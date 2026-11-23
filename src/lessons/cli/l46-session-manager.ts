import type { CommandRecord } from '../../console/store';
import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { diagnoseNode, preferencesOf } from '../../sim/ext/ssm';
import { EC2_ROLE, SESSION_LOG_GROUP } from '../../sim/ext/ssm-scenario';
import type { AwsEnv } from '../../sim/types';
import { sgNamed, vpcNamed, subnetNamed } from '../helpers';
import { l46 } from '../l46-session-manager';
import { failedAws, param, ranAws } from './helpers';
import type { CliPatches } from './types';

const { idOf, online, agentAllowed, endpoint, httpsFromBatch, sessionsOn, ranInSession, whoamiSsmUser, loggedEvents, port22Open, lastRevoke, ENDPOINT_SERVICES } = l46;
const sgId = (env: AwsEnv, name: string) => sgNamed(env, name)?.groupId ?? 'sg-xxxxxxxx';
const vpcId = (env: AwsEnv) => vpcNamed(env, 'webapp-vpc')?.vpcId ?? 'vpc-xxxxxxxx';
const subnetId = (env: AwsEnv) => subnetNamed(env, 'private-subnet-1a')?.subnetId ?? 'subnet-xxxxxxxx';
const CORE = 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore';
const LIST_NODES = "aws ssm describe-instance-information --query 'InstanceInformationList[].[InstanceId,PingStatus,PlatformName]' --output text";
/** describe-instance-information の出力に、そのインスタンスが Online で出た */
const listedOnline = (c: TaskContext, name: string) => online(c.env, name) && !!ranAws(c, 'ssm describe-instance-information', (x) => x.output.includes(idOf(c.env, name)) && x.output.includes('Online'));
const startedOn = (c: TaskContext, name: string) => ranAws(c, 'ssm start-session', (x) => param(x, 'target') === idOf(c.env, name));
const sawLogs = (c: TaskContext) => ['logs tail', 'logs filter-log-events', 'logs get-log-events'].some((cmd) => ranAws(c, cmd, (x: CommandRecord) => x.output.includes('sessionData') && x.output.includes('hostname')));

/** Session Manager の設定 (SSM-SessionManagerRunShell の中身)。セキュリティチームが用意したもの */
const PREFERENCES = JSON.stringify(
  {
    schemaVersion: '1.0',
    description: 'Document to hold regional settings for Session Manager',
    sessionType: 'Standard_Stream',
    inputs: { s3BucketName: '', s3KeyPrefix: '', s3EncryptionEnabled: true, cloudWatchLogGroupName: SESSION_LOG_GROUP, cloudWatchEncryptionEnabled: false, cloudWatchStreamingEnabled: true, kmsKeyId: '', runAsEnabled: false, runAsDefaultUser: '', idleSessionTimeout: '20', maxSessionDuration: '', shellProfile: { windows: '', linux: '' } },
  },
  null,
  4,
);

