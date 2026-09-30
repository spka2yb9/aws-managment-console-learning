import { trail } from './cloudtrail';
import { alnum } from './edge';
import { evalStatement, evaluateIamPermission, findPolicy, statements } from './iam';
import { newUuid } from './ids';
import { AwsError, type AccountAssignment, type AwsEnv, type IdentityCenter, type Organization, type OrgPolicy, type PermissionSet, type PolicyDocument } from './types';

/**
 * AWS Organizations (OUs, accounts, service control policies) and IAM Identity Center (permission sets and
 * account assignments). The env is the management account; member accounts exist only as organization entries.
 */

export const FULL_AWS_ACCESS = 'p-FullAWSAccess';

export function getOrg(env: AwsEnv): Organization {
  if (!env.organization) throw new AwsError('AWSOrganizationsNotInUseException', 'Your account is not a member of an organization.');
  return env.organization;
}

export const entityName = (org: Organization, id: string) => (id === org.rootId ? 'Root' : (org.ous.find((o) => o.id === id)?.name ?? org.accounts.find((a) => a.id === id)?.name ?? id));
const parentOf = (org: Organization, id: string) => org.ous.find((o) => o.id === id)?.parentId ?? org.accounts.find((a) => a.id === id)?.parentId;

/** root → … → the entity itself */
export function pathOf(org: Organization, id: string): string[] {
  const path = [id];
  for (let p = parentOf(org, id); p; p = parentOf(org, p)) path.unshift(p);
  return path;
}

const exists = (org: Organization, id: string) => id === org.rootId || org.ous.some((o) => o.id === id) || org.accounts.some((a) => a.id === id);

export function createOrganizationalUnit(env: AwsEnv, parentId: string, name: string): string {
  const org = getOrg(env);
  if (!exists(org, parentId) || org.accounts.some((a) => a.id === parentId)) throw new AwsError('ParentNotFoundException', 'We can\'t find a root or OU with the ParentId that you specified.');
  if (!name.trim()) throw new AwsError('InvalidInputException', 'You provided a value that does not match the required pattern.');
  if (org.ous.some((o) => o.parentId === parentId && o.name === name.trim())) throw new AwsError('DuplicateOrganizationalUnitException', 'An OU with the same name already exists.');
  const id = `ou-${org.rootId.slice(2)}-${alnum(newUuid(), 8).toLowerCase()}`;
  org.ous.push({ id, arn: `arn:aws:organizations::${org.managementAccountId}:ou/${org.id}/${id}`, name: name.trim(), parentId });
  // every entity needs at least one SCP: new OUs get FullAWSAccess
  org.policies.find((p) => p.id === FULL_AWS_ACCESS)?.targets.push(id);
  trail(env, { source: 'organizations', name: 'CreateOrganizationalUnit', region: 'us-east-1', resources: [['AWS::Organizations::OrganizationalUnit', id]], request: { parentId, name: name.trim() }, response: { organizationalUnit: { id, name: name.trim() } } });
  return id;
}

export function moveAccount(env: AwsEnv, accountId: string, destinationParentId: string) {
  const org = getOrg(env);
  const a = org.accounts.find((x) => x.id === accountId);
  if (!a) throw new AwsError('AccountNotFoundException', 'We can\'t find an AWS account with the AccountId that you specified.');
  if (!exists(org, destinationParentId) || org.accounts.some((x) => x.id === destinationParentId)) throw new AwsError('DestinationParentNotFoundException', 'We can\'t find the destination container (a root or OU) with the ParentId that you specified.');
  if (a.parentId === destinationParentId) throw new AwsError('DuplicateAccountException', 'That account is already present in the specified destination.');
  const source = a.parentId;
  a.parentId = destinationParentId;
  trail(env, { source: 'organizations', name: 'MoveAccount', region: 'us-east-1', resources: [['AWS::Organizations::Account', accountId]], request: { accountId, sourceParentId: source, destinationParentId }, response: null });
}

