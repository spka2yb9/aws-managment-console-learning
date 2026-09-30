import { label } from './env';
import { evaluateSecurityGroup, portRangeLabel, protocolLabel, sourceOf, type Direction, type Packet, type SgEvaluation } from './sg';
import type { AwsEnv, DbStatus, InstanceStateName } from './types';

const INSTANCE_STATE_JA: Record<InstanceStateName, string> = { pending: '保留中', running: '実行中', stopping: '停止中', stopped: '停止済み', 'shutting-down': 'シャットダウン中', terminated: '終了済み' };
const DB_STATUS_JA: Record<DbStatus, string> = { creating: '作成中', 'backing-up': 'バックアップ中', available: '利用可能', modifying: '変更中', renaming: '名前の変更中', stopping: '停止中', stopped: '停止済み', starting: '起動中', deleting: '削除中' };
import { evaluateNacl, rangeLabel, subnetNacl, type PortRange } from './nacl';
import { effectiveRouteTable, evaluateRoute, routesToInternet } from './vpc';

/** One line of a connectivity explanation, shown to learners as "why does / doesn't this work". */
export interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

export interface Connectivity {
  ok: boolean;
  checks: Check[];
}

/** "My IP" of the learner's simulated PC (TEST-NET-2, never a real address). */
export const CLIENT_IP = '198.51.100.24';

export interface Endpoint {
  id: string;
  kind: 'instance' | 'load-balancer' | 'db' | 'task';
  name: string;
  vpcId: string;
  /** network interfaces: one for an instance / DB, one per subnet for a load balancer */
  nodes: { subnetId: string; ip: string }[];
  groupIds: string[];
  up: boolean;
  stateText: string;
  /** source ports this endpoint uses when it opens connections (the return traffic comes back to these) */
  ephemeral: PortRange;
}

/** Ephemeral (client) port ranges: Linux 32768-60999, Windows / macOS 49152-65535, Elastic Load Balancing 1024-65535. */
export const EPHEMERAL = { linux: [32768, 60999] as PortRange, windows: [49152, 65535] as PortRange, elb: [1024, 65535] as PortRange };
/** the learner's PC (Windows / macOS) */
export const CLIENT_EPHEMERAL = EPHEMERAL.windows;

/** Resolve an instance id, load balancer ARN/name or DB identifier to its network interfaces. */
export function endpointOf(env: AwsEnv, id: string): Endpoint | null {
  const i = env.instances.find((x) => x.instanceId === id);
  if (i)
    return {
      id,
      kind: 'instance',
      name: label(i.instanceId, i),
      vpcId: i.vpcId,
      nodes: i.state === 'terminated' ? [] : [{ subnetId: i.subnetId, ip: i.privateIpAddress }],
      groupIds: i.securityGroupIds,
      up: i.state === 'running',
      stateText: `インスタンスの状態: ${INSTANCE_STATE_JA[i.state]}`,
      ephemeral: i.platformDetails === 'Windows' ? EPHEMERAL.windows : EPHEMERAL.linux,
    };
  const lb = env.loadBalancers.find((x) => x.loadBalancerArn === id || x.loadBalancerName === id);
  if (lb)
    return {
      id: lb.loadBalancerArn,
      kind: 'load-balancer',
      name: lb.loadBalancerName,
      vpcId: lb.vpcId,
      nodes: lb.subnetIds.map((s) => ({ subnetId: s, ip: lb.nodeIps[s] })),
      groupIds: lb.securityGroupIds,
      up: lb.state === 'active',
      stateText: `ロードバランサーの状態: ${lb.state === 'active' ? 'アクティブ' : 'プロビジョニング中'}`,
      ephemeral: EPHEMERAL.elb,
    };
  const task = (env.ecsTasks ?? []).find((x) => x.taskArn === id);
  if (task)
    return {
      id,
      kind: 'task',
      name: `タスク ${task.taskArn.split('/').pop()!.slice(0, 8)}`,
      vpcId: env.subnets.find((s) => s.subnetId === task.subnetId)?.vpcId ?? '',
      nodes: task.lastStatus === 'STOPPED' ? [] : [{ subnetId: task.subnetId, ip: task.privateIpAddress }],
      groupIds: task.securityGroupIds,
      up: task.lastStatus === 'RUNNING',
      stateText: `タスクのステータス: ${task.lastStatus}`,
      ephemeral: EPHEMERAL.linux,
    };
  const db = env.dbInstances.find((x) => x.dbInstanceIdentifier === id);
  if (db)
    return {
      id,
      kind: 'db',
      name: db.dbInstanceIdentifier,
      vpcId: env.subnets.find((s) => s.subnetId === db.subnetId)?.vpcId ?? '',
      nodes: [{ subnetId: db.subnetId, ip: db.privateIpAddress }],
      groupIds: db.vpcSecurityGroupIds,
      up: ['available', 'backing-up', 'modifying', 'renaming'].includes(db.status),
      stateText: `DB のステータス: ${DB_STATUS_JA[db.status]}`,
      ephemeral: EPHEMERAL.linux,
    };
  return null;
}

