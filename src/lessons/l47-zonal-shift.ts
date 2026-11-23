import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { decodeGraph, evaluateAlarm } from '../sim/cloudwatch';
import { azIdOf, azNameOf, configOf, impairedAt, zonalShiftEnabled } from '../sim/ext/zonalshift';
import { ALB_5XX_ALARM, AZS, azAlarm, IMPAIRED_AZ, zonalShiftEnv } from '../sim/ext/zonalshift-scenario';
import type { HttpResult } from '../sim/http';
import type { AwsEnv } from '../sim/types';
import { alarmNamed, lbNamed, visited, visitedQuery } from './helpers';

/* ---------- 演習の判定 (CLI 版も使う) ---------- */
export const IMPAIRED_AZ_ID = azIdOf(IMPAIRED_AZ);
const MINUTE = 60_000;
const alb = (env: AwsEnv) => lbNamed(env, 'web-alb');
/** web-alb の、学習者が始めたゾーンシフト (新しいものが後ろ) */
export const customerShifts = (env: AwsEnv) => (env.zonalShift?.shifts ?? []).filter((s) => s.shiftType === 'ZONAL_SHIFT' && s.resourceIdentifier === alb(env)?.loadBalancerArn);
export const activeShift = (env: AwsEnv) => customerShifts(env).find((s) => s.status === 'ACTIVE');
/** http.ts がゾーンシフト中に経路の診断へ足す行 */
export const SHIFT_CHECK = 'ゾーンシフト (ARC)';
export const albRequests = (c: TaskContext) => c.browser.filter((r) => !!alb(c.env) && r.url.toLowerCase().includes(alb(c.env)!.dnsName));
/** ゾーンシフトが効いた状態で 200 が返った */
export const shiftedOk = (r: HttpResult) => r.status === 200 && r.hops.some((h) => h.checks.some((x) => x.label === SHIFT_CHECK));
/** 新しいほうから 3 回続けて、ゾーンシフト中の 200 */
export const threeShiftedOk = (c: TaskContext) => albRequests(c).length >= 3 && albRequests(c).slice(0, 3).every(shiftedOk);
/** web-2 (ap-northeast-1c) が 200 を返した。シフト前の web-2 は 500 なので、戻したあとのものになる */
export const web2Ok = (c: TaskContext) => albRequests(c).some((r) => r.status === 200 && r.hops.some((h) => h.hop.includes('(web-2)')));
export const recovered = (env: AwsEnv) => !impairedAt(env, IMPAIRED_AZ, Date.now());
export const canceled = (env: AwsEnv) => !activeShift(env) && customerShifts(env).some((s) => s.status === 'CANCELED');
const shiftHours = (env: AwsEnv) => {
  const s = activeShift(env);
  return s ? (s.expiryTime - s.startTime) / 60 / MINUTE : 0;
};
export const azLabel = (env: AwsEnv, id: string) => `${id} (${azNameOf(env, id) ?? '?'})`;
export const outcomeAlarmNames = (env: AwsEnv) => (configOf(env, alb(env)?.loadBalancerArn ?? '')?.practiceRunConfiguration?.outcomeAlarms ?? []).map((a) => env.alarms.find((x) => x.alarmArn === a.alarmIdentifier)?.alarmName ?? a.alarmIdentifier);
export const autoshiftOn = (env: AwsEnv) => configOf(env, alb(env)?.loadBalancerArn ?? '')?.zonalAutoshiftStatus === 'ENABLED';
/** 1 枚のグラフに、web-alb の AZ 別 TargetResponseTime が 3 つの AZ ぶん並んだ */
const graphedAllAzs = (c: TaskContext) =>
  c.visited
    .filter((v) => v.startsWith('/cloudwatch/metrics?'))
    .some((v) => {
      const refs = decodeGraph(new URLSearchParams(v.split('?')[1]).get('graph') ?? '');
      const azs = new Set(refs.filter((r) => r.metricName === 'TargetResponseTime').map((r) => r.dimensions.find((d) => d.name === 'AvailabilityZone')?.value));
      return AZS.every((az) => azs.has(az));
    });

