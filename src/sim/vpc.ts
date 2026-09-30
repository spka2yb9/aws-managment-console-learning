import { cidrContains, cidrOverlaps, cidrSize, ipInCidr, ipOffset, isValidCidr, nthIp, prefixLength, RESERVED_IPS_PER_SUBNET } from './cidr';
import { trail } from './cloudtrail';
import { getIgw, getNacl, getRouteTable, getSubnet, getVpc, label, nameTags, regionOf } from './env';
import { createDefaultNacl } from './nacl';
import { newId, randomInt } from './ids';
import { AwsError, type AwsEnv, type NatGateway, type Route, type RouteTable, type Subnet } from './types';

// ---------- queries ----------

/** Explicitly associated route table, else the VPC's main route table (same rule as AWS). */
export function effectiveRouteTable(env: AwsEnv, subnetId: string): RouteTable {
  const subnet = getSubnet(env, subnetId);
  return (
    env.routeTables.find((rt) => rt.associations.some((a) => a.subnetId === subnetId)) ??
    env.routeTables.find((rt) => rt.vpcId === subnet.vpcId && rt.associations.some((a) => a.main))!
  );
}

export function isExplicitlyAssociated(env: AwsEnv, subnetId: string): boolean {
  return env.routeTables.some((rt) => rt.associations.some((a) => a.subnetId === subnetId));
}

export function mainRouteTable(env: AwsEnv, vpcId: string): RouteTable {
  return env.routeTables.find((rt) => rt.vpcId === vpcId && rt.associations.some((a) => a.main))!;
}

export type RouteState = 'active' | 'blackhole';

/** A route to an IGW no longer attached to the route table's VPC, or to a deleted NAT gateway, becomes a blackhole. */
export function routeState(env: AwsEnv, rt: RouteTable, route: Route): RouteState {
  if (route.gatewayId === 'local' || route.gatewayId?.startsWith('vpce-')) return 'active';
  if (route.natGatewayId) return (env.natGateways ?? []).some((n) => n.natGatewayId === route.natGatewayId && (n.state === 'available' || n.state === 'pending')) ? 'active' : 'blackhole';
  const igw = env.internetGateways.find((g) => g.internetGatewayId === route.gatewayId);
  return igw?.attachments.some((a) => a.vpcId === rt.vpcId) ? 'active' : 'blackhole';
}

export const routeTarget = (r: Route) => r.natGatewayId ?? r.gatewayId ?? '';

export interface RouteEvaluation {
  route: Route;
  state: RouteState;
  target: { type: 'local' | 'internet-gateway' | 'nat-gateway'; id: string };
}

/**
 * Longest-prefix match over the route table, like the VPC router. A blackhole route still wins the match
 * (traffic is dropped, it does not fall back to a less specific route). null = no matching route.
 */
export function evaluateRoute(env: AwsEnv, routeTableId: string, destinationIp: string): RouteEvaluation | null {
  const rt = getRouteTable(env, routeTableId);
  const best = rt.routes
    .filter((r) => r.destinationCidrBlock && ipInCidr(destinationIp, r.destinationCidrBlock))
    .sort((a, b) => prefixLength(b.destinationCidrBlock) - prefixLength(a.destinationCidrBlock))[0];
  if (!best) return null;
  return {
    route: best,
    state: routeState(env, rt, best),
    target: best.gatewayId === 'local' ? { type: 'local', id: 'local' } : best.natGatewayId ? { type: 'nat-gateway', id: best.natGatewayId } : { type: 'internet-gateway', id: best.gatewayId! },
  };
}

/** Does traffic from this subnet to `ip` leave through an attached internet gateway? */
export function routesToInternet(env: AwsEnv, subnetId: string, ip: string): boolean {
  const ev = evaluateRoute(env, effectiveRouteTable(env, subnetId).routeTableId, ip);
  return ev?.target.type === 'internet-gateway' && ev.state === 'active';
}

/**
 * AWS definition (VPC User Guide, "Subnet types"): a public subnet has a direct route to an internet gateway.
 * Decided purely from routing, never from the subnet name.
 */
