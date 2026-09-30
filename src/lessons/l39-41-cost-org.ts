import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { byName } from '../sim/env';
import { costLines, formatUsd, totalOf } from '../sim/cost';
import { evaluateScp, portalAccess } from '../sim/organizations';
import { costEnv, ORG_ACCOUNTS, ORG_OUS, scpEnv, ssoEnv } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { flowPath } from '../sim/vpc';
import { visited, visitedQuery } from './helpers';

// ---------------- 39 Cost ----------------

const total = (env: AwsEnv) => totalOf(costLines(env));
const budget = (env: AwsEnv) => env.budgets[0]?.limitUsd ?? 850;
const db = (env: AwsEnv, id: string) => env.dbInstances.find((d) => d.dbInstanceIdentifier === id);
const prodSafe = (env: AwsEnv) => !!db(env, 'webapp-db')?.multiAZ && (db(env, 'webapp-db')?.backupRetentionPeriod ?? 0) >= 7 && ['web-1', 'web-2'].every((n) => byName(env.instances, n)?.state === 'running');
const auditKept = (env: AwsEnv) => {
  const g = env.logGroups.find((x) => x.logGroupName === '/aws/cloudtrail/management-events');
  return !!g && (g.retentionInDays === undefined || g.retentionInDays >= 365);
};
const flowsWork = (env: AwsEnv) => !costLines(env).some((l) => l.broken);
const devSingleAz = (env: AwsEnv) => db(env, 'dev-db')?.multiAZ === false;
const devRetentionDays = (env: AwsEnv) => db(env, 'dev-db')?.backupRetentionPeriod ?? 99;
// 0 is not "short": it switches automated backups (and point-in-time restore) off
const devRetention = (env: AwsEnv) => devRetentionDays(env) >= 1 && devRetentionDays(env) <= 7;
const devSnapshots = (env: AwsEnv) => env.dbSnapshots.filter((s) => s.dbInstanceIdentifier === 'dev-db').length <= 1;
const batchFlow = (env: AwsEnv) => env.dataFlows.find((f) => f.destination === 's3');
const viaEndpoint = (env: AwsEnv) => !!batchFlow(env) && flowPath(env, batchFlow(env)!.subnetId, 's3').via === 'endpoint';
const devNats = (env: AwsEnv) => env.natGateways.filter((n) => n.vpcId === byName(env.vpcs, 'dev-vpc')?.vpcId && n.state !== 'deleted' && n.state !== 'deleting');
const debugShort = (env: AwsEnv) => (env.logGroups.find((g) => g.logGroupName === '/webapp/dev/debug')?.retentionInDays ?? Infinity) <= 14;

function guards(env: AwsEnv) {
  if (!prodSafe(env)) return ng(hakase('本番に手を出してはいかん。webapp-db はマルチ AZ・バックアップ保持期間 7 日以上、web-1 / web-2 は実行中に戻すのだ。本番のコストは「止まらないため」の費用だ。そこを削るのは、保険料をケチって事故を待つようなものだぞ。'));
  if (!auditKept(env)) return ng(hakase('監査ログ (CloudTrail) の保持期間を短くしてはいかん。/aws/cloudtrail/management-events の保持設定を「失効しない」(少なくとも 1 年以上) に戻すのだ。証拠を捨てたら犯人みたいだと、君が自分で言ったではないか。'));
  if (!flowsWork(env)) return ng(hakase('開発環境のサーバーが外に出られなくなっておる。請求とコスト管理の「通信できないデータの流れ」を見るのだ。ルートテーブルの 0.0.0.0/0 が消した NAT ゲートウェイを指したままなら、動いている NAT ゲートウェイに向け直すのだ (1 つも残っていなければ作り直す)。'));
  return undefined;
}

