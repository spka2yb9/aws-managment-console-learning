import { alnum } from '../../../sim/edge';
import { configOf, ssoIdentity } from '../auth/sso';
import { service } from '../types';

/* 学習者の PC の CLI は、IAM ユーザー learner のアクセスキーで動いている。
   IAM Identity Center のプロファイル (--profile) なら、許可セットのロールを引き受けた一時的な認証情報になる */
export default service('sts', 'AWS STS (いまの認証情報が誰なのか)', [
  {
    name: 'get-caller-identity',
    desc: 'この CLI がどの IAM ユーザー / ロールとして API を呼んでいるかを表示する',
    params: [],
    readOnly: true,
    scope: 'global',
    run: (ctx) => {
      const sso = ssoIdentity(ctx, configOf(ctx)[ctx.profile] ?? {});
      if (sso) return { UserId: `AROA${alnum(sso.roleName, 17)}:${sso.user}`, Account: sso.accountId, Arn: sso.arn };
      return { UserId: 'AIDAQ3EGZ7LEARNER0001', Account: ctx.env.accountId, Arn: `arn:aws:iam::${ctx.env.accountId}:user/learner` };
    },
  },
]);
