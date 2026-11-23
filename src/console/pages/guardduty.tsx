// Amazon GuardDuty (概要 / 検出結果 / 設定 / 抑制ルール) and the two remediation screens lesson 43 uses elsewhere:
// EC2 「インスタンスメタデータオプションを変更」 and the IAM role tab 「セッションを取り消す」.
import Alert from '@cloudscape-design/components/alert';
import Badge from '@cloudscape-design/components/badge';
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
import Modal from '@cloudscape-design/components/modal';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useState } from 'react';
import { label } from '../../sim/env';
import { metadataOptions, modifyInstanceMetadataOptions, REVOKE_POLICY_NAME, revokeOlderSessions, sessionsRevokedBefore, type MetadataOptions } from '../../sim/ext/credentials';
import { createFilter, deleteFilter, FILTER_FIELDS, findingMatches, findingResource, parseCriterion, SEVERITY_LEVELS, setArchived, severityLevel, suppressionRules, type Criterion, type Finding, type GuardDutyState, type RemoteIpDetails } from '../../sim/ext/guardduty';
import type { AwsError } from '../../sim/types';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, DeleteModal, EditForm, formatDate, JsonBlock, NotFound, queryParam, ResourceDetail, ResourceTable, useEnv, useGlobalEnv, useNavigate, useSelection, type Field } from '../ui';

// ---------------- GuardDuty ----------------

const BADGE = { 重大: 'severity-critical', 高: 'severity-high', 中: 'severity-medium', 低: 'severity-low' } as const;

export function SeverityBadge({ severity }: { severity: number }) {
  const l = severityLevel(severity);
  return <Badge color={BADGE[l.label]}>{l.label}</Badge>;
}

