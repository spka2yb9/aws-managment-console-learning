import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { versionOf } from '../../cli/aws/services/iam';
import { evaluateIamPermission, instanceRole, statements } from '../../sim/iam';
import { isPolicyPublic, objectArn } from '../../sim/s3';
import { PUBLIC_SITE_BUCKET, REPORTS_BUCKET } from '../../sim/scenarios';
import type { AwsEnv } from '../../sim/types';
import { bucketNamed, instanceNamed, lastRequestTo, lastRun } from '../helpers';
import { awsCalls, insideInstance, param, ranAws } from './helpers';
import type { CliPatches } from './types';

const KEY = 'reports/2026/09/report-2026-09-28.csv';
const CP = `aws s3 cp s3://${REPORTS_BUCKET}/${KEY} .`;
const GET = `aws s3api get-object --bucket ${REPORTS_BUCKET} --key ${KEY} report.csv`;
const SITE_URL = `https://${PUBLIC_SITE_BUCKET}.s3.ap-northeast-1.amazonaws.com/index.html`;
const PUBLIC_POLICY = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'PublicReadGetObject', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${PUBLIC_SITE_BUCKET}/*` }] }, null, 2);
const BPA_ON = 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true';
const FIND_BATCH = "aws ec2 describe-instances --filters Name=tag:Name,Values=batch-1 --query 'Reservations[0].Instances[0].InstanceId' --output text";

const newAssets = (env: AwsEnv) => env.buckets.find((b) => b.name.startsWith('webapp-assets'));
const assets = (c: TaskContext) => newAssets(c.env)?.name ?? 'webapp-assets-123456789012';
const siteHost = (env: AwsEnv) => (bucketNamed(env, PUBLIC_SITE_BUCKET) ? `${PUBLIC_SITE_BUCKET}.s3.` : undefined);
const batchId = (env: AwsEnv) => instanceNamed(env, 'batch-1')?.instanceId;
/** exit で batch-1 から PC に戻った */
const backOnPc = (c: TaskContext) => !insideInstance(c, batchId(c.env));
const ssh = (c: TaskContext) => `aws ec2-instance-connect ssh --instance-id ${batchId(c.env) ?? 'i-xxxxxxxx'}`;
/** The terminal is inside batch-1: the newest aws call typed on the PC is a successful ssh to it (exit is not recorded). */
const inBatch = (c: TaskContext) => {
  const last = awsCalls(c).at(-1);
  return !!last?.ok && last.command === 'ec2-instance-connect ssh' && param(last, 'instance-id') === batchId(c.env);
};
const batchCan = (env: AwsEnv) =>
  evaluateIamPermission(env, { principal: { type: 'role', roleName: 'batch-role', sessionName: batchId(env) ?? 'i' }, action: 's3:GetObject', resource: objectArn(REPORTS_BUCKET, KEY), resourcePolicy: bucketNamed(env, REPORTS_BUCKET)?.policy, context: { 'aws:SecureTransport': true } }).decision;
const batchPolicy = (env: AwsEnv) => env.iamPolicies.find((p) => p.policyName === 'batch-s3-read');
const batchPolicyArn = (c: TaskContext) => batchPolicy(c.env)?.arn ?? 'arn:aws:iam::123456789012:policy/batch-s3-read';
/** the bucket policy without DenyLegacyBatch (model solution of lesson 23) */
const withoutLegacy = (env: AwsEnv) => {
  const p = bucketNamed(env, REPORTS_BUCKET)?.policy;
  return JSON.stringify({ Version: '2012-10-17', Statement: p ? statements(p).filter((s) => s.Sid !== 'DenyLegacyBatch') : [] });
};

