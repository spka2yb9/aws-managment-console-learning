import Alert from '@cloudscape-design/components/alert';
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
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { nameOf } from '../../sim/env';
import { CLIENT_IP } from '../../sim/network';
import { createSecurityGroup, portRangeLabel, protocolLabel, RULE_TYPES, ruleTypeOf, setSecurityGroupRules, sgUsers, sourceOf, type Direction, type RuleInput } from '../../sim/sg';
import type { AwsEnv, AwsError, SecurityGroup, SecurityGroupRule } from '../../sim/types';
import { pick, vpcOption } from '../options';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, EditForm, NotFound, ResourceDetail, ResourceTable, ResourceTabs, nameCell, useEnv, useNavigate, useSelection } from '../ui';
import { Tags } from './vpc';

type Svc = 'vpc' | 'ec2';
const base = (svc: Svc) => `/${svc}/security-groups`;
const MY_IP = `${CLIENT_IP}/32`;

export function sgTitle(g: SecurityGroup) {
  return `${g.groupId} - ${g.groupName}`;
}

function PeerLink({ rule, env, svc }: { rule: SecurityGroupRule; env: AwsEnv; svc: Svc }) {
  const src = sourceOf(rule);
  const ref = env.securityGroups.find((g) => g.groupId === src);
  return ref ? <ConsoleLink to={`${base(svc)}/${src}`}>{`${src} / ${ref.groupName}`}</ConsoleLink> : <>{src}</>;
}

export function RulesTable({ rules, direction, svc, actions, title, extraColumn }: { rules: SecurityGroupRule[]; direction: Direction; svc: Svc; actions?: ReactNode; title?: string; extraColumn?: { header: string; cell: (r: SecurityGroupRule) => ReactNode } }) {
  const env = useEnv();
  return (
    <div data-testid={`${direction}-rules`}>
      <Table
        variant="container"
        header={<Header counter={`(${rules.length})`} actions={actions}>{title ?? (direction === 'ingress' ? 'インバウンドルール' : 'アウトバウンドルール')}</Header>}
        items={rules}
        trackBy="securityGroupRuleId"
        empty={<Box textAlign="center" color="inherit">セキュリティグループルールが見つかりません</Box>}
        columnDefinitions={[
          ...(extraColumn ? [{ id: 'extra', header: extraColumn.header, cell: extraColumn.cell }] : []),
          { id: 'id', header: 'セキュリティグループルール ID', cell: (r) => r.securityGroupRuleId },
          { id: 'ipv', header: 'IP バージョン', cell: (r) => (r.cidrIpv4 ? 'IPv4' : '-') },
          { id: 'type', header: 'タイプ', cell: (r) => ruleTypeOf(r).label },
          { id: 'protocol', header: 'プロトコル', cell: (r) => protocolLabel(r.ipProtocol) },
          { id: 'port', header: 'ポート範囲', cell: (r) => portRangeLabel(r) },
          { id: 'peer', header: direction === 'ingress' ? 'ソース' : '送信先', cell: (r) => <PeerLink rule={r} env={env} svc={svc} /> },
          { id: 'desc', header: '説明', cell: (r) => r.description ?? '-' },
        ]}
      />
    </div>
  );
}

