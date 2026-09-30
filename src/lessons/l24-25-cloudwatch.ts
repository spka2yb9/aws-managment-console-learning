import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { decodeGraph, evaluateAlarm } from '../sim/cloudwatch';
import { DB_INSTANCE_CLASSES } from '../sim/rds';
import { slowAppEnv, webAppEnv } from '../sim/scenarios';
import type { AwsEnv, MetricAlarm } from '../sim/types';
import { alarmNamed, dbNamed, instanceNamed, visited, visitedId, visitedQuery } from './helpers';

const SLOW_LOG = '/aws/rds/instance/webapp-db/slowquery';
const idOf = (env: AwsEnv, name: string) => instanceNamed(env, name)?.instanceId ?? '-';
const monitoringOf = (c: TaskContext, prefix: string, id: string) => c.visited.some((v) => v.startsWith(`${prefix}${id}?`) && new URLSearchParams(v.split('?')[1]).get('tab') === 'monitoring');
const graphed = (c: TaskContext) => c.visited.filter((v) => v.startsWith('/cloudwatch/metrics?')).map((v) => decodeGraph(new URLSearchParams(v.split('?')[1]).get('graph') ?? ''));
const watches = (a: MetricAlarm | undefined, ns: string, metric: string, value: string) => !!a && a.namespace === ns && a.metricName === metric && a.dimensions[0]?.value === value;
const above = (a: MetricAlarm) => a.comparisonOperator === 'GreaterThanThreshold' || a.comparisonOperator === 'GreaterThanOrEqualToThreshold';
const vcpu = (cls?: string) => DB_INSTANCE_CLASSES.find((c) => c.cls === cls)?.vcpu ?? 0;

