// The credentials of an instance role (lesson 43): instance metadata service options (IMDSv1 / IMDSv2 session tokens)
// and revoking the role's active sessions (the IAM console's "アクティブなセッションを取り消す").
import type { CliResult } from '../cli';
import { trail } from '../cloudtrail';
import { getInstance } from '../env';
import { getRole, list, putInlinePolicy, statements } from '../iam';
import { stableChars } from '../ids';
import { AwsError, type AwsEnv, type Instance } from '../types';

export type MetadataOptions = NonNullable<Instance['metadataOptions']>;

/** an instance launched without metadata options allows IMDSv1 (what the scenarios' instances have) */
export const metadataOptions = (i: Instance): MetadataOptions => i.metadataOptions ?? { httpTokens: 'optional', httpPutResponseHopLimit: 1, httpEndpoint: 'enabled' };

/** ModifyInstanceMetadataOptions: options not given keep their value */
export function modifyInstanceMetadataOptions(env: AwsEnv, instanceId: string, input: Partial<MetadataOptions>): MetadataOptions {
  const i = getInstance(env, instanceId);
  const bad = (name: string, v: unknown, valid: string) => new AwsError('InvalidParameterValue', `The value '${String(v)}' for ${name} is invalid. Valid values: ${valid}`);
  if (input.httpTokens !== undefined && input.httpTokens !== 'optional' && input.httpTokens !== 'required') throw bad('HttpTokens', input.httpTokens, 'optional | required');
  if (input.httpEndpoint !== undefined && input.httpEndpoint !== 'enabled' && input.httpEndpoint !== 'disabled') throw bad('HttpEndpoint', input.httpEndpoint, 'enabled | disabled');
  const hop = input.httpPutResponseHopLimit;
  if (hop !== undefined && (!Number.isInteger(hop) || hop < 1 || hop > 64)) throw bad('HttpPutResponseHopLimit', hop, 'an integer from 1 to 64');
  const next: MetadataOptions = { ...metadataOptions(i) };
  if (input.httpTokens) next.httpTokens = input.httpTokens;
  if (input.httpEndpoint) next.httpEndpoint = input.httpEndpoint;
  if (hop !== undefined) next.httpPutResponseHopLimit = hop;
  i.metadataOptions = next;
  trail(env, {
    source: 'ec2',
    name: 'ModifyInstanceMetadataOptions',
    resources: [['AWS::EC2::Instance', instanceId]],
    request: { ModifyInstanceMetadataOptionsRequest: { InstanceId: instanceId, ...(input.httpTokens ? { HttpTokens: input.httpTokens } : {}), ...(input.httpEndpoint ? { HttpEndpoint: input.httpEndpoint } : {}), ...(hop !== undefined ? { HttpPutResponseHopLimit: hop } : {}) } },
    response: { ModifyInstanceMetadataOptionsResponse: { instanceId, instanceMetadataOptions: { state: 'pending', ...next } } },
  });
  return next;
}

// ---------- IMDS (curl to 169.254.169.254 inside the instance) ----------

/** The session token IMDSv2 hands out (one per instance in the simulator; ponytail: no TTL expiry) */
export const imdsToken = (i: Instance) => `AQAEA${stableChars(`${i.instanceId}:imds`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', 51)}==`;

/** IMDS error pages are small XHTML documents */
const errorPage = (status: string) =>
  `<?xml version="1.0" encoding="iso-8859-1"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"\n\t"http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">\n <head>\n  <title>${status}</title>\n </head>\n <body>\n  <h1>${status}</h1>\n </body>\n</html>`;

export interface CurlRequest {
  url: string;
  method: string;
  /** header names in lower case */
  headers: Record<string, string>;
  /** -f / --fail: HTTP errors become curl errors (exit 22) */
  fail: boolean;
}

