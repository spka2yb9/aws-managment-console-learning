// 拡張機能のコース: AWS WAF Anti-DDoS (数千の IP からの L7 DDoS を、Anti-DDoS マネージドルールグループで受け止める)
import type { DiagramSpec } from '../diagram/spec';
import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { ANTI_DDOS, ANTI_DDOS_RULES, isExempt } from '../sim/ext/antiddos';
import { ACL_NAME, antiDdosEnv, RATE_RULE } from '../sim/ext/antiddos-scenario';
import type { AwsEnv, WafRule } from '../sim/types';
import { lastRequestTo, visited } from './helpers';

/* ---- 判定 (CLI 版 l42-anti-ddos.ts でも使う) ---- */
export const GROUP_RULE = `AWS-${ANTI_DDOS}`;
export const APP_PATH = '/app/v1/products';
export const webAcl = (env: AwsEnv) => env.webAcls.find((a) => a.name === ACL_NAME);
export const shopDomain = (env: AwsEnv) => env.distributions[0]?.domainName ?? 'd111111abcdef8.cloudfront.net';
/** the Anti-DDoS rule group's rule in webapp-acl */
export const groupRule = (env: AwsEnv): (WafRule & { statement: { kind: 'managed' } }) | undefined =>
  webAcl(env)?.rules.find((r): r is WafRule & { statement: { kind: 'managed' } } => r.statement.kind === 'managed' && r.statement.name === ANTI_DDOS);
const overrideOf = (env: AwsEnv, inner: string) => groupRule(env)?.statement.ruleActionOverrides?.find((o) => o.name === inner)?.action;
/** in the web ACL, but nothing in the group acts: every rule overridden to Count (or the group's OverrideAction is Count) */
export const counting = (env: AwsEnv) => !!groupRule(env) && (groupRule(env)!.action === 'Count' || ANTI_DDOS_RULES.every((r) => overrideOf(env, r.name) === 'Count'));
/** evaluated before every other rule */
export const onTop = (env: AwsEnv) => !!groupRule(env) && webAcl(env)!.rules.every((r) => r.priority >= groupRule(env)!.priority);
/** challenges and blocks with the rules' own actions */
export const protecting = (env: AwsEnv) => {
  const r = groupRule(env);
  return !!r && r.action !== 'Count' && r.statement.antiDdos?.challenge.usage === 'ENABLED' && ANTI_DDOS_RULES.every((x) => !overrideOf(env, x.name));
};
/** the smartphone app's API (/app/...) is not challenged */
export const appExempt = (env: AwsEnv) => {
  const cfg = groupRule(env)?.statement.antiDdos;
  return !!cfg && isExempt(cfg, shopDomain(env), APP_PATH);
};
const lastToShop = (c: TaskContext) => lastRequestTo(c, shopDomain(c.env));
export const timedOutSeen = (c: TaskContext) => lastToShop(c)?.status === 504;
export const shopOk = (c: TaskContext) => protecting(c.env) && lastToShop(c)?.status === 200;
const ACL_PATH = `/wafv2/webacls/${ACL_NAME}`;
const sawRules = (c: TaskContext) => c.visited.includes(`${ACL_PATH}?tab=rules`);
const sawGroupSamples = (c: TaskContext) => !!groupRule(c.env) && c.visited.some((v) => v.startsWith(ACL_PATH) && v.includes(`rule=${GROUP_RULE}`));

