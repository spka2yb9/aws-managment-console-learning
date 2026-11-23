import { iamUserActor, withActor } from '../cloudtrail';
import { byName } from '../env';
import { attachPolicy } from '../iam';
import { CLIENT_IP } from '../network';
import { createSecurityGroup, setSecurityGroupRules } from '../sg';
import { advanceTime } from '../time';
import type { AwsEnv } from '../types';
import { createVpcEndpoint } from '../vpc';
import { diagnoseNode, exitSession, managedNodes, pingStatus, REGISTER_MS, sessionCommand, startSession, terminateSession, updatePreferences } from './ssm';
import { EC2_ROLE, SESSION_LOG_GROUP, sessionManagerEnv } from './ssm-scenario';

const CORE = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const id = (env: AwsEnv, name: string) => byName(env.instances, name)!.instanceId;
const user = (env: AwsEnv) => ({ userName: 'learner', ownerArn: `arn:aws:iam::${env.accountId}:user/learner` });

function endpoints(env: AwsEnv, opts: { privateDns?: boolean; sgSource?: string } = {}) {
  const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
  const sg = createSecurityGroup(env, { groupName: 'ssm-endpoint-sg', description: 'HTTPS from the VPC', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, source: opts.sgSource ?? '10.0.0.0/16' }] });
  for (const s of ['ssm', 'ssmmessages', 'ec2messages'])
    createVpcEndpoint(env, { vpcId, type: 'Interface', serviceName: `com.amazonaws.ap-northeast-1.${s}`, subnetIds: [byName(env.subnets, 'private-subnet-1a')!.subnetId], securityGroupIds: [sg], privateDnsEnabled: opts.privateDns });
}

