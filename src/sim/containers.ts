import { trail } from './cloudtrail';
import { deregisterTargets, registerTargets, targetHealth } from './elb';
import { getSg, getSubnet, getTg } from './env';
import { hash, newUuid, randomHex } from './ids';
import { findImage, taskId } from './targets';
import { AwsError, type AwsEnv, type ContainerDefinition, type EcrImage, type EcsService, type EcsTask, type SimulatedApp, type TaskDefinition } from './types';
import { allocateIp } from './vpc';

/**
 * ECR + ECS on Fargate. advanceEcs() is the service scheduler: it starts tasks up to the desired count,
 * pulls images (a missing tag stops the task with CannotPullContainerError), registers RUNNING tasks in the
 * target group, and rolls deployments forward (new tasks healthy first, then the old ones stop).
 */

/** Simulated durations (real Fargate: tens of seconds). */
export const TASK_STEP_MS = 2000;
const RETRY_MS = 10_000;

// ---------------- ECR ----------------

export function createRepository(env: AwsEnv, name: string, now = Date.now()): string {
  if (!/^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name) || name.length < 2 || name.length > 256)
    throw new AwsError('InvalidParameterException', "Invalid parameter at 'repositoryName' failed to satisfy constraint: 'must satisfy regular expression '(?:[a-z0-9]+(?:[._-][a-z0-9]+)*/)*[a-z0-9]+(?:[._-][a-z0-9]+)*''");
  if (env.ecrRepositories.some((r) => r.repositoryName === name)) throw new AwsError('RepositoryAlreadyExistsException', `The repository with name '${name}' already exists in the registry with id '${env.accountId}'`);
  const uri = `${env.accountId}.dkr.ecr.${env.region}.amazonaws.com/${name}`;
  env.ecrRepositories.push({ repositoryName: name, repositoryArn: `arn:aws:ecr:${env.region}:${env.accountId}:repository/${name}`, repositoryUri: uri, createdAt: now, images: [] });
  trail(env, { source: 'ecr', name: 'CreateRepository', resources: [['AWS::ECR::Repository', name]], request: { repositoryName: name }, response: { repository: { repositoryName: name, repositoryUri: uri } } });
  return uri;
}

/** what `docker push` does (scenarios use it to prepare images) */
export function putImage(env: AwsEnv, repositoryName: string, tag: string, app: SimulatedApp, now = Date.now()): EcrImage {
  const repo = env.ecrRepositories.find((r) => r.repositoryName === repositoryName);
  if (!repo) throw new AwsError('RepositoryNotFoundException', `The repository with name '${repositoryName}' does not exist in the registry with id '${env.accountId}'`);
  repo.images.forEach((i) => (i.imageTags = i.imageTags.filter((t) => t !== tag)));
  const image: EcrImage = { imageTags: [tag], imageDigest: `sha256:${(hash(`${repositoryName}:${tag}:${app.version}`).toString(16) + randomHex(56)).slice(0, 64)}`, pushedAt: now, sizeInBytes: 48_000_000 + (hash(tag) % 9_000_000), app };
  repo.images.push(image);
  return image;
}

// ---------------- task definitions ----------------

export interface TaskDefinitionInput {
  family: string;
  cpu: string;
  memory: string;
  executionRoleArn?: string;
  taskRoleArn?: string;
  containerDefinitions: ContainerDefinition[];
}

