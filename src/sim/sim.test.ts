import { cidrContains, cidrOverlaps, isValidCidr } from './cidr';
import { advanceInstances, runInstances, startInstances, stopInstances, TRANSITION_MS } from './ec2';
import { deregisterTargets, modifyTargetGroupHealthCheck, parseMatcher, registerTargets, targetHealth } from './elb';
import { byName, emptyEnv, getSg } from './env';
import { simulateHttp } from './http';
import { canConnect, canConnectFromInternet } from './network';
import { createDbSubnetGroup } from './rds';
import { webAppEnv } from './scenarios';
import { createSecurityGroup, evaluateSecurityGroup, setSecurityGroupRules } from './sg';
import type { AwsEnv } from './types';
import { attachInternetGateway, createInternetGateway, createRouteTable, createSubnet, createVpc, detachInternetGateway, evaluateRoute, isPublicSubnet, replaceRoutes, setSubnetAssociations } from './vpc';

const sg = (env: AwsEnv, name: string) => byName(env.securityGroups, name)!;
const inst = (env: AwsEnv, name: string) => byName(env.instances, name)!;
const alb = (env: AwsEnv) => env.loadBalancers[0];
const tg = (env: AwsEnv) => env.targetGroups[0];

describe('CIDR', () => {
  it('validates strictly', () => {
    expect(isValidCidr('10.0.0.0/16')).toBe(true);
    expect(isValidCidr('10.0.0.1/16')).toBe(false); // host bits set
    expect(isValidCidr('10.0.0.0/33')).toBe(false);
    expect(isValidCidr('10.0.0/16')).toBe(false);
    expect(isValidCidr('010.0.0.0/16')).toBe(false);
  });
  it('contains / overlaps', () => {
    expect(cidrContains('10.0.0.0/16', '10.0.1.0/24')).toBe(true);
    expect(cidrContains('10.0.0.0/16', '10.1.0.0/24')).toBe(false);
    expect(cidrOverlaps('10.0.0.0/24', '10.0.0.128/25')).toBe(true);
    expect(cidrOverlaps('10.0.0.0/25', '10.0.0.128/25')).toBe(false);
  });
});

describe('VPC / Subnet / Route table', () => {
  function vpcWithSubnet() {
    const env = emptyEnv();
    const vpcId = createVpc(env, { cidrBlock: '10.0.0.0/16', name: 'v' });
    const subnetId = createSubnet(env, { vpcId, cidrBlock: '10.0.1.0/24', availabilityZone: 'ap-northeast-1a', name: 's' });
    return { env, vpcId, subnetId };
  }

  it('rejects subnets outside the VPC, overlapping, or with bad size', () => {
    const { env, vpcId } = vpcWithSubnet();
    expect(() => createSubnet(env, { vpcId, cidrBlock: '10.1.0.0/24', availabilityZone: 'ap-northeast-1a' })).toThrow(/is invalid/);
    expect(() => createSubnet(env, { vpcId, cidrBlock: '10.0.1.128/25', availabilityZone: 'ap-northeast-1a' })).toThrow(/conflicts/);
    expect(() => createSubnet(env, { vpcId, cidrBlock: '10.0.2.0/28', availabilityZone: 'ap-northeast-1b' })).toThrow(/availabilityZone/);
    expect(() => createVpc(env, { cidrBlock: '10.0.0.0/8' })).toThrow(/is invalid/);
  });

  it('turns a private subnet public only through routing (Phase 3)', () => {
    const { env, vpcId, subnetId } = vpcWithSubnet();
    const rt = createRouteTable(env, { vpcId, name: 'rt' });
    setSubnetAssociations(env, rt, [subnetId]);
    const igw = createInternetGateway(env, { name: 'igw' });
    expect(isPublicSubnet(env, subnetId)).toBe(false);
    // Route to a detached IGW is refused
    expect(() => replaceRoutes(env, rt, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }])).toThrow(/different networks/);
    attachInternetGateway(env, igw, vpcId);
    replaceRoutes(env, rt, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }]);
    expect(isPublicSubnet(env, subnetId)).toBe(true);
    expect(evaluateRoute(env, rt, '8.8.8.8')?.target).toEqual({ type: 'internet-gateway', id: igw });
    expect(evaluateRoute(env, rt, '10.0.5.5')?.target.type).toBe('local'); // longest prefix wins
    detachInternetGateway(env, igw, vpcId);
    expect(evaluateRoute(env, rt, '8.8.8.8')?.state).toBe('blackhole');
    expect(isPublicSubnet(env, subnetId)).toBe(false);
  });

  it('refuses a route more specific than the VPC CIDR to an IGW, and duplicates', () => {
    const { env, vpcId } = vpcWithSubnet();
    const rt = createRouteTable(env, { vpcId });
    const igw = createInternetGateway(env, {});
    attachInternetGateway(env, igw, vpcId);
    expect(() => replaceRoutes(env, rt, [{ destinationCidrBlock: '10.0.1.0/24', gatewayId: igw }])).toThrow(/more specific/);
    expect(() => replaceRoutes(env, rt, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }, { destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }])).toThrow(/already exists/);
  });

  it('scenario: public subnets are public, private are not', () => {
    const env = webAppEnv();
    expect(isPublicSubnet(env, byName(env.subnets, 'public-subnet-1a')!.subnetId)).toBe(true);
    expect(isPublicSubnet(env, byName(env.subnets, 'private-subnet-1a')!.subnetId)).toBe(false);
  });

  it('scenarios are deterministic', () => {
    expect(webAppEnv().vpcs.map((v) => v.vpcId)).toEqual(webAppEnv().vpcs.map((v) => v.vpcId));
  });
});

