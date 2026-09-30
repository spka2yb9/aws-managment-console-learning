import Alert from '@cloudscape-design/components/alert';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
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
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useState } from 'react';
import { REGIONS } from '../../sim/env';
import { parsePolicy } from '../../sim/iam';
import { attachScp, createAccountAssignment, createOrganizationalUnit, createPermissionSet, createScp, deleteAccountAssignment, deletePermissionSet, deleteScp, detachScp, entityName, moveAccount, pathOf, portalAccess, PREDEFINED_PERMISSION_SETS, testAccess, updateScp } from '../../sim/organizations';
import type { AccountAssignment, AwsError, Organization, OrgPolicy } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, DeleteModal, EditForm, errorText, formatDate, JsonBlock, NotFound, queryParam, ResourceDetail, ResourceTable, useGlobalEnv, useNavigate, useSelection } from '../ui';
import { PolicyEditor } from './iam';

const entityPath = (id: string) => `/organizations/accounts/${id}`;
const policyPath = (id: string) => `/organizations/policies/${id}`;
const kindOf = (org: Organization, id: string) => (id === org.rootId ? 'ルート' : org.ous.some((o) => o.id === id) ? '組織単位 (OU)' : 'AWS アカウント');
const NotEnabled = ({ what }: { what: string }) => <Alert type="info" header={`${what}は有効になっていません`}>このアカウントでは {what} を使っていません。</Alert>;

function useOrg() {
  return useGlobalEnv().organization;
}

// ---------------- AWS Organizations ----------------

interface OrgNode {
  id: string;
  name: string;
  kind: 'root' | 'ou' | 'account';
  email?: string;
  joinedAt?: number;
}

function children(org: Organization, id: string): OrgNode[] {
  return [
    ...org.ous.filter((o) => o.parentId === id).map((o): OrgNode => ({ id: o.id, name: o.name, kind: 'ou' })),
    ...org.accounts.filter((a) => a.parentId === id).map((a): OrgNode => ({ id: a.id, name: a.name, kind: 'account', email: a.email, joinedAt: a.joinedAt })),
  ];
}

function MoveModal({ org, account, onClose }: { org: Organization; account: OrgNode; onClose: () => void }) {
  const run = useConsole((s) => s.run);
  const [dest, setDest] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const options = [{ value: org.rootId, label: 'Root' }, ...org.ous.map((o) => ({ value: o.id, label: o.name, description: o.id }))];
  return (
    <Modal
      visible
      onDismiss={onClose}
      header={`AWS アカウント「${account.name}」を移動`}
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>キャンセル</Button>
            <Button variant="primary" data-testid="move-submit" onClick={() => {
              const r = run((d) => moveAccount(d, account.id, dest), `${account.name} を ${entityName(org, dest)} に移動しました`);
              if (r.ok) onClose();
              else setError(r.error);
            }}>AWS アカウントを移動</Button>
          </SpaceBetween>
        </Box>
      }
    >
      <FormField label="移動先" description="アカウントには、移動先とその上位 (ルートまで) にアタッチされた SCP がすべて適用されます。" errorText={errorText(error)}>
        <Select selectedOption={options.find((o) => o.value === dest) ?? null} placeholder="ルートまたは組織単位を選択" options={options} onChange={(e) => setDest(e.detail.selectedOption.value!)} data-testid="move-destination" />
      </FormField>
    </Modal>
  );
}

function CreateOuModal({ org, parent, onClose }: { org: Organization; parent: OrgNode; onClose: () => void }) {
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <Modal
      visible
      onDismiss={onClose}
      header="組織単位を作成"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>キャンセル</Button>
            <Button variant="primary" onClick={() => {
              const r = run((d) => createOrganizationalUnit(d, parent.id, name), `組織単位 ${name.trim()} を作成しました`);
              if (r.ok) onClose();
              else setError(r.error);
            }}>組織単位を作成</Button>
          </SpaceBetween>
        </Box>
      }
    >
      <SpaceBetween size="m">
        <Box>親: {entityName(org, parent.id)}</Box>
        <FormField label="組織単位名" errorText={errorText(error)}><Input value={name} onChange={(e) => setName(e.detail.value)} /></FormField>
      </SpaceBetween>
    </Modal>
  );
}

