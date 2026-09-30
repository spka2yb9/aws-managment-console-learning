// A tiny Amazon Linux shell for "EC2 Instance Connect": enough of the AWS CLI and IMDS to debug
// "who am I?" and "why AccessDenied?" the way you would on a real instance.
import { getInstance } from './env';
import { instanceRole, sessionArn } from './iam';
import { canConnect, canReachInternetFrom } from './network';
import { currentTables, writeTables } from './rds';
import { authorize, bucketArn, getBucket, s3DeleteObject, s3GetObject, s3ListBuckets, s3ListObjects, s3PutObject, type S3Caller } from './s3';
import { AwsError, type AwsEnv, type Instance } from './types';

export interface CliResult {
  output: string;
  ok: boolean;
  /** AWS API operation the command called (for lessons: "did GetObject succeed?") */
  operation?: string;
  errorCode?: string;
  /** a file written to the instance's home directory (downloads) */
  file?: { name: string; body: string };
}

/** Public endpoint IPs (Tokyo S3 / STS ranges) used for the network path check. */
const ENDPOINT_IP = { s3: '52.219.4.10', sts: '52.119.200.10' };

export function prompt(i: Instance) {
  return `[ec2-user@ip-${i.privateIpAddress.replaceAll('.', '-')} ~]$`;
}

/** Split like a shell: spaces separate words, quotes group them. */
export function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

const fmtTime = (iso: string) => iso.replace('T', ' ').slice(0, 19);
const pad = (s: string | number, n: number) => String(s).padStart(n);

function parseS3Url(u: string): { bucket: string; key: string } | null {
  const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(u);
  return m ? { bucket: m[1], key: m[2] } : null;
}

function opts(args: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let n = 0; n < args.length; n++) {
    if (args[n].startsWith('--')) {
      const [k, v] = args[n].slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (args[n + 1] && !args[n + 1].startsWith('--')) flags[k] = args[++n];
      else flags[k] = 'true';
    } else pos.push(args[n]);
  }
  return { pos, flags };
}

const apiError = (operation: string, e: AwsError): CliResult => ({ ok: false, operation, errorCode: e.code, output: `An error occurred (${e.code}) when calling the ${operation} operation: ${e.message}` });

/** Credentials from the instance profile, as the CLI's credential chain would find them via IMDS. */
function credentials(env: AwsEnv, i: Instance): { caller?: S3Caller; roleId?: string; roleName?: string; fail?: CliResult } {
  const r = instanceRole(env, i.instanceId);
  if (!r.role || r.problem) return { fail: { ok: false, errorCode: 'NoCredentials', output: 'Unable to locate credentials. You can configure credentials by running "aws configure".' } };
  return {
    caller: { principal: { type: 'role', roleName: r.role.roleName, sessionName: i.instanceId }, context: { 'aws:SecureTransport': true, 'aws:SourceIp': i.publicIpAddress ?? i.privateIpAddress } },
    roleId: r.role.roleId,
    roleName: r.role.roleName,
  };
}

function network(env: AwsEnv, i: Instance, service: 's3' | 'sts', url: string): CliResult | null {
  return canReachInternetFrom(env, i.instanceId, ENDPOINT_IP[service], 443).ok ? null : { ok: false, errorCode: 'ConnectTimeout', output: `Connect timeout on endpoint URL: "${url}"` };
}

