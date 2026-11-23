/* aws events — EventBridge のルール (スケジュール) とターゲット (AWS Batch のジョブキュー) */
import { trail } from '../../../sim/cloudtrail';
import { checkScheduleExpression, setRuleState } from '../../../sim/batch';
import type { AwsEnv, EventRule } from '../../../sim/types';
import { AwsError, list, service, str, structs, type OpContext, type OperationSpec } from '../types';

const ruleOf = (env: AwsEnv, name: string): EventRule => {
  const r = env.eventRules.find((x) => x.name === name || x.arn === name);
  if (!r) throw new AwsError('ResourceNotFoundException', `Rule ${name} does not exist on EventBus default.`);
  return r;
};
/* ルールがジョブを投げるときに引き受けるロール (シミュレーターの CloudTrail もこの名前で記録する) */
const invokeRole = (env: AwsEnv) => `arn:aws:iam::${env.accountId}:role/service-role/Amazon_EventBridge_Invoke_Batch_Job_Queue`;

const ruleOut = (r: EventRule) => ({ Name: r.name, Arn: r.arn, State: r.state, ...(r.description ? { Description: r.description } : {}), ScheduleExpression: r.scheduleExpression, EventBusName: 'default' });

/* ジョブ定義: 名前 / 名前:リビジョン / ARN (ルールが動いたときに見つからないと困るので、登録のときに確かめる) */
const jobDefinitionExists = (env: AwsEnv, d: string) => {
  const [name, rev] = d.split('/').pop()!.split(':');
  return env.jobDefinitions.some((x) => x.jobDefinitionArn === d || (x.jobDefinitionName === name && (!rev || String(x.revision) === rev)));
};

const ruleName = (ctx: OpContext, opt = 'name') => str(ctx, opt)!;

