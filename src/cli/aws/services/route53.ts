/* aws route53 — ホストゾーンとレコード (sim/edge.ts の changeRecord をそのまま使う)。Route 53 はグローバルなサービス */
import { alnum, changeRecord } from '../../../sim/edge';
import type { AwsEnv, DnsRecord, HostedZone } from '../../../sim/types';
import { AwsError, iso, req, service, str, struct, type OperationSpec, ParamError } from '../types';

/** エイリアスの HostedZoneId: ALB は リージョンごと、CloudFront は固定 */
const ALB_ZONE: Record<string, string> = { 'ap-northeast-1': 'Z14GRHDCWA56QT', 'us-east-1': 'Z35SXDOTRQ7X7K' };
export const CLOUDFRONT_ZONE = 'Z2FDTNDATAQYW2';

const dot = (s: string) => (s.endsWith('.') ? s : `${s}.`);
const bare = (s: string) => s.trim().toLowerCase().replace(/\.$/, '');
const zoneIdOf = (s: string) => s.replace(/^\/?hostedzone\//, '');

function zoneById(env: AwsEnv, raw: string): HostedZone {
  const id = zoneIdOf(raw);
  const z = env.hostedZones.find((x) => x.id === id);
  if (!z) throw new AwsError('NoSuchHostedZone', `No hosted zone found with ID: ${id}`);
  return z;
}

/** エイリアスの向き先 (ALB の DNS 名 / CloudFront のドメイン名) の HostedZoneId */
function aliasZoneOf(env: AwsEnv, target: string): string | undefined {
  if (env.loadBalancers.some((l) => l.dnsName === target)) return ALB_ZONE[env.region] ?? ALB_ZONE['ap-northeast-1'];
  if (env.distributions.some((d) => d.domainName === target)) return CLOUDFRONT_ZONE;
  return undefined;
}

const zoneOut = (z: HostedZone) => ({
  Id: `/hostedzone/${z.id}`,
  Name: dot(z.name),
  CallerReference: `RISWorkflow-RD:${alnum(z.id, 8).toLowerCase()}-${alnum(z.name, 4).toLowerCase()}`,
  Config: { ...(z.comment ? { Comment: z.comment } : {}), PrivateZone: false },
  ResourceRecordSetCount: z.records.length,
});

const recordOut = (env: AwsEnv, r: DnsRecord) =>
  r.aliasTarget
    ? { Name: dot(r.name), Type: r.type, AliasTarget: { HostedZoneId: aliasZoneOf(env, r.aliasTarget) ?? CLOUDFRONT_ZONE, DNSName: dot(r.aliasTarget), EvaluateTargetHealth: false } }
    : { Name: dot(r.name), Type: r.type, TTL: r.ttl ?? 300, ResourceRecords: r.values.map((Value) => ({ Value })) };

/* Route 53 はレコードを「ラベルを逆にした名前」の順で返す (Zone Apex が先頭) */
const sortKey = (r: DnsRecord) => `${r.name.split('.').reverse().join('.')} ${r.type}`;

/* 変更の ID に受け付けた時刻を埋め込んでおき、get-change で PENDING → INSYNC を決める (状態を持たずに済む) */
const SYNC_MS = 6000;
const changeId = (now: number) => `C${now.toString(36).toUpperCase().padStart(9, '0')}${alnum(String(Math.random()), 4)}`;
function changeOut(raw: string, now: number, comment?: string) {
  const id = raw.replace(/^\/?change\//, '');
  const at = /^C[0-9A-Z]{13}$/.test(id) ? parseInt(id.slice(1, 10), 36) : NaN;
  if (!Number.isFinite(at)) throw new AwsError('NoSuchChange', `A change with the specified change ID does not exist.`);
  return { ChangeInfo: { Id: `/change/${id}`, Status: now - at >= SYNC_MS ? 'INSYNC' : 'PENDING', SubmittedAt: iso(at), ...(comment ? { Comment: comment } : {}) } };
}

/* boto の Parameter validation failed (クライアント側の検査) */
function paramError(lines: string[]): never {
  throw new ParamError(`Parameter validation failed:\n${lines.join('\n')}`);
}

const ACTIONS = ['CREATE', 'UPSERT', 'DELETE'] as const;
const TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SOA'] as const;

/** ChangeBatch の 1 件を sim の DnsRecord へ */
function toRecord(env: AwsEnv, change: Record<string, unknown>, n: number): { action: (typeof ACTIONS)[number]; rec: DnsRecord } {
  const where = `ChangeBatch.Changes[${n}]`;
  const rrs = change.ResourceRecordSet as Record<string, unknown> | undefined;
  const missing = [...(change.Action === undefined ? [`Missing required parameter in ${where}: "Action"`] : []), ...(!rrs ? [`Missing required parameter in ${where}: "ResourceRecordSet"`] : [])];
  if (rrs && rrs.Name === undefined) missing.push(`Missing required parameter in ${where}.ResourceRecordSet: "Name"`);
  if (rrs && rrs.Type === undefined) missing.push(`Missing required parameter in ${where}.ResourceRecordSet: "Type"`);
  const alias = rrs?.AliasTarget as Record<string, unknown> | undefined;
  if (alias) for (const k of ['HostedZoneId', 'DNSName', 'EvaluateTargetHealth']) if (alias[k] === undefined) missing.push(`Missing required parameter in ${where}.ResourceRecordSet.AliasTarget: "${k}"`);
  if (missing.length) paramError(missing);
  const action = String(change.Action) as (typeof ACTIONS)[number];
  const type = String(rrs!.Type) as DnsRecord['type'];
  if (!ACTIONS.includes(action)) paramError([`Invalid value for parameter ${where}.Action, value: ${action}, valid values: ${ACTIONS.join(', ')}`]);
  if (!TYPES.includes(type)) throw new AwsError('InvalidInput', `Invalid request: Expected a valid record type, but found ${type}`);
  const name = bare(String(rrs!.Name));
  const values = Array.isArray(rrs!.ResourceRecords) ? (rrs!.ResourceRecords as { Value?: unknown }[]).map((r) => String(r?.Value ?? '')) : undefined;
  const hasTtlRecords = rrs!.TTL !== undefined && values !== undefined;
  if (!!alias === hasTtlRecords)
    throw new AwsError('InvalidInput', `Invalid request: Expected exactly one of [AliasTarget, all of [TTL, and ResourceRecords], or TrafficPolicyInstanceId], but found ${alias ? 'more than one' : 'none'} in Change with [Action=${action}, Name=${dot(name)}, Type=${type}, SetIdentifier=null]`);
  if (alias) {
    const target = bare(String(alias.DNSName)).replace(/^dualstack\./, '');
    const expected = aliasZoneOf(env, target);
    if (expected && expected !== String(alias.HostedZoneId)) throw new AwsError('InvalidChangeBatch', `[Tried to create an alias that targets ${dot(target)}, type ${type} in zone ${alias.HostedZoneId}, but the alias target name does not lie within the target zone]`);
    return { action, rec: { name, type, values: [], aliasTarget: target } };
  }
  return { action, rec: { name, type, ttl: Number(rrs!.TTL), values: values! } };
}

const ops: OperationSpec[] = [
  {
    name: 'list-hosted-zones',
    desc: 'ホストゾーンの一覧 (Id・Name・レコードの数)',
    params: [],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ HostedZones: ctx.env.hostedZones.map(zoneOut) }),
  },
  {
    name: 'list-hosted-zones-by-name',
    desc: 'ホストゾーンを名前の順に一覧する (--dns-name から後ろ)',
    params: [{ name: 'dns-name', type: 'string', desc: 'この名前から後ろを返す (例: webapp-shop.example)' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const from = str(ctx, 'dns-name');
      const key = (n: string) => bare(n).split('.').reverse().join('.');
      const zones = [...ctx.env.hostedZones].sort((a, b) => key(a.name).localeCompare(key(b.name))).filter((z) => !from || key(z.name) >= key(from));
      return { HostedZones: zones.map(zoneOut), ...(from ? { DNSName: dot(from) } : {}), IsTruncated: false, MaxItems: '100' };
    },
  },
  {
    name: 'list-resource-record-sets',
    desc: 'ホストゾーンのレコードの一覧 (Name・Type・TTL・値 / AliasTarget)',
    params: [{ name: 'hosted-zone-id', type: 'string', required: true, desc: 'ホストゾーンの ID (Z… か /hostedzone/Z…)' }],
    readOnly: true,
    scope: 'global',
    examples: ['aws route53 list-resource-record-sets --hosted-zone-id Z0123456789ABCDEFGHIJ'],
    run(ctx) {
      const z = zoneById(ctx.env, req(ctx, 'hosted-zone-id'));
      return { ResourceRecordSets: [...z.records].sort((a, b) => sortKey(a).localeCompare(sortKey(b))).map((r) => recordOut(ctx.env, r)) };
    },
  },
  {
    name: 'change-resource-record-sets',
    desc: 'レコードを作成・更新・削除する (CREATE / UPSERT / DELETE をまとめて 1 回で)',
    params: [
      { name: 'hosted-zone-id', type: 'string', required: true, desc: 'ホストゾーンの ID' },
      { name: 'change-batch', type: 'structure', required: true, desc: '変更の一覧 ({"Changes": [{"Action": "UPSERT", "ResourceRecordSet": {...}}]})。file://batch.json で渡すのが普通' },
    ],
    scope: 'global',
    examples: ['aws route53 change-resource-record-sets --hosted-zone-id Z0123456789ABCDEFGHIJ --change-batch file://batch.json'],
    run(ctx) {
      const z = zoneById(ctx.env, req(ctx, 'hosted-zone-id'));
      const batch = struct(ctx, 'change-batch') ?? {};
      if (!Array.isArray(batch.Changes)) paramError(['Missing required parameter in ChangeBatch: "Changes"']);
      const changes = batch.Changes as Record<string, unknown>[];
      if (!changes.length) paramError(['Invalid length for parameter ChangeBatch.Changes, value: 0, valid min length: 1']);
      // 全部まとめて 1 つの変更。どれか 1 つでも失敗すれば AwsError で何も変わらない
      changes.map((c, n) => toRecord(ctx.env, c, n)).forEach(({ action, rec }) => changeRecord(ctx.env, z.id, action, rec));
      return changeOut(changeId(ctx.now), ctx.now, batch.Comment === undefined ? undefined : String(batch.Comment));
    },
  },
  {
    name: 'get-change',
    desc: 'change-resource-record-sets の変更が反映されたか (PENDING → INSYNC)',
    params: [{ name: 'id', type: 'string', required: true, desc: '変更の ID (/change/C…)' }],
    readOnly: true,
    scope: 'global',
    run: (ctx) => changeOut(req(ctx, 'id'), ctx.now),
  },
  {
    name: 'wait resource-record-sets-changed',
    desc: '変更が INSYNC になるまで待つ',
    params: [{ name: 'id', type: 'string', required: true, desc: '変更の ID (/change/C…)' }],
    readOnly: true,
    scope: 'global',
    waiter: { until: (ctx) => changeOut(req(ctx, 'id'), ctx.now).ChangeInfo.Status === 'INSYNC', delayMs: 3000, maxAttempts: 40 },
    run: () => undefined,
  },
];

export default service('route53', 'Amazon Route 53 (DNS: ホストゾーンとレコード)', ops);
