import type { CommandRecord } from '../../console/store';
import { parseTimestamp } from '../../cli/aws/services/cloudwatch';
import { hakase, ng, node, ok, type LessonContent, type TaskContext } from '../../lesson/types';
import { evaluateAlarm, lbDimension } from '../../sim/cloudwatch';
import { ruleCompliance } from '../../sim/config';
import { eicConnectivity } from '../../sim/network';
import { DB_INSTANCE_CLASSES } from '../../sim/rds';
import { SHARE_BUCKET } from '../../sim/scenarios';
import type { AwsEnv, MetricAlarm } from '../../sim/types';
import { albReachesWeb, alarmNamed, dbNamed, instanceNamed, lastRun, sgAllows, sgNamed } from '../helpers';
import { failedAws, param, ranAws } from './helpers';
import type { CliPatches } from './types';

/* ---------- 共通 ---------- */
const idOf = (env: AwsEnv, name: string) => instanceNamed(env, name)?.instanceId ?? 'i-xxxxxxxx';
const sgId = (env: AwsEnv, name: string) => sgNamed(env, name)?.groupId ?? 'sg-xxxxxxxx';
/** 打ったコマンドの中のどれか (新しいもの) */
const ranAny = (c: TaskContext, commands: string[], pred: (x: CommandRecord) => boolean) => commands.some((cmd) => ranAws(c, cmd, pred));
/** 1 時間前から今までの時刻の書き方 (date +%s で今の UNIX 時間を変数に入れる) */
const LAST_HOUR = 'NOW=$(date +%s); ';
const WINDOW = '--start-time $((NOW - 3600)) --end-time $NOW';

/* ---------- CloudWatch ---------- */
const SLOW_LOG = '/aws/rds/instance/webapp-db/slowquery';
const watches = (a: MetricAlarm | undefined, ns: string, metric: string, value: string) => !!a && a.namespace === ns && a.metricName === metric && a.dimensions[0]?.value === value;
const above = (a: MetricAlarm) => a.comparisonOperator === 'GreaterThanThreshold' || a.comparisonOperator === 'GreaterThanOrEqualToThreshold';
const vcpu = (cls?: string) => DB_INSTANCE_CLASSES.find((c) => c.cls === cls)?.vcpu ?? 0;
const albDim = (env: AwsEnv) => {
  const lb = env.loadBalancers.find((x) => x.loadBalancerName === 'web-alb');
  return lb ? lbDimension(lb) : 'app/web-alb/xxxxxxxx';
};
const dimValues = (x: CommandRecord) => {
  const d = x.params?.dimensions;
  return (Array.isArray(d) ? (d as Record<string, unknown>[]) : []).map((v) => String(v.Value));
};
/** get-metric-statistics でそのメトリクスを見た (ディメンションの値が values のどれか) */
const statsOf = (c: TaskContext, ns: string, metric: string, values: string[], pred: (x: CommandRecord) => boolean = () => true) =>
  ranAws(c, 'cloudwatch get-metric-statistics', (x) => param(x, 'namespace') === ns && param(x, 'metric-name') === metric && dimValues(x).some((v) => values.includes(v)) && pred(x));
/** Lesson 25: 見た時間の範囲が、遅くなり始めた時刻 (40 分前) より前から始まっている */
const sinceIncident = (c: TaskContext) => (x: CommandRecord) => parseTimestamp(param(x, 'start-time')) <= (c.env.incidents[0]?.startedAt ?? 0);
const statsCmd = (ns: string, metric: string, dim: string, period: number) => `${LAST_HOUR}aws cloudwatch get-metric-statistics --namespace ${ns} --metric-name ${metric} --dimensions ${dim} --statistics Average --period ${period} ${WINDOW} --output table`;
/** get-metric-data で web-1 と web-2 の CPUUtilization を両方取り出した */
const bothCpu = (c: TaskContext) =>
  ranAws(c, 'cloudwatch get-metric-data', (x) => {
    const q = x.params?.['metric-data-queries'];
    const qs = Array.isArray(q) ? (q as { MetricStat?: { Metric?: { MetricName?: string; Dimensions?: { Value?: string }[] } } }[]) : [];
    const ids = qs.filter((q) => q.MetricStat?.Metric?.MetricName === 'CPUUtilization').flatMap((q) => q.MetricStat?.Metric?.Dimensions?.map((d) => d.Value) ?? []);
    return ['web-1', 'web-2'].every((n) => ids.includes(idOf(c.env, n)));
  });
/** describe-alarms でそのアラームを、after より後に見た */
const sawAlarm = (c: TaskContext, name: string, after: number) =>
  !!ranAws(c, 'cloudwatch describe-alarms', (x) => x.at >= after && (!x.params?.['alarm-names'] || param(x, 'alarm-names').split(',').includes(name)) && name.startsWith(param(x, 'alarm-name-prefix')));

const cpuQueries = (env: AwsEnv) =>
  JSON.stringify(
    ['web-1', 'web-2'].map((n) => ({ Id: n.replace('-', ''), Label: n, MetricStat: { Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'InstanceId', Value: idOf(env, n) }] }, Period: 300, Stat: 'Average' } })),
    null,
    2,
  ) + '\n';

/* ---------- CloudTrail / Config ---------- */
const EIC_IP = '3.112.23.1';
const learnerEvent = (env: AwsEnv, name: string, sg: string) => env.trailEvents.filter((e) => e.eventName === name && e.userIdentity.userName === 'learner' && e.resources.some(([, n]) => n === sg)).at(-1);
const revokeEvent = (env: AwsEnv) => env.trailEvents.find((e) => e.eventName === 'RevokeSecurityGroupIngress' && e.userIdentity.userName === 'tanaka');
/** lookup-events の絞り込み: 'ResourceName=sg-…' */
const lookup = (x: CommandRecord) => {
  const a = x.params?.['lookup-attributes'];
  const s = (Array.isArray(a) ? a[0] : undefined) as Record<string, unknown> | undefined;
  return s ? `${String(s.AttributeKey)}=${String(s.AttributeValue)}` : '';
};
const rule = (env: AwsEnv, name: string) => env.configRules.find((r) => r.configRuleName === name);
const compliant = (env: AwsEnv, name: string) => {
  const r = rule(env, name);
  return !!r && ruleCompliance(env, r).compliance === 'COMPLIANT';
};
const COMPLIANCE = ['configservice describe-compliance-by-config-rule', 'configservice get-compliance-details-by-config-rule'];
/** そのルールの準拠状況を、after より後に見た (ルール名で絞ったか、全部を見た) */
const sawCompliance = (c: TaskContext, name: string, after: number) =>
  ranAny(c, COMPLIANCE, (x) => x.at >= after && (param(x, 'config-rule-name') === name || (x.command === COMPLIANCE[0] && (!param(x, 'config-rule-names') || param(x, 'config-rule-names').split(',').includes(name)))));

const quiz27a: LessonContent = {
  type: 'quiz',
  question: hakase('では確認だ。AWS Config のルールで分かるのはどれかな？'),
  options: ['誰がいつリソースを変更したか', '今のリソースの設定がルールに準拠しているか', 'CPU 使用率の推移'],
  answer: 1,
  explanation: [
    hakase('正解。「誰がいつ」は CloudTrail、「推移」は CloudWatch だ。'),
    node('健康診断が Config、防犯カメラが CloudTrail、体温計が CloudWatch ですね。'),
    hakase('うむ。そして Config の設定の履歴で変わった時刻が分かれば、CloudTrail でその変更のイベントにもたどれる。'),
  ],
};

const quiz27b: LessonContent = {
  type: 'quiz',
  question: hakase('月曜の朝、restricted-ssh が NON_COMPLIANT になっていた。最初にすべきことは？'),
  options: ['ルールを削除して警告を消す', '設定の履歴と CloudTrail で、誰が何のために変更したかを確かめてから直す', '何もしない'],
  answer: 1,
  explanation: [
    hakase('正解。必要があって開けた可能性もある。まず設定の履歴と CloudTrail で、事実と理由を確かめるのだ。'),
    node('ルールを消して警告を消すのは、火災報知器の電池を抜くのと同じですね。'),
    hakase('静かにはなるが、燃えたままだ。理由がわかったら閉じて、代わりに EC2 Instance Connect や、SSH のポートを開けずにサーバーへ入れる **Session Manager** を案内するとよい。'),
  ],
};

