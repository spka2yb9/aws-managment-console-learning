import Alert from '@cloudscape-design/components/alert';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Tiles from '@cloudscape-design/components/tiles';
import TokenGroup from '@cloudscape-design/components/token-group';
import { useState, type ReactNode } from 'react';
import { cidrSize, isValidCidr, RESERVED_IPS_PER_SUBNET } from '../../sim/cidr';
import { label, nameOf, regionOf } from '../../sim/env';
import type { AwsEnv, AwsError, RouteTable, Subnet } from '../../sim/types';
import { attachInternetGateway, availableIpCount, createInternetGateway, createRouteTable, createSubnet, createVpc, deleteSubnet, deleteVpc, detachInternetGateway, subnetDependencies, vpcDependencies, effectiveRouteTable, isExplicitlyAssociated, mainRouteTable, associateSubnetRouteTable, modifySubnetAttribute, replaceRoutes, routeState, routeTarget, setSubnetAssociations } from '../../sim/vpc';
import { subnetNacl } from '../../sim/nacl';
import { pick, rtOption, vpcOption } from '../options';
import { SubnetNaclTab } from './nacl';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, DeleteModal, EditForm, NotFound, ResourceDetail, ResourceStatus, ResourceTable, ResourceTabs, nameCell, useEnv, useNavigate, useSelection, type Column } from '../ui';

const arn = (env: AwsEnv, type: string, id: string) => `arn:aws:ec2:${env.region}:${env.accountId}:${type}/${id}`;

export function Tags({ tags }: { tags: { key: string; value: string }[] }) {
  return (
    <Table
      variant="container"
      header={<Header counter={`(${tags.length})`}>タグ</Header>}
      columnDefinitions={[{ id: 'k', header: 'キー', cell: (t) => t.key }, { id: 'v', header: '値', cell: (t) => t.value }]}
      items={tags}
      empty={<Box textAlign="center" color="inherit">タグがありません</Box>}
    />
  );
}

// ---------------- dashboard ----------------

export function VpcDashboard() {
  const env = useEnv();
  const region = useConsole((s) => s.region);
  const navigate = useNavigate();
  const count = (n: number, text: string, to: string) => (
    <div>
      <Box variant="awsui-key-label">{text}</Box>
      <ConsoleLink to={to}><Box variant="awsui-value-large" tagOverride="span">{n}</Box></ConsoleLink>
    </div>
  );
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<Button variant="primary" onClick={() => navigate('/vpc/vpcs/create')}>VPC を作成</Button>}>VPC ダッシュボード</Header>
      <Container header={<Header variant="h2" description={regionOf(region).name}>リージョン別のリソース</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          {count(env.vpcs.length, 'VPC', '/vpc/vpcs')}
          {count(env.subnets.length, 'サブネット', '/vpc/subnets')}
          {count(env.routeTables.length, 'ルートテーブル', '/vpc/route-tables')}
          {count(env.internetGateways.length, 'インターネットゲートウェイ', '/vpc/igws')}
          {count(env.networkAcls.length, 'ネットワーク ACL', '/vpc/network-acls')}
          {count(env.securityGroups.length, 'セキュリティグループ', '/vpc/security-groups')}
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}

// ---------------- VPCs ----------------

export function VpcList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.vpcs, (v) => v.vpcId);
  const columns: Column<(typeof env.vpcs)[number]>[] = [
    { id: 'name', header: 'Name', cell: nameCell, value: nameOf },
    { id: 'vpcId', header: 'VPC ID', cell: (v) => <ConsoleLink to={`/vpc/vpcs/${v.vpcId}`}>{v.vpcId}</ConsoleLink>, value: (v) => v.vpcId },
    { id: 'state', header: '状態', cell: (v) => <ResourceStatus state={v.state} />, value: (v) => v.state },
    { id: 'cidr', header: 'IPv4 CIDR', cell: (v) => v.cidrBlock, value: (v) => v.cidrBlock },
    { id: 'dhcp', header: 'DHCP オプションセット', cell: (v) => v.dhcpOptionsId, value: (v) => v.dhcpOptionsId },
    { id: 'mainRt', header: 'メインルートテーブル', cell: (v) => { const rt = mainRouteTable(env, v.vpcId); return <ConsoleLink to={`/vpc/route-tables/${rt.routeTableId}`}>{label(rt.routeTableId, rt)}</ConsoleLink>; } },
    { id: 'acl', header: 'メインネットワーク ACL', cell: (v) => <ConsoleLink to={`/vpc/network-acls/${v.defaultNetworkAclId}`}>{v.defaultNetworkAclId}</ConsoleLink> },
    { id: 'tenancy', header: 'テナンシー', cell: () => 'デフォルト' },
    { id: 'default', header: 'デフォルト VPC', cell: (v) => (v.isDefault ? 'はい' : 'いいえ'), value: (v) => (v.isDefault ? 'はい' : 'いいえ') },
    { id: 'owner', header: '所有者 ID', cell: () => env.accountId },
  ];
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <>
      <ResourceTable
        title="お使いの VPC"
        resourceName="VPC "
        items={env.vpcs}
        trackBy={(v) => v.vpcId}
        columns={columns}
        selectedItems={sel}
        onSelectionChange={setSel}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <ActionMenu
              testId="vpc-actions"
              items={[
                { id: 'details', text: '詳細を表示', disabled: sel.length !== 1, onClick: () => navigate(`/vpc/vpcs/${sel[0].vpcId}`) },
                { id: 'delete', text: 'VPC の削除', disabled: sel.length !== 1, onClick: () => setDeleting(sel[0].vpcId) },
              ]}
            />
            <Button variant="primary" onClick={() => navigate('/vpc/vpcs/create')}>VPC を作成</Button>
          </SpaceBetween>
        }
      />
      {deleting && <DeleteVpcModal vpcId={deleting} onClose={() => { setDeleting(null); setSel([]); }} />}
    </>
  );
}

