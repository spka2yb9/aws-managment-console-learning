// AWS Security Hub CSPM console (lesson 44): summary with the security score, standards, controls, findings (ASFF)
// with workflow status, automation rules. Japanese labels follow the Security Hub CSPM console.
import Alert from '@cloudscape-design/components/alert';
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
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator, { type StatusIndicatorProps } from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import { useMemo, useState } from 'react';
import {
  asff,
  batchDisableStandards,
  batchEnableStandards,
  batchUpdateFindings,
  controlDef,
  controlStatus,
  createAutomationRule,
  deleteAutomationRules,
  enableSecurityHub,
  enabledControls,
  fresh,
  NORMALIZED,
  previewRule,
  securityScore,
  SEVERITIES,
  STANDARDS,
  subscriptionArn,
  WORKFLOW_STATUSES,
  type ComplianceStatus,
  type ControlStatus,
  type Finding,
  type FindingFilters,
  type SeverityLabel,
  type StandardKey,
  type WorkflowStatus,
} from '../../sim/ext/securityhub';
import type { AwsEnv, AwsError } from '../../sim/types';
import { useConsole } from '../store';
import { ActionMenu, CONSOLE_USER_ARN, ConsoleLink, CopyableValue, EditForm, formatDate, JsonBlock, NotFound, queryParam, ResourceDetail, ResourceTable, useEnv, useNavigate, useSelection } from '../ui';

/* ---------------- labels ---------------- */

const SEVERITY: Record<SeverityLabel, [StatusIndicatorProps.Type, string]> = { CRITICAL: ['error', '重大'], HIGH: ['warning', '高'], MEDIUM: ['info', '中'], LOW: ['stopped', '低'], INFORMATIONAL: ['stopped', '情報'] };
const CONTROL_STATUS: Record<ControlStatus, [StatusIndicatorProps.Type, string]> = { PASSED: ['success', '合格'], FAILED: ['error', '失敗'], UNKNOWN: ['warning', '不明'], NO_DATA: ['stopped', 'データなし'] };
const COMPLIANCE: Record<ComplianceStatus, [StatusIndicatorProps.Type, string]> = { PASSED: ['success', '合格'], FAILED: ['error', '失敗'], WARNING: ['warning', '警告'], NOT_AVAILABLE: ['stopped', '利用不可'] };
export const WORKFLOW_LABEL: Record<WorkflowStatus, string> = { NEW: '新規', NOTIFIED: '通知済み', SUPPRESSED: '抑制済み', RESOLVED: '解決済み' };

const Severity = ({ s }: { s: SeverityLabel }) => <StatusIndicator type={SEVERITY[s][0]}>{SEVERITY[s][1]}</StatusIndicator>;
const Status = ({ s }: { s: ControlStatus }) => <StatusIndicator type={CONTROL_STATUS[s][0]}>{CONTROL_STATUS[s][1]}</StatusIndicator>;
const Compliance = ({ s }: { s?: ComplianceStatus }) => (s ? <StatusIndicator type={COMPLIANCE[s][0]}>{COMPLIANCE[s][1]}</StatusIndicator> : <>-</>);
const STATUS_ORDER: ControlStatus[] = ['FAILED', 'UNKNOWN', 'NO_DATA', 'PASSED'];
const rank = (s: SeverityLabel) => NORMALIZED[s];

/** the console's env (selected Region) with Security Hub up to date */
function useHubEnv(): AwsEnv {
  const env = useEnv();
  return useMemo(() => fresh(env), [env]);
}

const hubOn = (env: AwsEnv) => !!env.securityHub?.hub;
const controlPath = (id: string) => `/securityhub/controls/${id}`;
const findingPath = (f: Finding) => `/securityhub/findings/view?${new URLSearchParams({ id: f.id })}`;
/** EC2 / RDS / S3 page of a finding's resource, when it still exists */
function resourceLink(env: AwsEnv, f: Finding) {
  const id = f.resource.id;
  const tail = id.split(/[/:]/).pop() ?? id;
  const name = f.resource.tags.Name ? `${tail} (${f.resource.tags.Name})` : tail;
  const to =
    f.resource.type === 'AwsEc2SecurityGroup' && env.securityGroups.some((g) => g.groupId === tail) ? `/ec2/security-groups/${tail}`
    : f.resource.type === 'AwsEc2Instance' && env.instances.some((i) => i.instanceId === tail) ? `/ec2/instances/${tail}`
    : f.resource.type === 'AwsRdsDbInstance' && env.dbInstances.some((d) => d.dbInstanceIdentifier === tail) ? `/rds/databases/${tail}`
    : f.resource.type === 'AwsS3Bucket' && env.buckets.some((b) => b.name === tail) ? `/s3/buckets/${tail}`
    : '';
  return to ? <ConsoleLink to={to}>{name}</ConsoleLink> : name;
}

