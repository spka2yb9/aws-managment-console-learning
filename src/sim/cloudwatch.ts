import { isTargetHealthy } from './elb';
import { trail } from './cloudtrail';
import { nameOf } from './env';
import { hash } from './ids';
import { DB_INSTANCE_CLASSES } from './rds';
import { AwsError, type AwsEnv, type ComparisonOperator, type DbInstance, type Dimension, type Instance, type LoadBalancer, type LogGroup, type MetricAlarm, type Statistic } from './types';

/**
 * CloudWatch simulation. Nothing is recorded: every datapoint and log line is a pure function of
 * (env, time), so charts, alarms and logs always agree and a reload shows the same history.
 *   traffic (daily wave) -> ALB -> healthy targets (EC2 CPU) -> the app's DB (RDS CPU / connections)
 *   RDS CPU > 70% makes every request wait -> ALB TargetResponseTime, slow/500 lines in the app log
 * ponytail: metrics use the current topology for the whole history (no topology timeline); add one if a lesson changes targets and looks back.
 */

export const MINUTE = 60_000;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export type MetricUnit = 'Percent' | 'Seconds' | 'Count' | 'Bytes';
export type DimensionName = 'InstanceId' | 'LoadBalancer' | 'DBInstanceIdentifier' | 'AutoScalingGroupName';

/** 18500000000 -> "18.5G", 0.0425 -> "0.0425": CloudWatch-style compact numbers */
export function formatValue(v: number, unit?: MetricUnit): string {
  const abs = Math.abs(v);
  if (unit === 'Percent') return `${Number(v.toFixed(abs < 10 ? 2 : 1))}`;
  for (const [n, s] of [[1e9, 'G'], [1e6, 'M'], [1e3, 'k']] as const) if (abs >= n) return `${Number((v / n).toFixed(2))}${s}`;
  return `${Number(v.toPrecision(3))}`;
}

export interface MetricInfo {
  namespace: string;
  metricName: string;
  unit: MetricUnit;
  dimension: DimensionName;
  /** statistic the console picks by default */
  stat: Statistic;
  /** title of the chart on the resource's モニタリング tab */
  title: string;
}

export const METRICS: MetricInfo[] = [
  { namespace: 'AWS/EC2', metricName: 'CPUUtilization', unit: 'Percent', dimension: 'InstanceId', stat: 'Average', title: 'CPU 使用率 (%)' },
  { namespace: 'AWS/EC2', metricName: 'NetworkIn', unit: 'Bytes', dimension: 'InstanceId', stat: 'Sum', title: 'ネットワーク入力 (バイト)' },
  { namespace: 'AWS/ApplicationELB', metricName: 'TargetResponseTime', unit: 'Seconds', dimension: 'LoadBalancer', stat: 'Average', title: 'ターゲットの応答時間 (秒)' },
  { namespace: 'AWS/ApplicationELB', metricName: 'RequestCount', unit: 'Count', dimension: 'LoadBalancer', stat: 'Sum', title: 'リクエスト (件数)' },
  { namespace: 'AWS/ApplicationELB', metricName: 'HTTPCode_Target_5XX_Count', unit: 'Count', dimension: 'LoadBalancer', stat: 'Sum', title: 'ターゲットの HTTP 5XX (件数)' },
  { namespace: 'AWS/RDS', metricName: 'CPUUtilization', unit: 'Percent', dimension: 'DBInstanceIdentifier', stat: 'Average', title: 'CPUUtilization (Percent)' },
  { namespace: 'AWS/RDS', metricName: 'DatabaseConnections', unit: 'Count', dimension: 'DBInstanceIdentifier', stat: 'Average', title: 'DatabaseConnections (Count)' },
  { namespace: 'AWS/RDS', metricName: 'FreeStorageSpace', unit: 'Bytes', dimension: 'DBInstanceIdentifier', stat: 'Average', title: 'FreeStorageSpace (Bytes)' },
  { namespace: 'AWS/AutoScaling', metricName: 'GroupInServiceInstances', unit: 'Count', dimension: 'AutoScalingGroupName', stat: 'Average', title: 'InService のインスタンス (件数)' },
  { namespace: 'AWS/AutoScaling', metricName: 'GroupDesiredCapacity', unit: 'Count', dimension: 'AutoScalingGroupName', stat: 'Average', title: '希望するキャパシティ (件数)' },
];

/** EC2 CPUUtilization aggregated over an Auto Scaling group (what target tracking watches) */
export const asgCpuMetric = (name: string): MetricRef => ({ namespace: 'AWS/EC2', metricName: 'CPUUtilization', dimensions: [{ name: 'AutoScalingGroupName', value: name }] });

export interface MetricRef {
  namespace: string;
  metricName: string;
  dimensions: Dimension[];
}

