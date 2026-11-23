/* aws rds delete-db-snapshot — 手動スナップショットを消す (作成・一覧・復元は rds-backup.ts) */
import { deleteDbSnapshot } from '../../../sim/rds';
import { AwsError, iso, req, service, type OperationSpec } from '../types';

const ops: OperationSpec[] = [
  {
    name: 'delete-db-snapshot',
    api: 'DeleteDBSnapshot',
    desc: '手動の DB スナップショットを消す (自動バックアップのものは保持期間で消える)',
    params: [{ name: 'db-snapshot-identifier', type: 'string', required: true, desc: 'スナップショットの識別子' }],
    run(ctx) {
      const id = req(ctx, 'db-snapshot-identifier');
      if (id.startsWith('rds:')) throw new AwsError('InvalidDBSnapshotState', 'Only manual snapshots may be deleted.');
      const s = ctx.env.dbSnapshots.find((x) => x.dbSnapshotIdentifier === id);
      deleteDbSnapshot(ctx.env, id);
      return {
        DBSnapshot: {
          DBSnapshotIdentifier: s!.dbSnapshotIdentifier,
          DBInstanceIdentifier: s!.dbInstanceIdentifier,
          SnapshotCreateTime: iso(s!.snapshotCreateTime),
          Engine: s!.engine,
          AllocatedStorage: s!.allocatedStorage,
          Status: 'deleted',
          AvailabilityZone: s!.availabilityZone,
          MasterUsername: s!.masterUsername,
          EngineVersion: s!.engineVersion,
          SnapshotType: s!.snapshotType,
          PercentProgress: 100,
          Encrypted: s!.encrypted,
          DBSnapshotArn: s!.dbSnapshotArn,
        },
      };
    },
  },
];

export default service('rds', '', ops);
