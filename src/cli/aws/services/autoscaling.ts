/* aws autoscaling — Auto Scaling グループ、スケーリングポリシー (ターゲット追跡)、アクティビティ */
import { createAutoScalingGroup, deleteAutoScalingGroup, deletePolicy, getAsg, liveInstances, putTargetTrackingPolicy, updateAutoScalingGroup, type AsgChanges } from '../../../sim/autoscaling';
import type { AutoScalingGroup, AwsEnv, LaunchTemplate, TargetTrackingPolicy } from '../../../sim/types';
import { AwsError, bool, int, iso, req, service, str, strs, struct, type OpContext, type OperationSpec } from '../types';

const groupName = { name: 'auto-scaling-group-name', type: 'string' as const, required: true, desc: 'Auto Scaling グループの名前' };

/* ターゲット追跡が作る CloudWatch アラームの名前。sim/autoscaling.ts のアクティビティの Cause と同じ作り方にそろえる */
const ttAlarm = (env: AwsEnv, g: AutoScalingGroup, p: TargetTrackingPolicy, kind: 'High' | 'Low') => {
  const name = `TargetTracking-${g.autoScalingGroupName}-Alarm${kind}-${p.policyARN.slice(-12, -1)}`;
  return { AlarmName: name, AlarmARN: `arn:aws:cloudwatch:${env.region}:${env.accountId}:alarm:${name}` };
};

const ltName = (env: AwsEnv, id: string) => env.launchTemplates.find((t) => t.launchTemplateId === id)?.launchTemplateName;

const asgOut = (env: AwsEnv, g: AutoScalingGroup) => ({
  AutoScalingGroupName: g.autoScalingGroupName,
  AutoScalingGroupARN: g.autoScalingGroupARN,
  LaunchTemplate: { LaunchTemplateId: g.launchTemplate.launchTemplateId, LaunchTemplateName: ltName(env, g.launchTemplate.launchTemplateId), Version: g.launchTemplate.version },
  MinSize: g.minSize,
  MaxSize: g.maxSize,
  DesiredCapacity: g.desiredCapacity,
  DefaultCooldown: 300,
  AvailabilityZones: [...new Set(g.subnetIds.map((s) => env.subnets.find((x) => x.subnetId === s)?.availabilityZone ?? ''))].sort(),
  LoadBalancerNames: [],
  TargetGroupARNs: g.targetGroupArns,
  HealthCheckType: g.healthCheckType,
  HealthCheckGracePeriod: g.healthCheckGracePeriod,
  Instances: g.instances
    .filter((r) => r.lifecycleState !== 'Terminated')
    .map((r) => ({
      InstanceId: r.instanceId,
      InstanceType: env.instances.find((i) => i.instanceId === r.instanceId)?.instanceType,
      AvailabilityZone: r.availabilityZone,
      LifecycleState: r.lifecycleState,
      HealthStatus: r.healthStatus,
      LaunchTemplate: { LaunchTemplateId: g.launchTemplate.launchTemplateId, LaunchTemplateName: ltName(env, g.launchTemplate.launchTemplateId), Version: r.launchTemplateVersion },
      ProtectedFromScaleIn: false,
    })),
  CreatedTime: iso(g.createdTime),
  SuspendedProcesses: [],
  VPCZoneIdentifier: g.subnetIds.join(','),
  EnabledMetrics: [],
  Tags: [],
  TerminationPolicies: ['Default'],
  NewInstancesProtectedFromScaleIn: false,
  ServiceLinkedRoleARN: `arn:aws:iam::${env.accountId}:role/aws-service-role/autoscaling.amazonaws.com/AWSServiceRoleForAutoScaling`,
  CapacityRebalance: false,
  TrafficSources: g.targetGroupArns.map((a) => ({ Identifier: a, Type: 'elbv2' })),
});

