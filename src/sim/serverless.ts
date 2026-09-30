import { trail } from './cloudtrail';
import { appendLog } from './cloudwatch';
import { hash, newUuid, randomHex } from './ids';
import { s3PutObject } from './s3';
import { AwsError, type AwsEnv, type LambdaFunction, type SqsMessage, type SqsQueue } from './types';

/**
 * SQS + Lambda. advanceServerless() is the Lambda poller of each event source mapping: it receives visible
 * messages (in flight for the visibility timeout), invokes the function, deletes them on success, and SQS
 * moves a message to the dead-letter queue once it has been received more than maxReceiveCount times.
 */

const md5 = (s: string) => (hash(s).toString(16).padStart(8, '0') + hash(`${s}!`).toString(16).padStart(8, '0')).repeat(2).slice(0, 32);

// ---------------- SQS ----------------

export function createQueue(env: AwsEnv, input: { name: string; visibilityTimeout?: number; messageRetentionPeriod?: number; deadLetterQueue?: { name: string; maxReceiveCount: number } }, now = Date.now()): string {
  const name = input.name.trim();
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(name)) throw new AwsError('InvalidParameterValue', 'Can only include alphanumeric characters, hyphens, or underscores. 1 to 80 in length');
  if (env.sqsQueues.some((q) => q.queueName === name)) throw new AwsError('QueueAlreadyExists', `A queue already exists with the same name and a different value for attribute`);
  const dlq = input.deadLetterQueue && getQueue(env, input.deadLetterQueue.name);
  const url = `https://sqs.${env.region}.amazonaws.com/${env.accountId}/${name}`;
  env.sqsQueues.push({
    queueName: name,
    queueUrl: url,
    queueArn: `arn:aws:sqs:${env.region}:${env.accountId}:${name}`,
    visibilityTimeout: input.visibilityTimeout ?? 30,
    messageRetentionPeriod: input.messageRetentionPeriod ?? 345_600,
    redrivePolicy: dlq ? { deadLetterTargetArn: dlq.queueArn, maxReceiveCount: input.deadLetterQueue!.maxReceiveCount } : undefined,
    createdAt: now,
    messages: [],
  });
  trail(env, { source: 'sqs', name: 'CreateQueue', resources: [['AWS::SQS::Queue', url]], request: { queueName: name }, response: { queueUrl: url } });
  return url;
}

export function getQueue(env: AwsEnv, nameOrArn: string): SqsQueue {
  const q = env.sqsQueues.find((x) => x.queueName === nameOrArn || x.queueArn === nameOrArn || x.queueUrl === nameOrArn);
  if (!q) throw new AwsError('AWS.SimpleQueueService.NonExistentQueue', 'The specified queue does not exist for this wsdl version.');
  return q;
}

export function sendMessage(env: AwsEnv, queue: string, body: string, now = Date.now()): string {
  const q = getQueue(env, queue);
  if (!body) throw new AwsError('MissingParameter', 'The request must contain the parameter MessageBody.');
  if (new Blob([body]).size > 262_144) throw new AwsError('InvalidParameterValue', 'One or more parameters are invalid. Reason: Message must be shorter than 262144 bytes.');
  const messageId = newUuid();
  q.messages.push({ messageId, body, md5OfBody: md5(body), sentAt: now, receiveCount: 0, visibleAt: now });
  return messageId;
}

/** ReceiveMessage: up to n visible messages, which become in flight for the visibility timeout (a DLQ move happens here). */
export function receiveMessages(env: AwsEnv, queue: string, n: number, now = Date.now()): SqsMessage[] {
  const q = getQueue(env, queue);
  const out: SqsMessage[] = [];
  for (const m of [...q.messages].sort((a, b) => a.sentAt - b.sentAt)) {
    if (out.length >= n) break;
    if (m.visibleAt > now) continue;
    if (q.redrivePolicy && m.receiveCount >= q.redrivePolicy.maxReceiveCount) {
      // received more than maxReceiveCount times: SQS moves it to the dead-letter queue
      const dlq = env.sqsQueues.find((x) => x.queueArn === q.redrivePolicy!.deadLetterTargetArn);
      q.messages = q.messages.filter((x) => x !== m);
      dlq?.messages.push({ ...m, visibleAt: now });
      continue;
    }
    m.receiveCount++;
    m.visibleAt = now + q.visibilityTimeout * 1000;
    out.push(m);
  }
  return out;
}

