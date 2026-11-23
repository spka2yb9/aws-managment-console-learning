// IAM Access Analyzer (lesson 45): analyzers, findings, archive rules.
// The state lives in AwsEnv as an optional field (sessions saved by older versions don't have it).
//
// Findings are not stored facts: every analysis derives "detections" from the current policies (bucket policies,
// role trust policies) or, for unused access, from the last-accessed data in `usage`, and merges them into the
// analyzer's findings: a detection without a finding becomes a new ACTIVE finding (ARCHIVED when an archive rule
// matches), an ACTIVE / ARCHIVED finding without a detection becomes RESOLVED. Like the real service, a policy change
// is analyzed a little later (RESCAN_DELAY_MS) unless the resource is rescanned (StartResourceScan) right away.
import { trail } from '../cloudtrail';
import { deleteInlinePolicy, detachPolicy, findPolicy, getRole, list, matchWildcard, statements } from '../iam';
import { newUuid } from '../ids';
import { bucketArn, isPolicyPublic } from '../s3';
import { AwsError, type AwsEnv, type IamRole, type PolicyStatement } from '../types';

const DAY = 86_400_000;
/** AWS analyzes a changed policy within 30 minutes; the simulator takes a minute */
export const RESCAN_DELAY_MS = 60_000;

export const ANALYZER_TYPES = ['ACCOUNT', 'ORGANIZATION', 'ACCOUNT_UNUSED_ACCESS', 'ORGANIZATION_UNUSED_ACCESS', 'ACCOUNT_INTERNAL_ACCESS', 'ORGANIZATION_INTERNAL_ACCESS'] as const;
/** the types the simulator runs (the account is not in an organization) */
export type AnalyzerType = 'ACCOUNT' | 'ACCOUNT_UNUSED_ACCESS';
export type FindingStatus = 'ACTIVE' | 'ARCHIVED' | 'RESOLVED';
// ponytail: IAM users' passwords / access keys are not modeled, so UnusedIAMUserPassword / UnusedIAMUserAccessKey never occur.
export type FindingType = 'ExternalAccess' | 'UnusedIAMRole' | 'UnusedPermission';

export interface Criterion {
  eq?: string[];
  neq?: string[];
  contains?: string[];
  exists?: boolean;
}
/** filter key (principal.AWS, resourceType, ...) → criterion; all of them must match */
export type FindingFilter = Record<string, Criterion>;

export interface ArchiveRule {
  ruleName: string;
  filter: FindingFilter;
  createdAt: number;
  updatedAt: number;
}

/** What one analysis found: a finding without its id, status and times. */
export interface Detection {
  /** the same access gets the same key (a changed principal / action / condition is a new finding) */
  key: string;
  findingType: FindingType;
  resource: string;
  resourceType: 'AWS::S3::Bucket' | 'AWS::IAM::Role';
  resourceOwnerAccount: string;
  /* ExternalAccess */
  principal?: Record<string, string>;
  action?: string[];
  condition?: Record<string, string>;
  isPublic?: boolean;
  /** S3: what grants the access (the simulator has no ACLs or access points) */
  sources?: { type: 'POLICY' }[];
  /* UnusedIAMRole: when the role was last used (undefined = never) */
  lastAccessed?: number;
  /* UnusedPermission: services the role may use but did not use in the tracking period */
  unusedServices?: { serviceNamespace: string; lastAccessed?: number }[];
}

export interface Finding extends Detection {
  id: string;
  status: FindingStatus;
  createdAt: number;
  analyzedAt: number;
  updatedAt: number;
}

export interface Analyzer {
  name: string;
  arn: string;
  type: AnalyzerType;
  status: 'ACTIVE';
  createdAt: number;
  /** unused access: the tracking period in days */
  unusedAccessAge?: number;
  archiveRules: ArchiveRule[];
  findings: Finding[];
  lastResourceAnalyzed?: string;
  lastResourceAnalyzedAt?: number;
  /** a policy changed: the next analysis runs then */
  rescanAt?: number;
}