export function registerTaskDefinition(env: AwsEnv, input: TaskDefinitionInput, now = Date.now()): string {
  const family = input.family.trim();
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(family)) throw new AwsError('ClientException', 'Family contains invalid characters. Up to 255 letters (uppercase and lowercase), numbers, underscores, and hyphens are allowed.');
  if (!input.containerDefinitions.length) throw new AwsError('ClientException', 'Container list cannot be empty.');
  for (const c of input.containerDefinitions) if (!c.image.trim()) throw new AwsError('ClientException', `Container.image should not be null or empty.`);
  const revision = Math.max(0, ...env.taskDefinitions.filter((d) => d.family === family).map((d) => d.revision)) + 1;
  const arn = `arn:aws:ecs:${env.region}:${env.accountId}:task-definition/${family}:${revision}`;
  env.taskDefinitions.push({ family, revision, taskDefinitionArn: arn, cpu: input.cpu, memory: input.memory, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], executionRoleArn: input.executionRoleArn, taskRoleArn: input.taskRoleArn, containerDefinitions: input.containerDefinitions.map((c) => ({ ...c, image: c.image.trim() })), status: 'ACTIVE', registeredAt: now });
  trail(env, { source: 'ecs', name: 'RegisterTaskDefinition', resources: [['AWS::ECS::TaskDefinition', arn]], request: { family, cpu: input.cpu, memory: input.memory, networkMode: 'awsvpc', requiresCompatibilities: ['FARGATE'], containerDefinitions: input.containerDefinitions }, response: { taskDefinition: { taskDefinitionArn: arn, revision, status: 'ACTIVE' } } });
  return arn;
}

export const getTaskDefinition = (env: AwsEnv, arnOrFamilyRevision: string): TaskDefinition => {
  const d = env.taskDefinitions.find((x) => x.taskDefinitionArn === arnOrFamilyRevision || `${x.family}:${x.revision}` === arnOrFamilyRevision);
  if (!d) throw new AwsError('ClientException', `Unable to describe task definition.`);
  return d;
};
export const tdLabel = (arn: string) => arn.split('/').pop()!;

// ---------------- clusters and services ----------------

export function createCluster(env: AwsEnv, name: string, now = Date.now()): string {
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(name)) throw new AwsError('InvalidParameterException', 'Cluster name can only contain letters, numbers, hyphens and underscores.');
  const arn = `arn:aws:ecs:${env.region}:${env.accountId}:cluster/${name}`;
  if (!env.ecsClusters.some((c) => c.clusterName === name)) env.ecsClusters.push({ clusterName: name, clusterArn: arn, createdAt: now });
  trail(env, { source: 'ecs', name: 'CreateCluster', resources: [['AWS::ECS::Cluster', arn]], request: { clusterName: name }, response: { cluster: { clusterArn: arn, status: 'ACTIVE' } } });
  return arn;
}

const getCluster = (env: AwsEnv, name: string) => {
  const c = env.ecsClusters.find((x) => x.clusterName === name || x.clusterArn === name);
  if (!c) throw new AwsError('ClusterNotFoundException', 'Cluster not found.');
  return c;
};

export function getService(env: AwsEnv, cluster: string, name: string): EcsService {
  const c = getCluster(env, cluster);
  const s = env.ecsServices.find((x) => x.clusterArn === c.clusterArn && x.serviceName === name);
  if (!s) throw new AwsError('ServiceNotFoundException', 'Service not found.');
  return s;
}

export interface CreateServiceInput {
  cluster: string;
  serviceName: string;
  taskDefinition: string;
  desiredCount: number;
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: 'ENABLED' | 'DISABLED';
  loadBalancers: EcsService['loadBalancers'];
  healthCheckGracePeriodSeconds?: number;
}

const event = (s: EcsService, now: number, message: string) => {
  s.events.unshift({ id: newUuid(), createdAt: now, message: `(service ${s.serviceName}) ${message}` });
  s.events = s.events.slice(0, 100);
};

