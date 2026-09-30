import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { ruleCompliance } from '../sim/config';
import { eicConnectivity } from '../sim/network';
import { auditEnv, SHARE_BUCKET, sshRevokedEnv } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { albReachesWeb, instanceNamed, lastRun, sgAllows, sgNamed, visited, visitedQuery } from './helpers';

const batchId = (env: AwsEnv) => instanceNamed(env, 'batch-1')?.instanceId ?? '-';
const batchSg = (env: AwsEnv) => sgNamed(env, 'batch-sg')?.groupId ?? '-';
const revokeEvent = (env: AwsEnv) => env.trailEvents.find((e) => e.eventName === 'RevokeSecurityGroupIngress' && e.userIdentity.userName === 'tanaka');
const openedEvent = (c: TaskContext, pick: (id: string) => boolean) => c.visited.some((v) => v.startsWith('/cloudtrail/events/view?') && pick(new URLSearchParams(v.split('?')[1]).get('id') ?? ''));
const EIC_IP = '3.112.23.1';
const rule = (env: AwsEnv, name: string) => env.configRules.find((r) => r.configRuleName === name);
const compliant = (env: AwsEnv, name: string) => {
  const r = rule(env, name);
  return !!r && ruleCompliance(env, r).compliance === 'COMPLIANT';
};

