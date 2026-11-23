import type { CommandRecord } from '../../console/store';
import { hakase, ng, node, ok, type TaskContext } from '../../lesson/types';
import { etagOf } from '../../cli/aws/services/cloudfront';
import { ipSetLockToken } from '../../cli/aws/services/wafv2';
import { ipInCidr } from '../../sim/cidr';
import { certCovers } from '../../sim/edge';
import { CLIENT_IP } from '../../sim/network';
import { SHOP_DOMAIN, STATIC_BUCKET } from '../../sim/scenarios';
import type { AwsEnv } from '../../sim/types';
import { failedAws, param, ranAws } from './helpers';
import type { CliPatches } from './types';

const WWW = `www.${SHOP_DOMAIN}`;
const CRS = 'AWS-AWSManagedRulesCommonRuleSet';
const ATTACKER = '198.51.100.77';

/* ---- コンソール版 (l35-38-edge.ts) と同じ判定 ---- */

/** the newest request (curl) to exactly this host (and scheme, when given) */
function lastTo(c: TaskContext, host: string, scheme?: 'http' | 'https') {
  return c.browser.find((r) => {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(r.url) ? r.url : `http://${r.url}`);
      return u.hostname === host && (!scheme || u.protocol === `${scheme}:`);
    } catch {
      return false;
    }
  });
}
const zone = (env: AwsEnv) => env.hostedZones.find((z) => z.name === SHOP_DOMAIN);
const dist = (env: AwsEnv) => env.distributions[0];
const zoneId = (c: TaskContext) => zone(c.env)?.id ?? 'Z0123456789ABCDEFGHIJ';
const distId = (c: TaskContext) => dist(c.env)?.id ?? 'E1234567890ABC';
const domain = (c: TaskContext) => dist(c.env)?.domainName ?? 'd111111abcdef8.cloudfront.net';

/** dig / nslookup / host を打った (aws と違って command が無い) */
const ranDns = (c: TaskContext, name: string) =>
  c.commands.some((x: CommandRecord) => !x.instanceId && !x.command && /^(dig|nslookup|host)$/.test(x.line.split(' ')[0]) && x.line.split(' ').slice(1).some((a) => a.toLowerCase().replace(/\.$/, '') === name));

/* 35 */
const apexAlias = (env: AwsEnv) => zone(env)?.records.find((r) => r.name === SHOP_DOMAIN && r.type === 'A' && r.aliasTarget);
const apexOk = (c: TaskContext) => lastTo(c, SHOP_DOMAIN)?.status === 200 && !!apexAlias(c.env);
/** the ChangeInfo.Id of the newest successful change-resource-record-sets */
const lastChangeId = (c: TaskContext) => /\/change\/C[0-9A-Z]+/.exec(ranAws(c, 'route53 change-resource-record-sets')?.output ?? '')?.[0];

/* 36 */
const virginiaCert = (env: AwsEnv) => env.certificates.find((c) => c.region === 'us-east-1' && certCovers(c, WWW) && certCovers(c, SHOP_DOMAIN));
const wrongRegionCert = (env: AwsEnv) => env.certificates.find((c) => c.region !== 'us-east-1' && certCovers(c, WWW));
const oldCertArn = (c: TaskContext) => dist(c.env)?.certificateArn ?? '<今の証明書の ARN>';
const newCertArn = (c: TaskContext) => virginiaCert(c.env)?.certificateArn ?? '<新しい証明書の ARN>';
const validationRecorded = (env: AwsEnv) => {
  const cert = virginiaCert(env);
  return !!cert && cert.validation.every((v) => zone(env)?.records.some((r) => r.type === 'CNAME' && r.name === v.cnameName.toLowerCase()));
};
const distFixed = (env: AwsEnv) => {
  const d = dist(env);
  const c = env.certificates.find((x) => x.certificateArn === d?.certificateArn);
  return !!d && !!c && d.aliases.includes(WWW) && d.aliases.includes(SHOP_DOMAIN) && certCovers(c, WWW);
};
const wwwHttpsOk = (c: TaskContext) => distFixed(c.env) && lastTo(c, WWW, 'https')?.status === 200;
const sawDistConfig = (c: TaskContext) => !!(ranAws(c, 'cloudfront get-distribution-config', (x) => param(x, 'id') === dist(c.env)?.id) ?? ranAws(c, 'cloudfront get-distribution', (x) => param(x, 'id') === dist(c.env)?.id));
const sawCertNames = (c: TaskContext) => !!ranAws(c, 'acm describe-certificate', (x) => x.region === 'us-east-1' && x.output.includes(SHOP_DOMAIN));
/* 検証用の CNAME を ChangeBatch に組み立てる --query */
const VALIDATION_QUERY = "'{Changes: Certificate.DomainValidationOptions[].{Action: `\"UPSERT\"`, ResourceRecordSet: {Name: ResourceRecord.Name, Type: ResourceRecord.Type, TTL: `300`, ResourceRecords: [{Value: ResourceRecord.Value}]}}}'";

/* 37 */
const staleSeen = (c: TaskContext) => {
  const r = lastTo(c, dist(c.env)?.domainName ?? '');
  return !!r && r.headers?.['X-Cache'] === 'Hit from cloudfront' && r.body.includes('夏のセール');
};
const invalidated = (env: AwsEnv) => !!dist(env)?.invalidations.some((i) => i.status === 'Completed') && !dist(env)?.cache.some((x) => x.path === '/index.html' && x.body.includes('夏のセール'));
const freshSeen = (c: TaskContext) => invalidated(c.env) && !!lastTo(c, dist(c.env)?.domainName ?? '')?.body.includes('秋のキャンペーン');
const sawS3 = (c: TaskContext) => !!(ranAws(c, 's3 ls', (x) => x.output.includes('index.html')) ?? ranAws(c, 's3api head-object', (x) => param(x, 'bucket') === STATIC_BUCKET) ?? ranAws(c, 's3api list-objects-v2', (x) => param(x, 'bucket') === STATIC_BUCKET));
const sawTtl = (c: TaskContext) => !!(ranAws(c, 'cloudfront get-distribution-config', (x) => x.output.includes('DefaultTTL')) ?? ranAws(c, 'cloudfront get-distribution', (x) => x.output.includes('DefaultTTL')));
const invId = (c: TaskContext) => dist(c.env)?.invalidations[0]?.id ?? '<無効化の ID>';

/* 38 */
const ipSet = (env: AwsEnv) => env.ipSets.find((s) => s.name === 'bad-ips');
const acl = (env: AwsEnv) => env.webAcls[0];
const idOf = (arn: string | undefined) => arn?.split('/').pop() ?? '<ID>';
const blockedSeen = (c: TaskContext) => {
  const r = lastTo(c, dist(c.env)?.domainName ?? '');
  return r?.status === 403 && r.body.includes('Request blocked');
};
const officeFree = (env: AwsEnv) => !!ipSet(env) && !ipSet(env)!.addresses.some((a) => ipInCidr(CLIENT_IP, a));
const attackerBlocked = (env: AwsEnv) => !!ipSet(env)?.addresses.some((a) => ipInCidr(ATTACKER, a));
const ipFixed = (env: AwsEnv) => officeFree(env) && attackerBlocked(env);
const samples = (env: AwsEnv) => env.webAcls[0]?.samples ?? [];
const xssBlocked = (c: TaskContext) => ipFixed(c.env) && samples(c.env).some((s) => s.clientIp === CLIENT_IP && s.rule === CRS && s.action === 'BLOCK');
const officeOk = (c: TaskContext) => ipFixed(c.env) && samples(c.env).some((s) => s.clientIp === CLIENT_IP && s.action === 'ALLOW');
/** get-sampled-requests for this rule metric whose output shows `ip` */
const sawSample = (c: TaskContext, metric: string, ip: string) => !!ranAws(c, 'wafv2 get-sampled-requests', (x) => param(x, 'rule-metric-name') === metric && x.output.includes(`"${ip}"`));
const DAY = 24 * 3600 * 1000;
const isoSec = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sampleCmd = (c: TaskContext, metric: string) =>
  `aws wafv2 get-sampled-requests --web-acl-arn ${acl(c.env)?.arn ?? '<ウェブ ACL の ARN>'} --rule-metric-name ${metric} --scope CLOUDFRONT --time-window StartTime=${isoSec(Date.now() - 2 * DAY)},EndTime=${isoSec(Date.now())} --max-items 100 --region us-east-1`;