type Status = 'current' | 'archived' | 'all';
const STATUS_OPTIONS: { value: Status; label: string }[] = [
  { value: 'current', label: '現在' },
  { value: 'archived', label: 'アーカイブ済み' },
  { value: 'all', label: 'すべて' },
];
const findingsPath = (params: Record<string, string>) => `/guardduty/findings${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
const resourceText = (f: Finding) => `${f.resource.resourceType}: ${findingResource(f)}`;

/** Detector of the console's Region, or the "not enabled" page */
function useDetector(): GuardDutyState | undefined {
  return useEnv().guardDuty;
}

function NotEnabled() {
  return (
    <Alert type="info" header="このリージョンでは GuardDuty が有効になっていません">
      GuardDuty はリージョンごとに有効にします (ディテクターはリージョンに 1 つ)。右上のリージョンセレクターを確認してください。
    </Alert>
  );
}

export function GdSummary() {
  const d = useDetector();
  if (!d) return <NotEnabled />;
  const current = d.findings.filter((f) => !f.service.archived);
  const recent = [...current].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="GuardDuty は CloudTrail の管理イベント、VPC フローログ、DNS ログを継続的に分析し、脅威の可能性を検出結果として報告します。">概要</Header>
      <Container header={<Header variant="h2" description="アーカイブされていない検出結果の件数">検出結果</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          {SEVERITY_LEVELS.map((l) => (
            <div key={l.label} data-testid={`summary-${l.en.toLowerCase()}`}>
              <Box variant="awsui-key-label">
                <Badge color={BADGE[l.label]}>{l.label}</Badge>
              </Box>
              <Box variant="awsui-value-large">{current.filter((f) => severityLevel(f.severity) === l).length}</Box>
            </div>
          ))}
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2" actions={<ConsoleLink to="/guardduty/findings">すべての検出結果を表示</ConsoleLink>}>最近の検出結果</Header>}>
        <SpaceBetween size="s">
          {recent.map((f) => (
            <SpaceBetween key={f.id} direction="horizontal" size="xs" alignItems="center">
              <SeverityBadge severity={f.severity} />
              <ConsoleLink to={findingsPath({ id: f.id })}>{f.title}</ConsoleLink>
              <Box variant="small" color="text-body-secondary">{formatDate(f.updatedAt)}</Box>
            </SpaceBetween>
          ))}
          {!recent.length && <Box color="text-body-secondary">検出結果はありません</Box>}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

export function GdFindings() {
  const d = useDetector();
  const path = useConsole((s) => s.path);
  const run = useConsole((s) => s.run);
  const navigate = useNavigate();
  const status = (queryParam(path, 'status') as Status | undefined) ?? 'current';
  const open = queryParam(path, 'id');
  const findings = (d?.findings ?? []).filter((f) => status === 'all' || f.service.archived === (status === 'archived'));
  const [sel, setSel] = useSelection(findings, (f) => f.id);
  if (!d) return <NotEnabled />;
  const go = (p: { status?: Status; id?: string }) => navigate(findingsPath({ ...(p.status && p.status !== 'current' ? { status: p.status } : {}), ...(p.id ? { id: p.id } : {}) }));
  const archive = (archived: boolean) => {
    const ids = sel.map((f) => f.id);
    if (run((x) => setArchived(x, d.detectorId, ids, archived), `${ids.length} 件の検出結果を${archived ? 'アーカイブ' : 'アーカイブ解除'}しました`).ok) setSel([]);
  };
  const detail = d.findings.find((f) => f.id === open);
  return (
    <SpaceBetween size="l">
      <ResourceTable
        title="検出結果"
        resourceName="検出結果"
        testId="gd-findings"
        filterPlaceholder="検出結果をフィルタリング (タイトル、タイプ、リソース...)"
        selectionType="multi"
        items={[...findings].sort((a, b) => b.severity - a.severity || b.updatedAt.localeCompare(a.updatedAt))}
        trackBy={(f) => f.id}
        selectedItems={sel}
        onSelectionChange={setSel}
        columns={[
          { id: 'severity', header: '重要度', cell: (f) => <SeverityBadge severity={f.severity} />, value: (f) => f.severity, width: 100 },
          { id: 'title', header: 'タイトル', cell: (f) => <ConsoleLink to={findingsPath({ ...(status !== 'current' ? { status } : {}), id: f.id })} testId={`finding-${f.id}`}>{f.title}</ConsoleLink>, value: (f) => f.title },
          { id: 'type', header: '検出結果タイプ', cell: (f) => f.type, value: (f) => f.type },
          { id: 'resource', header: 'リソース', cell: resourceText, value: resourceText },
          { id: 'lastSeen', header: '最終確認', cell: (f) => formatDate(f.service.eventLastSeen), value: (f) => f.service.eventLastSeen },
          { id: 'count', header: 'カウント', cell: (f) => f.service.count, value: (f) => f.service.count },
        ]}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <div data-testid="gd-status">
              <Select selectedOption={STATUS_OPTIONS.find((o) => o.value === status)!} options={STATUS_OPTIONS} onChange={(e) => go({ status: e.detail.selectedOption.value as Status })} />
            </div>
            <Hotspot hotspotId="gd-findings-actions" direction="left">
              <ActionMenu
                testId="gd-actions"
                items={[
                  { id: 'archive', text: 'アーカイブ', disabled: !sel.length || sel.some((f) => f.service.archived), onClick: () => archive(true) },
                  { id: 'unarchive', text: 'アーカイブ解除', disabled: !sel.length || sel.some((f) => !f.service.archived), onClick: () => archive(false) },
                ]}
              />
            </Hotspot>
          </SpaceBetween>
        }
      />
      {detail && <FindingDetail f={detail} onClose={() => go({ status })} />}
    </SpaceBetween>
  );
}

function ipFields(prefix: string, ip?: RemoteIpDetails): Field[] {
  if (!ip) return [];
  return [
    { label: `${prefix} IP アドレス`, value: <CopyableValue value={ip.ipAddressV4} /> },
    { label: '場所', value: ip.city || ip.country ? [ip.city?.cityName, ip.country?.countryName].filter(Boolean).join(', ') : '-' },
    { label: '組織', value: ip.organization ? `${ip.organization.org} (ISP: ${ip.organization.isp})` : '-' },
    { label: 'ASN', value: ip.organization ? `${ip.organization.asn} (${ip.organization.asnOrg})` : '-' },
  ];
}

export function FindingDetail({ f, onClose }: { f: Finding; onClose: () => void }) {
  const a = f.service.action;
  const ak = f.resource.accessKeyDetails;
  const inst = f.resource.instanceDetails;
  const nic = inst?.networkInterfaces[0];
  const level = severityLevel(f.severity);
  const remote = a.awsApiCallAction?.remoteIpDetails ?? a.networkConnectionAction?.remoteIpDetails ?? a.portProbeAction?.portProbeDetails[0]?.remoteIpDetails;
  return (
    <div data-testid="gd-finding-detail">
      <Container
        header={
          <Header variant="h2" description={f.description} actions={<Button variant="icon" iconName="close" ariaLabel="閉じる" onClick={onClose} />}>
            <SpaceBetween direction="horizontal" size="xs" alignItems="center">
              <SeverityBadge severity={f.severity} />
              <span>{f.title}</span>
            </SpaceBetween>
          </Header>
        }
      >
        <SpaceBetween size="l">
          <ResourceDetail
            title="概要"
            columns={3}
            fields={[
              { label: '重要度', value: `${level.label} (${f.severity.toFixed(1)})` },
              { label: '検出結果タイプ', value: f.type },
              { label: 'リージョン', value: f.region },
              { label: 'カウント', value: String(f.service.count) },
              { label: 'アカウント ID', value: f.accountId },
              { label: 'リソース ID', value: findingResource(f) },
              { label: '作成時刻', value: formatDate(f.createdAt) },
              { label: '更新時刻', value: formatDate(f.updatedAt) },
              { label: '検出結果 ID', value: <CopyableValue value={f.id} /> },
            ]}
          />
          <ResourceDetail
            title="影響を受けるリソース"
            columns={3}
            fields={[
              { label: 'リソースロール', value: f.service.resourceRole },
              { label: 'リソースタイプ', value: f.resource.resourceType },
              ...(ak
                ? [
                    { label: 'アクセスキー ID', value: <CopyableValue value={ak.accessKeyId} testId="gd-access-key" /> },
                    { label: 'プリンシパル ID', value: ak.principalId },
                    { label: 'ユーザータイプ', value: ak.userType },
                    { label: 'ユーザーネーム', value: <ConsoleLink to={`/iam/roles/${ak.userName}`}>{ak.userName}</ConsoleLink> },
                  ]
                : []),
              ...(inst
                ? [
                    { label: 'インスタンス ID', value: <ConsoleLink to={`/ec2/instances/${inst.instanceId}`}>{inst.instanceId}</ConsoleLink> },
                    { label: 'インスタンスタイプ', value: inst.instanceType },
                    { label: 'インスタンスの状態', value: inst.instanceState },
                    { label: 'イメージ ID', value: inst.imageId },
                    { label: 'IAM インスタンスプロファイル', value: inst.iamInstanceProfile?.arn ?? '-' },
                    { label: 'パブリック IP', value: nic?.publicIp ?? '-' },
                    { label: 'セキュリティグループ', value: nic?.securityGroups.map((g) => `${g.groupName} (${g.groupId})`).join(', ') ?? '-' },
                    { label: 'タグ', value: inst.tags.map((t) => `${t.key}: ${t.value}`).join(', ') || '-' },
                  ]
                : []),
            ]}
          />
          <ResourceDetail
            title="アクション"
            columns={3}
            fields={[
              { label: 'アクションタイプ', value: a.actionType },
              ...(a.awsApiCallAction
                ? [
                    { label: 'API', value: a.awsApiCallAction.api },
                    { label: 'サービス名', value: a.awsApiCallAction.serviceName },
                    { label: '発信者のタイプ', value: a.awsApiCallAction.callerType },
                    { label: 'ユーザーエージェント', value: <Box variant="small">{a.awsApiCallAction.userAgent ?? '-'}</Box> },
                  ]
                : []),
              ...(a.networkConnectionAction
                ? [
                    { label: '接続の方向', value: a.networkConnectionAction.connectionDirection },
                    { label: 'プロトコル', value: a.networkConnectionAction.protocol },
                    { label: 'リモートポート', value: `${a.networkConnectionAction.remotePortDetails.port} (${a.networkConnectionAction.remotePortDetails.portName})` },
                  ]
                : []),
              ...(a.portProbeAction ? [{ label: 'プローブされたポート', value: a.portProbeAction.portProbeDetails.map((p) => `${p.localPortDetails.port} (${p.localPortDetails.portName})`).join(', ') }, { label: 'ブロック済み', value: String(a.portProbeAction.blocked) }] : []),
              { label: '最初の確認', value: formatDate(f.service.eventFirstSeen) },
              { label: '最後の確認', value: formatDate(f.service.eventLastSeen) },
            ]}
          />
          {/* the resource is the target: the section describes who acted on it (actor); an actor resource: its target */}
          <ResourceDetail title={f.service.resourceRole === 'TARGET' ? 'アクター' : 'ターゲット'} columns={4} fields={ipFields(f.service.resourceRole === 'TARGET' ? 'アクターの' : 'ターゲットの', remote)} />
          <ResourceDetail title="追加情報" columns={3} fields={[{ label: 'アーカイブ済み', value: String(f.service.archived) }, { label: 'サンプル', value: 'false' }]} />
          <ExpandableSection headerText="JSON">
            <JsonBlock value={f} testId="gd-finding-json" />
          </ExpandableSection>
        </SpaceBetween>
      </Container>
    </div>
  );
}

export function GdSettings() {
  const d = useDetector();
  const env = useEnv();
  if (!d) return <NotEnabled />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1">設定</Header>
      <ResourceDetail
        title="ディテクター"
        columns={2}
        fields={[
          { label: 'ディテクター ID', value: <CopyableValue value={d.detectorId} testId="gd-detector-id" /> },
          { label: 'ステータス', value: d.status === 'ENABLED' ? <StatusIndicator type="success">有効</StatusIndicator> : <StatusIndicator type="stopped">停止中</StatusIndicator> },
          { label: '有効にした日時', value: formatDate(d.createdAt) },
          { label: '更新された検出結果の頻度', value: { FIFTEEN_MINUTES: '15 分ごと', ONE_HOUR: '1 時間ごと', SIX_HOURS: '6 時間ごと (デフォルト)' }[d.findingPublishingFrequency] },
          { label: 'サービスロール', value: `arn:aws:iam::${env.accountId}:role/aws-service-role/guardduty.amazonaws.com/AWSServiceRoleForAmazonGuardDuty` },
          { label: '基本データソース', value: 'AWS CloudTrail 管理イベント、VPC フローログ、DNS ログ' },
        ]}
      />
    </SpaceBetween>
  );
}

const criterionText = (c: Criterion) =>
  Object.entries(c)
    .map(([field, cond]) => `${FILTER_FIELDS[field] ?? field} ${Object.entries(cond).map(([op, v]) => `${/^(Neq|NotEquals|NotMatches)$/.test(op) ? '!=' : /^(Eq|Equals|Matches)$/.test(op) ? '=' : op} ${Array.isArray(v) ? v.join(', ') : v}`).join(' ')}`)
    .join(' かつ ');

export function GdSuppressionRules() {
  const d = useDetector();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const rules = d ? suppressionRules(d) : [];
  const [sel, setSel] = useSelection(rules, (r) => r.name);
  const [deleting, setDeleting] = useState(false);
  if (!d) return <NotEnabled />;
  return (
    <>
      <ResourceTable
        title="抑制ルール"
        description="抑制ルールに一致する新しい検出結果は、自動的にアーカイブされます。すでにある検出結果はアーカイブされません。"
        resourceName="抑制ルール"
        testId="gd-suppression-rules"
        items={rules}
        trackBy={(r) => r.name}
        selectedItems={sel}
        onSelectionChange={setSel}
        columns={[
          { id: 'name', header: '名前', cell: (r) => r.name, value: (r) => r.name },
          { id: 'desc', header: '説明', cell: (r) => r.description ?? '-', value: (r) => r.description ?? '' },
          { id: 'criteria', header: '条件', cell: (r) => criterionText(r.criterion), value: (r) => criterionText(r.criterion) },
          { id: 'rank', header: 'ランク', cell: (r) => r.rank, value: (r) => r.rank },
        ]}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button disabled={!sel.length} onClick={() => setDeleting(true)}>削除</Button>
            <Hotspot hotspotId="gd-create-suppression" direction="left">
              <Button variant="primary" onClick={() => navigate('/guardduty/suppression-rules/create')} data-testid="gd-create-suppression">抑制ルールを作成</Button>
            </Hotspot>
          </SpaceBetween>
        }
      />
      {deleting && sel[0] && (
        <DeleteModal header={`抑制ルール ${sel[0].name} を削除しますか?`} onClose={() => setDeleting(false)} onDelete={() => run((x) => deleteFilter(x, d.detectorId, sel[0].name), `抑制ルール ${sel[0].name} を削除しました`)}>
          削除すると、一致する新しい検出結果は再び「現在」に表示されるようになります。
        </DeleteModal>
      )}
    </>
  );
}

interface Row {
  field: string;
  op: '=' | '!=';
  values: string;
}
const KEY_OPTIONS = Object.entries(FILTER_FIELDS).map(([value, text]) => ({ value, label: text, description: value }));
const OP_OPTIONS = [
  { value: '=', label: '= (等しい)' },
  { value: '!=', label: '!= (等しくない)' },
];

export function CreateSuppressionRule() {
  const d = useDetector();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<Row[]>([{ field: 'type', op: '=', values: '' }]);
  const [error, setError] = useState<AwsError | null>(null);
  if (!d) return <NotEnabled />;
  const raw = Object.fromEntries(rows.filter((r) => r.values.trim()).map((r) => [r.field, { [r.op === '=' ? 'Equals' : 'NotEquals']: r.values.split(',').map((v) => v.trim()).filter(Boolean) }]));
  let criterion: Criterion = {};
  try {
    criterion = parseCriterion(raw, { wildcards: true });
  } catch {
    criterion = {};
  }
  const matched = Object.keys(criterion).length ? d.findings.filter((f) => findingMatches({ ...f, service: { ...f.service, archived: false } }, criterion)) : [];
  const set = (n: number, patch: Partial<Row>) => setRows(rows.map((r, i) => (i === n ? { ...r, ...patch } : r)));
  return (
    <EditForm
      title="抑制ルールを作成"
      description="条件に一致する新しい検出結果を自動的にアーカイブします。誤検知だと確かめた、決まった動作だけに絞り込んでください。"
      submitText="抑制ルールを作成"
      submitTestId="gd-suppression-submit"
      submitHotspotId="gd-suppression-submit"
      onCancel={() => navigate('/guardduty/suppression-rules')}
      error={error}
      onSubmit={() => {
        const r = run((x) => createFilter(x, d.detectorId, { name: name.trim(), description: description.trim() || undefined, action: 'ARCHIVE', criterion: parseCriterion(raw, { wildcards: true }) }), `抑制ルール ${name.trim()} を作成しました`);
        if (r.ok) navigate('/guardduty/suppression-rules');
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">抑制ルールの詳細</Header>}>
        <SpaceBetween size="l">
          <FormField label="名前" constraintText="3〜64 文字。英数字、ピリオド (.)、ハイフン (-)、アンダースコア (_) が使えます。">
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="scanner-portscan" data-testid="gd-rule-name" />
          </FormField>
          <FormField label={<span>説明 <i>- オプション</i></span>}>
            <Input value={description} onChange={(e) => setDescription(e.detail.value)} data-testid="gd-rule-description" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="条件はすべて満たすもの (AND) に一致します。値はカンマ区切りで複数書けます (どれか 1 つに一致)。">条件</Header>}>
        <SpaceBetween size="m">
          {rows.map((r, n) => (
            <SpaceBetween key={n} direction="horizontal" size="xs" alignItems="end">
              <FormField label={n === 0 ? 'キー' : undefined}>
                <div data-testid={`gd-rule-key-${n}`} style={{ minWidth: 260 }}>
                  <Select selectedOption={KEY_OPTIONS.find((o) => o.value === r.field)!} options={KEY_OPTIONS} filteringType="auto" onChange={(e) => set(n, { field: e.detail.selectedOption.value! })} />
                </div>
              </FormField>
              <FormField label={n === 0 ? '演算子' : undefined}>
                <Select selectedOption={OP_OPTIONS.find((o) => o.value === r.op)!} options={OP_OPTIONS} onChange={(e) => set(n, { op: e.detail.selectedOption.value as Row['op'] })} />
              </FormField>
              <FormField label={n === 0 ? '値' : undefined}>
                <Input value={r.values} onChange={(e) => set(n, { values: e.detail.value })} data-testid={`gd-rule-value-${n}`} />
              </FormField>
              <Button formAction="none" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, i) => i !== n))}>削除</Button>
            </SpaceBetween>
          ))}
          <Button formAction="none" onClick={() => setRows([...rows, { field: 'resource.instanceDetails.instanceId', op: '=', values: '' }])} data-testid="gd-rule-add">条件を追加</Button>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" counter={`(${matched.length})`} description="今ある検出結果のうち、この条件に一致するもの (アーカイブ済みを含む)。">一致する検出結果</Header>}>
        <div data-testid="gd-rule-matches">
          <SpaceBetween size="xs">
            {matched.map((f) => (
              <SpaceBetween key={f.id} direction="horizontal" size="xs" alignItems="center">
                <SeverityBadge severity={f.severity} />
                <span>{f.title}</span>
              </SpaceBetween>
            ))}
            {!matched.length && <Box color="text-body-secondary">一致する検出結果はありません</Box>}
          </SpaceBetween>
        </div>
      </Container>
    </EditForm>
  );
}

// ---------------- EC2: インスタンスメタデータオプションを変更 ----------------

export function ModifyMetadataOptions({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const i = env.instances.find((x) => x.instanceId === id);
  const [o, setO] = useState<MetadataOptions | null>(i ? metadataOptions(i) : null);
  const [error, setError] = useState<AwsError | null>(null);
  if (!i || !o) return <NotFound what="インスタンス" id={id} />;
  const enabled = o.httpEndpoint === 'enabled';
  return (
    <EditForm
      title="インスタンスメタデータオプションを変更"
      description="インスタンスメタデータサービス (IMDS) は、インスタンスの中からだけ http://169.254.169.254 で使える、インスタンス自身の情報とロールの一時的な認証情報の窓口です。"
      submitText="保存"
      submitTestId="imds-save"
      submitHotspotId="ec2-imds-save"
      onCancel={() => navigate(`/ec2/instances/${id}`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => modifyInstanceMetadataOptions(d, id, o), `${id} のインスタンスメタデータオプションを正常に変更しました`);
        if (r.ok) navigate(`/ec2/instances/${id}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">インスタンスメタデータオプション</Header>}>
        <SpaceBetween size="l">
          <FormField label="インスタンス ID">{label(i.instanceId, i)}</FormField>
          <FormField label="インスタンスメタデータサービス" description="無効にすると、インスタンスの中のアプリや AWS CLI もロールの認証情報を受け取れなくなります。">
            <Checkbox checked={enabled} onChange={(e) => setO({ ...o, httpEndpoint: e.detail.checked ? 'enabled' : 'disabled' })} data-testid="imds-enabled">
              有効化
            </Checkbox>
          </FormField>
          <FormField label="IMDSv2" description="必須にすると、セッショントークンを付けないリクエスト (IMDSv1) には 401 Unauthorized を返します。">
            <div data-testid="imds-tokens">
              <RadioGroup
                value={o.httpTokens}
                onChange={(e) => setO({ ...o, httpTokens: e.detail.value as MetadataOptions['httpTokens'] })}
                items={[
                  { value: 'optional', label: 'オプション', description: 'IMDSv1 と IMDSv2 のどちらのリクエストにも応答します', disabled: !enabled },
                  { value: 'required', label: '必須', description: 'IMDSv2 のセッショントークン付きのリクエストにだけ応答します', disabled: !enabled },
                ]}
              />
            </div>
          </FormField>
          <FormField label="メタデータレスポンスのホップ制限" description="トークンを取得する PUT の応答が届くネットワークホップ数 (1〜64)。コンテナから使うときは 2 にします。">
            <Input type="number" value={String(o.httpPutResponseHopLimit)} disabled={!enabled} onChange={(e) => setO({ ...o, httpPutResponseHopLimit: Number(e.detail.value) })} />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- IAM: ロールの「セッションを取り消す」タブ ----------------

