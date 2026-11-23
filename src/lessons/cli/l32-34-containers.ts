import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { evaluateIamPermission } from '../../sim/iam';
import { runningCount, serviceTasks } from '../../sim/containers';
import { ORDERS_BUCKET, REPORTS_BUCKET } from '../../sim/scenarios';
import { taskId } from '../../sim/targets';
import type { AwsEnv } from '../../sim/types';
import { lastRequestTo, lbNamed } from '../helpers';
import { param, ranAws } from './helpers';
import type { CliPatches } from './types';

/* 見るだけのタスク: 打った aws のうち、このロググループを読んで、この文字が出たもの */
const readLog = (c: TaskContext, group: string, text: string) =>
  ['logs tail', 'logs filter-log-events', 'logs get-log-events'].some((cmd) => !!ranAws(c, cmd, (x) => (param(x, 'group-name') || param(x, 'log-group-name')) === group && x.output.includes(text)));

/* ---------------- Lesson 32: ECS ---------------- */
const svc = (env: AwsEnv) => env.ecsServices.find((s) => s.serviceName === 'webapp-svc');
const imageOf = (env: AwsEnv, arn: string) => env.taskDefinitions.find((d) => d.taskDefinitionArn === arn)?.containerDefinitions[0]?.image ?? '';
const tagOf = (image: string) => image.match(/:([^:/]+)$/)?.[1];
const serviceTag = (env: AwsEnv) => {
  const s = svc(env);
  return s ? tagOf(imageOf(env, s.taskDefinition)) : undefined;
};
const revisionWith = (env: AwsEnv, tag: string) => env.taskDefinitions.filter((d) => d.family === 'webapp' && tagOf(d.containerDefinitions[0].image) === tag).sort((a, b) => b.revision - a.revision)[0]?.revision;
const albDns = (env: AwsEnv) => lbNamed(env, 'web-alb')?.dnsName ?? '<web-alb の DNS 名>';
const alb = (c: TaskContext) => lastRequestTo(c, lbNamed(c.env, 'web-alb')?.dnsName);
const failed = (env: AwsEnv) => env.ecsTasks.filter((t) => t.stopCode === 'TaskFailedToStart');
const sawStopped = (c: TaskContext) => !!ranAws(c, 'ecs describe-tasks', (x) => failed(c.env).some((t) => param(x, 'tasks').includes(taskId(t))));
const watched = (c: TaskContext) => !!ranAws(c, 'ecs describe-services', (x) => x.output.includes('IN_PROGRESS'));

/** 先輩が webapp:1 から書き出しておいた、register-task-definition に渡せる JSON */
function webappTd(env: AwsEnv): string {
  const d = env.taskDefinitions.find((x) => x.family === 'webapp' && x.revision === 1);
  if (!d) return '';
  const td = { family: d.family, networkMode: d.networkMode, requiresCompatibilities: d.requiresCompatibilities, cpu: d.cpu, memory: d.memory, executionRoleArn: d.executionRoleArn, containerDefinitions: d.containerDefinitions };
  return JSON.stringify(td, null, 4) + '\n';
}

/* ---------------- Lesson 33: SQS + Lambda ---------------- */
const queue = (env: AwsEnv, name: string) => env.sqsQueues.find((q) => q.queueName === name);
const queueUrl = (env: AwsEnv, name: string) => queue(env, name)?.queueUrl ?? `<${name} の URL>`;
const orderIdOf = (body: string) => {
  try {
    return (JSON.parse(body) as { orderId?: unknown }).orderId;
  } catch {
    return undefined;
  }
};
const saved = (env: AwsEnv, id: number | string) => !!env.buckets.find((b) => b.name === ORDERS_BUCKET)?.objects.some((o) => o.key === `orders/${id}.json`);
const sent2001 = (env: AwsEnv) => saved(env, 2001) || !!queue(env, 'orders-queue')?.messages.some((m) => String(orderIdOf(m.body)) === '2001');
const sawLambdaLogs = (c: TaskContext) => readLog(c, '/aws/lambda/process-order', 'BUCKET is not set');
const fnLog = (env: AwsEnv, text: string) => !!env.logGroups.find((g) => g.logGroupName === '/aws/lambda/process-order')?.events?.some((e) => e.message.includes(text));
const poison = (env: AwsEnv) => queue(env, 'orders-dlq')?.messages.find((m) => orderIdOf(m.body) === undefined);

/* ---------------- Lesson 34: EventBridge + Batch ---------------- */
const failedJobs = (env: AwsEnv) => env.batchJobs.filter((j) => j.status === 'FAILED');
const sawFailedJob = (c: TaskContext) => !!ranAws(c, 'batch describe-jobs', (x) => failedJobs(c.env).some((j) => param(x, 'jobs').includes(j.jobId)));
const sawJobLog = (c: TaskContext) => readLog(c, '/aws/batch/job', 'AccessDenied');
const canWrite = (env: AwsEnv) => evaluateIamPermission(env, { principal: { type: 'role', roleName: 'report-job-role', sessionName: 'job' }, action: 's3:PutObject', resource: `arn:aws:s3:::${REPORTS_BUCKET}/reports/daily-2026-09-30.csv` }).decision === 'Allow';
const reportSaved = (env: AwsEnv) => !!env.buckets.find((b) => b.name === REPORTS_BUCKET)?.objects.some((o) => o.key.startsWith('reports/daily-'));
const learnerJob = (env: AwsEnv) => env.batchJobs.find((j) => j.submittedBy === 'learner' && j.status === 'SUCCEEDED');
const testRule = (env: AwsEnv) => env.eventRules.find((r) => r.name !== 'daily-report-schedule' && /^rate\(1 minute\)$/.test(r.scheduleExpression));
const ruleJob = (env: AwsEnv) => {
  const r = testRule(env);
  return r && env.batchJobs.find((j) => j.submittedBy === `EventBridge (${r.name})` && j.status === 'SUCCEEDED');
};
const reportQueueArn = (env: AwsEnv) => env.jobQueues.find((q) => q.jobQueueName === 'report-queue')?.jobQueueArn ?? '<report-queue の ARN>';
const POLICY = `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"arn:aws:s3:::${REPORTS_BUCKET}/reports/*"}]}`;

