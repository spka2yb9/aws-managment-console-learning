import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useState } from 'react';
import { label, nameOf } from '../../sim/env';
import type { AwsError, NatGateway } from '../../sim/types';
import { createNatGateway, createVpcEndpoint, deleteNatGateway, deleteVpcEndpoint, isPublicSubnet, S3_PREFIX_LIST, s3EndpointService } from '../../sim/vpc';
import { vpcOption } from '../options';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, DeleteModal, EditForm, formatDate, nameCell, NotFound, ResourceDetail, ResourceStatus, ResourceTable, useEnv, useNavigate, useSelection } from '../ui';

const natPath = (id: string) => `/vpc/nat-gateways/${id}`;
const subnetName = (env: ReturnType<typeof useEnv>, id: string) => label(id, env.subnets.find((s) => s.subnetId === id));

function DeleteNatModal({ nat, onClose }: { nat: NatGateway; onClose: () => void }) {
  const run = useConsole((s) => s.run);
  return (
    <DeleteModal header="NAT ゲートウェイを削除" testId="delete-nat" onClose={onClose} onDelete={() => run((d) => deleteNatGateway(d, nat.natGatewayId), `NAT ゲートウェイ ${nat.natGatewayId} を削除しています`)}>
      <Box>NAT ゲートウェイ {label(nat.natGatewayId, nat)} を削除しますか? このゲートウェイをターゲットにしているルートはブラックホールになり、そのサブネットからインターネットに出られなくなります。</Box>
    </DeleteModal>
  );
}

export function NatList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [selected, setSelected] = useSelection(env.natGateways, (n) => n.natGatewayId);
  const [del, setDel] = useState<NatGateway | null>(null);
  const one = selected.length === 1 ? selected[0] : undefined;
  return (
    <>
      <ResourceTable
        title="NAT ゲートウェイ"
        resourceName="NAT ゲートウェイ"
        testId="nat-table"
        items={env.natGateways}
        trackBy={(n) => n.natGatewayId}
        selectedItems={selected}
        onSelectionChange={setSelected}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Hotspot hotspotId="nat-actions" direction="right">
              <ActionMenu testId="nat-actions" items={[{ id: 'delete', text: 'NAT ゲートウェイを削除', disabled: !one || one.state === 'deleted' || one.state === 'deleting', onClick: () => setDel(one!) }]} />
            </Hotspot>
            <Button variant="primary" onClick={() => navigate('/vpc/nat-gateways/create')} data-testid="create-nat">NAT ゲートウェイを作成</Button>
          </SpaceBetween>
        }
        columns={[
          { id: 'name', header: 'Name', cell: nameCell, value: (n) => nameOf(n) },
          { id: 'id', header: 'NAT ゲートウェイ ID', cell: (n) => <ConsoleLink to={natPath(n.natGatewayId)}>{n.natGatewayId}</ConsoleLink>, value: (n) => n.natGatewayId },
          { id: 'type', header: '接続タイプ', cell: () => 'パブリック' },
          { id: 'state', header: '状態', cell: (n) => <ResourceStatus state={n.state} />, value: (n) => n.state },
          { id: 'ip', header: 'プライマリパブリック IPv4 アドレス', cell: (n) => n.publicIp },
          { id: 'subnet', header: 'サブネット', cell: (n) => subnetName(env, n.subnetId), value: (n) => subnetName(env, n.subnetId) },
          { id: 'vpc', header: 'VPC', cell: (n) => label(n.vpcId, env.vpcs.find((v) => v.vpcId === n.vpcId)), value: (n) => n.vpcId },
          { id: 'az', header: 'アベイラビリティーゾーン', cell: (n) => env.subnets.find((s) => s.subnetId === n.subnetId)?.availabilityZone },
        ]}
      />
      {del && <DeleteNatModal nat={del} onClose={() => { setDel(null); setSelected([]); }} />}
    </>
  );
}

