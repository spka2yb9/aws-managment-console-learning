import type { CommandRecord } from '../console/store';
import type { ConsoleExerciseContent, TaskContext } from '../lesson/types';
import { iamUserActor, withActor } from '../sim/cloudtrail';
import { byName } from '../sim/env';
import { REGISTER_MS, sessionCommand, startSession, terminateSession, updatePreferences } from '../sim/ext/ssm';
import { EC2_ROLE, SESSION_LOG_GROUP } from '../sim/ext/ssm-scenario';
import { attachPolicy } from '../sim/iam';
import { CLIENT_IP } from '../sim/network';
import { createSecurityGroup, setSecurityGroupRules } from '../sim/sg';
import { advanceTime } from '../sim/time';
import type { AwsEnv } from '../sim/types';
import { createVpcEndpoint } from '../sim/vpc';
import { lesson46 } from './l46-session-manager';

const exercises = lesson46.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');

describe('46 Session Manager: model solution', () => {
  it('role → endpoints → session → logging → close port 22', () => {
    const env = lesson46.scenario();
    let now = Date.now();
    const visited: string[] = [];
    const commands: CommandRecord[] = [];
    const ctx = (): TaskContext => ({ env, path: '', region: env.region, visited, copied: [], browser: [], commands });
    const id = (n: string) => byName(env.instances, n)!.instanceId;
    const learner = () => iamUserActor(env, 'learner', CLIENT_IP);
    const tick = (ms = 1000) => {
      now += ms;
      advanceTime(env, now);
    };
    const start = (name: string) => withActor(learner(), ++now, () => startSession(env, { target: id(name), userName: 'learner', ownerArn: `arn:aws:iam::${env.accountId}:user/learner` }, now));
    const type = (sessionId: string, name: string, line: string) => commands.push({ instanceId: id(name), line, at: ++now, ...sessionCommand(env, sessionId, line, {}, now) });
    const passes = (n: number) => exercises[n].validate(ctx());
    const allDone = (n: number) => exercises[n].tasks.every((t) => t.done(ctx()));

    // 1. look first
    visited.push(`/ec2/instances/${id('batch-1')}/connect?tab=ssm`);
    expect(passes(0).ok).toBe(false);
    visited.push('/ssm/fleet-manager');
    expect(passes(0).ok).toBe(true);

    // 2. AmazonSSMManagedInstanceCore → web-1 registers after a few seconds; batch-1 has no path
    withActor(learner(), now, () => attachPolicy(env, 'role', EC2_ROLE, 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'));
    tick();
    expect(passes(1).lines[0].text).toMatch(/少し待って/);
    tick(REGISTER_MS);
    expect(passes(1).ok).toBe(true);
    expect(allDone(1)).toBe(true);

    // 3. endpoints: without private DNS the diagnosis says so
    expect(passes(2).ok).toBe(false);
    const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
    const sg = createSecurityGroup(env, { groupName: 'ssm-endpoint-sg', description: 'HTTPS from the VPC', vpcId, ingress: [{ ipProtocol: 'tcp', fromPort: 443, toPort: 443, source: '10.0.0.0/16' }] });
    const subnet = byName(env.subnets, 'private-subnet-1a')!.subnetId;
    const svc = (s: string) => `com.amazonaws.ap-northeast-1.${s}`;
    const noDns = createVpcEndpoint(env, { vpcId, type: 'Interface', serviceName: svc('ssm'), subnetIds: [subnet], securityGroupIds: [sg], privateDnsEnabled: false });
    tick();
    expect(passes(2).lines[0].text).toMatch(/プライベート DNS 名が無効/);
    env.vpcEndpoints = env.vpcEndpoints.filter((e) => e.vpcEndpointId !== noDns);
    for (const s of ['ssm', 'ssmmessages', 'ec2messages']) createVpcEndpoint(env, { vpcId, type: 'Interface', serviceName: svc(s), subnetIds: [subnet], securityGroupIds: [sg] });
    tick();
    tick(REGISTER_MS);
    expect(passes(2).ok).toBe(true);
    expect(allDone(2)).toBe(true);

    // 4. session to batch-1
    expect(passes(3).ok).toBe(false);
    const s1 = start('batch-1');
    type(s1, 'batch-1', 'whoami');
    expect(commands.at(-1)!.output).toBe('ssm-user');
    expect(passes(3).ok).toBe(false);
    withActor(learner(), ++now, () => terminateSession(env, s1, now));
    expect(passes(3).ok).toBe(true);

    // 5. logging: only sessions started after the preference change, and only from web-1 (batch-1 has no logs endpoint)
    withActor(learner(), ++now, () => updatePreferences(env, { cloudWatchLogGroupName: SESSION_LOG_GROUP, cloudWatchStreamingEnabled: true }, now));
    const onBatch = start('batch-1');
    type(onBatch, 'batch-1', 'hostname');
    expect(passes(4).lines[0].text).toMatch(/batch-1 でやっても/);
    const s2 = start('web-1');
    type(s2, 'web-1', 'hostname');
    expect(passes(4).ok).toBe(false);
    visited.push(`/cloudwatch/logs/events?group=${encodeURIComponent(SESSION_LOG_GROUP)}&stream=${s2}`);
    expect(passes(4).ok).toBe(true);

    // 6. close port 22 (keep HTTP), then a new session still works
    expect(passes(5).ok).toBe(false);
    const web = byName(env.securityGroups, 'web-sg')!;
    withActor(learner(), ++now, () => setSecurityGroupRules(env, web.groupId, 'ingress', []));
    withActor(learner(), ++now, () => setSecurityGroupRules(env, byName(env.securityGroups, 'batch-sg')!.groupId, 'ingress', []));
    tick();
    expect(passes(5).lines[0].text).toMatch(/HTTP \(80\) まで消えて/);
    withActor(learner(), ++now, () => setSecurityGroupRules(env, web.groupId, 'ingress', [{ ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0' }]));
    expect(passes(5).lines[0].text).toMatch(/閉じる前のセッションは数えん/);
    const s3 = start('batch-1');
    type(s3, 'batch-1', 'hostname');
    expect(passes(5).ok).toBe(true);
    expect(allDone(5)).toBe(true);
  });

  it('every exercise has hints and the scenario keeps both instances unmanaged at start', () => {
    const env: AwsEnv = lesson46.scenario();
    expect(env.ssm!.nodes).toEqual([]);
    expect(exercises.flatMap((e) => e.tasks).every((t) => t.hint.trim())).toBe(true);
  });
});