export const lesson26: Lesson = {
  id: 'ssh-revoked',
  number: '26',
  title: '昨日から EC2 に接続できない: CloudTrail で変更を追う',
  summary: 'イベント履歴から RevokeSecurityGroupIngress を見つけ、消されたルールを記録どおりに戻す',
  minutes: 25,
  startPath: '/ec2/instances',
  scenario: sshRevokedEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、batch-1 に EC2 Instance Connect で入れなくなりました。昨日の昼までは普通に使えてたのに…'),
        hakase('ほう。昨日までは入れて、今日は入れない、と。'),
        node('先に言っておきますけど、僕は何も触ってないですよ！'),
        hakase('誰もまだ君を疑っておらん。……今のところはな。'),
        node('「今のところ」を付けないでください。'),
        hakase('サーバーは気分で設定を変えたりせん。「昨日まで動いていたものが今日動かない」なら、たいてい**誰かが何かを変えた**のだ。'),
        node('気分屋なのは人間のほう、ってことですね。'),
        hakase('そういうことだ。ところで EC2 Instance Connect は覚えておるか。'),
        node('Lesson 22 で batch-1 に入ったときに使ったやつですよね。ボタンを押すと、ブラウザにターミナルが開く。'),
        hakase('うむ。あれも中身は **SSH** だ。サーバーに遠隔でログインするための通信で、TCP の **22 番**ポートを使う。'),
        node('えすえすえいち、22 番。Lesson 01 のクイズで「全世界から SSH できる状態」って出てきたやつですね。'),
        hakase('そうだ。どんなに正しい鍵を持っていても、玄関のドア、つまりセキュリティグループが 22 番を通さなければ入れん。まずは症状を自分の目で確かめる。推測はそのあとだ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('でも「誰かが変えた」って、どうやって突き止めるんです？ チーム全員に「やりました？」って聞いて回るとか？'),
        hakase('それで正直に名乗り出る人間ばかりなら、世の障害報告書はもっと薄くなっておる。'),
        hakase('そこで **CloudTrail** だ。AWS に対する操作を「誰が・いつ・何をしたか」、1 件ずつ記録しておるサービスだ。'),
        node('くらうどとれいる？ トレイルって、山道のことですか。'),
        hakase('trail は「通った跡」「足跡」という意味だ。AWS の中を歩いた足跡が全部残る、と覚えておけ。'),
        node('防犯カメラみたいですね。'),
        hakase('良いたとえだ。AWS への操作は、すべて **API** の呼び出しで行われる。API とは、AWS に命令を出すための窓口だ。'),
        node('えーぴーあい？ 僕、コンソールでボタンを押してるだけですけど。'),
        hakase('そのボタンも、裏では API を呼んでおる。Lesson 22 で打った `aws` コマンド (CLI) も同じ API だ。どちらから呼んでも、CloudTrail には **イベント** として同じように記録される。'),
        node('つまり、コンソールで押しても CLI で打っても、足跡の残り方は同じってことですね。'),
        hakase('そうだ。……足跡を消す方法はないのか、という顔をしておるな。'),
        node('してません！'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('記録を探すのは、CloudTrail の **イベント履歴** という画面だ。このリージョンで過去 90 日間に行われた操作が、新しい順に並んでおる。'),
        node('90 日… 3 か月前の僕のやらかしも残ってるってことですか。'),
        hakase('残念ながら全部だ。件数が多いから、**ルックアップ属性** で絞り込む。「ユーザー名」「イベント名」「リソース名」などから 1 つ選んで、値を入れるのだ。'),
        node('るっくあっぷ… look up は「調べる」ですよね。検索の条件ってことか。'),
        hakase('そうだ。今日は「batch-sg に何が起きたか」を知りたいから、「リソース名」にセキュリティグループの ID (`sg-…`) を入れる。値は完全一致だ。1 文字違えば何も出ん。'),
        node('並んだイベントの名前は、どう読めばいいんです？'),
        hakase('イベント名は API の名前そのものだ。たとえば **AuthorizeSecurityGroupIngress** は、Authorize (許可する) + SecurityGroup + Ingress (入ってくる通信、つまりインバウンド)。'),
        node('「インバウンドルールを追加した」ってことですね。じゃあ、ルールを消したら？'),
        hakase('**RevokeSecurityGroupIngress**。Revoke は「取り消す」だ。今日の手がかりは、たぶんそいつだ。'),
        node('イベントをクリックすると、何が見えるんですか。'),
        hakase('**イベントレコード** という JSON だ。Lesson 21 のバケットポリシーと同じ書き方だな。誰が (`userIdentity`)、いつ (`eventTime`)、どこから (`sourceIPAddress`)、何を使って (`userAgent`)、どんな指定で (`requestParameters`) 呼んだかが書いてある。'),
        node('誰が、いつ、どこから、何で、どうした。僕の日報より詳しいじゃないですか。'),
      ],
    },
    {
      type: 'exercise',
      title: 'EC2 Instance Connect で接続してみる',
      objective: '`batch-1` に EC2 Instance Connect で接続し、どんなエラーになるか確認する',
      tasks: [{ id: 'try', title: 'インスタンス一覧で `batch-1` を選び **接続** → EC2 Instance Connect の **接続**', hint: '`batch-1` にチェックを付けると、一覧上部の **接続** が押せます。つながらなくても、表示されたエラーメッセージを読めば完了です。', hotspotId: 'ec2-connect-submit', done: (c) => visited(c, `/ec2/instances/${batchId(c.env)}/terminal`) }],
      validate: (c) =>
        visited(c, `/ec2/instances/${batchId(c.env)}/terminal`)
          ? ok(
              node('「Failed to connect to your instance」… SSH の接続を確立できない、だそうです。'),
              hakase('EC2 Instance Connect は、君のブラウザから直接入るのではない。**AWS のサービスが持つ IP アドレス範囲** (東京リージョンは `3.112.23.0/29`) から、SSH (TCP 22) でインスタンスに入るのだ。'),
              node('`/29` って Lesson 04 の CIDR ですよね。`/28` が 16 個だったから、`/29` はその半分の 8 個。'),
              hakase('ほう、正解だ。明日は雪か。セキュリティグループがその 8 個からの 22 番を許可していなければ、つながらん。次はそこを確かめる。'),
            )
          : ng(hakase('まずは batch-1 に EC2 Instance Connect で接続してみるのだ。インスタンス一覧で `batch-1` を選んで **接続** → EC2 Instance Connect タブの **接続** だ。')),
    },
    {
      type: 'exercise',
      title: 'セキュリティグループを確認する',
      objective: '`batch-1` のセキュリティグループ `batch-sg` のインバウンドルールを確認する',
      tasks: [{ id: 'sg', title: 'EC2 > セキュリティグループ → `batch-sg` のインバウンドルール', hint: 'インスタンス詳細の「セキュリティ」タブからもリンクがあります。', done: (c) => visited(c, `/ec2/security-groups/${batchSg(c.env)}`) || visited(c, `/vpc/security-groups/${batchSg(c.env)}`) }],
      validate: (c) =>
        visited(c, `/ec2/security-groups/${batchSg(c.env)}`) || visited(c, `/vpc/security-groups/${batchSg(c.env)}`)
          ? ok(
              node('SSH のルールは `198.51.100.24/32` (オフィス) の 1 つだけです。EC2 Instance Connect の範囲がありません！'),
              hakase('`/32` はアドレス 1 個ぴったり。つまり今は、オフィスからしか入れんわけだ。'),
              node('でも昨日までは入れたんだから、昨日までは誰かが EC2 Instance Connect の範囲も許可してたはずですよね。'),
              hakase('そうだ。いつ、誰が、何を消したのか。当てずっぽうで犯人探しをする前に、CloudTrail で**事実**を確かめよう。'),
            )
          : ng(hakase('batch-sg のインバウンドルールを開くのだ。インスタンスの詳細の「セキュリティ」タブに、セキュリティグループへのリンクがある。')),
    },
    {
      type: 'exercise',
      title: 'CloudTrail で変更を探す',
      objective: 'CloudTrail の **イベント履歴** をルックアップ属性「リソース名」= `batch-sg` のグループ ID で絞り込み、`RevokeSecurityGroupIngress` のイベントを開く',
      tasks: [
        { id: 'lookup', title: '検索バーで `cloudtrail` → **イベント履歴** → 「リソース名」に `sg-…` を入力して Enter', hint: 'セキュリティグループ ID はコピーボタンでコピーできます。値は完全一致です。', hotspotId: 'ct-lookup', done: (c) => visitedQuery(c, '/cloudtrail/events', { attr: 'ResourceName', value: batchSg(c.env) }) || visitedQuery(c, '/cloudtrail/events', { attr: 'EventName', value: 'RevokeSecurityGroupIngress' }) },
        { id: 'open', title: '`RevokeSecurityGroupIngress` をクリックしてイベントレコードを読む', hint: '一覧の「イベント名」列のリンクをクリックします。イベントレコードの `userIdentity`・`eventTime`・`requestParameters` を読みます。', done: (c) => openedEvent(c, (id) => id === revokeEvent(c.env)?.eventId) },
      ],
      validate: (c) =>
        openedEvent(c, (id) => id === revokeEvent(c.env)?.eventId)
          ? ok(
              node('昨日 18:42 に **tanaka** さんが `RevokeSecurityGroupIngress` を実行してます。userAgent が `aws-cli/…` なので、コンソールじゃなくて CLI からですね。'),
              hakase('requestParameters を見ると、消されたのは `3.112.23.0/29` の TCP 22、説明は「EC2 Instance Connect」。使っていないルールを整理するつもりだったのだろう。'),
              node('犯人がわかりました！ tanaka さんに始末書を……'),
              hakase('始末書で次の事故が防げるなら、ワシの机の引き出しはとっくに空だ。**人を責めるのではなく、記録で事実を確かめる**。これが調査の基本だ。'),
              node('今やるべきなのは、消されたルールを記録どおりに戻すこと、ですね。'),
            )
          : ng(hakase('RevokeSecurityGroupIngress のイベントを開いて、中身を読むのだ。ルックアップ属性を「リソース名」にして batch-sg の ID (`sg-…`) を貼り付ければ、一覧に出てくる。')),
    },
    {
      type: 'exercise',
      title: '消されたルールを元に戻す',
      objective: '`batch-sg` のインバウンドルールに、イベントレコードに残っていたルール (SSH / `3.112.23.0/29` / 説明 `EC2 Instance Connect`) を追加する',
      tasks: [{ id: 'add', title: '`batch-sg` → インバウンドルールを編集 → ルールを追加 → **ルールを保存**', hint: 'タイプ「SSH」、ソース「カスタム」に `3.112.23.0/29`。', hotspotId: 'sg-save-rules', done: (c) => sgAllows(c.env, 'batch-sg', 22, { ip: EIC_IP }) }],
      validate: (c) => {
        if (sgAllows(c.env, 'batch-sg', 22, { ip: '192.0.2.200' })) return ng(hakase('待て、SSH を 0.0.0.0/0 (全世界) に開けてはいかん！ 世界中のボットが 22 番を叩きに来るぞ。ソースは EC2 Instance Connect の範囲 `3.112.23.0/29` だけにするのだ。'));
        if (!sgAllows(c.env, 'batch-sg', 22, { ip: EIC_IP })) return ng(hakase('まだ `3.112.23.0/29` からの SSH が許可されていない。タイプ「SSH」、ソース「カスタム」に `3.112.23.0/29` を入れて、**ルールを保存** するのだ。'));
        return ok(
          hakase('よし。消えたものを、消える前と同じ形で戻せた。'),
          node('記録にルールの中身まで残ってたから、「とりあえず全開放」にしなくて済んだんですね。'),
          hakase('そうだ。推測で広く開けるのは、鍵をなくしたからといって玄関のドアを外すようなものだ。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '接続を確認する',
      objective: 'もう一度 EC2 Instance Connect で `batch-1` に接続し、`whoami` を実行する',
      tasks: [{ id: 'whoami', title: 'ターミナルで `whoami`', hint: 'エラー画面が出ていたら「再試行」を押します。', hotspotId: 'terminal-input', done: (c) => !!lastRun(c, 'batch-1', /^\s*whoami/)?.ok }],
      validate: (c) =>
        lastRun(c, 'batch-1', /^\s*whoami/)?.ok && eicConnectivity(c.env, batchId(c.env)).ok
          ? ok(
              node('`ec2-user` と出ました！ つながりました。'),
              hakase('`whoami` は「私は誰？」に答えるコマンドだ。`ec2-user` は、Amazon Linux に最初から用意されているログイン用のユーザーだな。'),
              node('自分が誰かわからなくなったら、僕も打ってみます。'),
              hakase('君の場合、返ってくるのは「新人」だろうがな。'),
            )
          : ng(hakase('まだ whoami が成功していない。ターミナルがエラー画面のままなら「再試行」を押して、つながったら `whoami` と打つのだ。')),
    },
    {
      type: 'exercise',
      title: '自分の操作も記録されている',
      objective: 'イベント履歴で、ユーザー名 `learner` の `AuthorizeSecurityGroupIngress` イベントを開く',
      tasks: [{ id: 'mine', title: 'イベント履歴 → 自分の `AuthorizeSecurityGroupIngress` を開く', hint: 'ルックアップ属性「ユーザー名」= `learner` で絞り込めます。', done: (c) => openedEvent(c, (id) => c.env.trailEvents.some((e) => e.eventId === id && e.eventName === 'AuthorizeSecurityGroupIngress' && e.userIdentity.userName === 'learner')) }],
      validate: (c) =>
        openedEvent(c, (id) => c.env.trailEvents.some((e) => e.eventId === id && e.eventName === 'AuthorizeSecurityGroupIngress' && e.userIdentity.userName === 'learner'))
          ? ok(
              node('さっきの自分の操作が、ユーザー名 learner、userAgent「AWS Internal」(コンソールから) で記録されています。'),
              hakase('CloudTrail は、誰の操作も同じように記録する。新人でも、管理者でも、ワシでもだ。'),
              node('博士の操作も残るんですね。今度じっくり見ておきます。'),
              hakase('……だから障害調査にも、セキュリティ監査にも使えるのだ。余計なところは見んでよい。'),
            )
          : ng(hakase('learner の AuthorizeSecurityGroupIngress イベントを開くのだ。イベント履歴でルックアップ属性を「ユーザー名」、値を `learner` にして絞り込めばよい。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。「誰が・いつ・どの API を・どのリソースに」実行したかを調べるサービスはどれかな？'),
      options: ['CloudWatch', 'CloudTrail', 'AWS Config'],
      answer: 1,
      explanation: [
        hakase('正解。CloudWatch は「数値やログで今どうなっているか」、CloudTrail は「誰が何をしたか」だ。'),
        node('AWS Config は何なんです？'),
        hakase('「設定がルールどおりか」を調べる健康診断係だ。次の Lesson 27 でやる。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('リソースを作る・変える・消すといった操作の記録を **管理イベント** という。では、CloudTrail の「イベント履歴」で見られるのは、どのくらい前までの管理イベントかな？'),
      options: ['7 日', '90 日', '無期限'],
      answer: 1,
      explanation: [
        hakase('正解。それより長く残したり、まとめて分析したりするには **証跡 (Trail)** を作って、イベントを S3 のバケットに届け続ける。'),
        node('証跡がないと、91 日前の事故は迷宮入りってことですね。'),
        hakase('そうだ。だから本番アカウントでは、最初に証跡を作っておくのが鉄則だ。事故が起きてから作っても、過去の足跡は 1 つも増えん。'),
      ],
    },
  ],
};

export const lesson27: Lesson = {
  id: 'config-audit',
  number: '27',
  title: 'AWS Config で非準拠を見つけて直す',
  summary: 'ルールで設定を自動チェックし、非準拠の原因をタイムラインと CloudTrail でたどって直す',
  minutes: 25,
  startPath: '/console/home',
  scenario: auditEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、セキュリティ監査で「全部の設定がルールどおりかチェックして」と言われました。リソースが多すぎて、目で見るのは無理です…'),
        hakase('全部を目で見るつもりだったのか。君の目が 2 つしかないことを、監査の担当者は知らんのだな。'),
        node('4 つあっても無理ですよ。'),
        hakase('それは **AWS Config** の仕事だ。リソースの設定を記録し続けて、決めておいた**ルール**どおりかを自動でチェックしてくれる。'),
        node('こんふぃぐ？ configuration、「設定」の略ですよね。'),
        hakase('そうだ。設定の番人だな。たとえば「SSH を全世界 (`0.0.0.0/0`) に開けていないか」「S3 バケットを誰でも読める状態にしていないか」といったルールで調べる。'),
        node('`0.0.0.0/0` は Lesson 09 で出てきた Anywhere、全部のアドレスでしたよね。'),
        hakase('ほう、覚えておったか。君の記憶も、たまには不揮発性になるのだな。'),
        node('たまにって言わないでください。で、ルールに合ってるかどうかは、どうわかるんです？'),
        hakase('評価の結果は 2 つ。ルールどおりなら **準拠 (COMPLIANT)**、違反していれば **非準拠 (NON_COMPLIANT)** だ。'),
        node('じゅんきょ… 要するに「合格」と「不合格」ですね。'),
        hakase('うむ。しかも設定が変わるたびに、Config は勝手に採点し直す。休みも取らず、袖の下も効かん試験官だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ルールって、全部自分で書かないといけないんですか？'),
        hakase('よくあるものは AWS が用意しておる。**AWS マネージドルール** という。一覧から選んで追加するだけだ。'),
        node('まねーじど… Lesson 14 で RDS を「マネージドな MySQL」って言ってましたよね。AWS が面倒を見てくれるってやつ。'),
        hakase('その「マネージド」だ。このアカウントには、もう 3 つ入っておる。まず `restricted-ssh`。SSH の全開放を禁止するルールだ。'),
        node('restricted は「制限された」ですね。'),
        hakase('次に `s3-bucket-public-read-prohibited`。prohibited は「禁止された」。バケットを誰でも読める状態にするのを禁止する。'),
        node('Lesson 21 でブロックパブリックアクセスを緩めて、バケットポリシーで公開したやつ。あれをやると引っかかるんですね。'),
        hakase('そうだ。3 つ目の `rds-instance-public-access-check` は、RDS がインターネットから直接つながる設定になっていないかを見る。'),
        node('Lesson 14 の「パブリックアクセス なし」ですね。'),
        hakase('そして最後に、君にもう 1 つ `rds-storage-encrypted` を追加してもらう。RDS のディスクが**暗号化**されているかを見るルールだ。'),
        node('あんごうか？'),
        hakase('鍵を持つ者にしか読めない形でデータを保存することだ。ディスクを盗まれても、中身は読めん。……ルールは増やすほど評価の料金がかかるから、面白がって全部足すでないぞ。'),
      ],
    },
    {
      type: 'table',
      title: '運用で使い分ける 3 つのサービス',
      columns: ['サービス', '答えてくれる問い', '例'],
      rows: [
        ['CloudWatch', '今どうなっている？ (数値・ログ)', 'CPU 95%、応答時間 2 秒'],
        ['CloudTrail', '誰が・いつ・何をした？', 'tanaka が昨日 RevokeSecurityGroupIngress'],
        ['AWS Config', '設定はルールどおり？ いつから変わった？', 'restricted-ssh が NON_COMPLIANT'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('CloudWatch、CloudTrail、Config… 名前が似てて、頭の中で混ざりそうです。'),
        hakase('役割で覚えろ。CloudWatch は Lesson 24 でやった「今どうなっている？」を数字で見る**体温計**だ。'),
        node('CloudTrail は Lesson 26 の「誰が・いつ・何をした？」を残す**防犯カメラ**でしたよね。'),
        hakase('そして Config は「設定はルールどおりか？」を調べる**健康診断**だ。'),
        node('表には「いつから変わった？」ともありますね。'),
        hakase('Config は設定を記録し続けておるから、リソースごとに**タイムライン** (設定の変更の年表) が見られる。しかも、その変更を起こした CloudTrail のイベントにもつながっておる。'),
        node('健康診断の結果に、防犯カメラの映像が添付されてくるってことですか。'),
        hakase('そういうことだ。言い逃れは一切できん。まずは**ダッシュボード**で、非準拠がいくつあるか見てみよう。'),
        node('だっしゅぼーど… 車の運転席の、メーターが並んでるところですよね。'),
        hakase('そうだ。全体の状況が一目でわかる画面のことだ。スピード違反も一目でわかる。'),
      ],
    },
    {
      type: 'exercise',
      title: 'Config のダッシュボードを見る',
      objective: 'AWS Config の **ダッシュボード** で非準拠のルールを確認する',
      tasks: [{ id: 'dash', title: '検索バーで `config` → **AWS Config** → ダッシュボード', hint: 'AWS Config を開くと最初にダッシュボードが表示されます。「非準拠ルール」の一覧に注目します。', done: (c) => visited(c, '/config/home') }],
      validate: (c) =>
        visited(c, '/config/home')
          ? ok(
              node('非準拠のルールが 2 つあります。'),
              hakase('`restricted-ssh` と `s3-bucket-public-read-prohibited` だな。健康診断で 2 項目、要再検査だ。'),
              node('放っておくと、監査で呼び出されるやつですね。1 つずつ見ていきましょう。'),
            )
          : ng(hakase('Config のダッシュボードを開くのだ。検索バーで `config` と打てば **AWS Config** が出てくる。')),
    },
    {
      type: 'exercise',
      title: '非準拠のリソースと、その変更履歴を調べる',
      objective: 'ルール `restricted-ssh` を開き、非準拠のリソースのタイムライン (CloudTrail イベント) を確認する',
      tasks: [
        { id: 'rule', title: '**ルール** → `restricted-ssh` を開く', hint: 'AWS Config の左メニュー「ルール」を開きます。「検出結果の準拠状況」列で、非準拠のリソースの数がわかります。', done: (c) => visitedQuery(c, '/config/rules/view', { name: 'restricted-ssh' }) },
        { id: 'timeline', title: '非準拠のリソース ID (`sg-…`) をクリックしてタイムラインを開く', hint: 'ルールの詳細の下にある「対象範囲内のリソース」の「ID」列のリンクです。タイムラインでは「CloudTrail イベント」の欄で、誰がいつ変更したかを見ます。', done: (c) => visitedQuery(c, '/config/resources/view', { id: sgNamed(c.env, 'web-sg')?.groupId ?? '-' }) },
      ],
      validate: (c) =>
        visitedQuery(c, '/config/resources/view', { id: sgNamed(c.env, 'web-sg')?.groupId ?? '-' })
          ? ok(
              node('web-sg に 0.0.0.0/0 の SSH が追加されてて、昨日 tanaka さんが AuthorizeSecurityGroupIngress を実行してます。説明は「temporary debug」…'),
              hakase('「一時的なつもりで開けて、閉じ忘れる」。よくある話だ。この世で一番長生きする設定は、「一時的」と書かれた設定だ。'),
              node('Config が「今の状態がルール違反」だと教えてくれて、CloudTrail が「誰がいつそうしたか」を教えてくれた、ってことですね。'),
              hakase('そうだ。2 つを組み合わせて使うのだ。'),
            )
          : ng(hakase('restricted-ssh の非準拠リソースのタイムラインを開くのだ。**ルール** → `restricted-ssh` を開いて、非準拠のリソース ID (`sg-…`) をクリックする。')),
    },
    {
      type: 'exercise',
      title: 'SSH の全開放を閉じる',
      objective: '`web-sg` から 0.0.0.0/0 の SSH ルールを削除して `restricted-ssh` を準拠にする。ALB からの TCP 3000 は残すこと',
      tasks: [{ id: 'fix', title: '`web-sg` → インバウンドルールを編集 → SSH のルールを **削除** → ルールを保存', hint: 'EC2 > セキュリティグループで `web-sg` を開きます。編集画面では、ソースが `0.0.0.0/0` でポート 22 の行の **削除** だけを押します。', hotspotId: 'sg-save-rules', done: (c) => compliant(c.env, 'restricted-ssh') }],
      validate: (c) => {
        if (!albReachesWeb(c.env)) return ng(hakase('ALB からの 3000 番まで消してしまったぞ！ これではサイトが止まる。ソースが `alb-sg` の TCP 3000 のルールを戻すのだ。消すのは SSH (22 番) の行だけだ。'));
        return compliant(c.env, 'restricted-ssh')
          ? ok(
              node('restricted-ssh が「準拠」になりました！ サイトも止まってません。'),
              hakase('Config のルールは、設定が変わるたびに評価される。直せばすぐ結果に出るのだ。'),
              node('健康診断なのに、結果が出るのが早すぎますね。'),
              hakase('君の始末書も、このくらい早く出てくればよいのだがな。'),
            )
          : ng(hakase('まだ web-sg が 0.0.0.0/0 からの SSH を許可しておる。インバウンドルールの編集で、SSH の行の **削除** を押してから **ルールを保存** するのだ。'));
      },
    },
    {
      type: 'exercise',
      title: '公開バケットを非公開に戻す',
      objective: `\`${SHARE_BUCKET}\` のブロックパブリックアクセスを **すべてオン** にして、\`s3-bucket-public-read-prohibited\` を準拠にする`,
      tasks: [{ id: 'bpa', title: 'S3 → バケット → アクセス許可 → ブロックパブリックアクセスの **編集** → すべてオン → 保存', hint: '`webapp-share-…` の編集画面で「パブリックアクセスをすべて ブロック」にチェックを入れると、4 つがまとめてオンになります。**変更の保存** の後、ダイアログに「確認」と入力します。', hotspotId: 's3-edit-bpa', done: (c) => compliant(c.env, 's3-bucket-public-read-prohibited') }],
      validate: (c) =>
        compliant(c.env, 's3-bucket-public-read-prohibited')
          ? ok(
              node('`s3-bucket-public-read-prohibited` も準拠になりました。でも名前からして、取引先とファイルを共有したくて公開したんですよね…'),
              hakase('そういうときは、バケットを公開するのではなく**署名付き URL** を使う。'),
              node('しょめいつき？'),
              hakase('期限付きの許可が埋め込まれた URL だ。その URL を知っている人だけが、期限まで、そのファイルだけをダウンロードできる。誰でも持っていける街頭のチラシではなく、宛名入りの招待状だな。'),
            )
          : ng(hakase('まだバケットが誰でも読める状態だ。S3 で `webapp-share-…` の **アクセス許可** タブを開き、ブロックパブリックアクセスの **編集** で 4 つすべてをオンにして保存するのだ。')),
    },
    {
      type: 'exercise',
      title: 'ルールを追加する',
      objective: 'AWS マネージドルール `rds-storage-encrypted` を追加し、RDS の暗号化を評価する',
      tasks: [{ id: 'add', title: '**ルール** → **ルールを追加** → `rds-storage-encrypted` を選択 → 次へ → 次へ → **ルールを保存**', hint: '「AWS マネージドルール」の一覧で `rds-storage-encrypted` の行を選ぶと、名前は自動で入ります。ステップ 2 の「詳細」は変えずに進めます。', hotspotId: 'config-add-rule', done: (c) => c.env.configRules.some((r) => r.identifier === 'RDS_STORAGE_ENCRYPTED') }],
      validate: (c) => {
        const r = c.env.configRules.find((x) => x.identifier === 'RDS_STORAGE_ENCRYPTED');
        if (!r) return ng(hakase('rds-storage-encrypted がまだ追加されていない。**ルール** → **ルールを追加** で、一覧から `rds-storage-encrypted` を探して選ぶのだ。'));
        return ruleCompliance(c.env, r).compliance === 'COMPLIANT'
          ? ok(
              node('webapp-db は「準拠」でした。ちゃんと暗号化されてるんですね。'),
              hakase('運が良かったな。RDS の暗号化は**作成するときにしか選べない**。'),
              node('え、あとから「暗号化オン」にできないんですか。'),
              hakase('できん。あとから暗号化するには、スナップショットを取り、暗号化してコピーし、そこから新しい DB を作り直す。スナップショットそのものは、次の Lesson 28 でやるぞ。'),
            )
          : ng(hakase('評価結果を確認するのだ。**ルール** → `rds-storage-encrypted` を開いて、webapp-db の準拠状況を見る。'));
      },
    },
    {
      type: 'quiz',
      question: hakase('では確認だ。AWS Config のルールで分かるのはどれかな？'),
      options: ['誰がいつリソースを変更したか', '今のリソースの設定がルールに準拠しているか', 'CPU 使用率の推移'],
      answer: 1,
      explanation: [
        hakase('正解。「誰がいつ」は CloudTrail、「推移」は CloudWatch だ。'),
        node('健康診断が Config、防犯カメラが CloudTrail、体温計が CloudWatch ですね。'),
        hakase('うむ。そして Config のタイムラインからは、変更に対応する CloudTrail イベントにもたどれる。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('月曜の朝、restricted-ssh が NON_COMPLIANT になっていた。最初にすべきことは？'),
      options: ['ルールを削除して警告を消す', 'タイムラインと CloudTrail で、誰が何のために変更したかを確かめてから直す', '何もしない'],
      answer: 1,
      explanation: [
        hakase('正解。必要があって開けた可能性もある。まずタイムラインと CloudTrail で、事実と理由を確かめるのだ。'),
        node('ルールを消して警告を消すのは、火災報知器の電池を抜くのと同じですね。'),
        hakase('静かにはなるが、燃えたままだ。理由がわかったら閉じて、代わりに EC2 Instance Connect や、SSH のポートを開けずにサーバーへ入れる **Session Manager** を案内するとよい。'),
      ],
    },
  ],
};