function DeleteVpcModal({ vpcId, onClose }: { vpcId: string; onClose: () => void }) {
  const env = useEnv();
  const run = useConsole((s) => s.run);
  const vpc = env.vpcs.find((v) => v.vpcId === vpcId);
  const deps = vpcDependencies(env, vpcId);
  const count = (n: number, what: string) => (n ? [`${what} ${n} 個`] : []);
  const cascade = [
    ...count(env.subnets.filter((x) => x.vpcId === vpcId).length, 'サブネット'),
    ...count(env.routeTables.filter((x) => x.vpcId === vpcId).length, 'ルートテーブル'),
    ...count(env.networkAcls.filter((x) => x.vpcId === vpcId).length, 'ネットワーク ACL'),
    ...count(env.securityGroups.filter((x) => x.vpcId === vpcId).length, 'セキュリティグループ'),
    ...count(env.internetGateways.filter((g) => g.attachments.some((a) => a.vpcId === vpcId)).length, 'インターネットゲートウェイ'),
    ...count(env.vpcEndpoints.filter((x) => x.vpcId === vpcId).length, 'VPC エンドポイント'),
  ];
  return (
    <DeleteModal header="VPC の削除" testId="delete-vpc" onClose={onClose} onDelete={() => run((d) => deleteVpc(d, vpcId), `VPC ${vpcId} を削除しました`)}>
      <Box>{label(vpcId, vpc)} を削除しますか? 次の関連リソースも一緒に削除されます: {cascade.join('、') || 'なし'}</Box>
      {deps.length > 0 && (
        <Alert type="warning" header="先に削除が必要なリソースがあります">
          {deps.join('、')}
        </Alert>
      )}
    </DeleteModal>
  );
}

/** VPC "Resource map": subnets -> route tables -> network connections, the same mental model as the real tab. */
function ResourceMap({ vpcId }: { vpcId: string }) {
  const env = useEnv();
  const subnets = env.subnets.filter((s) => s.vpcId === vpcId);
  const rts = env.routeTables.filter((r) => r.vpcId === vpcId);
  const igws = env.internetGateways.filter((g) => g.attachments.some((a) => a.vpcId === vpcId));
  const col = (title: string, items: { key: string; to: string; text: string; sub: string }[]) => (
    <SpaceBetween size="xs">
      <Box variant="h3">{title} ({items.length})</Box>
      {items.map((i) => (
        <div key={i.key} className="resource-map-item">
          <ConsoleLink to={i.to}>{i.text}</ConsoleLink>
          <Box variant="small" display="block" color="text-body-secondary">{i.sub}</Box>
        </div>
      ))}
    </SpaceBetween>
  );
  return (
    <Container header={<Header variant="h2" description="サブネットがどのルートテーブルを使い、ルートがどこへ向かうかを表示します。">リソースマップ</Header>}>
      <ColumnLayout columns={3} borders="vertical">
        {col('サブネット', subnets.map((s) => ({ key: s.subnetId, to: `/vpc/subnets/${s.subnetId}`, text: nameOf(s) || s.subnetId, sub: `${s.availabilityZone} · ${s.cidrBlock} → ${nameOf(effectiveRouteTable(env, s.subnetId)) || effectiveRouteTable(env, s.subnetId).routeTableId}` })))}
        {col('ルートテーブル', rts.map((r) => ({ key: r.routeTableId, to: `/vpc/route-tables/${r.routeTableId}`, text: nameOf(r) || r.routeTableId, sub: r.routes.map((x) => `${x.destinationPrefixListId ?? x.destinationCidrBlock} → ${routeTarget(x)}`).join(', ') + (r.associations.some((a) => a.main) ? ' (メイン)' : '') })))}
        {col('ネットワーク接続', igws.map((g) => ({ key: g.internetGatewayId, to: `/vpc/igws/${g.internetGatewayId}`, text: nameOf(g) || g.internetGatewayId, sub: 'インターネットゲートウェイ' })))}
      </ColumnLayout>
    </Container>
  );
}

