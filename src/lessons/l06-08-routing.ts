import { hakase, ng, node, ok, type Lesson } from '../lesson/types';
import { byName } from '../sim/env';
import { webAppEnv } from '../sim/scenarios';
import type { DiagramSpec } from '../diagram/spec';
import { effectiveRouteTable, replaceRoutes, setSubnetAssociations } from '../sim/vpc';
import { isSubnetPublic, rtNamed, subnetNamed, visited, visitedId, vpcNamed } from './helpers';

const internetPath: DiagramSpec = {
  groups: [
    { id: 'vpc', label: 'VPC webapp-vpc (10.0.0.0/16)', kind: 'vpc' },
    { id: 'pub', label: 'Public subnet (0.0.0.0/0 → IGW)', kind: 'public-subnet', parent: 'vpc' },
    { id: 'priv', label: 'Private subnet (local only)', kind: 'private-subnet', parent: 'vpc' },
  ],
  nodes: [
    { id: 'users', label: 'Internet', icon: 'users' },
    { id: 'igw', label: 'Internet gateway', sublabel: 'webapp-igw', icon: 'internetGateway', parent: 'vpc' },
    { id: 'web', label: 'Web server', sublabel: 'public-subnet-1a', icon: 'ec2Instance', parent: 'pub' },
    { id: 'app', label: 'App server', sublabel: 'private-subnet-1a', icon: 'ec2Instance', parent: 'priv' },
  ],
  edges: [
    { id: 'e1', source: 'users', target: 'igw', label: '0.0.0.0/0', status: 'connected' },
    { id: 'e2', source: 'igw', target: 'web', label: 'route あり', status: 'connected' },
    { id: 'e3', source: 'web', target: 'app', label: 'local', status: 'neutral' },
  ],
};

