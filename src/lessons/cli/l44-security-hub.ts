import type { CommandRecord } from '../../console/store';
import { hakase, ng, node, ok, type DialogueContent, type LessonContent, type QuizContent, type TaskContext } from '../../lesson/types';
import { NEWSLETTER_BUCKET } from '../../sim/ext/securityhub-scenario';
import type { AwsEnv } from '../../sim/types';
import { albReachesWeb, sgNamed } from '../helpers';
import { devRule, fsbpOn, hubOn, lesson44, newsletterFinding, overSuppressed, passed, suppressedWithNote } from '../l44-security-hub';
import { ranAws } from './helpers';
import type { CliPatches } from './types';

const sgId = (env: AwsEnv, name: string) => sgNamed(env, name)?.groupId ?? 'sg-xxxxxxxx';
/** --filters / --criteria のある項目に書いた Value の一覧 */
const values = (x: CommandRecord, field: string, param = 'filters') => {
  const f = x.params?.[param] as Record<string, { Value?: unknown; Key?: unknown }[]> | undefined;
  return (Array.isArray(f?.[field]) ? f[field] : []).map((c) => String(c.Value));
};
const tagFilter = (x: CommandRecord) => {
  const f = x.params?.filters as Record<string, { Key?: unknown; Value?: unknown }[]> | undefined;
  return (Array.isArray(f?.ResourceTags) ? f.ResourceTags : []).some((c) => c.Key === 'Environment' && c.Value === 'dev');
};
const sawCritical = (c: TaskContext) => ranAws(c, 'securityhub get-findings', (x) => values(x, 'SeverityLabel').includes('CRITICAL') && values(x, 'ComplianceStatus').includes('FAILED'));
const sawControls = (c: TaskContext) => ranAws(c, 'securityhub batch-get-security-controls', (x) => String(x.params?.['security-control-ids'] ?? '').includes('EC2.19'));
/** 学習者が最後に直した時刻 (直したあとに見たかを確かめる) */
const fixedAt = (env: AwsEnv) => Math.max(0, ...env.trailEvents.filter((e) => e.userIdentity.userName === 'learner' && ['RevokeSecurityGroupIngress', 'ModifyDBInstance'].includes(e.eventName)).map((e) => e.eventTime));
const sawFixed = (c: TaskContext) => ranAws(c, 'securityhub get-findings', (x) => x.at >= fixedAt(c.env) && ['EC2.19', 'RDS.2'].every((id) => values(x, 'ComplianceSecurityControlId').includes(id)));

const CRITICAL = "aws securityhub get-findings --filters 'SeverityLabel=[{Value=CRITICAL,Comparison=EQUALS}],ComplianceStatus=[{Value=FAILED,Comparison=EQUALS}],RecordState=[{Value=ACTIVE,Comparison=EQUALS}]' --query 'Findings[].[Compliance.SecurityControlId,Resources[0].Id,ProductFields.\"aws/securityhub/annotation\"]' --output table";
const CHECK_FIXED = "aws securityhub get-findings --filters 'ComplianceSecurityControlId=[{Value=EC2.19,Comparison=EQUALS},{Value=RDS.2,Comparison=EQUALS}],RecordState=[{Value=ACTIVE,Comparison=EQUALS}]' --query 'Findings[].[Compliance.SecurityControlId,Resources[0].Id,Compliance.Status,Workflow.Status]' --output table";
const S38 = "aws securityhub get-findings --filters 'ComplianceSecurityControlId=[{Value=S3.8,Comparison=EQUALS}],ComplianceStatus=[{Value=FAILED,Comparison=EQUALS}]' --query 'Findings[].[Id,ProductArn,Resources[0].Id]' --output text";
const NOTE = 'メールマガジンの画像を配信するため、意図して公開している';

const CRITERIA = `{
  "ResourceTags": [
    { "Key": "Environment", "Value": "dev", "Comparison": "EQUALS" }
  ]
}
`;
const ACTIONS = `[
  {
    "Type": "FINDING_FIELDS_UPDATE",
    "FindingFieldsUpdate": {
      "Severity": { "Label": "LOW" },
      "Note": { "Text": "開発環境のリソース。本番より優先度を下げる", "UpdatedBy": "learner" }
    }
  }
]
`;

