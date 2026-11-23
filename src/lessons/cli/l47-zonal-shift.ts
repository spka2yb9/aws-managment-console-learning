import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { configOf, zonalShiftEnabled } from '../../sim/ext/zonalshift';
import { ALB_5XX_ALARM, azAlarm, IMPAIRED_AZ } from '../../sim/ext/zonalshift-scenario';
import type { AwsEnv } from '../../sim/types';
import { activeShift, albRequests, autoshiftOn, azLabel, canceled, customerShifts, IMPAIRED_AZ_ID, outcomeAlarmNames, recovered, SHIFT_CHECK, threeShiftedOk, web2Ok } from '../l47-zonal-shift';
import { lbNamed } from '../helpers';
import { param, ranAws } from './helpers';
import type { CliPatches } from './types';

const alb = (env: AwsEnv) => lbNamed(env, 'web-alb');
const arn = (c: TaskContext) => alb(c.env)?.loadBalancerArn ?? 'arn:aws:elasticloadbalancing:ap-northeast-1:123456789012:loadbalancer/app/web-alb/xxxxxxxx';
const dns = (c: TaskContext) => alb(c.env)?.dnsName ?? 'web-alb-xxxxxxxxxx.ap-northeast-1.elb.amazonaws.com';
const tgArn = (c: TaskContext) => c.env.targetGroups.find((t) => t.targetGroupName === 'web-tg')?.targetGroupArn ?? 'arn:aws:elasticloadbalancing:...:targetgroup/web-tg/xxxxxxxx';
/** 1 秒おきに 3 回 curl する (ALB は時刻で振り分けるので、3 台に 1 回ずつ当たる) */
const curl3 = (c: TaskContext) => `for i in 1 2 3; do curl -sv http://${dns(c)}/; echo; sleep 1; done`;
/** AZ ごとの TargetResponseTime を for で並べる (ディメンションは LoadBalancer と AvailabilityZone の 2 つ) */
const azMetrics = (c: TaskContext) =>
  `NOW=$(date +%s); for az in ap-northeast-1a ap-northeast-1c ap-northeast-1d; do echo $az; aws cloudwatch get-metric-statistics --namespace AWS/ApplicationELB --metric-name TargetResponseTime --dimensions Name=LoadBalancer,Value=${arn(c).split(':loadbalancer/')[1]} Name=AvailabilityZone,Value=$az --start-time $((NOW - 1800)) --end-time $NOW --period 300 --statistics Average --query 'Datapoints[].Average' --output text; done`;
const sawAzMetrics = (c: TaskContext) => !!ranAws(c, 'cloudwatch get-metric-statistics', (x) => param(x, 'dimensions').includes('AvailabilityZone') && param(x, 'dimensions').includes(IMPAIRED_AZ));
const sawWeb2Error = (c: TaskContext) => albRequests(c).some((r) => r.status === 500 && r.hops.some((h) => h.hop.includes('(web-2)')));
const sawWeb2Az = (c: TaskContext) => !!ranAws(c, 'ec2 describe-instances', (x) => x.output.includes(IMPAIRED_AZ));
const shiftStart = (c: TaskContext) => customerShifts(c.env).find((s) => s.awayFrom === IMPAIRED_AZ_ID)?.startTime ?? Infinity;
const alarmArn = (c: TaskContext) => c.env.alarms.find((a) => a.alarmName === ALB_5XX_ALARM)?.alarmArn ?? `arn:aws:cloudwatch:ap-northeast-1:123456789012:alarm:${ALB_5XX_ALARM}`;
const hours = (env: AwsEnv) => {
  const s = activeShift(env);
  return s ? (s.expiryTime - s.startTime) / 3_600_000 : 0;
};

