import AttributeEditor from '@cloudscape-design/components/attribute-editor';
import Autosuggest from '@cloudscape-design/components/autosuggest';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useState, type ReactNode } from 'react';
import { label, nameOf } from '../../sim/env';
import { associateSubnetNacl, createNetworkAcl, entryPorts, replaceNetworkAclEntries, setNaclSubnetAssociations, subnetNacl, type NaclEntryInput } from '../../sim/nacl';
import { RULE_TYPES, ruleTypeOf } from '../../sim/sg';
import type { AwsError, IpProtocol, NetworkAcl, NetworkAclEntry, Subnet } from '../../sim/types';
import { pick, vpcOption } from '../options';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, EditForm, NotFound, ResourceDetail, ResourceTable, ResourceTabs, nameCell, useEnv, useNavigate, useSelection } from '../ui';
import { portsSchema } from './sg';
import { Tags } from './vpc';

const PROTOCOL_LABEL: Record<IpProtocol, string> = { tcp: 'TCP (6)', udp: 'UDP (17)', icmp: 'ICMP (1)', '-1': 'すべて' };
const naclPath = (id: string) => `/vpc/network-acls/${id}`;
const ruleCount = (a: NetworkAcl, egress: boolean) => `${a.entries.filter((e) => e.egress === egress).length + 1} 個のルール`;

function portLabel(e: Pick<NetworkAclEntry, 'protocol' | 'fromPort' | 'toPort'>) {
  if (e.protocol !== 'tcp' && e.protocol !== 'udp') return 'すべて';
  const [a, b] = entryPorts(e);
  return a === b ? String(a) : `${a} - ${b}`;
}

function typeLabel(e: NetworkAclEntry) {
  const ports = entryPorts(e);
  return ruleTypeOf({ ipProtocol: e.protocol, fromPort: e.protocol === '-1' ? -1 : ports[0], toPort: e.protocol === '-1' ? -1 : ports[1] }).label;
}

function Action({ a }: { a: 'allow' | 'deny' }) {
  return <StatusIndicator type={a === 'allow' ? 'success' : 'error'}>{a === 'allow' ? '許可' : '拒否'}</StatusIndicator>;
}

type Row = { key: string; ruleNumber: string; e?: NetworkAclEntry };

/** Rules in evaluation order, ending with the implicit "*" deny-all rule the console always shows. */
export function NaclRulesTable({ acl, egress, actions }: { acl: NetworkAcl; egress: boolean; actions?: ReactNode }) {
  const rows: Row[] = [
    ...acl.entries.filter((e) => e.egress === egress).sort((a, b) => a.ruleNumber - b.ruleNumber).map((e) => ({ key: String(e.ruleNumber), ruleNumber: String(e.ruleNumber), e })),
    { key: '*', ruleNumber: '*' },
  ];
  return (
    <div data-testid={`nacl-${egress ? 'outbound' : 'inbound'}-rules`}>
      <Table<Row>
        variant="container"
        header={<Header counter={`(${rows.length})`} actions={actions} description="ルールはルール番号の小さい順に評価され、最初に一致したルールで許可または拒否が決まります。">{egress ? 'アウトバウンドルール' : 'インバウンドルール'}</Header>}
        items={rows}
        trackBy="key"
        columnDefinitions={[
          { id: 'n', header: 'ルール番号', cell: (r) => r.ruleNumber },
          { id: 'type', header: 'タイプ', cell: (r) => (r.e ? typeLabel(r.e) : 'すべてのトラフィック') },
          { id: 'proto', header: 'プロトコル', cell: (r) => (r.e ? PROTOCOL_LABEL[r.e.protocol] : 'すべて') },
          { id: 'port', header: 'ポート範囲', cell: (r) => (r.e ? portLabel(r.e) : 'すべて') },
          { id: 'peer', header: egress ? '送信先' : 'ソース', cell: (r) => r.e?.cidrBlock ?? '0.0.0.0/0' },
          { id: 'act', header: '許可/拒否', cell: (r) => <Action a={r.e?.ruleAction ?? 'deny'} /> },
        ]}
      />
    </div>
  );
}

