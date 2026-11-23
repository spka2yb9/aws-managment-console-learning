/* aws ec2 — NAT ゲートウェイと VPC エンドポイント (S3 のゲートウェイエンドポイント、Systems Manager などのインターフェイスエンドポイント) */
import { createNatGateway, createVpcEndpoint, deleteNatGateway, deleteVpcEndpoint, endpointDnsName } from '../../../sim/vpc';
import type { AwsEnv, NatGateway, VpcEndpoint } from '../../../sim/types';
import { applyFilters, AwsError, bool, byIds, iso, nameFromTagSpecs, req, service, str, strs, tagsOut, type FilterFields, type OpContext, type OperationSpec } from '../types';

const tags = (t: { key: string; value: string }[]) => (t.length ? { Tags: tagsOut(t) } : {});
const tagSpecs = { name: 'tag-specifications', type: 'list' as const, of: 'structure' as const, desc: "作成と同時に付けるタグ。例: 'ResourceType=natgateway,Tags=[{Key=Name,Value=x}]'" };

const natOut = (n: NatGateway) => ({
  CreateTime: iso(n.createTime),
  ...(n.state === 'deleting' || n.state === 'deleted' ? { DeleteTime: iso(n.stateChangedAt) } : {}),
  NatGatewayAddresses: [{ AllocationId: `eipalloc-${n.natGatewayId.slice(4)}`, NetworkInterfaceId: `eni-${n.natGatewayId.slice(4)}`, PrivateIp: n.privateIp, PublicIp: n.publicIp, AssociationId: `eipassoc-${n.natGatewayId.slice(4)}`, IsPrimary: true, Status: n.state === 'available' ? 'succeeded' : n.state === 'pending' ? 'associating' : 'disassociating' }],
  NatGatewayId: n.natGatewayId,
  State: n.state,
  SubnetId: n.subnetId,
  VpcId: n.vpcId,
  ...tags(n.tags),
  ConnectivityType: 'public',
});

const endpointOut = (env: AwsEnv, e: VpcEndpoint) => {
  const eni = e.networkInterfaces ?? [];
  const id = e.vpcEndpointId.slice(5);
  const host = endpointDnsName(e.serviceName);
  return {
    VpcEndpointId: e.vpcEndpointId,
    VpcEndpointType: e.type,
    VpcId: e.vpcId,
    ServiceName: e.serviceName,
    State: e.state,
    PolicyDocument: '{"Version":"2008-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"*","Resource":"*"}]}',
    RouteTableIds: e.routeTableIds,
    SubnetIds: eni.map((n) => n.subnetId),
    Groups: (e.securityGroupIds ?? []).map((g) => ({ GroupId: g, GroupName: env.securityGroups.find((x) => x.groupId === g)?.groupName ?? g })),
    IpAddressType: 'ipv4',
    ...(e.type === 'Interface' ? { DnsOptions: { DnsRecordIpType: 'ipv4' } } : {}),
    PrivateDnsEnabled: !!e.privateDnsEnabled,
    RequesterManaged: false,
    NetworkInterfaceIds: eni.map((n) => n.networkInterfaceId),
    DnsEntries:
      e.type === 'Interface'
        ? [
            { DnsName: `${e.vpcEndpointId}-${id.slice(0, 8)}.${host.replace('.amazonaws.com', '')}.vpce.amazonaws.com`, HostedZoneId: 'Z2E726K9Y6RL4W' },
            ...(e.privateDnsEnabled ? [{ DnsName: host, HostedZoneId: 'ZONEIDPENDING' }] : []),
          ]
        : [],
    CreationTimestamp: iso(e.createdAt),
    ...tags(e.tags),
    OwnerId: env.accountId,
  };
};

const natFields: FilterFields<NatGateway> = { 'nat-gateway-id': (n) => n.natGatewayId, state: (n) => n.state, 'subnet-id': (n) => n.subnetId, 'vpc-id': (n) => n.vpcId };