function imds(env: AwsEnv, i: Instance, path: string): string {
  const base = '/latest/meta-data/';
  if (!path.startsWith(base)) return '404 - Not Found';
  const p = path.slice(base.length);
  const profile = env.instanceProfiles.find((x) => x.arn === i.iamInstanceProfileArn);
  const r = instanceRole(env, i.instanceId);
  const table: Record<string, string> = {
    '': ['ami-id', 'hostname', 'iam/', 'instance-id', 'instance-type', 'local-ipv4', 'placement/', 'public-ipv4', 'security-groups'].join('\n'),
    'ami-id': i.imageId,
    hostname: `ip-${i.privateIpAddress.replaceAll('.', '-')}.${env.region}.compute.internal`,
    'instance-id': i.instanceId,
    'instance-type': i.instanceType,
    'local-ipv4': i.privateIpAddress,
    'placement/availability-zone': i.availabilityZone,
    'security-groups': i.securityGroupIds.map((g) => env.securityGroups.find((x) => x.groupId === g)?.groupName ?? g).join('\n'),
  };
  if (i.publicIpAddress) table['public-ipv4'] = i.publicIpAddress;
  if (profile) {
    table['iam/'] = 'info\nsecurity-credentials/';
    table['iam/info'] = JSON.stringify({ Code: 'Success', LastUpdated: new Date().toISOString(), InstanceProfileArn: profile.arn, InstanceProfileId: profile.instanceProfileId }, null, 2);
    const roleName = profile.roleNames[0];
    if (roleName) {
      table['iam/security-credentials/'] = roleName;
      table[`iam/security-credentials/${roleName}`] =
        r.problem === 'trust'
          ? JSON.stringify({ Code: 'AssumeRoleUnauthorizedAccess', Message: `EC2 cannot assume the role ${roleName}. Please see documentation at https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_use_switch-role-ec2.html#roles-usingrole-ec2instance-roles.`, LastUpdated: new Date().toISOString() }, null, 2)
          : JSON.stringify({ Code: 'Success', LastUpdated: new Date().toISOString(), Type: 'AWS-HMAC', AccessKeyId: 'ASIAXXXXXXXXSIMULATED', SecretAccessKey: '(simulator)', Token: '(simulator)', Expiration: new Date(Date.now() + 6 * 3600_000).toISOString() }, null, 2);
    }
  }
  // ponytail: IMDSv1 is allowed (no token required) to keep the shell simple.
  return table[p] ?? table[p.replace(/\/$/, '')] ?? table[`${p}/`] ?? '404 - Not Found';
}

const HELP = `このシミュレーターで使えるコマンド:
  aws sts get-caller-identity
  aws configure list
  aws s3 ls [s3://BUCKET[/PREFIX]]
  aws s3 cp s3://BUCKET/KEY FILE   /   aws s3 cp FILE s3://BUCKET/KEY
  aws s3 rm s3://BUCKET/KEY
  aws s3api get-object --bucket BUCKET --key KEY FILE
  aws s3api get-bucket-policy --bucket BUCKET
  curl http://169.254.169.254/latest/meta-data/iam/security-credentials/
  mysql [-h HOST] [-u USER] [-pPASSWORD] [DATABASE] -e "SQL"   (SHOW TABLES / SELECT COUNT(*) FROM t / DELETE FROM t)
  ./SCRIPT.sh
  ls [-a], cat FILE, whoami, hostname, pwd, clear, help`;

