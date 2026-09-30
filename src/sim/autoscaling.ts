import { trail, withActor, type Actor } from './cloudtrail';
import { instanceCpuAt, instanceCpuSampler, requestsPerSecond } from './cloudwatch';
import { AMIS, runInstances, terminateInstances } from './ec2';
import { deregisterTargets, isTargetHealthy, registerTargets } from './elb';
import { getSg, getSubnet, getTg } from './env';
import { newId, newUuid } from './ids';
import { AwsError, type AsgInstance, type AutoScalingGroup, type AwsEnv, type LaunchTemplate, type LaunchTemplateVersion, type SimulatedApp, type TargetTrackingPolicy } from './types';

/**
 * EC2 Auto Scaling. advanceAutoScaling() runs with the clock (store tick) and does what the service does:
 * replace unhealthy instances, apply target tracking, and launch / terminate to match the desired capacity.
 * ponytail: target tracking reacts to the live CPU after short holds (20 s out / 60 s in) instead of
 * CloudWatch alarms over 3 / 15 minutes, so lessons don't wait; the activity history still reads like AWS.
 */

export const SCALE_OUT_HOLD_MS = 20_000;
export const SCALE_IN_HOLD_MS = 60_000;

/** a launch template's user data that starts the web app makes its instances serve it */
export function appFromUserData(userData = ''): SimulatedApp | undefined {
  if (!/\bwebapp\b/.test(userData)) return undefined;
  return { port: Number(/--port[= ](\d+)/.exec(userData)?.[1] ?? 3000), healthCheckPath: '/health' };
}

const asgActor = (env: AwsEnv): Actor => ({ userName: 'AutoScaling', type: 'AssumedRole', arn: `arn:aws:sts::${env.accountId}:assumed-role/AWSServiceRoleForAutoScaling/AutoScaling`, sourceIPAddress: 'autoscaling.amazonaws.com', userAgent: 'autoscaling.amazonaws.com' });
const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

export interface LaunchTemplateInput {
  name: string;
  description?: string;
  imageId: string;
  instanceType: string;
  keyName?: string;
  securityGroupIds: string[];
  userData?: string;
  detailedMonitoring: boolean;
}

export function createLaunchTemplate(env: AwsEnv, input: LaunchTemplateInput, now = Date.now()): string {
  const name = input.name.trim();
  if (!/^[a-zA-Z0-9().\-/_]{3,128}$/.test(name)) throw new AwsError('InvalidLaunchTemplateName.MalformedException', 'A launch template name must be between 3 and 128 characters, and may contain letters, numbers, and the following characters: - ( ) . / _.');
  if (env.launchTemplates.some((t) => t.launchTemplateName === name)) throw new AwsError('InvalidLaunchTemplateName.AlreadyExistsException', `Launch template name already in use.`);
  if (!AMIS.some((a) => a.imageId === input.imageId)) throw new AwsError('InvalidAMIID.NotFound', `The image id '[${input.imageId}]' does not exist`);
  if (!input.securityGroupIds.length) throw new AwsError('InvalidParameterValue', 'At least one security group must be specified.');
  input.securityGroupIds.forEach((g) => getSg(env, g));
  const launchTemplateId = newId('lt');
  const v: LaunchTemplateVersion = { versionNumber: 1, versionDescription: input.description, imageId: input.imageId, instanceType: input.instanceType, keyName: input.keyName, securityGroupIds: [...input.securityGroupIds], userData: input.userData, detailedMonitoring: input.detailedMonitoring, createTime: new Date(now).toISOString() };
  env.launchTemplates.push({ launchTemplateId, launchTemplateName: name, defaultVersionNumber: 1, latestVersionNumber: 1, versions: [v], createTime: v.createTime });
  trail(env, { source: 'ec2', name: 'CreateLaunchTemplate', resources: [['AWS::EC2::LaunchTemplate', launchTemplateId]], request: { launchTemplateName: name, launchTemplateData: { imageId: input.imageId, instanceType: input.instanceType, securityGroupIds: input.securityGroupIds, monitoring: { enabled: input.detailedMonitoring } } }, response: { launchTemplate: { launchTemplateId, launchTemplateName: name, defaultVersionNumber: 1, latestVersionNumber: 1 } } });
  return launchTemplateId;
}

