/* Lesson 42 AWS WAF Anti-DDoS の CLI 版。ブラウザの代わりに curl で開く。
   curl は JavaScript を実行しないクライアント (CURL_CLIENT) なので、チャレンジされたパスでは 202 が返る (ブラウザは裏で解いて 200) */
import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { ANTI_DDOS, ANTI_DDOS_RULES, DEFAULT_EXEMPT } from '../../sim/ext/antiddos';
import { ACL_NAME, RATE_RULE } from '../../sim/ext/antiddos-scenario';
import type { AwsEnv } from '../../sim/types';
import { APP_PATH, appExempt, counting, GROUP_RULE, onTop, protecting, shopDomain, timedOutSeen, webAcl } from '../l42-anti-ddos';
import { param, ranAws } from './helpers';
import type { CliPatches } from './types';

const R = '--scope CLOUDFRONT --region us-east-1';
const aclId = (env: AwsEnv) => webAcl(env)?.arn.split('/').pop() ?? '<Id>';
const aclArn = (env: AwsEnv) => webAcl(env)?.arn ?? '<ウェブ ACL の ARN>';
const WINDOW = "--time-window StartTime=$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ),EndTime=$(date -u +%Y-%m-%dT%H:%M:%SZ) --max-items 100";
const samplesCmd = (c: TaskContext, metric: string, query: string) => `aws wafv2 get-sampled-requests --web-acl-arn ${aclArn(c.env)} --rule-metric-name ${metric} ${R} ${WINDOW} --query ${query}`;
const update = (c: TaskContext, file: string) =>
  `TOKEN=$(aws wafv2 get-web-acl --name ${ACL_NAME} ${R} --id ${aclId(c.env)} --query LockToken --output text); aws wafv2 update-web-acl --name ${ACL_NAME} ${R} --id ${aclId(c.env)} --default-action '{"Allow":{}}' --rules file://${file} --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=${ACL_NAME} --lock-token $TOKEN`;

/** the newest curl to the shop whose path is exactly `path` */
function curlTo(c: TaskContext, path: string) {
  return c.browser.find((r) => {
    try {
      const u = new URL(r.url);
      return u.hostname === shopDomain(c.env) && u.pathname === path;
    } catch {
      return false;
    }
  });
}

/* ---- 演習 1 ---- */
const sawRateRule = (c: TaskContext) => !!ranAws(c, 'wafv2 get-web-acl', (x) => x.output.includes('RateBasedStatement'));
const sawFlood = (c: TaskContext) => !!ranAws(c, 'wafv2 get-sampled-requests', (x) => param(x, 'rule-metric-name') === ACL_NAME && x.output.includes('198.18.'));
/* ---- 演習 2 ---- */
const sawGroup = (c: TaskContext) => !!ranAws(c, 'wafv2 describe-managed-rule-group', (x) => param(x, 'name') === ANTI_DDOS);
const sawLabels = (c: TaskContext) => counting(c.env) && !!ranAws(c, 'wafv2 get-sampled-requests', (x) => param(x, 'rule-metric-name') === GROUP_RULE && x.output.includes('anti-ddos:event-detected'));
const sawApp = (c: TaskContext) => counting(c.env) && !!ranAws(c, 'wafv2 get-sampled-requests', (x) => param(x, 'rule-metric-name') === GROUP_RULE && x.output.includes('/app/v1/') && x.output.includes('challengeable-request'));
/* ---- 演習 3 ---- */
const appOk = (c: TaskContext) => protecting(c.env) && appExempt(c.env) && curlTo(c, APP_PATH)?.status === 200;
const sawChallenges = (c: TaskContext) => protecting(c.env) && !!ranAws(c, 'wafv2 get-sampled-requests', (x) => param(x, 'rule-metric-name') === GROUP_RULE && x.output.includes('"CHALLENGE"'));

