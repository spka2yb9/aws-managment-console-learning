// Lesson 43: Amazon GuardDuty. A High finding (instance credentials used from outside AWS) → read it → follow the
// stolen key in CloudTrail → revoke the role's sessions → find the SSRF + IMDSv1 cause → require IMDSv2 → verify 401 →
// archive / suppress the noise. The base (web app, admin-1, scanner-1, GuardDuty) is prepared by the scenario.
import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { metadataOptions, sessionsRevokedBefore } from '../sim/ext/credentials';
import { findingMatches, instanceDetails, suppressionRules, type Finding } from '../sim/ext/guardduty';
import { ADMIN_ROLE, ATTACKER_IP, FINDING_IDS, guardDutyEnv, STOLEN_KEY } from '../sim/ext/guardduty-scenario';
import type { AwsEnv } from '../sim/types';
import { instanceNamed, lastRun, visitedQuery } from './helpers';

export const CREDS_URL = `http://169.254.169.254/latest/meta-data/iam/security-credentials/${ADMIN_ROLE}`;
const CREDS_RE = /169\.254\.169\.254\/latest\/meta-data\/iam\/security-credentials\/admin-tool-role/;

const findingOf = (env: AwsEnv, id: string) => env.guardDuty?.findings.find((f) => f.id === id);
const archived = (env: AwsEnv, id: string) => !!findingOf(env, id)?.service.archived;

/** the stolen credentials no longer work: the role denies credentials issued before (at least) the attack */
export const sessionsRevoked = (env: AwsEnv) => {
  const f = findingOf(env, FINDING_IDS.exfiltration);
  return !!f && (sessionsRevokedBefore(env, ADMIN_ROLE) ?? 0) > Date.parse(f.service.eventLastSeen);
};

export const imdsV2Required = (env: AwsEnv) => {
  const i = instanceNamed(env, 'admin-1');
  return !!i && metadataOptions(i).httpTokens === 'required' && metadataOptions(i).httpEndpoint === 'enabled';
};

/** curl to the credentials path on admin-1 (newest) */
export const credsCurl = (c: TaskContext) => lastRun(c, 'admin-1', CREDS_RE);
export const sawCredentials = (c: TaskContext) => !!credsCurl(c)?.output.includes('"AccessKeyId"');
export const got401 = (c: TaskContext) => !!credsCurl(c)?.output.includes('401 - Unauthorized');
export const cliStillWorks = (c: TaskContext) => !!lastRun(c, 'admin-1', /sts get-caller-identity/)?.ok && imdsV2Required(c.env);

const openedEvent = (c: TaskContext, pick: (id: string) => boolean) => c.visited.some((v) => v.startsWith('/cloudtrail/events/view?') && pick(new URLSearchParams(v.split('?')[1]).get('id') ?? ''));
const attackerEvent = (c: TaskContext) => openedEvent(c, (id) => c.env.trailEvents.some((e) => e.eventId === id && e.sourceIPAddress === ATTACKER_IP));

/**
 * The suppression rule check: it must archive scanner-1's Portscan, but neither the High finding nor the same
 * Portscan coming from another instance (web-1 taken over would look exactly like that, same AMI too).
 */
export function suppressionProblem(env: AwsEnv): 'none' | 'misses' | 'high' | 'broad' | undefined {
  const d = env.guardDuty;
  const scan = d && findingOf(env, FINDING_IDS.portscan);
  const web1 = instanceNamed(env, 'web-1');
  if (!d || !scan || !web1) return 'none';
  const current = (f: Finding) => ({ ...f, service: { ...f.service, archived: false } });
  const fromWeb1: Finding = { ...scan, resource: { ...scan.resource, instanceDetails: instanceDetails(env, web1) } };
  const rules = suppressionRules(d);
  if (!rules.length) return 'none';
  if (rules.some((r) => findingMatches(current(findingOf(env, FINDING_IDS.exfiltration)!), r.criterion))) return 'high';
  if (rules.some((r) => findingMatches(current(fromWeb1), r.criterion))) return 'broad';
  if (!rules.some((r) => findingMatches(current(scan), r.criterion))) return 'misses';
  return undefined;
}

