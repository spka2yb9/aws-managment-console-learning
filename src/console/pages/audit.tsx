import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Wizard from '@cloudscape-design/components/wizard';
import { useState } from 'react';
import { eventRecord, lookupEvents, type LookupAttribute } from '../../sim/cloudtrail';
import { configurationItem, deleteConfigRule, evaluateRule, managedRule, MANAGED_RULES, putConfigRule, resourceEvents, ruleCompliance, type Compliance, type Evaluation } from '../../sim/config';
import type { AwsEnv, AwsError, TrailEvent } from '../../sim/types';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, errorText, formatDate, JsonBlock, NotFound, queryParam, ResourceDetail, ResourceTable, useEnv, useGlobalEnv, useNavigate } from '../ui';

// ---------------- CloudTrail ----------------

const ATTRS: { value: LookupAttribute; label: string }[] = [
  { value: 'EventName', label: 'イベント名' },
  { value: 'Username', label: 'ユーザー名' },
  { value: 'ResourceType', label: 'リソースタイプ' },
  { value: 'ResourceName', label: 'リソース名' },
  { value: 'EventSource', label: 'イベントソース' },
  { value: 'EventId', label: 'イベント ID' },
  { value: 'AccessKeyId', label: 'AWS アクセスキー' },
];

export const eventPath = (e: TrailEvent) => `/cloudtrail/events/view?${new URLSearchParams({ id: e.eventId })}`;
const historyPath = (attr: LookupAttribute, value: string) => `/cloudtrail/events?${new URLSearchParams(value ? { attr, value } : {})}`;

/** console page of a resource CloudTrail mentions, when it still exists in the simulator */
function resourceLink(env: AwsEnv, type: string, name: string) {
  const pages: Record<string, [string, boolean]> = {
    'AWS::EC2::SecurityGroup': [`/ec2/security-groups/${name}`, env.securityGroups.some((g) => g.groupId === name)],
    'AWS::EC2::Instance': [`/ec2/instances/${name}`, env.instances.some((i) => i.instanceId === name)],
    'AWS::S3::Bucket': [`/s3/buckets/${name}`, env.buckets.some((b) => b.name === name)],
    'AWS::RDS::DBInstance': [`/rds/databases/${name}`, env.dbInstances.some((d) => d.dbInstanceIdentifier === name)],
    'AWS::CloudWatch::Alarm': [`/cloudwatch/alarms/view?${new URLSearchParams({ name: name.split(':alarm:')[1] ?? name })}`, env.alarms.some((a) => a.alarmArn === name)],
    'AWS::EC2::VPC': [`/vpc/vpcs/${name}`, env.vpcs.some((v) => v.vpcId === name)],
    'AWS::EC2::Subnet': [`/vpc/subnets/${name}`, env.subnets.some((x) => x.subnetId === name)],
  };
  const [to, exists] = pages[type] ?? ['', false];
  return exists ? <ConsoleLink to={to}>{name}</ConsoleLink> : name;
}

