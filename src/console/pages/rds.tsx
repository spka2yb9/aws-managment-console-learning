import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Multiselect from '@cloudscape-design/components/multiselect';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Table from '@cloudscape-design/components/table';
import Tiles from '@cloudscape-design/components/tiles';
import { useState } from 'react';
import { getMetricData, metricFor } from '../../sim/cloudwatch';
import { label, nameOf, regionOf } from '../../sim/env';
import { createDbInstance, createDbSubnetGroup, DB_ENGINES, DB_INSTANCE_CLASSES, modifyDbInstance, startDbInstance, stopDbInstance } from '../../sim/rds';
import { portRangeLabel, protocolLabel, ruleTypeOf, sourceOf } from '../../sim/sg';
import type { AwsError, DbEngine, DbInstance } from '../../sim/types';
import { pick, sgOption, vpcOption } from '../options';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, EditForm, formatDate, NotFound, ResourceDetail, ResourceStatus, ResourceTable, ResourceTabs, useEnv, useNavigate, useSelection } from '../ui';
import { MonitoringCharts, useNow } from './cloudwatch';
import { BackupTab } from './rds-backup';
import { Tags } from './vpc';

const engineLabel = (db: DbInstance) => (db.engine === 'mysql' ? 'MySQL Community' : 'PostgreSQL');
const dbPath = (id: string) => `/rds/databases/${id}`;
/** RDS shows "利用可能" where VPC resources show "Available". */
const dbState = (s: string) => (s === 'available' ? 'db-available' : s);

export function RdsDashboard() {
  const env = useEnv();
  const navigate = useNavigate();
  return (
    <SpaceBetween size="l">
      <Header variant="h1">ダッシュボード</Header>
      <Container header={<Header variant="h2">リソース</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">DB インスタンス</Box><ConsoleLink to="/rds/databases">{`${env.dbInstances.length}/40`}</ConsoleLink></div>
          <div><Box variant="awsui-key-label">サブネットグループ</Box><ConsoleLink to="/rds/subnet-groups">{String(env.dbSubnetGroups.length)}</ConsoleLink></div>
          <div><Box variant="awsui-key-label">割り当て済みストレージ</Box><Box>{env.dbInstances.reduce((n, d) => n + d.allocatedStorage, 0)} GB</Box></div>
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">データベースの作成</Header>}>
        <SpaceBetween size="s">
          <Box>Amazon Relational Database Service (RDS) を使用すると、クラウドでリレーショナルデータベースを簡単にセットアップ、運用、スケーリングできます。</Box>
          <Button variant="primary" onClick={() => navigate('/rds/create')}>データベースの作成</Button>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

function useDbActions(db: DbInstance | undefined) {
  const run = useConsole((s) => s.run);
  const navigate = useNavigate();
  return [
    { id: 'modify', text: '変更', disabled: db?.status !== 'available', onClick: () => navigate(`${dbPath(db!.dbInstanceIdentifier)}/modify`) },
    { id: 'snapshot', text: 'スナップショットの取得', disabled: db?.status !== 'available', onClick: () => navigate(`/rds/snapshots/take?${new URLSearchParams({ db: db!.dbInstanceIdentifier })}`) },
    { id: 'pitr', text: '特定時点への復元', disabled: !db || db.backupRetentionPeriod <= 0, onClick: () => navigate(`${dbPath(db!.dbInstanceIdentifier)}/pitr`) },
    { id: 'stop', text: '一時的に停止', disabled: db?.status !== 'available', onClick: () => run((d) => stopDbInstance(d, db!.dbInstanceIdentifier), `DB インスタンス ${db!.dbInstanceIdentifier} を停止しています`) },
    { id: 'start', text: '開始', disabled: db?.status !== 'stopped', onClick: () => run((d) => startDbInstance(d, db!.dbInstanceIdentifier), `DB インスタンス ${db!.dbInstanceIdentifier} を開始しています`) },
  ];
}

export function DbList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.dbInstances, (d) => d.dbInstanceIdentifier);
  const actions = useDbActions(sel[0]);
  return (
    <ResourceTable
      title="データベース"
      resourceName="データベース"
      testId="db-table"
      items={env.dbInstances}
      trackBy={(d) => d.dbInstanceIdentifier}
      selectedItems={sel}
      onSelectionChange={setSel}
      columns={[
        { id: 'id', header: 'DB 識別子', cell: (d) => <ConsoleLink to={dbPath(d.dbInstanceIdentifier)}>{d.dbInstanceIdentifier}</ConsoleLink>, value: (d) => d.dbInstanceIdentifier },
        { id: 'status', header: 'ステータス', cell: (d) => <ResourceStatus state={dbState(d.status)} />, value: (d) => d.status },
        { id: 'role', header: 'ロール', cell: () => 'インスタンス' },
        { id: 'engine', header: 'エンジン', cell: engineLabel, value: engineLabel },
        { id: 'az', header: 'リージョンと AZ', cell: (d) => d.availabilityZone, value: (d) => d.availabilityZone },
        { id: 'size', header: 'サイズ', cell: (d) => d.dbInstanceClass, value: (d) => d.dbInstanceClass },
        { id: 'vpc', header: 'VPC', cell: (d) => { const g = env.dbSubnetGroups.find((x) => x.dbSubnetGroupName === d.dbSubnetGroupName); return g ? <ConsoleLink to={`/vpc/vpcs/${g.vpcId}`}>{g.vpcId}</ConsoleLink> : '-'; } },
        { id: 'multiaz', header: 'マルチ AZ', cell: (d) => (d.multiAZ ? 'はい' : 'いいえ') },
      ]}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button disabled={sel.length !== 1 || sel[0].status !== 'available'} onClick={() => navigate(`${dbPath(sel[0].dbInstanceIdentifier)}/modify`)}>変更</Button>
          <ActionMenu items={actions.slice(1)} />
          <Hotspot hotspotId="rds-create" direction="right">
            <Button variant="primary" onClick={() => navigate('/rds/create')} data-testid="create-database">データベースの作成</Button>
          </Hotspot>
        </SpaceBetween>
      }
    />
  );
}