/** Local files: app.log plus whatever was downloaded (passed in by the caller from the command history). */
export function execCli(env: AwsEnv, instanceId: string, line: string, downloads: Record<string, string>): CliResult {
  const i = getInstance(env, instanceId);
  const files = { ...i.homeFiles, ...downloads };
  const [cmd, ...args] = tokenize(line.trim());
  const script = /^(?:\.\/)?(\S+\.sh)$/.exec(cmd === 'bash' || cmd === 'sh' ? (args[0] ?? '') : cmd);
  if (script && (cmd === 'bash' || cmd === 'sh' || cmd.startsWith('./'))) return runScript(env, i, script[1], downloads, files);
  if (!cmd) return { ok: true, output: '' };
  switch (cmd) {
    case 'help':
      return { ok: true, output: HELP };
    case 'whoami':
      return { ok: true, output: 'ec2-user' };
    case 'pwd':
      return { ok: true, output: '/home/ec2-user' };
    case 'hostname':
      return { ok: true, output: `ip-${i.privateIpAddress.replaceAll('.', '-')}.${env.region}.compute.internal` };
    case 'ls': {
      const all = args.some((a) => /^-\w*a/.test(a));
      return { ok: true, output: [...(all ? ['.', '..'] : []), ...Object.keys(files).filter((f) => all || !f.startsWith('.')).sort()].join('  ') };
    }
    case 'cat': {
      const f = args[0]?.replace(/^(\.\/|~\/)/, '');
      return f && f in files ? { ok: true, output: files[f] } : { ok: false, output: `cat: ${args[0] ?? ''}: No such file or directory` };
    }
    case 'echo':
      return { ok: true, output: args.join(' ') };
    case 'curl': {
      const url = args.filter((a) => !a.startsWith('-'))[0] ?? '';
      const m = /^https?:\/\/169\.254\.169\.254(\/.*)$/.exec(url);
      if (m) return { ok: true, output: imds(env, i, m[1]) };
      return { ok: false, output: `curl: (6) Could not resolve host: ${url.replace(/^https?:\/\//, '').split('/')[0] || '(none)'}` };
    }
    case 'aws':
      return aws(env, i, args, files);
    case 'mysql':
      return mysql(env, i, args, files);
    default:
      return { ok: false, output: `-bash: ${cmd}: command not found` };
  }
}

function aws(env: AwsEnv, i: Instance, args: string[], files: Record<string, string>): CliResult {
  const { pos, flags } = opts(args);
  const [service, sub, ...rest] = pos;
  if (flags.version || service === '--version') return { ok: true, output: 'aws-cli/2.17.40 Python/3.11.9 Linux/6.1.109-118.189.amzn2023.x86_64 exe/x86_64.amzn.2023' };
  if (!service) return { ok: false, output: 'usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: the following arguments are required: command' };
  if (service === 'configure' && sub === 'list') {
    const r = instanceRole(env, i.instanceId);
    const has = !!r.role && !r.problem;
    return {
      ok: true,
      output: [
        '      Name                    Value             Type    Location',
        '      ----                    -----             ----    --------',
        '   profile                <not set>             None    None',
        `access_key     ${has ? '****************ATED' : '               <not set>'}         ${has ? 'iam-role' : 'None    None'}`,
        `secret_key     ${has ? '****************ator' : '               <not set>'}         ${has ? 'iam-role' : 'None    None'}`,
        `    region           ${env.region}             imds`,
      ].join('\n'),
    };
  }
  const creds = credentials(env, i);
  if (service === 'sts' && sub === 'get-caller-identity') {
    if (creds.fail) return { ...creds.fail, operation: 'GetCallerIdentity' };
    const net = network(env, i, 'sts', `https://sts.${env.region}.amazonaws.com/`);
    if (net) return { ...net, operation: 'GetCallerIdentity' };
    return { ok: true, operation: 'GetCallerIdentity', output: JSON.stringify({ UserId: `${creds.roleId}:${i.instanceId}`, Account: env.accountId, Arn: sessionArn(env, creds.roleName!, i.instanceId) }, null, 4) };
  }
  if (service === 's3' || service === 's3api') {
    if (creds.fail) return creds.fail;
    const net = network(env, i, 's3', `https://s3.${env.region}.amazonaws.com/`);
    if (net) return net;
    return service === 's3' ? s3(env, i, creds.caller!, sub, rest, files) : s3api(env, creds.caller!, sub, rest, flags);
  }
  return { ok: false, output: `usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: argument command: Invalid choice, valid choices are: sts | s3 | s3api | configure (このシミュレーターで使えるもの)` };
}