function associatedWith(env: ReturnType<typeof useEnv>, a: NetworkAcl) {
  if (!a.associations.length) return '-';
  if (a.associations.length > 1) return `${a.associations.length} 個のサブネット`;
  const s = env.subnets.find((x) => x.subnetId === a.associations[0].subnetId);
  return label(a.associations[0].subnetId, s);
}

export function NaclList() {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.networkAcls, (a) => a.networkAclId);
  const one = sel[0];
  return (
    <ResourceTable
      title="ネットワーク ACL"
      resourceName="ネットワーク ACL "
      testId="nacl-table"
      items={env.networkAcls}
      trackBy={(a) => a.networkAclId}
      selectedItems={sel}
      onSelectionChange={setSel}
      columns={[
        { id: 'name', header: 'Name', cell: nameCell, value: nameOf },
        { id: 'id', header: 'ネットワーク ACL ID', cell: (a) => <ConsoleLink to={naclPath(a.networkAclId)}>{a.networkAclId}</ConsoleLink>, value: (a) => a.networkAclId },
        { id: 'assoc', header: '関連付け先', cell: (a) => associatedWith(env, a), value: (a) => a.associations.map((x) => x.subnetId).join(' ') },
        { id: 'default', header: 'デフォルト', cell: (a) => (a.isDefault ? 'はい' : 'いいえ'), value: (a) => (a.isDefault ? 'はい' : 'いいえ') },
        { id: 'vpc', header: 'VPC ID', cell: (a) => <ConsoleLink to={`/vpc/vpcs/${a.vpcId}`}>{label(a.vpcId, env.vpcs.find((v) => v.vpcId === a.vpcId))}</ConsoleLink>, value: (a) => a.vpcId },
        { id: 'in', header: 'インバウンドルールの数', cell: (a) => ruleCount(a, false) },
        { id: 'out', header: 'アウトバウンドルールの数', cell: (a) => ruleCount(a, true) },
        { id: 'owner', header: '所有者', cell: () => env.accountId },
      ]}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu
            items={[
              { id: 'in', text: 'インバウンドルールを編集', disabled: !one, onClick: () => navigate(`${naclPath(one.networkAclId)}/edit-inbound`) },
              { id: 'out', text: 'アウトバウンドルールを編集', disabled: !one, onClick: () => navigate(`${naclPath(one.networkAclId)}/edit-outbound`) },
              { id: 'assoc', text: 'サブネットの関連付けを編集', disabled: !one, onClick: () => navigate(`${naclPath(one.networkAclId)}/edit-subnet-associations`) },
            ]}
          />
          <Button variant="primary" onClick={() => navigate('/vpc/network-acls/create')} data-testid="create-nacl">ネットワーク ACL を作成</Button>
        </SpaceBetween>
      }
    />
  );
}

