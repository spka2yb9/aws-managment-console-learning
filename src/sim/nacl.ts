import { ipInCidr, isValidCidr } from './cidr';
import { trail } from './cloudtrail';
import { getNacl, getSubnet, getVpc, nameTags } from './env';
import { newId } from './ids';
import { AwsError, type AwsEnv, type IpProtocol, type NetworkAcl, type NetworkAclEntry } from './types';

export type PortRange = [number, number];

/** The subnet's network ACL (each subnet always has exactly one). */
export function subnetNacl(env: AwsEnv, subnetId: string): NetworkAcl {
  const acl = env.networkAcls.find((a) => a.associations.some((x) => x.subnetId === subnetId));
  if (acl) return acl;
  // Defensive: fall back to the VPC's default ACL.
  const vpcId = getSubnet(env, subnetId).vpcId;
  return env.networkAcls.find((a) => a.vpcId === vpcId && a.isDefault)!;
}

export function entryPorts(e: Pick<NetworkAclEntry, 'protocol' | 'fromPort' | 'toPort'>): PortRange {
  return (e.protocol === 'tcp' || e.protocol === 'udp') && e.fromPort !== undefined ? [e.fromPort, e.toPort ?? e.fromPort] : [0, 65535];
}

export interface NaclEvaluation {
  allowed: boolean;
  /** rule numbers that decided some part of the range ('*' = implicit deny) */
  decidedBy: (number | '*')[];
  /** sub-ranges of the requested ports that end up denied */
  denied: PortRange[];
}

/**
 * First-match evaluation over a port *range* (a client's ephemeral ports). Rules are applied in ascending rule
 * number; each matching rule decides the still-undecided part of the range. Whatever is left hits "*" (deny).
 * allowed = every port in the range is allowed.
 */
export function evaluateNacl(acl: NetworkAcl, egress: boolean, protocol: Exclude<IpProtocol, '-1'>, ports: PortRange, peerIp: string): NaclEvaluation {
  let undecided: PortRange[] = [ports];
  const denied: PortRange[] = [];
  const decidedBy: (number | '*')[] = [];
  const entries = acl.entries.filter((e) => e.egress === egress).sort((a, b) => a.ruleNumber - b.ruleNumber);
  for (const e of entries) {
    if (!undecided.length) break;
    if (e.protocol !== '-1' && e.protocol !== protocol) continue;
    if (!ipInCidr(peerIp, e.cidrBlock)) continue;
    const [lo, hi] = e.protocol === '-1' ? [0, 65535] : entryPorts(e);
    const next: PortRange[] = [];
    let hit = false;
    for (const [a, b] of undecided) {
      const from = Math.max(a, lo);
      const to = Math.min(b, hi);
      if (from > to) {
        next.push([a, b]);
        continue;
      }
      hit = true;
      if (e.ruleAction === 'deny') denied.push([from, to]);
      if (a < from) next.push([a, from - 1]);
      if (to < b) next.push([to + 1, b]);
    }
    if (hit) decidedBy.push(e.ruleNumber);
    undecided = next;
  }
  if (undecided.length) {
    denied.push(...undecided);
    decidedBy.push('*');
  }
  return { allowed: denied.length === 0, decidedBy, denied };
}

export const rangeLabel = ([a, b]: PortRange) => (a === b ? String(a) : `${a}-${b}`);

// ---------- operations ----------

/** Default ACL of a new VPC: rule 100 allows everything in both directions (plus the implicit "*" deny). */
export function createDefaultNacl(env: AwsEnv, vpcId: string): string {
  const networkAclId = newId('acl');
  env.networkAcls.push({
    networkAclId,
    vpcId,
    isDefault: true,
    entries: [
      { ruleNumber: 100, egress: false, protocol: '-1', ruleAction: 'allow', cidrBlock: '0.0.0.0/0' },
      { ruleNumber: 100, egress: true, protocol: '-1', ruleAction: 'allow', cidrBlock: '0.0.0.0/0' },
    ],
    associations: [],
    tags: [],
  });
  return networkAclId;
}

/** A custom ACL starts with no rules: only "*" (deny all) in both directions. */
export function createNetworkAcl(env: AwsEnv, input: { vpcId: string; name?: string }): string {
  getVpc(env, input.vpcId);
  const networkAclId = newId('acl');
  env.networkAcls.push({ networkAclId, vpcId: input.vpcId, isDefault: false, entries: [], associations: [], tags: nameTags(input.name) });
  trail(env, { source: 'ec2', name: 'CreateNetworkAcl', resources: [['AWS::EC2::NetworkAcl', networkAclId], ['AWS::EC2::VPC', input.vpcId]], request: { vpcId: input.vpcId }, response: { networkAcl: { networkAclId, vpcId: input.vpcId, default: false } } });
  return networkAclId;
}

export interface NaclEntryInput {
  ruleNumber: number;
  protocol: IpProtocol;
  ruleAction: 'allow' | 'deny';
  cidrBlock: string;
  fromPort?: number;
  toPort?: number;
}