/** describe-nat-gateways は --filters ではなく --filter (単数形) */
function nats(ctx: OpContext): NatGateway[] {
  const list = byIds(ctx.env.natGateways, strs(ctx, 'nat-gateway-ids'), (n) => n.natGatewayId, (id) => new AwsError('NatGatewayNotFound', `The Nat Gateway ${id} was not found`));
  return applyFilters({ ...ctx, p: { filters: ctx.p.filter } }, list, natFields);
}

const natQuery = [
  { name: 'nat-gateway-ids', type: 'list' as const, desc: 'NAT ゲートウェイ ID で絞る' },
  { name: 'filter', type: 'list' as const, of: 'structure' as const, desc: '絞り込み (このコマンドは --filter と単数形)。例: Name=vpc-id,Values=vpc-...' },
];

const ops: OperationSpec[] = [
  {
    name: 'describe-nat-gateways',
    desc: 'NAT ゲートウェイの一覧 (状態・サブネット・パブリック IP)',
    params: natQuery,
    readOnly: true,
    examples: ["aws ec2 describe-nat-gateways --filter Name=vpc-id,Values=vpc-0123456789abcdef0 --query 'NatGateways[].[NatGatewayId,State,SubnetId]' --output table"],
    run: (ctx) => ({ NatGateways: nats(ctx).map(natOut) }),
  },
  {
    name: 'create-nat-gateway',
    desc: 'パブリックサブネットに NAT ゲートウェイを作る (しばらく pending)',
    params: [
      { name: 'subnet-id', type: 'string', required: true, desc: '置くサブネット (パブリックサブネット)' },
      { name: 'allocation-id', type: 'string', desc: 'Elastic IP の割り当て ID (このシミュレーターでは省略すると自動で割り当てる)' },
      { name: 'connectivity-type', type: 'string', desc: 'public (既定)' },
      tagSpecs,
    ],
    run(ctx) {
      if ((str(ctx, 'connectivity-type') ?? 'public') !== 'public') throw new AwsError('InvalidParameterValue', '(シミュレーター) このシミュレーターはパブリック NAT ゲートウェイだけに対応しています');
      const id = createNatGateway(ctx.env, { subnetId: req(ctx, 'subnet-id'), name: nameFromTagSpecs(ctx, 'natgateway') }, ctx.now);
      return { NatGateway: natOut(ctx.env.natGateways.find((n) => n.natGatewayId === id)!) };
    },
  },
  {
    name: 'delete-nat-gateway',
    desc: 'NAT ゲートウェイを消す (deleting → deleted。向いているルートは blackhole になる)',
    params: [{ name: 'nat-gateway-id', type: 'string', required: true, desc: 'NAT ゲートウェイ ID' }],
    run(ctx) {
      deleteNatGateway(ctx.env, req(ctx, 'nat-gateway-id'), ctx.now);
      return { NatGatewayId: req(ctx, 'nat-gateway-id') };
    },
  },
  {
    name: 'wait nat-gateway-available',
    desc: 'NAT ゲートウェイが available になるまで待つ',
    params: natQuery,
    readOnly: true,
    waiter: { until: (ctx) => nats(ctx).every((n) => n.state === 'available') },
    run: () => undefined,
  },
  {
    name: 'wait nat-gateway-deleted',
    desc: 'NAT ゲートウェイが deleted になるまで待つ (deleting の間も時間料金はかかる)',
    params: natQuery,
    readOnly: true,
    waiter: { until: (ctx) => nats(ctx).every((n) => n.state === 'deleted') },
    run: () => undefined,
  },
  {
    name: 'create-vpc-endpoint',
    desc: 'VPC エンドポイントを作る (ゲートウェイ型: ルートテーブルに S3 行きのルートが足される / インターフェイス型: サブネットにネットワークインターフェイスを置く)',
    params: [
      { name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' },
      { name: 'service-name', type: 'string', required: true, desc: '例: com.amazonaws.ap-northeast-1.s3 (Gateway) / com.amazonaws.ap-northeast-1.ssm (Interface)' },
      { name: 'vpc-endpoint-type', type: 'string', desc: 'Gateway (既定) / Interface' },
      { name: 'route-table-ids', type: 'list', desc: 'Gateway: ルートを足すルートテーブルの ID (空白区切りで複数)' },
      { name: 'subnet-ids', type: 'list', desc: 'Interface: ネットワークインターフェイスを置くサブネット (1 つの AZ に 1 つまで)' },
      { name: 'security-group-ids', type: 'list', desc: 'Interface: ネットワークインターフェイスに付けるセキュリティグループ (省略すると VPC の default)' },
      { name: 'private-dns-enabled', type: 'boolean', desc: 'Interface: サービスの名前 (ssm.ap-northeast-1.amazonaws.com) を VPC の中ではこのエンドポイントに向ける (既定で有効。--no-private-dns-enabled で無効)' },
      tagSpecs,
    ],
    examples: [
      'aws ec2 create-vpc-endpoint --vpc-id vpc-0123456789abcdef0 --service-name com.amazonaws.ap-northeast-1.s3 --route-table-ids rtb-0123456789abcdef0 rtb-0fedcba9876543210',
      'aws ec2 create-vpc-endpoint --vpc-id vpc-0123456789abcdef0 --vpc-endpoint-type Interface --service-name com.amazonaws.ap-northeast-1.ssm --subnet-ids subnet-0123456789abcdef0 --security-group-ids sg-0123456789abcdef0',
    ],
    run(ctx) {
      const type = str(ctx, 'vpc-endpoint-type') ?? 'Gateway';
      if (type !== 'Gateway' && type !== 'Interface') throw new AwsError('InvalidParameter', `(シミュレーター) --vpc-endpoint-type は Gateway か Interface に対応しています (${type} は未対応)`);
      const id = createVpcEndpoint(
        ctx.env,
        { vpcId: req(ctx, 'vpc-id'), serviceName: req(ctx, 'service-name'), type, routeTableIds: strs(ctx, 'route-table-ids'), subnetIds: strs(ctx, 'subnet-ids'), securityGroupIds: strs(ctx, 'security-group-ids'), privateDnsEnabled: bool(ctx, 'private-dns-enabled'), name: nameFromTagSpecs(ctx, 'vpc-endpoint') },
        ctx.now,
      );
      const out = endpointOut(ctx.env, ctx.env.vpcEndpoints.find((e) => e.vpcEndpointId === id)!);
      // a new interface endpoint answers "pending" (the simulator makes it available at once)
      return { VpcEndpoint: type === 'Interface' ? { ...out, State: 'pending' } : out };
    },
  },
  {
    name: 'describe-vpc-endpoints',
    desc: 'VPC エンドポイントの一覧',
    params: [
      { name: 'vpc-endpoint-ids', type: 'list', desc: 'エンドポイント ID で絞る' },
      { name: 'filters', type: 'list', of: 'structure', desc: '絞り込み。例: Name=vpc-id,Values=vpc-...' },
    ],
    readOnly: true,
    run(ctx) {
      const list = byIds(ctx.env.vpcEndpoints, strs(ctx, 'vpc-endpoint-ids'), (e) => e.vpcEndpointId, (id) => new AwsError('InvalidVpcEndpointId.NotFound', `The VpcEndpoint Id '${id}' does not exist`));
      const out = applyFilters(ctx, list, { 'vpc-endpoint-id': (e) => e.vpcEndpointId, 'vpc-id': (e) => e.vpcId, 'service-name': (e) => e.serviceName, 'vpc-endpoint-state': (e) => e.state, 'vpc-endpoint-type': (e) => e.type });
      return { VpcEndpoints: out.map((e) => endpointOut(ctx.env, e)) };
    },
  },
  {
    name: 'delete-vpc-endpoints',
    desc: 'VPC エンドポイントを消す (足したルートも消える)',
    params: [{ name: 'vpc-endpoint-ids', type: 'list', required: true, desc: 'エンドポイント ID (空白区切りで複数)' }],
    run(ctx) {
      const Unsuccessful = [];
      for (const id of strs(ctx, 'vpc-endpoint-ids')) {
        try {
          deleteVpcEndpoint(ctx.env, id);
        } catch (e) {
          if (!(e instanceof AwsError)) throw e;
          Unsuccessful.push({ Error: { Code: e.code, Message: e.message }, ResourceId: id });
        }
      }
      return { Unsuccessful };
    },
  },
];

export default service('ec2', '', ops);
