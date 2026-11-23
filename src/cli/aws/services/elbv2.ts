/* aws elbv2 — ロードバランサー・リスナー・ターゲットグループの作成と変更、ターゲットの登録 */
import { trail } from '../../../sim/cloudtrail';
import { checkHealthCheck, createLoadBalancer, createTargetGroup, deleteLoadBalancer, deregisterTargets, lbsForTargetGroup, modifyTargetGroupHealthCheck, registerTargets, setLoadBalancerSecurityGroups, targetHealth } from '../../../sim/elb';
import { getLb, getSubnet, getTg } from '../../../sim/env';
import { randomHex } from '../../../sim/ids';
import type { HealthCheck } from '../../../sim/types';
import { listenerOut, lbOut, tgOut } from '../shapes';
import { AwsError, int, req, service, str, strs, structs, type OpContext, type OperationSpec } from '../types';

const targets = (ctx: OpContext, defaultPort: number) =>
  structs(ctx, 'targets').map((t) => {
    if (!t.Id) throw new AwsError('ValidationError', 'Target Id must be specified');
    return { id: String(t.Id), port: t.Port === undefined ? defaultPort : Number(t.Port) };
  });

function healthCheckFrom(ctx: OpContext, base: HealthCheck): HealthCheck {
  const port = str(ctx, 'health-check-port');
  const matcher = ctx.p.matcher as Record<string, unknown> | undefined;
  return {
    ...base,
    ...(str(ctx, 'health-check-path') !== undefined ? { path: str(ctx, 'health-check-path')! } : {}),
    ...(port !== undefined ? { port: port === 'traffic-port' ? 'traffic-port' : /^\d+$/.test(port) ? Number(port) : NaN } : {}),
    ...(int(ctx, 'health-check-interval-seconds') !== undefined ? { intervalSeconds: int(ctx, 'health-check-interval-seconds')! } : {}),
    ...(int(ctx, 'health-check-timeout-seconds') !== undefined ? { timeoutSeconds: int(ctx, 'health-check-timeout-seconds')! } : {}),
    ...(int(ctx, 'healthy-threshold-count') !== undefined ? { healthyThresholdCount: int(ctx, 'healthy-threshold-count')! } : {}),
    ...(int(ctx, 'unhealthy-threshold-count') !== undefined ? { unhealthyThresholdCount: int(ctx, 'unhealthy-threshold-count')! } : {}),
    ...(matcher?.HttpCode !== undefined ? { matcher: String(matcher.HttpCode) } : {}),
  };
}

const hcParams = [
  { name: 'health-check-path', type: 'string' as const, desc: 'ヘルスチェックのパス (例: /health)' },
  { name: 'health-check-port', type: 'string' as const, desc: 'traffic-port か番号' },
  { name: 'health-check-protocol', type: 'string' as const, desc: 'HTTP' },
  { name: 'health-check-interval-seconds', type: 'integer' as const, desc: '間隔 (秒)' },
  { name: 'health-check-timeout-seconds', type: 'integer' as const, desc: 'タイムアウト (秒)' },
  { name: 'healthy-threshold-count', type: 'integer' as const, desc: '正常とみなす連続成功回数' },
  { name: 'unhealthy-threshold-count', type: 'integer' as const, desc: '異常とみなす連続失敗回数' },
  { name: 'matcher', type: 'structure' as const, desc: '成功とみなす HTTP コード。例: HttpCode=200' },
];

const forwardTarget = (ctx: OpContext) => {
  const a = structs(ctx, 'default-actions')[0];
  if (!a || String(a.Type ?? '').toLowerCase() !== 'forward' || !a.TargetGroupArn) throw new AwsError('ValidationError', "このシミュレーターのリスナーは 'Type=forward,TargetGroupArn=...' の転送だけに対応しています");
  return String(a.TargetGroupArn);
};

