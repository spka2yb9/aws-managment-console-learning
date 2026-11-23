/* aws organizations — 組織の構造 (ルート・OU・アカウント) と SCP (サービスコントロールポリシー) */
import { parsePolicy } from '../../../sim/iam';
import { attachScp, createScp, deleteScp, detachScp, entityName, getOrg, moveAccount, updateScp } from '../../../sim/organizations';
import type { Organization, OrgPolicy } from '../../../sim/types';
import { AwsError, iso, req, service, str, type OpContext, type OperationSpec } from '../types';

const SCP = 'SERVICE_CONTROL_POLICY';
const policyTypes = [{ Type: SCP, Status: 'ENABLED' }];

const accountArn = (org: Organization, id: string) => `arn:aws:organizations::${org.managementAccountId}:account/${org.id}/${id}`;
const rootArn = (org: Organization) => `arn:aws:organizations::${org.managementAccountId}:root/${org.id}/${org.rootId}`;
const accountOut = (org: Organization, a: Organization['accounts'][number]) => ({ Id: a.id, Arn: accountArn(org, a.id), Email: a.email, Name: a.name, Status: 'ACTIVE', JoinedMethod: a.id === org.managementAccountId ? 'CREATED' : 'INVITED', JoinedTimestamp: iso(a.joinedAt) });
const summaryOut = (p: OrgPolicy) => ({ Id: p.id, Arn: p.arn, Name: p.name, Description: p.description ?? '', Type: SCP, AwsManaged: p.awsManaged });
const policyOut = (p: OrgPolicy) => ({ Policy: { PolicySummary: summaryOut(p), Content: JSON.stringify(p.document) } });
const typeOf = (org: Organization, id: string) => (id === org.rootId ? 'ROOT' : org.ous.some((o) => o.id === id) ? 'ORGANIZATIONAL_UNIT' : 'ACCOUNT');

function policyOf(ctx: OpContext): OrgPolicy {
  const p = getOrg(ctx.env).policies.find((x) => x.id === req(ctx, 'policy-id'));
  if (!p) throw new AwsError('PolicyNotFoundException', "We can't find a policy with the PolicyId that you specified.");
  return p;
}

function parentOf(ctx: OpContext, name = 'parent-id'): Organization {
  const org = getOrg(ctx.env);
  const id = req(ctx, name);
  if (id !== org.rootId && !org.ous.some((o) => o.id === id)) throw new AwsError('ParentNotFoundException', "We can't find a root or OU with the ParentId that you specified.");
  return org;
}

/** --filter SERVICE_CONTROL_POLICY (このシミュレーターのポリシーは SCP だけ) */
function checkFilter(ctx: OpContext) {
  const f = req(ctx, 'filter');
  if (!['SERVICE_CONTROL_POLICY', 'RESOURCE_CONTROL_POLICY', 'TAG_POLICY', 'BACKUP_POLICY', 'AISERVICES_OPT_OUT_POLICY', 'CHATBOT_POLICY', 'DECLARATIVE_POLICY_EC2'].includes(f))
    throw new AwsError('InvalidInputException', `You provided a value that does not match the required pattern. (Filter: ${f})`);
  return f === SCP;
}

/** --content の JSON を SCP として読む (IAM と同じ検証。エラーコードは Organizations のもの) */
function contentOf(ctx: OpContext) {
  try {
    return parsePolicy(req(ctx, 'content'), 'identity');
  } catch (e) {
    if (e instanceof AwsError) throw new AwsError('MalformedPolicyDocumentException', `The provided policy document does not meet the requirements of the specified policy type. (${e.message})`);
    throw e;
  }
}

const filter = { name: 'filter', type: 'string' as const, required: true, desc: 'ポリシーの種類: SERVICE_CONTROL_POLICY' };
const policyId = { name: 'policy-id', type: 'string' as const, required: true, desc: 'ポリシー ID (p-...)' };
const targetId = { name: 'target-id', type: 'string' as const, required: true, desc: 'ルート (r-...)・OU (ou-...)・アカウント ID' };