export function isPublicSubnet(env: AwsEnv, subnetId: string): boolean {
  const rt = effectiveRouteTable(env, subnetId);
  return rt.routes.some((r) => r.gatewayId?.startsWith('igw-') && routeState(env, rt, r) === 'active');
}

export function usedIps(env: AwsEnv, subnetId: string): string[] {
  return [
    ...env.instances.filter((i) => i.subnetId === subnetId && i.state !== 'terminated').map((i) => i.privateIpAddress),
    ...env.loadBalancers.flatMap((lb) => (lb.nodeIps[subnetId] ? [lb.nodeIps[subnetId]] : [])),
    ...env.dbInstances.filter((d) => d.subnetId === subnetId).map((d) => d.privateIpAddress),
    ...(env.ecsTasks ?? []).filter((t) => t.subnetId === subnetId && t.lastStatus !== 'STOPPED').map((t) => t.privateIpAddress),
  ];
}

export function availableIpCount(env: AwsEnv, subnet: Subnet): number {
  return cidrSize(subnet.cidrBlock) - RESERVED_IPS_PER_SUBNET - usedIps(env, subnet.subnetId).length;
}

/** Pick a free private IP (skipping the 4 reserved at the start and the broadcast address). */
export function allocateIp(env: AwsEnv, subnetId: string): string {
  const subnet = getSubnet(env, subnetId);
  if (availableIpCount(env, subnet) <= 0) throw new AwsError('InsufficientFreeAddressesInSubnet', `There are not enough free addresses in subnet '${subnetId}' to satisfy the requested number of instances.`);
  const used = new Set(usedIps(env, subnetId).map((ip) => ipOffset(subnet.cidrBlock, ip)));
  const usable = cidrSize(subnet.cidrBlock) - RESERVED_IPS_PER_SUBNET;
  let n = 4 + randomInt(usable);
  while (used.has(n)) n = n + 1 >= cidrSize(subnet.cidrBlock) - 1 ? 4 : n + 1;
  return nthIp(subnet.cidrBlock, n);
}

// ---------- operations (mutate the draft env) ----------

function checkBlockSize(cidr: string, kind: 'Vpc' | 'Subnet') {
  if (!isValidCidr(cidr)) throw new AwsError('InvalidParameterValue', `Value (${cidr}) for parameter cidrBlock is invalid. This is not a valid CIDR block.`);
  const p = prefixLength(cidr);
  // Both VPC and subnet IPv4 blocks must be between /16 and /28.
  if (p < 16 || p > 28) throw new AwsError(`Invalid${kind}.Range`, `The CIDR '${cidr}' is invalid.`);
}

export function createVpc(env: AwsEnv, input: { cidrBlock: string; name?: string }): string {
  checkBlockSize(input.cidrBlock, 'Vpc');
  const vpcId = newId('vpc');
  const defaultNetworkAclId = createDefaultNacl(env, vpcId);
  env.vpcs.push({
    vpcId,
    cidrBlock: input.cidrBlock,
    state: 'available',
    isDefault: false,
    instanceTenancy: 'default',
    enableDnsSupport: true,
    enableDnsHostnames: false,
    dhcpOptionsId: env.vpcs[0]?.dhcpOptionsId ?? newId('dopt'),
    defaultNetworkAclId,
    tags: nameTags(input.name),
  });
  // Every VPC comes with a main route table (local route only) and a default security group.
  env.routeTables.push({
    routeTableId: newId('rtb'),
    vpcId,
    routes: [{ destinationCidrBlock: input.cidrBlock, gatewayId: 'local', origin: 'CreateRouteTable' }],
    associations: [{ routeTableAssociationId: newId('rtbassoc'), main: true }],
    tags: [],
  });
  const sgId = newId('sg');
  env.securityGroups.push({
    groupId: sgId,
    groupName: 'default',
    description: 'default VPC security group',
    vpcId,
    ingress: [{ securityGroupRuleId: newId('sgr'), ipProtocol: '-1', fromPort: -1, toPort: -1, referencedGroupId: sgId }],
    egress: [{ securityGroupRuleId: newId('sgr'), ipProtocol: '-1', fromPort: -1, toPort: -1, cidrIpv4: '0.0.0.0/0' }],
    tags: [],
  });
  trail(env, { source: 'ec2', name: 'CreateVpc', resources: [['AWS::EC2::VPC', vpcId]], request: { cidrBlock: input.cidrBlock, instanceTenancy: 'default' }, response: { vpc: { vpcId, state: 'pending', cidrBlock: input.cidrBlock, dhcpOptionsId: env.vpcs[env.vpcs.length - 1].dhcpOptionsId } } });
  return vpcId;
}

