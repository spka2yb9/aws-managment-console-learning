import { describe, expect, it } from 'vitest';
import { iamUserActor, lookupEvents, withActor } from './cloudtrail';
import { evaluateRule, putConfigRule, resourceEvents, ruleCompliance } from './config';
import { byName } from './env';
import { attachPolicy, createUser } from './iam';
import { CLIENT_IP, eicConnectivity } from './network';
import { putPublicAccessBlock } from './s3';
import { auditEnv, s3IamEnv, SHARE_BUCKET, sshRevokedEnv, webAppEnv } from './scenarios';
import { createSecurityGroup, setSecurityGroupRules } from './sg';
import { BPA_ALL_ON } from './s3';

const learner = (env: Parameters<typeof iamUserActor>[0]) => iamUserActor(env, 'learner', CLIENT_IP);
const rulesOf = (env: ReturnType<typeof webAppEnv>, name: string) => byName(env.securityGroups, name)!.ingress.map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)!, description: r.description }));

describe('CloudTrail', () => {
  it('records API calls only inside withActor, in the AWS event shape', () => {
    const env = webAppEnv();
    expect(env.trailEvents).toEqual([]); // building the scenario records nothing
    const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
    const at = Date.now();
    withActor(learner(env), at, () => createSecurityGroup(env, { groupName: 'tmp-sg', description: 'tmp', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, source: '0.0.0.0/0' }] }));
    // CreateSecurityGroup + the console's AuthorizeSecurityGroupIngress; the default egress rule is not a separate call
    expect(env.trailEvents.map((e) => e.eventName)).toEqual(['CreateSecurityGroup', 'AuthorizeSecurityGroupIngress']);
    const tmp = env.securityGroups.find((g) => g.groupName === 'tmp-sg')!.groupId;
    withActor(learner(env), at + 1000, () => setSecurityGroupRules(env, tmp, 'ingress', []));
    const revoke = env.trailEvents[2];
    expect(revoke).toMatchObject({ eventName: 'RevokeSecurityGroupIngress', eventSource: 'ec2.amazonaws.com', awsRegion: 'ap-northeast-1', userIdentity: { type: 'IAMUser', userName: 'learner' }, resources: [['AWS::EC2::SecurityGroup', tmp]] });
    expect(revoke.requestParameters).toEqual({ groupId: tmp, ipPermissions: { items: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, groups: {}, ipRanges: { items: [{ cidrIp: '0.0.0.0/0' }] }, ipv6Ranges: {}, prefixListIds: {} }] } });
    // lookup: exact match, newest first, per Region; IAM is global and lands in us-east-1
    expect(lookupEvents(env, 'ap-northeast-1', 'ResourceName', tmp).map((e) => e.eventName)).toEqual(['RevokeSecurityGroupIngress', 'AuthorizeSecurityGroupIngress', 'CreateSecurityGroup']);
    expect(lookupEvents(env, 'ap-northeast-1', 'EventName', 'revokesecuritygroupingress')).toEqual([]);
    createUser(env, { userName: 'learner' });
    withActor(learner(env), at + 2000, () => attachPolicy(env, 'user', 'learner', 'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'));
    expect(lookupEvents(env, 'ap-northeast-1', 'EventName', 'AttachUserPolicy')).toEqual([]);
    expect(lookupEvents(env, 'us-east-1', 'EventName', 'AttachUserPolicy')[0]).toMatchObject({ eventSource: 'iam.amazonaws.com', responseElements: null });
  });

  it('lesson 26 history: tanaka revoked the EC2 Instance Connect rule yesterday with the CLI', () => {
    const env = sshRevokedEnv();
    const sg = byName(env.securityGroups, 'batch-sg')!;
    const [e] = lookupEvents(env, 'ap-northeast-1', 'EventName', 'RevokeSecurityGroupIngress');
    expect(e).toMatchObject({ userIdentity: { userName: 'tanaka' }, sourceIPAddress: '203.0.113.45', resources: [['AWS::EC2::SecurityGroup', sg.groupId]] });
    expect(e.userAgent).toMatch(/^aws-cli\//);
    expect(JSON.stringify(e.requestParameters)).toContain('"cidrIp":"3.112.23.0/29","description":"EC2 Instance Connect"');
    expect(e.eventTime).toBeLessThan(Date.now());
  });
});

describe('EC2 Instance Connect reachability', () => {
  it('needs TCP 22 from the Region EIC range, not from the office', () => {
    expect(eicConnectivity(s3IamEnv(), byName(s3IamEnv().instances, 'batch-1')!.instanceId).ok).toBe(true);
    const env = sshRevokedEnv();
    const id = byName(env.instances, 'batch-1')!.instanceId;
    expect(eicConnectivity(env, id).ok).toBe(false);
    const sg = byName(env.securityGroups, 'batch-sg')!;
    setSecurityGroupRules(env, sg.groupId, 'ingress', [...sg.ingress.map((r) => ({ ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: r.cidrIpv4! })), { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '3.112.23.0/29' }]);
    expect(eicConnectivity(env, id).ok).toBe(true);
  });
});

describe('AWS Config', () => {
  it('evaluates managed rules from the current configuration', () => {
    const env = auditEnv();
    const rule = (n: string) => env.configRules.find((r) => r.configRuleName === n)!;
    const web = byName(env.securityGroups, 'web-sg')!;
    expect(ruleCompliance(env, rule('restricted-ssh'))).toEqual({ compliance: 'NON_COMPLIANT', nonCompliant: 1 });
    expect(evaluateRule(env, rule('restricted-ssh')).find((e) => e.compliance === 'NON_COMPLIANT')).toMatchObject({ resourceId: web.groupId, resourceName: 'web-sg' });
    expect(ruleCompliance(env, rule('s3-bucket-public-read-prohibited')).compliance).toBe('NON_COMPLIANT');
    expect(ruleCompliance(env, rule('rds-instance-public-access-check')).compliance).toBe('COMPLIANT');
    // the timeline shows who changed it
    expect(resourceEvents(env, 'AWS::EC2::SecurityGroup', web.groupId).map((e) => `${e.eventName} ${e.userIdentity.userName}`)).toEqual(['AuthorizeSecurityGroupIngress tanaka']);
    setSecurityGroupRules(env, web.groupId, 'ingress', rulesOf(env, 'web-sg').filter((r) => r.fromPort !== 22));
    putPublicAccessBlock(env, SHARE_BUCKET, BPA_ALL_ON);
    expect(ruleCompliance(env, rule('restricted-ssh')).compliance).toBe('COMPLIANT');
    expect(ruleCompliance(env, rule('s3-bucket-public-read-prohibited')).compliance).toBe('COMPLIANT');
    expect(() => putConfigRule(env, { configRuleName: 'restricted-ssh', identifier: 'INCOMING_SSH_DISABLED' })).toThrow(/already exists/);
    expect(() => putConfigRule(env, { configRuleName: 'x', identifier: 'NOT_A_RULE' })).toThrow(/sourceIdentifier/);
    expect(ruleCompliance(env, putConfigRule(env, { configRuleName: 'rds-storage-encrypted', identifier: 'RDS_STORAGE_ENCRYPTED' })).compliance).toBe('COMPLIANT');
  });
});
