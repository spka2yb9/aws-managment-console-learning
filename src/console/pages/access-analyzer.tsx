// IAM > Access Analyzer (アクセスレポート): リソース分析 (外部アクセス)、未使用のアクセス、アナライザーの設定、アーカイブルール。
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import Form from '@cloudscape-design/components/form';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useState, type ReactNode } from 'react';
import { regionOf } from '../../sim/env';
import { analyzersOf, applyArchiveRule, checkFilter, createAnalyzer, createArchiveRule, deleteAnalyzer, deleteArchiveRule, deleteRoleWithPolicies, grantedServices, isUnusedAnalyzer, matchesFilter, startResourceScan, updateFindings, type Analyzer, type Criterion, type Finding, type FindingFilter, type FindingStatus } from '../../sim/ext/accessanalyzer';
import { findPolicy, list, statements } from '../../sim/iam';
import { randomHex } from '../../sim/ids';
import type { AwsEnv, AwsError } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, DeleteModal, EditForm, errorText, formatDate, NotFound, queryParam, ResourceDetail, ResourceTable, ResourceTabs, useGlobalEnv, useNavigate, useSelection } from '../ui';

const BASE = '/iam/access-analyzer';
export const analyzerPath = (name: string) => `${BASE}/analyzers/view?${new URLSearchParams({ name })}`;
export const findingPath = (a: Analyzer, f: Finding) => `${BASE}/${isUnusedAnalyzer(a) ? 'unused' : 'findings'}/view?${new URLSearchParams({ analyzer: a.name, id: f.id })}`;

const STATUS: Record<FindingStatus, [StatusIndicatorProps.Type, string]> = { ACTIVE: ['warning', 'アクティブ'], ARCHIVED: ['stopped', 'アーカイブ済み'], RESOLVED: ['success', '解決済み'] };
const FindingStatusIndicator = ({ status }: { status: FindingStatus }) => <StatusIndicator type={STATUS[status][0]}>{STATUS[status][1]}</StatusIndicator>;
const analysisLabel = (a: Analyzer) => (isUnusedAnalyzer(a) ? 'プリンシパル分析 - 未使用のアクセス' : 'リソース分析 - 外部アクセス');
const RESOURCE_TYPE: Record<string, string> = { 'AWS::S3::Bucket': 'S3 バケット', 'AWS::IAM::Role': 'IAM ロール' };
const FINDING_TYPE: Record<string, string> = { ExternalAccess: '外部アクセス', UnusedIAMRole: '未使用のロール', UnusedPermission: '未使用の権限' };
/** arn:aws:s3:::bucket → bucket, arn:aws:iam::123456789012:role/name → name */
const resourceName = (arn: string) => arn.split(':').pop()!.split('/').pop()!;
const principalLabel = (f: Finding) => {
  const p = f.principal?.AWS;
  return !p ? '-' : p === '*' ? 'すべてのプリンシパル (*)' : /^\d{12}$/.test(p) ? `AWS アカウント: ${p}` : p;
};
const conditionLabel = (f: Finding) => Object.entries(f.condition ?? {}).map(([k, v]) => `${k} = ${v}`).join(', ') || '-';
/** where the access is granted (to fix it) */
const resourcePage = (f: Finding, unused = false) => (f.resourceType === 'AWS::S3::Bucket' ? `/s3/buckets/${resourceName(f.resource)}?tab=permissions` : `/iam/roles/${resourceName(f.resource)}?tab=${unused ? 'permissions' : 'trust'}`);
const exists = (env: AwsEnv, f: Finding) => (f.resourceType === 'AWS::S3::Bucket' ? env.buckets.some((b) => `arn:aws:s3:::${b.name}` === f.resource) : env.iamRoles.some((r) => r.arn === f.resource));
const resourceLink = (env: AwsEnv, f: Finding, unused = false) => (exists(env, f) ? <ConsoleLink to={resourcePage(f, unused)}>{resourceName(f.resource)}</ConsoleLink> : resourceName(f.resource));

function NoAnalyzer({ unused }: { unused: boolean }) {
  const navigate = useNavigate();
  return (
    <Container header={<Header variant="h2">{unused ? '未使用のアクセスアナライザー' : '外部アクセスアナライザー'}がありません</Header>}>
      <SpaceBetween size="m">
        <Box>
          {unused
            ? 'IAM ロールとユーザーの未使用のアクセス (使われていないロール、使われていない権限) を見つけるには、未使用のアクセスアナライザーを作成します。'
            : 'このリージョンで、信頼ゾーンの外部と共有されているリソースを見つけるには、外部アクセスアナライザーを作成します。'}
        </Box>
        <Hotspot hotspotId="aa-create-analyzer" direction="right">
          <Button variant="primary" onClick={() => navigate(`${BASE}/analyzers/create?type=${unused ? 'unused' : 'external'}`)} data-testid="aa-create-analyzer">
            アナライザーを作成
          </Button>
        </Hotspot>
      </SpaceBetween>
    </Container>
  );
}

