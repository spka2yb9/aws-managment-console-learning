/* aws wafv2 — ウェブ ACL・IP セット・サンプリングされたリクエスト (sim/edge.ts)。
   --scope CLOUDFRONT のものは us-east-1 にある (実物と同じく --region us-east-1 で呼ぶ)。REGIONAL はそのリージョンのもの。
   リージョンを自分で見るので scope は 'global' にする */
import { isValidCidr } from '../../../sim/cidr';
import { MANAGED_RULE_GROUPS, updateIpSet, updateWebAcl } from '../../../sim/edge';
import { ANTI_DDOS, ANTI_DDOS_LABELS, ANTI_DDOS_RULES, NS, sampledRequests } from '../../../sim/ext/antiddos';
import { CLIENT_IP } from '../../../sim/network';
import { stableChars } from '../../../sim/ids';
import type { AntiDdosConfig, AwsEnv, IpSet, RuleActionOverride, WafRule, WafSensitivity, WebAcl } from '../../../sim/types';
import { AwsError, iso, ParamError, req, service, str, strs, struct, structs, type OpContext, type OperationSpec } from '../types';

type Scope = 'CLOUDFRONT' | 'REGIONAL';

const invalid = (field: string, parameter: string, reason = 'The parameter contains formatting that is not valid.') => new AwsError('WAFInvalidParameterException', `Error reason: ${reason}, field: ${field}, parameter: ${parameter}`);
const notFound = () => new AwsError('WAFNonexistentItemException', 'AWS WAF couldn’t perform the operation because your resource doesn’t exist.');

function scopeOf(ctx: OpContext): Scope {
  const s = req(ctx, 'scope');
  if (s !== 'CLOUDFRONT' && s !== 'REGIONAL') throw invalid('SCOPE_VALUE', s);
  // CloudFront 用のリソースは us-east-1 のエンドポイントでしか扱えない
  if (s === 'CLOUDFRONT' && ctx.region !== 'us-east-1') throw invalid('SCOPE_VALUE', s, 'The scope is not valid.');
  return s;
}

/** ARN のリージョン (CloudFront 用は us-east-1) がこの呼び出しのリージョンと同じもの */
const inScope = <T extends { arn: string; scope: Scope }>(ctx: OpContext, scope: Scope, items: T[]) => items.filter((x) => x.scope === scope && x.arn.split(':')[3] === ctx.region);
const idOf = (arn: string) => arn.split('/').pop()!;

