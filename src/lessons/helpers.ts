import type { CommandRecord } from '../console/store';
import type { TaskContext } from '../lesson/types';
import { byName } from '../sim/env';
import { canConnect, CLIENT_IP } from '../sim/network';
import { targetHealth } from '../sim/elb';
import { isPublicSubnet } from '../sim/vpc';
import { evaluateSecurityGroup } from '../sim/sg';
import type { AwsEnv } from '../sim/types';

/** Has the learner opened a console page matching this path (prefix or regexp)? */
export function visited(ctx: TaskContext, p: string | RegExp): boolean {
  return ctx.visited.some((v) => (typeof p === 'string' ? v.split('?')[0].startsWith(p) : p.test(v)));
}

export function copied(ctx: TaskContext, value: string | undefined): boolean {
  return !!value && ctx.copied.includes(value);
}

export const sgNamed = (env: AwsEnv, groupName: string) => env.securityGroups.find((g) => g.groupName === groupName);
export const subnetNamed = (env: AwsEnv, name: string) => byName(env.subnets, name);
export const instanceNamed = (env: AwsEnv, name: string) => byName(env.instances, name);
export const rtNamed = (env: AwsEnv, name: string) => byName(env.routeTables, name);

/** Does SG `groupName` let `peer` (the learner's PC, or a group) in on TCP `port`? */
export function sgAllows(env: AwsEnv, groupName: string, port: number, peer: { ip?: string; groupName?: string } = {}): boolean {
  const g = sgNamed(env, groupName);
  const peerGroup = peer.groupName ? sgNamed(env, peer.groupName) : undefined;
  if (!g) return false;
  return evaluateSecurityGroup(env, [g.groupId], 'ingress', { protocol: 'tcp', port, peerIp: peer.ip ?? CLIENT_IP, peerGroupIds: peerGroup ? [peerGroup.groupId] : [] }).allowed;
}

/** Last browser request whose URL host matches. */
export function lastRequestTo(ctx: TaskContext, host: string | undefined) {
  return host ? ctx.browser.find((r) => r.url.toLowerCase().includes(host.toLowerCase())) : undefined;
}

export const tgNamed = (env: AwsEnv, name: string) => env.targetGroups.find((t) => t.targetGroupName === name);
export const lbNamed = (env: AwsEnv, name: string) => env.loadBalancers.find((l) => l.loadBalancerName === name);
export const dbNamed = (env: AwsEnv, id: string) => env.dbInstances.find((d) => d.dbInstanceIdentifier === id);
export const vpcNamed = (env: AwsEnv, name: string) => byName(env.vpcs, name);

/** Every registered target of the group is healthy (and there is at least `min`). */
export function allTargetsHealthy(env: AwsEnv, tgName: string, min = 1): boolean {
  const tg = tgNamed(env, tgName);
  return !!tg && tg.targets.length >= min && tg.targets.every((t) => targetHealth(env, tg.targetGroupArn, t).state === 'healthy');
}

/** Most recent browser result for the load balancer (by name). */
export function lastAlbRequest(ctx: TaskContext, lbName = 'web-alb') {
  return lastRequestTo(ctx, lbNamed(ctx.env, lbName)?.dnsName);
}

export function connects(env: AwsEnv, from: string, to: string, port: number): boolean {
  return canConnect(env, from, to, 'tcp', port).ok;
}

/** ALB -> every web instance on the app port. */
export function albReachesWeb(env: AwsEnv, port = 3000): boolean {
  const lb = lbNamed(env, 'web-alb');
  const web = ['web-1', 'web-2'].map((n) => instanceNamed(env, n));
  return !!lb && web.every((i) => i && connects(env, lb.loadBalancerArn, i.instanceId, port));
}

/** every web instance -> webapp-db on 3306 */
export function webReachesDb(env: AwsEnv): boolean {
  const web = ['web-1', 'web-2'].map((n) => instanceNamed(env, n));
  return web.every((i) => i && connects(env, i.instanceId, 'webapp-db', 3306));
}

/** A path visited for a resource looked up by name, e.g. visitedResource(ctx, '/security-groups/', sgNamed(env,'web-sg')?.groupId) */
export function visitedId(ctx: TaskContext, prefix: string, id: string | undefined): boolean {
  return !!id && ctx.visited.some((v) => v.split('?')[0].includes(`${prefix}${id}`));
}

export function isSubnetPublic(env: AwsEnv, name: string): boolean {
  const s = subnetNamed(env, name);
  return !!s && isPublicSubnet(env, s.subnetId);
}

export const naclNamed = (env: AwsEnv, name: string) => byName(env.networkAcls, name);

/** The most recent terminal command on the named instance matching `re`. */
export function lastRun(ctx: TaskContext, instanceName: string, re: RegExp): CommandRecord | undefined {
  const id = instanceNamed(ctx.env, instanceName)?.instanceId;
  return [...ctx.commands].reverse().find((c) => c.instanceId === id && re.test(c.line));
}

export const bucketNamed = (env: AwsEnv, name: string) => env.buckets.find((b) => b.name === name);
export const roleNamed = (env: AwsEnv, name: string) => env.iamRoles.find((r) => r.roleName === name);

/** Was a page visited whose path starts with `base` and whose query parameters all match? */
export function visitedQuery(ctx: TaskContext, base: string, params: Record<string, string | RegExp>): boolean {
  return ctx.visited.some((v) => {
    const [p, q] = v.split('?');
    if (p !== base) return false;
    const sp = new URLSearchParams(q ?? '');
    return Object.entries(params).every(([k, want]) => {
      const got = sp.get(k);
      return got !== null && (typeof want === 'string' ? got === want : want.test(got));
    });
  });
}

export function alarmNamed(env: AwsEnv, name: string) {
  return env.alarms.find((a) => a.alarmName === name);
}
