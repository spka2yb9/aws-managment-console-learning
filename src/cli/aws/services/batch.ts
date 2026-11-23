/* aws batch — コンピューティング環境・ジョブキュー・ジョブ定義・ジョブ (Fargate)。応答のキーはキャメルケース、日時はエポックミリ秒 */
import { submitJob } from '../../../sim/batch';
import { hash } from '../../../sim/ids';
import type { AwsEnv, BatchJob, JobDefinition } from '../../../sim/types';
import { AwsError, list, service, str, structs, strs, type OperationSpec } from '../types';

const STATUSES = ['SUBMITTED', 'PENDING', 'RUNNABLE', 'STARTING', 'RUNNING', 'SUCCEEDED', 'FAILED'];
const uuidOf = (hex: string) => hex.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5');
const ceUuid = (arn: string) => uuidOf([0, 1, 2, 3].map((n) => hash(`${arn}${n}`).toString(16).padStart(8, '0')).join(''));

const containerProps = (d: JobDefinition) => ({
  image: d.image,
  command: d.command,
  ...(d.jobRoleArn ? { jobRoleArn: d.jobRoleArn } : {}),
  ...(d.executionRoleArn ? { executionRoleArn: d.executionRoleArn } : {}),
  volumes: [],
  environment: [],
  mountPoints: [],
  ulimits: [],
  resourceRequirements: [
    { value: d.vcpus, type: 'VCPU' },
    { value: d.memory, type: 'MEMORY' },
  ],
  secrets: [],
  networkConfiguration: { assignPublicIp: 'ENABLED' },
  fargatePlatformConfiguration: { platformVersion: 'LATEST' },
  runtimePlatform: { operatingSystemFamily: 'LINUX', cpuArchitecture: 'X86_64' },
});

/* Batch が Fargate で動かすときの ECS のタスク (ログストリーム名の末尾がタスク ID) */
const taskArnOf = (env: AwsEnv, j: BatchJob) => {
  const q = env.jobQueues.find((x) => x.jobQueueArn === j.jobQueue);
  const ce = q?.computeEnvironmentOrder[0] ?? '';
  return j.logStreamName ? `arn:aws:ecs:${env.region}:${env.accountId}:task/AWSBatch-${ce.split('/').pop()}-${ceUuid(ce)}/${j.logStreamName.split('/').pop()}` : undefined;
};

function jobOut(env: AwsEnv, j: BatchJob) {
  const d = env.jobDefinitions.find((x) => x.jobDefinitionArn === j.jobDefinition)!;
  const done = j.status === 'SUCCEEDED' || j.status === 'FAILED';
  const taskArn = taskArnOf(env, j);
  const run = { ...(taskArn ? { taskArn } : {}), ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}), ...(j.logStreamName ? { logStreamName: j.logStreamName } : {}), networkInterfaces: [] };
  return {
    jobArn: j.jobArn,
    jobName: j.jobName,
    jobId: j.jobId,
    jobQueue: j.jobQueue,
    status: j.status,
    attempts: done ? [{ container: run, ...(j.startedAt ? { startedAt: j.startedAt } : {}), ...(j.stoppedAt ? { stoppedAt: j.stoppedAt } : {}), ...(j.statusReason ? { statusReason: j.statusReason } : {}) }] : [],
    ...(j.statusReason ? { statusReason: j.statusReason } : {}),
    createdAt: j.createdAt,
    ...(j.startedAt ? { startedAt: j.startedAt } : {}),
    ...(j.stoppedAt ? { stoppedAt: j.stoppedAt } : {}),
    dependsOn: [],
    jobDefinition: j.jobDefinition,
    parameters: {},
    container: { ...containerProps(d), ...run },
    tags: {},
    propagateTags: false,
    platformCapabilities: ['FARGATE'],
    eksAttempts: [],
  };
}

