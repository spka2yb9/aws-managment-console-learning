import type { CommandRecord } from '../../console/store';
import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { metadataOptions } from '../../sim/ext/credentials';
import { ADMIN_ROLE, ATTACKER_IP, FINDING_IDS, STOLEN_KEY } from '../../sim/ext/guardduty-scenario';
import type { AwsEnv } from '../../sim/types';
import { instanceNamed } from '../helpers';
import { cliStillWorks, CREDS_URL, got401, imdsV2Required, sawCredentials, sessionsRevoked, suppressionProblem } from '../l43-guardduty';
import { awsCalls, insideInstance, param, ranAws } from './helpers';
import type { CliPatches } from './types';

const detector = (env: AwsEnv) => env.guardDuty?.detectorId ?? '<detector-id>';
const idOf = (env: AwsEnv, name: string) => instanceNamed(env, name)?.instanceId ?? 'i-xxxxxxxx';
const archived = (env: AwsEnv, id: string) => !!env.guardDuty?.findings.find((f) => f.id === id)?.service.archived;
const ssh = (c: TaskContext) => `aws ec2-instance-connect ssh --instance-id ${idOf(c.env, 'admin-1')}`;
/** the terminal is inside admin-1: the newest aws call on the PC is a successful ssh to it */
const inAdmin = (c: TaskContext) => {
  const last = awsCalls(c).at(-1);
  return !!last?.ok && last.command === 'ec2-instance-connect ssh' && param(last, 'instance-id') === idOf(c.env, 'admin-1');
};
const backOnPc = (c: TaskContext) => !insideInstance(c, instanceNamed(c.env, 'admin-1')?.instanceId);
const lookupOf = (x: CommandRecord) => param(x, 'lookup-attributes');

const HIGH = `'{"Criterion":{"severity":{"Gte":7}}}'`;
const CURRENT = `'{"Criterion":{"service.archived":{"Eq":["false"]}}}'`;
const LOOKUP = `aws cloudtrail lookup-events --lookup-attributes AttributeKey=AccessKeyId,AttributeValue=${STOLEN_KEY}`;
const readFinding = (c: TaskContext) => !!ranAws(c, 'guardduty get-findings', (x) => x.output.includes(STOLEN_KEY));
const readAttacker = (c: TaskContext) => !!ranAws(c, 'cloudtrail lookup-events', (x) => lookupOf(x).includes(STOLEN_KEY) && x.output.includes(ATTACKER_IP) && x.output.includes('ec2RoleDelivery'));
const filterCommand = (c: TaskContext) =>
  `aws guardduty create-filter --detector-id ${detector(c.env)} --name scanner-portscan --action ARCHIVE --description "Weekly vulnerability scan by scanner-1" --finding-criteria '{"Criterion":{"type":{"Eq":["Recon:EC2/Portscan"]},"resource.instanceDetails.instanceId":{"Eq":["${idOf(c.env, 'scanner-1')}"]}}}'`;

/** AWSRevokeOlderSessions as the console writes it, with the time the lesson started (+30 s) */
const revokeFile = () =>
  JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: ['*'], Resource: ['*'], Condition: { DateLessThan: { 'aws:TokenIssueTime': new Date(Date.now() + 30_000).toISOString().replace(/\.\d+Z$/, 'Z') } } }] }, null, 2) + '\n';