export function OrgAccounts() {
  const org = useOrg();
  const [selected, setSelected] = useState<OrgNode[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [modal, setModal] = useState<'move' | 'ou' | null>(null);
  if (!org) return <NotEnabled what="AWS Organizations" />;
  const root: OrgNode = { id: org.rootId, name: 'Root', kind: 'root' };
  const all = [root, ...org.ous.map((o): OrgNode => ({ id: o.id, name: o.name, kind: 'ou' })), ...org.accounts.map((a): OrgNode => ({ id: a.id, name: a.name, kind: 'account' }))];
  const pick = selected[0] && all.find((n) => n.id === selected[0].id);
  return (
    <SpaceBetween size="l">
      <Table
        variant="full-page"
        data-testid="org-tree"
        header={
          <Header
            variant="awsui-h1-sticky"
            description="組織の構造: ルートの下に組織単位 (OU) とアカウントを配置します。SCP は上位からすべて継承されます。"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button disabled={!pick || pick.kind === 'account'} onClick={() => setModal('ou')}>組織単位を作成</Button>
                <Hotspot hotspotId="org-move" direction="right">
                  <Button disabled={pick?.kind !== 'account'} onClick={() => setModal('move')} data-testid="org-move">移動</Button>
                </Hotspot>
              </SpaceBetween>
            }
          >
            AWS アカウント
          </Header>
        }
        items={[root]}
        trackBy="id"
        selectionType="single"
        selectedItems={pick ? [pick] : []}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        ariaLabels={{ itemSelectionLabel: (_, n) => `${n.name} を選択`, selectionGroupLabel: '組織の選択' }}
        expandableRows={{
          getItemChildren: (n) => children(org, n.id),
          isItemExpandable: (n) => n.kind !== 'account',
          expandedItems: all.filter((n) => n.kind !== 'account' && !collapsed.includes(n.id)),
          onExpandableItemToggle: (e) => setCollapsed(e.detail.expanded ? collapsed.filter((c) => c !== e.detail.item.id) : [...collapsed, e.detail.item.id]),
        }}
        columnDefinitions={[
          { id: 'name', header: '組織構造', cell: (n) => <ConsoleLink to={entityPath(n.id)}>{n.name}</ConsoleLink> },
          { id: 'id', header: 'ID', cell: (n) => n.id },
          { id: 'kind', header: 'タイプ', cell: (n) => (n.kind === 'root' ? 'ルート' : n.kind === 'ou' ? '組織単位' : n.id === org.managementAccountId ? '管理アカウント' : 'メンバーアカウント') },
          { id: 'email', header: 'E メール', cell: (n) => n.email ?? '' },
          { id: 'joined', header: '参加日時', cell: (n) => (n.joinedAt ? formatDate(n.joinedAt) : '') },
        ]}
      />
      {modal === 'move' && pick && <MoveModal org={org} account={pick} onClose={() => setModal(null)} />}
      {modal === 'ou' && pick && <CreateOuModal org={org} parent={pick} onClose={() => setModal(null)} />}
    </SpaceBetween>
  );
}

function AttachModal({ org, targetId, policyId, onClose }: { org: Organization; targetId?: string; policyId?: string; onClose: () => void }) {
  const run = useConsole((s) => s.run);
  const [value, setValue] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  // either "which policy to this target" or "which target for this policy"
  const options = targetId
    ? org.policies.filter((p) => !p.targets.includes(targetId)).map((p) => ({ value: p.id, label: p.name, description: p.description }))
    : [{ id: org.rootId, name: 'Root' }, ...org.ous, ...org.accounts].filter((t) => !org.policies.find((p) => p.id === policyId)?.targets.includes(t.id)).map((t) => ({ value: t.id, label: t.name, description: `${kindOf(org, t.id)} ${t.id}` }));
  return (
    <Modal
      visible
      onDismiss={onClose}
      header="ポリシーをアタッチ"
      footer={
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={onClose}>キャンセル</Button>
            <Button variant="primary" data-testid="attach-scp-submit" onClick={() => {
              const [p, t] = targetId ? [value, targetId] : [policyId!, value];
              const r = run((d) => attachScp(d, p, t), `ポリシーを ${entityName(org, t)} にアタッチしました`);
              if (r.ok) onClose();
              else setError(r.error);
            }}>ポリシーをアタッチ</Button>
          </SpaceBetween>
        </Box>
      }
    >
      <FormField label={targetId ? 'サービスコントロールポリシー' : 'ターゲット (ルート / OU / アカウント)'} errorText={errorText(error)}>
        <Select selectedOption={options.find((o) => o.value === value) ?? null} placeholder="選択" options={options} onChange={(e) => setValue(e.detail.selectedOption.value!)} data-testid="attach-scp-select" />
      </FormField>
    </Modal>
  );
}

