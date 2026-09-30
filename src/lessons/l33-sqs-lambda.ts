import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { asyncEnv, ORDERS_BUCKET } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { visitedQuery } from './helpers';

const queue = (env: AwsEnv, name: string) => env.sqsQueues.find((q) => q.queueName === name);
const orderIdOf = (body: string) => {
  try {
    return (JSON.parse(body) as { orderId?: unknown }).orderId;
  } catch {
    return undefined;
  }
};
const saved = (env: AwsEnv, id: number | string) => !!env.buckets.find((b) => b.name === ORDERS_BUCKET)?.objects.some((o) => o.key === `orders/${id}.json`);
const sent2001 = (env: AwsEnv) => saved(env, 2001) || !!queue(env, 'orders-queue')?.messages.some((m) => String(orderIdOf(m.body)) === '2001');
const sawLogs = (c: TaskContext) => visitedQuery(c, '/cloudwatch/logs/events', { group: '/aws/lambda/process-order' });
const fnLog = (env: AwsEnv, text: string) => !!env.logGroups.find((g) => g.logGroupName === '/aws/lambda/process-order')?.events?.some((e) => e.message.includes(text));
const poison = (env: AwsEnv) => queue(env, 'orders-dlq')?.messages.find((m) => orderIdOf(m.body) === undefined);