export const lesson24: Lesson = {
  id: 'cloudwatch-basics',
  number: '24',
  title: 'CloudWatch の基本: メトリクスとアラーム',
  summary: 'メトリクス・統計・期間を読み、EC2 の CPU 使用率にアラームを設定する',
  minutes: 20,
  startPath: '/ec2/instances',
  scenario: () => webAppEnv(),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、Lesson 19 で Internet → ALB → EC2 → RDS が全部つながりましたよね。あれって、放っておいてもずっと動き続けてくれるんですか？'),
        hakase('動き続けているかどうかは、見張っていなければ分からん。お客様からの電話で障害を知るのは、火災報知器の代わりに近所の悲鳴で火事を知るようなものだ。'),
        node('たとえが物騒です。'),
        hakase('AWS の見張り番が **CloudWatch** だ。Cloud を Watch する、そのままの名前だ。'),
        node('くらうどうぉっち。雲を眺める仕事ですか？ 僕にもできそう。'),
        hakase('眺めるだけで給料が出るなら、ワシはとっくに雲の研究者になっておる。'),
        node('で、何を見張るんですか？'),
        hakase('**メトリクス**だ。CPU 使用率や応答時間のような数値を、時刻とセットで記録したものだ。'),
        node('めとりくす？'),
        hakase('「測定値」のことだ。健康診断の体重を毎日書き留めた表だと思えばよい。こういう時刻順の数値の並びを**時系列**という。'),
        node('体重の時系列は、あまり見たくないですね…'),
        hakase('安心したまえ。AWS のリソースは、何もしなくても自分のメトリクスを CloudWatch に送ってくれる。EC2 なら CPU 使用率、ALB なら応答時間、RDS なら CPU や接続数だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('メトリクスってたくさんありそうですけど、どうやって見分けるんですか？'),
        hakase('3 つの組で 1 本に決まる。「**名前空間**」「**メトリクス名**」「**ディメンション**」だ。'),
        node('なまえくうかん？ 急に SF っぽくなりましたね。'),
        hakase('どのサービスのメトリクスか、という区分だ。EC2 なら `AWS/EC2`、RDS なら `AWS/RDS`。住所でいえば都道府県だな。'),
        node('メトリクス名は？'),
        hakase('何を測ったか、だ。CPU 使用率なら `CPUUtilization`。Utilization は「使用率」という意味だ。'),
        node('しーぴーゆー ゆーてぃらいぜーしょん。舌をかみそうです。'),
        hakase('ディメンションは「どのリソースの」だ。EC2 なら `InstanceId = i-…` のように、Lesson 10 で見たインスタンス ID で区別する。'),
        node('都道府県と、何を測ったかと、誰のか。「東京都の・体重の・ノード君の」みたいな？'),
        hakase('君の体重を AWS に送るのはやめたまえ。ストレージの無駄だ。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('メトリクスは細かい点の集まりだ。それを一定の時間ごとにまとめて 1 つの点にする。この時間を**期間**、まとめた点を**データポイント**という。'),
        node('5 分ごとにまとめるなら、期間は 5 分ってことですね。'),
        hakase('そうだ。まとめ方を**統計**という。平均、最大、最小、合計などがある。'),
        node('5 分間の平均とか、5 分間でいちばん高かった値とか。'),
        hakase('その通り。そして、データポイントが**しきい値**を超えたら騒ぎ出す見張り番が**アラーム**だ。'),
        node('しきいち？'),
        hakase('「ここを越えたら異常」という境目の値だ。敷居をまたいだら叱られる、の敷居だ。例えば「CPU 使用率の 5 分平均が 70% より大きい」とな。'),
        node('アラームが鳴ったらどうなるんですか？'),
        hakase('アラームには状態がある。普段は **OK**、条件を満たすと**アラーム状態**、データが届かなくて判断できないときは**データ不足**だ。'),
        node('3 つですね。OK、アラーム状態、データ不足。'),
        hakase('表にまとめておいた。まずは EC2 の画面から、`web-1` のメトリクスを覗いてみよう。'),
      ],
    },
    {
      type: 'table',
      title: 'CloudWatch の用語',
      columns: ['用語', '意味', '例'],
      rows: [
        ['名前空間', 'どのサービスのメトリクスか', '`AWS/EC2` `AWS/ApplicationELB` `AWS/RDS`'],
        ['ディメンション', 'どのリソースのメトリクスか', '`InstanceId = i-0abc…`'],
        ['統計', '期間内の値のまとめ方', '平均 / 最大 / 最小 / 合計'],
        ['期間', '1 つのデータポイントにまとめる時間', '1 分 / 5 分'],
        ['アラーム', 'しきい値を超えたら状態が変わる見張り番', 'CPU > 70 が 5 分続いたら「アラーム状態」'],
      ],
    },
    {
      type: 'exercise',
      title: 'EC2 のモニタリングタブを見る',
      objective: '`web-1` の詳細を開き、**モニタリング** タブで CPU 使用率のグラフを確認する',
      tasks: [
        { id: 'open', title: 'インスタンス一覧から `web-1` のインスタンス ID をクリック', hint: '一覧の「Name」列で `web-1` の行を探し、「インスタンス ID」列の `i-…` のリンクをクリックします。', done: (c) => visitedId(c, '/ec2/instances/', idOf(c.env, 'web-1')) },
        { id: 'tab', title: '**モニタリング** タブを開く', hint: '詳細ページの下のタブです。', done: (c) => monitoringOf(c, '/ec2/instances/', idOf(c.env, 'web-1')) },
      ],
      validate: (c) =>
        monitoringOf(c, '/ec2/instances/', idOf(c.env, 'web-1'))
          ? ok(
              node('CPU 使用率は 10% 前後です。点が 5 分おきに並んでます。'),
              hakase('EC2 の標準の見張り、**基本モニタリング**は **5 分間隔**だ。1 分間隔が必要なら**詳細モニタリング**を有効にする。こちらは有料だ。'),
              node('ALB や RDS も 5 分おきですか？'),
              hakase('いや、ALB や RDS は 1 分間隔で届くぞ。EC2 の無料の見張りだけが、のんびりしておるのだ。タダより遅いものはない。'),
            )
          : ng(hakase('web-1 のモニタリングタブをまだ開いていないようだ。インスタンス一覧で `web-1` のインスタンス ID をクリックし、詳細ページの下にある**モニタリング**タブを開くのだ。')),
    },
    {
      type: 'exercise',
      title: 'CloudWatch でメトリクスを並べて比べる',
      objective: 'CloudWatch の **すべてのメトリクス** で、`web-1` と `web-2` の `CPUUtilization` を 1 つのグラフに表示する',
      tasks: [
        { id: 'metrics', title: '検索バーで `metrics` → **すべてのメトリクス** を開く', hint: 'モニタリングタブの「メトリクスで表示」からも開けます。', done: (c) => visited(c, '/cloudwatch/metrics') },
        {
          id: 'both',
          title: '**EC2** → 一覧で `web-1` と `web-2` の `CPUUtilization` にチェック',
          hint: 'フィルターに `CPUUtilization` と入力すると探しやすくなります。',
          done: (c) => graphed(c).some((g) => ['web-1', 'web-2'].every((n) => g.some((r) => r.metricName === 'CPUUtilization' && r.dimensions[0].value === idOf(c.env, n)))),
        },
      ],
      validate: (c) =>
        graphed(c).some((g) => ['web-1', 'web-2'].every((n) => g.some((r) => r.metricName === 'CPUUtilization' && r.dimensions[0].value === idOf(c.env, n))))
          ? ok(
              node('2 台ともほぼ同じ形のグラフです。'),
              hakase('ALB が 2 台に均等に振り分けているからだ。Lesson 11 でやったな。'),
              node('ロードバランサーが、順番に仕事を配ってくれるんでしたよね。'),
              hakase('うむ。だから 1 台だけ高ければ、その 1 台に何か起きていると、並べるだけで気づける。双子の片方だけ顔色が悪ければ、すぐ分かるのと同じだ。'),
              hakase('次はいよいよアラームだ。「アラームの作成」は 4 ステップあるが、大事なのは最初の「メトリクスと条件の指定」だ。そこで統計・期間・しきい値を決める。'),
            )
          : ng(hakase('web-1 と web-2 の CPUUtilization を両方グラフに入れるのだ。すべてのメトリクスで **EC2** を選び、フィルターに `CPUUtilization` と入れて 2 行ともチェックしたまえ。')),
    },
    {
      type: 'exercise',
      title: 'CPU 使用率のアラームを作る',
      objective: '`web-1` の `CPUUtilization` が **5 分間の平均で 70 より大きい** ときにアラーム状態になる、アラーム `web-1-cpu-high` を作成する',
      tasks: [
        { id: 'open', title: 'CloudWatch > アラーム > **すべてのアラーム** → **アラームの作成**', hint: '検索バーに `alarms` と入力しても開けます。**アラームの作成** はアラーム一覧の右上にあります。', hotspotId: 'cw-create-alarm', done: (c) => visited(c, '/cloudwatch/alarms/create') },
        {
          id: 'create',
          title: 'メトリクス `web-1 CPUUtilization` / 平均 / 5 分 / より大きい 70 / 名前 `web-1-cpu-high` で作成',
          hint: 'メトリクスの選択欄に `web-1` と入力すると絞り込めます。',
          done: (c) => watches(alarmNamed(c.env, 'web-1-cpu-high'), 'AWS/EC2', 'CPUUtilization', idOf(c.env, 'web-1')),
        },
      ],
      validate: (c) => {
        const a = alarmNamed(c.env, 'web-1-cpu-high');
        if (!a) return ng(hakase('`web-1-cpu-high` という名前のアラームが見当たらん。「アラームの作成」のステップ 3 で、アラーム名に `web-1-cpu-high` と入れたかな？'));
        if (!watches(a, 'AWS/EC2', 'CPUUtilization', idOf(c.env, 'web-1'))) return ng(hakase('アラームが web-1 の CPUUtilization を見ていないぞ。アラームを開いて **編集** を押し、「メトリクスの選択」で `web-1` と入力して `web-1 CPUUtilization` を選び直すのだ。'));
        if (a.period < 300) return ng(hakase('期間が 5 分より短い。EC2 の基本モニタリングは 5 分ごとにしかデータが届かんから、1 分ごとに見張ると空振りして**データ不足**になりやすいのだ。'), node('`web-1-cpu-high` を開いて **編集** で期間を 5 分に直せばいいんですね。'));
        if (!above(a) || a.threshold !== 70 || a.statistic !== 'Average') return ng(hakase('条件は「平均が 70 より大きい」だ。統計は「平均」、条件は「より大きい」、しきい値は `70` になっているか見直し、違っていればアラームの **編集** で直すのだ。'));
        const s = evaluateAlarm(c.env, a).state;
        return s === 'OK'
          ? ok(
              hakase('状態は **OK** だ。CPU は 10% 前後で、70% には程遠いからな。'),
              node('せっかく作ったのに、何も起きないんですね。'),
              hakase('何も起きないのが一番だ。超えると「アラーム状態」になり、本番では **SNS** という通知サービスで、メールやチャットに知らせる。'),
              node('夜中にスマホが鳴るやつですね…'),
              hakase('うむ。深夜 3 時の通知音は、一度聞いたら一生忘れられんぞ。ワシの耳にはまだ残っておる。'),
            )
          : ng(hakase(`状態が ${s} だ。今の CPU なら OK になるはずだから、統計・期間・しきい値のどれかがずれておる。アラームの詳細で条件を見直すのだ。`));
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。アラームの 3 つの状態のうち、メトリクスのデータが届いていないときになるのはどれかな？'),
      options: ['OK', 'アラーム状態', 'データ不足'],
      answer: 2,
      explanation: [
        hakase('正解。インスタンスを停止したときや、期間がデータの間隔より短いときにデータ不足になる。'),
        node('データが来ないなら、異常もないから安心…ではないんですね。'),
        hakase('そうだ。「OK = 安全」でも「データ不足 = 平和」でもない。サーバーが丸ごと止まっても、アラームは静かに「データ不足」と言うだけかもしれんぞ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('数秒だけ CPU が 100% に跳ね上がる瞬間を見逃したくない。統計はどれを使う？'),
      options: ['平均', '最大', 'サンプル数'],
      answer: 1,
      explanation: [
        hakase('正解。平均は、短い**スパイク** (一瞬の跳ね上がり) をならして消してしまう。'),
        hakase('傾向を見るなら平均、ピークを見るなら最大、リクエスト数のような件数は合計だ。サンプル数は「点がいくつ届いたか」で、値の大きさは教えてくれんぞ。'),
      ],
    },
  ],
};

export const lesson25: Lesson = {
  id: 'app-slow',
  number: '25',
  title: 'アプリが遅い: CloudWatch で原因を絞り込む',
  summary: 'ALB → EC2 → RDS の順にメトリクスを見て、遅い原因が RDS にあると突き止める',
  minutes: 30,
  startPath: '/ec2/load-balancers',
  scenario: slowAppEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士！「注文履歴の表示がすごく遅い」ってお問い合わせが何件も来てます。画面はちゃんと出るみたいなんですけど…'),
        hakase('落ち着け。エラーではなく「遅い」か。Lesson 16 からやった 504 や 502 より、ある意味たちが悪いぞ。'),
        node('どうしてですか？ 動いてはいるのに。'),
        hakase('エラーなら画面が教えてくれる。「遅い」は誰も何も教えてくれん。お客様の忍耐が切れるのを待つだけだ。'),
        node('じゃあ、とりあえず EC2 を増やしましょう！ 台数が倍なら、速さも倍ですよね？'),
        hakase('勘で EC2 を増やしてはいかん。原因が別の場所なら、請求書だけが倍になる。'),
        node('請求書だけ倍…。上司の顔色も倍悪くなりそうです。'),
        hakase('遅いときは**入口から順に**メトリクスを見る。ALB → EC2 → RDS だ。どこで時間を使っているかを、数字で確かめるのだ。'),
        node('Lesson 15 でやった通信経路の順番ですね。Internet → ALB → EC2 → RDS。'),
        hakase('そうだ。リクエストはその順に流れる。行列の先頭がどこにあるかは、入口から見ていけば分かる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('ALB では何を見ればいいんですか？'),
        hakase('**ターゲットの応答時間**、メトリクス名でいうと `TargetResponseTime` だ。ALB がターゲットにリクエストを渡してから、応答が返ってくるまでの時間だ。'),
        node('ターゲットは Lesson 12 でやった、ALB の転送先でしたよね。今なら web-1 と web-2。'),
        hakase('うむ。この値が大きければ、遅いのは ALB より後ろだと分かる。ALB 自身はただの受付係だからな。'),
        node('受付は悪くない、奥の担当者が遅い、と。'),
        hakase('ただし、メトリクスで分かるのは「どこが遅いか」までだ。「なぜ遅いか」は教えてくれん。そこで**ログ**の出番だ。'),
        node('ろぐ？ 丸太ですか？'),
        hakase('航海日誌 (logbook) の log だ。何がいつ起きたかを 1 行ずつ書き残した記録だ。CloudWatch には、ログを集めて保管する **CloudWatch Logs** もある。'),
        node('メトリクスで場所を絞って、ログで理由を見る。'),
        hakase('そういうことだ。君にしては飲み込みが早い。障害の日だけ冴えるタイプか。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('CloudWatch Logs の中って、どうなってるんですか？'),
        hakase('ログは**ロググループ**という入れ物にまとめられる。アプリごと、用途ごとの棚だ。棚の中には**ログストリーム**という、出どころごとの記録が並ぶ。'),
        node('棚と、その中のノート、みたいな？'),
        hakase('うむ。ノートの 1 行 1 行が**ログイベント**だ。行が多すぎるときは、キーワードで**フィルタリング**、つまり絞り込む。'),
        node('日記を「ラーメン」で検索するみたいなものですね。'),
        hakase('君の日記はラーメンしか出てこなさそうだな。さて、受付から聞き込みを始めよう。`web-alb` のモニタリングタブだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ALB の応答時間を見る',
      objective: '`web-alb` の **モニタリング** タブで「ターゲットの応答時間」を確認する',
      tasks: [
        { id: 'open', title: 'ロードバランサー一覧で `web-alb` を開く', hint: '一覧の「名前」列で `web-alb` のリンクをクリックします。別の画面にいる場合は、EC2 の左メニュー「ロードバランシング」→「ロードバランサー」から戻れます。', done: (c) => visited(c, '/ec2/load-balancers/web-alb') },
        { id: 'tab', title: '**モニタリング** タブを開く', hint: '詳細ページ下部のタブの 1 つです。「ターゲットの応答時間 (秒)」のグラフで、値がいつから変わったかを見ます。', done: (c) => monitoringOf(c, '/ec2/load-balancers/', 'web-alb') },
      ],
      validate: (c) =>
        monitoringOf(c, '/ec2/load-balancers/', 'web-alb')
          ? ok(
              node('40 分くらい前から、0.05 秒くらいだった応答時間が一気に数十倍に跳ね上がってます！'),
              hakase('TargetResponseTime は「ALB がターゲットにリクエストを送ってから応答が返ってくるまで」の時間だったな。つまり遅いのは ALB より**後ろ**だ。'),
              node('受付は無実。次は奥の EC2 ですね。'),
              hakase('うむ。EC2 の CPU 使用率を見るのだ。CPU が悲鳴を上げていれば、アプリの計算が重いということになる。'),
            )
          : ng(hakase('web-alb のモニタリングタブを開くのだ。ロードバランサー一覧で `web-alb` をクリックし、詳細の**モニタリング**タブにある「ターゲットの応答時間」のグラフを見たまえ。')),
    },
    {
      type: 'exercise',
      title: 'EC2 の CPU を見る',
      objective: '`web-1` か `web-2` の **モニタリング** タブで CPU 使用率を確認する',
      tasks: [{ id: 'tab', title: 'インスタンス → `web-1` (または `web-2`) → **モニタリング**', hint: 'EC2 の左メニュー「インスタンス」から開きます。ALB の応答時間が跳ね上がった時刻に、CPU 使用率も上がっているかを見比べます。', done: (c) => ['web-1', 'web-2'].some((n) => monitoringOf(c, '/ec2/instances/', idOf(c.env, n))) }],
      validate: (c) =>
        ['web-1', 'web-2'].some((n) => monitoringOf(c, '/ec2/instances/', idOf(c.env, n)))
          ? ok(
              node('CPU は 10% 前後で、40 分前と変わりません。'),
              hakase('アプリのサーバーは暇そうだな。CPU が原因なら 90% 以上に張り付くはずだ。ということは、アプリは**何かを待っている**。'),
              node('何かって…EC2 の後ろにいるのは RDS ですね。'),
              hakase('そうだ。RDS では `CPUUtilization` と `DatabaseConnections` を見る。DatabaseConnections は DB につながっている接続の数、銀行の窓口に並んでいる客の数のようなものだ。'),
              node('窓口が詰まってたら、行列がどんどん伸びる、と。'),
            )
          : ng(hakase('web-1 か web-2 のモニタリングタブを開くのだ。検索バーで `instances` と入れてインスタンス一覧を開き、`web-1` のインスタンス ID → **モニタリング**タブだ。')),
    },
    {
      type: 'exercise',
      title: 'RDS のメトリクスを見る',
      objective: '`webapp-db` の **モニタリング** タブで CPUUtilization と DatabaseConnections を確認する',
      tasks: [{ id: 'tab', title: 'RDS > データベース → `webapp-db` → **モニタリング**', hint: '検索バーで `databases`。', done: (c) => monitoringOf(c, '/rds/databases/', 'webapp-db') }],
      validate: (c) =>
        monitoringOf(c, '/rds/databases/', 'webapp-db')
          ? ok(
              node('CPUUtilization が 90% を超えて張り付いてます！ 接続数も 10 くらいから 40 以上に増えてます。'),
              hakase('見えてきたな。DB が CPU を使い切ってクエリの完了が遅れ、待っている接続がどんどん溜まる。アプリはその間ずっと待たされるから、EC2 の CPU は上がらないのだ。'),
              node('DB が重い理由は、どうやって調べるんですか？'),
              hakase(`RDS は、時間のかかった**クエリ** (DB への問い合わせ文、SQL のことだ) を**スロークエリログ**に書き残して、CloudWatch Logs に送っておる。ロググループは \`${SLOW_LOG}\` だ。`),
              hakase('各ログには `Rows_examined`、つまりそのクエリが**読んだ行数**が載っておる。これでフィルタリングしてみるのだ。'),
            )
          : ng(hakase('webapp-db のモニタリングタブを開くのだ。検索バーで `databases` と入れてデータベースの一覧を開き、`webapp-db` → **モニタリング**タブだ。')),
    },
    {
      type: 'exercise',
      title: 'スロークエリログを調べる',
      objective: `CloudWatch Logs のロググループ \`${SLOW_LOG}\` のログイベントを開き、\`Rows_examined\` でフィルタリングする`,
      tasks: [
        { id: 'group', title: 'CloudWatch > ログ > **ロググループ** → `…/webapp-db/slowquery` を開く', hint: 'CloudWatch の左メニュー「ログ」→「ロググループ」。RDS のログは `/aws/rds/instance/<DB 名>/<ログの種類>` という名前のロググループに届きます。', done: (c) => visitedQuery(c, '/cloudwatch/logs/group', { name: SLOW_LOG }) || visitedQuery(c, '/cloudwatch/logs/events', { group: SLOW_LOG }) },
        { id: 'filter', title: 'ログストリーム `webapp-db` (または **すべてのログストリームを検索**) を開き、`Rows_examined` でフィルタリング', hint: 'フィルターは大文字と小文字を区別します。入力して Enter。', hotspotId: 'cw-log-filter', done: (c) => visitedQuery(c, '/cloudwatch/logs/events', { group: SLOW_LOG, filter: /Rows_examined|Query_time|orders/ }) },
      ],
      validate: (c) =>
        visitedQuery(c, '/cloudwatch/logs/events', { group: SLOW_LOG, filter: /Rows_examined|Query_time|orders/ })
          ? ok(
              node('`SELECT * FROM orders WHERE customer_id = …` が 1 回 8 秒くらいかかってて、`Rows_examined: 24xxxxx`！ 20 行返すのに 240 万行も読んでます。'),
              hakase('`customer_id` に**インデックス**がないから、毎回テーブルを全部読んでおるのだ。これを**フルスキャン**という。'),
              node('いんでっくす？'),
              hakase('本の巻末の索引だ。索引があれば目当てのページに直行できるが、なければ 1 ページ目から全部めくるしかない。240 万ページの本を、注文履歴を開くたびにな。'),
              hakase('40 分前のリリースで、この注文履歴のクエリが入ったのだろう。新機能と障害は、たいてい同じ日にやってくる。'),
            )
          : ng(hakase('スロークエリログのイベントを `Rows_examined` でフィルタリングするのだ。ロググループ `…/webapp-db/slowquery` → ログストリーム `webapp-db` を開き、フィルター欄に入力して Enter だ。大文字と小文字は区別されるぞ。')),
    },
    {
      type: 'exercise',
      title: 'RDS の CPU にアラームを設定する',
      objective: '`webapp-db` の `CPUUtilization` (平均 / 1 分) が **80 より大きい** ときのアラーム `webapp-db-cpu-high` を作成する',
      tasks: [
        {
          id: 'create',
          title: 'CloudWatch > すべてのアラーム > **アラームの作成**',
          hint: 'メトリクスの選択で `webapp-db` と入力して `webapp-db CPUUtilization` を選びます。RDS は 1 分間隔でデータが届きます。',
          hotspotId: 'cw-create-alarm',
          done: (c) => watches(alarmNamed(c.env, 'webapp-db-cpu-high'), 'AWS/RDS', 'CPUUtilization', 'webapp-db'),
        },
      ],
      validate: (c) => {
        const a = alarmNamed(c.env, 'webapp-db-cpu-high');
        if (!watches(a, 'AWS/RDS', 'CPUUtilization', 'webapp-db')) return ng(hakase('webapp-db の CPUUtilization を見る `webapp-db-cpu-high` が見当たらん。「メトリクスの選択」で `webapp-db` と入力し、`webapp-db CPUUtilization` を選んで作るのだ。'));
        if (!above(a!) || a!.threshold !== 80) return ng(hakase('条件は「80 より大きい」だ。条件を「より大きい」、しきい値を `80` にするのだ。アラームを開いて **編集** で直せる。'));
        return evaluateAlarm(c.env, a!).state === 'ALARM'
          ? ok(
              hakase('作った瞬間に**アラーム状態**になったな。今まさに問題が起きている証拠だ。本番では最初からこういうアラームを用意して、お客様より先に気づけるようにしておくのだ。'),
              node('Lesson 24 では OK のままだったのに。…で、今燃えてる火はどうするんですか？'),
              hakase('まずは消火だ。Lesson 14 で選んだ `db.t3.micro` を覚えておるか。あれが **DB インスタンスクラス**、DB の体格だ。これを `db.m7g.xlarge` に上げて、**vCPU** (仮想的な CPU) を 2 つから 4 つにする。'),
              hakase('変更の最後に「**すぐに適用**」を選ぶのだ。そうしないと「次回の定期メンテナンスウィンドウ」、つまり AWS が作業してよい夜中の時間帯まで待たされる。'),
              node('お客さんは夜中まで待ってくれませんもんね。'),
            )
          : ng(hakase('アラームがアラーム状態になっていない。統計は「平均」、期間は「1 分」になっているか見直すのだ。違っていればアラームの **編集** で直したまえ。'));
      },
    },
    {
      type: 'exercise',
      title: '応急処置: DB インスタンスクラスを上げる',
      objective: '`webapp-db` を **変更** して DB インスタンスクラスを `db.m7g.xlarge` (4 vCPU) にし、**すぐに適用** する。変更が終わったらアラームが OK に戻ることを確認する',
      tasks: [
        { id: 'modify', title: 'RDS > `webapp-db` → **変更** → DB インスタンスクラス `db.m7g.xlarge` → 続行 → **すぐに適用**', hint: '**変更** ボタンは DB の状態が「利用可能」のときだけ押せます。続行後の「変更の概要」で新しい値を確かめ、**DB インスタンスを変更** で確定します。', done: (c) => vcpu(dbNamed(c.env, 'webapp-db')?.dbInstanceClass) >= 4 },
        { id: 'ok', title: '状態が「利用可能」になり、アラーム `webapp-db-cpu-high` が **OK** に戻る', hint: 'CloudWatch > すべてのアラーム で状態を確認できます。', done: (c) => { const a = alarmNamed(c.env, 'webapp-db-cpu-high'); return dbNamed(c.env, 'webapp-db')?.status === 'available' && !!a && evaluateAlarm(c.env, a).state === 'OK'; } },
      ],
      validate: (c) => {
        const db = dbNamed(c.env, 'webapp-db');
        if (vcpu(db?.dbInstanceClass) < 4) return ng(hakase('まだ vCPU が 4 つ以上のクラスになっていない。RDS > データベース > `webapp-db` → **変更** で DB インスタンスクラスに `db.m7g.xlarge` を選び、続行 → **すぐに適用** だ。'));
        if (db?.status !== 'available') return ng(hakase('まだ変更中だ。状態が「利用可能」になるまで待つのだ。'), node('待つのも仕事のうち、ですね。'));
        const a = alarmNamed(c.env, 'webapp-db-cpu-high');
        if (a && evaluateAlarm(c.env, a).state !== 'OK') return ng(hakase('変更は終わったが、アラームがまだ OK に戻らん。新しいデータポイントが届くまで少し待ち、CloudWatch > すべてのアラーム で状態を見てから、もう一度検証するのだ。'));
        return ok(
          node('CPU が 50% くらいに下がって、アラームも OK に戻りました！ 応答時間も元通りです。'),
          hakase('ただしこれは**応急処置**だ。お金をかけて力で押し切っただけで、240 万行を読む無駄はそのまま残っている。'),
          node('痛み止めを飲んだだけで、虫歯は治ってない、みたいな？'),
          hakase('うむ。しかもこの痛み止め、1 時間あたりの料金は `db.t3.micro` のざっと 18 倍だ。'),
          node('請求書が届く前に、根本から直さないと…'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。今回「遅い」の根本原因はどこにあったかな？'),
      options: ['ALB の性能不足', 'EC2 の CPU 不足', 'RDS: インデックスのないクエリが毎回テーブルを全件スキャンしていた'],
      answer: 2,
      explanation: [
        hakase('正解。ALB の応答時間 ↑、EC2 の CPU は正常、RDS の CPU 90% 超と接続数 ↑、そしてスロークエリログ。'),
        hakase('メトリクスで場所を絞り、ログで理由を確かめる。これが調査の型だ。勘で EC2 を増やしていたら、今ごろ請求書と始末書が同時に届いておったぞ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では、二度と起こさないための**恒久対策**として、最も適切なのはどれかな？'),
      options: ['DB インスタンスクラスをさらに上げ続ける', '`orders.customer_id` にインデックスを作成してクエリを速くする', 'EC2 の台数を増やす'],
      answer: 1,
      explanation: [
        hakase('正解。EC2 を増やすと DB へのクエリも増えて、むしろ悪化することさえある。原因の場所 (DB) で、原因 (フルスキャン) を直すのだ。'),
        node('索引を作れば、240 万ページめくらずに済むんですね。'),
        hakase('うむ。インデックスで速くなったら、インスタンスクラスを戻してコストも元に戻せる。痛み止めは、虫歯を治したらやめるものだ。'),
      ],
    },
  ],
};