export function describeMatch(env: AwsEnv, ev: SgEvaluation): string {
  if (!ev.rule || !ev.groupId) return '';
  const g = env.securityGroups.find((x) => x.groupId === ev.groupId);
  const src = sourceOf(ev.rule);
  const srcGroup = env.securityGroups.find((x) => x.groupId === src);
  return `${ev.groupId} (${g?.groupName}) のルール ${ev.rule.securityGroupRuleId}: ${protocolLabel(ev.rule.ipProtocol)} ${portRangeLabel(ev.rule)} / ${srcGroup ? `${src} (${srcGroup.groupName})` : src}`;
}

function sgCheck(env: AwsEnv, who: string, groupIds: string[], direction: Direction, packets: Packet[], trafficText: string): Check {
  const results = packets.map((p) => evaluateSecurityGroup(env, groupIds, direction, p));
  const failed = results.findIndex((r) => !r.allowed);
  const title = `${who} のセキュリティグループ (${direction === 'ingress' ? 'インバウンドルール' : 'アウトバウンドルール'})`;
  if (failed === -1) return { label: title, ok: true, detail: `許可: ${describeMatch(env, results[0])}` };
  const peer = packets[failed];
  return {
    label: title,
    ok: false,
    detail: `${trafficText} (${direction === 'ingress' ? '送信元' : '宛先'} ${peer.peerIp}${peer.peerGroupIds.length ? ` / ${peer.peerGroupIds.join(', ')}` : ''}) に一致するルールがありません。セキュリティグループは許可ルールのみで、一致しない通信は拒否されます。`,
  };
}

/**
 * Can `from` open a connection to `to` on protocol/port? Evaluates, in order: both ends up, a route between them
 * (same VPC => local route), the source's outbound rules and the destination's inbound rules.
 * Security groups are stateful, so the response direction is not evaluated for them. Network ACLs are
 * stateless: when the two ends are in different subnets, both subnets' ACLs must allow the request AND the
 * response (to the client's ephemeral ports).
 */
