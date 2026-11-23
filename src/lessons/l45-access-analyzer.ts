// 拡張機能のコース: IAM Access Analyzer (外部アクセスと未使用のアクセス)
import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { analyzersOf, matchesFilter, type Analyzer, type Finding } from '../sim/ext/accessanalyzer';
import { accessAnalyzerEnv, EC2_READONLY, EXCHANGE_BUCKET, EXPORTS_BUCKET, PARTNER_ACCOUNT, PARTNER_ROLE, VENDOR_ACCOUNT, VENDOR_ROLE } from '../sim/ext/accessanalyzer-scenario';
import { isPolicyPublic } from '../sim/s3';
import type { AwsEnv } from '../sim/types';
import { bucketNamed, visited } from './helpers';

/* ---- shared with the CLI version (src/lessons/cli/l45-access-analyzer.ts) ---- */
export const EXPORTS_ARN = `arn:aws:s3:::${EXPORTS_BUCKET}`;
export const EXCHANGE_ARN = `arn:aws:s3:::${EXCHANGE_BUCKET}`;
const roleArn = (env: AwsEnv, name: string) => `arn:aws:iam::${env.accountId}:role/${name}`;
export const externalAnalyzer = (env: AwsEnv): Analyzer | undefined => analyzersOf(env).find((a) => a.type === 'ACCOUNT');
export const unusedAnalyzer = (env: AwsEnv): Analyzer | undefined => analyzersOf(env).find((a) => a.type === 'ACCOUNT_UNUSED_ACCESS');
const findingsOf = (a: Analyzer | undefined, resource: string) => a?.findings.filter((f) => f.resource === resource) ?? [];
/** the newest finding of the resource (a fixed and re-shared resource has an older resolved one) */
export const findingOf = (a: Analyzer | undefined, resource: string): Finding | undefined => findingsOf(a, resource).at(-1);
export const exportsFinding = (env: AwsEnv) => findingOf(externalAnalyzer(env), EXPORTS_ARN);
export const batchFinding = (env: AwsEnv) => unusedAnalyzer(env)?.findings.find((f) => f.resource === roleArn(env, 'batch-role') && f.findingType === 'UnusedPermission');
export const vendorUnusedFinding = (env: AwsEnv) => unusedAnalyzer(env)?.findings.find((f) => f.resource === roleArn(env, VENDOR_ROLE) && f.findingType === 'UnusedIAMRole');
const partnerResources = (env: AwsEnv) => [EXCHANGE_ARN, roleArn(env, PARTNER_ROLE)];
const otherResources = (env: AwsEnv) => [EXPORTS_ARN, roleArn(env, VENDOR_ROLE)];

/** an archive rule of the external analyzer that matches both partner findings */
export function partnerRule(env: AwsEnv) {
  const a = externalAnalyzer(env);
  const partner = partnerResources(env).map((r) => findingOf(a, r));
  if (!a || partner.some((f) => !f)) return undefined;
  return a.archiveRules.find((r) => partner.every((f) => matchesFilter(f!, r.filter)));
}
/** the rule also hides findings that are not the partner's */
export const ruleTooBroad = (env: AwsEnv) => {
  const r = partnerRule(env);
  return !!r && otherResources(env).some((res) => findingsOf(externalAnalyzer(env), res).some((f) => matchesFilter(f, r.filter)));
};
const isOnly = (a: Analyzer | undefined, resource: string, status: Finding['status']) => {
  const fs = findingsOf(a, resource);
  return fs.some((f) => f.status === status) && fs.every((f) => f.status === status || f.status === 'RESOLVED');
};
export const partnerArchived = (env: AwsEnv) => partnerResources(env).every((r) => isOnly(externalAnalyzer(env), r, 'ARCHIVED'));
/** a finding that is not the partner's is archived (by a broad rule or by hand) */
export const wrongArchived = (env: AwsEnv) => otherResources(env).some((r) => findingsOf(externalAnalyzer(env), r).some((f) => f.status === 'ARCHIVED'));
export const exportsPublic = (env: AwsEnv) => isPolicyPublic(bucketNamed(env, EXPORTS_BUCKET)?.policy);
export const exportsBpaOn = (env: AwsEnv) => Object.values(bucketNamed(env, EXPORTS_BUCKET)?.blockPublicAccess ?? { x: false }).every(Boolean);
export const exportsResolved = (env: AwsEnv) => {
  const fs = findingsOf(externalAnalyzer(env), EXPORTS_ARN);
  return fs.length > 0 && fs.every((f) => f.status === 'RESOLVED');
};
export const partnerStillShared = (env: AwsEnv) => !!bucketNamed(env, EXCHANGE_BUCKET)?.policy && env.iamRoles.some((r) => r.roleName === PARTNER_ROLE);
export const vendorGone = (env: AwsEnv) => !env.iamRoles.some((r) => r.roleName === VENDOR_ROLE);
const batchRole = (env: AwsEnv) => env.iamRoles.find((r) => r.roleName === 'batch-role');
export const ec2Detached = (env: AwsEnv) => !!batchRole(env) && !batchRole(env)!.attachedPolicyArns.includes(EC2_READONLY);
export const s3Kept = (env: AwsEnv) => !!batchRole(env)?.attachedPolicyArns.some((a) => a.endsWith(':policy/batch-s3-read'));

