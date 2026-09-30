import { describe, expect, it } from 'vitest';
import { registerTaskDefinition, getService, runningCount, serviceTasks, updateService, stopTask, getTaskDefinition } from './containers';
import { simulateHttp } from './http';
import { ecsEnv } from './scenarios';
import { targetHealth } from './elb';
import { advanceTime } from './time';
import type { AwsEnv } from './types';

const tick = (env: AwsEnv, from: number, seconds: number) => {
  for (let t = from; t <= from + seconds * 1000; t += 1000) advanceTime(env, t);
  return from + seconds * 1000;
};
const revision = (env: AwsEnv, tag: string) => {
  const td = getTaskDefinition(env, 'webapp:1');
  return registerTaskDefinition(env, { ...td, containerDefinitions: [{ ...td.containerDefinitions[0], image: td.containerDefinitions[0].image.replace(/:[^:]+$/, `:${tag}`) }] });
};

describe('ECS on Fargate', () => {
  it('the service runs 2 tasks registered as ip targets; the ALB serves the image version', () => {
    const env = ecsEnv();
    const s = getService(env, 'webapp-cluster', 'webapp-svc');
    expect(runningCount(env, s)).toBe(2);
    const tg = env.targetGroups[0];
    expect(tg.targetType).toBe('ip');
    expect(tg.targets.map((t) => targetHealth(env, tg.targetGroupArn, t).state)).toEqual(['healthy', 'healthy']);
    const r = simulateHttp(env, `http://${env.loadBalancers[0].dnsName}/`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('webapp v1');
    expect(s.events[0].message).toBe('(service webapp-svc) has reached a steady state.');
  });

  it('a wrong image tag: new tasks stop with CannotPullContainerError, the old ones keep serving; the right tag rolls out', () => {
    const env = ecsEnv();
    let now = Date.now();
    updateService(env, 'webapp-cluster', 'webapp-svc', { taskDefinition: revision(env, 'v2') }, now);
    now = tick(env, now, 6);
    const s = getService(env, 'webapp-cluster', 'webapp-svc');
    const stopped = serviceTasks(env, s).filter((t) => t.lastStatus === 'STOPPED' || t.lastStatus === 'DEPROVISIONING');
    expect(stopped.length).toBeGreaterThan(0);
    expect(stopped[0].stopCode).toBe('TaskFailedToStart');
    expect(stopped[0].stoppedReason).toMatch(/^CannotPullContainerError: .*webapp:v2: not found$/);
    expect(s.events.map((e) => e.message)).toContain('(service webapp-svc) is unable to consistently start tasks successfully. For more information, see the Troubleshooting section of the Amazon ECS Developer Guide.');
    expect(runningCount(env, s)).toBe(2); // v1 still serving: no downtime
    expect(simulateHttp(env, `http://${env.loadBalancers[0].dnsName}/`).body).toContain('webapp v1');
    updateService(env, 'webapp-cluster', 'webapp-svc', { taskDefinition: revision(env, 'v2.0') }, now);
    now = tick(env, now, 15);
    const after = getService(env, 'webapp-cluster', 'webapp-svc');
    expect(after.deployments).toHaveLength(1);
    expect(after.deployments[0].rolloutState).toBe('COMPLETED');
    const running = serviceTasks(env, after).filter((t) => t.lastStatus === 'RUNNING');
    expect(running.map((t) => t.taskDefinitionArn.split(':').pop())).toEqual(['3', '3']);
    expect(env.targetGroups[0].targets).toHaveLength(2);
    expect(simulateHttp(env, `http://${env.loadBalancers[0].dnsName}/`).body).toContain('webapp v2.0');
    // a stopped task is replaced by the scheduler
    stopTask(env, running[0].taskArn, 'test', now);
    tick(env, now, 10);
    expect(runningCount(env, getService(env, 'webapp-cluster', 'webapp-svc'))).toBe(2);
  });
});
