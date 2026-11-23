/* aws cloudwatch — メトリクス (一覧・統計の取り出し) とアラーム。値はコンソールのグラフと同じ sim/cloudwatch.ts から出す */
import { deleteAlarms, evaluateAlarm, getMetricData, listMetrics, metricInfo, OPERATORS, putMetricAlarm, type MetricRef } from '../../../sim/cloudwatch';
import type { AwsEnv, ComparisonOperator, MetricAlarm, Statistic } from '../../../sim/types';
import { AwsError, int, iso, pascal, req, service, str, strs, structs, type OpContext, type OperationSpec, ParamError } from '../types';

const STATISTICS: Statistic[] = ['SampleCount', 'Average', 'Sum', 'Minimum', 'Maximum'];
const STATES = ['OK', 'ALARM', 'INSUFFICIENT_DATA'];

/** CLI v2 の timestamp: ISO 8601 (タイムゾーンが無ければ UTC) か UNIX 時間 (秒)。読めなければ NaN */
export const parseTimestamp = (v: string) => (/^\d+(\.\d+)?$/.test(v) ? Number(v) * 1000 : Date.parse(/T/.test(v) && !/(Z|[+-]\d\d:?\d\d)$/i.test(v) ? v + 'Z' : v));

export function timestamp(ctx: OpContext, name: string): number | undefined {
  const v = str(ctx, name)?.trim();
  if (v === undefined) return undefined;
  const t = parseTimestamp(v);
  // ponytail: 実物は 252 (パラメーターの検証) で止まるが、AwsError では 254 になるので素の Error (255) にする。aws.ts が timestamp を検証するようになったら消す
  if (Number.isNaN(t)) throw new ParamError(`Parameter validation failed:\nInvalid type for parameter ${pascal(name)}, value: ${v}, type: <class 'str'>, valid types: <class 'datetime.datetime'>, timestamp-string`);
  return t;
}

const dimsIn = (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []).map((d: Record<string, unknown>) => ({ name: String(d.Name ?? ''), value: String(d.Value ?? '') }));
const dimsOut = (r: Pick<MetricRef, 'dimensions'>) => r.dimensions.map((d) => ({ Name: d.name, Value: d.value }));

/** 実在するメトリクス (名前空間・メトリクス名・ディメンションの名前が合う) だけを sim に問い合わせる。合わなければ実物と同じく空 */
function datapoints(env: AwsEnv, ref: MetricRef, o: { start: number; end: number; period: number; stat: Statistic }) {
  const info = metricInfo(ref);
  const asg = ref.namespace === 'AWS/EC2' && ref.metricName === 'CPUUtilization' && ref.dimensions[0]?.name === 'AutoScalingGroupName';
  // ALB の AZ 別メトリクス (LoadBalancer と AvailabilityZone の 2 つ。順番はどちらでもよい)
  const lb = ref.dimensions.find((d) => d.name === 'LoadBalancer');
  const az = ref.dimensions.find((d) => d.name === 'AvailabilityZone');
  if (info && ref.namespace === 'AWS/ApplicationELB' && ref.dimensions.length === 2 && lb && az) return getMetricData(env, { ...ref, dimensions: [lb, az] }, o);
  if (!info || ref.dimensions.length !== 1 || (ref.dimensions[0].name !== info.dimension && !asg)) return [];
  return getMetricData(env, ref, o);
}

function checkRange(start: number, end: number, period: number) {
  if (start >= end) throw new AwsError('InvalidParameterValue', 'The parameter StartTime must be less than the parameter EndTime.');
  const n = Math.ceil((end - start) / (period * 1000));
  if (n > 1440) throw new AwsError('InvalidParameterCombination', `You have requested up to ${n.toLocaleString('en-US')} datapoints, which exceeds the limit of 1,440. You may reduce the datapoints requested by increasing Period, or decreasing the time range.`);
}

function alarmOut(env: AwsEnv, a: MetricAlarm, now: number) {
  const e = evaluateAlarm(env, a, now);
  return {
    AlarmName: a.alarmName,
    AlarmArn: a.alarmArn,
    ...(a.alarmDescription ? { AlarmDescription: a.alarmDescription } : {}),
    AlarmConfigurationUpdatedTimestamp: iso(a.createdAt),
    ActionsEnabled: true,
    OKActions: [],
    AlarmActions: [],
    InsufficientDataActions: [],
    StateValue: e.state,
    StateReason: e.reason,
    StateUpdatedTimestamp: iso(e.stateUpdatedAt),
    MetricName: a.metricName,
    Namespace: a.namespace,
    Statistic: a.statistic,
    Dimensions: dimsOut(a),
    Period: a.period,
    EvaluationPeriods: a.evaluationPeriods,
    DatapointsToAlarm: a.datapointsToAlarm,
    Threshold: a.threshold,
    ComparisonOperator: a.comparisonOperator,
    TreatMissingData: a.treatMissingData,
    StateTransitionedTimestamp: iso(e.stateUpdatedAt),
  };
}