export function createSubnet(env: AwsEnv, input: { vpcId: string; cidrBlock: string; availabilityZone: string; name?: string }): string {
  const vpc = getVpc(env, input.vpcId);
  checkBlockSize(input.cidrBlock, 'Subnet');
  if (!regionOf(env.region).azs.includes(input.availabilityZone))
    throw new AwsError('InvalidParameterValue', `Value (${input.availabilityZone}) for parameter availabilityZone is invalid. Subnets can currently only be created in the following availability zones: ${regionOf(env.region).azs.join(', ')}.`);
  if (!cidrContains(vpc.cidrBlock, input.cidrBlock)) throw new AwsError('InvalidSubnet.Range', `The CIDR '${input.cidrBlock}' is invalid.`);
  if (env.subnets.some((s) => s.vpcId === vpc.vpcId && cidrOverlaps(s.cidrBlock, input.cidrBlock)))
    throw new AwsError('InvalidSubnet.Conflict', `The CIDR '${input.cidrBlock}' conflicts with another subnet`);
  const subnetId = newId('subnet');
  env.subnets.push({ subnetId, vpcId: vpc.vpcId, cidrBlock: input.cidrBlock, availabilityZone: input.availabilityZone, mapPublicIpOnLaunch: false, state: 'available', tags: nameTags(input.name) });
  // New subnets start on the VPC's default network ACL.
  getNacl(env, vpc.defaultNetworkAclId).associations.push({ networkAclAssociationId: newId('aclassoc'), subnetId });
  trail(env, { source: 'ec2', name: 'CreateSubnet', resources: [['AWS::EC2::Subnet', subnetId], ['AWS::EC2::VPC', vpc.vpcId]], request: { vpcId: vpc.vpcId, cidrBlock: input.cidrBlock, availabilityZone: input.availabilityZone }, response: { subnet: { subnetId, state: 'available' } } });
  return subnetId;
}

export function modifySubnetAttribute(env: AwsEnv, subnetId: string, attrs: { mapPublicIpOnLaunch: boolean }) {
  getSubnet(env, subnetId).mapPublicIpOnLaunch = attrs.mapPublicIpOnLaunch;
  trail(env, { source: 'ec2', name: 'ModifySubnetAttribute', resources: [['AWS::EC2::Subnet', subnetId]], request: { subnetId, mapPublicIpOnLaunch: { value: attrs.mapPublicIpOnLaunch } } });
}

export function createRouteTable(env: AwsEnv, input: { vpcId: string; name?: string }): string {
  const vpc = getVpc(env, input.vpcId);
  const routeTableId = newId('rtb');
  env.routeTables.push({
    routeTableId,
    vpcId: vpc.vpcId,
    routes: [{ destinationCidrBlock: vpc.cidrBlock, gatewayId: 'local', origin: 'CreateRouteTable' }],
    associations: [],
    tags: nameTags(input.name),
  });
  trail(env, { source: 'ec2', name: 'CreateRouteTable', resources: [['AWS::EC2::RouteTable', routeTableId], ['AWS::EC2::VPC', vpc.vpcId]], request: { vpcId: vpc.vpcId }, response: { routeTable: { routeTableId, vpcId: vpc.vpcId } } });
  return routeTableId;
}

/**
 * "Edit routes" submits the complete desired route list. The local route is immutable;
 * every other route is validated like CreateRoute / ReplaceRoute would.
 */
