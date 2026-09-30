import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { liveInstances, policyMetric } from '../sim/autoscaling';
import { asgEnv, scaledEnv } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { lastRequestTo, lbNamed, subnetNamed, visited, visitedId } from './helpers';

const ASG = 'webapp-asg';
const asgOf = (env: AwsEnv) => env.autoScalingGroups.find((g) => g.autoScalingGroupName === ASG);
const inService = (env: AwsEnv) => asgOf(env)?.instances.filter((r) => r.lifecycleState === 'InService').length ?? 0;
const albStatus = (c: TaskContext) => lastRequestTo(c, lbNamed(c.env, 'web-alb')?.dnsName)?.status;
const load = (env: AwsEnv) => env.traffic?.[env.traffic.length - 1]?.rps;
const cpuNow = (env: AwsEnv) => {
  const g = asgOf(env);
  const p = g?.policies[0];
  return g && p ? policyMetric(env, g, { ...p, metric: 'ASGAverageCPUUtilization' }, Date.now()) : undefined;
};

export const lesson30: Lesson = {
  id: 'asg-basics',
  number: '30',
  title: 'Auto Scaling グループで台数を保つ',
  summary: '起動テンプレートから決めた台数を起動し、壊れたインスタンスを自動で入れ替える',
  minutes: 25,
  startPath: '/ec2/launch-templates',
  scenario: asgEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、web-1 と web-2 を昨日片付けたので、ターゲットグループが空っぽです。また 2 台を手で作り直すんですか？'),
        hakase('片付けたのは君か。'),
        node('違います、指示どおりです！ 今日は新しい仕組みで立て直すって聞きました。'),
        hakase('うむ。手で作ると、壊れたときも手で直すことになる。夜中の 3 時にな。'),
        node('3 時は嫌です。寝てたいです。'),
        hakase('そこで **Auto Scaling グループ** だ。EC2 を何台保つか決めておけば、足りなければ起動し、壊れたら入れ替えてくれる。'),
        node('おーとすけーりんぐ… scaling は「規模を変える」ですよね。'),
        hakase('そうだ。負荷に合わせて台数を増減するのが本業だが、今日はまず「決めた台数を保つ」ほうをやる。増減は次の Lesson 31 だ。'),
        node('グループっていうのは？'),
        hakase('同じ役割の EC2 をひとまとめにして面倒を見る単位だ。羊の群れと、それを数える牧羊犬を想像すればよい。1 匹いなくなれば、牧羊犬が新しい羊を連れてくる。'),
        node('連れてくるって、その羊はどこから来るんですか。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('良い質問だ。**起動テンプレート** から来る。何を起動するかを書いた設計図だ。'),
        node('設計図… 何が書いてあるんです？'),
        hakase('Lesson 10 で EC2 を起動したとき、画面で何を決めたか覚えておるか。'),
        node('AMI、インスタンスタイプ、キーペア、ネットワーク設定、セキュリティグループでしたよね。'),
        hakase('うむ。AMI は OS やソフトが入ったディスクの型、インスタンスタイプは CPU とメモリの大きさだった。あれを毎回選ぶ代わりに、テンプレートに保存しておくのだ。'),
        node('毎回同じ注文を書かなくていい、定食屋の「いつもの」みたいなものですね。'),
        hakase('そして大事なのが **ユーザーデータ** だ。インスタンスが最初に起動したとき、自動で実行されるスクリプトのことだ。'),
        node('ゆーざーでーた？ ユーザーの個人情報じゃないんですか。'),
        hakase('紛らわしい名前だが違う。今回の `webapp-lt` なら、ユーザーデータに「アプリをインストールして、ポート 3000 で起動する」手順が書いてある。'),
        node('じゃあ、起動しただけでアプリが動いてる羊が届くってことですね。'),
        hakase('羊ではなく EC2 だ。……まあ、そういうことだ。'),
      ],
    },
    {
      type: 'table',
      title: 'Auto Scaling の用語',
      columns: ['用語', '意味'],
      rows: [
        ['起動テンプレート', 'AMI・インスタンスタイプ・セキュリティグループ・ユーザーデータなど、起動する中身の設計図'],
        ['希望するキャパシティ', '今あるべき台数。Auto Scaling はこの台数に合わせて起動・終了する'],
        ['最小 / 最大', '希望するキャパシティが動ける範囲。スケーリングでも最小未満・最大超にはならない'],
        ['ヘルスチェック', 'EC2 のステータス (標準) に加え、ELB のヘルスチェックで異常なものも入れ替えられる'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('表の「キャパシティ」って、容量ですよね。'),
        hakase('ここでは**台数**のことだ。**希望するキャパシティ** は「今あるべき台数」。Auto Scaling はいつもこの数に合わせようとする。'),
        node('最小と最大は？'),
        hakase('希望するキャパシティが動いてよい範囲だ。今日は 希望 2 / 最小 2 / 最大 6 にする。'),
        node('なんで最小が 2 なんですか。1 台なら半額なのに。'),
        hakase('1 台だと、その 1 台が壊れた瞬間にサイトが止まる。2 台を別々の AZ に置けば、片方の AZ が止まっても残る。半額で浮いたお金は、お詫びの菓子折りで消えるぞ。'),
        node('「ヘルスチェック」は Lesson 13 でやった、ALB がターゲットに `/health` で生きてるか聞くやつですよね。'),
        hakase('そうだ。ただし Auto Scaling は、標準では **EC2 のステータス** (インスタンスそのものが動いているか) しか見ない。**ELB のヘルスチェック** をオンにすると、ALB が unhealthy と判定したものも入れ替える。'),
        node('いーえるびー？'),
        hakase('Elastic Load Balancing。ALB を含むロードバランサーの総称だ。起動直後はアプリが準備中だから、判定を待ってやる**猶予期間**も設定できる。'),
        node('入ったばかりの新人に、いきなり「使えない」って言わないであげるんですね。優しい。'),
        hakase('ワシは君に猶予期間を与えた覚えはないがな。'),
      ],
    },
    {
      type: 'exercise',
      title: '起動テンプレートを確かめる',
      objective: '起動テンプレート `webapp-lt` を開き、ユーザーデータで何が起動されるか確認する',
      tasks: [{ id: 'lt', title: 'EC2 > 起動テンプレート → `webapp-lt` の ID をクリック', hint: '起動テンプレートは EC2 の左メニュー「インスタンス」セクションにあります。詳細画面の一番下に **ユーザーデータ** が表示されます。', done: (c) => visitedId(c, '/ec2/launch-templates/', c.env.launchTemplates[0]?.launchTemplateId) }],
      validate: (c) =>
        visitedId(c, '/ec2/launch-templates/', c.env.launchTemplates[0]?.launchTemplateId)
          ? ok(
              node('ユーザーデータに `dnf install -y webapp` と `systemctl enable --now webapp` … `webapp` を入れて、ポート 3000 で起動しています。'),
              hakase('`dnf` はソフトを取り寄せて入れる係、`systemctl` はサービスを起動して、再起動のあとも自動で動くようにする係だ。だから、このテンプレートから起動した EC2 は、起動するだけでアプリが動く。セキュリティグループも web-sg だ。'),
              node('web-sg は、Lesson 15 で ALB からの 3000 番を許可してたやつですね。'),
              hakase('うむ。テンプレートには**バージョン**もあって、書き換えるたびに番号が増える。今日は Default (既定) のバージョンのままでよい。'),
            )
          : ng(hakase('webapp-lt を開くのだ。EC2 > 起動テンプレート の一覧で、`webapp-lt` の起動テンプレート ID (`lt-…`) をクリックする。')),
    },
    {
      type: 'exercise',
      title: '今の状態を見る',
      objective: 'ブラウザで `web-alb` の DNS 名を開き、ターゲットがないときの応答を確認する',
      tasks: [{ id: 'browse', title: 'ロードバランサー一覧で DNS 名をコピー → 「ブラウザ」タブで開く', hint: '**DNS 名** 列のコピーアイコンでコピーし、レッスンパネルの **ブラウザ** タブの URL 欄に貼り付けて **移動** を押します。', done: (c) => albStatus(c) !== undefined }],
      validate: (c) =>
        albStatus(c) === 503
          ? ok(
              node('503 Service Temporarily Unavailable です。'),
              hakase('Lesson 12 でも見たな。ターゲットグループに誰もいないときの応答だ。'),
              node('お店は開いてるのに、店員が一人もいない状態ですね。'),
              hakase('そういうことだ。Auto Scaling グループを web-tg に**アタッチ** (Lesson 08 で IGW を VPC にくっつけたのと同じ言葉だ) しておけば、起動した EC2 が自動でターゲットに登録される。'),
            )
          : ng(hakase('ブラウザで web-alb を開いて、応答を確かめるのだ。EC2 > ロードバランサー で `web-alb` の DNS 名をコピーし、「ブラウザ」タブに貼り付ける。')),
    },
    {
      type: 'exercise',
      title: 'Auto Scaling グループを作成する',
      objective: '`webapp-lt` から `webapp-asg` を作成する: サブネットは private-subnet-1a / 1c、ターゲットグループ `web-tg` にアタッチ、ELB ヘルスチェックをオン、希望 2 / 最小 2 / 最大 6',
      tasks: [
        { id: 'open', title: 'EC2 > Auto Scaling グループ → **Auto Scaling グループを作成する**', hint: 'EC2 の左メニュー「Auto Scaling」セクションにあります。ステップ 1 で名前 `webapp-asg` と起動テンプレート `webapp-lt` を指定します。', hotspotId: 'asg-create', done: (c) => visited(c, '/ec2/autoscaling/create') },
        { id: 'create', title: 'ウィザードを進めて **Auto Scaling グループを作成**', hint: 'ステップ 3 で「既存のロードバランサーにアタッチする」→ web-tg、ステップ 4 でグループサイズを入力します。', done: (c) => !!asgOf(c.env) },
      ],
      validate: (c) => {
        const g = asgOf(c.env);
        if (!g) return ng(hakase('webapp-asg が見当たらん。EC2 > Auto Scaling グループ → **Auto Scaling グループを作成する** で、名前を `webapp-asg`、起動テンプレートを `webapp-lt` にするのだ。'));
        const priv = ['private-subnet-1a', 'private-subnet-1c'].map((n) => subnetNamed(c.env, n)?.subnetId);
        if (!priv.every((s) => s && g.subnetIds.includes(s)) || g.subnetIds.length !== 2) return ng(hakase('サブネットは private-subnet-1a と 1c の 2 つだ。作成時ならステップ 2 の「アベイラビリティーゾーンとサブネット」、作った後ならグループの詳細の **編集** の「ネットワーク」で直せる。2 つの AZ に分けておけば、片方の AZ が止まっても残る。'));
        if (!g.targetGroupArns.includes(c.env.targetGroups[0]?.targetGroupArn)) return ng(hakase('web-tg にアタッチされていない。これでは ALB から届かんぞ。作成時ならステップ 3 の「既存のロードバランサーにアタッチする」、作った後なら **編集** の「ロードバランシング」で web-tg を選ぶのだ。'));
        if (g.healthCheckType !== 'ELB') return ng(hakase('ELB のヘルスチェックがオフだ。アプリが止まっても、EC2 自体が動いていれば入れ替わらんぞ。**編集** の「ヘルスチェック」(作成時ならステップ 3) で「Elastic Load Balancing のヘルスチェックをオンにする」にチェックを入れるのだ。'));
        if (g.minSize !== 2 || g.desiredCapacity !== 2 || g.maxSize !== 6) return ng(hakase('台数は 希望 2 / 最小 2 / 最大 6 だ。グループの詳細の「編集」で直せるぞ。'));
        return ok(
          hakase('よし。アクティビティを見てみろ、もう 2 台起動し始めておる。'),
          node('あくてぃびてぃ？'),
          hakase('Auto Scaling が「いつ・何を・なぜ」したかの作業日誌だ。**インスタンス管理** タブでは 1 台ずつの状態が見える。起動中は **Pending**、起動が終わると **InService** (稼働中) になり、ターゲットグループにも登録される。'),
          node('ペンディングは「保留中」、インサービスは「営業中」ってことですね。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'サイトが戻ったことを確かめる',
      objective: '2 台が InService になったら、ブラウザで `web-alb` を開いて 200 を確認する',
      tasks: [
        { id: 'inservice', title: 'インスタンス管理タブで 2 台が InService', hint: '`webapp-asg` の **インスタンス管理** タブの **ライフサイクル** 列が Pending から InService に変わるまで少し待ちます。', done: (c) => inService(c.env) >= 2 },
        { id: 'browse', title: 'ブラウザで web-alb → **200**', hint: '2 台が InService になってから、**ブラウザ** タブで同じ DNS 名をもう一度 **移動** します。', done: (c) => albStatus(c) === 200 },
      ],
      validate: (c) =>
        inService(c.env) >= 2 && albStatus(c) === 200
          ? ok(
              node('200 OK！ 2 台が、それぞれ違う AZ で動いてます。'),
              hakase('Auto Scaling は、選んだサブネットの AZ に均等に配置する。ターゲットグループへの登録も自動だ。'),
              node('僕、ターゲットを 1 台も手で登録してないのに復旧しました。'),
              hakase('では意地悪をしよう。次は 1 台を**終了**する。Lesson 10 の「停止」と違って、終了はインスタンスを削除することだ。二度と起動できん。'),
            )
          : ng(hakase('2 台が InService になってから、もう一度ブラウザで確かめるのだ。`webapp-asg` の **インスタンス管理** タブで、2 台とも InService か見てみろ。')),
    },
    {
      type: 'exercise',
      title: '1 台壊してみる',
      objective: '`webapp-asg` のインスタンスを 1 台、EC2 コンソールから **終了** し、Auto Scaling が新しいインスタンスで置き換えることを確認する',
      tasks: [
        { id: 'kill', title: 'EC2 > インスタンス → `webapp-asg` の 1 台を選択 → インスタンスの状態 → **インスタンスを終了**', hint: 'Auto Scaling が起動したインスタンスは名前が `webapp-asg` です。チェックは 1 台だけに入れ、**インスタンスを終了 (削除)** を選びます。', done: (c) => !!asgOf(c.env)?.activities.some((a) => a.cause.includes('EC2 health check')) },
        { id: 'back', title: 'アクティビティ履歴を見て、台数が 2 台 (InService) に戻るのを待つ', hint: '`webapp-asg` の **アクティビティ** タブで **説明** と **原因** 列を読みます。新しい 1 台は **インスタンス管理** タブで InService になるまで待ちます。', done: (c) => !!asgOf(c.env)?.activities.some((a) => a.cause.includes('EC2 health check')) && inService(c.env) >= 2 },
      ],
      validate: (c) => {
        const g = asgOf(c.env);
        if (!g?.activities.some((a) => a.cause.includes('EC2 health check'))) return ng(hakase('まだインスタンスを終了していないようだ。EC2 > インスタンス で webapp-asg の 1 台を選び、**インスタンスの状態** → **インスタンスを終了** だ。'));
        if (inService(c.env) < 2 || liveInstances(g).length !== 2) return ng(hakase('入れ替えの途中だ。**アクティビティ** タブに新しいインスタンスの起動が記録され、それが InService になるまで少し待つのだ。'));
        return ok(
          node('終了した直後に「Launching a new EC2 instance」… 勝手に 1 台増えて 2 台に戻りました！'),
          hakase('これが**自己修復**だ。希望するキャパシティ 2 を保とうとしておる。夜中に 1 台壊れても、朝には元どおりだ。'),
          node('これで夜中の 3 時に起こされずに済みますね。'),
          hakase('台数の心配はな。Auto Scaling に直せんものは、相変わらず君の電話が鳴る。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。最小 2 / 希望 3 / 最大 6 のグループで、手で 1 台終了した。どうなる？'),
      options: ['2 台のまま (最小を満たしているので)', '新しい 1 台が起動して 3 台に戻る', '6 台まで増える'],
      answer: 1,
      explanation: [
        hakase('正解。保とうとするのは「希望するキャパシティ」だ。最小と最大は、スケーリングで希望する台数が動ける範囲にすぎん。'),
        node('牧羊犬が数えてるのは「希望」の数、ですね。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('アプリのプロセスだけが落ちて、EC2 自体は動いている。入れ替えてもらうにはどうする？'),
      options: ['何もしなくても入れ替わる', 'Auto Scaling で ELB のヘルスチェックをオンにしておく', '最大キャパシティを増やす'],
      answer: 1,
      explanation: [
        hakase('正解。EC2 のステータスチェックは「インスタンスが動いているか」しか見ない。ELB のヘルスチェック (`/health`) なら、アプリが応答しないことに気づける。'),
        node('体は出社してるけど、心ここにあらず、みたいな状態ですね。'),
        hakase('君のことか。'),
      ],
    },
  ],
};

export const lesson31: Lesson = {
  id: 'asg-target-tracking',
  number: '31',
  title: 'ターゲット追跡スケーリングと負荷テスト',
  summary: '平均 CPU 50% を目標に、負荷に合わせて台数を自動で増減させる',
  minutes: 25,
  startPath: '/ec2/autoscaling',
  scenario: scaledEnv,
  loadTest: true,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士！ 来週テレビで紹介されるので、アクセスが 10 倍くらいになるかもしれません。今のうちに 10 台に増やしておきますか？'),
        hakase('テレビか。紹介された翌朝、サーバーが全滅していた会社をワシは何社も見てきた。'),
        node('縁起でもない！ だから 10 台にしておこうって言ってるんです。'),
        hakase('では放送が終わったあとも、ずっと 10 台か？'),
        node('えっと… 放送が終わったら戻します。たぶん。'),
        hakase('その「たぶん」を忘れて、翌月の請求書で青ざめるのが人間というものだ。普段 2 台で足りるなら、8 台ぶんのお金を毎日捨てることになる。'),
        node('僕の給料より高そうですね、それ。'),
        hakase('間違いなく高い。そこで **ターゲット追跡スケーリング** を使う。'),
        node('たーげっとついせき？ 何を追いかけるんです？'),
        hakase('**目標値**だ。たとえば「グループ全体の平均 CPU 使用率を 50% に保て」と決めておく。超えたら台数を増やし、下回ったら減らしてくれる。'),
        node('エアコンの温度設定みたいですね。28 度にしておけば、勝手に強くしたり弱くしたりする。'),
        hakase('まさにそれだ。君にしては上出来のたとえだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('台数を増やすのと減らすのに、名前はあるんですか？'),
        hakase('増やすのが **スケールアウト**、減らすのが **スケールイン** だ。1 台を大きくするのは**スケールアップ**といって、別物だ。'),
        node('Lesson 25 で DB のインスタンスクラスを上げたのは、スケールアップのほうですね。'),
        hakase('そうだ。あれは 1 台を太らせた。今日は頭数を増やす。'),
        node('何台に増やすかは、どうやって決めるんです？'),
        hakase('おおよそ「今の台数 × 今の CPU ÷ 目標」だ。2 台で CPU 100% なら、2 × 100 ÷ 50 = 4 台。'),
        node('仕事の量が同じなら、人数を倍にすれば一人あたりは半分になる、と。'),
        hakase('うむ。そして「超えた」「下回った」の判定には、Lesson 24 でやった **CloudWatch アラーム** を使う。ターゲット追跡は、そのアラームを自動で作ってくれる。'),
        node('自分でアラームを作らなくていいんですね。楽だ。'),
        hakase('画面では **動的スケーリングポリシー** として作る。負荷に合わせて動的に台数を変える決まり、という意味だ。メトリクスタイプは「平均 CPU 使用率」、ターゲット値は 50 にする。'),
        node('ポリシーには、ほかの種類もあるんですか？'),
        hakase('「CPU が 70% を超えたら 2 台足す」のように段階を自分で決める、**ステップスケーリング** がある。まずは計算を任せられるターゲット追跡から覚えればよい。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('動きを確かめるのは、レッスンパネルの「**負荷テスト**」タブだ。シミュレーターの負荷発生ツールで、お客さんの代わりにアクセスを送り込む。'),
        node('本番でテレビ放送を再現するわけにはいかないですもんね。'),
        hakase('単位は **req/s**。1 秒あたりのリクエスト数だ。100 req/s なら、毎秒 100 回ページを開かれる。'),
        node('1000 req/s なら 10 倍、テレビの日ですね。'),
        hakase('そうだ。それと、Lesson 30 の起動テンプレート `webapp-lt` では、詳細モニタリングがオンになっておった。CPU の数字が 1 分ごとに届くから、判断が速い。'),
        node('Lesson 24 でやったメトリクスの「期間」が短い、ってことですね。'),
        hakase('うむ。では `webapp-asg` にポリシーを付けるところからだ。テレビに映る前に、君の手順書が炎上せんとよいがな。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ターゲット追跡ポリシーを作る',
      objective: '`webapp-asg` に、平均 CPU 使用率を **50** に保つターゲット追跡スケーリングポリシー `cpu50` を作成する',
      tasks: [{ id: 'policy', title: '`webapp-asg` → **自動スケーリング** タブ → **動的スケーリングポリシーを作成**', hint: 'メトリクスタイプ「平均 CPU 使用率」、ターゲット値 50。', hotspotId: 'asg-create-policy', done: (c) => !!asgOf(c.env)?.policies.length }],
      validate: (c) => {
        const p = asgOf(c.env)?.policies[0];
        if (!p) return ng(hakase('まだポリシーがない。`webapp-asg` の **自動スケーリング** タブで、**動的スケーリングポリシーを作成** を押すのだ。'));
        if (p.metric !== 'ASGAverageCPUUtilization' || p.targetValue !== 50) return ng(hakase('「平均 CPU 使用率」を 50 に保つポリシーにするのだ。ポリシータイプは「ターゲット追跡スケーリング」、メトリクスタイプ「平均 CPU 使用率」、ターゲット値 50 だ。'));
        return ok(
          hakase('準備完了だ。まずは普段どおりの負荷から試そう。'),
          node('エアコンの設定温度を 50 度にした、ってことですね。'),
          hakase('部屋が 50 度なら、君は今ごろ干物だ。CPU の話だぞ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '100 req/s をかける',
      objective: '「負荷テスト」タブで **100 req/s** を選び、台数と CPU を観察する',
      tasks: [{ id: 'load', title: '負荷テスト → **100 req/s**', hint: 'グラフは 5 秒ごとに更新されます。', done: (c) => load(c.env) === 100 }],
      validate: (c) =>
        load(c.env) === 100 && inService(c.env) === 2
          ? ok(
              node(`2 台のままで、CPU は ${Math.round(cpuNow(c.env) ?? 0)}% くらいです。`),
              hakase('目標の 50% より十分低いから、増やす必要はない。かといって最小が 2 だから、これ以上は減らん。'),
              node('暇な時間でも、お店には最低 2 人いる、みたいな感じですね。'),
            )
          : ng(hakase('負荷テストで 100 req/s を選ぶのだ。レッスンパネルの「負荷テスト」タブにボタンがある。')),
    },
    {
      type: 'exercise',
      title: '10 倍の負荷をかける',
      objective: '**1000 req/s** に上げ、CPU が上がって台数が増え、CPU が目標付近に下がるまで観察する',
      tasks: [
        { id: 'load', title: '負荷テスト → **1000 req/s**', hint: '**リクエスト/秒** の切り替えで選びます。すぐ下の **InService** と **平均 CPU** の数値・グラフで変化を追えます。', done: (c) => load(c.env) === 1000 },
        { id: 'out', title: 'InService が 4 台になり、平均 CPU が 50% 以下に戻る', hint: '20 秒ほど CPU が目標を超え続けるとスケールアウトします。', done: (c) => load(c.env) === 1000 && inService(c.env) >= 4 && (cpuNow(c.env) ?? 100) < 55 },
      ],
      validate: (c) => {
        if (load(c.env) !== 1000) return ng(hakase('1000 req/s にするのだ。「負荷テスト」タブで **1000 req/s** を選ぶ。'));
        if (inService(c.env) < 4) return ng(hakase('まだ台数が増えきっていない。CPU が 20 秒ほど目標を超え続けると、スケールアウトが始まる。グラフを見ながら待つのだ。'));
        return ok(
          node(`CPU が 80% を超えて、4 台に増えたら ${Math.round(cpuNow(c.env) ?? 0)}% まで下がりました！`),
          hakase('たとえば 2 台で 82% なら、2 × 82 ÷ 50 ≒ 3.3、切り上げて 4 台だ。「今の台数 × 今の CPU ÷ 目標」で必要な台数を計算して、一気に増やしたのだ。'),
          node('1 台ずつじゃなくて、必要な数をまとめて足すんですね。'),
          hakase('そうだ。テレビの前のお客さんは、1 台ずつ増えるのを待ってはくれん。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'アクティビティ履歴を読む',
      objective: '`webapp-asg` の **アクティビティ** タブで、希望するキャパシティが変わった理由を確認する',
      tasks: [{ id: 'activity', title: '`webapp-asg` → **アクティビティ** タブ', hint: 'EC2 > Auto Scaling グループ の一覧で名前のリンクから開きます。キャパシティが変わった理由は **原因** 列に書かれています。', done: (c) => visited(c, /\/ec2\/autoscaling\/webapp-asg\?tab=activity/) }],
      validate: (c) =>
        visited(c, /\/ec2\/autoscaling\/webapp-asg\?tab=activity/)
          ? ok(
              node('「TargetTracking-webapp-asg-AlarmHigh … triggered policy cpu50 changing the desired capacity from 2 to 4」とあります。'),
              hakase('ターゲット追跡が自動で作った CloudWatch アラームだ。目標を上回ったら鳴る **AlarmHigh** と、下回ったら鳴る **AlarmLow**。これをきっかけに、希望するキャパシティを変えるのだ。'),
              node('「なぜ 4 台になったのか」が、ちゃんと作業日誌に残ってるんですね。'),
              hakase('何がいつ起きたかは、いつでもここで追える。請求書を見た上司に「なぜ増えた」と詰められたときにもな。'),
            )
          : ng(hakase('アクティビティタブを開くのだ。Auto Scaling グループの一覧で `webapp-asg` を開き、**アクティビティ** タブを選ぶ。')),
    },
    {
      type: 'exercise',
      title: '負荷が引いたら',
      objective: '負荷テストを **100 req/s** に戻し、台数が最小の 2 台まで減るのを確認する',
      tasks: [
        { id: 'load', title: '負荷テスト → **100 req/s**', hint: '「通常」ではなく **100 req/s** を選びます。', done: (c) => load(c.env) === 100 },
        { id: 'in', title: '希望するキャパシティが 2 に戻り、2 台になる', hint: 'スケールインは慎重に行われます (約 1 分)。', done: (c) => load(c.env) === 100 && asgOf(c.env)?.desiredCapacity === 2 && liveInstances(asgOf(c.env)!).length === 2 },
      ],
      validate: (c) =>
        load(c.env) === 100 && asgOf(c.env)?.desiredCapacity === 2 && liveInstances(asgOf(c.env)!).length === 2
          ? ok(
              hakase('スケールアウトは素早く、スケールインはゆっくり。増やし遅れるとお客様が困るが、減らし遅れても少しお金がかかるだけだからだ。'),
              node('放送が終わったら、ちゃんと 2 台に戻りました。「たぶん」戻し忘れる僕の代わりに、戻してくれるんですね。'),
              hakase('そうだ。そして最小の 2 台より減ることはない。君の「たぶん」より、よほど信用できる。'),
            )
          : ng(hakase('100 req/s に戻して、台数が減るのを待つのだ。スケールインは慎重だから、1 分ほどかかる。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。ターゲット追跡 (平均 CPU 50%) のグループが 3 台で平均 CPU 90%。最大 10 台なら、何台にしようとするかな？'),
      options: ['4 台', '6 台', '10 台'],
      answer: 1,
      explanation: [
        hakase('正解。3 台 × 90% ÷ 50% = 5.4 → 切り上げて 6 台だ。'),
        node('5.4 台だと、0.4 台ぶんの EC2 が要りますもんね。'),
        hakase('0.4 台のサーバーは、ワシも見たことがない。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では「最大キャパシティ」を決めておく一番の理由はどれかな？'),
      options: ['起動を速くするため', '想定外の負荷や攻撃で台数とコストが増え続けないようにするため', 'ヘルスチェックのため'],
      answer: 1,
      explanation: [
        hakase('正解。上限がないと、攻撃やバグによる無限ループでも台数が増え続ける。'),
        node('朝起きたら 500 台、請求書は……'),
        hakase('君の年収では払えん額だろうな。最小は可用性 (2 つの AZ に 1 台ずつ)、最大はコストの安全装置だ。'),
      ],
    },
  ],
};