export function createScp(env: AwsEnv, input: { name: string; description?: string; document: PolicyDocument }): string {
  const org = getOrg(env);
  if (!/^[\w+=,.@-]{1,128}$/.test(input.name)) throw new AwsError('InvalidInputException', 'You provided a value that does not match the required pattern.');
  if (org.policies.some((p) => p.name === input.name)) throw new AwsError('DuplicatePolicyException', 'A policy with the same name already exists.');
  if (statements(input.document).some((st) => st.Principal || st.NotPrincipal)) throw new AwsError('MalformedPolicyDocumentException', 'The provided policy document does not meet the requirements of the specified policy type. (Principal はサービスコントロールポリシーでは使えません)');
  const id = `p-${alnum(newUuid(), 8).toLowerCase()}`;
  org.policies.push({ id, arn: `arn:aws:organizations::${org.managementAccountId}:policy/${org.id}/service_control_policy/${id}`, name: input.name, description: input.description, awsManaged: false, document: input.document, targets: [] });
  trail(env, { source: 'organizations', name: 'CreatePolicy', region: 'us-east-1', resources: [['AWS::Organizations::Policy', id]], request: { name: input.name, description: input.description, type: 'SERVICE_CONTROL_POLICY' }, response: { policy: { policySummary: { id, name: input.name } } } });
  return id;
}

const getPolicy = (org: Organization, id: string): OrgPolicy => {
  const p = org.policies.find((x) => x.id === id);
  if (!p) throw new AwsError('PolicyNotFoundException', 'We can\'t find a policy with the PolicyId that you specified.');
  return p;
};

export function updateScp(env: AwsEnv, id: string, document: PolicyDocument) {
  const p = getPolicy(getOrg(env), id);
  if (p.awsManaged) throw new AwsError('PolicyChangesInProgressException', 'AWS managed policies can\'t be modified.');
  p.document = document;
  trail(env, { source: 'organizations', name: 'UpdatePolicy', region: 'us-east-1', resources: [['AWS::Organizations::Policy', id]], request: { policyId: id }, response: null });
}

/** DeletePolicy: only customer managed SCPs that are no longer attached anywhere. */
export function deleteScp(env: AwsEnv, id: string) {
  const org = getOrg(env);
  const p = getPolicy(org, id);
  if (p.awsManaged) throw new AwsError('AccessDeniedException', 'You can\'t delete an AWS managed policy.');
  if (p.targets.length) throw new AwsError('PolicyInUseException', 'The policy is attached to one or more entities. You must detach it from all roots, OUs, and accounts before performing this operation.');
  org.policies = org.policies.filter((x) => x !== p);
  trail(env, { source: 'organizations', name: 'DeletePolicy', region: 'us-east-1', resources: [['AWS::Organizations::Policy', id]], request: { policyId: id }, response: null });
}

export function attachScp(env: AwsEnv, policyId: string, targetId: string) {
  const org = getOrg(env);
  const p = getPolicy(org, policyId);
  if (!exists(org, targetId)) throw new AwsError('TargetNotFoundException', 'We can\'t find a root, OU, account, or email target with the TargetId that you specified.');
  if (p.targets.includes(targetId)) throw new AwsError('DuplicatePolicyAttachmentException', 'The selected policy is already attached to the specified target.');
  p.targets.push(targetId);
  trail(env, { source: 'organizations', name: 'AttachPolicy', region: 'us-east-1', resources: [['AWS::Organizations::Policy', policyId]], request: { policyId, targetId }, response: null });
}

export function detachScp(env: AwsEnv, policyId: string, targetId: string) {
  const org = getOrg(env);
  const p = getPolicy(org, policyId);
  if (!p.targets.includes(targetId)) throw new AwsError('PolicyNotAttachedException', 'The policy isn\'t attached to the specified target in the specified root.');
  if (org.policies.filter((x) => x.targets.includes(targetId)).length === 1) throw new AwsError('ConstraintViolationException', 'You cannot remove the last service control policy attached to this target. (少なくとも 1 つの SCP が必要です)');
  p.targets = p.targets.filter((t) => t !== targetId);
  trail(env, { source: 'organizations', name: 'DetachPolicy', region: 'us-east-1', resources: [['AWS::Organizations::Policy', policyId]], request: { policyId, targetId }, response: null });
}