describe('Session Manager: managed nodes', () => {
  it('nothing is managed until the role has the agent permissions', () => {
    const env = sessionManagerEnv();
    expect(managedNodes(env)).toEqual([]);
    const d = diagnoseNode(env, id(env, 'web-1'));
    expect(d.ok).toBe(false);
    expect(d.checks.find((c) => c.label === 'IAM ロールの許可')!.detail).toMatch(/AmazonSSMManagedInstanceCore/);
  });

  it('the public instance registers a few seconds after AmazonSSMManagedInstanceCore is attached; the private one has no path', () => {
    const env = sessionManagerEnv();
    attachPolicy(env, 'role', EC2_ROLE, CORE);
    const t = Date.now();
    advanceTime(env, t);
    expect(pingStatus(env, id(env, 'web-1'))).toBeUndefined();
    advanceTime(env, t + REGISTER_MS);
    expect(pingStatus(env, id(env, 'web-1'))).toBe('Online');
    expect(pingStatus(env, id(env, 'batch-1'))).toBeUndefined();
    const ssm = diagnoseNode(env, id(env, 'batch-1')).checks.find((c) => c.label.startsWith('ssm.'))!;
    expect(ssm.ok).toBe(false);
    expect(ssm.detail).toMatch(/NAT ゲートウェイか、プライベート DNS 名を有効にしたインターフェイスエンドポイント/);
    expect(managedNodes(env)[0]).toMatchObject({ pingStatus: 'Online', platformName: 'Amazon Linux', agentVersion: expect.any(String) });
  });

  it('interface endpoints need private DNS and a security group that lets the instance in on 443', () => {
    const noDns = sessionManagerEnv();
    attachPolicy(noDns, 'role', EC2_ROLE, CORE);
    endpoints(noDns, { privateDns: false });
    expect(diagnoseNode(noDns, id(noDns, 'batch-1')).checks.find((c) => c.label.startsWith('ssm.'))!.detail).toMatch(/プライベート DNS 名が無効/);

    const badSg = sessionManagerEnv();
    attachPolicy(badSg, 'role', EC2_ROLE, CORE);
    endpoints(badSg, { sgSource: '10.0.1.0/24' });
    expect(diagnoseNode(badSg, id(badSg, 'batch-1')).checks.find((c) => c.label.startsWith('ssm.'))!.detail).toMatch(/からの TCP 443 を許可していません/);

    const env = sessionManagerEnv();
    attachPolicy(env, 'role', EC2_ROLE, CORE);
    endpoints(env);
    advanceTime(env, Infinity);
    expect(pingStatus(env, id(env, 'batch-1'))).toBe('Online');
    // a second private-DNS endpoint for the same service conflicts
    expect(() => endpoints(env)).toThrow();
  });

  it('connection lost when the agent loses its path; port 22 is irrelevant', () => {
    const env = sessionManagerEnv();
    attachPolicy(env, 'role', EC2_ROLE, CORE);
    advanceTime(env, Infinity);
    const web = byName(env.securityGroups, 'web-sg')!;
    setSecurityGroupRules(env, web.groupId, 'ingress', [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0' }]);
    advanceTime(env, Date.now());
    expect(pingStatus(env, id(env, 'web-1'))).toBe('Online');
    setSecurityGroupRules(env, web.groupId, 'egress', []);
    advanceTime(env, Date.now());
    expect(pingStatus(env, id(env, 'web-1'))).toBe('ConnectionLost');
  });
});

describe('Session Manager: sessions and logging', () => {
  it('TargetNotConnected before the node is online', () => {
    const env = sessionManagerEnv();
    expect(() => startSession(env, { target: id(env, 'web-1'), ...user(env) })).toThrow(`${id(env, 'web-1')} is not connected.`);
  });

  it('runs as ssm-user, streams to CloudWatch Logs only for sessions started after logging was turned on, records CloudTrail', () => {
    const env = sessionManagerEnv();
    attachPolicy(env, 'role', EC2_ROLE, CORE);
    advanceTime(env, Infinity);
    const web = id(env, 'web-1');
    const before = startSession(env, { target: web, ...user(env) });
    expect(sessionCommand(env, before, 'whoami', {}).output).toBe('ssm-user');
    withActor(iamUserActor(env, 'learner', CLIENT_IP), Date.now(), () => updatePreferences(env, { cloudWatchLogGroupName: SESSION_LOG_GROUP, cloudWatchStreamingEnabled: true }));
    sessionCommand(env, before, 'hostname', {});
    const group = () => env.logGroups.find((g) => g.logGroupName === SESSION_LOG_GROUP)!;
    expect(group().events).toEqual([]);
    const s = withActor(iamUserActor(env, 'learner', CLIENT_IP), Date.now(), () => startSession(env, { target: web, reason: 'check', ...user(env) }));
    expect(s).toMatch(/^learner-[0-9a-f]{17}$/);
    sessionCommand(env, s, 'whoami', {});
    const ev = group().events![0];
    expect(ev.logStreamName).toBe(s);
    expect(JSON.parse(ev.message)).toMatchObject({ target: { id: web }, runAsUser: 'ssm-user', sessionId: s, sessionData: ['sh-5.2$ whoami', 'ssm-user'] });
    expect(env.trailEvents.map((e) => e.eventName)).toEqual(['UpdateDocument', 'StartSession']);
    exitSession(env, s);
    expect(env.ssm!.sessions.find((x) => x.sessionId === s)).toMatchObject({ status: 'Terminated' });
    expect(sessionCommand(env, s, 'whoami', {}).ok).toBe(false);
    terminateSession(env, before);
    expect(env.ssm!.sessions.every((x) => x.status === 'Terminated')).toBe(true);
  });

  it('the private node cannot write session logs without a logs endpoint; upload mode writes at the end', () => {
    const env = sessionManagerEnv();
    attachPolicy(env, 'role', EC2_ROLE, CORE);
    endpoints(env);
    advanceTime(env, Infinity);
    updatePreferences(env, { cloudWatchLogGroupName: SESSION_LOG_GROUP, cloudWatchStreamingEnabled: true });
    const s = startSession(env, { target: id(env, 'batch-1'), ...user(env) });
    sessionCommand(env, s, 'whoami', {});
    expect(env.logGroups.find((g) => g.logGroupName === SESSION_LOG_GROUP)!.events).toEqual([]);
    updatePreferences(env, { cloudWatchStreamingEnabled: false });
    const up = startSession(env, { target: id(env, 'web-1'), ...user(env) });
    sessionCommand(env, up, 'whoami', {});
    expect(env.logGroups.find((g) => g.logGroupName === SESSION_LOG_GROUP)!.events).toEqual([]);
    terminateSession(env, up);
    expect(env.logGroups.find((g) => g.logGroupName === SESSION_LOG_GROUP)!.events![0].message).toBe('sh-5.2$ whoami\nssm-user');
  });

  it('stopping the instance ends its sessions', () => {
    const env = sessionManagerEnv();
    attachPolicy(env, 'role', EC2_ROLE, CORE);
    advanceTime(env, Infinity);
    const s = startSession(env, { target: id(env, 'web-1'), ...user(env) });
    byName(env.instances, 'web-1')!.state = 'stopped';
    advanceTime(env, Date.now());
    expect(env.ssm!.sessions[0]).toMatchObject({ sessionId: s, status: 'Terminated' });
    expect(managedNodes(env)).toEqual([]);
  });
});
