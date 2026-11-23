import type { ConsoleExerciseContent, TaskContext } from '../lesson/types';
import { byName } from '../sim/env';
import { batchUpdateFindings, createAutomationRule, enableSecurityHub } from '../sim/ext/securityhub';
import { modifyDbInstance } from '../sim/rds';
import { setSecurityGroupRules } from '../sim/sg';
import type { AwsEnv } from '../sim/types';
import { lesson44, newsletterFinding, scoreOf } from './l44-security-hub';

const ctxOf = (env: AwsEnv, visited: string[] = []): TaskContext => ({ env, path: '', region: env.region, visited, copied: [], browser: [], commands: [] });
const exercises = lesson44.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');
const rules = (env: AwsEnv) => byName(env.securityGroups, 'web-sg')!.ingress.map((r) => ({ securityGroupRuleId: r.securityGroupRuleId, ipProtocol: r.ipProtocol, fromPort: r.fromPort, toPort: r.toPort, source: (r.cidrIpv4 ?? r.referencedGroupId)!, description: r.description }));
const dev = { ResourceTags: [{ Key: 'Environment', Value: 'dev', Comparison: 'EQUALS' }] };

describe('44 Security Hub CSPM', () => {
  it('model solution: enable, look, fix the critical controls, suppress the accepted risk, add a rule', () => {
    const env = lesson44.scenario();
    const [enable, look, fix, suppress, rule] = exercises;
    for (const ex of exercises) expect(ex.validate(ctxOf(env)).ok, ex.title).toBe(false);

    enableSecurityHub(env);
    expect(enable.validate(ctxOf(env, ['/securityhub/home'])).ok).toBe(true);
    expect(scoreOf(env)).toMatchObject({ score: 33, passed: 4, total: 12 });

    expect(look.validate(ctxOf(env, ['/securityhub/controls'])).ok).toBe(false);
    expect(look.validate(ctxOf(env, ['/securityhub/controls', '/securityhub/controls/EC2.19'])).ok).toBe(true);

    // removing the ALB rule too breaks the site
    const web = byName(env.securityGroups, 'web-sg')!.groupId;
    const all = rules(env);
    setSecurityGroupRules(env, web, 'ingress', []);
    expect(fix.validate(ctxOf(env)).lines[0].text).toMatch(/3000/);
    setSecurityGroupRules(env, web, 'ingress', all.filter((r) => r.fromPort !== 22));
    expect(fix.validate(ctxOf(env)).ok).toBe(false);
    modifyDbInstance(env, 'webapp-db', { publiclyAccessible: false });
    expect(fix.validate(ctxOf(env)).ok).toBe(true);
    expect(scoreOf(env).score).toBe(67);

    const f = newsletterFinding(env)!;
    batchUpdateFindings(env, [{ Id: f.id, ProductArn: f.productArn }], { Workflow: { Status: 'SUPPRESSED' } });
    expect(suppress.validate(ctxOf(env)).lines[0].text).toMatch(/メモ/);
    batchUpdateFindings(env, [{ Id: f.id, ProductArn: f.productArn }], { Workflow: { Status: 'SUPPRESSED' }, Note: { Text: 'メールマガジンの画像用に公開', UpdatedBy: 'learner' } });
    expect(suppress.validate(ctxOf(env)).ok).toBe(true);
    expect(scoreOf(env).score).toBe(75);
    // suppressing everything else is not the fix
    const other = env.securityHub!.findings.find((x) => x.controlId === 'EC2.9' && x.compliance === 'FAILED')!;
    batchUpdateFindings(env, [{ Id: other.id, ProductArn: other.productArn }], { Workflow: { Status: 'SUPPRESSED' } });
    expect(suppress.validate(ctxOf(env)).ok).toBe(false);
    batchUpdateFindings(env, [{ Id: other.id, ProductArn: other.productArn }], { Workflow: { Status: 'NEW' } });

    const actions = [{ Type: 'FINDING_FIELDS_UPDATE', FindingFieldsUpdate: { Severity: { Label: 'LOW' }, Note: { Text: '開発環境', UpdatedBy: 'learner' } } }];
    createAutomationRule(env, { ruleName: 'off', description: 'x', ruleOrder: 1, ruleStatus: 'DISABLED', criteria: dev, actions }, 'learner');
    expect(rule.validate(ctxOf(env)).ok).toBe(false);
    createAutomationRule(env, { ruleName: 'dev-low-priority', description: '開発環境は優先度を下げる', ruleOrder: 2, criteria: dev, actions }, 'learner');
    expect(rule.validate(ctxOf(env)).ok).toBe(true);
  });
});
