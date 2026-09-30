import { describe, expect, it } from 'vitest';
import { advanceEdge, certCovers, changeRecord, createInvalidation, createValidationRecords, requestCertificate, resolve, updateDistribution, updateIpSet } from './edge';
import { simulateHttp } from './http';
import { recordWafSample, storeInCache } from './edge';
import { cacheEnv, dnsEnv, httpsEnv, SHOP_DOMAIN, wafEnv } from './scenarios';
import type { AwsEnv } from './types';

/** browse like the console does: apply the request's effects */
const browse = (env: AwsEnv, url: string) => {
  const r = simulateHttp(env, url);
  if (r.effects?.cache) storeInCache(env, r.effects.cache.distributionId, r.effects.cache.entry);
  if (r.effects?.waf) recordWafSample(env, r.effects.waf.aclArn, r.effects.waf.sample);
  return r;
};

describe('Route 53', () => {
  it('resolves CNAMEs and aliases; an apex CNAME is rejected; alias targets must exist', () => {
    const env = dnsEnv();
    expect(simulateHttp(env, `http://www.${SHOP_DOMAIN}/`).status).toBe(200);
    expect(simulateHttp(env, `http://${SHOP_DOMAIN}/`).error).toBe('ERR_NAME_NOT_RESOLVED');
    const zone = env.hostedZones[0].id;
    const alb = env.loadBalancers[0].dnsName;
    expect(() => changeRecord(env, zone, 'CREATE', { name: SHOP_DOMAIN, type: 'CNAME', ttl: 300, values: [alb] })).toThrow(`[RRSet of type CNAME with DNS name ${SHOP_DOMAIN}. is not permitted at apex in zone ${SHOP_DOMAIN}.]`);
    expect(() => changeRecord(env, zone, 'CREATE', { name: SHOP_DOMAIN, type: 'A', values: [], aliasTarget: 'nowhere.elb.amazonaws.com' })).toThrow(/alias target name does not lie within the target zone/);
    changeRecord(env, zone, 'CREATE', { name: SHOP_DOMAIN, type: 'A', values: [], aliasTarget: alb });
    expect(resolve(env, SHOP_DOMAIN).steps).toEqual([`${SHOP_DOMAIN} → A (エイリアス) → ${alb}`]);
    expect(simulateHttp(env, `http://${SHOP_DOMAIN}/`).status).toBe(200);
    expect(() => changeRecord(env, zone, 'CREATE', { name: `www.${SHOP_DOMAIN}`, type: 'A', values: ['203.0.113.5'] })).toThrow(/conflicting RRSet of type CNAME/);
  });
});

describe('ACM + CloudFront', () => {
  it('www is not covered: certificate error; a us-east-1 certificate with www fixes it after DNS validation', () => {
    const env = httpsEnv();
    expect(simulateHttp(env, `https://${SHOP_DOMAIN}/`).status).toBe(200);
    expect(simulateHttp(env, `http://${SHOP_DOMAIN}/`).hops.some((h) => h.checks.some((c) => c.detail.includes('Redirect HTTP to HTTPS')))).toBe(true);
    expect(simulateHttp(env, `https://www.${SHOP_DOMAIN}/`).error).toBe('ERR_CERT_COMMON_NAME_INVALID');
    const d = env.distributions[0];
    expect(() => updateDistribution(env, d.id, { aliases: [SHOP_DOMAIN, `www.${SHOP_DOMAIN}`] })).toThrow(/doesn't cover the alternate domain name/);
    const tokyo = requestCertificate(env, { domainName: SHOP_DOMAIN, subjectAlternativeNames: [`www.${SHOP_DOMAIN}`], region: 'ap-northeast-1' });
    const virginia = requestCertificate(env, { domainName: SHOP_DOMAIN, subjectAlternativeNames: [`*.${SHOP_DOMAIN}`], region: 'us-east-1' });
    const now = Date.now();
    advanceEdge(env, now + 10_000);
    expect(env.certificates.find((c) => c.certificateArn === virginia)!.status).toBe('PENDING_VALIDATION'); // no CNAME yet
    createValidationRecords(env, virginia);
    createValidationRecords(env, tokyo);
    advanceEdge(env, now + 10_000);
    const cert = env.certificates.find((c) => c.certificateArn === virginia)!;
    expect(cert.status).toBe('ISSUED');
    expect(certCovers(cert, `www.${SHOP_DOMAIN}`)).toBe(true);
    expect(certCovers(cert, `a.b.${SHOP_DOMAIN}`)).toBe(false);
    expect(() => updateDistribution(env, d.id, { aliases: [SHOP_DOMAIN, `www.${SHOP_DOMAIN}`], certificateArn: tokyo })).toThrow(/isn't in us-east-1 region/);
    updateDistribution(env, d.id, { aliases: [SHOP_DOMAIN, `www.${SHOP_DOMAIN}`], certificateArn: virginia });
    expect(simulateHttp(env, `https://www.${SHOP_DOMAIN}/`).status).toBe(200);
  });

  it('stale cache: Hit with the old page until an invalidation completes', () => {
    const env = cacheEnv();
    const d = env.distributions[0];
    const first = browse(env, `https://${d.domainName}/`);
    expect(first.body).toContain('夏のセール');
    expect(first.headers).toMatchObject({ 'X-Cache': 'Hit from cloudfront' });
    expect(Number(first.headers!.Age)).toBeGreaterThanOrEqual(3599);
    const now = Date.now();
    createInvalidation(env, d.id, ['/'], now);
    expect(browse(env, `https://${d.domainName}/`).body).toContain('夏のセール'); // still in progress
    advanceEdge(env, now + 5000);
    const fresh = browse(env, `https://${d.domainName}/`);
    expect(fresh.body).toContain('秋のキャンペーン');
    expect(fresh.headers!['X-Cache']).toBe('Miss from cloudfront');
    expect(browse(env, `https://${d.domainName}/`).headers!['X-Cache']).toBe('Hit from cloudfront');
    expect(() => createInvalidation(env, d.id, ['index.html'])).toThrow(/invalid invalidation paths/);
  });
});

describe('WAF', () => {
  it('an IP set too wide blocks the office; narrowed, the office passes and XSS is still blocked', () => {
    const env = wafEnv();
    const d = env.distributions[0];
    const blocked = browse(env, `https://${d.domainName}/`);
    expect(blocked.status).toBe(403);
    expect(blocked.body).toContain('Request blocked');
    expect(env.webAcls[0].samples[0]).toMatchObject({ clientIp: '198.51.100.24', rule: 'block-bad-ips', action: 'BLOCK' });
    updateIpSet(env, env.ipSets[0].arn, ['198.51.100.77/32']);
    expect(browse(env, `https://${d.domainName}/`).status).toBe(200);
    expect(browse(env, `https://${d.domainName}/?q=<script>alert(1)</script>`).status).toBe(403);
    expect(env.webAcls[0].samples[0]).toMatchObject({ rule: 'AWS-AWSManagedRulesCommonRuleSet', action: 'BLOCK' });
    expect(() => updateIpSet(env, env.ipSets[0].arn, ['198.51.100.777/32'])).toThrow(/not valid/);
  });
});
