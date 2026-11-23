import { iamUserActor, withActor } from '../cloudtrail';
import { byName, getDb } from '../env';
import { modifyDbInstance } from '../rds';
import { setSecurityGroupRules } from '../sg';
import { advanceTime } from '../time';
import type { AwsEnv } from '../types';
import {
  asff,
  batchDisableStandards,
  batchUpdateFindings,
  controlStatus,
  createAutomationRule,
  enableSecurityHub,
  fresh,
  getFindings,
  hasSecurityHubTransitions,
  requireHub,
  securityScore,
  subscriptionArn,
  type Finding,
} from './securityhub';
import { NEWSLETTER_BUCKET, securityHubEnv } from './securityhub-scenario';

const sg = (env: AwsEnv, name: string) => byName(env.securityGroups, name)!;
const closeSsh = (env: AwsEnv) => {
  const g = sg(env, 'web-sg');
  setSecurityGroupRules(env, g.groupId, 'ingress', g.ingress.filter((r) => r.fromPort !== 22).map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)!, description: r.description })));
};
const assetsFinding = (env: AwsEnv) => env.securityHub!.findings.find((f) => f.controlId === 'S3.8' && f.resource.id === `arn:aws:s3:::${NEWSLETTER_BUCKET}`)!;
const devFinding = (env: AwsEnv, control: string) => env.securityHub!.findings.find((f) => f.controlId === control && f.resource.tags.Name === 'dev-sandbox')!;
const ids = (f: Finding) => [{ Id: f.id, ProductArn: f.productArn }];

