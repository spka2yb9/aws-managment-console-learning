import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import Textarea from '@cloudscape-design/components/textarea';
import Wizard from '@cloudscape-design/components/wizard';
import { lazy, Suspense, useEffect, useState, type ComponentProps } from 'react';
import {
  alarmMetric,
  decodeGraph,
  deleteAlarms,
  encodeGraph,
  evaluateAlarm,
  filterLogEvents,
  getMetricData,
  listMetrics,
  logStreams,
  metricInfo,
  OPERATORS,
  putMetricAlarm,
  putRetentionPolicy,
  RETENTION_DAYS,
  sameMetric,
  storedBytes,
  type AlarmState,
  type MetricRef,
} from '../../sim/cloudwatch';
import { nameOf } from '../../sim/env';
import type { AwsEnv, AwsError, ComparisonOperator, LogGroup, MetricAlarm, Statistic } from '../../sim/types';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, errorText, formatDate, NotFound, queryParam, ResourceDetail, ResourceTable, useEnv, useNavigate } from '../ui';

// recharts is only downloaded when a graph is on screen
const MetricGraph = lazy(() => import('../MetricGraph'));
export function Graph(p: ComponentProps<typeof MetricGraph>) {
  return (
    <Suspense fallback={<Box textAlign="center" padding="xxl"><Spinner /></Box>}>
      <MetricGraph {...p} />
    </Suspense>
  );
}