const consoleLines = (n: number) => (lesson44.steps[n] as DialogueContent).lines;

const patches: CliPatches = {
  'security-hub': {
    files: () => ({ 'criteria.json': CRITERIA, 'actions.json': ACTIONS }),
    steps: {
      4: {
        type: 'dialogue',
        lines: [
          ...consoleLines(4),
          hakase('CLI では `aws securityhub` だ。`enable-security-hub` で有効にすると、最初から選ばれる 2 つの標準も一緒に有効になる。`get-enabled-standards` で確かめられる。'),
          node('スコアも CLI で見られますか？'),
          hakase('スコアはコンソールの「概要」に出る数字だ。CLI では、失敗している検出結果を `get-findings` で数えて確かめる。'),
          node('答案は返してもらえないけど、自分で採点はできる試験みたいですね。'),
        ],
      },
      6: {
        type: 'exercise',
        title: 'Security Hub CSPM を有効にする',
        objective: '`aws securityhub enable-security-hub` で Security Hub CSPM を有効にし、`get-enabled-standards` で 2 つの標準が有効になったことを確かめる',
        tasks: [
          {
            id: 'enable',
            title: '`aws securityhub enable-security-hub` を実行する',
            hint: '成功しても何も表示されません。`--no-enable-default-standards` を付けると標準を有効にしないので、今回は付けません。',
            command: 'aws securityhub enable-security-hub',
            done: (c) => fsbpOn(c.env),
          },
          {
            id: 'standards',
            title: '`aws securityhub get-enabled-standards` で有効な標準を見る',
            hint: "`StandardsArn` が標準、`StandardsStatus` が READY なら準備完了です。`--query 'StandardsSubscriptions[].[StandardsArn,StandardsStatus]' --output table` で一覧にすると見やすくなります。",
            command: "aws securityhub get-enabled-standards --query 'StandardsSubscriptions[].[StandardsArn,StandardsStatus]' --output table",
            done: (c) => fsbpOn(c.env) && !!ranAws(c, 'securityhub get-enabled-standards'),
          },
        ],
        validate: (c) => {
          if (!hubOn(c.env)) return ng(hakase('まだ Security Hub CSPM が有効になっておらん。`aws securityhub enable-security-hub` を打つのだ。'));
          if (!fsbpOn(c.env)) return ng(hakase('AWS 基礎セキュリティのベストプラクティスの標準が有効になっておらん。`aws securityhub batch-enable-standards --standards-subscription-requests StandardsArn=arn:aws:securityhub:ap-northeast-1::standards/aws-foundational-security-best-practices/v/1.0.0` で有効にするのだ。'));
          if (!ranAws(c, 'securityhub get-enabled-standards')) return ng(hakase('有効になった標準を `aws securityhub get-enabled-standards` で確かめるのだ。'));
          return ok(
            node('`aws-foundational-security-best-practices` と `cis-aws-foundations-benchmark` の 2 つが READY です。'),
            hakase('これで、2 つの標準のコントロールがアカウントを調べ始めた。結果は検出結果として、もう届いておる。'),
            node('部長に「たぶん大丈夫です」と答える前に、見ておけばよかったです。'),
          );
        },
      },
      7: {
        type: 'dialogue',
        lines: [
          node('どこから手を付けましょう。失敗している検出結果を全部出したら、すごい数になりそうです。'),
          hakase('トリアージだと言ったろう。`get-findings` の `--filters` で、重要度 (`SeverityLabel`) が CRITICAL、合否 (`ComplianceStatus`) が FAILED のものだけに絞る。'),
          node('ふぃるたーず。EC2 の `--filters` と同じですか？'),
          hakase('形が違う。`SeverityLabel=[{Value=CRITICAL,Comparison=EQUALS}]` のように、項目ごとに「値」と「比べ方」の組を並べる。比べ方は EQUALS (等しい)、NOT_EQUALS (等しくない)、PREFIX (前方一致) などだ。'),
          node('同じ項目に 2 つ書いたら？'),
          hakase('EQUALS どうしは「または」、NOT_EQUALS どうしは「かつ」になる。違う項目どうしは「かつ」だ。`RecordState` が ACTIVE も足しておく。リソースが消えた検出結果は ARCHIVED、つまりアーカイブ済みとして残っておるからな。'),
          node('出てきたコントロールは、`batch-get-security-controls` で詳しく見るんですね。'),
          hakase('そうだ。重要度とタイトルが分かる。ただし合格か失敗かは返さん。それは検出結果のほうで見る。'),
          node('犯人の顔を見てから捕まえるんですね。'),
          hakase('捕まえるのではない、直すのだ。君は刑事ドラマの見すぎだ。'),
        ],
      },
      8: {
        type: 'exercise',
        title: 'どのリソースが失敗しているかを見る',
        objective: '`get-findings` で重要度が CRITICAL の失敗した検出結果を出し、`batch-get-security-controls` で EC2.19 と RDS.2 の中身を見る',
        tasks: [
          {
            id: 'critical',
            title: '`get-findings` で、SeverityLabel が CRITICAL、ComplianceStatus が FAILED の検出結果を見る',
            hint: "`--filters 'SeverityLabel=[{Value=CRITICAL,Comparison=EQUALS}],ComplianceStatus=[{Value=FAILED,Comparison=EQUALS}]'`。`--query` でコントロール ID (`Compliance.SecurityControlId`) とリソース (`Resources[0].Id`) だけを抜き出すと読みやすくなります。",
            command: CRITICAL,
            done: (c) => !!sawCritical(c),
          },
          {
            id: 'controls',
            title: '`batch-get-security-controls` で EC2.19 と RDS.2 を見る',
            hint: "`aws securityhub batch-get-security-controls --security-control-ids EC2.19 RDS.2`。`SeverityRating` が重要度、`Title` がチェックの内容です。",
            command: "aws securityhub batch-get-security-controls --security-control-ids EC2.19 RDS.2 --query 'SecurityControls[].[SecurityControlId,SeverityRating,Title]' --output table",
            done: (c) => !!sawControls(c),
          },
        ],
        validate: (c) => {
          if (!sawCritical(c)) return ng(hakase("`aws securityhub get-findings --filters 'SeverityLabel=[{Value=CRITICAL,Comparison=EQUALS}],ComplianceStatus=[{Value=FAILED,Comparison=EQUALS}]'` で、重大の失敗だけを出すのだ。"));
          return sawControls(c)
            ? ok(
                node('EC2.19 は web-sg で、`annotation` に「high-risk port(s): 22」とあります。SSH の 22 番ですね。RDS.2 は webapp-db です。'),
                hakase('22 (SSH)、3306 (MySQL)、3389 (RDP) のように、狙われやすいポートの一覧だ。Lesson 27 で閉じたはずの穴が、また開いておる。'),
                node('ゾンビ映画の続編みたいですね。'),
                hakase('しかも続編のほうが予算が大きい。'),
              )
            : ng(hakase('次は `aws securityhub batch-get-security-controls --security-control-ids EC2.19 RDS.2` で、2 つのコントロールの中身を見るのだ。'));
        },
      },
      9: {
        type: 'dialogue',
        lines: [
          node('直し方は Lesson 27 と同じで、`aws ec2 revoke-security-group-ingress` で web-sg から SSH のルールを消せばいいですよね。'),
          hakase('そうだ。ALB からの 3000 番は消すでないぞ。サイトが止まる。'),
          node('web-sg は、EC2.18 にも引っかかってました。'),
          hakase('EC2.18 は「80 と 443 以外のポートを全世界に開けていないか」を見る。同じ SSH のルールが原因だから、1 か所直せば両方とも合格する。CIS の標準の EC2.13 もな。'),
          node('一石二鳥、いや三鳥ですね。RDS.2 のほうは？'),
          hakase('webapp-db の `PubliclyAccessible` が `true` になっておる。Lesson 14 で作ったときは `false` だったはずだ。'),
          node('プライベートサブネットにあるから、外からはつながらないんじゃないですか？'),
          hakase('今はな。誰かがルートテーブルを変えた瞬間に、DB がインターネットに顔を出す。鍵をかけ忘れた金庫を、奥の部屋に置いて安心しておるようなものだ。'),
          node('部屋のドアが開いたら終わりなんですね。`aws rds modify-db-instance` に `--no-publicly-accessible` を付けて直します。'),
        ],
      },
      10: {
        type: 'exercise',
        title: '重大の 2 つを直す',
        objective: '`web-sg` から 0.0.0.0/0 の SSH (22 番) のルールを削除し、`webapp-db` の PubliclyAccessible を false にして、EC2.19 と RDS.2 を合格にする。ALB からの TCP 3000 は残すこと',
        tasks: [
          {
            id: 'sg',
            title: '`aws ec2 revoke-security-group-ingress` で 0.0.0.0/0 の SSH だけを削除する',
            hint: '`aws ec2 revoke-security-group-ingress --group-id <web-sg の ID> --protocol tcp --port 22 --cidr 0.0.0.0/0`。web-sg の ID は EC2.19 の検出結果の `Resources[0].Id` の最後の部分です。',
            command: (c) => `aws ec2 revoke-security-group-ingress --group-id ${sgId(c.env, 'web-sg')} --protocol tcp --port 22 --cidr 0.0.0.0/0`,
            done: (c) => passed(c.env, 'EC2.19'),
          },
          {
            id: 'db',
            title: '`aws rds modify-db-instance` で webapp-db をパブリックアクセス不可にする',
            hint: '`aws rds modify-db-instance --db-instance-identifier webapp-db --no-publicly-accessible --apply-immediately`。`--no-` を付けると false の意味になります。',
            command: "aws rds modify-db-instance --db-instance-identifier webapp-db --no-publicly-accessible --apply-immediately --query 'DBInstance.[DBInstanceIdentifier,PubliclyAccessible]'",
            done: (c) => passed(c.env, 'RDS.2'),
          },
          {
            id: 'check',
            title: '`get-findings` で EC2.19 と RDS.2 の検出結果が PASSED になったことを確かめる',
            hint: "`--filters 'ComplianceSecurityControlId=[{Value=EC2.19,Comparison=EQUALS},{Value=RDS.2,Comparison=EQUALS}]'`。同じ項目の EQUALS は「または」なので、2 つのコントロールの検出結果がまとめて出ます。`Compliance.Status` と `Workflow.Status` を見ます。",
            command: CHECK_FIXED,
            done: (c) => passed(c.env, 'EC2.19') && passed(c.env, 'RDS.2') && !!sawFixed(c),
          },
        ],
        validate: (c) => {
          if (!albReachesWeb(c.env)) return ng(hakase('ALB からの 3000 番まで消してしまったぞ！ これではサイトが止まる。`aws ec2 authorize-security-group-ingress --group-id <web-sg の ID> --protocol tcp --port 3000 --source-group <alb-sg の ID>` で戻すのだ。'));
          if (!passed(c.env, 'EC2.19')) return ng(hakase('まだ web-sg が 0.0.0.0/0 からの SSH を許可しておる。`aws ec2 revoke-security-group-ingress --group-id <web-sg の ID> --protocol tcp --port 22 --cidr 0.0.0.0/0` で消すのだ。'));
          if (!passed(c.env, 'RDS.2')) return ng(hakase('webapp-db がまだパブリックアクセス可能だ。`aws rds modify-db-instance --db-instance-identifier webapp-db --no-publicly-accessible --apply-immediately` を打つのだ。'));
          if (!sawFixed(c)) return ng(hakase("直したあとの検出結果を確かめるのだ。`aws securityhub get-findings --filters 'ComplianceSecurityControlId=[{Value=EC2.19,Comparison=EQUALS},{Value=RDS.2,Comparison=EQUALS}]'` を打つ。"));
          return ok(
            node('EC2.19 も RDS.2 も、`Compliance.Status` が PASSED になりました。'),
            hakase('EC2.18 も一緒に合格しておる。1 本のルールが、何人分も足を引っ張っておったわけだ。'),
            node('`Workflow.Status` は RESOLVED になってます。'),
            hakase('それはワークフローのステータス、つまり対応の進み具合だ。コントロールの検出結果は、合格すると自動で RESOLVED (解決済み) になる。また誰かが SSH を開けたら、NEW (新規) に戻って、失敗の一覧にまた出てくるぞ。'),
          );
        },
      },
      11: {
        type: 'dialogue',
        lines: [
          ...consoleLines(11),
          node('CLI だと、どうやって抑制するんです？'),
          hakase('`batch-update-findings` だ。`get-findings` で調べた `Id` と `ProductArn` (検出結果を作った製品の ARN) の組で検出結果を指定し、`--workflow Status=SUPPRESSED` とメモの `--note` を付ける。'),
        ],
      },
      12: {
        type: 'exercise',
        title: 'わざと公開しているバケットの検出結果を抑制する',
        objective: `S3.8 の \`${NEWSLETTER_BUCKET}\` の検出結果を、理由のメモを付けて SUPPRESSED (抑制済み) にする。ほかの失敗した検出結果は抑制しないこと`,
        tasks: [
          {
            id: 'find',
            title: '`get-findings` で S3.8 の失敗した検出結果の Id と ProductArn を見る',
            hint: "`--filters 'ComplianceSecurityControlId=[{Value=S3.8,Comparison=EQUALS}],ComplianceStatus=[{Value=FAILED,Comparison=EQUALS}]' --query 'Findings[].[Id,ProductArn,Resources[0].Id]' --output text`。",
            command: S38,
            done: (c) => !!ranAws(c, 'securityhub get-findings', (x) => values(x, 'ComplianceSecurityControlId').includes('S3.8')),
          },
          {
            id: 'suppress',
            title: '`batch-update-findings` でその検出結果を SUPPRESSED にし、理由をメモに残す',
            hint: "`aws securityhub batch-update-findings --finding-identifiers Id=<Id>,ProductArn=<ProductArn> --workflow Status=SUPPRESSED --note 'Text=\"理由\",UpdatedBy=learner'`。メモの Text と UpdatedBy (書いた人) は両方とも必要です。",
            command: (c) => {
              const f = newsletterFinding(c.env);
              return `aws securityhub batch-update-findings --finding-identifiers Id=${f?.id ?? '<Id>'},ProductArn=${f?.productArn ?? '<ProductArn>'} --workflow Status=SUPPRESSED --note 'Text="${NOTE}",UpdatedBy=learner'`;
            },
            done: (c) => suppressedWithNote(c.env),
          },
        ],
        validate: (c) => {
          if (newsletterFinding(c.env)?.compliance === 'PASSED') return ng(hakase(`ブロックパブリックアクセスをオンにしたな。これではメールの画像が全部欠ける。\`aws s3api put-public-access-block --bucket ${NEWSLETTER_BUCKET}\` で 4 つとも false に戻して、検出結果のほうを抑制するのだ。`));
          if (overSuppressed(c.env)) return ng(hakase('ほかの失敗した検出結果まで抑制しておるぞ。対応が要らないと確かめたものか？ その検出結果を `batch-update-findings` の `--workflow Status=NEW` で新規に戻すのだ。'));
          if (newsletterFinding(c.env)?.workflow === 'SUPPRESSED' && !suppressedWithNote(c.env)) return ng(hakase("メモが空だ。もう一度 `batch-update-findings` で、`--note 'Text=\"理由\",UpdatedBy=learner'` を付けて設定し直すのだ。"));
          return suppressedWithNote(c.env)
            ? ok(
                node('`ProcessedFindings` に 1 件入ってました。これで S3.8 も合格扱いですね。'),
                hakase('メモは検出結果の `Note` に残る。監査で「なぜ公開しているのか」と聞かれたら、これを見せればよい。'),
                node('未来の自分への手紙ですね。'),
                hakase('未来の君が、手紙を読む習慣を身に付けておればな。'),
              )
            : ng(hakase(`\`get-findings\` で S3.8 の \`${NEWSLETTER_BUCKET}\` の検出結果の Id と ProductArn を調べ、\`batch-update-findings\` で \`--workflow Status=SUPPRESSED\` とメモを付けるのだ。`));
        },
      },
      13: {
        type: 'dialogue',
        lines: [
          ...consoleLines(13).slice(0, -1),
          hakase('ルールの条件は、`get-findings` の `--filters` と同じ形で書く。だから、条件を `--filters` に渡せば、今どの検出結果に合うかを先に確かめられる。'),
          node('条件と、書き換える中身は、どう渡すんですか？'),
          hakase('JSON のファイルにしてある。`criteria.json` が条件、`actions.json` が動作だ。`cat` で中身を見てから使うのだぞ。ルールがいくつもあるときは、`--rule-order` の数字が小さいものから適用される。'),
        ],
      },
      14: {
        type: 'exercise',
        title: '開発環境の検出結果を自動で仕分けるルールを作る',
        objective: '`criteria.json` の条件に合う検出結果を `get-findings` で確かめてから、`create-automation-rule` で自動化ルールを作り、`list-automation-rules` で確かめる',
        tasks: [
          {
            id: 'preview',
            title: '`get-findings --filters file://criteria.json` で、条件に合う検出結果を見る',
            hint: "`cat criteria.json` で条件を見てから、`aws securityhub get-findings --filters file://criteria.json --query 'Findings[].[Compliance.SecurityControlId,ProductName,Severity.Label,Compliance.Status,Resources[0].Id]' --output table`。",
            command: "aws securityhub get-findings --filters file://criteria.json --query 'Findings[].[Compliance.SecurityControlId,ProductName,Severity.Label,Compliance.Status,Resources[0].Id]' --output table",
            done: (c) => !!ranAws(c, 'securityhub get-findings', tagFilter),
          },
          {
            id: 'rule',
            title: '`create-automation-rule` でルールを作る',
            hint: '`aws securityhub create-automation-rule --rule-name dev-low-priority --rule-order 1 --description "開発環境の検出結果は優先度を下げる" --criteria file://criteria.json --actions file://actions.json`。応答の `RuleArn` がルールの ARN です。',
            command: 'aws securityhub create-automation-rule --rule-name dev-low-priority --rule-order 1 --description "開発環境の検出結果は優先度を下げる" --criteria file://criteria.json --actions file://actions.json',
            done: (c) => !!devRule(c.env),
          },
          {
            id: 'list',
            title: '`list-automation-rules` でルールが有効になっていることを確かめる',
            hint: "`aws securityhub list-automation-rules`。`RuleStatus` が ENABLED なら有効です。",
            command: "aws securityhub list-automation-rules --query 'AutomationRulesMetadata[].[RuleOrder,RuleName,RuleStatus]' --output table",
            done: (c) => {
              const r = devRule(c.env);
              return !!r && !!ranAws(c, 'securityhub list-automation-rules', (x) => x.at >= r.createdAt);
            },
          },
        ],
        validate: (c) => {
          const rules = c.env.securityHub?.automationRules ?? [];
          if (!rules.length) return ng(hakase('まだルールがない。`aws securityhub create-automation-rule --rule-name dev-low-priority --rule-order 1 --description "..." --criteria file://criteria.json --actions file://actions.json` を打つのだ。'));
          const r = devRule(c.env);
          if (!r) {
            if (rules.some((x) => x.ruleStatus !== 'ENABLED')) return ng(hakase('`RuleStatus` が DISABLED のルールがある。無効のルールは何もせん。`batch-delete-automation-rules` で消して、`--rule-status` を付けずに作り直すのだ。'));
            return ng(hakase('条件かアクションが違う。`criteria.json` と `actions.json` を `cat` で見直し、合わないルールは `batch-delete-automation-rules` で消して作り直すのだ。'));
          }
          if (!ranAws(c, 'securityhub list-automation-rules', (x) => x.at >= r.createdAt)) return ng(hakase('作ったルールを `aws securityhub list-automation-rules` で確かめるのだ。'));
          return ok(
            node('ルールができました。`get-findings` には dev-sandbox と dev-sg の検出結果が並んでました。'),
            hakase('次に dev-sandbox の検出結果が更新されたときから、重要度が自動で LOW になる。開発チームがサーバーを作り直すたびに、手で書き換えずに済む。'),
            node('残りは EC2.2 ですね。'),
            hakase('VPC の default のセキュリティグループのルールを空にする、だ。そのグループを使っておるリソースがないことを確かめてからやる。それは宿題にしておこう。'),
          );
        },
      },
      16: {
        ...(lesson44.steps[16] as QuizContent),
        explanation: [
          hakase('正解。自動化ルールが適用されるのは、作ったあとに作られた検出結果と、更新された検出結果だ。'),
          node('リソースの設定が変わるか、定期的なチェックで更新されたときですね。'),
          hakase('うむ。今すぐ変えたいものは、`batch-update-findings` で手で変えればよい。'),
        ],
      } satisfies LessonContent,
    },
  },
};

export default patches;