/** IAM's last-accessed data of one principal: when it was used, and when it last used each service. */
export interface Usage {
  lastAccessed?: number;
  services: Record<string, number>;
}

export interface AccessAnalyzerState {
  analyzers: Analyzer[];
  /** principal ARN → last-accessed data (scenarios fill it in; it is the evidence for unused access) */
  usage: Record<string, Usage>;
}

const state = (env: AwsEnv) => (env.accessAnalyzer ??= { analyzers: [], usage: {} });
export const analyzersOf = (env: AwsEnv): Analyzer[] => env.accessAnalyzer?.analyzers ?? [];
export const isUnusedAnalyzer = (a: Pick<Analyzer, 'type'>) => a.type === 'ACCOUNT_UNUSED_ACCESS';
export const analyzerArn = (env: AwsEnv, name: string) => `arn:aws:access-analyzer:${env.region}:${env.accountId}:analyzer/${name}`;
const record = (env: AwsEnv, name: string, request: unknown, response: Record<string, unknown> | null = null) => trail(env, { source: 'access-analyzer', name, request, response });

/** by name or ARN */
export function getAnalyzer(env: AwsEnv, nameOrArn: string): Analyzer {
  const a = analyzersOf(env).find((x) => x.name === nameOrArn || x.arn === nameOrArn);
  if (!a) throw new AwsError('ResourceNotFoundException', 'Analyzer not found');
  return a;
}

export function getFinding(a: Analyzer, id: string): Finding {
  const f = a.findings.find((x) => x.id === id);
  if (!f) throw new AwsError('ResourceNotFoundException', 'Finding not found');
  return f;
}

// ---------- detection ----------

const accountOf = (p: string) => (/^\d{12}$/.test(p) ? p : /^arn:aws:(?:iam|sts)::(\d{12}):/.exec(p)?.[1]);

/** The external principal a policy's principal entry stands for, as Access Analyzer reports it (account root → account id). */
function externalPrincipal(env: AwsEnv, p: string): string | undefined {
  if (p === '*') return '*';
  const account = accountOf(p);
  if (!account || account === env.accountId) return undefined;
  return p === account || p.endsWith(':root') ? account : p;
}

const flatCondition = (st: PolicyStatement): Record<string, string> =>
  Object.fromEntries(Object.values(st.Condition ?? {}).flatMap((kv) => Object.entries(kv).map(([k, v]) => [k, list(typeof v === 'boolean' ? String(v) : v).join(',')])));

/** Allow statements of a resource policy → one detection per external principal + condition (actions merged). */
function externalAccess(env: AwsEnv, resource: string, resourceType: Detection['resourceType'], sts: PolicyStatement[]): Detection[] {
  const found = new Map<string, Detection>();
  for (const st of sts) {
    if (st.Effect !== 'Allow' || !st.Principal) continue;
    const condition = flatCondition(st);
    // a condition that pins the caller to this account keeps the access inside the zone of trust
    if (Object.entries(condition).some(([k, v]) => ['aws:principalaccount', 'aws:sourceaccount'].includes(k.toLowerCase()) && v === env.accountId)) continue;
    for (const p of st.Principal === '*' ? ['*'] : list(st.Principal.AWS)) {
      const ext = externalPrincipal(env, p);
      if (!ext) continue;
      const group = JSON.stringify([ext, condition]);
      const d = found.get(group) ?? { key: '', findingType: 'ExternalAccess', resource, resourceType, resourceOwnerAccount: env.accountId, principal: { AWS: ext }, action: [], condition, isPublic: false, ...(resourceType === 'AWS::S3::Bucket' ? { sources: [{ type: 'POLICY' as const }] } : {}) };
      d.action = [...new Set([...d.action!, ...list(st.Action)])].sort();
      d.isPublic ||= ext === '*' && isPolicyPublic({ Statement: [st] });
      found.set(group, d);
    }
  }
  return [...found.values()].map((d) => ({ ...d, key: `${d.resource}|${JSON.stringify(d.principal)}|${JSON.stringify(d.condition)}|${d.action!.join(',')}` }));
}