/** Wall clock for graphs and alarm states, refreshed like the console's auto refresh. */
export function useNow(ms = 10_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const HOUR = 3_600_000;
const RANGES = [
  { id: '1h', label: '1 時間', ms: HOUR, period: 60 },
  { id: '3h', label: '3 時間', ms: 3 * HOUR, period: 60 },
  { id: '12h', label: '12 時間', ms: 12 * HOUR, period: 300 },
  { id: '1d', label: '1 日', ms: 24 * HOUR, period: 300 },
  { id: '1w', label: '1 週間', ms: 7 * 24 * HOUR, period: 3600 },
];
const range = (id: string) => RANGES.find((r) => r.id === id) ?? RANGES[1];

function RangeControl({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  return <SegmentedControl label="時間範囲" selectedId={value} onChange={(e) => onChange(e.detail.selectedId)} options={RANGES.map((r) => ({ id: r.id, text: r.label }))} />;
}

const STATS: { value: Statistic; label: string }[] = [
  { value: 'Average', label: '平均' },
  { value: 'Maximum', label: '最大' },
  { value: 'Minimum', label: '最小' },
  { value: 'Sum', label: '合計' },
  { value: 'SampleCount', label: 'サンプル数' },
];
const PERIODS = [
  { value: 60, label: '1 分' },
  { value: 300, label: '5 分' },
  { value: 900, label: '15 分' },
  { value: 3600, label: '1 時間' },
];
const statLabel = (s: Statistic) => STATS.find((x) => x.value === s)!.label;
const periodLabel = (p: number) => PERIODS.find((x) => x.value === p)?.label ?? `${p / 60} 分`;
const NAMESPACES = [
  { ns: 'AWS/EC2', label: 'EC2', group: 'インスタンス別メトリクス', column: 'インスタンス名' },
  { ns: 'AWS/ApplicationELB', label: 'ApplicationELB', group: 'LoadBalancer 別メトリクス', column: 'LoadBalancer 名' },
  { ns: 'AWS/RDS', label: 'RDS', group: 'データベース別メトリクス', column: 'DB インスタンス' },
  { ns: 'AWS/AutoScaling', label: 'AutoScaling', group: 'グループメトリクス', column: 'Auto Scaling グループ' },
];

export const metricsPath = (refs: MetricRef[], ns?: string) => `/cloudwatch/metrics?${new URLSearchParams({ ...(ns ? { ns } : {}), graph: encodeGraph(refs) })}`;

function resourceName(env: AwsEnv, ref: MetricRef): string {
  const v = ref.dimensions[0]?.value ?? '';
  if (ref.namespace === 'AWS/EC2') return nameOf(env.instances.find((i) => i.instanceId === v) ?? { tags: [] }) || v;
  if (ref.namespace === 'AWS/ApplicationELB') return v.split('/')[1] ?? v;
  return v;
}
const seriesLabel = (env: AwsEnv, ref: MetricRef) => `${resourceName(env, ref)} ${ref.metricName}`;

// ---------------- the モニタリング tab of EC2 / ALB / RDS ----------------

export function MonitoringCharts({ metrics, columns = 2 }: { metrics: MetricRef[]; columns?: 2 | 3 }) {
  const env = useEnv();
  const now = useNow();
  const [rangeId, setRangeId] = useState('3h');
  const r = range(rangeId);
  return (
    <SpaceBetween size="m">
      <Header variant="h2" description="CloudWatch メトリクス (シミュレーション)。グラフは 10 秒ごとに更新されます。" actions={<RangeControl value={rangeId} onChange={setRangeId} />}>
        メトリクス
      </Header>
      <Grid gridDefinition={metrics.map(() => ({ colspan: 12 / columns }))}>
        {metrics.map((m) => {
          const info = metricInfo(m)!;
          return (
            <Container key={m.metricName} header={<Header variant="h3" actions={<ConsoleLink to={metricsPath([m], m.namespace)}>メトリクスで表示</ConsoleLink>}>{info.title}</Header>}>
              <div data-testid={`chart-${m.metricName}`}>
                <Graph series={[{ label: seriesLabel(env, m), data: getMetricData(env, m, { start: now - r.ms, end: now, period: r.period, stat: info.stat }) }]} start={now - r.ms} end={now} unit={info.unit} height={160} />
              </div>
            </Container>
          );
        })}
      </Grid>
    </SpaceBetween>
  );
}

// ---------------- alarms ----------------

const STATE_LABEL: Record<AlarmState, string> = { ALARM: 'アラーム状態', OK: 'OK', INSUFFICIENT_DATA: 'データ不足' };

export function AlarmStateIndicator({ state }: { state: AlarmState }) {
  return <StatusIndicator type={state === 'ALARM' ? 'error' : state === 'OK' ? 'success' : 'stopped'}>{STATE_LABEL[state]}</StatusIndicator>;
}

export const conditionText = (a: MetricAlarm) => `${a.metricName} ${OPERATORS[a.comparisonOperator].symbol} ${a.threshold} (${periodLabel(a.period)}内の ${a.evaluationPeriods} データポイントのうち ${a.datapointsToAlarm} 件)`;
const alarmPath = (name: string) => `/cloudwatch/alarms/view?${new URLSearchParams({ name })}`;

export function CloudWatchHome() {
  const env = useEnv();
  const now = useNow();
  const navigate = useNavigate();
  const evals = env.alarms.map((a) => ({ a, e: evaluateAlarm(env, a, now) }));
  const count = (s: AlarmState) => evals.filter((x) => x.e.state === s).length;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="AWS のリソースとアプリケーションを、メトリクス・ログ・アラームでモニタリングします。">CloudWatch</Header>
      <Container header={<Header variant="h2" actions={<Button onClick={() => navigate('/cloudwatch/alarms/create')}>アラームの作成</Button>}>アラームの概要</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          {(['ALARM', 'INSUFFICIENT_DATA', 'OK'] as AlarmState[]).map((s) => (
            <div key={s}>
              <Box variant="awsui-key-label"><AlarmStateIndicator state={s} /></Box>
              <ConsoleLink to={`/cloudwatch/alarms?state=${s}`}>{String(count(s))}</ConsoleLink>
            </div>
          ))}
        </ColumnLayout>
      </Container>
      <ColumnLayout columns={2}>
        <Container header={<Header variant="h2">メトリクス</Header>}>
          <SpaceBetween size="xs">
            <Box>{`${listMetrics(env).length} 個のメトリクスがあります。`}</Box>
            <ConsoleLink to="/cloudwatch/metrics">すべてのメトリクス</ConsoleLink>
          </SpaceBetween>
        </Container>
        <Container header={<Header variant="h2">ログ</Header>}>
          <SpaceBetween size="xs">
            <Box>{`${env.logGroups.length} 個のロググループがあります。`}</Box>
            <ConsoleLink to="/cloudwatch/logs">ロググループ</ConsoleLink>
          </SpaceBetween>
        </Container>
      </ColumnLayout>
    </SpaceBetween>
  );
}

export function AlarmList() {
  const env = useEnv();
  const now = useNow();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const state = queryParam(useConsole((s) => s.path), 'state') as AlarmState | undefined;
  const rows = env.alarms.map((a) => ({ a, e: evaluateAlarm(env, a, now) })).filter((r) => !state || r.e.state === state);
  type Row = (typeof rows)[number];
  const [sel, setSel] = useState<Row[]>([]);
  return (
    <ResourceTable<Row>
      title={state ? `アラーム: ${STATE_LABEL[state]}` : 'アラーム'}
      items={rows}
      trackBy={(r) => r.a.alarmName}
      selectionType="multi"
      selectedItems={sel}
      onSelectionChange={setSel}
      resourceName="アラーム"
      testId="alarm-table"
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu
            items={[
              {
                id: 'delete',
                text: '削除',
                disabled: !sel.length,
                onClick: () => {
                  run((d) => deleteAlarms(d, sel.map((r) => r.a.alarmName)), `${sel.length} 個のアラームを削除しました`);
                  setSel([]);
                },
              },
            ]}
          />
          <Hotspot hotspotId="cw-create-alarm" direction="right">
            <Button variant="primary" onClick={() => navigate('/cloudwatch/alarms/create')} data-testid="create-alarm">アラームの作成</Button>
          </Hotspot>
        </SpaceBetween>
      }
      columns={[
        { id: 'name', header: '名前', cell: (r) => <ConsoleLink to={alarmPath(r.a.alarmName)}>{r.a.alarmName}</ConsoleLink>, value: (r) => r.a.alarmName },
        { id: 'state', header: '状態', cell: (r) => <AlarmStateIndicator state={r.e.state} />, value: (r) => STATE_LABEL[r.e.state] },
        { id: 'updated', header: '最終状態更新', cell: (r) => formatDate(r.e.stateUpdatedAt), value: (r) => r.e.stateUpdatedAt },
        { id: 'condition', header: '条件', cell: (r) => conditionText(r.a), value: (r) => conditionText(r.a) },
        { id: 'actions', header: 'アクション', cell: () => <Box color="text-body-secondary">アクションなし</Box> },
      ]}
    />
  );
}

export function AlarmDetail({ name }: { name: string }) {
  const env = useEnv();
  const now = useNow();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [rangeId, setRangeId] = useState('3h');
  const a = env.alarms.find((x) => x.alarmName === name);
  if (!a) return <NotFound what="アラーム" id={name} />;
  const e = evaluateAlarm(env, a, now);
  const r = range(rangeId);
  const info = metricInfo(a);
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              onClick={() => {
                run((d) => deleteAlarms(d, [name]), `アラーム「${name}」を削除しました`);
                navigate('/cloudwatch/alarms');
              }}
            >
              削除
            </Button>
            <Hotspot hotspotId="alarm-edit" direction="right">
              <Button onClick={() => navigate(`/cloudwatch/alarms/edit?${new URLSearchParams({ name })}`)} data-testid="alarm-edit">編集</Button>
            </Hotspot>
          </SpaceBetween>
        }
      >
        {name}
      </Header>
      <Container header={<Header variant="h2" description={conditionText(a)} actions={<RangeControl value={rangeId} onChange={setRangeId} />}>グラフ</Header>}>
        <div data-testid="alarm-graph">
          <Graph series={[{ label: seriesLabel(env, alarmMetric(a)), data: getMetricData(env, alarmMetric(a), { start: now - r.ms, end: now, period: a.period, stat: a.statistic }) }]} start={now - r.ms} end={now} unit={info?.unit} threshold={a.threshold} />
        </div>
      </Container>
      <ResourceDetail
        columns={3}
        fields={[
          { label: '名前', value: a.alarmName },
          { label: '種類', value: 'メトリクスアラーム' },
          { label: '状態', value: <span data-testid="alarm-state"><AlarmStateIndicator state={e.state} /></span> },
          { label: 'しきい値', value: conditionText(a) },
          { label: '最終状態更新', value: formatDate(e.stateUpdatedAt) },
          { label: '状態の理由', value: <Box variant="small" data-testid="alarm-reason">{e.reason}</Box> },
          { label: '説明', value: a.alarmDescription },
          { label: '名前空間', value: a.namespace },
          { label: 'メトリクス名', value: a.metricName },
          { label: a.dimensions[0]?.name ?? 'ディメンション', value: a.dimensions[0]?.value },
          { label: '統計', value: statLabel(a.statistic) },
          { label: '期間', value: periodLabel(a.period) },
          { label: '欠落データの処理', value: '欠落データを見つかりませんとして処理' },
          { label: 'ARN', value: <CopyableValue value={a.alarmArn} /> },
        ]}
      />
      <Table
        variant="container"
        header={<Header counter={`(${e.history.length})`}>履歴</Header>}
        items={e.history}
        empty="履歴はありません"
        columnDefinitions={[
          { id: 'at', header: '日付', cell: (h) => formatDate(h.at) },
          { id: 'type', header: '種類', cell: () => '状態の更新' },
          { id: 'desc', header: '説明', cell: (h) => <SpaceBetween size="xxs"><span>{`アラームが ${STATE_LABEL[h.from]} から ${STATE_LABEL[h.to]} に更新されました`}</span><Box variant="small" color="text-body-secondary">{h.reason}</Box></SpaceBetween> },
        ]}
      />
    </SpaceBetween>
  );
}