export function NaclDetail({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const acl = env.networkAcls.find((a) => a.networkAclId === id);
  if (!acl) return <NotFound what="ネットワーク ACL" id={id} />;
  const subnets = env.subnets.filter((s) => acl.associations.some((a) => a.subnetId === s.subnetId));
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <ActionMenu
            items={[
              { id: 'in', text: 'インバウンドルールを編集', onClick: () => navigate(`${naclPath(id)}/edit-inbound`) },
              { id: 'out', text: 'アウトバウンドルールを編集', onClick: () => navigate(`${naclPath(id)}/edit-outbound`) },
              { id: 'assoc', text: 'サブネットの関連付けを編集', onClick: () => navigate(`${naclPath(id)}/edit-subnet-associations`) },
            ]}
          />
        }
      >
        {label(acl.networkAclId, acl)}
      </Header>
      <ResourceDetail
        fields={[
          { label: 'ネットワーク ACL ID', value: <CopyableValue value={acl.networkAclId} /> },
          { label: '関連付け先', value: associatedWith(env, acl) },
          { label: 'デフォルト', value: acl.isDefault ? 'はい' : 'いいえ' },
          { label: 'VPC ID', value: <ConsoleLink to={`/vpc/vpcs/${acl.vpcId}`}>{label(acl.vpcId, env.vpcs.find((v) => v.vpcId === acl.vpcId))}</ConsoleLink> },
          { label: '所有者', value: env.accountId },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'inbound',
            label: 'インバウンドルール',
            content: <NaclRulesTable acl={acl} egress={false} actions={<Hotspot hotspotId="nacl-edit-inbound" direction="right"><Button onClick={() => navigate(`${naclPath(id)}/edit-inbound`)} data-testid="nacl-edit-inbound">インバウンドルールを編集</Button></Hotspot>} />,
          },
          {
            id: 'outbound',
            label: 'アウトバウンドルール',
            content: <NaclRulesTable acl={acl} egress actions={<Hotspot hotspotId="nacl-edit-outbound" direction="right"><Button onClick={() => navigate(`${naclPath(id)}/edit-outbound`)} data-testid="nacl-edit-outbound">アウトバウンドルールを編集</Button></Hotspot>} />,
          },
          {
            id: 'subnet-associations',
            label: 'サブネットの関連付け',
            content: (
              <Table<Subnet>
                variant="container"
                header={<Header counter={`(${subnets.length})`} actions={<Button onClick={() => navigate(`${naclPath(id)}/edit-subnet-associations`)} data-testid="nacl-edit-associations">サブネットの関連付けを編集</Button>}>サブネットの関連付け</Header>}
                items={subnets}
                empty={<Box textAlign="center" color="inherit">関連付けられているサブネットはありません</Box>}
                columnDefinitions={[
                  { id: 'n', header: 'Name', cell: nameCell },
                  { id: 'id', header: 'サブネット ID', cell: (s) => <ConsoleLink to={`/vpc/subnets/${s.subnetId}`}>{s.subnetId}</ConsoleLink> },
                  { id: 'c', header: 'IPv4 CIDR', cell: (s) => s.cidrBlock },
                ]}
              />
            ),
          },
          { id: 'tags', label: 'タグ', content: <Tags tags={acl.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

interface EditRow {
  ruleNumber: string;
  type: string;
  ports: string;
  cidr: string;
  action: 'allow' | 'deny';
}

function toEditRow(e: NetworkAclEntry): EditRow {
  const p = portLabel(e);
  return { ruleNumber: String(e.ruleNumber), type: typeLabel(e), ports: p === 'すべて' ? '' : p.replace(' - ', '-'), cidr: e.cidrBlock, action: e.ruleAction };
}

function parseRow(r: EditRow): { input?: NaclEntryInput; errors: { ruleNumber?: string; ports?: string; cidr?: string } } {
  const t = RULE_TYPES.find((x) => x.label === r.type) ?? RULE_TYPES[0];
  const errors: { ruleNumber?: string; ports?: string; cidr?: string } = {};
  if (!/^\d+$/.test(r.ruleNumber.trim())) errors.ruleNumber = 'ルール番号は 1〜32766 の整数で指定してください。';
  let ports: number[] = t.ports ?? [];
  if (!t.ports) {
    const p = portsSchema.safeParse(r.ports);
    if (p.success) ports = p.data;
    else errors.ports = p.error.issues[0].message;
  }
  if (!r.cidr.trim()) errors.cidr = 'CIDR ブロックを指定してください。';
  if (errors.ruleNumber || errors.ports || errors.cidr) return { errors };
  const tcpUdp = t.protocol === 'tcp' || t.protocol === 'udp';
  return { input: { ruleNumber: Number(r.ruleNumber), protocol: t.protocol, ruleAction: r.action, cidrBlock: r.cidr, ...(tcpUdp ? { fromPort: ports[0], toPort: ports[1] ?? ports[0] } : {}) }, errors };
}

const ACTIONS = [
  { value: 'allow', label: '許可' },
  { value: 'deny', label: '拒否' },
];

export function EditNaclRules({ id, egress }: { id: string; egress: boolean }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const acl = env.networkAcls.find((a) => a.networkAclId === id);
  const [rows, setRows] = useState<EditRow[]>(() => (acl?.entries ?? []).filter((e) => e.egress === egress).sort((a, b) => a.ruleNumber - b.ruleNumber).map(toEditRow));
  const [error, setError] = useState<AwsError | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  if (!acl) return <NotFound what="ネットワーク ACL" id={id} />;
  const word = egress ? 'アウトバウンド' : 'インバウンド';
  const peer = egress ? '送信先' : 'ソース';
  const back = `${naclPath(id)}?tab=${egress ? 'outbound' : 'inbound'}`;
  const set = (i: number, patch: Partial<EditRow>) => setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  // AWS convention: number rules in steps of 100 so there is room to insert rules later.
  const nextNumber = () => String((Math.floor(Math.max(0, ...rows.map((r) => Number(r.ruleNumber) || 0)) / 100) + 1) * 100);
  return (
    <EditForm
      title={`${word}ルールを編集`}
      description={egress ? 'アウトバウンドルールは、サブネットから出ていくトラフィックを制御します。' : 'インバウンドルールは、サブネットに入ってくるトラフィックを制御します。'}
      submitText="変更を保存"
      submitTestId="nacl-save-rules"
      submitHotspotId="nacl-save-rules"
      onCancel={() => navigate(back)}
      error={error}
      onSubmit={() => {
        const parsed = rows.map(parseRow);
        if (parsed.some((p) => !p.input)) return setShowErrors(true);
        const r = run((d) => replaceNetworkAclEntries(d, id, egress, parsed.map((p) => p.input!)), `ネットワーク ACL ${label(id, acl)} の${word}ルールが正常に更新されました`);
        if (r.ok) navigate(back);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2" description={`${label(id, acl)} ・ ルール番号の小さい順に評価されます。どのルールにも一致しない通信は「*」ルールで拒否されます。`}>{`${word}ルール`}</Header>}>
        <SpaceBetween size="m">
          <AttributeEditor<EditRow>
            items={rows}
            onAddButtonClick={() => setRows([...rows, { ruleNumber: nextNumber(), type: 'カスタム TCP', ports: '', cidr: '0.0.0.0/0', action: 'allow' }])}
            onRemoveButtonClick={(e) => setRows(rows.filter((_, i) => i !== e.detail.itemIndex))}
            addButtonText="新しいルールを追加"
            removeButtonText="削除"
            empty="ルールがありません。すべての通信は「*」ルールで拒否されます。"
            definition={[
              { label: 'ルール番号', errorText: (r) => (showErrors ? parseRow(r).errors.ruleNumber : undefined), control: (r, i) => <Input value={r.ruleNumber} onChange={(e) => set(i, { ruleNumber: e.detail.value })} ariaLabel="ルール番号" data-testid={`nacl-rule-number-${i}`} /> },
              {
                label: 'タイプ',
                control: (r, i) => (
                  <Select
                    selectedOption={{ value: r.type, label: r.type }}
                    options={RULE_TYPES.map((t) => ({ value: t.label, label: t.label }))}
                    onChange={(e) => {
                      const t = RULE_TYPES.find((x) => x.label === e.detail.selectedOption.value)!;
                      set(i, { type: t.label, ports: t.ports ? (t.ports[0] === -1 ? '' : t.ports[0] === t.ports[1] ? String(t.ports[0]) : `${t.ports[0]}-${t.ports[1]}`) : r.ports });
                    }}
                    filteringType="auto"
                    ariaLabel="タイプ"
                    data-testid={`nacl-rule-type-${i}`}
                  />
                ),
              },
              {
                label: 'ポート範囲',
                errorText: (r) => (showErrors ? parseRow(r).errors.ports : undefined),
                control: (r, i) => {
                  const fixed = !!RULE_TYPES.find((t) => t.label === r.type)?.ports;
                  return <Input value={fixed && !r.ports ? 'すべて' : r.ports} disabled={fixed} onChange={(e) => set(i, { ports: e.detail.value })} placeholder="1024-65535" ariaLabel="ポート範囲" data-testid={`nacl-rule-port-${i}`} />;
                },
              },
              {
                label: peer,
                errorText: (r) => (showErrors ? parseRow(r).errors.cidr : undefined),
                control: (r, i) => (
                  <Autosuggest value={r.cidr} onChange={(e) => set(i, { cidr: e.detail.value })} options={[{ value: '0.0.0.0/0' }, ...env.vpcs.filter((v) => v.vpcId === acl.vpcId).map((v) => ({ value: v.cidrBlock, description: 'VPC CIDR' }))]} enteredTextLabel={(v) => `使用: "${v}"`} ariaLabel={peer} data-testid={`nacl-rule-cidr-${i}`} />
                ),
              },
              { label: '許可/拒否', control: (r, i) => <Select selectedOption={pick(ACTIONS, r.action)} options={ACTIONS} onChange={(e) => set(i, { action: e.detail.selectedOption.value as EditRow['action'] })} ariaLabel="許可/拒否" data-testid={`nacl-rule-action-${i}`} /> },
            ]}
          />
          <Box variant="small" color="text-body-secondary">* すべてのトラフィック / すべて / 0.0.0.0/0 / 拒否 (変更できません)</Box>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function EditNaclSubnetAssociations({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const acl = env.networkAcls.find((a) => a.networkAclId === id);
  const [selected, setSelected] = useState<string[]>(() => acl?.associations.map((a) => a.subnetId) ?? []);
  const [error, setError] = useState<AwsError | null>(null);
  if (!acl) return <NotFound what="ネットワーク ACL" id={id} />;
  const subnets = env.subnets.filter((s) => s.vpcId === acl.vpcId);
  return (
    <EditForm
      title="サブネットの関連付けを編集"
      description="このネットワーク ACL に関連付けるサブネットを選択します。サブネットは常に 1 つのネットワーク ACL に関連付けられます。"
      submitText="変更を保存"
      submitTestId="nacl-save-associations"
      onCancel={() => navigate(`${naclPath(id)}?tab=subnet-associations`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => setNaclSubnetAssociations(d, id, selected), `ネットワーク ACL ${label(id, acl)} のサブネットの関連付けが正常に更新されました`);
        if (r.ok) navigate(`${naclPath(id)}?tab=subnet-associations`);
        else setError(r.error);
      }}
    >
      <Table<Subnet>
        variant="container"
        header={<Header counter={`(${selected.length}/${subnets.length})`}>使用可能なサブネット</Header>}
        items={subnets}
        trackBy="subnetId"
        selectionType="multi"
        selectedItems={subnets.filter((s) => selected.includes(s.subnetId))}
        onSelectionChange={(e) => setSelected(e.detail.selectedItems.map((s) => s.subnetId))}
        ariaLabels={{ itemSelectionLabel: (_, s) => `${nameOf(s) || s.subnetId} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: 'サブネット' }}
        columnDefinitions={[
          { id: 'n', header: 'Name', cell: nameCell },
          { id: 'id', header: 'サブネット ID', cell: (s) => s.subnetId },
          { id: 'acl', header: '関連付けられているネットワーク ACL', cell: (s) => label(subnetNacl(env, s.subnetId).networkAclId, subnetNacl(env, s.subnetId)) },
          { id: 'c', header: 'IPv4 CIDR', cell: (s) => s.cidrBlock },
        ]}
      />
    </EditForm>
  );
}

export function CreateNacl() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [vpcId, setVpcId] = useState(env.vpcs.find((v) => !v.isDefault)?.vpcId ?? env.vpcs[0]?.vpcId ?? '');
  const [error, setError] = useState<AwsError | null>(null);
  const options = env.vpcs.map(vpcOption);
  return (
    <EditForm
      title="ネットワーク ACL を作成"
      description="ネットワーク ACL は、サブネットレベルでトラフィックを制御するオプションのセキュリティレイヤーです。作成直後はすべての通信を拒否します。"
      submitText="ネットワーク ACL を作成"
      submitTestId="create-nacl-submit"
      onCancel={() => navigate('/vpc/network-acls')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createNetworkAcl(d, { vpcId, name: name.trim() }), (aid) => `ネットワーク ACL ${aid}${name ? ` / ${name}` : ''} が正常に作成されました`);
        if (r.ok) navigate(naclPath(r.value));
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">ネットワーク ACL の設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="名前 - オプション">
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="my-network-acl-01" data-testid="nacl-name" />
          </FormField>
          <FormField label="VPC" description="このネットワーク ACL を作成する VPC。">
            <Select selectedOption={pick(options, vpcId)} options={options} onChange={(e) => setVpcId(e.detail.selectedOption.value!)} />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

/** Subnet page tab: the subnet's ACL and its rules. */
export function SubnetNaclTab({ subnetId }: { subnetId: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const acl = subnetNacl(env, subnetId);
  return (
    <SpaceBetween size="m">
      <Container
        header={
          <Header variant="h2" actions={<Button onClick={() => navigate(`/vpc/subnets/${subnetId}/edit-network-acl-association`)}>ネットワーク ACL の関連付けを編集</Button>}>
            ネットワーク ACL: <ConsoleLink to={naclPath(acl.networkAclId)}>{label(acl.networkAclId, acl)}</ConsoleLink>
          </Header>
        }
      >
        <Box color="text-body-secondary">{acl.isDefault ? 'VPC のデフォルトのネットワーク ACL です。' : 'カスタムのネットワーク ACL です。'}</Box>
      </Container>
      <NaclRulesTable acl={acl} egress={false} />
      <NaclRulesTable acl={acl} egress />
    </SpaceBetween>
  );
}

export function EditSubnetNaclAssociation({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const s = env.subnets.find((x) => x.subnetId === id);
  const [aclId, setAclId] = useState(s ? subnetNacl(env, s.subnetId).networkAclId : '');
  if (!s) return <NotFound what="サブネット" id={id} />;
  const options = env.networkAcls.filter((a) => a.vpcId === s.vpcId).map((a) => ({ value: a.networkAclId, label: label(a.networkAclId, a), description: a.isDefault ? 'デフォルト' : undefined }));
  const acl = env.networkAcls.find((a) => a.networkAclId === aclId);
  return (
    <EditForm
      title="ネットワーク ACL の関連付けを編集"
      submitText="保存"
      submitTestId="save-subnet-nacl"
      onCancel={() => navigate(`/vpc/subnets/${id}?tab=network-acl`)}
      error={null}
      onSubmit={() => {
        run((d) => associateSubnetNacl(d, id, aclId), `サブネット ${id} のネットワーク ACL の関連付けが正常に更新されました`);
        navigate(`/vpc/subnets/${id}?tab=network-acl`);
      }}
    >
      <Container header={<Header variant="h2">サブネットのネットワーク ACL 設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="サブネット ID">{label(s.subnetId, s)}</FormField>
          <FormField label="ネットワーク ACL ID">
            <Select selectedOption={pick(options, aclId)} options={options} onChange={(e) => setAclId(e.detail.selectedOption.value!)} data-testid="subnet-nacl-select" />
          </FormField>
        </SpaceBetween>
      </Container>
      {acl && <NaclRulesTable acl={acl} egress={false} />}
      {acl && <NaclRulesTable acl={acl} egress />}
    </EditForm>
  );
}
