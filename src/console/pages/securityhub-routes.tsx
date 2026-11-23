import type { ConsoleRoute, Crumb } from '../routes';
import { useConsole } from '../store';
import { queryParam } from '../ui';
import { Automations, ControlDetail, CreateAutomationRule, FindingDetail, SecurityHubControls, SecurityHubFindings, SecurityHubHome, SecurityHubStandards } from './securityhub';

const SH: Crumb = { text: 'Security Hub CSPM', href: '/securityhub/home' };
const here = (text: string): Crumb => ({ text, href: '' });
const id = () => queryParam(useConsole.getState().path, 'id') ?? '';

export const SECURITYHUB_ROUTES: ConsoleRoute[] = [
  { pattern: '/securityhub/home', service: 'securityhub', crumbs: () => [SH, here('概要')], render: () => <SecurityHubHome /> },
  { pattern: '/securityhub/findings', service: 'securityhub', contentType: 'table', crumbs: () => [SH, here('検出結果')], render: () => <SecurityHubFindings /> },
  { pattern: '/securityhub/findings/view', service: 'securityhub', crumbs: () => [SH, { text: '検出結果', href: '/securityhub/findings' }, here(id().split('/').pop() ?? '')], render: () => <FindingDetail id={id()} key={id()} /> },
  { pattern: '/securityhub/standards', service: 'securityhub', crumbs: () => [SH, here('セキュリティ標準')], render: () => <SecurityHubStandards /> },
  { pattern: '/securityhub/controls', service: 'securityhub', crumbs: () => [SH, here('コントロール')], render: () => <SecurityHubControls key={useConsole.getState().path} /> },
  { pattern: '/securityhub/controls/:id', service: 'securityhub', crumbs: (p) => [SH, { text: 'コントロール', href: '/securityhub/controls' }, here(p.id)], render: (p) => <ControlDetail id={p.id} key={p.id} /> },
  { pattern: '/securityhub/automations', service: 'securityhub', contentType: 'table', crumbs: () => [SH, here('オートメーション')], render: () => <Automations /> },
  { pattern: '/securityhub/automations/create', service: 'securityhub', contentType: 'form', crumbs: () => [SH, { text: 'オートメーション', href: '/securityhub/automations' }, here('ルールを作成')], render: () => <CreateAutomationRule /> },
];
