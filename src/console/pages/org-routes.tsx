import type { ConsoleRoute, Crumb } from '../routes';
import { entityName } from '../../sim/organizations';
import { AccessPortal, AssignAccess, CreatePermissionSetPage, CreateScp, EditScp, OrgAccounts, OrgEntityDetail, PermissionSets, ScpDetail, ScpList, SsoAccountDetail, SsoAccounts, SsoGroups, SsoHome, SsoUsers } from './org';

const ORG: Crumb = { text: 'AWS Organizations', href: '/organizations/accounts' };
const ACCOUNTS: Crumb = { text: 'AWS アカウント', href: '/organizations/accounts' };
const SCPS: Crumb = { text: 'サービスコントロールポリシー', href: '/organizations/policies' };
const SSO: Crumb = { text: 'IAM Identity Center', href: '/sso/home' };
const SSO_ACCOUNTS: Crumb = { text: 'AWS アカウント', href: '/sso/accounts' };
const here = (text: string): Crumb => ({ text, href: '' });

export const ORG_ROUTES: ConsoleRoute[] = [
  { pattern: '/organizations/accounts', service: 'organizations', crumbs: () => [ORG, here('AWS アカウント')], render: () => <OrgAccounts /> },
  { pattern: '/organizations/accounts/:id', service: 'organizations', crumbs: (p, env) => [ORG, ACCOUNTS, here(env.organization ? entityName(env.organization, p.id) : p.id)], render: (p) => <OrgEntityDetail id={p.id} key={p.id} /> },
  { pattern: '/organizations/policies', service: 'organizations', contentType: 'table', crumbs: () => [ORG, here('サービスコントロールポリシー')], render: () => <ScpList /> },
  { pattern: '/organizations/policies/create', service: 'organizations', contentType: 'form', crumbs: () => [ORG, SCPS, here('ポリシーを作成')], render: () => <CreateScp /> },
  { pattern: '/organizations/policies/:id', service: 'organizations', crumbs: (p, env) => [ORG, SCPS, here(env.organization?.policies.find((x) => x.id === p.id)?.name ?? p.id)], render: (p) => <ScpDetail id={p.id} key={p.id} /> },
  { pattern: '/organizations/policies/:id/edit', service: 'organizations', contentType: 'form', crumbs: (p, env) => [ORG, SCPS, { text: env.organization?.policies.find((x) => x.id === p.id)?.name ?? p.id, href: `/organizations/policies/${p.id}` }, here('ポリシーを編集')], render: (p) => <EditScp id={p.id} key={p.id} /> },
  { pattern: '/sso/home', service: 'sso', crumbs: () => [SSO, here('ダッシュボード')], render: () => <SsoHome /> },
  { pattern: '/sso/users', service: 'sso', contentType: 'table', crumbs: () => [SSO, here('ユーザー')], render: () => <SsoUsers /> },
  { pattern: '/sso/groups', service: 'sso', contentType: 'table', crumbs: () => [SSO, here('グループ')], render: () => <SsoGroups /> },
  { pattern: '/sso/permission-sets', service: 'sso', contentType: 'table', crumbs: () => [SSO, here('許可セット')], render: () => <PermissionSets /> },
  { pattern: '/sso/permission-sets/create', service: 'sso', contentType: 'form', crumbs: () => [SSO, { text: '許可セット', href: '/sso/permission-sets' }, here('許可セットを作成')], render: () => <CreatePermissionSetPage /> },
  { pattern: '/sso/accounts', service: 'sso', contentType: 'table', crumbs: () => [SSO, here('AWS アカウント')], render: () => <SsoAccounts /> },
  { pattern: '/sso/accounts/:id', service: 'sso', crumbs: (p, env) => [SSO, SSO_ACCOUNTS, here(env.organization ? entityName(env.organization, p.id) : p.id)], render: (p) => <SsoAccountDetail id={p.id} key={p.id} /> },
  { pattern: '/sso/accounts/:id/assign', service: 'sso', contentType: 'form', crumbs: (p, env) => [SSO, SSO_ACCOUNTS, { text: env.organization ? entityName(env.organization, p.id) : p.id, href: `/sso/accounts/${p.id}` }, here('ユーザーまたはグループを割り当て')], render: (p) => <AssignAccess id={p.id} key={p.id} /> },
  { pattern: '/sso/portal', service: 'sso', crumbs: () => [SSO, here('AWS アクセスポータル')], render: () => <AccessPortal /> },
];