export function deleteMessage(env: AwsEnv, queue: string, messageId: string) {
  const q = getQueue(env, queue);
  q.messages = q.messages.filter((m) => m.messageId !== messageId);
}

export function purgeQueue(env: AwsEnv, queue: string) {
  const q = getQueue(env, queue);
  q.messages = [];
  trail(env, { source: 'sqs', name: 'PurgeQueue', resources: [['AWS::SQS::Queue', q.queueUrl]], request: { queueUrl: q.queueUrl }, response: null });
}

/** queues whose redrive policy points at this one (it is their DLQ) */
export const sourceQueuesOf = (env: AwsEnv, dlq: SqsQueue) => env.sqsQueues.filter((q) => q.redrivePolicy?.deadLetterTargetArn === dlq.queueArn);

/** StartMessageMoveTask ("DLQ 再処理を開始"): every message goes back to its source queue with a fresh receive count. */
export function startMessageMoveTask(env: AwsEnv, dlqName: string, now = Date.now()): number {
  const dlq = getQueue(env, dlqName);
  const [source] = sourceQueuesOf(env, dlq);
  if (!source) throw new AwsError('InvalidParameterValue', 'The source queue is not configured as a dead-letter queue of any queue.');
  const moved = dlq.messages.length;
  source.messages.push(...dlq.messages.map((m) => ({ ...m, receiveCount: 0, visibleAt: now })));
  dlq.messages = [];
  trail(env, { source: 'sqs', name: 'StartMessageMoveTask', resources: [['AWS::SQS::Queue', dlq.queueUrl]], request: { sourceArn: dlq.queueArn }, response: { taskHandle: randomHex(32) } });
  return moved;
}

// ---------------- Lambda ----------------

export function createFunction(env: AwsEnv, input: Omit<LambdaFunction, 'functionArn' | 'lastModified'>, now = Date.now()): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.functionName)) throw new AwsError('ValidationException', "1 validation error detected: Value at 'functionName' failed to satisfy constraint: Member must satisfy regular expression pattern: (arn:(aws[a-zA-Z-]*)?:lambda:)?([a-z]{2}(-gov)?-[a-z]+-\\d{1}:)?(\\d{12}:)?(function:)?([a-zA-Z0-9-_]+)(:(\\$LATEST|[a-zA-Z0-9-_]+))?");
  if (env.lambdaFunctions.some((f) => f.functionName === input.functionName)) throw new AwsError('ResourceConflictException', `Function already exist: ${input.functionName}`);
  const arn = `arn:aws:lambda:${env.region}:${env.accountId}:function:${input.functionName}`;
  env.lambdaFunctions.push({ ...input, functionArn: arn, lastModified: now });
  trail(env, { source: 'lambda', name: 'CreateFunction20150331', resources: [['AWS::Lambda::Function', arn]], request: { functionName: input.functionName, runtime: input.runtime, role: input.roleArn, handler: input.handler }, response: { functionArn: arn } });
  return arn;
}

export function getFunction(env: AwsEnv, name: string): LambdaFunction {
  const f = env.lambdaFunctions.find((x) => x.functionName === name || x.functionArn === name);
  if (!f) throw new AwsError('ResourceNotFoundException', `Function not found: arn:aws:lambda:${env.region}:${env.accountId}:function:${name}`);
  return f;
}

