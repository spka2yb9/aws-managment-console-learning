import { targetHealth } from '../sim/elb';
import { nameOf, regionOf } from '../sim/env';
import { canConnect, canConnectFromInternet } from '../sim/network';
import type { AwsEnv } from '../sim/types';
import { isPublicSubnet } from '../sim/vpc';
import type { DiagramEdge, DiagramGroup, DiagramNode, DiagramSpec } from './spec';

const INSTANCE_JA: Record<string, string> = { pending: '保留中', running: '実行中', stopping: '停止中', stopped: '停止済み', 'shutting-down': 'シャットダウン中', terminated: '終了済み' };
const DB_JA: Record<string, string> = { creating: '作成中', 'backing-up': 'バックアップ中', available: '利用可能', modifying: '変更中', stopping: '停止中', stopped: '停止済み', starting: '起動中' };

const status = (ok: boolean): DiagramEdge['status'] => (ok ? 'connected' : 'blocked');
const tag = (ok: boolean) => (ok ? 'Connected' : 'Blocked');

/**
 * Live architecture of the simulated account: Internet -> IGW -> ALB -> EC2 -> RDS inside
 * Region > VPC > Public / Private subnet groups, each edge coloured by the simulation engine's verdict.
 */
export function liveSpec(env: AwsEnv): DiagramSpec {
  const vpc = env.vpcs.find((v) => env.loadBalancers.some((l) => l.vpcId === v.vpcId)) ?? env.vpcs.find((v) => env.instances.some((i) => i.vpcId === v.vpcId && i.state !== 'terminated')) ?? env.vpcs.find((v) => !v.isDefault) ?? env.vpcs[0];
  if (!vpc) return { groups: [], nodes: [], edges: [] };
  const subnets = env.subnets.filter((s) => s.vpcId === vpc.vpcId);
  const pub = subnets.filter((s) => isPublicSubnet(env, s.subnetId));
  const priv = subnets.filter((s) => !isPublicSubnet(env, s.subnetId));
  const kindOf = (subnetId: string) => (pub.some((s) => s.subnetId === subnetId) ? 'pub' : 'priv');
  const names = (list: typeof subnets) => list.map((s) => nameOf(s) || s.subnetId).join(', ');

  const groups: DiagramGroup[] = [
    { id: 'region', label: `リージョン ${regionOf(env.region).name}`, kind: 'region' },
    { id: 'vpc', label: `VPC ${nameOf(vpc) || vpc.vpcId} (${vpc.cidrBlock})`, kind: 'vpc', parent: 'region' },
  ];
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const used = new Set<string>();
  const add = (n: DiagramNode) => {
    nodes.push(n);
    if (n.parent) used.add(n.parent);
  };

  const lbs = env.loadBalancers.filter((l) => l.vpcId === vpc.vpcId);
  const instances = env.instances.filter((i) => i.vpcId === vpc.vpcId && i.state !== 'terminated');
  const dbs = env.dbInstances.filter((d) => subnets.some((s) => s.subnetId === d.subnetId));
  const igw = env.internetGateways.find((g) => g.attachments.some((a) => a.vpcId === vpc.vpcId));

  if (lbs.length || instances.some((i) => i.publicIpAddress)) add({ id: 'internet', label: 'Internet', sublabel: 'Users', icon: 'users' });
  if (igw) add({ id: 'igw', label: nameOf(igw) || 'Internet gateway', sublabel: igw.internetGatewayId, icon: 'internetGateway', parent: 'vpc' });

  for (const lb of lbs) {
    const allPublic = lb.subnetIds.every((s) => kindOf(s) === 'pub');
    add({ id: lb.loadBalancerArn, label: lb.loadBalancerName, sublabel: `ALB · ${lb.scheme === 'internet-facing' ? 'インターネット向け' : '内部'}`, icon: 'alb', parent: allPublic ? 'pub' : 'priv' });
    for (const l of lb.listeners) {
      const inbound = canConnectFromInternet(env, lb.loadBalancerArn, 'tcp', l.port).ok;
      if (igw && lb.scheme === 'internet-facing') {
        edges.push({ id: `in-${lb.loadBalancerArn}-${l.port}`, source: 'internet', target: 'igw', label: `HTTP:${l.port}`, status: status(inbound) });
        edges.push({ id: `igw-${lb.loadBalancerArn}-${l.port}`, source: 'igw', target: lb.loadBalancerArn, status: status(inbound) });
      }
      const tg = env.targetGroups.find((t) => t.targetGroupArn === l.targetGroupArn);
      for (const t of tg?.targets ?? []) {
        const ok = targetHealth(env, tg!.targetGroupArn, t).state === 'healthy';
        edges.push({ id: `tg-${lb.loadBalancerArn}-${t.id}-${t.port}`, source: lb.loadBalancerArn, target: t.id, label: `TCP:${t.port} ${tag(ok)}`, status: status(ok) });
      }
    }
  }
  for (const i of instances) {
    add({ id: i.instanceId, label: nameOf(i) || i.instanceId, sublabel: `EC2 · ${INSTANCE_JA[i.state]}`, icon: 'ec2Instance', parent: kindOf(i.subnetId) });
    const db = dbs.find((d) => d.dbInstanceIdentifier === i.app?.dbInstanceIdentifier);
    if (db) {
      const ok = canConnect(env, i.instanceId, db.dbInstanceIdentifier, 'tcp', db.port).ok;
      edges.push({ id: `db-${i.instanceId}`, source: i.instanceId, target: db.dbInstanceIdentifier, label: `TCP:${db.port} ${tag(ok)}`, status: status(ok) });
    }
  }
  for (const d of dbs) add({ id: d.dbInstanceIdentifier, label: d.dbInstanceIdentifier, sublabel: `RDS ${d.engine === 'mysql' ? 'MySQL' : 'PostgreSQL'} · ${DB_JA[d.status] ?? d.status}`, icon: 'rdsInstance', parent: kindOf(d.subnetId) });

  if (used.has('pub')) groups.push({ id: 'pub', label: `Public subnet (${names(pub)})`, kind: 'public-subnet', parent: 'vpc' });
  if (used.has('priv')) groups.push({ id: 'priv', label: `Private subnet (${names(priv)})`, kind: 'private-subnet', parent: 'vpc' });
  // edges whose endpoints are not drawn (e.g. a target instance in another VPC) are dropped
  const ids = new Set(nodes.map((n) => n.id));
  return { groups, nodes, edges: edges.filter((e) => ids.has(e.source) && ids.has(e.target)) };
}
