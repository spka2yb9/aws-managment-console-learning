// Amazon GuardDuty (lesson 43): the detector of the Region, findings, filters / suppression rules.
// The state lives in AwsEnv as an optional field (sessions saved by older versions don't have it).
// Findings are kept in the shape of the GuardDuty JSON (camelCase, like the console's JSON and the filter
// criteria field names); the CLI turns the keys into PascalCase.
import { ipInCidr, isValidCidr } from '../cidr';
import { trail } from '../cloudtrail';
import { privateDnsName, publicDnsName, AMIS } from '../ec2';
import { matchWildcard } from '../iam';
import { AwsError, type AwsEnv, type Instance } from '../types';

export interface RemoteIpDetails {
  ipAddressV4: string;
  city?: { cityName: string };
  country?: { countryName: string };
  geoLocation?: { lat: number; lon: number };
  organization?: { asn: string; asnOrg: string; isp: string; org: string };
}

export interface InstanceDetails {
  availabilityZone: string;
  iamInstanceProfile?: { arn: string; id: string };
  imageDescription: string;
  imageId: string;
  instanceId: string;
  instanceState: string;
  instanceType: string;
  launchTime: string;
  networkInterfaces: {
    ipv6Addresses: string[];
    networkInterfaceId: string;
    privateDnsName: string;
    privateIpAddress: string;
    privateIpAddresses: { privateDnsName: string; privateIpAddress: string }[];
    publicDnsName?: string;
    publicIp?: string;
    securityGroups: { groupId: string; groupName: string }[];
    subnetId: string;
    vpcId: string;
  }[];
  productCodes: never[];
  tags: { key: string; value: string }[];
}

export interface PortDetails {
  port: number;
  portName: string;
}

export interface Finding {
  accountId: string;
  arn: string;
  createdAt: string;
  description: string;
  id: string;
  partition: 'aws';
  region: string;
  resource: {
    resourceType: 'AccessKey' | 'Instance';
    accessKeyDetails?: { accessKeyId: string; principalId: string; userName: string; userType: string };
    instanceDetails?: InstanceDetails;
  };
  schemaVersion: '2.0';
  service: {
    action: {
      actionType: 'AWS_API_CALL' | 'NETWORK_CONNECTION' | 'PORT_PROBE';
      awsApiCallAction?: { api: string; callerType: string; serviceName: string; userAgent?: string; remoteIpDetails: RemoteIpDetails; affectedResources: Record<string, string> };
      networkConnectionAction?: { blocked: boolean; connectionDirection: 'INBOUND' | 'OUTBOUND'; localIpDetails: { ipAddressV4: string }; localPortDetails: PortDetails; protocol: string; remoteIpDetails: RemoteIpDetails; remotePortDetails: PortDetails };
      portProbeAction?: { blocked: boolean; portProbeDetails: { localIpDetails: { ipAddressV4: string }; localPortDetails: PortDetails; remoteIpDetails: RemoteIpDetails }[] };
    };
    additionalInfo: { value: string; type: 'default' };
    archived: boolean;
    count: number;
    detectorId: string;
    eventFirstSeen: string;
    eventLastSeen: string;
    resourceRole: 'TARGET' | 'ACTOR';
    serviceName: 'guardduty';
  };
  severity: number;
  title: string;
  type: string;
  updatedAt: string;
}

export const CONDITION_KEYS = ['Eq', 'Neq', 'Gt', 'Gte', 'Lt', 'Lte', 'Equals', 'NotEquals', 'GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual', 'Matches', 'NotMatches'] as const;
export type Condition = Partial<Record<(typeof CONDITION_KEYS)[number], string[] | number>>;
/** FindingCriteria.Criterion: field (JSON name) → condition */
export type Criterion = Record<string, Condition>;

/** a saved filter; action ARCHIVE = a suppression rule */
export interface FindingFilter {
  name: string;
  description?: string;
  action: 'NOOP' | 'ARCHIVE';
  rank: number;
  criterion: Criterion;
  createdAt: number;
}

