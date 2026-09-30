import { hakase, ng, node, ok, type Lesson, type TaskContext } from '../lesson/types';
import { runningCount, serviceTasks } from '../sim/containers';
import { ecsEnv } from '../sim/scenarios';
import { taskId } from '../sim/targets';
import type { AwsEnv } from '../sim/types';
import { lastRequestTo, lbNamed, visited } from './helpers';

const svc = (env: AwsEnv) => env.ecsServices.find((s) => s.serviceName === 'webapp-svc');
const imageOf = (env: AwsEnv, arn: string) => env.taskDefinitions.find((d) => d.taskDefinitionArn === arn)?.containerDefinitions[0]?.image ?? '';
const tagOf = (image: string) => image.match(/:([^:/]+)$/)?.[1];
const serviceTag = (env: AwsEnv) => {
  const s = svc(env);
  return s ? tagOf(imageOf(env, s.taskDefinition)) : undefined;
};
const alb = (c: TaskContext) => lastRequestTo(c, lbNamed(c.env, 'web-alb')?.dnsName);
const failed = (env: AwsEnv) => env.ecsTasks.filter((t) => t.stopCode === 'TaskFailedToStart');

export const lesson32: Lesson = {
  id: 'ecs-fargate',
  number: '32',
  title: 'コンテナ: ECR と ECS (Fargate)',
  summary: 'タスク定義の新しいリビジョンでローリングデプロイし、起動しないタスクの停止理由を読む',
  minutes: 30,
  startPath: '/ecs/clusters',
  scenario: ecsEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、大変です！ EC2 の web-1 と web-2 が「終了済み」になってます！ まさか誰かが…'),
        hakase('落ち着きたまえ。消えたのではない、引っ越したのだ。Web アプリは今、**コンテナ** で動いておる。'),
        node('こんてな？ 港に積んである、あの鉄の箱ですか？'),
        hakase('名前の由来はまさにそれだ。荷物を決まった形の箱に詰めれば、どの船でもトラックでも同じように運べる。アプリも、動かすのに要るライブラリや設定ごと 1 つの箱に詰めて、どこでも同じように動かすのだ。'),
        node('EC2 と何が違うんですか？ EC2 も仮想サーバーでしたよね。'),
        hakase('EC2 は OS まで含めた丸ごと 1 台のサーバーだ。コンテナは土台のサーバーの OS を借りて、アプリの部屋だけを持ち運ぶ。軽いから数秒で起動するし、1 台の上にいくつも並べられる。'),
        node('EC2 が一軒家で、コンテナはアパートの一部屋ってことですね。'),
        hakase('うむ、悪くない。少なくとも君の部屋よりは片付いておる。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('じゃあ、その箱の中身はどこから来るんですか？'),
        hakase('箱の中身の「型」を **イメージ** という。Lesson 10 で EC2 を起動したとき、AMI を選んだのを覚えておるか。'),
        node('はい。サーバーの元になる、OS 入りのディスクの型…でしたよね。'),
        hakase('そうだ。コンテナの世界では、その役目をイメージがやる。イメージは **ECR (Elastic Container Registry)** に置いておく。'),
        node('いーしーあーる？ れじすとり？'),
        hakase('レジストリは登録所、つまりイメージの倉庫だ。中にアプリごとの **リポジトリ** (棚) があり、イメージには `v1` のような **タグ** を付けて版を区別する。'),
        node('冷凍庫の棚に、「webapp v1」ってラベルを貼った冷凍弁当が並んでる感じですね。'),
        hakase('腹が減っておるのか。まあよい、今日はそのたとえで行こう。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('で、その弁当を温めて出すのは誰なんですか？'),
        hakase('**ECS (Elastic Container Service)** だ。コンテナを起動し、決めた数を保ち、落ちたら入れ替える。Lesson 30 の Auto Scaling グループに近い係だ。'),
        node('Auto Scaling グループは、起動テンプレートを元に台数を保つんでしたよね。'),
        hakase('うむ。起動テンプレートに当たるのが **タスク定義** だ。「どのイメージを、CPU とメモリをどれだけ付けて、何番ポートで動かすか」の設計図だ。'),
        node('たすくていぎ。弁当の注文票ですね。'),
        hakase('タスク定義は上書きできん。変えるたびに `webapp:1`、`webapp:2` と **リビジョン** (版) が増えていく。'),
        node('上書き保存できないんですか？ 不便ですね。'),
        hakase('不便だから安全なのだ。前の版が必ず残る。君の報告書も上書きせずに版を残したまえ。どこで間違えたか、後で辿れる。'),
        node('…それ、褒められてないですよね。'),
        hakase('タスク定義から起動した実行中のコンテナが **タスク**。タスクを決めた数だけ動かし続け、ALB のターゲットグループに登録するのが **サービス**。それらをまとめる入れ物が **クラスター** だ。今は `webapp-cluster` の `webapp-svc` がタスクを 2 つ動かしておる。'),
      ],
    },
    {
      type: 'table',
      title: 'ECS の用語',
      columns: ['用語', '意味', '今回の例'],
      rows: [
        ['イメージ (ECR)', 'アプリと実行環境をまとめたもの。ECR のリポジトリに置き、タグで版を区別する', '`webapp:v1` `webapp:v2.0`'],
        ['タスク定義', 'どのイメージを、CPU・メモリ・ポートいくつで動かすかの設計図。変更するたびに新しいリビジョンになる', '`webapp:1`'],
        ['タスク', 'タスク定義から起動した実行中のコンテナ (のまとまり)', '2 つ'],
        ['サービス', 'タスクを決めた数だけ動かし続け、ALB のターゲットグループに登録する', '`webapp-svc`'],
        ['Fargate', 'サーバーを用意せずにタスクを動かす実行方式。タスクごとに ENI (IP アドレス) が付く', 'ターゲットタイプは IP'],
      ],
    },
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
        hakase('うむ。では今のサービスを見に行こう。ブラウザで web-alb を開いて確かめるのも忘れるでないぞ。'),
      ],
    },
    {
      type: 'exercise',
      title: '今のサービスを見る',
      objective: '`webapp-cluster` の `webapp-svc` を開いて実行中のタスクを確認し、ブラウザで `web-alb` を開く',
      tasks: [
        { id: 'svc', title: 'ECS > クラスター > `webapp-cluster` > サービス `webapp-svc` を開く', hint: 'クラスター名 `webapp-cluster` のリンクを開き、**サービス** タブのサービス名をクリックします。', done: (c) => visited(c, '/ecs/clusters/webapp-cluster/services/webapp-svc') },
        { id: 'alb', title: 'ブラウザで `web-alb` の DNS 名を開く', hint: 'EC2 > ロードバランサーから DNS 名をコピーします。', done: (c) => alb(c)?.status === 200 },
      ],
      validate: (c) =>
        alb(c)?.status === 200 && alb(c)!.body.includes('webapp v1')
          ? ok(
              node('「webapp v1」と表示されました。サービスの画面では、タスクが 2 つ実行中です。'),
              hakase('ターゲットグループの登録済みターゲットも覗いてみたまえ。EC2 のインスタンス ID ではなく、**タスクの IP アドレス** が並んでおる。'),
              node('インスタンスがいないのに、ALB はちゃんとタスクに届けてるんですね。'),
              hakase('ALB から見れば、相手が EC2 でもタスクでも「この IP のこのポート」に投げるだけだ。相手の正体など気にせん。'),
            )
          : ng(hakase('まだ確かめ終わっておらん。ECS > クラスター > webapp-cluster で サービス webapp-svc を開き、EC2 > ロードバランサーから web-alb の DNS 名をコピーしてブラウザで開くのだ。')),
    },
    {
      type: 'dialogue',
      lines: [
        node('開発チームから「v2 をリリースしたので、ECR のイメージ `webapp:v2` に切り替えてください」と連絡が来ました！'),
        hakase('ではデプロイだ。**デプロイ** とは、新しい版を配って動かすことだ。'),
        node('タスク定義は上書きできないんでしたよね。どうするんですか？'),
        hakase('よく覚えておった。だから `webapp:1` を元に **新しいリビジョンの作成** をして、**イメージ URI** の末尾のタグだけを `:v2` に変える。'),
        node('いめーじゆーあーるあい？'),
        hakase('イメージの住所だ。`123456789012.dkr.ecr.ap-northeast-1.amazonaws.com/webapp:v1` のように、どの ECR の・どのリポジトリの・どのタグかを 1 行で書く。コロンの後ろがタグだ。'),
        node('冷凍庫の住所と棚と、弁当のラベルですね。'),
        hakase('弁当から離れんか。リビジョンができたら、`webapp-svc` を **サービスを更新** で新しいリビジョンに切り替える。すると ECS は **ローリングアップデート** を始める。'),
        node('ろーりんぐ？ 転がすんですか？'),
        hakase('少しずつ入れ替えるのだ。新しいタスクを起動して、ヘルスチェックに合格してから古いタスクを止める。全部を一度に止めんから、お客さんは入れ替わりに気付かん。'),
        node('ヘルスチェックって、Lesson 13 でやった「生きてるか」を ALB が定期的に確かめるやつでしたよね。'),
        hakase('そうだ。合格しない新人は、先輩と交代させてもらえんわけだ。'),
        node('会社みたいですね。'),
        hakase('会社はもっと厳しいぞ。合格しなくても現場に放り込まれる。'),
      ],
    },
    {
      type: 'exercise',
      title: 'v2 をデプロイする',
      objective: 'タスク定義 `webapp:1` から、イメージのタグを `:v2` にした新しいリビジョンを作成し、`webapp-svc` をそのリビジョンに更新する',
      tasks: [
        { id: 'rev', title: 'タスク定義 `webapp:1` → **新しいリビジョンの作成** → イメージ URI の末尾を `:v2` に → 作成', hint: 'ECS の左メニュー **タスク定義** → `webapp` → `webapp:1` を開くと、右上にボタンがあります。**イメージ URI** はコロンの後ろのタグだけを書き換えます。', hotspotId: 'ecs-revision-submit', done: (c) => c.env.taskDefinitions.some((d) => tagOf(d.containerDefinitions[0].image) === 'v2') },
        { id: 'update', title: '`webapp-svc` → **サービスを更新** → 新しいリビジョンを選んで更新', hint: 'ECS > クラスター > `webapp-cluster` > `webapp-svc` の右上にボタンがあります。**タスク定義のリビジョン** の候補にはイメージ URI も出るので、末尾が `:v2` のものを選びます。', hotspotId: 'ecs-update-submit', done: (c) => serviceTag(c.env) === 'v2' },
      ],
      validate: (c) =>
        serviceTag(c.env) === 'v2'
          ? ok(
              hakase('サービスが `:v2` のリビジョンに切り替わった。デプロイが始まったぞ。'),
              node('あとは待つだけですね。コーヒー淹れてきます。'),
              hakase('待ちたまえ。デプロイは始めるより、終わるのを見届けるほうが大事だ。「デプロイ」タブでロールアウトの状態を、「タスク」タブで新しいタスクの様子を見るのだ。'),
              hakase('新しいタスクが起動に失敗して止まると、そのタスクに **停止理由** が残る。おかしいと思ったら、まずそこを読むのだぞ。'),
            )
          : ng(hakase('サービスはまだ :v2 のリビジョンを使っておらん。タスク定義 webapp:1 から新しいリビジョンを作ってイメージ URI の末尾を :v2 にし、webapp-svc の「サービスを更新」でそのリビジョンを選ぶのだ。')),
    },
    {
      type: 'exercise',
      title: 'デプロイが終わらない理由を調べる',
      objective: '停止したタスクを開き、**停止理由** を確認する',
      tasks: [{ id: 'stopped', title: 'サービスの **タスク** タブ → フィルターを「停止済み」→ 停止したタスクを開く', hint: 'フィルターは最初「実行中」です。**タスク** 列の ID をクリックすると、詳細画面の上部に停止理由が表示されます。', done: (c) => failed(c.env).some((t) => visited(c, `/ecs/clusters/webapp-cluster/tasks/${taskId(t)}`)) }],
      validate: (c) =>
        failed(c.env).some((t) => visited(c, `/ecs/clusters/webapp-cluster/tasks/${taskId(t)}`))
          ? ok(
              node('`CannotPullContainerError: … webapp:v2: not found` です！ いめーじが、ぷるできない？'),
              hakase('pull とは、イメージを倉庫から取ってくることだ。ECR に `v2` というタグのイメージがないから、取ってこられんのだ。'),
              node('冷凍庫に「v2」のラベルの弁当がない、と。…ってことは、サイトは止まってるんじゃ！？'),
              hakase('ブラウザで開いてみたまえ。v1 が表示されるはずだ。新しいタスクが正常にならない限り、古いタスクは止めない。だから **サービスは止まっておらん**。'),
              node('ローリングアップデートのおかげで、失敗してもお客さんにはバレないんですね。'),
            )
          : ng(hakase('停止理由はまだ読めておらん。webapp-svc の「タスク」タブでフィルターを「停止済み」にして、止まったタスクを開くのだ。')),
    },
    {
      type: 'exercise',
      title: '正しいタグでデプロイし直す',
      objective: 'ECR の `webapp` リポジトリで v2 の本当のタグを確かめ、そのタグで新しいリビジョンを作ってサービスを更新する。デプロイが完了したらブラウザで確認する',
      tasks: [
        { id: 'ecr', title: 'ECR > リポジトリ > `webapp` でイメージタグを確認', hint: 'ECS の左メニュー「Amazon ECR」の **リポジトリ** から開けます。**イメージタグ** 列を、さっき指定した `v2` と一字ずつ比べます。', done: (c) => visited(c, '/ecr/repositories/webapp') },
        { id: 'deploy', title: '正しいタグの新しいリビジョンで **サービスを更新**', hint: 'タスク定義 `webapp` からもう一度 **新しいリビジョンの作成** をして、イメージ URI のタグを ECR にあるものに合わせます。サービスを更新するときは、その最新リビジョンを選びます。', done: (c) => serviceTag(c.env) === 'v2.0' },
        { id: 'done', title: 'デプロイが完了し、ブラウザで新しい版が表示される', hint: 'タスクの入れ替えには少し時間がかかります。', done: (c) => serviceTag(c.env) === 'v2.0' && svc(c.env)?.deployments[0].rolloutState === 'COMPLETED' && !!alb(c)?.body.includes('webapp v2.0') },
      ],
      validate: (c) => {
        const s = svc(c.env);
        if (serviceTag(c.env) !== 'v2.0') return ng(hakase('サービスはまだ本当のタグのリビジョンになっておらん。ECR > リポジトリ > webapp のイメージタグを見て、そのタグでもう一度新しいリビジョンを作り、サービスを更新するのだ。'));
        if (s?.deployments[0].rolloutState !== 'COMPLETED' || runningCount(c.env, s) !== 2 || serviceTasks(c.env, s).some((t) => t.desiredStatus === 'RUNNING' && t.taskDefinitionArn !== s.taskDefinition)) return ng(hakase('まだデプロイ中だ。「デプロイ」タブのロールアウトの状態が「完了」になり、タスクが 2 つとも新しいリビジョンに入れ替わるまで待つのだ。'), node('待つのも仕事、ですね。'));
        if (!alb(c)?.body.includes('webapp v2.0')) return ng(hakase('デプロイは終わっておる。あとはブラウザで web-alb の DNS 名を開き直して、「webapp v2.0」が出るか確かめるのだ。'));
        return ok(
          node('タグは `v2` じゃなくて `v2.0` でした。今度は 2 つとも新しいタスクに入れ替わって、「webapp v2.0」です！'),
          hakase('開発チームが口で言う「v2」と、ECR に貼ったラベルの `v2.0` が違っておったのだ。タグは人が付ける名前だから、こういう間違いは起きる。'),
          node('確実にする方法はないんですか？'),
          hakase('デプロイの前に ECR でタグを確かめるか、**ダイジェスト** (`sha256:…`) で指定することだ。ダイジェストはイメージの中身から計算した指紋のようなもので、中身が 1 ビットでも違えば変わる。'),
          node('ラベルじゃなくて、弁当の DNA で注文するんですね。'),
        );
      },
    },
    {
      type: 'quiz',
      question: hakase('さて問題だ。新しいタスクが起動に失敗し続けていたあいだ、ALB 経由のサイトはどうなっていたかな？'),
      options: ['止まった (503)', '古いタスク (v1) が応答し続けた', '半分だけ 502 になった'],
      answer: 1,
      explanation: [
        hakase('正解。ローリングアップデートでは、新しいタスクがヘルスチェックに合格するまで古いタスクを止めない。'),
        node('だから v2 が全滅しても、お客さんは v1 を見続けていたんですね。'),
        hakase('うむ。先に全部止めてから入れ替える方式だったら、今ごろ君は障害報告書を書いておる。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では次だ。タスク定義を変更すると、どうなるかな？'),
      options: ['今のリビジョンが上書きされる', '新しいリビジョン (webapp:2, :3 …) ができ、サービスを更新して切り替える', 'すぐに全タスクが止まる'],
      answer: 1,
      explanation: [
        hakase('正解。タスク定義は上書きされず、新しいリビジョンが積み重なっていく。'),
        hakase('だから問題が起きても、前のリビジョンでサービスを更新すれば **すぐに戻せる**。これを **ロールバック** という。'),
        node('失敗しても戻れる道が残ってる。昨日の僕の報告書にもリビジョンが欲しかったです。'),
      ],
    },
  ],
};