export const getLaunchTemplate = (env: AwsEnv, id: string): LaunchTemplate => {
  const t = env.launchTemplates.find((x) => x.launchTemplateId === id);
  if (!t) throw new AwsError('InvalidLaunchTemplateId.NotFound', `The specified launch template, with template ID ${id}, does not exist.`);
  return t;
};

export const templateVersion = (t: LaunchTemplate, v: '$Default' | '$Latest') => t.versions.find((x) => x.versionNumber === (v === '$Latest' ? t.latestVersionNumber : t.defaultVersionNumber))!;

export function getAsg(env: AwsEnv, name: string): AutoScalingGroup {
  const g = env.autoScalingGroups.find((x) => x.autoScalingGroupName === name);
  if (!g) throw new AwsError('ValidationError', `AutoScalingGroup name not found - AutoScalingGroup '${name}' not found`);
  return g;
}

function checkSize(min: number, max: number, desired: number) {
  if (![min, max, desired].every((n) => Number.isInteger(n) && n >= 0)) throw new AwsError('ValidationError', 'Capacity values must be non-negative integers.');
  if (min > max) throw new AwsError('ValidationError', `The minimum size of the group (${min}) must be less than or equal to the maximum size (${max}).`);
  if (desired < min || desired > max) throw new AwsError('ValidationError', `Desired capacity:${desired} must be between the specified min size:${min} and max size:${max}`);
}

export interface CreateAsgInput {
  name: string;
  launchTemplateId: string;
  version?: '$Default' | '$Latest';
  minSize: number;
  maxSize: number;
  desiredCapacity: number;
  subnetIds: string[];
  targetGroupArns: string[];
  healthCheckType: 'EC2' | 'ELB';
  healthCheckGracePeriod?: number;
}

export function createAutoScalingGroup(env: AwsEnv, input: CreateAsgInput, now = Date.now()): string {
  const name = input.name.trim();
  if (!/^[\x20-\x7e]{1,255}$/.test(name) || name.includes(':')) throw new AwsError('ValidationError', 'AutoScalingGroupName must be 1-255 characters and must not contain ":".');
  if (env.autoScalingGroups.some((g) => g.autoScalingGroupName === name)) throw new AwsError('AlreadyExists', `AutoScalingGroup by this name already exists - A group with the name ${name} already exists`);
  checkSize(input.minSize, input.maxSize, input.desiredCapacity);
  const lt = getLaunchTemplate(env, input.launchTemplateId);
  const v = templateVersion(lt, input.version ?? '$Default');
  if (!input.subnetIds.length) throw new AwsError('ValidationError', 'At least one subnet must be specified (VPCZoneIdentifier).');
  const subnets = input.subnetIds.map((s) => getSubnet(env, s));
  const vpcId = subnets[0].vpcId;
  if (subnets.some((s) => s.vpcId !== vpcId)) throw new AwsError('ValidationError', 'The subnets must all belong to the same VPC.');
  if (v.securityGroupIds.some((g) => getSg(env, g).vpcId !== vpcId)) throw new AwsError('ValidationError', `The security groups of the launch template and the subnets belong to different VPCs.`);
  for (const arn of input.targetGroupArns) if (getTg(env, arn).vpcId !== vpcId) throw new AwsError('ValidationError', `Target group ${arn} is not in the same VPC as the subnets.`);
  const arn = `arn:aws:autoscaling:${env.region}:${env.accountId}:autoScalingGroup:${newUuid()}:autoScalingGroupName/${name}`;
  env.autoScalingGroups.push({
    autoScalingGroupName: name,
    autoScalingGroupARN: arn,
    launchTemplate: { launchTemplateId: lt.launchTemplateId, version: input.version ?? '$Default' },
    minSize: input.minSize,
    maxSize: input.maxSize,
    desiredCapacity: input.desiredCapacity,
    subnetIds: [...input.subnetIds],
    targetGroupArns: [...input.targetGroupArns],
    healthCheckType: input.healthCheckType,
    healthCheckGracePeriod: input.healthCheckGracePeriod ?? 300,
    instances: [],
    policies: [],
    activities: [],
    desiredHistory: [{ at: now, value: input.desiredCapacity }],
    createdTime: new Date(now).toISOString(),
  });
  trail(env, { source: 'autoscaling', name: 'CreateAutoScalingGroup', resources: [['AWS::AutoScaling::AutoScalingGroup', arn]], request: { autoScalingGroupName: name, launchTemplate: { launchTemplateId: lt.launchTemplateId, version: input.version ?? '$Default' }, minSize: input.minSize, maxSize: input.maxSize, desiredCapacity: input.desiredCapacity, vPCZoneIdentifier: input.subnetIds.join(','), targetGroupARNs: input.targetGroupArns, healthCheckType: input.healthCheckType }, response: null });
  advanceAutoScaling(env, now);
  return name;
}