export interface GuardDutyState {
  detectorId: string;
  createdAt: number;
  status: 'ENABLED' | 'DISABLED';
  findingPublishingFrequency: 'FIFTEEN_MINUTES' | 'ONE_HOUR' | 'SIX_HOURS';
  findings: Finding[];
  filters: FindingFilter[];
}

/** Finish transitions whose time has passed (called from advanceTime). true = something changed */
export function advanceGuardDuty(env: AwsEnv, now: number): boolean {
  void env;
  void now;
  return false;
}

/** Does this feature need the 1-second clock (something is in progress)? */
export function hasGuardDutyTransitions(env: AwsEnv): boolean {
  void env;
  return false;
}

// ---------- severity ----------

export const SEVERITY_LEVELS = [
  { min: 9, label: '重大', en: 'CRITICAL' },
  { min: 7, label: '高', en: 'HIGH' },
  { min: 4, label: '中', en: 'MEDIUM' },
  { min: 0, label: '低', en: 'LOW' },
] as const;
export const severityLevel = (severity: number) => SEVERITY_LEVELS.find((l) => severity >= l.min)!;

// ---------- filter fields (the console's property filters and their JSON names) ----------

export const FILTER_FIELDS: Record<string, string> = {
  type: '検出結果タイプ',
  severity: '重要度',
  id: '検出結果 ID',
  accountId: 'アカウント ID',
  region: 'リージョン',
  updatedAt: '更新時刻',
  'resource.resourceType': 'リソースタイプ',
  'resource.accessKeyDetails.accessKeyId': 'アクセスキー ID',
  'resource.accessKeyDetails.principalId': 'プリンシパル ID',
  'resource.accessKeyDetails.userName': 'ユーザーネーム',
  'resource.accessKeyDetails.userType': 'ユーザータイプ',
  'resource.instanceDetails.instanceId': 'インスタンス ID',
  'resource.instanceDetails.imageId': 'インスタンスイメージ ID',
  'resource.instanceDetails.tags.key': 'インスタンスのタグキー',
  'resource.instanceDetails.tags.value': 'インスタンスのタグ値',
  'resource.instanceDetails.iamInstanceProfile.id': 'IAM インスタンスプロファイル ID',
  'resource.instanceDetails.networkInterfaces.publicIp': 'パブリック IP',
  'resource.instanceDetails.networkInterfaces.privateIpAddresses.privateIpAddress': 'プライベート IPv4 アドレス',
  'resource.instanceDetails.networkInterfaces.securityGroups.groupId': 'セキュリティグループ ID',
  'resource.instanceDetails.networkInterfaces.securityGroups.groupName': 'セキュリティグループ名',
  'resource.instanceDetails.networkInterfaces.subnetId': 'サブネット ID',
  'resource.instanceDetails.networkInterfaces.vpcId': 'VPC ID',
  'service.archived': 'アーカイブ済み',
  'service.resourceRole': 'リソースロール',
  'service.action.actionType': 'アクションタイプ',
  'service.action.awsApiCallAction.api': '呼び出された API',
  'service.action.awsApiCallAction.callerType': 'API 発信者のタイプ',
  'service.action.awsApiCallAction.serviceName': 'API 発信者のサービス名',
  'service.action.awsApiCallAction.remoteIpDetails.ipAddressV4': 'API 発信者の IPv4 アドレス',
  'service.action.awsApiCallAction.remoteIpDetails.country.countryName': 'API 発信者の国',
  'service.action.awsApiCallAction.remoteIpDetails.city.cityName': 'API 発信者の都市',
  'service.action.awsApiCallAction.remoteIpDetails.organization.asn': 'API 発信者の ASN ID',
  'service.action.awsApiCallAction.remoteIpDetails.organization.asnOrg': 'API 発信者の ASN 名',
  'service.action.networkConnectionAction.connectionDirection': 'ネットワーク接続の方向',
  'service.action.networkConnectionAction.protocol': 'ネットワーク接続プロトコル',
  'service.action.networkConnectionAction.remoteIpDetails.ipAddressV4': 'ネットワーク接続のリモート IPv4 アドレス',
  'service.action.networkConnectionAction.remotePortDetails.port': 'ネットワーク接続のリモートポート',
  'service.action.networkConnectionAction.localPortDetails.port': 'ネットワーク接続のローカルポート',
};
const TIMESTAMP_FIELDS = ['updatedAt', 'createdAt', 'service.eventFirstSeen', 'service.eventLastSeen'];

