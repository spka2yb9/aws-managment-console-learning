import { describe, expect, it } from 'vitest';
import { evaluateAlarm, filterLogEvents, getMetricData, lbDimension, matchesFilter, metricFor, MINUTE, putMetricAlarm, type PutMetricAlarmInput } from './cloudwatch';
import { byName } from './env';
import { modifyDbInstance } from './rds';
import { slowAppEnv, webAppEnv } from './scenarios';
import { advanceTime } from './time';
import type { AwsEnv } from './types';

const avg = (env: AwsEnv, ns: string, metric: string, value: string, from: number, to: number, period = 60) => {
  const d = getMetricData(env, metricFor(ns, metric, value), { start: from, end: to, period, stat: 'Average' });
  return d.reduce((a, b) => a + b.v, 0) / d.length;
};
const rdsCpuAlarm: PutMetricAlarmInput = { alarmName: 'webapp-db-cpu-high', namespace: 'AWS/RDS', metricName: 'CPUUtilization', dimensions: [{ name: 'DBInstanceIdentifier', value: 'webapp-db' }], statistic: 'Average', period: 60, evaluationPeriods: 1, datapointsToAlarm: 1, threshold: 80, comparisonOperator: 'GreaterThanThreshold' };

describe('CloudWatch metrics', () => {
  it('a healthy web app: EC2 basic monitoring is 5-minute, CPU / response time are normal', () => {
    const env = webAppEnv();
    const now = Date.now();
    const web1 = byName(env.instances, 'web-1')!.instanceId;
    const cpu = getMetricData(env, metricFor('AWS/EC2', 'CPUUtilization', web1), { start: now - 60 * MINUTE, end: now, period: 60, stat: 'Average' });
    expect(cpu.length).toBeGreaterThanOrEqual(11);
    expect(cpu.length).toBeLessThanOrEqual(13);
    expect(cpu.every((d) => d.v > 2 && d.v < 40)).toBe(true);
    expect(avg(env, 'AWS/RDS', 'CPUUtilization', 'webapp-db', now - 60 * MINUTE, now)).toBeLessThan(40);
    expect(avg(env, 'AWS/ApplicationELB', 'TargetResponseTime', lbDimension(env.loadBalancers[0]), now - 60 * MINUTE, now)).toBeLessThan(0.1);
    // deterministic: same env, same answer
    expect(getMetricData(env, metricFor('AWS/EC2', 'CPUUtilization', web1), { start: now - 60 * MINUTE, end: now, period: 300, stat: 'Maximum' })).toEqual(getMetricData(env, metricFor('AWS/EC2', 'CPUUtilization', web1), { start: now - 60 * MINUTE, end: now, period: 300, stat: 'Maximum' }));
  });

  it('a slow query: ALB response time and RDS CPU rise 40 minutes ago, EC2 CPU stays normal', () => {
    const env = slowAppEnv();
    const now = Date.now();
    const alb = lbDimension(env.loadBalancers[0]);
    expect(avg(env, 'AWS/ApplicationELB', 'TargetResponseTime', alb, now - 90 * MINUTE, now - 50 * MINUTE)).toBeLessThan(0.1);
    expect(avg(env, 'AWS/ApplicationELB', 'TargetResponseTime', alb, now - 20 * MINUTE, now)).toBeGreaterThan(1);
    expect(avg(env, 'AWS/RDS', 'CPUUtilization', 'webapp-db', now - 90 * MINUTE, now - 50 * MINUTE)).toBeLessThan(40);
    expect(avg(env, 'AWS/RDS', 'CPUUtilization', 'webapp-db', now - 20 * MINUTE, now)).toBeGreaterThan(85);
    expect(avg(env, 'AWS/RDS', 'DatabaseConnections', 'webapp-db', now - 20 * MINUTE, now)).toBeGreaterThan(30);
    expect(avg(env, 'AWS/EC2', 'CPUUtilization', byName(env.instances, 'web-1')!.instanceId, now - 20 * MINUTE, now, 300)).toBeLessThan(40);
  });

  it('a larger DB class lowers CPU from the moment the modification completes', () => {
    const env = slowAppEnv();
    const now = Date.now();
    modifyDbInstance(env, 'webapp-db', { dbInstanceClass: 'db.m7g.xlarge' }, now);
    advanceTime(env, now + 10_000);
    const later = now + 20 * MINUTE;
    expect(avg(env, 'AWS/RDS', 'CPUUtilization', 'webapp-db', now - 20 * MINUTE, now - MINUTE)).toBeGreaterThan(85); // history keeps the old class
    expect(avg(env, 'AWS/RDS', 'CPUUtilization', 'webapp-db', now + 5 * MINUTE, later)).toBeLessThan(60);
    expect(avg(env, 'AWS/ApplicationELB', 'TargetResponseTime', lbDimension(env.loadBalancers[0]), now + 5 * MINUTE, later)).toBeLessThan(0.1);
  });
});

