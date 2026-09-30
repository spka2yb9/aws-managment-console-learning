import { ipInCidr, isValidCidr } from './cidr';
import { trail } from './cloudtrail';
import { getInstance } from './env';
import { randomInt } from './ids';
import { AwsError, type AwsEnv, type IamRole, type IamUser, type InlinePolicy, type ManagedPolicy, type PolicyDocument, type PolicyStatement, type StringOrList } from './types';

// ---------- ids / arns ----------

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** IAM unique ids: AROA… (role), AIDA… (user), ANPA… (policy), AIPA… (instance profile). */
export function iamId(prefix: 'AROA' | 'AIDA' | 'ANPA' | 'AIPA' | 'ASIA'): string {
  return prefix + Array.from({ length: 17 }, () => UPPER[randomInt(UPPER.length)]).join('');
}

export const roleArn = (env: AwsEnv, name: string, path = '/') => `arn:aws:iam::${env.accountId}:role${path}${name}`;
export const userArn = (env: AwsEnv, name: string) => `arn:aws:iam::${env.accountId}:user/${name}`;
export const policyArn = (env: AwsEnv, name: string) => `arn:aws:iam::${env.accountId}:policy/${name}`;
export const instanceProfileArn = (env: AwsEnv, name: string) => `arn:aws:iam::${env.accountId}:instance-profile/${name}`;
export const sessionArn = (env: AwsEnv, role: string, session: string) => `arn:aws:sts::${env.accountId}:assumed-role/${role}/${session}`;

