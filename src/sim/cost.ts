import { MINUTE, requestsPerSecond, storedGb } from './cloudwatch';
import type { AwsEnv, Tag } from './types';
import { flowPath } from './vpc';

/**
 * Monthly cost estimate of the current configuration ("if it stays like this for a month").
 * ponytail: approximate ap-northeast-1 on-demand prices (USD); no free tier, RIs / Savings Plans or tiered pricing.
 */

const HOURS = 730;
export const PRICES = {
  ec2: { 't3.micro': 0.0136, 't3.small': 0.0272, 't3.medium': 0.0544, 'm7i.large': 0.1302, 'c7i.large': 0.1123 } as Record<string, number>,
  ebsGb: 0.096,
  rds: { 'db.t4g.micro': 0.025, 'db.t3.micro': 0.026, 'db.t3.small': 0.052, 'db.t3.medium': 0.104, 'db.m7g.large': 0.232, 'db.m7g.xlarge': 0.464, 'db.m7g.2xlarge': 0.928, 'db.r7g.large': 0.302 } as Record<string, number>,
  rdsStorageGb: 0.138,
  backupGb: 0.095,
  albHour: 0.0243,
  lcuHour: 0.008,
  natHour: 0.062,
  natGb: 0.062,
  internetOutGb: 0.114,
  /** $0.01/GB in each direction */
  crossAzGb: 0.02,
  logsIngestGb: 0.76,
  logsStoreGb: 0.033,
};
const ROOT_VOLUME_GB = 8;
/** automated backups keep about this share of the DB per retention day (incremental) */
const DAILY_CHANGE = 0.05;
const RESPONSE_KB = 3;

export type CostCategory = 'EC2' | 'RDS' | 'ELB' | 'NAT ゲートウェイ' | 'データ転送' | 'CloudWatch Logs' | 'バックアップ';
export const COST_CATEGORIES: CostCategory[] = ['EC2', 'RDS', 'ELB', 'NAT ゲートウェイ', 'データ転送', 'CloudWatch Logs', 'バックアップ'];

export interface CostLine {
  /** unique per line (Auto Scaling instances share one Name) */
  id: string;
  category: CostCategory;
  resource: string;
  environment: '本番' | '開発';
  usage: string;
  usd: number;
  /** the flow has no working path: it costs nothing because it does not work */
  broken?: boolean;
}

/** what each lever trades against (shown next to the category) */
export const TRADEOFFS: Record<CostCategory, string> = {
  EC2: '止める・小さくするほど安い。本番は可用性 (2 台以上・複数 AZ)、開発は夜間停止やサイズ縮小',
  RDS: 'マルチ AZ はスタンバイ分で約 2 倍。本番は可用性のため必須、開発はシングル AZ で十分なことが多い',
  ELB: '台数によらず時間料金 + LCU。複数 AZ にまたがる入口 = 可用性',
  'NAT ゲートウェイ': 'AZ ごとに置くと AZ 障害に強いが時間料金が増える。S3 はゲートウェイエンドポイント (無料) でコストもセキュリティも改善',
  データ転送: 'インターネットへの送信と AZ をまたぐ通信は有料。NAT を 1 つにまとめると AZ 間の転送が増える',
  'CloudWatch Logs': '取り込み量と保存期間で決まる。監査ログは長く保持 (セキュリティ)、デバッグログは短く',
  バックアップ: '保持期間が長いほど復元できる範囲 (RPO) が広いが、保存料金が増える。DB サイズまでは無料',
};

const usd = (n: number) => Math.round(n * 100) / 100;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
const nameTag = (tags: Tag[] | undefined) => tags?.find((t) => t.key === 'Name')?.value;

export function environmentOf(name: string, tags?: Tag[]): CostLine['environment'] {
  const tag = tags?.find((t) => t.key === 'Environment')?.value;
  if (tag) return /^dev/i.test(tag) ? '開発' : '本番';
  return /(^|[-/])dev([-/]|$)/.test(name) ? '開発' : '本番';
}

