import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { evaluateIamPermission } from '../sim/iam';
import { reportEnv, REPORTS_BUCKET } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { visited, visitedQuery } from './helpers';

const failedJobs = (env: AwsEnv) => env.batchJobs.filter((j) => j.status === 'FAILED');
const openedFailed = (c: TaskContext) => failedJobs(c.env).some((j) => visited(c, `/batch/jobs/${j.jobId}`));
const sawJobLog = (c: TaskContext) => visitedQuery(c, '/cloudwatch/logs/events', { group: '/aws/batch/job' });
const canWrite = (env: AwsEnv) => evaluateIamPermission(env, { principal: { type: 'role', roleName: 'report-job-role', sessionName: 'job' }, action: 's3:PutObject', resource: `arn:aws:s3:::${REPORTS_BUCKET}/reports/daily-2026-09-30.csv` }).decision === 'Allow';
const reportSaved = (env: AwsEnv) => !!env.buckets.find((b) => b.name === REPORTS_BUCKET)?.objects.some((o) => o.key.startsWith('reports/daily-'));
const learnerJob = (env: AwsEnv) => env.batchJobs.find((j) => j.submittedBy === 'learner' && j.status === 'SUCCEEDED');
const testRule = (env: AwsEnv) => env.eventRules.find((r) => r.name !== 'daily-report-schedule' && /^rate\(1 minute\)$/.test(r.scheduleExpression));
const ruleJob = (env: AwsEnv) => {
  const r = testRule(env);
  return r && env.batchJobs.find((j) => j.submittedBy === `EventBridge (${r.name})` && j.status === 'SUCCEEDED');
};

