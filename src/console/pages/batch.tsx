import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Wizard from '@cloudscape-design/components/wizard';
import { useState } from 'react';
import { nextTriggers, putRule, setRuleState, submitJob } from '../../sim/batch';
import type { AwsError, BatchJob, BatchJobStatus } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, EditForm, errorText, formatDate, NotFound, ResourceDetail, ResourceTable, useEnv, useNavigate } from '../ui';
import { useNow } from './cloudwatch';

const jobPath = (j: BatchJob) => `/batch/jobs/${j.jobId}`;
const rulePath = (name: string) => `/events/rules/${name}`;
const JOB_STATUS: Record<BatchJobStatus, 'success' | 'error' | 'in-progress' | 'pending'> = { SUBMITTED: 'pending', PENDING: 'pending', RUNNABLE: 'pending', STARTING: 'in-progress', RUNNING: 'in-progress', SUCCEEDED: 'success', FAILED: 'error' };
export const JobStatus = ({ s }: { s: BatchJobStatus }) => <StatusIndicator type={JOB_STATUS[s]}>{s}</StatusIndicator>;
const utcAndJst = (t: number) => `${new Date(t).toISOString().replace('T', ' ').slice(0, 16)} UTC (${formatDate(t)})`;

// ---------------- Batch ----------------

export function JobList() {
  const env = useEnv();
  const navigate = useNavigate();
  useNow(2000);
  const jobs = [...env.batchJobs].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <ResourceTable
      title="ジョブ"
      resourceName="ジョブ"
      testId="batch-jobs"
      items={jobs}
      trackBy={(j) => j.jobId}
      selectionType="none"
      actions={
        <Hotspot hotspotId="batch-submit" direction="right">
          <Button variant="primary" onClick={() => navigate('/batch/jobs/submit')} data-testid="submit-job">新しいジョブを送信</Button>
        </Hotspot>
      }
      columns={[
        { id: 'name', header: 'ジョブ名', cell: (j) => <ConsoleLink to={jobPath(j)}>{j.jobName}</ConsoleLink>, value: (j) => j.jobName },
        { id: 'status', header: 'ステータス', cell: (j) => <JobStatus s={j.status} />, value: (j) => j.status },
        { id: 'queue', header: 'ジョブキュー', cell: (j) => j.jobQueue.split('/').pop() },
        { id: 'created', header: '作成日時', cell: (j) => formatDate(j.createdAt), value: (j) => j.createdAt },
        { id: 'duration', header: '所要時間', cell: (j) => (j.startedAt && j.stoppedAt ? `${((j.stoppedAt - j.startedAt) / 1000).toFixed(0)} 秒` : '-') },
        { id: 'by', header: '送信元', cell: (j) => j.submittedBy },
      ]}
    />
  );
}

export function JobDetail({ id }: { id: string }) {
  const env = useEnv();
  useNow(2000);
  const j = env.batchJobs.find((x) => x.jobId === id);
  if (!j) return <NotFound what="ジョブ" id={id} />;
  const d = env.jobDefinitions.find((x) => x.jobDefinitionArn === j.jobDefinition);
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{j.jobName}</Header>
      {j.status === 'FAILED' && (
        <div data-testid="job-failed">
          <Alert type="error" header="ジョブが失敗しました">{`ステータスの理由: ${j.statusReason} (終了コード ${j.exitCode})。原因はログストリームで確認できます。`}</Alert>
        </div>
      )}
      <ResourceDetail
        title="ジョブの詳細"
        columns={3}
        fields={[
          { label: 'ステータス', value: <span data-testid="job-status"><JobStatus s={j.status} /></span> },
          { label: 'ステータスの理由', value: j.statusReason },
          { label: '終了コード', value: j.exitCode === undefined ? '-' : String(j.exitCode) },
          { label: 'ジョブ ID', value: <CopyableValue value={j.jobId} iconOnly /> },
          { label: 'ジョブキュー', value: j.jobQueue.split('/').pop() },
          { label: 'ジョブ定義', value: d ? `${d.jobDefinitionName}:${d.revision}` : j.jobDefinition },
          { label: '作成日時', value: formatDate(j.createdAt) },
          { label: '開始日時', value: j.startedAt ? formatDate(j.startedAt) : '-' },
          { label: '停止日時', value: j.stoppedAt ? formatDate(j.stoppedAt) : '-' },
          { label: 'ジョブロール', value: d?.jobRoleArn ? <ConsoleLink to={`/iam/roles/${d.jobRoleArn.split('/').pop()}`}>{d.jobRoleArn.split('/').pop()}</ConsoleLink> : '-' },
          { label: '送信元', value: j.submittedBy },
          {
            label: 'ログストリーム名',
            value: j.logStreamName ? <ConsoleLink to={`/cloudwatch/logs/events?${new URLSearchParams({ group: '/aws/batch/job', stream: j.logStreamName })}`} testId="job-log-link">{j.logStreamName}</ConsoleLink> : '-',
          },
        ]}
      />
    </SpaceBetween>
  );
}

