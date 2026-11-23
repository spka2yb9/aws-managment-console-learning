import { iamUserActor, withActor } from '../cloudtrail';
import { createRole, detachPolicy } from '../iam';
import { deleteBucketPolicy, putPublicAccessBlock } from '../s3';
import { advanceTime } from '../time';
import { applyArchiveRule, createAnalyzer, createArchiveRule, deleteRoleWithPolicies, getAnalyzer, RESCAN_DELAY_MS, startResourceScan, updateFindings, type Finding } from './accessanalyzer';
import { accessAnalyzerEnv, EC2_READONLY, EXCHANGE_BUCKET, EXPORTS_BUCKET, PARTNER_ACCOUNT, PARTNER_ROLE, VENDOR_ACCOUNT, VENDOR_ROLE } from './accessanalyzer-scenario';

const roleArn = (name: string) => `arn:aws:iam::123456789012:role/${name}`;
const of = (fs: Finding[], resource: string) => fs.filter((f) => f.resource === resource);

describe('external access analyzer', () => {
  it('reports what is shared outside the account, and nothing that stays inside', () => {
    const env = accessAnalyzerEnv();
    const a = getAnalyzer(env, createAnalyzer(env, { name: 'webapp-external', type: 'ACCOUNT' }));
    expect(a.arn).toBe('arn:aws:access-analyzer:ap-northeast-1:123456789012:analyzer/webapp-external');
    const fs = a.findings;
    expect(fs.map((f) => f.resource).sort()).toEqual([`arn:aws:s3:::${EXCHANGE_BUCKET}`, `arn:aws:s3:::${EXPORTS_BUCKET}`, roleArn(VENDOR_ROLE), roleArn(PARTNER_ROLE)].sort());
    expect(fs.every((f) => f.status === 'ACTIVE' && f.findingType === 'ExternalAccess')).toBe(true);
    // two statements for the same principal are one finding
    expect(of(fs, `arn:aws:s3:::${EXCHANGE_BUCKET}`)[0]).toMatchObject({ principal: { AWS: PARTNER_ACCOUNT }, action: ['s3:GetObject', 's3:ListBucket', 's3:PutObject'], isPublic: false, sources: [{ type: 'POLICY' }] });
    expect(of(fs, `arn:aws:s3:::${EXPORTS_BUCKET}`)[0]).toMatchObject({ principal: { AWS: '*' }, isPublic: true });
    expect(of(fs, roleArn(PARTNER_ROLE))[0]).toMatchObject({ principal: { AWS: PARTNER_ACCOUNT }, condition: { 'sts:ExternalId': 'hayate-webapp-2026' }, action: ['sts:AssumeRole'] });
    expect(of(fs, roleArn(VENDOR_ROLE))[0].principal).toEqual({ AWS: VENDOR_ACCOUNT });
  });

  it('an archive rule archives new findings; apply-archive-rule archives the existing ones', () => {
    const env = accessAnalyzerEnv();
    const arn = createAnalyzer(env, { name: 'ext', type: 'ACCOUNT' });
    createArchiveRule(env, 'ext', 'partner-hayate', { 'principal.AWS': { eq: [PARTNER_ACCOUNT] } });
    expect(getAnalyzer(env, arn).findings.filter((f) => f.status === 'ARCHIVED')).toHaveLength(0);
    expect(applyArchiveRule(env, arn, 'partner-hayate')).toBe(2);
    const a = getAnalyzer(env, arn);
    expect(a.findings.filter((f) => f.status === 'ACTIVE').map((f) => f.resource).sort()).toEqual([`arn:aws:s3:::${EXPORTS_BUCKET}`, roleArn(VENDOR_ROLE)].sort());
    // a new role trusted by the partner is archived as soon as it is found
    createRole(env, { roleName: 'partner-report-role', trustPolicy: { Statement: [{ Effect: 'Allow', Principal: { AWS: PARTNER_ACCOUNT }, Action: 'sts:AssumeRole' }] } });
    startResourceScan(env, arn, roleArn('partner-report-role'));
    expect(of(getAnalyzer(env, arn).findings, roleArn('partner-report-role'))[0].status).toBe('ARCHIVED');
    // archiving by hand and back
    const id = of(a.findings, `arn:aws:s3:::${EXPORTS_BUCKET}`)[0].id;
    updateFindings(env, arn, { status: 'ARCHIVED', ids: [id] });
    updateFindings(env, arn, { status: 'ACTIVE', ids: [id] });
    expect(of(getAnalyzer(env, arn).findings, `arn:aws:s3:::${EXPORTS_BUCKET}`)[0].status).toBe('ACTIVE');
  });

  it('fixing the policy resolves the finding: after the next analysis, or at once with a rescan', () => {
    const env = accessAnalyzerEnv();
    const t0 = Date.now();
    const arn = createAnalyzer(env, { name: 'ext', type: 'ACCOUNT' }, t0);
    const exports = () => of(getAnalyzer(env, arn).findings, `arn:aws:s3:::${EXPORTS_BUCKET}`)[0];
    deleteBucketPolicy(env, EXPORTS_BUCKET);
    advanceTime(env, t0 + 1000);
    advanceTime(env, t0 + 2000);
    expect(exports().status).toBe('ACTIVE');
    advanceTime(env, t0 + 2000 + RESCAN_DELAY_MS);
    expect(exports().status).toBe('RESOLVED');

    // the other fix: RestrictPublicBuckets makes the public policy useless to outsiders
    const env2 = accessAnalyzerEnv();
    const arn2 = createAnalyzer(env2, { name: 'ext', type: 'ACCOUNT' });
    putPublicAccessBlock(env2, EXPORTS_BUCKET, { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: true, restrictPublicBuckets: true });
    startResourceScan(env2, arn2, `arn:aws:s3:::${EXPORTS_BUCKET}`);
    expect(of(getAnalyzer(env2, arn2).findings, `arn:aws:s3:::${EXPORTS_BUCKET}`)[0].status).toBe('RESOLVED');
    // the partner's access is untouched
    expect(of(getAnalyzer(env2, arn2).findings, `arn:aws:s3:::${EXCHANGE_BUCKET}`)[0].status).toBe('ACTIVE');
  });

  it('rejects what AWS rejects', () => {
    const env = accessAnalyzerEnv();
    createAnalyzer(env, { name: 'ext', type: 'ACCOUNT' });
    expect(() => createAnalyzer(env, { name: 'ext', type: 'ACCOUNT_UNUSED_ACCESS' })).toThrow(expect.objectContaining({ code: 'ConflictException' }));
    expect(() => createAnalyzer(env, { name: 'ext2', type: 'ACCOUNT' })).toThrow(expect.objectContaining({ code: 'ServiceQuotaExceededException' }));
    expect(() => createAnalyzer(env, { name: 'x', type: 'BUCKET' })).toThrow(expect.objectContaining({ code: 'ValidationException' }));
    expect(() => createAnalyzer(env, { name: '1bad', type: 'ACCOUNT_UNUSED_ACCESS' })).toThrow(expect.objectContaining({ code: 'ValidationException' }));
    expect(() => createAnalyzer(env, { name: 'unused', type: 'ACCOUNT_UNUSED_ACCESS', unusedAccessAge: 400 })).toThrow(expect.objectContaining({ code: 'ValidationException' }));
    expect(() => createArchiveRule(env, 'ext', 'r', { status: { eq: ['ACTIVE'] } })).toThrow(expect.objectContaining({ code: 'ValidationException' }));
    expect(() => createArchiveRule(env, 'ext', 'r', { 'principal.AWS': {} })).toThrow(expect.objectContaining({ code: 'ValidationException' }));
    expect(() => getAnalyzer(env, 'nope')).toThrow(expect.objectContaining({ code: 'ResourceNotFoundException' }));
  });

  it('mutating calls are recorded in CloudTrail as access-analyzer events', () => {
    const env = accessAnalyzerEnv();
    withActor(iamUserActor(env, 'learner', '198.51.100.24'), Date.now(), () => createAnalyzer(env, { name: 'ext', type: 'ACCOUNT' }));
    expect(env.trailEvents.at(-1)).toMatchObject({ eventName: 'CreateAnalyzer', eventSource: 'access-analyzer.amazonaws.com', awsRegion: 'ap-northeast-1' });
  });
});