/* ---- console ---- */
const viewed = (c: TaskContext, kind: 'findings' | 'unused', f: Finding | undefined) => !!f && visited(c, new RegExp(`^/iam/access-analyzer/${kind}/view\\?.*id=${f.id}`));

export const lesson45: Lesson = {
  id: 'access-analyzer',
  number: '45',
  title: 'IAM Access Analyzer',
  summary: 'パートナー連携の前に、社外に開いているリソースと使われていない権限を棚卸しする',
  minutes: 25,
  startPath: '/iam/home',
  scenario: accessAnalyzerEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、来月から配送会社の「はやて物流」さんとシステムをつなぎます。先方のセキュリティ担当から質問票が届きました。'),
        hakase('ほう。なんと書いてある？'),
        node('「御社の AWS で、社外からアクセスできるものをすべて挙げてください」です。'),
        hakase('棚卸しだな。で、君の答えは？'),
        node('「はやて物流さん用のバケットが 1 つだけです」と書こうかと。'),
        hakase('根拠は？'),
        node('僕の記憶です。'),
        hakase('記憶は根拠にならん。障害報告書に「たぶん大丈夫だと思っていました」と書いて通った者を、ワシは見たことがない。'),
        node('書いたことがあるような口ぶりですね。'),
        hakase('……このアカウントには、1 年分の「ちょっとだけ」が積もっておる。ちょっとだけ公開する、ちょっとだけ他社に貸す、ちょっとだけ権限を足す。'),
        node('ちょっとだけが積もると？'),
        hakase('雪崩になる。そこで今日は **IAM Access Analyzer** に数えさせる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('あいあむ あくせす あならいざー？'),
        hakase('analyzer は「分析するもの」だ。バケットポリシーやロールの信頼ポリシーを読んで、「社外の誰が、何をできるか」を洗い出す IAM の機能だ。'),
        node('ポリシーなら、僕が全部読めば済むんじゃ……'),
        hakase('人間は読み飛ばす。特に金曜の夕方はな。Access Analyzer は**自動推論**という数学の手法で、ポリシーが許すアクセスをもれなく調べる。'),
        node('数学で？ 実際にアクセスして試すんじゃないんですか？'),
        hakase('試すだけでは、試さなかった道が分からん。ポリシーを数式に直して、「外から入れる道があるか」を証明するのだ。'),
        node('証明……高校以来の単語です。'),
        hakase('安心したまえ。証明するのは AWS で、君は結果を読むだけだ。1 件 1 件の報告を**検出結果** (finding) という。'),
        node('けんしゅつけっか。「このバケットに、この相手が、この操作をできる」みたいな報告ですか？'),
        hakase('そのとおりだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('で、どこからが「外」なんですか？'),
        hakase('それを決めるのが**信頼ゾーン** (zone of trust) だ。信頼ゾーンを「現在のアカウント」にすると、このアカウント以外はすべて外部になる。'),
        node('Lesson 40 の Organizations みたいに、組織全体を信頼ゾーンにもできるんですか？'),
        hakase('組織の管理アカウントで作ればできる。そのときは組織の外だけが外部だ。今日は「現在のアカウント」でいく。はやて物流は、どちらにしても外部だからな。'),
        node('Lesson 27 の AWS Config にも `s3-bucket-public-read-prohibited` というルールがありましたよね。あれとは何が違うんですか？'),
        hakase('Config は「設定が決めたルールに合っているか」を見る。Access Analyzer は「実際に外部の誰が入れるか」を見る。'),
        node('公開はしていなくて、他社のアカウントにだけ貸していたら？'),
        hakase('公開読み取りを禁止するルールには引っかからん。Access Analyzer なら「アカウント 999988887777 が読める」と報告する。'),
        node('他社に貸しているものまで出てくるんですね。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('見つかったら、全部消すんですか？'),
        hakase('消したら、はやて物流との連携まで止まる。1 件ずつ判断するのだ。意図した共有なら**アーカイブ**、意図しない共有なら**ポリシーを直す**。'),
        node('あーかいぶ？ ゴミ箱に入れるんですか？'),
        hakase('捨てはせん。「確認済み、問題なし」の棚に移すだけだ。アクセスはできるまま残る。'),
        node('直したほうは？'),
        hakase('ポリシーを直すと、次の分析で**解決済み**になる。もうそのアクセスはできない、という印だ。'),
        node('アクティブ、アーカイブ済み、解決済み。表にまとめておきます。'),
        hakase('うむ。まとめた表をなくすまでが君の仕事だからな。'),
        node('なくす前提で話さないでください。'),
      ],
    },
    {
      type: 'table',
      title: '検出結果のステータス',
      columns: ['ステータス', '意味', 'アクセス'],
      rows: [
        ['アクティブ (ACTIVE)', 'まだ誰も確かめていない。外部からアクセスできる', 'できる'],
        ['アーカイブ済み (ARCHIVED)', '意図した共有として確認済み', 'できる (そのまま)'],
        ['解決済み (RESOLVED)', 'ポリシーを直したので、分析し直したらアクセスがなくなっていた', 'できない'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('よし、さっそく使います！ どこにあるんですか？'),
        hakase('IAM の左のメニューの「アクセスレポート」の下だ。分析を始めるには、まず**アナライザー**を作る。「アナライザーの設定」か、「リソース分析」の画面の**アナライザーを作成**から作れる。'),
        node('アナライザーって、分析係みたいなものですか？'),
        hakase('うむ。今日は「リソース分析 - 外部アクセス」の分析係を 1 人雇う。外部アクセスの分析は無料だ。'),
        node('無料で雇えるなんて。僕もそういう扱いですか？'),
        hakase('君には給料が出ておる。成果が出ておるかは別の話だがな。'),
        node('…………'),
        hakase('それから、外部アクセスアナライザーはリージョンごとに作る。作ったリージョンのバケットを見張るからだ。今日は東京だ。'),
        node('IAM はグローバルなのに、アナライザーはリージョンごとなんですね。'),
        hakase('見張る相手のバケットがリージョンにあるからだ。ロールはグローバルだから、どのリージョンのアナライザーにも出てくる。'),
      ],
    },
    {
      type: 'exercise',
      title: '外部アクセスアナライザーを作り、検出結果を見る',
      objective: '外部アクセスのアナライザー (信頼ゾーン: 現在のアカウント) を作り、リソース分析でパブリックアクセスが「はい」の検出結果を開く',
      tasks: [
        { id: 'open', title: 'IAM > アクセスレポート > **リソース分析** (または **アナライザーの設定**) → **アナライザーを作成**', hint: '検索バーで「Access Analyzer」と入力しても開けます。', hotspotId: 'aa-create-analyzer', done: (c) => visited(c, '/iam/access-analyzer/analyzers/create') || !!externalAnalyzer(c.env) },
        { id: 'create', title: '「リソース分析 - 外部アクセス」、信頼ゾーン「現在のアカウント」で **アナライザーを作成**', hint: '名前は既定の `ExternalAccess-ConsoleAnalyzer-…` のままで構いません。作成すると、すぐに分析が始まります。', hotspotId: 'aa-create-submit', done: (c) => !!externalAnalyzer(c.env) },
        { id: 'view', title: 'リソース分析で、パブリックアクセスが「はい」の検出結果を開く', hint: '一覧の「検出結果 ID」のリンクを開きます。外部プリンシパル、条件、アクションを確かめます。', done: (c) => viewed(c, 'findings', exportsFinding(c.env)) },
      ],
      validate: (c) => {
        if (!externalAnalyzer(c.env)) return ng(hakase('まだアナライザーがない。IAM の左メニューの「リソース分析」で **アナライザーを作成** を押し、「リソース分析 - 外部アクセス」のまま作るのだ。'));
        if (!viewed(c, 'findings', exportsFinding(c.env))) return ng(hakase('アナライザーはできた。リソース分析の一覧で、パブリックアクセスが「はい」になっている行の検出結果 ID を開くのだ。'));
        return ok(
          node('4 件も出ました！ はやて物流さんのバケットとロール、それに `webapp-exports-…` と `old-vendor-role` です。'),
          hakase('君の答案は「1 つだけです」だったな。'),
          node('4 倍になりました……。`webapp-exports-…` は外部プリンシパルが「すべてのプリンシパル (*)」で、パブリックアクセスが「はい」です。'),
          hakase('世界中の誰でも、名乗らずに読めるということだ。中身は顧客リストだぞ。'),
          node('質問票に書く前でよかった……。'),
        );
      },
    },
    {
      type: 'table',
      title: '検出結果の仕分け',
      columns: ['リソース', '外部プリンシパル', '分かっていること', '判断'],
      rows: [
        [`\`${EXCHANGE_BUCKET}\` (S3 バケット)`, `AWS アカウント ${PARTNER_ACCOUNT}`, 'はやて物流と配送ファイルをやり取りする。契約どおり', 'アーカイブ'],
        [`\`${PARTNER_ROLE}\` (IAM ロール)`, `AWS アカウント ${PARTNER_ACCOUNT} (条件: sts:ExternalId)`, 'はやて物流がファイルを置くときに引き受ける。契約どおり', 'アーカイブ'],
        [`\`${EXPORTS_BUCKET}\` (S3 バケット)`, 'すべてのプリンシパル (*)', '代理店に顧客リストを渡すため、「一時的に」公開したまま', 'ポリシーを直す'],
        [`\`${VENDOR_ROLE}\` (IAM ロール)`, `AWS アカウント ${VENDOR_ACCOUNT}`, '去年の移行業者。契約は終わっている。今も使われているかは不明', '使われているか調べてから決める'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('`partner-upload-role` の条件にある `sts:ExternalId` って何ですか？'),
        hakase('**外部 ID** だ。ロールを引き受けるときに、相手が添える合言葉のようなものだ。はやて物流の名をかたる別の誰かに、このロールを使わせないための仕掛けだ。'),
        node('合言葉つきなのに、検出結果には出るんですね。'),
        hakase('合言葉を知っている社外の相手が入れることに変わりはないからな。条件は「どういうときに入れるか」として検出結果に載る。'),
        node('はやて物流さんの 2 件は、1 件ずつアーカイブすればいいですか？'),
        hakase('それでもよい。だが来月、はやて物流用のロールがもう 1 つ増えたら？'),
        node('また出てきて、またアーカイブ……。いたちごっこですね。'),
        hakase('そこで**アーカイブルール**だ。「AWS アカウントが 999988887777 の検出結果は自動でアーカイブする」と決めておく。'),
        node('メールの自動振り分けみたいなものですね。'),
        hakase('うむ。ただしルールが自動でアーカイブするのは、これから見つかる検出結果だけだ。今ある 2 件も片付けるなら、作るときに「アクティブな結果を作成してアーカイブする」を選ぶ。'),
        node('基準をゆるくしすぎたら？'),
        hakase('本当の穴まで「確認済み」の棚に隠れる。「リソースタイプが S3 バケット」などと書いたら、公開されたバケットまで闇に葬られるぞ。基準は「パートナーのアカウント」のように狭く書くのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'はやて物流との共有をアーカイブルールで片付ける',
      objective: `基準「AWS アカウント」「である」\`${PARTNER_ACCOUNT}\` のアーカイブルールを作り、今あるパートナーの検出結果 2 件もアーカイブする`,
      tasks: [
        { id: 'rule', title: 'リソース分析 → **アーカイブルールを作成** → 基準「AWS アカウント」、演算子「である」、値 `999988887777`', hint: '「結果」の表に、ルールに一致するアクティブな検出結果が出ます。はやて物流の 2 件だけになっているかを確かめます。', hotspotId: 'aa-create-archive-rule', done: (c) => !!partnerRule(c.env) },
        { id: 'archive', title: '**アクティブな結果を作成してアーカイブする** で、今ある 2 件もアーカイブ', hint: '「ルールを作成」だけを押した場合は、リソース分析で 2 件を選んで **アーカイブ** しても構いません。', hotspotId: 'aa-rule-create-archive', done: (c) => partnerArchived(c.env) },
      ],
      validate: (c) => {
        if (wrongArchived(c.env) || ruleTooBroad(c.env))
          return ng(
            hakase('待て、はやて物流以外の検出結果までアーカイブされておる (または、ルールが一致してしまう)。アナライザーの設定でルールを削除して基準を AWS アカウント 999988887777 だけにし、リソース分析の「アーカイブ済み」から選んで **アクティブとしてマーク** で戻すのだ。'),
            node('顧客リストを闇に葬るところでした……。'),
          );
        if (!partnerRule(c.env)) return ng(hakase('はやて物流の 2 件に一致するアーカイブルールがまだない。リソース分析の **アーカイブルールを作成** で、基準「AWS アカウント」、値 `999988887777` のルールを作るのだ。'));
        if (!partnerArchived(c.env)) return ng(hakase('ルールはできたが、今ある 2 件はまだアクティブだ。ルールが自動でアーカイブするのは、新しく見つかった検出結果だけだ。リソース分析で 2 件を選んで **アーカイブ** するのだ。'));
        return ok(
          node('アクティブが 2 件に減りました。はやて物流さんの 2 件は「アーカイブ済み」です。'),
          hakase('来月はやて物流用のロールが増えても、見つかった瞬間にアーカイブ済みになる。君が確認するのは、本当に怪しいものだけで済む。'),
          node('怪しいものだけ見ればいい。僕の仕事が減りますね。'),
          hakase('減った分は、残りの 2 件で取り返してもらう。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('次は `webapp-exports-…` です。バケットごと消しましょう！'),
        hakase('落ち着け。バケットを消したら、中の顧客リストを使っている仕事まで止まる。直すのは「誰でも読める」という張り紙、つまりバケットポリシーだけだ。'),
        node('Lesson 21 でやった、Principal が `"*"` の張り紙ですね。'),
        hakase('うむ。代理店への受け渡しはとっくに終わっておる。ポリシーにはその `TemporaryShareForAgency` しか書かれておらんから、ポリシーごと削除してよい。'),
        node('ブロックパブリックアクセスも、下の 2 つがオフのままでした。'),
        hakase('よく見ておる。Lesson 21 の 4 つのスイッチだ。張り紙をはがしたら、全部オンに戻して二度と貼れんようにしておく。'),
        node('直したら、検出結果は勝手に「解決済み」になるんですか？'),
        hakase('なる。ただし Access Analyzer が変更に気づいて分析し直すまで、本物では最大 30 分かかる。このシミュレーターでは 1 分ほどだ。'),
        node('30 分も待てません。'),
        hakase('せっかちな君のために、検出結果の画面に**再スキャン**がある。そのリソースだけを、今すぐ分析し直すボタンだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '公開されたバケットを閉じる',
      objective: `\`${EXPORTS_BUCKET}\` のバケットポリシーを削除してブロックパブリックアクセスをすべてオンに戻し、再スキャンで検出結果が「解決済み」になるのを確かめる`,
      tasks: [
        { id: 'policy', title: `S3 > \`${EXPORTS_BUCKET}\` > アクセス許可 → バケットポリシーの **削除**`, hint: '検出結果の詳細の「リソース」のリンクから、そのバケットのアクセス許可タブに移れます。', done: (c) => !exportsPublic(c.env) },
        { id: 'bpa', title: 'ブロックパブリックアクセスの **編集** → 「パブリックアクセスをすべて ブロック」→ **変更の保存**', hint: '確認のダイアログで「確認」と入力して確定します。', hotspotId: 's3-edit-bpa', done: (c) => exportsBpaOn(c.env) },
        { id: 'rescan', title: '検出結果の画面で **再スキャン** → ステータスが「解決済み」', hint: 'リソース分析の上の「アクティブ / アーカイブ済み / 解決済み」で「解決済み」を選ぶと、解決した検出結果が見られます。', hotspotId: 'aa-rescan', done: (c) => exportsResolved(c.env) },
      ],
      validate: (c) => {
        if (!partnerStillShared(c.env)) return ng(hakase('待て、はやて物流との共有まで消しておる。今夜から配送ファイルが届かなくなるぞ。「Lessonを最初からやり直す」でやり直すのだ。'), node('連携が始まる前に終わるところでした……。'));
        if (exportsPublic(c.env)) return ng(hakase(`\`${EXPORTS_BUCKET}\` はまだ誰でも読める。S3 でそのバケットのアクセス許可タブを開き、バケットポリシーの **削除** を押すのだ。`));
        if (!exportsBpaOn(c.env)) return ng(hakase('張り紙ははがせた。ブロックパブリックアクセスの **編集** で、4 つのスイッチを全部オンに戻すのだ。'));
        if (!exportsResolved(c.env)) return ng(hakase('ポリシーは直った。だが検出結果はまだアクティブのままだ。リソース分析でその検出結果を開き、**再スキャン** を押すのだ。'));
        return ok(
          node('再スキャンしたら「解決済み」になりました！'),
          hakase('アーカイブとの違いが分かるかな？ アーカイブは「開いているが、これでよい」。解決済みは「もう開いていない」だ。'),
          node('アーカイブで済ませていたら、顧客リストは開いたまま「確認済み」になっていたんですね。'),
          hakase('そういうことだ。臭いものに蓋をしても、においは漏れる。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('最後は `old-vendor-role` です。信頼ポリシーに 444455556666 とあります。誰ですか、この人。'),
        hakase('人ではなくアカウントだ。去年の移行作業を手伝った業者のアカウントだな。契約はとうに終わっておる。'),
        node('じゃあ消しましょう！'),
        hakase('待て。「誰も覚えていない」と「誰も使っていない」は別物だ。夜中に動いている連携があったら、消した瞬間に障害だ。'),
        node('深夜に電話が鳴るやつですね。'),
        hakase('そこで 2 つ目の分析、**未使用のアクセス**だ。IAM のロールやユーザーが最後に使われた日を調べて、決めた日数のあいだ使われていないものを報告する。'),
        node('その日数は？'),
        hakase('**追跡期間**という。既定は 90 日だ。90 日使われていないロールや権限が「未使用」として報告される。'),
        node('90 日……。僕がジムに行っていない日数と同じですね。'),
        hakase('解約したまえ。注意が 2 つある。1 つ目、未使用のアクセスの分析は有料だ。分析した IAM ロールとユーザーの数に応じて、月ごとに料金がかかる。'),
        node('こっちはタダじゃないんですね。もう 1 つは？'),
        hakase('追跡期間のあいだずっと存在していたロールしか分析されん。作って 1 週間のロールは、まだ判断できないということだ。'),
      ],
    },
    {
      type: 'table',
      title: '未使用のアクセスの検出結果',
      columns: ['結果タイプ', '何が見つかるか', '勧められる対応'],
      rows: [
        ['未使用のロール (UnusedIAMRole)', '追跡期間中、一度も使われていない IAM ロール', 'ロールを削除する'],
        ['未使用の権限 (UnusedPermission)', '使われているロールやユーザーが、追跡期間中に使わなかったサービスの権限', 'そのサービスを許可するポリシーを外す'],
        ['未使用のアクセスキー (UnusedIAMUserAccessKey)', 'IAM ユーザーの、使われていないアクセスキー', 'アクセスキーを無効にするか削除する'],
        ['未使用のパスワード (UnusedIAMUserPassword)', 'コンソールにサインインしていない IAM ユーザーのパスワード', 'パスワードを削除する'],
      ],
    },
    {
      type: 'exercise',
      title: '未使用のアクセスアナライザーを作る',
      objective: '未使用のアクセスのアナライザー (追跡期間 90 日) を作り、「未使用のアクセス」で `batch-role` の検出結果を開く',
      tasks: [
        { id: 'create', title: 'アナライザーの設定 → **アナライザーを作成** → 「プリンシパル分析 - 未使用のアクセス」、追跡期間 90 日', hint: '名前は既定の `UnusedAccess-ConsoleAnalyzer-…` のままで構いません。', hotspotId: 'aa-create-submit', done: (c) => !!unusedAnalyzer(c.env) },
        { id: 'view', title: '未使用のアクセスで `batch-role` の「未使用の権限」を開く', hint: '「結果タイプ」と「IAM エンティティ」の列を見ます。検出結果 ID のリンクで詳細が開きます。', done: (c) => viewed(c, 'unused', batchFinding(c.env)) },
      ],
      validate: (c) => {
        const a = unusedAnalyzer(c.env);
        if (!a) return ng(hakase('まだ未使用のアクセスのアナライザーがない。アナライザーの設定で **アナライザーを作成** を押し、「プリンシパル分析 - 未使用のアクセス」を選ぶのだ。'));
        if (a.unusedAccessAge !== 90) return ng(hakase(`追跡期間が ${a.unusedAccessAge} 日になっておる。今日は既定の 90 日で見る。アナライザーの設定でこのアナライザーを削除し、追跡期間 90 日で作り直すのだ。`));
        if (!viewed(c, 'unused', batchFinding(c.env))) return ng(hakase('アナライザーはできた。左メニューの「未使用のアクセス」で、IAM エンティティが `batch-role` の検出結果 ID を開くのだ。'));
        return ok(
          node('`old-vendor-role` は「未使用のロール」で、最終アクセスは 200 日前です。`batch-role` は「未使用の権限」で、ec2、elasticloadbalancing、cloudwatch、autoscaling が使われていません。'),
          hakase('`batch-role` が毎晩使っておるのは S3 だけだ。誰かが昔、調べものついでに `AmazonEC2ReadOnlyAccess` を付けて、そのままにしたのだろう。'),
          node('「ちょっとだけ権限を足す」が、ここにもありました。'),
          hakase('learner は毎日使っておるから、ここには出てこん。出てきたら、君がサボっておるということだ。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('判断の材料はそろった。`old-vendor-role` は 200 日使われておらず、信頼している相手は契約の終わった業者だ。'),
        node('外部アクセスにも未使用のアクセスにも出てくるなんて、役満ですね。'),
        hakase('麻雀なら喜ぶところだが、セキュリティでは最悪の手だ。削除する。検出結果の画面の「推奨事項」にある **ロールを削除** を使えば、アタッチされたポリシーも一緒に外れる。'),
        node('`batch-role` は？ ロールごと消すんですか？'),
        hakase('消したら今夜のバッチが止まる。外すのは使っていない `AmazonEC2ReadOnlyAccess` だけだ。毎晩使っておる `batch-s3-read` は残す。'),
        node('Lesson 23 で「焼け野原にするな」って言われたやつですね。'),
        hakase('よく覚えておった。Lesson 21 で言った**最小権限**を、あとから取り戻す作業だ。外し方は IAM のロールの「許可」タブで、ポリシーを選んで **削除** だ。'),
        node('全部片付いたら、検出結果は「解決済み」になるんですよね。'),
        hakase('未使用のアクセスには再スキャンがない。次の分析を待つのだ。このシミュレーターなら 1 分ほどだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '使われていないアクセスを片付ける',
      objective: `\`${VENDOR_ROLE}\` を削除し、\`batch-role\` から使われていない \`AmazonEC2ReadOnlyAccess\` だけを外す`,
      tasks: [
        { id: 'role', title: `未使用のアクセス → \`${VENDOR_ROLE}\` の検出結果 → 推奨事項の **ロールを削除**`, hint: '確認のダイアログで「削除」と入力します。', hotspotId: 'aa-delete-role', done: (c) => vendorGone(c.env) },
        { id: 'policy', title: 'IAM > ロール > `batch-role` > 許可 → `AmazonEC2ReadOnlyAccess` を選んで **削除**', hint: '`batch-s3-read` は毎晩のバッチが使っているので残します。`batch-role` の検出結果の「IAM エンティティ」のリンクからも開けます。', done: (c) => ec2Detached(c.env) },
      ],
      validate: (c) => {
        if (!s3Kept(c.env)) return ng(hakase('待て、`batch-s3-read` まで外したな。今夜のバッチがレポートを読めなくなる。`batch-role` の許可タブで **許可を追加** → **ポリシーをアタッチ** から `batch-s3-read` を付け直すのだ。'), node('焼け野原になりかけました……。'));
        if (!partnerStillShared(c.env)) return ng(hakase('`partner-upload-role` まで消してしまったな。はやて物流がファイルを置けなくなる。「Lessonを最初からやり直す」でやり直すのだ。'));
        if (!vendorGone(c.env)) return ng(hakase(`\`${VENDOR_ROLE}\` がまだ残っておる。未使用のアクセスでその検出結果を開き、推奨事項の **ロールを削除** を押すのだ。`));
        if (!ec2Detached(c.env)) return ng(hakase('`batch-role` にまだ `AmazonEC2ReadOnlyAccess` が付いておる。IAM > ロール > `batch-role` の許可タブで、そのポリシーを選んで **削除** するのだ。'));
        return ok(
          node('`old-vendor-role` は消えて、`batch-role` には `batch-s3-read` だけが残りました。'),
          hakase('1 分ほどすれば、未使用のアクセスの 2 件も、外部アクセスの `old-vendor-role` の 1 件も「解決済み」になる。'),
          node('質問票には「はやて物流さん用のバケットとロールの 2 つです。確認済みです」と書けます。'),
          hakase('今度は記憶ではなく、検出結果という根拠つきだ。アナライザーは残しておけば、これからも見張り続ける。次の「ちょっとだけ」が積もる前にな。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase(`問題だ。信頼ゾーンを「現在のアカウント」にした外部アクセスアナライザーがある。パートナーのアカウント (${PARTNER_ACCOUNT}) にバケットを共有したら、どうなるかな？`),
      options: ['共有が自動で止められる', '検出結果として報告される。意図した共有ならアーカイブ (アーカイブルール) で確認済みにする', '組織の外への共有は分析されない'],
      answer: 1,
      explanation: [
        hakase('正解。Access Analyzer は見つけて知らせるだけで、アクセスを止めはせん。意図した共有かどうかを決めるのは人間だ。'),
        hakase('意図した共有は、アーカイブルールで自動的に「確認済み」にしておく。そうすれば、アクティブな検出結果は「まだ誰も見ていない怪しいもの」だけになる。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('バケットポリシーを直したのに、検出結果がまだ「アクティブ」のままだ。どうするのが正しいかな？'),
      options: ['検出結果を手でアーカイブする', '少し待つか、再スキャン (StartResourceScan) で分析し直して「解決済み」になるのを確かめる', 'アナライザーを作り直す'],
      answer: 1,
      explanation: [
        hakase('正解。変更が分析されるまで、本物では最大 30 分かかる。待てないなら再スキャンだ。'),
        hakase('アーカイブは「開いているが、これでよい」という印だ。直したつもりで実は開いたままだったら、穴に「確認済み」の札を貼ることになる。解決済みになるのを、自分の目で確かめるのだ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後の問題だ。未使用のアクセスアナライザーの追跡期間は 90 日。30 日前に作って、一度も使っていないロールはどうなるかな？'),
      options: ['未使用のロールとして報告される', '報告されない (追跡期間のあいだずっと存在していたロールだけが分析される)', '自動で削除される'],
      answer: 1,
      explanation: [
        hakase('正解。作って 30 日では、90 日使われていないかどうかはまだ分からん。だから分析されない。'),
        hakase('それに Access Analyzer は、ロールを勝手に消したりはせん。消すかどうかを決めるのは、根拠を見た人間だ。'),
      ],
    },
  ],
};