export function SgList({ svc }: { svc: Svc }) {
  const env = useEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useSelection(env.securityGroups, (g) => g.groupId);
  return (
    <ResourceTable
      title="セキュリティグループ"
      resourceName="セキュリティグループ"
      testId="sg-table"
      items={env.securityGroups}
      trackBy={(g) => g.groupId}
      selectedItems={sel}
      onSelectionChange={setSel}
      columns={[
        { id: 'name', header: 'Name', cell: nameCell, value: nameOf },
        { id: 'id', header: 'セキュリティグループ ID', cell: (g) => <ConsoleLink to={`${base(svc)}/${g.groupId}`}>{g.groupId}</ConsoleLink>, value: (g) => g.groupId },
        { id: 'groupName', header: 'セキュリティグループ名', cell: (g) => g.groupName, value: (g) => g.groupName },
        { id: 'vpc', header: 'VPC ID', cell: (g) => <ConsoleLink to={`/vpc/vpcs/${g.vpcId}`}>{g.vpcId}</ConsoleLink>, value: (g) => g.vpcId },
        { id: 'desc', header: '説明', cell: (g) => g.description, value: (g) => g.description },
        { id: 'owner', header: '所有者', cell: () => env.accountId },
        { id: 'in', header: 'インバウンドルールの数', cell: (g) => `${g.ingress.length} 個のアクセス許可エントリ` },
        { id: 'out', header: 'アウトバウンドルールの数', cell: (g) => `${g.egress.length} 個のアクセス許可エントリ` },
      ]}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu
            items={[
              { id: 'in', text: 'インバウンドのルールを編集', disabled: sel.length !== 1, onClick: () => navigate(`${base(svc)}/${sel[0].groupId}/edit-inbound`) },
              { id: 'out', text: 'アウトバウンドのルールを編集', disabled: sel.length !== 1, onClick: () => navigate(`${base(svc)}/${sel[0].groupId}/edit-outbound`) },
            ]}
          />
          <Button variant="primary" onClick={() => navigate(`${base(svc)}/create`)}>セキュリティグループを作成</Button>
        </SpaceBetween>
      }
    />
  );
}

