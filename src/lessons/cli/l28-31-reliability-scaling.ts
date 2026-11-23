import { hakase, ng, node, ok, type ExerciseTask, type TaskContext } from '../../lesson/types';
import { liveInstances, policyMetric } from '../../sim/autoscaling';
import { currentTables, findSnapshot } from '../../sim/rds';
import { ORDERS } from '../../sim/scenarios';
import type { AwsEnv } from '../../sim/types';
import { albReachesWeb, dbNamed, instanceNamed, lastRequestTo, lastRun, lbNamed, sgNamed, subnetNamed, tgNamed, webReachesDb } from '../helpers';
import { insideInstance, param, ranAws } from './helpers';
import type { CliPatches } from './types';

/* ---------- Lesson 28-29: バックアップと復元 ---------- */

const SNAP = 'webapp-db-before-migration';
const COUNT = 'mysql -e "SELECT COUNT(*) FROM orders"';
const n = ORDERS.toLocaleString('en-US');
const orders = (env: AwsEnv, id: string) => {
  const db = dbNamed(env, id);
  return db ? currentTables(db).orders : undefined;
};
const usesDbSg = (env: AwsEnv, id: string) => !!dbNamed(env, id)?.vpcSecurityGroupIds.includes(sgNamed(env, 'db-sg')?.groupId ?? '-');
const batchId = (c: TaskContext) => instanceNamed(c.env, 'batch-1')?.instanceId ?? 'i-xxxxxxxxxxxxxxxxx';
const dbSgId = (c: TaskContext) => sgNamed(c.env, 'db-sg')?.groupId ?? 'sg-xxxxxxxxxxxxxxxxx';
const endpoint = (c: TaskContext, id: string) => dbNamed(c.env, id)?.endpointAddress ?? `${id}.xxxxxxxxxxxx.ap-northeast-1.rds.amazonaws.com`;
const createdAt = (env: AwsEnv, ids: string[]) => Math.min(...ids.map((id) => Date.parse(dbNamed(env, id)?.instanceCreateTime ?? '') || Infinity));
/** `since` より後に、PC から batch-1 へ aws ec2-instance-connect ssh した */
const sshed = (c: TaskContext, since = 0) => !!ranAws(c, 'ec2-instance-connect ssh', (x) => param(x, 'instance-id') === batchId(c) && x.at >= since);

const BATCH_ID_QUERY = "aws ec2 describe-instances --filters Name=tag:Name,Values=batch-1 --query 'Reservations[0].Instances[0].InstanceId' --output text";
const connectTask = (title: string, since: (c: TaskContext) => number = () => 0): ExerciseTask => ({
  id: 'connect',
  title,
  hint: `インスタンス ID は \`${BATCH_ID_QUERY}\` で引けます。プロンプトが \`[ec2-user@ip-…]$\` に変われば batch-1 の中です。`,
  command: (c) => `aws ec2-instance-connect ssh --instance-id ${batchId(c)}`,
  done: (c) => sshed(c, since(c)),
});
/* batch-1 から PC に戻る (PC にいれば打たなくてよい) */
const EXIT: ExerciseTask = {
  id: 'exit',
  title: 'batch-1 に入ったままなら、`exit` で PC に戻る',
  hint: 'プロンプトが `[ec2-user@ip-…]$` のままなら、まだ batch-1 の中です。`aws rds …` は PC (`learner@my-pc`) のターミナルで打ちます。PC にいるなら、このタスクは飛ばして構いません。',
  command: 'exit',
  done: (c) => !insideInstance(c, batchId(c)),
};
const DB_SG_QUERY = "DB_SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query 'SecurityGroups[0].GroupId' --output text); echo $DB_SG";

/** Lesson 29: orders が 0 になった時刻 (データの履歴から読む) */
const accidentOf = (env: AwsEnv) => dbNamed(env, 'webapp-db')?.data?.find((d) => d.tables.orders === 0)?.at ?? 0;
const jstDate = (t: number) => new Date(t + 9 * 3_600_000).toISOString().slice(0, 19);
const jst = (t: number) => jstDate(t).slice(11);
const pitrIds = (env: AwsEnv) => env.dbInstances.filter((d) => d.dbInstanceIdentifier.startsWith('webapp-db-pitr')).map((d) => d.dbInstanceIdentifier);
const pitrDbs = (env: AwsEnv) => pitrIds(env).map((id) => dbNamed(env, id)!);
const goodPitr = (env: AwsEnv) => pitrDbs(env).find((d) => currentTables(d).orders === ORDERS && usesDbSg(env, d.dbInstanceIdentifier) && d.status === 'available');

/* ---------- Lesson 30-31: Auto Scaling ---------- */

const ASG = 'webapp-asg';
const asgOf = (env: AwsEnv) => env.autoScalingGroups.find((g) => g.autoScalingGroupName === ASG);
const inService = (env: AwsEnv) => asgOf(env)?.instances.filter((r) => r.lifecycleState === 'InService').length ?? 0;
const albDns = (c: TaskContext) => lbNamed(c.env, 'web-alb')?.dnsName ?? 'web-alb-xxxxxxxxxx.ap-northeast-1.elb.amazonaws.com';
const albStatus = (c: TaskContext) => lastRequestTo(c, lbNamed(c.env, 'web-alb')?.dnsName)?.status;
/** いま効いている負荷 (hey の -z が過ぎれば、ふだんのアクセス = undefined に戻る) */
const load = (env: AwsEnv) => [...(env.traffic ?? [])].reverse().find((x) => x.at <= Date.now())?.rps;
const cpuNow = (env: AwsEnv) => {
  const g = asgOf(env);
  const p = g?.policies[0];
  return g && p ? policyMetric(env, g, { ...p, metric: 'ASGAverageCPUUtilization' }, Date.now()) : undefined;
};
const ALB_DNS = "ALB=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text); echo $ALB";
const ASG_INSTANCES = "aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names webapp-asg --query 'AutoScalingGroups[0].Instances[].[InstanceId,AvailabilityZone,LifecycleState]' --output table";
const ASG_CPU = 'NOW=$(date +%s); aws cloudwatch get-metric-statistics --namespace AWS/EC2 --metric-name CPUUtilization --dimensions Name=AutoScalingGroupName,Value=webapp-asg --statistics Average --period 60 --start-time $((NOW - 600)) --end-time $NOW --output table';
const ranCpu = (c: TaskContext, since = 0) => !!ranAws(c, 'cloudwatch get-metric-statistics', (x) => param(x, 'metric-name') === 'CPUUtilization' && param(x, 'dimensions').includes(ASG) && x.at >= since);
/** 最後に負荷を変えた時刻 */
const loadSetAt = (env: AwsEnv) => [...(env.traffic ?? [])].reverse().find((x) => x.at <= Date.now() && x.rps !== undefined)?.at ?? Infinity;

const TT_CONFIG = `{
  "PredefinedMetricSpecification": {
    "PredefinedMetricType": "ASGAverageCPUUtilization"
  },
  "TargetValue": 50.0
}
`;