export function createService(env: AwsEnv, input: CreateServiceInput, now = Date.now()): string {
  const c = getCluster(env, input.cluster);
  const name = input.serviceName.trim();
  if (!/^[a-zA-Z0-9_-]{1,255}$/.test(name)) throw new AwsError('InvalidParameterException', 'Service name can only contain letters, numbers, hyphens and underscores.');
  if (env.ecsServices.some((s) => s.clusterArn === c.clusterArn && s.serviceName === name)) throw new AwsError('InvalidParameterException', 'Creation of service was not idempotent.');
  const td = getTaskDefinition(env, input.taskDefinition);
  if (!Number.isInteger(input.desiredCount) || input.desiredCount < 0) throw new AwsError('InvalidParameterException', 'desiredCount must be a non-negative integer.');
  if (!input.subnets.length) throw new AwsError('InvalidParameterException', 'subnets can not be empty.');
  const vpcId = getSubnet(env, input.subnets[0]).vpcId;
  input.subnets.forEach((s) => getSubnet(env, s));
  input.securityGroups.forEach((g) => getSg(env, g));
  for (const lb of input.loadBalancers) {
    const tg = getTg(env, lb.targetGroupArn);
    if (tg.targetType !== 'ip') throw new AwsError('InvalidParameterException', `The provided target group ${tg.targetGroupArn} has target type instance, which is incompatible with the awsvpc network mode specified in the task definition.`);
    if (tg.vpcId !== vpcId) throw new AwsError('InvalidParameterException', 'The target group and the subnets must be in the same VPC.');
    if (!td.containerDefinitions.some((x) => x.name === lb.containerName && x.portMappings.some((p) => p.containerPort === lb.containerPort)))
      throw new AwsError('InvalidParameterException', `The container ${lb.containerName} did not have a container port ${lb.containerPort} defined.`);
  }
  const arn = `arn:aws:ecs:${env.region}:${env.accountId}:service/${c.clusterName}/${name}`;
  const s: EcsService = {
    serviceName: name,
    serviceArn: arn,
    clusterArn: c.clusterArn,
    taskDefinition: td.taskDefinitionArn,
    desiredCount: input.desiredCount,
    launchType: 'FARGATE',
    subnets: [...input.subnets],
    securityGroups: [...input.securityGroups],
    assignPublicIp: input.assignPublicIp,
    loadBalancers: input.loadBalancers.map((l) => ({ ...l })),
    healthCheckGracePeriodSeconds: input.healthCheckGracePeriodSeconds ?? 0,
    deployments: [{ id: `ecs-svc/${randomHex(19).replace(/[a-f]/g, (x) => String(x.charCodeAt(0) % 10))}`, status: 'PRIMARY', taskDefinition: td.taskDefinitionArn, rolloutState: 'IN_PROGRESS', createdAt: now }],
    events: [],
    createdAt: now,
  };
  env.ecsServices.push(s);
  trail(env, { source: 'ecs', name: 'CreateService', resources: [['AWS::ECS::Service', arn]], request: { cluster: c.clusterName, serviceName: name, taskDefinition: tdLabel(td.taskDefinitionArn), desiredCount: input.desiredCount, launchType: 'FARGATE' }, response: { service: { serviceArn: arn, status: 'ACTIVE' } } });
  return arn;
}

/** UpdateService: a new task definition (or forceNewDeployment) starts a rolling deployment. */
export function updateService(env: AwsEnv, cluster: string, name: string, input: { taskDefinition?: string; desiredCount?: number; forceNewDeployment?: boolean }, now = Date.now()) {
  const s = getService(env, cluster, name);
  if (input.desiredCount !== undefined) {
    if (!Number.isInteger(input.desiredCount) || input.desiredCount < 0) throw new AwsError('InvalidParameterException', 'desiredCount must be a non-negative integer.');
    s.desiredCount = input.desiredCount;
  }
  const td = input.taskDefinition ? getTaskDefinition(env, input.taskDefinition) : undefined;
  if ((td && td.taskDefinitionArn !== s.taskDefinition) || input.forceNewDeployment) {
    if (td) s.taskDefinition = td.taskDefinitionArn;
    s.deployments = [{ id: `ecs-svc/${String(hash(newUuid())).padStart(19, '0').slice(0, 19)}`, status: 'PRIMARY', taskDefinition: s.taskDefinition, rolloutState: 'IN_PROGRESS', createdAt: now }, ...s.deployments.map((d) => ({ ...d, status: 'ACTIVE' as const }))];
    s.retryAt = undefined;
  }
  trail(env, { source: 'ecs', name: 'UpdateService', resources: [['AWS::ECS::Service', s.serviceArn]], request: { cluster, service: name, ...(td ? { taskDefinition: tdLabel(td.taskDefinitionArn) } : {}), ...(input.desiredCount !== undefined ? { desiredCount: input.desiredCount } : {}), forceNewDeployment: !!input.forceNewDeployment }, response: { service: { serviceArn: s.serviceArn } } });
  advanceEcs(env, now);
}