export function SgDetail({ svc, id }: { svc: Svc; id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const g = env.securityGroups.find((x) => x.groupId === id);
  if (!g) return <NotFound what="セキュリティグループ" id={id} />;
  const users = sgUsers(env, g.groupId);
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <ActionMenu
            items={[
              { id: 'in', text: 'インバウンドのルールを編集', onClick: () => navigate(`${base(svc)}/${id}/edit-inbound`) },
              { id: 'out', text: 'アウトバウンドのルールを編集', onClick: () => navigate(`${base(svc)}/${id}/edit-outbound`) },
            ]}
          />
        }
      >
        {sgTitle(g)}
      </Header>
      <ResourceDetail
        fields={[
          { label: 'セキュリティグループ名', value: g.groupName },
          { label: 'セキュリティグループ ID', value: <Hotspot hotspotId="sg-id-copy" direction="right"><CopyableValue value={g.groupId} testId="sg-id" /></Hotspot> },
          { label: '説明', value: g.description },
          { label: 'VPC ID', value: <ConsoleLink to={`/vpc/vpcs/${g.vpcId}`}>{g.vpcId}</ConsoleLink> },
          { label: '所有者', value: env.accountId },
          { label: 'インバウンドルールの数', value: `${g.ingress.length} 個のアクセス許可エントリ` },
          { label: 'アウトバウンドルールの数', value: `${g.egress.length} 個のアクセス許可エントリ` },
          { label: '関連付けられたリソース', value: users.join(', ') || '-' },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'inbound',
            label: 'インバウンドルール',
            content: (
              <RulesTable
                rules={g.ingress}
                direction="ingress"
                svc={svc}
                actions={
                  <Hotspot hotspotId="sg-edit-inbound" direction="right">
                    <Button onClick={() => navigate(`${base(svc)}/${id}/edit-inbound`)} data-testid="edit-inbound">インバウンドのルールを編集</Button>
                  </Hotspot>
                }
              />
            ),
          },
          {
            id: 'outbound',
            label: 'アウトバウンドルール',
            content: <RulesTable rules={g.egress} direction="egress" svc={svc} actions={<Button onClick={() => navigate(`${base(svc)}/${id}/edit-outbound`)} data-testid="edit-outbound">アウトバウンドのルールを編集</Button>} />,
          },
          { id: 'tags', label: 'タグ', content: <Tags tags={g.tags} /> },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------- rules editor ----------------

interface RuleRow {
  securityGroupRuleId?: string;
  type: string;
  ports: string;
  peerType: 'custom' | 'anywhere' | 'myip';
  peer: string;
  description: string;
}

const PEER_TYPES = [
  { value: 'custom', label: 'カスタム' },
  { value: 'anywhere', label: 'Anywhere-IPv4' },
  { value: 'myip', label: 'マイ IP' },
];

function toRow(r: SecurityGroupRule): RuleRow {
  const peer = sourceOf(r);
  return { securityGroupRuleId: r.securityGroupRuleId, type: ruleTypeOf(r).label, ports: portRangeLabel(r) === 'すべて' ? '' : portRangeLabel(r).replace(' - ', '-'), peerType: peer === '0.0.0.0/0' ? 'anywhere' : peer === MY_IP ? 'myip' : 'custom', peer, description: r.description ?? '' };
}

export const portsSchema = z
  .string()
  .trim()
  .regex(/^\d{1,5}(\s*-\s*\d{1,5})?$/, 'ポート (3000) またはポート範囲 (8000-8080) を入力してください。')
  .transform((v) => v.split('-').map((x) => Number(x.trim())))
  .refine(([a, b = a]) => a >= 0 && b <= 65535 && a <= b, 'ポートは 0〜65535 で、開始ポートは終了ポート以下である必要があります。');

/** Row -> API input, or the inline error messages the console would show. */
function parseRow(row: RuleRow): { input?: RuleInput; errors: { ports?: string; peer?: string } } {
  const t = RULE_TYPES.find((x) => x.label === row.type) ?? RULE_TYPES[0];
  const errors: { ports?: string; peer?: string } = {};
  let ports: number[] = t.ports ?? [];
  if (!t.ports) {
    const p = portsSchema.safeParse(row.ports);
    if (p.success) ports = p.data;
    else errors.ports = p.error.issues[0].message;
  }
  if (!row.peer.trim()) errors.peer = 'CIDR ブロックまたはセキュリティグループを指定してください。';
  if (errors.ports || errors.peer) return { errors };
  return { input: { securityGroupRuleId: row.securityGroupRuleId, ipProtocol: t.protocol, fromPort: ports[0], toPort: ports[1] ?? ports[0], source: row.peer, description: row.description }, errors };
}

function RulesEditor({ rows, onChange, direction, vpcId, showErrors }: { rows: RuleRow[]; onChange: (rows: RuleRow[]) => void; direction: Direction; vpcId: string; showErrors: boolean }) {
  const env = useEnv();
  const peerWord = direction === 'ingress' ? 'ソース' : '送信先';
  const groups = env.securityGroups.filter((g) => g.vpcId === vpcId);
  const set = (i: number, patch: Partial<RuleRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  const last = rows.length - 1;
  const hs = (i: number, id: string) => (i === last ? id : `${id}-${i}`);
  const openToWorld = direction === 'ingress' && rows.some((r) => r.peer.trim() === '0.0.0.0/0');
  return (
    <SpaceBetween size="m">
      <AttributeEditor<RuleRow>
        items={rows}
        onAddButtonClick={() => onChange([...rows, { type: 'カスタム TCP', ports: '', peerType: 'custom', peer: '', description: '' }])}
        onRemoveButtonClick={(e) => onChange(rows.filter((_, i) => i !== e.detail.itemIndex))}
        addButtonText="ルールを追加"
        removeButtonText="削除"
        empty={`このセキュリティグループには${direction === 'ingress' ? 'インバウンド' : 'アウトバウンド'}ルールがありません。`}
        definition={[
          {
            label: 'タイプ',
            control: (r, i) => (
              <Hotspot hotspotId={hs(i, 'sg-rule-type')} direction="right">
                <SpaceBetween size="xxxs">
                  <Select
                    selectedOption={{ value: r.type, label: r.type }}
                    options={RULE_TYPES.map((t) => ({ value: t.label, label: t.label }))}
                    onChange={(e) => {
                      const t = RULE_TYPES.find((x) => x.label === e.detail.selectedOption.value)!;
                      set(i, { type: t.label, ports: t.ports ? (t.ports[0] === -1 ? '' : t.ports[0] === t.ports[1] ? String(t.ports[0]) : `${t.ports[0]}-${t.ports[1]}`) : r.ports });
                    }}
                    filteringType="auto"
                    ariaLabel="タイプ"
                    data-testid={`rule-type-${i}`}
                  />
                  <Box variant="small" color="text-body-secondary">{r.securityGroupRuleId ?? '新しいルール'}</Box>
                </SpaceBetween>
              </Hotspot>
            ),
          },
          { label: 'プロトコル', control: (r) => <Box padding={{ top: 'xs' }}>{protocolLabel((RULE_TYPES.find((t) => t.label === r.type) ?? RULE_TYPES[0]).protocol)}</Box> },
          {
            label: 'ポート範囲',
            errorText: (r) => (showErrors ? parseRow(r).errors.ports : undefined),
            control: (r, i) => {
              const fixed = !!RULE_TYPES.find((t) => t.label === r.type)?.ports;
              return (
                <Hotspot hotspotId={hs(i, 'sg-rule-port')} direction="right">
                  <Input value={fixed && !r.ports ? 'すべて' : r.ports} disabled={fixed} onChange={(e) => set(i, { ports: e.detail.value })} placeholder="0" ariaLabel="ポート範囲" data-testid={`rule-port-${i}`} />
                </Hotspot>
              );
            },
          },
          {
            label: `${peerWord}タイプ`,
            control: (r, i) => (
              <Select
                selectedOption={pick(PEER_TYPES, r.peerType)}
                options={PEER_TYPES}
                onChange={(e) => {
                  const v = e.detail.selectedOption.value as RuleRow['peerType'];
                  set(i, { peerType: v, peer: v === 'anywhere' ? '0.0.0.0/0' : v === 'myip' ? MY_IP : '' });
                }}
                ariaLabel={`${peerWord}タイプ`}
                data-testid={`rule-peer-type-${i}`}
              />
            ),
          },
          {
            label: peerWord,
            errorText: (r) => (showErrors ? parseRow(r).errors.peer : undefined),
            control: (r, i) => (
              <Hotspot hotspotId={hs(i, 'sg-rule-source')} direction="right">
                <Autosuggest
                  value={r.peer}
                  onChange={(e) => set(i, { peer: e.detail.value, peerType: 'custom' })}
                  options={[
                    { label: 'CIDR ブロック', options: [{ value: '0.0.0.0/0' }, { value: MY_IP, description: 'マイ IP' }] },
                    { label: 'セキュリティグループ', options: groups.map((g) => ({ value: g.groupId, label: g.groupId, description: g.groupName })) },
                  ]}
                  placeholder="CIDR、IP、またはセキュリティグループ"
                  enteredTextLabel={(v) => `使用: "${v}"`}
                  ariaLabel={peerWord}
                  data-testid={`rule-peer-${i}`}
                />
              </Hotspot>
            ),
          },
          { label: '説明 - オプション', control: (r, i) => <Input value={r.description} onChange={(e) => set(i, { description: e.detail.value })} ariaLabel="説明" /> },
        ]}
      />
      {openToWorld && (
        <Alert type="warning">
          ソースが 0.0.0.0/0 または ::/0 のルールは、すべての IP アドレスからインスタンスへのアクセスを許可します。既知の IP アドレスからのアクセスのみを許可するように、セキュリティグループルールを設定することをお勧めします。
        </Alert>
      )}
    </SpaceBetween>
  );
}

export function EditSgRules({ svc, id, direction }: { svc: Svc; id: string; direction: Direction }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const g = env.securityGroups.find((x) => x.groupId === id);
  const [rows, setRows] = useState<RuleRow[]>(() => (g ? g[direction].map(toRow) : []));
  const [error, setError] = useState<AwsError | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  if (!g) return <NotFound what="セキュリティグループ" id={id} />;
  const word = direction === 'ingress' ? 'インバウンド' : 'アウトバウンド';
  const tab = direction === 'ingress' ? 'inbound' : 'outbound';
  const back = `${base(svc)}/${id}?tab=${tab}`;
  return (
    <EditForm
      title={`${word}のルールを編集`}
      description={direction === 'ingress' ? 'インバウンドルールは、インスタンスに到達できる受信トラフィックを制御します。' : 'アウトバウンドルールは、インスタンスから送信できるトラフィックを制御します。'}
      submitText="ルールを保存"
      submitTestId="save-rules"
      submitHotspotId="sg-save-rules"
      onCancel={() => navigate(back)}
      error={error}
      onSubmit={() => {
        const parsed = rows.map(parseRow);
        if (parsed.some((p) => !p.input)) return setShowErrors(true);
        const r = run((d) => setSecurityGroupRules(d, id, direction, parsed.map((p) => p.input!)), `セキュリティグループ (${g.groupId} | ${g.groupName}) の${word}セキュリティグループルールが正常に変更されました`);
        if (r.ok) navigate(back);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2" description={sgTitle(g)}>{`${word}ルール`}</Header>}>
        <RulesEditor rows={rows} onChange={setRows} direction={direction} vpcId={g.vpcId} showErrors={showErrors} />
      </Container>
    </EditForm>
  );
}

export function CreateSg({ svc }: { svc: Svc }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const vpcOptions = env.vpcs.map(vpcOption);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [vpcId, setVpcId] = useState(env.vpcs.find((v) => v.isDefault)?.vpcId ?? env.vpcs[0]?.vpcId ?? '');
  const [inbound, setInbound] = useState<RuleRow[]>([]);
  const [outbound, setOutbound] = useState<RuleRow[]>([{ type: 'すべてのトラフィック', ports: '', peerType: 'anywhere', peer: '0.0.0.0/0', description: '' }]);
  const [error, setError] = useState<AwsError | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  return (
    <EditForm
      title="セキュリティグループを作成"
      description="セキュリティグループは、インスタンスの仮想ファイアウォールとして機能し、インバウンドトラフィックとアウトバウンドトラフィックを制御します。"
      submitText="セキュリティグループを作成"
      submitTestId="create-sg-submit"
      onCancel={() => navigate(base(svc))}
      error={error}
      onSubmit={() => {
        const i = inbound.map(parseRow);
        const o = outbound.map(parseRow);
        setShowErrors(true);
        if ([...i, ...o].some((p) => !p.input)) return;
        const r = run((d) => createSecurityGroup(d, { groupName: name, description: desc, vpcId, ingress: i.map((p) => p.input!), egress: o.map((p) => p.input!) }), (gid) => `セキュリティグループ (${gid} | ${name}) が正常に作成されました`);
        if (r.ok) navigate(`${base(svc)}/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">基本的な詳細</Header>}>
        <SpaceBetween size="l">
          <FormField label="セキュリティグループ名" constraintText="作成後に名前を編集することはできません。" errorText={showErrors && !name.trim() ? 'セキュリティグループ名は必須です。' : undefined}>
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="MyWebServerGroup" data-testid="sg-name" />
          </FormField>
          <FormField label="説明" errorText={showErrors && !desc.trim() ? '説明は必須です。' : undefined}>
            <Textarea value={desc} onChange={(e) => setDesc(e.detail.value)} rows={1} placeholder="開発者に SSH アクセスを許可" data-testid="sg-description" />
          </FormField>
          <FormField label="VPC">
            <Select selectedOption={pick(vpcOptions, vpcId)} options={vpcOptions} onChange={(e) => setVpcId(e.detail.selectedOption.value!)} data-testid="sg-vpc" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">インバウンドルール</Header>}>
        <RulesEditor rows={inbound} onChange={setInbound} direction="ingress" vpcId={vpcId} showErrors={showErrors} />
      </Container>
      <Container header={<Header variant="h2">アウトバウンドルール</Header>}>
        <RulesEditor rows={outbound} onChange={setOutbound} direction="egress" vpcId={vpcId} showErrors={showErrors} />
      </Container>
    </EditForm>
  );
}
