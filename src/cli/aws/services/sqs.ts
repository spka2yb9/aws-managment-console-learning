/* aws sqs — キュー・メッセージの送受信・デッドレターキューの再処理 */
import { getQueue, receiveMessages, sendMessage, sourceQueuesOf, startMessageMoveTask } from '../../../sim/serverless';
import { newUuid } from '../../../sim/ids';
import type { SqsQueue } from '../../../sim/types';
import { AwsError, int, service, str, strs, type OpContext, type OperationSpec } from '../types';

const queueOf = (ctx: OpContext) => getQueue(ctx.env, str(ctx, 'queue-url')!);
const sec = (t: number) => String(Math.floor(t / 1000));
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

const ATTRIBUTES = ['QueueArn', 'ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible', 'ApproximateNumberOfMessagesDelayed', 'CreatedTimestamp', 'LastModifiedTimestamp', 'VisibilityTimeout', 'MaximumMessageSize', 'MessageRetentionPeriod', 'DelaySeconds', 'ReceiveMessageWaitTimeSeconds', 'RedrivePolicy', 'SqsManagedSseEnabled'];

function attributes(q: SqsQueue, now: number): Record<string, string> {
  const visible = q.messages.filter((m) => m.visibleAt <= now).length;
  const all: Record<string, string | undefined> = {
    QueueArn: q.queueArn,
    ApproximateNumberOfMessages: String(visible),
    ApproximateNumberOfMessagesNotVisible: String(q.messages.length - visible),
    ApproximateNumberOfMessagesDelayed: '0',
    CreatedTimestamp: sec(q.createdAt),
    LastModifiedTimestamp: sec(q.createdAt),
    VisibilityTimeout: String(q.visibilityTimeout),
    MaximumMessageSize: '262144',
    MessageRetentionPeriod: String(q.messageRetentionPeriod),
    DelaySeconds: '0',
    ReceiveMessageWaitTimeSeconds: '0',
    RedrivePolicy: q.redrivePolicy ? JSON.stringify({ deadLetterTargetArn: q.redrivePolicy.deadLetterTargetArn, maxReceiveCount: q.redrivePolicy.maxReceiveCount }) : undefined,
    SqsManagedSseEnabled: 'true',
  };
  return Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined));
}

const queueUrl = { name: 'queue-url', type: 'string', required: true, desc: 'キューの URL (aws sqs get-queue-url で引ける)' } as const;

