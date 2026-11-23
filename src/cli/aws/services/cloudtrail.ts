/* aws cloudtrail lookup-events — イベント履歴 (コンソールの「イベント履歴」と同じ sim/cloudtrail.ts の lookupEvents) */
import { eventRecord, lookupEvents, type LookupAttribute } from '../../../sim/cloudtrail';
import { AwsError, iso, service, structs } from '../types';
import { timestamp } from './cloudwatch';

const KEYS: LookupAttribute[] = ['EventId', 'EventName', 'Username', 'ResourceType', 'ResourceName', 'EventSource', 'AccessKeyId'];

export default service('cloudtrail', 'AWS CloudTrail (誰が・いつ・何をしたかの記録)', [
  {
    name: 'lookup-events',
    desc: 'このリージョンの過去 90 日の管理イベントを、新しい順に引く (絞り込みの属性は 1 つだけ)',
    params: [
      { name: 'lookup-attributes', type: 'list', of: 'structure', desc: 'AttributeKey=ResourceName,AttributeValue=sg-... (キー: EventName / Username / ResourceName / ResourceType / EventSource / EventId / AccessKeyId)' },
      { name: 'start-time', type: 'timestamp', desc: 'この時刻以降 (2026-01-01T00:00:00Z か UNIX 時間の秒)' },
      { name: 'end-time', type: 'timestamp', desc: 'この時刻まで' },
    ],
    readOnly: true,
    examples: ['aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=RevokeSecurityGroupIngress', "aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=learner --query 'Events[0].CloudTrailEvent' --output text"],
    run(ctx) {
      const attrs = structs(ctx, 'lookup-attributes');
      if (attrs.length > 1) throw new AwsError('InvalidLookupAttributesException', 'You cannot specify more than one lookup attribute.');
      const key = attrs[0] && String(attrs[0].AttributeKey ?? '');
      const value = attrs[0] && String(attrs[0].AttributeValue ?? '');
      if (key !== undefined && !KEYS.includes(key as LookupAttribute))
        throw new AwsError('ValidationException', `1 validation error detected: Value '${key}' at 'lookupAttributes.1.member.attributeKey' failed to satisfy constraint: Member must satisfy enum value set: [${[...KEYS, 'ReadOnly'].sort().join(', ')}]`);
      if (key !== undefined && !value) throw new AwsError('InvalidLookupAttributesException', 'The attribute value must not be empty.');
      const start = timestamp(ctx, 'start-time') ?? -Infinity;
      const end = timestamp(ctx, 'end-time') ?? Infinity;
      if (start > end) throw new AwsError('InvalidTimeRangeException', 'Start time must be before end time.');
      const events = lookupEvents(ctx.env, ctx.region, key as LookupAttribute | undefined, value).filter((e) => e.eventTime >= start && e.eventTime <= end);
      return {
        Events: events.map((e) => ({
          EventId: e.eventId,
          EventName: e.eventName,
          ReadOnly: String(e.readOnly),
          AccessKeyId: e.userIdentity.accessKeyId,
          EventTime: iso(e.eventTime),
          EventSource: e.eventSource,
          Username: e.userIdentity.userName,
          Resources: e.resources.map(([ResourceType, ResourceName]) => ({ ResourceType, ResourceName })),
          // 実物と同じく、イベントレコードは JSON の文字列のまま入っている
          CloudTrailEvent: JSON.stringify(eventRecord(ctx.env, e)),
        })),
      };
    },
  },
]);
