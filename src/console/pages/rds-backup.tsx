import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import DatePicker from '@cloudscape-design/components/date-picker';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Input from '@cloudscape-design/components/input';
import Multiselect from '@cloudscape-design/components/multiselect';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import TimeInput from '@cloudscape-design/components/time-input';
import { useState } from 'react';
import { automatedSnapshots, createDbSnapshot, DB_INSTANCE_CLASSES, deleteDbSnapshot, earliestRestorableTime, findSnapshot, latestRestorableTime, restoreDbInstanceFromSnapshot, restoreDbInstanceToPointInTime, type RestoreInput } from '../../sim/rds';
import type { AwsError, DbInstance, DbSnapshot } from '../../sim/types';
import { sgOption } from '../options';
import { useConsole } from '../store';
import { ActionMenu, ConsoleLink, CopyableValue, EditForm, formatDate, NotFound, queryParam, ResourceDetail, ResourceStatus, ResourceTable, useEnv, useNavigate } from '../ui';
import { useNow } from './cloudwatch';

const JST = 9 * 3_600_000;
const snapshotStatus = (s: DbSnapshot) => (s.status === 'available' ? 'db-available' : 'creating');
const restorePath = (id: string) => `/rds/snapshots/restore?${new URLSearchParams({ id })}`;

function useSnapshots(now: number) {
  const env = useEnv();
  return [...env.dbSnapshots, ...env.dbInstances.flatMap((db) => automatedSnapshots(env, db, now))].sort((a, b) => Date.parse(b.snapshotCreateTime) - Date.parse(a.snapshotCreateTime));
}

function SnapshotTable({ items, title, testId, dbId }: { items: DbSnapshot[]; title: string; testId: string; /** the DB detail page's table: one DB, snapshots are taken of it */ dbId?: string }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [sel, setSel] = useState<DbSnapshot[]>([]);
  const picked = sel[0] && items.find((s) => s.dbSnapshotIdentifier === sel[0].dbSnapshotIdentifier);
  return (
    <ResourceTable<DbSnapshot>
      title={title}
      variant="container"
      headerVariant="h2"
      resourceName="スナップショット"
      testId={testId}
      items={items}
      trackBy={(s) => s.dbSnapshotIdentifier}
      selectedItems={picked ? [picked] : []}
      onSelectionChange={setSel}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <ActionMenu
            items={[
              { id: 'restore', text: 'スナップショットを復元', disabled: picked?.status !== 'available', onClick: () => navigate(restorePath(picked!.dbSnapshotIdentifier)) },
              {
                id: 'delete',
                text: 'スナップショットを削除',
                disabled: picked?.snapshotType !== 'manual',
                disabledReason: 'システムスナップショットは保持期間が過ぎると自動で削除されます',
                onClick: () => {
                  run((d) => deleteDbSnapshot(d, picked!.dbSnapshotIdentifier), `スナップショット ${picked!.dbSnapshotIdentifier} を削除しました`);
                  setSel([]);
                },
              },
            ]}
            testId="snapshot-actions"
          />
          <Button variant="primary" onClick={() => navigate(`/rds/snapshots/take${dbId ? `?${new URLSearchParams({ db: dbId })}` : ''}`)} data-testid="take-snapshot">スナップショットの取得</Button>
        </SpaceBetween>
      }
      columns={[
        { id: 'id', header: 'スナップショット名', cell: (s) => s.dbSnapshotIdentifier, value: (s) => s.dbSnapshotIdentifier },
        ...(!dbId ? [{ id: 'db', header: 'DB インスタンス', cell: (s: DbSnapshot) => s.dbInstanceIdentifier, value: (s: DbSnapshot) => s.dbInstanceIdentifier }] : []),
        { id: 'time', header: 'スナップショット作成時間', cell: (s) => formatDate(s.snapshotCreateTime), value: (s) => s.snapshotCreateTime },
        { id: 'status', header: 'ステータス', cell: (s) => <ResourceStatus state={snapshotStatus(s)} />, value: (s) => s.status },
        { id: 'type', header: 'タイプ', cell: (s) => (s.snapshotType === 'manual' ? '手動' : 'システム') },
        { id: 'size', header: '割り当てられたストレージ', cell: (s) => `${s.allocatedStorage} GiB` },
      ]}
    />
  );
}