const patches: CliPatches = {
  'zonal-shift': {
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、ショップのお問い合わせです。注文ボタンを押すと、3 回に 1 回くらい、さんざん待たされたあげくにエラーになるそうです。'),
          hakase('3 回に 1 回、か。全部ダメなら話は早いのだがな。中途半端な障害ほど、人を夜更かしさせるものはない。'),
          node('先輩が仕込んだ CloudWatch のアラームも鳴ってます。`web-alb-5xx`、ALB の後ろのターゲットが返した 5XX エラーの数を見張るアラームです。'),
          hakase('Lesson 24 で作ったアラームの仲間だな。まずは今日の構成を確かめておこう。'),
          node('`web-alb` は 3 つの AZ にまたがっていて、ap-northeast-1a に web-1、1c に web-2、1d に web-3 がいます。'),
          hakase('Lesson 02 で「本番は 2 つ以上の AZ に分けて置く」と言ったな。先輩は 3 つに分けた。ワシの教えを 1.5 倍守っておる。'),
          node('だったら、1 台くらい調子が悪くても、ALB がヘルスチェックで外してくれるはずですよね？ Lesson 13 でやりました。'),
          hakase('「はず」か。君の「はず」が当たったためしがあったかな？ `aws elbv2 describe-target-health` で、ターゲットの `State` を確かめるのだ。'),
          node('アラームは `aws cloudwatch describe-alarms` ですね。`--state-value ALARM` を付けると、鳴っているものだけに絞れるんでしたっけ。'),
          hakase('うむ。名前の最後が `-1a` `-1c` `-1d` のアラームもある。先輩は AZ ごとにもアラームを分けておったのだ。`Dimensions` の `AvailabilityZone` を見れば、どの AZ のアラームか分かる。'),
        ],
      },
      2: {
        type: 'exercise',
        title: '症状を確かめる',
        objective: 'アラーム状態の AZ ごとのアラームを `describe-alarms` で見つけ、ターゲットグループ `web-tg` のヘルスを `describe-target-health` で確認する',
        tasks: [
          {
            id: 'alarm',
            title: '`aws cloudwatch describe-alarms --state-value ALARM` で、鳴っているアラームを一覧する',
            hint: "`--query 'MetricAlarms[].[AlarmName,Dimensions[1].Value]' --output table` を付けると、アラーム名と AZ だけが並びます (AZ ごとのアラームは `Dimensions` の 2 つ目が `AvailabilityZone` です)。",
            command: "aws cloudwatch describe-alarms --state-value ALARM --query 'MetricAlarms[].[AlarmName,Dimensions[1].Value]' --output table",
            done: (c) => !!ranAws(c, 'cloudwatch describe-alarms', (x) => x.output.includes(azAlarm(IMPAIRED_AZ))),
          },
          {
            id: 'health',
            title: '`aws elbv2 describe-target-health` で `web-tg` のターゲットのヘルスを見る',
            hint: "ターゲットグループの ARN は `aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text` で調べます。`--query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table` で見やすくなります。",
            command: (c) => `aws elbv2 describe-target-health --target-group-arn ${tgArn(c)} --query 'TargetHealthDescriptions[].[Target.Id,TargetHealth.State]' --output table`,
            done: (c) => !!ranAws(c, 'elbv2 describe-target-health'),
          },
        ],
        validate: (c) => {
          if (!ranAws(c, 'cloudwatch describe-alarms', (x) => x.output.includes(azAlarm(IMPAIRED_AZ)))) return ng(hakase('鳴っているアラームを一覧するのだ。`aws cloudwatch describe-alarms --state-value ALARM` だ。AZ ごとのアラームの名前が出てくるまで見るのだぞ。'));
          if (!ranAws(c, 'elbv2 describe-target-health')) return ng(hakase('次はターゲットのヘルスだ。`aws elbv2 describe-target-health --target-group-arn <web-tg の ARN>` で、3 台の `State` を見るのだ。'));
          return ok(
            node('アラーム状態なのは `web-alb-5xx` と `web-alb-5xx-1c` で、1a と 1d のアラームは出てきません。なのに、ターゲットは 3 台とも `healthy` でした。'),
            hakase('ap-northeast-1c のターゲット、つまり web-2 だけがエラーを返しておるわけだ。'),
            node('エラーを返してるのに `healthy` って、ヘルスチェックの目は節穴なんですか？'),
            hakase('節穴というより、見ている場所が狭いのだ。'),
          );
        },
      },
      3: {
        type: 'dialogue',
        lines: [
          hakase('ヘルスチェックが見るのは `/health` だけだったな。30 秒に 1 回「生きてるか？」と聞いて、5 秒以内に 200 が返れば合格だ。'),
          node('Lesson 13 でやりました。2 回続けて失敗したら異常 (unhealthy) にする、でしたよね。'),
          hakase('そうだ。今、ap-northeast-1c の中ではネットワークが不安定で、パケットがときどき落ちておる。重い注文のリクエストは待たされて時間切れになるが、小さな `/health` はたいてい成功してしまう。'),
          node('2 回続けては失敗しないから、ずっと `healthy` のまま……。'),
          hakase('これを **グレー障害** (gray failure) という。白でも黒でもない、灰色の壊れ方だ。きっぱり止まってくれれば ALB が外すのだが、半分生きているから外されない。'),
          node('ゾンビみたいですね。'),
          hakase('運用の担当者にとっては、ゾンビより怖い。ゾンビは少なくとも、見ればゾンビだと分かる。'),
          node('AZ ごとの数字は見られないんですか？ アラームは AZ ごとに分かれてましたよね。'),
          hakase('ALB のメトリクスには、ディメンションに `LoadBalancer` と `AvailabilityZone` の 2 つを付けた、AZ 別のものもある。Lesson 24 の `get-metric-statistics` で、`--dimensions` に 2 つ並べれば取れる。AZ を `for` で回して、3 つの AZ の `TargetResponseTime` (応答にかかった秒数) を並べてみるのだ。'),
          node('本当に web-2 だけが悪いのか、ほかに確かめる方法はありますか？'),
          hakase('お客様と同じことをすればよい。`curl -v` で何回か開くのだ。`-v` を付けると、`*` の行に ALB がどのターゲットへ送ったかが出る。このシミュレーターのおまけの機能だったな。'),
          node('何回も打つのは面倒です。'),
          hakase('`for i in 1 2 3; do … ; done` で 3 回繰り返せ。間に `sleep 1` で 1 秒ずつ空けると、ALB が振り分けるターゲットが変わる。エラーを返したターゲットが分かったら、`aws ec2 describe-instances` でそのインスタンスの AZ (`Placement.AvailabilityZone`) も確かめるのだ。'),
        ],
      },
      4: {
        type: 'exercise',
        title: 'エラーを返すターゲットと AZ を確かめる',
        objective: 'AZ 別の `TargetResponseTime` を比べ、`curl -v` で `web-alb` を何回か開いて 500 を返すターゲットを見つけ、そのインスタンスの AZ を `describe-instances` で確かめる',
        tasks: [
          {
            id: 'metrics',
            title: '`for` と `aws cloudwatch get-metric-statistics` で、3 つの AZ の `TargetResponseTime` を並べる',
            hint: "`--dimensions Name=LoadBalancer,Value=app/web-alb/… Name=AvailabilityZone,Value=$az` のように 2 つ並べます。`LoadBalancer` の値は ALB の ARN の `loadbalancer/` より後ろです。1 つだけ桁違いに遅い AZ があるはずです。",
            command: azMetrics,
            done: sawAzMetrics,
          },
          {
            id: 'curl',
            title: '`for` と `curl -sv` で `web-alb` を 3 回開き、500 を返すターゲットを見つける',
            hint: "DNS 名は `aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text` で調べます。`* ✘` の行に、どのターゲットで止まったかが出ます。",
            command: curl3,
            done: sawWeb2Error,
          },
          {
            id: 'az',
            title: '`aws ec2 describe-instances` で web-2 の AZ を表示する',
            hint: "`--filters Name=tag:Name,Values=web-2 --query 'Reservations[].Instances[].Placement.AvailabilityZone' --output text`",
            command: "aws ec2 describe-instances --filters Name=tag:Name,Values=web-2 --query 'Reservations[].Instances[].Placement.AvailabilityZone' --output text",
            done: sawWeb2Az,
          },
        ],
        validate: (c) => {
          if (!sawWeb2Error(c)) return ng(hakase('まだ 500 を返すターゲットを見ておらん。`for i in 1 2 3; do curl -sv http://<web-alb の DNS 名>/; echo; sleep 1; done` で、3 回続けて開くのだ。'));
          if (!sawWeb2Az(c)) return ng(hakase('エラーは web-2 だったな。`aws ec2 describe-instances --filters Name=tag:Name,Values=web-2` で、`Placement.AvailabilityZone` を見るのだ。'));
          return ok(
            node('web-1 と web-3 は 200 なのに、web-2 だけ「5 秒以上応答せず」で 500 です。web-2 は ap-northeast-1c にいます。'),
            hakase('決まりだな。悪いのは ap-northeast-1c だ。アラームとも合う。web-2 のアプリでもワシらの設定でもなく、AZ の中のネットワークだ。'),
            node('AWS Health (AWS からの障害のお知らせ) には、まだ何も出てませんけど……。'),
            hakase('AWS の発表を待っていたら、その間ずっと 3 人に 1 人のお客様を待たせることになる。自分の数字で判断できたなら、自分で動くのだ。'),
          );
        },
      },
      5: {
        type: 'dialogue',
        lines: [
          node('じゃあ、web-2 をターゲットグループから外しましょう。Lesson 17 で `deregister-targets` はやりました。'),
          hakase('今日はそれで済むかもしれん。だが、1c にいるのが web-2 だけとは限らんぞ。Auto Scaling が 1c に新しいインスタンスを起動すれば、またそこに送られる。'),
          node('AZ ごとまとめて避けられたらいいのに。'),
          hakase('それをやるのが **Route 53 ARC** の **ゾーンシフト** だ。ARC は Application Recovery Controller の略で、障害からの復旧を助ける機能の集まりだ。CLI では `aws arc-zonal-shift` だ。'),
          node('ぞーんしふと？'),
          hakase('1 つの AZ から、トラフィック (リクエストの流れ) を一時的に移す機能だ。台風の日に、増水した川の橋だけを通行止めにするようなものだ。'),
          node('橋は残したまま、通らせないだけ、と。'),
          hakase('うむ。インスタンスは消さずに残すから、AZ が直れば通行止めを解くだけで元に戻る。それと、ゾーンシフトには必ず **有効期限** がある。最初に決められるのは最長 3 日 (72 時間) までだ。'),
          node('期限付き？ 戻し忘れても勝手に戻るんですね。僕向きです。'),
          hakase('君のために作られた機能ではないが、否定はせん。ただし ALB でゾーンシフトを使うには、先に ALB の **属性** `zonal_shift.config.enabled` を `true` にしておく。既定は `false` だ。'),
          node('ぞくせい？'),
          hakase('ALB の細かい設定項目のことだ。`aws elbv2 describe-load-balancer-attributes` で一覧でき、`modify-load-balancer-attributes --attributes Key=…,Value=…` で変える。`true` にすると、ALB は ARC の **マネージドリソース**、つまりゾーンシフトできる対象として登録される。'),
        ],
      },
      6: {
        type: 'exercise',
        title: 'ALB のゾーンシフトを有効にする',
        objective: '`web-alb` の属性 `zonal_shift.config.enabled` を確かめ、`modify-load-balancer-attributes` で `true` にする',
        tasks: [
          {
            id: 'describe',
            title: '`aws elbv2 describe-load-balancer-attributes` で `zonal_shift.config.enabled` の今の値を見る',
            hint: "ARN は `aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].LoadBalancerArn' --output text` で調べます。`--query \"Attributes[?Key=='zonal_shift.config.enabled']\"` で 1 つに絞れます。",
            command: (c) => `aws elbv2 describe-load-balancer-attributes --load-balancer-arn ${arn(c)} --query "Attributes[?Key=='zonal_shift.config.enabled']"`,
            done: (c) => !!ranAws(c, 'elbv2 describe-load-balancer-attributes'),
          },
          {
            id: 'enable',
            title: '`aws elbv2 modify-load-balancer-attributes` で `zonal_shift.config.enabled` を `true` にする',
            hint: '`--load-balancer-arn <web-alb の ARN> --attributes Key=zonal_shift.config.enabled,Value=true`',
            command: (c) => `aws elbv2 modify-load-balancer-attributes --load-balancer-arn ${arn(c)} --attributes Key=zonal_shift.config.enabled,Value=true --query "Attributes[?Key=='zonal_shift.config.enabled']"`,
            done: (c) => !!alb(c.env) && zonalShiftEnabled(alb(c.env)!),
          },
        ],
        validate: (c) =>
          alb(c.env) && zonalShiftEnabled(alb(c.env)!)
            ? ok(
                node('`zonal_shift.config.enabled` が `true` になりました。でも、エラーはまだ出てますね。'),
                hakase('スイッチを付けただけだからな。まだ通行止めの看板は立てておらん。'),
                hakase('看板を立てる前に、1 つ大事な話がある。'),
              )
            : ng(hakase('`web-alb` の `zonal_shift.config.enabled` が、まだ `false` だ。`aws elbv2 modify-load-balancer-attributes --load-balancer-arn <ARN> --attributes Key=zonal_shift.config.enabled,Value=true` だ。')),
      },
      7: {
        type: 'dialogue',
        lines: [
          hakase('ゾーンシフトでは、AZ を `ap-northeast-1c` のような **AZ 名** ではなく、**AZ ID** で指定する。`--away-from` に渡す値だ。'),
          node('えーぜっとあいでぃー？ 名前とは別に ID があるんですか？'),
          hakase('AZ 名と実際の建物の対応は、アカウントごとにシャッフルされておる。君のアカウントの `1c` と隣の会社の `1c` は、別の建物かもしれん。'),
          node('なんでそんなややこしいことを？'),
          hakase('みんなが `a` を選びがちだからだ。名前を固定すると、どのアカウントでも `1a` の建物だけが満員になる。AZ ID は `apne1-az2` のような形で、どのアカウントから見ても同じ建物を指す。'),
          node('AWS Health のお知らせも、AZ ID で書かれるんですか？'),
          hakase('そうだ。AZ ID で話す癖をつけておけば、よその会社とも話が通じる。対応は `aws ec2 describe-availability-zones` の `ZoneName` と `ZoneId` で分かる。'),
          node('もう 1 つ聞いていいですか。ALB のノードは AZ ごとにいるんですよね？ 1c のノードを外すだけじゃダメなんですか？'),
          hakase('よい質問だ。ALB では **クロスゾーン負荷分散** が常にオンになっておる。さっきの属性の一覧にも `load_balancing.cross_zone.enabled` が `true` で出ていたはずだ。どの AZ のノードも、すべての AZ のターゲットにリクエストを振り分ける仕組みだ。'),
          node('ということは、1a のノードに来たリクエストも web-2 に回されちゃう？'),
          hakase('そういうことだ。だからゾーンシフトは、1c のノードを DNS から外すだけでなく、ほかのノードからも 1c のターゲットに新しいリクエストを送らないようにする。'),
          node('通行止めの看板を、川の両岸に立てるわけですね。'),
        ],
      },
      8: {
        type: 'exercise',
        title: 'ゾーンシフトを開始する',
        objective: '`aws arc-zonal-shift start-zonal-shift` で、`web-alb` のトラフィックを ap-northeast-1c (の AZ ID) から移すゾーンシフトを、有効期限 `1h`・コメント付きで開始する',
        tasks: [
          {
            id: 'azid',
            title: '`aws ec2 describe-availability-zones` で、AZ 名と AZ ID の対応を見る',
            hint: "`--query 'AvailabilityZones[].[ZoneName,ZoneId]' --output table` で 2 列の表になります。",
            command: "aws ec2 describe-availability-zones --query 'AvailabilityZones[].[ZoneName,ZoneId]' --output table",
            done: (c) => !!ranAws(c, 'ec2 describe-availability-zones'),
          },
          {
            id: 'managed',
            title: '`aws arc-zonal-shift list-managed-resources` で、`web-alb` がマネージドリソースになったことを確かめる',
            hint: "`--query 'items[].[name,arn]' --output table` で、名前と ARN が並びます。ARN は次の `--resource-identifier` に使います。",
            command: "aws arc-zonal-shift list-managed-resources --query 'items[].[name,arn]' --output table",
            done: (c) => !!ranAws(c, 'arc-zonal-shift list-managed-resources', (x) => x.output.includes('web-alb')),
          },
          {
            id: 'start',
            title: '`aws arc-zonal-shift start-zonal-shift` で、ゾーンシフトを開始する',
            hint: '`--resource-identifier <web-alb の ARN> --away-from <1c の AZ ID> --expires-in 1h --comment "<理由>"`。`--expires-in` は数字に `m` (分) か `h` (時間) を付けます。',
            command: (c) => `aws arc-zonal-shift start-zonal-shift --resource-identifier ${arn(c)} --away-from ${IMPAIRED_AZ_ID} --expires-in 1h --comment "${IMPAIRED_AZ_ID} (1c) gray failure: 5XX and timeouts"`,
            done: (c) => !!activeShift(c.env),
          },
        ],
        validate: (c) => {
          const s = activeShift(c.env);
          if (!s) return ng(hakase('まだゾーンシフトが始まっておらん。`aws arc-zonal-shift start-zonal-shift --resource-identifier <ARN> --away-from <AZ ID> --expires-in 1h --comment "…"` だ。'));
          if (s.awayFrom !== IMPAIRED_AZ_ID)
            return ng(hakase(`今のシフトは ${azLabel(c.env, s.awayFrom)} から移しておる。悪いのは ap-northeast-1c、AZ ID だと \`${IMPAIRED_AZ_ID}\` だ。\`aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id ${s.zonalShiftId}\` で止めて、開始し直すのだ。AZ は更新では変えられん。`), node('元気な AZ を通行止めにしてました……。'));
          if (hours(c.env) < 50 / 60 || hours(c.env) > 70 / 60) return ng(hakase(`有効期限が 1 時間になっておらん。\`aws arc-zonal-shift update-zonal-shift --zonal-shift-id ${s.zonalShiftId} --expires-in 1h\` で直すのだ。`));
          if (!s.comment.trim()) return ng(hakase(`コメントが空だ。\`aws arc-zonal-shift update-zonal-shift --zonal-shift-id ${s.zonalShiftId} --comment "…"\` で、なぜシフトしたのかを書いておくのだ。`));
          return ok(
            node('始まりました！ 応答の `status` が `ACTIVE`、`awayFrom` が `apne1-az2` です。'),
            hakase('コメントは、未来の自分と同僚への置き手紙だ。夜中に `list-zonal-shifts` を見た誰かが「誰が、なぜ 1c を止めたのか」を、君を叩き起こさずに知ることができる。'),
            node('僕の睡眠を守るための機能だったんですね。'),
            hakase('君の睡眠に興味はないが、結果としてそうなる。'),
          );
        },
      },
      9: {
        type: 'dialogue',
        lines: [
          hakase('さて、ARC から見てシフトが効いているかを確かめよう。`aws arc-zonal-shift get-managed-resource` の `appliedWeights` に、AZ ID ごとの重みが出る。1 なら送る、0 なら送らない、だ。'),
          node('`apne1-az2` が 0 になっていればいいんですね。'),
          hakase('うむ。そのあとで、お客様から見て直ったかを確かめる。さっきの `for` と `curl -sv` をもう一度打つのだ。'),
          node('前は 3 回に 1 回エラーでしたよね。'),
          hakase('そうだ。だから 1 回 200 が出ただけでは安心できん。3 回続けて 200 になるのを確かめる。ゾーンシフトが効いていれば、`*` の行に ALB がどの AZ を避けているかも出る。'),
          node('`describe-target-health` にも、何か変化はあるんですか？'),
          hakase('実物では、ターゲットに `AdministrativeOverride` (管理オーバーライド) という項目があって、web-2 は `zonal_shift_active` になる。ヘルスチェックの結果とは別に、ARC が「ここには送るな」と上書きしている印だ。'),
        ],
      },
      10: {
        type: 'exercise',
        title: 'エラーが消えたことを確かめる',
        objective: '`get-managed-resource` の `appliedWeights` で `apne1-az2` が 0 なのを確かめ、`curl` で 3 回続けて HTTP 200 になることを確認する',
        tasks: [
          {
            id: 'weights',
            title: '`aws arc-zonal-shift get-managed-resource` で `appliedWeights` を見る',
            hint: '`--resource-identifier <web-alb の ARN> --query appliedWeights`',
            command: (c) => `aws arc-zonal-shift get-managed-resource --resource-identifier ${arn(c)} --query appliedWeights`,
            done: (c) => !!ranAws(c, 'arc-zonal-shift get-managed-resource', (x) => x.at >= shiftStart(c) && x.output.includes(IMPAIRED_AZ_ID)),
          },
          { id: 'thrice', title: '`for` と `curl -sv` で 3 回続けて開き、3 回とも 200 になることを確かめる', hint: '`for i in 1 2 3; do curl -sv http://<DNS 名>/; echo; sleep 1; done`。応答したインスタンスの名前が本文に出ます。', command: curl3, done: threeShiftedOk },
        ],
        validate: (c) => {
          const last = albRequests(c)[0];
          if (!last || !last.hops.some((h) => h.checks.some((x) => x.label === SHIFT_CHECK))) return ng(hakase('ゾーンシフトを開始したあとで、`curl -sv` で `web-alb` を開くのだ。`*` の行に「ゾーンシフト (ARC)」が出ていれば、シフトが効いておる。'));
          if (!threeShiftedOk(c)) return ng(hakase('続けて 3 回とも 200 になるまで確かめるのだ。`for i in 1 2 3; do curl -sv http://<DNS 名>/; echo; sleep 1; done` だ。エラーが出たなら、`list-zonal-shifts --status ACTIVE` でシフトが生きているかを見たまえ。'));
          return ok(
            node('3 回とも 200 です！ 応答したのは web-1 と web-3 だけで、web-2 は一度も出てきません。'),
            hakase('`*` の行にも「ゾーンシフト (ARC)」が出ておるな。1c のターゲットには、新しいリクエストを送っておらん。'),
            node(`\`describe-alarms\` で見たら、\`${azAlarm(IMPAIRED_AZ)}\` は \`INSUFFICIENT_DATA\` (データ不足) になってました。`),
            hakase('1c にリクエストが行かんから、数えるエラーもないのだ。壊れた AZ から目をそらしただけで、直したわけではないのを忘れるな。'),
          );
        },
      },
      11: {
        type: 'dialogue',
        lines: [
          node('博士、あれから 40 分たちました。AWS Health にお知らせが出てます。「apne1-az2 で一部のインスタンスのネットワーク接続エラーが増えていました。現在は解決しています」だそうです。'),
          hakase('やはり apne1-az2、うちの 1c だったな。AWS の発表は、ワシらがシフトしてからずいぶん後だ。'),
          node('直ったなら、有効期限が来るまで放っておいてもいいですか？ どうせ勝手に戻りますし。'),
          hakase('今の web-alb は、2 つの AZ だけで動いておる。ここでもう 1 つの AZ が転んだら、残りは 1 つだ。'),
          node('片足立ちでバナナの皮に乗ってる、みたいな？'),
          hakase('妙に具体的だな。直ったと分かったら早めに戻して、3 つの AZ に戻す。`aws arc-zonal-shift list-zonal-shifts --status ACTIVE` でゾーンシフトの ID (`zonalShiftId`) を調べて、`cancel-zonal-shift --zonal-shift-id` だ。'),
          node('キャンセルしたら、web-2 にもまたリクエストが行くんですよね。'),
          hakase('そうだ。戻したら、web-2 が 200 を返すところまで自分の目で見るのだ。「戻しました、たぶん大丈夫です」は報告ではない。'),
        ],
      },
      12: {
        type: 'exercise',
        title: 'ゾーンシフトをキャンセルして元に戻す',
        objective: '`cancel-zonal-shift` でゾーンシフトを終わらせ、`curl` で `web-2` が HTTP 200 を返すことを確かめる',
        tasks: [
          {
            id: 'list',
            title: '`aws arc-zonal-shift list-zonal-shifts --status ACTIVE` で、ゾーンシフトの ID を調べる',
            hint: "`--query 'items[].[zonalShiftId,awayFrom,expiryTime]' --output table` で見やすくなります。",
            command: "aws arc-zonal-shift list-zonal-shifts --status ACTIVE --query 'items[].[zonalShiftId,awayFrom,expiryTime]' --output table",
            done: (c) => !!ranAws(c, 'arc-zonal-shift list-zonal-shifts', (x) => x.at >= shiftStart(c)),
          },
          {
            id: 'cancel',
            title: '`aws arc-zonal-shift cancel-zonal-shift` でゾーンシフトを終わらせる',
            hint: '`--zonal-shift-id <list-zonal-shifts で見た zonalShiftId>`。応答の `status` が `CANCELED` になります。',
            command: (c) => `aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id ${activeShift(c.env)?.zonalShiftId ?? '<zonalShiftId>'}`,
            done: (c) => canceled(c.env),
          },
          { id: 'web2', title: '`for` と `curl -sv` で何回か開いて、`web-2` が 200 を返すのを確かめる', hint: 'ALB は 3 台に順に振り分けます。本文に `web-2` と出るまで繰り返します。', command: curl3, done: web2Ok },
        ],
        validate: (c) => {
          const s = activeShift(c.env);
          if (s) return ng(hakase(`ゾーンシフトがまだ \`ACTIVE\` だ。\`aws arc-zonal-shift cancel-zonal-shift --zonal-shift-id ${s.zonalShiftId}\` だ。`));
          if (!canceled(c.env)) return ng(hakase('ゾーンシフトをキャンセルした記録がない。有効期限が切れるのを待つのではなく、自分で `cancel-zonal-shift` して戻すのだ。'));
          if (!recovered(c.env)) return ng(hakase('ap-northeast-1c は、まだ直りきっておらん。`sleep 10` で少し待ってから、もう一度 `curl` で確かめるのだ。'));
          if (!web2Ok(c)) return ng(hakase('web-2 が 200 を返すところを、まだ見ておらん。`for i in 1 2 3; do curl -sv http://<DNS 名>/; echo; sleep 1; done` で、本文に `web-2` と出るまで確かめるのだ。'));
          return ok(
            node('web-2 から 200 が返ってきました！ `describe-alarms` でも、`web-alb-5xx-1c` が `OK` に戻っています。'),
            hakase('3 つの AZ に戻ったな。お客様は何も知らずに買い物を続けておる。それが一番だ。'),
            node('僕たちの活躍、誰にも知られないんですね。'),
            hakase('運用とはそういうものだ。目立つのは、しくじったときだけだ。'),
          );
        },
      },
      13: {
        type: 'dialogue',
        lines: [
          node('今回は僕たちが気づいたからよかったですけど、夜中だったら……。'),
          hakase('そこで **ゾーンオートシフト** だ。AWS が自分の監視で AZ の障害を見つけたとき、君の代わりにゾーンシフトを始めてくれる。'),
          node('寝てる間に通行止めにしてくれるんですね！ 最初から全部それでいいじゃないですか。'),
          hakase('甘い。AZ を 1 つ外したら、残りの AZ で全部のお客様を受け止めることになる。台数が足りなければ、今度はすべての AZ が重くなる。'),
          node('通行止めのせいで、ほかの橋が大渋滞する、と。'),
          hakase('だからゾーンオートシフトを有効にするには、**練習実行** の設定が要る。AWS が週に 1 回くらい、どれか 1 つの AZ から 30 分だけトラフィックを移して、残りで耐えられるかを試す。避難訓練だな。'),
          node('れんしゅうじっこう……訓練で、本当にお客様のリクエストを動かすんですか？'),
          hakase('本番で動かすから意味がある。その代わり、**結果アラーム** を 1 つ以上必ず指定する。訓練の間に結果アラームが鳴ったら、練習実行は「失敗」として打ち切られ、トラフィックは元に戻る。`create-practice-run-configuration` の `--outcome-alarms` に、`type=CLOUDWATCH,alarmIdentifier=<アラームの ARN>` と書く。'),
          node('訓練で火事になったら、すぐ中止ってことですね。'),
          hakase('ほかに、任意で **ブロッキングアラーム** (`--blocking-alarms`) も選べる。これが鳴っている間は、訓練を始めない。セールの日のように訓練されては困る日は、`--blocked-dates` で外しておける。'),
          node('結果アラームには、AZ ごとのアラームを選べばいいですか？'),
          hakase('AZ ごとのものはやめておけ。訓練でその AZ を外すと、さっきのようにデータ不足になって何も見張れん。お客様全体への影響を見る `web-alb-5xx` を選ぶのだ。設定ができたら、`update-zonal-autoshift-configuration --zonal-autoshift-status ENABLED` で有効にする。'),
        ],
      },
      14: {
        type: 'exercise',
        title: 'ゾーンオートシフトを設定する',
        objective: '`web-alb` の練習実行設定を `create-practice-run-configuration` で作り (結果アラームは `web-alb-5xx`)、`update-zonal-autoshift-configuration` でゾーンオートシフトを有効にする',
        tasks: [
          {
            id: 'arn',
            title: '`aws cloudwatch describe-alarms` で `web-alb-5xx` の ARN を調べる',
            hint: "`--alarm-names web-alb-5xx --query 'MetricAlarms[0].AlarmArn' --output text`",
            command: "aws cloudwatch describe-alarms --alarm-names web-alb-5xx --query 'MetricAlarms[0].AlarmArn' --output text",
            done: (c) => !!ranAws(c, 'cloudwatch describe-alarms', (x) => param(x, 'alarm-names') === ALB_5XX_ALARM),
          },
          {
            id: 'practice',
            title: '`aws arc-zonal-shift create-practice-run-configuration` で、練習実行設定を作る',
            hint: '`--resource-identifier <web-alb の ARN> --outcome-alarms type=CLOUDWATCH,alarmIdentifier=<web-alb-5xx の ARN>`',
            command: (c) => `aws arc-zonal-shift create-practice-run-configuration --resource-identifier ${arn(c)} --outcome-alarms type=CLOUDWATCH,alarmIdentifier=${alarmArn(c)}`,
            done: (c) => !!configOf(c.env, alb(c.env)?.loadBalancerArn ?? '')?.practiceRunConfiguration,
          },
          {
            id: 'enable',
            title: '`aws arc-zonal-shift update-zonal-autoshift-configuration` で、ゾーンオートシフトを有効にする',
            hint: '`--resource-identifier <web-alb の ARN> --zonal-autoshift-status ENABLED`',
            command: (c) => `aws arc-zonal-shift update-zonal-autoshift-configuration --resource-identifier ${arn(c)} --zonal-autoshift-status ENABLED`,
            done: (c) => autoshiftOn(c.env),
          },
        ],
        validate: (c) => {
          const names = outcomeAlarmNames(c.env);
          if (!names.length) return ng(hakase('`web-alb` の練習実行設定がまだない。`aws arc-zonal-shift create-practice-run-configuration --resource-identifier <ARN> --outcome-alarms type=CLOUDWATCH,alarmIdentifier=<web-alb-5xx の ARN>` だ。'));
          if (!names.includes(ALB_5XX_ALARM))
            return ng(hakase(`結果アラームが ${names.map((n) => `\`${n}\``).join(', ')} になっておる。AZ ごとのアラームでは、訓練で外した AZ がデータ不足になって何も見張れん。\`update-practice-run-configuration --resource-identifier <ARN> --outcome-alarms type=CLOUDWATCH,alarmIdentifier=<web-alb-5xx の ARN>\` で置き換えるのだ。`));
          if (!autoshiftOn(c.env)) return ng(hakase('練習実行の設定はできた。あとは `aws arc-zonal-shift update-zonal-autoshift-configuration --resource-identifier <ARN> --zonal-autoshift-status ENABLED` だ。'));
          return ok(
            node('`get-managed-resource` で見たら、`zonalAutoshiftStatus` が `ENABLED`、結果アラームは `web-alb-5xx` です。これで夜中も安心ですね！'),
            hakase('安心するのは、練習実行が何回か成功してからだ。訓練で毎回失敗するなら、それは「AZ を 1 つ失うと耐えられない」という、ありがたい知らせだ。'),
            node('そのときは、台数を増やすんですね。'),
            hakase('うむ。1 つの AZ が丸ごと使えなくなっても、残りで回る台数を普段から置いておく。それが本当の意味のマルチ AZ だ。請求書は少し増えるがな。'),
          );
        },
      },
      15: {
        type: 'quiz',
        question: hakase('問題だ。ap-northeast-1c の web-2 がエラーを返していたのに、ALB が web-2 を外さなかったのはなぜかな？'),
        options: ['ALB のクロスゾーン負荷分散がオフだったから', '小さな `/health` のヘルスチェックは成功していて、ターゲットが「正常」のままだったから', 'web-2 のセキュリティグループが ALB からの通信を拒否していたから'],
        answer: 1,
        explanation: [
          hakase('正解。重いリクエストだけが時間切れになり、軽いヘルスチェックは成功する。これがグレー障害だ。'),
          hakase('ヘルスチェックが `healthy` でも安心せず、AZ ごとのメトリクスやアラームで、お客様が実際に受けている応答を見るのだ。'),
        ],
        wrong: [hakase('`describe-target-health` の結果を思い出すのだ。3 台の `State` は何だったかな？')],
      },
    },
  },
};

export default patches;
