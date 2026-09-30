import { execCli } from './cli';
import { byName } from './env';
import { simulateHttp } from './http';
import { evaluateIamPermission, parsePolicy, updateAssumeRolePolicy, updatePolicyDocument } from './iam';
import { bucketNameProblem, deleteObject, objectUrl, putBucketPolicy, putBucketVersioning, putObject, putPublicAccessBlock, s3GetObject } from './s3';
import { REPORTS_BUCKET, s3IamEnv } from './scenarios';
import type { AwsEnv } from './types';

const KEY = 'reports/2026/09/report-2026-09-28.csv';
const role = { type: 'role' as const, roleName: 'batch-role', sessionName: 'i-1' };
const batch = (env: AwsEnv) => byName(env.instances, 'batch-1')!.instanceId;
const sh = (env: AwsEnv, cmd: string) => execCli(env, batch(env), cmd, { 'app.log': 'ok' });
const policyArn = (env: AwsEnv) => env.iamPolicies.find((p) => p.policyName === 'batch-s3-read')!.arn;

describe('IAM policy evaluation (Phase 9)', () => {
  it('identity policy allows; wrong resource → implicit deny with the AWS reason', () => {
    const env = s3IamEnv();
    const req = { principal: role, action: 's3:GetObject', resource: `arn:aws:s3:::${REPORTS_BUCKET}/${KEY}` };
    expect(evaluateIamPermission(env, req).decision).toBe('Allow');
    updatePolicyDocument(env, policyArn(env), { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::webapp-report-123456789012/*' }] });
    const d = evaluateIamPermission(env, req);
    expect(d.decision).toBe('ImplicitDeny');
    expect(d.reason).toBe('because no identity-based policy allows the s3:GetObject action');
    expect(d.statements[0].mismatch).toBe('Resource');
  });

  it('explicit deny in the bucket policy beats any allow', () => {
    const env = s3IamEnv({ bucketPolicy: [{ Sid: 'DenyOldBatch', Effect: 'Deny', Principal: { AWS: 'arn:aws:iam::123456789012:role/batch-role' }, Action: 's3:*', Resource: [`arn:aws:s3:::${REPORTS_BUCKET}`, `arn:aws:s3:::${REPORTS_BUCKET}/*`] }] });
    const d = evaluateIamPermission(env, { principal: role, action: 's3:GetObject', resource: `arn:aws:s3:::${REPORTS_BUCKET}/${KEY}`, resourcePolicy: env.buckets[0].policy });
    expect(d.decision).toBe('ExplicitDeny');
    expect(d.reason).toBe('with an explicit deny in a resource-based policy');
  });

  it('actions are case-insensitive wildcards; NotAction; resource policy naming the role grants; ...:root only delegates', () => {
    const env = s3IamEnv({ batchPolicy: [{ Effect: 'Allow', NotAction: 's3:Delete*', Resource: '*' }] });
    expect(evaluateIamPermission(env, { principal: role, action: 'S3:getobject', resource: 'arn:aws:s3:::x/y' }).decision).toBe('Allow');
    expect(evaluateIamPermission(env, { principal: role, action: 's3:DeleteObject', resource: 'arn:aws:s3:::x/y' }).decision).toBe('ImplicitDeny');
    const env2 = s3IamEnv({ batchPolicy: [{ Effect: 'Allow', Action: 'ec2:DescribeInstances', Resource: '*' }] });
    const res = `arn:aws:s3:::${REPORTS_BUCKET}/${KEY}`;
    const viaRoot = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' as const, Principal: { AWS: 'arn:aws:iam::123456789012:root' }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${REPORTS_BUCKET}/*` }] };
    expect(evaluateIamPermission(env2, { principal: role, action: 's3:GetObject', resource: res, resourcePolicy: viaRoot }).decision).toBe('ImplicitDeny');
    const viaRole = { Version: '2012-10-17', Statement: [{ Effect: 'Allow' as const, Principal: { AWS: 'arn:aws:iam::123456789012:role/batch-role' }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${REPORTS_BUCKET}/*` }] };
    expect(evaluateIamPermission(env2, { principal: role, action: 's3:GetObject', resource: res, resourcePolicy: viaRole }).decision).toBe('Allow');
  });

  it('conditions: deny non-TLS requests', () => {
    const env = s3IamEnv({ bucketPolicy: [{ Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: `arn:aws:s3:::${REPORTS_BUCKET}/*`, Condition: { Bool: { 'aws:SecureTransport': 'false' } } }] });
    const base = { principal: role, action: 's3:GetObject', resource: `arn:aws:s3:::${REPORTS_BUCKET}/${KEY}`, resourcePolicy: env.buckets[0].policy };
    expect(evaluateIamPermission(env, { ...base, context: { 'aws:SecureTransport': true } }).decision).toBe('Allow');
    expect(evaluateIamPermission(env, { ...base, context: { 'aws:SecureTransport': false } }).decision).toBe('ExplicitDeny');
  });

  it('validates documents like IAM / S3', () => {
    expect(() => parsePolicy('{', 'identity')).toThrow(/Syntax errors/);
    expect(() => parsePolicy('{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"*"}]}', 'identity')).toThrow(/should not specify a principal/);
    expect(() => parsePolicy('{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::b/*"}]}', 'resource', { bucket: 'b' })).toThrow(/Principal/);
    expect(() => parsePolicy('{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::other/*"}]}', 'resource', { bucket: 'b' })).toThrow(/invalid resource/);
    expect(() => parsePolicy('{"Statement":[{"Effect":"Allow","Action":"GetObject","Resource":"*"}]}', 'identity')).toThrow(/prefaced by a vendor/);
  });
});

describe('S3 (Phase 9)', () => {
  it('bucket names', () => {
    expect(bucketNameProblem('My-Bucket')).toMatch(/大文字/);
    expect(bucketNameProblem('ab')).toMatch(/3〜63/);
    expect(bucketNameProblem('192.168.0.1')).toMatch(/IP/);
    expect(bucketNameProblem('webapp-assets-2026')).toBeNull();
  });

  it('Block Public Access: public policy is refused, and RestrictPublicBuckets hides it from anonymous callers', () => {
    const env = s3IamEnv();
    const pub = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${REPORTS_BUCKET}/*` }] });
    expect(() => putBucketPolicy(env, REPORTS_BUCKET, pub, 'arn:aws:iam::123456789012:user/learner')).toThrow(/BlockPublicPolicy/);
    const url = objectUrl(env.buckets[0], KEY);
    expect(simulateHttp(env, url).status).toBe(403);
    putPublicAccessBlock(env, REPORTS_BUCKET, { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: true });
    putBucketPolicy(env, REPORTS_BUCKET, pub, 'arn:aws:iam::123456789012:user/learner');
    expect(simulateHttp(env, url).status).toBe(403);
    putPublicAccessBlock(env, REPORTS_BUCKET, { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: false });
    const r = simulateHttp(env, url);
    expect(r.status).toBe(200);
    expect(r.body).toMatch(/orders/);
  });

  it('missing key: 404 with s3:ListBucket, 403 without', () => {
    const env = s3IamEnv();
    const caller = { principal: role, context: {} };
    expect(() => s3GetObject(env, caller, REPORTS_BUCKET, 'nope.csv')).toThrow(/does not exist/);
    const env2 = s3IamEnv({ batchPolicy: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: `arn:aws:s3:::${REPORTS_BUCKET}/*` }] });
    expect(() => s3GetObject(env2, caller, REPORTS_BUCKET, 'nope.csv')).toThrow(/^Access Denied$/);
  });

  it('versioning keeps old versions and uses delete markers', () => {
    const env = s3IamEnv();
    putBucketVersioning(env, REPORTS_BUCKET, 'Enabled');
    putObject(env, REPORTS_BUCKET, 'a.txt', { size: 1, body: 'v1' });
    putObject(env, REPORTS_BUCKET, 'a.txt', { size: 1, body: 'v2' });
    deleteObject(env, REPORTS_BUCKET, 'a.txt');
    const versions = env.buckets[0].objects.filter((o) => o.key === 'a.txt');
    expect(versions).toHaveLength(3);
    expect(versions.find((o) => o.isLatest)?.deleteMarker).toBe(true);
    putBucketVersioning(env, REPORTS_BUCKET, 'Suspended');
    expect(env.buckets[0].versioning).toBe('Suspended');
  });
});

describe('EC2 CLI (EC2 Instance Connect)', () => {
  it('get-caller-identity shows the assumed role', () => {
    const env = s3IamEnv();
    const r = sh(env, 'aws sts get-caller-identity');
    expect(r.ok).toBe(true);
    expect(r.output).toContain(`arn:aws:sts::123456789012:assumed-role/batch-role/${batch(env)}`);
  });

  it('no profile / broken trust policy → no credentials; IMDS explains the trust problem', () => {
    expect(sh(s3IamEnv({ attachProfile: false }), 'aws sts get-caller-identity').output).toMatch(/Unable to locate credentials/);
    const env = s3IamEnv({ trustService: 'lambda.amazonaws.com' });
    expect(sh(env, 'aws s3 ls').output).toMatch(/Unable to locate credentials/);
    expect(sh(env, 'curl http://169.254.169.254/latest/meta-data/iam/security-credentials/batch-role').output).toMatch(/AssumeRoleUnauthorizedAccess/);
    updateAssumeRolePolicy(env, 'batch-role', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] });
    expect(sh(env, 'aws sts get-caller-identity').ok).toBe(true);
  });

  it('cp only says 403 (HeadObject); s3api get-object gives the reason; fixing the policy works', () => {
    const env = s3IamEnv({ batchPolicy: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: ['arn:aws:s3:::webapp-report-123456789012', 'arn:aws:s3:::webapp-report-123456789012/*'] }] });
    expect(sh(env, `aws s3 cp s3://${REPORTS_BUCKET}/${KEY} .`).output).toBe('fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden');
    const api = sh(env, `aws s3api get-object --bucket ${REPORTS_BUCKET} --key ${KEY} report.csv`);
    expect(api.errorCode).toBe('AccessDenied');
    expect(api.output).toMatch(/is not authorized to perform: s3:GetObject on resource: "arn:aws:s3:::webapp-reports-123456789012\/reports\/2026\/09\/report-2026-09-28.csv" because no identity-based policy allows the s3:GetObject action/);
    updatePolicyDocument(env, policyArn(env), { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: [`arn:aws:s3:::${REPORTS_BUCKET}`, `arn:aws:s3:::${REPORTS_BUCKET}/*`] }] });
    const ok = sh(env, `aws s3 cp s3://${REPORTS_BUCKET}/${KEY} .`);
    expect(ok.ok).toBe(true);
    expect(ok.file?.name).toBe('report-2026-09-28.csv');
    expect(sh(env, `aws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/`).output).toMatch(/report-2026-09-27\.csv/);
  });

  it('network path matters: no public IP → connect timeout', () => {
    const env = s3IamEnv({}, (e) => {
      byName(e.instances, 'batch-1')!.publicIpAddress = undefined;
      byName(e.instances, 'batch-1')!.associatePublicIpAddress = false;
    });
    expect(sh(env, 'aws s3 ls').output).toMatch(/Connect timeout on endpoint URL/);
  });

  it('shell basics', () => {
    const env = s3IamEnv();
    expect(sh(env, 'whoami').output).toBe('ec2-user');
    expect(sh(env, 'foo').output).toMatch(/command not found/);
    expect(sh(env, 'curl http://169.254.169.254/latest/meta-data/iam/security-credentials/').output).toBe('batch-role');
  });
});
