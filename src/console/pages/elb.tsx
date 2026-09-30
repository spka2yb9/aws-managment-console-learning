import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
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
import Wizard from '@cloudscape-design/components/wizard';
import { useState } from 'react';
import { createLoadBalancer, createTargetGroup, DEFAULT_HEALTH_CHECK, deleteLoadBalancer, deregisterTargets, lbsForTargetGroup, modifyTargetGroupHealthCheck, registerTargets, setLoadBalancerSecurityGroups, targetHealth } from '../../sim/elb';
import { lbDimension, metricFor } from '../../sim/cloudwatch';
import { label, nameOf } from '../../sim/env';
import type { AwsEnv, AwsError, HealthCheck, Instance, LoadBalancer, RegisteredTarget, TargetGroup } from '../../sim/types';
import { backendOf, taskId } from '../../sim/targets';
import { isPublicSubnet } from '../../sim/vpc';
import { pick, sgOption, vpcOption } from '../options';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, DeleteModal, EditForm, errorText, formatDate, NotFound, ResourceDetail, ResourceStatus, ResourceTable, ResourceTabs, nameCell, useEnv, useNavigate, useSelection } from '../ui';
import { MonitoringCharts } from './cloudwatch';

// Tokyo ALB canonical hosted zone id (what Route 53 alias records point at).
const HOSTED_ZONE: Record<string, string> = { 'ap-northeast-1': 'Z14GRHDCWA56QT', 'us-east-1': 'Z35SXDOTRQ7X7K' };

const lbPath = (lb: LoadBalancer) => `/ec2/load-balancers/${lb.loadBalancerName}`;
const tgPath = (tg: TargetGroup) => `/ec2/target-groups/${tg.targetGroupName}`;

// ---------------- load balancers ----------------

export function LbList() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [sel, setSel] = useSelection(env.loadBalancers, (l) => l.loadBalancerArn);
  const [deleting, setDeleting] = useState<LoadBalancer | null>(null);
  return (
    <>
      <ResourceTable
        title="ロードバランサー"
        description="Elastic Load Balancing は、受信トラフィックの変化に応じてロードバランサーの容量を自動的にスケーリングします。"
        resourceName="ロードバランサー"
        testId="lb-table"
        items={env.loadBalancers}
        trackBy={(l) => l.loadBalancerArn}
        selectedItems={sel}
        onSelectionChange={setSel}
        columns={[
          { id: 'name', header: '名前', cell: (l) => <ConsoleLink to={lbPath(l)}>{l.loadBalancerName}</ConsoleLink>, value: (l) => l.loadBalancerName },
          { id: 'dns', header: 'DNS 名', cell: (l) => <CopyableValue value={l.dnsName} />, value: (l) => l.dnsName },
          { id: 'state', header: '状態', cell: (l) => <ResourceStatus state={l.state} />, value: (l) => l.state },
          { id: 'vpc', header: 'VPC ID', cell: (l) => <ConsoleLink to={`/vpc/vpcs/${l.vpcId}`}>{l.vpcId}</ConsoleLink>, value: (l) => l.vpcId },
          { id: 'az', header: 'アベイラビリティーゾーン', cell: (l) => `${l.subnetIds.length} 個のアベイラビリティーゾーン` },
          { id: 'type', header: 'タイプ', cell: () => 'application' },
          { id: 'scheme', header: 'スキーム', cell: (l) => l.scheme, value: (l) => l.scheme },
          { id: 'date', header: '作成日', cell: (l) => formatDate(l.createdTime) },
        ]}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <ActionMenu
              testId="lb-actions"
              items={[
                { id: 'sg', text: 'セキュリティグループを編集', disabled: sel.length !== 1, onClick: () => navigate(`${lbPath(sel[0])}/edit-security-groups`) },
                { id: 'delete', text: 'ロードバランサーの削除', disabled: sel.length !== 1, onClick: () => setDeleting(sel[0]) },
              ]}
            />
            <Hotspot hotspotId="alb-create" direction="right">
              <Button variant="primary" onClick={() => navigate('/ec2/load-balancers/select-type')} data-testid="create-lb">ロードバランサーの作成</Button>
            </Hotspot>
          </SpaceBetween>
        }
      />
      {deleting && (
        <DeleteModal header="ロードバランサーの削除" testId="delete-lb" onClose={() => { setDeleting(null); setSel([]); }} onDelete={() => run((d) => deleteLoadBalancer(d, deleting.loadBalancerArn), `ロードバランサー ${deleting.loadBalancerName} を削除しました`)}>
          <Box>{deleting.loadBalancerName} を削除しますか? リスナーも削除され、DNS 名 {deleting.dnsName} には接続できなくなります。ターゲットグループは残ります。</Box>
        </DeleteModal>
      )}
    </>
  );
}