function setDesired(g: AutoScalingGroup, value: number, now: number, cause: string) {
  if (value === g.desiredCapacity) return;
  g.desiredHistory.push({ at: now, value });
  const from = g.desiredCapacity;
  g.desiredCapacity = value;
  g.activities.unshift({ activityId: newUuid(), startTime: now, statusCode: 'Successful', description: `Setting desired capacity from ${from} to ${value}`, cause: `At ${iso(now)} ${cause} changing the desired capacity from ${from} to ${value}.` });
}

export interface AsgChanges {
  minSize?: number;
  maxSize?: number;
  desiredCapacity?: number;
  version?: '$Default' | '$Latest';
  subnetIds?: string[];
  targetGroupArns?: string[];
  healthCheckType?: 'EC2' | 'ELB';
  healthCheckGracePeriod?: number;
}

/**
 * The console's "編集": UpdateAutoScalingGroup plus Attach/DetachLoadBalancerTargetGroups.
 * New subnets only affect instances launched from now on; target group changes (de)register the running ones.
 */
export function updateAutoScalingGroup(env: AwsEnv, name: string, c: AsgChanges, now = Date.now()) {
  const g = getAsg(env, name);
  const size = { minSize: c.minSize ?? g.minSize, maxSize: c.maxSize ?? g.maxSize, desiredCapacity: c.desiredCapacity ?? g.desiredCapacity };
  checkSize(size.minSize, size.maxSize, size.desiredCapacity);
  if (c.subnetIds) {
    if (!c.subnetIds.length) throw new AwsError('ValidationError', 'At least one subnet must be specified (VPCZoneIdentifier).');
    const subnets = c.subnetIds.map((id) => getSubnet(env, id));
    const vpcId = getSubnet(env, g.subnetIds[0]).vpcId;
    if (subnets.some((x) => x.vpcId !== vpcId)) throw new AwsError('ValidationError', 'The subnets must all belong to the same VPC as the group.');
  }
  if (c.healthCheckGracePeriod !== undefined && !(Number.isInteger(c.healthCheckGracePeriod) && c.healthCheckGracePeriod >= 0)) throw new AwsError('ValidationError', 'HealthCheckGracePeriod must be a non-negative integer.');
  const vpcId = getSubnet(env, (c.subnetIds ?? g.subnetIds)[0]).vpcId;
  for (const arn of c.targetGroupArns ?? []) if (getTg(env, arn).vpcId !== vpcId) throw new AwsError('ValidationError', `Target group ${arn} is not in the same VPC as the subnets.`);
  const running = g.instances.filter((r) => r.lifecycleState === 'InService').map((r) => env.instances.find((i) => i.instanceId === r.instanceId)!).filter(Boolean);
  if (c.targetGroupArns) {
    const added = c.targetGroupArns.filter((a) => !g.targetGroupArns.includes(a));
    const removed = g.targetGroupArns.filter((a) => !c.targetGroupArns!.includes(a));
    withActor(asgActor(env), now, () => {
      for (const arn of added) registerTargets(env, arn, running.map((i) => ({ id: i.instanceId, port: i.app?.port ?? getTg(env, arn).port })));
      for (const arn of removed) deregisterTargets(env, arn, getTg(env, arn).targets.filter((t) => running.some((i) => i.instanceId === t.id)));
    });
    if (added.length) trail(env, { source: 'autoscaling', name: 'AttachLoadBalancerTargetGroups', resources: [['AWS::AutoScaling::AutoScalingGroup', g.autoScalingGroupARN]], request: { autoScalingGroupName: name, targetGroupARNs: added }, response: null });
    if (removed.length) trail(env, { source: 'autoscaling', name: 'DetachLoadBalancerTargetGroups', resources: [['AWS::AutoScaling::AutoScalingGroup', g.autoScalingGroupARN]], request: { autoScalingGroupName: name, targetGroupARNs: removed }, response: null });
    g.targetGroupArns = [...c.targetGroupArns];
  }
  g.minSize = size.minSize;
  g.maxSize = size.maxSize;
  if (c.version) g.launchTemplate = { ...g.launchTemplate, version: c.version };
  if (c.subnetIds) g.subnetIds = [...c.subnetIds];
  if (c.healthCheckType) g.healthCheckType = c.healthCheckType;
  if (c.healthCheckGracePeriod !== undefined) g.healthCheckGracePeriod = c.healthCheckGracePeriod;
  setDesired(g, size.desiredCapacity, now, `a user request update of AutoScalingGroup constraints to min: ${size.minSize}, max: ${size.maxSize}, desired: ${size.desiredCapacity}`);
  const request = { autoScalingGroupName: name, ...size, healthCheckType: c.healthCheckType, healthCheckGracePeriod: c.healthCheckGracePeriod, vPCZoneIdentifier: c.subnetIds?.join(','), launchTemplate: c.version ? { launchTemplateId: g.launchTemplate.launchTemplateId, version: c.version } : undefined };
  trail(env, { source: 'autoscaling', name: 'UpdateAutoScalingGroup', resources: [['AWS::AutoScaling::AutoScalingGroup', g.autoScalingGroupARN]], request: Object.fromEntries(Object.entries(request).filter(([, v]) => v !== undefined)), response: null });
  advanceAutoScaling(env, now);
}

