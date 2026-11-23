import { albAzMetric, evaluateAlarm, getMetricData, listMetrics, MINUTE } from '../cloudwatch';
import { targetHealth } from '../elb';
import { simulateHttp } from '../http';
import { advanceTime } from '../time';
import type { AwsEnv } from '../types';
import { ALB_5XX_ALARM, azAlarm, IMPAIRED_AZ, zonalShiftEnv } from './zonalshift-scenario';
import {
  appliedWeights,
  autoshiftsAt,
  azIdOf,
  cancelZonalShift,
  createPracticeRunConfiguration,
  deletePracticeRunConfiguration,
  getManagedResource,
  managedResources,
  modifyLoadBalancerAttributes,
  RECOVERY_AFTER_SHIFT_MS,
  shiftedAwayAz,
  startPracticeRun,
  startZonalShift,
  updateZonalAutoshiftConfiguration,
  updateZonalShift,
  ZONAL_SHIFT_ATTRIBUTE,
} from './zonalshift';

const lb = (env: AwsEnv) => env.loadBalancers[0];
const enable = (env: AwsEnv) => modifyLoadBalancerAttributes(env, lb(env).loadBalancerArn, [{ key: ZONAL_SHIFT_ATTRIBUTE, value: 'true' }]);
/** what each of the next n seconds of browser requests gets (the ALB spreads requests by the clock) */
function requests(env: AwsEnv, n = 3) {
  const out: { status?: number; body: string }[] = [];
  for (let i = 0; i < n; i++) {
    vi.setSystemTime(Date.now() + 1000);
    out.push(simulateHttp(env, `http://${lb(env).dnsName}/`));
  }
  return out;
}
const sum = (env: AwsEnv, metric: string, az?: string, minutes = 5) => {
  const ref = az ? albAzMetric(lb(env), metric, az) : { namespace: 'AWS/ApplicationELB', metricName: metric, dimensions: [{ name: 'LoadBalancer', value: lb(env).loadBalancerArn.split(':loadbalancer/')[1] }] };
  return getMetricData(env, ref, { start: Date.now() - minutes * MINUTE, end: Date.now(), period: 60, stat: 'Sum' });
};

