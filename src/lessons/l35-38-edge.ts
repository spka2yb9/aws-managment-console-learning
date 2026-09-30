import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { ipInCidr } from '../sim/cidr';
import { certCovers } from '../sim/edge';
import { CLIENT_IP } from '../sim/network';
import { cacheEnv, dnsEnv, httpsEnv, SHOP_DOMAIN, STATIC_BUCKET, wafEnv } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { visited, visitedQuery } from './helpers';

const WWW = `www.${SHOP_DOMAIN}`;

/** the newest browser request to exactly this host (and scheme, when given) */
function lastTo(c: TaskContext, host: string, scheme?: 'http' | 'https') {
  return c.browser.find((r) => {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(r.url) ? r.url : `http://${r.url}`);
      return u.hostname === host && (!scheme || u.protocol === `${scheme}:`);
    } catch {
      return false;
    }
  });
}
const zone = (env: AwsEnv) => env.hostedZones.find((z) => z.name === SHOP_DOMAIN);
const dist = (env: AwsEnv) => env.distributions[0];

// ---------------- 35 Route 53 ----------------

const apexAlias = (env: AwsEnv) => zone(env)?.records.find((r) => r.name === SHOP_DOMAIN && r.type === 'A' && r.aliasTarget);
const apexOk = (c: TaskContext) => lastTo(c, SHOP_DOMAIN)?.status === 200 && !!apexAlias(c.env);

