import type { ConsoleRoute, Crumb } from '../routes';
import { EditPreferences, FleetManager, SessionManagerHome, SessionTerminal, StartSessionPage } from './ssm';

const SSM: Crumb = { text: 'AWS Systems Manager', href: '/ssm/session-manager' };
const SM: Crumb = { text: 'セッションマネージャー', href: '/ssm/session-manager' };
const here = (text: string): Crumb => ({ text, href: '' });

// specific /ssm/session-manager/... pages before the session terminal (:id)
export const SSM_ROUTES: ConsoleRoute[] = [
  { pattern: '/ssm/fleet-manager', service: 'ssm', contentType: 'table', crumbs: () => [SSM, here('フリートマネージャー')], render: () => <FleetManager /> },
  { pattern: '/ssm/session-manager', service: 'ssm', crumbs: () => [SSM, here('セッションマネージャー')], render: () => <SessionManagerHome /> },
  { pattern: '/ssm/session-manager/start', service: 'ssm', contentType: 'form', crumbs: () => [SSM, SM, here('セッションの開始')], render: () => <StartSessionPage /> },
  { pattern: '/ssm/session-manager/edit-preferences', service: 'ssm', contentType: 'form', crumbs: () => [SSM, SM, { text: '設定', href: '/ssm/session-manager?tab=preferences' }, here('設定を編集')], render: () => <EditPreferences /> },
  { pattern: '/ssm/session-manager/:id', service: 'ssm', crumbs: (p) => [SSM, SM, here(p.id)], render: (p) => <SessionTerminal id={p.id} key={p.id} /> },
];