// ---------------- findings ----------------

/** リソース分析 (外部アクセス) / 未使用のアクセス: the findings of the analyzer of that kind, by status. */
export function FindingList({ unused }: { unused: boolean }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [status, setStatus] = useState<FindingStatus | 'ALL'>('ACTIVE');
  const a = analyzersOf(env).find((x) => isUnusedAnalyzer(x) === unused);
  const items = (a?.findings ?? []).filter((f) => status === 'ALL' || f.status === status);
  const [sel, setSel] = useSelection(items, (f) => f.id);
  const title = unused ? '未使用のアクセス' : 'リソース分析';
  if (!a) {
    return (
      <SpaceBetween size="l">
        <Header variant="h1" description={unused ? '使われていない IAM ロールや権限を見つけて、アクセスを最小限にします。' : '信頼ゾーンの外部のプリンシパルからアクセスできるリソースを見つけます。'}>{title}</Header>
        <NoAnalyzer unused={unused} />
      </SpaceBetween>
    );
  }
  const update = (to: 'ARCHIVED' | 'ACTIVE') => {
    run((d) => updateFindings(d, a.arn, { status: to, ids: sel.map((f) => f.id) }), `${sel.length} 件の検出結果を${to === 'ARCHIVED' ? 'アーカイブしました' : 'アクティブに戻しました'}`);
    setSel([]);
  };
  const external = [
    { id: 'resource', header: 'リソース', cell: (f: Finding) => resourceLink(env, f), value: (f: Finding) => resourceName(f.resource) },
    { id: 'type', header: 'リソースタイプ', cell: (f: Finding) => RESOURCE_TYPE[f.resourceType], value: (f: Finding) => RESOURCE_TYPE[f.resourceType] },
    { id: 'principal', header: '外部プリンシパル', cell: principalLabel, value: principalLabel },
    { id: 'condition', header: '条件', cell: conditionLabel, value: conditionLabel },
    { id: 'public', header: 'パブリックアクセス', cell: (f: Finding) => (f.isPublic ? <StatusIndicator type="error">はい</StatusIndicator> : 'いいえ'), value: (f: Finding) => (f.isPublic ? 'はい' : 'いいえ') },
  ];
  const unusedColumns = [
    { id: 'ftype', header: '結果タイプ', cell: (f: Finding) => FINDING_TYPE[f.findingType], value: (f: Finding) => FINDING_TYPE[f.findingType] },
    { id: 'entity', header: 'IAM エンティティ', cell: (f: Finding) => resourceLink(env, f, true), value: (f: Finding) => resourceName(f.resource) },
  ];
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={unused ? `未使用のアクセスアナライザー ${a.name} の検出結果です (追跡期間: ${a.unusedAccessAge} 日)。` : `外部アクセスアナライザー ${a.name} の検出結果です。信頼ゾーン (現在のアカウント) の外部のプリンシパルがアクセスできるリソースを示します。`}
      >
        {title}
      </Header>
      <SegmentedControl
        label="ステータス"
        selectedId={status}
        onChange={(e) => setStatus(e.detail.selectedId as typeof status)}
        options={[
          { id: 'ACTIVE', text: 'アクティブ' },
          { id: 'ARCHIVED', text: 'アーカイブ済み' },
          { id: 'RESOLVED', text: '解決済み' },
          { id: 'ALL', text: 'すべて' },
        ]}
      />
      <ResourceTable<Finding>
        title="検出結果"
        resourceName="検出結果"
        variant="container"
        headerVariant="h2"
        testId={unused ? 'aa-unused-findings' : 'aa-findings'}
        items={items}
        trackBy={(f) => f.id}
        selectionType="multi"
        selectedItems={sel}
        onSelectionChange={setSel}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button disabled={!sel.length || sel.some((f) => f.status !== 'ARCHIVED')} onClick={() => update('ACTIVE')}>アクティブとしてマーク</Button>
            <Button disabled={!sel.length || sel.some((f) => f.status !== 'ACTIVE')} onClick={() => update('ARCHIVED')} data-testid="aa-archive">アーカイブ</Button>
            <Hotspot hotspotId="aa-create-archive-rule" direction="right">
              <Button onClick={() => navigate(`${BASE}/archive-rules/create?${new URLSearchParams({ analyzer: a.name })}`)} data-testid="aa-create-archive-rule">アーカイブルールを作成</Button>
            </Hotspot>
          </SpaceBetween>
        }
        columns={[
          { id: 'id', header: '検出結果 ID', cell: (f) => <ConsoleLink to={findingPath(a, f)}>{f.id}</ConsoleLink>, value: (f) => f.id },
          ...(unused ? unusedColumns : external),
          { id: 'updated', header: unused ? '最終更新日' : '更新日時', cell: (f) => formatDate(f.updatedAt), value: (f) => f.updatedAt },
          { id: 'status', header: 'ステータス', cell: (f) => <FindingStatusIndicator status={f.status} />, value: (f) => STATUS[f.status][1] },
        ]}
      />
    </SpaceBetween>
  );
}