export function OrgEntityDetail({ id }: { id: string }) {
  const org = useOrg();
  const run = useConsole((s) => s.run);
  const [attach, setAttach] = useState(false);
  const [selected, setSelected] = useState<OrgPolicy[]>([]);
  if (!org) return <NotEnabled what="AWS Organizations" />;
  const known = id === org.rootId || org.ous.some((o) => o.id === id) || org.accounts.some((a) => a.id === id);
  if (!known) return <NotFound what="組織のエンティティ" id={id} />;
  const account = org.accounts.find((a) => a.id === id);
  const direct = org.policies.filter((p) => p.targets.includes(id));
  const inherited = pathOf(org, id).slice(0, -1).map((t) => ({ t, policies: org.policies.filter((p) => p.targets.includes(t)) }));
  const pick = selected.filter((p) => direct.some((d) => d.id === p.id));
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={kindOf(org, id)}>{entityName(org, id)}</Header>
      <ResourceDetail
        columns={3}
        fields={[
          { label: 'ID', value: <CopyableValue value={id} /> },
          { label: 'パス', value: <span data-testid="org-path">{pathOf(org, id).map((p) => entityName(org, p)).join(' / ')}</span> },
          ...(account ? [{ label: 'E メール', value: account.email }, { label: '参加日時', value: formatDate(account.joinedAt) }] : []),
          ...(id === org.managementAccountId ? [{ label: '注意', value: '管理アカウントには SCP が適用されません' }] : []),
        ]}
      />
      <Table
        variant="container"
        data-testid="scp-direct"
        header={
          <Header
            counter={`(${direct.length})`}
            description="このエンティティに直接アタッチされたサービスコントロールポリシー"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button disabled={!pick.length} onClick={() => run((d) => detachScp(d, pick[0].id, id), `${pick[0].name} をデタッチしました`) && setSelected([])} data-testid="detach-scp">デタッチ</Button>
                <Hotspot hotspotId="org-attach-scp" direction="right">
                  <Button onClick={() => setAttach(true)} data-testid="attach-scp">アタッチ</Button>
                </Hotspot>
              </SpaceBetween>
            }
          >
            直接アタッチ
          </Header>
        }
        items={direct}
        trackBy="id"
        selectionType="single"
        selectedItems={pick}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        columnDefinitions={[
          { id: 'name', header: 'ポリシー名', cell: (p) => <ConsoleLink to={policyPath(p.id)}>{p.name}</ConsoleLink> },
          { id: 'type', header: '種類', cell: (p) => (p.awsManaged ? 'AWS 管理' : 'カスタマー管理') },
          { id: 'desc', header: '説明', cell: (p) => p.description ?? '-' },
        ]}
      />
      {inherited.length > 0 && (
        <Table
          variant="container"
          data-testid="scp-inherited"
          header={<Header description="上位のルート / OU から継承されるポリシー。すべてのレベルで許可され、どこでも拒否されていない操作だけが実行できます。">継承元</Header>}
          items={inherited}
          columnDefinitions={[
            { id: 'from', header: '継承元', cell: (x) => <ConsoleLink to={entityPath(x.t)}>{entityName(org, x.t)}</ConsoleLink> },
            { id: 'policies', header: 'ポリシー', cell: (x) => x.policies.map((p) => p.name).join(', ') },
          ]}
        />
      )}
      {attach && <AttachModal org={org} targetId={id} onClose={() => setAttach(false)} />}
    </SpaceBetween>
  );
}

export function ScpList() {
  const org = useOrg();
  const navigate = useNavigate();
  if (!org) return <NotEnabled what="AWS Organizations" />;
  return (
    <ResourceTable
      title="サービスコントロールポリシー"
      description="組織のアカウントで使える権限の上限 (ガードレール) を決めます。SCP は権限を付与しません。"
      resourceName="ポリシー"
      testId="scp-list"
      items={org.policies}
      trackBy={(p) => p.id}
      selectionType="none"
      actions={
        <Hotspot hotspotId="org-create-scp" direction="right">
          <Button variant="primary" onClick={() => navigate('/organizations/policies/create')} data-testid="create-scp">ポリシーを作成</Button>
        </Hotspot>
      }
      columns={[
        { id: 'name', header: 'ポリシー名', cell: (p) => <ConsoleLink to={policyPath(p.id)}>{p.name}</ConsoleLink>, value: (p) => p.name },
        { id: 'type', header: '種類', cell: (p) => (p.awsManaged ? 'AWS 管理' : 'カスタマー管理') },
        { id: 'desc', header: '説明', cell: (p) => p.description ?? '-' },
        { id: 'targets', header: 'アタッチ先', cell: (p) => p.targets.map((t) => entityName(org, t)).join(', ') || '-' },
      ]}
    />
  );
}

