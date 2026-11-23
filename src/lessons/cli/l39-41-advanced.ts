import type { CommandRecord } from '../../console/store';
import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { principalId } from '../../cli/aws/services/sso-admin';
import { costLines, formatUsd, totalOf } from '../../sim/cost';
import { byName } from '../../sim/env';
import { evaluateScp, portalAccess } from '../../sim/organizations';
import { ORG_ACCOUNTS, ORG_OUS } from '../../sim/scenarios';
import type { AwsEnv } from '../../sim/types';
import { flowPath } from '../../sim/vpc';
import { awsCalls, param, ranAws } from './helpers';
import type { CliPatch, CliPatches } from './types';

/* ---- 共通 ---- */

const SSO_SESSION = (user: string) => `[sso-session ${user}]\nsso_start_url = https://webapp.awsapps.com/start\nsso_region = ap-northeast-1\nsso_registration_scopes = sso:account:access\n`;
const SSO_PROFILE = (name: string, session: string, account: string, role: string) => `[profile ${name}]\nsso_session = ${session}\nsso_account_id = ${account}\nsso_role_name = ${role}\nregion = ap-northeast-1\n`;
const DEFAULT_CONFIG = '[default]\nregion = ap-northeast-1\noutput = json\n';

/** SSO のプロファイルで打って、許可セットか SCP に拒否された aws (エラーの User: arn:aws:sts::<account>:assumed-role/…/<user> で見分ける) */
const deniedAs = (c: TaskContext, command: string, code: string, account: string, user: string, more = ''): CommandRecord | undefined =>
  [...awsCalls(c)].reverse().find((x) => x.command === command && !x.ok && x.errorCode === code && x.output.includes(`arn:aws:sts::${account}:assumed-role/AWSReservedSSO_${more}`) && x.output.includes(`/${user} is not authorized`));

/* ---------------- 39 コスト ---------------- */

const total = (env: AwsEnv) => totalOf(costLines(env));
const budget = (env: AwsEnv) => env.budgets[0]?.limitUsd ?? 850;
const db = (env: AwsEnv, id: string) => env.dbInstances.find((d) => d.dbInstanceIdentifier === id);
const prodSafe = (env: AwsEnv) => !!db(env, 'webapp-db')?.multiAZ && (db(env, 'webapp-db')?.backupRetentionPeriod ?? 0) >= 7 && ['web-1', 'web-2'].every((n) => byName(env.instances, n)?.state === 'running');
const auditKept = (env: AwsEnv) => {
  const g = env.logGroups.find((x) => x.logGroupName === '/aws/cloudtrail/management-events');
  return !!g && (g.retentionInDays === undefined || g.retentionInDays >= 365);
};
const flowsWork = (env: AwsEnv) => !costLines(env).some((l) => l.broken);
const devSingleAz = (env: AwsEnv) => db(env, 'dev-db')?.multiAZ === false;
const devRetentionDays = (env: AwsEnv) => db(env, 'dev-db')?.backupRetentionPeriod ?? 99;
const devRetention = (env: AwsEnv) => devRetentionDays(env) >= 1 && devRetentionDays(env) <= 7;
const devManualSnaps = (env: AwsEnv) => env.dbSnapshots.filter((s) => s.dbInstanceIdentifier === 'dev-db').sort((a, b) => a.snapshotCreateTime.localeCompare(b.snapshotCreateTime));
const devSnapshots = (env: AwsEnv) => devManualSnaps(env).length <= 1;
const batchFlow = (env: AwsEnv) => env.dataFlows.find((f) => f.destination === 's3');
const viaEndpoint = (env: AwsEnv) => !!batchFlow(env) && flowPath(env, batchFlow(env)!.subnetId, 's3').via === 'endpoint';
const devVpcId = (env: AwsEnv) => byName(env.vpcs, 'dev-vpc')?.vpcId ?? 'vpc-xxxxxxxx';
const devNats = (env: AwsEnv) => env.natGateways.filter((n) => n.vpcId === devVpcId(env) && n.state !== 'deleted' && n.state !== 'deleting');
const debugShort = (env: AwsEnv) => (env.logGroups.find((g) => g.logGroupName === '/webapp/dev/debug')?.retentionInDays ?? Infinity) <= 14;
const AZS = ['1a', '1c', '1d'];
const rtId = (env: AwsEnv, az: string) => byName(env.routeTables, `dev-private-rt-${az}`)?.routeTableId ?? 'rtb-xxxxxxxx';
const natId = (env: AwsEnv, az: string) => env.natGateways.find((n) => n.state !== 'deleted' && n.tags.some((t) => t.key === 'Name' && t.value === `dev-nat-${az}`))?.natGatewayId ?? 'nat-xxxxxxxx';
/** 開発のプライベートのルートテーブル 3 つの 0.0.0.0/0 が、動いている同じ NAT ゲートウェイを向いている */
const oneNat = (env: AwsEnv) => {
  const targets = new Set(AZS.map((az) => byName(env.routeTables, `dev-private-rt-${az}`)?.routes.find((r) => r.destinationCidrBlock === '0.0.0.0/0')?.natGatewayId));
  const [only] = targets;
  return targets.size === 1 && devNats(env).some((n) => n.natGatewayId === only);
};

/** 今月 1 日から来月 1 日まで (Cost Explorer の --time-period) */
const thisMonth = () => {
  const d = new Date(Date.now());
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return `Start=${day(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))},End=${day(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))}`;
};
const ACCOUNT = '$(aws sts get-caller-identity --query Account --output text)';
const CE = (groupBy: string, query: string) => `aws ce get-cost-and-usage --time-period ${thisMonth()} --granularity MONTHLY --metrics UnblendedCost --group-by ${groupBy} --query '${query}' --output text`;