/** 中身が変わるたびに変わるトークン (update-ip-set の --lock-token に渡す) */
function lockToken(seed: string): string {
  const h = stableChars(seed, '0123456789abcdef', 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export const ipSetLockToken = (s: IpSet) => lockToken(`${s.arn}:${s.addresses.join(',')}:${s.description ?? ''}`);
const aclToken = (a: WebAcl) => lockToken(`${a.arn}:${JSON.stringify(a.rules)}:${a.defaultAction}`);

/** --name と --id (と --scope) で 1 つ選ぶ */
function pick<T extends { arn: string; scope: Scope; name: string }>(ctx: OpContext, items: T[]): T {
  const scope = scopeOf(ctx);
  const name = req(ctx, 'name');
  const id = req(ctx, 'id');
  const x = inScope(ctx, scope, items).find((i) => i.name === name && idOf(i.arn) === id);
  if (!x) throw notFound();
  return x;
}

const actionOut = (a: string) => ({ [a]: {} });
const metricOf = (r: WafRule) => r.metricName ?? r.name;

function antiDdosOut(c: AntiDdosConfig) {
  return {
    AWSManagedRulesAntiDDoSRuleSet: {
      ClientSideActionConfig: { Challenge: { UsageOfAction: c.challenge.usage, Sensitivity: c.challenge.sensitivity, ExemptUriRegularExpressions: c.challenge.exemptUriRegex.map((RegexString) => ({ RegexString })) } },
      SensitivityToBlock: c.sensitivityToBlock,
    },
  };
}

function ruleOut(env: AwsEnv, r: WafRule) {
  const s = r.statement;
  const visibility = { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: metricOf(r) };
  if (s.kind === 'managed') {
    const statement = {
      VendorName: s.vendor,
      Name: s.name,
      ...(s.antiDdos ? { ManagedRuleGroupConfigs: [antiDdosOut(s.antiDdos)] } : {}),
      ...(s.ruleActionOverrides?.length ? { RuleActionOverrides: s.ruleActionOverrides.map((o) => ({ Name: o.name, ActionToUse: actionOut(o.action) })) } : {}),
    };
    return { Name: r.name, Priority: r.priority, Statement: { ManagedRuleGroupStatement: statement }, OverrideAction: r.action === 'Count' ? { Count: {} } : { None: {} }, VisibilityConfig: visibility };
  }
  const statement =
    s.kind === 'ip-set'
      ? { IPSetReferenceStatement: { ARN: env.ipSets.find((x) => x.arn === s.ipSetArn)?.arn ?? s.ipSetArn } }
      : s.kind === 'rate-based'
        ? { RateBasedStatement: { Limit: s.limit, EvaluationWindowSec: s.windowSec, AggregateKeyType: 'IP' } }
        : { ByteMatchStatement: { SearchString: s.value, FieldToMatch: { UriPath: {} }, TextTransformations: [{ Priority: 0, Type: 'NONE' }], PositionalConstraint: 'STARTS_WITH' } };
  return { Name: r.name, Priority: r.priority, Statement: statement, Action: actionOut(r.action), VisibilityConfig: visibility };
}

/* ---- --rules (JSON) → sim のルール。botocore が送る前に止める誤りは ParamError、API が返すものは AwsError ---- */

const RULE_KEYS = ['Name', 'Priority', 'Statement', 'Action', 'OverrideAction', 'RuleLabels', 'VisibilityConfig', 'CaptchaConfig', 'ChallengeConfig'];
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

function paramFail(msg: string): never {
  throw new ParamError(`\nParameter validation failed:\n${msg}`);
}

function need(o: Record<string, unknown>, key: string, where: string): unknown {
  if (o[key] === undefined) paramFail(`Missing required parameter in ${where}: "${key}"`);
  return o[key];
}

/** { "Count": {} } → Count */
function oneAction(v: unknown, where: string, allowed: string[]): string {
  const keys = Object.keys(obj(v) ?? {});
  if (keys.length !== 1 || !allowed.includes(keys[0])) paramFail(`Invalid value for parameter ${where}: ${JSON.stringify(v)}, must contain exactly one of: ${allowed.join(', ')}`);
  return keys[0];
}

function antiDdosIn(configs: unknown, where: string): AntiDdosConfig | undefined {
  const c = (Array.isArray(configs) ? configs : []).map(obj).find((x) => x?.AWSManagedRulesAntiDDoSRuleSet);
  const a = obj(c?.AWSManagedRulesAntiDDoSRuleSet);
  if (!a) return undefined;
  const w = `${where}.ManagedRuleGroupConfigs[0].AWSManagedRulesAntiDDoSRuleSet`;
  const ch = obj(obj(need(a, 'ClientSideActionConfig', w))?.Challenge);
  if (!ch) paramFail(`Missing required parameter in ${w}.ClientSideActionConfig: "Challenge"`);
  const usage = need(ch, 'UsageOfAction', `${w}.ClientSideActionConfig.Challenge`);
  const regexes = (Array.isArray(ch.ExemptUriRegularExpressions) ? ch.ExemptUriRegularExpressions : []).map((x) => String(obj(x)?.RegexString ?? ''));
  return {
    sensitivityToBlock: String(a.SensitivityToBlock ?? 'LOW') as WafSensitivity,
    challenge: { usage: String(usage) as AntiDdosConfig['challenge']['usage'], sensitivity: String(ch.Sensitivity ?? 'HIGH') as WafSensitivity, exemptUriRegex: regexes },
  };
}

function ruleIn(env: AwsEnv, raw: Record<string, unknown>, n: number): WafRule {
  const where = `Rules[${n}]`;
  const unknown = Object.keys(raw).find((k) => !RULE_KEYS.includes(k));
  if (unknown) paramFail(`Unknown parameter in ${where}: "${unknown}", must be one of: ${RULE_KEYS.join(', ')}`);
  const name = String(need(raw, 'Name', where));
  const priority = need(raw, 'Priority', where);
  if (typeof priority !== 'number') paramFail(`Invalid type for parameter ${where}.Priority, value: ${JSON.stringify(priority)}, type: <class 'str'>, valid types: <class 'int'>`);
  const st = obj(need(raw, 'Statement', where)) ?? {};
  const vis = obj(need(raw, 'VisibilityConfig', where)) ?? {};
  for (const k of ['SampledRequestsEnabled', 'CloudWatchMetricsEnabled', 'MetricName']) need(vis, k, `${where}.VisibilityConfig`);
  const metricName = String(vis.MetricName) === name ? undefined : String(vis.MetricName);
  const [kind] = Object.keys(st);
  const body = obj(st[kind]) ?? {};
  const w = `${where}.Statement.${kind}`;
  if (kind === 'ManagedRuleGroupStatement') {
    if (raw.Action) throw invalid('RULE_ACTION', name, 'A rule that references a rule group uses OverrideAction, not Action.');
    const override = oneAction(need(raw, 'OverrideAction', where), `${where}.OverrideAction`, ['None', 'Count']);
    const overrides: RuleActionOverride[] = (Array.isArray(body.RuleActionOverrides) ? body.RuleActionOverrides : []).map((o, k) => {
      const x = obj(o) ?? {};
      return { name: String(need(x, 'Name', `${w}.RuleActionOverrides[${k}]`)), action: oneAction(need(x, 'ActionToUse', `${w}.RuleActionOverrides[${k}]`), `${w}.RuleActionOverrides[${k}].ActionToUse`, ['Allow', 'Block', 'Count', 'Captcha', 'Challenge']) as RuleActionOverride['action'] };
    });
    const statement: WafRule['statement'] = { kind: 'managed', vendor: String(need(body, 'VendorName', w)) as 'AWS', name: String(need(body, 'Name', w)), antiDdos: antiDdosIn(body.ManagedRuleGroupConfigs, w), ruleActionOverrides: overrides };
    return { name, priority, action: override === 'Count' ? 'Count' : 'Block', statement, metricName };
  }
  if (raw.OverrideAction) throw invalid('OVERRIDE_ACTION', name, 'OverrideAction is only for rules that reference a rule group.');
  const action = oneAction(need(raw, 'Action', where), `${where}.Action`, ['Allow', 'Block', 'Count', 'Captcha', 'Challenge']);
  if (action !== 'Allow' && action !== 'Block' && action !== 'Count') throw invalid('RULE_ACTION', action, '(シミュレーター) このルールで使えるアクションは Allow / Block / Count です');
  let statement: WafRule['statement'];
  if (kind === 'IPSetReferenceStatement') {
    const arn = String(need(body, 'ARN', w));
    if (!env.ipSets.some((x) => x.arn === arn)) throw notFound();
    statement = { kind: 'ip-set', ipSetArn: arn };
  } else if (kind === 'RateBasedStatement') {
    const limit = need(body, 'Limit', w);
    if (body.AggregateKeyType !== undefined && body.AggregateKeyType !== 'IP') throw invalid('AGGREGATE_KEY_TYPE', String(body.AggregateKeyType), '(シミュレーター) AggregateKeyType は IP だけに対応しています');
    statement = { kind: 'rate-based', limit: Number(limit), windowSec: Number(body.EvaluationWindowSec ?? 300) };
  } else if (kind === 'ByteMatchStatement' && body.PositionalConstraint === 'STARTS_WITH' && obj(body.FieldToMatch)?.UriPath) {
    statement = { kind: 'uri-starts-with', value: String(body.SearchString ?? '') };
  } else throw invalid('STATEMENT', kind ?? '(empty)', '(シミュレーター) このステートメントには対応していません。IPSetReferenceStatement / RateBasedStatement / ManagedRuleGroupStatement / ByteMatchStatement (UriPath の STARTS_WITH) が使えます');
  return { name, priority, action, statement, metricName };
}

/* ---- マネージドルールグループの中身 (describe-managed-rule-group) ---- */
const CRS_RULES = ['NoUserAgent_HEADER', 'UserAgent_BadBots_HEADER', 'SizeRestrictions_QUERYSTRING', 'SizeRestrictions_Cookie_HEADER', 'SizeRestrictions_BODY', 'SizeRestrictions_URIPATH', 'EC2MetaDataSSRF_BODY', 'EC2MetaDataSSRF_COOKIE', 'EC2MetaDataSSRF_URIPATH', 'EC2MetaDataSSRF_QUERYARGUMENTS', 'GenericLFI_QUERYARGUMENTS', 'GenericLFI_URIPATH', 'GenericLFI_BODY', 'RestrictedExtensions_URIPATH', 'RestrictedExtensions_QUERYARGUMENTS', 'GenericRFI_QUERYARGUMENTS', 'GenericRFI_BODY', 'GenericRFI_URIPATH', 'CrossSiteScripting_COOKIE', 'CrossSiteScripting_QUERYARGUMENTS', 'CrossSiteScripting_BODY', 'CrossSiteScripting_URIPATH'];
const KBI_RULES = ['JavaDeserializationRCE_HEADER', 'JavaDeserializationRCE_BODY', 'JavaDeserializationRCE_URIPATH', 'JavaDeserializationRCE_QUERYSTRING', 'Host_localhost_HEADER', 'PROPFIND_METHOD', 'ExploitablePaths_URIPATH', 'Log4JRCE_QUERYSTRING', 'Log4JRCE_BODY', 'Log4JRCE_URIPATH', 'Log4JRCE_HEADER'];
const GROUP_DETAIL: Record<string, { ns: string; rules: { name: string; action: string }[]; en: string; labels?: string[] }> = {
  AWSManagedRulesCommonRuleSet: { ns: 'awswaf:managed:aws:core-rule-set:', rules: CRS_RULES.map((name) => ({ name, action: 'Block' })), en: 'Contains rules that are generally applicable to web applications. This provides protection against exploitation of a wide range of vulnerabilities, including those described in OWASP publications.' },
  AWSManagedRulesKnownBadInputsRuleSet: { ns: 'awswaf:managed:aws:known-bad-inputs:', rules: KBI_RULES.map((name) => ({ name, action: 'Block' })), en: 'Contains rules that allow you to block request patterns that are known to be invalid and are associated with exploitation or discovery of vulnerabilities.' },
  [ANTI_DDOS]: { ns: NS, rules: ANTI_DDOS_RULES.map((r) => ({ name: r.name, action: r.action })), labels: ANTI_DDOS_LABELS, en: 'Provides protection against application layer (layer 7) distributed denial of service (DDoS) attacks. Learns a traffic baseline of the protected resource, labels the requests during a probable DDoS event, and challenges or blocks the requests that are likely to take part in it.' },
};

const summary = (x: { name: string; arn: string; description?: string }, token: string) => ({ Name: x.name, Id: idOf(x.arn), Description: x.description ?? '', LockToken: token, ARN: x.arn });

/** --time-window の StartTime / EndTime (ISO 8601 か UNIX 秒) */
function timeOf(v: unknown, field: string): number {
  const s = String(v ?? '');
  const t = /^\d+(\.\d+)?$/.test(s) ? Number(s) * 1000 : Date.parse(s);
  if (!s || !Number.isFinite(t)) throw invalid('TIME_WINDOW', s || field);
  return t;
}

/* マネージドルールグループの中で一致したルール (sim/edge.ts の evaluateWaf の判定に合わせる) */
const innerRule = (uri: string) => (/<script|%3cscript/i.test(uri) ? 'CrossSiteScripting_QUERYARGUMENTS' : /\.\.\//.test(uri) ? 'GenericLFI_URIPATH' : undefined);

const scopeParam = { name: 'scope', type: 'string', required: true, desc: 'CLOUDFRONT (CloudFront 用。--region us-east-1 で呼ぶ) か REGIONAL' } as const;
const nameIdParams = [
  { name: 'name', type: 'string', required: true, desc: '名前' },
  scopeParam,
  { name: 'id', type: 'string', required: true, desc: 'ID (list-… の Id)' },
] as const;

const ops: OperationSpec[] = [
  {
    name: 'list-web-acls',
    api: 'ListWebACLs',
    desc: 'ウェブ ACL の一覧',
    params: [scopeParam],
    readOnly: true,
    scope: 'global',
    examples: ['aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1'],
    run(ctx) {
      const acls = inScope(ctx, scopeOf(ctx), ctx.env.webAcls);
      return { NextMarker: acls.at(-1)?.name ?? '', WebACLs: acls.map((a) => summary(a, aclToken(a))) };
    },
  },
  {
    name: 'get-web-acl',
    api: 'GetWebACL',
    desc: 'ウェブ ACL のルール (優先度・ステートメント・アクション) とデフォルトアクション',
    params: [...nameIdParams],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const a = pick(ctx, ctx.env.webAcls);
      const capacity = a.rules.reduce((n, r) => n + (r.statement.kind === 'managed' ? (MANAGED_RULE_GROUPS.find((g) => g.name === (r.statement as { name: string }).name)?.capacity ?? 0) : r.statement.kind === 'ip-set' ? 1 : 2), 0);
      return {
        WebACL: {
          Name: a.name,
          Id: idOf(a.arn),
          ARN: a.arn,
          DefaultAction: actionOut(a.defaultAction),
          Description: '',
          Rules: a.rules.map((r) => ruleOut(ctx.env, r)),
          VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: a.name },
          Capacity: capacity,
          ManagedByFirewallManager: false,
          LabelNamespace: `awswaf:${ctx.env.accountId}:webacl:${a.name}:`,
          RetrofittedByFirewallManager: false,
        },
        LockToken: aclToken(a),
      };
    },
  },
  {
    name: 'list-ip-sets',
    api: 'ListIPSets',
    desc: 'IP セットの一覧',
    params: [scopeParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const sets = inScope(ctx, scopeOf(ctx), ctx.env.ipSets);
      return { NextMarker: sets.at(-1)?.name ?? '', IPSets: sets.map((s) => summary(s, ipSetLockToken(s))) };
    },
  },
  {
    name: 'get-ip-set',
    api: 'GetIPSet',
    desc: 'IP セットの中身 (CIDR の一覧) と LockToken',
    params: [...nameIdParams],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const s = pick(ctx, ctx.env.ipSets);
      return { IPSet: { Name: s.name, Id: idOf(s.arn), ARN: s.arn, Description: s.description ?? '', IPAddressVersion: 'IPV4', Addresses: s.addresses }, LockToken: ipSetLockToken(s) };
    },
  },
  {
    name: 'update-ip-set',
    api: 'UpdateIPSet',
    desc: 'IP セットの中身を置き換える (--addresses に全部を書く。--lock-token は get-ip-set で取る)',
    params: [
      ...nameIdParams,
      { name: 'addresses', type: 'list', required: true, desc: 'CIDR の一覧 (空白区切り。1 つの IP なら /32)' },
      { name: 'lock-token', type: 'string', required: true, desc: 'get-ip-set の LockToken' },
      { name: 'description', type: 'string', desc: '説明' },
    ],
    scope: 'global',
    examples: ['aws wafv2 update-ip-set --name bad-ips --scope CLOUDFRONT --id <Id> --addresses 192.0.2.44/32 --lock-token <LockToken> --region us-east-1'],
    run(ctx) {
      const s = pick(ctx, ctx.env.ipSets);
      const bad = strs(ctx, 'addresses').find((a) => !isValidCidr(a));
      if (bad) throw invalid('IP_ADDRESS', bad);
      if (req(ctx, 'lock-token') !== ipSetLockToken(s)) throw new AwsError('WAFOptimisticLockException', 'AWS WAF couldn’t save your changes because someone changed the resource after you started to edit it. Reapply your changes.');
      updateIpSet(ctx.env, s.arn, strs(ctx, 'addresses'));
      const desc = str(ctx, 'description');
      if (desc !== undefined) s.description = desc;
      return { NextLockToken: ipSetLockToken(s) };
    },
  },
  {
    name: 'update-web-acl',
    api: 'UpdateWebACL',
    desc: 'ウェブ ACL のルールとデフォルトアクションを丸ごと置き換える (--rules に全部を書く。--lock-token は get-web-acl で取る)',
    params: [
      ...nameIdParams,
      { name: 'default-action', type: 'structure', required: true, desc: '\'{"Allow":{}}\' か \'{"Block":{}}\'' },
      { name: 'rules', type: 'list', of: 'structure', desc: 'ルールの JSON の配列 (file://rules.json)。省略するとルールは 0 個になる' },
      { name: 'visibility-config', type: 'structure', required: true, desc: 'SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=<名前>' },
      { name: 'lock-token', type: 'string', required: true, desc: 'get-web-acl の LockToken' },
      { name: 'description', type: 'string', desc: '説明' },
    ],
    scope: 'global',
    examples: ['aws wafv2 update-web-acl --name webapp-acl --scope CLOUDFRONT --id <Id> --default-action \'{"Allow":{}}\' --rules file://rules.json --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=webapp-acl --lock-token <LockToken> --region us-east-1'],
    run(ctx) {
      const a = pick(ctx, ctx.env.webAcls);
      const defaultAction = oneAction(struct(ctx, 'default-action'), 'DefaultAction', ['Allow', 'Block']) as WebAcl['defaultAction'];
      const vis = struct(ctx, 'visibility-config') ?? {};
      for (const k of ['SampledRequestsEnabled', 'CloudWatchMetricsEnabled', 'MetricName']) need(vis, k, 'VisibilityConfig');
      const rules = structs(ctx, 'rules').map((r, n) => ruleIn(ctx.env, r, n));
      if (req(ctx, 'lock-token') !== aclToken(a)) throw new AwsError('WAFOptimisticLockException', 'AWS WAF couldn’t save your changes because someone changed the resource after you started to edit it. Reapply your changes.');
      updateWebAcl(ctx.env, a.arn, { rules, defaultAction }, ctx.now);
      return { NextLockToken: aclToken(ctx.env.webAcls.find((x) => x.arn === a.arn)!) };
    },
  },
  {
    name: 'list-available-managed-rule-groups',
    desc: '使える AWS マネージドルールグループの一覧',
    params: [scopeParam],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      scopeOf(ctx);
      return { NextMarker: MANAGED_RULE_GROUPS.at(-1)!.name, ManagedRuleGroups: MANAGED_RULE_GROUPS.map((g) => ({ VendorName: 'AWS', Name: g.name, VersioningSupported: true, Description: GROUP_DETAIL[g.name]?.en ?? '' })) };
    },
  },
  {
    name: 'describe-managed-rule-group',
    desc: 'マネージドルールグループの中のルール (名前と既定のアクション)・WCU・付けるラベル',
    params: [
      { name: 'vendor-name', type: 'string', required: true, desc: 'AWS' },
      { name: 'name', type: 'string', required: true, desc: 'ルールグループの名前 (AWSManagedRulesAntiDDoSRuleSet など)' },
      scopeParam,
    ],
    readOnly: true,
    scope: 'global',
    examples: ['aws wafv2 describe-managed-rule-group --vendor-name AWS --name AWSManagedRulesAntiDDoSRuleSet --scope CLOUDFRONT --region us-east-1'],
    run(ctx) {
      scopeOf(ctx);
      const g = MANAGED_RULE_GROUPS.find((x) => x.name === req(ctx, 'name'));
      if (req(ctx, 'vendor-name') !== 'AWS' || !g) throw notFound();
      const d = GROUP_DETAIL[g.name];
      return {
        SnsTopicArn: `arn:aws:sns:us-east-1:248400274283:aws-managed-waf-rule-notifications`,
        Capacity: g.capacity,
        Rules: d.rules.map((r) => ({ Name: r.name, Action: actionOut(r.action) })),
        LabelNamespace: d.ns,
        AvailableLabels: (d.labels ?? d.rules.map((r) => d.ns + r.name)).map((Name) => ({ Name })),
        ConsumedLabels: [],
      };
    },
  },
  {
    name: 'get-sampled-requests',
    desc: 'ウェブ ACL が検査したリクエストの見本 (ルールごと。送信元 IP・URI・アクション・ラベル)',
    params: [
      { name: 'web-acl-arn', type: 'string', required: true, desc: 'ウェブ ACL の ARN' },
      { name: 'rule-metric-name', type: 'string', required: true, desc: 'ルールの VisibilityConfig.MetricName (デフォルトアクションのものはウェブ ACL の MetricName)' },
      scopeParam,
      { name: 'time-window', type: 'structure', required: true, desc: 'StartTime=<日時>,EndTime=<日時> (ISO 8601 か UNIX 秒)' },
    ],
    readOnly: true,
    scope: 'global',
    examples: ['aws wafv2 get-sampled-requests --web-acl-arn <ARN> --rule-metric-name block-bad-ips --scope CLOUDFRONT --time-window StartTime=2026-11-19T00:00:00Z,EndTime=2026-11-21T00:00:00Z --max-items 100 --region us-east-1'],
    run(ctx) {
      const scope = scopeOf(ctx);
      const arn = req(ctx, 'web-acl-arn');
      const a = inScope(ctx, scope, ctx.env.webAcls).find((x) => x.arn === arn);
      if (!a) throw notFound();
      const tw = struct(ctx, 'time-window') ?? {};
      const [from, to] = [timeOf(tw.StartTime, 'StartTime'), timeOf(tw.EndTime, 'EndTime')];
      const metric = req(ctx, 'rule-metric-name');
      // ルールの MetricName (既定はルール名)。ウェブ ACL の MetricName はどのルールにも一致しなかったもの (デフォルトアクション)
      const rule = a.rules.find((r) => metricOf(r) === metric);
      const hits = sampledRequests(ctx.env, a, from, to, (s) => (metric === a.name ? !s.rule : !!rule && s.rule === rule.name));
      const managed = rule?.statement.kind === 'managed';
      return {
        SampledRequests: hits.map((s) => {
          const inner = s.ruleWithinGroup ?? (managed ? innerRule(s.uri) : undefined);
          const ua = s.userAgent ?? (s.clientIp === CLIENT_IP ? 'curl/7.81.0' : 'python-requests/2.31.0');
          return {
            Request: { ClientIP: s.clientIp, Country: s.country ?? 'JP', URI: s.uri, Method: s.method, HTTPVersion: 'HTTP/2.0', Headers: [{ Name: 'Host', Value: s.host }, { Name: 'User-Agent', Value: ua }] },
            Weight: 1,
            Timestamp: iso(s.at),
            Action: s.action,
            ...(inner ? { RuleNameWithinRuleGroup: inner } : {}),
            ...(s.action === 'BLOCK' ? { ResponseCodeSent: 403 } : s.action === 'CHALLENGE' ? { ResponseCodeSent: 202 } : {}),
            ...(s.labels?.length ? { Labels: s.labels.map((Name) => ({ Name })) } : {}),
            ...(s.action === 'CHALLENGE' ? { ChallengeResponse: { ResponseCode: 202, SolveTimestamp: 0, FailureReason: 'TOKEN_MISSING' } } : {}),
            ...(s.overriddenAction ? { OverriddenAction: s.overriddenAction } : {}),
          };
        }),
        PopulationSize: hits.length,
        TimeWindow: { StartTime: iso(from), EndTime: iso(to) },
      };
    },
  },
];

export default service('wafv2', 'AWS WAF (ウェブ ACL・IP セット・マネージドルールグループ)', ops);
