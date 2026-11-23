/* aws iam — ロール・ユーザー・ポリシー・インスタンスプロファイル。IAM はリージョンに関係ない (scope: global)。
   変更はコンソールと同じ sim/iam.ts の関数で行う。ポリシーの文書は --xxx-document file://policy.json か JSON の文字列 */
import { trail } from '../../../sim/cloudtrail';
import { allPolicies, attachPolicy, createPolicy, createRole, createUser, deleteInlinePolicy, detachPolicy, evaluateIamPermission, findPolicy, getRole, getUser, iamId, instanceProfileArn, parsePolicy, policyAttachments, putInlinePolicy, updateAssumeRolePolicy, updatePolicyDocument, type RequestPrincipal } from '../../../sim/iam';
import type { AwsEnv, IamRole, IamUser, InstanceProfile, ManagedPolicy } from '../../../sim/types';
import { AwsError, bool, iso, req, service, str, strs, tagsOut, type OpContext, type OperationSpec } from '../types';

const roleOut = (r: IamRole) => ({
  Path: r.path,
  RoleName: r.roleName,
  RoleId: r.roleId,
  Arn: r.arn,
  CreateDate: iso(r.createDate),
  AssumeRolePolicyDocument: r.assumeRolePolicyDocument,
  ...(r.description ? { Description: r.description } : {}),
  MaxSessionDuration: r.maxSessionDuration,
});
const userOut = (u: IamUser) => ({ Path: u.path, UserName: u.userName, UserId: u.userId, Arn: u.arn, CreateDate: iso(u.createDate) });

/** シミュレーターは古いバージョンの文書を残さない。今のバージョンの番号は、CloudTrail に残った CreatePolicyVersion の数から数える */
export const versionOf = (env: AwsEnv, p: ManagedPolicy) => (p.awsManaged ? 'v1' : `v${1 + env.trailEvents.filter((e) => e.eventName === 'CreatePolicyVersion' && e.resources.some(([, n]) => n === p.arn)).length}`);
const policyOut = (env: AwsEnv, p: ManagedPolicy) => ({
  PolicyName: p.policyName,
  PolicyId: p.policyId,
  Arn: p.arn,
  Path: p.path,
  DefaultVersionId: versionOf(env, p),
  AttachmentCount: policyAttachments(env, p.arn).length,
  PermissionsBoundaryUsageCount: 0,
  IsAttachable: true,
  CreateDate: iso(p.createDate),
  UpdateDate: iso(p.updateDate),
});
function policyOf(ctx: OpContext): ManagedPolicy {
  const arn = req(ctx, 'policy-arn');
  const p = findPolicy(ctx.env, arn);
  if (!p) throw new AwsError('NoSuchEntity', `Policy ${arn} was not found.`);
  return p;
}

function profileOut(env: AwsEnv, p: InstanceProfile) {
  const roles = p.roleNames.map((n) => env.iamRoles.find((r) => r.roleName === n)).filter((r): r is IamRole => !!r);
  return { Path: '/', InstanceProfileName: p.instanceProfileName, InstanceProfileId: p.instanceProfileId, Arn: p.arn, CreateDate: iso(roles[0]?.createDate ?? 0), Roles: roles.map(roleOut) };
}
function profileOf(ctx: OpContext): InstanceProfile {
  const name = req(ctx, 'instance-profile-name');
  const p = ctx.env.instanceProfiles.find((x) => x.instanceProfileName === name);
  if (!p) throw new AwsError('NoSuchEntity', `Instance Profile ${name} cannot be found.`);
  return p;
}

const document = (ctx: OpContext, name: string, kind: 'identity' | 'trust') => parsePolicy(req(ctx, name), kind);

/* ---- ロールとユーザーで同じ形のもの (アタッチ / インライン) ---- */
type Kind = 'role' | 'user';
const Noun = { role: 'Role', user: 'User' } as const;
const entity = (ctx: OpContext, kind: Kind) => (kind === 'role' ? getRole(ctx.env, req(ctx, 'role-name')) : getUser(ctx.env, req(ctx, 'user-name')));
const nameParam = (kind: Kind) => ({ name: `${kind}-name`, type: 'string' as const, required: true, desc: kind === 'role' ? 'ロール名' : 'ユーザー名' });
const label = { role: 'ロール', user: 'ユーザー' };

