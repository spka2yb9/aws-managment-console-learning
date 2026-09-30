import type { ConsoleRoute, Crumb } from '../routes';
import { useConsole } from '../store';
import { queryParam } from '../ui';
import { AddConfigRule, ConfigDashboard, ConfigResources, ConfigRules, EventDetail, EventHistory, ResourceTimeline, RuleDetail } from './audit';

const CT: Crumb = { text: 'CloudTrail', href: '/cloudtrail/events' };
const HISTORY: Crumb = { text: 'イベント履歴', href: '/cloudtrail/events' };
const CONFIG: Crumb = { text: 'AWS Config', href: '/config/home' };
const RULES: Crumb = { text: 'ルール', href: '/config/rules' };
const RESOURCES: Crumb = { text: 'リソース', href: '/config/resources' };
const here = (text: string): Crumb => ({ text, href: '' });
const q = (key: string) => queryParam(useConsole.getState().path, key) ?? '';

export const AUDIT_ROUTES: ConsoleRoute[] = [
  { pattern: '/cloudtrail/events', service: 'cloudtrail', contentType: 'table', crumbs: () => [CT, here('イベント履歴')], render: () => <EventHistory key={useConsole.getState().path} /> },
  { pattern: '/cloudtrail/events/view', service: 'cloudtrail', crumbs: (_, env) => [CT, HISTORY, here(env.trailEvents.find((e) => e.eventId === q('id'))?.eventName ?? q('id'))], render: () => <EventDetail id={q('id')} key={q('id')} /> },
  { pattern: '/config/home', service: 'config', crumbs: () => [CONFIG, here('ダッシュボード')], render: () => <ConfigDashboard /> },
  { pattern: '/config/rules', service: 'config', contentType: 'table', crumbs: () => [CONFIG, here('ルール')], render: () => <ConfigRules /> },
  { pattern: '/config/rules/add', service: 'config', contentType: 'wizard', crumbs: () => [CONFIG, RULES, here('ルールを追加')], render: () => <AddConfigRule /> },
  { pattern: '/config/rules/view', service: 'config', crumbs: () => [CONFIG, RULES, here(q('name'))], render: () => <RuleDetail name={q('name')} key={q('name')} /> },
  { pattern: '/config/resources', service: 'config', contentType: 'table', crumbs: () => [CONFIG, here('リソース')], render: () => <ConfigResources /> },
  { pattern: '/config/resources/view', service: 'config', crumbs: () => [CONFIG, RESOURCES, here(q('id'))], render: () => <ResourceTimeline key={useConsole.getState().path} /> },
];
