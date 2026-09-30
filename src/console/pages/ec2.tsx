import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Multiselect from '@cloudscape-design/components/multiselect';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tiles from '@cloudscape-design/components/tiles';
import { useState } from 'react';
import { AMIS, INSTANCE_TYPES, modifyInstanceSecurityGroups, privateDnsName, publicDnsName, rebootInstances, runInstances, startInstances, stopInstances, terminateInstances } from '../../sim/ec2';
import { metricFor } from '../../sim/cloudwatch';
import { label, nameOf } from '../../sim/env';
import { setInstanceProfile } from '../../sim/iam';
import { createSecurityGroup, type Direction } from '../../sim/sg';
import type { AwsError, Instance, SecurityGroupRule } from '../../sim/types';
import { pick, sgOption, subnetOption, vpcOption } from '../options';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, EditForm, formatDate, NotFound, ResourceDetail, ResourceStatus, ResourceTable, ResourceTabs, nameCell, useEnv, useNavigate, useSelection, type ActionItem } from '../ui';
import { MonitoringCharts } from './cloudwatch';
import { RulesTable } from './sg';
import { Tags } from './vpc';

// ---------------- dashboard ----------------

export function Ec2Dashboard() {
  const env = useEnv();
  const navigate = useNavigate();
  const item = (text: string, n: number, to: string) => (
    <div key={text}>
      <Box variant="awsui-key-label">{text}</Box>
      <ConsoleLink to={to}><Box variant="awsui-value-large" tagOverride="span">{n}</Box></ConsoleLink>
    </div>
  );
  return (
    <SpaceBetween size="l">
      <Header variant="h1">EC2 ダッシュボード</Header>
      <Container header={<Header variant="h2" description="このリージョンで次の Amazon EC2 リソースを使用しています">リソース</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          {item('インスタンス (実行中)', env.instances.filter((i) => i.state === 'running').length, '/ec2/instances')}
          {item('インスタンス', env.instances.filter((i) => i.state !== 'terminated').length, '/ec2/instances')}
          {item('ロードバランサー', env.loadBalancers.length, '/ec2/load-balancers')}
          {item('ターゲットグループ', env.targetGroups.length, '/ec2/target-groups')}
          {item('セキュリティグループ', env.securityGroups.length, '/ec2/security-groups')}
          {item('キーペア', env.keyPairs.length, '/ec2/instances')}
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">インスタンスを起動</Header>}>
        <SpaceBetween size="s">
          <Box>開始するには、クラウド内の仮想サーバーである Amazon EC2 インスタンスを起動します。</Box>
          <Button variant="primary" onClick={() => navigate('/ec2/launch')}>インスタンスを起動</Button>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

// ---------------- instances ----------------

function useInstanceStateActions(instances: Instance[]): ActionItem[] {
  const run = useConsole((s) => s.run);
  const ids = instances.map((i) => i.instanceId);
  const has = (...states: string[]) => instances.length > 0 && instances.every((i) => states.includes(i.state));
  return [
    { id: 'stop', text: 'インスタンスを停止', disabled: !has('running', 'pending'), onClick: () => run((d) => stopInstances(d, ids), `${ids.join(', ')} を正常に停止しました`) },
    { id: 'start', text: 'インスタンスを開始', disabled: !has('stopped'), onClick: () => run((d) => startInstances(d, ids), `${ids.join(', ')} を正常に開始しました`) },
    { id: 'reboot', text: 'インスタンスを再起動', disabled: !has('running'), onClick: () => run((d) => rebootInstances(d, ids), `${ids.join(', ')} を正常に再起動しました`) },
    { id: 'terminate', text: 'インスタンスを終了 (削除)', disabled: !instances.length || has('terminated', 'shutting-down'), onClick: () => run((d) => terminateInstances(d, ids), `${ids.join(', ')} を正常に終了しました`) },
  ];
}

function statusCheck(i: Instance) {
  if (i.state === 'running') return <StatusIndicator type="success">2/2 のチェックに合格しました</StatusIndicator>;
  if (i.state === 'pending') return <StatusIndicator type="pending">初期化しています</StatusIndicator>;
  return '-';
}

const sgNames = (env: ReturnType<typeof useEnv>, ids: string[]) => ids.map((id) => env.securityGroups.find((g) => g.groupId === id)?.groupName ?? id).join(', ');

export function InstanceList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.instances, (i) => i.instanceId);
  const stateActions = useInstanceStateActions(sel);
  return (
    <ResourceTable
      title="インスタンス"
      resourceName="インスタンス"
      testId="instances-table"
      filterPlaceholder="インスタンスを属性またはタグ (大文字と小文字を区別) で検索"
      selectionType="multi"
      items={env.instances}
      trackBy={(i) => i.instanceId}
      selectedItems={sel}
      onSelectionChange={setSel}
      columns={[
        { id: 'name', header: 'Name', cell: nameCell, value: nameOf },
        { id: 'id', header: 'インスタンス ID', cell: (i) => <ConsoleLink to={`/ec2/instances/${i.instanceId}`}>{i.instanceId}</ConsoleLink>, value: (i) => i.instanceId },
        { id: 'state', header: 'インスタンスの状態', cell: (i) => <ResourceStatus state={i.state} />, value: (i) => i.state },
        { id: 'type', header: 'インスタンスタイプ', cell: (i) => i.instanceType, value: (i) => i.instanceType },
        { id: 'check', header: 'ステータスチェック', cell: statusCheck },
        { id: 'az', header: 'アベイラビリティーゾーン', cell: (i) => i.availabilityZone, value: (i) => i.availabilityZone },
        { id: 'pubdns', header: 'パブリック IPv4 DNS', cell: (i) => (i.publicIpAddress ? publicDnsName(env, i.publicIpAddress) : '-') },
        { id: 'pubip', header: 'パブリック IPv4 アドレス', cell: (i) => (i.publicIpAddress ? <CopyableValue value={i.publicIpAddress} /> : '-'), value: (i) => i.publicIpAddress ?? '' },
        { id: 'privip', header: 'プライベート IP アドレス', cell: (i) => i.privateIpAddress, value: (i) => i.privateIpAddress },
        { id: 'sg', header: 'セキュリティグループ名', cell: (i) => sgNames(env, i.securityGroupIds), value: (i) => sgNames(env, i.securityGroupIds) },
        { id: 'key', header: 'キー名', cell: (i) => i.keyName ?? '-', value: (i) => i.keyName ?? '' },
        { id: 'launch', header: '起動時刻', cell: (i) => formatDate(i.launchTime) },
      ]}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button disabled={sel.length !== 1} onClick={() => navigate(`/ec2/instances/${sel[0].instanceId}/connect`)} data-testid="connect-instance">接続</Button>
          <ActionMenu text="インスタンスの状態" items={stateActions} testId="instance-state-menu" />
          <ActionMenu
            items={[
              { id: 'details', text: '詳細を表示', disabled: sel.length !== 1, onClick: () => navigate(`/ec2/instances/${sel[0].instanceId}`) },
              {
                text: 'セキュリティ',
                items: [
                  { id: 'sg', text: 'セキュリティグループを変更', disabled: sel.length !== 1, onClick: () => navigate(`/ec2/instances/${sel[0].instanceId}/change-security-groups`) },
                  { id: 'iam', text: 'IAM ロールを変更', disabled: sel.length !== 1, onClick: () => navigate(`/ec2/instances/${sel[0].instanceId}/modify-iam-role`) },
                ],
              },
            ]}
          />
          <Hotspot hotspotId="ec2-launch" direction="right">
            <Button variant="primary" onClick={() => navigate('/ec2/launch')} data-testid="launch-instances">インスタンスを起動</Button>
          </Hotspot>
        </SpaceBetween>
      }
    />
  );
}

