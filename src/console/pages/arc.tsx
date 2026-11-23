// Route 53 Application Recovery Controller: ゾーンシフト / ゾーンオートシフト (lesson 47), and the ALB pages' zonal shift parts
// (属性 / 統合 tabs, ロードバランサー属性を編集) that elb.tsx and arc-routes.tsx mount.
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import Multiselect from '@cloudscape-design/components/multiselect';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Toggle from '@cloudscape-design/components/toggle';
import { useState } from 'react';
import { regionOf } from '../../sim/env';
import {
  appliedShift,
  azIdOf,
  azNameOf,
  cancelZonalShift,
  configOf,
  createPracticeRunConfiguration,
  deletePracticeRunConfiguration,
  lbAttributes,
  managedResources,
  modifyLoadBalancerAttributes,
  startPracticeRun,
  startZonalShift,
  updatePracticeRunConfiguration,
  updateZonalAutoshiftConfiguration,
  updateZonalShift,
  ZONAL_SHIFT_ATTRIBUTE,
  zonalShiftEnabled,
  type ManagedResource,
  type ZonalShift,
} from '../../sim/ext/zonalshift';
import type { AwsEnv, AwsError, LoadBalancer } from '../../sim/types';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, DeleteModal, EditForm, errorText, formatDate, NotFound, queryParam, ResourceDetail, ResourceTable, useEnv, useNavigate, useSelection } from '../ui';
import { useNow } from './cloudwatch';

const lbPath = (name: string) => `/ec2/load-balancers/${name}`;
/** "apne1-az2 (ap-northeast-1c)": the console shows both, the API takes the AZ ID */
const azText = (env: AwsEnv, id: string) => `${id} (${azNameOf(env, id) ?? '?'})`;
const nameOfArn = (env: AwsEnv, arn: string) => env.loadBalancers.find((l) => l.loadBalancerArn === arn)?.loadBalancerName ?? arn.split('/').slice(-2, -1)[0] ?? arn;
const alarmName = (env: AwsEnv, arn: string) => env.alarms.find((a) => a.alarmArn === arn)?.alarmName ?? arn.split(':').pop();
const remaining = (ms: number) => (ms >= 3_600_000 ? `残り ${Math.floor(ms / 3_600_000)} 時間 ${Math.floor((ms % 3_600_000) / 60_000)} 分` : `残り ${Math.max(0, Math.ceil(ms / 60_000))} 分`);

const STATUS: Record<ZonalShift['status'], [type: 'success' | 'stopped', text: string]> = { ACTIVE: ['success', 'アクティブ'], EXPIRED: ['stopped', '期限切れ'], CANCELED: ['stopped', 'キャンセル済み'] };
const OUTCOME: Record<string, string> = { PENDING: '実行中', SUCCEEDED: '成功', FAILED: '失敗', INTERRUPTED: '中断' };

/** expiry as "number + unit" (the console's 有効期限 field), sent to the API as 30m / 1h */
function ExpiryField({ amount, unit, onChange, label = 'ゾーンシフトの有効期限を設定' }: { amount: string; unit: 'm' | 'h'; onChange: (amount: string, unit: 'm' | 'h') => void; label?: string }) {
  const units = [{ value: 'm', label: '分' }, { value: 'h', label: '時間' }];
  return (
    <FormField label={label} description="すべてのゾーンシフトは一時的なものです。有効期限が来ると、トラフィックは自動でアベイラビリティーゾーンに戻ります。" constraintText="1 分～3 日 (72 時間) の範囲で指定します。後から更新して延長できます。">
      <SpaceBetween direction="horizontal" size="xs">
        <Input type="number" value={amount} onChange={(e) => onChange(e.detail.value, unit)} data-testid="shift-expiry" />
        <Select selectedOption={units.find((u) => u.value === unit)!} options={units} onChange={(e) => onChange(amount, e.detail.selectedOption.value as 'm' | 'h')} data-testid="shift-expiry-unit" />
      </SpaceBetween>
    </FormField>
  );
}

// ---------------- ゾーンシフト ----------------