const ops: OperationSpec[] = [
  {
    name: 'describe-compute-environments',
    desc: 'コンピューティング環境 (ジョブを動かす場所) の一覧',
    params: [{ name: 'compute-environments', type: 'list', desc: '名前か ARN で絞る' }],
    readOnly: true,
    run(ctx) {
      const want = strs(ctx, 'compute-environments');
      return {
        computeEnvironments: ctx.env.computeEnvironments
          .filter((c) => !want.length || want.includes(c.computeEnvironmentName) || want.includes(c.computeEnvironmentArn))
          .map((c) => ({ computeEnvironmentName: c.computeEnvironmentName, computeEnvironmentArn: c.computeEnvironmentArn, ecsClusterArn: `arn:aws:ecs:${ctx.env.region}:${ctx.env.accountId}:cluster/AWSBatch-${c.computeEnvironmentName}-${ceUuid(c.computeEnvironmentArn)}`, tags: {}, type: c.type, state: c.state, status: c.status, statusReason: 'ComputeEnvironment Healthy', computeResources: { type: c.resourceType, maxvCpus: c.maxvCpus, subnets: c.subnets, securityGroupIds: c.securityGroupIds }, serviceRole: `arn:aws:iam::${ctx.env.accountId}:role/aws-service-role/batch.amazonaws.com/AWSServiceRoleForBatch`, containerOrchestrationType: 'ECS', uuid: ceUuid(c.computeEnvironmentArn) })),
      };
    },
  },
  {
    name: 'describe-job-queues',
    desc: 'ジョブキューの一覧 (どのコンピューティング環境につながるか)',
    params: [{ name: 'job-queues', type: 'list', desc: '名前か ARN で絞る' }],
    readOnly: true,
    run(ctx) {
      const want = strs(ctx, 'job-queues');
      return {
        jobQueues: ctx.env.jobQueues
          .filter((q) => !want.length || want.includes(q.jobQueueName) || want.includes(q.jobQueueArn))
          .map((q) => ({ jobQueueName: q.jobQueueName, jobQueueArn: q.jobQueueArn, state: q.state, status: 'VALID', statusReason: 'JobQueue Healthy', priority: q.priority, computeEnvironmentOrder: q.computeEnvironmentOrder.map((c, n) => ({ order: n + 1, computeEnvironment: c })), tags: {}, jobStateTimeLimitActions: [] })),
      };
    },
  },
  {
    name: 'describe-job-definitions',
    desc: 'ジョブ定義 (イメージ・コマンド・ジョブロール) の一覧',
    params: [
      { name: 'job-definition-name', type: 'string', desc: '名前で絞る' },
      { name: 'job-definitions', type: 'list', desc: '名前:リビジョン か ARN で絞る' },
      { name: 'status', type: 'string', desc: 'ACTIVE / INACTIVE' },
    ],
    readOnly: true,
    examples: ['aws batch describe-job-definitions --job-definition-name daily-report'],
    run(ctx) {
      const name = str(ctx, 'job-definition-name');
      const want = strs(ctx, 'job-definitions');
      if (str(ctx, 'status') === 'INACTIVE') return { jobDefinitions: [] };
      return {
        jobDefinitions: ctx.env.jobDefinitions
          .filter((d) => (!name || d.jobDefinitionName === name) && (!want.length || want.some((w) => w === d.jobDefinitionArn || w === `${d.jobDefinitionName}:${d.revision}` || w === d.jobDefinitionName)))
          .map((d) => ({ jobDefinitionName: d.jobDefinitionName, jobDefinitionArn: d.jobDefinitionArn, revision: d.revision, status: 'ACTIVE', type: 'container', parameters: {}, containerProperties: containerProps(d), tags: {}, propagateTags: false, platformCapabilities: ['FARGATE'], containerOrchestrationType: 'ECS' })),
      };
    },
  },
  {
    name: 'submit-job',
    desc: 'ジョブをジョブキューに送る',
    params: [
      { name: 'job-name', type: 'string', required: true, desc: 'ジョブの名前 (自由に付ける)' },
      { name: 'job-queue', type: 'string', required: true, desc: 'ジョブキューの名前か ARN' },
      { name: 'job-definition', type: 'string', required: true, desc: 'ジョブ定義 (名前:リビジョン か ARN。リビジョンを省くと最新)' },
    ],
    examples: ['aws batch submit-job --job-name my-job --job-queue report-queue --job-definition daily-report:1'],
    run(ctx) {
      const id = submitJob(ctx.env, { jobName: str(ctx, 'job-name')!, jobQueue: str(ctx, 'job-queue')!, jobDefinition: str(ctx, 'job-definition')! }, 'learner', ctx.now);
      const j = ctx.env.batchJobs.find((x) => x.jobId === id)!;
      return { jobArn: j.jobArn, jobName: j.jobName, jobId: j.jobId };
    },
  },
  {
    name: 'list-jobs',
    desc: 'ジョブキューのジョブの一覧 (既定は RUNNING のものだけ。--filters を付けるとすべてのステータス)',
    params: [
      { name: 'job-queue', type: 'string', desc: 'ジョブキューの名前か ARN' },
      { name: 'job-status', type: 'string', desc: 'SUBMITTED / PENDING / RUNNABLE / STARTING / RUNNING (既定) / SUCCEEDED / FAILED' },
      { name: 'filters', type: 'list', of: 'structure', desc: 'name=JOB_NAME,values=my-job (JOB_NAME / JOB_DEFINITION)' },
    ],
    readOnly: true,
    examples: ['aws batch list-jobs --job-queue report-queue --job-status FAILED', 'aws batch list-jobs --job-queue report-queue --filters name=JOB_NAME,values=daily-report'],
    run(ctx) {
      const qName = str(ctx, 'job-queue');
      if (!qName) throw new AwsError('ClientException', 'jobQueue, arrayJobId or multiNodeJobId must be specified.');
      const q = ctx.env.jobQueues.find((x) => x.jobQueueName === qName || x.jobQueueArn === qName);
      if (!q) throw new AwsError('ClientException', `JobQueue ${qName} not found.`);
      const status = str(ctx, 'job-status') ?? 'RUNNING';
      if (!STATUSES.includes(status)) throw new AwsError('ClientException', `1 validation error detected: Value '${status}' at 'jobStatus' failed to satisfy constraint: Member must satisfy enum value set: [${STATUSES.join(', ')}]`);
      const filters = structs(ctx, 'filters').map((f) => ({ name: String(f.name ?? ''), values: list(f.values) }));
      for (const f of filters) if (f.name !== 'JOB_NAME' && f.name !== 'JOB_DEFINITION') throw new AwsError('ClientException', `(シミュレーター) フィルターは JOB_NAME と JOB_DEFINITION に対応しています: ${f.name}`);
      const like = (want: string, got: string) => (want.endsWith('*') ? got.startsWith(want.slice(0, -1)) : got === want);
      const jobs = ctx.env.batchJobs
        .filter((j) => j.jobQueue === q.jobQueueArn)
        // --filters を付けると、ステータスでは絞らない (実物と同じ)
        .filter((j) => (filters.length ? true : j.status === status))
        .filter((j) => filters.every((f) => f.values.some((v) => (f.name === 'JOB_NAME' ? like(v, j.jobName) : like(v, j.jobDefinition) || like(v, j.jobDefinition.split('/').pop()!)))))
        .sort((a, b) => b.createdAt - a.createdAt);
      return {
        jobSummaryList: jobs.map((j) => ({
          jobArn: j.jobArn,
          jobId: j.jobId,
          jobName: j.jobName,
          createdAt: j.createdAt,
          status: j.status,
          ...(j.statusReason ? { statusReason: j.statusReason } : {}),
          ...(j.startedAt ? { startedAt: j.startedAt } : {}),
          ...(j.stoppedAt ? { stoppedAt: j.stoppedAt } : {}),
          ...(j.exitCode !== undefined ? { container: { exitCode: j.exitCode } } : {}),
          jobDefinition: j.jobDefinition,
        })),
      };
    },
  },
  {
    name: 'describe-jobs',
    desc: 'ジョブの詳細 (ステータスの理由・終了コード・ログストリーム名)',
    params: [{ name: 'jobs', type: 'list', required: true, desc: 'ジョブ ID (最大 100)' }],
    readOnly: true,
    examples: ["aws batch describe-jobs --jobs <ジョブ ID> --query 'jobs[0].container.logStreamName'"],
    run(ctx) {
      const ids = strs(ctx, 'jobs');
      if (ids.length > 100) throw new AwsError('ClientException', 'Too many jobs specified, limit is 100.');
      return { jobs: ctx.env.batchJobs.filter((j) => ids.includes(j.jobId) || ids.includes(j.jobArn)).map((j) => jobOut(ctx.env, j)) };
    },
  },
];

export default service('batch', 'AWS Batch (ジョブキュー・ジョブ定義・ジョブ)', ops);