function SecurityTab({ i }: { i: Instance }) {
  const env = useEnv();
  const groups = env.securityGroups.filter((g) => i.securityGroupIds.includes(g.groupId));
  const rules = (dir: Direction) => groups.flatMap((g) => g[dir].map((r) => ({ ...r, group: g.groupName })));
  const extra = { header: 'セキュリティグループ', cell: (r: SecurityGroupRule) => (r as SecurityGroupRule & { group: string }).group };
  return (
    <SpaceBetween size="l">
      <ResourceDetail
        title="セキュリティの詳細"
        columns={3}
        fields={[
          { label: 'IAM ロール', value: <InstanceRoleLink i={i} /> },
          { label: '所有者 ID', value: env.accountId },
          { label: '起動時刻', value: formatDate(i.launchTime) },
          {
            label: 'セキュリティグループ',
            value: (
              <SpaceBetween size="xxs">
                {groups.map((g) => (
                  <span key={g.groupId} data-testid={`instance-sg-${g.groupName}`}>
                    <CopyableValue value={g.groupId} iconOnly /> <ConsoleLink to={`/ec2/security-groups/${g.groupId}`}>{`${g.groupId} (${g.groupName})`}</ConsoleLink>
                  </span>
                ))}
              </SpaceBetween>
            ),
          },
        ]}
      />
      <RulesTable rules={rules('ingress')} direction="ingress" svc="ec2" extraColumn={extra} />
      <RulesTable rules={rules('egress')} direction="egress" svc="ec2" extraColumn={extra} />
    </SpaceBetween>
  );
}