/** describe-budgets の出力に出ていた予測 (JSON / --output text / --query で金額だけ) */
function shownForecast(out: string): number | undefined {
  const m = /"ForecastedSpend":\s*\{\s*"Amount":\s*"([\d.]+)"/.exec(out) ?? /FORECASTEDSPEND\s+([\d.]+)/.exec(out) ?? /^\s*"?([\d.]+)"?\s*$/.exec(out);
  return m ? Number(m[1]) : undefined;
}
const budgetShown = (c: TaskContext) => !!ranAws(c, 'budgets describe-budgets', (x) => (shownForecast(x.output) ?? Infinity) <= budget(c.env));

function guards(env: AwsEnv) {
  if (!prodSafe(env)) return ng(hakase('本番に手を出してはいかん。`webapp-db` はマルチ AZ (`--multi-az`) でバックアップ保持期間 7 日以上に、web-1 / web-2 は `running` に戻すのだ。本番のコストは「止まらないため」の費用だ。そこを削るのは、保険料をケチって事故を待つようなものだぞ。'));
  if (!auditKept(env)) return ng(hakase('監査ログ (CloudTrail) の保持期間を短くしてはいかん。`aws logs delete-retention-policy --log-group-name /aws/cloudtrail/management-events` で「失効しない」に戻すのだ (少なくとも 365 日以上)。証拠を捨てたら犯人みたいだと、君が自分で言ったではないか。'));
  if (!flowsWork(env))
    return ng(
      hakase('開発環境のサーバーが外に出られなくなっておる。`aws ec2 describe-route-tables` で、`State` が `blackhole` のルートを探すのだ。消した NAT ゲートウェイを指したままの 0.0.0.0/0 だ。'),
      hakase('`aws ec2 replace-route --nat-gateway-id` で、動いている NAT ゲートウェイに向け直す。1 つも残っていなければ、`aws ec2 create-nat-gateway` で作り直すのだ。'),
    );
  return undefined;
}

const lesson39: CliPatch = {
  steps: {
    0: {
      type: 'dialogue',
      lines: [
        node('博士、経理から電話です。今月の AWS の請求が、予算の $850 を大きく超えそうだって…'),
        hakase('経理の電話は、障害の電話より怖いぞ。障害は直せば終わるが、請求書は取り消せん。'),
        node('と、とりあえず全部止めますか？'),
        hakase('全部止めればコストはゼロだ。ついでに売上も、君の給料もゼロになるがな。'),
        node('それは困ります。まだ博士より給料をもらってないのに。'),
        hakase('…今、さらっと野望を漏らしたな。いいか、今日は **コスト**・**可用性**・**セキュリティ** の天秤の話だ。可用性とは止まらずに使い続けられること、セキュリティとは盗まれず・壊されず・後から調べられることだ。'),
        node('安くすると、そのどっちかが削れるんですか？'),
        hakase('たいていはな。だから「削ってよいところだけ」を削る。請求も CLI で見られる。登録した **予算** と月末の **予測** は `aws budgets`、何にいくらかかっておるかは **Cost Explorer** の `aws ce` だ。'),
        node('こすとえくすぷろーらー？ コストの探検家ですか？'),
        hakase('名前のとおり、コストをサービス別・タグ別に分けて見る道具だ。金額は割引なしの定価、つまり **オンデマンド料金** での概算だ。'),
        node('本物の請求書と同じ金額が出るんですか？'),
        hakase('本物の `get-cost-and-usage` は、実際に使った分を返す。このシミュレーターには過去の請求がないから、「今の構成のまま 1 か月動いたらいくらか」を見積もって返す。応答の `"Estimated": true` が、見積もりだという印だ。'),
      ],
    },
    2: {
      type: 'dialogue',
      lines: [
        node('ALB はどうですか？'),
        hakase('動いている時間の料金に加えて、**LCU** で課金される。'),
        node('えるしーゆー？'),
        hakase('Load Balancer Capacity Unit、ALB が「どれだけ働いたか」の単位だ。新しい接続の数、同時接続の数、処理したデータ量、ルールの評価回数のうち、いちばん大きいものを 1 時間ごとに数える。Cost Explorer では `Amazon Elastic Load Balancing` に入ってくるぞ。'),
        node('タクシーの「基本料金 + 走った距離」みたいなものですね。'),
        hakase('うむ。次は **NAT ゲートウェイ** だ。今日が初登場だな。Lesson 06 で、Private subnet はインターネットに直接出られんと言ったろう。'),
        node('Route table に `0.0.0.0/0 → Internet gateway` がないから、でしたよね。'),
        hakase('そうだ。だが Private のサーバーも、パッケージの更新や外部 API の呼び出しで外に出たいことがある。そのとき代わりに外へ出してくれる出口が、NAT ゲートウェイだ。'),
        node('なっと？ 納豆？'),
        hakase('ネバネバしとらん。**NAT (Network Address Translation)**、アドレス変換だ。Public subnet に置き、Private のサーバーの送信元アドレスを自分のパブリック IP に付け替えて外に出し、返ってきた応答を中へ戻す。外から中へ入ろうとする通信は通さん。'),
      ],
    },
    3: {
      type: 'dialogue',
      lines: [
        node('会社の代表電話ですね。外にかけるときは代表番号で発信して、外から社員の内線には直接かけられない。'),
        hakase('うまいことを言う。ただしこの代表電話、置いておくだけの時間料金と、通したデータ 1 GB ごとの処理料金がかかる。しかも 1 つの AZ の中にあるから、本番では AZ ごとに置く。'),
        node('1 つにまとめれば安いのに。'),
        hakase('まとめると、その AZ が落ちたときに全部の AZ のサーバーが外に出られなくなる。そのうえ別の AZ の NAT まで運ぶ分、**AZ 間のデータ転送料金** がかかる。AZ をまたぐ通信と、インターネットへの送信は有料なのだ。'),
        node('その料金は、Cost Explorer だとどこに出るんですか？'),
        hakase('`EC2 - Other` という箱だ。NAT ゲートウェイもデータ転送も、そこにまとめて入る。名前からは中身が分からん福袋のような箱だから、タグの `Name` で分けて中を見るのだ。'),
        node('じゃあ Private のサーバーが S3 から大量にデータを取るときも、NAT の通行料を払ってるんですか？'),
        hakase('何もしなければな。そこで **ゲートウェイエンドポイント** だ。'),
        node('げーとうぇいえんどぽいんと？'),
        hakase('VPC から S3 (と DynamoDB) へ直通する裏口だ。`aws ec2 create-vpc-endpoint` で、サービス名 `com.amazonaws.ap-northeast-1.s3` と Route table を指定して作ると、その Route table に「S3 行きはこの裏口へ」というルートが足される。NAT もインターネットも通らず、しかも **無料** だ。'),
        node('無料で、インターネットにも出ない。コストとセキュリティの両方に効くじゃないですか。'),
      ],
    },
    4: {
      type: 'dialogue',
      lines: [
        hakase('何も失わん珍しいレバーだ。こういうのは真っ先に引く。最後はログだ。'),
        node('ログなんて、残しておくだけなら安そうですけど。'),
        hakase('CloudWatch Logs は、取り込んだ量と保存している量の両方で課金される。Lesson 25 で見たロググループには **保持期間** があって、既定は「失効しない」、つまり永遠に保存だ。解約できんサブスクのようなものだな。'),
        node('`aws logs describe-log-groups` の応答に `retentionInDays` が無いロググループが、それですね。'),
        hakase('ただし **監査ログ** は別だ。Lesson 26 で、CloudTrail の記録からセキュリティグループのルールを消した操作を突き止めたろう。あの記録は `/aws/cloudtrail/management-events` にも送っておる。調査や監査では 1 年以上前まで遡ることがあるから、これは削らん。削るのは開発のデバッグログのほうだ。'),
        node('捨てていいゴミと、捨てちゃいけない証拠を分けるんですね。証拠を捨てたら、こっちが犯人みたいですし。'),
      ],
    },
    6: {
      type: 'exercise',
      title: 'どこにお金がかかっているか調べる',
      objective: '`aws budgets describe-budgets` で予算に対する予測を、`aws ce get-cost-and-usage` で環境別・サービス別のコストと内訳を確認する',
      tasks: [
        {
          id: 'budget',
          title: '`aws budgets describe-budgets` で予算と予測を見る',
          hint: '`--account-id` にはアカウント ID を入れます。`aws sts get-caller-identity --query Account --output text` で出せるので、`$(...)` でそのまま埋め込めます。`BudgetLimit` が予算、`CalculatedSpend` の `ForecastedSpend` が月末の予測です。',
          command: `aws budgets describe-budgets --account-id ${ACCOUNT}`,
          done: (c) => !!ranAws(c, 'budgets describe-budgets'),
        },
        {
          id: 'env',
          title: '環境別 (タグ `Environment`) のコストを見る',
          hint: "`aws ce get-cost-and-usage --time-period Start=今月1日,End=来月1日 --granularity MONTHLY --metrics UnblendedCost --group-by Type=TAG,Key=Environment`。日付は `2026-11-01` の形で、End の日は含みません。`--query 'ResultsByTime[0].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]' --output text` で見やすくなります。このシミュレーターでは、Environment タグの無いリソースは名前に dev が入っているかで振り分けます。",
          command: () => CE('Type=TAG,Key=Environment', 'ResultsByTime[0].Groups[].[Keys[0],Metrics.UnblendedCost.Amount]'),
          done: (c) => !!ranAws(c, 'ce get-cost-and-usage', (x) => param(x, 'group-by').includes('Environment')),
        },
        {
          id: 'service',
          title: 'サービス別のコストと、その内訳 (タグ `Name`) を見る',
          hint: "`--group-by` は 2 つまで並べられます。`--group-by Type=DIMENSION,Key=SERVICE Type=TAG,Key=Name` で、サービスごと・リソースごとに分かれます。`--query 'ResultsByTime[0].Groups[].[Keys[0],Keys[1],Metrics.UnblendedCost.Amount]' --output text` が見やすいでしょう。",
          command: () => CE('Type=DIMENSION,Key=SERVICE Type=TAG,Key=Name', 'ResultsByTime[0].Groups[].[Keys[0],Keys[1],Metrics.UnblendedCost.Amount]'),
          done: (c) => !!ranAws(c, 'ce get-cost-and-usage', (x) => param(x, 'group-by').includes('SERVICE')),
        },
      ],
      validate: (c) =>
        ranAws(c, 'budgets describe-budgets') && ranAws(c, 'ce get-cost-and-usage', (x) => param(x, 'group-by').includes('Environment')) && ranAws(c, 'ce get-cost-and-usage', (x) => param(x, 'group-by').includes('SERVICE'))
          ? ok(
              node(`予測は ${formatUsd(total(c.env))}… しかも \`Environment$dev\` のほうが、\`Environment$prod\` の何倍もかかっています！`),
              node('いちばん高い RDS の中身は `dev-db`。`EC2 - Other` には `dev-nat-1a`・`1c`・`1d` が並んで、CloudWatch は `/webapp/dev/debug` が大半です…'),
              hakase('開発環境を「本番と同じ作りで、しかも大きめに」作ってしまったのだな。`aws rds describe-db-instances` で見れば分かるが、開発 DB なぞ本番より大きいクラスで、そのうえ `MultiAZ` が `true` だ。'),
              node('誰がこんな作りに…'),
              hakase('犯人捜しは後だ。削るのは開発からだ。本番のコストは「止まらないための費用」だから、手を付けん。'),
            )
          : ng(hakase('まだ見ていないものがある。チェックリストの未完了の項目を見たまえ。予算と予測は `aws budgets describe-budgets`、環境別とサービス別は `aws ce get-cost-and-usage` の `--group-by` で分けて見るのだ。')),
    },
    7: {
      type: 'exercise',
      title: '開発 DB を開発向けにする',
      objective: '`dev-db` をシングル AZ にし、バックアップ保持期間を 7 日以下にして、古い手動スナップショットを整理する (残すのは 1 つまで)。本番の `webapp-db` は変えない',
      tasks: [
        {
          id: 'az',
          title: '`aws rds modify-db-instance` で `dev-db` をシングル AZ に (`--no-multi-az`)',
          hint: '`aws rds modify-db-instance --db-instance-identifier dev-db --no-multi-az --apply-immediately`。`--no-` を頭に付けると「オフにする」の意味になります。`--apply-immediately` を付けると、次のメンテナンスの時間を待たずにすぐ変わります。',
          command: 'aws rds modify-db-instance --db-instance-identifier dev-db --no-multi-az --apply-immediately',
          done: (c) => devSingleAz(c.env),
        },
        {
          id: 'retention',
          title: 'バックアップ保持期間を **7 日以下** に (`--backup-retention-period`)',
          hint: '変更の直後は `DBInstanceStatus` が `modifying` で、その間にもう一度変えようとすると `InvalidDBInstanceState` で断られます。`aws rds wait db-instance-available --db-instance-identifier dev-db` で待ってから打ちます。0 日にすると自動バックアップが無効になるので、1〜7 日にします。',
          command: 'aws rds wait db-instance-available --db-instance-identifier dev-db && aws rds modify-db-instance --db-instance-identifier dev-db --backup-retention-period 7 --apply-immediately',
          done: (c) => devRetention(c.env),
        },
        {
          id: 'snap',
          title: '`dev-db` の古い手動スナップショットを `aws rds delete-db-snapshot` で削除 (残り 1 つ以下)',
          hint: "`aws rds describe-db-snapshots --db-instance-identifier dev-db --snapshot-type manual --query 'DBSnapshots[].[DBSnapshotIdentifier,SnapshotCreateTime]' --output text` で一覧を見て、新しいものを 1 つ残して消します。`for s in 名前1 名前2; do aws rds delete-db-snapshot --db-snapshot-identifier $s; done` のように、`for` で繰り返すと楽です。",
          command: (c) => `for s in ${devManualSnaps(c.env).slice(0, -1).map((s) => s.dbSnapshotIdentifier).join(' ')}; do aws rds delete-db-snapshot --db-snapshot-identifier $s --query DBSnapshot.Status --output text; done`,
          done: (c) => devSnapshots(c.env),
        },
      ],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (devRetentionDays(c.env) === 0) return ng(hakase('保持期間 0 日は「短い」ではなく「自動バックアップを止める」設定だ。開発でも、壊したときに戻せる日がなくなるぞ。`--backup-retention-period` を 1〜7 にするのだ。'));
        if (!devSingleAz(c.env) || !devRetention(c.env) || !devSnapshots(c.env))
          return ng(
            hakase('dev-db の作りすぎがまだ残っておる。`aws rds describe-db-instances --db-instance-identifier dev-db` で `MultiAZ` と `BackupRetentionPeriod` を確かめるのだ。'),
            hakase('直すのは `aws rds modify-db-instance` の `--no-multi-az` と `--backup-retention-period 7`。手動スナップショットは `aws rds delete-db-snapshot` で 1 つまで減らす。'),
          );
        return ok(
          node('開発 DB だけで月 $230 以上減りました！'),
          hakase('開発の DB が AZ 障害で 1 時間止まっても、困るのは開発者だけだ。コーヒー休憩が 1 時間延びるとも言う。'),
          node('手動スナップショットも 1 つは残したので、いざとなれば戻せますしね。'),
          hakase('うむ。本番の webapp-db はマルチ AZ のままだ。「止まったら誰が困るか」、そこが天秤の分かれ目だ。'),
        );
      },
    },
    8: {
      type: 'exercise',
      title: 'NAT ゲートウェイとデータ転送を見直す',
      objective: '`dev-vpc` に S3 のゲートウェイエンドポイントを作って dev-batch の S3 通信を NAT から外し、NAT ゲートウェイを 1 つにまとめる (通信は止めない)',
      tasks: [
        {
          id: 'vpce',
          title: '`aws ec2 create-vpc-endpoint` で S3 のゲートウェイエンドポイントを作る (VPC `dev-vpc`、プライベートのルートテーブル 3 つ)',
          hint: "`--service-name com.amazonaws.ap-northeast-1.s3` を指定し、`--route-table-ids` に 3 つの ID を空白区切りで並べます。ID は `aws ec2 describe-route-tables --filters 'Name=tag:Name,Values=dev-private-rt-*' --query 'RouteTables[].RouteTableId' --output text` で出せます (値の `*` は「何でも」)。ゲートウェイエンドポイントは無料です。",
          command: (c) => `aws ec2 create-vpc-endpoint --vpc-id ${devVpcId(c.env)} --service-name com.amazonaws.ap-northeast-1.s3 --route-table-ids ${AZS.map((az) => rtId(c.env, az)).join(' ')}`,
          done: (c) => viaEndpoint(c.env),
        },
        {
          id: 'routes',
          title: '`dev-private-rt-1c` と `dev-private-rt-1d` の 0.0.0.0/0 を `dev-nat-1a` に向け直す',
          hint: '`aws ec2 describe-nat-gateways --filter Name=tag:Name,Values=dev-nat-1a` で NAT ゲートウェイ ID を調べます (このコマンドだけ `--filter` と単数形です)。`aws ec2 replace-route --route-table-id <ルートテーブル ID> --destination-cidr-block 0.0.0.0/0 --nat-gateway-id <dev-nat-1a の ID>` を 2 つのルートテーブルに打ちます。',
          command: (c) => ['1c', '1d'].map((az) => `aws ec2 replace-route --route-table-id ${rtId(c.env, az)} --destination-cidr-block 0.0.0.0/0 --nat-gateway-id ${natId(c.env, '1a')}`).join(' && '),
          done: (c) => oneNat(c.env) && flowsWork(c.env),
        },
        {
          id: 'nat',
          title: '使わなくなった `dev-nat-1c` と `dev-nat-1d` を `aws ec2 delete-nat-gateway` で削除 (残り 1 つ)',
          hint: '向け直す前に削除すると、その AZ のサブネットはインターネットに出られなくなります (ルートの `State` が `blackhole` になります)。`State` は `deleting` から `deleted` に変わり、`deleting` の間も時間料金はかかります。`aws ec2 wait nat-gateway-deleted --nat-gateway-ids <ID> <ID>` で消え終わるまで待てます。',
          command: (c) => `${['1c', '1d'].map((az) => `aws ec2 delete-nat-gateway --nat-gateway-id ${natId(c.env, az)}`).join(' && ')} && aws ec2 wait nat-gateway-deleted --nat-gateway-ids ${natId(c.env, '1c')} ${natId(c.env, '1d')}`,
          done: (c) => devNats(c.env).length === 1 && flowsWork(c.env),
        },
      ],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (!viaEndpoint(c.env)) return ng(hakase('dev-batch の S3 への通信が、まだ NAT ゲートウェイを通っておる。1 GB ごとに処理料金がかかるのだ。`aws ec2 create-vpc-endpoint` で `com.amazonaws.ap-northeast-1.s3` のゲートウェイエンドポイントを作り、`--route-table-ids` に dev-vpc のプライベートのルートテーブルを 3 つとも並べるのだ。'));
        if (devNats(c.env).length !== 1) return ng(hakase('開発の NAT ゲートウェイはまだ 1 つになっておらん。先に `aws ec2 replace-route` で dev-private-rt-1c と dev-private-rt-1d の 0.0.0.0/0 を dev-nat-1a に向け直し、それから `aws ec2 delete-nat-gateway` で dev-nat-1c と dev-nat-1d を削除するのだ。'));
        return ok(
          node('S3 への 2,000 GB が無料になって、NAT も 1 つになりました。'),
          hakase('`describe-route-tables` を見てみたまえ。`DestinationPrefixListId` が `pl-` で始まるルートが、エンドポイントが足した「S3 行き」だ。'),
          hakase('dev-batch の S3 への通信は、インターネットにも出なくなった。コストだけでなく、セキュリティも良くなったわけだ。'),
          node('NAT を 1 つにしたほうは、可用性を削ったんですよね。'),
          hakase('そうだ。開発だから許せる妥協だ。本番では AZ ごとに置くのだぞ。本番の出口を 1 つにして AZ 障害に巻き込まれた障害報告書は、だいたい「コスト削減のため」という一文から始まる。'),
        );
      },
    },
    9: {
      type: 'exercise',
      title: 'ログの保持期間を見直す',
      objective: 'デバッグログ `/webapp/dev/debug` の保持期間を 14 日以下にする。監査ログ `/aws/cloudtrail/management-events` はそのまま残す',
      tasks: [
        {
          id: 'debug',
          title: '`aws logs put-retention-policy` で `/webapp/dev/debug` の保持期間を 14 日以下に',
          hint: '`--retention-in-days 14` のように日数で指定します (使える日数は 1, 3, 5, 7, 14, 30, … と決まっています)。監査ログ `/aws/cloudtrail/management-events` の保持期間は変えません。`aws logs describe-log-groups` の `retentionInDays` で確かめられます。',
          command: 'aws logs put-retention-policy --log-group-name /webapp/dev/debug --retention-in-days 14',
          done: (c) => debugShort(c.env),
        },
      ],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (!debugShort(c.env)) return ng(hakase('デバッグログの保持期間がまだ長い。`aws logs put-retention-policy --log-group-name /webapp/dev/debug --retention-in-days 14` で、14 日以下にするのだ。'));
        return ok(
          node('保存料金が下がりました。でも取り込みの $228 はそのままです。'),
          hakase('ログは「取り込んだ量」でも課金されると言ったろう。量そのものを減らすには、アプリの **ログレベル** を DEBUG から INFO に上げるのが次の一手だ。'),
          node('ろぐれべる？'),
          hakase('どこまで細かく書くかの目盛りだ。DEBUG は何でも書き、INFO は大事なことだけを書く。開発者の独り言まで全部録音しておく必要はない。もちろん監査ログは減らさんぞ。'),
        );
      },
    },
    10: {
      type: 'exercise',
      title: '予算内に収める',
      objective: `\`aws budgets describe-budgets\` で、予測が予算 ${formatUsd(850)} 以内になったことを確かめる (本番の可用性・監査ログ・開発の通信は守ったまま)`,
      tasks: [
        {
          id: 'budget',
          title: '予算の予測 (`ForecastedSpend`) が予算 (`BudgetLimit`) 以内',
          hint: "`--query 'Budgets[0].CalculatedSpend.ForecastedSpend.Amount' --output text` で予測の金額だけを出せます。足りなければ、開発のサーバー (dev-web-1 / dev-batch) を使わない時間は `aws ec2 stop-instances` で停止するのも手です。",
          command: `aws budgets describe-budgets --account-id ${ACCOUNT} --query 'Budgets[0].CalculatedSpend.ForecastedSpend.Amount' --output text`,
          done: (c) => total(c.env) <= budget(c.env) && !guards(c.env) && budgetShown(c),
        },
      ],
      validate: (c) => {
        const g = guards(c.env);
        if (g) return g;
        if (total(c.env) > budget(c.env)) return ng(hakase(`まだ予測は ${formatUsd(total(c.env))}。予算 ${formatUsd(budget(c.env))} を超えておる。\`aws ce get-cost-and-usage\` の内訳を大きい行から見直すのだ。開発のサーバー (dev-web-1 / dev-batch) を、使わない時間は \`aws ec2 stop-instances\` で停止するのも手だ。`));
        if (!budgetShown(c)) return ng(hakase('予測は予算内に収まったはずだ。`aws budgets describe-budgets` で、`ForecastedSpend` を自分の目で確かめるのだ。'));
        return ok(
          node(`予測 ${formatUsd(total(c.env))}、予算内です！`),
          hakase('本番の可用性と監査ログには 1 ドルも手を付けずに達成した。'),
          node('削ったのは、開発の作りすぎだけですね。'),
          hakase('コスト削減とは「どこを削らないか」を決めることなのだ。経理には、ワシが削ったと報告しておこう。'),
          node('えっ。'),
        );
      },
    },
  },
};

