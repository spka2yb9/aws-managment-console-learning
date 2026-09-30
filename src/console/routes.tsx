import type { AppLayoutProps } from '@cloudscape-design/components/app-layout';
import type { ReactNode } from 'react';
import { label } from '../sim/env';
import type { AwsEnv } from '../sim/types';
import { ConsoleHome } from './pages/home';
import { CreateSg, EditSgRules, SgDetail, SgList, sgTitle } from './pages/sg';
import { AttachIgw, CreateIgw, CreateRouteTable, CreateSubnet, CreateVpc, EditRoutes, EditSubnetAssociations, EditSubnetRouteTableAssociation, EditSubnetSettings, IgwDetail, IgwList, RouteTableDetail, RouteTableList, SubnetDetail, SubnetList, VpcDashboard, VpcDetail, VpcList } from './pages/vpc';
import { EC2_ROUTES } from './pages/ec2-routes';
import { S3_IAM_ROUTES } from './pages/s3-iam-routes';
import { CLOUDWATCH_ROUTES } from './pages/cloudwatch-routes';
import { AUDIT_ROUTES } from './pages/audit-routes';
import { CONTAINER_ROUTES } from './pages/containers-routes';
import { EDGE_ROUTES } from './pages/edge-routes';
import { BillingHome } from './pages/billing';
import { ORG_ROUTES } from './pages/org-routes';
import { CreateEndpoint, CreateNat, EndpointList, NatDetail, NatList } from './pages/vpc-nat';
import { CreateNacl, EditNaclRules, EditNaclSubnetAssociations, EditSubnetNaclAssociation, NaclDetail, NaclList } from './pages/nacl';

export type ServiceId = 'console' | 'vpc' | 'ec2' | 'rds' | 's3' | 'iam' | 'cloudwatch' | 'cloudtrail' | 'config' | 'ecs' | 'ecr' | 'sqs' | 'lambda' | 'batch' | 'events' | 'route53' | 'acm' | 'cloudfront' | 'wafv2' | 'billing' | 'organizations' | 'sso';

/** Global in the console (the Region selector shows グローバル). ACM is regional: CloudFront certificates live in us-east-1. */
export const GLOBAL_SERVICES: ServiceId[] = ['iam', 's3', 'route53', 'cloudfront', 'wafv2', 'billing', 'organizations', 'sso'];

export interface Crumb {
  text: string;
  href: string;
}

export interface ConsoleRoute {
  pattern: string;
  service: ServiceId;
  contentType?: AppLayoutProps.ContentType;
  crumbs: (p: Record<string, string>, env: AwsEnv) => Crumb[];
  render: (p: Record<string, string>) => ReactNode;
}

const VPC: Crumb = { text: 'VPC', href: '/vpc/home' };
const NACLS: Crumb = { text: 'ネットワーク ACL', href: '/vpc/network-acls' };
const byId = <T,>(list: T[], pred: (x: T) => boolean) => list.find(pred);

function sgRoutes(svc: 'vpc' | 'ec2'): ConsoleRoute[] {
  const root: Crumb[] = svc === 'vpc' ? [VPC] : [{ text: 'EC2', href: '/ec2/home' }];
  const list = { text: 'セキュリティグループ', href: `/${svc}/security-groups` };
  const sgCrumb = (id: string, env: AwsEnv): Crumb => {
    const g = byId(env.securityGroups, (x) => x.groupId === id);
    return { text: g ? sgTitle(g) : id, href: `/${svc}/security-groups/${id}` };
  };
  return [
    { pattern: `/${svc}/security-groups`, service: svc, contentType: 'table', crumbs: () => [...root, list], render: () => <SgList svc={svc} /> },
    { pattern: `/${svc}/security-groups/create`, service: svc, contentType: 'form', crumbs: () => [...root, list, { text: 'セキュリティグループを作成', href: '' }], render: () => <CreateSg svc={svc} /> },
    { pattern: `/${svc}/security-groups/:id`, service: svc, crumbs: (p, env) => [...root, list, sgCrumb(p.id, env)], render: (p) => <SgDetail svc={svc} id={p.id} key={p.id} /> },
    { pattern: `/${svc}/security-groups/:id/edit-inbound`, service: svc, contentType: 'form', crumbs: (p, env) => [...root, list, sgCrumb(p.id, env), { text: 'インバウンドのルールを編集', href: '' }], render: (p) => <EditSgRules svc={svc} id={p.id} direction="ingress" key={p.id} /> },
    { pattern: `/${svc}/security-groups/:id/edit-outbound`, service: svc, contentType: 'form', crumbs: (p, env) => [...root, list, sgCrumb(p.id, env), { text: 'アウトバウンドのルールを編集', href: '' }], render: (p) => <EditSgRules svc={svc} id={p.id} direction="egress" key={p.id} /> },
  ];
}

