import { execCli } from '../cli';
import { iamUserActor, lookupEvents, withActor } from '../cloudtrail';
import { byName } from '../env';
import { AwsError, type AwsEnv } from '../types';
import { imdsToken, metadataOptions, modifyInstanceMetadataOptions, revokeOlderSessions, sessionsRevokedBefore } from './credentials';
import { countBySeverity, createFilter, deleteFilter, listFindings, parseCriterion, recordFinding, setArchived } from './guardduty';
import { ADMIN_ROLE, ATTACKER_IP, FINDING_IDS, guardDutyEnv, STOLEN_KEY } from './guardduty-scenario';

const detectorOf = (env: AwsEnv) => env.guardDuty!.detectorId;
const ids = (env: AwsEnv, criterion: unknown) => listFindings(env, detectorOf(env), parseCriterion(criterion)).map((f) => f.id).sort();
const adminId = (env: AwsEnv) => byName(env.instances, 'admin-1')!.instanceId;
const sh = (env: AwsEnv, line: string) => execCli(env, adminId(env), line, {});
const CREDS = `curl http://169.254.169.254/latest/meta-data/iam/security-credentials/${ADMIN_ROLE}`;
const TOKEN = 'curl -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"';
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof AwsError ? e.code : String(e);
  }
  return 'no error';
};

describe('lesson 43 scenario', () => {
  it('has GuardDuty on, three current findings and the attacker in CloudTrail with the stolen key', () => {
    const env = guardDutyEnv();
    expect(env.guardDuty?.status).toBe('ENABLED');
    expect(env.guardDuty!.findings.map((f) => [f.type, f.severity, f.service.archived])).toEqual([
      ['Recon:EC2/Portscan', 5, false],
      ['Recon:EC2/PortProbeUnprotectedPort', 2, false],
      ['UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS', 8, false],
    ]);
    const exfil = env.guardDuty!.findings.find((f) => f.id === FINDING_IDS.exfiltration)!;
    expect(exfil.resource.accessKeyDetails?.accessKeyId).toBe(STOLEN_KEY);
    expect(exfil.resource.instanceDetails?.instanceId).toBe(adminId(env));
    const events = lookupEvents(env, env.region, 'AccessKeyId', STOLEN_KEY);
    expect(new Set(events.map((e) => e.sourceIPAddress))).toEqual(new Set([ATTACKER_IP, byName(env.instances, 'admin-1')!.publicIpAddress]));
    expect(events.filter((e) => e.sourceIPAddress === ATTACKER_IP).map((e) => e.eventName).reverse()).toEqual(['GetCallerIdentity', 'ListBuckets', 'GetBucketLocation', 'DescribeInstances']);
    expect(metadataOptions(byName(env.instances, 'admin-1')!).httpTokens).toBe('optional');
    // the same scenario every time (dialogue and tests refer to it)
    expect(guardDutyEnv().guardDuty!.detectorId).toBe(env.guardDuty!.detectorId);
  });
});