const ops: OperationSpec[] = [
  {
    name: 'list-rules',
    desc: 'ルールの一覧 (スケジュール式・状態)',
    params: [
      { name: 'name-prefix', type: 'string', desc: '名前の頭で絞る' },
      { name: 'event-bus-name', type: 'string', desc: 'イベントバス (default)' },
    ],
    readOnly: true,
    run(ctx) {
      const prefix = str(ctx, 'name-prefix') ?? '';
      return { Rules: ctx.env.eventRules.filter((r) => r.name.startsWith(prefix)).sort((a, b) => a.name.localeCompare(b.name)).map(ruleOut) };
    },
  },
  {
    name: 'describe-rule',
    desc: 'ルール 1 つの詳細',
    params: [
      { name: 'name', type: 'string', required: true, desc: 'ルール名' },
      { name: 'event-bus-name', type: 'string', desc: 'イベントバス (default)' },
    ],
    readOnly: true,
    examples: ['aws events describe-rule --name daily-report-schedule'],
    run(ctx) {
      const r = ruleOf(ctx.env, ruleName(ctx));
      return { ...ruleOut(r), CreatedBy: ctx.env.accountId };
    },
  },
  {
    name: 'put-rule',
    desc: 'ルールを作る (同じ名前があれば置き換える)。ターゲットは put-targets で付ける',
    params: [
      { name: 'name', type: 'string', required: true, desc: 'ルール名' },
      { name: 'schedule-expression', type: 'string', desc: "rate(5 minutes) / cron(0 17 * * ? *) (cron は UTC)" },
      { name: 'event-pattern', type: 'string', desc: '(このシミュレーターでは未対応) イベントパターン' },
      { name: 'state', type: 'string', desc: 'ENABLED (既定) / DISABLED' },
      { name: 'description', type: 'string', desc: '説明' },
      { name: 'event-bus-name', type: 'string', desc: 'イベントバス (default)' },
    ],
    examples: ["aws events put-rule --name my-rule --schedule-expression 'rate(5 minutes)'"],
    run(ctx) {
      const name = ruleName(ctx).trim();
      if (!/^[.\-_A-Za-z0-9]{1,64}$/.test(name)) throw new AwsError('ValidationException', "1 validation error detected: Value at 'name' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\.\\-_A-Za-z0-9]+");
      if (str(ctx, 'event-pattern')) throw new AwsError('ValidationException', '(シミュレーター) このシミュレーターは、スケジュール (--schedule-expression) のルールだけに対応しています');
      const expr = str(ctx, 'schedule-expression')?.trim();
      if (!expr) throw new AwsError('ValidationException', 'Parameter(s) EventPattern or ScheduleExpression must be specified.');
      checkScheduleExpression(expr);
      const state = str(ctx, 'state') ?? 'ENABLED';
      if (state !== 'ENABLED' && state !== 'DISABLED') throw new AwsError('ValidationException', `1 validation error detected: Value '${state}' at 'state' failed to satisfy constraint: Member must satisfy enum value set: [ENABLED, DISABLED, ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS]`);
      const description = str(ctx, 'description');
      const arn = `arn:aws:events:${ctx.env.region}:${ctx.env.accountId}:rule/${name}`;
      // PutRule は作成と更新を兼ねる。省いた項目は前の値を引き継がない (実物と同じ)
      const old = ctx.env.eventRules.find((r) => r.name === name);
      const fresh = !old || old.scheduleExpression !== expr;
      const rule: EventRule = { name, arn, description, scheduleExpression: expr, state: state as EventRule['state'], targets: old?.targets ?? [], createdAt: fresh ? ctx.now : old.createdAt, evaluatedUntil: fresh || old.state !== state ? ctx.now : old.evaluatedUntil };
      ctx.env.eventRules = old ? ctx.env.eventRules.map((r) => (r === old ? rule : r)) : [...ctx.env.eventRules, rule];
      trail(ctx.env, { source: 'events', name: 'PutRule', resources: [['AWS::Events::Rule', arn]], request: { name, scheduleExpression: expr, state, ...(description ? { description } : {}) }, response: { ruleArn: arn } });
      return { RuleArn: arn };
    },
  },
  {
    name: 'enable-rule',
    desc: 'ルールを有効にする',
    params: [{ name: 'name', type: 'string', required: true, desc: 'ルール名' }],
    run(ctx) {
      setRuleState(ctx.env, ruleOf(ctx.env, ruleName(ctx)).name, true, ctx.now);
      return undefined;
    },
  },
  {
    name: 'disable-rule',
    desc: 'ルールを無効にする (スケジュールで動かなくなる)',
    params: [{ name: 'name', type: 'string', required: true, desc: 'ルール名' }],
    examples: ['aws events disable-rule --name my-rule'],
    run(ctx) {
      setRuleState(ctx.env, ruleOf(ctx.env, ruleName(ctx)).name, false, ctx.now);
      return undefined;
    },
  },
  {
    name: 'list-targets-by-rule',
    desc: 'ルールのターゲット (呼び出す先) の一覧',
    params: [{ name: 'rule', type: 'string', required: true, desc: 'ルール名' }],
    readOnly: true,
    examples: ['aws events list-targets-by-rule --rule daily-report-schedule'],
    run(ctx) {
      const r = ruleOf(ctx.env, ruleName(ctx, 'rule'));
      return { Targets: r.targets.map((t) => ({ Id: t.id, Arn: t.arn, RoleArn: invokeRole(ctx.env), BatchParameters: { JobDefinition: t.jobDefinition, JobName: t.jobName } })) };
    },
  },
  {
    name: 'put-targets',
    desc: 'ルールにターゲットを付ける (同じ Id なら置き換える)。このシミュレーターでは AWS Batch のジョブキューだけ',
    params: [
      { name: 'rule', type: 'string', required: true, desc: 'ルール名' },
      { name: 'targets', type: 'list', of: 'structure', required: true, desc: 'Id=1,Arn=<ジョブキューの ARN>,BatchParameters={JobDefinition=x:1,JobName=y}' },
    ],
    examples: ["aws events put-targets --rule my-rule --targets 'Id=1,Arn=arn:aws:batch:ap-northeast-1:123456789012:job-queue/report-queue,BatchParameters={JobDefinition=daily-report:1,JobName=my-job}'"],
    run(ctx) {
      const r = ruleOf(ctx.env, ruleName(ctx, 'rule'));
      const targets = structs(ctx, 'targets');
      if (!targets.length) throw new AwsError('ValidationException', "1 validation error detected: Value '[]' at 'targets' failed to satisfy constraint: Member must have length greater than or equal to 1");
      const added = targets.map((t) => {
        const id = String(t.Id ?? '');
        const arn = String(t.Arn ?? '');
        if (!id || !arn) throw new AwsError('ValidationException', `Parameter(s) ${!id ? 'Id' : 'Arn'} must be specified for target: ${id || '(no id)'}.`);
        const q = ctx.env.jobQueues.find((x) => x.jobQueueArn === arn);
        if (!q) throw new AwsError('ValidationException', `(シミュレーター) Arn には AWS Batch のジョブキューの ARN (aws batch describe-job-queues の jobQueueArn) を指定してください: ${arn}`);
        const p = (t.BatchParameters ?? {}) as Record<string, unknown>;
        const jobDefinition = list(p.JobDefinition)[0];
        const jobName = list(p.JobName)[0];
        if (!jobDefinition || !jobName) throw new AwsError('ValidationException', `Parameter(s) BatchParameters.JobDefinition and BatchParameters.JobName must be specified for target: ${id}.`);
        if (!jobDefinitionExists(ctx.env, jobDefinition)) throw new AwsError('ValidationException', `JobDefinition ${jobDefinition} not found.`);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(jobName)) throw new AwsError('ValidationException', 'Job name should be of length [1-128]. Allowed characters: letters, numbers, hyphens and underscores (first character must be alphanumeric).');
        return { id, arn: q.jobQueueArn, jobDefinition, jobName };
      });
      r.targets = [...r.targets.filter((x) => !added.some((a) => a.id === x.id)), ...added];
      trail(ctx.env, { source: 'events', name: 'PutTargets', resources: [['AWS::Events::Rule', r.arn]], request: { rule: r.name, targets: added.map((a) => ({ id: a.id, arn: a.arn, batchParameters: { jobDefinition: a.jobDefinition, jobName: a.jobName } })) }, response: { failedEntryCount: 0 } });
      return { FailedEntryCount: 0, FailedEntries: [] };
    },
  },
];

export default service('events', 'Amazon EventBridge (ルール・スケジュール・ターゲット)', ops);