export const lesson47: Lesson = {
  id: 'zonal-shift',
  number: '47',
  title: 'Route 53 ARC ゾーンシフト',
  summary: '1 つの AZ のグレー障害を AZ 別のメトリクスで見つけ、ゾーンシフトでトラフィックを移して素早く復旧する。ゾーンオートシフトと練習実行も設定する',
  minutes: 25,
  startPath: '/cloudwatch/alarms',
  scenario: zonalShiftEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、ショップのお問い合わせです。注文ボタンを押すと、3 回に 1 回くらい、さんざん待たされたあげくにエラーになるそうです。'),
        hakase('3 回に 1 回、か。全部ダメなら話は早いのだがな。中途半端な障害ほど、人を夜更かしさせるものはない。'),
        node('先輩が仕込んだ CloudWatch のアラームも鳴ってます。`web-alb-5xx`、ALB の後ろのターゲットが返した 5XX エラーの数を見張るアラームです。'),
        hakase('Lesson 24 で作ったアラームの仲間だな。まずは今日の構成を確かめておこう。'),
        node('`web-alb` は 3 つの AZ にまたがっていて、ap-northeast-1a に web-1、1c に web-2、1d に web-3 がいます。'),
        hakase('Lesson 02 で「本番は 2 つ以上の AZ に分けて置く」と言ったな。先輩は 3 つに分けた。ワシの教えを 1.5 倍守っておる。'),
        node('だったら、1 台くらい調子が悪くても、ALB がヘルスチェックで外してくれるはずですよね？ Lesson 13 でやりました。'),
        hakase('「はず」か。君の「はず」が当たったためしがあったかな？ 外されているかどうか、ターゲットグループで確かめるのだ。'),
        node('アラームも見ておきます。`web-alb-5xx` のほかに、名前の最後が `-1a` `-1c` `-1d` のアラームがありますね。'),
        hakase('先輩は AZ ごとにもアラームを分けておったか。どの AZ のアラームが鳴っているかを見るのだ。'),
      ],
    },
    {
      type: 'table',
      title: '今日の構成 (web-alb)',
      columns: ['アベイラビリティーゾーン', 'ALB のサブネット', 'ターゲット', 'AZ ごとのアラーム'],
      rows: AZS.map((az, n) => [`\`${az}\``, `public-subnet-${az.slice(-2)}`, `web-${n + 1} (private-subnet-${az.slice(-2)})`, `\`${azAlarm(az)}\``]),
    },
    {
      type: 'exercise',
      title: '症状を確かめる',
      objective: 'アラーム状態になっている AZ ごとのアラームを開き、ターゲットグループ `web-tg` のヘルスステータスを確認する',
      tasks: [
        { id: 'alarm', title: 'CloudWatch > すべてのアラームで、アラーム状態の AZ ごとのアラームを開く', hint: '名前の最後 (`-1a` `-1c` `-1d`) が AZ です。状態が「アラーム状態」のものを開いて、ディメンションの AvailabilityZone を見ます。', done: (c) => visitedQuery(c, '/cloudwatch/alarms/view', { name: azAlarm(IMPAIRED_AZ) }) },
        { id: 'health', title: 'EC2 > ターゲットグループ > `web-tg` の **ターゲット** タブで、ヘルスステータスを見る', hint: 'EC2 の左メニュー「ロードバランシング」→「ターゲットグループ」から開きます。3 台のヘルスステータスと「ゾーン」列を見比べます。', done: (c) => visited(c, '/ec2/target-groups/web-tg') },
      ],
      validate: (c) => {
        if (!visitedQuery(c, '/cloudwatch/alarms/view', { name: azAlarm(IMPAIRED_AZ) })) return ng(hakase('アラーム状態の AZ ごとのアラームを開くのだ。CloudWatch の「すべてのアラーム」で、名前が `web-alb-5xx-1` で始まる 3 つの状態を見比べたまえ。'));
        if (!visited(c, '/ec2/target-groups/web-tg')) return ng(hakase('次はターゲットグループ `web-tg` だ。EC2 の左メニュー「ターゲットグループ」から開いて、**ターゲット** タブのヘルスステータスを見るのだ。'));
        return ok(
          node('アラーム状態なのは `web-alb-5xx-1c` だけで、1a と 1d は OK です。なのに、ターゲットは 3 台とも「正常」でした。'),
          hakase('ap-northeast-1c のターゲット、つまり web-2 だけがエラーを返しておるわけだ。'),
          node('エラーを返してるのに「正常」って、ヘルスチェックの目は節穴なんですか？'),
          hakase('節穴というより、見ている場所が狭いのだ。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('ヘルスチェックが見るのは `/health` だけだったな。30 秒に 1 回「生きてるか？」と聞いて、5 秒以内に 200 が返れば合格だ。'),
        node('Lesson 13 でやりました。2 回続けて失敗したら異常 (unhealthy) にする、でしたよね。'),
        hakase('そうだ。今、ap-northeast-1c の中ではネットワークが不安定で、パケットがときどき落ちておる。重い注文のリクエストは待たされて時間切れになるが、小さな `/health` はたいてい成功してしまう。'),
        node('2 回続けては失敗しないから、ずっと「正常」のまま……。'),
        hakase('これを **グレー障害** (gray failure) という。白でも黒でもない、灰色の壊れ方だ。きっぱり止まってくれれば ALB が外すのだが、半分生きているから外されない。'),
        node('ゾンビみたいですね。'),
        hakase('運用の担当者にとっては、ゾンビより怖い。ゾンビは少なくとも、見ればゾンビだと分かる。'),
        node('本当に 1c だけが悪いのか、ほかに確かめる方法はありますか？'),
        hakase('ALB のメトリクスには、AZ ごとに分けたものもある。ディメンションに `LoadBalancer` と `AvailabilityZone` の 2 つを持つメトリクスで、応答したターゲットの AZ ごとに数字が分かれておる。'),
        node('Lesson 25 で見た `TargetResponseTime` を、AZ ごとに分けたものですね。'),
        hakase('うむ。CloudWatch の「すべてのメトリクス」で **ApplicationELB** の **AppELB 別、AZ 別メトリクス** を開き、3 つの AZ の `TargetResponseTime` を 1 枚のグラフに並べるのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'AZ ごとの応答時間を比べる',
      objective: '「すべてのメトリクス」の **AppELB 別、AZ 別メトリクス** で、`web-alb` の 3 つの AZ の `TargetResponseTime` を 1 枚のグラフに並べる',
      tasks: [
        { id: 'group', title: 'CloudWatch > すべてのメトリクス > ApplicationELB の **AppELB 別、AZ 別メトリクス** を開く', hint: '「AWS 名前空間」に ApplicationELB が 2 つあります。小さく「AppELB 別、AZ 別メトリクス」と書いてあるほうです。', done: (c) => visitedQuery(c, '/cloudwatch/metrics', { ns: 'AWS/ApplicationELB:AZ' }) },
        { id: 'graph', title: '3 つの AZ の `TargetResponseTime` にチェックを入れる', hint: 'フィルターに `TargetResponseTime` と入れると絞り込めます。「AvailabilityZone」列で 3 つの AZ を確かめてチェックします。', done: graphedAllAzs },
      ],
      validate: (c) =>
        graphedAllAzs(c)
          ? ok(
              node('1a と 1d は 0.05 秒くらいなのに、1c だけ 5 秒前後です！ 25 分くらい前から急に跳ね上がってます。'),
              hakase('決まりだな。悪いのは ap-northeast-1c だ。web-2 のアプリでもワシらの設定でもなく、AZ の中のネットワークだ。'),
              node('AWS Health (AWS からの障害のお知らせ) には、まだ何も出てませんけど……。'),
              hakase('AWS の発表を待っていたら、その間ずっと 3 人に 1 人のお客様を待たせることになる。自分の数字で判断できたなら、自分で動くのだ。'),
            )
          : ng(hakase('AZ 別のメトリクスを並べるのだ。「すべてのメトリクス」→ ApplicationELB の「AppELB 別、AZ 別メトリクス」で、`TargetResponseTime` を 3 つの AZ ぶん選びたまえ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('じゃあ、web-2 をターゲットグループから外しましょう。Lesson 17 で登録解除はやりました。'),
        hakase('今日はそれで済むかもしれん。だが、1c にいるのが web-2 だけとは限らんぞ。Auto Scaling が 1c に新しいインスタンスを起動すれば、またそこに送られる。'),
        node('AZ ごとまとめて避けられたらいいのに。'),
        hakase('それをやるのが **Route 53 ARC** の **ゾーンシフト** だ。ARC は Application Recovery Controller の略で、障害からの復旧を助ける機能の集まりだ。'),
        node('ぞーんしふと？'),
        hakase('1 つの AZ から、トラフィック (リクエストの流れ) を一時的に移す機能だ。台風の日に、増水した川の橋だけを通行止めにするようなものだ。'),
        node('橋は残したまま、通らせないだけ、と。'),
        hakase('うむ。インスタンスは消さずに残すから、AZ が直れば通行止めを解くだけで元に戻る。それと、ゾーンシフトには必ず **有効期限** がある。最初に決められるのは最長 3 日 (72 時間) までだ。'),
        node('期限付き？ 戻し忘れても勝手に戻るんですね。僕向きです。'),
        hakase('君のために作られた機能ではないが、否定はせん。ただし ALB でゾーンシフトを使うには、先に ALB の **属性** で **ARC ゾーンシフト統合** を有効にしておく。既定ではオフだ。'),
        node('ぞくせい？'),
        hakase('ALB の細かい設定項目のことだ。削除保護やアイドルタイムアウトと並んで、ゾーンシフトのスイッチもそこにある。有効にすると、ALB は ARC の **マネージドリソース**、つまりゾーンシフトできる対象として登録される。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ALB のゾーンシフトを有効にする',
      objective: '`web-alb` の **属性** タブの **編集** で、**ARC ゾーンシフト統合** を有効にする',
      tasks: [
        {
          id: 'enable',
          title: 'ロードバランサー `web-alb` → **属性** タブ → **編集** → ARC ゾーンシフト統合を **有効化** → **変更内容の保存**',
          hint: 'EC2 の左メニュー「ロードバランサー」から `web-alb` を開きます。右上の「アクション」→「ロードバランサー属性を編集」からも開けます。',
          hotspotId: 'lb-zonal-shift-toggle',
          done: (c) => !!alb(c.env) && zonalShiftEnabled(alb(c.env)!),
        },
      ],
      validate: (c) =>
        alb(c.env) && zonalShiftEnabled(alb(c.env)!)
          ? ok(
              node('「ARC ゾーンシフト統合」が「有効」になりました。でも、エラーはまだ出てますね。'),
              hakase('スイッチを付けただけだからな。まだ通行止めの看板は立てておらん。'),
              hakase('看板を立てる前に、1 つ大事な話がある。'),
            )
          : ng(hakase('`web-alb` の ARC ゾーンシフト統合が、まだ無効だ。ロードバランサーの詳細の **属性** タブで **編集** を押し、トグルを有効化して保存するのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        hakase('ゾーンシフトでは、AZ を `ap-northeast-1c` のような **AZ 名** ではなく、**AZ ID** で指定する。'),
        node('えーぜっとあいでぃー？ 名前とは別に ID があるんですか？'),
        hakase('AZ 名と実際の建物の対応は、アカウントごとにシャッフルされておる。君のアカウントの `1c` と隣の会社の `1c` は、別の建物かもしれん。'),
        node('なんでそんなややこしいことを？'),
        hakase('みんなが `a` を選びがちだからだ。名前を固定すると、どのアカウントでも `1a` の建物だけが満員になる。AZ ID は `apne1-az2` のような形で、どのアカウントから見ても同じ建物を指す。'),
        node('AWS Health のお知らせも、AZ ID で書かれるんですか？'),
        hakase('そうだ。AZ ID で話す癖をつけておけば、よその会社とも話が通じる。今の 1c がどの ID かは、ゾーンシフトの開始画面に並べて出してある。'),
        node('もう 1 つ聞いていいですか。ALB のノードは AZ ごとにいるんですよね？ 1c のノードを外すだけじゃダメなんですか？'),
        hakase('よい質問だ。ALB では **クロスゾーン負荷分散** が常にオンになっておる。どの AZ のノードも、すべての AZ のターゲットにリクエストを振り分ける仕組みだ。'),
        node('ということは、1a のノードに来たリクエストも web-2 に回されちゃう？'),
        hakase('そういうことだ。だからゾーンシフトは、1c のノードを DNS から外すだけでなく、ほかのノードからも 1c のターゲットに新しいリクエストを送らないようにする。'),
        node('通行止めの看板を、川の両岸に立てるわけですね。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ゾーンシフトを開始する',
      objective: 'Application Recovery Controller の **ゾーンシフト** で、`web-alb` のトラフィックを ap-northeast-1c (の AZ ID) から移すゾーンシフトを、有効期限 **1 時間**・コメント付きで開始する',
      tasks: [
        {
          id: 'start',
          title: 'ゾーンシフト → **ゾーンシフトを開始** → AZ・リソース・有効期限・コメントを入れて、確認のチェックを入れて **開始**',
          hint: '検索バーに「ゾーンシフト」と入力して開きます。アベイラビリティーゾーンは「AZ ID (AZ 名)」の形で並んでいるので、ap-northeast-1c の行を選びます。リソースは `web-alb` です。',
          hotspotId: 'arc-shift-az',
          done: (c) => !!activeShift(c.env),
        },
      ],
      validate: (c) => {
        const s = activeShift(c.env);
        if (!s) return ng(hakase('まだゾーンシフトが始まっておらん。検索バーで「ゾーンシフト」を開き、**ゾーンシフトを開始** だ。リソースの一覧に `web-alb` が出なければ、さっきの属性が保存されているか見直すのだ。'));
        if (s.awayFrom !== IMPAIRED_AZ_ID)
          return ng(hakase(`今のシフトは ${azLabel(c.env, s.awayFrom)} から移しておる。悪いのは ap-northeast-1c、AZ ID だと \`${IMPAIRED_AZ_ID}\` だ。一覧で選んで **ゾーンシフトをキャンセル** し、開始し直すのだ。AZ は更新では変えられん。`), node('元気な AZ を通行止めにしてました……。'));
        if (shiftHours(c.env) < 50 / 60 || shiftHours(c.env) > 70 / 60) return ng(hakase('有効期限が 1 時間になっておらん。一覧で選んで **アクション** → **ゾーンシフトを更新** で、有効期限を 1 時間にするのだ。'));
        if (!s.comment.trim()) return ng(hakase('コメントが空だ。一覧で選んで **ゾーンシフトを更新** から、なぜシフトしたのかを書いておくのだ。'));
        return ok(
          node('始まりました！ ステータスが「アクティブ」、適用ステータスが「適用済み」です。'),
          hakase('コメントは、未来の自分と同僚への置き手紙だ。夜中に一覧を見た誰かが「誰が、なぜ 1c を止めたのか」を、君を叩き起こさずに知ることができる。'),
          node('僕の睡眠を守るための機能だったんですね。'),
          hakase('君の睡眠に興味はないが、結果としてそうなる。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        hakase('さて、お客様から見て直ったかを確かめよう。パネルの「ブラウザ」タブで、`web-alb` の DNS 名を何回か開くのだ。'),
        node('前は 3 回に 1 回エラーでしたよね。'),
        hakase('そうだ。だから 1 回 200 が出ただけでは安心できん。少なくとも 3 回続けて確かめる。'),
        node('「通信経路の診断 (学習用)」も開いておきます。'),
        hakase('うむ。ゾーンシフトが効いていれば、ALB がどの AZ を避けているかもそこに出る。'),
        node('ターゲットグループの画面にも、何か変化はあるんですか？'),
        hakase('ターゲットの表に **管理オーバーライド** という列が増えて、web-2 が「ゾーンシフトがアクティブ」になる。ヘルスチェックの結果とは別に、ARC が「ここには送るな」と上書きしている印だ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'エラーが消えたことを確かめる',
      objective: 'パネルの「ブラウザ」タブで `web-alb` の DNS 名を **3 回続けて** 開き、すべて HTTP 200 になることを確認する',
      tasks: [
        { id: 'browse', title: '「ブラウザ」タブで `web-alb` の DNS 名を開く', hint: 'ロードバランサー一覧の DNS 名をコピーして貼り付け、**移動** を押します。', done: (c) => !!albRequests(c)[0] && shiftedOk(albRequests(c)[0]) },
        { id: 'thrice', title: '続けて 3 回開いて、3 回とも 200 になることを確かめる', hint: '**移動** を何回か押します。応答したインスタンスの名前が本文に出ます。', done: threeShiftedOk },
      ],
      validate: (c) => {
        const last = albRequests(c)[0];
        if (!last || !last.hops.some((h) => h.checks.some((x) => x.label === SHIFT_CHECK))) return ng(hakase('ゾーンシフトを開始したあとで、「ブラウザ」タブで `web-alb` を開くのだ。「通信経路の診断」に「ゾーンシフト (ARC)」の行が出ていれば、シフトが効いておる。'));
        if (!threeShiftedOk(c)) return ng(hakase('続けて 3 回とも 200 になるまで確かめるのだ。エラーが出たなら、ゾーンシフトの一覧でステータスが「アクティブ」かを見たまえ。'));
        return ok(
          node('3 回とも 200 です！ 応答したのは web-1 と web-3 だけで、web-2 は一度も出てきません。'),
          hakase('診断にも「ゾーンシフト (ARC)」の行が出ておるな。1c のターゲットには、新しいリクエストを送っておらん。'),
          node('`web-alb-5xx-1c` は「データ不足」になりました。'),
          hakase('1c にリクエストが行かんから、数えるエラーもないのだ。壊れた AZ から目をそらしただけで、直したわけではないのを忘れるな。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('博士、あれから 40 分たちました。AWS Health にお知らせが出てます。「apne1-az2 で一部のインスタンスのネットワーク接続エラーが増えていました。現在は解決しています」だそうです。'),
        hakase('やはり apne1-az2、うちの 1c だったな。AWS の発表は、ワシらがシフトしてからずいぶん後だ。'),
        node('直ったなら、有効期限が来るまで放っておいてもいいですか？ どうせ勝手に戻りますし。'),
        hakase('今の web-alb は、2 つの AZ だけで動いておる。ここでもう 1 つの AZ が転んだら、残りは 1 つだ。'),
        node('片足立ちでバナナの皮に乗ってる、みたいな？'),
        hakase('妙に具体的だな。直ったと分かったら早めに戻して、3 つの AZ に戻す。ゾーンシフトの一覧で選んで **ゾーンシフトをキャンセル** だ。'),
        node('キャンセルしたら、web-2 にもまたリクエストが行くんですよね。'),
        hakase('そうだ。戻したら、web-2 が 200 を返すところまで自分の目で見るのだ。「戻しました、たぶん大丈夫です」は報告ではない。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ゾーンシフトをキャンセルして元に戻す',
      objective: 'ゾーンシフトを **キャンセル** し、「ブラウザ」タブで `web-2` が HTTP 200 を返すことを確かめる',
      tasks: [
        { id: 'cancel', title: 'ゾーンシフトの一覧で選んで **アクション** → **ゾーンシフトをキャンセル** → **確認**', hint: 'ステータスが「アクティブ」の行を選びます。', hotspotId: 'arc-shift-actions', done: (c) => canceled(c.env) },
        { id: 'web2', title: '「ブラウザ」タブで何回か開いて、`web-2` が 200 を返すのを確かめる', hint: 'ALB は 3 台に順に振り分けます。本文に `web-2` と出るまで **移動** を押します。', done: web2Ok },
      ],
      validate: (c) => {
        if (activeShift(c.env)) return ng(hakase('ゾーンシフトがまだアクティブだ。ゾーンシフトの一覧で選んで、**アクション** → **ゾーンシフトをキャンセル** だ。'));
        if (!canceled(c.env)) return ng(hakase('ゾーンシフトをキャンセルした記録がない。有効期限が切れるのを待つのではなく、自分でキャンセルして戻すのだ。'));
        if (!recovered(c.env)) return ng(hakase('ap-northeast-1c は、まだ直りきっておらん。少し待ってから、もう一度ブラウザタブで確かめるのだ。'));
        if (!web2Ok(c)) return ng(hakase('web-2 が 200 を返すところを、まだ見ておらん。「ブラウザ」タブで何回か開いて、本文に `web-2` と出るまで確かめるのだ。'));
        return ok(
          node(`web-2 から 200 が返ってきました！ \`${azAlarm(IMPAIRED_AZ)}\` も ${evaluateAlarm(c.env, alarmNamed(c.env, azAlarm(IMPAIRED_AZ))!).state === 'OK' ? 'OK に戻りました' : 'もうすぐ OK に戻りそうです'}。`),
          hakase('3 つの AZ に戻ったな。お客様は何も知らずに買い物を続けておる。それが一番だ。'),
          node('僕たちの活躍、誰にも知られないんですね。'),
          hakase('運用とはそういうものだ。目立つのは、しくじったときだけだ。'),
        );
      },
    },
    {
      type: 'dialogue',
      lines: [
        node('今回は僕たちが気づいたからよかったですけど、夜中だったら……。'),
        hakase('そこで **ゾーンオートシフト** だ。AWS が自分の監視で AZ の障害を見つけたとき、君の代わりにゾーンシフトを始めてくれる。'),
        node('寝てる間に通行止めにしてくれるんですね！ 最初から全部それでいいじゃないですか。'),
        hakase('甘い。AZ を 1 つ外したら、残りの AZ で全部のお客様を受け止めることになる。台数が足りなければ、今度はすべての AZ が重くなる。'),
        node('通行止めのせいで、ほかの橋が大渋滞する、と。'),
        hakase('だからゾーンオートシフトを有効にするには、**練習実行** の設定が要る。AWS が週に 1 回くらい、どれか 1 つの AZ から 30 分だけトラフィックを移して、残りで耐えられるかを試す。避難訓練だな。'),
        node('れんしゅうじっこう……訓練で、本当にお客様のリクエストを動かすんですか？'),
        hakase('本番で動かすから意味がある。その代わり、**結果アラーム** を 1 つ以上必ず指定する。訓練の間に結果アラームが鳴ったら、練習実行は「失敗」として打ち切られ、トラフィックは元に戻る。'),
        node('訓練で火事になったら、すぐ中止ってことですね。'),
        hakase('ほかに、任意で **ブロッキングアラーム** も選べる。これが鳴っている間は、訓練を始めない。セールの日のように訓練されては困る日は、**ブロックされた日付** で外しておける。'),
        node('結果アラームには、AZ ごとのアラームを選べばいいですか？'),
        hakase('AZ ごとのものはやめておけ。訓練でその AZ を外すと、さっきのようにデータ不足になって何も見張れん。お客様全体への影響を見る `web-alb-5xx` を選ぶのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'ゾーンオートシフトを設定する',
      objective: '**ゾーンオートシフト** で `web-alb` の練習実行を設定し (結果アラームは `web-alb-5xx`)、ゾーンオートシフトを **有効化** する',
      tasks: [
        {
          id: 'practice',
          title: 'ゾーンオートシフト → **ゾーンオートシフトを設定** → リソース `web-alb`、結果アラーム `web-alb-5xx` を選んで **作成**',
          hint: 'ゾーンシフトの画面の左メニュー「ゾーンオートシフト」から開きます。確認のチェックを入れると **作成** を押せます。',
          hotspotId: 'arc-outcome-alarm',
          done: (c) => !!configOf(c.env, alb(c.env)?.loadBalancerArn ?? '')?.practiceRunConfiguration,
        },
        { id: 'enable', title: 'ゾーンオートシフトを **有効化** する', hint: '設定画面で「ゾーンオートシフトを有効化」を選んで作成するか、一覧で選んで **アクション** → **ゾーンオートシフトを有効化** を押します。', done: (c) => autoshiftOn(c.env) },
      ],
      validate: (c) => {
        const names = outcomeAlarmNames(c.env);
        if (!names.length) return ng(hakase('`web-alb` の練習実行設定がまだない。**ゾーンオートシフトを設定** で、結果アラームに `web-alb-5xx` を選んで作成するのだ。'));
        if (!names.includes(ALB_5XX_ALARM))
          return ng(hakase(`結果アラームが ${names.map((n) => `\`${n}\``).join(', ')} になっておる。AZ ごとのアラームでは、訓練で外した AZ がデータ不足になって何も見張れん。一覧で選んで **アクション** → **練習実行設定を編集** から \`${ALB_5XX_ALARM}\` を選ぶのだ。`));
        if (!autoshiftOn(c.env)) return ng(hakase('練習実行の設定はできた。あとはゾーンオートシフトを有効にするだけだ。一覧で選んで **アクション** → **ゾーンオートシフトを有効化** だ。'));
        return ok(
          node('ゾーンオートシフトが「有効」、結果アラームは `web-alb-5xx` です。これで夜中も安心ですね！'),
          hakase('安心するのは、練習実行が何回か成功してからだ。訓練で毎回失敗するなら、それは「AZ を 1 つ失うと耐えられない」という、ありがたい知らせだ。'),
          node('そのときは、台数を増やすんですね。'),
          hakase('うむ。1 つの AZ が丸ごと使えなくなっても、残りで回る台数を普段から置いておく。それが本当の意味のマルチ AZ だ。請求書は少し増えるがな。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('問題だ。ap-northeast-1c の web-2 がエラーを返していたのに、ALB が web-2 を外さなかったのはなぜかな？'),
      options: ['ALB のクロスゾーン負荷分散がオフだったから', '小さな `/health` のヘルスチェックは成功していて、ターゲットが「正常」のままだったから', 'web-2 のセキュリティグループが ALB からの通信を拒否していたから'],
      answer: 1,
      explanation: [
        hakase('正解。重いリクエストだけが時間切れになり、軽いヘルスチェックは成功する。これがグレー障害だ。'),
        hakase('ヘルスチェックが「正常」でも安心せず、AZ ごとのメトリクスやアラームで、お客様が実際に受けている応答を見るのだ。'),
      ],
      wrong: [hakase('ターゲットグループの画面を思い出すのだ。3 台のヘルスステータスは何だったかな？')],
    },
    {
      type: 'quiz',
      question: hakase('ゾーンシフトで、トラフィックを移す元の AZ を指定するときに使うのはどれかな？'),
      options: ['AZ 名 (`ap-northeast-1c`)', 'AZ ID (`apne1-az2`)', 'サブネット ID (`subnet-…`)'],
      answer: 1,
      explanation: [
        hakase('正解。AZ 名と建物の対応はアカウントごとに違う。AZ ID なら、どのアカウントから見ても同じ場所を指す。'),
        hakase('AWS Health のお知らせも AZ ID で書かれる。AZ 名で話していると、同じ建物の話をしているのかすら分からんぞ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後の問題だ。ゾーンオートシフトを有効にするために、必ず要るものはどれかな？'),
      options: ['練習実行の設定 (結果アラームを 1 つ以上)', 'ブロッキングアラーム', '3 つ以上の AZ にまたがるターゲット'],
      answer: 0,
      explanation: [
        hakase('正解。練習実行の設定がないと、ゾーンオートシフトは有効にできん。結果アラームは必須で、ブロッキングアラームやブロックする日付・時間枠は任意だ。'),
        hakase('訓練をしていない避難計画は、ただの紙だ。紙は火事のときによく燃える。'),
      ],
    },
  ],
};