export const metricInfo = (r: Pick<MetricRef, 'namespace' | 'metricName'>) => METRICS.find((m) => m.namespace === r.namespace && m.metricName === r.metricName);
export const sameMetric = (a: MetricRef, b: MetricRef) => a.namespace === b.namespace && a.metricName === b.metricName && JSON.stringify(a.dimensions) === JSON.stringify(b.dimensions);

/** graph URLs of the metrics page: ns~metric~dim~value,... */
export const encodeGraph = (refs: MetricRef[]) => refs.map((r) => [r.namespace, r.metricName, r.dimensions[0].name, r.dimensions[0].value].join('~')).join(',');
export const decodeGraph = (s?: string): MetricRef[] =>
  (s ?? '')
    .split(',')
    .filter(Boolean)
    .map((x) => {
      const [namespace, metricName, name, value] = x.split('~');
      return { namespace, metricName, dimensions: [{ name, value }] };
    });

/** The ALB's LoadBalancer dimension: the part of the ARN after "loadbalancer/" (app/name/id). */
export const lbDimension = (lb: LoadBalancer) => lb.loadBalancerArn.split(':loadbalancer/')[1];

export function metricFor(namespace: string, metricName: string, value: string): MetricRef {
  return { namespace, metricName, dimensions: [{ name: metricInfo({ namespace, metricName })!.dimension, value }] };
}

/** Every metric the account publishes (what "すべてのメトリクス" can browse), with the resource's display name. */
export function listMetrics(env: AwsEnv): (MetricRef & { resourceName: string })[] {
  const out: (MetricRef & { resourceName: string })[] = [];
  const add = (ns: string, value: string, resourceName: string) => METRICS.filter((m) => m.namespace === ns).forEach((m) => out.push({ ...metricFor(ns, m.metricName, value), resourceName }));
  env.instances.filter((i) => i.state !== 'terminated').forEach((i) => add('AWS/EC2', i.instanceId, nameOf(i)));
  env.loadBalancers.forEach((lb) => add('AWS/ApplicationELB', lbDimension(lb), lb.loadBalancerName));
  env.dbInstances.forEach((db) => add('AWS/RDS', db.dbInstanceIdentifier, db.dbInstanceIdentifier));
  env.autoScalingGroups.forEach((g) => {
    add('AWS/AutoScaling', g.autoScalingGroupName, g.autoScalingGroupName);
    out.push({ ...asgCpuMetric(g.autoScalingGroupName), resourceName: g.autoScalingGroupName });
  });
  return out;
}

// ---------------- the load model ----------------

/** deterministic noise in [0, 1) */
const rnd = (key: string, m: number) => (hash(`${key}#${m}`) % 100_000) / 100_000;

/** Requests per second reaching the web tier: the simulator's load test setting, else a daily wave (peak 15:00 JST, low 03:00 JST). */
export function requestsPerSecond(env: AwsEnv, t: number): number {
  const set = [...(env.traffic ?? [])].reverse().find((x) => x.at <= t);
  if (set?.rps !== undefined) return set.rps * (0.97 + 0.06 * rnd('load', Math.floor(t / 5000)));
  const m = Math.floor(t / MINUTE);
  const hourJst = (m / 60 + 9) % 24;
  return 100 * (0.7 + 0.3 * Math.sin(((hourJst - 9) / 24) * 2 * Math.PI)) * (0.94 + 0.12 * rnd('rpm', m));
}

/** CPU % one request per second costs on the web tier (t3.micro); 250 req/s per instance ≈ 42 % */
export const CPU_PER_RPS = 0.16;

/** Targets that get traffic: healthy ones, or every registered running one when none is healthy (fail-open). */
function servingTargets(env: AwsEnv, lb: LoadBalancer): Instance[] {
  if (lb.state !== 'active') return [];
  const tgs = env.targetGroups.filter((tg) => lb.listeners.some((l) => l.targetGroupArn === tg.targetGroupArn));
  const registered = tgs.flatMap((tg) => tg.targets.map((t) => ({ tg, t, i: env.instances.find((x) => x.instanceId === t.id) }))).filter((x) => x.i?.state === 'running');
  const healthy = registered.filter((x) => isTargetHealthy(env, x.tg.targetGroupArn, x.t));
  return [...new Set((healthy.length ? healthy : registered).map((x) => x.i!))];
}

const vcpuOf = (cls: string) => DB_INSTANCE_CLASSES.find((c) => c.cls === cls)?.vcpu ?? 2;
const classAt = (db: DbInstance, t: number) => (db.previousInstanceClass && db.instanceClassChangedAt && t < db.instanceClassChangedAt ? db.previousInstanceClass : db.dbInstanceClass);
const dbUp = (db: DbInstance) => ['available', 'backing-up', 'modifying', 'renaming'].includes(db.status);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Auto Scaling instances serve during their in-service window, so the metric history follows scale-out / scale-in. */
const inService = (r: { inServiceAt?: number; outOfServiceAt?: number }, t: number) => r.inServiceAt !== undefined && r.inServiceAt <= t && t < (r.outOfServiceAt ?? Infinity);

