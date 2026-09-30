import { trail, withActor, type Actor } from './cloudtrail';
import { appendLog } from './cloudwatch';
import { newUuid, randomHex } from './ids';
import { s3PutObject } from './s3';
import { AwsError, type AwsEnv, type BatchJob, type BatchJobStatus, type EventRule, type JobDefinition } from './types';

/**
 * AWS Batch (Fargate) + EventBridge scheduled rules. advanceBatch() moves jobs through
 * SUBMITTED -> PENDING -> RUNNABLE -> STARTING -> RUNNING -> SUCCEEDED / FAILED and runs the job's
 * behavior model with its job role; advanceEvents() fires schedule rules (rate / cron, UTC) as time passes.
 */

const MINUTE = 60_000;
/** seconds in each state before the next one (real Batch: tens of seconds to minutes) */
const STEP: Partial<Record<BatchJobStatus, [number, BatchJobStatus]>> = { SUBMITTED: [1000, 'PENDING'], PENDING: [1000, 'RUNNABLE'], RUNNABLE: [1500, 'STARTING'], STARTING: [2000, 'RUNNING'], RUNNING: [3000, 'SUCCEEDED'] };

// ---------------- schedule expressions ----------------

/** rate(5 minutes) -> ms, or undefined when it is not a rate expression */
export function rateMs(expr: string): number | undefined {
  const m = /^rate\((\d+) (minute|minutes|hour|hours|day|days)\)$/.exec(expr.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].startsWith('minute') ? MINUTE : m[2].startsWith('hour') ? 60 * MINUTE : 1440 * MINUTE;
  return n * unit;
}

const field = (spec: string, value: number) =>
  spec === '*' || spec === '?' || spec.split(',').some((part) => {
    const [range, step] = part.split('/');
    const [from, to] = range === '*' ? [0, 59] : range.split('-').map(Number);
    const hi = to ?? (step ? 59 : from);
    return value >= from && value <= hi && (value - from) % Number(step ?? 1) === 0;
  });

/** cron(min hour day-of-month month day-of-week year), evaluated in UTC like EventBridge */
export function cronMatches(expr: string, t: number): boolean {
  const m = /^cron\((.+)\)$/.exec(expr.trim());
  if (!m) return false;
  const [min, hour, dom, month, dow] = m[1].split(/\s+/);
  const d = new Date(t);
  return field(min, d.getUTCMinutes()) && field(hour, d.getUTCHours()) && field(dom, d.getUTCDate()) && field(month, d.getUTCMonth() + 1) && field(dow, d.getUTCDay() + 1);
}

export function checkScheduleExpression(expr: string) {
  const e = expr.trim();
  if (rateMs(e) !== undefined) {
    if (/^rate\(1 (minutes|hours|days)\)$/.test(e) || /^rate\(([2-9]|\d{2,}) (minute|hour|day)\)$/.test(e)) throw new AwsError('ValidationException', 'Parameter ScheduleExpression is not valid. (単数形は値が 1 のときだけ: rate(1 minute) / rate(5 minutes))');
    return;
  }
  const c = /^cron\((\S+ ){5}\S+\)$/.test(e);
  if (!c) throw new AwsError('ValidationException', 'Parameter ScheduleExpression is not valid.');
  const [, , dom, , dow] = e.slice(5, -1).split(/\s+/);
  if ((dom === '?') === (dow === '?')) throw new AwsError('ValidationException', 'Parameter ScheduleExpression is not valid. (日と曜日のどちらか一方を ? にします)');
}

/** the next n trigger times after t */
export function nextTriggers(rule: Pick<EventRule, 'scheduleExpression' | 'createdAt'>, t: number, n: number): number[] {
  const out: number[] = [];
  const rate = rateMs(rule.scheduleExpression);
  if (rate) {
    for (let k = Math.floor((t - rule.createdAt) / rate) + 1; out.length < n; k++) out.push(rule.createdAt + k * rate);
    return out;
  }
  for (let m = Math.floor(t / MINUTE) + 1; out.length < n && m < Math.floor(t / MINUTE) + 60 * 24 * 400; m++) if (cronMatches(rule.scheduleExpression, m * MINUTE)) out.push(m * MINUTE);
  return out;
}