function ConnectivityTab({ db }: { db: DbInstance }) {
  const env = useEnv();
  const group = env.dbSubnetGroups.find((g) => g.dbSubnetGroupName === db.dbSubnetGroupName);
  const sgs = env.securityGroups.filter((g) => db.vpcSecurityGroupIds.includes(g.groupId));
  const rules = sgs.flatMap((g) => [...g.ingress.map((r) => ({ g, r, dir: 'インバウンド' })), ...g.egress.map((r) => ({ g, r, dir: 'アウトバウンド' }))]).map((x) => ({ ...x, dir: `${x.r.referencedGroupId ? 'EC2 セキュリティグループ' : 'CIDR/IP'} - ${x.dir}` }));
  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">接続とセキュリティ</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <SpaceBetween size="m">
            <Box variant="h3">エンドポイントとポート</Box>
            <div><Box variant="awsui-key-label">エンドポイント</Box><CopyableValue value={db.status === 'creating' ? '' : db.endpointAddress} testId="db-endpoint" /></div>
            <div><Box variant="awsui-key-label">ポート</Box><Box>{db.port}</Box></div>
          </SpaceBetween>
          <SpaceBetween size="m">
            <Box variant="h3">ネットワーキング</Box>
            <div><Box variant="awsui-key-label">アベイラビリティーゾーン</Box><Box>{db.availabilityZone}</Box></div>
            <div><Box variant="awsui-key-label">VPC</Box>{group ? <ConsoleLink to={`/vpc/vpcs/${group.vpcId}`}>{label(group.vpcId, env.vpcs.find((v) => v.vpcId === group.vpcId))}</ConsoleLink> : '-'}</div>
            <div><Box variant="awsui-key-label">サブネットグループ</Box><ConsoleLink to={`/rds/subnet-groups/${db.dbSubnetGroupName}`}>{db.dbSubnetGroupName}</ConsoleLink></div>
            <div>
              <Box variant="awsui-key-label">サブネット</Box>
              <SpaceBetween size="xxxs">{group?.subnetIds.map((s) => <ConsoleLink key={s} to={`/vpc/subnets/${s}`}>{s}</ConsoleLink>)}</SpaceBetween>
            </div>
            <div><Box variant="awsui-key-label">ネットワークタイプ</Box><Box>IPv4</Box></div>
          </SpaceBetween>
          <SpaceBetween size="m">
            <Box variant="h3">セキュリティ</Box>
            <div data-testid="db-security-groups">
              <Box variant="awsui-key-label">VPC セキュリティグループ</Box>
              <SpaceBetween size="xxxs">
                {sgs.map((g) => (
                  <Box key={g.groupId}>
                    <ConsoleLink to={`/ec2/security-groups/${g.groupId}`}>{`${g.groupName} (${g.groupId})`}</ConsoleLink> <Box variant="small" color="text-status-success">アクティブ</Box>
                  </Box>
                ))}
              </SpaceBetween>
            </div>
            <div><Box variant="awsui-key-label">パブリックアクセス可能</Box><Box>{db.publiclyAccessible ? 'はい' : 'いいえ'}</Box></div>
            <div><Box variant="awsui-key-label">認証機関</Box><Box>rds-ca-rsa2048-g1</Box></div>
          </SpaceBetween>
        </ColumnLayout>
      </Container>
      <div data-testid="db-sg-rules">
        <Table
          variant="container"
          header={<Header counter={`(${rules.length})`}>セキュリティグループのルール</Header>}
          items={rules}
          columnDefinitions={[
            { id: 'sg', header: 'セキュリティグループ', cell: (x) => <ConsoleLink to={`/ec2/security-groups/${x.g.groupId}`}>{`${x.g.groupName} (${x.g.groupId})`}</ConsoleLink> },
            { id: 'type', header: 'タイプ', cell: (x) => x.dir },
            { id: 'proto', header: 'プロトコル / ポート', cell: (x) => `${ruleTypeOf(x.r).label} · ${protocolLabel(x.r.ipProtocol)} ${portRangeLabel(x.r)}` },
            { id: 'rule', header: 'ルール', cell: (x) => { const src = sourceOf(x.r); const ref = env.securityGroups.find((g) => g.groupId === src); return ref ? `${src} (${ref.groupName})` : src; } },
          ]}
        />
      </div>
    </SpaceBetween>
  );
}

