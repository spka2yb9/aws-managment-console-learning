import type { ConsoleExerciseContent, TaskContext } from '../lesson/types';
import { updateWebAcl } from '../sim/edge';
import { ANTI_DDOS_RULES, DEFAULT_EXEMPT, defaultAntiDdosConfig } from '../sim/ext/antiddos';
import { recordWafSample } from '../sim/edge';
import { simulateHttp, type HttpResult } from '../sim/http';
import type { AwsEnv, WafRule } from '../sim/types';
import { GROUP_RULE, groupRule, lesson42, shopDomain, webAcl } from './l42-anti-ddos';

const ctxOf = (env: AwsEnv, extra: Partial<TaskContext> = {}): TaskContext => ({ env, path: '', region: env.region, visited: [], copied: [], browser: [], commands: [], ...extra });
const exercises = lesson42.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');
const ACL = '/wafv2/webacls/webapp-acl';

/** what the console's add / edit page saves: the group (in the given state) on top, the old rules below */
function saveGroup(env: AwsEnv, o: { count: boolean; exempt: string[]; top?: boolean }, now: number) {
  const group: WafRule = {
    name: GROUP_RULE,
    priority: 0,
    action: 'Block',
    statement: { kind: 'managed', vendor: 'AWS', name: 'AWSManagedRulesAntiDDoSRuleSet', antiDdos: { ...defaultAntiDdosConfig(), challenge: { usage: 'ENABLED', sensitivity: 'HIGH', exemptUriRegex: o.exempt } }, ruleActionOverrides: o.count ? ANTI_DDOS_RULES.map((r) => ({ name: r.name, action: 'Count' as const })) : [] },
  };
  const others = webAcl(env)!.rules.filter((r) => r.name !== GROUP_RULE);
  const order = o.top === false ? [...others, group] : [group, ...others];
  updateWebAcl(env, webAcl(env)!.arn, { rules: order.map((r, priority) => ({ ...r, priority })) }, now);
}

describe('42 AWS WAF Anti-DDoS: solution', () => {
  let now = Date.now();
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = Date.now();
  });
  afterEach(() => vi.useRealTimers());
  const later = (ms: number) => vi.setSystemTime((now += ms));
  /** the store's browse(): apply the request's effects, newest first */
  const surf = (env: AwsEnv, history: HttpResult[], url: string) => {
    const r = simulateHttp(env, url);
    if (r.effects?.waf) recordWafSample(env, r.effects.waf.aclArn, r.effects.waf.sample);
    history.unshift(r);
    return history;
  };

  it('504 + samples + rules -> Anti-DDoS in Count on top, labels read -> /app/ exempted, protection on -> 200', () => {
    const env = lesson42.scenario();
    const [ex1, ex2, ex3] = exercises;
    const url = `https://${shopDomain(env)}/`;
    const h = surf(env, [], url);
    expect(h[0].status).toBe(504);
    expect(ex1.validate(ctxOf(env, { browser: h, visited: [ACL] })).ok).toBe(false); // rules tab not seen
    expect(ex1.validate(ctxOf(env, { browser: h, visited: [ACL, `${ACL}?tab=rules`] })).ok).toBe(true);

    // added live (no Count): told to use Count first
    saveGroup(env, { count: false, exempt: [DEFAULT_EXEMPT] }, now);
    expect(ex2.validate(ctxOf(env)).lines[0].text).toMatch(/カウントにせずに/);
    saveGroup(env, { count: true, exempt: [DEFAULT_EXEMPT], top: false }, now);
    expect(ex2.validate(ctxOf(env)).lines[0].text).toMatch(/一番上にない/);
    saveGroup(env, { count: true, exempt: [DEFAULT_EXEMPT] }, now);
    const labels = `${ACL}?tab=overview&rule=${GROUP_RULE}`;
    expect(ex2.validate(ctxOf(env)).ok).toBe(false); // labels not read yet
    expect(ex2.tasks.every((t) => t.done(ctxOf(env, { visited: [labels] })))).toBe(true);
    expect(ex2.validate(ctxOf(env, { visited: [labels] })).ok).toBe(true);
    later(5000);
    expect(surf(env, h, url)[0].status).toBe(504); // counting changes nothing

    // protection without the exemption: the app would be challenged
    saveGroup(env, { count: false, exempt: [DEFAULT_EXEMPT, '^/app/'] }, now);
    expect(ex3.validate(ctxOf(env)).lines[0].text).toMatch(/202/);
    saveGroup(env, { count: false, exempt: [DEFAULT_EXEMPT, '/app/'] }, now);
    expect(groupRule(env)?.statement.ruleActionOverrides).toEqual([]);
    expect(ex3.validate(ctxOf(env, { browser: h })).ok).toBe(false); // not reopened yet
    later(5000);
    surf(env, h, url);
    expect(h[0].status).toBe(200);
    expect(ex3.tasks.every((t) => t.done(ctxOf(env, { browser: h })))).toBe(true);
    expect(ex3.validate(ctxOf(env, { browser: h })).ok).toBe(true);
  });
});