/** Event history of the console's Region (IAM and sign-in events are in US East (N. Virginia), like the real thing). */
export function EventHistory() {
  const env = useGlobalEnv();
  const region = useConsole((s) => s.region);
  const path = useConsole((s) => s.path);
  const navigate = useNavigate();
  const attr = (queryParam(path, 'attr') as LookupAttribute | undefined) ?? 'EventName';
  const value = queryParam(path, 'value') ?? '';
  const [a, setA] = useState<LookupAttribute>(attr);
  const [v, setV] = useState(value);
  const events = lookupEvents(env, region, value ? attr : undefined, value);
  return (
    <Table
      variant="full-page"
      data-testid="event-history"
      wrapLines
      items={events}
      header={
        <Header variant="awsui-h1-sticky" counter={`(${events.length})`} description="イベント履歴には、過去 90 日間のこの AWS リージョンの管理イベントが表示されます。長期間保存するには証跡を作成して S3 に配信します (このシミュレーターでは未提供)。">
          イベント履歴
        </Header>
      }
      filter={
        <SpaceBetween direction="horizontal" size="xs" alignItems="end">
          <FormField label="ルックアップ属性">
            <Select selectedOption={ATTRS.find((x) => x.value === a)!} options={ATTRS} onChange={(e) => setA(e.detail.selectedOption.value as LookupAttribute)} data-testid="lookup-attr" />
          </FormField>
          <FormField label="値">
            <Hotspot hotspotId="ct-lookup" direction="right">
              <div className="log-filter">
                <Input
                  type="search"
                  value={v}
                  placeholder={`${ATTRS.find((x) => x.value === a)!.label}を入力 (完全一致)`}
                  onChange={(e) => {
                    setV(e.detail.value);
                    if (!e.detail.value) navigate(historyPath(a, ''));
                  }}
                  onKeyDown={(e) => e.detail.key === 'Enter' && !e.detail.isComposing && navigate(historyPath(a, v.trim()))}
                  data-testid="lookup-value"
                />
              </div>
            </Hotspot>
          </FormField>
        </SpaceBetween>
      }
      empty={<Box textAlign="center" color="inherit" padding="l"><b>イベントがありません</b><Box variant="p" color="inherit">条件に一致するイベントはありません。値は大文字と小文字を区別した完全一致です。</Box></Box>}
      columnDefinitions={[
        { id: 'name', header: 'イベント名', cell: (e) => <ConsoleLink to={eventPath(e)}>{e.eventName}</ConsoleLink> },
        { id: 'time', header: 'イベント時間', cell: (e) => formatDate(e.eventTime) },
        { id: 'user', header: 'ユーザー名', cell: (e) => e.userIdentity.userName },
        { id: 'source', header: 'イベントソース', cell: (e) => e.eventSource },
        { id: 'type', header: 'リソースタイプ', cell: (e) => <SpaceBetween size="xxxs">{e.resources.map(([t], n) => <span key={n}>{t}</span>)}</SpaceBetween> },
        { id: 'res', header: 'リソース名', cell: (e) => <SpaceBetween size="xxxs">{e.resources.map(([, name], n) => <span key={n}>{name}</span>)}</SpaceBetween> },
      ]}
    />
  );
}

export function EventDetail({ id }: { id: string }) {
  const env = useGlobalEnv();
  const e = env.trailEvents.find((x) => x.eventId === id);
  if (!e) return <NotFound what="イベント" id={id} />;
  const record = eventRecord(env, e);
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{e.eventName}</Header>
      <ResourceDetail
        columns={3}
        fields={[
          { label: 'イベント時間', value: formatDate(e.eventTime) },
          { label: 'ユーザー名', value: e.userIdentity.userName },
          { label: 'イベント名', value: e.eventName },
          { label: 'イベントソース', value: e.eventSource },
          { label: 'AWS アクセスキー', value: e.userIdentity.accessKeyId },
          { label: 'ソース IP アドレス', value: e.sourceIPAddress },
          { label: 'イベント ID', value: <CopyableValue value={e.eventId} /> },
          { label: 'リクエスト ID', value: e.requestId },
          { label: 'AWS リージョン', value: e.awsRegion },
          { label: '読み取り専用', value: String(e.readOnly) },
          { label: 'エラーコード', value: '-' },
          { label: 'ユーザーエージェント', value: <Box variant="small">{e.userAgent}</Box> },
        ]}
      />
      <Table
        variant="container"
        header={<Header counter={`(${e.resources.length})`}>参照されたリソース</Header>}
        items={e.resources}
        empty="リソースはありません"
        columnDefinitions={[
          { id: 'type', header: 'リソースタイプ', cell: ([t]) => t },
          { id: 'name', header: 'リソース名', cell: ([t, n]) => resourceLink(env, t, n) },
        ]}
      />
      <Container header={<Header variant="h2" actions={<CopyToClipboard variant="button" textToCopy={JSON.stringify(record, null, 2)} copyButtonText="JSON をコピー" copySuccessText="コピーしました" copyErrorText="コピーに失敗しました" />}>イベントレコード</Header>}>
        <div data-testid="event-record">
          <JsonBlock value={record} />
        </div>
      </Container>
    </SpaceBetween>
  );
}