/** The load model over one env. Topology (health checks are network evaluations) is computed once per query. */
function model(env: AwsEnv) {
  const asg = (env.autoScalingGroups ?? []).flatMap((g) => g.instances.map((r) => ({ g, r, i: env.instances.find((x) => x.instanceId === r.instanceId) }))).filter((x) => x.i);
  const managed = new Set(asg.map((x) => x.r.instanceId));
  const serving = env.loadBalancers.map((lb) => {
    const tgArns = lb.listeners.map((l) => l.targetGroupArn);
    return { lb, fixed: servingTargets(env, lb).filter((i) => !managed.has(i.instanceId)), scaled: lb.state === 'active' ? asg.filter((x) => x.g.targetGroupArns.some((a) => tgArns.includes(a))) : [] };
  });
  const targetsAt = (s: (typeof serving)[number], t: number) => [...s.fixed, ...s.scaled.filter((x) => inService(x.r, t)).map((x) => x.i!)];
  const web = [...new Set(serving.flatMap((s) => [...s.fixed, ...s.scaled.map((x) => x.i!)]))];
  /** web instances whose app queries this DB */
  const clients = (db: DbInstance) => web.filter((i) => i.app?.dbInstanceIdentifier === db.dbInstanceIdentifier);
  const slowQuery = (db: DbInstance, t: number) => env.incidents.some((x) => x.kind === 'db-slow-query' && x.target === db.dbInstanceIdentifier && t >= x.startedAt);
  const cpu = new Map<string, number>();
  /** t: the moment the minute's sample stands for (its end, or "now" for the running minute) */
  const dbCpu = (db: DbInstance, m: number, t = (m + 1) * MINUTE - 1): number => {
    const key = `${db.dbInstanceIdentifier}:${m}:${t}`;
    if (!cpu.has(key)) {
      const load = clients(db).length ? requestsPerSecond(env, t) / 100 : 0;
      // vCPUs of work: normal queries grow with traffic; the full table scan costs 1.6 vCPU all the time
      const demand = 0.1 + 0.3 * load + (slowQuery(db, t) ? 1.6 : 0);
      cpu.set(key, clamp((demand / vcpuOf(classAt(db, t))) * 100 + 3 * (rnd(`${db.dbiResourceId}cpu`, m) - 0.5), 0.5, 99.6));
    }
    return cpu.get(key)!;
  };
  const appDb = (i: Instance) => env.dbInstances.find((d) => d.dbInstanceIdentifier === i.app?.dbInstanceIdentifier && dbUp(d));
  /** requests per minute an instance serves at t (0 when it is behind no ALB) */
  const share = (i: Instance, t: number) =>
    serving.reduce((sum, s) => {
      const now = targetsAt(s, t);
      return sum + (now.includes(i) ? (requestsPerSecond(env, t) * 60) / now.length : 0);
    }, 0);
  const instanceCpu = (i: Instance, m: number, t: number) => clamp(2 + (share(i, t) / 60) * CPU_PER_RPS + 2 * rnd(`${i.instanceId}cpu`, m), 0.1, 100);
  return {
    env,
    serving: (lb: LoadBalancer, t: number) => {
      const s = serving.find((x) => x.lb === lb);
      return s ? targetsAt(s, t) : [];
    },
    clients,
    slowQuery,
    dbCpu,
    appDb,
    share,
    instanceCpu,
    /** extra seconds every DB-backed request waits while the DB is saturated */
    dbWait: (db: DbInstance | undefined, m: number, t?: number) => {
      const c = db ? dbCpu(db, m, t) : 0;
      return c > 70 ? ((c - 70) / 30) ** 2 * 3 : 0;
    },
  };
}
type Model = ReturnType<typeof model>;

/** CPU of one instance at t (what target tracking reacts to) */
export function instanceCpuAt(env: AwsEnv, instanceId: string, t: number): number {
  return instanceCpuSampler(env)(instanceId, t);
}

/** the same, for many points: the model (topology) is built once */
export function instanceCpuSampler(env: AwsEnv): (instanceId: string, t: number) => number {
  const md = model(env);
  return (instanceId, t) => {
    const i = env.instances.find((x) => x.instanceId === instanceId);
    return i ? md.instanceCpu(i, Math.floor(t / MINUTE), t) : 0;
  };
}

interface Source {
  /** did the resource publish at time t */
  alive(t: number): boolean;
  /** minutes between datapoints (EC2 basic monitoring: 5) */
  resolution: number;
  /** m: minute index; t: the moment it stands for */
  sample(m: number, t: number): number;
}

