import { hakase, ng, node, ok, type Lesson } from '../lesson/types';
import { evaluateIamPermission, instanceRole, statements } from '../sim/iam';
import { isPolicyPublic, objectArn } from '../sim/s3';
import { publicSiteEnv, PUBLIC_SITE_BUCKET, REPORTS_BUCKET, s3IamEnv } from '../sim/scenarios';
import type { AwsEnv } from '../sim/types';
import { bucketNamed, instanceNamed, lastRequestTo, lastRun, visited, visitedId } from './helpers';

const KEY = 'reports/2026/09/report-2026-09-28.csv';
const CP = `aws s3 cp s3://${REPORTS_BUCKET}/${KEY} .`;
const GET = `aws s3api get-object --bucket ${REPORTS_BUCKET} --key ${KEY} report.csv`;
const batchId = (env: AwsEnv) => instanceNamed(env, 'batch-1')?.instanceId;
const newAssets = (env: AwsEnv) => env.buckets.find((b) => b.name.startsWith('webapp-assets'));
const siteHost = (env: AwsEnv) => (bucketNamed(env, PUBLIC_SITE_BUCKET) ? `${PUBLIC_SITE_BUCKET}.s3.` : undefined);
const batchCan = (env: AwsEnv, withBucketPolicy: boolean) =>
  evaluateIamPermission(env, { principal: { type: 'role', roleName: 'batch-role', sessionName: batchId(env) ?? 'i' }, action: 's3:GetObject', resource: objectArn(REPORTS_BUCKET, KEY), resourcePolicy: withBucketPolicy ? bucketNamed(env, REPORTS_BUCKET)?.policy : undefined, context: { 'aws:SecureTransport': true } }).decision;