// ---------------- AWS Config ----------------

const TYPE_LABEL: Record<string, string> = { 'AWS::EC2::SecurityGroup': 'EC2 SecurityGroup', 'AWS::S3::Bucket': 'S3 Bucket', 'AWS::RDS::DBInstance': 'RDS DBInstance', 'AWS::EC2::Instance': 'EC2 Instance' };
const rulePath = (name: string) => `/config/rules/view?${new URLSearchParams({ name })}`;
const timelinePath = (type: string, id: string) => `/config/resources/view?${new URLSearchParams({ type, id })}`;

export function ComplianceIndicator({ compliance, count }: { compliance: Compliance; count?: number }) {
  return compliance === 'COMPLIANT' ? <StatusIndicator type="success">準拠</StatusIndicator> : <StatusIndicator type="error">{count !== undefined ? `${count} 個の非準拠リソース` : '非準拠'}</StatusIndicator>;
}

/** every resource Config records, with its worst compliance over the rules that cover it */
function inventory(env: AwsEnv): (Evaluation & { rules: number })[] {
  const byKey = new Map<string, Evaluation & { rules: number }>();
  for (const r of MANAGED_RULES)
    for (const e of r.evaluate(env)) {
      const key = `${e.resourceType}|${e.resourceId}`;
      const covered = env.configRules.some((c) => c.identifier === r.identifier);
      const prev = byKey.get(key);
      const worse = covered && e.compliance === 'NON_COMPLIANT';
      byKey.set(key, { ...e, compliance: worse || prev?.compliance === 'NON_COMPLIANT' ? 'NON_COMPLIANT' : 'COMPLIANT', annotation: undefined, rules: (prev?.rules ?? 0) + (covered ? 1 : 0) });
    }
  return [...byKey.values()];
}