const SCP_TEMPLATE = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'Statement1', Effect: 'Deny', Action: [], Resource: '*' }] }, null, 2);

export function CreateScp() {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [text, setText] = useState(SCP_TEMPLATE);
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="サービスコントロールポリシーを作成"
      submitText="ポリシーを作成"
      submitTestId="create-scp-submit"
      submitHotspotId="org-create-scp-submit"
      onCancel={() => navigate('/organizations/policies')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createScp(d, { name: name.trim(), description: desc.trim() || undefined, document: parsePolicy(text, 'identity') }), `ポリシー ${name.trim()} を作成しました`);
        if (r.ok) navigate(policyPath(r.value));
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">詳細</Header>}>
        <SpaceBetween size="m">
          <FormField label="ポリシー名"><Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="scp-name" /></FormField>
          <FormField label="ポリシーの説明 - オプション"><Input value={desc} onChange={(e) => setDesc(e.detail.value)} /></FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="IAM ポリシーと同じ書き方です (Principal は書けません)。Deny で禁止する操作を書くのが一般的です。">ポリシー</Header>}>
        <PolicyEditor value={text} onChange={setText} kind="identity" testId="scp-editor" />
      </Container>
    </EditForm>
  );
}

export function EditScp({ id }: { id: string }) {
  const org = useOrg();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const p = org?.policies.find((x) => x.id === id);
  const [text, setText] = useState(p ? JSON.stringify(p.document, null, 2) : '');
  const [error, setError] = useState<AwsError | null>(null);
  if (!org || !p) return <NotFound what="ポリシー" id={id} />;
  return (
    <EditForm
      title={`${p.name} を編集`}
      submitText="変更を保存"
      submitTestId="edit-scp-submit"
      onCancel={() => navigate(policyPath(id))}
      error={error}
      onSubmit={() => {
        const r = run((d) => updateScp(d, id, parsePolicy(text, 'identity')), `ポリシー ${p.name} を更新しました`);
        if (r.ok) navigate(policyPath(id));
        else setError(r.error);
      }}
    >
      <Container><PolicyEditor value={text} onChange={setText} kind="identity" testId="scp-editor" /></Container>
    </EditForm>
  );
}

export function ScpDetail({ id }: { id: string }) {
  const org = useOrg();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [attach, setAttach] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const p = org?.policies.find((x) => x.id === id);
  const [selected, setSelected] = useSelection(p?.targets.map((t) => ({ t })) ?? [], (x) => x.t);
  if (!org || !p) return <NotFound what="ポリシー" id={id} />;
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description={p.description}
        actions={
          !p.awsManaged && (
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => setDeleting(true)} data-testid="delete-scp">削除</Button>
              <Button onClick={() => navigate(`${policyPath(id)}/edit`)} data-testid="edit-scp">ポリシーを編集</Button>
            </SpaceBetween>
          )
        }
      >
        {p.name}
      </Header>
      {deleting && (
        <DeleteModal
          header="ポリシーを削除"
          testId="delete-scp"
          onClose={() => setDeleting(false)}
          onDelete={() => {
            const r = run((d) => deleteScp(d, id), `ポリシー ${p.name} を削除しました`);
            if (r.ok) navigate('/organizations/policies');
            return r;
          }}
        >
          <Box>{p.name} を削除しますか? ルート / OU / アカウントにアタッチされている間は削除できません。先にすべてのターゲットからデタッチします。</Box>
        </DeleteModal>
      )}
      <ResourceDetail columns={3} fields={[{ label: 'ポリシー ID', value: p.id }, { label: '種類', value: p.awsManaged ? 'AWS 管理' : 'カスタマー管理' }, { label: 'ARN', value: <CopyableValue value={p.arn} iconOnly /> }]} />
      <Container header={<Header variant="h2">ポリシーの内容</Header>}>
        <JsonBlock value={p.document} testId="scp-document" />
      </Container>
      <Table
        variant="container"
        data-testid="scp-targets"
        header={
          <Header
            counter={`(${p.targets.length})`}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button disabled={selected.length !== 1} onClick={() => run((d) => detachScp(d, id, selected[0].t), `${entityName(org, selected[0].t)} からデタッチしました`) && setSelected([])}>デタッチ</Button>
                <Hotspot hotspotId="org-scp-attach" direction="right">
                  <Button onClick={() => setAttach(true)} data-testid="scp-attach">アタッチ</Button>
                </Hotspot>
              </SpaceBetween>
            }
          >
            ターゲット
          </Header>
        }
        items={p.targets.map((t) => ({ t }))}
        trackBy="t"
        selectionType="single"
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        empty={<Box color="text-body-secondary">どこにもアタッチされていません</Box>}
        columnDefinitions={[
          { id: 'name', header: '名前', cell: (x) => <ConsoleLink to={entityPath(x.t)}>{entityName(org, x.t)}</ConsoleLink> },
          { id: 'kind', header: 'タイプ', cell: (x) => kindOf(org, x.t) },
          { id: 'id', header: 'ID', cell: (x) => x.t },
        ]}
      />
      {attach && <AttachModal org={org} policyId={id} onClose={() => setAttach(false)} />}
    </SpaceBetween>
  );
}

