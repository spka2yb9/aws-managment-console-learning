/* aws ec2 — 参照系 (describe-*)、タグ、VPC / サブネットの作成と削除、待機 */
import { getInstance, REGIONS, regionOf } from '../../../sim/env';
import { AMIS } from '../../../sim/ec2';
import { createSubnet, createVpc, deleteSubnet, deleteVpc } from '../../../sim/vpc';
import type { AwsEnv, Tag, Tagged } from '../../../sim/types';
import { igwOut, naclOut, reservationOut, routeTableOut, sgOut, sgRuleOut, subnetOut, vpcOut, zoneId } from '../shapes';
import { applyFilters, AwsError, byIds, nameFromTagSpecs, req, service, strs, structs, tagsIn, type OpContext, type OperationSpec } from '../types';

const ids = (name: string, desc: string) => ({ name, type: 'list' as const, desc });
const filters = { name: 'filters', type: 'list' as const, of: 'structure' as const, desc: '絞り込み。例: Name=tag:Name,Values=webapp-vpc' };
const tagSpecs = { name: 'tag-specifications', type: 'list' as const, of: 'structure' as const, desc: "作成と同時に付けるタグ。例: 'ResourceType=vpc,Tags=[{Key=Name,Value=webapp-vpc}]'" };
const notFound = (code: string, kind: string) => (id: string) => new AwsError(code, `The ${kind} ID '${id}' does not exist`);

/** タグを付けられる EC2 のリソース (ID で引く) */
export function taggable(env: AwsEnv, id: string): Tagged | undefined {
  return (
    env.vpcs.find((x) => x.vpcId === id) ??
    env.subnets.find((x) => x.subnetId === id) ??
    env.routeTables.find((x) => x.routeTableId === id) ??
    env.internetGateways.find((x) => x.internetGatewayId === id) ??
    env.networkAcls.find((x) => x.networkAclId === id) ??
    env.securityGroups.find((x) => x.groupId === id) ??
    env.instances.find((x) => x.instanceId === id) ??
    env.natGateways.find((x) => x.natGatewayId === id) ??
    env.vpcEndpoints.find((x) => x.vpcEndpointId === id)
  );
}

/** --tag-specifications の Name 以外のタグも付ける */
function extraTags(ctx: OpContext, resourceId: string, resourceType: string) {
  const r = taggable(ctx.env, resourceId);
  if (!r) return;
  for (const s of structs(ctx, 'tag-specifications')) {
    if (s.ResourceType && s.ResourceType !== resourceType) continue;
    for (const t of tagsIn(s.Tags)) if (t.key !== 'Name') setTag(r, t);
  }
}

function setTag(r: Tagged, t: Tag) {
  const cur = r.tags.find((x) => x.key === t.key);
  if (cur) cur.value = t.value;
  else r.tags.push({ ...t });
}

const describe = (o: Omit<OperationSpec, 'readOnly'>): OperationSpec => ({ readOnly: true, ...o });