function entityOps(kind: Kind): OperationSpec[] {
  const n = Noun[kind];
  const p = nameParam(kind);
  const policyArn = { name: 'policy-arn', type: 'string' as const, required: true, desc: 'ポリシーの ARN' };
  const policyName = { name: 'policy-name', type: 'string' as const, required: true, desc: 'インラインポリシーの名前' };
  return [
    {
      name: `list-attached-${kind}-policies`,
      desc: `${label[kind]}にアタッチされた管理ポリシーの一覧`,
      params: [p],
      readOnly: true,
      scope: 'global',
      run: (ctx) => ({ AttachedPolicies: entity(ctx, kind).attachedPolicyArns.map((a) => ({ PolicyName: findPolicy(ctx.env, a)?.policyName ?? a.split('/').pop(), PolicyArn: a })) }),
    },
    {
      name: `attach-${kind}-policy`,
      desc: `${label[kind]}に管理ポリシーをアタッチする`,
      params: [p, policyArn],
      scope: 'global',
      run(ctx) {
        attachPolicy(ctx.env, kind, req(ctx, p.name), req(ctx, 'policy-arn'));
        return undefined;
      },
    },
    {
      name: `detach-${kind}-policy`,
      desc: `${label[kind]}から管理ポリシーを外す`,
      params: [p, policyArn],
      scope: 'global',
      run(ctx) {
        detachPolicy(ctx.env, kind, req(ctx, p.name), req(ctx, 'policy-arn'));
        return undefined;
      },
    },
    {
      name: `list-${kind}-policies`,
      desc: `${label[kind]}のインラインポリシーの名前の一覧`,
      params: [p],
      readOnly: true,
      scope: 'global',
      run: (ctx) => ({ PolicyNames: entity(ctx, kind).inlinePolicies.map((x) => x.policyName) }),
    },
    {
      name: `get-${kind}-policy`,
      desc: `${label[kind]}のインラインポリシーの文書`,
      params: [p, policyName],
      readOnly: true,
      scope: 'global',
      run(ctx) {
        const e = entity(ctx, kind);
        const ip = e.inlinePolicies.find((x) => x.policyName === req(ctx, 'policy-name'));
        if (!ip) throw new AwsError('NoSuchEntity', `The ${kind} policy with name ${req(ctx, 'policy-name')} cannot be found.`);
        return { [`${n}Name`]: req(ctx, p.name), PolicyName: ip.policyName, PolicyDocument: ip.document };
      },
    },
    {
      name: `put-${kind}-policy`,
      desc: `${label[kind]}にインラインポリシーを書く (同じ名前なら置き換え)`,
      params: [p, policyName, { name: 'policy-document', type: 'string', required: true, desc: 'ポリシーの JSON (file://policy.json)' }],
      scope: 'global',
      run(ctx) {
        putInlinePolicy(ctx.env, kind, req(ctx, p.name), req(ctx, 'policy-name'), document(ctx, 'policy-document', 'identity'));
        return undefined;
      },
    },
    {
      name: `delete-${kind}-policy`,
      desc: `${label[kind]}のインラインポリシーを削除する`,
      params: [p, policyName],
      scope: 'global',
      run(ctx) {
        const e = entity(ctx, kind);
        if (!e.inlinePolicies.some((x) => x.policyName === req(ctx, 'policy-name'))) throw new AwsError('NoSuchEntity', `The ${kind} policy with name ${req(ctx, 'policy-name')} cannot be found.`);
        deleteInlinePolicy(ctx.env, kind, req(ctx, p.name), req(ctx, 'policy-name'));
        return undefined;
      },
    },
  ];
}

/* ---- simulate-principal-policy (ポリシーシミュレーター) ---- */
function principalOf(env: AwsEnv, arn: string): RequestPrincipal {
  const m = /^arn:aws:iam::\d{12}:(role|user)\/(?:.*\/)?([^/]+)$/.exec(arn);
  if (!m) throw new AwsError('InvalidInput', `Invalid ARN: ${arn}`);
  if (m[1] === 'role') return { type: 'role', roleName: getRole(env, m[2]).roleName, sessionName: 'simulation' };
  return { type: 'user', userName: getUser(env, m[2]).userName };
}

