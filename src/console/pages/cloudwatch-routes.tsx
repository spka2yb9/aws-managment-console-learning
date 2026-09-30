import type { ConsoleRoute, Crumb } from '../routes';
import { useConsole } from '../store';
import { queryParam } from '../ui';
import { AlarmDetail, AlarmList, CloudWatchHome, CreateAlarm, LogEvents, LogGroupDetail, LogGroupList, MetricsPage } from './cloudwatch';

const CW: Crumb = { text: 'CloudWatch', href: '/cloudwatch/home' };
const ALARMS: Crumb = { text: 'アラーム', href: '/cloudwatch/alarms' };
const LOGS: Crumb = { text: 'ロググループ', href: '/cloudwatch/logs' };
const here = (text: string): Crumb => ({ text, href: '' });
const q = (key: string) => queryParam(useConsole.getState().path, key) ?? '';

export const CLOUDWATCH_ROUTES: ConsoleRoute[] = [
  { pattern: '/cloudwatch/home', service: 'cloudwatch', crumbs: () => [CW], render: () => <CloudWatchHome /> },
  { pattern: '/cloudwatch/alarms', service: 'cloudwatch', contentType: 'table', crumbs: () => [CW, ALARMS], render: () => <AlarmList /> },
  { pattern: '/cloudwatch/alarms/create', service: 'cloudwatch', contentType: 'wizard', crumbs: () => [CW, ALARMS, here('アラームの作成')], render: () => <CreateAlarm key={useConsole.getState().path} /> },
  { pattern: '/cloudwatch/alarms/edit', service: 'cloudwatch', contentType: 'wizard', crumbs: () => [CW, ALARMS, { text: q('name'), href: `/cloudwatch/alarms/view?${new URLSearchParams({ name: q('name') })}` }, here('編集')], render: () => <CreateAlarm edit={q('name')} key={q('name')} /> },
  { pattern: '/cloudwatch/alarms/view', service: 'cloudwatch', crumbs: () => [CW, ALARMS, here(q('name'))], render: () => <AlarmDetail name={q('name')} key={q('name')} /> },
  { pattern: '/cloudwatch/metrics', service: 'cloudwatch', crumbs: () => [CW, here('メトリクス')], render: () => <MetricsPage /> },
  { pattern: '/cloudwatch/logs', service: 'cloudwatch', contentType: 'table', crumbs: () => [CW, LOGS], render: () => <LogGroupList /> },
  { pattern: '/cloudwatch/logs/group', service: 'cloudwatch', crumbs: () => [CW, LOGS, here(q('name'))], render: () => <LogGroupDetail name={q('name')} key={q('name')} /> },
  {
    pattern: '/cloudwatch/logs/events',
    service: 'cloudwatch',
    contentType: 'table',
    crumbs: () => [CW, LOGS, { text: q('group'), href: `/cloudwatch/logs/group?${new URLSearchParams({ name: q('group') })}` }, here(q('stream') || 'ログイベント')],
    render: () => <LogEvents key={`${q('group')}|${q('stream')}`} />,
  },
];
