/* aws rds — スナップショットと復元 (手動スナップショット、自動バックアップ、スナップショットから / 特定時点への復元) */
import { getDb } from '../../../sim/env';
import { automatedSnapshots, createDbSnapshot, earliestRestorableTime, findSnapshot, latestRestorableTime, restoreDbInstanceFromSnapshot, restoreDbInstanceToPointInTime, type RestoreInput } from '../../../sim/rds';
import type { AwsEnv, DbSnapshot } from '../../../sim/types';
import { dbOut } from '../shapes';
import { AwsError, bool, iso, req, service, str, strs, type OpContext, type OperationSpec } from '../types';

const snapshotOut = (env: AwsEnv, s: DbSnapshot) => {
  const db = env.dbInstances.find((d) => d.dbInstanceIdentifier === s.dbInstanceIdentifier);
  return {
    DBSnapshotIdentifier: s.dbSnapshotIdentifier,
    DBInstanceIdentifier: s.dbInstanceIdentifier,
    SnapshotCreateTime: iso(s.snapshotCreateTime),
    Engine: s.engine,
    AllocatedStorage: s.allocatedStorage,
    Status: s.status,
    Port: s.port,
    AvailabilityZone: s.availabilityZone,
    VpcId: s.vpcId,
    ...(db ? { InstanceCreateTime: iso(db.instanceCreateTime) } : {}),
    MasterUsername: s.masterUsername,
    EngineVersion: s.engineVersion,
    LicenseModel: 'general-public-license',
    SnapshotType: s.snapshotType,
    OptionGroupName: `default:${s.engine}-${s.engineVersion.split('.').slice(0, 2).join('-')}`,
    PercentProgress: s.status === 'available' ? 100 : 0,
    StorageType: 'gp3',
    Encrypted: s.encrypted,
    DBSnapshotArn: s.dbSnapshotArn,
    IAMDatabaseAuthenticationEnabled: false,
    ProcessorFeatures: [],
    ...(db ? { DbiResourceId: db.dbiResourceId } : {}),
    TagList: [],
    OriginalSnapshotCreateTime: iso(s.snapshotCreateTime),
    SnapshotTarget: 'region',
  };
};

/** 手動 (env.dbSnapshots) と自動 (各 DB のバックアップ設定から作る) の両方 */
const allSnapshots = (ctx: OpContext) => [...ctx.env.dbInstances.flatMap((db) => automatedSnapshots(ctx.env, db, ctx.now)), ...ctx.env.dbSnapshots];

/** --restore-time: ISO 8601 (タイムゾーンなしは UTC。AWS CLI と同じ) かエポック秒 */
function parseTime(v: string): number {
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(v.trim());
  const t = m ? Date.parse(`${m[1]}T${m[2]}${(m[3] ?? 'Z').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`) : NaN;
  if (Number.isNaN(t)) throw new AwsError('InvalidParameterValue', `Invalid timestamp value for RestoreTime: ${v} (例: 2026-01-01T12:34:56Z / 2026-01-01T21:34:56+09:00)`);
  return t;
}

const restoreParams = [
  { name: 'db-instance-class', type: 'string' as const, desc: 'インスタンスクラス (省略すると元の DB と同じ)' },
  { name: 'db-subnet-group-name', type: 'string' as const, desc: 'DB サブネットグループ (省略すると、このシミュレーターでは元の DB と同じ)' },
  { name: 'vpc-security-group-ids', type: 'list' as const, desc: 'セキュリティグループ ID (省略すると VPC の default。元の DB からは引き継がれない)' },
  { name: 'publicly-accessible', type: 'boolean' as const, desc: 'パブリックアクセス' },
  { name: 'multi-az', type: 'boolean' as const, desc: 'マルチ AZ' },
];

function restoreInput(ctx: OpContext, identifier: string, sourceDbId: string, vpcId: string): RestoreInput {
  const src = ctx.env.dbInstances.find((d) => d.dbInstanceIdentifier === sourceDbId);
  // ponytail: 本物は --db-subnet-group-name を省くとデフォルト VPC に作る。ここでは元の DB と同じ場所にする
  const group = str(ctx, 'db-subnet-group-name') ?? src?.dbSubnetGroupName ?? ctx.env.dbSubnetGroups.find((g) => g.vpcId === vpcId)?.dbSubnetGroupName;
  if (!group) throw new AwsError('DBSubnetGroupNotFoundFault', 'DB subnet group is required (--db-subnet-group-name)');
  return {
    identifier,
    dbInstanceClass: str(ctx, 'db-instance-class') ?? src?.dbInstanceClass ?? 'db.t3.micro',
    dbSubnetGroupName: group,
    vpcSecurityGroupIds: strs(ctx, 'vpc-security-group-ids'),
    publiclyAccessible: bool(ctx, 'publicly-accessible') ?? false,
    multiAZ: bool(ctx, 'multi-az') ?? false,
  };
}

