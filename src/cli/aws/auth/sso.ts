/* IAM Identity Center (SSO) のプロファイルで打った aws の認可。
   ~/.aws/config の [profile x] に sso_session / sso_account_id / sso_role_name があれば、aws sso login で取ったトークン
   (~/.aws/sso/cache/<セッション名>.json) の人が、そのアカウントで許可セットのロール AWSReservedSSO_… を引き受けたものとして、
   許可セットのポリシーと SCP で判定する (コンソール版のアクセスポータルの「アクセスを試す」と同じ testAccess)。
   ponytail: メンバーアカウントのリソースは再現していない。参照系は管理アカウントの中身が見え、変更系は許可されても手前で止める */
import { useConsole } from '../../../console/store';
import { alnum } from '../../../sim/edge';
import { entityName, getOrg, portalAccess, testAccess } from '../../../sim/organizations';
import { readIni } from '../aws';
import { AwsError, str, type Authorizer, type OpContext } from '../types';

/* ---- aws sso login が置くトークン。ponytail: 本物のファイル名はセッション名の SHA-1。ここでは読みやすさを優先してセッション名そのもの ---- */
export const tokenPath = (session: string) => `~/.aws/sso/cache/${session}.json`;
export const makeToken = (user: string, expiresAt: number) => 'aoa' + btoa(`${user}:${expiresAt}`).replace(/=+$/, '');

/** トークンの持ち主と期限 (でたらめなら undefined) */
export function readToken(token: string | undefined): { user: string; expiresAt: number } | undefined {
  try {
    const [user, exp] = atob(token!.slice(3)).split(':');
    return user && Number(exp) ? { user, expiresAt: Number(exp) } : undefined;
  } catch {
    return undefined;
  }
}

export const configOf = (ctx: OpContext) => readIni(ctx.readLocal('~/.aws/config'));

export interface SsoIdentity {
  user: string;
  accountId: string;
  /** 許可セットの名前 (sso_role_name) */
  role: string;
  roleName: string;
  arn: string;
}

/**
 * SSO のプロファイルなら、誰がどのアカウントのどのロールで入っているか。SSO のプロファイルでなければ undefined。
 * サインインしていない・割り当てがないときは、本物の CLI と同じ文言の Error を投げる (aws.ts が終了コード 255 で出す)
 */
export function ssoIdentity(ctx: OpContext, conf: Record<string, string>): SsoIdentity | undefined {
  const session = conf.sso_session;
  if (!session && !conf.sso_start_url) return undefined;
  if (!session) throw new Error('(シミュレーター) このシミュレーターは、sso_session で [sso-session ...] を指す書き方にだけ対応しています');
  const missing = ['sso_account_id', 'sso_role_name'].filter((k) => !conf[k]);
  if (missing.length) throw new Error(`Missing the following required SSO configuration values: ${missing.join(', ')}. To make sure this profile is properly configured to use SSO, please run:\n\naws configure sso`);
  let token: { user: string; expiresAt: number } | undefined;
  try {
    token = readToken(JSON.parse(ctx.readLocal(tokenPath(session)) ?? '{}').accessToken);
  } catch {
    token = undefined;
  }
  if (!token) throw new Error(`Error loading SSO Token: Token for ${session} does not exist`);
  if (token.expiresAt <= ctx.now) throw new Error('Error when retrieving token from sso: Token has expired and refresh failed');
  const env = useConsole.getState().env;
  const access = portalAccess(env, token.user).find((a) => a.accountId === conf.sso_account_id && a.permissionSet.name === conf.sso_role_name);
  if (!access) throw new Error('Error when retrieving credentials from sso: An error occurred (ForbiddenException) when calling the GetRoleCredentials operation: No access');
  // testAccess (sim/organizations.ts) と同じロール名
  const roleName = `AWSReservedSSO_${conf.sso_role_name}_${alnum(access.permissionSet.arn, 16).toLowerCase()}`;
  return { user: token.user, accountId: conf.sso_account_id, role: conf.sso_role_name, roleName, arn: `arn:aws:sts::${conf.sso_account_id}:assumed-role/${roleName}/${token.user}` };
}

/* ---- 認可 ---- */

/** グローバルサービス: リクエストは us-east-1 に届いたものとして SCP の aws:RequestedRegion を判定する */
const GLOBAL = new Set(['iam', 'organizations', 'route53', 'cloudfront', 'budgets', 'ce', 'support']);
/** CLI のサービス名と IAM のアクションの頭が違うもの */
const IAM_PREFIX: Record<string, string> = { elbv2: 'elasticloadbalancing', 'sso-admin': 'sso', s3api: 's3' };
/** Query プロトコルのサービスは AccessDenied、EC2 は UnauthorizedOperation、ほかは AccessDeniedException */
const QUERY = new Set(['rds', 'iam', 'sts', 'elbv2', 'autoscaling', 'cloudwatch', 'sns', 's3', 's3api', 'cloudformation']);

function resourceOf(ctx: OpContext, service: string, operation: string, account: string): string {
  const r = ctx.region;
  if (service === 'ec2' && operation === 'RunInstances') return `arn:aws:ec2:${r}:${account}:instance/*`;
  if (service === 'ec2' && str(ctx, 'instance-ids')) return `arn:aws:ec2:${r}:${account}:instance/${str(ctx, 'instance-ids')}`;
  if (service === 'rds' && str(ctx, 'db-snapshot-identifier')) return `arn:aws:rds:${r}:${account}:snapshot:${str(ctx, 'db-snapshot-identifier')}`;
  if (service === 'rds' && str(ctx, 'db-instance-identifier')) return `arn:aws:rds:${r}:${account}:db:${str(ctx, 'db-instance-identifier')}`;
  return '*';
}

const authorize: Authorizer = ({ ctx, service, operation, readOnly, profileConfig }) => {
  // aws sso list-accounts など (アクセスポータルの API) は、--access-token のトークンだけで認可される
  if (service === 'sso') return;
  const id = ssoIdentity(ctx, profileConfig);
  if (!id || (service === 'sts' && operation === 'GetCallerIdentity')) return;
  const env = useConsole.getState().env;
  const action = `${IAM_PREFIX[service] ?? service}:${operation}`;
  const resource = resourceOf(ctx, service, operation, id.accountId);
  const r = testAccess(env, { userName: id.user, accountId: id.accountId, permissionSetName: id.role, action, region: GLOBAL.has(service) ? 'us-east-1' : ctx.region, resource });
  if (!r.allowed) {
    if (service === 'ec2') throw new AwsError('UnauthorizedOperation', `You are not authorized to perform this operation. ${r.error}. Encoded authorization failure message: ${alnum(action + id.arn, 48)}`);
    throw new AwsError(QUERY.has(service) ? 'AccessDenied' : 'AccessDeniedException', r.error!);
  }
  if (!readOnly && id.accountId !== env.accountId)
    throw new AwsError('DryRunOperation', `(シミュレーター) Request would have succeeded: 許可セット ${id.role} と SCP の判定では許可されました。ただし、このシミュレーターはメンバーアカウント ${entityName(getOrg(env), id.accountId)} (${id.accountId}) の中身を再現していないため、ここで止めます (何も変わっていません)`);
};

export default authorize;