/** UpdateFunctionConfiguration: environment variables etc. */
export function updateFunctionConfiguration(env: AwsEnv, name: string, changes: Partial<Pick<LambdaFunction, 'environment' | 'timeout' | 'memorySize'>>, now = Date.now()) {
  const f = getFunction(env, name);
  for (const k of Object.keys(changes.environment ?? {})) if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(k)) throw new AwsError('InvalidParameterValueException', `Lambda was unable to configure your environment variables because the environment variables you have provided contains reserved keys or invalid keys: ${k}`);
  Object.assign(f, changes, { lastModified: now });
  trail(env, { source: 'lambda', name: 'UpdateFunctionConfiguration20150331v2', resources: [['AWS::Lambda::Function', f.functionArn]], request: { functionName: name, ...(changes.environment ? { environment: { variables: '***' } } : {}), ...(changes.timeout ? { timeout: changes.timeout } : {}) }, response: { functionArn: f.functionArn, lastUpdateStatus: 'Successful' } });
}

export function createEventSourceMapping(env: AwsEnv, input: { functionName: string; eventSourceArn: string; batchSize?: number; enabled?: boolean }, now = Date.now()): string {
  getFunction(env, input.functionName);
  getQueue(env, input.eventSourceArn);
  const uuid = newUuid();
  env.eventSourceMappings.push({ uuid, functionName: input.functionName, eventSourceArn: input.eventSourceArn, batchSize: input.batchSize ?? 10, enabled: input.enabled ?? true, lastProcessingResult: 'No records processed', createdAt: now });
  trail(env, { source: 'lambda', name: 'CreateEventSourceMapping20150331', resources: [['AWS::Lambda::EventSourceMapping', uuid]], request: { functionName: input.functionName, eventSourceArn: input.eventSourceArn, batchSize: input.batchSize ?? 10 }, response: { uUID: uuid, state: 'Creating' } });
  return uuid;
}

export function updateEventSourceMapping(env: AwsEnv, uuid: string, enabled: boolean) {
  const m = env.eventSourceMappings.find((x) => x.uuid === uuid);
  if (!m) throw new AwsError('ResourceNotFoundException', 'The resource you requested does not exist.');
  m.enabled = enabled;
  trail(env, { source: 'lambda', name: 'UpdateEventSourceMapping20150331', resources: [['AWS::Lambda::EventSourceMapping', uuid]], request: { uUID: uuid, enabled }, response: { uUID: uuid, state: enabled ? 'Enabling' : 'Disabling' } });
}

export interface InvokeResult {
  ok: boolean;
  requestId: string;
  /** returned value / error object, as the console shows it */
  response: unknown;
  logs: string[];
  durationMs: number;
}

/** one execution environment (log stream) per function per day: 2026/09/30/[$LATEST]<32 hex> */
const logStreamOf = (f: LambdaFunction, at: number) => {
  const day = new Date(at).toISOString().slice(0, 10);
  return `${day.replaceAll('-', '/')}/[$LATEST]${[0, 1, 2, 3].map((n) => hash(`${f.functionName}${day}${n}`).toString(16).padStart(8, '0')).join('')}`;
};

/** Runs the function's behavior model on an event; always writes START / END / REPORT to CloudWatch Logs. */
export function invokeFunction(env: AwsEnv, name: string, event: unknown, now = Date.now()): InvokeResult {
  const f = getFunction(env, name);
  const requestId = newUuid();
  const lines: string[] = [];
  const log = (level: 'INFO' | 'ERROR', msg: string) => lines.push(`${new Date(now).toISOString()}\t${requestId}\t${level}\t${msg}`);
  let response: unknown;
  let ok = true;
  try {
    response = run(env, f, event, log);
  } catch (e) {
    ok = false;
    const err = e instanceof Error ? e : new Error(String(e));
    const errorType = e instanceof AwsError ? e.code : err.name;
    response = { errorType, errorMessage: err.message, trace: [`${errorType}: ${err.message}`, '    at Runtime.handler (file:///var/task/index.mjs:9:13)'] };
    log('ERROR', `Invoke Error \t${JSON.stringify(response)}`);
  }
  const durationMs = Number((30 + (hash(requestId) % 900) / 10).toFixed(2));
  appendLog(env, `/aws/lambda/${f.functionName}`, logStreamOf(f, now), [`START RequestId: ${requestId} Version: $LATEST`, ...lines, `END RequestId: ${requestId}`, `REPORT RequestId: ${requestId}\tDuration: ${durationMs} ms\tBilled Duration: ${Math.ceil(durationMs)} ms\tMemory Size: ${f.memorySize} MB\tMax Memory Used: ${64 + (hash(requestId) % 30)} MB`], now);
  return { ok, requestId, response, logs: [`START RequestId: ${requestId} Version: $LATEST`, ...lines, `END RequestId: ${requestId}`], durationMs };
}