/** the curl options the IMDS examples use: -X / --request, -H / --header, -s, -f, -i ... */
export function parseCurl(args: string[]): CurlRequest {
  const req: CurlRequest = { url: '', method: 'GET', headers: {}, fail: false };
  for (let n = 0; n < args.length; n++) {
    const a = args[n];
    if (a === '-X' || a === '--request') req.method = (args[++n] ?? '').toUpperCase();
    else if (/^-X\w+$/.test(a)) req.method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const [name, ...value] = (args[++n] ?? '').split(':');
      req.headers[name.trim().toLowerCase()] = value.join(':').trim();
    } else if (['-o', '--output', '-w', '--write-out', '-m', '--max-time', '--connect-timeout'].includes(a)) n++;
    else if (a === '--fail' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)) req.fail = true;
    else if (!a.startsWith('-') && !req.url) req.url = a;
  }
  return req;
}

/** A request to IMDS: the endpoint switch and IMDSv2 tokens come before the metadata itself (`get`). */
export function imdsCurl(i: Instance, req: CurlRequest, path: string, get: (path: string) => string): CliResult {
  const o = metadataOptions(i);
  const respond = (status: number, body: string): CliResult => (req.fail && status >= 400 ? { ok: false, errorCode: String(status), output: `curl: (22) The requested URL returned error: ${status}` } : { ok: true, output: body });
  if (o.httpEndpoint === 'disabled') return respond(403, errorPage('403 - Forbidden'));
  if (path === '/latest/api/token') {
    if (req.method !== 'PUT') return respond(405, errorPage('405 - Method Not Allowed'));
    const ttl = Number(req.headers['x-aws-ec2-metadata-token-ttl-seconds']);
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 21600) return respond(400, errorPage('400 - Missing or Invalid Parameters'));
    return respond(200, imdsToken(i));
  }
  if (req.method !== 'GET') return respond(405, errorPage('405 - Method Not Allowed'));
  const token = req.headers['x-aws-ec2-metadata-token'];
  // a token that is sent must be valid; without one, only IMDSv1 (httpTokens = optional) answers
  if (token !== undefined ? token !== imdsToken(i) : o.httpTokens === 'required') return respond(401, errorPage('401 - Unauthorized'));
  const body = get(path);
  return respond(body.startsWith('404') ? 404 : 200, body);
}

// ---------- revoking a role's active sessions ----------

export const REVOKE_POLICY_NAME = 'AWSRevokeOlderSessions';

/**
 * IAM console "アクティブなセッションを取り消す": an inline policy denying everything to credentials issued before
 * now (+30 seconds for propagation, like the console). Returns the cut-off time.
 */
export function revokeOlderSessions(env: AwsEnv, roleName: string, now = Date.now()): string {
  getRole(env, roleName);
  const before = new Date(now + 30_000).toISOString().replace(/\.\d+Z$/, 'Z');
  putInlinePolicy(env, 'role', roleName, REVOKE_POLICY_NAME, { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: ['*'], Resource: ['*'], Condition: { DateLessThan: { 'aws:TokenIssueTime': before } } }] });
  return before;
}

/**
 * Credentials of the role issued before this time are denied (an inline policy that denies * to * with
 * DateLessThan aws:TokenIssueTime, however it was written). undefined = no such policy.
 */
export function sessionsRevokedBefore(env: AwsEnv, roleName: string): number | undefined {
  const role = env.iamRoles.find((r) => r.roleName === roleName);
  const times = (role?.inlinePolicies ?? [])
    .flatMap((p) => statements(p.document))
    .filter((st) => st.Effect === 'Deny' && list(st.Action).includes('*') && list(st.Resource).includes('*'))
    .flatMap((st) => Object.entries(st.Condition ?? {}).filter(([op]) => /^DateLessThan(Equals)?$/.test(op)))
    .flatMap(([, kv]) => Object.entries(kv).filter(([k]) => k.toLowerCase() === 'aws:tokenissuetime').map(([, v]) => Date.parse(String(list(v as string | string[])[0]))))
    .filter((t) => Number.isFinite(t));
  return times.length ? Math.max(...times) : undefined;
}