const patches: CliPatches = {
  /* ================= Lesson 24 ================= */
  'cloudwatch-basics': {
    summary: 'メトリクス・統計・期間を aws cloudwatch で読み、EC2 の CPU 使用率にアラームを設定する',
    files: (env) => ({ 'cpu-web.json': cpuQueries(env) }),
    steps: {
      2: {
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
          hakase('アラームには状態がある。普段は **OK**、条件を満たすと**アラーム状態**、データが届かなくて判断できないときは**データ不足**だ。CLI では `OK`、`ALARM`、`INSUFFICIENT_DATA` と表示される。'),
          node('3 つですね。OK、アラーム状態、データ不足。'),
          hakase('表にまとめておいた。まずは CLI で、`web-1` のメトリクスを覗いてみよう。'),
        ],
      },
      4: [
        {
          type: 'dialogue',
          lines: [
            node('CloudWatch にも `describe-なんとか` があるんですか？'),
            hakase('まずは `aws cloudwatch list-metrics` だ。どんなメトリクスがあるかの一覧で、`--namespace AWS/EC2 --metric-name CPUUtilization` で絞れば、`Namespace`・`MetricName`・`Dimensions` の 3 つの組が並ぶ。'),
            node('さっきの「都道府県と、何を測ったかと、誰のか」ですね。でも `Dimensions` の値はインスタンス ID だけで、どれが web-1 か分かりません。'),
            hakase('それは `aws ec2 describe-instances` に `--filters` と `--query` を付けて調べる。Lesson 03 の `VPC_ID=$(...)` のように、`WEB1=$(...)` で変数に入れておいてもよい。'),
            node('値そのものは、どうやって取り出すんですか？'),
            hakase('`aws cloudwatch get-metric-statistics` だ。統計は `--statistics Average`、期間は `--period 300` で、単位は秒だ。いつからいつまでかは `--start-time` と `--end-time` で渡す。'),
            node('時刻って、どう書くんです？'),
            hakase('`2026-11-20T06:00:00Z` のような ISO 8601 の形か、**UNIX 時間**だ。UNIX 時間は 1970 年 1 月 1 日 0 時 (UTC) から何秒たったかで、`date +%s` と打てば今の値が出る。'),
            node('ゆにっくすじかん… 1 時間前なら、3600 を引けばいいんですね。'),
            hakase('そうだ。`NOW=$(date +%s)` で今を変数に入れ、`--start-time $((NOW - 3600)) --end-time $NOW` と書く。`$(( ))` はシェルに計算させる書き方だ。`--output table` を付ければ、数字が表に並ぶ。'),
            node('グラフじゃなくて、数字の表なんですね。'),
            hakase('返ってくる `Timestamp` の `+00:00` は UTC、日本時間より 9 時間遅れた時刻だ。時差を忘れて、障害の時刻を 9 時間ずらして書いた報告書をワシは何枚も見てきた。半分はワシが書いたものだがな。'),
          ],
        },
        {
          type: 'exercise',
          title: 'web-1 の CPU 使用率を数字で見る',
          objective: '`aws cloudwatch get-metric-statistics` で、`web-1` の `CPUUtilization` の直近 1 時間の平均 (5 分ごと) を表示する',
          tasks: [
            {
              id: 'list',
              title: '`aws cloudwatch list-metrics` で EC2 の CPUUtilization を一覧する',
              hint: '`--namespace AWS/EC2 --metric-name CPUUtilization` で絞ります。`Dimensions` の `Value` がインスタンス ID です。',
              command: 'aws cloudwatch list-metrics --namespace AWS/EC2 --metric-name CPUUtilization',
              done: (c) => !!ranAws(c, 'cloudwatch list-metrics', (x) => [undefined, 'AWS/EC2'].includes(x.params?.namespace as string | undefined)),
            },
            {
              id: 'id',
              title: '`web-1` のインスタンス ID を調べる',
              hint: "`aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[].Instances[].InstanceId' --output text`。`WEB1=$(...)` で変数に入れても構いません。",
              command: "aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[].Instances[].InstanceId' --output text",
              done: (c) => !!ranAws(c, 'ec2 describe-instances', (x) => x.output.includes(idOf(c.env, 'web-1'))),
            },
            {
              id: 'stats',
              title: '`get-metric-statistics` で `web-1` の CPU 使用率を表示する',
              hint: '`NOW=$(date +%s)` のあと、`aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<web-1 の ID> --statistics Average --period 300 --start-time $((NOW - 3600)) --end-time $NOW --output table`。',
              command: (c) => statsCmd('AWS/EC2', 'CPUUtilization', `Name=InstanceId,Value=${idOf(c.env, 'web-1')}`, 300),
              done: (c) => !!statsOf(c, 'AWS/EC2', 'CPUUtilization', [idOf(c.env, 'web-1')]),
            },
          ],
          validate: (c) =>
            statsOf(c, 'AWS/EC2', 'CPUUtilization', [idOf(c.env, 'web-1')])
              ? ok(
                  node('`Average` は 10% 前後です。`Timestamp` が 5 分おきに並んでます。'),
                  hakase('EC2 の標準の見張り、**基本モニタリング**は **5 分間隔**だ。`--period 60` で頼んでも、点は 5 分おきにしか返ってこん。1 分間隔が必要なら**詳細モニタリング**を有効にする。こちらは有料だ。'),
                  node('ALB や RDS も 5 分おきですか？'),
                  hakase('いや、ALB や RDS は 1 分間隔で届くぞ。EC2 の無料の見張りだけが、のんびりしておるのだ。タダより遅いものはない。'),
                )
              : ng(
                  hakase('web-1 の CPUUtilization をまだ取り出していないようだ。`--namespace AWS/EC2 --metric-name CPUUtilization` に、`--dimensions Name=InstanceId,Value=<web-1 の ID>` を付けるのだ。'),
                  hakase('`"Datapoints": []` と空で返ってきたなら、ディメンションの名前か ID を打ち間違えておる。CloudWatch は間違いを叱らず、黙って空を返すから気をつけたまえ。'),
                ),
        },
      ],
      5: {
        type: 'exercise',
        title: 'web-1 と web-2 の CPU を並べて比べる',
        objective: '`aws cloudwatch get-metric-data` で、`web-1` と `web-2` の `CPUUtilization` を 1 回で取り出して比べる',
        tasks: [
          {
            id: 'both',
            title: '`cpu-web.json` を使って `get-metric-data` で 2 台分を取り出す',
            hint: '`cat cpu-web.json` で中身を見てから、`aws cloudwatch get-metric-data --metric-data-queries file://cpu-web.json --start-time $((NOW - 3600)) --end-time $NOW`。`file://` を付けると、ファイルの中身がそのまま値になります。',
            command: `${LAST_HOUR}aws cloudwatch get-metric-data --metric-data-queries file://cpu-web.json ${WINDOW}`,
            done: (c) => !!bothCpu(c),
          },
        ],
        validate: (c) =>
          bothCpu(c)
            ? ok(
                node('`MetricDataResults` の web-1 と web-2 で、`Values` にほぼ同じ数字が並んでます。'),
                hakase('ALB が 2 台に均等に振り分けているからだ。Lesson 11 でやったな。'),
                node('ロードバランサーが、順番に仕事を配ってくれるんでしたよね。'),
                hakase('うむ。だから 1 台だけ高ければ、その 1 台に何か起きていると、並べるだけで気づける。双子の片方だけ顔色が悪ければ、すぐ分かるのと同じだ。'),
                hakase('次はいよいよアラームだ。作るのは 1 行だが、大事なのは統計・期間・しきい値の決め方だ。'),
              )
            : ng(
                hakase('web-1 と web-2 の CPUUtilization を両方取り出すのだ。`cat cpu-web.json` で中身を確かめてから、`--metric-data-queries file://cpu-web.json` で渡したまえ。'),
                hakase('`--start-time` と `--end-time` も要るぞ。`NOW=$(date +%s)` を打ったか？'),
              ),
      },
      6: [
        {
          type: 'dialogue',
          lines: [
            node('アラームも 1 行で作れるんですか？'),
            hakase('`aws cloudwatch put-metric-alarm` だ。見るメトリクスは `--namespace`・`--metric-name`・`--dimensions` の 3 つの組、統計は `--statistic`、期間は `--period`。ここまではさっきとほぼ同じだ。'),
            node('さっきは `--statistics` でしたよね。今度は s が付いてない…'),
            hakase('よく見ておる。取り出すときは統計をいくつでも並べられるが、アラームが見張る統計は 1 つだけだから単数形だ。s を 1 つ付け間違えただけで、`Unknown options` と叱られるぞ。'),
            node('しきい値は？'),
            hakase('`--threshold 70` と `--comparison-operator GreaterThanThreshold` で「70 より大きい」だ。`GreaterThanOrEqualToThreshold` なら「70 以上」になる。'),
            node('ぐれーたーざん… 英作文みたいですね。'),
            hakase('もう 1 つ、`--evaluation-periods 1`。直近いくつの期間で判定するかだ。1 なら、データポイントが 1 つ超えただけで騒ぎ出す。'),
            node('作ったアラームの状態は、どうやって見るんです？'),
            hakase('`aws cloudwatch describe-alarms --alarm-names <名前>` だ。`StateValue` に `OK`・`ALARM`・`INSUFFICIENT_DATA` のどれかが入っておる。'),
          ],
        },
        {
          type: 'exercise',
          title: 'CPU 使用率のアラームを作る',
          objective: '`web-1` の `CPUUtilization` が **5 分間の平均で 70 より大きい** ときにアラーム状態になる、アラーム `web-1-cpu-high` を `aws cloudwatch put-metric-alarm` で作成する',
          tasks: [
            {
              id: 'create',
              title: 'アラーム `web-1-cpu-high` を作成する (平均 / 300 秒 / 70 より大きい)',
              hint: '`aws cloudwatch put-metric-alarm --alarm-name web-1-cpu-high --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<web-1 の ID> --statistic Average --period 300 --evaluation-periods 1 --threshold 70 --comparison-operator GreaterThanThreshold`。成功しても何も表示されません。',
              command: (c) => `aws cloudwatch put-metric-alarm --alarm-name web-1-cpu-high --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=${idOf(c.env, 'web-1')} --statistic Average --period 300 --evaluation-periods 1 --threshold 70 --comparison-operator GreaterThanThreshold`,
              done: (c) => watches(alarmNamed(c.env, 'web-1-cpu-high'), 'AWS/EC2', 'CPUUtilization', idOf(c.env, 'web-1')),
            },
            {
              id: 'state',
              title: '`aws cloudwatch describe-alarms` でアラームの `StateValue` を見る',
              hint: '`aws cloudwatch describe-alarms --alarm-names web-1-cpu-high`。',
              command: 'aws cloudwatch describe-alarms --alarm-names web-1-cpu-high',
              done: (c) => {
                const a = alarmNamed(c.env, 'web-1-cpu-high');
                return !!a && sawAlarm(c, a.alarmName, a.createdAt);
              },
            },
          ],
          validate: (c) => {
            const a = alarmNamed(c.env, 'web-1-cpu-high');
            if (!a) return ng(hakase('`web-1-cpu-high` という名前のアラームが見当たらん。`aws cloudwatch describe-alarms` で名前を確かめるのだ。名前を打ち間違えたなら、そちらは `aws cloudwatch delete-alarms --alarm-names <名前>` で消して作り直したまえ。'));
            if (!watches(a, 'AWS/EC2', 'CPUUtilization', idOf(c.env, 'web-1')))
              return ng(hakase('アラームが web-1 の CPUUtilization を見ていないぞ。`put-metric-alarm` は、同じ `--alarm-name` で打ち直すと上書きされる。`--dimensions Name=InstanceId,Value=<web-1 の ID>` を確かめて打ち直すのだ。'));
            if (a.period < 300) return ng(hakase('期間が 5 分より短い。EC2 の基本モニタリングは 5 分ごとにしかデータが届かんから、1 分ごとに見張ると空振りして**データ不足**になりやすいのだ。'), node('同じ `--alarm-name` で、`--period 300` にして打ち直せばいいんですね。'));
            if (!above(a) || a.threshold !== 70 || a.statistic !== 'Average')
              return ng(hakase('条件は「平均が 70 より大きい」だ。`describe-alarms` の `Statistic`・`ComparisonOperator`・`Threshold` が `Average`・`GreaterThanThreshold`・`70` になっているか見直し、違っていれば同じ名前で打ち直すのだ。'));
            const s = evaluateAlarm(c.env, a).state;
            return s === 'OK'
              ? ok(
                  hakase('`StateValue` は `OK` だ。CPU は 10% 前後で、70% には程遠いからな。'),
                  node('せっかく作ったのに、何も起きないんですね。'),
                  hakase('何も起きないのが一番だ。超えると `ALARM` になり、本番では **SNS** という通知サービスで、メールやチャットに知らせる。'),
                  node('夜中にスマホが鳴るやつですね…'),
                  hakase('うむ。深夜 3 時の通知音は、一度聞いたら一生忘れられんぞ。ワシの耳にはまだ残っておる。'),
                )
              : ng(hakase(`\`StateValue\` が ${s} だ。今の CPU なら OK になるはずだから、統計・期間・しきい値のどれかがずれておる。\`describe-alarms\` で条件を見直すのだ。`));
          },
        },
      ],
    },
  },

  /* ================= Lesson 25 ================= */
  'app-slow': {
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          node('CloudWatch Logs の中って、どうなってるんですか？'),
          hakase('ログは**ロググループ**という入れ物にまとめられる。アプリごと、用途ごとの棚だ。棚の中には**ログストリーム**という、出どころごとの記録が並ぶ。'),
          node('棚と、その中のノート、みたいな？'),
          hakase('うむ。ノートの 1 行 1 行が**ログイベント**だ。行が多すぎるときは、キーワードで**フィルタリング**、つまり絞り込む。'),
          node('日記を「ラーメン」で検索するみたいなものですね。'),
          hakase('君の日記はラーメンしか出てこなさそうだな。さて、受付から聞き込みを始めよう。`web-alb` の `TargetResponseTime` だ。'),
          node('Lesson 24 の `get-metric-statistics` ですね。ディメンションは `LoadBalancer` に `web-alb`？'),
          hakase('惜しい。ALB のディメンションの値は、ARN の `loadbalancer/` より後ろの `app/web-alb/…` という形だ。名前だけでは見つからん。'),
          node('そんなの覚えてられませんよ。'),
          hakase('覚えんでよい。`aws cloudwatch list-metrics --namespace AWS/ApplicationELB --metric-name TargetResponseTime` で、`Dimensions` に正しい値が書いてある。覚えるより調べるほうが速い。ワシの歳になると、特にな。'),
        ],
      },
      3: {
        type: 'exercise',
        title: 'ALB の応答時間を見る',
        objective: '`web-alb` の `TargetResponseTime` を、直近 1 時間の平均で表示する',
        tasks: [
          {
            id: 'list',
            title: '`list-metrics` で `web-alb` のディメンションの値を調べる',
            hint: '`aws cloudwatch list-metrics --namespace AWS/ApplicationELB --metric-name TargetResponseTime`。`Dimensions` の `Value` (`app/web-alb/…`) を使います。',
            command: 'aws cloudwatch list-metrics --namespace AWS/ApplicationELB --metric-name TargetResponseTime',
            done: (c) => !!ranAws(c, 'cloudwatch list-metrics', (x) => x.output.includes(albDim(c.env))),
          },
          {
            id: 'stats',
            title: '`get-metric-statistics` で直近 1 時間の `TargetResponseTime` を表示する',
            hint: '`NOW=$(date +%s)` のあと、`--namespace AWS/ApplicationELB --metric-name TargetResponseTime --dimensions Name=LoadBalancer,Value=app/web-alb/… --statistics Average --period 300 --start-time $((NOW - 3600)) --end-time $NOW --output table`。値がいつから変わったかを見ます。',
            command: (c) => statsCmd('AWS/ApplicationELB', 'TargetResponseTime', `Name=LoadBalancer,Value=${albDim(c.env)}`, 300),
            done: (c) => !!statsOf(c, 'AWS/ApplicationELB', 'TargetResponseTime', [albDim(c.env)], sinceIncident(c)),
          },
        ],
        validate: (c) =>
          statsOf(c, 'AWS/ApplicationELB', 'TargetResponseTime', [albDim(c.env)], sinceIncident(c))
            ? ok(
                node('40 分くらい前の `Timestamp` から、0.05 くらいだった `Average` が一気に数十倍に跳ね上がってます！ `Unit` は `Seconds` だから秒ですね。'),
                hakase('TargetResponseTime は「ALB がターゲットにリクエストを送ってから応答が返ってくるまで」の時間だったな。つまり遅いのは ALB より**後ろ**だ。'),
                node('受付は無実。次は奥の EC2 ですね。'),
                hakase('うむ。EC2 の CPU 使用率を見るのだ。CPU が悲鳴を上げていれば、アプリの計算が重いということになる。'),
              )
            : ng(
                hakase('web-alb の TargetResponseTime を、1 時間前から取り出すのだ。`--dimensions Name=LoadBalancer,Value=<list-metrics で見た app/web-alb/…>` に、`--start-time $((NOW - 3600)) --end-time $NOW` だ。'),
                hakase('範囲が短すぎると、遅くなる前の値が見えんぞ。比べる相手がいなければ、異常も異常に見えん。'),
              ),
      },
      4: {
        type: 'exercise',
        title: 'EC2 の CPU を見る',
        objective: '`web-1` か `web-2` の `CPUUtilization` を、直近 1 時間の平均で表示する',
        tasks: [
          {
            id: 'cpu',
            title: '`get-metric-statistics` で `web-1` (または `web-2`) の CPU 使用率を表示する',
            hint: "インスタンス ID は `aws ec2 describe-instances --filters Name=tag:Name,Values=web-1 --query 'Reservations[].Instances[].InstanceId' --output text` で調べます。ALB の応答時間が跳ね上がった時刻に、CPU 使用率も上がっているかを見比べます。",
            command: (c) => statsCmd('AWS/EC2', 'CPUUtilization', `Name=InstanceId,Value=${idOf(c.env, 'web-1')}`, 300),
            done: (c) => !!statsOf(c, 'AWS/EC2', 'CPUUtilization', [idOf(c.env, 'web-1'), idOf(c.env, 'web-2')], sinceIncident(c)),
          },
        ],
        validate: (c) =>
          statsOf(c, 'AWS/EC2', 'CPUUtilization', [idOf(c.env, 'web-1'), idOf(c.env, 'web-2')], sinceIncident(c))
            ? ok(
                node('CPU は 10% 前後で、40 分前と変わりません。'),
                hakase('アプリのサーバーは暇そうだな。CPU が原因なら 90% 以上に張り付くはずだ。ということは、アプリは**何かを待っている**。'),
                node('何かって…EC2 の後ろにいるのは RDS ですね。'),
                hakase('そうだ。RDS では `CPUUtilization` と `DatabaseConnections` を見る。DatabaseConnections は DB につながっている接続の数、銀行の窓口に並んでいる客の数のようなものだ。名前空間は `AWS/RDS`、ディメンションは `DBInstanceIdentifier` に DB の名前だ。'),
                node('窓口が詰まってたら、行列がどんどん伸びる、と。'),
              )
            : ng(hakase('web-1 か web-2 の CPUUtilization を、1 時間前から取り出すのだ。`--namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=InstanceId,Value=<web-1 の ID>` だ。ID は `aws ec2 describe-instances` で調べたまえ。')),
      },
      5: {
        type: 'exercise',
        title: 'RDS のメトリクスを見る',
        objective: '`webapp-db` の `CPUUtilization` と `DatabaseConnections` を、直近 1 時間の平均で表示する',
        tasks: [
          {
            id: 'cpu',
            title: '`webapp-db` の `CPUUtilization` を表示する',
            hint: '`--namespace AWS/RDS --metric-name CPUUtilization --dimensions Name=DBInstanceIdentifier,Value=webapp-db`。RDS は 1 分間隔でデータが届きますが、`--period 300` で 5 分ごとにまとめると見やすくなります。',
            command: statsCmd('AWS/RDS', 'CPUUtilization', 'Name=DBInstanceIdentifier,Value=webapp-db', 300),
            done: (c) => !!statsOf(c, 'AWS/RDS', 'CPUUtilization', ['webapp-db'], sinceIncident(c)),
          },
          {
            id: 'conn',
            title: '`webapp-db` の `DatabaseConnections` を表示する',
            hint: '↑ キーで前のコマンドを呼び出し、`--metric-name` を `DatabaseConnections` に変えます。',
            command: statsCmd('AWS/RDS', 'DatabaseConnections', 'Name=DBInstanceIdentifier,Value=webapp-db', 300),
            done: (c) => !!statsOf(c, 'AWS/RDS', 'DatabaseConnections', ['webapp-db'], sinceIncident(c)),
          },
        ],
        validate: (c) =>
          statsOf(c, 'AWS/RDS', 'CPUUtilization', ['webapp-db'], sinceIncident(c)) && statsOf(c, 'AWS/RDS', 'DatabaseConnections', ['webapp-db'], sinceIncident(c))
            ? ok(
                node('CPUUtilization が 90% を超えて張り付いてます！ 接続数も 10 くらいから 40 以上に増えてます。'),
                hakase('見えてきたな。DB が CPU を使い切ってクエリの完了が遅れ、待っている接続がどんどん溜まる。アプリはその間ずっと待たされるから、EC2 の CPU は上がらないのだ。'),
                node('DB が重い理由は、どうやって調べるんですか？'),
                hakase(`RDS は、時間のかかった**クエリ** (DB への問い合わせ文、SQL のことだ) を**スロークエリログ**に書き残して、CloudWatch Logs に送っておる。ロググループは \`${SLOW_LOG}\` だ。`),
                hakase('各ログには `Rows_examined`、つまりそのクエリが**読んだ行数**が載っておる。ロググループの一覧は `aws logs describe-log-groups`、中身の検索は `aws logs filter-log-events` だ。`--filter-pattern` でフィルタリングしてみるのだ。'),
              )
            : ng(hakase('webapp-db の CPUUtilization と DatabaseConnections を、両方とも 1 時間前から取り出すのだ。`--namespace AWS/RDS --dimensions Name=DBInstanceIdentifier,Value=webapp-db` で、`--metric-name` だけを変えて 2 回打つ。')),
      },
      6: {
        type: 'exercise',
        title: 'スロークエリログを調べる',
        objective: `CloudWatch Logs のロググループ \`${SLOW_LOG}\` のログイベントを、\`Rows_examined\` でフィルタリングして読む`,
        tasks: [
          {
            id: 'group',
            title: '`aws logs describe-log-groups` で `…/webapp-db/slowquery` を見つける',
            hint: 'RDS のログは `/aws/rds/instance/<DB 名>/<ログの種類>` という名前のロググループに届きます。`--log-group-name-prefix /aws/rds` で絞れます。',
            command: 'aws logs describe-log-groups --log-group-name-prefix /aws/rds',
            done: (c) => !!ranAws(c, 'logs describe-log-groups', (x) => x.output.includes(SLOW_LOG)),
          },
          {
            id: 'filter',
            title: '`aws logs filter-log-events` で `Rows_examined` を含むイベントを読む',
            hint: `\`aws logs filter-log-events --log-group-name ${SLOW_LOG} --filter-pattern Rows_examined --limit 3\`。フィルターは大文字と小文字を区別します。\`--query 'events[].message' --output text\` を付けると、改行がそのまま出て読みやすくなります。`,
            command: `aws logs filter-log-events --log-group-name ${SLOW_LOG} --filter-pattern Rows_examined --limit 3 --query 'events[].message' --output text`,
            done: (c) => ranAny(c, ['logs filter-log-events', 'logs tail'], (x) => [param(x, 'log-group-name'), param(x, 'group-name')].includes(SLOW_LOG) && /Rows_examined|Query_time|orders/.test(param(x, 'filter-pattern'))),
          },
        ],
        validate: (c) =>
          ranAny(c, ['logs filter-log-events', 'logs tail'], (x) => [param(x, 'log-group-name'), param(x, 'group-name')].includes(SLOW_LOG) && /Rows_examined|Query_time|orders/.test(param(x, 'filter-pattern')))
            ? ok(
                node('`SELECT * FROM orders WHERE customer_id = …` が 1 回 8 秒くらいかかってて、`Rows_examined: 24xxxxx`！ 20 行返すのに 240 万行も読んでます。'),
                hakase('`customer_id` に**インデックス**がないから、毎回テーブルを全部読んでおるのだ。これを**フルスキャン**という。'),
                node('いんでっくす？'),
                hakase('本の巻末の索引だ。索引があれば目当てのページに直行できるが、なければ 1 ページ目から全部めくるしかない。240 万ページの本を、注文履歴を開くたびにな。'),
                hakase('40 分前のリリースで、この注文履歴のクエリが入ったのだろう。新機能と障害は、たいてい同じ日にやってくる。'),
              )
            : ng(hakase(`スロークエリログを \`Rows_examined\` でフィルタリングするのだ。\`aws logs filter-log-events --log-group-name ${SLOW_LOG} --filter-pattern Rows_examined\` だ。大文字と小文字は区別されるぞ。`)),
      },
      7: {
        type: 'exercise',
        title: 'RDS の CPU にアラームを設定する',
        objective: '`webapp-db` の `CPUUtilization` (平均 / 60 秒) が **80 より大きい** ときのアラーム `webapp-db-cpu-high` を作成し、状態を確かめる',
        tasks: [
          {
            id: 'create',
            title: 'アラーム `webapp-db-cpu-high` を作成する (平均 / 60 秒 / 80 より大きい)',
            hint: '`aws cloudwatch put-metric-alarm` で、`--namespace AWS/RDS --metric-name CPUUtilization --dimensions Name=DBInstanceIdentifier,Value=webapp-db` を見張ります。RDS は 1 分間隔でデータが届くので、`--period 60` にします。',
            command: 'aws cloudwatch put-metric-alarm --alarm-name webapp-db-cpu-high --namespace AWS/RDS --metric-name CPUUtilization --dimensions Name=DBInstanceIdentifier,Value=webapp-db --statistic Average --period 60 --evaluation-periods 1 --threshold 80 --comparison-operator GreaterThanThreshold',
            done: (c) => watches(alarmNamed(c.env, 'webapp-db-cpu-high'), 'AWS/RDS', 'CPUUtilization', 'webapp-db'),
          },
          {
            id: 'state',
            title: '`describe-alarms` で `StateValue` を見る',
            hint: '`aws cloudwatch describe-alarms --alarm-names webapp-db-cpu-high`。',
            command: 'aws cloudwatch describe-alarms --alarm-names webapp-db-cpu-high',
            done: (c) => {
              const a = alarmNamed(c.env, 'webapp-db-cpu-high');
              return !!a && sawAlarm(c, a.alarmName, a.createdAt);
            },
          },
        ],
        validate: (c) => {
          const a = alarmNamed(c.env, 'webapp-db-cpu-high');
          if (!watches(a, 'AWS/RDS', 'CPUUtilization', 'webapp-db')) return ng(hakase('webapp-db の CPUUtilization を見る `webapp-db-cpu-high` が見当たらん。`--namespace AWS/RDS --metric-name CPUUtilization --dimensions Name=DBInstanceIdentifier,Value=webapp-db` で作るのだ。'));
          if (!above(a!) || a!.threshold !== 80) return ng(hakase('条件は「80 より大きい」だ。`--comparison-operator GreaterThanThreshold --threshold 80` にして、同じ `--alarm-name` で打ち直すのだ。上書きされる。'));
          return evaluateAlarm(c.env, a!).state === 'ALARM'
            ? ok(
                hakase('作った瞬間に `StateValue` が `ALARM` になったな。今まさに問題が起きている証拠だ。本番では最初からこういうアラームを用意して、お客様より先に気づけるようにしておくのだ。'),
                node('Lesson 24 では OK のままだったのに。…で、今燃えてる火はどうするんですか？'),
                hakase('まずは消火だ。Lesson 14 で選んだ `db.t3.micro` を覚えておるか。あれが **DB インスタンスクラス**、DB の体格だ。これを `db.m7g.xlarge` に上げて、**vCPU** (仮想的な CPU) を 2 つから 4 つにする。'),
                hakase('`aws rds modify-db-instance` に `--apply-immediately` を付けるのだ。付けないと「次回の定期メンテナンスウィンドウ」、つまり AWS が作業してよい夜中の時間帯まで待たされる。'),
                node('お客さんは夜中まで待ってくれませんもんね。'),
              )
            : ng(hakase('`StateValue` が `ALARM` になっていない。`describe-alarms` で `Statistic` が `Average`、`Period` が `60` になっているか見直すのだ。違っていれば同じ名前で打ち直したまえ。'));
        },
      },
      8: {
        type: 'exercise',
        title: '応急処置: DB インスタンスクラスを上げる',
        objective: '`webapp-db` の DB インスタンスクラスを `db.m7g.xlarge` (4 vCPU) に変え、すぐに適用する。変更が終わったらアラームが OK に戻ることを確認する',
        tasks: [
          {
            id: 'modify',
            title: '`aws rds modify-db-instance` でクラスを `db.m7g.xlarge` にする (`--apply-immediately`)',
            hint: '`aws rds modify-db-instance --db-instance-identifier webapp-db --db-instance-class db.m7g.xlarge --apply-immediately`。返ってくる `PendingModifiedValues` や `DBInstanceStatus` を見ます。',
            command: 'aws rds modify-db-instance --db-instance-identifier webapp-db --db-instance-class db.m7g.xlarge --apply-immediately',
            done: (c) => vcpu(dbNamed(c.env, 'webapp-db')?.dbInstanceClass) >= 4,
          },
          {
            id: 'wait',
            title: '`aws rds wait db-instance-available` で変更が終わるのを待つ',
            hint: '`aws rds wait db-instance-available --db-instance-identifier webapp-db`。状態が `available` になると、何も表示せずに戻ります。',
            command: 'aws rds wait db-instance-available --db-instance-identifier webapp-db',
            done: (c) => vcpu(dbNamed(c.env, 'webapp-db')?.dbInstanceClass) >= 4 && dbNamed(c.env, 'webapp-db')?.status === 'available',
          },
          {
            id: 'ok',
            title: 'アラーム `webapp-db-cpu-high` が `OK` に戻ったことを `describe-alarms` で確かめる',
            hint: "`aws cloudwatch describe-alarms --alarm-names webapp-db-cpu-high --query 'MetricAlarms[].[AlarmName,StateValue]' --output table`。",
            command: "aws cloudwatch describe-alarms --alarm-names webapp-db-cpu-high --query 'MetricAlarms[].[AlarmName,StateValue]' --output table",
            done: (c) => {
              const db = dbNamed(c.env, 'webapp-db');
              const a = alarmNamed(c.env, 'webapp-db-cpu-high');
              return db?.status === 'available' && vcpu(db.dbInstanceClass) >= 4 && !!a && evaluateAlarm(c.env, a).state === 'OK' && sawAlarm(c, a.alarmName, db.statusChangedAt);
            },
          },
        ],
        validate: (c) => {
          const db = dbNamed(c.env, 'webapp-db');
          if (vcpu(db?.dbInstanceClass) < 4) return ng(hakase('まだ vCPU が 4 つ以上のクラスになっていない。`aws rds modify-db-instance --db-instance-identifier webapp-db --db-instance-class db.m7g.xlarge --apply-immediately` だ。'));
          if (db?.status !== 'available') return ng(hakase('まだ変更中だ。`aws rds wait db-instance-available --db-instance-identifier webapp-db` で、`available` になるまで待つのだ。'), node('待つのも仕事のうち、ですね。'));
          const a = alarmNamed(c.env, 'webapp-db-cpu-high');
          if (a && evaluateAlarm(c.env, a).state !== 'OK') return ng(hakase('変更は終わったが、アラームがまだ `OK` に戻らん。新しいデータポイントが届くまで少し待ち、もう一度 `aws cloudwatch describe-alarms --alarm-names webapp-db-cpu-high` で状態を見るのだ。'));
          return ok(
            node('`StateValue` が `OK` に戻りました！ CPU は 50% くらいに下がって、応答時間も元通りです。'),
            hakase('ただしこれは**応急処置**だ。お金をかけて力で押し切っただけで、240 万行を読む無駄はそのまま残っている。'),
            node('痛み止めを飲んだだけで、虫歯は治ってない、みたいな？'),
            hakase('うむ。しかもこの痛み止め、1 時間あたりの料金は `db.t3.micro` のざっと 18 倍だ。'),
            node('請求書が届く前に、根本から直さないと…'),
          );
        },
      },
    },
  },

  /* ================= Lesson 26 ================= */
  'ssh-revoked': {
    steps: {
      0: {
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
          node('Lesson 22 で batch-1 に入ったときに使ったやつですよね。`aws ec2-instance-connect ssh` を打つと、batch-1 の中のシェルにつながる。'),
          hakase('うむ。あれも中身は **SSH** だ。サーバーに遠隔でログインするための通信で、TCP の **22 番**ポートを使う。'),
          node('えすえすえいち、22 番。Lesson 01 のクイズで「全世界から SSH できる状態」って出てきたやつですね。'),
          hakase('そうだ。どんなに正しい鍵を持っていても、玄関のドア、つまりセキュリティグループが 22 番を通さなければ入れん。まずは症状を自分の目で確かめる。推測はそのあとだ。'),
        ],
      },
      1: {
        type: 'dialogue',
        lines: [
          node('でも「誰かが変えた」って、どうやって突き止めるんです？ チーム全員に「やりました？」って聞いて回るとか？'),
          hakase('それで正直に名乗り出る人間ばかりなら、世の障害報告書はもっと薄くなっておる。'),
          hakase('そこで **CloudTrail** だ。AWS に対する操作を「誰が・いつ・何をしたか」、1 件ずつ記録しておるサービスだ。'),
          node('くらうどとれいる？ トレイルって、山道のことですか。'),
          hakase('trail は「通った跡」「足跡」という意味だ。AWS の中を歩いた足跡が全部残る、と覚えておけ。'),
          node('防犯カメラみたいですね。'),
          hakase('良いたとえだ。AWS への操作は、すべて **API** の呼び出しで行われる。API とは、AWS に命令を出すための窓口だ。'),
          node('えーぴーあい？ 僕、ターミナルで `aws` を打ってるだけですけど。'),
          hakase('その `aws` コマンドが、中で API を呼んでおる。Lesson 01 で言ったな。Web 画面の Management Console のボタンも、裏では同じ API を呼ぶ。どちらから呼んでも、CloudTrail には **イベント** として同じように記録される。'),
          node('つまり、コンソールで押しても CLI で打っても、足跡の残り方は同じってことですね。'),
          hakase('そうだ。……足跡を消す方法はないのか、という顔をしておるな。'),
          node('してません！'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          hakase('記録を探すのは、CloudTrail の **イベント履歴** だ。CLI では `aws cloudtrail lookup-events` で引く。このリージョンで過去 90 日間に行われた操作が、新しい順に返ってくる。'),
          node('90 日… 3 か月前の僕のやらかしも残ってるってことですか。'),
          hakase('残念ながら全部だ。件数が多いから、**ルックアップ属性** で絞り込む。`--lookup-attributes AttributeKey=ResourceName,AttributeValue=sg-…` のように、キーを 1 つ選んで値を入れるのだ。キーには `Username` (ユーザー名)、`EventName` (イベント名)、`ResourceName` (リソース名) などがある。'),
          node('るっくあっぷ… look up は「調べる」ですよね。検索の条件ってことか。'),
          hakase('そうだ。今日は「batch-sg に何が起きたか」を知りたいから、`ResourceName` にセキュリティグループの ID (`sg-…`) を入れる。値は完全一致だ。1 文字違えば `"Events": []` が返るだけだ。'),
          node('並んだイベントの名前は、どう読めばいいんです？'),
          hakase('`EventName` は API の名前そのものだ。たとえば **AuthorizeSecurityGroupIngress** は、Authorize (許可する) + SecurityGroup + Ingress (入ってくる通信、つまりインバウンド)。'),
          node('「インバウンドルールを追加した」ってことですね。じゃあ、ルールを消したら？'),
          hakase('**RevokeSecurityGroupIngress**。Revoke は「取り消す」だ。今日の手がかりは、たぶんそいつだ。'),
          node('イベントの中身は、どこを見ればいいんですか。'),
          hakase('`CloudTrailEvent` に**イベントレコード**という JSON が入っておる。Lesson 21 のバケットポリシーと同じ書き方だな。誰が (`userIdentity`)、いつ (`eventTime`)、どこから (`sourceIPAddress`)、何を使って (`userAgent`)、どんな指定で (`requestParameters`) 呼んだかが書いてある。'),
          node('誰が、いつ、どこから、何で、どうした。僕の日報より詳しいじゃないですか。'),
          hakase('ただし、この JSON は**文字列**のまま入っておるから `\\"` だらけで読みにくい。`--query \'Events[0].CloudTrailEvent\' --output text` で取り出せば、素の JSON が出てくる。'),
        ],
      },
      3: {
        type: 'exercise',
        title: 'EC2 Instance Connect で接続してみる',
        objective: '`batch-1` に `aws ec2-instance-connect ssh` で接続し、どんなエラーになるか確認する',
        tasks: [
          {
            id: 'id',
            title: '`batch-1` のインスタンス ID を調べる',
            hint: "`aws ec2 describe-instances --filters Name=tag:Name,Values=batch-1 --query 'Reservations[].Instances[].InstanceId' --output text`。",
            command: "aws ec2 describe-instances --filters Name=tag:Name,Values=batch-1 --query 'Reservations[].Instances[].InstanceId' --output text",
            done: (c) => !!ranAws(c, 'ec2 describe-instances', (x) => x.output.includes(idOf(c.env, 'batch-1'))),
          },
          {
            id: 'try',
            title: '`aws ec2-instance-connect ssh` で `batch-1` に接続してみる',
            hint: '`aws ec2-instance-connect ssh --instance-id <batch-1 の ID>`。つながらなくても、表示されたエラーメッセージを読めば完了です。',
            command: (c) => `aws ec2-instance-connect ssh --instance-id ${idOf(c.env, 'batch-1')}`,
            done: (c) => !!failedAws(c, 'ec2-instance-connect ssh', 'ConnectTimeout'),
          },
        ],
        validate: (c) =>
          failedAws(c, 'ec2-instance-connect ssh', 'ConnectTimeout')
            ? ok(
                node('`ssh: connect to host … port 22: Connection timed out`… 22 番につながらないまま、時間切れになったみたいです。'),
                hakase('コンソールの「接続」ボタンで使う EC2 Instance Connect は、**AWS のサービスが持つ IP アドレス範囲** (東京リージョンは `3.112.23.0/29`) から、SSH (TCP 22) でインスタンスに入る。この学習環境の `aws ec2-instance-connect ssh` も、同じ道を通る。'),
                node('`/29` って Lesson 04 の CIDR ですよね。`/28` が 16 個だったから、`/29` はその半分の 8 個。'),
                hakase('ほう、正解だ。明日は雪か。セキュリティグループがその 8 個からの 22 番を許可していなければ、つながらん。次はそこを確かめる。'),
              )
            : ng(hakase('まずは batch-1 に入ってみるのだ。`aws ec2 describe-instances` で batch-1 の ID を調べ、`aws ec2-instance-connect ssh --instance-id <ID>` だ。')),
      },
      4: {
        type: 'exercise',
        title: 'セキュリティグループを確認する',
        objective: '`batch-1` のセキュリティグループ `batch-sg` のインバウンドルールを確認する',
        tasks: [
          {
            id: 'sg',
            title: '`aws ec2 describe-security-groups` で `batch-sg` の `IpPermissions` を見る',
            hint: '`aws ec2 describe-security-groups --filters Name=group-name,Values=batch-sg`。`GroupId` (`sg-…`) は次の調査で使います。',
            command: 'aws ec2 describe-security-groups --filters Name=group-name,Values=batch-sg',
            done: (c) => ranAny(c, ['ec2 describe-security-groups', 'ec2 describe-security-group-rules'], (x) => x.output.includes(sgId(c.env, 'batch-sg'))),
          },
        ],
        validate: (c) =>
          ranAny(c, ['ec2 describe-security-groups', 'ec2 describe-security-group-rules'], (x) => x.output.includes(sgId(c.env, 'batch-sg')))
            ? ok(
                node('`IpPermissions` の SSH は `198.51.100.24/32` (オフィス) の 1 つだけです。EC2 Instance Connect の範囲がありません！'),
                hakase('`/32` はアドレス 1 個ぴったり。つまり今は、オフィスからしか入れんわけだ。'),
                node('でも昨日までは入れたんだから、昨日までは誰かが EC2 Instance Connect の範囲も許可してたはずですよね。'),
                hakase('そうだ。いつ、誰が、何を消したのか。当てずっぽうで犯人探しをする前に、CloudTrail で**事実**を確かめよう。'),
              )
            : ng(hakase('batch-sg のインバウンドルールを見るのだ。`aws ec2 describe-security-groups --filters Name=group-name,Values=batch-sg` の `IpPermissions` だ。')),
      },
      5: {
        type: 'exercise',
        title: 'CloudTrail で変更を探す',
        objective: '`aws cloudtrail lookup-events` をルックアップ属性 `ResourceName` = `batch-sg` のグループ ID で絞り込み、`RevokeSecurityGroupIngress` のイベントレコードを読む',
        tasks: [
          {
            id: 'lookup',
            title: '`ResourceName` に `sg-…` を指定して `lookup-events` を実行する',
            hint: '`aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=<batch-sg の ID>`。値は完全一致です。',
            command: (c) => `aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=${sgId(c.env, 'batch-sg')}`,
            done: (c) => !!ranAws(c, 'cloudtrail lookup-events', (x) => [`ResourceName=${sgId(c.env, 'batch-sg')}`, 'EventName=RevokeSecurityGroupIngress'].includes(lookup(x))),
          },
          {
            id: 'open',
            title: '`RevokeSecurityGroupIngress` の `CloudTrailEvent` を取り出して読む',
            hint: "前のコマンドに `--query 'Events[0].CloudTrailEvent' --output text` を足します。`userIdentity`・`eventTime`・`userAgent`・`requestParameters` を読みます。",
            command: (c) => `aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=${sgId(c.env, 'batch-sg')} --query 'Events[0].CloudTrailEvent' --output text`,
            done: (c) => !!ranAws(c, 'cloudtrail lookup-events', (x) => !!x.query?.includes('CloudTrailEvent') && x.output.includes(revokeEvent(c.env)?.eventId ?? '-')),
          },
        ],
        validate: (c) =>
          ranAws(c, 'cloudtrail lookup-events', (x) => !!x.query?.includes('CloudTrailEvent') && x.output.includes(revokeEvent(c.env)?.eventId ?? '-'))
            ? ok(
                node('`eventTime` は `…T09:42:00Z`。UTC だから 9 時間足して、日本時間だと昨日の 18:42 ですね。**tanaka** さんが `RevokeSecurityGroupIngress` を実行してます。'),
                node('`userAgent` が `aws-cli/…` で、最後に `md/command#ec2.revoke-security-group-ingress` とあります。コンソールじゃなくて、僕と同じ CLI からですね。'),
                hakase('`requestParameters` を見ると、消されたのは `3.112.23.0/29` の TCP 22、説明は「EC2 Instance Connect」。使っていないルールを整理するつもりだったのだろう。'),
                node('犯人がわかりました！ tanaka さんに始末書を……'),
                hakase('始末書で次の事故が防げるなら、ワシの机の引き出しはとっくに空だ。**人を責めるのではなく、記録で事実を確かめる**。これが調査の基本だ。今やるべきなのは、消されたルールを記録どおりに戻すことだ。'),
              )
            : ng(hakase("RevokeSecurityGroupIngress のイベントレコードを読むのだ。`--lookup-attributes AttributeKey=ResourceName,AttributeValue=<batch-sg の ID>` に、`--query 'Events[0].CloudTrailEvent' --output text` を足せば取り出せる。")),
      },
      6: {
        type: 'exercise',
        title: '消されたルールを元に戻す',
        objective: '`batch-sg` のインバウンドルールに、イベントレコードに残っていたルール (TCP 22 / `3.112.23.0/29` / 説明 `EC2 Instance Connect`) を追加する',
        tasks: [
          {
            id: 'add',
            title: '`aws ec2 authorize-security-group-ingress` でルールを追加する',
            hint: "`--group-id <batch-sg の ID> --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=3.112.23.0/29,Description=\"EC2 Instance Connect\"}]'`。説明を付けないなら `--protocol tcp --port 22 --cidr 3.112.23.0/29` でも構いません。",
            command: (c) => `aws ec2 authorize-security-group-ingress --group-id ${sgId(c.env, 'batch-sg')} --ip-permissions 'IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=3.112.23.0/29,Description="EC2 Instance Connect"}]'`,
            done: (c) => sgAllows(c.env, 'batch-sg', 22, { ip: EIC_IP }),
          },
        ],
        validate: (c) => {
          if (sgAllows(c.env, 'batch-sg', 22, { ip: '192.0.2.200' }))
            return ng(hakase('待て、SSH を 0.0.0.0/0 (全世界) に開けてはいかん！ 世界中のボットが 22 番を叩きに来るぞ。`aws ec2 revoke-security-group-ingress --group-id <ID> --protocol tcp --port 22 --cidr 0.0.0.0/0` で消し、EC2 Instance Connect の範囲 `3.112.23.0/29` だけを許可するのだ。'));
          if (!sgAllows(c.env, 'batch-sg', 22, { ip: EIC_IP })) return ng(hakase('まだ `3.112.23.0/29` からの SSH が許可されていない。`aws ec2 authorize-security-group-ingress --group-id <batch-sg の ID>` に、TCP 22 と `3.112.23.0/29` を指定するのだ。'));
          return ok(
            hakase('よし。消えたものを、消える前と同じ形で戻せた。'),
            node('記録にルールの中身まで残ってたから、「とりあえず全開放」にしなくて済んだんですね。'),
            hakase('そうだ。推測で広く開けるのは、鍵をなくしたからといって玄関のドアを外すようなものだ。'),
            hakase('つながるかを確かめる前に、1 つ見ておくものがある。今の君の操作も、CloudTrail に残っておるはずだ。'),
          );
        },
      },
      // ponytail: コンソール版では「接続を確認する」→「自分の操作も記録されている」の順。CLI 版は batch-1 に入るとシェルがインスタンスの中に移り、
      // exit が記録されず判定できないので、ローカルで打つ「自分の操作」を先にした。exit を記録できるようになったら元の順に戻す
      7: {
        type: 'exercise',
        title: '自分の操作も記録されている',
        objective: '`aws cloudtrail lookup-events` で、ユーザー名 `learner` の `AuthorizeSecurityGroupIngress` イベントを見る',
        tasks: [
          {
            id: 'mine',
            title: '`Username` = `learner` で `lookup-events` を実行し、自分の `AuthorizeSecurityGroupIngress` を見る',
            hint: "`aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=learner`。`--query 'Events[0].CloudTrailEvent' --output text` でイベントレコードも読めます。",
            command: "aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=learner --query 'Events[0].CloudTrailEvent' --output text",
            done: (c) => {
              const e = learnerEvent(c.env, 'AuthorizeSecurityGroupIngress', sgId(c.env, 'batch-sg'));
              return !!e && !!ranAws(c, 'cloudtrail lookup-events', (x) => x.at >= e.eventTime && ['Username=learner', 'EventName=AuthorizeSecurityGroupIngress', `ResourceName=${sgId(c.env, 'batch-sg')}`].includes(lookup(x)));
            },
          },
        ],
        validate: (c) => {
          const e = learnerEvent(c.env, 'AuthorizeSecurityGroupIngress', sgId(c.env, 'batch-sg'));
          return e && ranAws(c, 'cloudtrail lookup-events', (x) => x.at >= e.eventTime && ['Username=learner', 'EventName=AuthorizeSecurityGroupIngress', `ResourceName=${sgId(c.env, 'batch-sg')}`].includes(lookup(x)))
            ? ok(
                node('さっきの自分の操作が、`userName` は `learner`、`userAgent` は `aws-cli/…` で記録されています。`md/command#ec2.authorize-security-group-ingress` って、打ったコマンドまで。'),
                hakase('CloudTrail は、誰の操作も同じように記録する。新人でも、管理者でも、ワシでもだ。'),
                node('博士の操作も残るんですね。今度じっくり見ておきます。'),
                hakase('……だから障害調査にも、セキュリティ監査にも使えるのだ。余計なところは見んでよい。さて、batch-1 につながるか確かめるのだ。'),
              )
            : ng(hakase('learner の AuthorizeSecurityGroupIngress イベントを見るのだ。`aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=learner` で絞り込めばよい。ルールを戻す前に打ったものは数えんぞ。'));
        },
      },
      8: {
        type: 'exercise',
        title: '接続を確認する',
        objective: 'もう一度 `aws ec2-instance-connect ssh` で `batch-1` に接続し、`whoami` を実行する',
        tasks: [
          {
            id: 'connect',
            title: '`aws ec2-instance-connect ssh` で `batch-1` に接続する',
            hint: '↑ キーで、さっきの `aws ec2-instance-connect ssh --instance-id <batch-1 の ID>` を呼び出せます。プロンプトが `[ec2-user@ip-… ~]$` に変われば、batch-1 の中です。',
            command: (c) => `aws ec2-instance-connect ssh --instance-id ${idOf(c.env, 'batch-1')}`,
            done: (c) => !!ranAws(c, 'ec2-instance-connect ssh', (x) => param(x, 'instance-id') === idOf(c.env, 'batch-1')),
          },
          {
            id: 'whoami',
            title: 'batch-1 の中で `whoami` を実行する',
            hint: '接続できたら `whoami` と打ちます。終わったら `exit` で自分の PC に戻れます。',
            command: 'whoami',
            done: (c) => !!lastRun(c, 'batch-1', /^\s*whoami/)?.ok,
          },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /^\s*whoami/)?.ok && eicConnectivity(c.env, idOf(c.env, 'batch-1')).ok
            ? ok(
                node('`ec2-user` と出ました！ つながりました。'),
                hakase('`whoami` は「私は誰？」に答えるコマンドだ。`ec2-user` は、Amazon Linux に最初から用意されているログイン用のユーザーだな。'),
                node('自分が誰かわからなくなったら、僕も打ってみます。'),
                hakase('君の場合、返ってくるのは「新人」だろうがな。'),
              )
            : ng(hakase('まだ whoami が成功していない。`aws ec2-instance-connect ssh --instance-id <batch-1 の ID>` でつないでから、`whoami` と打つのだ。')),
      },
    },
  },

  /* ================= Lesson 27 ================= */
  'config-audit': {
    summary: 'ルールで設定を自動チェックし、非準拠の原因を設定の履歴と CloudTrail でたどって直す',
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('ルールって、全部自分で書かないといけないんですか？'),
          hakase('よくあるものは AWS が用意しておる。**AWS マネージドルール** という。`RDS_STORAGE_ENCRYPTED` のような識別子を指定して、追加するだけだ。'),
          node('まねーじど… Lesson 14 で RDS を「マネージドな MySQL」って言ってましたよね。AWS が面倒を見てくれるってやつ。'),
          hakase('その「マネージド」だ。このアカウントには、もう 3 つ入っておる。まず `restricted-ssh`。SSH の全開放を禁止するルールだ。'),
          node('restricted は「制限された」ですね。'),
          hakase('次に `s3-bucket-public-read-prohibited`。prohibited は「禁止された」。バケットを誰でも読める状態にするのを禁止する。'),
          node('Lesson 21 でブロックパブリックアクセスを緩めて、バケットポリシーで公開したやつ。あれをやると引っかかるんですね。'),
          hakase('そうだ。3 つ目の `rds-instance-public-access-check` は、RDS がインターネットから直接つながる設定になっていないかを見る。'),
          node('Lesson 14 で作った webapp-db の、`PubliclyAccessible` が `false` のやつですね。'),
          hakase('そして最後に、君にもう 1 つ `rds-storage-encrypted` を追加してもらう。RDS のディスクが**暗号化**されているかを見るルールだ。'),
          node('あんごうか？'),
          hakase('鍵を持つ者にしか読めない形でデータを保存することだ。ディスクを盗まれても、中身は読めん。……ルールは増やすほど評価の料金がかかるから、面白がって全部足すでないぞ。'),
        ],
      },
      3: {
        type: 'dialogue',
        lines: [
          node('CloudWatch、CloudTrail、Config… 名前が似てて、頭の中で混ざりそうです。'),
          hakase('役割で覚えろ。CloudWatch は Lesson 24 でやった「今どうなっている？」を数字で見る**体温計**だ。'),
          node('CloudTrail は Lesson 26 の「誰が・いつ・何をした？」を残す**防犯カメラ**でしたよね。'),
          hakase('そして Config は「設定はルールどおりか？」を調べる**健康診断**だ。'),
          node('表には「いつから変わった？」ともありますね。'),
          hakase('Config は設定を記録し続けておるから、リソースごとの**設定の履歴** (設定の変更の年表) が `aws configservice get-resource-config-history` で引ける。いつ変わったかが分かれば、誰が変えたかは CloudTrail ですぐ引ける。'),
          node('健康診断の結果と、防犯カメラの映像を突き合わせるってことですか。'),
          hakase('そういうことだ。言い逃れは一切できん。まずは全体の採点結果だ。コンソールなら**ダッシュボード**、車の運転席のメーターのように全体が一目でわかる画面で見るところだな。'),
          node('CLI だと？'),
          hakase('`aws configservice describe-compliance-by-config-rule` が、ルールごとの結果を一覧にしてくれる。`ComplianceType` が `NON_COMPLIANT` のルールが要再検査だ。スピード違反も一目でわかる。'),
        ],
      },
      4: {
        type: 'exercise',
        title: 'ルールごとの準拠状況を見る',
        objective: '`aws configservice describe-compliance-by-config-rule` で、非準拠のルールを確認する',
        tasks: [
          {
            id: 'dash',
            title: '`aws configservice describe-compliance-by-config-rule` を実行する',
            hint: '`ComplianceType` が `NON_COMPLIANT` のルールに注目します。`--compliance-types NON_COMPLIANT` で非準拠のものだけに絞れます。',
            command: 'aws configservice describe-compliance-by-config-rule',
            done: (c) => !!ranAws(c, 'configservice describe-compliance-by-config-rule'),
          },
        ],
        validate: (c) =>
          ranAws(c, 'configservice describe-compliance-by-config-rule')
            ? ok(
                node('`NON_COMPLIANT` のルールが 2 つあります。'),
                hakase('`restricted-ssh` と `s3-bucket-public-read-prohibited` だな。`CappedCount` が非準拠のリソースの数だ。健康診断で 2 項目、要再検査だ。'),
                node('放っておくと、監査で呼び出されるやつですね。1 つずつ見ていきましょう。'),
              )
            : ng(hakase('`aws configservice describe-compliance-by-config-rule` を打つのだ。サービス名は `config` ではなく `configservice` だぞ。')),
      },
      5: {
        type: 'exercise',
        title: '非準拠のリソースと、その変更履歴を調べる',
        objective: 'ルール `restricted-ssh` で非準拠のリソースを見つけ、その設定の履歴と CloudTrail のイベントを確認する',
        tasks: [
          {
            id: 'rule',
            title: '`get-compliance-details-by-config-rule` で `restricted-ssh` の非準拠のリソースを見る',
            hint: '`aws configservice get-compliance-details-by-config-rule --config-rule-name restricted-ssh --compliance-types NON_COMPLIANT`。`ResourceId` (`sg-…`) と `Annotation` を見ます。',
            command: 'aws configservice get-compliance-details-by-config-rule --config-rule-name restricted-ssh --compliance-types NON_COMPLIANT',
            done: (c) => !!ranAws(c, 'configservice get-compliance-details-by-config-rule', (x) => param(x, 'config-rule-name') === 'restricted-ssh'),
          },
          {
            id: 'history',
            title: '`get-resource-config-history` でそのセキュリティグループの設定を見る',
            hint: '`aws configservice get-resource-config-history --resource-type AWS::EC2::SecurityGroup --resource-id <sg-…>`。`configurationItemCaptureTime` が設定を記録した時刻、`configuration` が設定の中身です。',
            command: (c) => `aws configservice get-resource-config-history --resource-type AWS::EC2::SecurityGroup --resource-id ${sgId(c.env, 'web-sg')}`,
            done: (c) => !!ranAws(c, 'configservice get-resource-config-history', (x) => param(x, 'resource-id') === sgId(c.env, 'web-sg')),
          },
          {
            id: 'trail',
            title: '`lookup-events` で、誰がそのセキュリティグループを変えたかを見る',
            hint: "`aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=<sg-…>`。`--query 'Events[].[EventTime,Username,EventName]' --output table` で一覧にすると見やすくなります。",
            command: (c) => `aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=${sgId(c.env, 'web-sg')} --query 'Events[].[EventTime,Username,EventName]' --output table`,
            done: (c) => !!ranAws(c, 'cloudtrail lookup-events', (x) => lookup(x) === `ResourceName=${sgId(c.env, 'web-sg')}`),
          },
        ],
        validate: (c) =>
          ranAws(c, 'configservice get-resource-config-history', (x) => param(x, 'resource-id') === sgId(c.env, 'web-sg')) && ranAws(c, 'cloudtrail lookup-events', (x) => lookup(x) === `ResourceName=${sgId(c.env, 'web-sg')}`)
            ? ok(
                node('web-sg の `configuration` に 0.0.0.0/0 の SSH があって、説明は「temporary debug」… 記録した時刻は、日本時間で昨日の 16:05 です。CloudTrail を見ると、その時刻に tanaka さんが AuthorizeSecurityGroupIngress を実行してます。'),
                hakase('「一時的なつもりで開けて、閉じ忘れる」。よくある話だ。この世で一番長生きする設定は、「一時的」と書かれた設定だ。'),
                node('Config が「今の状態がルール違反」だと教えてくれて、CloudTrail が「誰がいつそうしたか」を教えてくれた、ってことですね。'),
                hakase('そうだ。2 つを組み合わせて使うのだ。'),
              )
            : ng(
                hakase('restricted-ssh で非準拠のセキュリティグループの、設定の履歴と CloudTrail のイベントを見るのだ。ID は `get-compliance-details-by-config-rule --config-rule-name restricted-ssh` の `ResourceId` だ。'),
                hakase('その ID で `get-resource-config-history --resource-type AWS::EC2::SecurityGroup --resource-id <ID>` と、`lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=<ID>` を打ちたまえ。'),
              ),
      },
      6: {
        type: 'exercise',
        title: 'SSH の全開放を閉じる',
        objective: '`web-sg` から 0.0.0.0/0 の SSH ルールを削除して `restricted-ssh` を準拠にする。ALB からの TCP 3000 は残すこと',
        tasks: [
          {
            id: 'fix',
            title: '`aws ec2 revoke-security-group-ingress` で 0.0.0.0/0 の SSH だけを削除する',
            hint: '`aws ec2 revoke-security-group-ingress --group-id <web-sg の ID> --protocol tcp --port 22 --cidr 0.0.0.0/0`。`Annotation` にあったルール ID を `--security-group-rule-ids sgr-…` で指定しても消せます。',
            command: (c) => `aws ec2 revoke-security-group-ingress --group-id ${sgId(c.env, 'web-sg')} --protocol tcp --port 22 --cidr 0.0.0.0/0`,
            done: (c) => compliant(c.env, 'restricted-ssh'),
          },
          {
            id: 'check',
            title: '`restricted-ssh` が `COMPLIANT` になったことを確かめる',
            hint: '`aws configservice describe-compliance-by-config-rule --config-rule-names restricted-ssh`。',
            command: 'aws configservice describe-compliance-by-config-rule --config-rule-names restricted-ssh',
            done: (c) => {
              const e = learnerEvent(c.env, 'RevokeSecurityGroupIngress', sgId(c.env, 'web-sg'));
              return compliant(c.env, 'restricted-ssh') && !!e && !!sawCompliance(c, 'restricted-ssh', e.eventTime);
            },
          },
        ],
        validate: (c) => {
          if (!albReachesWeb(c.env)) return ng(hakase('ALB からの 3000 番まで消してしまったぞ！ これではサイトが止まる。`aws ec2 authorize-security-group-ingress --group-id <web-sg の ID> --protocol tcp --port 3000 --source-group <alb-sg の ID>` で戻すのだ。消すのは SSH (22 番) のルールだけだ。'));
          return compliant(c.env, 'restricted-ssh')
            ? ok(
                node('restricted-ssh が `COMPLIANT` になりました！ サイトも止まってません。'),
                hakase('Config のルールは、設定が変わるたびに評価される。直せばすぐ結果に出るのだ。'),
                node('健康診断なのに、結果が出るのが早すぎますね。'),
                hakase('君の始末書も、このくらい早く出てくればよいのだがな。'),
              )
            : ng(hakase('まだ web-sg が 0.0.0.0/0 からの SSH を許可しておる。`aws ec2 revoke-security-group-ingress --group-id <web-sg の ID> --protocol tcp --port 22 --cidr 0.0.0.0/0` で消すのだ。'));
        },
      },
      7: {
        type: 'exercise',
        title: '公開バケットを非公開に戻す',
        objective: `\`${SHARE_BUCKET}\` のブロックパブリックアクセスを **4 つすべてオン** にして、\`s3-bucket-public-read-prohibited\` を準拠にする`,
        tasks: [
          {
            id: 'bpa',
            title: '`aws s3api put-public-access-block` で 4 つすべてを `true` にする',
            hint: `\`aws s3api put-public-access-block --bucket ${SHARE_BUCKET} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true\`。`,
            command: `aws s3api put-public-access-block --bucket ${SHARE_BUCKET} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true`,
            done: (c) => compliant(c.env, 's3-bucket-public-read-prohibited'),
          },
        ],
        validate: (c) =>
          compliant(c.env, 's3-bucket-public-read-prohibited')
            ? ok(
                node('`s3-bucket-public-read-prohibited` も準拠になりました。でも名前からして、取引先とファイルを共有したくて公開したんですよね…'),
                hakase('そういうときは、バケットを公開するのではなく**署名付き URL** を使う。'),
                node('しょめいつき？'),
                hakase('期限付きの許可が埋め込まれた URL だ。その URL を知っている人だけが、期限まで、そのファイルだけをダウンロードできる。誰でも持っていける街頭のチラシではなく、宛名入りの招待状だな。'),
              )
            : ng(hakase(`まだバケットが誰でも読める状態だ。\`aws s3api put-public-access-block --bucket ${SHARE_BUCKET}\` で、\`--public-access-block-configuration\` の 4 つすべてを \`true\` にするのだ。`)),
      },
      8: {
        type: 'exercise',
        title: 'ルールを追加する',
        objective: 'AWS マネージドルール `rds-storage-encrypted` (識別子 `RDS_STORAGE_ENCRYPTED`) を追加し、RDS の暗号化を評価する',
        tasks: [
          {
            id: 'add',
            title: '`aws configservice put-config-rule` で `rds-storage-encrypted` を追加する',
            hint: "`aws configservice put-config-rule --config-rule 'ConfigRuleName=rds-storage-encrypted,Source={Owner=AWS,SourceIdentifier=RDS_STORAGE_ENCRYPTED}'`。`Owner=AWS` が AWS マネージドルールの印です。成功しても何も表示されません。",
            command: "aws configservice put-config-rule --config-rule 'ConfigRuleName=rds-storage-encrypted,Source={Owner=AWS,SourceIdentifier=RDS_STORAGE_ENCRYPTED}'",
            done: (c) => c.env.configRules.some((r) => r.identifier === 'RDS_STORAGE_ENCRYPTED'),
          },
          {
            id: 'check',
            title: '`get-compliance-details-by-config-rule` で webapp-db の評価結果を見る',
            hint: '`aws configservice get-compliance-details-by-config-rule --config-rule-name rds-storage-encrypted`。',
            command: 'aws configservice get-compliance-details-by-config-rule --config-rule-name rds-storage-encrypted',
            done: (c) => {
              const r = c.env.configRules.find((x) => x.identifier === 'RDS_STORAGE_ENCRYPTED');
              return !!r && !!sawCompliance(c, r.configRuleName, r.createdAt);
            },
          },
        ],
        validate: (c) => {
          const r = c.env.configRules.find((x) => x.identifier === 'RDS_STORAGE_ENCRYPTED');
          if (!r) return ng(hakase("rds-storage-encrypted がまだ追加されていない。`aws configservice put-config-rule --config-rule 'ConfigRuleName=rds-storage-encrypted,Source={Owner=AWS,SourceIdentifier=RDS_STORAGE_ENCRYPTED}'` だ。"));
          return ruleCompliance(c.env, r).compliance === 'COMPLIANT'
            ? ok(
                node('webapp-db は `COMPLIANT` でした。ちゃんと暗号化されてるんですね。'),
                hakase('運が良かったな。RDS の暗号化は**作成するときにしか選べない**。'),
                node('え、あとから「暗号化オン」にできないんですか。'),
                hakase('できん。あとから暗号化するには、スナップショットを取り、暗号化してコピーし、そこから新しい DB を作り直す。スナップショットそのものは、次の Lesson 28 でやるぞ。'),
              )
            : ng(hakase(`評価結果を確認するのだ。\`aws configservice get-compliance-details-by-config-rule --config-rule-name ${r.configRuleName}\` で、webapp-db の準拠状況を見る。`));
        },
      },
      9: quiz27a,
      10: quiz27b,
    },
  },
};

export default patches;
