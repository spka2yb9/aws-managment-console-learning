/* aws ec2 — ルートテーブル・インターネットゲートウェイ・セキュリティグループ・ネットワーク ACL・サブネットの属性の変更 */
import { trail } from '../../../sim/cloudtrail';
import { getIgw, getNacl, getRouteTable, getSg, getSubnet, getVpc } from '../../../sim/env';
import { newId } from '../../../sim/ids';
import { associateSubnetNacl, createNetworkAcl, replaceNetworkAclEntries, type NaclEntryInput } from '../../../sim/nacl';
import { createSecurityGroup, setSecurityGroupRules, sgUsers, type RuleInput } from '../../../sim/sg';
import type { IpProtocol, NetworkAclEntry, RouteTable, SecurityGroup, SecurityGroupRule } from '../../../sim/types';
import { attachInternetGateway, createInternetGateway, createRouteTable, detachInternetGateway, modifySubnetAttribute, replaceRoutes, setSubnetAssociations } from '../../../sim/vpc';
import { igwOut, naclOut, routeTableOut, sgRuleOut } from '../shapes';
import { AwsError, ParamError, bool, int, nameFromTagSpecs, req, service, str, strs, structs, type OpContext, type OperationSpec } from '../types';
import { taggable } from './ec2-core';

const tagSpecs = { name: 'tag-specifications', type: 'list' as const, of: 'structure' as const, desc: "作成と同時に付けるタグ。例: 'ResourceType=route-table,Tags=[{Key=Name,Value=public-rt}]'" };

function extraTags(ctx: OpContext, id: string, resourceType: string) {
  const r = taggable(ctx.env, id);
  if (!r) return;
  for (const s of structs(ctx, 'tag-specifications')) {
    if (s.ResourceType && s.ResourceType !== resourceType) continue;
    for (const t of [s.Tags].flat() as Record<string, unknown>[]) {
      if (!t || t.Key === 'Name') continue;
      const cur = r.tags.find((x) => x.key === t.Key);
      if (cur) cur.value = String(t.Value ?? '');
      else r.tags.push({ key: String(t.Key), value: String(t.Value ?? '') });
    }
  }
}

/* ---- ルートテーブル ---- */

/** ルートテーブルのいまのルート (local とゲートウェイエンドポイントのものを除く) を replaceRoutes の形で */
const customRoutes = (rt: RouteTable) => rt.routes.filter((r) => r.gatewayId !== 'local' && !r.destinationPrefixListId).map((r) => ({ destinationCidrBlock: r.destinationCidrBlock, gatewayId: (r.natGatewayId ?? r.gatewayId)! }));

const routeTarget = (ctx: OpContext) => {
  const t = str(ctx, 'gateway-id') ?? str(ctx, 'nat-gateway-id');
  if (!t) throw new AwsError('MissingParameter', 'The request must contain exactly one of gatewayId, natGatewayId, networkInterfaceId, vpcPeeringConnectionId or instanceId');
  return t;
};

const routeParams = [
  { name: 'route-table-id', type: 'string' as const, required: true, desc: 'ルートテーブル ID' },
  { name: 'destination-cidr-block', type: 'string' as const, required: true, desc: '宛先の CIDR (例: 0.0.0.0/0)' },
  { name: 'gateway-id', type: 'string' as const, desc: 'インターネットゲートウェイ ID (igw-...)' },
  { name: 'nat-gateway-id', type: 'string' as const, desc: 'NAT ゲートウェイ ID (nat-...)' },
];

/* ---- セキュリティグループ ---- */

const PROTOCOLS: Record<string, IpProtocol> = { tcp: 'tcp', '6': 'tcp', udp: 'udp', '17': 'udp', icmp: 'icmp', '1': 'icmp', all: '-1', '-1': '-1' };
const protocolOf = (p: unknown): IpProtocol => {
  const v = PROTOCOLS[String(p ?? '').toLowerCase()];
  if (!v) throw new AwsError('InvalidParameterValue', `Invalid value '${String(p)}' for IP protocol. Unknown protocol.`);
  return v;
};

