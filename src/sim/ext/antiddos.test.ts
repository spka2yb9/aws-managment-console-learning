import { iamUserActor, withActor } from '../cloudtrail';
import { getMetricData, lbDimension, metricFor } from '../cloudwatch';
import { updateWebAcl } from '../edge';
import { CURL_CLIENT, simulateHttp } from '../http';
import type { AwsEnv, WafRule } from '../types';
import { ANTI_DDOS, DEFAULT_EXEMPT, defaultAntiDdosConfig, exemptTarget, isExempt, normalizePath, NS, originResponseTime, sampledRequests, wafTrafficAt } from './antiddos';
import { ACL_NAME, antiDdosEnv, APP_UA } from './antiddos-scenario';

const acl = (env: AwsEnv) => env.webAcls.find((a) => a.name === ACL_NAME)!;
const shop = (env: AwsEnv, path = '/') => `https://${env.distributions[0].domainName}${path}`;
const antiDdosRule = (o: { count?: boolean; exempt?: string[] } = {}): WafRule => ({
  name: 'AWS-AWSManagedRulesAntiDDoSRuleSet',
  priority: 0,
  action: 'Block',
  statement: {
    kind: 'managed',
    vendor: 'AWS',
    name: ANTI_DDOS,
    antiDdos: { ...defaultAntiDdosConfig(), challenge: { usage: 'ENABLED', sensitivity: 'HIGH', exemptUriRegex: o.exempt ?? [DEFAULT_EXEMPT] } },
    ruleActionOverrides: o.count ? ['ChallengeAllDuringEvent', 'ChallengeDDoSRequests', 'DDoSRequests'].map((name) => ({ name, action: 'Count' as const })) : [],
  },
});
/** the rule group on top, the old rules after it */
const withGroup = (env: AwsEnv, rule: WafRule) => [rule, ...acl(env).rules.filter((r) => r.statement.kind !== 'managed' || r.statement.name !== ANTI_DDOS).map((r, n) => ({ ...r, priority: n + 1 }))];

