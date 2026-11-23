import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { EC2_READONLY, EXCHANGE_BUCKET, EXPORTS_BUCKET, PARTNER_ACCOUNT, PARTNER_ROLE, VENDOR_ACCOUNT, VENDOR_ROLE } from '../../sim/ext/accessanalyzer-scenario';
import {
  batchFinding,
  ec2Detached,
  EXPORTS_ARN,
  exportsBpaOn,
  exportsFinding,
  exportsPublic,
  exportsResolved,
  externalAnalyzer,
  partnerArchived,
  partnerRule,
  partnerStillShared,
  ruleTooBroad,
  s3Kept,
  unusedAnalyzer,
  vendorGone,
  wrongArchived,
} from '../l45-access-analyzer';
import { param, ranAws } from './helpers';
import type { CliPatches } from './types';

const ARN = (name: string) => `arn:aws:access-analyzer:ap-northeast-1:123456789012:analyzer/${name}`;
const extArn = (c: TaskContext) => externalAnalyzer(c.env)?.arn ?? ARN('webapp-external');
const extName = (c: TaskContext) => externalAnalyzer(c.env)?.name ?? 'webapp-external';
const unusedArn = (c: TaskContext) => unusedAnalyzer(c.env)?.arn ?? ARN('webapp-unused');
const TABLE = "--query 'findings[].[id,resourceType,resource,status]' --output table";
const UNUSED_TABLE = "--query 'findings[].[id,findingType,resource,status]' --output table";
const PARTNER_FILTER = `'{"principal.AWS": {"eq": ["${PARTNER_ACCOUNT}"]}}'`;
const ACTIVE_FILTER = `'{"status": {"eq": ["ACTIVE"]}}'`;
const BPA_ON = 'BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true';

/** an aws call against this analyzer */
const ranOn = (c: TaskContext, command: string, arn: string | undefined, pred: (out: string, id: string) => boolean = () => true) => !!arn && !!ranAws(c, `accessanalyzer ${command}`, (x) => param(x, 'analyzer-arn') === arn && pred(x.output, param(x, 'id')));
const listedExternal = (c: TaskContext) => ranOn(c, 'list-findings-v2', externalAnalyzer(c.env)?.arn);
const gotExports = (c: TaskContext) => ranOn(c, 'get-finding-v2', externalAnalyzer(c.env)?.arn, (_, id) => id === exportsFinding(c.env)?.id);
const listedActiveOnly = (c: TaskContext) => partnerArchived(c.env) && !!ranAws(c, 'accessanalyzer list-findings-v2', (x) => param(x, 'analyzer-arn') === externalAnalyzer(c.env)?.arn && param(x, 'filter').includes('ACTIVE') && x.output.includes(EXPORTS_BUCKET) && !x.output.includes(EXCHANGE_BUCKET));
const sawResolved = (c: TaskContext) => ranOn(c, 'get-finding-v2', externalAnalyzer(c.env)?.arn, (out, id) => id === exportsFinding(c.env)?.id && out.includes('RESOLVED'));
const listedUnused = (c: TaskContext) => ranOn(c, 'list-findings-v2', unusedAnalyzer(c.env)?.arn);
const gotBatch = (c: TaskContext) => ranOn(c, 'get-finding-v2', unusedAnalyzer(c.env)?.arn, (_, id) => id === batchFinding(c.env)?.id);
const sawAllResolved = (c: TaskContext) => vendorGone(c.env) && ec2Detached(c.env) && ranOn(c, 'list-findings-v2', unusedAnalyzer(c.env)?.arn, (out) => out.includes('RESOLVED') && !out.includes('ACTIVE'));