const ops: OperationSpec[] = [
  {
    name: 'create-db-snapshot',
    api: 'CreateDBSnapshot',
    desc: 'DB インスタンスの手動スナップショットを取る (削除するまで残る)',
    params: [
      { name: 'db-instance-identifier', type: 'string', required: true, desc: 'DB インスタンスの識別子' },
      { name: 'db-snapshot-identifier', type: 'string', required: true, desc: 'スナップショットの名前' },
    ],
    examples: ['aws rds create-db-snapshot --db-instance-identifier mydb --db-snapshot-identifier mydb-before-migration'],
    run(ctx) {
      const id = createDbSnapshot(ctx.env, req(ctx, 'db-instance-identifier'), req(ctx, 'db-snapshot-identifier'), ctx.now);
      return { DBSnapshot: snapshotOut(ctx.env, ctx.env.dbSnapshots.find((s) => s.dbSnapshotIdentifier === id)!) };
    },
  },
  {
    name: 'describe-db-snapshots',
    api: 'DescribeDBSnapshots',
    desc: 'スナップショットの一覧 (自動 = automated と 手動 = manual)',
    params: [
      { name: 'db-instance-identifier', type: 'string', desc: 'この DB インスタンスのものだけ' },
      { name: 'db-snapshot-identifier', type: 'string', desc: 'スナップショットの名前で絞る' },
      { name: 'snapshot-type', type: 'string', desc: 'automated / manual' },
    ],
    readOnly: true,
    run(ctx) {
      const db = str(ctx, 'db-instance-identifier');
      const id = str(ctx, 'db-snapshot-identifier');
      const type = str(ctx, 'snapshot-type');
      if (type && !['automated', 'manual', 'shared', 'public', 'awsbackup'].includes(type)) throw new AwsError('InvalidParameterValue', `Invalid snapshot type: ${type}`);
      if (db) getDb(ctx.env, db);
      const list = allSnapshots(ctx).filter((s) => (!db || s.dbInstanceIdentifier === db) && (!id || s.dbSnapshotIdentifier === id) && (!type || s.snapshotType === type));
      if (id && !list.length) throw new AwsError('DBSnapshotNotFound', `DBSnapshot ${id} not found.`);
      return { DBSnapshots: list.map((s) => snapshotOut(ctx.env, s)) };
    },
  },
  {
    name: 'wait db-snapshot-available',
    api: 'DescribeDBSnapshots',
    desc: 'スナップショットが available になるまで待つ',
    params: [
      { name: 'db-snapshot-identifier', type: 'string', desc: 'スナップショットの名前' },
      { name: 'db-instance-identifier', type: 'string', desc: 'この DB インスタンスのスナップショットすべて' },
    ],
    readOnly: true,
    waiter: {
      until(ctx) {
        const id = str(ctx, 'db-snapshot-identifier');
        const db = str(ctx, 'db-instance-identifier');
        const list = allSnapshots(ctx).filter((s) => (!id || s.dbSnapshotIdentifier === id) && (!db || s.dbInstanceIdentifier === db));
        if (!list.length) throw new AwsError('DBSnapshotNotFound', `DBSnapshot ${id ?? db ?? ''} not found.`);
        return list.every((s) => s.status === 'available');
      },
      maxAttempts: 60,
    },
    run: () => undefined,
  },
  {
    name: 'describe-db-instance-automated-backups',
    api: 'DescribeDBInstanceAutomatedBackups',
    desc: '自動バックアップの状態と、特定時点への復元ができる範囲 (RestoreWindow)',
    params: [{ name: 'db-instance-identifier', type: 'string', desc: 'DB インスタンスの識別子で絞る' }],
    readOnly: true,
    run(ctx) {
      const id = str(ctx, 'db-instance-identifier');
      const dbs = ctx.env.dbInstances.filter((d) => d.backupRetentionPeriod > 0 && (!id || d.dbInstanceIdentifier === id));
      return {
        DBInstanceAutomatedBackups: dbs.map((d) => ({
          DBInstanceArn: `arn:aws:rds:${ctx.env.region}:${ctx.env.accountId}:db:${d.dbInstanceIdentifier}`,
          DbiResourceId: d.dbiResourceId,
          Region: ctx.env.region,
          DBInstanceIdentifier: d.dbInstanceIdentifier,
          RestoreWindow: { EarliestTime: iso(earliestRestorableTime(d, ctx.now)), LatestTime: iso(latestRestorableTime(ctx.now)) },
          AllocatedStorage: d.allocatedStorage,
          Status: 'active',
          Port: d.port,
          AvailabilityZone: d.availabilityZone,
          VpcId: ctx.env.dbSubnetGroups.find((g) => g.dbSubnetGroupName === d.dbSubnetGroupName)?.vpcId,
          InstanceCreateTime: iso(d.instanceCreateTime),
          MasterUsername: d.masterUsername,
          Engine: d.engine,
          EngineVersion: d.engineVersion,
          LicenseModel: 'general-public-license',
          Encrypted: d.storageEncrypted,
          StorageType: d.storageType,
          IAMDatabaseAuthenticationEnabled: false,
          BackupRetentionPeriod: d.backupRetentionPeriod,
          DBInstanceAutomatedBackupsArn: `arn:aws:rds:${ctx.env.region}:${ctx.env.accountId}:auto-backup:ab-${d.dbiResourceId.slice(3).toLowerCase()}`,
          BackupTarget: 'region',
        })),
      };
    },
  },
  {
    name: 'restore-db-instance-from-db-snapshot',
    api: 'RestoreDBInstanceFromDBSnapshot',
    desc: 'スナップショットから「新しい」DB インスタンスを作る (元の DB は巻き戻らない)',
    params: [
      { name: 'db-instance-identifier', type: 'string', required: true, desc: '新しい DB インスタンスの識別子' },
      { name: 'db-snapshot-identifier', type: 'string', required: true, desc: '復元するスナップショット' },
      ...restoreParams,
    ],
    examples: ['aws rds restore-db-instance-from-db-snapshot --db-instance-identifier mydb-restored --db-snapshot-identifier mydb-before-migration --vpc-security-group-ids sg-0123456789abcdef0'],
    run(ctx) {
      const snapId = req(ctx, 'db-snapshot-identifier');
      const snap = findSnapshot(ctx.env, snapId, ctx.now);
      if (!snap) throw new AwsError('DBSnapshotNotFound', `DBSnapshot not found: ${snapId}`);
      const id = restoreDbInstanceFromSnapshot(ctx.env, snapId, restoreInput(ctx, req(ctx, 'db-instance-identifier'), snap.dbInstanceIdentifier, snap.vpcId), ctx.now);
      return { DBInstance: dbOut(ctx.env, getDb(ctx.env, id)) };
    },
  },
  {
    name: 'restore-db-instance-to-point-in-time',
    api: 'RestoreDBInstanceToPointInTime',
    desc: '自動バックアップとトランザクションログから、指定した時点の「新しい」DB インスタンスを作る',
    params: [
      { name: 'source-db-instance-identifier', type: 'string', required: true, desc: '元の DB インスタンス' },
      { name: 'target-db-instance-identifier', type: 'string', required: true, desc: '新しい DB インスタンスの識別子' },
      { name: 'restore-time', type: 'timestamp', desc: '戻す時点 (例: 2026-01-01T12:34:56Z、2026-01-01T21:34:56+09:00)' },
      { name: 'use-latest-restorable-time', type: 'boolean', desc: '最新の復元可能時間に戻す' },
      ...restoreParams,
    ],
    examples: ['aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier mydb --target-db-instance-identifier mydb-pitr --restore-time 2026-01-01T12:34:56Z'],
    run(ctx) {
      const src = getDb(ctx.env, req(ctx, 'source-db-instance-identifier'));
      const time = str(ctx, 'restore-time');
      const latest = bool(ctx, 'use-latest-restorable-time');
      if (time && latest) throw new AwsError('InvalidParameterCombination', 'Cannot specify both RestoreTime and UseLatestRestorableTime.');
      if (!time && !latest) throw new AwsError('InvalidParameterCombination', 'You must specify either RestoreTime or UseLatestRestorableTime.');
      const vpcId = ctx.env.dbSubnetGroups.find((g) => g.dbSubnetGroupName === src.dbSubnetGroupName)?.vpcId ?? '';
      const input = { ...restoreInput(ctx, req(ctx, 'target-db-instance-identifier'), src.dbInstanceIdentifier, vpcId), ...(time ? { restoreTime: parseTime(time) } : {}) };
      const id = restoreDbInstanceToPointInTime(ctx.env, src.dbInstanceIdentifier, input, ctx.now);
      return { DBInstance: dbOut(ctx.env, getDb(ctx.env, id)) };
    },
  },
];

export default service('rds', '', ops);