function InstanceRoleLink({ i }: { i: Instance }) {
  const env = useEnv();
  const p = env.instanceProfiles.find((x) => x.arn === i.iamInstanceProfileArn);
  const role = p?.roleNames[0];
  return role ? <ConsoleLink to={`/iam/roles/${role}`}>{role}</ConsoleLink> : <>-</>;
}

function eniId(instanceId: string) {
  return 'eni-' + instanceId.slice(2).split('').reverse().join('');
}

export function InstanceDetail({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const i = env.instances.find((x) => x.instanceId === id);
  const stateActions = useInstanceStateActions(i ? [i] : []);
  if (!i) return <NotFound what="インスタンス" id={id} />;
  const subnet = env.subnets.find((s) => s.subnetId === i.subnetId);
  const vpc = env.vpcs.find((v) => v.vpcId === i.vpcId);
  const ami = AMIS.find((a) => a.imageId === i.imageId);
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="1 分以内に更新"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Hotspot hotspotId="ec2-connect" direction="right">
              <Button onClick={() => navigate(`/ec2/instances/${id}/connect`)} data-testid="connect-instance">接続</Button>
            </Hotspot>
            <ActionMenu text="インスタンスの状態" items={stateActions} testId="instance-state-menu" />
            <ActionMenu
              testId="instance-actions"
              items={[
                {
                  text: 'セキュリティ',
                  items: [
                    { id: 'sg', text: 'セキュリティグループを変更', onClick: () => navigate(`/ec2/instances/${id}/change-security-groups`) },
                    { id: 'iam', text: 'IAM ロールを変更', onClick: () => navigate(`/ec2/instances/${id}/modify-iam-role`) },
                  ],
                },
              ]}
            />
          </SpaceBetween>
        }
      >
        {i.instanceId} ({nameOf(i) || '-'}) のインスタンス概要
      </Header>
      <ResourceDetail
        title="インスタンスの概要"
        fields={[
          { label: 'インスタンス ID', value: <CopyableValue value={i.instanceId} /> },
          { label: 'パブリック IPv4 アドレス', value: i.publicIpAddress ? <CopyableValue value={i.publicIpAddress} testId="public-ip" /> : '-' },
          { label: 'プライベート IPv4 アドレス', value: <CopyableValue value={i.privateIpAddress} /> },
          { label: 'インスタンスの状態', value: <ResourceStatus state={i.state} /> },
          { label: 'パブリック IPv4 DNS', value: i.publicIpAddress ? <CopyableValue value={publicDnsName(env, i.publicIpAddress)} /> : '-' },
          { label: 'プライベート IP DNS 名 (IPv4 のみ)', value: privateDnsName(env, i.privateIpAddress) },
          { label: 'インスタンスタイプ', value: i.instanceType },
          { label: 'VPC ID', value: <ConsoleLink to={`/vpc/vpcs/${i.vpcId}`}>{label(i.vpcId, vpc)}</ConsoleLink> },
          { label: 'サブネット ID', value: <ConsoleLink to={`/vpc/subnets/${i.subnetId}`}>{label(i.subnetId, subnet)}</ConsoleLink> },
          { label: 'IAM ロール', value: <InstanceRoleLink i={i} /> },
          { label: 'AMI ID', value: i.imageId },
          { label: '起動時に割り当てられたキーペア', value: i.keyName ?? '-' },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'details',
            label: '詳細',
            content: (
              <ResourceDetail
                title="インスタンスの詳細"
                fields={[
                  { label: 'プラットフォームの詳細', value: i.platformDetails },
                  { label: 'AMI 名', value: ami?.name ?? '-' },
                  { label: '起動時刻', value: formatDate(i.launchTime) },
                  { label: 'アベイラビリティーゾーン', value: i.availabilityZone },
                  { label: 'モニタリング', value: '無効' },
                  { label: 'テナンシー', value: 'default' },
                ]}
              />
            ),
          },
          { id: 'status', label: 'ステータスとアラーム', content: <ResourceDetail title="ステータスチェック" fields={[{ label: 'システムステータスチェック', value: statusCheck(i) }, { label: 'インスタンスステータスチェック', value: statusCheck(i) }]} /> },
          {
            id: 'monitoring',
            label: 'モニタリング',
            content: <MonitoringCharts metrics={['CPUUtilization', 'NetworkIn'].map((m) => metricFor('AWS/EC2', m, i.instanceId))} />,
          },
          { id: 'security', label: 'セキュリティ', content: <SecurityTab i={i} /> },
          {
            id: 'networking',
            label: 'ネットワーキング',
            content: (
              <SpaceBetween size="l">
                <ResourceDetail
                  title="ネットワーキングの詳細"
                  fields={[
                    { label: 'パブリック IPv4 アドレス', value: i.publicIpAddress ?? '-' },
                    { label: 'プライベート IPv4 アドレス', value: i.privateIpAddress },
                    { label: 'VPC ID', value: <ConsoleLink to={`/vpc/vpcs/${i.vpcId}`}>{label(i.vpcId, vpc)}</ConsoleLink> },
                    { label: 'サブネット ID', value: <ConsoleLink to={`/vpc/subnets/${i.subnetId}`}>{label(i.subnetId, subnet)}</ConsoleLink> },
                    { label: 'アベイラビリティーゾーン', value: i.availabilityZone },
                    { label: '自動割り当て IP アドレス', value: i.publicIpAddress ? `${i.publicIpAddress} [パブリック IP]` : '-' },
                  ]}
                />
                <Table
                  variant="container"
                  header={<Header counter="(1)">ネットワークインターフェイス</Header>}
                  items={[i]}
                  columnDefinitions={[
                    { id: 'eni', header: 'インターフェイス ID', cell: (x) => eniId(x.instanceId) },
                    { id: 'sub', header: 'サブネット ID', cell: (x) => x.subnetId },
                    { id: 'ip', header: 'プライベート IPv4 アドレス', cell: (x) => x.privateIpAddress },
                    { id: 'pub', header: 'パブリック IPv4 アドレス', cell: (x) => x.publicIpAddress ?? '-' },
                    { id: 'sg', header: 'セキュリティグループ', cell: (x) => sgNames(env, x.securityGroupIds) },
                  ]}
                />
              </SpaceBetween>
            ),
          },
          {
            id: 'storage',
            label: 'ストレージ',
            content: (
              <Table
                variant="container"
                header={<Header counter="(1)">ブロックデバイス</Header>}
                items={[i]}
                columnDefinitions={[
                  { id: 'vol', header: 'ボリューム ID', cell: (x) => 'vol-' + x.instanceId.slice(2) },
                  { id: 'dev', header: 'デバイス名', cell: () => '/dev/xvda' },
                  { id: 'size', header: 'ボリュームサイズ (GiB)', cell: () => 8 },
                  { id: 'type', header: 'ボリュームタイプ', cell: () => 'gp3' },
                ]}
              />
            ),
          },
          { id: 'tags', label: 'タグ', content: <Tags tags={i.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------- launch ----------------

export function LaunchInstance() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [imageId, setImageId] = useState(AMIS[0].imageId);
  const [type, setType] = useState('t3.micro');
  const [key, setKey] = useState<string>('');
  const defaultVpc = env.vpcs.find((v) => v.isDefault) ?? env.vpcs[0];
  const [vpcId, setVpcId] = useState(defaultVpc?.vpcId ?? '');
  const [subnetId, setSubnetId] = useState('');
  const [publicIp, setPublicIp] = useState<'default' | 'enable' | 'disable'>('default');
  const [sgMode, setSgMode] = useState<'existing' | 'create'>('existing');
  const [sgIds, setSgIds] = useState<string[]>([]);
  const [count, setCount] = useState('1');
  const [profileArn, setProfileArn] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const [launched, setLaunched] = useState<string[] | null>(null);
  const subnets = env.subnets.filter((s) => s.vpcId === vpcId);
  const subnet = subnets.find((s) => s.subnetId === subnetId);
  const effectivePublic = publicIp === 'default' ? !!subnet?.mapPublicIpOnLaunch : publicIp === 'enable';
  const sgs = env.securityGroups.filter((g) => g.vpcId === vpcId);
  const ami = AMIS.find((a) => a.imageId === imageId)!;
  const vpcOpts = env.vpcs.map(vpcOption);
  const subnetOpts = [{ value: '', label: '指定なし' }, ...subnets.map(subnetOption)];

  if (launched)
    return (
      <SpaceBetween size="l">
        <Alert type="success" header="成功" data-testid="launch-success">
          インスタンス ({launched.map((id) => <ConsoleLink key={id} to={`/ec2/instances/${id}`}>{id}</ConsoleLink>)}) の起動を正常に開始しました
        </Alert>
        <Button variant="primary" onClick={() => navigate('/ec2/instances')}>すべてのインスタンスを表示</Button>
      </SpaceBetween>
    );

  const submit = () => {
    const r = run((d) => {
      let groups = sgIds;
      if (sgMode === 'create') groups = [createSecurityGroup(d, { groupName: `launch-wizard-${d.securityGroups.length + 1}`, description: `launch-wizard-${d.securityGroups.length + 1} created ${new Date().toISOString()}`, vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '0.0.0.0/0' }] })];
      const target = subnetId || d.subnets.filter((s) => s.vpcId === vpcId)[0]?.subnetId;
      const ids = runInstances(d, { name: name.trim(), imageId, instanceType: type, keyName: key || undefined, subnetId: target ?? '', securityGroupIds: groups, associatePublicIpAddress: publicIp === 'default' ? undefined : publicIp === 'enable', count: Math.max(1, Number(count) || 1) });
      if (profileArn) ids.forEach((id) => setInstanceProfile(d, id, profileArn));
      return ids;
    });
    if (r.ok) setLaunched(r.value);
    else setError(r.error);
  };

  return (
    <Grid gridDefinition={[{ colspan: 8 }, { colspan: 4 }]}>
      <SpaceBetween size="l">
        <Header variant="h1" description="Amazon EC2 では、AWS クラウドで実行される仮想マシン (インスタンス) を作成できます。以下の簡単なステップに従って、すぐに開始できます。">インスタンスを起動</Header>
        {error && <Alert type="error" header="インスタンスの起動に失敗しました" data-testid="form-error">{error.message} ({error.code})</Alert>}
        <Container header={<Header variant="h2">名前とタグ</Header>}>
          <FormField label="名前">
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="例: My Web Server" data-testid="launch-name" />
          </FormField>
        </Container>
        <Container header={<Header variant="h2" description="AMI には、インスタンスのオペレーティングシステム、アプリケーションサーバー、アプリケーションが含まれています。">アプリケーションおよび OS イメージ (Amazon マシンイメージ)</Header>}>
          <SpaceBetween size="m">
            <Tiles value={imageId} onChange={(e) => setImageId(e.detail.value)} columns={3} items={AMIS.map((a) => ({ value: a.imageId, label: a.name.split(' ').slice(0, 3).join(' '), description: a.imageId }))} />
            <Box variant="small" color="text-body-secondary">{ami.description} — {ami.imageId}</Box>
          </SpaceBetween>
        </Container>
        <Container header={<Header variant="h2">インスタンスタイプ</Header>}>
          <FormField label="インスタンスタイプ">
            <Select
              selectedOption={{ value: type, label: type }}
              options={INSTANCE_TYPES.map((t) => ({ value: t.type, label: t.type, description: `${t.vcpu} vCPU · ${t.memoryGiB} GiB メモリ${t.freeTier ? ' · 無料利用枠の対象' : ''}` }))}
              onChange={(e) => setType(e.detail.selectedOption.value!)}
            />
          </FormField>
        </Container>
        <Container header={<Header variant="h2" description="キーペアを使用すると、インスタンスに安全に接続できます。">キーペア (ログイン)</Header>}>
          <FormField label="キーペア名 - 必須">
            <Select
              selectedOption={key ? { value: key, label: key } : { value: '', label: 'キーペアなしで続行 (推奨されません)' }}
              options={[{ value: '', label: 'キーペアなしで続行 (推奨されません)' }, ...env.keyPairs.map((k) => ({ value: k, label: k, description: 'RSA' }))]}
              onChange={(e) => setKey(e.detail.selectedOption.value!)}
              data-testid="launch-key"
            />
          </FormField>
        </Container>
        <Container header={<Header variant="h2">ネットワーク設定</Header>}>
          <SpaceBetween size="l">
            <FormField label="VPC - 必須">
              <Select selectedOption={pick(vpcOpts, vpcId)} options={vpcOpts} onChange={(e) => { setVpcId(e.detail.selectedOption.value!); setSubnetId(''); setSgIds([]); }} data-testid="launch-vpc" />
            </FormField>
            <FormField label="サブネット">
              <Select selectedOption={pick(subnetOpts, subnetId)} options={subnetOpts} onChange={(e) => setSubnetId(e.detail.selectedOption.value!)} data-testid="launch-subnet" />
            </FormField>
            <FormField label="パブリック IP の自動割り当て" description={`サブネットのデフォルト: ${subnet ? (subnet.mapPublicIpOnLaunch ? '有効化' : '無効化') : '-'}`}>
              <Select
                selectedOption={{ value: publicIp, label: publicIp === 'default' ? `${effectivePublic ? '有効化' : '無効化'} (サブネットのデフォルト)` : publicIp === 'enable' ? '有効化' : '無効化' }}
                options={[{ value: 'default', label: 'サブネットのデフォルト' }, { value: 'enable', label: '有効化' }, { value: 'disable', label: '無効化' }]}
                onChange={(e) => setPublicIp(e.detail.selectedOption.value as typeof publicIp)}
                data-testid="launch-public-ip"
              />
            </FormField>
            <FormField label="ファイアウォール (セキュリティグループ)" description="セキュリティグループは、インスタンスのトラフィックを制御するファイアウォールルールのセットです。">
              <RadioGroup value={sgMode} onChange={(e) => setSgMode(e.detail.value as typeof sgMode)} items={[{ value: 'create', label: 'セキュリティグループを作成' }, { value: 'existing', label: '既存のセキュリティグループを選択する' }]} />
            </FormField>
            {sgMode === 'existing' ? (
              <FormField label="共通のセキュリティグループ">
                <Multiselect selectedOptions={sgs.filter((g) => sgIds.includes(g.groupId)).map(sgOption)} options={sgs.map(sgOption)} onChange={(e) => setSgIds(e.detail.selectedOptions.map((o) => o.value!))} placeholder="セキュリティグループを選択" data-testid="launch-sgs" />
              </FormField>
            ) : (
              <Alert type="warning">任意の場所 (0.0.0.0/0) からの SSH (22) を許可する新しいセキュリティグループが作成されます。ソースが 0.0.0.0/0 のルールは、すべての IP アドレスからインスタンスへのアクセスを許可します。</Alert>
            )}
          </SpaceBetween>
        </Container>
        <ExpandableSection variant="container" headerText="高度な詳細">
          <FormField label="IAM インスタンスプロファイル" description="インスタンスにアタッチする IAM ロール (インスタンスプロファイル) を選択します。">
            <Select
              selectedOption={profileArn ? { value: profileArn, label: env.instanceProfiles.find((p) => p.arn === profileArn)?.instanceProfileName } : { value: '', label: '選択' }}
              options={[{ value: '', label: '選択' }, ...env.instanceProfiles.map((p) => ({ value: p.arn, label: p.instanceProfileName, description: p.arn }))]}
              onChange={(e) => setProfileArn(e.detail.selectedOption.value!)}
              data-testid="launch-iam-profile"
            />
          </FormField>
        </ExpandableSection>
        <Container header={<Header variant="h2">ストレージを設定</Header>}>
          <Box>1x 8 GiB gp3 ルートボリューム (暗号化されていません)</Box>
        </Container>
      </SpaceBetween>
      <div className="sticky-summary">
        <Container header={<Header variant="h2">概要</Header>}>
          <SpaceBetween size="m">
            <FormField label="インスタンス数">
              <Input type="number" value={count} onChange={(e) => setCount(e.detail.value)} />
            </FormField>
            <div><Box variant="awsui-key-label">ソフトウェアイメージ (AMI)</Box><Box>{ami.name}</Box></div>
            <div><Box variant="awsui-key-label">仮想サーバータイプ (インスタンスタイプ)</Box><Box>{type}</Box></div>
            <div><Box variant="awsui-key-label">ファイアウォール (セキュリティグループ)</Box><Box>{sgMode === 'create' ? '新しいセキュリティグループ' : sgs.filter((g) => sgIds.includes(g.groupId)).map((g) => g.groupName).join(', ') || '-'}</Box></div>
            <div><Box variant="awsui-key-label">ストレージ (ボリューム)</Box><Box>1 個のボリューム - 8 GiB</Box></div>
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => navigate('/ec2/instances')}>キャンセル</Button>
                <Hotspot hotspotId="ec2-launch-submit" direction="right">
                  <Button variant="primary" onClick={submit} data-testid="launch-submit">インスタンスを起動</Button>
                </Hotspot>
              </SpaceBetween>
            </Box>
          </SpaceBetween>
        </Container>
      </div>
    </Grid>
  );
}

