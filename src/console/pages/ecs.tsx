import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useState } from 'react';
import { getTaskDefinition, pendingCount, registerTaskDefinition, runningCount, serviceTasks, stopTask, tdLabel, updateService } from '../../sim/containers';
import { taskId } from '../../sim/targets';
import type { AwsError, EcsService, EcsTask } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, EditForm, formatDate, JsonBlock, NotFound, ResourceDetail, ResourceTable, ResourceTabs, useEnv, useNavigate } from '../ui';

const clusterName = (arn: string) => arn.split('/').pop()!;
const clusterPath = (name: string) => `/ecs/clusters/${name}`;
const servicePath = (cluster: string, svc: string) => `/ecs/clusters/${cluster}/services/${svc}`;
const taskPath = (t: EcsTask) => `/ecs/clusters/${clusterName(t.clusterArn)}/tasks/${taskId(t)}`;
const tdPath = (arn: string) => `/ecs/task-definitions/${tdLabel(arn).replace(':', '/')}`;
const mb = (b: number) => `${(b / 1_000_000).toFixed(2)}`;

const TASK_STATUS: Record<string, [string, 'success' | 'in-progress' | 'stopped' | 'pending']> = {
  PROVISIONING: ['プロビジョニング中', 'pending'],
  PENDING: ['保留中', 'pending'],
  RUNNING: ['実行中', 'success'],
  DEPROVISIONING: ['プロビジョニング解除中', 'in-progress'],
  STOPPED: ['停止済み', 'stopped'],
};
export const TaskStatus = ({ s }: { s: string }) => <StatusIndicator type={TASK_STATUS[s]?.[1] ?? 'pending'}>{TASK_STATUS[s]?.[0] ?? s}</StatusIndicator>;

// ---------------- ECR ----------------

export function RepositoryList() {
  const env = useEnv();
  return (
    <ResourceTable
      title="プライベートリポジトリ"
      resourceName="リポジトリ"
      testId="ecr-repos"
      items={env.ecrRepositories}
      trackBy={(r) => r.repositoryName}
      selectionType="none"
      columns={[
        { id: 'name', header: 'リポジトリ名', cell: (r) => <ConsoleLink to={`/ecr/repositories/${r.repositoryName}`}>{r.repositoryName}</ConsoleLink>, value: (r) => r.repositoryName },
        { id: 'uri', header: 'URI', cell: (r) => <CopyableValue value={r.repositoryUri} /> },
        { id: 'created', header: '作成日時', cell: (r) => formatDate(r.createdAt) },
        { id: 'mut', header: 'タグのイミュータビリティ', cell: () => '変更可能' },
        { id: 'enc', header: '暗号化タイプ', cell: () => 'AES-256' },
      ]}
    />
  );
}

