import Alert from '@cloudscape-design/components/alert';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import Wizard from '@cloudscape-design/components/wizard';
import { useState } from 'react';
import { allPolicies, attachPolicy, createPolicy, createRole, deleteInlinePolicy, detachPolicy, ec2TrustPolicy, evaluateIamPermission, findPolicy, list, parsePolicy, policyAttachments, putInlinePolicy, statements, updateAssumeRolePolicy, updatePolicyDocument, type IamDecision, type PolicyKind } from '../../sim/iam';
import type { AwsError, IamRole, ManagedPolicy, PolicyDocument } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, EditForm, errorText, formatDate, JsonBlock, NotFound, queryParam, ResourceDetail, ResourceTable, ResourceTabs, useGlobalEnv, useNavigate } from '../ui';
import { Tags } from './vpc';

const rolePath = (n: string) => `/iam/roles/${n}`;
const userPath = (n: string) => `/iam/users/${n}`;
export const policyPath = (arn: string) => `/iam/policies/view?arn=${encodeURIComponent(arn)}`;
const policyType = (p: ManagedPolicy) => (p.awsManaged ? 'AWS 管理' : 'カスタマー管理');

function trustedEntities(r: IamRole) {
  const services = statements(r.assumeRolePolicyDocument).flatMap((s) => (s.Principal && s.Principal !== '*' ? list(s.Principal.Service) : []));
  return services.length ? `AWS のサービス: ${services.map((s) => s.replace('.amazonaws.com', '')).join(', ')}` : 'AWS アカウント';
}

/** JSON policy editor: a monospace textarea with live validation (like the console's policy editor). */
export function PolicyEditor({ value, onChange, kind, bucket, label = 'ポリシーエディタ', description = 'JSON でポリシーを記述します。', testId }: { value: string; onChange: (v: string) => void; kind: PolicyKind; bucket?: string; label?: string; description?: string; testId?: string }) {
  let problem: string | null = null;
  try {
    parsePolicy(value, kind, { bucket });
  } catch (e) {
    problem = (e as AwsError).message;
  }
  return (
    <FormField label={label} description={description} errorText={problem ?? undefined} stretch>
      <div className="code-textarea">
        <Textarea value={value} onChange={(e) => onChange(e.detail.value)} rows={18} spellcheck={false} data-testid={testId} />
      </div>
    </FormField>
  );
}

const pretty = (d: PolicyDocument) => JSON.stringify(d, null, 2);

// ---------------- dashboard ----------------

