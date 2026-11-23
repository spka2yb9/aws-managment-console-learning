import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { controlStatus, fresh, securityScore, type Finding } from '../sim/ext/securityhub';
import { NEWSLETTER_BUCKET, securityHubEnv } from '../sim/ext/securityhub-scenario';
import type { AwsEnv } from '../sim/types';
import { albReachesWeb, visited } from './helpers';

/* 判定は、まだ時計が進んでいない変更も反映した Security Hub で行う (コンソールの画面と同じ) */
export const hubOn = (env: AwsEnv) => !!env.securityHub?.hub;
export const fsbpOn = (env: AwsEnv) => hubOn(env) && !!env.securityHub?.standards.some((s) => s.key === 'fsbp');
export const passed = (env: AwsEnv, id: string) => hubOn(env) && controlStatus(fresh(env), id) === 'PASSED';
export const scoreOf = (env: AwsEnv) => securityScore(fresh(env));
export const newsletterFinding = (env: AwsEnv): Finding | undefined => fresh(env).securityHub?.findings.find((f) => f.controlId === 'S3.8' && f.resource.id === `arn:aws:s3:::${NEWSLETTER_BUCKET}`);
export const suppressedWithNote = (env: AwsEnv) => {
  const f = newsletterFinding(env);
  return f?.workflow === 'SUPPRESSED' && !!f.note?.text.trim();
};
/** 失敗した検出結果を、ニュースレターのバケットのほかにも抑制した */
export const overSuppressed = (env: AwsEnv) => {
  const keep = newsletterFinding(env)?.id;
  return !!fresh(env).securityHub?.findings.some((f) => f.controlId && f.compliance === 'FAILED' && f.workflow === 'SUPPRESSED' && f.id !== keep);
};
/** Environment = dev のリソースの検出結果を、重要度 LOW にしてメモを付ける有効なルール */
export const devRule = (env: AwsEnv) =>
  env.securityHub?.automationRules.find(
    (r) =>
      r.ruleStatus === 'ENABLED' &&
      (r.criteria.ResourceTags ?? []).some((x) => x.Key === 'Environment' && x.Value === 'dev' && x.Comparison === 'EQUALS') &&
      r.actions.some((a) => a.FindingFieldsUpdate.Severity?.Label === 'LOW' && !!a.FindingFieldsUpdate.Note?.Text?.trim()),
  );
const scoreLine = (c: TaskContext) => {
  const s = scoreOf(c.env);
  return `${s.score ?? '-'}% (${s.total} 件中 ${s.passed} 件が合格)`;
};