describe('GuardDuty findings and filters', () => {
  it('matches finding criteria like the API (severity levels, nested lists, CIDR, archived)', () => {
    const env = guardDutyEnv();
    const { exfiltration, portscan } = FINDING_IDS;
    expect(ids(env, { Criterion: { severity: { Gte: 7 } } })).toEqual([exfiltration]);
    expect(ids(env, { Criterion: { severity: { Equals: ['4', '5', '6'] } } })).toEqual([portscan]);
    expect(ids(env, { Criterion: { type: { Eq: ['Recon:EC2/Portscan'] } } })).toEqual([portscan]);
    expect(ids(env, { Criterion: { 'resource.instanceDetails.tags.value': { Eq: ['vuln-scanner'] } } })).toEqual([portscan]);
    expect(ids(env, { Criterion: { 'service.action.awsApiCallAction.remoteIpDetails.ipAddressV4': { Equals: ['192.0.2.0/24'] } } })).toEqual([exfiltration]);
    expect(ids(env, { Criterion: { 'resource.instanceDetails.instanceId': { Neq: [adminId(env)] } } })).toEqual([portscan]);
    expect(ids(env, { Criterion: { 'service.archived': { Eq: ['false'] } } })).toHaveLength(3);
    expect(code(() => parseCriterion({ Criterion: { 'resource.instanceDetail.instanceId': { Eq: ['x'] } } }))).toBe('BadRequestException');
    expect(code(() => parseCriterion({ Criterion: { type: { Matches: ['Recon:*'] } } }))).toBe('BadRequestException');
    expect(Object.keys(parseCriterion({ Criterion: { type: { Matches: ['Recon:*'] } } }, { wildcards: true }))).toEqual(['type']);
    expect(countBySeverity(env.guardDuty!.findings)).toEqual({ '5.0': 1, '2.0': 1, '8.0': 1 });
  });

  it('archives / unarchives (recorded in CloudTrail) and rejects other detectors', () => {
    const env = guardDutyEnv();
    withActor(iamUserActor(env, 'learner', '198.51.100.24'), Date.now(), () => setArchived(env, detectorOf(env), [FINDING_IDS.exfiltration], true));
    expect(ids(env, { Criterion: { 'service.archived': { Eq: ['true'] } } })).toEqual([FINDING_IDS.exfiltration]);
    expect(env.trailEvents.at(-1)).toMatchObject({ eventName: 'ArchiveFindings', eventSource: 'guardduty.amazonaws.com' });
    setArchived(env, detectorOf(env), [FINDING_IDS.exfiltration], false);
    expect(ids(env, { Criterion: { 'service.archived': { Eq: ['true'] } } })).toEqual([]);
    expect(code(() => setArchived(env, 'abc', [FINDING_IDS.exfiltration], true))).toBe('BadRequestException');
    expect(code(() => setArchived(env, detectorOf(env), ['nope'], true))).toBe('BadRequestException');
  });

  it('a suppression rule archives new and updated matching findings, not existing ones', () => {
    const env = guardDutyEnv();
    const d = detectorOf(env);
    const scanner = byName(env.instances, 'scanner-1')!.instanceId;
    createFilter(env, d, { name: 'scanner-portscan', action: 'ARCHIVE', criterion: parseCriterion({ Criterion: { type: { Eq: ['Recon:EC2/Portscan'] }, 'resource.instanceDetails.instanceId': { Eq: [scanner] } } }) });
    expect(code(() => createFilter(env, d, { name: 'scanner-portscan', action: 'ARCHIVE', criterion: { type: { Eq: ['x'] } } }))).toBe('BadRequestException');
    expect(code(() => createFilter(env, d, { name: 'no', criterion: { type: { Eq: ['x'] } } }))).toBe('BadRequestException');
    const scan = env.guardDuty!.findings.find((f) => f.id === FINDING_IDS.portscan)!;
    expect(scan.service.archived).toBe(false);
    // next week's scan updates the finding: archived by the rule
    const next = recordFinding(env, scan);
    expect([next.service.archived, next.service.count]).toEqual([true, 9]);
    // the same type from another instance is not suppressed
    const other = recordFinding(env, { ...scan, id: 'f'.repeat(32), resource: { ...scan.resource, instanceDetails: { ...scan.resource.instanceDetails!, instanceId: adminId(env) } } });
    expect(other.service.archived).toBe(false);
    deleteFilter(env, d, 'scanner-portscan');
    expect(env.guardDuty!.filters).toEqual([]);
  });
});

