import { AwsError, type AwsEnv, type DbInstance, type DbSubnetGroup, type Instance, type InternetGateway, type LoadBalancer, type NetworkAcl, type RouteTable, type SecurityGroup, type Subnet, type Tagged, type TargetGroup, type Vpc } from './types';

export interface Region {
  code: string;
  name: string;
  azs: string[];
}

export const REGIONS: Region[] = [
  { code: 'us-east-1', name: '米国東部 (バージニア北部)', azs: ['a', 'b', 'c', 'd', 'e', 'f'] },
  { code: 'us-east-2', name: '米国東部 (オハイオ)', azs: ['a', 'b', 'c'] },
  { code: 'us-west-2', name: '米国西部 (オレゴン)', azs: ['a', 'b', 'c', 'd'] },
  { code: 'ap-northeast-1', name: 'アジアパシフィック (東京)', azs: ['a', 'c', 'd'] },
  { code: 'ap-northeast-3', name: 'アジアパシフィック (大阪)', azs: ['a', 'b', 'c'] },
  { code: 'ap-southeast-1', name: 'アジアパシフィック (シンガポール)', azs: ['a', 'b', 'c'] },
  { code: 'eu-west-1', name: '欧州 (アイルランド)', azs: ['a', 'b', 'c'] },
  { code: 'eu-central-1', name: '欧州 (フランクフルト)', azs: ['a', 'b', 'c'] },
].map((r) => ({ ...r, azs: r.azs.map((z) => r.code + z) }));

export function regionOf(code: string): Region {
  return REGIONS.find((r) => r.code === code) ?? REGIONS[0];
}

export function emptyEnv(region = 'ap-northeast-1'): AwsEnv {
  return {
    accountId: '123456789012',
    region,
    vpcs: [],
    subnets: [],
    routeTables: [],
    internetGateways: [],
    networkAcls: [],
    securityGroups: [],
    keyPairs: [],
    instances: [],
    loadBalancers: [],
    targetGroups: [],
    dbSubnetGroups: [],
    dbInstances: [],
    dbSnapshots: [],
    iamUsers: [],
    iamRoles: [],
    iamPolicies: [],
    instanceProfiles: [],
    buckets: [],
    incidents: [],
    alarms: [],
    logGroups: [],
    trailEvents: [],
    configRules: [],
    launchTemplates: [],
    autoScalingGroups: [],
    traffic: [],
    ecrRepositories: [],
    ecsClusters: [],
    taskDefinitions: [],
    ecsServices: [],
    ecsTasks: [],
    sqsQueues: [],
    lambdaFunctions: [],
    eventSourceMappings: [],
    computeEnvironments: [],
    jobQueues: [],
    jobDefinitions: [],
    batchJobs: [],
    eventRules: [],
    hostedZones: [],
    certificates: [],
    distributions: [],
    webAcls: [],
    ipSets: [],
    natGateways: [],
    vpcEndpoints: [],
    dataFlows: [],
    budgets: [],
  };
}

export function nameOf(r: Tagged): string {
  return r.tags.find((t) => t.key === 'Name')?.value ?? '';
}

export function nameTags(name?: string) {
  return name ? [{ key: 'Name', value: name }] : [];
}

/** "id / name" label as used across the AWS console selectors. */
export function label(id: string, r?: Tagged | null): string {
  const n = r ? nameOf(r) : '';
  return n ? `${id} / ${n}` : id;
}

function find<T>(list: T[], pred: (x: T) => boolean, code: string, message: string): T {
  const x = list.find(pred);
  if (!x) throw new AwsError(code, message);
  return x;
}

export const getVpc = (env: AwsEnv, id: string): Vpc => find(env.vpcs, (v) => v.vpcId === id, 'InvalidVpcID.NotFound', `The vpc ID '${id}' does not exist`);
export const getSubnet = (env: AwsEnv, id: string): Subnet =>
  find(env.subnets, (s) => s.subnetId === id, 'InvalidSubnetID.NotFound', `The subnet ID '${id}' does not exist`);
export const getRouteTable = (env: AwsEnv, id: string): RouteTable =>
  find(env.routeTables, (r) => r.routeTableId === id, 'InvalidRouteTableID.NotFound', `The routeTable ID '${id}' does not exist`);
export const getIgw = (env: AwsEnv, id: string): InternetGateway =>
  find(env.internetGateways, (g) => g.internetGatewayId === id, 'InvalidInternetGatewayID.NotFound', `The internetGateway ID '${id}' does not exist`);
export const getNacl = (env: AwsEnv, id: string): NetworkAcl =>
  find(env.networkAcls, (a) => a.networkAclId === id, 'InvalidNetworkAclID.NotFound', `The networkAcl ID '${id}' does not exist`);
export const getSg = (env: AwsEnv, id: string): SecurityGroup =>
  find(env.securityGroups, (g) => g.groupId === id, 'InvalidGroup.NotFound', `The security group '${id}' does not exist`);
export const getInstance = (env: AwsEnv, id: string): Instance =>
  find(env.instances, (i) => i.instanceId === id, 'InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`);
export const getLb = (env: AwsEnv, arn: string): LoadBalancer =>
  find(env.loadBalancers, (l) => l.loadBalancerArn === arn, 'LoadBalancerNotFound', `One or more load balancers not found`);
export const getTg = (env: AwsEnv, arn: string): TargetGroup =>
  find(env.targetGroups, (t) => t.targetGroupArn === arn, 'TargetGroupNotFound', `One or more target groups not found`);
export const getDb = (env: AwsEnv, id: string): DbInstance =>
  find(env.dbInstances, (d) => d.dbInstanceIdentifier === id, 'DBInstanceNotFound', `DBInstance ${id} not found.`);
export const getDbSubnetGroup = (env: AwsEnv, name: string): DbSubnetGroup =>
  find(env.dbSubnetGroups, (g) => g.dbSubnetGroupName === name, 'DBSubnetGroupNotFoundFault', `DB subnet group '${name}' does not exist.`);

/** Run an operation on a deep copy; the original env is never touched (safe for React state and rollback on error). */
export function mutate<T>(env: AwsEnv, op: (draft: AwsEnv) => T): [AwsEnv, T] {
  const draft = structuredClone(env);
  const result = op(draft);
  return [draft, result];
}

/** Look up scenario resources by Name tag (lessons refer to names, ids differ per scenario). */
export function byName<T extends Tagged>(list: T[], name: string): T | undefined {
  return list.find((r) => nameOf(r) === name);
}