const ops: OperationSpec[] = [
  describe({
    name: 'describe-regions',
    desc: '使えるリージョンの一覧',
    params: [ids('region-names', 'リージョン名で絞る'), { name: 'all-regions', type: 'boolean', desc: 'オプトインしていないものも出す' }],
    scope: 'global',
    run: (ctx) => ({ Regions: REGIONS.filter((r) => !strs(ctx, 'region-names').length || strs(ctx, 'region-names').includes(r.code)).map((r) => ({ OptInStatus: 'opt-in-not-required', RegionName: r.code, Endpoint: `ec2.${r.code}.amazonaws.com` })) }),
  }),
  describe({
    name: 'describe-availability-zones',
    desc: 'このリージョンのアベイラビリティーゾーン (AZ) の一覧',
    params: [ids('zone-names', 'AZ の名前で絞る'), filters],
    run: (ctx) => {
      const azs = regionOf(ctx.region).azs.map((az) => ({ name: az }));
      const list = applyFilters(ctx, byIds(azs, strs(ctx, 'zone-names'), (a) => a.name, (id) => new AwsError('InvalidParameterValue', `Invalid availability zone: [${id}]`)), { 'zone-name': (a) => a.name, state: () => 'available', 'region-name': () => ctx.region });
      return {
        AvailabilityZones: list.map((a) => ({ OptInStatus: 'opt-in-not-required', Messages: [], RegionName: ctx.region, ZoneName: a.name, ZoneId: zoneId(a.name), GroupName: ctx.region, NetworkBorderGroup: ctx.region, ZoneType: 'availability-zone', GroupLongName: regionOf(ctx.region).name, State: 'available' })),
      };
    },
  }),
  describe({
    name: 'describe-vpcs',
    desc: 'VPC の一覧',
    params: [ids('vpc-ids', 'VPC ID で絞る'), filters],
    run: (ctx) => {
      const list = applyFilters(ctx, byIds(ctx.env.vpcs, strs(ctx, 'vpc-ids'), (v) => v.vpcId, notFound('InvalidVpcID.NotFound', 'vpc')), { 'vpc-id': (v) => v.vpcId, 'cidr-block': (v) => v.cidrBlock, cidr: (v) => v.cidrBlock, 'is-default': (v) => String(v.isDefault), state: (v) => v.state, 'owner-id': () => ctx.env.accountId });
      return { Vpcs: list.map((v) => vpcOut(ctx.env, v)) };
    },
  }),
  describe({
    name: 'describe-subnets',
    desc: 'サブネットの一覧',
    params: [ids('subnet-ids', 'サブネット ID で絞る'), filters],
    run: (ctx) => {
      const list = applyFilters(ctx, byIds(ctx.env.subnets, strs(ctx, 'subnet-ids'), (s) => s.subnetId, notFound('InvalidSubnetID.NotFound', 'subnet')), {
        'subnet-id': (s) => s.subnetId,
        'vpc-id': (s) => s.vpcId,
        'cidr-block': (s) => s.cidrBlock,
        'availability-zone': (s) => s.availabilityZone,
        'map-public-ip-on-launch': (s) => String(s.mapPublicIpOnLaunch),
        state: (s) => s.state,
      });
      return { Subnets: list.map((s) => subnetOut(ctx.env, s)) };
    },
  }),
  describe({
    name: 'describe-route-tables',
    desc: 'ルートテーブルの一覧 (ルートと関連付け)',
    params: [ids('route-table-ids', 'ルートテーブル ID で絞る'), filters],
    run: (ctx) => {
      const list = applyFilters(ctx, byIds(ctx.env.routeTables, strs(ctx, 'route-table-ids'), (r) => r.routeTableId, notFound('InvalidRouteTableID.NotFound', 'routeTable')), {
        'route-table-id': (r) => r.routeTableId,
        'vpc-id': (r) => r.vpcId,
        'association.main': (r) => String(r.associations.some((a) => a.main)),
        'association.subnet-id': (r) => r.associations.flatMap((a) => (a.subnetId ? [a.subnetId] : [])),
        'route.gateway-id': (r) => r.routes.flatMap((x) => (x.gatewayId ? [x.gatewayId] : [])),
        'route.destination-cidr-block': (r) => r.routes.map((x) => x.destinationCidrBlock),
        'route.nat-gateway-id': (r) => r.routes.flatMap((x) => (x.natGatewayId ? [x.natGatewayId] : [])),
      });
      return { RouteTables: list.map((r) => routeTableOut(ctx.env, r)) };
    },
  }),
  describe({
    name: 'describe-internet-gateways',
    desc: 'インターネットゲートウェイの一覧',
    params: [ids('internet-gateway-ids', 'IGW の ID で絞る'), filters],
    run: (ctx) => {
      const list = applyFilters(ctx, byIds(ctx.env.internetGateways, strs(ctx, 'internet-gateway-ids'), (g) => g.internetGatewayId, notFound('InvalidInternetGatewayID.NotFound', 'internetGateway')), {
        'internet-gateway-id': (g) => g.internetGatewayId,
        'attachment.vpc-id': (g) => g.attachments.map((a) => a.vpcId),
        'attachment.state': (g) => g.attachments.map((a) => a.state),
      });
      return { InternetGateways: list.map((g) => igwOut(ctx.env, g)) };
    },
  }),
  describe({
    name: 'describe-security-groups',
    desc: 'セキュリティグループの一覧 (ルールつき)',
    params: [ids('group-ids', 'グループ ID で絞る'), ids('group-names', 'グループ名で絞る'), filters],
    run: (ctx) => {
      let list = byIds(ctx.env.securityGroups, strs(ctx, 'group-ids'), (g) => g.groupId, (id) => new AwsError('InvalidGroup.NotFound', `The security group '${id}' does not exist`));
      /* --group-names で引けるのはデフォルト VPC のグループだけ (ほかの VPC は --filters Name=group-name を使う) */
      const def = ctx.env.vpcs.find((v) => v.isDefault);
      if (strs(ctx, 'group-names').length) list = list.filter((g) => g.vpcId === def?.vpcId);
      list = byIds(list, strs(ctx, 'group-names'), (g) => g.groupName, (id) => new AwsError('InvalidGroup.NotFound', `The security group '${id}' does not exist in default VPC '${def?.vpcId ?? 'none'}'`));
      list = applyFilters(ctx, list, {
        'group-id': (g) => g.groupId,
        'group-name': (g) => g.groupName,
        'vpc-id': (g) => g.vpcId,
        description: (g) => g.description,
        'ip-permission.from-port': (g) => g.ingress.map((r) => String(r.fromPort)),
        'ip-permission.to-port': (g) => g.ingress.map((r) => String(r.toPort)),
        'ip-permission.cidr': (g) => g.ingress.flatMap((r) => (r.cidrIpv4 ? [r.cidrIpv4] : [])),
        'ip-permission.group-id': (g) => g.ingress.flatMap((r) => (r.referencedGroupId ? [r.referencedGroupId] : [])),
      });
      return { SecurityGroups: list.map((g) => sgOut(ctx.env, g)) };
    },
  }),
  describe({
    name: 'describe-security-group-rules',
    desc: 'セキュリティグループのルールを 1 行ずつ (ルール ID つき)',
    params: [ids('security-group-rule-ids', 'ルール ID で絞る'), filters],
    run: (ctx) => {
      const rows = ctx.env.securityGroups.flatMap((g) => [...g.ingress.map((r) => ({ g, r, egress: false })), ...g.egress.map((r) => ({ g, r, egress: true }))]).map((x) => ({ ...x, tags: [] as Tag[] }));
      let list = byIds(rows, strs(ctx, 'security-group-rule-ids'), (x) => x.r.securityGroupRuleId, (id) => new AwsError('InvalidSecurityGroupRuleId.NotFound', `The security group rule ID '${id}' does not exist`));
      list = applyFilters(ctx, list, { 'group-id': (x) => x.g.groupId, 'security-group-rule-id': (x) => x.r.securityGroupRuleId });
      return { SecurityGroupRules: list.map((x) => sgRuleOut(ctx.env, x.g, x.r, x.egress)) };
    },
  }),
  describe({
    name: 'describe-network-acls',
    desc: 'ネットワーク ACL の一覧 (エントリと関連付け)',
    params: [ids('network-acl-ids', 'ネットワーク ACL の ID で絞る'), filters],
    run: (ctx) => {
      const list = applyFilters(ctx, byIds(ctx.env.networkAcls, strs(ctx, 'network-acl-ids'), (n) => n.networkAclId, notFound('InvalidNetworkAclID.NotFound', 'networkAcl')), {
        'network-acl-id': (n) => n.networkAclId,
        'vpc-id': (n) => n.vpcId,
        default: (n) => String(n.isDefault),
        'association.subnet-id': (n) => n.associations.map((a) => a.subnetId),
      });
      return { NetworkAcls: list.map((n) => naclOut(ctx.env, n)) };
    },
  }),
  describe({
    name: 'describe-instances',
    desc: 'EC2 インスタンスの一覧 (Reservations[].Instances[] の中にある)',
    params: [ids('instance-ids', 'インスタンス ID で絞る'), filters],
    run: (ctx) => {
      const list = applyFilters(ctx, byIds(ctx.env.instances, strs(ctx, 'instance-ids'), (i) => i.instanceId, (id) => new AwsError('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`)), {
        'instance-id': (i) => i.instanceId,
        'instance-state-name': (i) => i.state,
        'instance-type': (i) => i.instanceType,
        'vpc-id': (i) => i.vpcId,
        'subnet-id': (i) => i.subnetId,
        'availability-zone': (i) => i.availabilityZone,
        'private-ip-address': (i) => i.privateIpAddress,
        'ip-address': (i) => i.publicIpAddress,
        'instance.group-id': (i) => i.securityGroupIds,
        'instance.group-name': (i) => i.securityGroupIds.map((id) => ctx.env.securityGroups.find((g) => g.groupId === id)?.groupName ?? ''),
        'image-id': (i) => i.imageId,
        'key-name': (i) => i.keyName,
        'iam-instance-profile.arn': (i) => i.iamInstanceProfileArn,
      });
      return { Reservations: list.map((i) => reservationOut(ctx.env, i)) };
    },
  }),
  describe({
    name: 'describe-instance-status',
    desc: 'インスタンスの状態 (既定では running のものだけ)',
    params: [ids('instance-ids', 'インスタンス ID で絞る'), { name: 'include-all-instances', type: 'boolean', desc: 'running 以外も出す' }],
    run: (ctx) => {
      const all = ctx.p['include-all-instances'] === true;
      const list = byIds(ctx.env.instances, strs(ctx, 'instance-ids'), (i) => i.instanceId, (id) => new AwsError('InvalidInstanceID.NotFound', `The instance ID '${id}' does not exist`)).filter((i) => all || i.state === 'running');
      const ok = (i: (typeof list)[number]) => (i.state === 'running' ? 'ok' : 'not-applicable');
      return { InstanceStatuses: list.map((i) => ({ AvailabilityZone: i.availabilityZone, InstanceId: i.instanceId, InstanceState: { Code: { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 }[i.state], Name: i.state }, InstanceStatus: { Details: [{ Name: 'reachability', Status: 'passed' }], Status: ok(i) }, SystemStatus: { Details: [{ Name: 'reachability', Status: 'passed' }], Status: ok(i) } })) };
    },
  }),
  describe({
    name: 'describe-key-pairs',
    desc: 'キーペアの一覧',
    params: [ids('key-names', 'キーペア名で絞る')],
    run: (ctx) => ({
      KeyPairs: byIds(ctx.env.keyPairs, strs(ctx, 'key-names'), (k) => k, (k) => new AwsError('InvalidKeyPair.NotFound', `The key pair '${k}' does not exist`)).map((k, n) => ({
        KeyPairId: `key-0${(n + 1).toString(16).padStart(16, 'a')}`,
        KeyFingerprint: '1f:51:ae:28:bf:89:e9:d8:1f:25:5d:37:2d:7d:b8:ca:9f:f5:f1:6f',
        KeyName: k,
        KeyType: 'rsa',
        Tags: [],
        CreateTime: '2026-09-01T00:00:00+00:00',
      })),
    }),
  }),
  describe({
    name: 'describe-images',
    desc: 'AMI の一覧 (このシミュレーターで使えるもの)',
    params: [ids('image-ids', 'AMI ID で絞る'), ids('owners', '所有者 (amazon など。このシミュレーターでは無視)'), filters],
    scope: 'global',
    run: (ctx) => {
      const list = applyFilters(ctx, byIds(AMIS, strs(ctx, 'image-ids'), (a) => a.imageId, (id) => new AwsError('InvalidAMIID.NotFound', `The image id '[${id}]' does not exist`)), { name: (a) => a.name, 'image-id': (a) => a.imageId });
      return { Images: list.map((a) => ({ ImageId: a.imageId, Name: a.name, Description: a.description, PlatformDetails: a.platform, Architecture: 'x86_64', ImageOwnerAlias: 'amazon', OwnerId: '137112412989', Public: true, State: 'available', RootDeviceType: 'ebs', VirtualizationType: 'hvm', CreationDate: '2026-08-15T00:00:00.000Z' })) };
    },
  }),

  /* ---- タグ ---- */
  {
    name: 'create-tags',
    desc: 'リソースにタグを付ける (同じキーなら上書き)',
    params: [
      { name: 'resources', type: 'list', required: true, desc: 'リソースの ID (複数可)' },
      { name: 'tags', type: 'list', of: 'structure', required: true, desc: 'Key=Name,Value=web のように指定' },
    ],
    examples: ['aws ec2 create-tags --resources vpc-0123456789abcdef0 --tags Key=Name,Value=webapp-vpc'],
    run(ctx) {
      for (const id of strs(ctx, 'resources')) {
        const r = taggable(ctx.env, id);
        if (!r) throw new AwsError('InvalidID', `The ID '${id}' is not valid`);
        for (const t of tagsIn(structs(ctx, 'tags'))) setTag(r, t);
      }
      return undefined;
    },
  },
  {
    name: 'delete-tags',
    desc: 'リソースからタグを外す',
    params: [
      { name: 'resources', type: 'list', required: true, desc: 'リソースの ID (複数可)' },
      { name: 'tags', type: 'list', of: 'structure', desc: '外すタグ (Key=Name)。省略するとすべて' },
    ],
    run(ctx) {
      const keys = structs(ctx, 'tags').map((t) => String(t.Key));
      for (const id of strs(ctx, 'resources')) {
        const r = taggable(ctx.env, id);
        if (!r) throw new AwsError('InvalidID', `The ID '${id}' is not valid`);
        r.tags = keys.length ? r.tags.filter((t) => !keys.includes(t.key)) : [];
      }
      return undefined;
    },
  },

  /* ---- VPC / サブネット ---- */
  {
    name: 'create-vpc',
    desc: 'VPC を作成する (メインルートテーブル・デフォルトのネットワーク ACL とセキュリティグループも一緒にできる)',
    params: [{ name: 'cidr-block', type: 'string', required: true, desc: 'IPv4 の CIDR (/16〜/28)' }, tagSpecs],
    examples: ["aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=webapp-vpc}]'"],
    run(ctx) {
      const id = createVpc(ctx.env, { cidrBlock: req(ctx, 'cidr-block'), name: nameFromTagSpecs(ctx, 'vpc') });
      extraTags(ctx, id, 'vpc');
      const { BlockPublicAccessStates: _, ...vpc } = vpcOut(ctx.env, ctx.env.vpcs.find((v) => v.vpcId === id)!);
      void _;
      return { Vpc: { ...vpc, State: 'pending' } };
    },
  },
  {
    name: 'delete-vpc',
    desc: 'VPC を削除する (中のサブネットやインスタンスなどを先に消しておく)',
    params: [{ name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' }],
    run(ctx) {
      const id = req(ctx, 'vpc-id');
      /* CLI の DeleteVpc はコンソールと違い、サブネットを道連れにしない */
      if (ctx.env.subnets.some((s) => s.vpcId === id) || ctx.env.internetGateways.some((g) => g.attachments.some((a) => a.vpcId === id)) || ctx.env.securityGroups.some((g) => g.vpcId === id && g.groupName !== 'default'))
        throw new AwsError('DependencyViolation', `The vpc '${id}' has dependencies and cannot be deleted.`);
      deleteVpc(ctx.env, id);
      return undefined;
    },
  },
  {
    name: 'create-subnet',
    desc: 'VPC の中にサブネットを作成する',
    params: [
      { name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' },
      { name: 'cidr-block', type: 'string', required: true, desc: 'IPv4 の CIDR (VPC の CIDR の内側)' },
      { name: 'availability-zone', type: 'string', desc: 'AZ の名前 (例: ap-northeast-1a)。省略すると AWS が選ぶ' },
      tagSpecs,
    ],
    examples: ["aws ec2 create-subnet --vpc-id vpc-0123456789abcdef0 --cidr-block 10.0.1.0/24 --availability-zone ap-northeast-1a --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=public-subnet-1a}]'"],
    run(ctx) {
      const az = (ctx.p['availability-zone'] as string | undefined) ?? regionOf(ctx.env.region).azs[0];
      const id = createSubnet(ctx.env, { vpcId: req(ctx, 'vpc-id'), cidrBlock: req(ctx, 'cidr-block'), availabilityZone: az, name: nameFromTagSpecs(ctx, 'subnet') });
      extraTags(ctx, id, 'subnet');
      return { Subnet: subnetOut(ctx.env, ctx.env.subnets.find((s) => s.subnetId === id)!) };
    },
  },
  {
    name: 'delete-subnet',
    desc: 'サブネットを削除する (中にインスタンスなどがあると消せない)',
    params: [{ name: 'subnet-id', type: 'string', required: true, desc: 'サブネット ID' }],
    run(ctx) {
      deleteSubnet(ctx.env, req(ctx, 'subnet-id'));
      return undefined;
    },
  },

  /* ---- 待機 ---- */
  ...(['running', 'stopped', 'terminated'] as const).map(
    (state): OperationSpec => ({
      name: `wait instance-${state}`,
      desc: `インスタンスが ${state} になるまで待つ`,
      params: [ids('instance-ids', 'インスタンス ID'), filters],
      readOnly: true,
      waiter: {
        until(ctx) {
          const ids = strs(ctx, 'instance-ids');
          const list = applyFilters(ctx, ids.length ? ids.map((id) => getInstance(ctx.env, id)) : ctx.env.instances, { 'instance-id': (i) => i.instanceId, 'instance-state-name': (i) => i.state, 'vpc-id': (i) => i.vpcId, 'subnet-id': (i) => i.subnetId });
          if (!list.length) return false;
          if (state === 'running' && list.some((i) => i.state === 'terminated' || i.state === 'shutting-down')) throw new AwsError('WaiterFailed', 'Waiter InstanceRunning failed: Waiter encountered a terminal failure state: For expression "Reservations[].Instances[].State.Name" we matched expected path: "terminated" at least once');
          return list.every((i) => i.state === state);
        },
      },
      run: () => undefined,
    }),
  ),
  {
    name: 'wait vpc-available',
    desc: 'VPC が available になるまで待つ',
    params: [ids('vpc-ids', 'VPC ID')],
    readOnly: true,
    waiter: { until: (ctx) => strs(ctx, 'vpc-ids').every((id) => ctx.env.vpcs.some((v) => v.vpcId === id)) },
    run: () => undefined,
  },
];

export default service('ec2', 'Amazon EC2 (VPC・サブネット・ルートテーブル・セキュリティグループ・インスタンス)', ops);
