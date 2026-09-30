import { label } from '../../sim/env';
import type { AwsEnv } from '../../sim/types';
import type { ConsoleRoute, Crumb } from '../routes';
import { queryParam } from '../ui';
import { ConnectInstance, InstanceTerminal, ModifyIamRole } from './ec2-connect';
import { AttachPolicies, CreateInlinePolicy, CreatePolicyPage, CreateRoleWizard, EditPolicy, EditTrustPolicy, IamDashboard, InlinePolicyView, PolicyDetail, PolicyList, PolicySimulator, RoleDetail, RoleList, UserDetail, UserList } from './iam';
import { BucketDetail, BucketList, CreateBucketPage, EditBpa, EditBucketPolicy, EditEncryption, EditVersioning, ObjectDetail, UploadObjects } from './s3';
import { useConsole } from '../store';

const S3: Crumb = { text: 'Amazon S3', href: '/s3/buckets' };
const BUCKETS: Crumb = { text: 'バケット', href: '/s3/buckets' };
const IAM: Crumb = { text: 'IAM', href: '/iam/home' };
const ROLES: Crumb = { text: 'ロール', href: '/iam/roles' };
const USERS: Crumb = { text: 'ユーザー', href: '/iam/users' };
const POLICIES: Crumb = { text: 'ポリシー', href: '/iam/policies' };
const EC2: Crumb = { text: 'EC2', href: '/ec2/home' };
const here = (text: string): Crumb => ({ text, href: '' });
const bucket = (n: string): Crumb => ({ text: n, href: `/s3/buckets/${n}` });
const instance = (env: AwsEnv, id: string): Crumb => ({ text: label(id, env.instances.find((i) => i.instanceId === id)), href: `/ec2/instances/${id}` });
const policyName = (env: AwsEnv) => {
  const arn = queryParam(useConsole.getState().path, 'arn') ?? '';
  return [...env.iamPolicies].find((p) => p.arn === arn)?.policyName ?? arn.split('/').pop() ?? '';
};