const patches: CliPatches = {
  'access-analyzer': {
    summary: 'パートナー連携の前に、aws accessanalyzer で社外に開いているリソースと使われていない権限を棚卸しする',
    steps: {
      5: [
        {
          type: 'dialogue',
          lines: [
            node('よし、さっそく使います！ コマンドは `aws accessanalyzer` ですか？'),
            hakase('うむ。分析を始めるには、まず**アナライザー**を作る。`aws accessanalyzer create-analyzer` だ。'),
            node('アナライザーって、分析係みたいなものですか？'),
            hakase('うむ。`--type ACCOUNT` で、信頼ゾーンが「このアカウント」の、外部アクセスの分析係を 1 人雇う。外部アクセスの分析は無料だ。'),
            node('無料で雇えるなんて。僕もそういう扱いですか？'),
            hakase('君には給料が出ておる。成果が出ておるかは別の話だがな。'),
            node('…………'),
            hakase('それから、外部アクセスアナライザーはリージョンごとに作る。作ったリージョンのバケットを見張るからだ。今日は `~/.aws/config` のとおり東京だ。'),
            node('IAM はグローバルなのに、アナライザーはリージョンごとなんですね。'),
            hakase('見張る相手のバケットがリージョンにあるからだ。ロールはグローバルだから、どのリージョンのアナライザーにも出てくる。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            node('作ったら、検出結果はどうやって見るんですか？'),
            hakase('`aws accessanalyzer list-findings-v2` だ。v2 は、外部アクセスと未使用のアクセスのどちらにも使える新しいほうだ。`--analyzer-arn` には、create-analyzer が返す `arn` を渡す。'),
            node('JSON だと長そうですね。'),
            hakase("`--query 'findings[].[id,resourceType,resource,status]' --output table` と書けば、ID、リソースの種類、リソース、ステータスだけを表にして見せる。`--output text` の、罫線つきの親戚だ。"),
            node('1 件ずつの中身は？'),
            hakase('`get-finding-v2 --id 検出結果の ID` だ。`findingDetails` の中の `externalAccessDetails` に、外部プリンシパル (`principal`)、条件 (`condition`)、操作 (`action`)、誰でも入れるか (`isPublic`) が入っておる。'),
            node('ID は表からコピーして貼ればいいんですね。'),
            hakase('うむ。手で打ち写したら、1 文字目で間違えるのが君だからな。'),
          ],
        },
      ],
      6: {
        type: 'exercise',
        title: '外部アクセスアナライザーを作り、検出結果を見る',
        objective: '`--type ACCOUNT` のアナライザーを作り、`list-findings-v2` で一覧を、`get-finding-v2` で `isPublic` が `true` の検出結果の中身を見る',
        tasks: [
          { id: 'create', title: '`aws accessanalyzer create-analyzer` で外部アクセスアナライザーを作る', hint: '`--analyzer-name webapp-external --type ACCOUNT`。応答の `arn` を、このあとの `--analyzer-arn` に使います。', command: 'aws accessanalyzer create-analyzer --analyzer-name webapp-external --type ACCOUNT', done: (c) => !!externalAnalyzer(c.env) },
          { id: 'list', title: '`aws accessanalyzer list-findings-v2` で検出結果の一覧を見る', hint: `\`--analyzer-arn <arn>\` に、作ったアナライザーの ARN を渡します。\`${TABLE}\` を付けると表で見られます。`, command: (c) => `aws accessanalyzer list-findings-v2 --analyzer-arn ${extArn(c)} ${TABLE}`, done: listedExternal },
          { id: 'get', title: `\`${EXPORTS_BUCKET}\` の検出結果を \`get-finding-v2\` で見る`, hint: '一覧の resource が `arn:aws:s3:::webapp-exports-…` の行の ID を `--id` に渡します。`principal` と `isPublic` を確かめます。', command: (c) => `aws accessanalyzer get-finding-v2 --analyzer-arn ${extArn(c)} --id ${exportsFinding(c.env)?.id ?? '<検出結果の ID>'}`, done: gotExports },
        ],
        validate: (c) => {
          if (!externalAnalyzer(c.env)) return ng(hakase('まだアナライザーがない。`aws accessanalyzer create-analyzer --analyzer-name webapp-external --type ACCOUNT` を打つのだ。'));
          if (!gotExports(c)) return ng(hakase(`アナライザーはできた。\`list-findings-v2 --analyzer-arn ${extArn(c)}\` で一覧を出し、\`${EXPORTS_BUCKET}\` の行の ID を \`get-finding-v2 --id\` に渡すのだ。`));
          return ok(
            node('4 件も出ました！ はやて物流さんのバケットとロール、それに `webapp-exports-…` と `old-vendor-role` です。'),
            hakase('君の答案は「1 つだけです」だったな。'),
            node('4 倍になりました……。`webapp-exports-…` は `"principal": {"AWS": "*"}` で、`"isPublic": true` です。'),
            hakase('世界中の誰でも、名乗らずに読めるということだ。中身は顧客リストだぞ。'),
            node('質問票に書く前でよかった……。'),
          );
        },
      },
      7: {
        type: 'table',
        title: '検出結果の仕分け',
        columns: ['resource', 'principal', '分かっていること', '判断'],
        rows: [
          [`\`arn:aws:s3:::${EXCHANGE_BUCKET}\``, `\`{"AWS": "${PARTNER_ACCOUNT}"}\``, 'はやて物流と配送ファイルをやり取りする。契約どおり', 'アーカイブ'],
          [`\`arn:aws:iam::123456789012:role/${PARTNER_ROLE}\``, `\`{"AWS": "${PARTNER_ACCOUNT}"}\` (condition: \`sts:ExternalId\`)`, 'はやて物流がファイルを置くときに引き受ける。契約どおり', 'アーカイブ'],
          [`\`arn:aws:s3:::${EXPORTS_BUCKET}\``, '`{"AWS": "*"}` (`isPublic`: `true`)', '代理店に顧客リストを渡すため、「一時的に」公開したまま', 'ポリシーを直す'],
          [`\`arn:aws:iam::123456789012:role/${VENDOR_ROLE}\``, `\`{"AWS": "${VENDOR_ACCOUNT}"}\``, '去年の移行業者。契約は終わっている。今も使われているかは不明', '使われているか調べてから決める'],
        ],
      },
      8: {
        type: 'dialogue',
        lines: [
          node('`partner-upload-role` の `condition` にある `sts:ExternalId` って何ですか？'),
          hakase('**外部 ID** だ。ロールを引き受けるときに、相手が添える合言葉のようなものだ。はやて物流の名をかたる別の誰かに、このロールを使わせないための仕掛けだ。'),
          node('合言葉つきなのに、検出結果には出るんですね。'),
          hakase('合言葉を知っている社外の相手が入れることに変わりはないからな。条件は「どういうときに入れるか」として `condition` に載る。'),
          node('はやて物流さんの 2 件は、`update-findings --status ARCHIVED` で 1 件ずつアーカイブすればいいですか？'),
          hakase('それでもよい。だが来月、はやて物流用のロールがもう 1 つ増えたら？'),
          node('また出てきて、またアーカイブ……。いたちごっこですね。'),
          hakase('そこで**アーカイブルール**だ。`create-archive-rule` の `--filter` に、`\'{"principal.AWS": {"eq": ["999988887777"]}}\'` と書く。「`principal` の `AWS` が 999988887777 と等しい検出結果は自動でアーカイブ」という意味だ。'),
          node('eq は equal、等しい、ですね。メールの自動振り分けみたいなものだ。'),
          hakase('うむ。ただしルールが自動でアーカイブするのは、これから見つかる検出結果だけだ。今ある 2 件には、`apply-archive-rule` でルールをあとから当てる。'),
          node('基準をゆるくしすぎたら？'),
          hakase('本当の穴まで「確認済み」の棚に隠れる。`{"resourceType": {"eq": ["AWS::S3::Bucket"]}}` などと書いたら、公開されたバケットまで闇に葬られるぞ。片付けたら、`--filter` に `status` を書いて、アクティブなものだけ一覧にして確かめるのだ。'),
        ],
      },
      9: {
        type: 'exercise',
        title: 'はやて物流との共有をアーカイブルールで片付ける',
        objective: `\`principal.AWS\` が \`${PARTNER_ACCOUNT}\` のアーカイブルールを作り、今あるパートナーの検出結果 2 件にも当てる。アクティブな検出結果を一覧にして確かめる`,
        tasks: [
          { id: 'rule', title: '`aws accessanalyzer create-archive-rule` でルールを作る', hint: `\`--analyzer-name <アナライザーの名前> --rule-name partner-hayate --filter ${PARTNER_FILTER}\`。名前 (ARN ではない) を渡すことに注意します。`, command: (c) => `aws accessanalyzer create-archive-rule --analyzer-name ${extName(c)} --rule-name partner-hayate --filter ${PARTNER_FILTER}`, done: (c) => !!partnerRule(c.env) },
          { id: 'apply', title: '`aws accessanalyzer apply-archive-rule` で今ある 2 件にも当てる', hint: 'こちらは `--analyzer-arn` と `--rule-name` です。成功しても何も表示されません。', command: (c) => `aws accessanalyzer apply-archive-rule --analyzer-arn ${extArn(c)} --rule-name ${partnerRule(c.env)?.ruleName ?? 'partner-hayate'}`, done: (c) => partnerArchived(c.env) },
          { id: 'check', title: '`--filter` でアクティブな検出結果だけを一覧にする', hint: `\`list-findings-v2 --analyzer-arn <arn> --filter ${ACTIVE_FILTER}\`。はやて物流の 2 件が消えて、残りの 2 件だけになっているはずです。`, command: (c) => `aws accessanalyzer list-findings-v2 --analyzer-arn ${extArn(c)} --filter ${ACTIVE_FILTER} ${TABLE}`, done: listedActiveOnly },
        ],
        validate: (c) => {
          if (wrongArchived(c.env) || ruleTooBroad(c.env))
            return ng(
              hakase('待て、はやて物流以外の検出結果までアーカイブされておる (または、ルールが一致してしまう)。`delete-archive-rule` でルールを消して `principal.AWS` だけの基準で作り直し、`update-findings --status ACTIVE --ids <ID>` でアクティブに戻すのだ。'),
              node('顧客リストを闇に葬るところでした……。'),
            );
          if (!partnerRule(c.env)) return ng(hakase(`はやて物流の 2 件に一致するアーカイブルールがまだない。\`create-archive-rule --analyzer-name ${extName(c)} --rule-name partner-hayate --filter ${PARTNER_FILTER}\` を打つのだ。`));
          if (!partnerArchived(c.env)) return ng(hakase('ルールはできたが、今ある 2 件はまだアクティブだ。ルールが自動でアーカイブするのは、新しく見つかった検出結果だけだ。`apply-archive-rule --analyzer-arn <arn> --rule-name <ルール名>` で当てるのだ。'));
          if (!listedActiveOnly(c)) return ng(hakase(`片付いたはずだ。\`list-findings-v2 --analyzer-arn ${extArn(c)} --filter ${ACTIVE_FILTER}\` で、アクティブなものだけを一覧にして確かめるのだ。`));
          return ok(
            node('アクティブが 2 件に減りました。はやて物流さんの 2 件は `ARCHIVED` です。'),
            hakase('来月はやて物流用のロールが増えても、見つかった瞬間に `ARCHIVED` になる。君が確認するのは、本当に怪しいものだけで済む。'),
            node('怪しいものだけ見ればいい。僕の仕事が減りますね。'),
            hakase('減った分は、残りの 2 件で取り返してもらう。'),
          );
        },
      },
      10: {
        type: 'dialogue',
        lines: [
          node('次は `webapp-exports-…` です。バケットごと消しましょう！'),
          hakase('落ち着け。バケットを消したら、中の顧客リストを使っている仕事まで止まる。直すのは「誰でも読める」という張り紙、つまりバケットポリシーだけだ。'),
          node('Lesson 21 でやった、Principal が `"*"` の張り紙ですね。'),
          hakase('うむ。代理店への受け渡しはとっくに終わっておる。ポリシーにはその `TemporaryShareForAgency` しか書かれておらんから、`aws s3api delete-bucket-policy` でポリシーごと削除してよい。'),
          node('ブロックパブリックアクセスも、下の 2 つがオフのままでした。'),
          hakase('よく見ておる。Lesson 21 の 4 つのスイッチだ。張り紙をはがしたら、`put-public-access-block` で全部 `true` に戻して、二度と貼れんようにしておく。'),
          node('直したら、検出結果は勝手に `RESOLVED` になるんですか？'),
          hakase('なる。ただし Access Analyzer が変更に気づいて分析し直すまで、本物では最大 30 分かかる。このシミュレーターでは 1 分ほどだ。'),
          node('30 分も待てません。'),
          hakase('せっかちな君のために、`aws accessanalyzer start-resource-scan` がある。`--resource-arn` で指したリソースだけを、今すぐ分析し直すコマンドだ。'),
        ],
      },
      11: {
        type: 'exercise',
        title: '公開されたバケットを閉じる',
        objective: `\`${EXPORTS_BUCKET}\` のバケットポリシーを削除してブロックパブリックアクセスをすべてオンに戻し、\`start-resource-scan\` のあと検出結果が \`RESOLVED\` になるのを確かめる`,
        tasks: [
          { id: 'policy', title: '`aws s3api delete-bucket-policy` で公開のポリシーを消す', hint: `\`--bucket ${EXPORTS_BUCKET}\`。成功しても何も表示されません。`, command: `aws s3api delete-bucket-policy --bucket ${EXPORTS_BUCKET}`, done: (c) => !exportsPublic(c.env) },
          { id: 'bpa', title: '`aws s3api put-public-access-block` で 4 つともオンに戻す', hint: `\`--public-access-block-configuration ${BPA_ON}\``, command: `aws s3api put-public-access-block --bucket ${EXPORTS_BUCKET} --public-access-block-configuration ${BPA_ON}`, done: (c) => exportsBpaOn(c.env) },
          { id: 'rescan', title: '`aws accessanalyzer start-resource-scan` でバケットを分析し直す', hint: `\`--analyzer-arn <arn> --resource-arn ${EXPORTS_ARN}\`。`, command: (c) => `aws accessanalyzer start-resource-scan --analyzer-arn ${extArn(c)} --resource-arn ${EXPORTS_ARN}`, done: (c) => exportsResolved(c.env) },
          { id: 'check', title: '`get-finding-v2` で `status` が `RESOLVED` になったのを確かめる', hint: '最初の演習で見た検出結果の ID です。`--query status` を付けると、ステータスだけが出ます。', command: (c) => `aws accessanalyzer get-finding-v2 --analyzer-arn ${extArn(c)} --id ${exportsFinding(c.env)?.id ?? '<検出結果の ID>'} --query status`, done: sawResolved },
        ],
        validate: (c) => {
          if (!partnerStillShared(c.env)) return ng(hakase('待て、はやて物流との共有まで消しておる。今夜から配送ファイルが届かなくなるぞ。「Lessonを最初からやり直す」でやり直すのだ。'), node('連携が始まる前に終わるところでした……。'));
          if (exportsPublic(c.env)) return ng(hakase(`\`${EXPORTS_BUCKET}\` はまだ誰でも読める。\`aws s3api delete-bucket-policy --bucket ${EXPORTS_BUCKET}\` を打つのだ。`));
          if (!exportsBpaOn(c.env)) return ng(hakase(`張り紙ははがせた。\`aws s3api put-public-access-block --bucket ${EXPORTS_BUCKET} --public-access-block-configuration ${BPA_ON}\` で、4 つとも戻すのだ。`));
          if (!exportsResolved(c.env)) return ng(hakase(`ポリシーは直った。だが検出結果はまだ \`ACTIVE\` のままだ。\`start-resource-scan --analyzer-arn ${extArn(c)} --resource-arn ${EXPORTS_ARN}\` で分析し直すのだ。`));
          if (!sawResolved(c)) return ng(hakase('分析し直した。`get-finding-v2` で、その検出結果の `status` を自分の目で確かめるのだ。'));
          return ok(
            node('`"RESOLVED"` になりました！'),
            hakase('アーカイブとの違いが分かるかな？ `ARCHIVED` は「開いているが、これでよい」。`RESOLVED` は「もう開いていない」だ。'),
            node('アーカイブで済ませていたら、顧客リストは開いたまま「確認済み」になっていたんですね。'),
            hakase('そういうことだ。臭いものに蓋をしても、においは漏れる。'),
          );
        },
      },
      14: {
        type: 'exercise',
        title: '未使用のアクセスアナライザーを作る',
        objective: '`--type ACCOUNT_UNUSED_ACCESS` (追跡期間 90 日) のアナライザーを作り、`batch-role` の検出結果を `get-finding-v2` で見る',
        tasks: [
          {
            id: 'create',
            title: '`create-analyzer --type ACCOUNT_UNUSED_ACCESS` で未使用のアクセスアナライザーを作る',
            hint: '追跡期間は `--configuration \'{"unusedAccess": {"unusedAccessAge": 90}}\'` で指定します。省略しても 90 日です。',
            command: 'aws accessanalyzer create-analyzer --analyzer-name webapp-unused --type ACCOUNT_UNUSED_ACCESS --configuration \'{"unusedAccess": {"unusedAccessAge": 90}}\'',
            done: (c) => !!unusedAnalyzer(c.env),
          },
          { id: 'list', title: '`list-findings-v2` で未使用のアクセスの検出結果を見る', hint: `\`--analyzer-arn\` には、今作ったアナライザーの ARN を渡します。\`${UNUSED_TABLE}\` で findingType も並べられます。`, command: (c) => `aws accessanalyzer list-findings-v2 --analyzer-arn ${unusedArn(c)} ${UNUSED_TABLE}`, done: listedUnused },
          { id: 'get', title: '`batch-role` の `UnusedPermission` を `get-finding-v2` で見る', hint: '`findingDetails` の `unusedPermissionDetails` に、使われていないサービス (`serviceNamespace`) が 1 つずつ並びます。', command: (c) => `aws accessanalyzer get-finding-v2 --analyzer-arn ${unusedArn(c)} --id ${batchFinding(c.env)?.id ?? '<検出結果の ID>'}`, done: gotBatch },
        ],
        validate: (c) => {
          const a = unusedAnalyzer(c.env);
          if (!a) return ng(hakase('まだ未使用のアクセスのアナライザーがない。`aws accessanalyzer create-analyzer --analyzer-name webapp-unused --type ACCOUNT_UNUSED_ACCESS` を打つのだ。'));
          if (a.unusedAccessAge !== 90) return ng(hakase(`追跡期間が ${a.unusedAccessAge} 日になっておる。今日は既定の 90 日で見る。\`aws accessanalyzer delete-analyzer --analyzer-name ${a.name}\` で消して、90 日で作り直すのだ。`));
          if (!gotBatch(c)) return ng(hakase(`アナライザーはできた。\`list-findings-v2 --analyzer-arn ${a.arn}\` で一覧を出し、resource が \`batch-role\` の行の ID を \`get-finding-v2 --id\` に渡すのだ。`));
          return ok(
            node('`old-vendor-role` は `UnusedIAMRole` で、`lastAccessed` は 200 日前です。`batch-role` は `UnusedPermission` で、ec2、elasticloadbalancing、cloudwatch、autoscaling が使われていません。'),
            hakase('`batch-role` が毎晩使っておるのは S3 だけだ。誰かが昔、調べものついでに `AmazonEC2ReadOnlyAccess` を付けて、そのままにしたのだろう。'),
            node('「ちょっとだけ権限を足す」が、ここにもありました。'),
            hakase('learner は毎日使っておるから、ここには出てこん。出てきたら、君がサボっておるということだ。'),
          );
        },
      },
      15: {
        type: 'dialogue',
        lines: [
          hakase('判断の材料はそろった。`old-vendor-role` は 200 日使われておらず、信頼している相手は契約の終わった業者だ。'),
          node('外部アクセスにも未使用のアクセスにも出てくるなんて、役満ですね。'),
          hakase('麻雀なら喜ぶところだが、セキュリティでは最悪の手だ。`aws iam delete-role` で削除する。'),
          node('`delete-role` 一発ですか？'),
          hakase('ポリシーが付いたままのロールは消せん。`DeleteConflict` で突き返される。先に `aws iam detach-role-policy` で `ReadOnlyAccess` を外すのだ。'),
          node('`batch-role` は？ ロールごと消すんですか？'),
          hakase('消したら今夜のバッチが止まる。外すのは使っていない `AmazonEC2ReadOnlyAccess` だけだ。毎晩使っておる `batch-s3-read` は残す。'),
          node('Lesson 23 で「焼け野原にするな」って言われたやつですね。'),
          hakase('よく覚えておった。Lesson 21 で言った**最小権限**を、あとから取り戻す作業だ。'),
          node('片付いたら、`start-resource-scan` で分析し直すんですよね。'),
          hakase('未使用のアクセスには、それがない。次の分析を待つのだ。このシミュレーターなら 1 分ほどだから、Lesson 33 で使った `sleep` で 60 秒待ってから一覧を見る。'),
        ],
      },
      16: {
        type: 'exercise',
        title: '使われていないアクセスを片付ける',
        objective: `\`${VENDOR_ROLE}\` のポリシーを外してロールを削除し、\`batch-role\` から使われていない \`AmazonEC2ReadOnlyAccess\` だけを外す。1 分待って、未使用のアクセスの検出結果が \`RESOLVED\` になるのを確かめる`,
        tasks: [
          { id: 'detach', title: `\`aws iam detach-role-policy\` で \`${VENDOR_ROLE}\` から \`ReadOnlyAccess\` を外す`, hint: '`--role-name old-vendor-role --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess`。付いているポリシーは `aws iam list-attached-role-policies --role-name old-vendor-role` で見られます。', command: `aws iam detach-role-policy --role-name ${VENDOR_ROLE} --policy-arn arn:aws:iam::aws:policy/ReadOnlyAccess`, done: (c) => vendorGone(c.env) || !c.env.iamRoles.find((r) => r.roleName === VENDOR_ROLE)?.attachedPolicyArns.length },
          { id: 'delete', title: `\`aws iam delete-role\` で \`${VENDOR_ROLE}\` を削除する`, hint: 'ポリシーが残っていると `DeleteConflict` になります。', command: `aws iam delete-role --role-name ${VENDOR_ROLE}`, done: (c) => vendorGone(c.env) },
          { id: 'batch', title: '`batch-role` から `AmazonEC2ReadOnlyAccess` だけを外す', hint: '`batch-s3-read` は毎晩のバッチが使っているので残します。', command: `aws iam detach-role-policy --role-name batch-role --policy-arn ${EC2_READONLY}`, done: (c) => ec2Detached(c.env) },
          { id: 'check', title: '1 分待って、未使用のアクセスの検出結果が `RESOLVED` になったのを見る', hint: '`sleep 60` で 1 分待ってから `list-findings-v2` を打ちます。`ACTIVE` が残っていたら、もう少し待ちます。', command: (c) => `sleep 60; aws accessanalyzer list-findings-v2 --analyzer-arn ${unusedArn(c)} ${UNUSED_TABLE}`, done: sawAllResolved },
        ],
        validate: (c) => {
          if (!s3Kept(c.env)) return ng(hakase('待て、`batch-s3-read` まで外したな。今夜のバッチがレポートを読めなくなる。`aws iam attach-role-policy --role-name batch-role --policy-arn arn:aws:iam::123456789012:policy/batch-s3-read` で付け直すのだ。'), node('焼け野原になりかけました……。'));
          if (!partnerStillShared(c.env)) return ng(hakase('`partner-upload-role` まで消してしまったな。はやて物流がファイルを置けなくなる。「Lessonを最初からやり直す」でやり直すのだ。'));
          if (!vendorGone(c.env)) return ng(hakase(`\`${VENDOR_ROLE}\` がまだ残っておる。\`detach-role-policy\` でポリシーを外してから、\`aws iam delete-role --role-name ${VENDOR_ROLE}\` を打つのだ。`));
          if (!ec2Detached(c.env)) return ng(hakase(`\`batch-role\` にまだ \`AmazonEC2ReadOnlyAccess\` が付いておる。\`aws iam detach-role-policy --role-name batch-role --policy-arn ${EC2_READONLY}\` で外すのだ。`));
          if (!sawAllResolved(c)) return ng(hakase(`片付けは済んだ。\`sleep 60\` で待ってから、\`list-findings-v2 --analyzer-arn ${unusedArn(c)}\` で \`RESOLVED\` になったのを確かめるのだ。`));
          return ok(
            node('2 件とも `RESOLVED` です。`batch-role` には `batch-s3-read` だけが残りました。'),
            hakase('外部アクセスのほうの `old-vendor-role` も、同じ分析で `RESOLVED` になっておる。'),
            node('質問票には「はやて物流さん用のバケットとロールの 2 つです。確認済みです」と書けます。'),
            hakase('今度は記憶ではなく、検出結果という根拠つきだ。アナライザーは残しておけば、これからも見張り続ける。次の「ちょっとだけ」が積もる前にな。'),
          );
        },
      },
    },
  },
};

export default patches;