function detectExternal(env: AwsEnv): Detection[] {
  const buckets = env.buckets.flatMap((b) => {
    // RestrictPublicBuckets: a public bucket policy only works inside the account, so nobody outside has access
    if (!b.policy || (isPolicyPublic(b.policy) && b.blockPublicAccess.restrictPublicBuckets)) return [];
    return b.region === env.region ? externalAccess(env, bucketArn(b.name), 'AWS::S3::Bucket', statements(b.policy)) : [];
  });
  const roles = env.iamRoles.flatMap((r) =>
    externalAccess(env, r.arn, 'AWS::IAM::Role', statements(r.assumeRolePolicyDocument).filter((st) => list(st.Action).some((a) => matchWildcard(a, 'sts:AssumeRole', true)))),
  );
  return [...buckets, ...roles];
}

/** Services the role's Allow statements name (actions like `*` or `*:Describe*` are skipped). */
export function grantedServices(env: AwsEnv, r: IamRole): string[] {
  const docs = [...r.attachedPolicyArns.map((a) => findPolicy(env, a)?.document), ...r.inlinePolicies.map((p) => p.document)].filter((d) => !!d);
  const services = docs.flatMap((d) => statements(d).filter((s) => s.Effect === 'Allow').flatMap((s) => list(s.Action))).map((a) => a.split(':')[0].toLowerCase());
  return [...new Set(services.filter((s) => s && s !== '*'))].sort();
}

/** Roles that existed for the whole tracking period: unused ones, or the services they did not use. */
function detectUnused(env: AwsEnv, a: Analyzer, now: number): Detection[] {
  const since = now - (a.unusedAccessAge ?? 90) * DAY;
  const usage = env.accessAnalyzer?.usage ?? {};
  return env.iamRoles
    .filter((r) => Date.parse(r.createDate) <= since && !r.path.startsWith('/aws-service-role/'))
    .flatMap((r): Detection[] => {
      const u = usage[r.arn];
      const base = { resource: r.arn, resourceType: 'AWS::IAM::Role' as const, resourceOwnerAccount: env.accountId };
      if (!u?.lastAccessed || u.lastAccessed < since) return [{ ...base, key: `UnusedIAMRole|${r.arn}`, findingType: 'UnusedIAMRole', lastAccessed: u?.lastAccessed }];
      const unused = grantedServices(env, r)
        .filter((s) => !(u.services[s] >= since))
        .map((s) => ({ serviceNamespace: s, ...(u.services[s] ? { lastAccessed: u.services[s] } : {}) }));
      return unused.length ? [{ ...base, key: `UnusedPermission|${r.arn}|${unused.map((x) => x.serviceNamespace).join(',')}`, findingType: 'UnusedPermission', unusedServices: unused }] : [];
    });
}

/** What the analyzer would report if it analyzed everything now. */
export function detect(env: AwsEnv, a: Analyzer, now: number): Detection[] {
  return isUnusedAnalyzer(a) ? detectUnused(env, a, now) : detectExternal(env);
}

/** Analyze (one resource or everything) and merge into the findings. */
function analyze(env: AwsEnv, a: Analyzer, now: number, resource?: string) {
  const found = detect(env, a, now).filter((d) => !resource || d.resource === resource);
  const open = a.findings.filter((f) => f.status !== 'RESOLVED' && (!resource || f.resource === resource));
  for (const f of open) {
    const d = found.find((x) => x.key === f.key);
    Object.assign(f, d ? { ...d, analyzedAt: now } : { status: 'RESOLVED', analyzedAt: now, updatedAt: now });
  }
  for (const d of found) {
    if (open.some((f) => f.key === d.key)) continue;
    const f: Finding = { ...d, id: newUuid(), status: 'ACTIVE', createdAt: now, analyzedAt: now, updatedAt: now };
    if (a.archiveRules.some((r) => matchesFilter(f, r.filter))) f.status = 'ARCHIVED';
    a.findings.push(f);
  }
  a.lastResourceAnalyzed = resource ?? found.at(-1)?.resource ?? a.lastResourceAnalyzed;
  a.lastResourceAnalyzedAt = now;
}