const policyOut = (env: AwsEnv, g: AutoScalingGroup, p: TargetTrackingPolicy) => ({
  AutoScalingGroupName: g.autoScalingGroupName,
  PolicyName: p.policyName,
  PolicyARN: p.policyARN,
  PolicyType: 'TargetTrackingScaling',
  StepAdjustments: [],
  Alarms: [ttAlarm(env, g, p, 'High'), ttAlarm(env, g, p, 'Low')],
  TargetTrackingConfiguration: { PredefinedMetricSpecification: { PredefinedMetricType: p.metric }, TargetValue: p.targetValue, DisableScaleIn: false },
  Enabled: true,
});

/** --launch-template LaunchTemplateName=x,Version=$Default → sim の起動テンプレートとバージョン */
function launchTemplateIn(ctx: OpContext): { t: LaunchTemplate; version: '$Default' | '$Latest' } | undefined {
  const lt = struct(ctx, 'launch-template');
  if (!lt) return undefined;
  const id = lt.LaunchTemplateId !== undefined ? String(lt.LaunchTemplateId) : undefined;
  const name = lt.LaunchTemplateName !== undefined ? String(lt.LaunchTemplateName) : undefined;
  const t = ctx.env.launchTemplates.find((x) => (id ? x.launchTemplateId === id : x.launchTemplateName === name));
  if (!t) throw new AwsError('ValidationError', `You must use a valid fully-formed launch template. The specified launch template, with template ${id ? `ID ${id}` : `name ${name ?? ''}`}, does not exist.`);
  const v = lt.Version === undefined || lt.Version === '' ? '$Default' : String(lt.Version);
  if (v === '$Default' || v === '$Latest') return { t, version: v };
  // ponytail: sim は $Default / $Latest しか持てない。番号はそのどちらかに当たるときだけ受け付ける
  if (Number(v) === t.defaultVersionNumber) return { t, version: '$Default' };
  if (Number(v) === t.latestVersionNumber) return { t, version: '$Latest' };
  throw new AwsError('ValidationError', `(シミュレーター) Version には $Default か $Latest (または、それに当たる番号) を指定してください: ${v}`);
}

const subnetsIn = (ctx: OpContext) => {
  const v = str(ctx, 'vpc-zone-identifier');
  return v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean);
};

function healthCheckTypeIn(ctx: OpContext): 'EC2' | 'ELB' | undefined {
  const v = str(ctx, 'health-check-type');
  if (v === undefined) return undefined;
  if (v !== 'EC2' && v !== 'ELB') throw new AwsError('ValidationError', `1 validation error detected: Value '${v}' at 'healthCheckType' failed to satisfy constraint: (このシミュレーターでは EC2 / ELB)`);
  return v;
}

const sizeParams = [
  { name: 'min-size', type: 'integer' as const, desc: '最小' },
  { name: 'max-size', type: 'integer' as const, desc: '最大' },
  { name: 'desired-capacity', type: 'integer' as const, desc: '希望するキャパシティ (台数)' },
];
const commonParams = [
  { name: 'launch-template', type: 'structure' as const, desc: 'LaunchTemplateName=名前 (か LaunchTemplateId=lt-...),Version=$Default' },
  { name: 'vpc-zone-identifier', type: 'string' as const, desc: 'サブネット ID をカンマでつないだもの (subnet-a,subnet-c)' },
  { name: 'health-check-type', type: 'string' as const, desc: 'EC2 (既定) / ELB' },
  { name: 'health-check-grace-period', type: 'integer' as const, desc: 'ヘルスチェックの猶予期間 (秒。既定 300)' },
];

