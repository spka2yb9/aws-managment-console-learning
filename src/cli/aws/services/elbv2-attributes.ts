/* aws elbv2 — ロードバランサーの属性 (zonal_shift.config.enabled でゾーンシフトを有効にする。ほかの属性は値を持つだけ) */
import { getLb } from '../../../sim/env';
import { lbAttributes, modifyLoadBalancerAttributes } from '../../../sim/ext/zonalshift';
import { AwsError, req, service, structs, type OperationSpec } from '../types';

const out = (attrs: Record<string, string>) => ({ Attributes: Object.entries(attrs).map(([Key, Value]) => ({ Key, Value })) });

const ops: OperationSpec[] = [
  {
    name: 'describe-load-balancer-attributes',
    desc: 'ロードバランサーの属性 (削除保護・アイドルタイムアウト・ゾーンシフトなど) の一覧',
    params: [{ name: 'load-balancer-arn', type: 'string', required: true, desc: 'ロードバランサーの ARN' }],
    readOnly: true,
    examples: ["aws elbv2 describe-load-balancer-attributes --load-balancer-arn arn:aws:elasticloadbalancing:... --query 'Attributes[?Key==`zonal_shift.config.enabled`]'"],
    run: (ctx) => out(lbAttributes(getLb(ctx.env, req(ctx, 'load-balancer-arn')))),
  },
  {
    name: 'modify-load-balancer-attributes',
    desc: 'ロードバランサーの属性を変える (指定したキーだけ)',
    params: [
      { name: 'load-balancer-arn', type: 'string', required: true, desc: 'ロードバランサーの ARN' },
      { name: 'attributes', type: 'list', of: 'structure', required: true, desc: 'Key=zonal_shift.config.enabled,Value=true (複数可)' },
    ],
    examples: ['aws elbv2 modify-load-balancer-attributes --load-balancer-arn arn:aws:elasticloadbalancing:... --attributes Key=zonal_shift.config.enabled,Value=true'],
    run(ctx) {
      const changes = structs(ctx, 'attributes').map((a) => {
        if (a.Key === undefined || a.Value === undefined) throw new AwsError('ValidationError', 'Each attribute must have a Key and a Value');
        return { key: String(a.Key), value: String(a.Value) };
      });
      return out(modifyLoadBalancerAttributes(ctx.env, req(ctx, 'load-balancer-arn'), changes));
    },
  },
];

export default service('elbv2', '', ops);