export function NatDetail({ id }: { id: string }) {
  const env = useEnv();
  const [del, setDel] = useState(false);
  const n = env.natGateways.find((x) => x.natGatewayId === id);
  if (!n) return <NotFound what="NAT ゲートウェイ" id={id} />;
  const users = env.routeTables.filter((rt) => rt.routes.some((r) => r.natGatewayId === id));
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<ActionMenu items={[{ id: 'delete', text: 'NAT ゲートウェイを削除', disabled: n.state === 'deleted' || n.state === 'deleting', onClick: () => setDel(true) }]} />}>
        {label(n.natGatewayId, n)}
      </Header>
      <ResourceDetail
        fields={[
          { label: 'NAT ゲートウェイ ID', value: <CopyableValue value={n.natGatewayId} /> },
          { label: '接続タイプ', value: 'パブリック' },
          { label: '状態', value: <span data-testid="nat-state"><ResourceStatus state={n.state} /></span> },
          { label: 'プライマリパブリック IPv4 アドレス', value: n.publicIp },
          { label: 'プライマリプライベート IPv4 アドレス', value: n.privateIp },
          { label: 'サブネット', value: <ConsoleLink to={`/vpc/subnets/${n.subnetId}`}>{subnetName(env, n.subnetId)}</ConsoleLink> },
          { label: 'VPC', value: <ConsoleLink to={`/vpc/vpcs/${n.vpcId}`}>{label(n.vpcId, env.vpcs.find((v) => v.vpcId === n.vpcId))}</ConsoleLink> },
          { label: '作成日時', value: formatDate(n.createTime) },
        ]}
      />
      <Container header={<Header variant="h2" description="この NAT ゲートウェイにトラフィックを送るルートテーブル">ルートテーブル</Header>}>
        {users.length ? users.map((rt) => <Box key={rt.routeTableId}><ConsoleLink to={`/vpc/route-tables/${rt.routeTableId}?tab=routes`}>{label(rt.routeTableId, rt)}</ConsoleLink></Box>) : <Box color="text-body-secondary">どのルートテーブルからも使われていません</Box>}
      </Container>
      {del && <DeleteNatModal nat={n} onClose={() => setDel(false)} />}
    </SpaceBetween>
  );
}

export function CreateNat() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [subnetId, setSubnetId] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const subnetOption = (id: string) => {
    const s = env.subnets.find((x) => x.subnetId === id)!;
    return { value: id, label: label(id, s), description: `${s.availabilityZone} / ${isPublicSubnet(env, id) ? 'パブリック' : 'プライベート'}` };
  };
  return (
    <EditForm
      title="NAT ゲートウェイを作成"
      description="NAT ゲートウェイは、プライベートサブネットのインスタンスがインターネットに接続するための、可用性の高いマネージド型サービスです。"
      submitText="NAT ゲートウェイを作成"
      onCancel={() => navigate('/vpc/nat-gateways')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createNatGateway(d, { subnetId, name: name.trim() }), (id) => `NAT ゲートウェイ ${id} が作成されました`);
        if (r.ok) navigate(natPath(r.value));
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">NAT ゲートウェイの設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="名前 - オプション"><Input value={name} onChange={(e) => setName(e.detail.value)} /></FormField>
          <FormField label="サブネット" description="パブリックサブネットを選択します。プライベートサブネットに作成すると、インターネットに出られません。">
            <Select selectedOption={subnetId ? subnetOption(subnetId) : null} placeholder="サブネットを選択" options={env.subnets.map((s) => subnetOption(s.subnetId))} onChange={(e) => setSubnetId(e.detail.selectedOption.value!)} />
          </FormField>
          <FormField label="接続タイプ"><RadioGroup value="public" items={[{ value: 'public', label: 'パブリック' }, { value: 'private', label: 'プライベート', disabled: true, description: 'このシミュレーターでは未提供' }]} /></FormField>
          <FormField label="Elastic IP 割り当て ID" description="作成時に Elastic IP アドレスを自動で割り当てます。"><Input value="自動割り当て" disabled /></FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function EndpointList() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [selected, setSelected] = useSelection(env.vpcEndpoints, (e) => e.vpcEndpointId);
  return (
    <ResourceTable
      title="エンドポイント"
      resourceName="エンドポイント"
      testId="endpoint-table"
      items={env.vpcEndpoints}
      trackBy={(e) => e.vpcEndpointId}
      selectedItems={selected}
      onSelectionChange={setSelected}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu items={[{ id: 'delete', text: 'VPC エンドポイントを削除', disabled: selected.length !== 1, onClick: () => run((d) => deleteVpcEndpoint(d, selected[0].vpcEndpointId), `VPC エンドポイント ${selected[0].vpcEndpointId} を削除しました`) && setSelected([]) }]} />
          <Hotspot hotspotId="vpce-create" direction="right">
            <Button variant="primary" onClick={() => navigate('/vpc/endpoints/create')} data-testid="create-endpoint">エンドポイントを作成</Button>
          </Hotspot>
        </SpaceBetween>
      }
      columns={[
        { id: 'name', header: 'Name', cell: nameCell, value: (e) => nameOf(e) },
        { id: 'id', header: 'VPC エンドポイント ID', cell: (e) => e.vpcEndpointId, value: (e) => e.vpcEndpointId },
        { id: 'vpc', header: 'VPC ID', cell: (e) => label(e.vpcId, env.vpcs.find((v) => v.vpcId === e.vpcId)), value: (e) => e.vpcId },
        { id: 'service', header: 'サービス名', cell: (e) => e.serviceName, value: (e) => e.serviceName },
        { id: 'type', header: 'エンドポイントタイプ', cell: () => 'Gateway' },
        { id: 'state', header: 'ステータス', cell: (e) => <ResourceStatus state={e.state} /> },
        { id: 'rts', header: 'ルートテーブル', cell: (e) => e.routeTableIds.map((id) => label(id, env.routeTables.find((r) => r.routeTableId === id))).join(', ') },
      ]}
    />
  );
}

