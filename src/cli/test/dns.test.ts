// @vitest-environment node
/* dig / nslookup / host の名前解決 (commands/dns.ts の lookup) */
import { lookup } from '../shell/commands/dns';
import { dnsEnv, httpsEnv, SHOP_DOMAIN } from '../../sim/scenarios';

it('resolves through Route 53 like a resolver', () => {
  const env = dnsEnv();
  // the apex exists (NS, SOA) but has no A record: NOERROR with an empty answer, not NXDOMAIN
  expect(lookup(env, SHOP_DOMAIN, 'A')).toMatchObject({ status: 'NOERROR', answer: [], authority: [{ type: 'SOA' }] });
  const www = lookup(env, `www.${SHOP_DOMAIN}`, 'A');
  expect(www.answer.map((r) => r.type)).toEqual(['CNAME', 'A', 'A']);
  expect(lookup(env, `www.${SHOP_DOMAIN}`, 'CNAME').answer.map((r) => r.type)).toEqual(['CNAME']);
  expect(lookup(env, `nope.${SHOP_DOMAIN}`, 'A').status).toBe('NXDOMAIN');
  expect(lookup(env, SHOP_DOMAIN, 'NS').answer).toHaveLength(4);
  // an alias answers A records of its target
  expect(lookup(httpsEnv(), `www.${SHOP_DOMAIN}`, 'A').answer.map((r) => r.type)).toEqual(['A', 'A', 'A', 'A']);
});