describe('Security Group (Phase 4)', () => {
  it('TCP 3000 from sg-alb is allowed, TCP 3001 is not', () => {
    const env = webAppEnv();
    const web = sg(env, 'web-sg');
    const albSg = sg(env, 'alb-sg');
    const packet = { protocol: 'tcp' as const, peerIp: '10.0.1.10', peerGroupIds: [albSg.groupId] };
    expect(evaluateSecurityGroup(env, [web.groupId], 'ingress', { ...packet, port: 3000 }).allowed).toBe(true);
    expect(evaluateSecurityGroup(env, [web.groupId], 'ingress', { ...packet, port: 3001 }).allowed).toBe(false);
    expect(evaluateSecurityGroup(env, [web.groupId], 'ingress', { ...packet, port: 3000, peerGroupIds: [] }).allowed).toBe(false);
    expect(canConnect(env, alb(env).loadBalancerArn, inst(env, 'web-1').instanceId, 'tcp', 3000).ok).toBe(true);
    expect(canConnect(env, alb(env).loadBalancerArn, inst(env, 'web-1').instanceId, 'tcp', 3001).ok).toBe(false);
  });

  it('outbound rules matter too', () => {
    const env = webAppEnv();
    setSecurityGroupRules(env, sg(env, 'alb-sg').groupId, 'egress', []);
    const c = canConnect(env, alb(env).loadBalancerArn, inst(env, 'web-1').instanceId, 'tcp', 3000);
    expect(c.ok).toBe(false);
    expect(c.checks.find((x) => !x.ok)?.label).toMatch(/アウトバウンドルール/);
  });

  it('validates rules like AWS', () => {
    const env = webAppEnv();
    const id = sg(env, 'web-sg').groupId;
    expect(() => setSecurityGroupRules(env, id, 'ingress', [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0' }, { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0' }])).toThrow(/already exists/);
    expect(() => setSecurityGroupRules(env, id, 'ingress', [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '10.0.0.1/16' }])).toThrow(/malformed/);
    expect(() => setSecurityGroupRules(env, id, 'ingress', [{ ipProtocol: 'tcp', fromPort: 90, toPort: 80, source: '0.0.0.0/0' }])).toThrow(/port range/);
    expect(() => setSecurityGroupRules(env, id, 'ingress', [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: 'sg-00000000000000000' }])).toThrow(/does not exist/);
    expect(() => createSecurityGroup(env, { groupName: 'web-sg', description: 'x', vpcId: sg(env, 'web-sg').vpcId })).toThrow(/already exists/);
  });

  it('keeps rule ids of unchanged rules and reports revoke/authorize', () => {
    const env = webAppEnv();
    const g = sg(env, 'alb-sg');
    const before = g.ingress[0].securityGroupRuleId;
    const res = setSecurityGroupRules(env, g.groupId, 'ingress', [
      { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0', securityGroupRuleId: before },
      { ipProtocol: 'tcp', fromPort: 443, toPort: 443, source: '0.0.0.0/0' },
    ]);
    expect(getSg(env, g.groupId).ingress[0].securityGroupRuleId).toBe(before);
    expect(res.authorized).toHaveLength(1);
    expect(res.revoked).toHaveLength(0);
  });
});