function s3(env: AwsEnv, i: Instance, caller: S3Caller, sub: string | undefined, rest: string[], files: Record<string, string>): CliResult {
  void i;
  if (sub === 'ls') {
    const target = rest[0] && parseS3Url(rest[0]);
    if (!target) {
      try {
        return { ok: true, operation: 'ListBuckets', output: s3ListBuckets(env, caller).map((b) => `${fmtTime(b.creationDate)} ${b.name}`).join('\n') };
      } catch (e) {
        if (e instanceof AwsError) return apiError('ListBuckets', e);
        throw e;
      }
    }
    try {
      const r = s3ListObjects(env, caller, target.bucket, target.key);
      return { ok: true, operation: 'ListObjectsV2', output: [...r.prefixes.map((p) => `${pad('PRE', 30)} ${p.slice(target.key.length)}`), ...r.objects.map((o) => `${fmtTime(o.lastModified)} ${pad(o.size, 10)} ${o.key.slice(target.key.length)}`)].join('\n') };
    } catch (e) {
      if (e instanceof AwsError) return apiError('ListObjectsV2', e);
      throw e;
    }
  }
  if (sub === 'cp') {
    const [src, dst] = rest;
    if (!src || !dst) return { ok: false, output: 'usage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>\nError: Invalid argument type' };
    const from = parseS3Url(src);
    const to = parseS3Url(dst);
    if (from && !to) {
      // The CLI does a HeadObject first: a HEAD response has no body, so failures only say 403 / 404.
      try {
        getBucket(env, from.bucket);
        const o = s3GetObject(env, caller, from.bucket, from.key);
        const name = dst === '.' || dst === './' ? from.key.split('/').pop()! : dst.replace(/^\.\//, '');
        return { ok: true, operation: 'GetObject', output: `download: ${src} to ${dst === '.' ? './' + name : dst}`, file: { name, body: o.body ?? `(${o.size} bytes)` } };
      } catch (e) {
        if (!(e instanceof AwsError)) throw e;
        const status = e.code === 'NoSuchKey' || e.code === 'NoSuchBucket' ? '404' : '403';
        return { ok: false, operation: 'GetObject', errorCode: e.code, output: status === '404' ? (e.code === 'NoSuchBucket' ? `fatal error: An error occurred (NoSuchBucket) when calling the HeadObject operation: The specified bucket does not exist` : `fatal error: An error occurred (404) when calling the HeadObject operation: Key "${from.key}" does not exist`) : 'fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden' };
      }
    }
    if (!from && to) {
      const local = src.replace(/^\.\//, '');
      if (!(local in files)) return { ok: false, output: `The user-provided path ${src} does not exist.` };
      const key = to.key === '' || to.key.endsWith('/') ? to.key + local.split('/').pop() : to.key;
      try {
        s3PutObject(env, caller, to.bucket, key, { size: files[local].length, body: files[local] });
        return { ok: true, operation: 'PutObject', output: `upload: ${src} to s3://${to.bucket}/${key}` };
      } catch (e) {
        if (!(e instanceof AwsError)) throw e;
        return { ok: false, operation: 'PutObject', errorCode: e.code, output: `upload failed: ${src} to s3://${to.bucket}/${key} An error occurred (${e.code}) when calling the PutObject operation: ${e.message}` };
      }
    }
    return { ok: false, output: 'このシミュレーターでは S3 間のコピーは未対応です。' };
  }
  if (sub === 'rm') {
    const t = rest[0] && parseS3Url(rest[0]);
    if (!t || !t.key) return { ok: false, output: 'usage: aws s3 rm <S3Uri>' };
    try {
      s3DeleteObject(env, caller, t.bucket, t.key);
      return { ok: true, operation: 'DeleteObject', output: `delete: ${rest[0]}` };
    } catch (e) {
      if (!(e instanceof AwsError)) throw e;
      return { ok: false, operation: 'DeleteObject', errorCode: e.code, output: `delete failed: ${rest[0]} An error occurred (${e.code}) when calling the DeleteObject operation: ${e.message}` };
    }
  }
  return { ok: false, output: `usage: aws s3 <ls|cp|rm> ...\naws: error: argument subcommand: Invalid choice: '${sub ?? ''}'` };
}

function s3api(env: AwsEnv, caller: S3Caller, sub: string | undefined, rest: string[], flags: Record<string, string>): CliResult {
  const bucket = flags.bucket;
  if (!bucket) return { ok: false, output: `aws: error: the following arguments are required: --bucket` };
  if (sub === 'get-object') {
    if (!flags.key || !rest[0]) return { ok: false, output: 'aws: error: the following arguments are required: --key, outfile' };
    try {
      const o = s3GetObject(env, caller, bucket, flags.key);
      return { ok: true, operation: 'GetObject', output: JSON.stringify({ AcceptRanges: 'bytes', LastModified: new Date(o.lastModified).toUTCString(), ContentLength: o.size, ETag: o.etag, ContentType: o.contentType, ServerSideEncryption: o.serverSideEncryption, Metadata: {} }, null, 4) };
    } catch (e) {
      if (e instanceof AwsError) return apiError('GetObject', e);
      throw e;
    }
  }
  if (sub === 'get-bucket-policy') {
    try {
      const b = getBucket(env, bucket);
      authorize(env, caller, 's3:GetBucketPolicy', bucketArn(bucket), b);
      if (!b.policy) throw new AwsError('NoSuchBucketPolicy', 'The bucket policy does not exist');
      return { ok: true, operation: 'GetBucketPolicy', output: JSON.stringify({ Policy: JSON.stringify(b.policy) }, null, 4) };
    } catch (e) {
      if (e instanceof AwsError) return apiError('GetBucketPolicy', e);
      throw e;
    }
  }
  return { ok: false, output: `aws: error: argument operation: Invalid choice: '${sub ?? ''}' (このシミュレーターでは get-object / get-bucket-policy に対応)` };
}


/** Runs a shell script line by line like `set -e` (stops at the first failing command). */
function runScript(env: AwsEnv, i: Instance, name: string, downloads: Record<string, string>, files: Record<string, string>): CliResult {
  const body = files[name];
  if (body === undefined) return { ok: false, output: `-bash: ./${name}: No such file or directory` };
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('set ')) continue;
    const r = execCli(env, i.instanceId, line, downloads);
    if (r.output) out.push(r.output);
    if (!r.ok) return { ok: false, output: out.join('\n'), operation: 'script' };
  }
  return { ok: true, output: out.join('\n'), operation: 'script' };
}