export function replaceRoutes(env: AwsEnv, routeTableId: string, desired: { destinationCidrBlock: string; gatewayId: string }[]) {
  const rt = getRouteTable(env, routeTableId);
  const vpc = getVpc(env, rt.vpcId);
  const local = rt.routes.find((r) => r.gatewayId === 'local')!;
  const custom = desired.filter((r) => r.gatewayId !== 'local');
  const seen = new Set<string>([local.destinationCidrBlock]);
  for (const r of custom) {
    const dest = r.destinationCidrBlock.trim();
    if (!isValidCidr(dest)) throw new AwsError('InvalidParameterValue', `Value (${dest}) for parameter destinationCidrBlock is invalid. This is not a valid CIDR block.`);
    if (seen.has(dest)) throw new AwsError('RouteAlreadyExists', `The route identified by ${dest} already exists.`);
    seen.add(dest);
    if (!r.gatewayId) throw new AwsError('MissingParameter', 'The request must contain exactly one of gatewayId, natGatewayId, networkInterfaceId, vpcPeeringConnectionId or instanceId');
    if (r.gatewayId.startsWith('nat-')) {
      const nat = (env.natGateways ?? []).find((n) => n.natGatewayId === r.gatewayId && n.state !== 'deleted');
      if (!nat) throw new AwsError('InvalidNatGatewayID.NotFound', `The natGateway ID '${r.gatewayId}' does not exist`);
      if (nat.vpcId !== rt.vpcId) throw new AwsError('InvalidParameterValue', `route table ${routeTableId} and network gateway ${r.gatewayId} belong to different networks`);
    } else {
      const igw = getIgw(env, r.gatewayId);
      if (!igw.attachments.some((a) => a.vpcId === rt.vpcId))
        throw new AwsError('InvalidParameterValue', `route table ${routeTableId} and network gateway ${r.gatewayId} belong to different networks`);
    }
    if (cidrContains(vpc.cidrBlock, dest))
      throw new AwsError('InvalidParameterValue', `The destination CIDR block ${dest} is equal to or more specific than one of this VPC's CIDR blocks. This route can target only an interface or an instance.`);
  }
  const old = rt.routes;
  // gateway endpoint routes are managed by the endpoint, not by this edit
  const endpointRoutes = old.filter((r) => r.destinationPrefixListId);
  rt.routes = [local, ...custom.map((r): Route => ({ destinationCidrBlock: r.destinationCidrBlock.trim(), ...(r.gatewayId.startsWith('nat-') ? { natGatewayId: r.gatewayId } : { gatewayId: r.gatewayId }), origin: 'CreateRoute' })), ...endpointRoutes];
  // the console applies the edit as DeleteRoute / ReplaceRoute / CreateRoute calls
  const res: [string, string][] = [['AWS::EC2::RouteTable', routeTableId]];
  for (const o of old) if (o !== local && !o.destinationPrefixListId && !rt.routes.some((r) => r.destinationCidrBlock === o.destinationCidrBlock)) trail(env, { source: 'ec2', name: 'DeleteRoute', resources: res, request: { routeTableId, destinationCidrBlock: o.destinationCidrBlock } });
  for (const r of rt.routes.slice(1)) {
    if (r.destinationPrefixListId) continue;
    const was = old.find((o) => o.destinationCidrBlock === r.destinationCidrBlock);
    const target = r.natGatewayId ? { natGatewayId: r.natGatewayId } : { gatewayId: r.gatewayId };
    if (!was) trail(env, { source: 'ec2', name: 'CreateRoute', resources: res, request: { routeTableId, destinationCidrBlock: r.destinationCidrBlock, ...target } });
    else if (routeTarget(was) !== routeTarget(r)) trail(env, { source: 'ec2', name: 'ReplaceRoute', resources: res, request: { routeTableId, destinationCidrBlock: r.destinationCidrBlock, ...target } });
  }
}