export const lesson33: Lesson = {
  id: 'sqs-lambda',
  number: '33',
  title: 'SQS と Lambda で非同期処理',
  summary: 'キューとデッドレターキューで、失敗した注文を失わずに再処理する',
  minutes: 30,
  startPath: '/sqs/queues',
  scenario: asyncEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、お客さんから「注文したのに、注文履歴に出てこない」って問い合わせが 3 件来てます。'),
        hakase('ほう。注文ボタンは押せたのかな？'),
        node('はい。画面には「ご注文を受け付けました」と出たそうです。'),
        hakase('なら注文は、**キュー** に入るところまでは行っておる。うちの注文処理は **非同期** だからな。'),
        node('ひどうき？'),
        hakase('「後でやっておきます」方式のことだ。注文を受けたら、確定処理の終わりを待たずにお客さんへ返事をする。重い処理は裏で、後から順番に片付ける。'),
        node('ラーメン屋の食券みたいですね。券を渡したら、あとは席で待ってればいい。'),
        hakase('うむ、よいたとえだ。食券を並べておく台が **キュー**、食券 1 枚 1 枚が **メッセージ** だ。AWS でその台の役をするのが **SQS (Simple Queue Service)** だ。'),
        node('じゃあ、厨房は誰なんですか？'),
        hakase('**Lambda** だ。サーバーを用意せず、コードの **関数** だけを置いておくと、呼ばれたときだけ動く。料金も、呼ばれた回数と動いた時間の分だけだ。'),
        node('呼ばれたときだけ出勤するバイトさんですね。うらやましい。'),
        hakase('君は呼ばれなくても出勤して、呼ばれても動かんがな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('でも Lambda は、どうやって台に食券が来たって知るんですか？'),
        hakase('**Lambda トリガー** を設定してある。正式には **イベントソースマッピング** といって、Lambda 側がキューを繰り返し覗きに行く。これを **ポーリング** という。'),
        node('ぽーりんぐ。「来てる？」「来てる？」って何度も聞きに行くんですね。'),
        hakase('そうだ。メッセージを見つけたら、最大 **バッチサイズ** の件数 (今回は 10 件) までまとめて関数に渡す。関数が成功したら、そのメッセージをキューから消す。'),
        node('失敗したら？ 食券を捨てちゃうんですか？'),
        hakase('捨てはせん。そこが今日の本題だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('受信されたメッセージは、**可視性タイムアウト** の間だけ、ほかの受信者から見えなくなる。時間内に消されなければ、また見えるようになって、もう一度受信される。'),
        node('厨房の人が食券を手に取ってる間は、ほかの人には見えない。作れなかったら台に戻る、と。'),
        hakase('うむ。今回は 10 秒にしてある。本来は関数のタイムアウトの 6 倍以上にするのが推奨だが、今日は君を待たせんためだ。'),
        node('珍しく優しい。でも、永遠に作れない注文だったら、永遠に台に戻り続けるんですか？'),
        hakase('そこで **最大受信数** だ。受信された回数がこれを超えると、メッセージは **デッドレターキュー (DLQ)** に移される。今回は 3 回だ。'),
        node('でっどれたー… 死んだ手紙？ 物騒ですね。'),
        hakase('宛先不明で配達できなかった郵便のことだ。何度やっても作れない食券を別の箱に隔離して、ほかの注文を流し続けるための置き場だ。'),
        node('厨房の隅の「保留」の箱ですね。問い合わせの 3 件、そこに入ってたりして。'),
        hakase('鋭いな。今日はたまに勘が働く日らしい。'),
      ],
    },
    {
      type: 'table',
      title: 'SQS と Lambda の用語',
      columns: ['用語', '意味', '今回の値'],
      rows: [
        ['可視性タイムアウト', '受信されたメッセージがほかから見えなくなる時間。処理に失敗すると、この後また受信できる', '10 秒'],
        ['最大受信数', 'この回数を超えて受信されると DLQ に移る', '3 回'],
        ['デッドレターキュー (DLQ)', '何度やっても処理できなかったメッセージの置き場', '`orders-dlq`'],
        ['Lambda トリガー (イベントソースマッピング)', 'Lambda がキューをポーリングし、メッセージをまとめて関数に渡す', 'バッチサイズ 10'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('で、まず何をすればいいですか？'),
        hakase('今も失敗し続けているかを確かめる。自分で注文を 1 件、`orders-queue` に送ってみるのだ。'),
        node('本文は `{"orderId": 2001, "amount": 1200}` でいいんですよね。Lesson 21 のバケットポリシーと同じ、波かっこの書き方ですね。'),
        hakase('**JSON** だ。「"項目名": 値」を並べたデータの書き方だな。送ったら、関数 `process-order` のログを見る。関数の `console.log` やエラーは CloudWatch Logs に届く。'),
        node('CloudWatch Logs は Lesson 25 で、スロークエリログを探したところですね。'),
        hakase('うむ。Lambda の記録はロググループ `/aws/lambda/process-order` に入り、その中に実行環境ごとの **ログストリーム** ができる。最新のストリームから読むのだ。'),
        node('犯人の足跡は、新しいものから辿る。'),
        hakase('刑事ドラマの見すぎだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '注文を 1 件送ってみる',
      objective: '`orders-queue` に `{"orderId": 2001, "amount": 1200}` を送信し、Lambda 関数 `process-order` のログを確認する',
      tasks: [
        { id: 'send', title: '`orders-queue` → **メッセージを送受信** → 本文を入力して **メッセージを送信**', hint: 'SQS > キュー の一覧から `orders-queue` を開くと右上にボタンがあります。**メッセージ本文** に `{"orderId": 2001, "amount": 1200}` を入力します。', hotspotId: 'sqs-send', done: (c) => sent2001(c.env) },
        { id: 'logs', title: 'Lambda > 関数 > `process-order` → モニタリング → **CloudWatch ログを表示** → 最新のログストリーム', hint: 'ログストリームは **最後のイベントの時刻** が一番新しいものを開きます。エラーの行に失敗の原因が書かれています。', hotspotId: 'lambda-logs', done: sawLogs },
      ],
      validate: (c) =>
        sent2001(c.env) && sawLogs(c)
          ? ok(
              node('`Error: BUCKET is not set` … 5 時間前から、全部このエラーです！'),
              hakase('コードは `process.env.BUCKET` を読んでおる。これは **環境変数** だ。関数の外から渡す設定値で、コードを書き換えずに保存先のバケット名などを変えられる。'),
              node('その環境変数が、空っぽになってるってことですか？'),
              hakase('5 時間前のデプロイで `BUCKET` が消えてしまったのだ。保存先を知らん厨房は、料理を作っても盛る皿がない。'),
            )
          : ng(hakase('まだ材料が揃っておらん。orders-queue の「メッセージを送受信」で注文を送り、Lambda > 関数 > process-order の「モニタリング」から「CloudWatch ログを表示」で最新のログストリームを開くのだ。')),
    },
    {
      type: 'exercise',
      title: '環境変数を直す',
      objective: `\`process-order\` の環境変数に \`BUCKET\` = \`${ORDERS_BUCKET}\` を追加する。可視性タイムアウトの後、注文 2001 が保存されることを確認する`,
      tasks: [
        { id: 'env', title: '`process-order` → 設定 → 環境変数 → **編集** → 追加して **保存**', hint: `**環境変数の追加** で、キー \`BUCKET\` (大文字)、値 \`${ORDERS_BUCKET}\` の行を足します。`, hotspotId: 'lambda-save-env', done: (c) => c.env.lambdaFunctions[0]?.environment.BUCKET === ORDERS_BUCKET },
        { id: 'saved', title: `S3 の \`${ORDERS_BUCKET}\` に \`orders/2001.json\` ができる`, hint: '失敗したメッセージは 10 秒後にもう一度受信されます。', done: (c) => saved(c.env, 2001) },
      ],
      validate: (c) =>
        saved(c.env, 2001)
          ? ok(
              node('orders/2001.json ができました！ 送り直してないのに、勝手にもう一度処理されたんですね。'),
              hakase('失敗したメッセージは消されずにキューに残り、可視性タイムアウトの 10 秒後にまた受信されたのだ。これがキューを挟む強みだ。'),
              node('じゃあ、問い合わせの 3 件も今ごろ保存されてますね！'),
              hakase('甘い。あの 3 件は 5 時間前に 3 回失敗して、とっくに DLQ に移っておる。DLQ のメッセージを元のキューに戻すのが **DLQ 再処理** だ。原因は直したから、今なら戻してよい。'),
            )
          : ng(hakase('まだ orders/2001.json がない。process-order の「設定」→「環境変数」に BUCKET が正しい綴りと値で入っているか確かめて、10 秒ほど待つのだ。')),
    },
    {
      type: 'exercise',
      title: 'DLQ の注文を再処理する',
      objective: '`orders-dlq` にたまった 3 件の注文を **DLQ 再処理** で `orders-queue` に戻し、すべて保存されることを確認する',
      tasks: [
        { id: 'redrive', title: 'SQS > キュー > `orders-dlq` → **DLQ 再処理を開始**', hint: '中身を見たいときは「メッセージを送受信」でポーリングできます。', hotspotId: 'sqs-redrive', done: (c) => (queue(c.env, 'orders-dlq')?.messages.filter((m) => orderIdOf(m.body) !== undefined).length ?? 1) === 0 },
        { id: 'saved', title: '注文 1001 / 1002 / 1003 が S3 に保存される', hint: `戻したメッセージは Lambda トリガーが順に処理します。S3 のバケット \`${ORDERS_BUCKET}\` の \`orders/\` に JSON ができるか確かめます。`, done: (c) => [1001, 1002, 1003].every((id) => saved(c.env, id)) },
      ],
      validate: (c) =>
        [1001, 1002, 1003].every((id) => saved(c.env, id))
          ? ok(
              node('3 件とも保存されました！ 1 件も失われていません。'),
              hakase('DLQ は「あとで直して流し直す」ための場所だ。順番は **原因を直してから再処理**。逆にすると、また 3 回失敗して DLQ に戻ってくるだけだ。'),
              node('厨房を直さずに食券を戻しても、また保留の箱行きですもんね。'),
              hakase('それを一晩じゅう繰り返して、Lambda の料金だけ積み上げた男をワシは知っておる。名前は言わんが、今は別の部署におる。'),
            )
          : ng(hakase('まだ保存されていない注文がある。SQS > キュー > orders-dlq を開いて「DLQ 再処理を開始」を押し、少し待つのだ。')),
    },
    {
      type: 'exercise',
      title: '壊れたメッセージを送ると？',
      objective: '`orders-queue` に、JSON として壊れた本文 `{"orderId": 3001,` を送信し、どこに行き着くかを観察する',
      tasks: [
        { id: 'send', title: '壊れた本文を送信', hint: '`orders-queue` の **メッセージを送受信** で、本文に `{"orderId": 3001,` だけを入力して送信します。閉じかっこは付けません。', done: (c) => !!queue(c.env, 'orders-queue')?.messages.some((m) => m.body.startsWith('{"orderId": 3001')) || !!poison(c.env) },
        { id: 'dlq', title: '約 30 秒後、`orders-dlq` に移る', hint: '10 秒 × 3 回失敗すると、4 回目の受信で DLQ に移ります。', done: (c) => !!poison(c.env) },
      ],
      validate: (c) =>
        poison(c.env) && fnLog(c.env, 'SyntaxError')
          ? ok(
              node('ログに SyntaxError が 3 回出て、4 回目の受信で DLQ に移りました。ほかの注文は普通に処理されてます。'),
              hakase('何度やっても成功しないメッセージを **ポイズンメッセージ** (毒入りメッセージ) という。DLQ がそれを隔離してくれた。'),
              node('DLQ がなかったら、どうなってたんですか？'),
              hakase('毒入りの食券が、台と厨房を延々と往復し続ける。メッセージの保持期間が切れて消えるまで、Lambda の料金を払いながらな。'),
            )
          : ng(hakase('まだ DLQ に移っておらん。orders-queue に壊れた本文 {"orderId": 3001, を送ったら、可視性タイムアウト 10 秒 × 3 回ぶん、30 秒ほど待ってから orders-dlq を見るのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。Web アプリが注文を SQS に入れて Lambda で処理する。その場で直接処理するのに比べた、一番の利点は何かな？'),
      options: ['処理が必ず速くなる', 'Web はすぐ応答でき、処理側が失敗・混雑してもメッセージは失われずに待てる', 'Lambda の料金が無料になる'],
      answer: 1,
      explanation: [
        hakase('正解。キューが間に入ることで、送る側と処理する側が **疎結合** になる。'),
        node('そけつごう？'),
        hakase('お互いの都合に縛られない、ということだ。厨房が止まっても食券は受け付けられるし、客が押し寄せても台に並べて順に作れる。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では、DLQ に入ったメッセージを再処理する前に、まずすべきことは何かな？'),
      options: ['すぐに DLQ 再処理を開始する', 'ログで失敗の原因を調べて直す', 'DLQ を削除する'],
      answer: 1,
      explanation: [
        hakase('正解。原因を直さずに戻しても、また失敗して DLQ に戻ってくるだけだ。'),
        node('今日も、ログで BUCKET の件を見つけて直してから再処理しましたもんね。'),
        hakase('うむ。DLQ を削除するのは、保留の箱ごと食券をゴミ箱に捨てるのと同じだ。お客さんの注文ごとな。'),
      ],
    },
  ],
};