const openKeys = (a: Analyzer) => a.findings.filter((f) => f.status !== 'RESOLVED').map((f) => f.key).sort().join('\n');
/** Do the findings differ from what the policies say now? */
export const isStale = (env: AwsEnv, a: Analyzer, now: number) => openKeys(a) !== detect(env, a, now).map((d) => d.key).sort().join('\n');

// ---------- filters ----------

const FILTER_KEYS = {
  external: ['resource', 'resourceType', 'resourceOwnerAccount', 'isPublic', 'findingType', 'status', 'id', 'error', 'principal.AWS', 'principal.Federated'],
  unused: ['resource', 'resourceType', 'resourceOwnerAccount', 'findingType', 'status', 'id'],
};

/** status / id can filter a list but not define an archive rule */
export function checkFilter(a: Analyzer, filter: FindingFilter, forRule: boolean) {
  for (const [key, c] of Object.entries(filter)) {
    const known = isUnusedAnalyzer(a) ? FILTER_KEYS.unused.includes(key) : FILTER_KEYS.external.includes(key) || key.startsWith('condition.');
    if (!known || (forRule && (key === 'status' || key === 'id'))) throw new AwsError('ValidationException', `Invalid filter key: ${key}`);
    if (!c || [c.eq, c.neq, c.contains, c.exists].every((x) => x === undefined)) throw new AwsError('ValidationException', `Invalid criterion for filter key: ${key}. Specify eq, neq, contains or exists.`);
  }
}

function filterValues(f: Finding, key: string): string[] {
  const [head, ...rest] = key.split('.');
  const v = head === 'principal' ? f.principal?.[rest.join('.')] : head === 'condition' ? f.condition?.[rest.join('.')] : (f as unknown as Record<string, unknown>)[key];
  return v === undefined ? [] : head === 'condition' ? String(v).split(',') : [String(v)];
}

export function matchesFilter(f: Finding, filter: FindingFilter): boolean {
  return Object.entries(filter).every(([key, c]) => {
    const vs = filterValues(f, key);
    return (c.exists === undefined || vs.length > 0 === c.exists) && (!c.eq || c.eq.some((e) => vs.includes(e))) && (!c.neq || !c.neq.some((e) => vs.includes(e))) && (!c.contains || c.contains.some((e) => vs.some((v) => v.includes(e))));
  });
}

// ---------- operations ----------