describe('zonal shift (lesson 47)', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('AZ IDs follow describe-availability-zones', () => {
    expect(['ap-northeast-1a', 'ap-northeast-1c', 'ap-northeast-1d'].map(azIdOf)).toEqual(['apne1-az1', 'apne1-az2', 'apne1-az3']);
  });

  it('gray failure: every target is healthy, yet requests to the impaired AZ time out; per-AZ metrics and alarms show it', () => {
    const env = zonalShiftEnv();
    const tg = env.targetGroups[0];
    expect(tg.targets.map((t) => targetHealth(env, tg.targetGroupArn, t).state)).toEqual(['healthy', 'healthy', 'healthy']);
    const r = requests(env);
    expect(r.map((x) => x.status).sort()).toEqual([200, 200, 500]);
    expect(simulateHttp(env, `http://${lb(env).dnsName}/health`).status).toBe(200);
    expect(sum(env, 'HTTPCode_Target_5XX_Count', IMPAIRED_AZ).at(-1)!.v).toBeGreaterThan(1000);
    expect(sum(env, 'HTTPCode_Target_5XX_Count', 'ap-northeast-1a').at(-1)!.v).toBe(0);
    const states = Object.fromEntries(env.alarms.map((a) => [a.alarmName, evaluateAlarm(env, a).state]));
    expect(states).toEqual({ [ALB_5XX_ALARM]: 'ALARM', [azAlarm('ap-northeast-1a')]: 'OK', [azAlarm(IMPAIRED_AZ)]: 'ALARM', [azAlarm('ap-northeast-1d')]: 'OK' });
    expect(listMetrics(env).filter((m) => m.dimensions[1]?.name === 'AvailabilityZone')).toHaveLength(9);
  });

  it('the ALB attribute registers it as a managed resource; bad keys and values are rejected', () => {
    const env = zonalShiftEnv();
    expect(managedResources(env)).toEqual([]);
    expect(() => startZonalShift(env, { resourceIdentifier: lb(env).loadBalancerArn, awayFrom: 'apne1-az2', expiresIn: '1h', comment: 'x' })).toThrow(/Resource not found/);
    expect(() => modifyLoadBalancerAttributes(env, lb(env).loadBalancerArn, [{ key: 'zonal_shift.enabled', value: 'true' }])).toThrow(/not recognized/);
    expect(() => modifyLoadBalancerAttributes(env, lb(env).loadBalancerArn, [{ key: ZONAL_SHIFT_ATTRIBUTE, value: 'yes' }])).toThrow(/not valid/);
    expect(() => modifyLoadBalancerAttributes(env, lb(env).loadBalancerArn, [{ key: 'load_balancing.cross_zone.enabled', value: 'false' }])).toThrow(/not supported/);
    enable(env);
    expect(managedResources(env).map((r) => [r.name, r.availabilityZones])).toEqual([['web-alb', ['apne1-az1', 'apne1-az2', 'apne1-az3']]]);
    modifyLoadBalancerAttributes(env, lb(env).loadBalancerArn, [{ key: ZONAL_SHIFT_ATTRIBUTE, value: 'false' }]);
    expect(lb(env).attributes).toBeUndefined();
  });

  it('a zonal shift moves traffic away from the AZ ID until it is canceled; the AZ heals meanwhile', () => {
    const env = zonalShiftEnv();
    enable(env);
    const arn = lb(env).loadBalancerArn;
    expect(() => startZonalShift(env, { resourceIdentifier: arn, awayFrom: IMPAIRED_AZ, expiresIn: '1h', comment: 'x' })).toThrow(/not a valid Availability Zone ID/);
    expect(() => startZonalShift(env, { resourceIdentifier: arn, awayFrom: 'apne1-az4', expiresIn: '1h', comment: 'x' })).toThrow(/not deployed/);
    expect(() => startZonalShift(env, { resourceIdentifier: arn, awayFrom: 'apne1-az2', expiresIn: '73h', comment: 'x' })).toThrow(/72 hours/);
    expect(() => startZonalShift(env, { resourceIdentifier: arn, awayFrom: 'apne1-az2', expiresIn: '1d', comment: 'x' })).toThrow(/whole number/);
    const s = startZonalShift(env, { resourceIdentifier: arn, awayFrom: 'apne1-az2', expiresIn: '1h', comment: '1c gray failure' });
    expect(s.expiryTime - s.startTime).toBe(60 * MINUTE);
    expect(() => startZonalShift(env, { resourceIdentifier: arn, awayFrom: 'apne1-az1', expiresIn: '1h', comment: 'x' })).toThrow(/already active/);
    expect(shiftedAwayAz(env, lb(env), Date.now())).toBe(IMPAIRED_AZ);
    expect(appliedWeights(env, getManagedResource(env, arn), Date.now())).toEqual({ 'apne1-az1': 1, 'apne1-az2': 0, 'apne1-az3': 1 });
    const during = requests(env, 6);
    expect(during.every((x) => x.status === 200)).toBe(true);
    expect(during.some((x) => x.body.includes('web-2'))).toBe(false);
    // the shifted-away AZ gets no requests (no datapoints), the others share them
    expect(sum(env, 'RequestCount', IMPAIRED_AZ, 0)).toEqual([]);
    updateZonalShift(env, s.zonalShiftId, { expiresIn: '2h', comment: 'still investigating' });
    expect(env.zonalShift!.shifts[0]).toMatchObject({ comment: 'still investigating', expiryTime: Date.now() + 120 * MINUTE });
    vi.setSystemTime(s.startTime + RECOVERY_AFTER_SHIFT_MS + 1000);
    cancelZonalShift(env, s.zonalShiftId);
    expect(env.zonalShift!.shifts[0].status).toBe('CANCELED');
    expect(() => cancelZonalShift(env, s.zonalShiftId)).toThrow(/not active/);
    const after = requests(env, 3);
    expect(after.map((x) => x.status)).toEqual([200, 200, 200]);
    expect(after.some((x) => x.body.includes('web-2'))).toBe(true);
    expect(evaluateAlarm(env, env.alarms.find((a) => a.alarmName === ALB_5XX_ALARM)!).state).toBe('OK');
  });

  it('a shift expires by itself', () => {
    const env = zonalShiftEnv();
    enable(env);
    const s = startZonalShift(env, { resourceIdentifier: lb(env).loadBalancerArn, awayFrom: 'apne1-az3', expiresIn: '30m', comment: '' });
    expect(advanceTime(env, s.startTime + 29 * MINUTE)).toBe(false);
    expect(advanceTime(env, s.startTime + 30 * MINUTE)).toBe(true);
    expect(env.zonalShift!.shifts[0].status).toBe('EXPIRED');
    expect(shiftedAwayAz(env, lb(env), Date.now() + 31 * MINUTE)).toBeUndefined();
  });

  it('autoshift needs a practice run configuration (outcome alarm); practice runs succeed, fail or get interrupted by alarms', () => {
    const env = zonalShiftEnv();
    enable(env);
    const arn = lb(env).loadBalancerArn;
    const alarmArn = (name: string) => env.alarms.find((a) => a.alarmName === name)!.alarmArn;
    expect(() => updateZonalAutoshiftConfiguration(env, arn, 'ENABLED')).toThrow(/practice run configuration is required/);
    expect(() => createPracticeRunConfiguration(env, arn, { outcomeAlarms: [] })).toThrow(/At least 1 outcome alarm/);
    expect(() => createPracticeRunConfiguration(env, arn, { outcomeAlarms: [{ type: 'CLOUDWATCH', alarmIdentifier: alarmArn(ALB_5XX_ALARM) + 'x' }] })).toThrow(/does not exist/);
    expect(() => createPracticeRunConfiguration(env, arn, { outcomeAlarms: [{ type: 'CLOUDWATCH', alarmIdentifier: alarmArn(ALB_5XX_ALARM) }], blockedWindows: ['Mon:09:00-Tue:10:00'] })).toThrow(/same day/);
    createPracticeRunConfiguration(env, arn, { outcomeAlarms: [{ type: 'CLOUDWATCH', alarmIdentifier: alarmArn(ALB_5XX_ALARM) }], blockedDates: ['2026-12-24'] });
    expect(() => createPracticeRunConfiguration(env, arn, { outcomeAlarms: [{ type: 'CLOUDWATCH', alarmIdentifier: alarmArn(ALB_5XX_ALARM) }] })).toThrow(/already exists/);
    // the impaired AZ: an autoshift starts as soon as autoshift is on (AWS noticed the impairment long ago) and heals the AZ
    updateZonalAutoshiftConfiguration(env, arn, 'ENABLED');
    expect(autoshiftsAt(env, lb(env), Date.now())).toEqual([{ awayFrom: 'apne1-az2', startTime: Date.now() }]);
    expect(shiftedAwayAz(env, lb(env), Date.now())).toBe(IMPAIRED_AZ);
    expect(() => deletePracticeRunConfiguration(env, arn)).toThrow(/Disable zonal autoshift/);
    vi.setSystemTime(Date.now() + RECOVERY_AFTER_SHIFT_MS + 2 * MINUTE);
    expect(autoshiftsAt(env, lb(env), Date.now())).toEqual([]);
    const p = startPracticeRun(env, { resourceIdentifier: arn, awayFrom: 'apne1-az1', comment: 'drill' });
    expect(p).toMatchObject({ shiftType: 'PRACTICE_RUN', practiceRunOutcome: 'PENDING' });
    expect(shiftedAwayAz(env, lb(env), Date.now())).toBe('ap-northeast-1a');
    advanceTime(env, p.startTime + 30 * MINUTE);
    expect(env.zonalShift!.shifts[0]).toMatchObject({ status: 'EXPIRED', practiceRunOutcome: 'SUCCEEDED' });
    // the next drill: another AZ goes bad while 1a is shifted away, the outcome alarm goes off and fails the practice run
    vi.setSystemTime(p.startTime + 31 * MINUTE);
    startPracticeRun(env, { resourceIdentifier: arn, awayFrom: 'apne1-az1', comment: 'drill 2' });
    env.zonalShift!.impairments.push({ availabilityZone: 'ap-northeast-1d', startedAt: Date.now() + MINUTE });
    vi.setSystemTime(Date.now() + 2 * MINUTE);
    expect(advanceTime(env, Date.now())).toBe(true);
    expect(env.zonalShift!.shifts[1]).toMatchObject({ status: 'CANCELED', practiceRunOutcome: 'FAILED' });
    expect(() => cancelZonalShift(env, env.zonalShift!.shifts[1].zonalShiftId)).toThrow(/not active/);
    expect(() => startPracticeRun(env, { resourceIdentifier: arn, awayFrom: 'apne1-az1', comment: 'drill 3' })).toThrow(/outcome alarms are in the ALARM state/);
    updateZonalAutoshiftConfiguration(env, arn, 'DISABLED');
    deletePracticeRunConfiguration(env, arn);
  });
});
