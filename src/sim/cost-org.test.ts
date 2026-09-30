import { describe, expect, it } from 'vitest';
import { filterLogEvents, putRetentionPolicy } from './cloudwatch';
import { costLines, totalOf } from './cost';
import { byName } from './env';
import { attachScp, createAccountAssignment, createPermissionSet, createScp, deleteAccountAssignment, detachScp, evaluateScp, FULL_AWS_ACCESS, moveAccount, portalAccess, testAccess } from './organizations';
import { modifyDbInstance } from './rds';
import { costEnv, ORG_ACCOUNTS, ORG_OUS, scpEnv, ssoEnv } from './scenarios';
import { advanceTime } from './time';
import type { AwsEnv } from './types';
import { createVpcEndpoint, deleteNatGateway, evaluateRoute, replaceRoutes, routeState } from './vpc';

const line = (env: AwsEnv, re: RegExp) => costLines(env).filter((l) => re.test(l.resource));
const rt = (env: AwsEnv, name: string) => byName(env.routeTables, name)!;
const nat = (env: AwsEnv, name: string) => byName(env.natGateways, name)!;

describe('cost', () => {
  it('Multi-AZ doubles the DB; a gateway endpoint takes S3 off the NAT; one NAT for dev adds cross-AZ transfer', () => {
    const env = costEnv();
    const before = totalOf(costLines(env));
    expect(before).toBeGreaterThan(1300);
    const db = line(env, /^dev-db$/)[0].usd;
    modifyDbInstance(env, 'dev-db', { multiAZ: false, backupRetentionPeriod: 7 });
    expect(line(env, /^dev-db$/)[0].usd).toBeCloseTo(db / 2, 0);
    expect(() => modifyDbInstance(env, 'webapp-db', { backupRetentionPeriod: 40 })).toThrow(/0 to 35/);

    // S3 through the gateway endpoint: no NAT processing
    expect(line(env, /データ処理: dev-batch/)[0].usd).toBe(124);
    createVpcEndpoint(env, { vpcId: byName(env.vpcs, 'dev-vpc')!.vpcId, serviceName: 'com.amazonaws.ap-northeast-1.s3', routeTableIds: ['dev-private-rt-1a', 'dev-private-rt-1c', 'dev-private-rt-1d'].map((n) => rt(env, n).routeTableId) });
    expect(line(env, /データ処理: dev-batch/)).toHaveLength(0);
    expect(line(env, /^dev-batch → S3/)[0].usage).toMatch(/ゲートウェイエンドポイント/);

    // deleting a NAT that is still routed to breaks the subnet's egress
    const n1c = nat(env, 'dev-nat-1c').natGatewayId;
    deleteNatGateway(env, n1c);
    advanceTime(env, Date.now() + 10_000);
    expect(routeState(env, rt(env, 'dev-private-rt-1c'), rt(env, 'dev-private-rt-1c').routes[1])).toBe('blackhole');
    expect(costLines(env).some((l) => l.broken)).toBe(false); // S3 goes via the endpoint; 1c has no internet flow
    const n1a = nat(env, 'dev-nat-1a').natGatewayId;
    replaceRoutes(env, rt(env, 'dev-private-rt-1c').routeTableId, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: n1a }]);
    expect(rt(env, 'dev-private-rt-1c').routes.some((r) => r.destinationPrefixListId)).toBe(true); // the endpoint route survives the edit
    expect(evaluateRoute(env, rt(env, 'dev-private-rt-1c').routeTableId, '8.8.8.8')?.target).toEqual({ type: 'nat-gateway', id: n1a });
    env.dataFlows.push({ name: 'dev-private-1c → インターネット', subnetId: byName(env.subnets, 'dev-private-1c')!.subnetId, destination: 'internet', gbPerMonth: 10 });
    expect(line(env, /^AZ 間: dev-private-1c/)[0].usd).toBeCloseTo(0.2, 2);
    deleteNatGateway(env, n1a);
    advanceTime(env, Date.now() + 20_000);
    expect(costLines(env).filter((l) => l.broken).map((l) => l.resource)).toEqual(['dev-web-1 → インターネット (パッケージ更新・外部 API)', 'dev-private-1c → インターネット']);
  });

  it('log retention: storage follows the retention period, and old events disappear', () => {
    const env = costEnv();
    const debug = line(env, /^\/webapp\/dev\/debug$/)[0].usd;
    putRetentionPolicy(env, '/webapp/dev/debug', 7);
    expect(line(env, /^\/webapp\/dev\/debug$/)[0].usd).toBeLessThan(debug - 60);
    expect(() => putRetentionPolicy(env, '/webapp/dev/debug', 8)).toThrow(/enum value set/);
    const g = env.logGroups.find((x) => x.logGroupName === '/webapp/app')!;
    const now = Date.now();
    expect(filterLogEvents(env, g, { start: now - 2 * 86_400_000, end: now, limit: 1 }).length).toBe(1);
    putRetentionPolicy(env, '/webapp/app', 1);
    expect(filterLogEvents(env, g, { start: now - 2 * 86_400_000, end: now - 1.5 * 86_400_000 }).length).toBe(0);
  });
});