const patches: CliPatches = {
  'session-manager': {
    files: () => ({ 'SessionManagerRunShell.json': PREFERENCES + '\n' }),
    steps: {
      4: {
        type: 'exercise',
        title: 'マネージドノードを確認する',
        objective: '`aws ssm describe-instance-information` でマネージドノードの一覧を見て、web-1 にセッションを開始しようとし、`webapp-ec2-role` に付いているポリシーを確かめる',
        tasks: [
          {
            id: 'list',
            title: '`aws ssm describe-instance-information` でマネージドノードの一覧を見る',
            hint: '`InstanceInformationList` が、Systems Manager に登録できたマネージドノードの一覧です。',
            command: 'aws ssm describe-instance-information',
            done: (c) => !!ranAws(c, 'ssm describe-instance-information'),
          },
          {
            id: 'try',
            title: '`aws ssm start-session` で web-1 に入ろうとしてみる',
            hint: "web-1 のインスタンス ID は `aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[].Instances[].InstanceId' --output text` で調べます。エラーになれば完了です。",
            command: (c) => `aws ssm start-session --target ${idOf(c.env, 'web-1')}`,
            done: (c) => !!failedAws(c, 'ssm start-session', 'TargetNotConnected'),
          },
          {
            id: 'role',
            title: `\`aws iam list-attached-role-policies\` で \`${EC2_ROLE}\` のポリシーを見る`,
            hint: `\`aws iam list-attached-role-policies --role-name ${EC2_ROLE}\`。web-1 と batch-1 には、このロールが付いています。`,
            command: `aws iam list-attached-role-policies --role-name ${EC2_ROLE}`,
            done: (c) => !!ranAws(c, 'iam list-attached-role-policies', (x) => param(x, 'role-name') === EC2_ROLE),
          },
        ],
        validate: (c) =>
          ranAws(c, 'ssm describe-instance-information') && failedAws(c, 'ssm start-session', 'TargetNotConnected') && ranAws(c, 'iam list-attached-role-policies', (x) => param(x, 'role-name') === EC2_ROLE)
            ? ok(
                node('`InstanceInformationList` は空っぽ。start-session は `TargetNotConnected` で「is not connected.」と言われました。'),
                hakase('web-1 はまだマネージドノードではない。ロールのポリシーはどうだった。'),
                node('`CloudWatchAgentServerPolicy` だけです。Systems Manager の許可がありません。制服は着てるのに、通行証が付いてない状態ですね。'),
                hakase('うまいことを言う。給料は上がらんがな。'),
              )
            : ng(hakase(`まだ確かめていないものがある。\`aws ssm describe-instance-information\`、web-1 への \`aws ssm start-session --target <ID>\`、\`aws iam list-attached-role-policies --role-name ${EC2_ROLE}\` の 3 つを打つのだ。`)),
      },
      5: {
        type: 'dialogue',
        lines: [
          hakase(`web-1 と batch-1 には、どちらも ${EC2_ROLE} というロールが付いておる。今は CloudWatchAgentServerPolicy だけだ。メトリクスとログを CloudWatch に送るための許可だな。`),
          node('そこに AmazonSSMManagedInstanceCore を足せばいいんですね。インスタンスごとに付け替えなくていいんですか。'),
          hakase('ロールにポリシーを足せば、そのロールを着ている 2 台とも許可が増える。制服の規則を書き換えるようなものだ。'),
          node('1 回で 2 台分。楽ちんですね。'),
          hakase(`\`aws iam attach-role-policy\` に \`--role-name ${EC2_ROLE}\` と、ポリシーの ARN \`${CORE}\` を付ける。AWS 管理ポリシーの ARN は、アカウント ID の代わりに aws と書くのだ。`),
          hakase('付けたら、エージェントが気づいて登録するまで数秒待つ。本物の AWS では数分かかることもある。`sleep 10` で 10 秒待ってから、一覧を見直すとよい。'),
          node('登録されたら、`describe-instance-information` に出てくるんですね。'),
          hakase('うむ。2 台とも出てくるかどうか、よく見ておくのだ。'),
        ],
      },
      6: {
        type: 'exercise',
        title: 'ロールに Systems Manager の許可を足す',
        objective: `IAM ロール \`${EC2_ROLE}\` に AWS 管理ポリシー \`AmazonSSMManagedInstanceCore\` をアタッチし、web-1 が \`Online\` になったことを確かめる`,
        tasks: [
          {
            id: 'attach',
            title: '`aws iam attach-role-policy` で `AmazonSSMManagedInstanceCore` をアタッチする',
            hint: `\`aws iam attach-role-policy --role-name ${EC2_ROLE} --policy-arn ${CORE}\`。成功すると何も表示されません。`,
            command: `aws iam attach-role-policy --role-name ${EC2_ROLE} --policy-arn ${CORE}`,
            done: (c) => agentAllowed(c.env),
          },
          {
            id: 'online',
            title: '`aws ssm describe-instance-information` で web-1 の `PingStatus` が `Online` になったのを見る',
            hint: "登録まで数秒かかります。空なら `sleep 10` で待ってからもう一度。`--query 'InstanceInformationList[].[InstanceId,PingStatus,PlatformName]' --output text` で必要な列だけ出せます。",
            command: `sleep 10 && ${LIST_NODES}`,
            done: (c) => listedOnline(c, 'web-1'),
          },
        ],
        validate: (c) => {
          if (!agentAllowed(c.env)) return ng(hakase(`${EC2_ROLE} に、まだエージェントの許可がない。\`aws iam attach-role-policy --role-name ${EC2_ROLE} --policy-arn ${CORE}\` だ。`));
          if (!listedOnline(c, 'web-1')) return ng(hakase('許可は付いた。`sleep 10` で少し待ってから、`aws ssm describe-instance-information` で web-1 が Online になったかを見るのだ。'));
          return ok(
            node('web-1 が `Online` で出てきました！ でも batch-1 がいません。'),
            hakase('同じロールを着ておるのに、batch-1 だけ登録できない。許可の問題ではないということだ。'),
            node('残る条件は…通り道ですね。'),
          );
        },
      },
      7: {
        type: 'dialogue',
        lines: [
          hakase('batch-1 はプライベートサブネットにおる。ルートテーブルには local のルートしかない。'),
          node('Lesson 39 で、プライベートのサーバーが外に出るには NAT ゲートウェイが要るって習いました。NAT を作ればいいんですか。'),
          hakase('それでも動く。だがセキュリティチームは「batch-1 からインターネットに出られる道は作るな」と言っておる。しかも NAT は時間料金が高い。'),
          node('S3 のときは、`aws ec2 create-vpc-endpoint` で作ったゲートウェイエンドポイントっていう無料の裏口がありました。'),
          hakase('よく覚えておったな。だがゲートウェイエンドポイントが使えるのは S3 と DynamoDB だけだ。ほかのサービスには、インターフェイスエンドポイントを使う。'),
          node('いんたーふぇいすえんどぽいんと？'),
          hakase('サブネットの中に、そのサービス専用のネットワークインターフェイス (ENI) を置くのだ。ENI は、NACL のレッスンでやったな。'),
          node('インスタンスに挿さってる、仮想の LAN カードでしたっけ。'),
          hakase('そうだ。その ENI がプライベート IP を持ち、サービスの出張窓口になる。さらにプライベート DNS 名を有効にすると、VPC の中では ssm.ap-northeast-1.amazonaws.com という名前が、その ENI の IP に変わる。'),
          node('住所録を書き換えて、本社の住所をビルの 1 階の出張所に向ける感じですか。'),
          hakase('うまい。ENI にはセキュリティグループを付けるから、batch-1 からの HTTPS (443) を許可しておく必要がある。まず `aws ec2 create-security-group` でグループを作り、`aws ec2 authorize-security-group-ingress` で 443 を開ける。'),
          hakase('エンドポイントは同じ `create-vpc-endpoint` に `--vpc-endpoint-type Interface` を付けて作る。置くサブネットは `--subnet-ids`、セキュリティグループは `--security-group-ids` だ。プライベート DNS 名は、何も書かなければ有効になる。`--no-private-dns-enabled` と書けば無効だ。'),
          node('3 つの窓口の分だけ、3 回打つんですね。'),
          hakase('`for s in ssm ssmmessages ec2messages; do …; done` と書けば 1 行で済む。`$s` に 3 つの名前が順に入るのだ。インターフェイスエンドポイントは 1 つずつ時間料金がかかるから、本番で増やすときは請求書の顔色をうかがうことだ。'),
        ],
      },
      8: {
        type: 'exercise',
        title: 'batch-1 の通り道を作る',
        objective: '`webapp-vpc` に、HTTPS (443) を VPC 内 (`10.0.0.0/16`) から許可するセキュリティグループを作り、`ssm` / `ssmmessages` / `ec2messages` のインターフェイスエンドポイントを `private-subnet-1a` に作る (プライベート DNS 名は有効)',
        tasks: [
          {
            id: 'sg-create',
            title: '`aws ec2 create-security-group` で `ssm-endpoint-sg` を作る',
            hint: "`--group-name ssm-endpoint-sg --description 'HTTPS from the VPC to the endpoints' --vpc-id <webapp-vpc の ID>`。返ってきた `GroupId` を次で使います。",
            command: (c) => `aws ec2 create-security-group --group-name ssm-endpoint-sg --description 'HTTPS from the VPC to the endpoints' --vpc-id ${vpcId(c.env)}`,
            done: (c) => !!sgNamed(c.env, 'ssm-endpoint-sg'),
          },
          {
            id: 'sg',
            title: '`aws ec2 authorize-security-group-ingress` で `10.0.0.0/16` からの TCP 443 を許可する',
            hint: '`--group-id <ssm-endpoint-sg の ID> --protocol tcp --port 443 --cidr 10.0.0.0/16`。',
            command: (c) => `aws ec2 authorize-security-group-ingress --group-id ${sgId(c.env, 'ssm-endpoint-sg')} --protocol tcp --port 443 --cidr 10.0.0.0/16`,
            done: (c) => httpsFromBatch(c.env),
          },
          {
            id: 'endpoints',
            title: '`aws ec2 create-vpc-endpoint --vpc-endpoint-type Interface` で ssm / ssmmessages / ec2messages のエンドポイントを作る',
            hint: '1 つずつなら `--vpc-id <webapp-vpc の ID> --vpc-endpoint-type Interface --service-name com.amazonaws.ap-northeast-1.ssm --subnet-ids <private-subnet-1a の ID> --security-group-ids <ssm-endpoint-sg の ID>` を、ssmmessages と ec2messages でも打ちます。for で 3 つまとめても構いません。',
            command: (c) =>
              `for s in ${ENDPOINT_SERVICES.join(' ')}; do aws ec2 create-vpc-endpoint --vpc-id ${vpcId(c.env)} --vpc-endpoint-type Interface --service-name com.amazonaws.ap-northeast-1.$s --subnet-ids ${subnetId(c.env)} --security-group-ids ${sgId(c.env, 'ssm-endpoint-sg')} --query 'VpcEndpoint.[VpcEndpointId,ServiceName,PrivateDnsEnabled]' --output text; done`,
            done: (c) => ENDPOINT_SERVICES.every((s) => !!endpoint(c.env, s)),
          },
          {
            id: 'online',
            title: '`aws ssm describe-instance-information` で batch-1 が `Online` になったのを見る',
            hint: '数秒かかります。`sleep 10` で待ってから見ます。',
            command: `sleep 10 && ${LIST_NODES}`,
            done: (c) => listedOnline(c, 'batch-1'),
          },
        ],
        validate: (c) => {
          if (listedOnline(c, 'batch-1'))
            return ok(
              node('batch-1 も `Online` になりました！ インターネットには 1 歩も出ていないのに。'),
              hakase('エージェントは ssm.ap-northeast-1.amazonaws.com に接続しただけだ。VPC の中では、その名前がエンドポイントの ENI を指しておる。'),
              node('住所録の書き換え、恐るべしですね。'),
            );
          const failed = diagnoseNode(c.env, idOf(c.env, 'batch-1')).checks.find((x) => !x.ok);
          return ng(hakase(failed ? `batch-1 はまだ Online になっておらん。引っかかっているのは「${failed.label}」だ: ${failed.detail}` : 'エンドポイントはそろった。`sleep 10` で待ってから、`aws ssm describe-instance-information` を打ち直すのだ。'));
        },
      },
      9: {
        type: 'dialogue',
        lines: [
          hakase('いよいよ入るぞ。`aws ssm start-session --target <batch-1 の ID>` だ。'),
          node('`aws ec2-instance-connect ssh` と同じで、打つとサーバーの中に入るんですか。'),
          hakase('そうだ。ただし本物の AWS CLI では、PC に Session Manager プラグインという追加のプログラムを入れておく必要がある。この学習環境では入れなくても動く。'),
          node('ぷらぐいん。AWS CLI に足すおまけですね。'),
          hakase('`--reason` を付ければ、セッションの理由が履歴に残る。「なんとなく入った」と書く勇気があるなら、それでもよい。'),
          node('書きませんよ、そんなこと。'),
          hakase('入るとプロンプトが `sh-5.2$` に変わる。そこで whoami を打ってみるのだ。Lesson 26 では ec2-user だったな。'),
          node('今度は誰になるんですか。'),
          hakase('打てばわかる。終わったら `exit` でセッションを閉じる。開けっぱなしは、金庫を開けたまま帰るのと同じだ。'),
        ],
      },
      10: {
        type: 'exercise',
        title: 'batch-1 にセッションで入る',
        objective: '`aws ssm start-session` で `batch-1` に入り、`whoami` を実行してから `exit` でセッションを終える',
        tasks: [
          {
            id: 'start',
            title: '`aws ssm start-session` で batch-1 に入る',
            hint: '`aws ssm start-session --target <batch-1 の ID>`。プロンプトが `sh-5.2$` に変われば、batch-1 の中です。',
            command: (c) => `aws ssm start-session --target ${idOf(c.env, 'batch-1')}`,
            done: (c) => !!startedOn(c, 'batch-1'),
          },
          {
            id: 'whoami',
            title: 'batch-1 の中で `whoami` を実行する',
            hint: '`whoami` と打ちます。',
            command: 'whoami',
            done: whoamiSsmUser,
          },
          {
            id: 'exit',
            title: '`exit` でセッションを終え、PC に戻る',
            hint: '`Exiting session with sessionId: …` と出て、プロンプトが `learner@my-pc` に戻ります。',
            command: 'exit',
            done: (c) => whoamiSsmUser(c) && sessionsOn(c.env, 'batch-1').some((s) => s.status === 'Terminated'),
          },
        ],
        validate: (c) =>
          whoamiSsmUser(c) && sessionsOn(c.env, 'batch-1').some((s) => s.status === 'Terminated')
            ? ok(
                node('`ssm-user` と出ました。ec2-user じゃないんですね。'),
                hakase('セッションマネージャーは、ssm-user というユーザーでシェルを開く。SSM Agent が用意するユーザーだ。'),
                node('22 番もパブリック IP もないプライベートの batch-1 に、踏み台なしで入れちゃいました。'),
                hakase('`aws ssm describe-sessions --state History` を打ってみろ。誰が (`Owner`)、いつ (`StartDate`)、どのインスタンスに (`Target`) 入って、いつ出たか (`EndDate`) が残っておる。'),
              )
            : ng(hakase('batch-1 に `aws ssm start-session --target <ID>` で入って whoami を打ち、`exit` でセッションを終えるのだ。')),
      },
      11: {
        type: 'dialogue',
        lines: [
          node('履歴には、入った人と時間は残ってます。でも何を打ったかはわからないですよね。'),
          hakase('そこで、セッションのログを CloudWatch Logs に送る。セッションマネージャーの設定は、SSM-SessionManagerRunShell という名前の SSM ドキュメントに入っておる。ドキュメントは、Systems Manager が使う設定書の JSON だ。'),
          hakase('`aws ssm get-document --name SSM-SessionManagerRunShell` で今の中身が見られる。書き換えるのは `aws ssm update-document` だ。'),
          hakase(`セキュリティチームが、ホームに SessionManagerRunShell.json を置いてくれた。\`cloudWatchLogGroupName\` が ${SESSION_LOG_GROUP}、\`cloudWatchStreamingEnabled\` が true になっておる。ロググループも用意済みだ。Lesson 25 でやったな。ロググループが棚で、ログストリームが出どころごとの記録だ。`),
          node('ログストリームの名前は何になるんですか。'),
          hakase('セッション ID だ。セッションごとに 1 本できる。ストリーミングを有効にすれば、コマンドを打つたびにログが届く。'),
          node('すとりーむ。小川みたいに、ちょろちょろ流れ続けるんですね。'),
          hakase('うむ。ログを書くのはエージェントだから、ロールに logs:PutLogEvents などの許可が要る。CloudWatchAgentServerPolicy に入っておるから、今日はそのままでよい。'),
          hakase('新しい設定が使われるのは、更新したあとに開始したセッションからだ。今回は web-1 で試すのだ。なぜ batch-1 ではないのかは、最後に問題を出す。'),
          node('うわ、いやな予告だ…'),
        ],
      },
      12: {
        type: 'exercise',
        title: 'セッションの操作を記録する',
        objective: `\`aws ssm update-document\` で Session Manager の設定を更新し (ロググループ \`${SESSION_LOG_GROUP}\`、ストリーミング)、web-1 とのセッションで \`hostname\` を実行して、そのログを \`aws logs\` で確かめる`,
        tasks: [
          {
            id: 'prefs',
            title: '`aws ssm update-document` で `SessionManagerRunShell.json` を設定に反映する',
            hint: "中身は `cat SessionManagerRunShell.json` で確かめられます。`aws ssm update-document --name SSM-SessionManagerRunShell --content file://SessionManagerRunShell.json --document-version '$LATEST'`。`$LATEST` は最新のバージョンのことで、シェルに変数と読まれないように ' で囲みます。",
            command: "aws ssm update-document --name SSM-SessionManagerRunShell --content file://SessionManagerRunShell.json --document-version '$LATEST'",
            done: (c) => preferencesOf(c.env).cloudWatchLogGroupName === SESSION_LOG_GROUP,
          },
          {
            id: 'start',
            title: '`aws ssm start-session` で web-1 に入る',
            hint: '`aws ssm start-session --target <web-1 の ID>`。設定を更新したあとに開始したセッションだけがログに残ります。',
            command: (c) => `aws ssm start-session --target ${idOf(c.env, 'web-1')}`,
            done: (c) => sessionsOn(c.env, 'web-1').some((s) => s.logGroupName === SESSION_LOG_GROUP),
          },
          {
            id: 'run',
            title: 'web-1 の中で `hostname` を実行する',
            hint: '`hostname` と打ちます。',
            command: 'hostname',
            done: (c) => loggedEvents(c.env).some((e) => e.message.includes('hostname')),
          },
          {
            id: 'exit',
            title: '`exit` で PC に戻る',
            hint: 'セッションの中の `aws` は web-1 のものなので、ログを見るには PC に戻ります。',
            command: 'exit',
            done: (c) => sessionsOn(c.env, 'web-1').some((s) => s.logGroupName === SESSION_LOG_GROUP && s.status === 'Terminated'),
          },
          {
            id: 'view',
            title: `\`aws logs tail\` で \`${SESSION_LOG_GROUP}\` のログを見る`,
            hint: `\`aws logs tail ${SESSION_LOG_GROUP} --since 1h\`。ログストリームの名前がセッション ID です。`,
            command: `aws logs tail ${SESSION_LOG_GROUP} --since 1h`,
            done: sawLogs,
          },
        ],
        validate: (c) => {
          if (preferencesOf(c.env).cloudWatchLogGroupName !== SESSION_LOG_GROUP) return ng(hakase("まだログの送り先が決まっておらん。`aws ssm update-document --name SSM-SessionManagerRunShell --content file://SessionManagerRunShell.json --document-version '$LATEST'` だ。"));
          if (!loggedEvents(c.env).some((e) => e.message.includes('hostname')))
            return ng(hakase('ロググループに hostname の記録がない。設定を更新してから web-1 との「新しい」セッションを開始して、hostname を打つのだ。batch-1 でやっても、ログは届かんぞ。'));
          if (!sawLogs(c)) return ng(hakase(`記録はできた。\`exit\` で PC に戻り、\`aws logs tail ${SESSION_LOG_GROUP} --since 1h\` でログを見るのだ。`));
          return ok(
            node('JSON で出てます。`sessionData` に `sh-5.2$ hostname` と結果、`userIdentity` に僕の ARN、`runAsUser` が ssm-user。'),
            hakase('誰が、どのインスタンスで、何を打って、何が返ったか。監査に聞かれて困ることは、もう何もない。'),
            node('僕が変なコマンドを打っても、全部バレるってことですね。'),
            hakase('そういうことだ。言い訳を考える時間が省けて、よかったな。'),
          );
        },
      },
      14: {
        type: 'exercise',
        title: '22 番を閉じる',
        objective: '`web-sg` と `batch-sg` のインバウンドルールから SSH (22) を削除し、そのあと `batch-1` とのセッションでコマンドを実行する',
        tasks: [
          {
            id: 'web',
            title: '`aws ec2 revoke-security-group-ingress` で web-sg の SSH (`198.51.100.24/32`) を削除する',
            hint: '`--group-id <web-sg の ID> --protocol tcp --port 22 --cidr 198.51.100.24/32`。ルールは `aws ec2 describe-security-groups --filters Name=group-name,Values=web-sg` で確かめられます。',
            command: (c) => `aws ec2 revoke-security-group-ingress --group-id ${sgId(c.env, 'web-sg')} --protocol tcp --port 22 --cidr 198.51.100.24/32`,
            done: (c) => !!sgNamed(c.env, 'web-sg') && !port22Open(c.env, 'web-sg'),
          },
          {
            id: 'batch',
            title: '`aws ec2 revoke-security-group-ingress` で batch-sg の SSH (web-sg から) を削除する',
            hint: '相手がセキュリティグループのルールは `--cidr` の代わりに `--source-group <web-sg の ID>` で指定します。',
            command: (c) => `aws ec2 revoke-security-group-ingress --group-id ${sgId(c.env, 'batch-sg')} --protocol tcp --port 22 --source-group ${sgId(c.env, 'web-sg')}`,
            done: (c) => !!sgNamed(c.env, 'batch-sg') && !port22Open(c.env, 'batch-sg'),
          },
          {
            id: 'start',
            title: '`aws ssm start-session` で batch-1 にもう一度入る',
            hint: '22 番を閉じたあとに開始したセッションで確かめます。',
            command: (c) => `aws ssm start-session --target ${idOf(c.env, 'batch-1')}`,
            done: (c) => !port22Open(c.env, 'web-sg') && !port22Open(c.env, 'batch-sg') && sessionsOn(c.env, 'batch-1').some((s) => s.startDate >= lastRevoke(c.env) && s.status === 'Connected'),
          },
          {
            id: 'session',
            title: 'batch-1 の中で `hostname` を実行する',
            hint: '`hostname` と打ちます。終わったら `exit` で PC に戻れます。',
            command: 'hostname',
            done: (c) => !port22Open(c.env, 'web-sg') && !port22Open(c.env, 'batch-sg') && ranInSession(c, 'batch-1', /^\s*hostname/, lastRevoke(c.env)),
          },
        ],
        validate: (c) => {
          if (port22Open(c.env, 'web-sg') || port22Open(c.env, 'batch-sg')) return ng(hakase('まだ 22 番を許可しているルールが残っておる。`aws ec2 revoke-security-group-ingress` で、web-sg の `--cidr 198.51.100.24/32` と batch-sg の `--source-group <web-sg の ID>` の SSH を消すのだ。'));
          if (!ranInSession(c, 'batch-1', /^\s*hostname/, lastRevoke(c.env))) return ng(hakase('22 番は閉じた。そのあとで `aws ssm start-session` で batch-1 に入り、hostname を打つのだ。閉じる前のセッションは数えんぞ。'));
          return ok(
            node('入れました！ 22 番が閉じていても、batch-1 のシェルが普通に動きます。'),
            hakase('玄関は全部閉めた。入るときはセッションマネージャー、入った記録は CloudWatch Logs と CloudTrail。監査への回答書は、これで書ける。'),
            node('回答書は僕が書きます。……博士の分の始末書も、ついでに書いておきましょうか？'),
            hakase('ワシは何もやらかしておらん。君の給料から代筆料を引いておく。'),
          );
        },
      },
    },
  },
};

export default patches;