function FindingHeader({ a, f, children }: { a: Analyzer; f: Finding; children?: ReactNode }) {
  const run = useConsole((s) => s.run);
  const set = (to: 'ARCHIVED' | 'ACTIVE') => run((d) => updateFindings(d, a.arn, { status: to, ids: [f.id] }), to === 'ARCHIVED' ? '検出結果をアーカイブしました' : '検出結果をアクティブに戻しました');
  return (
    <Header
      variant="h1"
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          {children}
          {f.status === 'ACTIVE' && <Button onClick={() => set('ARCHIVED')} data-testid="aa-archive-one">アーカイブ</Button>}
          {f.status === 'ARCHIVED' && <Button onClick={() => set('ACTIVE')}>アクティブとしてマーク</Button>}
        </SpaceBetween>
      }
    >
      {`検出結果: ${f.id}`}
    </Header>
  );
}

const lookup = (env: AwsEnv, analyzer: string, id: string) => {
  const a = analyzersOf(env).find((x) => x.name === analyzer);
  return { a, f: a?.findings.find((x) => x.id === id) };
};

/** An external access finding: who outside the zone of trust can do what, and through which policy. */
export function FindingDetail({ analyzer, id }: { analyzer: string; id: string }) {
  const env = useGlobalEnv();
  const run = useConsole((s) => s.run);
  const { a, f } = lookup(env, analyzer, id);
  if (!a || !f) return <NotFound what="検出結果" id={id} />;
  const rescan = () => run((d) => startResourceScan(d, a.arn, f.resource), `${resourceName(f.resource)} の再スキャンが完了しました`);
  return (
    <SpaceBetween size="l">
      <FindingHeader a={a} f={f}>
        <Hotspot hotspotId="aa-rescan" direction="left">
          <Button iconName="refresh" onClick={rescan} data-testid="aa-rescan">再スキャン</Button>
        </Hotspot>
      </FindingHeader>
      {f.status === 'RESOLVED' && <Alert type="success" header="この検出結果は解決済みです">再スキャンの結果、このアクセスはもう許可されていません。</Alert>}
      <ResourceDetail
        title="検出結果の詳細"
        columns={3}
        fields={[
          { label: 'ステータス', value: <span data-testid="aa-finding-status"><FindingStatusIndicator status={f.status} /></span> },
          { label: 'リソース', value: resourceLink(env, f) },
          { label: 'リソースタイプ', value: RESOURCE_TYPE[f.resourceType] },
          { label: 'リソース ARN', value: <CopyableValue value={f.resource} /> },
          { label: 'リソース所有者アカウント', value: f.resourceOwnerAccount },
          { label: '外部プリンシパル', value: principalLabel(f) },
          { label: '条件', value: conditionLabel(f) },
          { label: 'アクション', value: (f.action ?? []).join(', ') },
          { label: 'パブリックアクセス', value: f.isPublic ? 'はい' : 'いいえ' },
          { label: '共有手段', value: f.resourceType === 'AWS::S3::Bucket' ? 'バケットポリシー' : '信頼ポリシー' },
          { label: '分析日時', value: formatDate(f.analyzedAt) },
          { label: '作成日時', value: formatDate(f.createdAt) },
          { label: '更新日時', value: formatDate(f.updatedAt) },
        ]}
      />
      <Container header={<Header variant="h2">次のステップ</Header>}>
        <SpaceBetween size="s">
          <Box>このアクセスが意図したものであれば、検出結果をアーカイブします。同じようなアクセスが今後も見つかるなら、アーカイブルールを作成すると自動でアーカイブされます。</Box>
          <Box>
            意図しないアクセスであれば、{f.resourceType === 'AWS::S3::Bucket' ? 'S3 コンソールでバケットポリシー' : 'IAM コンソールでロールの信頼ポリシー'}を変更してアクセスを削除します。ポリシーの変更は自動で分析されますが、時間がかかることがあります。すぐに確かめるには <b>再スキャン</b> を選択します。
          </Box>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

/** the role's policies that grant the unused services */
function policiesGranting(env: AwsEnv, roleArn: string, services: string[]) {
  const r = env.iamRoles.find((x) => x.arn === roleArn);
  if (!r) return [];
  const servicesOf = (doc: Parameters<typeof statements>[0]) => [...new Set(statements(doc).filter((s) => s.Effect === 'Allow').flatMap((s) => list(s.Action)).map((x) => x.split(':')[0].toLowerCase()))].filter((s) => services.includes(s));
  return [
    ...r.attachedPolicyArns.map((arn) => ({ name: findPolicy(env, arn)?.policyName ?? arn, services: findPolicy(env, arn) ? servicesOf(findPolicy(env, arn)!.document) : [] })),
    ...r.inlinePolicies.map((p) => ({ name: `${p.policyName} (インライン)`, services: servicesOf(p.document) })),
  ].filter((p) => p.services.length);
}

/** An unused access finding with the recommended step (delete the role / remove the unused permissions). */
export function UnusedFindingDetail({ analyzer, id }: { analyzer: string; id: string }) {
  const env = useGlobalEnv();
  const run = useConsole((s) => s.run);
  const [deleting, setDeleting] = useState(false);
  const { a, f } = lookup(env, analyzer, id);
  if (!a || !f) return <NotFound what="検出結果" id={id} />;
  const role = env.iamRoles.find((r) => r.arn === f.resource);
  const name = resourceName(f.resource);
  const unusedServices = f.unusedServices ?? [];
  return (
    <SpaceBetween size="l">
      <FindingHeader a={a} f={f} />
      {f.status === 'RESOLVED' && <Alert type="success" header="この検出結果は解決済みです">最新の分析で、この未使用のアクセスは見つかりませんでした。</Alert>}
      <ResourceDetail
        title="検出結果の詳細"
        columns={3}
        fields={[
          { label: 'ステータス', value: <span data-testid="aa-finding-status"><FindingStatusIndicator status={f.status} /></span> },
          { label: '結果タイプ', value: FINDING_TYPE[f.findingType] },
          { label: 'IAM エンティティ', value: resourceLink(env, f, true) },
          { label: 'リソース ARN', value: <CopyableValue value={f.resource} /> },
          { label: 'AWS アカウント ID', value: f.resourceOwnerAccount },
          { label: '追跡期間', value: `${a.unusedAccessAge} 日` },
          ...(f.findingType === 'UnusedIAMRole' ? [{ label: '最終アクセス', value: f.lastAccessed ? formatDate(f.lastAccessed) : 'アクセスなし' }] : []),
          { label: '分析日時', value: formatDate(f.analyzedAt) },
          { label: '作成日時', value: formatDate(f.createdAt) },
          { label: '更新日時', value: formatDate(f.updatedAt) },
        ]}
      />
      {f.findingType === 'UnusedPermission' && (
        <Table
          variant="container"
          data-testid="aa-unused-services"
          header={<Header variant="h2" counter={`(${unusedServices.length})`} description="追跡期間中に使われなかったサービスの権限です。">未使用の権限</Header>}
          items={unusedServices}
          columnDefinitions={[
            { id: 'svc', header: 'サービス', cell: (s) => s.serviceNamespace },
            { id: 'last', header: '最終アクセス', cell: (s) => (s.lastAccessed ? formatDate(s.lastAccessed) : '追跡期間中のアクセスなし') },
          ]}
        />
      )}
      <Container header={<Header variant="h2">推奨事項</Header>}>
        {f.status === 'RESOLVED' || !role ? (
          <Box color="text-body-secondary">対応は不要です。</Box>
        ) : f.findingType === 'UnusedIAMRole' ? (
          <SpaceBetween size="s">
            <Box>未使用のロール {name} を削除することをお勧めします。削除する前に、このロールを引き受けるアプリケーションや人がいないことを確認してください。</Box>
            <Hotspot hotspotId="aa-delete-role" direction="right">
              <Button onClick={() => setDeleting(true)} data-testid="aa-delete-role">ロールを削除</Button>
            </Hotspot>
          </SpaceBetween>
        ) : (
          <SpaceBetween size="s">
            <Box>未使用の権限を許可しているポリシーを、ロールから削除 (デタッチ) することをお勧めします。使っている権限まで外さないように、既存の許可ポリシーごとに確認してください。</Box>
            <Table
              variant="embedded"
              data-testid="aa-existing-policies"
              items={policiesGranting(env, f.resource, unusedServices.map((s) => s.serviceNamespace))}
              empty="該当するポリシーはありません"
              columnDefinitions={[
                { id: 'name', header: '既存の許可ポリシー', cell: (p) => p.name },
                { id: 'svc', header: '未使用のサービス', cell: (p) => p.services.join(', ') },
                { id: 'all', header: 'ロールが使っているサービス', cell: () => grantedServices(env, role).filter((s) => !unusedServices.some((u) => u.serviceNamespace === s)).join(', ') || '-' },
              ]}
            />
            <ConsoleLink to={`/iam/roles/${name}?tab=permissions`}>ロール {name} の許可ポリシーを開く</ConsoleLink>
          </SpaceBetween>
        )}
      </Container>
      {deleting && (
        <DeleteModal header={`${name} を削除しますか?`} onClose={() => setDeleting(false)} onDelete={() => run((d) => deleteRoleWithPolicies(d, name), `ロール ${name} を削除しました`)} testId="aa-delete-role">
          <Box>ロールを削除すると、アタッチされたポリシーはデタッチされ、このロールを引き受けていたプリンシパルはアクセスできなくなります。この操作は元に戻せません。</Box>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

// ---------------- analyzers ----------------

export function AnalyzerList() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const items = analyzersOf(env);
  const [sel, setSel] = useSelection(items, (a) => a.name);
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <ResourceTable<Analyzer>
        title="アナライザー"
        description="アナライザーは、選択した信頼ゾーンまたはアカウントのリソースとアクセスを継続的に分析し、検出結果を生成します。"
        resourceName="アナライザー"
        testId="aa-analyzers"
        items={items}
        trackBy={(a) => a.name}
        selectedItems={sel}
        onSelectionChange={setSel}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button disabled={!sel.length} onClick={() => setDeleting(true)}>削除</Button>
            <Hotspot hotspotId="aa-create-analyzer" direction="right">
              <Button variant="primary" onClick={() => navigate(`${BASE}/analyzers/create`)} data-testid="aa-create-analyzer">アナライザーを作成</Button>
            </Hotspot>
          </SpaceBetween>
        }
        columns={[
          { id: 'name', header: '名前', cell: (a) => <ConsoleLink to={analyzerPath(a.name)}>{a.name}</ConsoleLink>, value: (a) => a.name },
          { id: 'type', header: '分析', cell: analysisLabel, value: analysisLabel },
          { id: 'zone', header: '信頼ゾーン / 選択したアカウント', cell: () => '現在のアカウント' },
          { id: 'status', header: 'ステータス', cell: () => <StatusIndicator type="success">アクティブ</StatusIndicator> },
          { id: 'active', header: 'アクティブな検出結果', cell: (a) => String(a.findings.filter((f) => f.status === 'ACTIVE').length), value: (a) => a.findings.filter((f) => f.status === 'ACTIVE').length },
          { id: 'date', header: '作成日時', cell: (a) => formatDate(a.createdAt), value: (a) => a.createdAt },
        ]}
      />
      {deleting && sel[0] && (
        <DeleteModal header={`${sel[0].name} を削除しますか?`} onClose={() => setDeleting(false)} onDelete={() => run((d) => deleteAnalyzer(d, sel[0].name), `アナライザー ${sel[0].name} を削除しました`)} testId="aa-delete-analyzer">
          <Box>アナライザーを削除すると、その検出結果とアーカイブルールも削除されます。</Box>
        </DeleteModal>
      )}
    </>
  );
}

export function CreateAnalyzerPage() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const path = useConsole((s) => s.path);
  const [kind, setKind] = useState(queryParam(path, 'type') === 'unused' ? 'unused' : 'external');
  const [suffix] = useState(() => randomHex(8));
  const [name, setName] = useState<string | null>(null);
  const [age, setAge] = useState('90');
  const [error, setError] = useState<AwsError | null>(null);
  const unused = kind === 'unused';
  const value = name ?? `${unused ? 'UnusedAccess' : 'ExternalAccess'}-ConsoleAnalyzer-${suffix}`;
  const region = regionOf(env.region);
  return (
    <EditForm
      title="アナライザーを作成"
      description="IAM Access Analyzer は、自動推論でポリシーを分析し、意図しないアクセスや未使用のアクセスを検出結果として報告します。"
      submitText="アナライザーを作成"
      submitTestId="aa-create-submit"
      submitHotspotId="aa-create-submit"
      onCancel={() => navigate(`${BASE}/analyzers`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => createAnalyzer(d, { name: value.trim(), type: unused ? 'ACCOUNT_UNUSED_ACCESS' : 'ACCOUNT', unusedAccessAge: unused ? Number(age) : undefined }), `アナライザー ${value.trim()} が作成されました`);
        if (r.ok) navigate(`${BASE}/${unused ? 'unused' : 'findings'}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">分析</Header>}>
        <RadioGroup
          value={kind}
          onChange={(e) => setKind(e.detail.value)}
          items={[
            { value: 'external', label: 'リソース分析 - 外部アクセス', description: '信頼ゾーンの外部のプリンシパルと共有されているリソースを特定します。' },
            { value: 'internal', label: 'リソース分析 - 内部アクセス', description: 'このシミュレーターでは未提供', disabled: true },
            { value: 'unused', label: 'プリンシパル分析 - 未使用のアクセス', description: 'IAM ロールとユーザーに付与されているのに使われていないアクセスを特定します。追加料金がかかります。' },
          ]}
        />
      </Container>
      <Container header={<Header variant="h2">アナライザーの詳細</Header>}>
        <SpaceBetween size="l">
          <FormField label="名前" constraintText="名前は 1～255 文字。先頭は英字かアンダースコア、英数字と「_ . -」を使用できます。">
            <Input value={value} onChange={(e) => setName(e.detail.value)} data-testid="aa-analyzer-name" />
          </FormField>
          <FormField label="リージョン" description={unused ? '未使用のアクセスの検出結果はリージョンによって変わりません。' : '外部アクセスアナライザーは、作成したリージョンのリソースを分析します。'}>
            <Box>{`${region.name} ${region.code}`}</Box>
          </FormField>
          {unused ? (
            <>
              <FormField label="追跡期間" description="この日数のあいだ使われなかったアクセスを検出結果にします。追跡期間を通じて存在していた IAM エンティティだけが分析されます。" constraintText="1～365 日">
                <Input type="number" value={age} onChange={(e) => setAge(e.detail.value)} data-testid="aa-unused-age" />
              </FormField>
              <FormField label="選択したアカウント">
                <RadioGroup value="account" items={[{ value: 'account', label: '現在のアカウント' }, { value: 'org', label: '現在の組織', description: 'このアカウントは組織の管理アカウントではありません', disabled: true }]} />
              </FormField>
            </>
          ) : (
            <FormField label="信頼ゾーン" description="信頼ゾーンの外部のプリンシパルからのアクセスが検出結果になります。">
              <RadioGroup value="account" items={[{ value: 'account', label: '現在のアカウント' }, { value: 'org', label: '現在の組織', description: 'このアカウントは組織の管理アカウントではありません', disabled: true }]} />
            </FormField>
          )}
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

const PROPERTIES = {
  external: [
    { value: 'principal.AWS', label: 'AWS アカウント' },
    { value: 'resource', label: 'リソース' },
    { value: 'resourceType', label: 'リソースタイプ' },
    { value: 'isPublic', label: 'パブリックアクセス' },
    { value: 'resourceOwnerAccount', label: 'リソース所有者アカウント' },
  ],
  unused: [
    { value: 'findingType', label: '検出結果のタイプ' },
    { value: 'resource', label: 'リソース' },
    { value: 'resourceOwnerAccount', label: 'リソース所有者アカウント' },
  ],
};
const OPERATORS = [
  { value: 'eq', label: 'である' },
  { value: 'neq', label: '等しくない' },
  { value: 'contains', label: '含む' },
];
const propertyLabel = (key: string) => [...PROPERTIES.external, ...PROPERTIES.unused].find((p) => p.value === key)?.label ?? key;
export const criterionText = (key: string, c: Criterion) =>
  `${propertyLabel(key)} ${(['eq', 'neq', 'contains'] as const).filter((op) => c[op]).map((op) => `${OPERATORS.find((o) => o.value === op)!.label} ${c[op]!.join(' または ')}`).join(' / ')}${c.exists === undefined ? '' : c.exists ? ' が存在する' : ' が存在しない'}`;

export function AnalyzerDetail({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const a = analyzersOf(env).find((x) => x.name === name);
  const [sel, setSel] = useState<string[]>([]);
  if (!a) return <NotFound what="アナライザー" id={name} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{a.name}</Header>
      <ResourceDetail
        title="アナライザーの詳細"
        columns={3}
        fields={[
          { label: 'ARN', value: <CopyableValue value={a.arn} /> },
          { label: '分析', value: analysisLabel(a) },
          { label: isUnusedAnalyzer(a) ? '選択したアカウント' : '信頼ゾーン', value: '現在のアカウント' },
          { label: 'ステータス', value: <StatusIndicator type="success">アクティブ</StatusIndicator> },
          { label: '作成日時', value: formatDate(a.createdAt) },
          ...(isUnusedAnalyzer(a) ? [{ label: '追跡期間', value: `${a.unusedAccessAge} 日` }] : []),
          { label: '最後に分析されたリソース', value: a.lastResourceAnalyzed ?? '-' },
          { label: '最終分析日時', value: a.lastResourceAnalyzedAt ? formatDate(a.lastResourceAnalyzedAt) : '-' },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'archive-rules',
            label: 'アーカイブルール',
            content: (
              <Table
                variant="container"
                data-testid="aa-archive-rules"
                header={
                  <Header
                    counter={`(${a.archiveRules.length})`}
                    description="アーカイブルールに一致する新しい検出結果は、自動的にアーカイブされます。"
                    actions={
                      <SpaceBetween direction="horizontal" size="xs">
                        <Button
                          disabled={!sel.length}
                          onClick={() => {
                            run((d) => sel.forEach((r) => deleteArchiveRule(d, a.name, r)), `${sel.length} 個のアーカイブルールを削除しました`);
                            setSel([]);
                          }}
                        >
                          削除
                        </Button>
                        <Button variant="primary" onClick={() => navigate(`${BASE}/archive-rules/create?${new URLSearchParams({ analyzer: a.name })}`)}>アーカイブルールを作成</Button>
                      </SpaceBetween>
                    }
                  >
                    アーカイブルール
                  </Header>
                }
                items={a.archiveRules}
                trackBy="ruleName"
                selectionType="multi"
                selectedItems={a.archiveRules.filter((r) => sel.includes(r.ruleName))}
                onSelectionChange={(e) => setSel(e.detail.selectedItems.map((r) => r.ruleName))}
                ariaLabels={{ itemSelectionLabel: (_, r) => `${r.ruleName} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: 'アーカイブルール' }}
                empty="アーカイブルールはありません"
                columnDefinitions={[
                  { id: 'name', header: '名前', cell: (r) => r.ruleName },
                  { id: 'filter', header: '基準', cell: (r) => Object.entries(r.filter).map(([k, c]) => criterionText(k, c)).join('、') },
                  { id: 'created', header: '作成日時', cell: (r) => formatDate(r.createdAt) },
                  { id: 'updated', header: '更新日時', cell: (r) => formatDate(r.updatedAt) },
                ]}
              />
            ),
          },
          { id: 'tags', label: 'タグ', content: <Container><Box color="text-body-secondary">タグはありません。</Box></Container> },
        ]}
      />
    </SpaceBetween>
  );
}