/** --protocol / --port / --cidr / --source-group の簡単な書き方と、--ip-permissions の書き方の両方を RuleInput に */
function ruleInputs(ctx: OpContext): RuleInput[] {
  const perms = structs(ctx, 'ip-permissions');
  if (perms.length) {
    return perms.flatMap((p) => {
      const proto = protocolOf(p.IpProtocol);
      const from = p.FromPort === undefined ? -1 : Number(p.FromPort);
      const to = p.ToPort === undefined ? from : Number(p.ToPort);
      const ranges = ([p.IpRanges].flat().filter(Boolean) as Record<string, unknown>[]).map((r) => ({ source: String(r.CidrIp ?? ''), description: r.Description as string | undefined }));
      const groups = ([p.UserIdGroupPairs].flat().filter(Boolean) as Record<string, unknown>[]).map((g) => ({ source: String(g.GroupId ?? ''), description: g.Description as string | undefined }));
      const peers = [...ranges, ...groups];
      if (!peers.length) throw new AwsError('InvalidParameterValue', 'The request must contain at least one of IpRanges, Ipv6Ranges, PrefixListIds or UserIdGroupPairs');
      return peers.map((x) => ({ ipProtocol: proto, fromPort: from, toPort: to, source: x.source, description: x.description }));
    });
  }
  const proto = protocolOf(str(ctx, 'protocol'));
  const port = str(ctx, 'port') ?? '-1';
  if (!/^-?\d+(-\d+)?$/.test(port)) throw new ParamError('port parameter should be of the form <from[-to]> (e.g., 22 or 22-25)');
  const [a, b = a] = port.split('-').map(Number);
  const [from, to] = port === '-1' || proto === '-1' ? [-1, -1] : [a, b];
  const source = str(ctx, 'cidr') ?? str(ctx, 'source-group');
  if (!source) throw new AwsError('MissingParameter', 'Either --cidr or --source-group (or --ip-permissions) is required');
  if (proto !== '-1' && port === '-1' && proto !== 'icmp') throw new AwsError('InvalidParameterValue', 'Invalid value for portRange. Must specify both from and to ports with TCP/UDP.');
  return [{ ipProtocol: proto, fromPort: from, toPort: to, source }];
}

const toInput = (r: SecurityGroupRule): RuleInput => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)!, description: r.description });
const sameRule = (a: RuleInput, b: RuleInput) => a.ipProtocol === b.ipProtocol && (a.ipProtocol === '-1' || (a.fromPort === b.fromPort && a.toPort === b.toPort)) && a.source === b.source;

const ruleParams = [
  { name: 'group-id', type: 'string' as const, required: true, desc: 'セキュリティグループ ID' },
  { name: 'protocol', type: 'string' as const, desc: 'tcp / udp / icmp / all (-1)' },
  { name: 'port', type: 'string' as const, desc: 'ポート (22) か範囲 (1024-65535)' },
  { name: 'cidr', type: 'string' as const, desc: '相手の CIDR (例: 203.0.113.0/24)' },
  { name: 'source-group', type: 'string' as const, desc: '相手のセキュリティグループ ID (sg-...)' },
  { name: 'ip-permissions', type: 'list' as const, of: 'structure' as const, desc: "まとめて書く形。例: 'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]'" },
];

function authorize(direction: 'ingress' | 'egress') {
  return (ctx: OpContext) => {
    const g = getSg(ctx.env, req(ctx, 'group-id'));
    const adds = ruleInputs(ctx);
    for (const a of adds) {
      const dup = g[direction].map(toInput).find((r) => sameRule(r, a));
      if (dup) throw new AwsError('InvalidPermission.Duplicate', `the specified rule "peer: ${a.source}, ${a.ipProtocol === '-1' ? 'ALL' : a.ipProtocol.toUpperCase()}, from port: ${a.fromPort}, to port: ${a.toPort}, ALLOW" already exists`);
    }
    const { authorized } = setSecurityGroupRules(ctx.env, g.groupId, direction, [...g[direction].map(toInput), ...adds]);
    const fresh = getSg(ctx.env, g.groupId);
    return { Return: true, SecurityGroupRules: authorized.map((r) => sgRuleOut(ctx.env, fresh, fresh[direction].find((x) => x.securityGroupRuleId === r.securityGroupRuleId) ?? r, direction === 'egress')) };
  };
}

