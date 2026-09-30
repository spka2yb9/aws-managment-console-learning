import { getInstance, getSg, getSubnet, nameTags } from './env';
import { trail } from './cloudtrail';
import { newId, randomInt } from './ids';
import { AwsError, type AwsEnv, type Instance, type InstanceStateName, type SimulatedApp } from './types';
import { allocateIp } from './vpc';

export const AMIS = [
  { imageId: 'ami-0d52744d6551d851e', name: 'Amazon Linux 2023 AMI', description: 'Amazon Linux 2023 kernel-6.1 AMI', platform: 'Linux/UNIX', user: 'ec2-user' },
  { imageId: 'ami-0b20f552f63953f0e', name: 'Ubuntu Server 24.04 LTS (HVM), SSD Volume Type', description: 'Canonical, Ubuntu, 24.04, amd64 noble image', platform: 'Linux/UNIX', user: 'ubuntu' },
  { imageId: 'ami-0a1b2c3d4e5f60718', name: 'Microsoft Windows Server 2022 Base', description: 'Microsoft Windows Server 2022 Full Locale English AMI', platform: 'Windows', user: 'Administrator' },
];

export const INSTANCE_TYPES = [
  { type: 't3.micro', vcpu: 2, memoryGiB: 1, freeTier: true },
  { type: 't3.small', vcpu: 2, memoryGiB: 2 },
  { type: 't3.medium', vcpu: 2, memoryGiB: 4 },
  { type: 'm7i.large', vcpu: 2, memoryGiB: 8 },
  { type: 'c7i.large', vcpu: 2, memoryGiB: 4 },
];

/** Seconds a transitional state lasts in the simulator (real AWS: tens of seconds). */
export const TRANSITION_MS = 3000;

export const STATE_CODES: Record<InstanceStateName, number> = { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 };

function publicIp() {
  // 203.0.113.0/24 is TEST-NET-3: never a real address.
  return `203.0.113.${10 + randomInt(240)}`;
}

export function publicDnsName(env: AwsEnv, ip: string) {
  return `ec2-${ip.replaceAll('.', '-')}.${env.region}.compute.amazonaws.com`;
}

export function privateDnsName(env: AwsEnv, ip: string) {
  return `ip-${ip.replaceAll('.', '-')}.${env.region}.compute.internal`;
}

export interface RunInstancesInput {
  name?: string;
  imageId: string;
  instanceType: string;
  keyName?: string;
  subnetId: string;
  securityGroupIds: string[];
  /** undefined = subnet default (mapPublicIpOnLaunch) */
  associatePublicIpAddress?: boolean;
  count?: number;
  app?: SimulatedApp;
  privateIpAddress?: string;
}

export function runInstances(env: AwsEnv, input: RunInstancesInput, now = Date.now()): string[] {
  const subnet = getSubnet(env, input.subnetId);
  if (!input.securityGroupIds.length) throw new AwsError('InvalidParameterValue', 'At least one security group must be specified.');
  for (const id of input.securityGroupIds) {
    if (getSg(env, id).vpcId !== subnet.vpcId) throw new AwsError('InvalidParameter', `Security group ${id} and subnet ${subnet.subnetId} belong to different networks.`);
  }
  if (input.keyName && !env.keyPairs.includes(input.keyName)) throw new AwsError('InvalidKeyPair.NotFound', `The key pair '${input.keyName}' does not exist`);
  const ami = AMIS.find((a) => a.imageId === input.imageId);
  if (!ami) throw new AwsError('InvalidAMIID.NotFound', `The image id '[${input.imageId}]' does not exist`);
  const ids: string[] = [];
  for (let n = 0; n < (input.count ?? 1); n++) {
    const instanceId = newId('i');
    env.instances.push({
      instanceId,
      imageId: input.imageId,
      instanceType: input.instanceType,
      state: 'pending',
      stateChangedAt: now,
      vpcId: subnet.vpcId,
      subnetId: subnet.subnetId,
      availabilityZone: subnet.availabilityZone,
      privateIpAddress: input.privateIpAddress ?? allocateIp(env, subnet.subnetId),
      associatePublicIpAddress: input.associatePublicIpAddress ?? subnet.mapPublicIpOnLaunch,
      securityGroupIds: [...input.securityGroupIds],
      keyName: input.keyName,
      launchTime: new Date(now).toISOString(),
      platformDetails: ami.platform,
      app: input.app,
      tags: nameTags(input.name),
    });
    ids.push(instanceId);
  }
  trail(env, {
    source: 'ec2',
    name: 'RunInstances',
    resources: ids.map((id): [string, string] => ['AWS::EC2::Instance', id]),
    request: { instancesSet: { items: [{ imageId: input.imageId, minCount: ids.length, maxCount: ids.length, ...(input.keyName ? { keyName: input.keyName } : {}) }] }, instanceType: input.instanceType, subnetId: input.subnetId, groupSet: { items: input.securityGroupIds.map((groupId) => ({ groupId })) } },
    response: { instancesSet: { items: ids.map((instanceId) => ({ instanceId, currentState: { code: 0, name: 'pending' } })) } },
  });
  return ids;
}

