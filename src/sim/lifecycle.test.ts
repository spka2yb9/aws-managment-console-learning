import { describe, expect, it } from 'vitest';
import { createAutoScalingGroup, deleteAutoScalingGroup, getAsg, updateAutoScalingGroup } from './autoscaling';
import { iamUserActor, withActor } from './cloudtrail';
import { costLines } from './cost';
import { changeRecord, deleteCertificate } from './edge';
import { stopInstances } from './ec2';
import { createTargetGroup, deleteLoadBalancer } from './elb';
import { byName } from './env';
import { simulateHttp } from './http';
import { CLIENT_IP } from './network';
import { attachScp, createAccountAssignment, createScp, deletePermissionSet, deleteScp, detachScp } from './organizations';
import { accountEnv, asgEnv, costEnv, httpsEnv, ORG_ACCOUNTS, ORG_OUS, scpEnv, SHOP_DOMAIN, webAppEnv } from './scenarios';
import { advanceTime } from './time';
import type { AwsEnv } from './types';
import { createSubnet, createVpc, deleteSubnet, deleteVpc } from './vpc';

const tick = (env: AwsEnv, from: number, seconds: number) => {
  for (let t = from; t <= from + seconds * 1000; t += 1000) advanceTime(env, t);
  return from + seconds * 1000;
};

describe('VPC / subnet deletion', () => {
  it('a subnet with an instance is a DependencyViolation; an empty VPC goes with its route tables, NACLs, SGs and IGW', () => {
    const env = webAppEnv();
    const web1 = byName(env.subnets, 'private-subnet-1a')!.subnetId;
    expect(() => deleteSubnet(env, web1)).toThrow(`The subnet '${web1}' has dependencies and cannot be deleted.`);
    const vpc = byName(env.vpcs, 'webapp-vpc')!.vpcId;
    expect(() => deleteVpc(env, vpc)).toThrow(/has dependencies/);

    const empty = accountEnv();
    const v = createVpc(empty, { cidrBlock: '10.9.0.0/16', name: 'mistake-vpc' });
    const s = createSubnet(empty, { vpcId: v, cidrBlock: '10.9.1.0/24', availabilityZone: 'ap-northeast-1a' });
    deleteSubnet(empty, s);
    expect(empty.subnets.some((x) => x.subnetId === s)).toBe(false);
    expect(empty.networkAcls.some((n) => n.associations.some((a) => a.subnetId === s))).toBe(false);
    createSubnet(empty, { vpcId: v, cidrBlock: '10.9.1.0/24', availabilityZone: 'ap-northeast-1a' }); // the range is free again
    withActor(iamUserActor(empty, 'learner', CLIENT_IP), Date.now(), () => deleteVpc(empty, v));
    expect([empty.vpcs, empty.subnets, empty.routeTables, empty.networkAcls, empty.securityGroups].map((l) => (l as { vpcId: string }[]).filter((x) => x.vpcId === v).length)).toEqual([0, 0, 0, 0, 0]);
    expect(empty.trailEvents.map((e) => e.eventName)).toEqual(expect.arrayContaining(['DeleteSubnet', 'DeleteRouteTable', 'DeleteNetworkAcl', 'DeleteSecurityGroup', 'DeleteVpc']));
  });
});

describe('Auto Scaling edit / delete', () => {
  it('attaching a target group registers the running instances; deleting the group terminates them', () => {
    const env = asgEnv();
    let now = Date.now();
    const subnets = ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId);
    createAutoScalingGroup(env, { name: 'webapp-asg', launchTemplateId: env.launchTemplates[0].launchTemplateId, minSize: 2, maxSize: 4, desiredCapacity: 2, subnetIds: [subnets[0]], targetGroupArns: [], healthCheckType: 'EC2' }, now);
    now = tick(env, now, 10);
    const tg = env.targetGroups[0];
    expect(tg.targets).toHaveLength(0);
    updateAutoScalingGroup(env, 'webapp-asg', { subnetIds: subnets, targetGroupArns: [tg.targetGroupArn], healthCheckType: 'ELB', healthCheckGracePeriod: 60 }, now);
    const g = getAsg(env, 'webapp-asg');
    expect([g.subnetIds, g.healthCheckType, g.healthCheckGracePeriod]).toEqual([subnets, 'ELB', 60]);
    expect(env.targetGroups[0].targets.map((t) => t.id).sort()).toEqual(g.instances.map((r) => r.instanceId).sort());
    expect(() => updateAutoScalingGroup(env, 'webapp-asg', { subnetIds: [] })).toThrow(/At least one subnet/);
    const other = createTargetGroup(env, { name: 'other-tg', port: 80, vpcId: byName(env.vpcs, 'webapp-vpc')!.vpcId });
    updateAutoScalingGroup(env, 'webapp-asg', { targetGroupArns: [other] }, now);
    expect(env.targetGroups[0].targets).toHaveLength(0);
    const ids = g.instances.map((r) => r.instanceId);
    deleteAutoScalingGroup(env, 'webapp-asg', now);
    expect(env.autoScalingGroups).toHaveLength(0);
    tick(env, now, 10);
    expect(env.instances.filter((i) => ids.includes(i.instanceId)).map((i) => i.state)).toEqual(['terminated', 'terminated']);
  });
});

