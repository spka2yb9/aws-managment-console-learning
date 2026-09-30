import { getInstance, getLb, getSg, getSubnet, getTg, getVpc } from './env';
import { trail } from './cloudtrail';
import { randomDigits, randomHex } from './ids';
import { canConnect } from './network';
import { backendOf } from './targets';
import { ipInCidr, isValidIp } from './cidr';
import { AwsError, type AwsEnv, type HealthCheck, type LoadBalancer, type RegisteredTarget, type TargetGroup } from './types';
import { allocateIp } from './vpc';

export const LB_PROVISION_MS = 5000;

export const DEFAULT_HEALTH_CHECK: HealthCheck = {
  protocol: 'HTTP',
  port: 'traffic-port',
  path: '/',
  intervalSeconds: 30,
  timeoutSeconds: 5,
  healthyThresholdCount: 5,
  unhealthyThresholdCount: 2,
  matcher: '200',
};

// AWS naming rule shared by load balancers and target groups.
function checkElbName(name: string, kind: 'LoadBalancer' | 'Target group') {
  if (!name) throw new AwsError('ValidationError', `${kind} name cannot be empty`);
  if (name.length > 32) throw new AwsError('ValidationError', `${kind} name cannot be longer than '32' characters`);
  if (!/^[a-zA-Z0-9-]+$/.test(name) || name.startsWith('-') || name.endsWith('-'))
    throw new AwsError('ValidationError', `${kind} name '${name}' can only contain characters that are alphanumeric characters or hyphens(-) and must not begin or end with a hyphen`);
  if (kind === 'LoadBalancer' && name.toLowerCase().startsWith('internal-')) throw new AwsError('ValidationError', "Load balancer names cannot start with 'internal-'");
}

// ---------- target groups ----------

export function createTargetGroup(env: AwsEnv, input: { name: string; port: number; vpcId: string; healthCheck?: Partial<HealthCheck>; targetType?: 'instance' | 'ip' }): string {
  checkElbName(input.name, 'Target group');
  getVpc(env, input.vpcId);
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new AwsError('ValidationError', 'Port must be between 1 and 65535');
  if (env.targetGroups.some((t) => t.targetGroupName === input.name))
    throw new AwsError('DuplicateTargetGroupName', `A target group with the same name '${input.name}' exists, but with different settings`);
  const arn = `arn:aws:elasticloadbalancing:${env.region}:${env.accountId}:targetgroup/${input.name}/${randomHex(16)}`;
  env.targetGroups.push({
    targetGroupArn: arn,
    targetGroupName: input.name,
    targetType: input.targetType ?? 'instance',
    protocol: 'HTTP',
    protocolVersion: 'HTTP1',
    port: input.port,
    vpcId: input.vpcId,
    healthCheck: { ...DEFAULT_HEALTH_CHECK, ...input.healthCheck },
    targets: [],
  });
  trail(env, { source: 'elasticloadbalancing', name: 'CreateTargetGroup', resources: [['AWS::ElasticLoadBalancingV2::TargetGroup', arn]], request: { name: input.name, protocol: 'HTTP', port: input.port, vpcId: input.vpcId, targetType: input.targetType ?? 'instance' }, response: { targetGroups: [{ targetGroupArn: arn, targetGroupName: input.name }] } });
  return arn;
}

export function modifyTargetGroupHealthCheck(env: AwsEnv, arn: string, hc: HealthCheck) {
  if (!hc.path.startsWith('/')) throw new AwsError('ValidationError', 'Health check path must begin with a \'/\' character');
  if (hc.port !== 'traffic-port' && (!Number.isInteger(hc.port) || hc.port < 1 || hc.port > 65535)) throw new AwsError('ValidationError', 'Health check port must be between 1 and 65535');
  if (!parseMatcher(hc.matcher)) throw new AwsError('ValidationError', `Health check matcher HTTP code '${hc.matcher}' must be within '200-499' code range`);
  getTg(env, arn).healthCheck = { ...hc };
  trail(env, { source: 'elasticloadbalancing', name: 'ModifyTargetGroup', resources: [['AWS::ElasticLoadBalancingV2::TargetGroup', arn]], request: { targetGroupArn: arn, healthCheckPath: hc.path, healthCheckPort: String(hc.port), matcher: { httpCode: hc.matcher } } });
}