function NotEnabled() {
  return (
    <Alert type="info" header="Security Hub CSPM が有効になっていません" action={<ConsoleLink to="/securityhub/home">Security Hub CSPM を有効にする</ConsoleLink>}>
      このアカウントのこのリージョンでは、AWS Security Hub CSPM はまだ有効になっていません。
    </Alert>
  );
}

/* ---------------- workflow status ---------------- */

/** 「ワークフローのステータス」▼ → 「ワークフローのステータスの設定」ダイアログ (メモは任意) */
function WorkflowMenu({ selected, onDone }: { selected: Finding[]; onDone?: () => void }) {
  const run = useConsole((s) => s.run);
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const close = () => {
    setStatus(null);
    setNote('');
    setError(null);
  };
  return (
    <>
      <Hotspot hotspotId="sh-workflow" direction="left">
        <ActionMenu
          text="ワークフローのステータス"
          testId="sh-workflow"
          items={WORKFLOW_STATUSES.map((s) => ({ id: s, text: WORKFLOW_LABEL[s], disabled: !selected.length, disabledReason: '検出結果を選択してください', onClick: () => setStatus(s) }))}
        />
      </Hotspot>
      {status && (
        <Modal
          visible
          onDismiss={close}
          header="ワークフローのステータスの設定"
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={close}>キャンセル</Button>
                <Button
                  variant="primary"
                  data-testid="sh-set-status"
                  onClick={() => {
                    const text = note.trim();
                    const r = run(
                      (d) => batchUpdateFindings(d, selected.map((f) => ({ Id: f.id, ProductArn: f.productArn })), { Workflow: { Status: status }, ...(text ? { Note: { Text: text, UpdatedBy: CONSOLE_USER_ARN(d) } } : {}) }),
                      `${selected.length} 件の検出結果のワークフローのステータスを「${WORKFLOW_LABEL[status]}」に設定しました`,
                    );
                    if (!r.ok) return setError(r.error);
                    close();
                    onDone?.();
                  }}
                >
                  ステータスの設定
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <Box>{`${selected.length} 件の検出結果のワークフローのステータスを「${WORKFLOW_LABEL[status]}」に設定します。`}</Box>
            {status === 'SUPPRESSED' && <Alert type="warning">抑制した検出結果は、コントロールのステータスとセキュリティスコアの計算から除かれます。対応が不要だと判断した理由をメモに残してください。</Alert>}
            <FormField label="メモ - オプション" description="ステータスを変更する理由を入力します。" errorText={error ? `${error.message} (${error.code})` : undefined}>
              <Textarea value={note} onChange={(e) => setNote(e.detail.value)} placeholder="例: ニュースレターの画像配信用に意図して公開している" data-testid="sh-note" />
            </FormField>
          </SpaceBetween>
        </Modal>
      )}
    </>
  );
}

/* ---------------- summary / enable ---------------- */

export function SecurityHubHome() {
  const env = useHubEnv();
  return hubOn(env) ? <Summary env={env} /> : <EnableHub />;
}