/** "Edit subnet associations": the checked subnets become explicitly associated with this table (moved from any other). */
export function setSubnetAssociations(env: AwsEnv, routeTableId: string, subnetIds: string[]) {
  const rt = getRouteTable(env, routeTableId);
  for (const id of subnetIds) {
    const s = getSubnet(env, id);
    if (s.vpcId !== rt.vpcId) throw new AwsError('InvalidParameterValue', `route table ${routeTableId} and subnet ${id} belong to different networks`);
  }
  for (const other of env.routeTables) {
    if (other !== rt) other.associations = other.associations.filter((a) => !a.subnetId || !subnetIds.includes(a.subnetId));
  }
  const keep = rt.associations.filter((a) => a.main || (a.subnetId && subnetIds.includes(a.subnetId)));
  const existing = new Set(keep.map((a) => a.subnetId));
  const dropped = rt.associations.filter((a) => !keep.includes(a));
  rt.associations = [...keep, ...subnetIds.filter((id) => !existing.has(id)).map((subnetId) => ({ routeTableAssociationId: newId('rtbassoc'), main: false, subnetId }))];
  for (const a of dropped) trail(env, { source: 'ec2', name: 'DisassociateRouteTable', resources: [['AWS::EC2::RouteTable', routeTableId]], request: { associationId: a.routeTableAssociationId } });
  for (const a of rt.associations.filter((x) => x.subnetId && !existing.has(x.subnetId)))
    trail(env, { source: 'ec2', name: 'AssociateRouteTable', resources: [['AWS::EC2::RouteTable', routeTableId], ['AWS::EC2::Subnet', a.subnetId!]], request: { routeTableId, subnetId: a.subnetId }, response: { associationId: a.routeTableAssociationId } });
}

/** Subnet page "Edit route table association": pick the table for one subnet (the main table = no explicit association). */
export function associateSubnetRouteTable(env: AwsEnv, subnetId: string, routeTableId: string) {
  const rt = getRouteTable(env, routeTableId);
  for (const other of env.routeTables) other.associations = other.associations.filter((a) => a.subnetId !== subnetId);
  if (!rt.associations.some((a) => a.main)) setSubnetAssociations(env, routeTableId, [...rt.associations.filter((a) => a.subnetId).map((a) => a.subnetId!), subnetId]);
}

export function createInternetGateway(env: AwsEnv, input: { name?: string }): string {
  const internetGatewayId = newId('igw');
  env.internetGateways.push({ internetGatewayId, attachments: [], tags: nameTags(input.name) });
  trail(env, { source: 'ec2', name: 'CreateInternetGateway', resources: [['AWS::EC2::InternetGateway', internetGatewayId]], request: {}, response: { internetGateway: { internetGatewayId, attachmentSet: {} } } });
  return internetGatewayId;
}

export function attachInternetGateway(env: AwsEnv, internetGatewayId: string, vpcId: string) {
  const igw = getIgw(env, internetGatewayId);
  getVpc(env, vpcId);
  if (igw.attachments.length) throw new AwsError('Resource.AlreadyAssociated', `resource ${internetGatewayId} is already attached to network ${igw.attachments[0].vpcId}`);
  if (env.internetGateways.some((g) => g.attachments.some((a) => a.vpcId === vpcId)))
    throw new AwsError('Resource.AlreadyAssociated', `Network ${vpcId} already has an internet gateway attached`);
  igw.attachments = [{ vpcId, state: 'available' }];
  trail(env, { source: 'ec2', name: 'AttachInternetGateway', resources: [['AWS::EC2::InternetGateway', internetGatewayId], ['AWS::EC2::VPC', vpcId]], request: { internetGatewayId, vpcId } });
}

export function detachInternetGateway(env: AwsEnv, internetGatewayId: string, vpcId: string) {
  const igw = getIgw(env, internetGatewayId);
  if (!igw.attachments.some((a) => a.vpcId === vpcId)) throw new AwsError('Gateway.NotAttached', `resource ${internetGatewayId} is not attached to network ${vpcId}`);
  const mapped = env.instances.some((i) => i.vpcId === vpcId && i.publicIpAddress) || env.loadBalancers.some((l) => l.vpcId === vpcId && l.scheme === 'internet-facing');
  if (mapped) throw new AwsError('DependencyViolation', `Network ${vpcId} has some mapped public address(es). Please unmap those public address(es) before detaching the gateway.`);
  igw.attachments = [];
  trail(env, { source: 'ec2', name: 'DetachInternetGateway', resources: [['AWS::EC2::InternetGateway', internetGatewayId], ['AWS::EC2::VPC', vpcId]], request: { internetGatewayId, vpcId } });
}

