import { hakase, ng, node, ok, type LessonContent, type TaskContext } from '../../lesson/types';
import { subnetNamed, vpcNamed } from '../helpers';
import { failedAws, param, ranAws } from './helpers';
import type { CliPatches } from './types';

const vpcId = (c: TaskContext) => vpcNamed(c.env, 'webapp-vpc')?.vpcId ?? 'vpc-xxxxxxxx';

/* Lesson 02: 先輩の PC の設定のまま、既定のリージョンがバージニア北部になっている */
const US_EAST_CONFIG = '[default]\nregion = us-east-1\noutput = json\n';

const quiz02: LessonContent = {
  type: 'quiz',
  question: hakase('問題だ。`describe-subnets` の出力にあった `public-subnet-1a` と `public-subnet-1c`。この 2 つの違いは何かな？ `AvailabilityZone` と `VpcId` をよく見て答えるのだ。'),
  options: ['Region が違う', 'Availability Zone が違う', 'VPC が違う'],
  answer: 1,
  explanation: [
    hakase('正解。同じ Region、同じ VPC の中で、AZ だけが違う。片方の AZ が止まっても、もう片方でサービスを続けられるわけだ。'),
    node('`describe-availability-zones` の一覧にも、`ap-northeast-1b` は無かったですね。'),
    hakase('よく気づいた。多くのアカウントでは、東京で使える AZ は a, c, d の 3 つだ。ノード君が細かいところに気づくとは、明日は障害でも起きるのか。'),
  ],
};