export function SnapshotList() {
  const now = useNow(5000);
  const all = useSnapshots(now);
  const [tab, setTab] = useState('manual');
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="手動スナップショットは削除するまで残ります。システムスナップショット (自動バックアップ) は保持期間が過ぎると削除されます。">スナップショット</Header>
      <Tabs
        activeTabId={tab}
        onChange={(e) => setTab(e.detail.activeTabId)}
        tabs={[
          { id: 'manual', label: '手動', content: <SnapshotTable title="手動スナップショット" testId="manual-snapshots" items={all.filter((s) => s.snapshotType === 'manual')} /> },
          { id: 'system', label: 'システム', content: <SnapshotTable title="システムスナップショット" testId="system-snapshots" items={all.filter((s) => s.snapshotType === 'automated')} /> },
        ]}
      />
    </SpaceBetween>
  );
}

export function TakeSnapshot() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [dbId, setDbId] = useState(queryParam(useConsole((s) => s.path), 'db') ?? env.dbInstances[0]?.dbInstanceIdentifier ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="DB スナップショットの取得"
      description="DB インスタンスの、この時点のデータのバックアップを作成します。手動スナップショットは削除するまで保持されます。"
      submitText="スナップショットの取得"
      submitTestId="take-snapshot-submit"
      submitHotspotId="rds-take-snapshot"
      onCancel={() => navigate('/rds/snapshots')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createDbSnapshot(d, dbId, name), `スナップショット ${name.trim().toLowerCase()} を作成しています`);
        if (r.ok) navigate('/rds/snapshots');
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="DB インスタンス">
            <Select selectedOption={dbId ? { value: dbId, label: dbId } : null} options={env.dbInstances.map((d) => ({ value: d.dbInstanceIdentifier, label: d.dbInstanceIdentifier }))} onChange={(e) => setDbId(e.detail.selectedOption.value!)} data-testid="snapshot-db" />
          </FormField>
          <FormField label="スナップショット名" constraintText="英字で始まり、英数字とハイフンのみ。ハイフンで終わったり 2 つ続けたりはできません。">
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="例: webapp-db-before-migration" data-testid="snapshot-name" />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

/** the "DB インスタンスの設定 / 接続" part shared by both restore pages */
function RestoreSettings({ vpcId, value, onChange }: { vpcId: string; value: RestoreInput; onChange: (v: RestoreInput) => void }) {
  const env = useEnv();
  const groups = env.dbSubnetGroups.filter((g) => g.vpcId === vpcId);
  const sgs = env.securityGroups.filter((g) => g.vpcId === vpcId);
  const set = (p: Partial<RestoreInput>) => onChange({ ...value, ...p });
  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">設定</Header>}>
        <FormField label="DB インスタンス識別子" description="復元すると新しい DB インスタンスが作成されます。既存の DB インスタンスとは別の名前を付けます。">
          <Input value={value.identifier} onChange={(e) => set({ identifier: e.detail.value })} placeholder="例: webapp-db-restored" data-testid="restore-identifier" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">インスタンスの設定</Header>}>
        <FormField label="DB インスタンスクラス">
          <Select selectedOption={{ value: value.dbInstanceClass, label: value.dbInstanceClass }} options={DB_INSTANCE_CLASSES.map((c) => ({ value: c.cls, label: c.cls, description: `${c.vcpu} vCPU ${c.memoryGiB} GiB RAM` }))} onChange={(e) => set({ dbInstanceClass: e.detail.selectedOption.value! })} />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">可用性と耐久性</Header>}>
        <RadioGroup value={value.multiAZ ? 'multi' : 'single'} onChange={(e) => set({ multiAZ: e.detail.value === 'multi' })} items={[{ value: 'multi', label: 'マルチ AZ DB インスタンス', description: '別の AZ に同期スタンバイを作成します。' }, { value: 'single', label: '単一の DB インスタンス' }]} />
      </Container>
      <Container header={<Header variant="h2">接続</Header>}>
        <SpaceBetween size="l">
          <FormField label="DB サブネットグループ">
            <Select selectedOption={value.dbSubnetGroupName ? { value: value.dbSubnetGroupName, label: value.dbSubnetGroupName } : null} options={groups.map((g) => ({ value: g.dbSubnetGroupName, label: g.dbSubnetGroupName, description: g.description }))} onChange={(e) => set({ dbSubnetGroupName: e.detail.selectedOption.value! })} />
          </FormField>
          <FormField label="パブリックアクセス">
            <RadioGroup value={value.publiclyAccessible ? 'yes' : 'no'} onChange={(e) => set({ publiclyAccessible: e.detail.value === 'yes' })} items={[{ value: 'yes', label: 'あり' }, { value: 'no', label: 'なし' }]} />
          </FormField>
          <FormField label="既存の VPC セキュリティグループ" description="データベースへのアクセスを許可するセキュリティグループを選択します。復元元の設定は引き継がれません。">
            <Multiselect selectedOptions={sgs.filter((g) => value.vpcSecurityGroupIds.includes(g.groupId)).map(sgOption)} options={sgs.map(sgOption)} onChange={(e) => set({ vpcSecurityGroupIds: e.detail.selectedOptions.map((o) => o.value!) })} placeholder="セキュリティグループを選択" data-testid="restore-sgs" />
          </FormField>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

/** like the console: a fresh form starts with the VPC's default security group selected */
function useRestoreInput(vpcId: string, from?: DbInstance): [RestoreInput, (v: RestoreInput) => void] {
  const env = useEnv();
  return useState<RestoreInput>({
    identifier: '',
    dbInstanceClass: from?.dbInstanceClass ?? 'db.t3.micro',
    dbSubnetGroupName: from?.dbSubnetGroupName ?? env.dbSubnetGroups.find((g) => g.vpcId === vpcId)?.dbSubnetGroupName ?? '',
    vpcSecurityGroupIds: env.securityGroups.filter((g) => g.vpcId === vpcId && g.groupName === 'default').map((g) => g.groupId),
    publiclyAccessible: false,
    multiAZ: false,
  });
}

export function RestoreSnapshot() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const id = queryParam(useConsole((s) => s.path), 'id') ?? '';
  const [now] = useState(() => Date.now());
  const snap = findSnapshot(env, id, now);
  const [input, setInput] = useRestoreInput(snap?.vpcId ?? '', env.dbInstances.find((d) => d.dbInstanceIdentifier === snap?.dbInstanceIdentifier));
  const [error, setError] = useState<AwsError | null>(null);
  if (!snap) return <NotFound what="スナップショット" id={id} />;
  return (
    <EditForm
      title="スナップショットの復元"
      description="スナップショットから新しい DB インスタンスを作成します。元の DB インスタンスは変更されません。"
      submitText="DB インスタンスを復元"
      submitTestId="restore-submit"
      submitHotspotId="rds-restore-submit"
      onCancel={() => navigate('/rds/snapshots')}
      error={error}
      onSubmit={() => {
        const r = run((d) => restoreDbInstanceFromSnapshot(d, id, input), `DB インスタンス ${input.identifier.trim().toLowerCase()} を復元しています`);
        if (r.ok) navigate(`/rds/databases/${r.value}`);
        else setError(r.error);
      }}
    >
      <ResourceDetail
        title="スナップショット"
        columns={3}
        fields={[
          { label: 'スナップショット名', value: snap.dbSnapshotIdentifier },
          { label: 'スナップショット作成時間', value: formatDate(snap.snapshotCreateTime) },
          { label: 'エンジン', value: `${snap.engine === 'mysql' ? 'MySQL Community' : 'PostgreSQL'} ${snap.engineVersion}` },
        ]}
      />
      <RestoreSettings vpcId={snap.vpcId} value={input} onChange={setInput} />
    </EditForm>
  );
}

const toLocalParts = (t: number) => {
  const iso = new Date(t + JST).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19) };
};

