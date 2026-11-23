import type { CommandRecord } from '../console/store';
import type { ConsoleExerciseContent, TaskContext } from '../lesson/types';
import { execCli } from '../sim/cli';
import { byName } from '../sim/env';
import { modifyInstanceMetadataOptions, revokeOlderSessions } from '../sim/ext/credentials';
import { createFilter, deleteFilter, parseCriterion, setArchived } from '../sim/ext/guardduty';
import { ADMIN_ROLE, ATTACKER_IP, FINDING_IDS, STOLEN_KEY } from '../sim/ext/guardduty-scenario';
import type { AwsEnv } from '../sim/types';
import { CREDS_URL, lesson43 } from './l43-guardduty';

const ctxOf = (env: AwsEnv, extra: Partial<TaskContext> = {}): TaskContext => ({ env, path: '', region: env.region, visited: [], copied: [], browser: [], commands: [], ...extra });
const exercises = lesson43.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');

describe('43 GuardDuty: finding -> CloudTrail -> revoke sessions -> IMDSv2 -> suppression rule', () => {
  it('passes each exercise with the console operations', () => {
    const env = lesson43.scenario();
    const ex = exercises;
    const admin = byName(env.instances, 'admin-1')!.instanceId;
    const scanner = byName(env.instances, 'scanner-1')!.instanceId;
    const d = env.guardDuty!.detectorId;
    const run = (line: string): CommandRecord => ({ instanceId: admin, line, at: 0, ...execCli(env, admin, line, {}) });

    // 1. the High finding
    expect(ex[0].validate(ctxOf(env, { visited: [`/guardduty/findings?id=${FINDING_IDS.portscan}`] })).ok).toBe(false);
    expect(ex[0].validate(ctxOf(env, { visited: [`/guardduty/findings?id=${FINDING_IDS.exfiltration}`] })).ok).toBe(true);

    // 2. CloudTrail by access key, then an event from the attacker's IP
    const lookup = `/cloudtrail/events?${new URLSearchParams({ attr: 'AccessKeyId', value: STOLEN_KEY })}`;
    const own = env.trailEvents.find((e) => e.userIdentity.accessKeyId === STOLEN_KEY && e.sourceIPAddress !== ATTACKER_IP)!;
    const attacker = env.trailEvents.find((e) => e.sourceIPAddress === ATTACKER_IP)!;
    expect(ex[1].validate(ctxOf(env, { visited: [lookup, `/cloudtrail/events/view?id=${own.eventId}`] })).ok).toBe(false);
    expect(ex[1].validate(ctxOf(env, { visited: [lookup, `/cloudtrail/events/view?id=${attacker.eventId}`] })).ok).toBe(true);

    // 3. revoke the role's active sessions
    expect(ex[2].validate(ctxOf(env)).ok).toBe(false);
    revokeOlderSessions(env, ADMIN_ROLE);
    expect(ex[2].validate(ctxOf(env)).ok).toBe(true);

    // 4. IMDSv1 hands out the credentials
    const v1 = run(`curl ${CREDS_URL}`);
    expect(ex[3].validate(ctxOf(env, { commands: [v1] })).ok).toBe(true);

    // 5. IMDSv2 required (turning IMDS off is not the fix)
    modifyInstanceMetadataOptions(env, admin, { httpEndpoint: 'disabled' });
    expect(ex[4].validate(ctxOf(env)).ok).toBe(false);
    modifyInstanceMetadataOptions(env, admin, { httpEndpoint: 'enabled', httpTokens: 'required' });
    expect(ex[4].validate(ctxOf(env)).ok).toBe(true);

    // 6. the same curl is 401, the CLI still works
    expect(ex[5].validate(ctxOf(env, { commands: [v1] })).ok).toBe(false);
    expect(ex[5].validate(ctxOf(env, { commands: [v1, run(`curl ${CREDS_URL}`), run('aws sts get-caller-identity')] })).ok).toBe(true);

    // 7. archive what is handled, suppress only scanner-1's Portscan
    const rule = (name: string, criterion: unknown) => createFilter(env, d, { name, action: 'ARCHIVE', criterion: parseCriterion(criterion) });
    rule('all-portscans', { Criterion: { type: { Eq: ['Recon:EC2/Portscan'] } } });
    expect(ex[6].validate(ctxOf(env)).lines[0].text).toMatch(/乗っ取られた別のインスタンス/);
    deleteFilter(env, d, 'all-portscans');
    rule('scanner-ami', { Criterion: { type: { Eq: ['Recon:EC2/Portscan'] }, 'resource.instanceDetails.imageId': { Eq: [byName(env.instances, 'scanner-1')!.imageId] } } });
    expect(ex[6].validate(ctxOf(env)).lines[0].text).toMatch(/AMI の ID は web-1 も同じ/);
    deleteFilter(env, d, 'scanner-ami');
    rule('scanner-portscan', { Criterion: { type: { Eq: ['Recon:EC2/Portscan'] }, 'resource.instanceDetails.instanceId': { Eq: [scanner] } } });
    expect(ex[6].validate(ctxOf(env)).lines[0].text).toMatch(/新しい検出結果にしか効かん/);
    setArchived(env, d, [FINDING_IDS.exfiltration, FINDING_IDS.portscan, FINDING_IDS.portProbe], true);
    expect(ex[6].validate(ctxOf(env)).ok).toBe(false); // admin-1's port 80 is not fixed yet
    setArchived(env, d, [FINDING_IDS.portProbe], false);
    expect(ex[6].validate(ctxOf(env)).ok).toBe(true);
  });

  it('a tag-based suppression rule is accepted too', () => {
    const env = lesson43.scenario();
    const d = env.guardDuty!.detectorId;
    createFilter(env, d, { name: 'scanner-tag', action: 'ARCHIVE', criterion: parseCriterion({ Criterion: { type: { Equals: ['Recon:EC2/Portscan'] }, 'resource.instanceDetails.tags.value': { Equals: ['vuln-scanner'] } } }) });
    setArchived(env, d, [FINDING_IDS.exfiltration, FINDING_IDS.portscan], true);
    expect(exercises[6].validate(ctxOf(env)).ok).toBe(true);
  });
});
