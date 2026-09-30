import { hash, newUuid } from './ids';
import type { AwsEnv, TrailEvent } from './types';

/**
 * CloudTrail. Every mutating sim API calls trail(); it records only inside withActor(), i.e. when a
 * console operation (store.run) or a scenario seeding history runs it. Building scenarios and unit
 * tests therefore leave the event history empty unless they ask for it.
 */

export interface Actor {
  userName: string;
  type: 'IAMUser' | 'AssumedRole';
  arn: string;
  sourceIPAddress: string;
  userAgent: string;
}

let recording: { actor: Actor; now: number } | null = null;

/** Run fn with API calls recorded as `actor` at `now` (null = record nothing). */
export function withActor<T>(actor: Actor | null, now: number, fn: () => T): T {
  const prev = recording;
  recording = actor ? { actor, now } : null;
  try {
    return fn();
  } finally {
    recording = prev;
  }
}

/** calls made by the API itself (default rules of a new group, ...) are not separate events */
export const quietly = <T>(fn: () => T): T => withActor(null, 0, fn);

export const iamUserActor = (env: AwsEnv, userName: string, sourceIPAddress: string, o: Partial<Actor> = {}): Actor => ({ userName, type: 'IAMUser', arn: `arn:aws:iam::${env.accountId}:user/${userName}`, sourceIPAddress, userAgent: 'AWS Internal', ...o });
export const CLI_USER_AGENT = 'aws-cli/2.17.20 md/awscrt#0.20.11 ua/2.0 os/linux#5.15.0 md/arch#x86_64 lang/python#3.11.9 md/pyimpl#CPython cfg/retry-mode#standard md/installer#exe md/distrib#ubuntu.22 md/prompt#off md/command#';

export type EventSource = 'ec2' | 'elasticloadbalancing' | 'rds' | 'iam' | 's3' | 'monitoring' | 'config' | 'signin' | 'autoscaling' | 'ecs' | 'ecr' | 'sqs' | 'lambda' | 'logs' | 'batch' | 'events' | 'route53' | 'acm' | 'cloudfront' | 'wafv2' | 'organizations' | 'sso';

/** IAM (a global service) and console sign-in are logged in us-east-1 */
const GLOBAL: EventSource[] = ['iam', 'signin'];
const idPart = (s: string) => hash(s).toString(36).toUpperCase().padStart(7, '0').slice(0, 7);

/** response: extra responseElements (requestId is added), null = the API returns none (IAM, S3 ...) */
export function trail(env: AwsEnv, e: { source: EventSource; name: string; resources?: [string, string][]; request?: unknown; response?: Record<string, unknown> | null; region?: string }) {
  if (!recording) return;
  const { actor, now } = recording;
  const requestId = newUuid();
  env.trailEvents.push({
    eventId: newUuid(),
    eventTime: now,
    eventName: e.name,
    eventSource: `${e.source}.amazonaws.com`,
    awsRegion: GLOBAL.includes(e.source) ? 'us-east-1' : (e.region ?? env.region),
    sourceIPAddress: actor.sourceIPAddress,
    userAgent: actor.userAgent,
    userIdentity: { type: actor.type, principalId: `AIDA${idPart(actor.arn)}EXAMPLE${idPart(actor.userName)}`.slice(0, 21), arn: actor.arn, accountId: env.accountId, accessKeyId: `${actor.userAgent === 'AWS Internal' ? 'ASIA' : 'AKIA'}${idPart(actor.arn + 'key')}${idPart(actor.userName + 'k')}XX`.slice(0, 20), userName: actor.userName },
    readOnly: false,
    resources: e.resources ?? [],
    requestParameters: e.request ?? null,
    responseElements: e.response === null ? null : { requestId, ...(e.response ?? { _return: true }) },
    requestId,
  });
}

export type LookupAttribute = 'EventName' | 'Username' | 'ResourceType' | 'ResourceName' | 'EventSource' | 'EventId' | 'AccessKeyId';

/** LookupEvents: the region's events, newest first, optionally matching one attribute exactly (like the API). */
export function lookupEvents(env: AwsEnv, region: string, attr?: LookupAttribute, value?: string): TrailEvent[] {
  const v = value?.trim();
  const match = (e: TrailEvent) => {
    if (!attr || !v) return true;
    switch (attr) {
      case 'EventName':
        return e.eventName === v;
      case 'Username':
        return e.userIdentity.userName === v;
      case 'ResourceType':
        return e.resources.some(([t]) => t === v);
      case 'ResourceName':
        return e.resources.some(([, n]) => n === v);
      case 'EventSource':
        return e.eventSource === v;
      case 'EventId':
        return e.eventId === v;
      case 'AccessKeyId':
        return e.userIdentity.accessKeyId === v;
    }
  };
  // reversed first: events of one operation share a timestamp and must stay newest-recorded first
  return [...env.trailEvents].reverse().filter((e) => e.awsRegion === region && match(e)).sort((a, b) => b.eventTime - a.eventTime);
}

/** The event as CloudTrail stores it (the "イベントレコード" JSON). */
export function eventRecord(env: AwsEnv, e: TrailEvent) {
  return {
    eventVersion: '1.10',
    // console sessions use temporary credentials with a session context; the CLI signs with the user's access key
    userIdentity: e.userAgent === 'AWS Internal' ? { ...e.userIdentity, sessionContext: { attributes: { creationDate: new Date(e.eventTime - 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z'), mfaAuthenticated: 'false' } } } : e.userIdentity,
    eventTime: new Date(e.eventTime).toISOString().replace(/\.\d+Z$/, 'Z'),
    eventSource: e.eventSource,
    eventName: e.eventName,
    awsRegion: e.awsRegion,
    sourceIPAddress: e.sourceIPAddress,
    userAgent: e.userAgent,
    requestParameters: e.requestParameters,
    responseElements: e.responseElements,
    requestID: e.requestId,
    eventID: e.eventId,
    readOnly: e.readOnly,
    eventType: e.eventSource === 'signin.amazonaws.com' ? 'AwsConsoleSignIn' : 'AwsApiCall',
    managementEvent: true,
    recipientAccountId: env.accountId,
    eventCategory: 'Management',
    ...(e.userAgent === 'AWS Internal' ? { sessionCredentialFromConsole: 'true' } : {}),
  };
}
