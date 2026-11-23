// Lesson 46: Systems Manager Session Manager. The base (web-1 public, batch-1 private without NAT, webapp-ec2-role,
// /ssm/session-logs) is prepared by the scenario; the learner only adds what Session Manager needs.
import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { diagnoseNode, pingStatus, preferencesOf } from '../sim/ext/ssm';
import { EC2_ROLE, SESSION_LOG_GROUP, sessionManagerEnv } from '../sim/ext/ssm-scenario';
import { evaluateSecurityGroup, ruleMatchesTraffic } from '../sim/sg';
import type { AwsEnv } from '../sim/types';
import { instanceNamed, sgNamed, visited, visitedQuery, vpcNamed } from './helpers';

const ENDPOINT_SERVICES = ['ssm', 'ssmmessages', 'ec2messages'] as const;
const idOf = (env: AwsEnv, name: string) => instanceNamed(env, name)?.instanceId ?? '-';
const online = (env: AwsEnv, name: string) => pingStatus(env, idOf(env, name)) === 'Online';
/** the role lets SSM Agent talk to Systems Manager (AmazonSSMManagedInstanceCore or equivalent) */
const agentAllowed = (env: AwsEnv) => !!diagnoseNode(env, idOf(env, 'web-1')).checks.find((c) => c.label === 'IAM ロールの許可')?.ok;
const endpoint = (env: AwsEnv, svc: string) => env.vpcEndpoints.find((e) => e.type === 'Interface' && e.vpcId === vpcNamed(env, 'webapp-vpc')?.vpcId && e.serviceName === `com.amazonaws.${env.region}.${svc}`);
/** some security group in webapp-vpc lets batch-1 in on HTTPS (for the endpoints) */
const httpsFromBatch = (env: AwsEnv) => {
  const b = instanceNamed(env, 'batch-1');
  return !!b && env.securityGroups.some((g) => g.vpcId === b.vpcId && evaluateSecurityGroup(env, [g.groupId], 'ingress', { protocol: 'tcp', port: 443, peerIp: b.privateIpAddress, peerGroupIds: b.securityGroupIds }).allowed);
};
const sessionsOn = (env: AwsEnv, name: string) => (env.ssm?.sessions ?? []).filter((s) => s.target === idOf(env, name));
/** a command run in a Session Manager session on the instance (as ssm-user), after `since` */
const ranInSession = (c: TaskContext, name: string, re: RegExp, since = 0) =>
  sessionsOn(c.env, name).some((s) => s.startDate >= since && c.commands.some((x) => x.instanceId === s.target && x.at >= s.startDate && (!s.endDate || x.at <= s.endDate) && x.ok && re.test(x.line)));
const whoamiSsmUser = (c: TaskContext) => c.commands.some((x) => x.instanceId === idOf(c.env, 'batch-1') && /^\s*whoami/.test(x.line) && x.output === 'ssm-user');
const loggedEvents = (env: AwsEnv) => (env.logGroups.find((g) => g.logGroupName === SESSION_LOG_GROUP)?.events ?? []).filter((e) => e.message.includes('sessionData') || e.message.startsWith('sh-'));
const port22Open = (env: AwsEnv, group: string) => !!sgNamed(env, group)?.ingress.some((r) => ruleMatchesTraffic(r, 'tcp', 22));
/** when the learner last revoked an inbound rule of web-sg / batch-sg (CloudTrail) */
const lastRevoke = (env: AwsEnv) => {
  const ids = ['web-sg', 'batch-sg'].map((g) => sgNamed(env, g)?.groupId);
  return Math.max(0, ...env.trailEvents.filter((e) => e.eventName === 'RevokeSecurityGroupIngress' && e.userIdentity.userName === 'learner' && e.resources.some(([, id]) => ids.includes(id))).map((e) => e.eventTime));
};
const openedConnectTab = (c: TaskContext) => ['web-1', 'batch-1'].some((n) => visitedQuery(c, `/ec2/instances/${idOf(c.env, n)}/connect`, { tab: 'ssm' }));

