import { describe, expect, it } from 'vitest';
import { getQueue, invokeFunction, sendMessage, startMessageMoveTask, updateFunctionConfiguration } from './serverless';
import { filterLogEvents } from './cloudwatch';
import { asyncEnv, ORDERS_BUCKET } from './scenarios';
import { detachPolicy, policyArn } from './iam';
import { advanceTime } from './time';
import { mutate } from './env';
import type { AwsEnv } from './types';

const tick = (env: AwsEnv, from: number, seconds: number) => {
  for (let t = from; t <= from + seconds * 1000; t += 1000) advanceTime(env, t);
  return from + seconds * 1000;
};
const keys = (env: AwsEnv) => env.buckets.find((b) => b.name === ORDERS_BUCKET)!.objects.map((o) => o.key).sort();
const logs = (env: AwsEnv, pattern: string, now: number) => filterLogEvents(env, env.logGroups.find((g) => g.logGroupName === '/aws/lambda/process-order')!, { start: now - 12 * 3_600_000, end: now + 600_000, pattern });

describe('SQS + Lambda', () => {
  it('the scenario: a bad deploy sent 3 orders to the DLQ after 3 failed receives each', () => {
    const env = asyncEnv();
    expect(keys(env)).toEqual(['orders/998.json', 'orders/999.json']);
    expect(getQueue(env, 'orders-queue').messages).toHaveLength(0);
    const dlq = getQueue(env, 'orders-dlq').messages;
    expect(dlq.map((m) => JSON.parse(m.body).orderId)).toEqual([1001, 1002, 1003]);
    expect(dlq.every((m) => m.receiveCount === 3)).toBe(true);
    expect(logs(env, 'BUCKET', Date.now()).length).toBeGreaterThanOrEqual(9);
    expect(logs(env, 'REPORT', Date.now())[0].message).toMatch(/^REPORT RequestId: [0-9a-f-]{36}\tDuration: [\d.]+ ms\tBilled Duration: \d+ ms\tMemory Size: 128 MB\tMax Memory Used: \d+ MB$/);
  });

  it('fix the variable -> retried message succeeds; redrive the DLQ; a poison message ends up in the DLQ', () => {
    const env = asyncEnv();
    let now = Date.now();
    sendMessage(env, 'orders-queue', JSON.stringify({ orderId: 2001, amount: 1200 }), now);
    now = tick(env, now, 2);
    expect(getQueue(env, 'orders-queue').messages[0].receiveCount).toBe(1); // failed, in flight
    updateFunctionConfiguration(env, 'process-order', { environment: { BUCKET: ORDERS_BUCKET } }, now);
    now = tick(env, now, 10);
    expect(keys(env)).toContain('orders/2001.json');
    expect(startMessageMoveTask(env, 'orders-dlq', now)).toBe(3);
    now = tick(env, now, 2);
    expect(keys(env)).toEqual(expect.arrayContaining(['orders/1001.json', 'orders/1002.json', 'orders/1003.json']));
    expect(getQueue(env, 'orders-dlq').messages).toHaveLength(0);
    sendMessage(env, 'orders-queue', '{"orderId": 3001,', now);
    // like the console's clock: a tick only keeps its changes when advanceTime reports them
    for (let t = now; t <= now + 40_000; t += 1000) {
      const [next, changed] = mutate(env, (d) => advanceTime(d, t));
      if (changed) Object.assign(env, next);
    }
    now += 40_000;
    expect(getQueue(env, 'orders-dlq').messages.map((m) => m.body)).toEqual(['{"orderId": 3001,']);
    expect(logs(env, 'SyntaxError', now).length).toBe(3);
    // a console test invocation with a plain event
    const r = invokeFunction(env, 'process-order', { hello: 'world' }, now);
    expect(r.ok).toBe(false);
    expect(r.response).toMatchObject({ errorType: 'TypeError' });
  });

  it('the function role decides what it may write (AccessDenied from IAM)', () => {
    const env = asyncEnv();
    updateFunctionConfiguration(env, 'process-order', { environment: { BUCKET: ORDERS_BUCKET } });
    expect(invokeFunction(env, 'process-order', { Records: [{ body: '{"orderId":1}' }] }).ok).toBe(true);
    detachPolicy(env, 'role', 'process-order-role', policyArn(env, 'process-order-s3'));
    const r = invokeFunction(env, 'process-order', { Records: [{ body: '{"orderId":2}' }] });
    expect(r.ok).toBe(false);
    expect(r.response).toMatchObject({ errorType: 'AccessDenied' });
    expect((r.response as { errorMessage: string }).errorMessage).toContain('assumed-role/process-order-role/process-order is not authorized to perform: s3:PutObject');
  });
});