export const lesson20: Lesson = {
  id: 's3-basics',
  number: '20',
  title: 'S3 の基本',
  summary: 'バケット・オブジェクト・キー。フォルダは本当は存在しない',
  minutes: 25,
  startPath: '/console/home',
  scenario: () => s3IamEnv(),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、先輩に「月次レポートの CSV は S3 に置いてあるから見ておいて」って言われました。えすすりー、って何ですか？'),
        hakase('**S3**、Simple Storage Service の略だ。S が 3 つで S3 だ。'),
        node('じゃあ EC2 は Elastic Compute Cloud で、C が 2 つだから EC2 なんですね。'),
        hakase('ほう、冴えておるな。君の頭にもようやく電源が入ったか。'),
        node('褒めるか貶すか、どっちかにしてください。で、S3 ってファイルサーバーみたいなものですか？'),
        hakase('近いが少し違う。S3 は**オブジェクトストレージ**だ。'),
        node('おぶじぇくとすとれーじ？'),
        hakase('データ本体と、サイズや更新日時などの付帯情報 (**メタデータ**) をひとまとめにした「**オブジェクト**」を、1 つずつ丸ごと預かる倉庫だ。ファイルサーバーのように途中の数行だけ書き換える、といったことはできん。変えるときは丸ごと置き換える。'),
        node('丸ごと預けて、丸ごと受け取る。コインロッカーみたいですね。'),
        hakase('うむ。しかもこのロッカーは容量の上限を気にしなくてよいし、中身は自動で複数の AZ に複製される。'),
        node('AZ って、Lesson 02 でやった Availability Zone でしたよね。1 つのリージョンの中にある、互いに離れたデータセンター群。'),
        hakase('そうだ。1 つの AZ が水没しても、ほかの AZ に写しが残る。ワシが昔テープでバックアップを取っていたころは、テープごと水没したものだが。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('今さらっと怖いこと言いましたよね。'),
        hakase('昔の話だ。さて、S3 の登場人物は 2 つ。中身の**オブジェクト**と、それを入れる**バケット**だ。'),
        node('ばけっと？ 掃除のバケツですか？'),
        hakase('そのバケツだ。英語で bucket。データを放り込むバケツだと思えばよい。'),
        node('急に庶民的になりましたね。'),
        hakase('ただしバケットの名前は、**全世界の AWS アカウントで一意**でなければならん。世界に 1 つだ。1 つ。'),
        node('なんで 2 回言ったんですか。'),
        hakase(`大事だからだ。\`test\` のような名前は、とっくに誰かに取られておる。だから \`${REPORTS_BUCKET}\` のように、末尾に 12 桁の**アカウント ID** (AWS アカウントごとに振られる背番号) を付けて一意にするのが定番だ。`),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('オブジェクトにも名前はあるんですか？'),
        hakase('バケットの中でオブジェクトを区別する名前を**キー**という。ロッカーの番号札だな。例えば `reports/2026/09/report-2026-09-28.csv` だ。'),
        node('reports フォルダの中の、2026 フォルダの中の…'),
        hakase('そう見えるだろう？ だが S3 に**本物のフォルダはない**。これは / を含む 1 本の長い名前だ。'),
        node('え、じゃあフォルダに見えるのは？'),
        hakase('キーの先頭部分、**プレフィックス**だ。prefix は「前に付くもの」という意味だ。コンソールが / で区切って、フォルダのように見せてくれておるだけだ。'),
        node('名札に「営業部/1課/山田」って書いてあるだけで、営業部という部屋はない、みたいな？'),
        hakase('その通りだ。そしてバケット名とキーをつないだ `s3://バケット名/キー` が **S3 URI**、オブジェクトの住所だ。'),
        node('ゆーあーるあい？ URL の親戚ですか？'),
        hakase('親戚だ。URI はものを指し示す名前の総称で、URL はその一種だ。S3 URI は主に **AWS CLI**、つまりコマンドで AWS を操作する道具で使う。CLI は Lesson 22 で本格的に触るぞ。'),
      ],
    },
    {
      type: 'table',
      title: 'S3 の用語',
      columns: ['用語', '意味', '例'],
      rows: [
        ['バケット', 'オブジェクトの入れ物。名前は**全 AWS アカウントで一意**', `\`${REPORTS_BUCKET}\``],
        ['オブジェクト', '保存されるデータ本体 + メタデータ (サイズや更新日時などの付帯情報)', 'CSV、画像、ログ'],
        ['キー', 'バケット内でのオブジェクトの名前', '`reports/2026/09/report-2026-09-28.csv`'],
        ['プレフィックス', 'キーの先頭部分。コンソールではフォルダのように見える', '`reports/2026/09/`'],
        ['S3 URI', 'CLI などでオブジェクトを指す住所', `\`s3://${REPORTS_BUCKET}/reports/\``],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('では実物を見よう。S3 のコンソールを開くと、右上のリージョン表示が「**グローバル**」になる。'),
        node('Lesson 02 では東京リージョンに切り替えましたよね。S3 にはリージョンがないんですか？'),
        hakase('バケット自体はどこかのリージョンに作られる。だが名前は世界で一意だから、一覧は全リージョン分をまとめて見せるのだ。一覧の見出しは「**汎用バケット**」、普通のバケットのことだ。'),
        node('今日は見るだけですか？'),
        hakase('いや、自分のバケットも作ってもらう。そのとき**バージョニング**と**ブロックパブリックアクセス**を設定する。'),
        node('ばーじょにんぐ？'),
        hakase('上書きや削除をしても、前の版を残しておく仕組みだ。ワープロの「元に戻す」の、もっと執念深い版だな。'),
        node('間違えて消しても戻せるんですね。僕のためにあるような機能だ。'),
        hakase('自覚があるのはよいことだ。ブロックパブリックアクセスは、バケットをうっかり全世界に公開しないための安全装置だ。詳しくは次の Lesson 21 でやる。今日は「全部オン」とだけ覚えておけばよい。'),
        node('全部オン。了解です！'),
      ],
    },
    {
      type: 'exercise',
      title: '既存のバケットを見る',
      objective: `S3 コンソールで \`${REPORTS_BUCKET}\` を開き、\`reports/2026/09/\` の中のオブジェクトを表示する`,
      tasks: [
        { id: 'list', title: '検索バーで `S3` を開く (汎用バケット)', hint: 'S3 はグローバルなコンソールです。右上のリージョン表示が「グローバル」になります。', done: (c) => visited(c, '/s3/buckets') },
        { id: 'bucket', title: `\`${REPORTS_BUCKET}\` を開く`, hint: 'バケット名のリンクをクリックします。', done: (c) => visitedId(c, '/s3/buckets/', REPORTS_BUCKET) },
        { id: 'prefix', title: '`reports/` → `2026/` → `09/` とたどる', hint: 'フォルダのように見えるのはキーのプレフィックスです。', done: (c) => visited(c, /prefix=reports%2F2026%2F09%2F/) },
      ],
      validate: (c) =>
        visited(c, /prefix=reports%2F2026%2F09%2F/)
          ? ok(
              node('`reports/2026/09/` の中に CSV が 2 つありました。'),
              hakase('フォルダを 3 つくぐったように見えたが、実際は `reports/2026/09/report-2026-09-28.csv` という長いキーのオブジェクトが並んでいるだけだ。'),
              node('`reports/` も `2026/` も、プレフィックスで絞り込んで見せてくれてたんですね。'),
              hakase('うむ。S3 に本物のフォルダはない。ないフォルダの中で迷子になる新人は、毎年必ずおるがな。'),
            )
          : ng(hakase('まだ `reports/2026/09/` を開いていないようだ。バケット名をクリックしたら、`reports/` → `2026/` → `09/` と順にクリックしていくのだ。')),
    },
    {
      type: 'exercise',
      title: 'バケットを作成する',
      objective: '名前が `webapp-assets-` で始まるバケットを、ブロックパブリックアクセスはすべてオン、バージョニングを **有効** にして作成する',
      tasks: [
        { id: 'open', title: '**バケットを作成** を開く', hint: '汎用バケットの一覧の右上です。', done: (c) => visited(c, '/s3/create') },
        { id: 'create', title: 'バケット名 `webapp-assets-123456789012` / バージョニング「有効にする」で作成', hint: '`test` や `my-bucket` のような名前は他のアカウントが使っているため作れません。アカウント ID を付けると一意にしやすいです。', hotspotId: 's3-create-submit', done: (c) => !!newAssets(c.env) },
      ],
      validate: (c) => {
        const b = newAssets(c.env);
        if (!b) return ng(hakase('`webapp-assets-` で始まるバケットが見当たらん。汎用バケットの一覧で**バケットを作成**を押し、バケット名を `webapp-assets-123456789012` にして作るのだ。'));
        if (b.versioning !== 'Enabled') return ng(hakase('バージョニングが有効になっておらんぞ。作り直さなくてよい。バケットの**プロパティ**タブの「バケットのバージョニング」で**編集**を押し、「有効にする」を選んで保存するのだ。'));
        if (!Object.values(b.blockPublicAccess).every(Boolean)) return ng(hakase('ブロックパブリックアクセスがオフになっておる。**アクセス許可**タブの「ブロックパブリックアクセス (バケット設定)」の**編集**で、「パブリックアクセスをすべて ブロック」にチェックを入れて保存するのだ。'), node('作った初日に公開しかけるところでした…'));
        return ok(
          hakase('よし。バージョニングは有効、ブロックパブリックアクセスは全部オンだ。新しいバケットは既定で非公開だから、これで誰にも覗かれん。'),
          node('画面にあった「デフォルトの暗号化」は、何もしなくてよかったんですか？'),
          hakase('新しいバケットは、何もしなくても **SSE-S3** で暗号化される。Server-Side Encryption、保存するときに S3 側で暗号化してくれる仕組みだ。鍵の管理まで S3 がやってくれる。'),
          node('鍵の管理まで。僕の家の鍵より厳重ですね。'),
          hakase('君の家の鍵は、どうせ植木鉢の下にあるのだろう。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'オブジェクトをアップロードする',
      objective: '作成したバケットに、手元の任意のファイルをアップロードし、S3 URI をコピーする',
      tasks: [
        { id: 'upload', title: 'オブジェクトタブの **アップロード** → ファイルを選択 → **アップロード**', hint: 'シミュレーターではファイル名とサイズ (と小さなテキストの内容) だけを保存し、外部には送信しません。', hotspotId: 's3-upload', done: (c) => (newAssets(c.env)?.objects.length ?? 0) > 0 },
        { id: 'uri', title: 'オブジェクトを開き **S3 URI** をコピー', hint: 'オブジェクト名のリンク → プロパティ → S3 URI のコピーアイコン。', done: (c) => c.copied.some((x) => x.startsWith(`s3://${newAssets(c.env)?.name ?? '-'}/`)) },
      ],
      validate: (c) =>
        c.copied.some((x) => x.startsWith(`s3://${newAssets(c.env)?.name ?? '-'}/`))
          ? ok(
              hakase('コピーした `s3://…` が **S3 URI** だ。アプリやスクリプトからオブジェクトを指すときの住所だ。'),
              node('CLI だと `aws s3 cp s3://…` みたいに使うんですよね。'),
              hakase('うむ。cp は copy、S3 と手元の間でファイルをコピーするコマンドだ。Lesson 22 からは毎日のように打つことになるぞ。'),
              node('住所さえ控えておけば、コマンドからも取り出せる、と。メモしておきます。'),
              hakase('メモをなくさんようにな。君の記憶は揮発性メモリだからな。'),
            )
          : ng(hakase('まだ S3 URI をコピーしていないようだ。オブジェクトタブの**アップロード**でファイルを上げたら、そのオブジェクト名をクリックし、プロパティにある S3 URI のコピーアイコンを押すのだ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。`test` という名前でバケットを作ろうとしたら失敗した。なぜかな？'),
      options: ['名前が短すぎるから', 'バケット名は全 AWS アカウントで一意で、既に誰かが使っているから', 'リージョンが違うから'],
      answer: 1,
      explanation: [
        hakase('正解。バケット名は、全 AWS アカウントで共有する 1 冊の名簿に載る。`test` のような名前は、とっくの昔に誰かが取っておる。'),
        hakase('会社名・用途・アカウント ID を組み合わせて付けるのが定番だ。早い者勝ちの世界だからな。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('では、バージョニングを有効にしたバケットでオブジェクトを削除すると、どうなるかな？'),
      options: ['完全に消えて戻せない', '「削除マーカー」が付き、古いバージョンは残る', '削除できない'],
      answer: 1,
      explanation: [
        hakase('正解。削除すると、最新の版として「**削除マーカー**」という目印が乗るだけで、古いバージョンは残る。'),
        node('削除マーカーを消せば、元に戻るってことですね。'),
        hakase('そうだ。誤削除や上書きに備えるならバージョニングは有効にしておくのだ。ただし古い版の分も保存料金はかかる。安心料だと思って払いたまえ。'),
      ],
    },
  ],
};

const PUBLIC_POLICY = JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'PublicReadGetObject', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${PUBLIC_SITE_BUCKET}/*` }] }, null, 2);

export const lesson21: Lesson = {
  id: 's3-public-access',
  number: '21',
  title: 'ブロックパブリックアクセスとバケットポリシー',
  summary: '既定で非公開の S3 を、必要なバケットだけ意図して公開する',
  minutes: 20,
  startPath: '/s3/buckets',
  scenario: publicSiteEnv,
  steps: [
    {
      type: 'dialogue',
      lines: [
        node(`博士、キャンペーン用の静的ページを \`${PUBLIC_SITE_BUCKET}\` に置きました。URL を開けば、お客さんに見てもらえますよね？`),
        hakase('せいてきページとは何か、言えるかな？'),
        node('静かなページ…じゃなくて、HTML や画像を、サーバーでプログラムを動かさずにそのまま返すだけのページです。'),
        hakase('正解だ。それなら EC2 を立てずとも、S3 のオブジェクトをそのまま配ればよい。'),
        node('で、URL ってどれですか？ Lesson 20 でコピーした `s3://…` ですか？'),
        hakase('あれは **S3 URI**、CLI 用の住所だったな。ブラウザで開くのは**オブジェクト URL**のほうだ。`https://バケット名.s3.リージョン.amazonaws.com/キー` という形をしておる。'),
        node('住所が 2 つあるんですね。社内便の宛先と、郵便の住所みたいな。'),
        hakase('そんなところだ。ただし開いても、たぶん見られんぞ。S3 は**既定ですべて非公開**だからな。'),
        node('え、せっかく置いたのに？'),
        hakase('置いただけで世界に公開されたら、給与明細の CSV を置いた瞬間に全社員の年収が世界に知れ渡る。君の年収もな。'),
        node('それは…ある意味、僕が一番恥ずかしいやつです。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('非公開のオブジェクトを名乗らずに開くと、**403 Forbidden** が返る。'),
        node('よんまるさん？ 502 や 503 は Lesson 17 でやりましたけど。'),
        hakase('5xx はサーバー側の失敗だったな。4xx は「頼んだ側に問題がある」という意味だ。403 は「君が誰であれ、ここは通さん」という門前払いだ。S3 はエラーコードとして `AccessDenied` を返す。'),
        node('門前払い…。じゃあ、公開するにはどうするんですか？'),
        hakase('**バケットポリシー**を書く。バケットに貼る「誰に、何を、どれについて許すか」の張り紙だ。'),
        node('張り紙ですか。意外とアナログですね。'),
        hakase('書くことは 3 つ。「**誰に** (Principal)」「**何を** (Action)」「**どれに** (Resource)」だ。'),
        node('ぷりんしぱる？'),
        hakase('頼んでくる相手のことだ。`"*"` と書けば、名乗らない**匿名**の人も含めた全員になる。Action は操作の名前で、オブジェクトを取り出すなら `s3:GetObject` だ。'),
        node('Resource には何を書くんですか？'),
        hakase('**ARN** だ。Amazon Resource Name、AWS のリソースを世界で 1 つに特定する名前だ。S3 なら `arn:aws:s3:::バケット名/キー` の形になる。'),
        node('あーん…？ 口を開けて待ってたら、誰かポリシーを書いてくれませんかね。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('待っていて届くのは始末書だけだ。ちなみに公開の手段には、**ACL** という古いやり方もある。'),
        node('ACL って、Lesson 09-2 のネットワーク ACL ですか？'),
        hakase('同じアクセスコントロールリストという名前だが、別物だ。S3 の ACL は、バケットやオブジェクトごとに付ける昔ながらの許可リストだ。今は無効にしてバケットポリシーで管理するのが推奨で、このバケットも ACL は無効だ。'),
        node('名前がかぶってるの、ややこしいですね…'),
        hakase('文句は命名した者に言いたまえ。そしてもう 1 つ。Lesson 20 で「全部オン」にした**ブロックパブリックアクセス**を覚えておるか。'),
        node('「今日は全部オンとだけ覚えておけ」って言われたやつですね。'),
        hakase('そうだ。あれがオンのままでは、公開するポリシーは保存すらできん。まずは本当に 403 になるか、自分の目で確かめたまえ。'),
      ],
    },
    {
      type: 'exercise',
      title: 'オブジェクト URL を開いてみる',
      objective: '`index.html` のオブジェクト URL をブラウザで開き、403 になることを確認する',
      tasks: [
        { id: 'open', title: `\`${PUBLIC_SITE_BUCKET}\` の \`index.html\` を開いて **オブジェクト URL** をコピー`, hint: 'オブジェクト名のリンク → プロパティ → オブジェクト URL。', hotspotId: 's3-object-url', done: (c) => c.copied.some((x) => x.includes(`${PUBLIC_SITE_BUCKET}.s3.`)) },
        { id: 'browse', title: '「ブラウザ」タブに貼り付けて **移動**', hint: 'URL 欄に Ctrl+V で貼り付けます。ブラウザからのアクセスは、認証情報を持たない匿名のリクエストとして S3 に届きます。', done: (c) => !!lastRequestTo(c, siteHost(c.env)) },
      ],
      validate: (c) =>
        lastRequestTo(c, siteHost(c.env))?.status === 403
          ? ok(
              node('403 Forbidden、`AccessDenied` でした。本当に門前払いだ。'),
              hakase('匿名のリクエストを許可するものが何もないからだ。公開するには、**バケットポリシー**で Principal `"*"` に `s3:GetObject` を許可する必要がある。'),
              node('でも、その前にブロックパブリックアクセスが立ちはだかる、と。'),
              hakase('うむ。次の表で、その安全装置の中身を見よう。4 つのスイッチでできておる。'),
            )
          : ng(hakase('まだ 403 を確認していないようだ。`index.html` のプロパティからオブジェクト URL をコピーし、パネルの「ブラウザ」タブに貼り付けて**移動**するのだ。')),
    },
    {
      type: 'table',
      title: 'ブロックパブリックアクセスの 4 つの設定',
      columns: ['設定', '効果'],
      rows: [
        ['新しい ACL を介したパブリックアクセスをブロック', '公開する ACL の新規設定を拒否'],
        ['任意の ACL を介したパブリックアクセスをブロック', '既存の公開 ACL を無視'],
        ['新しいパブリックバケットポリシーを介したパブリックアクセスをブロック', 'Principal `"*"` を許可するポリシーの**保存を拒否**'],
        ['任意のパブリックバケットポリシーを介したアクセスをブロック', '公開ポリシーがあっても、匿名 / 他アカウントからのアクセスを**無視**'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('4 つもあるんですね。「新しい〜」と「任意の〜」は何が違うんですか？'),
        hakase('「新しい」は、**これから**公開しようとする設定を拒否する。「任意の」は、**すでにある**公開設定を無視する。入口で止めるか、入られても相手にしないかの違いだ。'),
        node('門番と、話しかけられても無視する受付、みたいな感じですか。'),
        hakase('うむ。君の報告書を読まずに机に積んでおくワシが「任意の」ほうだな。'),
        node('読んでくださいよ。'),
        hakase('上の 2 つは ACL、下の 2 つはバケットポリシーについての設定だ。今回は ACL を使わない (ACL は無効) から、上の 2 つはオンのままでよい。'),
        node('じゃあ、バケットポリシーに関する下の 2 つだけをオフにするんですね。'),
        hakase('そうだ。しかも**このバケットだけ**だ。レポートのバケットには絶対に触ってはならんぞ。'),
        node('触ったらどうなるんですか？'),
        hakase('社外秘の売上 CSV が全世界に配信され、君の名前が障害報告書の 1 行目に載る。ワシが丁寧に書いてやろう。'),
        node('絶対に触りません。'),
        hakase('オフにするときは、確認のダイアログで「確認」と入力させられる。AWS も君をあまり信用しておらんということだ。'),
        node('AWS にまで疑われてる…'),
      ],
    },
    {
      type: 'exercise',
      title: 'このバケットだけブロックパブリックアクセスを緩める',
      objective: `\`${PUBLIC_SITE_BUCKET}\` のブロックパブリックアクセスのうち、**バケットポリシーに関する 2 つ**をオフにする`,
      tasks: [
        { id: 'perm', title: 'バケットの **アクセス許可** タブを開く', hint: `S3 > 汎用バケットで \`${PUBLIC_SITE_BUCKET}\` を開き、上部のタブ (オブジェクト / プロパティ / アクセス許可) から選びます。レポートのバケットと間違えないように。`, done: (c) => visited(c, new RegExp(`/s3/buckets/${PUBLIC_SITE_BUCKET}\\?tab=permissions`)) },
        { id: 'edit', title: 'ブロックパブリックアクセスの **編集** → 下の 2 つのチェックを外す → **変更の保存** → 「確認」と入力', hint: '確認のダイアログで「確認」と入力して確定します。', hotspotId: 's3-edit-bpa', done: (c) => bucketNamed(c.env, PUBLIC_SITE_BUCKET)?.blockPublicAccess.blockPublicPolicy === false },
      ],
      validate: (c) => {
        const b = bucketNamed(c.env, PUBLIC_SITE_BUCKET)!;
        if (!Object.values(bucketNamed(c.env, REPORTS_BUCKET)!.blockPublicAccess).every(Boolean)) return ng(hakase(`レポートのバケットのブロックパブリックアクセスが変わっておる！ \`${REPORTS_BUCKET}\` の**アクセス許可**タブで編集し、すぐに全部オンに戻すのだ。`), node('ひいい、報告書の 1 行目に自分の名前が見えました…'));
        if (b.blockPublicAccess.blockPublicPolicy || b.blockPublicAccess.restrictPublicBuckets) return ng(hakase('バケットポリシーに関する 2 つ (新しいパブリックバケットポリシー / 任意のパブリックバケットポリシー) がまだオンだ。ブロックパブリックアクセスの**編集**で下の 2 つのチェックを外し、**変更の保存** → 「確認」と入力して確定するのだ。'));
        return ok(
          hakase('よし。これでバケットポリシーで公開**できる**状態になった。まだ公開はされていないぞ。'),
          node('鍵を外しただけで、ドアはまだ閉まってる、みたいなことですね。'),
          hakase('うむ。ドアを開けるのがバケットポリシーだ。下に **JSON** で書いたポリシーを用意した。`{ }` の中に `"名前": 値` を並べていく書式だ。'),
          node('じぇいそん…ホラー映画じゃないんですね。`"Effect": "Allow"` が許可で、`"Version": "2012-10-17"` は…書いた日ですか？ だいぶ古くないですか？'),
          hakase('ポリシーの書き方の版の日付だ。今もそれが最新なのだ。コピーして貼り付けたまえ。'),
        );
      },
    },
    { type: 'code', title: '公開用のバケットポリシー (コピーして使う)', language: 'json', code: PUBLIC_POLICY },
    {
      type: 'exercise',
      title: 'バケットポリシーで GetObject を公開する',
      objective: 'バケットポリシーに、全員 (`"*"`) へ `s3:GetObject` だけを許可するステートメントを保存する',
      tasks: [
        { id: 'edit', title: 'バケットポリシーの **編集** に上のポリシーを貼り付けて **変更の保存**', hint: 'Resource の末尾の `/*` は「このバケットのすべてのオブジェクト」という意味です。', hotspotId: 's3-edit-policy', done: (c) => isPolicyPublic(bucketNamed(c.env, PUBLIC_SITE_BUCKET)?.policy) },
      ],
      validate: (c) => {
        const p = bucketNamed(c.env, PUBLIC_SITE_BUCKET)?.policy;
        if (!isPolicyPublic(p)) return ng(hakase('まだ公開ポリシーが保存されていない。**アクセス許可**タブのバケットポリシーの**編集**に上の JSON を貼り付け、**変更の保存**を押すのだ。`BlockPublicPolicy` のエラーが出るなら、ブロックパブリックアクセスの下の 2 つがまだオンだ。'));
        const broad = evaluateIamPermission(c.env, { principal: { type: 'anonymous' }, action: 's3:PutObject', resource: objectArn(PUBLIC_SITE_BUCKET, 'x'), resourcePolicy: p }).decision === 'Allow';
        if (broad) return ng(hakase('待て、全員に書き込み (`s3:PutObject`) まで許可しておる！ 誰でもファイルを置き換えられてしまう。Action は `s3:GetObject` だけにするのだ。'), node('一晩でキャンペーンページが怪しい広告だらけになるやつですね…'));
        return ok(
          hakase('読み取りだけを全員に許可した。`Resource` の末尾の `/*` は「このバケットのすべてのオブジェクト」という意味だ。'),
          node('`Sid` の `PublicReadGetObject` って何ですか？'),
          hakase('`Statement` の中の 1 つ 1 つがルールで、`Sid` はその名札 (Statement ID) だ。動きには関係ないが、後で読む人が助かる。未来の君とかな。'),
          node('未来の僕が読んでくれるといいんですけど。'),
          hakase('期待はしておらん。さあ、ブラウザで確かめよう。'),
        );
      },
    },
    {
      type: 'exercise',
      title: '公開されたことを確認する',
      objective: 'ブラウザで `index.html` のオブジェクト URL を開き、200 を確認する',
      tasks: [{ id: 'browse', title: 'ブラウザで オブジェクト URL を開く → **200**', hint: '「ブラウザ」タブで先ほどと同じオブジェクト URL をもう一度 **移動** します。まだ 403 なら、ブロックパブリックアクセスとバケットポリシーの両方を見直します。', done: (c) => lastRequestTo(c, siteHost(c.env))?.status === 200 }],
      validate: (c) =>
        lastRequestTo(c, siteHost(c.env))?.status === 200
          ? ok(
              node('「Welcome to webapp!」と表示されました。200 です！'),
              hakase('403 の門前払いが、バケットポリシー 1 枚で 200 に変わった。外した安全装置はこのバケットの 2 つだけ、許したのは読み取りだけだ。'),
              node('必要なところだけ、必要な分だけ開けた、ってことですね。'),
              hakase('うむ。これを**最小権限**という。全部開けるのは一瞬だが、流出の後始末は何年もかかるぞ。'),
            )
          : ng(hakase('最新のアクセスがまだ 200 ではない。「ブラウザ」タブでオブジェクト URL を開いて**移動**を押すのだ。403 のままなら、バケットポリシーが保存できているか確かめたまえ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。ブロックパブリックアクセスが全部オンのまま、Principal `"*"` のバケットポリシーを保存しようとするとどうなる？'),
      options: ['保存できて公開される', '保存できない (AccessDenied: BlockPublicPolicy)', '保存できるが警告だけ出る'],
      answer: 1,
      explanation: [
        hakase('正解。`BlockPublicPolicy` に止められて、保存そのものができん。だから「うっかり公開」が起きにくいのだ。'),
        hakase('同じ設定はアカウント全体にもあり、会社ではアカウントレベルでオンにしておくことが多い。人間のうっかりは、仕組みで止めるのが一番だ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('本番の Web サイトで画像を配信したい。もっとも推奨される方法はどれかな？'),
      options: ['すべてのバケットを公開する', 'バケットは非公開のまま CloudFront (OAC) 経由で配信する', 'IAM ユーザーのアクセスキーを HTML に埋め込む'],
      answer: 1,
      explanation: [
        hakase('正解。バケットは非公開のまま、**CloudFront** という配信サービスだけが読めるようにするのが今の定番だ。OAC (Origin Access Control) は、その「CloudFront にだけ読ませる」仕組みの名前だ。'),
        node('アクセスキーを HTML に埋め込むのは…'),
        hakase('「ソースを表示」した全員に合鍵を配るようなものだ。翌月の請求書が君の年収を超えるぞ。CloudFront は Lesson 36 からじっくりやる。'),
      ],
    },
  ],
};

export const lesson22: Lesson = {
  id: 'iam-role',
  number: '22',
  title: 'IAM ロールと信頼ポリシー',
  summary: 'EC2 にアクセスキーを置かず、ロールで一時的な認証情報を渡す',
  minutes: 25,
  startPath: '/ec2/instances',
  scenario: () => s3IamEnv({ attachProfile: false }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、`batch-1` で夜間バッチを動かすことになりました。夜中に S3 のレポート CSV を読んで、まとめて処理するプログラムです。'),
        hakase('溜めておいて一気に片付ける、バッチ処理だな。君の夏休みの宿題と同じだ。'),
        node('余計なお世話です。で、S3 を読むには**アクセスキー**を設定ファイルに書けばいいんですよね？ ネットで見ました。'),
        hakase('それは一番やってはいかん方法だ。'),
        node('え。そもそも、あくせすきーって何なんですか？'),
        hakase('**IAM** (Identity and Access Management) という、AWS で「誰が何をしてよいか」を管理するサービスがある。そこで作る利用者が **IAM ユーザー**、その人がプログラムから使うために発行する ID とパスワードの組がアクセスキーだ。'),
        node('社員証みたいなものですか。'),
        hakase('しかも自分で消すまで有効な社員証だ。設定ファイルに書くのは、それをサーバーにテープで貼っておくようなものだ。漏れたら、世界中の誰かが君の会社の AWS で好き放題する。'),
        node('月末の請求書で気づくやつだ…'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('そこで EC2 には **IAM ロール**を付ける。ロールは「役割」、制服のようなものだ。警備員の制服を着た者は、警備員として振る舞える。'),
        node('EC2 に制服を着せるんですか？'),
        hakase('うむ。ロールを着た EC2 は、**一時的な認証情報**を自動で受け取れる。数時間で期限が切れる合鍵だ。'),
        node('期限が切れたら？'),
        hakase('切れる前に、AWS が勝手に新しい鍵に取り替える。この定期的な取り替えを**ローテーション**という。アクセスキーだと、人間が手でやるしかない。'),
        node('人間は忘れますもんね。'),
        hakase('君のようにな。さて、IAM で決めるのは「**誰が** (プリンシパル)、**何を** (アクション)、**どれに** (リソース)」してよいか、だ。'),
        node('Lesson 21 のバケットポリシーに出てきた Principal、Action、Resource ですね！'),
        hakase('ほう。1 レッスン前の話を覚えておるとは。君の記憶にも、ようやく保存ボタンが付いたか。'),
      ],
    },
    {
      type: 'dialogue',
      lines: [
        hakase('そのルールを書いた文書が**ポリシー**だ。どこに貼るかで呼び名が変わる。Lesson 21 のバケットポリシーは、S3 バケットという**リソース**に貼るから**リソースベースポリシー**だ。'),
        node('じゃあ、ロールに貼るのは？'),
        hakase('ユーザーやロールという「ID」に貼るのが**アイデンティティベースポリシー**だ。アイデンティティは身元、身分のことだ。'),
        node('「この身分の者は何をしてよいか」を書くんですね。'),
        hakase('そうだ。そしてロールだけが持つのが**信頼ポリシー**。「誰がこの制服を着てよいか」、つまりロールを**引き受けて**よい相手の名簿だ。EC2 に着せるなら、名簿に `ec2.amazonaws.com` と書く。'),
        node('名簿に載ってないと、制服は着られない、と。表で整理します。'),
      ],
    },
    {
      type: 'table',
      title: 'IAM ポリシーの種類',
      columns: ['種類', '付ける先', '決めること'],
      rows: [
        ['アイデンティティベースポリシー', 'ユーザー / ロール', 'その ID が何をしてよいか'],
        ['リソースベースポリシー', 'S3 バケットなどのリソース', '誰がそのリソースを使ってよいか'],
        ['信頼ポリシー', 'ロール', '**誰がそのロールを引き受けられるか** (例: ec2.amazonaws.com)'],
        ['明示的な拒否 (Deny)', 'どのポリシーにも書ける', 'どんな Allow よりも優先して拒否'],
      ],
    },
    {
      type: 'dialogue',
      lines: [
        node('表の一番下の「明示的な拒否 (Deny)」は？'),
        hakase('ポリシーには許可 (`Allow`) だけでなく、拒否 (`Deny`) も書ける。Deny はどんな Allow よりも優先する。Lesson 23 で、痛い目に遭いながら覚えてもらう。'),
        node('痛い目に遭う予定が決まってるんですね…'),
        hakase('さて、今の `batch-1` は制服を着ておらん。本当に鍵がないか、`aws sts get-caller-identity` で確かめる。'),
        node('えすてぃーえす？'),
        hakase('**STS** (Security Token Service)、一時的な認証情報を配る係だ。get-caller-identity は「今の私は誰？」と AWS に聞くコマンドだ。'),
        node('記憶喪失の人の第一声ですね。'),
        hakase('AWS 操作の第一声でもある。迷ったらまずこれを打て。'),
      ],
    },
    { type: 'code', title: 'EC2 上で最初に打つコマンド', language: 'bash', code: 'aws sts get-caller-identity' },
    {
      type: 'dialogue',
      lines: [
        node('どこで打つんですか？'),
        hakase('`batch-1` の中だ。**EC2 Instance Connect** を使えば、コンソールの「接続」からブラウザで入れる。開くのは**ターミナル**、コマンドを打つ黒い画面だ。'),
        node('Lesson 10 で決めたキーペアは要らないんですか？'),
        hakase('Instance Connect が、接続のたびに使い捨ての鍵を送り込んでくれる。中で打つ `aws` は **AWS CLI**、Lesson 20 で「S3 URI は CLI で使う住所」と言ったあれだ。'),
        node('コマンドで AWS を操作する道具、でしたね。'),
        hakase('うむ。では、制服を着ていない batch-1 が自分を何者と名乗るか、見てやろう。'),
      ],
    },
    {
      type: 'exercise',
      title: 'batch-1 に接続して「自分は誰か」を確認する',
      objective: '`batch-1` に EC2 Instance Connect で接続し、`aws sts get-caller-identity` を実行する',
      tasks: [
        { id: 'connect', title: 'インスタンス一覧で `batch-1` を選び **接続** → EC2 Instance Connect の **接続**', hint: '`batch-1` の行にチェックを付けると、一覧上部の **接続** が押せます。接続画面は「EC2 Instance Connect」タブのまま **接続** を押します。', hotspotId: 'ec2-connect-submit', done: (c) => visited(c, new RegExp(`${batchId(c.env)}/terminal`)) },
        { id: 'run', title: 'ターミナルで `aws sts get-caller-identity` を実行', hint: '入力して Enter。', hotspotId: 'terminal-input', done: (c) => !!lastRun(c, 'batch-1', /sts get-caller-identity/) },
      ],
      validate: (c) =>
        lastRun(c, 'batch-1', /sts get-caller-identity/)?.errorCode === 'NoCredentials'
          ? ok(
              node('`Unable to locate credentials` と出ました。「認証情報が見つからない」…ですよね。'),
              hakase('うむ。インスタンスに IAM ロールが付いていないから、認証情報がどこにもないのだ。'),
              node('社員証を持たずに出社した状態ですね。'),
              hakase('入館ゲートで止められて当然だ。次は、着せる予定の制服 `batch-role` を調べよう。'),
            )
          : ng(hakase('`aws sts get-caller-identity` を実行して結果を見るのだ。ターミナルは、インスタンス一覧で `batch-1` を選び、**接続** → EC2 Instance Connect の**接続**で開ける。')),
    },
    {
      type: 'exercise',
      title: 'ロール batch-role を調べる',
      objective: 'IAM > ロール > `batch-role` を開き、**信頼関係** と **許可** を確認する',
      tasks: [
        { id: 'role', title: 'IAM > ロール > `batch-role` を開く', hint: '検索バーで `IAM` → ロール。', done: (c) => visitedId(c, '/iam/roles/', 'batch-role') },
        { id: 'trust', title: '**信頼関係** タブを開く', hint: 'ロールの詳細の下に「許可」と「信頼関係」のタブがあります。信頼ポリシーの `Principal` に何が書かれているかを見ます。', done: (c) => visited(c, /\/iam\/roles\/batch-role\?tab=trust/) },
      ],
      validate: (c) =>
        visited(c, /\/iam\/roles\/batch-role\?tab=trust/)
          ? ok(
              hakase('信頼ポリシーの Principal が `ec2.amazonaws.com` になっているな。EC2 がこのロールを**引き受けて**よい、という意味だ。'),
              node('制服を着てよい人の名簿に、EC2 が載っているってことですね。'),
              hakase('そうだ。そして**許可**タブの `batch-s3-read` が、制服を着た後にできること、つまりアイデンティティベースポリシーだ。'),
              node('名簿もあって、仕事の中身も書いてある。あとは着せるだけですね。'),
              hakase('うむ。EC2 はロールを**インスタンスプロファイル**という入れ物に入れて受け取る。制服をハンガーごと渡すようなものだ。コンソールで付ければ入れ物は自動で用意されるから、気にせんでよい。'),
            )
          : ng(hakase('batch-role の**信頼関係**タブを開くのだ。IAM > ロール で `batch-role` をクリックすると、詳細の下にタブが並んでおる。')),
    },
    {
      type: 'exercise',
      title: 'batch-1 に IAM ロールを付ける',
      objective: '`batch-1` の **アクション > セキュリティ > IAM ロールを変更** で `batch-role` を選び、更新する',
      tasks: [
        { id: 'open', title: 'EC2 > インスタンス > `batch-1` → アクション → セキュリティ → **IAM ロールを変更**', hint: '**アクション** メニューは、一覧で `batch-1` にチェックを付けるか、インスタンスの詳細画面を開くと使えます。', done: (c) => visited(c, /modify-iam-role/) },
        { id: 'save', title: '`batch-role` を選んで **IAM ロールの更新**', hint: '「IAM ロール」のプルダウンの初期値は「IAM ロールがありません」です。ロールと同じ名前のインスタンスプロファイル `batch-role` を選びます。', hotspotId: 'ec2-update-iam-role', done: (c) => !!batchId(c.env) && instanceRole(c.env, batchId(c.env)!).role?.roleName === 'batch-role' },
      ],
      validate: (c) =>
        batchId(c.env) && !instanceRole(c.env, batchId(c.env)!).problem
          ? ok(
              hakase('ロールが付いた。これで batch-1 は制服を着た状態だ。'),
              node('設定ファイルにキーを 1 文字も書いてないのに。'),
              hakase('それがロールのよいところだ。もう一度ターミナルで「私は誰？」と聞いてみよう。'),
            )
          : ng(hakase('まだ batch-1 に batch-role が付いていない。インスタンス一覧で `batch-1` を選び、アクション → セキュリティ → **IAM ロールを変更** で `batch-role` を選んで **IAM ロールの更新** を押すのだ。')),
    },
    { type: 'code', title: '確認用コマンド', language: 'bash', code: `aws sts get-caller-identity\naws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/` },
    {
      type: 'exercise',
      title: 'もう一度「自分は誰か」を確認する',
      objective: 'ターミナルで `aws sts get-caller-identity` と `aws s3 ls` を実行し、どちらも成功させる',
      tasks: [
        { id: 'who', title: '`aws sts get-caller-identity` → `assumed-role/batch-role/...`', hint: 'ターミナルの画面は EC2 > batch-1 > 接続 から開き直せます。', done: (c) => !!lastRun(c, 'batch-1', /sts get-caller-identity/)?.ok },
        { id: 'ls', title: `\`aws s3 ls s3://${REPORTS_BUCKET}/reports/2026/09/\``, hint: '上の確認用コマンドの 2 行目をコピーして貼り付けます。`aws s3 ls` は、S3 URI で指定したプレフィックスの中身を一覧表示します。', done: (c) => !!lastRun(c, 'batch-1', /s3 ls s3:\/\//)?.ok },
      ],
      validate: (c) =>
        lastRun(c, 'batch-1', /sts get-caller-identity/)?.ok && lastRun(c, 'batch-1', /s3 ls s3:\/\//)?.ok
          ? ok(
              node('Arn が `assumed-role/batch-role/i-…` になりました！ CSV の一覧も見えます。'),
              hakase('「assumed-role」は、EC2 がロールを**引き受けて**得た一時的な身分という意味だ。最後の `i-…` はインスタンス ID、誰が制服を着ているかの名札だな。'),
              node('アクセスキーはどこにも書いてないのに、ちゃんと S3 が読めた。'),
              hakase('鍵は AWS が配り、期限が来れば勝手に取り替える。人間に鍵を持たせないのが一番の防犯だ。何しろ人間が一番の脆弱性だからな。'),
            )
          : ng(hakase('2 つのコマンドがまだ成功していないようだ。上の確認用コマンドを 1 行ずつターミナルで実行するのだ。`Unable to locate credentials` のままなら、batch-1 にロールが付いたか確かめたまえ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。batch-role の信頼ポリシーの Principal を、うっかり `lambda.amazonaws.com` (Lesson 33 で使う Lambda というサービス) に変えてしまった。batch-1 で `aws s3 ls` はどうなる？'),
      options: ['今まで通り成功する', 'EC2 がロールを引き受けられず、認証情報が得られない', 'Lambda 経由で成功する'],
      answer: 1,
      explanation: [
        hakase('正解。名簿から EC2 が消えたら、EC2 は制服を着られん。インスタンスメタデータ (`curl http://169.254.169.254/latest/meta-data/iam/security-credentials/batch-role`) を見ると `AssumeRoleUnauthorizedAccess` と出る。'),
        node('いんすたんすめたでーた？'),
        hakase('インスタンスの中からだけ見える、自分自身の情報の窓口だ。一時的な認証情報もここから受け取っておる。許可ポリシーが正しくても、信頼ポリシーが通らなければ何も始まらんのだ。'),
      ],
    },
  ],
};

export const lesson23: Lesson = {
  id: 'access-denied',
  number: '23',
  title: 'AccessDenied Troubleshooting',
  summary: 'EC2 → S3 の AccessDenied を、ロール → エラーが指すポリシー (明示的な拒否 → 許可) の順に追う',
  minutes: 25,
  startPath: '/ec2/instances',
  scenario: () =>
    s3IamEnv({
      // typo: "report" instead of "reports"
      batchPolicy: [{ Sid: 'ReadReports', Effect: 'Allow', Action: ['s3:GetObject', 's3:ListBucket'], Resource: ['arn:aws:s3:::webapp-report-123456789012', 'arn:aws:s3:::webapp-report-123456789012/*'] }],
      bucketPolicy: [
        { Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [`arn:aws:s3:::${REPORTS_BUCKET}`, `arn:aws:s3:::${REPORTS_BUCKET}/*`], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
        { Sid: 'DenyLegacyBatch', Effect: 'Deny', Principal: { AWS: 'arn:aws:iam::123456789012:role/batch-role' }, Action: 's3:GetObject', Resource: `arn:aws:s3:::${REPORTS_BUCKET}/*` },
      ],
    }),
  steps: [
    {
      type: 'dialogue',
      lines: [
        node('博士、大変です！ 夜間バッチが失敗してます。ログには `fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden` とだけ…'),
        hakase('403 か。Lesson 21 でやったな。'),
        node('門前払いのやつですよね。「君が誰であれ、ここは通さん」。'),
        hakase('そうだ。S3 でいえば `AccessDenied`、権限が足りんということだ。'),
        node('昨日まで動いてたのに…。とりあえずバケットを作り直しましょうか？'),
        hakase('待て待て。原因も分からずに作り直すのは、熱が出たから引っ越すようなものだ。'),
        node('引っ越しても熱は下がりませんね。'),
        hakase('AccessDenied の調査は順番が大事だ。**1. 誰として動いているか**を確かめ、**2. エラーメッセージが指すポリシー**を 1 つずつ直す。'),
        node('誰として…Lesson 22 でやった `aws sts get-caller-identity` ですね。「今の私は誰？」'),
        hakase('うむ。まずは失敗したコマンドをそのまま再現して、それから身分を確かめる。コマンドを用意したから、コピーするのだ。'),
      ],
    },
    { type: 'code', title: '再現用コマンド', language: 'bash', code: `${CP}\naws sts get-caller-identity` },
    {
      type: 'dialogue',
      lines: [
        node('1 行目の `aws s3 cp` は、Lesson 20 で聞いたコピーのコマンドですよね。'),
        hakase('そうだ。S3 URI で指したオブジェクトを手元にダウンロードする。バッチが毎晩やっている処理そのものだ。'),
        node('エラーに出てた HeadObject って何ですか？ 頭のオブジェクト？'),
        hakase('`aws s3 cp` が最初に呼ぶ S3 の API だ。「本体は要らん、大きさや更新日時などの情報 (ヘッダー) だけくれ」という問い合わせだ。'),
        node('えーぴーあい？'),
        hakase('プログラムから AWS に頼みごとをする窓口のことだ。コンソールのボタンも CLI も、裏では API を呼んでおる。'),
        node('HeadObject の時点で断られたから、ダウンロードまでたどり着けなかったんですね。'),
        hakase('そういうことだ。怪しいのは 2 か所。ロールに付いた IAM ポリシーと、バケットに貼られたバケットポリシーだ。'),
        node('Lesson 22 の表の、アイデンティティベースとリソースベースですね。'),
        hakase('うむ。どちらも疑え。ワシは部下の報告書も疑うがな。'),
        node('僕の報告書は疑わないでください。'),
        hakase('君の報告書が一番怪しい。さあ、batch-1 に接続して再現するのだ。'),
      ],
    },
    {
      type: 'exercise',
      title: '症状を再現し、プリンシパルを確かめる',
      objective: '`batch-1` のターミナルで失敗するコマンドを再現し、`aws sts get-caller-identity` で身分を確認する',
      tasks: [
        { id: 'cp', title: `\`aws s3 cp s3://${REPORTS_BUCKET}/${KEY} .\` → 403`, hint: 'batch-1 → 接続 → EC2 Instance Connect → 接続。', hotspotId: 'terminal-input', done: (c) => !!lastRun(c, 'batch-1', /s3 cp s3:\/\//) },
        { id: 'who', title: '`aws sts get-caller-identity` を実行', hint: '出力の `Arn` を見て、どのロールとして動いているかを確認します。ロールが付いていなければ `Unable to locate credentials` になります。', done: (c) => !!lastRun(c, 'batch-1', /sts get-caller-identity/)?.ok },
      ],
      validate: (c) =>
        lastRun(c, 'batch-1', /s3 cp s3:\/\//)?.output.includes('403') && lastRun(c, 'batch-1', /sts get-caller-identity/)?.ok
          ? ok(
              node('403 が再現しました。身分は `assumed-role/batch-role/…` です。'),
              hakase('ロールはちゃんと付いておる。「鍵がない」のではなく、「鍵はあるのに、どこかで断られている」のだ。'),
              node('じゃあ、なんで 403 としか出ないんですか？'),
              hakase('HEAD の応答には本文がないから、理由を書く場所がないのだ。封筒だけ返ってきて、手紙が入っていないようなものだな。'),
              hakase('理由を見るには、本体まで取りに行く `aws s3api get-object` を使う。s3api は S3 の API をほぼそのまま呼ぶ、飾り気のないコマンドだ。'),
            )
          : ng(hakase('cp の 403 と get-caller-identity の両方を確認するのだ。上のコマンドをターミナルに貼り付けると 1 行目が実行され、2 行目が入力欄で待っておる。Enter で 2 行目も実行したまえ。')),
    },
    { type: 'code', title: '詳しい理由を見るコマンド', language: 'bash', code: GET },
    {
      type: 'exercise',
      title: '詳しいエラーを見る',
      objective: '`aws s3api get-object` を実行し、AccessDenied の理由を読む',
      tasks: [{ id: 'get', title: '`aws s3api get-object ...` を実行', hint: '上のコマンドをコピーして貼り付けます (Ctrl+V)。', done: (c) => !!lastRun(c, 'batch-1', /s3api get-object/) }],
      validate: (c) =>
        lastRun(c, 'batch-1', /s3api get-object/)?.output.includes('explicit deny in a resource-based policy')
          ? ok(
              node('`with an explicit deny in a resource-based policy` です。'),
              hakase('**明示的な拒否**だ。IAM はまず Deny を探す。Deny が 1 つでも当たれば Allow が何枚あっても拒否だから、エラーにもまずそれが出る。場所はリソースベースポリシー、つまりバケットポリシーだ。'),
              node('バケットポリシーの Deny を消せばいいんですね。全部消しちゃえば早いですか？'),
              hakase('焼け野原にしてどうする。`DenyInsecureTransport` は、**Condition** (条件) で `aws:SecureTransport` が false のとき、つまり暗号化されていない HTTP で来た通信だけを拒否する大事な守りだ。消すのは batch-role を名指しした `DenyLegacyBatch` だけだ。'),
              node('犯人だけ捕まえて、警備員は残す、と。'),
            )
          : ng(hakase('get-object のエラーメッセージを最後まで読むのだ。上の `aws s3api get-object ...` をコピーしてターミナルに貼り付け、Enter で実行したまえ。')),
    },
    {
      type: 'exercise',
      title: 'バケットポリシーの明示的な拒否を外す',
      objective: `\`${REPORTS_BUCKET}\` のバケットポリシーから、batch-role を拒否しているステートメント (\`DenyLegacyBatch\`) だけを削除する`,
      tasks: [
        { id: 'open', title: 'S3 > バケット > アクセス許可 > バケットポリシーを確認', hint: `\`${REPORTS_BUCKET}\` の **アクセス許可** タブを下へスクロールすると「バケットポリシー」があります。Effect が \`Deny\` のステートメントと、その Principal に注目します。`, done: (c) => visited(c, new RegExp(`/s3/buckets/${REPORTS_BUCKET}\\?tab=permissions`)) },
        { id: 'fix', title: '**編集** で `DenyLegacyBatch` のステートメントを削除して **変更の保存**', hint: '`DenyInsecureTransport` (暗号化されていない通信の拒否) は大事な設定なので残します。JSON のカンマに注意。', hotspotId: 's3-save-policy', done: (c) => batchCan(c.env, true) !== 'ExplicitDeny' },
      ],
      validate: (c) => {
        if (batchCan(c.env, true) === 'ExplicitDeny') return ng(hakase('まだ batch-role はバケットポリシーで明示的に拒否されておる。`"Sid": "DenyLegacyBatch"` を含む `{` から `}` までを削除し、**変更の保存**を押したかな？'));
        const p = bucketNamed(c.env, REPORTS_BUCKET)?.policy;
        const tls = p && statements(p).some((s) => s.Effect === 'Deny' && JSON.stringify(s.Condition ?? {}).includes('aws:SecureTransport'));
        if (!tls) return ng(hakase('む、`DenyInsecureTransport` まで消してしまったな。暗号化されていない HTTP での平文アクセスを拒否する大事な守りだ。Effect `Deny`、Principal `"*"`、Action `s3:*`、Condition `aws:SecureTransport` が `false` のステートメントを書き戻すのだ。'), node('全部消せば動く…はダメなんですね。'));
        return ok(
          hakase('必要な守りは残して、原因の Deny だけを外した。'),
          node('外科手術みたいですね。'),
          hakase('うむ。悪いところごと全部切れば、患者も助からん。さあ、もう一度試そう。'),
        );
      },
    },
    {
      type: 'exercise',
      title: 'もう一度試す',
      objective: '`aws s3api get-object` を再実行する',
      tasks: [{ id: 'get', title: '`aws s3api get-object ...` を再実行', hint: 'ターミナルで ↑ キーを押すと前のコマンドを呼び出せます。', done: (c) => !!lastRun(c, 'batch-1', /s3api get-object/)?.output.includes('no identity-based policy allows') }],
      validate: (c) =>
        lastRun(c, 'batch-1', /s3api get-object/)?.output.includes('no identity-based policy allows')
          ? ok(
              node('今度は `because no identity-based policy allows the s3:GetObject action` です！ エラーが変わりました。'),
              hakase('原因はもう 1 つあったのだ。「どのアイデンティティベースポリシーも GetObject を許可していない」、つまり batch-role の IAM ポリシーだ。'),
              node('拒否はされてないけど、許可もされてない？'),
              hakase('そうだ。どこにも Allow がなければ、**暗黙的な拒否**になる。「書いていないことはダメ」が IAM の基本だ。'),
              node('明示的な拒否を外したら、下に暗黙的な拒否が隠れてた…二重底ですね。'),
            )
          : ng(hakase('get-object を再実行して、エラーの理由が変わったか見るのだ。ターミナルで ↑ キーを押せば、前のコマンドが出てくる。')),
    },
    {
      type: 'exercise',
      title: 'IAM ポリシーを直す',
      objective: '`batch-role` のポリシー `batch-s3-read` の Resource を正しいバケット ARN に直す',
      tasks: [
        { id: 'open', title: 'IAM > ロール > `batch-role` > 許可 > `batch-s3-read` を開く', hint: '「許可」タブの「許可ポリシー」一覧で、ポリシー名のリンクをクリックします。ポリシーの詳細に JSON が表示されます。', done: (c) => visited(c, /\/iam\/policies\/view/) },
        { id: 'fix', title: '**編集** で Resource を直して **変更を保存**', hint: `バケット名は \`${REPORTS_BUCKET}\` です。ポリシーの Resource をよく見比べましょう。`, hotspotId: 'iam-save-policy', done: (c) => batchCan(c.env, true) === 'Allow' },
      ],
      validate: (c) =>
        batchCan(c.env, true) === 'Allow'
          ? ok(
              node('`webapp-report-…` になってました。`reports` の s が抜けてた！'),
              hakase('1 文字違えば ARN は別物だ。IAM は「たぶんこれのことだろう」とは察してくれん。'),
              node('察してくれたら楽なのに。'),
              hakase('察しのいいセキュリティは、泥棒にも察しがいい。'),
            )
          : ng(hakase(`まだポリシーが対象のオブジェクトを許可していない。\`batch-s3-read\` の Resource の ARN を、バケット名 \`${REPORTS_BUCKET}\` と 1 文字ずつ見比べるのだ。`)),
    },
    {
      type: 'exercise',
      title: '復旧を確認する',
      objective: '最初に失敗した `aws s3 cp` が成功することを確認する',
      tasks: [{ id: 'cp', title: `\`${CP}\``, hint: 'ターミナルで ↑ キーを何度か押すと、最初に打った `aws s3 cp` を呼び出せます。成功すると `download:` と表示されます。', done: (c) => !!lastRun(c, 'batch-1', /s3 cp s3:\/\//)?.ok }],
      validate: (c) =>
        lastRun(c, 'batch-1', /s3 cp s3:\/\//)?.ok
          ? ok(
              node('`download: …` と出ました！ `cat report-2026-09-28.csv` で中身も見えます。'),
              hakase('復旧だ。原因は 2 つ。バケットポリシーの明示的な拒否と、IAM ポリシーの ARN の打ち間違いだ。'),
              node('1 つ直したら終わりだと思ってました。'),
              hakase('障害の原因がいつも 1 つなら、ワシの障害報告書はもっと薄くて済んだのだがな。'),
            )
          : ng(hakase('まだ cp が成功していない。最初の `aws s3 cp` をもう一度実行するのだ。まだ 403 なら、get-object でエラーの理由を読み直したまえ。')),
    },
    {
      type: 'quiz',
      question: hakase('問題だ。IAM ポリシーで Allow、バケットポリシーで同じ操作を Deny。結果はどうなる？'),
      options: ['許可 (IAM ポリシーが優先)', '拒否 (明示的な拒否がすべてに優先)', '先に書かれた方が優先'],
      answer: 1,
      explanation: [
        hakase('正解。評価の順番は「明示的な拒否 → 許可 → どれにもなければ暗黙的な拒否」だ。Deny は切り札だ。'),
        hakase('IAM の「**ポリシーシミュレーター**」を使えば、どのポリシーのどのステートメントが効くかを試算できるぞ。本番で試す前に、机の上で試すのだ。'),
      ],
    },
    {
      type: 'quiz',
      question: hakase('最後の問題だ。今回の調査の進め方として正しいのはどれかな？'),
      options: ['バケットを作り直す → ロールを作り直す', 'get-caller-identity で身分 → エラーが示すポリシー (Deny → 許可) を 1 つずつ直す', 'アクセスキーを発行して EC2 に置く'],
      answer: 1,
      explanation: [
        hakase('その通り。「誰として」を確かめ、エラーメッセージの末尾 (`with an explicit deny in …` / `because no … allows`) が指す場所を順に直す。'),
        hakase('原因が 1 つとは限らん。直したら必ずもう一度試して、メッセージが変わったかを見るのだ。'),
      ],
    },
  ],
};