const badRequest = (message: string) => new AwsError('BadRequestException', message);
const INVALID = 'The request is rejected because an invalid or out-of-range value is specified as an input parameter.';

/** Values of a dotted JSON path (lists along the way are flattened: tags.value = every tag value) */
function valuesAt(f: Finding, field: string): (string | number | boolean)[] {
  let cur: unknown[] = [f];
  for (const key of field.split('.')) cur = cur.flatMap((x) => (x && typeof x === 'object' ? [(x as Record<string, unknown>)[key]].flat() : [])).filter((x) => x !== undefined && x !== null);
  return cur.filter((x): x is string | number | boolean => typeof x !== 'object');
}

/** Criterion as the API takes it, checked like GuardDuty does (unknown fields and conditions are rejected) */
export function parseCriterion(input: unknown, opts: { wildcards?: boolean } = {}): Criterion {
  const c = input && typeof input === 'object' && 'Criterion' in input ? (input as { Criterion: unknown }).Criterion : input;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw badRequest(INVALID);
  const out: Criterion = {};
  for (const [field, cond] of Object.entries(c as Record<string, unknown>)) {
    if (!(field in FILTER_FIELDS) && !TIMESTAMP_FIELDS.includes(field)) throw badRequest(`${INVALID} (unknown field: ${field})`);
    if (!cond || typeof cond !== 'object' || Array.isArray(cond) || !Object.keys(cond).length) throw badRequest(INVALID);
    const parsed: Condition = {};
    for (const [op, v] of Object.entries(cond as Record<string, unknown>)) {
      if (!(CONDITION_KEYS as readonly string[]).includes(op)) throw badRequest(`${INVALID} (unknown condition: ${op})`);
      if (/Matches$/.test(op) && !opts.wildcards) throw badRequest('The request is rejected because Matches and NotMatches conditions are only supported for filters (CreateFilter / UpdateFilter).');
      const isList = /^(Eq|Neq|Equals|NotEquals|Matches|NotMatches)$/.test(op);
      if (isList ? !Array.isArray(v) || !v.length : typeof v !== 'number' && !(typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) throw badRequest(INVALID);
      parsed[op as keyof Condition] = isList ? (v as unknown[]).map(String) : Number(v);
    }
    out[field] = parsed;
  }
  return out;
}

function conditionHolds(f: Finding, field: string, cond: Condition): boolean {
  const raw = valuesAt(f, field);
  const isTime = TIMESTAMP_FIELDS.includes(field);
  const nums = raw.map((v) => (isTime ? Date.parse(String(v)) : Number(v)));
  const strs = raw.map(String);
  // severity is matched by level: Equals ["7","8"] = 7.0 - 8.9 (High)
  const eq = (want: string) => (field === 'severity' ? nums.some((n) => Math.floor(n) === Number(want)) : strs.some((s) => s === want || (want.includes('/') && isValidCidr(want) && /^\d+\.\d+\.\d+\.\d+$/.test(s) && ipInCidr(s, want))));
  return Object.entries(cond).every(([op, v]) => {
    const list = Array.isArray(v) ? v : [];
    const n = Number(v);
    switch (op) {
      case 'Eq':
      case 'Equals':
        return list.some(eq);
      case 'Neq':
      case 'NotEquals':
        return !list.some(eq);
      case 'Gt':
      case 'GreaterThan':
        return nums.some((x) => x > n);
      case 'Gte':
      case 'GreaterThanOrEqual':
        return nums.some((x) => x >= n);
      case 'Lt':
      case 'LessThan':
        return nums.some((x) => x < n);
      case 'Lte':
      case 'LessThanOrEqual':
        return nums.some((x) => x <= n);
      case 'Matches':
        return list.some((w) => strs.some((s) => matchWildcard(w, s, false)));
      case 'NotMatches':
        return !list.some((w) => strs.some((s) => matchWildcard(w, s, false)));
      default:
        return false;
    }
  });
}

/** Does the finding meet every condition of the criterion (AND)? */
export const findingMatches = (f: Finding, criterion: Criterion) => Object.entries(criterion).every(([field, cond]) => conditionHolds(f, field, cond));

// ---------- operations ----------

const gd = (env: AwsEnv, name: string, request: unknown, response: Record<string, unknown> | null = {}) => trail(env, { source: 'guardduty', name, request, response });

export function getDetector(env: AwsEnv, detectorId: string): GuardDutyState {
  const d = env.guardDuty;
  if (!d || d.detectorId !== detectorId) throw badRequest('The request is rejected because the input detectorId is not owned by the current account.');
  return d;
}

/** ListFindings: every finding, archived or not, unless the criterion says otherwise */
export function listFindings(env: AwsEnv, detectorId: string, criterion: Criterion = {}, sort?: { attributeName: string; orderBy: 'ASC' | 'DESC' }): Finding[] {
  const found = getDetector(env, detectorId).findings.filter((f) => findingMatches(f, criterion));
  const key = (f: Finding) => (sort ? valuesAt(f, sort.attributeName)[0] ?? '' : f.updatedAt);
  const dir = sort?.orderBy === 'ASC' ? 1 : -1;
  return [...found].sort((a, b) => (key(a) < key(b) ? -dir : key(a) > key(b) ? dir : 0));
}

export function setArchived(env: AwsEnv, detectorId: string, findingIds: string[], archived: boolean) {
  const d = getDetector(env, detectorId);
  if (!findingIds.length) throw badRequest(INVALID);
  for (const id of findingIds) if (!d.findings.some((f) => f.id === id)) throw badRequest('The request is rejected because the input findingId is not owned by the current account.');
  for (const f of d.findings) if (findingIds.includes(f.id)) f.service.archived = archived;
  gd(env, archived ? 'ArchiveFindings' : 'UnarchiveFindings', { detectorId, findingIds });
}

export function createFilter(env: AwsEnv, detectorId: string, input: { name: string; description?: string; action?: 'NOOP' | 'ARCHIVE'; rank?: number; criterion: Criterion }, now = Date.now()): FindingFilter {
  const d = getDetector(env, detectorId);
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(input.name)) throw badRequest(`${INVALID} (name: 3-64 characters of a-z, A-Z, 0-9, period, hyphen, underscore)`);
  if ((input.description ?? '').length > 512) throw badRequest(INVALID);
  if (input.action && input.action !== 'NOOP' && input.action !== 'ARCHIVE') throw badRequest(INVALID);
  if (!Object.keys(input.criterion).length) throw badRequest(INVALID);
  if (d.filters.some((x) => x.name === input.name)) throw badRequest('The request is rejected because a filter with the same name already exists.');
  const rank = input.rank ?? d.filters.length + 1;
  if (!Number.isInteger(rank) || rank < 1 || rank > d.filters.length + 1) throw badRequest(INVALID);
  const filter: FindingFilter = { name: input.name, ...(input.description ? { description: input.description } : {}), action: input.action ?? 'NOOP', rank, criterion: input.criterion, createdAt: now };
  d.filters.push(filter);
  gd(env, 'CreateFilter', { detectorId, name: filter.name, description: filter.description, action: filter.action, rank, findingCriteria: { criterion: filter.criterion } }, { name: filter.name });
  return filter;
}

