import { hakase, ng, node, ok, type Lesson } from '../lesson/types';
import { modifyTargetGroupHealthCheck } from '../sim/elb';
import { byName } from '../sim/env';
import { CLIENT_IP } from '../sim/network';
import { createDbSubnetGroup } from '../sim/rds';
import { webAppEnv } from '../sim/scenarios';
import { createSecurityGroup } from '../sim/sg';
import { isPublicSubnet } from '../sim/vpc';
import { allTargetsHealthy, copied, dbNamed, instanceNamed, lastAlbRequest, lbNamed, sgNamed, subnetNamed, tgNamed, visited, visitedId, vpcNamed } from './helpers';

const webServerSgScenario = () =>
  webAppEnv({ upTo: 'security-groups' }, (env) => {
    createSecurityGroup(env, {
      groupName: 'web-server-sg',
      name: 'web-server-sg',
      description: 'HTTP from anywhere, SSH from my PC',
      vpcId: byName(env.vpcs, 'webapp-vpc')!.vpcId,
      ingress: [
        { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0', description: 'HTTP' },
        { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: `${CLIENT_IP}/32`, description: 'SSH from my PC' },
      ],
    });
  });

export const lesson10: Lesson = {
  id: 'ec2',
  number: '10',
  title: 'EC2',
  summary: '仮想サーバーを起動し、状態と所属 (VPC / Subnet / SG) を辿る',
  minutes: 30,
  startPath: '/ec2/home',
  scenario: webServerSgScenario,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士！ 今日はついにサーバーを立てるんですよね。Lesson 03 から VPC だの Subnet だの、ずっと土地の造成ばっかりでしたもん。'),
        hakase('造成とは言い得て妙だな。区画を切り (Subnet)、道路を引き (Route table)、門を付け (Internet gateway)、門番を置いた (Security Group)。今日はいよいよ、そこに家を建てる。'),
        node('家、つまりサーバーですね！ どこの家電量販店で買うんですか？'),
        hakase('買わん。**EC2** を使う。Elastic Compute Cloud の略で、AWS の **仮想サーバー** だ。'),
        node('かそうさーばー？ 仮装…コスプレしたサーバーですか？'),
        hakase('衣装の話ではない。データセンターの大きな物理サーバー 1 台を、ソフトウェアで何台分にも切り分けて、それぞれを独立したサーバーに見せかけておるのだ。'),
        node('1 軒の大きな家を壁で仕切って、アパートにする感じですか。'),
        hakase('うむ。その切り分けた 1 部屋、つまり 1 台の仮想サーバーを **インスタンス** と呼ぶ。Elastic は「伸縮自在」。要るときに増やし、要らなくなったら消せる。'),
        node('Lesson 01 の表にあった「サーバー調達」の話ですね。オンプレミスだと、届くまで何週間もかかるって。'),
        hakase('見積もりを取り、稟議を回し、3 週間待って、深夜のデータセンターでケーブルを挿した。今はボタン 1 つで数十秒だ。……ワシの青春の 3 週間を返してほしいものだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('「インスタンスを起動」の画面で決めることは多いが、1 つずつ片付ければ怖くない。まず **AMI** だ。'),
        node('えーえむあい？ 相性占いか何かですか？'),
        hakase('占いではない。Amazon Machine Image、画面では「Amazon マシンイメージ」だ。OS やソフトがインストール済みのディスクの「型」だな。'),
        hakase('たい焼きの型を思い浮かべよ。同じ型なら、何匹焼いても同じ中身のたい焼きができる。今回は AWS 製の Linux、**Amazon Linux 2023** の型を使う。'),
        node('じゃあ次は、たい焼きの大きさですね。'),
        hakase('うむ。それが **インスタンスタイプ**、CPU とメモリの大きさだ。今回は `t3.micro`。仮想 CPU (vCPU) が 2 つ、メモリ 1 GiB の小さなやつだ。`t3` は種類と世代、`micro` はサイズを表す。'),
        node('一番大きいのにしておけば安心ですね！'),
        hakase('月末に請求書を見て、安心とは何かを考え直すことになるがな。大きいほど速いが、時間あたりの料金も上がるのだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('次は **キーペア**。SSH でログインするための鍵の組だ。'),
        node('SSH って、Lesson 01 のクイズで「全世界から SSH できる状態にしてしまった」ってやつですよね。'),
        hakase('よく覚えておったな。SSH は、離れた場所からサーバーにログインして操作する仕組みで、TCP の 22 番を使う。'),
        node('キーペアの「ペア」って、何と何なんです？'),
        hakase('公開鍵と秘密鍵だ。公開鍵はインスタンスに置かれ、秘密鍵は作ったときに 1 度だけ君の PC にダウンロードされる。錠前と、それに合う唯一の鍵だな。'),
        node('秘密鍵をなくしたら？'),
        hakase('そのキーペアでは二度と入れん。AWS も再発行してくれん。秘密鍵をデスクトップに置いたまま PC を初期化した新人を、ワシは 3 人知っておる。'),
        node('3 人も…。今回は用意済みの `webapp-key` を選べばいいんですね。'),
        hakase('うむ。そしてファイアウォールは **セキュリティグループ**。Lesson 09 でやった門番だ。'),
        node('許可リスト型のファイアウォールでしたよね。`web-server-sg` は、HTTP を `0.0.0.0/0` から許可したやつです。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('最後は **ネットワーク設定**。家を建てる土地を選ぶところで、VPC、サブネット、それに **パブリック IP の自動割り当て** を決める。'),
        node('VPC は `webapp-vpc`、サブネットは `public-subnet-1a` ですね。Lesson 06 で `0.0.0.0/0 → IGW` のルートを足して、Public subnet にした部屋です。'),
        hakase('うむ。ただし罠がある。VPC の欄には、最初から **デフォルト VPC** が選ばれておるのだ。'),
        node('でふぉると VPC？ そんなの作った覚えはないですけど。'),
        hakase('AWS がリージョンごとに最初から用意しておく VPC だ。CIDR は `172.31.0.0/16` で、すぐ使えるようにサブネットがインターネットにつながっておる。'),
        node('親切じゃないですか。'),
        hakase('親切すぎて、気づかずにそこへ建てる者が後を絶たん。他人の土地に家を建てたようなものだ。そして「DB につながりません」と夜中に電話してくる。'),
        node('パブリック IP は、Lesson 08 の「インターネットにつながる条件」の 1 つでしたよね。「リソースが Public IP を持っている」。'),
        hakase('うむ。だから **有効化** にする。名前は `my-first-ec2`、セキュリティグループは「既存のセキュリティグループを選択する」で `web-server-sg` だ。'),
        node('起動したら、すぐ使えるんですか？'),
        hakase('状態はまず **保留中** になり、準備ができると **実行中** になる。数秒の辛抱だ。さあ、建ててみよ。'),
      ],
    },
    {
      type: 'table',
      title: '「インスタンスを起動」で決めること',
      columns: ['項目', '意味', '今回の値'],
      rows: [
        ['AMI (Amazon マシンイメージ)', 'OS やソフトが入ったディスクの「型」', 'Amazon Linux 2023'],
        ['インスタンスタイプ', 'CPU とメモリの大きさ', '`t3.micro`'],
        ['キーペア', 'SSH ログイン用の鍵 (公開鍵と秘密鍵)', '`webapp-key`'],
        ['ネットワーク設定', 'どの VPC / サブネットに置くか、パブリック IP を付けるか', '`webapp-vpc` / `public-subnet-1a` / 有効化'],
        ['ファイアウォール (セキュリティグループ)', 'インスタンスの門番', '`web-server-sg`'],
      ],
    },
    {
      type: 'exercise',
      title: 'EC2 インスタンスを起動する',
      objective: '名前 `my-first-ec2` を `webapp-vpc` の `public-subnet-1a` に、セキュリティグループ `web-server-sg`、パブリック IP 有効で起動し、**実行中** にする',
      tasks: [
        { id: 'launch', title: 'インスタンス > **インスタンスを起動** を開く', hint: 'EC2 の左メニュー「インスタンス」 → 右上の **インスタンスを起動**。', hotspotId: 'ec2-launch', done: (c) => visited(c, '/ec2/launch') },
        { id: 'net', title: 'ネットワーク設定で VPC `webapp-vpc` / サブネット `public-subnet-1a` / パブリック IP の自動割り当て `有効化` を選ぶ', hint: 'VPC の初期値は **デフォルト VPC** です。そのまま起動すると別の VPC に作られてしまいます。', done: (c) => !!instanceNamed(c.env, 'my-first-ec2') },
        { id: 'running', title: 'インスタンスの状態が **実行中** になるのを待つ', hint: '保留中 → 実行中 には数秒かかります。インスタンス一覧は自動で更新されます。', done: (c) => instanceNamed(c.env, 'my-first-ec2')?.state === 'running' },
      ],
      validate: (c) => {
        const i = instanceNamed(c.env, 'my-first-ec2');
        if (!i) return ng(hakase('`my-first-ec2` という名前のインスタンスが見当たらん。「名前とタグ」の **名前** 欄に `my-first-ec2` と入れて起動したか、インスタンス一覧の Name 列で確かめるのだ。'));
        if (i.vpcId !== vpcNamed(c.env, 'webapp-vpc')?.vpcId) return ng(hakase('デフォルト VPC に建ててしまったな。さっき罠だと言ったばかりだろう。君の記憶は揮発性メモリか。'), hakase('実務でもよくある間違いだ。「インスタンスの状態」→「インスタンスを終了 (削除)」で片付けて、ネットワーク設定の VPC を `webapp-vpc` にして起動し直そう。'), node('VPC の欄、最初に見るようにします…'));
        if (i.subnetId !== subnetNamed(c.env, 'public-subnet-1a')?.subnetId) return ng(hakase('サブネットが `public-subnet-1a` ではないようだ。サブネットは起動した後では変えられん。終了して、ネットワーク設定の **サブネット** で `public-subnet-1a` を選んで起動し直すのだ。'));
        if (!i.securityGroupIds.includes(sgNamed(c.env, 'web-server-sg')?.groupId ?? '')) return ng(hakase('セキュリティグループに `web-server-sg` が付いていない。よその門番を雇ってしまったな。'), hakase('インスタンスの「アクション」→「セキュリティ」→「セキュリティグループを変更」で `web-server-sg` を付けるのだ。'));
        if (!i.associatePublicIpAddress) return ng(hakase('パブリック IP が付いておらん。これでは地図に載っていない家だ。'), hakase('自動割り当ては起動のときにしか決められん。終了して、ネットワーク設定の「パブリック IP の自動割り当て」を **有効化** にして起動し直すのだ。'));
        if (i.state !== 'running') return ng(hakase('まだ **実行中** になっていないな。保留中は準備中という意味だ。数秒待って、インスタンス一覧の状態を見るのだ。'));
        return ok(node('実行中になりました！ 僕の初めてのサーバーです！'), hakase('おめでとう。詳細画面の **パブリック IPv4 アドレス** を見てみよ。インターネットから見た、この家の住所だ。'), node('Lesson 09 でブラウザに貼り付けて開いた、あの番号ですね。'), hakase('うむ。ちなみに、動いている間はずっと料金がかかっておる。感動は手短にな。'));
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('さて、建てた家には住所が 2 つある。**プライベート IPv4 アドレス** と **パブリック IPv4 アドレス** だ。'),
        node('2 つも？ 郵便屋さんが迷いません？'),
        hakase('使う場所が違う。プライベートは Subnet の CIDR から割り当てられる、VPC の中だけで通じる内線番号。パブリックは、インターネットから見た外線番号だ。'),
        node('`public-subnet-1a` は `10.0.1.0/24` だから、プライベートは `10.0.1.x` になるんですね。Lesson 04 でやった CIDR の範囲です。'),
        hakase('うむ。それと `i-` で始まる **インスタンス ID**。こちらはインスタンスの社員番号だ。'),
        node('住所が 2 つに社員番号。人間より身分証が多いですね。'),
        hakase('では電源の話だ。インスタンスの状態は、止めると **停止中 → 停止済み**、削除すると **シャットダウン中 → 終了済み** と変わる。英語なら `stopping → stopped`、`shutting-down → terminated` だ。'),
        node('停止と終了って、何が違うんです？ どっちも止まってますよね。'),
        hakase('大違いだ。「インスタンスを停止」は電源を切るだけ。ディスクの **EBS** (Elastic Block Store) は残るから、また「インスタンスを開始」できる。'),
        node('いーびーえす？'),
        hakase('インスタンスにつないで使う、ネットワーク越しのディスクだ。OS もデータもここに入っておる。停止中はインスタンスの料金は止まるが、EBS の保管料はかかり続ける。'),
        node('寝てても家賃は取られるんですね。'),
        hakase('請求書は眠らんのだ。一方「インスタンスを終了 (削除)」は、その名のとおり削除だ。元には戻せん。'),
        node('「今日の作業は終了」のつもりで押したら…'),
        hakase('家ごと更地だ。本番サーバーでそれをやった新人の席も、翌月には更地になっておった。では停止してみよう。パブリック IP がどうなるか、よく見ておれ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'インスタンスを Stop する',
      objective: '`my-first-ec2` を停止し、**停止済み** になったらパブリック IP がどうなるか見る',
      tasks: [{ id: 'stop', title: 'インスタンスの状態 → **インスタンスを停止**', hint: 'インスタンス一覧でチェックを付けるか、詳細画面の **インスタンスの状態** メニューから。', done: (c) => instanceNamed(c.env, 'my-first-ec2')?.state === 'stopped' }],
      validate: (c) =>
        instanceNamed(c.env, 'my-first-ec2')?.state === 'stopped'
          ? ok(
              node('パブリック IPv4 アドレスが「-」になりました！ 住所が消えちゃいました。'),
              hakase('自動で割り当てたパブリック IP は、停止すると AWS に**返却**される。次に開始すると、別の番号が割り当てられるのだ。'),
              node('引っ越してもいないのに、住所が変わるんですか！？'),
              hakase('そういうことだ。住所を固定したければ **Elastic IP** を使う。アカウント専用に確保しておける、固定のパブリック IP だ。確保しておくだけでも料金はかかるがな。'),
            )
          : ng(hakase('まだ **停止済み** になっていないようだ。インスタンス一覧で `my-first-ec2` にチェックを付け、「インスタンスの状態」→「インスタンスを停止」を押したかな？ 停止中を経て停止済みになるまで、少し待つのだ。')),
    },
    {
      type: 'exercise',
      title: 'インスタンスを Start する',
      objective: '`my-first-ec2` を開始して **実行中** に戻す',
      tasks: [{ id: 'start', title: 'インスタンスの状態 → **インスタンスを開始**', hint: '停止済みのときだけ選べます。', done: (c) => instanceNamed(c.env, 'my-first-ec2')?.state === 'running' }],
      validate: (c) =>
        instanceNamed(c.env, 'my-first-ec2')?.state === 'running' && instanceNamed(c.env, 'my-first-ec2')?.publicIpAddress
          ? ok(
              node('実行中に戻りました！ パブリック IPv4 アドレスも付いてます。'),
              hakase('だが、停止する前とは別の番号のはずだ。同じ家に、新しい住所が付いたのだ。'),
              node('前の番号をブックマークしてたお客さんは、迷子ですね。'),
              hakase('うむ。だから本番では、IP アドレスが変わる前提で設計する。これは試験に出るぞ。すぐ次にな。'),
            )
          : ng(hakase('まだ **実行中** に戻っていない。「インスタンスの状態」→「インスタンスを開始」は、停止済みのときだけ押せる。押したら、保留中を経て実行中になるまで待つのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。Elastic IP を付けていない EC2 を停止して、また開始した。変わってしまうのはどれかな？'),
      options: ['Private IPv4 address', 'Public IPv4 address', 'インスタンス ID'],
      answer: 1,
      explanation: [
        hakase('正解。プライベート IP とインスタンス ID は、停止しても変わらん。変わるのは、自動で割り当てたパブリック IP だけだ。'),
        hakase('だから「この IP に接続する」と決め打ちする設計は危うい。次のレッスンでやる ALB のように、変わらない名前の窓口を立てるのが定石だ。'),
        node('IP アドレスを名刺に刷っちゃダメってことですね。'),
      ],
    },
    {
      type: 'exercise',
      title: 'VPC → Subnet → EC2 → Security Group を辿る',
      objective: '`my-first-ec2` の詳細から、所属する Subnet・VPC・Security group の画面へリンクで移動する',
      tasks: [
        { id: 'subnet', title: 'EC2 詳細の **サブネット ID** リンクから Subnet を開く', hint: 'インスタンスの概要か ネットワーキングタブの サブネット ID。', done: (c) => visitedId(c, '/vpc/subnets/', subnetNamed(c.env, 'public-subnet-1a')?.subnetId) },
        { id: 'vpc', title: 'Subnet 詳細の **VPC** リンクから VPC を開く', hint: '詳細の VPC の値。', done: (c) => visitedId(c, '/vpc/vpcs/', vpcNamed(c.env, 'webapp-vpc')?.vpcId) },
        { id: 'sg', title: 'EC2 詳細の **セキュリティ** タブから `web-server-sg` を開く', hint: 'インスタンスに戻り、my-first-ec2 → セキュリティタブ → セキュリティグループのリンク。', done: (c) => visitedId(c, '/security-groups/', sgNamed(c.env, 'web-server-sg')?.groupId) },
      ],
      validate: (c) =>
        visitedId(c, '/vpc/vpcs/', vpcNamed(c.env, 'webapp-vpc')?.vpcId) && visitedId(c, '/security-groups/', sgNamed(c.env, 'web-server-sg')?.groupId)
          ? ok(
              hakase('辿れたな。この EC2 が「どの VPC の」「どの Subnet に建ち」「どの Security Group を門番にしているか」を、リンクで行き来できた。'),
              node('Lesson 03 から作ってきたものが、全部つながってるんですね。'),
              hakase('うむ。障害調査では、この関係を素早く辿れるかどうかで、帰宅時間が数時間変わる。'),
              node('数時間…！'),
              hakase('ワシは辿れなかった夜、始発で帰ったことがある。'),
            )
          : ng(hakase('まだ辿っていない画面があるようだ。インスタンス詳細の **サブネット ID** → サブネット詳細の **VPC**、それからインスタンスに戻って **セキュリティ** タブのセキュリティグループ、の順にリンクを押すのだ。')),
    },
  ],
};

export const lesson11: Lesson = {
  id: 'alb',
  number: '11',
  title: 'ALB',
  summary: 'Application Load Balancer を Public subnet に作り、Private の EC2 へ振り分ける',
  minutes: 20,
  startPath: '/ec2/load-balancers',
  scenario: () => webAppEnv({ upTo: 'target-group' }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、前回 EC2 を Public subnet に建てましたけど、インターネットに直接さらされてるのって、ちょっと怖くないですか？'),
        hakase('ほう、ノード君にしては健全な恐怖心だ。パブリック IP を持つサーバーには、世界中から 24 時間ノックが来る。'),
        node('玄関が大通りに面してる家、って感じですね。'),
        hakase('うむ。そこで本番では、アプリのサーバーを **Private subnet** に隠す。Lesson 06 でやったな。'),
        node('Route table に `0.0.0.0/0 → IGW` が無いから、インターネットから直接届かない部屋でしたよね。'),
        hakase('そうだ。だが届かないままでは、お客さんも使えん。'),
        node('鍵をかけすぎて、お客さんも入れないお店ですね。'),
        hakase('そこで、表玄関に受付係を置く。それが **ロードバランサー** だ。'),
        node('ろーどばらんさー？'),
        hakase('Load は「負荷」、Balance は「釣り合わせる」。受け取ったリクエストを後ろの複数のサーバーに振り分けて、負荷を均すのだ。銀行で「3 番の窓口へどうぞ」と案内する係だな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('AWS のロードバランサーにはいくつか種類があるが、Web なら **ALB** (Application Load Balancer) を使う。HTTP の中身まで読んで振り分けられるやつだ。'),
        node('案内係だけが表に出て、窓口の人は奥にいる、と。今回の奥の窓口は誰なんですか？'),
        hakase('`web-1` と `web-2` の 2 台だ。それぞれ `private-subnet-1a` と `private-subnet-1c` にいて、ポート 3000 でアプリが待っておる。'),
        node('ポートって、Lesson 09 で HTTP は TCP 80、SSH は 22 ってやった、あの番号ですよね。'),
        hakase('うむ。ポートは、サーバーの中の窓口番号だ。このアプリは 3000 番の窓口で受け付けておる。'),
        node('なんで 80 じゃないんですか？'),
        hakase('アプリの開発者がそう決めたからだ。お客さんは 80 番で ALB に来て、ALB が奥の 3000 番へ回す。表と奥で番号が違ってかまわんのだ。'),
        node('奥の 2 台の名簿みたいなものはあるんですか？'),
        hakase('ある。**ターゲットグループ** `web-tg` に、2 台とも登録済みだ。ALB の転送先の名簿だな。詳しくは次のレッスンでやる。'),
        node('じゃあ足りないのは…'),
        hakase('受付係、つまり ALB 本体だけだ。今日はそれを作る。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('ALB を作るときに決めるのは主に 4 つ。まず **スキーム**。「インターネット向け」か「内部」かだ。'),
        node('すきーむ？ 悪だくみですか？'),
        hakase('それは scheme の別の意味だな。ここでは「方式」だ。インターネット向けはパブリック IP を持ち、インターネットから受け付ける。内部は VPC の中だけの受付だ。しかも、作った後では変えられん。'),
        node('後から変えられないもの、多いですね…'),
        hakase('次に **ネットワークマッピング**。ALB を置く Subnet を選ぶ。条件は **2 つ以上の AZ** で、AZ ごとに Subnet を 1 つずつだ。'),
        node('AZ は Lesson 02 でやった、同じリージョンの中の別々のデータセンター群ですね。'),
        hakase('うむ。ALB は選んだ AZ ごとに受付の分身を置く。片方の AZ が停電しても、もう片方で受付を続けられるのだ。'),
        node('表玄関だから、選ぶのは Public subnet ですね。`public-subnet-1a` と `public-subnet-1c`。'),
        hakase('その通り。3 つ目は **セキュリティグループ**、ALB の門番だ。`alb-sg` に、HTTP 80 を `0.0.0.0/0` から許可するルールが入っておる。VPC に最初からある `default` のセキュリティグループが選ばれていたら、外しておけ。'),
        node('最後は？'),
        hakase('**リスナー**。英語の listen、「耳を傾ける」係だ。どのプロトコルとポートで受け付けて、どこへ送るかを決める。今回は `HTTP:80` で受けて、`web-tg` へ転送だ。'),
      ],
    },
    {
      type: 'table',
      title: 'ALB を作るときの設定',
      columns: ['設定', '意味', '今回の値'],
      rows: [
        ['スキーム', '**インターネット向け** (パブリック IP を持つ) か **内部** か。作成後は変更できない', '`インターネット向け`'],
        ['ネットワークマッピング', '2 つ以上の AZ と、各 AZ の Subnet', '`public-subnet-1a`, `public-subnet-1c`'],
        ['セキュリティグループ', 'ALB のファイアウォール', '`alb-sg` (HTTP 80 を 0.0.0.0/0 から許可)'],
        ['リスナー', 'どのプロトコル・ポートで受けて、どこへ送るか', '`HTTP:80` → 転送先 `web-tg`'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('よし、作ります！'),
        hakase('待て。作成画面の VPC の欄は、最初は **デフォルト VPC** になっておる。前回の EC2 と同じ罠だ。'),
        node('うっ、`webapp-vpc` に変えます。変えると、AZ ごとに Subnet を選べるようになるんですね。'),
        hakase('うむ。それと、Private subnet を選ぶと画面に警告が出る。見て見ぬふりをすると、誰も来ない受付が完成するぞ。'),
        node('作ったら、状態が **プロビジョニング中** から **アクティブ** になるのを待つんですよね。ぷろびじょにんぐ…？'),
        hakase('「準備・手配」という意味だ。AWS が裏で受付係を手配しておる。アクティブになれば開店だ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'Application Load Balancer を作成する',
      objective: '`web-alb` をインターネット向け・`webapp-vpc`・public-subnet-1a/1c・`alb-sg`・リスナー HTTP:80 → `web-tg` で作成し、**アクティブ** にする',
      tasks: [
        { id: 'type', title: 'ロードバランサー > **ロードバランサーの作成** → Application Load Balancer の **作成**', hint: 'ロードバランサーの種類を選ぶ画面が出ます。', hotspotId: 'alb-create', done: (c) => visited(c, '/ec2/load-balancers/create-alb') },
        { id: 'create', title: 'ネットワークマッピングで 1a / 1c の **パブリック**サブネット、セキュリティグループに `alb-sg` を選んで作成', hint: 'VPC を webapp-vpc に変えるとアベイラビリティーゾーンの一覧が出ます。各 AZ にチェックを入れて Subnet を選びます。セキュリティグループの default は外しましょう。', hotspotId: 'alb-submit', done: (c) => !!lbNamed(c.env, 'web-alb') },
        { id: 'active', title: '状態が **アクティブ** になるのを待つ', hint: 'プロビジョニング中 → アクティブ に数秒かかります。', done: (c) => lbNamed(c.env, 'web-alb')?.state === 'active' },
      ],
      validate: (c) => {
        const lb = lbNamed(c.env, 'web-alb');
        if (!lb) return ng(hakase('`web-alb` が見つからん。**ロードバランサー名** を `web-alb` にして作成したか、ロードバランサー一覧で確かめるのだ。'));
        if (lb.scheme !== 'internet-facing') return ng(hakase('スキームが **内部** になっておる。それでは VPC の中からしか来られない受付だ。'), hakase('インターネットから使う ALB は **インターネット向け** にする。スキームは後から変えられないから、作り直しだ。'));
        const privateOnes = lb.subnetIds.filter((s) => !isPublicSubnet(c.env, s));
        if (privateOnes.length) return ng(hakase('ALB のサブネットに Private subnet が混じっておる。インターネット向けの ALB は、`0.0.0.0/0 → IGW` のある Public subnet に置かないと、インターネットから届かんのだ。'), node('作成画面にも警告が出ていました…見て見ぬふりしちゃいました。'), hakase('ネットワークマッピングでは、1a にも 1c にも `public-subnet-` のほうを選ぶのだ。'));
        if (!lb.securityGroupIds.includes(sgNamed(c.env, 'alb-sg')?.groupId ?? '')) return ng(hakase('セキュリティグループに `alb-sg` が付いていない。門番を間違えた受付には、お客さんが入れんぞ。ロードバランサーの詳細から「セキュリティグループを編集」で `alb-sg` を付けるのだ。'));
        if (lb.listeners[0]?.port !== 80 || lb.listeners[0]?.targetGroupArn !== tgNamed(c.env, 'web-tg')?.targetGroupArn) return ng(hakase('リスナーが `HTTP:80` → `web-tg` になっていないようだ。「リスナーとルーティング」で、ポート `80`、デフォルトアクションの転送先に `web-tg` を選ぶのだ。'));
        if (lb.state !== 'active') return ng(hakase('まだ **プロビジョニング中** だ。AWS が受付係を手配しておる。数秒待って、状態が **アクティブ** になってから押すのだ。'));
        return ok(
          hakase('ALB ができた。詳細画面の **DNS 名** を見てみよ。`web-alb-` で始まる長い名前、それがこの ALB の住所だ。'),
          node('でぃーえぬえす？'),
          hakase('コンピュータは IP アドレスでしか相手を探せん。そこで、名前から IP アドレスを引く電話帳のような仕組みがある。それが **DNS** (Domain Name System) だ。'),
          node('ALB の IP アドレスを直接使っちゃダメなんですか？'),
          hakase('ALB の IP アドレスは、AWS の都合で変わることがある。前回、停止するたびにパブリック IP が変わったのと同じ轍を踏むな。変わらない名前のほうを使うのだ。詳しくは Lesson 35 でやる。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'ALB の DNS 名にブラウザでアクセスする',
      objective: '`web-alb` の DNS 名をコピーし、パネルの「ブラウザ」タブで開いて HTTP 200 を確認する',
      tasks: [
        { id: 'copy', title: 'web-alb 詳細の **DNS 名** をコピー', hint: 'DNS 名の横のコピーアイコン。', done: (c) => copied(c, lbNamed(c.env, 'web-alb')?.dnsName) },
        { id: 'browse', title: '「ブラウザ」タブに貼り付けて **移動**', hint: '`http://` は省略しても構いません。', done: (c) => lastAlbRequest(c)?.status === 200 },
      ],
      validate: (c) => {
        const r = lastAlbRequest(c);
        if (!r) return ng(hakase('まだ ALB にアクセスしていないようだ。DNS 名の横のコピーアイコンを押して、パネルの「ブラウザ」タブに貼り付け、**移動** を押すのだ。'));
        if (r.status !== 200) return ng(hakase(`結果は ${r.error ?? r.status} だ。ブラウザタブの下の「通信経路の診断 (学習用)」を開くと、どの区間で止まったかが分かる。このシミュレーターのおまけの道具だ。赤い行を探すのだ。`));
        return ok(
          node('「Hello from web-1」って出ました！ HTTP 200 です！'),
          hakase('200 は「OK」、つまり成功の返事だ。お客さん → ALB → Private subnet の web-1 と、受付係がちゃんと奥へ取り次いだのだ。'),
          node('何回か「移動」を押したら、web-2 が答えることもあるんですか？'),
          hakase('うむ、少し間をあけて押してみよ。ALB が 2 台に振り分けておるから、ときどき web-2 が答える。片方が倒れても、もう片方が働く。ワシの職場もそうであってほしかった。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。ALB を作るときに選ぶ Subnet には条件があった。どれかな？'),
      options: ['1 つの Subnet だけ', '2 つ以上の、異なる AZ の Subnet', '同じ AZ の 2 つの Subnet'],
      answer: 1,
      explanation: [
        hakase('正解。ALB は選んだ AZ ごとに **ノード** と呼ばれる受付の分身を置く。1 つの AZ が止まっても、残りで受付を続けるためだ。'),
        node('ノード…僕が各 AZ に 1 人ずついるってことですか？'),
        hakase('君ではない。君が 2 人いたら、障害報告書も 2 倍になるだけだ。'),
      ],
    },
  ],
};

export const lesson12: Lesson = {
  id: 'target-group',
  number: '12',
  title: 'Target Group',
  summary: 'ALB の転送先を登録する。503 の意味',
  minutes: 20,
  startPath: '/ec2/load-balancers',
  scenario: () => webAppEnv({ upTo: 'load-balancer', registerTargets: false }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、大変です！ ALB の DNS 名を開いたら、**503 Service Temporarily Unavailable** って出ました！'),
        hakase('朝から景気のいい数字だな。DNS 名は、前回やった ALB の住所だ。住所は合っておるから、ALB には届いた。届いた先で断られたのだ。'),
        node('断られた？ 503 ってどういう意味なんですか？'),
        hakase('ブラウザに返ってくる 3 桁の数字を **HTTP ステータスコード** という。200 が成功の「OK」だったな。先頭の桁で、大まかな意味が分かる。'),
        node('先頭の桁？'),
        hakase('4 で始まる **4xx** は「お客さん側の間違い」、5 で始まる **5xx** は「サーバー側の問題」だ。'),
        node('つまり 503 は、こっち側のせい…'),
        hakase('うむ。謝る側だ。503 は「今はサービスを提供できません」。ALB が「取り次ぐ相手がいない」と言っておる。'),
        node('取り次ぐ相手って `web-1` と `web-2` ですよね？ 2 台とも実行中なのに。'),
        hakase('実行中でも、ALB がその存在を知らなければ、いないのと同じだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('前回、ALB の転送先の名簿を何と言ったか覚えておるか。'),
        node('**ターゲットグループ** ですよね。`web-tg`。'),
        hakase('うむ。ALB はリスナーで受けたリクエストを、ターゲットグループに登録された **ターゲット** に転送する。ターゲットとは転送先のことだ。'),
        node('リスナーは、`HTTP:80` で耳を傾けてる係でしたね。'),
        hakase('そうだ。前回は `web-tg` に 2 台をワシが登録しておいてやった。今日の環境は、その名簿が白紙だ。'),
        node('白紙の名簿で「3 番窓口へどうぞ」と言われても、窓口に誰もいないですね。'),
        hakase('だから ALB は 503 を返す。まずは自分の目で確かめよう。ブラウザタブの下にある「通信経路の診断 (学習用)」も開いてみよ。'),
        node('つうしんけいろのしんだん？'),
        hakase('リクエストがどの区間を通り、どこで止まったかを並べてくれる。本物の AWS には無い、このシミュレーターのおまけだ。本物では、この推理を自分の頭でやることになる。'),
        node('本物、厳しいですね…'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('直し方は、名簿に 2 台を書き込めばいいんですよね。'),
        hakase('うむ。`web-tg` の「ターゲット」タブで **ターゲットの登録** を押す。インスタンスを選び、ポートを決めて登録だ。'),
        node('ポートは 3000 ですよね。前回、アプリは 3000 番の窓口で待ってるって。'),
        hakase('よく覚えておったな。今日は傘を持って帰れ。'),
        node('雨の予報なんて出てませんよ？'),
        hakase('君が覚えておるのだ、何が降ってもおかしくない。……それと、登録画面は 2 段階だ。まず「**保留中として以下を含める**」で下書きに載せ、次に「**保留中のターゲットを登録**」で確定する。'),
        node('ほりゅうちゅう。まだ確定してない、ってことですね。下書きのまま帰っちゃう人、いそうです。'),
        hakase('おる。そして「登録したのに 503 のまま」と騒ぐのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '503 を確認する',
      objective: '`web-alb` の DNS 名をブラウザで開き、503 を確認する',
      tasks: [
        { id: 'copy', title: 'web-alb の **DNS 名** をコピー', hint: 'ロードバランサー一覧の DNS 名の列にもコピーアイコンがあります。', done: (c) => copied(c, lbNamed(c.env, 'web-alb')?.dnsName) },
        { id: 'browse', title: 'ブラウザタブで開いて **503** を確認', hint: '「通信経路の診断」も開いてみましょう。', done: (c) => lastAlbRequest(c)?.status === 503 },
      ],
      validate: (c) =>
        lastAlbRequest(c)?.status === 503
          ? ok(
              node('診断に「ターゲットが登録されていません」って出てます！'),
              hakase('名簿が白紙、の動かぬ証拠だな。では名簿の中身を見ていこう。ターゲットには **ターゲットタイプ** という種類があり、インスタンスの他に、IP アドレスや Lambda 関数、ALB そのものを登録する種類もある。'),
              node('らむだ？'),
              hakase('サーバーを用意せずに、プログラムだけを動かせる AWS のサービスだ。後のレッスンで出てくるから、今は名前だけ覚えておけ。今回はインスタンスを登録する。'),
              hakase('もう 1 つ大事なのが **ヘルスチェック**。ALB が各ターゲットに「生きておるか？」と定期的に聞く健康診断だ。合格すると **正常 (healthy)** になり、初めてリクエストが届く。詳しくは次のレッスンでやる。'),
            )
          : ng(hakase('まだ 503 を確認していないようだ。ロードバランサー一覧の **DNS 名** の列でコピーアイコンを押し、ブラウザタブに貼り付けて **移動** するのだ。')),
    },
    {
      type: 'table',
      title: 'Target group の主な設定',
      columns: ['設定', '意味'],
      rows: [
        ['ターゲットタイプ', '転送先の種類: インスタンス / IP アドレス / Lambda 関数 / Application Load Balancer'],
        ['プロトコル : ポート', 'ALB からターゲットへ送るときのプロトコルとポート (今回 `HTTP:3000`)'],
        ['登録済みターゲット', '実際の転送先 (インスタンスとポート)'],
        ['ヘルスチェック', 'ターゲットが正常かを確かめる健康診断の設定'],
      ],
    },
    {
      type: 'exercise',
      title: 'Target を登録する',
      objective: '`web-tg` に `web-1` と `web-2` を port `3000` で登録し、両方 healthy にする',
      tasks: [
        { id: 'open', title: 'ターゲットグループで `web-tg` を開く', hint: 'EC2 の左メニュー ロードバランシング → ターゲットグループ。', done: (c) => visitedId(c, '/ec2/target-groups/', 'web-tg') },
        { id: 'register', title: 'ターゲットタブの **ターゲットの登録**', hint: '「登録済みターゲット」の表の右上にあるボタンです。押すと「ターゲットを登録」画面が開き、使用可能なインスタンスが一覧されます。', hotspotId: 'tg-register', done: (c) => visited(c, /register-targets/) },
        { id: 'pending', title: 'web-1 と web-2 にチェック → ポート `3000` → **保留中として以下を含める** → **保留中のターゲットを登録**', hint: '「選択したインスタンスのポート」が 3000 になっていることを確認してから「保留中として以下を含める」を押します。', hotspotId: 'tg-register-submit', done: (c) => (tgNamed(c.env, 'web-tg')?.targets.length ?? 0) >= 2 },
        { id: 'healthy', title: 'ヘルスステータスが **正常 (healthy)** になる', hint: 'ターゲットタブの「ヘルスステータス」列で 2 台とも **正常** か確認します。変わらなければ「ヘルスステータスの詳細」列に理由が出ます。', done: (c) => allTargetsHealthy(c.env, 'web-tg', 2) },
      ],
      validate: (c) => {
        const tg = tgNamed(c.env, 'web-tg')!;
        if (tg.targets.length < 2) return ng(hakase('ターゲットがまだ 2 台登録されていない。「保留中として以下を含める」だけで満足して、「保留中のターゲットを登録」を押し忘れておらんか？'));
        if (tg.targets.some((t) => t.port !== 3000)) return ng(hakase('ポートが 3000 ではないターゲットがあるぞ。アプリは 3000 番の窓口で待っておるのだ。'), hakase('間違えたターゲットは登録解除して、「選択したインスタンスのポート」を `3000` にして登録し直すのだ。'));
        if (!allTargetsHealthy(c.env, 'web-tg', 2)) return ng(hakase('まだ **正常 (healthy)** でないターゲットがある。登録直後は健康診断の最中だから、少し待て。それでも変わらなければ、ターゲットタブの **ヘルスステータスの詳細** に理由が書いてある。'));
        return ok(
          hakase('2 台とも **正常 (healthy)** だ。名簿に載って、健康診断にも合格した。'),
          node('これで ALB が 2 台に取り次げるんですね。'),
          hakase('うむ。だが画面が緑になっただけで安心するのは早い。お客さんの目で、もう一度ブラウザで確かめるのだ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '復旧を確認する',
      objective: 'ブラウザで `web-alb` にアクセスし、HTTP 200 を確認する',
      tasks: [{ id: 'browse', title: 'ブラウザタブで ALB にアクセス → **200**', hint: 'さっき 503 だった `web-alb` の DNS 名のまま、「ブラウザ」タブで **移動** を押し直します。', done: (c) => lastAlbRequest(c)?.status === 200 }],
      validate: (c) =>
        lastAlbRequest(c)?.status === 200
          ? ok(
              node('503 から 200 になりました！ Hello from web-1 です！'),
              hakase('受付係に名簿を渡しただけで、店が開いた。障害の半分は、こういう「書き忘れ」だ。'),
              node('残りの半分は？'),
              hakase('「消し忘れ」と「押し間違い」だ。どちらも君の得意分野だな。'),
            )
          : ng(hakase('最新のアクセス結果がまだ 200 ではない。ターゲットが 2 台とも正常になったのを確かめてから、ブラウザタブでもう一度 **移動** を押すのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。リスナーは `HTTP:80`、ターゲットグループは `HTTP:3000`。では 3000 は何のポートかな？'),
      options: ['ユーザーのブラウザが ALB に接続するポート', 'ALB が EC2 上のアプリに接続するポート', 'ヘルスチェック専用のポート'],
      answer: 1,
      explanation: [
        hakase('正解。お客さん → ALB が 80 番、ALB → EC2 が 3000 番だ。'),
        hakase('ALB を挟むと、通信は 2 つの区間に分かれる。区間ごとに別々に考えるのが、ALB まわりのトラブルを解くコツだ。'),
        node('表玄関は 80 番、奥の窓口は 3000 番。覚えました！'),
      ],
    },
  ],
};

export const lesson13: Lesson = {
  id: 'health-check',
  number: '13',
  title: 'Health Check',
  summary: 'Unhealthy の理由を読み解く。fail open の落とし穴',
  minutes: 20,
  startPath: '/ec2/target-groups',
  scenario: () => webAppEnv({}, (env) => modifyTargetGroupHealthCheck(env, env.targetGroups[0].targetGroupArn, { ...env.targetGroups[0].healthCheck, path: '/healthz' })),
  steps: [
    {
      type: 'dialogue',
      lines: [
        hakase('前回、ターゲットを登録したら、**正常 (healthy)** になるまで待ったな。'),
        node('はい。ALB の健康診断に合格すると、正常になるんでしたよね。'),
        hakase('うむ。今日はその健康診断、**ヘルスチェック** を詳しくやる。ALB は各ターゲットに定期的に HTTP リクエストを送り、決められた応答コードが返ってくれば正常と判断する。'),
        node('「生きてますか？」「はい、200 です」みたいな？'),
        hakase('そうだ。返事がない、または違うコードが返ると **異常 (unhealthy)** になる。コンソールでは「異常」と表示される。'),
        node('異常なターゲットには、ALB はリクエストを送らないんですよね。倒れてる窓口にお客さんを案内しても仕方ないし。'),
        hakase('基本はそうだ。ただし例外がある。その例外が、今日の主役だ。'),
        node('例外が主役って、嫌な予感しかしないです。'),
        hakase('勘がよくなったな。障害の現場で長生きする素質だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('まず健康診断の設定を見ておこう。**パス** は、ALB が「どのページに」聞きに行くかだ。'),
        node('ぱす？ 通行証ですか？'),
        hakase('道のほうだ。`http://example.com/health` なら、名前の後ろの `/health` の部分。建物の中の部屋番号のようなものだな。'),
        node('アプリのほうが「健康診断はこの部屋で受け付けます」って決めてるわけですね。'),
        hakase('うむ。**ポート** は普通 **トラフィックポート**、つまりターゲットを登録したポート (今回は 3000) をそのまま使う。**成功コード** は「この応答なら健康」とみなすステータスコードで、既定は `200` だ。'),
        node('設定画面にある「しきい値」っていうのは？'),
        hakase('敷居の「しきい」だ。何回連続で失敗したら異常にし、何回連続で成功したら正常に戻すか、という回数だな。1 回くしゃみをしただけで入院させていては、病院がパンクする。'),
        node('**間隔** と **タイムアウト** は、診断の頻度と、返事を待つ時間ですね。'),
        hakase('その通り。既定では 30 秒ごとに聞き、5 秒待って返事がなければ失敗とする。'),
      ],
    },
    {
      type: 'table',
      title: 'Health check の設定',
      columns: ['設定', '意味'],
      rows: [
        ['ヘルスチェックパス', 'ALB がリクエストするパス (例 `/health`)'],
        ['ポート', '通常は **トラフィックポート** (= ターゲットを登録したポート)'],
        ['成功コード', 'healthy とみなす HTTP ステータスコード (既定 `200`)'],
        ['正常のしきい値 / 非正常のしきい値', '何回連続で成功 / 失敗したら状態を変えるか (既定 5 回 / 2 回)'],
        ['間隔 / タイムアウト', 'チェックの間隔と、返事を待つ時間 (既定 30 秒 / 5 秒)'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('博士、監視から「`web-tg` のターゲットが全部 Unhealthy」ってアラートが来ました！'),
        hakase('監視の仕組みが異常を知らせてきたわけだ。全部、とは穏やかではないな。'),
        node('でも…お客さんからの苦情はまだ来てないんです。サイトも見られるみたいで。'),
        hakase('ほう。全員が重病なのに、店は営業しておる、と。'),
        node('監視のほうが壊れてるんですかね？ アラートを止めちゃえば静かになりますよ。'),
        hakase('火災報知器がうるさいから電池を抜く、というやつだな。家が燃えてから後悔するタイプだ。'),
        node('うっ…'),
        hakase('まずは事実を集める。`web-tg` のターゲットタブで **ヘルスステータスの詳細** を読み、それからブラウザで ALB を開いて、本当に見られるかを確かめよう。'),
        node('ヘルスステータスの詳細って、何が書いてあるんですか？'),
        hakase('異常の理由だ。英語で短く書いてある。医者のカルテのようなものだな。'),
      ],
    },
    {
      type: 'exercise',
      title: '状況を調べる',
      objective: '`web-tg` の ターゲットタブで **ヘルスステータスの詳細** を読み、ブラウザで ALB にアクセスしてみる',
      tasks: [
        { id: 'tg', title: 'ターゲットグループで `web-tg` を開き ターゲットタブを見る', hint: '一覧の名前 `web-tg` のリンクをクリックします。ターゲットタブの「ヘルスステータスの詳細」列に、異常の理由が英語で書かれています。', done: (c) => visitedId(c, '/ec2/target-groups/', 'web-tg') },
        { id: 'browse', title: 'ブラウザタブで `web-alb` の DNS 名を開く', hint: 'DNS 名はロードバランサー一覧からコピーできます。', done: (c) => !!lastAlbRequest(c) },
      ],
      validate: (c) =>
        visitedId(c, '/ec2/target-groups/', 'web-tg') && lastAlbRequest(c)
          ? ok(
              node('ヘルスステータスの詳細は `Health checks failed with these codes: [404]` です。でもブラウザでは 200 で表示されました！'),
              hakase('それが **fail open** (フェイルオープン) だ。正常なターゲットが 1 台もなくなると、ALB は「全部止めるよりはマシ」と判断して、異常なターゲットにもリクエストを送る。'),
              node('だから苦情が来てないんですね。よかった！'),
              hakase('よくはない。今は偶然動いておるだけだ。この状態で 1 台が本当に壊れても、ALB には見分けがつかん。壊れた窓口にも、お客さんを案内し続けてしまうのだ。'),
              node('健康診断が、まるで役に立ってないってことか…'),
            )
          : ng(hakase('ターゲットの状態とブラウザの両方を確認するのだ。ターゲットグループで `web-tg` を開いてターゲットタブを見てから、ブラウザタブで `web-alb` の DNS 名を開くのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        hakase('では推理だ。404 というコード、どう読む？'),
        node('4 で始まるから「お客さん側の間違い」でしたよね。前回の 503 のときに教わりました。'),
        hakase('うむ。404 は **Not Found**、「そんなページは無い」だ。ここでのお客さんは、健康診断に来た ALB 自身だな。'),
        node('ALB が、存在しない部屋に健康診断に行ってる？'),
        hakase('そういうことだ。ターゲットグループの **ヘルスチェック** タブで、パスを見てみよ。'),
        node('ええと…`/healthz` になってます。アプリの健康診断の部屋は `/health` のはず…'),
        hakase('最後の `z` 1 文字だ。誰かが「こっちのほうが格好いい」と書き換えたらしい。'),
        node('1 文字で全台異常…'),
        hakase('障害報告書で一番書きにくいのは、原因が 1 文字のときだ。ワシが言うのだから間違いない。では直そう。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ヘルスチェックパス を修正する',
      objective: '`web-tg` の ヘルスチェックパス を `/health` に直し、全 Target を healthy にする',
      tasks: [
        { id: 'edit', title: 'ヘルスチェックタブ → **編集**', hint: '`web-tg` の「ヘルスチェック」タブで、「ヘルスチェックの設定」の右上にあるボタンです。編集の前に、今の「パス」の値を見ておきましょう。', hotspotId: 'tg-edit-health', done: (c) => visited(c, /edit-health-check/) },
        { id: 'path', title: 'ヘルスチェックパス を `/health` にして **変更を保存**', hint: '書き換えるのは「ヘルスチェックパス」の入力欄だけです。「ヘルスチェックの詳細設定」の成功コード (`200`) はそのままにします。', hotspotId: 'tg-save-health', done: (c) => tgNamed(c.env, 'web-tg')?.healthCheck.path === '/health' },
        { id: 'healthy', title: 'Targets がすべて **正常 (healthy)** になる', hint: '保存するとヘルスチェックタブに戻ります。「ターゲット」タブに切り替えて、2 台のヘルスステータスが **正常** になったか確認します。', done: (c) => allTargetsHealthy(c.env, 'web-tg', 2) },
      ],
      validate: (c) => {
        const hc = tgNamed(c.env, 'web-tg')!.healthCheck;
        if (hc.path !== '/health') return ng(hakase(`パスがまだ \`${hc.path}\` だ。ヘルスチェックタブの **編集** で、ヘルスチェックパスを \`/health\` にして **変更を保存** するのだ。`));
        if (hc.matcher !== '200') return ng(hakase('成功コードを変えてしまったな？ 404 を成功扱いにすると、「部屋が無い」も健康ということになる。本当の異常を見逃すぞ。'), hakase('成功コードは `200` に戻して、直すのはパスのほうだ。'));
        return allTargetsHealthy(c.env, 'web-tg', 2)
          ? ok(
              hakase('全ターゲットが **正常** に戻った。これで ALB は、本当に元気なターゲットだけにお客さんを案内できる。'),
              node('fail open も解除ですね。'),
              hakase('うむ。正常なターゲットが 1 台でもあれば、異常なほうには送らなくなる。健康診断が、ようやく仕事を取り戻したのだ。'),
            )
          : ng(hakase('まだ正常になっていないターゲットがある。ターゲットタブの **ヘルスステータスの詳細** に、残っている理由が書いてあるはずだ。'));
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。成功コードを `200-499` にすれば、404 でも正常になってアラートは止まる。これは良い対処かな？'),
      options: ['良い。アラートが止まる', '良くない。本当に壊れた Target も healthy に見えてしまう'],
      answer: 1,
      explanation: [
        hakase('その通り。ヘルスチェックは「アプリが本当に応答できるか」を見るものだ。'),
        hakase('アラートを黙らせるために基準を緩めるのは、体温計の目盛りを書き換えて平熱にするようなものだ。熱は下がらん。'),
        node('火災報知器の電池を抜くのと同じですね。'),
      ],
    },
  ],
};

export const lesson14: Lesson = {
  id: 'rds',
  number: '14',
  title: 'RDS',
  summary: 'Private subnet にマネージドな MySQL を作る',
  minutes: 20,
  startPath: '/rds/databases',
  scenario: () =>
    webAppEnv({ upTo: 'load-balancer', appUsesDb: true }, (env) =>
      createDbSubnetGroup(env, { name: 'webapp-db-subnet-group', description: 'Private subnets for webapp-db', vpcId: byName(env.vpcs, 'webapp-vpc')!.vpcId, subnetIds: ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId) }),
    ),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、ALB を開いたら、今度は **500 Internal Server Error** です…'),
        hakase('5 で始まるということは？'),
        node('サーバー側の問題、ですよね。503 のときは、取り次ぐ相手がいない、でした。'),
        hakase('うむ。500 は「サーバーの中で何かが起きて、処理できなかった」だ。今回、ALB はちゃんと取り次げた。転んだのはアプリ自身だ。'),
        node('何につまずいたんですか？ 画面には「アプリがDatabaseに接続できません」って出てました。'),
        hakase('それが答えだ。アプリはお客さんの注文や会員情報を **データベース** から読み出す作りだが、つなぎに行く先の `webapp-db` が、まだ存在しないのだ。'),
        node('でーたべーす…データをしまっておく倉庫、ですよね？'),
        hakase('倉庫というより、整理された帳簿だな。何百万件の注文があっても、欲しい 1 件をすぐ引き出せるようにしまっておく仕組みだ。'),
        node('帳簿がないから、アプリが「注文どこ！？」ってパニックになってるんですね。'),
        hakase('うむ。今日はその帳簿を用意する。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('じゃあ EC2 をもう 1 台建てて、MySQL をインストールすればいいんですね！'),
        hakase('ほう。まいえすきゅーえる、が何かは知っておるのか。'),
        node('えっと…名前だけ…'),
        hakase('正直でよろしい。**MySQL** は世界中で使われておる、無料のデータベースソフトだ。データを **表 (テーブル)** の形でしまい、表と表を関係 (relation) でつなぐ。こういう DB を **RDB** (リレーショナルデータベース) という。'),
        node('Excel の表が何枚もあって、「注文」の表の会員番号から「会員」の表を引ける、みたいな感じですか。'),
        hakase('いい喩えだ。で、EC2 に MySQL を入れる案だが、出来なくはない。ただし OS のパッチ当て、毎晩のバックアップ、壊れたときの切り替え……全部、君がやることになる。'),
        node('ぱっち？'),
        hakase('OS やソフトの穴をふさぐ更新だ。当てないと攻撃され、当てると動かなくなることもある。深夜 2 時にパッチを当てて、朝まで DB が起きてこなかった男をワシは知っておる。'),
        node('…それ、博士ですよね。'),
        hakase('黙秘する。そこで **RDS** (Relational Database Service) だ。そういう面倒を AWS に任せられる、**マネージド** な RDB だ。'),
        node('まねーじど。「代わりに管理してもらえる」ってことですね。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('「データベースの作成」で決めることを見ておこう。まず **エンジンのタイプ**、つまりどの DB ソフトを使うか。今回は MySQL だ。次に **テンプレート**。'),
        node('てんぷれーと？ ひな形ですか？'),
        hakase('うむ。「本番稼働用」「開発/テスト」「無料利用枠」から選ぶと、それらしい初期値を入れてくれる。本番稼働用だと **マルチ AZ** などが最初から ON だ。'),
        node('まるち AZ？'),
        hakase('別の AZ に予備の DB (スタンバイ) を置いて、本体が止まったら自動で切り替える仕組みだ。安心だが、料金も倍近くになる。今回は練習だから無料利用枠でよい。'),
        node('**DB インスタンス識別子** は、DB の名前ですか？'),
        hakase('うむ。アプリは `webapp-db` を探しに行くから、必ず `webapp-db` にする。初期値の `database-1` のまま作ると、アプリは永遠に探し続けるぞ。'),
        node('表札を間違えた家には、郵便が届かないってことですね。**DB インスタンスクラス** の `db.t3.micro` は？'),
        hakase('Lesson 10 のインスタンスタイプの DB 版、CPU とメモリの大きさだ。それと、管理者用の **マスターパスワード** は 8 文字以上。`password` などと入れたら破門する。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('残りは置き場所と門番だ。DB は Private subnet に置く。そのために **DB サブネットグループ** を選ぶ。'),
        node('さぶねっとぐるーぷ？ Subnet を束ねたものですか？'),
        hakase('うむ。「DB を置いてよい Subnet の名簿」だ。2 つ以上の AZ の Subnet を入れる決まりがある。`private-subnet-1a` と `1c` を入れた `webapp-db-subnet-group` を用意しておいた。'),
        node('**パブリックアクセス** は？'),
        hakase('「なし」だ。「あり」にすると DB にパブリック IP が付き、インターネットから接続を試せる状態になる。帳簿を店先の歩道に置くようなものだ。'),
        node('最後の **VPC セキュリティグループ** は、DB の門番ですね。'),
        hakase('うむ。`db-sg` を選ぶ。`web-1` と `web-2` に付いておる `web-sg` から、TCP 3306 番だけを通すルールが入っておる。'),
        node('3306 番？'),
        hakase('MySQL の標準のポートだ。ソースが IP アドレスではなく `web-sg` になっておるのは、「`web-sg` を付けたサーバーからなら通す」という意味だ。この仕組みは次のレッスンで詳しく見る。'),
      ],
    },
    {
      type: 'table',
      title: '「データベースの作成」の主な設定',
      columns: ['設定', '今回の値', 'ポイント'],
      rows: [
        ['エンジンのタイプ', 'MySQL', 'どの DB ソフトを使うか'],
        ['テンプレート', '無料利用枠 (または 開発/テスト)', '本番稼働用 はマルチ AZ などが既定で ON'],
        ['DB インスタンス識別子', '`webapp-db`', 'アプリの接続先設定と合わせる (初期値 `database-1` のままにしない)'],
        ['VPC / DB サブネットグループ', '`webapp-vpc` / `webapp-db-subnet-group`', 'サブネットグループ = DB を置ける Subnet の集合 (2 AZ 以上)'],
        ['パブリックアクセス', '**なし**', 'DB をインターネットに出さない'],
        ['VPC セキュリティグループ', '`db-sg`', '`web-sg` からの TCP 3306 (MySQL) を許可済み'],
      ],
    },
    {
      type: 'exercise',
      title: 'Database を作成する',
      objective: '`webapp-db` (MySQL, db.t3.micro) を `webapp-vpc` の `webapp-db-subnet-group` に、パブリックアクセス **なし**、VPC セキュリティグループ `db-sg` で作成し、**利用可能** にする',
      tasks: [
        { id: 'open', title: 'RDS > データベース > **データベースの作成**', hint: 'Aurora and RDS の左メニュー「データベース」を開くと、一覧の右上に **データベースの作成** ボタンがあります。', hotspotId: 'rds-create', done: (c) => visited(c, '/rds/create') },
        { id: 'create', title: '設定して **データベースの作成**', hint: 'マスターパスワードは 8 文字以上。VPC セキュリティグループは default を外して `db-sg` を選びます。', hotspotId: 'rds-submit', done: (c) => !!dbNamed(c.env, 'webapp-db') },
        { id: 'available', title: 'ステータスが **利用可能** になるのを待つ', hint: '作成中 → バックアップ中 → 利用可能 と進みます。', done: (c) => dbNamed(c.env, 'webapp-db')?.status === 'available' },
      ],
      validate: (c) => {
        const db = dbNamed(c.env, 'webapp-db');
        if (!db) return ng(hakase('`webapp-db` が見つからん。**DB インスタンス識別子** を初期値の `database-1` のまま作っておらんか？ データベース一覧で名前を確かめるのだ。'));
        if (c.env.dbSubnetGroups.find((g) => g.dbSubnetGroupName === db.dbSubnetGroupName)?.vpcId !== vpcNamed(c.env, 'webapp-vpc')?.vpcId) return ng(hakase('`webapp-vpc` 以外に作られておる。「接続」の VPC で `webapp-vpc` を、DB サブネットグループで `webapp-db-subnet-group` を選ぶのだ。'));
        if (db.publiclyAccessible) return ng(hakase('パブリックアクセスが「あり」になっておる！ 本番の帳簿を歩道に置くでない。顧客情報が漏れたら、君の席ごと外に出ていくことになるぞ。'), node('データベースの「変更」で、パブリックアクセスを「なし」にすればいいんですね。'));
        if (!db.vpcSecurityGroupIds.includes(sgNamed(c.env, 'db-sg')?.groupId ?? '')) return ng(hakase('VPC セキュリティグループに `db-sg` が付いていない。初期値の default が残っておらんか？ データベースの「変更」で `db-sg` を付けるのだ。'));
        if (db.status !== 'available') return ng(hakase(`ステータスはまだ ${db.status} だ。作成中 → バックアップ中 → 利用可能 と進む。本物だと 10 分ほどかかるから、コーヒーを淹れに行くのが作法だ。`));
        return ok(
          hakase('DB ができた。**接続とセキュリティ** タブを見てみよ。**エンドポイント** が表示されておるはずだ。'),
          node('えんどぽいんと？ `webapp-db.` で始まる長い名前が出てます。'),
          hakase('DB の接続先の名前、つまり DB の DNS 名だ。ALB と同じで、IP アドレスではなく、この名前でつなぎに行く。'),
          node('DNS 名は住所、でしたね。アプリの接続先には、この住所を書いておくんですね。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'エンドポイントを確認してアプリの動作を見る',
      objective: '`webapp-db` のエンドポイントをコピーし、ブラウザで ALB にアクセスして `Database: connected` を確認する',
      tasks: [
        { id: 'endpoint', title: '接続とセキュリティタブの **エンドポイント** をコピー', hint: 'アプリの DB 接続先 (ホスト名) に設定する値です。', done: (c) => copied(c, dbNamed(c.env, 'webapp-db')?.endpointAddress) },
        { id: 'browse', title: 'ブラウザで ALB にアクセス → `Database: connected`', hint: 'ロードバランサー一覧で `web-alb` の DNS 名をコピーして「ブラウザ」タブで開きます。500 ではなく 200 になり、本文に `Database: connected` と出れば成功です。', done: (c) => lastAlbRequest(c)?.status === 200 },
      ],
      validate: (c) =>
        lastAlbRequest(c)?.body.includes('Database: connected')
          ? ok(
              node('500 だったのが 200 になりました！ `Database: connected` って出てます！'),
              hakase('EC2 から RDS への TCP 3306 が、`db-sg` で許可されておるからだ。アプリがエンドポイントの名前で、ちゃんと帳簿を探し当てたのだ。'),
              node('これで注文が消える心配はないですね！'),
              hakase('うむ。データを消すのは、いつだって DB ではなく人間だがな。'),
            )
          : ng(hakase('まだ `Database: connected` が表示されていない。DB のステータスが **利用可能** になっているかを確かめてから、ブラウザタブで ALB の DNS 名を開き直すのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。パブリックアクセスを **なし** にした RDS に、同じ VPC の EC2 から接続できるかな？'),
      options: ['できない', 'Security group で許可されていればできる'],
      answer: 1,
      explanation: [
        hakase('正解。パブリックアクセスは「インターネットから」つなげるかどうかの話だ。'),
        hakase('VPC の中からは、セキュリティグループが許せば接続できる。現に、さっき `web-1` がつながったろう。'),
        node('歩道には置かないけど、店の奥の人は読める帳簿ってことですね。'),
      ],
    },
  ],
};

export const lesson15: Lesson = {
  id: 'web-connectivity',
  number: '15',
  title: 'Web Application Connectivity',
  summary: 'Internet → ALB → EC2 → RDS の通信を 1 本ずつ説明できるようになる',
  minutes: 15,
  startPath: '/ec2/load-balancers',
  scenario: () => webAppEnv(),
  steps: [
    {
      type: 'dialogue',
      lines: [
        hakase('ノード君、ここまでで Web アプリの基本の形が揃った。お客さんのリクエストがどこを通って DB まで届くか、説明できるかな。'),
        node('えっと…インターネットから ALB に来て、ALB が EC2 に回して、EC2 が RDS に聞きに行く！'),
        hakase('雑だが合っておる。それを 3 つの **区間** に分けて考えるのだ。'),
        node('Internet → ALB、ALB → EC2、EC2 → RDS ですね。'),
        hakase('うむ。障害のときは「どの区間で止まったか」を切り分ける。全部を一度に疑うと、夜が明ける。'),
        node('経験者は語る、ですね。'),
        hakase('ワシは 3 回明けた。さて、下の図は今の環境をそのまま描いたものだ。**Live** とあるのは、設定を変えるとすぐ図に反映されるという意味だ。'),
      ],
    },
    { type: 'diagram', title: '現在の構成 (Live)', diagram: 'live' },
    {
      type: 'dialogue',
      lines: [
        hakase('通信が届くには、区間ごとに 2 つの関門がある。**ルーティング** と **セキュリティグループ** だ。'),
        node('ルーティングは Route table で「どっちへ送るか」、セキュリティグループは門番の「通すか通さないか」ですね。'),
        hakase('うむ。まず Internet → ALB。ALB の Subnet の Route table に `0.0.0.0/0 → IGW` が要る。Lesson 06 と 08 でやったな。'),
        node('ALB が Public subnet にいるのは、そのためでしたね。'),
        hakase('ALB → EC2 と EC2 → RDS は、どちらも VPC の中の通信だ。Route table の `local` のルートで届く。'),
        node('`10.0.0.0/16 → local` ですよね。VPC の中なら、どの Subnet にも届くルートです。'),
        hakase('よく覚えておった。この調子なら、ワシの給料を抜く日も……まあ、来ないな。'),
        node('天気予報は晴れですよ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('次にセキュリティグループだ。見るのは、それぞれ **受け側** のインバウンドルールだ。'),
        node('受け側だけでいいんですか？ 戻りの通信は？'),
        hakase('Lesson 09 でやったろう。セキュリティグループは **ステートフル** だ。'),
        node('あ、許可された通信への応答は、自動で通るんでしたね。'),
        hakase('うむ。そしてここからが本題だ。`web-sg` のソースは IP アドレスではなく、`alb-sg` というセキュリティグループになっておる。'),
        node('ソースにセキュリティグループ？ 住所じゃなくて、グループの名前ですか？'),
        hakase('「`alb-sg` を付けているものからなら通す」という意味だ。社員証で入館を許すようなものだな。住所録で許すと、引っ越すたびに書き換えが要る。'),
        node('なるほど！ で、`db-sg` のソースは `web-sg`。社員証の鎖ですね。'),
        hakase('うむ。ALB の社員証を持つ者だけが EC2 に入れ、EC2 の社員証を持つ者だけが DB に入れる。この後の表にある「MYSQL/Aurora」は、3306 番を開けるときにコンソールで選ぶルールのタイプ名だ。'),
        node('おーろら？'),
        hakase('AWS が作った、MySQL と互換性のある DB だ。同じ 3306 番を使うから、タイプ名でひとまとめにされておる。'),
      ],
    },
    {
      type: 'table',
      title: '区間ごとに必要な許可',
      columns: ['区間', 'ルーティング', 'セキュリティグループ (受け側のインバウンドルール)'],
      rows: [
        ['Internet → ALB (80)', 'ALB の Subnet に `0.0.0.0/0 → IGW`', '`alb-sg`: HTTP 80 / ソース `0.0.0.0/0`'],
        ['ALB → EC2 (3000)', 'VPC 内 `local`', '`web-sg`: TCP 3000 / ソース `alb-sg`'],
        ['EC2 → RDS (3306)', 'VPC 内 `local`', '`db-sg`: MYSQL/Aurora 3306 / ソース `web-sg`'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('サブネットをまたぐ通信は、ネットワーク ACL も通るんですよね？ Lesson 09-2 でやりました。'),
        hakase('その通り。ネットワーク ACL は Subnet の出入口に立つ、もう 1 人の門番だ。しかも **ステートレス**。'),
        node('行きと戻りを別々に許可しないといけないんでしたね。戻りは `1024-65535` のエフェメラルポートで。'),
        hakase('うむ。この VPC はどの Subnet も既定の全部許可の ACL だから通れる。だがカスタム ACL を付けたら、両方の Subnet で、リクエストと **戻り通信** の両方を許可せねばならん。'),
        node('片方だけ許可して、帰り道で迷子になるやつですね。'),
        hakase('そうだ。ではブラウザで ALB を開いて、「通信経路の診断」を読んでみよう。3 区間それぞれの判定と、「ネットワーク ACL」の行も並んでおる。'),
        node('503 のとき、どこで止まったか教えてくれたあの診断ですね。'),
      ],
    },
    {
      type: 'exercise',
      title: '通信経路の診断を読む',
      objective: 'ブラウザで ALB にアクセスし、「通信経路の診断」で 3 区間すべてが緑になっていることを確認する',
      tasks: [{ id: 'browse', title: 'ブラウザタブで `web-alb` にアクセス', hint: 'DNS 名はロードバランサー一覧でコピーできます。', done: (c) => lastAlbRequest(c)?.status === 200 }],
      validate: (c) =>
        lastAlbRequest(c)?.status === 200
          ? ok(
              hakase('診断を開くと、スキーム、ルートテーブル、リスナー、それに各セキュリティグループとネットワーク ACL の判定がずらりと並んでおるな。'),
              node('全部緑です！ 健康診断の結果表みたいですね。'),
              hakase('障害のときは、このどこかが赤くなる。赤い行が、君が今夜帰れない理由だ。'),
            )
          : ng(hakase('ALB へのアクセスがまだ 200 になっていない。ロードバランサー一覧で `web-alb` の DNS 名をコピーして、ブラウザタブで開くのだ。')),
    },
    {
      type: 'exercise',
      title: 'Security Group の鎖を辿る',
      objective: '`web-sg` の インバウンドルール の ソース (`alb-sg`) をリンクで開き、次に `db-sg` を開く',
      tasks: [
        { id: 'web', title: 'セキュリティグループで `web-sg` を開く', hint: 'EC2 の左メニュー「ネットワーク & セキュリティ」→「セキュリティグループ」で、セキュリティグループ名が `web-sg` の行の ID リンクをクリックします。', done: (c) => visitedId(c, '/security-groups/', sgNamed(c.env, 'web-sg')?.groupId) },
        { id: 'alb', title: 'インバウンドルールのソース `sg-... / alb-sg` のリンクを開く', hint: 'ソース列の セキュリティグループ ID はリンクになっています。', done: (c) => visitedId(c, '/security-groups/', sgNamed(c.env, 'alb-sg')?.groupId) },
        { id: 'db', title: '`db-sg` を開いて ソースが `web-sg` であることを確認', hint: 'セキュリティグループ一覧に戻って `db-sg` の ID リンクを開き、インバウンドルールの「ソース」列を見ます。', done: (c) => visitedId(c, '/security-groups/', sgNamed(c.env, 'db-sg')?.groupId) },
      ],
      validate: (c) =>
        visitedId(c, '/security-groups/', sgNamed(c.env, 'db-sg')?.groupId)
          ? ok(
              hakase('`alb-sg` → `web-sg` → `db-sg`。セキュリティグループをソースに指定して、**信頼の鎖** を作っておるのだ。'),
              node('ALB の社員証を持つ者だけが EC2 へ、EC2 の社員証を持つ者だけが DB へ、ですね。'),
              hakase('うむ。この鎖のどこかが切れると、504 や 500 が出る。それは次のトラブルシューティングのコースで、嫌というほど味わってもらう。'),
              node('嫌というほど…'),
            )
          : ng(hakase('まだ辿っていないセキュリティグループがある。`web-sg` のインバウンドルールの **ソース** 列にある `alb-sg` のリンクを押し、それからセキュリティグループ一覧で `db-sg` を開くのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。EC2 は Private subnet にいて、パブリック IP も持っておらん。なのに、インターネットのお客さんがアプリを使えるのはなぜかな？'),
      options: ['EC2 に Public IP があるから', 'Public subnet の ALB が受けて、VPC 内で EC2 に転送するから', 'RDS が中継しているから'],
      answer: 1,
      explanation: [
        hakase('正解。インターネットと直接話すのは ALB だけだ。'),
        hakase('ALB が表玄関で受け付け、VPC の中の `local` ルートで、奥の EC2 に取り次いでおる。'),
        node('受付係だけが表に出る、Lesson 11 の話ですね。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後の問題だ。`db-sg` のソースを IP アドレスではなく `web-sg` (セキュリティグループ ID) にする、一番の利点は？'),
      options: ['通信が速くなる', 'EC2 が増えたり IP が変わったりしても、ルールを変えずに済む', '料金が安くなる'],
      answer: 1,
      explanation: [
        hakase('その通り。「`web-sg` を付けたものなら誰でも」という意味になるから、EC2 が増えても、IP が変わっても、ルールはそのままでよい。'),
        hakase('後のレッスンでやる **Auto Scaling**、つまり負荷に合わせて EC2 の台数を自動で増減させる仕組みとも相性がよい。'),
        node('社員証方式なら、新入社員が来ても住所録を書き換えなくていいんですね。'),
      ],
    },
  ],
};