const patches: CliPatches = {
  guardduty: {
    files: () => ({ 'revoke-sessions.json': revokeFile() }),
    steps: {
      3: [
        {
          type: 'dialogue',
          lines: [
            hakase('検出結果の **タイプ** は、決まった形の名前だ。今朝のはこれだ。`UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS`'),
            node('長っ！ 呪文ですか。'),
            hakase('区切りごとに読めば怖くない。`:` の前が **目的** (UnauthorizedAccess = 不正アクセス)、`/` の前が **狙われたものの種類** (IAMUser = IAM の認証情報)、最後が **何が起きたか** だ。'),
            node('いんすたんすくれでんしゃる……えくすふぃるとれーしょん？'),
            hakase('Instance Credential は「インスタンスの認証情報」、Exfiltration は「持ち出し」。OutsideAWS は「AWS の外で」。まとめると「インスタンス用の認証情報が持ち出され、AWS の外から使われた」だ。'),
            node('Lesson 22 でやった、ロールの一時的な認証情報のことですか？ EC2 だけが使える合鍵みたいな。'),
            hakase('そうだ。EC2 のために発行された合鍵が、AWS の外のパソコンから使われておる。'),
            node('合鍵が勝手に複製されて、知らない人が出入りしてるってことですよね。完全にホラーじゃないですか。'),
            hakase('ホラー映画なら、目をつぶっておれば終わる。こちらは目をつぶるほど被害が増える。まずは検出結果を読んで、**どの合鍵が・どこから・何に使われたか** を確かめるのだ。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            node('CLI だと、どのコマンドで見るんですか？'),
            hakase('GuardDuty のコマンドは、ほとんどが `--detector-id` でディテクターの ID を取る。まず `aws guardduty list-detectors` で ID を調べる。リージョンに 1 つだから、出てくるのは 1 つだけだ。'),
            node('ディテクター ID が、GuardDuty の本体の名札なんですね。'),
            hakase('`aws guardduty get-findings-statistics --finding-statistic-types COUNT_BY_SEVERITY` で重要度ごとの件数が分かる。`"8.0": 1` なら、重要度 8.0 が 1 件だ。'),
            hakase('一覧は `aws guardduty list-findings` だ。ただし返ってくるのは検出結果の **ID だけ** だ。`--finding-criteria` で条件を JSON で渡せば絞り込める。`{"Criterion":{"severity":{"Gte":7}}}` なら「重要度が 7 以上」、つまり「高」と「重大」だけだ。'),
            node('じーてぃーいー？'),
            hakase('Greater Than or Equal、「以上」だ。`Eq` (等しい)、`Neq` (等しくない)、`Lt` (未満) などもある。中身は `aws guardduty get-findings --finding-ids <ID>` で取り出す。'),
            node('ID の一覧をもらって、気になるのだけ中身を見る。図書館で目録を引いてから本を借りるみたいですね。'),
            hakase('図書館に行ったことがあるとは知らなんだ。……応答の `Resource` に狙われたもの、`Service.Action` に何をされたか、その中の `RemoteIpDetails` に相手の IP アドレスが入っておる。'),
          ],
        },
      ],
      4: {
        type: 'exercise',
        title: '検出結果を読む',
        objective: '`aws guardduty` で重要度 7 以上の検出結果を探し、`get-findings` で中身 (どのリソースが・どこから・何をされたか) を読む',
        tasks: [
          { id: 'detector', title: '`aws guardduty list-detectors` でディテクター ID を調べる', hint: '`DetectorIds` に 32 文字の ID が 1 つ入っています。', command: 'aws guardduty list-detectors', done: (c) => !!ranAws(c, 'guardduty list-detectors', (x) => x.output.includes(detector(c.env))) },
          {
            id: 'stats',
            title: '`get-findings-statistics` で重要度ごとの件数を見る',
            hint: '`aws guardduty get-findings-statistics --detector-id <ID> --finding-statistic-types COUNT_BY_SEVERITY`',
            command: (c) => `aws guardduty get-findings-statistics --detector-id ${detector(c.env)} --finding-statistic-types COUNT_BY_SEVERITY`,
            done: (c) => !!ranAws(c, 'guardduty get-findings-statistics'),
          },
          {
            id: 'list',
            title: `\`list-findings\` に \`--finding-criteria ${HIGH}\` を付けて、重要度 7 以上の検出結果の ID を調べる`,
            hint: `\`aws guardduty list-findings --detector-id <ID> --finding-criteria ${HIGH}\`。JSON は ' (シングルクォート) で囲みます。`,
            command: (c) => `aws guardduty list-findings --detector-id ${detector(c.env)} --finding-criteria ${HIGH}`,
            done: (c) => !!ranAws(c, 'guardduty list-findings', (x) => x.output.includes(FINDING_IDS.exfiltration) && !x.output.includes(FINDING_IDS.portscan)),
          },
          {
            id: 'get',
            title: '`get-findings` でその検出結果の中身を読む',
            hint: '`aws guardduty get-findings --detector-id <ID> --finding-ids <検出結果 ID>`。`Resource` と `Service.Action.AwsApiCallAction` を読みます。',
            command: (c) => `aws guardduty get-findings --detector-id ${detector(c.env)} --finding-ids ${FINDING_IDS.exfiltration}`,
            done: readFinding,
          },
        ],
        validate: (c) =>
          readFinding(c)
            ? ok(
                node('`Resource.ResourceType` は `AccessKey`、`AccessKeyDetails.UserName` は `admin-tool-role`。`InstanceDetails.Tags` を見ると、`Name` タグの値が……`admin-1` です！'),
                hakase('社内の管理ツールが動いておるサーバーだな。相手の IP アドレスは？'),
                node(`\`RemoteIpDetails.IpAddressV4\` が \`${ATTACKER_IP}\`、\`CityName\` が Amsterdam、\`CountryName\` が Netherlands、\`Org\` が Example VPS Hosting。海外から攻撃されてるんですか!?`),
                hakase('落ち着け。**VPS** は時間貸しの借り物サーバーだ。分かるのはそのサーバーの置き場所だけで、攻撃者の住所ではない。国名で犯人像を決めつけると、調査を間違えるぞ。'),
                node('`Api` は `DescribeInstances`、`Service.Count` は 4。少なくとも 4 回は使われたってことか……。'),
              )
            : ng(hakase('検出結果の中身を読むのだ。`aws guardduty list-detectors` で ID を調べ、`list-findings` に `--finding-criteria` を付けて重要度 7 以上の ID を探し、`get-findings --finding-ids <ID>` で取り出したまえ。')),
      },
      5: {
        type: 'dialogue',
        lines: [
          node('4 回って言われても、何をされたのか気になります。'),
          hakase('そこで CloudTrail の出番だ。合鍵には番号が振ってある。検出結果の `AccessKeyDetails.AccessKeyId` (`ASIA…`) がそれだ。'),
          node('えーしあ？ Lesson 26 で見た tanaka さんの CLI の操作は、アクセスキーが `AKIA…` でした。'),
          hakase('よく覚えておったな。`AKIA` は IAM ユーザーの長期のアクセスキー、`ASIA` はロールなどで発行される **一時的な** アクセスキーだ。'),
          node('頭の 4 文字で、正社員証か入館証か分かるみたいなものですね。'),
          hakase('……妙なたとえだが、まあよい。`aws cloudtrail lookup-events` のルックアップ属性を `AttributeKey=AccessKeyId` にして、この番号で絞れば、この合鍵で行われた操作が全部並ぶ。'),
          node('どこから使われたかも見られますか？'),
          hakase('`CloudTrailEvent` の中の `sourceIPAddress` だ。admin-1 自身の IP アドレスと、さっきの攻撃者の IP アドレスが混ざっておるはずだ。同じ合鍵が 2 か所から使われておるのだからな。'),
          hakase(`1 件だけ取り出すなら、\`--query "Events[?EventName=='GetCallerIdentity'].CloudTrailEvent"\` のように **フィルター式** を使う。\`[?…]\` は「条件に合うものだけ」、\`'…'\` は文字列だ。式に ' を使うから、全体は " (ダブルクォート) で囲む。`),
        ],
      },
      6: {
        type: 'exercise',
        title: 'CloudTrail で足跡を追う',
        objective: `検出結果のアクセスキー ID で \`aws cloudtrail lookup-events\` を絞り込み、攻撃者の IP アドレス (\`${ATTACKER_IP}\`) からのイベントレコードを読む`,
        tasks: [
          {
            id: 'lookup',
            title: '`AttributeKey=AccessKeyId` でこの合鍵のイベントを並べる',
            hint: `\`${LOOKUP} --query 'Events[].[EventTime,EventName]' --output text\`。時刻とイベント名だけを抜き出します。`,
            command: `${LOOKUP} --query 'Events[].[EventTime,EventName]' --output text`,
            done: (c) => !!ranAws(c, 'cloudtrail lookup-events', (x) => lookupOf(x).includes(STOLEN_KEY)),
          },
          {
            id: 'open',
            title: '`GetCallerIdentity` のイベントレコードを取り出し、`sourceIPAddress` と `userIdentity` を読む',
            hint: `\`${LOOKUP} --query "Events[?EventName=='GetCallerIdentity'].CloudTrailEvent" --output text\``,
            command: `${LOOKUP} --query "Events[?EventName=='GetCallerIdentity'].CloudTrailEvent" --output text`,
            done: readAttacker,
          },
        ],
        validate: (c) =>
          readAttacker(c)
            ? ok(
                node(`\`sourceIPAddress\` は \`${ATTACKER_IP}\`。一覧の時刻を見ると、\`GetCallerIdentity\`、\`ListBuckets\`、\`GetBucketLocation\`、\`DescribeInstances\` の順です。最初に「自分は誰？」を確かめてますね。`),
                hakase('盗んだ鍵がどの家の鍵か、まず確かめたわけだ。それからバケットとサーバーの一覧を眺めておる。下見だな。'),
                node('`userIdentity` の中に `"ec2RoleDelivery": "1.0"` ってあります。'),
                hakase('それが手がかりだ。この合鍵は **IMDSv1** という古い方法で受け取られた、という印だ。あとで詳しくやる。それと、S3 のオブジェクトの読み取りは **データイベント** といって、イベント履歴には残らん。レポートの中身まで読まれたかどうかは、ここからは分からんのだ。'),
                node('「分かりません」って報告書に書くの、つらいですね……。'),
              )
            : ng(hakase(`攻撃者のイベントレコードを読むのだ。\`--lookup-attributes AttributeKey=AccessKeyId,AttributeValue=<アクセスキー ID>\` に \`--query "Events[?EventName=='GetCallerIdentity'].CloudTrailEvent" --output text\` を足したまえ。`)),
      },
      7: {
        type: 'dialogue',
        lines: [
          node('とにかく、その合鍵を止めないと！ アクセスキーを削除しちゃえばいいんですよね？'),
          hakase('IAM ユーザーの長期のキーならそうする。だが一時的な認証情報には、削除する API がない。期限が来るまで勝手に生き続ける。'),
          node('じゃあ期限まで、指をくわえて見てるしかないんですか。'),
          hakase('そこで「アクティブなセッションを取り消す」だ。'),
          node('せっしょん？'),
          hakase('ロールを引き受けて一時的な認証情報をもらってから、期限が切れるまでのひと続きの利用のことだ。合鍵 1 本の「貸出期間」と思えばよい。取り消すには、ロールに **インラインポリシー** (そのロール専用に直接書き込むポリシー) を足して、「この時刻より前に発行された認証情報には、何もさせない」と書く。Management Console のボタンも、裏では `PutRolePolicy` を呼んでおる。'),
          node('発行された時刻で見分けるんですか。'),
          hakase('条件キー `aws:TokenIssueTime` で、認証情報の発行時刻を比べるのだ。効果は `Deny`。Lesson 23 でやったな。ホームに `revoke-sessions.json` を用意しておいた。時刻はこのレッスンを始めたときにしてある。`cat` で中身を見て、`date -u` の今の時刻と見比べたまえ。'),
          node('明示的な拒否は、どんな許可より強いんでしたよね。'),
          hakase('その通り。これを `aws iam put-role-policy --role-name admin-tool-role --policy-name AWSRevokeOlderSessions --policy-document file://revoke-sessions.json` で書き込めば、盗まれた合鍵は何もできなくなる。'),
          node('でも、admin-1 自身が持ってる合鍵も、同じころに発行されたものですよね？'),
          hakase('鋭いな。admin-1 の今の認証情報も道連れで拒否される。EC2 は認証情報を定期的に新しいものへ入れ替えるから、入れ替わればまた使える。それまで管理ツールがエラーを出すかもしれんが、泥棒に使われ続けるよりはましだ。'),
          hakase('こういう、被害が広がるのを先に止める対応を **封じ込め** という。原因を探すのはそのあとだ。火事のときは、出火原因を調べる前に火を消すだろう。'),
          node('火を消す前に原因を調べ始めたら、調べる家がなくなりますもんね。'),
        ],
      },
      8: {
        type: 'exercise',
        title: '盗まれた認証情報を使えなくする',
        objective: 'IAM ロール `admin-tool-role` に、インラインポリシー `AWSRevokeOlderSessions` (`revoke-sessions.json`) を書き込み、アクティブなセッションを取り消す',
        tasks: [
          {
            id: 'revoke',
            title: '`aws iam put-role-policy` で `revoke-sessions.json` を書き込む',
            hint: '`aws iam put-role-policy --role-name admin-tool-role --policy-name AWSRevokeOlderSessions --policy-document file://revoke-sessions.json`。成功しても何も表示されません。',
            command: `aws iam put-role-policy --role-name ${ADMIN_ROLE} --policy-name AWSRevokeOlderSessions --policy-document file://revoke-sessions.json`,
            done: (c) => sessionsRevoked(c.env),
          },
          {
            id: 'check',
            title: '`aws iam list-role-policies` でインラインポリシーが増えたことを確かめる',
            hint: '`aws iam list-role-policies --role-name admin-tool-role`。`PolicyNames` に `AWSRevokeOlderSessions` があれば完了です。',
            command: `aws iam list-role-policies --role-name ${ADMIN_ROLE}`,
            done: (c) => !!ranAws(c, 'iam list-role-policies', (x) => x.output.includes('AWSRevokeOlderSessions')),
          },
        ],
        validate: (c) =>
          sessionsRevoked(c.env)
            ? ok(
                node('`PolicyNames` に `AWSRevokeOlderSessions` が増えました。中身は `"Effect": "Deny"`、`"Action": ["*"]`、条件は `DateLessThan` と `aws:TokenIssueTime` です。'),
                hakase('「この時刻より前に発行された鍵では、何もさせない」。この 1 枚で、出回っておる合鍵がすべてただの金属片になった。'),
                node('金属片なら、せめて売れたらいいんですけどね。'),
              )
            : ng(hakase('まだ admin-tool-role のセッションが取り消されていない。`aws iam put-role-policy --role-name admin-tool-role --policy-name AWSRevokeOlderSessions --policy-document file://revoke-sessions.json` を打つのだ。')),
      },
      9: {
        type: 'dialogue',
        lines: [
          hakase('火は消えた。次は出火原因だ。そもそも合鍵は、どうやって盗まれたのか。'),
          node('admin-1 にログインされたんですか？'),
          hakase('その形跡はない。admin-1 の管理ツールには「URL を指定してプレビューする」機能があってな。指定された URL のページを、**サーバー自身が** 取りに行って画面に表示する。'),
          node('便利そうですけど……あっ。'),
          hakase(`気付いたか。そこに \`${CREDS_URL}\` と入れたら、どうなる。`),
          node('169.254.169.254 って、Lesson 22 で出てきた、インスタンスの中からだけ見える窓口ですよね。インスタンスメタデータ。'),
          hakase('そうだ。正式には **IMDS** (インスタンスメタデータサービス) という。ロールの一時的な認証情報も、ここから受け取る。サーバーがそれを取りに行って、親切に画面に表示してしまったわけだ。'),
          node('外の人が、サーバーに「代わりに取ってきて」って頼めちゃうってことですね。'),
          hakase('サーバーをだまして、サーバーの立場でリクエストを送らせる攻撃を **SSRF** (Server-Side Request Forgery) という。forgery は「偽造」だ。'),
          node('受付の人に「社長室の金庫の中身、ちょっと持ってきて」って頼んだら、本当に持ってきちゃった、みたいな。'),
          hakase('受付が素直すぎたのだ。君と同じでな。'),
          node('褒められてないことだけは分かります。'),
          hakase('では、攻撃者が見たものを自分の目で見る。`aws ec2-instance-connect ssh` で admin-1 に入り、プレビュー機能が送ったのと同じリクエストを `curl` で送ってみたまえ。`curl` は URL にリクエストを送って、返ってきた中身を表示するコマンドだ。終わったら `exit` で PC に戻るのを忘れるな。'),
        ],
      },
      10: {
        type: 'exercise',
        title: '攻撃者が見たものを見る',
        objective: '`admin-1` に `aws ec2-instance-connect ssh` で入り、トークンを付けない `curl` で IMDS からロールの認証情報が取れてしまうことを確かめる',
        tasks: [
          {
            id: 'id',
            title: '`admin-1` のインスタンス ID と、今の IMDSv2 の設定 (`MetadataOptions.HttpTokens`) を調べる',
            hint: "`aws ec2 describe-instances --filters Name=tag:Name,Values=admin-1 --query 'Reservations[].Instances[].[InstanceId,MetadataOptions.HttpTokens]' --output text`。`optional` は「トークンは任意」、つまり IMDSv1 も使える状態です。",
            command: "aws ec2 describe-instances --filters Name=tag:Name,Values=admin-1 --query 'Reservations[].Instances[].[InstanceId,MetadataOptions.HttpTokens]' --output text",
            done: (c) => !!ranAws(c, 'ec2 describe-instances', (x) => x.output.includes(idOf(c.env, 'admin-1'))),
          },
          { id: 'ssh', title: '`aws ec2-instance-connect ssh` で `admin-1` に入る', hint: '`aws ec2-instance-connect ssh --instance-id <admin-1 の ID>`。プロンプトが `[ec2-user@ip-…]` に変わります。', command: ssh, done: (c) => inAdmin(c) || sawCredentials(c) },
          { id: 'curl', title: `\`curl ${CREDS_URL}\``, hint: '`AccessKeyId` などが入った JSON が返れば完了です。', command: `curl ${CREDS_URL}`, done: sawCredentials },
          { id: 'exit', title: '`exit` で自分の PC に戻る', hint: '次の設定変更は PC から打ちます。プロンプトが `learner@my-pc` に戻れば PC です。', command: 'exit', done: (c) => sawCredentials(c) && backOnPc(c) },
        ],
        validate: (c) =>
          sawCredentials(c)
            ? ok(
                node('出ました。`"AccessKeyId"`、`"SecretAccessKey"`、`"Token"`……合鍵の一式が丸ごとです。'),
                hakase('プレビュー機能は、この文字列をそのまま画面に表示した。攻撃者はそれをコピーして、自分のパソコンの CLI に貼っただけだ。'),
                node('金庫の暗証番号を、受付の掲示板に貼り出してたようなものですね……。'),
              )
            : ng(hakase(`admin-1 の中で \`curl ${CREDS_URL}\` を打つのだ。\`aws ec2-instance-connect ssh --instance-id <admin-1 の ID>\` で入り、プロンプトが変わったのを確かめてから打ちたまえ。`)),
      },
      11: {
        type: 'dialogue',
        lines: [
          hakase('だが、窓口の側でも防げる。IMDS には 2 つの方式がある。**IMDSv1** は、GET で聞かれれば誰にでも答える。**IMDSv2** は、先に **セッショントークン** (しばらく使える整理券) をもらわないと答えない。'),
          node('整理券は、どうやってもらうんですか？'),
          hakase('`PUT` という種類のリクエスト (ふつうにページを取ってくるのが GET、何かを置くのが PUT だ) に、`X-aws-ec2-metadata-token-ttl-seconds` という **ヘッダー** (リクエストに付ける添え書き) を付けて送る。TTL は有効期間 (秒) のことだ。もらった整理券を、次の GET のヘッダー `X-aws-ec2-metadata-token` に付けるのだ。'),
          node('プレビュー機能は「この URL を GET してきて」しかできないから……整理券をもらえない！'),
          hakase('その通り。SSRF で送らせられるのは、たいてい添え書きなしの GET だけだ。IMDSv2 を **必須** にすれば、トークンなしの GET には `401 - Unauthorized` (認証されていない) が返る。'),
          node('でも、admin-1 の正規の管理ツールまで困りませんか？'),
          hakase('AWS の SDK や CLI は、自分で整理券をもらってから聞きに行く。だから正しく作られたアプリは何も変えなくてよい。困るのは、窓口を素手で叩くような作りのものだけだ。'),
          node('さっきの `"ec2RoleDelivery": "1.0"` は、整理券なしの v1 で取られた印だったんですね。'),
          hakase('冴えておるな。朝のコーヒーが、ようやく効いてきたか。v2 で受け取った認証情報なら `2.0` になる。設定は `aws ec2 modify-instance-metadata-options` だ。`--http-tokens required` で IMDSv2 が必須、`--http-endpoint enabled` で IMDS 自体は使えるまま。結果は `describe-instances` の `MetadataOptions` で確かめられる。'),
        ],
      },
      13: {
        type: 'exercise',
        title: 'IMDSv2 を必須にする',
        objective: '`aws ec2 modify-instance-metadata-options` で `admin-1` の **IMDSv2** を必須 (`--http-tokens required`) にする (IMDS は有効のまま)',
        tasks: [
          {
            id: 'imds',
            title: '`modify-instance-metadata-options` で `--http-tokens required --http-endpoint enabled`',
            hint: '`aws ec2 modify-instance-metadata-options --instance-id <admin-1 の ID> --http-tokens required --http-endpoint enabled`。応答の `State` は `pending` (反映中) です。',
            command: (c) => `aws ec2 modify-instance-metadata-options --instance-id ${idOf(c.env, 'admin-1')} --http-tokens required --http-endpoint enabled`,
            done: (c) => imdsV2Required(c.env),
          },
          {
            id: 'check',
            title: '`describe-instances` の `MetadataOptions` で `"HttpTokens": "required"` を確かめる',
            hint: "`aws ec2 describe-instances --instance-ids <admin-1 の ID> --query 'Reservations[].Instances[].MetadataOptions'`。`State` は `applied` (反映済み) になっています。",
            command: (c) => `aws ec2 describe-instances --instance-ids ${idOf(c.env, 'admin-1')} --query 'Reservations[].Instances[].MetadataOptions'`,
            done: (c) => !!ranAws(c, 'ec2 describe-instances', (x) => x.output.includes('"HttpTokens": "required"')),
          },
        ],
        validate: (c) => {
          const i = instanceNamed(c.env, 'admin-1');
          if (i && metadataOptions(i).httpEndpoint === 'disabled') return ng(hakase('待て、`--http-endpoint disabled` で IMDS そのものを止めてはいかん。正規の管理ツールも認証情報を受け取れなくなる。`--http-tokens required --http-endpoint enabled` で打ち直すのだ。'));
          if (!imdsV2Required(c.env)) return ng(hakase('まだ `HttpTokens` が `optional` のままだ。`aws ec2 modify-instance-metadata-options --instance-id <admin-1 の ID> --http-tokens required --http-endpoint enabled` を打つのだ。'));
          return ok(node('`"HttpTokens": "required"` になりました。'), hakase('これで窓口は、整理券のない客を門前払いする。本当に門前払いされるか、admin-1 に入って確かめよう。'));
        },
      },
      14: {
        type: 'exercise',
        title: '穴がふさがったことを確かめる',
        objective: '`admin-1` で同じ `curl` を実行して `401 - Unauthorized` になることと、正規の AWS CLI (`aws sts get-caller-identity`) は今までどおり動くことを確かめ、PC に戻る',
        tasks: [
          { id: 'ssh', title: 'もう一度 `admin-1` に入る', hint: '↑ キーで前の `aws ec2-instance-connect ssh ...` を呼び出せます。', command: ssh, done: (c) => inAdmin(c) || got401(c) },
          { id: 'curl401', title: `もう一度 \`curl ${CREDS_URL}\``, hint: '↑ キーを何度か押すと、前に打った curl を呼び出せます。', command: `curl ${CREDS_URL}`, done: got401 },
          { id: 'sts', title: '`aws sts get-caller-identity`', hint: 'admin-1 の中の AWS CLI は、自分で IMDSv2 のトークンをもらってから認証情報を受け取ります。`admin-tool-role` の名前が入った `Arn` が返れば完了です。', command: 'aws sts get-caller-identity', done: cliStillWorks },
          { id: 'exit', title: '`exit` で自分の PC に戻る', hint: '次は PC から GuardDuty を片付けます。', command: 'exit', done: (c) => got401(c) && backOnPc(c) },
        ],
        validate: (c) =>
          got401(c) && cliStillWorks(c)
            ? ok(
                node('同じ curl が `401 - Unauthorized` になりました！ なのに `aws sts get-caller-identity` は、ちゃんと `admin-tool-role` で答えてます。'),
                hakase('素手の GET は門前払い、整理券を持った正規の客は通す。これが IMDSv2 だ。'),
                node('プレビュー機能にあの URL を入れられても、もう 401 の画面が出るだけですね。'),
                hakase('攻撃者は 401 の画面を眺めて、さぞがっかりするだろう。いい気味だ。'),
              )
            : ng(hakase(`admin-1 の中で \`curl ${CREDS_URL}\` が 401 になること、\`aws sts get-caller-identity\` が成功することの両方を確かめるのだ。401 にならないなら、\`describe-instances\` の \`MetadataOptions.HttpTokens\` が \`required\` か見直したまえ。`)),
      },
      15: {
        type: 'dialogue',
        lines: [
          node('これで一件落着ですね。……あれ、`list-findings` を条件なしで打つと、まだ `Recon:EC2/Portscan` と `Recon:EC2/PortProbeUnprotectedPort` が出てきます。'),
          hakase('Portscan は「EC2 インスタンスがポートスキャンをしておる」という報告だ。ポートスキャンは、どのポートが開いておるかを片っ端から試す偵察のことだ。'),
          node('やってるのは `scanner-1`……って、うちのセキュリティチームの脆弱性スキャナーじゃないですか。'),
          hakase('そうだ。毎週、社内のサーバーに弱点がないか、自分から叩いて調べておる。GuardDuty から見れば、やっておることは攻撃者と同じだ。だから毎週律儀に報告してくる。'),
          hakase('この手の報告に慣れると、本物の「高」まで「いつものやつ」と見落とすようになる。ワシの知り合いは、鳴りっぱなしの警報を放っておいて、本物の侵入を 3 か月見逃した。'),
          node('その人、今どうしてるんですか。'),
          hakase('「警報との付き合い方」という研修の講師をしておる。教材には一生困らんそうだ。'),
          hakase('そこで道具が 2 つある。**アーカイブ** は、確かめ終わった検出結果をしまっておくことだ (`aws guardduty archive-findings`)。消えるわけではなく、`Service.Archived` が `true` になって 90 日は残る。対応が済んだ今朝の「高」も、アーカイブしてよい。'),
          hakase('もう 1 つが **抑制ルール** だ。CLI では `aws guardduty create-filter --action ARCHIVE`、つまり「一致したらアーカイブする」フィルターだ。効くのは **新しい** 検出結果だけだから、今あるものは手でアーカイブする。'),
          node('じゃあ条件は「タイプが Recon:EC2/Portscan なら全部」でいいですか？'),
          hakase('それでは、乗っ取られた web-1 が本物のポートスキャンを始めても見逃す。条件は `type` と、scanner-1 だと分かるもの (`resource.instanceDetails.instanceId` か、タグ値 `vuln-scanner` の `resource.instanceDetails.tags.value`) の 2 つで絞るのだ。AMI の ID は、web-1 も同じ Amazon Linux だから絞れんぞ。'),
          node('PortProbeUnprotectedPort のほうはどうします？'),
          hakase('それは「admin-1 の 80 番が世界中に開いておって、悪い評判の IP アドレスから叩かれた」という報告だ。誤報ではないし、まだ直しておらん。だからアーカイブせずに残しておく。'),
        ],
      },
      16: {
        type: 'exercise',
        title: '誤報を片付ける',
        objective: '対応が済んだ検出結果をアーカイブし、脆弱性スキャナー `scanner-1` の `Recon:EC2/Portscan` だけを自動でアーカイブする抑制ルール (`create-filter --action ARCHIVE`) を作る',
        tasks: [
          {
            id: 'archive',
            title: '`archive-findings` で `InstanceCredentialExfiltration.OutsideAWS` と `Recon:EC2/Portscan` をアーカイブする',
            hint: '`aws guardduty archive-findings --detector-id <ID> --finding-ids <ID1> <ID2>`。ID は空白で区切って並べます。Portscan の ID は `list-findings` に `{"Criterion":{"type":{"Eq":["Recon:EC2/Portscan"]}}}` を渡すと分かります。',
            command: (c) => `aws guardduty archive-findings --detector-id ${detector(c.env)} --finding-ids ${FINDING_IDS.exfiltration} ${FINDING_IDS.portscan}`,
            done: (c) => archived(c.env, FINDING_IDS.exfiltration) && archived(c.env, FINDING_IDS.portscan),
          },
          {
            id: 'rule',
            title: '`create-filter --action ARCHIVE` で、`type` = `Recon:EC2/Portscan` かつ scanner-1 のインスタンス ID の抑制ルールを作る',
            hint: `\`aws guardduty create-filter --detector-id <ID> --name scanner-portscan --action ARCHIVE --finding-criteria '{"Criterion":{"type":{"Eq":["Recon:EC2/Portscan"]},"resource.instanceDetails.instanceId":{"Eq":["<scanner-1 の ID>"]}}}'\``,
            command: filterCommand,
            done: (c) => suppressionProblem(c.env) === undefined,
          },
          {
            id: 'current',
            title: `\`list-findings\` に \`--finding-criteria ${CURRENT}\` を付けて、アーカイブされていない検出結果を確かめる`,
            hint: '残っているのが admin-1 の PortProbeUnprotectedPort の 1 件だけなら完了です。',
            command: (c) => `aws guardduty list-findings --detector-id ${detector(c.env)} --finding-criteria ${CURRENT}`,
            done: (c) => !!ranAws(c, 'guardduty list-findings', (x) => param(x, 'finding-criteria').includes('service.archived') && x.output.includes(FINDING_IDS.portProbe) && !x.output.includes(FINDING_IDS.exfiltration)),
          },
        ],
        validate: (c) => {
          const p = suppressionProblem(c.env);
          if (p === 'high') return ng(hakase('その抑制ルールは、今朝の「高」まで飲み込んでしまう。`aws guardduty delete-filter --filter-name <名前>` で消して、条件を `type` = `Recon:EC2/Portscan` と scanner-1 に絞って作り直すのだ。'));
          if (p === 'broad') return ng(hakase('それでは、乗っ取られた別のインスタンスのポートスキャンまで黙って片付けてしまう。`delete-filter` で消して、2 つ目の条件で scanner-1 だけに絞るのだ (`resource.instanceDetails.instanceId` か、タグ値 `vuln-scanner`)。AMI の ID は web-1 も同じだから絞れんぞ。'));
          if (p === 'none' || p === 'misses') return ng(hakase('scanner-1 の Portscan に一致する抑制ルールがまだない。`aws guardduty create-filter --action ARCHIVE` に、`type` と scanner-1 のインスタンス ID の 2 つの条件を `--finding-criteria` で渡すのだ。'));
          if (!archived(c.env, FINDING_IDS.exfiltration) || !archived(c.env, FINDING_IDS.portscan)) return ng(hakase('抑制ルールは新しい検出結果にしか効かん。今ある `InstanceCredentialExfiltration.OutsideAWS` と `Recon:EC2/Portscan` は、`aws guardduty archive-findings` で片付けるのだ。'));
          if (archived(c.env, FINDING_IDS.portProbe)) return ng(hakase('`Recon:EC2/PortProbeUnprotectedPort` までアーカイブしてしまったな。admin-1 の 80 番はまだ直しておらん。`aws guardduty unarchive-findings` で戻しておくのだ。'));
          return ok(
            node('アーカイブした 2 つが一覧から消えて、`create-filter` は `"Name": "scanner-portscan"` を返しました。'),
            hakase('来週のスキャンの報告は、届いた瞬間に自動でアーカイブされる。誤報の騒音が消えれば、本物の警報がよく聞こえる。'),
            node('残っているのは、admin-1 の 80 番の「低」だけ。これが次の宿題ですね。'),
          );
        },
      },
    },
  },
};

export default patches;