export function registerTargets(env: AwsEnv, arn: string, targets: RegisteredTarget[]) {
  const tg = getTg(env, arn);
  if (tg.targetType === 'ip') {
    const cidr = getVpc(env, tg.vpcId).cidrBlock;
    const outside = targets.filter((t) => !isValidIp(t.id) || !ipInCidr(t.id, cidr));
    if (outside.length) throw new AwsError('ValidationError', `The IP address '${outside[0].id}' is not a valid IPv4 address within the VPC of the target group`);
    for (const t of targets) if (!tg.targets.some((x) => x.id === t.id && x.port === t.port)) tg.targets.push({ id: t.id, port: t.port });
    trail(env, { source: 'elasticloadbalancing', name: 'RegisterTargets', resources: [['AWS::ElasticLoadBalancingV2::TargetGroup', arn]], request: { targetGroupArn: arn, targets: targets.map((x) => ({ id: x.id, port: x.port })) }, response: null });
    return;
  }
  const wrongVpc = targets.filter((t) => getInstance(env, t.id).vpcId !== tg.vpcId);
  if (wrongVpc.length) throw new AwsError('InvalidTarget', `The following targets are not in the target group VPC '${tg.vpcId}': '${wrongVpc.map((t) => t.id).join("', '")}'`);
  const invalid = targets.filter((t) => ['terminated', 'shutting-down'].includes(getInstance(env, t.id).state));
  if (invalid.length) throw new AwsError('InvalidTarget', `The following targets are not in a running state and cannot be registered: '${invalid.map((t) => t.id).join("', '")}'`);
  for (const t of targets) {
    if (!Number.isInteger(t.port) || t.port < 1 || t.port > 65535) throw new AwsError('ValidationError', 'Port must be between 1 and 65535');
    if (!tg.targets.some((x) => x.id === t.id && x.port === t.port)) tg.targets.push({ id: t.id, port: t.port });
  }
  trail(env, { source: 'elasticloadbalancing', name: 'RegisterTargets', resources: [['AWS::ElasticLoadBalancingV2::TargetGroup', arn]], request: { targetGroupArn: arn, targets: targets.map((x) => ({ id: x.id, port: x.port })) }, response: null });
}

/** ponytail: deregistration is instant (real ELB drains for the deregistration delay, 300s by default). */
export function deregisterTargets(env: AwsEnv, arn: string, targets: RegisteredTarget[]) {
  const tg = getTg(env, arn);
  tg.targets = tg.targets.filter((x) => !targets.some((t) => t.id === x.id && t.port === x.port));
  trail(env, { source: 'elasticloadbalancing', name: 'DeregisterTargets', resources: [['AWS::ElasticLoadBalancingV2::TargetGroup', arn]], request: { targetGroupArn: arn, targets: targets.map((x) => ({ id: x.id, port: x.port })) }, response: null });
}

// ---------- load balancers ----------

export interface CreateLoadBalancerInput {
  name: string;
  scheme: LoadBalancer['scheme'];
  vpcId: string;
  subnetIds: string[];
  securityGroupIds: string[];
  listeners: { port: number; targetGroupArn: string }[];
}

export function lbsForTargetGroup(env: AwsEnv, arn: string): LoadBalancer[] {
  return env.loadBalancers.filter((lb) => lb.listeners.some((l) => l.targetGroupArn === arn));
}

