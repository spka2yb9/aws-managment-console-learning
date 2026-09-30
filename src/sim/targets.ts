import type { AwsEnv, EcsTask, RegisteredTarget, SimulatedApp, TargetGroup } from './types';

/**
 * What a target group target actually is: an EC2 instance (instance targets) or a Fargate task found by
 * its ENI's IP (ip targets). Network checks, health checks and ALB routing all go through this.
 */
export interface Backend {
  /** endpoint id for canConnect (instance id / task ARN) */
  id: string;
  kind: 'instance' | 'task';
  name: string;
  app?: SimulatedApp;
  availabilityZone: string;
  running: boolean;
  /** starting up (health checks are "initial") */
  starting: boolean;
  /** gone for good (terminated instance / stopped task) */
  gone: boolean;
}

export const taskId = (t: EcsTask) => t.taskArn.split('/').pop()!;
export const liveTaskByIp = (env: AwsEnv, ip: string) => (env.ecsTasks ?? []).find((t) => t.privateIpAddress === ip && t.lastStatus !== 'STOPPED');

/** the app a task runs: its image's app (from ECR), on the container's first port mapping */
export function taskApp(env: AwsEnv, task: EcsTask): SimulatedApp | undefined {
  const td = (env.taskDefinitions ?? []).find((d) => d.taskDefinitionArn === task.taskDefinitionArn);
  const c = td?.containerDefinitions[0];
  const image = c && findImage(env, c.image);
  if (!c || !image) return undefined;
  return { ...image.app, port: c.portMappings[0]?.containerPort ?? image.app.port };
}

/** repository URI + ":tag" (or "@sha256:...") -> the image, if it was pushed */
export function findImage(env: AwsEnv, uri: string) {
  const [repoUri, ref] = uri.includes('@') ? uri.split('@') : [uri.replace(/:[^:/]+$/, ''), uri.match(/:([^:/]+)$/)?.[1] ?? 'latest'];
  const repo = (env.ecrRepositories ?? []).find((r) => r.repositoryUri === repoUri);
  return repo?.images.find((i) => (uri.includes('@') ? i.imageDigest === ref : i.imageTags.includes(ref)));
}

export function backendOf(env: AwsEnv, tg: TargetGroup, target: RegisteredTarget): Backend | undefined {
  if (tg.targetType === 'ip') {
    const t = (env.ecsTasks ?? []).find((x) => x.privateIpAddress === target.id && x.lastStatus !== 'STOPPED') ?? [...(env.ecsTasks ?? [])].reverse().find((x) => x.privateIpAddress === target.id);
    if (!t) return undefined;
    return { id: t.taskArn, kind: 'task', name: `タスク ${taskId(t).slice(0, 8)}`, app: taskApp(env, t), availabilityZone: t.availabilityZone, running: t.lastStatus === 'RUNNING', starting: t.lastStatus === 'PROVISIONING' || t.lastStatus === 'PENDING', gone: t.lastStatus === 'STOPPED' || t.lastStatus === 'DEPROVISIONING' };
  }
  const i = env.instances.find((x) => x.instanceId === target.id);
  if (!i) return undefined;
  return { id: i.instanceId, kind: 'instance', name: i.tags.find((x) => x.key === 'Name')?.value ? `${i.instanceId} (${i.tags.find((x) => x.key === 'Name')!.value})` : i.instanceId, app: i.app, availabilityZone: i.availabilityZone, running: i.state === 'running', starting: i.state === 'pending', gone: i.state === 'terminated' };
}