const ops: OperationSpec[] = [
  /* ---- ロール ---- */
  {
    name: 'list-roles',
    desc: 'ロールの一覧',
    params: [{ name: 'path-prefix', type: 'string', desc: 'パスの頭で絞る' }],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ Roles: ctx.env.iamRoles.filter((r) => r.path.startsWith(str(ctx, 'path-prefix') ?? '/')).map(roleOut) }),
  },
  {
    name: 'get-role',
    desc: 'ロールの詳細 (AssumeRolePolicyDocument が信頼ポリシー)',
    params: [nameParam('role')],
    readOnly: true,
    scope: 'global',
    examples: ['aws iam get-role --role-name batch-role', "aws iam get-role --role-name batch-role --query 'Role.AssumeRolePolicyDocument'"],
    run(ctx) {
      const r = getRole(ctx.env, req(ctx, 'role-name'));
      return { Role: { ...roleOut(r), ...(r.tags.length ? { Tags: tagsOut(r.tags) } : {}), RoleLastUsed: {} } };
    },
  },
  {
    name: 'create-role',
    desc: 'ロールを作る (--assume-role-policy-document が信頼ポリシー)',
    params: [nameParam('role'), { name: 'assume-role-policy-document', type: 'string', required: true, desc: '信頼ポリシーの JSON (file://trust.json)' }, { name: 'description', type: 'string', desc: '説明' }],
    scope: 'global',
    examples: ['aws iam create-role --role-name my-role --assume-role-policy-document file://trust.json'],
    run(ctx) {
      createRole(ctx.env, { roleName: req(ctx, 'role-name'), description: str(ctx, 'description'), trustPolicy: document(ctx, 'assume-role-policy-document', 'trust') }, ctx.now);
      return { Role: roleOut(getRole(ctx.env, req(ctx, 'role-name'))) };
    },
  },
  {
    name: 'delete-role',
    desc: 'ロールを削除する (ポリシーとインスタンスプロファイルを外してから)',
    params: [nameParam('role')],
    scope: 'global',
    run(ctx) {
      const r = getRole(ctx.env, req(ctx, 'role-name'));
      if (r.attachedPolicyArns.length || r.inlinePolicies.length) throw new AwsError('DeleteConflict', 'Cannot delete entity, must detach all policies first.');
      if (ctx.env.instanceProfiles.some((p) => p.roleNames.includes(r.roleName))) throw new AwsError('DeleteConflict', 'Cannot delete entity, must remove roles from instance profile first.');
      ctx.env.iamRoles = ctx.env.iamRoles.filter((x) => x !== r);
      trail(ctx.env, { source: 'iam', name: 'DeleteRole', resources: [['AWS::IAM::Role', r.arn]], request: { roleName: r.roleName }, response: null });
      return undefined;
    },
  },
  {
    name: 'update-assume-role-policy',
    desc: 'ロールの信頼ポリシー (誰が引き受けられるか) を置き換える',
    params: [nameParam('role'), { name: 'policy-document', type: 'string', required: true, desc: '信頼ポリシーの JSON (file://trust.json)' }],
    scope: 'global',
    run(ctx) {
      updateAssumeRolePolicy(ctx.env, getRole(ctx.env, req(ctx, 'role-name')).roleName, document(ctx, 'policy-document', 'trust'));
      return undefined;
    },
  },
  ...entityOps('role'),

  /* ---- ユーザー ---- */
  {
    name: 'list-users',
    desc: 'IAM ユーザーの一覧',
    params: [],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ Users: ctx.env.iamUsers.map(userOut) }),
  },
  {
    name: 'get-user',
    desc: 'IAM ユーザーの詳細 (省略するとこの CLI のユーザー)',
    params: [{ name: 'user-name', type: 'string', desc: 'ユーザー名 (省略すると learner)' }],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ User: userOut(getUser(ctx.env, str(ctx, 'user-name') ?? 'learner')) }),
  },
  {
    name: 'create-user',
    desc: 'IAM ユーザーを作る',
    params: [nameParam('user')],
    scope: 'global',
    run(ctx) {
      createUser(ctx.env, { userName: req(ctx, 'user-name') }, ctx.now);
      return { User: userOut(getUser(ctx.env, req(ctx, 'user-name'))) };
    },
  },
  ...entityOps('user'),

  /* ---- 管理ポリシー ---- */
  {
    name: 'list-policies',
    desc: '管理ポリシーの一覧 (--scope Local で自分のアカウントで作ったものだけ)',
    params: [
      { name: 'scope', type: 'string', desc: 'All (既定) / AWS / Local' },
      { name: 'only-attached', type: 'boolean', desc: 'どこかにアタッチされているものだけ' },
    ],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const scope = str(ctx, 'scope') ?? 'All';
      return {
        Policies: allPolicies(ctx.env)
          .filter((p) => scope === 'All' || (scope === 'AWS') === p.awsManaged)
          .filter((p) => !bool(ctx, 'only-attached') || policyAttachments(ctx.env, p.arn).length > 0)
          .map((p) => policyOut(ctx.env, p)),
      };
    },
  },
  {
    name: 'get-policy',
    desc: '管理ポリシーの情報 (DefaultVersionId が使われているバージョン。中身は get-policy-version で見る)',
    params: [{ name: 'policy-arn', type: 'string', required: true, desc: 'ポリシーの ARN' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const p = policyOf(ctx);
      return { Policy: { ...policyOut(ctx.env, p), ...(p.description ? { Description: p.description } : {}), Tags: [] } };
    },
  },
  {
    name: 'get-policy-version',
    desc: '管理ポリシーの、あるバージョンの文書 (Document)',
    params: [
      { name: 'policy-arn', type: 'string', required: true, desc: 'ポリシーの ARN' },
      { name: 'version-id', type: 'string', required: true, desc: 'バージョン (get-policy の DefaultVersionId。例: v1)' },
    ],
    readOnly: true,
    scope: 'global',
    examples: ['aws iam get-policy-version --policy-arn arn:aws:iam::123456789012:policy/my-policy --version-id v1'],
    run(ctx) {
      const p = policyOf(ctx);
      const v = req(ctx, 'version-id');
      // ponytail: 古いバージョンの文書は残していない (今のバージョンだけ見られる)。履歴が要るレッスンが来たら sim に持たせる
      if (v !== versionOf(ctx.env, p)) throw new AwsError('NoSuchEntity', `Policy ${p.arn} version ${v} does not exist or is not attachable.`);
      return { PolicyVersion: { Document: p.document, VersionId: v, IsDefaultVersion: true, CreateDate: iso(p.updateDate) } };
    },
  },
  {
    name: 'list-policy-versions',
    desc: '管理ポリシーのバージョンの一覧',
    params: [{ name: 'policy-arn', type: 'string', required: true, desc: 'ポリシーの ARN' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const p = policyOf(ctx);
      return { Versions: [{ VersionId: versionOf(ctx.env, p), IsDefaultVersion: true, CreateDate: iso(p.updateDate) }] };
    },
  },
  {
    name: 'create-policy',
    desc: '管理ポリシーを作る',
    params: [
      { name: 'policy-name', type: 'string', required: true, desc: 'ポリシー名' },
      { name: 'policy-document', type: 'string', required: true, desc: 'ポリシーの JSON (file://policy.json)' },
      { name: 'description', type: 'string', desc: '説明' },
    ],
    scope: 'global',
    run(ctx) {
      const arn = createPolicy(ctx.env, { policyName: req(ctx, 'policy-name'), description: str(ctx, 'description'), document: document(ctx, 'policy-document', 'identity') }, ctx.now);
      return { Policy: policyOut(ctx.env, findPolicy(ctx.env, arn)!) };
    },
  },
  {
    name: 'create-policy-version',
    desc: '管理ポリシーの新しいバージョンを作る (--set-as-default で使うバージョンにする = 中身の書き換え)',
    params: [
      { name: 'policy-arn', type: 'string', required: true, desc: 'ポリシーの ARN' },
      { name: 'policy-document', type: 'string', required: true, desc: 'ポリシーの JSON (file://policy.json)' },
      { name: 'set-as-default', type: 'boolean', desc: '新しいバージョンを既定のバージョン (使われるもの) にする' },
    ],
    scope: 'global',
    examples: ['aws iam create-policy-version --policy-arn arn:aws:iam::123456789012:policy/my-policy --policy-document file://policy.json --set-as-default'],
    run(ctx) {
      const p = policyOf(ctx);
      const doc = document(ctx, 'policy-document', 'identity');
      const next = `v${Number(versionOf(ctx.env, p).slice(1)) + 1}`;
      // ponytail: --set-as-default なしのバージョンは保存しない (既定のバージョンは変わらない)。set-default-policy-version が要るなら sim に履歴を持たせる
      if (bool(ctx, 'set-as-default')) updatePolicyDocument(ctx.env, p.arn, doc, ctx.now);
      return { PolicyVersion: { VersionId: next, IsDefaultVersion: !!bool(ctx, 'set-as-default'), CreateDate: iso(ctx.now) } };
    },
  },

  /* ---- インスタンスプロファイル (EC2 にロールを渡す入れ物) ---- */
  {
    name: 'list-instance-profiles',
    desc: 'インスタンスプロファイルの一覧',
    params: [],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ InstanceProfiles: ctx.env.instanceProfiles.map((p) => profileOut(ctx.env, p)) }),
  },
  {
    name: 'list-instance-profiles-for-role',
    desc: 'ロールが入っているインスタンスプロファイル',
    params: [nameParam('role')],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const r = getRole(ctx.env, req(ctx, 'role-name'));
      return { InstanceProfiles: ctx.env.instanceProfiles.filter((p) => p.roleNames.includes(r.roleName)).map((p) => profileOut(ctx.env, p)) };
    },
  },
  {
    name: 'get-instance-profile',
    desc: 'インスタンスプロファイルの詳細 (中のロール)',
    params: [{ name: 'instance-profile-name', type: 'string', required: true, desc: 'インスタンスプロファイル名' }],
    readOnly: true,
    scope: 'global',
    run: (ctx) => ({ InstanceProfile: profileOut(ctx.env, profileOf(ctx)) }),
  },
  {
    name: 'create-instance-profile',
    desc: 'インスタンスプロファイル (空の入れ物) を作る',
    params: [{ name: 'instance-profile-name', type: 'string', required: true, desc: 'インスタンスプロファイル名' }],
    scope: 'global',
    run(ctx) {
      const name = req(ctx, 'instance-profile-name');
      if (ctx.env.instanceProfiles.some((p) => p.instanceProfileName === name)) throw new AwsError('EntityAlreadyExists', `Instance Profile ${name} already exists.`);
      const p: InstanceProfile = { instanceProfileName: name, instanceProfileId: iamId('AIPA'), arn: instanceProfileArn(ctx.env, name), roleNames: [] };
      ctx.env.instanceProfiles.push(p);
      trail(ctx.env, { source: 'iam', name: 'CreateInstanceProfile', resources: [['AWS::IAM::InstanceProfile', p.arn]], request: { instanceProfileName: name }, response: { instanceProfile: { instanceProfileName: name, arn: p.arn } } });
      return { InstanceProfile: { ...profileOut(ctx.env, p), CreateDate: iso(ctx.now) } };
    },
  },
  {
    name: 'add-role-to-instance-profile',
    desc: 'インスタンスプロファイルにロールを入れる (1 つまで)',
    params: [{ name: 'instance-profile-name', type: 'string', required: true, desc: 'インスタンスプロファイル名' }, nameParam('role')],
    scope: 'global',
    run(ctx) {
      const p = profileOf(ctx);
      const r = getRole(ctx.env, req(ctx, 'role-name'));
      if (p.roleNames.length) throw new AwsError('LimitExceeded', 'Cannot exceed quota for InstanceSessionsPerInstanceProfile: 1');
      p.roleNames.push(r.roleName);
      trail(ctx.env, { source: 'iam', name: 'AddRoleToInstanceProfile', resources: [['AWS::IAM::Role', r.arn]], request: { instanceProfileName: p.instanceProfileName, roleName: r.roleName }, response: null });
      return undefined;
    },
  },
  {
    name: 'remove-role-from-instance-profile',
    desc: 'インスタンスプロファイルからロールを出す',
    params: [{ name: 'instance-profile-name', type: 'string', required: true, desc: 'インスタンスプロファイル名' }, nameParam('role')],
    scope: 'global',
    run(ctx) {
      const p = profileOf(ctx);
      const name = req(ctx, 'role-name');
      if (!p.roleNames.includes(name)) throw new AwsError('NoSuchEntity', `The role with name ${name} cannot be found.`);
      p.roleNames = p.roleNames.filter((n) => n !== name);
      trail(ctx.env, { source: 'iam', name: 'RemoveRoleFromInstanceProfile', resources: [['AWS::IAM::InstanceProfile', p.arn]], request: { instanceProfileName: p.instanceProfileName, roleName: name }, response: null });
      return undefined;
    },
  },
  {
    name: 'delete-instance-profile',
    desc: 'インスタンスプロファイルを削除する (ロールを出してから)',
    params: [{ name: 'instance-profile-name', type: 'string', required: true, desc: 'インスタンスプロファイル名' }],
    scope: 'global',
    run(ctx) {
      const p = profileOf(ctx);
      if (p.roleNames.length) throw new AwsError('DeleteConflict', 'Cannot delete entity, must remove roles from instance profile first.');
      ctx.env.instanceProfiles = ctx.env.instanceProfiles.filter((x) => x !== p);
      trail(ctx.env, { source: 'iam', name: 'DeleteInstanceProfile', resources: [['AWS::IAM::InstanceProfile', p.arn]], request: { instanceProfileName: p.instanceProfileName }, response: null });
      return undefined;
    },
  },

  /* ---- ポリシーシミュレーター ---- */
  {
    name: 'simulate-principal-policy',
    desc: 'ユーザー / ロールがある操作を許されるかを、実際には呼ばずに試算する (ポリシーシミュレーター)',
    params: [
      { name: 'policy-source-arn', type: 'string', required: true, desc: 'ユーザーかロールの ARN' },
      { name: 'action-names', type: 'list', required: true, desc: '例: s3:GetObject' },
      { name: 'resource-arns', type: 'list', desc: '例: arn:aws:s3:::my-bucket/key (省略すると *)' },
      { name: 'resource-policy', type: 'string', desc: 'リソースベースポリシー (バケットポリシーなど) の JSON' },
    ],
    readOnly: true,
    scope: 'global',
    examples: ['aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::123456789012:role/batch-role --action-names s3:GetObject --resource-arns arn:aws:s3:::my-bucket/key'],
    run(ctx) {
      const principal = principalOf(ctx.env, req(ctx, 'policy-source-arn'));
      const resourcePolicy = str(ctx, 'resource-policy') === undefined ? undefined : parsePolicy(req(ctx, 'resource-policy'), 'resource');
      const resources = strs(ctx, 'resource-arns');
      return {
        EvaluationResults: strs(ctx, 'action-names').flatMap((action) =>
          (resources.length ? resources : ['*']).map((resource) => {
            const d = evaluateIamPermission(ctx.env, { principal, action, resource, resourcePolicy });
            const want = d.decision === 'Allow' ? 'Allow' : 'Deny';
            return {
              EvalActionName: action,
              EvalResourceName: resource,
              EvalDecision: { Allow: 'allowed', ExplicitDeny: 'explicitDeny', ImplicitDeny: 'implicitDeny' }[d.decision],
              MatchedStatements: d.statements.filter((s) => s.applies && s.effect === want).map((s) => ({ SourcePolicyId: s.kind === 'resource' ? 'ResourcePolicy' : s.source.replace(/ \(.*\)$/, ''), SourcePolicyType: s.kind === 'resource' ? 'resource' : 'IAM Policy' })),
              MissingContextValues: [],
            };
          }),
        ),
      };
    },
  },
];

export default service('iam', 'AWS IAM (ロール・ユーザー・ポリシー・インスタンスプロファイル)', ops);