interface Row {
  key: string;
  op: 'eq' | 'neq' | 'contains';
  value: string;
}

const toFilter = (rows: Row[]): FindingFilter => {
  const filter: FindingFilter = {};
  for (const r of rows) {
    const values = r.value.split(',').map((v) => v.trim()).filter(Boolean);
    if (values.length) filter[r.key] = { ...filter[r.key], [r.op]: values };
  }
  return filter;
};

/** Archive rule: criteria (property / operator / values), the active findings it matches, create (and archive them). */
export function CreateArchiveRulePage({ analyzer }: { analyzer: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const a = analyzersOf(env).find((x) => x.name === analyzer);
  const props = a && isUnusedAnalyzer(a) ? PROPERTIES.unused : PROPERTIES.external;
  const [ruleName, setRuleName] = useState(() => `ArchiveRule-${randomHex(8)}`);
  const [rows, setRows] = useState<Row[]>([{ key: props[0].value, op: 'eq', value: '' }]);
  const [error, setError] = useState<AwsError | null>(null);
  if (!a) return <NotFound what="アナライザー" id={analyzer} />;
  const filter = toFilter(rows);
  let valid = Object.keys(filter).length > 0;
  try {
    checkFilter(a, filter, true);
  } catch {
    valid = false;
  }
  const matching = valid ? a.findings.filter((f) => f.status === 'ACTIVE' && matchesFilter(f, filter)) : [];
  const setRow = (i: number, patch: Partial<Row>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const submit = (archive: boolean) => {
    const r = run(
      (d) => {
        createArchiveRule(d, a.name, ruleName.trim(), filter);
        return archive ? applyArchiveRule(d, a.arn, ruleName.trim()) : 0;
      },
      (n) => `アーカイブルール ${ruleName.trim()} を作成しました${archive ? ` (${n} 件の検出結果をアーカイブしました)` : ''}`,
    );
    if (r.ok) navigate(analyzerPath(a.name));
    else setError(r.error);
  };
  return (
    <Form
      header={<Header variant="h1" description="アーカイブルールは、ルールの基準に一致する新しい検出結果を自動的にアーカイブします。">アーカイブルールを作成</Header>}
      errorText={errorText(error)}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button variant="link" onClick={() => navigate(analyzerPath(a.name))}>キャンセル</Button>
          <Button disabled={!valid} onClick={() => submit(false)} data-testid="aa-rule-create">ルールを作成</Button>
          <Hotspot hotspotId="aa-rule-create-archive" direction="left">
            <Button variant="primary" disabled={!valid} onClick={() => submit(true)} data-testid="aa-rule-create-archive">アクティブな結果を作成してアーカイブする</Button>
          </Hotspot>
        </SpaceBetween>
      }
    >
      <SpaceBetween size="l">
        <Container header={<Header variant="h2">アーカイブルールの詳細</Header>}>
          <SpaceBetween size="l">
            <FormField label="ルール名" constraintText="先頭は英字。英数字と「_ . -」を使用できます。">
              <Input value={ruleName} onChange={(e) => setRuleName(e.detail.value)} data-testid="aa-rule-name" />
            </FormField>
            <FormField label="アナライザー">
              <Box>{a.name}</Box>
            </FormField>
          </SpaceBetween>
        </Container>
        <Container header={<Header variant="h2" description="すべての基準に一致する検出結果がアーカイブされます。値はカンマで区切って複数指定できます (どれかに一致)。">ルール</Header>}>
          <SpaceBetween size="m">
            {rows.map((r, i) => (
              <SpaceBetween key={i} direction="horizontal" size="xs">
                <FormField label="基準">
                  <Select selectedOption={props.find((p) => p.value === r.key) ?? null} options={props} onChange={(e) => setRow(i, { key: e.detail.selectedOption.value! })} />
                </FormField>
                <FormField label="演算子">
                  <Select selectedOption={OPERATORS.find((o) => o.value === r.op)!} options={OPERATORS} onChange={(e) => setRow(i, { op: e.detail.selectedOption.value as Row['op'] })} />
                </FormField>
                <FormField label="値">
                  <Input value={r.value} onChange={(e) => setRow(i, { value: e.detail.value })} placeholder={r.key === 'principal.AWS' ? '例: 111122223333' : r.key === 'isPublic' ? 'true または false' : r.key === 'resourceType' ? '例: AWS::S3::Bucket' : '値'} data-testid={`aa-rule-value-${i}`} />
                </FormField>
                <Box padding={{ top: 'l' }}>
                  <Button disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, n) => n !== i))}>この基準を削除</Button>
                </Box>
              </SpaceBetween>
            ))}
            <Button onClick={() => setRows([...rows, { key: props[0].value, op: 'eq', value: '' }])}>条件を追加</Button>
          </SpaceBetween>
        </Container>
        <Table
          variant="container"
          data-testid="aa-rule-preview"
          header={<Header counter={`(${matching.length})`} description="ルールに一致する、現在アクティブな検出結果です。「アクティブな結果を作成してアーカイブする」を選択すると、これらもアーカイブされます。">結果</Header>}
          items={matching}
          empty={valid ? '一致するアクティブな検出結果はありません' : '基準を入力すると、一致する検出結果が表示されます'}
          columnDefinitions={[
            { id: 'id', header: '検出結果 ID', cell: (f) => f.id },
            { id: 'resource', header: 'リソース', cell: (f) => resourceName(f.resource) },
            { id: 'principal', header: isUnusedAnalyzer(a) ? '結果タイプ' : '外部プリンシパル', cell: (f) => (isUnusedAnalyzer(a) ? FINDING_TYPE[f.findingType] : principalLabel(f)) },
          ]}
        />
      </SpaceBetween>
    </Form>
  );
}