const OPERATOR_ITEMS: { value: ComparisonOperator; label: string }[] = [
  { value: 'GreaterThanThreshold', label: 'より大きい (> しきい値)' },
  { value: 'GreaterThanOrEqualToThreshold', label: '以上 (>= しきい値)' },
  { value: 'LessThanOrEqualToThreshold', label: '以下 (<= しきい値)' },
  { value: 'LessThanThreshold', label: 'より低い (< しきい値)' },
];

/** The alarm wizard; with `edit` it opens an existing alarm ("編集") and saves it under the same name. */
export function CreateAlarm({ edit }: { edit?: string }) {
  const env = useEnv();
  const now = useNow();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const path = useConsole((s) => s.path);
  const current = edit ? env.alarms.find((a) => a.alarmName === edit) : undefined;
  const preset = current ? alarmMetric(current) : decodeGraph(queryParam(path, 'graph'))[0];
  const metrics = listMetrics(env);
  const [step, setStep] = useState(0);
  const [metricKey, setMetricKey] = useState(preset ? encodeGraph([preset]) : '');
  const [stat, setStat] = useState<Statistic>(current?.statistic ?? (preset ? (metricInfo(preset)?.stat ?? 'Average') : 'Average'));
  const [period, setPeriod] = useState(current?.period ?? 300);
  const [op, setOp] = useState<ComparisonOperator>(current?.comparisonOperator ?? 'GreaterThanThreshold');
  const [threshold, setThreshold] = useState(current ? String(current.threshold) : '');
  const [evaluationPeriods, setEvaluationPeriods] = useState(String(current?.evaluationPeriods ?? 1));
  const [datapoints, setDatapoints] = useState(String(current?.datapointsToAlarm ?? 1));
  const [name, setName] = useState(current?.alarmName ?? '');
  const [desc, setDesc] = useState(current?.alarmDescription ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<AwsError | null>(null);
  const ref = decodeGraph(metricKey)[0];
  const info = ref && metricInfo(ref);
  const err = problem ?? errorText(error);
  const option = (m: (typeof metrics)[number]) => ({ value: encodeGraph([m]), label: `${m.resourceName || m.dimensions[0].value} ${m.metricName}`, description: `${m.namespace} · ${m.dimensions[0].name} = ${m.dimensions[0].value}` });
  const selected = ref && metrics.find((m) => sameMetric(m, ref));
  const r = range('3h');
  const preview = ref && (
    <Graph series={[{ label: seriesLabel(env, ref), data: getMetricData(env, ref, { start: now - r.ms, end: now, period, stat }) }]} start={now - r.ms} end={now} unit={info?.unit} threshold={threshold.trim() && Number.isFinite(Number(threshold)) ? Number(threshold) : undefined} />
  );
  const validate = (index: number) => {
    if (index >= 1 && !ref) return 'メトリクスを選択してください。';
    if (index >= 1 && (!threshold.trim() || !Number.isFinite(Number(threshold)))) return 'しきい値は数字である必要があります。';
    if (index >= 3 && !name.trim()) return 'アラーム名を入力してください。';
    if (index >= 3 && !edit && env.alarms.some((a) => a.alarmName === name.trim())) return 'この名前のアラームは既に存在します。';
    return null;
  };
  return (
    <div data-testid="create-alarm-wizard">
      <Wizard
        activeStepIndex={step}
        onNavigate={(e) => {
          const p = e.detail.requestedStepIndex > step ? validate(e.detail.requestedStepIndex) : null;
          setProblem(p);
          if (!p) setStep(e.detail.requestedStepIndex);
        }}
        onCancel={() => navigate(edit ? alarmPath(edit) : '/cloudwatch/alarms')}
        onSubmit={() => {
          const p = validate(3);
          if (p) return setProblem(p);
          const res = run(
            (d) => putMetricAlarm(d, { alarmName: name, alarmDescription: desc.trim() || undefined, ...ref!, statistic: stat, period, evaluationPeriods: Number(evaluationPeriods), datapointsToAlarm: Number(datapoints), threshold: Number(threshold), comparisonOperator: op }),
            edit ? `アラーム「${edit}」が正常に更新されました` : `アラーム「${name.trim()}」が正常に作成されました`,
          );
          if (res.ok) navigate(edit ? alarmPath(edit) : '/cloudwatch/alarms');
          else setError(res.error);
        }}
        i18nStrings={{ stepNumberLabel: (n) => `ステップ ${n}`, collapsedStepsLabel: (n, t) => `ステップ ${n}/${t}`, navigationAriaLabel: 'ステップ', cancelButton: 'キャンセル', previousButton: '前へ', nextButton: '次へ', submitButton: edit ? 'アラームの更新' : 'アラームの作成', optional: 'オプション' }}
        submitButtonText={edit ? 'アラームの更新' : 'アラームの作成'}
        steps={[
          {
            title: 'メトリクスと条件の指定',
            errorText: err,
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">メトリクス</Header>}>
                  <SpaceBetween size="m">
                    <FormField label="メトリクス" description="アラームで監視するメトリクスを選択します。リソース名やメトリクス名で絞り込めます。">
                      <Select
                        selectedOption={selected ? option(selected) : null}
                        placeholder="メトリクスの選択"
                        filteringType="auto"
                        options={NAMESPACES.map((n) => ({ label: `${n.label} > ${n.group}`, options: metrics.filter((m) => m.namespace === n.ns).map(option) }))}
                        onChange={(e) => {
                          const m = decodeGraph(e.detail.selectedOption.value)[0];
                          setMetricKey(e.detail.selectedOption.value!);
                          setStat(metricInfo(m)?.stat ?? 'Average');
                          setPeriod(m.namespace === 'AWS/EC2' ? 300 : 60);
                        }}
                        data-testid="alarm-metric"
                      />
                    </FormField>
                    {ref && (
                      <>
                        <ColumnLayout columns={3} variant="text-grid">
                          <div><Box variant="awsui-key-label">名前空間</Box>{ref.namespace}</div>
                          <div><Box variant="awsui-key-label">メトリクス名</Box>{ref.metricName}</div>
                          <div><Box variant="awsui-key-label">{ref.dimensions[0].name}</Box>{ref.dimensions[0].value}</div>
                        </ColumnLayout>
                        <ColumnLayout columns={2}>
                          <FormField label="統計">
                            <Select selectedOption={{ value: stat, label: statLabel(stat) }} options={STATS} onChange={(e) => setStat(e.detail.selectedOption.value as Statistic)} data-testid="alarm-stat" />
                          </FormField>
                          <FormField label="期間" constraintText={ref.namespace === 'AWS/EC2' ? 'EC2 の基本モニタリングは 5 分間隔です。1 分にするとデータ不足になりやすくなります。' : undefined}>
                            <Select selectedOption={{ value: String(period), label: periodLabel(period) }} options={PERIODS.map((p) => ({ value: String(p.value), label: p.label }))} onChange={(e) => setPeriod(Number(e.detail.selectedOption.value))} data-testid="alarm-period" />
                          </FormField>
                        </ColumnLayout>
                        {preview}
                      </>
                    )}
                  </SpaceBetween>
                </Container>
                <Container header={<Header variant="h2">条件</Header>}>
                  <SpaceBetween size="m">
                    <FormField label="しきい値の種類">
                      <RadioGroup value="static" items={[{ value: 'static', label: '静的', description: '値をしきい値として使用' }, { value: 'anomaly', label: '異常検出', disabled: true, description: 'このシミュレーターでは未提供' }]} />
                    </FormField>
                    <FormField label={`${ref?.metricName ?? 'メトリクス'} が次の場合...`} description="アラーム条件を定義します。">
                      <RadioGroup value={op} onChange={(e) => setOp(e.detail.value as ComparisonOperator)} items={OPERATOR_ITEMS} data-testid="alarm-operator" />
                    </FormField>
                    <FormField label="…よりも" description="しきい値を定義します。" constraintText="数字である必要があります">
                      <Input value={threshold} onChange={(e) => setThreshold(e.detail.value)} inputMode="decimal" placeholder="例: 80" data-testid="alarm-threshold" />
                    </FormField>
                    <ExpandableSection headerText="その他の設定">
                      <SpaceBetween size="m">
                        <FormField label="アラームを実行するデータポイント" description="アラーム状態になるために、評価期間内でしきい値を超える必要があるデータポイントの数です。">
                          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                            <Input value={datapoints} onChange={(e) => setDatapoints(e.detail.value)} type="number" data-testid="alarm-datapoints" />
                            <span>/</span>
                            <Input value={evaluationPeriods} onChange={(e) => setEvaluationPeriods(e.detail.value)} type="number" data-testid="alarm-evaluation-periods" />
                          </SpaceBetween>
                        </FormField>
                        <FormField label="欠落データの処理">
                          <Select disabled selectedOption={{ value: 'missing', label: '欠落データを見つかりませんとして処理' }} options={[]} />
                        </FormField>
                      </SpaceBetween>
                    </ExpandableSection>
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ),
          },
          {
            title: 'アクションの設定',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">通知</Header>}>
                <Alert type="info">Amazon SNS による通知、Auto Scaling アクション、EC2 アクションはこのシミュレーターでは未提供です。アラームの状態はコンソールで確認できます。</Alert>
              </Container>
            ),
          },
          {
            title: '名前と説明を追加',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">名前と説明</Header>}>
                <SpaceBetween size="m">
                  <FormField label="アラーム名" constraintText="このアカウントとリージョンで一意の名前を指定します。">
                    <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="例: webapp-db-cpu-high" disabled={!!edit} data-testid="alarm-name" />
                  </FormField>
                  <FormField label="アラームの説明 - オプション">
                    <Textarea value={desc} onChange={(e) => setDesc(e.detail.value)} rows={3} />
                  </FormField>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: 'プレビューと作成',
            errorText: err,
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">ステップ 1: メトリクスと条件の指定</Header>}>
                  <SpaceBetween size="m">
                    {preview}
                    <ColumnLayout columns={3} variant="text-grid">
                      <div><Box variant="awsui-key-label">メトリクス</Box>{ref ? seriesLabel(env, ref) : '-'}</div>
                      <div><Box variant="awsui-key-label">統計 / 期間</Box>{`${statLabel(stat)} / ${periodLabel(period)}`}</div>
                      <div><Box variant="awsui-key-label">条件</Box>{ref ? `${ref.metricName} ${OPERATORS[op].symbol} ${threshold} (${datapoints}/${evaluationPeriods} データポイント)` : '-'}</div>
                    </ColumnLayout>
                  </SpaceBetween>
                </Container>
                <Container header={<Header variant="h2">ステップ 3: 名前と説明を追加</Header>}>
                  <ColumnLayout columns={2} variant="text-grid">
                    <div><Box variant="awsui-key-label">アラーム名</Box>{name || '-'}</div>
                    <div><Box variant="awsui-key-label">アラームの説明</Box>{desc || '-'}</div>
                  </ColumnLayout>
                </Container>
              </SpaceBetween>
            ),
          },
        ]}
      />
    </div>
  );
}