/** "削除" in the console (ForceDelete): the group goes away and its instances are terminated. */
export function deleteAutoScalingGroup(env: AwsEnv, name: string, now = Date.now()) {
  const g = getAsg(env, name);
  const live = liveInstances(g).map((r) => r.instanceId);
  withActor(asgActor(env), now, () => {
    for (const arn of g.targetGroupArns) deregisterTargets(env, arn, getTg(env, arn).targets.filter((t) => live.includes(t.id)));
    if (live.length) terminateInstances(env, live.filter((id) => env.instances.some((i) => i.instanceId === id && i.state !== 'terminated' && i.state !== 'shutting-down')), now);
  });
  env.autoScalingGroups = env.autoScalingGroups.filter((x) => x !== g);
  trail(env, { source: 'autoscaling', name: 'DeleteAutoScalingGroup', resources: [['AWS::AutoScaling::AutoScalingGroup', g.autoScalingGroupARN]], request: { autoScalingGroupName: name, forceDelete: true }, response: null });
}

export function putTargetTrackingPolicy(env: AwsEnv, name: string, input: { policyName: string; metric: TargetTrackingPolicy['metric']; targetValue: number }) {
  const g = getAsg(env, name);
  const policyName = input.policyName.trim();
  if (!policyName) throw new AwsError('ValidationError', 'PolicyName is required.');
  if (!(input.targetValue > 0)) throw new AwsError('ValidationError', 'TargetValue must be greater than 0.');
  const policyARN = `arn:aws:autoscaling:${env.region}:${env.accountId}:scalingPolicy:${newUuid()}:autoScalingGroupName/${name}:policyName/${policyName}`;
  g.policies = [...g.policies.filter((p) => p.policyName !== policyName), { policyName, policyARN, metric: input.metric, targetValue: input.targetValue }];
  trail(env, { source: 'autoscaling', name: 'PutScalingPolicy', resources: [['AWS::AutoScaling::ScalingPolicy', policyARN]], request: { autoScalingGroupName: name, policyName, policyType: 'TargetTrackingScaling', targetTrackingConfiguration: { predefinedMetricSpecification: { predefinedMetricType: input.metric }, targetValue: input.targetValue } }, response: { policyARN } });
}

export function deletePolicy(env: AwsEnv, name: string, policyName: string) {
  const g = getAsg(env, name);
  g.policies = g.policies.filter((p) => p.policyName !== policyName);
  trail(env, { source: 'autoscaling', name: 'DeletePolicy', resources: [['AWS::AutoScaling::AutoScalingGroup', g.autoScalingGroupARN]], request: { autoScalingGroupName: name, policyName }, response: null });
}

/** The simulator's load generator (not an AWS API). undefined = back to normal traffic. */
export function setTraffic(env: AwsEnv, rps: number | undefined, now = Date.now()) {
  env.traffic = [...(env.traffic ?? []), { at: now, rps }];
}

