import { describe, expect, it } from 'vitest';
import { createAutoScalingGroup, getAsg, liveInstances, putTargetTrackingPolicy, setTraffic, updateAutoScalingGroup } from './autoscaling';
import { asgCpuMetric, getMetricData, metricFor } from './cloudwatch';
import { byName } from './env';
import { simulateHttp } from './http';
import { asgEnv } from './scenarios';
import { advanceTime } from './time';
import type { AwsEnv } from './types';

const tick = (env: AwsEnv, from: number, seconds: number) => {
  for (let t = from; t <= from + seconds * 1000; t += 1000) advanceTime(env, t);
  return from + seconds * 1000;
};
const create = (env: AwsEnv, now: number) =>
  createAutoScalingGroup(
    env,
    { name: 'webapp-asg', launchTemplateId: env.launchTemplates[0].launchTemplateId, minSize: 2, maxSize: 6, desiredCapacity: 2, subnetIds: ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId), targetGroupArns: [env.targetGroups[0].targetGroupArn], healthCheckType: 'ELB', healthCheckGracePeriod: 60 },
    now,
  );
const inService = (env: AwsEnv) => getAsg(env, 'webapp-asg').instances.filter((r) => r.lifecycleState === 'InService').length;

describe('Auto Scaling', () => {
  it('launches to the desired capacity across AZs, registers to the target group, and replaces a terminated instance', () => {
    const env = asgEnv();
    const lb = env.loadBalancers[0];
    expect(simulateHttp(env, `http://${lb.dnsName}/`).status).toBe(503);
    let now = Date.now();
    create(env, now);
    const g = getAsg(env, 'webapp-asg');
    expect(g.instances.map((r) => r.lifecycleState)).toEqual(['Pending', 'Pending']);
    expect(new Set(g.instances.map((r) => r.availabilityZone)).size).toBe(2);
    now = tick(env, now, 5);
    expect(inService(env)).toBe(2);
    expect(env.targetGroups[0].targets.length).toBe(2);
    expect(simulateHttp(env, `http://${lb.dnsName}/`).status).toBe(200);
    // someone terminates one by hand: the group notices and launches a replacement
    const victim = g.instances[0].instanceId;
    env.instances.find((i) => i.instanceId === victim)!.state = 'shutting-down';
    tick(env, now, 6);
    const after = getAsg(env, 'webapp-asg');
    expect(liveInstances(after).length).toBe(2);
    expect(liveInstances(after).map((r) => r.instanceId)).not.toContain(victim);
    expect(after.activities.map((a) => a.description)).toContain(`Terminating EC2 instance: ${victim}`);
    expect(() => updateAutoScalingGroup(env, 'webapp-asg', { minSize: 2, maxSize: 6, desiredCapacity: 7 })).toThrow(/Desired capacity:7 must be between the specified min size:2 and max size:6/);
  });

  it('target tracking on CPU: 100 req/s -> 2 instances; 1000 req/s -> ~80% -> 4 instances -> ~45%; back down to 2', () => {
    const env = asgEnv();
    let now = Date.now();
    create(env, now);
    putTargetTrackingPolicy(env, 'webapp-asg', { policyName: 'cpu50', metric: 'ASGAverageCPUUtilization', targetValue: 50 });
    setTraffic(env, 100, now);
    now = tick(env, now, 90);
    expect(inService(env)).toBe(2);
    const cpu = (t: number) => getMetricData(env, asgCpuMetric('webapp-asg'), { start: t - 1000, end: t, period: 60, stat: 'Average' }).pop()!.v;
    expect(cpu(now)).toBeLessThan(15);
    setTraffic(env, 1000, now);
    const spike = now + 5000;
    now = tick(env, now, 10);
    expect(cpu(spike)).toBeGreaterThan(75);
    expect(cpu(spike)).toBeLessThan(90);
    now = tick(env, now, 30);
    expect(getAsg(env, 'webapp-asg').desiredCapacity).toBe(4);
    expect(inService(env)).toBe(4);
    expect(cpu(now)).toBeGreaterThan(38);
    expect(cpu(now)).toBeLessThan(50);
    expect(getAsg(env, 'webapp-asg').activities.find((a) => a.description.startsWith('Setting desired capacity'))!.cause).toMatch(/TargetTracking-webapp-asg-AlarmHigh-.* triggered policy cpu50 changing the desired capacity from 2 to 4\.$/);
    // the history keeps the spike: the group's in-service count went 2 -> 4
    const counts = (stat: 'Minimum' | 'Maximum') => getMetricData(env, metricFor('AWS/AutoScaling', 'GroupInServiceInstances', 'webapp-asg'), { start: spike - 60_000, end: now, period: 60, stat }).map((d) => d.v);
    expect(Math.min(...counts('Minimum'))).toBe(2);
    expect(Math.max(...counts('Maximum'))).toBe(4);
    setTraffic(env, 100, now);
    now = tick(env, now, 70);
    expect(getAsg(env, 'webapp-asg').desiredCapacity).toBe(2); // never below the minimum
    tick(env, now, 5);
    expect(liveInstances(getAsg(env, 'webapp-asg')).length).toBe(2);
  });
});