export const lesson43: Lesson = {
  id: 'guardduty',
  number: '43',
  title: 'Amazon GuardDuty',
  summary: '脅威の検出結果を読み、盗まれた認証情報を止め、IMDSv2 で再発を防ぐ',
  minutes: 25,
  startPath: '/console/home',
  scenario: () => guardDutyEnv(),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、大変です！ 朝来たら、GuardDuty から「重要度: 高」の通知が届いてました。'),
        hakase('ほう。それで君は、通知を見てすぐここへ来たのか。'),
        node('いえ、先にコーヒーを淹れてから来ました。'),
        hakase('泥棒が家の中を歩き回っておるかもしれんのに、優雅なことだ。'),
        node('えっ、泥棒なんですか!? ……そもそも、がーどでゅーてぃーって何でしたっけ。名前は聞いたことあるんですけど。'),
        hakase('**Amazon GuardDuty** は、AWS アカウントの中の怪しい動きを見張って知らせる、脅威検出のサービスだ。Guard (見張り) + Duty (任務)、つまり「見張り番」だな。'),
        node('見張り番。警備員さんを雇ってるみたいなものですか。'),
        hakase('24 時間休まず、文句も言わず、残業代も請求せん警備員だ。君も見習いたまえ。'),
        node('最後の 1 つだけは見習いたくないです。'),
        hakase('このアカウントでは、2 か月前から有効にしてある。見張り番が「高」と言うなら、何かが起きたと思って調べるのが筋だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('見張るって、どこを見てるんですか。サーバーに監視ソフトを入れた覚えはないんですけど。'),
        hakase('入れんでよい。GuardDuty は、AWS がもともと記録しておるログを読む。Lesson 26 の CloudTrail の管理イベント、VPC を流れる通信の記録 (**VPC フローログ**)、DNS の問い合わせの記録 (**DNS ログ**) だ。'),
        node('くらうどとれいるは、誰がいつ何をしたかの足跡でしたよね。'),
        hakase('そうだ。その足跡を、悪いことに使われた IP アドレスなどのリスト (**脅威インテリジェンス**) や、ふだんの使われ方を覚えた機械学習と照らし合わせる。おかしなものを見つけたら **検出結果** (finding) として報告するのだ。'),
        node('防犯カメラの映像を、警備員さんが手配写真と見比べてくれる感じですね。'),
        hakase('うむ。GuardDuty の本体は **ディテクター** といって、リージョンごとに 1 つ有効にする。東京で有効にしても、大阪は見張っておらん。'),
        node('じゃあ、使ってないリージョンは放っておいていいんですか？'),
        hakase('攻撃者は、君が使っておらんリージョンにこっそりサーバーを立てるのが大好きだ。全部のリージョンで有効にしておくのが鉄則だ。'),
        node('留守の部屋ほど泥棒に入られやすい、ってことですね。'),
        hakase('そして検出結果には **重要度** が付く。1.0〜10.0 の数字で、4 つのレベルに分かれておる。'),
      ],
    },
    {
      type: 'table',
      title: 'GuardDuty の重要度',
      columns: ['レベル', '値', '意味', '対応の目安'],
      rows: [
        ['重大 (Critical)', '9.0〜10.0', '攻撃が進行中で、被害が広がりつつある', 'すぐに対応する'],
        ['高 (High)', '7.0〜8.9', 'リソースが侵害され、悪用されている', 'すぐに対応する'],
        ['中 (Medium)', '4.0〜6.9', 'ふだんと違う、怪しい動きがある', 'なるべく早く調べる'],
        ['低 (Low)', '1.0〜3.9', '怪しい試みはあったが、被害には至っていない', '状況を確かめる'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('検出結果の **タイプ** は、決まった形の名前だ。今朝のはこれだ。`UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS`'),
        node('長っ！ 呪文ですか。'),
        hakase('区切りごとに読めば怖くない。`:` の前が **目的** (UnauthorizedAccess = 不正アクセス)、`/` の前が **狙われたものの種類** (IAMUser = IAM の認証情報)、最後が **何が起きたか** だ。'),
        node('いんすたんすくれでんしゃる……えくすふぃるとれーしょん？'),
        hakase('Instance Credential は「インスタンスの認証情報」、Exfiltration は「持ち出し」。OutsideAWS は「AWS の外で」。まとめると「インスタンス用の認証情報が持ち出され、AWS の外から使われた」だ。'),
        node('Lesson 22 でやった、ロールの一時的な認証情報のことですか？ EC2 だけが使える合鍵みたいな。'),
        hakase('そうだ。EC2 のために発行された合鍵が、AWS の外のパソコンから使われておる。'),
        node('合鍵が勝手に複製されて、知らない人が出入りしてるってことですよね。完全にホラーじゃないですか。'),
        hakase('ホラー映画なら、目をつぶっておれば終わる。こちらは目をつぶるほど被害が増える。まずは検出結果を開いて、**どの合鍵が・どこから・何に使われたか** を読むのだ。'),
        node('開いたら、どこを見ればいいんですか？'),
        hakase('「影響を受けるリソース」に狙われたもの、「アクション」に何をされたか、「**アクター**」に相手がどこから来たかが書いてある。actor は「行動した者」、つまり相手のことだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '検出結果を読む',
      objective: 'GuardDuty の **検出結果** で重要度「高」の検出結果を開き、どのリソースが・どこから・何をされたかを読む',
      tasks: [
        {
          id: 'open',
          title: '検索バーで `guardduty` → **検出結果** → 重要度「高」の検出結果のタイトルをクリック',
          hint: '重要度の列のバッジが「高」のものです。タイトルをクリックすると、一覧の下に詳細が開きます。「影響を受けるリソース」と「アクター」を読みます。',
          done: (c) => visitedQuery(c, '/guardduty/findings', { id: FINDING_IDS.exfiltration }),
        },
      ],
      validate: (c) =>
        visitedQuery(c, '/guardduty/findings', { id: FINDING_IDS.exfiltration })
          ? ok(
              node('開きました。リソースタイプは `AccessKey`、ユーザーネームは `admin-tool-role`。インスタンスのタグは……`Name: admin-1` です！'),
              hakase('社内の管理ツールが動いておるサーバーだな。アクターの IP アドレスは？'),
              node(`\`${ATTACKER_IP}\`、場所は Amsterdam, Netherlands、組織は Example VPS Hosting。海外から攻撃されてるんですか!?`),
              hakase('落ち着け。**VPS** は時間貸しの借り物サーバーだ。分かるのはそのサーバーの置き場所だけで、攻撃者の住所ではない。国名で犯人像を決めつけると、調査を間違えるぞ。'),
              node('アクションの API は `DescribeInstances`、カウントは 4。少なくとも 4 回は使われたってことか……。'),
            )
          : ng(hakase('重要度「高」の検出結果を開くのだ。検索バーに `guardduty` と入れて GuardDuty を開き、左のメニューの **検出結果** で、バッジが「高」の行のタイトルをクリックしたまえ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('4 回って言われても、何をされたのか気になります。'),
        hakase('そこで CloudTrail の出番だ。合鍵には番号が振ってある。検出結果の **アクセスキー ID** (`ASIA…`) がそれだ。'),
        node('えーしあ？ Lesson 26 で見た tanaka さんの CLI の操作は、アクセスキーが `AKIA…` でした。'),
        hakase('よく覚えておったな。`AKIA` は IAM ユーザーの長期のアクセスキー、`ASIA` はロールなどで発行される**一時的な**アクセスキーだ。'),
        node('頭の 4 文字で、正社員証か入館証か分かるみたいなものですね。'),
        hakase('……妙なたとえだが、まあよい。イベント履歴のルックアップ属性を「AWS アクセスキー」にして、この番号で絞れば、この合鍵で行われた操作が全部並ぶ。'),
        node('どこから使われたかも見られますか？'),
        hakase('イベントレコードの `sourceIPAddress` だ。admin-1 自身の IP アドレスと、さっきの攻撃者の IP アドレスが混ざっておるはずだ。同じ合鍵が 2 か所から使われておるのだからな。'),
      ],
    },
    {
      type: 'exercise',
      title: 'CloudTrail で足跡を追う',
      objective: `検出結果の **アクセスキー ID** で CloudTrail の **イベント履歴** を絞り込み、攻撃者の IP アドレス (\`${ATTACKER_IP}\`) からのイベントを開く`,
      tasks: [
        {
          id: 'lookup',
          title: 'CloudTrail → **イベント履歴** → ルックアップ属性「AWS アクセスキー」に `ASIA…` を入力して Enter',
          hint: '検出結果の「アクセスキー ID」はコピーボタンでコピーできます。値は完全一致です。',
          hotspotId: 'ct-lookup',
          done: (c) => visitedQuery(c, '/cloudtrail/events', { attr: 'AccessKeyId', value: STOLEN_KEY }),
        },
        {
          id: 'open',
          title: `送信元が \`${ATTACKER_IP}\` のイベントを開き、\`sourceIPAddress\` と \`userIdentity\` を読む`,
          hint: '一覧のイベント名をクリックすると、イベントレコード (JSON) が見られます。admin-1 の IP アドレスからのイベントと見比べます。',
          done: attackerEvent,
        },
      ],
      validate: (c) =>
        attackerEvent(c)
          ? ok(
              node(`\`${ATTACKER_IP}\` からは \`GetCallerIdentity\`、\`ListBuckets\`、\`GetBucketLocation\`、\`DescribeInstances\` の順です。最初に「自分は誰？」を確かめてますね。`),
              hakase('盗んだ鍵がどの家の鍵か、まず確かめたわけだ。それからバケットとサーバーの一覧を眺めておる。下見だな。'),
              node('`userIdentity` の中に `"ec2RoleDelivery": "1.0"` ってあります。'),
              hakase('それが手がかりだ。この合鍵は **IMDSv1** という古い方法で受け取られた、という印だ。あとで詳しくやる。それと、S3 のオブジェクトの読み取りは **データイベント** といって、イベント履歴には残らん。レポートの中身まで読まれたかどうかは、ここからは分からんのだ。'),
              node('「分かりません」って報告書に書くの、つらいですね……。'),
            )
          : ng(hakase(`攻撃者のイベントを開くのだ。イベント履歴でルックアップ属性を「AWS アクセスキー」にして検出結果のアクセスキー ID を貼り付け、送信元 IP アドレスが \`${ATTACKER_IP}\` のイベントをクリックしたまえ。`)),
    },
    {
      type: 'dialogue',
      lines: [
        node('とにかく、その合鍵を止めないと！ アクセスキーを削除しちゃえばいいんですよね？'),
        hakase('IAM ユーザーの長期のキーならそうする。だが一時的な認証情報には、削除ボタンがない。期限が来るまで勝手に生き続ける。'),
        node('じゃあ期限まで、指をくわえて見てるしかないんですか。'),
        hakase('そこで IAM のロールの画面にある **アクティブなセッションを取り消す** を使う。'),
        node('せっしょん？'),
        hakase('ロールを引き受けて一時的な認証情報をもらってから、期限が切れるまでのひと続きの利用のことだ。合鍵 1 本の「貸出期間」と思えばよい。取り消すと、ロールに **インラインポリシー** (そのロール専用に直接書き込むポリシー) が追加され、「この時刻より前に発行された認証情報には、何もさせない」と書かれる。'),
        node('発行された時刻で見分けるんですか。'),
        hakase('条件キー `aws:TokenIssueTime` で、認証情報の発行時刻を比べるのだ。効果は `Deny`。Lesson 23 でやったな。'),
        node('明示的な拒否は、どんな許可より強いんでしたよね。'),
        hakase('その通り。盗まれた合鍵は、取り消した瞬間から何もできなくなる。'),
        node('でも、admin-1 自身が持ってる合鍵も、同じころに発行されたものですよね？'),
        hakase('鋭いな。admin-1 の今の認証情報も道連れで拒否される。EC2 は認証情報を定期的に新しいものへ入れ替えるから、入れ替わればまた使える。それまで管理ツールがエラーを出すかもしれんが、泥棒に使われ続けるよりはましだ。'),
        hakase('こういう、被害が広がるのを先に止める対応を **封じ込め** という。原因を探すのはそのあとだ。火事のときは、出火原因を調べる前に火を消すだろう。'),
        node('火を消す前に原因を調べ始めたら、調べる家がなくなりますもんね。'),
      ],
    },
    {
      type: 'exercise',
      title: '盗まれた認証情報を使えなくする',
      objective: 'IAM ロール `admin-tool-role` の **セッションを取り消す** タブで、アクティブなセッションを取り消す',
      tasks: [
        {
          id: 'revoke',
          title: 'IAM → ロール → `admin-tool-role` → **セッションを取り消す** タブ → **アクティブなセッションを取り消す**',
          hint: '確認画面のチェックボックスにチェックを入れると、ボタンが押せるようになります。検出結果の「ユーザーネーム」のリンクからもロールを開けます。',
          hotspotId: 'iam-revoke-sessions',
          done: (c) => sessionsRevoked(c.env),
        },
      ],
      validate: (c) =>
        sessionsRevoked(c.env)
          ? ok(
              node('取り消しました。許可のタブに `AWSRevokeOlderSessions` というインラインポリシーが増えてます。`"Effect": "Deny"`、`"Action": ["*"]`、条件は `DateLessThan` と `aws:TokenIssueTime`。'),
              hakase('「今より前に発行された鍵では、何もさせない」。この 1 枚で、出回っておる合鍵がすべてただの金属片になった。'),
              node('金属片なら、せめて売れたらいいんですけどね。'),
            )
          : ng(hakase('まだ admin-tool-role のセッションが取り消されていない。IAM → ロール → `admin-tool-role` を開き、**セッションを取り消す** タブの **アクティブなセッションを取り消す** を押すのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        hakase('火は消えた。次は出火原因だ。そもそも合鍵は、どうやって盗まれたのか。'),
        node('admin-1 にログインされたんですか？'),
        hakase('その形跡はない。admin-1 の管理ツールには「URL を指定してプレビューする」機能があってな。指定された URL のページを、**サーバー自身が** 取りに行って画面に表示する。'),
        node('便利そうですけど……あっ。'),
        hakase(`気付いたか。そこに \`${CREDS_URL}\` と入れたら、どうなる。`),
        node('169.254.169.254 って、Lesson 22 で出てきた、インスタンスの中からだけ見える窓口ですよね。インスタンスメタデータ。'),
        hakase('そうだ。正式には **IMDS** (インスタンスメタデータサービス) という。ロールの一時的な認証情報も、ここから受け取る。サーバーがそれを取りに行って、親切に画面に表示してしまったわけだ。'),
        node('外の人が、サーバーに「代わりに取ってきて」って頼めちゃうってことですね。'),
        hakase('サーバーをだまして、サーバーの立場でリクエストを送らせる攻撃を **SSRF** (Server-Side Request Forgery) という。forgery は「偽造」だ。'),
        node('受付の人に「社長室の金庫の中身、ちょっと持ってきて」って頼んだら、本当に持ってきちゃった、みたいな。'),
        hakase('受付が素直すぎたのだ。君と同じでな。'),
        node('褒められてないことだけは分かります。'),
        hakase('では、攻撃者が見たものを自分の目で見る。EC2 Instance Connect で admin-1 に入り、プレビュー機能が送ったのと同じリクエストを `curl` で送ってみたまえ。`curl` は URL にリクエストを送って、返ってきた中身を表示するコマンドだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '攻撃者が見たものを見る',
      objective: '`admin-1` に EC2 Instance Connect で接続し、トークンを付けない `curl` で IMDS からロールの認証情報が取れてしまうことを確かめる',
      tasks: [
        {
          id: 'curl',
          title: `\`admin-1\` のターミナルで \`curl ${CREDS_URL}\``,
          hint: 'インスタンス一覧で `admin-1` を選び **接続** → EC2 Instance Connect の **接続**。`AccessKeyId` などが入った JSON が返れば完了です。',
          hotspotId: 'terminal-input',
          done: sawCredentials,
        },
      ],
      validate: (c) =>
        sawCredentials(c)
          ? ok(
              node('出ました。`"AccessKeyId"`、`"SecretAccessKey"`、`"Token"`……合鍵の一式が丸ごとです。'),
              hakase('プレビュー機能は、この文字列をそのまま画面に表示した。攻撃者はそれをコピーして、自分のパソコンの CLI に貼っただけだ。'),
              node('金庫の暗証番号を、受付の掲示板に貼り出してたようなものですね……。'),
            )
          : ng(hakase(`admin-1 の中で \`curl ${CREDS_URL}\` を打つのだ。インスタンス一覧で admin-1 を選んで **接続** → EC2 Instance Connect の **接続** でターミナルが開く。`)),
    },
    {
      type: 'dialogue',
      lines: [
        hakase('だが、窓口の側でも防げる。IMDS には 2 つの方式がある。**IMDSv1** は、GET で聞かれれば誰にでも答える。**IMDSv2** は、先に **セッショントークン** (しばらく使える整理券) をもらわないと答えない。'),
        node('整理券は、どうやってもらうんですか？'),
        hakase('`PUT` という種類のリクエスト (ふつうにページを取ってくるのが GET、何かを置くのが PUT だ) に、`X-aws-ec2-metadata-token-ttl-seconds` という **ヘッダー** (リクエストに付ける添え書き) を付けて送る。TTL は有効期間 (秒) のことだ。もらった整理券を、次の GET のヘッダー `X-aws-ec2-metadata-token` に付けるのだ。'),
        node('プレビュー機能は「この URL を GET してきて」しかできないから……整理券をもらえない！'),
        hakase('その通り。SSRF で送らせられるのは、たいてい添え書きなしの GET だけだ。IMDSv2 を **必須** にすれば、トークンなしの GET には `401 - Unauthorized` (認証されていない) が返る。'),
        node('でも、admin-1 の正規の管理ツールまで困りませんか？'),
        hakase('AWS の SDK や CLI は、自分で整理券をもらってから聞きに行く。だから正しく作られたアプリは何も変えなくてよい。困るのは、窓口を素手で叩くような作りのものだけだ。'),
        node('さっきの `"ec2RoleDelivery": "1.0"` は、整理券なしの v1 で取られた印だったんですね。'),
        hakase('冴えておるな。朝のコーヒーが、ようやく効いてきたか。v2 で受け取った認証情報なら `2.0` になる。設定は EC2 のインスタンスの **アクション** → **インスタンスの設定** → **インスタンスメタデータオプションを変更** だ。'),
      ],
    },
    {
      type: 'code',
      title: 'IMDSv1 と IMDSv2 のリクエスト (インスタンスの中で打つ)',
      language: 'bash',
      code: [
        '# IMDSv1: 添え書きなしの GET に答える (SSRF でも送れてしまう)',
        `curl ${CREDS_URL}`,
        '',
        '# IMDSv2: 先に PUT でセッショントークン (整理券) をもらう。TTL は秒 (最大 21600 = 6 時間)',
        'curl -X PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"',
        '',
        '# もらったトークンをヘッダーに付けて GET する。$( ) を使うと、トークンをもらうコマンドを 1 行に埋め込める',
        `curl -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 21600')" ${CREDS_URL}`,
      ].join('\n'),
    },
    {
      type: 'exercise',
      title: 'IMDSv2 を必須にする',
      objective: '`admin-1` のインスタンスメタデータオプションで **IMDSv2** を **必須** にする (インスタンスメタデータサービスは有効のまま)',
      tasks: [
        {
          id: 'imds',
          title: 'EC2 → インスタンス → `admin-1` → **アクション** → **インスタンスの設定** → **インスタンスメタデータオプションを変更** → IMDSv2「必須」→ **保存**',
          hint: '「インスタンスメタデータサービス」の「有効化」はチェックしたままにします。',
          hotspotId: 'ec2-imds-save',
          done: (c) => imdsV2Required(c.env),
        },
      ],
      validate: (c) => {
        const i = instanceNamed(c.env, 'admin-1');
        if (i && metadataOptions(i).httpEndpoint === 'disabled') return ng(hakase('待て、インスタンスメタデータサービスそのものを無効にしてはいかん。正規の管理ツールも認証情報を受け取れなくなる。「有効化」にチェックを入れたまま、IMDSv2 を「必須」にするのだ。'));
        if (!imdsV2Required(c.env)) return ng(hakase('まだ IMDSv2 が「オプション」のままだ。admin-1 を選んで **アクション** → **インスタンスの設定** → **インスタンスメタデータオプションを変更** で「必須」を選び、**保存** するのだ。'));
        return ok(node('保存しました。IMDSv2 が「必須」です。'), hakase('これで窓口は、整理券のない客を門前払いする。本当に門前払いされるか、確かめに行こう。'));
      },
    },
    {
      type: 'exercise',
      title: '穴がふさがったことを確かめる',
      objective: '`admin-1` で同じ `curl` を実行して `401 - Unauthorized` になることと、正規の AWS CLI (`aws sts get-caller-identity`) は今までどおり動くことを確かめる',
      tasks: [
        { id: 'curl401', title: `もう一度 \`curl ${CREDS_URL}\``, hint: 'ターミナルで ↑ キーを押すと、前に打ったコマンドを呼び出せます。', hotspotId: 'terminal-input', done: got401 },
        { id: 'sts', title: '`aws sts get-caller-identity`', hint: 'AWS CLI は自分で IMDSv2 のトークンをもらってから認証情報を受け取ります。`admin-tool-role` の名前が入った `Arn` が返れば完了です。', done: cliStillWorks },
      ],
      validate: (c) =>
        got401(c) && cliStillWorks(c)
          ? ok(
              node('同じ curl が `401 - Unauthorized` になりました！ なのに `aws sts get-caller-identity` は、ちゃんと `admin-tool-role` で答えてます。'),
              hakase('素手の GET は門前払い、整理券を持った正規の客は通す。これが IMDSv2 だ。'),
              node('プレビュー機能にあの URL を入れられても、もう 401 の画面が出るだけですね。'),
              hakase('攻撃者は 401 の画面を眺めて、さぞがっかりするだろう。いい気味だ。'),
            )
          : ng(hakase(`admin-1 の中で \`curl ${CREDS_URL}\` が 401 になること、\`aws sts get-caller-identity\` が成功することの両方を確かめるのだ。401 にならないなら、IMDSv2 が「必須」になっているか見直したまえ。`)),
    },
    {
      type: 'dialogue',
      lines: [
        node('これで一件落着ですね。……あれ、検出結果の一覧に、まだ `Recon:EC2/Portscan` と `Recon:EC2/PortProbeUnprotectedPort` が残ってます。'),
        hakase('Portscan は「EC2 インスタンスがポートスキャンをしておる」という報告だ。ポートスキャンは、どのポートが開いておるかを片っ端から試す偵察のことだ。'),
        node('やってるのは `scanner-1`……って、うちのセキュリティチームの脆弱性スキャナーじゃないですか。'),
        hakase('そうだ。毎週、社内のサーバーに弱点がないか、自分から叩いて調べておる。GuardDuty から見れば、やっておることは攻撃者と同じだ。だから毎週律儀に報告してくる。'),
        hakase('この手の報告に慣れると、本物の「高」まで「いつものやつ」と見落とすようになる。ワシの知り合いは、鳴りっぱなしの警報を放っておいて、本物の侵入を 3 か月見逃した。'),
        node('その人、今どうしてるんですか。'),
        hakase('「警報との付き合い方」という研修の講師をしておる。教材には一生困らんそうだ。'),
        hakase('そこで道具が 2 つある。**アーカイブ** は、確かめ終わった検出結果を「現在」の一覧から外して、しまっておくことだ。消えるわけではなく、90 日は残る。対応が済んだ今朝の「高」も、アーカイブしてよい。'),
        hakase('もう 1 つが **抑制ルール** だ。条件に一致する **新しい** 検出結果を、自動でアーカイブする。今ある検出結果は自動では片付かんから、そちらは手でアーカイブする。'),
        node('じゃあ条件は「タイプが Recon:EC2/Portscan なら全部」でいいですか？'),
        hakase('それでは、乗っ取られた web-1 が本物のポートスキャンを始めても見逃す。条件は **タイプ** と、**scanner-1 だと分かるもの** (インスタンス ID か、`Role: vuln-scanner` のタグ) の 2 つで絞るのだ。AMI の ID は、web-1 も同じ Amazon Linux だから絞れんぞ。'),
        node('PortProbeUnprotectedPort のほうはどうします？'),
        hakase('それは「admin-1 の 80 番が世界中に開いておって、悪い評判の IP アドレスから叩かれた」という報告だ。誤報ではないし、まだ直しておらん。だから「現在」に残しておく。'),
      ],
    },
    {
      type: 'exercise',
      title: '誤報を片付ける',
      objective: '対応が済んだ検出結果をアーカイブし、脆弱性スキャナー `scanner-1` の `Recon:EC2/Portscan` だけを自動でアーカイブする **抑制ルール** を作る',
      tasks: [
        {
          id: 'archive',
          title: '検出結果で `InstanceCredentialExfiltration.OutsideAWS` と `Recon:EC2/Portscan` を選び、**アクション** → **アーカイブ**',
          hint: 'チェックボックスで 2 つ選びます。アーカイブした検出結果は、一覧の上の「現在」を「アーカイブ済み」に切り替えると見られます。',
          hotspotId: 'gd-findings-actions',
          done: (c) => archived(c.env, FINDING_IDS.exfiltration) && archived(c.env, FINDING_IDS.portscan),
        },
        {
          id: 'rule',
          title: '**抑制ルール** → **抑制ルールを作成**: 検出結果タイプ = `Recon:EC2/Portscan` と、インスタンス ID = `scanner-1` の ID',
          hint: '「条件を追加」で 2 つ目のキー (インスタンス ID) を選びます。scanner-1 のインスタンス ID は、検出結果の詳細やインスタンス一覧でコピーできます。下の「一致する検出結果」が Portscan の 1 件だけになれば OK です。',
          hotspotId: 'gd-suppression-submit',
          done: (c) => suppressionProblem(c.env) === undefined,
        },
      ],
      validate: (c) => {
        const p = suppressionProblem(c.env);
        if (p === 'high') return ng(hakase('その抑制ルールは、今朝の「高」まで飲み込んでしまう。抑制ルールを削除して、条件を検出結果タイプ `Recon:EC2/Portscan` と scanner-1 に絞って作り直すのだ。'));
        if (p === 'broad') return ng(hakase('それでは、乗っ取られた別のインスタンスのポートスキャンまで黙って片付けてしまう。2 つ目の条件で scanner-1 だけに絞るのだ (インスタンス ID か、タグ値 `vuln-scanner`)。AMI の ID は web-1 も同じだから絞れんぞ。'));
        if (p === 'none' || p === 'misses') return ng(hakase('scanner-1 の Portscan に一致する抑制ルールがまだない。**抑制ルール** → **抑制ルールを作成** で、検出結果タイプ = `Recon:EC2/Portscan` と、インスタンス ID = scanner-1 の ID の 2 つの条件を入れるのだ。'));
        if (!archived(c.env, FINDING_IDS.exfiltration) || !archived(c.env, FINDING_IDS.portscan)) return ng(hakase('抑制ルールは新しい検出結果にしか効かん。今ある `InstanceCredentialExfiltration.OutsideAWS` と `Recon:EC2/Portscan` は、検出結果の一覧で選んで **アクション** → **アーカイブ** で片付けるのだ。'));
        if (archived(c.env, FINDING_IDS.portProbe)) return ng(hakase('`Recon:EC2/PortProbeUnprotectedPort` までアーカイブしてしまったな。admin-1 の 80 番はまだ直しておらん。「アーカイブ済み」で選んで **アクション** → **アーカイブ解除** で戻しておくのだ。'));
        return ok(
          node('アーカイブした 2 つが「現在」から消えて、抑制ルールもできました。一致する検出結果は scanner-1 の Portscan だけです。'),
          hakase('来週のスキャンの報告は、届いた瞬間に自動でアーカイブされる。誤報の騒音が消えれば、本物の警報がよく聞こえる。'),
          node('「現在」に残ってるのは、admin-1 の 80 番の「低」だけ。これが次の宿題ですね。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('今日の流れを振り返るぞ。GuardDuty の検出結果で異変に気付き、CloudTrail で足跡を確かめ、セッションを取り消して封じ込め、IMDSv2 で穴をふさぎ、誤報を抑制ルールで片付けた。'),
        node('見張り番が知らせて、記録で確かめて、止めて、直して、片付ける。'),
        hakase('残りの宿題は 2 つ。管理ツールのプレビュー機能そのものを直すこと (内部のアドレスには取りに行かせない)。それと admin-sg の 80 番を、社内からだけに絞ることだ。'),
        node('IMDSv2 で守れたんだから、もう直さなくてもいいんじゃ……。'),
        hakase('鍵を 1 つ増やしたからといって、開けっぱなしの窓を放っておく理由にはならん。守りは何重にも重ねるのだ。新しく作るインスタンスは、最初から IMDSv2 を必須にしておくことだな。'),
        node('今日いちばんの教訓は「通知を見たら、コーヒーより先に来る」ですね。'),
        hakase('それは教訓ではなく、社会人の常識だ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('問題だ。重要度 8.0 の検出結果は、どのレベルかな？'),
      options: ['中', '高', '重大'],
      answer: 1,
      explanation: [
        hakase('正解。7.0〜8.9 が「高」だ。リソースが侵害され、悪用されておる状態だな。'),
        node('9.0 以上の「重大」は、攻撃がもっと進んで被害が広がっている状態ですよね。'),
        hakase('そうだ。どのレベルでも、まず開いて読む。読まずにコーヒーを淹れるのは、どのレベルでも不正解だ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('SSRF でインスタンスのロールの認証情報を盗まれるのを防ぐ設定は、どれかな？'),
      options: ['セキュリティグループで 169.254.169.254 への通信を拒否する', 'インスタンスメタデータオプションで IMDSv2 を必須にする', 'GuardDuty で抑制ルールを作る'],
      answer: 1,
      explanation: [
        hakase('正解。169.254.169.254 はインスタンスの中だけで使うアドレスで、セキュリティグループはこの通信を見張っておらん。抑制ルールは報告を片付けるだけで、盗まれるのは止められん。'),
        node('窓口の側で「整理券なしはお断り」にするのが、いちばん効くんですね。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('抑制ルールを作ったあと、ルールに一致する新しい検出結果はどうなるかな？'),
      options: ['作られずに捨てられる', '作られるが、自動的にアーカイブされる', '重要度が「低」に下がる'],
      answer: 1,
      explanation: [
        hakase('正解。検出結果は作られるが、すぐにアーカイブされる。アーカイブ済みとして 90 日は残るし、通知を送る EventBridge や、次のレッスンでやる Security Hub には送られんから、騒がしくもならん。'),
        node('捨てるんじゃなくて、黙って棚にしまってくれるんですね。'),
      ],
    },
  ],
};
