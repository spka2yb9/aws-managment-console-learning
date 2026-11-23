/* aws ecs — クラスター・サービス・タスク・タスク定義 (Fargate)。応答のキーは ECS の API どおりキャメルケース */
import { getService, getTaskDefinition, pendingCount, registerTaskDefinition, runningCount, serviceTasks, updateService } from '../../../sim/containers';
import { taskId } from '../../../sim/targets';
import type { AwsEnv, ContainerDefinition, EcsService, EcsTask, TaskDefinition } from '../../../sim/types';
import { AwsError, bool, int, iso, service, str, strs, struct, structs, type OpContext, type OperationSpec, ParamError } from '../types';

/* --cluster を省略すると、実物と同じく default クラスターを探す */
const clusterArg = (ctx: OpContext) => str(ctx, 'cluster') ?? 'default';
const clusterOf = (env: AwsEnv, name: string) => {
  const c = env.ecsClusters.find((x) => x.clusterName === name || x.clusterArn === name);
  if (!c) throw new AwsError('ClusterNotFoundException', 'Cluster not found.');
  return c;
};
const nameOf = (nameOrArn: string) => nameOrArn.split('/').pop()!;
const uuidOf = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

const network = (s: EcsService) => ({ awsvpcConfiguration: { subnets: s.subnets, securityGroups: s.securityGroups, assignPublicIp: s.assignPublicIp } });