describe('AWS WAF Anti-DDoS (lesson 42)', () => {
  let now = Date.now();
  const later = (ms: number) => {
    now += ms;
    vi.setSystemTime(now);
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    now = Date.now();
  });
  afterEach(() => vi.useRealTimers());

  it('the flood: thousands of slow IPs slip under the per-IP rate rule and the shop times out', () => {
    const env = antiDdosEnv();
    const r = simulateHttp(env, shop(env));
    expect(r.status).toBe(504);
    expect(originResponseTime(env, 'web-alb', now)).toBeGreaterThan(1.5);
    const samples = sampledRequests(env, acl(env), now - 60_000, now);
    expect(samples.length).toBe(100);
    expect(samples.every((s) => s.action === 'ALLOW' && !s.rule)).toBe(true);
    expect(new Set(samples.map((s) => s.clientIp)).size).toBeGreaterThan(50);
  });

  it('Count mode labels the requests but changes nothing', () => {
    const env = antiDdosEnv();
    updateWebAcl(env, acl(env).arn, { rules: withGroup(env, antiDdosRule({ count: true })) }, now);
    later(10_000);
    expect(simulateHttp(env, shop(env)).status).toBe(504);
    const group = sampledRequests(env, acl(env), now - 10_000, now, (s) => s.rule === 'AWS-AWSManagedRulesAntiDDoSRuleSet');
    expect(group.length).toBeGreaterThan(5);
    expect(group.every((s) => s.action === 'COUNT' && s.labels?.includes(NS + 'event-detected'))).toBe(true);
    const app = group.find((s) => s.userAgent === APP_UA);
    expect(app).toMatchObject({ ruleWithinGroup: 'ChallengeAllDuringEvent', overriddenAction: 'CHALLENGE' });
    expect(group.some((s) => s.labels?.includes(NS + 'high-suspicion-ddos-request'))).toBe(true);
    // samples before the change were judged by the old rules
    expect(sampledRequests(env, acl(env), now - 60_000, now - 10_001).every((s) => !s.labels)).toBe(true);
  });

  it('enabled with the app exempted: browsers pass the challenge, curl gets 202, the app and the shop work', () => {
    const env = antiDdosEnv();
    withActor(iamUserActor(env, 'learner', '198.51.100.24'), now, () => updateWebAcl(env, acl(env).arn, { rules: withGroup(env, antiDdosRule({ exempt: [DEFAULT_EXEMPT, '/app/'] })) }, now));
    later(10_000);
    const browser = simulateHttp(env, shop(env));
    expect(browser.status).toBe(200);
    expect(browser.effects?.waf?.sample.labels).toContain('awswaf:managed:token:accepted');
    const curl = simulateHttp(env, shop(env), undefined, CURL_CLIENT);
    expect(curl).toMatchObject({ status: 202, headers: expect.objectContaining({ 'x-amzn-waf-action': 'challenge' }) });
    expect(simulateHttp(env, shop(env, '/app/v1/products'), undefined, CURL_CLIENT).status).toBe(200);
    const w = wafTrafficAt(env, acl(env), now)!;
    expect(w.allowed).toBeCloseTo(115);
    expect(w.challenged).toBeCloseTo(1900);
    expect(w.blocked).toBeCloseTo(150);
    const samples = sampledRequests(env, acl(env), now - 10_000, now);
    expect(samples.some((s) => s.action === 'CHALLENGE' && s.ruleWithinGroup === 'ChallengeAllDuringEvent')).toBe(true);
    expect(samples.some((s) => s.action === 'BLOCK' && s.ruleWithinGroup === 'DDoSRequests')).toBe(true);
    expect(samples.filter((s) => s.userAgent === APP_UA).every((s) => s.action === 'ALLOW' && !s.labels?.includes(NS + 'challengeable-request'))).toBe(true);
    const lb = env.loadBalancers[0];
    expect(getMetricData(env, metricFor('AWS/ApplicationELB', 'RequestCount', lbDimension(lb)), { start: now, end: now, period: 60, stat: 'Sum' })[0].v).toBeLessThan(200 * 60);
    expect(env.trailEvents.at(-1)).toMatchObject({ eventName: 'UpdateWebACL' });
  });

  it('without the exemption the app is challenged; ^/app/ never matches because the host comes first', () => {
    const env = antiDdosEnv();
    updateWebAcl(env, acl(env).arn, { rules: withGroup(env, antiDdosRule({ exempt: [DEFAULT_EXEMPT, '^/app/'] })) }, now);
    later(5000);
    expect(simulateHttp(env, shop(env, '/app/v1/products'), undefined, CURL_CLIENT).status).toBe(202);
    const host = env.distributions[0].domainName;
    expect(exemptTarget(host, '/app/v1/products?x=1')).toBe(`${host}/app/v1/products`);
    expect(isExempt({ ...defaultAntiDdosConfig(), challenge: { usage: 'ENABLED', sensitivity: 'HIGH', exemptUriRegex: ['^/app/'] } }, host, '/app/v1/products')).toBe(false);
    expect(isExempt(defaultAntiDdosConfig(), host, '/api/orders/')).toBe(true);
    expect(normalizePath('/a//./b/../c/')).toBe('/a/c');
  });

  it('rejects what AWS rejects', () => {
    const env = antiDdosEnv();
    const bad = (patch: (r: WafRule & { statement: { kind: 'managed' } }) => void) => {
      const r = antiDdosRule() as WafRule & { statement: { kind: 'managed' } };
      patch(r);
      return () => updateWebAcl(env, acl(env).arn, { rules: withGroup(env, r) }, now);
    };
    expect(bad((r) => (r.statement.ruleActionOverrides = [{ name: 'ChallengeAllDuringEvent', action: 'Block' }]))).toThrow(/WAFInvalidParameterException|can only be overridden/);
    expect(bad((r) => (r.statement.antiDdos!.challenge.exemptUriRegex = ['(']))).toThrow(/REGEX_STRING/);
    expect(bad((r) => (r.statement.antiDdos = undefined))).toThrow(/MANAGED_RULE_GROUP_CONFIG/);
    expect(bad((r) => (r.priority = 1))).toThrow(/Duplicate value/);
    expect(acl(env).rules.length).toBe(2);
  });
});