export function costLines(env: AwsEnv, now = Date.now()): CostLine[] {
  const lines: CostLine[] = [];
  const add = (l: Omit<CostLine, 'id'> & { id?: string }) => lines.push({ ...l, id: l.id ?? `${l.category}|${l.resource}`, usd: usd(l.usd) });

  for (const i of env.instances.filter((x) => x.state !== 'terminated')) {
    const name = nameTag(i.tags) ?? i.instanceId;
    const on = i.state === 'running' || i.state === 'pending';
    const hourly = PRICES.ec2[i.instanceType] ?? 0.1;
    add({ id: i.instanceId, category: 'EC2', resource: name, environment: environmentOf(name, i.tags), usage: on ? `${i.instanceType} ${HOURS} 時間 + EBS ${ROOT_VOLUME_GB} GB` : `停止中: EBS ${ROOT_VOLUME_GB} GB のみ`, usd: (on ? hourly * HOURS : 0) + ROOT_VOLUME_GB * PRICES.ebsGb });
  }

  for (const d of env.dbInstances) {
    const copies = d.multiAZ ? 2 : 1;
    const on = d.status !== 'stopped' && d.status !== 'stopping';
    const hourly = PRICES.rds[d.dbInstanceClass] ?? 0.2;
    add({
      category: 'RDS',
      resource: d.dbInstanceIdentifier,
      environment: environmentOf(d.dbInstanceIdentifier, d.tags),
      usage: `${on ? `${d.dbInstanceClass} ${HOURS} 時間` : '停止中'}${d.multiAZ ? ' (マルチ AZ: ×2)' : ''} + ストレージ ${d.allocatedStorage} GB${d.multiAZ ? ' ×2' : ''}`,
      usd: (on ? hourly * HOURS * copies : 0) + d.allocatedStorage * PRICES.rdsStorageGb * copies,
    });
  }

  // automated backups + manual snapshots per source DB; free up to the DB's storage size
  for (const id of [...new Set([...env.dbInstances.map((d) => d.dbInstanceIdentifier), ...env.dbSnapshots.map((s) => s.dbInstanceIdentifier)])]) {
    const db = env.dbInstances.find((d) => d.dbInstanceIdentifier === id);
    const snaps = env.dbSnapshots.filter((s) => s.dbInstanceIdentifier === id && s.status !== 'creating');
    const auto = db ? db.backupRetentionPeriod * db.allocatedStorage * DAILY_CHANGE : 0;
    const manual = snaps.reduce((n, s) => n + s.allocatedStorage, 0);
    const free = db?.allocatedStorage ?? 0;
    if (!auto && !manual) continue;
    add({ category: 'バックアップ', resource: id, environment: environmentOf(id, db?.tags), usage: `自動バックアップ ${db?.backupRetentionPeriod ?? 0} 日 (${fmt(auto)} GB) + 手動スナップショット ${snaps.length} 個 (${fmt(manual)} GB) − 無料 ${free} GB`, usd: Math.max(0, auto + manual - free) * PRICES.backupGb });
  }

  // the simulated web traffic goes to the first load balancer (the app's ALB)
  const avgRps = Array.from({ length: 24 }, (_, h) => requestsPerSecond(env, now - h * 60 * MINUTE)).reduce((a, b) => a + b, 0) / 24;
  env.loadBalancers.forEach((lb, n) => {
    const rps = n === 0 ? avgRps : 0;
    const lcu = rps / 25;
    add({ category: 'ELB', resource: lb.loadBalancerName, environment: environmentOf(lb.loadBalancerName), usage: `${HOURS} 時間 + ${fmt(lcu)} LCU (平均 ${fmt(rps)} req/s)`, usd: PRICES.albHour * HOURS + lcu * PRICES.lcuHour * HOURS });
    if (rps) {
      const gb = (rps * RESPONSE_KB * 1000 * HOURS * 3600) / 1e9;
      add({ category: 'データ転送', resource: `${lb.loadBalancerName} → インターネット`, environment: environmentOf(lb.loadBalancerName), usage: `${fmt(gb)} GB (平均 ${RESPONSE_KB} KB × ${fmt(rps)} req/s)`, usd: gb * PRICES.internetOutGb });
    }
  });

  for (const nat of env.natGateways.filter((x) => x.state !== 'deleted')) {
    const name = nameTag(nat.tags) ?? nat.natGatewayId;
    add({ category: 'NAT ゲートウェイ', resource: name, environment: environmentOf(name, nat.tags), usage: `${HOURS} 時間`, usd: PRICES.natHour * HOURS });
  }

  for (const f of env.dataFlows) {
    const subnet = env.subnets.find((s) => s.subnetId === f.subnetId);
    const environment = environmentOf(f.name, subnet?.tags);
    const sender = f.source ? env.instances.find((i) => nameTag(i.tags) === f.source && i.state !== 'terminated') : undefined;
    if (f.source && !(sender && (sender.state === 'running' || sender.state === 'pending'))) {
      add({ category: 'データ転送', resource: f.name, environment, usage: `送信元 ${f.source} が停止中のため転送なし`, usd: 0 });
      continue;
    }
    const p = flowPath(env, f.subnetId, f.destination);
    if (p.via === 'none') {
      add({ category: 'データ転送', resource: f.name, environment, usage: `通信できません: ${p.detail}`, usd: 0, broken: true });
      continue;
    }
    if (p.via === 'endpoint') {
      add({ category: 'データ転送', resource: f.name, environment, usage: `${fmt(f.gbPerMonth)} GB: ゲートウェイエンドポイント経由 (無料)`, usd: 0 });
      continue;
    }
    if (p.via === 'nat') {
      add({ category: 'NAT ゲートウェイ', resource: `データ処理: ${f.name}`, environment, usage: `${fmt(f.gbPerMonth)} GB (${nameTag(p.nat!.tags) ?? p.nat!.natGatewayId})`, usd: f.gbPerMonth * PRICES.natGb });
      const natAz = env.subnets.find((s) => s.subnetId === p.nat!.subnetId)?.availabilityZone;
      if (natAz && natAz !== subnet?.availabilityZone) add({ category: 'データ転送', resource: `AZ 間: ${f.name}`, environment, usage: `${fmt(f.gbPerMonth)} GB (${subnet?.availabilityZone} → ${natAz} の NAT ゲートウェイ)`, usd: f.gbPerMonth * PRICES.crossAzGb });
    }
    if (f.destination === 'internet') add({ category: 'データ転送', resource: `${f.name}`, environment, usage: `${fmt(f.gbPerMonth)} GB インターネットへ送信`, usd: f.gbPerMonth * PRICES.internetOutGb });
  }

  for (const g of env.logGroups.filter((x) => x.ingestionGbPerMonth)) {
    const stored = storedGb(g, now);
    add({ category: 'CloudWatch Logs', resource: g.logGroupName, environment: environmentOf(g.logGroupName), usage: `取り込み ${fmt(g.ingestionGbPerMonth!)} GB/月 + 保存 ${fmt(stored)} GB (保持: ${g.retentionInDays ? `${g.retentionInDays} 日` : '失効しない'})`, usd: g.ingestionGbPerMonth! * PRICES.logsIngestGb + stored * PRICES.logsStoreGb });
  }
  return lines;
}

export const totalOf = (lines: CostLine[]) => usd(lines.reduce((n, l) => n + l.usd, 0));
export const formatUsd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