export const lesson44: Lesson = {
  id: 'security-hub',
  number: '44',
  title: 'Security Hub CSPM でセキュリティを採点して直す',
  summary: 'セキュリティ標準でアカウントを自動でチェックし、スコアと重要度で順番を決めて直す。対応しないものは理由を残して抑制し、自動化ルールで仕分ける',
  minutes: 25,
  startPath: '/console/home',
  scenario: securityHubEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、部長に「うちの AWS、結局どのくらい安全なの？ 一言で」と聞かれました。'),
        hakase('ほう。それで君は何と答えた。'),
        node('「たぶん大丈夫です」って。'),
        hakase('「たぶん」で始まる報告は、障害報告書の書き出しとしては満点だな。'),
        node('障害報告書にしないでください。でも、SSH の全開放とか公開バケットとか、今までいろいろありましたよね。'),
        hakase('Lesson 27 では AWS Config のルールで、Lesson 43 では GuardDuty で見つけたな。道具は増えたが、結果はばらばらの画面に散らばっておる。'),
        node('Config の画面を見て、GuardDuty の画面を見て… 一言で答えるには、全部回らないといけないんですね。'),
        hakase('そこで AWS Security Hub だ。決まったチェック項目でアカウント全体を自動で採点し、ほかのサービスの結果も 1 か所に集める。'),
        node('せきゅりてぃはぶ。ハブって、自転車の車輪の真ん中のあれですか。'),
        hakase('そうだ。スポークが全部集まる真ん中の部品だ。セキュリティの情報が集まる真ん中、というわけだ。'),
        node('部長が欲しい「一言」が出てくる場所ってことですね。'),
        hakase('出てくるのは一言ではなく数字だがな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('ただし名前に注意が要る。2025 年に、これまでの Security Hub は「Security Hub CSPM」という名前に変わった。'),
        node('しーえすぴーえむ？'),
        hakase('Cloud Security Posture Management の略だ。posture は「姿勢」。クラウドの設定に危ない所がないかを見て、セキュリティの姿勢を正しておく、という意味だ。'),
        node('猫背を直す整体みたいなものですか。'),
        hakase('近い。背骨の代わりに、セキュリティグループやバケットの設定を見る。'),
        node('じゃあ「Security Hub」という名前のほうは？'),
        hakase('Security Hub CSPM や GuardDuty などの結果を、さらにまとめて分析する新しいサービスの名前になった。今日使うのは、採点をする Security Hub CSPM のほうだ。'),
        node('部署の名前が変わって、元の名前を新しい部署が使ってるんですね。'),
        hakase('名刺を刷り直す総務の苦労まで、そっくり同じだな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('採点って、何を基準にするんですか？'),
        hakase('セキュリティ標準だ。チェック項目のまとまりのことで、今日は AWS が作った「AWS 基礎セキュリティのベストプラクティス」を使う。英語の頭文字で FSBP とも呼ぶ。'),
        node('べすとぷらくてぃす… 「こうするのがいちばん良い」というお手本ですね。'),
        hakase('そうだ。CIS という団体が作った「CIS AWS Foundations Benchmark」という標準もあって、有効にするときは、この 2 つが最初から選ばれておる。'),
        node('標準の中身は、どうなってるんです？'),
        hakase('コントロールと呼ぶチェック項目が並んでおる。たとえば EC2.19 は「セキュリティグループは、リスクの高いポートへの無制限アクセスを許可してはいけません」だ。'),
        node('こんとろーる。EC2.19 は、EC2 の 19 番のチェックってことですか。'),
        hakase('そうだ。コントロールが 1 つのリソースを調べた結果を、検出結果と呼ぶ。セキュリティグループが 5 つあれば、EC2.19 の検出結果は 5 つできる。'),
        node('健康診断なら、検査項目がコントロールで、一人ひとりの結果票が検出結果ですね。'),
        hakase('例えが上手くなったな。給料は上がらんが。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('健康診断なら、最後に「総合判定 A」みたいなのが出ますよね。'),
        hakase('それがセキュリティスコアだ。有効なコントロールのうち、合格したものの割合を 0〜100% で出す。部長への「一言」はこれだな。'),
        node('全部のコントロールで割るんですか。'),
        hakase('割る数は、合格・失敗・不明のコントロールの数だ。調べた結果がまだない「データなし」のものは数えん。'),
        node('どれから直せばいいかは、どうやって決めるんです？'),
        hakase('コントロールごとに重要度が決まっておる。重大・高・中・低・情報の 5 段階で、放っておいたときにどれだけ危ないかの目安だ。重大から順に片付ける。'),
        node('救急外来のトリアージですね。'),
        hakase('そうだ。かすり傷の患者から手当てしていたら、隣で重症の患者が手遅れになる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('検出結果は ASFF という決まった形の JSON で保存される。AWS Security Finding Format、AWS のセキュリティの検出結果の形式だ。GuardDuty の結果も同じ形で届くから、1 か所に並べられる。'),
        node('履歴書の書式をそろえると、比べやすくなるのと同じですね。'),
        hakase('それから、コントロールの多くは、中で Lesson 27 の AWS Config のルールを使っておる。設定が変わると、すぐにチェックし直す。'),
        node('健康診断係の Config の上に、採点係の Security Hub CSPM がいる二階建てなんですね。'),
        hakase('うまいことを言う。ただ、本物のスコアの更新は 24 時間ごとだ。このシミュレーターでは、すぐに計算し直すぞ。'),
        node('本物だと、直してから 1 日待たないと部長に自慢できないんですね。'),
      ],
    },
    {
      type: 'table',
      title: 'Security Hub CSPM の言葉',
      columns: ['言葉', '意味', '例'],
      rows: [
        ['セキュリティ標準', 'チェック項目のまとまり', 'AWS 基礎セキュリティのベストプラクティス v1.0.0'],
        ['コントロール', '1 つのチェック項目。重要度が決まっている', 'EC2.19 (重大)、RDS.2 (重大)'],
        ['検出結果', 'コントロールが 1 つのリソースを調べた結果 (ASFF の JSON)。ほかのサービスから届くものもある', 'web-sg は EC2.19 に「失敗」'],
        ['重要度', '放っておいたときの危なさ', '重大 / 高 / 中 / 低 / 情報'],
        ['セキュリティスコア', '合格したコントロールの割合', '11 件中 4 件が合格なら 36%'],
      ],
    },
    {
      type: 'exercise',
      title: 'Security Hub CSPM を有効にする',
      objective: 'Security Hub CSPM を有効にする。セキュリティ標準は、最初から選ばれている 2 つのままにする',
      tasks: [
        { id: 'open', title: '検索バーで `security hub` → Security Hub を開く', hint: 'まだ有効にしていないので、「Security Hub CSPM を有効にする」の画面が開きます。', done: (c) => visited(c, '/securityhub/home') },
        {
          id: 'enable',
          title: '「AWS 基礎セキュリティのベストプラクティス v1.0.0 を有効化」にチェックが入っていることを確かめ、「Security Hub CSPM を有効にする」を押す',
          hint: 'セキュリティ標準のチェックボックスは 2 つとも入れたままにします。有効にすると、すぐに「概要」の画面に変わります。',
          hotspotId: 'sh-enable',
          done: (c) => fsbpOn(c.env),
        },
      ],
      validate: (c) => {
        if (!hubOn(c.env)) return ng(hakase('まだ Security Hub CSPM が有効になっておらん。検索バーで `security hub` と打って開き、「Security Hub CSPM を有効にする」を押すのだ。'));
        if (!fsbpOn(c.env)) return ng(hakase('AWS 基礎セキュリティのベストプラクティスの標準が有効になっておらん。左のメニューの「セキュリティ標準」で「標準を有効化」を押すのだ。'));
        return ok(
          node(`スコアが出ました。${scoreLine(c)}… 合格のほうが少ないです。`),
          hakase('部長に「たぶん大丈夫です」と答えた口で、この数字を報告するわけだ。'),
          node('今さらっと怖いこと言いましたよね。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('概要の「失敗したコントロール」を見ると、重大が 2 つ、高もずらっと並んでます。どこから手を付けましょう。'),
        hakase('トリアージだと言ったろう。重大の 2 つ、EC2.19 と RDS.2 からだ。'),
        node('RDS.2 は、RDS のパブリックアクセスのチェックですね。'),
        hakase('そうだ。まずは「コントロール」の画面で全体を見てから、EC2.19 がどのリソースで失敗しておるかを確かめる。'),
        node('犯人の顔を見てから捕まえるんですね。'),
        hakase('捕まえるのではない、直すのだ。君は刑事ドラマの見すぎだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'どのリソースが失敗しているかを見る',
      objective: '「コントロール」でコントロールのステータスと重要度を確かめ、EC2.19 の詳細で失敗しているリソースを見る',
      tasks: [
        { id: 'controls', title: '左のメニューの「コントロール」を開く', hint: '失敗したコントロールが上に、重要度の高い順に並びます。「ステータス」の「失敗」で絞ることもできます。', done: (c) => visited(c, '/securityhub/controls') },
        { id: 'ec2-19', title: '`EC2.19` を開き、「チェック」で失敗しているリソースを見る', hint: 'ID 列の `EC2.19` をクリックします。「チェック」の表で、コンプライアンスのステータスが「失敗」の行がそのリソースです。', done: (c) => visited(c, '/securityhub/controls/EC2.19') },
      ],
      validate: (c) =>
        visited(c, '/securityhub/controls/EC2.19')
          ? ok(
              node('web-sg が失敗してます。リスクの高いポートの一覧に、SSH の 22 番が入ってるんですね。'),
              hakase('22 (SSH)、3306 (MySQL)、3389 (RDP) のように、狙われやすいポートの一覧だ。Lesson 27 で閉じたはずの穴が、また開いておる。'),
              node('ゾンビ映画の続編みたいですね。'),
              hakase('しかも続編のほうが予算が大きい。'),
            )
          : ng(hakase('左のメニューの「コントロール」を開いて、ID 列の `EC2.19` をクリックするのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('直し方は Lesson 27 と同じで、web-sg から SSH のルールを消せばいいですよね。'),
        hakase('そうだ。ALB からの 3000 番は消すでないぞ。サイトが止まる。'),
        node('web-sg は、EC2.18 にも引っかかってました。'),
        hakase('EC2.18 は「80 と 443 以外のポートを全世界に開けていないか」を見る。同じ SSH のルールが原因だから、1 か所直せば両方とも合格する。CIS の標準の EC2.13 もな。'),
        node('一石二鳥、いや三鳥ですね。RDS.2 のほうは？'),
        hakase('webapp-db の「パブリックアクセス可能」が「はい」になっておる。Lesson 14 で作ったときは「なし」だったはずだ。'),
        node('プライベートサブネットにあるから、外からはつながらないんじゃないですか？'),
        hakase('今はな。誰かがルートテーブルを変えた瞬間に、DB がインターネットに顔を出す。鍵をかけ忘れた金庫を、奥の部屋に置いて安心しておるようなものだ。'),
        node('部屋のドアが開いたら終わりなんですね。RDS の「変更」で「パブリックアクセス不可」にします。'),
      ],
    },
    {
      type: 'exercise',
      title: '重大の 2 つを直す',
      objective: '`web-sg` から 0.0.0.0/0 の SSH (22 番) のルールを削除し、`webapp-db` をパブリックアクセス不可にして、EC2.19 と RDS.2 を合格にする。ALB からの TCP 3000 は残すこと',
      tasks: [
        {
          id: 'sg',
          title: 'EC2 > セキュリティグループ > `web-sg` → インバウンドのルールを編集 → 0.0.0.0/0 の SSH の行を削除 → ルールを保存',
          hint: '消すのは、ソースが `0.0.0.0/0` でポートが 22 の行だけです。保存すると、すぐに EC2.19 のチェックがやり直されます。',
          hotspotId: 'sg-save-rules',
          done: (c) => passed(c.env, 'EC2.19'),
        },
        {
          id: 'db',
          title: 'RDS > データベース > `webapp-db` → 変更 → パブリックアクセスを「パブリックアクセス不可」→ 続行 → すぐに適用 → DB インスタンスを変更',
          hint: '「パブリックアクセス」は「接続」の欄にあります。ほかの項目は変えません。',
          done: (c) => passed(c.env, 'RDS.2'),
        },
      ],
      validate: (c) => {
        if (!albReachesWeb(c.env)) return ng(hakase('ALB からの 3000 番まで消してしまったぞ！ これではサイトが止まる。web-sg に、ソースが `alb-sg` の TCP 3000 のルールを戻すのだ。'));
        if (!passed(c.env, 'EC2.19')) return ng(hakase('まだ web-sg が 0.0.0.0/0 からの SSH を許可しておる。EC2 > セキュリティグループ > web-sg のインバウンドのルールで、ソースが 0.0.0.0/0 でポートが 22 の行を削除して保存するのだ。'));
        if (!passed(c.env, 'RDS.2')) return ng(hakase('webapp-db がまだパブリックアクセス可能だ。RDS > データベース > webapp-db の「変更」で、パブリックアクセスを「パブリックアクセス不可」にするのだ。'));
        return ok(
          node(`EC2.19 も RDS.2 も「合格」になりました。スコアは ${scoreLine(c)} です。`),
          hakase('EC2.18 も一緒に合格しておる。1 本のルールが、何人分も足を引っ張っておったわけだ。'),
          node('合格した検出結果は「解決済み」になってます。'),
          hakase('それはワークフローのステータス、つまり対応の進み具合だ。コントロールの検出結果は、合格すると自動で解決済みになる。また誰かが SSH を開けたら、新規に戻って一覧の上に出てくるぞ。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node(`次は S3.8 です。${NEWSLETTER_BUCKET} のバケットが、ブロックパブリックアクセスをオフにしてます。これもオンにしましょう。`),
        hakase('待て。そのバケットは、メールマガジンに載せる画像を置く場所だ。誰でも見られないと、届いたメールの画像が全部欠ける。'),
        node('ああ、わざと公開してるんですね。じゃあ失敗のままですか？'),
        hakase('確かめたうえで「対応は要らない」と決めた検出結果は、ワークフローのステータスを「抑制済み」にする。'),
        node('わーくふろーのすてーたす、さっきの「対応の進み具合」ですね。'),
        hakase('新規、通知済み、抑制済み、解決済みの 4 つがある。通知済みは、リソースの持ち主に知らせて、対応を待っている状態だ。'),
        node('抑制した検出結果はどうなるんです？'),
        hakase('コントロールのステータスを決めるときに数えん。だからスコアも上がる。'),
        node('えっ、じゃあ失敗したのを全部抑制すれば、スコア 100% ですね！'),
        hakase('帳簿から赤字の行を消して「黒字です」と報告するようなものだ。次の監査で消えるのは、赤字ではなく君の名刺だぞ。'),
        node('…S3.8 をコントロールごと無効にするのは？'),
        hakase('ほかのバケットのチェックまで止まる。明日だれかが別のバケットをうっかり公開しても、誰も気づかん。'),
        node('じゃあ、このバケットの検出結果だけを、理由を書いて抑制するんですね。'),
        hakase('そうだ。理由はメモに残す。半年後に見た人が、同じ議論を最初からやり直さずに済む。'),
      ],
    },
    {
      type: 'exercise',
      title: 'わざと公開しているバケットの検出結果を抑制する',
      objective: `S3.8 の \`${NEWSLETTER_BUCKET}\` の検出結果を、理由のメモを付けて「抑制済み」にする。ほかの失敗した検出結果は抑制しないこと`,
      tasks: [
        {
          id: 'suppress',
          title: 'コントロール > `S3.8` → チェックで `webapp-newsletter-…` の行を選択 → ワークフローのステータス → 抑制済み → メモを書いて「ステータスの設定」',
          hint: '「検出結果」の画面で選んでもかまいません。メモには、公開している理由 (メールマガジンの画像) を書きます。',
          hotspotId: 'sh-workflow',
          done: (c) => suppressedWithNote(c.env),
        },
      ],
      validate: (c) => {
        if (newsletterFinding(c.env)?.compliance === 'PASSED') return ng(hakase('ブロックパブリックアクセスをオンにしたな。これではメールの画像が全部欠ける。S3 で 4 つともオフに戻して、検出結果のほうを抑制するのだ。'));
        if (overSuppressed(c.env)) return ng(hakase('ほかの失敗した検出結果まで抑制しておるぞ。対応が要らないと確かめたものか？ その検出結果を選んで、ワークフローのステータスを「新規」に戻すのだ。'));
        if (newsletterFinding(c.env)?.workflow === 'SUPPRESSED' && !suppressedWithNote(c.env)) return ng(hakase('メモが空だ。もう一度その検出結果を選んで「抑制済み」を選び、公開している理由をメモに書くのだ。'));
        return suppressedWithNote(c.env)
          ? ok(
              node(`S3.8 が「合格」になりました。スコアは ${scoreLine(c)} です。`),
              hakase('メモは検出結果に残る。監査で「なぜ公開しているのか」と聞かれたら、これを見せればよい。'),
              node('未来の自分への手紙ですね。'),
              hakase('未来の君が、手紙を読む習慣を身に付けておればな。'),
            )
          : ng(hakase(`コントロールの \`S3.8\` を開いて、\`${NEWSLETTER_BUCKET}\` の行を選び、「ワークフローのステータス」から「抑制済み」を選ぶのだ。メモに理由を書いて「ステータスの設定」を押す。`));
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('残った失敗は EC2.2 と、EC2.8 と EC2.9 です。EC2.8 と EC2.9 は dev-sandbox ですね。'),
        hakase('dev-sandbox は開発チームの実験用のサーバーだ。Environment タグが dev になっておる。'),
        node('EC2.9 はパブリック IP、EC2.8 は IMDSv2 ですね。IMDSv2 は Lesson 43 で出てきました。'),
        hakase('インスタンスの中から認証情報を盗まれにくくする、メタデータの取り出し方だったな。どちらも「高」だ。ただ、中身は本番ではないから、本番と同じ「高」で並ぶと、本当に急ぐものが埋もれる。'),
        node('開発チームは毎週サーバーを作り直してますし、そのたびに手で重要度を変えるのは大変です。'),
        hakase('そこで自動化ルールだ。条件に合う検出結果が作られたり更新されたりしたときに、重要度やワークフローのステータス、メモを自動で書き換える。'),
        node('メールの振り分けルールみたいなものですね。「件名に〇〇があったらこのフォルダへ」っていう。'),
        hakase('そうだ。今回は「リソースタグの Environment が dev なら、重要度を低にしてメモを付ける」だ。'),
        node('作ったら、今ある dev-sandbox の検出結果もすぐ低になるんですか？'),
        hakase('ならん。ルールが適用されるのは、作ったあとに作られた検出結果と、更新された検出結果だ。dev-sandbox の設定が変わったときや、定期的なチェックで検出結果が更新されたときに適用される。'),
        node('過去にさかのぼらない法律みたいですね。'),
        hakase('どの検出結果が条件に合うかは、作成画面のプレビューで確かめられる。ルールがいくつもあるときは、ルールの順序の数字が小さいものから適用されるぞ。'),
      ],
    },
    {
      type: 'exercise',
      title: '開発環境の検出結果を自動で仕分けるルールを作る',
      objective: '自動化ルールを作る。基準は ResourceTags の Environment が dev に EQUALS、自動アクションは重要度を LOW にしてメモを付ける',
      tasks: [
        {
          id: 'rule',
          title: 'オートメーション → ルールを作成 → ルール名と説明 → 基準: キー ResourceTags、タグキー Environment、オペレータ EQUALS、値 dev → 自動アクション: 重要度 LOW、メモ → ルールを作成',
          hint: 'ルール名は `dev-low-priority` のように用途がわかる名前にします。値まで入れると、プレビューに dev-sandbox と dev-sg の検出結果が並びます。ルールステータスは「有効」のままです。',
          hotspotId: 'sh-create-rule',
          done: (c) => !!devRule(c.env),
        },
      ],
      validate: (c) => {
        const rules = c.env.securityHub?.automationRules ?? [];
        if (!rules.length) return ng(hakase('まだルールがない。左のメニューの「オートメーション」で「ルールを作成」を押すのだ。'));
        if (devRule(c.env))
          return ok(
            node('ルールができました。プレビューに dev-sandbox と dev-sg の検出結果が並んでました。'),
            hakase('次に dev-sandbox の検出結果が更新されたときから、重要度が自動で低になる。開発チームがサーバーを作り直すたびに、手で書き換えずに済む。'),
            node('残りは EC2.2 ですね。'),
            hakase('VPC の default のセキュリティグループのルールを空にする、だ。そのグループを使っておるリソースがないことを確かめてからやる。それは宿題にしておこう。'),
          );
        if (rules.some((r) => r.ruleStatus !== 'ENABLED')) return ng(hakase('ルールステータスが「無効」のルールがある。無効のルールは何もせん。削除して、「有効」で作り直すのだ。'));
        return ng(hakase('条件かアクションが違う。基準はキー ResourceTags、タグキー Environment、オペレータ EQUALS、値 dev。自動アクションは重要度を LOW にして、メモも書く。違うルールは削除して作り直すのだ。'));
      },
    },
    {
      type: 'quiz',
      question: hakase('では確認だ。セキュリティスコアを上げる正しい方法はどれかな？'),
      options: ['失敗した検出結果のリソースを直すか、対応が要らないと確かめたものを、理由を書いて抑制する', 'セキュリティ標準をすべて無効にする', '失敗した検出結果をすべて抑制する'],
      answer: 0,
      explanation: [
        hakase('正解。直すのが本筋で、抑制は確かめたうえでの例外だ。'),
        node('標準を全部無効にするのは、体重計を捨てて「ダイエット成功」と言うのと同じですね。'),
        hakase('数字が出なくなるだけで、腹は出たままだ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('月曜に、dev タグの自動化ルールを作った。先週から変わっておらん dev-sandbox の検出結果は、ルールを作った瞬間にどうなるかな？'),
      options: ['すぐに重要度が低になる', '次に検出結果が更新されるまで変わらない', '削除される'],
      answer: 1,
      explanation: [
        hakase('正解。自動化ルールが適用されるのは、作ったあとに作られた検出結果と、更新された検出結果だ。'),
        node('リソースの設定が変わるか、定期的なチェックで更新されたときですね。'),
        hakase('うむ。今すぐ変えたいものは、検出結果を選んで手で変えればよい。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後だ。Security Hub CSPM の「コントロール」とは何かな？'),
      options: ['セキュリティ標準の 1 つのチェック項目', 'リソースを操作するための IAM ポリシー', 'GuardDuty が見つけた攻撃'],
      answer: 0,
      explanation: [
        hakase('正解。コントロールが 1 つのリソースを調べた結果が検出結果で、合格したコントロールの割合がセキュリティスコアだ。'),
        node('検査項目、結果票、総合判定ですね。これで部長に数字で答えられます。'),
        hakase('「たぶん」を付けずに答えるのだぞ。'),
      ],
    },
  ],
};