export function SubmitJob() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [def, setDef] = useState(env.jobDefinitions[0] ? `${env.jobDefinitions[0].jobDefinitionName}:${env.jobDefinitions[0].revision}` : '');
  const [queue, setQueue] = useState(env.jobQueues[0]?.jobQueueName ?? '');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="ジョブを送信"
      submitText="ジョブを送信"
      submitTestId="submit-job-submit"
      submitHotspotId="batch-submit-submit"
      onCancel={() => navigate('/batch/jobs')}
      error={error}
      onSubmit={() => {
        const r = run((d) => submitJob(d, { jobName: name, jobQueue: queue, jobDefinition: def }, 'learner'), `ジョブ ${name.trim()} が送信されました`);
        if (r.ok) navigate(`/batch/jobs/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">ジョブの設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="名前"><Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="job-name" /></FormField>
          <FormField label="ジョブ定義"><Select selectedOption={def ? { value: def, label: def } : null} options={env.jobDefinitions.map((d) => ({ value: `${d.jobDefinitionName}:${d.revision}`, label: `${d.jobDefinitionName}:${d.revision}`, description: d.image }))} onChange={(e) => setDef(e.detail.selectedOption.value!)} /></FormField>
          <FormField label="ジョブキュー"><Select selectedOption={queue ? { value: queue, label: queue } : null} options={env.jobQueues.map((q) => ({ value: q.jobQueueName, label: q.jobQueueName }))} onChange={(e) => setQueue(e.detail.selectedOption.value!)} /></FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function JobQueueList() {
  const env = useEnv();
  return (
    <ResourceTable
      title="ジョブキュー"
      resourceName="ジョブキュー"
      items={env.jobQueues}
      trackBy={(q) => q.jobQueueName}
      selectionType="none"
      columns={[
        { id: 'name', header: '名前', cell: (q) => q.jobQueueName, value: (q) => q.jobQueueName },
        { id: 'state', header: '状態', cell: (q) => q.state },
        { id: 'prio', header: '優先度', cell: (q) => String(q.priority) },
        { id: 'ce', header: 'コンピューティング環境', cell: (q) => q.computeEnvironmentOrder.map((a) => a.split('/').pop()).join(', ') },
      ]}
    />
  );
}

export function ComputeEnvironmentList() {
  const env = useEnv();
  return (
    <ResourceTable
      title="コンピューティング環境"
      resourceName="コンピューティング環境"
      items={env.computeEnvironments}
      trackBy={(c) => c.computeEnvironmentName}
      selectionType="none"
      columns={[
        { id: 'name', header: '名前', cell: (c) => c.computeEnvironmentName, value: (c) => c.computeEnvironmentName },
        { id: 'type', header: 'プロビジョニングモデル', cell: (c) => c.resourceType },
        { id: 'max', header: '最大 vCPU', cell: (c) => String(c.maxvCpus) },
        { id: 'status', header: 'ステータス', cell: (c) => <StatusIndicator>{c.status}</StatusIndicator> },
      ]}
    />
  );
}

export function JobDefinitionList() {
  const env = useEnv();
  return (
    <ResourceTable
      title="ジョブ定義"
      resourceName="ジョブ定義"
      items={env.jobDefinitions}
      trackBy={(d) => d.jobDefinitionArn}
      selectionType="none"
      columns={[
        { id: 'name', header: '名前', cell: (d) => `${d.jobDefinitionName}:${d.revision}`, value: (d) => d.jobDefinitionName },
        { id: 'image', header: 'イメージ', cell: (d) => d.image },
        { id: 'cmd', header: 'コマンド', cell: (d) => <Box variant="code">{d.command.join(' ')}</Box> },
        { id: 'role', header: 'ジョブロール', cell: (d) => d.jobRoleArn?.split('/').pop() ?? '-' },
      ]}
    />
  );
}

// ---------------- EventBridge ----------------

export function RuleList() {
  const env = useEnv();
  const navigate = useNavigate();
  return (
    <ResourceTable
      title="ルール"
      resourceName="ルール"
      testId="event-rules"
      items={env.eventRules}
      trackBy={(r) => r.name}
      selectionType="none"
      actions={
        <Hotspot hotspotId="events-create-rule" direction="right">
          <Button variant="primary" onClick={() => navigate('/events/rules/create')} data-testid="create-rule">ルールを作成</Button>
        </Hotspot>
      }
      columns={[
        { id: 'name', header: '名前', cell: (r) => <ConsoleLink to={rulePath(r.name)}>{r.name}</ConsoleLink>, value: (r) => r.name },
        { id: 'state', header: 'ステータス', cell: (r) => (r.state === 'ENABLED' ? <StatusIndicator>有効</StatusIndicator> : <StatusIndicator type="stopped">無効</StatusIndicator>) },
        { id: 'type', header: 'タイプ', cell: () => 'スケジュール' },
        { id: 'desc', header: '説明', cell: (r) => r.description ?? '-' },
      ]}
    />
  );
}

export function RuleDetail({ name }: { name: string }) {
  const env = useEnv();
  const now = useNow(5000);
  const run = useConsole((s) => s.run);
  const r = env.eventRules.find((x) => x.name === name);
  if (!r) return <NotFound what="ルール" id={name} />;
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Hotspot hotspotId="events-toggle" direction="right">
            <Button onClick={() => run((d) => setRuleState(d, name, r.state !== 'ENABLED'), `ルール ${name} を${r.state === 'ENABLED' ? '無効' : '有効'}にしました`)} data-testid="toggle-rule">{r.state === 'ENABLED' ? '無効にする' : '有効にする'}</Button>
          </Hotspot>
        }
      >
        {name}
      </Header>
      <ResourceDetail
        title="ルールの詳細"
        columns={3}
        fields={[
          { label: 'ルール名', value: name },
          { label: 'ステータス', value: <span data-testid="rule-state">{r.state === 'ENABLED' ? <StatusIndicator>有効</StatusIndicator> : <StatusIndicator type="stopped">無効</StatusIndicator>}</span> },
          { label: 'イベントバス', value: 'default' },
          { label: 'スケジュール式', value: <Box variant="code" data-testid="schedule-expression">{r.scheduleExpression}</Box> },
          { label: '説明', value: r.description },
          { label: 'ARN', value: <CopyableValue value={r.arn} iconOnly /> },
        ]}
      />
      <Container header={<Header variant="h2" description="cron 式は UTC で評価されます。">次の 3 回のトリガー</Header>}>
        <SpaceBetween size="xxs">{r.state === 'ENABLED' ? nextTriggers(r, now, 3).map((t) => <Box key={t}>{utcAndJst(t)}</Box>) : <Box color="text-body-secondary">ルールは無効です</Box>}</SpaceBetween>
      </Container>
      <Table
        variant="container"
        header={<Header counter={`(${r.targets.length})`}>ターゲット</Header>}
        items={r.targets}
        columnDefinitions={[
          { id: 'type', header: 'タイプ', cell: () => 'Batch ジョブキュー' },
          { id: 'arn', header: 'ARN', cell: (t) => t.arn },
          { id: 'def', header: 'ジョブ定義', cell: (t) => t.jobDefinition },
          { id: 'job', header: 'ジョブ名', cell: (t) => t.jobName },
        ]}
      />
    </SpaceBetween>
  );
}

export function CreateRule() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<'rate' | 'cron'>('rate');
  const [rate, setRate] = useState('5');
  const [unit, setUnit] = useState('minutes');
  const [cron, setCron] = useState('0 17 * * ? *');
  const [queue, setQueue] = useState(env.jobQueues[0]?.jobQueueName ?? '');
  const [def, setDef] = useState(env.jobDefinitions[0] ? `${env.jobDefinitions[0].jobDefinitionName}:${env.jobDefinitions[0].revision}` : '');
  const [jobName, setJobName] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const expression = kind === 'rate' ? `rate(${rate} ${unit})` : `cron(${cron})`;
  const err = errorText(error);
  return (
    <div data-testid="create-rule-wizard">
      <Wizard
        activeStepIndex={step}
        onNavigate={(e) => setStep(e.detail.requestedStepIndex)}
        onCancel={() => navigate('/events/rules')}
        onSubmit={() => {
          const r = run((d) => putRule(d, { name, description: desc || undefined, scheduleExpression: expression, target: { jobQueue: queue, jobDefinition: def, jobName: jobName || name } }), `ルール ${name.trim()} が作成されました`);
          if (r.ok) navigate(rulePath(name.trim()));
          else setError(r.error);
        }}
        i18nStrings={{ stepNumberLabel: (n) => `ステップ ${n}`, collapsedStepsLabel: (n, t) => `ステップ ${n}/${t}`, navigationAriaLabel: 'ステップ', cancelButton: 'キャンセル', previousButton: '前へ', nextButton: '次へ', submitButton: 'ルールの作成', optional: 'オプション' }}
        submitButtonText="ルールの作成"
        steps={[
          {
            title: 'ルールの詳細を定義',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">ルールの詳細</Header>}>
                <SpaceBetween size="m">
                  <FormField label="名前"><Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="rule-name" /></FormField>
                  <FormField label="説明 - オプション"><Input value={desc} onChange={(e) => setDesc(e.detail.value)} /></FormField>
                  <FormField label="イベントバス"><Select selectedOption={{ value: 'default', label: 'default' }} options={[{ value: 'default', label: 'default' }]} disabled /></FormField>
                  <FormField label="ルールタイプ"><RadioGroup value="schedule" items={[{ value: 'pattern', label: 'イベントパターンを持つルール', disabled: true, description: 'このシミュレーターでは未提供' }, { value: 'schedule', label: 'スケジュール', description: '一定の間隔、または特定の時刻に実行します。' }]} /></FormField>
                  <Alert type="info">新しいスケジュールには EventBridge Scheduler の利用が推奨されています。このシミュレーターでは、スケジュールルールで学習します。</Alert>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: 'スケジュールを定義',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">スケジュールパターン</Header>}>
                <SpaceBetween size="m">
                  <RadioGroup value={kind} onChange={(e) => setKind(e.detail.value as typeof kind)} items={[{ value: 'rate', label: '一定の間隔で実行されるスケジュール (rate)' }, { value: 'cron', label: '特定の時刻に実行されるきめ細かなスケジュール (cron) - 時刻は UTC' }]} data-testid="schedule-kind" />
                  {kind === 'rate' ? (
                    <SpaceBetween direction="horizontal" size="xs">
                      <Input value={rate} onChange={(e) => setRate(e.detail.value)} type="number" data-testid="rate-value" />
                      <Select selectedOption={{ value: unit, label: unit }} options={['minute', 'minutes', 'hour', 'hours', 'day', 'days'].map((u) => ({ value: u, label: u }))} onChange={(e) => setUnit(e.detail.selectedOption.value!)} data-testid="rate-unit" />
                    </SpaceBetween>
                  ) : (
                    <FormField label="cron 式" description="分 時 日 月 曜日 年 (UTC)。例: 0 17 * * ? * = 毎日 02:00 (JST)"><Input value={cron} onChange={(e) => setCron(e.detail.value)} data-testid="cron-value" /></FormField>
                  )}
                  <Box variant="code">{expression}</Box>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: 'ターゲットを選択',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">ターゲット 1</Header>}>
                <SpaceBetween size="m">
                  <FormField label="ターゲットタイプ"><Select selectedOption={{ value: 'batch', label: 'Batch ジョブキュー' }} options={[{ value: 'batch', label: 'Batch ジョブキュー' }]} disabled /></FormField>
                  <FormField label="ジョブキュー"><Select selectedOption={queue ? { value: queue, label: queue } : null} options={env.jobQueues.map((q) => ({ value: q.jobQueueName, label: q.jobQueueName }))} onChange={(e) => setQueue(e.detail.selectedOption.value!)} /></FormField>
                  <FormField label="ジョブ定義"><Select selectedOption={def ? { value: def, label: def } : null} options={env.jobDefinitions.map((d) => ({ value: `${d.jobDefinitionName}:${d.revision}`, label: `${d.jobDefinitionName}:${d.revision}` }))} onChange={(e) => setDef(e.detail.selectedOption.value!)} /></FormField>
                  <FormField label="ジョブ名"><Input value={jobName} onChange={(e) => setJobName(e.detail.value)} placeholder={name || 'ジョブ名'} /></FormField>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: '確認と作成',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">確認</Header>}>
                <ColumnLayout columns={2} variant="text-grid">
                  <div><Box variant="awsui-key-label">名前</Box>{name || '-'}</div>
                  <div><Box variant="awsui-key-label">スケジュール式</Box>{expression}</div>
                  <div><Box variant="awsui-key-label">ターゲット</Box>{`Batch ジョブキュー ${queue}`}</div>
                  <div><Box variant="awsui-key-label">ジョブ定義</Box>{def}</div>
                </ColumnLayout>
              </Container>
            ),
          },
        ]}
      />
    </div>
  );
}