function source(md: Model, ref: MetricRef): Source | undefined {
  const env = md.env;
  const value = ref.dimensions[0]?.value;
  if (ref.namespace === 'AWS/EC2' && ref.dimensions[0]?.name === 'AutoScalingGroupName') {
    const g = env.autoScalingGroups.find((x) => x.autoScalingGroupName === value);
    if (!g || ref.metricName !== 'CPUUtilization') return;
    const members = (t: number) => g.instances.filter((r) => inService(r, t)).map((r) => env.instances.find((i) => i.instanceId === r.instanceId)).filter((i): i is Instance => !!i);
    return { alive: (t) => members(t).length > 0, resolution: 1, sample: (m, t) => members(t).reduce((a, i) => a + md.instanceCpu(i, m, t), 0) / members(t).length };
  }
  if (ref.namespace === 'AWS/EC2') {
    const i = env.instances.find((x) => x.instanceId === value);
    if (!i) return;
    const launched = Date.parse(i.launchTime);
    const alive = (t: number) => t >= launched && (i.state === 'running' || t < i.stateChangedAt);
    const resolution = i.detailedMonitoring ? 1 : 5;
    if (ref.metricName === 'CPUUtilization') return { alive, resolution, sample: (m, t) => md.instanceCpu(i, m, t) };
    if (ref.metricName === 'NetworkIn') return { alive, resolution, sample: (m, t) => Math.round((md.share(i, t) * 1800 + 4000 * rnd(`${i.instanceId}net`, m)) * resolution) };
  }
  if (ref.namespace === 'AWS/AutoScaling') {
    const g = env.autoScalingGroups.find((x) => x.autoScalingGroupName === value);
    if (!g) return;
    const created = Date.parse(g.createdTime);
    if (ref.metricName === 'GroupInServiceInstances') return { alive: (t) => t >= created, resolution: 1, sample: (_, t) => g.instances.filter((r) => inService(r, t)).length };
    if (ref.metricName === 'GroupDesiredCapacity') return { alive: (t) => t >= created, resolution: 1, sample: (_, t) => [...g.desiredHistory].reverse().find((d) => d.at <= t)?.value ?? g.desiredCapacity };
  }
  if (ref.namespace === 'AWS/ApplicationELB') {
    const lb = env.loadBalancers.find((x) => lbDimension(x) === value);
    if (!lb) return;
    const created = Date.parse(lb.createdTime);
    const alive = (t: number) => t >= created && lb.state === 'active' && md.serving(lb, t).length > 0;
    const rt = (m: number, t: number) => 0.035 + 0.02 * rnd(`${lb.loadBalancerName}rt`, m) + Math.max(0, ...md.serving(lb, t).map((i) => md.dbWait(md.appDb(i), m, t)));
    if (ref.metricName === 'TargetResponseTime') return { alive, resolution: 1, sample: rt };
    if (ref.metricName === 'RequestCount') return { alive, resolution: 1, sample: (_, t) => Math.round(requestsPerSecond(env, t) * 60) };
    if (ref.metricName === 'HTTPCode_Target_5XX_Count') return { alive, resolution: 1, sample: (m, t) => (rt(m, t) > 1.5 ? Math.round(requestsPerSecond(env, t) * 60 * 0.03 * rnd(`${lb.loadBalancerName}5xx`, m)) : 0) };
  }
  if (ref.namespace === 'AWS/RDS') {
    const db = env.dbInstances.find((x) => x.dbInstanceIdentifier === value);
    if (!db) return;
    const created = Date.parse(db.instanceCreateTime);
    const alive = (t: number) => t >= created && (dbUp(db) || t < db.statusChangedAt);
    if (ref.metricName === 'CPUUtilization') return { alive, resolution: 1, sample: (m, t) => md.dbCpu(db, m, t) };
    if (ref.metricName === 'DatabaseConnections')
      return { alive, resolution: 1, sample: (m, t) => 5 * md.clients(db).length + Math.round(2 * rnd(`${db.dbiResourceId}conn`, m)) + (md.dbCpu(db, m, t) > 85 ? 30 + Math.round(6 * rnd(`${db.dbiResourceId}pile`, m)) : 0) };
    if (ref.metricName === 'FreeStorageSpace') return { alive, resolution: 1, sample: (m) => Math.max(0, db.allocatedStorage * GiB - 1.1 * GiB - ((m * MINUTE - created) / MINUTE) * 0.25 * MiB - 50 * MiB * rnd(`${db.dbiResourceId}disk`, m)) };
  }
}

export interface Datapoint {
  /** start of the period (epoch ms) */
  t: number;
  v: number;
}

function aggregate(values: number[], stat: Statistic): number {
  switch (stat) {
    case 'Sum':
      return values.reduce((a, b) => a + b, 0);
    case 'Maximum':
      return Math.max(...values);
    case 'Minimum':
      return Math.min(...values);
    case 'SampleCount':
      return values.length;
    default:
      return values.reduce((a, b) => a + b, 0) / values.length;
  }
}

/** GetMetricData: one datapoint per clock-aligned period that has samples, up to `end` (the current period included). */
export function getMetricData(env: AwsEnv, ref: MetricRef, o: { start: number; end: number; period: number; stat: Statistic }): Datapoint[] {
  return metricData(model(env), ref, o);
}