export function CreateEndpoint() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [vpcId, setVpcId] = useState('');
  const [rts, setRts] = useState<string[]>([]);
  const [error, setError] = useState<AwsError | null>(null);
  const service = s3EndpointService(env);
  return (
    <EditForm
      title="エンドポイントを作成"
      description="VPC エンドポイントを使うと、インターネットゲートウェイや NAT ゲートウェイを通らずに、AWS のサービスへプライベートに接続できます。"
      submitText="エンドポイントを作成"
      submitTestId="create-endpoint-submit"
      submitHotspotId="vpce-create-submit"
      onCancel={() => navigate('/vpc/endpoints')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createVpcEndpoint(d, { vpcId, serviceName: service, routeTableIds: rts, name: name.trim() }), (id) => `VPC エンドポイント ${id} が作成されました`);
        if (r.ok) navigate('/vpc/endpoints');
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">エンドポイントの設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="名前タグ - オプション"><Input value={name} onChange={(e) => setName(e.detail.value)} /></FormField>
          <FormField label="サービスカテゴリ"><RadioGroup value="aws" items={[{ value: 'aws', label: 'AWS のサービス' }]} /></FormField>
          <FormField label="サービス" description="ゲートウェイエンドポイント (S3 / DynamoDB) は無料です。インターフェイスエンドポイントは時間とデータ量の料金がかかります (このシミュレーターでは未提供)。">
            <Select selectedOption={{ value: service, label: service, description: 'タイプ: Gateway' }} options={[{ value: service, label: service, description: 'タイプ: Gateway' }]} data-testid="endpoint-service" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">ネットワーク設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="VPC">
            <Select selectedOption={vpcId ? vpcOption(env.vpcs.find((v) => v.vpcId === vpcId)!) : null} placeholder="VPC を選択" options={env.vpcs.map(vpcOption)} onChange={(e) => { setVpcId(e.detail.selectedOption.value!); setRts([]); }} data-testid="endpoint-vpc" />
          </FormField>
          <FormField label="ルートテーブル" description={`選択したルートテーブルに、送信先 ${S3_PREFIX_LIST} (S3) → このエンドポイント のルートが追加されます。`}>
            <SpaceBetween size="xxs">
              {env.routeTables.filter((rt) => rt.vpcId === vpcId).map((rt) => (
                <Checkbox key={rt.routeTableId} checked={rts.includes(rt.routeTableId)} onChange={(e) => setRts(e.detail.checked ? [...rts, rt.routeTableId] : rts.filter((x) => x !== rt.routeTableId))} data-testid={`endpoint-rt-${nameOf(rt) || rt.routeTableId}`}>
                  {label(rt.routeTableId, rt)}
                </Checkbox>
              ))}
            </SpaceBetween>
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}
