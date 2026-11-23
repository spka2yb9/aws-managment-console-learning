# CLI 版の仕組みと、レッスンの CLI 版の書き方

コンソール版と同じレッスンを、ターミナルで AWS CLI を打って学ぶモードです（`#/cli`）。
AWS の側はコンソール版と同じシミュレーター（`src/sim`）を使い、その手前に `aws` コマンドを自作しています。

## 構成

| 場所 | 中身 |
|---|---|
| `src/cli/shell/lifo.ts` | Lifo（ブラウザ内の仮想シェル。linux-learning から移植）。`scripts/patch-lifo.mjs` が postinstall で Lifo を書き換える |
| `src/cli/shell/shell.ts` | `CliShell`。学習者の PC（`learner@my-pc`）のシェルと、`aws ec2-instance-connect ssh` で入った EC2 の中（`src/sim/cli.ts` の `execCli`）を切り替える |
| `src/cli/shell/curl.ts` | `curl`。`simulateHttp` に聞き、結果を `ctx.browser` に残す（コンソール版のブラウザタブと同じ判定が使える）。`-v` で経路の確認結果を出す |
| `src/cli/shell/commands/*.ts` | 学習者の PC に足すコマンド。`default` で `{ コマンド名: (ctx) => 終了コード }` を返す。自動で読み込まれる。`time.ts`（`sleep` と GNU 互換寄りの `date`。`sleep` の間もシミュレーターの時計を進める）、`dns.ts`（`dig` / `nslookup` / `host`）、`loadtest.ts`（`hey` / `pkill hey`） |
| `src/cli/aws/aws.ts` | `aws` 本体。グローバルオプション、引数の解析、ヘルプ、`--query`（jmespath）、`--output`、エラーの書き方、待機（`wait`）、Tab 補完 |
| `src/cli/aws/services/*.ts` | オペレーションの定義。`default` で `service(名前, 説明, ops)` を返す。自動で読み込まれ、同じサービスを複数のファイルに分けてよい。同じオペレーションを 2 回定義すると `registry.test.ts` が失敗する |
| `src/cli/aws/auth/*.ts` | 認可のフック（`Authorizer`）。API を呼ぶ前に毎回呼ばれ、拒否するなら `AwsError` を投げる。既定のプロファイル（IAM ユーザー learner、管理者）以外のプロファイル（IAM Identity Center など）で使う |
| `src/cli/aws/shapes.ts` | sim のリソースを API の応答の形（パスカルケース）にする関数（EC2 / ELBv2 / RDS） |
| `src/lessons/cli/*.ts` | レッスンの CLI 版（後述）。`l*.ts` が自動で読み込まれる |
| `src/pages/CliLessonPage.tsx` | CLI 版のレッスン画面（左に会話と演習、右にターミナル）。進捗と状態は `cli:<lessonId>` で保存 |

## オペレーションの書き方

```ts
// src/cli/aws/services/sqs.ts
import { service, req, type OperationSpec } from '../types';

const ops: OperationSpec[] = [
  {
    name: 'get-queue-url',            // CLI のサブコマンド名。API 名 (GetQueueUrl) は自動で作る
    desc: 'キューの名前から URL を引く', // aws sqs help に出る
    params: [{ name: 'queue-name', type: 'string', required: true, desc: 'キューの名前' }],
    readOnly: true,                    // 参照系 (環境を変えない、CloudTrail に残らない)
    run: (ctx) => ({ QueueUrl: ... }), // 応答のオブジェクト。何も出さないなら undefined
  },
];
export default service('sqs', 'Amazon SQS (キュー)', ops);
```

- CLI 側で止める引数の誤り（`Parameter validation failed` など）は `ParamError` を投げる（終了コード 252）。
- 変更系（`readOnly` なし）は `ctx.env`（下書き）を sim の関数で書き換える。`AwsError` を投げれば何も変わらず、`An error occurred (Code) when calling the Xxx operation: ...` と出て終了コード 254 になる。sim の関数がそのまま使えることが多い（コンソールの画面が呼んでいるものを探す）。
- 引数の型: `string` / `integer` / `boolean`（`--x` と `--no-x`）/ `list`（空白区切り・カンマ区切り・JSON）/ `list` + `of: 'structure'`（shorthand `Key=a,Value=b` か JSON）/ `structure` / `map`。`file://` はどの型でも学習者の PC のファイルを読む。値の取り出しは `str` `req` `int` `bool` `strs` `structs` `struct`（`types.ts`）。
- `scope: 'global'` はリージョンに関係ないもの（IAM、S3 のバケット一覧、Route 53、CloudFront など）。既定の `regional` は、レッスンのリージョン以外を指定すると空のアカウントに見え、変更はできない。
- `raw: true` は文字列をそのまま出す（`aws s3 ls`、`aws logs tail` のような高レベルのコマンド）。失敗は `{ text, exitCode, errorCode }` で返す。
- 待機は `name: 'wait instance-running'` と `waiter: { until(ctx) }`。
- EC2 の `--filters` は `applyFilters(ctx, items, { 'vpc-id': (x) => x.vpcId, ... })`。`tag:Name` と `tag-key` は自動。
- 応答の形は実物の AWS CLI v2 に合わせる（キー名、入れ子、日時は `iso()`）。`--query` で学習者が抜き出すので、キー名を間違えないこと。