export function LbSelectType() {
  const navigate = useNavigate();
  const card = (title: string, text: string, enabled: boolean, testId?: string) => (
    <Container header={<Header variant="h2">{title}</Header>} fitHeight>
      <SpaceBetween size="m">
        <Box>{text}</Box>
        <Button variant={enabled ? 'primary' : 'normal'} disabled={!enabled} disabledReason="このシミュレーターでは未提供" onClick={() => navigate('/ec2/load-balancers/create-alb')} data-testid={testId}>
          作成
        </Button>
      </SpaceBetween>
    </Container>
  );
  return (
    <SpaceBetween size="l">
      <Header variant="h1">ロードバランサータイプの比較と選択</Header>
      <ColumnLayout columns={3}>
        {card('Application Load Balancer', 'HTTP および HTTPS トラフィックを使用するアプリケーションに柔軟な機能セットが必要な場合は、Application Load Balancer を選択します。リクエストレベル (レイヤー 7) で動作します。', true, 'create-alb')}
        {card('Network Load Balancer', '超高パフォーマンス、大規模な TLS オフロード、UDP のサポートが必要な場合は、Network Load Balancer を選択します。接続レベル (レイヤー 4) で動作します。', false)}
        {card('Gateway Load Balancer', 'GENEVE をサポートするサードパーティー仮想アプライアンスのフリートをデプロイおよび管理する必要がある場合は、Gateway Load Balancer を選択します。', false)}
      </ColumnLayout>
    </SpaceBetween>
  );
}