export function deleteFilter(env: AwsEnv, detectorId: string, name: string) {
  const d = getDetector(env, detectorId);
  if (!d.filters.some((x) => x.name === name)) throw badRequest('The request is rejected because the input filterName does not exist.');
  d.filters = d.filters.filter((x) => x.name !== name);
  gd(env, 'DeleteFilter', { detectorId, filterName: name });
}

/** suppression rules = filters whose action is ARCHIVE */
export const suppressionRules = (d: GuardDutyState) => d.filters.filter((x) => x.action === 'ARCHIVE');

/**
 * GuardDuty reports activity: a new finding, or another occurrence of an existing one (same id: count and times
 * move on). New and updated findings that match a suppression rule are archived right away; existing findings are
 * not touched when a rule is created (archive them yourself).
 */
export function recordFinding(env: AwsEnv, finding: Finding, now = Date.now()): Finding {
  const d = env.guardDuty!;
  const at = new Date(now).toISOString();
  const prev = d.findings.find((f) => f.id === finding.id);
  const f: Finding = prev ? { ...prev, updatedAt: at, service: { ...prev.service, count: prev.service.count + 1, eventLastSeen: at.replace(/\.\d+Z$/, 'Z'), archived: false } } : finding;
  if (suppressionRules(d).some((r) => findingMatches({ ...f, service: { ...f.service, archived: false } }, r.criterion))) f.service.archived = true;
  d.findings = [...d.findings.filter((x) => x.id !== f.id), f];
  return f;
}