/** What still has a network interface (or a DB subnet group entry) in the subnet: DeleteSubnet refuses while any exist. */
export function subnetDependencies(env: AwsEnv, subnetId: string): string[] {
  return [
    ...env.instances.filter((i) => i.subnetId === subnetId && i.state !== 'terminated').map((i) => `EC2 インスタンス ${label(i.instanceId, i)}`),
    ...env.loadBalancers.filter((l) => l.subnetIds.includes(subnetId)).map((l) => `ロードバランサー ${l.loadBalancerName}`),
    ...env.dbInstances.filter((d) => d.subnetId === subnetId).map((d) => `DB インスタンス ${d.dbInstanceIdentifier}`),
    ...env.dbSubnetGroups.filter((g) => g.subnetIds.includes(subnetId)).map((g) => `DB サブネットグループ ${g.dbSubnetGroupName}`),
    ...(env.natGateways ?? []).filter((n) => n.subnetId === subnetId && n.state !== 'deleted').map((n) => `NAT ゲートウェイ ${label(n.natGatewayId, n)}`),
    ...(env.ecsTasks ?? []).filter((t) => t.subnetId === subnetId && t.lastStatus !== 'STOPPED').map((t) => `ECS タスク ${t.taskArn.split('/').pop()}`),
    ...(env.autoScalingGroups ?? []).filter((g) => g.subnetIds.includes(subnetId)).map((g) => `Auto Scaling グループ ${g.autoScalingGroupName}`),
  ];
}

export function deleteSubnet(env: AwsEnv, subnetId: string) {
  getSubnet(env, subnetId);
  if (subnetDependencies(env, subnetId).length) throw new AwsError('DependencyViolation', `The subnet '${subnetId}' has dependencies and cannot be deleted.`);
  env.subnets = env.subnets.filter((x) => x.subnetId !== subnetId);
  for (const rt of env.routeTables) rt.associations = rt.associations.filter((a) => a.subnetId !== subnetId);
  for (const n of env.networkAcls) n.associations = n.associations.filter((a) => a.subnetId !== subnetId);
  trail(env, { source: 'ec2', name: 'DeleteSubnet', resources: [['AWS::EC2::Subnet', subnetId]], request: { subnetId } });
}

/** Resources the console cannot delete together with the VPC: they have to go first. */
export function vpcDependencies(env: AwsEnv, vpcId: string): string[] {
  const subnets = env.subnets.filter((x) => x.vpcId === vpcId).map((x) => x.subnetId);
  return [
    ...new Set([
      ...subnets.flatMap((id) => subnetDependencies(env, id)),
      ...env.loadBalancers.filter((l) => l.vpcId === vpcId).map((l) => `ロードバランサー ${l.loadBalancerName}`),
      ...env.targetGroups.filter((t) => t.vpcId === vpcId).map((t) => `ターゲットグループ ${t.targetGroupName}`),
    ]),
  ];
}

/**
 * "VPC の削除" in the console: deletes the VPC with its subnets, route tables, network ACLs, security groups,
 * gateway endpoints and attached internet gateways. Anything running in it (instances, ALBs, DBs...) must be deleted first.
 */
