import type { ConsoleExerciseContent, TaskContext } from '../lesson/types';
import { applyArchiveRule, createAnalyzer, createArchiveRule, deleteRoleWithPolicies, RESCAN_DELAY_MS, startResourceScan, updateFindings } from '../sim/ext/accessanalyzer';
import { EC2_READONLY, EXPORTS_BUCKET, PARTNER_ACCOUNT, VENDOR_ROLE } from '../sim/ext/accessanalyzer-scenario';
import { detachPolicy } from '../sim/iam';
import { BPA_ALL_ON, deleteBucketPolicy, putPublicAccessBlock } from '../sim/s3';
import { advanceTime } from '../sim/time';
import type { AwsEnv } from '../sim/types';
import { batchFinding, exportsFinding, EXPORTS_ARN, externalAnalyzer, lesson45, unusedAnalyzer } from './l45-access-analyzer';

const exercises = lesson45.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');
const ctxOf = (env: AwsEnv, visited: string[] = []): TaskContext => ({ env, path: '', region: env.region, visited, copied: [], browser: [], commands: [] });
const view = (kind: 'findings' | 'unused', analyzer: string, id: string) => `/iam/access-analyzer/${kind}/view?${new URLSearchParams({ analyzer, id })}`;

describe('45 IAM Access Analyzer: model solution', () => {
  it('create, archive the partner, close the public bucket, clean up unused access', () => {
    const env = lesson45.scenario();
    const t0 = Date.now();
    const visited: string[] = [];
    const [ex1, ex2, ex3, ex4, ex5] = exercises;

    // 1. external access analyzer
    createAnalyzer(env, { name: 'ExternalAccess-ConsoleAnalyzer-1', type: 'ACCOUNT' }, t0);
    expect(ex1.validate(ctxOf(env, visited)).ok).toBe(false);
    visited.push(view('findings', externalAnalyzer(env)!.name, exportsFinding(env)!.id));
    expect(ex1.validate(ctxOf(env, visited)).ok).toBe(true);

    // 2. archive rule for the partner; archiving the public bucket by hand is sent back
    const a = externalAnalyzer(env)!;
    expect(ex2.validate(ctxOf(env, visited)).ok).toBe(false);
    createArchiveRule(env, a.name, 'partner-hayate', { 'principal.AWS': { eq: [PARTNER_ACCOUNT] } });
    expect(ex2.validate(ctxOf(env, visited)).ok).toBe(false); // existing findings are not archived by a new rule
    applyArchiveRule(env, a.arn, 'partner-hayate');
    expect(ex2.validate(ctxOf(env, visited)).ok).toBe(true);
    updateFindings(env, a.arn, { status: 'ARCHIVED', ids: [exportsFinding(env)!.id] });
    expect(ex2.validate(ctxOf(env, visited)).ok).toBe(false);
    updateFindings(env, a.arn, { status: 'ACTIVE', ids: [exportsFinding(env)!.id] });

    // 3. close the public bucket; the finding is resolved after a rescan
    deleteBucketPolicy(env, EXPORTS_BUCKET);
    putPublicAccessBlock(env, EXPORTS_BUCKET, BPA_ALL_ON);
    expect(ex3.validate(ctxOf(env, visited)).ok).toBe(false);
    startResourceScan(env, a.arn, EXPORTS_ARN);
    expect(ex3.validate(ctxOf(env, visited)).ok).toBe(true);

    // 4. unused access analyzer
    createAnalyzer(env, { name: 'UnusedAccess-ConsoleAnalyzer-1', type: 'ACCOUNT_UNUSED_ACCESS', unusedAccessAge: 90 }, t0);
    expect(ex4.validate(ctxOf(env, visited)).ok).toBe(false);
    visited.push(view('unused', unusedAnalyzer(env)!.name, batchFinding(env)!.id));
    expect(ex4.validate(ctxOf(env, visited)).ok).toBe(true);

    // 5. clean up: removing batch-s3-read too would break the nightly batch
    deleteRoleWithPolicies(env, VENDOR_ROLE);
    detachPolicy(env, 'role', 'batch-role', 'arn:aws:iam::123456789012:policy/batch-s3-read');
    detachPolicy(env, 'role', 'batch-role', EC2_READONLY);
    expect(ex5.validate(ctxOf(env, visited)).ok).toBe(false);
    env.iamRoles.find((r) => r.roleName === 'batch-role')!.attachedPolicyArns.push('arn:aws:iam::123456789012:policy/batch-s3-read');
    expect(ex5.validate(ctxOf(env, visited)).ok).toBe(true);

    // a minute later every finding about removed access is resolved
    advanceTime(env, t0 + 1000);
    advanceTime(env, t0 + 1000 + RESCAN_DELAY_MS);
    expect(unusedAnalyzer(env)!.findings.map((f) => f.status)).toEqual(['RESOLVED', 'RESOLVED']);
    expect(externalAnalyzer(env)!.findings.filter((f) => f.status === 'ACTIVE')).toEqual([]);
  });

  it('a tracking period other than 90 days is sent back', () => {
    const env = lesson45.scenario();
    createAnalyzer(env, { name: 'unused', type: 'ACCOUNT_UNUSED_ACCESS', unusedAccessAge: 365 });
    expect(exercises[3].validate(ctxOf(env)).ok).toBe(false);
  });
});
