/* シミュレーターのリソースを、AWS の API の応答と同じ形 (キーはパスカルケース) にする。
   複数のサービスのファイルから使うものはここに置く (describe と create の応答で同じ形を返すため) */
import { availableIpCount, routeState } from '../../sim/vpc';
import { publicDnsName, privateDnsName, STATE_CODES } from '../../sim/ec2';
import { lbsForTargetGroup, targetHealth } from '../../sim/elb';
import { shiftedAwayAz } from '../../sim/ext/zonalshift';
import { regionOf } from '../../sim/env';
import { metadataOptions } from '../../sim/ext/credentials';
import type { AwsEnv, DbInstance, Instance, InternetGateway, LoadBalancer, NetworkAcl, NetworkAclEntry, RouteTable, SecurityGroup, SecurityGroupRule, Subnet, TargetGroup, Vpc } from '../../sim/types';
import { iso, tagsOut } from './types';

/* ---- EC2 / VPC ---- */

/** ap-northeast-1 → apne1 (AZ ID の頭) */
export const regionShort = (region: string) => {
  const [geo, dir, n] = region.split('-');
  return geo + dir.replace('north', 'n').replace('south', 's').replace('east', 'e').replace('west', 'w').replace('central', 'c') + n;
};
export const zoneId = (az: string) => {
  const region = az.slice(0, -1);
  const i = regionOf(region).azs.indexOf(az);
  return `${regionShort(region)}-az${i + 1}`;
};

const withTags = (tags: { key: string; value: string }[]) => (tags.length ? { Tags: tagsOut(tags) } : {});

export const vpcOut = (env: AwsEnv, v: Vpc) => ({
  OwnerId: env.accountId,
  InstanceTenancy: v.instanceTenancy,
  CidrBlockAssociationSet: [{ AssociationId: `vpc-cidr-assoc-${v.vpcId.slice(4)}`, CidrBlock: v.cidrBlock, CidrBlockState: { State: 'associated' } }],
  IsDefault: v.isDefault,
  ...withTags(v.tags),
  BlockPublicAccessStates: { InternetGatewayBlockMode: 'off' },
  VpcId: v.vpcId,
  State: v.state,
  CidrBlock: v.cidrBlock,
  DhcpOptionsId: v.dhcpOptionsId,
});

export const subnetOut = (env: AwsEnv, s: Subnet) => ({
  AvailabilityZoneId: zoneId(s.availabilityZone),
  MapCustomerOwnedIpOnLaunch: false,
  OwnerId: env.accountId,
  AssignIpv6AddressOnCreation: false,
  Ipv6CidrBlockAssociationSet: [],
  ...withTags(s.tags),
  SubnetArn: `arn:aws:ec2:${env.region}:${env.accountId}:subnet/${s.subnetId}`,
  EnableDns64: false,
  Ipv6Native: false,
  PrivateDnsNameOptionsOnLaunch: { HostnameType: 'ip-name', EnableResourceNameDnsARecord: false, EnableResourceNameDnsAAAARecord: false },
  SubnetId: s.subnetId,
  State: s.state,
  VpcId: s.vpcId,
  CidrBlock: s.cidrBlock,
  AvailableIpAddressCount: availableIpCount(env, s),
  AvailabilityZone: s.availabilityZone,
  DefaultForAz: env.vpcs.find((v) => v.vpcId === s.vpcId)?.isDefault ?? false,
  MapPublicIpOnLaunch: s.mapPublicIpOnLaunch,
});