export const liveInstances = (g: AutoScalingGroup) => g.instances.filter((r) => r.lifecycleState === 'Pending' || r.lifecycleState === 'InService');

/** the metric a policy tracks, right now; undefined while nothing is in service */
export function policyMetric(env: AwsEnv, g: AutoScalingGroup, p: TargetTrackingPolicy, now: number): number | undefined {
  const inService = g.instances.filter((r) => r.lifecycleState === 'InService');
  if (!inService.length) return undefined;
  if (p.metric === 'ALBRequestCountPerTarget') return (requestsPerSecond(env, now) * 60) / inService.length;
  return inService.reduce((a, r) => a + instanceCpuAt(env, r.instanceId, now), 0) / inService.length;
}

function out(env: AwsEnv, g: AutoScalingGroup, r: AsgInstance, now: number, cause: string) {
  r.lifecycleState = 'Terminating';
  r.outOfServiceAt ??= now;
  withActor(asgActor(env), now, () => {
    for (const arn of g.targetGroupArns) {
      const tg = env.targetGroups.find((t) => t.targetGroupArn === arn);
      const reg = tg?.targets.filter((t) => t.id === r.instanceId) ?? [];
      if (reg.length) deregisterTargets(env, arn, reg);
    }
    const i = env.instances.find((x) => x.instanceId === r.instanceId);
    if (i && !['terminated', 'shutting-down'].includes(i.state)) terminateInstances(env, [r.instanceId], now);
  });
  g.activities.unshift({ activityId: newUuid(), startTime: now, statusCode: 'Successful', description: `Terminating EC2 instance: ${r.instanceId}`, cause: `At ${iso(now)} ${cause}` });
}

