import type { ConsoleRoute, Crumb } from '../routes';
import { ComputeEnvironmentList, CreateRule, JobDefinitionList, JobDetail, JobList, JobQueueList, RuleDetail, RuleList, SubmitJob } from './batch';
import { EditEnvironment, FunctionDetail, FunctionList, QueueDetail, QueueList, SendReceive } from './serverless';
import { ClusterDetail, ClusterList, NewRevision, RepositoryDetail, RepositoryList, ServiceDetail, TaskDefinitionDetail, TaskDefinitionFamily, TaskDefinitionList, TaskDetail, UpdateService } from './ecs';

const ECR: Crumb = { text: 'Amazon ECR', href: '/ecr/repositories' };
const REPOS: Crumb = { text: 'プライベートリポジトリ', href: '/ecr/repositories' };
const ECS: Crumb = { text: 'Amazon Elastic Container Service', href: '/ecs/clusters' };
const CLUSTERS: Crumb = { text: 'クラスター', href: '/ecs/clusters' };
const TDS: Crumb = { text: 'タスク定義', href: '/ecs/task-definitions' };
const SQS: Crumb = { text: 'Amazon SQS', href: '/sqs/queues' };
const QUEUES: Crumb = { text: 'キュー', href: '/sqs/queues' };
const LAMBDA: Crumb = { text: 'Lambda', href: '/lambda/functions' };
const FUNCS: Crumb = { text: '関数', href: '/lambda/functions' };
const BATCH: Crumb = { text: 'AWS Batch', href: '/batch/jobs' };
const JOBS: Crumb = { text: 'ジョブ', href: '/batch/jobs' };
const EVENTS: Crumb = { text: 'Amazon EventBridge', href: '/events/rules' };
const RULES: Crumb = { text: 'ルール', href: '/events/rules' };
const here = (text: string): Crumb => ({ text, href: '' });
const cluster = (name: string): Crumb => ({ text: name, href: `/ecs/clusters/${name}` });
const service = (c: string, s: string): Crumb => ({ text: s, href: `/ecs/clusters/${c}/services/${s}` });