describe('CloudWatch alarms', () => {
  it('evaluates like CloudWatch: ALARM with an AWS-format reason, back to OK after scaling up', () => {
    const env = slowAppEnv();
    const now = Date.now();
    putMetricAlarm(env, rdsCpuAlarm, now);
    const first = evaluateAlarm(env, env.alarms[0], now);
    expect(first.state).toBe('ALARM');
    expect(first.reason).toMatch(/^Threshold Crossed: 1 out of the last 1 datapoints \[\d+(\.\d+)? \(\d\d\/\d\d\/\d\d \d\d:\d\d:00\)\] was greater than the threshold \(80\.0\) \(minimum 1 datapoint for OK -> ALARM transition\)\.$/);
    modifyDbInstance(env, 'webapp-db', { dbInstanceClass: 'db.m7g.xlarge' }, now);
    const after = evaluateAlarm(env, env.alarms[0], now + 5 * MINUTE);
    expect(after.state).toBe('OK');
    expect(after.reason).toContain('was not greater than the threshold (80.0).');
    expect(after.history.map((h) => h.to)).toEqual(['OK', 'ALARM']);
  });

  it('INSUFFICIENT_DATA when the metric has no datapoints; validation errors like the API', () => {
    const env = webAppEnv();
    putMetricAlarm(env, { ...rdsCpuAlarm, alarmName: 'ghost', dimensions: [{ name: 'DBInstanceIdentifier', value: 'no-such-db' }] });
    expect(evaluateAlarm(env, env.alarms[0]).state).toBe('INSUFFICIENT_DATA');
    expect(evaluateAlarm(env, env.alarms[0]).reason).toBe('Insufficient Data: 1 datapoint was unknown.');
    expect(() => putMetricAlarm(env, { ...rdsCpuAlarm, datapointsToAlarm: 3 })).toThrow(/DatapointsToAlarm/);
    expect(() => putMetricAlarm(env, { ...rdsCpuAlarm, period: 90 })).toThrow(/multiple of 60/);
    // same name replaces
    putMetricAlarm(env, rdsCpuAlarm);
    putMetricAlarm(env, { ...rdsCpuAlarm, threshold: 90 });
    expect(env.alarms.filter((a) => a.alarmName === rdsCpuAlarm.alarmName).map((a) => a.threshold)).toEqual([90]);
  });
});

describe('CloudWatch Logs', () => {
  it('filter patterns: AND terms, "phrases", ?any, -exclude, case-sensitive', () => {
    const line = '2026-09-29T05:31:12.345Z ERROR GET /api/orders 500 5003ms - SequelizeConnectionAcquireTimeoutError: Operation timeout';
    expect(matchesFilter('', line)).toBe(true);
    expect(matchesFilter('ERROR orders', line)).toBe(true);
    expect(matchesFilter('ERROR products', line)).toBe(false);
    expect(matchesFilter('"Operation timeout"', line)).toBe(true);
    expect(matchesFilter('"timeout Operation"', line)).toBe(false);
    expect(matchesFilter('?WARN ?ERROR', line)).toBe(true);
    expect(matchesFilter('ERROR -orders', line)).toBe(false);
    expect(matchesFilter('error', line)).toBe(false);
  });

  it('the slow query log only has entries since the incident; the app log turns slow', () => {
    const env = slowAppEnv();
    const now = Date.now();
    const group = (name: string) => env.logGroups.find((g) => g.logGroupName === name)!;
    const slow = filterLogEvents(env, group('/aws/rds/instance/webapp-db/slowquery'), { start: now - 3 * 60 * MINUTE, end: now });
    expect(slow.length).toBeGreaterThan(100);
    expect(Math.min(...slow.map((e) => e.timestamp))).toBeGreaterThanOrEqual(now - 40 * MINUTE - MINUTE);
    expect(slow[0].message).toMatch(/# Query_time: \d+\.\d+ {2}Lock_time: .* Rows_examined: 24\d{5}\nSET timestamp=\d+;\nSELECT \* FROM orders WHERE customer_id = \d+/);
    const app = group('/webapp/app');
    const before = filterLogEvents(env, app, { start: now - 3 * 60 * MINUTE, end: now - 45 * MINUTE, pattern: '?WARN ?ERROR' });
    const during = filterLogEvents(env, app, { start: now - 30 * MINUTE, end: now, pattern: '?WARN ?ERROR' });
    expect(before).toEqual([]);
    expect(during.length).toBeGreaterThan(20);
    expect(new Set(filterLogEvents(env, app, { start: now - 10 * MINUTE, end: now }).map((e) => e.logStreamName)).size).toBe(2);
  });
});
