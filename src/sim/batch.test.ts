import { describe, expect, it } from 'vitest';
import { checkScheduleExpression, cronMatches, nextTriggers, putRule, setRuleState, submitJob } from './batch';
import { filterLogEvents } from './cloudwatch';
import { putInlinePolicy } from './iam';
import { reportEnv, REPORTS_BUCKET } from './scenarios';
import { advanceTime } from './time';
import type { AwsEnv } from './types';

const tick = (env: AwsEnv, from: number, seconds: number) => {
  for (let t = from; t <= from + seconds * 1000; t += 1000) advanceTime(env, t);
  return from + seconds * 1000;
};

describe('EventBridge schedules', () => {
  it('cron is UTC; rate needs the right singular/plural', () => {
    expect(cronMatches('cron(0 17 * * ? *)', Date.parse('2026-09-29T17:00:00Z'))).toBe(true); // 02:00 JST
    expect(cronMatches('cron(0 17 * * ? *)', Date.parse('2026-09-29T02:00:00Z'))).toBe(false);
    expect(cronMatches('cron(*/15 9-17 ? * MON-FRI *)'.replace('MON-FRI', '2-6'), Date.parse('2026-09-30T09:45:00Z'))).toBe(true);
    expect(nextTriggers({ scheduleExpression: 'rate(5 minutes)', createdAt: 0 }, 60_000, 2)).toEqual([300_000, 600_000]);
    expect(() => checkScheduleExpression('rate(1 minutes)')).toThrow(/ScheduleExpression/);
    expect(() => checkScheduleExpression('rate(5 minute)')).toThrow(/ScheduleExpression/);
    expect(() => checkScheduleExpression('cron(0 17 * * * *)')).toThrow(/ScheduleExpression/);
    expect(() => checkScheduleExpression('cron(0 17 * * ? *)')).not.toThrow();
  });
});

describe('AWS Batch', () => {
  it('last nights failed with AccessDenied; after fixing the job role a submitted job succeeds; a rate(1 minute) rule submits jobs', () => {
    const env = reportEnv();
    expect(env.batchJobs.map((j) => j.status)).toEqual(['FAILED', 'FAILED']);
    expect(env.batchJobs[0].submittedBy).toBe('EventBridge (daily-report-schedule)');
    const log = filterLogEvents(env, env.logGroups.find((g) => g.logGroupName === '/aws/batch/job')!, { start: 0, end: Date.now(), pattern: 'AccessDenied' });
    expect(log[0].message).toMatch(/assumed-role\/report-job-role\/.* is not authorized to perform: s3:PutObject/);
    let now = Date.now();
    putInlinePolicy(env, 'role', 'report-job-role', 'write-reports', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: `arn:aws:s3:::${REPORTS_BUCKET}/reports/*` }] });
    const id = submitJob(env, { jobName: 'rerun', jobQueue: 'report-queue', jobDefinition: 'daily-report:1' }, 'learner', now);
    expect(env.batchJobs.find((j) => j.jobId === id)!.status).toBe('SUBMITTED');
    now = tick(env, now, 10);
    expect(env.batchJobs.find((j) => j.jobId === id)!.status).toBe('SUCCEEDED');
    expect(env.buckets.find((b) => b.name === REPORTS_BUCKET)!.objects.some((o) => /^reports\/daily-\d{4}-\d{2}-\d{2}\.csv$/.test(o.key))).toBe(true);
    putRule(env, { name: 'report-test', scheduleExpression: 'rate(1 minute)', target: { jobQueue: 'report-queue', jobDefinition: 'daily-report:1', jobName: 'report-test' } }, now);
    now = tick(env, now, 75);
    expect(env.batchJobs.filter((j) => j.submittedBy === 'EventBridge (report-test)').map((j) => j.status)).toEqual(['SUCCEEDED']);
    setRuleState(env, 'report-test', false, now);
    tick(env, now, 70);
    expect(env.batchJobs.filter((j) => j.submittedBy === 'EventBridge (report-test)')).toHaveLength(1);
  });
});