const ops: OperationSpec[] = [
  {
    name: 'describe-organization',
    desc: '組織の ID と管理アカウント',
    params: [],
    readOnly: true,
    run(ctx) {
      const org = getOrg(ctx.env);
      const mgmt = org.accounts.find((a) => a.id === org.managementAccountId);
      return { Organization: { Id: org.id, Arn: org.arn, FeatureSet: 'ALL', MasterAccountArn: accountArn(org, org.managementAccountId), MasterAccountId: org.managementAccountId, MasterAccountEmail: mgmt?.email, AvailablePolicyTypes: policyTypes } };
    },
  },
  {
    name: 'list-roots',
    desc: '組織のルート (組織図のいちばん上)',
    params: [],
    readOnly: true,
    run(ctx) {
      const org = getOrg(ctx.env);
      return { Roots: [{ Id: org.rootId, Arn: rootArn(org), Name: 'Root', PolicyTypes: policyTypes }] };
    },
  },
  {
    name: 'list-organizational-units-for-parent',
    desc: 'ルートか OU の直下の OU の一覧',
    params: [{ name: 'parent-id', type: 'string', required: true, desc: 'ルート (r-...) か OU (ou-...) の ID' }],
    readOnly: true,
    run(ctx) {
      const org = parentOf(ctx);
      return { OrganizationalUnits: org.ous.filter((o) => o.parentId === req(ctx, 'parent-id')).map((o) => ({ Id: o.id, Arn: o.arn, Name: o.name })) };
    },
  },
  {
    name: 'list-accounts',
    desc: '組織のすべてのアカウント',
    params: [],
    readOnly: true,
    run(ctx) {
      const org = getOrg(ctx.env);
      return { Accounts: org.accounts.map((a) => accountOut(org, a)) };
    },
  },
  {
    name: 'list-accounts-for-parent',
    desc: 'ルートか OU の直下のアカウント',
    params: [{ name: 'parent-id', type: 'string', required: true, desc: 'ルート (r-...) か OU (ou-...) の ID' }],
    readOnly: true,
    run(ctx) {
      const org = parentOf(ctx);
      return { Accounts: org.accounts.filter((a) => a.parentId === req(ctx, 'parent-id')).map((a) => accountOut(org, a)) };
    },
  },
  {
    name: 'list-parents',
    desc: 'アカウントか OU のすぐ上 (親) のルート / OU',
    params: [{ name: 'child-id', type: 'string', required: true, desc: 'アカウント ID か OU の ID' }],
    readOnly: true,
    run(ctx) {
      const org = getOrg(ctx.env);
      const id = req(ctx, 'child-id');
      const parent = org.accounts.find((a) => a.id === id)?.parentId ?? org.ous.find((o) => o.id === id)?.parentId;
      if (!parent) throw new AwsError('ChildNotFoundException', "We can't find an organizational unit (OU) or AWS account with the ChildId that you specified.");
      return { Parents: [{ Id: parent, Type: typeOf(org, parent) }] };
    },
  },
  {
    name: 'move-account',
    desc: 'アカウントを別のルート / OU の下へ移す',
    params: [
      { name: 'account-id', type: 'string', required: true, desc: '移すアカウントの ID' },
      { name: 'source-parent-id', type: 'string', required: true, desc: 'いまの親 (ルートか OU) の ID' },
      { name: 'destination-parent-id', type: 'string', required: true, desc: '移し先 (ルートか OU) の ID' },
    ],
    run(ctx) {
      const org = getOrg(ctx.env);
      const a = org.accounts.find((x) => x.id === req(ctx, 'account-id'));
      if (a && a.parentId !== req(ctx, 'source-parent-id')) throw new AwsError('SourceParentNotFoundException', "We can't find a source root or OU with the ParentId that you specified.");
      moveAccount(ctx.env, req(ctx, 'account-id'), req(ctx, 'destination-parent-id'));
      return undefined;
    },
  },
  {
    name: 'list-policies',
    desc: 'ポリシー (SCP) の一覧',
    params: [filter],
    readOnly: true,
    run: (ctx) => ({ Policies: checkFilter(ctx) ? getOrg(ctx.env).policies.map(summaryOut) : [] }),
  },
  {
    name: 'describe-policy',
    desc: 'ポリシーの中身 (Content は JSON の文字列)',
    params: [policyId],
    readOnly: true,
    run: (ctx) => policyOut(policyOf(ctx)),
  },
  {
    name: 'create-policy',
    desc: 'SCP を作る (作っただけでは効かない。attach-policy で付ける)',
    params: [
      { name: 'content', type: 'string', required: true, desc: 'ポリシーの JSON (file://x.json でファイルから)' },
      { name: 'description', type: 'string', required: true, desc: '説明' },
      { name: 'name', type: 'string', required: true, desc: 'ポリシーの名前' },
      { name: 'type', type: 'string', required: true, desc: 'SERVICE_CONTROL_POLICY' },
    ],
    examples: ['aws organizations create-policy --name protect-audit --description "..." --type SERVICE_CONTROL_POLICY --content file://protect-audit.json'],
    run(ctx) {
      if (req(ctx, 'type') !== SCP) throw new AwsError('InvalidInputException', '(シミュレーター) このシミュレーターで作れるのは SERVICE_CONTROL_POLICY だけです');
      const id = createScp(ctx.env, { name: req(ctx, 'name'), description: str(ctx, 'description'), document: contentOf(ctx) });
      return policyOut(getOrg(ctx.env).policies.find((p) => p.id === id)!);
    },
  },
  {
    name: 'update-policy',
    desc: 'SCP の中身を書き換える',
    params: [policyId, { name: 'content', type: 'string', required: true, desc: '新しいポリシーの JSON (file://x.json)' }],
    run(ctx) {
      updateScp(ctx.env, policyOf(ctx).id, contentOf(ctx));
      return policyOut(policyOf(ctx));
    },
  },
  {
    name: 'delete-policy',
    desc: 'SCP を消す (どこにも付いていないものだけ)',
    params: [policyId],
    run(ctx) {
      deleteScp(ctx.env, policyOf(ctx).id);
      return undefined;
    },
  },
  {
    name: 'attach-policy',
    desc: 'SCP をルート / OU / アカウントに付ける (下の OU とアカウントに継承される)',
    params: [policyId, targetId],
    run(ctx) {
      attachScp(ctx.env, req(ctx, 'policy-id'), req(ctx, 'target-id'));
      return undefined;
    },
  },
  {
    name: 'detach-policy',
    desc: 'SCP をルート / OU / アカウントから外す',
    params: [policyId, targetId],
    run(ctx) {
      detachScp(ctx.env, req(ctx, 'policy-id'), req(ctx, 'target-id'));
      return undefined;
    },
  },
  {
    name: 'list-policies-for-target',
    desc: 'ルート / OU / アカウントに直接付いている SCP (上から継承されるものは含まない)',
    params: [targetId, filter],
    readOnly: true,
    run(ctx) {
      const org = getOrg(ctx.env);
      const id = req(ctx, 'target-id');
      if (typeOf(org, id) === 'ACCOUNT' && !org.accounts.some((a) => a.id === id)) throw new AwsError('TargetNotFoundException', "We can't find a root, OU, account, or email target with the TargetId that you specified.");
      return { Policies: checkFilter(ctx) ? org.policies.filter((p) => p.targets.includes(id)).map(summaryOut) : [] };
    },
  },
  {
    name: 'list-targets-for-policy',
    desc: 'その SCP が直接付いているルート / OU / アカウント',
    params: [policyId],
    readOnly: true,
    run(ctx) {
      const org = getOrg(ctx.env);
      const p = policyOf(ctx);
      const arnOf = (id: string) => (id === org.rootId ? rootArn(org) : (org.ous.find((o) => o.id === id)?.arn ?? accountArn(org, id)));
      return { Targets: p.targets.map((t) => ({ TargetId: t, Arn: arnOf(t), Name: entityName(org, t), Type: typeOf(org, t) })) };
    },
  },
];

export default service('organizations', 'AWS Organizations (アカウント・OU・SCP)', ops.map((o) => ({ ...o, scope: 'global' as const })));