describe('EC2 (Phase 5)', () => {
  it('pending -> running -> stopping -> stopped, public IP only while running', () => {
    const env = webAppEnv({ upTo: 'security-groups' });
    const t = 1_000_000;
    const [id] = runInstances(env, { imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', subnetId: byName(env.subnets, 'public-subnet-1a')!.subnetId, securityGroupIds: [sg(env, 'web-sg').groupId] }, t);
    const i = () => env.instances.find((x) => x.instanceId === id)!;
    expect(i().state).toBe('pending');
    advanceInstances(env, t + TRANSITION_MS);
    expect(i().state).toBe('running');
    expect(i().publicIpAddress).toMatch(/^203\.0\.113\./);
    stopInstances(env, [id], t + 10_000);
    expect(i().state).toBe('stopping');
    advanceInstances(env, t + 20_000);
    expect(i().state).toBe('stopped');
    expect(i().publicIpAddress).toBeUndefined();
    startInstances(env, [id], t + 30_000);
    expect(i().state).toBe('pending');
  });

  it('refuses a security group from another VPC', () => {
    const env = webAppEnv({ upTo: 'security-groups' });
    const defaultSg = env.securityGroups.find((g) => g.groupName === 'default' && g.vpcId === env.vpcs[0].vpcId)!;
    expect(() => runInstances(env, { imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', subnetId: byName(env.subnets, 'public-subnet-1a')!.subnetId, securityGroupIds: [defaultSg.groupId] })).toThrow(/different networks/);
  });
});

describe('ALB / Target group health (Phase 6)', () => {
  it('healthy in the reference architecture', () => {
    const env = webAppEnv();
    expect(tg(env).targets.map((t) => targetHealth(env, tg(env).targetGroupArn, t).state)).toEqual(['healthy', 'healthy']);
  });

  it('SG blocks ALB -> Target.Timeout', () => {
    const env = webAppEnv({}, (e) => setSecurityGroupRules(e, sg(e, 'web-sg').groupId, 'ingress', []));
    expect(targetHealth(env, tg(env).targetGroupArn, tg(env).targets[0])).toMatchObject({ state: 'unhealthy', reason: 'Target.Timeout' });
  });

  it('wrong health check path -> ResponseCodeMismatch [404]; matcher can accept it', () => {
    const env = webAppEnv();
    modifyTargetGroupHealthCheck(env, tg(env).targetGroupArn, { ...tg(env).healthCheck, path: '/healthz' });
    expect(targetHealth(env, tg(env).targetGroupArn, tg(env).targets[0])).toMatchObject({ reason: 'Target.ResponseCodeMismatch', description: 'Health checks failed with these codes: [404]' });
    modifyTargetGroupHealthCheck(env, tg(env).targetGroupArn, { ...tg(env).healthCheck, matcher: '200-404' });
    expect(targetHealth(env, tg(env).targetGroupArn, tg(env).targets[0]).state).toBe('healthy');
    expect(parseMatcher('600')).toBeNull();
  });

  it('target port without a listening app -> FailedHealthChecks; stopped -> unused', () => {
    const env = webAppEnv();
    const t0 = tg(env).targets[0];
    deregisterTargets(env, tg(env).targetGroupArn, [t0]);
    registerTargets(env, tg(env).targetGroupArn, [{ id: t0.id, port: 80 }]);
    setSecurityGroupRules(env, sg(env, 'web-sg').groupId, 'ingress', [{ ipProtocol: 'tcp', fromPort: 80, toPort: 3000, source: sg(env, 'alb-sg').groupId }]);
    expect(targetHealth(env, tg(env).targetGroupArn, { id: t0.id, port: 80 })).toMatchObject({ state: 'unhealthy', reason: 'Target.FailedHealthChecks' });
    stopInstances(env, [t0.id]);
    expect(targetHealth(env, tg(env).targetGroupArn, { id: t0.id, port: 80 })).toMatchObject({ state: 'unused', reason: 'Target.InvalidState' });
  });

  it('target group without a load balancer -> unused', () => {
    const env = webAppEnv({ upTo: 'target-group' });
    expect(targetHealth(env, tg(env).targetGroupArn, tg(env).targets[0]).reason).toBe('Target.NotInUse');
  });
});

describe('HTTP through Internet -> ALB -> EC2 -> RDS (Phase 6/7)', () => {
  const get = (env: AwsEnv, path = '/') => simulateHttp(env, `http://${alb(env).dnsName}${path}`);

  it('200 when everything is connected', () => {
    const r = get(webAppEnv());
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/Database: connected/);
    expect(r.hops.every((h) => h.ok)).toBe(true);
  });

  it('503 without targets, 504 when the SG blocks, 502 when nothing listens', () => {
    expect(get(webAppEnv({ registerTargets: false })).status).toBe(503);
    expect(get(webAppEnv({}, (e) => setSecurityGroupRules(e, sg(e, 'web-sg').groupId, 'ingress', []))).status).toBe(504);
    const env = webAppEnv({}, (e) => {
      const ids = e.targetGroups[0].targets.map((t) => t.id);
      deregisterTargets(e, e.targetGroups[0].targetGroupArn, e.targetGroups[0].targets);
      registerTargets(e, e.targetGroups[0].targetGroupArn, ids.map((id) => ({ id, port: 80 })));
      setSecurityGroupRules(e, sg(e, 'web-sg').groupId, 'ingress', [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: sg(e, 'alb-sg').groupId }]);
    });
    expect(get(env).status).toBe(502);
  });

  it('fail-open: all targets unhealthy by path mismatch still serve 200', () => {
    const env = webAppEnv({}, (e) => modifyTargetGroupHealthCheck(e, e.targetGroups[0].targetGroupArn, { ...e.targetGroups[0].healthCheck, path: '/healthz' }));
    expect(get(env).status).toBe(200);
  });

  it('500 when EC2 cannot reach RDS on 3306', () => {
    const env = webAppEnv({}, (e) => setSecurityGroupRules(e, sg(e, 'db-sg').groupId, 'ingress', [{ ipProtocol: 'tcp', fromPort: 3306, toPort: 3306, source: '10.0.1.0/24' }]));
    expect(canConnect(env, inst(env, 'web-1').instanceId, 'webapp-db', 'tcp', 3306).ok).toBe(false);
    expect(get(env).status).toBe(500);
    setSecurityGroupRules(env, sg(env, 'db-sg').groupId, 'ingress', [{ ipProtocol: 'tcp', fromPort: 3306, toPort: 3306, source: sg(env, 'web-sg').groupId }]);
    expect(canConnect(env, inst(env, 'web-1').instanceId, 'webapp-db', 'tcp', 3306).ok).toBe(true);
    expect(get(env).status).toBe(200);
  });

  it('timeout when the ALB SG blocks the internet; RDS is not reachable from the internet', () => {
    const env = webAppEnv({}, (e) => setSecurityGroupRules(e, sg(e, 'alb-sg').groupId, 'ingress', []));
    expect(get(env).error).toBe('ERR_CONNECTION_TIMED_OUT');
    expect(canConnectFromInternet(env, 'webapp-db', 'tcp', 3306).ok).toBe(false);
    expect(simulateHttp(env, 'http://example.invalid').error).toBe('ERR_NAME_NOT_RESOLVED');
  });

  it('health check path works without the DB', () => {
    const env = webAppEnv({}, (e) => setSecurityGroupRules(e, sg(e, 'db-sg').groupId, 'ingress', []));
    expect(get(env, '/health').status).toBe(200);
  });
});

describe('RDS (Phase 7)', () => {
  it('subnet group needs two AZs', () => {
    const env = webAppEnv({ upTo: 'subnets' });
    const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
    expect(() => createDbSubnetGroup(env, { name: 'g', description: 'd', vpcId, subnetIds: [byName(env.subnets, 'private-subnet-1a')!.subnetId] })).toThrow(/at least 2 AZs/);
  });
  it('DB ends up available in a private subnet', () => {
    const env = webAppEnv();
    expect(env.dbInstances[0]).toMatchObject({ status: 'available', publiclyAccessible: false, port: 3306 });
  });
});
