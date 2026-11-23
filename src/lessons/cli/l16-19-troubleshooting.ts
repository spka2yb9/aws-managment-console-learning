import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { albReachesWeb, allTargetsHealthy, instanceNamed, lastAlbRequest, lbNamed, naclNamed, sgAllows, sgNamed, subnetNamed, tgNamed, webReachesDb } from '../helpers';
import { awsCalls, param, ranAws } from './helpers';
import type { CliPatches } from './types';

/* 今の環境の ID (模範解答のコマンドに埋める) */
const dns = (c: TaskContext) => lbNamed(c.env, 'web-alb')?.dnsName ?? 'web-alb-xxxxxxxxxx.ap-northeast-1.elb.amazonaws.com';
const lbArn = (c: TaskContext) => lbNamed(c.env, 'web-alb')?.loadBalancerArn ?? '<web-alb の ARN>';
const tgArn = (c: TaskContext) => tgNamed(c.env, 'web-tg')?.targetGroupArn ?? '<web-tg の ARN>';
const sgId = (c: TaskContext, name: string) => sgNamed(c.env, name)?.groupId ?? `<${name} の ID>`;
const iid = (c: TaskContext, name: string) => instanceNamed(c.env, name)?.instanceId ?? `<${name} の ID>`;

const DNS_QUERY = "aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text";
const curlAlb = (c: TaskContext) => `curl http://${dns(c)}`;
const tgHealth = (c: TaskContext) => `aws elbv2 describe-target-health --target-group-arn ${tgArn(c)}`;
const tgHealthStates = (c: TaskContext) => `${tgHealth(c)} --query 'TargetHealthDescriptions[].TargetHealth.State'`;

/** `commands` のどれかが成功し、その出力に `id` が出ていた (「ID を調べた」タスク) */
const saw = (c: TaskContext, commands: string[], id: string | undefined) => !!id && awsCalls(c).some((x) => x.ok && commands.includes(x.command!) && x.output.includes(id));
/** web-tg のターゲットのヘルスを見た */
const sawTgHealth = (c: TaskContext) => !!ranAws(c, 'elbv2 describe-target-health', (x) => param(x, 'target-group-arn') === tgNamed(c.env, 'web-tg')?.targetGroupArn);
/** 直したあとに、web-tg のターゲットが healthy になったのを確かめた */
const sawHealthy = (c: TaskContext) =>
  allTargetsHealthy(c.env, 'web-tg', 2) &&
  (!!ranAws(c, 'elbv2 describe-target-health', (x) => param(x, 'target-group-arn') === tgNamed(c.env, 'web-tg')?.targetGroupArn && x.output.includes('healthy') && !x.output.includes('unhealthy')) || !!ranAws(c, 'elbv2 wait target-in-service'));
/** セキュリティグループ `name` のルールを describe-security-groups で見た (ID でも名前の絞り込みでも) */
const sawSg = (c: TaskContext, name: string) => {
  const id = sgNamed(c.env, name)?.groupId ?? '-';
  return !!ranAws(c, 'ec2 describe-security-groups', (x) => param(x, 'group-ids').includes(id) || param(x, 'filters').includes(`"${name}"`) || x.output.includes(id));
};