export function RepositoryDetail({ name }: { name: string }) {
  const env = useEnv();
  const r = env.ecrRepositories.find((x) => x.repositoryName === name);
  if (!r) return <NotFound what="リポジトリ" id={name} />;
  const images = [...r.images].sort((a, b) => b.pushedAt - a.pushedAt);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={r.repositoryUri}>{name}</Header>
      <ResourceTable
        title="イメージ"
        headerVariant="h2"
        variant="container"
        resourceName="イメージ"
        testId="ecr-images"
        items={images}
        trackBy={(i) => i.imageDigest}
        selectionType="none"
        columns={[
          { id: 'tag', header: 'イメージタグ', cell: (i) => i.imageTags.join(', ') || '<untagged>', value: (i) => i.imageTags.join(',') },
          { id: 'type', header: 'アーティファクトタイプ', cell: () => 'Image' },
          { id: 'pushed', header: 'プッシュされた日時', cell: (i) => formatDate(i.pushedAt), value: (i) => i.pushedAt },
          { id: 'size', header: 'サイズ (MB)', cell: (i) => mb(i.sizeInBytes) },
          { id: 'uri', header: 'イメージ URI', cell: (i) => (i.imageTags[0] ? <CopyableValue value={`${r.repositoryUri}:${i.imageTags[0]}`} iconOnly /> : '-') },
          { id: 'digest', header: 'ダイジェスト', cell: (i) => <Box variant="small">{`${i.imageDigest.slice(0, 19)}…`}</Box> },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------- clusters ----------------

export function ClusterList() {
  const env = useEnv();
  return (
    <ResourceTable
      title="クラスター"
      resourceName="クラスター"
      testId="ecs-clusters"
      items={env.ecsClusters}
      trackBy={(c) => c.clusterName}
      selectionType="none"
      columns={[
        { id: 'name', header: 'クラスター', cell: (c) => <ConsoleLink to={clusterPath(c.clusterName)}>{c.clusterName}</ConsoleLink>, value: (c) => c.clusterName },
        { id: 'svc', header: 'サービス', cell: (c) => String(env.ecsServices.filter((s) => s.clusterArn === c.clusterArn).length) },
        { id: 'tasks', header: 'タスク', cell: (c) => `${env.ecsTasks.filter((t) => t.clusterArn === c.clusterArn && t.lastStatus === 'RUNNING').length} 実行中` },
        { id: 'infra', header: 'インフラストラクチャ', cell: () => 'Fargate' },
      ]}
    />
  );
}

function TaskTable({ tasks, title }: { tasks: EcsTask[]; title: string }) {
  const run = useConsole((s) => s.run);
  const [show, setShow] = useState<'running' | 'stopped' | 'all'>('running');
  const shown = tasks.filter((t) => show === 'all' || (show === 'running' ? t.desiredStatus === 'RUNNING' : t.desiredStatus === 'STOPPED')).sort((a, b) => b.createdAt - a.createdAt);
  return (
    <Table
      variant="container"
      data-testid="ecs-tasks"
      wrapLines
      header={
        <Header counter={`(${shown.length})`} actions={<SegmentedControl label="必要なタスクのステータス" selectedId={show} onChange={(e) => setShow(e.detail.selectedId as typeof show)} options={[{ id: 'running', text: '実行中' }, { id: 'stopped', text: '停止済み' }, { id: 'all', text: 'すべて' }]} data-testid="task-filter" />}>
          {title}
        </Header>
      }
      items={shown}
      empty={show === 'stopped' ? '停止したタスクはありません' : 'タスクはありません'}
      columnDefinitions={[
        { id: 'id', header: 'タスク', cell: (t) => <ConsoleLink to={taskPath(t)}>{taskId(t)}</ConsoleLink> },
        { id: 'last', header: '最後のステータス', cell: (t) => <TaskStatus s={t.lastStatus} /> },
        { id: 'desired', header: '必要なステータス', cell: (t) => (t.desiredStatus === 'RUNNING' ? '実行中' : '停止済み') },
        { id: 'td', header: 'タスク定義', cell: (t) => <ConsoleLink to={tdPath(t.taskDefinitionArn)}>{tdLabel(t.taskDefinitionArn)}</ConsoleLink> },
        { id: 'started', header: '開始時刻', cell: (t) => (t.startedAt ? formatDate(t.startedAt) : '-') },
        { id: 'ip', header: 'プライベート IP', cell: (t) => t.privateIpAddress },
        { id: 'stop', header: '', cell: (t) => (t.desiredStatus === 'RUNNING' ? <Button variant="inline-link" onClick={() => run((d) => stopTask(d, t.taskArn), `タスク ${taskId(t)} を停止しています`)}>停止</Button> : '') },
      ]}
    />
  );
}

export function ClusterDetail({ name }: { name: string }) {
  const env = useEnv();
  const c = env.ecsClusters.find((x) => x.clusterName === name);
  if (!c) return <NotFound what="クラスター" id={name} />;
  const services = env.ecsServices.filter((s) => s.clusterArn === c.clusterArn);
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{name}</Header>
      <ResourceDetail title="クラスターの概要" columns={3} fields={[{ label: 'ARN', value: <CopyableValue value={c.clusterArn} /> }, { label: 'ステータス', value: <StatusIndicator>アクティブ</StatusIndicator> }, { label: 'サービス', value: String(services.length) }]} />
      <ResourceTabs
        tabs={[
          {
            id: 'services',
            label: 'サービス',
            content: (
              <Table
                variant="container"
                data-testid="ecs-services"
                header={<Header counter={`(${services.length})`}>サービス</Header>}
                items={services}
                columnDefinitions={[
                  { id: 'name', header: 'サービス名', cell: (s) => <ConsoleLink to={servicePath(name, s.serviceName)}>{s.serviceName}</ConsoleLink> },
                  { id: 'status', header: 'ステータス', cell: () => <StatusIndicator>アクティブ</StatusIndicator> },
                  { id: 'deploy', header: 'デプロイとタスク', cell: (s) => `${runningCount(env, s)}/${s.desiredCount} のタスクが実行中` },
                  { id: 'td', header: 'タスク定義', cell: (s) => tdLabel(s.taskDefinition) },
                  { id: 'type', header: '起動タイプ', cell: () => 'FARGATE' },
                ]}
              />
            ),
          },
          { id: 'tasks', label: 'タスク', content: <TaskTable title="タスク" tasks={env.ecsTasks.filter((t) => t.clusterArn === c.clusterArn)} /> },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------- services ----------------

const deploymentState = (s: EcsService) => (s.deployments[0].rolloutState === 'COMPLETED' ? <StatusIndicator type="success">完了</StatusIndicator> : <StatusIndicator type="in-progress">進行中</StatusIndicator>);

export function ServiceDetail({ cluster, name }: { cluster: string; name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const s = env.ecsServices.find((x) => clusterName(x.clusterArn) === cluster && x.serviceName === name);
  if (!s) return <NotFound what="サービス" id={name} />;
  const tg = env.targetGroups.find((t) => t.targetGroupArn === s.loadBalancers[0]?.targetGroupArn);
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Hotspot hotspotId="ecs-update-service" direction="right">
            <Button variant="primary" onClick={() => navigate(`${servicePath(cluster, name)}/update`)} data-testid="update-service">サービスを更新</Button>
          </Hotspot>
        }
      >
        {name}
      </Header>
      <Container header={<Header variant="h2">サービスの概要</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <div><Box variant="awsui-key-label">ステータス</Box><StatusIndicator>アクティブ</StatusIndicator></div>
          <div data-testid="service-counts"><Box variant="awsui-key-label">タスク</Box>{`${runningCount(env, s)} 実行中 / ${pendingCount(env, s)} 保留中 / ${s.desiredCount} 必要`}</div>
          <div><Box variant="awsui-key-label">タスク定義: リビジョン</Box><ConsoleLink to={tdPath(s.taskDefinition)}>{tdLabel(s.taskDefinition)}</ConsoleLink></div>
          <div><Box variant="awsui-key-label">デプロイ</Box><span data-testid="deployment-state">{deploymentState(s)}</span></div>
        </ColumnLayout>
      </Container>
      <ResourceTabs
        tabs={[
          { id: 'tasks', label: 'タスク', content: <TaskTable title="タスク" tasks={serviceTasks(env, s)} /> },
          {
            id: 'deployments',
            label: 'デプロイ',
            content: (
              <Table
                variant="container"
                data-testid="ecs-deployments"
                header={<Header counter={`(${s.deployments.length})`}>デプロイ</Header>}
                items={s.deployments}
                columnDefinitions={[
                  { id: 'id', header: 'デプロイ ID', cell: (d) => d.id },
                  { id: 'status', header: 'ステータス', cell: (d) => (d.status === 'PRIMARY' ? 'プライマリ' : 'アクティブ') },
                  { id: 'td', header: 'タスク定義', cell: (d) => tdLabel(d.taskDefinition) },
                  { id: 'running', header: '実行中', cell: (d) => String(serviceTasks(env, s).filter((t) => t.taskDefinitionArn === d.taskDefinition && t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING').length) },
                  { id: 'rollout', header: 'ロールアウトの状態', cell: (d) => (d.rolloutState === 'COMPLETED' ? '完了' : '進行中') },
                  { id: 'created', header: '作成日時', cell: (d) => formatDate(d.createdAt) },
                ]}
              />
            ),
          },
          {
            id: 'events',
            label: 'イベント',
            content: (
              <Table
                variant="container"
                data-testid="ecs-events"
                wrapLines
                header={<Header counter={`(${s.events.length})`}>イベント</Header>}
                items={s.events}
                columnDefinitions={[
                  { id: 'time', header: '開始時刻', cell: (e) => formatDate(e.createdAt), width: 220 },
                  { id: 'msg', header: 'メッセージ', cell: (e) => e.message },
                ]}
              />
            ),
          },
          {
            id: 'network',
            label: '設定とネットワーク',
            content: (
              <ResourceDetail
                title="ネットワーク設定"
                columns={2}
                fields={[
                  { label: 'サブネット', value: s.subnets.map((x) => env.subnets.find((y) => y.subnetId === x)?.tags.find((t) => t.key === 'Name')?.value ?? x).join(', ') },
                  { label: 'セキュリティグループ', value: s.securityGroups.map((g) => env.securityGroups.find((x) => x.groupId === g)?.groupName ?? g).join(', ') },
                  { label: 'パブリック IP の自動割り当て', value: s.assignPublicIp === 'ENABLED' ? 'オン' : 'オフ' },
                  { label: 'ターゲットグループ', value: tg ? <ConsoleLink to={`/ec2/target-groups/${tg.targetGroupName}`}>{`${tg.targetGroupName} (${s.loadBalancers[0].containerName}:${s.loadBalancers[0].containerPort})`}</ConsoleLink> : '-' },
                ]}
              />
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

export function UpdateService({ cluster, name }: { cluster: string; name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const s = env.ecsServices.find((x) => clusterName(x.clusterArn) === cluster && x.serviceName === name);
  const family = s ? getTaskDefinition(env, s.taskDefinition).family : '';
  const revisions = env.taskDefinitions.filter((d) => d.family === family && d.status === 'ACTIVE').sort((a, b) => b.revision - a.revision);
  const [td, setTd] = useState(revisions[0]?.taskDefinitionArn ?? '');
  const [desired, setDesired] = useState(String(s?.desiredCount ?? 1));
  const [force, setForce] = useState(false);
  const [error, setError] = useState<AwsError | null>(null);
  if (!s) return <NotFound what="サービス" id={name} />;
  return (
    <EditForm
      title={`${name} を更新`}
      submitText="更新"
      submitTestId="update-service-submit"
      submitHotspotId="ecs-update-submit"
      onCancel={() => navigate(servicePath(cluster, name))}
      error={error}
      onSubmit={() => {
        const r = run((d) => updateService(d, cluster, name, { taskDefinition: td, desiredCount: Number(desired), forceNewDeployment: force }), `サービス ${name} が更新されました`);
        if (r.ok) navigate(`${servicePath(cluster, name)}?tab=deployments`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">デプロイ設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="タスク定義のリビジョン" description="新しいリビジョンを選ぶと、ローリングアップデートで新しいタスクに置き換わります。">
            <Select selectedOption={td ? { value: td, label: tdLabel(td) } : null} options={revisions.map((d) => ({ value: d.taskDefinitionArn, label: tdLabel(d.taskDefinitionArn), description: d.containerDefinitions[0]?.image, tags: [d.taskDefinitionArn === s.taskDefinition ? '現在' : ''] }))} onChange={(e) => setTd(e.detail.selectedOption.value!)} data-testid="service-td" />
          </FormField>
          <FormField label="必要なタスク"><Input value={desired} onChange={(e) => setDesired(e.detail.value)} type="number" data-testid="service-desired" /></FormField>
          <Checkbox checked={force} onChange={(e) => setForce(e.detail.checked)} description="同じタスク定義でも、新しいタスクを起動して置き換えます。">新しいデプロイの強制</Checkbox>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- tasks ----------------

export function TaskDetail({ cluster, id }: { cluster: string; id: string }) {
  const env = useEnv();
  const t = env.ecsTasks.find((x) => clusterName(x.clusterArn) === cluster && taskId(x) === id);
  if (!t) return <NotFound what="タスク" id={id} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{id}</Header>
      {t.stoppedReason && (
        <div data-testid="stopped-reason">
          <Alert type={t.stopCode === 'TaskFailedToStart' || t.stopCode === 'EssentialContainerExited' ? 'error' : 'info'} header={`停止理由: ${t.stopCode ?? ''}`}>
            {t.stoppedReason}
          </Alert>
        </div>
      )}
      <ResourceDetail
        title="概要"
        columns={3}
        fields={[
          { label: '最後のステータス', value: <TaskStatus s={t.lastStatus} /> },
          { label: '必要なステータス', value: t.desiredStatus === 'RUNNING' ? '実行中' : '停止済み' },
          { label: 'タスク定義: リビジョン', value: <ConsoleLink to={tdPath(t.taskDefinitionArn)}>{tdLabel(t.taskDefinitionArn)}</ConsoleLink> },
          { label: 'グループ', value: t.group },
          { label: '起動タイプ', value: 'FARGATE' },
          { label: 'ARN', value: <CopyableValue value={t.taskArn} iconOnly /> },
          { label: 'プライベート IP', value: t.privateIpAddress },
          { label: 'アベイラビリティーゾーン', value: t.availabilityZone },
          { label: '作成日時', value: formatDate(t.createdAt) },
        ]}
      />
      <Table
        variant="container"
        data-testid="task-containers"
        wrapLines
        header={<Header>コンテナ</Header>}
        items={t.containers}
        columnDefinitions={[
          { id: 'name', header: 'コンテナ名', cell: (c) => c.name },
          { id: 'image', header: 'イメージ URI', cell: (c) => c.image },
          { id: 'status', header: 'ステータス', cell: (c) => <TaskStatus s={c.lastStatus} /> },
          { id: 'reason', header: '理由', cell: (c) => c.reason ?? '-' },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------- task definitions ----------------

export function TaskDefinitionList() {
  const env = useEnv();
  const families = [...new Set(env.taskDefinitions.map((d) => d.family))].map((f) => ({ family: f, latest: Math.max(...env.taskDefinitions.filter((d) => d.family === f).map((d) => d.revision)) }));
  return (
    <ResourceTable
      title="タスク定義"
      resourceName="タスク定義"
      testId="task-definitions"
      items={families}
      trackBy={(f) => f.family}
      selectionType="none"
      columns={[
        { id: 'family', header: 'タスク定義', cell: (f) => <ConsoleLink to={`/ecs/task-definitions/${f.family}`}>{f.family}</ConsoleLink>, value: (f) => f.family },
        { id: 'latest', header: '最新のリビジョン', cell: (f) => <ConsoleLink to={`/ecs/task-definitions/${f.family}/${f.latest}`}>{`${f.family}:${f.latest}`}</ConsoleLink> },
        { id: 'status', header: '最新リビジョンのステータス', cell: () => 'ACTIVE' },
      ]}
    />
  );
}

export function TaskDefinitionFamily({ family }: { family: string }) {
  const env = useEnv();
  const revisions = env.taskDefinitions.filter((d) => d.family === family).sort((a, b) => b.revision - a.revision);
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{family}</Header>
      <Table
        variant="container"
        header={<Header counter={`(${revisions.length})`}>リビジョン</Header>}
        items={revisions}
        columnDefinitions={[
          { id: 'rev', header: 'タスク定義: リビジョン', cell: (d) => <ConsoleLink to={`/ecs/task-definitions/${family}/${d.revision}`}>{`${family}:${d.revision}`}</ConsoleLink> },
          { id: 'image', header: 'イメージ', cell: (d) => d.containerDefinitions[0]?.image },
          { id: 'status', header: 'ステータス', cell: (d) => d.status },
          { id: 'created', header: '作成日時', cell: (d) => formatDate(d.registeredAt) },
        ]}
      />
    </SpaceBetween>
  );
}

export function TaskDefinitionDetail({ family, revision }: { family: string; revision: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const d = env.taskDefinitions.find((x) => x.family === family && String(x.revision) === revision);
  if (!d) return <NotFound what="タスク定義" id={`${family}:${revision}`} />;
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Hotspot hotspotId="ecs-new-revision" direction="right">
            <Button onClick={() => navigate(`/ecs/task-definitions/${family}/${revision}/new-revision`)} data-testid="new-revision">新しいリビジョンの作成</Button>
          </Hotspot>
        }
      >
        {`${family}:${revision}`}
      </Header>
      <ResourceDetail
        title="概要"
        columns={3}
        fields={[
          { label: 'ARN', value: <CopyableValue value={d.taskDefinitionArn} iconOnly /> },
          { label: 'ステータス', value: d.status },
          { label: '起動タイプ', value: 'FARGATE' },
          { label: 'タスクサイズ', value: `${Number(d.cpu) / 1024} vCPU / ${Number(d.memory) / 1024} GB` },
          { label: 'タスク実行ロール', value: d.executionRoleArn?.split('/').pop() },
          { label: 'ネットワークモード', value: d.networkMode },
        ]}
      />
      <Table
        variant="container"
        data-testid="td-containers"
        header={<Header>コンテナ</Header>}
        items={d.containerDefinitions}
        columnDefinitions={[
          { id: 'name', header: 'コンテナ名', cell: (c) => c.name },
          { id: 'image', header: 'イメージ', cell: (c) => c.image },
          { id: 'port', header: 'ポートマッピング', cell: (c) => c.portMappings.map((p) => `${p.containerPort}/${p.protocol}`).join(', ') },
          { id: 'essential', header: '必須コンテナ', cell: (c) => (c.essential ? 'はい' : 'いいえ') },
        ]}
      />
      <Container header={<Header variant="h2">JSON</Header>}>
        <JsonBlock value={{ family: d.family, revision: d.revision, containerDefinitions: d.containerDefinitions, cpu: d.cpu, memory: d.memory, networkMode: d.networkMode, requiresCompatibilities: d.requiresCompatibilities, executionRoleArn: d.executionRoleArn }} />
      </Container>
    </SpaceBetween>
  );
}

export function NewRevision({ family, revision }: { family: string; revision: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const d = env.taskDefinitions.find((x) => x.family === family && String(x.revision) === revision);
  const [image, setImage] = useState(d?.containerDefinitions[0]?.image ?? '');
  const [port, setPort] = useState(String(d?.containerDefinitions[0]?.portMappings[0]?.containerPort ?? 80));
  const [cpu, setCpu] = useState(d?.cpu ?? '256');
  const [memory, setMemory] = useState(d?.memory ?? '512');
  const [error, setError] = useState<AwsError | null>(null);
  if (!d) return <NotFound what="タスク定義" id={`${family}:${revision}`} />;
  const c = d.containerDefinitions[0];
  return (
    <EditForm
      title="新しいタスク定義のリビジョンを作成"
      description={`${family}:${revision} をもとに、新しいリビジョンを作成します。既存のリビジョンは変更されません。`}
      submitText="作成"
      submitTestId="revision-submit"
      submitHotspotId="ecs-revision-submit"
      onCancel={() => navigate(`/ecs/task-definitions/${family}/${revision}`)}
      error={error}
      onSubmit={() => {
        const r = run((x) => registerTaskDefinition(x, { family, cpu, memory, executionRoleArn: d.executionRoleArn, taskRoleArn: d.taskRoleArn, containerDefinitions: [{ ...c, image, portMappings: [{ containerPort: Number(port), protocol: 'tcp' }] }, ...d.containerDefinitions.slice(1)] }), (arn) => `タスク定義 ${tdLabel(arn)} が正常に作成されました`);
        if (r.ok) navigate(tdPath(r.value));
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">インフラストラクチャの要件</Header>}>
        <ColumnLayout columns={2}>
          <FormField label="CPU"><Select selectedOption={{ value: cpu, label: `${Number(cpu) / 1024} vCPU` }} options={['256', '512', '1024'].map((v) => ({ value: v, label: `${Number(v) / 1024} vCPU` }))} onChange={(e) => setCpu(e.detail.selectedOption.value!)} /></FormField>
          <FormField label="メモリ"><Select selectedOption={{ value: memory, label: `${Number(memory) / 1024} GB` }} options={['512', '1024', '2048'].map((v) => ({ value: v, label: `${Number(v) / 1024} GB` }))} onChange={(e) => setMemory(e.detail.selectedOption.value!)} /></FormField>
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">{`コンテナ - 1: ${c.name}`}</Header>}>
        <SpaceBetween size="m">
          <FormField label="イメージ URI" description="リポジトリ URI とタグ (例: 123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/webapp:v1)。">
            <Input value={image} onChange={(e) => setImage(e.detail.value)} data-testid="revision-image" />
          </FormField>
          <FormField label="コンテナポート"><Input value={port} onChange={(e) => setPort(e.detail.value)} type="number" /></FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}