// ---------------- IAM Identity Center ----------------

function useSso() {
  return useGlobalEnv().identityCenter;
}

export function SsoHome() {
  const sso = useSso();
  if (!sso) return <NotEnabled what="IAM Identity Center" />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="組織のすべてのアカウントへのアクセスを、1 か所で管理します。人は一時的な認証情報でサインインします (長期のアクセスキーは不要)。">IAM Identity Center</Header>
      <ResourceDetail
        title="設定の概要"
        columns={3}
        fields={[
          { label: 'リージョン', value: sso.region },
          { label: 'ID ストア', value: sso.identityStoreId },
          { label: 'AWS アクセスポータルの URL', value: <ConsoleLink to="/sso/portal">{`https://${sso.identityStoreId}.awsapps.com/start`}</ConsoleLink> },
          { label: 'ユーザー', value: String(sso.users.length) },
          { label: 'グループ', value: String(sso.groups.length) },
          { label: '許可セット', value: String(sso.permissionSets.length) },
        ]}
      />
      <Container header={<Header variant="h2">しくみ</Header>}>
        <SpaceBetween size="xs">
          <Box>1. <b>許可セット</b>: 「このアカウントで何ができるか」のテンプレート (例: ReadOnlyAccess)。</Box>
          <Box>2. <b>割り当て</b>: 「どのアカウントで・誰 (グループ) に・どの許可セット」を組み合わせる。各アカウントに AWSReservedSSO_… ロールが作られます。</Box>
          <Box>3. ユーザーは <b>AWS アクセスポータル</b> からアカウントと許可セットを選んでサインインします。実際にできることは、許可セットと SCP の両方が許可した操作だけです。</Box>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

export function SsoUsers() {
  const sso = useSso();
  if (!sso) return <NotEnabled what="IAM Identity Center" />;
  return (
    <ResourceTable
      title="ユーザー"
      resourceName="ユーザー"
      items={sso.users}
      trackBy={(u) => u.userName}
      selectionType="none"
      columns={[
        { id: 'name', header: 'ユーザー名', cell: (u) => u.userName, value: (u) => u.userName },
        { id: 'display', header: '表示名', cell: (u) => u.displayName },
        { id: 'email', header: 'E メール', cell: (u) => u.email },
        { id: 'groups', header: 'グループ', cell: (u) => u.groups.join(', ') },
      ]}
    />
  );
}

export function SsoGroups() {
  const sso = useSso();
  if (!sso) return <NotEnabled what="IAM Identity Center" />;
  return (
    <ResourceTable
      title="グループ"
      resourceName="グループ"
      items={sso.groups}
      trackBy={(g) => g.groupName}
      selectionType="none"
      columns={[
        { id: 'name', header: 'グループ名', cell: (g) => g.groupName, value: (g) => g.groupName },
        { id: 'desc', header: '説明', cell: (g) => g.description ?? '-' },
        { id: 'members', header: 'メンバー', cell: (g) => sso.users.filter((u) => u.groups.includes(g.groupName)).map((u) => u.userName).join(', ') },
      ]}
    />
  );
}

export function PermissionSets() {
  const sso = useSso();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [selected, setSelected] = useSelection(sso?.permissionSets ?? [], (p) => p.arn);
  const [deleting, setDeleting] = useState(false);
  if (!sso) return <NotEnabled what="IAM Identity Center" />;
  return (
    <>
      <ResourceTable
        title="許可セット"
        resourceName="許可セット"
        testId="permission-sets"
        items={sso.permissionSets}
        trackBy={(p) => p.arn}
        selectedItems={selected}
        onSelectionChange={setSelected}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button disabled={selected.length !== 1} onClick={() => setDeleting(true)} data-testid="delete-permission-set">削除</Button>
            <Hotspot hotspotId="sso-create-ps" direction="right">
              <Button variant="primary" onClick={() => navigate('/sso/permission-sets/create')} data-testid="create-permission-set">許可セットを作成</Button>
            </Hotspot>
          </SpaceBetween>
        }
        columns={[
          { id: 'name', header: '名前', cell: (p) => p.name, value: (p) => p.name },
          { id: 'policies', header: 'AWS 管理ポリシー', cell: (p) => p.managedPolicyArns.map((a) => a.split('/').pop()).join(', ') },
          { id: 'session', header: 'セッション期間', cell: (p) => p.sessionDuration.replace(/^PT(\d+)H$/, '$1 時間') },
          { id: 'created', header: '作成日', cell: (p) => formatDate(p.createdAt) },
        ]}
      />
      {deleting && selected[0] && (
        <DeleteModal header="許可セットを削除" testId="delete-ps" onClose={() => { setDeleting(false); setSelected([]); }} onDelete={() => run((d) => deletePermissionSet(d, selected[0].arn), `許可セット ${selected[0].name} を削除しました`)}>
          <Box>{selected[0].name} を削除しますか? アカウントに割り当てられている間は削除できません。</Box>
        </DeleteModal>
      )}
    </>
  );
}

