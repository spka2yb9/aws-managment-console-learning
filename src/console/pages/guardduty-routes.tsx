import { label } from '../../sim/env';
import type { ConsoleRoute, Crumb } from '../routes';
import { CreateSuppressionRule, GdFindings, GdSettings, GdSummary, GdSuppressionRules, ModifyMetadataOptions } from './guardduty';

const GD: Crumb = { text: 'GuardDuty', href: '/guardduty/home' };
const here = (text: string): Crumb => ({ text, href: '' });

export const GUARDDUTY_ROUTES: ConsoleRoute[] = [
  { pattern: '/guardduty/home', service: 'guardduty', crumbs: () => [GD, here('概要')], render: () => <GdSummary /> },
  { pattern: '/guardduty/findings', service: 'guardduty', contentType: 'table', crumbs: () => [GD, here('検出結果')], render: () => <GdFindings /> },
  { pattern: '/guardduty/settings', service: 'guardduty', crumbs: () => [GD, here('設定')], render: () => <GdSettings /> },
  { pattern: '/guardduty/suppression-rules', service: 'guardduty', contentType: 'table', crumbs: () => [GD, here('抑制ルール')], render: () => <GdSuppressionRules /> },
  { pattern: '/guardduty/suppression-rules/create', service: 'guardduty', contentType: 'form', crumbs: () => [GD, { text: '抑制ルール', href: '/guardduty/suppression-rules' }, here('抑制ルールを作成')], render: () => <CreateSuppressionRule /> },
  // EC2 > インスタンス > アクション > インスタンスの設定 > インスタンスメタデータオプションを変更 (lesson 43)
  {
    pattern: '/ec2/instances/:id/modify-metadata-options',
    service: 'ec2',
    contentType: 'form',
    crumbs: (p, env) => [{ text: 'EC2', href: '/ec2/home' }, { text: 'インスタンス', href: '/ec2/instances' }, { text: label(p.id, env.instances.find((i) => i.instanceId === p.id)), href: `/ec2/instances/${p.id}` }, here('インスタンスメタデータオプションを変更')],
    render: (p) => <ModifyMetadataOptions id={p.id} key={p.id} />,
  },
];