export interface ScpLevel {
  targetId: string;
  name: string;
  /** some attached SCP allows the action at this level */
  allowedBy: string[];
  deniedBy: string[];
}

export interface ScpDecision {
  decision: 'Allow' | 'ExplicitDeny' | 'ImplicitDeny';
  /** the management account is never restricted by SCPs */
  exempt: boolean;
  levels: ScpLevel[];
}

/**
 * SCP evaluation: every level from the root down to the account must have an attached SCP that allows the action,
 * and no SCP on the path may deny it. SCPs never grant anything by themselves.
 */
export function evaluateScp(env: AwsEnv, accountId: string, action: string, context: Record<string, string>, resource = '*'): ScpDecision {
  const org = getOrg(env);
  if (accountId === org.managementAccountId) return { decision: 'Allow', exempt: true, levels: [] };
  const levels = pathOf(org, accountId).map((targetId): ScpLevel => {
    const attached = org.policies.filter((p) => p.targets.includes(targetId));
    const applies = (p: OrgPolicy, effect: 'Allow' | 'Deny') => statements(p.document).some((st) => st.Effect === effect && evalStatement(env, st, { principal: { type: 'user', userName: '-' }, action, resource, context }, 'identity', p.name).applies);
    return { targetId, name: entityName(org, targetId), allowedBy: attached.filter((p) => applies(p, 'Allow')).map((p) => p.name), deniedBy: attached.filter((p) => applies(p, 'Deny')).map((p) => p.name) };
  });
  const decision = levels.some((l) => l.deniedBy.length) ? 'ExplicitDeny' : levels.every((l) => l.allowedBy.length) ? 'Allow' : 'ImplicitDeny';
  return { decision, exempt: false, levels };
}

// ---------------- IAM Identity Center ----------------

export function getSso(env: AwsEnv): IdentityCenter {
  if (!env.identityCenter) throw new AwsError('ResourceNotFoundException', 'IAM Identity Center is not enabled.');
  return env.identityCenter;
}

/** predefined permission sets offered by the console (each one AWS managed policy) */
export const PREDEFINED_PERMISSION_SETS = [
  { name: 'AdministratorAccess', description: 'AWS のサービスとリソースへのフルアクセス' },
  { name: 'PowerUserAccess', description: 'IAM と Organizations の管理以外のフルアクセス' },
  { name: 'ReadOnlyAccess', description: 'すべてのサービスとリソースの読み取り専用アクセス' },
];

export function createPermissionSet(env: AwsEnv, input: { name: string; description?: string; managedPolicyArns: string[]; sessionDuration?: string }, now = Date.now()): string {
  const sso = getSso(env);
  if (!/^[\w+=,.@-]{1,32}$/.test(input.name)) throw new AwsError('ValidationException', 'The permission set name is not valid.');
  if (sso.permissionSets.some((p) => p.name === input.name)) throw new AwsError('ConflictException', `PermissionSet with name ${input.name} already exists.`);
  const arn = `${sso.instanceArn.replace(':instance/', ':permissionSet/')}/ps-${alnum(newUuid(), 16).toLowerCase()}`;
  sso.permissionSets.push({ name: input.name, arn, description: input.description, managedPolicyArns: input.managedPolicyArns, sessionDuration: input.sessionDuration ?? 'PT1H', createdAt: now });
  trail(env, { source: 'sso', name: 'CreatePermissionSet', region: sso.region, resources: [['AWS::SSO::PermissionSet', arn]], request: { instanceArn: sso.instanceArn, name: input.name, sessionDuration: input.sessionDuration ?? 'PT1H' }, response: { permissionSet: { name: input.name, permissionSetArn: arn } } });
  return arn;
}