export function IamDashboard() {
  const env = useGlobalEnv();
  const item = (text: string, n: number, to: string) => (
    <div>
      <Box variant="awsui-key-label">{text}</Box>
      <ConsoleLink to={to}><Box variant="awsui-value-large" tagOverride="span">{n}</Box></ConsoleLink>
    </div>
  );
  return (
    <SpaceBetween size="l">
      <Header variant="h1">IAM ダッシュボード</Header>
      <Container header={<Header variant="h2">IAM リソース</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          {item('ユーザー', env.iamUsers.length, '/iam/users')}
          {item('ロール', env.iamRoles.length, '/iam/roles')}
          {item('ポリシー (カスタマー管理)', env.iamPolicies.length, '/iam/policies')}
          {item('インスタンスプロファイル', env.instanceProfiles.length, '/iam/roles')}
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">AWS アカウント</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <div><Box variant="awsui-key-label">アカウント ID</Box><CopyableValue value={env.accountId} /></div>
          <div><Box variant="awsui-key-label">サインイン中のユーザー</Box><Box>learner</Box></div>
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}

// ---------------- users ----------------

export function UserList() {
  const env = useGlobalEnv();
  return (
    <ResourceTable
      title="ユーザー"
      description="IAM ユーザーは、アカウント内の特定の人やアプリケーションの長期的な認証情報を持つ ID です。"
      resourceName="ユーザー"
      items={env.iamUsers}
      trackBy={(u) => u.userName}
      selectionType="none"
      columns={[
        { id: 'name', header: 'ユーザー名', cell: (u) => <ConsoleLink to={userPath(u.userName)}>{u.userName}</ConsoleLink>, value: (u) => u.userName },
        { id: 'path', header: 'パス', cell: (u) => u.path },
        { id: 'groups', header: 'グループ', cell: () => '0' },
        { id: 'console', header: 'コンソールアクセス', cell: (u) => (u.consoleAccess ? '有効' : '無効') },
        { id: 'policies', header: '許可ポリシー', cell: (u) => String(u.attachedPolicyArns.length + u.inlinePolicies.length) },
        { id: 'date', header: '作成日時', cell: (u) => formatDate(u.createDate) },
      ]}
    />
  );
}

function PermissionsTable({ type, name, attached, inline }: { type: 'role' | 'user'; name: string; attached: string[]; inline: { policyName: string }[] }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [sel, setSel] = useState<string[]>([]);
  type Row = { id: string; name: string; type: string; arn?: string };
  const rows: Row[] = [
    ...attached.map((arn) => ({ id: arn, name: findPolicy(env, arn)?.policyName ?? arn, type: findPolicy(env, arn) ? policyType(findPolicy(env, arn)!) : '-', arn })),
    ...inline.map((p) => ({ id: `inline:${p.policyName}`, name: p.policyName, type: 'カスタマーインライン' })),
  ];
  const base = type === 'role' ? rolePath(name) : userPath(name);
  return (
    <div data-testid="permission-policies">
      <Table<Row>
        variant="container"
        header={
          <Header
            counter={`(${rows.length})`}
            description="最大 10 個のマネージドポリシーをアタッチできます。"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  disabled={!sel.length}
                  onClick={() => {
                    run((d) => rows.filter((r) => sel.includes(r.id)).forEach((r) => (r.arn ? detachPolicy(d, type, name, r.arn) : deleteInlinePolicy(d, type, name, r.name))), `${sel.length} 個のポリシーを削除しました`);
                    setSel([]);
                  }}
                >
                  削除
                </Button>
                <Hotspot hotspotId="iam-add-permissions" direction="right">
                  <ButtonDropdown
                    variant="primary"
                    items={[
                      { id: 'attach', text: 'ポリシーをアタッチ' },
                      { id: 'inline', text: 'インラインポリシーを作成' },
                    ]}
                    onItemClick={(e) => navigate(`${base}/${e.detail.id === 'attach' ? 'attach-policies' : 'create-inline'}`)}
                    data-testid="add-permissions"
                  >
                    許可を追加
                  </ButtonDropdown>
                </Hotspot>
              </SpaceBetween>
            }
          >
            許可ポリシー
          </Header>
        }
        items={rows}
        trackBy="id"
        selectionType="multi"
        selectedItems={rows.filter((r) => sel.includes(r.id))}
        onSelectionChange={(e) => setSel(e.detail.selectedItems.map((r) => r.id))}
        ariaLabels={{ itemSelectionLabel: (_, r) => `${r.name} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: 'ポリシー' }}
        empty={<Box textAlign="center" color="inherit">ポリシーがありません</Box>}
        columnDefinitions={[
          { id: 'name', header: 'ポリシー名', cell: (r) => (r.arn ? <ConsoleLink to={policyPath(r.arn)}>{r.name}</ConsoleLink> : <ConsoleLink to={`${base}/inline?name=${encodeURIComponent(r.name)}`}>{r.name}</ConsoleLink>) },
          { id: 'type', header: 'タイプ', cell: (r) => r.type },
          { id: 'how', header: 'アタッチ方法', cell: () => '直接' },
        ]}
      />
    </div>
  );
}

export function UserDetail({ name }: { name: string }) {
  const env = useGlobalEnv();
  const u = env.iamUsers.find((x) => x.userName === name);
  if (!u) return <NotFound what="ユーザー" id={name} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{u.userName}</Header>
      <ResourceDetail title="概要" columns={3} fields={[{ label: 'ARN', value: <CopyableValue value={u.arn} /> }, { label: 'コンソールアクセス', value: u.consoleAccess ? '有効 (MFA なし)' : '無効' }, { label: '作成日', value: formatDate(u.createDate) }]} />
      <ResourceTabs tabs={[{ id: 'permissions', label: '許可', content: <PermissionsTable type="user" name={name} attached={u.attachedPolicyArns} inline={u.inlinePolicies} /> }, { id: 'groups', label: 'グループ', content: <Box color="text-body-secondary">このユーザーはどのグループにも属していません。</Box> }, { id: 'tags', label: 'タグ', content: <Tags tags={u.tags} /> }]} />
    </SpaceBetween>
  );
}

// ---------------- roles ----------------

export function RoleList() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  return (
    <ResourceTable
      title="ロール"
      description="IAM ロールは、短期間有効な認証情報を持つ ID です。ロールは、信頼するエンティティ (EC2 など) が引き受けて使います。"
      resourceName="ロール"
      testId="role-table"
      items={env.iamRoles}
      trackBy={(r) => r.roleName}
      selectionType="none"
      columns={[
        { id: 'name', header: 'ロール名', cell: (r) => <ConsoleLink to={rolePath(r.roleName)}>{r.roleName}</ConsoleLink>, value: (r) => r.roleName },
        { id: 'trusted', header: '信頼されたエンティティ', cell: trustedEntities, value: trustedEntities },
        { id: 'last', header: '最後のアクティビティ', cell: () => '-' },
        { id: 'date', header: '作成日時', cell: (r) => formatDate(r.createDate) },
      ]}
      actions={<Button variant="primary" onClick={() => navigate('/iam/roles/create')} data-testid="create-role">ロールを作成</Button>}
    />
  );
}

export function RoleDetail({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const r = env.iamRoles.find((x) => x.roleName === name);
  if (!r) return <NotFound what="ロール" id={name} />;
  const profile = env.instanceProfiles.find((p) => p.roleNames.includes(name));
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={r.description}>{r.roleName}</Header>
      <ResourceDetail
        title="概要"
        columns={3}
        fields={[
          { label: '作成日', value: formatDate(r.createDate) },
          { label: 'ARN', value: <CopyableValue value={r.arn} /> },
          { label: '最後のアクティビティ', value: '-' },
          { label: '最大セッション時間', value: `${r.maxSessionDuration / 3600} 時間` },
          { label: 'インスタンスプロファイル ARN', value: profile ? <CopyableValue value={profile.arn} /> : '-' },
        ]}
      />
      <ResourceTabs
        tabs={[
          { id: 'permissions', label: '許可', content: <PermissionsTable type="role" name={name} attached={r.attachedPolicyArns} inline={r.inlinePolicies} /> },
          {
            id: 'trust',
            label: '信頼関係',
            content: (
              <Container
                header={
                  <Header variant="h2" description="このロールを引き受けることができるエンティティ (信頼ポリシー)。" actions={<Hotspot hotspotId="iam-edit-trust" direction="right"><Button onClick={() => navigate(`${rolePath(name)}/edit-trust`)} data-testid="edit-trust">信頼ポリシーを編集</Button></Hotspot>}>
                    信頼されたエンティティ
                  </Header>
                }
              >
                <JsonBlock value={r.assumeRolePolicyDocument} testId="trust-policy" />
              </Container>
            ),
          },
          { id: 'tags', label: 'タグ', content: <Tags tags={r.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

export function InlinePolicyView({ type, name }: { type: 'role' | 'user'; name: string }) {
  const env = useGlobalEnv();
  const path = useConsole((s) => s.path);
  const pname = queryParam(path, 'name') ?? '';
  const e = type === 'role' ? env.iamRoles.find((x) => x.roleName === name) : env.iamUsers.find((x) => x.userName === name);
  const p = e?.inlinePolicies.find((x) => x.policyName === pname);
  if (!p) return <NotFound what="インラインポリシー" id={pname} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="カスタマーインラインポリシー">{p.policyName}</Header>
      <Container header={<Header variant="h2">このポリシーで定義されている許可</Header>}>
        <JsonBlock value={p.document} />
      </Container>
    </SpaceBetween>
  );
}

export function EditTrustPolicy({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const r = env.iamRoles.find((x) => x.roleName === name);
  const [text, setText] = useState(r ? pretty(r.assumeRolePolicyDocument) : '');
  const [error, setError] = useState<AwsError | null>(null);
  if (!r) return <NotFound what="ロール" id={name} />;
  return (
    <EditForm
      title="信頼ポリシーを編集"
      description="信頼ポリシーは、どのプリンシパル (AWS のサービスやアカウント) がこのロールを引き受けられるかを定義します。"
      submitText="ポリシーを更新"
      submitTestId="save-trust"
      submitHotspotId="iam-save-trust"
      onCancel={() => navigate(`${rolePath(name)}?tab=trust`)}
      error={error}
      onSubmit={() => {
        const res = run((d) => updateAssumeRolePolicy(d, name, parsePolicy(text, 'trust')), `ロール ${name} の信頼ポリシーが更新されました`);
        if (res.ok) navigate(`${rolePath(name)}?tab=trust`);
        else setError(res.error);
      }}
    >
      <Container>
        <PolicyEditor value={text} onChange={setText} kind="trust" testId="trust-editor" />
      </Container>
    </EditForm>
  );
}

function PolicyPicker({ selected, onChange }: { selected: string[]; onChange: (arns: string[]) => void }) {
  const env = useGlobalEnv();
  const items = allPolicies(env);
  return (
    <ResourceTable
      title="許可ポリシー"
      resourceName="ポリシー"
      variant="container"
      headerVariant="h2"
      items={items}
      trackBy={(p) => p.arn}
      selectionType="multi"
      selectedItems={items.filter((p) => selected.includes(p.arn))}
      onSelectionChange={(xs) => onChange(xs.map((p) => p.arn))}
      filterPlaceholder="ポリシーをフィルタリング"
      testId="policy-picker"
      columns={[
        { id: 'name', header: 'ポリシー名', cell: (p) => p.policyName, value: (p) => p.policyName },
        { id: 'type', header: 'タイプ', cell: policyType, value: policyType },
        { id: 'desc', header: '説明', cell: (p) => p.description },
      ]}
    />
  );
}

export function AttachPolicies({ type, name }: { type: 'role' | 'user'; name: string }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [sel, setSel] = useState<string[]>([]);
  const [error, setError] = useState<AwsError | null>(null);
  const back = `${type === 'role' ? rolePath(name) : userPath(name)}?tab=permissions`;
  return (
    <EditForm
      title={`許可を追加: ${name}`}
      description="ポリシーをアタッチ"
      submitText="許可を追加"
      submitTestId="attach-policies-submit"
      submitDisabled={!sel.length}
      onCancel={() => navigate(back)}
      error={error}
      onSubmit={() => {
        const r = run((d) => sel.forEach((a) => attachPolicy(d, type, name, a)), `${name} にポリシーがアタッチされました`);
        if (r.ok) navigate(back);
        else setError(r.error);
      }}
    >
      <PolicyPicker selected={sel} onChange={setSel} />
    </EditForm>
  );
}

const SAMPLE_POLICY = pretty({ Version: '2012-10-17', Statement: [{ Sid: 'Statement1', Effect: 'Allow', Action: [], Resource: [] } as never] });

export function CreateInlinePolicy({ type, name }: { type: 'role' | 'user'; name: string }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [text, setText] = useState(SAMPLE_POLICY);
  const [pname, setPname] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const back = `${type === 'role' ? rolePath(name) : userPath(name)}?tab=permissions`;
  return (
    <EditForm
      title="インラインポリシーの作成"
      submitText="ポリシーの作成"
      submitTestId="create-inline-submit"
      onCancel={() => navigate(back)}
      error={error}
      onSubmit={() => {
        const r = run((d) => putInlinePolicy(d, type, name, pname.trim(), parsePolicy(text, 'identity')), `インラインポリシー ${pname} を作成しました`);
        if (r.ok) navigate(back);
        else setError(r.error);
      }}
    >
      <Container>
        <SpaceBetween size="l">
          <PolicyEditor value={text} onChange={setText} kind="identity" testId="inline-editor" />
          <FormField label="ポリシー名" constraintText="最大 128 文字。英数字と「+=,.@-_」を使用できます。">
            <Input value={pname} onChange={(e) => setPname(e.detail.value)} data-testid="inline-name" />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function CreateRoleWizard() {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [step, setStep] = useState(0);
  const [useCase, setUseCase] = useState('ec2');
  const [policies, setPolicies] = useState<string[]>([]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('Allows EC2 instances to call AWS services on your behalf.');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <div data-testid="create-role-wizard">
      <Wizard
        activeStepIndex={step}
        onNavigate={(e) => setStep(e.detail.requestedStepIndex)}
        onCancel={() => navigate('/iam/roles')}
        onSubmit={() => {
          const r = run((d) => createRole(d, { roleName: name.trim(), description: desc, trustPolicy: ec2TrustPolicy(), policyArns: policies, withInstanceProfile: useCase === 'ec2' }), `ロール ${name} が作成されました`);
          if (r.ok) navigate(rolePath(name.trim()));
          else setError(r.error);
        }}
        i18nStrings={{ stepNumberLabel: (n) => `ステップ ${n}`, collapsedStepsLabel: (n, t) => `ステップ ${n}/${t}`, navigationAriaLabel: 'ステップ', cancelButton: 'キャンセル', previousButton: '前へ', nextButton: '次へ', submitButton: 'ロールを作成', optional: 'オプション' }}
        steps={[
          {
            title: '信頼されたエンティティを選択',
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">信頼されたエンティティタイプ</Header>}>
                  <RadioGroup value="service" items={[{ value: 'service', label: 'AWS のサービス', description: 'EC2、Lambda などの AWS のサービスがこのアカウントでアクションを実行することを許可します。' }, { value: 'account', label: 'AWS アカウント', disabled: true, description: 'このシミュレーターでは未提供' }]} />
                </Container>
                <Container header={<Header variant="h2">ユースケース</Header>}>
                  <FormField label="サービスまたはユースケース">
                    <Select selectedOption={{ value: useCase, label: useCase === 'ec2' ? 'EC2' : useCase }} options={[{ value: 'ec2', label: 'EC2', description: 'EC2 インスタンスがユーザーに代わって AWS のサービスを呼び出すことを許可します。' }]} onChange={(e) => setUseCase(e.detail.selectedOption.value!)} />
                  </FormField>
                </Container>
              </SpaceBetween>
            ),
          },
          { title: '許可を追加', content: <PolicyPicker selected={policies} onChange={setPolicies} /> },
          {
            title: '名前、確認、および作成',
            content: (
              <SpaceBetween size="l">
                {error && <Alert type="error">{errorText(error)}</Alert>}
                <Container header={<Header variant="h2">ロールの詳細</Header>}>
                  <SpaceBetween size="l">
                    <FormField label="ロール名" constraintText="最大 64 文字。英数字と「+=,.@-_」を使用できます。">
                      <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="例: batch-role" data-testid="role-name" />
                    </FormField>
                    <FormField label="説明">
                      <Input value={desc} onChange={(e) => setDesc(e.detail.value)} />
                    </FormField>
                  </SpaceBetween>
                </Container>
                <Container header={<Header variant="h2">ステップ 1: 信頼されたエンティティを選択</Header>}>
                  <JsonBlock value={ec2TrustPolicy()} />
                </Container>
              </SpaceBetween>
            ),
          },
        ]}
      />
    </div>
  );
}

// ---------------- policies ----------------

export function PolicyList() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  return (
    <ResourceTable
      title="ポリシー"
      description="ポリシーは、アタッチ先の ID やリソースのアクセス許可を定義するオブジェクトです。"
      resourceName="ポリシー"
      testId="policy-table"
      items={allPolicies(env)}
      trackBy={(p) => p.arn}
      selectionType="none"
      filterPlaceholder="ポリシーをフィルタリング"
      columns={[
        { id: 'name', header: 'ポリシー名', cell: (p) => <ConsoleLink to={policyPath(p.arn)}>{p.policyName}</ConsoleLink>, value: (p) => p.policyName },
        { id: 'type', header: 'タイプ', cell: policyType, value: policyType },
        { id: 'use', header: '用途', cell: (p) => (policyAttachments(env, p.arn).length ? `許可ポリシー (${policyAttachments(env, p.arn).length})` : 'なし') },
        { id: 'desc', header: '説明', cell: (p) => p.description },
      ]}
      actions={<Button variant="primary" onClick={() => navigate('/iam/policies/create')}>ポリシーの作成</Button>}
    />
  );
}

export function PolicyDetail() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const path = useConsole((s) => s.path);
  const arn = queryParam(path, 'arn') ?? '';
  const [tab, setTab] = useState('permissions');
  const p = findPolicy(env, arn);
  if (!p) return <NotFound what="ポリシー" id={arn} />;
  const attachments = policyAttachments(env, arn);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={p.description}>{p.policyName}</Header>
      <ResourceDetail title="ポリシーの詳細" columns={3} fields={[{ label: 'タイプ', value: policyType(p) }, { label: '作成日時', value: formatDate(p.createDate) }, { label: '編集日時', value: formatDate(p.updateDate) }, { label: 'ARN', value: <CopyableValue value={p.arn} /> }]} />
      <Container>
        <SpaceBetween size="m">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant={tab === 'permissions' ? 'primary' : 'normal'} onClick={() => setTab('permissions')}>許可</Button>
            <Button variant={tab === 'entities' ? 'primary' : 'normal'} onClick={() => setTab('entities')}>アタッチされたエンティティ ({attachments.length})</Button>
          </SpaceBetween>
          {tab === 'permissions' ? (
            <SpaceBetween size="s">
              <Header variant="h2" actions={!p.awsManaged && <Hotspot hotspotId="iam-edit-policy" direction="right"><Button onClick={() => navigate(`/iam/policies/edit?arn=${encodeURIComponent(arn)}`)} data-testid="edit-policy">編集</Button></Hotspot>}>
                このポリシーで定義されている許可
              </Header>
              <JsonBlock value={p.document} testId="policy-document" />
            </SpaceBetween>
          ) : (
            <Table variant="embedded" items={attachments} columnDefinitions={[{ id: 'n', header: 'エンティティ名', cell: (a) => <ConsoleLink to={a.type === 'ロール' ? rolePath(a.name) : userPath(a.name)}>{a.name}</ConsoleLink> }, { id: 't', header: 'エンティティタイプ', cell: (a) => a.type }]} empty="アタッチされたエンティティはありません" />
          )}
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

export function EditPolicy() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const path = useConsole((s) => s.path);
  const arn = queryParam(path, 'arn') ?? '';
  const p = findPolicy(env, arn);
  const [text, setText] = useState(p ? pretty(p.document) : '');
  const [error, setError] = useState<AwsError | null>(null);
  if (!p || p.awsManaged) return <NotFound what="カスタマー管理ポリシー" id={arn} />;
  return (
    <EditForm
      title={`ポリシー ${p.policyName} の編集`}
      description="新しいバージョンが作成され、デフォルトのバージョンとして設定されます。"
      submitText="変更を保存"
      submitTestId="save-policy"
      submitHotspotId="iam-save-policy"
      onCancel={() => navigate(policyPath(arn))}
      error={error}
      onSubmit={() => {
        const r = run((d) => updatePolicyDocument(d, arn, parsePolicy(text, 'identity')), `ポリシー ${p.policyName} が更新されました`);
        if (r.ok) navigate(policyPath(arn));
        else setError(r.error);
      }}
    >
      <Container>
        <PolicyEditor value={text} onChange={setText} kind="identity" testId="policy-editor" />
      </Container>
    </EditForm>
  );
}

export function CreatePolicyPage() {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [text, setText] = useState(SAMPLE_POLICY);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="ポリシーの作成"
      submitText="ポリシーの作成"
      submitTestId="create-policy-submit"
      onCancel={() => navigate('/iam/policies')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createPolicy(d, { policyName: name.trim(), description: desc, document: parsePolicy(text, 'identity') }), `ポリシー ${name} が作成されました`);
        if (r.ok) navigate(policyPath(r.value));
        else setError(r.error);
      }}
    >
      <Container>
        <SpaceBetween size="l">
          <PolicyEditor value={text} onChange={setText} kind="identity" testId="create-policy-editor" />
          <FormField label="ポリシー名"><Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="policy-name" /></FormField>
          <FormField label="説明 - オプション"><Input value={desc} onChange={(e) => setDesc(e.detail.value)} /></FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- policy simulator ----------------

const ACTIONS = ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:ListBucket', 's3:ListAllMyBuckets', 's3:GetBucketPolicy', 'ec2:DescribeInstances'];
const DECISION: Record<IamDecision['decision'], { type: 'success' | 'error' | 'warning'; text: string }> = {
  Allow: { type: 'success', text: '許可' },
  ExplicitDeny: { type: 'error', text: '拒否 (明示的な拒否)' },
  ImplicitDeny: { type: 'warning', text: '拒否 (暗黙的な拒否)' },
};

/** Simplified IAM Policy Simulator: identity policies + the bucket policy for S3 resources. */
export function PolicySimulator() {
  const env = useGlobalEnv();
  const [principal, setPrincipal] = useState(env.iamRoles[0] ? `role:${env.iamRoles[0].roleName}` : '');
  const [action, setAction] = useState('s3:GetObject');
  const [resource, setResource] = useState(env.buckets[0] ? `arn:aws:s3:::${env.buckets[0].name}/*` : '*');
  const [result, setResult] = useState<IamDecision | null>(null);
  const options = [...env.iamRoles.map((r) => ({ value: `role:${r.roleName}`, label: r.roleName, description: 'ロール' })), ...env.iamUsers.map((u) => ({ value: `user:${u.userName}`, label: u.userName, description: 'ユーザー' }))];
  const run = () => {
    const [t, n] = principal.split(':');
    const bucket = /^arn:aws:s3:::([^/]+)/.exec(resource)?.[1];
    const b = env.buckets.find((x) => x.name === bucket);
    setResult(evaluateIamPermission(env, { principal: t === 'role' ? { type: 'role', roleName: n, sessionName: 'simulator' } : { type: 'user', userName: n }, action, resource, resourcePolicy: b?.policy, context: { 'aws:SecureTransport': true } }));
  };
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="選択したプリンシパルのアイデンティティベースポリシーと、S3 リソースならバケットポリシーを評価します。">ポリシーシミュレーター</Header>
      <Container>
        <ColumnLayout columns={3}>
          <FormField label="ユーザー、グループ、ロール"><Select selectedOption={options.find((o) => o.value === principal) ?? null} options={options} onChange={(e) => setPrincipal(e.detail.selectedOption.value!)} data-testid="sim-principal" /></FormField>
          <FormField label="アクション"><Autosuggest value={action} onChange={(e) => setAction(e.detail.value)} options={ACTIONS.map((a) => ({ value: a }))} enteredTextLabel={(v) => `使用: "${v}"`} ariaLabel="アクション" data-testid="sim-action" /></FormField>
          <FormField label="リソース ARN"><Autosuggest value={resource} onChange={(e) => setResource(e.detail.value)} options={env.buckets.flatMap((b) => [{ value: `arn:aws:s3:::${b.name}` }, { value: `arn:aws:s3:::${b.name}/*` }])} enteredTextLabel={(v) => `使用: "${v}"`} ariaLabel="リソース ARN" data-testid="sim-resource" /></FormField>
        </ColumnLayout>
        <Box margin={{ top: 'm' }} float="right">
          <Button variant="primary" onClick={run} data-testid="sim-run">シミュレーションを実行</Button>
        </Box>
      </Container>
      {result && (
        <Container header={<Header variant="h2" description={result.reason}>結果: <span data-testid="sim-result"><StatusIndicator type={DECISION[result.decision].type}>{DECISION[result.decision].text}</StatusIndicator></span></Header>}>
          <Table
            variant="embedded"
            items={result.statements}
            empty="評価されたステートメントはありません"
            columnDefinitions={[
              { id: 'src', header: 'ポリシー', cell: (s) => `${s.source}${s.kind === 'resource' ? ' (リソースベース)' : ''}` },
              { id: 'sid', header: 'Sid', cell: (s) => s.sid ?? '-' },
              { id: 'eff', header: '効果', cell: (s) => s.effect },
              { id: 'app', header: '一致', cell: (s) => <StatusIndicator type={s.applies ? (s.effect === 'Deny' ? 'error' : 'success') : 'stopped'}>{s.applies ? (s.accountOnly ? '一致 (アカウント委任)' : '一致') : '不一致'}</StatusIndicator> },
              { id: 'why', header: '不一致の理由', cell: (s) => (s.mismatch ? `${s.mismatch} が一致しません` : '-') },
            ]}
          />
        </Container>
      )}
    </SpaceBetween>
  );
}
