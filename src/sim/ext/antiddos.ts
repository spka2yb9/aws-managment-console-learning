// AWS WAF Anti-DDoS (lesson 42): the AWSManagedRulesAntiDDoSRuleSet rule group, the WAF rule evaluation it plugs into,
// and the traffic behind it. The traffic mix (shoppers, the app, a botnet) lives in env.traffic (TrafficSetting.sources):
//   edge (CloudFront + WAF) sees every source -> what the web ACL lets through is TrafficSetting.rps -> CloudWatch's load model
// Sampled requests and WAF metrics are generated from (sources, the rules of the time) like CloudWatch's metrics: nothing is stored.
import { ipInCidr, nthIp } from '../cidr';
import { getMetricData, lbDimension, metricFor, MINUTE, requestsPerSecond, type Datapoint } from '../cloudwatch';
import { hash } from '../ids';
import { AwsError, type AntiDdosConfig, type AwsEnv, type RuleActionOverride, type TrafficSource, type WafRule, type WafSample, type WafSensitivity, type WebAcl } from '../types';

export const ANTI_DDOS = 'AWSManagedRulesAntiDDoSRuleSet';
export const NS = 'awswaf:managed:aws:anti-ddos:';
export const TOKEN_ACCEPTED = 'awswaf:managed:token:accepted';
export const TOKEN_ABSENT = 'awswaf:managed:token:absent';

/** the rules of the group, in evaluation order, with their own action and the overrides AWS accepts */
export const ANTI_DDOS_RULES: { name: string; action: RuleActionOverride['action']; overrides: RuleActionOverride['action'][] }[] = [
  { name: 'ChallengeAllDuringEvent', action: 'Challenge', overrides: ['Allow', 'Count'] },
  { name: 'ChallengeDDoSRequests', action: 'Challenge', overrides: ['Allow', 'Count'] },
  { name: 'DDoSRequests', action: 'Block', overrides: ['Allow', 'Block', 'Count', 'Challenge'] },
];

export const ANTI_DDOS_LABELS = ['event-detected', 'ddos-request', 'high-suspicion-ddos-request', 'medium-suspicion-ddos-request', 'low-suspicion-ddos-request', 'challengeable-request', ...ANTI_DDOS_RULES.map((r) => r.name)].map((l) => NS + l);

/** the regex AWS recommends starting from (matched against host + normalized path) */
export const DEFAULT_EXEMPT = String.raw`\/api(\/|$)|\.(acc|avi|css|gif|jpe?g|js|mp[34]|ogg|otf|pdf|png|tiff?|ttf|webm|webp|woff2?)$`;
export const defaultAntiDdosConfig = (): AntiDdosConfig => ({ sensitivityToBlock: 'LOW', challenge: { usage: 'ENABLED', sensitivity: 'HIGH', exemptUriRegex: [DEFAULT_EXEMPT] } });

type Suspicion = 'high' | 'medium' | 'low';
/** LOW matches only the high-suspicion label, MEDIUM medium and high, HIGH all of them */
const SENSITIVE: Record<WafSensitivity, Suspicion[]> = { LOW: ['high'], MEDIUM: ['high', 'medium'], HIGH: ['high', 'medium', 'low'] };

const invalid = (field: string, parameter: string, reason = 'The parameter contains formatting that is not valid.') => new AwsError('WAFInvalidParameterException', `Error reason: ${reason}, field: ${field}, parameter: ${parameter}`);

function regex(s: string): RegExp | null {
  try {
    return new RegExp(s);
  } catch {
    return null;
  }
}