export function deleteVpc(env: AwsEnv, vpcId: string) {
  const vpc = getVpc(env, vpcId);
  if (vpcDependencies(env, vpcId).length) throw new AwsError('DependencyViolation', `The vpc '${vpcId}' has dependencies and cannot be deleted.`);
  for (const e of env.vpcEndpoints.filter((x) => x.vpcId === vpcId)) deleteVpcEndpoint(env, e.vpcEndpointId);
  for (const sub of env.subnets.filter((x) => x.vpcId === vpcId)) deleteSubnet(env, sub.subnetId);
  for (const igw of env.internetGateways.filter((g) => g.attachments.some((a) => a.vpcId === vpcId))) {
    igw.attachments = [];
    trail(env, { source: 'ec2', name: 'DetachInternetGateway', resources: [['AWS::EC2::InternetGateway', igw.internetGatewayId], ['AWS::EC2::VPC', vpcId]], request: { internetGatewayId: igw.internetGatewayId, vpcId } });
    env.internetGateways = env.internetGateways.filter((g) => g !== igw);
    trail(env, { source: 'ec2', name: 'DeleteInternetGateway', resources: [['AWS::EC2::InternetGateway', igw.internetGatewayId]], request: { internetGatewayId: igw.internetGatewayId } });
  }
  const removed = <T extends { vpcId: string }>(list: T[], name: string, type: string, id: (x: T) => string) => {
    for (const x of list.filter((y) => y.vpcId === vpcId)) trail(env, { source: 'ec2', name, resources: [[type, id(x)]], request: {} });
    return list.filter((y) => y.vpcId !== vpcId);
  };
  env.routeTables = removed(env.routeTables, 'DeleteRouteTable', 'AWS::EC2::RouteTable', (x) => x.routeTableId);
  env.networkAcls = removed(env.networkAcls, 'DeleteNetworkAcl', 'AWS::EC2::NetworkAcl', (x) => x.networkAclId);
  env.securityGroups = removed(env.securityGroups, 'DeleteSecurityGroup', 'AWS::EC2::SecurityGroup', (x) => x.groupId);
  env.natGateways = env.natGateways.filter((n) => n.vpcId !== vpcId);
  env.vpcs = env.vpcs.filter((v) => v !== vpc);
  trail(env, { source: 'ec2', name: 'DeleteVpc', resources: [['AWS::EC2::VPC', vpcId]], request: { vpcId } });
}

// ---------- NAT gateways / gateway endpoints ----------

const NAT_MS = 5000;
export const S3_PREFIX_LIST = 'pl-61a54008';
export const s3EndpointService = (env: AwsEnv) => `com.amazonaws.${env.region}.s3`;

export function createNatGateway(env: AwsEnv, input: { subnetId: string; name?: string }, now = Date.now()): string {
  const subnet = getSubnet(env, input.subnetId);
  const natGatewayId = newId('nat');
  env.natGateways.push({ natGatewayId, vpcId: subnet.vpcId, subnetId: subnet.subnetId, state: 'pending', stateChangedAt: now, publicIp: `203.0.113.${10 + randomInt(240)}`, privateIp: allocateIp(env, subnet.subnetId), createTime: now, tags: nameTags(input.name) });
  trail(env, { source: 'ec2', name: 'CreateNatGateway', resources: [['AWS::EC2::NatGateway', natGatewayId]], request: { subnetId: subnet.subnetId, connectivityType: 'public', allocationId: `eipalloc-${natGatewayId.slice(4)}` }, response: { natGateway: { natGatewayId, subnetId: subnet.subnetId, vpcId: subnet.vpcId, state: 'pending' } } });
  return natGatewayId;
}

export function deleteNatGateway(env: AwsEnv, natGatewayId: string, now = Date.now()) {
  const nat = env.natGateways.find((n) => n.natGatewayId === natGatewayId && n.state !== 'deleted');
  if (!nat) throw new AwsError('NatGatewayNotFound', `The Nat Gateway ${natGatewayId} was not found`);
  nat.state = 'deleting';
  nat.stateChangedAt = now;
  trail(env, { source: 'ec2', name: 'DeleteNatGateway', resources: [['AWS::EC2::NatGateway', natGatewayId]], request: { natGatewayId }, response: { natGatewayId } });
}

export function advanceNatGateways(env: AwsEnv, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  let changed = false;
  for (const n of env.natGateways ?? [])
    if ((n.state === 'pending' || n.state === 'deleting') && now - n.stateChangedAt >= NAT_MS) {
      n.state = n.state === 'pending' ? 'available' : 'deleted';
      n.stateChangedAt = now;
      changed = true;
    }
  return changed;
}

