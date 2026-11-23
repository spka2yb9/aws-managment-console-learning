import type { CommandRecord } from '../../console/store';
import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { AMIS } from '../../sim/ec2';
import { nameOf } from '../../sim/env';
import { isPublicSubnet } from '../../sim/vpc';
import { allTargetsHealthy, dbNamed, instanceNamed, lastAlbRequest, lbNamed, sgNamed, subnetNamed, tgNamed, vpcNamed } from '../helpers';
import { param, ranAws } from './helpers';
import type { CliPatches } from './types';

const AL2023 = AMIS[0].imageId;

/* Lesson 10: 終了したインスタンスも Name タグを持ったまましばらく残るので、生きている新しいほうを見る */
const myEc2 = (c: TaskContext) => [...c.env.instances].reverse().find((i) => nameOf(i) === 'my-first-ec2' && i.state !== 'terminated' && i.state !== 'shutting-down');
const ec2Id = (c: TaskContext) => myEc2(c)?.instanceId ?? 'i-xxxxxxxx';
const sgId = (c: TaskContext, name: string) => sgNamed(c.env, name)?.groupId ?? 'sg-xxxxxxxx';
const subnetId = (c: TaskContext, name: string) => subnetNamed(c.env, name)?.subnetId ?? 'subnet-xxxxxxxx';
const tgArn = (c: TaskContext) => tgNamed(c.env, 'web-tg')?.targetGroupArn ?? '<web-tg の ARN>';
const dnsName = (c: TaskContext) => lbNamed(c.env, 'web-alb')?.dnsName ?? '<web-alb の DNS 名>';
const webId = (c: TaskContext, name: string) => instanceNamed(c.env, name)?.instanceId ?? 'i-xxxxxxxx';

/** a describe-security-groups call that asked for this group (by name or ID) */
const askedSg = (c: TaskContext, name: string) => (x: CommandRecord) => {
  const asked = [param(x, 'filters'), param(x, 'group-names'), param(x, 'group-ids')].join(' ');
  return asked.includes(sgId(c, name)) || new RegExp(`(^|[^\\w-])${name}([^\\w-]|$)`).test(asked);
};
/** web-1 / web-2: which instance answered the last request to the ALB */
const answeredBy = (c: TaskContext) => /\((web-\d)\)/.exec(lastAlbRequest(c)?.body ?? '')?.[1] ?? 'web-1';
/** the newest describe-instances typed after `t` */
const describedSince = (c: TaskContext, t: number | undefined) => t !== undefined && !!ranAws(c, 'ec2 describe-instances', (x) => x.at >= t);
/** describe-target-health saying every target is healthy */
const sawAllHealthy = (c: TaskContext) => !!ranAws(c, 'elbv2 describe-target-health', (x) => /healthy/.test(x.output) && !/unhealthy|initial/.test(x.output));

const TG_ARN_CMD = "TG_ARN=$(aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text)";
const DNS_CMD = "aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text";