export function CreateAlb() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [scheme, setScheme] = useState<LoadBalancer['scheme']>('internet-facing');
  const [vpcId, setVpcId] = useState(env.vpcs.find((v) => v.isDefault)?.vpcId ?? env.vpcs[0]?.vpcId ?? '');
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sgIds, setSgIds] = useState<string[]>([]);
  const [port, setPort] = useState('80');
  const [tgArn, setTgArn] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const vpcOpts = env.vpcs.map(vpcOption);
  const subnets = env.subnets.filter((s) => s.vpcId === vpcId);
  const azs = [...new Set(subnets.map((s) => s.availabilityZone))].sort();
  const sgs = env.securityGroups.filter((g) => g.vpcId === vpcId);
  const tgs = env.targetGroups.filter((t) => t.vpcId === vpcId);
  const tgOpts = tgs.map((t) => ({ value: t.targetGroupArn, label: t.targetGroupName, description: `${t.protocol}:${t.port} · ${t.targetType}${lbsForTargetGroup(env, t.targetGroupArn).length ? ' · 別のロードバランサーで使用中' : ''}` }));
  const chosen = Object.values(mapping).filter(Boolean);
  const privateChosen = scheme === 'internet-facing' && chosen.some((s) => !isPublicSubnet(env, s));
  return (
    <EditForm
      title="Application Load Balancer を作成"
      description="Application Load Balancer は、リクエストの属性に基づいて、受信した HTTP および HTTPS トラフィックを Amazon EC2 インスタンスなどの複数のターゲットに分散します。"
      submitText="ロードバランサーの作成"
      submitTestId="create-alb-submit"
      submitHotspotId="alb-submit"
      onCancel={() => navigate('/ec2/load-balancers')}
      error={error}
      onSubmit={() => {
        const r = run(
          (d) => createLoadBalancer(d, { name: name.trim(), scheme, vpcId, subnetIds: chosen, securityGroupIds: sgIds, listeners: tgArn ? [{ port: Number(port), targetGroupArn: tgArn }] : [] }),
          `ロードバランサー ${name} が正常に作成されました。ロードバランサーがトラフィックをルーティングできるようになるまで数分かかる場合があります。`,
        );
        if (r.ok) navigate(`/ec2/load-balancers/${name.trim()}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">基本的な設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="ロードバランサー名" constraintText="ハイフンを含む最大 32 文字の英数字を使用できます。ただし、名前の先頭と末尾にハイフンは使用できません。">
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="名前を入力" data-testid="alb-name" />
          </FormField>
          <FormField label="スキーム" description="ロードバランサーの作成後にスキームを変更することはできません。">
            <RadioGroup
              value={scheme}
              onChange={(e) => setScheme(e.detail.value as LoadBalancer['scheme'])}
              items={[
                { value: 'internet-facing', label: 'インターネット向け', description: 'インターネット向けのトラフィックを処理します。パブリック IP アドレスを持ち、DNS 名はパブリック IP に解決されます。パブリックサブネットが必要です。' },
                { value: 'internal', label: '内部', description: '内部トラフィックを処理します。プライベート IP アドレスを持ち、DNS 名はプライベート IP に解決されます。' },
              ]}
            />
          </FormField>
          <FormField label="ロードバランサーの IP アドレスタイプ">
            <RadioGroup value="ipv4" items={[{ value: 'ipv4', label: 'IPv4', description: 'IPv4 アドレスのみが含まれます。' }]} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="ロードバランサーは、選択したサブネット内のターゲットにトラフィックをルーティングします。">ネットワークマッピング</Header>}>
        <SpaceBetween size="l">
          <FormField label="VPC">
            <Select selectedOption={pick(vpcOpts, vpcId)} options={vpcOpts} onChange={(e) => { setVpcId(e.detail.selectedOption.value!); setMapping({}); setSgIds([]); setTgArn(''); }} data-testid="alb-vpc" />
          </FormField>
          <FormField label="アベイラビリティーゾーンとサブネット" description="少なくとも 2 つのアベイラビリティーゾーンと、ゾーンごとに 1 つのサブネットを選択します。">
            <SpaceBetween size="s">
              {azs.map((az) => {
                const opts = subnets.filter((s) => s.availabilityZone === az).map((s) => ({ value: s.subnetId, label: `${s.subnetId} (${nameOf(s) || '-'})`, description: `${s.cidrBlock}${isPublicSubnet(env, s.subnetId) ? '' : ' · インターネットゲートウェイへのルートなし'}` }));
                const on = az in mapping;
                return (
                  <div key={az} className="az-row" data-testid={`alb-az-${az}`}>
                    <Checkbox checked={on} onChange={(e) => setMapping((m) => { const n = { ...m }; if (e.detail.checked) n[az] = ''; else delete n[az]; return n; })}>{az}</Checkbox>
                    {on && <Select selectedOption={pick(opts, mapping[az])} options={opts} onChange={(e) => setMapping((m) => ({ ...m, [az]: e.detail.selectedOption.value! }))} placeholder="サブネットを選択" data-testid={`alb-subnet-${az}`} />}
                  </div>
                );
              })}
            </SpaceBetween>
          </FormField>
          {privateChosen && (
            <Alert type="warning">選択したサブネットには、インターネットゲートウェイへのルートがありません。これは、ロードバランサーがインターネットトラフィックを受信しないことを意味します。</Alert>
          )}
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="セキュリティグループは、ロードバランサーへのトラフィックを制御するファイアウォールルールのセットです。">セキュリティグループ</Header>}>
        <FormField label="セキュリティグループ">
          <Multiselect selectedOptions={sgs.filter((g) => sgIds.includes(g.groupId)).map(sgOption)} options={sgs.map(sgOption)} onChange={(e) => setSgIds(e.detail.selectedOptions.map((o) => o.value!))} placeholder="最大 5 つのセキュリティグループを選択" data-testid="alb-sgs" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2" description="リスナーは、設定したポートとプロトコルを使用して接続リクエストをチェックするプロセスです。">リスナーとルーティング</Header>}>
        <ColumnLayout columns={3}>
          <FormField label="プロトコル">
            <Select selectedOption={{ value: 'HTTP', label: 'HTTP' }} options={[{ value: 'HTTP', label: 'HTTP' }, { value: 'HTTPS', label: 'HTTPS', disabled: true, description: 'ACM が必要 (後のレッスン)' }]} />
          </FormField>
          <FormField label="ポート">
            <Input value={port} onChange={(e) => setPort(e.detail.value)} type="number" data-testid="alb-port" />
          </FormField>
          <FormField label="デフォルトアクション: 転送先">
            <Select selectedOption={pick(tgOpts, tgArn)} options={tgOpts} onChange={(e) => setTgArn(e.detail.selectedOption.value!)} placeholder="ターゲットグループを選択" empty="この VPC にはターゲットグループがありません" data-testid="alb-tg" />
          </FormField>
        </ColumnLayout>
      </Container>
    </EditForm>
  );
}

function HealthSummary({ env, tg }: { env: AwsEnv; tg: TargetGroup }) {
  const states = tg.targets.map((t) => targetHealth(env, tg.targetGroupArn, t).state);
  const n = (s: string) => states.filter((x) => x === s).length;
  const cell = (text: string, value: number, type: 'success' | 'error' | 'stopped' | 'pending') => (
    <div>
      <Box variant="awsui-key-label">{text}</Box>
      <StatusIndicator type={type}>{value}</StatusIndicator>
    </div>
  );
  return (
    <ColumnLayout columns={6} variant="text-grid">
      <div><Box variant="awsui-key-label">合計ターゲット</Box><Box>{tg.targets.length}</Box></div>
      {cell('正常', n('healthy'), 'success')}
      {cell('異常', n('unhealthy'), 'error')}
      {cell('未使用', n('unused'), 'stopped')}
      {cell('初期', n('initial'), 'pending')}
      {cell('ドレイン中', n('draining'), 'pending')}
    </ColumnLayout>
  );
}

export function LbDetail({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const lb = env.loadBalancers.find((l) => l.loadBalancerName === name);
  if (!lb) return <NotFound what="ロードバランサー" id={name} />;
  const vpc = env.vpcs.find((v) => v.vpcId === lb.vpcId);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<ActionMenu items={[{ id: 'sg', text: 'セキュリティグループを編集', onClick: () => navigate(`${lbPath(lb)}/edit-security-groups`) }]} />}>{lb.loadBalancerName}</Header>
      <ResourceDetail
        fields={[
          { label: 'ロードバランサーのタイプ', value: 'Application' },
          { label: 'ステータス', value: <ResourceStatus state={lb.state} /> },
          { label: 'VPC', value: <ConsoleLink to={`/vpc/vpcs/${lb.vpcId}`}>{label(lb.vpcId, vpc)}</ConsoleLink> },
          { label: 'ロードバランサーの IP アドレスタイプ', value: 'IPv4' },
          { label: 'スキーム', value: lb.scheme === 'internet-facing' ? 'Internet-facing' : 'Internal' },
          { label: 'ホストゾーン', value: HOSTED_ZONE[env.region] ?? 'Z1LMS91P8CMLE5' },
          {
            label: 'アベイラビリティーゾーン',
            value: (
              <SpaceBetween size="xxs">
                {lb.subnetIds.map((s) => {
                  const sub = env.subnets.find((x) => x.subnetId === s);
                  return <ConsoleLink key={s} to={`/vpc/subnets/${s}`}>{`${label(s, sub)} ${sub?.availabilityZone}`}</ConsoleLink>;
                })}
              </SpaceBetween>
            ),
          },
          { label: '作成日', value: formatDate(lb.createdTime) },
          { label: 'ロードバランサー ARN', value: <CopyableValue value={lb.loadBalancerArn} /> },
          { label: 'DNS 名', value: <CopyableValue value={lb.dnsName} display={<>{lb.dnsName} (A レコード)</>} testId="lb-dns" /> },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'listeners',
            label: 'リスナーとルール',
            content: (
              <Table
                variant="container"
                data-testid="listeners"
                header={<Header counter={`(${lb.listeners.length})`}>リスナーとルール</Header>}
                items={lb.listeners}
                empty={<Box textAlign="center" color="inherit">リスナーがありません</Box>}
                columnDefinitions={[
                  { id: 'pp', header: 'プロトコル:ポート', cell: (l) => `${l.protocol}:${l.port}` },
                  {
                    id: 'action',
                    header: 'デフォルトアクション',
                    cell: (l) => {
                      const tg = env.targetGroups.find((t) => t.targetGroupArn === l.targetGroupArn);
                      return (
                        <SpaceBetween size="xxxs">
                          <span>ターゲットグループへの転送</span>
                          {tg && <ConsoleLink to={tgPath(tg)}>{`${tg.targetGroupName}: 1 (100%)`}</ConsoleLink>}
                        </SpaceBetween>
                      );
                    },
                  },
                  { id: 'rules', header: 'ルール', cell: () => '1 個のルール' },
                  { id: 'arn', header: 'ARN', cell: (l) => <CopyableValue value={l.listenerArn} display="リスナー ARN" /> },
                ]}
              />
            ),
          },
          {
            id: 'network',
            label: 'ネットワークマッピング',
            content: (
              <Table
                variant="container"
                header={<Header description={`VPC: ${label(lb.vpcId, vpc)}`}>マッピング</Header>}
                items={lb.subnetIds}
                columnDefinitions={[
                  { id: 'az', header: 'ゾーン', cell: (s) => env.subnets.find((x) => x.subnetId === s)?.availabilityZone },
                  { id: 'sub', header: 'サブネット', cell: (s) => <ConsoleLink to={`/vpc/subnets/${s}`}>{label(s, env.subnets.find((x) => x.subnetId === s))}</ConsoleLink> },
                  { id: 'ip', header: 'プライベート IPv4 アドレス', cell: (s) => lb.nodeIps[s] },
                  { id: 'pub', header: 'IPv4 アドレス', cell: () => (lb.scheme === 'internet-facing' ? 'AWS によって割り当て済み' : '-') },
                ]}
              />
            ),
          },
          {
            id: 'security',
            label: 'セキュリティ',
            content: (
              <Table
                variant="container"
                data-testid="lb-security-groups"
                header={<Header counter={`(${lb.securityGroupIds.length})`} actions={<Button onClick={() => navigate(`${lbPath(lb)}/edit-security-groups`)}>編集</Button>}>セキュリティグループ</Header>}
                items={env.securityGroups.filter((g) => lb.securityGroupIds.includes(g.groupId))}
                columnDefinitions={[
                  { id: 'id', header: 'セキュリティグループ ID', cell: (g) => <SpaceBetween direction="horizontal" size="xs"><ConsoleLink to={`/ec2/security-groups/${g.groupId}`}>{g.groupId}</ConsoleLink><CopyableValue value={g.groupId} iconOnly testId="lb-sg-copy" /></SpaceBetween> },
                  { id: 'name', header: '名前', cell: (g) => g.groupName },
                  { id: 'desc', header: '説明', cell: (g) => g.description },
                ]}
              />
            ),
          },
          { id: 'monitoring', label: 'モニタリング', content: <MonitoringCharts columns={3} metrics={['TargetResponseTime', 'RequestCount', 'HTTPCode_Target_5XX_Count'].map((m) => metricFor('AWS/ApplicationELB', m, lbDimension(lb)))} /> },
        ]}
      />
    </SpaceBetween>
  );
}

export function EditLbSecurityGroups({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const lb = env.loadBalancers.find((l) => l.loadBalancerName === name);
  const [ids, setIds] = useState<string[]>(lb?.securityGroupIds ?? []);
  const [error, setError] = useState<AwsError | null>(null);
  if (!lb) return <NotFound what="ロードバランサー" id={name} />;
  const sgs = env.securityGroups.filter((g) => g.vpcId === lb.vpcId);
  return (
    <EditForm
      title="セキュリティグループを編集"
      submitText="変更を保存"
      onCancel={() => navigate(`${lbPath(lb)}?tab=security`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => setLoadBalancerSecurityGroups(d, lb.loadBalancerArn, ids), `${name} のセキュリティグループが正常に更新されました`);
        if (r.ok) navigate(`${lbPath(lb)}?tab=security`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">セキュリティグループ</Header>}>
        <Multiselect selectedOptions={sgs.filter((g) => ids.includes(g.groupId)).map(sgOption)} options={sgs.map(sgOption)} onChange={(e) => setIds(e.detail.selectedOptions.map((o) => o.value!))} />
      </Container>
    </EditForm>
  );
}

// ---------------- target groups ----------------

export function TgList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.targetGroups, (t) => t.targetGroupArn);
  return (
    <ResourceTable
      title="ターゲットグループ"
      resourceName="ターゲットグループ"
      testId="tg-table"
      items={env.targetGroups}
      trackBy={(t) => t.targetGroupArn}
      selectedItems={sel}
      onSelectionChange={setSel}
      columns={[
        { id: 'name', header: '名前', cell: (t) => <ConsoleLink to={tgPath(t)}>{t.targetGroupName}</ConsoleLink>, value: (t) => t.targetGroupName },
        { id: 'arn', header: 'ARN', cell: (t) => <CopyableValue value={t.targetGroupArn} display={t.targetGroupArn.split(':').pop()} /> },
        { id: 'port', header: 'ポート', cell: (t) => t.port, value: (t) => t.port },
        { id: 'protocol', header: 'プロトコル', cell: (t) => t.protocol },
        { id: 'type', header: 'ターゲットタイプ', cell: () => 'インスタンス' },
        { id: 'lb', header: 'ロードバランサー', cell: (t) => { const lb = lbsForTargetGroup(env, t.targetGroupArn)[0]; return lb ? <ConsoleLink to={lbPath(lb)}>{lb.loadBalancerName}</ConsoleLink> : '関連付けなし'; }, value: (t) => lbsForTargetGroup(env, t.targetGroupArn)[0]?.loadBalancerName ?? '' },
        { id: 'vpc', header: 'VPC ID', cell: (t) => <ConsoleLink to={`/vpc/vpcs/${t.vpcId}`}>{t.vpcId}</ConsoleLink>, value: (t) => t.vpcId },
      ]}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu
            items={[
              { id: 'reg', text: 'ターゲットを登録', disabled: sel.length !== 1, onClick: () => navigate(`${tgPath(sel[0])}/register-targets`) },
              { id: 'hc', text: 'ヘルスチェック設定を編集', disabled: sel.length !== 1, onClick: () => navigate(`${tgPath(sel[0])}/edit-health-check`) },
            ]}
          />
          <Button variant="primary" onClick={() => navigate('/ec2/target-groups/create')} data-testid="create-tg">ターゲットグループの作成</Button>
        </SpaceBetween>
      }
    />
  );
}

function hcFields(hc: HealthCheck) {
  return [
    { label: 'プロトコル', value: hc.protocol },
    { label: 'パス', value: hc.path },
    { label: 'ポート', value: hc.port === 'traffic-port' ? 'トラフィックポート' : String(hc.port) },
    { label: '正常のしきい値', value: `${hc.healthyThresholdCount} 回連続のヘルスチェック成功` },
    { label: '非正常のしきい値', value: `${hc.unhealthyThresholdCount} 回連続のヘルスチェック失敗` },
    { label: 'タイムアウト', value: `${hc.timeoutSeconds} 秒` },
    { label: '間隔', value: `${hc.intervalSeconds} 秒` },
    { label: '成功コード', value: hc.matcher },
  ];
}

export function TgDetail({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const tg = env.targetGroups.find((t) => t.targetGroupName === name);
  const [sel, setSel] = useState<string[]>([]);
  if (!tg) return <NotFound what="ターゲットグループ" id={name} />;
  const lb = lbsForTargetGroup(env, tg.targetGroupArn)[0];
  const key = (t: RegisteredTarget) => `${t.id}:${t.port}`;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<ActionMenu items={[{ id: 'reg', text: 'ターゲットを登録', onClick: () => navigate(`${tgPath(tg)}/register-targets`) }, { id: 'hc', text: 'ヘルスチェック設定を編集', onClick: () => navigate(`${tgPath(tg)}/edit-health-check`) }]} />}>
        {tg.targetGroupName}
      </Header>
      <ResourceDetail
        fields={[
          { label: 'ターゲットタイプ', value: 'インスタンス' },
          { label: 'プロトコル : ポート', value: `${tg.protocol}: ${tg.port}` },
          { label: 'プロトコルバージョン', value: tg.protocolVersion },
          { label: 'VPC', value: <ConsoleLink to={`/vpc/vpcs/${tg.vpcId}`}>{label(tg.vpcId, env.vpcs.find((v) => v.vpcId === tg.vpcId))}</ConsoleLink> },
          { label: 'IP アドレスタイプ', value: 'IPv4' },
          { label: 'ロードバランサー', value: lb ? <ConsoleLink to={lbPath(lb)}>{lb.loadBalancerName}</ConsoleLink> : '関連付けなし' },
          { label: 'ARN', value: <CopyableValue value={tg.targetGroupArn} /> },
        ]}
      />
      <Container>
        <HealthSummary env={env} tg={tg} />
      </Container>
      <ResourceTabs
        tabs={[
          {
            id: 'targets',
            label: 'ターゲット',
            content: (
              <div data-testid="registered-targets">
                <Table<RegisteredTarget>
                  variant="container"
                  header={
                    <Header
                      counter={`(${tg.targets.length})`}
                      description="ヘルスチェックはロードバランサーのすべてのノードから実行されます。"
                      actions={
                        <SpaceBetween direction="horizontal" size="xs">
                          <Button disabled={!sel.length} onClick={() => { run((d) => deregisterTargets(d, tg.targetGroupArn, tg.targets.filter((t) => sel.includes(key(t)))), `${name} から ${sel.length} 個のターゲットの登録を正常に解除しました`); setSel([]); }} data-testid="deregister">
                            登録解除
                          </Button>
                          <Hotspot hotspotId="tg-register" direction="right">
                            <Button onClick={() => navigate(`${tgPath(tg)}/register-targets`)} data-testid="register-targets">ターゲットの登録</Button>
                          </Hotspot>
                        </SpaceBetween>
                      }
                    >
                      登録済みターゲット
                    </Header>
                  }
                  items={tg.targets}
                  trackBy={key}
                  selectionType="multi"
                  selectedItems={tg.targets.filter((t) => sel.includes(key(t)))}
                  onSelectionChange={(e) => setSel(e.detail.selectedItems.map(key))}
                  ariaLabels={{ itemSelectionLabel: (_, t) => `${key(t)} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: 'ターゲット' }}
                  empty={<Box textAlign="center" color="inherit"><b>ターゲットがありません</b><Box color="inherit">このターゲットグループに登録されているターゲットはありません。</Box></Box>}
                  columnDefinitions={[
                    {
                      id: 'id',
                      header: tg.targetType === 'ip' ? 'IP アドレス' : 'インスタンス ID',
                      cell: (t) => {
                        const b = backendOf(env, tg, t);
                        // IP targets are ECS tasks (Fargate): link to the task, not to an EC2 instance
                        if (tg.targetType !== 'ip') return <ConsoleLink to={`/ec2/instances/${t.id}`}>{t.id}</ConsoleLink>;
                        const task = b && env.ecsTasks.find((x) => x.taskArn === b.id);
                        return task ? <ConsoleLink to={`/ecs/clusters/${task.clusterArn.split('/').pop()}/tasks/${taskId(task)}`}>{t.id}</ConsoleLink> : t.id;
                      },
                    },
                    { id: 'name', header: '名前', cell: (t) => (tg.targetType === 'ip' ? backendOf(env, tg, t)?.name : nameOf(env.instances.find((i) => i.instanceId === t.id) ?? { tags: [] })) || '-' },
                    { id: 'port', header: 'ポート', cell: (t) => t.port },
                    { id: 'zone', header: 'ゾーン', cell: (t) => backendOf(env, tg, t)?.availabilityZone ?? '-' },
                    { id: 'health', header: 'ヘルスステータス', cell: (t) => <ResourceStatus state={targetHealth(env, tg.targetGroupArn, t).state} /> },
                    { id: 'details', header: 'ヘルスステータスの詳細', cell: (t) => { const h = targetHealth(env, tg.targetGroupArn, t); return h.description ? `${h.description}` : '-'; } },
                  ]}
                />
              </div>
            ),
          },
          {
            id: 'health-checks',
            label: 'ヘルスチェック',
            content: (
              <ResourceDetail
                title="ヘルスチェックの設定"
                fields={hcFields(tg.healthCheck)}
                actions={
                  <Hotspot hotspotId="tg-edit-health" direction="right">
                    <Button onClick={() => navigate(`${tgPath(tg)}/edit-health-check`)} data-testid="edit-health-check">編集</Button>
                  </Hotspot>
                }
              />
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

/** "Available instances" + "Ports for the selected instances" + "Include as pending below" — the real register flow. */
function TargetPicker({ env, vpcId, defaultPort, pending, onPending }: { env: AwsEnv; vpcId: string; defaultPort: number; pending: RegisteredTarget[]; onPending: (p: RegisteredTarget[]) => void }) {
  const instances = env.instances.filter((i) => i.vpcId === vpcId && i.state !== 'terminated');
  const [sel, setSel] = useState<Instance[]>([]);
  const [port, setPort] = useState(String(defaultPort));
  return (
    <SpaceBetween size="l">
      <Table<Instance>
        variant="container"
        header={<Header counter={`(${instances.length})`}>使用可能なインスタンス</Header>}
        items={instances}
        trackBy="instanceId"
        selectionType="multi"
        selectedItems={sel}
        onSelectionChange={(e) => setSel(e.detail.selectedItems)}
        ariaLabels={{ itemSelectionLabel: (_, i) => `${nameOf(i) || i.instanceId} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: 'インスタンス' }}
        columnDefinitions={[
          { id: 'id', header: 'インスタンス ID', cell: (i) => i.instanceId },
          { id: 'name', header: '名前', cell: nameCell },
          { id: 'state', header: '状態', cell: (i) => <ResourceStatus state={i.state} /> },
          { id: 'sg', header: 'セキュリティグループ', cell: (i) => i.securityGroupIds.map((g) => env.securityGroups.find((x) => x.groupId === g)?.groupName).join(', ') },
          { id: 'zone', header: 'ゾーン', cell: (i) => i.availabilityZone },
          { id: 'subnet', header: 'サブネット ID', cell: (i) => i.subnetId },
        ]}
      />
      <SpaceBetween direction="horizontal" size="s" alignItems="end">
        <FormField label="選択したインスタンスのポート" description="選択したインスタンスにトラフィックをルーティングするためのポート。">
          <Input value={port} onChange={(e) => setPort(e.detail.value)} type="number" data-testid="target-port" />
        </FormField>
        <Hotspot hotspotId="tg-include-pending" direction="right">
          <Button
            formAction="none"
            disabled={!sel.length}
            data-testid="include-pending"
            onClick={() => {
              const add = sel.map((i) => ({ id: i.instanceId, port: Number(port) })).filter((t) => !pending.some((p) => p.id === t.id && p.port === t.port));
              onPending([...pending, ...add]);
              setSel([]);
            }}
          >
            保留中として以下を含める
          </Button>
        </Hotspot>
      </SpaceBetween>
      <Table<RegisteredTarget>
        variant="container"
        data-testid="pending-targets"
        header={<Header counter={`(${pending.length})`}>ターゲットを確認</Header>}
        items={pending}
        empty={<Box textAlign="center" color="inherit">まだインスタンスが追加されていません。上でインスタンスを指定するか、後でターゲットを追加する場合はグループを空のままにします。</Box>}
        columnDefinitions={[
          { id: 'id', header: 'インスタンス ID', cell: (t) => t.id },
          { id: 'name', header: '名前', cell: (t) => nameOf(env.instances.find((i) => i.instanceId === t.id) ?? { tags: [] }) || '-' },
          { id: 'port', header: 'ポート', cell: (t) => t.port },
          { id: 'remove', header: '', cell: (t) => <Button variant="inline-link" formAction="none" onClick={() => onPending(pending.filter((p) => p !== t))}>削除</Button> },
        ]}
      />
    </SpaceBetween>
  );
}

export function RegisterTargets({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const tg = env.targetGroups.find((t) => t.targetGroupName === name);
  const [pending, setPending] = useState<RegisteredTarget[]>([]);
  const [error, setError] = useState<AwsError | null>(null);
  if (!tg) return <NotFound what="ターゲットグループ" id={name} />;
  return (
    <EditForm
      title="ターゲットを登録"
      description="これはターゲットグループを作成するためのオプションのステップです。ただし、ロードバランサーがこのターゲットグループにトラフィックをルーティングするには、ターゲットを登録する必要があります。"
      submitText="保留中のターゲットを登録"
      submitTestId="register-pending"
      submitHotspotId="tg-register-submit"
      submitDisabled={!pending.length}
      onCancel={() => navigate(`${tgPath(tg)}?tab=targets`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => registerTargets(d, tg.targetGroupArn, pending), `ターゲットグループ ${name} に ${pending.length} 個のターゲットを正常に登録しました`);
        if (r.ok) navigate(`${tgPath(tg)}?tab=targets`);
        else setError(r.error);
      }}
    >
      <TargetPicker env={env} vpcId={tg.vpcId} defaultPort={tg.port} pending={pending} onPending={setPending} />
    </EditForm>
  );
}

function HealthCheckForm({ hc, onChange, trafficPort }: { hc: HealthCheck; onChange: (hc: HealthCheck) => void; trafficPort: number }) {
  const set = (p: Partial<HealthCheck>) => onChange({ ...hc, ...p });
  const num = (v: string) => Math.max(0, Number(v) || 0);
  return (
    <SpaceBetween size="l">
      <FormField label="ヘルスチェックプロトコル">
        <Select selectedOption={{ value: 'HTTP', label: 'HTTP' }} options={[{ value: 'HTTP', label: 'HTTP' }]} />
      </FormField>
      <FormField label="ヘルスチェックパス" description="デフォルトのパス '/' を使用してルートでヘルスチェックを実行するか、必要に応じてカスタムパスを指定します。" constraintText="最大 1024 文字を使用できます。">
        <Input value={hc.path} onChange={(e) => set({ path: e.detail.value })} data-testid="hc-path" />
      </FormField>
      <ExpandableSection headerText="ヘルスチェックの詳細設定" defaultExpanded={hc.port !== 'traffic-port'} data-testid="hc-advanced">
        <SpaceBetween size="l">
          <FormField label="ヘルスチェックポート" description="ロードバランサーがターゲットでヘルスチェックを実行するときに使用するポート。">
            <RadioGroup
              value={hc.port === 'traffic-port' ? 'traffic' : 'override'}
              onChange={(e) => set({ port: e.detail.value === 'traffic' ? 'traffic-port' : trafficPort })}
              items={[{ value: 'traffic', label: 'トラフィックポート', description: 'ロードバランサーからトラフィックを受信する各ターゲットのポート。' }, { value: 'override', label: '上書き' }]}
            />
          </FormField>
          {hc.port !== 'traffic-port' && <Input value={String(hc.port)} type="number" onChange={(e) => set({ port: num(e.detail.value) })} data-testid="hc-port" />}
          <ColumnLayout columns={2}>
            <FormField label="正常のしきい値"><Input value={String(hc.healthyThresholdCount)} type="number" onChange={(e) => set({ healthyThresholdCount: num(e.detail.value) })} /></FormField>
            <FormField label="非正常のしきい値"><Input value={String(hc.unhealthyThresholdCount)} type="number" onChange={(e) => set({ unhealthyThresholdCount: num(e.detail.value) })} /></FormField>
            <FormField label="タイムアウト (秒)"><Input value={String(hc.timeoutSeconds)} type="number" onChange={(e) => set({ timeoutSeconds: num(e.detail.value) })} /></FormField>
            <FormField label="間隔 (秒)"><Input value={String(hc.intervalSeconds)} type="number" onChange={(e) => set({ intervalSeconds: num(e.detail.value) })} /></FormField>
          </ColumnLayout>
          <FormField label="成功コード" description="ターゲットからの正常な応答を確認するときに使用する HTTP コード。複数の値 (例: &quot;200,202&quot;) または値の範囲 (例: &quot;200-299&quot;) を指定できます。">
            <Input value={hc.matcher} onChange={(e) => set({ matcher: e.detail.value })} data-testid="hc-matcher" />
          </FormField>
        </SpaceBetween>
      </ExpandableSection>
    </SpaceBetween>
  );
}

export function EditHealthCheck({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const tg = env.targetGroups.find((t) => t.targetGroupName === name);
  const [hc, setHc] = useState<HealthCheck>(tg?.healthCheck ?? DEFAULT_HEALTH_CHECK);
  const [error, setError] = useState<AwsError | null>(null);
  if (!tg) return <NotFound what="ターゲットグループ" id={name} />;
  return (
    <EditForm
      title="ヘルスチェック設定を編集"
      submitText="変更を保存"
      submitTestId="save-health-check"
      submitHotspotId="tg-save-health"
      onCancel={() => navigate(`${tgPath(tg)}?tab=health-checks`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => modifyTargetGroupHealthCheck(d, tg.targetGroupArn, hc), `${name} のヘルスチェック設定が正常に更新されました`);
        if (r.ok) navigate(`${tgPath(tg)}?tab=health-checks`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2" description="関連付けられたロードバランサーは、以下の設定に従って、登録済みターゲットに定期的にリクエストを送信し、ステータスをテストします。">ヘルスチェックの設定</Header>}>
        <HealthCheckForm hc={hc} onChange={setHc} trafficPort={tg.port} />
      </Container>
    </EditForm>
  );
}

export function CreateTargetGroup() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [port, setPort] = useState('80');
  const [vpcId, setVpcId] = useState(env.vpcs.find((v) => !v.isDefault)?.vpcId ?? env.vpcs[0]?.vpcId ?? '');
  const [hc, setHc] = useState<HealthCheck>(DEFAULT_HEALTH_CHECK);
  const [pending, setPending] = useState<RegisteredTarget[]>([]);
  const [error, setError] = useState<AwsError | null>(null);
  const vpcOpts = env.vpcs.map(vpcOption);
  return (
    <div data-testid="create-tg-wizard">
      <Wizard
        activeStepIndex={step}
        onNavigate={(e) => {
          setError(null);
          setStep(e.detail.requestedStepIndex);
        }}
        onCancel={() => navigate('/ec2/target-groups')}
        onSubmit={() => {
          const r = run(
            (d) => {
              const arn = createTargetGroup(d, { name: name.trim(), port: Number(port), vpcId, healthCheck: hc });
              if (pending.length) registerTargets(d, arn, pending);
              return arn;
            },
            `ターゲットグループ ${name} が正常に作成されました`,
          );
          if (r.ok) navigate(`/ec2/target-groups/${name.trim()}`);
          else setError(r.error);
        }}
        i18nStrings={{ stepNumberLabel: (n) => `ステップ ${n}`, collapsedStepsLabel: (n, t) => `ステップ ${n}/${t}`, navigationAriaLabel: 'ステップ', cancelButton: 'キャンセル', previousButton: '前へ', nextButton: '次へ', submitButton: 'ターゲットグループの作成', optional: 'オプション' }}
        steps={[
          {
            title: 'グループの詳細の指定',
            description: 'ロードバランサーは、ターゲットグループ内のターゲットにリクエストをルーティングし、ターゲットに対してヘルスチェックを実行します。',
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">基本的な設定</Header>}>
                  <SpaceBetween size="l">
                    <FormField label="ターゲットタイプの選択">
                      <Tiles
                        value="instance"
                        columns={2}
                        items={[
                          { value: 'instance', label: 'インスタンス', description: '特定の VPC 内のインスタンスへの負荷分散をサポートします。' },
                          { value: 'ip', label: 'IP アドレス', description: 'このシミュレーターでは未提供', disabled: true },
                          { value: 'lambda', label: 'Lambda 関数', description: 'このシミュレーターでは未提供', disabled: true },
                          { value: 'alb', label: 'Application Load Balancer', description: 'このシミュレーターでは未提供', disabled: true },
                        ]}
                      />
                    </FormField>
                    <FormField label="ターゲットグループ名" constraintText="ハイフンを含む最大 32 文字の英数字を使用できます。ただし、名前の先頭と末尾にハイフンは使用できません。">
                      <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="ターゲットグループ名を入力" data-testid="tg-name" />
                    </FormField>
                    <ColumnLayout columns={2}>
                      <FormField label="プロトコル">
                        <Select selectedOption={{ value: 'HTTP', label: 'HTTP' }} options={[{ value: 'HTTP', label: 'HTTP' }]} />
                      </FormField>
                      <FormField label="ポート">
                        <Input value={port} onChange={(e) => setPort(e.detail.value)} type="number" data-testid="tg-port" />
                      </FormField>
                    </ColumnLayout>
                    <FormField label="VPC" description="ターゲットグループに含めるインスタンスがある VPC を選択します。">
                      <Select selectedOption={pick(vpcOpts, vpcId)} options={vpcOpts} onChange={(e) => { setVpcId(e.detail.selectedOption.value!); setPending([]); }} data-testid="tg-vpc" />
                    </FormField>
                    <FormField label="プロトコルバージョン">
                      <RadioGroup value="HTTP1" items={[{ value: 'HTTP1', label: 'HTTP1', description: 'HTTP/1.1 を使用してターゲットにリクエストを送信します。' }]} />
                    </FormField>
                  </SpaceBetween>
                </Container>
                <Container header={<Header variant="h2">ヘルスチェック</Header>}>
                  <HealthCheckForm hc={hc} onChange={setHc} trafficPort={Number(port)} />
                </Container>
              </SpaceBetween>
            ),
          },
          {
            title: 'ターゲットの登録',
            content: (
              <SpaceBetween size="l">
                {error && <Alert type="error">{errorText(error)}</Alert>}
                <TargetPicker env={env} vpcId={vpcId} defaultPort={Number(port)} pending={pending} onPending={setPending} />
              </SpaceBetween>
            ),
          },
        ]}
      />
    </div>
  );
}
