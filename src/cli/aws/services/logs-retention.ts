/* aws logs — ロググループの保持期間 */
import { putRetentionPolicy } from '../../../sim/cloudwatch';
import { int, req, service, type OperationSpec } from '../types';

const group = { name: 'log-group-name', type: 'string' as const, required: true, desc: 'ロググループ名' };

const ops: OperationSpec[] = [
  {
    name: 'put-retention-policy',
    desc: 'ロググループの保持期間 (日) を決める。古いログはこの日数を過ぎると消える',
    params: [group, { name: 'retention-in-days', type: 'integer', required: true, desc: '1, 3, 5, 7, 14, 30, 60, 90, ... 3653' }],
    examples: ['aws logs put-retention-policy --log-group-name /webapp/app --retention-in-days 30'],
    run(ctx) {
      putRetentionPolicy(ctx.env, req(ctx, 'log-group-name'), int(ctx, 'retention-in-days'));
      return undefined;
    },
  },
  {
    name: 'delete-retention-policy',
    desc: '保持期間の設定を消す (失効しない = ずっと残す に戻る)',
    params: [group],
    run(ctx) {
      putRetentionPolicy(ctx.env, req(ctx, 'log-group-name'), undefined);
      return undefined;
    },
  },
];

export default service('logs', '', ops);