function EnableHub() {
  const run = useConsole((s) => s.run);
  const [picked, setPicked] = useState<StandardKey[]>(STANDARDS.map((s) => s.key));
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="AWS のベストプラクティスと業界標準に照らしてセキュリティ体制 (CSPM) を自動でチェックし、AWS のサービスやパートナー製品の検出結果を 1 か所に集めます。">
        AWS Security Hub CSPM
      </Header>
      <Alert type="info" header="Security Hub と Security Hub CSPM">
        2025 年から、これまでの Security Hub は「Security Hub CSPM」という名前になりました。新しい「Security Hub」は、Security Hub CSPM や GuardDuty などの結果をさらにまとめて分析するサービスです。このページは Security Hub CSPM です。
      </Alert>
      <Container header={<Header variant="h2">Security Hub CSPM を有効にする</Header>}>
        <SpaceBetween size="l">
          <FormField label="セキュリティ標準" description="有効にするセキュリティ標準を選択します。標準のコントロールが、アカウントのリソースを自動でチェックします。">
            <SpaceBetween size="xs">
              {STANDARDS.map((s) => (
                <Checkbox key={s.key} checked={picked.includes(s.key)} onChange={(e) => setPicked(e.detail.checked ? [...picked, s.key] : picked.filter((k) => k !== s.key))}>
                  {`${s.nameJa} を有効化`}
                </Checkbox>
              ))}
            </SpaceBetween>
          </FormField>
          <Box variant="small" color="text-body-secondary">コントロールの多くは AWS Config のルールを使ってチェックします。AWS Config のリソースの記録が必要です (このシミュレーターでは記録済みです)。</Box>
          {error && <Alert type="error">{`${error.message} (${error.code})`}</Alert>}
          <Hotspot hotspotId="sh-enable" direction="right">
            <Button
              variant="primary"
              data-testid="sh-enable"
              onClick={() => {
                const r = run((d) => {
                  const all = STANDARDS.every((s) => picked.includes(s.key));
                  enableSecurityHub(d, { enableDefaultStandards: all });
                  if (!all && picked.length) batchEnableStandards(d, picked.map((k) => STANDARDS.find((s) => s.key === k)!.arn(d.region)));
                }, 'Security Hub CSPM を有効にしました。');
                if (!r.ok) setError(r.error);
              }}
            >
              Security Hub CSPM を有効にする
            </Button>
          </Hotspot>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

function Summary({ env }: { env: AwsEnv }) {
  const all = securityScore(env);
  const failed = enabledControls(env).filter((c) => controlStatus(env, c.id) === 'FAILED').sort((a, b) => rank(b.severity) - rank(a.severity));
  const open = env.securityHub!.findings.filter((f) => f.recordState === 'ACTIVE' && (f.workflow === 'NEW' || f.workflow === 'NOTIFIED'));
  const products = [...new Set(open.map((f) => f.productName))];
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="有効にしたセキュリティ標準のコントロールのチェック結果と、集まった検出結果の概要です。">概要</Header>
      <ColumnLayout columns={2}>
        <Container header={<Header variant="h2" description="合格したコントロール ÷ 有効なコントロール (データなしを除く)">セキュリティスコア</Header>}>
          <div data-testid="sh-score">
            <Box variant="awsui-value-large">{all.score === null ? '-' : `${all.score}%`}</Box>
            <Box color="text-body-secondary">{`${all.total} 件中 ${all.passed} 件のコントロールが合格`}</Box>
          </div>
        </Container>
        <Container header={<Header variant="h2">失敗したコントロール (重要度別)</Header>}>
          <ColumnLayout columns={4} variant="text-grid">
            {SEVERITIES.slice(0, 4).map((s) => (
              <div key={s}>
                <Box variant="awsui-key-label"><Severity s={s} /></Box>
                <Box variant="h2" data-testid={`sh-failed-${s}`}>{failed.filter((c) => c.severity === s).length}</Box>
              </div>
            ))}
          </ColumnLayout>
        </Container>
      </ColumnLayout>
      <Table
        variant="container"
        header={<Header counter={`(${env.securityHub!.standards.length})`}>セキュリティ標準</Header>}
        items={env.securityHub!.standards.map((s) => ({ s, def: STANDARDS.find((x) => x.key === s.key)!, score: securityScore(env, s.key) }))}
        empty="有効なセキュリティ標準はありません"
        columnDefinitions={[
          { id: 'name', header: '名前', cell: (x) => x.def.nameJa },
          { id: 'score', header: 'セキュリティスコア', cell: (x) => (x.score.score === null ? '-' : `${x.score.score}%`) },
          { id: 'view', header: '', cell: (x) => <ConsoleLink to={`/securityhub/controls?standard=${x.s.key}`}>結果を表示</ConsoleLink> },
        ]}
      />
      <Table
        variant="container"
        data-testid="sh-failed-controls"
        header={<Header counter={`(${failed.length})`} description="重要度の高いものから対応します。">失敗したコントロール</Header>}
        items={failed}
        empty="失敗したコントロールはありません"
        columnDefinitions={[
          { id: 'sev', header: '重要度', cell: (c) => <Severity s={c.severity} /> },
          { id: 'id', header: 'ID', cell: (c) => <ConsoleLink to={controlPath(c.id)}>{c.id}</ConsoleLink> },
          { id: 'title', header: 'タイトル', cell: (c) => c.titleJa },
        ]}
      />
      <Container header={<Header variant="h2" description="ワークフローのステータスが「新規」または「通知済み」のアクティブな検出結果">検出結果 (製品別)</Header>}>
        <ColumnLayout columns={Math.max(products.length, 1)} variant="text-grid">
          {products.map((p) => (
            <div key={p}>
              <Box variant="awsui-key-label">{p}</Box>
              <ConsoleLink to="/securityhub/findings">{`${open.filter((f) => f.productName === p).length} 件`}</ConsoleLink>
            </div>
          ))}
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}

/* ---------------- standards ---------------- */

export function SecurityHubStandards() {
  const env = useHubEnv();
  const run = useConsole((s) => s.run);
  if (!hubOn(env)) return <NotEnabled />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="セキュリティ標準は、規制の枠組みや業界のベストプラクティスに基づくコントロールのまとまりです。">セキュリティ標準</Header>
      {STANDARDS.map((s) => {
        const on = env.securityHub!.standards.some((x) => x.key === s.key);
        const sc = securityScore(env, s.key);
        return (
          <Container
            key={s.key}
            header={
              <Header
                variant="h2"
                description={on ? `セキュリティスコア ${sc.score ?? '-'}% (${sc.total} 件中 ${sc.passed} 件のコントロールが合格)` : '無効'}
                actions={
                  <SpaceBetween direction="horizontal" size="xs">
                    {on && <ConsoleLink to={`/securityhub/controls?standard=${s.key}`}>結果を表示</ConsoleLink>}
                    {on ? (
                      <Button onClick={() => run((d) => batchDisableStandards(d, [subscriptionArn(d, s.key)]), `${s.nameJa} を無効にしました`)}>標準を無効化</Button>
                    ) : (
                      <Button onClick={() => run((d) => batchEnableStandards(d, [s.arn(d.region)]), `${s.nameJa} を有効にしました`)}>標準を有効化</Button>
                    )}
                  </SpaceBetween>
                }
              >
                {s.nameJa}
              </Header>
            }
          >
            <Box variant="small">{s.description}</Box>
          </Container>
        );
      })}
    </SpaceBetween>
  );
}

