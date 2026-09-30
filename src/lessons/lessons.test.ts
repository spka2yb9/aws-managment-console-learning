import type { ConsoleExerciseContent, Lesson, TaskContext } from '../lesson/types';
import { deregisterTargets, modifyTargetGroupHealthCheck, registerTargets } from '../sim/elb';
import { byName } from '../sim/env';
import { simulateHttp } from '../sim/http';
import { setSecurityGroupRules } from '../sim/sg';
import type { AwsEnv } from '../sim/types';
import { associateSubnetRouteTable, attachInternetGateway, createInternetGateway, replaceRoutes } from '../sim/vpc';
import { replaceNetworkAclEntries } from '../sim/nacl';
import { execCli } from '../sim/cli';
import { setInstanceProfile, updatePolicyDocument } from '../sim/iam';
import { objectUrl, putBucketPolicy, putPublicAccessBlock } from '../sim/s3';
import { PUBLIC_SITE_BUCKET, REPORTS_BUCKET } from '../sim/scenarios';
import type { PolicyStatement } from '../sim/types';
import { advanceTime } from '../sim/time';
import { encodeGraph, metricFor, putMetricAlarm } from '../sim/cloudwatch';
import { createDbSnapshot, modifyDbInstance, restoreDbInstanceFromSnapshot, restoreDbInstanceToPointInTime } from '../sim/rds';
import { iamUserActor, withActor } from '../sim/cloudtrail';
import { putConfigRule } from '../sim/config';
import { CLIENT_IP } from '../sim/network';
import { createAutoScalingGroup, putTargetTrackingPolicy, setTraffic } from '../sim/autoscaling';
import { getTaskDefinition, registerTaskDefinition, updateService } from '../sim/containers';
import { taskId } from '../sim/targets';
import { sendMessage, startMessageMoveTask, updateFunctionConfiguration } from '../sim/serverless';
import { putRule, setRuleState, submitJob } from '../sim/batch';
import { putInlinePolicy } from '../sim/iam';
import { ORDERS_BUCKET, REPORTS_BUCKET as REPORTS } from '../sim/scenarios';
import { BPA_ALL_ON } from '../sim/s3';
import { changeRecord, createInvalidation, createValidationRecords, recordWafSample, requestCertificate, storeInCache, updateDistribution, updateIpSet } from '../sim/edge';
import type { HttpResult } from '../sim/http';
import { SHOP_DOMAIN, STATIC_BUCKET } from '../sim/scenarios';
import { putRetentionPolicy } from '../sim/cloudwatch';
import { deleteDbSnapshot } from '../sim/rds';
import { createVpcEndpoint, deleteNatGateway } from '../sim/vpc';
import { attachScp, createAccountAssignment, createPermissionSet, createScp, deleteAccountAssignment, FULL_AWS_ACCESS, moveAccount } from '../sim/organizations';
import { ORG_ACCOUNTS, ORG_OUS } from '../sim/scenarios';
import { ALL_LESSONS, findLesson } from '.';
import { sgNamed } from './helpers';

const ctxOf = (env: AwsEnv, extra: Partial<TaskContext> = {}): TaskContext => ({ env, path: '', region: env.region, visited: [], copied: [], browser: [], commands: [], ...extra });
const exercises = (l: Lesson) => l.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');
const browse = (env: AwsEnv) => [simulateHttp(env, `http://${env.loadBalancers[0].dnsName}/`)];
const sgRule = (port: number, source: string) => ({ ipProtocol: 'tcp' as const, fromPort: port, toPort: port, source });

describe('lesson data', () => {
  it.each(ALL_LESSONS.map((l) => [l.number, l] as const))('%s builds its scenario and has well-formed steps', (_, lesson) => {
    const env = lesson.scenario();
    expect(env.vpcs.length).toBeGreaterThan(0);
    expect(lesson.steps.length).toBeGreaterThan(2);
    for (const s of lesson.steps) {
      if (s.type === 'dialogue') expect(s.lines.every((l) => l.text.trim() && (l.speaker === 'hakase' || l.speaker === 'node'))).toBe(true);
      if (s.type === 'quiz') expect(s.options[s.answer]).toBeDefined();
      if (s.type === 'exercise') expect(new Set(s.tasks.map((t) => t.id)).size).toBe(s.tasks.length);
      // the Hint box shows the current task's hint: an empty one is an empty box
      if (s.type === 'exercise') expect(s.tasks.filter((t) => !t.hint.trim()).map((t) => t.id)).toEqual([]);
    }
    // No exercise passes before the learner does anything (except pure navigation ones, which need visits).
    for (const ex of exercises(lesson)) expect(ex.validate(ctxOf(env, { region: lesson.startRegion ?? env.region })).ok).toBe(false);
  });

  it('lesson ids are unique', () => {
    expect(new Set(ALL_LESSONS.map((l) => l.id)).size).toBe(ALL_LESSONS.length);
  });
});