## レッスンの CLI 版の書き方

コンソール版のレッスン（`src/lessons/*.ts`）は変えず、ステップを番号で差し替えます（`src/lessons/cli/types.ts` の `CliPatch`）。

```ts
// src/lessons/cli/l06-09-network.ts
const patches: CliPatches = {
  'public-private-subnet': {          // レッスンの id
    files: (env) => ({ 'policy.json': '...' }),   // 学習者の PC のホームに置くファイル (任意。'.aws/config' で既定の設定を上書き)
    steps: {
      3: { type: 'dialogue', lines: [...] },      // 3 番目のステップを差し替え
      4: { type: 'exercise', ... },               // 演習は必ず差し替える
      7: [{ type: 'dialogue', ... }, { type: 'exercise', ... }],  // 配列なら 1 つを複数に
    },
  },
};
export default patches;
```

ステップの番号と種類は `LESSONS=06,07 npx vitest run src/lessons/cli/outline.test.ts --silent=false` で出せます。

### 何を差し替えるか

- 演習（`exercise`）はすべて。コンソールを操作する演習が残っているとテストが失敗する。
- 会話・表・クイズのうち、コンソールの操作や画面（「〜をクリック」「〜タブ」「一覧の〜列」「右上の〜」「〜画面」「ブラウザタブ」）に触れているもの。同じことを CLI のコマンドと応答（JSON のキー名）で言い換える。話の筋、ギャグ、技術の説明、クイズの選択肢と正解は変えない（「内容はそのまま」）。
- 会話の文体は `src/lessons/STYLE.md` のとおり。CLI 版で新しく出てくる言葉（オプション、`--query`、shorthand など）は、出てきたその場で説明する。前のレッスン（学習順）で CLI 版が説明したことは「〜でしたよね」で振り返ってよい。CLI 版の Lesson 01〜05（`l01-05-basics.ts`）で、CLI、`aws <サービス> <操作>`、JSON、Region の設定（`aws configure`、`--region`）、オプション、タグと `--tag-specifications`、shorthand 構文、`--query`、`--output text`、`--filters`、`VPC_ID=$(...)` の変数を説明済み。

### 演習の書き方

- タスクの `done` は「結果の状態」で判定するのが基本（`subnetNamed(c.env, ...)` など、コンソール版と同じ）。
- 「見るだけ」のタスクは、打った `aws` を `ranAws(c, 'ec2 describe-vpcs', (x) => ...)` で判定する（`src/lessons/cli/helpers.ts`）。`x.params`（解析済みの引数）、`x.query`、`x.format`、`x.region`、`x.output`（画面に出た文字）で絞れる。わざとエラーを見るタスクは `failedAws(c, 'ec2 create-subnet', 'InvalidSubnet.Range')`。
- EC2 の中で打ったコマンドは、コンソール版と同じ `lastRun(c, 'batch-1', /.../)`（`src/lessons/helpers.ts`）で判定できる。`exit` も記録されるので、PC に戻ったかは `insideInstance(c, instanceId)` で分かる。
- `curl` も `dig` も、打った行と出力が `ctx.commands` に残る（`instanceId` は空、`command` は無し）。`curl` の結果はコンソール版と同じ `lastAlbRequest(c)` / `lastRequestTo(c, host)`。
- どのタスクにも `hint` と `command`（模範解答のコマンド。関数にすれば今の環境の ID を埋められる）を書く。学習者は「コマンド例を見る」で表示し、「ターミナルに入力」で打てる。
- `validate` の `ok` / `ng` の発言も CLI の言葉にする。`ng` は次に打つべきコマンドのヒントを含める。
- 前の演習のコマンドだけで次の演習が通ってしまわないようにする（`ranAws` の条件を具体的にする）。テストが確かめる。
- タスクがすべて終わり `validate` に通ると、ボタンを押さなくても自動で次へ進む。

### テスト

`npx vitest run src/lessons/cli src/cli` で次を確かめます。

- コンソール版の演習がすべて差し替わっている、タスクにヒントとコマンド例がある
- 模範解答: 各タスクの `command` を順に本物のシェル（Lifo + `aws`）で打つと、各タスクが done になり、演習が検証に通る（待機は時計を進めるだけなので一瞬で終わる）
- 演習のコマンドを打つ前には検証に通らない
- `aws` のオペレーションが重複していない

### モンキーテスト

`src/cli/test/monkey.test.ts` は、レッスンの初期状態ごとに、ランダムなオペレーションと、模範解答を少し壊したコマンドを打ち続けます。JS の例外、`[object Object]` や `NaN` の表示、終わらないコマンド、レッスンの判定や構成図が落ちる状態を見つけると失敗します。既定は 1 レッスンあたり 40 回です。`MONKEY_SEED=7 MONKEY_N=300 MONKEY_LESSONS=26,27 npx vitest run src/cli/test/monkey.test.ts` のように、種・回数・レッスンを変えて増量できます。

画面側は `e2e/cli-monkey.spec.ts` です。ターミナルにでたらめなキー入力と貼り付けをし、レッスンパネルのボタンを押し、ウィンドウの大きさを変えます。ページの例外が出ず、最後にターミナルが応答すれば合格です（`MONKEY_SEED` と `MONKEY_STEPS` で増量できます）。
