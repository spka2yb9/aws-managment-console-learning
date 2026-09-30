import { hakase, ng, node, ok, type Lesson } from '../lesson/types';
import { currentTables, findSnapshot } from '../sim/rds';
import { accidentEnv, backupEnv, ORDERS } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { albReachesWeb, dbNamed, lastRun, sgNamed, webReachesDb } from './helpers';

const SNAP = 'webapp-db-before-migration';
const COUNT = 'mysql -e "SELECT COUNT(*) FROM orders"';
const orders = (env: AwsEnv, id: string) => {
  const db = dbNamed(env, id);
  return db ? currentTables(db).orders : undefined;
};
const usesDbSg = (env: AwsEnv, id: string) => !!dbNamed(env, id)?.vpcSecurityGroupIds.includes(sgNamed(env, 'db-sg')?.groupId ?? '-');
const n = ORDERS.toLocaleString('en-US');

export const lesson28: Lesson = {
  id: 'rds-snapshot',
  number: '28',
  title: 'RDS スナップショットと復元',
  summary: '作業前にスナップショットを取り、事故が起きたら新しい DB インスタンスに復元して切り替える',
  minutes: 30,
  startPath: '/rds/databases',
  scenario: backupEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、今夜は orders テーブルの移行です。古い注文を消すスクリプト `migrate.sh` を batch-1 で流すだけなので、すぐ終わります！'),
        hakase('「すぐ終わります」。ワシが障害報告書の中で一番多く読んできた言葉だ。'),
        node('縁起でもないこと言わないでください。'),
        hakase('念のため確認だ。orders テーブルとは何かな？'),
        node('webapp-db の中にある、注文の表です。1 行が 1 件の注文で。'),
        hakase('うむ。**テーブル**は DB の中の表だ。で、移行スクリプトは何をする？'),
        node('3 年より古い注文の行を **DELETE** (削除) します。そのあとで表の作りを変える予定です。'),
        hakase('本番のデータを消す作業だな。そういうときは、始める前に必ず**スナップショット**を取るのだ。'),
        node('すなっぷしょっと？ スナップ写真の？'),
        hakase('そうだ。ある瞬間の DB を、丸ごと写真に撮っておくようなものだ。何かあれば、その写真から DB を作り直せる。'),
        node('記念撮影ですね。「移行前の webapp-db」。'),
        hakase('それが最後の一枚にならんことを祈っておる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('でも RDS って、自動でバックアップしてくれてるんじゃないんですか？'),
        hakase('しておる。**自動バックアップ**だ。毎日 1 回、決めた時間帯 (**バックアップウィンドウ**) に、DB 全体のスナップショットを取る。'),
        node('毎日撮ってくれるなら、わざわざ自分で撮らなくても…'),
        hakase('自動の方には**保持期間**がある。1〜35 日のうち決めた日数が過ぎると、古いものから消えていく。'),
        node('賞味期限付きなんですね。'),
        hakase('それに加えて、DB への変更を順番に書き留めた**トランザクションログ**も、5 分ごとに保存しておる。'),
        node('とらんざくしょんろぐ？'),
        hakase('DB の日記帳だ。「何時何分何秒、この行を消した」と全部書いてある。毎日の写真にこの日記を足していけば、保持期間内の**任意の時点**に戻せる。これを**特定時点への復元**という。詳しくは次の Lesson 29 でやる。'),
        node('自動の方、すごいじゃないですか。じゃあ手動の方は？'),
        hakase('**手動スナップショット**は、好きなときに自分で撮る。そして**削除するまで**残る。元の DB を消しても残る。'),
        node('賞味期限なし。作業の直前をピンポイントで撮れて、ずっと残る。作業前の記念撮影は、手動のほうが確実ってことですね。'),
        hakase('そういうことだ。自動の方だけに頼って、いざ必要なときには保持期間が切れていた、という悲劇もよくある。'),
      ],
    },
    {
      type: 'table',
      title: 'RDS のバックアップ',
      columns: ['種類', '取得', '保持', '戻せる時点'],
      rows: [
        ['自動バックアップ (システムスナップショット)', '毎日のバックアップウィンドウ + 5 分ごとのトランザクションログ', '保持期間 (1〜35 日) が過ぎると削除', '保持期間内の**任意の時点** (特定時点への復元)'],
        ['手動スナップショット', '好きなときに自分で取得', '**削除するまで**残る', 'スナップショットを取った時点'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('コンソールのスナップショット一覧では、自動の方は種類が「システム」、手動の方は「手動」と表示される。'),
        node('今夜撮るのは手動ですね。名前はどうします？'),
        hakase('`webapp-db-before-migration`。「移行前」と一目でわかる名前にしておけ。半年後の君が `test1` という名前を見て、中身を思い出せると思うか。'),
        node('思い出せない自信があります。'),
        hakase('胸を張るな。撮ったら、ステータスが「**利用可能**」になるまで待つ。作成中は、まだ写真が現像できておらん。'),
        node('現像って… 博士、スマホ世代にその例えは通じないですよ。'),
        hakase('若者はすぐそこに突っ込む。とにかく「利用可能」になるまで、移行を始めてはならんぞ。'),
      ],
    },
    {
      type: 'exercise',
      title: '手動スナップショットを取る',
      objective: `\`webapp-db\` の手動スナップショット \`${SNAP}\` を取得し、ステータスが「利用可能」になるまで待つ`,
      tasks: [
        { id: 'take', title: 'RDS > データベース > `webapp-db` → アクション → **スナップショットの取得**', hint: 'DB インスタンスが `webapp-db` になっていることを確かめ、**スナップショット名** に `webapp-db-before-migration` と入力します。', hotspotId: 'rds-take-snapshot', done: (c) => !!findSnapshot(c.env, SNAP) },
        { id: 'wait', title: 'スナップショット一覧でステータスが「利用可能」になる', hint: '数秒かかります。', done: (c) => findSnapshot(c.env, SNAP)?.status === 'available' },
      ],
      validate: (c) => {
        const s = findSnapshot(c.env, SNAP);
        if (!s) return ng(hakase(`\`${SNAP}\` という名前のスナップショットが見当たらん。\`webapp-db\` を選んで アクション → **スナップショットの取得** で、名前を一字一句そのとおりに入れるのだ。`));
        if (s.status !== 'available') return ng(hakase('まだ作成中だ。スナップショット一覧で、ステータスが「利用可能」になるまで待つのだ。'));
        return ok(
          hakase('よし、これで保険ができた。では移行を始めよう。'),
          node('終わったら、ちゃんと消えたか件数を確かめるんですよね。'),
          hakase('そうだ。`SELECT COUNT(*) FROM orders` は、orders の行の数を数える SQL (DB への命令文) だ。batch-1 の `mysql` コマンドには接続先が設定済みだから、`-e` で SQL を 1 本だけ実行できる。'),
          node('3 年より古い分だけ減っていれば成功、ですね。'),
        );
      },
    },
    { type: 'code', title: '移行とその確認 (batch-1 のターミナルで)', language: 'bash', code: `./migrate.sh\n${COUNT}` },
    {
      type: 'exercise',
      title: '移行スクリプトを実行する',
      objective: '`batch-1` に EC2 Instance Connect で接続し、`./migrate.sh` を実行してから orders の件数を確認する',
      tasks: [
        { id: 'run', title: '`./migrate.sh` を実行', hint: 'batch-1 → 接続 → EC2 Instance Connect → 接続。', hotspotId: 'terminal-input', done: (c) => !!lastRun(c, 'batch-1', /migrate\.sh/)?.ok },
        { id: 'count', title: `\`${COUNT}\` で件数を確認`, hint: 'migrate.sh と同じ batch-1 のターミナルで入力します。接続先は `~/.my.cnf` に設定済みなので `-h` は不要です。', done: (c) => !!lastRun(c, 'batch-1', /select\s+count/i)?.ok },
      ],
      validate: (c) =>
        lastRun(c, 'batch-1', /migrate\.sh/)?.ok && orders(c.env, 'webapp-db') === 0 && lastRun(c, 'batch-1', /select\s+count/i)?.output.includes('|        0 |')
          ? ok(
              node('え…… COUNT(*) が **0** です！ 全部消えてる！？'),
              hakase('`cat migrate.sh` で中身を見てみるのだ。`DELETE FROM orders; -- WHERE …` と、WHERE の前に `;` がある。'),
              node('本当だ… でも `;` 1 文字で、そんなに変わるんですか？'),
              hakase('SQL では `;` で文が終わり、`--` から後ろはただのコメントだ。条件を書くはずの WHERE が飾りになって、残ったのは `DELETE FROM orders`。つまり**全件削除**だ。'),
            )
          : ng(hakase('migrate.sh を実行して、件数を確かめるのだ。batch-1 → 接続 → EC2 Instance Connect で入り、`./migrate.sh` のあとに件数を数えるコマンドを打つ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('ど、ど、どうしましょう……本番の注文が、ぜ、全部……'),
        hakase('落ち着け。君の席が消えるかどうかは、これからの 30 分で決まる。'),
        node('全然落ち着けないです！'),
        hakase('そのためのスナップショットだ。さっき撮った `webapp-db-before-migration` から**復元**する。'),
        node('よかった… じゃあ webapp-db を、写真を撮った時点に巻き戻すんですね。'),
        hakase('そこが大事な勘違いだ。**復元は今の DB を巻き戻すのではなく、新しい DB インスタンスを作る**。大事だからもう一度言う。新しい DB インスタンスを作る。'),
        node('なんで 2 回言ったんですか。'),
        hakase('本番の真っ最中に、1 回目を聞き流す人間を何人も見てきたからだ。新しいものだから、名前 (DB インスタンス識別子) も別にする。今回は `webapp-db-restored` だ。'),
        node('DB インスタンス識別子って、Lesson 14 で `webapp-db` って付けた名前でしたよね。'),
        hakase('うむ。名前が違えば、**エンドポイント**も別になる。'),
        node('エンドポイントは、アプリが DB につなぐときの住所でしたよね。Lesson 14 でコピーした長いやつ。'),
        hakase('そうだ。そしてもう 1 つ。**セキュリティグループは引き継がれない**。選び直さなければ、VPC に最初から用意されている `default` のセキュリティグループが付く。'),
        node('default だと何がまずいんです？'),
        hakase('db-sg にある「web-sg と batch-sg からの 3306 番を許可」というルールがない。せっかく復元しても、誰も開けられない金庫になる。必ず `db-sg` を選ぶのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'スナップショットから復元する',
      objective: `\`${SNAP}\` から DB インスタンス \`webapp-db-restored\` を復元する。VPC セキュリティグループは \`db-sg\` にする`,
      tasks: [
        { id: 'restore', title: 'RDS > スナップショット → `webapp-db-before-migration` を選択 → アクション → **スナップショットを復元**', hint: 'セキュリティグループは最初「default」が選ばれています。', hotspotId: 'rds-restore-submit', done: (c) => !!dbNamed(c.env, 'webapp-db-restored') },
        { id: 'available', title: 'ステータスが「利用可能」になる', hint: 'RDS > データベース の一覧で `webapp-db-restored` の **ステータス** 列を見ます。作成中 → バックアップ中 → 利用可能 の順に変わります。', done: (c) => dbNamed(c.env, 'webapp-db-restored')?.status === 'available' },
      ],
      validate: (c) => {
        const db = dbNamed(c.env, 'webapp-db-restored');
        if (!db) return ng(hakase('webapp-db-restored が見当たらん。RDS > スナップショット で `webapp-db-before-migration` を選び、アクション → **スナップショットを復元** だ。DB インスタンス識別子は `webapp-db-restored` にする。'));
        if (!usesDbSg(c.env, 'webapp-db-restored')) return ng(hakase('セキュリティグループが db-sg になっていない。default のままだと、web サーバーからも batch-1 からも接続できんぞ。`webapp-db-restored` の「変更」で、VPC セキュリティグループに db-sg を付けるのだ。'));
        if (db.status !== 'available') return ng(hakase('まだ作成中だ。ステータスが「利用可能」になるまで少し待つのだ。DB を 1 台まるごと作るのだから、カップ麺よりは待たされる。'));
        return ok(
          hakase('新しい DB インスタンスができた。'),
          node('これで元どおり、ですよね？'),
          hakase('気が早い。「復元できたはず」と「データが戻っている」は別物だ。本当にデータが戻っているか、自分の目で確かめよう。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '復元した DB のデータを確かめる',
      objective: '`webapp-db-restored` の **エンドポイント** をコピーし、`mysql -h <エンドポイント> -e "SELECT COUNT(*) FROM orders"` で件数を確認する',
      tasks: [{ id: 'check', title: '`mysql -h webapp-db-restored.… -e "SELECT COUNT(*) FROM orders"`', hint: 'エンドポイントは DB の「接続とセキュリティ」タブにあります。ターミナルに貼り付けて使います。', done: (c) => !!lastRun(c, 'batch-1', /-h\s*\S*webapp-db-restored/)?.ok }],
      validate: (c) =>
        lastRun(c, 'batch-1', /-h\s*\S*webapp-db-restored/)?.output.includes(String(ORDERS))
          ? ok(
              node(`${n} 件！ スナップショットを取った時点のデータです。`),
              hakase('よし。あとはアプリをこの DB に向けるだけだ。'),
              node('アプリの設定の接続先を、新しいエンドポイントに書き換えるんですか？'),
              hakase('それでもよいが、もっと楽な手がある。**名前を入れ替える**のだ。Lesson 25 でインスタンスクラスを上げたときと同じ「変更」画面で、DB インスタンス識別子を変えて「すぐに適用」する。'),
              node('壊れた方を別の名前に逃がして、空いた `webapp-db` の名前を新しい方に付けるってことですね。'),
            )
          : ng(hakase('復元した DB のエンドポイントを `-h` に指定して、件数を確かめるのだ。エンドポイントは `webapp-db-restored` の「接続とセキュリティ」タブにある。`-h` を付けないと、壊れた webapp-db を数えることになるぞ。')),
    },
    {
      type: 'exercise',
      title: '名前を入れ替えて切り替える',
      objective: '壊れた `webapp-db` を `webapp-db-broken` に名前変更し、その後 `webapp-db-restored` を `webapp-db` に名前変更する',
      tasks: [
        { id: 'old', title: '`webapp-db` → 変更 → DB インスタンス識別子を `webapp-db-broken` → すぐに適用', hint: '識別子を書き換えて **続行** → 変更のスケジュールで **すぐに適用** を選び、**DB インスタンスを変更** を押します。', done: (c) => !!dbNamed(c.env, 'webapp-db-broken') },
        { id: 'new', title: '`webapp-db-restored` → 変更 → DB インスタンス識別子を `webapp-db` → すぐに適用', hint: '`webapp-db` という名前が空いていないと `DBInstanceAlreadyExists` エラーになります。1 つ目の名前変更を済ませてから行います。', done: (c) => !!dbNamed(c.env, 'webapp-db-broken') && orders(c.env, 'webapp-db') === ORDERS },
      ],
      validate: (c) => {
        if (!dbNamed(c.env, 'webapp-db-broken')) return ng(hakase('まず壊れた webapp-db を webapp-db-broken に名前変更するのだ。`webapp-db` → **変更** → DB インスタンス識別子を `webapp-db-broken` にして、**すぐに適用** だ。'));
        if (orders(c.env, 'webapp-db') !== ORDERS) return ng(hakase('webapp-db という名前の DB が、まだ復元したデータになっていない。次は `webapp-db-restored` の識別子を `webapp-db` に変えるのだ。'));
        if (dbNamed(c.env, 'webapp-db')?.status !== 'available') return ng(hakase('名前の変更中だ。「利用可能」になるまで待つのだ。'));
        if (!webReachesDb(c.env) || !albReachesWeb(c.env)) return ng(hakase('アプリから DB に届いていない。新しい `webapp-db` の VPC セキュリティグループが `db-sg` になっているか、セキュリティグループを確かめるのだ。'));
        return ok(
          node('アプリの設定を変えずに、元のエンドポイント名のまま復旧できました！'),
          hakase('エンドポイントは DB インスタンス識別子から作られる。だから名前を入れ替えれば、アプリも batch-1 の `~/.my.cnf` (mysql コマンドの接続先を書いた設定ファイル) も、そのまま新しい DB を見るのだ。'),
          node('壊れた webapp-db-broken は、もう消していいですか？ 見てると胃が痛くて。'),
          hakase('まだ消すな。調査が終わるまでは大事な証拠だ。証拠を消しても、始末書が 2 枚に増えるだけだぞ。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。自動バックアップのスナップショットが毎日 3:00 に取られている。15:00 に障害が起き、スナップショットだけで戻すとしたら、最大で何時間分のデータを失う？'),
      options: ['0 時間', '12 時間', '24 時間'],
      answer: 1,
      explanation: [
        hakase('正解。3:00 から 15:00 までの 12 時間分が消える。この「どの時点まで戻れるか (どれだけのデータ損失を許せるか)」を **RPO** (目標復旧時点) という。'),
        node('12 時間分の注文が消えたら、僕の席も消えそうです。'),
        hakase('だから特定時点への復元がある。トランザクションログのおかげで、RPO は 5 分程度まで縮められる。次の Lesson 29 でやるぞ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('スナップショットから復元すると、どうなるかな？ さっきワシが 2 回言ったことだ。'),
      options: ['元の DB インスタンスが巻き戻る', '新しい DB インスタンスが作られ、エンドポイントも新しくなる', 'スナップショットが DB に変わり、スナップショットは消える'],
      answer: 1,
      explanation: [
        hakase('正解。だから復元の手順書には、「アプリの接続先をどう切り替えるか」まで書いておくのだ。'),
        node('今日みたいに名前を入れ替えるか、アプリの接続先を書き換えるか、ですね。'),
      ],
    },
  ],
};

/** when orders went to 0 (read from the data history, so it survives a reload) */
const accidentOf = (env: AwsEnv) => dbNamed(env, 'webapp-db')?.data?.find((d) => d.tables.orders === 0)?.at ?? 0;
const jst = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(11, 19);
/** the learner may retry under another name (webapp-db-pitr2 ...) */
const pitrDbs = (env: AwsEnv) => env.dbInstances.filter((d) => d.dbInstanceIdentifier.startsWith('webapp-db-pitr'));
const goodPitr = (env: AwsEnv) => pitrDbs(env).find((d) => currentTables(d).orders === ORDERS && usesDbSg(env, d.dbInstanceIdentifier) && d.status === 'available');

export const lesson29: Lesson = {
  id: 'rpo-rto-dr',
  number: '29',
  title: 'RPO / RTO と DR 戦略',
  summary: '特定時点への復元でデータ損失を最小にし、要件に合う DR 戦略を選ぶ',
  minutes: 30,
  startPath: '/rds/databases',
  scenario: () => accidentEnv().env,
  steps: [
    {
      type: 'dialogue',
      lines: [
        hakase('前回は、手動スナップショットのおかげで君の首がつながった。'),
        node('言い方！ でもクイズで「スナップショットだけで戻すと、最大で何時間分のデータを失う？」って聞かれて、ぞっとしました。'),
        hakase('12 時間分、だったな。障害に備える設計では、まずそこを数字で決める。**RPO** と **RTO** だ。'),
        node('あーるぴーおー……？ 新型のロボットですか。'),
        hakase('ロボットではない。RPO (Recovery Point Objective、目標復旧時点) は「**どの時点まで戻れればよいか**」。つまり、何分・何時間分のデータ損失まで許せるかだ。'),
        node('前回のクイズなら、3:00 まで戻るから 12 時間分失う。RPO 12 時間ってことですね。'),
        hakase('そうだ。もう一つの RTO (Recovery Time Objective、目標復旧時間) は「**どれだけの時間で復旧すべきか**」。つまり、どれだけ止まっていてよいかだ。'),
        node('RPO は「過去のどこまで戻るか」、RTO は「この先いつまでに直すか」…ですか。'),
        hakase('うまいことを言う。事故の瞬間を真ん中に置いて、左 (過去) に RPO、右 (未来) に RTO だ。'),
        node('じゃあ、どっちもゼロにすればいいじゃないですか。'),
        hakase('できるとも。お金がいくらでもあればな。ゼロに近づけるほど、予備の環境や仕組みにお金と手間がかかる。だから、ビジネスと相談して決めるのだ。'),
        node('「注文を 1 時間分失ったらいくら損するか」を、社長の顔色を見ながら決めるってことですね。'),
      ],
    },
    {
      type: 'table',
      title: 'RPO と RTO',
      columns: ['指標', '問い', '例', '縮める方法'],
      rows: [
        ['RPO', 'どこまでのデータを失ってよい？', '「最大 5 分ぶん」', 'バックアップの頻度を上げる・レプリケーション'],
        ['RTO', 'どれだけ止まってよい？', '「1 時間以内に復旧」', '予備の環境を用意しておく・手順を自動化する'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('表の「レプリケーション」って何ですか？'),
        hakase('データを別の場所へ、ほぼリアルタイムで複製し続けることだ。複製し続けていれば、失うのは最後の数秒だけで済む。つまり RPO が縮む。'),
        node('RTO のほうの「予備の環境を用意しておく」は？'),
        hakase('壊れてから一から作ると、作り終わるまで止まったままだ。最初から待機させておけば、切り替えるだけで済む。そのかわり、何も起きない日も予備の料金を払い続けることになるがな。'),
        node('保険料みたいなものですね。'),
        hakase('そうだ。こういう、大きな障害や災害から立ち直るための備えを **DR (Disaster Recovery、災害対策)** という。今日の後半では、要件に合う DR の戦略を選んでもらう。'),
        node('災害って、地震とかですか？'),
        hakase('地震も、データセンターの停電も、そして……本番で WHERE を書き忘れる新人も、だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('博士、大変です！ さっきのクリーンアップ処理が orders を**全件消しました**。そのあとも新しい注文は少し入ってきてます……'),
        hakase('……噂をすれば、か。今度は新人ではなく、クリーンアップのバッチ処理が犯人だな。'),
        node('前回と同じで、WHERE が効いてないみたいです。しかも今回は、作業前のスナップショットなんて撮ってません！'),
        hakase('手動のはな。だが**自動バックアップ**はある。Lesson 28 の表を覚えておるか。'),
        node('毎日のスナップショットと、5 分ごとのトランザクションログ、でしたよね。'),
        hakase('そうだ。夜中の自動スナップショットに戻すと、それ以降の今日の注文がすべて消える。RPO は半日以上だ。'),
        node('それはまずいです。社長の顔色が……'),
        hakase('そこで**特定時点への復元**だ。スナップショットにトランザクションログを足して、事故の直前まで戻す。秒単位で時点を選べるぞ。'),
        node('日記帳を、事故の直前のページまで読み返すってことですね。'),
        hakase('うむ。復元の画面には「**最新の復元可能時間**」と「**カスタム日時**」がある。最新を選ぶと、ログがある一番新しい時点……つまり DELETE の**後**に戻ってしまう。'),
        node('空っぽの状態を丁寧に復元しても、意味ないですもんね。'),
        hakase('だから、まず事故の正確な時刻を調べる。batch-1 の `cleanup.log` に記録が残っておるはずだ。入力する時刻は日本時間 (UTC+09:00) だ。UTC は世界の基準の時刻で、日本はそれより 9 時間進んでおる。'),
      ],
    },
    {
      type: 'exercise',
      title: '事故の時刻を調べる',
      objective: '`batch-1` に接続し、`cat cleanup.log` で DELETE が実行された時刻を確認する',
      tasks: [{ id: 'log', title: '`cat cleanup.log`', hint: 'batch-1 → 接続 → EC2 Instance Connect。', hotspotId: 'terminal-input', done: (c) => !!lastRun(c, 'batch-1', /cat\s+cleanup\.log/)?.ok }],
      validate: (c) =>
        lastRun(c, 'batch-1', /cat\s+cleanup\.log/)?.ok
          ? ok(
              node(`DELETE は **${jst(accidentOf(c.env))}** (日本時間) です。`),
              hakase('ではその少し前、1 分前あたりを復元時点にしよう。'),
              node('特定時点への復元も、前回みたいに新しい DB ができるんですよね。'),
              hakase('そうだ。名前は `webapp-db-pitr`。PITR は Point-In-Time Recovery (特定時点への復元) の頭文字だ。セキュリティグループも `db-sg` を選び直すのを忘れるな。君の記憶が揮発性でなければな。'),
            )
          : ng(hakase('cleanup.log を開くのだ。batch-1 → 接続 → EC2 Instance Connect で入って、`cat cleanup.log` と打つ。')),
    },
    {
      type: 'exercise',
      title: '特定時点への復元',
      objective: '`webapp-db` を **カスタム日時** (事故の少し前) に復元して `webapp-db-pitr` を作る。セキュリティグループは `db-sg`',
      tasks: [
        { id: 'restore', title: 'RDS > `webapp-db` → アクション → **特定時点への復元** → カスタム日時', hint: '時刻は UTC+09:00 (日本時間) で入力します。', hotspotId: 'rds-pitr-submit', done: (c) => pitrDbs(c.env).length > 0 },
        { id: 'available', title: 'ステータスが「利用可能」になる', hint: 'RDS > データベース の一覧で `webapp-db-pitr` の **ステータス** 列を見ます。作成中 → バックアップ中 → 利用可能 の順に変わります。', done: (c) => pitrDbs(c.env).some((d) => d.status === 'available') },
      ],
      validate: (c) => {
        if (goodPitr(c.env))
          return ok(
            hakase('復元できたな。'),
            node('前回みたいに、件数を数えて確かめるんですよね。'),
            hakase('ほう、言われる前に言うとは。今日は槍でも降るのか。データは何件あるか、確かめてみよう。'),
          );
        const dbs = pitrDbs(c.env);
        if (!dbs.length) return ng(hakase('webapp-db-pitr が見当たらん。RDS > データベース で `webapp-db` を選び、アクション → **特定時点への復元** で、DB インスタンス識別子を `webapp-db-pitr` にするのだ。'));
        if (dbs.every((d) => currentTables(d).orders === 0))
          return ng(
            hakase('空っぽの orders を、丁寧に復元してしまったな。復元した時点がすでに事故の後だ。'),
            hakase('「最新の復元可能時間」ではなく、事故より前のカスタム日時を選ぶのだ。名前を `webapp-db-pitr2` にして、もう一度復元すればよい。'),
          );
        if (!dbs.some((d) => usesDbSg(c.env, d.dbInstanceIdentifier))) return ng(hakase('セキュリティグループが db-sg になっていない。復元した DB の「変更」で、VPC セキュリティグループを db-sg に付け替えるのだ。'));
        return ng(hakase('まだ作成中だ。「利用可能」になるまで待つのだ。'));
      },
    },
    {
      type: 'exercise',
      title: '失ったデータを比べる',
      objective: '`mysql -h <webapp-db-pitr のエンドポイント> -e "SELECT COUNT(*) FROM orders"` で件数を確認する',
      tasks: [{ id: 'check', title: '`mysql -h webapp-db-pitr.… -e "SELECT COUNT(*) FROM orders"`', hint: '`webapp-db-pitr` の **接続とセキュリティ** タブでエンドポイントをコピーし、batch-1 のターミナルで `-h` のあとに貼り付けます。', done: (c) => !!lastRun(c, 'batch-1', /-h\s*\S*webapp-db-pitr/)?.ok }],
      validate: (c) =>
        lastRun(c, 'batch-1', /-h\s*\S*webapp-db-pitr/)?.output.includes(String(ORDERS))
          ? ok(
              node(`${n} 件！ 夜中の自動スナップショットは 4,112 件少なかったので、そっちに戻していたら今日の注文が消えてました。`),
              hakase('特定時点への復元で、RPO は「数分」になった。事故のあとに入った 58 件は、今の webapp-db から移せばよい。'),
              node('助かりました… でも、DB どころか東京リージョンごと使えなくなったら、どうするんです？'),
              hakase('そこで DR だ。代表的な戦略が 4 つある。表にしておいたから、RPO と RTO とコストを見比べてみろ。'),
            )
          : ng(hakase('webapp-db-pitr のエンドポイントで件数を確かめるのだ。エンドポイントは「接続とセキュリティ」タブにある。それを `mysql -h` のあとに貼り付ける。')),
    },
    {
      type: 'table',
      title: 'DR (災害対策) の 4 つの戦略',
      columns: ['戦略', '平常時の DR サイト', 'RPO', 'RTO', 'コスト'],
      rows: [
        ['バックアップと復元', 'なし (バックアップを別リージョンにコピーしておく)', '時間', '数時間〜1 日', '$'],
        ['パイロットライト', 'DB だけ複製して稼働。アプリは停止', '数分', '数十分〜数時間', '$$'],
        ['ウォームスタンバイ', '縮小した環境一式が稼働中', '数秒〜数分', '数分', '$$$'],
        ['マルチサイト (アクティブ/アクティブ)', '本番と同じ規模で両方が稼働', 'ほぼ 0', 'ほぼ 0', '$$$$'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('表の「DR サイト」は、災害のときに切り替える先の環境のことだ。上から下へ、安くて遅い → 高くて速い、の順に並べてある。'),
        node('「バックアップと復元」は、バックアップを別のリージョンにコピーしておくだけですか。'),
        hakase('そうだ。災害が起きてから、コピーしておいたバックアップで環境を一から作る。安いが、作り終わるまで何時間も止まる。'),
        node('「パイロットライト」って何です？ パイロットの…ライト？'),
        hakase('ガス給湯器の**種火**のことだ。DB だけは別のリージョンに複製して動かしておき、アプリのサーバーは止めておく。いざとなったら、種火から火を大きくする。'),
        node('種火！ じゃあ「ウォームスタンバイ」は、エンジンをかけたまま待ってる車ですね。'),
        hakase('うむ。小さくした環境一式を常に動かしておき、障害時に大きくして切り替える。**マルチサイト**は、2 つの拠点が両方とも現役 (アクティブ) で、本番と同じ規模で動いている。片方が消えても、もう片方がそのまま受ける。'),
        node('一番安心だけど、お金も 2 倍…'),
        hakase('2 倍で済めば安いほうだ。'),
        node('そういえば、webapp-db を**マルチ AZ** にしておけば、今回の DELETE も防げたんですか？'),
        hakase('防げん。マルチ AZ は、別の AZ に待機用の DB (**スタンバイ**) を置いて、**同期で**書き込み続ける仕組みだ。'),
        node('同期で… じゃあ DELETE も、一瞬でスタンバイに届く？'),
        hakase('そうだ。仲良く 2 台そろって空っぽになる。マルチ AZ は「AZ の障害」に対する**高可用性 (HA、止まりにくさ)** の仕組みで、「間違った操作」から守るのはバックアップだ。両方必要なのだ。'),
        node('AZ は Lesson 02 でやった、リージョンの中の独立したデータセンター群でしたよね。停電には強いけど、人間のうっかりには弱い、と。'),
        hakase('うむ。人間のうっかりに強いサービスは、AWS にもまだない。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('社内の申請システムだ。「1 日分のデータ損失と、1 日の停止までは許容。とにかく安く」。どの DR 戦略かな？'),
      options: ['バックアップと復元', 'ウォームスタンバイ', 'マルチサイト'],
      answer: 0,
      explanation: [
        hakase('正解。RPO も RTO も 1 日でよいなら、バックアップを別リージョンにコピーしておくだけで足りる。'),
        node('種火すらいらない、ってことですね。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('次は EC サイトだ。「データ損失は数秒まで、停止は数分まで。平常時は小さな環境で待機してよい」。どれかな？'),
      options: ['パイロットライト', 'ウォームスタンバイ', 'バックアップと復元'],
      answer: 1,
      explanation: [
        hakase('正解。縮小した環境一式を常に動かしておき、障害時に拡大して切り替える。'),
        node('パイロットライトだと、種火から火を起こしてる間に数分が過ぎちゃうんですね。'),
        hakase('そうだ。アプリのサーバーが止まっているぶん、RTO が長くなる。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後だ。webapp-db をマルチ AZ にした。これで守れるのはどれかな？'),
      options: ['誤って実行した DELETE', 'AZ 全体の障害', 'リージョン全体の障害'],
      answer: 1,
      explanation: [
        hakase('正解。誤操作にはバックアップ (特定時点への復元)、リージョン全体の障害には別リージョンへの DR が必要だ。'),
        node('マルチ AZ は万能薬じゃない、と。'),
      ],
    },
  ],
};