const patches: CliPatches = {
  /* ---- Lesson 16 ---- */
  'sg-troubleshooting': {
    summary: '504 の原因をターゲットのヘルスから辿り、ALB の SG ID を変数で受け渡して許可する',
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('どっちなんですか？'),
          hakase('それを調べるのが今日の仕事だ。障害対応の基本は 2 つ。「症状を自分で確かめる」、そして「外側から順に調べる」。'),
          node('外側から？'),
          hakase('お客さんに近い方からだ。Internet → ALB → EC2 → RDS。Lesson 15 で、この区間を 1 本ずつ説明したな。'),
          node('はい。Internet → ALB が 80、ALB → EC2 が 3000、EC2 → RDS が 3306 でしたよね。'),
          hakase('ほう、覚えておったか。障害対応中に限って物覚えがよくなる。追い詰められた人間の特徴だな。'),
          node('504 なら降ってます。'),
          hakase('うまいことを言っても障害は直らんぞ。まずは再現だ。`aws elbv2 describe-load-balancers` で `web-alb` の **DNS 名** (`DNSName`) を取り出して、`curl` で開くのだ。'),
          node('ブラウザで開くんじゃないんですか？'),
          hakase('`curl` は URL に HTTP でアクセスして、返ってきた中身を表示するコマンドだ。ターミナルのブラウザだと思えばよい。サーバー屋は画面を開くより先にこれを打つ。'),
          node('他人の「開きません」じゃなくて、自分の目で 504 を見る、ですね。'),
        ],
      },
      2: {
        type: 'exercise',
        title: '症状を確認する',
        objective: '`web-alb` の DNS 名を取り出し、`curl` でアクセスして 504 を確認する',
        tasks: [
          {
            id: 'dns',
            title: '`web-alb` の DNS 名を取り出す',
            hint: "`aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text`。`DNS=$(...)` で変数に入れておくと、次のコマンドで `$DNS` と書けます。",
            command: `DNS=$(${DNS_QUERY}); echo $DNS`,
            done: (c) => saw(c, ['elbv2 describe-load-balancers'], lbNamed(c.env, 'web-alb')?.dnsName),
          },
          { id: 'browse', title: '`curl` で ALB にアクセスして **504** を確認', hint: '`curl http://$DNS`。変数が消えていたら、DNS 名をそのまま書きます。', command: curlAlb, done: (c) => lastAlbRequest(c)?.status === 504 },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.status === 504
            ? ok(
                hakase('504 だな。「ALB は受け取ったが、Target が時間内に応答しなかった」という意味だ。'),
                node('ALB が 504 を返してくれてるってことは、Internet → ALB までは届いてるんですね。'),
                hakase('冴えておるな。怪しいのはその奥だ。次は `aws elbv2 describe-listeners` で `web-alb` のリスナーを見る。リスナーは Lesson 11 でやった、ALB の受付窓口 (HTTP:80) だったな。'),
                node('受付窓口の `DefaultActions` ってところに、注文の回し先が書いてあるんですか？'),
                hakase('そうだ。デフォルトアクションは「ほかに条件が無ければ、こうする」という既定の動きだ。そこにある `TargetGroupArn` (転送先 `web-tg` の ARN、AWS の中で 1 つに決まるフルネーム) を `aws elbv2 describe-target-health` に渡して、Lesson 13 で読んだヘルスの理由を見に行くのだ。'),
              )
            : ng(hakase('まだ 504 を確認していない。`aws elbv2 describe-load-balancers` で `web-alb` の `DNSName` を取り出し、`curl http://<DNS 名>` で開くのだ。')),
      },
      3: {
        type: 'exercise',
        title: 'ロードバランサー → ターゲットグループ → ターゲットのヘルスを調べる',
        objective: '`web-alb` のリスナーから転送先の `web-tg` を見つけ、`aws elbv2 describe-target-health` でターゲットのヘルスの理由を読む',
        tasks: [
          {
            id: 'lb',
            title: '`aws elbv2 describe-listeners` で `web-alb` のリスナーを見る',
            hint: "`--load-balancer-arn` に web-alb の ARN を渡します。ARN は `aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text` で取り出せます。`DefaultActions` の `TargetGroupArn` が転送先です。",
            command: (c) => `aws elbv2 describe-listeners --load-balancer-arn ${lbArn(c)}`,
            done: (c) => saw(c, ['elbv2 describe-listeners'], tgNamed(c.env, 'web-tg')?.targetGroupArn),
          },
          {
            id: 'tg',
            title: '`web-tg` のターゲットのヘルスを見る',
            hint: '`aws elbv2 describe-target-health --target-group-arn <TargetGroupArn>`。`TargetHealth` の `State`・`Reason`・`Description` を読みます。',
            command: tgHealth,
            done: sawTgHealth,
          },
        ],
        validate: (c) =>
          sawTgHealth(c)
            ? ok(
                node('2 台とも `"State": "unhealthy"` で、`"Description": "Request timed out"` って書いてあります。`Reason` は `Target.Timeout` です。'),
                hakase('Timeout は「パケットが届いていない」合図だ。アプリの不具合ではなく、**ネットワーク (Security Group)** で止まっている可能性が高い。'),
                node('アプリが壊れてたら、エラーでも何かしら返事は来るはず、ってことですね。'),
                hakase('そうだ。燃えている厨房でも悲鳴くらいは返す。無言なのは、注文票が届いていないからだ。'),
              )
            : ng(hakase('web-tg のターゲットのヘルスをまだ見ていないようだ。`describe-listeners` の `TargetGroupArn` を、`aws elbv2 describe-target-health --target-group-arn` に渡すのだ。')),
      },
      4: {
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
          hakase('そうだ。ID は `aws ec2 describe-security-groups --filters Name=group-name,Values=alb-sg` の `GroupId` に出ておる。そして ID は手で打たず、`--query` で取り出して**変数に入れる**。`sg-` から始まる長い英数字を深夜に手で打つのは、自分の首を絞める行為だ。'),
          node('1 文字間違えたら、別の Security Group を許可しちゃうかもしれないですもんね。'),
          hakase('あるいは存在しない ID で `InvalidGroup.NotFound` だ。どちらにしても始末書が 1 枚増える。ルールを足すのは `aws ec2 authorize-security-group-ingress`。`--cidr` の代わりに `--source-group` を付ければ、ソースに Security Group の ID を書ける。'),
          node('`--protocol tcp --port 3000 --source-group $ALB_SG`、ですね。'),
        ],
      },
      5: {
        type: 'exercise',
        title: 'ALB の SG ID を変数で受け渡して EC2 の SG に許可する',
        objective: '`web-sg` のインバウンドルールに「TCP 3000 / ソース = alb-sg の ID」を追加する',
        tasks: [
          {
            id: 'copy',
            title: '`alb-sg` の ID を変数に取り出す',
            hint: "`ALB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=alb-sg --query 'SecurityGroups[0].GroupId' --output text)`。`echo $ALB_SG` で中身を確かめます。",
            command: "ALB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=alb-sg --query 'SecurityGroups[0].GroupId' --output text); echo $ALB_SG",
            done: (c) => saw(c, ['ec2 describe-security-groups', 'elbv2 describe-load-balancers'], sgNamed(c.env, 'alb-sg')?.groupId),
          },
          {
            id: 'open',
            title: '`web-sg` の ID を取り出し、いまのインバウンドルールを見る',
            hint: "`WEB_SG=$(...)` で同じように取り出してから、`aws ec2 describe-security-groups --group-ids $WEB_SG --query 'SecurityGroups[0].IpPermissions'`。いまは SSH (22) のルールしかないはずです。",
            command: "WEB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=web-sg --query 'SecurityGroups[0].GroupId' --output text); aws ec2 describe-security-groups --group-ids $WEB_SG --query 'SecurityGroups[0].IpPermissions'",
            done: (c) => sawSg(c, 'web-sg'),
          },
          {
            id: 'paste',
            title: '`authorize-security-group-ingress` で TCP 3000 / ソース `alb-sg` を足す',
            hint: '`aws ec2 authorize-security-group-ingress --group-id $WEB_SG --protocol tcp --port 3000 --source-group $ALB_SG`。変数が消えていたら、ID を取り出し直します。',
            command: (c) => `aws ec2 authorize-security-group-ingress --group-id ${sgId(c, 'web-sg')} --protocol tcp --port 3000 --source-group ${sgId(c, 'alb-sg')}`,
            done: (c) => sgAllows(c.env, 'web-sg', 3000, { groupName: 'alb-sg', ip: '10.0.1.200' }),
          },
        ],
        validate: (c) => {
          if (!albReachesWeb(c.env)) return ng(hakase('まだ ALB から web-1 / web-2 の TCP 3000 に届かない。`--port 3000` で、`--source-group` に `alb-sg` の ID (`sg-...`) を渡したか？ `aws ec2 describe-security-groups --group-ids <web-sg の ID>` の `IpPermissions` で確かめるのだ。'));
          if (sgAllows(c.env, 'web-sg', 3000, { ip: '192.0.2.10' }))
            return ng(hakase('つながりはするが…`--cidr 0.0.0.0/0` で足したのではないか？ 厨房の勝手口を全世界に開けてどうする。EC2 は ALB 以外から 3000 番を受ける必要は無い。足したときと同じオプションで `aws ec2 revoke-security-group-ingress` を打って消し、`--source-group` で足し直すのだ。'));
          return ok(
            hakase('よし。これで「alb-sg が付いたもの (= ALB) から TCP 3000」だけが許可された。'),
            node('「整理」した人に、整理しすぎですって言っておきます。'),
            hakase('ついでに、消す前にルールの `Description` くらい読め、と付け加えておくのだな。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: '復旧を確認する',
        objective: 'Target が healthy になり、`curl` で 200 が返ることを確認する',
        tasks: [
          {
            id: 'healthy',
            title: '`web-tg` の Target がすべて **healthy**',
            hint: "`aws elbv2 describe-target-health --target-group-arn <web-tg の ARN>` で、`Request timed out` が消えて 2 台とも `\"State\": \"healthy\"` になったか確かめます。`--query 'TargetHealthDescriptions[].TargetHealth.State'` を付けると、状態だけが並びます。",
            command: tgHealthStates,
            done: sawHealthy,
          },
          { id: 'browse', title: '`curl` で ALB にアクセス → **200**', hint: 'ターゲットが healthy になってから、さっきと同じ `curl http://<DNS 名>` をもう一度打ちます。504 から変わったか確かめましょう。', command: curlAlb, done: (c) => lastAlbRequest(c)?.status === 200 },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.status === 200
            ? ok(
                node('直りました！ Target も両方 healthy です！'),
                hakase('症状を確かめ、外側から辿り、Timeout からネットワークを疑い、ID は変数で受け渡して直す。今日の手順は、そのまま本物の障害でも使える。'),
                node('もう 504 が出ても怖くないです。'),
                hakase('その油断が次の障害を呼ぶのだ。まあ、呼ばれたらまたワシを呼ぶがよい。'),
              )
            : ng(hakase('最新のアクセスがまだ 200 ではない。`describe-target-health` で 2 台とも healthy になったのを確かめてから、もう一度 `curl` で ALB を開くのだ。')),
      },
    },
  },

  /* ---- Lesson 16-2 ---- */
  'nacl-troubleshooting': {
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('ネットワーク ACL は**ステートレス**でしたよね。行きを通しても、戻りの返事はまた別に名簿で調べられる。'),
          hakase('正解だ。今日は雪どころか槍が降るかもしれん。'),
          node('素直に褒めてください。'),
          hakase('褒めるのは直してからだ。今回は登場人物が多い。ALB は public subnet、EC2 と RDS は private subnet にいる。'),
          node('ALB → EC2 も、EC2 → RDS も、サブネットをまたぐんですね。'),
          hakase('そうだ。関所をまたぐ通信は全部、行きと戻りの両方の名簿が要る。1 本でも帰り道が無ければ Timeout だ。'),
          node('疑うところが一気に増えましたね…'),
          hakase('だから順番を守る。まず症状、次に Target のヘルス、それから EC2 がいるサブネットの関所だ。`curl` で ALB を開いて 504 を確かめ、`aws elbv2 describe-target-health` で `web-tg` のヘルスの理由を読むのだ。'),
        ],
      },
      2: {
        type: 'exercise',
        title: '症状とターゲットのヘルスを確認する',
        objective: '`curl` で 504 を確認し、`web-tg` のターゲットのヘルスの理由を見る',
        tasks: [
          { id: 'browse', title: '`curl` で ALB にアクセス → **504**', hint: "DNS 名は `aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text` で取り出せます。`curl http://$(...)` のように、`$(...)` をコマンドの中に直接書いても構いません。", command: curlAlb, done: (c) => lastAlbRequest(c)?.status === 504 },
          {
            id: 'tg',
            title: '`web-tg` のターゲットのヘルスを見る',
            hint: "`aws elbv2 describe-target-health --target-group-arn <web-tg の ARN>`。ARN は `aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text` で取り出せます。`TargetHealth` の `Description` に異常の理由が出ます。",
            command: tgHealth,
            done: sawTgHealth,
          },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.status === 504 && sawTgHealth(c)
            ? ok(
                node('`Request timed out` です。Lesson 16 とまったく同じ顔をしてます。'),
                hakase('Timeout はネットワークで止まっている合図だ。Security Group が正しいなら、次に疑うのは**サブネットのネットワーク ACL** だ。'),
                node('`web-1` がいるのは `private-subnet-1a` ですよね。そこの関所を見に行きます。'),
                hakase('`aws ec2 describe-instances` で web-1 の `SubnetId` を取り出し、`aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=<サブネット ID>` と打てば、そのサブネットに付いている関所の名簿がそのまま読めるのだ。'),
              )
            : ng(hakase('504 の確認と、ターゲットのヘルスの確認の両方をするのだ。`curl` で ALB の DNS 名を開き、それから `aws elbv2 describe-target-health` で `web-tg` を見るのだ。')),
      },
      3: {
        type: 'exercise',
        title: 'EC2 のサブネットのネットワーク ACL を調べる',
        objective: '`web-1` がいる `private-subnet-1a` の **ネットワーク ACL** を `aws ec2 describe-network-acls` で取り出し、インバウンドとアウトバウンドのルールを確認する',
        tasks: [
          {
            id: 'subnet',
            title: '`web-1` のサブネット ID を取り出す',
            hint: "`SUBNET_ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[0].Instances[0].SubnetId' --output text)`。`aws ec2 describe-subnets --subnet-ids $SUBNET_ID` で、Name タグが `private-subnet-1a` かも確かめられます。",
            command: "SUBNET_ID=$(aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[0].Instances[0].SubnetId' --output text); echo $SUBNET_ID",
            done: (c) => saw(c, ['ec2 describe-instances', 'ec2 describe-subnets'], subnetNamed(c.env, 'private-subnet-1a')?.subnetId),
          },
          {
            id: 'acl',
            title: 'そのサブネットのネットワーク ACL を見る',
            hint: '`aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=$SUBNET_ID`。`Entries` のうち `"Egress": false` がインバウンド、`"Egress": true` がアウトバウンドのルールです (`"Protocol": "6"` は TCP のプロトコル番号)。行きの通信と戻りの通信のポートが、それぞれ許可されているか見比べましょう。',
            command: (c) => `aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=${subnetNamed(c.env, 'private-subnet-1a')?.subnetId ?? '<サブネット ID>'}`,
            done: (c) => saw(c, ['ec2 describe-network-acls'], naclNamed(c.env, 'private-nacl')?.networkAclId),
          },
        ],
        validate: (c) =>
          saw(c, ['ec2 describe-network-acls'], naclNamed(c.env, 'private-nacl')?.networkAclId)
            ? ok(
                node('`"Egress": false` のインバウンドは、3000 も 3306 も戻り通信用の 1024-65535 も `allow` です。でも `"Egress": true` のアウトバウンドは 3306 と 443 だけ…'),
                hakase('それだ。ALB → EC2 の**リクエスト**は入れる。だが EC2 から ALB への**返事**の宛先は ALB のエフェメラルポート (1024〜65535)。アウトバウンドの最後の `*` の行 (ルール番号 32767 の `deny`) で拒否されておる。'),
                node('443 って何でしたっけ？'),
                hakase('HTTPS、暗号化した HTTP の番号だ。「アプリが外へ送るのは DB への 3306 と HTTPS だけ」と、行きのことだけ考えて書いた名簿だな。入ってきた客への返事のことは、誰も考えなかった。'),
                hakase('次の表に、戻り通信の宛先になるエフェメラルポートをまとめておいた。NLB は ALB の兄弟分のロードバランサーで、この一家をまとめて Elastic Load Balancing と呼ぶ。NAT ゲートウェイは private subnet からインターネットへ出ていくための出口だ。どちらも今は名前だけ覚えておけばよい。'),
              )
            : ng(hakase('private-subnet-1a のネットワーク ACL をまだ見ていないようだ。web-1 の `SubnetId` を、`aws ec2 describe-network-acls --filters Name=association.subnet-id,Values=<サブネット ID>` に渡すのだ。')),
      },
      5: {
        type: 'exercise',
        title: '戻り通信を許可する',
        objective: '`private-nacl` のアウトバウンドルールに「ルール番号 `120` / TCP `1024-65535` / 送信先 `10.0.0.0/16` / 許可」を追加し、ALB → EC2 と EC2 → RDS の両方をつなぐ',
        tasks: [
          {
            id: 'edit',
            title: '`private-nacl` の ID を変数に取り出す',
            hint: "`ACL_ID=$(aws ec2 describe-network-acls --filters Name=tag:Name,Values=private-nacl --query 'NetworkAcls[0].NetworkAclId' --output text)`。さっきの出力の `NetworkAclId` と同じものです。",
            command: "ACL_ID=$(aws ec2 describe-network-acls --filters Name=tag:Name,Values=private-nacl --query 'NetworkAcls[0].NetworkAclId' --output text); echo $ACL_ID",
            done: (c) => !!ranAws(c, 'ec2 describe-network-acls', (x) => !!x.query && x.output.includes(naclNamed(c.env, 'private-nacl')?.networkAclId ?? '-')),
          },
          {
            id: 'add',
            title: '`create-network-acl-entry` で `120` / TCP / `1024-65535` / `10.0.0.0/16` / 許可 のアウトバウンドルールを足す',
            hint: '`aws ec2 create-network-acl-entry --network-acl-id $ACL_ID --egress --rule-number 120 --protocol tcp --port-range From=1024,To=65535 --cidr-block 10.0.0.0/16 --rule-action allow`。`--egress` を付け忘れるとインバウンドのルールになります (インバウンドの 120 は使用済みなので `NetworkAclEntryAlreadyExists` で止まります)。送信先を VPC の CIDR (10.0.0.0/16) にすると、VPC 内への戻り通信だけを許可できます。',
            command: (c) => `aws ec2 create-network-acl-entry --network-acl-id ${naclNamed(c.env, 'private-nacl')?.networkAclId ?? '<private-nacl の ID>'} --egress --rule-number 120 --protocol tcp --port-range From=1024,To=65535 --cidr-block 10.0.0.0/16 --rule-action allow`,
            done: (c) => albReachesWeb(c.env),
          },
        ],
        validate: (c) => {
          if (!albReachesWeb(c.env))
            return ng(
              hakase('まだ ALB → EC2 の戻り通信が拒否されておる。`--egress` を付けて「TCP / `1024-65535` / `10.0.0.0/16` / allow」を足したか？ `describe-network-acls` の `"Egress": true` の行で確かめるのだ。'),
              hakase('`curl -v` で ALB を開けば、拒否されたポート範囲も分かる。`-v` を付けると、シミュレーターが経路のどこで止まったかを `*` の行で教えてくれる。本物の curl には無い、学習用のおまけだ。'),
            );
          if (!webReachesDb(c.env))
            return ng(
              hakase('ALB → EC2 はつながった。だが web-2 (private-subnet-1c) → RDS (private-subnet-1a) の戻り通信がまだ拒否されておる。'),
              node('サブネットをまたぐから、DB 側のサブネットから web-2 のエフェメラルポート (32768-60999) への返事が要るんですね。'),
              hakase('送信先を ALB のサブネットだけに絞ったのではないか？ `aws ec2 replace-network-acl-entry` に同じルール番号と `--cidr-block 10.0.0.0/16` を付けて書き換えれば、VPC 全体をまとめて面倒を見られる。'),
            );
          return ok(
            hakase('ALB → EC2 も EC2 → RDS もつながった。`10.0.0.0/16` 宛ての 1024-65535 で、どちらの戻り通信もカバーできたな。'),
            node('送信先を VPC の中 (`10.0.0.0/16`) だけにしたから、外の世界への余計な出口は増やしてない、と。'),
            hakase('うむ。関所の名簿には、必要な帰り道だけを書く。これでセキュリティ担当の笑顔も守られたわけだ。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: '復旧を確認する',
        objective: 'ターゲットが healthy になり、`curl` で `Database: connected` が表示されることを確認する',
        tasks: [
          {
            id: 'healthy',
            title: '`web-tg` のターゲットがすべて **healthy**',
            hint: '`aws elbv2 describe-target-health --target-group-arn <web-tg の ARN>` で、2 台の `State` が `healthy` か確かめます。`unhealthy` のままなら `Description` の理由を見直します。',
            command: tgHealthStates,
            done: sawHealthy,
          },
          { id: 'browse', title: '`curl` で ALB にアクセス → **200 / Database: connected**', hint: '`curl http://<DNS 名>` をもう一度打ち、本文に `Database: connected` が出るか確認します。', command: curlAlb, done: (c) => !!lastAlbRequest(c)?.body.includes('Database: connected') },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.body.includes('Database: connected')
            ? ok(
                node('直りました！ `Database: connected` です！'),
                hakase('Security Group が正しいのに Timeout なら、ネットワーク ACL。そして ACL は戻り通信まで見る。今日の教訓はこれだけだ。'),
                node('次に「強化しておきました」って聞いたら、帰り道を確認します。'),
                hakase('うむ。「強化」とは、たいてい誰かの帰り道を塞ぐことだからな。'),
              )
            : ng(hakase('まだ `Database: connected` が出ていない。`describe-target-health` で 2 台とも healthy になったのを確かめてから、`curl` で ALB を開き直すのだ。')),
      },
    },
  },

  /* ---- Lesson 17 ---- */
  'target-unhealthy': {
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          node('「待ち受けていない」って、どういう状態ですか？'),
          hakase('ポートは、サーバーの中の窓口の番号だ。アプリは決まった番号の窓口に座って、客を待つ。これを「待ち受ける」、英語で listen という。'),
          node('誰も座っていない窓口に行ったら？'),
          hakase('「その窓口はやっておりません」と即座に突き返される。これが**接続拒否**だ。待たされないぶん、Timeout よりは親切だな。'),
          node('親切な門前払い…'),
          hakase('Lesson 16 で見た `Request timed out` は、門の前にすら着けなかった。今回は門まで着いて、叩いて、断られた可能性が高い。'),
          node('じゃあ Security Group は通ってる、ってことですか？'),
          hakase('仮説としてはな。確かめるのはいつもの順番だ。まず `curl` で 502 を見て、`aws elbv2 describe-target-health` で `web-tg` のヘルスの理由と、ターゲットの**ポート** (`Target` の `Port`) を見るのだ。'),
          node('ポートも見るんですね。'),
          hakase('窓口の番号を間違えた本人は、たいてい自分では気づかん。…ところでノード君、この環境を作り直したのは誰だったかな？'),
          node('…さあ、誰でしたっけ。'),
        ],
      },
      3: {
        type: 'exercise',
        title: '症状とターゲットのヘルスを確認する',
        objective: '`curl` で 502 を確認し、`web-tg` のターゲットのヘルスの理由と **ポート** を見る',
        tasks: [
          { id: 'browse', title: '`curl` で ALB にアクセス → **502**', hint: "DNS 名は `aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text` で取り出し、`curl http://<DNS 名>` で開きます。", command: curlAlb, done: (c) => lastAlbRequest(c)?.status === 502 },
          {
            id: 'tg',
            title: '`web-tg` のターゲットのヘルスとポートを見る',
            hint: "`aws elbv2 describe-target-health --target-group-arn <web-tg の ARN>`。ARN は `aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text` で取り出せます。`Target` の `Port` を、アプリが待ち受けているポートと見比べましょう。",
            command: tgHealth,
            done: sawTgHealth,
          },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.status === 502 && sawTgHealth(c)
            ? ok(
                node('`"Description": "Health checks failed"` です。Timeout じゃないですね。それと `Target` の `Port` が **80** になってます。'),
                hakase('Timeout でないということは、パケットは届いている (SG は通っている)。だが port 80 では誰も待ち受けていないから、接続を拒否されているのだ。'),
                hakase('このアプリは **port 3000** で動いている。Target group を作るとき、`create-target-group` の例を写して `--port 80` のまま作ってしまったのだろう。'),
                node('例のコマンドを、ポートも見ずにそのまま打ったんですね…誰かが。'),
                hakase('「とりあえずコピペ」は、障害報告書の原因欄の常連だ。'),
              )
            : ng(hakase('502 の確認と、ターゲットのヘルスの確認の両方をするのだ。`curl` で ALB を開いてから、`aws elbv2 describe-target-health` で `web-tg` の `Target` の `Port` を見るのだ。')),
      },
      4: {
        type: 'dialogue',
        lines: [
          node('Target group のポートを 3000 に変更すればいいんですね！ `aws elbv2 modify-target-group` に `--port 3000` を付けて…'),
          hakase('打っても無駄だ。`modify-target-group` に `--port` は無い。Target group のプロトコルとポートは**作成後に変更できない**。'),
          node('ええっ、じゃあ作り直しですか？'),
          hakase('それも手だが、リスナーの転送先の付け替えまで要る。もっと楽な道がある。Target を登録するとき、ポートを 1 台ずつ指定できるのだ。'),
          node('じゃあ Target group のポートって、ただの初期値なんですか？'),
          hakase('そうだ。`register-targets` の `--targets` で `Port` を省いたときの初期値にすぎん。実際に使われるのは、Target ごとに登録したポートだ。'),
          node('web-1 と web-2 を 3000 で登録し直せばいいんですね。'),
          hakase('うむ。そして 80 で登録されている方は `aws elbv2 deregister-targets` で「登録解除」、つまり名簿から外す。'),
          node('3000 で登録できたら、80 のは放っておいてもよくないですか？'),
          hakase('よくない。Lesson 13 の **fail open** を覚えておるか。'),
          node('全 Target が unhealthy になると、ALB が「全部止めるよりマシ」って unhealthy な Target にも送るやつ…あ、今の 502 もそれですね。'),
          hakase('その通り。80 の亡霊を残しておくと、何かの拍子にまた 502 を呼び出す。登録も解除も `--targets Id=<インスタンス ID>,Port=3000` のように、ID とポートの組で書くのだ。同じインスタンスでも、ポートが違えば別の Target だからな。'),
          node('ヘルスチェックも 3000 で見てくれるんですか？'),
          hakase('Lesson 13 の表にあったな。ヘルスチェックのポートは通常「トラフィックポート」(`traffic-port`)、つまり Target の登録ポートだ。3000 で登録すれば、3000 がチェックされる。'),
        ],
      },
      5: {
        type: 'exercise',
        title: 'Target を port 3000 で登録し直す',
        objective: '`web-1` / `web-2` をポート `3000` で登録し、ポート `80` のターゲットを登録解除して、すべて **healthy** にする',
        tasks: [
          {
            id: 'register',
            title: '`register-targets` で web-1, web-2 をポート `3000` で登録',
            hint: 'インスタンス ID は、さっきの `describe-target-health` の `Target` の `Id` に出ています。`aws elbv2 register-targets --target-group-arn <web-tg の ARN> --targets Id=<web-1 の ID>,Port=3000 Id=<web-2 の ID>,Port=3000`。2 台は空白で区切って並べます。',
            command: (c) => `aws elbv2 register-targets --target-group-arn ${tgArn(c)} --targets Id=${iid(c, 'web-1')},Port=3000 Id=${iid(c, 'web-2')},Port=3000`,
            done: (c) => ['web-1', 'web-2'].every((n) => tgNamed(c.env, 'web-tg')?.targets.some((t) => t.id === instanceNamed(c.env, n)?.instanceId && t.port === 3000)),
          },
          {
            id: 'deregister',
            title: '`deregister-targets` でポート `80` のターゲットを登録解除',
            hint: '`aws elbv2 deregister-targets --target-group-arn <web-tg の ARN> --targets Id=<web-1 の ID>,Port=80 Id=<web-2 の ID>,Port=80`',
            command: (c) => `aws elbv2 deregister-targets --target-group-arn ${tgArn(c)} --targets Id=${iid(c, 'web-1')},Port=80 Id=${iid(c, 'web-2')},Port=80`,
            done: (c) => !tgNamed(c.env, 'web-tg')?.targets.some((t) => t.port === 80),
          },
          {
            id: 'healthy',
            title: 'すべてのターゲットが **healthy**',
            hint: '`aws elbv2 describe-target-health` で確かめます。ヘルスチェックのポートは `traffic-port` なので、登録した 3000 番がチェックされます (`HealthCheckPort` が `"3000"` になります)。',
            command: tgHealthStates,
            done: sawHealthy,
          },
        ],
        validate: (c) => {
          const tg = tgNamed(c.env, 'web-tg')!;
          if (tg.targets.some((t) => t.port === 80)) return ng(hakase('ポート 80 の Target が残っている。unhealthy な亡霊は、fail open のときにまた 502 の原因になるぞ。`aws elbv2 deregister-targets` に `Id=<インスタンス ID>,Port=80` を並べて登録解除するのだ。'));
          if (!allTargetsHealthy(c.env, 'web-tg', 2)) return ng(hakase('healthy でない Target があるようだ。`describe-target-health` で、web-1 と web-2 の両方がポート 3000 で登録されているか確認するのだ。'));
          return ok(
            hakase('全 Target が port 3000 で healthy になった。'),
            node('窓口の番号を合わせただけで、門前払いが終わりました。'),
            hakase('番号 1 つで世界は変わる。接続先を 1 文字間違えて本番 DB に入り、テーブルを消した男をワシは知っておる。'),
            node('その人、どうなったんですか？'),
            hakase('今は障害報告書の書き方を教えておる。…ワシだがな。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: '復旧を確認する',
        objective: '`curl` で ALB にアクセスし、200 を確認する',
        tasks: [{ id: 'browse', title: '`curl` で ALB にアクセス → **200**', hint: 'ターゲットが 2 台ともポート 3000 で healthy になってから、`curl http://<DNS 名>` をもう一度打ちます。', command: curlAlb, done: (c) => lastAlbRequest(c)?.status === 200 }],
        validate: (c) =>
          lastAlbRequest(c)?.status === 200
            ? ok(
                node('502 が消えました！ 200 です！'),
                hakase('Timeout なら経路、門前払いならポートかアプリ。5xx の数字と `describe-target-health` の理由を並べれば、どこを見るべきかは半分決まる。'),
                node('これで 5xx コレクターも卒業ですね。'),
                hakase('安心したまえ。まだ 500 が残っておる。'),
              )
            : ng(hakase('最新のアクセスがまだ 200 ではない。ターゲットが両方 healthy になっているのを `describe-target-health` で確かめて、もう一度 `curl` で ALB を開くのだ。')),
      },
      7: {
        type: 'quiz',
        question: hakase('問題だ。Security Group で ALB → EC2 が遮断されているとき、お客さんのブラウザや `curl` に出やすいのはどれかな？'),
        options: ['502 Bad Gateway', '504 Gateway Time-out', '404 Not Found'],
        answer: 1,
        explanation: [
          hakase('正解。遮断されたパケットには返事が来ないから Timeout、つまり 504 になる。`describe-target-health` の `Request timed out` とセットで覚えるのだ。'),
          node('Timeout なら Security Group やネットワーク ACL、Health checks failed ならポートやアプリ、ですね。'),
          hakase('うむ。この 2 行を覚えておけば、深夜の呼び出しが 30 分は短くなる。'),
        ],
      },
    },
  },

  /* ---- Lesson 18 ---- */
  'ec2-rds-troubleshooting': {
    summary: 'Application cannot connect to database を、RDS に付いている VPC セキュリティグループから調べる',
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('`curl` で開けばいいんですね。'),
          hakase('そうだ。そこで出る数字で、切り分けが半分終わる。502 か 504 なら、ALB → EC2 が怪しい。'),
          node('Lesson 16 と 17 の、ALB が Target からまともな返事をもらえなかったやつですね。'),
          hakase('だが **500 Internal Server Error** なら話は別だ。500 は「サーバー内部のエラー」。アプリ自身が「すみません、中で失敗しました」と返事をした、という意味だ。'),
          node('アプリが返事をしてるなら、ALB → EC2 は届いてるってことですか？'),
          hakase('冴えておるな。店員が客に謝れるなら、少なくとも客と店員の間はつながっておる。謝っている理由は、倉庫 (DB) に行けないからだ。'),
          node('倉庫の鍵を、誰かが勝手に替えちゃった、みたいな。'),
          hakase('鍵を替えた奴は、たいてい「セキュリティのためです」と言う。では、`curl -i` で ALB を開いて、何番が出るか見てみよ。'),
          node('あい？'),
          hakase('`-i` を付けると、本文の前に返事の頭 (ヘッダー) も出る。1 行目の `HTTP/1.1 200 OK` の 200 のような数字が、ステータスコードだ。本文だけ見て番号を当てるのは、占い師の仕事だ。'),
        ],
      },
      2: {
        type: 'exercise',
        title: '症状を確認する',
        objective: '`curl -i` で ALB にアクセスし、HTTP 500 を確認する',
        tasks: [
          {
            id: 'browse',
            title: '`curl -i` で ALB にアクセス → **500**',
            hint: "DNS 名は `aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text` で取り出し、`curl -i http://<DNS 名>` で開きます。1 行目のステータスコードに加えて、本文のエラーメッセージも読んでおきましょう。",
            command: (c) => `curl -i http://${dns(c)}`,
            done: (c) => lastAlbRequest(c)?.status === 500,
          },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.status === 500
            ? ok(
                hakase('500 は「アプリ自身がエラーを返した」だ。つまり Internet → ALB → EC2 は**届いている**。怪しいのはその先、EC2 → RDS だな。'),
                node('本文にも `connect ETIMEDOUT` って出てます。ログと同じですね。'),
                hakase('エラーの中身をお客さんの画面にまで出すのは、本番ではやめたほうがいい。攻撃者への親切な道案内になるからな。今日のところは助かったが。'),
                hakase('次は RDS 側だ。Lesson 14 でエンドポイント (`Endpoint`) を見た `aws rds describe-db-instances` に、DB に付いている **VPC セキュリティグループ** (`VpcSecurityGroups`) も出ておる。'),
              )
            : ng(hakase('まだ 500 を確認していない。`web-alb` の DNS 名を取り出し、`curl -i http://<DNS 名>` で開くのだ。')),
      },
      3: {
        type: 'exercise',
        title: 'RDS → VPC セキュリティグループ → インバウンドルールを調べる',
        objective: '`aws rds describe-db-instances` で `webapp-db` に付いている VPC セキュリティグループ `db-sg` を調べ、そのインバウンドルールを確認する',
        tasks: [
          {
            id: 'db',
            title: '`webapp-db` の VPC セキュリティグループを見る',
            hint: "`aws rds describe-db-instances --db-instance-identifier webapp-db --query 'DBInstances[0].VpcSecurityGroups'`。`VpcSecurityGroupId` が DB に付いている Security Group の ID です。",
            command: "aws rds describe-db-instances --db-instance-identifier webapp-db --query 'DBInstances[0].VpcSecurityGroups'",
            done: (c) => saw(c, ['rds describe-db-instances'], sgNamed(c.env, 'db-sg')?.groupId),
          },
          {
            id: 'sg',
            title: 'その Security Group (`db-sg`) のインバウンドルールを見る',
            hint: "`aws ec2 describe-security-groups --group-ids <VpcSecurityGroupId> --query 'SecurityGroups[0].IpPermissions'`。ソースは `IpRanges` (CIDR) か `UserIdGroupPairs` (Security Group) に出ます。",
            command: (c) => `aws ec2 describe-security-groups --group-ids ${sgId(c, 'db-sg')} --query 'SecurityGroups[0].IpPermissions'`,
            done: (c) => sawSg(c, 'db-sg'),
          },
        ],
        validate: (c) =>
          sawSg(c, 'db-sg')
            ? ok(
                node('`IpRanges` の `CidrIp` が `10.0.1.0/24` です。`Description` には「MySQL from app servers」って書いてあるのに。'),
                hakase('10.0.1.0/24 は **public-subnet-1a** の範囲だ。web-1 / web-2 は private-subnet (10.0.11.0/24, 10.0.12.0/24) にいる。だから届かない。引っ越したのに転送届を出さなかったわけだ。'),
                node('じゃあ Lesson 15 の「Security Group の鎖」みたいに、ソースを `web-sg` の ID にすれば、住所が変わっても大丈夫ですね。'),
                hakase('そうだ。`web-1` に付いている `web-sg` の ID を変数に取り出して、`--source-group` に渡すのだ。手で打つなよ。'),
                hakase('古いルールも残しておく理由は無い。`aws ec2 revoke-security-group-ingress` で消すのだ。revoke は「取り消す」。足したときと同じ `--protocol tcp --port 3306 --cidr 10.0.1.0/24` を付ければ、そのルールが消える。'),
              )
            : ng(hakase('db-sg のインバウンドルールをまだ見ていない。`describe-db-instances` の `VpcSecurityGroupId` を、`aws ec2 describe-security-groups --group-ids` に渡すのだ。')),
      },
      4: {
        type: 'exercise',
        title: 'ソースを web-sg に直す',
        objective: '`db-sg` のインバウンドルールのソースを、EC2 に付いている `web-sg` の ID にする (`10.0.1.0/24` のルールは消す)',
        tasks: [
          {
            id: 'copy',
            title: '`web-1` に付いている `web-sg` の ID を変数に取り出す',
            hint: "`WEB_SG=$(aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)`。`echo $WEB_SG` で中身を確かめます。",
            command: "WEB_SG=$(aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text); echo $WEB_SG",
            done: (c) => saw(c, ['ec2 describe-instances', 'ec2 describe-security-groups'], sgNamed(c.env, 'web-sg')?.groupId),
          },
          {
            id: 'edit',
            title: '`db-sg` に TCP 3306 / ソース `web-sg` のルールを足す',
            hint: '`aws ec2 authorize-security-group-ingress --group-id <db-sg の ID> --protocol tcp --port 3306 --source-group $WEB_SG`。先に新しいルールを足してから古いルールを消すと、つながらない時間を作らずに済みます。',
            command: (c) => `aws ec2 authorize-security-group-ingress --group-id ${sgId(c, 'db-sg')} --protocol tcp --port 3306 --source-group ${sgId(c, 'web-sg')}`,
            done: (c) => sgAllows(c.env, 'db-sg', 3306, { groupName: 'web-sg', ip: '10.0.11.200' }),
          },
          {
            id: 'revoke',
            title: '古い `10.0.1.0/24` のルールを消す',
            hint: '`aws ec2 revoke-security-group-ingress --group-id <db-sg の ID> --protocol tcp --port 3306 --cidr 10.0.1.0/24`',
            command: (c) => `aws ec2 revoke-security-group-ingress --group-id ${sgId(c, 'db-sg')} --protocol tcp --port 3306 --cidr 10.0.1.0/24`,
            done: (c) => !!sgNamed(c.env, 'db-sg') && !sgNamed(c.env, 'db-sg')!.ingress.some((r) => r.cidrIpv4 === '10.0.1.0/24'),
          },
        ],
        validate: (c) => {
          if (!webReachesDb(c.env)) return ng(hakase('まだ web-1 / web-2 から webapp-db の 3306 に届かない。`aws ec2 describe-security-groups --group-ids <db-sg の ID>` の `UserIdGroupPairs` に、ポート 3306 で `web-sg` の ID があるか確認するのだ。'));
          if (sgAllows(c.env, 'db-sg', 3306, { ip: '192.0.2.10' })) return ng(hakase('DB が全世界に開いておる！ 顧客データを世界中に配る気か。`--cidr 0.0.0.0/0` のルールは `revoke-security-group-ingress` で消して、ソースは web-sg にするのだ。'));
          return ok(
            hakase('EC2 → RDS がつながった。'),
            node('これで web-1 でも web-2 でも、web-sg が付いていれば DB に入れるんですね。'),
            hakase('うむ。台数が 100 台に増えても、ルールは 1 行のままだ。'),
          );
        },
      },
      5: {
        type: 'exercise',
        title: '復旧を確認する',
        objective: '`curl` で `Database: connected` を確認する',
        tasks: [
          {
            id: 'browse',
            title: '`curl` で ALB にアクセス → **200 / Database: connected**',
            hint: '`curl -i http://<DNS 名>` を打ち直します。まだ `connect ETIMEDOUT` が出るなら、`db-sg` のインバウンドルールのソースを見直します。',
            command: (c) => `curl -i http://${dns(c)}`,
            done: (c) => !!lastAlbRequest(c)?.body.includes('Database: connected'),
          },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.body.includes('Database: connected')
            ? ok(
                node('つながりました！ `Database: connected` です！'),
                hakase('ログで当たりを付け、`curl` の 500 で区間を絞り、RDS から Security Group を辿って直す。見事な切り分けだ。'),
                node('博士、僕そろそろ給料上がりますかね？'),
                hakase('上がるとも。DB のルールを書き換えた誰かの減給分が回ってくればな。'),
              )
            : ng(hakase('まだ `Database: connected` が出ていない。もう一度 `curl` で ALB を開き直して、本文を見るのだ。')),
      },
    },
  },

  /* ---- Lesson 19 ---- */
  'mvp-final': {
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('ヒントは少なめ、ですよね…'),
          hakase('うむ。だが材料は全部習った。ALB → EC2 は何番ポートで、ソースは何だったかな？'),
          node('アプリのポート 3000 で、ソースは ALB の Security Group の ID。ID は手で打たずに変数で受け渡す。Lesson 16 でやりました。'),
          hakase('では EC2 → RDS は？'),
          node('MySQL の 3306 で、ソースは EC2 の Security Group の ID。Lesson 18 の、転送届を出し忘れたやつです。'),
          hakase('よろしい。次の構成図は、今の環境をそのまま映した **Live** の図だ。パネルの「構成図」タブでもいつでも見られる。どこが塞がっているか眺めてから、CLI で直すのだ。'),
          node('全部つながったら、僕の給料も上がりますか？'),
          hakase('考えておこう。考えるだけだがな。'),
        ],
      },
      3: {
        type: 'exercise',
        title: 'ALB → EC2 をつなぐ',
        objective: 'ALB の Security Group を確認して ID を取り出し、EC2 の Security Group にインバウンドルールを足して ALB → EC2 を Connected にする',
        tasks: [
          {
            id: 'copy',
            title: 'ALB のセキュリティグループを確認し、ID を **取り出す**',
            hint: '`aws elbv2 describe-load-balancers --names web-alb` の `SecurityGroups`。',
            command: "ALB_SG=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].SecurityGroups[0]' --output text); echo $ALB_SG",
            done: (c) => saw(c, ['elbv2 describe-load-balancers', 'ec2 describe-security-groups'], sgNamed(c.env, 'alb-sg')?.groupId),
          },
          {
            id: 'fix',
            title: 'EC2 のセキュリティグループにインバウンドルールを追加',
            hint: 'アプリのポートは `describe-target-health` の `Target` の `Port` を見れば分かります。EC2 のセキュリティグループは `describe-instances` の `SecurityGroups` に出ています。',
            command: (c) => `aws ec2 authorize-security-group-ingress --group-id ${sgId(c, 'web-sg')} --protocol tcp --port 3000 --source-group ${sgId(c, 'alb-sg')}`,
            done: (c) => albReachesWeb(c.env),
          },
        ],
        validate: (c) => {
          if (!albReachesWeb(c.env)) return ng(hakase('ALB → EC2 はまだ Blocked だ。ポートはターゲットの登録ポート、ソースは `alb-sg` の ID だったな。「構成図」タブで線の色も見てみるのだ。'));
          if (sgAllows(c.env, 'web-sg', 3000, { ip: '192.0.2.10' })) return ng(hakase('つながったが、EC2 が全世界に開いているぞ。最終課題で始末書を書く気か。`--cidr 0.0.0.0/0` のルールは `revoke-security-group-ingress` で消し、ソースを ALB の Security Group の ID にしよう。'));
          return ok(
            hakase('**ALB → EC2 Connected**。'),
            node('ここまでは Lesson 16 の復習ですね。取り出して、変数に入れて、足す。'),
            hakase('油断するでない。次は DB だ。'),
          );
        },
      },
      4: {
        type: 'exercise',
        title: 'EC2 → RDS をつなぐ',
        objective: 'RDS の Security Group を確認し、EC2 の Security Group をソースにして EC2 → RDS を Connected にする',
        tasks: [
          {
            id: 'find',
            title: 'RDS の Security Group を確認',
            hint: '`aws rds describe-db-instances` の `VpcSecurityGroups`。',
            command: "aws rds describe-db-instances --db-instance-identifier webapp-db --query 'DBInstances[0].VpcSecurityGroups'",
            done: (c) => saw(c, ['rds describe-db-instances'], sgNamed(c.env, 'db-sg')?.groupId),
          },
          {
            id: 'fix',
            title: 'EC2 の SG をソースにして MySQL (3306) を許可',
            hint: '`--protocol tcp --port 3306` で、`--source-group` に EC2 の SG (`web-sg`) の ID を渡します。',
            command: (c) => `aws ec2 authorize-security-group-ingress --group-id ${sgId(c, 'db-sg')} --protocol tcp --port 3306 --source-group ${sgId(c, 'web-sg')}`,
            done: (c) => webReachesDb(c.env),
          },
        ],
        validate: (c) => {
          if (!webReachesDb(c.env)) return ng(hakase('EC2 → RDS はまだ Blocked だ。`db-sg` のインバウンドルールに、MySQL (3306) をソース `web-sg` の ID で足したかな？'));
          if (sgAllows(c.env, 'db-sg', 3306, { ip: '192.0.2.10' })) return ng(hakase('DB が全世界に開いておる！ 最終課題で情報漏えいとは、ある意味伝説だ。`--cidr 0.0.0.0/0` のルールは消して、ソースは EC2 の Security Group (`web-sg`) の ID にするのだ。'));
          return ok(
            hakase('**EC2 → RDS Connected**。'),
            node('構成図の線、全部緑になってるかな…'),
            hakase('自分の目で確かめるがよい。次の図だ。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: 'ALL CONNECTED',
        objective: '`curl` で ALB にアクセスし、Internet → ALB → EC2 → RDS がすべてつながったことを確認する',
        tasks: [
          {
            id: 'browse',
            title: '`curl` で ALB にアクセス → **Database: connected**',
            hint: '`web-alb` の DNS 名を `curl` で開きます。表示されないときは、パネルの「構成図」タブで Blocked の区間が残っていないか確認します。`curl -v` (経路の確認結果を `*` の行で出す、シミュレーターのおまけ) でも、止まっている区間が分かります。',
            command: curlAlb,
            done: (c) => !!lastAlbRequest(c)?.body.includes('Database: connected'),
          },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.body.includes('Database: connected') && allTargetsHealthy(c.env, 'web-tg', 2)
            ? ok(
                hakase('**Internet → ALB → EC2 → RDS  ALL CONNECTED**。'),
                node('やった！ 自分の手で直せました！'),
                hakase('見事だ。実際の AWS でも、やることは同じだ。症状を確かめ、外側から 1 区間ずつ調べ、ID は変数で正確に受け渡す。これを忘れるでないぞ。'),
                node('博士、約束の給料の件は…'),
                hakase('考えた。結論は「来期に検討」だ。'),
              )
            : ng(hakase('まだどこかがつながっていないようだ。`describe-target-health` で `web-tg` のターゲットが両方 healthy になっているか確かめてから、`curl` で ALB を開き、`Database: connected` が出るか見るのだ。')),
      },
    },
  },
};

export default patches;