export function createAnalyzer(env: AwsEnv, input: { name: string; type: string; unusedAccessAge?: number; archiveRules?: { ruleName: string; filter: FindingFilter }[] }, now = Date.now()): string {
  const { name, type } = input;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,254}$/.test(name)) throw new AwsError('ValidationException', `1 validation error detected: Value '${name}' at 'analyzerName' failed to satisfy constraint: Member must satisfy regular expression pattern: [A-Za-z_][A-Za-z0-9_.-]*`);
  if (!(ANALYZER_TYPES as readonly string[]).includes(type)) throw new AwsError('ValidationException', `1 validation error detected: Value '${type}' at 'type' failed to satisfy constraint: Member must satisfy enum value set: [${ANALYZER_TYPES.join(', ')}]`);
  if (type !== 'ACCOUNT' && type !== 'ACCOUNT_UNUSED_ACCESS') throw new AwsError('ValidationException', `(シミュレーター) タイプ ${type} のアナライザーには対応していません。ACCOUNT か ACCOUNT_UNUSED_ACCESS を指定してください`);
  if (analyzersOf(env).some((a) => a.name === name)) throw new AwsError('ConflictException', `Analyzer ${name} already exists`);
  if (analyzersOf(env).some((a) => a.type === type)) throw new AwsError('ServiceQuotaExceededException', `You can create only one analyzer of type ${type} per account per Region`);
  const unused = type === 'ACCOUNT_UNUSED_ACCESS';
  if (!unused && input.unusedAccessAge !== undefined) throw new AwsError('ValidationException', 'The unusedAccess configuration is only valid for an unused access analyzer');
  const age = unused ? (input.unusedAccessAge ?? 90) : undefined;
  if (age !== undefined && (!Number.isInteger(age) || age < 1 || age > 365)) throw new AwsError('ValidationException', 'unusedAccessAge must be between 1 and 365 days');
  const a: Analyzer = { name, arn: analyzerArn(env, name), type, status: 'ACTIVE', createdAt: now, ...(age ? { unusedAccessAge: age } : {}), archiveRules: [], findings: [] };
  for (const r of input.archiveRules ?? []) a.archiveRules.push(newRule(a, r.ruleName, r.filter, now));
  state(env).analyzers.push(a);
  analyze(env, a, now);
  record(env, 'CreateAnalyzer', { analyzerName: name, type, ...(age ? { configuration: { unusedAccess: { unusedAccessAge: age } } } : {}) }, { arn: a.arn });
  return a.arn;
}

export function deleteAnalyzer(env: AwsEnv, name: string) {
  const a = getAnalyzer(env, name);
  state(env).analyzers = analyzersOf(env).filter((x) => x !== a);
  record(env, 'DeleteAnalyzer', { analyzerName: a.name });
}

function newRule(a: Analyzer, ruleName: string, filter: FindingFilter, now: number): ArchiveRule {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,254}$/.test(ruleName)) throw new AwsError('ValidationException', `1 validation error detected: Value '${ruleName}' at 'ruleName' failed to satisfy constraint: Member must satisfy regular expression pattern: [A-Za-z][A-Za-z0-9_.-]*`);
  if (a.archiveRules.some((r) => r.ruleName === ruleName)) throw new AwsError('ConflictException', `Archive rule ${ruleName} already exists`);
  if (!Object.keys(filter).length) throw new AwsError('ValidationException', 'The filter must contain at least one criterion');
  checkFilter(a, filter, true);
  return { ruleName, filter, createdAt: now, updatedAt: now };
}

/** Archives matching findings from now on. Existing ones stay as they are (applyArchiveRule does that). */
export function createArchiveRule(env: AwsEnv, analyzerName: string, ruleName: string, filter: FindingFilter, now = Date.now()) {
  const a = getAnalyzer(env, analyzerName);
  a.archiveRules.push(newRule(a, ruleName, filter, now));
  record(env, 'CreateArchiveRule', { analyzerName: a.name, ruleName, filter });
}

export function getArchiveRule(a: Analyzer, ruleName: string): ArchiveRule {
  const r = a.archiveRules.find((x) => x.ruleName === ruleName);
  if (!r) throw new AwsError('ResourceNotFoundException', 'Archive rule not found');
  return r;
}

export function deleteArchiveRule(env: AwsEnv, analyzerName: string, ruleName: string) {
  const a = getAnalyzer(env, analyzerName);
  const r = getArchiveRule(a, ruleName);
  a.archiveRules = a.archiveRules.filter((x) => x !== r);
  record(env, 'DeleteArchiveRule', { analyzerName: a.name, ruleName });
}

/** Retroactively archive the ACTIVE findings the rule matches. Returns how many. */
export function applyArchiveRule(env: AwsEnv, analyzer: string, ruleName: string, now = Date.now()): number {
  const a = getAnalyzer(env, analyzer);
  const r = getArchiveRule(a, ruleName);
  const hit = a.findings.filter((f) => f.status === 'ACTIVE' && matchesFilter(f, r.filter));
  for (const f of hit) Object.assign(f, { status: 'ARCHIVED', updatedAt: now });
  record(env, 'ApplyArchiveRule', { analyzerArn: a.arn, ruleName });
  return hit.length;
}