/** [client] section of ~/.my.cnf */
function myCnf(text: string | undefined): Record<string, string> {
  return Object.fromEntries((text ?? '').split('\n').map((l) => /^\s*(\w+)\s*=\s*(.*?)\s*$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => [m[1], m[2]]));
}

/** the mysql client's box table (what `mysql -e` prints on a terminal) */
function sqlTable(headers: string[], rows: string[][]): string {
  const w = headers.map((h, n) => Math.max(h.length, ...rows.map((r) => r[n].length)));
  const line = `+${w.map((x) => '-'.repeat(x + 2)).join('+')}+`;
  const row = (r: string[]) => `| ${r.map((c, n) => (/^\d+$/.test(c) ? c.padStart(w[n]) : c.padEnd(w[n]))).join(' | ')} |`;
  return [line, row(headers), line, ...rows.map(row), line].join('\n');
}

/** MySQL client against RDS: resolves the endpoint, checks the network path (SG / NACL / route) and the user, runs a few statements. */
function mysql(env: AwsEnv, i: Instance, args: string[], files: Record<string, string>): CliResult {
  const cnf = myCnf(files['.my.cnf']);
  let host = cnf.host;
  let user = cnf.user ?? 'ec2-user';
  let password: string | undefined = cnf.password;
  let database = cnf.database;
  let sql: string | undefined;
  let passwordOnCommandLine = false;
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    const value = (short: string, long: string) => (a === short || a === long ? args[++n] : a.startsWith(`${long}=`) ? a.slice(long.length + 1) : a.startsWith(short) && short !== '-e' ? a.slice(2) : undefined);
    const h = value('-h', '--host');
    const u = value('-u', '--user');
    if (h !== undefined) host = h;
    else if (u !== undefined) user = u;
    else if (a === '-e' || a === '--execute') sql = args[++n];
    else if (a.startsWith('--execute=')) sql = a.slice(10);
    else if (a === '-P' || a === '--port') n++;
    else if (a.startsWith('-p') || a.startsWith('--password')) {
      const p = a.startsWith('--password=') ? a.slice(11) : a.startsWith('-p') ? a.slice(2) : '';
      if (p) {
        password = p;
        passwordOnCommandLine = true;
      }
    } else if (!a.startsWith('-')) database = a;
  }
  const fail = (output: string): CliResult => ({ ok: false, output, operation: 'mysql' });
  const warning = passwordOnCommandLine ? 'mysql: [Warning] Using a password on the command line interface can be insecure.\n' : '';
  if (!host) return fail("ERROR 2002 (HY000): Can't connect to local MySQL server through socket '/var/lib/mysql/mysql.sock' (2)");
  const db = env.dbInstances.find((d) => d.endpointAddress === host);
  if (!db) return fail(`${warning}ERROR 2005 (HY000): Unknown MySQL server host '${host}' (-2)`);
  if (db.engine !== 'mysql' || !canConnect(env, i.instanceId, db.dbInstanceIdentifier, 'tcp', db.port).ok) return fail(`${warning}ERROR 2003 (HY000): Can't connect to MySQL server on '${host}:${db.port}' (110)`);
  if (user !== db.masterUsername || !password) return fail(`${warning}ERROR 1045 (28000): Access denied for user '${user}'@'${i.privateIpAddress}' (using password: ${password ? 'YES' : 'NO'})`);
  if (database && database !== db.dbName) return fail(`${warning}ERROR 1049 (42000): Unknown database '${database}'`);
  if (sql === undefined) return fail(`${warning}このシミュレーターの mysql は -e "SQL" で 1 回ずつ実行します (対話モードは未対応)。`);
  const out: string[] = [];
  for (const st of sql.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const tables = currentTables(db);
    const table = (name: string) => (name in tables ? null : fail(`${warning}${out.join('\n')}ERROR 1146 (42S02): Table '${database}.${name}' doesn't exist`));
    let m: RegExpExecArray | null;
    if (/^show\s+databases$/i.test(st)) out.push(sqlTable(['Database'], [['information_schema'], ['mysql'], ['performance_schema'], ['sys'], ...(db.dbName ? [[db.dbName]] : [])]));
    else if (!database) return fail(`${warning}ERROR 1046 (3D000): No database selected`);
    else if (/^show\s+tables$/i.test(st)) out.push(sqlTable([`Tables_in_${database}`], Object.keys(tables).sort().map((t) => [t])));
    else if ((m = /^select\s+count\(\s*\*\s*\)\s+from\s+`?(\w+)`?$/i.exec(st))) {
      const e = table(m[1]);
      if (e) return e;
      out.push(sqlTable(['COUNT(*)'], [[String(tables[m[1]])]]));
    } else if ((m = /^delete\s+from\s+`?(\w+)`?(\s+where\s+.+)?$/i.exec(st))) {
      const e = table(m[1]);
      if (e) return e;
      // without WHERE every row goes; with one, the simulator assumes it matches the old (archived) 18%
      writeTables(db, { ...tables, [m[1]]: m[2] ? Math.round(tables[m[1]] * 0.82) : 0 });
    } else return fail(`${warning}${out.join('\n')}ERROR 1064 (42000) at line 1: You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '${st.slice(0, 40)}' at line 1`);
  }
  return { ok: true, output: warning.trimEnd() ? `${warning}${out.join('\n')}`.trimEnd() : out.join('\n'), operation: 'mysql' };
}