const patches: CliPatches = {
  'ecs-fargate': {
    summary: 'タスク定義の新しいリビジョンを CLI で登録してローリングデプロイし、起動しないタスクの停止理由を読む',
    files: (env) => ({ 'webapp-td.json': webappTd(env) }),
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、大変です！ `aws ec2 describe-instances` で見たら、web-1 と web-2 の `State` が `terminated` (終了済み) になってます！ まさか誰かが…'),
          hakase('落ち着きたまえ。消えたのではない、引っ越したのだ。Web アプリは今、**コンテナ** で動いておる。'),
          node('こんてな？ 港に積んである、あの鉄の箱ですか？'),
          hakase('名前の由来はまさにそれだ。荷物を決まった形の箱に詰めれば、どの船でもトラックでも同じように運べる。アプリも、動かすのに要るライブラリや設定ごと 1 つの箱に詰めて、どこでも同じように動かすのだ。'),
          node('EC2 と何が違うんですか？ EC2 も仮想サーバーでしたよね。'),
          hakase('EC2 は OS まで含めた丸ごと 1 台のサーバーだ。コンテナは土台のサーバーの OS を借りて、アプリの部屋だけを持ち運ぶ。軽いから数秒で起動するし、1 台の上にいくつも並べられる。'),
          node('EC2 が一軒家で、コンテナはアパートの一部屋ってことですね。'),
          hakase('うむ、悪くない。少なくとも君の部屋よりは片付いておる。'),
        ],
      },
      4: [
        {
          type: 'dialogue',
          lines: [
            node('そのタスクは、結局どのサーバーの上で動いてるんですか？'),
            hakase('それが **Fargate** だ。土台のサーバーは AWS が用意して、ワシらはタスクに割り当てた CPU とメモリと、動いた時間の分だけ払う。OS のパッチ当ても台数の管理もせんでよい。'),
            node('アパートどころか、大家さんも管理人も AWS なんですね。'),
            hakase('家賃は会社持ちだがな。君の給料と同じ財布から出ておる。'),
            node('急に生々しい。'),
            hakase('Fargate では、タスクごとに **ENI (Elastic Network Interface)**、つまり仮想のネットワークカードが付いて、VPC のプライベート IP アドレスを 1 つもらう。'),
            node('タスク 1 つが、EC2 1 台みたいに自分の IP アドレスを持つってことですね。'),
            hakase('そうだ。だからターゲットグループの **ターゲットタイプ** は「IP」になっておる。Lesson 12 の表に出てきたな。'),
            node('インスタンスを登録するか、IP アドレスを登録するか、でしたよね。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            hakase('うむ。では今のサービスを CLI で見に行こう。`aws ecs describe-services --cluster webapp-cluster --services webapp-svc` だ。'),
            node('`--cluster` と `--services`…。クラスターの中のサービス、と住所みたいに指定するんですね。'),
            hakase('そうだ。返ってくる JSON の `desiredCount` が動かし続けたい数、`runningCount` が実行中の数、`taskDefinition` が使っているタスク定義だ。'),
            node('あれ、`desiredCount` って小文字で始まるんですか？ EC2 は `VpcId` みたいに大文字始まりだったのに。'),
            hakase('よく気づいた。ECS の API は、キー名が小文字で始まる **キャメルケース** なのだ。サービスごとに作ったチームが違うから、流儀も違う。`--query` で書くときに間違えやすいから気をつけたまえ。'),
            node('部署ごとに書類の書式が違う会社みたいですね。'),
            hakase('どこの会社の話かは聞かんでおこう。サイトがちゃんと動いておるかも確かめる。ブラウザの代わりは `curl` だ。'),
            node('Lesson 09 から使ってる、URL の中身を取ってきて表示するコマンドですね。開く先は web-alb の DNS 名ですか？'),
            hakase("うむ。`aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text` で取り出せる。`ALB=$(...)` で変数に入れておけば、`curl http://$ALB` で済む。"),
            node('手順書がだんだん呪文みたいになってきました。'),
            hakase('呪文は唱えた分だけ上達する。給料は唱えても上がらんがな。'),
          ],
        },
      ],
      5: {
        type: 'exercise',
        title: '今のサービスを見る',
        objective: '`aws ecs describe-services` で `webapp-svc` の実行中のタスクを確認し、`curl` で `web-alb` を開く',
        tasks: [
          {
            id: 'svc',
            title: '`aws ecs describe-services` で `webapp-svc` を見る',
            hint: '`--cluster webapp-cluster --services webapp-svc` を付けます。`runningCount` が実行中のタスクの数です。',
            command: 'aws ecs describe-services --cluster webapp-cluster --services webapp-svc',
            done: (c) => !!ranAws(c, 'ecs describe-services', (x) => param(x, 'services').includes('webapp-svc')),
          },
          {
            id: 'alb',
            title: '`curl` で `web-alb` の DNS 名を開く',
            hint: "DNS 名は `aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text` で取り出せます。`ALB=$(...)` で変数に入れて、`curl http://$ALB` と打ちます。",
            command: "ALB=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text); curl http://$ALB",
            done: (c) => alb(c)?.status === 200,
          },
        ],
        validate: (c) =>
          alb(c)?.status === 200 && alb(c)!.body.includes('webapp v1') && ranAws(c, 'ecs describe-services')
            ? ok(
                node('`curl` で「webapp v1」が返ってきました。`describe-services` の `runningCount` は 2、タスクが 2 つ実行中です。'),
                hakase('ターゲットグループの登録済みターゲットも覗いてみたまえ。`aws elbv2 describe-target-health` の `Target.Id` には、EC2 のインスタンス ID ではなく **タスクの IP アドレス** が並んでおる。'),
                node('インスタンスがいないのに、ALB はちゃんとタスクに届けてるんですね。'),
                hakase('ALB から見れば、相手が EC2 でもタスクでも「この IP のこのポート」に投げるだけだ。相手の正体など気にせん。'),
              )
            : ng(hakase('まだ確かめ終わっておらん。`aws ecs describe-services --cluster webapp-cluster --services webapp-svc` でサービスを見て、web-alb の DNS 名を `curl` で開くのだ。DNS 名は `aws elbv2 describe-load-balancers --names web-alb` の `DNSName` だ。')),
      },
      6: [
        {
          type: 'dialogue',
          lines: [
            node('開発チームから「v2 をリリースしたので、ECR のイメージ `webapp:v2` に切り替えてください」と連絡が来ました！'),
            hakase('ではデプロイだ。**デプロイ** とは、新しい版を配って動かすことだ。'),
            node('タスク定義は上書きできないんでしたよね。どうするんですか？'),
            hakase('よく覚えておった。だから `webapp:1` と同じ中身で、**イメージ URI** の末尾のタグだけを `:v2` に変えたものを、新しいリビジョンとして登録する。'),
            node('いめーじゆーあーるあい？'),
            hakase('イメージの住所だ。`123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/webapp:v1` のように、どの ECR の・どのリポジトリの・どのタグかを 1 行で書く。コロンの後ろがタグだ。'),
            node('冷凍庫の住所と棚と、弁当のラベルですね。'),
            hakase('弁当から離れんか。ホームに `webapp-td.json` があるだろう。先輩が `webapp:1` の中身を JSON に書き出しておいたものだ。`cat webapp-td.json` で見てみたまえ。'),
            node('`"image"` の行の最後が `webapp:v1"` ですね。でもこのターミナル、エディタが無いですよ？'),
            hakase("`sed -i 's/前/後/' ファイル` を使う。ファイルの中の「前」の文字を「後」に置き換えるコマンドだ。`sed -i 's/webapp:v1\"/webapp:v2\"/' webapp-td.json` なら、タグだけが変わる。"),
            node('書き換えたファイルを、AWS に渡すんですね。'),
            hakase('`aws ecs register-task-definition --cli-input-json file://webapp-td.json` だ。`--cli-input-json` は、オプションを 1 つの JSON にまとめて丸ごと渡すオプションだ。Lesson 21 の `file://` と同じで、ファイルの中身を読んでくれる。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            node('登録したら、それでデプロイされるんですか？'),
            hakase('いや、まだ棚に注文票を足しただけだ。応答の `revision` が新しいリビジョンの番号だから、`aws ecs update-service --cluster webapp-cluster --service webapp-svc --task-definition webapp:<番号>` で、サービスをそのリビジョンに切り替える。'),
            hakase('すると ECS は **ローリングアップデート** を始める。'),
            node('ろーりんぐ？ 転がすんですか？'),
            hakase('少しずつ入れ替えるのだ。新しいタスクを起動して、ヘルスチェックに合格してから古いタスクを止める。全部を一度に止めんから、お客さんは入れ替わりに気付かん。'),
            node('ヘルスチェックって、Lesson 13 でやった「生きてるか」を ALB が定期的に確かめるやつでしたよね。'),
            hakase('そうだ。合格しない新人は、先輩と交代させてもらえんわけだ。'),
            node('会社みたいですね。'),
            hakase('会社はもっと厳しいぞ。合格しなくても現場に放り込まれる。'),
            hakase("切り替えたら、デプロイの様子を見る。`describe-services` の `deployments` に新旧のデプロイが並ぶから、`--query 'services[0].deployments'` でそこだけ抜き出すとよい。"),
          ],
        },
      ],
      7: {
        type: 'exercise',
        title: 'v2 をデプロイする',
        objective: '`webapp-td.json` のイメージのタグを `:v2` に書き換えて新しいリビジョンを登録し、`webapp-svc` をそのリビジョンに更新して、デプロイの様子を見る',
        tasks: [
          {
            id: 'rev',
            title: '`webapp-td.json` のタグを `:v2` にして、`register-task-definition` で登録する',
            hint: "`sed -i 's/webapp:v1\"/webapp:v2\"/' webapp-td.json` で書き換え、`cat webapp-td.json` で確かめてから `aws ecs register-task-definition --cli-input-json file://webapp-td.json` を打ちます。応答の `revision` が新しいリビジョンの番号です。",
            command: "sed -i 's/webapp:v1\"/webapp:v2\"/' webapp-td.json; aws ecs register-task-definition --cli-input-json file://webapp-td.json",
            done: (c) => c.env.taskDefinitions.some((d) => tagOf(d.containerDefinitions[0].image) === 'v2'),
          },
          {
            id: 'update',
            title: '`update-service` で `webapp-svc` を新しいリビジョンに切り替える',
            hint: '`aws ecs update-service --cluster webapp-cluster --service webapp-svc --task-definition webapp:<リビジョン>`。応答はサービスの JSON 全部で長いので、`--query service.taskDefinition` を付けると切り替え先だけが出ます。',
            command: (c) => `aws ecs update-service --cluster webapp-cluster --service webapp-svc --task-definition webapp:${revisionWith(c.env, 'v2') ?? '<リビジョン>'} --query service.taskDefinition`,
            done: (c) => serviceTag(c.env) === 'v2',
          },
          {
            id: 'watch',
            title: '`describe-services` の `deployments` でデプロイの様子を見る',
            hint: "`aws ecs describe-services --cluster webapp-cluster --services webapp-svc --query 'services[0].deployments'`。`rolloutState` と `failedTasks` に注目します。",
            command: "aws ecs describe-services --cluster webapp-cluster --services webapp-svc --query 'services[0].deployments'",
            done: watched,
          },
        ],
        validate: (c) => {
          if (!c.env.taskDefinitions.some((d) => tagOf(d.containerDefinitions[0].image) === 'v2'))
            return ng(hakase('まだ `:v2` のタスク定義が無い。`cat webapp-td.json` で `image` の行を確かめ、`sed -i` でタグを書き換えてから `aws ecs register-task-definition --cli-input-json file://webapp-td.json` で登録するのだ。'));
          if (serviceTag(c.env) !== 'v2') return ng(hakase('サービスはまだ `:v2` のリビジョンを使っておらん。`aws ecs update-service --cluster webapp-cluster --service webapp-svc --task-definition webapp:<リビジョン>` で切り替えるのだ。リビジョンの番号は、登録したときの応答の `revision` だ。'));
          if (!watched(c)) return ng(hakase("切り替えたら、終わるまで見届けるのだ。`aws ecs describe-services --cluster webapp-cluster --services webapp-svc --query 'services[0].deployments'` でデプロイの様子を見たまえ。"));
          return ok(
            hakase('サービスが `:v2` のリビジョンに切り替わった。デプロイが始まったぞ。'),
            node('`deployments` に 2 つ並んでますね。新しいほうが `PRIMARY` で `IN_PROGRESS`、古いほうが `ACTIVE`。あとは待つだけですね。コーヒー淹れてきます。'),
            hakase('待ちたまえ。デプロイは始めるより、終わるのを見届けるほうが大事だ。新しいデプロイの `runningCount` と `failedTasks` を見るのだ。`failedTasks` が増えておったら、新しいタスクが起動に失敗しておる。'),
            hakase('起動に失敗して止まったタスクには **停止理由** (`stoppedReason`) が残る。おかしいと思ったら、まずそこを読むのだぞ。'),
          );
        },
      },
      8: {
        type: 'exercise',
        title: 'デプロイが終わらない理由を調べる',
        objective: '停止したタスクを探し、**停止理由** (`stoppedReason`) を確認する',
        tasks: [
          {
            id: 'list',
            title: '`aws ecs list-tasks` で停止したタスクを探す',
            hint: '`aws ecs list-tasks --cluster webapp-cluster --service-name webapp-svc --desired-status STOPPED`。`--desired-status` を付けないと、動いているタスクだけが出ます。空なら、少し待ってからもう一度打ちます。',
            command: 'aws ecs list-tasks --cluster webapp-cluster --service-name webapp-svc --desired-status STOPPED',
            done: (c) => !!ranAws(c, 'ecs list-tasks', (x) => param(x, 'desired-status') === 'STOPPED' && failed(c.env).some((t) => x.output.includes(taskId(t)))),
          },
          {
            id: 'stopped',
            title: '`aws ecs describe-tasks` で停止したタスクの `stoppedReason` を読む',
            hint: "`aws ecs describe-tasks --cluster webapp-cluster --tasks <タスク ID>`。タスク ID は ARN の最後の `/` の後ろです (ARN のままでも構いません)。`--query 'tasks[0].stoppedReason'` で停止理由だけを出せます。",
            command: (c) => `aws ecs describe-tasks --cluster webapp-cluster --tasks ${failed(c.env)[0] ? taskId(failed(c.env)[0]) : '<タスク ID>'} --query 'tasks[0].[stopCode,stoppedReason]'`,
            done: sawStopped,
          },
        ],
        validate: (c) =>
          sawStopped(c)
            ? ok(
                node('`CannotPullContainerError: … webapp:v2: not found` です！ いめーじが、ぷるできない？'),
                hakase('pull とは、イメージを倉庫から取ってくることだ。ECR に `v2` というタグのイメージがないから、取ってこられんのだ。'),
                node('冷凍庫に「v2」のラベルの弁当がない、と。…ってことは、サイトは止まってるんじゃ！？'),
                hakase('`curl` で開いてみたまえ。v1 が返ってくるはずだ。新しいタスクが正常にならない限り、古いタスクは止めない。だから **サービスは止まっておらん**。'),
                node('ローリングアップデートのおかげで、失敗してもお客さんにはバレないんですね。'),
              )
            : ng(hakase('停止理由はまだ読めておらん。`aws ecs list-tasks --cluster webapp-cluster --service-name webapp-svc --desired-status STOPPED` で止まったタスクを探し、その ID を `aws ecs describe-tasks --cluster webapp-cluster --tasks <ID>` に渡すのだ。')),
      },
      9: {
        type: 'exercise',
        title: '正しいタグでデプロイし直す',
        objective: 'ECR の `webapp` リポジトリで v2 の本当のタグを確かめ、そのタグで新しいリビジョンを登録してサービスを更新する。`aws ecs wait services-stable` でデプロイの完了を待ち、`curl` で確認する',
        tasks: [
          {
            id: 'ecr',
            title: '`aws ecr describe-images` で `webapp` リポジトリのイメージタグを確認',
            hint: "`aws ecr describe-images --repository-name webapp`。`imageTags` を、さっき指定した `v2` と一字ずつ比べます。`--query 'imageDetails[].imageTags'` でタグだけを出せます。",
            command: "aws ecr describe-images --repository-name webapp --query 'imageDetails[].imageTags'",
            done: (c) => ['ecr describe-images', 'ecr list-images'].some((cmd) => !!ranAws(c, cmd, (x) => param(x, 'repository-name') === 'webapp')),
          },
          {
            id: 'rev',
            title: '正しいタグで新しいリビジョンを登録する',
            hint: "`sed -i` で `webapp-td.json` のタグを ECR にあるものに直し (例: `sed -i 's/webapp:v2\"/webapp:<正しいタグ>\"/' webapp-td.json`)、`register-task-definition` でもう一度登録します。",
            command: "sed -i 's/webapp:v2\"/webapp:v2.0\"/' webapp-td.json; aws ecs register-task-definition --cli-input-json file://webapp-td.json --query taskDefinition.taskDefinitionArn",
            done: (c) => c.env.taskDefinitions.some((d) => tagOf(d.containerDefinitions[0].image) === 'v2.0'),
          },
          {
            id: 'deploy',
            title: '`update-service` で、そのリビジョンに切り替える',
            hint: '`aws ecs update-service --cluster webapp-cluster --service webapp-svc --task-definition webapp:<リビジョン>`。リビジョンは、いま登録した応答の ARN の最後の番号です。',
            command: (c) => `aws ecs update-service --cluster webapp-cluster --service webapp-svc --task-definition webapp:${revisionWith(c.env, 'v2.0') ?? '<リビジョン>'} --query service.taskDefinition`,
            done: (c) => serviceTag(c.env) === 'v2.0',
          },
          {
            id: 'done',
            title: '`aws ecs wait services-stable` でデプロイの完了を待ち、`curl` で新しい版を確かめる',
            hint: '`aws ecs wait services-stable --cluster webapp-cluster --services webapp-svc` は、デプロイが終わってタスクの数がそろうまで待ってから戻ってきます。そのあと `curl http://$ALB` を打ちます。',
            command: (c) => `aws ecs wait services-stable --cluster webapp-cluster --services webapp-svc; curl http://${albDns(c.env)}`,
            done: (c) => serviceTag(c.env) === 'v2.0' && svc(c.env)?.deployments[0].rolloutState === 'COMPLETED' && !!alb(c)?.body.includes('webapp v2.0'),
          },
        ],
        validate: (c) => {
          const s = svc(c.env);
          if (serviceTag(c.env) !== 'v2.0') return ng(hakase('サービスはまだ本当のタグのリビジョンになっておらん。`aws ecr describe-images --repository-name webapp` でタグを見て、`webapp-td.json` のタグを `sed -i` で直してから登録し、`update-service` で切り替えるのだ。'));
          if (s?.deployments[0].rolloutState !== 'COMPLETED' || runningCount(c.env, s) !== 2 || serviceTasks(c.env, s).some((t) => t.desiredStatus === 'RUNNING' && t.taskDefinitionArn !== s.taskDefinition))
            return ng(hakase('まだデプロイ中だ。`aws ecs wait services-stable --cluster webapp-cluster --services webapp-svc` で、タスクが 2 つとも新しいリビジョンに入れ替わるまで待つのだ。'), node('待つのも仕事、ですね。'));
          if (!alb(c)?.body.includes('webapp v2.0')) return ng(hakase('デプロイは終わっておる。あとは `curl` で web-alb の DNS 名を開き直して、「webapp v2.0」が返るか確かめるのだ。'));
          return ok(
            node('タグは `v2` じゃなくて `v2.0` でした。`wait` が戻ってきて、`curl` でも「webapp v2.0」です！'),
            hakase('開発チームが口で言う「v2」と、ECR に貼ったラベルの `v2.0` が違っておったのだ。タグは人が付ける名前だから、こういう間違いは起きる。'),
            node('確実にする方法はないんですか？'),
            hakase('デプロイの前に `aws ecr describe-images` でタグを確かめるか、**ダイジェスト** (`sha256:…`) で指定することだ。`imageDigest` に出ておるのがそれで、イメージの中身から計算した指紋のようなものだ。中身が 1 ビットでも違えば変わる。'),
            node('ラベルじゃなくて、弁当の DNA で注文するんですね。'),
          );
        },
      },
    },
  },

  'sqs-lambda': {
    summary: 'キューとデッドレターキューで、失敗した注文を失わずに CLI で再処理する',
    steps: {
      4: [
        {
          type: 'dialogue',
          lines: [
            node('で、まず何をすればいいですか？'),
            hakase('今も失敗し続けているかを確かめる。自分で注文を 1 件、`orders-queue` に送ってみるのだ。'),
            node('どうやって送るんですか？'),
            hakase('`aws sqs send-message` だ。送り先は名前ではなく **キューの URL** で指定する。`aws sqs get-queue-url --queue-name orders-queue` で引けるから、`QUEUE_URL=$(...)` で変数に入れておくとよい。'),
            node('キューにも住所があるんですね。'),
            hakase('本文は `--message-body` に書く。中身は `{"orderId": 2001, "amount": 1200}` だ。'),
            node('Lesson 21 のバケットポリシーと同じ、波かっこの書き方ですね。'),
            hakase("**JSON** だ。「\"項目名\": 値」を並べたデータの書き方だな。中に `\"` や空白があるから、全体を `'` で囲んでシェルから守るのを忘れるな。"),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            hakase('送ったら、関数 `process-order` のログを見る。関数の `console.log` やエラーは CloudWatch Logs に届く。'),
            node('CloudWatch Logs は Lesson 25 で、スロークエリログを探したところですね。'),
            hakase('うむ。Lambda の記録はロググループ `/aws/lambda/process-order` に入り、その中に実行環境ごとの **ログストリーム** ができる。'),
            node('ストリームが何本もあったら、どれを読めばいいんですか？'),
            hakase('`aws logs tail /aws/lambda/process-order --since 6h` なら、全部のストリームをまとめて時刻の順に並べてくれる。`--since 6h` は「6 時間前から」で、一番下が一番新しいログだ。'),
            node('犯人の足跡は、新しいものから辿る。下から読めばいいんですね。'),
            hakase('刑事ドラマの見すぎだ。'),
          ],
        },
      ],
      5: {
        type: 'exercise',
        title: '注文を 1 件送ってみる',
        objective: '`orders-queue` に `{"orderId": 2001, "amount": 1200}` を送信し、Lambda 関数 `process-order` のログを確認する',
        tasks: [
          {
            id: 'url',
            title: '`aws sqs get-queue-url` で `orders-queue` の URL を調べる',
            hint: '`QUEUE_URL=$(aws sqs get-queue-url --queue-name orders-queue --query QueueUrl --output text)` で変数に入れておくと、この先が楽です。',
            command: 'QUEUE_URL=$(aws sqs get-queue-url --queue-name orders-queue --query QueueUrl --output text); echo $QUEUE_URL',
            done: (c) => !!ranAws(c, 'sqs get-queue-url', (x) => param(x, 'queue-name') === 'orders-queue'),
          },
          {
            id: 'send',
            title: '`aws sqs send-message` で注文 2001 を送信する',
            hint: "`aws sqs send-message --queue-url $QUEUE_URL --message-body '{\"orderId\": 2001, \"amount\": 1200}'`。応答に `MessageId` が返れば送れています。",
            command: (c) => `aws sqs send-message --queue-url ${queueUrl(c.env, 'orders-queue')} --message-body '{"orderId": 2001, "amount": 1200}'`,
            done: (c) => sent2001(c.env),
          },
          {
            id: 'logs',
            title: '`aws logs tail` で `process-order` のログを見る',
            hint: '`aws logs tail /aws/lambda/process-order --since 6h`。`ERROR` の行に失敗の原因が書かれています。',
            command: 'aws logs tail /aws/lambda/process-order --since 6h',
            done: sawLambdaLogs,
          },
        ],
        validate: (c) =>
          sent2001(c.env) && sawLambdaLogs(c)
            ? ok(
                node('`Error: BUCKET is not set` … 5 時間前から、全部このエラーです！'),
                hakase('コードは `process.env.BUCKET` を読んでおる。これは **環境変数** だ。関数の外から渡す設定値で、コードを書き換えずに保存先のバケット名などを変えられる。'),
                node('その環境変数が、空っぽになってるってことですか？'),
                hakase('5 時間前のデプロイで `BUCKET` が消えてしまったのだ。保存先を知らん厨房は、料理を作っても盛る皿がない。`aws lambda get-function-configuration` の `Environment` で確かめてから、`aws lambda update-function-configuration` で足すのだ。'),
                hakase('1 つ注意だ。`--environment` は環境変数を **丸ごと置き換える**。ほかに変数があれば、それも全部書かんと消えるぞ。今回は `BUCKET` だけだがな。'),
              )
            : ng(hakase('まだ材料が揃っておらん。`aws sqs send-message` で orders-queue に注文を送り、`aws logs tail /aws/lambda/process-order --since 6h` でログを読むのだ。キューの URL は `aws sqs get-queue-url --queue-name orders-queue` で引ける。')),
      },
      6: {
        type: 'exercise',
        title: '環境変数を直す',
        objective: `\`process-order\` の環境変数に \`BUCKET\` = \`${ORDERS_BUCKET}\` を設定する。可視性タイムアウトの後、注文 2001 が保存されることを確認する`,
        tasks: [
          {
            id: 'check',
            title: '`aws lambda get-function-configuration` で今の環境変数を見る',
            hint: '`aws lambda get-function-configuration --function-name process-order --query Environment`。`Variables` の中身を見ます。',
            command: 'aws lambda get-function-configuration --function-name process-order --query Environment',
            done: (c) => ['lambda get-function-configuration', 'lambda get-function'].some((cmd) => !!ranAws(c, cmd, (x) => param(x, 'function-name').endsWith('process-order'))),
          },
          {
            id: 'env',
            title: '`aws lambda update-function-configuration` で `BUCKET` を設定する',
            hint: `\`aws lambda update-function-configuration --function-name process-order --environment 'Variables={BUCKET=${ORDERS_BUCKET}}'\`。キーは大文字の \`BUCKET\` です。\`Variables={キー=値}\` は Lesson 03 の shorthand 構文です。`,
            command: `aws lambda update-function-configuration --function-name process-order --environment 'Variables={BUCKET=${ORDERS_BUCKET}}' --query Environment`,
            done: (c) => c.env.lambdaFunctions[0]?.environment.BUCKET === ORDERS_BUCKET,
          },
          {
            id: 'saved',
            title: `S3 の \`${ORDERS_BUCKET}\` に \`orders/2001.json\` ができる`,
            hint: '失敗したメッセージは 10 秒後にもう一度受信されます。`sleep 15` (15 秒待つだけのコマンド) のあと、`aws logs tail /aws/lambda/process-order --since 1m` で `saved to` の行を探します。',
            command: 'sleep 15; aws logs tail /aws/lambda/process-order --since 1m',
            done: (c) => saved(c.env, 2001),
          },
        ],
        validate: (c) =>
          saved(c.env, 2001)
            ? ok(
                node('`order 2001 saved to s3://…` が出ました！ 送り直してないのに、勝手にもう一度処理されたんですね。'),
                hakase('失敗したメッセージは消されずにキューに残り、可視性タイムアウトの 10 秒後にまた受信されたのだ。これがキューを挟む強みだ。'),
                node('じゃあ、問い合わせの 3 件も今ごろ保存されてますね！'),
                hakase('甘い。あの 3 件は 5 時間前に 3 回失敗して、とっくに DLQ に移っておる。DLQ のメッセージを元のキューに戻すのが **DLQ 再処理** で、CLI では `aws sqs start-message-move-task` だ。原因は直したから、今なら戻してよい。'),
                hakase('戻すときは DLQ を **ARN** で指定する。`aws sqs get-queue-attributes --queue-url <orders-dlq の URL> --attribute-names ApproximateNumberOfMessages QueueArn` で、たまった数と ARN を一緒に見られるぞ。'),
              )
            : ng(hakase('まだ orders/2001.json がない。`aws lambda get-function-configuration --function-name process-order --query Environment` で、`BUCKET` が正しい綴りと値で入っているか確かめるのだ。入っておれば、`sleep 15` で待ってからログを見るのだ。')),
      },
      7: {
        type: 'exercise',
        title: 'DLQ の注文を再処理する',
        objective: '`orders-dlq` にたまった 3 件の注文を `aws sqs start-message-move-task` で `orders-queue` に戻し、すべて保存されることを確認する',
        tasks: [
          {
            id: 'count',
            title: '`aws sqs get-queue-attributes` で `orders-dlq` のメッセージの数と ARN を見る',
            hint: '`aws sqs get-queue-attributes --queue-url <orders-dlq の URL> --attribute-names ApproximateNumberOfMessages QueueArn`。URL は `aws sqs get-queue-url --queue-name orders-dlq` で引けます。',
            command: (c) => `aws sqs get-queue-attributes --queue-url ${queueUrl(c.env, 'orders-dlq')} --attribute-names ApproximateNumberOfMessages QueueArn`,
            done: (c) => !!ranAws(c, 'sqs get-queue-attributes', (x) => param(x, 'queue-url').endsWith('/orders-dlq')),
          },
          {
            id: 'redrive',
            title: '`aws sqs start-message-move-task` で DLQ のメッセージを元のキューに戻す',
            hint: '`aws sqs start-message-move-task --source-arn <orders-dlq の ARN>`。戻す先 (`--destination-arn`) を省くと、元のキュー (`orders-queue`) に戻ります。',
            command: (c) => `aws sqs start-message-move-task --source-arn ${queue(c.env, 'orders-dlq')?.queueArn ?? '<orders-dlq の ARN>'}`,
            done: (c) => (queue(c.env, 'orders-dlq')?.messages.filter((m) => orderIdOf(m.body) !== undefined).length ?? 1) === 0,
          },
          {
            id: 'saved',
            title: '注文 1001 / 1002 / 1003 が S3 に保存される',
            hint: '戻したメッセージは Lambda トリガーが順に処理します。`sleep 5` のあと、`aws logs tail /aws/lambda/process-order --since 1m` で `saved to` の行を確かめます。',
            command: 'sleep 5; aws logs tail /aws/lambda/process-order --since 1m',
            done: (c) => [1001, 1002, 1003].every((id) => saved(c.env, id)),
          },
        ],
        validate: (c) =>
          [1001, 1002, 1003].every((id) => saved(c.env, id))
            ? ok(
                node('3 件とも保存されました！ 1 件も失われていません。'),
                hakase('DLQ は「あとで直して流し直す」ための場所だ。順番は **原因を直してから再処理**。逆にすると、また 3 回失敗して DLQ に戻ってくるだけだ。'),
                node('厨房を直さずに食券を戻しても、また保留の箱行きですもんね。'),
                hakase('それを一晩じゅう繰り返して、Lambda の料金だけ積み上げた男をワシは知っておる。名前は言わんが、今は別の部署におる。'),
              )
            : ng(hakase('まだ保存されていない注文がある。`aws sqs start-message-move-task --source-arn <orders-dlq の ARN>` で戻し、少し待つのだ。ARN は `get-queue-attributes` の `QueueArn` だ。')),
      },
      8: {
        type: 'exercise',
        title: '壊れたメッセージを送ると？',
        objective: '`orders-queue` に、JSON として壊れた本文 `{"orderId": 3001,` を送信し、どこに行き着くかを観察する',
        tasks: [
          {
            id: 'send',
            title: '壊れた本文を送信',
            hint: "`aws sqs send-message --queue-url $QUEUE_URL --message-body '{\"orderId\": 3001,'`。閉じかっこは付けません。",
            command: (c) => `aws sqs send-message --queue-url ${queueUrl(c.env, 'orders-queue')} --message-body '{"orderId": 3001,'`,
            done: (c) => !!queue(c.env, 'orders-queue')?.messages.some((m) => m.body.startsWith('{"orderId": 3001')) || !!poison(c.env),
          },
          {
            id: 'dlq',
            title: '約 30 秒後、`orders-dlq` に移ったことを確かめる',
            hint: '10 秒 × 3 回失敗すると、4 回目の受信で DLQ に移ります。`sleep 40` で待ってから、`aws sqs receive-message --queue-url <orders-dlq の URL> --attribute-names ApproximateReceiveCount` で中身を見ます。',
            command: (c) => `sleep 40; aws sqs receive-message --queue-url ${queueUrl(c.env, 'orders-dlq')} --attribute-names ApproximateReceiveCount`,
            done: (c) => !!poison(c.env),
          },
        ],
        validate: (c) =>
          poison(c.env) && fnLog(c.env, 'SyntaxError')
            ? ok(
                node('`Body` が `{"orderId": 3001,` のメッセージが DLQ にいました。ログにも SyntaxError が 3 回出て、4 回目の受信で DLQ に移ったんですね。ほかの注文は普通に処理されてます。'),
                hakase('何度やっても成功しないメッセージを **ポイズンメッセージ** (毒入りメッセージ) という。DLQ がそれを隔離してくれた。'),
                node('DLQ がなかったら、どうなってたんですか？'),
                hakase('毒入りの食券が、台と厨房を延々と往復し続ける。メッセージの保持期間が切れて消えるまで、Lambda の料金を払いながらな。'),
              )
            : ng(hakase('まだ DLQ に移っておらん。orders-queue に壊れた本文 `{"orderId": 3001,` を送ったら、可視性タイムアウト 10 秒 × 3 回ぶん待つのだ。`sleep 40` のあと、`aws sqs get-queue-attributes` か `aws sqs receive-message` で orders-dlq を見るのだ。')),
      },
    },
  },

  'eventbridge-batch': {
    summary: '毎晩のレポートジョブが失敗する原因を CLI でジョブのログから突き止め、スケジュール実行を確かめる',
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          node('ジョブって、どうやって作るんですか？'),
          hakase('**ジョブ定義** に「どのイメージを・どのコマンドで・どの IAM ロールで」動かすかを書く。ECS のタスク定義と同じで、リビジョンで版が増える。`daily-report:1` の `:1` がそれだ。'),
          node('IAM ロールって、Lesson 22 で EC2 に付けた、アクセスキーの代わりに一時的な権限をくれるやつでしたよね。'),
          hakase('そうだ。ジョブの中のプログラムが S3 などを触るときに使うロールを **ジョブロール** という。今回は `report-job-role` だ。'),
          node('ジョブ定義を書いたら、すぐ動くんですか？'),
          hakase('いや、ジョブはまず **ジョブキュー** に並ぶ。キューは Lesson 33 でやった待ち行列だな。並んだジョブを **コンピューティング環境** が拾って、実際に動かす。'),
          node('こんぴゅーてぃんぐかんきょう？'),
          hakase('ジョブを動かす場所だ。EC2 の集まりにもできるが、今回は Fargate だ。注文票がジョブ定義、順番待ちの列がジョブキュー、厨房がコンピューティング環境、というわけだ。'),
          node('また厨房ですか。この会社、食べ物のたとえしかないんですか？'),
          hakase('君がすぐ腹を空かせるからだ。まずは、スケジュールが本当に動いているかを確かめよう。ルールの中身は `aws events describe-rule --name <ルール名>` で見られる。'),
          node('ターゲットも同じコマンドで出るんですか？'),
          hakase('出ん。ルールとターゲットは別々に登録するものでな、ターゲットは `aws events list-targets-by-rule --rule <ルール名>` で見るのだ。'),
        ],
      },
      4: {
        type: 'exercise',
        title: 'スケジュールを確かめる',
        objective: 'EventBridge のルール `daily-report-schedule` のスケジュール式と、ターゲットを確認する',
        tasks: [
          {
            id: 'rule',
            title: '`aws events describe-rule` で `daily-report-schedule` を見る',
            hint: '`aws events describe-rule --name daily-report-schedule`。`ScheduleExpression` が cron 式です。cron は UTC なので、日本時間に直して読みます。',
            command: 'aws events describe-rule --name daily-report-schedule',
            done: (c) => !!ranAws(c, 'events describe-rule', (x) => param(x, 'name') === 'daily-report-schedule'),
          },
          {
            id: 'targets',
            title: '`aws events list-targets-by-rule` でターゲットを見る',
            hint: '`aws events list-targets-by-rule --rule daily-report-schedule`。`Arn` が投げ先のジョブキュー、`BatchParameters` が使うジョブ定義とジョブ名です。',
            command: 'aws events list-targets-by-rule --rule daily-report-schedule',
            done: (c) => !!ranAws(c, 'events list-targets-by-rule', (x) => param(x, 'rule') === 'daily-report-schedule'),
          },
        ],
        validate: (c) =>
          ranAws(c, 'events describe-rule', (x) => param(x, 'name') === 'daily-report-schedule') && ranAws(c, 'events list-targets-by-rule', (x) => param(x, 'rule') === 'daily-report-schedule')
            ? ok(
                node('`"ScheduleExpression": "cron(0 17 * * ? *)"` … 17 時？ 夕方に動いてるんですか？'),
                hakase('言ったはずだ、cron は **UTC** だ。UTC の 17:00 に 9 時間足すと？'),
                node('26 時… あ、日本時間の翌日 2:00 ですね！ `Description` にも「毎日 02:00 (JST)」って書いてあります。'),
                hakase('うむ。スケジュールは正しく、`State` も `ENABLED`、ターゲットも `report-queue` を向いておる。ルールは毎晩ちゃんと動いておる。犯人は別におるのだ。'),
                hakase('次は Batch のジョブだ。`aws batch list-jobs --job-queue report-queue --job-status FAILED` で失敗したジョブを探すのだ。`--job-status` を付けんと、実行中 (`RUNNING`) のジョブしか出んから気をつけたまえ。'),
              )
            : ng(hakase('まだルールを見ておらん。`aws events describe-rule --name daily-report-schedule` でスケジュール式を、`aws events list-targets-by-rule --rule daily-report-schedule` でターゲットを読むのだ。')),
      },
      5: {
        type: 'exercise',
        title: '失敗したジョブを調べる',
        objective: 'AWS Batch で失敗した `daily-report` ジョブを探し、ジョブの詳細とログストリームで原因を確認する',
        tasks: [
          {
            id: 'list',
            title: '`aws batch list-jobs` でステータスが FAILED のジョブを探す',
            hint: '`aws batch list-jobs --job-queue report-queue --job-status FAILED`。`jobId` がジョブの ID です。',
            command: 'aws batch list-jobs --job-queue report-queue --job-status FAILED',
            done: (c) => !!ranAws(c, 'batch list-jobs', (x) => failedJobs(c.env).some((j) => x.output.includes(j.jobId))),
          },
          {
            id: 'job',
            title: '`aws batch describe-jobs` で失敗したジョブの詳細を見る',
            hint: '`aws batch describe-jobs --jobs <ジョブ ID>`。`statusReason` (ステータスの理由)、`container.exitCode` (終了コード)、`container.logStreamName` (ログストリーム名) を確かめます。',
            command: (c) => `aws batch describe-jobs --jobs ${failedJobs(c.env).at(-1)?.jobId ?? '<ジョブ ID>'}`,
            done: sawFailedJob,
          },
          {
            id: 'log',
            title: 'ジョブのログストリームのログを読む',
            hint: 'ロググループは `/aws/batch/job` です。`aws logs tail /aws/batch/job --since 3d --log-stream-names <ログストリーム名>` で、そのジョブのログだけを読めます。エラーの行で、どのロールがどの操作を断られたかを読み取ります。',
            command: (c) => `aws logs tail /aws/batch/job --since 3d --log-stream-names ${failedJobs(c.env).at(-1)?.logStreamName ?? '<ログストリーム名>'}`,
            done: sawJobLog,
          },
        ],
        validate: (c) =>
          sawFailedJob(c) && sawJobLog(c)
            ? ok(
                node('`AccessDenied … report-job-role … is not authorized to perform: s3:PutObject` です！'),
                hakase('Lesson 23 でさんざん見たエラーだな。誰が・何をしようとして断られたかを読むのだ。'),
                node('えっと、report-job-role が、S3 への `s3:PutObject`、つまりオブジェクトの書き込みを断られてます。'),
                hakase('ジョブロールには注文を読む権限はあるが、レポートを書く権限がないのだ。材料は取れるのに、皿に盛れん厨房だな。'),
                hakase('直すときは **最小権限** だ。必要な操作を、必要な場所にだけ許す。ロールに直接書き込む **インラインポリシー** を `aws iam put-role-policy` で足して、`reports/` の下への `s3:PutObject` だけを許可するのだ。ポリシーの JSON は、`echo \'...\' > report-put.json` でファイルに書いて渡せばよい。'),
              )
            : ng(hakase('まだ原因に辿り着いておらん。`aws batch list-jobs --job-queue report-queue --job-status FAILED` で失敗したジョブを探し、`aws batch describe-jobs --jobs <ID>` の `container.logStreamName` を見て、`aws logs tail /aws/batch/job --since 3d --log-stream-names <ログストリーム名>` でログを読むのだ。')),
      },
      6: {
        type: 'exercise',
        title: 'ジョブロールに書き込み権限を付ける',
        objective: `\`report-job-role\` に、\`arn:aws:s3:::${REPORTS_BUCKET}/reports/*\` への \`s3:PutObject\` を許可するインラインポリシーを \`aws iam put-role-policy\` で付ける`,
        tasks: [
          {
            id: 'iam',
            title: 'ポリシーの JSON をファイルに書き、`aws iam put-role-policy` で `report-job-role` に付ける',
            hint: `エディタが無いので、ポリシーの JSON は \`echo '...' > report-put.json\` でファイルに書き、\`cat report-put.json\` で確かめます。中身は Action が \`s3:PutObject\`、Resource が \`arn:aws:s3:::${REPORTS_BUCKET}/reports/*\` の Allow です (最小権限: バケット全体ではなく reports/ の下だけ)。付けるのは \`aws iam put-role-policy --role-name report-job-role --policy-name report-put --policy-document file://report-put.json\` です。`,
            command: `echo '${POLICY}' > report-put.json; aws iam put-role-policy --role-name report-job-role --policy-name report-put --policy-document file://report-put.json`,
            done: (c) => canWrite(c.env),
          },
        ],
        validate: (c) => {
          if (!canWrite(c.env)) return ng(hakase(`report-job-role はまだ reports/ に書き込めん。\`cat report-put.json\` で、Action が s3:PutObject、Resource が arn:aws:s3:::${REPORTS_BUCKET}/reports/* になっているか確かめて、\`aws iam put-role-policy --role-name report-job-role --policy-name report-put --policy-document file://report-put.json\` を打つのだ。`));
          const all = evaluateIamPermission(c.env, { principal: { type: 'role', roleName: 'report-job-role', sessionName: 'job' }, action: 's3:DeleteBucket', resource: `arn:aws:s3:::${REPORTS_BUCKET}` }).decision === 'Allow';
          return all
            ? ng(hakase('権限が広すぎる。s3:* などでは、バケットの削除までできてしまう。Action は s3:PutObject だけにして、同じ `--policy-name` で `put-role-policy` をもう一度打てば上書きできる。'), hakase('レポートを書かせたいだけの相手に、倉庫ごと燃やせるマッチまで渡す必要はない。'))
            : ok(
                hakase('よし、必要な権限だけを足せた。'),
                node('バケット全体じゃなくて `reports/` の下だけ、しかも書き込みだけ、ですね。'),
                hakase('うむ。万一ジョブが乗っ取られても、被害はレポートの置き場だけで済む。最小権限とは、事故の大きさを先に決めておくことなのだ。'),
                hakase('では、ジョブを手で投げ直す。`aws batch submit-job` に、ジョブ名 (自由に付けてよい)、ジョブキュー、ジョブ定義を渡すのだ。'),
              );
        },
      },
      7: {
        type: 'exercise',
        title: 'ジョブを再実行する',
        objective: '`aws batch submit-job` でジョブを送信 (ジョブ定義 `daily-report:1`、ジョブキュー `report-queue`) し、SUCCEEDED になることを確認する',
        tasks: [
          {
            id: 'submit',
            title: '`aws batch submit-job` でジョブを送る',
            hint: '`aws batch submit-job --job-name daily-report-rerun --job-queue report-queue --job-definition daily-report:1`。ジョブ名は自由です。応答の `jobId` を `JOB_ID=$(... --query jobId --output text)` で変数に入れておくと楽です。',
            command: 'JOB_ID=$(aws batch submit-job --job-name daily-report-rerun --job-queue report-queue --job-definition daily-report:1 --query jobId --output text); echo $JOB_ID',
            done: (c) => c.env.batchJobs.some((j) => j.submittedBy === 'learner'),
          },
          {
            id: 'ok',
            title: 'ステータスが **SUCCEEDED** になり、S3 にレポートができる',
            hint: "ステータスは数秒で RUNNING を経て SUCCEEDED になります。`sleep 10` で待ってから `aws batch describe-jobs --jobs $JOB_ID --query 'jobs[0].status'` を打ちます。FAILED になったら、`statusReason` とログでジョブロールの権限を見直します。",
            command: (c) => `sleep 10; aws batch describe-jobs --jobs ${c.env.batchJobs.filter((j) => j.submittedBy === 'learner').at(-1)?.jobId ?? '$JOB_ID'} --query 'jobs[0].[status,statusReason]'`,
            done: (c) => !!learnerJob(c.env) && reportSaved(c.env),
          },
        ],
        validate: (c) =>
          learnerJob(c.env) && reportSaved(c.env)
            ? ok(
                node('`SUCCEEDED` になりました！ レポートもできたはずです。'),
                hakase('今日の分はこれで取り戻せた。部長の顔色も、赤から黄色くらいには戻るだろう。'),
                node('緑にはならないんですか？'),
                hakase('2 日分の遅れは消えん。さて、手で投げたジョブは成功した。次は EventBridge から投げても動くかだ。1 分ごとに動くテスト用のルールを作って試す。'),
                hakase("ルールは `aws events put-rule --name <名前> --schedule-expression 'rate(1 minute)'`、ターゲットは `aws events put-targets` で別々に付ける。ジョブの名前はターゲットの `JobName` で決まるから、手で投げたジョブと見分けられる名前にしておくのだ。"),
              )
            : ng(hakase('まだ成功したジョブがない。`aws batch submit-job --job-name daily-report-rerun --job-queue report-queue --job-definition daily-report:1` で送り、`aws batch describe-jobs --jobs <ジョブ ID>` の `status` が SUCCEEDED になるまで待つのだ。')),
      },
      8: {
        type: 'exercise',
        title: 'スケジュールからの実行を確かめる',
        objective: '`rate(1 minute)` のテスト用ルールを作ってターゲットを付け、EventBridge からジョブが投入され成功することを確かめ、最後にそのルールを **無効** にする',
        tasks: [
          {
            id: 'create',
            title: '`aws events put-rule` でテスト用ルール (`rate(1 minute)`) を作る',
            hint: "`aws events put-rule --name report-test --schedule-expression 'rate(1 minute)'`。1 のときは minute (単数形) です。`(` があるので、式は `'` で囲みます。",
            command: "aws events put-rule --name report-test --schedule-expression 'rate(1 minute)'",
            done: (c) => !!testRule(c.env),
          },
          {
            id: 'target',
            title: '`aws events put-targets` で、ターゲットに `report-queue` と `daily-report:1` を付ける',
            hint: "`aws events put-targets --rule report-test --targets 'Id=1,Arn=<report-queue の ARN>,BatchParameters={JobDefinition=daily-report:1,JobName=report-test}'`。ジョブキューの ARN は `aws batch describe-job-queues --query 'jobQueues[0].jobQueueArn' --output text` で取り出せます。",
            command: (c) => `aws events put-targets --rule ${testRule(c.env)?.name ?? 'report-test'} --targets 'Id=1,Arn=${reportQueueArn(c.env)},BatchParameters={JobDefinition=daily-report:1,JobName=report-test}'`,
            done: (c) => !!testRule(c.env)?.targets.some((t) => t.arn === reportQueueArn(c.env)),
          },
          {
            id: 'job',
            title: '1 分ほどで、ルールが投げたジョブが SUCCEEDED になる',
            hint: 'ルールは 1 分ごとに動きます。`sleep 75` で待ってから `aws batch list-jobs --job-queue report-queue --filters name=JOB_NAME,values=report-test` を打ちます。`--filters` を付けると、ステータスに関係なく全部出ます。',
            command: 'sleep 75; aws batch list-jobs --job-queue report-queue --filters name=JOB_NAME,values=report-test',
            done: (c) => !!ruleJob(c.env),
          },
          {
            id: 'off',
            title: 'テスト用ルールを `aws events disable-rule` で **無効にする**',
            hint: '`aws events disable-rule --name report-test`。放っておくと 1 分ごとにジョブが動き続けます。',
            command: (c) => `aws events disable-rule --name ${testRule(c.env)?.name ?? 'report-test'}`,
            done: (c) => !!ruleJob(c.env) && testRule(c.env)?.state === 'DISABLED',
          },
        ],
        validate: (c) => {
          if (!ruleJob(c.env)) return ng(hakase("まだ EventBridge から投入されたジョブが成功していない。`put-rule` で `rate(1 minute)` のルールを作り、`put-targets` で `report-queue` / `daily-report:1` を付けたら、`sleep 75` のあと `aws batch list-jobs --job-queue report-queue --filters name=JOB_NAME,values=<ターゲットの JobName>` を見るのだ。"));
          if (testRule(c.env)?.state !== 'DISABLED') return ng(hakase('テスト用ルールがまだ有効だ。1 分ごとに料金のかかるジョブが動き続けるぞ。1 日で 1,440 回だ。`aws events disable-rule --name <ルール名>` で無効にするのだ。'));
          return ok(
            hakase('EventBridge → Batch の流れを確かめられた。ルールがジョブを投げ、ジョブがレポートを書く。'),
            node('これで今夜 2:00 のジョブも成功するはずですね。'),
            hakase('うむ。テスト用ルールを無効にしたのも偉い。消し忘れたテスト用ルールとは、たいてい月末の請求書で再会することになるからな。'),
          );
        },
      },
    },
  },
};

export default patches;