function stop(t: EcsTask, now: number, code: EcsTask['stopCode'], reason: string) {
  t.desiredStatus = 'STOPPED';
  t.stopCode = code;
  t.stoppedReason = reason;
  if (t.lastStatus !== 'STOPPED' && t.lastStatus !== 'DEPROVISIONING') {
    t.lastStatus = 'DEPROVISIONING';
    t.statusChangedAt = now;
  }
}

export function stopTask(env: AwsEnv, taskArn: string, reason = 'Task stopped by user', now = Date.now()) {
  const t = env.ecsTasks.find((x) => x.taskArn === taskArn);
  if (!t) throw new AwsError('InvalidParameterException', 'The referenced task was not found.');
  stop(t, now, 'UserInitiated', reason);
  trail(env, { source: 'ecs', name: 'StopTask', resources: [['AWS::ECS::Task', taskArn]], request: { task: taskArn, reason }, response: { task: { taskArn, desiredStatus: 'STOPPED' } } });
}

function runTask(env: AwsEnv, s: EcsService, td: TaskDefinition, n: number, now: number): EcsTask {
  const subnet = getSubnet(env, s.subnets[n % s.subnets.length]);
  const cluster = s.clusterArn.split('/').pop()!;
  const t: EcsTask = {
    taskArn: `arn:aws:ecs:${env.region}:${env.accountId}:task/${cluster}/${randomHex(32)}`,
    clusterArn: s.clusterArn,
    group: `service:${s.serviceName}`,
    taskDefinitionArn: td.taskDefinitionArn,
    lastStatus: 'PROVISIONING',
    desiredStatus: 'RUNNING',
    statusChangedAt: now,
    subnetId: subnet.subnetId,
    availabilityZone: subnet.availabilityZone,
    privateIpAddress: allocateIp(env, subnet.subnetId),
    securityGroupIds: [...s.securityGroups],
    createdAt: now,
    containers: td.containerDefinitions.map((c) => ({ name: c.name, image: c.image, lastStatus: 'PENDING' })),
  };
  env.ecsTasks.push(t);
  return t;
}

const serviceTasks = (env: AwsEnv, s: EcsService) => env.ecsTasks.filter((t) => t.clusterArn === s.clusterArn && t.group === `service:${s.serviceName}`);

/** a task counts as healthy when RUNNING and (with a load balancer) healthy in every target group */
function healthy(env: AwsEnv, s: EcsService, t: EcsTask) {
  return t.lastStatus === 'RUNNING' && s.loadBalancers.every((lb) => targetHealth(env, lb.targetGroupArn, { id: t.privateIpAddress, port: lb.containerPort }).state === 'healthy');
}