/** CreateWebACL / UpdateWebACL checks for the Anti-DDoS rule group */
export function validateAntiDdos(cfg: AntiDdosConfig | undefined, overrides: RuleActionOverride[] = []) {
  if (!cfg) throw invalid('MANAGED_RULE_GROUP_CONFIG', ANTI_DDOS, 'A required field is missing from the parameter.');
  for (const s of [cfg.sensitivityToBlock, cfg.challenge.sensitivity]) if (!SENSITIVE[s]) throw invalid('SENSITIVITY', String(s));
  if (cfg.challenge.usage !== 'ENABLED' && cfg.challenge.usage !== 'DISABLED') throw invalid('USAGE_OF_ACTION', String(cfg.challenge.usage));
  const res = cfg.challenge.exemptUriRegex;
  if (cfg.challenge.usage === 'ENABLED' && (res.length < 1 || res.length > 5)) throw invalid('EXEMPT_URI_REGULAR_EXPRESSIONS', `${res.length}`, 'The number of regular expressions must be between 1 and 5.');
  const bad = res.find((r) => !r.trim() || !regex(r));
  if (bad !== undefined) throw invalid('REGEX_STRING', bad || '(empty)');
  for (const o of overrides) {
    const rule = ANTI_DDOS_RULES.find((r) => r.name === o.name);
    if (!rule) throw invalid('RULE_ACTION_OVERRIDE', o.name, 'The rule name does not exist in the rule group.');
    if (!rule.overrides.includes(o.action)) throw invalid('RULE_ACTION_OVERRIDE', `${o.name}: ${o.action}`, `The rule ${o.name} can only be overridden to ${rule.overrides.join(' or ')}.`);
  }
}