/* ---------------- controls ---------------- */

export function SecurityHubControls() {
  const env = useHubEnv();
  const path = useConsole((s) => s.path);
  const [show, setShow] = useState<'ALL' | ControlStatus>('ALL');
  if (!hubOn(env)) return <NotEnabled />;
  const standard = queryParam(path, 'standard') as StandardKey | undefined;
  const def = STANDARDS.find((s) => s.key === standard);
  const score = securityScore(env, def?.key);
  const rows = enabledControls(env, def?.key)
    .map((c) => {
      const fs = env.securityHub!.findings.filter((f) => f.controlId === c.id && f.recordState === 'ACTIVE' && f.workflow !== 'SUPPRESSED');
      return { c, status: controlStatus(env, c.id), failed: fs.filter((f) => f.compliance === 'FAILED').length, checks: fs.length };
    })
    .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || rank(b.c.severity) - rank(a.c.severity));
  const shown = rows.filter((r) => show === 'ALL' || r.status === show);
  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2" description={def ? def.nameJa : '有効なすべての標準'}>セキュリティスコア</Header>}>
        <Box variant="awsui-value-large" data-testid="sh-controls-score">{score.score === null ? '-' : `${score.score}%`}</Box>
        <Box color="text-body-secondary">{`${score.total} 件中 ${score.passed} 件のコントロールが合格`}</Box>
      </Container>
      <ResourceTable
        title="コントロール"
        description="コントロールは、セキュリティ標準の 1 つのチェック項目です。ステータスは、アーカイブ済みと抑制済みを除いた検出結果から決まります。"
        items={shown}
        trackBy={(r) => r.c.id}
        selectionType="none"
        resourceName="コントロール"
        testId="sh-controls"
        variant="container"
        actions={
          <SegmentedControl
            label="ステータス"
            selectedId={show}
            onChange={(e) => setShow(e.detail.selectedId as typeof show)}
            options={[{ id: 'ALL', text: 'すべて' }, { id: 'FAILED', text: '失敗' }, { id: 'UNKNOWN', text: '不明' }, { id: 'NO_DATA', text: 'データなし' }, { id: 'PASSED', text: '合格' }]}
          />
        }
        columns={[
          { id: 'id', header: 'ID', cell: (r) => <ConsoleLink to={controlPath(r.c.id)}>{r.c.id}</ConsoleLink>, value: (r) => r.c.id },
          { id: 'title', header: 'タイトル', cell: (r) => r.c.titleJa, value: (r) => r.c.titleJa },
          { id: 'sev', header: '重要度', cell: (r) => <Severity s={r.c.severity} />, value: (r) => rank(r.c.severity) },
          { id: 'checks', header: '失敗したチェック', cell: (r) => `${r.failed}/${r.checks}`, value: (r) => r.failed },
          { id: 'status', header: 'ステータス', cell: (r) => <Status s={r.status} />, value: (r) => CONTROL_STATUS[r.status][1] },
        ]}
      />
    </SpaceBetween>
  );
}