function UpdateShiftModal({ shift, onClose }: { shift: ZonalShift; onClose: () => void }) {
  const run = useConsole((s) => s.run);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'m' | 'h'>('h');
  const [comment, setComment] = useState(shift.comment);
  const [error, setError] = useState<AwsError | null>(null);
  const submit = () => {
    const r = run((d) => updateZonalShift(d, shift.zonalShiftId, { expiresIn: amount ? `${amount}${unit}` : undefined, comment }), `ゾーンシフト ${shift.zonalShiftId} を更新しました`);
    if (r.ok) onClose();
    else setError(r.error);
  };
  return (
    <Modal visible onDismiss={onClose} header="ゾーンシフトを更新" footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={submit} data-testid="update-shift-submit">更新</Button></SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <Box>{`現在の有効期限: ${formatDate(shift.expiryTime)}。新しい有効期限は、今からの長さで指定します (空欄なら変えません)。`}</Box>
        <ExpiryField amount={amount} unit={unit} onChange={(a, u) => { setAmount(a); setUnit(u); }} />
        <FormField label="コメント" constraintText="最大 128 文字。新しいコメントで上書きされます (履歴は残りません)。" errorText={errorText(error)}>
          <Input value={comment} onChange={(e) => setComment(e.detail.value)} data-testid="update-shift-comment" />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

function CancelShiftModal({ shift, onClose }: { shift: ZonalShift; onClose: () => void }) {
  const env = useEnv();
  const run = useConsole((s) => s.run);
  const [error, setError] = useState<AwsError | null>(null);
  const submit = () => {
    const r = run((d) => cancelZonalShift(d, shift.zonalShiftId), `ゾーンシフト ${shift.zonalShiftId} をキャンセルしました`);
    if (r.ok) onClose();
    else setError(r.error);
  };
  return (
    <Modal visible onDismiss={onClose} header="ゾーンシフトをキャンセル" footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={onClose}>キャンセル</Button><Button variant="primary" onClick={submit} data-testid="cancel-shift-confirm">確認</Button></SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <Box>{`${nameOfArn(env, shift.resourceIdentifier)} のトラフィックが、アベイラビリティーゾーン ${azText(env, shift.awayFrom)} に戻ります。このゾーンが正常に戻っていることを確かめてからキャンセルしてください。`}</Box>
        {error && <Alert type="error">{errorText(error)}</Alert>}
      </SpaceBetween>
    </Modal>
  );
}

export function ZonalShiftList() {
  const env = useEnv();
  const navigate = useNavigate();
  const now = useNow(5000);
  const shifts = [...(env.zonalShift?.shifts ?? [])].reverse();
  const [selected, setSelected] = useSelection(shifts, (s) => s.zonalShiftId);
  const [modal, setModal] = useState<'update' | 'cancel' | null>(null);
  const one = selected.length === 1 ? selected[0] : undefined;
  const applied = (s: ZonalShift) => {
    const lb = env.loadBalancers.find((l) => l.loadBalancerArn === s.resourceIdentifier);
    return lb && appliedShift(env, lb, now)?.zonalShiftId === s.zonalShiftId;
  };
  return (
    <SpaceBetween size="l">
      <ResourceTable
        title="ゾーンシフト"
        description="ゾーンシフトを開始すると、サポートされているリソースの新しいトラフィックを、1 つのアベイラビリティーゾーンから一時的に移動できます。アプリケーションは、リージョン内のほかのアベイラビリティーゾーンで動き続けます。"
        resourceName="ゾーンシフト"
        testId="zonal-shift-table"
        items={shifts}
        trackBy={(s) => s.zonalShiftId}
        selectedItems={selected}
        onSelectionChange={setSelected}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Hotspot hotspotId="arc-shift-actions" direction="left">
              <ActionMenu
                testId="zonal-shift-actions"
                items={[
                  { id: 'update', text: 'ゾーンシフトを更新', disabled: one?.status !== 'ACTIVE' || one.shiftType !== 'ZONAL_SHIFT', onClick: () => setModal('update') },
                  { id: 'cancel', text: 'ゾーンシフトをキャンセル', disabled: one?.status !== 'ACTIVE', onClick: () => setModal('cancel') },
                ]}
              />
            </Hotspot>
            <Hotspot hotspotId="arc-start-shift" direction="left">
              <Button variant="primary" onClick={() => navigate('/arc/zonal-shift/start')} data-testid="start-zonal-shift">ゾーンシフトを開始</Button>
            </Hotspot>
          </SpaceBetween>
        }
        columns={[
          { id: 'id', header: 'ゾーンシフト ID', cell: (s) => <CopyableValue value={s.zonalShiftId} />, value: (s) => s.zonalShiftId },
          { id: 'resource', header: 'リソース名', cell: (s) => <ConsoleLink to={lbPath(nameOfArn(env, s.resourceIdentifier))}>{nameOfArn(env, s.resourceIdentifier)}</ConsoleLink>, value: (s) => nameOfArn(env, s.resourceIdentifier) },
          { id: 'az', header: 'シフト元のアベイラビリティーゾーン', cell: (s) => azText(env, s.awayFrom), value: (s) => azText(env, s.awayFrom) },
          { id: 'status', header: 'ステータス', cell: (s) => <StatusIndicator type={STATUS[s.status][0]}>{STATUS[s.status][1]}</StatusIndicator>, value: (s) => s.status },
          { id: 'applied', header: '適用ステータス', cell: (s) => (s.status !== 'ACTIVE' ? '-' : applied(s) ? '適用済み' : '未適用') },
          { id: 'type', header: 'シフトタイプ', cell: (s) => (s.shiftType === 'PRACTICE_RUN' ? `練習実行 (${OUTCOME[s.practiceRunOutcome ?? 'PENDING']})` : 'ゾーンシフト'), value: (s) => s.shiftType },
          { id: 'expiry', header: '有効期限', cell: (s) => (s.status === 'ACTIVE' ? `${formatDate(s.expiryTime)} (${remaining(s.expiryTime - now)})` : formatDate(s.endedAt ?? s.expiryTime)) },
          { id: 'comment', header: 'コメント', cell: (s) => s.comment || '-', value: (s) => s.comment },
          { id: 'start', header: '開始時刻', cell: (s) => formatDate(s.startTime) },
        ]}
      />
      {modal === 'update' && one && <UpdateShiftModal shift={one} onClose={() => setModal(null)} />}
      {modal === 'cancel' && one && <CancelShiftModal shift={one} onClose={() => { setModal(null); setSelected([]); }} />}
    </SpaceBetween>
  );
}

export function StartZonalShift() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const path = useConsole((s) => s.path);
  const resources = managedResources(env);
  const [azId, setAzId] = useState('');
  const [arn, setArn] = useState(queryParam(path, 'resource') ?? '');
  const [amount, setAmount] = useState('1');
  const [unit, setUnit] = useState<'m' | 'h'>('h');
  const [comment, setComment] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<AwsError | null>(null);
  const azs = regionOf(env.region).azs.map((az) => ({ value: azIdOf(az), label: `${azIdOf(az)} (${az})` }));
  const inAz = resources.filter((r) => !azId || r.availabilityZones.includes(azId));
  const submit = () => {
    const r = run((d) => startZonalShift(d, { resourceIdentifier: arn, awayFrom: azId, expiresIn: `${amount}${unit}`, comment }), (s) => `ゾーンシフト ${s.zonalShiftId} を開始しました。${azText(env, azId)} の ${nameOfArn(env, arn)} に新しいトラフィックは送られません。`);
    if (r.ok) navigate('/arc/zonal-shift');
    else setError(r.error);
  };
  return (
    <EditForm
      title="ゾーンシフトを開始"
      description="リソースのトラフィックを、1 つのアベイラビリティーゾーンから一時的に移動します。"
      submitText="開始"
      submitTestId="start-shift-submit"
      submitHotspotId="arc-start-shift-submit"
      submitDisabled={!azId || !arn || !ack}
      onCancel={() => navigate('/arc/zonal-shift')}
      onSubmit={submit}
      error={error}
    >
      <Container header={<Header variant="h2" description="アベイラビリティーゾーンは AZ ID で指定します。AZ 名 (ap-northeast-1a など) と AZ ID の対応は、AWS アカウントごとに異なります。">アベイラビリティーゾーン</Header>}>
        <Hotspot hotspotId="arc-shift-az" direction="right">
          <FormField label="トラフィックの移動元のアベイラビリティーゾーン">
            <Select selectedOption={azs.find((a) => a.value === azId) ?? null} options={azs} placeholder="アベイラビリティーゾーンを選択" onChange={(e) => setAzId(e.detail.selectedOption.value!)} data-testid="shift-az" />
          </FormField>
        </Hotspot>
      </Container>
      <ResourceTable<ManagedResource>
        title="リソース"
        description="ゾーンシフトできるリソース (マネージドリソース) です。Application Load Balancer は、ロードバランサーの属性で ARC ゾーンシフト統合を有効にすると表示されます。"
        headerVariant="h2"
        variant="container"
        resourceName="リソース"
        testId="shift-resources"
        items={inAz}
        trackBy={(r) => r.arn}
        selectedItems={inAz.filter((r) => r.arn === arn)}
        onSelectionChange={(xs) => setArn(xs[0]?.arn ?? '')}
        columns={[
          { id: 'name', header: 'リソース名', cell: (r) => r.name, value: (r) => r.name },
          { id: 'type', header: 'リソースタイプ', cell: () => 'Application Load Balancer' },
          { id: 'azs', header: 'アベイラビリティーゾーン', cell: (r) => r.availabilityZones.join(', ') },
          { id: 'auto', header: 'ゾーンオートシフト', cell: (r) => (configOf(env, r.arn)?.zonalAutoshiftStatus === 'ENABLED' ? '有効' : '無効') },
          { id: 'arn', header: 'リソース ARN', cell: (r) => r.arn },
        ]}
      />
      <Container header={<Header variant="h2">ゾーンシフトの設定</Header>}>
        <SpaceBetween size="l">
          <ExpiryField amount={amount} unit={unit} onChange={(a, u) => { setAmount(a); setUnit(u); }} />
          <FormField label="コメント" constraintText="最大 128 文字。なぜシフトしたのかを残します。">
            <Input value={comment} onChange={(e) => setComment(e.detail.value)} placeholder="例: apne1-az2 でエラー率が上昇したため" data-testid="shift-comment" />
          </FormField>
          <Checkbox checked={ack} onChange={(e) => setAck(e.detail.checked)} data-testid="shift-ack">
            ゾーンシフトを開始すると、トラフィックがアベイラビリティーゾーンから移動し、アプリケーションで使用できるキャパシティが減ることを了承します。
          </Checkbox>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- ゾーンオートシフト ----------------

function StartPracticeRunModal({ r, onClose }: { r: ManagedResource; onClose: () => void }) {
  const env = useEnv();
  const run = useConsole((s) => s.run);
  const [azId, setAzId] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const submit = () => {
    const res = run((d) => startPracticeRun(d, { resourceIdentifier: r.arn, awayFrom: azId, comment }), '練習実行を開始しました (30 分)');
    if (res.ok) onClose();
    else setError(res.error);
  };
  return (
    <Modal visible onDismiss={onClose} header="練習実行を開始" footer={<Box float="right"><SpaceBetween direction="horizontal" size="xs"><Button variant="link" onClick={onClose}>キャンセル</Button><Button variant="primary" disabled={!azId} onClick={submit}>開始</Button></SpaceBetween></Box>}>
      <SpaceBetween size="m">
        <Box>{`${r.name} のトラフィックを 30 分間、選んだアベイラビリティーゾーンから移動します。結果アラームがアラーム状態になると、練習実行は失敗として終了します。`}</Box>
        <FormField label="アベイラビリティーゾーン">
          <Select selectedOption={azId ? { value: azId, label: azText(env, azId) } : null} options={r.availabilityZones.map((id) => ({ value: id, label: azText(env, id) }))} onChange={(e) => setAzId(e.detail.selectedOption.value!)} placeholder="アベイラビリティーゾーンを選択" />
        </FormField>
        <FormField label="コメント" errorText={errorText(error)}>
          <Input value={comment} onChange={(e) => setComment(e.detail.value)} />
        </FormField>
      </SpaceBetween>
    </Modal>
  );
}

export function AutoshiftList() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const now = useNow(5000);
  const resources = managedResources(env);
  const [selected, setSelected] = useSelection(resources, (r) => r.arn);
  const [modal, setModal] = useState<'delete' | 'practice' | null>(null);
  const one = selected.length === 1 ? selected[0] : undefined;
  const cfg = one && configOf(env, one.arn);
  const setStatus = (status: 'ENABLED' | 'DISABLED') => run((d) => updateZonalAutoshiftConfiguration(d, one!.arn, status), `${one!.name} のゾーンオートシフトを${status === 'ENABLED' ? '有効' : '無効'}にしました`);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="ゾーンオートシフトを有効にすると、AWS がアベイラビリティーゾーンの障害を検出したときに、リソースのトラフィックを自動でそのゾーンから移動します。有効にするには、練習実行設定が必要です。">
        ゾーンオートシフト
      </Header>
      <ResourceTable
        title="リソースのゾーンオートシフト設定"
        headerVariant="h2"
        variant="container"
        resourceName="リソース"
        testId="autoshift-table"
        items={resources}
        trackBy={(r) => r.arn}
        selectedItems={selected}
        onSelectionChange={setSelected}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <ActionMenu
              testId="autoshift-actions"
              items={[
                { id: 'enable', text: 'ゾーンオートシフトを有効化', disabled: !cfg?.practiceRunConfiguration || cfg.zonalAutoshiftStatus === 'ENABLED', disabledReason: '練習実行設定が必要です', onClick: () => setStatus('ENABLED') },
                { id: 'disable', text: 'ゾーンオートシフトを無効化', disabled: cfg?.zonalAutoshiftStatus !== 'ENABLED', onClick: () => setStatus('DISABLED') },
                { id: 'edit', text: '練習実行設定を編集', disabled: !cfg?.practiceRunConfiguration, onClick: () => navigate(`/arc/zonal-autoshift/configure?${new URLSearchParams({ resource: one!.arn, edit: '1' })}`) },
                { id: 'delete', text: '練習実行設定を削除', disabled: !cfg?.practiceRunConfiguration, onClick: () => setModal('delete') },
                { id: 'practice', text: '練習実行を開始', disabled: cfg?.zonalAutoshiftStatus !== 'ENABLED', disabledReason: 'ゾーンオートシフトが有効なリソースだけ', onClick: () => setModal('practice') },
              ]}
            />
            <Hotspot hotspotId="arc-configure-autoshift" direction="left">
              <Button variant="primary" onClick={() => navigate('/arc/zonal-autoshift/configure')} data-testid="configure-autoshift">ゾーンオートシフトを設定</Button>
            </Hotspot>
          </SpaceBetween>
        }
        columns={[
          { id: 'name', header: 'リソース名', cell: (r) => <ConsoleLink to={lbPath(r.name)}>{r.name}</ConsoleLink>, value: (r) => r.name },
          { id: 'status', header: 'ゾーンオートシフト', cell: (r) => (configOf(env, r.arn)?.zonalAutoshiftStatus === 'ENABLED' ? <StatusIndicator>有効</StatusIndicator> : <StatusIndicator type="stopped">無効</StatusIndicator>) },
          { id: 'practice', header: '練習実行設定', cell: (r) => (configOf(env, r.arn)?.practiceRunConfiguration ? '設定済み' : '未設定') },
          { id: 'outcome', header: '結果アラーム', cell: (r) => configOf(env, r.arn)?.practiceRunConfiguration?.outcomeAlarms.map((c) => alarmName(env, c.alarmIdentifier)).join(', ') || '-' },
          { id: 'blocking', header: 'ブロッキングアラーム', cell: (r) => configOf(env, r.arn)?.practiceRunConfiguration?.blockingAlarms.map((c) => alarmName(env, c.alarmIdentifier)).join(', ') || '-' },
          { id: 'auto', header: 'アクティブなオートシフト', cell: (r) => { const a = appliedShift(env, r.lb, now); return a?.shiftType === 'ZONAL_AUTOSHIFT' ? `${azText(env, a.awayFrom)} から移動中` : '-'; } },
        ]}
      />
      {modal === 'practice' && one && <StartPracticeRunModal r={one} onClose={() => setModal(null)} />}
      {modal === 'delete' && one && (
        <DeleteModal
          header="練習実行設定を削除"
          testId="delete-practice"
          onClose={() => { setModal(null); setSelected([]); }}
          onDelete={() =>
            run((d) => {
              // ゾーンオートシフトには練習実行設定が要るので、コンソールは先に無効にする
              if (configOf(d, one.arn)?.zonalAutoshiftStatus === 'ENABLED') updateZonalAutoshiftConfiguration(d, one.arn, 'DISABLED');
              deletePracticeRunConfiguration(d, one.arn);
            }, `${one.name} の練習実行設定を削除しました`)
          }
        >
          <Box>{`${one.name} の練習実行設定を削除しますか? ゾーンオートシフトも無効になります。`}</Box>
        </DeleteModal>
      )}
    </SpaceBetween>
  );
}