/* ---------------- 40 Organizations / SCP ---------------- */

const tokyo = { 'aws:RequestedRegion': 'ap-northeast-1' };
const virginia = { 'aws:RequestedRegion': 'us-east-1' };
const members = [ORG_ACCOUNTS.audit, ORG_ACCOUNTS.logArchive, ORG_ACCOUNTS.prod, ORG_ACCOUNTS.staging, ORG_ACCOUNTS.dev];
const scp = (env: AwsEnv, account: string, action: string, ctx = tokyo) => evaluateScp(env, account, action, ctx).decision;
const prodMoved = (env: AwsEnv) => env.organization?.accounts.find((a) => a.id === ORG_ACCOUNTS.prod)?.parentId === ORG_OUS.production;
const auditProtected = (env: AwsEnv) => members.every((a) => scp(env, a, 'cloudtrail:StopLogging') === 'ExplicitDeny' && scp(env, a, 'cloudtrail:DeleteTrail') === 'ExplicitDeny');
const stillWorks = (env: AwsEnv) => members.every((a) => scp(env, a, 'ec2:DescribeInstances') === 'Allow' && scp(env, a, 's3:GetObject') === 'Allow');
const devTokyoOnly = (env: AwsEnv) => scp(env, ORG_ACCOUNTS.dev, 'ec2:RunInstances', virginia) === 'ExplicitDeny' && scp(env, ORG_ACCOUNTS.dev, 'ec2:RunInstances') === 'Allow';
const globalOk = (env: AwsEnv) => scp(env, ORG_ACCOUNTS.dev, 'iam:CreateRole', virginia) !== 'ExplicitDeny';
const rootId = (env: AwsEnv) => env.organization?.rootId ?? 'r-xxxx';
const auditPolicy = (env: AwsEnv) => env.organization?.policies.find((p) => !p.awsManaged && p.name !== 'prod-guardrails' && !JSON.stringify(p.document).includes('aws:RequestedRegion'));
const regionPolicy = (env: AwsEnv) => env.organization?.policies.find((p) => !p.awsManaged && JSON.stringify(p.document).includes('aws:RequestedRegion'));
const PROTECT_AUDIT = '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":["cloudtrail:StopLogging","cloudtrail:DeleteTrail"],"Resource":"*"}]}';
const REGION_GUARD = JSON.stringify(
  { Version: '2012-10-17', Statement: [{ Sid: 'DenyOutsideTokyo', Effect: 'Deny', NotAction: ['iam:*', 'organizations:*', 'sts:*', 'route53:*', 'cloudfront:*', 'support:*'], Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': ['ap-northeast-1'] } } }] },
  null,
  2,
);
const satoDenied = (c: TaskContext) => !!deniedAs(c, 'rds delete-db-snapshot', 'AccessDenied', ORG_ACCOUNTS.prod, 'sato');
const nodeDeniedInVirginia = (c: TaskContext) => !!deniedAs(c, 'ec2 run-instances', 'UnauthorizedOperation', ORG_ACCOUNTS.dev, 'node') && deniedAs(c, 'ec2 run-instances', 'UnauthorizedOperation', ORG_ACCOUNTS.dev, 'node')?.region === 'us-east-1';

function orgGuards(env: AwsEnv) {
  if (!stillWorks(env))
    return ng(
      hakase('普通の操作 (ec2:DescribeInstances や s3:GetObject) まで止まっているアカウントがある。FullAWSAccess を外したり、すべてを拒否する SCP を付けたりしていないか、`aws organizations list-targets-for-policy` で SCP の付き先を確かめるのだ。'),
      hakase('外すなら `aws organizations detach-policy` だ。柵を立てるつもりで、道路ごと封鎖してどうする。'),
    );
  return undefined;
}

const lesson40: CliPatch = {
  files: () => ({
    '.aws/config': [DEFAULT_CONFIG, SSO_SESSION('sato'), SSO_SESSION('node'), SSO_PROFILE('sato-prod', 'sato', ORG_ACCOUNTS.prod, 'AdministratorAccess'), SSO_PROFILE('node-dev', 'node', ORG_ACCOUNTS.dev, 'AdministratorAccess')].join('\n'),
    'region-guard.json': REGION_GUARD + '\n',
  }),
  steps: {
    3: [
      {
        type: 'dialogue',
        lines: [
          node('表に「管理アカウントには SCP は適用されない」ってありますね。'),
          hakase('いちばん偉いアカウントだけは柵の外だ。だから管理アカウントでは普段の作業をせん。社長室の金庫の鍵は、持つ人を最小限にするのだ。'),
          node('で、今日の症状は何ですか？'),
          hakase('Production OU には `prod-guardrails` という SCP が付いていて、本番の DB やスナップショットの削除を禁止しておる。…はずなのだが、効いておらん疑いがある。'),
          node('効いてるかどうかは、どうやって確かめるんですか？'),
          hakase('その人になって試すのが一番だ。使うのは **IAM Identity Center**、人が 1 か所でサインインして、入るアカウントと **許可セット** (そのアカウントでの権限のセット) を選ぶ仕組みだ。詳しくは次の Lesson 41 でやる。'),
          node('CLI だと、どうやってその人になるんですか？'),
          hakase('`~/.aws/config` に **プロファイル** を書いておく。「どのアカウントに、どの許可セットで入るか」に名前を付けたものだ。運用担当の sato さんが本番 (webapp-prod) に `AdministratorAccess` で入る `sato-prod` を用意しておいた。'),
          node('ぷろふぁいる。`cat ~/.aws/config` で見ると…`sso_account_id` がアカウント、`sso_role_name` が許可セットですね。'),
          hakase('うむ。コマンドに `--profile sato-prod` を付ければ、sato さんとして打てる。ただし先に、`aws sso login --profile sato-prod` でサインインしておかねばならん。'),
        ],
      },
      {
        type: 'dialogue',
        lines: [
          node('サインインって、パスワードはどうするんですか？ 僕、sato さんのパスワードなんて知りませんよ。'),
          hakase('知っておったら大問題だ。本物ならブラウザが開いて、本人がパスワードを入れる。このシミュレーターでは代わりに、`[sso-session sato]` のように **セッションの名前と同じユーザー** でサインインしたことにする。'),
          node('許可セットの `AdministratorAccess` って、名前からして何でもできそうですね。'),
          hakase('そのアカウントで何でもできる管理者だ。sato さんとして、その権限で本番の `rds:DeleteDBSnapshot`、つまりスナップショットの削除を試す。管理者でも止められれば、ガードレールが効いている証拠だ。'),
          node('本当に消えちゃったらどうするんですか？'),
          hakase('ここはシミュレーターだ。メンバーアカウントの中身までは再現しておらんから、確かめられるのは「許可されるか、拒否されるか」までだ。消えるのは、ガードレールが効いていなかったという事実のほうだけだ。'),
        ],
      },
    ],
    4: {
      type: 'dialogue',
      lines: [
        node('ほかにやることはありますか？'),
        hakase('2 つある。1 つ目は、Lesson 26 の CloudTrail を止められんようにすることだ。イベント履歴で見られるのは 90 日分だが、もっと長く残すために記録を送り続ける設定を **証跡 (トレイル)** という。記録を止める `cloudtrail:StopLogging` と、証跡を消す `cloudtrail:DeleteTrail` を、組織全体で禁止する。'),
        node('2 つ目は？'),
        hakase('開発アカウントで、東京以外の **リージョン** を使わせないことだ。Lesson 02 でやったとおり、`--region` を変えて問い合わせんと、そこのリソースは出てこん。'),
        node('誰も見てないリージョンで、高いインスタンスが動き続けちゃうってことですか。'),
        hakase('月末に経理から二度目の電話が来て、初めて気付くやつだ。ただし IAM のような **グローバルサービス** まで止めてはいかん。'),
        node('ぐろーばるさーびす？'),
        hakase('リージョンに属さず、世界に 1 つだけあるサービスだ。IAM、Organizations、Route 53、CloudFront などがそうだ。こういうサービスへのリクエストは、多くが us-east-1 に届いたものとして扱われる。Lesson 36 で CloudFront の証明書を us-east-1 で作ったのも、CloudFront がグローバルサービスだからだ。'),
        node('「東京以外は禁止」とだけ書くと、IAM まで禁止されちゃうんですね。'),
        hakase('そういうことだ。まずは組織の構造から見る。`aws organizations` の応答は長いから、Lesson 09-2 の `--query` の `[?条件]` で絞るのだ。'),
        node('`"Policies[?Name==\'prod-guardrails\'].Id"` なら、名前が prod-guardrails のポリシーの ID だけが残るんですね。'),
      ],
    },
    5: {
      type: 'exercise',
      title: '組織の構造を確かめる',
      objective: '`aws organizations` で組織のアカウントを見て、`webapp-prod` の親 (どの OU の下にいるか) と、`prod-guardrails` がどこに付いているかを確かめる',
      tasks: [
        {
          id: 'accounts',
          title: '`aws organizations list-accounts` でアカウントの一覧を見る',
          hint: "`--query 'Accounts[].[Id,Name,JoinedMethod]' --output table` で、ID・名前・組織への入り方だけにすると見やすくなります。",
          command: "aws organizations list-accounts --query 'Accounts[].[Id,Name,JoinedMethod]' --output table",
          done: (c) => !!ranAws(c, 'organizations list-accounts'),
        },
        {
          id: 'parent',
          title: '`aws organizations list-parents` で `webapp-prod` の親を見る',
          hint: '`--child-id` に webapp-prod のアカウント ID を入れます。`Type` が `ORGANIZATIONAL_UNIT` なら OU の下、`ROOT` ならルートの直下です。',
          command: `aws organizations list-parents --child-id ${ORG_ACCOUNTS.prod}`,
          done: (c) => !!ranAws(c, 'organizations list-parents', (x) => param(x, 'child-id') === ORG_ACCOUNTS.prod),
        },
        {
          id: 'prod',
          title: '`prod-guardrails` が付いている先を `aws organizations list-targets-for-policy` で見る',
          hint: '`aws organizations list-policies --filter SERVICE_CONTROL_POLICY` でポリシー ID (p-...) を調べ、`aws organizations list-targets-for-policy --policy-id <ID>` を打ちます。`--query "Policies[?Name==\'prod-guardrails\'].Id" --output text` で ID だけを取り出せます。',
          command: `POLICY_ID=$(aws organizations list-policies --filter SERVICE_CONTROL_POLICY --query "Policies[?Name=='prod-guardrails'].Id" --output text); aws organizations list-targets-for-policy --policy-id $POLICY_ID`,
          done: (c) => !!ranAws(c, 'organizations list-targets-for-policy', (x) => x.output.includes('prod-guardrails') || x.output.includes(ORG_OUS.production)),
        },
      ],
      validate: (c) =>
        ranAws(c, 'organizations list-parents', (x) => param(x, 'child-id') === ORG_ACCOUNTS.prod) && ranAws(c, 'organizations list-targets-for-policy', (x) => x.output.includes(ORG_OUS.production))
          ? ok(
              node('`list-parents` の `Type` が `ROOT` です。webapp-prod は Production OU に入っていません！'),
              hakase('組織に招待したアカウントは、最初はルートの直下に入る。`JoinedMethod` が `INVITED` になっておったろう。誰かが Production に移し忘れたのだ。'),
              node('で、`prod-guardrails` が付いているのは Production OU だけ。じゃあ…'),
              hakase('肝心の本番に効いておらん。柵を立てた道路の隣を、本番だけが柵なしで走っておったわけだ。'),
            )
          : ng(hakase('まだ確かめておらんものがある。`aws organizations list-parents --child-id <webapp-prod の ID>` で親を、`aws organizations list-targets-for-policy` で prod-guardrails の付き先を見るのだ。')),
    },
    6: {
      type: 'exercise',
      title: '本番アカウントを Production OU に移す',
      objective: '`webapp-prod` を Production OU に移動し、運用担当 `sato` のプロファイル `sato-prod` (AdministratorAccess) で、本番の `rds:DeleteDBSnapshot` が拒否されることを確かめる',
      tasks: [
        {
          id: 'move',
          title: '`aws organizations move-account` で `webapp-prod` を Production OU へ',
          hint: 'ルートの ID (r-...) は `aws organizations list-roots`、Production OU の ID (ou-...) は `aws organizations list-organizational-units-for-parent --parent-id <ルートの ID>` で調べます。`--source-parent-id` には今の親 (ルート)、`--destination-parent-id` には移し先を入れます。',
          command: (c) => `aws organizations move-account --account-id ${ORG_ACCOUNTS.prod} --source-parent-id ${rootId(c.env)} --destination-parent-id ${ORG_OUS.production}`,
          done: (c) => prodMoved(c.env),
        },
        {
          id: 'login',
          title: '`aws sso login --profile sato-prod` で sato さんとしてサインイン',
          hint: 'サインインすると、トークン (サインインした証明) が `~/.aws/sso/cache/` に置かれます。`--sso-session sato` でも同じです。',
          command: 'aws sso login --profile sato-prod',
          done: (c) => !!ranAws(c, 'sso login', (x) => /sato/.test(x.line)),
        },
        {
          id: 'try',
          title: '`--profile sato-prod` で、本番のスナップショット `webapp-db-before-release` の削除を試す',
          hint: '`aws rds delete-db-snapshot --db-snapshot-identifier webapp-db-before-release --profile sato-prod`。AdministratorAccess でも、SCP が拒否すれば `AccessDenied` になります。',
          command: 'aws rds delete-db-snapshot --db-snapshot-identifier webapp-db-before-release --profile sato-prod',
          done: (c) => prodMoved(c.env) && satoDenied(c),
        },
      ],
      validate: (c) => {
        if (!prodMoved(c.env)) return ng(hakase('webapp-prod はまだ Production OU の外だ。`aws organizations move-account` の `--destination-parent-id` に Production OU の ID を入れるのだ。'));
        if (!satoDenied(c)) return ng(hakase('移動はできた。次は確かめだ。`aws sso login --profile sato-prod` でサインインしてから、`--profile sato-prod` を付けて `aws rds delete-db-snapshot` を打つのだ。'));
        return ok(
          node('AdministratorAccess なのに `AccessDenied` で、`with an explicit deny in a service control policy` と出ました！'),
          hakase('「SCP の明示的な拒否によって」と書いてある。IAM で何を許可されていても、SCP の拒否が勝つ。'),
          node('アカウントの管理者でも外せないガードレール、ですね。'),
          hakase('うむ。これで sato さんが寝ぼけて本番のスナップショットを消す心配はなくなった。君が消す心配もな。'),
          hakase('次は SCP を自分で書く。Lesson 21 でやったとおり、JSON はファイルに書いて `file://` で渡す。この端末にはエディタがないから、`echo \'...\' > ファイル名` で書くのだ。'),
        );
      },
    },
    7: {
      type: 'exercise',
      title: '監査ログを止められないようにする',
      objective: 'SCP `protect-audit` を作って `cloudtrail:StopLogging` と `cloudtrail:DeleteTrail` を拒否し、**ルート** にアタッチして全メンバーアカウントに効かせる',
      tasks: [
        {
          id: 'create',
          title: '`aws organizations create-policy` で SCP `protect-audit` を作る (Effect: Deny、Action: 2 つ、Resource: *)',
          hint: `まず JSON をファイルに書きます: \`echo '${PROTECT_AUDIT}' > protect-audit.json\`。続けて \`aws organizations create-policy --name protect-audit --description '監査ログの停止と削除を禁止' --type SERVICE_CONTROL_POLICY --content file://protect-audit.json\`。`,
          command: `echo '${PROTECT_AUDIT}' > protect-audit.json && aws organizations create-policy --name protect-audit --description '監査ログの停止と削除を禁止' --type SERVICE_CONTROL_POLICY --content file://protect-audit.json`,
          done: (c) => !!auditPolicy(c.env),
        },
        {
          id: 'attach',
          title: '`aws organizations attach-policy` で Root にアタッチ',
          hint: '`--policy-id` は create-policy の応答の `Policy.PolicySummary.Id` (p-...)、`--target-id` は `aws organizations list-roots` の `Id` (r-...) です。Root に付けると、下のすべての OU とアカウントに継承されます。',
          command: (c) => `aws organizations attach-policy --policy-id ${auditPolicy(c.env)?.id ?? 'p-xxxxxxxx'} --target-id ${rootId(c.env)}`,
          done: (c) => auditProtected(c.env),
        },
      ],
      validate: (c) => {
        const g = orgGuards(c.env);
        if (g) return g;
        if (!auditProtected(c.env)) return ng(hakase('まだ CloudTrail を止められるメンバーアカウントがある。`aws organizations attach-policy` の `--target-id` にルートの ID (r-...) を入れれば、下のすべての OU とアカウントに継承されるぞ。'));
        return ok(
          node('全部のメンバーアカウントで、CloudTrail を止められなくなりました。'),
          hakase('侵入した攻撃者が最初にやるのは、証拠を消すこと、つまり CloudTrail を止めることだ。それを組織全体で封じた。'),
          node('泥棒が最初に防犯カメラを壊すのと同じですね。'),
          hakase('そうだ。次のリージョン制限では、Deny に **Condition** (条件) を付ける。`aws:RequestedRegion` はリクエスト先のリージョン、`StringNotEquals` は「一致しなければ」だ。合わせて「東京でなければ拒否」になる。'),
          hakase('グローバルサービスは、「ここに書いたもの以外を拒否する」という **NotAction** の書き方で外す。長いから、`region-guard.json` に書いておいた。`cat region-guard.json` で読んでみたまえ。'),
        );
      },
    },
    8: {
      type: 'exercise',
      title: '開発アカウントのリージョンを制限する',
      objective: 'Development OU に、東京リージョン (ap-northeast-1) 以外での操作を拒否する SCP を付ける。IAM などのグローバルサービスは止めない。`node-dev` プロファイル (webapp-dev の AdministratorAccess) で、us-east-1 の `ec2:RunInstances` が拒否されることを確かめる',
      tasks: [
        {
          id: 'create',
          title: '`region-guard.json` を読んで、`aws organizations create-policy` で SCP を作る',
          hint: '`cat region-guard.json` で中身を確かめます。NotAction で iam:* などのグローバルサービスを外し、Condition の StringNotEquals で ap-northeast-1 以外を拒否しています。`--content file://region-guard.json` で渡します。',
          command: "cat region-guard.json && aws organizations create-policy --name dev-tokyo-only --description '東京以外のリージョンでの操作を禁止' --type SERVICE_CONTROL_POLICY --content file://region-guard.json",
          done: (c) => !!regionPolicy(c.env),
        },
        {
          id: 'scp',
          title: '作った SCP を Development OU にアタッチ',
          hint: 'Development OU の ID (ou-...) は `aws organizations list-organizational-units-for-parent --parent-id <ルートの ID>` で調べます。',
          command: (c) => `aws organizations attach-policy --policy-id ${regionPolicy(c.env)?.id ?? 'p-xxxxxxxx'} --target-id ${ORG_OUS.development}`,
          done: (c) => devTokyoOnly(c.env),
        },
        {
          id: 'login',
          title: '`aws sso login --profile node-dev` で node としてサインイン',
          hint: '`node-dev` は、node が webapp-dev に AdministratorAccess で入るプロファイルです (`cat ~/.aws/config`)。',
          command: 'aws sso login --profile node-dev',
          done: (c) => !!ranAws(c, 'sso login', (x) => /node/.test(x.line)),
        },
        {
          id: 'try',
          title: '`--profile node-dev --region us-east-1` で `aws ec2 run-instances` を試す',
          hint: '`aws ec2 run-instances --image-id ami-0d52744d6551d851e --instance-type t3.micro --region us-east-1 --profile node-dev`。`UnauthorizedOperation` のメッセージの最後で、何が拒否したかが分かります。',
          command: 'aws ec2 run-instances --image-id ami-0d52744d6551d851e --instance-type t3.micro --region us-east-1 --profile node-dev',
          done: (c) => devTokyoOnly(c.env) && nodeDeniedInVirginia(c),
        },
      ],
      validate: (c) => {
        const g = orgGuards(c.env);
        if (g) return g;
        if (!devTokyoOnly(c.env)) return ng(hakase('webapp-dev で、us-east-1 の ec2:RunInstances が拒否され、東京では許可される状態にするのだ。`region-guard.json` で SCP を作り、`aws organizations attach-policy` で Development OU に付けたまえ。'));
        if (!globalOk(c.env)) return ng(hakase('IAM のようなグローバルサービスまで止まっておる。グローバルサービスへのリクエストはリージョンが us-east-1 になるから、NotAction で iam:* などを除外しないと、開発者がロールも作れなくなるぞ。`aws organizations update-policy --policy-id <ID> --content file://region-guard.json` で直せる。'));
        if (!nodeDeniedInVirginia(c)) return ng(hakase('SCP はできた。最後に確かめだ。`aws sso login --profile node-dev` でサインインし、`--profile node-dev --region us-east-1` を付けて `aws ec2 run-instances` を試すのだ。'));
        return ok(
          node('東京以外では、管理者でもインスタンスを起動できなくなりました。'),
          hakase('誰も見ないリージョンに高額なインスタンスが置き去りにされる事故を防げる。乗っ取られたアカウントで、知らないリージョンに暗号資産の採掘マシンをずらりと並べられる事故もな。'),
          node('セキュリティとコストの両方に効くガードレールですね。'),
          hakase('うむ。前回の天秤で言えば、何も失わんほうのレバーだ。'),
        );
      },
    },
  },
};

/* ---------------- 41 IAM Identity Center ---------------- */

const sso = (env: AwsEnv) => env.identityCenter;
const readOnly = (env: AwsEnv) => sso(env)?.permissionSets.find((p) => p.managedPolicyArns.some((a) => a.endsWith('/ReadOnlyAccess')));
const devsOn = (env: AwsEnv, account: string) =>
  (sso(env)?.assignments ?? []).filter((a) => a.accountId === account && a.principalType === 'GROUP' && a.principalName === 'Developers').map((a) => sso(env)!.permissionSets.find((p) => p.arn === a.permissionSetArn)?.name);
const prodReadOnly = (env: AwsEnv) => {
  const ro = readOnly(env);
  const on = devsOn(env, ORG_ACCOUNTS.prod);
  return !!ro && on.length === 1 && on[0] === ro.name;
};
const nodeCanDev = (env: AwsEnv) => portalAccess(env, 'node').some((a) => a.accountId === ORG_ACCOUNTS.dev);
const instanceArn = (env: AwsEnv) => sso(env)?.instanceArn ?? 'arn:aws:sso:::instance/ssoins-xxxx';
const psArn = (env: AwsEnv, name: string) => sso(env)?.permissionSets.find((p) => p.name === name)?.arn ?? 'arn:aws:sso:::permissionSet/ssoins-xxxx/ps-xxxx';
const devGroupId = (env: AwsEnv) => (sso(env) ? principalId(sso(env)!, 'GROUP', 'Developers') : 'xxxxxxxx');
const TOKEN = `TOKEN=$(grep accessToken ~/.aws/sso/cache/node.json | cut -d'"' -f4)`;
const assignment = (verb: 'create' | 'delete', env: AwsEnv, ps: string) =>
  `aws sso-admin ${verb}-account-assignment --instance-arn ${instanceArn(env)} --target-id ${ORG_ACCOUNTS.prod} --target-type AWS_ACCOUNT --permission-set-arn ${psArn(env, ps)} --principal-type GROUP --principal-id ${devGroupId(env)}`;
/** node-prod が ReadOnlyAccess になったのを get-caller-identity で見てから、node-prod で describe-instances が通った */
const roIdentity = (c: TaskContext) => ranAws(c, 'sts get-caller-identity', (x) => x.output.includes(`arn:aws:sts::${ORG_ACCOUNTS.prod}:assumed-role/AWSReservedSSO_ReadOnlyAccess_`) && x.output.includes('/node'));
const nodeProdRead = (c: TaskContext) => !!ranAws(c, 'ec2 describe-instances', (x) => /--profile[= ]node-prod\b/.test(x.line) && x.at >= (roIdentity(c)?.at ?? Infinity));
const nodeProdDenied = (c: TaskContext) => !!deniedAs(c, 'ec2 terminate-instances', 'UnauthorizedOperation', ORG_ACCOUNTS.prod, 'node', 'ReadOnlyAccess_');

const lesson41: CliPatch = {
  files: () => ({
    '.aws/config': [DEFAULT_CONFIG, SSO_SESSION('node'), SSO_PROFILE('node-dev', 'node', ORG_ACCOUNTS.dev, 'AdministratorAccess'), SSO_PROFILE('node-prod', 'node', ORG_ACCOUNTS.prod, 'AdministratorAccess')].join('\n'),
  }),
  steps: {
    0: {
      type: 'dialogue',
      lines: [
        node('博士、アカウントが増えたら、それぞれに IAM ユーザーを作るんですか？ パスワードとアクセスキーが何個も…'),
        hakase('アカウントが 6 つで開発者が 10 人なら、60 組だな。'),
        node('付箋が足りません。'),
        hakase('付箋に書くでない。Lesson 22 で、アクセスキーは期限のない長期の鍵だから、漏れたら終わりだと言ったろう。退職者の鍵を 1 本消し忘れただけで、元社員が本番に入れてしまう。'),
        node('それは怖すぎます。'),
        hakase('だから人のアクセスは **IAM Identity Center** にまとめる。人は 1 か所でサインインし、そこから各アカウントに **一時的な認証情報** で入る。'),
        node('前回、`aws sso login` でサインインして、`--profile sato-prod` で sato さんとして試したのが、それでしたよね。'),
        hakase('うむ。Identity Center は社員通用口だ。社員証 1 枚で、入ってよいビルとフロアにだけ入れる。`aws sso login` が通用口でのサインイン、プロファイルが「どのビルのどのフロアか」だ。'),
      ],
    },
    1: [
      {
        type: 'dialogue',
        lines: [
          node('どのビルに入れるかは、どうやって決めるんですか？'),
          hakase('部品は 2 つだ。1 つ目が **許可セット**。「そのアカウントの中で何ができるか」のテンプレートだ。'),
          node('社員証の「役職」みたいなものですね。'),
          hakase('うむ。何でもできる `AdministratorAccess` や、見るだけの `ReadOnlyAccess` のように、AWS 管理ポリシーを 1 つ付けただけの許可セットがよく使われる。コンソールなら **事前定義された許可セット** から選ぶだけだが、CLI では「許可セットを作る」「AWS 管理ポリシーを付ける」の 2 手だ。'),
          hakase('2 つ目が **割り当て**。「どのアカウントで・誰に・どの許可セットを」の組み合わせだ。割り当てると、そのアカウントに `AWSReservedSSO_…` という IAM ロールが自動で作られ、サインインした人はそのロールを引き受ける。'),
          node('IAM ロールは、Lesson 22 で EC2 に付けた、一時的な権限を借りるやつですよね。だから長期のアクセスキーがいらないんだ。'),
          hakase('そうだ。一時的な認証情報は、許可セットの **セッション期間** (今の AdministratorAccess は 4 時間) が過ぎると切れる。割り当ての「誰に」には、ユーザー 1 人ずつではなく **グループ** を指定するのがよい。今回は Developers と Operators がある。'),
          node('人が異動しても、グループのメンバーを入れ替えるだけで済みますね。'),
        ],
      },
      {
        type: 'dialogue',
        lines: [
          hakase('うむ。さて、今日の相談は、その Developers グループのことだ。'),
          node('嫌な予感がします。僕、Developers ですよね。'),
          hakase('君の予感は、障害のときだけよく当たるな。自分が入れるアカウントは `aws sso list-accounts`、そこで使える許可セットは `aws sso list-account-roles` で見られる。ブラウザのアクセスポータルに並ぶものと同じだ。'),
          node('`aws sso list-accounts help` を見たら、`--access-token` が必須って書いてあります。'),
          hakase('`aws sso login` で取った **トークン** を渡すのだ。'),
          node('とーくん？'),
          hakase('サインインした証明になる、合言葉のような文字列だ。`~/.aws/sso/cache/` のファイルに入っておる。合言葉をメモ帳に書いて机に貼るなよ。'),
          node('貼りませんよ。でも、ファイルからどうやって取り出すんですか？'),
          hakase('`grep` で accessToken の行を探し、`cut` で値だけを切り出して変数に入れればよい。あとは自分の目で確かめたまえ。'),
        ],
      },
    ],
    2: {
      type: 'exercise',
      title: '今のアクセスを確かめる',
      objective: '`aws sso login` で node としてサインインし、`aws sso list-accounts` と `aws sso list-account-roles` で、node がどのアカウントにどの許可セットで入れるかを見る',
      tasks: [
        {
          id: 'login',
          title: '`aws sso login --sso-session node` でサインイン',
          hint: '`cat ~/.aws/config` で `[sso-session node]` を確かめておきます。サインインすると、トークンが `~/.aws/sso/cache/node.json` に置かれます。',
          command: 'aws sso login --sso-session node',
          done: (c) => !!ranAws(c, 'sso login', (x) => /node/.test(x.line)),
        },
        {
          id: 'accounts',
          title: 'トークンを変数 `TOKEN` に入れて、`aws sso list-accounts` で入れるアカウントを見る',
          hint: "`TOKEN=$(grep accessToken ~/.aws/sso/cache/node.json | cut -d'\"' -f4)` で取り出せます。`grep` は accessToken を含む行だけを出し、`cut -d'\"' -f4` はその行を `\"` で区切った 4 番目 (値) を切り出します。続けて `aws sso list-accounts --access-token $TOKEN`。",
          command: `${TOKEN}; aws sso list-accounts --access-token $TOKEN`,
          done: (c) => !!ranAws(c, 'sso list-accounts'),
        },
        {
          id: 'portal',
          title: '`aws sso list-account-roles` で、webapp-prod (`333333333333`) で使える許可セットを見る',
          hint: '`aws sso list-account-roles --account-id 333333333333 --access-token $TOKEN`。`TOKEN` が空なら、前のタスクの `TOKEN=$(...)` をもう一度打ちます。`--account-id` を変えれば、ほかのアカウントも見られます。',
          command: `aws sso list-account-roles --account-id ${ORG_ACCOUNTS.prod} --access-token $TOKEN`,
          done: (c) => !!ranAws(c, 'sso list-account-roles', (x) => param(x, 'account-id') === ORG_ACCOUNTS.prod),
        },
      ],
      validate: (c) =>
        ranAws(c, 'sso list-account-roles', (x) => param(x, 'account-id') === ORG_ACCOUNTS.prod)
          ? ok(
              node('`list-accounts` には dev も staging も prod も並んでいて、prod の `roleName` は `AdministratorAccess`… 僕、本番の管理者なんですか！？'),
              hakase('Developers グループに、全アカウントの AdministratorAccess が割り当てられておる。Lesson 34 で言った **最小権限** に真っ向から反しておる。'),
              node('必要な操作を、必要な場所にだけ許す、でしたよね。'),
              hakase('そうだ。開発者が本番でやるのは、ログや設定を「見る」ことまでだ。本番は読み取り専用で十分。君に本番の削除ボタンを渡すのは、猫に金魚の見張りを頼むようなものだ。'),
            )
          : ng(hakase('まだ webapp-prod の許可セットを見ておらん。`aws sso login --sso-session node` でサインインし、トークンを `TOKEN` に入れてから、`aws sso list-account-roles --account-id 333333333333 --access-token $TOKEN` を打つのだ。')),
    },
    3: {
      type: 'exercise',
      title: '読み取り専用の許可セットを作る',
      objective: '許可セット **ReadOnlyAccess** を作り、AWS 管理ポリシー `ReadOnlyAccess` を付ける (コンソールの「事前定義された許可セット」と同じもの)',
      tasks: [
        {
          id: 'instance',
          title: '`aws sso-admin list-instances` でインスタンスの ARN を調べ、今の許可セットを見る',
          hint: "`INSTANCE=$(aws sso-admin list-instances --query 'Instances[0].InstanceArn' --output text)` で変数に入れておくと、この先が楽です。`aws sso-admin list-permission-sets --instance-arn $INSTANCE` で許可セットの ARN、`aws sso-admin describe-permission-set --instance-arn $INSTANCE --permission-set-arn <ARN>` で名前とセッション期間が見られます。",
          command: "INSTANCE=$(aws sso-admin list-instances --query 'Instances[0].InstanceArn' --output text); aws sso-admin list-permission-sets --instance-arn $INSTANCE",
          done: (c) => !!ranAws(c, 'sso-admin list-permission-sets'),
        },
        {
          id: 'create',
          title: '`aws sso-admin create-permission-set` で `ReadOnlyAccess` という許可セットを作る',
          hint: "`aws sso-admin create-permission-set --instance-arn $INSTANCE --name ReadOnlyAccess`。応答の `PermissionSet.PermissionSetArn` を `--query` で取り出して、`PS_RO=$(...)` のように変数に入れておきます。",
          command: (c) => `PS_RO=$(aws sso-admin create-permission-set --instance-arn ${instanceArn(c.env)} --name ReadOnlyAccess --query 'PermissionSet.PermissionSetArn' --output text); echo $PS_RO`,
          done: (c) => !!sso(c.env)?.permissionSets.some((p) => p.name !== 'AdministratorAccess'),
        },
        {
          id: 'ps',
          title: '`aws sso-admin attach-managed-policy-to-permission-set` で AWS 管理ポリシー `ReadOnlyAccess` を付ける',
          hint: '`--permission-set-arn $PS_RO --managed-policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess`。AWS 管理ポリシーの ARN は、アカウント ID の代わりに `aws` が入ります。',
          command: (c) => `aws sso-admin attach-managed-policy-to-permission-set --instance-arn ${instanceArn(c.env)} --permission-set-arn ${psArn(c.env, 'ReadOnlyAccess')} --managed-policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess`,
          done: (c) => !!readOnly(c.env),
        },
      ],
      validate: (c) =>
        readOnly(c.env)
          ? ok(
              hakase('許可セット ReadOnlyAccess ができた。だが、作っただけではまだ誰も使えん。'),
              node('役職を作っただけで、まだ誰にも辞令を出してない、と。'),
              hakase('うむ。アカウントに割り当てると、そのアカウントに `AWSReservedSSO_ReadOnlyAccess_…` というロールが作られて、初めて使えるようになる。'),
            )
          : ng(hakase('ReadOnlyAccess の許可セットがまだない。`aws sso-admin create-permission-set` で作り、`aws sso-admin attach-managed-policy-to-permission-set` で `arn:aws:iam::aws:policy/ReadOnlyAccess` を付けるのだ。')),
    },
    4: {
      type: 'exercise',
      title: '本番の割り当てを直す',
      objective: '`webapp-prod` で、Developers グループに ReadOnlyAccess を割り当て、AdministratorAccess の割り当てを削除する (開発アカウントの権限はそのまま)',
      tasks: [
        {
          id: 'group',
          title: '`aws identitystore list-groups` で Developers グループの ID を調べる',
          hint: 'Identity Store の ID (d-...) は `aws sso-admin list-instances` の `IdentityStoreId` です。`--query "Groups[?DisplayName==\'Developers\'].GroupId" --output text` で ID だけを取り出し、`GROUP_ID=$(...)` で変数に入れます。',
          command: (c) => `GROUP_ID=$(aws identitystore list-groups --identity-store-id ${sso(c.env)?.identityStoreId ?? 'd-xxxxxxxxxx'} --query "Groups[?DisplayName=='Developers'].GroupId" --output text); echo $GROUP_ID`,
          done: (c) => !!ranAws(c, 'identitystore list-groups'),
        },
        {
          id: 'assign',
          title: '`aws sso-admin create-account-assignment` で、webapp-prod の Developers に ReadOnlyAccess を割り当てる',
          hint: '`--instance-arn $INSTANCE --target-id 333333333333 --target-type AWS_ACCOUNT --permission-set-arn $PS_RO --principal-type GROUP --principal-id $GROUP_ID`。応答の `Status` が `IN_PROGRESS` なら受け付けられています (数秒で終わります)。',
          command: (c) => assignment('create', c.env, 'ReadOnlyAccess'),
          done: (c) => !!readOnly(c.env) && devsOn(c.env, ORG_ACCOUNTS.prod).includes(readOnly(c.env)!.name),
        },
        {
          id: 'remove',
          title: '`aws sso-admin delete-account-assignment` で、Developers の AdministratorAccess を削除',
          hint: '同じオプションで、`--permission-set-arn` を AdministratorAccess の ARN にします。どの ARN が AdministratorAccess かは、`aws sso-admin list-permission-sets` の ARN を `describe-permission-set` で 1 つずつ見れば分かります。`aws sso-admin list-account-assignments --instance-arn $INSTANCE --account-id 333333333333 --permission-set-arn <ARN>` で、誰に割り当たっているかを確かめられます。Operators の AdministratorAccess は運用担当の分なので残します。',
          command: (c) => assignment('delete', c.env, 'AdministratorAccess'),
          done: (c) => prodReadOnly(c.env),
        },
      ],
      validate: (c) => {
        if (!nodeCanDev(c.env)) return ng(hakase('開発アカウントの割り当てまで消してしまった。開発者が開発できなくなるぞ。`aws sso-admin create-account-assignment` で、webapp-dev (555555555555) の Developers に AdministratorAccess を割り当て直すのだ。'));
        if (!prodReadOnly(c.env)) return ng(hakase('webapp-prod での Developers の許可セットを、ReadOnlyAccess だけにするのだ。`create-account-assignment` で ReadOnlyAccess を割り当てたら、`delete-account-assignment` で AdministratorAccess の割り当てを消したまえ。'));
        return ok(
          hakase('よし。本番の Developers は ReadOnlyAccess だけになった。'),
          node('グループ単位だから、新人が来ても Developers に入れるだけで同じ権限になりますね。'),
          hakase('うむ。人が入れ替わってもグループのメンバーを変えるだけで済む。退職者は Identity Center のユーザーを無効にすれば、全アカウントへのサインインを一度に止められる。付箋を 60 枚探し回る必要はない。'),
        );
      },
    },
    5: {
      type: 'exercise',
      title: '本番でできること・できないことを確かめる',
      objective: '`node-prod` プロファイルを ReadOnlyAccess に書き換え、webapp-prod で `ec2:DescribeInstances` は許可、`ec2:TerminateInstances` は拒否されることを確かめる',
      tasks: [
        {
          id: 'profile',
          title: '`node-prod` プロファイルの許可セットを ReadOnlyAccess にして、`aws sts get-caller-identity` で確かめる',
          hint: '`aws configure set sso_role_name ReadOnlyAccess --profile node-prod` で `~/.aws/config` を書き換えます。`aws sts get-caller-identity --profile node-prod` の `Arn` に、引き受けたロール `AWSReservedSSO_ReadOnlyAccess_…` が出ます。',
          command: 'aws configure set sso_role_name ReadOnlyAccess --profile node-prod && aws sts get-caller-identity --profile node-prod',
          done: (c) => !!roIdentity(c),
        },
        {
          id: 'read',
          title: '`ec2:DescribeInstances` → 許可',
          hint: '`aws ec2 describe-instances --profile node-prod`。エラーにならず JSON が返れば許可です (このシミュレーターはメンバーアカウントのインスタンスを再現していないので、中身は空です)。',
          command: 'aws ec2 describe-instances --profile node-prod',
          done: (c) => prodReadOnly(c.env) && nodeProdRead(c),
        },
        {
          id: 'write',
          title: '`ec2:TerminateInstances` → 拒否',
          hint: '`aws ec2 terminate-instances --instance-ids i-0123456789abcdef0 --profile node-prod`。`UnauthorizedOperation` のメッセージの最後で、拒否の理由が分かります。',
          command: 'aws ec2 terminate-instances --instance-ids i-0123456789abcdef0 --profile node-prod',
          done: (c) => prodReadOnly(c.env) && nodeProdDenied(c),
        },
      ],
      validate: (c) =>
        prodReadOnly(c.env) && nodeProdRead(c) && nodeProdDenied(c)
          ? ok(
              node('見るのは OK、消すのは `UnauthorizedOperation` で、理由は `because no identity-based policy allows` です。'),
              hakase('Lesson 23 で見たのと同じ、「許可しているポリシーがない」という拒否だ。今回は SCP ではなく、許可セットが止めた。'),
              node('これで僕が、うっかり本番を壊すことはないですね。'),
              hakase('うっかりはな。本番を変えるときは、レビュー付きのデプロイの仕組みを通すか、Operators の運用担当に頼むのだ。'),
              node('わざとなら壊せるみたいな言い方、やめてください。'),
            )
          : ng(hakase('2 つの操作をまだ試しておらん。`--profile node-prod` を付けて、`aws ec2 describe-instances` と `aws ec2 terminate-instances` を 1 回ずつ打つのだ。プロファイルの `sso_role_name` が ReadOnlyAccess になっているかも `aws configure get sso_role_name --profile node-prod` で確かめたまえ。')),
    },
  },
};

const patches: CliPatches = { 'cost-tradeoffs': lesson39, 'organizations-scp': lesson40, 'identity-center': lesson41 };
export default patches;

