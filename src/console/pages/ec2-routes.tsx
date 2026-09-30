import { label } from '../../sim/env';
import { AsgDetail, AsgList, CreateAsgWizard, CreateLaunchTemplate, CreatePolicy, EditAsg, LaunchTemplateDetail, LaunchTemplateList } from './autoscaling';
import { useConsole } from '../store';
import { RestorePitr, RestoreSnapshot, SnapshotList, TakeSnapshot } from './rds-backup';
import type { AwsEnv } from '../../sim/types';
import type { ConsoleRoute, Crumb } from '../routes';
import { ChangeSecurityGroups, Ec2Dashboard, InstanceDetail, InstanceList, LaunchInstance } from './ec2';
import { CreateAlb, CreateTargetGroup, EditHealthCheck, EditLbSecurityGroups, LbDetail, LbList, LbSelectType, RegisterTargets, TgDetail, TgList } from './elb';
import { CreateDatabase, CreateSubnetGroup, DbDetail, DbList, ModifyDatabase, RdsDashboard, SubnetGroupDetail, SubnetGroupList } from './rds';

const EC2: Crumb = { text: 'EC2', href: '/ec2/home' };
const RDS: Crumb = { text: 'RDS', href: '/rds/home' };
const INSTANCES: Crumb = { text: 'インスタンス', href: '/ec2/instances' };
const LBS: Crumb = { text: 'ロードバランサー', href: '/ec2/load-balancers' };
const TGS: Crumb = { text: 'ターゲットグループ', href: '/ec2/target-groups' };
const DBS: Crumb = { text: 'データベース', href: '/rds/databases' };
const SGRPS: Crumb = { text: 'サブネットグループ', href: '/rds/subnet-groups' };
const SNAPS: Crumb = { text: 'スナップショット', href: '/rds/snapshots' };
const LTS: Crumb = { text: '起動テンプレート', href: '/ec2/launch-templates' };
const ASGS: Crumb = { text: 'Auto Scaling グループ', href: '/ec2/autoscaling' };
const here = (text: string): Crumb => ({ text, href: '' });
const instance = (env: AwsEnv, id: string): Crumb => ({ text: label(id, env.instances.find((i) => i.instanceId === id)), href: `/ec2/instances/${id}` });

