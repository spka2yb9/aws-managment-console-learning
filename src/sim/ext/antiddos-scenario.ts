// Lesson 42: the shop behind CloudFront + AWS WAF is under an L7 flood from thousands of IPs.
import { quietly } from '../cloudtrail';
import { MINUTE } from '../cloudwatch';
import { createDistribution, createWebAcl } from '../edge';
import { webAppEnv } from '../scenarios';
import type { AwsEnv, TrafficSource } from '../types';
import { refreshOriginTraffic } from './antiddos';

const DAY = 86_400_000;
export const ACL_NAME = 'webapp-acl';
export const RATE_RULE = 'rate-limit-per-ip';
export const APP_UA = 'webapp-shop-app/3.2.1 (iPhone; iOS 18.1)';
export const ATTACK_MINUTES = 15;

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const WORLD = ['US', 'BR', 'IN', 'VN', 'ID', 'DE', 'JP', 'FR', 'TR', 'MX'];

/** everyday clients of the shop: browsers (run JavaScript) and the smartphone app (an HTTP client: no JavaScript) */
export const SHOP_SOURCES: TrafficSource[] = [
  { name: 'shoppers', cidr: '203.0.113.0/24', ips: 250, rps: 90, paths: ['/', '/products/{n}', '/cart'], userAgent: CHROME, javascript: true, country: ['JP'] },
  { name: 'smartphone-app', cidr: '100.64.0.0/10', ips: 400, rps: 25, paths: ['/app/v1/products', '/app/v1/cart'], userAgent: APP_UA, javascript: false, country: ['JP'] },
];

/** the botnet: thousands of IPs, each one slow (0.4 req/s = 120 per 5 minutes, far under the rate-based rule's 1,000) */
export const BOTNET: TrafficSource[] = [
  { name: 'botnet', cidr: '198.18.0.0/15', ips: 4800, rps: 1900, paths: ['/', '/products?page={n}', '/search?q={n}'], userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', javascript: false, suspicion: { high: 0.6, medium: 0.3, low: 0.1 }, country: WORLD },
  { name: 'botnet-headless', cidr: '198.18.128.0/17', ips: 300, rps: 150, paths: ['/', '/products?page={n}'], userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36', javascript: true, suspicion: { high: 1 }, country: WORLD },
];

/**
 * The shop (CloudFront → web-alb → web-1/web-2 → webapp-db) with web ACL webapp-acl: a per-IP rate-based rule and the core rule set.
 * The flood started ATTACK_MINUTES ago and nothing in the web ACL catches it, so the web tier is drowning.
 */
export function antiDdosEnv(): AwsEnv {
  return webAppEnv({}, (env) =>
    quietly(() => {
      const now = Date.now();
      const acl = createWebAcl(env, {
        name: ACL_NAME,
        scope: 'CLOUDFRONT',
        defaultAction: 'Allow',
        rules: [
          { name: RATE_RULE, priority: 0, action: 'Block', statement: { kind: 'rate-based', limit: 1000, windowSec: 300 } },
          { name: 'AWS-AWSManagedRulesCommonRuleSet', priority: 1, action: 'Block', statement: { kind: 'managed', vendor: 'AWS', name: 'AWSManagedRulesCommonRuleSet' } },
        ],
      });
      const id = createDistribution(env, { comment: 'webapp shop', origin: { kind: 'alb', loadBalancerName: 'web-alb' }, aliases: [], viewerProtocolPolicy: 'redirect-to-https', defaultTtl: 0, webAclArn: acl }, now - 30 * DAY);
      Object.assign(env.distributions.find((d) => d.id === id)!, { status: 'Deployed' });
      const start = now - ATTACK_MINUTES * MINUTE;
      env.traffic.push({ at: start, sources: [...SHOP_SOURCES, ...BOTNET] });
      refreshOriginTraffic(env, start);
    }),
  );
}
