import { hakase, ng, node, ok, type Lesson } from '../lesson/types';
import { runInstances } from '../sim/ec2';
import { byName } from '../sim/env';
import { CLIENT_IP } from '../sim/network';
import { webAppEnv } from '../sim/scenarios';
import { createSecurityGroup } from '../sim/sg';
import { lastRequestTo, sgAllows, sgNamed, visited } from './helpers';

export const lesson09: Lesson = {
  id: 'security-group',
  number: '09',
  title: 'Security Group',
  summary: 'インスタンスの前に立つ「許可リスト型」のファイアウォールを設定する',
  minutes: 25,
  startPath: '/console/home',
  scenario: () =>
    webAppEnv({ upTo: 'network' }, (env) => {
      const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
      const sg = createSecurityGroup(env, {
        groupName: 'web-server-sg',
        name: 'web-server-sg',
        description: 'Security group for web-server',
        vpcId,
        ingress: [{ ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: `${CLIENT_IP}/32`, description: 'SSH from my PC' }],
      });
      runInstances(env, { name: 'web-server', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', subnetId: byName(env.subnets, 'public-subnet-1a')!.subnetId, securityGroupIds: [sg], app: { port: 80, healthCheckPath: '/' } });
    }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、Security Group ってFirewallなんですか？'),
        hakase('藪から棒だな。どうした。'),
        node('`web-server` に Web サーバーのソフトを入れたのに、ブラウザで開くとずっと読み込み中で、最後はタイムアウトするんです。先輩に聞いたら「Security Group 見た？ あれ Firewall だから」って。'),
        hakase('先輩にしては珍しく正しいことを言う。で、ふぁいあうぉーるが何かは分かっておるのか？'),
        node('…燃える壁、ですか？'),
        hakase('直訳としては満点、エンジニアとしては零点だ。**Firewall** (ファイアウォール) は「防火壁」。火事が隣に燃え移らないようにする壁から来た名前で、通してよい通信だけを通し、それ以外を止める仕組みだ。'),
        node('通信の関所みたいなものですね。'),
        hakase('うむ。Security Group は AWS の**仮想**ファイアウォールだ。機械の箱ではなく、設定だけで存在する関所だな。'),
        node('Lesson 06 や Lesson 08 で「サーバーの前に立つ門番」って言ってたやつですね。'),
        hakase('そうだ。Security Group は、EC2 などの**ネットワークインターフェース** (サーバーがネットワークにつながる差込口) に付ける。ネットワークの境目ではなく、サーバー 1 台 1 台の前に立つ門番だ。'),
        node('大まかには Firewall ってことでいいんですね。'),
        hakase('大まかには、な。だが普通の Firewall とは違う癖がある。そこを知らんと、深夜に呼び出されるぞ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('違う癖って、なんですか？'),
        hakase('1 つ目。Security Group に書けるのは「**許可**」だけだ。「これは通すな」という拒否のルールは書けん。'),
        node('え、じゃあ悪い人を止められないじゃないですか。'),
        hakase('逆だ。どの許可ルールにも当てはまらん通信は、全部止まる。これを**暗黙の拒否**という。招待客リストに名前の無い者は、黙って門前払いだ。'),
        node('招待制のパーティーなんですね。僕、呼ばれたことないですけど。'),
        hakase('知っておる。2 つ目、ルールには順番が無い。全部のルールを見て、どれか 1 つにでも当てはまれば通す。'),
        node('3 つ目は？'),
        hakase('**ステートフル**だ。「状態 (state) を覚えている」という意味で、門番が「さっき通した客への返事だな」と覚えていて、戻りの通信は顔パスで通す。'),
        node('すてーとふる。行きを許可したら、帰りは勝手に通してくれるんですね。'),
        hakase('そうだ。ここで向きの言葉も覚えておけ。サーバーに入ってくる通信が**インバウンド**、サーバーから出ていく通信が**アウトバウンド**だ。ルールもそれぞれ別に書く。'),
        node('インバウンドが入り、アウトバウンドが出。…作った直後はどうなってるんですか？'),
        hakase('インバウンドはルール無し、つまり全部拒否。アウトバウンドは `0.0.0.0/0`、Lesson 06 でやった「すべての宛先」への通信が全部許可だ。表にまとめたから見ておけ。'),
      ],
    },
    {
      type: 'table',
      title: 'Security Group の性質',
      columns: ['性質', '意味'],
      rows: [
        ['許可ルールのみ', '書けるのは「許可」だけ。どのルールにも一致しない通信は拒否 (暗黙の拒否)'],
        ['ステートフル', '許可された通信の「戻り」は、反対方向のルールに関係なく自動で許可'],
        ['全ルールを評価', '順番は関係なく、どれか1つに一致すれば許可'],
        ['初期状態', 'インバウンド: ルールなし (全拒否) / アウトバウンド: 全許可 (`0.0.0.0/0`)'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('さて、君の症状だ。ブラウザが Web ページを取りに行くときは、**HTTP** という決まりごと (プロトコル) で、サーバーの **80 番ポート**に話しかける。'),
        node('ぽーと？'),
        hakase('サーバーの中の窓口の番号だ。80 番窓口は Web、22 番窓口は **SSH** (サーバーに遠隔でログインする仕組み)、という具合に番号で用件を分ける。**TCP** は、届いたか確かめながら運ぶ書留のような運び方の名前だと思っておけ。'),
        node('じゃあ、80 番窓口に誰も通されてないから、返事が来なくて**タイムアウト** (待ちくたびれて諦めること) してる…？'),
        hakase('ほう、推理が冴えておるな。明日は槍でも降るか。確かめるには、`web-server-sg` の**インバウンドルール**を見ればよい。'),
        node('セキュリティグループって、EC2 と VPC のどっちの画面にあるんですか？'),
        hakase('どちらにもある。入口が 2 つあるだけで、中身は同じものだ。今回は検索バーで「セキュリティグループ (VPC の機能)」を開く。'),
        hakase('直すときは「インバウンドのルールを編集」→「ルールを追加」で、**タイプ**に `HTTP`、**ソースタイプ** (誰からの通信を許可するか) に **Anywhere-IPv4** を選ぶ。Anywhere-IPv4 は `0.0.0.0/0`、つまり世界中の誰からでも、だ。'),
        node('世界中に開けちゃって大丈夫なんですか？'),
        hakase('Web サイトは誰にでも見てもらうものだから、80 番は開けてよい。だが今ある SSH のルールは消すなよ。あれは**マイ IP**、君の PC からだけに絞ってある。SSH を世界に開けたら、Lesson 01 のクイズのとおり君の責任だ。'),
        node('世界中から僕のサーバーにログインし放題…。考えただけで胃が痛いです。'),
      ],
    },
    {
      type: 'exercise',
      title: 'インバウンドルールに HTTP を許可する',
      objective: '`web-server-sg` に「HTTP (TCP 80) を Anywhere-IPv4 (`0.0.0.0/0`) から許可」する インバウンドルール を追加して保存する',
      tasks: [
        { id: 'open-sg', title: 'セキュリティグループの一覧を開く', hint: '上部の検索バー (Alt+S) に `security` と入力し、**セキュリティグループ (VPC の機能)** を選びます。', done: (c) => visited(c, /\/(vpc|ec2)\/security-groups$/) },
        { id: 'open-web-sg', title: '`web-server-sg` の詳細を開く', hint: '一覧の フィルターに `web-server` と入力して絞り込み、セキュリティグループ ID のリンクをクリックします。', done: (c) => visited(c, new RegExp(`/security-groups/${sgNamed(c.env, 'web-server-sg')?.groupId}`)) },
        { id: 'edit-inbound', title: '**インバウンドのルールを編集** を開く', hint: 'インバウンドルールタブの右上にあるボタンです。', hotspotId: 'sg-edit-inbound', done: (c) => visited(c, /edit-inbound/) },
        { id: 'add-http', title: '**ルールを追加** → タイプ: `HTTP` / ソースタイプ: `Anywhere-IPv4` にして **ルールを保存**', hint: '既存の SSH ルールは残したまま、**ルールを追加** で行を追加します。タイプを HTTP にするとポート範囲は自動で 80 になります。', hotspotId: 'sg-save-rules', done: (c) => sgAllows(c.env, 'web-server-sg', 80) },
      ],
      validate: (c) => {
        if (!sgAllows(c.env, 'web-server-sg', 80))
          return ng(hakase('まだ TCP 80 がインターネットから許可されていないようだ。招待客リストは白紙のままだぞ。'), hakase('「ルールを追加」で、タイプを `HTTP`、ソースタイプを **Anywhere-IPv4** (`0.0.0.0/0`) にして **ルールを保存** を押したかな？'));
        if (sgAllows(c.env, 'web-server-sg', 22, { ip: '192.0.2.99' }))
          return ng(
            hakase('HTTP は開いたが…SSH (22) まで全世界に開いておるぞ。世界中の攻撃者に合鍵を配ってどうする。'),
            node('あ、SSH の行を書き換えちゃったかも…'),
            hakase('「インバウンドのルールを編集」で SSH の行のソースタイプを **マイ IP** に戻し、HTTP は **ルールを追加** で別の行にするのだ。'),
          );
        return ok(
          hakase('よし、インバウンドルールに HTTP が追加された。SSH は君の PC だけ、HTTP は世界中の誰でも、という使い分けだ。'),
          node('招待客リストに「Web を見たい方はどなたでも」って書き足した感じですね。'),
          hakase('うむ。SSH の欄に「どなたでも」と書く者は、翌朝には自分の席が「どなたでも」座れる状態になっておる。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('アウトバウンドルールは触ってないですけど、Web ページの返事はちゃんとサーバーから出ていけるんですか？'),
        hakase('そこがステートフルの出番だ。インバウンドで許可した通信への**応答**は、アウトバウンドルールに関係なく自動で通る。'),
        node('門番が「さっき通した客への返事だな」って覚えてるから、でしたよね。'),
        hakase('うむ。ノード君が 10 分前の話を覚えておるとは。揮発性メモリにしては上出来だ。'),
        node('10 分くらいは持ちます！'),
        hakase('では、実際にブラウザで確かめよう。EC2 のサーバー 1 台 1 台を**インスタンス**と呼ぶ。インスタンスの一覧で `web-server` の「**パブリック IPv4 アドレス**」を見つけ、横のコピーアイコンでコピーするのだ。'),
        node('パブリック IPv4 アドレスって、Lesson 06 の Public IP、インターネットから見える住所でしたよね。'),
        hakase('そうだ。それをパネル上部の「ブラウザ」タブの URL 欄に貼り付けて、「移動」を押す。'),
        node('何が出たら成功ですか？'),
        hakase('**HTTP 200** だ。200 は、サーバーの「はい、どうぞ」という返事の番号、**ステータスコード**だ。失敗したら「通信経路の診断」を開けば、どこで止まったか分かる。'),
        node('失敗する前提みたいに言わないでください。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ブラウザで web-server を開く',
      objective: '`web-server` の Public IPv4 address をコピーし、ブラウザタブでアクセスして HTTP 200 を確認する',
      tasks: [
        { id: 'find-ip', title: 'EC2 > インスタンス で `web-server` の **パブリック IPv4 アドレス** を確認してコピー', hint: '検索バーで `EC2` → インスタンス。パブリック IPv4 アドレスの横のコピーアイコンを押します。', done: (c) => c.copied.includes(byName(c.env.instances, 'web-server')?.publicIpAddress ?? '-') },
        { id: 'browse', title: 'パネルの「ブラウザ」タブに `http://<Public IP>` を貼り付けて **移動**', hint: 'URL 欄に貼り付け (Ctrl+V) て「移動」を押します。', done: (c) => lastRequestTo(c, byName(c.env.instances, 'web-server')?.publicIpAddress)?.status === 200 },
      ],
      validate: (c) => {
        const r = lastRequestTo(c, byName(c.env.instances, 'web-server')?.publicIpAddress);
        if (!r) return ng(hakase('まだ `web-server` の Public IP にアクセスしていないようだ。EC2 のインスタンス一覧でパブリック IPv4 アドレスをコピーし、「ブラウザ」タブに貼り付けて「移動」を押すのだ。'));
        if (r.status !== 200) return ng(hakase(`結果は ${r.error ?? r.status} だったな。「通信経路の診断」を開いて、どこで止まったか見てみるのだ。インバウンドルールに HTTP (80) が残っているかも確かめるのだぞ。`));
        return ok(
          node('開きました！ HTTP 200 です！ タイムアウト地獄から生還しました！'),
          hakase('うむ。それが Security Group の基本だ。「誰から (ソース)・どのポートへ」を許可リストで書く。書いていない者は通さん。'),
          node('招待客リスト、ですね。'),
          hakase('そうだ。リストに書き忘れた客は、たとえ社長でも門前払いだ。…そのとき社長からの電話を取るのは君だぞ。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。`web-server-sg` のアウトバウンドルールを全部削除したとする。ブラウザからの HTTP アクセスはどうなるかな？'),
      options: ['レスポンスが返せなくなり、タイムアウトする', 'Inbound で許可済みなので、レスポンスは返る (ステートフル)', 'Security Group が無効になり、全通信が許可される'],
      answer: 1,
      explanation: [
        hakase('正解だ。Security Group はステートフルだから、インバウンドで許可した接続の戻り通信は、アウトバウンドルールを見ない。'),
        node('ただし、サーバーのほうから外へ**新しく**通信を始めるときは、アウトバウンドの許可が要るんですね。'),
        hakase('その通り。アウトバウンドを空にすると、サーバーから外への新しい通信、たとえばソフトの更新のダウンロードは止まる。'),
      ],
      wrong: [hakase('ヒントは表の 2 行目、「ステートフル」だ。門番は、さっき通した客への返事をどう扱うのだったかな？')],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('まとめよう。Security Group は「許可のみ」「ステートフル」「全ルールを評価」。そして、どれにも当てはまらない通信は暗黙の拒否だ。'),
        node('招待客リスト、帰りは顔パス、順番なし、リストに無い人は門前払い。'),
        hakase('…最後のたとえが雑だが、まあよい。もう 1 つ。ソースには CIDR だけでなく、**別の Security Group** も指定できる。'),
        node('別の Security Group？ 住所じゃなくて、門番を指定するんですか？'),
        hakase('「この Security Group が付いているサーバーからなら通してよい」と書けるのだ。サーバーが入れ替わって住所が変わっても、ルールを書き直さずに済む。社員証で入館を許可するようなものだな。'),
        node('住所で 1 人ずつ許可するより、社員証で許可するほうが楽ってことですね。'),
        hakase('そうだ。これは ALB と EC2 をつなぐときに大活躍する。後のレッスンで、ID を Copy & Paste しながら体験しよう。'),
        node('次の Lesson 09-2 は、Subnet の入口に立つ門番、ネットワーク ACL でしたよね。'),
        hakase('うむ。門番が 2 人になると、揉めごとも 2 倍だ。覚悟しておけ。'),
      ],
    },
  ],
};