export function ConfigDashboard() {
  const env = useEnv();
  const rules = env.configRules.map((r) => ({ r, c: ruleCompliance(env, r) }));
  const bad = rules.filter((x) => x.c.compliance === 'NON_COMPLIANT');
  const resources = inventory(env);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="AWS Config はリソースの設定を記録し、ルールに準拠しているかを継続的に評価します。">ダッシュボード</Header>
      <Container header={<Header variant="h2">コンプライアンスのステータス</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <div data-testid="noncompliant-rules">
            <Box variant="awsui-key-label">ルール</Box>
            <ConsoleLink to="/config/rules">{`${bad.length} 個の非準拠ルール`}</ConsoleLink>
          </div>
          <div>
            <Box variant="awsui-key-label">リソース</Box>
            <ConsoleLink to="/config/resources">{`${resources.filter((x) => x.compliance === 'NON_COMPLIANT').length} 個の非準拠リソース`}</ConsoleLink>
          </div>
        </ColumnLayout>
      </Container>
      <Table
        variant="container"
        header={<Header counter={`(${bad.length})`}>非準拠ルール</Header>}
        items={bad}
        empty="すべてのルールが準拠しています"
        columnDefinitions={[
          { id: 'name', header: '名前', cell: (x) => <ConsoleLink to={rulePath(x.r.configRuleName)}>{x.r.configRuleName}</ConsoleLink> },
          { id: 'c', header: '準拠状況', cell: (x) => <ComplianceIndicator compliance={x.c.compliance} count={x.c.nonCompliant} /> },
        ]}
      />
      <Container header={<Header variant="h2">リソースインベントリ</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          {Object.entries(TYPE_LABEL).map(([t, l]) => (
            <div key={t}>
              <Box variant="awsui-key-label">{l}</Box>
              {resources.filter((x) => x.resourceType === t).length}
            </div>
          ))}
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}

export function ConfigRules() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const rows = env.configRules.map((r) => ({ r, c: ruleCompliance(env, r) }));
  type Row = (typeof rows)[number];
  const [sel, setSel] = useState<Row[]>([]);
  return (
    <ResourceTable<Row>
      title="ルール"
      description="ルールは、リソースの望ましい設定を表します。リソースの設定が変わるたびに評価されます。"
      items={rows}
      trackBy={(x) => x.r.configRuleName}
      selectedItems={sel}
      onSelectionChange={setSel}
      resourceName="ルール"
      testId="config-rules"
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu
            items={[
              {
                id: 'delete',
                text: 'ルールの削除',
                disabled: sel.length !== 1,
                onClick: () => {
                  run((d) => deleteConfigRule(d, sel[0].r.configRuleName), `ルール ${sel[0].r.configRuleName} を削除しました`);
                  setSel([]);
                },
              },
            ]}
          />
          <Hotspot hotspotId="config-add-rule" direction="right">
            <Button variant="primary" onClick={() => navigate('/config/rules/add')} data-testid="add-config-rule">ルールを追加</Button>
          </Hotspot>
        </SpaceBetween>
      }
      columns={[
        { id: 'name', header: '名前', cell: (x) => <ConsoleLink to={rulePath(x.r.configRuleName)}>{x.r.configRuleName}</ConsoleLink>, value: (x) => x.r.configRuleName },
        { id: 'fix', header: '修復アクション', cell: () => '未設定' },
        { id: 'type', header: 'タイプ', cell: () => 'AWS マネージド' },
        { id: 'c', header: '検出結果の準拠状況', cell: (x) => <ComplianceIndicator compliance={x.c.compliance} count={x.c.nonCompliant} />, value: (x) => x.c.nonCompliant },
      ]}
    />
  );
}

export function RuleDetail({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const flash = useConsole((s) => s.flash);
  const [show, setShow] = useState<'NON_COMPLIANT' | 'COMPLIANT' | 'ALL'>('NON_COMPLIANT');
  const r = env.configRules.find((x) => x.configRuleName === name);
  if (!r) return <NotFound what="ルール" id={name} />;
  const m = managedRule(r.identifier)!;
  const rc = ruleCompliance(env, r);
  const evals = evaluateRule(env, r);
  const shown = evals.filter((e) => show === 'ALL' || e.compliance === show);
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button onClick={() => flash('success', `ルール ${name} の評価を開始しました`)} data-testid="reevaluate">再評価</Button>
            <Button
              onClick={() => {
                if (run((d) => deleteConfigRule(d, name), `ルール ${name} を削除しました`).ok) navigate('/config/rules');
              }}
            >
              削除
            </Button>
          </SpaceBetween>
        }
      >
        {name}
      </Header>
      <ResourceDetail
        title="ルールの詳細"
        columns={2}
        fields={[
          { label: '説明', value: m.description },
          { label: '準拠状況', value: <span data-testid="rule-compliance"><ComplianceIndicator compliance={rc.compliance} count={rc.nonCompliant} /></span> },
          { label: 'ルール ARN', value: <CopyableValue value={r.configRuleArn} /> },
          { label: 'マネージドルール名', value: m.identifier },
          { label: 'トリガータイプ', value: '設定変更が行われた時' },
          { label: '範囲', value: m.resourceType },
        ]}
      />
      <Table
        variant="container"
        data-testid="rule-resources"
        wrapLines
        header={
          <Header counter={`(${shown.length})`} actions={<SegmentedControl label="準拠状況" selectedId={show} onChange={(e) => setShow(e.detail.selectedId as typeof show)} options={[{ id: 'NON_COMPLIANT', text: '非準拠' }, { id: 'COMPLIANT', text: '準拠' }, { id: 'ALL', text: 'すべて' }]} />}>
            対象範囲内のリソース
          </Header>
        }
        items={shown}
        empty={show === 'NON_COMPLIANT' ? '非準拠のリソースはありません' : 'リソースはありません'}
        columnDefinitions={[
          { id: 'id', header: 'ID', cell: (e) => <ConsoleLink to={timelinePath(e.resourceType, e.resourceId)}>{e.resourceId}</ConsoleLink> },
          { id: 'name', header: '名前', cell: (e) => e.resourceName || '-' },
          { id: 'type', header: 'タイプ', cell: (e) => e.resourceType },
          { id: 'c', header: '準拠状況', cell: (e) => <ComplianceIndicator compliance={e.compliance} /> },
          { id: 'note', header: '注釈', cell: (e) => e.annotation ?? '-' },
        ]}
      />
    </SpaceBetween>
  );
}