/* 学習者の PC に置くファイル: 博士が用意したカウント用と、同僚が作った本番用の下書き (除外 URI の正規表現に間違いがある) */
function rulesFile(on: boolean): string {
  const group = {
    Name: GROUP_RULE,
    Priority: 0,
    Statement: {
      ManagedRuleGroupStatement: {
        VendorName: 'AWS',
        Name: ANTI_DDOS,
        ManagedRuleGroupConfigs: [
          {
            AWSManagedRulesAntiDDoSRuleSet: {
              ClientSideActionConfig: { Challenge: { UsageOfAction: 'ENABLED', Sensitivity: 'HIGH', ExemptUriRegularExpressions: [{ RegexString: DEFAULT_EXEMPT }, ...(on ? [{ RegexString: '^/app/' }] : [])] } },
              SensitivityToBlock: 'LOW',
            },
          },
        ],
        ...(on ? {} : { RuleActionOverrides: ANTI_DDOS_RULES.map((r) => ({ Name: r.name, ActionToUse: { Count: {} } })) }),
      },
    },
    OverrideAction: { None: {} },
    VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: GROUP_RULE },
  };
  const rest = [
    { Name: RATE_RULE, Priority: 1, Statement: { RateBasedStatement: { Limit: 1000, EvaluationWindowSec: 300, AggregateKeyType: 'IP' } }, Action: { Block: {} }, VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: RATE_RULE } },
    { Name: 'AWS-AWSManagedRulesCommonRuleSet', Priority: 2, Statement: { ManagedRuleGroupStatement: { VendorName: 'AWS', Name: 'AWSManagedRulesCommonRuleSet' } }, OverrideAction: { None: {} }, VisibilityConfig: { SampledRequestsEnabled: true, CloudWatchMetricsEnabled: true, MetricName: 'AWS-AWSManagedRulesCommonRuleSet' } },
  ];
  return JSON.stringify([group, ...rest], null, 2) + '\n';
}