function serviceOut(env: AwsEnv, s: EcsService) {
  const tasks = serviceTasks(env, s);
  return {
    serviceArn: s.serviceArn,
    serviceName: s.serviceName,
    clusterArn: s.clusterArn,
    loadBalancers: s.loadBalancers.map((l) => ({ targetGroupArn: l.targetGroupArn, containerName: l.containerName, containerPort: l.containerPort })),
    serviceRegistries: [],
    status: 'ACTIVE',
    desiredCount: s.desiredCount,
    runningCount: runningCount(env, s),
    pendingCount: pendingCount(env, s),
    launchType: 'FARGATE',
    platformVersion: 'LATEST',
    platformFamily: 'Linux',
    taskDefinition: s.taskDefinition,
    deploymentConfiguration: { deploymentCircuitBreaker: { enable: false, rollback: false }, maximumPercent: 200, minimumHealthyPercent: 100 },
    deployments: s.deployments.map((d) => {
      const mine = tasks.filter((t) => t.taskDefinitionArn === d.taskDefinition && t.createdAt >= d.createdAt);
      const running = mine.filter((t) => t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING').length;
      return {
        id: d.id,
        status: d.status,
        taskDefinition: d.taskDefinition,
        desiredCount: d.status === 'PRIMARY' ? s.desiredCount : running,
        pendingCount: mine.filter((t) => (t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING') && t.desiredStatus === 'RUNNING').length,
        runningCount: running,
        failedTasks: mine.filter((t) => t.stopCode === 'TaskFailedToStart').length,
        createdAt: iso(d.createdAt),
        updatedAt: iso(d.createdAt),
        launchType: 'FARGATE',
        platformVersion: '1.4.0',
        platformFamily: 'Linux',
        networkConfiguration: network(s),
        rolloutState: d.rolloutState,
        rolloutStateReason: d.rolloutState === 'COMPLETED' ? `ECS deployment ${d.id} completed.` : `ECS deployment ${d.id} in progress.`,
      };
    }),
    roleArn: `arn:aws:iam::${env.accountId}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`,
    events: s.events.map((e) => ({ id: e.id, createdAt: iso(e.createdAt), message: e.message })),
    createdAt: iso(s.createdAt),
    placementConstraints: [],
    placementStrategy: [],
    networkConfiguration: network(s),
    healthCheckGracePeriodSeconds: s.healthCheckGracePeriodSeconds,
    schedulingStrategy: 'REPLICA',
    deploymentController: { type: 'ECS' },
    enableECSManagedTags: false,
    propagateTags: 'NONE',
    enableExecuteCommand: false,
  };
}

function taskOut(env: AwsEnv, t: EcsTask) {
  const td = env.taskDefinitions.find((d) => d.taskDefinitionArn === t.taskDefinitionArn);
  const id = taskId(t);
  const eni = uuidOf(id.slice(16) + id.slice(0, 16));
  const cluster = nameOf(t.clusterArn);
  return {
    attachments: [{ id: eni, type: 'ElasticNetworkInterface', status: t.lastStatus === 'STOPPED' ? 'DELETED' : 'ATTACHED', details: [{ name: 'subnetId', value: t.subnetId }, { name: 'privateIPv4Address', value: t.privateIpAddress }] }],
    availabilityZone: t.availabilityZone,
    clusterArn: t.clusterArn,
    connectivity: 'CONNECTED',
    containers: t.containers.map((c, n) => ({
      containerArn: `arn:aws:ecs:${env.region}:${env.accountId}:container/${cluster}/${id}/${uuidOf(id.slice(n) + id.slice(0, n))}`,
      taskArn: t.taskArn,
      name: c.name,
      image: c.image,
      lastStatus: c.lastStatus,
      ...(c.reason ? { reason: c.reason } : {}),
      networkInterfaces: [{ attachmentId: eni, privateIpv4Address: t.privateIpAddress }],
      cpu: '0',
    })),
    cpu: td?.cpu,
    createdAt: iso(t.createdAt),
    desiredStatus: t.desiredStatus,
    group: t.group,
    lastStatus: t.lastStatus,
    launchType: 'FARGATE',
    memory: td?.memory,
    platformVersion: '1.4.0',
    platformFamily: 'Linux',
    ...(t.startedAt ? { startedAt: iso(t.startedAt) } : {}),
    ...(t.stopCode ? { stopCode: t.stopCode } : {}),
    ...(t.stoppedReason ? { stoppedReason: t.stoppedReason } : {}),
    ...(t.stoppedAt ? { stoppedAt: iso(t.stoppedAt) } : {}),
    taskArn: t.taskArn,
    taskDefinitionArn: t.taskDefinitionArn,
  };
}

function taskDefinitionOut(d: TaskDefinition) {
  return {
    taskDefinitionArn: d.taskDefinitionArn,
    containerDefinitions: d.containerDefinitions.map((c) => ({ name: c.name, image: c.image, cpu: 0, portMappings: c.portMappings.map((p) => ({ containerPort: p.containerPort, hostPort: p.containerPort, protocol: p.protocol })), essential: c.essential, environment: c.environment, mountPoints: [], volumesFrom: [], systemControls: [] })),
    family: d.family,
    ...(d.taskRoleArn ? { taskRoleArn: d.taskRoleArn } : {}),
    ...(d.executionRoleArn ? { executionRoleArn: d.executionRoleArn } : {}),
    networkMode: d.networkMode,
    revision: d.revision,
    volumes: [],
    status: d.status,
    placementConstraints: [],
    compatibilities: ['EC2', 'FARGATE'],
    requiresCompatibilities: d.requiresCompatibilities,
    cpu: d.cpu,
    memory: d.memory,
    registeredAt: iso(d.registeredAt),
  };
}

/* register-task-definition に渡せるキー (--cli-input-json の検査に使う) */
const TD_KEYS = ['family', 'taskRoleArn', 'executionRoleArn', 'networkMode', 'containerDefinitions', 'volumes', 'placementConstraints', 'requiresCompatibilities', 'cpu', 'memory', 'tags', 'pidMode', 'ipcMode', 'proxyConfiguration', 'inferenceAccelerators', 'ephemeralStorage', 'runtimePlatform'];

function containerIn(c: Record<string, unknown>): ContainerDefinition {
  if (!c.name || typeof c.name !== 'string') throw new AwsError('ClientException', 'Container.name should not be null or empty.');
  if (typeof c.image !== 'string') throw new AwsError('ClientException', 'Container.image should not be null or empty.');
  const ports = Array.isArray(c.portMappings) ? (c.portMappings as Record<string, unknown>[]) : [];
  const envs = Array.isArray(c.environment) ? (c.environment as Record<string, unknown>[]) : [];
  return {
    name: c.name,
    image: c.image,
    essential: c.essential === undefined ? true : c.essential === true || c.essential === 'true',
    portMappings: ports.map((p) => ({ containerPort: Number(p.containerPort), protocol: 'tcp' as const })),
    environment: envs.map((e) => ({ name: String(e.name ?? ''), value: String(e.value ?? '') })),
  };
}

const ops: OperationSpec[] = [
  /* ---- クラスター ---- */
  {
    name: 'list-clusters',
    desc: 'クラスターの ARN の一覧',
    params: [],
    readOnly: true,
    run: (ctx) => ({ clusterArns: ctx.env.ecsClusters.map((c) => c.clusterArn) }),
  },
  {
    name: 'describe-clusters',
    desc: 'クラスターの詳細 (実行中のタスクとサービスの数)',
    params: [{ name: 'clusters', type: 'list', desc: 'クラスター名か ARN (省略すると default)' }],
    readOnly: true,
    run(ctx) {
      const want = strs(ctx, 'clusters');
      const names = want.length ? want : ['default'];
      const found = names.map((n) => ctx.env.ecsClusters.find((c) => c.clusterName === n || c.clusterArn === n));
      return {
        clusters: found.filter((c) => !!c).map((c) => {
          const tasks = ctx.env.ecsTasks.filter((t) => t.clusterArn === c.clusterArn);
          return { clusterArn: c.clusterArn, clusterName: c.clusterName, status: 'ACTIVE', registeredContainerInstancesCount: 0, runningTasksCount: tasks.filter((t) => t.lastStatus === 'RUNNING').length, pendingTasksCount: tasks.filter((t) => t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING').length, activeServicesCount: ctx.env.ecsServices.filter((s) => s.clusterArn === c.clusterArn).length, statistics: [], tags: [], settings: [{ name: 'containerInsights', value: 'disabled' }], capacityProviders: ['FARGATE', 'FARGATE_SPOT'], defaultCapacityProviderStrategy: [] };
        }),
        failures: names.filter((_, i) => !found[i]).map((n) => ({ arn: n.startsWith('arn:') ? n : `arn:aws:ecs:${ctx.region}:${ctx.env.accountId}:cluster/${n}`, reason: 'MISSING' })),
      };
    },
  },

  /* ---- サービス ---- */
  {
    name: 'list-services',
    desc: 'クラスターのサービスの ARN の一覧',
    params: [{ name: 'cluster', type: 'string', desc: 'クラスター名 (省略すると default)' }],
    readOnly: true,
    run(ctx) {
      const c = clusterOf(ctx.env, clusterArg(ctx));
      return { serviceArns: ctx.env.ecsServices.filter((s) => s.clusterArn === c.clusterArn).map((s) => s.serviceArn) };
    },
  },
  {
    name: 'describe-services',
    desc: 'サービスの詳細 (タスクの数・タスク定義・デプロイ・イベント)',
    params: [
      { name: 'cluster', type: 'string', desc: 'クラスター名 (省略すると default)' },
      { name: 'services', type: 'list', required: true, desc: 'サービス名か ARN' },
    ],
    readOnly: true,
    examples: ['aws ecs describe-services --cluster webapp-cluster --services webapp-svc', "aws ecs describe-services --cluster webapp-cluster --services webapp-svc --query 'services[0].deployments'"],
    run(ctx) {
      const c = clusterOf(ctx.env, clusterArg(ctx));
      const names = strs(ctx, 'services');
      const found = names.map((n) => ctx.env.ecsServices.find((s) => s.clusterArn === c.clusterArn && (s.serviceName === n || s.serviceArn === n)));
      return {
        services: found.filter((s) => !!s).map((s) => serviceOut(ctx.env, s)),
        failures: names.filter((_, i) => !found[i]).map((n) => ({ arn: n.startsWith('arn:') ? n : `arn:aws:ecs:${ctx.region}:${ctx.env.accountId}:service/${c.clusterName}/${n}`, reason: 'MISSING' })),
      };
    },
  },
  {
    name: 'update-service',
    desc: 'サービスのタスク定義やタスクの数を変える (新しいタスク定義ならローリングアップデートが始まる)',
    params: [
      { name: 'cluster', type: 'string', desc: 'クラスター名 (省略すると default)' },
      { name: 'service', type: 'string', required: true, desc: 'サービス名' },
      { name: 'task-definition', type: 'string', desc: 'family:revision か ARN (revision を省くと最新の ACTIVE)' },
      { name: 'desired-count', type: 'integer', desc: '動かし続けるタスクの数' },
      { name: 'force-new-deployment', type: 'boolean', desc: '同じタスク定義でもタスクを入れ替える' },
    ],
    examples: ['aws ecs update-service --cluster webapp-cluster --service webapp-svc --task-definition webapp:2'],
    run(ctx) {
      const cluster = clusterArg(ctx);
      const name = nameOf(str(ctx, 'service')!);
      let td = str(ctx, 'task-definition');
      // family だけなら最新の ACTIVE なリビジョン
      if (td && !td.includes(':')) {
        const latest = ctx.env.taskDefinitions.filter((d) => d.family === td && d.status === 'ACTIVE').sort((a, b) => b.revision - a.revision)[0];
        if (!latest) throw new AwsError('ClientException', 'TaskDefinition not found.');
        td = latest.taskDefinitionArn;
      }
      if (td) {
        try {
          getTaskDefinition(ctx.env, td);
        } catch {
          throw new AwsError('ClientException', 'TaskDefinition not found.');
        }
      }
      updateService(ctx.env, cluster, name, { taskDefinition: td, desiredCount: int(ctx, 'desired-count'), forceNewDeployment: bool(ctx, 'force-new-deployment') }, ctx.now);
      return { service: serviceOut(ctx.env, getService(ctx.env, cluster, name)) };
    },
  },
  {
    name: 'wait services-stable',
    desc: 'サービスのデプロイが終わり、タスクの数が必要な数にそろうまで待つ',
    params: [
      { name: 'cluster', type: 'string', desc: 'クラスター名 (省略すると default)' },
      { name: 'services', type: 'list', required: true, desc: 'サービス名か ARN' },
    ],
    readOnly: true,
    waiter: {
      maxAttempts: 40,
      until(ctx) {
        const c = clusterOf(ctx.env, clusterArg(ctx));
        return strs(ctx, 'services').every((n) => {
          const s = ctx.env.ecsServices.find((x) => x.clusterArn === c.clusterArn && (x.serviceName === n || x.serviceArn === n));
          if (!s) throw new AwsError('WaiterFailed', 'Waiter ServicesStable failed: Waiter encountered a terminal failure state: For expression "failures[].reason" we matched expected path: "MISSING" at least once');
          return s.deployments.length === 1 && runningCount(ctx.env, s) === s.desiredCount;
        });
      },
    },
    run: () => undefined,
  },

  /* ---- タスク ---- */
  {
    name: 'list-tasks',
    desc: 'タスクの ARN の一覧 (既定は必要なステータスが RUNNING のもの)',
    params: [
      { name: 'cluster', type: 'string', desc: 'クラスター名 (省略すると default)' },
      { name: 'service-name', type: 'string', desc: 'このサービスのタスクだけ' },
      { name: 'family', type: 'string', desc: 'このタスク定義ファミリーのタスクだけ' },
      { name: 'desired-status', type: 'string', desc: 'RUNNING (既定) / PENDING / STOPPED' },
    ],
    readOnly: true,
    examples: ['aws ecs list-tasks --cluster webapp-cluster --service-name webapp-svc --desired-status STOPPED'],
    run(ctx) {
      const c = clusterOf(ctx.env, clusterArg(ctx));
      const svc = str(ctx, 'service-name');
      if (svc) getService(ctx.env, c.clusterName, nameOf(svc));
      const status = str(ctx, 'desired-status') ?? 'RUNNING';
      if (!['RUNNING', 'PENDING', 'STOPPED'].includes(status)) throw new AwsError('InvalidParameterException', `1 validation error detected: Value '${status}' at 'desiredStatus' failed to satisfy constraint: Member must satisfy enum value set: [PENDING, RUNNING, STOPPED]`);
      const family = str(ctx, 'family');
      const tasks = ctx.env.ecsTasks
        .filter((t) => t.clusterArn === c.clusterArn && (!svc || t.group === `service:${nameOf(svc)}`) && (!family || t.taskDefinitionArn.includes(`task-definition/${family}:`)))
        .filter((t) => (status === 'PENDING' ? false : t.desiredStatus === status))
        .sort((a, b) => b.createdAt - a.createdAt);
      return { taskArns: tasks.map((t) => t.taskArn) };
    },
  },
  {
    name: 'describe-tasks',
    desc: 'タスクの詳細 (ステータス・IP アドレス・停止理由)',
    params: [
      { name: 'cluster', type: 'string', desc: 'クラスター名 (省略すると default)' },
      { name: 'tasks', type: 'list', required: true, desc: 'タスクの ARN か ID' },
    ],
    readOnly: true,
    examples: ["aws ecs describe-tasks --cluster webapp-cluster --tasks <タスク ID> --query 'tasks[0].stoppedReason'"],
    run(ctx) {
      const c = clusterOf(ctx.env, clusterArg(ctx));
      const ids = strs(ctx, 'tasks');
      const found = ids.map((x) => ctx.env.ecsTasks.find((t) => t.clusterArn === c.clusterArn && (t.taskArn === x || taskId(t) === x)));
      return {
        tasks: found.filter((t) => !!t).map((t) => taskOut(ctx.env, t)),
        failures: ids.filter((_, i) => !found[i]).map((x) => ({ arn: x.startsWith('arn:') ? x : `arn:aws:ecs:${ctx.region}:${ctx.env.accountId}:task/${c.clusterName}/${x}`, reason: 'MISSING' })),
      };
    },
  },

  /* ---- タスク定義 ---- */
  {
    name: 'list-task-definitions',
    desc: 'タスク定義 (リビジョンごと) の ARN の一覧',
    params: [
      { name: 'family-prefix', type: 'string', desc: 'ファミリー名で絞る' },
      { name: 'status', type: 'string', desc: 'ACTIVE (既定) / INACTIVE' },
      { name: 'sort', type: 'string', desc: 'ASC (既定) / DESC' },
    ],
    readOnly: true,
    run(ctx) {
      const family = str(ctx, 'family-prefix');
      const status = str(ctx, 'status') ?? 'ACTIVE';
      const list = ctx.env.taskDefinitions.filter((d) => (!family || d.family === family) && d.status === status).sort((a, b) => a.family.localeCompare(b.family) || a.revision - b.revision);
      if (str(ctx, 'sort') === 'DESC') list.reverse();
      return { taskDefinitionArns: list.map((d) => d.taskDefinitionArn) };
    },
  },
  {
    name: 'describe-task-definition',
    desc: 'タスク定義の中身 (イメージ・CPU・メモリ・ポート)',
    params: [{ name: 'task-definition', type: 'string', required: true, desc: 'family:revision か ARN (revision を省くと最新)' }],
    readOnly: true,
    examples: ['aws ecs describe-task-definition --task-definition webapp:1'],
    run(ctx) {
      const want = str(ctx, 'task-definition')!;
      const d = want.includes(':')
        ? ctx.env.taskDefinitions.find((x) => x.taskDefinitionArn === want || `${x.family}:${x.revision}` === want)
        : ctx.env.taskDefinitions.filter((x) => x.family === want && x.status === 'ACTIVE').sort((a, b) => b.revision - a.revision)[0];
      if (!d) throw new AwsError('ClientException', 'Unable to describe task definition.');
      return { taskDefinition: taskDefinitionOut(d) };
    },
  },
  {
    name: 'register-task-definition',
    desc: 'タスク定義を登録する (同じファミリーなら新しいリビジョンになる)',
    params: [
      { name: 'family', type: 'string', desc: 'ファミリー名 (例: webapp)' },
      { name: 'container-definitions', type: 'list', of: 'structure', desc: 'コンテナの定義 (JSON。name / image / portMappings など)' },
      { name: 'cpu', type: 'string', desc: 'CPU ユニット (256 = 0.25 vCPU)' },
      { name: 'memory', type: 'string', desc: 'メモリ (MiB)' },
      { name: 'network-mode', type: 'string', desc: 'Fargate は awsvpc' },
      { name: 'requires-compatibilities', type: 'list', desc: 'FARGATE' },
      { name: 'execution-role-arn', type: 'string', desc: 'タスク実行ロール (イメージの取得とログの書き込み)' },
      { name: 'task-role-arn', type: 'string', desc: 'タスクロール (アプリが AWS を呼ぶときの権限)' },
      { name: 'cli-input-json', type: 'structure', desc: '上のオプションをまとめた JSON (file://td.json)' },
    ],
    examples: ['aws ecs register-task-definition --cli-input-json file://webapp-td.json'],
    run(ctx) {
      const input = struct(ctx, 'cli-input-json') ?? {};
      const unknown = Object.keys(input).filter((k) => !TD_KEYS.includes(k));
      if (unknown.length) throw new ParamError(`Parameter validation failed:\n${unknown.map((k) => `Unknown parameter in input: "${k}", must be one of: ${TD_KEYS.join(', ')}`).join('\n')}`);
      const pick = (opt: string, key: string) => str(ctx, opt) ?? (input[key] === undefined ? undefined : String(input[key]));
      const family = pick('family', 'family');
      if (!family) throw new ParamError('Parameter validation failed:\nMissing required parameter in input: "family"');
      const containers = ctx.p['container-definitions'] !== undefined ? structs(ctx, 'container-definitions') : Array.isArray(input.containerDefinitions) ? (input.containerDefinitions as Record<string, unknown>[]) : undefined;
      if (!containers) throw new ParamError('Parameter validation failed:\nMissing required parameter in input: "containerDefinitions"');
      const mode = pick('network-mode', 'networkMode');
      if (mode !== 'awsvpc') throw new AwsError('ClientException', "Fargate only supports network mode 'awsvpc'.");
      const cpu = pick('cpu', 'cpu');
      const memory = pick('memory', 'memory');
      if (!cpu) throw new AwsError('ClientException', "Fargate requires that 'cpu' be defined at the task level.");
      if (!memory) throw new AwsError('ClientException', "Fargate requires that 'memory' be defined at the task level.");
      const arn = registerTaskDefinition(ctx.env, { family, cpu, memory, executionRoleArn: pick('execution-role-arn', 'executionRoleArn'), taskRoleArn: pick('task-role-arn', 'taskRoleArn'), containerDefinitions: containers.map(containerIn) }, ctx.now);
      return { taskDefinition: taskDefinitionOut(getTaskDefinition(ctx.env, arn)) };
    },
  },
];

export default service('ecs', 'Amazon ECS (コンテナの実行: クラスター・サービス・タスク・タスク定義)', ops);