export const routeTableOut = (env: AwsEnv, rt: RouteTable) => ({
  Associations: rt.associations.map((a) => ({ Main: a.main, RouteTableAssociationId: a.routeTableAssociationId, RouteTableId: rt.routeTableId, ...(a.subnetId ? { SubnetId: a.subnetId } : {}), AssociationState: { State: 'associated' } })),
  PropagatingVgws: [],
  RouteTableId: rt.routeTableId,
  Routes: rt.routes.map((r) => ({
    ...(r.destinationCidrBlock ? { DestinationCidrBlock: r.destinationCidrBlock } : {}),
    ...(r.destinationPrefixListId ? { DestinationPrefixListId: r.destinationPrefixListId } : {}),
    ...(r.gatewayId ? { GatewayId: r.gatewayId } : {}),
    ...(r.natGatewayId ? { NatGatewayId: r.natGatewayId } : {}),
    Origin: r.origin,
    State: routeState(env, rt, r),
  })),
  ...withTags(rt.tags),
  VpcId: rt.vpcId,
  OwnerId: env.accountId,
});

export const igwOut = (env: AwsEnv, g: InternetGateway) => ({
  Attachments: g.attachments.map((a) => ({ State: a.state, VpcId: a.vpcId })),
  InternetGatewayId: g.internetGatewayId,
  OwnerId: env.accountId,
  ...withTags(g.tags),
});