export function RestorePitr({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [now] = useState(() => Date.now());
  const src = env.dbInstances.find((d) => d.dbInstanceIdentifier === id);
  const vpcId = env.dbSubnetGroups.find((g) => g.dbSubnetGroupName === src?.dbSubnetGroupName)?.vpcId ?? '';
  const [input, setInput] = useRestoreInput(vpcId, src);
  const [mode, setMode] = useState<'latest' | 'custom'>('latest');
  const latest = latestRestorableTime(now);
  const [date, setDate] = useState(toLocalParts(latest).date);
  const [time, setTime] = useState(toLocalParts(latest).time);
  const [error, setError] = useState<AwsError | null>(null);
  if (!src) return <NotFound what="DB インスタンス" id={id} />;
  const custom = Date.parse(`${date}T${time.length === 5 ? `${time}:00` : time}+09:00`);
  return (
    <EditForm
      title="特定時点への復元"
      description={`${id} の自動バックアップ (スナップショット + トランザクションログ) から、指定した時点のデータで新しい DB インスタンスを作成します。`}
      submitText="特定時点への復元"
      submitTestId="pitr-submit"
      submitHotspotId="rds-pitr-submit"
      onCancel={() => navigate(`/rds/databases/${id}`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => restoreDbInstanceToPointInTime(d, id, { ...input, ...(mode === 'custom' ? { restoreTime: custom } : {}) }, Date.now()), `DB インスタンス ${input.identifier.trim().toLowerCase()} を復元しています`);
        if (r.ok) navigate(`/rds/databases/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">復元時間</Header>}>
        <SpaceBetween size="m">
          <Box variant="small" color="text-body-secondary">{`復元可能な範囲: ${formatDate(earliestRestorableTime(src, now))} 〜 ${formatDate(latest)}`}</Box>
          <RadioGroup
            value={mode}
            onChange={(e) => setMode(e.detail.value as typeof mode)}
            items={[
              { value: 'latest', label: '最新の復元可能時間', description: formatDate(latest) },
              { value: 'custom', label: 'カスタム日時', description: '復元する日時を指定します (UTC+09:00)。' },
            ]}
            data-testid="pitr-mode"
          />
          {mode === 'custom' && (
            <SpaceBetween direction="horizontal" size="s">
              <FormField label="日付">
                <DatePicker value={date} onChange={(e) => setDate(e.detail.value)} placeholder="YYYY/MM/DD" openCalendarAriaLabel={(d) => `日付を選択${d ? `: ${d}` : ''}`} data-testid="pitr-date" />
              </FormField>
              <FormField label="時刻 (UTC+09:00)" constraintText="hh:mm:ss (24 時間表記)">
                <TimeInput value={time} onChange={(e) => setTime(e.detail.value)} format="hh:mm:ss" placeholder="hh:mm:ss" data-testid="pitr-time" />
              </FormField>
            </SpaceBetween>
          )}
        </SpaceBetween>
      </Container>
      <RestoreSettings vpcId={vpcId} value={input} onChange={setInput} />
    </EditForm>
  );
}

/** DB detail > メンテナンスとバックアップ */
export function BackupTab({ db }: { db: DbInstance }) {
  const env = useEnv();
  const now = useNow(5000);
  const navigate = useNavigate();
  const up = ['available', 'backing-up', 'modifying', 'renaming'].includes(db.status);
  const snaps = [...env.dbSnapshots.filter((s) => s.dbInstanceIdentifier === db.dbInstanceIdentifier), ...automatedSnapshots(env, db, now)].sort((a, b) => Date.parse(b.snapshotCreateTime) - Date.parse(a.snapshotCreateTime));
  return (
    <SpaceBetween size="l">
      <ResourceDetail
        title="バックアップ"
        columns={3}
        actions={<Button disabled={db.backupRetentionPeriod <= 0 || !up} onClick={() => navigate(`/rds/databases/${db.dbInstanceIdentifier}/pitr`)}>特定時点への復元</Button>}
        fields={[
          { label: '自動バックアップ', value: db.backupRetentionPeriod > 0 ? `有効 (${db.backupRetentionPeriod} 日)` : '無効' },
          { label: 'バックアップウィンドウ', value: `${db.preferredBackupWindow} UTC` },
          { label: 'スナップショットにタグをコピー', value: '有効' },
          { label: '最も早い復元可能時間', value: db.backupRetentionPeriod > 0 ? formatDate(earliestRestorableTime(db, now)) : '-' },
          { label: '最新の復元可能時間', value: up && db.backupRetentionPeriod > 0 ? formatDate(latestRestorableTime(now)) : '-' },
          { label: 'エンドポイント', value: <CopyableValue value={db.endpointAddress} /> },
        ]}
      />
      <SnapshotTable title="スナップショット" testId="db-snapshots" items={snaps} dbId={db.dbInstanceIdentifier} />
      <Box variant="small" color="text-body-secondary">
        すべてのスナップショットは <ConsoleLink to="/rds/snapshots">スナップショット</ConsoleLink> で確認できます。
      </Box>
    </SpaceBetween>
  );
}