function run(env: AwsEnv, f: LambdaFunction, event: unknown, log: (level: 'INFO' | 'ERROR', msg: string) => void): unknown {
  // behavior 'order-processor': saves every SQS record's order to S3 with the function's role
  const bucket = f.environment.BUCKET;
  if (!bucket) throw new Error('BUCKET is not set');
  const records = (event as { Records?: { body: string }[] })?.Records;
  if (!Array.isArray(records)) throw new TypeError("Cannot read properties of undefined (reading 'Records')");
  const roleName = f.roleArn.split('/').pop()!;
  for (const r of records) {
    let order: { orderId?: unknown };
    try {
      order = JSON.parse(r.body);
    } catch {
      throw new SyntaxError(`Unexpected token in JSON at position ${Math.max(0, r.body.length - 1)}: "${r.body.slice(0, 40)}" is not valid JSON`);
    }
    const key = `orders/${order.orderId}.json`;
    s3PutObject(env, { principal: { type: 'role', roleName, sessionName: f.functionName }, context: { 'aws:SecureTransport': true } }, bucket, key, { size: r.body.length, contentType: 'application/json', body: r.body });
    log('INFO', `order ${order.orderId} saved to s3://${bucket}/${key}`);
  }
  return { statusCode: 200, processed: records.length };
}

/** the event a batch of SQS messages becomes */
export function sqsEvent(env: AwsEnv, q: SqsQueue, messages: SqsMessage[]) {
  return {
    Records: messages.map((m) => ({
      messageId: m.messageId,
      receiptHandle: `AQEB${randomHex(40)}`,
      body: m.body,
      attributes: { ApproximateReceiveCount: String(m.receiveCount), SentTimestamp: String(m.sentAt) },
      md5OfBody: m.md5OfBody,
      eventSource: 'aws:sqs',
      eventSourceARN: q.queueArn,
      awsRegion: env.region,
    })),
  };
}

export function advanceServerless(env: AwsEnv, now: number): boolean {
  if (!Number.isFinite(now)) return false;
  let changed = false;
  for (const q of env.sqsQueues ?? []) {
    const keep = q.messages.filter((m) => now - m.sentAt < q.messageRetentionPeriod * 1000);
    if (keep.length !== q.messages.length) {
      q.messages = keep;
      changed = true;
    }
  }
  for (const m of env.eventSourceMappings ?? []) {
    if (!m.enabled) continue;
    const q = env.sqsQueues.find((x) => x.queueArn === m.eventSourceArn);
    const f = env.lambdaFunctions.find((x) => x.functionName === m.functionName);
    if (!q || !f) continue;
    // a move to the DLQ happens inside ReceiveMessage: the source queue shrinks even without a batch
    const before = q.messages.length;
    const batch = receiveMessages(env, q.queueName, m.batchSize, now);
    if (!batch.length) {
      if (q.messages.length !== before) changed = true;
      continue;
    }
    changed = true;
    const r = invokeFunction(env, f.functionName, sqsEvent(env, q, batch), now);
    // without partial batch responses, the whole batch succeeds or comes back after the visibility timeout
    if (r.ok) q.messages = q.messages.filter((x) => !batch.includes(x));
    m.lastProcessingResult = r.ok ? 'OK' : 'PROBLEM: Function call failed';
  }
  return changed;
}