export function CreatePermissionSetPage() {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [policy, setPolicy] = useState('ReadOnlyAccess');
  const [name, setName] = useState('');
  const [hours, setHours] = useState('1');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="許可セットを作成"
      submitText="作成"
      submitTestId="create-permission-set-submit"
      submitHotspotId="sso-create-ps-submit"
      onCancel={() => navigate('/sso/permission-sets')}
      error={error}
      onSubmit={() => {
        const n = name.trim() || policy;
        const r = run((d) => createPermissionSet(d, { name: n, managedPolicyArns: [`arn:aws:iam::aws:policy/${policy}`], sessionDuration: `PT${hours}H` }), `許可セット ${n} を作成しました`);
        if (r.ok) navigate('/sso/permission-sets');
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">許可セットのタイプ: 事前定義された許可セット</Header>}>
        <FormField label="事前定義された許可セットのポリシー">
          <RadioGroup value={policy} onChange={(e) => setPolicy(e.detail.value)} items={PREDEFINED_PERMISSION_SETS.map((p) => ({ value: p.name, label: p.name, description: p.description }))} data-testid="permission-set-policy" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">許可セットの詳細</Header>}>
        <SpaceBetween size="m">
          <FormField label="許可セット名" description="空欄なら、ポリシー名と同じ名前になります。"><Input value={name} onChange={(e) => setName(e.detail.value)} placeholder={policy} /></FormField>
          <FormField label="セッション期間"><Select selectedOption={{ value: hours, label: `${hours} 時間` }} options={['1', '4', '8', '12'].map((h) => ({ value: h, label: `${h} 時間` }))} onChange={(e) => setHours(e.detail.selectedOption.value!)} /></FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

const assignmentsOf = (sso: NonNullable<ReturnType<typeof useSso>>, accountId: string) => sso.assignments.filter((a) => a.accountId === accountId);

export function SsoAccounts() {
  const env = useGlobalEnv();
  const org = env.organization;
  const sso = env.identityCenter;
  if (!org || !sso) return <NotEnabled what="IAM Identity Center" />;
  return (
    <ResourceTable
      title="AWS アカウント"
      description="アカウントを選んで、ユーザーまたはグループに許可セットを割り当てます。"
      resourceName="アカウント"
      testId="sso-accounts"
      items={org.accounts}
      trackBy={(a) => a.id}
      selectionType="none"
      columns={[
        { id: 'name', header: 'アカウント名', cell: (a) => <ConsoleLink to={`/sso/accounts/${a.id}`}>{a.name}</ConsoleLink>, value: (a) => a.name },
        { id: 'id', header: 'アカウント ID', cell: (a) => a.id, value: (a) => a.id },
        { id: 'ou', header: '組織単位', cell: (a) => entityName(org, a.parentId) },
        { id: 'assigned', header: '割り当て', cell: (a) => assignmentsOf(sso, a.id).map((x) => `${x.principalName}: ${sso.permissionSets.find((p) => p.arn === x.permissionSetArn)?.name}`).join(', ') || '-' },
      ]}
    />
  );
}

export function SsoAccountDetail({ id }: { id: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const org = env.organization;
  const sso = env.identityCenter;
  const items = sso ? assignmentsOf(sso, id) : [];
  const key = (a: AccountAssignment) => `${a.principalType}|${a.principalName}|${a.permissionSetArn}`;
  const [selected, setSelected] = useSelection(items, key);
  if (!org || !sso) return <NotEnabled what="IAM Identity Center" />;
  const account = org.accounts.find((a) => a.id === id);
  if (!account) return <NotFound what="アカウント" id={id} />;
  const psName = (arn: string) => sso.permissionSets.find((p) => p.arn === arn)?.name ?? arn;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`${id} / ${entityName(org, account.parentId)}`}>{account.name}</Header>
      <Table
        variant="container"
        data-testid="sso-assignments"
        header={
          <Header
            counter={`(${items.length})`}
            description="このアカウントにアクセスできるユーザーとグループ"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Hotspot hotspotId="sso-remove-access" direction="right">
                  <Button disabled={selected.length !== 1} onClick={() => run((d) => deleteAccountAssignment(d, selected[0]), `${selected[0].principalName} の ${psName(selected[0].permissionSetArn)} を削除しました`) && setSelected([])} data-testid="remove-access">アクセスを削除</Button>
                </Hotspot>
                <Hotspot hotspotId="sso-assign" direction="right">
                  <Button variant="primary" onClick={() => navigate(`/sso/accounts/${id}/assign`)} data-testid="assign-access">ユーザーまたはグループを割り当て</Button>
                </Hotspot>
              </SpaceBetween>
            }
          >
            割り当てられたユーザーとグループ
          </Header>
        }
        items={items}
        trackBy={key}
        selectionType="single"
        selectedItems={selected}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems)}
        ariaLabels={{ itemSelectionLabel: (_, a) => `${a.principalName} ${psName(a.permissionSetArn)} を選択`, selectionGroupLabel: '割り当ての選択' }}
        empty={<Box color="text-body-secondary">割り当てはありません</Box>}
        columnDefinitions={[
          { id: 'name', header: 'ユーザー/グループ', cell: (a) => a.principalName },
          { id: 'type', header: 'タイプ', cell: (a) => (a.principalType === 'GROUP' ? 'グループ' : 'ユーザー') },
          { id: 'ps', header: '許可セット', cell: (a) => psName(a.permissionSetArn) },
        ]}
      />
    </SpaceBetween>
  );
}