const plan: DiagramSpec = {
  groups: [],
  nodes: [
    { id: 'shoppers', label: 'お客さん', sublabel: 'ブラウザ (JavaScript を実行する)', icon: 'users' },
    { id: 'app', label: 'スマホアプリ', sublabel: '/app/... (JavaScript なし)', icon: 'client' },
    { id: 'bots', label: 'ボットネット', sublabel: '198.18.x.x ほか 5,000 台', icon: 'internet' },
    { id: 'waf', label: 'AWS WAF', sublabel: 'webapp-acl + Anti-DDoS', icon: 'waf' },
    { id: 'cf', label: 'CloudFront', sublabel: 'ショップの入口', icon: 'cloudfront' },
    { id: 'alb', label: 'web-alb', sublabel: '→ web-1 / web-2 → webapp-db', icon: 'alb' },
  ],
  edges: [
    { id: 'e1', source: 'shoppers', target: 'waf', label: 'チャレンジを自動で解いて通る', status: 'connected' },
    { id: 'e2', source: 'app', target: 'waf', label: '除外 URI なのでチャレンジされない', status: 'connected' },
    { id: 'e3', source: 'bots', target: 'waf', label: 'チャレンジ (202) / ブロック (403)', status: 'blocked' },
    { id: 'e4', source: 'waf', target: 'cf', label: '通ったものだけ', status: 'connected' },
    { id: 'e5', source: 'cf', target: 'alb', label: 'ふだんの量に戻る', status: 'connected' },
  ],
};