export function createVpcEndpoint(env: AwsEnv, input: { vpcId: string; serviceName: string; routeTableIds: string[]; name?: string }, now = Date.now()): string {
  getVpc(env, input.vpcId);
  if (input.serviceName !== s3EndpointService(env)) throw new AwsError('InvalidServiceName', `The Vpc Endpoint Service '${input.serviceName}' does not exist`);
  if (env.vpcEndpoints.some((e) => e.vpcId === input.vpcId && e.serviceName === input.serviceName)) throw new AwsError('RouteAlreadyExists', `route table already has a route with destination-prefix-list-id ${S3_PREFIX_LIST}`);
  const vpcEndpointId = newId('vpce');
  for (const id of input.routeTableIds) {
    const rt = getRouteTable(env, id);
    if (rt.vpcId !== input.vpcId) throw new AwsError('InvalidParameter', `Route table ${id} does not belong to vpc ${input.vpcId}`);
    rt.routes.push({ destinationCidrBlock: '', destinationPrefixListId: S3_PREFIX_LIST, gatewayId: vpcEndpointId, origin: 'CreateVpcEndpoint' });
  }
  env.vpcEndpoints.push({ vpcEndpointId, vpcId: input.vpcId, serviceName: input.serviceName, type: 'Gateway', routeTableIds: [...input.routeTableIds], state: 'available', createdAt: now, tags: nameTags(input.name) });
  trail(env, { source: 'ec2', name: 'CreateVpcEndpoint', resources: [['AWS::EC2::VPCEndpoint', vpcEndpointId]], request: { vpcEndpointType: 'Gateway', vpcId: input.vpcId, serviceName: input.serviceName, routeTableIdSet: input.routeTableIds }, response: { vpcEndpoint: { vpcEndpointId, state: 'available' } } });
  return vpcEndpointId;
}

export function deleteVpcEndpoint(env: AwsEnv, vpcEndpointId: string) {
  if (!env.vpcEndpoints.some((e) => e.vpcEndpointId === vpcEndpointId)) throw new AwsError('InvalidVpcEndpointId.NotFound', `The VpcEndpoint Id '${vpcEndpointId}' does not exist`);
  env.vpcEndpoints = env.vpcEndpoints.filter((e) => e.vpcEndpointId !== vpcEndpointId);
  for (const rt of env.routeTables) rt.routes = rt.routes.filter((r) => r.gatewayId !== vpcEndpointId);
  trail(env, { source: 'ec2', name: 'DeleteVpcEndpoints', resources: [['AWS::EC2::VPCEndpoint', vpcEndpointId]], request: { vpcEndpointId: [vpcEndpointId] }, response: { unsuccessful: [] } });
}

/** How a data flow leaves its subnet: S3 via the gateway endpoint, else the 0.0.0.0/0 route (NAT or IGW). */
export function flowPath(env: AwsEnv, subnetId: string, destination: 's3' | 'internet'): { via: 'endpoint' | 'nat' | 'igw' | 'none'; nat?: NatGateway; detail: string } {
  const rt = effectiveRouteTable(env, subnetId);
  if (destination === 's3') {
    const ep = rt.routes.find((r) => r.destinationPrefixListId === S3_PREFIX_LIST);
    if (ep) return { via: 'endpoint', detail: `${S3_PREFIX_LIST} → ${ep.gatewayId} (ゲートウェイエンドポイント)` };
  }
  // an S3 / internet address outside every VPC range
  const ev = evaluateRoute(env, rt.routeTableId, destination === 's3' ? '52.219.0.10' : '93.184.216.34');
  if (!ev || ev.state !== 'active' || ev.target.type === 'local') return { via: 'none', detail: `${label(rt.routeTableId, rt)} に有効な 0.0.0.0/0 ルートがありません` };
  if (ev.target.type === 'internet-gateway') return { via: 'igw', detail: `0.0.0.0/0 → ${ev.target.id}` };
  const nat = env.natGateways.find((n) => n.natGatewayId === ev.target.id)!;
  if (!isPublicSubnet(env, nat.subnetId)) return { via: 'none', detail: `${nat.natGatewayId} がパブリックサブネットにありません` };
  return { via: 'nat', nat, detail: `0.0.0.0/0 → ${nat.natGatewayId} (${getSubnet(env, nat.subnetId).availabilityZone})` };
}

