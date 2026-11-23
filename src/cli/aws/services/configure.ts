/* aws configure — 学習者の PC の ~/.aws/config と ~/.aws/credentials を読み書きするだけ (API は呼ばない) */
import { readIni } from '../aws';
import { service, str, type OpContext } from '../types';

const CONFIG = '~/.aws/config';
const CREDENTIALS = '~/.aws/credentials';
const CRED_KEYS = ['aws_access_key_id', 'aws_secret_access_key', 'aws_session_token'];
const mask = (v: string) => '*'.repeat(Math.max(0, v.length - 4)).slice(0, 16) + v.slice(-4);

function setIni(text: string | null, section: string, key: string, value: string, credentials: boolean): string {
  const header = credentials || section === 'default' ? `[${section}]` : `[profile ${section}]`;
  const lines = (text ?? '').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1);
  let start = lines.findIndex((l) => l.trim() === header);
  if (start < 0) {
    lines.push(...(lines.length ? [''] : []), header);
    start = lines.length - 1;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > start && i < end && l.split('=')[0].trim() === key);
  if (at >= 0) lines[at] = `${key} = ${value}`;
  else lines.splice(end, 0, `${key} = ${value}`);
  return lines.join('\n').replace(/\n*$/, '\n');
}

function profileOf(ctx: OpContext) {
  return ctx.profile;
}

export default service('configure', 'このPCのAWS CLIの設定 (~/.aws/config・~/.aws/credentials)', [
  {
    name: 'list',
    desc: '使われる設定と、それがどこから来たかを表示する',
    params: [],
    local: true,
    raw: true,
    run(ctx) {
      const profile = profileOf(ctx);
      const conf = readIni(ctx.readLocal(CONFIG))[profile] ?? {};
      const cred = readIni(ctx.readLocal(CREDENTIALS))[profile] ?? {};
      const row = (name: string, value: string | undefined, type: string, loc: string) => `${name.padStart(10)} ${(value ?? '<not set>').padStart(24)} ${(value ? type : 'None').padStart(16)}    ${value ? loc : 'None'}`;
      const envKey = ctx.shellEnv.AWS_ACCESS_KEY_ID;
      const region = ctx.shellEnv.AWS_REGION ?? ctx.shellEnv.AWS_DEFAULT_REGION;
      return [
        '      Name                    Value             Type    Location',
        '      ----                    -----             ----    --------',
        row('profile', profile === 'default' && !ctx.shellEnv.AWS_PROFILE ? undefined : profile, ctx.shellEnv.AWS_PROFILE ? 'env' : 'manual', ctx.shellEnv.AWS_PROFILE ? 'AWS_PROFILE' : '--profile'),
        row('access_key', envKey ? mask(envKey) : cred.aws_access_key_id && mask(cred.aws_access_key_id), envKey ? 'env' : 'shared-credentials-file', envKey ? '' : ''),
        row('secret_key', ctx.shellEnv.AWS_SECRET_ACCESS_KEY ? mask(ctx.shellEnv.AWS_SECRET_ACCESS_KEY) : cred.aws_secret_access_key && mask(cred.aws_secret_access_key), envKey ? 'env' : 'shared-credentials-file', ''),
        row('region', region ?? conf.region, region ? 'env' : 'config-file', region ? (ctx.shellEnv.AWS_REGION ? 'AWS_REGION' : 'AWS_DEFAULT_REGION') : '~/.aws/config'),
      ].join('\n');
    },
  },
  {
    name: 'get',
    desc: '設定の値を 1 つ表示する (例: aws configure get region)',
    params: [{ name: 'varname', type: 'string', required: true, positional: true, desc: 'region / output / aws_access_key_id など' }],
    local: true,
    raw: true,
    run(ctx) {
      const name = str(ctx, 'varname')!;
      const [section, key] = name.includes('.') ? [name.split('.')[0], name.split('.').slice(1).join('.')] : [profileOf(ctx), name];
      const file = CRED_KEYS.includes(key) ? CREDENTIALS : CONFIG;
      return readIni(ctx.readLocal(file))[section]?.[key] ?? '';
    },
  },
  {
    name: 'set',
    desc: '設定の値を書き込む (例: aws configure set region us-east-1)',
    params: [
      { name: 'varname', type: 'string', required: true, positional: true, desc: 'region / output など' },
      { name: 'value', type: 'string', required: true, positional: true, desc: '値' },
    ],
    local: true,
    raw: true,
    run(ctx) {
      const name = str(ctx, 'varname')!;
      const [section, key] = name.includes('.') ? [name.split('.')[0], name.split('.').slice(1).join('.')] : [profileOf(ctx), name];
      const cred = CRED_KEYS.includes(key);
      const file = cred ? CREDENTIALS : CONFIG;
      ctx.writeLocal(file, setIni(ctx.readLocal(file), section, key, str(ctx, 'value')!, cred));
      return '';
    },
  },
]);