export const CONTAINER_ROUTES: ConsoleRoute[] = [
  { pattern: '/ecr/repositories', service: 'ecr', contentType: 'table', crumbs: () => [ECR, here('プライベートリポジトリ')], render: () => <RepositoryList /> },
  { pattern: '/ecr/repositories/:name', service: 'ecr', crumbs: (p) => [ECR, REPOS, here(p.name)], render: (p) => <RepositoryDetail name={p.name} key={p.name} /> },
  { pattern: '/ecs/clusters', service: 'ecs', contentType: 'table', crumbs: () => [ECS, here('クラスター')], render: () => <ClusterList /> },
  { pattern: '/ecs/clusters/:cluster', service: 'ecs', crumbs: (p) => [ECS, CLUSTERS, here(p.cluster)], render: (p) => <ClusterDetail name={p.cluster} key={p.cluster} /> },
  { pattern: '/ecs/clusters/:cluster/services/:svc', service: 'ecs', crumbs: (p) => [ECS, CLUSTERS, cluster(p.cluster), here(p.svc)], render: (p) => <ServiceDetail cluster={p.cluster} name={p.svc} key={p.svc} /> },
  { pattern: '/ecs/clusters/:cluster/services/:svc/update', service: 'ecs', contentType: 'form', crumbs: (p) => [ECS, CLUSTERS, cluster(p.cluster), service(p.cluster, p.svc), here('サービスを更新')], render: (p) => <UpdateService cluster={p.cluster} name={p.svc} key={p.svc} /> },
  { pattern: '/ecs/clusters/:cluster/tasks/:id', service: 'ecs', crumbs: (p) => [ECS, CLUSTERS, cluster(p.cluster), here(p.id)], render: (p) => <TaskDetail cluster={p.cluster} id={p.id} key={p.id} /> },
  { pattern: '/ecs/task-definitions', service: 'ecs', contentType: 'table', crumbs: () => [ECS, here('タスク定義')], render: () => <TaskDefinitionList /> },
  { pattern: '/ecs/task-definitions/:family', service: 'ecs', crumbs: (p) => [ECS, TDS, here(p.family)], render: (p) => <TaskDefinitionFamily family={p.family} key={p.family} /> },
  { pattern: '/ecs/task-definitions/:family/:rev', service: 'ecs', crumbs: (p) => [ECS, TDS, { text: p.family, href: `/ecs/task-definitions/${p.family}` }, here(`${p.family}:${p.rev}`)], render: (p) => <TaskDefinitionDetail family={p.family} revision={p.rev} key={`${p.family}:${p.rev}`} /> },
  { pattern: '/ecs/task-definitions/:family/:rev/new-revision', service: 'ecs', contentType: 'form', crumbs: (p) => [ECS, TDS, { text: p.family, href: `/ecs/task-definitions/${p.family}` }, here('新しいリビジョンの作成')], render: (p) => <NewRevision family={p.family} revision={p.rev} key={`${p.family}:${p.rev}`} /> },
  { pattern: '/sqs/queues', service: 'sqs', contentType: 'table', crumbs: () => [SQS, here('キュー')], render: () => <QueueList /> },
  { pattern: '/sqs/queues/:name', service: 'sqs', crumbs: (p) => [SQS, QUEUES, here(p.name)], render: (p) => <QueueDetail name={p.name} key={p.name} /> },
  { pattern: '/sqs/queues/:name/send-receive', service: 'sqs', crumbs: (p) => [SQS, QUEUES, { text: p.name, href: `/sqs/queues/${p.name}` }, here('メッセージを送受信')], render: (p) => <SendReceive name={p.name} key={p.name} /> },
  { pattern: '/lambda/functions', service: 'lambda', contentType: 'table', crumbs: () => [LAMBDA, here('関数')], render: () => <FunctionList /> },
  { pattern: '/lambda/functions/:name', service: 'lambda', crumbs: (p) => [LAMBDA, FUNCS, here(p.name)], render: (p) => <FunctionDetail name={p.name} key={p.name} /> },
  { pattern: '/lambda/functions/:name/edit-env', service: 'lambda', contentType: 'form', crumbs: (p) => [LAMBDA, FUNCS, { text: p.name, href: `/lambda/functions/${p.name}` }, here('環境変数の編集')], render: (p) => <EditEnvironment name={p.name} key={p.name} /> },
  { pattern: '/batch/jobs', service: 'batch', contentType: 'table', crumbs: () => [BATCH, here('ジョブ')], render: () => <JobList /> },
  { pattern: '/batch/jobs/submit', service: 'batch', contentType: 'form', crumbs: () => [BATCH, JOBS, here('ジョブを送信')], render: () => <SubmitJob /> },
  { pattern: '/batch/jobs/:id', service: 'batch', crumbs: (p, env) => [BATCH, JOBS, here(env.batchJobs.find((j) => j.jobId === p.id)?.jobName ?? p.id)], render: (p) => <JobDetail id={p.id} key={p.id} /> },
  { pattern: '/batch/job-queues', service: 'batch', contentType: 'table', crumbs: () => [BATCH, here('ジョブキュー')], render: () => <JobQueueList /> },
  { pattern: '/batch/job-definitions', service: 'batch', contentType: 'table', crumbs: () => [BATCH, here('ジョブ定義')], render: () => <JobDefinitionList /> },
  { pattern: '/batch/compute-environments', service: 'batch', contentType: 'table', crumbs: () => [BATCH, here('コンピューティング環境')], render: () => <ComputeEnvironmentList /> },
  { pattern: '/events/rules', service: 'events', contentType: 'table', crumbs: () => [EVENTS, here('ルール')], render: () => <RuleList /> },
  { pattern: '/events/rules/create', service: 'events', contentType: 'wizard', crumbs: () => [EVENTS, RULES, here('ルールを作成')], render: () => <CreateRule /> },
  { pattern: '/events/rules/:name', service: 'events', crumbs: (p) => [EVENTS, RULES, here(p.name)], render: (p) => <RuleDetail name={p.name} key={p.name} /> },
];