const patches: CliPatches = {
  'anti-ddos': {
    summary: '数千の IP からの L7 DDoS を、Anti-DDoS マネージドルールグループで受け止める。aws wafv2 update-web-acl でカウントで試し、get-sampled-requests でラベルを読み、アプリの API を除外してから有効にする',
    files: () => ({ 'antiddos-count.json': rulesFile(false), 'antiddos-on.json': rulesFile(true) }),
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          hakase('`webapp-acl` には、前の担当者が入れた **レートベースのルール** `rate-limit-per-ip` がある。'),
          node('れーとべーす？'),
          hakase('同じ送信元 IP から、決まった時間に何回来たかを数えて、上限を超えた IP を止めるルールだ。設定の JSON では `RateBasedStatement` と出る。`Limit` が上限の回数、`EvaluationWindowSec` が数える時間 (秒) だ。'),
          node('回転寿司の「お一人様 1,000 皿まで」みたいなものですね。'),
          hakase('1 人で 1,001 皿食う客は止められる。だが、5,000 人が 120 皿ずつ取っていったらどうなる？'),
          node('…上限には誰も引っかからないけど、お寿司は全部なくなります。'),
          hakase('そうだ。分散型の攻撃は、1 台あたりは控えめに送ってくる。IP ごとに数えるルールには引っかからん。'),
          node('ずるいなあ。'),
          hakase('ずるいのが攻撃者の仕事だ。まずは `curl` でショップの症状を見て、`aws wafv2 get-web-acl` でルールを、`aws wafv2 get-sampled-requests` で Lesson 38 の防犯カメラの録画を見るぞ。'),
          hakase('録画の `--time-window` には、`date` の出力を `$( )` で埋め込むと楽だ。`$(date -u -d \'10 minutes ago\' +%Y-%m-%dT%H:%M:%SZ)` で 10 分前の UTC の日時になる。`--rule-metric-name` をウェブ ACL 自身の名札 `webapp-acl` にすると、どのルールにも一致しなかったリクエストが見える。Lesson 38 でやったな。'),
        ],
      },
      3: {
        type: 'exercise',
        title: '症状と、効いていないルールを確かめる',
        objective: '`curl -i` で CloudFront のドメイン名を開いて 504 を確かめ、`aws wafv2 get-web-acl` と `aws wafv2 get-sampled-requests` で、レートベースのルールが攻撃を止めていないことを確かめる',
        tasks: [
          { id: 'browse', title: '`curl -i https://<ドメイン名>/` → 504', hint: "ドメイン名は `aws cloudfront list-distributions --query 'DistributionList.Items[0].DomainName' --output text` で調べます。", command: (c) => `curl -i https://${shopDomain(c.env)}/`, done: timedOutSeen },
          {
            id: 'rules',
            title: `\`aws wafv2 get-web-acl\` で \`${RATE_RULE}\` の \`RateBasedStatement\` を見る`,
            hint: `\`--name ${ACL_NAME} --scope CLOUDFRONT --id <Id> --region us-east-1\`。\`Id\` は \`aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1\` に出ています。\`--query 'WebACL.Rules[].[Name,Priority,Statement]'\` で絞ると読みやすくなります。`,
            command: (c) => `aws wafv2 get-web-acl --name ${ACL_NAME} ${R} --id ${aclId(c.env)} --query 'WebACL.Rules[].[Name,Priority,Statement]'`,
            done: sawRateRule,
          },
          {
            id: 'samples',
            title: '`get-sampled-requests` の `--rule-metric-name webapp-acl` で、デフォルトアクションで通ったリクエストを見る',
            hint: "`--web-acl-arn` は `aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --query 'WebACLs[0].ARN' --output text`。`--query 'SampledRequests[].[Request.ClientIP,Action,Request.URI]' --output text` で 1 行 1 件にすると見やすくなります。",
            command: (c) => samplesCmd(c, ACL_NAME, "'SampledRequests[].[Request.ClientIP,Action,Request.URI]' --output text"),
            done: sawFlood,
          },
        ],
        validate: (c) =>
          timedOutSeen(c) && sawRateRule(c) && sawFlood(c)
            ? ok(
                node('送信元 IP は、ほとんどが 198.18 で始まるのに、同じ IP がほとんどありません。どれも `ALLOW` で、`rate-limit-per-ip` の `Limit` は 1000、`EvaluationWindowSec` は 300 です。'),
                hakase('ボットネットはおよそ 5,000 台、1 台あたり 1 秒に 0.4 回、5 分で 120 回だ。上限 1,000 回の 8 分の 1 にもならん。ショップ全体では、ふだんの 20 倍が押し寄せておる。'),
                node('寿司 120 皿の客が 5,000 人…お店がつぶれるわけだ。'),
                hakase('つぶれかけておるのは、うちのショップだ。'),
              )
            : ng(hakase('`curl -i https://<ドメイン名>/` で 504 を確かめ、`aws wafv2 get-web-acl` でルールの `Statement` を、`get-sampled-requests --rule-metric-name webapp-acl` で通ったリクエストを見るのだ。`--scope CLOUDFRONT --region us-east-1` を忘れるな。')),
      },
      10: {
        type: 'dialogue',
        lines: [
          hakase('では入れる。が、Lesson 38 のクイズを覚えておるか。新しいルールを本番に入れるときは？'),
          node('まず Count で入れて、サンプルで誤検知がないか見てから本番にする、でしたよね。'),
          hakase('今回も同じだ。中の 3 つのルールのアクションを、すべて **カウント** に **オーバーライド** する。オーバーライドは「上書き」、ルールのアクションを今だけ差し替えることだ。JSON では `RuleActionOverrides` に、ルール名と `"ActionToUse": {"Count": {}}` を並べる。'),
          node('攻撃の真っ最中に、カウントなんて悠長なことをやってていいんですか？'),
          hakase('気持ちは分かる。だが、焦って入れたルールで社内を締め出したのが Lesson 38 の誰かさんだ。数分の確認でお客さんを巻き込む事故を防げるなら、安いものだ。'),
          hakase('置き場所は、Allow のルールの後で、ほかのルールより前。今の `webapp-acl` には Allow のルールが無いから、**一番上**、`Priority` は 0 だ。できるだけ多くのトラフィックを見せて、ベースラインを正確にするためだ。同じ理由で、対象を絞り込む **スコープダウンステートメント** (`ScopeDownStatement`) も付けるなと、AWS は言っておる。'),
          node('一番上ですね。社長の席だ。'),
          hakase('偉いのではない。最初に全員と顔を合わせる受付係だ。'),
          hakase('入れるのは `aws wafv2 update-web-acl` だ。気をつけろ、これは足し算ではなく **丸ごと差し替え** だ。`--rules` に、今あるルールも含めた全部を書く。書き忘れたルールは消える。'),
          node('IP セットの `update-ip-set` と同じですね。'),
          hakase('うむ。`--lock-token` も同じで、`get-web-acl` の `LockToken` を渡す。`--default-action` と `--visibility-config` (メトリクスとサンプルの設定) も必須だ。ルールの全部は `antiddos-count.json` に書いておいた。設定の `ManagedRuleGroupConfigs` が感度や除外 URI、`RuleActionOverrides` がカウントへの上書きだ。`cat` で読んでから使うのだ。'),
        ],
      },
      11: {
        type: 'exercise',
        title: 'Anti-DDoS をカウントで追加して、ラベルを読む',
        objective: `\`${ANTI_DDOS}\` の中身を確かめ、\`antiddos-count.json\` (すべてのルールをカウントにオーバーライドし、優先度 0 に置いたもの) を \`aws wafv2 update-web-acl\` で適用して、\`get-sampled-requests\` でラベルを読む`,
        tasks: [
          {
            id: 'describe',
            title: '`aws wafv2 describe-managed-rule-group` で、ルールグループの中のルールとラベルを見る',
            hint: `\`--vendor-name AWS --name ${ANTI_DDOS} --scope CLOUDFRONT --region us-east-1\`。\`Rules\` がルールと既定のアクション、\`AvailableLabels\` が付けるラベルです。\`Capacity\` は WCU (ウェブ ACL の容量の単位) です。`,
            command: `aws wafv2 describe-managed-rule-group --vendor-name AWS --name ${ANTI_DDOS} ${R}`,
            done: (c) => sawGroup(c) || counting(c.env),
          },
          {
            id: 'apply',
            title: '`antiddos-count.json` を `aws wafv2 update-web-acl` で適用する',
            hint: "`cat antiddos-count.json` で中身を確かめてから、`TOKEN=$(aws wafv2 get-web-acl ... --query LockToken --output text)` で LockToken を変数に入れ、`update-web-acl` に `--rules file://antiddos-count.json --default-action '{\"Allow\":{}}' --visibility-config SampledRequestsEnabled=true,CloudWatchMetricsEnabled=true,MetricName=webapp-acl --lock-token $TOKEN` を付けます。",
            command: (c) => update(c, 'antiddos-count.json'),
            done: (c) => counting(c.env) && onTop(c.env),
          },
          {
            id: 'labels',
            title: `少し待ってから、\`--rule-metric-name ${GROUP_RULE}\` の録画でラベルを見る`,
            hint: "追加したあとのリクエストが溜まるまで `sleep 5` で待ちます。`--query 'SampledRequests[:3].{IP: Request.ClientIP, Rule: RuleNameWithinRuleGroup, Overridden: OverriddenAction, Labels: Labels[].Name}'` で、新しい 3 件のラベルを見ます。",
            command: (c) => `sleep 5; ${samplesCmd(c, GROUP_RULE, "'SampledRequests[:3].{IP: Request.ClientIP, Rule: RuleNameWithinRuleGroup, Overridden: OverriddenAction, Labels: Labels[].Name}'")}`,
            done: sawLabels,
          },
          {
            id: 'app',
            title: '同じ録画から、User-Agent が `webapp-shop-app` のリクエストだけを取り出す',
            hint: "ヘッダーの 2 つ目 (`Request.Headers[1]`) が User-Agent です。`--query \"SampledRequests[?starts_with(Request.Headers[1].Value, 'webapp-shop-app')].{UA: Request.Headers[1].Value, URI: Request.URI, Rule: RuleNameWithinRuleGroup, Labels: Labels[].Name}\"` のように `[? ]` で絞り込みます。",
            command: (c) => samplesCmd(c, GROUP_RULE, "\"SampledRequests[?starts_with(Request.Headers[1].Value, 'webapp-shop-app')].{UA: Request.Headers[1].Value, URI: Request.URI, Rule: RuleNameWithinRuleGroup, Overridden: OverriddenAction, Labels: Labels[].Name}\""),
            done: sawApp,
          },
        ],
        validate: (c) => {
          if (!counting(c.env)) return ng(hakase(groupRuleMissing(c.env) ? '`update-web-acl` がまだだ。`antiddos-count.json` を `--rules file://antiddos-count.json` で渡し、`--lock-token` に `get-web-acl` の `LockToken` を渡すのだ。' : 'カウントになっておらん。`RuleActionOverrides` に 3 つのルールすべてを `{"Count": {}}` で並べた `antiddos-count.json` を、もう一度 `update-web-acl` で適用するのだ。'));
          if (!onTop(c.env)) return ng(hakase(`\`${GROUP_RULE}\` が一番上にない。\`Priority\` を 0 にして、ほかのルールを 1、2 にずらすのだ。`));
          if (!sawLabels(c) || !sawApp(c)) return ng(hakase(`\`get-sampled-requests --rule-metric-name ${GROUP_RULE}\` で、新しいリクエストの \`Labels\` を読むのだ。それから \`[?starts_with(Request.Headers[1].Value, 'webapp-shop-app')]\` で、アプリのリクエストだけを取り出せ。まだ出てこなければ、少し待ってからもう一度だ。`));
          return ok(
            node('198.18 のリクエストには `ddos-request` と `high-suspicion-ddos-request` が付いています。`Action` は全部 `COUNT` で、`OverriddenAction` に本当なら何をしたかが出ています。'),
            hakase('止めずに、ラベルと「本番ならこうした」だけを記録しておるわけだ。'),
            node('アプリのリクエストは、`/app/v1/products` に `challengeable-request` が付いて、`RuleNameWithinRuleGroup` が `ChallengeAllDuringEvent`、`OverriddenAction` が `CHALLENGE` です。'),
            hakase('よく見つけた。それが今日いちばんの落とし穴だ。'),
          );
        },
      },
      12: {
        type: 'dialogue',
        lines: [
          hakase('`webapp-shop-app` は、うちのスマホアプリだ。アプリの HTTP クライアントはブラウザではないから、JavaScript のチャレンジを解けん。このまま本番にしたら、アプリのお客さんだけ 202 で門前払いだ。'),
          node('ウェブのお客さんを助けて、アプリのお客さんを見捨てるところでした。'),
          hakase('ついでに言うと、`curl` も JavaScript を実行せん。本物の環境でイベント中に、チャレンジされるページを `curl` で開くと、ブラウザなら通れるのに 202 と `x-amzn-waf-action: challenge` が返る。監視の死活チェックを `curl` で書いている会社では、ここで「障害だ！」と騒ぎになる。'),
          node('攻撃が止まった瞬間に、監視が鳴りだすんですか。皮肉ですね。'),
          hakase('だから **除外 URI の正規表現** (`ExemptUriRegularExpressions`) で外す。ここに一致した URI は challengeable-request にならず、チャレンジされない。既定の正規表現には、パスの途中の `/api` や、画像・CSS の拡張子が入っておる。'),
          node('うちのアプリは `/app/` だから、既定のままだと外れないんですね。'),
          hakase('そうだ。そして注意がもう一つ。照合する相手は「ホスト名 + パス」、たとえば `d111111abcdef8.cloudfront.net/app/v1/products` だ。だから `^/app/` と書くと…'),
          node('先頭がホスト名だから、一致しない！'),
          hakase('正解。AWS のドキュメントにも、わざわざ注意書きがある。`/app/` と書けば、パスのどこかに `/app/` があるものに一致する。'),
          hakase('同僚が本番用のファイル `antiddos-on.json` を作ってくれたが…`grep RegexString antiddos-on.json` で見てみろ。'),
          node('`"^/app/"`…ああっ、まさに今の落とし穴に落ちてます！'),
          hakase('この端末にはエディタが無いから、Lesson 36 のように `sed` で直すのだ。それから、対策を試したくなっても、本物の環境に自分で攻撃を再現してはいかん。AWS には **DDoS シミュレーションテストのポリシー** があって、承認されたパートナーを通すなど、決まった条件で行う。勝手にやれば、今度は君が攻撃者だ。'),
          node('Lesson 31 の `hey` の負荷テストとは違って、気軽にはやれないんですね。今日の攻撃は、シミュレーターが用意してくれたものだから大丈夫、と。'),
          hakase('ありがたく使うのだ。請求書も来ないしな。'),
        ],
      },
      13: {
        type: 'exercise',
        title: 'アプリの API を除外して、保護を有効にする',
        objective: '`antiddos-on.json` の除外 URI の正規表現 `^/app/` を `/app/` に直して `update-web-acl` で適用し、`curl` でアプリの API が通ること、録画でボットがチャレンジされていることを確かめる',
        tasks: [
          {
            id: 'apply',
            title: '`sed` で `antiddos-on.json` の `"^/app/"` を `"/app/"` に直し、`update-web-acl` で適用する',
            hint: "`sed -i 's#\"\\^/app/\"#\"/app/\"#' antiddos-on.json` で置き換えます (`\\^` は「^ という文字そのもの」)。`grep RegexString antiddos-on.json` で確かめてから、演習 2 と同じ `update-web-acl` を `--rules file://antiddos-on.json` で打ちます。LockToken は取り直します。",
            command: (c) => `sed -i 's#"\\^/app/"#"/app/"#' antiddos-on.json; grep RegexString antiddos-on.json; ${update(c, 'antiddos-on.json')}`,
            done: (c) => protecting(c.env) && appExempt(c.env),
          },
          {
            id: 'challenge',
            title: '`curl -i https://<ドメイン名>/` → 202 (チャレンジ)',
            hint: 'curl は JavaScript を実行しないので、チャレンジを解けません。ヘッダーの `x-amzn-waf-action: challenge` も見てみます。ブラウザなら裏で解いて、そのまま 200 になります。',
            command: (c) => `curl -i https://${shopDomain(c.env)}/`,
            done: (c) => protecting(c.env) && curlTo(c, '/')?.status === 202,
          },
          { id: 'app', title: `\`curl -i https://<ドメイン名>${APP_PATH}\` → 200`, hint: 'アプリの API は除外 URI に一致するので、JavaScript を実行しない curl でもチャレンジされません。', command: (c) => `curl -i https://${shopDomain(c.env)}${APP_PATH}`, done: appOk },
          {
            id: 'samples',
            title: `\`--rule-metric-name ${GROUP_RULE}\` の録画で、ボットが \`CHALLENGE\` されているのを見る`,
            hint: "`--query 'SampledRequests[:5].[Request.ClientIP,Action,RuleNameWithinRuleGroup]'` で新しい 5 件を見ます。HeadlessChrome のボットは `DDoSRequests` で `BLOCK` されます。",
            command: (c) => samplesCmd(c, GROUP_RULE, "'SampledRequests[:5].[Request.ClientIP,Action,RuleNameWithinRuleGroup]'"),
            done: sawChallenges,
          },
        ],
        validate: (c) => {
          if (protecting(c.env) && !appExempt(c.env)) return ng(hakase('保護は効いたが、アプリの `/app/v1/products` がチャレンジされて 202 で止まっておる。`^/app/` はホスト名が先頭に来るから一致せん。`sed` で `/app/` に直して、もう一度 `update-web-acl` だ。'));
          if (!protecting(c.env)) return ng(hakase('まだカウントのままだ。`antiddos-on.json` には `RuleActionOverrides` が無い。`sed` で直してから `update-web-acl --rules file://antiddos-on.json` で適用するのだ。'));
          if (!appOk(c) || !sawChallenges(c)) return ng(hakase(`設定はできた。\`curl -i\` でアプリの \`${APP_PATH}\` を開き、\`get-sampled-requests\` で \`CHALLENGE\` を確かめるのだ。`));
          return ok(
            node(`アプリの \`${APP_PATH}\` は、JavaScript を実行しない curl でも 200 です。除外 URI の正規表現が効いて、チャレンジされていません。`),
            hakase('お客さんのブラウザは裏でチャレンジを解いて 200 だ。録画を見ろ。198.18 の安物のボットは CHALLENGE で門前払い、HeadlessChrome の手の込んだボットは DDoSRequests で BLOCK だ。'),
            node('お客さんは何も気付かずに買い物できて、ボットだけが締め出されるんですね。'),
            hakase('そうだ。攻撃はまだ続いておるが、サーバーに届くのはふだんの量だけになった。攻撃者の電気代だけが、むなしく積み上がっていくわけだ。'),
          );
        },
      },
    },
  },
};

const groupRuleMissing = (env: AwsEnv) => !webAcl(env)?.rules.some((r) => r.statement.kind === 'managed' && r.statement.name === ANTI_DDOS);

export default patches;
