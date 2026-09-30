import { hakase, ng, node, ok, type Lesson } from '../lesson/types';
import { deregisterTargets, registerTargets } from '../sim/elb';
import { webAppEnv } from '../sim/scenarios';
import { setSecurityGroupRules } from '../sim/sg';
import { albReachesWeb, allTargetsHealthy, copied, instanceNamed, lastAlbRequest, sgAllows, sgNamed, tgNamed, visited, visitedId, webReachesDb } from './helpers';

const sgId = (env: Parameters<typeof sgNamed>[0], name: string) => sgNamed(env, name)!.groupId;

export const lesson16: Lesson = {
  id: 'sg-troubleshooting',
  number: '16',
  title: 'Security Group Troubleshooting',
  summary: '504 の原因をターゲットのヘルスから辿り、ALB の SG ID を Copy & Paste で許可する',
  minutes: 25,
  startPath: '/ec2/load-balancers',
  scenario: () => webAppEnv({}, (env) => setSecurityGroupRules(env, sgId(env, 'web-sg'), 'ingress', [{ ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: '10.0.0.0/16', description: 'SSH from VPC' }])),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士！ サイトを開くと **504 Gateway Time-out** って出ます！'),
        hakase('ほう、朝から景気のいい数字だな。'),
        node('景気よくないです！ 昨日、誰かが `web-sg` を「整理」したらしくて…'),
        hakase('「整理」。障害報告書で一番よく見る単語だ。たいてい「不要と思われるルールを削除」と続く。'),
        node('「思われる」ってところが怖いですね。'),
        hakase('さて、504 の意味は分かるかな？'),
        node('5 で始まるのはサーバー側のエラー…ですよね。Lesson 12 では、Target が 1 台も登録されてなくて 503 でした。'),
        hakase('うむ。503 は「転送先がいない」だった。504 は **Gateway Time-out**。ゲートウェイ、つまり中継役の ALB が、奥の Target の返事を待ちくたびれた、という意味だ。'),
        node('げーとうぇい…Lesson 08 のインターネットゲートウェイのゲートウェイですか？'),
        hakase('言葉は同じで、「出入口」「中継役」のことだ。ここでは ALB のことだと思えばよい。ALB は客の注文を受け取って厨房 (Target) に回したが、料理がいつまで経っても出てこない。'),
        node('ウェイターが「すみません、厨房が返事をしません」って客に謝ってる状態ですね。'),
        hakase('そうだ。厨房が返事をしない理由は 2 つ。厨房が燃えているか、注文票が厨房まで届いていないかだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('どっちなんですか？'),
        hakase('それを調べるのが今日の仕事だ。障害対応の基本は 2 つ。「症状を自分で確かめる」、そして「外側から順に調べる」。'),
        node('外側から？'),
        hakase('お客さんに近い方からだ。Internet → ALB → EC2 → RDS。Lesson 15 で、この区間を 1 本ずつ説明したな。'),
        node('はい。Internet → ALB が 80、ALB → EC2 が 3000、EC2 → RDS が 3306 でしたよね。'),
        hakase('ほう、覚えておったか。障害対応中に限って物覚えがよくなる。追い詰められた人間の特徴だな。'),
        node('504 なら降ってます。'),
        hakase('うまいことを言っても障害は直らんぞ。まずはブラウザで再現だ。ロードバランサーの一覧から `web-alb` の **DNS 名** をコピーして、「ブラウザ」タブで開くのだ。'),
        node('他人の「開きません」じゃなくて、自分の目で 504 を見る、ですね。'),
      ],
    },
    {
      type: 'exercise',
      title: '症状を確認する',
      objective: 'ブラウザで `web-alb` にアクセスし、504 を確認する',
      tasks: [{ id: 'browse', title: 'ブラウザタブで ALB の DNS 名を開く', hint: 'ロードバランサー一覧の DNS 名をコピーして貼り付けます。', done: (c) => lastAlbRequest(c)?.status === 504 }],
      validate: (c) =>
        lastAlbRequest(c)?.status === 504
          ? ok(
              hakase('504 だな。「ALB は受け取ったが、Target が時間内に応答しなかった」という意味だ。'),
              node('ALB が 504 を返してくれてるってことは、Internet → ALB までは届いてるんですね。'),
              hakase('冴えておるな。怪しいのはその奥だ。次は `web-alb` の「リスナーとルール」を開く。リスナーは Lesson 11 でやった、ALB の受付窓口 (HTTP:80) だったな。'),
              node('受付窓口の「デフォルトアクション」ってところに、注文の回し先が書いてあるんですか？'),
              hakase('そうだ。デフォルトアクションは「ほかに条件が無ければ、こうする」という既定の動きだ。そこにある転送先 `web-tg` から、Lesson 13 で読んだ「ヘルスステータスの詳細」を見に行くのだ。'),
            )
          : ng(hakase('まだ 504 を確認していない。ロードバランサーの一覧で `web-alb` の DNS 名をコピーし、「ブラウザ」タブに貼り付けて開くのだ。')),
    },
    {
      type: 'exercise',
      title: 'ロードバランサー → ターゲットグループ → ターゲットのヘルスを調べる',
      objective: '`web-alb` の Listener から `web-tg` を開き、Target の **ヘルスステータスの詳細** を読む',
      tasks: [
        { id: 'lb', title: 'ロードバランサーで `web-alb` を開く', hint: 'EC2 の左メニュー「ロードバランシング」→「ロードバランサー」で、名前列の `web-alb` のリンクをクリックします。', done: (c) => visitedId(c, '/ec2/load-balancers/', 'web-alb') },
        { id: 'tg', title: 'リスナーとルール の デフォルトアクション から `web-tg` を開く', hint: '「ターゲットグループへの転送」の下のリンクです。', done: (c) => visitedId(c, '/ec2/target-groups/', 'web-tg') },
      ],
      validate: (c) =>
        visitedId(c, '/ec2/target-groups/', 'web-tg')
          ? ok(
              node('両方 **異常 (unhealthy)** で、`Request timed out` って書いてあります。'),
              hakase('Timeout は「パケットが届いていない」合図だ。アプリの不具合ではなく、**ネットワーク (Security Group)** で止まっている可能性が高い。'),
              node('アプリが壊れてたら、エラーでも何かしら返事は来るはず、ってことですね。'),
              hakase('そうだ。燃えている厨房でも悲鳴くらいは返す。無言なのは、注文票が届いていないからだ。'),
            )
          : ng(hakase('web-tg のターゲットをまだ見ていないようだ。`web-alb` の「リスナーとルール」で、デフォルトアクションにある `web-tg` のリンクを開くのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        hakase('ALB → EC2 の通信を受ける側、つまり EC2 に付いている `web-sg` のインバウンドルールを見よう。アプリの TCP 3000 が、ALB から許可されていないはずだ。'),
        node('3000 はアプリが待ち受けてるポートでしたよね。Lesson 12 のクイズでやりました。'),
        hakase('うむ。リスナーの 80 は客が叩く表の扉、3000 は厨房の勝手口だ。'),
        node('ソースには何を書けばいいんですか？ ALB の IP アドレス？'),
        hakase('ALB の IP は、AWS の都合で増えたり変わったりする。IP で書くと、ある朝突然また 504 だ。'),
        node('朝から 504 はもう嫌です。'),
        hakase('だから **ALB に付いている Security Group (`alb-sg`) の ID** をソースにするのだ。Lesson 15 で辿った「Security Group の鎖」だな。'),
        node('「`alb-sg` が付いているものからなら通す」って書き方でしたね。IP が変わっても、付いてる Security Group は変わらない。'),
        hakase('そうだ。ID は `web-alb` の詳細の「セキュリティ」タブに出ておる。そして ID は手で打たず、**コピーして貼り付ける**。`sg-` から始まる長い英数字を深夜に手で打つのは、自分の首を絞める行為だ。'),
        node('1 文字間違えたら、別の Security Group を許可しちゃうかもしれないですもんね。'),
        hakase('あるいは存在しない ID で保存エラーだ。どちらにしても始末書が 1 枚増える。'),
        node('ルールは「カスタム TCP」で、ポート範囲 `3000`、ソースに貼り付け、ですね。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ALB の SG ID を Copy して EC2 の SG に Paste する',
      objective: '`web-sg` の インバウンドルールに「カスタム TCP 3000 / ソース = alb-sg の ID」を追加する',
      tasks: [
        { id: 'copy', title: '`web-alb` の **セキュリティ** タブで `alb-sg` の ID をコピー', hint: 'ロードバランサー詳細 → セキュリティタブ → セキュリティグループ ID の横のコピーアイコン。alb-sg の詳細画面でもコピーできます。', done: (c) => copied(c, sgNamed(c.env, 'alb-sg')?.groupId) },
        { id: 'open', title: '`web-sg` を開いて **インバウンドのルールを編集**', hint: 'EC2 の セキュリティグループで web-sg を探します (web-1 の セキュリティタブからも辿れます)。', hotspotId: 'sg-edit-inbound', done: (c) => visited(c, new RegExp(`${sgNamed(c.env, 'web-sg')?.groupId}/edit-inbound`)) },
        { id: 'paste', title: '**ルールを追加** → カスタム TCP / ポート範囲 `3000` / ソースに **貼り付け** (Ctrl+V) → **ルールを保存**', hint: 'ソース欄に sg-... を貼り付けると、そのまま使えます。候補から選んでも OK。', hotspotId: 'sg-save-rules', done: (c) => sgAllows(c.env, 'web-sg', 3000, { groupName: 'alb-sg', ip: '10.0.1.200' }) },
      ],
      validate: (c) => {
        if (!albReachesWeb(c.env)) return ng(hakase('まだ ALB から web-1 / web-2 の TCP 3000 に届かない。ポート範囲が `3000` か、ソースが `alb-sg` の ID (`sg-...`) になっているかを確認するのだ。'));
        if (sgAllows(c.env, 'web-sg', 3000, { ip: '192.0.2.10' })) return ng(hakase('つながりはするが…ソースが `0.0.0.0/0` になっていないか？ 厨房の勝手口を全世界に開けてどうする。EC2 は ALB 以外から 3000 番を受ける必要は無い。ソースは alb-sg の ID にしよう。'));
        return ok(
          hakase('よし。これで「alb-sg が付いたもの (= ALB) から TCP 3000」だけが許可された。'),
          node('「整理」した人に、整理しすぎですって言っておきます。'),
          hakase('ついでに、消す前にルールの説明欄くらい読め、と付け加えておくのだな。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '復旧を確認する',
      objective: 'Target が healthy になり、ブラウザで 200 が返ることを確認する',
      tasks: [
        { id: 'healthy', title: '`web-tg` の Target がすべて **正常 (healthy)**', hint: '`web-tg` の「ターゲット」タブで、「ヘルスステータスの詳細」から `Request timed out` が消え、2 台とも **正常** になったか確認します。', done: (c) => allTargetsHealthy(c.env, 'web-tg', 2) },
        { id: 'browse', title: 'ブラウザで ALB にアクセス → **200**', hint: 'ターゲットが正常になってから、「ブラウザ」タブで `web-alb` の DNS 名をもう一度開きます。504 から変わったか確かめましょう。', done: (c) => lastAlbRequest(c)?.status === 200 },
      ],
      validate: (c) =>
        lastAlbRequest(c)?.status === 200
          ? ok(
              node('直りました！ Target も両方 healthy です！'),
              hakase('症状を確かめ、外側から辿り、Timeout からネットワークを疑い、ID はコピーで直す。今日の手順は、そのまま本物の障害でも使える。'),
              node('もう 504 が出ても怖くないです。'),
              hakase('その油断が次の障害を呼ぶのだ。まあ、呼ばれたらまたワシを呼ぶがよい。'),
            )
          : ng(hakase('最新のアクセスがまだ 200 ではない。`web-tg` の Target が両方 healthy になったのを確かめてから、もう一度ブラウザで ALB を開くのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。`web-sg` に「TCP 3000 / ソース sg-alb」がある。ALB から EC2 の **TCP 3001** への通信は？'),
      options: ['通信できる (同じ Security Group だから)', '通信できない (3001 に一致する許可ルールが無い)'],
      answer: 1,
      explanation: [
        hakase('正解。Security Group は許可リストだ。ポートもソースも一致するルールが無ければ、黙って拒否される。'),
        node('1 番違いでも容赦なし、ですね。'),
        hakase('入館証の部屋番号が 1 つ違えば、警備員は通さん。それと同じだ。'),
      ],
    },
  ],
};

export const lesson17: Lesson = {
  id: 'target-unhealthy',
  number: '17',
  title: 'Target Unhealthy Troubleshooting',
  summary: '502 Bad Gateway を ターゲットのヘルスとポートから切り分ける',
  minutes: 20,
  startPath: '/ec2/target-groups',
  scenario: () =>
    webAppEnv({}, (env) => {
      // The target group was created with the console default port 80, but the app listens on 3000.
      const tg = env.targetGroups[0];
      tg.port = 80;
      const ids = tg.targets.map((t) => t.id);
      deregisterTargets(env, tg.targetGroupArn, tg.targets);
      registerTargets(env, tg.targetGroupArn, ids.map((id) => ({ id, port: 80 })));
      setSecurityGroupRules(env, sgId(env, 'web-sg'), 'ingress', [
        { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: sgId(env, 'alb-sg'), description: 'HTTP from ALB' },
        { ipProtocol: 'tcp', fromPort: 3000, toPort: 3000, source: sgId(env, 'alb-sg'), description: 'App port from ALB' },
      ]);
    }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、新しく作り直した環境で、今度は **502 Bad Gateway** が出ます…'),
        hakase('504 の次は 502 か。君は 5xx のコレクターだな。'),
        node('集めたくて集めてるわけじゃないです。504 と 2 しか違わないですけど、似たようなものですか？'),
        hakase('数字は近いが、意味はまったく別物だ。電話で言えば、504 は「呼び出し音が鳴り続けて、誰も出ない」。'),
        node('502 は？'),
        hakase('「つながった瞬間にガチャ切りされた」、あるいは「出たけど意味不明なことを言われた」だ。'),
        node('どっちも嫌な電話ですね。'),
        hakase('Bad Gateway は、中継役の ALB が「奥の相手から、まともな返事がもらえなかった」と言っておるのだ。504 との違いは、相手まで**届いている**かどうかだ。'),
        node('504 は届いてない、502 は届いてるけど断られた…'),
        hakase('そういうことだ。表にまとめておいた。Lesson 12 で見た 503 も並べてある。'),
      ],
    },
    {
      type: 'table',
      title: 'ALB が返す 5xx の読み方',
      columns: ['ステータス', 'ALB から見た状況', 'よくある原因'],
      rows: [
        ['502 Bad Gateway', 'Target まで届いたが、接続を拒否された / 応答が不正', 'ターゲットのポート でアプリが待ち受けていない、アプリのクラッシュ'],
        ['503 Service Unavailable', '転送できる Target が無い', 'Target が 1 台も登録されていない'],
        ['504 Gateway Time-out', 'Target が時間内に応答しない', 'Security Group / NACL で遮断、アプリが重い'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('「待ち受けていない」って、どういう状態ですか？'),
        hakase('ポートは、サーバーの中の窓口の番号だ。アプリは決まった番号の窓口に座って、客を待つ。これを「待ち受ける」、英語で listen という。'),
        node('誰も座っていない窓口に行ったら？'),
        hakase('「その窓口はやっておりません」と即座に突き返される。これが**接続拒否**だ。待たされないぶん、Timeout よりは親切だな。'),
        node('親切な門前払い…'),
        hakase('Lesson 16 で見た `Request timed out` は、門の前にすら着けなかった。今回は門まで着いて、叩いて、断られた可能性が高い。'),
        node('じゃあ Security Group は通ってる、ってことですか？'),
        hakase('仮説としてはな。確かめるのはいつもの順番だ。まずブラウザで 502 を見て、`web-tg` のターゲットタブで**ヘルスステータスの詳細**と**ポート**を見るのだ。'),
        node('ポートも見るんですね。'),
        hakase('窓口の番号を間違えた本人は、たいてい自分では気づかん。…ところでノード君、この環境を作り直したのは誰だったかな？'),
        node('…さあ、誰でしたっけ。'),
      ],
    },
    {
      type: 'exercise',
      title: '症状とターゲットのヘルスを確認する',
      objective: 'ブラウザで 502 を確認し、`web-tg` の Targets で ヘルスステータスの詳細 と **ポート** を見る',
      tasks: [
        { id: 'browse', title: 'ブラウザで ALB にアクセス → **502**', hint: 'ロードバランサー一覧で `web-alb` の DNS 名をコピーし、「ブラウザ」タブに貼り付けて **移動** します。', done: (c) => lastAlbRequest(c)?.status === 502 },
        { id: 'tg', title: '`web-tg` の ターゲットタブを開く', hint: 'EC2 の左メニュー「ロードバランシング」→「ターゲットグループ」から開きます。「ポート」列の値を、アプリが待ち受けているポートと見比べましょう。', done: (c) => visitedId(c, '/ec2/target-groups/', 'web-tg') },
      ],
      validate: (c) =>
        lastAlbRequest(c)?.status === 502 && visitedId(c, '/ec2/target-groups/', 'web-tg')
          ? ok(
              node('`Health checks failed` です。Timeout じゃないですね。それとポートが **80** になってます。'),
              hakase('Timeout でないということは、パケットは届いている (SG は通っている)。だが port 80 では誰も待ち受けていないから、接続を拒否されているのだ。'),
              hakase('このアプリは **port 3000** で動いている。Target group を作るとき、Console の既定値 80 のまま作ってしまったのだろう。'),
              node('既定値のまま「次へ」を連打したんですね…誰かが。'),
              hakase('「次へ」の連打は、障害報告書の原因欄の常連だ。'),
            )
          : ng(hakase('502 の確認と、ターゲットタブの確認の両方をするのだ。ブラウザで ALB を開いてから、ターゲットグループ `web-tg` の「ターゲット」タブでポートの列を見るのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('Target group のポートを 3000 に変更すればいいんですね！ 編集ボタンはどこだろう…'),
        hakase('探しても無駄だ。Target group のプロトコルとポートは**作成後に変更できない**。'),
        node('ええっ、じゃあ作り直しですか？'),
        hakase('それも手だが、リスナーの転送先の付け替えまで要る。もっと楽な道がある。Target を登録するとき、ポートを 1 台ずつ指定できるのだ。'),
        node('じゃあ Target group のポートって、ただの初期値なんですか？'),
        hakase('そうだ。登録画面の「選択したインスタンスのポート」の初期値になるだけで、実際に使われるのは Target ごとに登録したポートだ。'),
        node('web-1 と web-2 を 3000 で登録し直せばいいんですね。'),
        hakase('うむ。そして 80 で登録されている方は「登録解除」、つまり名簿から外す。'),
        node('3000 で登録できたら、80 のは放っておいてもよくないですか？'),
        hakase('よくない。Lesson 13 の **fail open** を覚えておるか。'),
        node('全 Target が unhealthy になると、ALB が「全部止めるよりマシ」って unhealthy な Target にも送るやつ…あ、今の 502 もそれですね。'),
        hakase('その通り。80 の亡霊を残しておくと、何かの拍子にまた 502 を呼び出す。登録画面では、ポートを 3000 に書き換えてから「保留中として以下を含める」、最後に「保留中のターゲットを登録」だ。'),
        node('ヘルスチェックも 3000 で見てくれるんですか？'),
        hakase('Lesson 13 の表にあったな。ヘルスチェックのポートは通常「トラフィックポート」、つまり Target の登録ポートだ。3000 で登録すれば、3000 がチェックされる。'),
      ],
    },
    {
      type: 'exercise',
      title: 'Target を port 3000 で登録し直す',
      objective: '`web-1` / `web-2` をポート `3000` で登録し、ポート `80` のターゲットを登録解除して、すべて **正常 (healthy)** にする',
      tasks: [
        { id: 'register', title: '**ターゲットの登録** で web-1, web-2 をポート `3000` で登録', hint: '「選択したインスタンスのポート」を 3000 に書き換えてから **保留中として以下を含める**。', hotspotId: 'tg-register', done: (c) => ['web-1', 'web-2'].every((n) => tgNamed(c.env, 'web-tg')?.targets.some((t) => t.id === instanceNamed(c.env, n)?.instanceId && t.port === 3000)) },
        { id: 'deregister', title: 'ポート `80` のターゲットを選んで **登録解除**', hint: '登録済みターゲットの一覧でチェックを付けて **登録解除**。', done: (c) => !tgNamed(c.env, 'web-tg')?.targets.some((t) => t.port === 80) },
        { id: 'healthy', title: 'すべてのターゲットが **正常 (healthy)**', hint: 'ヘルスチェックのポートは「トラフィックポート」なので、登録した 3000 番がチェックされます。', done: (c) => allTargetsHealthy(c.env, 'web-tg', 2) },
      ],
      validate: (c) => {
        const tg = tgNamed(c.env, 'web-tg')!;
        if (tg.targets.some((t) => t.port === 80)) return ng(hakase('ポート 80 の Target が残っている。unhealthy な亡霊は、fail open のときにまた 502 の原因になるぞ。登録済みターゲットの一覧でポート 80 の行にチェックを付けて **登録解除** するのだ。'));
        if (!allTargetsHealthy(c.env, 'web-tg', 2)) return ng(hakase('healthy でない Target があるようだ。web-1 と web-2 の両方が、ポート 3000 で登録されているか確認するのだ。'));
        return ok(
          hakase('全 Target が port 3000 で healthy になった。'),
          node('窓口の番号を合わせただけで、門前払いが終わりました。'),
          hakase('番号 1 つで世界は変わる。接続先を 1 文字間違えて本番 DB に入り、テーブルを消した男をワシは知っておる。'),
          node('その人、どうなったんですか？'),
          hakase('今は障害報告書の書き方を教えておる。…ワシだがな。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '復旧を確認する',
      objective: 'ブラウザで ALB にアクセスし、200 を確認する',
      tasks: [{ id: 'browse', title: 'ブラウザで ALB にアクセス → **200**', hint: 'ターゲットが 2 台ともポート 3000 で正常になってから、「ブラウザ」タブで `web-alb` の DNS 名をもう一度開きます。', done: (c) => lastAlbRequest(c)?.status === 200 }],
      validate: (c) =>
        lastAlbRequest(c)?.status === 200
          ? ok(
              node('502 が消えました！ 200 です！'),
              hakase('Timeout なら経路、門前払いならポートかアプリ。5xx の数字とヘルスステータスの詳細を並べれば、どこを見るべきかは半分決まる。'),
              node('これで 5xx コレクターも卒業ですね。'),
              hakase('安心したまえ。まだ 500 が残っておる。'),
            )
          : ng(hakase('最新のアクセスがまだ 200 ではない。ターゲットが両方 healthy になっているのを確かめて、もう一度ブラウザで ALB を開くのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。Security Group で ALB → EC2 が遮断されているとき、ブラウザに出やすいのはどれかな？'),
      options: ['502 Bad Gateway', '504 Gateway Time-out', '404 Not Found'],
      answer: 1,
      explanation: [
        hakase('正解。遮断されたパケットには返事が来ないから Timeout、つまり 504 になる。ヘルスステータスの詳細の `Request timed out` とセットで覚えるのだ。'),
        node('Timeout なら Security Group やネットワーク ACL、Health checks failed ならポートやアプリ、ですね。'),
        hakase('うむ。この 2 行を覚えておけば、深夜の呼び出しが 30 分は短くなる。'),
      ],
    },
  ],
};

export const lesson18: Lesson = {
  id: 'ec2-rds-troubleshooting',
  number: '18',
  title: 'EC2 → RDS Troubleshooting',
  summary: 'Application cannot connect to database を RDS の「接続とセキュリティ」から調べる',
  minutes: 20,
  startPath: '/rds/databases',
  scenario: () => webAppEnv({}, (env) => setSecurityGroupRules(env, sgId(env, 'db-sg'), 'ingress', [{ ipProtocol: 'tcp', fromPort: 3306, toPort: 3306, source: '10.0.1.0/24', description: 'MySQL from app servers' }])),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、アプリのログに **Application cannot connect to database** って出てます。その後ろに `connect ETIMEDOUT` って。'),
        hakase('ほう、英語のログを読もうとしたのか。成長したな。'),
        node('「アプリがデータベースに接続できません」ですよね。それくらい読めます。…で、いーてぃめどあうと？'),
        hakase('E は Error、TIMEDOUT は時間切れ。「接続しようとしたが、時間切れになった」というエラーの名前だ。'),
        node('また Timeout ですか。Lesson 16 と 16-2 で、Timeout はネットワークで止まってる合図って習いました。'),
        hakase('うむ。今回はアプリ自身がそう言っておる。では、どこからどこへの接続かな？'),
        node('アプリがデータベースへ、ですから… EC2 → RDS の区間ですね。'),
        hakase('仮説としては上出来だ。だが、ログの一行だけで決めつけるのは早い。お客さんから何が見えているかを、まず確かめる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ブラウザで開けばいいんですね。'),
        hakase('そうだ。そこで出る数字で、切り分けが半分終わる。502 か 504 なら、ALB → EC2 が怪しい。'),
        node('Lesson 16 と 17 の、ALB が Target からまともな返事をもらえなかったやつですね。'),
        hakase('だが **500 Internal Server Error** なら話は別だ。500 は「サーバー内部のエラー」。アプリ自身が「すみません、中で失敗しました」と返事をした、という意味だ。'),
        node('アプリが返事をしてるなら、ALB → EC2 は届いてるってことですか？'),
        hakase('冴えておるな。店員が客に謝れるなら、少なくとも客と店員の間はつながっておる。謝っている理由は、倉庫 (DB) に行けないからだ。'),
        node('倉庫の鍵を、誰かが勝手に替えちゃった、みたいな。'),
        hakase('鍵を替えた奴は、たいてい「セキュリティのためです」と言う。では、ブラウザで ALB を開いて、何番が出るか見てみよ。'),
      ],
    },
    {
      type: 'exercise',
      title: '症状を確認する',
      objective: 'ブラウザで ALB にアクセスし、HTTP 500 を確認する',
      tasks: [{ id: 'browse', title: 'ブラウザで ALB にアクセス → **500**', hint: 'ロードバランサー一覧で `web-alb` の DNS 名をコピーして「ブラウザ」タブで開きます。ステータスコードに加えて、本文のエラーメッセージも読んでおきましょう。', done: (c) => lastAlbRequest(c)?.status === 500 }],
      validate: (c) =>
        lastAlbRequest(c)?.status === 500
          ? ok(
              hakase('500 は「アプリ自身がエラーを返した」だ。つまり Internet → ALB → EC2 は**届いている**。怪しいのはその先、EC2 → RDS だな。'),
              node('画面にも `connect ETIMEDOUT` って出てます。ログと同じですね。'),
              hakase('エラーの中身をお客さんの画面にまで出すのは、本番ではやめたほうがいい。攻撃者への親切な道案内になるからな。今日のところは助かったが。'),
              hakase('次は RDS 側だ。Lesson 14 でエンドポイントをコピーした「接続とセキュリティ」タブに、DB に付いている **VPC セキュリティグループ** が出ておる。'),
            )
          : ng(hakase('まだ 500 を確認していない。ロードバランサーの一覧で DNS 名をコピーし、「ブラウザ」タブで開くのだ。')),
    },
    {
      type: 'exercise',
      title: 'RDS → 接続とセキュリティ → セキュリティグループ → インバウンドルールを調べる',
      objective: '`webapp-db` の **接続とセキュリティ** タブから VPC セキュリティグループ `db-sg` を開き、インバウンドルールを確認する',
      tasks: [
        { id: 'db', title: 'RDS > データベース で `webapp-db` を開く', hint: 'Aurora and RDS の左メニュー「データベース」で、DB 識別子 `webapp-db` のリンクをクリックし、「接続とセキュリティ」タブを表示します。', done: (c) => visitedId(c, '/rds/databases/', 'webapp-db') },
        { id: 'sg', title: '接続とセキュリティの **VPC セキュリティグループ** から `db-sg` を開く', hint: 'セキュリティグループのルールの表でも、ルール列に ソースが見えます。', done: (c) => visitedId(c, '/security-groups/', sgNamed(c.env, 'db-sg')?.groupId) },
      ],
      validate: (c) =>
        visitedId(c, '/security-groups/', sgNamed(c.env, 'db-sg')?.groupId)
          ? ok(
              node('ソースが `10.0.1.0/24` です。説明には「MySQL from app servers」って書いてあるのに。'),
              hakase('10.0.1.0/24 は **public-subnet-1a** の範囲だ。web-1 / web-2 は private-subnet (10.0.11.0/24, 10.0.12.0/24) にいる。だから届かない。引っ越したのに転送届を出さなかったわけだ。'),
              node('じゃあ Lesson 15 の「Security Group の鎖」みたいに、ソースを `web-sg` の ID にすれば、住所が変わっても大丈夫ですね。'),
              hakase('そうだ。`web-1` の「セキュリティ」タブで `web-sg` の ID をコピーして、`db-sg` のソースに貼り付けるのだ。手で打つなよ。'),
            )
          : ng(hakase('db-sg のインバウンドルールをまだ見ていない。`webapp-db` の「接続とセキュリティ」タブで、VPC セキュリティグループの `db-sg` のリンクを開くのだ。')),
    },
    {
      type: 'exercise',
      title: 'ソースを web-sg に直す',
      objective: '`db-sg` の インバウンドルール の ソースを、EC2 に付いている `web-sg` の ID にする',
      tasks: [
        { id: 'copy', title: '`web-1` の **セキュリティ** タブなどで `web-sg` の ID をコピー', hint: 'EC2 > インスタンス > web-1 > セキュリティタブ、または web-sg の詳細画面で。', done: (c) => copied(c, sgNamed(c.env, 'web-sg')?.groupId) },
        { id: 'edit', title: '`db-sg` の **インバウンドのルールを編集** で ソースに貼り付けて **ルールを保存**', hint: '既存ルールの ソースを書き換えます。', hotspotId: 'sg-save-rules', done: (c) => sgAllows(c.env, 'db-sg', 3306, { groupName: 'web-sg', ip: '10.0.11.200' }) },
      ],
      validate: (c) => {
        if (!webReachesDb(c.env)) return ng(hakase('まだ web-1 / web-2 から webapp-db の 3306 に届かない。`db-sg` のインバウンドルールで、ポートが 3306、ソースが `web-sg` の ID (`sg-...`) になっているか確認するのだ。'));
        if (sgAllows(c.env, 'db-sg', 3306, { ip: '192.0.2.10' })) return ng(hakase('DB が全世界に開いておる！ 顧客データを世界中に配る気か。ソースは `0.0.0.0/0` ではなく web-sg にするのだ。'));
        return ok(
          hakase('EC2 → RDS がつながった。'),
          node('これで web-1 でも web-2 でも、web-sg が付いていれば DB に入れるんですね。'),
          hakase('うむ。台数が 100 台に増えても、ルールは 1 行のままだ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '復旧を確認する',
      objective: 'ブラウザで `Database: connected` を確認する',
      tasks: [{ id: 'browse', title: 'ブラウザで ALB にアクセス → **200 / Database: connected**', hint: '「ブラウザ」タブで `web-alb` の DNS 名を開き直します。まだ `connect ETIMEDOUT` が出るなら、`db-sg` のインバウンドルールのソースを見直します。', done: (c) => !!lastAlbRequest(c)?.body.includes('Database: connected') }],
      validate: (c) =>
        lastAlbRequest(c)?.body.includes('Database: connected')
          ? ok(
              node('つながりました！ `Database: connected` です！'),
              hakase('ログで当たりを付け、ブラウザの 500 で区間を絞り、RDS から Security Group を辿って直す。見事な切り分けだ。'),
              node('博士、僕そろそろ給料上がりますかね？'),
              hakase('上がるとも。DB のルールを書き換えた誰かの減給分が回ってくればな。'),
            )
          : ng(hakase('まだ Database: connected が出ていない。もう一度ブラウザで ALB を開き直して、ページの本文を見るのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。`db-sg` の ソースに web-1 の Private IP を `10.0.11.x/32` と書く方法もある。`/32` は「このアドレス 1 個だけ」という意味だ。これはなぜおすすめできない？'),
      options: ['IP では接続できないから', 'EC2 の入れ替えや台数増加のたびにルール変更が必要になるから', 'Private IP は毎日変わるから'],
      answer: 1,
      explanation: [
        hakase('正解。`/32` は 32 ビット全部が固定、つまり 1 台分だ。EC2 を入れ替えたり増やしたりするたびに、ルールを書き直す羽目になる。'),
        hakase('Security Group をソースにすれば、「web-sg が付いた EC2 なら何台でも」許可される。'),
        node('書き直し忘れた日が、次の障害の日ですね。'),
      ],
    },
  ],
};

export const lesson19: Lesson = {
  id: 'mvp-final',
  number: '19',
  title: '総合演習: Internet → ALB → EC2 → RDS',
  summary: 'Blocked な 2 区間を自分で直し、ALL CONNECTED にする',
  minutes: 25,
  startPath: '/console/home',
  scenario: () =>
    webAppEnv({}, (env) => {
      setSecurityGroupRules(env, sgId(env, 'web-sg'), 'ingress', []);
      setSecurityGroupRules(env, sgId(env, 'db-sg'), 'ingress', []);
    }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        hakase('最終課題だ。構成は Internet → ALB → EC2 → RDS。だが今、**ALB → EC2** と **EC2 → RDS** が Blocked になっておる。'),
        node('ぶろっくど？'),
        hakase('「塞がれている」だ。構成図では、通信が通らない区間をそう表示する。通れば Connected、全区間が通れば ALL CONNECTED だ。'),
        node('今度は誰がやったんですか。'),
        hakase('ワシだ。`web-sg` と `db-sg` のインバウンドルールを、きれいさっぱり消しておいた。'),
        node('博士が犯人！？ 障害報告書、博士の名前で書いていいですか？'),
        hakase('書くのは君だ。直すのも君だ。ワシはここで茶をすすりながら見ておる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ヒントは少なめ、ですよね…'),
        hakase('うむ。だが材料は全部習った。ALB → EC2 は何番ポートで、ソースは何だったかな？'),
        node('アプリのポート 3000 で、ソースは ALB の Security Group の ID。ID はコピーして貼る。Lesson 16 でやりました。'),
        hakase('では EC2 → RDS は？'),
        node('MySQL の 3306 で、ソースは EC2 の Security Group の ID。Lesson 18 の、転送届を出し忘れたやつです。'),
        hakase('よろしい。次の構成図は、今の環境をそのまま映した **Live** の図だ。パネルの「構成図」タブでもいつでも見られる。どこが塞がっているか眺めてから、Management Console で直すのだ。'),
        node('全部つながったら、僕の給料も上がりますか？'),
        hakase('考えておこう。考えるだけだがな。'),
      ],
    },
    { type: 'diagram', title: '初期状態 (Live)', diagram: 'live' },
    {
      type: 'exercise',
      title: 'ALB → EC2 をつなぐ',
      objective: 'ALB の Security Group を確認して ID をコピーし、EC2 の Security Group の インバウンドルール を修正して ALB → EC2 を Connected にする',
      tasks: [
        { id: 'copy', title: 'ALB のセキュリティグループを確認し、ID を **コピー**', hint: 'web-alb のセキュリティタブ。', done: (c) => copied(c, sgNamed(c.env, 'alb-sg')?.groupId) },
        { id: 'fix', title: 'EC2 のセキュリティグループにインバウンドルールを追加', hint: 'アプリのポートはターゲットグループの登録ポートを見れば分かります。', done: (c) => albReachesWeb(c.env) },
      ],
      validate: (c) => {
        if (!albReachesWeb(c.env)) return ng(hakase('ALB → EC2 はまだ Blocked だ。ポートはターゲットグループの登録ポート、ソースは `alb-sg` の ID だったな。「構成図」タブで線の色も見てみるのだ。'));
        if (sgAllows(c.env, 'web-sg', 3000, { ip: '192.0.2.10' })) return ng(hakase('つながったが、EC2 が全世界に開いているぞ。最終課題で始末書を書く気か。ソースを ALB の Security Group の ID にしよう。'));
        return ok(
          hakase('**ALB → EC2 Connected**。'),
          node('ここまでは Lesson 16 の復習ですね。コピーして、貼って、保存。'),
          hakase('油断するでない。次は DB だ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'EC2 → RDS をつなぐ',
      objective: 'RDS の Security Group を確認し、EC2 の Security Group を ソースにして EC2 → RDS を Connected にする',
      tasks: [
        { id: 'find', title: 'RDS の Security Group を確認', hint: 'RDS > webapp-db > 接続とセキュリティ。', done: (c) => visitedId(c, '/security-groups/', sgNamed(c.env, 'db-sg')?.groupId) },
        { id: 'fix', title: 'EC2 の SG を ソースにして MySQL (3306) を許可', hint: 'EC2 の SG の ID は `web-1` の「セキュリティ」タブでコピーできます。`db-sg` の **インバウンドのルールを編集** でタイプに `MYSQL/Aurora` を選ぶと、ポート 3306 が自動で入ります。', done: (c) => webReachesDb(c.env) },
      ],
      validate: (c) => {
        if (!webReachesDb(c.env)) return ng(hakase('EC2 → RDS はまだ Blocked だ。`db-sg` のインバウンドルールに、MySQL (3306) をソース `web-sg` の ID で追加したかな？'));
        if (sgAllows(c.env, 'db-sg', 3306, { ip: '192.0.2.10' })) return ng(hakase('DB が全世界に開いておる！ 最終課題で情報漏えいとは、ある意味伝説だ。ソースは EC2 の Security Group (`web-sg`) の ID にするのだ。'));
        return ok(
          hakase('**EC2 → RDS Connected**。'),
          node('構成図の線、全部緑になってるかな…'),
          hakase('自分の目で確かめるがよい。次の図だ。'),
        );
      },
    },
    { type: 'diagram', title: '最終状態 (Live)', diagram: 'live' },
    {
      type: 'exercise',
      title: 'ALL CONNECTED',
      objective: 'ブラウザで ALB にアクセスし、Internet → ALB → EC2 → RDS がすべてつながったことを確認する',
      tasks: [{ id: 'browse', title: 'ブラウザで ALB にアクセス → **Database: connected**', hint: 'ロードバランサー一覧の `web-alb` の DNS 名を「ブラウザ」タブで開きます。表示されないときは、パネルの「構成図」タブで Blocked の区間が残っていないか確認します。', done: (c) => !!lastAlbRequest(c)?.body.includes('Database: connected') }],
      validate: (c) =>
        lastAlbRequest(c)?.body.includes('Database: connected') && allTargetsHealthy(c.env, 'web-tg', 2)
          ? ok(
              hakase('**Internet → ALB → EC2 → RDS  ALL CONNECTED**。'),
              node('やった！ 自分の手で直せました！'),
              hakase('見事だ。実際の AWS でも、やることは同じだ。症状を確かめ、外側から 1 区間ずつ調べ、ID は Copy & Paste で正確に。これを忘れるでないぞ。'),
              node('博士、約束の給料の件は…'),
              hakase('考えた。結論は「来期に検討」だ。'),
            )
          : ng(hakase('まだどこかがつながっていないようだ。`web-tg` のターゲットが両方 healthy になっているか確かめてから、ブラウザで ALB を開き、`Database: connected` が出るか見るのだ。')),
    },
  ],
};