function instancesEvent(env: AwsEnv, name: string, ids: string[]) {
  trail(env, { source: 'ec2', name, resources: ids.map((id): [string, string] => ['AWS::EC2::Instance', id]), request: { instancesSet: { items: ids.map((instanceId) => ({ instanceId })) } }, response: { instancesSet: { items: ids.map((instanceId) => ({ instanceId, currentState: { name: env.instances.find((i) => i.instanceId === instanceId)?.state } })) } } });
}

function setState(i: Instance, state: InstanceStateName, now: number) {
  i.state = state;
  i.stateChangedAt = now;
}

function incorrectState(i: Instance, action: string): never {
  throw new AwsError('IncorrectInstanceState', `The instance '${i.instanceId}' is not in a state from which it can be ${action}.`);
}

export function stopInstances(env: AwsEnv, ids: string[], now = Date.now()) {
  for (const id of ids) {
    const i = getInstance(env, id);
    if (i.state === 'stopped' || i.state === 'stopping') continue;
    if (i.state !== 'running' && i.state !== 'pending') incorrectState(i, 'stopped');
    setState(i, 'stopping', now);
  }
  instancesEvent(env, 'StopInstances', ids);
}

export function startInstances(env: AwsEnv, ids: string[], now = Date.now()) {
  for (const id of ids) {
    const i = getInstance(env, id);
    if (i.state === 'running' || i.state === 'pending') continue;
    if (i.state !== 'stopped') incorrectState(i, 'started');
    setState(i, 'pending', now);
  }
  instancesEvent(env, 'StartInstances', ids);
}

export function rebootInstances(env: AwsEnv, ids: string[]) {
  for (const id of ids) {
    const i = getInstance(env, id);
    if (i.state !== 'running') incorrectState(i, 'rebooted');
  }
}

export function terminateInstances(env: AwsEnv, ids: string[], now = Date.now()) {
  for (const id of ids) {
    const i = getInstance(env, id);
    if (i.state === 'terminated' || i.state === 'shutting-down') continue;
    setState(i, 'shutting-down', now);
  }
  instancesEvent(env, 'TerminateInstances', ids);
  // Terminated instances are removed from target groups by ELB.
  for (const tg of env.targetGroups) tg.targets = tg.targets.filter((t) => !ids.includes(t.id));
}

export function modifyInstanceSecurityGroups(env: AwsEnv, instanceId: string, groupIds: string[]) {
  const i = getInstance(env, instanceId);
  if (!groupIds.length) throw new AwsError('InvalidParameterValue', 'At least one security group must be specified.');
  for (const id of groupIds) {
    if (getSg(env, id).vpcId !== i.vpcId) throw new AwsError('InvalidGroup.NotFound', `You have specified two resources that belong to different networks.`);
  }
  i.securityGroupIds = [...groupIds];
  trail(env, { source: 'ec2', name: 'ModifyInstanceAttribute', resources: [['AWS::EC2::Instance', instanceId]], request: { instanceId, groupSet: { items: groupIds.map((groupId) => ({ groupId })) } } });
}

/** Finish transitional states whose time has passed. Stop/terminate release the auto-assigned public IP, start gets a new one. */
export function advanceInstances(env: AwsEnv, now: number): boolean {
  let changed = false;
  for (const i of env.instances) {
    if (now - i.stateChangedAt < TRANSITION_MS) continue;
    const next: Partial<Record<InstanceStateName, InstanceStateName>> = { pending: 'running', stopping: 'stopped', 'shutting-down': 'terminated' };
    const to = next[i.state];
    if (!to) continue;
    setState(i, to, Math.min(now, i.stateChangedAt + TRANSITION_MS));
    if (to === 'running' && i.associatePublicIpAddress) i.publicIpAddress = publicIp();
    if (to !== 'running') i.publicIpAddress = undefined;
    changed = true;
  }
  return changed;
}
