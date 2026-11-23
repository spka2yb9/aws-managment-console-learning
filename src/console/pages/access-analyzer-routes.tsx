import type { ConsoleRoute, Crumb } from '../routes';
import { useConsole } from '../store';
import { queryParam } from '../ui';
import { AnalyzerDetail, AnalyzerList, CreateAnalyzerPage, CreateArchiveRulePage, FindingDetail, FindingList, UnusedFindingDetail } from './access-analyzer';

// IAM コンソールの「アクセスレポート」。IAM の画面なので service は 'iam' (リージョンの表示はグローバル)
const IAM: Crumb = { text: 'IAM', href: '/iam/home' };
const RESOURCES: Crumb = { text: 'リソース分析', href: '/iam/access-analyzer/findings' };
const UNUSED: Crumb = { text: '未使用のアクセス', href: '/iam/access-analyzer/unused' };
const ANALYZERS: Crumb = { text: 'アナライザーの設定', href: '/iam/access-analyzer/analyzers' };
const here = (text: string): Crumb => ({ text, href: '' });
const q = (key: string) => queryParam(useConsole.getState().path, key) ?? '';

export const ACCESS_ANALYZER_ROUTES: ConsoleRoute[] = [
  { pattern: '/iam/access-analyzer/findings', service: 'iam', contentType: 'table', crumbs: () => [IAM, here('リソース分析')], render: () => <FindingList unused={false} key="external" /> },
  { pattern: '/iam/access-analyzer/findings/view', service: 'iam', crumbs: () => [IAM, RESOURCES, here(q('id'))], render: () => <FindingDetail analyzer={q('analyzer')} id={q('id')} key={q('id')} /> },
  { pattern: '/iam/access-analyzer/unused', service: 'iam', contentType: 'table', crumbs: () => [IAM, here('未使用のアクセス')], render: () => <FindingList unused key="unused" /> },
  { pattern: '/iam/access-analyzer/unused/view', service: 'iam', crumbs: () => [IAM, UNUSED, here(q('id'))], render: () => <UnusedFindingDetail analyzer={q('analyzer')} id={q('id')} key={q('id')} /> },
  { pattern: '/iam/access-analyzer/analyzers', service: 'iam', contentType: 'table', crumbs: () => [IAM, here('アナライザーの設定')], render: () => <AnalyzerList /> },
  { pattern: '/iam/access-analyzer/analyzers/create', service: 'iam', contentType: 'form', crumbs: () => [IAM, ANALYZERS, here('アナライザーを作成')], render: () => <CreateAnalyzerPage key={useConsole.getState().path} /> },
  { pattern: '/iam/access-analyzer/analyzers/view', service: 'iam', crumbs: () => [IAM, ANALYZERS, here(q('name'))], render: () => <AnalyzerDetail name={q('name')} key={q('name')} /> },
  { pattern: '/iam/access-analyzer/archive-rules/create', service: 'iam', contentType: 'form', crumbs: () => [IAM, ANALYZERS, { text: q('analyzer'), href: `/iam/access-analyzer/analyzers/view?${new URLSearchParams({ name: q('analyzer') })}` }, here('アーカイブルールを作成')], render: () => <CreateArchiveRulePage analyzer={q('analyzer')} key={q('analyzer')} /> },
];