const patches: CliPatches = {
  'what-is-aws': {
    summary: 'クラウドの考え方と、AWS CLI でサービスを呼び出す基本',
    steps: {
      4: {
        type: 'dialogue',
        lines: [
          hakase('その設定をどこでやるか。Web 画面の **AWS Management Console** もあるが、このコースでは **AWS CLI** を使う。'),
          node('しーえるあい？'),
          hakase('**Command Line Interface**、文字でコマンドを打って操作する道具だ。右の黒い画面が君の PC の**ターミナル**で、そこに `aws` で始まるコマンドを打つ。'),
          node('マウスでポチポチするほうが楽そうですけど…。'),
          hakase('100 台のサーバーに同じ設定をするとき、100 回ポチポチするか？ コマンドなら、1 行書いて繰り返すだけだ。手順書にも貼れるし、間違えた手順を後から調べるのも楽だ。'),
          node('なるほど。コピペできる手順書になるんですね。'),
          hakase('AWS の機能は 200 以上の**サービス**に分かれておる。**仮想サーバー**のサービスが **EC2** (Elastic Compute Cloud)、自分専用のネットワークのサービスが **VPC** (Virtual Private Cloud) だ。VPC は Lesson 03 でじっくりやる。'),
          node('かそうさーばー？'),
          hakase('大きな物理サーバーをソフトウェアで区切って作った、借りものの 1 台だ。EC2 で借りた 1 台 1 台を**インスタンス**と呼ぶ。'),
          node('いんすたんす。カップ麺みたいにすぐできるから？'),
          hakase('それはインスタントだ。インスタンスは「実体」「1 個のもの」という意味だ。コマンドの形は `aws <サービス> <操作>`。例えば EC2 のインスタンスの一覧なら `aws ec2 describe-instances` だ。describe は「説明する」、つまり見るだけの操作だな。'),
          node('打ったらどうなるんですか？'),
          hakase('AWS の **API** (プログラムから呼び出す窓口) に問い合わせて、答えが **JSON** という形式で返ってくる。`{ }` と `" "` だらけの、機械に読みやすい書き方だ。'),
          node('じぇいそん…。人間には読みにくいやつですね。'),
          hakase('慣れれば読める。なお、ここはシミュレーターだ。何を打っても本物の AWS にはつながらんし、請求書も来ん。本物で壊すと請求書と始末書が同時に届くから、今のうちに存分に壊しておきたまえ。'),
        ],
      },
      5: {
        type: 'exercise',
        title: 'AWS CLI を打ってみる',
        objective: '`aws ec2 describe-instances` で EC2 インスタンスの一覧を、`aws ec2 describe-vpcs` で VPC の一覧を表示する',
        tasks: [
          { id: 'instances', title: '`aws ec2 describe-instances` を実行する', hint: '右のターミナルをクリックして `aws ec2 describe-instances` と打ち、Enter を押します。', command: 'aws ec2 describe-instances', done: (c) => !!ranAws(c, 'ec2 describe-instances') },
          { id: 'vpc', title: '`aws ec2 describe-vpcs` を実行する', hint: 'サービスは同じ `ec2`、操作が `describe-vpcs` です。↑ キーで前のコマンドを呼び出して直すと楽です。', command: 'aws ec2 describe-vpcs', done: (c) => !!ranAws(c, 'ec2 describe-vpcs') },
        ],
        validate: (c) =>
          ranAws(c, 'ec2 describe-instances') && ranAws(c, 'ec2 describe-vpcs')
            ? ok(
                hakase('よし。`aws <サービス> <操作>` で API を呼び、JSON で答えが返る。これが CLI の基本動作だ。'),
                node('インスタンスの JSON の `Tags` に `web-1` と `web-2` がありました。あれは誰のサーバーですか？'),
                hakase('先輩が作った Web サーバーだ。見るのはよいが、うっかり止めたら君の評価も止まるぞ。'),
                node('JSON が長すぎて、画面の上に流れていっちゃいました。'),
                hakase('欲しいところだけを抜き出す技は、この先で教える。今は、サービスごとの操作の一覧が `aws ec2 help` で見られることだけ覚えておけばよい。'),
              )
            : ng(hakase('まだ打っていないコマンドがあるようだ。チェックリストで未完了の項目を見たまえ。`aws`、サービス名、操作名の間は半角スペースで区切るのだ。')),
      },
      7: {
        type: 'dialogue',
        lines: [
          node('次は何を学ぶんですか？'),
          hakase('**Region** (リージョン) だ。リソースが置かれる場所を表しておる。この PC の CLI は、`ap-northeast-1` という Region に問い合わせるよう設定してある。'),
          node('りーじょん？ りそーす？'),
          hakase('**リソース**は、AWS で作ったサーバーやネットワークなど、一つ一つの部品のことだ。Region はそれを置く地域、と今は覚えておけばよい。'),
          node('地域なんて、ずっと同じでいいじゃないですか。'),
          hakase('そう思っておる新人が、ある日「作ったはずのリソースが消えた！」と大騒ぎするのだ。毎年恒例の行事だな。'),
          node('予言みたいに言わないでくださいよ。'),
          hakase('予言ではない、統計だ。詳しくは次のレッスンでやる。'),
        ],
      },
    },
  },

  'region-az': {
    summary: 'リソースはどこにある？CLI の Region の設定と AZ の意味',
    files: () => ({ '.aws/config': US_EAST_CONFIG }),
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、大変です！ 先輩に借りた PC で `aws ec2 describe-vpcs` を打ったら、`"Vpcs": []` って空っぽなんです！ `webapp-vpc` が消されちゃった!?'),
          hakase('ほう、ついに消したか。退職届の書き方なら教えてやろう。'),
          node('僕じゃないですよ！ 打ったらもう無かったんです！'),
          hakase('冗談だ。落ち着いて `aws configure get region` と打ってみるのだ。CLI がどこに問い合わせておるかが分かる。'),
          node('`us-east-1`…。Lesson 01 では `ap-northeast-1` でしたよね。'),
          hakase('うむ。それが **Region** (リージョン) だ。Lesson 01 の最後に「リソースを置く地域」だと言ったな。'),
          node('言ってました。予言も当たりました。'),
          hakase('統計だと言ったろう。Region は、AWS が世界各地に持っておる拠点だ。東京、大阪、バージニア北部、アイルランド…と、世界中にある。'),
          node('拠点ごとに、返ってくる中身が違うんですか？'),
          hakase('AWS のリソースの多くは **Region ごとに独立**しておる。東京 Region で作った VPC は、バージニア北部 Region に問い合わせても出てこないのだ。'),
          node('VPC って、AWS の中に作る自分専用のネットワークでしたよね。消えたんじゃなくて、別の拠点の棚を見てただけ、ってことですか。'),
          hakase('そういうことだ。東京支店の書類を、アメリカ支店の棚で探しておったわけだ。'),
        ],
      },
      1: {
        type: 'dialogue',
        lines: [
          node('でも、なんで世界中に分かれてるんですか？ 1 か所にまとめたほうが楽なのに。'),
          hakase('理由はいくつかある。まず距離だ。日本のお客さんには、アメリカのサーバーより東京のサーバーのほうが速く応答できる。'),
          node('近いほうが速い。宅配便と同じですね。'),
          hakase('次に規則だ。「データは国内に置くこと」と決めている会社もある。そして災害。東京が大地震で止まっても、大阪にも用意しておけば助かる。'),
          node('もし全部止まったら、博士はどうするんですか？'),
          hakase('祈る。ワシは祈りの専門家ではないがな。…さて、Region には **Region コード**という ID がある。さっきの `us-east-1` はバージニア北部、東京は `ap-northeast-1` だ。'),
          node('えーぴー のーすいーすと わん？ 呪文ですか？'),
          hakase('ap は Asia Pacific (アジアパシフィック)、northeast は北東、1 は番号だ。大阪は `ap-northeast-3` になる。東京の `ap-northeast-1` だけは今覚えておけ。CLI でもエラーでも、この先何百回と見ることになる。'),
          node('先輩の PC は、なんで `us-east-1` になってたんですか？'),
          hakase('バージニア北部は AWS で最初にできた一番古い Region でな、ドキュメントの例もここが多い。例をそのまま写して設定した PC は、だいたいこうなっておる。毎年この時期は「消えた！」の声が風物詩だ。'),
          node('季語にしないでください。'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          node('表にある Availability Zone っていうのは何ですか？'),
          hakase('Region の中には、電源やネットワークが独立したデータセンターの集まりが複数ある。それが **Availability Zone**、略して **AZ** だ。'),
          node('データセンターって、Lesson 01 で出てきた、サーバーを大量に並べる建物でしたよね。'),
          hakase('うむ。窓がなくて冷房が効きすぎておってな。夜勤のワシはいつも毛布にくるまっておった。'),
          node('博士の昔話はいいです。AZ は、Region の中にある建物のグループってことですね。'),
          hakase('その理解でよい。なぜ分かれておるかは後でやる。まずは表を見て、CLI の Region を東京に切り替えるのだ。`aws configure set region ap-northeast-1` で設定ファイル (`~/.aws/config`) を書き換えられる。'),
          node('1 回だけ別の Region を見たいときは？'),
          hakase('コマンドの後ろに `--region us-east-1` のように付ければ、そのコマンドだけ別の Region に問い合わせる。設定より `--region` のほうが優先だ。'),
        ],
      },
      4: {
        type: 'exercise',
        title: 'Region を切り替えてリソースを見つける',
        objective: 'CLI の Region を **ap-northeast-1 (東京)** にして、`webapp-vpc` を見つける',
        tasks: [
          { id: 'check', title: '`aws configure get region` でいまの Region を確かめる', hint: '設定ファイルの region が表示されます。', command: 'aws configure get region', done: (c) => !!ranAws(c, 'configure get', (x) => param(x, 'varname') === 'region') },
          { id: 'region', title: 'Region を `ap-northeast-1` に設定する', hint: '`aws configure set region ap-northeast-1` で設定を書き換えます (`--region ap-northeast-1` を付けて打つだけでも構いません)。', command: 'aws configure set region ap-northeast-1', done: (c) => !!ranAws(c, 'configure set', (x) => param(x, 'varname') === 'region' && param(x, 'value') === 'ap-northeast-1') },
          { id: 'find', title: '`aws ec2 describe-vpcs` で `webapp-vpc` が表示されることを確認', hint: '`"Value": "webapp-vpc"` のタグが付いた VPC が返ってくれば成功です。', command: 'aws ec2 describe-vpcs', done: (c) => !!ranAws(c, 'ec2 describe-vpcs', (x) => x.region === 'ap-northeast-1') },
        ],
        validate: (c) => {
          if (ranAws(c, 'ec2 describe-vpcs', (x) => x.region === 'ap-northeast-1'))
            return ok(
              node('ありました！ `webapp-vpc`、ちゃんと東京にいました…。'),
              hakase('「リソースが消えた！」の原因の多くは Region 違いだ。慌てる前に、まず Region を確かめる。これを習慣にするのだ。'),
              node('先輩に「消しちゃいました」って謝りに行くところでした。'),
              hakase('無実の罪で始末書を書くのは、ワシだけで十分だ。'),
            );
          const last = ranAws(c, 'ec2 describe-vpcs');
          return ng(hakase(last ? `最後の \`describe-vpcs\` は ${last.region} に問い合わせておる。\`aws configure set region ap-northeast-1\` で設定を変えるか、\`--region ap-northeast-1\` を付けて打ち直すのだ。` : '`aws ec2 describe-vpcs` をまだ打っておらんようだ。Region を `ap-northeast-1` にしてから打つのだ。'));
        },
      },
      5: {
        type: 'dialogue',
        lines: [
          hakase('東京に戻ったところで、お待ちかねの AZ だ。東京 Region の中には AZ が 3 つある。'),
          node('表にあった `ap-northeast-1a` とかですね。Region コードの後ろに a とか c とかを付けるだけなんだ。'),
          hakase('そうだ。そして新しい言葉をもう 1 つ。**Subnet** (サブネット) だ。'),
          node('さぶねっと？ サブのネット…補欠のネットワークですか？'),
          hakase('補欠ではない。VPC の中を区切った、小さなネットワークだ。VPC が家なら、Subnet は部屋だな。詳しくは Lesson 05 でやる。'),
          node('部屋ですか。それが AZ とどう関係するんです？'),
          hakase('**Subnet は必ず 1 つの AZ に属する**。部屋ごとに、どの建物に作るかが決まっておるのだ。'),
          node('AZ が分かれてると、何がうれしいんですか？'),
          hakase('ある AZ で停電や火災が起きても、別の AZ は影響を受けにくい。だから本番のシステムは **2 つ以上の AZ** にサーバーを分けて置くのだ。'),
          node('卵を 1 つのカゴに盛るな、ってやつですね。'),
          hakase('うむ。1 つの AZ に全部置いて、そこが止まったらどうなるか。サービスが止まり、電話が鳴り、君の週末も止まる。'),
          node('週末は止めないでください。'),
          hakase('では確かめよう。`aws ec2 describe-availability-zones` で東京の AZ を、`aws ec2 describe-subnets` で各 Subnet の `AvailabilityZone` を見てみるのだ。'),
        ],
      },
      6: {
        type: 'exercise',
        title: 'Subnet の AZ を確認する',
        objective: '東京 Region の AZ の一覧と、各 Subnet の Availability Zone を確認する',
        tasks: [
          { id: 'azs', title: '`aws ec2 describe-availability-zones` で AZ の一覧を見る', hint: '`ZoneName` が AZ の名前です。', command: 'aws ec2 describe-availability-zones', done: (c) => !!ranAws(c, 'ec2 describe-availability-zones', (x) => x.region === 'ap-northeast-1') },
          { id: 'subnets', title: '`aws ec2 describe-subnets` で Subnet の AZ を見る', hint: '各 Subnet の `AvailabilityZone` と、`Tags` の `Name` を見比べます。', command: 'aws ec2 describe-subnets', done: (c) => !!ranAws(c, 'ec2 describe-subnets', (x) => x.region === 'ap-northeast-1') },
        ],
        validate: (c) =>
          ranAws(c, 'ec2 describe-subnets', (x) => x.region === 'ap-northeast-1')
            ? ok(
                node('`AvailabilityZone` に、`ap-northeast-1a` と `ap-northeast-1c` の 2 種類がありますね。'),
                hakase('うむ。先輩は一応、2 つの AZ に分けて作っておったようだ。先輩の評価を 1 つ上げておこう。'),
                hakase('ついでに君の評価も上げたいところだが、それは次の問題しだいだ。'),
              )
            : ng(hakase('東京 (`ap-northeast-1`) に問い合わせた `aws ec2 describe-subnets` がまだ無いようだ。Region の設定を確かめてから打つのだ。')),
      },
      7: quiz02,
    },
  },

  vpc: {
    summary: 'AWS CLI で自分専用のネットワーク (VPC) を作る',
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          node('そういえば Lesson 01 で `describe-vpcs` を打ったとき、`"IsDefault": true` で `172.31.0.0/16` の VPC がありましたよ？'),
          hakase('それは**デフォルト VPC** だ。AWS がどの Region にも最初から用意しておる VPC で、すぐ EC2 を試せるようになっておる。`172.31.` も、さっきのプライベート IP アドレスの範囲だ。'),
          node('じゃあ、それを使えば作らなくていいんじゃ…。'),
          hakase('お試しには便利だが、間取りは AWS が決めたものだ。本番環境は、自分で設計した VPC を作るのが普通だ。他人が決めた間取りに一生住むつもりか。'),
          node('賃貸派なので…。'),
          hakase('賃貸でも部屋は選ぶだろう。では作り方だ。VPC を作る操作は `aws ec2 create-vpc`。CIDR は `--cidr-block 10.0.0.0/16` のように**オプション**で渡す。'),
          node('おぷしょん？'),
          hakase('`--` で始まる、コマンドへの追加の指示だ。`--名前 値` の組で書く。`aws ec2 create-vpc help` と打てば、使えるオプションの一覧が出る。'),
          node('名前はどうやって付けるんですか？'),
          hakase('AWS のリソースには**タグ**という付箋を貼れる。キーが `Name` のタグが名前で、今回は `webapp-vpc` だ。作るときに `--tag-specifications \'ResourceType=vpc,Tags=[{Key=Name,Value=webapp-vpc}]\'` と付ければ、作ると同時に貼れる。'),
          node('呪文が長い…。'),
          hakase('`キー=値` をカンマでつなぐ書き方を **shorthand 構文**という。`ResourceType=vpc` で「VPC に貼るタグ」、`Tags=[...]` の中がタグの中身だ。シェルが `[` や `{` を勝手に解釈せんよう、全体を `\'` で囲むのを忘れるな。'),
          node('付箋を貼らなかったらどうなるんですか？'),
          hakase('一覧には `vpc-0a1b2c...` という ID しか出ん。半年後、誰が何のために作ったか分からん VPC が並ぶ。ワシはそれを「遺跡」と呼んでおる。'),
        ],
      },
      3: {
        type: 'exercise',
        title: 'VPC を作成する',
        objective: '名前タグ `webapp-vpc`、IPv4 CIDR `10.0.0.0/16` の VPC を `aws ec2 create-vpc` で作成する',
        tasks: [
          { id: 'list', title: '`aws ec2 describe-vpcs` でデフォルト VPC を確かめる', hint: '`"IsDefault": true` の VPC があるはずです。', command: 'aws ec2 describe-vpcs', done: (c) => !!ranAws(c, 'ec2 describe-vpcs') },
          {
            id: 'submit',
            title: '`webapp-vpc` (`10.0.0.0/16`) を作成する',
            hint: '`aws ec2 create-vpc --cidr-block 10.0.0.0/16` に、Name タグを付ける `--tag-specifications` を足します。',
            command: "aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=webapp-vpc}]'",
            done: (c) => !!vpcNamed(c.env, 'webapp-vpc'),
          },
        ],
        validate: (c) => {
          const v = vpcNamed(c.env, 'webapp-vpc');
          if (!v)
            return ng(
              hakase('`webapp-vpc` という名前の VPC がまだ無いようだ。タグを付け忘れて作ったなら、`aws ec2 create-tags --resources <VPC ID> --tags Key=Name,Value=webapp-vpc` で後から貼れる。'),
              hakase('VPC ID は `aws ec2 describe-vpcs` の `VpcId` だ。'),
            );
          if (v.cidrBlock !== '10.0.0.0/16')
            return ng(
              hakase(`CIDR が ${v.cidrBlock} になっておる。今回は \`10.0.0.0/16\` だ。`),
              node('じゃあ、もう 1 つ作り直せば…。'),
              hakase(`VPC の CIDR は後から変えられんし、同じ名前の VPC が 2 つあっては紛らわしいだけだ。\`aws ec2 delete-vpc --vpc-id ${v.vpcId}\` で消してから、作り直すのだ。`),
            );
          return ok(
            hakase('できたな。`webapp-vpc` の誕生だ。返ってきた JSON の `VpcId` を見てみるのだ。'),
            node('`vpc-` から始まる長い文字列ですね。`"State": "pending"` ってなってますけど、失敗ですか？'),
            hakase('作り始めた直後の状態だ。すぐ `available` になる。`VpcId` は AWS がリソースごとに付ける一意の ID、社員番号のようなものだ。この先のコマンドでは、名前ではなくこの ID で VPC を指定する。'),
            node('名前タグは、同じ名前が付けられちゃうんですね。'),
            hakase('そうだ。同じ名前の VPC が 2 つ並んで、間違えて本番のほうを消した男をワシは知っておる。誰かは武士の情けで伏せておこう。'),
          );
        },
      },
      4: {
        type: 'dialogue',
        lines: [
          hakase('実は VPC を作ると、頼んでもいないのにいくつかのリソースが**自動で**作られる。'),
          node('おまけが付いてくるんですか？ 得した気分です。'),
          hakase('おまけというより、無いと困る最低限の備品だ。まず**ルートテーブル**。'),
          node('るーとてーぶる？'),
          hakase('「この宛先へのデータは、ここへ送れ」という道案内の表だ。カーナビの行き先リストのようなものだな。VPC を作ると、最初の 1 枚が**メインルートテーブル**として作られる。'),
          node('メインってことは、サブもあるんですか？'),
          hakase('自分で追加できる。どの Subnet がどの表を使うかは Lesson 07 でやる。次に**セキュリティグループ**。Lesson 01 で出てきた、サーバーの前に立つ門番だ。'),
          node('Security Group でしたよね。SSH を全世界に開けて怒られるやつ。'),
          hakase('覚え方が不吉だが、合っておる。VPC ごとに「default」のセキュリティグループが 1 つ作られる。それから**ネットワーク ACL**。こちらは Subnet の出入口に立つ関所だ。Lesson 09-2 でやる。'),
          node('では、インターネットとの出入口は？'),
          hakase('その出入口を**インターネットゲートウェイ**という。自動で作られるかどうか、自分の目で確かめたまえ。ただし、ほかの VPC のものまで出てくると見づらい。そこで 2 つ技を教える。'),
          node('技ですか。'),
          hakase('1 つ目は `--query`。JSON から欲しいところだけを抜き出す。`--query \'Vpcs[0].VpcId\' --output text` なら、最初の VPC の ID だけが素の文字で出る。2 つ目は `--filters`。`--filters Name=tag:Name,Values=webapp-vpc` で、Name タグが `webapp-vpc` のものだけに絞る。'),
          node('組み合わせると、`webapp-vpc` の ID だけが出るんですね。'),
          hakase('うむ。`VPC_ID=$(...)` のように変数に入れておけば、次のコマンドで `$VPC_ID` と書くだけで済む。ID を手でコピーして 1 文字間違える事故とも、おさらばだ。'),
        ],
      },
      5: {
        type: 'exercise',
        title: '自動で作られたものを確認する',
        objective: '`webapp-vpc` の VPC ID を取り出し、その VPC のルートテーブルとインターネットゲートウェイを確認する',
        tasks: [
          {
            id: 'detail',
            title: '`--filters` と `--query` で `webapp-vpc` の VPC ID だけを表示する',
            hint: "`aws ec2 describe-vpcs --filters Name=tag:Name,Values=webapp-vpc --query 'Vpcs[0].VpcId' --output text`。`VPC_ID=$(...)` で変数に入れても構いません。",
            command: "VPC_ID=$(aws ec2 describe-vpcs --filters Name=tag:Name,Values=webapp-vpc --query 'Vpcs[0].VpcId' --output text); echo $VPC_ID",
            done: (c) => !!ranAws(c, 'ec2 describe-vpcs', (x) => !!x.query && x.output.includes(vpcNamed(c.env, 'webapp-vpc')?.vpcId ?? '-')),
          },
          {
            id: 'rts',
            title: '`webapp-vpc` のルートテーブルを見る',
            hint: '`aws ec2 describe-route-tables --filters Name=vpc-id,Values=<VPC ID>`。`"Main": true` の関連付けがあるのがメインルートテーブルです。',
            command: (c) => `aws ec2 describe-route-tables --filters Name=vpc-id,Values=${vpcId(c)}`,
            done: (c) => !!ranAws(c, 'ec2 describe-route-tables', (x) => param(x, 'filters').includes(vpcNamed(c.env, 'webapp-vpc')?.vpcId ?? '-')),
          },
          {
            id: 'igw',
            title: '`webapp-vpc` につながったインターネットゲートウェイを探す',
            hint: '`aws ec2 describe-internet-gateways --filters Name=attachment.vpc-id,Values=<VPC ID>`',
            command: (c) => `aws ec2 describe-internet-gateways --filters Name=attachment.vpc-id,Values=${vpcId(c)}`,
            done: (c) => !!ranAws(c, 'ec2 describe-internet-gateways'),
          },
        ],
        validate: (c) =>
          ranAws(c, 'ec2 describe-route-tables', (x) => param(x, 'filters').includes(vpcNamed(c.env, 'webapp-vpc')?.vpcId ?? '-'))
            ? ok(
                hakase('`webapp-vpc` のルートテーブルが 1 枚あったな。`Associations` の `"Main": true` が、自動で作られたメインルートテーブルの印だ。'),
                node('頼んでないのに、ちゃんとできてますね。でもインターネットゲートウェイは `"InternetGateways": []` で空っぽでした。'),
                hakase('ほう、よく見ておる。その答え合わせは問題でやろう。'),
              )
            : ng(hakase('`aws ec2 describe-route-tables` に `--filters Name=vpc-id,Values=<webapp-vpc の VPC ID>` を付けて打ってみるのだ。VPC ID は、さっき `--query` で取り出したものだ。')),
      },
    },
  },

  cidr: {
    steps: {
      5: {
        type: 'quiz',
        question: hakase('準備運動だ。`10.0.1.0/24` の Subnet で、EC2 などに割り当てられる IP アドレスは何個かな？'),
        options: ['256 個', '254 個', '251 個'],
        answer: 2,
        explanation: [
          hakase('正解。256 − 5 = 251 個だ。`aws ec2 describe-subnets` の `AvailableIpAddressCount` にも、この数が出る。'),
          node('表札、案内係、電話帳、予約札、一斉送信。5 個引くのを忘れませんでした。'),
          hakase('妙な覚え方だが、忘れんならそれでよい。'),
        ],
        wrong: [hakase('普通のネットワークの教科書なら 254 だが、ここは AWS だ。AWS が各 Subnet で予約するアドレスは何個だったかな？ 表の右端の列を思い出すのだ。')],
      },
      7: {
        type: 'exercise',
        title: 'CIDR の検証を体験する',
        objective: '`webapp-vpc` に、サブネット名 `cidr-practice`、CIDR `10.0.100.0/24` の Subnet を作成する (先に `10.1.0.0/24` を試してエラーも見る)',
        tasks: [
          {
            id: 'create',
            title: 'わざと VPC の外の `10.1.0.0/24` で `aws ec2 create-subnet` を打ち、エラーを見る',
            hint: '`--vpc-id` には `webapp-vpc` の VPC ID を入れます (`aws ec2 describe-vpcs` の `VpcId`)。`InvalidSubnet.Range` のエラーが返ってくれば成功です。',
            command: (c) => `aws ec2 create-subnet --vpc-id ${vpcId(c)} --cidr-block 10.1.0.0/24`,
            done: (c) => !!failedAws(c, 'ec2 create-subnet', 'InvalidSubnet.Range'),
          },
          {
            id: 'made',
            title: '`10.0.100.0/24` で `cidr-practice` を作成',
            hint: "Name タグは `--tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=cidr-practice}]'` で付けます。",
            command: (c) => `aws ec2 create-subnet --vpc-id ${vpcId(c)} --cidr-block 10.0.100.0/24 --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=cidr-practice}]'`,
            done: (c) => subnetNamed(c.env, 'cidr-practice')?.cidrBlock === '10.0.100.0/24',
          },
        ],
        validate: (c) =>
          subnetNamed(c.env, 'cidr-practice')?.cidrBlock === '10.0.100.0/24'
            ? ok(
                hakase('よし。`10.1.0.0/24` のエラーも見られたかな？ VPC の外にはみ出した Subnet は、AWS が門前払いするのだ。'),
                node('`An error occurred (InvalidSubnet.Range)` って英語で怒られました。でも `10.0.100.0/24` なら、すんなり通りましたね。'),
                hakase('ついでにもう 1 つ。同じ VPC の中で、Subnet どうしの範囲が**重なる**ことも許されん。1 つの住所に部屋が 2 つあったら、郵便屋さんが困るだろう。'),
                node('どっちに届ければいいか分からないですもんね。'),
              )
            : ng(hakase('`cidr-practice` (`10.0.100.0/24`) がまだ見当たらんな。`aws ec2 create-subnet` に `--vpc-id` (webapp-vpc の ID)、`--cidr-block`、Name タグの `--tag-specifications` を付けるのだ。名前を付け忘れたなら `aws ec2 create-tags` で後から貼れる。')),
      },
    },
  },

  subnet: {
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          hakase('今日は Web サーバー用の部屋を、東京の 2 つの AZ に 1 つずつ作る。名前は `public-subnet-1a` と `public-subnet-1c` だ。'),
          node('名前の最後の `1a` と `1c` は、AZ の `ap-northeast-1a` と `ap-northeast-1c` から取ってるんですね。'),
          hakase('そうだ。名前を見ただけでどの AZ か分かるようにしておく。半年後の自分への親切だ。半年後も君がこの会社におれば、の話だがな。'),
          node('いますよ！ 博士より給料をもらうまでは辞めません。'),
          hakase('ほう。では定年まで辞められんな。'),
          node('…。CIDR はどうするんですか？'),
          hakase('`10.0.1.0/24` と `10.0.2.0/24` だ。Lesson 04 の復習だが、どちらも `webapp-vpc` の `10.0.0.0/16` の内側かな？'),
          node('どっちも `10.0.` で始まるから内側です。`/24` だから 256 個、AWS の予約 5 個を引いて 251 個使えます。2 つの範囲も重なってません。'),
          hakase('完璧だ。`aws ec2 create-subnet` に、`--vpc-id`・`--availability-zone`・`--cidr-block` と、Name タグの `--tag-specifications` を付ける。'),
          node('`--vpc-id` には、`webapp-vpc` の ID を入れるんですよね。'),
          hakase('そこが罠だ。`describe-vpcs` の一覧の先頭はデフォルト VPC のことがある。先頭の ID を何も考えずにコピーすると、部屋が隣の家に建つ。Lesson 03 の `--filters` で `webapp-vpc` の ID を取り出すのだ。'),
          node('隣の家に勝手に部屋を建てたら、怒られますもんね。'),
        ],
      },
      2: {
        type: 'exercise',
        title: '2 つの AZ に Subnet を作る',
        objective: '`webapp-vpc` に `public-subnet-1a` (`10.0.1.0/24`, ap-northeast-1a) と `public-subnet-1c` (`10.0.2.0/24`, ap-northeast-1c) を作成する',
        tasks: [
          {
            id: 'open',
            title: '`webapp-vpc` の VPC ID を確かめる',
            hint: "`aws ec2 describe-vpcs --filters Name=tag:Name,Values=webapp-vpc --query 'Vpcs[0].VpcId' --output text`",
            command: "aws ec2 describe-vpcs --filters Name=tag:Name,Values=webapp-vpc --query 'Vpcs[0].VpcId' --output text",
            done: (c) => !!ranAws(c, 'ec2 describe-vpcs'),
          },
          {
            id: '1a',
            title: '`public-subnet-1a` / `ap-northeast-1a` / `10.0.1.0/24`',
            hint: '`--availability-zone ap-northeast-1a` を付けます。',
            command: (c) => `aws ec2 create-subnet --vpc-id ${vpcId(c)} --availability-zone ap-northeast-1a --cidr-block 10.0.1.0/24 --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=public-subnet-1a}]'`,
            done: (c) => subnetNamed(c.env, 'public-subnet-1a')?.availabilityZone === 'ap-northeast-1a',
          },
          {
            id: '1c',
            title: '`public-subnet-1c` / `ap-northeast-1c` / `10.0.2.0/24`',
            hint: '↑ キーで前のコマンドを呼び出し、AZ・CIDR・名前の 3 か所を直すと楽です。',
            command: (c) => `aws ec2 create-subnet --vpc-id ${vpcId(c)} --availability-zone ap-northeast-1c --cidr-block 10.0.2.0/24 --tag-specifications 'ResourceType=subnet,Tags=[{Key=Name,Value=public-subnet-1c}]'`,
            done: (c) => subnetNamed(c.env, 'public-subnet-1c')?.availabilityZone === 'ap-northeast-1c',
          },
        ],
        validate: (c) => {
          const vpc = vpcNamed(c.env, 'webapp-vpc');
          const a = subnetNamed(c.env, 'public-subnet-1a');
          const b = subnetNamed(c.env, 'public-subnet-1c');
          if (!a || !b) return ng(hakase('2 つの Subnet がそろっていないようだ。`aws ec2 describe-subnets --filters Name=vpc-id,Values=<VPC ID>` で、`Name` タグが `public-subnet-1a` と `public-subnet-1c` のものがあるか確かめるのだ。名前を付け忘れただけなら `aws ec2 create-tags` で貼れる。CIDR が重なって作れんときは、`aws ec2 delete-subnet --subnet-id <ID>` で間違えたほうを消してから作り直すのだ。'));
          if (a.vpcId !== vpc?.vpcId || b.vpcId !== vpc?.vpcId)
            return ng(
              hakase('Subnet が `webapp-vpc` 以外の VPC に作られておる。`--vpc-id` にデフォルト VPC (`172.31.0.0/16`) の ID を入れなかったか？'),
              hakase('建ててしまった部屋は動かせん。`aws ec2 delete-subnet --subnet-id <ID>` で間違えたほうを消し、`--vpc-id` に `webapp-vpc` の ID を入れて作り直すのだ。'),
            );
          if (a.availabilityZone === b.availabilityZone) return ng(hakase('2 つとも同じ AZ だ。これでは AZ 障害で 2 つそろって倒れる。`public-subnet-1c` は `--availability-zone ap-northeast-1c` で作るのだ。AZ は後から変えられんから、`aws ec2 delete-subnet` で消して作り直す。'));
          if (a.cidrBlock !== '10.0.1.0/24' || b.cidrBlock !== '10.0.2.0/24') return ng(hakase('CIDR が指定と違うようだ。`public-subnet-1a` は `10.0.1.0/24`、`public-subnet-1c` は `10.0.2.0/24` だ。CIDR も後から変えられん。`aws ec2 delete-subnet` で消して作り直すのだ。'));
          return ok(
            hakase('完璧だ。`webapp-vpc` の中に、2 つの AZ にまたがって部屋ができた。'),
            node('`ap-northeast-1a` の部屋と `ap-northeast-1c` の部屋。片方の建物が停電しても、もう片方は無事、ってことですね。'),
            hakase('うむ。これで AZ 障害が起きても、深夜に電話で叩き起こされる確率が少し下がる。ゼロにはならんがな。'),
          );
        },
      },
      3: {
        type: 'dialogue',
        lines: [
          node('名前に public って付けたので、これで Public subnet ですね！'),
          hakase('……残念ながら、そうはならん。名前は付箋にすぎん。段ボールに「金庫」と書いても、金庫にはならんだろう。'),
          node('ぱぶりっく さぶねっと って、そもそも何なんですか？'),
          hakase('インターネットと直接やりとりできる Subnet のことだ。逆に、インターネットから直接は届かない Subnet を **Private subnet** という。'),
          node('表通りに面した部屋と、奥の部屋みたいなものですね。'),
          hakase('うむ。では何で決まるか。`aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<public-subnet-1a の ID>` と打ってみたまえ。'),
          node('…`"RouteTables": []`。空っぽです。ルートテーブルが無いんですか？'),
          hakase('Subnet を作っただけだと、どの表とも**明示的には**関連付けられておらん。その場合は Lesson 03 で見た**メインルートテーブル**を使うことになる。`Name=association.main,Values=true` で絞れば出てくる。'),
          node('ルートテーブルって、「この宛先へのデータはここへ送れ」っていう道案内の表でしたよね。'),
          hakase('そうだ。その表の 1 行 1 行を**ルート** (route、経路) という。Public かどうかは、その Subnet が使うルートテーブルに**インターネットゲートウェイへのルートがあるか**で決まる。'),
          node('インターネットゲートウェイって、VPC を作っても自動では作られない、インターネットとの出入口でしたよね。'),
          hakase('よく覚えておる。そしてこの VPC には、まだその出入口すら無い。玄関のない家に「表通り側」と名札を付けても、客は来ん。'),
          node('じゃあ、今の 2 つの部屋は…。'),
          hakase('名前だけ public の、中身は private だ。本物の Public subnet にする方法は、次の Lesson 06 でやる。'),
        ],
      },
    },
  },
};

export default patches;