describe('Security Hub CSPM', () => {
  it('is off until enabled', () => {
    const env = securityHubEnv();
    expect(() => requireHub(env)).toThrow(/not subscribed to AWS Security Hub/);
    expect(hasSecurityHubTransitions(env)).toBe(false);
    expect(fresh(env)).toBe(env);
  });

  it('enabling turns on FSBP and CIS v1.2.0, evaluates the controls and imports the queued GuardDuty finding', () => {
    const env = securityHubEnv();
    enableSecurityHub(env);
    expect(env.securityHub!.standards.map((s) => s.key)).toEqual(['fsbp', 'cis']);
    const status = (id: string) => controlStatus(env, id);
    for (const id of ['EC2.2', 'EC2.8', 'EC2.9', 'EC2.13', 'EC2.18', 'EC2.19', 'RDS.2', 'S3.8']) expect(status(id), id).toBe('FAILED');
    for (const id of ['IAM.1', 'RDS.3', 'RDS.5', 'RDS.11']) expect(status(id), id).toBe('PASSED');
    expect(securityScore(env, 'fsbp')).toEqual({ score: 36, passed: 4, total: 11 });
    expect(securityScore(env)).toEqual({ score: 33, passed: 4, total: 12 });
    // a control without resources gets one PASSED finding for the account
    expect(env.securityHub!.findings.find((f) => f.controlId === 'IAM.1')!.resource.type).toBe('AwsAccount');
    const gd = env.securityHub!.findings.find((f) => f.productName === 'GuardDuty')!;
    expect(gd.resource.tags.Environment).toBe('dev');
    expect(env.securityHub!.queued).toEqual([]);
    expect(() => enableSecurityHub(env)).toThrow(/already subscribed/);
    expect(hasSecurityHubTransitions(env)).toBe(false);
  });

  it('fixing resources passes the controls, resolves the findings and raises the score; a regression reopens them', () => {
    const env = securityHubEnv();
    enableSecurityHub(env);
    closeSsh(env);
    modifyDbInstance(env, 'webapp-db', { publiclyAccessible: false });
    expect(hasSecurityHubTransitions(env)).toBe(true);
    // readers see the new result before the clock ticks
    expect(controlStatus(fresh(env), 'EC2.19')).toBe('PASSED');
    advanceTime(env, Date.now());
    for (const id of ['EC2.13', 'EC2.18', 'EC2.19', 'RDS.2']) expect(controlStatus(env, id), id).toBe('PASSED');
    const web = env.securityHub!.findings.find((f) => f.controlId === 'EC2.19' && f.resource.id.endsWith(sg(env, 'web-sg').groupId))!;
    expect(web.workflow).toBe('RESOLVED');
    expect(securityScore(env, 'fsbp').score).toBe(64);
    // SSH opened again: FAILED, and the resolved finding is NEW again
    const g = sg(env, 'web-sg');
    setSecurityGroupRules(env, g.groupId, 'ingress', [...g.ingress.map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)! })), { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '0.0.0.0/0' }]);
    advanceTime(env, Date.now());
    expect(web.compliance).toBe('FAILED');
    expect(env.securityHub!.findings.find((f) => f.id === web.id)!.workflow).toBe('NEW');
  });

  it('suppressed findings do not count: the control passes and the score goes up; the note is kept', () => {
    const env = securityHubEnv();
    enableSecurityHub(env);
    const f = assetsFinding(env);
    const before = f.updatedAt;
    const r = batchUpdateFindings(env, ids(f), { Workflow: { Status: 'SUPPRESSED' }, Note: { Text: 'public on purpose', UpdatedBy: 'learner' } }, before + 5000);
    expect(r.processed).toHaveLength(1);
    expect(assetsFinding(env).workflow).toBe('SUPPRESSED');
    expect(assetsFinding(env).note).toEqual({ text: 'public on purpose', updatedBy: 'learner', updatedAt: before + 5000 });
    expect(assetsFinding(env).updatedAt).toBe(before);
    expect(controlStatus(env, 'S3.8')).toBe('PASSED');
    expect(securityScore(env, 'fsbp').passed).toBe(5);
    expect(asff(env, assetsFinding(env)).Note?.Text).toBe('public on purpose');
  });

  it('BatchUpdateFindings validates its input and reports unknown findings', () => {
    const env = securityHubEnv();
    enableSecurityHub(env);
    const f = assetsFinding(env);
    expect(() => batchUpdateFindings(env, ids(f), { Workflow: { Status: 'IGNORED' } })).toThrow(/Workflow.Status/);
    expect(() => batchUpdateFindings(env, ids(f), { Note: { Text: 'x' } })).toThrow(/UpdatedBy/);
    const r = batchUpdateFindings(env, [{ Id: 'nope', ProductArn: f.productArn }], { Workflow: { Status: 'NOTIFIED' } });
    expect(r.unprocessed[0].ErrorCode).toBe('FindingNotFound');
  });

  it('GetFindings filters: EQUALS ORed, NOT_EQUALS ANDed, resource tags', () => {
    const env = securityHubEnv();
    enableSecurityHub(env);
    const critical = getFindings(env, { SeverityLabel: [{ Value: 'CRITICAL', Comparison: 'EQUALS' }], ComplianceStatus: [{ Value: 'FAILED', Comparison: 'EQUALS' }] });
    expect(critical.map((f) => f.controlId).sort()).toEqual(['EC2.19', 'RDS.2']);
    const either = getFindings(env, { ComplianceSecurityControlId: [{ Value: 'RDS.2', Comparison: 'EQUALS' }, { Value: 'RDS.5', Comparison: 'EQUALS' }] });
    expect(either).toHaveLength(2);
    const notPassed = getFindings(env, { ComplianceStatus: [{ Value: 'PASSED', Comparison: 'NOT_EQUALS' }], WorkflowStatus: [{ Value: 'SUPPRESSED', Comparison: 'NOT_EQUALS' }, { Value: 'RESOLVED', Comparison: 'NOT_EQUALS' }] });
    expect(notPassed.every((f) => f.compliance !== 'PASSED')).toBe(true);
    expect(notPassed.some((f) => f.productName === 'GuardDuty')).toBe(true);
    const dev = getFindings(env, { ResourceTags: [{ Key: 'Environment', Value: 'dev', Comparison: 'EQUALS' }], ComplianceStatus: [{ Value: 'FAILED', Comparison: 'EQUALS' }] });
    expect(dev.map((f) => f.controlId).sort()).toEqual(['EC2.8', 'EC2.9']);
    expect(getFindings(env, { ComplianceAssociatedStandardsId: [{ Value: 'ruleset/cis', Comparison: 'PREFIX' }] }).every((f) => ['EC2.2', 'EC2.13', 'IAM.1'].includes(f.controlId!))).toBe(true);
    expect(() => getFindings(env, { SeverityLabel: [{ Value: 'HIGH', Comparison: 'IS' }] })).toThrow(/Comparison 'IS'/);
  });

  it('automation rules apply to findings created or updated after the rule, in rule order', () => {
    const env = securityHubEnv();
    enableSecurityHub(env);
    const criteria = { ResourceTags: [{ Key: 'Environment', Value: 'dev', Comparison: 'EQUALS' }] };
    createAutomationRule(env, { ruleName: 'dev-low', description: 'dev is low priority', ruleOrder: 1, criteria, actions: [{ Type: 'FINDING_FIELDS_UPDATE', FindingFieldsUpdate: { Severity: { Label: 'LOW' }, Note: { Text: 'dev environment', UpdatedBy: 'automation' } } }] }, 'learner');
    createAutomationRule(env, { ruleName: 'later', description: 'runs after', ruleOrder: 2, criteria, actions: [{ Type: 'FINDING_FIELDS_UPDATE', FindingFieldsUpdate: { Workflow: { Status: 'NOTIFIED' } } }] }, 'learner');
    // existing findings are not touched
    expect(devFinding(env, 'EC2.9').severity).toBe('HIGH');
    // the dev sandbox changes (a tag): its findings are checked again, and the rules run
    byName(env.instances, 'dev-sandbox')!.tags.push({ key: 'Owner', value: 'dev-team' });
    advanceTime(env, Date.now());
    expect(devFinding(env, 'EC2.9').severity).toBe('LOW');
    expect(devFinding(env, 'EC2.9').note?.text).toBe('dev environment');
    expect(devFinding(env, 'EC2.9').workflow).toBe('NOTIFIED');
    expect(asff(env, devFinding(env, 'EC2.9')).FindingProviderFields.Severity.Label).toBe('HIGH');
    expect(() => createAutomationRule(env, { ruleName: 'x', description: 'x', ruleOrder: 0, criteria, actions: [{ Type: 'FINDING_FIELDS_UPDATE', FindingFieldsUpdate: { Severity: { Label: 'LOW' } } }] }, 'learner')).toThrow(/RuleOrder/);
    expect(() => createAutomationRule(env, { ruleName: 'x', description: 'x', ruleOrder: 3, criteria: {}, actions: [{ Type: 'FINDING_FIELDS_UPDATE', FindingFieldsUpdate: { Severity: { Label: 'LOW' } } }] }, 'learner')).toThrow(/Criteria/);
  });

  it('disabling a standard archives the findings of controls only it had', () => {
    const env = securityHubEnv();
    enableSecurityHub(env);
    batchDisableStandards(env, [subscriptionArn(env, 'cis')]);
    expect(env.securityHub!.findings.filter((f) => f.controlId === 'EC2.13').every((f) => f.recordState === 'ARCHIVED')).toBe(true);
    expect(controlStatus(env, 'EC2.13')).toBe('NO_DATA');
    expect(controlStatus(env, 'EC2.2')).toBe('FAILED');
  });

  it('records API calls in CloudTrail', () => {
    const env = securityHubEnv();
    withActor(iamUserActor(env, 'learner', '198.51.100.24'), Date.now(), () => enableSecurityHub(env));
    expect(env.trailEvents.at(-1)).toMatchObject({ eventName: 'EnableSecurityHub', eventSource: 'securityhub.amazonaws.com' });
    expect(getDb(env, 'webapp-db').publiclyAccessible).toBe(true);
  });
});