function metricData(md: Model, ref: MetricRef, o: { start: number; end: number; period: number; stat: Statistic }): Datapoint[] {
  const src = source(md, ref);
  if (!src) return [];
  const periodMs = o.period * 1000;
  const out: Datapoint[] = [];
  for (let b = Math.floor(o.start / periodMs) * periodMs; b <= o.end; b += periodMs) {
    const values: number[] = [];
    for (let m = Math.ceil(b / MINUTE); m * MINUTE < b + periodMs && m * MINUTE <= o.end; m++) {
      // a sample stands for the end of its minute (or now): alive is judged at that moment too
      const t = Math.min(o.end, (m + 1) * MINUTE - 1);
      if (m % src.resolution === 0 && src.alive(t)) values.push(src.sample(m, t));
    }
    if (values.length) out.push({ t: b, v: aggregate(values, o.stat) });
  }
  return out;
}

// ---------------- alarms ----------------

export type AlarmState = 'OK' | 'ALARM' | 'INSUFFICIENT_DATA';

export const OPERATORS: Record<ComparisonOperator, { symbol: string; words: string; test: (v: number, t: number) => boolean }> = {
  GreaterThanThreshold: { symbol: '>', words: 'greater than', test: (v, t) => v > t },
  GreaterThanOrEqualToThreshold: { symbol: '>=', words: 'greater than or equal to', test: (v, t) => v >= t },
  LessThanThreshold: { symbol: '<', words: 'less than', test: (v, t) => v < t },
  LessThanOrEqualToThreshold: { symbol: '<=', words: 'less than or equal to', test: (v, t) => v <= t },
};

export const alarmArn = (env: AwsEnv, name: string) => `arn:aws:cloudwatch:${env.region}:${env.accountId}:alarm:${name}`;
export const alarmMetric = (a: MetricAlarm): MetricRef => ({ namespace: a.namespace, metricName: a.metricName, dimensions: a.dimensions });

export type PutMetricAlarmInput = Omit<MetricAlarm, 'alarmArn' | 'createdAt' | 'treatMissingData'>;

/** PutMetricAlarm: creates the alarm, or replaces the one with the same name (like the API). */
export function putMetricAlarm(env: AwsEnv, input: PutMetricAlarmInput, now = Date.now()) {
  const name = input.alarmName.trim();
  if (!name) throw new AwsError('ValidationError', '1 validation error detected: Value at \'alarmName\' failed to satisfy constraint: Member must have length greater than or equal to 1');
  if (name.length > 255) throw new AwsError('ValidationError', "1 validation error detected: Value at 'alarmName' failed to satisfy constraint: Member must have length less than or equal to 255");
  if (!Number.isFinite(input.threshold)) throw new AwsError('ValidationError', 'The parameter Threshold must be a number.');
  if (input.period < 60 || input.period % 60) throw new AwsError('ValidationError', 'The parameter Period must be a multiple of 60.');
  if (!Number.isInteger(input.evaluationPeriods) || input.evaluationPeriods < 1) throw new AwsError('ValidationError', 'The parameter EvaluationPeriods must be greater than or equal to 1.');
  if (!Number.isInteger(input.datapointsToAlarm) || input.datapointsToAlarm < 1 || input.datapointsToAlarm > input.evaluationPeriods)
    throw new AwsError('ValidationError', 'DatapointsToAlarm must be greater than 0 and less than or equal to EvaluationPeriods.');
  const alarm: MetricAlarm = { ...input, alarmName: name, alarmArn: alarmArn(env, name), treatMissingData: 'missing', createdAt: now };
  env.alarms = [...env.alarms.filter((a) => a.alarmName !== name), alarm];
  trail(env, { source: 'monitoring', name: 'PutMetricAlarm', resources: [['AWS::CloudWatch::Alarm', alarm.alarmArn]], request: { alarmName: name, namespace: input.namespace, metricName: input.metricName, dimensions: input.dimensions, statistic: input.statistic, period: input.period, evaluationPeriods: input.evaluationPeriods, datapointsToAlarm: input.datapointsToAlarm, threshold: input.threshold, comparisonOperator: input.comparisonOperator, treatMissingData: 'missing', actionsEnabled: true }, response: null });
}

export function deleteAlarms(env: AwsEnv, names: string[]) {
  env.alarms = env.alarms.filter((a) => !names.includes(a.alarmName));
  trail(env, { source: 'monitoring', name: 'DeleteAlarms', resources: names.map((n): [string, string] => ['AWS::CloudWatch::Alarm', alarmArn(env, n)]), request: { alarmNames: names }, response: null });
}

export interface AlarmEvaluation {
  state: AlarmState;
  reason: string;
  stateUpdatedAt: number;
  /** transitions, newest first */
  history: { at: number; from: AlarmState; to: AlarmState; reason: string }[];
}