const named = {
  vpcs: (env: AwsEnv, id: string) => label(id, env.vpcs.find((x) => x.vpcId === id)),
  subnets: (env: AwsEnv, id: string) => label(id, env.subnets.find((x) => x.subnetId === id)),
  routeTables: (env: AwsEnv, id: string) => label(id, env.routeTables.find((x) => x.routeTableId === id)),
  internetGateways: (env: AwsEnv, id: string) => label(id, env.internetGateways.find((x) => x.internetGatewayId === id)),
  networkAcls: (env: AwsEnv, id: string) => label(id, env.networkAcls.find((x) => x.networkAclId === id)),
};

export const ROUTES: ConsoleRoute[] = [
  { pattern: '/console/home', service: 'console', crumbs: () => [{ text: 'コンソールのホーム', href: '/console/home' }], render: () => <ConsoleHome /> },
  { pattern: '/vpc/home', service: 'vpc', crumbs: () => [VPC, { text: 'VPC ダッシュボード', href: '' }], render: () => <VpcDashboard /> },
  { pattern: '/vpc/vpcs', service: 'vpc', contentType: 'table', crumbs: () => [VPC, { text: 'お使いの VPC', href: '/vpc/vpcs' }], render: () => <VpcList /> },
  { pattern: '/vpc/vpcs/create', service: 'vpc', contentType: 'form', crumbs: () => [VPC, { text: 'お使いの VPC', href: '/vpc/vpcs' }, { text: 'VPC を作成', href: '' }], render: () => <CreateVpc /> },
  { pattern: '/vpc/vpcs/:id', service: 'vpc', crumbs: (p, env) => [VPC, { text: 'お使いの VPC', href: '/vpc/vpcs' }, { text: named.vpcs(env, p.id), href: '' }], render: (p) => <VpcDetail id={p.id} key={p.id} /> },
  { pattern: '/vpc/subnets', service: 'vpc', contentType: 'table', crumbs: () => [VPC, { text: 'サブネット', href: '/vpc/subnets' }], render: () => <SubnetList /> },
  { pattern: '/vpc/subnets/create', service: 'vpc', contentType: 'form', crumbs: () => [VPC, { text: 'サブネット', href: '/vpc/subnets' }, { text: 'サブネットを作成', href: '' }], render: () => <CreateSubnet /> },
  { pattern: '/vpc/subnets/:id', service: 'vpc', crumbs: (p, env) => [VPC, { text: 'サブネット', href: '/vpc/subnets' }, { text: named.subnets(env, p.id), href: '' }], render: (p) => <SubnetDetail id={p.id} key={p.id} /> },
  { pattern: '/vpc/subnets/:id/edit-settings', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, { text: 'サブネット', href: '/vpc/subnets' }, { text: named.subnets(env, p.id), href: `/vpc/subnets/${p.id}` }, { text: 'サブネットの設定を編集', href: '' }], render: (p) => <EditSubnetSettings id={p.id} key={p.id} /> },
  { pattern: '/vpc/subnets/:id/edit-route-table-association', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, { text: 'サブネット', href: '/vpc/subnets' }, { text: named.subnets(env, p.id), href: `/vpc/subnets/${p.id}` }, { text: 'ルートテーブルの関連付けを編集', href: '' }], render: (p) => <EditSubnetRouteTableAssociation id={p.id} key={p.id} /> },
  { pattern: '/vpc/route-tables', service: 'vpc', contentType: 'table', crumbs: () => [VPC, { text: 'ルートテーブル', href: '/vpc/route-tables' }], render: () => <RouteTableList /> },
  { pattern: '/vpc/route-tables/create', service: 'vpc', contentType: 'form', crumbs: () => [VPC, { text: 'ルートテーブル', href: '/vpc/route-tables' }, { text: 'ルートテーブルを作成', href: '' }], render: () => <CreateRouteTable /> },
  { pattern: '/vpc/route-tables/:id', service: 'vpc', crumbs: (p, env) => [VPC, { text: 'ルートテーブル', href: '/vpc/route-tables' }, { text: named.routeTables(env, p.id), href: '' }], render: (p) => <RouteTableDetail id={p.id} key={p.id} /> },
  { pattern: '/vpc/route-tables/:id/edit-routes', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, { text: 'ルートテーブル', href: '/vpc/route-tables' }, { text: named.routeTables(env, p.id), href: `/vpc/route-tables/${p.id}` }, { text: 'ルートを編集', href: '' }], render: (p) => <EditRoutes id={p.id} key={p.id} /> },
  { pattern: '/vpc/route-tables/:id/edit-subnet-associations', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, { text: 'ルートテーブル', href: '/vpc/route-tables' }, { text: named.routeTables(env, p.id), href: `/vpc/route-tables/${p.id}` }, { text: 'サブネットの関連付けを編集', href: '' }], render: (p) => <EditSubnetAssociations id={p.id} key={p.id} /> },
  { pattern: '/vpc/igws', service: 'vpc', contentType: 'table', crumbs: () => [VPC, { text: 'インターネットゲートウェイ', href: '/vpc/igws' }], render: () => <IgwList /> },
  { pattern: '/vpc/igws/create', service: 'vpc', contentType: 'form', crumbs: () => [VPC, { text: 'インターネットゲートウェイ', href: '/vpc/igws' }, { text: 'インターネットゲートウェイの作成', href: '' }], render: () => <CreateIgw /> },
  { pattern: '/vpc/igws/:id', service: 'vpc', crumbs: (p, env) => [VPC, { text: 'インターネットゲートウェイ', href: '/vpc/igws' }, { text: named.internetGateways(env, p.id), href: '' }], render: (p) => <IgwDetail id={p.id} key={p.id} /> },
  { pattern: '/vpc/igws/:id/attach', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, { text: 'インターネットゲートウェイ', href: '/vpc/igws' }, { text: named.internetGateways(env, p.id), href: `/vpc/igws/${p.id}` }, { text: 'VPC にアタッチ', href: '' }], render: (p) => <AttachIgw id={p.id} key={p.id} /> },
  { pattern: '/vpc/nat-gateways', service: 'vpc', contentType: 'table', crumbs: () => [VPC, { text: 'NAT ゲートウェイ', href: '' }], render: () => <NatList /> },
  { pattern: '/vpc/nat-gateways/create', service: 'vpc', contentType: 'form', crumbs: () => [VPC, { text: 'NAT ゲートウェイ', href: '/vpc/nat-gateways' }, { text: 'NAT ゲートウェイを作成', href: '' }], render: () => <CreateNat /> },
  { pattern: '/vpc/nat-gateways/:id', service: 'vpc', crumbs: (p, env) => [VPC, { text: 'NAT ゲートウェイ', href: '/vpc/nat-gateways' }, { text: label(p.id, env.natGateways.find((n) => n.natGatewayId === p.id)), href: '' }], render: (p) => <NatDetail id={p.id} key={p.id} /> },
  { pattern: '/vpc/endpoints', service: 'vpc', contentType: 'table', crumbs: () => [VPC, { text: 'エンドポイント', href: '' }], render: () => <EndpointList /> },
  { pattern: '/vpc/endpoints/create', service: 'vpc', contentType: 'form', crumbs: () => [VPC, { text: 'エンドポイント', href: '/vpc/endpoints' }, { text: 'エンドポイントを作成', href: '' }], render: () => <CreateEndpoint /> },
  { pattern: '/vpc/subnets/:id/edit-network-acl-association', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, { text: 'サブネット', href: '/vpc/subnets' }, { text: named.subnets(env, p.id), href: `/vpc/subnets/${p.id}` }, { text: 'ネットワーク ACL の関連付けを編集', href: '' }], render: (p) => <EditSubnetNaclAssociation id={p.id} key={p.id} /> },
  { pattern: '/vpc/network-acls', service: 'vpc', contentType: 'table', crumbs: () => [VPC, NACLS], render: () => <NaclList /> },
  { pattern: '/vpc/network-acls/create', service: 'vpc', contentType: 'form', crumbs: () => [VPC, NACLS, { text: 'ネットワーク ACL を作成', href: '' }], render: () => <CreateNacl /> },
  { pattern: '/vpc/network-acls/:id', service: 'vpc', crumbs: (p, env) => [VPC, NACLS, { text: named.networkAcls(env, p.id), href: '' }], render: (p) => <NaclDetail id={p.id} key={p.id} /> },
  { pattern: '/vpc/network-acls/:id/edit-inbound', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, NACLS, { text: named.networkAcls(env, p.id), href: `/vpc/network-acls/${p.id}` }, { text: 'インバウンドルールを編集', href: '' }], render: (p) => <EditNaclRules id={p.id} egress={false} key={p.id} /> },
  { pattern: '/vpc/network-acls/:id/edit-outbound', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, NACLS, { text: named.networkAcls(env, p.id), href: `/vpc/network-acls/${p.id}` }, { text: 'アウトバウンドルールを編集', href: '' }], render: (p) => <EditNaclRules id={p.id} egress key={p.id} /> },
  { pattern: '/vpc/network-acls/:id/edit-subnet-associations', service: 'vpc', contentType: 'form', crumbs: (p, env) => [VPC, NACLS, { text: named.networkAcls(env, p.id), href: `/vpc/network-acls/${p.id}` }, { text: 'サブネットの関連付けを編集', href: '' }], render: (p) => <EditNaclSubnetAssociations id={p.id} key={p.id} /> },
  ...sgRoutes('vpc'),
  ...sgRoutes('ec2'),
  // specific EC2 sub-pages first: they share the /ec2/instances/:id prefix
  ...S3_IAM_ROUTES,
  ...CLOUDWATCH_ROUTES,
  ...AUDIT_ROUTES,
  ...CONTAINER_ROUTES,
  ...EDGE_ROUTES,
  ...ORG_ROUTES,
  { pattern: '/billing/home', service: 'billing', crumbs: () => [{ text: '請求とコスト管理', href: '/billing/home' }, { text: 'ホーム', href: '' }], render: () => <BillingHome /> },
  ...EC2_ROUTES,
];

export function matchRoute(path: string): { route: ConsoleRoute; params: Record<string, string> } | null {
  const parts = path.split('?')[0].split('/');
  for (const route of ROUTES) {
    const pp = route.pattern.split('/');
    if (pp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    if (pp.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(parts[i])), true) : seg === parts[i]))) return { route, params };
  }
  return null;
}