/** DeletePermissionSet: refused while any account assignment still uses it. */
export function deletePermissionSet(env: AwsEnv, arn: string) {
  const sso = getSso(env);
  const ps = sso.permissionSets.find((p) => p.arn === arn);
  if (!ps) throw new AwsError('ResourceNotFoundException', 'The permission set does not exist.');
  if (sso.assignments.some((a) => a.permissionSetArn === arn)) throw new AwsError('ConflictException', `Permission set ${ps.name} is provisioned to one or more accounts. Remove its account assignments first.`);
  sso.permissionSets = sso.permissionSets.filter((p) => p !== ps);
  trail(env, { source: 'sso', name: 'DeletePermissionSet', region: sso.region, resources: [['AWS::SSO::PermissionSet', arn]], request: { instanceArn: sso.instanceArn, permissionSetArn: arn }, response: null });
}

export function createAccountAssignment(env: AwsEnv, a: AccountAssignment) {
  const sso = getSso(env);
  const org = getOrg(env);
  if (!org.accounts.some((x) => x.id === a.accountId) && a.accountId !== org.managementAccountId) throw new AwsError('ValidationException', `The account ${a.accountId} is not in the organization.`);
  if (!sso.permissionSets.some((p) => p.arn === a.permissionSetArn)) throw new AwsError('ResourceNotFoundException', 'The permission set does not exist.');
  const known = a.principalType === 'GROUP' ? sso.groups.some((g) => g.groupName === a.principalName) : sso.users.some((u) => u.userName === a.principalName);
  if (!known) throw new AwsError('ResourceNotFoundException', `The ${a.principalType.toLowerCase()} ${a.principalName} does not exist.`);
  if (sso.assignments.some((x) => sameAssignment(x, a))) throw new AwsError('ConflictException', 'The account assignment already exists.');
  sso.assignments.push({ ...a });
  trail(env, { source: 'sso', name: 'CreateAccountAssignment', region: sso.region, resources: [['AWS::SSO::Assignment', a.accountId]], request: { instanceArn: sso.instanceArn, targetId: a.accountId, targetType: 'AWS_ACCOUNT', permissionSetArn: a.permissionSetArn, principalType: a.principalType, principalId: a.principalName }, response: { accountAssignmentCreationStatus: { status: 'SUCCEEDED' } } });
}

const sameAssignment = (x: AccountAssignment, a: AccountAssignment) => x.accountId === a.accountId && x.permissionSetArn === a.permissionSetArn && x.principalType === a.principalType && x.principalName === a.principalName;

export function deleteAccountAssignment(env: AwsEnv, a: AccountAssignment) {
  const sso = getSso(env);
  if (!sso.assignments.some((x) => sameAssignment(x, a))) throw new AwsError('ResourceNotFoundException', 'The account assignment does not exist.');
  sso.assignments = sso.assignments.filter((x) => !sameAssignment(x, a));
  trail(env, { source: 'sso', name: 'DeleteAccountAssignment', region: sso.region, resources: [['AWS::SSO::Assignment', a.accountId]], request: { instanceArn: sso.instanceArn, targetId: a.accountId, targetType: 'AWS_ACCOUNT', permissionSetArn: a.permissionSetArn, principalType: a.principalType, principalId: a.principalName }, response: { accountAssignmentDeletionStatus: { status: 'SUCCEEDED' } } });
}

/** what the user sees in the AWS access portal: account × permission set (directly or through a group) */
export function portalAccess(env: AwsEnv, userName: string): { accountId: string; permissionSet: PermissionSet; via: string }[] {
  const sso = getSso(env);
  const user = sso.users.find((u) => u.userName === userName);
  if (!user) return [];
  const out: { accountId: string; permissionSet: PermissionSet; via: string }[] = [];
  for (const a of sso.assignments) {
    const mine = a.principalType === 'USER' ? a.principalName === userName : user.groups.includes(a.principalName);
    const ps = sso.permissionSets.find((p) => p.arn === a.permissionSetArn);
    if (mine && ps && !out.some((o) => o.accountId === a.accountId && o.permissionSet.arn === ps.arn)) out.push({ accountId: a.accountId, permissionSet: ps, via: a.principalType === 'USER' ? 'ユーザー' : `グループ ${a.principalName}` });
  }
  return out.sort((x, y) => x.accountId.localeCompare(y.accountId) || x.permissionSet.name.localeCompare(y.permissionSet.name));
}