function revoke(direction: 'ingress' | 'egress') {
  return (ctx: OpContext) => {
    const g: SecurityGroup = getSg(ctx.env, req(ctx, 'group-id'));
    const current = g[direction].map(toInput);
    const ids = strs(ctx, 'security-group-rule-ids');
    let keep: RuleInput[];
    if (ids.length) {
      for (const id of ids) if (!current.some((r) => r.securityGroupRuleId === id)) throw new AwsError('InvalidSecurityGroupRuleId.NotFound', `The security group rule ID '${id}' does not exist`);
      keep = current.filter((r) => !ids.includes(r.securityGroupRuleId!));
    } else {
      const drops = ruleInputs(ctx);
      for (const d of drops) if (!current.some((r) => sameRule(r, d))) throw new AwsError('InvalidPermission.NotFound', 'The specified rule does not exist in this security group.');
      keep = current.filter((r) => !drops.some((d) => sameRule(r, d)));
    }
    setSecurityGroupRules(ctx.env, g.groupId, direction, keep);
    return { Return: true };
  };
}

/* ---- ネットワーク ACL ---- */

function naclEntry(ctx: OpContext): NaclEntryInput & { egress: boolean } {
  const range = (ctx.p['port-range'] ?? {}) as Record<string, unknown>;
  const protocol = protocolOf(req(ctx, 'protocol'));
  const action = req(ctx, 'rule-action').toLowerCase();
  if (action !== 'allow' && action !== 'deny') throw new AwsError('InvalidParameterValue', `Invalid value '${action}' for ruleAction. It must be 'allow' or 'deny'.`);
  if ((protocol === 'tcp' || protocol === 'udp') && range.From === undefined) throw new AwsError('MissingParameter', 'The request must contain the parameter portRange');
  return {
    ruleNumber: int(ctx, 'rule-number')!,
    protocol,
    ruleAction: action,
    cidrBlock: req(ctx, 'cidr-block'),
    ...(range.From !== undefined ? { fromPort: Number(range.From), toPort: Number(range.To ?? range.From) } : {}),
    egress: bool(ctx, 'egress') === true,
  };
}
const asInput = (e: NetworkAclEntry): NaclEntryInput => ({ ruleNumber: e.ruleNumber, protocol: e.protocol, ruleAction: e.ruleAction, cidrBlock: e.cidrBlock, fromPort: e.fromPort, toPort: e.toPort });

const naclEntryParams = [
  { name: 'network-acl-id', type: 'string' as const, required: true, desc: 'ネットワーク ACL の ID' },
  { name: 'rule-number', type: 'integer' as const, required: true, desc: 'ルール番号 (小さい順に評価される)' },
  { name: 'protocol', type: 'string' as const, required: true, desc: 'tcp (6) / udp (17) / icmp (1) / -1 (すべて)' },
  { name: 'rule-action', type: 'string' as const, required: true, desc: 'allow / deny' },
  { name: 'cidr-block', type: 'string' as const, required: true, desc: '相手の CIDR' },
  { name: 'port-range', type: 'structure' as const, desc: 'From=80,To=80' },
  { name: 'egress', type: 'boolean' as const, desc: 'アウトバウンドのルール (付けなければ --ingress)' },
  { name: 'ingress', type: 'boolean' as const, desc: 'インバウンドのルール' },
];

