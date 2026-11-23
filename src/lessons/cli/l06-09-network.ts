import { hakase, ng, node, ok, type LessonContent, type TaskContext } from '../../lesson/types';
import { byName } from '../../sim/env';
import type { HttpResult } from '../../sim/http';
import { evaluateNacl } from '../../sim/nacl';
import { canConnectFromInternet, CLIENT_IP } from '../../sim/network';
import { effectiveRouteTable } from '../../sim/vpc';
import { instanceNamed, isSubnetPublic, lastRequestTo, naclNamed, rtNamed, sgAllows, sgNamed, subnetNamed, vpcNamed } from '../helpers';
import { ranAws } from './helpers';
import type { CliPatches } from './types';

/* ---- 今の環境の ID (模範解答のコマンドに埋める。無ければ形だけの ID) ---- */
const subnetId = (c: TaskContext, name: string) => subnetNamed(c.env, name)?.subnetId;
const rtId = (c: TaskContext, name: string) => rtNamed(c.env, name)?.routeTableId;
const igwId = (c: TaskContext) => byName(c.env.internetGateways, 'webapp-igw')?.internetGatewayId;
const vpcId = (c: TaskContext) => vpcNamed(c.env, 'webapp-vpc')?.vpcId;
const webIp = (c: TaskContext) => instanceNamed(c.env, 'web-server')?.publicIpAddress;
/** 文字列に ID が含まれるか (ID が無ければ false) */
const has = (text: string | undefined, id: string | undefined) => !!id && !!text?.includes(id);

const subnetIdCmd = (name: string) => `aws ec2 describe-subnets --filters Name=tag:Name,Values=${name} --query 'Subnets[0].SubnetId' --output text`;
const rtIdCmd = (name: string) => `aws ec2 describe-route-tables --filters Name=tag:Name,Values=${name} --query 'RouteTables[0].RouteTableId' --output text`;
const WEB_IP_CMD = "aws ec2 describe-instances --filters Name=tag:Name,Values=web-server --query 'Reservations[0].Instances[0].PublicIpAddress' --output text";

/** 名前のサブネット ID を表示した (describe-subnets の出力に ID がある) */
const sawSubnetId = (c: TaskContext, name: string) => !!ranAws(c, 'ec2 describe-subnets', (x) => has(x.output, subnetId(c, name)));
/** ルートテーブル `name` の ID だけを絞って表示した (もう一方の表は出ていない) */
const sawOnlyRt = (c: TaskContext, name: string, other: string) => !!ranAws(c, 'ec2 describe-route-tables', (x) => has(x.output, rtId(c, name)) && !has(x.output, rtId(c, other)));
/** web-server の Public IP を describe-instances で表示した */
const sawWebIp = (c: TaskContext) => !!ranAws(c, 'ec2 describe-instances', (x) => has(x.output, webIp(c)));

const curlResult = (r: HttpResult) => (r.error === 'ERR_CONNECTION_TIMED_OUT' ? 'タイムアウト' : r.error ? `エラー (${r.error})` : `HTTP ${r.status}`);

const webServerReachable = (c: TaskContext) => {
  const i = instanceNamed(c.env, 'web-server');
  return !!i && canConnectFromInternet(c.env, i.instanceId, 'tcp', 80).ok;
};

/* Lesson 08 のクイズ: 選択肢と正解はコンソール版のまま、解説だけ CLI の言葉に */
const quiz08: LessonContent = {
  type: 'quiz',
  question: hakase('問題だ。IGW を VPC からデタッチすると、`public-rt` の `0.0.0.0/0 → igw` ルートはどうなるかな？'),
  options: ['自動で削除される', 'ステータスが ブラックホール になり、パケットは破棄される', '別の IGW に自動で切り替わる'],
  answer: 1,
  explanation: [
    hakase('正解。行は勝手には消えん。`describe-route-tables` の `Routes` で `"State": "blackhole"` になっておったら、ターゲットがもう存在しない合図だ。'),
    node('「インターネットにつながらない」ときは、ルートの `State` も見る。覚えました！'),
  ],
};