export function canConnect(env: AwsEnv, fromId: string, toId: string, protocol: Packet['protocol'], port: number): Connectivity {
  const src = endpointOf(env, fromId);
  const dst = endpointOf(env, toId);
  if (!src || !dst) return { ok: false, checks: [{ label: 'リソース', ok: false, detail: `${!src ? fromId : toId} が見つかりません` }] };
  const traffic = `${protocol.toUpperCase()} ${port}`;
  const checks: Check[] = [
    { label: `${src.name} の状態`, ok: src.up, detail: src.stateText },
    { label: `${dst.name} の状態`, ok: dst.up, detail: dst.stateText },
  ];
  const sameVpc = src.vpcId === dst.vpcId && src.nodes.length > 0 && dst.nodes.length > 0;
  let routeDetail = '異なるVPC間には経路がありません (VPC Peering / Transit Gateway が必要)';
  if (sameVpc) {
    const ev = evaluateRoute(env, effectiveRouteTable(env, src.nodes[0].subnetId).routeTableId, dst.nodes[0].ip);
    routeDetail = ev ? `${dst.nodes[0].ip} → ${ev.route.destinationCidrBlock} → ${ev.target.id} (VPC内は local ルートで到達)` : '経路がありません';
  }
  checks.push({ label: 'ルートテーブル', ok: sameVpc, detail: routeDetail });
  const dstIp = dst.nodes[0]?.ip ?? '';
  checks.push(sgCheck(env, src.name, src.groupIds, 'egress', [{ protocol, port, peerIp: dstIp, peerGroupIds: dst.groupIds }], traffic));
  checks.push(sgCheck(env, dst.name, dst.groupIds, 'ingress', src.nodes.map((n) => ({ protocol, port, peerIp: n.ip, peerGroupIds: src.groupIds })), traffic));
  if (sameVpc) checks.push(...naclChecks(env, src.nodes, dst.nodes, src.ephemeral, protocol, port));
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------- network ACL (stateless, per subnet) ----------

interface Leg {
  subnetId: string;
  egress: boolean;
  ports: PortRange;
  peerIp: string;
  kind: 'リクエスト' | '戻り通信';
}

function legResult(env: AwsEnv, leg: Leg, protocol: Packet['protocol']) {
  const acl = subnetNacl(env, leg.subnetId);
  const ev = evaluateNacl(acl, leg.egress, protocol, leg.ports, leg.peerIp);
  const dir = leg.egress ? 'アウトバウンドルール' : 'インバウンドルール';
  const peer = leg.egress ? `宛先 ${leg.peerIp}` : `送信元 ${leg.peerIp}`;
  const ports = leg.kind === '戻り通信' ? `エフェメラルポート ${rangeLabel(leg.ports)}` : `ポート ${rangeLabel(leg.ports)}`;
  const text = ev.allowed
    ? `${leg.kind} (${dir}, ${peer}, ${protocol.toUpperCase()} ${ports}): ルール ${ev.decidedBy.join(', ')} で許可`
    : `${leg.kind} (${dir}, ${peer}, ${protocol.toUpperCase()} ${ports}) のうち ${ev.denied.map(rangeLabel).join(', ')} が拒否されます (評価したルール: ${ev.decidedBy.join(', ')})`;
  return { acl, ok: ev.allowed, text };
}

function naclCheck(env: AwsEnv, title: string, subnetId: string, legs: Leg[], protocol: Packet['protocol']): Check {
  const results = legs.map((l) => legResult(env, l, protocol));
  const acl = results[0]?.acl ?? subnetNacl(env, subnetId);
  const failed = results.filter((r) => !r.ok);
  const where = `${label(acl.networkAclId, acl)} (${label(subnetId, env.subnets.find((s) => s.subnetId === subnetId))})`;
  return {
    label: title,
    ok: failed.length === 0,
    detail: failed.length
      ? `${where}: ${failed.map((r) => r.text).join(' / ')}。ネットワーク ACL はステートレスなので、戻り通信にも許可ルールが必要です。`
      : `${where}: ${results.map((r) => r.text).join(' / ')}`,
  };
}

function naclChecks(env: AwsEnv, srcNodes: Endpoint['nodes'], dstNodes: Endpoint['nodes'], ephemeral: PortRange, protocol: Packet['protocol'], port: number): Check[] {
  const pairs = srcNodes.flatMap((s) => dstNodes.map((d) => ({ s, d }))).filter(({ s, d }) => s.subnetId !== d.subnetId);
  if (!pairs.length) return [{ label: 'ネットワーク ACL', ok: true, detail: '同一サブネット内の通信にはネットワーク ACL は適用されません' }];
  const out: Check[] = [];
  for (const { s, d } of pairs) {
    out.push(
      naclCheck(env, `送信元サブネットのネットワーク ACL (${label(s.subnetId, env.subnets.find((x) => x.subnetId === s.subnetId))})`, s.subnetId, [
        { subnetId: s.subnetId, egress: true, ports: [port, port], peerIp: d.ip, kind: 'リクエスト' },
        { subnetId: s.subnetId, egress: false, ports: ephemeral, peerIp: d.ip, kind: '戻り通信' },
      ], protocol),
      naclCheck(env, `送信先サブネットのネットワーク ACL (${label(d.subnetId, env.subnets.find((x) => x.subnetId === d.subnetId))})`, d.subnetId, [
        { subnetId: d.subnetId, egress: false, ports: [port, port], peerIp: s.ip, kind: 'リクエスト' },
        { subnetId: d.subnetId, egress: true, ports: ephemeral, peerIp: s.ip, kind: '戻り通信' },
      ], protocol),
    );
  }
  // one line per distinct subnet ACL check is enough to explain
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.label + c.ok) ? false : (seen.add(c.label + c.ok), true)));
}