export function AddConfigRule() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [step, setStep] = useState(0);
  const [picked, setPicked] = useState<(typeof MANAGED_RULES)[number] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const err = problem ?? errorText(error);
  return (
    <div data-testid="add-config-rule-wizard">
      <Wizard
        activeStepIndex={step}
        onNavigate={(e) => {
          if (e.detail.requestedStepIndex > 0 && !picked) return setProblem('ルールを選択してください。');
          setProblem(null);
          setStep(e.detail.requestedStepIndex);
        }}
        onCancel={() => navigate('/config/rules')}
        onSubmit={() => {
          const res = run((d) => putConfigRule(d, { configRuleName: name, identifier: picked!.identifier }), `ルール ${name.trim()} が追加されました`);
          if (res.ok) navigate('/config/rules');
          else setError(res.error);
        }}
        i18nStrings={{ stepNumberLabel: (n) => `ステップ ${n}`, collapsedStepsLabel: (n, t) => `ステップ ${n}/${t}`, navigationAriaLabel: 'ステップ', cancelButton: 'キャンセル', previousButton: '前へ', nextButton: '次へ', submitButton: 'ルールを保存', optional: 'オプション' }}
        submitButtonText="ルールを保存"
        steps={[
          {
            title: 'ルールタイプの指定',
            errorText: err,
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">ルールタイプを選択</Header>}>
                  <RadioGroup value="managed" items={[{ value: 'managed', label: 'AWS によって管理されるルールの追加', description: 'AWS マネージドルールを選択し、要件に合わせてカスタマイズします。' }, { value: 'custom', label: 'カスタムルールの作成', disabled: true, description: 'このシミュレーターでは未提供' }]} />
                </Container>
                <Table
                  variant="container"
                  data-testid="managed-rules"
                  header={<Header counter={`(${MANAGED_RULES.length})`}>AWS マネージドルール</Header>}
                  selectionType="single"
                  trackBy="identifier"
                  selectedItems={picked ? [picked] : []}
                  onSelectionChange={(e) => {
                    const r = e.detail.selectedItems[0];
                    setPicked(r);
                    setName(r.name);
                  }}
                  ariaLabels={{ itemSelectionLabel: (_, r) => `${r.name} を選択`, selectionGroupLabel: 'ルールの選択' }}
                  items={MANAGED_RULES}
                  columnDefinitions={[
                    { id: 'name', header: '名前', cell: (r) => r.name },
                    { id: 'desc', header: '説明', cell: (r) => r.description },
                    { id: 'added', header: '', cell: (r) => (env.configRules.some((c) => c.identifier === r.identifier) ? <Box variant="small" color="text-status-inactive">追加済み</Box> : '') },
                  ]}
                />
              </SpaceBetween>
            ),
          },
          {
            title: 'ルールの設定',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">詳細</Header>}>
                <SpaceBetween size="m">
                  <FormField label="名前" constraintText="最大 128 文字。英数字、ハイフン、アンダースコアのみ。">
                    <Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="config-rule-name" />
                  </FormField>
                  <FormField label="マネージドルール名">{picked?.identifier}</FormField>
                  <FormField label="範囲 (リソースタイプ)">{picked?.resourceType}</FormField>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: '確認と作成',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">確認</Header>}>
                <ColumnLayout columns={2} variant="text-grid">
                  <div><Box variant="awsui-key-label">名前</Box>{name}</div>
                  <div><Box variant="awsui-key-label">マネージドルール名</Box>{picked?.identifier}</div>
                  <div><Box variant="awsui-key-label">説明</Box>{picked?.description}</div>
                  <div><Box variant="awsui-key-label">トリガータイプ</Box>設定変更が行われた時</div>
                </ColumnLayout>
              </Container>
            ),
          },
        ]}
      />
    </div>
  );
}

