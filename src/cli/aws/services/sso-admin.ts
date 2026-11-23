/* aws sso-admin — IAM Identity Center の管理 (許可セットとアカウントへの割り当て)、aws identitystore — ユーザーとグループ */
import { trail } from '../../../sim/cloudtrail';
import { stableChars } from '../../../sim/ids';
import { findPolicy } from '../../../sim/iam';
import { createAccountAssignment, createPermissionSet, deleteAccountAssignment, deletePermissionSet, getSso } from '../../../sim/organizations';
import type { AccountAssignment, AwsEnv, IdentityCenter, PermissionSet } from '../../../sim/types';
import { AwsError, iso, list, req, service, str, structs, type OpContext, type OperationSpec } from '../types';

/* ---- Identity Store の ID。sim はユーザー・グループを名前で持つので、名前から決まる UUID の形の ID を作る ---- */
export const principalId = (sso: IdentityCenter, type: string, name: string) => {
  const h = stableChars(`${sso.identityStoreId}/${type}/${name}`, '0123456789abcdef', 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const groupIdOf = (sso: IdentityCenter, name: string) => principalId(sso, 'GROUP', name);
const userIdOf = (sso: IdentityCenter, name: string) => principalId(sso, 'USER', name);

function principalName(sso: IdentityCenter, type: string, id: string): string {
  if (type !== 'GROUP' && type !== 'USER') throw new AwsError('ValidationException', `1 validation error detected: Value '${type}' at 'principalType' failed to satisfy constraint: Member must satisfy enum value set: [USER, GROUP]`);
  const names = type === 'GROUP' ? sso.groups.map((g) => g.groupName) : sso.users.map((u) => u.userName);
  const name = names.find((n) => principalId(sso, type, n) === id);
  if (!name) throw new AwsError('ResourceNotFoundException', `The ${type.toLowerCase()} ${id} does not exist.`);
  return name;
}

function instanceOf(ctx: OpContext): IdentityCenter {
  const sso = getSso(ctx.env);
  if (req(ctx, 'instance-arn') !== sso.instanceArn) throw new AwsError('ResourceNotFoundException', `The instance ${str(ctx, 'instance-arn')} does not exist.`);
  return sso;
}

function permissionSetOf(ctx: OpContext): PermissionSet {
  const arn = req(ctx, 'permission-set-arn');
  const ps = instanceOf(ctx).permissionSets.find((p) => p.arn === arn);
  if (!ps) throw new AwsError('ResourceNotFoundException', `The permission set ${arn} does not exist.`);
  return ps;
}

const psOut = (p: PermissionSet) => ({ Name: p.name, PermissionSetArn: p.arn, ...(p.description ? { Description: p.description } : {}), CreatedDate: iso(p.createdAt), SessionDuration: p.sessionDuration });

/** --target-id / --permission-set-arn / --principal-type / --principal-id を sim の割り当てに */
function assignmentOf(ctx: OpContext): AccountAssignment {
  const sso = instanceOf(ctx);
  if (req(ctx, 'target-type') !== 'AWS_ACCOUNT') throw new AwsError('ValidationException', `1 validation error detected: Value '${str(ctx, 'target-type')}' at 'targetType' failed to satisfy constraint: Member must satisfy enum value set: [AWS_ACCOUNT]`);
  const type = req(ctx, 'principal-type');
  return { accountId: req(ctx, 'target-id'), permissionSetArn: permissionSetOf(ctx).arn, principalType: type as 'USER' | 'GROUP', principalName: principalName(sso, type, req(ctx, 'principal-id')) };
}

const assignmentStatus = (ctx: OpContext, a: AccountAssignment) => ({
  Status: 'IN_PROGRESS',
  RequestId: stableChars(`${ctx.now}${a.accountId}${a.permissionSetArn}`, '0123456789abcdef', 8) + '-0000-4000-8000-' + stableChars(a.principalName, '0123456789abcdef', 12),
  TargetId: a.accountId,
  TargetType: 'AWS_ACCOUNT',
  PermissionSetArn: a.permissionSetArn,
  PrincipalType: a.principalType,
  PrincipalId: req(ctx, 'principal-id'),
  CreatedDate: iso(ctx.now),
});

const instanceArn = { name: 'instance-arn', type: 'string' as const, required: true, desc: 'IAM Identity Center のインスタンスの ARN (aws sso-admin list-instances)' };
const permissionSetArn = { name: 'permission-set-arn', type: 'string' as const, required: true, desc: '許可セットの ARN' };
const assignmentParams = [
  instanceArn,
  { name: 'target-id', type: 'string' as const, required: true, desc: 'AWS アカウント ID' },
  { name: 'target-type', type: 'string' as const, required: true, desc: 'AWS_ACCOUNT' },
  permissionSetArn,
  { name: 'principal-type', type: 'string' as const, required: true, desc: 'GROUP / USER' },
  { name: 'principal-id', type: 'string' as const, required: true, desc: 'グループ / ユーザーの ID (aws identitystore list-groups の GroupId)' },
];

function trailSso(env: AwsEnv, name: string, ps: PermissionSet, request: Record<string, unknown>) {
  const sso = getSso(env);
  trail(env, { source: 'sso', name, region: sso.region, resources: [['AWS::SSO::PermissionSet', ps.arn]], request: { instanceArn: sso.instanceArn, permissionSetArn: ps.arn, ...request }, response: null });
}

const ssoAdmin: OperationSpec[] = [
  {
    name: 'list-instances',
    desc: 'IAM Identity Center のインスタンス (組織に 1 つ) の ARN と Identity Store の ID',
    params: [],
    readOnly: true,
    run(ctx) {
      const sso = getSso(ctx.env);
      return { Instances: [{ InstanceArn: sso.instanceArn, IdentityStoreId: sso.identityStoreId, OwnerAccountId: ctx.env.accountId, Name: 'webapp', CreatedDate: iso(Math.min(...sso.permissionSets.map((p) => p.createdAt), ctx.now)), Status: 'ACTIVE' }] };
    },
  },
  {
    name: 'list-permission-sets',
    desc: '許可セットの ARN の一覧',
    params: [instanceArn],
    readOnly: true,
    run: (ctx) => ({ PermissionSets: instanceOf(ctx).permissionSets.map((p) => p.arn) }),
  },
  {
    name: 'describe-permission-set',
    desc: '許可セットの名前・セッション期間',
    params: [instanceArn, permissionSetArn],
    readOnly: true,
    run: (ctx) => ({ PermissionSet: psOut(permissionSetOf(ctx)) }),
  },
  {
    name: 'list-managed-policies-in-permission-set',
    desc: '許可セットに付いている AWS 管理ポリシー',
    params: [instanceArn, permissionSetArn],
    readOnly: true,
    run: (ctx) => ({ AttachedManagedPolicies: permissionSetOf(ctx).managedPolicyArns.map((a) => ({ Name: a.split('/').pop(), Arn: a })) }),
  },
  {
    name: 'list-permission-sets-provisioned-to-account',
    desc: 'そのアカウントに配られている (割り当てで使われている) 許可セット',
    params: [instanceArn, { name: 'account-id', type: 'string', required: true, desc: 'AWS アカウント ID' }],
    readOnly: true,
    run(ctx) {
      const sso = instanceOf(ctx);
      return { PermissionSets: [...new Set(sso.assignments.filter((a) => a.accountId === req(ctx, 'account-id')).map((a) => a.permissionSetArn))] };
    },
  },
  {
    name: 'create-permission-set',
    desc: '許可セットを作る (ポリシーは attach-managed-policy-to-permission-set で付ける)',
    params: [
      instanceArn,
      { name: 'name', type: 'string', required: true, desc: '許可セットの名前' },
      { name: 'description', type: 'string', desc: '説明' },
      { name: 'session-duration', type: 'string', desc: 'セッション期間 (ISO 8601。PT1H〜PT12H、既定 PT1H)' },
    ],
    examples: ['aws sso-admin create-permission-set --instance-arn <ARN> --name ReadOnlyAccess --session-duration PT4H'],
    run(ctx) {
      instanceOf(ctx);
      const duration = str(ctx, 'session-duration');
      if (duration && !/^PT([1-9]|1[0-2])H$/.test(duration)) throw new AwsError('ValidationException', `1 validation error detected: Value '${duration}' at 'sessionDuration' failed to satisfy constraint: Member must be between PT1H and PT12H`);
      const arn = createPermissionSet(ctx.env, { name: req(ctx, 'name'), description: str(ctx, 'description'), managedPolicyArns: [], sessionDuration: duration }, ctx.now);
      return { PermissionSet: psOut(getSso(ctx.env).permissionSets.find((p) => p.arn === arn)!) };
    },
  },
  {
    name: 'delete-permission-set',
    desc: '許可セットを消す (割り当てで使われていると消せない)',
    params: [instanceArn, permissionSetArn],
    run(ctx) {
      deletePermissionSet(ctx.env, permissionSetOf(ctx).arn);
      return undefined;
    },
  },
  {
    name: 'attach-managed-policy-to-permission-set',
    desc: '許可セットに AWS 管理ポリシー (arn:aws:iam::aws:policy/...) を付ける',
    params: [instanceArn, permissionSetArn, { name: 'managed-policy-arn', type: 'string', required: true, desc: '例: arn:aws:iam::aws:policy/ReadOnlyAccess' }],
    examples: ['aws sso-admin attach-managed-policy-to-permission-set --instance-arn <ARN> --permission-set-arn <ARN> --managed-policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess'],
    run(ctx) {
      const ps = permissionSetOf(ctx);
      const arn = req(ctx, 'managed-policy-arn');
      if (!arn.startsWith('arn:aws:iam::aws:policy/') || !findPolicy(ctx.env, arn)) throw new AwsError('ResourceNotFoundException', `Policy ${arn} does not exist. (AWS 管理ポリシーの ARN を指定します)`);
      if (ps.managedPolicyArns.includes(arn)) throw new AwsError('ConflictException', `Managed policy ${arn} is already attached to the permission set.`);
      ps.managedPolicyArns.push(arn);
      trailSso(ctx.env, 'AttachManagedPolicyToPermissionSet', ps, { managedPolicyArn: arn });
      return undefined;
    },
  },
  {
    name: 'detach-managed-policy-from-permission-set',
    desc: '許可セットから AWS 管理ポリシーを外す',
    params: [instanceArn, permissionSetArn, { name: 'managed-policy-arn', type: 'string', required: true, desc: 'ポリシーの ARN' }],
    run(ctx) {
      const ps = permissionSetOf(ctx);
      const arn = req(ctx, 'managed-policy-arn');
      if (!ps.managedPolicyArns.includes(arn)) throw new AwsError('ResourceNotFoundException', `Managed policy ${arn} is not attached to the permission set.`);
      ps.managedPolicyArns = ps.managedPolicyArns.filter((a) => a !== arn);
      trailSso(ctx.env, 'DetachManagedPolicyFromPermissionSet', ps, { managedPolicyArn: arn });
      return undefined;
    },
  },
  {
    name: 'list-account-assignments',
    desc: 'アカウントで、その許可セットを誰 (グループ / ユーザー) に割り当てているか',
    params: [instanceArn, { name: 'account-id', type: 'string', required: true, desc: 'AWS アカウント ID' }, permissionSetArn],
    readOnly: true,
    run(ctx) {
      const sso = instanceOf(ctx);
      const ps = permissionSetOf(ctx);
      const account = req(ctx, 'account-id');
      return {
        AccountAssignments: sso.assignments
          .filter((a) => a.accountId === account && a.permissionSetArn === ps.arn)
          .map((a) => ({ AccountId: a.accountId, PermissionSetArn: a.permissionSetArn, PrincipalType: a.principalType, PrincipalId: principalId(sso, a.principalType, a.principalName) })),
      };
    },
  },
  {
    name: 'create-account-assignment',
    desc: 'アカウントで、グループ / ユーザーに許可セットを割り当てる (そのアカウントに AWSReservedSSO_… ロールができる)',
    params: assignmentParams,
    run(ctx) {
      const a = assignmentOf(ctx);
      createAccountAssignment(ctx.env, a);
      return { AccountAssignmentCreationStatus: assignmentStatus(ctx, a) };
    },
  },
  {
    name: 'delete-account-assignment',
    desc: 'アカウントでの、グループ / ユーザーへの許可セットの割り当てを消す',
    params: assignmentParams,
    run(ctx) {
      const a = assignmentOf(ctx);
      deleteAccountAssignment(ctx.env, a);
      return { AccountAssignmentDeletionStatus: assignmentStatus(ctx, a) };
    },
  },
];

/* ---- identitystore ---- */

function storeOf(ctx: OpContext): IdentityCenter {
  const sso = getSso(ctx.env);
  if (req(ctx, 'identity-store-id') !== sso.identityStoreId) throw new AwsError('ResourceNotFoundException', `Identity store ${str(ctx, 'identity-store-id')} not found.`);
  return sso;
}

const groupOut = (sso: IdentityCenter, g: IdentityCenter['groups'][number]) => ({ GroupId: groupIdOf(sso, g.groupName), DisplayName: g.groupName, ...(g.description ? { Description: g.description } : {}), IdentityStoreId: sso.identityStoreId });
const storeId = { name: 'identity-store-id', type: 'string' as const, required: true, desc: 'Identity Store の ID (aws sso-admin list-instances の IdentityStoreId)' };
const attrFilters = { name: 'filters', type: 'list' as const, of: 'structure' as const, desc: '例: AttributePath=DisplayName,AttributeValue=Developers' };
/** --filters AttributePath=…,AttributeValue=… (完全一致) */
const matches = (ctx: OpContext, attrs: Record<string, string>) => structs(ctx, 'filters').every((f) => list(f.AttributeValue).includes(attrs[String(f.AttributePath)] ?? ''));

const identitystore: OperationSpec[] = [
  {
    name: 'list-users',
    desc: 'ユーザーの一覧',
    params: [storeId, attrFilters],
    readOnly: true,
    run(ctx) {
      const sso = storeOf(ctx);
      return {
        Users: sso.users
          .filter((u) => matches(ctx, { UserName: u.userName }))
          .map((u) => ({ UserName: u.userName, UserId: userIdOf(sso, u.userName), DisplayName: u.displayName, Emails: [{ Value: u.email, Type: 'work', Primary: true }], IdentityStoreId: sso.identityStoreId })),
      };
    },
  },
  {
    name: 'list-groups',
    desc: 'グループの一覧',
    params: [storeId, attrFilters],
    readOnly: true,
    run(ctx) {
      const sso = storeOf(ctx);
      return { Groups: sso.groups.filter((g) => matches(ctx, { DisplayName: g.groupName })).map((g) => groupOut(sso, g)) };
    },
  },
  {
    name: 'describe-group',
    desc: 'グループの ID から名前を引く',
    params: [storeId, { name: 'group-id', type: 'string', required: true, desc: 'グループの ID' }],
    readOnly: true,
    run(ctx) {
      const sso = storeOf(ctx);
      const g = sso.groups.find((x) => groupIdOf(sso, x.groupName) === req(ctx, 'group-id'));
      if (!g) throw new AwsError('ResourceNotFoundException', `GROUP not found.`);
      return groupOut(sso, g);
    },
  },
];

export default [service('sso-admin', 'IAM Identity Center の管理 (許可セットとアカウントへの割り当て)', ssoAdmin), service('identitystore', 'IAM Identity Center のユーザーとグループ (Identity Store)', identitystore)];