export function ControlDetail({ id }: { id: string }) {
  const env = useHubEnv();
  const c = controlDef(id);
  const [selected, setSelected] = useSelection((env.securityHub?.findings ?? []).filter((f) => f.controlId === id && f.recordState === 'ACTIVE'), (f) => f.id);
  if (!hubOn(env)) return <NotEnabled />;
  if (!c) return <NotFound what="コントロール" id={id} />;
  const findings = env.securityHub!.findings.filter((f) => f.controlId === id && f.recordState === 'ACTIVE').sort((a, b) => (a.compliance === b.compliance ? 0 : a.compliance === 'FAILED' ? -1 : 1));
  const enabled = enabledControls(env).includes(c);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={c.titleJa}>{c.id}</Header>
      <ResourceDetail
        columns={3}
        fields={[
          { label: '重要度', value: <Severity s={c.severity} /> },
          { label: 'ステータス', value: <span data-testid="sh-control-status">{enabled ? <Status s={controlStatus(env, c.id)} /> : <StatusIndicator type="stopped">無効</StatusIndicator>}</span> },
          { label: 'セキュリティ標準', value: STANDARDS.filter((s) => c.standards[s.key]).map((s) => `${s.nameJa} (${c.standards[s.key]})`).join(' / ') },
          { label: 'AWS Config ルール', value: c.configRule },
          { label: 'スケジュールタイプ', value: c.schedule },
          { label: '修復', value: <CopyableValue value={`https://docs.aws.amazon.com/console/securityhub/${c.id}/remediation`} /> },
        ]}
      />
      <Container header={<Header variant="h2">説明</Header>}>{c.descriptionJa}</Container>
      <Table
        variant="container"
        data-testid="sh-control-findings"
        wrapLines
        selectionType="multi"
        trackBy="id"
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        ariaLabels={{ itemSelectionLabel: (_, f) => `${f.resource.id} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: '検出結果の選択' }}
        header={<Header counter={`(${findings.length})`} description="このコントロールが各リソースをチェックした結果 (検出結果) です。" actions={<WorkflowMenu selected={selected} onDone={() => setSelected([])} />}>チェック</Header>}
        items={findings}
        empty="検出結果はありません"
        columnDefinitions={[
          { id: 'c', header: 'コンプライアンスのステータス', cell: (f) => <Compliance s={f.compliance} /> },
          { id: 'w', header: 'ワークフローのステータス', cell: (f) => WORKFLOW_LABEL[f.workflow] },
          { id: 'res', header: 'リソース', cell: (f) => resourceLink(env, f) },
          { id: 'type', header: 'リソースタイプ', cell: (f) => f.resource.type },
          { id: 'note', header: 'メモ', cell: (f) => f.note?.text ?? '-' },
          { id: 'at', header: '更新日時', cell: (f) => <ConsoleLink to={findingPath(f)}>{formatDate(f.updatedAt)}</ConsoleLink> },
        ]}
      />
    </SpaceBetween>
  );
}

/* ---------------- findings ---------------- */

export function SecurityHubFindings() {
  const env = useHubEnv();
  const [show, setShow] = useState<'open' | 'active'>('open');
  const all = (env.securityHub?.findings ?? []).filter((f) => f.recordState === 'ACTIVE' && (show === 'active' || f.workflow === 'NEW' || f.workflow === 'NOTIFIED'));
  const items = [...all].sort((a, b) => rank(b.severity) - rank(a.severity) || b.updatedAt - a.updatedAt);
  const [selected, setSelected] = useSelection(items, (f) => f.id);
  if (!hubOn(env)) return <NotEnabled />;
  return (
    <ResourceTable
      title="検出結果"
      description="Security Hub CSPM のコントロールのチェック結果と、統合した AWS サービス (GuardDuty など) から届いた検出結果です。形式は AWS Security Finding Format (ASFF) です。"
      items={items}
      trackBy={(f) => f.id}
      selectionType="multi"
      selectedItems={selected}
      onSelectionChange={setSelected}
      resourceName="検出結果"
      testId="sh-findings"
      actions={
        <SpaceBetween direction="horizontal" size="xs" alignItems="center">
          <SegmentedControl label="表示" selectedId={show} onChange={(e) => setShow(e.detail.selectedId as typeof show)} options={[{ id: 'open', text: '新規・通知済み' }, { id: 'active', text: 'すべてのアクティブ' }]} />
          <WorkflowMenu selected={selected} onDone={() => setSelected([])} />
        </SpaceBetween>
      }
      columns={[
        { id: 'sev', header: '重要度', cell: (f) => <Severity s={f.severity} />, value: (f) => rank(f.severity) },
        { id: 'workflow', header: 'ワークフローのステータス', cell: (f) => WORKFLOW_LABEL[f.workflow], value: (f) => WORKFLOW_LABEL[f.workflow] },
        { id: 'product', header: '製品名', cell: (f) => f.productName, value: (f) => f.productName },
        { id: 'title', header: 'タイトル', cell: (f) => <ConsoleLink to={findingPath(f)}>{f.controlId ? `${f.controlId} ${controlDef(f.controlId)?.titleJa}` : f.title}</ConsoleLink>, value: (f) => `${f.controlId ?? ''} ${f.title}` },
        { id: 'type', header: 'リソースタイプ', cell: (f) => f.resource.type, value: (f) => f.resource.type },
        { id: 'res', header: 'リソース', cell: (f) => resourceLink(env, f), value: (f) => `${f.resource.id} ${f.resource.tags.Name ?? ''}` },
        { id: 'c', header: 'コンプライアンスのステータス', cell: (f) => <Compliance s={f.compliance} />, value: (f) => f.compliance ?? '' },
        { id: 'at', header: '更新日時', cell: (f) => formatDate(f.updatedAt), value: (f) => f.updatedAt },
      ]}
    />
  );
}

export function FindingDetail({ id }: { id: string }) {
  const env = useHubEnv();
  const f = env.securityHub?.findings.find((x) => x.id === id);
  if (!hubOn(env)) return <NotEnabled />;
  if (!f) return <NotFound what="検出結果" id={id} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<WorkflowMenu selected={[f]} />}>{f.controlId ? `${f.controlId} ${controlDef(f.controlId)?.titleJa}` : f.title}</Header>
      <ResourceDetail
        columns={3}
        fields={[
          { label: '重要度', value: <Severity s={f.severity} /> },
          { label: 'ワークフローのステータス', value: WORKFLOW_LABEL[f.workflow] },
          { label: 'レコードの状態', value: f.recordState },
          { label: '製品名', value: f.productName },
          { label: 'コントロール', value: f.controlId ? <ConsoleLink to={controlPath(f.controlId)}>{f.controlId}</ConsoleLink> : '-' },
          { label: 'コンプライアンスのステータス', value: <Compliance s={f.compliance} /> },
          { label: 'リソース', value: resourceLink(env, f) },
          { label: 'メモ', value: f.note ? `${f.note.text} (${f.note.updatedBy})` : '-' },
          { label: '検出結果 ID', value: <CopyableValue value={f.id} /> },
        ]}
      />
      <Container header={<Header variant="h2" description="AWS Security Finding Format (ASFF)">JSON</Header>}>
        <JsonBlock value={asff(env, f)} testId="sh-asff" />
      </Container>
    </SpaceBetween>
  );
}

/* ---------------- automation rules ---------------- */

export function Automations() {
  const env = useHubEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const rules = [...(env.securityHub?.automationRules ?? [])].sort((a, b) => a.ruleOrder - b.ruleOrder);
  const [selected, setSelected] = useSelection(rules, (r) => r.ruleArn);
  if (!hubOn(env)) return <NotEnabled />;
  return (
    <ResourceTable
      title="自動化ルール"
      description="条件に一致する検出結果が作成または更新されたときに、重要度やワークフローのステータス、メモを自動で更新します。ルールの順序が小さいものから適用されます。"
      items={rules}
      trackBy={(r) => r.ruleArn}
      selectedItems={selected}
      onSelectionChange={setSelected}
      resourceName="ルール"
      testId="sh-rules"
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button disabled={selected.length !== 1} onClick={() => run((d) => deleteAutomationRules(d, [selected[0].ruleArn]), `ルール ${selected[0].ruleName} を削除しました`).ok && setSelected([])}>削除</Button>
          <Button variant="primary" onClick={() => navigate('/securityhub/automations/create')} data-testid="sh-create-rule-button">ルールを作成</Button>
        </SpaceBetween>
      }
      columns={[
        { id: 'order', header: 'ルールの順序', cell: (r) => r.ruleOrder, value: (r) => r.ruleOrder },
        { id: 'name', header: 'ルール名', cell: (r) => r.ruleName, value: (r) => r.ruleName },
        { id: 'status', header: 'ルールステータス', cell: (r) => (r.ruleStatus === 'ENABLED' ? <StatusIndicator type="success">有効</StatusIndicator> : <StatusIndicator type="stopped">無効</StatusIndicator>), value: (r) => r.ruleStatus },
        { id: 'criteria', header: '基準', cell: (r) => criteriaText(r.criteria) },
        { id: 'desc', header: '説明', cell: (r) => r.description, value: (r) => r.description },
        { id: 'at', header: '最終更新日時', cell: (r) => formatDate(r.updatedAt), value: (r) => r.updatedAt },
      ]}
    />
  );
}

const criteriaText = (c: FindingFilters) =>
  Object.entries(c)
    .flatMap(([k, conds]) => conds.map((x) => (k === 'ResourceTags' ? `${k}.${String(x.Key)} ${String(x.Comparison)} ${String(x.Value)}` : `${k} ${String(x.Comparison)} ${String(x.Value)}`)))
    .join(' AND ');

/** keys offered in the criteria dropdown (what the lessons need, in the console's order) */
const CRITERIA_KEYS = ['ResourceTags', 'ComplianceSecurityControlId', 'SeverityLabel', 'ComplianceStatus', 'WorkflowStatus', 'ResourceType', 'ResourceId', 'ProductName', 'Title'];
interface CriterionRow {
  key: string;
  tagKey: string;
  op: string;
  value: string;
}

export function CreateAutomationRule() {
  const env = useHubEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [rows, setRows] = useState<CriterionRow[]>([{ key: 'ResourceTags', tagKey: '', op: 'EQUALS', value: '' }]);
  const [severity, setSeverity] = useState('');
  const [workflow, setWorkflow] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('ENABLED');
  const [terminal, setTerminal] = useState(false);
  const [error, setError] = useState<AwsError | null>(null);
  if (!hubOn(env)) return <NotEnabled />;
  const criteria: FindingFilters = {};
  for (const r of rows.filter((x) => x.value.trim())) (criteria[r.key] ??= []).push(r.key === 'ResourceTags' ? { Key: r.tagKey.trim(), Value: r.value.trim(), Comparison: r.op } : { Value: r.value.trim(), Comparison: r.op });
  const preview = Object.keys(criteria).length ? previewRule(env, criteria) : [];
  const order = Math.max(0, ...(env.securityHub!.automationRules.map((r) => r.ruleOrder))) + 1;
  const set = (n: number, patch: Partial<CriterionRow>) => setRows(rows.map((r, i) => (i === n ? { ...r, ...patch } : r)));
  const opt = (v: string, label = v) => ({ value: v, label });
  const keep = opt('', '変更しない');
  return (
    <EditForm
      title="ルールを作成"
      description="条件に一致する検出結果が作成または更新されたときに、選択したフィールドを自動で更新します。ルールは作成後に届いた検出結果と、作成後に更新された検出結果に適用されます。"
      submitText="ルールを作成"
      submitTestId="sh-create-rule"
      submitHotspotId="sh-create-rule"
      onCancel={() => navigate('/securityhub/automations')}
      error={error}
      onSubmit={() => {
        const update = { ...(severity ? { Severity: { Label: severity } } : {}), ...(workflow ? { Workflow: { Status: workflow } } : {}), ...(note.trim() ? { Note: { Text: note.trim(), UpdatedBy: CONSOLE_USER_ARN(env) } } : {}) };
        const r = run((d) => createAutomationRule(d, { ruleName: name, description: desc, ruleOrder: order, ruleStatus: status, isTerminal: terminal, criteria, actions: [{ Type: 'FINDING_FIELDS_UPDATE', FindingFieldsUpdate: update }] }, CONSOLE_USER_ARN(d)), `ルール ${name.trim()} を作成しました`);
        if (r.ok) navigate('/securityhub/automations');
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">ルールタイプ</Header>}>
        <RadioGroup value="custom" items={[{ value: 'custom', label: 'カスタムルールを作成' }, { value: 'template', label: 'テンプレートからルールを作成', disabled: true, description: 'このシミュレーターでは未提供' }]} />
      </Container>
      <Container header={<Header variant="h2">ルール</Header>}>
        <SpaceBetween size="m">
          <FormField label="ルール名">
            <Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="sh-rule-name" />
          </FormField>
          <FormField label="説明">
            <Input value={desc} onChange={(e) => setDesc(e.detail.value)} data-testid="sh-rule-description" />
          </FormField>
          <FormField label="ルールの順序" description="コンソールで作成したルールは、既存のルールの後に適用されます。">{order}</FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="すべての基準に一致する検出結果にルールを適用します。">基準</Header>}>
        <SpaceBetween size="s">
          {rows.map((r, n) => (
            <SpaceBetween key={n} direction="horizontal" size="xs" alignItems="end">
              <FormField label="キー">
                <Select selectedOption={opt(r.key)} options={CRITERIA_KEYS.map((k) => opt(k))} onChange={(e) => set(n, { key: e.detail.selectedOption.value!, op: 'EQUALS' })} data-testid={`sh-criteria-key-${n}`} />
              </FormField>
              {r.key === 'ResourceTags' && (
                <FormField label="タグキー">
                  <Input value={r.tagKey} onChange={(e) => set(n, { tagKey: e.detail.value })} placeholder="Environment" data-testid={`sh-criteria-tag-${n}`} />
                </FormField>
              )}
              <FormField label="オペレータ">
                <Select selectedOption={opt(r.op)} options={(r.key === 'ResourceTags' ? ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'NOT_CONTAINS'] : ['EQUALS', 'NOT_EQUALS', 'PREFIX', 'CONTAINS', 'NOT_CONTAINS']).map((o) => opt(o))} onChange={(e) => set(n, { op: e.detail.selectedOption.value! })} />
              </FormField>
              <FormField label="値">
                <Input value={r.value} onChange={(e) => set(n, { value: e.detail.value })} data-testid={`sh-criteria-value-${n}`} />
              </FormField>
              <Button disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, i) => i !== n))}>削除</Button>
            </SpaceBetween>
          ))}
          <Button onClick={() => setRows([...rows, { key: 'ComplianceSecurityControlId', tagKey: '', op: 'EQUALS', value: '' }])}>基準を追加</Button>
          <Table
            variant="embedded"
            data-testid="sh-rule-preview"
            header={<Header variant="h3" counter={`(${preview.length})`} description="今の検出結果のうち、基準に一致するもの (アクションは適用前)">プレビュー</Header>}
            items={preview}
            empty="一致する検出結果はありません"
            columnDefinitions={[
              { id: 'sev', header: '重要度', cell: (f) => <Severity s={f.severity} /> },
              { id: 'title', header: 'タイトル', cell: (f) => (f.controlId ? `${f.controlId} ${controlDef(f.controlId)?.titleJa}` : f.title) },
              { id: 'res', header: 'リソース', cell: (f) => resourceLink(env, f) },
            ]}
          />
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="検出結果がルールの基準に一致したときに更新するフィールドです。">自動アクション</Header>}>
        <ColumnLayout columns={3}>
          <FormField label="重要度">
            <Select selectedOption={severity ? opt(severity) : keep} options={[keep, ...SEVERITIES.map((s) => opt(s))]} onChange={(e) => setSeverity(e.detail.selectedOption.value!)} data-testid="sh-action-severity" />
          </FormField>
          <FormField label="ワークフローのステータス">
            <Select selectedOption={workflow ? opt(workflow, WORKFLOW_LABEL[workflow as WorkflowStatus]) : keep} options={[keep, ...WORKFLOW_STATUSES.map((s) => opt(s, WORKFLOW_LABEL[s]))]} onChange={(e) => setWorkflow(e.detail.selectedOption.value!)} />
          </FormField>
          <FormField label="メモ">
            <Input value={note} onChange={(e) => setNote(e.detail.value)} data-testid="sh-action-note" />
          </FormField>
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">ルールステータス</Header>}>
        <RadioGroup value={status} onChange={(e) => setStatus(e.detail.value)} items={[{ value: 'ENABLED', label: '有効' }, { value: 'DISABLED', label: '無効' }]} />
      </Container>
      <Container header={<Header variant="h2">詳細設定 - オプション</Header>}>
        <Checkbox checked={terminal} onChange={(e) => setTerminal(e.detail.checked)}>これらの条件に一致する検出結果については後続のルールを無視する</Checkbox>
      </Container>
    </EditForm>
  );
}