export const list = (v: StringOrList | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
export const statements = (d: PolicyDocument): PolicyStatement[] => (Array.isArray(d.Statement) ? d.Statement : [d.Statement]);

// ---------- AWS managed policies (the ones lessons need; documents match AWS) ----------

const aws = (policyName: string, description: string, Statement: PolicyStatement[]): ManagedPolicy => ({
  policyName,
  policyId: `ANPA${policyName.toUpperCase().replace(/[^A-Z]/g, '').padEnd(17, 'X').slice(0, 17)}`,
  arn: `arn:aws:iam::aws:policy/${policyName}`,
  path: '/',
  awsManaged: true,
  description,
  document: { Version: '2012-10-17', Statement },
  createDate: '2015-02-06T18:40:00Z',
  updateDate: '2023-08-10T21:31:00Z',
});

export const AWS_MANAGED_POLICIES: ManagedPolicy[] = [
  aws('AdministratorAccess', 'Provides full access to AWS services and resources.', [{ Effect: 'Allow', Action: '*', Resource: '*' }]),
  aws('PowerUserAccess', 'Provides full access to AWS services and resources, but does not allow management of Users and groups.', [
    { Effect: 'Allow', NotAction: ['iam:*', 'organizations:*', 'account:*'], Resource: '*' },
    { Effect: 'Allow', Action: ['account:GetAccountInformation', 'account:GetPrimaryEmail', 'account:ListRegions', 'iam:CreateServiceLinkedRole', 'iam:DeleteServiceLinkedRole', 'iam:ListRoles', 'organizations:DescribeOrganization'], Resource: '*' },
  ]),
  aws('ReadOnlyAccess', 'Provides read-only access to AWS services and resources.', [{ Effect: 'Allow', Action: ['*:Describe*', '*:Get*', '*:List*', '*:BatchGet*', 'cloudtrail:LookupEvents', 'logs:FilterLogEvents'], Resource: '*' }]),
  aws('AWSLambdaBasicExecutionRole', 'Provides write permissions to CloudWatch Logs.', [{ Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' }]),
  aws('AmazonS3FullAccess', 'Provides full access to all buckets via the AWS Management Console.', [{ Effect: 'Allow', Action: ['s3:*', 's3-object-lambda:*'], Resource: '*' }]),
  aws('AmazonS3ReadOnlyAccess', 'Provides read only access to all buckets via the AWS Management Console.', [
    { Effect: 'Allow', Action: ['s3:Get*', 's3:List*', 's3:Describe*', 's3-object-lambda:Get*', 's3-object-lambda:List*'], Resource: '*' },
  ]),
  aws('AmazonEC2ReadOnlyAccess', 'Provides read only access to Amazon EC2 via the AWS Management Console.', [
    { Effect: 'Allow', Action: ['ec2:Describe*', 'elasticloadbalancing:Describe*', 'cloudwatch:ListMetrics', 'cloudwatch:GetMetricStatistics', 'cloudwatch:Describe*', 'autoscaling:Describe*'], Resource: '*' },
  ]),
  aws('IAMReadOnlyAccess', 'Provides read only access to IAM via the AWS Management Console.', [
    { Effect: 'Allow', Action: ['iam:GenerateCredentialReport', 'iam:GenerateServiceLastAccessedDetails', 'iam:Get*', 'iam:List*', 'iam:SimulateCustomPolicy', 'iam:SimulatePrincipalPolicy'], Resource: '*' },
  ]),
  aws('AmazonSSMManagedInstanceCore', 'The policy for Amazon EC2 Role to enable AWS Systems Manager service core functionality.', [
    {
      Effect: 'Allow',
      Action: ['ssm:DescribeAssociation', 'ssm:GetDeployablePatchSnapshotForInstance', 'ssm:GetDocument', 'ssm:DescribeDocument', 'ssm:GetManifest', 'ssm:GetParameter', 'ssm:GetParameters', 'ssm:ListAssociations', 'ssm:ListInstanceAssociations', 'ssm:PutInventory', 'ssm:PutComplianceItems', 'ssm:PutConfigurePackageResult', 'ssm:UpdateAssociationStatus', 'ssm:UpdateInstanceAssociationStatus', 'ssm:UpdateInstanceInformation'],
      Resource: '*',
    },
    { Effect: 'Allow', Action: ['ssmmessages:CreateControlChannel', 'ssmmessages:CreateDataChannel', 'ssmmessages:OpenControlChannel', 'ssmmessages:OpenDataChannel'], Resource: '*' },
    { Effect: 'Allow', Action: ['ec2messages:AcknowledgeMessage', 'ec2messages:DeleteMessage', 'ec2messages:FailMessage', 'ec2messages:GetEndpoint', 'ec2messages:GetMessages', 'ec2messages:SendReply'], Resource: '*' },
  ]),
  aws('CloudWatchAgentServerPolicy', 'Permissions required to use AmazonCloudWatchAgent on servers', [
    { Effect: 'Allow', Action: ['cloudwatch:PutMetricData', 'ec2:DescribeVolumes', 'ec2:DescribeTags', 'logs:PutLogEvents', 'logs:PutRetentionPolicy', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups', 'logs:CreateLogStream', 'logs:CreateLogGroup', 'xray:PutTraceSegments', 'xray:PutTelemetryRecords'], Resource: '*' },
    { Effect: 'Allow', Action: ['ssm:GetParameter'], Resource: 'arn:aws:ssm:*:*:parameter/AmazonCloudWatch-*' },
  ]),
];

/** Trust policy the console generates for "AWS のサービス → EC2". */
export const ec2TrustPolicy = (): PolicyDocument => ({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }] });

export function findPolicy(env: AwsEnv, arn: string): ManagedPolicy | undefined {
  return AWS_MANAGED_POLICIES.find((p) => p.arn === arn) ?? env.iamPolicies.find((p) => p.arn === arn);
}

export const allPolicies = (env: AwsEnv) => [...AWS_MANAGED_POLICIES, ...env.iamPolicies];

export function getRole(env: AwsEnv, name: string): IamRole {
  const r = env.iamRoles.find((x) => x.roleName === name);
  if (!r) throw new AwsError('NoSuchEntity', `The role with name ${name} cannot be found.`);
  return r;
}

export function getUser(env: AwsEnv, name: string): IamUser {
  const u = env.iamUsers.find((x) => x.userName === name);
  if (!u) throw new AwsError('NoSuchEntity', `The user with name ${name} cannot be found.`);
  return u;
}

/** Entities (roles / users) a managed policy is attached to. */
export function policyAttachments(env: AwsEnv, arn: string) {
  return [...env.iamRoles.filter((r) => r.attachedPolicyArns.includes(arn)).map((r) => ({ type: 'ロール', name: r.roleName })), ...env.iamUsers.filter((u) => u.attachedPolicyArns.includes(arn)).map((u) => ({ type: 'ユーザー', name: u.userName }))];
}

// ---------- policy document validation ----------

export type PolicyKind = 'identity' | 'resource' | 'trust';

/** Parse + validate like IAM / S3 do, throwing MalformedPolicyDocument with an AWS-like message. */
export function parsePolicy(text: string, kind: PolicyKind, opts: { bucket?: string } = {}): PolicyDocument {
  const code = kind === 'resource' ? 'MalformedPolicy' : 'MalformedPolicyDocument';
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new AwsError(code, kind === 'resource' ? "Policies must be valid JSON and the first byte must be '{'" : 'Syntax errors in policy.');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new AwsError(code, 'Syntax errors in policy.');
  const d = doc as PolicyDocument;
  if (d.Version !== undefined && d.Version !== '2012-10-17' && d.Version !== '2008-10-17') throw new AwsError(code, 'The policy failed legacy parsing');
  if (!d.Statement) throw new AwsError(code, 'Missing required field Statement');
  for (const st of statements(d)) {
    if (!st || typeof st !== 'object') throw new AwsError(code, 'Syntax errors in policy.');
    if (st.Effect !== 'Allow' && st.Effect !== 'Deny') throw new AwsError(code, `Invalid effect: ${String(st.Effect)}`);
    if (!list(st.Action).length && !list(st.NotAction).length) throw new AwsError(code, 'Policy statement must contain actions.');
    for (const a of [...list(st.Action), ...list(st.NotAction)]) if (a !== '*' && !/^[a-z0-9-]+:[A-Za-z0-9*?]+$/.test(a)) throw new AwsError(code, 'Actions/Conditions must be prefaced by a vendor, e.g., iam, sdb, ec2, etc.');
    if (kind === 'identity' && (st.Principal || st.NotPrincipal)) throw new AwsError(code, 'Policy document should not specify a principal.');
    if (kind !== 'identity' && !st.Principal && !st.NotPrincipal) throw new AwsError(code, 'Missing required field Principal');
    if (kind !== 'trust' && !list(st.Resource).length && !list(st.NotResource).length) throw new AwsError(code, 'Policy statement must contain resources.');
    if (kind === 'resource' && opts.bucket)
      for (const r of [...list(st.Resource), ...list(st.NotResource)])
        if (!matchWildcard(r, `arn:aws:s3:::${opts.bucket}`, false) && !matchWildcard(r, `arn:aws:s3:::${opts.bucket}/x`, false)) throw new AwsError(code, 'Policy has invalid resource');
  }
  return d;
}

// ---------- operations ----------

function checkName(name: string, kind: string) {
  if (!/^[\w+=,.@-]{1,64}$/.test(name)) throw new AwsError('ValidationError', `The specified value for ${kind}Name is invalid. It must contain only alphanumeric characters and/or the following: +=,.@_-`);
}

export function createRole(env: AwsEnv, input: { roleName: string; description?: string; trustPolicy: PolicyDocument; policyArns?: string[]; withInstanceProfile?: boolean }, now = Date.now()): string {
  checkName(input.roleName, 'role');
  if (env.iamRoles.some((r) => r.roleName.toLowerCase() === input.roleName.toLowerCase())) throw new AwsError('EntityAlreadyExists', `Role with name ${input.roleName} already exists.`);
  for (const a of input.policyArns ?? []) if (!findPolicy(env, a)) throw new AwsError('NoSuchEntity', `Policy ${a} does not exist or is not attachable.`);
  const arn = roleArn(env, input.roleName);
  env.iamRoles.push({ roleName: input.roleName, roleId: iamId('AROA'), arn, path: '/', description: input.description ?? '', createDate: new Date(now).toISOString(), maxSessionDuration: 3600, assumeRolePolicyDocument: input.trustPolicy, attachedPolicyArns: [...(input.policyArns ?? [])], inlinePolicies: [], tags: [] });
  // The console creates a same-named instance profile for EC2 roles.
  if (input.withInstanceProfile) env.instanceProfiles.push({ instanceProfileName: input.roleName, instanceProfileId: iamId('AIPA'), arn: instanceProfileArn(env, input.roleName), roleNames: [input.roleName] });
  const res: [string, string][] = [['AWS::IAM::Role', arn]];
  trail(env, { source: 'iam', name: 'CreateRole', resources: res, request: { roleName: input.roleName, description: input.description, assumeRolePolicyDocument: JSON.stringify(input.trustPolicy) }, response: { role: { roleName: input.roleName, arn, path: '/' } } });
  for (const p of input.policyArns ?? []) trail(env, { source: 'iam', name: 'AttachRolePolicy', resources: [...res, ['AWS::IAM::Policy', p]], request: { roleName: input.roleName, policyArn: p }, response: null });
  if (input.withInstanceProfile) {
    trail(env, { source: 'iam', name: 'CreateInstanceProfile', resources: [['AWS::IAM::InstanceProfile', instanceProfileArn(env, input.roleName)]], request: { instanceProfileName: input.roleName }, response: { instanceProfile: { instanceProfileName: input.roleName, arn: instanceProfileArn(env, input.roleName) } } });
    trail(env, { source: 'iam', name: 'AddRoleToInstanceProfile', resources: res, request: { instanceProfileName: input.roleName, roleName: input.roleName }, response: null });
  }
  return arn;
}

export function createUser(env: AwsEnv, input: { userName: string; policyArns?: string[]; consoleAccess?: boolean }, now = Date.now()): string {
  checkName(input.userName, 'user');
  if (env.iamUsers.some((u) => u.userName.toLowerCase() === input.userName.toLowerCase())) throw new AwsError('EntityAlreadyExists', `User with name ${input.userName} already exists.`);
  const arn = userArn(env, input.userName);
  env.iamUsers.push({ userName: input.userName, userId: iamId('AIDA'), arn, path: '/', createDate: new Date(now).toISOString(), consoleAccess: !!input.consoleAccess, attachedPolicyArns: [...(input.policyArns ?? [])], inlinePolicies: [], tags: [] });
  trail(env, { source: 'iam', name: 'CreateUser', resources: [['AWS::IAM::User', arn]], request: { userName: input.userName }, response: { user: { userName: input.userName, arn, path: '/' } } });
  for (const p of input.policyArns ?? []) trail(env, { source: 'iam', name: 'AttachUserPolicy', resources: [['AWS::IAM::User', arn], ['AWS::IAM::Policy', p]], request: { userName: input.userName, policyArn: p }, response: null });
  return arn;
}

export function createPolicy(env: AwsEnv, input: { policyName: string; description?: string; document: PolicyDocument }, now = Date.now()): string {
  checkName(input.policyName, 'policy');
  if (env.iamPolicies.some((p) => p.policyName === input.policyName)) throw new AwsError('EntityAlreadyExists', `A policy called ${input.policyName} already exists. Duplicate names are not allowed.`);
  const arn = policyArn(env, input.policyName);
  const at = new Date(now).toISOString();
  env.iamPolicies.push({ policyName: input.policyName, policyId: iamId('ANPA'), arn, path: '/', awsManaged: false, description: input.description ?? '', document: input.document, createDate: at, updateDate: at });
  trail(env, { source: 'iam', name: 'CreatePolicy', resources: [['AWS::IAM::Policy', arn]], request: { policyName: input.policyName, policyDocument: JSON.stringify(input.document), description: input.description }, response: { policy: { policyName: input.policyName, arn, defaultVersionId: 'v1' } } });
  return arn;
}

export function updatePolicyDocument(env: AwsEnv, arn: string, document: PolicyDocument, now = Date.now()) {
  const p = env.iamPolicies.find((x) => x.arn === arn);
  if (!p) throw new AwsError('NoSuchEntity', `Policy ${arn} was not found.`);
  p.document = document;
  p.updateDate = new Date(now).toISOString();
  trail(env, { source: 'iam', name: 'CreatePolicyVersion', resources: [['AWS::IAM::Policy', arn]], request: { policyArn: arn, policyDocument: JSON.stringify(document), setAsDefault: true }, response: { policyVersion: { isDefaultVersion: true } } });
}

type Principalish = { attachedPolicyArns: string[]; inlinePolicies: InlinePolicy[] };

/** AttachRolePolicy / PutUserPolicy / ... */
function entityEvent(env: AwsEnv, type: 'role' | 'user', name: string, verb: string, noun: string, request: Record<string, string>, policyArn?: string) {
  const res: [string, string][] = [[type === 'role' ? 'AWS::IAM::Role' : 'AWS::IAM::User', type === 'role' ? roleArn(env, name) : userArn(env, name)], ...(policyArn ? [['AWS::IAM::Policy', policyArn] as [string, string]] : [])];
  trail(env, { source: 'iam', name: `${verb}${type === 'role' ? 'Role' : 'User'}${noun}`, resources: res, request: { [type === 'role' ? 'roleName' : 'userName']: name, ...request }, response: null });
}

function entity(env: AwsEnv, type: 'role' | 'user', name: string): Principalish {
  return type === 'role' ? getRole(env, name) : getUser(env, name);
}

export function attachPolicy(env: AwsEnv, type: 'role' | 'user', name: string, arn: string) {
  const e = entity(env, type, name);
  if (!findPolicy(env, arn)) throw new AwsError('NoSuchEntity', `Policy ${arn} does not exist or is not attachable.`);
  if (e.attachedPolicyArns.length >= 10 && !e.attachedPolicyArns.includes(arn)) throw new AwsError('LimitExceeded', `Cannot exceed quota for PoliciesPerRole: 10`);
  if (!e.attachedPolicyArns.includes(arn)) e.attachedPolicyArns.push(arn);
  entityEvent(env, type, name, 'Attach', 'Policy', { policyArn: arn }, arn);
}

export function detachPolicy(env: AwsEnv, type: 'role' | 'user', name: string, arn: string) {
  const e = entity(env, type, name);
  if (!e.attachedPolicyArns.includes(arn)) throw new AwsError('NoSuchEntity', `Policy ${arn} was not found.`);
  e.attachedPolicyArns = e.attachedPolicyArns.filter((a) => a !== arn);
  entityEvent(env, type, name, 'Detach', 'Policy', { policyArn: arn }, arn);
}

export function putInlinePolicy(env: AwsEnv, type: 'role' | 'user', name: string, policyName: string, document: PolicyDocument) {
  checkName(policyName, 'policy');
  const e = entity(env, type, name);
  e.inlinePolicies = [...e.inlinePolicies.filter((p) => p.policyName !== policyName), { policyName, document }];
  entityEvent(env, type, name, 'Put', 'Policy', { policyName, policyDocument: JSON.stringify(document) });
}

export function deleteInlinePolicy(env: AwsEnv, type: 'role' | 'user', name: string, policyName: string) {
  const e = entity(env, type, name);
  e.inlinePolicies = e.inlinePolicies.filter((p) => p.policyName !== policyName);
  entityEvent(env, type, name, 'Delete', 'Policy', { policyName });
}

export function updateAssumeRolePolicy(env: AwsEnv, roleName: string, document: PolicyDocument) {
  getRole(env, roleName).assumeRolePolicyDocument = document;
  trail(env, { source: 'iam', name: 'UpdateAssumeRolePolicy', resources: [['AWS::IAM::Role', roleArn(env, roleName)]], request: { roleName, policyDocument: JSON.stringify(document) }, response: null });
}

/** EC2 "IAM ロールを変更": attach / replace / remove the instance profile. */
export function setInstanceProfile(env: AwsEnv, instanceId: string, profileArn: string | undefined) {
  const i = getInstance(env, instanceId);
  if (profileArn && !env.instanceProfiles.some((p) => p.arn === profileArn)) throw new AwsError('InvalidParameterValue', `Value (${profileArn}) for parameter iamInstanceProfile.arn is invalid. Invalid IAM Instance Profile ARN`);
  const before = i.iamInstanceProfileArn;
  i.iamInstanceProfileArn = profileArn;
  const name = !before ? 'AssociateIamInstanceProfile' : profileArn ? 'ReplaceIamInstanceProfileAssociation' : 'DisassociateIamInstanceProfile';
  trail(env, { source: 'ec2', name, resources: [['AWS::EC2::Instance', instanceId]], request: { instanceId, ...(profileArn ? { iamInstanceProfile: { arn: profileArn } } : {}) } });
}

// ---------- evaluation ----------

/** IAM wildcard match: `*` any sequence, `?` one char. Actions are case-insensitive, ARNs are not. */
export function matchWildcard(pattern: string, value: string, ignoreCase: boolean): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', ignoreCase ? 'i' : '');
  return re.test(value);
}

export type RequestPrincipal =
  | { type: 'role'; roleName: string; sessionName: string }
  | { type: 'user'; userName: string }
  | { type: 'anonymous' }
  | { type: 'service'; service: string };

export interface IamRequest {
  principal: RequestPrincipal;
  action: string;
  resource: string;
  /** resource-based policy of the target (e.g. the bucket policy) */
  resourcePolicy?: PolicyDocument;
  /** condition keys: aws:SecureTransport, aws:SourceIp, s3:prefix … */
  context?: Record<string, string | boolean>;
}

export interface StatementResult {
  source: string;
  kind: 'identity' | 'resource';
  sid?: string;
  effect: 'Allow' | 'Deny';
  applies: boolean;
  /** why it did not apply: Action / Resource / Principal / Condition */
  mismatch?: string;
  /** Principal is only the account (delegates to IAM, does not grant by itself) */
  accountOnly?: boolean;
}

export interface IamDecision {
  decision: 'Allow' | 'ExplicitDeny' | 'ImplicitDeny';
  /** the AWS AccessDenied reason fragment */
  reason: string;
  principalArn: string;
  statements: StatementResult[];
}

export function principalArn(env: AwsEnv, p: RequestPrincipal): string {
  if (p.type === 'role') return sessionArn(env, p.roleName, p.sessionName);
  if (p.type === 'user') return userArn(env, p.userName);
  if (p.type === 'service') return p.service;
  return 'anonymous';
}

function identityPolicies(env: AwsEnv, p: RequestPrincipal): { source: string; doc: PolicyDocument }[] {
  const e = p.type === 'role' ? env.iamRoles.find((r) => r.roleName === p.roleName) : p.type === 'user' ? env.iamUsers.find((u) => u.userName === p.userName) : undefined;
  if (!e) return [];
  return [
    ...e.attachedPolicyArns.flatMap((arn) => {
      const pol = findPolicy(env, arn);
      return pol ? [{ source: `${pol.policyName} (${pol.awsManaged ? 'AWS 管理' : 'カスタマー管理'})`, doc: pol.document }] : [];
    }),
    ...e.inlinePolicies.map((ip) => ({ source: `${ip.policyName} (インライン)`, doc: ip.document })),
  ];
}

function conditionHolds(cond: PolicyStatement['Condition'], ctx: Record<string, string | boolean>): boolean {
  if (!cond) return true;
  return Object.entries(cond).every(([op, kv]) =>
    Object.entries(kv).every(([key, raw]) => {
      const expected = list(typeof raw === 'boolean' ? String(raw) : (raw as StringOrList)).map(String);
      const actualRaw = Object.entries(ctx).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
      if (op === 'Null') return expected.includes(String(actualRaw === undefined));
      if (actualRaw === undefined) return op.startsWith('StringNot') || op.startsWith('ArnNot') || op === 'NotIpAddress' ? true : false;
      const actual = String(actualRaw);
      switch (op) {
        case 'StringEquals':
        case 'ArnEquals':
          return expected.includes(actual);
        case 'StringNotEquals':
        case 'ArnNotEquals':
          return !expected.includes(actual);
        case 'StringEqualsIgnoreCase':
          return expected.some((e) => e.toLowerCase() === actual.toLowerCase());
        case 'StringLike':
        case 'ArnLike':
          return expected.some((e) => matchWildcard(e, actual, false));
        case 'StringNotLike':
        case 'ArnNotLike':
          return !expected.some((e) => matchWildcard(e, actual, false));
        case 'Bool':
          return expected.includes(actual.toLowerCase());
        case 'IpAddress':
          return expected.some((c) => isValidCidr(c.includes('/') ? c : `${c}/32`) && ipInCidr(actual, c.includes('/') ? c : `${c}/32`));
        case 'NotIpAddress':
          return !expected.some((c) => isValidCidr(c.includes('/') ? c : `${c}/32`) && ipInCidr(actual, c.includes('/') ? c : `${c}/32`));
        default:
          // ponytail: unsupported condition operators never match; add them when a lesson needs one.
          return false;
      }
    }),
  );
}

type PrincipalMatch = 'yes' | 'account' | 'no';

function principalMatches(env: AwsEnv, spec: PolicyStatement['Principal'], p: RequestPrincipal): PrincipalMatch {
  if (spec === undefined) return 'no';
  if (spec === '*') return 'yes';
  const awsList = list(spec.AWS);
  if (awsList.includes('*')) return 'yes';
  if (p.type === 'service') return list(spec.Service).includes(p.service) ? 'yes' : 'no';
  if (p.type === 'anonymous') return 'no';
  const own = p.type === 'role' ? roleArn(env, p.roleName) : userArn(env, p.userName);
  if (awsList.includes(own) || awsList.includes(principalArn(env, p))) return 'yes';
  if (awsList.includes(`arn:aws:iam::${env.accountId}:root`) || awsList.includes(env.accountId)) return 'account';
  return 'no';
}

export function evalStatement(env: AwsEnv, st: PolicyStatement, req: IamRequest, kind: 'identity' | 'resource', source: string): StatementResult {
  const base = { source, kind, sid: st.Sid, effect: st.Effect } as const;
  const actionOk = st.Action ? list(st.Action).some((a) => matchWildcard(a, req.action, true)) : !list(st.NotAction).some((a) => matchWildcard(a, req.action, true));
  if (!actionOk) return { ...base, applies: false, mismatch: 'Action' };
  const resourceOk = st.Resource ? list(st.Resource).some((r) => matchWildcard(r, req.resource, false)) : st.NotResource ? !list(st.NotResource).some((r) => matchWildcard(r, req.resource, false)) : kind === 'resource';
  if (!resourceOk) return { ...base, applies: false, mismatch: 'Resource' };
  let accountOnly = false;
  if (kind === 'resource') {
    const m = st.Principal !== undefined ? principalMatches(env, st.Principal, req.principal) : principalMatches(env, st.NotPrincipal, req.principal) === 'no' ? 'yes' : 'no';
    if (m === 'no') return { ...base, applies: false, mismatch: 'Principal' };
    accountOnly = m === 'account';
  }
  const ctx = { ...req.context, 'aws:PrincipalArn': req.principal.type === 'role' ? roleArn(env, req.principal.roleName) : principalArn(env, req.principal), 'aws:PrincipalAccount': env.accountId };
  if (!conditionHolds(st.Condition, ctx)) return { ...base, applies: false, mismatch: 'Condition' };
  return { ...base, applies: true, accountOnly };
}

/**
 * Same-account policy evaluation (AWS "policy evaluation logic"):
 *   1. an explicit Deny in any applicable policy → deny
 *   2. an Allow in the resource-based policy that names the principal (or "*") → allow
 *   3. an Allow in an identity-based policy → allow
 *   4. otherwise implicit deny
 * A resource policy that only names the account (…:root) delegates to IAM and does not allow by itself.
 * ponytail: SCPs, permission boundaries and session policies are not evaluated here yet.
 */
export function evaluateIamPermission(env: AwsEnv, req: IamRequest, identity = identityPolicies(env, req.principal)): IamDecision {
  const results: StatementResult[] = [
    ...identity.flatMap(({ source, doc }) => statements(doc).map((st) => evalStatement(env, st, req, 'identity', source))),
    ...(req.resourcePolicy ? statements(req.resourcePolicy).map((st) => evalStatement(env, st, req, 'resource', 'リソースベースポリシー')) : []),
  ];
  const principal = principalArn(env, req.principal);
  const denyIdentity = results.find((r) => r.applies && r.effect === 'Deny' && r.kind === 'identity');
  const denyResource = results.find((r) => r.applies && r.effect === 'Deny' && r.kind === 'resource');
  if (denyIdentity || denyResource) return { decision: 'ExplicitDeny', reason: `with an explicit deny in ${denyIdentity ? 'an identity-based' : 'a resource-based'} policy`, principalArn: principal, statements: results };
  const allowResource = results.some((r) => r.applies && r.effect === 'Allow' && r.kind === 'resource' && !r.accountOnly);
  const allowIdentity = results.some((r) => r.applies && r.effect === 'Allow' && r.kind === 'identity');
  if (allowResource || allowIdentity) return { decision: 'Allow', reason: '', principalArn: principal, statements: results };
  return {
    decision: 'ImplicitDeny',
    reason: req.principal.type === 'anonymous' ? 'because no resource-based policy allows the ' + req.action + ' action' : `because no identity-based policy allows the ${req.action} action`,
    principalArn: principal,
    statements: results,
  };
}

/** Is `service` (e.g. ec2.amazonaws.com) allowed to assume the role by its trust policy? */
export function trustAllows(env: AwsEnv, role: IamRole, service: string): boolean {
  return statements(role.assumeRolePolicyDocument).some(
    (st) => st.Effect === 'Allow' && list(st.Action).some((a) => matchWildcard(a, 'sts:AssumeRole', true)) && principalMatches(env, st.Principal, { type: 'service', service }) === 'yes',
  );
}

/** The role an instance's credentials come from, or why there are none (what IMDS / the CLI would report). */
export function instanceRole(env: AwsEnv, instanceId: string): { role?: IamRole; problem?: 'no-profile' | 'no-role' | 'trust' } {
  const i = getInstance(env, instanceId);
  if (!i.iamInstanceProfileArn) return { problem: 'no-profile' };
  const profile = env.instanceProfiles.find((p) => p.arn === i.iamInstanceProfileArn);
  const role = profile && env.iamRoles.find((r) => profile.roleNames.includes(r.roleName));
  if (!role) return { problem: 'no-role' };
  if (!trustAllows(env, role, 'ec2.amazonaws.com')) return { role, problem: 'trust' };
  return { role };
}

/** The message S3 / IAM put in an AccessDenied error (the CLI prefixes "An error occurred (AccessDenied) when calling …"). */
export function accessDeniedMessage(action: string, resource: string, d: IamDecision): string {
  if (d.principalArn === 'anonymous') return 'Access Denied';
  return `User: ${d.principalArn} is not authorized to perform: ${action} on resource: "${resource}" ${d.reason}`;
}