/** "29/09/26 05:31:00", the timestamp format of alarm state reasons (UTC) */
const reasonTime = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCFullYear() % 100)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const num = (v: number) => String(Number(v.toFixed(3)));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Evaluates the alarm from its creation to `now`, like CloudWatch does, and returns the current state
 * with an AWS-format reason and the state history. ponytail: the still-open period counts as a datapoint, so
 * lessons react at once (real CloudWatch waits for the period to close).
 */
export function evaluateAlarm(env: AwsEnv, a: MetricAlarm, now = Date.now()): AlarmEvaluation {
  const md = model(env);
  const periodMs = a.period * 1000;
  const op = OPERATORS[a.comparisonOperator];
  const bucketOf = (t: number) => Math.floor(t / periodMs) * periodMs;
  const query = (start: number, end: number) => new Map(metricData(md, alarmMetric(a), { start, end, period: a.period, stat: a.statistic }).map((d) => [d.t, d.v] as const));
  const created = bucketOf(a.createdAt);
  const data = query(created - a.evaluationPeriods * periodMs, now);
  // what the still-open period looked like at creation (it may have changed since)
  const atCreation = new Map([...data].filter(([t]) => t < created));
  query(created, a.createdAt).forEach((v, t) => atCreation.set(t, v));
  const judge = (bucket: number, values: Map<number, number>) => {
    const window = Array.from({ length: a.evaluationPeriods }, (_, n) => bucket - n * periodMs).map((t) => ({ t, v: values.get(t) }));
    const known = window.filter((w) => w.v !== undefined) as { t: number; v: number }[];
    const breaching = known.filter((w) => op.test(w.v, a.threshold));
    const shown = (list: { t: number; v: number }[]) => list.map((w) => `${num(w.v)} (${reasonTime(w.t)})`).join(', ');
    if (breaching.length >= a.datapointsToAlarm)
      return { state: 'ALARM' as const, reason: `Threshold Crossed: ${breaching.length} out of the last ${a.evaluationPeriods} datapoints [${shown(breaching)}] was ${op.words} the threshold (${a.threshold.toFixed(1)}) (minimum ${plural(a.datapointsToAlarm, 'datapoint')} for OK -> ALARM transition).` };
    if (!known.length) return { state: 'INSUFFICIENT_DATA' as const, reason: `Insufficient Data: ${plural(a.evaluationPeriods, 'datapoint')} ${a.evaluationPeriods === 1 ? 'was' : 'were'} unknown.` };
    return { state: 'OK' as const, reason: `Threshold Crossed: ${plural(known.length, 'datapoint')} [${shown(known)}] was not ${op.words} the threshold (${a.threshold.toFixed(1)}).` };
  };
  // evaluated at creation, at every period boundary since, and now
  const instants: { at: number; bucket: number; values: Map<number, number> }[] = [{ at: a.createdAt, bucket: created, values: atCreation }];
  for (let b = created + periodMs; b <= now; b += periodMs) instants.push({ at: b, bucket: b, values: data });
  instants.push({ at: now, bucket: bucketOf(now), values: data });
  let state: AlarmState = 'INSUFFICIENT_DATA';
  let reason = 'Unchecked: Initial alarm creation';
  let stateUpdatedAt = a.createdAt;
  const history: AlarmEvaluation['history'] = [];
  for (const i of instants) {
    const r = judge(i.bucket, i.values);
    reason = r.reason;
    if (r.state === state) continue;
    history.unshift({ at: i.at, from: state, to: r.state, reason: r.reason });
    state = r.state;
    stateUpdatedAt = i.at;
  }
  return { state, reason, stateUpdatedAt, history };
}

// ---------------- logs ----------------

export interface LogEvent {
  timestamp: number;
  message: string;
  logStreamName: string;
}

export const logGroupArn = (env: AwsEnv, name: string) => `arn:aws:logs:${env.region}:${env.accountId}:log-group:${name}:*`;

export function createLogGroup(env: AwsEnv, name: string, source: LogGroup['source'], now = Date.now()) {
  if (env.logGroups.some((g) => g.logGroupName === name)) throw new AwsError('ResourceAlreadyExistsException', 'The specified log group already exists');
  env.logGroups.push({ logGroupName: name, arn: logGroupArn(env, name), creationTime: now, source });
}

/** writers of the group, one log stream each */
function writers(env: AwsEnv, g: LogGroup): { stream: string; alive: (t: number) => boolean; minute: (m: number) => LogEvent[] }[] {
  if (g.source.kind === 'stored') {
    const byMinute = new Map<string, LogEvent[]>();
    for (const e of g.events ?? []) {
      const k = `${e.logStreamName}|${Math.floor(e.timestamp / MINUTE)}`;
      byMinute.set(k, [...(byMinute.get(k) ?? []), e]);
    }
    return [...new Set((g.events ?? []).map((e) => e.logStreamName))].map((stream) => ({ stream, alive: () => true, minute: (m: number) => byMinute.get(`${stream}|${m}`) ?? [] }));
  }
  const md = model(env);
  if (g.source.kind === 'app')
    return env.instances
      .filter((i) => i.app)
      .map((i) => {
        const launched = Date.parse(i.launchTime);
        return { stream: i.instanceId, alive: (t: number) => t >= Math.max(launched, g.creationTime) && (i.state === 'running' || t < i.stateChangedAt), minute: (m: number) => appLines(md, i, m) };
      });
  const src = g.source as { kind: 'rds-slowquery'; dbInstanceIdentifier: string };
  const db = env.dbInstances.find((d) => d.dbInstanceIdentifier === src.dbInstanceIdentifier);
  if (!db) return [];
  return [{ stream: db.dbInstanceIdentifier, alive: (t: number) => t >= g.creationTime && dbUp(db), minute: (m: number) => slowQueryLines(md, db, m) }];
}