/** GetFindingsStatistics COUNT_BY_SEVERITY: severity ("8.0") → count */
export function countBySeverity(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.severity.toFixed(1)] = (out[f.severity.toFixed(1)] ?? 0) + 1;
  return out;
}

// ---------- building findings ----------

/** resource.instanceDetails of a finding about this instance */
export function instanceDetails(env: AwsEnv, i: Instance): InstanceDetails {
  const profile = env.instanceProfiles.find((p) => p.arn === i.iamInstanceProfileArn);
  const ami = AMIS.find((a) => a.imageId === i.imageId);
  return {
    availabilityZone: i.availabilityZone,
    ...(profile ? { iamInstanceProfile: { arn: profile.arn, id: profile.instanceProfileId } } : {}),
    imageDescription: ami?.description ?? '',
    imageId: i.imageId,
    instanceId: i.instanceId,
    instanceState: i.state,
    instanceType: i.instanceType,
    launchTime: new Date(i.launchTime).toISOString().replace(/\.\d+Z$/, '.000Z'),
    networkInterfaces: [
      {
        ipv6Addresses: [],
        networkInterfaceId: `eni-${i.instanceId.slice(2)}`,
        privateDnsName: privateDnsName(env, i.privateIpAddress),
        privateIpAddress: i.privateIpAddress,
        privateIpAddresses: [{ privateDnsName: privateDnsName(env, i.privateIpAddress), privateIpAddress: i.privateIpAddress }],
        ...(i.publicIpAddress ? { publicDnsName: publicDnsName(env, i.publicIpAddress), publicIp: i.publicIpAddress } : {}),
        securityGroups: i.securityGroupIds.map((g) => ({ groupId: g, groupName: env.securityGroups.find((x) => x.groupId === g)?.groupName ?? g })),
        subnetId: i.subnetId,
        vpcId: i.vpcId,
      },
    ],
    productCodes: [],
    tags: i.tags.map((t) => ({ key: t.key, value: t.value })),
  };
}

/** The resource a finding is about, for lists: "AccessKey: admin-tool-role" / "Instance: i-…" */
export function findingResource(f: Finding): string {
  if (f.resource.resourceType === 'AccessKey') return `${f.resource.accessKeyDetails?.userName ?? ''}`;
  return f.resource.instanceDetails?.instanceId ?? '';
}