export const lesson06: Lesson = {
  id: 'public-private-subnet',
  number: '06',
  title: 'Public / Private Subnet',
  summary: 'Public subnet は名前ではなく Route table で決まる',
  minutes: 20,
  startPath: '/vpc/subnets',
  scenario: () => webAppEnv({ upTo: 'network' }, (env) => replaceRoutes(env, byName(env.routeTables, 'public-rt')!.routeTableId, [])),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、先輩に「`public-subnet-1a` って本当に Public になってる？」って聞かれました。名前に public って付けたんだから、Public ですよね？'),
        hakase('Lesson 05 の最後のクイズで、君は何と答えたかな？'),
        node('えーと…「いいえ、Internet gateway への route が無いので」。あっ。'),
        hakase('正解を選んでおいて、中身は覚えておらんとは。君の記憶は揮発性メモリか。電源を切ると消えるタイプの。'),
        node('寝たらリセットされるタイプです。…で、名前じゃないなら何で決まるんですか？'),
        hakase('まず名前の話だ。Subnet の名前は、Lesson 03 で VPC に付けたのと同じ**名前タグ** (Name タグ)、ただの名札だ。AWS は名札を読んで通信を決めたりはせん。'),
        node('名札に「社長」って書いても、社長にはなれないってことですね。'),
        hakase('そういうことだ。君がそれをやったら、ワシは名札ごと君の席を片付けるがな。'),
        hakase('決めるのは **Route table**、画面では「ルートテーブル」だ。Subnet から出ていく**パケット** (通信のデータを小分けにした小包) に、「この宛先ならこの出口へ行け」と教える道案内の表だ。'),
        node('るーとてーぶる…。Lesson 03 で VPC と一緒に自動で作られてた、あれですか？'),
        hakase('ほう、そこは覚えておったか。あれは**メインルートテーブル**という特別な 1 枚だ。その話は後でする。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('もう 1 つの主役が **Internet gateway**、略して **IGW** だ。VPC とインターネットの間の出入口だな。'),
        node('いんたーねっとげーとうぇい。Lesson 03 のクイズで「VPC を作っても自動では作られない」ほうでしたよね。'),
        hakase('うむ。ゲートウェイは「門」だ。自分で作って VPC に**アタッチ** (取り付け) するまで、VPC は外と無縁の閉じた箱だ。作り方は Lesson 08 でやる。'),
        node('先輩は「IGW の `webapp-igw` も、ルートテーブルの `public-rt` も作っておいた」って言ってました。'),
        hakase('門を建てても、道案内の表に「外へ行くなら門へ」と書かなければ誰も通らん。立派な門の前に草が生えるだけだ。'),
        node('観光名所にはなりそうですね。'),
        hakase('そこで定義だ。**Public subnet とは「IGW への route を持つ Route table に関連付いた Subnet」**のこと。それ以外は全部 **Private subnet** だ。'),
        node('るーと？ かんれんづけ？'),
        hakase('**route** (ルート) は表の 1 行、「この宛先 → この出口」の組だ。**関連付け**は「この Subnet はこの表を使う」という紐付けで、Subnet は必ずどれか 1 枚の表を使う。'),
        node('つまり、Subnet ごとに道案内の表が 1 枚決まっていて、その表に門への道が書いてあれば Public、ってことですね。'),
        hakase('今日はずいぶん冴えておるな。雪でも降るのか。図で確かめよう。'),
      ],
    },
    { type: 'diagram', title: 'Public subnet と Private subnet', diagram: internetPath },
    {
      type: 'dialogue',
      lines: [
        node('図の Public subnet に「0.0.0.0/0 → IGW」ってあります。ぜろてんぜろ…すらっしゅぜろ？'),
        hakase('Lesson 04 のプレフィックス長を思い出せ。`/16` は先頭 16 ビットが固定だったな。では `/0` は？'),
        node('固定が 0 ビット…。どんなアドレスでも当てはまる、ですか？'),
        hakase('そうだ。`0.0.0.0/0` は「すべての宛先」、要するに「どこか外の世界」だ。'),
        node('Private subnet の「local only」は？'),
        hakase('**local** は「VPC の CIDR (`10.0.0.0/16`) 宛なら、VPC の中で届ける」という route だ。どの Route table にも最初から入っていて、消せん。だから図の Web server と App server は、Public と Private に分かれていても local で話せる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('次の表には「NAT」「ALB」「踏み台」「RDS」…知らない単語のバーゲンセールです。'),
        hakase('一言ずつ片付ける。**ALB** は外からのリクエストを受けて奥のサーバーに振り分ける受付係 (Lesson 11 でやる)。**踏み台**は、外から中のサーバーに入るための中継サーバーだ。どちらも外の客と会うから Public に置く。'),
        hakase('**NAT Gateway** は、Private subnet から外へ「出るだけ」の片道の出口だ。今は名前だけでよい。**EC2** (AWS の仮想サーバー) で動くアプリや **RDS** (AWS のデータベース) は、外から直接触られたくないから Private に置く。'),
        node('データベースを Public に置いちゃったら？'),
        hakase('全世界に顧客名簿を配ることになる。そのときの始末書は、厚さで電話帳が作れるぞ。'),
        node('「Public IP と Security Group の許可が必要」っていうのは？'),
        hakase('**Public IP** はインターネットから見えるサーバーの住所、**Security Group** はサーバーの前に立つ門番だ (Lesson 09 でやる)。道があっても、住所が無ければ届かんし、門番が通さねば入れん。'),
      ],
    },
    {
      type: 'table',
      title: 'Public subnet と Private subnet',
      columns: ['', 'Public subnet', 'Private subnet'],
      rows: [
        ['Route table', '`0.0.0.0/0 → igw-...` がある', '`local` だけ (または `0.0.0.0/0 → NAT Gateway`)'],
        ['インターネットから直接', '到達できる (Public IP と Security Group の許可が必要)', '到達できない'],
        ['置くもの', 'ALB、NAT Gateway、踏み台', 'アプリの EC2、RDS'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('では、`public-subnet-1a` が本当はどの Route table を使っているか、画面で調べよう。'),
        node('先輩を信じないんですか？'),
        hakase('「作っておいた」を信じて本番が止まった話なら、障害報告書が 3 冊書ける。確かめるのだ。'),
        hakase('サブネット一覧で `public-subnet-1a` を開き、詳細の「ルートテーブル」のリンクをたどる。ルートテーブルの「**ルート**」タブに、**送信先** (宛先) と **ターゲット** (出口) の組が並んでおる。'),
        node('送信先が宛先で、ターゲットが出口。了解です！'),
      ],
    },
    {
      type: 'exercise',
      title: 'Subnet の Route table を調べる',
      objective: '`public-subnet-1a` が使っているルートテーブルと、そのルートを確認する',
      tasks: [
        { id: 'subnet', title: 'サブネット一覧で `public-subnet-1a` の詳細を開く', hint: 'サブネット一覧のフィルターに `public` と入れて絞り込み、サブネット ID をクリックします。', done: (c) => visitedId(c, '/vpc/subnets/', subnetNamed(c.env, 'public-subnet-1a')?.subnetId) },
        { id: 'rt', title: 'ルートテーブルのリンクから `public-rt` を開く', hint: '詳細の **ルートテーブル** の値がリンクになっています。', done: (c) => visitedId(c, '/vpc/route-tables/', rtNamed(c.env, 'public-rt')?.routeTableId) },
      ],
      validate: (c) =>
        visitedId(c, '/vpc/route-tables/', rtNamed(c.env, 'public-rt')?.routeTableId)
          ? ok(
              hakase('ルートタブを見てみろ。`10.0.0.0/16 → local` の 1 行しかない。VPC の中への道しか書いておらんのだ。'),
              node('`webapp-igw` は VPC にアタッチ済みなのに、表に門への道が無いから誰も通らない…。先輩の「作っておいた」は半分だけだったんですね。'),
              hakase('門を建てて満足して帰る。よくある話だ。では道を書き足そう。「**ルートを編集**」→「**ルートを追加**」で、送信先に `0.0.0.0/0`、ターゲットに `webapp-igw` を選んで「**変更を保存**」だ。'),
              node('ターゲットの欄には何て打てばいいんですか？'),
              hakase('IGW の ID は `igw-` で始まる。欄をクリックすれば候補が出るから、名前が `webapp-igw` のものを選べ。'),
            )
          : ng(hakase('まだ `public-rt` の詳細画面を開いていないようだ。`public-subnet-1a` の詳細にある「ルートテーブル」の値がリンクになっておる。そこをクリックするのだ。迷子になるのはパケットだけで十分だ。')),
    },
    {
      type: 'exercise',
      title: '0.0.0.0/0 → Internet gateway を追加する',
      objective: '`public-rt` に 送信先 `0.0.0.0/0`、ターゲット `webapp-igw` の route を追加して保存し、Private → Public に変える',
      tasks: [
        { id: 'edit', title: 'ルートタブの **ルートを編集** を開く', hint: 'public-rt 詳細の ルートタブ右上にあります。', hotspotId: 'rt-edit-routes', done: (c) => visited(c, /\/edit-routes/) },
        { id: 'add', title: '**ルートを追加** → 送信先 `0.0.0.0/0` / ターゲット: インターネットゲートウェイ `webapp-igw` → **変更を保存**', hint: 'ターゲットの入力欄をクリックすると igw- の候補が出ます。', hotspotId: 'rt-save-routes', done: (c) => isSubnetPublic(c.env, 'public-subnet-1a') },
      ],
      validate: (c) => {
        if (!isSubnetPublic(c.env, 'public-subnet-1a'))
          return ng(hakase('まだ `public-subnet-1a` に Internet gateway への道が無い。送信先 `0.0.0.0/0` とターゲット `webapp-igw` を入れて、**変更を保存** を押したかな？ 書いただけで出さない手紙は、届かんぞ。'));
        if (isSubnetPublic(c.env, 'private-subnet-1a'))
          return ng(hakase('む、private-subnet まで Public になっておる。メインルートテーブル (`private-rt`) に道を書いていないか？'), hakase('ルートテーブル一覧で `private-rt` を開き、「ルートを編集」で `0.0.0.0/0` の行を削除するのだ。道を書くのは `public-rt` だけだ。'));
        return ok(
          hakase('よし、`public-rt` に `0.0.0.0/0 → webapp-igw` が入って、ステータスは「アクティブ」だ。これで `public-subnet-1a` は **Private → Public** になった。'),
          node('`public-subnet-1c` はどうなるんですか？ 触ってないですけど。'),
          hakase('`public-subnet-1c` も同じ `public-rt` に関連付いておるから、一緒に Public になった。表を 1 枚直せば、その表を使う Subnet が全部変わる。'),
          node('便利だけど、間違えたら全部まとめて壊れるってことですね。'),
          hakase('そうだ。ワシが昔、表 1 枚で Subnet を 20 個道連れにした話は…また今度にしよう。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('でも博士、`0.0.0.0/0` は「すべての宛先」なんですよね。じゃあ VPC の中宛のパケットも、`10.0.0.0/16 → local` と `0.0.0.0/0 → igw` のどっちにも当てはまっちゃいませんか？'),
        hakase('いいところに気づいた。今日の君は本物か？ 中身が入れ替わっておらんか？'),
        node('本物です。失礼な。'),
        hakase('Route table は、当てはまる route が複数あるとき、**いちばん長く一致する** route を選ぶ。**ロンゲストプレフィックスマッチ** (longest prefix match) という。'),
        node('ろんげすと…ぷれふぃっくす…まっち？'),
        hakase('プレフィックス長の数字が大きい、つまり範囲が狭くて具体的な route ほど優先、ということだ。住所なら「東京都」より「東京都新宿区西新宿 2 丁目」のほうが正確だろう？'),
        node('宛先 `10.0.12.5` なら、`/16` の local にも `/0` にも当てはまるけど、`/16` のほうが長いから local。'),
        hakase('そうだ。ではインターネットのどこか、例えば `203.0.113.10` 宛なら？'),
        node('`10.0.0.0/16` には入らないから、当てはまるのは `0.0.0.0/0` だけ。IGW 行きです！'),
        hakase('正解だ。`0.0.0.0/0` は「ほかのどれにも当てはまらなかったときの行き先」で、**デフォルトルート**とも呼ぶ。'),
        node('最後の砦ですね。'),
        hakase('砦というより落とし物の集積所だな。行き先の分からんパケットは、全部そこへ送られる。'),
        node('そういえば、`private-subnet-1a` はどの表を使ってるんですか？'),
        hakase('どの表とも関連付けを指定していないから、**メインルートテーブル**の `private-rt` を使っておる。メインは「指定の無い Subnet が自動で使う表」、Lesson 03 で VPC と一緒に作られたあれだ。詳しくは次の Lesson 07 でやる。'),
        node('さっき「後でする」って言ってた話ですね。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では確認だ。`public-rt` には `10.0.0.0/16 → local` と `0.0.0.0/0 → igw` がある。宛先 `10.0.12.5` のパケットは、どこへ行くかな？'),
      options: ['Internet gateway', 'local (VPC 内)', '破棄される'],
      answer: 1,
      explanation: [
        hakase('正解。`/16` にも `/0` にも当てはまるが、プレフィックスが長い `/16` の local が勝つ。VPC の中宛のパケットが、インターネットへ迷い出ることはない。'),
        node('`10.0.12.5` って、よく見たら `private-subnet-1c` (`10.0.12.0/24`) の中のアドレスですね。'),
        hakase('よく見ておるな。同じ VPC の中の相手だから、当然 local で届くわけだ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後だ。`public-rt` は直した。では今、`private-subnet-1a` は Public かな？'),
      options: ['Public (同じ VPC だから)', 'Private (main route table に IGW への route が無いから)'],
      answer: 1,
      explanation: [
        hakase('その通り。`private-subnet-1a` が使うメインルートテーブル `private-rt` には local しかない。同じ VPC でも、使う表が違えば Public と Private に分かれるのだ。'),
        node('名札じゃなくて、道案内の表で決まる。今度こそ覚えました！'),
        hakase('その「今度こそ」を、ワシは何度聞いたことか。'),
      ],
    },
  ],
};

export const lesson07: Lesson = {
  id: 'route-table',
  number: '07',
  title: 'Route Table',
  summary: 'Subnet と Route table の関連付け、main route table の役割',
  minutes: 15,
  startPath: '/vpc/route-tables',
  scenario: () =>
    webAppEnv({ upTo: 'network' }, (env) => {
      // Someone "temporarily" associated the private subnet with the public route table.
      const rt = byName(env.routeTables, 'public-rt')!;
      setSubnetAssociations(env, rt.routeTableId, [...rt.associations.filter((a) => a.subnetId).map((a) => a.subnetId!), byName(env.subnets, 'private-subnet-1a')!.subnetId]);
    }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、大変です！ セキュリティ診断で「DB (データベース) を置く予定の `private-subnet-1a` が、インターネットに出られる状態です」って指摘されました！'),
        hakase('ほう。金庫を置く部屋の窓が全開というわけか。DB を入れる前に見つかってよかったな。入れた後なら、今ごろ君の席は窓際どころか窓の外だ。'),
        node('怖いこと言わないでください。でも `private-subnet-1a` なんて、誰も触ってないはずですよ？'),
        hakase('「誰も触っていないはず」は、障害報告書でいちばんよく見る一文だ。Lesson 06 を思い出せ。Public か Private かは何で決まった？'),
        node('名札じゃなくて Route table、でしたよね。Subnet が使う道案内の表に `0.0.0.0/0 → IGW` の route があれば Public。'),
        hakase('うむ。では、Subnet と表の紐付けは何と呼んだかな？'),
        node('関連付け、でしたよね。Subnet は必ずどれか 1 枚の表を使う。'),
        hakase('ほう、前回の話がまだ頭に残っておる。君の頭も捨てたものではないな。'),
        node('捨てる予定があったんですか…。'),
        hakase('今日はその関連付けを掘り下げる。関連付けには 2 種類ある。**明示的な関連付け**と、**暗黙の関連付け**だ。'),
        node('めいじてき？ あんもく？'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('**明示的** (explicit) は、Route table に「この Subnet はこの表を使え」と名指しで登録すること。**暗黙** (implicit) は、名指しされていない Subnet が自動で**メインルートテーブル** (main route table) を使うことだ。'),
        node('メインルートテーブル。Lesson 03 で VPC と一緒に作られて、Lesson 06 で `private-rt` のことだって出てきましたね。'),
        hakase('そうだ。VPC に 1 枚だけある「指定が無ければこれを使え」という既定の表だ。会社で言えば、配属先の決まっていない新人がとりあえず放り込まれる総務部だな。'),
        node('僕、入社したとき総務部でした。'),
        hakase('知っておる。だからこのたとえにした。'),
        node('ひどい。…じゃあ `private-subnet-1a` は誰にも名指しされてないから、メインの `private-rt` を使ってるはずですよね？'),
        hakase('「はず」だな。画面でどう見えるかは次の表のとおりだ。ルートテーブルの詳細の「**サブネットの関連付け**」タブに、一覧が 2 つ出る。'),
      ],
    },
    {
      type: 'table',
      title: 'Subnet と Route table の関係',
      columns: ['関連付け', '意味', 'Console での見え方'],
      rows: [
        ['明示的 (explicit)', 'Route table に Subnet を名指しで直接関連付ける', 'Route table の サブネットの関連付け > 明示的なサブネットの関連付け'],
        ['暗黙 (main)', '明示的な関連付けが無い Subnet は main を使う', 'main の サブネットの関連付け > 明示的な関連付けのないサブネット'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('名指しされた Subnet はその表の「明示的なサブネットの関連付け」に、名指しされてない Subnet はメインの表の「明示的な関連付けのないサブネット」に出るんですね。'),
        hakase('そうだ。では `private-subnet-1a` がどの表を使っているか、今度は Subnet の側から調べよう。サブネットの詳細の「ルートテーブル」に、いま使っている表が出る。'),
        node('調べるまでもなく `private-rt` ですよ。賭けてもいいです。'),
        hakase('ほう、何を賭ける？'),
        node('…今月の給料で。'),
        hakase('君の給料なら、負けても誰も困らん額だな。よし、見てみるのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '原因を調べる',
      objective: '`private-subnet-1a` がどの Route table に関連付いているか確認する',
      tasks: [
        { id: 'subnet', title: 'サブネット一覧で `private-subnet-1a` を開く', hint: 'サブネット一覧をフィルターで `private` と絞り込みます。', done: (c) => visitedId(c, '/vpc/subnets/', subnetNamed(c.env, 'private-subnet-1a')?.subnetId) },
      ],
      validate: (c) =>
        visitedId(c, '/vpc/subnets/', subnetNamed(c.env, 'private-subnet-1a')?.subnetId)
          ? ok(
              hakase('ルートテーブルが `public-rt` になっておる。誰かが「ちょっとだけ」と名指しで関連付けて、戻し忘れたのだろう。'),
              node('「一時的に」って、いちばん信用できない言葉ですね…。だから `0.0.0.0/0 → igw` の道が使えて、Public になっちゃってたんですね。'),
              hakase('そして賭けは君の負けだ。給料は…まあ、取っても誤差だな。'),
              node('誤差って言わないでください！'),
              hakase('では直すぞ。サブネットの詳細の「アクション」から「**ルートテーブルの関連付けを編集**」を開き、ルートテーブル ID で `private-rt` を選んで保存する。'),
            )
          : ng(hakase('まず `private-subnet-1a` の詳細画面を開くのだ。サブネット一覧のフィルターに `private` と入れて、サブネット ID のリンクをクリックする。')),
    },
    {
      type: 'exercise',
      title: 'private-subnet-1a を private-rt に戻す',
      objective: '`private-subnet-1a` の関連付けを `private-rt` (main route table) に戻し、Private subnet にする',
      tasks: [
        { id: 'edit', title: 'サブネット詳細の アクション → **ルートテーブルの関連付けを編集** を開く', hint: 'ルートテーブルタブの **ルートテーブルの関連付けを編集** ボタンからも開けます。public-rt 側の **サブネットの関連付けを編集** でチェックを外す方法でも OK です。', done: (c) => visited(c, /edit-route-table-association|edit-subnet-associations/) },
        { id: 'save', title: 'ルートテーブル ID で `private-rt` を選んで **保存**', hint: 'private-rt はメインルートテーブルです。選ぶと下にルート (local のみ) が表示されます。', done: (c) => !isSubnetPublic(c.env, 'private-subnet-1a') },
      ],
      validate: (c) => {
        if (isSubnetPublic(c.env, 'private-subnet-1a'))
          return ng(hakase('まだ `private-subnet-1a` が Public のままだ。窓は全開だぞ。ルートテーブル ID で `public-rt` ではなく `private-rt` を選んで、**保存** を押したか確かめるのだ。'));
        if (!isSubnetPublic(c.env, 'public-subnet-1a') || !isSubnetPublic(c.env, 'public-subnet-1c'))
          return ng(hakase('今度は public-subnet が Private になってしまったぞ。窓を閉めるついでに玄関まで塞いでどうする。'), hakase('`public-rt` の「サブネットの関連付け」タブで、`public-subnet-1a` と `public-subnet-1c` が残っているか確かめるのだ。'));
        const rt = effectiveRouteTable(c.env, subnetNamed(c.env, 'private-subnet-1a')!.subnetId);
        return ok(
          hakase(`よし、\`private-subnet-1a\` は ${rt.associations.some((a) => a.main) ? 'main route table (private-rt)' : 'private な route table'} を使う Private subnet に戻った。窓は閉まったぞ。`),
          node('`public-subnet-1a` と `1c` は Public のまま。直すべきところだけ直せました！'),
          hakase('うむ。診断の担当者には「関連付けを戻しました」と報告しておけ。始末書にならずに済んで、よかったな。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。この VPC に新しい Subnet を作ったとする。作った直後、その Subnet はどの Route table を使うかな？'),
      options: ['public-rt', 'メインルートテーブル (private-rt)', 'どれにも関連付かない'],
      answer: 1,
      explanation: [
        hakase('正解。作った直後は誰にも名指しされていないから、暗黙の関連付けでメインルートテーブルを使う。'),
        hakase('だからメインルートテーブルには、IGW への route を**入れない**のが安全な設計だ。うっかり作った Subnet が、勝手にインターネットへ窓を開けないようにな。'),
        node('新人はまず総務部から。外回りは名指しされてから、ですね。'),
      ],
    },
  ],
};

export const lesson08: Lesson = {
  id: 'internet-gateway',
  number: '08',
  title: 'Internet Gateway',
  summary: 'VPC とインターネットの出入口を作ってつなぐ',
  minutes: 20,
  startPath: '/vpc/igws',
  scenario: () => webAppEnv({ upTo: 'network', noInternetGateway: true }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、`public-rt` に `0.0.0.0/0` の route を書こうとしたら、ターゲットの入力欄に `igw-` の候補が 1 つも出てきません！'),
        hakase('当然だ。この VPC には、まだ Internet gateway が無い。'),
        node('え、Lesson 06 のときはあったじゃないですか。`webapp-igw`。'),
        hakase('あれは先輩が作っておいたものだ。今回は君が自分で作る。いつまでも先輩のおさがりで生きていけると思うな。'),
        node('おさがりって言い方…。改めて、Internet gateway って VPC とインターネットの出入口、でしたよね。'),
        hakase('うむ、略して IGW。Lesson 03 のクイズのとおり、VPC を作っても自動では付いてこない。門の無い城で「外へは門から」と道案内を書いても、その先は壁で行き止まりだ。'),
        node('だから候補が出なかったんですね。やることは IGW を作るだけですか？'),
        hakase('3 つだ。「作る」「VPC に**アタッチ** (取り付け) する」「Route table に道を書く」。3 つだ。'),
        node('なんで 2 回言ったんですか。…でも出入口が 1 つだけって、そこが壊れたら終わりじゃないですか？'),
        hakase('いい心配だ。IGW は 1 つの VPC に 1 つしかアタッチできんが、AWS が裏で**冗長化** (予備を用意して、壊れても動き続けるように) してあり、通信量に合わせて勝手に広がる。'),
        node('じゃあ、そこだけ止まって全部止まる…みたいな弱点にはならない？'),
        hakase('そういう弱点を**単一障害点**と呼ぶが、IGW はそうならん。AWS が面倒を見る**マネージド**な部品だからな。君が面倒を見る部品だったら、ワシは夜も眠れん。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('IGW を作って道を書けば、もうインターネットにつながるんですか？'),
        hakase('甘い。インターネットとつながるには、条件が 4 つそろわねばならん。次の表だ。'),
        node('「リソースが Public IP を持っている」…。Public IP は Lesson 06 で出た、インターネットから見えるサーバーの住所でしたよね。'),
        hakase('そうだ。EC2 なら「**パブリック IP の自動割り当て**」を有効にすると、起動するときに住所が付く。住所の無いサーバーには、道があっても手紙は届かん。'),
        node('「Security Group (と NACL)」の NACL は？ なっくる？'),
        hakase('**ネットワーク ACL** (Access Control List、許可リスト) の略だ。Security Group がサーバーの前に立つ門番なら、NACL は Subnet の入口に立つ門番だ。Security Group は Lesson 09、NACL は Lesson 09-2 でやる。'),
        node('門番が 2 人…。どっちかが寝てたら通れちゃうんですか？'),
        hakase('逆だ。どちらか 1 人でも「通さん」と言えば通れん。今日はそのうち、門と道の 2 つだけをやる。'),
      ],
    },
    {
      type: 'table',
      title: 'インターネットにつながるための条件',
      columns: ['条件', 'どこで設定するか'],
      rows: [
        ['VPC に Internet gateway がアタッチされている', 'VPC > インターネットゲートウェイ'],
        ['Subnet の Route table に `0.0.0.0/0 → igw-...` がある', 'VPC > ルートテーブル > ルートを編集'],
        ['リソースが Public IP を持っている', 'EC2 の「パブリック IP の自動割り当て」など'],
        ['Security Group (と NACL) が通信を許可している', 'VPC / EC2 > セキュリティグループ'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('では門を作ろう。インターネットゲートウェイの画面で作成する。名前タグは Lesson 03 の VPC と同じ要領で、`webapp-igw` だ。'),
        node('作ったらすぐ使えるんですか？'),
        hakase('作った直後の状態は **Detached** (どこにも付いていない)。門を建てただけで、城壁にはめ込んでいない状態だ。「VPC にアタッチ」して **Attached** になって、初めて門になる。'),
        node('でたっち、あたっち。付いてない、付いてる、ですね。'),
        hakase('うむ。作っただけで満足して帰るのは、先輩の悪い癖だ。君は真似するなよ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'IGW を作成して VPC にアタッチする',
      objective: '名前タグ `webapp-igw` のインターネットゲートウェイを作成し、`webapp-vpc` にアタッチする',
      tasks: [
        { id: 'create', title: 'インターネットゲートウェイ > **インターネットゲートウェイの作成**', hint: '一覧右上のボタンです。', hotspotId: 'igw-create', done: (c) => visited(c, '/vpc/igws/create') },
        { id: 'named', title: '名前タグ `webapp-igw` で作成', hint: '名前タグ を入力して **インターネットゲートウェイの作成**。作成直後の状態は **Detached** です。', done: (c) => !!byName(c.env.internetGateways, 'webapp-igw') },
        { id: 'attach', title: 'アクション → **VPC にアタッチ** で `webapp-vpc` にアタッチ', hint: '画面上部の緑のバナーの **VPC へアタッチ** からも行けます。使用可能な VPC の入力欄をクリックすると候補が出ます。', hotspotId: 'igw-actions', done: (c) => byName(c.env.internetGateways, 'webapp-igw')?.attachments[0]?.vpcId === vpcNamed(c.env, 'webapp-vpc')?.vpcId },
      ],
      validate: (c) => {
        const g = byName(c.env.internetGateways, 'webapp-igw');
        if (!g) return ng(hakase('`webapp-igw` という名前の IGW が見つからん。インターネットゲートウェイの一覧で、名前タグのつづりを確かめるのだ。名前の誤字は、深夜の障害対応でしか笑えんぞ。'));
        if (g.attachments[0]?.vpcId !== vpcNamed(c.env, 'webapp-vpc')?.vpcId)
          return ng(hakase('`webapp-igw` はできたが、まだ `webapp-vpc` にアタッチされていないようだ。アクション → **VPC にアタッチ** で `webapp-vpc` を選び、状態が **Attached** になるか確かめるのだ。'));
        return ok(
          hakase('状態が **Attached** になった。これで webapp-vpc に門が付いたぞ。'),
          node('やった！ これでインターネットにつながりますね！'),
          hakase('さっきの表を 2 秒で忘れたのか。門はできたが、`public-rt` にはまだ門への道が書いてない。'),
          node('あ、3 つのうち 2 つしか終わってない…。次は `public-rt` の **ルートを編集** で、`0.0.0.0/0` → `webapp-igw` ですね。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'public-rt に IGW への route を追加する',
      objective: '`public-rt` に `0.0.0.0/0 → webapp-igw` を追加し、public-subnet を Public にする',
      tasks: [
        { id: 'edit', title: 'ルートテーブルで `public-rt` を開き **ルートを編集**', hint: 'ルートテーブル一覧で public-rt を選び、アクション → ルートを編集 でも開けます。', hotspotId: 'rt-edit-routes', done: (c) => visited(c, /\/edit-routes/) },
        { id: 'save', title: '`0.0.0.0/0` → インターネットゲートウェイ `webapp-igw` で **変更を保存**', hint: 'ターゲットの候補に Attached と表示される IGW を選びます。', hotspotId: 'rt-save-routes', done: (c) => isSubnetPublic(c.env, 'public-subnet-1a') },
      ],
      validate: (c) =>
        isSubnetPublic(c.env, 'public-subnet-1a') && isSubnetPublic(c.env, 'public-subnet-1c')
          ? ok(
              hakase('これで `public-subnet-1a` / `1c` がインターネットへの道を持った。作る・アタッチする・道を書く、3 つそろったな。'),
              node('今度はターゲットの候補に `webapp-igw` が出ました。門と道がそろって、やっと Public です！'),
              hakase('うむ。ただし、表の残り 2 つ、Public IP と門番の話が残っておるのを忘れるな。'),
            )
          : ng(hakase('まだ public-subnet に IGW への道が無いな。`public-rt` の「ルートを編集」で、送信先 `0.0.0.0/0`、ターゲットに Attached の `webapp-igw` を選び、**変更を保存** を押したか確かめるのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('逆に、IGW を VPC から外したらどうなるんですか？ **デタッチ**っていうんですよね。'),
        hakase('うむ。デタッチしても、`public-rt` の `0.0.0.0/0 → igw` の行は消えずに残る。'),
        node('残るなら、そのまま使えるんじゃないですか？'),
        hakase('行き先の門がもう無いのだぞ。ルートの「ステータス」列が **ブラックホール** になり、そこへ向かうパケットは黙って捨てられる。'),
        node('ぶらっくほーる。吸い込まれて二度と出てこない…。'),
        hakase('エラーも返さずに消えるから、たちが悪い。ワシは若いころ、深夜にこれで 3 時間溶かした。吸い込まれたのはパケットだけではない。ワシの睡眠もだ。'),
        node('博士の睡眠はどうでもいいですけど、うっかりデタッチしたら大惨事じゃないですか。'),
        hakase('どうでもよくはない。…まあよい。AWS もそこは考えておって、Public IP を持つ EC2 や、インターネット向け (internet-facing) の ALB が VPC にある間は、デタッチを拒否する。'),
        node('拒否されると、どうなるんですか？'),
        hakase('`DependencyViolation` というエラーが返る。「まだそれに頼っているものがあるぞ」という意味だ。事故を防ぐ安全装置だな。'),
        node('安全装置に怒られるうちが花、ですね。'),
        hakase('そういうことだ。安全装置を外してまで消した者の始末書は、ワシが赤ペンで添削してやろう。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('問題だ。IGW を VPC からデタッチすると、`public-rt` の `0.0.0.0/0 → igw` ルートはどうなるかな？'),
      options: ['自動で削除される', 'ステータスが ブラックホール になり、パケットは破棄される', '別の IGW に自動で切り替わる'],
      answer: 1,
      explanation: [
        hakase('正解。行は勝手には消えん。ルートタブの「ステータス」列が赤い「ブラックホール」になっておったら、ターゲットがもう存在しない合図だ。'),
        node('「インターネットにつながらない」ときは、ステータス列も見る。覚えました！'),
      ],
    },
  ],
};
