/* aws lambda — 関数の設定 (環境変数)、テスト呼び出し、SQS などのイベントソースマッピング。応答のキーはパスカルケース */
import { hash } from '../../../sim/ids';
import { getFunction, invokeFunction, updateEventSourceMapping, updateFunctionConfiguration } from '../../../sim/serverless';
import type { AwsEnv, EventSourceMapping, LambdaFunction } from '../../../sim/types';
import { AwsError, bool, int, iso, service, str, struct, type OpContext, type OperationSpec } from '../types';

/* Lambda の日時は 2026-09-30T03:12:45.123+0000 の書き方 */
const lambdaTime = (t: number) => new Date(t).toISOString().replace('Z', '+0000');
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const hex = (s: string, n: number) => Array.from({ length: Math.ceil(n / 8) }, (_, i) => hash(`${s}#${i}`).toString(16).padStart(8, '0')).join('').slice(0, n);
const uuid = (s: string) => hex(s, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');

function configOut(f: LambdaFunction, status: 'Successful' | 'InProgress' = 'Successful') {
  return {
    FunctionName: f.functionName,
    FunctionArn: f.functionArn,
    Runtime: f.runtime,
    Role: f.roleArn,
    Handler: f.handler,
    CodeSize: f.code.length,
    Description: '',
    Timeout: f.timeout,
    MemorySize: f.memorySize,
    LastModified: lambdaTime(f.lastModified),
    CodeSha256: b64(hex(f.code, 64)).slice(0, 43) + '=',
    Version: '$LATEST',
    Environment: { Variables: { ...f.environment } },
    TracingConfig: { Mode: 'PassThrough' },
    RevisionId: uuid(`${f.functionName}${f.lastModified}`),
    State: 'Active',
    LastUpdateStatus: status,
    PackageType: 'Zip',
    Architectures: ['x86_64'],
    EphemeralStorage: { Size: 512 },
    SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' },
    LoggingConfig: { LogFormat: 'Text', LogGroup: `/aws/lambda/${f.functionName}` },
  };
}

function mappingOut(env: AwsEnv, m: EventSourceMapping, state?: string) {
  return {
    UUID: m.uuid,
    BatchSize: m.batchSize,
    MaximumBatchingWindowInSeconds: 0,
    EventSourceArn: m.eventSourceArn,
    FunctionArn: getFunction(env, m.functionName).functionArn,
    LastModified: iso(m.createdAt),
    State: state ?? (m.enabled ? 'Enabled' : 'Disabled'),
    StateTransitionReason: 'USER_INITIATED',
    FunctionResponseTypes: [],
    EventSourceMappingArn: `arn:aws:lambda:${env.region}:${env.accountId}:event-source-mapping:${m.uuid}`,
  };
}

const fn = (ctx: OpContext) => getFunction(ctx.env, str(ctx, 'function-name')!);
const fnName = { name: 'function-name', type: 'string', required: true, desc: '関数名か ARN' } as const;
const mappingOf = (ctx: OpContext) => {
  const m = ctx.env.eventSourceMappings.find((x) => x.uuid === str(ctx, 'uuid'));
  if (!m) throw new AwsError('ResourceNotFoundException', 'The resource you requested does not exist.');
  return m;
};

/* --payload: CLI v2 の既定は base64。--cli-binary-format raw-in-base64-out を付けると JSON をそのまま書ける。
   ponytail: aws.ts がグローバルオプション --cli-binary-format を読み捨てるので区別できない。JSON として読めればそのまま、読めなければ base64 として読む */
function payload(ctx: OpContext): unknown {
  const raw = str(ctx, 'payload');
  if (raw === undefined) return {};
  const parse = (s: string) => {
    try {
      return { ok: true, v: JSON.parse(s) as unknown };
    } catch {
      return { ok: false, v: undefined };
    }
  };
  const direct = parse(raw);
  if (direct.ok) return direct.v;
  let decoded: string | undefined;
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0)));
  } catch {
    throw new AwsError('InvalidParameterValue', `Invalid base64: "${raw}"`);
  }
  const viaB64 = parse(decoded);
  if (!viaB64.ok) throw new AwsError('InvalidRequestContentException', 'Could not parse request body into json: Could not parse payload into json: Unexpected character: was expecting a JSON value');
  return viaB64.v;
}