const enumError = (value: string, field: string, set: string[]) => new AwsError('ValidationError', `1 validation error detected: Value '${value}' at '${field}' failed to satisfy constraint: Member must satisfy enum value set: [${set.join(', ')}]`);

const ops: OperationSpec[] = [
  {
    name: 'list-metrics',
    desc: 'メトリクスの一覧 (名前空間・メトリクス名・ディメンション)',
    params: [
      { name: 'namespace', type: 'string', desc: '名前空間で絞る (AWS/EC2 など)' },
      { name: 'metric-name', type: 'string', desc: 'メトリクス名で絞る (CPUUtilization など)' },
      { name: 'dimensions', type: 'list', of: 'structure', desc: 'ディメンションで絞る: Name=InstanceId[,Value=i-...]' },
      { name: 'recently-active', type: 'string', desc: 'PT3H: 3 時間以内にデータが届いたものだけ' },
    ],
    readOnly: true,
    examples: ['aws cloudwatch list-metrics --namespace AWS/EC2 --metric-name CPUUtilization'],
    run(ctx) {
      const ns = str(ctx, 'namespace');
      const name = str(ctx, 'metric-name');
      const filters = structs(ctx, 'dimensions');
      const metrics = listMetrics(ctx.env).filter(
        (m) => (!ns || m.namespace === ns) && (!name || m.metricName === name) && filters.every((f) => m.dimensions.some((d) => d.name === f.Name && (f.Value === undefined || d.value === String(f.Value)))),
      );
      return { Metrics: metrics.map((m) => ({ Namespace: m.namespace, MetricName: m.metricName, Dimensions: dimsOut(m) })) };
    },
  },
  {
    name: 'get-metric-statistics',
    desc: '1 つのメトリクスのデータポイントを、期間ごとの統計 (平均・最大など) で取り出す',
    params: [
      { name: 'namespace', type: 'string', required: true, desc: '名前空間 (AWS/EC2、AWS/ApplicationELB、AWS/RDS など)' },
      { name: 'metric-name', type: 'string', required: true, desc: 'メトリクス名 (CPUUtilization など)' },
      { name: 'dimensions', type: 'list', of: 'structure', desc: 'どのリソースか: Name=InstanceId,Value=i-...' },
      { name: 'start-time', type: 'timestamp', required: true, desc: '開始 (2026-01-01T00:00:00Z か UNIX 時間の秒)' },
      { name: 'end-time', type: 'timestamp', required: true, desc: '終了 (同じ書き方)' },
      { name: 'period', type: 'integer', required: true, desc: '期間 (秒。60 の倍数)' },
      { name: 'statistics', type: 'list', desc: 'Average / Maximum / Minimum / Sum / SampleCount (複数可)' },
      { name: 'unit', type: 'string', desc: '単位 (Percent / Seconds / Count / Bytes)' },
    ],
    readOnly: true,
    examples: ['NOW=$(date +%s)', 'aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=i-0123456789abcdef0 --statistics Average --period 300 --start-time $((NOW - 3600)) --end-time $NOW --output table'],
    run(ctx) {
      const stats = strs(ctx, 'statistics');
      if (!stats.length) throw new AwsError('InvalidParameterCombination', 'At least one of the parameters Statistics and ExtendedStatistics must be specified.');
      for (const s of stats) if (!STATISTICS.includes(s as Statistic)) throw enumError(`[${stats.join(', ')}]`, 'statistics', STATISTICS);
      const period = int(ctx, 'period')!;
      if (period < 1 || (period >= 60 && period % 60)) throw new AwsError('InvalidParameterValue', 'The parameter Period must be a multiple of 60.');
      const start = timestamp(ctx, 'start-time')!;
      const end = timestamp(ctx, 'end-time')!;
      checkRange(start, end, period);
      const ref: MetricRef = { namespace: req(ctx, 'namespace'), metricName: req(ctx, 'metric-name'), dimensions: dimsIn(ctx.p.dimensions) };
      const unit = metricInfo(ref)?.unit;
      const wanted = str(ctx, 'unit');
      // ponytail: 60 秒未満の期間 (高解像度メトリクス) は無いので空にする
      const series = period < 60 || (wanted && wanted !== unit) ? [] : stats.map((s) => new Map(datapoints(ctx.env, ref, { start, end: Math.min(end, ctx.now), period, stat: s as Statistic }).filter((d) => d.t >= start && d.t < end).map((d) => [d.t, d.v] as const)));
      const times = [...new Set(series.flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
      return { Label: ref.metricName, Datapoints: times.map((t) => ({ Timestamp: iso(t), ...Object.fromEntries(stats.map((s, n) => [s, series[n].get(t)])), Unit: unit })) };
    },
  },
  {
    name: 'get-metric-data',
    desc: '複数のメトリクスのデータポイントを 1 回で取り出す (MetricDataQueries)',
    params: [
      { name: 'metric-data-queries', type: 'list', of: 'structure', required: true, desc: '取り出すメトリクスの並び (JSON か file://queries.json)' },
      { name: 'start-time', type: 'timestamp', required: true, desc: '開始 (2026-01-01T00:00:00Z か UNIX 時間の秒)' },
      { name: 'end-time', type: 'timestamp', required: true, desc: '終了 (同じ書き方)' },
      { name: 'scan-by', type: 'string', desc: 'TimestampDescending (既定、新しい順) / TimestampAscending' },
    ],
    readOnly: true,
    examples: ['aws cloudwatch get-metric-data --metric-data-queries file://queries.json --start-time $((NOW - 3600)) --end-time $NOW'],
    run(ctx) {
      const start = timestamp(ctx, 'start-time')!;
      const end = timestamp(ctx, 'end-time')!;
      const queries = structs(ctx, 'metric-data-queries');
      if (!queries.length) throw new AwsError('ValidationError', 'The parameter MetricDataQueries is required.');
      const ids = queries.map((q) => (typeof q.Id === 'string' ? q.Id : JSON.stringify(q.Id ?? '')));
      if (new Set(ids).size !== ids.length) throw new AwsError('ValidationError', 'The values for parameter id in MetricDataQueries are not unique.');
      const scan = str(ctx, 'scan-by') ?? 'TimestampDescending';
      if (!['TimestampDescending', 'TimestampAscending'].includes(scan)) throw enumError(scan, 'scanBy', ['TimestampDescending', 'TimestampAscending']);
      const results = queries.map((q, n) => {
        const at = `MetricDataQueries.member.${n + 1}`;
        if (!/^[a-z][a-zA-Z0-9_]*$/.test(ids[n])) throw new AwsError('ValidationError', `The value ${ids[n]} for parameter ${at}.Id is not matching the expected pattern ^[a-z][a-zA-Z0-9_]*$.`);
        if (q.Expression !== undefined) throw new AwsError('ValidationError', `(シミュレーター) ${at}.Expression (Metric Math) には対応していません。MetricStat で指定してください`);
        const ms = q.MetricStat as Record<string, unknown> | undefined;
        const m = ms?.Metric as Record<string, unknown> | undefined;
        if (!ms || !m?.Namespace || !m.MetricName) throw new AwsError('ValidationError', `The parameter ${at}.MetricStat.Metric (Namespace, MetricName) is required.`);
        const stat = String(ms.Stat ?? '');
        if (!STATISTICS.includes(stat as Statistic)) throw new AwsError('ValidationError', `(シミュレーター) ${at}.MetricStat.Stat は ${STATISTICS.join(' / ')} のどれかにしてください (受け取った値: ${stat || 'なし'})`);
        const period = Number(ms.Period);
        if (!Number.isInteger(period) || period < 60 || period % 60) throw new AwsError('ValidationError', `The parameter ${at}.MetricStat.Period must be a multiple of 60.`);
        checkRange(start, end, period);
        const ref: MetricRef = { namespace: String(m.Namespace), metricName: String(m.MetricName), dimensions: dimsIn(m.Dimensions) };
        const points = datapoints(ctx.env, ref, { start, end: Math.min(end, ctx.now), period, stat: stat as Statistic }).filter((d) => d.t >= start && d.t < end);
        if (scan === 'TimestampDescending') points.reverse();
        return { ret: q.ReturnData !== false, out: { Id: ids[n], Label: String(q.Label ?? ref.metricName), Timestamps: points.map((d) => iso(d.t)), Values: points.map((d) => d.v), StatusCode: 'Complete' } };
      });
      return { MetricDataResults: results.filter((r) => r.ret).map((r) => r.out), Messages: [] };
    },
  },
  {
    name: 'describe-alarms',
    desc: 'アラームの一覧と今の状態 (StateValue)',
    params: [
      { name: 'alarm-names', type: 'list', desc: 'アラーム名で絞る (複数可)' },
      { name: 'alarm-name-prefix', type: 'string', desc: 'アラーム名の頭で絞る' },
      { name: 'state-value', type: 'string', desc: 'OK / ALARM / INSUFFICIENT_DATA で絞る' },
      { name: 'alarm-types', type: 'list', desc: 'MetricAlarm / CompositeAlarm' },
    ],
    readOnly: true,
    examples: ['aws cloudwatch describe-alarms --alarm-names web-1-cpu-high', "aws cloudwatch describe-alarms --query 'MetricAlarms[].[AlarmName,StateValue]' --output table"],
    run(ctx) {
      const names = strs(ctx, 'alarm-names');
      const prefix = str(ctx, 'alarm-name-prefix');
      const state = str(ctx, 'state-value');
      if (names.length && prefix !== undefined) throw new AwsError('InvalidParameterCombination', 'AlarmNames and AlarmNamePrefix cannot be specified together.');
      if (state && !STATES.includes(state)) throw enumError(state, 'stateValue', STATES);
      const types = strs(ctx, 'alarm-types');
      const alarms = [...ctx.env.alarms]
        .filter((a) => (!names.length || names.includes(a.alarmName)) && (!prefix || a.alarmName.startsWith(prefix)))
        .sort((a, b) => a.alarmName.localeCompare(b.alarmName))
        .map((a) => alarmOut(ctx.env, a, ctx.now))
        .filter((a) => !state || a.StateValue === state);
      return { MetricAlarms: !types.length || types.includes('MetricAlarm') ? alarms : [], CompositeAlarms: [] };
    },
  },
  {
    name: 'put-metric-alarm',
    desc: 'メトリクスのアラームを作る (同じ名前があれば上書き)',
    params: [
      { name: 'alarm-name', type: 'string', required: true, desc: 'アラーム名' },
      { name: 'alarm-description', type: 'string', desc: '説明' },
      { name: 'namespace', type: 'string', desc: '名前空間 (AWS/EC2 など)' },
      { name: 'metric-name', type: 'string', desc: 'メトリクス名 (CPUUtilization など)' },
      { name: 'dimensions', type: 'list', of: 'structure', desc: 'どのリソースか: Name=InstanceId,Value=i-...' },
      { name: 'statistic', type: 'string', desc: 'Average / Maximum / Minimum / Sum / SampleCount' },
      { name: 'period', type: 'integer', desc: '期間 (秒。60 の倍数)' },
      { name: 'evaluation-periods', type: 'integer', required: true, desc: '直近いくつの期間で判定するか' },
      { name: 'datapoints-to-alarm', type: 'integer', desc: 'そのうちいくつ超えたらアラーム状態か (既定は evaluation-periods と同じ)' },
      { name: 'threshold', type: 'string', desc: 'しきい値 (数値)' },
      { name: 'comparison-operator', type: 'string', required: true, desc: 'GreaterThanThreshold / GreaterThanOrEqualToThreshold / LessThanThreshold / LessThanOrEqualToThreshold' },
      { name: 'unit', type: 'string', desc: '単位' },
    ],
    examples: ['aws cloudwatch put-metric-alarm --alarm-name web-1-cpu-high --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=i-0123456789abcdef0 --statistic Average --period 300 --evaluation-periods 1 --threshold 70 --comparison-operator GreaterThanThreshold'],
    run(ctx) {
      const namespace = str(ctx, 'namespace');
      const metricName = str(ctx, 'metric-name');
      if (!namespace || !metricName) throw new AwsError('ValidationError', 'Either MetricName and Namespace, or Metrics must be specified.');
      const statistic = str(ctx, 'statistic');
      if (!statistic) throw new AwsError('ValidationError', 'Either Statistic or ExtendedStatistic must be specified.');
      if (!STATISTICS.includes(statistic as Statistic)) throw enumError(statistic, 'statistic', STATISTICS);
      const op = req(ctx, 'comparison-operator');
      if (!(op in OPERATORS)) throw enumError(op, 'comparisonOperator', Object.keys(OPERATORS));
      const evaluationPeriods = int(ctx, 'evaluation-periods')!;
      putMetricAlarm(
        ctx.env,
        {
          alarmName: req(ctx, 'alarm-name'),
          alarmDescription: str(ctx, 'alarm-description'),
          namespace,
          metricName,
          dimensions: dimsIn(ctx.p.dimensions),
          statistic: statistic as Statistic,
          period: int(ctx, 'period') ?? NaN,
          evaluationPeriods,
          datapointsToAlarm: int(ctx, 'datapoints-to-alarm') ?? evaluationPeriods,
          threshold: str(ctx, 'threshold') === undefined ? NaN : Number(str(ctx, 'threshold')),
          comparisonOperator: op as ComparisonOperator,
        },
        ctx.now,
      );
      return undefined;
    },
  },
  {
    name: 'delete-alarms',
    desc: 'アラームを削除する',
    params: [{ name: 'alarm-names', type: 'list', required: true, desc: '削除するアラーム名 (複数可)' }],
    run(ctx) {
      const names = strs(ctx, 'alarm-names');
      if (names.some((n) => !ctx.env.alarms.some((a) => a.alarmName === n))) throw new AwsError('ResourceNotFound', 'The named resource does not exist.');
      deleteAlarms(ctx.env, names);
      return undefined;
    },
  },
];

export default service('cloudwatch', 'Amazon CloudWatch (メトリクス・アラーム)', ops);
