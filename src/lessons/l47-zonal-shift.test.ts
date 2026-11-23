import type { ConsoleExerciseContent, TaskContext } from '../lesson/types';
import { albAzMetric, encodeGraph } from '../sim/cloudwatch';
import { cancelZonalShift, createPracticeRunConfiguration, modifyLoadBalancerAttributes, RECOVERY_AFTER_SHIFT_MS, startZonalShift, updatePracticeRunConfiguration, updateZonalAutoshiftConfiguration, updateZonalShift, ZONAL_SHIFT_ATTRIBUTE } from '../sim/ext/zonalshift';
import { ALB_5XX_ALARM, AZS, azAlarm } from '../sim/ext/zonalshift-scenario';
import { simulateHttp } from '../sim/http';
import type { AwsEnv } from '../sim/types';
import { lesson47 } from './l47-zonal-shift';

const ctxOf = (env: AwsEnv, extra: Partial<TaskContext> = {}): TaskContext => ({ env, path: '', region: env.region, visited: [], copied: [], browser: [], commands: [], ...extra });
const exercises = lesson47.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');

describe('47 zonal shift: alarm -> per-AZ metrics -> attribute -> shift apne1-az2 -> 200s -> cancel -> autoshift', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());

  it('solution', () => {
    const env = lesson47.scenario();
    const lb = env.loadBalancers[0];
    const [symptoms, perAz, enable, start, verify, cancel, autoshift] = exercises;
    /** n browser requests, one second apart (the ALB spreads requests by the clock), newest first like ctx.browser */
    const browse = (n: number) => Array.from({ length: n }, () => (vi.setSystemTime(Date.now() + 1000), simulateHttp(env, `http://${lb.dnsName}/`))).reverse();

    expect(symptoms.validate(ctxOf(env, { visited: ['/ec2/target-groups/web-tg'] })).ok).toBe(false);
    expect(symptoms.validate(ctxOf(env, { visited: ['/ec2/target-groups/web-tg', `/cloudwatch/alarms/view?name=${azAlarm('ap-northeast-1c')}`] })).ok).toBe(true);

    const graph = (azs: string[]) => `/cloudwatch/metrics?${new URLSearchParams({ ns: 'AWS/ApplicationELB:AZ', graph: encodeGraph(azs.map((az) => albAzMetric(lb, 'TargetResponseTime', az))) })}`;
    expect(perAz.validate(ctxOf(env, { visited: [graph(AZS.slice(0, 2))] })).ok).toBe(false);
    expect(perAz.validate(ctxOf(env, { visited: [graph(AZS)] })).ok).toBe(true);

    expect(() => startZonalShift(env, { resourceIdentifier: lb.loadBalancerArn, awayFrom: 'apne1-az2', expiresIn: '1h', comment: 'x' })).toThrow(/not found/);
    modifyLoadBalancerAttributes(env, lb.loadBalancerArn, [{ key: ZONAL_SHIFT_ATTRIBUTE, value: 'true' }]);
    expect(enable.validate(ctxOf(env)).ok).toBe(true);

    // the wrong AZ first (a healthy one), then the right one with a comment
    const wrong = startZonalShift(env, { resourceIdentifier: lb.loadBalancerArn, awayFrom: 'apne1-az1', expiresIn: '1h', comment: 'oops' });
    expect(start.validate(ctxOf(env)).lines[0].text).toMatch(/apne1-az2/);
    cancelZonalShift(env, wrong.zonalShiftId);
    const s = startZonalShift(env, { resourceIdentifier: lb.loadBalancerArn, awayFrom: 'apne1-az2', expiresIn: '3h', comment: '' });
    expect(start.validate(ctxOf(env)).ok).toBe(false); // 3 hours
    updateZonalShift(env, s.zonalShiftId, { expiresIn: '1h', comment: 'apne1-az2 (1c) gray failure: 5XX and 5 s latency' });
    expect(start.validate(ctxOf(env)).ok).toBe(true);

    expect(verify.validate(ctxOf(env, { browser: browse(2) })).ok).toBe(false);
    expect(verify.validate(ctxOf(env, { browser: browse(3) })).ok).toBe(true);

    // AWS fixes the AZ meanwhile; the learner cancels and sees web-2 answer again
    vi.setSystemTime(s.startTime + RECOVERY_AFTER_SHIFT_MS + 60_000);
    expect(cancel.validate(ctxOf(env, { browser: browse(3) })).ok).toBe(false);
    cancelZonalShift(env, s.zonalShiftId);
    const v = cancel.validate(ctxOf(env, { browser: browse(3) }));
    expect(v.ok).toBe(true);
    expect(v.lines[0].text).toMatch(/OK に戻りました/);

    const alarmArn = (name: string) => env.alarms.find((a) => a.alarmName === name)!.alarmArn;
    createPracticeRunConfiguration(env, lb.loadBalancerArn, { outcomeAlarms: [{ type: 'CLOUDWATCH', alarmIdentifier: alarmArn(azAlarm('ap-northeast-1c')) }] });
    updateZonalAutoshiftConfiguration(env, lb.loadBalancerArn, 'ENABLED');
    expect(autoshift.validate(ctxOf(env)).ok).toBe(false); // a per-AZ outcome alarm
    updatePracticeRunConfiguration(env, lb.loadBalancerArn, { outcomeAlarms: [{ type: 'CLOUDWATCH', alarmIdentifier: alarmArn(ALB_5XX_ALARM) }] });
    expect(autoshift.validate(ctxOf(env)).ok).toBe(true);
  });
});