const ops: OperationSpec[] = [
  {
    name: 'list-queues',
    desc: 'キューの URL の一覧',
    params: [{ name: 'queue-name-prefix', type: 'string', desc: '名前の頭で絞る' }],
    readOnly: true,
    run(ctx) {
      const prefix = str(ctx, 'queue-name-prefix') ?? '';
      const urls = ctx.env.sqsQueues.filter((q) => q.queueName.startsWith(prefix)).map((q) => q.queueUrl).sort();
      return urls.length ? { QueueUrls: urls } : undefined;
    },
  },
  {
    name: 'get-queue-url',
    desc: 'キューの名前から URL を引く',
    params: [{ name: 'queue-name', type: 'string', required: true, desc: 'キューの名前' }],
    readOnly: true,
    examples: ['aws sqs get-queue-url --queue-name orders-queue'],
    run(ctx) {
      const name = str(ctx, 'queue-name')!;
      const q = ctx.env.sqsQueues.find((x) => x.queueName === name);
      if (!q) throw new AwsError('AWS.SimpleQueueService.NonExistentQueue', 'The specified queue does not exist.');
      return { QueueUrl: q.queueUrl };
    },
  },
  {
    name: 'get-queue-attributes',
    desc: 'キューの属性 (メッセージの数・可視性タイムアウト・リドライブポリシー)',
    params: [queueUrl, { name: 'attribute-names', type: 'list', desc: 'All か、ApproximateNumberOfMessages などの属性名 (省略すると何も返らない)' }],
    readOnly: true,
    examples: ['aws sqs get-queue-attributes --queue-url <URL> --attribute-names All'],
    run(ctx) {
      const q = queueOf(ctx);
      const names = strs(ctx, 'attribute-names');
      for (const n of names) if (n !== 'All' && !ATTRIBUTES.includes(n) && n !== 'Policy' && n !== 'RedriveAllowPolicy') throw new AwsError('InvalidAttributeName', `Unknown Attribute ${n}.`);
      if (!names.length) return undefined;
      const all = attributes(q, ctx.now);
      const out = names.includes('All') ? all : Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k)));
      return Object.keys(out).length ? { Attributes: out } : undefined;
    },
  },
  {
    name: 'list-dead-letter-source-queues',
    desc: 'このキューをデッドレターキューにしているキューの一覧',
    params: [queueUrl],
    readOnly: true,
    run: (ctx) => ({ queueUrls: sourceQueuesOf(ctx.env, queueOf(ctx)).map((q) => q.queueUrl) }),
  },
  {
    name: 'send-message',
    desc: 'キューにメッセージを 1 件送る',
    params: [queueUrl, { name: 'message-body', type: 'string', required: true, desc: 'メッセージの本文 (例: JSON の文字列)' }],
    examples: [`aws sqs send-message --queue-url <URL> --message-body '{"orderId": 1}'`],
    run(ctx) {
      const q = queueOf(ctx);
      const id = sendMessage(ctx.env, q.queueUrl, str(ctx, 'message-body')!, ctx.now);
      return { MD5OfMessageBody: q.messages.find((m) => m.messageId === id)!.md5OfBody, MessageId: id };
    },
  },
  {
    name: 'receive-message',
    desc: 'キューからメッセージを受信する (受信したメッセージは可視性タイムアウトの間、ほかから見えなくなる)',
    params: [
      queueUrl,
      { name: 'max-number-of-messages', type: 'integer', desc: '1〜10 (既定 1)' },
      { name: 'visibility-timeout', type: 'integer', desc: '受信したメッセージを隠す秒数 (既定はキューの設定)' },
      { name: 'wait-time-seconds', type: 'integer', desc: '(このシミュレーターでは待たない) ロングポーリングの秒数' },
      { name: 'attribute-names', type: 'list', desc: 'All / ApproximateReceiveCount / SentTimestamp など' },
      { name: 'message-system-attribute-names', type: 'list', desc: 'attribute-names の新しい名前' },
    ],
    run(ctx) {
      const q = queueOf(ctx);
      const n = int(ctx, 'max-number-of-messages') ?? 1;
      if (n < 1 || n > 10) throw new AwsError('InvalidParameterValue', `Value ${n} for parameter MaxNumberOfMessages is invalid. Reason: Must be between 1 and 10, if provided.`);
      const vt = int(ctx, 'visibility-timeout');
      const got = receiveMessages(ctx.env, q.queueUrl, n, ctx.now);
      if (vt !== undefined) got.forEach((m) => (m.visibleAt = ctx.now + vt * 1000));
      if (!got.length) return undefined;
      const names = [...strs(ctx, 'attribute-names'), ...strs(ctx, 'message-system-attribute-names')];
      const attrs = (m: (typeof got)[number]) => {
        const all: Record<string, string> = { SenderId: 'AIDAIOSFODNN7EXAMPLE', ApproximateFirstReceiveTimestamp: sec(ctx.now), ApproximateReceiveCount: String(m.receiveCount), SentTimestamp: String(m.sentAt) };
        return names.includes('All') ? all : Object.fromEntries(Object.entries(all).filter(([k]) => names.includes(k)));
      };
      return {
        Messages: got.map((m) => ({
          MessageId: m.messageId,
          ReceiptHandle: `AQEB${b64(`${m.messageId} ${m.receiveCount}`).replace(/=+$/, '')}`,
          MD5OfBody: m.md5OfBody,
          Body: m.body,
          ...(Object.keys(attrs(m)).length ? { Attributes: attrs(m) } : {}),
        })),
      };
    },
  },
  {
    name: 'start-message-move-task',
    desc: 'デッドレターキューのメッセージを、元のキューに戻す (DLQ 再処理)',
    params: [
      { name: 'source-arn', type: 'string', required: true, desc: 'デッドレターキューの ARN' },
      { name: 'destination-arn', type: 'string', desc: '戻す先のキューの ARN (省略すると元のキュー)' },
      { name: 'max-number-of-messages-per-second', type: 'integer', desc: '1 秒に移す数の上限' },
    ],
    examples: ['aws sqs start-message-move-task --source-arn arn:aws:sqs:ap-northeast-1:123456789012:orders-dlq'],
    run(ctx) {
      const arn = str(ctx, 'source-arn')!;
      if (!arn.startsWith('arn:')) throw new AwsError('InvalidParameterValue', 'You must use a valid ARN for the source queue.');
      const dlq = getQueue(ctx.env, arn);
      const dest = str(ctx, 'destination-arn');
      const [source] = sourceQueuesOf(ctx.env, dlq);
      // ponytail: the simulator only moves messages back to their source queue; another destination is rejected
      if (dest && source && dest !== source.queueArn) throw new AwsError('InvalidParameterValue', `(シミュレーター) 戻す先は元のキュー (${source.queueArn}) だけに対応しています。--destination-arn を省略してください`);
      startMessageMoveTask(ctx.env, dlq.queueUrl, ctx.now);
      return { TaskHandle: b64(JSON.stringify({ taskId: newUuid(), sourceArn: dlq.queueArn })) };
    },
  },
];

export default service('sqs', 'Amazon SQS (キュー)', ops);
