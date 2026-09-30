import { hakase, ng, node, ok, type Lesson } from '../lesson/types';
import { runInstances } from '../sim/ec2';
import { byName } from '../sim/env';
import { createNetworkAcl, evaluateNacl, replaceNetworkAclEntries, setNaclSubnetAssociations } from '../sim/nacl';
import { canConnectFromInternet, CLIENT_IP } from '../sim/network';
import { webAppEnv } from '../sim/scenarios';
import { createSecurityGroup } from '../sim/sg';
import type { AwsEnv } from '../sim/types';
import { albReachesWeb, allTargetsHealthy, copied, lastAlbRequest, lastRequestTo, naclNamed, subnetNamed, visited, visitedId, webReachesDb } from './helpers';

const tcp = (ruleNumber: number, fromPort: number, toPort: number, cidrBlock: string) => ({ ruleNumber, protocol: 'tcp' as const, fromPort, toPort, cidrBlock, ruleAction: 'allow' as const });
const webServer = (env: AwsEnv) => byName(env.instances, 'web-server');
const webServerReachable = (env: AwsEnv) => {
  const i = webServer(env);
  return !!i && canConnectFromInternet(env, i.instanceId, 'tcp', 80).ok;
};

export const lessonNacl: Lesson = {
  id: 'network-acl',
  number: '09-2',
  title: 'Network ACL',
  summary: 'サブネットの出入口に立つ、ステートレスなファイアウォール',
  minutes: 25,
  startPath: '/ec2/instances',
  scenario: () =>
    webAppEnv({ upTo: 'network' }, (env) => {
      const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
      const sg = createSecurityGroup(env, {
        groupName: 'web-server-sg',
        name: 'web-server-sg',
        description: 'HTTP from anywhere, SSH from my PC',
        vpcId,
        ingress: [
          { ipProtocol: 'tcp', fromPort: 80, toPort: 80, source: '0.0.0.0/0', description: 'HTTP' },
          { ipProtocol: 'tcp', fromPort: 22, toPort: 22, source: `${CLIENT_IP}/32`, description: 'SSH from my PC' },
        ],
      });
      runInstances(env, { name: 'web-server', imageId: 'ami-0d52744d6551d851e', instanceType: 't3.micro', keyName: 'webapp-key', subnetId: byName(env.subnets, 'public-subnet-1a')!.subnetId, securityGroupIds: [sg], app: { port: 80, healthCheckPath: '/' } });
      // Someone "hardened" the public subnets: inbound HTTP/SSH only, and no outbound rules at all.
      const acl = createNetworkAcl(env, { vpcId, name: 'public-nacl' });
      replaceNetworkAclEntries(env, acl, false, [tcp(100, 80, 80, '0.0.0.0/0'), tcp(110, 22, 22, `${CLIENT_IP}/32`)]);
      setNaclSubnetAssociations(env, acl, ['public-subnet-1a', 'public-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId));
    }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、Lesson 09 で `web-server-sg` に HTTP を許可して、ブラウザで 200 が返りましたよね。'),
        hakase('うむ。君が珍しく一発で成功した、記念すべき日だ。'),
        node('珍しくは余計です。…その `web-server` が、今朝また開かないんです。ずっと読み込み中で、最後は**タイムアウト**。Security Group は触ってないのに。'),
        hakase('タイムアウト、つまり返事を待ちくたびれて諦めた、か。そういえば昨夜、セキュリティ担当が「public subnet を硬くしておきました」と得意げに言っておったな。'),
        node('硬く？ サブネットって冷やすと固まるんですか？'),
        hakase('豆腐ではない。サブネットに**ネットワーク ACL** を付けた、という意味だ。'),
        node('ねっとわーく えーしーえる？'),
        hakase('ACL は Access Control List、「アクセス制御のリスト」だ。誰を通して誰を止めるかを書いた名簿だな。'),
        node('あ、Lesson 08 の「インターネットにつながるための条件」の表に、「Security Group (と NACL)」ってカッコ書きで載ってました。'),
        hakase('よく覚えておったな。NACL は Network ACL の略だ。カッコの中に押し込められていた日陰者が、今日の主役というわけだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('Security Group と何が違うんですか？ どっちもファイアウォールですよね。'),
        hakase('立っている場所が違う。Security Group は、インスタンス 1 台 1 台の前に立つ門番だったな。'),
        node('はい。Lesson 09 で「インスタンスの前に立つ許可リスト」って習いました。'),
        hakase('ネットワーク ACL は**サブネットの出入口**に立つ関所だ。サブネットに出入りする通信を、まとめて調べる。'),
        node('マンションで言うと、Security Group が各部屋の鍵で、ネットワーク ACL がエントランスのオートロック、みたいな？'),
        hakase('ほう、今日は冴えておるな。ただしこのオートロックは、とんでもなく物覚えが悪い。'),
        node('物覚え？'),
        hakase('ネットワーク ACL は**ステートレス**だ。ステート (state) は「状態」。やり取りの状態を覚えていない、という意味だ。'),
        node('Security Group は**ステートフル**でしたよね。行きを許可したら、その戻りは自動で通してくれる。'),
        hakase('そうだ。ところがステートレスな関所は、出ていく返事を見て「お前は誰だ。名簿に無いから通さん」と言う。さっき自分で通した客への返事なのに、だ。'),
        node('それ、博士がいつも僕に言う「君の記憶は揮発性メモリか」ってやつじゃないですか。'),
        hakase('関所のほうがまだマシだ。あれは仕様だが、君のはバグだからな。'),
      ],
    },
    {
      type: 'table',
      title: 'Security Group とネットワーク ACL',
      columns: ['', 'Security Group', 'ネットワーク ACL'],
      rows: [
        ['適用先', 'ENI (インスタンス、ALB、RDS など)', 'サブネット (出入りする通信)'],
        ['状態', 'ステートフル: 戻り通信は自動で許可', '**ステートレス**: 戻り通信にも許可ルールが必要'],
        ['ルール', '許可のみ', '**許可と拒否**'],
        ['評価', '全ルールのどれかに一致すれば許可', '**ルール番号の小さい順**に評価し、最初に一致したルールで決定'],
        ['既定', '新規作成時は Inbound なし', 'デフォルト ACL は全許可 / 新規作成したカスタム ACL は**全拒否**'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('表の「ENI」って何ですか？ えにー？'),
        hakase('Elastic Network Interface。インスタンスに挿さっている仮想の LAN カードだ。Security Group は、実はインスタンス本体ではなくこの ENI に付いておる。'),
        node('ALB とか RDS も書いてありますけど…'),
        hakase('どちらも後のレッスンで作る、ロードバランサーとデータベースだ。今は「EC2 以外にも ENI を持つものがある」とだけ覚えておけばよい。'),
        node('「ルール番号の小さい順に評価し、最初に一致したルールで決定」っていうのは？'),
        hakase('ネットワーク ACL のルールには 100、110 のような番号が付いておる。関所の役人は番号の小さい順に名簿を読み、最初に当てはまった行で「許可」か「拒否」かを即決する。'),
        node('残りの行は読まないんですか？'),
        hakase('読まん。お役所仕事の鑑だ。だから Security Group と違って「拒否」も書けるし、書く順番がすべてになる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('最後の「デフォルト ACL は全許可、カスタム ACL は全拒否」は？'),
        hakase('VPC を作ると、ネットワーク ACL も 1 つ自動で作られる。Lesson 03 のクイズで「自動では作られないもの」を選んだとき、ネットワーク ACL は作られる側だったな。'),
        node('はい、作られないのはインターネットゲートウェイでした。'),
        hakase('その自動で作られるのが**デフォルト ACL** で、中身は全部許可だ。自分で新しく作った**カスタム ACL** は、最初は全部拒否。どの行にも当てはまらない通信は、名簿の最後にある `*` の行で拒否される。'),
        node('`*`…あすたりすく？'),
        hakase('そう、「その他全部」の行だ。消すこともできない、関所の最後の番人だな。'),
        hakase('さて、`web-server` のいる public subnet には、`public-nacl` というカスタム ACL が付いておるらしい。だが中身を見る前に、まず症状を自分の目で確かめる。障害対応の第一歩だ。'),
        node('他人の「開きません」を鵜呑みにするな、ってことですね。'),
        hakase('特に君の「開きません」はな。EC2 の `web-server` の**パブリック IPv4 アドレス**をコピーして、パネルの「ブラウザ」タブで開いてみよ。'),
      ],
    },
    {
      type: 'exercise',
      title: '症状を確認する',
      objective: '`web-server` のパブリック IPv4 アドレスをブラウザで開き、タイムアウトすることを確認する',
      tasks: [
        { id: 'copy', title: 'EC2 > インスタンスで `web-server` の **パブリック IPv4 アドレス** をコピー', hint: 'パブリック IPv4 アドレスの横のコピーアイコン。', done: (c) => copied(c, webServer(c.env)?.publicIpAddress) },
        { id: 'browse', title: '「ブラウザ」タブに貼り付けて **移動**', hint: 'URL 欄には IP アドレスだけを貼れば OK です (`http://` は省略可)。「応答時間が長すぎます」と表示されれば症状の再現です。', done: (c) => !!lastRequestTo(c, webServer(c.env)?.publicIpAddress) },
      ],
      validate: (c) => {
        const r = lastRequestTo(c, webServer(c.env)?.publicIpAddress);
        if (!r) return ng(hakase('まだ web-server にアクセスしていないようだ。EC2 > インスタンスで `web-server` のパブリック IPv4 アドレスをコピーし、「ブラウザ」タブに貼り付けて **移動** を押すのだ。'));
        if (r.error !== 'ERR_CONNECTION_TIMED_OUT') return ng(hakase(`結果は ${r.error ?? r.status} だったな。開いたのは web-server のパブリック IPv4 アドレスかな？ コピーし直して、もう一度試すのだ。`));
        return ok(
          hakase('タイムアウトだ。`ERR_CONNECTION_TIMED_OUT` は、返事を待ちくたびれたブラウザが諦めた、という意味だ。'),
          node('門前払いなら「拒否しました」って言ってくれればいいのに。'),
          hakase('ネットワーク ACL は、拒否したパケットを黙って捨てる。返事が無いから、ブラウザは待ち続けるしかないのだ。'),
          hakase('ブラウザの下にある「通信経路の診断」を見てみよ。通信がどこで息絶えたかを書いた検死報告書だ。学習用の機能だから、本物の AWS にはこんな親切なものは無いがな。'),
          node('言い方…あ、Security Group は緑なのに、**ネットワーク ACL** の「戻り通信」が赤くなってます！'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'ネットワーク ACL を調べる',
      objective: 'VPC > ネットワーク ACL で `public-nacl` を開き、インバウンドルールとアウトバウンドルールを見比べる',
      tasks: [
        { id: 'list', title: 'VPC > **ネットワーク ACL** を開く', hint: '検索バーに `network acl` と入力するか、VPC の左メニュー「セキュリティ」から。', done: (c) => visited(c, '/vpc/network-acls') },
        { id: 'open', title: '`public-nacl` を開いてアウトバウンドルールタブを見る', hint: 'ネットワーク ACL ID のリンクをクリックします。', done: (c) => visitedId(c, '/vpc/network-acls/', naclNamed(c.env, 'public-nacl')?.networkAclId) },
      ],
      validate: (c) =>
        visitedId(c, '/vpc/network-acls/', naclNamed(c.env, 'public-nacl')?.networkAclId)
          ? ok(
              node('インバウンドはルール 100 で HTTP、110 で SSH を許可してます。でもアウトバウンドは `*` の拒否しかない！'),
              hakase('そう。ブラウザからのリクエストはサブネットに入れるが、web-server の**返事がサブネットから出られない**のだ。'),
              node('入口の関所は通してくれたのに、出口で「名簿に無い」って止められてるんですね。'),
              hakase('「必要なものだけ許可しました」のつもりで、帰り道を書き忘れたわけだ。片道切符のサブネットの完成だな。'),
            )
          : ng(hakase('`public-nacl` の詳細をまだ開いていないようだ。ネットワーク ACL の一覧で `public-nacl` を探し、ネットワーク ACL ID のリンクを押すのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('じゃあアウトバウンドに HTTP (80) を足せばいいんですか？ 入口が 80 なら、出口も 80 ですよね。'),
        hakase('惜しい。いや、惜しくもない。返事の宛先ポートは 80 ではない。'),
        node('えっ、でも Web サーバーは 80 番で待ってるんですよね？'),
        hakase('80 番は web-server 側の受付窓口の番号だ。ブラウザ側も、自分の番号札を持って接続してくる。返事はその番号札の番号に宛てて送られる。'),
        node('番号札？'),
        hakase('**エフェメラルポート**だ。ephemeral は「つかの間の」「はかない」という意味。接続のたびに OS が一時的に選ぶポート番号だ。'),
        node('はかないポート…なんだか僕の給料みたいですね。'),
        hakase('君の給料は、はかないのではなく最初から少ないのだ。'),
        node('ひどい。…で、そのはかない番号って何番なんですか？'),
        hakase('OS によって違う。Windows や macOS は 49152〜65535、Linux は 32768〜60999。後で習う ALB は 1024〜65535 を使う。'),
        node('バラバラじゃないですか。'),
        hakase('だから戻り通信用のアウトバウンドには、まとめて **TCP 1024-65535** を許可するのが定番だ。0〜1023 は 80 や 22 のような「よく知られたポート」で、番号札には使われない。'),
        node('「ポート範囲」には `1024-65535` ってハイフンでつないで書けばいいんですね。'),
        hakase('そうだ。タイプはポートを自分で決める「カスタム TCP」、送信先はブラウザがどこから来るか分からんから `0.0.0.0/0`、そして「許可」だ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'アウトバウンドルールで戻り通信を許可する',
      objective: '`public-nacl` のアウトバウンドルールに「ルール番号 100 / カスタム TCP / ポート範囲 `1024-65535` / 送信先 `0.0.0.0/0` / 許可」を追加する',
      tasks: [
        { id: 'edit', title: 'アウトバウンドルールタブの **アウトバウンドルールを編集**', hint: '`public-nacl` の詳細で「アウトバウンドルール」タブを選ぶと、ルール表の右上にボタンがあります。一覧でチェックを付けて「アクション」メニューから開くこともできます。', hotspotId: 'nacl-edit-outbound', done: (c) => visited(c, new RegExp(`${naclNamed(c.env, 'public-nacl')?.networkAclId}/edit-outbound`)) },
        { id: 'add', title: '**新しいルールを追加** → `100` / カスタム TCP / `1024-65535` / `0.0.0.0/0` / 許可 → **変更を保存**', hint: 'ポート範囲は `1024-65535` のように開始と終了をハイフンでつなぎます。', hotspotId: 'nacl-save-rules', done: (c) => webServerReachable(c.env) },
      ],
      validate: (c) => {
        if (!webServerReachable(c.env)) return ng(hakase('まだ戻り通信が通らない。まさか 80 番を足したのではあるまいな？ 返事の宛先はブラウザのエフェメラルポート (49152〜65535) だ。「通信経路の診断」で、どのポートが拒否されているか見てみよ。'));
        const acl = naclNamed(c.env, 'public-nacl')!;
        const tooOpen = evaluateNacl(acl, true, 'tcp', [22, 22], '192.0.2.10').allowed;
        return ok(
          hakase('よし、戻り通信が許可された。これで web-server の返事がサブネットから出ていける。'),
          node('行きはインバウンドの 80、帰りはアウトバウンドの 1024-65535。関所には行きと帰りの両方の名簿が要るんですね。'),
          ...(tooOpen ? [hakase('ただし今のルールはポートを絞っていないな。動きはするが、名簿に「誰でもどこへでも」と書いたのと同じだ。戻り通信用ならエフェメラルポート (1024-65535) に絞るのが基本だ。')] : []),
          hakase('次にセキュリティ担当が「硬くしておきました」と言ってきたら、帰り道はあるのか聞き返してやるのだな。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '復旧を確認する',
      objective: 'ブラウザで `web-server` を開き、HTTP 200 を確認する',
      tasks: [{ id: 'browse', title: 'ブラウザで web-server にアクセス → **200**', hint: '「ブラウザ」タブで web-server のパブリック IPv4 アドレスのまま、もう一度 **移動** を押します。結果が `HTTP 200 OK` になれば復旧です。', done: (c) => lastRequestTo(c, webServer(c.env)?.publicIpAddress)?.status === 200 }],
      validate: (c) =>
        lastRequestTo(c, webServer(c.env)?.publicIpAddress)?.status === 200
          ? ok(
              node('開きました！ 200 です！'),
              hakase('症状を確かめ、関所の名簿を調べ、帰り道を足して、もう一度確かめる。障害対応はいつもこの順番だ。'),
              node('今日は障害報告書を書かずに済みそうですね。'),
              hakase('書くとしたら、題名は「帰り道を忘れた関所」だな。'),
            )
          : ng(hakase('最新のアクセスがまだ 200 ではない。「ブラウザ」タブで web-server のアドレスのまま、もう一度 **移動** を押すのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。インバウンドルールが「100: すべてのトラフィック 0.0.0.0/0 拒否」「200: HTTP 0.0.0.0/0 許可」のとき、HTTP は通るかな？'),
      options: ['通る (許可ルールがあるから)', '通らない (番号の小さいルール 100 で先に拒否される)'],
      answer: 1,
      explanation: [
        hakase('正解。ネットワーク ACL は番号の小さい順に読んで、最初に一致した行で決まる。100 番の「全部拒否」に当たった時点でおしまいだ。200 番は読まれもしない。'),
        node('だからルール番号は 100, 200… と間を空けて付けるんですね。あとで間に割り込ませられるように。'),
        hakase('そういうことだ。Security Group の「どれか一致すれば許可」と混ぜて覚えると、深夜に呼び出されることになるぞ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では、同じサブネットにある EC2 どうしの通信に、ネットワーク ACL は適用されるかな？'),
      options: ['適用される', '適用されない (サブネットの出入りだけが対象)'],
      answer: 1,
      explanation: [
        hakase('正解。関所はサブネットの出入口に立っておる。同じサブネットの中の通信は関所を通らないから、Security Group だけで決まる。'),
        node('マンションの中で部屋から部屋へ行くのに、エントランスのオートロックは関係ない、と。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後の問題だ。特定の攻撃元 IP (`203.0.113.66`) だけをサブネット全体でブロックしたい。使うのはどちら？'),
      options: ['Security Group に拒否ルールを書く', 'ネットワーク ACL に小さい番号の拒否ルールを書く'],
      answer: 1,
      explanation: [
        hakase('正解。Security Group には拒否ルールが書けない。「特定の相手だけ拒否」は、拒否が書けるネットワーク ACL の出番だ。今ある許可ルールより小さい番号で書けば、先に止められる。'),
        node('普段もネットワーク ACL で細かく守ったほうが安全じゃないですか？'),
        hakase('普段はデフォルトの全許可 ACL のまま、Security Group で細かく許可する。関所で全員の荷物を開けていたら、日が暮れるうえに今日みたいな帰り道の書き忘れが起きるからな。'),
      ],
    },
  ],
};

export const lessonNaclTroubleshooting: Lesson = {
  id: 'nacl-troubleshooting',
  number: '16-2',
  title: 'Network ACL Troubleshooting',
  summary: 'Security Group は正しいのに 504。ステートレスな ACL の戻り通信を疑う',
  minutes: 20,
  startPath: '/ec2/load-balancers',
  scenario: () =>
    webAppEnv({}, (env) => {
      const vpcId = byName(env.vpcs, 'webapp-vpc')!.vpcId;
      const acl = createNetworkAcl(env, { vpcId, name: 'private-nacl' });
      replaceNetworkAclEntries(env, acl, false, [tcp(100, 3000, 3000, '10.0.0.0/16'), tcp(110, 3306, 3306, '10.0.0.0/16'), tcp(120, 1024, 65535, '10.0.0.0/16')]);
      // Outbound was written as "only what the app sends": MySQL and HTTPS. The return traffic was forgotten.
      replaceNetworkAclEntries(env, acl, true, [tcp(100, 3306, 3306, '10.0.0.0/16'), tcp(110, 443, 443, '0.0.0.0/0')]);
      setNaclSubnetAssociations(env, acl, ['private-subnet-1a', 'private-subnet-1c'].map((n) => byName(env.subnets, n)!.subnetId));
    }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、また **504 Gateway Time-out** です…'),
        hakase('またか。君はよほど 504 に好かれておるな。'),
        node('好かれたくないです。でも今回は、`web-sg` も `db-sg` も昨日ちゃんと確認しました！ ALB からの 3000 も、web-sg からの 3306 も許可されてます。'),
        hakase('ほう。Lesson 16 で懲りたか。'),
        node('懲りました。504 は「中継役の ALB が、Target の返事を待ちくたびれた」でしたよね。'),
        hakase('うむ。そして Security Group は正しい、と。では、ほかに何か変わったことは？'),
        node('そういえば、セキュリティ担当の人が「private subnet を強化しておきました」って、すごくいい笑顔で言ってました。'),
        hakase('その笑顔、Lesson 09-2 でも見た気がするな。'),
        node('あっ…public subnet に**ネットワーク ACL** を付けて、帰り道を書き忘れたやつ！'),
        hakase('そうだ。サブネットの出入口に立つ関所だったな。今度は private subnet に関所が立ったらしい。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ネットワーク ACL は**ステートレス**でしたよね。行きを通しても、戻りの返事はまた別に名簿で調べられる。'),
        hakase('正解だ。今日は雪どころか槍が降るかもしれん。'),
        node('素直に褒めてください。'),
        hakase('褒めるのは直してからだ。今回は登場人物が多い。ALB は public subnet、EC2 と RDS は private subnet にいる。'),
        node('ALB → EC2 も、EC2 → RDS も、サブネットをまたぐんですね。'),
        hakase('そうだ。関所をまたぐ通信は全部、行きと戻りの両方の名簿が要る。1 本でも帰り道が無ければ Timeout だ。'),
        node('疑うところが一気に増えましたね…'),
        hakase('だから順番を守る。まず症状、次に Target のヘルス、それから EC2 がいるサブネットの関所だ。ブラウザで ALB を開いて 504 を確かめ、`web-tg` の**ヘルスステータスの詳細**を読むのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '症状とターゲットのヘルスを確認する',
      objective: 'ブラウザで 504 を確認し、`web-tg` のターゲットの **ヘルスステータスの詳細** を見る',
      tasks: [
        { id: 'browse', title: 'ブラウザで ALB にアクセス → **504**', hint: 'ロードバランサー一覧の DNS 名をコピーして貼り付けます。', done: (c) => lastAlbRequest(c)?.status === 504 },
        { id: 'tg', title: '`web-tg` のターゲットタブを開く', hint: 'EC2 の左メニュー「ロードバランシング」→「ターゲットグループ」で `web-tg` の名前をクリックします。「ヘルスステータスの詳細」列に異常の理由が出ます。', done: (c) => visitedId(c, '/ec2/target-groups/', 'web-tg') },
      ],
      validate: (c) =>
        lastAlbRequest(c)?.status === 504 && visitedId(c, '/ec2/target-groups/', 'web-tg')
          ? ok(
              node('`Request timed out` です。Lesson 16 とまったく同じ顔をしてます。'),
              hakase('Timeout はネットワークで止まっている合図だ。Security Group が正しいなら、次に疑うのは**サブネットのネットワーク ACL** だ。'),
              node('`web-1` がいるのは `private-subnet-1a` ですよね。そこの関所を見に行きます。'),
              hakase('web-1 の詳細にある「サブネット ID」のリンクから辿れる。サブネットの詳細には「ネットワーク ACL」タブがあって、付いている関所の名簿がそのまま読めるのだ。'),
            )
          : ng(hakase('504 の確認と、ターゲットタブの確認の両方をするのだ。ブラウザで ALB の DNS 名を開き、それからターゲットグループ `web-tg` の「ターゲット」タブを見るのだ。')),
    },
    {
      type: 'exercise',
      title: 'EC2 のサブネットのネットワーク ACL を調べる',
      objective: '`web-1` がいる `private-subnet-1a` の **ネットワーク ACL** タブで、インバウンドとアウトバウンドのルールを確認する',
      tasks: [
        { id: 'subnet', title: 'VPC > サブネットで `private-subnet-1a` を開く', hint: 'EC2 の web-1 詳細の「サブネット ID」リンクからも辿れます。', done: (c) => visitedId(c, '/vpc/subnets/', subnetNamed(c.env, 'private-subnet-1a')?.subnetId) },
        { id: 'acl', title: '**ネットワーク ACL** タブ (または `private-nacl` の詳細) を開く', hint: 'サブネット詳細の「ネットワーク ACL」タブに、インバウンドルールとアウトバウンドルールが並びます。行きの通信と戻りの通信のポートが、それぞれ許可されているか見比べましょう。', done: (c) => visited(c, /tab=network-acl/) || visitedId(c, '/vpc/network-acls/', naclNamed(c.env, 'private-nacl')?.networkAclId) },
      ],
      validate: (c) =>
        visited(c, /tab=network-acl/) || visitedId(c, '/vpc/network-acls/', naclNamed(c.env, 'private-nacl')?.networkAclId)
          ? ok(
              node('インバウンドは 3000 も 3306 も戻り通信用の 1024-65535 も許可されてます。でもアウトバウンドは 3306 と 443 だけ…'),
              hakase('それだ。ALB → EC2 の**リクエスト**は入れる。だが EC2 から ALB への**返事**の宛先は ALB のエフェメラルポート (1024〜65535)。アウトバウンドで拒否されておる。'),
              node('443 って何でしたっけ？'),
              hakase('HTTPS、暗号化した HTTP の番号だ。「アプリが外へ送るのは DB への 3306 と HTTPS だけ」と、行きのことだけ考えて書いた名簿だな。入ってきた客への返事のことは、誰も考えなかった。'),
              hakase('次の表に、戻り通信の宛先になるエフェメラルポートをまとめておいた。NLB は ALB の兄弟分のロードバランサーで、この一家をまとめて Elastic Load Balancing と呼ぶ。NAT ゲートウェイは private subnet からインターネットへ出ていくための出口だ。どちらも今は名前だけ覚えておけばよい。'),
            )
          : ng(hakase('private-subnet-1a のネットワーク ACL をまだ見ていないようだ。VPC > サブネットで `private-subnet-1a` を開き、「ネットワーク ACL」タブを押すのだ。')),
    },
    {
      type: 'table',
      title: 'エフェメラルポート (戻り通信の宛先ポート)',
      columns: ['接続を始める側', 'エフェメラルポート'],
      rows: [
        ['ALB / NLB (Elastic Load Balancing)', '1024-65535'],
        ['NAT ゲートウェイ', '1024-65535'],
        ['Linux (Amazon Linux など)', '32768-60999'],
        ['Windows / macOS', '49152-65535'],
      ],
    },
    {
      type: 'exercise',
      title: '戻り通信を許可する',
      objective: '`private-nacl` のアウトバウンドルールに「TCP `1024-65535` / 送信先 `10.0.0.0/16` / 許可」を追加し、ALB → EC2 と EC2 → RDS の両方をつなぐ',
      tasks: [
        { id: 'edit', title: '`private-nacl` の **アウトバウンドルールを編集**', hint: 'ネットワーク ACL 一覧、またはサブネットのネットワーク ACL タブのリンクから。', hotspotId: 'nacl-edit-outbound', done: (c) => visited(c, new RegExp(`${naclNamed(c.env, 'private-nacl')?.networkAclId}/edit-outbound`)) },
        { id: 'add', title: '**新しいルールを追加** → `120` / カスタム TCP / `1024-65535` / `10.0.0.0/16` / 許可 → **変更を保存**', hint: '送信先を VPC の CIDR (10.0.0.0/16) にすると、VPC 内への戻り通信だけを許可できます。', hotspotId: 'nacl-save-rules', done: (c) => albReachesWeb(c.env) },
      ],
      validate: (c) => {
        if (!albReachesWeb(c.env)) return ng(hakase('まだ ALB → EC2 の戻り通信が拒否されておる。アウトバウンドに「カスタム TCP / `1024-65535` / `10.0.0.0/16` / 許可」を足して保存したか？ 「通信経路の診断」で、拒否されたポート範囲も確認するのだ。'));
        if (!webReachesDb(c.env))
          return ng(
            hakase('ALB → EC2 はつながった。だが web-2 (private-subnet-1c) → RDS (private-subnet-1a) の戻り通信がまだ拒否されておる。'),
            node('サブネットをまたぐから、DB 側のサブネットから web-2 のエフェメラルポート (32768-60999) への返事が要るんですね。'),
            hakase('送信先を ALB のサブネットだけに絞ったのではないか？ VPC 全体の `10.0.0.0/16` にすれば、まとめて面倒を見られる。'),
          );
        return ok(
          hakase('ALB → EC2 も EC2 → RDS もつながった。`10.0.0.0/16` 宛ての 1024-65535 で、どちらの戻り通信もカバーできたな。'),
          node('送信先を VPC の中 (`10.0.0.0/16`) だけにしたから、外の世界への余計な出口は増やしてない、と。'),
          hakase('うむ。関所の名簿には、必要な帰り道だけを書く。これでセキュリティ担当の笑顔も守られたわけだ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '復旧を確認する',
      objective: 'ターゲットが正常になり、ブラウザで `Database: connected` が表示されることを確認する',
      tasks: [
        { id: 'healthy', title: '`web-tg` のターゲットがすべて **正常 (healthy)**', hint: '`web-tg` の「ターゲット」タブで、2 台のヘルスステータスが **正常** か確認します。異常のままなら「ヘルスステータスの詳細」の理由を見直します。', done: (c) => allTargetsHealthy(c.env, 'web-tg', 2) },
        { id: 'browse', title: 'ブラウザで ALB にアクセス → **200 / Database: connected**', hint: 'ロードバランサー一覧で `web-alb` の DNS 名をコピーして「ブラウザ」タブで開き、本文に `Database: connected` が出るか確認します。', done: (c) => !!lastAlbRequest(c)?.body.includes('Database: connected') },
      ],
      validate: (c) =>
        lastAlbRequest(c)?.body.includes('Database: connected')
          ? ok(
              node('直りました！ `Database: connected` です！'),
              hakase('Security Group が正しいのに Timeout なら、ネットワーク ACL。そして ACL は戻り通信まで見る。今日の教訓はこれだけだ。'),
              node('次に「強化しておきました」って聞いたら、帰り道を確認します。'),
              hakase('うむ。「強化」とは、たいてい誰かの帰り道を塞ぐことだからな。'),
            )
          : ng(hakase('まだ Database: connected が表示されていない。`web-tg` のターゲットが両方 正常 (healthy) になったのを確かめてから、ブラウザで ALB を開き直すのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。ターゲットが `Request timed out`。Security Group は正しい。次に確認すべきはどれかな？'),
      options: ['アプリケーションのログ', 'サブネットのネットワーク ACL (インバウンドとアウトバウンドの両方)', 'ALB のリスナーのポート'],
      answer: 1,
      explanation: [
        hakase('正解。Timeout はパケットが届いていない / 返ってこない合図。Security Group の次はネットワーク ACL、そして ACL は**戻り通信**まで見るのだ。'),
        node('アプリのログを見ても、届いていないパケットのことは書いてないですもんね。'),
        hakase('そうだ。来てもいない客の苦情は、店の日誌には載らん。'),
      ],
    },
  ],
};