export function DbDetail({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const now = useNow();
  const db = env.dbInstances.find((d) => d.dbInstanceIdentifier === id);
  const actions = useDbActions(db);
  if (!db) return <NotFound what="DB インスタンス" id={id} />;
  const cls = DB_INSTANCE_CLASSES.find((c) => c.cls === db.dbInstanceClass);
  const up = ['available', 'backing-up', 'modifying', 'renaming'].includes(db.status);
  const latest = (metric: string) => getMetricData(env, metricFor('AWS/RDS', metric, db.dbInstanceIdentifier), { start: now - 5 * 60_000, end: now, period: 60, stat: 'Average' }).pop()?.v;
  const cpu = latest('CPUUtilization');
  const conns = latest('DatabaseConnections');
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button disabled={db.status !== 'available'} onClick={() => navigate(`${dbPath(id)}/modify`)} data-testid="modify-db">変更</Button>
            <ActionMenu items={actions.slice(1)} />
          </SpaceBetween>
        }
      >
        {db.dbInstanceIdentifier}
      </Header>
      <ResourceDetail
        title="概要"
        fields={[
          { label: 'DB 識別子', value: db.dbInstanceIdentifier },
          { label: 'ステータス', value: <ResourceStatus state={dbState(db.status)} /> },
          { label: 'ロール', value: 'インスタンス' },
          { label: 'エンジン', value: engineLabel(db) },
          { label: 'CPU', value: up && cpu !== undefined ? `${cpu.toFixed(2)}%` : '-' },
          { label: 'クラス', value: db.dbInstanceClass },
          { label: '現在のアクティビティ', value: up && conns !== undefined ? `${Math.round(conns)} 接続` : '-' },
          { label: 'リージョンと AZ', value: db.availabilityZone },
        ]}
      />
      <ResourceTabs
        tabs={[
          { id: 'connectivity', label: '接続とセキュリティ', content: <ConnectivityTab db={db} /> },
          {
            id: 'monitoring',
            label: 'モニタリング',
            content: <MonitoringCharts columns={3} metrics={['CPUUtilization', 'DatabaseConnections', 'FreeStorageSpace'].map((m) => metricFor('AWS/RDS', m, db.dbInstanceIdentifier))} />,
          },
          {
            id: 'configuration',
            label: '設定',
            content: (
              <ResourceDetail
                title="インスタンス"
                columns={3}
                fields={[
                  { label: 'DB インスタンス ID', value: db.dbInstanceIdentifier },
                  { label: 'エンジンバージョン', value: db.engineVersion },
                  { label: 'DB 名', value: db.dbName ?? '-' },
                  { label: 'インスタンスクラス', value: db.dbInstanceClass },
                  { label: 'vCPU', value: String(cls?.vcpu ?? '-') },
                  { label: 'RAM', value: `${cls?.memoryGiB ?? '-'} GB` },
                  { label: 'マスターユーザー名', value: db.masterUsername },
                  { label: 'ストレージタイプ', value: `汎用 SSD (${db.storageType})` },
                  { label: 'ストレージ', value: `${db.allocatedStorage} GiB` },
                  { label: '暗号化', value: db.storageEncrypted ? '有効' : '無効' },
                  { label: 'マルチ AZ', value: db.multiAZ ? 'はい' : 'いいえ' },
                  { label: '作成日時', value: formatDate(db.instanceCreateTime) },
                ]}
              />
            ),
          },
          { id: 'backup', label: 'メンテナンスとバックアップ', content: <BackupTab db={db} /> },
          { id: 'tags', label: 'タグ', content: <Tags tags={db.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

type Template = 'production' | 'dev' | 'free';

export function CreateDatabase() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [engine, setEngine] = useState<DbEngine>('mysql');
  const [version, setVersion] = useState(DB_ENGINES.mysql.versions[0]);
  const [template, setTemplate] = useState<Template>('free');
  const [identifier, setIdentifier] = useState('database-1');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [cls, setCls] = useState('db.t3.micro');
  const [storage, setStorage] = useState('20');
  const [vpcId, setVpcId] = useState(env.vpcs.find((v) => !v.isDefault)?.vpcId ?? env.vpcs[0]?.vpcId ?? '');
  const [groupName, setGroupName] = useState('');
  const [publicAccess, setPublicAccess] = useState(false);
  const [sgIds, setSgIds] = useState<string[]>([]);
  const [az, setAz] = useState('');
  const [dbName, setDbName] = useState('');
  const [retention, setRetention] = useState('7');
  const [error, setError] = useState<AwsError | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const vpcOpts = env.vpcs.map(vpcOption);
  const groups = env.dbSubnetGroups.filter((g) => g.vpcId === vpcId);
  const groupOpts = groups.map((g) => ({ value: g.dbSubnetGroupName, label: g.dbSubnetGroupName, description: `${g.subnetIds.length} 個のサブネット、${new Set(g.subnetIds.map((s) => env.subnets.find((x) => x.subnetId === s)?.availabilityZone)).size} 個のアベイラビリティーゾーン` }));
  const effectiveGroup = groupName || groups[0]?.dbSubnetGroupName || '';
  const sgs = env.securityGroups.filter((g) => g.vpcId === vpcId);
  const azOpts = [{ value: '', label: '指定なし' }, ...regionOf(env.region).azs.map((z) => ({ value: z, label: z }))];
  const pwMismatch = showErrors && password !== confirm;
  return (
    <EditForm
      title="データベースの作成"
      submitText="データベースの作成"
      submitTestId="create-db-submit"
      submitHotspotId="rds-submit"
      onCancel={() => navigate('/rds/databases')}
      error={error}
      onSubmit={() => {
        setShowErrors(true);
        if (password !== confirm) return;
        const r = run(
          (d) => createDbInstance(d, { identifier, engine, engineVersion: version, dbInstanceClass: cls, masterUsername: username, masterPassword: password, dbName, allocatedStorage: Number(storage), dbSubnetGroupName: effectiveGroup, vpcSecurityGroupIds: sgIds, publiclyAccessible: publicAccess, multiAZ: template === 'production', availabilityZone: az || undefined, backupRetentionPeriod: Number(retention) }),
          (id) => `データベース ${id} を作成しています。データベースが起動するまでに数分かかる場合があります。`,
        );
        if (r.ok) navigate('/rds/databases');
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">データベース作成方法を選択</Header>}>
        <Tiles value="standard" items={[{ value: 'standard', label: '標準作成', description: '可用性、セキュリティ、バックアップ、メンテナンスに関するオプションを含め、すべての設定オプションを自分で設定します。' }, { value: 'easy', label: '簡単に作成', description: 'このシミュレーターでは未提供', disabled: true }]} />
      </Container>
      <Container header={<Header variant="h2">エンジンのオプション</Header>}>
        <SpaceBetween size="l">
          <FormField label="エンジンのタイプ">
            <Tiles
              value={engine}
              onChange={(e) => { const v = e.detail.value as DbEngine; setEngine(v); setVersion(DB_ENGINES[v].versions[0]); }}
              columns={4}
              items={[
                { value: 'aurora-mysql', label: 'Aurora (MySQL 互換)', disabled: true },
                { value: 'aurora-postgresql', label: 'Aurora (PostgreSQL 互換)', disabled: true },
                { value: 'mysql', label: 'MySQL' },
                { value: 'postgres', label: 'PostgreSQL' },
              ]}
            />
          </FormField>
          <FormField label="エンジンバージョン">
            <Select selectedOption={{ value: version, label: `${DB_ENGINES[engine].label} ${version}` }} options={DB_ENGINES[engine].versions.map((v) => ({ value: v, label: `${DB_ENGINES[engine].label} ${v}` }))} onChange={(e) => setVersion(e.detail.selectedOption.value!)} />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="ユースケースに合ったサンプルテンプレートを選択します。">テンプレート</Header>}>
        <Tiles
          value={template}
          onChange={(e) => { const t = e.detail.value as Template; setTemplate(t); setCls(t === 'production' ? 'db.m7g.large' : 'db.t3.micro'); }}
          columns={3}
          items={[
            { value: 'production', label: '本番稼働用', description: '高可用性と高速で一貫したパフォーマンスのためのデフォルトを使用します。' },
            { value: 'dev', label: '開発/テスト', description: 'このインスタンスは、本番環境以外での開発用途を想定しています。' },
            { value: 'free', label: '無料利用枠', description: 'RDS の無料利用枠を使用して、新しいアプリケーションの開発、既存アプリケーションのテスト、Amazon RDS の実践的な経験を積むことができます。' },
          ]}
        />
      </Container>
      <Container header={<Header variant="h2">設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="DB インスタンス識別子" description="DB インスタンスの名前を入力します。名前は、現在の AWS リージョンで AWS アカウントが所有するすべての DB インスタンスで一意である必要があります。" constraintText="DB インスタンス識別子は大文字と小文字が区別されませんが、すべて小文字で保存されます。1〜63 文字の英数字またはハイフン。1 文字目は文字である必要があります。ハイフンを 2 つ続けることはできません。末尾をハイフンにすることはできません。">
            <Input value={identifier} onChange={(e) => setIdentifier(e.detail.value)} data-testid="db-identifier" />
          </FormField>
          <FormField label="マスターユーザー名" constraintText="1〜16 文字の英数字。1 文字目は文字である必要があります。">
            <Input value={username} onChange={(e) => setUsername(e.detail.value)} />
          </FormField>
          <FormField label="認証情報管理">
            <Tiles value="self" items={[{ value: 'secrets', label: 'AWS Secrets Manager で管理', disabled: true, description: 'このシミュレーターでは未提供' }, { value: 'self', label: 'セルフマネージド', description: '独自のパスワードを作成するか、RDS に管理用のパスワードを作成させます。' }]} />
          </FormField>
          <FormField label="マスターパスワード" constraintText="最小制約: 8 文字以上の印刷可能な ASCII 文字。次の記号は使用できません: / ' &quot; @">
            <Input type="password" value={password} onChange={(e) => setPassword(e.detail.value)} data-testid="db-password" />
          </FormField>
          <FormField label="マスターパスワードを確認" errorText={pwMismatch ? 'パスワードが一致しません。' : undefined}>
            <Input type="password" value={confirm} onChange={(e) => setConfirm(e.detail.value)} data-testid="db-password-confirm" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">インスタンスの設定</Header>}>
        <FormField label="DB インスタンスクラス">
          <Select selectedOption={{ value: cls, label: cls }} options={DB_INSTANCE_CLASSES.map((c) => ({ value: c.cls, label: c.cls, description: `${c.vcpu} vCPU ${c.memoryGiB} GiB RAM` }))} onChange={(e) => setCls(e.detail.selectedOption.value!)} />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">ストレージ</Header>}>
        <ColumnLayout columns={2}>
          <FormField label="ストレージタイプ"><Select selectedOption={{ value: 'gp3', label: '汎用 SSD (gp3)' }} options={[{ value: 'gp3', label: '汎用 SSD (gp3)' }]} /></FormField>
          <FormField label="ストレージ割り当て (GiB)" constraintText="最小値は 20 GiB、最大値は 6,144 GiB です"><Input type="number" value={storage} onChange={(e) => setStorage(e.detail.value)} /></FormField>
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">接続</Header>}>
        <SpaceBetween size="l">
          <FormField label="コンピューティングリソース">
            <RadioGroup value="none" items={[{ value: 'none', label: 'EC2 コンピューティングリソースに接続しない', description: 'このデータベースのコンピューティングリソースへの接続をセットアップしません。後でコンピューティングリソースへの接続を手動でセットアップできます。' }, { value: 'ec2', label: 'EC2 コンピューティングリソースに接続', disabled: true, description: 'このシミュレーターでは未提供' }]} />
          </FormField>
          <FormField label="Virtual Private Cloud (VPC)" description="VPC を選択します。VPC は、この DB インスタンスの仮想ネットワーク環境を定義します。" constraintText="データベースの作成後に VPC を変更することはできません。">
            <Select selectedOption={pick(vpcOpts, vpcId)} options={vpcOpts} onChange={(e) => { setVpcId(e.detail.selectedOption.value!); setGroupName(''); setSgIds([]); }} data-testid="db-vpc" />
          </FormField>
          <FormField label="DB サブネットグループ" description="DB サブネットグループを選択します。DB サブネットグループは、選択した VPC で DB インスタンスが使用できるサブネットと IP 範囲を定義します。">
            <Select selectedOption={pick(groupOpts, effectiveGroup)} options={groupOpts} onChange={(e) => setGroupName(e.detail.selectedOption.value!)} empty="この VPC には DB サブネットグループがありません" data-testid="db-subnet-group" />
          </FormField>
          <FormField label="パブリックアクセス">
            <RadioGroup
              value={publicAccess ? 'yes' : 'no'}
              onChange={(e) => setPublicAccess(e.detail.value === 'yes')}
              items={[
                { value: 'yes', label: 'あり', description: 'RDS はデータベースにパブリック IP アドレスを割り当てます。VPC 外の Amazon EC2 インスタンスやその他のリソースがデータベースに接続できます。' },
                { value: 'no', label: 'なし', description: 'RDS はデータベースにパブリック IP アドレスを割り当てません。VPC 内の Amazon EC2 インスタンスとその他のリソースのみがデータベースに接続できます。' },
              ]}
            />
          </FormField>
          <FormField label="VPC セキュリティグループ (ファイアウォール)" description="データベースへのアクセスを許可する VPC セキュリティグループを 1 つ以上選択します。セキュリティグループのルールで適切な受信トラフィックが許可されていることを確認してください。">
            <Multiselect selectedOptions={sgs.filter((g) => sgIds.includes(g.groupId)).map(sgOption)} options={sgs.map(sgOption)} onChange={(e) => setSgIds(e.detail.selectedOptions.map((o) => o.value!))} placeholder="VPC セキュリティグループを選択" data-testid="db-sgs" />
          </FormField>
          <FormField label="アベイラビリティーゾーン">
            <Select selectedOption={pick(azOpts, az)} options={azOpts} onChange={(e) => setAz(e.detail.selectedOption.value!)} />
          </FormField>
          <FormField label="データベースポート" description="データベースがアプリケーション接続に使用する TCP/IP ポート。">
            <Input value={String(DB_ENGINES[engine].port)} disabled />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">追加設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="最初のデータベース名" description="データベース名を指定しない場合、Amazon RDS はデータベースを作成しません。">
            <Input value={dbName} onChange={(e) => setDbName(e.detail.value)} />
          </FormField>
          <FormField label="バックアップ保持期間" description="自動バックアップを保持する日数 (1〜35)。">
            <Select selectedOption={{ value: retention, label: `${retention} 日` }} options={['0', '1', '7', '14', '35'].map((d) => ({ value: d, label: `${d} 日` }))} onChange={(e) => setRetention(e.detail.selectedOption.value!)} />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function ModifyDatabase({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const db = env.dbInstances.find((d) => d.dbInstanceIdentifier === id);
  const [sgIds, setSgIds] = useState<string[]>(db?.vpcSecurityGroupIds ?? []);
  const [publicAccess, setPublicAccess] = useState(!!db?.publiclyAccessible);
  const [cls, setCls] = useState(db?.dbInstanceClass ?? '');
  const [newId, setNewId] = useState(id);
  const [multiAZ, setMultiAZ] = useState(!!db?.multiAZ);
  const [retention, setRetention] = useState(String(db?.backupRetentionPeriod ?? 7));
  const [summary, setSummary] = useState(false);
  const [when, setWhen] = useState('immediately');
  const [error, setError] = useState<AwsError | null>(null);
  if (!db) return <NotFound what="DB インスタンス" id={id} />;
  const vpcId = env.dbSubnetGroups.find((g) => g.dbSubnetGroupName === db.dbSubnetGroupName)?.vpcId;
  const sgs = env.securityGroups.filter((g) => g.vpcId === vpcId);
  const renamed = newId.trim().toLowerCase();
  const changes = [
    renamed !== id && { attr: 'DB インスタンス識別子', cur: id, next: renamed },
    cls !== db.dbInstanceClass && { attr: 'DB インスタンスクラス', cur: db.dbInstanceClass, next: cls },
    multiAZ !== db.multiAZ && { attr: 'マルチ AZ 配置', cur: db.multiAZ ? 'はい' : 'いいえ', next: multiAZ ? 'はい' : 'いいえ' },
    Number(retention) !== db.backupRetentionPeriod && { attr: 'バックアップ保持期間', cur: `${db.backupRetentionPeriod} 日`, next: `${Number(retention)} 日` },
    sgIds.join() !== db.vpcSecurityGroupIds.join() && { attr: 'セキュリティグループ', cur: db.vpcSecurityGroupIds.map((s) => sgs.find((g) => g.groupId === s)?.groupName ?? s).join(', '), next: sgIds.map((s) => sgs.find((g) => g.groupId === s)?.groupName ?? s).join(', ') },
    publicAccess !== db.publiclyAccessible && { attr: 'パブリックアクセス可能', cur: db.publiclyAccessible ? 'はい' : 'いいえ', next: publicAccess ? 'はい' : 'いいえ' },
  ].filter(Boolean) as { attr: string; cur: string; next: string }[];
  if (summary)
    return (
      <EditForm
        title={`DB インスタンスを変更: ${id}`}
        submitText="DB インスタンスを変更"
        submitTestId="modify-db-submit"
        onCancel={() => setSummary(false)}
        error={error}
        onSubmit={() => {
          const r = run((d) => modifyDbInstance(d, id, { vpcSecurityGroupIds: sgIds, publiclyAccessible: publicAccess, dbInstanceClass: cls, multiAZ, backupRetentionPeriod: Number(retention), newDbInstanceIdentifier: renamed }), `DB インスタンス ${id} が正常に変更されました`);
          if (r.ok) navigate(`${dbPath(renamed)}?tab=connectivity`);
          else setError(r.error);
        }}
      >
        <Table header={<Header>変更の概要</Header>} variant="container" items={changes} empty="変更はありません" columnDefinitions={[{ id: 'a', header: '属性', cell: (c) => c.attr }, { id: 'c', header: '現在の値', cell: (c) => c.cur }, { id: 'n', header: '新しい値', cell: (c) => c.next }]} />
        <Container header={<Header variant="h2">変更のスケジュール</Header>}>
          <RadioGroup value={when} onChange={(e) => setWhen(e.detail.value)} items={[{ value: 'next', label: '次回の定期メンテナンスウィンドウ中に適用', disabled: true, description: 'このシミュレーターでは未提供' }, { value: 'immediately', label: 'すぐに適用', description: 'このリクエストの変更と保留中の変更は、できるだけ早く非同期で適用されます。' }]} />
        </Container>
      </EditForm>
    );
  return (
    <EditForm title={`DB インスタンスを変更: ${id}`} submitText="続行" submitTestId="modify-db-continue" onCancel={() => navigate(dbPath(id))} error={null} onSubmit={() => setSummary(true)}>
      <Container header={<Header variant="h2">設定</Header>}>
        <FormField label="DB インスタンス識別子" description="名前を変更するとエンドポイントも変わります。同じ名前に変えた DB インスタンスが、その名前のエンドポイントを引き継ぎます。">
          <Input value={newId} onChange={(e) => setNewId(e.detail.value)} data-testid="modify-db-identifier" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">インスタンスの設定</Header>}>
        <FormField label="DB インスタンスクラス">
          <Select selectedOption={{ value: cls, label: cls }} options={DB_INSTANCE_CLASSES.map((c) => ({ value: c.cls, label: c.cls, description: `${c.vcpu} vCPU ${c.memoryGiB} GiB RAM` }))} onChange={(e) => setCls(e.detail.selectedOption.value!)} data-testid="modify-db-class" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">可用性と耐久性</Header>}>
        <FormField label="マルチ AZ 配置">
          <RadioGroup value={multiAZ ? 'multi' : 'single'} onChange={(e) => setMultiAZ(e.detail.value === 'multi')} items={[{ value: 'multi', label: 'スタンバイインスタンスを作成する', description: '別の AZ に同期レプリケーションされるスタンバイを作成します (高可用性)。' }, { value: 'single', label: 'スタンバイインスタンスを作成しないでください' }]} data-testid="modify-db-multiaz" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">バックアップ</Header>}>
        <FormField label="バックアップ保持期間" description="自動バックアップを保持する日数 (0〜35)。この期間内の任意の時点に復元できます。0 にすると自動バックアップは無効になります。">
          <Select selectedOption={{ value: retention, label: `${retention} 日` }} options={Array.from({ length: 36 }, (_, n) => ({ value: String(n), label: `${n} 日` }))} onChange={(e) => setRetention(e.detail.selectedOption.value!)} data-testid="modify-db-retention" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">接続</Header>}>
        <SpaceBetween size="l">
          <FormField label="セキュリティグループ" description="データベースへのアクセスを許可する VPC セキュリティグループを 1 つ以上選択します。">
            <Multiselect selectedOptions={sgs.filter((g) => sgIds.includes(g.groupId)).map(sgOption)} options={sgs.map(sgOption)} onChange={(e) => setSgIds(e.detail.selectedOptions.map((o) => o.value!))} data-testid="modify-db-sgs" />
          </FormField>
          <FormField label="パブリックアクセス">
            <RadioGroup value={publicAccess ? 'yes' : 'no'} onChange={(e) => setPublicAccess(e.detail.value === 'yes')} items={[{ value: 'yes', label: 'パブリックアクセス可能' }, { value: 'no', label: 'パブリックアクセス不可' }]} />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function SubnetGroupList() {
  const env = useEnv();
  const navigate = useNavigate();
  return (
    <ResourceTable
      title="サブネットグループ"
      resourceName="サブネットグループ"
      items={env.dbSubnetGroups}
      trackBy={(g) => g.dbSubnetGroupName}
      selectionType="none"
      columns={[
        { id: 'name', header: '名前', cell: (g) => <ConsoleLink to={`/rds/subnet-groups/${g.dbSubnetGroupName}`}>{g.dbSubnetGroupName}</ConsoleLink>, value: (g) => g.dbSubnetGroupName },
        { id: 'desc', header: '説明', cell: (g) => g.description, value: (g) => g.description },
        { id: 'status', header: 'ステータス', cell: () => <ResourceStatus state="complete" /> },
        { id: 'vpc', header: 'VPC', cell: (g) => <ConsoleLink to={`/vpc/vpcs/${g.vpcId}`}>{g.vpcId}</ConsoleLink>, value: (g) => g.vpcId },
      ]}
      actions={<Button variant="primary" onClick={() => navigate('/rds/subnet-groups/create')}>DB サブネットグループを作成</Button>}
    />
  );
}

export function SubnetGroupDetail({ name }: { name: string }) {
  const env = useEnv();
  const g = env.dbSubnetGroups.find((x) => x.dbSubnetGroupName === name);
  if (!g) return <NotFound what="DB サブネットグループ" id={name} />;
  const subnets = env.subnets.filter((s) => g.subnetIds.includes(s.subnetId));
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{g.dbSubnetGroupName}</Header>
      <ResourceDetail fields={[{ label: 'VPC', value: <ConsoleLink to={`/vpc/vpcs/${g.vpcId}`}>{g.vpcId}</ConsoleLink> }, { label: '説明', value: g.description }, { label: 'ステータス', value: '完了' }, { label: 'ARN', value: `arn:aws:rds:${env.region}:${env.accountId}:subgrp:${g.dbSubnetGroupName}` }]} />
      <Table
        variant="container"
        header={<Header counter={`(${subnets.length})`}>サブネット</Header>}
        items={subnets}
        columnDefinitions={[
          { id: 'az', header: 'アベイラビリティーゾーン', cell: (s) => s.availabilityZone },
          { id: 'id', header: 'サブネット ID', cell: (s) => <ConsoleLink to={`/vpc/subnets/${s.subnetId}`}>{`${s.subnetId}${nameOf(s) ? ` (${nameOf(s)})` : ''}`}</ConsoleLink> },
          { id: 'cidr', header: 'CIDR ブロック', cell: (s) => s.cidrBlock },
        ]}
      />
    </SpaceBetween>
  );
}

export function CreateSubnetGroup() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [vpcId, setVpcId] = useState(env.vpcs.find((v) => !v.isDefault)?.vpcId ?? '');
  const [subnetIds, setSubnetIds] = useState<string[]>([]);
  const [error, setError] = useState<AwsError | null>(null);
  const vpcOpts = env.vpcs.map(vpcOption);
  const subnets = env.subnets.filter((s) => s.vpcId === vpcId);
  const opts = subnets.map((s) => ({ value: s.subnetId, label: `${s.subnetId}${nameOf(s) ? ` (${nameOf(s)})` : ''}`, description: `${s.availabilityZone} · ${s.cidrBlock}` }));
  return (
    <EditForm
      title="DB サブネットグループを作成"
      description="新しいサブネットグループを作成するには、名前と説明を付けて、既存の VPC を選択します。その後、その VPC に関連するサブネットを追加できます。"
      submitText="作成"
      onCancel={() => navigate('/rds/subnet-groups')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createDbSubnetGroup(d, { name, description: desc, vpcId, subnetIds }), (n) => `${n} が正常に作成されました。`);
        if (r.ok) navigate(`/rds/subnet-groups/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">サブネットグループの詳細</Header>}>
        <SpaceBetween size="l">
          <FormField label="名前"><Input value={name} onChange={(e) => setName(e.detail.value)} /></FormField>
          <FormField label="説明"><Input value={desc} onChange={(e) => setDesc(e.detail.value)} /></FormField>
          <FormField label="VPC"><Select selectedOption={pick(vpcOpts, vpcId)} options={vpcOpts} onChange={(e) => { setVpcId(e.detail.selectedOption.value!); setSubnetIds([]); }} /></FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">サブネットを追加</Header>}>
        <FormField label="サブネット" description="マルチ AZ DB クラスターの場合は、3 つの異なるアベイラビリティーゾーンで 3 つのサブネットを選択する必要があります。その他のデプロイでは、少なくとも 2 つのアベイラビリティーゾーンのサブネットを選択します。">
          <Multiselect selectedOptions={opts.filter((o) => subnetIds.includes(o.value))} options={opts} onChange={(e) => setSubnetIds(e.detail.selectedOptions.map((o) => o.value!))} />
        </FormField>
      </Container>
      {subnetIds.length === 1 && <Alert type="info">少なくとも 2 つのアベイラビリティーゾーンのサブネットを選択してください。</Alert>}
    </EditForm>
  );
}