export const lesson42: Lesson = {
  id: 'anti-ddos',
  number: '42',
  title: 'AWS WAF Anti-DDoS',
  summary: '数千の IP からの L7 DDoS を、Anti-DDoS マネージドルールグループで受け止める。カウントで試し、ラベルを読み、アプリの API を除外してから有効にする',
  minutes: 25,
  startPath: '/cloudfront/distributions',
  scenario: antiDdosEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、大変です！ ショップが開かないって問い合わせが殺到してます。開いても、しばらく待たされて **504** です。'),
        hakase('504 Gateway Time-out。Lesson 16 で見たな。「奥のサーバーが時間内に返事をしなかった」だ。'),
        node('サーバーが落ちたんですか？'),
        hakase('落ちてはおらん。CloudWatch で ALB を見たら、リクエストがふだんの 20 倍だ。web サーバーもデータベースも CPU が天井に張り付いておる。'),
        node('20 倍！ セールでも始まったんですか？'),
        hakase('セールなら注文も 20 倍のはずだが、注文はほぼゼロだ。来ておるのは客ではない。**DDoS** だ。'),
        node('でぃーどす？'),
        hakase('Distributed Denial of Service、分散型サービス妨害攻撃だ。たくさんのコンピュータから一斉にリクエストを送りつけて、サービスを押しつぶす。Lesson 38 で Shield の説明のときに名前だけ出たな。'),
        node('「今日は出番がない」って言ってたやつですね。今日は出番があるんですね。'),
        hakase('「分散型」というのは、攻撃元が 1 台ではないということだ。乗っ取られた家庭用ルーターや監視カメラが、何千台も一斉に来る。こういう乗っ取られた機械の群れを **ボットネット** という。'),
        node('ぼっとねっと…ロボットのネットワークですか？'),
        hakase('そうだ。持ち主は、自分のカメラが攻撃に加わっているとは夢にも思っておらん。ワシの家の電子レンジも怪しいものだ。'),
        node('博士の電子レンジ、ネットにつながってないですよね。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('でも、うちには WAF がありますよね。Lesson 38 で IP セットを直したやつ。'),
        hakase('今日のショップにも、ウェブ ACL `webapp-acl` が CloudFront に付いておる。それが何もしていないのが問題なのだ。'),
        hakase('DDoS には大きく 2 種類ある。パケットの量で回線やネットワーク機器をあふれさせる **L3/L4** の攻撃と、まともな HTTP リクエストのふりをして、アプリに重い仕事をさせる **L7** の攻撃だ。'),
        node('える…すりー？'),
        hakase('通信の仕組みを 7 階建てのビルにたとえた **OSI 参照モデル** の階数だ。3 階がネットワーク (IP)、4 階がトランスポート (TCP / UDP)、7 階がアプリケーション (HTTP) だ。'),
        hakase('L3/L4 の洪水は、CloudFront の手前で **AWS Shield Standard** が追加料金なしで受け止めてくれる。今日来ておるのは、一見まともな `GET /` を何千台から送ってくる L7 の洪水だ。'),
        node('普通のリクエストに見えるなら、見分けようがないじゃないですか。'),
        hakase('1 件ずつ見ればな。だから「全体として、ふだんと比べてどうか」を見る道具が要る。それが今日の主役だ。だがその前に、今の守りがなぜ効かんのかを確かめる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('`webapp-acl` には、前の担当者が入れた **レートベースのルール** `rate-limit-per-ip` がある。'),
        node('れーとべーす？'),
        hakase('同じ送信元 IP から、決まった時間に何回来たかを数えて、上限を超えた IP を止めるルールだ。`rate-limit-per-ip` は、5 分間 (300 秒) に 1,000 回を超えた IP をブロックする。'),
        node('回転寿司の「お一人様 1,000 皿まで」みたいなものですね。'),
        hakase('1 人で 1,001 皿食う客は止められる。だが、5,000 人が 120 皿ずつ取っていったらどうなる？'),
        node('…上限には誰も引っかからないけど、お寿司は全部なくなります。'),
        hakase('そうだ。分散型の攻撃は、1 台あたりは控えめに送ってくる。IP ごとに数えるルールには引っかからん。'),
        node('ずるいなあ。'),
        hakase('ずるいのが攻撃者の仕事だ。まずはショップの症状と、ウェブ ACL の **サンプリングされたリクエスト** を見るぞ。Lesson 38 の防犯カメラの録画だ。'),
      ],
    },
    {
      type: 'exercise',
      title: '症状と、効いていないルールを確かめる',
      objective: 'CloudFront のドメイン名をブラウザで開いて 504 を確かめ、WAF のウェブ ACL `webapp-acl` のサンプリングされたリクエストとルールで、レートベースのルールが攻撃を止めていないことを確かめる',
      tasks: [
        { id: 'browse', title: 'CloudFront のドメイン名をブラウザで開く → 504', hint: 'ディストリビューションの一覧の **ドメイン名** をコピーし、レッスンパネル上部の「ブラウザ」タブの URL 欄に貼り付けて「移動」を押します。待たされた末に 504 が返ります。', done: timedOutSeen },
        { id: 'samples', title: 'WAF & Shield > ウェブ ACL > `webapp-acl` → 概要 タブで、リクエストのグラフとサンプリングされたリクエストを見る', hint: 'サービスの検索で「WAF」と入力し、ウェブ ACL の一覧から `webapp-acl` を開きます。**送信元 IP** と **一致したルール** の列を見比べます。', done: (c) => visited(c, ACL_PATH) },
        { id: 'rules', title: `ルール タブで \`${RATE_RULE}\` の条件を見る`, hint: '`webapp-acl` の **ルール** タブの **ステートメント** 列に、レートベースのルールの上限が出ています。', done: sawRules },
      ],
      validate: (c) =>
        timedOutSeen(c) && visited(c, ACL_PATH) && sawRules(c)
          ? ok(
              node('サンプルの送信元 IP は、ほとんどが 198.18 で始まるのに、同じ IP がほとんどありません。どれも **デフォルトアクション** で ALLOW、`rate-limit-per-ip` には 1 件も一致していません。'),
              hakase('グラフの「許可」も、1 分に 12 万件を超えておる。ふだんは 6,000 件ほどだ。ボットネットはおよそ 5,000 台、1 台あたり 1 秒に 0.4 回、5 分で 120 回だ。上限 1,000 回の 8 分の 1 にもならん。'),
              node('寿司 120 皿の客が 5,000 人…お店がつぶれるわけだ。'),
              hakase('つぶれかけておるのは、うちのショップだ。'),
            )
          : ng(hakase('ディストリビューションの一覧で **ドメイン名** をコピーし、パネル上部の「ブラウザ」タブの URL 欄に貼り付けて「移動」を押す。504 を確かめるのだ。それから WAF & Shield > ウェブ ACL > `webapp-acl` を開いて、**概要** と **ルール** の 2 つのタブを見ろ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('じゃあ、上限を 100 回に下げれば止まりますよね？'),
        hakase('今日の 120 回は止まるな。そして明日、攻撃者が台数を 2 倍にして、1 台 60 回にするだけだ。'),
        node('いたちごっこじゃないですか。'),
        hakase('しかも、スマホの回線は **CGNAT** といって、何百人ものお客さんに 1 つのグローバル IP を共有させておることが多い。Lesson 39 の NAT ゲートウェイと同じで、外から見るとみんな同じ IP だ。上限を下げすぎると、その人たちがまとめて止まる。'),
        node('IP ごとに数えるやり方には、限界があるんですね。'),
        hakase('そこで **AWS WAF Anti-DDoS** だ。正体は、AWS マネージドルールグループの `AWSManagedRulesAntiDDoSRuleSet`。Lesson 38 で冷凍食品の詰め合わせにたとえたものの、高級品だ。'),
        node('高級品ってことは…'),
        hakase('有料の追加機能だ。ウェブ ACL の料金とは別に料金がかかる。有料の DDoS 対策サービス **Shield Advanced** を契約していれば、追加料金なしで使える。'),
        hakase('このルールグループは、守っているリソースのふだんのトラフィックを見て **ベースライン** を作る。'),
        node('べーすらいん？'),
        hakase('「ふだんはこのくらい」という基準線だ。ふだん 1 秒に 100 件のショップに 2,000 件来たら、明らかにおかしい。ベースラインから大きく外れた状態を **DDoS イベント** として検知する。本物は追加してから数分でベースラインを作り始めるが、シミュレーターでは、それまでの記録を使って一瞬で済ませる。'),
        node('ずっと店の前に立って、お客さんの数を数えてる店員さんですね。'),
      ],
    },
    {
      type: 'table',
      title: 'Anti-DDoS のラベル (awswaf:managed:aws:anti-ddos: に続く名前)',
      columns: ['ラベル', '付くリクエスト'],
      rows: [
        ['event-detected', 'DDoS イベント中に、守っているリソースに来たリクエストすべて (お客さんにも攻撃にも付く)'],
        ['ddos-request', '攻撃に加わっていると疑われる送信元からのリクエスト'],
        ['high- / medium- / low-suspicion-ddos-request', '疑いの強さ。high が最も怪しい'],
        ['challengeable-request', 'チャレンジに答えられる URI への GET (除外 URI の正規表現に一致しないもの)'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('このルールグループは、イベント中のリクエストに **ラベル** を付ける。荷物に貼る付箋のようなもので、「このリクエストはこういうものだ」と WAF が書き込んでいく。表のとおりだ。'),
        node('付箋を貼るだけで、止めてはくれないんですか？'),
        hakase('止めるのは中の 3 つのルールだ。ラベルを見て動く。'),
      ],
    },
    {
      type: 'table',
      title: 'AWSManagedRulesAntiDDoSRuleSet のルール (上から評価)',
      columns: ['ルール', 'アクション', '一致するもの'],
      rows: [
        ['ChallengeAllDuringEvent', 'Challenge', 'イベント中の challengeable-request すべて'],
        ['ChallengeDDoSRequests', 'Challenge', '疑いが「チャレンジの感度」以上のもの (ChallengeAllDuringEvent をカウントにしたときだけ評価)'],
        ['DDoSRequests', 'Block', '疑いが「ブロックの感度」以上のもの'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ちゃれんじ？'),
        hakase('「あなたは本物のブラウザか」を確かめる小テストだ。WAF は **202** と一緒に JavaScript の問題を返す。ブラウザは裏で自動的に解いて、合格のしるしの **トークン** (`aws-waf-token` という Cookie) を受け取り、リクエストを送り直す。'),
        node('お客さんは何もしなくていいんですか？'),
        hakase('気付きもしない。だから「サイレント」チャレンジという。安物のボットは JavaScript を実行せずに HTTP のリクエストを送るだけだから、解けずに 202 で門前払いだ。'),
        node('本物のブラウザを動かす、手の込んだボットは？'),
        hakase('チャレンジは抜けてくる。そこで DDoSRequests が、疑いの強さを見てブロックする。チャレンジが柔らかい対策、ブロックが固い対策だ。'),
        hakase('どこまで反応するかは **感度** で決める。低・中・高の 3 段階で、既定はブロックが「低」(高い疑いだけ)、チャレンジが「高」(疑わしいものすべて) だ。'),
        node('疑いが「高い」ものだけ止めるのが感度「低」…ややこしいですね。'),
        hakase('感度が高い = 敏感 = 少しの疑いでも反応する、と覚えるのだ。ワシの胃と同じだ。'),
        node('博士の胃は、上司の足音にも反応しますもんね。'),
      ],
    },
    { type: 'diagram', title: 'Anti-DDoS を有効にしたあとの流れ (今日のゴール)', diagram: plan },
    {
      type: 'dialogue',
      lines: [
        hakase('では入れる。が、Lesson 38 のクイズを覚えておるか。新しいルールを本番に入れるときは？'),
        node('まず Count で入れて、サンプルで誤検知がないか見てから本番にする、でしたよね。'),
        hakase('今回も同じだ。中の 3 つのルールのアクションを、すべて **カウント** に **オーバーライド** する。オーバーライドは「上書き」、ルールのアクションを今だけ差し替えることだ。止めずに、ラベルと一致だけが記録される。'),
        node('攻撃の真っ最中に、カウントなんて悠長なことをやってていいんですか？'),
        hakase('気持ちは分かる。だが、焦って入れたルールで社内を締め出したのが Lesson 38 の誰かさんだ。数分の確認でお客さんを巻き込む事故を防げるなら、安いものだ。'),
        hakase('置き場所は、Allow のルールの後で、ほかのルールより前。今の `webapp-acl` には Allow のルールが無いから、**一番上** だ。できるだけ多くのトラフィックを見せて、ベースラインを正確にするためだ。同じ理由で、対象を絞り込む **スコープダウンステートメント** も付けるなと、AWS は言っておる。'),
        node('一番上ですね。社長の席だ。'),
        hakase('偉いのではない。最初に全員と顔を合わせる受付係だ。'),
        hakase('ルール タブの **ルールを追加** から **マネージドルールグループを追加** を選ぶ。新しいルールは一番下に追加されるから、**ルールの優先度を設定** で上に移動するのを忘れるな。'),
      ],
    },
    {
      type: 'exercise',
      title: 'Anti-DDoS をカウントで追加して、ラベルを読む',
      objective: `\`webapp-acl\` に AWS マネージドルールグループ \`${ANTI_DDOS}\` を、すべてのルールアクションを **カウント** にオーバーライドして一番上 (優先度 0) に追加し、サンプリングされたリクエストでラベルを読む`,
      tasks: [
        {
          id: 'add',
          title: 'ルール タブ > ルールを追加 > マネージドルールグループを追加 → 「Anti-DDoS 保護」をウェブ ACL に追加し、すべてのルールアクションをカウントにオーバーライド',
          hint: '「Anti-DDoS 保護 (有料)」の **ウェブ ACL に追加** をオンにすると設定が出ます。ルールグループの設定は既定のまま、**ルール** の **すべてのルールアクションをオーバーライド** で **カウント (Count)** を選びます。',
          hotspotId: 'waf-antiddos-toggle',
          done: (c) => counting(c.env),
        },
        { id: 'top', title: `ルールの優先度を設定 で \`${GROUP_RULE}\` を一番上に移動して保存`, hint: '**ルールの優先度を設定** で新しいルールを選び、**上に移動** を押して一番上にしてから **保存** します。', hotspotId: 'waf-move-up', done: (c) => counting(c.env) && onTop(c.env) },
        {
          id: 'labels',
          title: `概要 タブのサンプリングされたリクエストを \`${GROUP_RULE}\` で絞り込み、ラベルを読む`,
          hint: 'サンプリングされたリクエストの右上のリストでルールを選びます。少し待って更新ボタンを押すと、追加したあとのリクエストが増えます。**ラベル** と **User-Agent** の列を見ます。',
          hotspotId: 'waf-samples-filter',
          done: (c) => counting(c.env) && sawGroupSamples(c),
        },
      ],
      validate: (c) => {
        if (!groupRule(c.env)) return ng(hakase('まだルールグループが無い。`webapp-acl` の **ルール** タブで **ルールを追加** > **マネージドルールグループを追加** だ。'));
        if (!counting(c.env)) return ng(hakase('カウントにせずに、いきなり本番で入れてしまったな。Lesson 38 の誰かさんと同じ道だ。ルールを選んで **編集** し、**すべてのルールアクションをオーバーライド** で **カウント** にするのだ。'));
        if (!onTop(c.env)) return ng(hakase(`\`${GROUP_RULE}\` が一番上にない。受付係が奥の部屋にいては、客の顔が見えん。ルールを選んで **編集** し、**ルールの優先度を設定** で一番上に移動するのだ。`));
        if (!sawGroupSamples(c)) return ng(hakase(`入れただけで満足するでない。**概要** タブのサンプリングされたリクエストを \`${GROUP_RULE}\` で絞り込んで、ラベルを読むのだ。`));
        return ok(
          node('198.18 のリクエストには `ddos-request` と `high-suspicion-ddos-request` が付いています。お客さんのブラウザのリクエストには `event-detected` と `challengeable-request` だけです。'),
          hakase('アクションは全部 COUNT で、止めてはおらん。「ルールグループ内のルール」に、本番なら何をしたかが出ておるな。'),
          node('あれ、User-Agent が `webapp-shop-app` のリクエストもあります。`/app/v1/products` に `challengeable-request` が付いて、ChallengeAllDuringEvent に一致してます。'),
          hakase('よく見つけた。それが今日いちばんの落とし穴だ。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('`webapp-shop-app` は、うちのスマホアプリだ。アプリの HTTP クライアントはブラウザではないから、JavaScript のチャレンジを解けん。このまま本番にしたら、アプリのお客さんだけ 202 で門前払いだ。'),
        node('ウェブのお客さんを助けて、アプリのお客さんを見捨てるところでした。'),
        hakase('だから **除外 URI の正規表現** で外す。ここに一致した URI は challengeable-request にならず、チャレンジされない。既定の正規表現には、パスの途中の `/api` や、画像・CSS の拡張子が入っておる。'),
        node('うちのアプリは `/app/` だから、既定のままだと外れないんですね。'),
        hakase('そうだ。そして注意がもう一つ。照合する相手は「ホスト名 + パス」、たとえば `d111111abcdef8.cloudfront.net/app/v1/products` だ。だから `^/app/` と書くと…'),
        node('先頭がホスト名だから、一致しない！'),
        hakase('正解。AWS のドキュメントにも、わざわざ注意書きがある。`/app/` と書けば、パスのどこかに `/app/` があるものに一致する。'),
        node('除外したら、アプリのふりをした攻撃は素通りですか？'),
        hakase('チャレンジされなくなるだけで、DDoSRequests のブロックは効く。除外するのは、チャレンジを解けない正当なクライアントが使う URI だけにするのだ。'),
        hakase('それから大事な注意だ。対策を試したくなっても、本物の環境に自分で攻撃を再現してはいかん。AWS には **DDoS シミュレーションテストのポリシー** があって、承認されたパートナーを通すなど、決まった条件で行う。勝手にやれば、今度は君が攻撃者だ。'),
        node('Lesson 31 の負荷テストとは違って、気軽にはやれないんですね。今日の攻撃は、シミュレーターが用意してくれたものだから大丈夫、と。'),
        hakase('ありがたく使うのだ。請求書も来ないしな。'),
      ],
    },
    {
      type: 'exercise',
      title: 'アプリの API を除外して、保護を有効にする',
      objective: 'ルールグループを編集して、除外 URI の正規表現に `/app/` を加え、ルールアクションのオーバーライド (カウント) を外す。ブラウザでショップが開けることを確かめる',
      tasks: [
        { id: 'exempt', title: `ルール タブで \`${GROUP_RULE}\` を選んで 編集 → 除外 URI の正規表現に \`/app/\` を追加`, hint: '**正規表現を追加** で入力欄を増やし、`/app/` と入力します。`^/app/` は一致しません (照合する相手はホスト名から始まります)。', hotspotId: 'waf-antiddos-exempt', done: (c) => appExempt(c.env) },
        { id: 'enable', title: '同じ画面で すべてのルールアクションをオーバーライド → すべてのオーバーライドを削除 → 保存', hint: '3 つのルールのアクションが「オーバーライドしない」に戻れば、ルールグループ本来の Challenge / Block が効きます。', hotspotId: 'waf-antiddos-override-all', done: (c) => protecting(c.env) },
        { id: 'browse', title: 'CloudFront のドメイン名をブラウザで開き直す → 200', hint: '保存したら、パネル上部の「ブラウザ」タブで同じドメイン名を開き直します (「移動」をもう一度押す)。**通信経路の診断** の AWS WAF の行に、チャレンジがどうなったかが出ます。', done: shopOk },
      ],
      validate: (c) => {
        if (protecting(c.env) && !appExempt(c.env))
          return ng(hakase('保護は効いたが、アプリの `/app/v1/products` がチャレンジされて 202 で止まっておる。除外 URI の正規表現に `/app/` を加えるのだ。`^/app/` ではホスト名が先頭に来るから一致せんぞ。'));
        if (!protecting(c.env)) return ng(hakase('まだカウントのままか、チャレンジが無効だ。ルールを選んで **編集** し、**すべてのルールアクションをオーバーライド** で **すべてのオーバーライドを削除** を選んで保存するのだ。'));
        if (!shopOk(c)) return ng(hakase('設定はできた。パネル上部の「ブラウザ」タブでショップのドメイン名を開き直して、200 が返るのを確かめるのだ。'));
        return ok(
          node('200 が返りました！ 通信経路の診断に「ブラウザが JavaScript でチャレンジを解いて」と出ています。'),
          hakase('サンプルも見てみろ。198.18 の安物のボットは CHALLENGE で門前払い、HeadlessChrome の手の込んだボットは DDoSRequests で BLOCK、アプリは ALLOW だ。グラフの「チャレンジ」も跳ね上がっておる。'),
          node('お客さんは何も気付かずに買い物できて、ボットだけが締め出されるんですね。'),
          hakase('そうだ。攻撃はまだ続いておるが、サーバーに届くのはふだんの量だけになった。攻撃者の電気代だけが、むなしく積み上がっていくわけだ。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('5,000 台のボットネットが、1 台あたり 5 分に 120 回ずつ送ってくる。上限 1,000 回の、IP ごとのレートベースのルールで止まらないのはなぜかな？'),
      options: ['1 台ずつの回数が上限より少ないから', 'レートベースのルールは HTTP の中身を見られないから', 'CloudFront がキャッシュを返しているから'],
      answer: 0,
      explanation: [
        hakase('正解。レートベースのルールは送信元 IP ごとに数える。合計がどれだけ多くても、1 台ずつが上限より少なければ一致しない。'),
        hakase('だから分散型の攻撃には、全体をベースラインと比べる Anti-DDoS のような仕組みが要るのだ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('除外 URI の正規表現に `^/app/` と書いた。スマホアプリの `/app/v1/products` へのリクエストは、イベント中どうなるかな？'),
      options: ['チャレンジされる (照合する相手はホスト名 + パスなので一致しない)', 'チャレンジされない (除外される)', '必ずブロックされる'],
      answer: 0,
      explanation: [
        hakase('正解。照合するのは `ホスト名/app/v1/products` だから、先頭を `/` に固定した `^/app/` は一致しない。`/app/` と書くのだ。'),
        node('正規表現は、何と照合するかまで確かめないとだめなんですね。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('ブロックの感度を「低」にすると、ルール DDoSRequests はどのリクエストをブロックするかな？'),
      options: ['疑いが高い (high-suspicion) ものだけ', '疑いのあるもの (low / medium / high) すべて', '何もブロックしない'],
      answer: 0,
      explanation: [
        hakase('正解。感度が低いと、鈍感になって一番怪しいものにしか反応しない。「高」にすると、疑いが低いものまでブロックする。'),
        hakase('鈍感すぎれば攻撃が通り、敏感すぎればお客さんを巻き込む。サンプルのラベルを見ながら決めるのだ。'),
      ],
    },
  ],
};