export const EC2_ROUTES: ConsoleRoute[] = [
  { pattern: '/ec2/home', service: 'ec2', crumbs: () => [EC2, here('ダッシュボード')], render: () => <Ec2Dashboard /> },
  { pattern: '/ec2/instances', service: 'ec2', contentType: 'table', crumbs: () => [EC2, INSTANCES], render: () => <InstanceList /> },
  { pattern: '/ec2/launch', service: 'ec2', crumbs: () => [EC2, INSTANCES, here('インスタンスを起動')], render: () => <LaunchInstance /> },
  { pattern: '/ec2/instances/:id', service: 'ec2', crumbs: (p, env) => [EC2, INSTANCES, { ...instance(env, p.id), href: '' }], render: (p) => <InstanceDetail id={p.id} key={p.id} /> },
  { pattern: '/ec2/instances/:id/change-security-groups', service: 'ec2', contentType: 'form', crumbs: (p, env) => [EC2, INSTANCES, instance(env, p.id), here('セキュリティグループの変更')], render: (p) => <ChangeSecurityGroups id={p.id} key={p.id} /> },
  { pattern: '/ec2/load-balancers', service: 'ec2', contentType: 'table', crumbs: () => [EC2, LBS], render: () => <LbList /> },
  { pattern: '/ec2/load-balancers/select-type', service: 'ec2', crumbs: () => [EC2, LBS, here('ロードバランサータイプの比較と選択')], render: () => <LbSelectType /> },
  { pattern: '/ec2/load-balancers/create-alb', service: 'ec2', contentType: 'form', crumbs: () => [EC2, LBS, here('Application Load Balancer を作成')], render: () => <CreateAlb /> },
  { pattern: '/ec2/load-balancers/:name', service: 'ec2', crumbs: (p) => [EC2, LBS, here(p.name)], render: (p) => <LbDetail name={p.name} key={p.name} /> },
  { pattern: '/ec2/load-balancers/:name/edit-security-groups', service: 'ec2', contentType: 'form', crumbs: (p) => [EC2, LBS, { text: p.name, href: `/ec2/load-balancers/${p.name}` }, here('セキュリティグループを編集')], render: (p) => <EditLbSecurityGroups name={p.name} key={p.name} /> },
  { pattern: '/ec2/target-groups', service: 'ec2', contentType: 'table', crumbs: () => [EC2, TGS], render: () => <TgList /> },
  { pattern: '/ec2/target-groups/create', service: 'ec2', contentType: 'wizard', crumbs: () => [EC2, TGS, here('ターゲットグループの作成')], render: () => <CreateTargetGroup /> },
  { pattern: '/ec2/target-groups/:name', service: 'ec2', crumbs: (p) => [EC2, TGS, here(p.name)], render: (p) => <TgDetail name={p.name} key={p.name} /> },
  { pattern: '/ec2/target-groups/:name/register-targets', service: 'ec2', contentType: 'form', crumbs: (p) => [EC2, TGS, { text: p.name, href: `/ec2/target-groups/${p.name}` }, here('ターゲットを登録')], render: (p) => <RegisterTargets name={p.name} key={p.name} /> },
  { pattern: '/ec2/target-groups/:name/edit-health-check', service: 'ec2', contentType: 'form', crumbs: (p) => [EC2, TGS, { text: p.name, href: `/ec2/target-groups/${p.name}` }, here('ヘルスチェック設定を編集')], render: (p) => <EditHealthCheck name={p.name} key={p.name} /> },
  { pattern: '/ec2/launch-templates', service: 'ec2', contentType: 'table', crumbs: () => [EC2, here('起動テンプレート')], render: () => <LaunchTemplateList /> },
  { pattern: '/ec2/launch-templates/create', service: 'ec2', contentType: 'form', crumbs: () => [EC2, LTS, here('起動テンプレートを作成')], render: () => <CreateLaunchTemplate /> },
  { pattern: '/ec2/launch-templates/:id', service: 'ec2', crumbs: (p) => [EC2, LTS, here(p.id)], render: (p) => <LaunchTemplateDetail id={p.id} key={p.id} /> },
  { pattern: '/ec2/autoscaling', service: 'ec2', contentType: 'table', crumbs: () => [EC2, here('Auto Scaling グループ')], render: () => <AsgList /> },
  { pattern: '/ec2/autoscaling/create', service: 'ec2', contentType: 'wizard', crumbs: () => [EC2, ASGS, here('Auto Scaling グループを作成')], render: () => <CreateAsgWizard /> },
  { pattern: '/ec2/autoscaling/:name', service: 'ec2', crumbs: (p) => [EC2, ASGS, here(decodeURIComponent(p.name))], render: (p) => <AsgDetail name={decodeURIComponent(p.name)} key={p.name} /> },
  { pattern: '/ec2/autoscaling/:name/edit', service: 'ec2', contentType: 'form', crumbs: (p) => [EC2, ASGS, { text: decodeURIComponent(p.name), href: `/ec2/autoscaling/${p.name}` }, here('編集')], render: (p) => <EditAsg name={decodeURIComponent(p.name)} key={p.name} /> },
  { pattern: '/ec2/autoscaling/:name/create-policy', service: 'ec2', contentType: 'form', crumbs: (p) => [EC2, ASGS, { text: decodeURIComponent(p.name), href: `/ec2/autoscaling/${p.name}` }, here('動的スケーリングポリシーを作成')], render: (p) => <CreatePolicy name={decodeURIComponent(p.name)} key={p.name} /> },
  { pattern: '/rds/home', service: 'rds', crumbs: () => [RDS, here('ダッシュボード')], render: () => <RdsDashboard /> },
  { pattern: '/rds/databases', service: 'rds', contentType: 'table', crumbs: () => [RDS, DBS], render: () => <DbList /> },
  { pattern: '/rds/create', service: 'rds', contentType: 'form', crumbs: () => [RDS, DBS, here('データベースの作成')], render: () => <CreateDatabase /> },
  { pattern: '/rds/databases/:id', service: 'rds', crumbs: (p) => [RDS, DBS, here(p.id)], render: (p) => <DbDetail id={p.id} key={p.id} /> },
  { pattern: '/rds/databases/:id/modify', service: 'rds', contentType: 'form', crumbs: (p) => [RDS, DBS, { text: p.id, href: `/rds/databases/${p.id}` }, here('変更')], render: (p) => <ModifyDatabase id={p.id} key={p.id} /> },
  { pattern: '/rds/databases/:id/pitr', service: 'rds', contentType: 'form', crumbs: (p) => [RDS, DBS, { text: p.id, href: `/rds/databases/${p.id}` }, here('特定時点への復元')], render: (p) => <RestorePitr id={p.id} key={p.id} /> },
  { pattern: '/rds/snapshots', service: 'rds', crumbs: () => [RDS, SNAPS], render: () => <SnapshotList /> },
  { pattern: '/rds/snapshots/take', service: 'rds', contentType: 'form', crumbs: () => [RDS, SNAPS, here('スナップショットの取得')], render: () => <TakeSnapshot key={useConsole.getState().path} /> },
  { pattern: '/rds/snapshots/restore', service: 'rds', contentType: 'form', crumbs: () => [RDS, SNAPS, here('スナップショットの復元')], render: () => <RestoreSnapshot key={useConsole.getState().path} /> },
  { pattern: '/rds/subnet-groups', service: 'rds', contentType: 'table', crumbs: () => [RDS, SGRPS], render: () => <SubnetGroupList /> },
  { pattern: '/rds/subnet-groups/create', service: 'rds', contentType: 'form', crumbs: () => [RDS, SGRPS, here('DB サブネットグループを作成')], render: () => <CreateSubnetGroup /> },
  { pattern: '/rds/subnet-groups/:name', service: 'rds', crumbs: (p) => [RDS, SGRPS, here(p.name)], render: (p) => <SubnetGroupDetail name={p.name} key={p.name} /> },
];