describe('lesson solutions pass validation', () => {
  it('06 Public subnet: 0.0.0.0/0 -> IGW makes public-subnet public', () => {
    const l = findLesson('public-private-subnet')!;
    const env = l.scenario();
    const ex = exercises(l)[1];
    expect(ex.validate(ctxOf(env)).ok).toBe(false);
    replaceRoutes(env, byName(env.routeTables, 'public-rt')!.routeTableId, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: byName(env.internetGateways, 'webapp-igw')!.internetGatewayId }]);
    expect(ex.validate(ctxOf(env)).ok).toBe(true);
  });

  it('07 Route table: moving private-subnet-1a back to main makes it private', () => {
    const l = findLesson('route-table')!;
    const env = l.scenario();
    const ex = exercises(l)[1];
    associateSubnetRouteTable(env, byName(env.subnets, 'private-subnet-1a')!.subnetId, byName(env.routeTables, 'private-rt')!.routeTableId);
    expect(ex.validate(ctxOf(env)).ok).toBe(true);
  });

  it('08 IGW: create, attach, route', () => {
    const l = findLesson('internet-gateway')!;
    const env = l.scenario();
    const igw = createInternetGateway(env, { name: 'webapp-igw' });
    attachInternetGateway(env, igw, byName(env.vpcs, 'webapp-vpc')!.vpcId);
    expect(exercises(l)[0].validate(ctxOf(env)).ok).toBe(true);
    replaceRoutes(env, byName(env.routeTables, 'public-rt')!.routeTableId, [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: igw }]);
    expect(exercises(l)[1].validate(ctxOf(env)).ok).toBe(true);
  });

  it('09 Security group: HTTP from anywhere, but not SSH from anywhere', () => {
    const l = findLesson('security-group')!;
    const env = l.scenario();
    const g = sgNamed(env, 'web-server-sg')!;
    const ex = exercises(l)[0];
    setSecurityGroupRules(env, g.groupId, 'ingress', [sgRule(22, '0.0.0.0/0'), sgRule(80, '0.0.0.0/0')]);
    expect(ex.validate(ctxOf(env)).ok).toBe(false);
    setSecurityGroupRules(env, g.groupId, 'ingress', [sgRule(22, '198.51.100.24/32'), sgRule(80, '0.0.0.0/0')]);
    expect(ex.validate(ctxOf(env)).ok).toBe(true);
    const ip = byName(env.instances, 'web-server')!.publicIpAddress!;
    expect(exercises(l)[1].validate(ctxOf(env, { browser: [simulateHttp(env, `http://${ip}`)] })).ok).toBe(true);
  });

  it('12 Target group: 503 until targets are registered', () => {
    const l = findLesson('target-group')!;
    const env = l.scenario();
    expect(browse(env)[0].status).toBe(503);
    const tg = env.targetGroups[0];
    registerTargets(env, tg.targetGroupArn, env.instances.filter((i) => byName([i], 'web-1') || byName([i], 'web-2')).map((i) => ({ id: i.instanceId, port: 3000 })));
    expect(exercises(l)[1].validate(ctxOf(env)).ok).toBe(true);
    expect(exercises(l)[2].validate(ctxOf(env, { browser: browse(env) })).ok).toBe(true);
  });

  it('13 Health check: fail-open serves 200; fixing the path makes targets healthy', () => {
    const l = findLesson('health-check')!;
    const env = l.scenario();
    expect(browse(env)[0].status).toBe(200);
    const tg = env.targetGroups[0];
    modifyTargetGroupHealthCheck(env, tg.targetGroupArn, { ...tg.healthCheck, path: '/health' });
    expect(exercises(l)[1].validate(ctxOf(env)).ok).toBe(true);
  });

  it('16 SG troubleshooting: 504, then TCP 3000 from alb-sg (not 0.0.0.0/0) fixes it', () => {
    const l = findLesson('sg-troubleshooting')!;
    const env = l.scenario();
    expect(browse(env)[0].status).toBe(504);
    const ex = exercises(l)[2];
    setSecurityGroupRules(env, sgNamed(env, 'web-sg')!.groupId, 'ingress', [sgRule(3000, '0.0.0.0/0')]);
    expect(ex.validate(ctxOf(env)).ok).toBe(false);
    setSecurityGroupRules(env, sgNamed(env, 'web-sg')!.groupId, 'ingress', [sgRule(3000, sgNamed(env, 'alb-sg')!.groupId)]);
    expect(ex.validate(ctxOf(env)).ok).toBe(true);
    expect(exercises(l)[3].validate(ctxOf(env, { browser: browse(env) })).ok).toBe(true);
  });

  it('17 Target unhealthy: 502, re-registering on 3000 fixes it', () => {
    const l = findLesson('target-unhealthy')!;
    const env = l.scenario();
    expect(browse(env)[0].status).toBe(502);
    const tg = env.targetGroups[0];
    const ids = tg.targets.map((t) => t.id);
    registerTargets(env, tg.targetGroupArn, ids.map((id) => ({ id, port: 3000 })));
    expect(exercises(l)[1].validate(ctxOf(env)).ok).toBe(false); // port 80 targets still there
    deregisterTargets(env, tg.targetGroupArn, ids.map((id) => ({ id, port: 80 })));
    expect(exercises(l)[1].validate(ctxOf(env)).ok).toBe(true);
    expect(browse(env)[0].status).toBe(200);
  });

  it('18 EC2 -> RDS: 500 until db-sg allows web-sg', () => {
    const l = findLesson('ec2-rds-troubleshooting')!;
    const env = l.scenario();
    expect(browse(env)[0].status).toBe(500);
    setSecurityGroupRules(env, sgNamed(env, 'db-sg')!.groupId, 'ingress', [sgRule(3306, sgNamed(env, 'web-sg')!.groupId)]);
    expect(exercises(l)[2].validate(ctxOf(env)).ok).toBe(true);
    expect(exercises(l)[3].validate(ctxOf(env, { browser: browse(env) })).ok).toBe(true);
  });

  it('09-2 Network ACL: outbound ephemeral ports fix the timeout', () => {
    const l = findLesson('network-acl')!;
    const env = l.scenario();
    const acl = byName(env.networkAcls, 'public-nacl')!;
    const ex = exercises(l)[2];
    replaceNetworkAclEntries(env, acl.networkAclId, true, [{ ruleNumber: 100, protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlock: '0.0.0.0/0', ruleAction: 'allow' }]);
    expect(ex.validate(ctxOf(env)).ok).toBe(false); // the classic mistake: allowing port 80 outbound
    replaceNetworkAclEntries(env, acl.networkAclId, true, [{ ruleNumber: 100, protocol: 'tcp', fromPort: 1024, toPort: 65535, cidrBlock: '0.0.0.0/0', ruleAction: 'allow' }]);
    expect(ex.validate(ctxOf(env)).ok).toBe(true);
    const ip = byName(env.instances, 'web-server')!.publicIpAddress!;
    expect(exercises(l)[3].validate(ctxOf(env, { browser: [simulateHttp(env, `http://${ip}`)] })).ok).toBe(true);
  });

  it('16-2 Network ACL troubleshooting: ALB return traffic alone is not enough, EC2 -> RDS across subnets too', () => {
    const l = findLesson('nacl-troubleshooting')!;
    const env = l.scenario();
    expect(browse(env)[0].status).toBe(504);
    const acl = byName(env.networkAcls, 'private-nacl')!;
    const out = acl.entries.filter((e) => e.egress).map((e) => ({ ruleNumber: e.ruleNumber, protocol: e.protocol, fromPort: e.fromPort, toPort: e.toPort, cidrBlock: e.cidrBlock, ruleAction: e.ruleAction }));
    const ex = exercises(l)[2];
    replaceNetworkAclEntries(env, acl.networkAclId, true, [...out, { ruleNumber: 120, protocol: 'tcp', fromPort: 1024, toPort: 65535, cidrBlock: '10.0.1.0/24', ruleAction: 'allow' }, { ruleNumber: 130, protocol: 'tcp', fromPort: 1024, toPort: 65535, cidrBlock: '10.0.2.0/24', ruleAction: 'allow' }]);
    expect(ex.validate(ctxOf(env)).ok).toBe(false); // ALB fixed, web-2 -> DB (other subnet) still blocked
    replaceNetworkAclEntries(env, acl.networkAclId, true, [...out, { ruleNumber: 120, protocol: 'tcp', fromPort: 1024, toPort: 65535, cidrBlock: '10.0.0.0/16', ruleAction: 'allow' }]);
    expect(ex.validate(ctxOf(env)).ok).toBe(true);
    expect(exercises(l)[3].validate(ctxOf(env, { browser: browse(env) })).ok).toBe(true);
  });

  it('21 S3 public access: BPA blocks the public policy until the two policy settings are off', () => {
    const l = findLesson('s3-public-access')!;
    const env = l.scenario();
    const [open, bpa, policy, check] = exercises(l);
    const url = objectUrl(env.buckets.find((b) => b.name === PUBLIC_SITE_BUCKET)!, 'index.html');
    expect(open.validate(ctxOf(env, { browser: [simulateHttp(env, url)] })).ok).toBe(true); // 403
    const text = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${PUBLIC_SITE_BUCKET}/*` }] });
    expect(() => putBucketPolicy(env, PUBLIC_SITE_BUCKET, text, 'learner')).toThrow(/BlockPublicPolicy/);
    putPublicAccessBlock(env, PUBLIC_SITE_BUCKET, { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: false });
    expect(bpa.validate(ctxOf(env)).ok).toBe(true);
    putBucketPolicy(env, PUBLIC_SITE_BUCKET, text, 'learner');
    expect(policy.validate(ctxOf(env)).ok).toBe(true);
    expect(check.validate(ctxOf(env, { browser: [simulateHttp(env, url)] })).ok).toBe(true);
  });

  it('22 IAM role: no credentials until batch-role is attached', () => {
    const l = findLesson('iam-role')!;
    const env = l.scenario();
    const id = byName(env.instances, 'batch-1')!.instanceId;
    const run = (cmd: string) => ({ instanceId: id, line: cmd, at: 0, ...execCli(env, id, cmd, {}) });
    expect(exercises(l)[0].validate(ctxOf(env, { commands: [run('aws sts get-caller-identity')] })).ok).toBe(true);
    setInstanceProfile(env, id, env.instanceProfiles[0].arn);
    expect(exercises(l)[2].validate(ctxOf(env)).ok).toBe(true);
    expect(exercises(l)[3].validate(ctxOf(env, { commands: [run('aws sts get-caller-identity'), run(`aws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/`)] })).ok).toBe(true);
  });

  it('23 AccessDenied: explicit deny in the bucket policy first, then the identity policy typo', () => {
    const l = findLesson('access-denied')!;
    const env = l.scenario();
    const id = byName(env.instances, 'batch-1')!.instanceId;
    const run = (cmd: string) => ({ instanceId: id, line: cmd, at: 0, ...execCli(env, id, cmd, {}) });
    const get = `aws s3api get-object --bucket ${REPORTS_BUCKET} --key reports/2026/09/report-2026-09-28.csv r.csv`;
    const ex = exercises(l);
    expect(ex[1].validate(ctxOf(env, { commands: [run(get)] })).ok).toBe(true); // explicit deny reported first
    const b = env.buckets.find((x) => x.name === REPORTS_BUCKET)!;
    const all = b.policy!;
    b.policy = undefined;
    expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // removed the TLS guard too
    b.policy = { ...all, Statement: (all.Statement as PolicyStatement[]).filter((s) => s.Sid !== 'DenyLegacyBatch') };
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
    expect(ex[3].validate(ctxOf(env, { commands: [run(get)] })).ok).toBe(true); // now: no identity-based policy allows
    const policy = env.iamPolicies.find((p) => p.policyName === 'batch-s3-read')!;
    updatePolicyDocument(env, policy.arn, { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: [`arn:aws:s3:::${REPORTS_BUCKET}`, `arn:aws:s3:::${REPORTS_BUCKET}/*`] }] });
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true);
    expect(ex[5].validate(ctxOf(env, { commands: [run(`aws s3 cp s3://${REPORTS_BUCKET}/reports/2026/09/report-2026-09-28.csv .`)] })).ok).toBe(true);
  });

  it('24 CloudWatch basics: monitoring tab, graph two metrics, EC2 CPU alarm (period matters)', () => {
    const l = findLesson('cloudwatch-basics')!;
    const env = l.scenario();
    const ex = exercises(l);
    const id = (n: string) => byName(env.instances, n)!.instanceId;
    expect(ex[0].validate(ctxOf(env, { visited: [`/ec2/instances/${id('web-1')}?tab=monitoring`] })).ok).toBe(true);
    const graph = encodeGraph(['web-1', 'web-2'].map((n) => metricFor('AWS/EC2', 'CPUUtilization', id(n))));
    expect(ex[1].validate(ctxOf(env, { visited: [`/cloudwatch/metrics?${new URLSearchParams({ ns: 'AWS/EC2', graph })}`] })).ok).toBe(true);
    const alarm = { alarmName: 'web-1-cpu-high', namespace: 'AWS/EC2', metricName: 'CPUUtilization', dimensions: [{ name: 'InstanceId', value: id('web-1') }], statistic: 'Average' as const, period: 60, evaluationPeriods: 1, datapointsToAlarm: 1, threshold: 70, comparisonOperator: 'GreaterThanThreshold' as const };
    putMetricAlarm(env, alarm);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // 1 minute on basic monitoring
    putMetricAlarm(env, { ...alarm, period: 300 });
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
  });

  it('25 app is slow: ALB -> EC2 -> RDS -> slow query log -> alarm -> scale up', () => {
    const l = findLesson('app-slow')!;
    const env = l.scenario();
    const ex = exercises(l);
    const web1 = byName(env.instances, 'web-1')!.instanceId;
    expect(ex[0].validate(ctxOf(env, { visited: ['/ec2/load-balancers/web-alb?tab=monitoring'] })).ok).toBe(true);
    expect(ex[1].validate(ctxOf(env, { visited: [`/ec2/instances/${web1}?tab=monitoring`] })).ok).toBe(true);
    expect(ex[2].validate(ctxOf(env, { visited: ['/rds/databases/webapp-db?tab=monitoring'] })).ok).toBe(true);
    const group = '/aws/rds/instance/webapp-db/slowquery';
    expect(ex[3].validate(ctxOf(env, { visited: [`/cloudwatch/logs/events?${new URLSearchParams({ group, stream: 'webapp-db' })}`] })).ok).toBe(false);
    expect(ex[3].validate(ctxOf(env, { visited: [`/cloudwatch/logs/events?${new URLSearchParams({ group, stream: 'webapp-db', filter: 'Rows_examined' })}`] })).ok).toBe(true);
    const now = Date.now();
    putMetricAlarm(env, { alarmName: 'webapp-db-cpu-high', namespace: 'AWS/RDS', metricName: 'CPUUtilization', dimensions: [{ name: 'DBInstanceIdentifier', value: 'webapp-db' }], statistic: 'Average', period: 60, evaluationPeriods: 1, datapointsToAlarm: 1, threshold: 80, comparisonOperator: 'GreaterThanThreshold' }, now);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true); // ALARM right away
    expect(ex[5].validate(ctxOf(env)).ok).toBe(false);
    modifyDbInstance(env, 'webapp-db', { dbInstanceClass: 'db.m7g.xlarge' }, now - 10_000);
    advanceTime(env, now);
    expect(env.dbInstances[0].status).toBe('available');
    expect(ex[5].validate(ctxOf(env)).ok).toBe(true);
  });

  it('26 SSH revoked: connect fails, find RevokeSecurityGroupIngress, restore the EIC rule (not 0.0.0.0/0)', () => {
    const l = findLesson('ssh-revoked')!;
    const env = l.scenario();
    const ex = exercises(l);
    const id = byName(env.instances, 'batch-1')!.instanceId;
    const sg = byName(env.securityGroups, 'batch-sg')!;
    expect(ex[0].validate(ctxOf(env, { visited: [`/ec2/instances/${id}/terminal`] })).ok).toBe(true);
    expect(ex[1].validate(ctxOf(env, { visited: [`/ec2/security-groups/${sg.groupId}`] })).ok).toBe(true);
    const revoke = env.trailEvents.find((e) => e.eventName === 'RevokeSecurityGroupIngress')!;
    expect(ex[2].validate(ctxOf(env, { visited: [`/cloudtrail/events?attr=ResourceName&value=${sg.groupId}`] })).ok).toBe(false);
    expect(ex[2].validate(ctxOf(env, { visited: [`/cloudtrail/events/view?id=${revoke.eventId}`] })).ok).toBe(true);
    const keep = sg.ingress.map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: r.cidrIpv4!, description: r.description }));
    const learner = iamUserActor(env, 'learner', CLIENT_IP);
    withActor(learner, Date.now(), () => setSecurityGroupRules(env, sg.groupId, 'ingress', [...keep, { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '0.0.0.0/0' }]));
    expect(ex[3].validate(ctxOf(env)).ok).toBe(false); // wide open is not the fix
    withActor(learner, Date.now(), () => setSecurityGroupRules(env, sg.groupId, 'ingress', [...keep, { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '3.112.23.0/29', description: 'EC2 Instance Connect' }]));
    expect(ex[3].validate(ctxOf(env)).ok).toBe(true);
    const whoami = { instanceId: id, line: 'whoami', at: 0, ...execCli(env, id, 'whoami', {}) };
    expect(ex[4].validate(ctxOf(env, { commands: [whoami] })).ok).toBe(true);
    const mine = env.trailEvents.filter((e) => e.eventName === 'AuthorizeSecurityGroupIngress' && e.userIdentity.userName === 'learner').pop()!;
    expect(ex[5].validate(ctxOf(env, { visited: [`/cloudtrail/events/view?id=${mine.eventId}`] })).ok).toBe(true);
  });

  it('27 Config audit: timeline -> close SSH keeping the ALB rule -> block public bucket -> add a rule', () => {
    const l = findLesson('config-audit')!;
    const env = l.scenario();
    const ex = exercises(l);
    const web = byName(env.securityGroups, 'web-sg')!;
    expect(ex[0].validate(ctxOf(env, { visited: ['/config/home'] })).ok).toBe(true);
    expect(ex[1].validate(ctxOf(env, { visited: [`/config/resources/view?${new URLSearchParams({ type: 'AWS::EC2::SecurityGroup', id: web.groupId })}`] })).ok).toBe(true);
    setSecurityGroupRules(env, web.groupId, 'ingress', []);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // broke the app
    setSecurityGroupRules(env, web.groupId, 'ingress', [{ ipProtocol: 'tcp', fromPort: 3000, toPort: 3000, source: byName(env.securityGroups, 'alb-sg')!.groupId }]);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
    expect(ex[3].validate(ctxOf(env)).ok).toBe(false);
    putPublicAccessBlock(env, 'webapp-share-123456789012', BPA_ALL_ON);
    expect(ex[3].validate(ctxOf(env)).ok).toBe(true);
    putConfigRule(env, { configRuleName: 'rds-storage-encrypted', identifier: 'RDS_STORAGE_ENCRYPTED' });
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true);
  });

  it('28 snapshot -> buggy migration -> restore (db-sg, not default) -> verify -> swap names', () => {
    const l = findLesson('rds-snapshot')!;
    const env = l.scenario();
    const ex = exercises(l);
    const id = byName(env.instances, 'batch-1')!.instanceId;
    const run = (cmd: string) => ({ instanceId: id, line: cmd, at: 0, ...execCli(env, id, cmd, {}) });
    const now = Date.now();
    createDbSnapshot(env, 'webapp-db', 'webapp-db-before-migration', now);
    expect(ex[0].validate(ctxOf(env)).ok).toBe(false); // still creating
    advanceTime(env, now + 10_000);
    expect(ex[0].validate(ctxOf(env)).ok).toBe(true);
    const migrate = run('./migrate.sh');
    expect(ex[1].validate(ctxOf(env, { commands: [migrate, run('mysql -e "SELECT COUNT(*) FROM orders"')] })).ok).toBe(true);
    const restore = (sg: string[]) => ({ identifier: 'webapp-db-restored', dbInstanceClass: 'db.t3.micro', dbSubnetGroupName: 'webapp-db-subnet-group', vpcSecurityGroupIds: sg, publiclyAccessible: false, multiAZ: false });
    restoreDbInstanceFromSnapshot(env, 'webapp-db-before-migration', restore([]), now + 10_000);
    advanceTime(env, now + 60_000);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // default security group
    modifyDbInstance(env, 'webapp-db-restored', { vpcSecurityGroupIds: [byName(env.securityGroups, 'db-sg')!.groupId] }, now + 60_000);
    advanceTime(env, now + 70_000);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
    const endpoint = env.dbInstances.find((d) => d.dbInstanceIdentifier === 'webapp-db-restored')!.endpointAddress;
    expect(ex[3].validate(ctxOf(env, { commands: [run(`mysql -h ${endpoint} -e "SELECT COUNT(*) FROM orders"`)] })).ok).toBe(true);
    modifyDbInstance(env, 'webapp-db', { newDbInstanceIdentifier: 'webapp-db-broken' }, now + 70_000);
    advanceTime(env, now + 80_000);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(false);
    modifyDbInstance(env, 'webapp-db-restored', { newDbInstanceIdentifier: 'webapp-db' }, now + 80_000);
    advanceTime(env, now + 90_000);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true);
  });

  it('29 point-in-time restore just before the accident (latest restorable time is too late)', () => {
    const l = findLesson('rpo-rto-dr')!;
    const env = l.scenario();
    const ex = exercises(l);
    const id = byName(env.instances, 'batch-1')!.instanceId;
    const run = (cmd: string) => ({ instanceId: id, line: cmd, at: 0, ...execCli(env, id, cmd, {}) });
    const log = run('cat cleanup.log');
    expect(log.output).toContain('DELETE FROM orders');
    expect(ex[0].validate(ctxOf(env, { commands: [log] })).ok).toBe(true);
    const accident = env.dbInstances[0].data!.find((d) => d.tables.orders === 0)!.at;
    const base = { dbInstanceClass: 'db.t3.micro', dbSubnetGroupName: 'webapp-db-subnet-group', vpcSecurityGroupIds: [byName(env.securityGroups, 'db-sg')!.groupId], publiclyAccessible: false, multiAZ: false };
    const now = Date.now();
    restoreDbInstanceToPointInTime(env, 'webapp-db', { ...base, identifier: 'webapp-db-pitr' }, now);
    advanceTime(env, now + 60_000);
    expect(ex[1].validate(ctxOf(env)).ok).toBe(false); // after the DELETE
    restoreDbInstanceToPointInTime(env, 'webapp-db', { ...base, identifier: 'webapp-db-pitr2', restoreTime: accident - 60_000 }, now);
    advanceTime(env, now + 120_000);
    expect(ex[1].validate(ctxOf(env)).ok).toBe(true);
    const endpoint = env.dbInstances.find((d) => d.dbInstanceIdentifier === 'webapp-db-pitr2')!.endpointAddress;
    expect(ex[2].validate(ctxOf(env, { commands: [run(`mysql -h ${endpoint} -e "SELECT COUNT(*) FROM orders"`)] })).ok).toBe(true);
  });

  it('30 Auto Scaling group: 503 -> create (2 AZ, web-tg, ELB) -> 200 -> self-healing', () => {
    const l = findLesson('asg-basics')!;
    const env = l.scenario();
    const ex = exercises(l);
    const lb = env.loadBalancers[0];
    expect(ex[0].validate(ctxOf(env, { visited: [`/ec2/launch-templates/${env.launchTemplates[0].launchTemplateId}`] })).ok).toBe(true);
    expect(ex[1].validate(ctxOf(env, { browser: [simulateHttp(env, `http://${lb.dnsName}/`)] })).ok).toBe(true);
    let now = Date.now();
    const subnets = ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId);
    createAutoScalingGroup(env, { name: 'webapp-asg', launchTemplateId: env.launchTemplates[0].launchTemplateId, minSize: 2, maxSize: 6, desiredCapacity: 2, subnetIds: subnets, targetGroupArns: [env.targetGroups[0].targetGroupArn], healthCheckType: 'ELB' }, now);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
    for (let t = now; t <= now + 5000; t += 1000) advanceTime(env, t);
    now += 5000;
    expect(ex[3].validate(ctxOf(env, { browser: [simulateHttp(env, `http://${lb.dnsName}/`)] })).ok).toBe(true);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(false);
    env.instances.find((i) => i.instanceId === env.autoScalingGroups[0].instances[0].instanceId)!.state = 'shutting-down';
    for (let t = now; t <= now + 6000; t += 1000) advanceTime(env, t);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true);
  });

  it('31 target tracking: policy -> 100 req/s (2) -> 1000 req/s (4, ~45%) -> activity -> back to 2', () => {
    const l = findLesson('asg-target-tracking')!;
    const env = l.scenario();
    const ex = exercises(l);
    expect(env.autoScalingGroups[0].instances.filter((r) => r.lifecycleState === 'InService').length).toBe(2);
    putTargetTrackingPolicy(env, 'webapp-asg', { policyName: 'cpu50', metric: 'ASGAverageCPUUtilization', targetValue: 50 });
    expect(ex[0].validate(ctxOf(env)).ok).toBe(true);
    let now = Date.now();
    const run = (seconds: number) => {
      for (let t = now; t <= now + seconds * 1000; t += 1000) advanceTime(env, t);
      now += seconds * 1000;
    };
    setTraffic(env, 100, now);
    run(10);
    expect(ex[1].validate(ctxOf(env)).ok).toBe(true);
    setTraffic(env, 1000, now);
    run(10);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // still 2 instances at ~80 %
    run(30);
    // validators look at "now": keep the clock of the test in step with Date.now() by asking with the real time
    expect(env.autoScalingGroups[0].desiredCapacity).toBe(4);
    expect(ex[3].validate(ctxOf(env, { visited: ['/ec2/autoscaling/webapp-asg?tab=activity'] })).ok).toBe(true);
    setTraffic(env, 100, now);
    run(75);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true);
  });

  it('32 ECS: v1 -> :v2 fails to pull (old tasks keep serving) -> stopped reason -> :v2.0 rolls out', () => {
    const l = findLesson('ecs-fargate')!;
    const env = l.scenario();
    const ex = exercises(l);
    const url = `http://${env.loadBalancers[0].dnsName}/`;
    expect(ex[0].validate(ctxOf(env, { browser: [simulateHttp(env, url)] })).ok).toBe(true);
    const td = getTaskDefinition(env, 'webapp:1');
    const rev = (tag: string) => registerTaskDefinition(env, { ...td, containerDefinitions: [{ ...td.containerDefinitions[0], image: td.containerDefinitions[0].image.replace(/:v1$/, `:${tag}`) }] });
    let now = Date.now();
    updateService(env, 'webapp-cluster', 'webapp-svc', { taskDefinition: rev('v2') }, now);
    expect(ex[1].validate(ctxOf(env)).ok).toBe(true);
    for (let t = now; t <= now + 6000; t += 1000) advanceTime(env, t);
    now += 6000;
    const failed = env.ecsTasks.find((t) => t.stopCode === 'TaskFailedToStart')!;
    expect(ex[2].validate(ctxOf(env, { visited: [`/ecs/clusters/webapp-cluster/tasks/${taskId(failed)}`] })).ok).toBe(true);
    expect(simulateHttp(env, url).body).toContain('webapp v1');
    updateService(env, 'webapp-cluster', 'webapp-svc', { taskDefinition: rev('v2.0') }, now);
    for (let t = now; t <= now + 15000; t += 1000) advanceTime(env, t);
    expect(ex[3].validate(ctxOf(env, { browser: [simulateHttp(env, url)] })).ok).toBe(true);
  });

  it('33 SQS + Lambda: failing order -> logs -> fix BUCKET -> retried -> DLQ redrive -> poison message to the DLQ', () => {
    const l = findLesson('sqs-lambda')!;
    const env = l.scenario();
    const ex = exercises(l);
    let now = Date.now();
    const run = (seconds: number) => {
      for (let t = now; t <= now + seconds * 1000; t += 1000) advanceTime(env, t);
      now += seconds * 1000;
    };
    sendMessage(env, 'orders-queue', '{"orderId": 2001, "amount": 1200}', now);
    run(2);
    expect(ex[0].validate(ctxOf(env, { visited: [`/cloudwatch/logs/events?${new URLSearchParams({ group: '/aws/lambda/process-order', stream: 'x' })}`] })).ok).toBe(true);
    updateFunctionConfiguration(env, 'process-order', { environment: { BUCKET: ORDERS_BUCKET } }, now);
    run(11);
    expect(ex[1].validate(ctxOf(env)).ok).toBe(true);
    startMessageMoveTask(env, 'orders-dlq', now);
    run(2);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
    sendMessage(env, 'orders-queue', '{"orderId": 3001,', now);
    run(10);
    expect(ex[3].validate(ctxOf(env)).ok).toBe(false);
    run(30);
    expect(ex[3].validate(ctxOf(env)).ok).toBe(true);
  });

  it('34 EventBridge + Batch: UTC cron -> failed job log -> job role PutObject -> rerun -> rate(1 minute) rule, then disable', () => {
    const l = findLesson('eventbridge-batch')!;
    const env = l.scenario();
    const ex = exercises(l);
    expect(ex[0].validate(ctxOf(env, { visited: ['/events/rules/daily-report-schedule'] })).ok).toBe(true);
    const failed = env.batchJobs.find((j) => j.status === 'FAILED')!;
    expect(ex[1].validate(ctxOf(env, { visited: [`/batch/jobs/${failed.jobId}`, `/cloudwatch/logs/events?${new URLSearchParams({ group: '/aws/batch/job', stream: failed.logStreamName! })}`] })).ok).toBe(true);
    putInlinePolicy(env, 'role', 'report-job-role', 'all-s3', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] });
    expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // too broad
    putInlinePolicy(env, 'role', 'report-job-role', 'all-s3', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: `arn:aws:s3:::${REPORTS}/reports/*` }] });
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
    let now = Date.now();
    const run = (seconds: number) => {
      for (let t = now; t <= now + seconds * 1000; t += 1000) advanceTime(env, t);
      now += seconds * 1000;
    };
    submitJob(env, { jobName: 'rerun', jobQueue: 'report-queue', jobDefinition: 'daily-report:1' }, 'learner', now);
    run(10);
    expect(ex[3].validate(ctxOf(env)).ok).toBe(true);
    putRule(env, { name: 'report-test', scheduleExpression: 'rate(1 minute)', target: { jobQueue: 'report-queue', jobDefinition: 'daily-report:1', jobName: 'report-test' } }, now);
    run(70);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(false); // still enabled
    setRuleState(env, 'report-test', false, now);
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true);
  });

  describe('35-38 edge', () => {
    /** the store's browse(): apply the request's effects, newest result first */
    const surf = (env: AwsEnv, history: HttpResult[], url: string) => {
      const r = simulateHttp(env, url);
      if (r.effects?.cache) storeInCache(env, r.effects.cache.distributionId, r.effects.cache.entry);
      if (r.effects?.waf) recordWafSample(env, r.effects.waf.aclArn, r.effects.waf.sample);
      history.unshift(r);
      return history;
    };
    let now = Date.now();
    const run = (env: AwsEnv, seconds: number) => {
      for (let t = now; t <= now + seconds * 1000; t += 1000) advanceTime(env, t);
      now += seconds * 1000;
    };

    it('35 Route 53: apex not resolved -> zone records -> apex alias to the ALB', () => {
      const l = findLesson('route53-dns')!;
      const env = l.scenario();
      const ex = exercises(l);
      const h: HttpResult[] = [];
      surf(env, h, `http://www.${SHOP_DOMAIN}/`);
      surf(env, h, `http://${SHOP_DOMAIN}/`);
      expect(ex[0].validate(ctxOf(env, { browser: h })).ok).toBe(true);
      expect(ex[1].validate(ctxOf(env, { visited: [`/route53/hostedzones/${env.hostedZones[0].id}`] })).ok).toBe(true);
      expect(() => changeRecord(env, env.hostedZones[0].id, 'CREATE', { name: SHOP_DOMAIN, type: 'CNAME', ttl: 300, values: [env.loadBalancers[0].dnsName] })).toThrow(/apex/);
      changeRecord(env, env.hostedZones[0].id, 'CREATE', { name: SHOP_DOMAIN, type: 'A', values: [], aliasTarget: env.loadBalancers[0].dnsName });
      expect(ex[2].validate(ctxOf(env, { browser: h })).ok).toBe(false); // not re-checked yet
      expect(ex[2].validate(ctxOf(env, { browser: surf(env, h, SHOP_DOMAIN) })).ok).toBe(true);
    });

    it('36 ACM: cert error on www -> us-east-1 certificate with www, DNS validated -> distribution aliases + cert', () => {
      const l = findLesson('acm-certificate')!;
      const env = l.scenario();
      const ex = exercises(l);
      const h = surf(env, [], `https://www.${SHOP_DOMAIN}/`);
      expect(ex[0].validate(ctxOf(env, { browser: h })).ok).toBe(true);
      const d = env.distributions[0];
      expect(ex[1].validate(ctxOf(env, { visited: [`/cloudfront/distributions/${d.id}`] })).ok).toBe(true);
      requestCertificate(env, { domainName: SHOP_DOMAIN, subjectAlternativeNames: [`www.${SHOP_DOMAIN}`], region: 'ap-northeast-1' }, now);
      expect(ex[2].validate(ctxOf(env)).lines[0].text).toMatch(/us-east-1 以外/);
      const arn = requestCertificate(env, { domainName: SHOP_DOMAIN, subjectAlternativeNames: [`www.${SHOP_DOMAIN}`], region: 'us-east-1' }, now);
      run(env, 6);
      expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // pending validation
      createValidationRecords(env, arn);
      run(env, 6);
      expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
      updateDistribution(env, d.id, { aliases: [SHOP_DOMAIN, `www.${SHOP_DOMAIN}`], certificateArn: arn }, now);
      run(env, 6);
      expect(ex[3].validate(ctxOf(env, { browser: h })).ok).toBe(false);
      expect(ex[3].validate(ctxOf(env, { browser: surf(env, h, `https://www.${SHOP_DOMAIN}`) })).ok).toBe(true);
    });

    it('37 CloudFront cache: Hit with the old page -> TTL 1 day -> invalidation -> the new page', () => {
      const l = findLesson('cloudfront-cache')!;
      const env = l.scenario();
      const ex = exercises(l);
      const d = env.distributions[0];
      const h = surf(env, [], `https://${d.domainName}/`);
      expect(ex[0].validate(ctxOf(env, { browser: h })).ok).toBe(false); // S3 not looked at
      expect(ex[0].validate(ctxOf(env, { browser: h, visited: [`/s3/buckets/${STATIC_BUCKET}`] })).ok).toBe(true);
      expect(ex[1].validate(ctxOf(env, { visited: [`/cloudfront/distributions/${d.id}?tab=behaviors`] })).ok).toBe(true);
      createInvalidation(env, d.id, ['/images/*'], now);
      run(env, 4);
      expect(ex[2].validate(ctxOf(env)).lines[0].text).toMatch(/キャッシュが残っている/);
      createInvalidation(env, d.id, ['/index.html'], now);
      run(env, 4);
      expect(ex[2].validate(ctxOf(env, { browser: h })).ok).toBe(false);
      expect(ex[2].validate(ctxOf(env, { browser: surf(env, h, `https://${d.domainName}/`) })).ok).toBe(true);
    });

    it('38 WAF: office blocked by a /24 IP set -> narrowed to the attacker -> XSS still blocked', () => {
      const l = findLesson('waf-blocked')!;
      const env = l.scenario();
      const ex = exercises(l);
      const url = `https://${env.distributions[0].domainName}/`;
      const h = surf(env, [], url);
      expect(ex[0].validate(ctxOf(env, { browser: h, visited: ['/wafv2/webacls/webapp-acl'] })).ok).toBe(true);
      updateIpSet(env, env.ipSets[0].arn, []);
      expect(ex[1].validate(ctxOf(env)).ok).toBe(false); // the attacker is free again
      updateIpSet(env, env.ipSets[0].arn, ['198.51.100.77/32']);
      expect(ex[1].validate(ctxOf(env)).ok).toBe(true);
      surf(env, h, url);
      expect(ex[2].validate(ctxOf(env, { browser: h })).ok).toBe(false);
      surf(env, h, `${url}?q=<script>alert(1)</script>`);
      expect(ex[2].validate(ctxOf(env, { browser: h })).ok).toBe(true);
    });
  });

  describe('39-41 cost / organizations', () => {
    const settle = (env: AwsEnv, ms = 10_000) => advanceTime(env, Date.now() + ms);
    const rtId = (env: AwsEnv, name: string) => byName(env.routeTables, name)!.routeTableId;
    const natId = (env: AwsEnv, name: string) => byName(env.natGateways, name)!.natGatewayId;

    it('39 cost: dev DB, endpoint + one NAT, debug log retention -> under budget; prod / audit / egress guarded', () => {
      const l = findLesson('cost-tradeoffs')!;
      const env = l.scenario();
      const ex = exercises(l);
      expect(ex[0].validate(ctxOf(env, { visited: ['/billing/home'] })).ok).toBe(true);
      modifyDbInstance(env, 'webapp-db', { multiAZ: false });
      settle(env);
      expect(ex[1].validate(ctxOf(env)).lines[0].text).toMatch(/本番に手を出してはいかん/);
      modifyDbInstance(env, 'webapp-db', { multiAZ: true });
      modifyDbInstance(env, 'dev-db', { multiAZ: false, backupRetentionPeriod: 3 });
      settle(env);
      for (const snap of env.dbSnapshots.filter((x) => x.dbInstanceIdentifier === 'dev-db').slice(1)) deleteDbSnapshot(env, snap.dbSnapshotIdentifier);
      expect(ex[1].validate(ctxOf(env)).ok).toBe(true);

      // deleting NATs before re-pointing the routes breaks dev egress
      deleteNatGateway(env, natId(env, 'dev-nat-1a'));
      settle(env);
      expect(ex[2].validate(ctxOf(env)).lines[0].text).toMatch(/外に出られなく/);
      const env2 = l.scenario();
      modifyDbInstance(env2, 'dev-db', { multiAZ: false, backupRetentionPeriod: 3 });
      settle(env2);
      for (const snap of env2.dbSnapshots.filter((x) => x.dbInstanceIdentifier === 'dev-db').slice(1)) deleteDbSnapshot(env2, snap.dbSnapshotIdentifier);
      createVpcEndpoint(env2, { vpcId: byName(env2.vpcs, 'dev-vpc')!.vpcId, serviceName: 'com.amazonaws.ap-northeast-1.s3', routeTableIds: ['dev-private-rt-1a', 'dev-private-rt-1c', 'dev-private-rt-1d'].map((n) => rtId(env2, n)) });
      for (const n of ['dev-private-rt-1c', 'dev-private-rt-1d']) replaceRoutes(env2, rtId(env2, n), [{ destinationCidrBlock: '0.0.0.0/0', gatewayId: natId(env2, 'dev-nat-1a') }]);
      deleteNatGateway(env2, natId(env2, 'dev-nat-1c'));
      deleteNatGateway(env2, natId(env2, 'dev-nat-1d'));
      settle(env2);
      expect(ex[2].validate(ctxOf(env2)).ok).toBe(true);
      putRetentionPolicy(env2, '/aws/cloudtrail/management-events', 30);
      expect(ex[3].validate(ctxOf(env2)).lines[0].text).toMatch(/監査ログ/);
      putRetentionPolicy(env2, '/aws/cloudtrail/management-events', undefined);
      expect(ex[4].validate(ctxOf(env2)).ok).toBe(false); // debug logs still kept forever: over budget
      putRetentionPolicy(env2, '/webapp/dev/debug', 7);
      expect(ex[3].validate(ctxOf(env2)).ok).toBe(true);
      expect(ex[4].validate(ctxOf(env2)).ok).toBe(true);
    });

    it('40 SCP: move prod into Production, protect CloudTrail from Root, Tokyo-only Development', () => {
      const l = findLesson('organizations-scp')!;
      const env = l.scenario();
      const ex = exercises(l);
      expect(ex[0].validate(ctxOf(env, { visited: [`/organizations/accounts/${ORG_ACCOUNTS.prod}`] })).ok).toBe(true);
      const portal = (p: Record<string, string>) => `/sso/portal?${new URLSearchParams(p)}`;
      moveAccount(env, ORG_ACCOUNTS.prod, ORG_OUS.production);
      expect(ex[1].validate(ctxOf(env, { visited: [portal({ user: 'sato', account: ORG_ACCOUNTS.prod, ps: 'AdministratorAccess', action: 'rds:DeleteDBSnapshot', region: 'ap-northeast-1' })] })).ok).toBe(true);
      const audit = createScp(env, { name: 'protect-audit', document: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail'], Resource: '*' }] } });
      attachScp(env, audit, ORG_OUS.production);
      expect(ex[2].validate(ctxOf(env)).ok).toBe(false); // only one OU
      attachScp(env, audit, env.organization!.rootId);
      expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
      // a region SCP without the global-service exemption blocks IAM
      const naive = createScp(env, { name: 'naive-region', document: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: '*', Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': ['ap-northeast-1'] } } }] } });
      attachScp(env, naive, ORG_OUS.development);
      const tryDev = portal({ user: 'node', account: ORG_ACCOUNTS.dev, ps: 'AdministratorAccess', action: 'ec2:RunInstances', region: 'us-east-1' });
      expect(ex[3].validate(ctxOf(env, { visited: [tryDev] })).lines[0].text).toMatch(/グローバルサービス/);
      env.organization!.policies = env.organization!.policies.map((p) => (p.id === naive ? { ...p, document: { Version: '2012-10-17', Statement: [{ Effect: 'Deny', NotAction: ['iam:*', 'organizations:*', 'sts:*'], Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': ['ap-northeast-1'] } } }] } } : p));
      expect(ex[3].validate(ctxOf(env)).ok).toBe(false); // not tried in the portal
      expect(ex[3].validate(ctxOf(env, { visited: [tryDev] })).ok).toBe(true);
      // detaching FullAWSAccess from an OU breaks everything below it
      env.organization!.policies.find((p) => p.id === FULL_AWS_ACCESS)!.targets = env.organization!.policies.find((p) => p.id === FULL_AWS_ACCESS)!.targets.filter((t) => t !== ORG_OUS.staging);
      expect(ex[3].validate(ctxOf(env, { visited: [tryDev] })).ok).toBe(false);
    });

    it('41 Identity Center: ReadOnlyAccess for Developers on prod, admin removed, dev kept', () => {
      const l = findLesson('identity-center')!;
      const env = l.scenario();
      const ex = exercises(l);
      expect(ex[0].validate(ctxOf(env, { visited: ['/sso/portal?user=node'] })).ok).toBe(true);
      const ro = createPermissionSet(env, { name: 'ReadOnlyAccess', managedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] });
      expect(ex[1].validate(ctxOf(env)).ok).toBe(true);
      const admin = env.identityCenter!.permissionSets.find((p) => p.name === 'AdministratorAccess')!.arn;
      createAccountAssignment(env, { accountId: ORG_ACCOUNTS.prod, permissionSetArn: ro, principalType: 'GROUP', principalName: 'Developers' });
      expect(ex[2].validate(ctxOf(env)).ok).toBe(false);
      deleteAccountAssignment(env, { accountId: ORG_ACCOUNTS.prod, permissionSetArn: admin, principalType: 'GROUP', principalName: 'Developers' });
      expect(ex[2].validate(ctxOf(env)).ok).toBe(true);
      const tries = ['ec2:DescribeInstances', 'ec2:TerminateInstances'].map((action) => `/sso/portal?${new URLSearchParams({ user: 'node', account: ORG_ACCOUNTS.prod, ps: 'ReadOnlyAccess', action, region: 'ap-northeast-1' })}`);
      expect(ex[3].validate(ctxOf(env, { visited: tries.slice(0, 1) })).ok).toBe(false);
      expect(ex[3].validate(ctxOf(env, { visited: tries })).ok).toBe(true);
      deleteAccountAssignment(env, { accountId: ORG_ACCOUNTS.dev, permissionSetArn: admin, principalType: 'GROUP', principalName: 'Developers' });
      expect(ex[2].validate(ctxOf(env)).lines[0].text).toMatch(/開発アカウント/);
    });
  });

  it('19 MVP final: both links blocked, then ALL CONNECTED', () => {
    const l = findLesson('mvp-final')!;
    const env = l.scenario();
    const [a, b, final] = exercises(l);
    expect(a.validate(ctxOf(env)).ok).toBe(false);
    expect(b.validate(ctxOf(env)).ok).toBe(false);
    setSecurityGroupRules(env, sgNamed(env, 'web-sg')!.groupId, 'ingress', [sgRule(3000, sgNamed(env, 'alb-sg')!.groupId)]);
    expect(a.validate(ctxOf(env)).ok).toBe(true);
    setSecurityGroupRules(env, sgNamed(env, 'db-sg')!.groupId, 'ingress', [sgRule(3306, sgNamed(env, 'web-sg')!.groupId)]);
    expect(b.validate(ctxOf(env)).ok).toBe(true);
    advanceTime(env, Infinity);
    expect(final.validate(ctxOf(env, { browser: browse(env) })).ok).toBe(true);
  });
});
