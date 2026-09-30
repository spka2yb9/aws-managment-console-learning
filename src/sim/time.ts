import { advanceAutoScaling } from './autoscaling';
import { advanceEcs } from './containers';
import { advanceServerless } from './serverless';
import { advanceBatch, advanceEvents } from './batch';
import { advanceEdge } from './edge';
import { advanceInstances } from './ec2';
import { advanceLoadBalancers } from './elb';
import { advanceDbInstances, advanceDbSnapshots } from './rds';
import type { AwsEnv } from './types';
import { advanceNatGateways } from './vpc';

/** Is anything in a transitional state (pending, provisioning, creating...)? */
export function hasTransitions(env: AwsEnv): boolean {
  return (
    env.instances.some((i) => ['pending', 'stopping', 'shutting-down'].includes(i.state)) ||
    env.loadBalancers.some((l) => l.state === 'provisioning') ||
    env.dbInstances.some((d) => !['available', 'stopped'].includes(d.status)) ||
    env.dbSnapshots.some((s) => s.status === 'creating') ||
    // Auto Scaling watches its instances and metrics all the time
    (env.autoScalingGroups ?? []).length > 0 ||
    (env.ecsServices ?? []).length > 0 ||
    (env.ecsTasks ?? []).some((t) => t.lastStatus !== 'STOPPED' && t.lastStatus !== 'RUNNING') ||
    (env.eventSourceMappings ?? []).some((m) => m.enabled) ||
    (env.eventRules ?? []).some((r) => r.state === 'ENABLED') ||
    (env.batchJobs ?? []).some((j) => j.status !== 'SUCCEEDED' && j.status !== 'FAILED') ||
    (env.certificates ?? []).some((c) => c.status === 'PENDING_VALIDATION') ||
    (env.distributions ?? []).some((d) => d.status === 'InProgress' || d.invalidations.some((i) => i.status === 'InProgress')) ||
    (env.natGateways ?? []).some((n) => n.state === 'pending' || n.state === 'deleting')
  );
}

/** Move every resource forward to `now` (Infinity = settle everything, used when building scenarios). */
export function advanceTime(env: AwsEnv, now: number): boolean {
  let changed = false;
  // Each advance* finishes one transition per resource, so repeat until nothing moves (creating -> backing-up -> available).
  while ([advanceInstances(env, now), advanceLoadBalancers(env, now), advanceDbInstances(env, now), advanceDbSnapshots(env, now), advanceAutoScaling(env, now), advanceEcs(env, now), advanceServerless(env, now), advanceEvents(env, now), advanceBatch(env, now), advanceEdge(env, now), advanceNatGateways(env, now)].some(Boolean)) changed = true;
  return changed;
}