const words = (s: string) => s.split(/[\s,]+/).filter(Boolean);

export function ConfigureAutoshift() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const path = useConsole((s) => s.path);
  const edit = queryParam(path, 'edit') === '1';
  const resources = managedResources(env);
  const [arn, setArn] = useState(queryParam(path, 'resource') ?? '');
  const prev = configOf(env, arn)?.practiceRunConfiguration;
  const [status, setStatus] = useState<'ENABLED' | 'DISABLED'>('ENABLED');
  const [outcome, setOutcome] = useState<string[]>(prev?.outcomeAlarms.map((c) => c.alarmIdentifier) ?? []);
  const [blocking, setBlocking] = useState<string[]>(prev?.blockingAlarms.map((c) => c.alarmIdentifier) ?? []);
  const [dates, setDates] = useState(prev?.blockedDates.join(' ') ?? '');
  const [windows, setWindows] = useState(prev?.blockedWindows.join(' ') ?? '');
  const [ack, setAck] = useState(edit);
  const [error, setError] = useState<AwsError | null>(null);
  const alarmOptions = env.alarms.map((a) => ({ value: a.alarmArn, label: a.alarmName, description: `${a.namespace} ${a.metricName}${a.dimensions.length > 1 ? ` (${a.dimensions.slice(1).map((d) => d.value).join(', ')})` : ''}` }));
  const pickAlarms = (arns: string[]) => alarmOptions.filter((o) => arns.includes(o.value));
  const cond = (arns: string[]) => arns.map((a) => ({ type: 'CLOUDWATCH' as const, alarmIdentifier: a }));
  const submit = () => {
    const input = { outcomeAlarms: cond(outcome), blockingAlarms: cond(blocking), blockedDates: words(dates), blockedWindows: words(windows) };
    const r = run(
      (d) => {
        if (edit) return updatePracticeRunConfiguration(d, arn, input);
        createPracticeRunConfiguration(d, arn, input);
        return status === 'ENABLED' ? updateZonalAutoshiftConfiguration(d, arn, 'ENABLED') : undefined;
      },
      edit ? '練習実行設定を保存しました' : `${nameOfArn(env, arn)} のゾーンオートシフトを設定しました`,
    );
    if (r.ok) navigate('/arc/zonal-autoshift');
    else setError(r.error);
  };
  const choices = edit ? resources.filter((r) => r.arn === arn) : resources.filter((r) => !configOf(env, r.arn)?.practiceRunConfiguration);
  return (
    <EditForm
      title={edit ? '練習実行設定を編集' : 'ゾーンオートシフトを設定'}
      description="練習実行では、AWS が週に 1 回程度、リソースのトラフィックを 1 つのアベイラビリティーゾーンから 30 分間移動し、残りのゾーンで処理できるかを確かめます。"
      submitText={edit ? '保存' : '作成'}
      submitTestId="autoshift-submit"
      submitHotspotId="arc-autoshift-submit"
      submitDisabled={!arn || !ack}
      onCancel={() => navigate('/arc/zonal-autoshift')}
      onSubmit={submit}
      error={error}
    >
      <Container header={<Header variant="h2">リソース</Header>}>
        <FormField label="リソース" description="ゾーンシフトが有効なリソース (マネージドリソース) から選びます。">
          <Select selectedOption={choices.filter((r) => r.arn === arn).map((r) => ({ value: r.arn, label: r.name }))[0] ?? null} options={choices.map((r) => ({ value: r.arn, label: r.name, description: r.arn }))} onChange={(e) => setArn(e.detail.selectedOption.value!)} placeholder="リソースを選択" disabled={edit} data-testid="autoshift-resource" />
        </FormField>
      </Container>
      {!edit && (
        <Container header={<Header variant="h2">ゾーンオートシフト</Header>}>
          <RadioGroup
            value={status}
            onChange={(e) => setStatus(e.detail.value as 'ENABLED' | 'DISABLED')}
            items={[
              { value: 'ENABLED', label: 'ゾーンオートシフトを有効化', description: 'AWS がアベイラビリティーゾーンの障害を検出すると、このリソースのトラフィックを自動でそのゾーンから移動します。' },
              { value: 'DISABLED', label: 'ゾーンオートシフトを無効化', description: '練習実行設定だけを作成します。' },
            ]}
          />
        </Container>
      )}
      <Container header={<Header variant="h2" description="練習実行を監視・制御する CloudWatch アラームと、練習実行をしない日時 (UTC) を指定します。">練習実行設定</Header>}>
        <SpaceBetween size="l">
          <Hotspot hotspotId="arc-outcome-alarm" direction="right">
            <FormField label="結果アラーム" description="練習実行の間、アプリケーションの健全性を監視するアラーム。練習実行中にアラーム状態になると、練習実行は失敗として終了し、トラフィックは元に戻ります。" constraintText="1 つ以上必須 (最大 10 個)。">
              <Multiselect selectedOptions={pickAlarms(outcome)} options={alarmOptions} onChange={(e) => setOutcome(e.detail.selectedOptions.map((o) => o.value!))} placeholder="アラームを選択" data-testid="outcome-alarms" />
            </FormField>
          </Hotspot>
          <FormField label={<>ブロッキングアラーム - <i>オプション</i></>} description="アラーム状態の間は、練習実行を開始しません (実行中なら中断します)。">
            <Multiselect selectedOptions={pickAlarms(blocking)} options={alarmOptions} onChange={(e) => setBlocking(e.detail.selectedOptions.map((o) => o.value!))} placeholder="アラームを選択" data-testid="blocking-alarms" />
          </FormField>
          <FormField label={<>ブロックされた日付 - <i>オプション</i></>} constraintText="YYYY-MM-DD (UTC) をスペースで区切って入力します。例: 2026-12-24 2026-12-31">
            <Input value={dates} onChange={(e) => setDates(e.detail.value)} />
          </FormField>
          <FormField label={<>ブロックされた時間枠 - <i>オプション</i></>} constraintText="曜日:HH:MM-曜日:HH:MM (UTC、同じ曜日) をスペースで区切って入力します。例: Mon:00:00-Mon:10:00">
            <Input value={windows} onChange={(e) => setWindows(e.detail.value)} />
          </FormField>
          {!edit && (
            <Checkbox checked={ack} onChange={(e) => setAck(e.detail.checked)} data-testid="autoshift-ack">
              練習実行のために、AWS が週に 1 回程度、このリソースのトラフィックを 1 つのアベイラビリティーゾーンから移動することを了承します。
            </Checkbox>
          )}
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- Elastic Load Balancing: 属性 / 統合 tabs, edit attributes ----------------

const onOff = (v: string) => (v === 'true' ? 'オン' : 'オフ');

export function LbAttributesTab({ lb }: { lb: LoadBalancer }) {
  const navigate = useNavigate();
  const a = lbAttributes(lb);
  return (
    <ResourceDetail
      title="属性"
      columns={3}
      actions={
        <Hotspot hotspotId="lb-attributes-edit" direction="left">
          <Button onClick={() => navigate(`${lbPath(lb.loadBalancerName)}/edit-attributes`)} data-testid="edit-lb-attributes">編集</Button>
        </Hotspot>
      }
      fields={[
        { label: 'HTTP/2', value: onOff(a['routing.http2.enabled']) },
        { label: 'アイドルタイムアウト', value: `${a['idle_timeout.timeout_seconds']} 秒` },
        { label: 'HTTP クライアントキープアライブ期間', value: `${a['client_keep_alive.seconds']} 秒` },
        { label: '非同期緩和モード', value: a['routing.http.desync_mitigation_mode'] },
        { label: '無効なヘッダーフィールドを削除', value: onOff(a['routing.http.drop_invalid_header_fields.enabled']) },
        { label: 'X-Forwarded-For ヘッダー', value: a['routing.http.xff_header_processing.mode'] },
        { label: 'クロスゾーン負荷分散', value: onOff(a['load_balancing.cross_zone.enabled']) },
        { label: 'ARC ゾーンシフト統合', value: <span data-testid="lb-zonal-shift">{zonalShiftEnabled(lb) ? '有効' : '無効'}</span> },
        { label: '削除保護', value: onOff(a['deletion_protection.enabled']) },
        { label: 'WAF フェイルオープン', value: onOff(a['waf.fail_open.enabled']) },
        { label: 'アクセスログ', value: onOff(a['access_logs.s3.enabled']) },
        { label: '接続ログ', value: onOff(a['connection_logs.s3.enabled']) },
      ]}
    />
  );
}

export function LbIntegrationsTab({ lb }: { lb: LoadBalancer }) {
  const env = useEnv();
  const navigate = useNavigate();
  const now = useNow(5000);
  const enabled = zonalShiftEnabled(lb);
  const a = appliedShift(env, lb, now);
  return (
    <Container header={<Header variant="h2" description="ゾーンシフトとゾーンオートシフトで、障害のあるアベイラビリティーゾーンからこのロードバランサーのトラフィックを移動します。" actions={<Button disabled={!enabled} onClick={() => navigate(`/arc/zonal-shift/start?${new URLSearchParams({ resource: lb.loadBalancerArn })}`)} data-testid="lb-start-shift">ゾーンシフトを開始する</Button>}>Amazon Application Recovery Controller (ARC)</Header>}>
      <SpaceBetween size="m">
        {!enabled && <Alert type="info">ARC ゾーンシフト統合が無効です。「属性」タブの「編集」から有効にすると、このロードバランサーでゾーンシフトを開始できます。</Alert>}
        <ResourceDetail
          title="ゾーンシフト"
          columns={3}
          fields={[
            { label: 'ARC ゾーンシフト統合', value: enabled ? '有効' : '無効' },
            { label: 'ゾーンシフトのステータス', value: a ? `${azText(env, a.awayFrom)} からトラフィックを移動中 (${a.shiftType === 'ZONAL_SHIFT' ? 'ゾーンシフト' : a.shiftType === 'ZONAL_AUTOSHIFT' ? 'オートシフト' : '練習実行'})` : 'アクティブなゾーンシフトはありません' },
            { label: 'ゾーンオートシフト', value: <ConsoleLink to="/arc/zonal-autoshift">{configOf(env, lb.loadBalancerArn)?.zonalAutoshiftStatus === 'ENABLED' ? '有効' : '無効'}</ConsoleLink> },
          ]}
        />
      </SpaceBetween>
    </Container>
  );
}

/** the target table's 管理オーバーライド column (elb.tsx): targets in the shifted-away AZ get no new requests */
export function adminOverride(env: AwsEnv, lb: LoadBalancer, az: string | undefined, now = Date.now()): string {
  const a = appliedShift(env, lb, now);
  return a && azNameOf(env, a.awayFrom) === az ? 'ゾーンシフトがアクティブ' : 'オーバーライドなし';
}

export function EditLbAttributes({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const lb = env.loadBalancers.find((l) => l.loadBalancerName === name);
  const [zonal, setZonal] = useState(!!lb && zonalShiftEnabled(lb));
  const [error, setError] = useState<AwsError | null>(null);
  if (!lb) return <NotFound what="ロードバランサー" id={name} />;
  const back = () => navigate(`${lbPath(name)}?tab=attributes`);
  const a = lbAttributes(lb);
  const submit = () => {
    const r = run((d) => modifyLoadBalancerAttributes(d, lb.loadBalancerArn, [{ key: ZONAL_SHIFT_ATTRIBUTE, value: String(zonal) }]), `ロードバランサー ${name} の属性を更新しました`);
    if (r.ok) back();
    else setError(r.error);
  };
  return (
    <EditForm title="ロードバランサー属性を編集" description={`${name} の属性`} submitText="変更内容の保存" submitTestId="save-lb-attributes" submitHotspotId="lb-attributes-save" onCancel={back} onSubmit={submit} error={error}>
      <Container header={<Header variant="h2">トラフィックの設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="HTTP/2"><Toggle checked={a['routing.http2.enabled'] === 'true'} disabled>オン</Toggle></FormField>
          <FormField label="アイドルタイムアウト" constraintText="このシミュレーターでは変更できません。"><Input value={a['idle_timeout.timeout_seconds']} disabled /></FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">アベイラビリティーゾーンのルーティング設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="クロスゾーン負荷分散" description="ロードバランサーのどのノードも、すべてのアベイラビリティーゾーンの登録済みターゲットにトラフィックを分散します。Application Load Balancer では常にオンです (ターゲットグループの属性で無効にできます)。">
            <Toggle checked disabled>オン</Toggle>
          </FormField>
          <Hotspot hotspotId="lb-zonal-shift-toggle" direction="right">
            <FormField label="ARC ゾーンシフト統合" description="Amazon Application Recovery Controller (ARC) のゾーンシフトとゾーンオートシフトで、障害のあるアベイラビリティーゾーンからこのロードバランサーのトラフィックを移動できるようにします。">
              <Toggle checked={zonal} onChange={(e) => setZonal(e.detail.checked)} data-testid="zonal-shift-toggle">有効化</Toggle>
            </FormField>
          </Hotspot>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">保護</Header>}>
        <FormField label="削除保護" constraintText="このシミュレーターでは変更できません。"><Toggle checked={a['deletion_protection.enabled'] === 'true'} disabled>オン</Toggle></FormField>
      </Container>
    </EditForm>
  );
}