/* 22 */
const nobodyOnBatch = (c: TaskContext) => !!lastRun(c, 'batch-1', /sts get-caller-identity/);
const whoOk = (c: TaskContext) => !!lastRun(c, 'batch-1', /sts get-caller-identity/)?.ok;
const lsOk = (c: TaskContext) => !!lastRun(c, 'batch-1', /s3 ls s3:\/\//)?.ok;
/* 23 */
const cpRun = (c: TaskContext) => !!lastRun(c, 'batch-1', /s3 cp s3:\/\//);
const explicitDenySeen = (c: TaskContext) => !!lastRun(c, 'batch-1', /s3api get-object/)?.output.includes('explicit deny in a resource-based policy');
const implicitDenySeen = (c: TaskContext) => !!lastRun(c, 'batch-1', /s3api get-object/)?.output.includes('no identity-based policy allows');

const patches: CliPatches = {
  's3-basics': {
    summary: 'aws s3 と aws s3api で、バケット・オブジェクト・キーを扱う。フォルダは本当は存在しない',
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          node('オブジェクトにも名前はあるんですか？'),
          hakase('バケットの中でオブジェクトを区別する名前を**キー**という。ロッカーの番号札だな。例えば `reports/2026/09/report-2026-09-28.csv` だ。'),
          node('reports フォルダの中の、2026 フォルダの中の…'),
          hakase('そう見えるだろう？ だが S3 に**本物のフォルダはない**。これは / を含む 1 本の長い名前だ。'),
          node('え、じゃあフォルダに見えるのは？'),
          hakase('キーの先頭部分、**プレフィックス**だ。prefix は「前に付くもの」という意味だ。この後で打つ `aws s3 ls` が / で区切って、フォルダのように見せてくれておるだけだ。'),
          node('名札に「営業部/1課/山田」って書いてあるだけで、営業部という部屋はない、みたいな？'),
          hakase('その通りだ。そしてバケット名とキーをつないだ `s3://バケット名/キー` が **S3 URI**、オブジェクトの住所だ。'),
          node('ゆーあーるあい？ URL の親戚ですか？'),
          hakase('親戚だ。URI はものを指し示す名前の総称で、URL はその一種だ。S3 URI は、このターミナルの AWS CLI で S3 のオブジェクトを指すときに使う。今日さっそく打つぞ。'),
        ],
      },
      3: {
        type: 'table',
        title: 'S3 の用語',
        columns: ['用語', '意味', '例'],
        rows: [
          ['バケット', 'オブジェクトの入れ物。名前は**全 AWS アカウントで一意**', `\`${REPORTS_BUCKET}\``],
          ['オブジェクト', '保存されるデータ本体 + メタデータ (サイズや更新日時などの付帯情報)', 'CSV、画像、ログ'],
          ['キー', 'バケット内でのオブジェクトの名前', '`reports/2026/09/report-2026-09-28.csv`'],
          ['プレフィックス', 'キーの先頭部分。`aws s3 ls` ではフォルダ (`PRE`) のように見える', '`reports/2026/09/`'],
          ['S3 URI', 'CLI などでオブジェクトを指す住所', `\`s3://${REPORTS_BUCKET}/reports/\``],
        ],
      },
      4: [
        {
          type: 'dialogue',
          lines: [
            hakase('では実物を見よう。S3 を操作するコマンドは 2 種類ある。`aws s3` と `aws s3api` だ。'),
            node('えすすりー と えすすりーえーぴーあい？ 双子ですか？'),
            hakase('性格の違う兄弟だな。`aws s3` は `ls` や `cp` のように、S3 URI でファイルを出し入れする人間向けのコマンドだ。`aws s3api` は S3 の API をほぼそのまま呼ぶ、飾り気のないほうだ。'),
            node('使い分けは？'),
            hakase('ファイルの出し入れは `aws s3`、バケットの細かい設定や本当の姿を見るのは `aws s3api` だ。まずは `aws s3 ls` でバケットの一覧を出す。ls は list、一覧だ。'),
            node('Lesson 02 では Region を東京にしましたよね。S3 も東京のバケットしか出ないんですか？'),
            hakase('バケット自体はどこかのリージョンに作られる。だが名前は世界で一意だから、一覧は全リージョン分をまとめて見せるのだ。'),
            node('バケットの中を見るときは？'),
            hakase('`aws s3 ls s3://バケット名/プレフィックス/` だ。次の / までを `PRE` の行にまとめて、フォルダのように見せてくれる。'),
            node('じゃあ、本当のキーを見るには？'),
            hakase("`aws s3api list-objects-v2` だ。`--query 'Contents[].Key'` と書けば、`Contents` の全部の要素から `Key` だけを抜き出せる。`[0]` が 1 つ目なら、`[]` は全部だ。"),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            node('今日は見るだけですか？'),
            hakase('いや、自分のバケットも作ってもらう。作るのは `aws s3 mb`、make bucket の略だ。そのとき**バージョニング**と**ブロックパブリックアクセス**も確かめる。'),
            node('ばーじょにんぐ？'),
            hakase('上書きや削除をしても、前の版を残しておく仕組みだ。ワープロの「元に戻す」の、もっと執念深い版だな。`aws s3api put-bucket-versioning` で有効にする。'),
            node('間違えて消しても戻せるんですね。僕のためにあるような機能だ。'),
            hakase('自覚があるのはよいことだ。ブロックパブリックアクセスは、バケットをうっかり全世界に公開しないための安全装置だ。詳しくは次の Lesson 21 でやる。今日は「全部オン」とだけ覚えておけばよい。'),
            node('全部オン。了解です！'),
          ],
        },
      ],
      5: {
        type: 'exercise',
        title: '既存のバケットを見る',
        objective: `\`aws s3 ls\` で \`${REPORTS_BUCKET}\` の中をたどって \`reports/2026/09/\` のオブジェクトを表示し、\`aws s3api list-objects-v2\` で本当のキーを確かめる`,
        tasks: [
          { id: 'list', title: '`aws s3 ls` でバケットの一覧を見る', hint: 'S3 URI を付けずに打つと、バケットの一覧が出ます。日時はバケットを作った日時です。', command: 'aws s3 ls', done: (c) => !!ranAws(c, 's3 ls', (x) => !param(x, 'path')) },
          {
            id: 'bucket',
            title: `\`${REPORTS_BUCKET}\` の中を見る`,
            hint: '`aws s3 ls s3://<バケット名>/` と打ちます。`PRE` の行が、フォルダのように見えるプレフィックスです。',
            command: `aws s3 ls s3://${REPORTS_BUCKET}/`,
            done: (c) => !!ranAws(c, 's3 ls', (x) => new RegExp(`^(s3://)?${REPORTS_BUCKET}/?$`).test(param(x, 'path'))),
          },
          {
            id: 'prefix',
            title: '`reports/` → `2026/` → `09/` とたどる',
            hint: 'S3 URI の後ろに `reports/2026/09/` を足して打ちます。最後の `/` を忘れずに。',
            command: `aws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/`,
            done: (c) => !!ranAws(c, 's3 ls', (x) => param(x, 'path').includes(`${REPORTS_BUCKET}/reports/2026/09/`) && x.output.includes('.csv')),
          },
          {
            id: 'keys',
            title: '`aws s3api list-objects-v2` で本当のキーを見る',
            hint: "`aws s3api list-objects-v2 --bucket <バケット名> --query 'Contents[].Key'`。`Contents[].Key` は「Contents の全部の要素の Key」という意味です。",
            command: `aws s3api list-objects-v2 --bucket ${REPORTS_BUCKET} --query 'Contents[].Key'`,
            done: (c) => !!ranAws(c, 's3api list-objects-v2', (x) => param(x, 'bucket') === REPORTS_BUCKET),
          },
        ],
        validate: (c) => {
          if (!ranAws(c, 's3 ls', (x) => param(x, 'path').includes(`${REPORTS_BUCKET}/reports/2026/09/`) && x.output.includes('.csv')))
            return ng(hakase(`まだ \`reports/2026/09/\` の中を見ていないようだ。\`aws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/\` と、最後の / まで付けて打つのだ。`));
          if (!ranAws(c, 's3api list-objects-v2', (x) => param(x, 'bucket') === REPORTS_BUCKET))
            return ng(hakase(`中身は見られたな。仕上げに \`aws s3api list-objects-v2 --bucket ${REPORTS_BUCKET} --query 'Contents[].Key'\` で、本当のキーも見るのだ。`));
          return ok(
            node('`reports/2026/09/` の中に CSV が 2 つありました。'),
            hakase('フォルダを 3 つくぐったように見えたが、`list-objects-v2` の答えはどうだった？ `reports/2026/09/report-2026-09-28.csv` という長いキーが並んでいるだけだ。'),
            node('`PRE reports/` も `PRE 2026/` も、`aws s3 ls` がプレフィックスでまとめて見せてくれてたんですね。'),
            hakase('うむ。S3 に本物のフォルダはない。ないフォルダの中で迷子になる新人は、毎年必ずおるがな。'),
          );
        },
      },
      6: {
        type: 'exercise',
        title: 'バケットを作成する',
        objective: '名前が `webapp-assets-` で始まるバケットを `aws s3 mb` で作り、バージョニングを **有効** にする。ブロックパブリックアクセスがすべてオンなことも確かめる',
        tasks: [
          {
            id: 'create',
            title: 'バケット `webapp-assets-123456789012` を作る',
            hint: '`aws s3 mb s3://webapp-assets-123456789012`。`test` や `my-bucket` のような名前は他のアカウントが使っているため作れません。アカウント ID を付けると一意にしやすいです。',
            command: 'aws s3 mb s3://webapp-assets-123456789012',
            done: (c) => !!newAssets(c.env),
          },
          {
            id: 'versioning',
            title: 'バージョニングを有効にする',
            hint: '`aws s3api put-bucket-versioning --bucket <バケット名> --versioning-configuration Status=Enabled`。成功しても何も表示されません。`aws s3api get-bucket-versioning --bucket <バケット名>` で確かめられます。',
            command: (c) => `aws s3api put-bucket-versioning --bucket ${assets(c)} --versioning-configuration Status=Enabled`,
            done: (c) => newAssets(c.env)?.versioning === 'Enabled',
          },
          {
            id: 'bpa',
            title: 'ブロックパブリックアクセスが全部オンか確かめる',
            hint: '`aws s3api get-public-access-block --bucket <バケット名>`。4 つとも `true` なら全部オンです。',
            command: (c) => `aws s3api get-public-access-block --bucket ${assets(c)}`,
            done: (c) => !!ranAws(c, 's3api get-public-access-block', (x) => param(x, 'bucket') === newAssets(c.env)?.name),
          },
        ],
        validate: (c) => {
          const b = newAssets(c.env);
          if (!b) return ng(hakase('`webapp-assets-` で始まるバケットが見当たらん。`aws s3 mb s3://webapp-assets-123456789012` で作るのだ。`make_bucket failed` と出たなら、エラーの理由を読みたまえ。'));
          if (b.versioning !== 'Enabled') return ng(hakase(`バージョニングが有効になっておらんぞ。作り直さなくてよい。\`aws s3api put-bucket-versioning --bucket ${b.name} --versioning-configuration Status=Enabled\` で有効にするのだ。`));
          if (!Object.values(b.blockPublicAccess).every(Boolean)) return ng(hakase(`ブロックパブリックアクセスがオフになっておる。\`aws s3api put-public-access-block --bucket ${b.name} --public-access-block-configuration ${BPA_ON}\` で全部オンに戻すのだ。`), node('作った初日に公開しかけるところでした…'));
          return ok(
            hakase('よし。バージョニングは有効、ブロックパブリックアクセスは全部オンだ。新しいバケットは既定で非公開だから、これで誰にも覗かれん。'),
            node('暗号化の設定は、何もしなくてよかったんですか？'),
            hakase('新しいバケットは、何もしなくても **SSE-S3** で暗号化される。Server-Side Encryption、保存するときに S3 側で暗号化してくれる仕組みだ。鍵の管理まで S3 がやってくれる。`aws s3api get-bucket-encryption` で見れば `"SSEAlgorithm": "AES256"` と出るぞ。'),
            node('鍵の管理まで。僕の家の鍵より厳重ですね。'),
            hakase('君の家の鍵は、どうせ植木鉢の下にあるのだろう。'),
          );
        },
      },
      7: [
        {
          type: 'dialogue',
          lines: [
            node('作ったバケットに、ファイルを入れてみたいです。でも、この PC に入れるファイルなんてありましたっけ？'),
            hakase("なければ作ればよい。`echo 'Hello S3' > hello.txt` と打ってみたまえ。"),
            node('Lesson 03 で `echo $VPC_ID` は打ちましたけど、`>` は？'),
            hakase('**リダイレクト**だ。画面に出るはずの文字を、ファイルに書き込む。`cat hello.txt` で中身を表示すれば確かめられる。'),
            node('きゃっと…猫ですか？'),
            hakase('concatenate、つなげるの略だ。ファイルの中身を画面に出す。猫の手を借りたいのはワシのほうだ。'),
            node('で、アップロードは？'),
            hakase('`aws s3 cp hello.txt s3://バケット名/` だ。cp は copy、手元と S3 の間でファイルをコピーする。'),
            node('逆に S3 から取り出すときは？'),
            hakase('コピー元とコピー先を逆にするだけだ。コピー先を `-` にすると、ファイルに保存せずに画面へ出す。S3 URI さえ分かれば、どこからでも取り出せるのだ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'オブジェクトをアップロードする',
          objective: '手元にファイルを作って、作成したバケットにアップロードし、S3 URI を指定して中身を取り出す',
          tasks: [
            {
              id: 'upload',
              title: '`hello.txt` を作って `aws s3 cp` でアップロード',
              hint: "`echo 'Hello S3' > hello.txt` でファイルを作り、`aws s3 cp hello.txt s3://<バケット名>/` で送ります。`upload:` と出れば成功です (シミュレーターなので外部には送信しません)。",
              command: (c) => `echo 'Hello S3' > hello.txt && aws s3 cp hello.txt s3://${assets(c)}/`,
              done: (c) => (newAssets(c.env)?.objects.length ?? 0) > 0,
            },
            {
              id: 'uri',
              title: 'S3 URI を指定して中身を表示する',
              hint: '`aws s3 cp s3://<バケット名>/hello.txt -`。最後の `-` は「ファイルではなく画面に出す」という意味です。',
              command: (c) => `aws s3 cp s3://${assets(c)}/hello.txt -`,
              done: (c) => !!ranAws(c, 's3 cp', (x) => param(x, 'source').startsWith(`s3://${newAssets(c.env)?.name ?? '-'}/`)),
            },
          ],
          validate: (c) =>
            ranAws(c, 's3 cp', (x) => param(x, 'source').startsWith(`s3://${newAssets(c.env)?.name ?? '-'}/`))
              ? ok(
                  hakase('`cp` に渡した `s3://…` が **S3 URI** だ。アプリやスクリプトからオブジェクトを指すときの住所だ。'),
                  node('アップロードも取り出しも、`aws s3 cp` の向きを変えるだけなんですね。'),
                  hakase('うむ。この先、`aws s3 cp` は毎日のように打つことになるぞ。'),
                  node('住所さえ控えておけば、コマンドからも取り出せる、と。メモしておきます。'),
                  hakase('メモをなくさんようにな。君の記憶は揮発性メモリだからな。'),
                )
              : ng(hakase('まだ S3 URI で中身を取り出していないようだ。`aws s3 cp hello.txt s3://<バケット名>/` でアップロードしたら、`aws s3 cp s3://<バケット名>/hello.txt -` で中身を画面に出すのだ。')),
        },
      ],
    },
  },

  's3-public-access': {
    files: () => ({ 'policy.json': PUBLIC_POLICY + '\n' }),
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node(`博士、キャンペーン用の静的ページを \`${PUBLIC_SITE_BUCKET}\` に置きました。URL を開けば、お客さんに見てもらえますよね？`),
          hakase('せいてきページとは何か、言えるかな？'),
          node('静かなページ…じゃなくて、HTML や画像を、サーバーでプログラムを動かさずにそのまま返すだけのページです。'),
          hakase('正解だ。それなら EC2 を立てずとも、S3 のオブジェクトをそのまま配ればよい。'),
          node('で、URL ってどれですか？ Lesson 20 で `aws s3 cp` に渡した `s3://…` ですか？'),
          hakase('あれは **S3 URI**、CLI 用の住所だったな。ブラウザや `curl` で開くのは**オブジェクト URL**のほうだ。`https://バケット名.s3.リージョン.amazonaws.com/キー` という形をしておる。'),
          node('住所が 2 つあるんですね。社内便の宛先と、郵便の住所みたいな。'),
          hakase('そんなところだ。ただし開いても、たぶん見られんぞ。S3 は**既定ですべて非公開**だからな。'),
          node('え、せっかく置いたのに？'),
          hakase('置いただけで世界に公開されたら、給与明細の CSV を置いた瞬間に全社員の年収が世界に知れ渡る。君の年収もな。'),
          node('それは…ある意味、僕が一番恥ずかしいやつです。'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          hakase('待っていて届くのは始末書だけだ。ちなみに公開の手段には、**ACL** という古いやり方もある。'),
          node('ACL って、Lesson 09-2 のネットワーク ACL ですか？'),
          hakase('同じアクセスコントロールリストという名前だが、別物だ。S3 の ACL は、バケットやオブジェクトごとに付ける昔ながらの許可リストだ。今は無効にしてバケットポリシーで管理するのが推奨で、このバケットも ACL は無効だ。'),
          node('名前がかぶってるの、ややこしいですね…'),
          hakase('文句は命名した者に言いたまえ。そしてもう 1 つ。Lesson 20 で「全部オン」にした**ブロックパブリックアクセス**を覚えておるか。'),
          node('「今日は全部オンとだけ覚えておけ」って言われたやつですね。'),
          hakase('そうだ。あれがオンのままでは、公開するポリシーは保存すらできん。まずは本当に 403 になるか、Lesson 09 から使っておる `curl` で、オブジェクト URL を開いてみたまえ。'),
          node('`aws s3 ls` なら中身が見えるのに、`curl` だと見えないんですか？'),
          hakase('`aws` のコマンドは、AWS の利用者として名乗ってから頼んでおる。`curl` は認証情報を何も付けずに頼むから、S3 から見れば名乗らない**匿名**の客だ。'),
          node('会員証を見せるお客さんと、見せないお客さんの違いですね。'),
        ],
      },
      3: {
        type: 'exercise',
        title: 'オブジェクト URL を開いてみる',
        objective: '`index.html` のオブジェクト URL に `curl` でアクセスし、403 になることを確認する',
        tasks: [
          {
            id: 'open',
            title: `\`${PUBLIC_SITE_BUCKET}\` に \`index.html\` があることを確かめる`,
            hint: '`aws s3 ls s3://<バケット名>/` で中身を見ます。オブジェクト URL は `https://<バケット名>.s3.ap-northeast-1.amazonaws.com/<キー>` の形です。',
            command: `aws s3 ls s3://${PUBLIC_SITE_BUCKET}/`,
            done: (c) => !!ranAws(c, 's3 ls', (x) => param(x, 'path').includes(PUBLIC_SITE_BUCKET)),
          },
          {
            id: 'browse',
            title: '`curl` でオブジェクト URL を開く',
            hint: '`curl -i https://<バケット名>.s3.ap-northeast-1.amazonaws.com/index.html`。`-i` を付けると、1 行目に HTTP のステータスが出ます。`curl` からのアクセスは、認証情報を持たない匿名のリクエストとして S3 に届きます。',
            command: `curl -i ${SITE_URL}`,
            done: (c) => !!lastRequestTo(c, siteHost(c.env)),
          },
        ],
        validate: (c) =>
          lastRequestTo(c, siteHost(c.env))?.status === 403
            ? ok(
                node('`HTTP/1.1 403 Forbidden`、本文には `<Code>AccessDenied</Code>` でした。本当に門前払いだ。'),
                hakase('匿名のリクエストを許可するものが何もないからだ。公開するには、**バケットポリシー**で Principal `"*"` に `s3:GetObject` を許可する必要がある。'),
                node('でも、その前にブロックパブリックアクセスが立ちはだかる、と。'),
                hakase('うむ。次の表で、その安全装置の中身を見よう。4 つのスイッチでできておる。'),
              )
            : ng(hakase(`まだ 403 を確認していないようだ。\`curl -i ${SITE_URL}\` と打つのだ。バケット名の後ろの \`.s3.ap-northeast-1.amazonaws.com\` を書き間違えておらんか？`)),
      },
      4: {
        type: 'table',
        title: 'ブロックパブリックアクセスの 4 つの設定',
        columns: ['設定 (API のキー)', '効果'],
        rows: [
          ['`BlockPublicAcls`', '公開する ACL の新規設定を拒否'],
          ['`IgnorePublicAcls`', '既存の公開 ACL を無視'],
          ['`BlockPublicPolicy`', 'Principal `"*"` を許可するポリシーの**保存を拒否**'],
          ['`RestrictPublicBuckets`', '公開ポリシーがあっても、匿名 / 他アカウントからのアクセスを**無視**'],
        ],
      },
      5: {
        type: 'dialogue',
        lines: [
          node('4 つもあるんですね。`Block〜` と、`Ignore〜` や `Restrict〜` は何が違うんですか？'),
          hakase('`Block〜` は、**これから**公開しようとする設定を拒否する。`Ignore〜` と `Restrict〜` は、**すでにある**公開設定を無視する。入口で止めるか、入られても相手にしないかの違いだ。'),
          node('門番と、話しかけられても無視する受付、みたいな感じですか。'),
          hakase('うむ。君の報告書を読まずに机に積んでおくワシが、無視するほうだな。'),
          node('読んでくださいよ。'),
          hakase('上の 2 つは ACL、下の 2 つはバケットポリシーについての設定だ。今回は ACL を使わない (ACL は無効) から、上の 2 つはオンのままでよい。'),
          node('じゃあ、バケットポリシーに関する下の 2 つだけをオフにするんですね。'),
          hakase('そうだ。しかも**このバケットだけ**だ。レポートのバケットには絶対に触ってはならんぞ。'),
          node('触ったらどうなるんですか？'),
          hakase('社外秘の売上 CSV が全世界に配信され、君の名前が障害報告書の 1 行目に載る。ワシが丁寧に書いてやろう。'),
          node('絶対に触りません。'),
          hakase('今の設定は `aws s3api get-public-access-block` で見る。変えるのは `put-public-access-block` で、`--public-access-block-configuration` に 4 つを `キー=true` か `キー=false` で**全部**並べる。書かなかったものは false、つまりオフになるから気をつけたまえ。'),
          node('打ち間違えたら、確認の画面とか出ますよね？'),
          hakase('CLI にそんな親切はない。Enter を押した瞬間に変わる。打つ前に、バケット名を指差し確認するのだ。'),
        ],
      },
      6: {
        type: 'exercise',
        title: 'このバケットだけブロックパブリックアクセスを緩める',
        objective: `\`${PUBLIC_SITE_BUCKET}\` のブロックパブリックアクセスのうち、**バケットポリシーに関する 2 つ** (\`BlockPublicPolicy\` と \`RestrictPublicBuckets\`) をオフにする`,
        tasks: [
          {
            id: 'perm',
            title: '今の設定を `get-public-access-block` で見る',
            hint: `\`aws s3api get-public-access-block --bucket ${PUBLIC_SITE_BUCKET}\`。レポートのバケットと間違えないように。`,
            command: `aws s3api get-public-access-block --bucket ${PUBLIC_SITE_BUCKET}`,
            done: (c) => !!ranAws(c, 's3api get-public-access-block', (x) => param(x, 'bucket') === PUBLIC_SITE_BUCKET),
          },
          {
            id: 'edit',
            title: '下の 2 つだけを false にして `put-public-access-block`',
            hint: '`--public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false`。成功しても何も表示されません。',
            command: `aws s3api put-public-access-block --bucket ${PUBLIC_SITE_BUCKET} --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false`,
            done: (c) => bucketNamed(c.env, PUBLIC_SITE_BUCKET)?.blockPublicAccess.blockPublicPolicy === false,
          },
        ],
        validate: (c) => {
          const b = bucketNamed(c.env, PUBLIC_SITE_BUCKET)!;
          if (!Object.values(bucketNamed(c.env, REPORTS_BUCKET)!.blockPublicAccess).every(Boolean))
            return ng(hakase(`レポートのバケットのブロックパブリックアクセスが変わっておる！ \`aws s3api put-public-access-block --bucket ${REPORTS_BUCKET} --public-access-block-configuration ${BPA_ON}\` で、すぐに全部オンに戻すのだ。`), node('ひいい、報告書の 1 行目に自分の名前が見えました…'));
          if (b.blockPublicAccess.blockPublicPolicy || b.blockPublicAccess.restrictPublicBuckets)
            return ng(hakase('バケットポリシーに関する 2 つ (`BlockPublicPolicy` と `RestrictPublicBuckets`) がまだオンだ。`put-public-access-block` で、この 2 つを `=false`、ACL の 2 つを `=true` にして 4 つとも並べるのだ。'));
          if (!b.blockPublicAccess.blockPublicAcls || !b.blockPublicAccess.ignorePublicAcls)
            return ng(hakase('ACL の 2 つ (`BlockPublicAcls` と `IgnorePublicAcls`) までオフになっておる。書き忘れたものは false になるのだ。`BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false` と 4 つ並べて打ち直したまえ。'));
          return ok(
            hakase('よし。これでバケットポリシーで公開**できる**状態になった。まだ公開はされていないぞ。'),
            node('鍵を外しただけで、ドアはまだ閉まってる、みたいなことですね。'),
            hakase('うむ。ドアを開けるのがバケットポリシーだ。君の PC のホームに、**JSON** で書いたポリシーを `policy.json` として用意しておいた。`cat policy.json` で中身を見たまえ。'),
            node('Lesson 01 からずっと見てる `{ }` のやつですね。`"Effect": "Allow"` が許可で、`"Version": "2012-10-17"` は…書いた日ですか？ だいぶ古くないですか？'),
            hakase('ポリシーの書き方の版の日付だ。今もそれが最新なのだ。'),
          );
        },
      },
      7: { type: 'code', title: '公開用のバケットポリシー (`policy.json` として PC のホームに置いてある)', language: 'json', code: PUBLIC_POLICY },
      8: [
        {
          type: 'dialogue',
          lines: [
            node('このファイルを、どうやって AWS に渡すんですか？ 中身をコピーして貼り付けるんですか？'),
            hakase('`aws s3api put-bucket-policy --bucket バケット名 --policy file://policy.json` だ。'),
            node('ふぁいるころんすらっしゅすらっしゅ？'),
            hakase('オプションの値に `file://ファイル名` と書くと、CLI がそのファイルの中身を読んで値にしてくれる。長い JSON を 1 行に詰め込まずに済むわけだ。'),
            node('URL みたいな書き方なのに、行き先は自分の PC なんですね。'),
            hakase('うむ。`file://` を付け忘れると、`policy.json` という 11 文字そのものをポリシーとして送ってしまう。AWS に「それは JSON ではない」と突き返されるぞ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'バケットポリシーで GetObject を公開する',
          objective: 'バケットポリシーに、全員 (`"*"`) へ `s3:GetObject` だけを許可するステートメントを `put-bucket-policy` で保存する',
          tasks: [
            {
              id: 'edit',
              title: '`policy.json` を `put-bucket-policy` で保存する',
              hint: 'Resource の末尾の `/*` は「このバケットのすべてのオブジェクト」という意味です。成功しても何も表示されません。`aws s3api get-bucket-policy --bucket <バケット名>` で保存されたか確かめられます。',
              command: `aws s3api put-bucket-policy --bucket ${PUBLIC_SITE_BUCKET} --policy file://policy.json`,
              done: (c) => isPolicyPublic(bucketNamed(c.env, PUBLIC_SITE_BUCKET)?.policy),
            },
          ],
          validate: (c) => {
            const p = bucketNamed(c.env, PUBLIC_SITE_BUCKET)?.policy;
            if (!isPolicyPublic(p)) return ng(hakase(`まだ公開ポリシーが保存されていない。\`aws s3api put-bucket-policy --bucket ${PUBLIC_SITE_BUCKET} --policy file://policy.json\` を打つのだ。\`BlockPublicPolicy\` のエラーが出るなら、ブロックパブリックアクセスの下の 2 つがまだオンだ。`));
            const broad = evaluateIamPermission(c.env, { principal: { type: 'anonymous' }, action: 's3:PutObject', resource: objectArn(PUBLIC_SITE_BUCKET, 'x'), resourcePolicy: p }).decision === 'Allow';
            if (broad) return ng(hakase('待て、全員に書き込み (`s3:PutObject`) まで許可しておる！ 誰でもファイルを置き換えられてしまう。`policy.json` の Action を `s3:GetObject` だけにして、もう一度 `put-bucket-policy` するのだ。'), node('一晩でキャンペーンページが怪しい広告だらけになるやつですね…'));
            return ok(
              hakase('読み取りだけを全員に許可した。`Resource` の末尾の `/*` は「このバケットのすべてのオブジェクト」という意味だ。'),
              node('`Sid` の `PublicReadGetObject` って何ですか？'),
              hakase('`Statement` の中の 1 つ 1 つがルールで、`Sid` はその名札 (Statement ID) だ。動きには関係ないが、後で読む人が助かる。未来の君とかな。'),
              node('未来の僕が読んでくれるといいんですけど。'),
              hakase('期待はしておらん。さあ、`curl` で確かめよう。'),
            );
          },
        },
      ],
      9: {
        type: 'exercise',
        title: '公開されたことを確認する',
        objective: '`curl` で `index.html` のオブジェクト URL を開き、200 を確認する',
        tasks: [
          {
            id: 'browse',
            title: '`curl` でオブジェクト URL を開く → **200**',
            hint: '先ほどと同じ `curl -i ...` をもう一度打ちます (↑ キーで呼び出せます)。まだ 403 なら、ブロックパブリックアクセスとバケットポリシーの両方を見直します。',
            command: `curl -i ${SITE_URL}`,
            done: (c) => lastRequestTo(c, siteHost(c.env))?.status === 200,
          },
        ],
        validate: (c) =>
          lastRequestTo(c, siteHost(c.env))?.status === 200
            ? ok(
                node('`HTTP/1.1 200 OK` で、「Welcome to webapp!」の HTML が返ってきました！'),
                hakase('403 の門前払いが、バケットポリシー 1 枚で 200 に変わった。外した安全装置はこのバケットの 2 つだけ、許したのは読み取りだけだ。'),
                node('必要なところだけ、必要な分だけ開けた、ってことですね。'),
                hakase('うむ。これを**最小権限**という。全部開けるのは一瞬だが、流出の後始末は何年もかかるぞ。'),
              )
            : ng(hakase('最新のアクセスがまだ 200 ではない。`curl -i <オブジェクト URL>` をもう一度打つのだ。403 のままなら、`aws s3api get-bucket-policy` でバケットポリシーが保存できているか確かめたまえ。')),
      },
    },
  },

  'iam-role': {
    steps: {
      0: {
        type: 'dialogue',
        lines: [
          node('博士、`batch-1` で夜間バッチを動かすことになりました。夜中に S3 のレポート CSV を読んで、まとめて処理するプログラムです。'),
          hakase('溜めておいて一気に片付ける、バッチ処理だな。君の夏休みの宿題と同じだ。'),
          node('余計なお世話です。で、S3 を読むには**アクセスキー**を設定ファイルに書けばいいんですよね？ ネットで見ました。'),
          hakase('サーバーに置くなら、それは一番やってはいかん方法だ。'),
          node('え。そもそも、あくせすきーって何なんですか？'),
          hakase('**IAM** (Identity and Access Management) という、AWS で「誰が何をしてよいか」を管理するサービスがある。そこで作る利用者が **IAM ユーザー**、その人がプログラムから使うために発行する ID とパスワードの組がアクセスキーだ。'),
          node('社員証みたいなものですか。'),
          hakase('しかも自分で消すまで有効な社員証だ。実はこの PC の CLI も、`~/.aws/credentials` に書いた IAM ユーザー `learner` のアクセスキーで動いておる。'),
          node('え、じゃあ僕の PC も危ないんですか？'),
          hakase('人間が使う PC でも、本当は期限の短い鍵にしたいところだ。それは Lesson 41 でやる。だがサーバーの設定ファイルに書くのは、社員証をサーバーにテープで貼っておくようなものだ。漏れたら、世界中の誰かが君の会社の AWS で好き放題する。'),
          node('月末の請求書で気づくやつだ…'),
        ],
      },
      6: {
        type: 'dialogue',
        lines: [
          node('どこで打つんですか？ この PC のターミナルでいいんですか？'),
          hakase('この PC で打てば、答えるのは learner として動く君の PC の CLI だ。`batch-1` の中で打たねば意味がない。'),
          node('サーバーの中に入るんですか？ Lesson 10 で作ったキーペアで SSH するとか？'),
          hakase('**EC2 Instance Connect** を使えば、キーペアは要らん。接続のたびに使い捨ての鍵を送り込んでくれる。`aws ec2-instance-connect ssh --instance-id <インスタンス ID>` で入れる。'),
          node('入ったら、どうやって戻ってくるんですか？'),
          hakase('`exit` だ。プロンプトが `[ec2-user@ip-…]` の間は batch-1 の中、`learner@my-pc` に戻れば君の PC だ。どちらで打っておるか、常にプロンプトを見るのだ。'),
          node('インスタンス ID は、Lesson 03 の `--filters` と `--query` で取り出せばいいですね。'),
          hakase("うむ。`Name=tag:Name,Values=batch-1` で絞って、`--query 'Reservations[0].Instances[0].InstanceId'` だ。では、制服を着ていない batch-1 が自分を何者と名乗るか、見てやろう。比べるために、この PC が何と名乗るかも先に見ておくのだ。"),
        ],
      },
      7: {
        type: 'exercise',
        title: 'batch-1 に接続して「自分は誰か」を確認する',
        objective: 'PC と `batch-1` の中のそれぞれで `aws sts get-caller-identity` を実行し、答えを比べる',
        tasks: [
          { id: 'me', title: 'この PC で `aws sts get-caller-identity` を実行', hint: '比べるために、まず自分の PC の CLI が何者かを見ます。`Arn` の最後が `user/learner` なら IAM ユーザー learner です。', command: 'aws sts get-caller-identity', done: (c) => !!ranAws(c, 'sts get-caller-identity') },
          {
            id: 'connect',
            title: '`aws ec2-instance-connect ssh` で `batch-1` に入る',
            hint: `インスタンス ID は \`${FIND_BATCH}\` で取り出せます。プロンプトが \`[ec2-user@ip-…]\` に変われば成功です。`,
            command: ssh,
            done: (c) => inBatch(c) || nobodyOnBatch(c),
          },
          { id: 'run', title: 'batch-1 の中で `aws sts get-caller-identity` を実行', hint: 'プロンプトが `[ec2-user@ip-…]` になっていることを確かめてから打ちます。', command: 'aws sts get-caller-identity', done: nobodyOnBatch },
          { id: 'exit', title: '`exit` で自分の PC に戻る', hint: 'プロンプトが `learner@my-pc` に戻れば PC です。次の調べものは PC で打ちます。', command: 'exit', done: (c) => nobodyOnBatch(c) && backOnPc(c) },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /sts get-caller-identity/)?.errorCode === 'NoCredentials'
            ? ok(
                node('PC では `user/learner` だったのに、batch-1 の中だと `Unable to locate credentials` と出ました。「認証情報が見つからない」…ですよね。'),
                hakase('うむ。インスタンスに IAM ロールが付いていないから、認証情報がどこにもないのだ。PC の learner の鍵は、PC の中にしかない。'),
                node('社員証を持たずに出社した状態ですね。'),
                hakase('入館ゲートで止められて当然だ。`exit` で PC に戻ったら、着せる予定の制服 `batch-role` を調べよう。'),
              )
            : ng(hakase('batch-1 の中で `aws sts get-caller-identity` を打って結果を見るのだ。`aws ec2-instance-connect ssh --instance-id <batch-1 の ID>` で入り、プロンプトが `[ec2-user@ip-…]` に変わったのを確かめてから打ちたまえ。')),
      },
      8: {
        type: 'exercise',
        title: 'ロール batch-role を調べる',
        objective: '`aws iam get-role` で `batch-role` の**信頼ポリシー**を、`aws iam list-attached-role-policies` で**許可ポリシー**を確認する',
        tasks: [
          {
            id: 'role',
            title: '`aws iam get-role --role-name batch-role` で信頼ポリシーを見る',
            hint: 'batch-1 の中ではなく PC で打ちます。`AssumeRolePolicyDocument` が信頼ポリシーです。`Principal` に何が書かれているかを見ます。',
            command: 'aws iam get-role --role-name batch-role',
            done: (c) => !!ranAws(c, 'iam get-role', (x) => param(x, 'role-name') === 'batch-role'),
          },
          {
            id: 'attached',
            title: '`aws iam list-attached-role-policies --role-name batch-role` で許可ポリシーを見る',
            hint: 'ロールに付いている (アタッチされた) 管理ポリシーの一覧が出ます。',
            command: 'aws iam list-attached-role-policies --role-name batch-role',
            done: (c) => !!ranAws(c, 'iam list-attached-role-policies', (x) => param(x, 'role-name') === 'batch-role'),
          },
        ],
        validate: (c) =>
          ranAws(c, 'iam get-role', (x) => param(x, 'role-name') === 'batch-role') && ranAws(c, 'iam list-attached-role-policies', (x) => param(x, 'role-name') === 'batch-role')
            ? ok(
                hakase('`AssumeRolePolicyDocument` の Principal が `ec2.amazonaws.com` になっているな。この文書が信頼ポリシーで、EC2 がこのロールを**引き受けて**よい、という意味だ。'),
                node('制服を着てよい人の名簿に、EC2 が載っているってことですね。'),
                hakase('そうだ。そして `list-attached-role-policies` に出た `batch-s3-read` が、制服を着た後にできること、つまりアイデンティティベースポリシーだ。'),
                node('名簿もあって、仕事の中身も書いてある。あとは着せるだけですね。'),
              )
            : ng(hakase('PC で `aws iam get-role --role-name batch-role` と `aws iam list-attached-role-policies --role-name batch-role` を打つのだ。プロンプトが `[ec2-user@ip-…]` のままなら、まだ batch-1 の中だ。先に `exit` で戻りたまえ。')),
      },
      9: [
        {
          type: 'dialogue',
          lines: [
            hakase('EC2 はロールを**インスタンスプロファイル**という入れ物に入れて受け取る。制服をハンガーごと渡すようなものだ。'),
            node('いんすたんすぷろふぁいる？ その入れ物も作るんですか？'),
            hakase('コンソールで EC2 用のロールを作ると、同じ名前の入れ物が自動で用意される。CLI でロールを作ったときは、`create-instance-profile` と `add-role-to-instance-profile` の 2 手間が要る。'),
            node('batch-role はどっちなんですか？'),
            hakase('先輩がコンソールで作ったから、入れ物はもうある。`aws iam list-instance-profiles-for-role --role-name batch-role` で確かめたまえ。'),
            node('入れ物があったら、それを batch-1 に渡すんですね。'),
            hakase('`aws ec2 associate-iam-instance-profile` だ。associate は「関連付ける」。`--iam-instance-profile Name=batch-role` で、入れ物を名前で指定する。'),
            node('`キー=値` の shorthand ですね。Lesson 03 でタグを付けたときと同じだ。'),
            hakase('うむ。渡すのはロールの名前ではなく、**入れ物の名前**だぞ。今回はたまたま同じ名前だから、間違えようがないがな。…いや、君なら間違えるか。'),
            node('間違えませんよ！'),
          ],
        },
        {
          type: 'exercise',
          title: 'batch-1 に IAM ロールを付ける',
          objective: '`aws ec2 associate-iam-instance-profile` で、`batch-1` にインスタンスプロファイル `batch-role` を関連付ける',
          tasks: [
            {
              id: 'open',
              title: '`batch-role` のインスタンスプロファイルを確かめる',
              hint: '`aws iam list-instance-profiles-for-role --role-name batch-role`。`InstanceProfileName` が入れ物の名前です。',
              command: 'aws iam list-instance-profiles-for-role --role-name batch-role',
              done: (c) => !!ranAws(c, 'iam list-instance-profiles-for-role'),
            },
            {
              id: 'save',
              title: '`batch-1` にインスタンスプロファイル `batch-role` を関連付ける',
              hint: '`aws ec2 associate-iam-instance-profile --instance-id <batch-1 の ID> --iam-instance-profile Name=batch-role`。`"State": "associating"` と返れば受け付けられています。',
              command: (c) => `aws ec2 associate-iam-instance-profile --instance-id ${batchId(c.env) ?? 'i-xxxxxxxx'} --iam-instance-profile Name=batch-role`,
              done: (c) => !!batchId(c.env) && instanceRole(c.env, batchId(c.env)!).role?.roleName === 'batch-role',
            },
          ],
          validate: (c) =>
            batchId(c.env) && !instanceRole(c.env, batchId(c.env)!).problem
              ? ok(
                  hakase('ロールが付いた。これで batch-1 は制服を着た状態だ。'),
                  node('設定ファイルにキーを 1 文字も書いてないのに。'),
                  hakase('それがロールのよいところだ。もう一度 batch-1 に入って、「私は誰？」と聞いてみよう。'),
                )
              : ng(hakase('まだ batch-1 に batch-role が付いていない。PC で `aws ec2 associate-iam-instance-profile --instance-id <batch-1 の ID> --iam-instance-profile Name=batch-role` を打つのだ。今の関連付けは `aws ec2 describe-iam-instance-profile-associations` で見られる。')),
        },
      ],
      10: { type: 'code', title: '確認用コマンド (batch-1 の中で打つ)', language: 'bash', code: `aws sts get-caller-identity\naws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/` },
      11: {
        type: 'exercise',
        title: 'もう一度「自分は誰か」を確認する',
        objective: '`batch-1` に入り直し、`aws sts get-caller-identity` と `aws s3 ls` を実行して、どちらも成功させる',
        tasks: [
          { id: 'connect', title: 'もう一度 `batch-1` に入る', hint: '↑ キーで前の `aws ec2-instance-connect ssh ...` を呼び出せます。', command: ssh, done: (c) => inBatch(c) || whoOk(c) },
          { id: 'who', title: '`aws sts get-caller-identity` → `assumed-role/batch-role/...`', hint: 'batch-1 の中 (`[ec2-user@ip-…]`) で打ちます。', command: 'aws sts get-caller-identity', done: whoOk },
          { id: 'ls', title: `\`aws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/\``, hint: '上の確認用コマンドの 2 行目です。Lesson 20 で PC から打った `aws s3 ls` を、今度は batch-1 として打ちます。', command: `aws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/`, done: lsOk },
        ],
        validate: (c) =>
          whoOk(c) && lsOk(c)
            ? ok(
                node('Arn が `assumed-role/batch-role/i-…` になりました！ CSV の一覧も見えます。'),
                hakase('「assumed-role」は、EC2 がロールを**引き受けて**得た一時的な身分という意味だ。最後の `i-…` はインスタンス ID、誰が制服を着ているかの名札だな。'),
                node('アクセスキーはどこにも書いてないのに、ちゃんと S3 が読めた。'),
                hakase('鍵は AWS が配り、期限が来れば勝手に取り替える。人間に鍵を持たせないのが一番の防犯だ。何しろ人間が一番の脆弱性だからな。'),
              )
            : ng(hakase('2 つのコマンドがまだ成功していないようだ。`aws ec2-instance-connect ssh` で batch-1 に入ってから、上の確認用コマンドを 1 行ずつ打つのだ。`Unable to locate credentials` のままなら、batch-1 にロールが付いたか PC で確かめたまえ。')),
      },
    },
  },

  'access-denied': {
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          node('1 行目の `aws s3 cp` は、Lesson 20 で使ったコピーのコマンドですよね。'),
          hakase('そうだ。S3 URI で指したオブジェクトを手元にダウンロードする。バッチが毎晩やっている処理そのものだ。'),
          node('エラーに出てた HeadObject って何ですか？ 頭のオブジェクト？'),
          hakase('`aws s3 cp` が最初に呼ぶ S3 の API だ。「本体は要らん、大きさや更新日時などの情報 (ヘッダー) だけくれ」という問い合わせだ。'),
          node('API って、Lesson 01 で聞いた、プログラムから AWS に頼みごとをする窓口でしたよね。'),
          hakase('うむ。コンソールのボタンも CLI も、裏では API を呼んでおる。CLI は呼んだ API の名前をエラーにそのまま出すから、どこで断られたかが分かるのだ。'),
          node('HeadObject の時点で断られたから、ダウンロードまでたどり着けなかったんですね。'),
          hakase('そういうことだ。怪しいのは 2 か所。ロールに付いた IAM ポリシーと、バケットに貼られたバケットポリシーだ。'),
          node('Lesson 22 の表の、アイデンティティベースとリソースベースですね。'),
          hakase('うむ。どちらも疑え。ワシは部下の報告書も疑うがな。'),
          node('僕の報告書は疑わないでください。'),
          hakase('君の報告書が一番怪しい。さあ、batch-1 に入って再現するのだ。Lesson 22 と同じ `aws ec2-instance-connect ssh` だ。'),
        ],
      },
      3: {
        type: 'exercise',
        title: '症状を再現し、プリンシパルを確かめる',
        objective: '`batch-1` に入って失敗するコマンドを再現し、`aws sts get-caller-identity` で身分を確認する',
        tasks: [
          { id: 'connect', title: '`aws ec2-instance-connect ssh` で `batch-1` に入る', hint: `インスタンス ID は \`${FIND_BATCH}\` で取り出せます。`, command: ssh, done: (c) => inBatch(c) || cpRun(c) },
          { id: 'cp', title: `\`aws s3 cp s3://${REPORTS_BUCKET}/${KEY} .\` → 403`, hint: 'batch-1 の中 (`[ec2-user@ip-…]`) で、上の再現用コマンドの 1 行目を打ちます。', command: CP, done: cpRun },
          { id: 'who', title: '`aws sts get-caller-identity` を実行', hint: '出力の `Arn` を見て、どのロールとして動いているかを確認します。ロールが付いていなければ `Unable to locate credentials` になります。', command: 'aws sts get-caller-identity', done: (c) => !!lastRun(c, 'batch-1', /sts get-caller-identity/)?.ok },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /s3 cp s3:\/\//)?.output.includes('403') && lastRun(c, 'batch-1', /sts get-caller-identity/)?.ok
            ? ok(
                node('403 が再現しました。身分は `assumed-role/batch-role/…` です。'),
                hakase('ロールはちゃんと付いておる。「鍵がない」のではなく、「鍵はあるのに、どこかで断られている」のだ。'),
                node('じゃあ、なんで 403 としか出ないんですか？'),
                hakase('HEAD の応答には本文がないから、理由を書く場所がないのだ。封筒だけ返ってきて、手紙が入っていないようなものだな。'),
                hakase('理由を見るには、本体まで取りに行く `aws s3api get-object` を使う。Lesson 20 で使った、API をそのまま呼ぶほうのコマンドだ。'),
              )
            : ng(hakase('cp の 403 と get-caller-identity の両方を確認するのだ。`aws ec2-instance-connect ssh --instance-id <batch-1 の ID>` で batch-1 に入り、上の再現用コマンドを 1 行ずつ打ちたまえ。')),
      },
      5: {
        type: 'exercise',
        title: '詳しいエラーを見る',
        objective: 'batch-1 の中で `aws s3api get-object` を実行し、AccessDenied の理由を読む',
        tasks: [
          { id: 'get', title: '`aws s3api get-object ...` を実行', hint: 'batch-1 の中で、上のコマンドを打ちます。エラーメッセージを最後まで読みます。', command: GET, done: (c) => !!lastRun(c, 'batch-1', /s3api get-object/) },
          { id: 'exit', title: '`exit` で自分の PC に戻る', hint: 'バケットポリシーは PC から直します。プロンプトが `learner@my-pc` に戻れば PC です。', command: 'exit', done: (c) => !!lastRun(c, 'batch-1', /s3api get-object/) && backOnPc(c) },
        ],
        validate: (c) =>
          explicitDenySeen(c)
            ? ok(
                node('`with an explicit deny in a resource-based policy` です。'),
                hakase('**明示的な拒否**だ。IAM はまず Deny を探す。Deny が 1 つでも当たれば Allow が何枚あっても拒否だから、エラーにもまずそれが出る。場所はリソースベースポリシー、つまりバケットポリシーだ。'),
                node('バケットポリシーの Deny を消せばいいんですね。全部消しちゃえば早いですか？'),
                hakase('焼け野原にしてどうする。`DenyInsecureTransport` は、**Condition** (条件) で `aws:SecureTransport` が false のとき、つまり暗号化されていない HTTP で来た通信だけを拒否する大事な守りだ。消すのは batch-role を名指しした `DenyLegacyBatch` だけだ。'),
                node('犯人だけ捕まえて、警備員は残す、と。'),
              )
            : ng(hakase('get-object のエラーメッセージを最後まで読むのだ。batch-1 の中で、上の `aws s3api get-object ...` を打ちたまえ。')),
      },
      6: [
        {
          type: 'dialogue',
          lines: [
            node('バケットポリシーを直すのは、batch-1 の中からですか？'),
            hakase('batch-1 の制服では、バケットポリシーを見ることすら許されておらん。`exit` で PC に戻り、管理者の learner として直すのだ。'),
            node('まず今のポリシーを見ないと。`aws s3api get-bucket-policy` ですか？'),
            hakase('うむ。ただし答えの `Policy` は、JSON が丸ごと 1 本の**文字列**に詰め込まれておる。`"` の前が `\\` だらけで読みにくい。'),
            node('JSON の中に JSON…マトリョーシカですね。'),
            hakase('`--query Policy --output text` で取り出せば、中身の JSON が 1 行で素直に出る。それを読んで、`DenyLegacyBatch` の `{ }` だけを除いたポリシーを `put-bucket-policy` で送り直す。'),
            node('エディタが無いのに、どうやって直すんですか？'),
            hakase("1 行の JSON を選んでコピーし、`put-bucket-policy --bucket バケット名 --policy '…'` の `'…'` の中に貼り付けて、要らんところを消してから Enter だ。`--policy` には `file://` でなく、JSON をそのまま書いてもよい。"),
            node('`DenyLegacyBatch` の `{` から `}` まで、それと前のカンマを消す、と。'),
            hakase('そうだ。カンマを 1 つ残すだけで、AWS に「JSON ではない」と突き返される。障害対応中に限って、そういう 1 文字にやられるのだ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'バケットポリシーの明示的な拒否を外す',
          objective: `\`${REPORTS_BUCKET}\` のバケットポリシーから、batch-role を拒否しているステートメント (\`DenyLegacyBatch\`) だけを削除する`,
          tasks: [
            {
              id: 'open',
              title: '`aws s3api get-bucket-policy` で今のバケットポリシーを見る',
              hint: `PC で \`aws s3api get-bucket-policy --bucket ${REPORTS_BUCKET} --query Policy --output text\`。Effect が \`Deny\` のステートメントと、その Principal に注目します。`,
              command: `aws s3api get-bucket-policy --bucket ${REPORTS_BUCKET} --query Policy --output text`,
              done: (c) => !!ranAws(c, 's3api get-bucket-policy', (x) => param(x, 'bucket') === REPORTS_BUCKET),
            },
            {
              id: 'fix',
              title: '`DenyLegacyBatch` を除いたポリシーを `put-bucket-policy` で保存',
              hint: "`DenyInsecureTransport` (暗号化されていない通信の拒否) は大事な設定なので残します。JSON のカンマに注意。`--policy '{\"Version\":…}'` のように JSON をそのまま渡せます。",
              command: (c) => `aws s3api put-bucket-policy --bucket ${REPORTS_BUCKET} --policy '${withoutLegacy(c.env)}'`,
              done: (c) => batchCan(c.env) !== 'ExplicitDeny',
            },
          ],
          validate: (c) => {
            if (batchCan(c.env) === 'ExplicitDeny') return ng(hakase(`まだ batch-role はバケットポリシーで明示的に拒否されておる。\`aws s3api get-bucket-policy --bucket ${REPORTS_BUCKET} --query Policy --output text\` で今のポリシーを見て、\`"Sid":"DenyLegacyBatch"\` を含む \`{\` から \`}\` までを除いたものを \`put-bucket-policy\` で保存したかな？`));
            const p = bucketNamed(c.env, REPORTS_BUCKET)?.policy;
            const tls = p && statements(p).some((s) => s.Effect === 'Deny' && JSON.stringify(s.Condition ?? {}).includes('aws:SecureTransport'));
            if (!tls) return ng(hakase('む、`DenyInsecureTransport` まで消してしまったな。暗号化されていない HTTP での平文アクセスを拒否する大事な守りだ。Effect `Deny`、Principal `"*"`、Action `s3:*`、Condition `aws:SecureTransport` が `false` のステートメントを書き戻すのだ。'), node('全部消せば動く…はダメなんですね。'));
            return ok(
              hakase('必要な守りは残して、原因の Deny だけを外した。'),
              node('外科手術みたいですね。'),
              hakase('うむ。悪いところごと全部切れば、患者も助からん。さあ、もう一度 batch-1 に入って試そう。'),
            );
          },
        },
      ],
      7: {
        type: 'exercise',
        title: 'もう一度試す',
        objective: 'batch-1 に入り直し、`aws s3api get-object` を再実行する',
        tasks: [
          { id: 'connect', title: 'もう一度 `batch-1` に入る', hint: '↑ キーで前の `aws ec2-instance-connect ssh ...` を呼び出せます。', command: ssh, done: (c) => inBatch(c) || implicitDenySeen(c) },
          { id: 'get', title: '`aws s3api get-object ...` を再実行', hint: 'batch-1 の中で、さっきと同じコマンドを打ちます。↑ キーで呼び出せます。', command: GET, done: implicitDenySeen },
          { id: 'exit', title: '`exit` で自分の PC に戻る', hint: 'IAM ポリシーも PC から直します。', command: 'exit', done: (c) => implicitDenySeen(c) && backOnPc(c) },
        ],
        validate: (c) =>
          implicitDenySeen(c)
            ? ok(
                node('今度は `because no identity-based policy allows the s3:GetObject action` です！ エラーが変わりました。'),
                hakase('原因はもう 1 つあったのだ。「どのアイデンティティベースポリシーも GetObject を許可していない」、つまり batch-role の IAM ポリシーだ。'),
                node('拒否はされてないけど、許可もされてない？'),
                hakase('そうだ。どこにも Allow がなければ、**暗黙的な拒否**になる。「書いていないことはダメ」が IAM の基本だ。'),
                node('明示的な拒否を外したら、下に暗黙的な拒否が隠れてた…二重底ですね。'),
              )
            : ng(hakase('get-object を再実行して、エラーの理由が変わったか見るのだ。`aws ec2-instance-connect ssh` で batch-1 に入り、↑ キーで前の get-object を呼び出したまえ。')),
      },
      8: [
        {
          type: 'dialogue',
          lines: [
            node('batch-role の IAM ポリシーって、どうやって中身を見るんですか？'),
            hakase('PC に戻ってからだぞ。まず `aws iam list-attached-role-policies --role-name batch-role` で、付いておるポリシーの ARN を調べる。Lesson 22 でも打ったな。'),
            node('`batch-s3-read` でしたね。その中身は？'),
            hakase('管理ポリシーは、書き換えるたびに**バージョン**が増えていく。`aws iam get-policy` の `DefaultVersionId` が今使われておるバージョンで、中身は `aws iam get-policy-version --version-id v1` のようにバージョンを指定して見る。'),
            node('ばーじょん…書き換えた履歴が残るんですか。'),
            hakase('うむ。だから直すときも上書きではない。`aws iam create-policy-version --set-as-default` で、直した新しいバージョンを作り、それを使うバージョンに切り替える。'),
            node('中身の JSON はどうやって直すんです？ さっきみたいに貼り付けて消すんですか？'),
            hakase("今度は打ち間違いの直しだから、`sed` が楽だ。`--query PolicyVersion.Document > batch-policy.json` でファイルに保存し、`sed -i 's/間違い/正しい/g' batch-policy.json` で置き換える。s は substitute、置き換えだ。"),
            node('`-i` と最後の `g` は？'),
            hakase('`-i` はファイルそのものを書き換える、`g` は 1 行に何個あっても全部置き換える、だ。最後に `--policy-document file://batch-policy.json` で送る。'),
          ],
        },
        {
          type: 'exercise',
          title: 'IAM ポリシーを直す',
          objective: '`batch-role` のポリシー `batch-s3-read` の Resource を正しいバケット ARN に直す',
          tasks: [
            {
              id: 'open',
              title: '`aws iam get-policy-version` で `batch-s3-read` の中身を見る',
              hint: 'PC で `aws iam get-policy-version --policy-arn <ポリシーの ARN> --version-id <バージョン>`。ARN は `list-attached-role-policies` の `PolicyArn`、バージョンは `aws iam get-policy` の `DefaultVersionId` です。',
              command: (c) => `aws iam get-policy-version --policy-arn ${batchPolicyArn(c)} --version-id ${batchPolicy(c.env) ? versionOf(c.env, batchPolicy(c.env)!) : 'v1'}`,
              done: (c) => !!ranAws(c, 'iam get-policy-version', (x) => param(x, 'policy-arn') === batchPolicyArn(c)),
            },
            {
              id: 'fix',
              title: 'Resource を直したバージョンを `create-policy-version` で作り、使うバージョンにする',
              hint: `バケット名は \`${REPORTS_BUCKET}\` です。ポリシーの Resource をよく見比べましょう。\`--set-as-default\` を忘れると、新しいバージョンは作られても使われません。`,
              command: (c) => {
                const arn = batchPolicyArn(c);
                const v = batchPolicy(c.env) ? versionOf(c.env, batchPolicy(c.env)!) : 'v1';
                return `aws iam get-policy-version --policy-arn ${arn} --version-id ${v} --query PolicyVersion.Document > batch-policy.json && sed -i 's/webapp-report-/webapp-reports-/g' batch-policy.json && aws iam create-policy-version --policy-arn ${arn} --policy-document file://batch-policy.json --set-as-default`;
              },
              done: (c) => batchCan(c.env) === 'Allow',
            },
          ],
          validate: (c) =>
            batchCan(c.env) === 'Allow'
              ? ok(
                  node('`webapp-report-…` になってました。`reports` の s が抜けてた！'),
                  hakase('1 文字違えば ARN は別物だ。IAM は「たぶんこれのことだろう」とは察してくれん。'),
                  node('察してくれたら楽なのに。'),
                  hakase('察しのいいセキュリティは、泥棒にも察しがいい。'),
                )
              : ng(hakase(`まだポリシーが対象のオブジェクトを許可していない。\`batch-s3-read\` の Resource の ARN を、バケット名 \`${REPORTS_BUCKET}\` と 1 文字ずつ見比べるのだ。直したバージョンを作ったなら、\`--set-as-default\` を付け忘れていないか、\`aws iam get-policy\` の \`DefaultVersionId\` で確かめたまえ。`)),
        },
      ],
      9: {
        type: 'exercise',
        title: '復旧を確認する',
        objective: 'batch-1 に入り直し、最初に失敗した `aws s3 cp` が成功することを確認する',
        tasks: [
          { id: 'connect', title: 'もう一度 `batch-1` に入る', hint: '↑ キーで前の `aws ec2-instance-connect ssh ...` を呼び出せます。', command: ssh, done: (c) => inBatch(c) || !!lastRun(c, 'batch-1', /s3 cp s3:\/\//)?.ok },
          { id: 'cp', title: `\`${CP}\``, hint: 'batch-1 の中で、↑ キーを何度か押すと最初に打った `aws s3 cp` を呼び出せます。成功すると `download:` と表示されます。', command: CP, done: (c) => !!lastRun(c, 'batch-1', /s3 cp s3:\/\//)?.ok },
        ],
        validate: (c) =>
          lastRun(c, 'batch-1', /s3 cp s3:\/\//)?.ok
            ? ok(
                node('`download: …` と出ました！ `cat report-2026-09-28.csv` で中身も見えます。'),
                hakase('復旧だ。原因は 2 つ。バケットポリシーの明示的な拒否と、IAM ポリシーの ARN の打ち間違いだ。'),
                node('1 つ直したら終わりだと思ってました。'),
                hakase('障害の原因がいつも 1 つなら、ワシの障害報告書はもっと薄くて済んだのだがな。'),
              )
            : ng(hakase('まだ cp が成功していない。batch-1 に入って、最初の `aws s3 cp` をもう一度打つのだ。まだ 403 なら、get-object でエラーの理由を読み直したまえ。')),
      },
      10: {
        type: 'quiz',
        question: hakase('問題だ。IAM ポリシーで Allow、バケットポリシーで同じ操作を Deny。結果はどうなる？'),
        options: ['許可 (IAM ポリシーが優先)', '拒否 (明示的な拒否がすべてに優先)', '先に書かれた方が優先'],
        answer: 1,
        explanation: [
          hakase('正解。評価の順番は「明示的な拒否 → 許可 → どれにもなければ暗黙的な拒否」だ。Deny は切り札だ。'),
          hakase('IAM の**ポリシーシミュレーター**、CLI なら `aws iam simulate-principal-policy` を使えば、どのポリシーのどのステートメントが効くかを試算できるぞ。`--resource-policy` にバケットポリシーを渡せば、両方まとめて試せる。本番で試す前に、机の上で試すのだ。'),
        ],
      },
    },
  },
};

export default patches;