export function advanceEcs(env: AwsEnv, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  const before = JSON.stringify([env.ecsTasks, env.ecsServices]);
  /** service groups whose tasks failed to pull their image in this tick */
  const failedToStart = new Set<string>();
  // 1. task lifecycle
  for (const t of env.ecsTasks) {
    if (now - t.statusChangedAt < TASK_STEP_MS) continue;
    const at = t.statusChangedAt + TASK_STEP_MS;
    if (t.lastStatus === 'PROVISIONING') {
      t.lastStatus = 'PENDING';
      t.statusChangedAt = at;
    } else if (t.lastStatus === 'PENDING') {
      const missing = t.containers.find((c) => !findImage(env, c.image));
      if (missing) {
        const reason = `CannotPullContainerError: pull image manifest has been retried 1 time(s): failed to resolve ref ${missing.image}: ${missing.image}: not found`;
        t.containers.forEach((c) => ((c.lastStatus = 'STOPPED'), (c.reason = c === missing ? reason : undefined)));
        stop(t, at, 'TaskFailedToStart', reason);
        failedToStart.add(`${t.clusterArn}|${t.group}`);
      } else {
        t.lastStatus = 'RUNNING';
        t.startedAt = at;
        t.statusChangedAt = at;
        t.containers.forEach((c) => (c.lastStatus = 'RUNNING'));
      }
    } else if (t.lastStatus === 'DEPROVISIONING') {
      t.lastStatus = 'STOPPED';
      t.stoppedAt = at;
      t.statusChangedAt = at;
      t.containers.forEach((c) => (c.lastStatus = 'STOPPED'));
    }
  }
  // 2. service schedulers
  for (const s of env.ecsServices) {
    const tasks = serviceTasks(env, s).filter((t) => t.desiredStatus === 'RUNNING');
    const primary = s.deployments[0];
    const td = env.taskDefinitions.find((d) => d.taskDefinitionArn === primary.taskDefinition)!;
    const mine = tasks.filter((t) => t.taskDefinitionArn === primary.taskDefinition);
    const old = tasks.filter((t) => t.taskDefinitionArn !== primary.taskDefinition);
    // tasks that just failed to start: back off, like the scheduler's throttling
    if (failedToStart.has(`${s.clusterArn}|service:${s.serviceName}`)) {
      event(s, now, 'is unable to consistently start tasks successfully. For more information, see the Troubleshooting section of the Amazon ECS Developer Guide.');
      s.retryAt = now + RETRY_MS;
    }
    // register / deregister load balancer targets
    for (const t of serviceTasks(env, s))
      for (const lb of s.loadBalancers) {
        const tg = env.targetGroups.find((x) => x.targetGroupArn === lb.targetGroupArn);
        if (!tg) continue;
        const registered = tg.targets.some((x) => x.id === t.privateIpAddress && x.port === lb.containerPort);
        if (t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING' && !registered) {
          registerTargets(env, lb.targetGroupArn, [{ id: t.privateIpAddress, port: lb.containerPort }]);
          event(s, now, `registered 1 targets in (target-group ${lb.targetGroupArn})`);
        } else if (t.desiredStatus === 'STOPPED' && registered) {
          deregisterTargets(env, lb.targetGroupArn, [{ id: t.privateIpAddress, port: lb.containerPort }]);
          event(s, now, `deregistered 1 targets in (target-group ${lb.targetGroupArn})`);
        }
      }
    // start tasks of the primary deployment up to the desired count
    if (mine.length < s.desiredCount && (!s.retryAt || now >= s.retryAt)) {
      const started = Array.from({ length: s.desiredCount - mine.length }, (_, n) => runTask(env, s, td, mine.length + n, now));
      event(s, now, `has started ${started.length} tasks: ${started.map((t) => `(task ${taskId(t)})`).join(' ')}.`);
    } else if (mine.length > s.desiredCount) {
      const extra = mine.slice(s.desiredCount);
      extra.forEach((t) => stop(t, now, 'ServiceSchedulerInitiated', 'Scaling activity initiated by (deployment ' + primary.id + ')'));
      event(s, now, `has stopped ${extra.length} running tasks: ${extra.map((t) => `(task ${taskId(t)})`).join(' ')}.`);
    }
    // rolling update: once the new tasks are healthy, the old ones go
    const ready = mine.filter((t) => healthy(env, s, t)).length;
    if (old.length && ready >= s.desiredCount) {
      old.forEach((t) => stop(t, now, 'ServiceSchedulerInitiated', `Task stopped by deployment (deployment ${primary.id})`));
      event(s, now, `has stopped ${old.length} running tasks: ${old.map((t) => `(task ${taskId(t)})`).join(' ')}.`);
    }
    if (!old.length && s.deployments.length > 1) s.deployments = [primary];
    if (primary.rolloutState === 'IN_PROGRESS' && ready >= s.desiredCount && !old.length) {
      primary.rolloutState = 'COMPLETED';
      event(s, now, `deployment ${primary.id} deployment completed.`);
      event(s, now, 'has reached a steady state.');
    }
  }
  // 3. stopped tasks stay visible for an hour
  env.ecsTasks = env.ecsTasks.filter((t) => t.lastStatus !== 'STOPPED' || now - (t.stoppedAt ?? now) < 3_600_000);
  return JSON.stringify([env.ecsTasks, env.ecsServices]) !== before;
}

export const runningCount = (env: AwsEnv, s: EcsService) => serviceTasks(env, s).filter((t) => t.lastStatus === 'RUNNING' && t.desiredStatus === 'RUNNING').length;
export const pendingCount = (env: AwsEnv, s: EcsService) => serviceTasks(env, s).filter((t) => (t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING') && t.desiredStatus === 'RUNNING').length;
export { serviceTasks };