export function RevokeSessions({ name }: { name: string }) {
  const env = useGlobalEnv();
  const run = useConsole((s) => s.run);
  const [open, setOpen] = useState(false);
  const [ack, setAck] = useState(false);
  const before = sessionsRevokedBefore(env, name);
  const close = () => {
    setOpen(false);
    setAck(false);
  };
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="このロールを引き受けて発行された一時的な認証情報のうち、今より前に発行されたものをすべて拒否します。ロールにインラインポリシー AWSRevokeOlderSessions を追加し、すべてのアクションを aws:TokenIssueTime の条件付きで拒否します。"
          actions={
            <Hotspot hotspotId="iam-revoke-sessions" direction="left">
              <Button onClick={() => setOpen(true)} data-testid="revoke-sessions">アクティブなセッションを取り消す</Button>
            </Hotspot>
          }
        >
          セッションを取り消す
        </Header>
      }
    >
      <SpaceBetween size="m">
        {before !== undefined ? (
          <Alert type="success" header="アクティブなセッションは取り消されています">
            {formatDate(before)} より前に発行された認証情報は、インラインポリシー {REVOKE_POLICY_NAME} で拒否されます。これより後に発行された新しい認証情報には影響しません。
          </Alert>
        ) : (
          <Box color="text-body-secondary">このロールのセッションは取り消されていません。</Box>
        )}
        {open && (
          <Modal
            visible
            onDismiss={close}
            header="アクティブなセッションを取り消しますか?"
            footer={
              <Box float="right">
                <SpaceBetween direction="horizontal" size="xs">
                  <Button variant="link" onClick={close}>キャンセル</Button>
                  <Button
                    variant="primary"
                    disabled={!ack}
                    data-testid="revoke-sessions-confirm"
                    onClick={() => {
                      if (run((d) => revokeOlderSessions(d, name), `ロール ${name} のアクティブなセッションを取り消しました`).ok) close();
                    }}
                  >
                    アクティブなセッションを取り消す
                  </Button>
                </SpaceBetween>
              </Box>
            }
          >
            <SpaceBetween size="m">
              <Alert type="warning">このロールの今のセッションを使っているすべてのユーザーとアプリケーション (EC2 インスタンスを含む) が、すべてのアクションを拒否されます。新しい認証情報を取得し直すまで、作業中の処理が失敗する可能性があります。</Alert>
              <Checkbox checked={ack} onChange={(e) => setAck(e.detail.checked)} data-testid="revoke-sessions-ack">
                このロールのすべてのアクティブなセッションを取り消すことを了承します。
              </Checkbox>
            </SpaceBetween>
          </Modal>
        )}
      </SpaceBetween>
    </Container>
  );
}