// ---------------- Batch ----------------

export function createComputeEnvironment(env: AwsEnv, input: { name: string; maxvCpus: number; subnets: string[]; securityGroupIds: string[] }): string {
  const arn = `arn:aws:batch:${env.region}:${env.accountId}:compute-environment/${input.name}`;
  env.computeEnvironments.push({ computeEnvironmentName: input.name, computeEnvironmentArn: arn, type: 'MANAGED', resourceType: 'FARGATE', maxvCpus: input.maxvCpus, subnets: [...input.subnets], securityGroupIds: [...input.securityGroupIds], state: 'ENABLED', status: 'VALID' });
  trail(env, { source: 'batch', name: 'CreateComputeEnvironment', resources: [['AWS::Batch::ComputeEnvironment', arn]], request: { computeEnvironmentName: input.name, type: 'MANAGED', computeResources: { type: 'FARGATE', maxvCpus: input.maxvCpus } }, response: { computeEnvironmentArn: arn } });
  return arn;
}

export function createJobQueue(env: AwsEnv, input: { name: string; priority: number; computeEnvironment: string }): string {
  const arn = `arn:aws:batch:${env.region}:${env.accountId}:job-queue/${input.name}`;
  env.jobQueues.push({ jobQueueName: input.name, jobQueueArn: arn, priority: input.priority, state: 'ENABLED', computeEnvironmentOrder: [input.computeEnvironment] });
  trail(env, { source: 'batch', name: 'CreateJobQueue', resources: [['AWS::Batch::JobQueue', arn]], request: { jobQueueName: input.name, priority: input.priority }, response: { jobQueueArn: arn } });
  return arn;
}

export function registerJobDefinition(env: AwsEnv, input: Omit<JobDefinition, 'revision' | 'jobDefinitionArn'>): string {
  const revision = Math.max(0, ...env.jobDefinitions.filter((d) => d.jobDefinitionName === input.jobDefinitionName).map((d) => d.revision)) + 1;
  const arn = `arn:aws:batch:${env.region}:${env.accountId}:job-definition/${input.jobDefinitionName}:${revision}`;
  env.jobDefinitions.push({ ...input, revision, jobDefinitionArn: arn });
  trail(env, { source: 'batch', name: 'RegisterJobDefinition', resources: [['AWS::Batch::JobDefinition', arn]], request: { jobDefinitionName: input.jobDefinitionName, type: 'container', platformCapabilities: ['FARGATE'] }, response: { jobDefinitionArn: arn, revision } });
  return arn;
}

const findQueue = (env: AwsEnv, q: string) => env.jobQueues.find((x) => x.jobQueueName === q || x.jobQueueArn === q);
const findDefinition = (env: AwsEnv, d: string) => {
  const [name, rev] = d.split('/').pop()!.split(':');
  const all = env.jobDefinitions.filter((x) => x.jobDefinitionArn === d || x.jobDefinitionName === name);
  return rev ? all.find((x) => String(x.revision) === rev || x.jobDefinitionArn === d) : all.sort((a, b) => b.revision - a.revision)[0];
};