describe('deleting edge / ALB / org resources', () => {
  it('ALB delete: the DNS name stops answering, the target group stays', () => {
    const env = webAppEnv();
    const lb = env.loadBalancers[0];
    deleteLoadBalancer(env, lb.loadBalancerArn);
    expect(env.loadBalancers).toHaveLength(0);
    expect(env.targetGroups).toHaveLength(1);
    expect(simulateHttp(env, `http://${lb.dnsName}/`).error).toBeDefined();
  });

  it('a certificate in use by CloudFront cannot be deleted; a record can be upserted in place', () => {
    const env = httpsEnv();
    expect(() => deleteCertificate(env, env.distributions[0].certificateArn!)).toThrow(/in use by/);
    const zone = env.hostedZones[0].id;
    changeRecord(env, zone, 'CREATE', { name: `test.${SHOP_DOMAIN}`, type: 'A', ttl: 60, values: ['192.0.2.1'] });
    changeRecord(env, zone, 'UPSERT', { name: `test.${SHOP_DOMAIN}`, type: 'A', ttl: 300, values: ['192.0.2.2'] });
    expect(env.hostedZones[0].records.filter((r) => r.name === `test.${SHOP_DOMAIN}`)).toEqual([{ name: `test.${SHOP_DOMAIN}`, type: 'A', ttl: 300, values: ['192.0.2.2'] }]);
  });

  it('SCPs and permission sets can only be deleted once nothing uses them', () => {
    const env = scpEnv();
    const p = createScp(env, { name: 'tmp', document: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: 'ec2:*', Resource: '*' }] } });
    attachScp(env, p, ORG_OUS.development);
    expect(() => deleteScp(env, p)).toThrow(/detach it from all roots/);
    detachScp(env, p, ORG_OUS.development);
    deleteScp(env, p);
    expect(env.organization!.policies.some((x) => x.id === p)).toBe(false);
    expect(() => deleteScp(env, 'p-FullAWSAccess')).toThrow(/AWS managed/);
    const ro = env.identityCenter!.permissionSets.find((x) => x.name === 'ReadOnlyAccess')!;
    expect(() => deletePermissionSet(env, ro.arn)).toThrow(/Remove its account assignments/);
    const ps = env.identityCenter!.permissionSets.find((x) => x.name === 'PowerUserAccess')!;
    env.identityCenter!.assignments = env.identityCenter!.assignments.filter((a) => a.permissionSetArn !== ps.arn);
    deletePermissionSet(env, ps.arn);
    expect(() => createAccountAssignment(env, { accountId: ORG_ACCOUNTS.dev, permissionSetArn: ps.arn, principalType: 'GROUP', principalName: 'Developers' })).toThrow(/permission set does not exist/);
  });
});

describe('cost: data flows follow their sender', () => {
  it('stopping dev-batch stops its S3 transfer through the NAT gateway', () => {
    const env = costEnv();
    const nat = () => costLines(env).find((l) => l.resource.startsWith('データ処理: dev-batch'));
    expect(nat()!.usd).toBe(124);
    stopInstances(env, [byName(env.instances, 'dev-batch')!.instanceId]);
    expect(nat()).toBeUndefined();
    expect(costLines(env).find((l) => l.resource.startsWith('dev-batch → S3'))!.usage).toMatch(/停止中/);
  });
});