const patches: CliPatches = {
  ec2: {
    steps: {
      0: {
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
          hakase('見積もりを取り、稟議を回し、3 週間待って、深夜のデータセンターでケーブルを挿した。今はコマンド 1 行で数十秒だ。……ワシの青春の 3 週間を返してほしいものだ。'),
        ],
      },
      1: {
        type: 'dialogue',
        lines: [
          hakase('インスタンスを起動する操作は `aws ec2 run-instances` だ。決めることは多いが、1 つずつ片付ければ怖くない。まず **AMI** だ。'),
          node('えーえむあい？ 相性占いか何かですか？'),
          hakase('占いではない。Amazon Machine Image、つまり OS やソフトがインストール済みのディスクの「型」だ。`--image-id` に、`ami-` で始まる AMI ID で指定する。'),
          hakase('たい焼きの型を思い浮かべよ。同じ型なら、何匹焼いても同じ中身のたい焼きができる。今回は AWS 製の Linux、**Amazon Linux 2023** の型を使う。ID は `aws ec2 describe-images` で調べられる。'),
          node('じゃあ次は、たい焼きの大きさですね。'),
          hakase('うむ。それが **インスタンスタイプ**、CPU とメモリの大きさだ。`--instance-type t3.micro` と書く。仮想 CPU (vCPU) が 2 つ、メモリ 1 GiB の小さなやつだ。`t3` は種類と世代、`micro` はサイズを表す。'),
          node('一番大きいのにしておけば安心ですね！'),
          hakase('月末に請求書を見て、安心とは何かを考え直すことになるがな。大きいほど速いが、時間あたりの料金も上がるのだ。'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          hakase('次は **キーペア**。SSH でログインするための鍵の組だ。'),
          node('SSH って、Lesson 01 のクイズで「全世界から SSH できる状態にしてしまった」ってやつですよね。'),
          hakase('よく覚えておったな。SSH は、離れた場所からサーバーにログインして操作する仕組みで、TCP の 22 番を使う。'),
          node('キーペアの「ペア」って、何と何なんです？'),
          hakase('公開鍵と秘密鍵だ。公開鍵はインスタンスに置かれ、秘密鍵は君の手元の PC に置く。錠前と、それに合う唯一の鍵だな。`aws ec2 create-key-pair` で作ると、応答の `KeyMaterial` に秘密鍵が 1 度だけ出てくる。'),
          node('秘密鍵をなくしたら？'),
          hakase('そのキーペアでは二度と入れん。AWS も再発行してくれん。秘密鍵をデスクトップに置いたまま PC を初期化した新人を、ワシは 3 人知っておる。'),
          node('3 人も…。今回は用意済みの `webapp-key` を使えばいいんですね。'),
          hakase('うむ。`--key-name webapp-key` だ。そしてファイアウォールは **セキュリティグループ**。Lesson 09 でやった門番だ。`--security-group-ids` に ID で渡す。'),
          node('許可リスト型のファイアウォールでしたよね。`web-server-sg` は、HTTP を `0.0.0.0/0` から許可したやつです。'),
        ],
      },
      3: [
        {
          type: 'dialogue',
          lines: [
            hakase('最後は **ネットワーク**。家を建てる土地を選ぶところだ。`--subnet-id` でサブネットを選ぶと、そのサブネットの VPC に建つ。それと **パブリック IP の自動割り当て** も決める。'),
            node('サブネットは `public-subnet-1a` ですね。Lesson 06 で `0.0.0.0/0 → IGW` のルートを足して、Public subnet にした部屋です。'),
            hakase('うむ。ただし罠がある。`--subnet-id` を省くと、AWS は **デフォルト VPC** のサブネットに建てようとするのだ。'),
            node('デフォルト VPC って、Lesson 03 の `describe-vpcs` に出てきた `172.31.0.0/16` のやつですよね。'),
            hakase('うむ。AWS がリージョンごとに最初から用意しておく VPC で、すぐ使えるようにサブネットがインターネットにつながっておる。'),
            node('親切じゃないですか。'),
            hakase('親切すぎて、気づかずにそこへ建てる者が後を絶たん。他人の土地に家を建てたようなものだ。そして「DB につながりません」と夜中に電話してくる。'),
            node('パブリック IP は、Lesson 08 の「インターネットにつながる条件」の 1 つでしたよね。「リソースが Public IP を持っている」。'),
            hakase('うむ。だから `--associate-public-ip-address` を付ける。値の要らない、付けるだけで有効になるオプションだ。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            node('サブネットとセキュリティグループの ID は、どうやって調べるんですか？'),
            hakase('Lesson 03 の `--filters` と `--query` だ。`describe-subnets` は `--filters Name=tag:Name,Values=public-subnet-1a`、`describe-security-groups` は `--filters Name=group-name,Values=web-server-sg` で絞り、`--query` で ID だけを取り出す。'),
            node('`SUBNET_ID=$(...)` みたいに変数に入れておけば、`run-instances` で `$SUBNET_ID` と書くだけですね。'),
            hakase('分かってきたな。名前は Lesson 03 と同じくタグで付ける。`--tag-specifications` の `ResourceType` を `instance` にして、`my-first-ec2` だ。'),
            node('起動したら、すぐ使えるんですか？'),
            hakase('状態 (`State.Name`) はまず `pending` (保留中) になり、準備ができると `running` (実行中) になる。数秒の辛抱だ。'),
            node('`describe-instances` を何度も打って、`running` になるまで見張るんですか？'),
            hakase('それなら **ウェイター** (waiter) を使え。`aws ec2 wait instance-running --instance-ids <ID>` と打てば、`running` になるまで待ち、なったら何も表示せずにプロンプトへ戻る。'),
            node('ウェイター。料理を運んでくれるんですか？'),
            hakase('運ぶのは「できました」の知らせだけだ。チップも要らん。さあ、建ててみよ。'),
          ],
        },
      ],
      4: {
        type: 'table',
        title: '`aws ec2 run-instances` で決めること',
        columns: ['オプション', '意味', '今回の値'],
        rows: [
          ['`--image-id`', 'AMI (Amazon マシンイメージ)。OS やソフトが入ったディスクの「型」', `Amazon Linux 2023 (\`${AL2023}\`)`],
          ['`--instance-type`', 'CPU とメモリの大きさ', '`t3.micro`'],
          ['`--key-name`', 'SSH ログイン用の鍵 (公開鍵と秘密鍵)', '`webapp-key`'],
          ['`--subnet-id`', 'どのサブネット (と、その VPC) に置くか。省くとデフォルト VPC', '`public-subnet-1a` の ID'],
          ['`--associate-public-ip-address`', 'パブリック IP を付ける', '(付ける)'],
          ['`--security-group-ids`', 'インスタンスの門番 (セキュリティグループ)', '`web-server-sg` の ID'],
          ['`--tag-specifications`', '名前 (Name タグ)', '`my-first-ec2`'],
        ],
      },
      5: {
        type: 'exercise',
        title: 'EC2 インスタンスを起動する',
        objective: '名前 `my-first-ec2` を `webapp-vpc` の `public-subnet-1a` に、セキュリティグループ `web-server-sg`、パブリック IP ありで `aws ec2 run-instances` で起動し、`running` にする',
        tasks: [
          { id: 'ami', title: '`aws ec2 describe-images` で Amazon Linux 2023 の AMI ID を調べる', hint: "`Name` が `Amazon Linux 2023 AMI` のものの `ImageId` です。`--query 'Images[].[ImageId,Name]' --output text` を付けると 1 行ずつ並びます。", command: "aws ec2 describe-images --query 'Images[].[ImageId,Name]' --output text", done: (c) => !!ranAws(c, 'ec2 describe-images') },
          {
            id: 'ids',
            title: '`public-subnet-1a` と `web-server-sg` の ID を調べる',
            hint: "`aws ec2 describe-subnets --filters Name=tag:Name,Values=public-subnet-1a --query 'Subnets[0].SubnetId' --output text` と、`aws ec2 describe-security-groups --filters Name=group-name,Values=web-server-sg --query 'SecurityGroups[0].GroupId' --output text`。`;` で区切ると 1 行に並べて打てます。",
            command: "SUBNET_ID=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=public-subnet-1a --query 'Subnets[0].SubnetId' --output text); SG_ID=$(aws ec2 describe-security-groups --filters Name=group-name,Values=web-server-sg --query 'SecurityGroups[0].GroupId' --output text); echo $SUBNET_ID $SG_ID",
            done: (c) => !!ranAws(c, 'ec2 describe-subnets', (x) => x.output.includes(subnetId(c, 'public-subnet-1a'))) && !!ranAws(c, 'ec2 describe-security-groups', (x) => x.output.includes(sgId(c, 'web-server-sg'))),
          },
          {
            id: 'net',
            title: '`my-first-ec2` を `public-subnet-1a`・`web-server-sg`・パブリック IP ありで起動する',
            hint: "`aws ec2 run-instances --image-id <AMI ID> --instance-type t3.micro --key-name webapp-key --subnet-id $SUBNET_ID --security-group-ids $SG_ID --associate-public-ip-address --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=my-first-ec2}]'`。`--subnet-id` を忘れるとデフォルト VPC に建ちます。",
            command: (c) => `aws ec2 run-instances --image-id ${AL2023} --instance-type t3.micro --key-name webapp-key --subnet-id ${subnetId(c, 'public-subnet-1a')} --security-group-ids ${sgId(c, 'web-server-sg')} --associate-public-ip-address --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=my-first-ec2}]' --query 'Instances[0].InstanceId' --output text`,
            done: (c) => !!myEc2(c),
          },
          { id: 'running', title: '`aws ec2 wait instance-running` で `running` になるのを待つ', hint: '`--instance-ids` には `run-instances` の応答の `InstanceId` (`i-` で始まる ID) を入れます。プロンプトが戻ってきたら `running` です。', command: (c) => `aws ec2 wait instance-running --instance-ids ${ec2Id(c)}`, done: (c) => myEc2(c)?.state === 'running' },
        ],
        validate: (c) => {
          const i = myEc2(c);
          if (!i) return ng(hakase('`my-first-ec2` という名前のインスタンスが見当たらん。Name タグを付け忘れたなら、`aws ec2 create-tags --resources <インスタンス ID> --tags Key=Name,Value=my-first-ec2` で後から貼れる。`aws ec2 describe-instances` の `Tags` で確かめるのだ。'));
          if (i.vpcId !== vpcNamed(c.env, 'webapp-vpc')?.vpcId) return ng(hakase('デフォルト VPC に建ててしまったな。さっき罠だと言ったばかりだろう。君の記憶は揮発性メモリか。'), hakase(`実務でもよくある間違いだ。\`aws ec2 terminate-instances --instance-ids ${i.instanceId}\` で片付けて、\`--subnet-id\` に \`public-subnet-1a\` の ID を入れて起動し直そう。`), node('`--subnet-id`、最初に確かめるようにします…'));
          if (i.subnetId !== subnetNamed(c.env, 'public-subnet-1a')?.subnetId) return ng(hakase(`サブネットが \`public-subnet-1a\` ではないようだ。サブネットは起動した後では変えられん。\`aws ec2 terminate-instances --instance-ids ${i.instanceId}\` で終了して、\`--subnet-id\` に \`public-subnet-1a\` の ID を入れて起動し直すのだ。`));
          if (!i.securityGroupIds.includes(sgNamed(c.env, 'web-server-sg')?.groupId ?? '')) return ng(hakase('セキュリティグループに `web-server-sg` が付いていない。よその門番を雇ってしまったな。'), hakase(`\`aws ec2 modify-instance-attribute --instance-id ${i.instanceId} --groups <web-server-sg の ID>\` で付け替えるのだ。`));
          if (!i.associatePublicIpAddress) return ng(hakase('パブリック IP が付いておらん。これでは地図に載っていない家だ。'), hakase('自動割り当ては起動のときにしか決められん。`aws ec2 terminate-instances` で終了して、`--associate-public-ip-address` を付けて起動し直すのだ。'));
          if (i.state !== 'running') return ng(hakase(`まだ \`running\` になっていないな。\`pending\` は準備中という意味だ。\`aws ec2 wait instance-running --instance-ids ${i.instanceId}\` で待つのだ。`));
          return ok(node('`running` になりました！ 僕の初めてのサーバーです！'), hakase('おめでとう。`aws ec2 describe-instances` で `PublicIpAddress` を見てみよ。インターネットから見た、この家の住所だ。'), node('Lesson 09 で `curl` に渡した、あの番号ですね。'), hakase('うむ。ちなみに、動いている間はずっと料金がかかっておる。感動は手短にな。'));
        },
      },
      6: {
        type: 'dialogue',
        lines: [
          hakase('さて、建てた家には住所が 2 つある。`describe-instances` の応答の `PrivateIpAddress` と `PublicIpAddress` だ。'),
          node('2 つも？ 郵便屋さんが迷いません？'),
          hakase('使う場所が違う。プライベートは Subnet の CIDR から割り当てられる、VPC の中だけで通じる内線番号。パブリックは、インターネットから見た外線番号だ。'),
          node('`public-subnet-1a` は `10.0.1.0/24` だから、プライベートは `10.0.1.x` になるんですね。Lesson 04 でやった CIDR の範囲です。'),
          hakase('うむ。それと `i-` で始まる `InstanceId`。こちらはインスタンスの社員番号だ。'),
          node('住所が 2 つに社員番号。人間より身分証が多いですね。'),
          hakase('では電源の話だ。`State.Name` は、止めると `stopping` (停止中) → `stopped` (停止済み)、削除すると `shutting-down` (シャットダウン中) → `terminated` (終了済み) と変わる。'),
          node('停止と終了って、何が違うんです？ どっちも止まってますよね。'),
          hakase('大違いだ。`aws ec2 stop-instances` は電源を切るだけ。ディスクの **EBS** (Elastic Block Store) は残るから、また `aws ec2 start-instances` で開始できる。'),
          node('いーびーえす？'),
          hakase('インスタンスにつないで使う、ネットワーク越しのディスクだ。OS もデータもここに入っておる。停止中はインスタンスの料金は止まるが、EBS の保管料はかかり続ける。'),
          node('寝てても家賃は取られるんですね。'),
          hakase('請求書は眠らんのだ。一方 `aws ec2 terminate-instances` は、その名のとおり削除だ。元には戻せん。'),
          node('「今日の作業は終了 (terminate)」のつもりで打ったら…'),
          hakase('家ごと更地だ。本番サーバーでそれをやった新人の席も、翌月には更地になっておった。では停止してみよう。パブリック IP がどうなるか、よく見ておれ。'),
        ],
      },
      7: {
        type: 'exercise',
        title: 'インスタンスを Stop する',
        objective: '`my-first-ec2` を `aws ec2 stop-instances` で停止し、`stopped` になったらパブリック IP がどうなるか見る',
        tasks: [
          { id: 'stop', title: '`aws ec2 stop-instances` で `my-first-ec2` を停止する', hint: '`--instance-ids` に `my-first-ec2` のインスタンス ID を入れます。応答の `CurrentState` が `stopping` になります。', command: (c) => `aws ec2 stop-instances --instance-ids ${ec2Id(c)}`, done: (c) => ['stopping', 'stopped'].includes(myEc2(c)?.state ?? '') },
          { id: 'stopped', title: '`aws ec2 wait instance-stopped` で `stopped` になるのを待つ', hint: '`running` を待ったときと同じ形で、ウェイターの名前が `instance-stopped` になります。', command: (c) => `aws ec2 wait instance-stopped --instance-ids ${ec2Id(c)}`, done: (c) => myEc2(c)?.state === 'stopped' },
          {
            id: 'ip',
            title: '`describe-instances` でパブリック IP を確かめる',
            hint: "`aws ec2 describe-instances --instance-ids <ID> --query 'Reservations[0].Instances[0].PublicIpAddress' --output text`",
            command: (c) => `aws ec2 describe-instances --instance-ids ${ec2Id(c)} --query 'Reservations[0].Instances[0].PublicIpAddress' --output text`,
            done: (c) => myEc2(c)?.state === 'stopped' && describedSince(c, myEc2(c)?.stateChangedAt),
          },
        ],
        validate: (c) => {
          const i = myEc2(c);
          if (i?.state !== 'stopped') return ng(hakase('まだ `stopped` になっていないようだ。`aws ec2 stop-instances --instance-ids <ID>` を打ったかな？ `stopping` を経て `stopped` になるまで、`aws ec2 wait instance-stopped` で待つのだ。'));
          if (!describedSince(c, i.stateChangedAt)) return ng(hakase('止まったな。では `stopped` になった今の姿を、`aws ec2 describe-instances` で見るのだ。`PublicIpAddress` がどうなっておるかな？'));
          return ok(
            node('`PublicIpAddress` が `None` になりました！ 住所が消えちゃいました。'),
            hakase('`--output text` では、値の無いところが `None` と出る。自動で割り当てたパブリック IP は、停止すると AWS に**返却**されるのだ。次に開始すると、別の番号が割り当てられる。'),
            node('引っ越してもいないのに、住所が変わるんですか！？'),
            hakase('そういうことだ。住所を固定したければ **Elastic IP** を使う。アカウント専用に確保しておける、固定のパブリック IP だ。確保しておくだけでも料金はかかるがな。'),
          );
        },
      },
      8: {
        type: 'exercise',
        title: 'インスタンスを Start する',
        objective: '`my-first-ec2` を `aws ec2 start-instances` で開始して `running` に戻し、パブリック IP を確かめる',
        tasks: [
          { id: 'start', title: '`aws ec2 start-instances` で開始する', hint: '`stopped` のときだけ開始できます。応答の `CurrentState` が `pending` になります。', command: (c) => `aws ec2 start-instances --instance-ids ${ec2Id(c)}`, done: (c) => ['pending', 'running'].includes(myEc2(c)?.state ?? '') },
          { id: 'running', title: '`aws ec2 wait instance-running` で `running` になるのを待つ', hint: '起動したときと同じウェイターです。↑ キーで前のコマンドを呼び出すと楽です。', command: (c) => `aws ec2 wait instance-running --instance-ids ${ec2Id(c)}`, done: (c) => myEc2(c)?.state === 'running' },
          {
            id: 'ip',
            title: '`describe-instances` でパブリック IP を確かめる',
            hint: '停止したときと同じ `describe-instances` を打ち直します。',
            command: (c) => `aws ec2 describe-instances --instance-ids ${ec2Id(c)} --query 'Reservations[0].Instances[0].PublicIpAddress' --output text`,
            done: (c) => myEc2(c)?.state === 'running' && describedSince(c, myEc2(c)?.stateChangedAt),
          },
        ],
        validate: (c) => {
          const i = myEc2(c);
          if (i?.state !== 'running' || !i.publicIpAddress) return ng(hakase('まだ `running` に戻っていない。`aws ec2 start-instances` は `stopped` のときだけ打てる。打ったら、`pending` を経て `running` になるまで `aws ec2 wait instance-running` で待つのだ。'));
          if (!describedSince(c, i.stateChangedAt)) return ng(hakase('動き出したな。では `aws ec2 describe-instances` で、今の `PublicIpAddress` を見るのだ。'));
          return ok(
            node('`running` に戻りました！ `PublicIpAddress` も付いてます。'),
            hakase('だが、停止する前とは別の番号のはずだ。同じ家に、新しい住所が付いたのだ。'),
            node('前の番号をブックマークしてたお客さんは、迷子ですね。'),
            hakase('うむ。だから本番では、IP アドレスが変わる前提で設計する。これは試験に出るぞ。すぐ次にな。'),
          );
        },
      },
      10: {
        type: 'exercise',
        title: 'VPC → Subnet → EC2 → Security Group を辿る',
        objective: '`my-first-ec2` の `SubnetId`・`VpcId`・`SecurityGroups` を手がかりに、所属する Subnet・VPC・Security group を `describe-*` で順に引く',
        tasks: [
          { id: 'instance', title: '`describe-instances` で `my-first-ec2` の `SubnetId` と `SecurityGroups` を見る', hint: '`aws ec2 describe-instances --instance-ids <ID>` の応答を見ます。', command: (c) => `aws ec2 describe-instances --instance-ids ${ec2Id(c)}`, done: (c) => !!ranAws(c, 'ec2 describe-instances', (x) => x.output.includes(subnetId(c, 'public-subnet-1a'))) },
          { id: 'subnet', title: '`SubnetId` で `aws ec2 describe-subnets --subnet-ids` を引く', hint: 'インスタンスの `SubnetId` をそのまま `--subnet-ids` に渡します。応答の `VpcId` が次の手がかりです。', command: (c) => `aws ec2 describe-subnets --subnet-ids ${subnetId(c, 'public-subnet-1a')}`, done: (c) => !!ranAws(c, 'ec2 describe-subnets', (x) => param(x, 'subnet-ids').includes(subnetId(c, 'public-subnet-1a'))) },
          { id: 'vpc', title: 'サブネットの `VpcId` で `aws ec2 describe-vpcs --vpc-ids` を引く', hint: '`Tags` の `Name` が `webapp-vpc` なら正解です。', command: (c) => `aws ec2 describe-vpcs --vpc-ids ${vpcNamed(c.env, 'webapp-vpc')?.vpcId ?? 'vpc-xxxxxxxx'}`, done: (c) => !!ranAws(c, 'ec2 describe-vpcs', (x) => param(x, 'vpc-ids').includes(vpcNamed(c.env, 'webapp-vpc')?.vpcId ?? '-')) },
          { id: 'sg', title: 'インスタンスの `SecurityGroups` の `GroupId` で `aws ec2 describe-security-groups --group-ids` を引く', hint: 'インスタンスの応答に戻り、`SecurityGroups` の `GroupId` を `--group-ids` に渡します。', command: (c) => `aws ec2 describe-security-groups --group-ids ${sgId(c, 'web-server-sg')}`, done: (c) => !!ranAws(c, 'ec2 describe-security-groups', (x) => param(x, 'group-ids').includes(sgId(c, 'web-server-sg'))) },
        ],
        validate: (c) =>
          ranAws(c, 'ec2 describe-vpcs', (x) => param(x, 'vpc-ids').includes(vpcNamed(c.env, 'webapp-vpc')?.vpcId ?? '-')) && ranAws(c, 'ec2 describe-security-groups', (x) => param(x, 'group-ids').includes(sgId(c, 'web-server-sg')))
            ? ok(
                hakase('辿れたな。この EC2 が「どの VPC の」「どの Subnet に建ち」「どの Security Group を門番にしているか」を、ID を手がかりに行き来できた。'),
                node('Lesson 03 から作ってきたものが、全部つながってるんですね。'),
                hakase('うむ。障害調査では、この関係を素早く辿れるかどうかで、帰宅時間が数時間変わる。'),
                node('数時間…！'),
                hakase('ワシは辿れなかった夜、始発で帰ったことがある。'),
              )
            : ng(hakase('まだ引いていないリソースがあるようだ。インスタンスの `SubnetId` → `describe-subnets --subnet-ids` の `VpcId` → `describe-vpcs --vpc-ids`、それからインスタンスに戻って `SecurityGroups` の `GroupId` → `describe-security-groups --group-ids` の順に辿るのだ。')),
      },
    },
  },

  alb: {
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          hakase('ALB を作る操作は `aws elbv2 create-load-balancer` だ。`elbv2` は Elastic Load Balancing の第 2 版で、ALB の仲間を扱うサービスの名前だな。'),
          hakase('決めることは主に 4 つ。まず **スキーム** (`--scheme`)。インターネット向け (`internet-facing`) か内部 (`internal`) かだ。'),
          node('すきーむ？ 悪だくみですか？'),
          hakase('それは scheme の別の意味だな。ここでは「方式」だ。インターネット向けはパブリック IP を持ち、インターネットから受け付ける。内部は VPC の中だけの受付だ。しかも、作った後では変えられん。'),
          node('後から変えられないもの、多いですね…'),
          hakase('次に **サブネット** (`--subnets`)。ALB を置く Subnet を ID で並べる。条件は **2 つ以上の AZ** で、AZ ごとに Subnet を 1 つずつだ。'),
          node('AZ は Lesson 02 でやった、同じリージョンの中の別々のデータセンター群ですね。'),
          hakase('うむ。ALB は選んだ AZ ごとに受付の分身を置く。片方の AZ が停電しても、もう片方で受付を続けられるのだ。'),
          node('表玄関だから、選ぶのは Public subnet ですね。`public-subnet-1a` と `public-subnet-1c`。'),
          hakase('その通り。3 つ目は **セキュリティグループ** (`--security-groups`)、ALB の門番だ。`alb-sg` に、HTTP 80 を `0.0.0.0/0` から許可するルールが入っておる。省くと VPC に最初からある `default` のセキュリティグループが付くから、必ず指定しておけ。'),
          node('最後は？'),
          hakase('**リスナー**。英語の listen、「耳を傾ける」係だ。どのプロトコルとポートで受け付けて、どこへ送るかを決める。今回は `HTTP:80` で受けて、`web-tg` へ転送だ。'),
        ],
      },
      3: {
        type: 'table',
        title: 'ALB を作るときの設定',
        columns: ['設定 (オプション)', '意味', '今回の値'],
        rows: [
          ['スキーム (`--scheme`)', '**インターネット向け** (`internet-facing`、パブリック IP を持つ) か **内部** (`internal`) か。作成後は変更できない', '`internet-facing`'],
          ['サブネット (`--subnets`)', '2 つ以上の AZ と、各 AZ の Subnet', '`public-subnet-1a`, `public-subnet-1c` の ID'],
          ['セキュリティグループ (`--security-groups`)', 'ALB のファイアウォール', '`alb-sg` の ID (HTTP 80 を 0.0.0.0/0 から許可)'],
          ['リスナー (`aws elbv2 create-listener`)', 'どのプロトコル・ポートで受けて、どこへ送るか', '`HTTP:80` → 転送先 `web-tg`'],
        ],
      },
      4: [
        {
          type: 'dialogue',
          lines: [
            node('よし、作ります！ VPC はどのオプションで選ぶんですか？'),
            hakase('選ばん。`--subnets` に並べたサブネットの VPC に作られる。前回の EC2 の `--subnet-id` と同じだ。'),
            node('じゃあ、デフォルト VPC のサブネットを並べたら、デフォルト VPC に作られちゃうんですね。前回と同じ罠だ。'),
            hakase('うむ。それと、Private subnet を並べても、CLI は警告ひとつ出さずに作ってしまう。誰も来ない受付の完成だ。'),
            node('サブネットの ID は 2 つ要りますね。'),
            hakase('`--filters Name=tag:Name,Values=public-subnet-1a,public-subnet-1c` と `Values` にカンマで並べれば、どちらかに当てはまるものに絞れる。`--query \'Subnets[].SubnetId\'` と `[]` で書けば、全部の要素から ID を取り出せる。'),
            node('作ったら、`State` が `provisioning` から `active` になるのを待つんですよね。ぷろびじょにんぐ…？'),
            hakase('「準備・手配」という意味だ。AWS が裏で受付係を手配しておる。`aws elbv2 wait load-balancer-available --names web-alb` で、`active` になるまで待てる。`active` になれば開店だ。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            node('リスナーは、別のコマンドで足すんですね。'),
            hakase('うむ。`aws elbv2 create-listener` だ。どの ALB に足すか、どのターゲットグループへ送るかは **ARN** で指定する。'),
            node('えーあーるえぬ？'),
            hakase('Amazon Resource Name、AWS のリソースの正式な住所だ。`arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/web-alb/...` のように、サービス・リージョン・アカウント ID・リソースの順に並ぶ。`elbv2` の操作では、ID ではなくこの ARN でリソースを指すのだ。'),
            node('長っ…。手で打ったら絶対間違えます。'),
            hakase('だから手では打たん。ALB の ARN は `describe-load-balancers --names web-alb` の `LoadBalancerArn`、ターゲットグループの ARN は `describe-target-groups --names web-tg` の `TargetGroupArn` だ。`LB_ARN=$(...)` と変数に入れておけ。'),
            node('転送先はどう書くんですか？'),
            hakase('`--default-actions Type=forward,TargetGroupArn=$TG_ARN` だ。「`TG_ARN` のターゲットグループへ転送 (forward) せよ」という shorthand だな。'),
            node('変数がないと、1 行が新聞の社説くらいの長さになりそうです。'),
            hakase('ARN を手でコピーして 1 文字落とした夜を、ワシは何度も過ごした。変数は文明だ。'),
          ],
        },
      ],
      5: {
        type: 'exercise',
        title: 'Application Load Balancer を作成する',
        objective: '`web-alb` をインターネット向け・public-subnet-1a/1c・`alb-sg` で作成し、リスナー HTTP:80 → `web-tg` を足して `active` にする',
        tasks: [
          {
            id: 'ids',
            title: '2 つの **パブリック**サブネットと `alb-sg` の ID を調べる',
            hint: "`aws ec2 describe-subnets --filters Name=tag:Name,Values=public-subnet-1a,public-subnet-1c --query 'Subnets[].SubnetId' --output text` と、`aws ec2 describe-security-groups --filters Name=group-name,Values=alb-sg --query 'SecurityGroups[0].GroupId' --output text`。",
            command: "SUBNETS=$(aws ec2 describe-subnets --filters Name=tag:Name,Values=public-subnet-1a,public-subnet-1c --query 'Subnets[].SubnetId' --output text); ALB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=alb-sg --query 'SecurityGroups[0].GroupId' --output text); echo $SUBNETS $ALB_SG",
            done: (c) => !!ranAws(c, 'ec2 describe-subnets', (x) => ['public-subnet-1a', 'public-subnet-1c'].every((n) => x.output.includes(subnetId(c, n)))) && !!ranAws(c, 'ec2 describe-security-groups', (x) => x.output.includes(sgId(c, 'alb-sg'))),
          },
          {
            id: 'create',
            title: '`aws elbv2 create-load-balancer` で `web-alb` を作成する',
            hint: '`aws elbv2 create-load-balancer --name web-alb --scheme internet-facing --subnets <1a の ID> <1c の ID> --security-groups <alb-sg の ID>`。サブネットは空白で区切って並べます。',
            command: (c) => `aws elbv2 create-load-balancer --name web-alb --scheme internet-facing --subnets ${subnetId(c, 'public-subnet-1a')} ${subnetId(c, 'public-subnet-1c')} --security-groups ${sgId(c, 'alb-sg')}`,
            done: (c) => !!lbNamed(c.env, 'web-alb'),
          },
          {
            id: 'listener',
            title: '`aws elbv2 create-listener` で HTTP:80 → `web-tg` のリスナーを足す',
            hint: '`LB_ARN` と `TG_ARN` を変数に入れてから、`aws elbv2 create-listener --load-balancer-arn $LB_ARN --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG_ARN`。',
            command: `LB_ARN=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text); ${TG_ARN_CMD}; aws elbv2 create-listener --load-balancer-arn $LB_ARN --protocol HTTP --port 80 --default-actions Type=forward,TargetGroupArn=$TG_ARN`,
            done: (c) => !!lbNamed(c.env, 'web-alb')?.listeners.some((l) => l.port === 80 && l.targetGroupArn === tgNamed(c.env, 'web-tg')?.targetGroupArn),
          },
          { id: 'active', title: '`State` が `active` になるのを待つ', hint: '`aws elbv2 wait load-balancer-available --names web-alb`。プロンプトが戻ってきたら `active` です。', command: 'aws elbv2 wait load-balancer-available --names web-alb', done: (c) => lbNamed(c.env, 'web-alb')?.state === 'active' },
        ],
        validate: (c) => {
          const lb = lbNamed(c.env, 'web-alb');
          if (!lb) return ng(hakase('`web-alb` が見つからん。`--name web-alb` で作成したか、`aws elbv2 describe-load-balancers` の `LoadBalancerName` で確かめるのだ。'));
          if (lb.scheme !== 'internet-facing') return ng(hakase('スキームが `internal` (内部) になっておる。それでは VPC の中からしか来られない受付だ。'), hakase('インターネットから使う ALB は `internet-facing` にする。スキームは後から変えられないから、`aws elbv2 delete-load-balancer --load-balancer-arn <ARN>` で消して作り直しだ。'));
          const privateOnes = lb.subnetIds.filter((s) => !isPublicSubnet(c.env, s));
          if (privateOnes.length) return ng(hakase('ALB のサブネットに Private subnet が混じっておる。インターネット向けの ALB は、`0.0.0.0/0 → IGW` のある Public subnet に置かないと、インターネットから届かんのだ。'), node('CLI は何も言ってくれませんでした…'), hakase('警告は出んと言ったろう。`aws elbv2 delete-load-balancer` で消して、`--subnets` に `public-subnet-` のほうの ID を 2 つ並べて作り直すのだ。'));
          if (!lb.securityGroupIds.includes(sgNamed(c.env, 'alb-sg')?.groupId ?? '')) return ng(hakase('セキュリティグループに `alb-sg` が付いていない。門番を間違えた受付には、お客さんが入れんぞ。`aws elbv2 set-security-groups --load-balancer-arn <ARN> --security-groups <alb-sg の ID>` で付け替えるのだ。'));
          if (!lb.listeners.some((l) => l.port === 80 && l.targetGroupArn === tgNamed(c.env, 'web-tg')?.targetGroupArn)) return ng(hakase('リスナーが `HTTP:80` → `web-tg` になっていないようだ。`aws elbv2 describe-listeners --load-balancer-arn <ARN>` で確かめて、無ければ `aws elbv2 create-listener` で足すのだ。転送先は `--default-actions Type=forward,TargetGroupArn=<web-tg の ARN>` だ。'));
          if (lb.state !== 'active') return ng(hakase('まだ `provisioning` だ。AWS が受付係を手配しておる。`aws elbv2 wait load-balancer-available --names web-alb` で `active` になるまで待つのだ。'));
          return ok(
            hakase('ALB ができた。`create-load-balancer` の応答の `DNSName` を見てみよ。`web-alb-` で始まる長い名前、それがこの ALB の住所だ。'),
            node('でぃーえぬえす？'),
            hakase('コンピュータは IP アドレスでしか相手を探せん。そこで、名前から IP アドレスを引く電話帳のような仕組みがある。それが **DNS** (Domain Name System) だ。'),
            node('ALB の IP アドレスを直接使っちゃダメなんですか？'),
            hakase('ALB の IP アドレスは、AWS の都合で変わることがある。前回、停止するたびにパブリック IP が変わったのと同じ轍を踏むな。変わらない名前のほうを使うのだ。詳しくは Lesson 35 でやる。'),
          );
        },
      },
      6: [
        {
          type: 'dialogue',
          lines: [
            node('この住所、どうやって開くんですか？'),
            hakase('Lesson 09 で使った `curl` だ。URL を渡すと、HTTP でページを取ってきて中身を表示する。文字だけのブラウザだな。'),
            node('DNS 名は、また `--query` で取り出せばいいんですね。'),
            hakase('うむ。`--query \'LoadBalancers[0].DNSName\' --output text` だ。それと、`curl` に `-i` を付けると、本文の前に応答の頭、つまり **ヘッダー** も出る。1 行目の `HTTP/1.1` の後ろの数字が、サーバーの返事の結果だ。'),
            node('ヘッダー。手紙の封筒に書いてある宛名や消印みたいなものですか。'),
            hakase('そんなところだ。中身を読む前に、封筒で「どんな返事か」を確かめるのだ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'ALB の DNS 名に `curl` でアクセスする',
          objective: '`web-alb` の DNS 名を取り出し、`curl -i` でアクセスして HTTP 200 を確認する',
          tasks: [
            { id: 'copy', title: '`describe-load-balancers` で `web-alb` の `DNSName` を取り出す', hint: `\`${DNS_CMD}\``, command: DNS_CMD, done: (c) => !!ranAws(c, 'elbv2 describe-load-balancers', (x) => x.output.includes(dnsName(c))) },
            { id: 'browse', title: '`curl -i http://<DNS 名>` でアクセスする', hint: '1 行目が `HTTP/1.1 200 OK` なら成功です。', command: (c) => `curl -i http://${dnsName(c)}`, done: (c) => lastAlbRequest(c)?.status === 200 },
          ],
          validate: (c) => {
            const r = lastAlbRequest(c);
            if (!r) return ng(hakase('まだ ALB にアクセスしていないようだ。`aws elbv2 describe-load-balancers --names web-alb` で `DNSName` を取り出して、`curl -i http://<DNS 名>` と打つのだ。'));
            if (r.status !== 200) return ng(hakase(`結果は ${r.error ?? r.status} だ。\`curl -v\` を付けて打ち直すと、\`*\` の行に、どの区間で止まったかが出る。このシミュレーターのおまけの機能だ。✘ の行を探すのだ。`));
            const who = answeredBy(c);
            const other = who === 'web-1' ? 'web-2' : 'web-1';
            return ok(
              node(`「Hello from ... (${who})」って出ました！ 1 行目は \`HTTP/1.1 200 OK\` です！`),
              hakase(`200 は「OK」、つまり成功の返事だ。お客さん → ALB → Private subnet の ${who} と、受付係がちゃんと奥へ取り次いだのだ。`),
              node(`何回か \`curl\` を打ったら、${other} が答えることもあるんですか？`),
              hakase(`うむ、少し間をあけて打ってみよ。ALB が 2 台に振り分けておるから、ときどき ${other} が答える。片方が倒れても、もう片方が働く。ワシの職場もそうであってほしかった。`),
            );
          },
        },
      ],
    },
  },

  'target-group': {
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、大変です！ ALB の DNS 名に `curl` したら、**503 Service Temporarily Unavailable** って出ました！'),
          hakase('朝から景気のいい数字だな。DNS 名は、前回やった ALB の住所だ。住所は合っておるから、ALB には届いた。届いた先で断られたのだ。'),
          node('断られた？ 503 ってどういう意味なんですか？'),
          hakase('サーバーが返してくる 3 桁の数字を **HTTP ステータスコード** という。`curl -i` の 1 行目に出る数字だ。200 が成功の「OK」だったな。先頭の桁で、大まかな意味が分かる。'),
          node('先頭の桁？'),
          hakase('4 で始まる **4xx** は「お客さん側の間違い」、5 で始まる **5xx** は「サーバー側の問題」だ。'),
          node('つまり 503 は、こっち側のせい…'),
          hakase('うむ。謝る側だ。503 は「今はサービスを提供できません」。ALB が「取り次ぐ相手がいない」と言っておる。'),
          node('取り次ぐ相手って `web-1` と `web-2` ですよね？ 2 台とも `running` なのに。'),
          hakase('動いておっても、ALB がその存在を知らなければ、いないのと同じだ。'),
        ],
      },
      1: {
        type: 'dialogue',
        lines: [
          hakase('前回、ALB の転送先の名簿を何と言ったか覚えておるか。'),
          node('**ターゲットグループ** ですよね。`web-tg`。'),
          hakase('うむ。ALB はリスナーで受けたリクエストを、ターゲットグループに登録された **ターゲット** に転送する。ターゲットとは転送先のことだ。'),
          node('リスナーは、`HTTP:80` で耳を傾けてる係でしたね。'),
          hakase('そうだ。前回は `web-tg` に 2 台をワシが登録しておいてやった。今日の環境は、その名簿が白紙だ。'),
          node('白紙の名簿で「3 番窓口へどうぞ」と言われても、窓口に誰もいないですね。'),
          hakase('だから ALB は 503 を返す。まずは自分の目で確かめよう。`curl` に `-v` を付けてみよ。'),
          node('`-v`？'),
          hakase('verbose、「詳しく」の v だ。このシミュレーターでは、リクエストがどの区間を通り、どこで止まったかを `*` の行に並べてくれる。本物の AWS には無い、おまけだ。本物では、この推理を自分の頭でやることになる。'),
          node('本物、厳しいですね…'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          node('直し方は、名簿に 2 台を書き込めばいいんですよね。'),
          hakase('うむ。`aws elbv2 register-targets` だ。`--target-group-arn` で `web-tg` を、`--targets` で登録するインスタンスとポートを指定する。'),
          node('ポートは 3000 ですよね。前回、アプリは 3000 番の窓口で待ってるって。'),
          hakase('よく覚えておったな。今日は傘を持って帰れ。'),
          node('雨の予報なんて出てませんよ？'),
          hakase('君が覚えておるのだ、何が降ってもおかしくない。……書き方は `--targets Id=i-xxxx,Port=3000 Id=i-yyyy,Port=3000`。1 台分を `Id=...,Port=...` の shorthand で書き、2 台目は**空白で区切って**並べる。'),
          node('カンマでつないじゃったら？'),
          hakase('1 台分の設定に `Id` が 2 つ書いてあることになって、2 台はうまく載らん。それと、このコマンドは成功しても**何も表示しない**。'),
          node('何も出ないと、ちゃんと登録できたか不安になりますね。'),
          hakase('不安になって確かめる者は伸びる。確かめずに「登録したのに 503 のまま」と騒ぐ者もおる。確かめるのは `aws elbv2 describe-target-health` だ。'),
        ],
      },
      3: {
        type: 'exercise',
        title: '503 を確認する',
        objective: '`web-alb` の DNS 名に `curl -v` でアクセスし、503 を確認する',
        tasks: [
          { id: 'copy', title: '`web-alb` の `DNSName` を取り出す', hint: `\`${DNS_CMD}\``, command: DNS_CMD, done: (c) => !!ranAws(c, 'elbv2 describe-load-balancers', (x) => x.output.includes(dnsName(c))) },
          { id: 'browse', title: '`curl -i -v` で開いて **503** を確認', hint: '`curl -i -v http://<DNS 名>`。`*` で始まる行が、シミュレーターの経路の確認結果です。', command: (c) => `curl -i -v http://${dnsName(c)}`, done: (c) => lastAlbRequest(c)?.status === 503 },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.status === 503
            ? ok(
                node('`*` の行に「ターゲットが登録されていません」って出てます！'),
                hakase('名簿が白紙、の動かぬ証拠だな。では名簿の中身を見ていこう。ターゲットには **ターゲットタイプ** という種類があり、インスタンスの他に、IP アドレスや Lambda 関数、ALB そのものを登録する種類もある。'),
                node('らむだ？'),
                hakase('サーバーを用意せずに、プログラムだけを動かせる AWS のサービスだ。後のレッスンで出てくるから、今は名前だけ覚えておけ。今回はインスタンスを登録する。'),
                hakase('もう 1 つ大事なのが **ヘルスチェック**。ALB が各ターゲットに「生きておるか？」と定期的に聞く健康診断だ。合格すると **正常 (healthy)** になり、初めてリクエストが届く。詳しくは次のレッスンでやる。'),
              )
            : ng(hakase('まだ 503 を確認していないようだ。`aws elbv2 describe-load-balancers --names web-alb` で `DNSName` を取り出し、`curl -i -v http://<DNS 名>` と打つのだ。')),
      },
      4: {
        type: 'table',
        title: 'Target group の主な設定',
        columns: ['設定', 'CLI で見るところ', '意味'],
        rows: [
          ['ターゲットタイプ', '`describe-target-groups` の `TargetType`', '転送先の種類: インスタンス / IP アドレス / Lambda 関数 / Application Load Balancer'],
          ['プロトコル : ポート', '`Protocol` と `Port`', 'ALB からターゲットへ送るときのプロトコルとポート (今回 `HTTP:3000`)'],
          ['登録済みターゲット', '`describe-target-health` の `Target`', '実際の転送先 (インスタンスとポート)'],
          ['ヘルスチェック', '`HealthCheckPath` など `HealthCheck` で始まるキー', 'ターゲットが正常かを確かめる健康診断の設定'],
        ],
      },
      5: {
        type: 'exercise',
        title: 'Target を登録する',
        objective: '`web-tg` に `web-1` と `web-2` を port `3000` で登録し、両方 healthy にする',
        tasks: [
          { id: 'open', title: '`web-tg` の ARN を調べる', hint: "`aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text`。`TG_ARN=$(...)` で変数に入れておくと、この後が楽です。", command: `${TG_ARN_CMD}; echo $TG_ARN`, done: (c) => !!ranAws(c, 'elbv2 describe-target-groups', (x) => x.output.includes(tgArn(c))) },
          {
            id: 'ids',
            title: '`web-1` と `web-2` のインスタンス ID を調べる',
            hint: "`aws ec2 describe-instances --filters Name=tag:Name,Values=web-1,web-2 --query 'Reservations[].Instances[].InstanceId' --output text`",
            command: "aws ec2 describe-instances --filters Name=tag:Name,Values=web-1,web-2 --query 'Reservations[].Instances[].InstanceId' --output text",
            done: (c) => !!ranAws(c, 'ec2 describe-instances', (x) => ['web-1', 'web-2'].every((n) => x.output.includes(webId(c, n)))),
          },
          {
            id: 'register',
            title: '`aws elbv2 register-targets` で 2 台を port `3000` で登録する',
            hint: '`aws elbv2 register-targets --target-group-arn <ARN> --targets Id=<web-1 の ID>,Port=3000 Id=<web-2 の ID>,Port=3000`。2 台目の前はカンマではなく空白です。成功しても何も表示されません。',
            command: (c) => `aws elbv2 register-targets --target-group-arn ${tgArn(c)} --targets Id=${webId(c, 'web-1')},Port=3000 Id=${webId(c, 'web-2')},Port=3000`,
            done: (c) => (tgNamed(c.env, 'web-tg')?.targets.length ?? 0) >= 2,
          },
          {
            id: 'healthy',
            title: '`describe-target-health` で 2 台とも **healthy** なのを確かめる',
            hint: "`aws elbv2 describe-target-health --target-group-arn <ARN> --query 'TargetHealthDescriptions[].TargetHealth.State' --output text`。まだ `initial` なら `aws elbv2 wait target-in-service --target-group-arn <ARN>` で待てます。",
            command: (c) => `aws elbv2 describe-target-health --target-group-arn ${tgArn(c)} --query 'TargetHealthDescriptions[].TargetHealth.State' --output text`,
            done: (c) => allTargetsHealthy(c.env, 'web-tg', 2) && sawAllHealthy(c),
          },
        ],
        validate: (c) => {
          const tg = tgNamed(c.env, 'web-tg')!;
          if (tg.targets.length < 2) return ng(hakase('ターゲットがまだ 2 台登録されていない。`--targets` の 2 台目を、カンマではなく空白で区切って並べたかな？ `aws elbv2 describe-target-health --target-group-arn <ARN>` で、`Target` の `Id` が 2 つあるか確かめるのだ。'));
          if (tg.targets.some((t) => t.port !== 3000)) return ng(hakase('ポートが 3000 ではないターゲットがあるぞ。アプリは 3000 番の窓口で待っておるのだ。'), hakase('間違えたターゲットは `aws elbv2 deregister-targets --target-group-arn <ARN> --targets Id=<ID>,Port=<間違えたポート>` で外して、`Port=3000` で登録し直すのだ。'));
          if (!allTargetsHealthy(c.env, 'web-tg', 2)) return ng(hakase('まだ `healthy` でないターゲットがある。登録直後は健康診断の最中だから、`aws elbv2 wait target-in-service --target-group-arn <ARN>` で少し待て。それでも変わらなければ、`describe-target-health` の `TargetHealth` の `Reason` と `Description` に理由が書いてある。'));
          return ok(
            hakase('2 台とも `healthy` だ。名簿に載って、健康診断にも合格した。'),
            node('これで ALB が 2 台に取り次げるんですね。'),
            hakase('うむ。だが `healthy` の文字を見ただけで安心するのは早い。お客さんの目で、もう一度 `curl` で確かめるのだ。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: '復旧を確認する',
        objective: '`curl` で `web-alb` にアクセスし、HTTP 200 を確認する',
        tasks: [{ id: 'browse', title: '`curl -i` で ALB にアクセス → **200**', hint: 'さっき 503 だった `web-alb` の DNS 名のまま、`curl -i http://<DNS 名>` を打ち直します (↑ キーで呼び出せます)。', command: (c) => `curl -i http://${dnsName(c)}`, done: (c) => lastAlbRequest(c)?.status === 200 }],
        validate: (c) =>
          lastAlbRequest(c)?.status === 200
            ? ok(
                node(`503 から 200 になりました！ Hello from ${answeredBy(c)} です！`),
                hakase('受付係に名簿を渡しただけで、店が開いた。障害の半分は、こういう「書き忘れ」だ。'),
                node('残りの半分は？'),
                hakase('「消し忘れ」と「打ち間違い」だ。どちらも君の得意分野だな。'),
              )
            : ng(hakase('最新のアクセス結果がまだ 200 ではない。`describe-target-health` で 2 台とも `healthy` になったのを確かめてから、`curl` を打ち直すのだ。')),
      },
    },
  },

  'health-check': {
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          hakase('前回、ターゲットを登録したら、`healthy` (正常) になったのを確かめたな。'),
          node('はい。ALB の健康診断に合格すると、正常になるんでしたよね。'),
          hakase('うむ。今日はその健康診断、**ヘルスチェック** を詳しくやる。ALB は各ターゲットに定期的に HTTP リクエストを送り、決められた応答コードが返ってくれば正常と判断する。'),
          node('「生きてますか？」「はい、200 です」みたいな？'),
          hakase('そうだ。返事がない、または違うコードが返ると **異常 (unhealthy)** になる。`describe-target-health` の応答では `"State": "unhealthy"` と出る。'),
          node('異常なターゲットには、ALB はリクエストを送らないんですよね。倒れてる窓口にお客さんを案内しても仕方ないし。'),
          hakase('基本はそうだ。ただし例外がある。その例外が、今日の主役だ。'),
          node('例外が主役って、嫌な予感しかしないです。'),
          hakase('勘がよくなったな。障害の現場で長生きする素質だ。'),
        ],
      },
      1: {
        type: 'dialogue',
        lines: [
          hakase('まず健康診断の設定を見ておこう。`aws elbv2 describe-target-groups` の応答に並んでおる。**パス** (`HealthCheckPath`) は、ALB が「どのページに」聞きに行くかだ。'),
          node('ぱす？ 通行証ですか？'),
          hakase('道のほうだ。`http://example.com/health` なら、名前の後ろの `/health` の部分。建物の中の部屋番号のようなものだな。'),
          node('アプリのほうが「健康診断はこの部屋で受け付けます」って決めてるわけですね。'),
          hakase('うむ。**ポート** (`HealthCheckPort`) は普通 `traffic-port`、つまりターゲットを登録したポート (今回は 3000) をそのまま使う。**成功コード** (`Matcher` の `HttpCode`) は「この応答なら健康」とみなすステータスコードで、既定は `200` だ。'),
          node('`HealthyThresholdCount` と `UnhealthyThresholdCount` っていうのは？'),
          hakase('**しきい値** だ。敷居の「しきい」だな。何回連続で失敗したら異常にし、何回連続で成功したら正常に戻すか、という回数だ。1 回くしゃみをしただけで入院させていては、病院がパンクする。'),
          node('`HealthCheckIntervalSeconds` と `HealthCheckTimeoutSeconds` は、診断の **間隔** と、返事を待つ **タイムアウト** ですね。'),
          hakase('その通り。既定では 30 秒ごとに聞き、5 秒待って返事がなければ失敗とする。'),
        ],
      },
      2: {
        type: 'table',
        title: 'Health check の設定',
        columns: ['設定', 'CLI のキー (変えるときのオプション)', '意味'],
        rows: [
          ['ヘルスチェックパス', '`HealthCheckPath` (`--health-check-path`)', 'ALB がリクエストするパス (例 `/health`)'],
          ['ポート', '`HealthCheckPort` (`--health-check-port`)', '通常は `traffic-port` (= ターゲットを登録したポート)'],
          ['成功コード', '`Matcher` の `HttpCode` (`--matcher HttpCode=200`)', 'healthy とみなす HTTP ステータスコード (既定 `200`)'],
          ['正常のしきい値 / 非正常のしきい値', '`HealthyThresholdCount` / `UnhealthyThresholdCount`', '何回連続で成功 / 失敗したら状態を変えるか (既定 5 回 / 2 回)'],
          ['間隔 / タイムアウト', '`HealthCheckIntervalSeconds` / `HealthCheckTimeoutSeconds`', 'チェックの間隔と、返事を待つ時間 (既定 30 秒 / 5 秒)'],
        ],
      },
      3: {
        type: 'dialogue',
        lines: [
          node('博士、監視から「`web-tg` のターゲットが全部 Unhealthy」ってアラートが来ました！'),
          hakase('監視の仕組みが異常を知らせてきたわけだ。全部、とは穏やかではないな。'),
          node('でも…お客さんからの苦情はまだ来てないんです。サイトも見られるみたいで。'),
          hakase('ほう。全員が重病なのに、店は営業しておる、と。'),
          node('監視のほうが壊れてるんですかね？ アラートを止めちゃえば静かになりますよ。'),
          hakase('火災報知器がうるさいから電池を抜く、というやつだな。家が燃えてから後悔するタイプだ。'),
          node('うっ…'),
          hakase('まずは事実を集める。`aws elbv2 describe-target-health` でターゲットの状態と理由を読み、それから `curl` で ALB を開いて、本当に見られるかを確かめよう。'),
          node('理由って、どこに書いてあるんですか？'),
          hakase('`TargetHealth` の `Reason` と `Description` だ。英語で短く書いてある。医者のカルテのようなものだな。'),
        ],
      },
      4: {
        type: 'exercise',
        title: '状況を調べる',
        objective: '`aws elbv2 describe-target-health` で `web-tg` のターゲットの状態と理由を読み、`curl` で ALB にアクセスしてみる',
        tasks: [
          { id: 'tg', title: '`describe-target-health` で `web-tg` のターゲットを見る', hint: "`TG_ARN=$(aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text)` で ARN を変数に入れてから、`aws elbv2 describe-target-health --target-group-arn $TG_ARN`。`TargetHealth` の `Description` に、異常の理由が英語で書かれています。", command: `${TG_ARN_CMD}; aws elbv2 describe-target-health --target-group-arn $TG_ARN`, done: (c) => !!ranAws(c, 'elbv2 describe-target-health') },
          { id: 'browse', title: '`curl -i` で `web-alb` の DNS 名を開く', hint: `DNS 名は \`${DNS_CMD}\` で取り出せます。`, command: (c) => `curl -i http://${dnsName(c)}`, done: (c) => !!lastAlbRequest(c) },
        ],
        validate: (c) =>
          ranAws(c, 'elbv2 describe-target-health') && lastAlbRequest(c)
            ? ok(
                node('`Description` は `Health checks failed with these codes: [404]` です。でも `curl` では 200 が返ってきました！'),
                hakase('それが **fail open** (フェイルオープン) だ。正常なターゲットが 1 台もなくなると、ALB は「全部止めるよりはマシ」と判断して、異常なターゲットにもリクエストを送る。'),
                node('だから苦情が来てないんですね。よかった！'),
                hakase('よくはない。今は偶然動いておるだけだ。この状態で 1 台が本当に壊れても、ALB には見分けがつかん。壊れた窓口にも、お客さんを案内し続けてしまうのだ。'),
                node('健康診断が、まるで役に立ってないってことか…'),
              )
            : ng(hakase('ターゲットの状態と、お客さんから見た結果の両方を確認するのだ。`aws elbv2 describe-target-health` を打ってから、`curl` で `web-alb` の DNS 名を開くのだ。')),
      },
      5: {
        type: 'dialogue',
        lines: [
          hakase('では推理だ。404 というコード、どう読む？'),
          node('4 で始まるから「お客さん側の間違い」でしたよね。前回の 503 のときに教わりました。'),
          hakase('うむ。404 は **Not Found**、「そんなページは無い」だ。ここでのお客さんは、健康診断に来た ALB 自身だな。'),
          node('ALB が、存在しない部屋に健康診断に行ってる？'),
          hakase('そういうことだ。`aws elbv2 describe-target-groups --names web-tg` の `HealthCheckPath` を見てみよ。'),
          node('ええと…`"HealthCheckPath": "/healthz"` になってます。アプリの健康診断の部屋は `/health` のはず…'),
          hakase('最後の `z` 1 文字だ。誰かが「こっちのほうが格好いい」と書き換えたらしい。'),
          node('1 文字で全台異常…'),
          hakase('障害報告書で一番書きにくいのは、原因が 1 文字のときだ。ワシが言うのだから間違いない。では直そう。設定を変えるのは `aws elbv2 modify-target-group` で、パスは `--health-check-path` で渡す。'),
        ],
      },
      6: {
        type: 'exercise',
        title: 'ヘルスチェックパス を修正する',
        objective: '`aws elbv2 modify-target-group` で `web-tg` の ヘルスチェックパス を `/health` に直し、全 Target を healthy にする',
        tasks: [
          { id: 'edit', title: '`describe-target-groups` で今の `HealthCheckPath` と成功コードを見る', hint: "`aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].[HealthCheckPath,Matcher.HttpCode]' --output text`。`[ ]` に並べると、2 つの値を 1 行で出せます。", command: "aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].[HealthCheckPath,Matcher.HttpCode]' --output text", done: (c) => !!ranAws(c, 'elbv2 describe-target-groups', (x) => x.output.includes('/healthz')) },
          { id: 'path', title: '`aws elbv2 modify-target-group` で ヘルスチェックパス を `/health` にする', hint: '`aws elbv2 modify-target-group --target-group-arn <ARN> --health-check-path /health`。変えるのはパスだけで、成功コード (`--matcher`) はそのままにします。`$TG_ARN` が残っていれば使えます。', command: (c) => `aws elbv2 modify-target-group --target-group-arn ${tgArn(c)} --health-check-path /health`, done: (c) => tgNamed(c.env, 'web-tg')?.healthCheck.path === '/health' },
          { id: 'healthy', title: '`describe-target-health` で Targets がすべて **healthy** になったのを確かめる', hint: "`aws elbv2 describe-target-health --target-group-arn <ARN> --query 'TargetHealthDescriptions[].TargetHealth.State' --output text` で 2 台とも `healthy` か見ます。", command: (c) => `aws elbv2 describe-target-health --target-group-arn ${tgArn(c)} --query 'TargetHealthDescriptions[].TargetHealth.State' --output text`, done: (c) => allTargetsHealthy(c.env, 'web-tg', 2) && sawAllHealthy(c) },
        ],
        validate: (c) => {
          const hc = tgNamed(c.env, 'web-tg')!.healthCheck;
          if (hc.path !== '/health') return ng(hakase(`パスがまだ \`${hc.path}\` だ。\`aws elbv2 modify-target-group --target-group-arn <ARN> --health-check-path /health\` で直すのだ。`));
          if (hc.matcher !== '200') return ng(hakase('成功コードを変えてしまったな？ 404 を成功扱いにすると、「部屋が無い」も健康ということになる。本当の異常を見逃すぞ。'), hakase('`--matcher HttpCode=200` で成功コードを戻して、直すのはパスのほうだ。'));
          return allTargetsHealthy(c.env, 'web-tg', 2)
            ? ok(
                hakase('全ターゲットが `healthy` に戻った。これで ALB は、本当に元気なターゲットだけにお客さんを案内できる。'),
                node('fail open も解除ですね。'),
                hakase('うむ。正常なターゲットが 1 台でもあれば、異常なほうには送らなくなる。健康診断が、ようやく仕事を取り戻したのだ。'),
              )
            : ng(hakase('まだ `healthy` になっていないターゲットがある。`describe-target-health` の `Description` に、残っている理由が書いてあるはずだ。'));
        },
      },
    },
  },

  rds: {
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、ALB に `curl` したら、今度は **500 Internal Server Error** です…'),
          hakase('5 で始まるということは？'),
          node('サーバー側の問題、ですよね。503 のときは、取り次ぐ相手がいない、でした。'),
          hakase('うむ。500 は「サーバーの中で何かが起きて、処理できなかった」だ。今回、ALB はちゃんと取り次げた。転んだのはアプリ自身だ。'),
          node('何につまずいたんですか？ 本文には「アプリがDatabaseに接続できません」って出てました。'),
          hakase('それが答えだ。アプリはお客さんの注文や会員情報を **データベース** から読み出す作りだが、つなぎに行く先の `webapp-db` が、まだ存在しないのだ。'),
          node('でーたべーす…データをしまっておく倉庫、ですよね？'),
          hakase('倉庫というより、整理された帳簿だな。何百万件の注文があっても、欲しい 1 件をすぐ引き出せるようにしまっておく仕組みだ。'),
          node('帳簿がないから、アプリが「注文どこ！？」ってパニックになってるんですね。'),
          hakase('うむ。今日はその帳簿を用意する。'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          hakase('DB を作る操作は `aws rds create-db-instance` だ。決めることを見ておこう。まず **エンジン** (`--engine`)、つまりどの DB ソフトを使うか。今回は `mysql` だ。それと、コンソールにある **テンプレート** は CLI には無い。'),
          node('てんぷれーと？ ひな形ですか？'),
          hakase('うむ。コンソールでは「本番稼働用」「開発/テスト」「無料利用枠」から選ぶと、それらしい初期値を入れてくれる。本番稼働用だと **マルチ AZ** などが最初から ON だ。CLI では、省いたオプションは既定値になる。'),
          node('まるち AZ？'),
          hakase('別の AZ に予備の DB (スタンバイ) を置いて、本体が止まったら自動で切り替える仕組みだ。安心だが、料金も倍近くになる。`--multi-az` を付ければ有効になるが、既定は無効だ。今回は練習だから無効のままでよい。'),
          node('ひな形が無いなら、大事なところは自分で 1 つずつ書くんですね。`--db-instance-identifier` は、DB の名前ですか？'),
          hakase('うむ。**DB インスタンス識別子** という。アプリは `webapp-db` を探しに行くから、必ず `webapp-db` にする。ドキュメントの例を写して `mydbinstance` のまま作ると、アプリは永遠に探し続けるぞ。'),
          node('表札を間違えた家には、郵便が届かないってことですね。`--db-instance-class` の `db.t3.micro` は？'),
          hakase('Lesson 10 の `--instance-type` の DB 版、CPU とメモリの大きさだ。ディスクの大きさは `--allocated-storage` で、今回は 20 GiB。それと、管理者のユーザー名 (`--master-username`) と **マスターパスワード** (`--master-user-password`) だ。パスワードは 8 文字以上。`password` などと入れたら破門する。'),
        ],
      },
      3: {
        type: 'dialogue',
        lines: [
          hakase('残りは置き場所と門番だ。DB は Private subnet に置く。そのために **DB サブネットグループ** を `--db-subnet-group-name` で指定する。'),
          node('さぶねっとぐるーぷ？ Subnet を束ねたものですか？'),
          hakase('うむ。「DB を置いてよい Subnet の名簿」だ。2 つ以上の AZ の Subnet を入れる決まりがある。`private-subnet-1a` と `1c` を入れた `webapp-db-subnet-group` を用意しておいた。中身は `aws rds describe-db-subnet-groups` で見られる。'),
          node('**パブリックアクセス** は？'),
          hakase('「なし」だ。`--no-publicly-accessible` と書く。`--publicly-accessible` にすると DB にパブリック IP が付き、インターネットから接続を試せる状態になる。帳簿を店先の歩道に置くようなものだ。'),
          node('頭に `--no-` を付けると、逆の意味になるんですね。'),
          hakase('うむ。有効か無効かを決めるオプションは、そのまま書けば有効、`--no-` を付ければ無効だ。最後の `--vpc-security-group-ids` は、DB の門番だ。'),
          node('セキュリティグループですね。'),
          hakase('うむ。`db-sg` の ID を渡す。`web-1` と `web-2` に付いておる `web-sg` から、TCP 3306 番だけを通すルールが入っておる。'),
          node('3306 番？'),
          hakase('MySQL の標準のポートだ。ソースが IP アドレスではなく `web-sg` になっておるのは、「`web-sg` を付けたサーバーからなら通す」という意味だ。この仕組みは次のレッスンで詳しく見る。'),
        ],
      },
      4: {
        type: 'table',
        title: '`aws rds create-db-instance` の主な設定',
        columns: ['オプション', '今回の値', 'ポイント'],
        rows: [
          ['`--engine`', '`mysql`', 'どの DB ソフトを使うか'],
          ['`--multi-az`', '(省略。既定で無効)', '本番ではマルチ AZ を有効にすることが多い。料金は倍近く'],
          ['`--db-instance-identifier`', '`webapp-db`', 'アプリの接続先設定と合わせる (例の `mydbinstance` のままにしない)'],
          ['`--db-instance-class` / `--allocated-storage`', '`db.t3.micro` / `20`', 'CPU とメモリの大きさ / ディスクの大きさ (GiB)'],
          ['`--master-username` / `--master-user-password`', '`admin` / 8 文字以上', '管理者のユーザー名とパスワード'],
          ['`--db-subnet-group-name`', '`webapp-db-subnet-group`', 'サブネットグループ = DB を置ける Subnet の集合 (2 AZ 以上)。VPC もこれで決まる'],
          ['`--no-publicly-accessible`', '(パブリックアクセスなし)', 'DB をインターネットに出さない'],
          ['`--vpc-security-group-ids`', '`db-sg` の ID', '`web-sg` からの TCP 3306 (MySQL) を許可済み'],
        ],
      },
      5: {
        type: 'exercise',
        title: 'Database を作成する',
        objective: '`webapp-db` (MySQL, db.t3.micro) を `webapp-db-subnet-group` に、パブリックアクセス **なし**、VPC セキュリティグループ `db-sg` で作成し、`available` にする',
        tasks: [
          { id: 'open', title: '`db-sg` のセキュリティグループ ID を調べる', hint: "`aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query 'SecurityGroups[0].GroupId' --output text`", command: "DB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query 'SecurityGroups[0].GroupId' --output text); echo $DB_SG", done: (c) => !!ranAws(c, 'ec2 describe-security-groups', (x) => x.output.includes(sgId(c, 'db-sg'))) },
          {
            id: 'create',
            title: '`aws rds create-db-instance` で `webapp-db` を作成する',
            hint: '`aws rds create-db-instance --db-instance-identifier webapp-db --engine mysql --db-instance-class db.t3.micro --allocated-storage 20 --master-username admin --master-user-password <8 文字以上> --db-subnet-group-name webapp-db-subnet-group --no-publicly-accessible --vpc-security-group-ids <db-sg の ID>`。パスワードに `/`・`@`・`"`・空白は使えません。',
            command: (c) => `aws rds create-db-instance --db-instance-identifier webapp-db --engine mysql --db-instance-class db.t3.micro --allocated-storage 20 --master-username admin --master-user-password Pass-Hakase-1984 --db-subnet-group-name webapp-db-subnet-group --no-publicly-accessible --vpc-security-group-ids ${sgId(c, 'db-sg')}`,
            done: (c) => !!dbNamed(c.env, 'webapp-db'),
          },
          { id: 'available', title: '`DBInstanceStatus` が `available` になるのを待つ', hint: '`aws rds wait db-instance-available --db-instance-identifier webapp-db`。`creating` → `backing-up` → `available` と進みます。', command: 'aws rds wait db-instance-available --db-instance-identifier webapp-db', done: (c) => dbNamed(c.env, 'webapp-db')?.status === 'available' },
        ],
        validate: (c) => {
          const db = dbNamed(c.env, 'webapp-db');
          if (!db) return ng(hakase("`webapp-db` が見つからん。`--db-instance-identifier` を例のまま `mydbinstance` にしておらんか？ `aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'` で名前を確かめるのだ。"));
          if (c.env.dbSubnetGroups.find((g) => g.dbSubnetGroupName === db.dbSubnetGroupName)?.vpcId !== vpcNamed(c.env, 'webapp-vpc')?.vpcId) return ng(hakase('`webapp-vpc` 以外に作られておる。`--db-subnet-group-name` には `webapp-db-subnet-group` を指定するのだ。`aws rds describe-db-instances` の `DBSubnetGroup` で、どこに作られたかを確かめよ。'));
          if (db.publiclyAccessible) return ng(hakase('パブリックアクセスが有効になっておる！ 本番の帳簿を歩道に置くでない。顧客情報が漏れたら、君の席ごと外に出ていくことになるぞ。'), node('`aws rds modify-db-instance --db-instance-identifier webapp-db --no-publicly-accessible --apply-immediately` で直せばいいんですね。'));
          if (!db.vpcSecurityGroupIds.includes(sgNamed(c.env, 'db-sg')?.groupId ?? '')) return ng(hakase('VPC セキュリティグループに `db-sg` が付いていない。`--vpc-security-group-ids` を省いて、default が付いておらんか？ `aws rds modify-db-instance --db-instance-identifier webapp-db --vpc-security-group-ids <db-sg の ID> --apply-immediately` で付け替えるのだ。'));
          if (db.status !== 'available') return ng(hakase(`ステータスはまだ \`${db.status}\` だ。\`creating\` → \`backing-up\` → \`available\` と進む。\`aws rds wait db-instance-available --db-instance-identifier webapp-db\` で待てる。本物だと 10 分ほどかかるから、コーヒーを淹れに行くのが作法だ。`));
          return ok(
            hakase('DB ができた。`aws rds describe-db-instances --db-instance-identifier webapp-db` で `Endpoint` を見てみよ。作成中には無かったキーだ。'),
            node('えんどぽいんと？ `Address` に `webapp-db.` で始まる長い名前が出てます。'),
            hakase('DB の接続先の名前、つまり DB の DNS 名だ。ALB と同じで、IP アドレスではなく、この名前でつなぎに行く。'),
            node('DNS 名は住所、でしたね。アプリの接続先には、この住所を書いておくんですね。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: 'エンドポイントを確認してアプリの動作を見る',
        objective: '`webapp-db` のエンドポイントを `--query` で取り出し、`curl` で ALB にアクセスして `Database: connected` を確認する',
        tasks: [
          { id: 'endpoint', title: '`describe-db-instances` で `Endpoint` の `Address` を取り出す', hint: "`aws rds describe-db-instances --db-instance-identifier webapp-db --query 'DBInstances[0].Endpoint.Address' --output text`。アプリの DB 接続先 (ホスト名) に設定する値です。", command: "aws rds describe-db-instances --db-instance-identifier webapp-db --query 'DBInstances[0].Endpoint.Address' --output text", done: (c) => !!ranAws(c, 'rds describe-db-instances', (x) => x.output.includes(dbNamed(c.env, 'webapp-db')?.endpointAddress ?? '-')) },
          { id: 'browse', title: '`curl` で ALB にアクセス → `Database: connected`', hint: `\`${DNS_CMD}\` で DNS 名を取り出し、\`curl -i http://<DNS 名>\`。500 ではなく 200 になり、本文に \`Database: connected\` と出れば成功です。`, command: (c) => `curl -i http://${dnsName(c)}`, done: (c) => lastAlbRequest(c)?.status === 200 },
        ],
        validate: (c) =>
          lastAlbRequest(c)?.body.includes('Database: connected')
            ? ok(
                node('500 だったのが 200 になりました！ `Database: connected` って出てます！'),
                hakase('EC2 から RDS への TCP 3306 が、`db-sg` で許可されておるからだ。アプリがエンドポイントの名前で、ちゃんと帳簿を探し当てたのだ。'),
                node('これで注文が消える心配はないですね！'),
                hakase('うむ。データを消すのは、いつだって DB ではなく人間だがな。'),
              )
            : ng(hakase('まだ `Database: connected` が表示されていない。`aws rds describe-db-instances` で `DBInstanceStatus` が `available` になっているかを確かめてから、`curl` で ALB の DNS 名を開き直すのだ。')),
      },
    },
  },

  'web-connectivity': {
    steps: {
      3: {
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
          hakase('うむ。ALB の社員証を持つ者だけが EC2 に入れ、EC2 の社員証を持つ者だけが DB に入れる。`describe-security-groups` の応答では、ソースのセキュリティグループは `IpPermissions` の `UserIdGroupPairs` に `GroupId` で出る。IP アドレスのソースなら `IpRanges` だ。'),
          node('3306 番のルールなら、`"FromPort": 3306` ですね。'),
          hakase('うむ。ちなみにコンソールでは、3306 番のルールのタイプが「MYSQL/Aurora」と表示される。'),
          node('おーろら？'),
          hakase('AWS が作った、MySQL と互換性のある DB だ。同じ 3306 番を使うから、タイプ名でひとまとめにされておる。'),
        ],
      },
      4: {
        type: 'table',
        title: '区間ごとに必要な許可',
        columns: ['区間', 'ルーティング', 'セキュリティグループ (受け側のインバウンドルール)'],
        rows: [
          ['Internet → ALB (80)', 'ALB の Subnet に `0.0.0.0/0 → IGW`', '`alb-sg`: TCP 80 (HTTP) / ソース `0.0.0.0/0` (`IpRanges`)'],
          ['ALB → EC2 (3000)', 'VPC 内 `local`', '`web-sg`: TCP 3000 / ソース `alb-sg` (`UserIdGroupPairs`)'],
          ['EC2 → RDS (3306)', 'VPC 内 `local`', '`db-sg`: TCP 3306 (MYSQL/Aurora) / ソース `web-sg` (`UserIdGroupPairs`)'],
        ],
      },
      5: {
        type: 'dialogue',
        lines: [
          node('サブネットをまたぐ通信は、ネットワーク ACL も通るんですよね？ Lesson 09-2 でやりました。'),
          hakase('その通り。ネットワーク ACL は Subnet の出入口に立つ、もう 1 人の門番だ。しかも **ステートレス**。'),
          node('行きと戻りを別々に許可しないといけないんでしたね。戻りは `1024-65535` のエフェメラルポートで。'),
          hakase('うむ。この VPC はどの Subnet も既定の全部許可の ACL だから通れる。だがカスタム ACL を付けたら、両方の Subnet で、リクエストと **戻り通信** の両方を許可せねばならん。'),
          node('片方だけ許可して、帰り道で迷子になるやつですね。'),
          hakase('そうだ。では `curl -v` で ALB を開いて、`*` の行を読んでみよう。3 区間それぞれの判定と、「ネットワーク ACL」の行も並んでおる。'),
          node('503 のとき、どこで止まったか教えてくれた、あの `-v` ですね。'),
        ],
      },
      6: {
        type: 'exercise',
        title: '経路の確認結果を読む',
        objective: '`curl -v` で ALB にアクセスし、`*` の行で 3 区間すべてが ✔ になっていることを確認する',
        tasks: [{ id: 'browse', title: '`curl -v` で `web-alb` にアクセス', hint: `\`${DNS_CMD}\` で DNS 名を取り出し、\`curl -v http://<DNS 名>\` と打ちます。`, command: (c) => `curl -v http://${dnsName(c)}`, done: (c) => lastAlbRequest(c)?.status === 200 }],
        validate: (c) =>
          lastAlbRequest(c)?.status === 200
            ? ok(
                hakase('`*` の行を見ると、スキーム、ルートテーブル、リスナー、それに各セキュリティグループとネットワーク ACL の判定がずらりと並んでおるな。'),
                node('全部 ✔ です！ 健康診断の結果表みたいですね。'),
                hakase('障害のときは、このどこかが ✘ になる。✘ の行が、君が今夜帰れない理由だ。'),
              )
            : ng(hakase('ALB へのアクセスがまだ 200 になっていない。`aws elbv2 describe-load-balancers --names web-alb` で `DNSName` を取り出して、`curl -v http://<DNS 名>` と打つのだ。')),
      },
      7: {
        type: 'exercise',
        title: 'Security Group の鎖を辿る',
        objective: '`web-sg` のインバウンドルールのソース (`alb-sg`) を ID で引き、次に `db-sg` のソースが `web-sg` であることを確かめる',
        tasks: [
          { id: 'web', title: '`describe-security-groups` で `web-sg` のインバウンドルールを見る', hint: "`aws ec2 describe-security-groups --filters Name=group-name,Values=web-sg --query 'SecurityGroups[0].IpPermissions'`。`UserIdGroupPairs` の `GroupId` がソースのセキュリティグループです。", command: "aws ec2 describe-security-groups --filters Name=group-name,Values=web-sg --query 'SecurityGroups[0].IpPermissions'", done: (c) => !!ranAws(c, 'ec2 describe-security-groups', (x) => askedSg(c, 'web-sg')(x) && x.output.includes(sgId(c, 'alb-sg'))) },
          { id: 'alb', title: 'ソースの `GroupId` を `--group-ids` で引き、`alb-sg` であることを確かめる', hint: "`aws ec2 describe-security-groups --group-ids <GroupId> --query 'SecurityGroups[0].[GroupName,Description]'`。`GroupName` が `alb-sg` なら正解です。", command: (c) => `aws ec2 describe-security-groups --group-ids ${sgId(c, 'alb-sg')} --query 'SecurityGroups[0].[GroupName,Description]'`, done: (c) => !!ranAws(c, 'ec2 describe-security-groups', (x) => param(x, 'group-ids').includes(sgId(c, 'alb-sg'))) },
          { id: 'db', title: '`db-sg` を見て、ソースが `web-sg` であることを確認', hint: "`aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query 'SecurityGroups[0].IpPermissions'`。`UserIdGroupPairs` の `GroupId` が `web-sg` の ID か見比べます。", command: "aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query 'SecurityGroups[0].IpPermissions'", done: (c) => !!ranAws(c, 'ec2 describe-security-groups', (x) => askedSg(c, 'db-sg')(x) && x.output.includes(sgId(c, 'web-sg'))) },
        ],
        validate: (c) =>
          ranAws(c, 'ec2 describe-security-groups', (x) => askedSg(c, 'db-sg')(x) && x.output.includes(sgId(c, 'web-sg')))
            ? ok(
                hakase('`alb-sg` → `web-sg` → `db-sg`。セキュリティグループをソースに指定して、**信頼の鎖** を作っておるのだ。'),
                node('ALB の社員証を持つ者だけが EC2 へ、EC2 の社員証を持つ者だけが DB へ、ですね。'),
                hakase('うむ。この鎖のどこかが切れると、504 や 500 が出る。それは次のトラブルシューティングのコースで、嫌というほど味わってもらう。'),
                node('嫌というほど…'),
              )
            : ng(hakase('まだ辿っていないセキュリティグループがある。`web-sg` の `IpPermissions` の `UserIdGroupPairs` にある `GroupId` を `--group-ids` で引き、それから `db-sg` を `--filters Name=group-name,Values=db-sg` で見るのだ。')),
      },
    },
  },
};

export default patches;