export function AssignAccess({ id }: { id: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const sso = env.identityCenter;
  const [type, setType] = useState<'GROUP' | 'USER'>('GROUP');
  const [principal, setPrincipal] = useState('');
  const [ps, setPs] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  if (!sso || !env.organization) return <NotEnabled what="IAM Identity Center" />;
  const principals = type === 'GROUP' ? sso.groups.map((g) => ({ value: g.groupName, label: g.groupName, description: g.description })) : sso.users.map((u) => ({ value: u.userName, label: u.userName, description: u.displayName }));
  const psOptions = sso.permissionSets.map((p) => ({ value: p.arn, label: p.name }));
  return (
    <EditForm
      title={`${entityName(env.organization, id)} に割り当て`}
      submitText="送信"
      submitTestId="assign-submit"
      submitHotspotId="sso-assign-submit"
      onCancel={() => navigate(`/sso/accounts/${id}`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => createAccountAssignment(d, { accountId: id, permissionSetArn: ps, principalType: type, principalName: principal }), `${principal} に割り当てました`);
        if (r.ok) navigate(`/sso/accounts/${id}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">ユーザーとグループ</Header>}>
        <SpaceBetween size="m">
          <RadioGroup value={type} onChange={(e) => { setType(e.detail.value as typeof type); setPrincipal(''); }} items={[{ value: 'GROUP', label: 'グループ (推奨)' }, { value: 'USER', label: 'ユーザー' }]} />
          <Select selectedOption={principals.find((p) => p.value === principal) ?? null} placeholder="選択" options={principals} onChange={(e) => setPrincipal(e.detail.selectedOption.value!)} data-testid="assign-principal" />
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">許可セット</Header>}>
        <Select selectedOption={psOptions.find((p) => p.value === ps) ?? null} placeholder="許可セットを選択" options={psOptions} onChange={(e) => setPs(e.detail.selectedOption.value!)} data-testid="assign-permission-set" />
      </Container>
    </EditForm>
  );
}

const COMMON_ACTIONS = ['ec2:DescribeInstances', 'ec2:RunInstances', 'ec2:TerminateInstances', 's3:GetObject', 's3:DeleteBucket', 'rds:DeleteDBInstance', 'rds:DeleteDBSnapshot', 'cloudtrail:StopLogging', 'cloudtrail:DeleteTrail', 'iam:CreateRole', 'organizations:LeaveOrganization'];

/** The AWS access portal (https://d-xxxx.awsapps.com/start), with a simulator panel that tries one API call. */
export function AccessPortal() {
  const env = useGlobalEnv();
  const path = useConsole((s) => s.path);
  const navigate = useNavigate();
  const q = (k: string) => queryParam(path, k) ?? '';
  const [action, setAction] = useState(q('action') || 'ec2:RunInstances');
  const [region, setRegion] = useState(q('region') || 'ap-northeast-1');
  const org = env.organization;
  const sso = env.identityCenter;
  if (!org || !sso) return <NotEnabled what="IAM Identity Center" />;
  const user = q('user');
  const go = (p: Record<string, string>) => navigate(`/sso/portal?${new URLSearchParams(Object.fromEntries(Object.entries({ user, ...p }).filter(([, v]) => v)))}`);
  const access = user ? portalAccess(env, user) : [];
  const account = q('account');
  const ps = q('ps');
  const tested = account && ps && q('action') ? testAccess(env, { userName: user, accountId: account, permissionSetName: ps, action: q('action'), region: q('region') || 'ap-northeast-1' }) : undefined;
  const userOptions = sso.users.map((u) => ({ value: u.userName, label: u.userName, description: u.displayName }));
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`https://${sso.identityStoreId}.awsapps.com/start (シミュレーター: ユーザーを選んでサインインした状態を再現します)`}>AWS アクセスポータル</Header>
      <Container>
        <FormField label="サインインするユーザー">
          <Select selectedOption={userOptions.find((u) => u.value === user) ?? null} placeholder="ユーザーを選択" options={userOptions} onChange={(e) => navigate(`/sso/portal?user=${e.detail.selectedOption.value}`)} data-testid="portal-user" />
        </FormField>
      </Container>
      {!!user && (
        <Table
          variant="container"
          data-testid="portal-accounts"
          header={<Header counter={`(${access.length})`} description="このユーザーがサインインできるアカウントと許可セット">AWS アカウント</Header>}
          items={access}
          empty={<Box color="text-body-secondary">アクセスできるアカウントはありません</Box>}
          columnDefinitions={[
            { id: 'account', header: 'アカウント', cell: (a) => <><Box>{`${entityName(org, a.accountId)} (${a.accountId})`}</Box><Box variant="small" color="text-body-secondary">{`OU: ${entityName(org, org.accounts.find((x) => x.id === a.accountId)?.parentId ?? '')}`}</Box></> },
            { id: 'ps', header: '許可セット (ロール)', cell: (a) => <><Box>{a.permissionSet.name}</Box><Box variant="small" color="text-body-secondary">{a.via}</Box></> },
            { id: 'try', header: '', cell: (a) => <Button wrapText={false} onClick={() => go({ account: a.accountId, ps: a.permissionSet.name })} data-testid={`portal-try-${a.accountId}-${a.permissionSet.name}`}>アクセスを試す</Button> },
          ]}
        />
      )}
      {!!(user && account && ps) && (
        <Container header={<Header variant="h2" description={`${user} として ${entityName(org, account)} に ${ps} でサインインし、API を 1 回呼び出します。`}>アクセスを試す</Header>}>
          <SpaceBetween size="m">
            <ColumnLayout columns={2}>
              <FormField label="アクション">
                <Autosuggest value={action} onChange={(e) => setAction(e.detail.value)} options={COMMON_ACTIONS.map((a) => ({ value: a }))} enteredTextLabel={(v) => `使用: "${v}"`} ariaLabel="アクション" data-testid="portal-action" />
              </FormField>
              <FormField label="リージョン">
                <Select selectedOption={{ value: region, label: `${REGIONS.find((r) => r.code === region)?.name} (${region})` }} options={REGIONS.map((r) => ({ value: r.code, label: `${r.name} (${r.code})` }))} onChange={(e) => setRegion(e.detail.selectedOption.value!)} data-testid="portal-region" />
              </FormField>
            </ColumnLayout>
            <Hotspot hotspotId="sso-portal-run" direction="right">
              <Button variant="primary" onClick={() => go({ account, ps, action: action.trim(), region })} data-testid="portal-run">実行</Button>
            </Hotspot>
            {tested && (
              <div data-testid="portal-result">
                <SpaceBetween size="s">
                  {tested.allowed ? <StatusIndicator>{`${q('action')} (${q('region')}) は許可されました`}</StatusIndicator> : <Box variant="code">{`An error occurred (AccessDenied): ${tested.error}`}</Box>}
                  <ul className="trace-list">
                    {tested.layers.map((l) => (
                      <li key={l.label}>
                        <StatusIndicator type={l.ok ? 'success' : 'error'}>{l.label}</StatusIndicator>
                        <Box variant="small" display="block" color="text-body-secondary">{l.detail}</Box>
                      </li>
                    ))}
                  </ul>
                </SpaceBetween>
              </div>
            )}
          </SpaceBetween>
        </Container>
      )}
    </SpaceBetween>
  );
}