export const S3_IAM_ROUTES: ConsoleRoute[] = [
  { pattern: '/s3/buckets', service: 's3', contentType: 'table', crumbs: () => [S3, BUCKETS], render: () => <BucketList /> },
  { pattern: '/s3/create', service: 's3', contentType: 'form', crumbs: () => [S3, BUCKETS, here('バケットを作成')], render: () => <CreateBucketPage /> },
  { pattern: '/s3/buckets/:name', service: 's3', crumbs: (p) => [S3, BUCKETS, here(p.name)], render: (p) => <BucketDetail name={p.name} key={p.name} /> },
  { pattern: '/s3/buckets/:name/object', service: 's3', crumbs: (p) => [S3, BUCKETS, bucket(p.name), here(queryParam(useConsole.getState().path, 'key')?.split('/').pop() ?? '')], render: (p) => <ObjectDetail name={p.name} key={useConsole.getState().path} /> },
  { pattern: '/s3/buckets/:name/upload', service: 's3', contentType: 'form', crumbs: (p) => [S3, BUCKETS, bucket(p.name), here('アップロード')], render: (p) => <UploadObjects name={p.name} key={p.name} /> },
  { pattern: '/s3/buckets/:name/edit-policy', service: 's3', contentType: 'form', crumbs: (p) => [S3, BUCKETS, bucket(p.name), here('バケットポリシーを編集')], render: (p) => <EditBucketPolicy name={p.name} key={p.name} /> },
  { pattern: '/s3/buckets/:name/edit-bpa', service: 's3', contentType: 'form', crumbs: (p) => [S3, BUCKETS, bucket(p.name), here('ブロックパブリックアクセスを編集')], render: (p) => <EditBpa name={p.name} key={p.name} /> },
  { pattern: '/s3/buckets/:name/edit-versioning', service: 's3', contentType: 'form', crumbs: (p) => [S3, BUCKETS, bucket(p.name), here('バケットのバージョニングを編集')], render: (p) => <EditVersioning name={p.name} key={p.name} /> },
  { pattern: '/s3/buckets/:name/edit-encryption', service: 's3', contentType: 'form', crumbs: (p) => [S3, BUCKETS, bucket(p.name), here('デフォルトの暗号化を編集')], render: (p) => <EditEncryption name={p.name} key={p.name} /> },
  { pattern: '/iam/home', service: 'iam', crumbs: () => [IAM, here('ダッシュボード')], render: () => <IamDashboard /> },
  { pattern: '/iam/users', service: 'iam', contentType: 'table', crumbs: () => [IAM, USERS], render: () => <UserList /> },
  { pattern: '/iam/users/:name', service: 'iam', crumbs: (p) => [IAM, USERS, here(p.name)], render: (p) => <UserDetail name={p.name} key={p.name} /> },
  { pattern: '/iam/users/:name/attach-policies', service: 'iam', contentType: 'form', crumbs: (p) => [IAM, USERS, { text: p.name, href: `/iam/users/${p.name}` }, here('許可を追加')], render: (p) => <AttachPolicies type="user" name={p.name} key={p.name} /> },
  { pattern: '/iam/users/:name/create-inline', service: 'iam', contentType: 'form', crumbs: (p) => [IAM, USERS, { text: p.name, href: `/iam/users/${p.name}` }, here('インラインポリシーの作成')], render: (p) => <CreateInlinePolicy type="user" name={p.name} key={p.name} /> },
  { pattern: '/iam/users/:name/inline', service: 'iam', crumbs: (p) => [IAM, USERS, { text: p.name, href: `/iam/users/${p.name}` }, here('インラインポリシー')], render: (p) => <InlinePolicyView type="user" name={p.name} /> },
  { pattern: '/iam/roles', service: 'iam', contentType: 'table', crumbs: () => [IAM, ROLES], render: () => <RoleList /> },
  { pattern: '/iam/roles/create', service: 'iam', contentType: 'wizard', crumbs: () => [IAM, ROLES, here('ロールを作成')], render: () => <CreateRoleWizard /> },
  { pattern: '/iam/roles/:name', service: 'iam', crumbs: (p) => [IAM, ROLES, here(p.name)], render: (p) => <RoleDetail name={p.name} key={p.name} /> },
  { pattern: '/iam/roles/:name/attach-policies', service: 'iam', contentType: 'form', crumbs: (p) => [IAM, ROLES, { text: p.name, href: `/iam/roles/${p.name}` }, here('許可を追加')], render: (p) => <AttachPolicies type="role" name={p.name} key={p.name} /> },
  { pattern: '/iam/roles/:name/create-inline', service: 'iam', contentType: 'form', crumbs: (p) => [IAM, ROLES, { text: p.name, href: `/iam/roles/${p.name}` }, here('インラインポリシーの作成')], render: (p) => <CreateInlinePolicy type="role" name={p.name} key={p.name} /> },
  { pattern: '/iam/roles/:name/inline', service: 'iam', crumbs: (p) => [IAM, ROLES, { text: p.name, href: `/iam/roles/${p.name}` }, here('インラインポリシー')], render: (p) => <InlinePolicyView type="role" name={p.name} /> },
  { pattern: '/iam/roles/:name/edit-trust', service: 'iam', contentType: 'form', crumbs: (p) => [IAM, ROLES, { text: p.name, href: `/iam/roles/${p.name}` }, here('信頼ポリシーを編集')], render: (p) => <EditTrustPolicy name={p.name} key={p.name} /> },
  { pattern: '/iam/policies', service: 'iam', contentType: 'table', crumbs: () => [IAM, POLICIES], render: () => <PolicyList /> },
  { pattern: '/iam/policies/create', service: 'iam', contentType: 'form', crumbs: () => [IAM, POLICIES, here('ポリシーの作成')], render: () => <CreatePolicyPage /> },
  { pattern: '/iam/policies/view', service: 'iam', crumbs: (_, env) => [IAM, POLICIES, here(policyName(env))], render: () => <PolicyDetail key={useConsole.getState().path} /> },
  { pattern: '/iam/policies/edit', service: 'iam', contentType: 'form', crumbs: (_, env) => [IAM, POLICIES, { text: policyName(env), href: '' }, here('編集')], render: () => <EditPolicy key={useConsole.getState().path} /> },
  { pattern: '/iam/simulator', service: 'iam', crumbs: () => [IAM, here('ポリシーシミュレーター')], render: () => <PolicySimulator /> },
  { pattern: '/ec2/instances/:id/connect', service: 'ec2', crumbs: (p, env) => [EC2, { text: 'インスタンス', href: '/ec2/instances' }, instance(env, p.id), here('インスタンスに接続')], render: (p) => <ConnectInstance id={p.id} key={p.id} /> },
  { pattern: '/ec2/instances/:id/terminal', service: 'ec2', crumbs: (p, env) => [EC2, { text: 'インスタンス', href: '/ec2/instances' }, instance(env, p.id), here('EC2 Instance Connect')], render: (p) => <InstanceTerminal id={p.id} key={p.id} /> },
  { pattern: '/ec2/instances/:id/modify-iam-role', service: 'ec2', contentType: 'form', crumbs: (p, env) => [EC2, { text: 'インスタンス', href: '/ec2/instances' }, instance(env, p.id), here('IAM ロールを変更')], render: (p) => <ModifyIamRole id={p.id} key={p.id} /> },
];
