/* aws rds — 参照系 (DB インスタンス・DB サブネットグループ) */
import { getDb, getDbSubnetGroup } from '../../../sim/env';
import { dbOut, dbSubnetGroupOut } from '../shapes';
import { service, str, type OperationSpec } from '../types';

const ops: OperationSpec[] = [
  {
    name: 'describe-db-instances',
    api: 'DescribeDBInstances',
    desc: 'DB インスタンスの一覧 (エンドポイント・状態・セキュリティグループ)',
    params: [{ name: 'db-instance-identifier', type: 'string', desc: 'DB インスタンスの識別子で絞る' }],
    readOnly: true,
    run(ctx) {
      const id = str(ctx, 'db-instance-identifier');
      return { DBInstances: (id ? [getDb(ctx.env, id)] : ctx.env.dbInstances).map((d) => dbOut(ctx.env, d)) };
    },
  },
  {
    name: 'describe-db-subnet-groups',
    api: 'DescribeDBSubnetGroups',
    desc: 'DB サブネットグループの一覧',
    params: [{ name: 'db-subnet-group-name', type: 'string', desc: '名前で絞る' }],
    readOnly: true,
    run(ctx) {
      const name = str(ctx, 'db-subnet-group-name');
      return { DBSubnetGroups: (name ? [getDbSubnetGroup(ctx.env, name)] : ctx.env.dbSubnetGroups).map((g) => dbSubnetGroupOut(ctx.env, g)) };
    },
  },
  {
    name: 'wait db-instance-available',
    api: 'DBInstanceAvailable',
    desc: 'DB インスタンスが available になるまで待つ',
    params: [{ name: 'db-instance-identifier', type: 'string', required: true, desc: 'DB インスタンスの識別子' }],
    readOnly: true,
    waiter: { until: (ctx) => getDb(ctx.env, str(ctx, 'db-instance-identifier')!).status === 'available', maxAttempts: 120 },
    run: () => undefined,
  },
];

export default service('rds', 'Amazon RDS (リレーショナルデータベース)', ops);