export function submitJob(env: AwsEnv, input: { jobName: string; jobQueue: string; jobDefinition: string }, submittedBy = 'learner', now = Date.now()): string {
  const name = input.jobName.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) throw new AwsError('ClientException', 'Job name should be of length [1-128]. Allowed characters: letters, numbers, hyphens and underscores (first character must be alphanumeric).');
  const q = findQueue(env, input.jobQueue);
  if (!q) throw new AwsError('ClientException', `JobQueue ${input.jobQueue} not found.`);
  const d = findDefinition(env, input.jobDefinition);
  if (!d) throw new AwsError('ClientException', `JobDefinition ${input.jobDefinition} not found.`);
  const jobId = newUuid();
  env.batchJobs.push({ jobId, jobName: name, jobArn: `arn:aws:batch:${env.region}:${env.accountId}:job/${jobId}`, jobQueue: q.jobQueueArn, jobDefinition: d.jobDefinitionArn, status: 'SUBMITTED', statusChangedAt: now, createdAt: now, submittedBy });
  trail(env, { source: 'batch', name: 'SubmitJob', resources: [['AWS::Batch::Job', jobId]], request: { jobName: name, jobQueue: q.jobQueueName, jobDefinition: `${d.jobDefinitionName}:${d.revision}` }, response: { jobArn: `arn:aws:batch:${env.region}:${env.accountId}:job/${jobId}`, jobName: name, jobId } });
  return jobId;
}

/** the container's work, with the job role; returns log lines and the exit code */
function runJob(env: AwsEnv, job: BatchJob, d: JobDefinition, at: number): { lines: string[]; exitCode: number } {
  const bucket = d.command.find((c) => c.startsWith('--bucket='))?.slice(9) ?? '';
  const day = new Date(at + 9 * 3_600_000).toISOString().slice(0, 10);
  const key = `reports/daily-${day}.csv`;
  const lines = [`[INFO] daily-report ${d.image.split(':').pop()} starting (job ${job.jobName})`, `[INFO] aggregating orders for ${day} ...`, `[INFO] 1,284 orders, total 3,912,400 JPY`];
  try {
    s3PutObject(env, { principal: { type: 'role', roleName: d.jobRoleArn?.split('/').pop() ?? '', sessionName: job.jobId.slice(0, 32) }, context: { 'aws:SecureTransport': true } }, bucket, key, { size: 4096, contentType: 'text/csv', body: `date,orders,total\n${day},1284,3912400\n` });
    lines.push(`[INFO] uploaded s3://${bucket}/${key}`, '[INFO] done');
    return { lines, exitCode: 0 };
  } catch (e) {
    if (!(e instanceof AwsError)) throw e;
    lines.push(`Traceback (most recent call last):`, `  File "/app/report.py", line 42, in <module>`, `    s3.put_object(Bucket=bucket, Key=key, Body=csv)`, `botocore.exceptions.ClientError: An error occurred (${e.code}) when calling the PutObject operation: ${e.message}`);
    return { lines, exitCode: 1 };
  }
}

export function advanceBatch(env: AwsEnv, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  let changed = false;
  for (const job of env.batchJobs ?? []) {
    for (let step = STEP[job.status]; step && now - job.statusChangedAt >= step[0]; step = STEP[job.status]) {
      const at = job.statusChangedAt + step[0];
      changed = true;
      if (job.status === 'RUNNING') {
        const d = env.jobDefinitions.find((x) => x.jobDefinitionArn === job.jobDefinition)!;
        const r = runJob(env, job, d, at);
        appendLog(env, '/aws/batch/job', job.logStreamName!, r.lines, at);
        job.exitCode = r.exitCode;
        job.status = r.exitCode === 0 ? 'SUCCEEDED' : 'FAILED';
        job.statusReason = 'Essential container in task exited';
        job.stoppedAt = at;
      } else {
        job.status = step[1];
        if (job.status === 'RUNNING') {
          job.startedAt = at;
          const d = env.jobDefinitions.find((x) => x.jobDefinitionArn === job.jobDefinition)!;
          job.logStreamName = `${d.jobDefinitionName}/default/${randomHex(32)}`;
        }
      }
      job.statusChangedAt = at;
    }
  }
  return changed;
}

// ---------------- EventBridge ----------------

const eventsActor = (env: AwsEnv): Actor => ({ userName: 'Amazon_EventBridge_Invoke_Batch', type: 'AssumedRole', arn: `arn:aws:sts::${env.accountId}:assumed-role/Amazon_EventBridge_Invoke_Batch_Job_Queue/${randomHex(16)}`, sourceIPAddress: 'events.amazonaws.com', userAgent: 'events.amazonaws.com' });