const ops: OperationSpec[] = [
  {
    name: 'describe-auto-scaling-groups',
    desc: 'Auto Scaling グループの一覧 (台数の設定と、インスタンスの状態)',
    params: [{ name: 'auto-scaling-group-names', type: 'list', desc: '名前で絞る' }],
    readOnly: true,
    run(ctx) {
      const names = strs(ctx, 'auto-scaling-group-names');
      return { AutoScalingGroups: ctx.env.autoScalingGroups.filter((g) => !names.length || names.includes(g.autoScalingGroupName)).map((g) => asgOut(ctx.env, g)) };
    },
  },
  {
    name: 'describe-scaling-activities',
    desc: 'Auto Scaling が「いつ・何を・なぜ」したかの履歴 (新しい順)',
    params: [
      { name: 'auto-scaling-group-name', type: 'string', desc: 'グループの名前で絞る' },
      { name: 'activity-ids', type: 'list', desc: 'アクティビティ ID で絞る' },
    ],
    readOnly: true,
    run(ctx) {
      const name = str(ctx, 'auto-scaling-group-name');
      const ids = strs(ctx, 'activity-ids');
      const groups = ctx.env.autoScalingGroups.filter((g) => !name || g.autoScalingGroupName === name);
      const all = groups.flatMap((g) =>
        g.activities.map((a) => {
          const i = ctx.env.instances.find((x) => a.description.endsWith(x.instanceId));
          return {
            ActivityId: a.activityId,
            AutoScalingGroupName: g.autoScalingGroupName,
            Description: a.description,
            Cause: a.cause,
            StartTime: iso(a.startTime),
            EndTime: iso(a.startTime),
            StatusCode: a.statusCode,
            Progress: 100,
            Details: JSON.stringify(i ? { 'Subnet ID': i.subnetId, 'Availability Zone': i.availabilityZone } : {}),
            AutoScalingGroupARN: g.autoScalingGroupARN,
          };
        }),
      );
      return { Activities: all.filter((a) => !ids.length || ids.includes(a.ActivityId)).sort((a, b) => b.StartTime!.localeCompare(a.StartTime!)) };
    },
  },
  {
    name: 'create-auto-scaling-group',
    desc: 'Auto Scaling グループを作る (起動テンプレートから希望の台数を起動する)',
    params: [
      groupName,
      ...commonParams,
      { name: 'min-size', type: 'integer', required: true, desc: '最小' },
      { name: 'max-size', type: 'integer', required: true, desc: '最大' },
      { name: 'desired-capacity', type: 'integer', desc: '希望するキャパシティ (省略すると最小と同じ)' },
      { name: 'target-group-arns', type: 'list', desc: 'アタッチするターゲットグループの ARN' },
    ],
    examples: ['aws autoscaling create-auto-scaling-group --auto-scaling-group-name my-asg --launch-template LaunchTemplateName=my-template --min-size 2 --max-size 6 --desired-capacity 2 --vpc-zone-identifier subnet-0aaa,subnet-0ccc --target-group-arns arn:aws:elasticloadbalancing:... --health-check-type ELB --health-check-grace-period 300'],
    run(ctx) {
      const lt = launchTemplateIn(ctx);
      if (!lt) throw new AwsError('ValidationError', 'Valid requests must contain either LaunchTemplate, LaunchConfigurationName, InstanceId or MixedInstancesPolicy parameter.');
      const min = int(ctx, 'min-size')!;
      createAutoScalingGroup(
        ctx.env,
        {
          name: req(ctx, 'auto-scaling-group-name'),
          launchTemplateId: lt.t.launchTemplateId,
          version: lt.version,
          minSize: min,
          maxSize: int(ctx, 'max-size')!,
          desiredCapacity: int(ctx, 'desired-capacity') ?? min,
          subnetIds: subnetsIn(ctx) ?? [],
          targetGroupArns: strs(ctx, 'target-group-arns'),
          healthCheckType: healthCheckTypeIn(ctx) ?? 'EC2',
          healthCheckGracePeriod: int(ctx, 'health-check-grace-period'),
        },
        ctx.now,
      );
      return undefined;
    },
  },
  {
    name: 'update-auto-scaling-group',
    desc: 'Auto Scaling グループの設定を変える (台数・サブネット・ヘルスチェックなど)',
    params: [groupName, ...commonParams, ...sizeParams],
    run(ctx) {
      const lt = launchTemplateIn(ctx);
      const g = getAsg(ctx.env, req(ctx, 'auto-scaling-group-name'));
      if (lt && lt.t.launchTemplateId !== g.launchTemplate.launchTemplateId) throw new AwsError('ValidationError', '(シミュレーター) 起動テンプレートそのものの付け替えには未対応です。Version だけ変えられます');
      const c: AsgChanges = { minSize: int(ctx, 'min-size'), maxSize: int(ctx, 'max-size'), desiredCapacity: int(ctx, 'desired-capacity'), version: lt?.version, subnetIds: subnetsIn(ctx), healthCheckType: healthCheckTypeIn(ctx), healthCheckGracePeriod: int(ctx, 'health-check-grace-period') };
      updateAutoScalingGroup(ctx.env, g.autoScalingGroupName, c, ctx.now);
      return undefined;
    },
  },
  {
    name: 'set-desired-capacity',
    desc: '希望するキャパシティ (台数) を変える',
    params: [groupName, { name: 'desired-capacity', type: 'integer', required: true, desc: '台数' }, { name: 'honor-cooldown', type: 'boolean', desc: 'クールダウンを守る (このシミュレーターでは無視)' }],
    run(ctx) {
      updateAutoScalingGroup(ctx.env, req(ctx, 'auto-scaling-group-name'), { desiredCapacity: int(ctx, 'desired-capacity') }, ctx.now);
      return undefined;
    },
  },
  {
    name: 'attach-load-balancer-target-groups',
    desc: 'ターゲットグループをアタッチする (起動したインスタンスが自動で登録される)',
    params: [groupName, { name: 'target-group-arns', type: 'list', required: true, desc: 'ターゲットグループの ARN' }],
    run(ctx) {
      const g = getAsg(ctx.env, req(ctx, 'auto-scaling-group-name'));
      updateAutoScalingGroup(ctx.env, g.autoScalingGroupName, { targetGroupArns: [...new Set([...g.targetGroupArns, ...strs(ctx, 'target-group-arns')])] }, ctx.now);
      return undefined;
    },
  },
  {
    name: 'delete-auto-scaling-group',
    desc: 'Auto Scaling グループを削除する (--force-delete でインスタンスごと)',
    params: [groupName, { name: 'force-delete', type: 'boolean', desc: 'インスタンスが残っていても、終了させて削除する' }],
    run(ctx) {
      const g = getAsg(ctx.env, req(ctx, 'auto-scaling-group-name'));
      if (liveInstances(g).length && !bool(ctx, 'force-delete')) throw new AwsError('ResourceInUse', 'You cannot delete an AutoScalingGroup while there are instances or pending Spot instance request(s) still in the group.');
      deleteAutoScalingGroup(ctx.env, g.autoScalingGroupName, ctx.now);
      return undefined;
    },
  },
  {
    name: 'put-scaling-policy',
    desc: 'スケーリングポリシーを作る (このシミュレーターはターゲット追跡 TargetTrackingScaling だけ)',
    params: [
      groupName,
      { name: 'policy-name', type: 'string', required: true, desc: 'ポリシーの名前' },
      { name: 'policy-type', type: 'string', desc: 'TargetTrackingScaling' },
      { name: 'target-tracking-configuration', type: 'structure', desc: 'PredefinedMetricSpecification={PredefinedMetricType=ASGAverageCPUUtilization},TargetValue=50 (JSON や file:// でも可)' },
    ],
    examples: ["aws autoscaling put-scaling-policy --auto-scaling-group-name my-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration file://config.json"],
    run(ctx) {
      const type = str(ctx, 'policy-type') ?? 'SimpleScaling';
      if (type !== 'TargetTrackingScaling') throw new AwsError('ValidationError', `(シミュレーター) PolicyType ${type} には未対応です。--policy-type TargetTrackingScaling を指定してください`);
      const c = struct(ctx, 'target-tracking-configuration');
      if (!c) throw new AwsError('ValidationError', 'TargetTrackingConfiguration is required for TargetTrackingScaling policy type.');
      if (c.CustomizedMetricSpecification) throw new AwsError('ValidationError', '(シミュレーター) CustomizedMetricSpecification には未対応です。PredefinedMetricSpecification を使ってください');
      const metric = String((c.PredefinedMetricSpecification as { PredefinedMetricType?: unknown } | undefined)?.PredefinedMetricType ?? '');
      if (metric !== 'ASGAverageCPUUtilization' && metric !== 'ALBRequestCountPerTarget')
        throw new AwsError('ValidationError', `1 validation error detected: Value '${metric}' at 'targetTrackingConfiguration.predefinedMetricSpecification.predefinedMetricType' failed to satisfy constraint (このシミュレーターでは ASGAverageCPUUtilization / ALBRequestCountPerTarget)`);
      const targetValue = Number(c.TargetValue);
      if (c.TargetValue === undefined || Number.isNaN(targetValue)) throw new AwsError('ValidationError', 'TargetValue is required.');
      const name = req(ctx, 'auto-scaling-group-name');
      const policyName = req(ctx, 'policy-name');
      putTargetTrackingPolicy(ctx.env, name, { policyName, metric, targetValue });
      const g = getAsg(ctx.env, name);
      const p = g.policies.find((x) => x.policyName === policyName.trim())!;
      return { PolicyARN: p.policyARN, Alarms: [ttAlarm(ctx.env, g, p, 'High'), ttAlarm(ctx.env, g, p, 'Low')] };
    },
  },
  {
    name: 'describe-policies',
    desc: 'スケーリングポリシーの一覧',
    params: [
      { name: 'auto-scaling-group-name', type: 'string', desc: 'グループの名前で絞る' },
      { name: 'policy-names', type: 'list', desc: 'ポリシーの名前で絞る' },
    ],
    readOnly: true,
    run(ctx) {
      const name = str(ctx, 'auto-scaling-group-name');
      const names = strs(ctx, 'policy-names');
      return { ScalingPolicies: ctx.env.autoScalingGroups.filter((g) => !name || g.autoScalingGroupName === name).flatMap((g) => g.policies.filter((p) => !names.length || names.includes(p.policyName)).map((p) => policyOut(ctx.env, g, p))) };
    },
  },
  {
    name: 'delete-policy',
    desc: 'スケーリングポリシーを削除する',
    params: [groupName, { name: 'policy-name', type: 'string', required: true, desc: 'ポリシーの名前' }],
    run(ctx) {
      const g = getAsg(ctx.env, req(ctx, 'auto-scaling-group-name'));
      const policyName = req(ctx, 'policy-name');
      if (!g.policies.some((p) => p.policyName === policyName)) throw new AwsError('ValidationError', `Policy ${policyName} not found for group ${g.autoScalingGroupName}`);
      deletePolicy(ctx.env, g.autoScalingGroupName, policyName);
      return undefined;
    },
  },
  {
    name: 'wait group-in-service',
    desc: 'グループの InService のインスタンスが最小 (MinSize) 以上になるまで待つ',
    params: [{ name: 'auto-scaling-group-names', type: 'list', desc: 'グループの名前' }],
    readOnly: true,
    waiter: {
      until(ctx) {
        const names = strs(ctx, 'auto-scaling-group-names');
        const groups = ctx.env.autoScalingGroups.filter((g) => !names.length || names.includes(g.autoScalingGroupName));
        return groups.length > 0 && groups.every((g) => g.instances.filter((r) => r.lifecycleState === 'InService').length >= g.minSize);
      },
      maxAttempts: 120,
    },
    run: () => undefined,
  },
];

export default service('autoscaling', 'Amazon EC2 Auto Scaling (台数を保つ・増減する)', ops);