const ops: OperationSpec[] = [
  {
    name: 'list-functions',
    desc: '関数の一覧 (設定つき)',
    params: [],
    readOnly: true,
    run: (ctx) => ({ Functions: ctx.env.lambdaFunctions.map((f) => configOut(f)) }),
  },
  {
    name: 'get-function',
    desc: '関数の設定と、コードのダウンロード先',
    params: [fnName],
    readOnly: true,
    run(ctx) {
      const f = fn(ctx);
      return { Configuration: configOut(f), Code: { RepositoryType: 'S3', Location: `https://awslambda-${ctx.env.region}-tasks.s3.${ctx.env.region}.amazonaws.com/snapshots/${ctx.env.accountId}/${f.functionName}-${uuid(f.functionArn)}?versionId=${hex(f.code, 32)}` } };
    },
  },
  {
    name: 'get-function-configuration',
    desc: '関数の設定 (ランタイム・タイムアウト・環境変数)',
    params: [fnName],
    readOnly: true,
    examples: ['aws lambda get-function-configuration --function-name process-order --query Environment'],
    run: (ctx) => configOut(fn(ctx)),
  },
  {
    name: 'update-function-configuration',
    desc: '関数の設定を変える (--environment は環境変数を丸ごと置き換える)',
    params: [
      fnName,
      { name: 'environment', type: 'structure', desc: "Variables={KEY=value,...} (今ある変数も全部書く)" },
      { name: 'timeout', type: 'integer', desc: 'タイムアウト (秒、最大 900)' },
      { name: 'memory-size', type: 'integer', desc: 'メモリ (MB)' },
    ],
    examples: ["aws lambda update-function-configuration --function-name process-order --environment 'Variables={BUCKET=my-bucket}'"],
    run(ctx) {
      const name = fn(ctx).functionName;
      const e = struct(ctx, 'environment');
      const vars = e?.Variables;
      if (e && vars !== undefined && (typeof vars !== 'object' || vars === null || Array.isArray(vars))) throw new AwsError('InvalidParameterValueException', 'Environment.Variables must be a map of strings.');
      const timeout = int(ctx, 'timeout');
      if (timeout !== undefined && (timeout < 1 || timeout > 900)) throw new AwsError('InvalidParameterValueException', `1 validation error detected: Value '${timeout}' at 'timeout' failed to satisfy constraint: Member must have value less than or equal to 900`);
      updateFunctionConfiguration(
        ctx.env,
        name,
        {
          ...(e ? { environment: Object.fromEntries(Object.entries((vars ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)])) } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
          ...(int(ctx, 'memory-size') !== undefined ? { memorySize: int(ctx, 'memory-size') } : {}),
        },
        ctx.now,
      );
      return configOut(getFunction(ctx.env, name), 'InProgress');
    },
  },
  {
    name: 'invoke',
    desc: '関数を呼び出し、戻り値をファイルに書く (テスト実行)',
    params: [
      fnName,
      { name: 'payload', type: 'string', desc: "イベントの JSON ('{\"key\": 1}' か file://event.json。--cli-binary-format raw-in-base64-out と一緒に)" },
      { name: 'invocation-type', type: 'string', desc: 'RequestResponse (既定) / Event / DryRun' },
      { name: 'log-type', type: 'string', desc: 'Tail にすると、ログの最後を LogResult (base64) で返す' },
      { name: 'outfile', type: 'string', required: true, positional: true, desc: '戻り値を書くファイル' },
    ],
    examples: [`aws lambda invoke --function-name process-order --cli-binary-format raw-in-base64-out --payload '{"Records": []}' response.json`],
    run(ctx) {
      const f = fn(ctx);
      const event = payload(ctx);
      const type = str(ctx, 'invocation-type') ?? 'RequestResponse';
      if (!['RequestResponse', 'Event', 'DryRun'].includes(type)) throw new AwsError('InvalidParameterValueException', `1 validation error detected: Value '${type}' at 'invocationType' failed to satisfy constraint: Member must satisfy enum value set: [Event, RequestResponse, DryRun]`);
      const out = str(ctx, 'outfile')!;
      if (type === 'DryRun') {
        ctx.writeLocal(out, '');
        return { StatusCode: 204 };
      }
      const r = invokeFunction(ctx.env, f.functionName, event, ctx.now);
      if (type === 'Event') {
        ctx.writeLocal(out, '');
        return { StatusCode: 202 };
      }
      ctx.writeLocal(out, JSON.stringify(r.response));
      return {
        StatusCode: 200,
        ...(r.ok ? {} : { FunctionError: 'Unhandled' }),
        ...(str(ctx, 'log-type') === 'Tail' ? { LogResult: b64([...r.logs, `REPORT RequestId: ${r.requestId}\tDuration: ${r.durationMs} ms`].join('\n') + '\n') } : {}),
        ExecutedVersion: '$LATEST',
      };
    },
  },
  {
    name: 'list-event-source-mappings',
    desc: 'イベントソースマッピング (Lambda トリガー) の一覧',
    params: [
      { name: 'function-name', type: 'string', desc: 'この関数のものだけ' },
      { name: 'event-source-arn', type: 'string', desc: 'このキューなどのものだけ' },
    ],
    readOnly: true,
    run(ctx) {
      const name = str(ctx, 'function-name');
      const f = name ? fn(ctx) : undefined;
      const src = str(ctx, 'event-source-arn');
      return { EventSourceMappings: ctx.env.eventSourceMappings.filter((m) => (!f || m.functionName === f.functionName) && (!src || m.eventSourceArn === src)).map((m) => mappingOut(ctx.env, m)) };
    },
  },
  {
    name: 'get-event-source-mapping',
    desc: 'イベントソースマッピング 1 つの詳細',
    params: [{ name: 'uuid', type: 'string', required: true, desc: 'UUID' }],
    readOnly: true,
    run: (ctx) => mappingOut(ctx.env, mappingOf(ctx)),
  },
  {
    name: 'update-event-source-mapping',
    desc: 'イベントソースマッピングを有効・無効にする',
    params: [
      { name: 'uuid', type: 'string', required: true, desc: 'UUID' },
      { name: 'enabled', type: 'boolean', desc: '--enabled で有効、--no-enabled で無効' },
    ],
    run(ctx) {
      const m = mappingOf(ctx);
      const enabled = bool(ctx, 'enabled');
      if (enabled !== undefined) updateEventSourceMapping(ctx.env, m.uuid, enabled);
      return mappingOut(ctx.env, ctx.env.eventSourceMappings.find((x) => x.uuid === m.uuid)!, enabled === undefined ? undefined : enabled ? 'Enabling' : 'Disabling');
    },
  },
];

export default service('lambda', 'AWS Lambda (関数・環境変数・SQS トリガー)', ops);