export interface RuleInput {
  name: string;
  description?: string;
  scheduleExpression: string;
  target: { jobQueue: string; jobDefinition: string; jobName: string };
}

export function putRule(env: AwsEnv, input: RuleInput, now = Date.now()): string {
  const name = input.name.trim();
  if (!/^[.\-_A-Za-z0-9]{1,64}$/.test(name)) throw new AwsError('ValidationException', "1 validation error detected: Value at 'name' failed to satisfy constraint: Member must satisfy regular expression pattern: [\\.\\-_A-Za-z0-9]+");
  if (env.eventRules.some((r) => r.name === name)) throw new AwsError('ResourceAlreadyExistsException', `Rule ${name} already exists on EventBus default.`);
  checkScheduleExpression(input.scheduleExpression);
  const q = findQueue(env, input.target.jobQueue);
  if (!q) throw new AwsError('ValidationException', `Job queue ${input.target.jobQueue} does not exist.`);
  const arn = `arn:aws:events:${env.region}:${env.accountId}:rule/${name}`;
  env.eventRules.push({ name, arn, description: input.description, scheduleExpression: input.scheduleExpression.trim(), state: 'ENABLED', targets: [{ id: `Target${randomHex(4)}`, arn: q.jobQueueArn, jobDefinition: input.target.jobDefinition, jobName: input.target.jobName }], createdAt: now, evaluatedUntil: now });
  trail(env, { source: 'events', name: 'PutRule', resources: [['AWS::Events::Rule', arn]], request: { name, scheduleExpression: input.scheduleExpression.trim(), state: 'ENABLED' }, response: { ruleArn: arn } });
  trail(env, { source: 'events', name: 'PutTargets', resources: [['AWS::Events::Rule', arn]], request: { rule: name, targets: [{ arn: q.jobQueueArn, batchParameters: { jobDefinition: input.target.jobDefinition, jobName: input.target.jobName } }] }, response: { failedEntryCount: 0 } });
  return arn;
}

export function setRuleState(env: AwsEnv, name: string, enabled: boolean, now = Date.now()) {
  const r = env.eventRules.find((x) => x.name === name);
  if (!r) throw new AwsError('ResourceNotFoundException', `Rule ${name} does not exist.`);
  r.state = enabled ? 'ENABLED' : 'DISABLED';
  r.evaluatedUntil = now;
  trail(env, { source: 'events', name: enabled ? 'EnableRule' : 'DisableRule', resources: [['AWS::Events::Rule', r.arn]], request: { name }, response: null });
}

/** trigger times in (from, to]: only the elapsed minutes are checked, so a tick stays cheap */
function dueTriggers(rule: EventRule, from: number, to: number): number[] {
  const rate = rateMs(rule.scheduleExpression);
  if (rate) {
    const out: number[] = [];
    for (let k = Math.floor((from - rule.createdAt) / rate) + 1; rule.createdAt + k * rate <= to; k++) out.push(rule.createdAt + k * rate);
    return out;
  }
  const out: number[] = [];
  for (let m = Math.floor(from / MINUTE) + 1; m * MINUTE <= to; m++) if (cronMatches(rule.scheduleExpression, m * MINUTE)) out.push(m * MINUTE);
  return out;
}

export function advanceEvents(env: AwsEnv, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  let changed = false;
  for (const r of env.eventRules ?? []) {
    if (r.state !== 'ENABLED' || now <= r.evaluatedUntil) continue;
    const due = dueTriggers(r, r.evaluatedUntil, now);
    if (!due.length) continue;
    for (const t of due) for (const target of r.targets) withActor(eventsActor(env), t, () => submitJob(env, { jobName: target.jobName, jobQueue: target.arn, jobDefinition: target.jobDefinition }, `EventBridge (${r.name})`, t));
    r.evaluatedUntil = due[due.length - 1];
    changed = true;
  }
  return changed;
}