const ops: OperationSpec[] = [
  /* ---- サブネットの属性 ---- */
  {
    name: 'modify-subnet-attribute',
    desc: 'サブネットの属性を変える (起動したインスタンスにパブリック IP を自動で付けるか、など)',
    params: [
      { name: 'subnet-id', type: 'string', required: true, desc: 'サブネット ID' },
      { name: 'map-public-ip-on-launch', type: 'boolean', desc: 'パブリック IPv4 アドレスを自動で割り当てる (--no-map-public-ip-on-launch で外す)' },
    ],
    run(ctx) {
      const v = bool(ctx, 'map-public-ip-on-launch');
      if (v === undefined) throw new AwsError('MissingParameter', 'Exactly one attribute must be specified (--map-public-ip-on-launch / --no-map-public-ip-on-launch)');
      modifySubnetAttribute(ctx.env, req(ctx, 'subnet-id'), { mapPublicIpOnLaunch: v });
      return undefined;
    },
  },

  /* ---- ルートテーブル ---- */
  {
    name: 'create-route-table',
    desc: 'ルートテーブルを作成する (最初は local ルートだけ)',
    params: [{ name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' }, tagSpecs],
    run(ctx) {
      const id = createRouteTable(ctx.env, { vpcId: req(ctx, 'vpc-id'), name: nameFromTagSpecs(ctx, 'route-table') });
      extraTags(ctx, id, 'route-table');
      return { RouteTable: routeTableOut(ctx.env, getRouteTable(ctx.env, id)) };
    },
  },
  {
    name: 'delete-route-table',
    desc: 'ルートテーブルを削除する (サブネットとの関連付けを先に外す)',
    params: [{ name: 'route-table-id', type: 'string', required: true, desc: 'ルートテーブル ID' }],
    run(ctx) {
      const rt = getRouteTable(ctx.env, req(ctx, 'route-table-id'));
      if (rt.associations.length) throw new AwsError('DependencyViolation', `The routeTable '${rt.routeTableId}' has dependencies and cannot be deleted.`);
      ctx.env.routeTables = ctx.env.routeTables.filter((x) => x !== rt);
      trail(ctx.env, { source: 'ec2', name: 'DeleteRouteTable', resources: [['AWS::EC2::RouteTable', rt.routeTableId]], request: { routeTableId: rt.routeTableId } });
      return undefined;
    },
  },
  {
    name: 'create-route',
    desc: 'ルートテーブルにルートを足す',
    params: routeParams,
    examples: ['aws ec2 create-route --route-table-id rtb-0123456789abcdef0 --destination-cidr-block 0.0.0.0/0 --gateway-id igw-0123456789abcdef0'],
    run(ctx) {
      const rt = getRouteTable(ctx.env, req(ctx, 'route-table-id'));
      const dest = req(ctx, 'destination-cidr-block');
      if (rt.routes.some((r) => r.destinationCidrBlock === dest)) throw new AwsError('RouteAlreadyExists', `The route identified by ${dest} already exists.`);
      replaceRoutes(ctx.env, rt.routeTableId, [...customRoutes(rt), { destinationCidrBlock: dest, gatewayId: routeTarget(ctx) }]);
      return { Return: true };
    },
  },
  {
    name: 'replace-route',
    desc: 'ルートテーブルの既存のルートの行き先を変える',
    params: routeParams,
    run(ctx) {
      const rt = getRouteTable(ctx.env, req(ctx, 'route-table-id'));
      const dest = req(ctx, 'destination-cidr-block');
      const routes = customRoutes(rt);
      if (!routes.some((r) => r.destinationCidrBlock === dest)) throw new AwsError('InvalidParameterValue', `There is no route defined for '${dest}' in the route table. Use CreateRoute instead.`);
      replaceRoutes(ctx.env, rt.routeTableId, routes.map((r) => (r.destinationCidrBlock === dest ? { destinationCidrBlock: dest, gatewayId: routeTarget(ctx) } : r)));
      return undefined;
    },
  },
  {
    name: 'delete-route',
    desc: 'ルートテーブルからルートを消す',
    params: routeParams.slice(0, 2),
    run(ctx) {
      const rt = getRouteTable(ctx.env, req(ctx, 'route-table-id'));
      const dest = req(ctx, 'destination-cidr-block');
      const routes = customRoutes(rt);
      if (!routes.some((r) => r.destinationCidrBlock === dest)) throw new AwsError('InvalidRoute.NotFound', `no route with destination-cidr-block ${dest} in route table ${rt.routeTableId}`);
      replaceRoutes(ctx.env, rt.routeTableId, routes.filter((r) => r.destinationCidrBlock !== dest));
      return undefined;
    },
  },
  {
    name: 'associate-route-table',
    desc: 'サブネットをルートテーブルに関連付ける (このサブネットはこの表を使う)',
    params: [
      { name: 'route-table-id', type: 'string', required: true, desc: 'ルートテーブル ID' },
      { name: 'subnet-id', type: 'string', required: true, desc: 'サブネット ID' },
    ],
    run(ctx) {
      const rt = getRouteTable(ctx.env, req(ctx, 'route-table-id'));
      const subnetId = getSubnet(ctx.env, req(ctx, 'subnet-id')).subnetId;
      const other = ctx.env.routeTables.find((x) => x.associations.some((a) => a.subnetId === subnetId));
      if (other && other !== rt) throw new AwsError('Resource.AlreadyAssociated', `the specified association for route table ${rt.routeTableId} conflicts with an existing association`);
      if (other === rt) throw new AwsError('Resource.AlreadyAssociated', `the specified association for route table ${rt.routeTableId} conflicts with an existing association`);
      setSubnetAssociations(ctx.env, rt.routeTableId, [...rt.associations.flatMap((a) => (a.subnetId ? [a.subnetId] : [])), subnetId]);
      const a = getRouteTable(ctx.env, rt.routeTableId).associations.find((x) => x.subnetId === subnetId)!;
      return { AssociationId: a.routeTableAssociationId, AssociationState: { State: 'associated' } };
    },
  },
  {
    name: 'replace-route-table-association',
    desc: 'サブネットの関連付けを、別のルートテーブルに付け替える',
    params: [
      { name: 'association-id', type: 'string', required: true, desc: '関連付け ID (rtbassoc-...)' },
      { name: 'route-table-id', type: 'string', required: true, desc: '新しいルートテーブル ID' },
    ],
    run(ctx) {
      const assocId = req(ctx, 'association-id');
      const from = ctx.env.routeTables.find((x) => x.associations.some((a) => a.routeTableAssociationId === assocId));
      const a = from?.associations.find((x) => x.routeTableAssociationId === assocId);
      if (!from || !a) throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${assocId}' does not exist`);
      const to = getRouteTable(ctx.env, req(ctx, 'route-table-id'));
      if (a.main) {
        from.associations = from.associations.filter((x) => x !== a);
        to.associations.push({ ...a, routeTableAssociationId: newId('rtbassoc') });
        trail(ctx.env, { source: 'ec2', name: 'ReplaceRouteTableAssociation', resources: [['AWS::EC2::RouteTable', to.routeTableId]], request: { associationId: assocId, routeTableId: to.routeTableId } });
        return { NewAssociationId: to.associations.at(-1)!.routeTableAssociationId, AssociationState: { State: 'associated' } };
      }
      setSubnetAssociations(ctx.env, to.routeTableId, [...to.associations.flatMap((x) => (x.subnetId ? [x.subnetId] : [])), a.subnetId!]);
      return { NewAssociationId: getRouteTable(ctx.env, to.routeTableId).associations.find((x) => x.subnetId === a.subnetId)!.routeTableAssociationId, AssociationState: { State: 'associated' } };
    },
  },
  {
    name: 'disassociate-route-table',
    desc: 'サブネットとルートテーブルの関連付けを外す (サブネットはメインルートテーブルに戻る)',
    params: [{ name: 'association-id', type: 'string', required: true, desc: '関連付け ID (rtbassoc-...)' }],
    run(ctx) {
      const assocId = req(ctx, 'association-id');
      const rt = ctx.env.routeTables.find((x) => x.associations.some((a) => a.routeTableAssociationId === assocId));
      const a = rt?.associations.find((x) => x.routeTableAssociationId === assocId);
      if (!rt || !a) throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${assocId}' does not exist`);
      if (a.main) throw new AwsError('InvalidParameterValue', 'Cannot disassociate the main route table association');
      setSubnetAssociations(ctx.env, rt.routeTableId, rt.associations.flatMap((x) => (x.subnetId && x !== a ? [x.subnetId] : [])));
      return undefined;
    },
  },

  /* ---- インターネットゲートウェイ ---- */
  {
    name: 'create-internet-gateway',
    desc: 'インターネットゲートウェイを作成する (まだどの VPC にもつながっていない)',
    params: [tagSpecs],
    run(ctx) {
      const id = createInternetGateway(ctx.env, { name: nameFromTagSpecs(ctx, 'internet-gateway') });
      extraTags(ctx, id, 'internet-gateway');
      return { InternetGateway: igwOut(ctx.env, getIgw(ctx.env, id)) };
    },
  },
  {
    name: 'attach-internet-gateway',
    desc: 'インターネットゲートウェイを VPC にアタッチする',
    params: [
      { name: 'internet-gateway-id', type: 'string', required: true, desc: 'IGW の ID' },
      { name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' },
    ],
    run(ctx) {
      attachInternetGateway(ctx.env, req(ctx, 'internet-gateway-id'), req(ctx, 'vpc-id'));
      return undefined;
    },
  },
  {
    name: 'detach-internet-gateway',
    desc: 'インターネットゲートウェイを VPC から外す',
    params: [
      { name: 'internet-gateway-id', type: 'string', required: true, desc: 'IGW の ID' },
      { name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' },
    ],
    run(ctx) {
      detachInternetGateway(ctx.env, req(ctx, 'internet-gateway-id'), req(ctx, 'vpc-id'));
      return undefined;
    },
  },
  {
    name: 'delete-internet-gateway',
    desc: 'インターネットゲートウェイを削除する (先にデタッチする)',
    params: [{ name: 'internet-gateway-id', type: 'string', required: true, desc: 'IGW の ID' }],
    run(ctx) {
      const g = getIgw(ctx.env, req(ctx, 'internet-gateway-id'));
      if (g.attachments.length) throw new AwsError('DependencyViolation', `The internetGateway '${g.internetGatewayId}' has dependencies and cannot be deleted.`);
      ctx.env.internetGateways = ctx.env.internetGateways.filter((x) => x !== g);
      trail(ctx.env, { source: 'ec2', name: 'DeleteInternetGateway', resources: [['AWS::EC2::InternetGateway', g.internetGatewayId]], request: { internetGatewayId: g.internetGatewayId } });
      return undefined;
    },
  },

  /* ---- セキュリティグループ ---- */
  {
    name: 'create-security-group',
    desc: 'セキュリティグループを作成する (インバウンドは空、アウトバウンドはすべて許可で始まる)',
    params: [
      { name: 'group-name', type: 'string', required: true, desc: 'グループ名' },
      { name: 'description', type: 'string', required: true, desc: '説明 (必須)' },
      { name: 'vpc-id', type: 'string', desc: 'VPC ID (省略するとデフォルト VPC)' },
      tagSpecs,
    ],
    run(ctx) {
      const vpcId = str(ctx, 'vpc-id') ?? ctx.env.vpcs.find((v) => v.isDefault)?.vpcId;
      if (!vpcId) throw new AwsError('VPCIdNotSpecified', 'No default VPC for this user');
      const id = createSecurityGroup(ctx.env, { groupName: req(ctx, 'group-name'), description: req(ctx, 'description'), vpcId: getVpc(ctx.env, vpcId).vpcId, name: nameFromTagSpecs(ctx, 'security-group') });
      extraTags(ctx, id, 'security-group');
      return { GroupId: id, SecurityGroupArn: `arn:aws:ec2:${ctx.env.region}:${ctx.env.accountId}:security-group/${id}` };
    },
  },
  {
    name: 'delete-security-group',
    desc: 'セキュリティグループを削除する (使っているリソースがあると消せない)',
    params: [{ name: 'group-id', type: 'string', required: true, desc: 'グループ ID' }],
    run(ctx) {
      const g = getSg(ctx.env, req(ctx, 'group-id'));
      if (g.groupName === 'default') throw new AwsError('CannotDelete', `the specified group: "${g.groupId}" name: "default" cannot be deleted by a user`);
      const users = sgUsers(ctx.env, g.groupId);
      const referenced = ctx.env.securityGroups.some((x) => x !== g && [...x.ingress, ...x.egress].some((r) => r.referencedGroupId === g.groupId));
      if (users.length || referenced) throw new AwsError('DependencyViolation', `resource ${g.groupId} has a dependent object`);
      ctx.env.securityGroups = ctx.env.securityGroups.filter((x) => x !== g);
      trail(ctx.env, { source: 'ec2', name: 'DeleteSecurityGroup', resources: [['AWS::EC2::SecurityGroup', g.groupId]], request: { groupId: g.groupId } });
      return undefined;
    },
  },
  {
    name: 'authorize-security-group-ingress',
    desc: 'セキュリティグループにインバウンドルールを足す',
    params: ruleParams,
    examples: ['aws ec2 authorize-security-group-ingress --group-id sg-0123456789abcdef0 --protocol tcp --port 80 --cidr 0.0.0.0/0', 'aws ec2 authorize-security-group-ingress --group-id sg-0123456789abcdef0 --protocol tcp --port 3000 --source-group sg-0fedcba9876543210'],
    run: authorize('ingress'),
  },
  {
    name: 'authorize-security-group-egress',
    desc: 'セキュリティグループにアウトバウンドルールを足す',
    params: [{ ...ruleParams[0] }, ruleParams[5], ...ruleParams.slice(1, 5)],
    run: authorize('egress'),
  },
  {
    name: 'revoke-security-group-ingress',
    desc: 'セキュリティグループのインバウンドルールを消す (足したときと同じ書き方か、ルール ID で指定)',
    params: [...ruleParams, { name: 'security-group-rule-ids', type: 'list', desc: 'ルール ID (sgr-...)' }],
    run: revoke('ingress'),
  },
  {
    name: 'revoke-security-group-egress',
    desc: 'セキュリティグループのアウトバウンドルールを消す',
    params: [...ruleParams, { name: 'security-group-rule-ids', type: 'list', desc: 'ルール ID (sgr-...)' }],
    run: revoke('egress'),
  },

  /* ---- ネットワーク ACL ---- */
  {
    name: 'create-network-acl',
    desc: 'ネットワーク ACL を作成する (最初はすべて拒否の * ルールだけ)',
    params: [{ name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' }, tagSpecs],
    run(ctx) {
      const id = createNetworkAcl(ctx.env, { vpcId: req(ctx, 'vpc-id'), name: nameFromTagSpecs(ctx, 'network-acl') });
      extraTags(ctx, id, 'network-acl');
      return { NetworkAcl: naclOut(ctx.env, getNacl(ctx.env, id)) };
    },
  },
  {
    name: 'delete-network-acl',
    desc: 'ネットワーク ACL を削除する (サブネットに関連付いていると消せない)',
    params: [{ name: 'network-acl-id', type: 'string', required: true, desc: 'ネットワーク ACL の ID' }],
    run(ctx) {
      const n = getNacl(ctx.env, req(ctx, 'network-acl-id'));
      if (n.isDefault) throw new AwsError('InvalidParameterValue', `cannot delete default network ACL ${n.networkAclId}`);
      if (n.associations.length) throw new AwsError('DependencyViolation', `The networkAcl '${n.networkAclId}' has dependencies and cannot be deleted.`);
      ctx.env.networkAcls = ctx.env.networkAcls.filter((x) => x !== n);
      trail(ctx.env, { source: 'ec2', name: 'DeleteNetworkAcl', resources: [['AWS::EC2::NetworkAcl', n.networkAclId]], request: { networkAclId: n.networkAclId } });
      return undefined;
    },
  },
  {
    name: 'create-network-acl-entry',
    desc: 'ネットワーク ACL にルールを足す',
    params: naclEntryParams,
    examples: ['aws ec2 create-network-acl-entry --network-acl-id acl-0123456789abcdef0 --ingress --rule-number 100 --protocol tcp --port-range From=80,To=80 --cidr-block 0.0.0.0/0 --rule-action allow'],
    run(ctx) {
      const n = getNacl(ctx.env, req(ctx, 'network-acl-id'));
      const e = naclEntry(ctx);
      const same = n.entries.filter((x) => x.egress === e.egress);
      if (same.some((x) => x.ruleNumber === e.ruleNumber)) throw new AwsError('NetworkAclEntryAlreadyExists', `The network acl entry identified by ${e.ruleNumber} already exists.`);
      replaceNetworkAclEntries(ctx.env, n.networkAclId, e.egress, [...same.map(asInput), e]);
      return undefined;
    },
  },
  {
    name: 'replace-network-acl-entry',
    desc: 'ネットワーク ACL のルールを書き換える (同じルール番号のものを置き換える)',
    params: naclEntryParams,
    run(ctx) {
      const n = getNacl(ctx.env, req(ctx, 'network-acl-id'));
      const e = naclEntry(ctx);
      const same = n.entries.filter((x) => x.egress === e.egress);
      if (!same.some((x) => x.ruleNumber === e.ruleNumber)) throw new AwsError('InvalidNetworkAclEntry.NotFound', `The network acl entry identified by ${e.ruleNumber} does not exist.`);
      replaceNetworkAclEntries(ctx.env, n.networkAclId, e.egress, same.map((x) => (x.ruleNumber === e.ruleNumber ? e : asInput(x))));
      return undefined;
    },
  },
  {
    name: 'delete-network-acl-entry',
    desc: 'ネットワーク ACL のルールを消す',
    params: [naclEntryParams[0], naclEntryParams[1], naclEntryParams[6], naclEntryParams[7]],
    run(ctx) {
      const n = getNacl(ctx.env, req(ctx, 'network-acl-id'));
      const egress = bool(ctx, 'egress') === true;
      const no = int(ctx, 'rule-number')!;
      const same = n.entries.filter((x) => x.egress === egress);
      if (!same.some((x) => x.ruleNumber === no)) throw new AwsError('InvalidNetworkAclEntry.NotFound', `The network acl entry identified by ${no} does not exist.`);
      replaceNetworkAclEntries(ctx.env, n.networkAclId, egress, same.filter((x) => x.ruleNumber !== no).map(asInput));
      return undefined;
    },
  },
  {
    name: 'replace-network-acl-association',
    desc: 'サブネットが使うネットワーク ACL を付け替える',
    params: [
      { name: 'association-id', type: 'string', required: true, desc: 'いまの関連付けの ID (aclassoc-...)' },
      { name: 'network-acl-id', type: 'string', required: true, desc: '新しいネットワーク ACL の ID' },
    ],
    run(ctx) {
      const assocId = req(ctx, 'association-id');
      const from = ctx.env.networkAcls.find((n) => n.associations.some((a) => a.networkAclAssociationId === assocId));
      const subnetId = from?.associations.find((a) => a.networkAclAssociationId === assocId)?.subnetId;
      if (!subnetId) throw new AwsError('InvalidAssociationID.NotFound', `The association ID '${assocId}' does not exist`);
      const to = req(ctx, 'network-acl-id');
      associateSubnetNacl(ctx.env, subnetId, to);
      return { NewAssociationId: getNacl(ctx.env, to).associations.find((a) => a.subnetId === subnetId)!.networkAclAssociationId };
    },
  },
];

export default service('ec2', '', ops);