export const lesson34: Lesson = {
  id: 'eventbridge-batch',
  number: '34',
  title: 'EventBridge と AWS Batch で定期ジョブ',
  summary: '毎晩のレポートジョブが失敗する原因をジョブのログから突き止め、スケジュール実行を確かめる',
  minutes: 30,
  startPath: '/events/rules',
  scenario: reportEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、毎朝届くはずの日次レポートが、2 日続けて来ていません…'),
        hakase('ほう。営業部長が朝一番に見るあれか。3 日目も来なかったら、部長の顔色が CloudWatch のアラームより先に赤くなるぞ。'),
        node('怖いこと言わないでください。あれって誰が作ってるんですか？'),
        hakase('人ではない。毎晩、**EventBridge** が **AWS Batch** にジョブを投げて作らせておる。'),
        node('いべんとぶりっじ？'),
        hakase('「何かが起きたら、どこかを呼ぶ」配達係だ。きっかけは AWS の中の出来事でもよいし、時計でもよい。その決まりごとを **ルール** に書き、呼び出す先を **ターゲット** という。'),
        node('目覚まし時計みたいなものですか？'),
        hakase('うむ。時計で動くルールには **スケジュール式** を書く。`rate(5 minutes)` なら 5 分ごと、`cron(…)` なら「毎日何時何分」のように時刻で決める。'),
        node('くーろん？'),
        hakase('UNIX の大昔からある時刻指定の書き方だ。`cron(分 時 日 月 曜日 年)` の 6 つを並べる。`*` は「毎〜」、`?` は「指定しない」。日と曜日は、どちらか一方を `?` にする決まりだ。'),
        node('じゃあ 1 分ごとなら `rate(1 minutes)` ですね。'),
        hakase('`rate(1 minute)` だ。1 のときは単数形。英語の文法でエラーになる、なかなか意地の悪い仕様だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('それと大事なことを言っておく。**cron は UTC** だ。UTC だぞ。'),
        node('なんで 2 回言ったんですか。'),
        hakase('毎年どこかで誰かが 9 時間ずらして、真っ昼間に本番の重いジョブを動かすからだ。UTC は世界の基準の時刻で、日本時間 (JST) は UTC に 9 時間足したものだ。'),
        node('UTC の 0 時が、日本の朝 9 時ってことですね。'),
        hakase('うむ。ずらしたら、始末書も 9 時間早く届くと思いたまえ。'),
        node('で、Batch のほうは何ですか？'),
        hakase('**AWS Batch** は、時間のかかる処理をまとめて実行するサービスだ。処理 1 回分を **ジョブ** という。中身は Lesson 32 のタスクと同じコンテナで、今回は Fargate の上で動かしておる。'),
        node('コンテナなら、ECR のイメージから動くんですね。でも Lambda じゃだめなんですか？ Lesson 33 の、呼ばれたときだけ動く関数。'),
        hakase('Lambda は 1 回の実行が最大 15 分までだ。40 分かかる集計を頼んだら、15 分で強制終了される。'),
        node('残業禁止の厳しいバイトさんですね。'),
        hakase('Batch は残業に文句を言わん。そのぶん料金はきっちり取られるがな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ジョブって、どうやって作るんですか？'),
        hakase('**ジョブ定義** に「どのイメージを・どのコマンドで・どの IAM ロールで」動かすかを書く。ECS のタスク定義と同じで、リビジョンで版が増える。`daily-report:1` の `:1` がそれだ。'),
        node('IAM ロールって、Lesson 22 で EC2 に付けた、アクセスキーの代わりに一時的な権限をくれるやつでしたよね。'),
        hakase('そうだ。ジョブの中のプログラムが S3 などを触るときに使うロールを **ジョブロール** という。今回は `report-job-role` だ。'),
        node('ジョブ定義を書いたら、すぐ動くんですか？'),
        hakase('いや、ジョブはまず **ジョブキュー** に並ぶ。キューは Lesson 33 でやった待ち行列だな。並んだジョブを **コンピューティング環境** が拾って、実際に動かす。'),
        node('こんぴゅーてぃんぐかんきょう？'),
        hakase('ジョブを動かす場所だ。EC2 の集まりにもできるが、今回は Fargate だ。注文票がジョブ定義、順番待ちの列がジョブキュー、厨房がコンピューティング環境、というわけだ。'),
        node('また厨房ですか。この会社、食べ物のたとえしかないんですか？'),
        hakase('君がすぐ腹を空かせるからだ。まずは、スケジュールが本当に動いているかを確かめよう。'),
      ],
    },
    {
      type: 'table',
      title: 'EventBridge と Batch の用語',
      columns: ['用語', '意味'],
      rows: [
        ['スケジュール式', '`rate(5 minutes)` (一定間隔) か `cron(分 時 日 月 曜日 年)` (特定の時刻)。**cron は UTC**'],
        ['ターゲット', 'ルールが動いたときに呼び出す先。今回は Batch のジョブキュー'],
        ['ジョブ定義', 'どのイメージを・どの IAM ロール (ジョブロール) で・どのコマンドで動かすか'],
        ['ジョブキュー / コンピューティング環境', 'ジョブの待ち行列と、実際に動かす場所 (今回は Fargate)'],
      ],
    },
    {
      type: 'exercise',
      title: 'スケジュールを確かめる',
      objective: 'EventBridge のルール `daily-report-schedule` を開き、スケジュール式と次のトリガー日時を確認する',
      tasks: [{ id: 'rule', title: 'EventBridge > ルール > `daily-report-schedule`', hint: 'ルール一覧の名前のリンクから詳細を開きます。cron の **スケジュール式** は UTC なので、「次の 3 回のトリガー」に併記された日本時間と見比べます。', done: (c) => visited(c, '/events/rules/daily-report-schedule') }],
      validate: (c) =>
        visited(c, '/events/rules/daily-report-schedule')
          ? ok(
              node('`cron(0 17 * * ? *)` … 17 時？ 夕方に動いてるんですか？'),
              hakase('言ったはずだ、cron は **UTC** だ。UTC の 17:00 に 9 時間足すと？'),
              node('26 時… あ、日本時間の翌日 2:00 ですね！ 「次の 3 回のトリガー」も、日本時間では毎日 2:00 です。'),
              hakase('うむ。スケジュールは正しい。ルールは毎晩ちゃんと動いておる。犯人は別におるのだ。'),
            )
          : ng(hakase('まだルールを見ておらん。EventBridge > ルール から daily-report-schedule を開き、スケジュール式と「次の 3 回のトリガー」を読むのだ。')),
    },
    {
      type: 'exercise',
      title: '失敗したジョブを調べる',
      objective: 'AWS Batch のジョブ一覧で失敗した `daily-report` ジョブを開き、ログストリームで原因を確認する',
      tasks: [
        { id: 'job', title: 'Batch > ジョブ → ステータスが FAILED のジョブを開く', hint: 'ジョブ一覧の **ステータス** 列で FAILED の行を探し、**ジョブ名** のリンクから詳細を開きます。「ステータスの理由」と「終了コード」も確認します。', done: openedFailed },
        { id: 'log', title: 'ジョブの **ログストリーム名** のリンクからログを開く', hint: 'リンク先は CloudWatch Logs のロググループ `/aws/batch/job` です。エラーの行で、どのロールがどの操作を断られたかを読み取ります。', done: sawJobLog },
      ],
      validate: (c) =>
        openedFailed(c) && sawJobLog(c)
          ? ok(
              node('`AccessDenied … report-job-role … is not authorized to perform: s3:PutObject` です！'),
              hakase('Lesson 23 でさんざん見たエラーだな。誰が・何をしようとして断られたかを読むのだ。'),
              node('えっと、report-job-role が、S3 への `s3:PutObject`、つまりオブジェクトの書き込みを断られてます。'),
              hakase('ジョブロールには注文を読む権限はあるが、レポートを書く権限がないのだ。材料は取れるのに、皿に盛れん厨房だな。'),
              hakase('直すときは **最小権限** だ。必要な操作を、必要な場所にだけ許す。ロールに直接書き込む **インラインポリシー** で足すか、既存の `report-job-s3` を編集して、`reports/` の下への `s3:PutObject` だけを許可するのだ。'),
            )
          : ng(hakase('まだ原因に辿り着いておらん。Batch > ジョブ でステータスが FAILED のジョブを開き、「ログストリーム名」のリンクからログを読むのだ。')),
    },
    {
      type: 'exercise',
      title: 'ジョブロールに書き込み権限を付ける',
      objective: `\`report-job-role\` に、\`arn:aws:s3:::${REPORTS_BUCKET}/reports/*\` への \`s3:PutObject\` を許可する`,
      tasks: [{ id: 'iam', title: 'IAM > ロール > `report-job-role` → 許可を追加 (インラインポリシーを作成) または `report-job-s3` を編集', hint: '最小権限: バケット全体ではなく reports/ の下だけを許可します。', hotspotId: 'iam-add-permissions', done: (c) => canWrite(c.env) }],
      validate: (c) => {
        if (!canWrite(c.env)) return ng(hakase(`report-job-role はまだ reports/ に書き込めん。IAM > ロール > report-job-role の「許可を追加」で、Action に s3:PutObject、Resource に arn:aws:s3:::${REPORTS_BUCKET}/reports/* を書くのだ。`));
        const all = evaluateIamPermission(c.env, { principal: { type: 'role', roleName: 'report-job-role', sessionName: 'job' }, action: 's3:DeleteBucket', resource: `arn:aws:s3:::${REPORTS_BUCKET}` }).decision === 'Allow';
        return all
          ? ng(hakase('権限が広すぎる。s3:* などでは、バケットの削除までできてしまう。Action は s3:PutObject だけにするのだ。'), hakase('レポートを書かせたいだけの相手に、倉庫ごと燃やせるマッチまで渡す必要はない。'))
          : ok(
              hakase('よし、必要な権限だけを足せた。'),
              node('バケット全体じゃなくて `reports/` の下だけ、しかも書き込みだけ、ですね。'),
              hakase('うむ。万一ジョブが乗っ取られても、被害はレポートの置き場だけで済む。最小権限とは、事故の大きさを先に決めておくことなのだ。'),
            );
      },
    },
    {
      type: 'exercise',
      title: 'ジョブを再実行する',
      objective: 'Batch で **新しいジョブを送信** (ジョブ定義 `daily-report:1`、ジョブキュー `report-queue`) し、SUCCEEDED になることを確認する',
      tasks: [
        { id: 'submit', title: 'Batch > ジョブ → **新しいジョブを送信**', hint: 'ジョブ名は自由です (例: daily-report-rerun)。', hotspotId: 'batch-submit-submit', done: (c) => c.env.batchJobs.some((j) => j.submittedBy === 'learner') },
        { id: 'ok', title: 'ステータスが **SUCCEEDED** になり、S3 にレポートができる', hint: 'ステータスは数秒で RUNNING を経て SUCCEEDED になります。FAILED になったら、ジョブの詳細の「ステータスの理由」とログでジョブロールの権限を見直します。', done: (c) => !!learnerJob(c.env) && reportSaved(c.env) },
      ],
      validate: (c) =>
        learnerJob(c.env) && reportSaved(c.env)
          ? ok(
              node('SUCCEEDED！ reports/daily-… .csv ができました。'),
              hakase('今日の分はこれで取り戻せた。部長の顔色も、赤から黄色くらいには戻るだろう。'),
              node('緑にはならないんですか？'),
              hakase('2 日分の遅れは消えん。さて、手で投げたジョブは成功した。次は EventBridge から投げても動くかだ。ジョブ一覧の「送信元」を見れば、手で投げたか EventBridge が投げたかが分かるぞ。'),
            )
          : ng(hakase('まだ成功したジョブがない。Batch > ジョブ の「新しいジョブを送信」で、ジョブ定義 daily-report:1、ジョブキュー report-queue を選んで送信し、ステータスが SUCCEEDED になるまで待つのだ。')),
    },
    {
      type: 'exercise',
      title: 'スケジュールからの実行を確かめる',
      objective: '`rate(1 minute)` のテスト用ルールを作って、EventBridge からジョブが投入され成功することを確かめ、最後にそのルールを **無効** にする',
      tasks: [
        { id: 'create', title: 'EventBridge > ルール → **ルールを作成** (スケジュール `rate(1 minute)`、ターゲット `report-queue` / `daily-report:1`)', hint: '1 のときは minute (単数形) です。', hotspotId: 'events-create-rule', done: (c) => !!testRule(c.env) },
        { id: 'job', title: '1 分以内に、送信元が EventBridge のジョブが SUCCEEDED になる', hint: 'ジョブ一覧の **送信元** 列が `EventBridge (ルール名)` のジョブを探します。ルールは 1 分ごとに動くので、作成後しばらく待ってから一覧を見ます。', done: (c) => !!ruleJob(c.env) },
        { id: 'off', title: 'テスト用ルールを **無効にする**', hint: '放っておくと 1 分ごとにジョブが動き続けます。', hotspotId: 'events-toggle', done: (c) => !!ruleJob(c.env) && testRule(c.env)?.state === 'DISABLED' },
      ],
      validate: (c) => {
        if (!ruleJob(c.env)) return ng(hakase('まだ EventBridge から投入されたジョブが成功していない。スケジュール rate(1 minute)、ターゲット report-queue / daily-report:1 のルールを作ったら、1 分待ってジョブ一覧の「送信元」を見るのだ。'));
        if (testRule(c.env)?.state !== 'DISABLED') return ng(hakase('テスト用ルールがまだ有効だ。1 分ごとに料金のかかるジョブが動き続けるぞ。1 日で 1,440 回だ。ルールを開いて「無効にする」を押すのだ。'));
        return ok(
          hakase('EventBridge → Batch の流れを確かめられた。ルールがジョブを投げ、ジョブがレポートを書く。'),
          node('これで今夜 2:00 のジョブも成功するはずですね。'),
          hakase('うむ。テスト用ルールを無効にしたのも偉い。消し忘れたテスト用ルールとは、たいてい月末の請求書で再会することになるからな。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。毎日、日本時間の 9:00 に動かしたい。EventBridge の cron 式はどれかな？'),
      options: ['cron(0 9 * * ? *)', 'cron(0 0 * * ? *)', 'cron(0 18 * * ? *)'],
      answer: 1,
      explanation: [
        hakase('正解。日本時間は UTC+9 だから、9:00 JST から 9 時間引いて UTC の 0:00 だ。'),
        node('`cron(0 9 * * ? *)` にすると、日本時間の 18:00 に動いちゃうんですね。'),
        hakase('うむ。朝のレポートが夕方に届く。定時で帰る人には永遠に読まれんレポートの完成だ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では、1 回 40 分かかる集計処理を毎晩動かしたい。向いているのはどれかな？'),
      options: ['Lambda', 'AWS Batch (または ECS のタスク)', 'CloudWatch アラーム'],
      answer: 1,
      explanation: [
        hakase('正解。Lambda は 1 回の実行が最大 15 分だ。長い処理はコンテナで動かす Batch や ECS のタスクに任せるのだ。'),
        node('CloudWatch アラームは、しきい値を超えたら知らせる係でしたもんね。集計はしてくれない。'),
      ],
    },
  ],
};