describe('Organizations / SCP', () => {
  it('a root-level account misses OU guardrails; SCPs deny but never grant; the management account is exempt', () => {
    const env = scpEnv();
    const ctx = { 'aws:RequestedRegion': 'ap-northeast-1' };
    expect(evaluateScp(env, ORG_ACCOUNTS.prod, 'rds:DeleteDBSnapshot', ctx).decision).toBe('Allow');
    moveAccount(env, ORG_ACCOUNTS.prod, ORG_OUS.production);
    const d = evaluateScp(env, ORG_ACCOUNTS.prod, 'rds:DeleteDBSnapshot', ctx);
    expect(d.decision).toBe('ExplicitDeny');
    expect(d.levels.map((l) => l.name)).toEqual(['Root', 'Production', 'webapp-prod']);
    const region = createScp(env, { name: 'dev-tokyo-only', document: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', NotAction: ['iam:*', 'organizations:*', 'sts:*'], Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': ['ap-northeast-1'] } } }] } });
    attachScp(env, region, ORG_OUS.development);
    expect(evaluateScp(env, ORG_ACCOUNTS.dev, 'ec2:RunInstances', { 'aws:RequestedRegion': 'us-east-1' }).decision).toBe('ExplicitDeny');
    expect(evaluateScp(env, ORG_ACCOUNTS.dev, 'ec2:RunInstances', ctx).decision).toBe('Allow');
    expect(evaluateScp(env, ORG_ACCOUNTS.dev, 'iam:CreateRole', { 'aws:RequestedRegion': 'us-east-1' }).decision).toBe('Allow');
    expect(evaluateScp(env, ORG_ACCOUNTS.staging, 'ec2:RunInstances', { 'aws:RequestedRegion': 'us-east-1' }).decision).toBe('Allow');
    expect(evaluateScp(env, ORG_ACCOUNTS.management, 'rds:DeleteDBSnapshot', ctx)).toMatchObject({ decision: 'Allow', exempt: true });
    // replacing FullAWSAccess on the OU with a narrow allow list: anything else is implicitly denied below it
    const ec2Only = createScp(env, { name: 'ec2-only', document: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 'ec2:*', Resource: '*' }] } });
    attachScp(env, ec2Only, ORG_OUS.staging);
    detachScp(env, FULL_AWS_ACCESS, ORG_OUS.staging);
    expect(evaluateScp(env, ORG_ACCOUNTS.staging, 's3:GetObject', ctx).decision).toBe('ImplicitDeny');
    expect(() => detachScp(env, ec2Only, ORG_OUS.staging)).toThrow(/last service control policy/);
    expect(() => createScp(env, { name: 'bad', document: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: '*', Resource: '*' }] } })).toThrow(/Principal/);
  });

  it('Identity Center: access = permission set AND SCPs; assignments decide what the portal shows', () => {
    const env = ssoEnv();
    expect(portalAccess(env, 'node').map((a) => `${a.accountId}:${a.permissionSet.name}`)).toEqual([`${ORG_ACCOUNTS.prod}:AdministratorAccess`, `${ORG_ACCOUNTS.staging}:AdministratorAccess`, `${ORG_ACCOUNTS.dev}:AdministratorAccess`]);
    const base = { userName: 'node', accountId: ORG_ACCOUNTS.prod, region: 'ap-northeast-1' };
    // prod-guardrails already protects the data, even for administrators
    const del = testAccess(env, { ...base, permissionSetName: 'AdministratorAccess', action: 'rds:DeleteDBInstance' });
    expect(del.allowed).toBe(false);
    expect(del.error).toMatch(/^User: arn:aws:sts::333333333333:assumed-role\/AWSReservedSSO_AdministratorAccess_[a-z0-9]{16}\/node is not authorized to perform: rds:DeleteDBInstance on resource: \* with an explicit deny in a service control policy$/);
    expect(testAccess(env, { ...base, permissionSetName: 'AdministratorAccess', action: 'ec2:TerminateInstances' }).allowed).toBe(true);
    const ro = createPermissionSet(env, { name: 'ReadOnlyAccess', managedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] });
    const admin = env.identityCenter!.permissionSets.find((p) => p.name === 'AdministratorAccess')!.arn;
    createAccountAssignment(env, { accountId: ORG_ACCOUNTS.prod, permissionSetArn: ro, principalType: 'GROUP', principalName: 'Developers' });
    deleteAccountAssignment(env, { accountId: ORG_ACCOUNTS.prod, permissionSetArn: admin, principalType: 'GROUP', principalName: 'Developers' });
    expect(testAccess(env, { ...base, permissionSetName: 'AdministratorAccess', action: 'ec2:TerminateInstances' }).error).toMatch(/割り当てがありません/);
    const term = testAccess(env, { ...base, permissionSetName: 'ReadOnlyAccess', action: 'ec2:TerminateInstances' });
    expect(term.error).toMatch(/because no identity-based policy allows the ec2:TerminateInstances action$/);
    expect(testAccess(env, { ...base, permissionSetName: 'ReadOnlyAccess', action: 'ec2:DescribeInstances' }).allowed).toBe(true);
    expect(() => createAccountAssignment(env, { accountId: ORG_ACCOUNTS.prod, permissionSetArn: ro, principalType: 'GROUP', principalName: 'Developers' })).toThrow(/already exists/);
    expect(() => createAccountAssignment(env, { accountId: ORG_ACCOUNTS.prod, permissionSetArn: ro, principalType: 'GROUP', principalName: 'Nobody' })).toThrow(/does not exist/);
  });
});