const patches: CliPatches = {
  'rds-snapshot': {
    steps: {
      3: {
        type: 'dialogue',
        lines: [
          hakase('スナップショットの一覧は `aws rds describe-db-snapshots` で見られる。`SnapshotType` が `automated` なら自動の方、`manual` なら手動の方だ。'),
          node('今夜撮るのは手動ですね。名前はどうします？'),
          hakase('`webapp-db-before-migration`。「移行前」と一目でわかる名前にしておけ。半年後の君が `test1` という名前を見て、中身を思い出せると思うか。'),
          node('思い出せない自信があります。'),
          hakase('胸を張るな。撮るのは `aws rds create-db-snapshot` だ。`--db-instance-identifier` で撮る DB を、`--db-snapshot-identifier` でスナップショットの名前を指定する。'),
          node('撮ったら、すぐ使えるんですか？'),
          hakase('撮った直後の `Status` は `creating` (作成中) だ。`available` (利用可能) になるまで待つ。作成中は、まだ写真が現像できておらん。'),
          node('現像って… 博士、スマホ世代にその例えは通じないですよ。'),
          hakase('若者はすぐそこに突っ込む。待つなら `aws rds wait db-snapshot-available` が便利だ。`available` になるまで何も表示せずに待ち、なったら戻ってくる。とにかく `available` になるまで、移行を始めてはならんぞ。'),
        ],
      },
      4: {
        type: 'exercise',
        title: '手動スナップショットを取る',
        objective: `今あるスナップショットを確かめてから、\`webapp-db\` の手動スナップショット \`${SNAP}\` を取り、\`available\` になるまで待つ`,
        tasks: [
          {
            id: 'list',
            title: '`aws rds describe-db-snapshots` で今あるスナップショットを見る',
            hint: "`SnapshotType` が `automated` のものが、毎日の自動バックアップです。`--query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotType,Status]' --output table` で、名前・種類・状態だけを表にできます。",
            command: "aws rds describe-db-snapshots --query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotType,Status]' --output table",
            done: (c) => !!ranAws(c, 'rds describe-db-snapshots'),
          },
          {
            id: 'take',
            title: `\`${SNAP}\` を取る`,
            hint: `\`aws rds create-db-snapshot\` に \`--db-instance-identifier webapp-db\` と \`--db-snapshot-identifier ${SNAP}\` を付けます。`,
            command: `aws rds create-db-snapshot --db-instance-identifier webapp-db --db-snapshot-identifier ${SNAP}`,
            done: (c) => !!findSnapshot(c.env, SNAP),
          },
          {
            id: 'wait',
            title: '`Status` が `available` になるまで待つ',
            hint: `\`aws rds wait db-snapshot-available --db-snapshot-identifier ${SNAP}\` は、available になると何も表示せずに戻ってきます。\`describe-db-snapshots\` で \`Status\` を見ても構いません。`,
            command: `aws rds wait db-snapshot-available --db-snapshot-identifier ${SNAP}`,
            done: (c) => findSnapshot(c.env, SNAP)?.status === 'available',
          },
        ],
        validate: (c) => {
          const s = findSnapshot(c.env, SNAP);
          if (!s) return ng(hakase(`\`${SNAP}\` という名前のスナップショットが見当たらん。\`aws rds create-db-snapshot\` の \`--db-snapshot-identifier\` に、名前を一字一句そのとおりに入れるのだ。`));
          if (s.status !== 'available') return ng(hakase(`まだ \`creating\` (作成中) だ。\`aws rds wait db-snapshot-available --db-snapshot-identifier ${SNAP}\` で、\`available\` になるまで待つのだ。`));
          return ok(
            hakase('よし、これで保険ができた。`describe-db-snapshots` に、`SnapshotType` が `manual` の 1 枚が増えておるはずだ。では移行を始めよう。'),
            node('終わったら、ちゃんと消えたか件数を確かめるんですよね。'),
            hakase('そうだ。`SELECT COUNT(*) FROM orders` は、orders の行の数を数える SQL (DB への命令文) だ。batch-1 の `mysql` コマンドには接続先が設定済みだから、`-e` で SQL を 1 本だけ実行できる。'),
            node('3 年より古い分だけ減っていれば成功、ですね。batch-1 には、Lesson 22 でやった `aws ec2-instance-connect ssh` で入ればいいですか？'),
            hakase('うむ。インスタンス ID は `aws ec2 describe-instances` に `--filters Name=tag:Name,Values=batch-1` を付けて引くのだ。'),
          );
        },
      },
      5: {
        type: 'code',
        title: '移行とその確認',
        language: 'bash',
        code: `# PC のターミナルで: batch-1 に入る\naws ec2-instance-connect ssh --instance-id <batch-1 のインスタンス ID>\n# ここからは batch-1 の中\n./migrate.sh\n${COUNT}`,
      },
      6: {
        type: 'exercise',
        title: '移行スクリプトを実行する',
        objective: '`aws ec2-instance-connect ssh` で `batch-1` に入り、`./migrate.sh` を実行してから orders の件数を確認する',
        tasks: [
          connectTask('`batch-1` に `aws ec2-instance-connect ssh` で入る'),
          { id: 'run', title: '`./migrate.sh` を実行', hint: 'batch-1 の中 (プロンプトが `[ec2-user@ip-…]$`) で打ちます。', command: './migrate.sh', done: (c) => !!lastRun(c, 'batch-1', /migrate\.sh/)?.ok },
          { id: 'count', title: `\`${COUNT}\` で件数を確認`, hint: 'migrate.sh と同じ batch-1 の中で打ちます。接続先は `~/.my.cnf` に設定済みなので `-h` は不要です。', command: COUNT, done: (c) => !!lastRun(c, 'batch-1', /select\s+count/i)?.ok },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /migrate\.sh/)?.ok && orders(c.env, 'webapp-db') === 0 && lastRun(c, 'batch-1', /select\s+count/i)?.output.includes('|        0 |')
            ? ok(
                node('え…… COUNT(*) が **0** です！ 全部消えてる！？'),
                hakase('`cat migrate.sh` で中身を見てみるのだ。`DELETE FROM orders; -- WHERE …` と、WHERE の前に `;` がある。'),
                node('本当だ… でも `;` 1 文字で、そんなに変わるんですか？'),
                hakase('SQL では `;` で文が終わり、`--` から後ろはただのコメントだ。条件を書くはずの WHERE が飾りになって、残ったのは `DELETE FROM orders`。つまり**全件削除**だ。'),
              )
            : ng(hakase('migrate.sh を実行して、件数を確かめるのだ。`aws ec2-instance-connect ssh` で batch-1 に入り、`./migrate.sh` のあとに件数を数えるコマンドを打つ。')),
      },
      7: {
        type: 'dialogue',
        lines: [
          node('ど、ど、どうしましょう……本番の注文が、ぜ、全部……'),
          hakase('落ち着け。君の席が消えるかどうかは、これからの 30 分で決まる。'),
          node('全然落ち着けないです！'),
          hakase('そのためのスナップショットだ。さっき撮った `webapp-db-before-migration` から**復元**する。'),
          node('よかった… じゃあ webapp-db を、写真を撮った時点に巻き戻すんですね。'),
          hakase('そこが大事な勘違いだ。**復元は今の DB を巻き戻すのではなく、新しい DB インスタンスを作る**。大事だからもう一度言う。新しい DB インスタンスを作る。'),
          node('なんで 2 回言ったんですか。'),
          hakase('本番の真っ最中に、1 回目を聞き流す人間を何人も見てきたからだ。コマンドは `aws rds restore-db-instance-from-db-snapshot`。新しいものだから、`--db-instance-identifier` (DB インスタンス識別子) も別にする。今回は `webapp-db-restored` だ。'),
          node('DB インスタンス識別子って、Lesson 14 で `webapp-db` って付けた名前でしたよね。'),
          hakase('うむ。名前が違えば、**エンドポイント**も別になる。'),
          node('エンドポイントは、アプリが DB につなぐときの住所でしたよね。`describe-db-instances` の `Endpoint` の `Address` に出てた長いやつ。'),
          hakase('そうだ。そしてもう 1 つ。**セキュリティグループは引き継がれない**。`--vpc-security-group-ids` を付けなければ、VPC に最初から用意されている `default` のセキュリティグループが付く。'),
          node('default だと何がまずいんです？'),
          hakase('db-sg にある「web-sg と batch-sg からの 3306 番を許可」というルールがない。せっかく復元しても、誰も開けられない金庫になる。必ず `--vpc-security-group-ids` で `db-sg` の ID を指定し、置き場所の `--db-subnet-group-name` も元と同じ `webapp-db-subnet-group` にするのだ。'),
        ],
      },
      8: {
        type: 'exercise',
        title: 'スナップショットから復元する',
        objective: `\`${SNAP}\` から DB インスタンス \`webapp-db-restored\` を復元する。VPC セキュリティグループは \`db-sg\` にする`,
        tasks: [
          EXIT,
          { id: 'sg', title: '`db-sg` のセキュリティグループ ID を調べる', hint: "`aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg --query 'SecurityGroups[0].GroupId' --output text`。`DB_SG=$(...)` で変数に入れておくと楽です。", command: DB_SG_QUERY, done: (c) => !!ranAws(c, 'ec2 describe-security-groups', (x) => x.output.includes(dbSgId(c))) },
          {
            id: 'restore',
            title: '`aws rds restore-db-instance-from-db-snapshot` で `webapp-db-restored` を作る',
            hint: `\`--db-instance-identifier webapp-db-restored --db-snapshot-identifier ${SNAP} --db-subnet-group-name webapp-db-subnet-group\` に、\`--vpc-security-group-ids $DB_SG\` を付けます。`,
            command: (c) => `aws rds restore-db-instance-from-db-snapshot --db-instance-identifier webapp-db-restored --db-snapshot-identifier ${SNAP} --db-subnet-group-name webapp-db-subnet-group --vpc-security-group-ids ${dbSgId(c)}`,
            done: (c) => !!dbNamed(c.env, 'webapp-db-restored'),
          },
          {
            id: 'available',
            title: '`available` になるまで待つ',
            hint: '`aws rds wait db-instance-available --db-instance-identifier webapp-db-restored`。`DBInstanceStatus` は creating → backing-up → available の順に変わります。',
            command: 'aws rds wait db-instance-available --db-instance-identifier webapp-db-restored',
            done: (c) => dbNamed(c.env, 'webapp-db-restored')?.status === 'available',
          },
        ],
        validate: (c) => {
          const db = dbNamed(c.env, 'webapp-db-restored');
          if (!db) return ng(hakase(`webapp-db-restored が見当たらん。PC のターミナルで \`aws rds restore-db-instance-from-db-snapshot\` を打つのだ。\`--db-instance-identifier webapp-db-restored\` と \`--db-snapshot-identifier ${SNAP}\` を忘れるな。`));
          if (!usesDbSg(c.env, 'webapp-db-restored'))
            return ng(hakase('セキュリティグループが db-sg になっていない。default のままだと、web サーバーからも batch-1 からも接続できんぞ。`available` になってから `aws rds modify-db-instance --db-instance-identifier webapp-db-restored --vpc-security-group-ids <db-sg の ID> --apply-immediately` で付け替えるのだ。'));
          if (db.status !== 'available') return ng(hakase('まだ作成中だ。`aws rds wait db-instance-available --db-instance-identifier webapp-db-restored` で待つのだ。DB を 1 台まるごと作るのだから、カップ麺よりは待たされる。'));
          return ok(
            hakase('新しい DB インスタンスができた。'),
            node('これで元どおり、ですよね？'),
            hakase('気が早い。「復元できたはず」と「データが戻っている」は別物だ。本当にデータが戻っているか、自分の目で確かめよう。'),
          );
        },
      },
      9: {
        type: 'exercise',
        title: '復元した DB のデータを確かめる',
        objective: '`webapp-db-restored` のエンドポイントを調べ、batch-1 で `mysql -h <エンドポイント> -e "SELECT COUNT(*) FROM orders"` を実行して件数を確認する',
        tasks: [
          {
            id: 'endpoint',
            title: '`webapp-db-restored` のエンドポイントを調べる',
            hint: "`aws rds describe-db-instances --db-instance-identifier webapp-db-restored --query 'DBInstances[0].Endpoint.Address' --output text`。batch-1 の中ではシェルの変数が使えないので、表示されたエンドポイントをコピーしておきます。",
            command: "aws rds describe-db-instances --db-instance-identifier webapp-db-restored --query 'DBInstances[0].Endpoint.Address' --output text",
            done: (c) => !!ranAws(c, 'rds describe-db-instances', (x) => x.output.includes(endpoint(c, 'webapp-db-restored'))),
          },
          connectTask('もう一度 `batch-1` に入る', (c) => createdAt(c.env, ['webapp-db-restored'])),
          {
            id: 'check',
            title: '`mysql -h webapp-db-restored.… -e "SELECT COUNT(*) FROM orders"`',
            hint: 'batch-1 の中で、`-h` のあとにコピーしたエンドポイントを貼り付けます。',
            command: (c) => `mysql -h ${endpoint(c, 'webapp-db-restored')} -e "SELECT COUNT(*) FROM orders"`,
            done: (c) => !!lastRun(c, 'batch-1', /-h\s*\S*webapp-db-restored/)?.ok,
          },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /-h\s*\S*webapp-db-restored/)?.output.includes(String(ORDERS))
            ? ok(
                node(`${n} 件！ スナップショットを取った時点のデータです。`),
                hakase('よし。あとはアプリをこの DB に向けるだけだ。'),
                node('アプリの設定の接続先を、新しいエンドポイントに書き換えるんですか？'),
                hakase('それでもよいが、もっと楽な手がある。**名前を入れ替える**のだ。Lesson 25 でインスタンスクラスを上げたときと同じ `aws rds modify-db-instance` に、`--new-db-instance-identifier` で新しい識別子を渡し、`--apply-immediately` (すぐに適用) を付ける。'),
                node('壊れた方を別の名前に逃がして、空いた `webapp-db` の名前を新しい方に付けるってことですね。'),
              )
            : ng(hakase('復元した DB のエンドポイントを `-h` に指定して、件数を確かめるのだ。エンドポイントは `aws rds describe-db-instances --db-instance-identifier webapp-db-restored` の `Endpoint.Address` だ。`-h` を付けないと、壊れた webapp-db を数えることになるぞ。')),
      },
      10: {
        type: 'exercise',
        title: '名前を入れ替えて切り替える',
        objective: '壊れた `webapp-db` を `webapp-db-broken` に名前変更し、その後 `webapp-db-restored` を `webapp-db` に名前変更する',
        tasks: [
          EXIT,
          {
            id: 'old',
            title: '`webapp-db` の識別子を `webapp-db-broken` に変える',
            hint: '`aws rds modify-db-instance --db-instance-identifier webapp-db --new-db-instance-identifier webapp-db-broken --apply-immediately`',
            command: 'aws rds modify-db-instance --db-instance-identifier webapp-db --new-db-instance-identifier webapp-db-broken --apply-immediately',
            done: (c) => !!dbNamed(c.env, 'webapp-db-broken'),
          },
          {
            id: 'new',
            title: '`webapp-db-restored` の識別子を `webapp-db` に変える',
            hint: '`webapp-db` という名前が空いていないと `DBInstanceAlreadyExists` エラーになります。1 つ目の名前変更を済ませてから打ちます。',
            command: 'aws rds modify-db-instance --db-instance-identifier webapp-db-restored --new-db-instance-identifier webapp-db --apply-immediately',
            done: (c) => !!dbNamed(c.env, 'webapp-db-broken') && orders(c.env, 'webapp-db') === ORDERS,
          },
          {
            id: 'wait',
            title: '新しい `webapp-db` が `available` になるまで待つ',
            hint: '名前の変更中は `DBInstanceStatus` が `renaming` です。`aws rds wait db-instance-available --db-instance-identifier webapp-db` で待ちます。',
            command: 'aws rds wait db-instance-available --db-instance-identifier webapp-db',
            done: (c) => !!dbNamed(c.env, 'webapp-db-broken') && orders(c.env, 'webapp-db') === ORDERS && dbNamed(c.env, 'webapp-db')?.status === 'available',
          },
        ],
        validate: (c) => {
          if (!dbNamed(c.env, 'webapp-db-broken')) return ng(hakase('まず壊れた webapp-db を webapp-db-broken に名前変更するのだ。`aws rds modify-db-instance --db-instance-identifier webapp-db --new-db-instance-identifier webapp-db-broken --apply-immediately` だ。'));
          if (orders(c.env, 'webapp-db') !== ORDERS) return ng(hakase('webapp-db という名前の DB が、まだ復元したデータになっていない。次は `webapp-db-restored` の識別子を、`--new-db-instance-identifier webapp-db` で変えるのだ。'));
          if (dbNamed(c.env, 'webapp-db')?.status !== 'available') return ng(hakase('名前の変更中 (`renaming`) だ。`aws rds wait db-instance-available --db-instance-identifier webapp-db` で、`available` になるまで待つのだ。'));
          if (!webReachesDb(c.env) || !albReachesWeb(c.env)) return ng(hakase('アプリから DB に届いていない。新しい `webapp-db` の `VpcSecurityGroups` が `db-sg` になっているか、`aws rds describe-db-instances --db-instance-identifier webapp-db` で確かめるのだ。'));
          return ok(
            node('アプリの設定を変えずに、元のエンドポイント名のまま復旧できました！'),
            hakase('エンドポイントは DB インスタンス識別子から作られる。だから名前を入れ替えれば、アプリも batch-1 の `~/.my.cnf` (mysql コマンドの接続先を書いた設定ファイル) も、そのまま新しい DB を見るのだ。'),
            node('壊れた webapp-db-broken は、もう消していいですか？ 見てると胃が痛くて。'),
            hakase('まだ消すな。調査が終わるまでは大事な証拠だ。証拠を消しても、始末書が 2 枚に増えるだけだぞ。'),
          );
        },
      },
    },
  },

  'rpo-rto-dr': {
    steps: {
      3: [
        {
          type: 'dialogue',
          lines: [
            node('博士、大変です！ さっきのクリーンアップ処理が orders を**全件消しました**。そのあとも新しい注文は少し入ってきてます……'),
            hakase('……噂をすれば、か。今度は新人ではなく、クリーンアップのバッチ処理が犯人だな。'),
            node('前回と同じで、WHERE が効いてないみたいです。しかも今回は、作業前のスナップショットなんて撮ってません！'),
            hakase('手動のはな。だが**自動バックアップ**はある。Lesson 28 の表を覚えておるか。'),
            node('毎日のスナップショットと、5 分ごとのトランザクションログ、でしたよね。'),
            hakase('そうだ。夜中の自動スナップショットに戻すと、それ以降の今日の注文がすべて消える。RPO は半日以上だ。'),
            node('それはまずいです。社長の顔色が……'),
            hakase('そこで**特定時点への復元**だ。スナップショットにトランザクションログを足して、事故の直前まで戻す。秒単位で時点を選べるぞ。コマンドは `aws rds restore-db-instance-to-point-in-time` だ。'),
            node('日記帳を、事故の直前のページまで読み返すってことですね。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            hakase('うむ。戻す時点の決め方は 2 通りある。`--use-latest-restorable-time` は**最新の復元可能時間**、`--restore-time` は自分で決めた日時だ。最新を選ぶと、ログがある一番新しい時点……つまり DELETE の**後**に戻ってしまう。'),
            node('空っぽの状態を丁寧に復元しても、意味ないですもんね。'),
            hakase('だから、まず事故の正確な時刻を調べる。batch-1 の `cleanup.log` に記録が残っておるはずだ。'),
            node('時刻は、どう書けばいいんですか？'),
            hakase('`--restore-time` は ISO 8601 という形で書く。`2026-01-15T14:59:00+09:00` のように日付と時刻を `T` でつなぎ、最後に `+09:00` を付ければ日本時間 (UTC+09:00) だ。UTC は世界の基準の時刻で、日本はそれより 9 時間進んでおる。'),
            node('`+09:00` を付け忘れたら？'),
            hakase('タイムゾーンのない時刻は UTC とみなされる。9 時間先を指定したことになり、`InvalidRestoreFault` で「その時刻には戻せん」と怒られる。戻せる範囲は `aws rds describe-db-instance-automated-backups` の `RestoreWindow` に出るぞ。'),
          ],
        },
      ],
      4: {
        type: 'exercise',
        title: '事故の時刻を調べる',
        objective: '`batch-1` に `aws ec2-instance-connect ssh` で入り、`cat cleanup.log` で DELETE が実行された時刻を確認する',
        tasks: [
          connectTask('`batch-1` に `aws ec2-instance-connect ssh` で入る'),
          { id: 'log', title: '`cat cleanup.log`', hint: 'batch-1 の中 (プロンプトが `[ec2-user@ip-…]$`) で打ちます。', command: 'cat cleanup.log', done: (c) => !!lastRun(c, 'batch-1', /cat\s+cleanup\.log/)?.ok },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /cat\s+cleanup\.log/)?.ok
            ? ok(
                node(`DELETE は **${jst(accidentOf(c.env))}** (日本時間) です。`),
                hakase('ではその少し前、1 分前あたりを復元時点にしよう。'),
                node('特定時点への復元も、前回みたいに新しい DB ができるんですよね。'),
                hakase('そうだ。`--target-db-instance-identifier` は `webapp-db-pitr`。PITR は Point-In-Time Recovery (特定時点への復元) の頭文字だ。`--vpc-security-group-ids` で `db-sg` を指定するのも忘れるな。君の記憶が揮発性でなければな。'),
              )
            : ng(hakase('cleanup.log を開くのだ。`aws ec2-instance-connect ssh` で batch-1 に入って、`cat cleanup.log` と打つ。')),
      },
      5: {
        type: 'exercise',
        title: '特定時点への復元',
        objective: '`webapp-db` を事故の少し前の日時 (`--restore-time`) に復元して `webapp-db-pitr` を作る。セキュリティグループは `db-sg`',
        tasks: [
          EXIT,
          {
            id: 'window',
            title: '`aws rds describe-db-instance-automated-backups` で戻せる範囲を確かめる',
            hint: '`RestoreWindow` の `EarliestTime` から `LatestTime` までが戻せる範囲です (UTC で表示されます)。`LatestTime` が「最新の復元可能時間」です。',
            command: "aws rds describe-db-instance-automated-backups --db-instance-identifier webapp-db --query 'DBInstanceAutomatedBackups[0].RestoreWindow'",
            done: (c) => !!ranAws(c, 'rds describe-db-instance-automated-backups'),
          },
          {
            id: 'restore',
            title: '`aws rds restore-db-instance-to-point-in-time` で `webapp-db-pitr` を作る',
            hint: '`--source-db-instance-identifier webapp-db --target-db-instance-identifier webapp-db-pitr --restore-time <事故の 1 分前>+09:00`。`--db-subnet-group-name webapp-db-subnet-group` と、`--vpc-security-group-ids` に db-sg の ID (`aws ec2 describe-security-groups --filters Name=group-name,Values=db-sg`) も付けます。',
            command: (c) => `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier webapp-db --target-db-instance-identifier webapp-db-pitr --restore-time ${jstDate(accidentOf(c.env) - 60_000)}+09:00 --db-subnet-group-name webapp-db-subnet-group --vpc-security-group-ids ${dbSgId(c)}`,
            done: (c) => pitrDbs(c.env).length > 0,
          },
          {
            id: 'available',
            title: '`available` になるまで待つ',
            hint: '`aws rds wait db-instance-available --db-instance-identifier webapp-db-pitr`。`DBInstanceStatus` は creating → backing-up → available の順に変わります。',
            command: 'aws rds wait db-instance-available --db-instance-identifier webapp-db-pitr',
            done: (c) => pitrDbs(c.env).some((d) => d.status === 'available'),
          },
        ],
        validate: (c) => {
          if (goodPitr(c.env))
            return ok(
              hakase('復元できたな。'),
              node('前回みたいに、件数を数えて確かめるんですよね。'),
              hakase('ほう、言われる前に言うとは。今日は槍でも降るのか。データは何件あるか、確かめてみよう。'),
            );
          const dbs = pitrDbs(c.env);
          if (!dbs.length)
            return ng(
              hakase('webapp-db-pitr が見当たらん。PC のターミナルで `aws rds restore-db-instance-to-point-in-time` に `--source-db-instance-identifier webapp-db` と `--target-db-instance-identifier webapp-db-pitr` を付けるのだ。'),
              hakase('`InvalidRestoreFault` が出たなら、`--restore-time` が `RestoreWindow` の範囲に入っておらん。`+09:00` を付け忘れておらんか。'),
            );
          if (dbs.every((d) => currentTables(d).orders === 0))
            return ng(
              hakase('空っぽの orders を、丁寧に復元してしまったな。復元した時点がすでに事故の後だ。'),
              hakase('`--use-latest-restorable-time` ではなく、`--restore-time` で事故より前の日時を指定するのだ。`--target-db-instance-identifier` を `webapp-db-pitr2` にして、もう一度復元すればよい。'),
            );
          if (!dbs.some((d) => usesDbSg(c.env, d.dbInstanceIdentifier))) return ng(hakase('セキュリティグループが db-sg になっていない。`available` になってから、`aws rds modify-db-instance` に `--vpc-security-group-ids <db-sg の ID> --apply-immediately` を付けて付け替えるのだ。'));
          return ng(hakase('まだ作成中だ。`aws rds wait db-instance-available` で `available` になるまで待つのだ。'));
        },
      },
      6: {
        type: 'exercise',
        title: '失ったデータを比べる',
        objective: '`webapp-db-pitr` のエンドポイントを調べ、batch-1 で `mysql -h <エンドポイント> -e "SELECT COUNT(*) FROM orders"` を実行して件数を確認する',
        tasks: [
          {
            id: 'endpoint',
            title: '`webapp-db-pitr` のエンドポイントを調べる',
            hint: "`aws rds describe-db-instances --db-instance-identifier webapp-db-pitr --query 'DBInstances[0].Endpoint.Address' --output text`。表示されたエンドポイントをコピーしておきます。",
            command: "aws rds describe-db-instances --db-instance-identifier webapp-db-pitr --query 'DBInstances[0].Endpoint.Address' --output text",
            done: (c) => !!ranAws(c, 'rds describe-db-instances', (x) => pitrIds(c.env).some((id) => x.output.includes(endpoint(c, id)))),
          },
          connectTask('もう一度 `batch-1` に入る', (c) => createdAt(c.env, pitrIds(c.env))),
          {
            id: 'check',
            title: '`mysql -h webapp-db-pitr.… -e "SELECT COUNT(*) FROM orders"`',
            hint: 'batch-1 の中で、`-h` のあとにコピーしたエンドポイントを貼り付けます。',
            command: (c) => `mysql -h ${endpoint(c, goodPitr(c.env)?.dbInstanceIdentifier ?? 'webapp-db-pitr')} -e "SELECT COUNT(*) FROM orders"`,
            done: (c) => !!lastRun(c, 'batch-1', /-h\s*\S*webapp-db-pitr/)?.ok,
          },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /-h\s*\S*webapp-db-pitr/)?.output.includes(String(ORDERS))
            ? ok(
                node(`${n} 件！ 夜中の自動スナップショットは 4,112 件少なかったので、そっちに戻していたら今日の注文が消えてました。`),
                hakase('特定時点への復元で、RPO は「数分」になった。事故のあとに入った 58 件は、今の webapp-db から移せばよい。'),
                node('助かりました… でも、DB どころか東京リージョンごと使えなくなったら、どうするんです？'),
                hakase('そこで DR だ。代表的な戦略が 4 つある。表にしておいたから、RPO と RTO とコストを見比べてみろ。'),
              )
            : ng(hakase('webapp-db-pitr のエンドポイントで件数を確かめるのだ。エンドポイントは `aws rds describe-db-instances --db-instance-identifier webapp-db-pitr` の `Endpoint.Address` だ。batch-1 に入って、それを `mysql -h` のあとに貼り付ける。')),
      },
    },
  },

  'asg-basics': {
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          hakase('良い質問だ。**起動テンプレート** から来る。何を起動するかを書いた設計図だ。'),
          node('設計図… 何が書いてあるんです？'),
          hakase('Lesson 10 で `aws ec2 run-instances` を打ったとき、どんなオプションを付けたか覚えておるか。'),
          node('`--image-id`、`--instance-type`、`--key-name`、`--subnet-id`、`--security-group-ids` でしたよね。'),
          hakase('うむ。AMI は OS やソフトが入ったディスクの型、インスタンスタイプは CPU とメモリの大きさだった。あれを毎回打つ代わりに、テンプレートに保存しておくのだ。'),
          node('毎回同じ注文を書かなくていい、定食屋の「いつもの」みたいなものですね。'),
          hakase('そして大事なのが **ユーザーデータ** だ。インスタンスが最初に起動したとき、自動で実行されるスクリプトのことだ。'),
          node('ゆーざーでーた？ ユーザーの個人情報じゃないんですか。'),
          hakase('紛らわしい名前だが違う。今回の `webapp-lt` なら、ユーザーデータに「アプリをインストールして、ポート 3000 で起動する」手順が書いてある。'),
          node('じゃあ、起動しただけでアプリが動いてる羊が届くってことですね。'),
          hakase('羊ではなく EC2 だ。……まあ、そういうことだ。'),
        ],
      },
      4: [
        {
          type: 'dialogue',
          lines: [
            hakase('まずは設計図の `webapp-lt` を見てみよう。起動テンプレートの一覧は `aws ec2 describe-launch-templates`、中身は `aws ec2 describe-launch-template-versions` だ。'),
            node('ばーじょんず？ テンプレートにも版があるんですか。'),
            hakase('書き換えるたびに番号が増える。今日は既定 (Default) の版を `--versions \'$Default\'` で指定して見る。`$` で始まる言葉はシェルが変数だと思って消してしまうから、`\'` で囲むのを忘れるな。'),
            node('ユーザーデータも、そこに出るんですか？'),
            hakase('出るが、`UserData` は **Base64** という形に変換されておる。文字を、英数字と `+` `/` `=` だけで書き直したものだ。'),
            node('べーすろくじゅうよん？ 暗号ですか。'),
            hakase('暗号ではない。誰でも元に戻せる、ただの書き直しだ。`--query` で `UserData` だけを取り出し、`| base64 -d -` に流せば読める文字に戻る。`|` (パイプ) は左のコマンドの出力を右のコマンドに渡す記号、`-d` は元に戻す、最後の `-` はパイプから来た文字を読め、という意味だ。'),
            node('秘密のメモかと思ったら、透けてる封筒に入ってるだけなんですね。'),
            hakase('そういうことだ。だからユーザーデータにパスワードを書いてはならん。誰でも読めるのだからな。'),
          ],
        },
        {
          type: 'exercise',
          title: '起動テンプレートを確かめる',
          objective: '起動テンプレート `webapp-lt` の中身を `aws ec2 describe-launch-template-versions` で見て、ユーザーデータで何が起動されるか確認する',
          tasks: [
            { id: 'list', title: '`aws ec2 describe-launch-templates` で `webapp-lt` を見つける', hint: '`LaunchTemplateName` と、`DefaultVersionNumber` / `LatestVersionNumber` を見ます。', command: 'aws ec2 describe-launch-templates', done: (c) => !!ranAws(c, 'ec2 describe-launch-templates') },
            {
              id: 'lt',
              title: '`webapp-lt` のユーザーデータを読む',
              hint: "`aws ec2 describe-launch-template-versions --launch-template-name webapp-lt --versions '$Default' --query 'LaunchTemplateVersions[0].LaunchTemplateData.UserData' --output text | base64 -d -`。ほかの中身も見たいときは `--query` 以降を外します。",
              command: "aws ec2 describe-launch-template-versions --launch-template-name webapp-lt --versions '$Default' --query 'LaunchTemplateVersions[0].LaunchTemplateData.UserData' --output text | base64 -d -",
              done: (c) => !!ranAws(c, 'ec2 describe-launch-template-versions', (x) => param(x, 'launch-template-name') === 'webapp-lt' || param(x, 'launch-template-id') === c.env.launchTemplates[0]?.launchTemplateId),
            },
          ],
          validate: (c) =>
            ranAws(c, 'ec2 describe-launch-template-versions', (x) => param(x, 'launch-template-name') === 'webapp-lt' || param(x, 'launch-template-id') === c.env.launchTemplates[0]?.launchTemplateId)
              ? ok(
                  node('ユーザーデータに `dnf install -y webapp` と `systemctl enable --now webapp` … `webapp` を入れて、ポート 3000 で起動しています。'),
                  hakase('`dnf` はソフトを取り寄せて入れる係、`systemctl` はサービスを起動して、再起動のあとも自動で動くようにする係だ。だから、このテンプレートから起動した EC2 は、起動するだけでアプリが動く。`SecurityGroupIds` も web-sg だ。'),
                  node('web-sg は、Lesson 15 で ALB からの 3000 番を許可してたやつですね。'),
                  hakase('うむ。`DefaultVersion` が `true` の版が既定のバージョンだ。今日は既定のバージョンのままでよい。'),
                )
              : ng(hakase("webapp-lt の中身を見るのだ。`aws ec2 describe-launch-template-versions --launch-template-name webapp-lt --versions '$Default'` だ。")),
        },
      ],
      5: {
        type: 'exercise',
        title: '今の状態を見る',
        objective: '`web-alb` の DNS 名に `curl` でアクセスし、ターゲットがないときの応答を確認する',
        tasks: [
          { id: 'dns', title: '`web-alb` の DNS 名を調べる', hint: "`aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text`。`ALB=$(...)` で変数に入れておくと、あとで `$ALB` と書くだけで済みます。", command: ALB_DNS, done: (c) => !!ranAws(c, 'elbv2 describe-load-balancers') },
          { id: 'browse', title: '`curl -i http://<DNS 名>/` で応答を見る', hint: '`curl -i http://$ALB/`。`-i` を付けると、1 行目にステータスコードが出ます。', command: (c) => `curl -i http://${albDns(c)}/`, done: (c) => albStatus(c) !== undefined },
        ],
        validate: (c) =>
          albStatus(c) === 503
            ? ok(
                node('503 Service Temporarily Unavailable です。'),
                hakase('Lesson 12 でも見たな。ターゲットグループに誰もいないときの応答だ。'),
                node('お店は開いてるのに、店員が一人もいない状態ですね。'),
                hakase('そういうことだ。Auto Scaling グループを web-tg に**アタッチ** (Lesson 08 の `attach-internet-gateway` で IGW を VPC にくっつけたのと同じ言葉だ) しておけば、起動した EC2 が自動でターゲットに登録される。'),
              )
            : ng(hakase('curl で web-alb にアクセスして、応答を確かめるのだ。DNS 名は `aws elbv2 describe-load-balancers --names web-alb` の `DNSName` だ。')),
      },
      6: [
        {
          type: 'dialogue',
          lines: [
            hakase('では Auto Scaling グループを作る。コマンドは `aws autoscaling create-auto-scaling-group` だ。オプションが多いから、さっきの表の言葉と並べて覚えるのだ。'),
            node('うへえ。全部でいくつあるんですか。'),
            hakase('今日使うのは 9 つ。名前は `--auto-scaling-group-name`、起動テンプレートは `--launch-template LaunchTemplateName=webapp-lt`。`Version` を書かなければ既定のバージョンだ。'),
            node('台数は `--desired-capacity 2`、`--min-size 2`、`--max-size 6` ですね。英語そのままだ。'),
            hakase('うむ。置き場所のサブネットは `--vpc-zone-identifier` に、サブネット ID をカンマでつないで 1 つの文字列で渡す。private-subnet-1a と 1c の 2 つだ。'),
            node('ぶいぴーしーぞーんあいでんてぃふぁいあー…。名前が長いうえに、ほかのコマンドと渡し方が違うんですね。'),
            hakase('昔の名残だ。AWS には、こういう歴史の地層がいくらでもある。ターゲットグループへのアタッチは、`--target-group-arns` に web-tg の ARN を渡す。'),
            node('ELB のヘルスチェックは？'),
            hakase('`--health-check-type ELB` でオン、猶予期間は `--health-check-grace-period 300` (秒) だ。サブネット ID は `aws ec2 describe-subnets`、ARN は `aws elbv2 describe-target-groups` で先に調べておけ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'Auto Scaling グループを作成する',
          objective: '`webapp-lt` から `webapp-asg` を作成する: サブネットは private-subnet-1a / 1c、ターゲットグループ `web-tg` にアタッチ、ELB ヘルスチェックをオン、希望 2 / 最小 2 / 最大 6',
          tasks: [
            {
              id: 'subnets',
              title: 'private-subnet-1a / 1c のサブネット ID を調べる',
              hint: "`aws ec2 describe-subnets --filters Name=tag:Name,Values=private-subnet-1a,private-subnet-1c --query 'Subnets[].[SubnetId,AvailabilityZone]' --output text`。`Values=` にはカンマで複数の値を並べられます。",
              command: "aws ec2 describe-subnets --filters Name=tag:Name,Values=private-subnet-1a,private-subnet-1c --query 'Subnets[].[SubnetId,AvailabilityZone]' --output text",
              done: (c) => !!ranAws(c, 'ec2 describe-subnets', (x) => x.output.includes(subnetNamed(c.env, 'private-subnet-1a')?.subnetId ?? '-')),
            },
            {
              id: 'tg',
              title: '`web-tg` の ARN を調べる',
              hint: "`aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text`",
              command: "aws elbv2 describe-target-groups --names web-tg --query 'TargetGroups[0].TargetGroupArn' --output text",
              done: (c) => !!ranAws(c, 'elbv2 describe-target-groups', (x) => x.output.includes(tgNamed(c.env, 'web-tg')?.targetGroupArn ?? '-')),
            },
            {
              id: 'create',
              title: '`aws autoscaling create-auto-scaling-group` で `webapp-asg` を作る',
              hint: '`--vpc-zone-identifier subnet-…,subnet-…` は、カンマの前後に空白を入れずに書きます。ARN は長いので、コピーして貼り付けます。',
              command: (c) =>
                `aws autoscaling create-auto-scaling-group --auto-scaling-group-name webapp-asg --launch-template LaunchTemplateName=webapp-lt --min-size 2 --max-size 6 --desired-capacity 2 --vpc-zone-identifier ${['private-subnet-1a', 'private-subnet-1c'].map((s) => subnetNamed(c.env, s)?.subnetId).join(',')} --target-group-arns ${tgNamed(c.env, 'web-tg')?.targetGroupArn} --health-check-type ELB --health-check-grace-period 300`,
              done: (c) => !!asgOf(c.env),
            },
          ],
          validate: (c) => {
            const g = asgOf(c.env);
            if (!g) return ng(hakase('webapp-asg が見当たらん。`aws autoscaling create-auto-scaling-group` で、`--auto-scaling-group-name webapp-asg` と `--launch-template LaunchTemplateName=webapp-lt` を指定するのだ。'));
            const priv = ['private-subnet-1a', 'private-subnet-1c'].map((x) => subnetNamed(c.env, x)?.subnetId);
            if (!priv.every((s) => s && g.subnetIds.includes(s)) || g.subnetIds.length !== 2)
              return ng(hakase('サブネットは private-subnet-1a と 1c の 2 つだ。`aws autoscaling update-auto-scaling-group --auto-scaling-group-name webapp-asg --vpc-zone-identifier <1a の ID>,<1c の ID>` で直せる。2 つの AZ に分けておけば、片方の AZ が止まっても残る。'));
            if (!g.targetGroupArns.includes(c.env.targetGroups[0]?.targetGroupArn)) return ng(hakase('web-tg にアタッチされていない。これでは ALB から届かんぞ。`aws autoscaling attach-load-balancer-target-groups --auto-scaling-group-name webapp-asg --target-group-arns <web-tg の ARN>` でアタッチするのだ。'));
            if (g.healthCheckType !== 'ELB') return ng(hakase('ELB のヘルスチェックがオフだ。アプリが止まっても、EC2 自体が動いていれば入れ替わらんぞ。`aws autoscaling update-auto-scaling-group` に `--health-check-type ELB --health-check-grace-period 300` を付けて直すのだ。'));
            if (g.minSize !== 2 || g.desiredCapacity !== 2 || g.maxSize !== 6) return ng(hakase('台数は 希望 2 / 最小 2 / 最大 6 だ。`aws autoscaling update-auto-scaling-group` の `--desired-capacity`・`--min-size`・`--max-size` で直せるぞ。'));
            return ok(
              hakase('よし。何も表示されなかったが、それで成功だ。このコマンドは、うまくいくと何も返さん。`aws autoscaling describe-scaling-activities` を見てみろ、もう 2 台起動し始めておる。'),
              node('あくてぃびてぃ？'),
              hakase('Auto Scaling が「いつ・何を・なぜ」したかの作業日誌だ。1 台ずつの状態は `describe-auto-scaling-groups` の `Instances` に出る。`LifecycleState` は、起動中は **Pending**、起動が終わると **InService** (稼働中) になり、ターゲットグループにも登録される。'),
              node('ペンディングは「保留中」、インサービスは「営業中」ってことですね。'),
            );
          },
        },
      ],
      7: {
        type: 'exercise',
        title: 'サイトが戻ったことを確かめる',
        objective: '2 台が InService になるまで待ち、`curl` で `web-alb` から 200 が返ることを確認する',
        tasks: [
          {
            id: 'inservice',
            title: '2 台が InService になるまで待つ',
            hint: '`aws autoscaling wait group-in-service --auto-scaling-group-names webapp-asg` は、InService の台数が最小 (`MinSize`) 以上になるまで待ちます。`&&` でつなぐと、待ち終わってから `describe-auto-scaling-groups` で `LifecycleState` を表示できます。',
            command: `aws autoscaling wait group-in-service --auto-scaling-group-names webapp-asg && ${ASG_INSTANCES}`,
            done: (c) => inService(c.env) >= 2,
          },
          { id: 'browse', title: '`curl` で web-alb → **200**', hint: '2 台が InService になってから、同じ URL にもう一度 `curl -i` します。', command: (c) => `curl -i http://${albDns(c)}/`, done: (c) => albStatus(c) === 200 },
        ],
        validate: (c) =>
          inService(c.env) >= 2 && albStatus(c) === 200
            ? ok(
                node('200 OK！ 2 台が、それぞれ違う AZ で動いてます。'),
                hakase('Auto Scaling は、選んだサブネットの AZ に均等に配置する。ターゲットグループへの登録も自動だ。'),
                node('僕、ターゲットを 1 台も手で登録してないのに復旧しました。'),
                hakase('では意地悪をしよう。次は 1 台を**終了**する。Lesson 10 の「停止」と違って、終了 (`aws ec2 terminate-instances`) はインスタンスを削除することだ。二度と起動できん。'),
              )
            : ng(hakase('2 台が InService になってから、もう一度 curl で確かめるのだ。`aws autoscaling wait group-in-service --auto-scaling-group-names webapp-asg` で待てる。')),
      },
      8: {
        type: 'exercise',
        title: '1 台壊してみる',
        objective: '`webapp-asg` のインスタンスを 1 台 `aws ec2 terminate-instances` で終了し、Auto Scaling が新しいインスタンスで置き換えることを確認する',
        tasks: [
          {
            id: 'kill',
            title: '`webapp-asg` の 1 台を `aws ec2 terminate-instances` で終了する',
            hint: "インスタンス ID は `aws autoscaling describe-auto-scaling-groups --auto-scaling-group-names webapp-asg --query 'AutoScalingGroups[0].Instances[0].InstanceId' --output text` で 1 つだけ取り出せます。`--instance-ids` には 1 台だけを渡します。",
            command: (c) => `aws ec2 terminate-instances --instance-ids ${asgOf(c.env)?.instances.find((r) => r.lifecycleState === 'InService')?.instanceId ?? 'i-xxxxxxxxxxxxxxxxx'}`,
            done: (c) => !!asgOf(c.env)?.activities.some((a) => a.cause.includes('EC2 health check')),
          },
          {
            id: 'back',
            title: '2 台 (InService) に戻るのを待つ',
            hint: '`aws autoscaling wait group-in-service --auto-scaling-group-names webapp-asg`。新しい 1 台が InService になると戻ってきます。',
            command: `aws autoscaling wait group-in-service --auto-scaling-group-names webapp-asg && ${ASG_INSTANCES}`,
            done: (c) => !!asgOf(c.env)?.activities.some((a) => a.cause.includes('EC2 health check')) && inService(c.env) >= 2,
          },
          {
            id: 'activity',
            title: '`aws autoscaling describe-scaling-activities` で何が起きたかを読む',
            hint: '新しい順に並びます。`Description` (何をしたか) と `Cause` (なぜしたか) を読みます。',
            command: 'aws autoscaling describe-scaling-activities --auto-scaling-group-name webapp-asg',
            done: (c) => !!ranAws(c, 'autoscaling describe-scaling-activities', (x) => x.output.includes('EC2 health check')),
          },
        ],
        validate: (c) => {
          const g = asgOf(c.env);
          if (!g?.activities.some((a) => a.cause.includes('EC2 health check'))) return ng(hakase('まだインスタンスを終了していないようだ。`aws ec2 terminate-instances --instance-ids <webapp-asg の 1 台の ID>` だ。ID は `describe-auto-scaling-groups` の `Instances` にある。'));
          if (inService(c.env) < 2 || liveInstances(g).length !== 2) return ng(hakase('入れ替えの途中だ。`aws autoscaling wait group-in-service --auto-scaling-group-names webapp-asg` で、新しいインスタンスが InService になるまで待つのだ。'));
          return ok(
            node('終了した直後に「Launching a new EC2 instance」… 勝手に 1 台増えて 2 台に戻りました！'),
            hakase('これが**自己修復**だ。希望するキャパシティ 2 を保とうとしておる。夜中に 1 台壊れても、朝には元どおりだ。'),
            node('これで夜中の 3 時に起こされずに済みますね。'),
            hakase('台数の心配はな。Auto Scaling に直せんものは、相変わらず君の電話が鳴る。'),
          );
        },
      },
    },
  },

  'asg-target-tracking': {
    files: () => ({ 'config.json': TT_CONFIG }),
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('台数を増やすのと減らすのに、名前はあるんですか？'),
          hakase('増やすのが **スケールアウト**、減らすのが **スケールイン** だ。1 台を大きくするのは**スケールアップ**といって、別物だ。'),
          node('Lesson 25 で DB のインスタンスクラスを上げたのは、スケールアップのほうですね。'),
          hakase('そうだ。あれは 1 台を太らせた。今日は頭数を増やす。'),
          node('何台に増やすかは、どうやって決めるんです？'),
          hakase('おおよそ「今の台数 × 今の CPU ÷ 目標」だ。2 台で CPU 100% なら、2 × 100 ÷ 50 = 4 台。'),
          node('仕事の量が同じなら、人数を倍にすれば一人あたりは半分になる、と。'),
          hakase('うむ。そして「超えた」「下回った」の判定には、Lesson 24 でやった **CloudWatch アラーム** を使う。ターゲット追跡は、そのアラームを自動で作ってくれる。'),
          node('自分でアラームを作らなくていいんですね。楽だ。'),
          hakase('作るのは、台数を変える決まり、**スケーリングポリシー** だ。`aws autoscaling put-scaling-policy` に `--policy-type TargetTrackingScaling` を付け、目標は `--target-tracking-configuration` に JSON で渡す。'),
          node('JSON に何を書くんです？'),
          hakase('ホームに `config.json` を置いておいた。`PredefinedMetricType` の `ASGAverageCPUUtilization` が「グループの平均 CPU 使用率」、`TargetValue` の `50` が目標値だ。`file://config.json` と書けば、ファイルの中身をそのまま渡せる。'),
          node('ポリシーには、ほかの種類もあるんですか？'),
          hakase('「CPU が 70% を超えたら 2 台足す」のように段階を自分で決める、**ステップスケーリング** (`StepScaling`) がある。まずは計算を任せられるターゲット追跡から覚えればよい。'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          hakase('動きを確かめるには、お客さんの代わりにアクセスを送り込む道具が要る。負荷テストの道具、`hey` だ。'),
          node('へい？ 返事ですか。'),
          hakase('返事ではない。HTTP のリクエストを大量に送る、実在の小さな道具だ。`-c` が同時に送る数 (並列数)、`-q` が 1 並列あたりの 1 秒の回数、`-z` が続ける時間だ。'),
          node('じゃあ 1 秒あたりのリクエスト数は、`-c` × `-q` ですか。'),
          hakase('そうだ。単位は **req/s**、1 秒あたりのリクエスト数だ。`hey -z 10m -c 10 -q 10 http://$ALB/` なら 10 × 10 = 100 req/s を 10 分。毎秒 100 回ページを開かれる。'),
          node('1000 req/s なら 10 倍、テレビの日ですね。本番でテレビ放送を再現するわけにはいかないですもんね。'),
          hakase('本物の hey は、終わるまでターミナルを占領する。この学習環境の hey は負荷をシミュレーターに任せてすぐ戻るから、そのまま `aws` で様子を見られる。止めるときは `pkill hey` だ。'),
          node('様子は、どうやって見るんですか？'),
          hakase('台数は `describe-auto-scaling-groups`、CPU は Lesson 24 の `aws cloudwatch get-metric-statistics` だ。グループ全体の平均 CPU は、ディメンションを `AutoScalingGroupName` にすれば出る。レッスンパネルの「負荷テスト」タブにも、シミュレーターのグラフがある。'),
          node('数字でもグラフでも見られるんですね。'),
          hakase('それと、Lesson 30 の起動テンプレート `webapp-lt` では、詳細モニタリングがオンになっておった。CPU の数字が 1 分ごとに届くから、判断が速い。'),
          node('Lesson 24 でやったメトリクスの「期間」が短い、ってことですね。'),
          hakase('うむ。では `webapp-asg` にポリシーを付けるところからだ。テレビに映る前に、君の手順書が炎上せんとよいがな。'),
        ],
      },
      3: {
        type: 'exercise',
        title: 'ターゲット追跡ポリシーを作る',
        objective: '`webapp-asg` に、平均 CPU 使用率を **50** に保つターゲット追跡スケーリングポリシー `cpu50` を `aws autoscaling put-scaling-policy` で作成する',
        tasks: [
          {
            id: 'policy',
            title: '`webapp-asg` にポリシー `cpu50` を作る',
            hint: '`--auto-scaling-group-name webapp-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration file://config.json`。中身は `cat config.json` で見られます。',
            command: 'aws autoscaling put-scaling-policy --auto-scaling-group-name webapp-asg --policy-name cpu50 --policy-type TargetTrackingScaling --target-tracking-configuration file://config.json',
            done: (c) => !!asgOf(c.env)?.policies.length,
          },
        ],
        validate: (c) => {
          const p = asgOf(c.env)?.policies[0];
          if (!p) return ng(hakase('まだポリシーがない。`aws autoscaling put-scaling-policy` に `--policy-type TargetTrackingScaling` と `--target-tracking-configuration file://config.json` を付けて打つのだ。'));
          if (p.metric !== 'ASGAverageCPUUtilization' || p.targetValue !== 50)
            return ng(hakase('「平均 CPU 使用率」を 50 に保つポリシーにするのだ。`PredefinedMetricType` は `ASGAverageCPUUtilization`、`TargetValue` は 50。同じ `--policy-name` でもう一度 `put-scaling-policy` を打てば上書きできる。'));
          return ok(
            hakase('準備完了だ。返ってきた `Alarms` に、自動で作られたアラームの名前が 2 つ並んでおるだろう。まずは普段どおりの負荷から試そう。'),
            node('エアコンの設定温度を 50 度にした、ってことですね。'),
            hakase('部屋が 50 度なら、君は今ごろ干物だ。CPU の話だぞ。'),
          );
        },
      },
      4: {
        type: 'exercise',
        title: '100 req/s をかける',
        objective: '`hey` で `web-alb` に **100 req/s** をかけ、台数と平均 CPU を観察する',
        tasks: [
          { id: 'dns', title: '`web-alb` の DNS 名を変数 `ALB` に入れる', hint: "`ALB=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text)`", command: ALB_DNS, done: (c) => !!ranAws(c, 'elbv2 describe-load-balancers') },
          { id: 'load', title: '`hey` で **100 req/s** をかける', hint: '`hey -z 10m -c 10 -q 10 http://$ALB/` で、10 並列 × 10 回/秒 = 100 req/s を 10 分かけます。', command: (c) => `hey -z 10m -c 10 -q 10 http://${albDns(c)}/`, done: (c) => load(c.env) === 100 },
          { id: 'asg', title: '`describe-auto-scaling-groups` で台数を見る', hint: `\`${ASG_INSTANCES}\``, command: ASG_INSTANCES, done: (c) => !!ranAws(c, 'autoscaling describe-auto-scaling-groups', (x) => x.at >= loadSetAt(c.env)) },
          {
            id: 'cpu',
            title: '`get-metric-statistics` でグループの平均 CPU を見る',
            hint: '`NOW=$(date +%s)` で今の時刻 (秒) を変数に入れ、`--start-time $((NOW - 600)) --end-time $NOW` で直近 10 分を、`--period 60` で 1 分ごとに出します。ディメンションは `Name=AutoScalingGroupName,Value=webapp-asg` です。',
            command: ASG_CPU,
            done: (c) => ranCpu(c, loadSetAt(c.env)),
          },
        ],
        validate: (c) =>
          load(c.env) === 100 && inService(c.env) === 2
            ? ok(
                node(`2 台のままで、CPU は ${Math.round(cpuNow(c.env) ?? 0)}% くらいです。`),
                hakase('目標の 50% より十分低いから、増やす必要はない。かといって最小が 2 だから、これ以上は減らん。'),
                node('暇な時間でも、お店には最低 2 人いる、みたいな感じですね。'),
              )
            : ng(hakase('hey で 100 req/s をかけるのだ。`hey -z 10m -c 10 -q 10 http://$ALB/` だ。`$ALB` が空なら、先に DNS 名を変数に入れる。')),
      },
      5: {
        type: 'exercise',
        title: '10 倍の負荷をかける',
        objective: '`hey` で **1000 req/s** に上げ、CPU が上がって台数が増え、CPU が目標付近に下がるまで観察する',
        tasks: [
          { id: 'load', title: '`hey` で **1000 req/s** をかける', hint: '`hey -z 10m -c 50 -q 20 http://$ALB/` で、50 並列 × 20 回/秒 = 1000 req/s。打ち直すと、前の負荷と入れ替わります。', command: (c) => `hey -z 10m -c 50 -q 20 http://${albDns(c)}/`, done: (c) => load(c.env) === 1000 },
          {
            id: 'out',
            title: 'InService が 4 台になり、平均 CPU が 50% 以下に戻る',
            hint: `CPU が 20 秒ほど目標を超え続けるとスケールアウトします。\`sleep 60\` で 1 分待ってから \`${ASG_INSTANCES}\` で台数を見ます (待たずに何度か打っても構いません)。`,
            command: `sleep 60; ${ASG_INSTANCES}`,
            done: (c) => load(c.env) === 1000 && inService(c.env) >= 4 && (cpuNow(c.env) ?? 100) < 55,
          },
          { id: 'cpu', title: '`get-metric-statistics` で平均 CPU の変化を見る', hint: `\`${ASG_CPU}\`。1 分ごとの平均 CPU が、上がってから下がっています。`, command: ASG_CPU, done: (c) => ranCpu(c, loadSetAt(c.env)) },
        ],
        validate: (c) => {
          if (load(c.env) !== 1000) return ng(hakase('1000 req/s にするのだ。`hey -z 10m -c 50 -q 20 http://$ALB/` だ。'));
          if (inService(c.env) < 4) return ng(hakase('まだ台数が増えきっていない。CPU が 20 秒ほど目標を超え続けると、スケールアウトが始まる。`describe-auto-scaling-groups` で `LifecycleState` を見ながら待つのだ。'));
          return ok(
            node(`CPU が 80% を超えて、4 台に増えたら ${Math.round(cpuNow(c.env) ?? 0)}% まで下がりました！`),
            hakase('たとえば 2 台で 82% なら、2 × 82 ÷ 50 ≒ 3.3、切り上げて 4 台だ。「今の台数 × 今の CPU ÷ 目標」で必要な台数を計算して、一気に増やしたのだ。'),
            node('1 台ずつじゃなくて、必要な数をまとめて足すんですね。'),
            hakase('そうだ。テレビの前のお客さんは、1 台ずつ増えるのを待ってはくれん。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: 'アクティビティ履歴を読む',
        objective: '`aws autoscaling describe-scaling-activities` で、希望するキャパシティが変わった理由を確認する',
        tasks: [
          {
            id: 'activity',
            title: '`aws autoscaling describe-scaling-activities` を読む',
            hint: '新しい順に並びます。キャパシティが変わった理由は `Cause` に書かれています。',
            command: 'aws autoscaling describe-scaling-activities --auto-scaling-group-name webapp-asg',
            done: (c) => !!ranAws(c, 'autoscaling describe-scaling-activities', (x) => x.output.includes('triggered policy')),
          },
        ],
        validate: (c) =>
          ranAws(c, 'autoscaling describe-scaling-activities', (x) => x.output.includes('triggered policy'))
            ? ok(
                node('「TargetTracking-webapp-asg-AlarmHigh … triggered policy cpu50 changing the desired capacity from 2 to 4」とあります。'),
                hakase('ターゲット追跡が自動で作った CloudWatch アラームだ。目標を上回ったら鳴る **AlarmHigh** と、下回ったら鳴る **AlarmLow**。これをきっかけに、希望するキャパシティを変えるのだ。'),
                node('「なぜ 4 台になったのか」が、ちゃんと作業日誌に残ってるんですね。'),
                hakase('何がいつ起きたかは、いつでもここで追える。請求書を見た上司に「なぜ増えた」と詰められたときにもな。'),
              )
            : ng(hakase('アクティビティを読むのだ。`aws autoscaling describe-scaling-activities --auto-scaling-group-name webapp-asg` だ。スケールアウトの前に打ったものには、まだ理由が載っておらんぞ。')),
      },
      7: {
        type: 'exercise',
        title: '負荷が引いたら',
        objective: '`hey` を **100 req/s** に戻し、台数が最小の 2 台まで減るのを確認する',
        tasks: [
          { id: 'load', title: '`hey` で **100 req/s** に戻す', hint: '`hey -z 10m -c 10 -q 10 http://$ALB/`。`pkill hey` で止めるのではなく、100 req/s をかけ直します。', command: (c) => `hey -z 10m -c 10 -q 10 http://${albDns(c)}/`, done: (c) => load(c.env) === 100 },
          {
            id: 'in',
            title: '希望するキャパシティが 2 に戻り、2 台になる',
            hint: `スケールインは慎重に行われます (約 1 分)。\`sleep 90\` で待ってから \`${ASG_INSTANCES}\` で見ます。減らされる 2 台は、終了するまで \`Terminating\` と表示されます。`,
            command: `sleep 90; ${ASG_INSTANCES}`,
            done: (c) => load(c.env) === 100 && asgOf(c.env)?.desiredCapacity === 2 && liveInstances(asgOf(c.env)!).length === 2,
          },
        ],
        validate: (c) =>
          load(c.env) === 100 && asgOf(c.env)?.desiredCapacity === 2 && liveInstances(asgOf(c.env)!).length === 2
            ? ok(
                hakase('スケールアウトは素早く、スケールインはゆっくり。増やし遅れるとお客様が困るが、減らし遅れても少しお金がかかるだけだからだ。'),
                node('放送が終わったら、ちゃんと 2 台に戻りました。「たぶん」戻し忘れる僕の代わりに、戻してくれるんですね。'),
                hakase('そうだ。そして最小の 2 台より減ることはない。君の「たぶん」より、よほど信用できる。'),
              )
            : ng(hakase('100 req/s に戻して、台数が減るのを待つのだ。スケールインは慎重だから、1 分ほどかかる。`sleep 60` のあとで `describe-auto-scaling-groups` を見てみろ。')),
      },
    },
  },
};

export default patches;