/** Everything the Auto Scaling service does between two clock ticks. */
export function advanceAutoScaling(env: AwsEnv, now: number): boolean {
  // scenarios settle with now = Infinity; the service only acts on real clock ticks
  if (!Number.isFinite(now)) return false;
  let changed = false;
  for (const g of env.autoScalingGroups ?? []) {
    const before = JSON.stringify([g.instances, g.desiredCapacity, g.policies]);
    // 1. lifecycle and health
    for (const r of g.instances) {
      const i = env.instances.find((x) => x.instanceId === r.instanceId);
      if (r.lifecycleState === 'Terminating') {
        if (!i || i.state === 'terminated') r.lifecycleState = 'Terminated';
        continue;
      }
      if (r.lifecycleState === 'Terminated') continue;
      if (!i || ['stopping', 'stopped', 'shutting-down', 'terminated'].includes(i.state)) {
        r.healthStatus = 'Unhealthy';
        out(env, g, r, now, 'an instance was taken out of service in response to an EC2 health check indicating it has been terminated or stopped.');
        continue;
      }
      if (r.lifecycleState === 'Pending' && i.state === 'running') {
        r.lifecycleState = 'InService';
        r.inServiceAt = now;
        const app = i.app;
        withActor(asgActor(env), now, () => g.targetGroupArns.forEach((arn) => registerTargets(env, arn, [{ id: i.instanceId, port: app?.port ?? getTg(env, arn).port }])));
      }
      if (g.healthCheckType === 'ELB' && r.lifecycleState === 'InService' && now - (r.inServiceAt ?? now) > g.healthCheckGracePeriod * 1000) {
        const unhealthy = g.targetGroupArns.some((arn) => getTg(env, arn).targets.filter((t) => t.id === r.instanceId).some((t) => !isTargetHealthy(env, arn, t)));
        if (unhealthy) {
          r.healthStatus = 'Unhealthy';
          out(env, g, r, now, 'an instance was taken out of service in response to an ELB system health check failure.');
        }
      }
    }
    // 2. target tracking
    for (const p of g.policies) {
      const v = policyMetric(env, g, p, now);
      if (v === undefined) continue;
      const inService = g.instances.filter((r) => r.lifecycleState === 'InService').length;
      const want = Math.min(g.maxSize, Math.max(g.minSize, Math.ceil((inService * v) / p.targetValue)));
      const alarm = `a monitor alarm TargetTracking-${g.autoScalingGroupName}-Alarm${v > p.targetValue ? 'High' : 'Low'}-${p.policyARN.slice(-12, -1)} in state ALARM triggered policy ${p.policyName}`;
      if (v > p.targetValue) {
        p.lowSince = undefined;
        p.highSince ??= now;
        if (now - p.highSince >= SCALE_OUT_HOLD_MS && want > g.desiredCapacity) {
          setDesired(g, want, now, alarm);
          p.highSince = undefined;
        }
      } else if (v < p.targetValue * 0.9) {
        p.highSince = undefined;
        p.lowSince ??= now;
        if (now - p.lowSince >= SCALE_IN_HOLD_MS && want < g.desiredCapacity) {
          setDesired(g, want, now, alarm);
          p.lowSince = undefined;
        }
      } else {
        p.highSince = undefined;
        p.lowSince = undefined;
      }
    }
    // 3. match the desired capacity
    const lt = env.launchTemplates.find((t) => t.launchTemplateId === g.launchTemplate.launchTemplateId);
    const live = liveInstances(g);
    const perAz = (az: string) => liveInstances(g).filter((r) => r.availabilityZone === az).length;
    if (live.length < g.desiredCapacity && lt) {
      const v = templateVersion(lt, g.launchTemplate.version);
      for (let n = live.length; n < g.desiredCapacity; n++) {
        // spread over the AZs: the subnet whose AZ has the fewest instances
        const subnet = g.subnetIds.map((s) => getSubnet(env, s)).sort((a, b) => perAz(a.availabilityZone) - perAz(b.availabilityZone))[0];
        const [id] = withActor(asgActor(env), now, () => runInstances(env, { name: g.autoScalingGroupName, imageId: v.imageId, instanceType: v.instanceType, keyName: v.keyName, subnetId: subnet.subnetId, securityGroupIds: v.securityGroupIds, app: appFromUserData(v.userData) }, now));
        const i = env.instances.find((x) => x.instanceId === id)!;
        i.detailedMonitoring = v.detailedMonitoring;
        i.tags.push({ key: 'aws:autoscaling:groupName', value: g.autoScalingGroupName });
        g.instances.push({ instanceId: id, lifecycleState: 'Pending', healthStatus: 'Healthy', availabilityZone: subnet.availabilityZone, launchTemplateVersion: String(v.versionNumber), launchedAt: now });
        g.activities.unshift({ activityId: newUuid(), startTime: now, statusCode: 'Successful', description: `Launching a new EC2 instance: ${id}`, cause: `At ${iso(now)} an instance was started in response to a difference between desired and actual capacity, increasing the capacity from ${n} to ${n + 1}.` });
      }
    } else if (live.length > g.desiredCapacity) {
      for (let n = live.length; n > g.desiredCapacity; n--) {
        // default termination policy: the AZ with the most instances, then the oldest instance
        const pick = liveInstances(g).sort((a, b) => perAz(b.availabilityZone) - perAz(a.availabilityZone) || a.launchedAt - b.launchedAt)[0];
        out(env, g, pick, now, `an instance was taken out of service in response to a difference between desired and actual capacity, shrinking the capacity from ${n} to ${n - 1}.`);
      }
    }
    // 4. keep a day of history for the metrics
    g.instances = g.instances.filter((r) => r.lifecycleState !== 'Terminated' || now - (r.outOfServiceAt ?? now) < 86_400_000);
    g.activities = g.activities.slice(0, 100);
    if (JSON.stringify([g.instances, g.desiredCapacity, g.policies]) !== before) changed = true;
  }
  return changed;
}


/** What the load test tab plots: req/s, in-service instances and their average CPU, every `step` ms. */
export function loadTestSeries(env: AwsEnv, g: AutoScalingGroup | undefined, start: number, end: number, step: number) {
  const cpu = instanceCpuSampler(env);
  const out: { t: number; rps: number; inService?: number; cpu?: number }[] = [];
  for (let t = Math.floor(start / step) * step; t <= end; t += step) {
    const members = g?.instances.filter((r) => r.inServiceAt !== undefined && r.inServiceAt <= t && t < (r.outOfServiceAt ?? Infinity)) ?? [];
    out.push({ t, rps: requestsPerSecond(env, t), ...(g ? { inService: members.length } : {}), ...(members.length ? { cpu: members.reduce((a, r) => a + cpu(r.instanceId, t), 0) / members.length } : {}) });
  }
  return out;
}