const patches: CliPatches = {
  /* ---------------- 35 Route 53 ---------------- */
  'route53-dns': {
    summary: 'www 付きでは開けるのに、www なしでは開けない。dig と aws route53 で DNS レコードを調べ、Zone Apex にエイリアスレコードを作る',
    files: (env) => {
      const dns = env.loadBalancers.find((l) => l.loadBalancerName === 'web-alb')?.dnsName ?? 'web-alb.ap-northeast-1.elb.amazonaws.com';
      const batch = (comment: string, rrs: object) => JSON.stringify({ Comment: comment, Changes: [{ Action: 'CREATE', ResourceRecordSet: { Name: SHOP_DOMAIN, ...rrs } }] }, null, 2) + '\n';
      return {
        'apex-cname.json': batch('Zone Apex to web-alb (CNAME)', { Type: 'CNAME', TTL: 300, ResourceRecords: [{ Value: dns }] }),
        'apex-alias.json': batch('Zone Apex to web-alb (alias)', { Type: 'A', AliasTarget: { HostedZoneId: 'ALB_ZONE_ID', DNSName: 'ALB_DNS_NAME', EvaluateTargetHealth: false } }),
      };
    },
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('その電話帳って、どこにあるんですか？ 本棚ですか？'),
          hakase('AWS では **Route 53** というサービスが預かっておる。DNS が使うポート番号の 53 と、アメリカの国道 Route 66 をかけた名前だ。'),
          node('ダジャレじゃないですか。博士のギャグと同じレベルですね。'),
          hakase('一緒にするでない。Route 53 では、ドメインごとに **ホストゾーン** という入れ物を作る。電話帳 1 冊ぶんだ。インターネットに公開するものは **パブリックホストゾーン** といって、`aws route53 list-hosted-zones` で見ると `Config` の `PrivateZone` が `false` になっておる。'),
          node('どめいん？'),
          hakase(`\`${SHOP_DOMAIN}\` のような、うちが持っている名前の区画だ。会社名のようなもので、その下に \`www\` や \`shop\` のような部署の名前を好きなだけ作れる。`),
          node('会社の下に部署があるイメージですね。www 部。'),
          hakase(`うむ。そして部署の付かない会社名そのもの、\`${SHOP_DOMAIN}\` を **Zone Apex** という。Apex は「頂点」。ゾーンのてっぺんの名前だ。`),
          node('会社の代表番号みたいなものですね。…代表番号が電話帳に載ってない会社って、潰れたのかなって思いますよね。'),
          hakase('まさに今、お客さんにそう思われておる。'),
        ],
      },
      3: [
        {
          type: 'dialogue',
          lines: [
            hakase('それから、ホストゾーンを作ると、Route 53 は最初から 2 つのレコードを Zone Apex に入れておく。**NS** と **SOA** だ。'),
            node('えぬえす？ えすおーえー？'),
            hakase('NS は Name Server。「この電話帳を預かっている DNS サーバーはこの 4 台だ」という案内だ。SOA は Start of Authority。発行元や版の番号を書いた、電話帳の奥付だな。誰も読まんが、無いと電話帳として成り立たん。'),
            hakase('最後に、レコードには **TTL** という数字が付いておる。'),
            node('てぃーてぃーえる？'),
            hakase('Time To Live、答えの賞味期限だ。お客さんの代わりに DNS を引いてくれる **リゾルバー** (プロバイダーなどの DNS サーバー) は、一度引いた答えをメモしておく。これを **キャッシュ** という。TTL は、そのメモを使ってよい秒数だ。'),
            node('TTL が 300 なら、5 分間は電話帳を見直さずにメモで答える、と。'),
            hakase('うむ。だから DNS を変えても、すぐには効かん。深夜の切り替え作業で「変わらない！」と叫ぶ人間の 9 割はこれだ。'),
            node('残りの 1 割は？'),
            hakase('直すレコードを間違えておる。'),
          ],
        },
        {
          type: 'dialogue',
          lines: [
            hakase('講釈はここまでだ。まずは `curl` で症状を確かめる。Lesson 12 でやったとおり、`-v` を付ければ、どの区間で止まったかが `*` の行に出る。'),
            node('DNS だけを調べる道具はないんですか？ curl だと、ページを取りに行くところまで全部やっちゃいますよね。'),
            hakase('**dig** がある。DNS に名前を問い合わせて、返ってきた答えをそのまま見せる道具だ。`dig 名前` と打つだけだ。'),
            node('でぃぐ。掘るんですか？'),
            hakase('Domain Information Groper、「ドメインの情報を手探りするもの」の略だ。だが「掘る」と覚えてもよい。電話帳を掘り返して、奥付まで読み上げてくれる。'),
            node('博士の昔の失敗も掘り返せますか？'),
            hakase('それは NXDOMAIN、「そんな名前は無い」と返ってくる。'),
            node('都合の悪いことだけ電話帳から消してる…。'),
          ],
        },
      ],
      5: {
        type: 'exercise',
        title: '症状を確かめる',
        objective: `\`curl\` で \`http://${WWW}\` と \`http://${SHOP_DOMAIN}\` を開いて結果を比べ、\`dig\` で \`${SHOP_DOMAIN}\` を引く`,
        tasks: [
          { id: 'www', title: `\`curl -i http://${WWW}\` → 200 OK`, hint: '`-i` を付けると、1 行目にステータス (`HTTP/1.1 200 OK`) が出ます。', command: `curl -i http://${WWW}`, done: (c) => lastTo(c, WWW)?.status === 200 },
          { id: 'apex', title: `\`curl -v http://${SHOP_DOMAIN}\` → 名前が解決できない`, hint: '`*` で始まる行が経路の確認です。**DNS (Route 53)** の行を読みます。', command: `curl -v http://${SHOP_DOMAIN}`, done: (c) => lastTo(c, SHOP_DOMAIN)?.error === 'ERR_NAME_NOT_RESOLVED' },
          { id: 'dig', title: `\`dig ${SHOP_DOMAIN}\` で DNS の答えを見る`, hint: '`->>HEADER<<-` の行の `status` と、その次の行の `ANSWER:` の数を見ます。`dig www.webapp-shop.example` と見比べても構いません。', command: `dig ${SHOP_DOMAIN}`, done: (c) => ranDns(c, SHOP_DOMAIN) },
        ],
        validate: (c) =>
          lastTo(c, WWW)?.status === 200 && lastTo(c, SHOP_DOMAIN)?.error === 'ERR_NAME_NOT_RESOLVED' && ranDns(c, SHOP_DOMAIN)
            ? ok(
                node('www 付きは 200 OK。www なしは `Could not resolve host`…「ホスト名を解決できない」ですか？'),
                hakase('うむ。DNS に聞いても IP アドレスがもらえなかった、という意味だ。サーバーや ALB にたどり着く前に、電話帳の段階でつまずいておる。'),
                node('でも dig だと `status: NOERROR` で、エラーじゃないって言ってます。なのに `ANSWER: 0`…'),
                hakase('NOERROR は「その名前は電話帳にある」。ANSWER: 0 は「だが聞かれた A レコードは載っておらん」だ。代わりに AUTHORITY SECTION に奥付の SOA が出ておる。'),
                node('ALB が壊れてるわけじゃないんですね。よかった、僕のせいじゃない。'),
                hakase('喜ぶのは原因を見てからにしたまえ。次は `aws route53` でホストゾーンのレコードを読むぞ。'),
              )
            : ng(hakase(`\`curl -i http://${WWW}\` と \`curl -v http://${SHOP_DOMAIN}\` を 1 つずつ打つのだ。それから \`dig ${SHOP_DOMAIN}\` で、DNS が何と答えるかを見ろ。`)),
      },
      6: {
        type: 'exercise',
        title: 'レコードを調べる',
        objective: `\`aws route53 list-hosted-zones\` でホストゾーンの ID を調べ、\`list-resource-record-sets\` で \`${SHOP_DOMAIN}\` のレコードを確認する`,
        tasks: [
          {
            id: 'zones',
            title: '`aws route53 list-hosted-zones` でホストゾーンの ID を調べる',
            hint: "`Id` は `/hostedzone/Z…` の形です。`--query 'HostedZones[0].Id' --output text` で ID だけを取り出し、`ZONE_ID=$(...)` で変数に入れておくと後で楽です。",
            command: "ZONE_ID=$(aws route53 list-hosted-zones --query 'HostedZones[0].Id' --output text); echo $ZONE_ID",
            done: (c) => !!(ranAws(c, 'route53 list-hosted-zones') ?? ranAws(c, 'route53 list-hosted-zones-by-name')),
          },
          {
            id: 'zone',
            title: `\`aws route53 list-resource-record-sets\` で \`${SHOP_DOMAIN}\` のレコードを見る`,
            hint: '`--hosted-zone-id` には `/hostedzone/Z…` のままでも `Z…` だけでも渡せます。各レコードの `Name` と `Type` を見比べます。名前の最後の `.` は、DNS の根っこ (ルート) を表します。',
            command: (c) => `aws route53 list-resource-record-sets --hosted-zone-id ${zoneId(c)}`,
            done: (c) => !!ranAws(c, 'route53 list-resource-record-sets', (x) => param(x, 'hosted-zone-id').endsWith(zoneId(c))),
          },
        ],
        validate: (c) =>
          ranAws(c, 'route53 list-resource-record-sets', (x) => param(x, 'hosted-zone-id').endsWith(zoneId(c)))
            ? ok(
                node(`\`${WWW}.\` は \`CNAME\` で ALB の DNS 名を指しています。でも \`${SHOP_DOMAIN}.\` には \`NS\` と \`SOA\` しかありません！`),
                hakase('原因はそれだ。www なしの名前、つまり Zone Apex には、お客さんを案内するレコードが 1 つも無かった。代表番号の欄が空っぽの電話帳だ。'),
                node('じゃあ www と同じように、CNAME で ALB に向ければいいですね！'),
                hakase('やってみたまえ。レコードを足すのは `aws route53 change-resource-record-sets` だ。変更の中身は JSON で書いて、`--change-batch file://ファイル名` で渡す。`file://` を付けると、ファイルの中身がそのまま値になる。'),
                hakase('君の言うとおり CNAME で書いた `apex-cname.json` を、ホームディレクトリに置いておいた。`Name` は Zone Apex の名前そのもの。`SetIdentifier` や `Weight` を書かなければ、1 つの名前に 1 つの答えを返す素直な「シンプルルーティング」になる。'),
                node('…なんで「やってみたまえ」がそんなに楽しそうなんですか。'),
              )
            : ng(hakase('`aws route53 list-hosted-zones` で `Id` を調べて、`aws route53 list-resource-record-sets --hosted-zone-id <ID>` を打つのだ。電話帳は表紙を眺めても中身はわからんぞ。')),
      },
      7: {
        type: 'exercise',
        title: 'Zone Apex にレコードを作る',
        objective: `\`${SHOP_DOMAIN}\` が ALB \`web-alb\` を指すようにして、\`curl\` で開けることを確かめる。まず \`apex-cname.json\` の CNAME で作ってみて、エラーを読んでみよう`,
        tasks: [
          {
            id: 'cname',
            title: '`apex-cname.json` (CNAME) で `change-resource-record-sets` を打ち、エラーを読む',
            hint: '`cat apex-cname.json` で中身を見てから、`--change-batch file://apex-cname.json` で渡します。`InvalidChangeBatch` のエラーの "apex" に注目。',
            command: (c) => `cat apex-cname.json; aws route53 change-resource-record-sets --hosted-zone-id ${zoneId(c)} --change-batch file://apex-cname.json`,
            done: (c) => !!failedAws(c, 'route53 change-resource-record-sets', 'InvalidChangeBatch') || !!apexAlias(c.env),
          },
          {
            id: 'lb',
            title: '`apex-alias.json` の `ALB_ZONE_ID` と `ALB_DNS_NAME` を、`web-alb` の値に置き換える',
            hint: "エイリアスの `AliasTarget` には、向き先の DNS 名 (`DNSName`) と、向き先が属するホストゾーンの ID (ALB の `CanonicalHostedZoneId`) を書きます。`aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text` で取り出し、`sed -i \"s/ALB_ZONE_ID/$ZONE/\" apex-alias.json` のように置き換えます。",
            command:
              "ZONE=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text); DNS=$(aws elbv2 describe-load-balancers --names web-alb --query 'LoadBalancers[0].DNSName' --output text); sed -i -e \"s/ALB_ZONE_ID/$ZONE/\" -e \"s/ALB_DNS_NAME/$DNS/\" apex-alias.json; cat apex-alias.json",
            done: (c) => !!ranAws(c, 'elbv2 describe-load-balancers', (x) => (x.query ?? '').includes('CanonicalHostedZoneId')) || !!apexAlias(c.env),
          },
          {
            id: 'record',
            title: '`apex-alias.json` (タイプ A のエイリアス) でレコードを作る',
            hint: '`cat apex-alias.json` で、`ALB_ZONE_ID` と `ALB_DNS_NAME` が置き換わっているか確かめてから打ちます。返ってくる `ChangeInfo` の `Id` は次で使います。',
            command: (c) => `aws route53 change-resource-record-sets --hosted-zone-id ${zoneId(c)} --change-batch file://apex-alias.json`,
            done: (c) => !!apexAlias(c.env),
          },
          {
            id: 'browse',
            title: `変更が \`INSYNC\` になるのを待って \`curl -i http://${SHOP_DOMAIN}\` → 200 OK`,
            hint: '`aws route53 wait resource-record-sets-changed --id <ChangeInfo の Id>` は、変更が Route 53 の DNS サーバー全部に行き渡る (`PENDING` → `INSYNC`) まで待ちます。開けなければ `dig webapp-shop.example` で、ANSWER SECTION に A レコードが出るかを見ます。',
            command: (c) => `${lastChangeId(c) ? `aws route53 wait resource-record-sets-changed --id ${lastChangeId(c)} && ` : ''}curl -i http://${SHOP_DOMAIN}`,
            done: apexOk,
          },
        ],
        validate: (c) => {
          if (!apexAlias(c.env))
            return ng(
              hakase('Zone Apex にエイリアスの A レコードがまだない。CNAME は Zone Apex には作れんのだ。エラーにも `not permitted at apex` と書いてあったろう。'),
              hakase('`apex-alias.json` の `ALB_ZONE_ID` と `ALB_DNS_NAME` を、`aws elbv2 describe-load-balancers` の `CanonicalHostedZoneId` と `DNSName` に置き換えて、`change-resource-record-sets` に渡すのだ。'),
            );
          if (!apexOk(c)) return ng(hakase(`レコードはできた。だが開いて確かめるまでが仕事だ。\`curl -i http://${SHOP_DOMAIN}\` をもう一度打つのだ。`));
          return ok(
            node('開けました！ 200 OK です。`dig` で引くと、エイリアスなのに `A` レコードで IP アドレスが返ってきますね。でも、なんで CNAME はダメだったんですか？'),
            hakase('Zone Apex には必ず NS と SOA がある。そして CNAME には「同じ名前にほかのレコードを置いてはならん」という決まりがあるのだ。だから Zone Apex に CNAME は置けん。'),
            hakase('そこで Route 53 は、ALB などを A レコードとして答えられる **エイリアス** を用意しておる。伏線回収だな。'),
            node('すっきりしました。…最初から教えてくれてもよかったと思いますけど。'),
            hakase('エラーを自分で踏んだ人間は忘れん。ワシは踏ませる専門家だ。'),
          );
        },
      },
    },
  },

  /* ---------------- 36 ACM + CloudFront ---------------- */
  'acm-certificate': {
    summary: 'www 付きの HTTPS だけ証明書エラーになる。aws acm と aws cloudfront で、証明書の名前、リージョン、代替ドメイン名をそろえる',
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('で、「プライバシーが保護されません」っていうのは？'),
          hakase('**HTTPS** の話だ。HTTP に S (Secure) が付いたもので、通信を **TLS** という仕組みで暗号化する。'),
          node('てぃーえるえす？'),
          hakase('Transport Layer Security。昔は **SSL** と呼ばれておって、CloudFront の設定にも `SSLSupportMethod` のように古い名前が残っておる。同じものだと思ってよい。'),
          hakase('暗号化を始める前に、サーバーはブラウザに **証明書** を見せる。「私は確かにこの名前のサーバーだ」という身分証明書だ。守る名前が書いてあり、信頼できる発行元のハンコが押してある。'),
          node('社員証みたいなものですね。'),
          hakase('うむ。ブラウザや curl は、開いた名前が証明書に書いてあるかを確かめる。書いてなければ「偽物かもしれん」と警告を出す。それがさっきの画面だ。'),
          node('ブラウザのエラーコードは `ERR_CERT_COMMON_NAME_INVALID` でした。こもんねーむ？'),
          hakase('Common Name、証明書に書かれた名前のことだ。「名前が合わん」と言っておる。他人の社員証で入館しようとしたようなものだな。'),
          hakase('ちなみにワシは昔、自分の社員証で止められたことがある。退職扱いになっておってな。'),
          node('それ、ジョークじゃなくて事件ですよね。'),
        ],
      },
      2: {
        type: 'dialogue',
        lines: [
          node('でも CloudFront には、世界中のいろんなサイトが相乗りしてるんですよね。どのサイトの証明書を見せるか、どうやって決めるんですか？'),
          hakase(`ほう、鋭い。熱でもあるのか。ブラウザは暗号化の前に「${WWW} に用があります」と名乗る。これを **SNI** (Server Name Indication) という。`),
          node('えすえぬあい…雑居ビルの受付で「〇〇社に来ました」って言うやつですね。'),
          hakase('うむ。CloudFront は名乗られた名前で、見せる証明書を選ぶ。`curl -v` の `*` の行にある「TLS 証明書 (SNI)」が、その結果だ。'),
          hakase('ただし CloudFront が自分の名前として受け付けるのは、ディストリビューションの **代替ドメイン名** に登録した名前だけだ。知らん名前には、既定の `*.cloudfront.net` の証明書を見せる。`*` は「何でも当てはまる」印、**ワイルドカード** だ。'),
          node('設定の JSON だと `Aliases`、ドキュメントだと「代替ドメイン名 (CNAME)」ってなってますね。Lesson 35 の CNAME レコードと関係あるんですか？'),
          hakase('昔は独自ドメインを CNAME で CloudFront に向けるのが普通だった、その名残だ。今は Route 53 のエイリアスで向けてもかまわん。名前に惑わされるでない。'),
        ],
      },
      3: {
        type: 'dialogue',
        lines: [
          node('証明書は、どこでもらうんですか？ ハンコ屋さん？'),
          hakase('**ACM** (AWS Certificate Manager) だ。公開用の証明書を無料で発行して、期限の前に自動で更新までしてくれる。CLI では `aws acm` だ。'),
          node('無料で自動！ 博士よりやさしい。'),
          hakase('ただし罠が 1 つある。**CloudFront で使う証明書は、us-east-1 (米国東部 (バージニア北部)) でリクエストする** のだ。'),
          node('東京じゃダメなんですか？ Lesson 02 で、リソースはリージョンごとにあるって習いましたけど。'),
          hakase('CloudFront は特定のリージョンに属さないグローバルなサービスで、証明書は us-east-1 のものしか使えん決まりだ。この PC の既定は東京だから、CloudFront 用の証明書を `aws acm` で扱うときは毎回 `--region us-east-1` を付ける。東京で作って半日溶かした人間を、ワシは何人も知っておる。ワシも含めてな。'),
          hakase('最後に **DNS 検証**。ACM は発行の前に「本当にこのドメインの持ち主か」を確かめる。ACM が指定する CNAME レコードをホストゾーンに作れば、持ち主の証明になるのだ。'),
          node('自分ちの表札に、指定された合言葉を書いておく感じですね。持ち主じゃなきゃ書けない。'),
          hakase('そういうことだ。材料はそろった。まずは症状を、`curl` と `-v` で確かめるぞ。'),
        ],
      },
      4: {
        type: 'table',
        title: 'HTTPS に関わる設定',
        columns: ['設定', '場所 (CLI)', 'ポイント'],
        rows: [
          ['証明書', 'AWS Certificate Manager (`aws acm`)', '守る名前を全部入れる。ワイルドカード `*.example.com` は `example.com` 自体を含まない'],
          ['証明書のリージョン', 'ACM (`--region`)', '**CloudFront で使う証明書は us-east-1 (バージニア北部)** にリクエストする'],
          ['DNS 検証', 'Route 53 (`aws route53`)', 'ACM が示す CNAME をホストゾーンに作ると、ドメインの所有を証明できる'],
          ['代替ドメイン名 (CNAME)', 'CloudFront (`aws cloudfront`、設定の `Aliases`)', 'ディストリビューションで受け付ける名前。証明書に含まれている必要がある'],
        ],
      },
      5: {
        type: 'exercise',
        title: '症状を確かめる',
        objective: `\`curl -v https://${WWW}\` で、エラーと経路の確認の「TLS 証明書 (SNI)」の行を見る`,
        tasks: [{ id: 'err', title: `\`curl -v https://${WWW}\` → 証明書エラー`, hint: 'URL は `https://` で始めます。`*` で始まる行のうち、**TLS 証明書 (SNI)** の行を読みます。', command: `curl -v https://${WWW}`, done: (c) => lastTo(c, WWW, 'https')?.error === 'ERR_CERT_COMMON_NAME_INVALID' }],
        validate: (c) =>
          lastTo(c, WWW, 'https')?.error === 'ERR_CERT_COMMON_NAME_INVALID'
            ? ok(
                node(`「TLS 証明書 (SNI)」の行に「${WWW} は代替ドメイン名ではないため、既定の証明書 *.cloudfront.net が返されました」と出ています。最後の行は \`SSL: no alternative certificate subject name matches target host name\` です。`),
                hakase('「証明書のどの名前にも当てはまらん」という意味だ。DNS は正しく CloudFront まで届いておる。Lesson 35 のエイリアスはちゃんと働いておるわけだ。'),
                hakase('だが CloudFront は www を自分の名前として知らん。だから名前の違う証明書を見せてしまったのだ。'),
                node('雑居ビルの受付で「そんな会社はうちに入っていません」って言われたんですね。'),
                hakase('では受付の名簿を見よう。`aws cloudfront list-distributions` で一覧、`aws cloudfront get-distribution-config --id <ID>` で 1 つの設定が見られる。CloudFront はグローバルなサービスだから、こちらは `--region` を気にせんでよい。'),
              )
            : ng(hakase(`\`curl -v https://${WWW}\` と打つのだ。\`https://\` を忘れるな。エラーが出たら、\`*\` の行の「TLS 証明書 (SNI)」を読め。`)),
      },
      6: {
        type: 'exercise',
        title: 'ディストリビューションの設定を見る',
        objective: '`aws cloudfront get-distribution-config` で代替ドメイン名 (`Aliases`) と証明書 (`ViewerCertificate`) を確認し、その証明書の名前を `aws acm describe-certificate` で見る',
        tasks: [
          { id: 'list', title: '`aws cloudfront list-distributions` でディストリビューションの ID を調べる', hint: "`--query 'DistributionList.Items[].[Id,DomainName]' --output text` で、ID とドメイン名だけを出せます。", command: "aws cloudfront list-distributions --query 'DistributionList.Items[].[Id,DomainName]' --output text", done: (c) => !!ranAws(c, 'cloudfront list-distributions') },
          {
            id: 'dist',
            title: '`aws cloudfront get-distribution-config --id <ID>` で `Aliases` と `ViewerCertificate` を見る',
            hint: "`--query 'DistributionConfig.[Aliases,ViewerCertificate]'` で 2 つに絞れます。`Aliases` が代替ドメイン名、`ViewerCertificate` の `ACMCertificateArn` が使っている証明書です。",
            command: (c) => `aws cloudfront get-distribution-config --id ${distId(c)} --query 'DistributionConfig.[Aliases,ViewerCertificate]'`,
            done: sawDistConfig,
          },
          {
            id: 'cert',
            title: '`aws acm describe-certificate` で、その証明書の名前を見る',
            hint: '`--certificate-arn` に `ACMCertificateArn` の値を渡します。証明書は us-east-1 にあるので `--region us-east-1` を付けます (付けないと `ResourceNotFoundException`)。`SubjectAlternativeNames` が守っている名前です。',
            command: (c) => `aws acm describe-certificate --certificate-arn ${oldCertArn(c)} --region us-east-1 --query 'Certificate.[Status,SubjectAlternativeNames]'`,
            done: sawCertNames,
          },
        ],
        validate: (c) =>
          sawDistConfig(c) && sawCertNames(c)
            ? ok(
                node(`\`Aliases\` も、証明書の \`SubjectAlternativeNames\` も ${SHOP_DOMAIN} だけです。www を \`Aliases\` に足せばいいんですね！`),
                hakase('早とちりだ。代替ドメイン名に足せるのは、証明書に入っている名前だけだ。今の証明書に www は入っておらん。'),
                node('じゃあ先に、www 入りの証明書を ACM でもらってくる、と。'),
                hakase('そうだ。`--region` を間違えるなよ。フリではないぞ。'),
              )
            : ng(hakase('`aws cloudfront get-distribution-config --id <ID>` で設定を見るのだ。ID は `list-distributions` の `Id` だ。証明書の中身は、`ACMCertificateArn` を `aws acm describe-certificate` に渡して見ろ。`--region us-east-1` を忘れるな。')),
      },
      7: [
        {
          type: 'dialogue',
          lines: [
            hakase('証明書は `aws acm request-certificate` でリクエストする。最初の名前を `--domain-name` に、残りを `--subject-alternative-names` に書く。DNS 検証にするなら `--validation-method DNS` だ。'),
            node('`--validation-method` を省略したら？'),
            hakase('E メール検証になる。ドメインの管理者宛てに確認のメールが飛んで、誰も読まずに 72 時間で期限切れだ。'),
            hakase('リクエストすると、`aws acm describe-certificate` の `DomainValidationOptions` に、名前ごとの `ResourceRecord` が出る。作るべき CNAME の `Name` と `Value` だ。これを Lesson 35 の `change-resource-record-sets` で Route 53 に作る。'),
            node('名前も値も、長くてランダムな文字列ですよね。手で JSON を書くの、つらそう…'),
            hakase('そこで、`--query` を使って JSON を組み立てる。`{Changes: 式}` のように `{キー: 式}` と書くと、新しいオブジェクトを作れる。`` `"UPSERT"` `` のようにバッククォートで囲めば、式ではなくそのままの値だ。'),
            hakase('できた JSON を `> validation.json` でファイルに保存して、`file://validation.json` で渡す。`UPSERT` は「無ければ作り、あれば上書き」だ。'),
            node('aws の答えを、そのまま次の aws の入力にするんですね。伝言ゲームみたい。'),
            hakase('伝言ゲームと違って、途中で話が盛られることはない。人間を挟まんからな。'),
            hakase('発行には少し時間がかかる。Lesson 10 でやったウェイターの `aws acm wait certificate-validated` で、`ISSUED` になるまで待つのだ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'www を含む証明書をリクエストする',
          objective: `ACM で \`${SHOP_DOMAIN}\` と \`${WWW}\` の両方を含む証明書を、**us-east-1** (\`--region us-east-1\`) でリクエストし、DNS 検証で発行する`,
          tasks: [
            {
              id: 'region',
              title: '`aws acm request-certificate` を **`--region us-east-1`** で打つ',
              hint: `\`--domain-name ${SHOP_DOMAIN} --subject-alternative-names ${WWW} --validation-method DNS --region us-east-1\`。返ってきた \`CertificateArn\` は、\`CERT_ARN=$(... --query CertificateArn --output text)\` で変数に入れておくと楽です。`,
              command: `aws acm request-certificate --domain-name ${SHOP_DOMAIN} --subject-alternative-names ${WWW} --validation-method DNS --region us-east-1`,
              done: (c) => !!virginiaCert(c.env),
            },
            {
              id: 'json',
              title: '検証用の CNAME を `validation.json` に書き出す',
              hint: `\`aws acm describe-certificate --certificate-arn <ARN> --region us-east-1 --query ${VALIDATION_QUERY} > validation.json\`。\`cat validation.json\` で \`Changes\` に CNAME が 2 つ並んでいるか確かめます。`,
              command: (c) => `aws acm describe-certificate --certificate-arn ${newCertArn(c)} --region us-east-1 --query ${VALIDATION_QUERY} > validation.json; cat validation.json`,
              done: (c) => !!ranAws(c, 'acm describe-certificate', (x) => (x.query ?? '').includes('Changes')) || validationRecorded(c.env),
            },
            {
              id: 'records',
              title: '`validation.json` で Route 53 に CNAME を作る',
              hint: 'Lesson 35 と同じ `aws route53 change-resource-record-sets --hosted-zone-id <ID> --change-batch file://validation.json` です。ホストゾーンの ID は `aws route53 list-hosted-zones` で調べます。',
              command: (c) => `aws route53 change-resource-record-sets --hosted-zone-id ${zoneId(c)} --change-batch file://validation.json`,
              done: (c) => validationRecorded(c.env),
            },
            {
              id: 'validate',
              title: '`aws acm wait certificate-validated` で待ち、`Status` が `ISSUED` になる',
              hint: 'ウェイターにも `--certificate-arn` と `--region us-east-1` を付けます。プロンプトが戻ったら `describe-certificate` の `Certificate.Status` で確かめます。',
              command: (c) => `aws acm wait certificate-validated --certificate-arn ${newCertArn(c)} --region us-east-1 && aws acm describe-certificate --certificate-arn ${newCertArn(c)} --region us-east-1 --query Certificate.Status --output text`,
              done: (c) => virginiaCert(c.env)?.status === 'ISSUED',
            },
          ],
          validate: (c) => {
            const cert = virginiaCert(c.env);
            if (!cert)
              return ng(
                ...(wrongRegionCert(c.env)
                  ? [
                      hakase('その証明書は us-east-1 以外のリージョンにある。CloudFront は us-east-1 の証明書しか使えんのだ。'),
                      hakase('`--region us-east-1` を付けて、`aws acm request-certificate` を打ち直すのだ。言ったそばから半日溶かす気か。'),
                    ]
                  : [
                      hakase(`us-east-1 に、${SHOP_DOMAIN} と ${WWW} を含む証明書がまだない。`),
                      hakase('`aws acm request-certificate` に `--domain-name` と `--subject-alternative-names` で名前を 2 つ、`--validation-method DNS`、`--region us-east-1` を付けて打つのだ。'),
                    ]),
              );
            if (cert.status !== 'ISSUED')
              return ng(
                hakase('まだ `PENDING_VALIDATION` (検証保留中) だ。`describe-certificate` の `ResourceRecord` の CNAME を `validation.json` に書き出して、`change-resource-record-sets` で Route 53 に作るのだ。'),
                hakase('作ったら `aws acm wait certificate-validated --certificate-arn <ARN> --region us-east-1` で待て。'),
              );
            return ok(
              node('`ISSUED` になりました！'),
              hakase('ACM は、検証用の CNAME が DNS で引けることを確かめて「このドメインの持ち主だ」と認めたのだ。この CNAME を消さなければ、証明書は期限の前に自動で更新される。'),
              node('消したら？'),
              hakase('ある日証明書が切れて、全世界のお客さんに「プライバシーが保護されません」が出る。障害報告書の題材としては一級品だ。'),
              hakase('次は CloudFront に新しい証明書を付ける。CloudFront の設定変更は、世界中のエッジに配り終わるまで数分かかる。これを **デプロイ** という。`Status` が `InProgress` の間は配っている最中、`Deployed` になれば完了だ。'),
            );
          },
        },
      ],
      8: [
        {
          type: 'dialogue',
          lines: [
            hakase('CloudFront の設定には、一部だけを書き換える API が無い。`get-distribution-config` で設定を丸ごと取ってきて、直して、`update-distribution` で丸ごと返すのだ。'),
            node('部分修正できないんですか。不便ですね。'),
            hakase('その代わり **ETag** という設定のバージョン番号が付いてくる。返すときに `--if-match <ETag>` で「このバージョンを直しました」と言う。その間に誰かが設定を変えておれば、`PreconditionFailed` で突き返される。'),
            node('2 人で同時に直して、片方の変更が消える事故を防ぐんですね。'),
            hakase('そうだ。ワシは昔、同じ設定ファイルを先輩と同時に直して、先輩の 3 時間を消したことがある。ETag があれば、ワシの査定は 3 段階高かった。'),
            hakase('この端末にはエディタが無いから、取ってきた JSON は **sed** で直す。`sed -i \'s/元/新/\' ファイル` で、ファイルの中の「元」を「新」に書き換える。'),
            node('せど？'),
            hakase('Stream EDitor、流れてくる文字を決まりどおりに書き換える道具だ。直すのは 3 つ。`Aliases` の `Quantity` を 2 に、`Items` に www を足す。そして `ACMCertificateArn` と `Certificate` を新しい証明書の ARN にする。'),
            node('`Quantity` って、`Items` の数をわざわざ書くんですか？ 数えれば分かるのに。'),
            hakase('CloudFront の API の流儀だ。数え間違えると `InconsistentQuantities` で怒られる。数も数えられん人間に設定は任せん、ということだ。'),
          ],
        },
        {
          type: 'exercise',
          title: 'CloudFront に証明書と www を設定する',
          objective: `\`get-distribution-config\` で取った設定を直して、代替ドメイン名に \`${WWW}\` を追加し、新しい証明書に替える。デプロイ後に \`https://${WWW}\` を開く`,
          tasks: [
            {
              id: 'config',
              title: '`get-distribution-config` で、ETag を控えて設定を `dist-config.json` に保存する',
              hint: "`--query ETag --output text` で ETag だけ、`--query DistributionConfig > dist-config.json` で設定だけを取り出します。`update-distribution` に渡すのは `DistributionConfig` の中身だけです。",
              command: (c) => `aws cloudfront get-distribution-config --id ${distId(c)} --query ETag --output text; aws cloudfront get-distribution-config --id ${distId(c)} --query DistributionConfig > dist-config.json`,
              done: (c) => !!ranAws(c, 'cloudfront get-distribution-config', (x) => x.query?.trim() === 'DistributionConfig') || distFixed(c.env),
            },
            {
              id: 'edit',
              title: '`sed` で `dist-config.json` を直し、`update-distribution` で返す',
              hint: `\`-e\` 1 つが置き換え 1 つです。\`/"Aliases"/,/]/ s/"Quantity": 1/"Quantity": 2/\` は「"Aliases" の行から最初の ] の行までの間だけ」で数を 2 に、\`s/"${SHOP_DOMAIN}"$/…/\` は Items の行に www を足し、\`s#古いARN#新しいARN#\` は証明書を替えます (ARN に / が入るので区切りを # に)。\`cat dist-config.json\` で確かめてから、\`aws cloudfront update-distribution --id <ID> --if-match <ETag> --distribution-config file://dist-config.json\` を打ちます。`,
              command: (c) =>
                `sed -i -e '/"Aliases"/,/]/ s/"Quantity": 1/"Quantity": 2/' -e 's/"${SHOP_DOMAIN}"$/"${SHOP_DOMAIN}", "${WWW}"/' -e 's#${oldCertArn(c)}#${newCertArn(c)}#' dist-config.json && aws cloudfront update-distribution --id ${distId(c)} --if-match ${dist(c.env) ? etagOf(dist(c.env)) : '<ETag>'} --distribution-config file://dist-config.json --query 'Distribution.[Status,DistributionConfig.Aliases.Items]'`,
              done: (c) => distFixed(c.env),
            },
            {
              id: 'browse',
              title: `\`aws cloudfront wait distribution-deployed\` で待ってから \`curl -I https://${WWW}\` → 200 OK`,
              hint: '`Status` が `InProgress` の間は、まだ配っている最中です。ウェイターのプロンプトが戻ったら `curl` で開きます。証明書のエラーが続くなら `curl -v` で TLS 証明書 (SNI) の行を見ます。',
              command: (c) => `aws cloudfront wait distribution-deployed --id ${distId(c)} && curl -I https://${WWW}`,
              done: wwwHttpsOk,
            },
          ],
          validate: (c) => {
            if (!distFixed(c.env)) return ng(hakase(`\`get-distribution-config\` で \`Aliases\` に ${SHOP_DOMAIN} と ${WWW} の両方があるか、\`ACMCertificateArn\` が www 入りの新しい証明書になっているかを確かめるのだ。www なしを消すと、今度はそっちが壊れるぞ。`));
            if (!wwwHttpsOk(c)) return ng(hakase(`設定はできた。\`aws cloudfront wait distribution-deployed --id <ID>\` でデプロイを待ってから、\`curl -I https://${WWW}\` をもう一度打つのだ。`));
            return ok(
              node('`HTTP/1.1 200 OK` が返ってきました！ 証明書のエラーも出ません。'),
              hakase('証明書の名前、証明書のリージョン、CloudFront の代替ドメイン名、Route 53 のレコード。4 つがそろって、ようやく独自ドメインの HTTPS が動く。'),
              node('4 つもあるんですね。1 つでも欠けたら…'),
              hakase('真っ赤な画面だ。4 つ全部を覚えておる人間は少ない。だから障害はなくならん。ワシの飯の種だな。'),
            );
          },
        },
      ],
    },
  },

  /* ---------------- 37 CloudFront cache ---------------- */
  'cloudfront-cache': {
    summary: 'S3 のページを更新したのにサイトが変わらない。curl -i の X-Cache と Age でキャッシュを確かめ、aws cloudfront create-invalidation で最新にする',
    steps: {
      1: {
        type: 'dialogue',
        lines: [
          node('本当にキャッシュのせいか、どうやったらわかるんですか？'),
          hakase('応答の **ヘッダー** を見る。ページ本体とは別に付いてくる、荷物の送り状のような情報だ。`curl -i` なら本体の上に、`curl -I` ならヘッダーだけが出る。'),
          node('へっだー。送り状なら、どこから来たか書いてありそうですね。'),
          hakase('そのとおり。**X-Cache** が `Hit from cloudfront` なら、エッジのキャッシュから返した。`Miss from cloudfront` なら、オリジンまで取りに行った、という印だ。'),
          node('ヒットは当たりで、ミスは外れ。'),
          hakase('キャッシュに当たったかどうか、だ。**Age** は、そのコピーをキャッシュしてから何秒たったか。コピーの年齢だな。'),
          node('年齢。ワインみたいに、寝かせるほどおいしくなったり…'),
          hakase('せん。Web ページは寝かせると腐るだけだ。君の企画書と同じでな。'),
          hakase('ついでに `X-Amz-Cf-Pop` は、答えたエッジの名前だ。`NRT` は成田空港のコード。エッジには近くの空港のコードが付いておる。'),
          node('空港コード！ ちょっと旅行気分ですね。'),
          hakase('旅行はキャンペーンを直してからだ。開くのはディストリビューションのドメイン名 (`d…cloudfront.net`) で、`aws cloudfront list-distributions` の `DomainName` にある。S3 のほうは `aws s3 ls` で index.html の最終更新日時を見て、どちらが新しいか比べるのだ。'),
        ],
      },
      2: {
        type: 'exercise',
        title: 'キャッシュを確かめる',
        objective: 'ディストリビューションのドメイン名 (d…cloudfront.net) を `curl -i` で開き、応答ヘッダーの **X-Cache** と **Age** を確認する。`aws s3 ls` で index.html の最終更新日時も見てみよう',
        tasks: [
          { id: 'domain', title: '`aws cloudfront list-distributions` でドメイン名を調べる', hint: "`--query 'DistributionList.Items[0].DomainName' --output text` でドメイン名だけを出せます。`DOMAIN=$(...)` で変数に入れておくと楽です。", command: "aws cloudfront list-distributions --query 'DistributionList.Items[0].DomainName' --output text", done: (c) => !!ranAws(c, 'cloudfront list-distributions') },
          { id: 'browse', title: '`curl -i https://<ドメイン名>/` で開き、`X-Cache` と `Age` を見る', hint: 'ヘッダーは本体 (HTML) の上に並びます。`X-Cache` と `Age` の行を探します。', command: (c) => `curl -i https://${domain(c)}/`, done: staleSeen },
          { id: 's3', title: `\`aws s3 ls s3://${STATIC_BUCKET}/\` で index.html の最終更新日時を見る`, hint: '左端の日時が最終更新日時です。curl の `Age` (秒) と比べます。', command: `aws s3 ls s3://${STATIC_BUCKET}/`, done: sawS3 },
        ],
        validate: (c) =>
          staleSeen(c) && sawS3(c)
            ? ok(
                node('`X-Cache: Hit from cloudfront`、`Age` は 3600 秒くらい…1 時間前のコピーです！ S3 のほうは 10 分前に更新されてるのに。'),
                hakase('Hit はキャッシュから返した印だ。エッジはオリジン (S3) に聞きに行かず、1 時間前の「夏のセール」を配り続けておる。'),
                node('じゃあ、このコピーはいつまで配られ続けるんですか？'),
                hakase('Lesson 35 の DNS と同じで、**TTL** で決まる。CloudFront では **ビヘイビア** に書いてある。ビヘイビアは、URL のパスごとに「どのオリジンから取り、どれだけキャッシュするか」を決める設定だ。JSON の `DefaultCacheBehavior` は、ほかのパスパターンに当てはまらない「全部のパス」のビヘイビアだ。'),
                node('びへいびあ…お行儀ですね。うちのサイトのお行儀を見に行きます。'),
              )
            : ng(hakase(`\`aws cloudfront list-distributions\` で \`DomainName\` (d…cloudfront.net) を調べて、\`curl -i https://<ドメイン名>/\` で開くのだ。それから \`aws s3 ls s3://${STATIC_BUCKET}/\` で、index.html の最終更新日時を見比べろ。片方だけでは比べようがない。`)),
      },
      3: {
        type: 'exercise',
        title: 'キャッシュの期間を調べる',
        objective: '`aws cloudfront get-distribution-config` で `DefaultCacheBehavior` の `DefaultTTL` を確認する',
        tasks: [
          {
            id: 'ttl',
            title: '`get-distribution-config` で `DefaultCacheBehavior` を見る',
            hint: "`aws cloudfront get-distribution-config --id <ID> --query 'DistributionConfig.DefaultCacheBehavior'`。ID は `list-distributions` の `Id` です。`DefaultTTL` (秒) を時間や日に換算してみましょう。",
            command: (c) => `aws cloudfront get-distribution-config --id ${distId(c)} --query 'DistributionConfig.DefaultCacheBehavior'`,
            done: sawTtl,
          },
        ],
        validate: (c) =>
          sawTtl(c)
            ? ok(
                node('`ViewerProtocolPolicy` っていう項目もあります。びゅーわー？'),
                hakase('ビューワーは、ページを見に来るブラウザのことだ。その項目は、ブラウザが http:// で来たときの扱いを決める。`redirect-to-https` なら「暗号化した https:// で来直してくれ」と案内し直す。今日はキャッシュの話だから、そこは触らんでよい。'),
                node('`DefaultTTL` は 86400 秒…1 日です！ 明日まで待てば直るってことですか？'),
                hakase('そうだ。オリジンが Cache-Control (「何秒キャッシュしてよいか」を伝えるヘッダー) を返さないと、エッジはこの 1 日を使う。キャンペーンが明日からなら、待てばよい。'),
                node('今日からです…。部長の顔が浮かびます。'),
                hakase('なら、エッジに今すぐ古いコピーを捨てさせる。これが **無効化 (Invalidation)** だ。`aws cloudfront create-invalidation` の `--paths` に、捨てたいファイルのパスを `/` から書く。このサイトは `/` を開くと index.html が返る (設定の `DefaultRootObject`) から、`/index.html` だ。'),
                node('全部まとめて捨てるなら `/*` ですね。'),
                hakase('うむ。ただし `*` はシェルがファイル名に展開してしまうから、`\'/*\'` と引用符で囲むのだぞ。'),
              )
            : ng(hakase("`aws cloudfront get-distribution-config --id <ID> --query 'DistributionConfig.DefaultCacheBehavior'` を打つのだ。`DefaultTTL` がキャッシュの期間 (秒) だ。")),
      },
      4: {
        type: 'exercise',
        title: '無効化して最新にする',
        objective: '`aws cloudfront create-invalidation` でキャッシュから index.html を消し、`curl -i` で新しいページが返る (X-Cache: Miss) ことを確かめる',
        tasks: [
          { id: 'inv', title: '`create-invalidation --paths /index.html` で無効化を作る', hint: "パスは / で始めます (`'/*'` でも構いません)。返ってくる `Invalidation` の `Id` と `Status` を見ます。", command: (c) => `aws cloudfront create-invalidation --distribution-id ${distId(c)} --paths /index.html`, done: (c) => !!dist(c.env)?.invalidations.length },
          { id: 'wait', title: '`aws cloudfront wait invalidation-completed` で `Completed` になるまで待つ', hint: '`--distribution-id` とあわせて、`--id` に無効化の `Id` (I…) を渡します。', command: (c) => `aws cloudfront wait invalidation-completed --distribution-id ${distId(c)} --id ${invId(c)}`, done: (c) => invalidated(c.env) },
          { id: 'fresh', title: '`curl -i` でもう一度開く → 「秋のキャンペーン」', hint: 'ヘッダーの `X-Cache` が Miss に変わっているかも確認します。もう一度打つと、どうなるでしょう。', command: (c) => `curl -i https://${domain(c)}/; curl -I https://${domain(c)}/`, done: freshSeen },
        ],
        validate: (c) => {
          if (!invalidated(c.env))
            return dist(c.env)?.invalidations.some((i) => i.status === 'Completed')
              ? ng(hakase('無効化は終わったが、index.html のキャッシュが残っている。`--paths` を確かめるのだ。'), hakase('`/index.html` か `\'/*\'` を、先頭の `/` 付きで書く。違う場所を掃除しても、汚れは消えんぞ。'))
              : ng(hakase('`aws cloudfront create-invalidation --distribution-id <ID> --paths /index.html` で無効化を作り、`aws cloudfront wait invalidation-completed` で `Completed` になるまで待つのだ。'));
          if (!freshSeen(c)) return ng(hakase('`curl -i` でディストリビューションのドメイン名をもう一度開くのだ。X-Cache が Miss なら、オリジンから取り直した証拠だ。'));
          return ok(
            node('「秋のキャンペーン」になりました！ X-Cache は Miss、もう一度開くと Hit です。'),
            hakase('無効化のあとの最初のリクエストで、エッジは S3 から新しいページを取り直し、またキャッシュしたのだ。だから 2 回目は Hit になる。'),
            node('部長が来る前に間に合いました！'),
            hakase('運のいい男だ。ただし、新しいページもまた 1 日キャッシュされる。キャンペーンの誤字を見つけたら、また無効化だぞ。'),
          );
        },
      },
    },
  },

  /* ---------------- 38 WAF ---------------- */
  'waf-blocked': {
    summary: '昨日の攻撃対策のあと、社内から 403 になった。aws wafv2 get-sampled-requests でルールを突き止め、IP セットを直す',
    steps: {
      2: {
        type: 'dialogue',
        lines: [
          hakase('`webapp-acl` のルールは 2 つだ。1 つ目の `block-bad-ips` は、**IP セット** `bad-ips` に載っている送信元を Block する。'),
          node('あいぴーせっと？'),
          hakase('ブロックしたい IP アドレスの範囲を、CIDR で並べた名簿だ。ルールはこの名簿を見て判断する。'),
          node('CIDR って、Lesson 04 でやった `/24` とか `/16` とかの書き方ですね。'),
          hakase('2 つ目の `AWS-AWSManagedRulesCommonRuleSet` は **マネージドルール** だ。'),
          node('まねーじど…誰かが管理してくれてるルール？'),
          hakase('うむ。AWS が作って、新しい攻撃の手口に合わせて更新し続けてくれるルールの詰め合わせだ。設定の JSON では `ManagedRuleGroupStatement` (マネージドルールグループ) と出る。よくある攻撃のパターンを、自分で 1 つずつ書かずにすむ。'),
          node('冷凍食品の詰め合わせですね。チンするだけ。'),
          hakase('たとえば URL に `<script>alert(1)</script>` のようなスクリプトを仕込み、ページを見た他人のブラウザで実行させる **クロスサイトスクリプティング (XSS)**。そういう攻撃の「形」を見て止めるのだ。'),
          node('IP じゃなくて、手口で止めるんですね。'),
        ],
      },
      3: {
        type: 'dialogue',
        lines: [
          node('僕の IP が、どのルールで止められたかを調べるには？'),
          hakase('ウェブ ACL の **サンプリングされたリクエスト** だ。WAF が検査したリクエストの一部を、送信元 IP・アクション・URI 付きで、見本として残しておる。`aws wafv2 get-sampled-requests` で見られる。'),
          node('防犯カメラの録画ですね。僕が映ってたら恥ずかしいな。'),
          hakase('映っておるから 403 なのだ。録画はルールごとに分かれておる。`--rule-metric-name` に、ルールの **メトリクス名** (ルールごとの名札。ここではルール名と同じ) を渡し、`--time-window` で見たい時間帯を `StartTime=…,EndTime=…` と指定する。'),
          node('時間帯まで指定するんですか。防犯カメラの巻き戻しみたいですね。'),
          hakase('CLI のサービス名は `wafv2`。WAF はよく Shield と並べて紹介されるが、Shield は DDoS (大量のアクセスで押しつぶす攻撃) 対策のサービスで、今日は出番がない。'),
          hakase('CloudFront 用のウェブ ACL は `--scope CLOUDFRONT` を付けて扱う。住んでおるのは Lesson 36 の証明書と同じ us-east-1 だから、`--region us-east-1` も要る。付け忘れると `The scope is not valid` と門前払いだ。さあ、録画を見に行くぞ。'),
        ],
      },
      4: {
        type: 'exercise',
        title: 'どのルールで止まったか調べる',
        objective: `ディストリビューションのドメイン名を \`curl -i\` で開いて 403 を確かめ、\`aws wafv2 get-sampled-requests\` で、自分の IP (${CLIENT_IP}) を止めたルールと、昨日の攻撃の記録を見る`,
        tasks: [
          { id: 'browse', title: '`curl -i https://<ドメイン名>/` → 403 (Request blocked)', hint: "ドメイン名は `aws cloudfront list-distributions --query 'DistributionList.Items[0].DomainName' --output text` で調べます。", command: (c) => `curl -i https://${domain(c)}/`, done: blockedSeen },
          {
            id: 'sample',
            title: `\`get-sampled-requests\` でルール \`block-bad-ips\` の録画を見る → 送信元 ${CLIENT_IP}`,
            hint: "`--web-acl-arn` は `aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1` の `ARN`。`--rule-metric-name block-bad-ips --scope CLOUDFRONT --time-window StartTime=<2 日前>,EndTime=<今> --max-items 100 --region us-east-1` を付けます。日時は `2026-11-20T09:00:00Z` のような UTC の形で書きます。`Request.ClientIP` と `Action` を見ます。",
            command: (c) => `aws wafv2 list-web-acls --scope CLOUDFRONT --region us-east-1 --query 'WebACLs[].[Name,ARN]' --output text; ${sampleCmd(c, 'block-bad-ips')}`,
            done: (c) => blockedSeen(c) && sawSample(c, 'block-bad-ips', CLIENT_IP),
          },
          { id: 'managed', title: `\`--rule-metric-name ${CRS}\` で、マネージドルールの録画を見る`, hint: `↑ キーで前のコマンドを呼び出し、\`--rule-metric-name\` だけを \`${CRS}\` に替えます。`, command: (c) => sampleCmd(c, CRS), done: (c) => sawSample(c, CRS, ATTACKER) },
        ],
        validate: (c) =>
          blockedSeen(c) && sawSample(c, 'block-bad-ips', CLIENT_IP) && sawSample(c, CRS, ATTACKER)
            ? ok(
                node(`僕の IP ${CLIENT_IP} が、ルール \`block-bad-ips\` で BLOCK されています！ 攻撃元は .77 なのに…`),
                hakase(`マネージドルールの録画も見たな。昨日の .77 の \`<script>\` 入りのリクエストは、マネージドルールがちゃんと止めておる。\`RuleNameWithinRuleGroup\` が、詰め合わせの中で当たったルールの名前だ。`),
                hakase('`--rule-metric-name` をウェブ ACL 自身の名札 `webapp-acl` にすると、どのルールにも当たらず通ったものが見える。昨日の .77 は、`/wp-login.php` や `/.env` を ALLOW で通っておる。'),
                node('わぷろぐいん…ドットえんぶ…？'),
                hakase('管理画面や秘密の設定ファイルを探して回る、空き巣の下見だ。それを見て慌てて IP ごと止めたのだろう。では `aws wafv2 get-web-acl` でルールの `Statement` (ルールが何を調べるかの条件) を見て、IP セットの中身を確かめるのだ。'),
              )
            : ng(hakase(`\`curl -i https://<ドメイン名>/\` で 403 を確かめるのだ。それから \`aws wafv2 get-sampled-requests\` を \`--rule-metric-name block-bad-ips\` と \`${CRS}\` で 1 回ずつ打って、自分の IP (${CLIENT_IP}) と .77 を探せ。\`--scope CLOUDFRONT --region us-east-1\` を忘れるな。`)),
      },
      5: [
        {
          type: 'dialogue',
          lines: [
            hakase('`get-web-acl` には `--name`、`--scope`、`--id` を渡す。`Id` は `list-web-acls` に出ておる。IP セットも同じで、`get-ip-set` に `--name bad-ips` と `Id` だ。'),
            node('書き換えは `update-ip-set` ですか？'),
            hakase('うむ。ただし `--addresses` には、残したいものも含めて全部を書く。足し算ではなく、名簿を丸ごと差し替えるのだ。'),
            hakase('それから `--lock-token`。`get-ip-set` の `LockToken` を渡す。Lesson 36 の ETag と同じ、バージョン番号だ。古いバージョンの名簿を直して出すと `WAFOptimisticLockException` で突き返される。'),
            node('おぷてぃみすてぃっく…楽観的？'),
            hakase('「どうせ誰も同時には触らんだろう」と楽観して作業を始め、出すときにだけ確かめるやり方だ。悲観して毎回鍵をかけるより速い。ワシの人生観とは逆だがな。'),
          ],
        },
        {
          type: 'exercise',
          title: 'IP セットを直す',
          objective: `IP セット \`bad-ips\` を、攻撃元 \`${ATTACKER}\` だけをブロックする内容に直す (社内 ${CLIENT_IP} は含めない)`,
          tasks: [
            {
              id: 'acl',
              title: '`aws wafv2 get-web-acl` でルールの `Statement` を見る',
              hint: '`--name webapp-acl --scope CLOUDFRONT --id <Id> --region us-east-1`。`block-bad-ips` の `IPSetReferenceStatement` の `ARN` が、見ている IP セットです。',
              command: (c) => `aws wafv2 get-web-acl --name webapp-acl --scope CLOUDFRONT --id ${idOf(acl(c.env)?.arn)} --region us-east-1 --query 'WebACL.Rules[].[Name,Priority,Statement]'`,
              done: (c) => !!ranAws(c, 'wafv2 get-web-acl') || ipFixed(c.env),
            },
            {
              id: 'get',
              title: '`aws wafv2 get-ip-set` で `bad-ips` の中身と `LockToken` を見る',
              hint: '`Id` は ARN の最後の部分か、`aws wafv2 list-ip-sets --scope CLOUDFRONT --region us-east-1` の `Id` です。`Addresses` と `LockToken` を見ます。',
              command: (c) => `aws wafv2 get-ip-set --name bad-ips --scope CLOUDFRONT --id ${idOf(ipSet(c.env)?.arn)} --region us-east-1`,
              done: (c) => !!ranAws(c, 'wafv2 get-ip-set') || ipFixed(c.env),
            },
            {
              id: 'fix',
              title: '`aws wafv2 update-ip-set` で、`--addresses` を攻撃元 1 つだけにする',
              hint: '1 つの IP アドレスだけを指すなら /32 です。`--lock-token` には `get-ip-set` の `LockToken` を渡します。',
              command: (c) => `aws wafv2 update-ip-set --name bad-ips --scope CLOUDFRONT --id ${idOf(ipSet(c.env)?.arn)} --addresses ${ATTACKER}/32 --lock-token ${ipSet(c.env) ? ipSetLockToken(ipSet(c.env)!) : '<LockToken>'} --region us-east-1`,
              done: (c) => ipFixed(c.env),
            },
          ],
          validate: (c) => {
            if (!officeFree(c.env)) return ng(hakase(`まだ ${CLIENT_IP} が IP セットに含まれておる。198.51.100.0/24 は .0 から .255 までの 256 個だぞ。攻撃元 1 つだけなら \`/32\` だ。\`update-ip-set\` の \`--addresses\` に書き直すのだ。`));
            if (!attackerBlocked(c.env)) return ng(hakase(`攻撃元 ${ATTACKER} まで外してしまった。泥棒に合鍵を返してどうする。\`--addresses ${ATTACKER}/32\` の 1 つは残すのだ。`));
            return ok(
              node(`\`${ATTACKER}/32\` にしました。/24 だと、同じプロバイダーの範囲にいる社内まで巻き込んでいたんですね。`),
              hakase('そうだ。/24 で止めるのは、泥棒の住む町内ごと出入り禁止にしたようなものだ。その町内に、自分の会社があったわけだ。'),
              node('身内を締め出してたなんて…'),
              hakase('ブロックは「必要な範囲だけ」。Security Group やネットワーク ACL と同じ考え方だ。'),
            );
          },
        },
      ],
      6: {
        type: 'exercise',
        title: '開けることと、攻撃が止まることを確かめる',
        objective: `\`curl\` で社内から開けることを確かめ、次に \`/?q=<script>alert(1)</script>\` を付けて開き、マネージドルールでブロックされることを \`get-sampled-requests\` で確かめる`,
        tasks: [
          { id: 'ok', title: '`curl -i https://<ドメイン名>/` → 200 OK', hint: 'IP セットを直したら、同じドメイン名をパスを付けずに開き直します。まだ 403 なら、`get-sampled-requests` でどのルールに止められたかを確認します。', command: (c) => `curl -i https://${domain(c)}/`, done: officeOk },
          { id: 'xss', title: "`curl -i 'https://<ドメイン名>/?q=<script>alert(1)</script>'` → 403", hint: 'URL 全体を `\'` で囲みます。囲まないと、シェルが `<` や `>` をファイルの読み書きの記号として扱ってしまいます。', command: (c) => `curl -i 'https://${domain(c)}/?q=<script>alert(1)</script>'`, done: xssBlocked },
          { id: 'rule', title: `\`get-sampled-requests\` で、自分の \`<script>\` 入りのリクエストが \`${CRS}\` に止められたことを見る`, hint: `\`--rule-metric-name ${CRS}\` で、\`ClientIP\` が ${CLIENT_IP} の行を探します。\`EndTime\` は今の日時にします。`, command: (c) => sampleCmd(c, CRS), done: (c) => xssBlocked(c) && sawSample(c, CRS, CLIENT_IP) },
        ],
        validate: (c) =>
          officeOk(c) && xssBlocked(c) && sawSample(c, CRS, CLIENT_IP)
            ? ok(
                node(`普通のページは開けて、\`<script>\` 付きは 403 で止まりました！ 止めたのは \`${CRS}\` です。`),
                hakase('IP で止めるルールは、攻撃元が IP を変えれば効かん。攻撃の「形」で止めるマネージドルールと組み合わせるのが基本だ。'),
                node('IP の名簿と、手口の見張り番の二段構えですね。'),
                hakase('そうだ。慌てて町内ごと締め出した誰かさんの始末書には、「落ち着いてサンプルを読むこと」と書いておいてやろう。'),
              )
            : ng(hakase(`まずドメイン名だけを \`curl -i\` で開いて 200 を確かめ、次に末尾へ \`/?q=<script>alert(1)</script>\` を付けて、URL 全体を \`'\` で囲んで開くのだ。止まったら、\`get-sampled-requests --rule-metric-name ${CRS}\` で自分の IP を探せ。`)),
      },
    },
  },
};

export default patches;