describe('IMDS (curl inside the instance)', () => {
  it('IMDSv1 hands the role credentials to a token-less GET (what the SSRF did)', () => {
    const env = guardDutyEnv();
    const r = sh(env, CREDS);
    expect(r.ok).toBe(true);
    expect(r.output).toContain('"AccessKeyId"');
  });

  it('IMDSv2 required: token-less GET is 401, a session token works, the CLI still gets credentials', () => {
    const env = guardDutyEnv();
    const i = byName(env.instances, 'admin-1')!;
    modifyInstanceMetadataOptions(env, i.instanceId, { httpTokens: 'required', httpEndpoint: 'enabled' });
    expect(sh(env, CREDS).output).toContain('401 - Unauthorized');
    expect(sh(env, `curl -sf ${CREDS.slice(5)}`)).toMatchObject({ ok: false, output: 'curl: (22) The requested URL returned error: 401' });
    expect(sh(env, TOKEN).output).toBe(imdsToken(i));
    expect(sh(env, `curl -H "X-aws-ec2-metadata-token: ${imdsToken(i)}" ${CREDS.slice(5)}`).output).toContain('"AccessKeyId"');
    expect(sh(env, `curl -H "X-aws-ec2-metadata-token: wrong" ${CREDS.slice(5)}`).output).toContain('401 - Unauthorized');
    // the one-liner with command substitution
    expect(sh(env, `curl -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')" ${CREDS.slice(5)}`).output).toContain('"AccessKeyId"');
    expect(sh(env, 'curl -X PUT http://169.254.169.254/latest/api/token').output).toContain('400 - Missing or Invalid Parameters');
    expect(sh(env, 'aws sts get-caller-identity').ok).toBe(true);
  });

  it('a disabled endpoint answers 403 and leaves the CLI without credentials', () => {
    const env = guardDutyEnv();
    modifyInstanceMetadataOptions(env, adminId(env), { httpEndpoint: 'disabled' });
    expect(sh(env, CREDS).output).toContain('403 - Forbidden');
    expect(sh(env, 'aws sts get-caller-identity').errorCode).toBe('NoCredentials');
  });

  it('modify-instance-metadata-options validates and is recorded', () => {
    const env = guardDutyEnv();
    expect(code(() => modifyInstanceMetadataOptions(env, adminId(env), { httpTokens: 'always' as never }))).toBe('InvalidParameterValue');
    expect(code(() => modifyInstanceMetadataOptions(env, adminId(env), { httpPutResponseHopLimit: 65 }))).toBe('InvalidParameterValue');
    expect(code(() => modifyInstanceMetadataOptions(env, 'i-nope', { httpTokens: 'required' }))).toBe('InvalidInstanceID.NotFound');
    withActor(iamUserActor(env, 'learner', '198.51.100.24'), Date.now(), () => modifyInstanceMetadataOptions(env, adminId(env), { httpPutResponseHopLimit: 2 }));
    expect(byName(env.instances, 'admin-1')!.metadataOptions).toEqual({ httpTokens: 'optional', httpPutResponseHopLimit: 2, httpEndpoint: 'enabled' });
    expect(env.trailEvents.at(-1)?.eventName).toBe('ModifyInstanceMetadataOptions');
  });
});

describe('revoking role sessions', () => {
  it('adds AWSRevokeOlderSessions denying credentials issued before now (+30 s)', () => {
    const env = guardDutyEnv();
    expect(sessionsRevokedBefore(env, ADMIN_ROLE)).toBeUndefined();
    const now = Date.parse('2026-11-20T03:00:00Z');
    expect(revokeOlderSessions(env, ADMIN_ROLE, now)).toBe('2026-11-20T03:00:30Z');
    expect(sessionsRevokedBefore(env, ADMIN_ROLE)).toBe(now + 30_000);
    // the same policy written by hand with the CLI (Action as a string) counts too
    const role = env.iamRoles.find((r) => r.roleName === ADMIN_ROLE)!;
    role.inlinePolicies = [{ policyName: 'revoke', document: { Version: '2012-10-17', Statement: { Effect: 'Deny', Action: '*', Resource: '*', Condition: { DateLessThan: { 'aws:TokenIssueTime': '2026-11-20T04:00:00Z' } } } } }];
    expect(sessionsRevokedBefore(env, ADMIN_ROLE)).toBe(Date.parse('2026-11-20T04:00:00Z'));
    expect(code(() => revokeOlderSessions(env, 'nope'))).toBe('NoSuchEntity');
  });
});