/** Internet client -> resource. Needs a public entry point, a route back to the internet via an IGW, and inbound SG rules. */
export function canConnectFromInternet(env: AwsEnv, toId: string, protocol: Packet['protocol'], port: number, clientIp = CLIENT_IP): Connectivity {
  const dst = endpointOf(env, toId);
  if (!dst) return { ok: false, checks: [{ label: 'リソース', ok: false, detail: `${toId} が見つかりません` }] };
  const checks: Check[] = [{ label: `${dst.name} の状態`, ok: dst.up, detail: dst.stateText }];
  if (dst.kind === 'load-balancer') {
    const lb = env.loadBalancers.find((l) => l.loadBalancerArn === dst.id)!;
    checks.push({ label: 'スキーム', ok: lb.scheme === 'internet-facing', detail: lb.scheme === 'internet-facing' ? 'インターネット向け: パブリック IP を持つ' : '内部: プライベート IP のみ。インターネットからは到達できません' });
  } else if (dst.kind === 'instance') {
    const i = env.instances.find((x) => x.instanceId === dst.id)!;
    checks.push({ label: 'パブリック IPv4 アドレス', ok: !!i.publicIpAddress, detail: i.publicIpAddress ?? 'パブリック IP がありません (プライベート IP のみ)' });
  } else {
    const db = env.dbInstances.find((x) => x.dbInstanceIdentifier === dst.id)!;
    checks.push({ label: 'パブリックアクセス可能', ok: db.publiclyAccessible, detail: db.publiclyAccessible ? 'はい' : 'いいえ: VPC 外からは接続できません' });
  }
  const notPublic = dst.nodes.filter((n) => !routesToInternet(env, n.subnetId, clientIp));
  checks.push({
    label: 'ルートテーブル (インターネットゲートウェイ)',
    ok: dst.nodes.length > 0 && notPublic.length === 0,
    detail: notPublic.length
      ? `${notPublic.map((n) => label(n.subnetId, env.subnets.find((s) => s.subnetId === n.subnetId))).join(', ')} のルートテーブルにインターネットゲートウェイへのルート (0.0.0.0/0 → igw-...) がありません`
      : '0.0.0.0/0 → インターネットゲートウェイ (パブリックサブネット)',
  });
  checks.push(sgCheck(env, dst.name, dst.groupIds, 'ingress', [{ protocol, port, peerIp: clientIp, peerGroupIds: [] }], `${protocol.toUpperCase()} ${port}`));
  for (const n of dst.nodes)
    checks.push(
      naclCheck(env, `ネットワーク ACL (${label(n.subnetId, env.subnets.find((x) => x.subnetId === n.subnetId))})`, n.subnetId, [
        { subnetId: n.subnetId, egress: false, ports: [port, port], peerIp: clientIp, kind: 'リクエスト' },
        { subnetId: n.subnetId, egress: true, ports: CLIENT_EPHEMERAL, peerIp: clientIp, kind: '戻り通信' },
      ], protocol),
    );
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Instance → public AWS endpoint (S3, STS…) over the internet: running, public IP, route to the IGW,
 * outbound SG rule, and the subnet ACL for the request and the reply to the instance's ephemeral ports.
 * ponytail: NAT gateways and VPC endpoints are not modelled; private instances can't reach AWS APIs.
 */
export function canReachInternetFrom(env: AwsEnv, instanceId: string, destIp: string, port: number): Connectivity {
  const src = endpointOf(env, instanceId);
  const i = env.instances.find((x) => x.instanceId === instanceId);
  if (!src || !i) return { ok: false, checks: [{ label: 'リソース', ok: false, detail: `${instanceId} が見つかりません` }] };
  const node = src.nodes[0];
  const checks: Check[] = [
    { label: `${src.name} の状態`, ok: src.up, detail: src.stateText },
    { label: 'パブリック IPv4 アドレス', ok: !!i.publicIpAddress, detail: i.publicIpAddress ?? 'パブリック IP がありません (NAT ゲートウェイや VPC エンドポイントは未対応)' },
    { label: 'ルートテーブル (インターネットゲートウェイ)', ok: !!node && routesToInternet(env, node.subnetId, destIp), detail: node && routesToInternet(env, node.subnetId, destIp) ? '0.0.0.0/0 → インターネットゲートウェイ' : 'インターネットへのルートがありません' },
    sgCheck(env, src.name, src.groupIds, 'egress', [{ protocol: 'tcp', port, peerIp: destIp, peerGroupIds: [] }], `TCP ${port}`),
  ];
  if (node)
    checks.push(
      naclCheck(env, `ネットワーク ACL (${label(node.subnetId, env.subnets.find((x) => x.subnetId === node.subnetId))})`, node.subnetId, [
        { subnetId: node.subnetId, egress: true, ports: [port, port], peerIp: destIp, kind: 'リクエスト' },
        { subnetId: node.subnetId, egress: false, ports: src.ephemeral, peerIp: destIp, kind: '戻り通信' },
      ], 'tcp'),
    );
  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * EC2 Instance Connect (browser) opens SSH from the service's IP range of the Region
 * (ip-ranges.json, service EC2_INSTANCE_CONNECT), so the security group must allow TCP 22 from it.
 * ponytail: only the Regions the scenarios use; add others from ip-ranges.json when needed.
 */
export const EC2_INSTANCE_CONNECT_RANGES: Record<string, string> = { 'ap-northeast-1': '3.112.23.0/29', 'us-east-1': '18.206.107.24/29', 'us-west-2': '18.237.140.160/29' };

export function eicConnectivity(env: AwsEnv, instanceId: string): Connectivity {
  const cidr = EC2_INSTANCE_CONNECT_RANGES[env.region] ?? EC2_INSTANCE_CONNECT_RANGES['ap-northeast-1'];
  const [a, b, c, d] = cidr.split('/')[0].split('.').map(Number);
  return canConnectFromInternet(env, instanceId, 'tcp', 22, `${a}.${b}.${c}.${d + 1}`);
}