export function ChangeSecurityGroups({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const i = env.instances.find((x) => x.instanceId === id);
  const [ids, setIds] = useState<string[]>(i?.securityGroupIds ?? []);
  const [error, setError] = useState<AwsError | null>(null);
  if (!i) return <NotFound what="インスタンス" id={id} />;
  const sgs = env.securityGroups.filter((g) => g.vpcId === i.vpcId);
  return (
    <EditForm
      title="セキュリティグループの変更"
      description="セキュリティグループは、関連付けられたインスタンスのファイアウォールとして機能し、インスタンスレベルでインバウンドとアウトバウンドの両方のトラフィックを制御します。"
      submitText="保存"
      onCancel={() => navigate(`/ec2/instances/${id}`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => modifyInstanceSecurityGroups(d, id, ids), `${id} のセキュリティグループを正常に変更しました`);
        if (r.ok) navigate(`/ec2/instances/${id}?tab=security`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">インスタンスの詳細</Header>}>
        <SpaceBetween size="l">
          <FormField label="インスタンス ID">{label(i.instanceId, i)}</FormField>
          <FormField label="関連付けられたセキュリティグループ">
            <Multiselect selectedOptions={sgs.filter((g) => ids.includes(g.groupId)).map(sgOption)} options={sgs.map(sgOption)} onChange={(e) => setIds(e.detail.selectedOptions.map((o) => o.value!))} />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}
