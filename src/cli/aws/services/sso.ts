/* aws sso — IAM Identity Center のアクセスポータル側 (サインインと、自分が入れるアカウント・ロールの一覧)。
   sso login はブラウザの代わりに、sso-session の名前と同じユーザーでサインインしたことにする (シミュレーターの約束) */
import { entityName, getOrg, getSso, portalAccess } from '../../../sim/organizations';
import { configOf, makeToken, readToken, tokenPath } from '../auth/sso';
import { AwsError, iso, req, service, str, type OpContext, type OperationSpec, type RawResult } from '../types';

const HOURS_8 = 8 * 3600_000;

/** --access-token の持ち主 (期限切れ・でたらめなら UnauthorizedException) */
function userOf(ctx: OpContext): string {
  const t = readToken(req(ctx, 'access-token'));
  if (!t || t.expiresAt <= ctx.now || !getSso(ctx.env).users.some((u) => u.userName === t.user)) throw new AwsError('UnauthorizedException', 'Session token not found or invalid');
  return t.user;
}

const fail = (text: string): RawResult => ({ text: `\n${text}`, exitCode: 255 });

const ops: OperationSpec[] = [
  {
    name: 'login',
    desc: 'IAM Identity Center にサインインし、一時的な認証情報を取るためのトークンを ~/.aws/sso/cache に置く',
    params: [
      { name: 'sso-session', type: 'string', desc: '~/.aws/config の [sso-session 名前] (省略すると --profile のプロファイルの sso_session)' },
      { name: 'no-browser', type: 'boolean', desc: 'ブラウザを開かず URL だけを出す' },
      { name: 'use-device-code', type: 'boolean', desc: 'デバイスコードでサインインする' },
    ],
    local: true,
    raw: true,
    examples: ['aws sso login --sso-session node', 'aws sso login --profile node-dev'],
    run(ctx) {
      const config = configOf(ctx);
      if (!str(ctx, 'sso-session') && ctx.profile !== 'default' && !config[ctx.profile]) return fail(`The config profile (${ctx.profile}) could not be found`);
      const session = str(ctx, 'sso-session') ?? config[ctx.profile]?.sso_session;
      if (!session) return fail('Missing the following required SSO configuration values: sso_start_url, sso_region. To make sure this profile is properly configured to use SSO, please run:\n\naws configure sso');
      const s = config[`sso-session ${session}`];
      if (!s) return fail(`The specified sso-session does not exist: "${session}"`);
      const missing = ['sso_start_url', 'sso_region'].filter((k) => !s[k]);
      if (missing.length) return fail(`Missing the following required SSO configuration values: ${missing.join(', ')}. To make sure this profile is properly configured to use SSO, please run:\n\naws configure sso`);
      const user = getSso(ctx.env).users.find((u) => u.userName === session);
      if (!user) return fail(`(シミュレーター) ブラウザでのサインインの代わりに、sso-session の名前と同じユーザーでサインインします。IAM Identity Center にユーザー ${session} がいません (いるのは ${getSso(ctx.env).users.map((u) => u.userName).join(' / ')})`);
      const expiresAt = ctx.now + HOURS_8;
      ctx.writeLocal(tokenPath(session), JSON.stringify({ startUrl: s.sso_start_url, region: s.sso_region, accessToken: makeToken(user.userName, expiresAt), expiresAt: iso(expiresAt)!.replace('+00:00', 'Z') }, null, 2) + '\n');
      const code = `${user.userName.toUpperCase().padEnd(4, 'X').slice(0, 4)}-${String(expiresAt % 10000).padStart(4, '0')}`;
      return [
        'Attempting to automatically open the SSO authorization page in your default browser.',
        'If the browser does not open or you wish to use a different device to authorize this request, open the following URL:',
        '',
        `https://device.sso.${s.sso_region}.amazonaws.com/`,
        '',
        'Then enter the code:',
        '',
        code,
        `(シミュレーター) ブラウザの代わりに、ユーザー ${user.userName} (${user.displayName}) としてサインインしました`,
        `Successfully logged into Start URL: ${s.sso_start_url}`,
      ].join('\n');
    },
  },
  {
    name: 'list-accounts',
    desc: 'サインインした人が入れる AWS アカウントの一覧 (アクセスポータルに並ぶもの)',
    params: [{ name: 'access-token', type: 'string', required: true, desc: 'aws sso login で取ったトークン (~/.aws/sso/cache/*.json の accessToken)' }],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const org = getOrg(ctx.env);
      const ids = [...new Set(portalAccess(ctx.env, userOf(ctx)).map((a) => a.accountId))];
      return { accountList: ids.map((id) => ({ accountId: id, accountName: entityName(org, id), emailAddress: org.accounts.find((a) => a.id === id)?.email })) };
    },
  },
  {
    name: 'list-account-roles',
    desc: 'サインインした人が、そのアカウントで使えるロール (許可セット) の一覧',
    params: [
      { name: 'access-token', type: 'string', required: true, desc: 'aws sso login で取ったトークン' },
      { name: 'account-id', type: 'string', required: true, desc: 'アカウント ID' },
    ],
    readOnly: true,
    scope: 'global',
    run(ctx) {
      const account = req(ctx, 'account-id');
      return { roleList: portalAccess(ctx.env, userOf(ctx)).filter((a) => a.accountId === account).map((a) => ({ roleName: a.permissionSet.name, accountId: account })) };
    },
  },
];

export default service('sso', 'IAM Identity Center のアクセスポータル (サインインと、入れるアカウント・ロール)', ops);