export const lesson39: Lesson = {
  id: 'cost-tradeoffs',
  number: '39',
  title: 'コスト vs 可用性 vs セキュリティ',
  summary: '月額が予算を超えた。本番の可用性と監査ログは守ったまま、開発環境の作りすぎを削って予算内に収める',
  minutes: 35,
  startPath: '/console/home',
  scenario: costEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、経理から電話です。今月の AWS の請求が、予算の $850 を大きく超えそうだって…'),
        hakase('経理の電話は、障害の電話より怖いぞ。障害は直せば終わるが、請求書は取り消せん。'),
        node('と、とりあえず全部止めますか？'),
        hakase('全部止めればコストはゼロだ。ついでに売上も、君の給料もゼロになるがな。'),
        node('それは困ります。まだ博士より給料をもらってないのに。'),
        hakase('…今、さらっと野望を漏らしたな。いいか、今日は **コスト**・**可用性**・**セキュリティ** の天秤の話だ。可用性とは止まらずに使い続けられること、セキュリティとは盗まれず・壊されず・後から調べられることだ。'),
        node('安くすると、そのどっちかが削れるんですか？'),
        hakase('たいていはな。だから「削ってよいところだけ」を削る。請求は **請求とコスト管理** の画面で見る。登録した **予算** と、「この構成のまま月末までいくといくらか」という **予測** を比べてくれる。金額は割引なしの定価、つまり **オンデマンド料金** での概算だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('まず EC2 は、止めれば安くなるんですよね。'),
        hakase('止める・小さくする・台数を減らす。停止中は時間料金がかからず、ディスク (EBS) の保存料金だけになる。代わりに処理能力と、台数があることによる冗長性を失う。'),
        node('RDS は？ 本番の `webapp-db` は **マルチ AZ** でしたよね。Lesson 29 のクイズに出てきました。'),
        hakase('そうだ。別の AZ に **スタンバイ** (予備の DB) を置いておき、AZ が落ちたら自動で切り替える。これを **フェイルオーバー** という。予備の分、料金はほぼ 2 倍だ。本番でケチって AZ 障害が来たら、浮いた金は障害報告書の印刷代に消えるがな。'),
        node('バックアップは？ Lesson 28 で、作業の前に取った手動スナップショットとか。'),
        hakase('自動バックアップの **保持期間** を長くしたり、手動スナップショットを溜め込んだりすると、保存料金が増える。その代わり、戻せる過去が長くなる。Lesson 29 の **RPO** を覚えておるか。'),
        node('「どこまでのデータ損失なら許せるか」を時間で決めた目標…でしたよね。'),
        hakase('ほう、覚えておったか。Lesson 29 の君は半分寝ておったのにな。バックアップを削るとは、RPO を悪くすることなのだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ALB はどうですか？'),
        hakase('動いている時間の料金に加えて、**LCU** で課金される。'),
        node('えるしーゆー？'),
        hakase('Load Balancer Capacity Unit、ALB が「どれだけ働いたか」の単位だ。新しい接続の数、同時接続の数、処理したデータ量、ルールの評価回数のうち、いちばん大きいものを 1 時間ごとに数える。請求の画面では ELB の行に出てくるぞ。'),
        node('タクシーの「基本料金 + 走った距離」みたいなものですね。'),
        hakase('うむ。次は **NAT ゲートウェイ** だ。今日が初登場だな。Lesson 06 で、Private subnet はインターネットに直接出られんと言ったろう。'),
        node('Route table に `0.0.0.0/0 → Internet gateway` がないから、でしたよね。'),
        hakase('そうだ。だが Private のサーバーも、パッケージの更新や外部 API の呼び出しで外に出たいことがある。そのとき代わりに外へ出してくれる出口が、NAT ゲートウェイだ。'),
        node('なっと？ 納豆？'),
        hakase('ネバネバしとらん。**NAT (Network Address Translation)**、アドレス変換だ。Public subnet に置き、Private のサーバーの送信元アドレスを自分のパブリック IP に付け替えて外に出し、返ってきた応答を中へ戻す。外から中へ入ろうとする通信は通さん。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('会社の代表電話ですね。外にかけるときは代表番号で発信して、外から社員の内線には直接かけられない。'),
        hakase('うまいことを言う。ただしこの代表電話、置いておくだけの時間料金と、通したデータ 1 GB ごとの処理料金がかかる。しかも 1 つの AZ の中にあるから、本番では AZ ごとに置く。'),
        node('1 つにまとめれば安いのに。'),
        hakase('まとめると、その AZ が落ちたときに全部の AZ のサーバーが外に出られなくなる。そのうえ別の AZ の NAT まで運ぶ分、**AZ 間のデータ転送料金** がかかる。AZ をまたぐ通信と、インターネットへの送信は有料なのだ。'),
        node('じゃあ Private のサーバーが S3 から大量にデータを取るときも、NAT の通行料を払ってるんですか？'),
        hakase('何もしなければな。そこで **ゲートウェイエンドポイント** だ。'),
        node('げーとうぇいえんどぽいんと？'),
        hakase('VPC から S3 (と DynamoDB) へ直通する裏口だ。サービス `com.amazonaws.ap-northeast-1.s3` を選んで作ると、選んだ Route table に「S3 行きはこの裏口へ」というルートが足される。NAT もインターネットも通らず、しかも **無料** だ。'),
        node('無料で、インターネットにも出ない。コストとセキュリティの両方に効くじゃないですか。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('何も失わん珍しいレバーだ。こういうのは真っ先に引く。最後はログだ。'),
        node('ログなんて、残しておくだけなら安そうですけど。'),
        hakase('CloudWatch Logs は、取り込んだ量と保存している量の両方で課金される。Lesson 25 で見たロググループには **保持期間** があって、既定は「失効しない」、つまり永遠に保存だ。解約できんサブスクのようなものだな。'),
        hakase('ただし **監査ログ** は別だ。Lesson 26 で、CloudTrail の記録からセキュリティグループのルールを消した操作を突き止めたろう。あの記録は `/aws/cloudtrail/management-events` にも送っておる。調査や監査では 1 年以上前まで遡ることがあるから、これは削らん。削るのは開発のデバッグログのほうだ。'),
        node('捨てていいゴミと、捨てちゃいけない証拠を分けるんですね。証拠を捨てたら、こっちが犯人みたいですし。'),
      ],
    },
    {
      type: 'table',
      title: 'コストのレバーと、その代わりに失うもの',
      columns: ['対象', '安くするレバー', '代わりに失うもの'],
      rows: [
        ['EC2', '停止・サイズ縮小・台数削減', '処理能力、冗長性 (可用性)'],
        ['RDS', 'シングル AZ・クラス縮小', 'AZ 障害時の自動フェイルオーバー (可用性)'],
        ['ALB', '(開発では) 使わない', '複数 AZ にまたがる入口 (可用性)'],
        ['NAT ゲートウェイ', 'AZ ごと → 1 つにまとめる', 'AZ 障害への耐性 (可用性)。AZ 間のデータ転送料金が増える'],
        ['データ転送', 'S3 へはゲートウェイエンドポイントを通す', 'なし (コストもセキュリティも改善)'],
        ['ログ', '保持期間を短く・量を減らす', '調査できる期間 (監査ログはセキュリティのため長く)'],
        ['バックアップ', '保持期間を短く・古いスナップショット削除', '復元できる範囲 (RPO)'],
      ],
    },
    {
      type: 'exercise',
      title: 'どこにお金がかかっているか調べる',
      objective: '請求とコスト管理 のホームで、予算に対する予測、環境別・サービス別のコストと内訳を確認する',
      tasks: [{ id: 'billing', title: '請求とコスト管理 > ホーム を開く', hint: '検索で「cost」や「請求」と入力します。', done: (c) => visited(c, '/billing/home') }],
      validate: (c) =>
        visited(c, '/billing/home')
          ? ok(
              node(`合計 ${formatUsd(total(c.env))} のうち、開発環境が本番の何倍もかかっています！ 開発 DB がマルチ AZ、NAT ゲートウェイが 3 つ、デバッグログが「失効しない」…`),
              hakase('開発環境を「本番と同じ作りで、しかも大きめに」作ってしまったのだな。開発 DB なぞ、本番より大きいクラスで、そのうえマルチ AZ だ。'),
              node('誰がこんな作りに…'),
              hakase('犯人捜しは後だ。削るのは開発からだ。本番のコストは「止まらないための費用」だから、手を付けん。'),
            )
          : ng(hakase('まだ請求を見ておらん。上の検索バーに「請求」か「cost」と入力して、請求とコスト管理のホームを開くのだ。')),
    },
    {
      type: 'exercise',
      title: '開発 DB を開発向けにする',
      objective: '`dev-db` をシングル AZ にし、バックアップ保持期間を 7 日以下にして、古い手動スナップショットを整理する (残すのは 1 つまで)。本番の `webapp-db` は変えない',
      tasks: [
        { id: 'az', title: 'RDS > `dev-db` → 変更 → マルチ AZ 配置: **スタンバイインスタンスを作成しないでください**', hint: '同じ画面でバックアップ保持期間も変えられます。', done: (c) => devSingleAz(c.env) },
        { id: 'retention', title: 'バックアップ保持期間を **7 日以下** に', hint: '`dev-db` の **変更** 画面の「バックアップ」欄で選び、**続行** → **すぐに適用** → **DB インスタンスを変更** で確定します。0 日にすると自動バックアップが無効になるので、1〜7 日にします。', done: (c) => devRetention(c.env) },
        { id: 'snap', title: 'RDS > スナップショット → `dev-db` の古い手動スナップショットを削除 (残り 1 つ以下)', hint: '**手動** タブで DB インスタンス が `dev-db` の行を 1 つずつ選び、**アクション** → **スナップショットを削除** します。残すなら新しいものを 1 つにします。', done: (c) => devSnapshots(c.env) },
      ],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (devRetentionDays(c.env) === 0) return ng(hakase('保持期間 0 日は「短い」ではなく「自動バックアップを止める」設定だ。開発でも、壊したときに戻せる日がなくなるぞ。dev-db の **変更** で 1〜7 日にするのだ。'));
        if (!devSingleAz(c.env) || !devRetention(c.env) || !devSnapshots(c.env)) return ng(hakase('dev-db の作りすぎがまだ残っておる。RDS > dev-db の「変更」でマルチ AZ 配置を「スタンバイインスタンスを作成しないでください」に、バックアップ保持期間を 7 日以下にし、RDS > スナップショットで dev-db の手動スナップショットを 1 つまで減らすのだ。'));
        return ok(
          node('開発 DB だけで月 $230 以上減りました！'),
          hakase('開発の DB が AZ 障害で 1 時間止まっても、困るのは開発者だけだ。コーヒー休憩が 1 時間延びるとも言う。'),
          node('手動スナップショットも 1 つは残したので、いざとなれば戻せますしね。'),
          hakase('うむ。本番の webapp-db はマルチ AZ のままだ。「止まったら誰が困るか」、そこが天秤の分かれ目だ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'NAT ゲートウェイとデータ転送を見直す',
      objective: '`dev-vpc` に S3 のゲートウェイエンドポイントを作って dev-batch の S3 通信を NAT から外し、NAT ゲートウェイを 1 つにまとめる (通信は止めない)',
      tasks: [
        { id: 'vpce', title: 'VPC > エンドポイント → **エンドポイントを作成** (サービス `com.amazonaws.ap-northeast-1.s3`、VPC `dev-vpc`、プライベートのルートテーブル 3 つ)', hint: 'ゲートウェイエンドポイントは無料です。', hotspotId: 'vpce-create', done: (c) => viaEndpoint(c.env) },
        { id: 'routes', title: '`dev-private-rt-1c` と `dev-private-rt-1d` の 0.0.0.0/0 を `dev-nat-1a` に向け直す', hint: 'ルートテーブル > ルートを編集 → ターゲットのタイプで NAT ゲートウェイを選びます。', hotspotId: 'rt-save-routes', done: (c) => flowsWork(c.env) && devNats(c.env).length < 3 },
        { id: 'nat', title: 'VPC > NAT ゲートウェイ → 使わなくなった `dev-nat-1c` と `dev-nat-1d` を削除 (残り 1 つ)', hint: '先に削除すると、その AZ のサブネットはインターネットに出られなくなります。', hotspotId: 'nat-actions', done: (c) => devNats(c.env).length === 1 && flowsWork(c.env) },
      ],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (!viaEndpoint(c.env)) return ng(hakase('dev-batch の S3 への通信が、まだ NAT ゲートウェイを通っておる。1 GB ごとに処理料金がかかるのだ。VPC > エンドポイントで com.amazonaws.ap-northeast-1.s3 のゲートウェイエンドポイントを作り、dev-vpc のプライベートのルートテーブルを 3 つとも選ぶのだ。'));
        if (devNats(c.env).length !== 1) return ng(hakase('開発の NAT ゲートウェイはまだ 1 つになっておらん。先に dev-private-rt-1c と dev-private-rt-1d の 0.0.0.0/0 を dev-nat-1a に向け直し、それから dev-nat-1c と dev-nat-1d を削除するのだ。'));
        return ok(
          node('S3 への 2,000 GB が無料になって、NAT も 1 つになりました。'),
          hakase('エンドポイントのおかげで、dev-batch の S3 への通信はインターネットにも出なくなった。コストだけでなく、セキュリティも良くなったわけだ。'),
          node('NAT を 1 つにしたほうは、可用性を削ったんですよね。'),
          hakase('そうだ。開発だから許せる妥協だ。本番では AZ ごとに置くのだぞ。本番の出口を 1 つにして AZ 障害に巻き込まれた障害報告書は、だいたい「コスト削減のため」という一文から始まる。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'ログの保持期間を見直す',
      objective: 'デバッグログ `/webapp/dev/debug` の保持期間を 14 日以下にする。監査ログ `/aws/cloudtrail/management-events` はそのまま残す',
      tasks: [{ id: 'debug', title: 'CloudWatch > ロググループ > `/webapp/dev/debug` → アクション > **保持設定を編集**', hint: '「イベントの有効期限」で 14 日以下 (例: 14 日) を選んで **保存** します。監査ログ `/aws/cloudtrail/management-events` の保持設定は変えません。', hotspotId: 'logs-retention', done: (c) => debugShort(c.env) }],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (!debugShort(c.env)) return ng(hakase('デバッグログの保持期間がまだ長い。CloudWatch > ロググループ > /webapp/dev/debug の「アクション」→「保持設定を編集」で、14 日以下にするのだ。'));
        return ok(
          node('保存料金が下がりました。でも取り込みの $228 はそのままです。'),
          hakase('ログは「取り込んだ量」でも課金されると言ったろう。量そのものを減らすには、アプリの **ログレベル** を DEBUG から INFO に上げるのが次の一手だ。'),
          node('ろぐれべる？'),
          hakase('どこまで細かく書くかの目盛りだ。DEBUG は何でも書き、INFO は大事なことだけを書く。開発者の独り言まで全部録音しておく必要はない。もちろん監査ログは減らさんぞ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '予算内に収める',
      objective: `請求とコスト管理で、予測が予算 ${formatUsd(850)} 以内になったことを確かめる (本番の可用性・監査ログ・開発の通信は守ったまま)`,
      tasks: [{ id: 'budget', title: '予算の予測が「予算内」', hint: '足りなければ、開発のサーバー (dev-web-1 / dev-batch) を使わない時間は停止するのも手です。', done: (c) => total(c.env) <= budget(c.env) && !guards(c.env) }],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (total(c.env) > budget(c.env)) return ng(hakase(`まだ予測は ${formatUsd(total(c.env))}。予算 ${formatUsd(budget(c.env))} を超えておる。請求とコスト管理の内訳を大きい行から見直すのだ。開発のサーバー (dev-web-1 / dev-batch) を、使わない時間は停止するのも手だ。`));
        return ok(
          node(`予測 ${formatUsd(total(c.env))}、予算内です！`),
          hakase('本番の可用性と監査ログには 1 ドルも手を付けずに達成した。'),
          node('削ったのは、開発の作りすぎだけですね。'),
          hakase('コスト削減とは「どこを削らないか」を決めることなのだ。経理には、ワシが削ったと報告しておこう。'),
          node('えっ。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。本番の NAT ゲートウェイも 1 つにまとめると、何が起きるかな？'),
      options: ['何も変わらない', 'その NAT の AZ が障害になると、すべての AZ のプライベートサブネットがインターネットに出られなくなる', 'NAT ゲートウェイの料金が 2 倍になる'],
      answer: 1,
      explanation: [
        hakase('正解。NAT ゲートウェイは 1 つの AZ の中にある。その AZ が落ちると、ほかの AZ のプライベートサブネットまで道連れで外に出られなくなる。'),
        hakase('AZ ごとに NAT を置くのは、AZ 障害を 1 つの AZ に閉じ込めるためだ。本番では、その費用を払う価値がある。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では、プライベートサブネットから S3 への大量の通信。コストとセキュリティの両方に効くのはどれかな？'),
      options: ['NAT ゲートウェイを大きいサイズにする', 'S3 のゲートウェイエンドポイントを使う', 'パブリックサブネットに移す'],
      answer: 1,
      explanation: [
        hakase('正解。ゲートウェイエンドポイントは無料で、通信はインターネットに出ない。'),
        node('パブリックサブネットに移すのは、NAT 代は浮いても、サーバーがインターネットの目の前に出ちゃいますもんね。'),
        hakase('うむ。さらに Lesson 21 でやったバケットポリシーで、「このエンドポイントからだけ」と絞ることもできる。'),
      ],
    },
  ],
};

// ---------------- 40 Organizations / SCP ----------------

const tokyo = { 'aws:RequestedRegion': 'ap-northeast-1' };
const virginia = { 'aws:RequestedRegion': 'us-east-1' };
const members = [ORG_ACCOUNTS.audit, ORG_ACCOUNTS.logArchive, ORG_ACCOUNTS.prod, ORG_ACCOUNTS.staging, ORG_ACCOUNTS.dev];
const scp = (env: AwsEnv, account: string, action: string, ctx = tokyo) => evaluateScp(env, account, action, ctx).decision;
const prodMoved = (env: AwsEnv) => env.organization?.accounts.find((a) => a.id === ORG_ACCOUNTS.prod)?.parentId === ORG_OUS.production;
const auditProtected = (env: AwsEnv) => members.every((a) => scp(env, a, 'cloudtrail:StopLogging') === 'ExplicitDeny' && scp(env, a, 'cloudtrail:DeleteTrail') === 'ExplicitDeny');
const stillWorks = (env: AwsEnv) => members.every((a) => scp(env, a, 'ec2:DescribeInstances') === 'Allow' && scp(env, a, 's3:GetObject') === 'Allow');
const devTokyoOnly = (env: AwsEnv) => scp(env, ORG_ACCOUNTS.dev, 'ec2:RunInstances', virginia) === 'ExplicitDeny' && scp(env, ORG_ACCOUNTS.dev, 'ec2:RunInstances') === 'Allow';
const globalOk = (env: AwsEnv) => scp(env, ORG_ACCOUNTS.dev, 'iam:CreateRole', virginia) !== 'ExplicitDeny';
const tried = (c: TaskContext, user: string, account: string, action: string, extra: Record<string, string> = {}) => visitedQuery(c, '/sso/portal', { user, account, action, ...extra });
function orgGuards(env: AwsEnv) {
  if (!stillWorks(env)) return ng(hakase('普通の操作 (ec2:DescribeInstances や s3:GetObject) まで止まっているアカウントがある。FullAWSAccess を外したり、すべてを拒否する SCP を付けたりしていないか、サービスコントロールポリシーのターゲットを確かめるのだ。柵を立てるつもりで、道路ごと封鎖してどうする。'));
  return undefined;
}

export const lesson40: Lesson = {
  id: 'organizations-scp',
  number: '40',
  title: 'AWS Organizations と SCP でガードレールを作る',
  summary: '本番アカウントが OU の外にいてガードレールが効いていない。アカウントを正しい OU に置き、SCP で監査の停止とリージョンを制限する',
  minutes: 35,
  startPath: '/organizations/accounts',
  scenario: scpEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、うちの会社、本番・ステージング・開発を別々の AWS アカウントに分けたそうです。前回みたいに、本番と開発が 1 つのアカウントで混ざらないように。'),
        hakase('うむ。1 つのアカウントに全部詰め込むと、開発者の手が滑った先が本番、ということになるからな。ちなみにステージングは、本番直前のリハーサル会場だ。'),
        node('でもアカウントがたくさんあったら、請求書もたくさん来ますよね。経理さんからまた電話が来ますよ。'),
        hakase('そこで **AWS Organizations** だ。たくさんのアカウントを 1 つの **組織** にまとめ、請求も 1 つにまとめる。'),
        node('おーがないぜーしょんず。会社の組織図みたいなものですか？'),
        hakase('まさにそれだ。組織を作ったアカウントが **管理アカウント**、組織に入っているほかのアカウントが **メンバーアカウント**。組織図のいちばん上が **ルート** だ。'),
        node('ルート… Lesson 06 のルートテーブルのルートですか？'),
        hakase('綴りが違う。あっちは route (道)、こっちは root (根っこ) だ。組織図の頂点、社長室だと思えばよい。'),
        node('社長室の下に、部署があるんですね。'),
        hakase('そうだ。部署にあたるのが **OU (組織単位)**。アカウントを入れるフォルダのようなもので、今回は Security・Production・Staging・Development の 4 つがある。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('フォルダに分けると、何がうれしいんですか？'),
        hakase('OU やアカウントに **SCP (サービスコントロールポリシー)** を付けられる。「このアカウントでは、誰であっても絶対にできないこと」を決める **ガードレール** だ。'),
        node('がーどれーる。道路の端の柵ですね。'),
        hakase('うむ。運転は自由だが、崖には落ちられん。大事なのは、SCP は権限を **与えない** ということだ。できることの **上限** を決めるだけだ。'),
        node('IAM ポリシーとは違うんですか？ Lesson 22 でやった、JSON で許可を書くやつ。'),
        hakase('書き方は同じだが、役割が違う。IAM ポリシーが「君はこれをしてよい」という許可証なら、SCP は「この建物ではこれは禁止」という館内ルールだ。許可証を持っていても、館内ルールで禁止ならできん。'),
        node('Lesson 23 で、明示的な拒否は許可より強いって習いましたよね。'),
        hakase('SCP の Deny も同じで、そのアカウントの管理者でも破れん。そして SCP は **継承** される。ルートに付けたものは組織の全員に、OU に付けたものはその中のアカウント全部に効く。'),
        node('社長室の張り紙は、全部署に効くと。'),
        hakase('うむ。ただし最初から、ルートと全 OU・全アカウントには **FullAWSAccess** という「全部許可」の SCP が付いておる。上限を「全部」にしておくためのものだ。これを外すと上限がゼロになって、何もできなくなるぞ。'),
      ],
    },
    {
      type: 'table',
      title: 'Organizations の用語',
      columns: ['用語', '意味'],
      rows: [
        ['管理アカウント', '組織を作ったアカウント。請求をまとめる。**SCP は適用されない** ので、普段の作業には使わない'],
        ['OU (組織単位)', 'アカウントのフォルダ。Security / Production / Staging / Development など'],
        ['SCP', 'アカウントで使える権限の **上限**。権限を与えるのではなく、制限するだけ'],
        ['継承', 'ルート → OU → アカウントの各レベルで許可され、どこでも拒否されていない操作だけが実行できる'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('表に「管理アカウントには SCP は適用されない」ってありますね。'),
        hakase('いちばん偉いアカウントだけは柵の外だ。だから管理アカウントでは普段の作業をせん。社長室の金庫の鍵は、持つ人を最小限にするのだ。'),
        node('で、今日の症状は何ですか？'),
        hakase('Production OU には `prod-guardrails` という SCP が付いていて、本番の DB やスナップショットの削除を禁止しておる。…はずなのだが、効いておらん疑いがある。'),
        node('効いてるかどうかは、どうやって確かめるんですか？'),
        hakase('その人になって試すのが一番だ。**IAM Identity Center** の **AWS アクセスポータル** を使う。人がサインインして、入るアカウントと **許可セット** (そのアカウントでの権限のセット) を選ぶ入口だ。詳しくは次の Lesson 41 でやる。'),
        node('許可セットの `AdministratorAccess` って、名前からして何でもできそうですね。'),
        hakase('そのアカウントで何でもできる管理者だ。運用担当の `sato` として、その権限で本番の `rds:DeleteDBSnapshot`、つまりスナップショットの削除を試す。管理者でも止められれば、ガードレールが効いている証拠だ。'),
        node('本当に消えちゃったらどうするんですか？'),
        hakase('ここはシミュレーターだ。消えるのは、ガードレールが効いていなかったという事実のほうだけだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ほかにやることはありますか？'),
        hakase('2 つある。1 つ目は、Lesson 26 の CloudTrail を止められんようにすることだ。イベント履歴で見られるのは 90 日分だが、もっと長く残すために記録を送り続ける設定を **証跡 (トレイル)** という。記録を止める `cloudtrail:StopLogging` と、証跡を消す `cloudtrail:DeleteTrail` を、組織全体で禁止する。'),
        node('2 つ目は？'),
        hakase('開発アカウントで、東京以外の **リージョン** を使わせないことだ。Lesson 02 でやったとおり、リージョンを切り替えないと、そこのリソースは画面に出てこん。'),
        node('誰も見てないリージョンで、高いインスタンスが動き続けちゃうってことですか。'),
        hakase('月末に経理から二度目の電話が来て、初めて気付くやつだ。ただし IAM のような **グローバルサービス** まで止めてはいかん。'),
        node('ぐろーばるさーびす？'),
        hakase('リージョンに属さず、世界に 1 つだけあるサービスだ。IAM、Organizations、Route 53、CloudFront などがそうだ。こういうサービスへのリクエストは、多くが us-east-1 に届いたものとして扱われる。Lesson 36 で CloudFront の証明書を us-east-1 で作ったのも、CloudFront がグローバルサービスだからだ。'),
        node('「東京以外は禁止」とだけ書くと、IAM まで禁止されちゃうんですね。'),
      ],
    },
    {
      type: 'exercise',
      title: '組織の構造を確かめる',
      objective: 'AWS Organizations > AWS アカウント で組織の構造を見て、`webapp-prod` の詳細 (パスと継承されるポリシー) を開く',
      tasks: [{ id: 'prod', title: '`webapp-prod` を開く', hint: 'ツリーで `webapp-prod` がどの OU の下にあるかを見てから、名前のリンクで詳細を開き、**パス** と「継承元」の表を確認します。', done: (c) => visited(c, `/organizations/accounts/${ORG_ACCOUNTS.prod}`) }],
      validate: (c) =>
        visited(c, `/organizations/accounts/${ORG_ACCOUNTS.prod}`)
          ? ok(
              node('パスが「Root / webapp-prod」です。Production OU に入っていません！'),
              hakase('組織に招待したアカウントは、最初はルートの直下に入る。誰かが Production に移し忘れたのだ。'),
              node('じゃあ `prod-guardrails` は…'),
              hakase('肝心の本番に効いておらん。柵を立てた道路の隣を、本番だけが柵なしで走っておったわけだ。'),
            )
          : ng(hakase('まだ webapp-prod を開いておらん。AWS Organizations > AWS アカウントの組織の構造から webapp-prod を選び、パスと継承されるポリシーを見るのだ。')),
    },
    {
      type: 'exercise',
      title: '本番アカウントを Production OU に移す',
      objective: '`webapp-prod` を Production OU に移動し、IAM Identity Center の **AWS アクセスポータル** で、運用担当 `sato` が本番で `rds:DeleteDBSnapshot` を実行できなくなったことを確かめる',
      tasks: [
        { id: 'move', title: 'AWS アカウント → `webapp-prod` を選択 → **移動** → Production', hint: '`webapp-prod` の行のラジオボタンを選ぶと **移動** が押せるようになります。移動先で Production を選び **AWS アカウントを移動** を押します。', hotspotId: 'org-move', done: (c) => prodMoved(c.env) },
        { id: 'try', title: 'IAM Identity Center > AWS アクセスポータル → ユーザー `sato` → webapp-prod (AdministratorAccess) の **アクセスを試す** → `rds:DeleteDBSnapshot` を実行', hint: 'AdministratorAccess でも SCP が拒否すればできません。', hotspotId: 'sso-portal-run', done: (c) => prodMoved(c.env) && tried(c, 'sato', ORG_ACCOUNTS.prod, 'rds:DeleteDBSnapshot') },
      ],
      validate: (c) => {
        if (!prodMoved(c.env)) return ng(hakase('webapp-prod はまだ Production OU の外だ。AWS アカウントで webapp-prod を選び、「移動」で Production を選ぶのだ。'));
        if (!tried(c, 'sato', ORG_ACCOUNTS.prod, 'rds:DeleteDBSnapshot')) return ng(hakase('移動はできた。次は確かめだ。IAM Identity Center > AWS アクセスポータルでユーザー sato を選び、webapp-prod (AdministratorAccess) の「アクセスを試す」で rds:DeleteDBSnapshot を実行するのだ。'));
        return ok(
          node('AdministratorAccess なのに `with an explicit deny in a service control policy` で拒否されました！'),
          hakase('「SCP の明示的な拒否によって」と書いてある。IAM で何を許可されていても、SCP の拒否が勝つ。'),
          node('アカウントの管理者でも外せないガードレール、ですね。'),
          hakase('うむ。これで sato さんが寝ぼけて本番のスナップショットを消す心配はなくなった。君が消す心配もな。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '監査ログを止められないようにする',
      objective: 'SCP `protect-audit` を作って `cloudtrail:StopLogging` と `cloudtrail:DeleteTrail` を拒否し、**ルート** にアタッチして全メンバーアカウントに効かせる',
      tasks: [
        { id: 'create', title: 'サービスコントロールポリシー → **ポリシーを作成** (Effect: Deny、Action: 2 つ、Resource: *)', hint: '{ "Version": "2012-10-17", "Statement": [{ "Effect": "Deny", "Action": ["cloudtrail:StopLogging", "cloudtrail:DeleteTrail"], "Resource": "*" }] }', hotspotId: 'org-create-scp', done: (c) => !!c.env.organization?.policies.some((p) => !p.awsManaged && p.name !== 'prod-guardrails') },
        { id: 'attach', title: 'ポリシーの **ターゲット** → **アタッチ** → Root', hint: '作成したポリシーの詳細画面下の **ターゲット** 表で **アタッチ** を押し、Root を選んで **ポリシーをアタッチ** します。Root に付けると、下のすべての OU とアカウントに継承されます。', hotspotId: 'org-scp-attach', done: (c) => auditProtected(c.env) },
      ],
      validate: (c) => {
        const g = orgGuards(c.env);
        if (g) return g;
        if (!auditProtected(c.env)) return ng(hakase('まだ CloudTrail を止められるメンバーアカウントがある。protect-audit の「ターゲット」で Root にアタッチすれば、下のすべての OU とアカウントに継承されるぞ。'));
        return ok(
          node('全部のメンバーアカウントで、CloudTrail を止められなくなりました。'),
          hakase('侵入した攻撃者が最初にやるのは、証拠を消すこと、つまり CloudTrail を止めることだ。それを組織全体で封じた。'),
          node('泥棒が最初に防犯カメラを壊すのと同じですね。'),
          hakase('そうだ。次のリージョン制限では、Deny に **Condition** (条件) を付ける。`aws:RequestedRegion` はリクエスト先のリージョン、`StringNotEquals` は「一致しなければ」だ。合わせて「東京でなければ拒否」になる。'),
          hakase('グローバルサービスは **NotAction** で外す。「ここに書いたもの以外を拒否する」という書き方だ。書き方の例はヒントに置いてある。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '開発アカウントのリージョンを制限する',
      objective: 'Development OU に、東京リージョン (ap-northeast-1) 以外での操作を拒否する SCP を付ける。IAM などのグローバルサービスは止めない。アクセスポータルで `node` が webapp-dev の us-east-1 で `ec2:RunInstances` できないことを確かめる',
      tasks: [
        { id: 'scp', title: 'SCP を作成して Development にアタッチ', hint: '{ "Version": "2012-10-17", "Statement": [{ "Effect": "Deny", "NotAction": ["iam:*", "organizations:*", "sts:*", "route53:*", "cloudfront:*", "support:*"], "Resource": "*", "Condition": { "StringNotEquals": { "aws:RequestedRegion": ["ap-northeast-1"] } } }] }', done: (c) => devTokyoOnly(c.env) },
        { id: 'try', title: 'アクセスポータル → `node` → webapp-dev (AdministratorAccess) → リージョン **米国東部 (バージニア北部)** で `ec2:RunInstances`', hint: 'webapp-dev の行の **アクセスを試す** を押すと、アクションとリージョンの入力欄が出ます。結果の「SCP: …」の行で、どのレベルの SCP が拒否したかを確認できます。', hotspotId: 'sso-portal-run', done: (c) => devTokyoOnly(c.env) && tried(c, 'node', ORG_ACCOUNTS.dev, 'ec2:RunInstances', { region: 'us-east-1' }) },
      ],
      validate: (c) => {
        const g = orgGuards(c.env);
        if (g) return g;
        if (!devTokyoOnly(c.env)) return ng(hakase('webapp-dev で、us-east-1 の ec2:RunInstances が拒否され、東京では許可される状態にするのだ。Condition の StringNotEquals で aws:RequestedRegion が ap-northeast-1 以外なら拒否する SCP を作り、Development にアタッチしたまえ。'));
        if (!globalOk(c.env)) return ng(hakase('IAM のようなグローバルサービスまで止まっておる。グローバルサービスへのリクエストはリージョンが us-east-1 になるから、NotAction で iam:* などを除外しないと、開発者がロールも作れなくなるぞ。'));
        if (!tried(c, 'node', ORG_ACCOUNTS.dev, 'ec2:RunInstances', { region: 'us-east-1' })) return ng(hakase('SCP はできた。最後に確かめだ。アクセスポータルで node を選び、webapp-dev (AdministratorAccess) でリージョンを米国東部 (バージニア北部) にして ec2:RunInstances を試すのだ。'));
        return ok(
          node('東京以外では、管理者でもインスタンスを起動できなくなりました。'),
          hakase('誰も見ないリージョンに高額なインスタンスが置き去りにされる事故を防げる。乗っ取られたアカウントで、知らないリージョンに暗号資産の採掘マシンをずらりと並べられる事故もな。'),
          node('セキュリティとコストの両方に効くガードレールですね。'),
          hakase('うむ。前回の天秤で言えば、何も失わんほうのレバーだ。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。SCP で `s3:*` を許可したが、IAM ポリシーでは何も許可していないユーザーがいる。S3 を使えるかな？'),
      options: ['使える (SCP が許可しているから)', '使えない (SCP は上限を決めるだけで、権限を与えない)', 'バケットによって使える'],
      answer: 1,
      explanation: [
        hakase('正解。SCP は上限を決めるだけで、権限を与えはせん。'),
        hakase('できることは「SCP の上限」と「IAM の許可」の重なった部分だけだ。館内ルールで禁止されていなくても、許可証がなければ何もできん。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では、ルートに付けた `protect-audit` は、管理アカウント (webapp-management) にも効くかな？'),
      options: ['効く', '効かない (管理アカウントには SCP が適用されない)', '管理アカウントだけに効く'],
      answer: 1,
      explanation: [
        hakase('正解。管理アカウントには SCP が適用されん。ルートに付けてもだ。'),
        node('だから管理アカウントでは普段の作業をしないで、入れる人も最小限にするんですね。'),
        hakase('うむ。社長室の金庫の鍵を、全社員の机に配る会社はない。…と信じたい。'),
      ],
    },
  ],
};

// ---------------- 41 IAM Identity Center ----------------

const sso = (env: AwsEnv) => env.identityCenter;
const readOnly = (env: AwsEnv) => sso(env)?.permissionSets.find((p) => p.managedPolicyArns.some((a) => a.endsWith('/ReadOnlyAccess')));
const devsOn = (env: AwsEnv, account: string) =>
  (sso(env)?.assignments ?? []).filter((a) => a.accountId === account && a.principalType === 'GROUP' && a.principalName === 'Developers').map((a) => sso(env)!.permissionSets.find((p) => p.arn === a.permissionSetArn)?.name);
const prodReadOnly = (env: AwsEnv) => {
  const ro = readOnly(env);
  const on = devsOn(env, ORG_ACCOUNTS.prod);
  return !!ro && on.length === 1 && on[0] === ro.name;
};
const nodeCanDev = (env: AwsEnv) => portalAccess(env, 'node').some((a) => a.accountId === ORG_ACCOUNTS.dev);

export const lesson41: Lesson = {
  id: 'identity-center',
  number: '41',
  title: 'IAM Identity Center で人のアクセスを管理する',
  summary: '開発者全員が本番の管理者になっている。許可セットと割り当てで、本番は読み取り専用にする',
  minutes: 25,
  startPath: '/sso/home',
  scenario: ssoEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、アカウントが増えたら、それぞれに IAM ユーザーを作るんですか？ パスワードとアクセスキーが何個も…'),
        hakase('アカウントが 6 つで開発者が 10 人なら、60 組だな。'),
        node('付箋が足りません。'),
        hakase('付箋に書くでない。Lesson 22 で、アクセスキーは期限のない長期の鍵だから、漏れたら終わりだと言ったろう。退職者の鍵を 1 本消し忘れただけで、元社員が本番に入れてしまう。'),
        node('それは怖すぎます。'),
        hakase('だから人のアクセスは **IAM Identity Center** にまとめる。人は 1 か所でサインインし、そこから各アカウントに **一時的な認証情報** で入る。'),
        node('前回、sato さんとして試した AWS アクセスポータルが、その入口でしたよね。'),
        hakase('うむ。アクセスポータルは社員通用口だ。社員証 1 枚で、入ってよいビルとフロアにだけ入れる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('どのビルに入れるかは、どうやって決めるんですか？'),
        hakase('部品は 2 つだ。1 つ目が **許可セット**。「そのアカウントの中で何ができるか」のテンプレートだ。AWS が用意した **事前定義された許可セット** には、何でもできる `AdministratorAccess` や、見るだけの `ReadOnlyAccess` などがある。'),
        node('社員証の「役職」みたいなものですね。'),
        hakase('2 つ目が **割り当て**。「どのアカウントで・誰に・どの許可セットを」の組み合わせだ。割り当てると、そのアカウントに `AWSReservedSSO_…` という IAM ロールが自動で作られ、サインインした人はそのロールを引き受ける。'),
        node('IAM ロールは、Lesson 22 で EC2 に付けた、一時的な権限を借りるやつですよね。だから長期のアクセスキーがいらないんだ。'),
        hakase('そうだ。一時的な認証情報は、許可セットの **セッション期間** (今の AdministratorAccess は 4 時間) が過ぎると切れる。割り当ての「誰に」には、ユーザー 1 人ずつではなく **グループ** を指定するのがよい。今回は Developers と Operators がある。'),
        node('人が異動しても、グループのメンバーを入れ替えるだけで済みますね。'),
        hakase('うむ。さて、今日の相談は、その Developers グループのことだ。'),
        node('嫌な予感がします。僕、Developers ですよね。'),
        hakase('君の予感は、障害のときだけよく当たるな。アクセスポータルで node を選べば、君が入れるアカウントと許可セットが一覧で出る。自分の目で確かめたまえ。'),
      ],
    },
    {
      type: 'exercise',
      title: '今のアクセスを確かめる',
      objective: 'IAM Identity Center の **AWS アクセスポータル** で、ユーザー `node` がどのアカウントにどの許可セットで入れるかを見る',
      tasks: [{ id: 'portal', title: 'AWS アクセスポータル → ユーザー `node` を選択', hint: '左メニューの **AWS アクセスポータル** を開き、「サインインするユーザー」で選びます。表示された各アカウントの **OU** と **許可セット (ロール)** の組み合わせに注目します。', done: (c) => visitedQuery(c, '/sso/portal', { user: 'node' }) }],
      validate: (c) =>
        visitedQuery(c, '/sso/portal', { user: 'node' })
          ? ok(
              node('dev も staging も prod も、全部 AdministratorAccess です… 僕、本番の管理者なんですか！？'),
              hakase('Developers グループに、全アカウントの AdministratorAccess が割り当てられておる。Lesson 34 で言った **最小権限** に真っ向から反しておる。'),
              node('必要な操作を、必要な場所にだけ許す、でしたよね。'),
              hakase('そうだ。開発者が本番でやるのは、ログや設定を「見る」ことまでだ。本番は読み取り専用で十分。君に本番の削除ボタンを渡すのは、猫に金魚の見張りを頼むようなものだ。'),
            )
          : ng(hakase('まだポータルを見ておらん。IAM Identity Center > AWS アクセスポータルで、サインインするユーザーに node を選ぶのだ。')),
    },
    {
      type: 'exercise',
      title: '読み取り専用の許可セットを作る',
      objective: '事前定義された許可セット **ReadOnlyAccess** を作成する',
      tasks: [{ id: 'ps', title: '許可セット → **許可セットを作成** → ReadOnlyAccess', hint: '「事前定義された許可セットのポリシー」の一覧から選びます。許可セット名を空欄にすると、ポリシー名と同じ名前になります。', hotspotId: 'sso-create-ps', done: (c) => !!readOnly(c.env) }],
      validate: (c) =>
        readOnly(c.env)
          ? ok(
              hakase('許可セット ReadOnlyAccess ができた。だが、作っただけではまだ誰も使えん。'),
              node('役職を作っただけで、まだ誰にも辞令を出してない、と。'),
              hakase('うむ。アカウントに割り当てると、そのアカウントに `AWSReservedSSO_ReadOnlyAccess_…` というロールが作られて、初めて使えるようになる。'),
            )
          : ng(hakase('ReadOnlyAccess の許可セットがまだない。IAM Identity Center > 許可セットの「許可セットを作成」で、事前定義された許可セットから ReadOnlyAccess を選ぶのだ。')),
    },
    {
      type: 'exercise',
      title: '本番の割り当てを直す',
      objective: '`webapp-prod` で、Developers グループに ReadOnlyAccess を割り当て、AdministratorAccess の割り当てを削除する (開発アカウントの権限はそのまま)',
      tasks: [
        { id: 'assign', title: 'AWS アカウント → `webapp-prod` → **ユーザーまたはグループを割り当て** → グループ Developers、許可セット ReadOnlyAccess', hint: 'IAM Identity Center > AWS アカウント の一覧で `webapp-prod` の名前をクリックします。**グループ (推奨)** のまま Developers を選び、許可セットを選んで **送信** します。', hotspotId: 'sso-assign', done: (c) => !!readOnly(c.env) && devsOn(c.env, ORG_ACCOUNTS.prod).includes(readOnly(c.env)!.name) },
        { id: 'remove', title: 'Developers の AdministratorAccess を選んで **アクセスを削除**', hint: '`webapp-prod` の画面の表で、タイプが **グループ**、名前が Developers、許可セットが AdministratorAccess の行を選びます。Operators の AdministratorAccess は運用担当の分なので残します。', hotspotId: 'sso-remove-access', done: (c) => prodReadOnly(c.env) },
      ],
      validate: (c) => {
        if (!nodeCanDev(c.env)) return ng(hakase('開発アカウントの割り当てまで消してしまった。開発者が開発できなくなるぞ。webapp-dev で、Developers に AdministratorAccess を割り当て直すのだ。'));
        if (!prodReadOnly(c.env)) return ng(hakase('webapp-prod での Developers の許可セットを、ReadOnlyAccess だけにするのだ。ReadOnlyAccess を割り当てたら、Developers の AdministratorAccess の行を選んで「アクセスを削除」したまえ。'));
        return ok(
          hakase('よし。本番の Developers は ReadOnlyAccess だけになった。'),
          node('グループ単位だから、新人が来ても Developers に入れるだけで同じ権限になりますね。'),
          hakase('うむ。人が入れ替わってもグループのメンバーを変えるだけで済む。退職者は Identity Center のユーザーを無効にすれば、全アカウントへのサインインを一度に止められる。付箋を 60 枚探し回る必要はない。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '本番でできること・できないことを確かめる',
      objective: 'アクセスポータルで `node` として webapp-prod (ReadOnlyAccess) にサインインし、`ec2:DescribeInstances` は許可、`ec2:TerminateInstances` は拒否されることを確かめる',
      tasks: [
        { id: 'read', title: '`ec2:DescribeInstances` → 許可', hint: 'ポータルで `node` を選び、webapp-prod の ReadOnlyAccess の行で **アクセスを試す** を押します。アクション欄に入力して **実行** します。', hotspotId: 'sso-portal-run', done: (c) => prodReadOnly(c.env) && visitedQuery(c, '/sso/portal', { user: 'node', account: ORG_ACCOUNTS.prod, ps: 'ReadOnlyAccess', action: 'ec2:DescribeInstances' }) },
        { id: 'write', title: '`ec2:TerminateInstances` → 拒否', hint: 'アクション欄を書き換えて、もう一度 **実行** します。結果の「許可セットのポリシー」の行で、拒否の理由を確認できます。', done: (c) => prodReadOnly(c.env) && visitedQuery(c, '/sso/portal', { user: 'node', account: ORG_ACCOUNTS.prod, ps: 'ReadOnlyAccess', action: 'ec2:TerminateInstances' }) },
      ],
      validate: (c) =>
        prodReadOnly(c.env) && ['ec2:DescribeInstances', 'ec2:TerminateInstances'].every((action) => visitedQuery(c, '/sso/portal', { user: 'node', account: ORG_ACCOUNTS.prod, ps: 'ReadOnlyAccess', action }))
          ? ok(
              node('見るのは OK、消すのは `no identity-based policy allows` で拒否です。'),
              hakase('Lesson 23 で見たのと同じ、「許可しているポリシーがない」という拒否だ。今回は SCP ではなく、許可セットが止めた。'),
              node('これで僕が、うっかり本番を壊すことはないですね。'),
              hakase('うっかりはな。本番を変えるときは、レビュー付きのデプロイの仕組みを通すか、Operators の運用担当に頼むのだ。'),
              node('わざとなら壊せるみたいな言い方、やめてください。'),
            )
          : ng(hakase('2 つのアクションをまだ試しておらん。アクセスポータルで node を選び、webapp-prod (ReadOnlyAccess) で ec2:DescribeInstances と ec2:TerminateInstances を 1 回ずつ実行するのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。IAM Identity Center を使う一番の利点はどれかな？'),
      options: ['アカウントごとに IAM ユーザーとアクセスキーを作れる', '1 か所で人を管理し、各アカウントには一時的な認証情報でアクセスできる', 'SCP が不要になる'],
      answer: 1,
      explanation: [
        hakase('正解。長期のアクセスキーが漏れる心配がなく、退職者のアクセスも 1 か所で止められる。'),
        hakase('SCP とは役割が違う。SCP はアカウントの上限、許可セットは人の権限だ。両方を組み合わせるのだ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では最後だ。node が本番で ec2:TerminateInstances できるのは、どんなときかな？'),
      options: ['許可セットが許可していれば、いつでも', 'SCP が許可していれば、いつでも', '許可セットと SCP の両方が許可しているときだけ'],
      answer: 2,
      explanation: [
        hakase('正解。人に与えた権限 (許可セット) と、アカウントのガードレール (SCP) の両方を通った操作だけが実行できる。'),
        node('許可証と館内ルール、両方ですね。'),
        hakase('うむ。もっとも、両方を通っても君にはやらせんがな。'),
      ],
    },
  ],
};