// ---------------- metrics ----------------

export function MetricsPage() {
  const env = useEnv();
  const now = useNow();
  const navigate = useNavigate();
  const path = useConsole((s) => s.path);
  const ns = queryParam(path, 'ns');
  const graph = decodeGraph(queryParam(path, 'graph'));
  const [rangeId, setRangeId] = useState('3h');
  const [stat, setStat] = useState<Statistic | 'default'>('default');
  const [period, setPeriod] = useState(0);
  const [tab, setTab] = useState('browse');
  const r = range(rangeId);
  const all = listMetrics(env);
  const setGraph = (refs: MetricRef[], nextNs = ns) => navigate(metricsPath(refs, nextNs));
  const units = [...new Set(graph.map((g) => metricInfo(g)?.unit))];
  const nsInfo = NAMESPACES.find((n) => n.ns === ns);
  type Row = (typeof all)[number];
  return (
    <SpaceBetween size="l">
      <Header variant="h1">メトリクス</Header>
      <Container
        header={
          <Header
            variant="h2"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Select selectedOption={stat === 'default' ? { value: 'default', label: '統計: 既定' } : { value: stat, label: `統計: ${statLabel(stat)}` }} options={[{ value: 'default', label: '統計: 既定' }, ...STATS.map((s) => ({ value: s.value, label: `統計: ${s.label}` }))]} onChange={(e) => setStat(e.detail.selectedOption.value as Statistic)} />
                <Select selectedOption={{ value: String(period), label: period ? `期間: ${periodLabel(period)}` : '期間: 自動' }} options={[{ value: '0', label: '期間: 自動' }, ...PERIODS.map((p) => ({ value: String(p.value), label: `期間: ${p.label}` }))]} onChange={(e) => setPeriod(Number(e.detail.selectedOption.value))} />
                <RangeControl value={rangeId} onChange={setRangeId} />
              </SpaceBetween>
            }
          >
            {graph.length ? `グラフ化したメトリクス (${graph.length})` : '無題のグラフ'}
          </Header>
        }
      >
        <div data-testid="metrics-graph">
          {graph.length ? (
            <Graph
              series={graph.map((g) => ({ label: seriesLabel(env, g), data: getMetricData(env, g, { start: now - r.ms, end: now, period: period || r.period, stat: stat === 'default' ? (metricInfo(g)?.stat ?? 'Average') : stat }) }))}
              start={now - r.ms}
              end={now}
              unit={units.length === 1 ? units[0] : undefined}
              height={260}
            />
          ) : (
            <Box textAlign="center" color="text-body-secondary" padding={{ vertical: 'xxl' }}>下の「参照」タブでメトリクスを選択すると、ここにグラフが表示されます。</Box>
          )}
        </div>
      </Container>
      <Tabs
        activeTabId={tab}
        onChange={(e) => setTab(e.detail.activeTabId)}
        tabs={[
          {
            id: 'browse',
            label: '参照',
            content: nsInfo ? (
              <SpaceBetween size="s">
                <Box>
                  <ConsoleLink to={metricsPath(graph)}>すべて</ConsoleLink>
                  {` > ${nsInfo.label} > ${nsInfo.group}`}
                </Box>
                <ResourceTable<Row>
                  title={`${nsInfo.label} > ${nsInfo.group}`}
                  headerVariant="h2"
                  variant="container"
                  items={all.filter((m) => m.namespace === ns)}
                  trackBy={encodeGraph1}
                  selectionType="multi"
                  selectedItems={all.filter((m) => graph.some((g) => sameMetric(g, m)))}
                  onSelectionChange={(items) => setGraph([...graph.filter((g) => g.namespace !== ns), ...items])}
                  resourceName="メトリクス"
                  testId="metric-table"
                  columns={[
                    { id: 'resource', header: nsInfo.column, cell: (m) => m.resourceName || '-', value: (m) => m.resourceName },
                    { id: 'dim', header: all.find((m) => m.namespace === ns)?.dimensions[0].name ?? 'ディメンション', cell: (m) => m.dimensions[0].value, value: (m) => m.dimensions[0].value },
                    { id: 'metric', header: 'メトリクス名', cell: (m) => m.metricName, value: (m) => m.metricName },
                  ]}
                />
              </SpaceBetween>
            ) : (
              <Container header={<Header variant="h2" counter={`(${all.length})`}>AWS 名前空間</Header>}>
                <ColumnLayout columns={3}>
                  {NAMESPACES.map((n) => (
                    <div key={n.ns}>
                      <ConsoleLink to={metricsPath(graph, n.ns)}>{n.label}</ConsoleLink>
                      <Box variant="small" color="text-body-secondary">{`${all.filter((m) => m.namespace === n.ns).length} 個のメトリクス`}</Box>
                    </div>
                  ))}
                </ColumnLayout>
              </Container>
            ),
          },
          {
            id: 'graphed',
            label: `グラフ化したメトリクス (${graph.length})`,
            content: (
              <Table
                variant="container"
                items={graph}
                empty="グラフ化したメトリクスはありません"
                columnDefinitions={[
                  { id: 'label', header: 'ラベル', cell: (g) => seriesLabel(env, g) },
                  { id: 'details', header: '詳細', cell: (g) => `${g.namespace} • ${g.metricName} • ${g.dimensions[0].name}: ${g.dimensions[0].value}` },
                  { id: 'stat', header: '統計', cell: (g) => statLabel(stat === 'default' ? (metricInfo(g)?.stat ?? 'Average') : stat) },
                  { id: 'period', header: '期間', cell: () => periodLabel(period || r.period) },
                  {
                    id: 'actions',
                    header: 'アクション',
                    cell: (g) => (
                      <SpaceBetween direction="horizontal" size="xs">
                        <Button variant="inline-link" onClick={() => navigate(`/cloudwatch/alarms/create?${new URLSearchParams({ graph: encodeGraph([g]) })}`)}>アラームの作成</Button>
                        <Button variant="inline-link" onClick={() => setGraph(graph.filter((x) => !sameMetric(x, g)))}>削除</Button>
                      </SpaceBetween>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

const encodeGraph1 = (m: MetricRef) => encodeGraph([m]);

// ---------------- logs ----------------

const logGroupPath = (name: string) => `/cloudwatch/logs/group?${new URLSearchParams({ name })}`;
const eventsPath = (group: string, stream?: string, filter?: string) => `/cloudwatch/logs/events?${new URLSearchParams({ group, ...(stream ? { stream } : {}), ...(filter ? { filter } : {}) })}`;
const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${(b / 1e3).toFixed(1)} KB`);
const retentionText = (g: LogGroup) => (g.retentionInDays ? `${g.retentionInDays} 日` : '失効しない');

function EditRetentionModal({ g, onClose }: { g: LogGroup; onClose: () => void }) {
  const run = useConsole((s) => s.run);
  const [days, setDays] = useState(g.retentionInDays ? String(g.retentionInDays) : 'never');
  const [error, setError] = useState<AwsError | null>(null);
  const options = [{ value: 'never', label: '失効しない' }, ...RETENTION_DAYS.map((d) => ({ value: String(d), label: `${d} 日` }))];
  return (
    <Modal
      visible
      onDismiss={onClose}
      header="保持設定を編集"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>キャンセル</Button>
            <Button
              variant="primary"
              data-testid="retention-save"
              onClick={() => {
                const r = run((d) => putRetentionPolicy(d, g.logGroupName, days === 'never' ? undefined : Number(days)), `${g.logGroupName} の保持設定を変更しました`);
                if (r.ok) onClose();
                else setError(r.error);
              }}
            >
              保存
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <FormField label="イベントの有効期限" description="この期間を過ぎたログイベントは自動的に削除されます。保存料金は保存しているデータ量で決まります。" errorText={errorText(error)}>
        <Select selectedOption={options.find((o) => o.value === days)!} options={options} onChange={(e) => setDays(e.detail.selectedOption.value!)} data-testid="retention-select" />
      </FormField>
    </Modal>
  );
}

export function LogGroupList() {
  const env = useEnv();
  const now = useNow(60_000);
  return (
    <ResourceTable
      title="ロググループ"
      description="ロググループは、同じ保持、モニタリング、アクセス制御設定を共有するログストリームのグループです。"
      items={env.logGroups}
      trackBy={(g) => g.logGroupName}
      selectionType="none"
      resourceName="ロググループ"
      testId="log-group-table"
      columns={[
        { id: 'name', header: 'ロググループ', cell: (g) => <ConsoleLink to={logGroupPath(g.logGroupName)}>{g.logGroupName}</ConsoleLink>, value: (g) => g.logGroupName },
        { id: 'class', header: 'ログクラス', cell: () => 'スタンダード' },
        { id: 'retention', header: '保持', cell: retentionText },
        { id: 'bytes', header: '保存されたバイト数', cell: (g) => fmtBytes(storedBytes(env, g, now)) },
        { id: 'created', header: '作成時刻', cell: (g) => formatDate(g.creationTime), value: (g) => g.creationTime },
      ]}
    />
  );
}

export function LogGroupDetail({ name }: { name: string }) {
  const env = useEnv();
  const now = useNow(30_000);
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const g = env.logGroups.find((x) => x.logGroupName === name);
  if (!g) return <NotFound what="ロググループ" id={name} />;
  const streams = logStreams(env, g, now);
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Hotspot hotspotId="logs-retention" direction="right">
            <ActionMenu testId="log-group-actions" items={[{ id: 'retention', text: '保持設定を編集', onClick: () => setEditing(true) }]} />
          </Hotspot>
        }
      >
        {name}
      </Header>
      {editing && <EditRetentionModal g={g} onClose={() => setEditing(false)} />}
      <ResourceDetail
        title="ロググループの詳細"
        columns={3}
        fields={[
          { label: 'ログクラス', value: 'スタンダード' },
          { label: '保持', value: <span data-testid="log-retention">{retentionText(g)}</span> },
          { label: '作成時刻', value: formatDate(g.creationTime) },
          { label: '保存されたバイト数', value: fmtBytes(storedBytes(env, g, now)) },
          { label: 'KMS キー ID', value: '-' },
          { label: 'ARN', value: <CopyableValue value={g.arn} /> },
        ]}
      />
      <Table
        variant="container"
        data-testid="log-stream-table"
        header={
          <Header counter={`(${streams.length})`} actions={<Button onClick={() => navigate(eventsPath(name))} data-testid="search-all-streams">すべてのログストリームを検索</Button>}>
            ログストリーム
          </Header>
        }
        items={streams}
        empty="ログストリームはありません"
        columnDefinitions={[
          { id: 'name', header: 'ログストリーム', cell: (s) => <ConsoleLink to={eventsPath(name, s.logStreamName)}>{s.logStreamName}</ConsoleLink> },
          { id: 'last', header: '最後のイベントの時刻', cell: (s) => (s.lastEventTime ? formatDate(s.lastEventTime) : '-') },
        ]}
      />
    </SpaceBetween>
  );
}

const LOG_RANGES = [
  { id: 'all', text: 'すべて', ms: Infinity },
  { id: '30m', text: '30 分', ms: 30 * 60_000 },
  { id: '1h', text: '1 時間', ms: HOUR },
  { id: '3h', text: '3 時間', ms: 3 * HOUR },
  { id: '12h', text: '12 時間', ms: 12 * HOUR },
];

export function LogEvents() {
  const env = useEnv();
  const now = useNow(15_000);
  const navigate = useNavigate();
  const path = useConsole((s) => s.path);
  const group = queryParam(path, 'group') ?? '';
  const stream = queryParam(path, 'stream');
  const applied = queryParam(path, 'filter') ?? '';
  const [text, setText] = useState(applied);
  const g = env.logGroups.find((x) => x.logGroupName === group);
  // events a service wrote (Lambda, Batch) are all shown by default; generated app logs start with the last hour
  const [rangeId, setRangeId] = useState(g?.source.kind === 'stored' ? 'all' : '1h');
  if (!g) return <NotFound what="ロググループ" id={group} />;
  const ms = LOG_RANGES.find((r) => r.id === rangeId)!.ms;
  const events = filterLogEvents(env, g, { start: Math.max(now - ms, g.creationTime), end: now, stream, pattern: applied, limit: 500 });
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={stream ? `ロググループ: ${group}` : 'すべてのログストリームのイベントを検索します。'}>
        {stream ? `ログイベント: ${stream}` : `${group} のログイベント`}
      </Header>
      <Table
        variant="full-page"
        data-testid="log-events"
        header={<Header counter={`(${events.length})`} description="新しいイベントほど下に表示されます (最大 500 件)。">ログイベント</Header>}
        filter={
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            {/* Enter handled here: a lesson hotspot next to the input would break implicit form submission */}
            <Hotspot hotspotId="cw-log-filter" direction="right">
              <div className="log-filter">
                <Input
                  type="search"
                  value={text}
                  onChange={(e) => setText(e.detail.value)}
                  onKeyDown={(e) => e.detail.key === 'Enter' && !e.detail.isComposing && navigate(eventsPath(group, stream, text.trim()))}
                  placeholder="イベントのフィルタリング - 用語、フレーズ、またはパターンを使用して検索"
                  ariaLabel="イベントのフィルタリング"
                  data-testid="log-filter"
                />
              </div>
            </Hotspot>
            <SegmentedControl label="時間範囲" selectedId={rangeId} onChange={(e) => setRangeId(e.detail.selectedId)} options={LOG_RANGES} />
          </SpaceBetween>
        }
        items={events}
        empty={<Box textAlign="center" color="inherit" padding="l"><b>イベントがありません</b><Box variant="p" color="inherit">この時間範囲に一致するイベントはありません。フィルターや時間範囲を変えてみましょう。</Box></Box>}
        columnDefinitions={[
          { id: 'time', header: 'タイムスタンプ', cell: (e) => formatDate(e.timestamp), width: 230 },
          ...(stream ? [] : [{ id: 'stream', header: 'ログストリーム', cell: (e: (typeof events)[number]) => e.logStreamName, width: 200 }]),
          { id: 'message', header: 'メッセージ', cell: (e) => <pre className="log-message">{e.message}</pre> },
        ]}
      />
    </SpaceBetween>
  );
}