const ops: OperationSpec[] = [
  {
    name: 'create-target-group',
    desc: 'ターゲットグループを作成する',
    params: [
      { name: 'name', type: 'string', required: true, desc: '名前' },
      { name: 'protocol', type: 'string', desc: 'HTTP' },
      { name: 'port', type: 'integer', required: true, desc: 'ターゲットのポート' },
      { name: 'vpc-id', type: 'string', required: true, desc: 'VPC ID' },
      { name: 'target-type', type: 'string', desc: 'instance (既定) / ip' },
      ...hcParams,
    ],
    examples: ['aws elbv2 create-target-group --name web-tg --protocol HTTP --port 3000 --vpc-id vpc-0123456789abcdef0 --health-check-path /health'],
    run(ctx) {
      const arn = createTargetGroup(ctx.env, { name: req(ctx, 'name'), port: int(ctx, 'port')!, vpcId: req(ctx, 'vpc-id'), targetType: (str(ctx, 'target-type') as 'instance' | 'ip' | undefined) ?? 'instance' });
      const tg = getTg(ctx.env, arn);
      tg.healthCheck = healthCheckFrom(ctx, tg.healthCheck);
      checkHealthCheck(tg.healthCheck);
      return { TargetGroups: [tgOut(ctx.env, tg)] };
    },
  },
  {
    name: 'modify-target-group',
    desc: 'ターゲットグループのヘルスチェックの設定を変える',
    params: [{ name: 'target-group-arn', type: 'string', required: true, desc: 'ターゲットグループの ARN' }, ...hcParams],
    run(ctx) {
      const tg = getTg(ctx.env, req(ctx, 'target-group-arn'));
      modifyTargetGroupHealthCheck(ctx.env, tg.targetGroupArn, healthCheckFrom(ctx, tg.healthCheck));
      return { TargetGroups: [tgOut(ctx.env, getTg(ctx.env, tg.targetGroupArn))] };
    },
  },
  {
    name: 'delete-target-group',
    desc: 'ターゲットグループを削除する (リスナーから使われていると消せない)',
    params: [{ name: 'target-group-arn', type: 'string', required: true, desc: 'ターゲットグループの ARN' }],
    run(ctx) {
      const tg = getTg(ctx.env, req(ctx, 'target-group-arn'));
      if (lbsForTargetGroup(ctx.env, tg.targetGroupArn).length) throw new AwsError('ResourceInUse', `Target group '${tg.targetGroupArn}' is currently in use by a listener or a rule`);
      ctx.env.targetGroups = ctx.env.targetGroups.filter((x) => x !== tg);
      trail(ctx.env, { source: 'elasticloadbalancing', name: 'DeleteTargetGroup', resources: [['AWS::ElasticLoadBalancingV2::TargetGroup', tg.targetGroupArn]], request: { targetGroupArn: tg.targetGroupArn }, response: null });
      return undefined;
    },
  },
  {
    name: 'register-targets',
    desc: 'ターゲットグループにターゲット (インスタンスや IP) を登録する',
    params: [
      { name: 'target-group-arn', type: 'string', required: true, desc: 'ターゲットグループの ARN' },
      { name: 'targets', type: 'list', of: 'structure', required: true, desc: 'Id=i-...,Port=3000 (Port を省くとターゲットグループのポート)' },
    ],
    examples: ['aws elbv2 register-targets --target-group-arn arn:aws:elasticloadbalancing:... --targets Id=i-0123456789abcdef0 Id=i-0fedcba9876543210'],
    run(ctx) {
      const tg = getTg(ctx.env, req(ctx, 'target-group-arn'));
      registerTargets(ctx.env, tg.targetGroupArn, targets(ctx, tg.port));
      return undefined;
    },
  },
  {
    name: 'deregister-targets',
    desc: 'ターゲットグループからターゲットを外す',
    params: [
      { name: 'target-group-arn', type: 'string', required: true, desc: 'ターゲットグループの ARN' },
      { name: 'targets', type: 'list', of: 'structure', required: true, desc: 'Id=i-...,Port=80 (登録したときのポートで指定)' },
    ],
    run(ctx) {
      const tg = getTg(ctx.env, req(ctx, 'target-group-arn'));
      const ts = targets(ctx, tg.port);
      const missing = ts.filter((t) => !tg.targets.some((x) => x.id === t.id && x.port === t.port));
      if (missing.length) throw new AwsError('InvalidTarget', `The following targets are not registered in target group '${tg.targetGroupArn}': '${missing.map((t) => `${t.id}:${t.port}`).join("', '")}'`);
      deregisterTargets(ctx.env, tg.targetGroupArn, ts);
      return undefined;
    },
  },
  {
    name: 'create-load-balancer',
    desc: 'Application Load Balancer を作成する (リスナーは create-listener で足す)',
    params: [
      { name: 'name', type: 'string', required: true, desc: '名前' },
      { name: 'subnets', type: 'list', required: true, desc: 'サブネット ID (2 つ以上の AZ)' },
      { name: 'security-groups', type: 'list', desc: 'セキュリティグループ ID' },
      { name: 'scheme', type: 'string', desc: 'internet-facing (既定) / internal' },
      { name: 'type', type: 'string', desc: 'application' },
      { name: 'ip-address-type', type: 'string', desc: 'ipv4' },
    ],
    run(ctx) {
      const subnets = strs(ctx, 'subnets');
      if (!subnets.length) throw new AwsError('ValidationError', 'At least two subnets in two different Availability Zones must be specified');
      const vpcId = getSubnet(ctx.env, subnets[0]).vpcId;
      const sgs = strs(ctx, 'security-groups');
      const groups = sgs.length ? sgs : ctx.env.securityGroups.filter((g) => g.vpcId === vpcId && g.groupName === 'default').map((g) => g.groupId);
      const arn = createLoadBalancer(ctx.env, { name: req(ctx, 'name'), scheme: (str(ctx, 'scheme') as 'internet-facing' | 'internal' | undefined) ?? 'internet-facing', vpcId, subnetIds: subnets, securityGroupIds: groups, listeners: [] });
      return { LoadBalancers: [lbOut(ctx.env, getLb(ctx.env, arn))] };
    },
  },
  {
    name: 'delete-load-balancer',
    desc: 'ロードバランサーを削除する (リスナーも消える。ターゲットグループは残る)',
    params: [{ name: 'load-balancer-arn', type: 'string', required: true, desc: 'ロードバランサーの ARN' }],
    run(ctx) {
      deleteLoadBalancer(ctx.env, req(ctx, 'load-balancer-arn'));
      return undefined;
    },
  },
  {
    name: 'create-listener',
    desc: 'ロードバランサーにリスナー (受け付けるポートと転送先) を足す',
    params: [
      { name: 'load-balancer-arn', type: 'string', required: true, desc: 'ロードバランサーの ARN' },
      { name: 'protocol', type: 'string', desc: 'HTTP' },
      { name: 'port', type: 'integer', required: true, desc: '受け付けるポート' },
      { name: 'default-actions', type: 'list', of: 'structure', required: true, desc: 'Type=forward,TargetGroupArn=...' },
    ],
    examples: ['aws elbv2 create-listener --load-balancer-arn arn:aws:elasticloadbalancing:... --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:...'],
    run(ctx) {
      const lb = getLb(ctx.env, req(ctx, 'load-balancer-arn'));
      const port = int(ctx, 'port')!;
      const tg = getTg(ctx.env, forwardTarget(ctx));
      if (str(ctx, 'protocol') && str(ctx, 'protocol')!.toUpperCase() !== 'HTTP') throw new AwsError('UnsupportedProtocol', 'このシミュレーターの ALB のリスナーは HTTP だけです');
      if (lb.listeners.some((l) => l.port === port)) throw new AwsError('DuplicateListener', 'A listener already exists on this port for this load balancer');
      if (tg.vpcId !== lb.vpcId) throw new AwsError('ValidationError', `Target group '${tg.targetGroupArn}' is not in the same VPC as the load balancer`);
      const used = lbsForTargetGroup(ctx.env, tg.targetGroupArn).filter((x) => x !== lb);
      if (used.length) throw new AwsError('TargetGroupAssociationLimit', `The following target groups cannot be associated with more than one load balancer: ${tg.targetGroupArn}`);
      const l = { listenerArn: `${lb.loadBalancerArn.replace(':loadbalancer/', ':listener/')}/${randomHex(16)}`, protocol: 'HTTP' as const, port, targetGroupArn: tg.targetGroupArn };
      lb.listeners.push(l);
      trail(ctx.env, { source: 'elasticloadbalancing', name: 'CreateListener', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', lb.loadBalancerArn]], request: { loadBalancerArn: lb.loadBalancerArn, protocol: 'HTTP', port, defaultActions: [{ type: 'forward', targetGroupArn: tg.targetGroupArn }] }, response: { listeners: [{ listenerArn: l.listenerArn }] } });
      return { Listeners: [listenerOut(lb, l)] };
    },
  },
  {
    name: 'modify-listener',
    desc: 'リスナーの転送先 (ターゲットグループ) を変える',
    params: [
      { name: 'listener-arn', type: 'string', required: true, desc: 'リスナーの ARN' },
      { name: 'default-actions', type: 'list', of: 'structure', required: true, desc: 'Type=forward,TargetGroupArn=...' },
    ],
    run(ctx) {
      const arn = req(ctx, 'listener-arn');
      const lb = ctx.env.loadBalancers.find((x) => x.listeners.some((l) => l.listenerArn === arn));
      if (!lb) throw new AwsError('ListenerNotFound', 'One or more listeners not found');
      const l = lb.listeners.find((x) => x.listenerArn === arn)!;
      l.targetGroupArn = getTg(ctx.env, forwardTarget(ctx)).targetGroupArn;
      trail(ctx.env, { source: 'elasticloadbalancing', name: 'ModifyListener', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', lb.loadBalancerArn]], request: { listenerArn: arn, defaultActions: [{ type: 'forward', targetGroupArn: l.targetGroupArn }] } });
      return { Listeners: [listenerOut(lb, l)] };
    },
  },
  {
    name: 'delete-listener',
    desc: 'リスナーを削除する',
    params: [{ name: 'listener-arn', type: 'string', required: true, desc: 'リスナーの ARN' }],
    run(ctx) {
      const arn = req(ctx, 'listener-arn');
      const lb = ctx.env.loadBalancers.find((x) => x.listeners.some((l) => l.listenerArn === arn));
      if (!lb) throw new AwsError('ListenerNotFound', 'One or more listeners not found');
      lb.listeners = lb.listeners.filter((l) => l.listenerArn !== arn);
      trail(ctx.env, { source: 'elasticloadbalancing', name: 'DeleteListener', resources: [['AWS::ElasticLoadBalancingV2::LoadBalancer', lb.loadBalancerArn]], request: { listenerArn: arn }, response: null });
      return undefined;
    },
  },
  {
    name: 'set-security-groups',
    desc: 'ロードバランサーのセキュリティグループを付け替える',
    params: [
      { name: 'load-balancer-arn', type: 'string', required: true, desc: 'ロードバランサーの ARN' },
      { name: 'security-groups', type: 'list', required: true, desc: 'セキュリティグループ ID (全部を並べる)' },
    ],
    run(ctx) {
      setLoadBalancerSecurityGroups(ctx.env, req(ctx, 'load-balancer-arn'), strs(ctx, 'security-groups'));
      return { SecurityGroupIds: strs(ctx, 'security-groups') };
    },
  },
  {
    name: 'wait load-balancer-available',
    desc: 'ロードバランサーが active になるまで待つ',
    params: [
      { name: 'load-balancer-arns', type: 'list', desc: 'ARN' },
      { name: 'names', type: 'list', desc: '名前' },
    ],
    readOnly: true,
    waiter: {
      until(ctx) {
        const arns = strs(ctx, 'load-balancer-arns');
        const names = strs(ctx, 'names');
        const lbs = ctx.env.loadBalancers.filter((l) => arns.includes(l.loadBalancerArn) || names.includes(l.loadBalancerName));
        if (!lbs.length) throw new AwsError('LoadBalancerNotFound', 'One or more load balancers not found');
        return lbs.every((l) => l.state === 'active');
      },
    },
    run: () => undefined,
  },
  {
    name: 'wait target-in-service',
    desc: 'ターゲットが healthy になるまで待つ',
    params: [
      { name: 'target-group-arn', type: 'string', required: true, desc: 'ターゲットグループの ARN' },
      { name: 'targets', type: 'list', of: 'structure', desc: 'Id=i-... (省略するとすべて)' },
    ],
    readOnly: true,
    waiter: {
      maxAttempts: 20,
      until(ctx) {
        const tg = getTg(ctx.env, req(ctx, 'target-group-arn'));
        const want = targets(ctx, tg.port);
        const list = want.length ? tg.targets.filter((t) => want.some((w) => w.id === t.id)) : tg.targets;
        return list.length > 0 && list.every((t) => targetHealth(ctx.env, tg.targetGroupArn, t).state === 'healthy');
      },
    },
    run: () => undefined,
  },
];

export default service('elbv2', '', ops);