/** Archive (or reactivate) findings by id, or every finding of a resource. Resolved findings stay resolved. */
export function updateFindings(env: AwsEnv, analyzer: string, input: { status: string; ids?: string[]; resourceArn?: string }, now = Date.now()) {
  const a = getAnalyzer(env, analyzer);
  if (input.status !== 'ACTIVE' && input.status !== 'ARCHIVED') throw new AwsError('ValidationException', `1 validation error detected: Value '${input.status}' at 'status' failed to satisfy constraint: Member must satisfy enum value set: [ACTIVE, ARCHIVED]`);
  if (!input.ids?.length && !input.resourceArn) throw new AwsError('ValidationException', 'Either ids or resourceArn must be specified');
  const targets = input.ids?.length ? input.ids.map((id) => getFinding(a, id)) : a.findings.filter((f) => f.resource === input.resourceArn);
  for (const f of targets) if (f.status !== 'RESOLVED' && f.status !== input.status) Object.assign(f, { status: input.status, updatedAt: now });
  record(env, 'UpdateFindings', { analyzerArn: a.arn, status: input.status, ...(input.ids?.length ? { ids: input.ids } : { resourceArn: input.resourceArn }) });
}

/** Analyze one resource right away (external access analyzers only). */
export function startResourceScan(env: AwsEnv, analyzer: string, resourceArn: string, now = Date.now()) {
  const a = getAnalyzer(env, analyzer);
  if (isUnusedAnalyzer(a)) throw new AwsError('ValidationException', `StartResourceScan is not supported for analyzers of type ${a.type}`);
  analyze(env, a, now, resourceArn);
  record(env, 'StartResourceScan', { analyzerArn: a.arn, resourceArn });
}

/**
 * The IAM console's "ロールを削除": detaches the managed policies, deletes the inline ones and takes the role out of its
 * instance profiles first (with the CLI those are separate calls, and delete-role fails until they are done).
 */
export function deleteRoleWithPolicies(env: AwsEnv, name: string) {
  const r = getRole(env, name);
  for (const arn of [...r.attachedPolicyArns]) detachPolicy(env, 'role', name, arn);
  for (const p of [...r.inlinePolicies]) deleteInlinePolicy(env, 'role', name, p.policyName);
  for (const ip of env.instanceProfiles.filter((p) => p.roleNames.includes(name))) {
    ip.roleNames = ip.roleNames.filter((n) => n !== name);
    trail(env, { source: 'iam', name: 'RemoveRoleFromInstanceProfile', resources: [['AWS::IAM::InstanceProfile', ip.arn]], request: { instanceProfileName: ip.instanceProfileName, roleName: name }, response: null });
  }
  env.iamRoles = env.iamRoles.filter((x) => x !== r);
  trail(env, { source: 'iam', name: 'DeleteRole', resources: [['AWS::IAM::Role', r.arn]], request: { roleName: name }, response: null });
}

// ---------- clock ----------

/** Finish transitions whose time has passed (called from advanceTime). true = something changed */
export function advanceAccessAnalyzer(env: AwsEnv, now: number): boolean {
  let changed = false;
  for (const a of analyzersOf(env)) {
    if (a.rescanAt === undefined) {
      if (!isStale(env, a, Number.isFinite(now) ? now : Date.now())) continue;
      a.rescanAt = now + RESCAN_DELAY_MS;
    } else if (now >= a.rescanAt) {
      // Infinity = settle everything: the analysis happens "now"
      analyze(env, a, Number.isFinite(a.rescanAt) ? a.rescanAt : Date.now());
      delete a.rescanAt;
    } else continue;
    changed = true;
  }
  return changed;
}

/** Does this feature need the 1-second clock (something is in progress)? Analyzers watch the policies all the time. */
export function hasAccessAnalyzerTransitions(env: AwsEnv): boolean {
  return analyzersOf(env).length > 0;
}