/** "Edit inbound/outbound rules" submits the whole rule list for one direction. */
export function replaceNetworkAclEntries(env: AwsEnv, networkAclId: string, egress: boolean, inputs: NaclEntryInput[]) {
  const acl = getNacl(env, networkAclId);
  const seen = new Set<number>();
  const entries: NetworkAclEntry[] = inputs.map((i) => {
    if (!Number.isInteger(i.ruleNumber) || i.ruleNumber < 1 || i.ruleNumber > 32766)
      throw new AwsError('InvalidParameterValue', `Invalid value '${i.ruleNumber}' for ruleNumber. It must be an integer between 1 and 32766.`);
    if (seen.has(i.ruleNumber)) throw new AwsError('NetworkAclEntryAlreadyExists', `The network acl entry identified by ${i.ruleNumber} already exists.`);
    seen.add(i.ruleNumber);
    const cidr = i.cidrBlock.trim();
    if (!isValidCidr(cidr)) throw new AwsError('InvalidParameterValue', `Value (${cidr || '(empty)'}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`);
    const e: NetworkAclEntry = { ruleNumber: i.ruleNumber, egress, protocol: i.protocol, ruleAction: i.ruleAction, cidrBlock: cidr };
    if (i.protocol === 'tcp' || i.protocol === 'udp') {
      const from = i.fromPort ?? 0;
      const to = i.toPort ?? from;
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 65535 || from > to) throw new AwsError('InvalidParameterValue', `Invalid port range: ${from}-${to}`);
      e.fromPort = from;
      e.toPort = to;
    }
    return e;
  });
  const old = acl.entries.filter((e) => e.egress === egress);
  acl.entries = [...acl.entries.filter((e) => e.egress !== egress), ...entries];
  const res: [string, string][] = [['AWS::EC2::NetworkAcl', networkAclId]];
  const entry = (e: NetworkAclEntry) => ({ networkAclId, ruleNumber: e.ruleNumber, egress, ruleAction: e.ruleAction, protocol: PROTOCOL_NUMBER[e.protocol], cidrBlock: e.cidrBlock, ...(e.fromPort !== undefined ? { portRange: { from: e.fromPort, to: e.toPort } } : {}) });
  for (const o of old) if (!entries.some((e) => e.ruleNumber === o.ruleNumber)) trail(env, { source: 'ec2', name: 'DeleteNetworkAclEntry', resources: res, request: { networkAclId, ruleNumber: o.ruleNumber, egress } });
  for (const e of entries) {
    const was = old.find((o) => o.ruleNumber === e.ruleNumber);
    if (!was) trail(env, { source: 'ec2', name: 'CreateNetworkAclEntry', resources: res, request: entry(e) });
    else if (JSON.stringify(was) !== JSON.stringify(e)) trail(env, { source: 'ec2', name: 'ReplaceNetworkAclEntry', resources: res, request: entry(e) });
  }
}

const PROTOCOL_NUMBER: Record<IpProtocol, string> = { '-1': '-1', tcp: '6', udp: '17', icmp: '1' };

/** ReplaceNetworkAclAssociation: move one subnet to `networkAclId`. */
export function associateSubnetNacl(env: AwsEnv, subnetId: string, networkAclId: string) {
  const subnet = getSubnet(env, subnetId);
  const acl = getNacl(env, networkAclId);
  if (acl.vpcId !== subnet.vpcId) throw new AwsError('InvalidParameterValue', `Network ACL ${networkAclId} and subnet ${subnetId} belong to different networks`);
  for (const a of env.networkAcls) a.associations = a.associations.filter((x) => x.subnetId !== subnetId);
  acl.associations.push({ networkAclAssociationId: newId('aclassoc'), subnetId });
  trail(env, { source: 'ec2', name: 'ReplaceNetworkAclAssociation', resources: [['AWS::EC2::NetworkAcl', networkAclId], ['AWS::EC2::Subnet', subnetId]], request: { networkAclId, subnetId } });
}

/**
 * "Edit subnet associations": checked subnets move to this ACL; unchecked ones it used to have go back to the
 * VPC's default ACL (a subnet can never be without an ACL, so the default ACL can't give subnets up this way).
 */
export function setNaclSubnetAssociations(env: AwsEnv, networkAclId: string, subnetIds: string[]) {
  const acl = getNacl(env, networkAclId);
  const removed = acl.associations.map((a) => a.subnetId).filter((s) => !subnetIds.includes(s));
  if (acl.isDefault && removed.length)
    throw new AwsError('InvalidParameterValue', 'A subnet must always be associated with a network ACL. To move a subnet off the default network ACL, associate it with another network ACL.');
  const def = env.networkAcls.find((a) => a.vpcId === acl.vpcId && a.isDefault)!;
  for (const s of removed) associateSubnetNacl(env, s, def.networkAclId);
  for (const s of subnetIds) if (!acl.associations.some((a) => a.subnetId === s)) associateSubnetNacl(env, s, networkAclId);
}