describe('unused access analyzer', () => {
  it('reports the unused role and the unused services of a used role', () => {
    const env = accessAnalyzerEnv();
    const a = getAnalyzer(env, createAnalyzer(env, { name: 'unused', type: 'ACCOUNT_UNUSED_ACCESS', unusedAccessAge: 90 }));
    expect(a.unusedAccessAge).toBe(90);
    expect(a.findings.map((f) => [f.findingType, f.resource.split('/').pop()]).sort()).toEqual([
      ['UnusedIAMRole', VENDOR_ROLE],
      ['UnusedPermission', 'batch-role'],
    ]);
    expect(a.findings.find((f) => f.findingType === 'UnusedPermission')!.unusedServices!.map((s) => s.serviceNamespace)).toEqual(['autoscaling', 'cloudwatch', 'ec2', 'elasticloadbalancing']);
    expect(a.findings.find((f) => f.findingType === 'UnusedIAMRole')!.lastAccessed).toBeLessThan(Date.now() - 199 * 86_400_000);
  });

  it('roles younger than the tracking period are not analyzed', () => {
    const env = accessAnalyzerEnv();
    createRole(env, { roleName: 'brand-new-role', trustPolicy: { Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] } });
    const a = getAnalyzer(env, createAnalyzer(env, { name: 'unused', type: 'ACCOUNT_UNUSED_ACCESS' }));
    expect(a.findings.some((f) => f.resource.endsWith('/brand-new-role'))).toBe(false);
    expect(() => startResourceScan(env, a.arn, roleArn(VENDOR_ROLE))).toThrow(expect.objectContaining({ code: 'ValidationException' }));
  });

  it('removing the unused access resolves the findings (unused and external) on the next analysis', () => {
    const env = accessAnalyzerEnv();
    const t0 = Date.now();
    const ext = createAnalyzer(env, { name: 'ext', type: 'ACCOUNT' }, t0);
    const unused = createAnalyzer(env, { name: 'unused', type: 'ACCOUNT_UNUSED_ACCESS' }, t0);
    detachPolicy(env, 'role', 'batch-role', EC2_READONLY);
    deleteRoleWithPolicies(env, VENDOR_ROLE);
    expect(env.iamRoles.some((r) => r.roleName === VENDOR_ROLE)).toBe(false);
    advanceTime(env, t0 + 1000);
    advanceTime(env, t0 + 1000 + RESCAN_DELAY_MS);
    expect(getAnalyzer(env, unused).findings.map((f) => f.status)).toEqual(['RESOLVED', 'RESOLVED']);
    expect(of(getAnalyzer(env, ext).findings, roleArn(VENDOR_ROLE))[0].status).toBe('RESOLVED');
    // nothing left to analyze: the clock does not move the findings any more
    expect(advanceTime(env, t0 + 10 * RESCAN_DELAY_MS)).toBe(false);
  });
});