export const lesson35: Lesson = {
  id: 'route53-dns',
  number: '35',
  title: 'Route 53 で独自ドメインを公開する',
  summary: 'www 付きでは開けるのに、www なしでは開けない。DNS レコードを調べ、Zone Apex にエイリアスレコードを作る',
  minutes: 20,
  startPath: '/route53/hostedzones',
  scenario: dnsEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node(`博士、お客さんから「${SHOP_DOMAIN} が開かない」って電話がありました。僕のブラウザだと ${WWW} は開けるんですけど…`),
        hakase('ほう。www を付けると開いて、付けないと開かない、と。'),
        node('www なんて飾りみたいなものですよね？'),
        hakase('飾りではない。**DNS** から見れば、この 2 つはまったく別の名前だ。'),
        node('でぃーえぬえす？'),
        hakase('Lesson 11 で ALB を作ったとき、「**DNS 名** がこの ALB の住所だ」と言ったのを覚えておるか。'),
        node('あ、あの長ーい名前ですね。`web-alb-1234567890.ap-northeast-1.elb.amazonaws.com` みたいな。'),
        hakase('うむ。だがコンピュータは、IP アドレスでないと相手を探せん。名前から IP アドレスを引く、電話帳のような仕組みが DNS だ。'),
        node('電話帳ですか。今どき見たことないですけど。'),
        hakase('……ワシの青春を否定するでない。'),
        node('じゃあ、www なしの名前は、電話帳に載ってないってことですか？'),
        hakase('それを確かめるのが今日の仕事だ。だが確かめる前に、電話帳の読み方を教えておこう。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('その電話帳って、どこにあるんですか？ 本棚ですか？'),
        hakase('AWS では **Route 53** というサービスが預かっておる。DNS が使うポート番号の 53 と、アメリカの国道 Route 66 をかけた名前だ。'),
        node('ダジャレじゃないですか。博士のギャグと同じレベルですね。'),
        hakase('一緒にするでない。Route 53 では、ドメインごとに **ホストゾーン** という入れ物を作る。電話帳 1 冊ぶんだ。インターネットに公開するものは、画面で「パブリックホストゾーン」と出る。'),
        node('どめいん？'),
        hakase(`\`${SHOP_DOMAIN}\` のような、うちが持っている名前の区画だ。会社名のようなもので、その下に \`www\` や \`shop\` のような部署の名前を好きなだけ作れる。`),
        node('会社の下に部署があるイメージですね。www 部。'),
        hakase(`うむ。そして部署の付かない会社名そのもの、\`${SHOP_DOMAIN}\` を **Zone Apex** という。Apex は「頂点」。ゾーンのてっぺんの名前だ。`),
        node('会社の代表番号みたいなものですね。…代表番号が電話帳に載ってない会社って、潰れたのかなって思いますよね。'),
        hakase('まさに今、お客さんにそう思われておる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('電話帳の中身は、どうなってるんですか？'),
        hakase('1 行 1 行を **レコード** という。「この名前を聞かれたら、こう答えよ」という書き付けだ。'),
        hakase('**A レコード** は、名前 → IPv4 アドレス。`192.0.2.10` のような数字の住所を、そのまま答える。**CNAME レコード** は、名前 → 別の名前。「その名前なら、こっちの名前を引き直してくれ」と答える。'),
        node('電話の転送みたいですね。「担当が替わりました、こちらへおかけ直しください」って。'),
        hakase(`うまいことを言う。\`${WWW}\` は今、CNAME で ALB の DNS 名に転送しておるはずだ。`),
        hakase('もう 1 つ、Route 53 独自の **エイリアス** がある。名前 → ALB や CloudFront などの AWS リソース。Route 53 が中で IP アドレスを調べて、A レコードとして答えてくれる。'),
        node('えいりあす…あだ名ですか？'),
        hakase('英語で「別名」だ。CNAME と何が違うのかは、今日の最後にわかる。伏線だから覚えておけ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('それから、ホストゾーンを作ると、Route 53 は最初から 2 つのレコードを Zone Apex に入れておく。**NS** と **SOA** だ。'),
        node('えぬえす？ えすおーえー？'),
        hakase('NS は Name Server。「この電話帳を預かっている DNS サーバーはこの 4 台だ」という案内だ。SOA は Start of Authority。発行元や版の番号を書いた、電話帳の奥付だな。誰も読まんが、無いと電話帳として成り立たん。'),
        hakase('最後に、レコードには **TTL** という数字が付いておる。'),
        node('てぃーてぃーえる？'),
        hakase('Time To Live、答えの賞味期限だ。お客さんの代わりに DNS を引いてくれる **リゾルバー** (プロバイダーなどの DNS サーバー) は、一度引いた答えをメモしておく。これを **キャッシュ** という。TTL は、そのメモを使ってよい秒数だ。'),
        node('TTL が 300 なら、5 分間は電話帳を見直さずにメモで答える、と。'),
        hakase('うむ。だから DNS を変えても、すぐには効かん。深夜の切り替え作業で「変わらない！」と叫ぶ人間の 9 割はこれだ。'),
        node('残りの 1 割は？'),
        hakase('直すレコードを間違えておる。…さて、講釈はここまでだ。まずはブラウザで症状を確かめる。Lesson 15 でやった「通信経路の診断」も見るのだぞ。'),
      ],
    },
    {
      type: 'table',
      title: 'DNS レコードの基本',
      columns: ['用語', '意味'],
      rows: [
        ['ホストゾーン', 'ドメイン (例: webapp-shop.example) のレコードの入れ物。電話帳 1 冊'],
        ['A レコード', '名前 → IPv4 アドレス'],
        ['CNAME レコード', '名前 → 別の名前 (その名前をさらに引く)'],
        ['エイリアス (Route 53 独自)', '名前 → ALB / CloudFront などの AWS リソース。A レコードとして返る'],
        ['Zone Apex', 'www などが付かない、ドメインそのものの名前 (webapp-shop.example)'],
        ['TTL', 'リゾルバーが答えをキャッシュしてよい秒数'],
      ],
    },
    {
      type: 'exercise',
      title: '症状を確かめる',
      objective: `右のパネルの **ブラウザ** で \`http://${WWW}\` と \`http://${SHOP_DOMAIN}\` を開き、結果を比べる`,
      tasks: [
        { id: 'www', title: `\`http://${WWW}\` → 200 OK`, hint: '右のパネルの **ブラウザ** の URL 欄に `http://` から入力して **移動** を押します。', done: (c) => lastTo(c, WWW)?.status === 200 },
        { id: 'apex', title: `\`http://${SHOP_DOMAIN}\` → 名前が見つからない`, hint: '「通信経路の診断」で DNS の結果を見てみましょう。', done: (c) => lastTo(c, SHOP_DOMAIN)?.error === 'ERR_NAME_NOT_RESOLVED' },
      ],
      validate: (c) =>
        lastTo(c, WWW)?.status === 200 && lastTo(c, SHOP_DOMAIN)?.error === 'ERR_NAME_NOT_RESOLVED'
          ? ok(
              node('www 付きは 200 OK。www なしは `ERR_NAME_NOT_RESOLVED`…「名前が解決できない」ですか？'),
              hakase('うむ。DNS に聞いたら「そんな名前は知らん」と言われた、という意味だ。サーバーや ALB にたどり着く前に、電話帳の段階でつまずいておる。'),
              node('ALB が壊れてるわけじゃないんですね。よかった、僕のせいじゃない。'),
              hakase('喜ぶのは原因を見てからにしたまえ。次はホストゾーンのレコードを読むぞ。'),
            )
          : ng(hakase(`右のパネルの「ブラウザ」で、\`http://${WWW}\` と \`http://${SHOP_DOMAIN}\` を 1 つずつ開くのだ。www なしで失敗したら、「通信経路の診断」の DNS の行を読んでみろ。`)),
    },
    {
      type: 'exercise',
      title: 'レコードを調べる',
      objective: `Route 53 > ホストゾーン > \`${SHOP_DOMAIN}\` を開き、どの名前にどのレコードがあるか確認する`,
      tasks: [{ id: 'zone', title: `ホストゾーン \`${SHOP_DOMAIN}\` を開く`, hint: 'ホストゾーン一覧の **ホストゾーン名** のリンクから開きます。**レコード** 表で、www 付きの名前と www なしの名前に、それぞれどのタイプのレコードがあるかを見比べます。', done: (c) => visited(c, `/route53/hostedzones/${zone(c.env)?.id}`) }],
      validate: (c) =>
        visited(c, `/route53/hostedzones/${zone(c.env)?.id}`)
          ? ok(
              node(`${WWW} は CNAME で ALB の DNS 名を指しています。でも ${SHOP_DOMAIN} には NS と SOA しかありません！`),
              hakase('原因はそれだ。www なしの名前、つまり Zone Apex には、お客さんを案内するレコードが 1 つも無かった。代表番号の欄が空っぽの電話帳だ。'),
              node('じゃあ www と同じように、CNAME で ALB に向ければいいですね！'),
              hakase('やってみたまえ。**レコードを作成** で、レコード名を空白にすれば Zone Apex だ。ルーティングポリシーは「シンプルルーティング」、1 つの名前に 1 つの答えを返す素直な設定のままでよい。'),
              node('…なんで「やってみたまえ」がそんなに楽しそうなんですか。'),
            )
          : ng(hakase(`Route 53 > ホストゾーン の一覧で、\`${SHOP_DOMAIN}\` の名前をクリックして開くのだ。電話帳は表紙を眺めても中身はわからんぞ。`)),
    },
    {
      type: 'exercise',
      title: 'Zone Apex にレコードを作る',
      objective: `\`${SHOP_DOMAIN}\` (レコード名は空白) が ALB \`web-alb\` を指すようにして、ブラウザで開けることを確かめる。まず CNAME で作ってみて、エラーを読んでみよう`,
      tasks: [
        { id: 'record', title: '**レコードを作成** → レコード名は空白、タイプ **A**、**エイリアス** をオン → ALB へのエイリアス → `web-alb` の DNS 名', hint: 'CNAME を選ぶと Route 53 に拒否されます。エラーメッセージの "apex" に注目。', hotspotId: 'route53-create-record', done: (c) => !!apexAlias(c.env) },
        { id: 'browse', title: `ブラウザで \`http://${SHOP_DOMAIN}\` → 200 OK`, hint: 'レコードを作成したら、ブラウザで www なしの URL を開き直します。開けなければ「通信経路の診断 (学習用)」の **DNS (Route 53)** の行で、名前がどこに解決されたかを確認します。', done: apexOk },
      ],
      validate: (c) => {
        if (!apexAlias(c.env))
          return ng(
            hakase('Zone Apex にエイリアスの A レコードがまだない。CNAME は Zone Apex には作れんのだ。エラーにも `not permitted at apex` と書いてあったろう。'),
            hakase('レコードタイプを **A** にして **エイリアス** をオン、ルーティング先は「Application Load Balancer と Classic Load Balancer へのエイリアス」→ `web-alb` の DNS 名だ。'),
          );
        if (!apexOk(c)) return ng(hakase(`レコードはできた。だがブラウザで確かめるまでが仕事だ。\`http://${SHOP_DOMAIN}\` をもう一度開くのだ。`));
        return ok(
          node('開けました！ 200 OK です。でも、なんで CNAME はダメだったんですか？'),
          hakase('Zone Apex には必ず NS と SOA がある。そして CNAME には「同じ名前にほかのレコードを置いてはならん」という決まりがあるのだ。だから Zone Apex に CNAME は置けん。'),
          hakase('そこで Route 53 は、ALB などを A レコードとして答えられる **エイリアス** を用意しておる。伏線回収だな。'),
          node('すっきりしました。…最初から教えてくれてもよかったと思いますけど。'),
          hakase('エラーを自分で踏んだ人間は忘れん。ワシは踏ませる専門家だ。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase(`\`${SHOP_DOMAIN}\` (Zone Apex) で ALB を公開したい。どのレコードを作るかな？`),
      options: ['CNAME レコードで ALB の DNS 名を指す', 'A レコード (エイリアス) で ALB を指す', 'A レコードに ALB の今の IP アドレスを書く'],
      answer: 1,
      explanation: [
        hakase('正解。CNAME は Zone Apex に置けん。IP アドレスの直書きもダメだ。ALB の IP アドレスは、台数の増減などで予告なく変わる。'),
        hakase('直書きすると、ある日突然つながらなくなって深夜 3 時にワシの電話が鳴る。そして朝には君の始末書だ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('TTL 300 秒の CNAME レコードの向き先を変えた。変更前の答えを持っているお客さんには、いつ新しい答えが届くかな？'),
      options: ['すぐに届く', '最大 300 秒 (5 分) 後', 'ちょうど 24 時間後'],
      answer: 1,
      explanation: [
        hakase('正解。リゾルバーは TTL の間、古い答えをキャッシュしてよい。だから最大 300 秒は、古い向き先に行くお客さんがいる。'),
        hakase('大事な切り替えの前日に TTL を短くしておくのが定石だ。当日に短くしても、もう配られたメモは長い TTL のままだからな。'),
      ],
    },
  ],
};

// ---------------- 36 ACM + CloudFront ----------------

const virginiaCert = (env: AwsEnv) => env.certificates.find((c) => c.region === 'us-east-1' && certCovers(c, WWW) && certCovers(c, SHOP_DOMAIN));
const wrongRegionCert = (env: AwsEnv) => env.certificates.find((c) => c.region !== 'us-east-1' && certCovers(c, WWW));
const distFixed = (env: AwsEnv) => {
  const d = dist(env);
  const c = env.certificates.find((x) => x.certificateArn === d?.certificateArn);
  return !!d && !!c && d.aliases.includes(WWW) && d.aliases.includes(SHOP_DOMAIN) && certCovers(c, WWW);
};
const wwwHttpsOk = (c: TaskContext) => distFixed(c.env) && lastTo(c, WWW, 'https')?.status === 200;

export const lesson36: Lesson = {
  id: 'acm-certificate',
  number: '36',
  title: 'HTTPS の証明書エラーを直す (ACM と CloudFront)',
  summary: 'www 付きの HTTPS だけ証明書エラーになる。証明書の名前、リージョン、CloudFront の代替ドメイン名をそろえる',
  minutes: 30,
  startPath: '/cloudfront/distributions',
  scenario: httpsEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node(`博士、ショップは CloudFront 経由で \`https://${SHOP_DOMAIN}\` で公開してますよね。昨日、www も Lesson 35 で習ったエイリアスレコードで CloudFront に向けたんです。`),
        hakase('ほう、言われる前に仕事をするとは。で、何を壊した？'),
        node(`壊した前提なんですね…。\`https://${WWW}\` を開くと「この接続ではプライバシーが保護されません」って出るんです。www なしは普通に開けるのに。`),
        hakase('お客さんが一番逃げ出す画面だな。…ところで、CloudFront が何なのか分かって向けたのかな？'),
        node('……Lesson 21 のクイズで、名前だけ見ました。'),
        hakase('名前だけで本番の DNS を触ったのか。度胸だけは一人前だ。'),
        hakase('**CloudFront** は AWS の **CDN** (コンテンツ配信ネットワーク) だ。世界中に **エッジロケーション** という拠点を置いて、お客さんの近くから応答を返す。'),
        node('えっじろけーしょん？'),
        hakase('edge は「ふち」。AWS のネットワークのいちばん外側、お客さんに一番近い所だ。世界に数百か所あって、東京のお客さんは東京近くのエッジにつながる。'),
        node('コンビニみたいですね。遠くの倉庫まで行かなくても、近所で買える。'),
        hakase('うまい。その遠くの倉庫、本物のデータを持っている元のサーバーを **オリジン** という。このショップのオリジンは `web-alb` だ。'),
        hakase('CloudFront の設定一式は **ディストリビューション** と呼ぶ。「どのオリジンから取って、どんな名前で配るか」のまとめだ。`d…cloudfront.net` という専用のドメイン名も 1 つずつもらえる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('で、「プライバシーが保護されません」っていうのは？'),
        hakase('**HTTPS** の話だ。HTTP に S (Secure) が付いたもので、通信を **TLS** という仕組みで暗号化する。'),
        node('てぃーえるえす？'),
        hakase('Transport Layer Security。昔は **SSL** と呼ばれておって、画面にも「カスタム SSL 証明書」のように古い名前が残っておる。同じものだと思ってよい。'),
        hakase('暗号化を始める前に、サーバーはブラウザに **証明書** を見せる。「私は確かにこの名前のサーバーだ」という身分証明書だ。守る名前が書いてあり、信頼できる発行元のハンコが押してある。'),
        node('社員証みたいなものですね。'),
        hakase('うむ。ブラウザは、開いた名前が証明書に書いてあるかを確かめる。書いてなければ「偽物かもしれん」と警告を出す。それがさっきの画面だ。'),
        node('エラーコードは `ERR_CERT_COMMON_NAME_INVALID` でした。こもんねーむ？'),
        hakase('Common Name、証明書に書かれた名前のことだ。「名前が合わん」と言っておる。他人の社員証で入館しようとしたようなものだな。'),
        hakase('ちなみにワシは昔、自分の社員証で止められたことがある。退職扱いになっておってな。'),
        node('それ、ジョークじゃなくて事件ですよね。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('でも CloudFront には、世界中のいろんなサイトが相乗りしてるんですよね。どのサイトの証明書を見せるか、どうやって決めるんですか？'),
        hakase(`ほう、鋭い。熱でもあるのか。ブラウザは暗号化の前に「${WWW} に用があります」と名乗る。これを **SNI** (Server Name Indication) という。`),
        node('えすえぬあい…雑居ビルの受付で「〇〇社に来ました」って言うやつですね。'),
        hakase('うむ。CloudFront は名乗られた名前で、見せる証明書を選ぶ。「通信経路の診断」の「TLS 証明書 (SNI)」の行が、その結果だ。'),
        hakase('ただし CloudFront が自分の名前として受け付けるのは、ディストリビューションの **代替ドメイン名** に登録した名前だけだ。知らん名前には、既定の `*.cloudfront.net` の証明書を見せる。`*` は「何でも当てはまる」印、**ワイルドカード** だ。'),
        node('画面だと「代替ドメイン名 (CNAME)」ってなってますね。Lesson 35 の CNAME レコードと関係あるんですか？'),
        hakase('昔は独自ドメインを CNAME で CloudFront に向けるのが普通だった、その名残だ。今は Route 53 のエイリアスで向けてもかまわん。名前に惑わされるでない。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('証明書は、どこでもらうんですか？ ハンコ屋さん？'),
        hakase('**ACM** (AWS Certificate Manager) だ。公開用の証明書を無料で発行して、期限の前に自動で更新までしてくれる。'),
        node('無料で自動！ 博士よりやさしい。'),
        hakase('ただし罠が 1 つある。**CloudFront で使う証明書は、us-east-1 (米国東部 (バージニア北部)) でリクエストする** のだ。'),
        node('東京じゃダメなんですか？ Lesson 02 で、リソースはリージョンごとにあるって習いましたけど。'),
        hakase('CloudFront は特定のリージョンに属さないグローバルなサービスで、証明書は us-east-1 のものしか使えん決まりだ。東京で作って半日溶かした人間を、ワシは何人も知っておる。ワシも含めてな。'),
        hakase('最後に **DNS 検証**。ACM は発行の前に「本当にこのドメインの持ち主か」を確かめる。ACM が指定する CNAME レコードをホストゾーンに作れば、持ち主の証明になるのだ。'),
        node('自分ちの表札に、指定された合言葉を書いておく感じですね。持ち主じゃなきゃ書けない。'),
        hakase('そういうことだ。材料はそろった。まずは症状を、ブラウザと「通信経路の診断」で確かめるぞ。'),
      ],
    },
    {
      type: 'table',
      title: 'HTTPS に関わる設定',
      columns: ['設定', '場所', 'ポイント'],
      rows: [
        ['証明書', 'AWS Certificate Manager (ACM)', '守る名前を全部入れる。ワイルドカード `*.example.com` は `example.com` 自体を含まない'],
        ['証明書のリージョン', 'ACM', '**CloudFront で使う証明書は us-east-1 (バージニア北部)** にリクエストする'],
        ['DNS 検証', 'Route 53', 'ACM が示す CNAME をホストゾーンに作ると、ドメインの所有を証明できる'],
        ['代替ドメイン名 (CNAME)', 'CloudFront', 'ディストリビューションで受け付ける名前。証明書に含まれている必要がある'],
      ],
    },
    {
      type: 'exercise',
      title: '症状を確かめる',
      objective: `ブラウザで \`https://${WWW}\` を開き、エラーと「通信経路の診断」の TLS 証明書の行を確認する`,
      tasks: [{ id: 'err', title: `\`https://${WWW}\` → 証明書エラー`, hint: 'URL は `https://` で始めます。エラーが出たら、下の「通信経路の診断 (学習用)」を開いて **TLS 証明書 (SNI)** の行を読みます。', done: (c) => lastTo(c, WWW, 'https')?.error === 'ERR_CERT_COMMON_NAME_INVALID' }],
      validate: (c) =>
        lastTo(c, WWW, 'https')?.error === 'ERR_CERT_COMMON_NAME_INVALID'
          ? ok(
              node(`「TLS 証明書 (SNI)」の行に「${WWW} は代替ドメイン名ではないため、既定の証明書 *.cloudfront.net が返されました」と出ています。`),
              hakase('DNS は正しく CloudFront まで届いておる。Lesson 35 のエイリアスはちゃんと働いておるわけだ。'),
              hakase('だが CloudFront は www を自分の名前として知らん。だから名前の違う証明書を見せてしまったのだ。'),
              node('雑居ビルの受付で「そんな会社はうちに入っていません」って言われたんですね。'),
            )
          : ng(hakase(`ブラウザで \`https://${WWW}\` を開くのだ。エラーが出たら、下の「通信経路の診断」を開いて TLS 証明書の行を読め。`)),
    },
    {
      type: 'exercise',
      title: 'ディストリビューションの設定を見る',
      objective: 'CloudFront > ディストリビューション を開き、**代替ドメイン名** と **カスタム SSL 証明書** を確認する',
      tasks: [{ id: 'dist', title: 'ディストリビューションの詳細を開く', hint: 'ディストリビューション一覧の **ID** のリンクから開きます。**一般** タブの「設定」欄に、代替ドメイン名とカスタム SSL 証明書が並んでいます。', done: (c) => visited(c, `/cloudfront/distributions/${dist(c.env)?.id}`) }],
      validate: (c) =>
        visited(c, `/cloudfront/distributions/${dist(c.env)?.id}`)
          ? ok(
              node(`代替ドメイン名も、カスタム SSL 証明書も ${SHOP_DOMAIN} だけです。www を代替ドメイン名に足せばいいんですね！`),
              hakase('早とちりだ。代替ドメイン名に足せるのは、証明書に入っている名前だけだ。今の証明書に www は入っておらん。'),
              node('じゃあ先に、www 入りの証明書を ACM でもらってくる、と。'),
              hakase('そうだ。リージョンを間違えるなよ。フリではないぞ。'),
            )
          : ng(hakase('CloudFront > ディストリビューション の一覧で、ID のリンクを開くのだ。「一般」タブの「設定」に、代替ドメイン名と証明書が並んでおる。')),
    },
    {
      type: 'exercise',
      title: 'www を含む証明書をリクエストする',
      objective: `ACM で \`${SHOP_DOMAIN}\` と \`${WWW}\` の両方を含む証明書を、**米国東部 (バージニア北部) us-east-1** でリクエストし、DNS 検証で発行する`,
      tasks: [
        { id: 'region', title: '右上のリージョンを **米国東部 (バージニア北部)** に切り替えて、Certificate Manager > **リクエスト**', hint: 'ドメイン名は 2 つ入力します (この証明書に別の名前を追加)。', hotspotId: 'acm-request', done: (c) => !!virginiaCert(c.env) },
        { id: 'validate', title: '証明書の詳細で **Route 53 でレコードを作成** → ステータスが **発行済み**', hint: 'ボタンは証明書の詳細の **ドメイン** 表の右上にあります。証明書の一覧はリージョンごとなので、米国東部 (バージニア北部) のまま開き、少し待ってからステータスを確認します。', hotspotId: 'acm-create-records', done: (c) => virginiaCert(c.env)?.status === 'ISSUED' },
      ],
      validate: (c) => {
        const cert = virginiaCert(c.env);
        if (!cert)
          return ng(
            ...(wrongRegionCert(c.env)
              ? [
                  hakase('その証明書は us-east-1 以外のリージョンにある。CloudFront は us-east-1 の証明書しか使えんのだ。'),
                  hakase('右上のリージョンを **米国東部 (バージニア北部)** に切り替えて、リクエストし直すのだ。言ったそばから半日溶かす気か。'),
                ]
              : [
                  hakase(`us-east-1 に、${SHOP_DOMAIN} と ${WWW} を含む証明書がまだない。`),
                  hakase('リージョンが **米国東部 (バージニア北部)** になっているのを確かめて **リクエスト**。「この証明書に別の名前を追加」で、名前を 2 つ入れるのだ。'),
                ]),
          );
        if (cert.status !== 'ISSUED') return ng(hakase('まだ「検証保留中」だ。証明書の詳細で **Route 53 でレコードを作成** を押して、検証用の CNAME を作るのだ。作ったら少し待て。'));
        return ok(
          node('発行済みになりました！'),
          hakase('ACM は、検証用の CNAME が DNS で引けることを確かめて「このドメインの持ち主だ」と認めたのだ。この CNAME を消さなければ、証明書は期限の前に自動で更新される。'),
          node('消したら？'),
          hakase('ある日証明書が切れて、全世界のお客さんに「プライバシーが保護されません」が出る。障害報告書の題材としては一級品だ。'),
          hakase('次は CloudFront に新しい証明書を付ける。CloudFront の設定変更は、世界中のエッジに配り終わるまで数分かかる。これを **デプロイ** という。最終変更日が「デプロイ中」の間は待つのだ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'CloudFront に証明書と www を設定する',
      objective: `ディストリビューションの設定を編集して、代替ドメイン名に \`${WWW}\` を追加し、新しい証明書を選ぶ。デプロイ後に \`https://${WWW}\` を開く`,
      tasks: [
        { id: 'edit', title: '一般タブの設定 **編集** → 代替ドメイン名に項目を追加、カスタム SSL 証明書を変更 → 変更を保存', hint: `代替ドメイン名は \`${SHOP_DOMAIN}\` を残したまま **項目を追加** で \`${WWW}\` を足します。カスタム SSL 証明書には、us-east-1 で発行済みの www 入りの証明書を選びます。`, hotspotId: 'cloudfront-edit', done: (c) => distFixed(c.env) },
        { id: 'browse', title: `デプロイが終わったら (最終変更日が日時になる) ブラウザで \`https://${WWW}\` → 200 OK`, hint: '「デプロイ中」の間は古い設定のままなので、証明書エラーが続きます。開くときは `https://` を付け、エラーなら「通信経路の診断 (学習用)」の **TLS 証明書 (SNI)** の行を確認します。', done: wwwHttpsOk },
      ],
      validate: (c) => {
        if (!distFixed(c.env)) return ng(hakase(`代替ドメイン名に ${SHOP_DOMAIN} と ${WWW} の両方があるか、「カスタム SSL 証明書」が www 入りの新しい証明書になっているかを確かめるのだ。www なしを消すと、今度はそっちが壊れるぞ。`));
        if (!wwwHttpsOk(c)) return ng(hakase(`設定はできた。デプロイが終わって最終変更日が日時になったら、\`https://${WWW}\` をもう一度開くのだ。`));
        return ok(
          node('鍵マーク付きで開けました！'),
          hakase('証明書の名前、証明書のリージョン、CloudFront の代替ドメイン名、Route 53 のレコード。4 つがそろって、ようやく独自ドメインの HTTPS が動く。'),
          node('4 つもあるんですね。1 つでも欠けたら…'),
          hakase('真っ赤な画面だ。4 つ全部を覚えておる人間は少ない。だから障害はなくならん。ワシの飯の種だな。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('CloudFront に設定する ACM 証明書は、どのリージョンでリクエストするかな？'),
      options: ['アプリと同じ東京リージョン (ap-northeast-1)', '米国東部 (バージニア北部) (us-east-1)', 'どのリージョンでもよい'],
      answer: 1,
      explanation: [
        hakase('正解。CloudFront はグローバルなサービスで、証明書は us-east-1 のものしか選べん。'),
        hakase('一方、ALB に付ける証明書は ALB と同じリージョンだ。東京の ALB なら東京。これを混同して半日溶かすのが、この業界の通過儀礼だ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase(`証明書のドメイン名を \`*.${SHOP_DOMAIN}\` だけにした。守れない名前はどれかな？`),
      options: [WWW, `shop.${SHOP_DOMAIN}`, SHOP_DOMAIN],
      answer: 2,
      explanation: [
        hakase(`正解。ワイルドカードの \`*\` が当てはまるのは 1 つ下の階層だけだ。\`${SHOP_DOMAIN}\` そのもの (Zone Apex) は含まれん。`),
        hakase('Zone Apex も使うなら、証明書に両方の名前を入れるのだ。今日やったとおりにな。'),
      ],
    },
  ],
};

// ---------------- 37 CloudFront cache ----------------

const staleSeen = (c: TaskContext) => {
  const r = lastTo(c, dist(c.env)?.domainName ?? '');
  return !!r && r.headers?.['X-Cache'] === 'Hit from cloudfront' && r.body.includes('夏のセール');
};
const invalidated = (env: AwsEnv) => !!dist(env)?.invalidations.some((i) => i.status === 'Completed') && !dist(env)?.cache.some((x) => x.path === '/index.html' && x.body.includes('夏のセール'));
const freshSeen = (c: TaskContext) => invalidated(c.env) && !!lastTo(c, dist(c.env)?.domainName ?? '')?.body.includes('秋のキャンペーン');

export const lesson37: Lesson = {
  id: 'cloudfront-cache',
  number: '37',
  title: 'CloudFront のキャッシュが古いまま',
  summary: 'S3 のページを更新したのにサイトが変わらない。X-Cache と Age でキャッシュを確かめ、無効化で最新にする',
  minutes: 20,
  startPath: '/cloudfront/distributions',
  scenario: cacheEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士！ 10 分前に S3 の index.html を「秋のキャンペーン」に書き換えたのに、サイトはまだ「夏のセール」のままです！'),
        hakase('秋に夏のセール。季節感のない店だ。お客さんはもう紅葉狩りに出かけておるぞ。'),
        node('笑いごとじゃないです。部長がもうすぐ見に来るんです。'),
        hakase('このサイトは、S3 の前に **CloudFront** を置いておる。Lesson 36 でやったな。'),
        node('世界中の **エッジロケーション** から、お客さんの近くで返してくれるんでしたよね。で、本物のデータを持っている元のサーバーが **オリジン**。'),
        hakase('ほう。君の記憶は揮発性メモリかと思っておったが、少しは残っておるようだ。今回のオリジンは ALB ではなく、Lesson 20 でやった S3 のバケットだ。'),
        node('でも、エッジはどうやって近くで返すんですか？ 全部のエッジに S3 のコピーが置いてあるとか？'),
        hakase('最初のお客さんが来たとき、エッジはオリジンに取りに行く。そして返すついでに、コピーを手元にしまっておく。これが **キャッシュ** だ。'),
        node('キャッシュって、Lesson 35 の DNS のリゾルバーがやってたやつですよね。一度引いた答えをメモしておく。'),
        hakase('同じ考え方だ。2 人目からはコピーを返すから速いし、S3 への問い合わせも減って安い。'),
        node('いいことずくめじゃないですか。'),
        hakase('コピーが古くなっても、エッジは気づかずに配り続ける。そこが落とし穴だ。今の君のようにな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('本当にキャッシュのせいか、どうやったらわかるんですか？'),
        hakase('応答の **ヘッダー** を見る。ページ本体とは別に付いてくる、荷物の送り状のような情報だ。ブラウザの結果の上に並んでおる。'),
        node('へっだー。送り状なら、どこから来たか書いてありそうですね。'),
        hakase('そのとおり。**X-Cache** が `Hit from cloudfront` なら、エッジのキャッシュから返した。`Miss from cloudfront` なら、オリジンまで取りに行った、という印だ。'),
        node('ヒットは当たりで、ミスは外れ。'),
        hakase('キャッシュに当たったかどうか、だ。**Age** は、そのコピーをキャッシュしてから何秒たったか。コピーの年齢だな。'),
        node('年齢。ワインみたいに、寝かせるほどおいしくなったり…'),
        hakase('せん。Web ページは寝かせると腐るだけだ。君の企画書と同じでな。'),
        hakase('ついでに `X-Amz-Cf-Pop` は、答えたエッジの名前だ。`NRT` は成田空港のコード。エッジには近くの空港のコードが付いておる。'),
        node('空港コード！ ちょっと旅行気分ですね。'),
        hakase('旅行はキャンペーンを直してからだ。開くのはディストリビューションのドメイン名 (`d…cloudfront.net`) だ。S3 のバケットでも index.html の最終更新日時を見て、どちらが新しいか比べるのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'キャッシュを確かめる',
      objective: 'ディストリビューションのドメイン名 (d…cloudfront.net) をブラウザで開き、応答ヘッダーの **X-Cache** と **Age** を確認する。S3 のバケットでも index.html の最終更新日時を見てみよう',
      tasks: [
        { id: 'browse', title: 'CloudFront > ディストリビューション → ドメイン名をコピーして **ブラウザ** で開く', hint: 'ドメイン名は一覧の **ドメイン名** 列か、詳細の「ディストリビューションドメイン名」のコピーアイコンで取れます。結果の上に並ぶヘッダーから `X-Cache` と `Age` を探します。', done: staleSeen },
        { id: 's3', title: `S3 > \`${STATIC_BUCKET}\` の index.html を見る`, hint: 'オブジェクト一覧で index.html の **最終更新日時** を見て、CloudFront の応答の `Age` (秒) と比べます。', done: (c) => visited(c, `/s3/buckets/${STATIC_BUCKET}`) },
      ],
      validate: (c) =>
        staleSeen(c) && visited(c, `/s3/buckets/${STATIC_BUCKET}`)
          ? ok(
              node('`X-Cache: Hit from cloudfront`、`Age` は 3600 秒くらい…1 時間前のコピーです！ S3 のほうは 10 分前に更新されてるのに。'),
              hakase('Hit はキャッシュから返した印だ。エッジはオリジン (S3) に聞きに行かず、1 時間前の「夏のセール」を配り続けておる。'),
              node('じゃあ、このコピーはいつまで配られ続けるんですか？'),
              hakase('Lesson 35 の DNS と同じで、**TTL** で決まる。CloudFront では、ディストリビューションの **ビヘイビア** タブにある。ビヘイビアは、URL のパスごとに「どのオリジンから取り、どれだけキャッシュするか」を決める設定だ。パスパターンの `デフォルト (*)` は「全部のパス」だ。'),
              node('びへいびあ…お行儀ですね。うちのサイトのお行儀を見に行きます。'),
            )
          : ng(hakase(`ディストリビューションの一覧で **ドメイン名** (d…cloudfront.net) をコピーして、ブラウザで開くのだ。それから S3 > \`${STATIC_BUCKET}\` も開いて、index.html の最終更新日時を見比べろ。片方だけでは比べようがない。`)),
    },
    {
      type: 'exercise',
      title: 'キャッシュの期間を調べる',
      objective: 'ディストリビューションの **ビヘイビア** タブで、デフォルト TTL を確認する',
      tasks: [{ id: 'ttl', title: 'ビヘイビア タブを開く', hint: 'タブは詳細画面の上部 (一般 / オリジン / ビヘイビア / 無効化) にあります。「デフォルト TTL (秒)」の値を時間や日に換算してみましょう。', done: (c) => visitedQuery(c, `/cloudfront/distributions/${dist(c.env)?.id}`, { tab: 'behaviors' }) }],
      validate: (c) =>
        visitedQuery(c, `/cloudfront/distributions/${dist(c.env)?.id}`, { tab: 'behaviors' })
          ? ok(
              node('ビヘイビアの行に「ビューワープロトコルポリシー」っていう列もあります。びゅーわー？'),
              hakase('ビューワーは、ページを見に来るブラウザのことだ。その列は、ブラウザが http:// で来たときの扱いを決める。**Redirect HTTP to HTTPS** なら「暗号化した https:// で来直してくれ」と案内し直す。今日はキャッシュの話だから、そこは触らんでよい。'),
              node('デフォルト TTL は 86400 秒…1 日です！ 明日まで待てば直るってことですか？'),
              hakase('そうだ。オリジンが Cache-Control (「何秒キャッシュしてよいか」を伝えるヘッダー) を返さないと、エッジはこの 1 日を使う。キャンペーンが明日からなら、待てばよい。'),
              node('今日からです…。部長の顔が浮かびます。'),
              hakase('なら、エッジに今すぐ古いコピーを捨てさせる。これが **無効化 (Invalidation)** だ。**無効化** タブで、捨てたいファイルの **オブジェクトパス** を `/` から書く。このサイトは `/` を開くと index.html が返る (一般タブの「デフォルトルートオブジェクト」) から、`/index.html` だ。'),
              node('全部まとめて捨てるなら `/*` ですね。'),
            )
          : ng(hakase('ディストリビューションの ID を開いて、**ビヘイビア** タブに切り替えるのだ。「デフォルト TTL (秒)」の列がある。')),
    },
    {
      type: 'exercise',
      title: '無効化して最新にする',
      objective: '無効化を作成してキャッシュから index.html を消し、ブラウザで新しいページが返る (X-Cache: Miss) ことを確かめる',
      tasks: [
        { id: 'inv', title: '無効化 タブ → **無効化を作成** → オブジェクトパス `/index.html` (または `/*`) → ステータスが完了', hint: 'パスは / で始めます。', hotspotId: 'cloudfront-invalidate', done: (c) => invalidated(c.env) },
        { id: 'fresh', title: 'ブラウザでもう一度開く → 「秋のキャンペーン」', hint: '無効化の **ステータス** が「完了」になってから、同じドメイン名をブラウザで開き直します。ヘッダーの `X-Cache` が Miss に変わっているかも確認します。', done: freshSeen },
      ],
      validate: (c) => {
        if (!invalidated(c.env))
          return dist(c.env)?.invalidations.some((i) => i.status === 'Completed')
            ? ng(hakase('無効化は終わったが、index.html のキャッシュが残っている。オブジェクトパスを確かめるのだ。'), hakase('`/index.html` か `/*` を、先頭の `/` 付きで書く。違う場所を掃除しても、汚れは消えんぞ。'))
            : ng(hakase('無効化を作成して、ステータスが「完了」になるまで待つのだ。**無効化** タブ → **無効化を作成** → オブジェクトパスに `/index.html` だ。'));
        if (!freshSeen(c)) return ng(hakase('ブラウザでディストリビューションのドメイン名をもう一度開くのだ。X-Cache が Miss なら、オリジンから取り直した証拠だ。'));
        return ok(
          node('「秋のキャンペーン」になりました！ X-Cache は Miss、もう一度開くと Hit です。'),
          hakase('無効化のあとの最初のリクエストで、エッジは S3 から新しいページを取り直し、またキャッシュしたのだ。だから 2 回目は Hit になる。'),
          node('部長が来る前に間に合いました！'),
          hakase('運のいい男だ。ただし、新しいページもまた 1 日キャッシュされる。キャンペーンの誤字を見つけたら、また無効化だぞ。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('CSS や画像を更新するたびに無効化するのは面倒だ。よく使われるやり方はどれかな？'),
      options: ['TTL を 0 にして、キャッシュを使わない', 'ファイル名にバージョンを付ける (style.v2.css) か、HTML だけ TTL を短くする', 'CloudFront をやめて S3 を直接公開する'],
      answer: 1,
      explanation: [
        hakase('正解。名前が変われば別のオブジェクトだから、古いキャッシュには当たらん。HTML の参照先を style.v2.css に書き換えれば、次からは新しい CSS が配られる。'),
        hakase('HTML は TTL を短く、CSS や画像はバージョン付きで長く、が定番だ。TTL 0 はキャッシュの速さと安さを自分から捨てるようなもの、S3 の直接公開は Lesson 21 のクイズでやったとおり勧められん。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('無効化のパスを `/*` にした。無料枠 (月 1,000 パス) では何パスと数えるかな？'),
      options: ['1 パス', 'キャッシュされていたファイルの数', '1,000 パス'],
      answer: 0,
      explanation: [
        hakase('正解。`/*` のようなワイルドカードも 1 パスだ。月 1,000 パスを超えると、1 パスごとに料金がかかる。'),
        hakase('ただし全部のキャッシュが消えるから、しばらくはオリジンへのリクエストが一気に増える。オリジンが ALB や EC2 なら、その波で倒れることもある。深夜 3 時の電話の原因は、だいたいこういう「ついで」だ。'),
      ],
    },
  ],
};

// ---------------- 38 WAF ----------------

const ipSet = (env: AwsEnv) => env.ipSets.find((s) => s.name === 'bad-ips');
const blockedSeen = (c: TaskContext) => {
  const r = lastTo(c, dist(c.env)?.domainName ?? '');
  return r?.status === 403 && r.body.includes('Request blocked');
};
const officeFree = (env: AwsEnv) => !!ipSet(env) && !ipSet(env)!.addresses.some((a) => ipInCidr(CLIENT_IP, a));
const attackerBlocked = (env: AwsEnv) => !!ipSet(env)?.addresses.some((a) => ipInCidr('198.51.100.77', a));
const ipFixed = (env: AwsEnv) => officeFree(env) && attackerBlocked(env);
const samples = (env: AwsEnv) => env.webAcls[0]?.samples ?? [];
const xssBlocked = (c: TaskContext) => ipFixed(c.env) && samples(c.env).some((s) => s.clientIp === CLIENT_IP && s.rule === 'AWS-AWSManagedRulesCommonRuleSet' && s.action === 'BLOCK');
const officeOk = (c: TaskContext) => ipFixed(c.env) && samples(c.env).some((s) => s.clientIp === CLIENT_IP && s.action === 'ALLOW');

export const lesson38: Lesson = {
  id: 'waf-blocked',
  number: '38',
  title: 'WAF が社内からのアクセスをブロックする',
  summary: '昨日の攻撃対策のあと、社内から 403 になった。サンプリングされたリクエストでルールを突き止め、IP セットを直す',
  minutes: 20,
  startPath: '/wafv2/webacls',
  scenario: wafEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、社内からショップを開くと **403 Forbidden** になるんです。お客さんからは普通に見えてるみたいなんですけど。'),
        hakase('403 は「お前には見せん」という門前払いだ。Lesson 21 で、S3 のオブジェクト URL を開いて食らったな。'),
        node('あのときはバケットが非公開だったからですよね。今回は社内からだけ…うちの会社、嫌われてるんですかね。'),
        hakase('心当たりは山ほどあるが、今回は別件だ。昨日、`198.51.100.77` から攻撃があってな。誰かが **AWS WAF** で、その送信元をブロックしたそうだ。'),
        node('誰かって誰ですか？'),
        hakase('犯人探しは Lesson 26 の CloudTrail でできるが、後回しだ。まずはお客さんと社員を助ける。'),
        node('で、わふ？'),
        hakase('Web Application Firewall の略だ。CloudFront の手前に立って、やってくるリクエストを 1 件ずつ検査し、ルールに合うものを止める。'),
        node('ファイアウォールなら、Lesson 09 の Security Group と Lesson 09-2 のネットワーク ACL でやりましたよね。'),
        hakase('うむ。あれらが見るのは IP アドレスとポート番号、つまり封筒の宛名だけだ。WAF は封筒を開けて、URL などの中身まで読む。'),
        node('手紙を勝手に開けて読むなんて、プライバシーの侵害じゃないですか。'),
        hakase('ウイルス入りの添付ファイルを、開けもせず部長に転送する係よりはマシだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('WAF の設定は、どこを見ればいいんですか？'),
        hakase('**ウェブ ACL** だ。ACL は Access Control List。ネットワーク ACL の ACL と同じ、許可と拒否の一覧表だな。今回は `webapp-acl` が CloudFront に付いておる。'),
        hakase('ウェブ ACL の中には **ルール** が並んでおる。**優先度** の小さい順に調べて、最初に一致したルールの **アクション** を使う。'),
        node('ネットワーク ACL のルール番号と同じですね。小さい番号から見て、最初に一致したもので決まる。'),
        hakase('よく覚えておった。今日は雪か。いや、雹だな。'),
        node('で、あくしょん、っていうのは？'),
        hakase('一致したときの扱いだ。Allow (通す)、Block (止めて 403 を返す)、Count (止めずに数えるだけ) などがある。どのルールにも一致しなければ **デフォルトアクション**。`webapp-acl` は Allow だ。'),
        node('Count って、止めないなら何の意味があるんですか？'),
        hakase('新しいルールの試運転だ。本番のお客さんを止める前に、「止めていたら誰が止まったか」を数えられる。昨日の誰かさんに教えてやりたかったな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('`webapp-acl` のルールは 2 つだ。1 つ目の `block-bad-ips` は、**IP セット** `bad-ips` に載っている送信元を Block する。'),
        node('あいぴーせっと？'),
        hakase('ブロックしたい IP アドレスの範囲を、CIDR で並べた名簿だ。ルールはこの名簿を見て判断する。'),
        node('CIDR って、Lesson 04 でやった `/24` とか `/16` とかの書き方ですね。'),
        hakase('2 つ目の `AWS-AWSManagedRulesCommonRuleSet` は **マネージドルール** だ。'),
        node('まねーじど…誰かが管理してくれてるルール？'),
        hakase('うむ。AWS が作って、新しい攻撃の手口に合わせて更新し続けてくれるルールの詰め合わせだ。画面では「マネージドルールグループ」と出る。よくある攻撃のパターンを、自分で 1 つずつ書かずにすむ。'),
        node('冷凍食品の詰め合わせですね。チンするだけ。'),
        hakase('たとえば URL に `<script>alert(1)</script>` のようなスクリプトを仕込み、ページを見た他人のブラウザで実行させる **クロスサイトスクリプティング (XSS)**。そういう攻撃の「形」を見て止めるのだ。'),
        node('IP じゃなくて、手口で止めるんですね。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('僕の IP が、どのルールで止められたかを調べるには？'),
        hakase('ウェブ ACL の **サンプリングされたリクエスト** だ。WAF が検査したリクエストの一部を、送信元 IP・アクション・一致したルール付きで、見本として残しておる。'),
        node('防犯カメラの録画ですね。僕が映ってたら恥ずかしいな。'),
        hakase('映っておるから 403 なのだ。メニューは **WAF & Shield**。Shield は DDoS (大量のアクセスで押しつぶす攻撃) 対策のサービスで、今日は出番がない。'),
        hakase('CloudFront 用のウェブ ACL は CloudFront と同じくグローバル扱いで、画面のスコープにも「グローバル (CloudFront)」と出る。裏では Lesson 36 の証明書と同じ us-east-1 に住んでおる。さあ、録画を見に行くぞ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'どのルールで止まったか調べる',
      objective: 'ディストリビューションのドメイン名をブラウザで開いて 403 を確かめ、WAF のウェブ ACL `webapp-acl` の **サンプリングされたリクエスト** で、自分の IP を止めたルールを見つける',
      tasks: [
        { id: 'browse', title: 'CloudFront のドメイン名をブラウザで開く → 403 (Request blocked)', hint: 'ディストリビューションの一覧からドメイン名をコピーします。', done: blockedSeen },
        { id: 'sample', title: `WAF & Shield > ウェブ ACL > \`webapp-acl\` → 送信元 IP ${CLIENT_IP} の行を探す`, hint: 'ウェブ ACL 一覧で名前のリンクから開き、**概要** タブの「サンプリングされたリクエスト」で **送信元 IP** と **一致したルール** の列を見比べます。', done: (c) => blockedSeen(c) && visited(c, '/wafv2/webacls/webapp-acl') },
      ],
      validate: (c) =>
        blockedSeen(c) && visited(c, '/wafv2/webacls/webapp-acl')
          ? ok(
              node(`僕の IP ${CLIENT_IP} が、ルール \`block-bad-ips\` で BLOCK されています！ 攻撃元は .77 なのに…`),
              hakase('昨日の録画も見てみろ。.77 の `<script>` 入りのリクエストは、マネージドルールがちゃんと止めておる。'),
              node('本当だ。でも `/wp-login.php` とか `/.env` とかは ALLOW で通ってますね。'),
              hakase('管理画面や秘密の設定ファイルを探して回る、空き巣の下見だ。それを見て慌てて IP ごと止めたのだろう。では **ルール** タブの「ステートメント」(ルールが何を調べるかの条件) のリンクから、IP セットの中身を確かめるのだ。'),
            )
          : ng(hakase(`ディストリビューションの一覧で **ドメイン名** をコピーしてブラウザで開き、403 を確かめるのだ。それから WAF & Shield > ウェブ ACL > \`webapp-acl\` を開いて、サンプルから自分の IP (${CLIENT_IP}) の行を探せ。`)),
    },
    {
      type: 'exercise',
      title: 'IP セットを直す',
      objective: `IP セット \`bad-ips\` を、攻撃元 \`198.51.100.77\` だけをブロックする内容に直す (社内 ${CLIENT_IP} は含めない)`,
      tasks: [{ id: 'fix', title: 'ルール タブ → IP セット `bad-ips` → **IP アドレスを編集**', hint: '1 つの IP アドレスだけを指すなら /32 です。', hotspotId: 'waf-edit-ipset', done: (c) => ipFixed(c.env) }],
      validate: (c) => {
        if (!officeFree(c.env)) return ng(hakase(`まだ ${CLIENT_IP} が IP セットに含まれておる。198.51.100.0/24 は .0 から .255 までの 256 個だぞ。攻撃元 1 つだけなら \`/32\` だ。`));
        if (!attackerBlocked(c.env)) return ng(hakase('攻撃元 198.51.100.77 まで外してしまった。泥棒に合鍵を返してどうする。`198.51.100.77/32` の 1 行は残すのだ。'));
        return ok(
          node('`198.51.100.77/32` にしました。/24 だと、同じプロバイダーの範囲にいる社内まで巻き込んでいたんですね。'),
          hakase('そうだ。/24 で止めるのは、泥棒の住む町内ごと出入り禁止にしたようなものだ。その町内に、自分の会社があったわけだ。'),
          node('身内を締め出してたなんて…'),
          hakase('ブロックは「必要な範囲だけ」。Security Group やネットワーク ACL と同じ考え方だ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '開けることと、攻撃が止まることを確かめる',
      objective: `ブラウザで社内から開けることを確かめ、次に \`/?q=<script>alert(1)</script>\` を付けて開き、マネージドルールでブロックされることを確かめる`,
      tasks: [
        { id: 'ok', title: 'CloudFront のドメイン名を開く → 200 OK', hint: 'IP セットを直したら、同じドメイン名をパスを付けずに開き直します。まだ 403 なら、サンプルの **一致したルール** 列でどのルールに止められたかを確認します。', done: officeOk },
        { id: 'xss', title: 'URL の末尾に `/?q=<script>alert(1)</script>` を付けて開く → 403、サンプルのルールは `AWS-AWSManagedRulesCommonRuleSet`', hint: 'ドメイン名のすぐ後ろに続けて入力します (`…cloudfront.net/?q=<script>alert(1)</script>`)。止めたルールは、ウェブ ACL `webapp-acl` の「サンプリングされたリクエスト」の **一致したルール** 列で確認します。', done: xssBlocked },
      ],
      validate: (c) =>
        officeOk(c) && xssBlocked(c)
          ? ok(
              node('普通のページは開けて、`<script>` 付きは 403 で止まりました！ 止めたのは `AWS-AWSManagedRulesCommonRuleSet` です。'),
              hakase('IP で止めるルールは、攻撃元が IP を変えれば効かん。攻撃の「形」で止めるマネージドルールと組み合わせるのが基本だ。'),
              node('IP の名簿と、手口の見張り番の二段構えですね。'),
              hakase('そうだ。慌てて町内ごと締め出した誰かさんの始末書には、「落ち着いてサンプルを読むこと」と書いておいてやろう。'),
            )
          : ng(hakase('まずドメイン名だけを開いて 200 を確かめ、次に末尾へ `/?q=<script>alert(1)</script>` を付けて開くのだ。止まったら、サンプルの「一致したルール」を見ろ。')),
    },
    {
      type: 'quiz',
      question: hakase('`198.51.100.0/24` に含まれる IP アドレスはいくつかな？'),
      options: ['1 個', '24 個', '256 個'],
      answer: 2,
      explanation: [
        hakase('正解。/24 は先頭 24 ビットが同じアドレスで、残り 8 ビット分、2 の 8 乗で 256 個だ。Lesson 04 の表にもあったな。'),
        hakase('1 個だけなら /32。IPv4 アドレスは 32 ビットだから、全部固定というわけだ。32 ビットだ。32 ビット。'),
        node('なんで 2 回言ったんですか。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('新しい WAF ルールを本番に入れたい。お客さんを誤ってブロックしないための、安全な進め方はどれかな？'),
      options: ['まず Count (カウント) アクションで入れ、サンプルやメトリクスで誤検知がないか見てから Block にする', 'いきなり Block にして、苦情が来たら外す', 'デフォルトアクションを Block にする'],
      answer: 0,
      explanation: [
        hakase('正解。Count なら止めずに「一致した」ことだけを記録できる。サンプルや、Lesson 24 でやったメトリクスで巻き込みがないか見てから Block にするのだ。'),
        hakase('いきなり Block は今回の事故そのものだ。苦情が来るまでの売上は戻らん。デフォルトアクションを Block にしたら、お客さん全員が門前払いだ。'),
      ],
    },
  ],
};