/** AWS WAF normalizes the path before the exempt regexes: no empty or "." segments, ".." resolved, no query string */
export function normalizePath(uri: string): string {
  const out: string[] = [];
  for (const seg of uri.split(/[?#]/)[0].split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return '/' + out.join('/');
}

/** ExemptUriRegularExpressions are matched against host + normalized path (www.example.com/api/orders): ^/api/ never matches */
export const exemptTarget = (host: string, uri: string) => `${host}${normalizePath(uri)}`;
export const isExempt = (cfg: AntiDdosConfig, host: string, uri: string) => cfg.challenge.exemptUriRegex.some((r) => !!regex(r)?.test(exemptTarget(host, uri)));

// ---------------- traffic ----------------

/** the traffic mix in effect at t (undefined: no simulated sources, just the normal daily load) */
export function sourcesAt(env: AwsEnv, t: number): TrafficSource[] | undefined {
  return [...(env.traffic ?? [])].reverse().find((x) => x.at <= t)?.sources;
}

/** A DDoS event: the requests reaching the edge are far above the resource's baseline (its normal daily traffic). */
export function ddosEventAt(env: AwsEnv, t: number): boolean {
  const src = sourcesAt(env, t);
  if (!src) return false;
  return src.reduce((a, s) => a + s.rps, 0) > 3 * requestsPerSecond({ ...env, traffic: [] }, t);
}

// ---------------- evaluation ----------------

export interface WafRequest {
  clientIp: string;
  method: string;
  uri: string;
  host: string;
  userAgent?: string;
  /** the client runs JavaScript: it answers a silent challenge and comes back with a token */
  javascript?: boolean;
  /** how the Anti-DDoS rule group rates the source during an event (attack traffic) */
  suspicion?: Suspicion;
  /** requests per second this IP sends (rate-based rules) */
  ipRps?: number;
}

export interface WafVerdict {
  action: 'ALLOW' | 'BLOCK' | 'CHALLENGE';
  /** the terminating rule (none = the default action) */
  rule?: string;
  ruleWithinGroup?: string;
  /** web ACL rules that counted the request (Count action / OverrideAction Count) */
  counted: string[];
  /** rules inside a group that matched but were overridden to Count: the group, the rule and its own action */
  countedWithinGroup: { rule: string; inner: string; action: string }[];
  labels: string[];
  /** the client solved a Challenge of this rule (group > rule) with JavaScript and went on with a token */
  solvedChallenge?: string;
}

type Hit = { inner: string; action: WafVerdict['action'] };

function antiDdos(env: AwsEnv, cfg: AntiDdosConfig, overrides: RuleActionOverride[], req: WafRequest, t: number) {
  const labels: string[] = [];
  const counted: { inner: string; action: string }[] = [];
  let solved: string | undefined;
  const event = ddosEventAt(env, t);
  const challengeable = cfg.challenge.usage === 'ENABLED' && req.method === 'GET' && !isExempt(cfg, req.host, req.uri);
  if (event) labels.push(NS + 'event-detected');
  if (event && req.suspicion) labels.push(NS + 'ddos-request', `${NS}${req.suspicion}-suspicion-ddos-request`);
  if (challengeable) labels.push(NS + 'challengeable-request');
  const override = (inner: string) => overrides.find((o) => o.name === inner)?.action;
  /** a rule matched: Count goes on, a Challenge the browser solves goes on, everything else ends the evaluation */
  const fire = (inner: string, own: RuleActionOverride['action']): Hit | undefined => {
    labels.push(NS + inner);
    const a = override(inner) ?? own;
    if (a === 'Count') counted.push({ inner, action: own });
    else if (a === 'Challenge' && req.javascript) solved ??= inner;
    else return { inner, action: a === 'Challenge' ? 'CHALLENGE' : a === 'Allow' ? 'ALLOW' : 'BLOCK' };
    return undefined;
  };
  const suspected = (s: WafSensitivity) => !!req.suspicion && SENSITIVE[s].includes(req.suspicion);
  let hit: Hit | undefined;
  if (event && challengeable) {
    hit = fire('ChallengeAllDuringEvent', 'Challenge');
    // ChallengeDDoSRequests only runs when ChallengeAllDuringEvent is overridden to Count
    if (!hit && override('ChallengeAllDuringEvent') === 'Count' && suspected(cfg.challenge.sensitivity)) hit = fire('ChallengeDDoSRequests', 'Challenge');
  }
  if (!hit && event && suspected(cfg.sensitivityToBlock)) hit = fire('DDoSRequests', 'Block');
  labels.push(solved ? TOKEN_ACCEPTED : TOKEN_ABSENT);
  return { labels, counted, solved, hit };
}

const CRS = 'AWSManagedRulesCommonRuleSet';
const KBI = 'AWSManagedRulesKnownBadInputsRuleSet';

/** Rules by priority: the first terminating match decides (Count only counts, labels pile up); otherwise the default action. */
export function evaluateRules(env: AwsEnv, rules: WafRule[], defaultAction: WebAcl['defaultAction'], req: WafRequest, t = Date.now()): WafVerdict {
  const v: WafVerdict = { action: defaultAction === 'Block' ? 'BLOCK' : 'ALLOW', counted: [], countedWithinGroup: [], labels: [] };
  let u = req.uri;
  try {
    u = decodeURIComponent(req.uri);
  } catch {
    /* malformed escapes: inspect as is */
  }
  u = u.toLowerCase();
  for (const r of [...rules].sort((a, b) => a.priority - b.priority)) {
    const s = r.statement;
    if (s.kind === 'managed' && s.name === ANTI_DDOS) {
      const g = antiDdos(env, s.antiDdos ?? defaultAntiDdosConfig(), s.ruleActionOverrides ?? [], req, t);
      v.labels.push(...g.labels);
      v.countedWithinGroup.push(...g.counted.map((c) => ({ rule: r.name, ...c })));
      if (g.solved) v.solvedChallenge ??= `${r.name} > ${g.solved}`;
      if (!g.hit) continue;
      if (r.action === 'Count') {
        // OverrideAction Count: the group's verdict is only counted
        v.counted.push(r.name);
        v.countedWithinGroup.push({ rule: r.name, inner: g.hit.inner, action: g.hit.action });
        continue;
      }
      return { ...v, action: g.hit.action, rule: r.name, ruleWithinGroup: g.hit.inner };
    }
    const match =
      s.kind === 'ip-set'
        ? !!env.ipSets.find((x) => x.arn === s.ipSetArn)?.addresses.some((cidr) => ipInCidr(req.clientIp, cidr))
        : s.kind === 'uri-starts-with'
          ? req.uri.startsWith(s.value)
          : s.kind === 'rate-based'
            ? (req.ipRps ?? 0) * s.windowSec > s.limit
            : s.name === CRS
              ? /<script|\.\.\/|%3cscript/.test(u)
              : s.name === KBI && /\/\.git|jndi:|\/\.env/.test(u);
    if (!match) continue;
    if (r.action === 'Count') v.counted.push(r.name);
    else return { ...v, action: r.action === 'Block' ? 'BLOCK' : 'ALLOW', rule: r.name };
  }
  return v;
}

/** the rules a web ACL had at t */
export const rulesAt = (acl: WebAcl, t: number): WafRule[] => [...(acl.revisions ?? [])].reverse().find((r) => r.at <= t)?.rules ?? acl.rules;

/** what the sampled-requests list keeps of one request */
export function toSample(req: WafRequest, v: WafVerdict, at: number, country = 'JP'): WafSample {
  const c = !v.rule ? v.countedWithinGroup[0] : undefined;
  const rule = v.rule ?? c?.rule ?? v.counted[0];
  return {
    at,
    clientIp: req.clientIp,
    method: req.method,
    uri: req.uri,
    host: req.host,
    rule,
    action: v.rule ? v.action : rule ? 'COUNT' : v.action,
    ...(v.ruleWithinGroup ?? c ? { ruleWithinGroup: v.ruleWithinGroup ?? c!.inner } : {}),
    ...(c ? { overriddenAction: c.action.toUpperCase() } : {}),
    ...(v.labels.length ? { labels: v.labels } : {}),
    ...(req.userAgent ? { userAgent: req.userAgent } : {}),
    country,
  };
}

// ---------------- the traffic, sampled ----------------

/** deterministic noise in [0, 1) */
const rnd = (key: string) => (hash(key) % 100_000) / 100_000;

/** one request of a source: which IP, path and suspicion level (k picks it deterministically) */
function requestOf(s: TrafficSource, k: number, host: string): { req: WafRequest; country: string } {
  const n = hash(`${s.name}#${k}`);
  let suspicion: Suspicion | undefined;
  if (s.suspicion) {
    let x = rnd(`${s.name}~${k}`);
    for (const lv of ['high', 'medium', 'low'] as const) {
      x -= s.suspicion[lv] ?? 0;
      if (x < 0) {
        suspicion = lv;
        break;
      }
    }
  }
  const path = s.paths[n % s.paths.length].replace('{n}', String((n >>> 8) % 500));
  return {
    req: { clientIp: nthIp(s.cidr, 1 + (n % s.ips)), method: 'GET', uri: path, host, userAgent: s.userAgent, javascript: s.javascript, suspicion, ipRps: s.rps / s.ips },
    country: s.country[(n >>> 4) % s.country.length],
  };
}

/** the web ACL's protected site (its distribution) */
const hostOf = (env: AwsEnv, acl: WebAcl) => env.distributions.find((d) => d.webAclArn === acl.arn)?.domainName;

const GRID = 250;
const LOOKBACK = 10 * MINUTE;

/** smooth weighted round-robin: source n gets weights[n] of every sum(weights) slots, evenly spread */
function roundRobin(weights: number[], length = 64): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const cur = weights.map(() => 0);
  return Array.from({ length }, () => {
    weights.forEach((w, j) => (cur[j] += w));
    const j = cur.indexOf(Math.max(...cur));
    cur[j] -= total;
    return j;
  });
}

/**
 * Sampled requests between from and to, newest first: the requests the learner sent (stored) and a sample of the
 * simulated traffic (one every GRID ms), judged by the rules of their time. Sources take turns by the square root of
 * their rate, so a small client (the app) still shows up every few seconds next to a botnet.
 */
export function sampledRequests(env: AwsEnv, acl: WebAcl, from: number, to: number, keep: (s: WafSample) => boolean = () => true, max = 100): WafSample[] {
  const out = acl.samples.filter((s) => s.at >= from && s.at <= to && keep(s));
  const host = hostOf(env, acl);
  const synthetic: WafSample[] = [];
  if (host)
    for (let t = Math.floor(to / GRID) * GRID; t >= Math.max(from, to - LOOKBACK) && synthetic.length < max; t -= GRID) {
      const src = sourcesAt(env, t);
      if (!src?.length) break;
      const k = t / GRID;
      const order = roundRobin(src.map((x) => Math.sqrt(x.rps)));
      const { req, country } = requestOf(src[order[k % order.length]], k, host);
      const sample = toSample(req, evaluateRules(env, rulesAt(acl, t), acl.defaultAction, req, t), t, country);
      if (keep(sample)) synthetic.push(sample);
    }
  return [...out, ...synthetic].sort((a, b) => b.at - a.at).slice(0, max);
}

/** every distinct request kind of the mix with its share of the source's rate */
function requestKinds(s: TrafficSource, host: string): { req: WafRequest; rps: number }[] {
  const levels = s.suspicion ? (Object.entries(s.suspicion) as [Suspicion, number][]) : [[undefined, 1] as const];
  return s.paths.flatMap((p) =>
    levels.map(([suspicion, share]) => ({
      req: { clientIp: nthIp(s.cidr, 1), method: 'GET', uri: p.replace('{n}', '1'), host, userAgent: s.userAgent, javascript: s.javascript, suspicion, ipRps: s.rps / s.ips },
      rps: (s.rps * share) / s.paths.length,
    })),
  );
}

export interface WafTraffic {
  allowed: number;
  blocked: number;
  challenged: number;
  counted: number;
}

/** requests per second of the mix by what the web ACL does with them (counted ones are also in allowed/blocked/...) */
export function wafTrafficAt(env: AwsEnv, acl: WebAcl, t: number): WafTraffic | undefined {
  const src = sourcesAt(env, t);
  const host = hostOf(env, acl);
  if (!src || !host) return undefined;
  const out: WafTraffic = { allowed: 0, blocked: 0, challenged: 0, counted: 0 };
  const rules = rulesAt(acl, t);
  for (const s of src)
    for (const k of requestKinds(s, host)) {
      const v = evaluateRules(env, rules, acl.defaultAction, k.req, t);
      out[v.action === 'ALLOW' ? 'allowed' : v.action === 'BLOCK' ? 'blocked' : 'challenged'] += k.rps;
      if (v.counted.length || v.countedWithinGroup.length) out.counted += k.rps;
    }
  return out;
}

export const WAF_METRICS = [
  ['AllowedRequests', 'allowed', '許可'],
  ['BlockedRequests', 'blocked', 'ブロック'],
  ['ChallengeRequests', 'challenged', 'チャレンジ'],
  ['CountedRequests', 'counted', 'カウント'],
] as const;

/** AWS/WAFV2 metrics of the web ACL (Sum per minute): normal traffic is all allowed */
export function wafMetricData(env: AwsEnv, acl: WebAcl, metric: (typeof WAF_METRICS)[number][0], start: number, end: number): Datapoint[] {
  const key = WAF_METRICS.find((m) => m[0] === metric)![1];
  if (!hostOf(env, acl)) return [];
  const out: Datapoint[] = [];
  for (let m = Math.ceil(start / MINUTE); m * MINUTE <= end; m++) {
    const t = Math.min(end, (m + 1) * MINUTE - 1);
    const w = wafTrafficAt(env, acl, t) ?? { allowed: requestsPerSecond(env, t), blocked: 0, challenged: 0, counted: 0 };
    out.push({ t: m * MINUTE, v: Math.round(w[key] * 60) });
  }
  return out;
}

/**
 * After the rules change, the web tier gets only what the web ACL lets through (CloudWatch's load model reads TrafficSetting.rps).
 * ponytail: only web ACL updates refresh it; detaching the web ACL from the distribution keeps the old rate.
 */
export function refreshOriginTraffic(env: AwsEnv, now: number) {
  const src = sourcesAt(env, now);
  const acl = env.webAcls.find((a) => hostOf(env, a));
  if (!src || !acl) return;
  const w = wafTrafficAt(env, acl, now)!;
  env.traffic = [...env.traffic.filter((x) => x.at !== now), { at: now, rps: Math.round(w.allowed), sources: src }];
}

/** the ALB's TargetResponseTime right now (seconds): over 1.5 s the web tier is drowning (CloudWatch counts 5XX then) */
export function originResponseTime(env: AwsEnv, loadBalancerName: string, t: number): number {
  const lb = env.loadBalancers.find((l) => l.loadBalancerName === loadBalancerName);
  if (!lb) return 0;
  return getMetricData(env, metricFor('AWS/ApplicationELB', 'TargetResponseTime', lbDimension(lb)), { start: t, end: t, period: 60, stat: 'Average' })[0]?.v ?? 0;
}
export const OVERLOADED_SECONDS = 1.5;