export function ConfigResources() {
  const env = useEnv();
  const items = inventory(env);
  return (
    <ResourceTable
      title="リソースインベントリ"
      description="AWS Config が記録しているリソースです。リソース識別子を選択すると、設定とその変更履歴 (CloudTrail イベント) を確認できます。"
      items={items}
      trackBy={(e) => `${e.resourceType}|${e.resourceId}`}
      selectionType="none"
      resourceName="リソース"
      testId="config-resources"
      columns={[
        { id: 'id', header: 'リソース識別子', cell: (e) => <ConsoleLink to={timelinePath(e.resourceType, e.resourceId)}>{e.resourceId}</ConsoleLink>, value: (e) => e.resourceId },
        { id: 'name', header: '名前', cell: (e) => e.resourceName || '-', value: (e) => e.resourceName },
        { id: 'type', header: 'リソースタイプ', cell: (e) => e.resourceType, value: (e) => e.resourceType },
        { id: 'c', header: '準拠状況', cell: (e) => (e.rules ? <ComplianceIndicator compliance={e.compliance} /> : '-'), value: (e) => (e.rules ? e.compliance : '-') },
      ]}
    />
  );
}

export function ResourceTimeline() {
  const env = useEnv();
  const globalEnv = useGlobalEnv();
  const path = useConsole((s) => s.path);
  const type = queryParam(path, 'type') ?? '';
  const id = queryParam(path, 'id') ?? '';
  const item = configurationItem(env, type, id);
  if (!item) return <NotFound what="リソース" id={id} />;
  const rules = env.configRules.filter((r) => managedRule(r.identifier)?.resourceType === type).map((r) => ({ r, e: evaluateRule(env, r).find((x) => x.resourceId === id)! }));
  const events = resourceEvents(globalEnv, type, id);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={type}>{id}</Header>
      <Table
        variant="container"
        header={<Header counter={`(${rules.length})`}>準拠状況</Header>}
        items={rules}
        empty="このリソースを評価するルールはありません"
        columnDefinitions={[
          { id: 'rule', header: 'ルール', cell: (x) => <ConsoleLink to={rulePath(x.r.configRuleName)}>{x.r.configRuleName}</ConsoleLink> },
          { id: 'c', header: '準拠状況', cell: (x) => <ComplianceIndicator compliance={x.e.compliance} /> },
          { id: 'note', header: '注釈', cell: (x) => x.e.annotation ?? '-' },
        ]}
      />
      <Table
        variant="container"
        data-testid="resource-events"
        header={<Header counter={`(${events.length})`} description="このリソースを変更した API 呼び出しです (新しい順)。">CloudTrail イベント</Header>}
        items={events}
        empty="イベントはありません"
        columnDefinitions={[
          { id: 'time', header: 'イベント時間', cell: (e) => formatDate(e.eventTime) },
          { id: 'name', header: 'イベント名', cell: (e) => <ConsoleLink to={eventPath(e)}>{e.eventName}</ConsoleLink> },
          { id: 'user', header: 'ユーザー名', cell: (e) => e.userIdentity.userName },
        ]}
      />
      <Container header={<Header variant="h2">設定項目 (現在)</Header>}>
        <JsonBlock value={item} />
      </Container>
    </SpaceBetween>
  );
}