const patches: CliPatches = {
  /* ================= Lesson 06 ================= */
  'public-private-subnet': {
    steps: {
      0: {
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
          hakase('決めるのは **Route table**、日本語では「ルートテーブル」だ。Subnet から出ていく**パケット** (通信のデータを小分けにした小包) に、「この宛先ならこの出口へ行け」と教える道案内の表だ。'),
          node('るーとてーぶる…。Lesson 03 で VPC と一緒に自動で作られてた、あれですか？'),
          hakase('ほう、そこは覚えておったか。あれは**メインルートテーブル**という特別な 1 枚だ。その話は後でする。'),
        ],
      },
      6: {
        type: 'dialogue',
        lines: [
          hakase('では、`public-subnet-1a` が本当はどの Route table を使っているか、CLI で調べよう。'),
          node('先輩を信じないんですか？'),
          hakase('「作っておいた」を信じて本番が止まった話なら、障害報告書が 3 冊書ける。確かめるのだ。'),
          hakase('まず `aws ec2 describe-subnets` で、`public-subnet-1a` のサブネット ID を取り出す。Lesson 03 で `--filters` と `--query` を使って VPC ID を取り出したのと同じ要領だ。'),
          node('次に、そのサブネット ID で `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=...` ですね。Lesson 05 の最後に打ったら、空っぽだったやつです。'),
          hakase('あのときは作ったばかりの Subnet で、まだどの表とも関連付いていなかった。先輩の話が本当なら、今度は 1 枚出てくるはずだ。'),
          hakase('出てきた表の `Routes` に、`DestinationCidrBlock` (宛先) と `GatewayId` (出口) の組が並んでおる。'),
          node('`DestinationCidrBlock` が宛先で、`GatewayId` が出口。了解です！'),
        ],
      },
      7: {
        type: 'exercise',
        title: 'Subnet の Route table を調べる',
        objective: '`public-subnet-1a` が使っているルートテーブルと、そのルートを確認する',
        tasks: [
          {
            id: 'subnet',
            title: '`public-subnet-1a` のサブネット ID を調べる',
            hint: "`aws ec2 describe-subnets --filters Name=tag:Name,Values=public-subnet-1a --query 'Subnets[0].SubnetId' --output text`。`SUBNET_ID=$(...)` で変数に入れておくと、次のコマンドで `$SUBNET_ID` と書けます。",
            command: subnetIdCmd('public-subnet-1a'),
            done: (c) => sawSubnetId(c, 'public-subnet-1a'),
          },
          {
            id: 'rt',
            title: 'そのサブネットに関連付いたルートテーブルを `describe-route-tables` で見る',
            hint: '`aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<サブネット ID>`。`Tags` の `Name` と、`Routes` の中身を見ます。',
            command: (c) => `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=${subnetId(c, 'public-subnet-1a') ?? 'subnet-xxxxxxxx'}`,
            done: (c) => !!ranAws(c, 'ec2 describe-route-tables', (x) => has(x.line, subnetId(c, 'public-subnet-1a')) || has(x.line, rtId(c, 'public-rt')) || x.line.includes('public-rt')),
          },
        ],
        validate: (c) =>
          ranAws(c, 'ec2 describe-route-tables', (x) => has(x.line, subnetId(c, 'public-subnet-1a')) || has(x.line, rtId(c, 'public-rt')) || x.line.includes('public-rt'))
            ? ok(
                hakase('出てきたのは `public-rt` だな。`Routes` を見てみろ。`DestinationCidrBlock` が `10.0.0.0/16`、`GatewayId` が `local` の 1 行しかない。VPC の中への道しか書いておらんのだ。'),
                node('`webapp-igw` は VPC にアタッチ済みなのに、表に門への道が無いから誰も通らない…。先輩の「作っておいた」は半分だけだったんですね。'),
                hakase('門を建てて満足して帰る。よくある話だ。では道を書き足そう。`aws ec2 create-route` に、表を `--route-table-id`、宛先を `--destination-cidr-block 0.0.0.0/0`、出口を `--gateway-id` で渡す。'),
                node('`--gateway-id` には何て打てばいいんですか？'),
                hakase('IGW の ID だ。`igw-` で始まる。`aws ec2 describe-internet-gateways` で探せるが、デフォルト VPC の IGW も一緒に出てくる。Name タグの `--filters` で `webapp-igw` に絞るのだ。'),
              )
            : ng(hakase('まだ `public-subnet-1a` のルートテーブルを見ていないようだ。サブネット ID を取り出して、`aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<サブネット ID>` と打つのだ。迷子になるのはパケットだけで十分だ。')),
      },
      8: {
        type: 'exercise',
        title: '0.0.0.0/0 → Internet gateway を追加する',
        objective: '`public-rt` に宛先 `0.0.0.0/0`、出口 `webapp-igw` のルートを `aws ec2 create-route` で追加し、Private → Public に変える',
        tasks: [
          {
            id: 'igw',
            title: '`webapp-igw` の IGW ID を調べる',
            hint: "`aws ec2 describe-internet-gateways --filters Name=tag:Name,Values=webapp-igw --query 'InternetGateways[0].InternetGatewayId' --output text`",
            command: "aws ec2 describe-internet-gateways --filters Name=tag:Name,Values=webapp-igw --query 'InternetGateways[0].InternetGatewayId' --output text",
            done: (c) => !!ranAws(c, 'ec2 describe-internet-gateways', (x) => has(x.output, igwId(c))),
          },
          {
            id: 'add',
            title: '`public-rt` に `0.0.0.0/0` → `webapp-igw` のルートを追加する',
            hint: '`aws ec2 create-route --route-table-id <public-rt の ID> --destination-cidr-block 0.0.0.0/0 --gateway-id <webapp-igw の ID>`。public-rt の ID は、さっきの出力の `RouteTableId` です。',
            command: (c) => `aws ec2 create-route --route-table-id ${rtId(c, 'public-rt') ?? 'rtb-xxxxxxxx'} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igwId(c) ?? 'igw-xxxxxxxx'}`,
            done: (c) => isSubnetPublic(c.env, 'public-subnet-1a'),
          },
        ],
        validate: (c) => {
          if (!isSubnetPublic(c.env, 'public-subnet-1a'))
            return ng(hakase('まだ `public-subnet-1a` に Internet gateway への道が無い。`aws ec2 create-route` を打って、`"Return": true` が返ったかな？ 書いただけで Enter を押さないコマンドは、出さない手紙と同じで届かんぞ。'));
          if (isSubnetPublic(c.env, 'private-subnet-1a'))
            return ng(
              hakase('む、private-subnet まで Public になっておる。メインルートテーブル (`private-rt`) に道を書いていないか？'),
              hakase('`aws ec2 delete-route --route-table-id <private-rt の ID> --destination-cidr-block 0.0.0.0/0` で、その道を消すのだ。道を書くのは `public-rt` だけだ。'),
            );
          return ok(
            hakase('よし、`public-rt` に `0.0.0.0/0 → webapp-igw` が入った。`describe-route-tables` で見れば、そのルートの `State` は `active` だ。これで `public-subnet-1a` は **Private → Public** になった。'),
            node('`public-subnet-1c` はどうなるんですか？ 触ってないですけど。'),
            hakase('`public-subnet-1c` も同じ `public-rt` に関連付いておるから、一緒に Public になった。表を 1 枚直せば、その表を使う Subnet が全部変わる。'),
            node('便利だけど、間違えたら全部まとめて壊れるってことですね。'),
            hakase('そうだ。ワシが昔、表 1 枚で Subnet を 20 個道連れにした話は…また今度にしよう。'),
          );
        },
      },
    },
  },

  /* ================= Lesson 07 ================= */
  'route-table': {
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          hakase('**明示的** (explicit) は、Route table に「この Subnet はこの表を使え」と名指しで登録すること。**暗黙** (implicit) は、名指しされていない Subnet が自動で**メインルートテーブル** (main route table) を使うことだ。'),
          node('メインルートテーブル。Lesson 03 で VPC と一緒に作られて、Lesson 06 で `private-rt` のことだって出てきましたね。'),
          hakase('そうだ。VPC に 1 枚だけある「指定が無ければこれを使え」という既定の表だ。会社で言えば、配属先の決まっていない新人がとりあえず放り込まれる総務部だな。'),
          node('僕、入社したとき総務部でした。'),
          hakase('知っておる。だからこのたとえにした。'),
          node('ひどい。…じゃあ `private-subnet-1a` は誰にも名指しされてないから、メインの `private-rt` を使ってるはずですよね？'),
          hakase('「はず」だな。CLI でどう見えるかは次の表のとおりだ。`aws ec2 describe-route-tables` の応答では、表ごとの `Associations` に関連付けが並ぶ。'),
        ],
      },
      2: {
        type: 'table',
        title: 'Subnet と Route table の関係',
        columns: ['関連付け', '意味', 'CLI (`describe-route-tables`) での見え方'],
        rows: [
          ['明示的 (explicit)', 'Route table に Subnet を名指しで直接関連付ける', 'その表の `Associations` に、`"SubnetId": "subnet-..."` と `"Main": false` の要素が載る'],
          ['暗黙 (main)', '明示的な関連付けが無い Subnet は main を使う', 'どの表の `Associations` にも載らない。main の表には `"Main": true` の要素がある'],
        ],
      },
      3: {
        type: 'dialogue',
        lines: [
          node('名指しされた Subnet は、その表の `Associations` に `SubnetId` 付きで載る。名指しされてない Subnet はどの表にも名前が載らなくて、暗黙で `"Main": true` の表を使う、ってことですね。'),
          hakase('そうだ。だから Subnet の側から調べるなら、Lesson 06 でも使った `--filters Name=association.subnet-id,Values=<サブネット ID>` だ。名指しされておれば、その表が出てくる。'),
          node('空っぽなら誰にも名指しされてない、つまりメインの表を使ってる。Lesson 05 で見た、作ったばかりの `public-subnet-1a` と同じですね。'),
          hakase('うむ。では `private-subnet-1a` で調べよう。'),
          node('調べるまでもなく空っぽですよ。メインの `private-rt` を使ってるはずです。賭けてもいいです。'),
          hakase('ほう、何を賭ける？'),
          node('…今月の給料で。'),
          hakase('君の給料なら、負けても誰も困らん額だな。よし、見てみるのだ。'),
        ],
      },
      4: {
        type: 'exercise',
        title: '原因を調べる',
        objective: '`private-subnet-1a` がどの Route table に関連付いているか確認する',
        tasks: [
          {
            id: 'subnet',
            title: '`private-subnet-1a` のサブネット ID を調べる',
            hint: "`aws ec2 describe-subnets --filters Name=tag:Name,Values=private-subnet-1a --query 'Subnets[0].SubnetId' --output text`",
            command: subnetIdCmd('private-subnet-1a'),
            done: (c) => sawSubnetId(c, 'private-subnet-1a'),
          },
          {
            id: 'rt',
            title: '`association.subnet-id` で絞って、関連付いたルートテーブルを探す',
            hint: '`aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<サブネット ID>`。空っぽならメインルートテーブルを使っています。',
            command: (c) => `aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=${subnetId(c, 'private-subnet-1a') ?? 'subnet-xxxxxxxx'}`,
            done: (c) => !!ranAws(c, 'ec2 describe-route-tables', (x) => has(x.line, subnetId(c, 'private-subnet-1a')) || has(x.output, subnetId(c, 'private-subnet-1a'))),
          },
        ],
        validate: (c) =>
          ranAws(c, 'ec2 describe-route-tables', (x) => has(x.line, subnetId(c, 'private-subnet-1a')) || has(x.output, subnetId(c, 'private-subnet-1a')))
            ? ok(
                hakase('空っぽではないな。出てきたのは `public-rt` だ。`Associations` に、`private-subnet-1a` の `SubnetId` が名指しで載っておる。誰かが「ちょっとだけ」と関連付けて、戻し忘れたのだろう。'),
                node('「一時的に」って、いちばん信用できない言葉ですね…。だから `0.0.0.0/0 → igw` の道が使えて、Public になっちゃってたんですね。'),
                hakase('そして賭けは君の負けだ。給料は…まあ、取っても誤差だな。'),
                node('誤差って言わないでください！'),
                hakase('では直すぞ。付け替えは `aws ec2 replace-route-table-association` だ。`--association-id` に今の関連付けの ID (その要素の `RouteTableAssociationId`、`rtbassoc-` で始まるもの)、`--route-table-id` に `private-rt` の ID を渡す。'),
              )
            : ng(hakase('まず `private-subnet-1a` のサブネット ID を取り出し、`aws ec2 describe-route-tables --filters Name=association.subnet-id,Values=<サブネット ID>` と打つのだ。')),
      },
      5: {
        type: 'exercise',
        title: 'private-subnet-1a を private-rt に戻す',
        objective: '`private-subnet-1a` の関連付けを `private-rt` (main route table) に戻し、Private subnet にする',
        tasks: [
          {
            id: 'edit',
            title: '`private-rt` のルートテーブル ID を調べる',
            hint: "`aws ec2 describe-route-tables --filters Name=tag:Name,Values=private-rt --query 'RouteTables[0].RouteTableId' --output text`",
            command: rtIdCmd('private-rt'),
            done: (c) => sawOnlyRt(c, 'private-rt', 'public-rt'),
          },
          {
            id: 'save',
            title: '`replace-route-table-association` で `private-rt` に付け替える',
            hint: '`aws ec2 replace-route-table-association --association-id <関連付け ID> --route-table-id <private-rt の ID>`。関連付け ID は、さっきの出力で `SubnetId` が private-subnet-1a の ID になっている要素の `RouteTableAssociationId` です。`aws ec2 disassociate-route-table --association-id <関連付け ID>` で関連付けを外しても、暗黙の関連付けでメインの `private-rt` に戻ります。',
            command: (c) => {
              const sid = subnetId(c, 'private-subnet-1a');
              const assoc = c.env.routeTables.flatMap((r) => r.associations).find((a) => !!sid && a.subnetId === sid)?.routeTableAssociationId;
              return `aws ec2 replace-route-table-association --association-id ${assoc ?? 'rtbassoc-xxxxxxxx'} --route-table-id ${rtId(c, 'private-rt') ?? 'rtb-xxxxxxxx'}`;
            },
            done: (c) => !isSubnetPublic(c.env, 'private-subnet-1a'),
          },
        ],
        validate: (c) => {
          if (isSubnetPublic(c.env, 'private-subnet-1a'))
            return ng(hakase('まだ `private-subnet-1a` が Public のままだ。窓は全開だぞ。`--route-table-id` に `public-rt` ではなく `private-rt` の ID を渡したか確かめるのだ。'));
          if (!isSubnetPublic(c.env, 'public-subnet-1a') || !isSubnetPublic(c.env, 'public-subnet-1c'))
            return ng(
              hakase('今度は public-subnet が Private になってしまったぞ。窓を閉めるついでに玄関まで塞いでどうする。'),
              hakase('`--association-id` に、public-subnet の関連付け ID を渡さなかったか？ `aws ec2 describe-route-tables --filters Name=tag:Name,Values=public-rt` の `Associations` を確かめ、外れた Subnet は `aws ec2 replace-route-table-association` か `aws ec2 associate-route-table` で `public-rt` に戻すのだ。'),
            );
          const rt = effectiveRouteTable(c.env, subnetNamed(c.env, 'private-subnet-1a')!.subnetId);
          return ok(
            hakase(`よし、\`private-subnet-1a\` は ${rt.associations.some((a) => a.main) ? 'main route table (private-rt)' : 'private な route table'} を使う Private subnet に戻った。窓は閉まったぞ。`),
            node('`public-subnet-1a` と `1c` は Public のまま。直すべきところだけ直せました！'),
            hakase('うむ。診断の担当者には「関連付けを戻しました」と報告しておけ。始末書にならずに済んで、よかったな。'),
          );
        },
      },
    },
  },

  /* ================= Lesson 08 ================= */
  'internet-gateway': {
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、`public-rt` に `0.0.0.0/0` の route を書こうとして、`--gateway-id` に渡す IGW の ID を探したんです。でも `describe-internet-gateways` を `webapp-vpc` の VPC ID で絞ったら、`"InternetGateways": []` で空っぽなんです！'),
          hakase('当然だ。この VPC には、まだ Internet gateway が無い。'),
          node('え、Lesson 06 のときはあったじゃないですか。`webapp-igw`。'),
          hakase('あれは先輩が作っておいたものだ。今回は君が自分で作る。いつまでも先輩のおさがりで生きていけると思うな。'),
          node('おさがりって言い方…。改めて、Internet gateway って VPC とインターネットの出入口、でしたよね。'),
          hakase('うむ、略して IGW。Lesson 03 のクイズのとおり、VPC を作っても自動では付いてこない。門の無い城で「外へは門から」と道案内を書いても、その先は壁で行き止まりだ。'),
          node('だから空っぽだったんですね。やることは IGW を作るだけですか？'),
          hakase('3 つだ。「作る」「VPC に**アタッチ** (取り付け) する」「Route table に道を書く」。3 つだ。'),
          node('なんで 2 回言ったんですか。…でも出入口が 1 つだけって、そこが壊れたら終わりじゃないですか？'),
          hakase('いい心配だ。IGW は 1 つの VPC に 1 つしかアタッチできんが、AWS が裏で**冗長化** (予備を用意して、壊れても動き続けるように) してあり、通信量に合わせて勝手に広がる。'),
          node('じゃあ、そこだけ止まって全部止まる…みたいな弱点にはならない？'),
          hakase('そういう弱点を**単一障害点**と呼ぶが、IGW はそうならん。AWS が面倒を見る**マネージド**な部品だからな。君が面倒を見る部品だったら、ワシは夜も眠れん。'),
        ],
      },
      1: {
        type: 'dialogue',
        lines: [
          node('IGW を作って道を書けば、もうインターネットにつながるんですか？'),
          hakase('甘い。インターネットとつながるには、条件が 4 つそろわねばならん。次の表だ。'),
          node('「リソースが Public IP を持っている」…。Public IP は Lesson 06 で出た、インターネットから見えるサーバーの住所でしたよね。'),
          hakase('そうだ。EC2 なら、Subnet の `MapPublicIpOnLaunch` (パブリック IP の自動割り当て) を `true` にしておくか、`run-instances` に `--associate-public-ip-address` を付けると、起動するときに住所が付く。住所の無いサーバーには、道があっても手紙は届かん。'),
          node('「Security Group (と NACL)」の NACL は？ なっくる？'),
          hakase('**ネットワーク ACL** (Access Control List、許可リスト) の略だ。Security Group がサーバーの前に立つ門番なら、NACL は Subnet の入口に立つ門番だ。Security Group は Lesson 09、NACL は Lesson 09-2 でやる。'),
          node('門番が 2 人…。どっちかが寝てたら通れちゃうんですか？'),
          hakase('逆だ。どちらか 1 人でも「通さん」と言えば通れん。今日はそのうち、門と道の 2 つだけをやる。'),
        ],
      },
      2: {
        type: 'table',
        title: 'インターネットにつながるための条件',
        columns: ['条件', '設定するコマンド'],
        rows: [
          ['VPC に Internet gateway がアタッチされている', '`aws ec2 create-internet-gateway` → `aws ec2 attach-internet-gateway`'],
          ['Subnet の Route table に `0.0.0.0/0 → igw-...` がある', '`aws ec2 create-route`'],
          ['リソースが Public IP を持っている', '`aws ec2 modify-subnet-attribute --map-public-ip-on-launch`、`run-instances --associate-public-ip-address` など'],
          ['Security Group (と NACL) が通信を許可している', '`aws ec2 authorize-security-group-ingress` など'],
        ],
      },
      3: {
        type: 'dialogue',
        lines: [
          hakase('では門を作ろう。`aws ec2 create-internet-gateway` だ。名前タグは Lesson 03 の VPC と同じ要領で `--tag-specifications` に書く。`ResourceType` は `internet-gateway`、名前は `webapp-igw` だ。'),
          node('作ったらすぐ使えるんですか？'),
          hakase('作った直後の応答を見ると、`"Attachments": []` と空っぽだ。どこにも付いていない **Detached** の状態で、門を建てただけで、城壁にはめ込んでいない。'),
          hakase('`aws ec2 attach-internet-gateway` で VPC にアタッチすると、`Attachments` に VPC ID が載り、`State` が `available` になる。これが **Attached** で、ここで初めて門になる。'),
          node('でたっち、あたっち。付いてない、付いてる、ですね。'),
          hakase('うむ。アタッチには、作ったときの応答にある `InternetGatewayId` が要る。`--query \'InternetGateway.InternetGatewayId\' --output text` を付けて作り、`IGW_ID=$(...)` で変数に入れておく手もある。'),
          node('`describe-` だけじゃなくて、`create-` の応答にも `--query` が使えるんですね。'),
          hakase('応答が JSON なら何にでも使える。作っただけで満足して帰るのは、先輩の悪い癖だ。君は真似するなよ。'),
        ],
      },
      4: {
        type: 'exercise',
        title: 'IGW を作成して VPC にアタッチする',
        objective: '名前タグ `webapp-igw` のインターネットゲートウェイを作成し、`webapp-vpc` にアタッチする',
        tasks: [
          {
            id: 'create',
            title: '`webapp-igw` を作成する',
            hint: "`aws ec2 create-internet-gateway --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=webapp-igw}]'`。応答の `Attachments` が空 (`[]`)、つまり Detached の状態です。",
            command: "aws ec2 create-internet-gateway --tag-specifications 'ResourceType=internet-gateway,Tags=[{Key=Name,Value=webapp-igw}]'",
            done: (c) => !!igwId(c),
          },
          {
            id: 'attach',
            title: '`attach-internet-gateway` で `webapp-vpc` にアタッチする',
            hint: '`aws ec2 attach-internet-gateway --internet-gateway-id <IGW ID> --vpc-id <webapp-vpc の VPC ID>`。成功しても何も表示されません。',
            command: (c) => `aws ec2 attach-internet-gateway --internet-gateway-id ${igwId(c) ?? 'igw-xxxxxxxx'} --vpc-id ${vpcId(c) ?? 'vpc-xxxxxxxx'}`,
            done: (c) => !!igwId(c) && byName(c.env.internetGateways, 'webapp-igw')?.attachments[0]?.vpcId === vpcId(c),
          },
          {
            id: 'check',
            title: '`describe-internet-gateways` で `Attachments` を確かめる',
            hint: '`aws ec2 describe-internet-gateways --filters Name=tag:Name,Values=webapp-igw`。`Attachments` に webapp-vpc の `VpcId` と `"State": "available"` があればアタッチ済みです。',
            command: 'aws ec2 describe-internet-gateways --filters Name=tag:Name,Values=webapp-igw',
            done: (c) => !!ranAws(c, 'ec2 describe-internet-gateways', (x) => has(x.output, igwId(c)) && has(x.output, vpcId(c))),
          },
        ],
        validate: (c) => {
          const g = byName(c.env.internetGateways, 'webapp-igw');
          if (!g) return ng(hakase('`webapp-igw` という名前の IGW が見つからん。`aws ec2 describe-internet-gateways` で、`Tags` の `Name` のつづりを確かめるのだ。名前を付け忘れたなら `aws ec2 create-tags` で後から貼れる。名前の誤字は、深夜の障害対応でしか笑えんぞ。'));
          if (g.attachments[0]?.vpcId !== vpcId(c))
            return ng(hakase('`webapp-igw` はできたが、まだ `webapp-vpc` にアタッチされていないようだ。`aws ec2 attach-internet-gateway` に `--internet-gateway-id` と `--vpc-id` (webapp-vpc の ID) を付けて打ち、`describe-internet-gateways` の `Attachments` に VPC ID が載るか確かめるのだ。'));
          return ok(
            hakase('`Attachments` に webapp-vpc の ID が載って、Attached になった。これで webapp-vpc に門が付いたぞ。'),
            node('やった！ これでインターネットにつながりますね！'),
            hakase('さっきの表を 2 秒で忘れたのか。門はできたが、`public-rt` にはまだ門への道が書いてない。'),
            node('あ、3 つのうち 2 つしか終わってない…。次は `aws ec2 create-route` で、`public-rt` に `0.0.0.0/0` → `webapp-igw` ですね。'),
          );
        },
      },
      5: {
        type: 'exercise',
        title: 'public-rt に IGW への route を追加する',
        objective: '`public-rt` に `0.0.0.0/0 → webapp-igw` を追加し、public-subnet を Public にする',
        tasks: [
          {
            id: 'rt',
            title: '`public-rt` のルートテーブル ID を調べる',
            hint: "`aws ec2 describe-route-tables --filters Name=tag:Name,Values=public-rt --query 'RouteTables[0].RouteTableId' --output text`",
            command: rtIdCmd('public-rt'),
            done: (c) => sawOnlyRt(c, 'public-rt', 'private-rt'),
          },
          {
            id: 'save',
            title: '`create-route` で `0.0.0.0/0` → `webapp-igw` を追加する',
            hint: '`aws ec2 create-route --route-table-id <public-rt の ID> --destination-cidr-block 0.0.0.0/0 --gateway-id <webapp-igw の ID>`。IGW の ID は `describe-internet-gateways` で調べ直せます。',
            command: (c) => `aws ec2 create-route --route-table-id ${rtId(c, 'public-rt') ?? 'rtb-xxxxxxxx'} --destination-cidr-block 0.0.0.0/0 --gateway-id ${igwId(c) ?? 'igw-xxxxxxxx'}`,
            done: (c) => isSubnetPublic(c.env, 'public-subnet-1a'),
          },
        ],
        validate: (c) =>
          isSubnetPublic(c.env, 'public-subnet-1a') && isSubnetPublic(c.env, 'public-subnet-1c')
            ? ok(
                hakase('これで `public-subnet-1a` / `1c` がインターネットへの道を持った。作る・アタッチする・道を書く、3 つそろったな。'),
                node('今度は `--gateway-id` に渡す `igw-` の ID がちゃんとありました。門と道がそろって、やっと Public です！'),
                hakase('うむ。ただし、表の残り 2 つ、Public IP と門番の話が残っておるのを忘れるな。'),
              )
            : ng(hakase('まだ public-subnet に IGW への道が無いな。`aws ec2 create-route` で、`--route-table-id` に public-rt の ID、`--destination-cidr-block 0.0.0.0/0`、`--gateway-id` に webapp-igw の ID を渡したか確かめるのだ。VPC にアタッチしていない IGW を渡すと、エラーで断られるぞ。')),
      },
      6: {
        type: 'dialogue',
        lines: [
          node('逆に、IGW を VPC から外したらどうなるんですか？ **デタッチ**っていうんですよね。'),
          hakase('うむ。デタッチしても、`public-rt` の `0.0.0.0/0 → igw` の行は消えずに残る。'),
          node('残るなら、そのまま使えるんじゃないですか？'),
          hakase('行き先の門がもう無いのだぞ。`describe-route-tables` で見ると、そのルートの `State` が `blackhole` (**ブラックホール**) になり、そこへ向かうパケットは黙って捨てられる。'),
          node('ぶらっくほーる。吸い込まれて二度と出てこない…。'),
          hakase('エラーも返さずに消えるから、たちが悪い。ワシは若いころ、深夜にこれで 3 時間溶かした。吸い込まれたのはパケットだけではない。ワシの睡眠もだ。'),
          node('博士の睡眠はどうでもいいですけど、うっかりデタッチしたら大惨事じゃないですか。'),
          hakase('どうでもよくはない。…まあよい。AWS もそこは考えておって、Public IP を持つ EC2 や、インターネット向け (internet-facing) の ALB が VPC にある間は、デタッチを拒否する。'),
          node('拒否されると、どうなるんですか？'),
          hakase('`aws ec2 detach-internet-gateway` が `DependencyViolation` というエラーを返す。「まだそれに頼っているものがあるぞ」という意味だ。事故を防ぐ安全装置だな。'),
          node('安全装置に怒られるうちが花、ですね。'),
          hakase('そういうことだ。安全装置を外してまで消した者の始末書は、ワシが赤ペンで添削してやろう。'),
        ],
      },
      7: quiz08,
    },
  },

  /* ================= Lesson 09 ================= */
  'security-group': {
    steps: {
      3: {
        type: 'dialogue',
        lines: [
          hakase('さて、君の症状だ。ブラウザが Web ページを取りに行くときは、**HTTP** という決まりごと (プロトコル) で、サーバーの **80 番ポート**に話しかける。'),
          node('ぽーと？'),
          hakase('サーバーの中の窓口の番号だ。80 番窓口は Web、22 番窓口は **SSH** (サーバーに遠隔でログインする仕組み)、という具合に番号で用件を分ける。**TCP** は、届いたか確かめながら運ぶ書留のような運び方の名前だと思っておけ。'),
          node('じゃあ、80 番窓口に誰も通されてないから、返事が来なくて**タイムアウト** (待ちくたびれて諦めること) してる…？'),
          hakase('ほう、推理が冴えておるな。明日は槍でも降るか。確かめるには、`web-server-sg` の**インバウンドルール**を見ればよい。'),
          node('セキュリティグループって VPC の中にあるんですよね。コマンドは `aws vpc` ですか？'),
          hakase('そんなサービス名は無い。VPC もセキュリティグループも、操作は `aws ec2` だ。Lesson 03 で VPC を作ったのも `aws ec2 create-vpc` だったろう。'),
          node('じゃあ中身を見るのは `aws ec2 describe-security-groups` ですか？'),
          hakase('うむ。`--filters Name=group-name,Values=web-server-sg` で絞るのだ。インバウンドルールは `IpPermissions`、アウトバウンドルールは `IpPermissionsEgress` に入っておる。'),
          hakase('直すときは `aws ec2 authorize-security-group-ingress` で許可ルールを足す。`--group-id` に SG の ID、`--protocol tcp --port 80`、そして `--cidr 0.0.0.0/0` だ。Lesson 06 でやった「すべての宛先」が、ここでは「世界中の誰からでも」という意味になる。'),
          node('世界中に開けちゃって大丈夫なんですか？'),
          hakase('Web サイトは誰にでも見てもらうものだから、80 番は開けてよい。だが今ある SSH のルールは消すなよ。あれは相手を `198.51.100.24/32` に絞ってある。'),
          node('`198.51.100.24` って誰ですか？'),
          hakase('君の PC だ。`curl https://checkip.amazonaws.com` と打てば分かる。**curl** は URL の中身を取ってきて表示するコマンドで、checkip は話しかけてきた相手の IP アドレスを返すだけの AWS のサイトだ。`/32` は、その IP 1 個だけという意味だ。SSH を世界に開けたら、Lesson 01 のクイズのとおり君の責任だ。'),
          node('世界中から僕のサーバーにログインし放題…。考えただけで胃が痛いです。'),
        ],
      },
      4: {
        type: 'exercise',
        title: 'インバウンドルールに HTTP を許可する',
        objective: '`web-server-sg` に「HTTP (TCP 80) を `0.0.0.0/0` から許可」するインバウンドルールを `aws ec2 authorize-security-group-ingress` で追加する',
        tasks: [
          {
            id: 'open-sg',
            title: '`web-server-sg` のインバウンドルール (`IpPermissions`) を見る',
            hint: '`aws ec2 describe-security-groups --filters Name=group-name,Values=web-server-sg`。SSH (22) のルールの `CidrIp` を、`curl https://checkip.amazonaws.com` で調べた自分の PC の IP と見比べてみましょう。',
            command: 'aws ec2 describe-security-groups --filters Name=group-name,Values=web-server-sg',
            done: (c) => ['ec2 describe-security-groups', 'ec2 describe-security-group-rules'].some((cmd) => !!ranAws(c, cmd, (x) => x.output.includes(`${CLIENT_IP}/32`))),
          },
          {
            id: 'add-http',
            title: 'TCP 80 を `0.0.0.0/0` から許可するルールを足す',
            hint: '`aws ec2 authorize-security-group-ingress --group-id <web-server-sg の ID> --protocol tcp --port 80 --cidr 0.0.0.0/0`。グループ ID は `GroupId` (`sg-` で始まる) です。',
            command: (c) => `aws ec2 authorize-security-group-ingress --group-id ${sgNamed(c.env, 'web-server-sg')?.groupId ?? 'sg-xxxxxxxx'} --protocol tcp --port 80 --cidr 0.0.0.0/0`,
            done: (c) => sgAllows(c.env, 'web-server-sg', 80),
          },
        ],
        validate: (c) => {
          if (!sgAllows(c.env, 'web-server-sg', 80))
            return ng(hakase('まだ TCP 80 がインターネットから許可されていないようだ。招待客リストは白紙のままだぞ。'), hakase('`aws ec2 authorize-security-group-ingress` に `--group-id`、`--protocol tcp`、`--port 80`、`--cidr 0.0.0.0/0` を付けて打ったかな？'));
          if (sgAllows(c.env, 'web-server-sg', 22, { ip: '192.0.2.99' }))
            return ng(
              hakase('HTTP は開いたが…SSH (22) まで全世界に開いておるぞ。世界中の攻撃者に合鍵を配ってどうする。'),
              node('あ、`--port 22` で `0.0.0.0/0` を足しちゃったかも…'),
              hakase('`aws ec2 revoke-security-group-ingress` に、足したときと同じ `--group-id`、`--protocol tcp --port 22 --cidr 0.0.0.0/0` を付ければ、そのルールが消える。SSH は君の PC (`curl https://checkip.amazonaws.com` の IP に `/32`) からだけで十分だ。'),
            );
          return ok(
            hakase('よし、`IpPermissions` に HTTP (80) が増えた。SSH は君の PC だけ、HTTP は世界中の誰でも、という使い分けだ。'),
            node('招待客リストに「Web を見たい方はどなたでも」って書き足した感じですね。'),
            hakase('うむ。SSH の欄に「どなたでも」と書く者は、翌朝には自分の席が「どなたでも」座れる状態になっておる。'),
          );
        },
      },
      5: {
        type: 'dialogue',
        lines: [
          node('アウトバウンドルールは触ってないですけど、Web ページの返事はちゃんとサーバーから出ていけるんですか？'),
          hakase('そこがステートフルの出番だ。インバウンドで許可した通信への**応答**は、アウトバウンドルールに関係なく自動で通る。'),
          node('門番が「さっき通した客への返事だな」って覚えてるから、でしたよね。'),
          hakase('うむ。ノード君が 10 分前の話を覚えておるとは。揮発性メモリにしては上出来だ。'),
          node('10 分くらいは持ちます！'),
          hakase('では、実際に `curl` で確かめよう。URL を渡すと、ブラウザの代わりに Web ページを取ってきて表示する。まず `web-server` の**パブリック IPv4 アドレス**を調べるのだ。'),
          node('パブリック IPv4 アドレスって、Lesson 06 の Public IP、インターネットから見える住所でしたよね。'),
          hakase('そうだ。`aws ec2 describe-instances` の `PublicIpAddress` に入っておる。ただし、インスタンスは `Reservations[]` の中の `Instances[]` という二重の入れ子だ。'),
          node('りざべーしょん？ 予約ですか？'),
          hakase('`run-instances` 1 回分の申し込みのことだ。1 回で何台も起動できるから、申し込みの中にインスタンスが並ぶ。`--query \'Reservations[0].Instances[0].PublicIpAddress\'` で、最初の申し込みの最初の 1 台の住所が取れる。'),
          node('何が出たら成功ですか？'),
          hakase('`curl -i http://<IP>` と `-i` を付けると、本文の前に返事の**ヘッダー**も出る。1 行目に **HTTP 200** と出れば成功だ。200 は、サーバーの「はい、どうぞ」という返事の番号、**ステータスコード**だ。'),
          hakase('失敗したら `-v` を付けて打ち直せ。このシミュレーターでは、通信がどこで止まったかを `*` の行で教えてくれる。'),
          node('失敗する前提みたいに言わないでください。'),
        ],
      },
      6: {
        type: 'exercise',
        title: 'curl で web-server を開く',
        objective: '`web-server` のパブリック IPv4 アドレスを調べ、`curl` でアクセスして HTTP 200 を確認する',
        tasks: [
          {
            id: 'find-ip',
            title: '`describe-instances` で `web-server` の `PublicIpAddress` を調べる',
            hint: "`aws ec2 describe-instances --filters Name=tag:Name,Values=web-server --query 'Reservations[0].Instances[0].PublicIpAddress' --output text`。`IP=$(...)` で変数に入れておくと、次は `curl -i http://$IP` で済みます。",
            command: WEB_IP_CMD,
            done: sawWebIp,
          },
          {
            id: 'browse',
            title: '`curl -i http://<Public IP>` で開き、`HTTP/1.1 200 OK` を確かめる',
            hint: 'IP アドレスの前に `http://` を付けます。1 行目が `HTTP/1.1 200 OK` なら成功です。',
            command: (c) => `curl -i http://${webIp(c) ?? '203.0.113.10'}`,
            done: (c) => lastRequestTo(c, webIp(c))?.status === 200,
          },
        ],
        validate: (c) => {
          const r = lastRequestTo(c, webIp(c));
          if (!r) return ng(hakase('まだ `web-server` の Public IP にアクセスしていないようだ。`describe-instances` で `PublicIpAddress` を調べ、`curl -i http://<IP>` と打つのだ。'));
          if (r.status !== 200) return ng(hakase(`結果は ${curlResult(r)} だったな。\`curl -v http://<IP>\` で、どこで止まったか見てみるのだ。インバウンドルールに HTTP (80) が残っているかも確かめるのだぞ。`));
          return ok(
            node('開きました！ `HTTP/1.1 200 OK` です！ タイムアウト地獄から生還しました！'),
            hakase('うむ。それが Security Group の基本だ。「誰から (ソース)・どのポートへ」を許可リストで書く。書いていない者は通さん。'),
            node('招待客リスト、ですね。'),
            hakase('そうだ。リストに書き忘れた客は、たとえ社長でも門前払いだ。…そのとき社長からの電話を取るのは君だぞ。'),
          );
        },
      },
      8: {
        type: 'dialogue',
        lines: [
          hakase('まとめよう。Security Group は「許可のみ」「ステートフル」「全ルールを評価」。そして、どれにも当てはまらない通信は暗黙の拒否だ。'),
          node('招待客リスト、帰りは顔パス、順番なし、リストに無い人は門前払い。'),
          hakase('…最後のたとえが雑だが、まあよい。もう 1 つ。許可する相手には、`--cidr` の CIDR だけでなく、`--source-group` で**別の Security Group** も指定できる。'),
          node('別の Security Group？ 住所じゃなくて、門番を指定するんですか？'),
          hakase('「この Security Group が付いているサーバーからなら通してよい」と書けるのだ。サーバーが入れ替わって住所が変わっても、ルールを書き直さずに済む。社員証で入館を許可するようなものだな。'),
          node('住所で 1 人ずつ許可するより、社員証で許可するほうが楽ってことですね。'),
          hakase('そうだ。これは ALB と EC2 をつなぐときに大活躍する。後のレッスンで、`--source-group` に Security Group の ID を渡して体験しよう。'),
          node('次の Lesson 09-2 は、Subnet の入口に立つ門番、ネットワーク ACL でしたよね。'),
          hakase('うむ。門番が 2 人になると、揉めごとも 2 倍だ。覚悟しておけ。'),
        ],
      },
    },
  },

  /* ================= Lesson 09-2 ================= */
  'network-acl': {
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、Lesson 09 で `web-server-sg` に HTTP を許可して、`curl` で 200 が返りましたよね。'),
          hakase('うむ。君が珍しく一発で成功した、記念すべき日だ。'),
          node('珍しくは余計です。…その `web-server` が、今朝また開かないんです。`curl` がずっと返事を待って、最後は**タイムアウト**。Security Group は触ってないのに。'),
          hakase('タイムアウト、つまり返事を待ちくたびれて諦めた、か。そういえば昨夜、セキュリティ担当が「public subnet を硬くしておきました」と得意げに言っておったな。'),
          node('硬く？ サブネットって冷やすと固まるんですか？'),
          hakase('豆腐ではない。サブネットに**ネットワーク ACL** を付けた、という意味だ。'),
          node('ねっとわーく えーしーえる？'),
          hakase('ACL は Access Control List、「アクセス制御のリスト」だ。誰を通して誰を止めるかを書いた名簿だな。'),
          node('あ、Lesson 08 の「インターネットにつながるための条件」の表に、「Security Group (と NACL)」ってカッコ書きで載ってました。'),
          hakase('よく覚えておったな。NACL は Network ACL の略だ。カッコの中に押し込められていた日陰者が、今日の主役というわけだ。'),
        ],
      },
      4: {
        type: 'dialogue',
        lines: [
          node('最後の「デフォルト ACL は全許可、カスタム ACL は全拒否」は？'),
          hakase('VPC を作ると、ネットワーク ACL も 1 つ自動で作られる。Lesson 03 のクイズで「自動では作られないもの」を選んだとき、ネットワーク ACL は作られる側だったな。'),
          node('はい、作られないのはインターネットゲートウェイでした。'),
          hakase('その自動で作られるのが**デフォルト ACL** で、中身は全部許可だ。自分で新しく作った**カスタム ACL** は、最初は全部拒否。どの行にも当てはまらない通信は、名簿の最後にある `*` の行で拒否される。'),
          node('`*`…あすたりすく？'),
          hakase('そう、「その他全部」の行だ。消すこともできない、関所の最後の番人だな。CLI の応答では、ルール番号 `32767` の行として出てくる。'),
          hakase('さて、`web-server` のいる public subnet には、`public-nacl` というカスタム ACL が付いておるらしい。だが中身を見る前に、まず症状を自分の目で確かめる。障害対応の第一歩だ。'),
          node('他人の「開きません」を鵜呑みにするな、ってことですね。'),
          hakase('特に君の「開きません」はな。Lesson 09 と同じく `web-server` の `PublicIpAddress` を調べて、`curl` で開いてみよ。今日は `-v` も付けるのだ。'),
          node('Lesson 09 で「失敗したら付けよ」って言われたやつですね。'),
          hakase('うむ。verbose (おしゃべり) の v だ。本物の curl なら通信の細かいやり取りを出すが、このシミュレーターでは、通信が経路のどこで止まったかを行頭に `*` の付いた行で教えてくれる。'),
        ],
      },
      5: {
        type: 'exercise',
        title: '症状を確認する',
        objective: '`web-server` のパブリック IPv4 アドレスを `curl -v` で開き、タイムアウトすることを確認する',
        tasks: [
          {
            id: 'copy',
            title: '`describe-instances` で `web-server` の `PublicIpAddress` を調べる',
            hint: "`aws ec2 describe-instances --filters Name=tag:Name,Values=web-server --query 'Reservations[0].Instances[0].PublicIpAddress' --output text`",
            command: WEB_IP_CMD,
            done: sawWebIp,
          },
          {
            id: 'browse',
            title: '`curl -v http://<Public IP>` で開く',
            hint: '返事を待つので数秒かかります。`curl: (28) ... Timeout was reached` と出れば症状の再現です。',
            command: (c) => `curl -v http://${webIp(c) ?? '203.0.113.10'}`,
            done: (c) => !!lastRequestTo(c, webIp(c)),
          },
        ],
        validate: (c) => {
          const r = lastRequestTo(c, webIp(c));
          if (!r) return ng(hakase('まだ web-server にアクセスしていないようだ。`describe-instances` で `web-server` の `PublicIpAddress` を調べ、`curl -v http://<IP>` と打つのだ。'));
          if (r.error !== 'ERR_CONNECTION_TIMED_OUT') return ng(hakase(`結果は ${curlResult(r)} だったな。開いたのは web-server のパブリック IPv4 アドレスかな？ \`describe-instances\` で調べ直して、もう一度試すのだ。`));
          return ok(
            hakase('タイムアウトだ。`curl: (28) ... Timeout was reached` は、返事を待ちくたびれた curl が諦めた、という意味だ。'),
            node('門前払いなら「拒否しました」って言ってくれればいいのに。'),
            hakase('ネットワーク ACL は、拒否したパケットを黙って捨てる。返事が無いから、curl は待ち続けるしかないのだ。'),
            hakase('`-v` で出た `*` の行を見てみよ。通信がどこで息絶えたかを書いた検死報告書だ。学習用のおまけだから、本物の AWS にはこんな親切なものは無いがな。'),
            node('言い方…あ、セキュリティグループは ✔ なのに、**ネットワーク ACL** の行が ✘ で、「戻り通信」が拒否されるって書いてあります！'),
          );
        },
      },
      6: [
        {
          type: 'dialogue',
          lines: [
            hakase('では関所の名簿を見る。`aws ec2 describe-network-acls` だ。`--filters Name=association.subnet-id,Values=<サブネット ID>` で絞れば、そのサブネットに付いておる ACL だけが出る。'),
            node('ルートテーブルを探したときと同じ絞り方ですね。'),
            hakase('うむ。名簿は `Entries` に並んでおる。`"Egress": false` がインバウンド、`"Egress": true` がアウトバウンドだ。egress は「出ていくこと」という意味だ。'),
            node('行きと帰りが 1 つの配列に混ざってるんですか。見比べにくそうです…。'),
            hakase('文句の多い新人だ。では `--query` の技をもう 1 つ教えよう。`[?条件]` と書くと、配列のうち条件に合う要素だけが残る。`--query \'NetworkAcls[0].Entries[?Egress]\'` なら、`Egress` が `true` の行、つまりアウトバウンドだけだ。'),
            node('`--filters` みたいなことが、`--query` でもできるんですね。'),
            hakase('`--filters` は AWS の側で絞り、`--query` は返ってきた JSON を手元で絞る。この違いは覚えておけ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'ネットワーク ACL を調べる',
          objective: '`public-subnet-1a` に付いたネットワーク ACL (`public-nacl`) のインバウンドルールとアウトバウンドルールを見比べる',
          tasks: [
            {
              id: 'list',
              title: '`public-subnet-1a` に付いたネットワーク ACL を `describe-network-acls` で見る',
              hint: "サブネット ID は `aws ec2 describe-subnets --filters Name=tag:Name,Values=public-subnet-1a --query 'Subnets[0].SubnetId' --output text` で取り出せます。`aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=<サブネット ID>`",
              command: (c) => `aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=${subnetId(c, 'public-subnet-1a') ?? 'subnet-xxxxxxxx'}`,
              done: (c) => !!ranAws(c, 'ec2 describe-network-acls', (x) => has(x.output, naclNamed(c.env, 'public-nacl')?.networkAclId)),
            },
            {
              id: 'open',
              title: '`--query` でアウトバウンドのルールだけを表示する',
              hint: "`aws ec2 describe-network-acls --filters Name=tag:Name,Values=public-nacl --query 'NetworkAcls[0].Entries[?Egress]'`",
              command: "aws ec2 describe-network-acls --filters Name=tag:Name,Values=public-nacl --query 'NetworkAcls[0].Entries[?Egress]'",
              done: (c) => !!ranAws(c, 'ec2 describe-network-acls', (x) => !!x.query?.includes('Egress')),
            },
          ],
          validate: (c) =>
            ranAws(c, 'ec2 describe-network-acls', (x) => has(x.output, naclNamed(c.env, 'public-nacl')?.networkAclId))
              ? ok(
                  node('インバウンドは、ルール 100 で 80 番 (HTTP)、110 で 22 番 (SSH) を許可してます。でもアウトバウンドは、ルール番号 `32767`、つまり `*` の拒否しかない！'),
                  hakase('`"Protocol": "6"` は TCP の番号だ。そう、外からのリクエストはサブネットに入れるが、web-server の**返事がサブネットから出られない**のだ。'),
                  node('入口の関所は通してくれたのに、出口で「名簿に無い」って止められてるんですね。'),
                  hakase('「必要なものだけ許可しました」のつもりで、帰り道を書き忘れたわけだ。片道切符のサブネットの完成だな。'),
                )
              : ng(hakase('`public-nacl` の中身をまだ見ていないようだ。`aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=<public-subnet-1a の ID>` と打つのだ。')),
        },
      ],
      7: {
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
          node('Lesson 09 の `--port` みたいに、`1024-65535` ってハイフンでつないで書けばいいんですか？'),
          hakase('ネットワーク ACL では `aws ec2 create-network-acl-entry` を使い、ポート範囲は shorthand で `--port-range From=1024,To=65535` と書く。ほかに、アウトバウンドなので `--egress`、`--rule-number 100`、`--protocol tcp` を付ける。'),
          hakase('送信先はブラウザがどこから来るか分からんから `--cidr-block 0.0.0.0/0`、許可は `--rule-action allow` だ。'),
        ],
      },
      8: {
        type: 'exercise',
        title: 'アウトバウンドルールで戻り通信を許可する',
        objective: '`public-nacl` のアウトバウンドルールに「ルール番号 100 / TCP / ポート範囲 `1024-65535` / 送信先 `0.0.0.0/0` / 許可」を `aws ec2 create-network-acl-entry` で追加する',
        tasks: [
          {
            id: 'edit',
            title: '`public-nacl` のネットワーク ACL ID を取り出す',
            hint: "`aws ec2 describe-network-acls --filters Name=tag:Name,Values=public-nacl --query 'NetworkAcls[0].NetworkAclId' --output text`。`acl-` で始まる ID です。",
            command: "aws ec2 describe-network-acls --filters Name=tag:Name,Values=public-nacl --query 'NetworkAcls[0].NetworkAclId' --output text",
            done: (c) => !!ranAws(c, 'ec2 describe-network-acls', (x) => !!x.query && has(x.output, naclNamed(c.env, 'public-nacl')?.networkAclId)),
          },
          {
            id: 'add',
            title: '`create-network-acl-entry` で `--egress` のルール 100 を足す',
            hint: '`aws ec2 create-network-acl-entry --network-acl-id <public-nacl の ID> --egress --rule-number 100 --protocol tcp --port-range From=1024,To=65535 --cidr-block 0.0.0.0/0 --rule-action allow`。成功しても何も表示されません。',
            command: (c) => `aws ec2 create-network-acl-entry --network-acl-id ${naclNamed(c.env, 'public-nacl')?.networkAclId ?? 'acl-xxxxxxxx'} --egress --rule-number 100 --protocol tcp --port-range From=1024,To=65535 --cidr-block 0.0.0.0/0 --rule-action allow`,
            done: webServerReachable,
          },
        ],
        validate: (c) => {
          if (!webServerReachable(c))
            return ng(
              hakase('まだ戻り通信が通らない。まさか 80 番を足したのではあるまいな？ 返事の宛先はブラウザのエフェメラルポート (49152〜65535) だ。`curl -v` で、どのポートが拒否されているか見てみよ。'),
              hakase('間違えたルールは、`aws ec2 replace-network-acl-entry` に同じ `--egress --rule-number` と正しい中身を付ければ書き換えられる。'),
            );
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
      9: {
        type: 'exercise',
        title: '復旧を確認する',
        objective: '`curl` で `web-server` を開き、HTTP 200 を確認する',
        tasks: [
          {
            id: 'browse',
            title: '`curl -i http://<Public IP>` → `200`',
            hint: '↑ キーでさっきの `curl` を呼び出し、`-v` を `-i` に変えて打ち直します。1 行目が `HTTP/1.1 200 OK` なら復旧です。',
            command: (c) => `curl -i http://${webIp(c) ?? '203.0.113.10'}`,
            done: (c) => lastRequestTo(c, webIp(c))?.status === 200,
          },
        ],
        validate: (c) =>
          lastRequestTo(c, webIp(c))?.status === 200
            ? ok(
                node('開きました！ 200 です！'),
                hakase('症状を確かめ、関所の名簿を調べ、帰り道を足して、もう一度確かめる。障害対応はいつもこの順番だ。'),
                node('今日は障害報告書を書かずに済みそうですね。'),
                hakase('書くとしたら、題名は「帰り道を忘れた関所」だな。'),
              )
            : ng(hakase('最新のアクセスがまだ 200 ではない。web-server のアドレスのまま、もう一度 `curl -i http://<IP>` と打つのだ。')),
      },
    },
  },
};

export default patches;