/** SG のルールを AWS と同じく (プロトコル, ポート範囲) ごとにまとめた IpPermissions */
export function ipPermissions(env: AwsEnv, rules: SecurityGroupRule[]) {
  const groups = new Map<string, SecurityGroupRule[]>();
  for (const r of rules) {
    const k = `${r.ipProtocol}|${r.fromPort}|${r.toPort}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()].map((rs) => {
    const r = rs[0];
    return {
      IpProtocol: r.ipProtocol,
      ...(r.ipProtocol === '-1' ? {} : { FromPort: r.fromPort, ToPort: r.toPort }),
      UserIdGroupPairs: rs.filter((x) => x.referencedGroupId).map((x) => ({ ...(x.description ? { Description: x.description } : {}), UserId: env.accountId, GroupId: x.referencedGroupId })),
      IpRanges: rs.filter((x) => x.cidrIpv4).map((x) => ({ ...(x.description ? { Description: x.description } : {}), CidrIp: x.cidrIpv4 })),
      Ipv6Ranges: [],
      PrefixListIds: [],
    };
  });
}

export const sgOut = (env: AwsEnv, g: SecurityGroup) => ({
  GroupId: g.groupId,
  IpPermissionsEgress: ipPermissions(env, g.egress),
  ...withTags(g.tags),
  VpcId: g.vpcId,
  SecurityGroupArn: `arn:aws:ec2:${env.region}:${env.accountId}:security-group/${g.groupId}`,
  OwnerId: env.accountId,
  GroupName: g.groupName,
  Description: g.description,
  IpPermissions: ipPermissions(env, g.ingress),
});

/** describe-security-group-rules の 1 行 */
export const sgRuleOut = (env: AwsEnv, g: SecurityGroup, r: SecurityGroupRule, egress: boolean) => ({
  SecurityGroupRuleId: r.securityGroupRuleId,
  GroupId: g.groupId,
  GroupOwnerId: env.accountId,
  IsEgress: egress,
  IpProtocol: r.ipProtocol,
  FromPort: r.fromPort,
  ToPort: r.toPort,
  ...(r.cidrIpv4 ? { CidrIpv4: r.cidrIpv4 } : {}),
  ...(r.referencedGroupId ? { ReferencedGroupInfo: { GroupId: r.referencedGroupId, UserId: env.accountId } } : {}),
  ...(r.description ? { Description: r.description } : {}),
  Tags: [],
  SecurityGroupRuleArn: `arn:aws:ec2:${env.region}:${env.accountId}:security-group-rule/${r.securityGroupRuleId}`,
});

const PROTOCOL_NUMBER: Record<string, string> = { tcp: '6', udp: '17', icmp: '1', '-1': '-1' };
const naclEntryOut = (e: NetworkAclEntry) => ({
  CidrBlock: e.cidrBlock,
  Egress: e.egress,
  Protocol: PROTOCOL_NUMBER[e.protocol] ?? e.protocol,
  RuleAction: e.ruleAction,
  RuleNumber: e.ruleNumber,
  ...(e.fromPort !== undefined && (e.protocol === 'tcp' || e.protocol === 'udp') ? { PortRange: { From: e.fromPort, To: e.toPort ?? e.fromPort } } : {}),
});

export const naclOut = (env: AwsEnv, n: NetworkAcl) => ({
  Associations: n.associations.map((a) => ({ NetworkAclAssociationId: a.networkAclAssociationId, NetworkAclId: n.networkAclId, SubnetId: a.subnetId })),
  /* どのルールにも当たらなければ拒否する「*」のルール (ルール番号 32767) も、AWS と同じく一覧に出す */
  Entries: [...n.entries, ...[true, false].map((egress) => ({ ruleNumber: 32767, egress, protocol: '-1' as const, ruleAction: 'deny' as const, cidrBlock: '0.0.0.0/0' }))]
    .sort((a, b) => Number(a.egress) - Number(b.egress) || a.ruleNumber - b.ruleNumber)
    .map(naclEntryOut),
  IsDefault: n.isDefault,
  NetworkAclId: n.networkAclId,
  ...withTags(n.tags),
  VpcId: n.vpcId,
  OwnerId: env.accountId,
});

export const instanceOut = (env: AwsEnv, i: Instance) => {
  const profile = env.instanceProfiles.find((p) => p.arn === i.iamInstanceProfileArn);
  const running = i.state === 'running' || i.state === 'pending' || i.state === 'stopping';
  const publicIp = i.state === 'running' || i.state === 'pending' ? i.publicIpAddress : undefined;
  return {
    AmiLaunchIndex: 0,
    ImageId: i.imageId,
    InstanceId: i.instanceId,
    InstanceType: i.instanceType,
    ...(i.keyName ? { KeyName: i.keyName } : {}),
    LaunchTime: iso(i.launchTime),
    Monitoring: { State: i.detailedMonitoring ? 'enabled' : 'disabled' },
    Placement: { AvailabilityZone: i.availabilityZone, GroupName: '', Tenancy: 'default' },
    PrivateDnsName: i.state === 'terminated' ? '' : privateDnsName(env, i.privateIpAddress),
    ...(i.state === 'terminated' ? {} : { PrivateIpAddress: i.privateIpAddress }),
    ProductCodes: [],
    PublicDnsName: publicIp ? publicDnsName(env, publicIp) : '',
    ...(publicIp ? { PublicIpAddress: publicIp } : {}),
    State: { Code: STATE_CODES[i.state], Name: i.state },
    StateTransitionReason: i.state === 'stopped' || i.state === 'terminated' ? `User initiated (${iso(i.stateChangedAt)?.replace('+00:00', ' GMT').replace('T', ' ')})` : '',
    ...(i.state === 'terminated' ? {} : { SubnetId: i.subnetId, VpcId: i.vpcId }),
    Architecture: 'x86_64',
    BlockDeviceMappings: running || i.state === 'stopped' ? [{ DeviceName: '/dev/xvda', Ebs: { AttachTime: iso(i.launchTime), DeleteOnTermination: true, Status: 'attached', VolumeId: `vol-${i.instanceId.slice(2)}` } }] : [],
    ClientToken: '',
    EbsOptimized: false,
    EnaSupport: true,
    Hypervisor: 'xen',
    ...(profile ? { IamInstanceProfile: { Arn: profile.arn, Id: profile.instanceProfileId } } : {}),
    SecurityGroups: i.securityGroupIds.map((id) => ({ GroupName: env.securityGroups.find((g) => g.groupId === id)?.groupName ?? id, GroupId: id })),
    SourceDestCheck: true,
    ...withTags(i.tags),
    VirtualizationType: 'hvm',
    MetadataOptions: { State: 'applied', HttpTokens: metadataOptions(i).httpTokens, HttpPutResponseHopLimit: metadataOptions(i).httpPutResponseHopLimit, HttpEndpoint: metadataOptions(i).httpEndpoint, HttpProtocolIpv6: 'disabled', InstanceMetadataTags: 'disabled' },
    PlatformDetails: i.platformDetails,
    UsageOperation: 'RunInstances',
  };
};

/** describe-instances は Reservations の中に Instances が入る (このシミュレーターでは 1 インスタンス 1 予約) */
export const reservationOut = (env: AwsEnv, i: Instance) => ({
  Groups: [],
  Instances: [instanceOut(env, i)],
  OwnerId: env.accountId,
  ReservationId: `r-${i.instanceId.slice(2)}`,
});

/* ---- ELBv2 ---- */

export const lbOut = (env: AwsEnv, lb: LoadBalancer) => ({
  LoadBalancerArn: lb.loadBalancerArn,
  DNSName: lb.dnsName,
  CanonicalHostedZoneId: 'Z14GRHDCWA56QT',
  CreatedTime: iso(lb.createdTime),
  LoadBalancerName: lb.loadBalancerName,
  Scheme: lb.scheme,
  VpcId: lb.vpcId,
  State: { Code: lb.state },
  Type: lb.type,
  AvailabilityZones: lb.subnetIds.map((id) => ({ ZoneName: env.subnets.find((s) => s.subnetId === id)?.availabilityZone ?? '', SubnetId: id, LoadBalancerAddresses: [] })),
  SecurityGroups: lb.securityGroupIds,
  IpAddressType: lb.ipAddressType,
});

export const listenerOut = (lb: LoadBalancer, l: LoadBalancer['listeners'][number]) => ({
  ListenerArn: l.listenerArn,
  LoadBalancerArn: lb.loadBalancerArn,
  Port: l.port,
  Protocol: l.protocol,
  DefaultActions: [{ Type: 'forward', TargetGroupArn: l.targetGroupArn, ForwardConfig: { TargetGroups: [{ TargetGroupArn: l.targetGroupArn, Weight: 1 }], TargetGroupStickinessConfig: { Enabled: false } } }],
});

export const tgOut = (env: AwsEnv, tg: TargetGroup) => ({
  TargetGroupArn: tg.targetGroupArn,
  TargetGroupName: tg.targetGroupName,
  Protocol: tg.protocol,
  Port: tg.port,
  VpcId: tg.vpcId,
  HealthCheckProtocol: tg.healthCheck.protocol,
  HealthCheckPort: String(tg.healthCheck.port),
  HealthCheckEnabled: true,
  HealthCheckIntervalSeconds: tg.healthCheck.intervalSeconds,
  HealthCheckTimeoutSeconds: tg.healthCheck.timeoutSeconds,
  HealthyThresholdCount: tg.healthCheck.healthyThresholdCount,
  UnhealthyThresholdCount: tg.healthCheck.unhealthyThresholdCount,
  HealthCheckPath: tg.healthCheck.path,
  Matcher: { HttpCode: tg.healthCheck.matcher },
  LoadBalancerArns: env.loadBalancers.filter((lb) => lb.listeners.some((l) => l.targetGroupArn === tg.targetGroupArn)).map((lb) => lb.loadBalancerArn),
  TargetType: tg.targetType,
  ProtocolVersion: tg.protocolVersion,
  IpAddressType: 'ipv4',
});

export const targetHealthOut = (env: AwsEnv, tg: TargetGroup, t: TargetGroup['targets'][number]) => {
  const h = targetHealth(env, tg.targetGroupArn, t);
  // a zonal shift (Route 53 ARC) away from the target's AZ overrides routing without changing its health
  const lb = lbsForTargetGroup(env, tg.targetGroupArn)[0];
  const az = env.instances.find((i) => i.instanceId === t.id)?.availabilityZone;
  const shifted = !!lb && !!az && shiftedAwayAz(env, lb, Date.now()) === az;
  return {
    Target: { Id: t.id, Port: t.port },
    HealthCheckPort: String(tg.healthCheck.port === 'traffic-port' ? t.port : tg.healthCheck.port),
    TargetHealth: { State: h.state, ...(h.reason ? { Reason: h.reason } : {}), ...(h.description ? { Description: h.description } : {}) },
    AdministrativeOverride: shifted
      ? { State: 'zonal_shift_active', Reason: 'AdministrativeOverride.ZonalShiftActive' }
      : { State: 'no_override', Reason: 'AdministrativeOverride.NoOverride', Description: 'No override is currently active on target' },
  };
};

/* ---- RDS ---- */

export const dbOut = (env: AwsEnv, d: DbInstance) => ({
  DBInstanceIdentifier: d.dbInstanceIdentifier,
  DBInstanceClass: d.dbInstanceClass,
  Engine: d.engine,
  DBInstanceStatus: d.status,
  MasterUsername: d.masterUsername,
  ...(d.dbName ? { DBName: d.dbName } : {}),
  ...(d.status === 'creating' ? {} : { Endpoint: { Address: d.endpointAddress, Port: d.port, HostedZoneId: 'Z24O6O9L7SGTOT' } }),
  AllocatedStorage: d.allocatedStorage,
  InstanceCreateTime: iso(d.instanceCreateTime),
  PreferredBackupWindow: d.preferredBackupWindow,
  BackupRetentionPeriod: d.backupRetentionPeriod,
  DBSecurityGroups: [],
  VpcSecurityGroups: d.vpcSecurityGroupIds.map((id) => ({ VpcSecurityGroupId: id, Status: 'active' })),
  DBParameterGroups: [{ DBParameterGroupName: `default.${d.engine}${d.engineVersion.split('.').slice(0, 2).join('.')}`, ParameterApplyStatus: 'in-sync' }],
  AvailabilityZone: d.availabilityZone,
  DBSubnetGroup: (() => {
    const g = env.dbSubnetGroups.find((x) => x.dbSubnetGroupName === d.dbSubnetGroupName);
    return g ? dbSubnetGroupOut(env, g) : { DBSubnetGroupName: d.dbSubnetGroupName };
  })(),
  PreferredMaintenanceWindow: 'sun:18:00-sun:18:30',
  PendingModifiedValues: {},
  MultiAZ: d.multiAZ,
  EngineVersion: d.engineVersion,
  AutoMinorVersionUpgrade: true,
  PubliclyAccessible: d.publiclyAccessible,
  StorageType: d.storageType,
  DbInstancePort: 0,
  StorageEncrypted: d.storageEncrypted,
  DbiResourceId: d.dbiResourceId,
  DBInstanceArn: `arn:aws:rds:${env.region}:${env.accountId}:db:${d.dbInstanceIdentifier}`,
  ...(d.tags.length ? { TagList: tagsOut(d.tags) } : { TagList: [] }),
  DeletionProtection: false,
});

export const dbSubnetGroupOut = (env: AwsEnv, g: AwsEnv['dbSubnetGroups'][number]) => ({
  DBSubnetGroupName: g.dbSubnetGroupName,
  DBSubnetGroupDescription: g.description,
  VpcId: g.vpcId,
  SubnetGroupStatus: 'Complete',
  Subnets: g.subnetIds.map((id) => ({ SubnetIdentifier: id, SubnetAvailabilityZone: { Name: env.subnets.find((s) => s.subnetId === id)?.availabilityZone ?? '' }, SubnetOutpost: {}, SubnetStatus: 'Active' })),
  DBSubnetGroupArn: `arn:aws:rds:${env.region}:${env.accountId}:subgrp:${g.dbSubnetGroupName}`,
  SupportedNetworkTypes: ['IPV4'],
});