export interface AccessTest {
  allowed: boolean;
  /** AWS error text when denied */
  error?: string;
  layers: { label: string; ok: boolean; detail: string }[];
}

/**
 * Signing in to an account with a permission set = assuming the AWSReservedSSO_<name>_… role there.
 * The request is allowed only if the permission set's policies allow it AND the SCPs on the account's path do.
 */
export function testAccess(env: AwsEnv, q: { userName: string; accountId: string; permissionSetName: string; action: string; region: string; resource?: string }): AccessTest {
  const org = getOrg(env);
  const access = portalAccess(env, q.userName).find((a) => a.accountId === q.accountId && a.permissionSet.name === q.permissionSetName);
  const account = entityName(org, q.accountId);
  if (!access) return { allowed: false, error: `${q.userName} は ${account} に ${q.permissionSetName} でサインインできません (割り当てがありません)`, layers: [{ label: 'アカウントの割り当て', ok: false, detail: `${account} × ${q.permissionSetName} の割り当てがありません` }] };
  const resource = q.resource?.trim() || '*';
  const context = { 'aws:RequestedRegion': q.region };
  const identity = access.permissionSet.managedPolicyArns.flatMap((arn) => {
    const p = findPolicy(env, arn);
    return p ? [{ source: `${p.policyName} (許可セット ${q.permissionSetName})`, doc: p.document }] : [];
  });
  const iam = evaluateIamPermission(env, { principal: { type: 'user', userName: q.userName }, action: q.action, resource, context }, identity);
  const scp = evaluateScp(env, q.accountId, q.action, context, resource);
  const layers = [
    { label: 'アカウントの割り当て', ok: true, detail: `${account} × ${q.permissionSetName} (${access.via})` },
    { label: '許可セットのポリシー', ok: iam.decision === 'Allow', detail: iam.decision === 'Allow' ? `${iam.statements.find((s) => s.applies && s.effect === 'Allow')?.source} が許可` : iam.decision === 'ExplicitDeny' ? '明示的に拒否されています' : 'どのポリシーも許可していません (暗黙的な拒否)' },
    ...(scp.exempt
      ? [{ label: 'サービスコントロールポリシー (SCP)', ok: true, detail: '管理アカウントには SCP が適用されません' }]
      : scp.levels.map((l) => ({ label: `SCP: ${l.name}`, ok: !l.deniedBy.length && l.allowedBy.length > 0, detail: l.deniedBy.length ? `${l.deniedBy.join(', ')} が拒否` : l.allowedBy.length ? `${l.allowedBy.join(', ')} が許可` : 'このレベルの SCP がどれも許可していません' }))),
  ];
  const allowed = iam.decision === 'Allow' && scp.decision === 'Allow';
  const principal = `arn:aws:sts::${q.accountId}:assumed-role/AWSReservedSSO_${q.permissionSetName}_${alnum(access.permissionSet.arn, 16).toLowerCase()}/${q.userName}`;
  const why = scp.decision === 'ExplicitDeny' ? 'with an explicit deny in a service control policy' : iam.decision === 'ExplicitDeny' ? 'with an explicit deny in an identity-based policy' : iam.decision !== 'Allow' ? 'because no identity-based policy allows the ' + q.action + ' action' : 'because no service control policy allows the ' + q.action + ' action';
  return { allowed, error: allowed ? undefined : `User: ${principal} is not authorized to perform: ${q.action} on resource: ${resource} ${why}`, layers };
}
