import type { ConsoleRoute, Crumb } from '../routes';
import { useConsole } from '../store';
import { queryParam } from '../ui';
import { CertificateDetail, CertificateList, CreateInvalidationPage, CreateRecord, DistributionDetail, DistributionList, EditBehavior, EditDistribution, EditIpSet, HostedZoneDetail, HostedZoneList, IpSetDetail, IpSetList, RequestCertificate, WebAclDetail, WebAclList } from './edge';

const R53: Crumb = { text: 'Route 53', href: '/route53/hostedzones' };
const ZONES: Crumb = { text: 'ホストゾーン', href: '/route53/hostedzones' };
const ACM: Crumb = { text: 'AWS Certificate Manager', href: '/acm/certificates' };
const CERTS: Crumb = { text: '証明書', href: '/acm/certificates' };
const CF: Crumb = { text: 'CloudFront', href: '/cloudfront/distributions' };
const DISTS: Crumb = { text: 'ディストリビューション', href: '/cloudfront/distributions' };
const WAF: Crumb = { text: 'WAF & Shield', href: '/wafv2/webacls' };
const IPSETS: Crumb = { text: 'IP セット', href: '/wafv2/ipsets' };
const here = (text: string): Crumb => ({ text, href: '' });
const q = (key: string) => queryParam(useConsole.getState().path, key) ?? '';
const dist = (id: string): Crumb => ({ text: id, href: `/cloudfront/distributions/${id}` });

export const EDGE_ROUTES: ConsoleRoute[] = [
  { pattern: '/route53/hostedzones', service: 'route53', contentType: 'table', crumbs: () => [R53, here('ホストゾーン')], render: () => <HostedZoneList /> },
  { pattern: '/route53/hostedzones/:id', service: 'route53', crumbs: (p, env) => [R53, ZONES, here(env.hostedZones.find((z) => z.id === p.id)?.name ?? p.id)], render: (p) => <HostedZoneDetail id={p.id} key={p.id} /> },
  { pattern: '/route53/hostedzones/:id/create-record', service: 'route53', contentType: 'form', crumbs: (p, env) => [R53, ZONES, { text: env.hostedZones.find((z) => z.id === p.id)?.name ?? p.id, href: `/route53/hostedzones/${p.id}` }, here('レコードを作成')], render: (p) => <CreateRecord id={p.id} key={p.id} /> },
  { pattern: '/route53/hostedzones/:id/edit-record', service: 'route53', contentType: 'form', crumbs: (p, env) => [R53, ZONES, { text: env.hostedZones.find((z) => z.id === p.id)?.name ?? p.id, href: `/route53/hostedzones/${p.id}` }, here('レコードを編集')], render: (p) => <CreateRecord id={p.id} edit={{ name: q('name'), type: q('type') }} key={`${q('name')}|${q('type')}`} /> },
  { pattern: '/acm/certificates', service: 'acm', contentType: 'table', crumbs: () => [ACM, here('証明書')], render: () => <CertificateList /> },
  { pattern: '/acm/certificates/request', service: 'acm', contentType: 'form', crumbs: () => [ACM, CERTS, here('証明書をリクエスト')], render: () => <RequestCertificate /> },
  { pattern: '/acm/certificates/:id', service: 'acm', crumbs: (p) => [ACM, CERTS, here(p.id)], render: (p) => <CertificateDetail id={p.id} key={p.id} /> },
  { pattern: '/cloudfront/distributions', service: 'cloudfront', contentType: 'table', crumbs: () => [CF, here('ディストリビューション')], render: () => <DistributionList /> },
  { pattern: '/cloudfront/distributions/:id', service: 'cloudfront', crumbs: (p) => [CF, DISTS, here(p.id)], render: (p) => <DistributionDetail id={p.id} key={p.id} /> },
  { pattern: '/cloudfront/distributions/:id/edit', service: 'cloudfront', contentType: 'form', crumbs: (p) => [CF, DISTS, dist(p.id), here('設定を編集')], render: (p) => <EditDistribution id={p.id} key={p.id} /> },
  { pattern: '/cloudfront/distributions/:id/behaviors/edit', service: 'cloudfront', contentType: 'form', crumbs: (p) => [CF, DISTS, dist(p.id), here('ビヘイビアを編集')], render: (p) => <EditBehavior id={p.id} key={p.id} /> },
  { pattern: '/cloudfront/distributions/:id/invalidations/create', service: 'cloudfront', contentType: 'form', crumbs: (p) => [CF, DISTS, dist(p.id), here('無効化を作成')], render: (p) => <CreateInvalidationPage id={p.id} key={p.id} /> },
  { pattern: '/wafv2/webacls', service: 'wafv2', contentType: 'table', crumbs: () => [WAF, here('ウェブ ACL')], render: () => <WebAclList /> },
  { pattern: '/wafv2/webacls/:name', service: 'wafv2', crumbs: (p) => [WAF, { text: 'ウェブ ACL', href: '/wafv2/webacls' }, here(p.name)], render: (p) => <WebAclDetail name={p.name} key={p.name} /> },
  { pattern: '/wafv2/ipsets', service: 'wafv2', contentType: 'table', crumbs: () => [WAF, here('IP セット')], render: () => <IpSetList /> },
  { pattern: '/wafv2/ipsets/:name', service: 'wafv2', crumbs: (p) => [WAF, IPSETS, here(p.name)], render: (p) => <IpSetDetail name={p.name} key={p.name} /> },
  { pattern: '/wafv2/ipsets/:name/edit', service: 'wafv2', contentType: 'form', crumbs: (p) => [WAF, IPSETS, { text: p.name, href: `/wafv2/ipsets/${p.name}` }, here('IP アドレスを編集')], render: (p) => <EditIpSet name={p.name} key={p.name} /> },
];