export function createLoadBalancer(env: AwsEnv, input: CreateLoadBalancerInput, now = Date.now()): string {
  checkElbName(input.name, 'LoadBalancer');
  getVpc(env, input.vpcId);
  if (env.loadBalancers.some((l) => l.loadBalancerName === input.name))
    throw new AwsError('DuplicateLoadBalancerName', `A load balancer with the same name '${input.name}' exists, but with different settings`);
  const subnets = input.subnetIds.map((id) => getSubnet(env, id));
  if (subnets.some((s) => s.vpcId !== input.vpcId)) throw new AwsError('InvalidSubnet', 'All subnets must belong to the same VPC');
  const azs = new Set(subnets.map((s) => s.availabilityZone));
  if (azs.size !== subnets.length) throw new AwsError('InvalidConfigurationRequest', 'A load balancer cannot be attached to multiple subnets in the same Availability Zone');
  if (azs.size < 2) throw new AwsError('ValidationError', 'At least two subnets in two different Availability Zones must be specified');
  if (!input.securityGroupIds.length) throw new AwsError('ValidationError', 'At least one security group must be specified');
  for (const id of input.securityGroupIds) if (getSg(env, id).vpcId !== input.vpcId) throw new AwsError('InvalidSecurityGroup', `Security group '${id}' does not belong to VPC '${input.vpcId}'`);
  const ports = new Set<number>();
  for (const l of input.listeners) {
    if (ports.has(l.port)) throw new AwsError('DuplicateListener', `A listener already exists on this port for this load balancer`);
    ports.add(l.port);
    const tg = getTg(env, l.targetGroupArn);
    if (tg.vpcId !== input.vpcId) throw new AwsError('ValidationError', `Target group '${tg.targetGroupArn}' is not in the same VPC as the load balancer`);
    if (lbsForTargetGroup(env, tg.targetGroupArn).length)
      throw new AwsError('TargetGroupAssociationLimit', `The following target groups cannot be associated with more than one load balancer: ${tg.targetGroupArn}`);
  }
  const id = randomHex(16);
  const arn = `arn:aws:elasticloadbalancing:${env.region}:${env.accountId}:loadbalancer/app/${input.name}/${id}`;
  const nodeIps: Record<string, string> = {};
  for (const s of subnets) nodeIps[s.subnetId] = allocateIp(env, s.subnetId);
  env.loadBalancers.push({
    loadBalancerArn: arn,
    loadBalancerName: input.name,
    dnsName: `${input.scheme === 'internal' ? 'internal-' : ''}${input.name}-${randomDigits(10)}.${env.region}.elb.amazonaws.com`.toLowerCase(),
    type: 'application',
    scheme: input.scheme,
    ipAddressType: 'ipv4',
    vpcId: input.vpcId,
    state: 'provisioning',
    stateChangedAt: now,
    createdTime: new Date(now).toISOString(),
    subnetIds: [...input.subnetIds],
    nodeIps,
    securityGroupIds: [...input.securityGroupIds],
    listeners: input.listeners.map((l) => ({ listenerArn: `${arn.replace(':loadbalancer/', ':listener/')}/${randomHex(16)}`, protocol: 'HTTP', port: l.port, targetGroupArn: l.targetGroupArn })),
  });
  const lb = env.loadBalancers[env.loadBalancers.length - 1];
  trail(env, { source: 'elasticloadbalancing', name: 'CreateLoadBalancer', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', arn]], request: { name: input.name, subnets: input.subnetIds, securityGroups: input.securityGroupIds, scheme: input.scheme, type: 'application', ipAddressType: 'ipv4' }, response: { loadBalancers: [{ loadBalancerArn: arn, dNSName: lb.dnsName, state: { code: 'provisioning' } }] } });
  for (const l of lb.listeners)
    trail(env, { source: 'elasticloadbalancing', name: 'CreateListener', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', arn]], request: { loadBalancerArn: arn, protocol: 'HTTP', port: l.port, defaultActions: [{ type: 'forward', targetGroupArn: l.targetGroupArn }] }, response: { listeners: [{ listenerArn: l.listenerArn }] } });
  return arn;
}

/** DeleteLoadBalancer: its listeners go with it; the target groups (and their targets) stay. */
export function deleteLoadBalancer(env: AwsEnv, arn: string) {
  const lb = getLb(env, arn);
  env.loadBalancers = env.loadBalancers.filter((l) => l !== lb);
  trail(env, { source: 'elasticloadbalancing', name: 'DeleteLoadBalancer', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', arn]], request: { loadBalancerArn: arn }, response: null });
}

export function setLoadBalancerSecurityGroups(env: AwsEnv, arn: string, groupIds: string[]) {
  const lb = getLb(env, arn);
  if (!groupIds.length) throw new AwsError('ValidationError', 'At least one security group must be specified');
  for (const id of groupIds) if (getSg(env, id).vpcId !== lb.vpcId) throw new AwsError('InvalidSecurityGroup', `Security group '${id}' does not belong to VPC '${lb.vpcId}'`);
  lb.securityGroupIds = [...groupIds];
  trail(env, { source: 'elasticloadbalancing', name: 'SetSecurityGroups', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', arn]], request: { loadBalancerArn: arn, securityGroups: groupIds }, response: { securityGroupIds: groupIds } });
}

export function advanceLoadBalancers(env: AwsEnv, now: number): boolean {
  let changed = false;
  for (const lb of env.loadBalancers) {
    if (lb.state === 'provisioning' && now - lb.stateChangedAt >= LB_PROVISION_MS) {
      lb.state = 'active';
      lb.stateChangedAt = now;
      changed = true;
    }
  }
  return changed;
}

// ---------- health checks ----------

export type TargetHealthState = 'initial' | 'healthy' | 'unhealthy' | 'unused' | 'draining' | 'unavailable';

export interface TargetHealth {
  state: TargetHealthState;
  reason?: string;
  description?: string;
}

/** "200", "200,302", "200-299" -> predicate. null if invalid. */
export function parseMatcher(matcher: string): ((code: number) => boolean) | null {
  const parts = matcher.split(',').map((p) => p.trim());
  const ranges: [number, number][] = [];
  for (const p of parts) {
    const m = /^(\d{3})(?:-(\d{3}))?$/.exec(p);
    if (!m) return null;
    const from = Number(m[1]);
    const to = Number(m[2] ?? m[1]);
    if (from < 200 || to > 499 || from > to) return null;
    ranges.push([from, to]);
  }
  return (code) => ranges.some(([a, b]) => code >= a && code <= b);
}

export function healthCheckPort(tg: TargetGroup, target: RegisteredTarget): number {
  return tg.healthCheck.port === 'traffic-port' ? target.port : tg.healthCheck.port;
}

/**
 * Health of one registered target, with the same state / reason codes the ELB console shows.
 * ponytail: evaluated instantly from the current config; real ELB needs healthy/unhealthy threshold x interval seconds.
 */
export function targetHealth(env: AwsEnv, tgArn: string, target: RegisteredTarget): TargetHealth {
  const tg = getTg(env, tgArn);
  const lbs = lbsForTargetGroup(env, tgArn);
  if (!lbs.length) return { state: 'unused', reason: 'Target.NotInUse', description: 'Target group is not configured to receive traffic from the load balancer' };
  const lb = lbs[0];
  const b = backendOf(env, tg, target);
  if (!b || b.gone) return { state: 'unused', reason: 'Target.InvalidState', description: `Target is in the ${b?.kind === 'task' || tg.targetType === 'ip' ? 'stopped' : 'terminated'} state` };
  if (!b.running && !b.starting) return { state: 'unused', reason: 'Target.InvalidState', description: 'Target is in the stopped state' };
  if (lb.state === 'provisioning') return { state: 'initial', reason: 'Elb.RegistrationInProgress', description: 'Target registration is in progress' };
  if (b.starting) return { state: 'initial', reason: 'Elb.InitialHealthChecking', description: 'Initial health checks in progress' };
  const lbAzs = lb.subnetIds.map((s) => env.subnets.find((x) => x.subnetId === s)?.availabilityZone);
  if (!lbAzs.includes(b.availabilityZone)) return { state: 'unused', reason: 'Target.NotInUse', description: 'Target is in an Availability Zone that is not enabled for the load balancer' };
  const port = healthCheckPort(tg, target);
  // Health checks come from every load balancer node, through the LB's and the target's security groups.
  if (!canConnect(env, lb.loadBalancerArn, b.id, 'tcp', port).ok) return { state: 'unhealthy', reason: 'Target.Timeout', description: 'Request timed out' };
  const app = b.app;
  if (!app || app.port !== port) return { state: 'unhealthy', reason: 'Target.FailedHealthChecks', description: 'Health checks failed' };
  const code = app.healthCheckPath === tg.healthCheck.path ? 200 : 404;
  if (!parseMatcher(tg.healthCheck.matcher)?.(code)) return { state: 'unhealthy', reason: 'Target.ResponseCodeMismatch', description: `Health checks failed with these codes: [${code}]` };
  return { state: 'healthy' };
}

export function isTargetHealthy(env: AwsEnv, tgArn: string, target: RegisteredTarget): boolean {
  return targetHealth(env, tgArn, target).state === 'healthy';
}
