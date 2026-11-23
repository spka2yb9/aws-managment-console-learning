/* aws elbv2 — 参照系 (ロードバランサー・リスナー・ターゲットグループ・ターゲットのヘルス) */
import { getLb, getTg } from '../../../sim/env';
import { listenerOut, lbOut, targetHealthOut, tgOut } from '../shapes';
import { AwsError, byIds, service, str, strs, type OperationSpec } from '../types';

const ops: OperationSpec[] = [
  {
    name: 'describe-load-balancers',
    desc: 'ロードバランサーの一覧 (DNS 名・状態・サブネット・セキュリティグループ)',
    params: [
      { name: 'load-balancer-arns', type: 'list', desc: 'ARN で絞る' },
      { name: 'names', type: 'list', desc: '名前で絞る' },
    ],
    readOnly: true,
    run(ctx) {
      let list = byIds(ctx.env.loadBalancers, strs(ctx, 'load-balancer-arns'), (l) => l.loadBalancerArn, (id) => new AwsError('LoadBalancerNotFound', `One or more load balancers not found: '${id}'`));
      list = byIds(list, strs(ctx, 'names'), (l) => l.loadBalancerName, (id) => new AwsError('LoadBalancerNotFound', `Load balancers '[${id}]' not found`));
      return { LoadBalancers: list.map((l) => lbOut(ctx.env, l)) };
    },
  },
  {
    name: 'describe-listeners',
    desc: 'ロードバランサーのリスナー (ポートと転送先のターゲットグループ)',
    params: [
      { name: 'load-balancer-arn', type: 'string', desc: 'ロードバランサーの ARN' },
      { name: 'listener-arns', type: 'list', desc: 'リスナーの ARN で絞る' },
    ],
    readOnly: true,
    run(ctx) {
      const arn = str(ctx, 'load-balancer-arn');
      const want = strs(ctx, 'listener-arns');
      if (!arn && !want.length) throw new AwsError('ValidationError', 'You must specify either listener ARNs or a load balancer ARN');
      const lbs = arn ? [getLb(ctx.env, arn)] : ctx.env.loadBalancers;
      const rows = lbs.flatMap((lb) => lb.listeners.map((l) => ({ lb, l })));
      return { Listeners: byIds(rows, want, (x) => x.l.listenerArn, () => new AwsError('ListenerNotFound', 'One or more listeners not found')).map((x) => listenerOut(x.lb, x.l)) };
    },
  },
  {
    name: 'describe-target-groups',
    desc: 'ターゲットグループの一覧 (ポート・ヘルスチェックの設定)',
    params: [
      { name: 'target-group-arns', type: 'list', desc: 'ARN で絞る' },
      { name: 'names', type: 'list', desc: '名前で絞る' },
      { name: 'load-balancer-arn', type: 'string', desc: 'このロードバランサーにつながるものだけ' },
    ],
    readOnly: true,
    run(ctx) {
      let list = byIds(ctx.env.targetGroups, strs(ctx, 'target-group-arns'), (t) => t.targetGroupArn, () => new AwsError('TargetGroupNotFound', 'One or more target groups not found'));
      list = byIds(list, strs(ctx, 'names'), (t) => t.targetGroupName, (id) => new AwsError('TargetGroupNotFound', `Target groups '[${id}]' not found`));
      const lb = str(ctx, 'load-balancer-arn');
      if (lb) {
        const l = getLb(ctx.env, lb);
        list = list.filter((t) => l.listeners.some((x) => x.targetGroupArn === t.targetGroupArn));
      }
      return { TargetGroups: list.map((t) => tgOut(ctx.env, t)) };
    },
  },
  {
    name: 'describe-target-health',
    desc: 'ターゲットグループに登録したターゲットのヘルス (healthy / unhealthy と理由)',
    params: [{ name: 'target-group-arn', type: 'string', required: true, desc: 'ターゲットグループの ARN' }],
    readOnly: true,
    run(ctx) {
      const tg = getTg(ctx.env, str(ctx, 'target-group-arn')!);
      return { TargetHealthDescriptions: tg.targets.map((t) => targetHealthOut(ctx.env, tg, t)) };
    },
  },
];

export default service('elbv2', 'Elastic Load Balancing v2 (Application Load Balancer・ターゲットグループ)', ops);