export const lesson46: Lesson = {
  id: 'session-manager',
  number: '46',
  title: 'Systems Manager Session Manager',
  summary: 'SSH のポートを開けずにインスタンスに入り、操作を記録する',
  minutes: 25,
  startPath: '/ec2/instances',
  scenario: sessionManagerEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、セキュリティ監査の結果が来ました。「web-1 の 22 番ポートが開いている」って指摘されてます。'),
        hakase('ほう。オフィスからの SSH だけに絞ってあっても、指摘されたか。'),
        node('セキュリティチームからの指示は 2 つです。「22 番は全部閉じること」「サーバーで誰が何をしたか、全部記録すること」。'),
        hakase('もっともな指示だ。Lesson 26 を覚えておるか。誰かが SSH のルールを消して、誰も batch-1 に入れなくなった事件だ。'),
        node('EC2 Instance Connect も中身は SSH で、22 番が閉じたら入れなくなるって話でしたよね。'),
        hakase('そうだ。22 番を閉じたら、あの事件が毎日起きるようなものだ。'),
        node('じゃあ、どうやってサーバーに入るんですか。窓から？'),
        hakase('窓も閉じておる。今日使うのは Session Manager (セッションマネージャー) だ。ポートを 1 つも開けずに、サーバーのシェルに入れる。'),
        node('え、ドアが全部閉まってるのに中に入れるんですか。'),
        hakase('中から電話をかけてもらうのだ。順に説明する。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('Session Manager は、AWS Systems Manager というサービスの機能の 1 つだ。Systems Manager は、たくさんのサーバーをまとめて面倒を見るための道具箱だな。'),
        node('しすてむずまねーじゃー。道具箱の中に、セッションマネージャーが入ってるんですね。'),
        hakase('うむ。サーバーの中には SSM Agent (エージェント) というプログラムが常駐しておる。SSM は、Systems Manager の昔の名前 Simple Systems Manager の略だ。Amazon Linux 2023 なら最初から入っておる。'),
        hakase('エージェントは、自分から外へ HTTPS (TCP 443) で Systems Manager に接続して、「ここにおるぞ」と定期的に知らせる。これを ping という。'),
        node('ぴんぐ。生存確認ですね。'),
        hakase('Systems Manager に登録できたサーバーを、マネージドノードという。ノードは、管理する 1 台 1 台のことだ。エージェントがちゃんと ping を送ってくるなら、ping ステータスは「オンライン」になる。'),
        node('で、セッションはどうつながるんですか。'),
        hakase('君がセッションを開始すると、Systems Manager はエージェントがつないでいる回線に「客が来たぞ」と伝え、その回線の上でシェルを動かす。通信を始めるのはいつもサーバーの側だ。'),
        node('つまり、サーバーが外に電話をかけっぱなしにしてて、その電話で話すから、玄関 (インバウンドのポート) を開けなくていいってことですね。'),
        hakase('そういうことだ。セキュリティグループはステートフルだったな。出ていった通信の戻りは、インバウンドのルールがなくても通る。'),
        node('Lesson 09 でやったやつだ。行きが許可されていれば、帰りは顔パス。'),
        hakase('うむ。そしてセッションは、誰がいつどのサーバーに入ったかが Systems Manager に記録される。設定すれば、打ったコマンドと出力も CloudWatch Logs に残せる。'),
        node('「全部記録しろ」の指示も片付くじゃないですか。'),
        hakase('片付くかどうかは、君の手際しだいだがな。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('サーバーがマネージドノードになるには、何が要るんですか。'),
        hakase('3 つだ。1 つ目はエージェント。今日の web-1 と batch-1 は Amazon Linux 2023 だから、すでに入っておる。'),
        hakase('2 つ目は権限だ。エージェントは、インスタンスに付いた IAM ロールの一時的な認証情報で Systems Manager を呼ぶ。'),
        node('Lesson 22 でやったインスタンスプロファイルですね。EC2 に制服を着せるやつ。'),
        hakase('そうだ。その制服に、Systems Manager と話してよいという許可が要る。AWS 管理ポリシーの AmazonSSMManagedInstanceCore を付けるのが定番だ。'),
        hakase('3 つ目は通り道だ。エージェントは HTTPS で 3 つの窓口に接続する。ssm、ssmmessages、ec2messages だ。'),
        node('3 つもあるんですか。役割が違うんですか。'),
        hakase('ssm は登録と ping、ssmmessages はセッションのデータ、ec2messages はエージェントへの指示の受け渡しに使う。窓口の住所 (エンドポイント) は ssm.ap-northeast-1.amazonaws.com のような名前だ。'),
        node('3 つの窓口に電話が届かないとダメ、ってことですね。'),
        hakase('うむ。表にしておく。'),
      ],
    },
    {
      type: 'table',
      title: 'マネージドノードになる条件',
      columns: ['条件', '中身', '今日の状態'],
      rows: [
        ['SSM Agent', 'インスタンスで動くエージェント', 'Amazon Linux 2023 にはプリインストール済み'],
        ['IAM ロールの許可', 'エージェントが Systems Manager を呼ぶ許可 (AmazonSSMManagedInstanceCore)', 'webapp-ec2-role にはまだない'],
        ['通り道 (HTTPS 443)', 'ssm / ssmmessages / ec2messages のエンドポイントに届くこと', 'web-1 はインターネット経由で届く。batch-1 は?'],
      ],
    },
    {
      type: 'exercise',
      title: 'マネージドノードを確認する',
      objective: 'EC2 の「インスタンスに接続」でセッションマネージャーのタブを開き、Systems Manager のフリートマネージャーでマネージドノードの一覧を見る',
      tasks: [
        { id: 'tab', title: 'インスタンス一覧で `web-1` (または `batch-1`) を選び、「接続」 → 「セッションマネージャー」 タブ', hint: 'インスタンスにチェックを付けると、一覧の上の「接続」が押せます。タブの中に、エージェントがオンラインでない理由の診断が出ます。', done: openedConnectTab },
        { id: 'fleet', title: '検索バーで `Systems Manager` → 左メニュー 「フリートマネージャー」', hint: 'サービスの検索で「フリートマネージャー」と入力しても開けます。', done: (c) => visited(c, '/ssm/fleet-manager') },
      ],
      validate: (c) =>
        openedConnectTab(c) && visited(c, '/ssm/fleet-manager')
          ? ok(
              node('フリートマネージャーは「マネージドノードがありません」。接続画面にも「SSM Agent がオンラインになっていません」と出ました。'),
              hakase('診断を見ると、「IAM ロールの許可」がバツになっておる。エージェントは入っているが、身分証に許可がないのだ。'),
              node('制服は着てるのに、通行証が付いてない状態ですね。'),
              hakase('うまいことを言う。給料は上がらんがな。'),
            )
          : ng(hakase('まだ見ていない画面がある。EC2 のインスタンスの「接続」でセッションマネージャーのタブを開き、Systems Manager のフリートマネージャーも開くのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        hakase(`web-1 と batch-1 には、どちらも ${EC2_ROLE} というロールが付いておる。今は CloudWatchAgentServerPolicy だけだ。メトリクスとログを CloudWatch に送るための許可だな。`),
        node('そこに AmazonSSMManagedInstanceCore を足せばいいんですね。インスタンスごとに付け替えなくていいんですか。'),
        hakase('ロールにポリシーを足せば、そのロールを着ている 2 台とも許可が増える。制服の規則を書き換えるようなものだ。'),
        node('1 回で 2 台分。楽ちんですね。'),
        hakase('IAM の「ロール」からロールを開き、「許可を追加」→「ポリシーをアタッチ」だ。付けたら、エージェントが気づいて登録するまで数秒待つ。本物の AWS では数分かかることもある。'),
        node('登録されたら、フリートマネージャーに出てくるんですね。'),
        hakase('うむ。2 台とも出てくるかどうか、よく見ておくのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ロールに Systems Manager の許可を足す',
      objective: `IAM ロール \`${EC2_ROLE}\` に AWS 管理ポリシー \`AmazonSSMManagedInstanceCore\` をアタッチし、フリートマネージャーで web-1 がオンラインになったことを確かめる`,
      tasks: [
        { id: 'attach', title: `IAM > ロール > \`${EC2_ROLE}\` → 「許可を追加」 → 「ポリシーをアタッチ」 で \`AmazonSSMManagedInstanceCore\``, hint: 'ポリシーの検索欄に「SSMManaged」と入れると見つかります。', hotspotId: 'iam-add-permissions', done: (c) => agentAllowed(c.env) },
        { id: 'online', title: 'フリートマネージャーで `web-1` の SSM Agent ping ステータスが 「オンライン」 になる', hint: '数秒かかります。一覧が空なら、少し待ってからもう一度開きます。', done: (c) => online(c.env, 'web-1') },
      ],
      validate: (c) => {
        if (!agentAllowed(c.env)) return ng(hakase(`${EC2_ROLE} に、まだエージェントの許可がない。IAM のロールから ${EC2_ROLE} を開き、「許可を追加」→「ポリシーをアタッチ」で AmazonSSMManagedInstanceCore を選ぶのだ。`));
        if (!online(c.env, 'web-1')) return ng(hakase('許可は付いた。エージェントが登録するまで少し待って、フリートマネージャーを開き直すのだ。'));
        return ok(
          node('web-1 が「オンライン」で出てきました！ でも batch-1 がいません。'),
          hakase('同じロールを着ておるのに、batch-1 だけ登録できない。許可の問題ではないということだ。'),
          node('残る条件は…通り道ですね。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('batch-1 はプライベートサブネットにおる。ルートテーブルには local のルートしかない。'),
        node('Lesson 39 で、プライベートのサーバーが外に出るには NAT ゲートウェイが要るって習いました。NAT を作ればいいんですか。'),
        hakase('それでも動く。だがセキュリティチームは「batch-1 からインターネットに出られる道は作るな」と言っておる。しかも NAT は時間料金が高い。'),
        node('S3 のときは、ゲートウェイエンドポイントっていう無料の裏口がありました。'),
        hakase('よく覚えておったな。だがゲートウェイエンドポイントが使えるのは S3 と DynamoDB だけだ。ほかのサービスには、インターフェイスエンドポイントを使う。'),
        node('いんたーふぇいすえんどぽいんと？'),
        hakase('サブネットの中に、そのサービス専用のネットワークインターフェイス (ENI) を置くのだ。ENI は、NACL のレッスンでやったな。'),
        node('インスタンスに挿さってる、仮想の LAN カードでしたっけ。'),
        hakase('そうだ。その ENI がプライベート IP を持ち、サービスの出張窓口になる。さらに「プライベート DNS 名」を有効にすると、VPC の中では ssm.ap-northeast-1.amazonaws.com という名前が、その ENI の IP に変わる。'),
        node('住所録を書き換えて、本社の住所をビルの 1 階の出張所に向ける感じですか。'),
        hakase('うまい。エージェントはいつもの名前に接続するだけで、勝手に出張所へ行く。ENI にはセキュリティグループを付けるから、batch-1 からの HTTPS (443) を許可しておく必要がある。'),
        node('出張所の受付にも、入館ルールがあるんですね。'),
        hakase('うむ。3 つの窓口の分だけ、エンドポイントを 3 つ作る。インターフェイスエンドポイントは 1 つずつ時間料金がかかるから、本番で増やすときは請求書の顔色をうかがうことだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'batch-1 の通り道を作る',
      objective: '`webapp-vpc` に、HTTPS (443) を VPC 内 (`10.0.0.0/16`) から許可するセキュリティグループを作り、`ssm` / `ssmmessages` / `ec2messages` のインターフェイスエンドポイントを `private-subnet-1a` に作る (DNS 名を有効化)',
      tasks: [
        { id: 'sg', title: 'EC2 > セキュリティグループ → 「セキュリティグループを作成」 (名前 `ssm-endpoint-sg`、VPC `webapp-vpc`、インバウンド HTTPS / `10.0.0.0/16`)', hint: 'タイプ「HTTPS」を選ぶとポート 443 が入ります。ソースはカスタムで `10.0.0.0/16`。', done: (c) => httpsFromBatch(c.env) },
        ...ENDPOINT_SERVICES.map((svc) => ({
          id: svc,
          title: `VPC > エンドポイント → 「エンドポイントを作成」: \`com.amazonaws.ap-northeast-1.${svc}\``,
          hint: 'VPC は `webapp-vpc`、サブネットは `private-subnet-1a`、セキュリティグループは今作ったもの。「DNS 名を有効化」はオンのままにします。',
          hotspotId: 'vpce-create',
          done: (c: TaskContext) => !!endpoint(c.env, svc),
        })),
        { id: 'online', title: 'フリートマネージャーで `batch-1` が 「オンライン」 になる', hint: '数秒かかります。オンラインにならなければ、EC2 の接続画面のセッションマネージャータブで診断を見ます。', done: (c) => online(c.env, 'batch-1') },
      ],
      validate: (c) => {
        if (online(c.env, 'batch-1'))
          return ok(
            node('batch-1 もオンラインになりました！ インターネットには 1 歩も出ていないのに。'),
            hakase('エージェントは ssm.ap-northeast-1.amazonaws.com に接続しただけだ。VPC の中では、その名前がエンドポイントの ENI を指しておる。'),
            node('住所録の書き換え、恐るべしですね。'),
          );
        const failed = diagnoseNode(c.env, idOf(c.env, 'batch-1')).checks.find((x) => !x.ok);
        return ng(hakase(failed ? `batch-1 はまだオンラインになっておらん。引っかかっているのは「${failed.label}」だ: ${failed.detail}` : 'エンドポイントはそろった。エージェントが登録するまで数秒待って、フリートマネージャーを開き直すのだ。'));
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('いよいよ入るぞ。セッションマネージャーの「セッションの開始」で、ターゲットに batch-1 を選ぶ。EC2 の接続画面のセッションマネージャータブからでもよい。'),
        node('「セッションの理由」って欄がありますね。'),
        hakase('任意だが、書いておけば履歴に残る。「なんとなく入った」と書く勇気があるなら、それでもよい。'),
        node('書きませんよ、そんなこと。'),
        hakase('入ったら whoami を打ってみるのだ。Lesson 26 では ec2-user だったな。'),
        node('今度は誰になるんですか。'),
        hakase('打てばわかる。終わったら、画面右上の「終了」でセッションを閉じる。開けっぱなしは、金庫を開けたまま帰るのと同じだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'batch-1 にセッションで入る',
      objective: 'セッションマネージャーで `batch-1` とのセッションを開始し、`whoami` を実行してからセッションを終了する',
      tasks: [
        { id: 'start', title: 'Systems Manager > セッションマネージャー → 「セッションの開始」 → `batch-1` → 「セッションを開始」', hint: 'EC2 の「インスタンスに接続」→「セッションマネージャー」タブの「接続」からでも開始できます。', hotspotId: 'ssm-start-session', done: (c) => sessionsOn(c.env, 'batch-1').length > 0 },
        { id: 'whoami', title: 'ターミナルで `whoami`', hint: 'プロンプトが `sh-5.2$` になっています。', hotspotId: 'ssm-terminal-input', done: whoamiSsmUser },
        { id: 'end', title: '右上の 「終了」 でセッションを終了する', hint: '`exit` と打っても終わります。', hotspotId: 'ssm-terminate', done: (c) => sessionsOn(c.env, 'batch-1').some((s) => s.status === 'Terminated') },
      ],
      validate: (c) =>
        whoamiSsmUser(c) && sessionsOn(c.env, 'batch-1').some((s) => s.status === 'Terminated')
          ? ok(
              node('`ssm-user` と出ました。ec2-user じゃないんですね。'),
              hakase('セッションマネージャーは、ssm-user というユーザーでシェルを開く。SSM Agent が用意するユーザーだ。'),
              node('22 番もパブリック IP もないプライベートの batch-1 に、踏み台なしで入れちゃいました。'),
              hakase('セッション履歴のタブを見てみろ。誰が、いつ、どのインスタンスに入って、いつ出たかが残っておる。'),
            )
          : ng(hakase('batch-1 とのセッションで whoami を打ち、そのあと「終了」でセッションを閉じるのだ。セッションマネージャーの「セッションの開始」から batch-1 を選ぶ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('履歴には、入った人と時間は残ってます。でも何を打ったかはわからないですよね。'),
        hakase('そこで、セッションのログを CloudWatch Logs に送る。設定はセッションマネージャーの「設定」タブだ。'),
        hakase(`セキュリティチームが ${SESSION_LOG_GROUP} というロググループを用意してくれておる。Lesson 25 でやったな。ロググループが棚で、ログストリームが出どころごとの記録だ。`),
        node('ログストリームの名前は何になるんですか。'),
        hakase('セッション ID だ。セッションごとに 1 本できる。「セッションログのストリーム」を選べば、コマンドを打つたびにログが届く。'),
        node('すとりーむ。小川みたいに、ちょろちょろ流れ続けるんですね。'),
        hakase('うむ。ログを書くのはエージェントだから、ロールに logs:PutLogEvents などの許可が要る。CloudWatchAgentServerPolicy に入っておるから、今日はそのままでよい。'),
        hakase('新しい設定が使われるのは、保存したあとに開始したセッションからだ。今回は web-1 で試すのだ。なぜ batch-1 ではないのかは、最後に問題を出す。'),
        node('うわ、いやな予告だ…'),
      ],
    },
    {
      type: 'exercise',
      title: 'セッションの操作を記録する',
      objective: `セッションマネージャーの設定で CloudWatch のログ記録を有効にし (ロググループ \`${SESSION_LOG_GROUP}\`、ストリーム)、web-1 とのセッションで \`hostname\` を実行して、そのログを CloudWatch Logs で確かめる`,
      tasks: [
        { id: 'prefs', title: 'セッションマネージャー > 「設定」 タブ → 「編集」 → CloudWatch のログ記録を 「有効にする」 → 「セッションログのストリーム」、ロググループ `/ssm/session-logs` → 「保存」', hint: '「暗号化された CloudWatch ロググループのみを許可する」はオフのままにします (このロググループは暗号化されていません)。', hotspotId: 'ssm-prefs-edit', done: (c) => preferencesOf(c.env).cloudWatchLogGroupName === SESSION_LOG_GROUP },
        { id: 'run', title: '`web-1` とのセッションを開始し、`hostname` を実行', hint: '設定を保存したあとに開始したセッションだけがログに残ります。', hotspotId: 'ssm-start-session', done: (c) => loggedEvents(c.env).some((e) => e.message.includes('hostname')) },
        { id: 'view', title: `CloudWatch > ロググループ → \`${SESSION_LOG_GROUP}\` → セッション ID のログストリームを開く`, hint: 'セッション履歴の「出力の場所」のリンクからも開けます (終了したセッションのみ)。', done: (c) => visitedQuery(c, '/cloudwatch/logs/events', { group: SESSION_LOG_GROUP }) },
      ],
      validate: (c) => {
        if (preferencesOf(c.env).cloudWatchLogGroupName !== SESSION_LOG_GROUP) return ng(hakase(`まだログの送り先が決まっておらん。セッションマネージャーの「設定」タブで「編集」を押し、CloudWatch のログ記録を有効にして ${SESSION_LOG_GROUP} を選ぶのだ。`));
        if (!loggedEvents(c.env).some((e) => e.message.includes('hostname')))
          return ng(hakase('ロググループに hostname の記録がない。設定を保存してから web-1 との「新しい」セッションを開始して、hostname を打つのだ。batch-1 でやっても、ログは届かんぞ。'));
        if (!visitedQuery(c, '/cloudwatch/logs/events', { group: SESSION_LOG_GROUP })) return ng(hakase(`記録はできた。CloudWatch のロググループ ${SESSION_LOG_GROUP} を開き、セッション ID のログストリームを見るのだ。`));
        return ok(
          node('JSON で出てます。`sessionData` に `sh-5.2$ hostname` と結果、`userIdentity` に僕の ARN、`runAsUser` が ssm-user。'),
          hakase('誰が、どのインスタンスで、何を打って、何が返ったか。監査に聞かれて困ることは、もう何もない。'),
          node('僕が変なコマンドを打っても、全部バレるってことですね。'),
          hakase('そういうことだ。言い訳を考える時間が省けて、よかったな。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('最後の仕上げだ。22 番を閉じる。web-sg にはオフィスからの SSH、batch-sg には web-sg からの SSH が残っておる。'),
        node('batch-sg のほうは、web-1 を踏み台にして batch-1 に入るためのルールですよね。踏み台は Lesson 06 で出てきた、中のサーバーに入るための中継サーバー。'),
        hakase('そうだ。セッションマネージャーがあれば、踏み台も要らん。2 つのルールを消すのだ。'),
        node('消したとたんに入れなくなったりしませんよね…？ Lesson 26 の悪夢が。'),
        hakase('エージェントはインバウンドのルールを使っておらん。確かめるために、消したあとでもう一度 batch-1 に入ってみろ。'),
        node('閉めてから入れることを確かめる。泥棒が聞いたら泣きますね。'),
      ],
    },
    {
      type: 'exercise',
      title: '22 番を閉じる',
      objective: '`web-sg` と `batch-sg` のインバウンドルールから SSH (22) を削除し、そのあと `batch-1` とのセッションでコマンドを実行する',
      tasks: [
        { id: 'web', title: '`web-sg` のインバウンドルールから SSH (`198.51.100.24/32`) を削除 → 「ルールを保存」', hint: 'EC2 > セキュリティグループ → web-sg → 「インバウンドのルールを編集」。HTTP (80) のルールは残します。', hotspotId: 'sg-save-rules', done: (c) => !!sgNamed(c.env, 'web-sg') && !port22Open(c.env, 'web-sg') },
        { id: 'batch', title: '`batch-sg` のインバウンドルールから SSH (web-sg から) を削除 → 「ルールを保存」', hint: 'ルールが 1 つもなくなっても構いません。セキュリティグループは許可だけを書くものなので、空なら何も入れません。', hotspotId: 'sg-save-rules', done: (c) => !!sgNamed(c.env, 'batch-sg') && !port22Open(c.env, 'batch-sg') },
        { id: 'session', title: '`batch-1` とのセッションを開始し、`hostname` を実行', hint: '22 番を閉じたあとに開始したセッションで確かめます。', hotspotId: 'ssm-start-session', done: (c) => !port22Open(c.env, 'web-sg') && !port22Open(c.env, 'batch-sg') && ranInSession(c, 'batch-1', /^\s*hostname/, lastRevoke(c.env)) },
      ],
      validate: (c) => {
        if (port22Open(c.env, 'web-sg') || port22Open(c.env, 'batch-sg')) return ng(hakase('まだ 22 番を許可しているルールが残っておる。web-sg と batch-sg の「インバウンドのルールを編集」で、SSH のルールを削除するのだ。'));
        if (!sgNamed(c.env, 'web-sg')?.ingress.some((r) => ruleMatchesTraffic(r, 'tcp', 80))) return ng(hakase('待て、web-sg の HTTP (80) まで消えておる。それではお客さんがサイトを見られん。HTTP のルールは戻すのだ。'));
        if (!ranInSession(c, 'batch-1', /^\s*hostname/, lastRevoke(c.env))) return ng(hakase('22 番は閉じた。そのあとで batch-1 とのセッションを開始して、hostname を打つのだ。閉じる前のセッションは数えんぞ。'));
        return ok(
          node('入れました！ 22 番が閉じていても、batch-1 のシェルが普通に動きます。'),
          hakase('玄関は全部閉めた。入るときはセッションマネージャー、入った記録は CloudWatch Logs と CloudTrail。監査への回答書は、これで書ける。'),
          node('回答書は僕が書きます。……博士の分の始末書も、ついでに書いておきましょうか？'),
          hakase('ワシは何もやらかしておらん。君の給料から代筆料を引いておく。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。セッションマネージャーでインスタンスに入るとき、インスタンスのセキュリティグループのインバウンドルールには何が必要かな？'),
      options: ['SSH (TCP 22) の許可', 'HTTPS (TCP 443) の許可', 'セッションのためのインバウンドルールは要らない'],
      answer: 2,
      explanation: [
        hakase('正解。通信を始めるのは、インスタンスの中の SSM Agent だ。外向きに HTTPS で接続し、その回線の上でセッションが動く。'),
        node('セキュリティグループはステートフルだから、戻りの通信もそのまま通るんですよね。'),
        hakase('うむ。443 の許可が要るのは、インターフェイスエンドポイントの ENI のほうだ。取り違えるでないぞ。'),
      ],
      wrong: [hakase('通信を始めるのは誰か、を思い出すのだ。電話をかけているのは、サーバーの中のエージェントのほうだったな。')],
    },
    {
      type: 'quiz',
      question: hakase('プライベートサブネットの batch-1 は、NAT ゲートウェイなしでマネージドノードになれた。何のおかげかな？'),
      options: ['S3 のゲートウェイエンドポイント', 'プライベート DNS 名を有効にした ssm / ssmmessages / ec2messages のインターフェイスエンドポイント', 'batch-1 のパブリック IP アドレス'],
      answer: 1,
      explanation: [
        hakase('正解。VPC の中では、ssm.ap-northeast-1.amazonaws.com などの名前がエンドポイントの ENI のプライベート IP に変わる。だからエージェントは、インターネットに出ずに Systems Manager に接続できる。'),
        node('プライベート DNS 名を無効にしたら、名前はインターネットの住所のままだから、届かないんですね。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('予告どおりの問題だ。batch-1 とのセッションでもログを CloudWatch Logs にストリーミングしたい。今のままでは記録が届かん。何が足りないかな？'),
      options: ['batch-1 から CloudWatch Logs に届く通り道 (com.amazonaws.ap-northeast-1.logs のインターフェイスエンドポイント)', 'ssm-user にロググループへの書き込み権限を付けること', 'セッションの理由を入力すること'],
      answer: 0,
      explanation: [
        hakase('正解。ログを送るのも、インスタンスの中のエージェントだ。web-1 はインターネット経由で CloudWatch Logs に届くが、batch-1 には logs の窓口への道がない。'),
        node('ロールの許可はもうあるから、logs のインターフェイスエンドポイントを足せば届く、と。'),
        hakase('そうだ。エンドポイントは「そのサーバーが話す相手の数だけ」要る。今日の教訓だ。'),
      ],
      wrong: [hakase('ログを CloudWatch Logs に送っているのは誰か、そしてそれはどこを通るのかを考えるのだ。web-1 と batch-1 の違いはどこにあった？')],
    },
  ],
};

/** shared with the CLI version (src/lessons/cli/l46-session-manager.ts) */
export const l46 = { idOf, online, agentAllowed, endpoint, httpsFromBatch, sessionsOn, ranInSession, whoamiSsmUser, loggedEvents, port22Open, lastRevoke, ENDPOINT_SERVICES };