export function VpcDetail({ id }: { id: string }) {
  const env = useEnv();
  const vpc = env.vpcs.find((v) => v.vpcId === id);
  if (!vpc) return <NotFound what="VPC" id={id} />;
  const rt = mainRouteTable(env, vpc.vpcId);
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{label(vpc.vpcId, vpc)}</Header>
      <ResourceDetail
        fields={[
          { label: 'VPC ID', value: <CopyableValue value={vpc.vpcId} /> },
          { label: '状態', value: <ResourceStatus state={vpc.state} /> },
          { label: 'DNS ホスト名', value: vpc.enableDnsHostnames ? '有効' : '無効' },
          { label: 'DNS 解決', value: vpc.enableDnsSupport ? '有効' : '無効' },
          { label: 'テナンシー', value: 'デフォルト' },
          { label: 'DHCP オプションセット', value: vpc.dhcpOptionsId },
          { label: 'メインルートテーブル', value: <ConsoleLink to={`/vpc/route-tables/${rt.routeTableId}`}>{label(rt.routeTableId, rt)}</ConsoleLink> },
          { label: 'メインネットワーク ACL', value: <ConsoleLink to={`/vpc/network-acls/${vpc.defaultNetworkAclId}`}>{vpc.defaultNetworkAclId}</ConsoleLink> },
          { label: 'デフォルト VPC', value: vpc.isDefault ? 'はい' : 'いいえ' },
          { label: 'IPv4 CIDR', value: vpc.cidrBlock },
          { label: 'IPv6 プール', value: '-' },
          { label: '所有者 ID', value: env.accountId },
        ]}
      />
      <ResourceTabs
        tabs={[
          { id: 'resource-map', label: 'リソースマップ', content: <ResourceMap vpcId={vpc.vpcId} /> },
          {
            id: 'cidrs',
            label: 'CIDR',
            content: <Table variant="container" header={<Header>IPv4 CIDR</Header>} items={[vpc]} columnDefinitions={[{ id: 'c', header: 'アドレス', cell: (v) => v.cidrBlock }, { id: 's', header: 'ステータス', cell: () => <ResourceStatus state="associated" /> }]} />,
          },
          { id: 'tags', label: 'タグ', content: <Tags tags={vpc.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

export function CreateVpc() {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [cidr, setCidr] = useState('10.0.0.0/16');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="VPC を作成"
      description="VPC は、Amazon EC2 インスタンスなどの AWS オブジェクトが配置された、AWS クラウドの独立した部分です。"
      submitText="VPC を作成"
      submitTestId="create-vpc-submit"
      onCancel={() => navigate('/vpc/vpcs')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createVpc(d, { cidrBlock: cidr.trim(), name: name.trim() }), (id) => `${id}${name ? ` / ${name}` : ''} が正常に作成されました`);
        if (r.ok) navigate(`/vpc/vpcs/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">VPC の設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="作成するリソース" description="VPC リソースのみ、または VPC とその他のネットワークリソースを作成します。">
            <Tiles
              value="vpc-only"
              items={[
                { value: 'vpc-only', label: 'VPC のみ' },
                { value: 'vpc-more', label: 'VPC など', disabled: true, description: 'このシミュレーターでは未提供' },
              ]}
            />
          </FormField>
          <FormField label="名前タグ - オプション" description="'Name' のキーと指定した値を持つタグを作成します。">
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="my-vpc-01" data-testid="vpc-name" />
          </FormField>
          <FormField label="IPv4 CIDR ブロック">
            <RadioGroup value="manual" items={[{ value: 'manual', label: 'IPv4 CIDR の手動入力' }, { value: 'ipam', label: 'IPAM 割り当ての IPv4 CIDR ブロック', disabled: true }]} />
          </FormField>
          <FormField label="IPv4 CIDR" constraintText="CIDR ブロックのサイズは /16 から /28 の間である必要があります。">
            <Input value={cidr} onChange={(e) => setCidr(e.detail.value)} data-testid="vpc-cidr" />
          </FormField>
          <FormField label="IPv6 CIDR ブロック">
            <RadioGroup value="none" items={[{ value: 'none', label: 'IPv6 CIDR ブロックなし' }]} />
          </FormField>
          <FormField label="テナンシー">
            <Select selectedOption={{ value: 'default', label: 'デフォルト' }} options={[{ value: 'default', label: 'デフォルト' }]} />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- Subnets ----------------

export function SubnetList() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [sel, setSel] = useSelection(env.subnets, (s) => s.subnetId);
  const columns: Column<Subnet>[] = [
    { id: 'name', header: 'Name', cell: nameCell, value: nameOf },
    { id: 'subnetId', header: 'サブネット ID', cell: (s) => <ConsoleLink to={`/vpc/subnets/${s.subnetId}`}>{s.subnetId}</ConsoleLink>, value: (s) => s.subnetId },
    { id: 'state', header: '状態', cell: (s) => <ResourceStatus state={s.state} />, value: (s) => s.state },
    { id: 'vpc', header: 'VPC', cell: (s) => <ConsoleLink to={`/vpc/vpcs/${s.vpcId}`}>{label(s.vpcId, env.vpcs.find((v) => v.vpcId === s.vpcId))}</ConsoleLink>, value: (s) => label(s.vpcId, env.vpcs.find((v) => v.vpcId === s.vpcId)) },
    { id: 'cidr', header: 'IPv4 CIDR', cell: (s) => s.cidrBlock, value: (s) => s.cidrBlock },
    { id: 'ips', header: '使用可能な IPv4 アドレス', cell: (s) => availableIpCount(env, s), value: (s) => availableIpCount(env, s) },
    { id: 'az', header: 'アベイラビリティーゾーン', cell: (s) => s.availabilityZone, value: (s) => s.availabilityZone },
    { id: 'rt', header: 'ルートテーブル', cell: (s) => { const rt = effectiveRouteTable(env, s.subnetId); return <ConsoleLink to={`/vpc/route-tables/${rt.routeTableId}`}>{label(rt.routeTableId, rt)}</ConsoleLink>; }, value: (s) => label(effectiveRouteTable(env, s.subnetId).routeTableId, effectiveRouteTable(env, s.subnetId)) },
    { id: 'acl', header: 'ネットワーク ACL', cell: (s) => <ConsoleLink to={`/vpc/network-acls/${subnetNacl(env, s.subnetId).networkAclId}`}>{subnetNacl(env, s.subnetId).networkAclId}</ConsoleLink>, value: (s) => subnetNacl(env, s.subnetId).networkAclId },
    { id: 'default', header: 'デフォルトのサブネット', cell: (s) => (env.vpcs.find((v) => v.vpcId === s.vpcId)?.isDefault ? 'はい' : 'いいえ') },
    { id: 'autoip', header: 'パブリック IPv4 アドレスを自動割り当て', cell: (s) => (s.mapPublicIpOnLaunch ? 'はい' : 'いいえ'), value: (s) => (s.mapPublicIpOnLaunch ? 'はい' : 'いいえ') },
  ];
  const [deleting, setDeleting] = useState<string | null>(null);
  return (
    <>
      <ResourceTable
        title="サブネット"
        resourceName="サブネット"
        items={env.subnets}
        trackBy={(s) => s.subnetId}
        columns={columns}
        selectedItems={sel}
        onSelectionChange={setSel}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <ActionMenu
              items={[
                { id: 'settings', text: 'サブネットの設定を編集', disabled: sel.length !== 1, onClick: () => navigate(`/vpc/subnets/${sel[0].subnetId}/edit-settings`) },
                { id: 'rt', text: 'ルートテーブルの関連付けを編集', disabled: sel.length !== 1, onClick: () => navigate(`/vpc/subnets/${sel[0].subnetId}/edit-route-table-association`) },
                { id: 'acl', text: 'ネットワーク ACL の関連付けを編集', disabled: sel.length !== 1, onClick: () => navigate(`/vpc/subnets/${sel[0].subnetId}/edit-network-acl-association`) },
                { id: 'delete', text: 'サブネットの削除', disabled: sel.length !== 1, onClick: () => setDeleting(sel[0].subnetId) },
              ]}
              testId="subnet-actions"
            />
            <Button variant="primary" onClick={() => navigate('/vpc/subnets/create')}>サブネットを作成</Button>
          </SpaceBetween>
        }
      />
      {deleting && (
        <DeleteModal header="サブネットの削除" testId="delete-subnet" onClose={() => { setDeleting(null); setSel([]); }} onDelete={() => run((d) => deleteSubnet(d, deleting), `サブネット ${deleting} を削除しました`)}>
          <Box>{label(deleting, env.subnets.find((x) => x.subnetId === deleting))} を削除しますか?</Box>
          {subnetDependencies(env, deleting).length > 0 && <Alert type="warning" header="このサブネットを使っているリソースがあります">{subnetDependencies(env, deleting).join('、')}</Alert>}
        </DeleteModal>
      )}
    </>
  );
}

function RoutesTable({ rt, title, actions }: { rt: RouteTable; title?: string; actions?: ReactNode }) {
  const env = useEnv();
  return (
    <Table
      variant="container"
      data-testid="routes-table"
      header={<Header counter={`(${rt.routes.length})`} actions={actions}>{title ?? 'ルート'}</Header>}
      items={rt.routes}
      trackBy={(r) => r.destinationPrefixListId ?? r.destinationCidrBlock}
      columnDefinitions={[
        { id: 'dest', header: '送信先', cell: (r) => r.destinationPrefixListId ?? r.destinationCidrBlock },
        { id: 'target', header: 'ターゲット', cell: (r) => (r.gatewayId === 'local' ? 'local' : <ConsoleLink to={r.natGatewayId ? `/vpc/nat-gateways/${r.natGatewayId}` : r.gatewayId?.startsWith('vpce-') ? '/vpc/endpoints' : `/vpc/igws/${r.gatewayId}`}>{routeTarget(r)}</ConsoleLink>) },
        { id: 'status', header: 'ステータス', cell: (r) => <ResourceStatus state={routeState(env, rt, r)} /> },
        { id: 'prop', header: '伝播済み', cell: () => 'いいえ' },
        { id: 'origin', header: 'ルートの発生元', cell: (r) => (r.origin === 'CreateRouteTable' ? 'ルートテーブルの作成' : 'ルートの作成') },
      ]}
    />
  );
}

export function SubnetDetail({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const s = env.subnets.find((x) => x.subnetId === id);
  if (!s) return <NotFound what="サブネット" id={id} />;
  const rt = effectiveRouteTable(env, s.subnetId);
  const vpc = env.vpcs.find((v) => v.vpcId === s.vpcId)!;
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={<ActionMenu items={[{ id: 'settings', text: 'サブネットの設定を編集', onClick: () => navigate(`/vpc/subnets/${id}/edit-settings`) }, { id: 'rt', text: 'ルートテーブルの関連付けを編集', onClick: () => navigate(`/vpc/subnets/${id}/edit-route-table-association`) }, { id: 'acl', text: 'ネットワーク ACL の関連付けを編集', onClick: () => navigate(`/vpc/subnets/${id}/edit-network-acl-association`) }]} />}
      >
        {label(s.subnetId, s)}
      </Header>
      <ResourceDetail
        fields={[
          { label: 'サブネット ID', value: <CopyableValue value={s.subnetId} /> },
          { label: 'サブネット ARN', value: <CopyableValue value={arn(env, 'subnet', s.subnetId)} /> },
          { label: '状態', value: <ResourceStatus state={s.state} /> },
          { label: 'IPv4 CIDR', value: s.cidrBlock },
          { label: '使用可能な IPv4 アドレス', value: String(availableIpCount(env, s)) },
          { label: 'アベイラビリティーゾーン', value: s.availabilityZone },
          { label: 'VPC', value: <ConsoleLink to={`/vpc/vpcs/${s.vpcId}`}>{label(s.vpcId, vpc)}</ConsoleLink> },
          { label: 'ルートテーブル', value: <ConsoleLink to={`/vpc/route-tables/${rt.routeTableId}`}>{label(rt.routeTableId, rt)}</ConsoleLink> },
          { label: 'ネットワーク ACL', value: <ConsoleLink to={`/vpc/network-acls/${subnetNacl(env, s.subnetId).networkAclId}`}>{label(subnetNacl(env, s.subnetId).networkAclId, subnetNacl(env, s.subnetId))}</ConsoleLink> },
          { label: 'デフォルトのサブネット', value: vpc.isDefault ? 'はい' : 'いいえ' },
          { label: 'パブリック IPv4 アドレスを自動割り当て', value: s.mapPublicIpOnLaunch ? 'はい' : 'いいえ' },
          { label: '所有者', value: env.accountId },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'route-table',
            label: 'ルートテーブル',
            content: (
              <SpaceBetween size="m">
                <Container header={<Header variant="h2" actions={<Button onClick={() => navigate(`/vpc/subnets/${id}/edit-route-table-association`)}>ルートテーブルの関連付けを編集</Button>}>ルートテーブル: {label(rt.routeTableId, rt)}</Header>}>
                  <Box color="text-body-secondary">{isExplicitlyAssociated(env, s.subnetId) ? '明示的に関連付けられています' : '明示的な関連付けはありません: VPC のメインルートテーブルを使用しています'}</Box>
                </Container>
                <RoutesTable rt={rt} />
              </SpaceBetween>
            ),
          },
          { id: 'network-acl', label: 'ネットワーク ACL', content: <SubnetNaclTab subnetId={s.subnetId} /> },
          { id: 'tags', label: 'タグ', content: <Tags tags={s.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

export function CreateSubnet() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const vpcOptions = env.vpcs.map(vpcOption);
  const [vpcId, setVpcId] = useState<string>();
  const [name, setName] = useState('');
  const [az, setAz] = useState('');
  const [cidr, setCidr] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const vpc = env.vpcs.find((v) => v.vpcId === vpcId);
  const azOptions = [{ value: '', label: '設定なし' }, ...regionOf(env.region).azs.map((z) => ({ value: z, label: `${regionOf(env.region).name} / ${z}` }))];
  return (
    <EditForm
      title="サブネットを作成"
      submitText="サブネットを作成"
      submitTestId="create-subnet-submit"
      onCancel={() => navigate('/vpc/subnets')}
      error={error}
      onSubmit={() => {
        if (!vpc) return;
        const zone = az || regionOf(env.region).azs[env.subnets.length % regionOf(env.region).azs.length];
        const r = run((d) => createSubnet(d, { vpcId: vpc.vpcId, cidrBlock: cidr.trim(), availabilityZone: zone, name: name.trim() }), (id) => `1 個のサブネットが正常に作成されました: ${id}`);
        if (r.ok) navigate(`/vpc/subnets/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">VPC</Header>}>
        <FormField label="VPC ID" description="この VPC にサブネットを作成します。">
          <Select selectedOption={pick(vpcOptions, vpcId)} options={vpcOptions} onChange={(e) => setVpcId(e.detail.selectedOption.value)} placeholder="VPC を選択" data-testid="subnet-vpc" />
        </FormField>
      </Container>
      {vpc && (
        <Container header={<Header variant="h2">サブネットの設定</Header>}>
          <SpaceBetween size="l">
            <FormField label="サブネット名" description="'Name' のキーと指定した値を持つタグを作成します。">
              <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="my-subnet-01" data-testid="subnet-name" />
            </FormField>
            <FormField label="アベイラビリティーゾーン" description="サブネットを配置するゾーンを選択するか、Amazon に選択させます。">
              <Select selectedOption={pick(azOptions, az)} options={azOptions} onChange={(e) => setAz(e.detail.selectedOption.value!)} data-testid="subnet-az" />
            </FormField>
            <FormField label="IPv4 VPC CIDR ブロック">
              <Select selectedOption={{ value: vpc.cidrBlock, label: vpc.cidrBlock }} options={[{ value: vpc.cidrBlock, label: vpc.cidrBlock }]} />
            </FormField>
            <FormField label="IPv4 サブネット CIDR ブロック" constraintText={isValidCidr(cidr.trim()) ? `${cidrSize(cidr.trim())} IP (AWS はサブネットごとに ${RESERVED_IPS_PER_SUBNET} 個を予約)` : 'CIDR ブロックのサイズは /16 から /28 の間である必要があります。'}>
              <Input value={cidr} onChange={(e) => setCidr(e.detail.value)} placeholder={vpc.cidrBlock.replace(/\/\d+$/, '/24')} data-testid="subnet-cidr" />
            </FormField>
          </SpaceBetween>
        </Container>
      )}
    </EditForm>
  );
}

export function EditSubnetSettings({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const s = env.subnets.find((x) => x.subnetId === id);
  const [auto, setAuto] = useState(!!s?.mapPublicIpOnLaunch);
  if (!s) return <NotFound what="サブネット" id={id} />;
  return (
    <EditForm
      title="サブネットの設定を編集"
      submitText="保存"
      onCancel={() => navigate(`/vpc/subnets/${id}`)}
      error={null}
      onSubmit={() => {
        run((d) => modifySubnetAttribute(d, id, { mapPublicIpOnLaunch: auto }), `サブネットの設定が正常に変更されました: ${id}`);
        navigate(`/vpc/subnets/${id}`);
      }}
    >
      <Container header={<Header variant="h2">自動割り当て IP 設定</Header>}>
        <Checkbox checked={auto} onChange={(e) => setAuto(e.detail.checked)} description="このサブネットで起動する新しいインスタンスに、パブリック IPv4 アドレスを自動で割り当てます。">
          パブリック IPv4 アドレスの自動割り当てを有効化
        </Checkbox>
      </Container>
    </EditForm>
  );
}

export function EditSubnetRouteTableAssociation({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const s = env.subnets.find((x) => x.subnetId === id);
  const [rtId, setRtId] = useState(s ? effectiveRouteTable(env, s.subnetId).routeTableId : '');
  if (!s) return <NotFound what="サブネット" id={id} />;
  const options = env.routeTables.filter((r) => r.vpcId === s.vpcId).map(rtOption);
  const rt = env.routeTables.find((r) => r.routeTableId === rtId);
  return (
    <EditForm
      title="ルートテーブルの関連付けを編集"
      submitText="保存"
      submitTestId="save-subnet-rt"
      onCancel={() => navigate(`/vpc/subnets/${id}`)}
      error={null}
      onSubmit={() => {
        run((d) => associateSubnetRouteTable(d, id, rtId), `サブネット ${id} のルートテーブルの関連付けが正常に更新されました`);
        navigate(`/vpc/subnets/${id}?tab=route-table`);
      }}
    >
      <Container header={<Header variant="h2">サブネットのルートテーブル設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="サブネット ID">{label(s.subnetId, s)}</FormField>
          <FormField label="ルートテーブル ID">
            <Select selectedOption={pick(options, rtId)} options={options} onChange={(e) => setRtId(e.detail.selectedOption.value!)} data-testid="subnet-rt-select" />
          </FormField>
        </SpaceBetween>
      </Container>
      {rt && <RoutesTable rt={rt} />}
    </EditForm>
  );
}

// ---------------- Route tables ----------------

export function RouteTableList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.routeTables, (r) => r.routeTableId);
  const explicit = (r: RouteTable) => r.associations.filter((a) => a.subnetId).map((a) => a.subnetId!);
  const columns: Column<RouteTable>[] = [
    { id: 'name', header: 'Name', cell: nameCell, value: nameOf },
    { id: 'id', header: 'ルートテーブル ID', cell: (r) => <ConsoleLink to={`/vpc/route-tables/${r.routeTableId}`}>{r.routeTableId}</ConsoleLink>, value: (r) => r.routeTableId },
    { id: 'explicit', header: '明示的なサブネットの関連付け', cell: (r) => explicit(r).map((s) => label(s, env.subnets.find((x) => x.subnetId === s))).join(', ') || '-', value: (r) => explicit(r).join(' ') },
    { id: 'edge', header: 'エッジの関連付け', cell: () => '-' },
    { id: 'main', header: 'メイン', cell: (r) => (r.associations.some((a) => a.main) ? 'はい' : 'いいえ'), value: (r) => (r.associations.some((a) => a.main) ? 'はい' : 'いいえ') },
    { id: 'vpc', header: 'VPC', cell: (r) => <ConsoleLink to={`/vpc/vpcs/${r.vpcId}`}>{label(r.vpcId, env.vpcs.find((v) => v.vpcId === r.vpcId))}</ConsoleLink>, value: (r) => label(r.vpcId, env.vpcs.find((v) => v.vpcId === r.vpcId)) },
    { id: 'owner', header: '所有者 ID', cell: () => env.accountId },
  ];
  return (
    <ResourceTable
      title="ルートテーブル"
      resourceName="ルートテーブル"
      items={env.routeTables}
      trackBy={(r) => r.routeTableId}
      columns={columns}
      selectedItems={sel}
      onSelectionChange={setSel}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu
            items={[
              { id: 'routes', text: 'ルートを編集', disabled: sel.length !== 1, onClick: () => navigate(`/vpc/route-tables/${sel[0].routeTableId}/edit-routes`) },
              { id: 'assoc', text: 'サブネットの関連付けを編集', disabled: sel.length !== 1, onClick: () => navigate(`/vpc/route-tables/${sel[0].routeTableId}/edit-subnet-associations`) },
            ]}
          />
          <Button variant="primary" onClick={() => navigate('/vpc/route-tables/create')}>ルートテーブルを作成</Button>
        </SpaceBetween>
      }
    />
  );
}

export function RouteTableDetail({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const rt = env.routeTables.find((r) => r.routeTableId === id);
  if (!rt) return <NotFound what="ルートテーブル" id={id} />;
  const isMain = rt.associations.some((a) => a.main);
  const explicit = env.subnets.filter((s) => rt.associations.some((a) => a.subnetId === s.subnetId));
  const implicit = isMain ? env.subnets.filter((s) => s.vpcId === rt.vpcId && !isExplicitlyAssociated(env, s.subnetId)) : [];
  const subnetTable = (title: string, items: Subnet[], actions?: ReactNode, testId?: string) => (
    <div data-testid={testId}>
      <Table<Subnet>
        variant="container"
        header={<Header counter={`(${items.length})`} actions={actions}>{title}</Header>}
        items={items}
        empty={<Box textAlign="center" color="inherit">サブネットの関連付けはありません</Box>}
        columnDefinitions={[
          { id: 'n', header: 'Name', cell: nameCell },
          { id: 'id', header: 'サブネット ID', cell: (s) => <ConsoleLink to={`/vpc/subnets/${s.subnetId}`}>{s.subnetId}</ConsoleLink> },
          { id: 'c', header: 'IPv4 CIDR', cell: (s) => s.cidrBlock },
        ]}
      />
    </div>
  );
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <ActionMenu
            items={[
              { id: 'routes', text: 'ルートを編集', onClick: () => navigate(`/vpc/route-tables/${id}/edit-routes`) },
              { id: 'assoc', text: 'サブネットの関連付けを編集', onClick: () => navigate(`/vpc/route-tables/${id}/edit-subnet-associations`) },
            ]}
          />
        }
      >
        {label(rt.routeTableId, rt)}
      </Header>
      <ResourceDetail
        fields={[
          { label: 'ルートテーブル ID', value: <CopyableValue value={rt.routeTableId} /> },
          { label: 'メイン', value: isMain ? 'はい' : 'いいえ' },
          { label: '明示的なサブネットの関連付け', value: explicit.map((s) => label(s.subnetId, s)).join(', ') || '-' },
          { label: 'エッジの関連付け', value: '-' },
          { label: 'VPC', value: <ConsoleLink to={`/vpc/vpcs/${rt.vpcId}`}>{label(rt.vpcId, env.vpcs.find((v) => v.vpcId === rt.vpcId))}</ConsoleLink> },
          { label: '所有者 ID', value: env.accountId },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'routes',
            label: 'ルート',
            content: (
              <RoutesTable
                rt={rt}
                actions={
                  <Hotspot hotspotId="rt-edit-routes" direction="right">
                    <Button onClick={() => navigate(`/vpc/route-tables/${id}/edit-routes`)} data-testid="edit-routes">ルートを編集</Button>
                  </Hotspot>
                }
              />
            ),
          },
          {
            id: 'subnet-associations',
            label: 'サブネットの関連付け',
            content: (
              <SpaceBetween size="m">
                {subnetTable(
                  '明示的なサブネットの関連付け',
                  explicit,
                  <Hotspot hotspotId="rt-edit-associations" direction="right">
                    <Button onClick={() => navigate(`/vpc/route-tables/${id}/edit-subnet-associations`)} data-testid="edit-subnet-associations">サブネットの関連付けを編集</Button>
                  </Hotspot>,
                  'explicit-associations',
                )}
                {isMain && subnetTable('明示的な関連付けのないサブネット', implicit, undefined, 'implicit-associations')}
              </SpaceBetween>
            ),
          },
          { id: 'tags', label: 'タグ', content: <Tags tags={rt.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

const TARGET_TYPES = [
  { value: 'igw', label: 'インターネットゲートウェイ' },
  { value: 'nat', label: 'NAT ゲートウェイ' },
  { value: 'instance', label: 'インスタンス', disabled: true, description: 'このシミュレーターでは未提供' },
  { value: 'pcx', label: 'ピアリング接続', disabled: true, description: 'このシミュレーターでは未提供' },
  { value: 'tgw', label: 'Transit Gateway', disabled: true, description: 'このシミュレーターでは未提供' },
];

export function EditRoutes({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const rt = env.routeTables.find((r) => r.routeTableId === id);
  const [rows, setRows] = useState(() => (rt?.routes ?? []).filter((r) => r.gatewayId !== 'local' && !r.destinationPrefixListId).map((r) => ({ dest: r.destinationCidrBlock, target: routeTarget(r), type: r.natGatewayId ? 'nat' : 'igw' })));
  const [error, setError] = useState<AwsError | null>(null);
  if (!rt) return <NotFound what="ルートテーブル" id={id} />;
  const local = rt.routes.find((r) => r.gatewayId === 'local')!;
  const igws = env.internetGateways;
  const nats = env.natGateways.filter((n) => n.vpcId === rt.vpcId && n.state !== 'deleted' && n.state !== 'deleting');
  const set = (i: number, patch: Partial<(typeof rows)[number]>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  return (
    <EditForm
      title="ルートを編集"
      submitText="変更を保存"
      submitTestId="save-routes"
      submitHotspotId="rt-save-routes"
      onCancel={() => navigate(`/vpc/route-tables/${id}?tab=routes`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => replaceRoutes(d, id, rows.map((x) => ({ destinationCidrBlock: x.dest, gatewayId: x.target.trim() }))), `${label(id, rt)} のルートが正常に更新されました`);
        if (r.ok) navigate(`/vpc/route-tables/${id}?tab=routes`);
        else setError(r.error);
      }}
    >
      <Container>
        <div className="route-editor" data-testid="route-editor">
          <div className="route-editor-row route-editor-head">
            <Box variant="awsui-key-label">送信先</Box>
            <Box variant="awsui-key-label">ターゲット</Box>
            <Box variant="awsui-key-label">ステータス</Box>
            <Box variant="awsui-key-label">伝播済み</Box>
            <span />
          </div>
          <div className="route-editor-row">
            <Input value={local.destinationCidrBlock} disabled />
            <SpaceBetween size="xxs">
              <Select selectedOption={{ value: 'local', label: 'local' }} options={[]} disabled />
            </SpaceBetween>
            <ResourceStatus state="active" />
            <span>いいえ</span>
            <span />
          </div>
          {rows.map((r, i) => (
            <div className="route-editor-row" key={i} data-testid={`route-row-${i}`}>
              <Hotspot hotspotId={i === rows.length - 1 ? 'rt-route-destination' : `rt-route-destination-${i}`} direction="right">
                <Autosuggest
                  value={r.dest}
                  onChange={(e) => set(i, { dest: e.detail.value })}
                  options={[{ value: '0.0.0.0/0' }]}
                  placeholder="CIDR を入力"
                  enteredTextLabel={(v) => `使用: "${v}"`}
                  ariaLabel="送信先"
                  data-testid={`route-dest-${i}`}
                />
              </Hotspot>
              <Hotspot hotspotId={i === rows.length - 1 ? 'rt-route-target' : `rt-route-target-${i}`} direction="right">
                <SpaceBetween size="xxs">
                  <Select selectedOption={TARGET_TYPES.find((t) => t.value === r.type) ?? TARGET_TYPES[0]} options={TARGET_TYPES} onChange={(e) => set(i, { type: e.detail.selectedOption.value!, target: '' })} ariaLabel="ターゲットのタイプ" data-testid={`route-target-type-${i}`} />
                  <Autosuggest
                    value={r.target}
                    onChange={(e) => set(i, { target: e.detail.value })}
                    options={
                      r.type === 'nat'
                        ? nats.map((n) => ({ value: n.natGatewayId, label: n.natGatewayId, description: nameOf(n) || undefined, tags: [env.subnets.find((x) => x.subnetId === n.subnetId)?.availabilityZone ?? ''] }))
                        : igws.map((g) => ({ value: g.internetGatewayId, label: g.internetGatewayId, description: nameOf(g) || undefined, tags: [g.attachments[0] ? `Attached ${g.attachments[0].vpcId}` : 'Detached'] }))
                    }
                    placeholder={r.type === 'nat' ? 'nat-' : 'igw-'}
                    enteredTextLabel={(v) => `使用: "${v}"`}
                    ariaLabel="ターゲット"
                    data-testid={`route-target-${i}`}
                  />
                </SpaceBetween>
              </Hotspot>
              <span>-</span>
              <span>いいえ</span>
              <Button formAction="none" onClick={() => setRows(rows.filter((_, n) => n !== i))}>削除</Button>
            </div>
          ))}
        </div>
        <Box margin={{ top: 'm' }}>
          <Hotspot hotspotId="rt-add-route" direction="right">
            <Button formAction="none" onClick={() => setRows([...rows, { dest: '', target: '', type: 'igw' }])} data-testid="add-route">ルートを追加</Button>
          </Hotspot>
        </Box>
      </Container>
    </EditForm>
  );
}

export function EditSubnetAssociations({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const rt = env.routeTables.find((r) => r.routeTableId === id);
  const subnets = env.subnets.filter((s) => s.vpcId === rt?.vpcId);
  const [selected, setSelected] = useState<string[]>(() => rt?.associations.filter((a) => a.subnetId).map((a) => a.subnetId!) ?? []);
  const [error, setError] = useState<AwsError | null>(null);
  if (!rt) return <NotFound what="ルートテーブル" id={id} />;
  return (
    <EditForm
      title="サブネットの関連付けを編集"
      description="このルートテーブルに関連付けるサブネットを変更します。"
      submitText="関連付けを保存"
      submitTestId="save-associations"
      submitHotspotId="rt-save-associations"
      onCancel={() => navigate(`/vpc/route-tables/${id}?tab=subnet-associations`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => setSubnetAssociations(d, id, selected), `${label(id, rt)} のサブネットの関連付けが正常に更新されました。`);
        if (r.ok) navigate(`/vpc/route-tables/${id}?tab=subnet-associations`);
        else setError(r.error);
      }}
    >
      <Table<Subnet>
        variant="container"
        header={<Header counter={`(${selected.length}/${subnets.length})`}>使用可能なサブネット</Header>}
        items={subnets}
        trackBy="subnetId"
        selectionType="multi"
        selectedItems={subnets.filter((s) => selected.includes(s.subnetId))}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems.map((s) => s.subnetId))}
        ariaLabels={{ itemSelectionLabel: (_, s) => `${nameOf(s) || s.subnetId} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: 'サブネット' }}
        columnDefinitions={[
          { id: 'n', header: 'Name', cell: nameCell },
          { id: 'id', header: 'サブネット ID', cell: (s) => s.subnetId },
          { id: 'c', header: 'IPv4 CIDR', cell: (s) => s.cidrBlock },
          { id: 'rt', header: 'ルートテーブル ID', cell: (s) => label(effectiveRouteTable(env, s.subnetId).routeTableId, effectiveRouteTable(env, s.subnetId)) },
        ]}
      />
      <Container header={<Header variant="h2">選択したサブネット</Header>}>
        <TokenGroup items={selected.map((s) => ({ label: label(s, env.subnets.find((x) => x.subnetId === s)) }))} onDismiss={(e) => setSelected(selected.filter((_, i) => i !== e.detail.itemIndex))} />
      </Container>
    </EditForm>
  );
}

export function CreateRouteTable() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [vpcId, setVpcId] = useState<string>();
  const [error, setError] = useState<AwsError | null>(null);
  const options = env.vpcs.map(vpcOption);
  return (
    <EditForm
      title="ルートテーブルを作成"
      description="ルートテーブルは、VPC 内のサブネット、インターネット、VPN 接続の間でパケットがどのように転送されるかを指定します。"
      submitText="ルートテーブルを作成"
      onCancel={() => navigate('/vpc/route-tables')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createRouteTable(d, { vpcId: vpcId ?? '', name: name.trim() }), (rid) => `ルートテーブル ${rid}${name ? ` / ${name}` : ''} が正常に作成されました。`);
        if (r.ok) navigate(`/vpc/route-tables/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">ルートテーブルの設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="名前 - オプション">
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="my-route-table-01" />
          </FormField>
          <FormField label="VPC" description="このルートテーブルに使用する VPC。">
            <Select selectedOption={pick(options, vpcId)} options={options} onChange={(e) => setVpcId(e.detail.selectedOption.value)} placeholder="VPC を選択" />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- Internet gateways ----------------

function DetachModal({ igwId, vpcId, onClose }: { igwId: string; vpcId: string; onClose: () => void }) {
  const run = useConsole((s) => s.run);
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <Modal
      visible
      onDismiss={onClose}
      header="VPC からデタッチ"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>キャンセル</Button>
            <Button
              variant="primary"
              onClick={() => {
                const r = run((d) => detachInternetGateway(d, igwId, vpcId), `インターネットゲートウェイ ${igwId} が ${vpcId} から正常にデタッチされました`);
                if (r.ok) onClose();
                else setError(r.error);
              }}
            >
              インターネットゲートウェイのデタッチ
            </Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Box>インターネットゲートウェイ {igwId} を VPC {vpcId} からデタッチしてもよろしいですか?</Box>
        {error && <Box color="text-status-error">{error.message}</Box>}
      </SpaceBetween>
    </Modal>
  );
}

export function IgwList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.internetGateways, (g) => g.internetGatewayId);
  const [detach, setDetach] = useState<{ igwId: string; vpcId: string } | null>(null);
  const one = sel.length === 1 ? sel[0] : null;
  return (
    <>
      <ResourceTable
        title="インターネットゲートウェイ"
        resourceName="インターネットゲートウェイ"
        items={env.internetGateways}
        trackBy={(g) => g.internetGatewayId}
        selectedItems={sel}
        onSelectionChange={setSel}
        columns={[
          { id: 'name', header: 'Name', cell: nameCell, value: nameOf },
          { id: 'id', header: 'インターネットゲートウェイ ID', cell: (g) => <ConsoleLink to={`/vpc/igws/${g.internetGatewayId}`}>{g.internetGatewayId}</ConsoleLink>, value: (g) => g.internetGatewayId },
          { id: 'state', header: '状態', cell: (g) => <ResourceStatus state={g.attachments.length ? 'attached' : 'detached'} />, value: (g) => (g.attachments.length ? 'Attached' : 'Detached') },
          { id: 'vpc', header: 'VPC ID', cell: (g) => (g.attachments[0] ? <ConsoleLink to={`/vpc/vpcs/${g.attachments[0].vpcId}`}>{label(g.attachments[0].vpcId, env.vpcs.find((v) => v.vpcId === g.attachments[0].vpcId))}</ConsoleLink> : '-'), value: (g) => g.attachments[0]?.vpcId ?? '' },
          { id: 'owner', header: '所有者', cell: () => env.accountId },
        ]}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <ActionMenu
              items={[
                { id: 'attach', text: 'VPC にアタッチ', disabled: !one || !!one.attachments.length, onClick: () => navigate(`/vpc/igws/${one!.internetGatewayId}/attach`) },
                { id: 'detach', text: 'VPC からデタッチ', disabled: !one || !one.attachments.length, onClick: () => setDetach({ igwId: one!.internetGatewayId, vpcId: one!.attachments[0].vpcId }) },
              ]}
            />
            <Hotspot hotspotId="igw-create" direction="right">
              <Button variant="primary" onClick={() => navigate('/vpc/igws/create')} data-testid="create-igw">インターネットゲートウェイの作成</Button>
            </Hotspot>
          </SpaceBetween>
        }
      />
      {detach && <DetachModal {...detach} onClose={() => setDetach(null)} />}
    </>
  );
}

export function IgwDetail({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const [detach, setDetach] = useState(false);
  const g = env.internetGateways.find((x) => x.internetGatewayId === id);
  if (!g) return <NotFound what="インターネットゲートウェイ" id={id} />;
  const vpcId = g.attachments[0]?.vpcId;
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <Hotspot hotspotId="igw-actions" direction="right">
            <ActionMenu
              testId="igw-actions"
              items={[
                { id: 'attach', text: 'VPC にアタッチ', disabled: !!vpcId, onClick: () => navigate(`/vpc/igws/${id}/attach`) },
                { id: 'detach', text: 'VPC からデタッチ', disabled: !vpcId, onClick: () => setDetach(true) },
              ]}
            />
          </Hotspot>
        }
      >
        {label(g.internetGatewayId, g)}
      </Header>
      <ResourceDetail
        fields={[
          { label: 'インターネットゲートウェイ ID', value: <CopyableValue value={g.internetGatewayId} /> },
          { label: '状態', value: <ResourceStatus state={vpcId ? 'attached' : 'detached'} /> },
          { label: 'VPC ID', value: vpcId ? <ConsoleLink to={`/vpc/vpcs/${vpcId}`}>{label(vpcId, env.vpcs.find((v) => v.vpcId === vpcId))}</ConsoleLink> : '-' },
          { label: '所有者', value: env.accountId },
        ]}
      />
      <Tags tags={g.tags} />
      {detach && vpcId && <DetachModal igwId={id} vpcId={vpcId} onClose={() => setDetach(false)} />}
    </SpaceBetween>
  );
}

export function CreateIgw() {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const flash = useConsole((s) => s.flash);
  const [name, setName] = useState('');
  return (
    <EditForm
      title="インターネットゲートウェイの作成"
      description="インターネットゲートウェイは、VPC をインターネットに接続する仮想ルーターです。新しいインターネットゲートウェイを作成するには、以下でゲートウェイの名前を指定します。"
      submitText="インターネットゲートウェイの作成"
      submitTestId="create-igw-submit"
      onCancel={() => navigate('/vpc/igws')}
      error={null}
      onSubmit={() => {
        const r = run((d) => createInternetGateway(d, { name: name.trim() }));
        if (!r.ok) return;
        flash('success', `次のインターネットゲートウェイが作成されました: ${r.value}${name ? ` - ${name}` : ''}。VPC にアタッチして、VPC がインターネットと通信できるようにしましょう。`, { text: 'VPC へアタッチ', onClick: () => navigate(`/vpc/igws/${r.value}/attach`) });
        navigate(`/vpc/igws/${r.value}`);
      }}
    >
      <Container header={<Header variant="h2">インターネットゲートウェイの設定</Header>}>
        <FormField label="名前タグ" description="'Name' のキーと指定した値を持つタグを作成します。">
          <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="my-internet-gateway-01" data-testid="igw-name" />
        </FormField>
      </Container>
    </EditForm>
  );
}

export function AttachIgw({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [vpcId, setVpcId] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const free = env.vpcs.filter((v) => !env.internetGateways.some((g) => g.attachments.some((a) => a.vpcId === v.vpcId)));
  const g = env.internetGateways.find((x) => x.internetGatewayId === id);
  if (!g) return <NotFound what="インターネットゲートウェイ" id={id} />;
  return (
    <EditForm
      title={`VPC にアタッチ (${id})`}
      submitText="インターネットゲートウェイのアタッチ"
      submitTestId="attach-igw-submit"
      onCancel={() => navigate(`/vpc/igws/${id}`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => attachInternetGateway(d, id, vpcId.trim()), `インターネットゲートウェイ ${id} が ${vpcId} に正常にアタッチされました`);
        if (r.ok) navigate(`/vpc/igws/${id}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">VPC</Header>}>
        <FormField label="使用可能な VPC" description="インターネットゲートウェイをこの VPC にアタッチします。">
          <Autosuggest
            value={vpcId}
            onChange={(e) => setVpcId(e.detail.value)}
            options={free.map((v) => ({ value: v.vpcId, description: nameOf(v) || undefined, tags: [v.cidrBlock] }))}
            placeholder="VPC を選択"
            enteredTextLabel={(v) => `使用: "${v}"`}
            ariaLabel="使用可能な VPC"
            data-testid="attach-igw-vpc"
          />
        </FormField>
      </Container>
    </EditForm>
  );
}