const iso = (t: number) => new Date(t).toISOString();
const PATHS = ['/', '/api/orders', '/api/orders', '/api/products', '/api/cart'];

function appLines(md: Model, i: Instance, m: number): LogEvent[] {
  const key = i.instanceId;
  const out: LogEvent[] = [];
  const line = (offset: number, message: string) => out.push({ timestamp: m * MINUTE + offset, message: `${iso(m * MINUTE + offset)} ${message}`, logStreamName: key });
  line(7_000, 'INFO  GET /health 200 1ms - ELB-HealthChecker/2.0');
  line(37_000, 'INFO  GET /health 200 1ms - ELB-HealthChecker/2.0');
  // one line per ~1000 requests keeps the log readable
  const n = Math.round(md.share(i, (m + 1) * MINUTE - 1) / 1000);
  const wait = md.dbWait(md.appDb(i), m);
  for (let j = 0; j < n; j++) {
    const path = PATHS[Math.floor(rnd(`${key}p${j}`, m) * PATHS.length)];
    const ms = Math.round(12 + 40 * rnd(`${key}d${j}`, m) + (path === '/' ? 0 : wait * 1000 * (0.6 + 0.8 * rnd(`${key}w${j}`, m))));
    const at = Math.floor(rnd(`${key}t${j}`, m) * 60_000);
    if (ms > 5000) line(at, `ERROR GET ${path} 500 5003ms - SequelizeConnectionAcquireTimeoutError: Operation timeout`);
    else line(at, `${ms > 1000 ? 'WARN ' : 'INFO '} GET ${path} 200 ${ms}ms`);
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

function slowQueryLines(md: Model, db: DbInstance, m: number): LogEvent[] {
  if (!md.slowQuery(db, m * MINUTE)) return [];
  const clients = md.clients(db);
  return [0, 1, 2, 3].map((j) => {
    const t = m * MINUTE + Math.floor(rnd(`${db.dbiResourceId}sq${j}`, m) * 60_000);
    const q = (6 + 5 * rnd(`${db.dbiResourceId}qt${j}`, m)).toFixed(6);
    const rows = 2_400_000 + Math.floor(rnd(`${db.dbiResourceId}rows${j}`, m) * 90_000);
    const from = clients[j % Math.max(1, clients.length)]?.privateIpAddress ?? '10.0.11.10';
    const customer = 1000 + Math.floor(rnd(`${db.dbiResourceId}c${j}`, m) * 9000);
    return {
      timestamp: t,
      logStreamName: db.dbInstanceIdentifier,
      message: [
        `# Time: ${iso(t).replace('Z', '000Z')}`,
        `# User@Host: ${db.masterUsername}[${db.masterUsername}] @  [${from}]  Id: ${100 + j}`,
        `# Query_time: ${q}  Lock_time: 0.000011 Rows_sent: 20  Rows_examined: ${rows}`,
        `SET timestamp=${Math.floor(t / 1000)};`,
        `SELECT * FROM orders WHERE customer_id = ${customer} ORDER BY created_at DESC LIMIT 20;`,
      ].join('\n'),
    };
  });
}

/** Log streams of a group, most recent event first (DescribeLogStreams orderBy LastEventTime, like the console). */
export function logStreams(env: AwsEnv, g: LogGroup, now = Date.now()): { logStreamName: string; lastEventTime?: number }[] {
  if (g.source.kind === 'stored') {
    const last = new Map<string, number>();
    for (const e of g.events ?? []) if (e.timestamp <= now) last.set(e.logStreamName, Math.max(last.get(e.logStreamName) ?? 0, e.timestamp));
    return [...last].map(([logStreamName, lastEventTime]) => ({ logStreamName, lastEventTime })).sort((a, b) => b.lastEventTime - a.lastEventTime);
  }
  return writers(env, g).map((w) => {
    // last minute (within a day) that produced something
    for (let m = Math.floor(now / MINUTE); m > Math.floor(now / MINUTE) - 1440; m--) {
      if (!w.alive(m * MINUTE)) continue;
      const ev = w.minute(m).filter((e) => e.timestamp <= now);
      if (ev.length) return { logStreamName: w.stream, lastEventTime: ev[ev.length - 1].timestamp };
    }
    return { logStreamName: w.stream };
  });
}

/**
 * CloudWatch Logs filter pattern (case-sensitive): space-separated terms must all match, "quoted phrase"
 * is one term, ?term = any of these, -term = must not contain.
 */
export function matchesFilter(pattern: string, message: string): boolean {
  const terms = [...pattern.matchAll(/([?-]?)(?:"([^"]*)"|(\S+))/g)].map((t) => ({ mod: t[1], text: t[2] ?? t[3] }));
  const any = terms.filter((t) => t.mod === '?');
  return (
    terms.filter((t) => !t.mod).every((t) => message.includes(t.text)) &&
    terms.filter((t) => t.mod === '-').every((t) => !message.includes(t.text)) &&
    (!any.length || any.some((t) => message.includes(t.text)))
  );
}

/** FilterLogEvents: events of one stream (or all) in [start, end], oldest first, at most the newest `limit`. */
export function filterLogEvents(env: AwsEnv, g: LogGroup, q: { start: number; end: number; stream?: string; pattern?: string; limit?: number }): LogEvent[] {
  // events older than the retention period are gone
  const o = g.retentionInDays ? { ...q, start: Math.max(q.start, Date.now() - g.retentionInDays * 1440 * MINUTE) } : q;
  // stored events (Lambda, Batch) are filtered directly; generated ones are produced minute by minute
  if (g.source.kind === 'stored')
    return (g.events ?? []).filter((e) => (!o.stream || e.logStreamName === o.stream) && e.timestamp >= o.start && e.timestamp <= o.end && matchesFilter(o.pattern ?? '', e.message)).sort((a, b) => a.timestamp - b.timestamp).slice(-(o.limit ?? 1000));
  const out: LogEvent[] = [];
  for (const w of writers(env, g).filter((x) => !o.stream || x.stream === o.stream))
    for (let m = Math.floor(o.start / MINUTE); m * MINUTE <= o.end; m++)
      if (w.alive(m * MINUTE)) for (const e of w.minute(m)) if (e.timestamp >= o.start && e.timestamp <= o.end && matchesFilter(o.pattern ?? '', e.message)) out.push(e);
  return out.sort((a, b) => a.timestamp - b.timestamp).slice(-(o.limit ?? 1000));
}

/** a service writing its own log lines (Lambda, Batch): creates the group on first use */
export function appendLog(env: AwsEnv, groupName: string, stream: string, lines: string[], at: number) {
  let g = env.logGroups.find((x) => x.logGroupName === groupName);
  if (!g) {
    g = { logGroupName: groupName, arn: logGroupArn(env, groupName), creationTime: at, source: { kind: 'stored' }, events: [] };
    env.logGroups.push(g);
  }
  g.events = [...(g.events ?? []), ...lines.map((message, n) => ({ timestamp: at + n, message, logStreamName: stream }))].slice(-2000);
}

export const RETENTION_DAYS = [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653];

/** PutRetentionPolicy (days) / DeleteRetentionPolicy (undefined = never expire) */
export function putRetentionPolicy(env: AwsEnv, name: string, days: number | undefined) {
  const g = env.logGroups.find((x) => x.logGroupName === name);
  if (!g) throw new AwsError('ResourceNotFoundException', 'The specified log group does not exist.');
  if (days !== undefined && !RETENTION_DAYS.includes(days)) throw new AwsError('InvalidParameterException', `1 validation error detected: Value '${days}' at 'retentionInDays' failed to satisfy constraint: Member must satisfy enum value set: [${RETENTION_DAYS.join(', ')}]`);
  g.retentionInDays = days;
  if (days === undefined) trail(env, { source: 'logs', name: 'DeleteRetentionPolicy', resources: [['AWS::Logs::LogGroup', g.arn]], request: { logGroupName: name }, response: null });
  else trail(env, { source: 'logs', name: 'PutRetentionPolicy', resources: [['AWS::Logs::LogGroup', g.arn]], request: { logGroupName: name, retentionInDays: days }, response: null });
}

/** GB kept by a group with a simulated ingestion volume: a month's worth of ingestion per 30 days, up to the retention period */
export function storedGb(g: LogGroup, now = Date.now()): number {
  const days = Math.min((now - g.creationTime) / (1440 * MINUTE), g.retentionInDays ?? Infinity);
  return ((g.ingestionGbPerMonth ?? 0) / 30) * Math.max(0, days);
}

/** rough "保存されたバイト数" for the log group list */
export function storedBytes(env: AwsEnv, g: LogGroup, now = Date.now()): number {
  if (g.ingestionGbPerMonth) return Math.round(storedGb(g, now) * 1024 ** 3);
  if (g.source.kind === 'stored') return (g.events ?? []).reduce((n, e) => n + e.message.length + 26, 0);
  return Math.round(((now - g.creationTime) / MINUTE) * (g.source.kind === 'app' ? 420 : 60) * Math.max(1, writers(env, g).length));
}
