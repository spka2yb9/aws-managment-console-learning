/* aws rds — DB サブネットグループ・DB インスタンスの作成と変更、停止と開始 */
import { getDb, getDbSubnetGroup } from '../../../sim/env';
import { createDbInstance, createDbSubnetGroup, modifyDbInstance, startDbInstance, stopDbInstance, type DbModification } from '../../../sim/rds';
import type { DbEngine } from '../../../sim/types';
import { dbOut, dbSubnetGroupOut } from '../shapes';
import { AwsError, bool, int, req, service, str, strs, type OperationSpec } from '../types';

const id = { name: 'db-instance-identifier', type: 'string' as const, required: true, desc: 'DB インスタンスの識別子' };

const ops: OperationSpec[] = [
  {
    name: 'create-db-subnet-group',
    api: 'CreateDBSubnetGroup',
    desc: 'DB サブネットグループ (DB を置いてよいサブネットの組。2 つ以上の AZ) を作成する',
    params: [
      { name: 'db-subnet-group-name', type: 'string', required: true, desc: '名前' },
      { name: 'db-subnet-group-description', type: 'string', required: true, desc: '説明' },
      { name: 'subnet-ids', type: 'list', required: true, desc: 'サブネット ID (2 つ以上の AZ)' },
    ],
    run(ctx) {
      const subnetIds = strs(ctx, 'subnet-ids');
      if (!subnetIds.length) throw new AwsError('DBSubnetGroupDoesNotCoverEnoughAZs', "The DB subnet group doesn't meet Availability Zone (AZ) coverage requirement. Current AZ coverage: none. Add subnets to cover at least 2 AZs.");
      const vpcId = ctx.env.subnets.find((s) => s.subnetId === subnetIds[0])?.vpcId;
      if (!vpcId) throw new AwsError('InvalidSubnet', `Subnet ${subnetIds[0]} does not exist`);
      const name = createDbSubnetGroup(ctx.env, { name: req(ctx, 'db-subnet-group-name'), description: req(ctx, 'db-subnet-group-description'), vpcId, subnetIds });
      return { DBSubnetGroup: dbSubnetGroupOut(ctx.env, getDbSubnetGroup(ctx.env, name)) };
    },
  },
  {
    name: 'create-db-instance',
    api: 'CreateDBInstance',
    desc: 'DB インスタンスを作成する',
    params: [
      id,
      { name: 'engine', type: 'string', required: true, desc: 'mysql / postgres' },
      { name: 'engine-version', type: 'string', desc: 'エンジンのバージョン' },
      { name: 'db-instance-class', type: 'string', required: true, desc: 'インスタンスクラス (例: db.t4g.micro)' },
      { name: 'master-username', type: 'string', desc: 'マスターユーザー名 (既定 admin)' },
      { name: 'master-user-password', type: 'string', desc: 'マスターパスワード (8 文字以上)' },
      { name: 'allocated-storage', type: 'integer', desc: 'ストレージ (GiB。既定 20)' },
      { name: 'db-name', type: 'string', desc: '最初に作るデータベース名' },
      { name: 'db-subnet-group-name', type: 'string', desc: 'DB サブネットグループ' },
      { name: 'vpc-security-group-ids', type: 'list', desc: 'セキュリティグループ ID' },
      { name: 'publicly-accessible', type: 'boolean', desc: 'パブリックアクセス (--no-publicly-accessible で無効)' },
      { name: 'multi-az', type: 'boolean', desc: 'マルチ AZ (--no-multi-az で無効)' },
      { name: 'availability-zone', type: 'string', desc: '置く AZ' },
      { name: 'backup-retention-period', type: 'integer', desc: '自動バックアップの保持日数 (0〜35。既定 1)' },
      { name: 'storage-type', type: 'string', desc: 'gp3' },
    ],
    run(ctx) {
      const group = str(ctx, 'db-subnet-group-name') ?? ctx.env.dbSubnetGroups[0]?.dbSubnetGroupName;
      if (!group) throw new AwsError('DBSubnetGroupNotFoundFault', 'DB subnet group is required (--db-subnet-group-name)');
      const sgs = strs(ctx, 'vpc-security-group-ids');
      const vpcId = getDbSubnetGroup(ctx.env, group).vpcId;
      if (!['mysql', 'postgres'].includes(req(ctx, 'engine'))) throw new AwsError('InvalidParameterValue', `Invalid DB engine (このシミュレーターは mysql / postgres に対応)`);
      const created = createDbInstance(ctx.env, {
        identifier: req(ctx, 'db-instance-identifier'),
        engine: req(ctx, 'engine') as DbEngine,
        engineVersion: str(ctx, 'engine-version'),
        dbInstanceClass: req(ctx, 'db-instance-class'),
        masterUsername: str(ctx, 'master-username') ?? 'admin',
        masterPassword: str(ctx, 'master-user-password') ?? '',
        dbName: str(ctx, 'db-name'),
        allocatedStorage: int(ctx, 'allocated-storage') ?? 20,
        dbSubnetGroupName: group,
        vpcSecurityGroupIds: sgs.length ? sgs : ctx.env.securityGroups.filter((g) => g.vpcId === vpcId && g.groupName === 'default').map((g) => g.groupId),
        publiclyAccessible: bool(ctx, 'publicly-accessible') ?? false,
        multiAZ: bool(ctx, 'multi-az') ?? false,
        availabilityZone: str(ctx, 'availability-zone'),
        backupRetentionPeriod: int(ctx, 'backup-retention-period') ?? 1,
      });
      return { DBInstance: dbOut(ctx.env, getDb(ctx.env, created)) };
    },
  },
  {
    name: 'modify-db-instance',
    api: 'ModifyDBInstance',
    desc: 'DB インスタンスの設定を変える (セキュリティグループ・クラス・バックアップ保持期間・マルチ AZ など)',
    params: [
      id,
      { name: 'vpc-security-group-ids', type: 'list', desc: 'セキュリティグループ ID (全部を並べる)' },
      { name: 'db-instance-class', type: 'string', desc: 'インスタンスクラス' },
      { name: 'backup-retention-period', type: 'integer', desc: '自動バックアップの保持日数' },
      { name: 'multi-az', type: 'boolean', desc: 'マルチ AZ' },
      { name: 'publicly-accessible', type: 'boolean', desc: 'パブリックアクセス' },
      { name: 'new-db-instance-identifier', type: 'string', desc: '新しい識別子 (名前の変更)' },
      { name: 'apply-immediately', type: 'boolean', desc: 'すぐに適用する (このシミュレーターは常にすぐ適用)' },
    ],
    run(ctx) {
      const mod: DbModification = {};
      const sgs = strs(ctx, 'vpc-security-group-ids');
      if (sgs.length) mod.vpcSecurityGroupIds = sgs;
      if (str(ctx, 'db-instance-class')) mod.dbInstanceClass = str(ctx, 'db-instance-class');
      if (int(ctx, 'backup-retention-period') !== undefined) mod.backupRetentionPeriod = int(ctx, 'backup-retention-period');
      if (bool(ctx, 'multi-az') !== undefined) mod.multiAZ = bool(ctx, 'multi-az');
      if (bool(ctx, 'publicly-accessible') !== undefined) mod.publiclyAccessible = bool(ctx, 'publicly-accessible');
      if (str(ctx, 'new-db-instance-identifier')) mod.newDbInstanceIdentifier = str(ctx, 'new-db-instance-identifier');
      const current = req(ctx, 'db-instance-identifier');
      modifyDbInstance(ctx.env, current, mod);
      return { DBInstance: dbOut(ctx.env, getDb(ctx.env, mod.newDbInstanceIdentifier?.toLowerCase() ?? current)) };
    },
  },
  {
    name: 'stop-db-instance',
    api: 'StopDBInstance',
    desc: 'DB インスタンスを一時的に停止する',
    params: [id],
    run(ctx) {
      stopDbInstance(ctx.env, req(ctx, 'db-instance-identifier'));
      return { DBInstance: dbOut(ctx.env, getDb(ctx.env, req(ctx, 'db-instance-identifier'))) };
    },
  },
  {
    name: 'start-db-instance',
    api: 'StartDBInstance',
    desc: '停止中の DB インスタンスを開始する',
    params: [id],
    run(ctx) {
      startDbInstance(ctx.env, req(ctx, 'db-instance-identifier'));
      return { DBInstance: dbOut(ctx.env, getDb(ctx.env, req(ctx, 'db-instance-identifier'))) };
    },
  },
];

export default service('rds', '', ops);
