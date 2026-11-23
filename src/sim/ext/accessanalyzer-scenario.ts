// Lesson 45 scenario: the account before a partner integration audit (base stack prepared, no analyzer yet).
import { quietly } from '../cloudtrail';
import { attachPolicy, createRole, putInlinePolicy } from '../iam';
import { withStableIds } from '../ids';
import { createBucket, putBucketPolicy, putObject, putPublicAccessBlock } from '../s3';
import { s3IamEnv } from '../scenarios';
import type { AwsEnv } from '../types';

const DAY = 86_400_000;

/** はやて物流: the delivery partner, shared with on purpose (contract) */
export const PARTNER_ACCOUNT = '999988887777';
/** the migration vendor of 2025: its contract is over, nobody remembers the role */
export const VENDOR_ACCOUNT = '444455556666';
export const EXCHANGE_BUCKET = 'webapp-partner-exchange-123456789012';
export const EXPORTS_BUCKET = 'webapp-exports-123456789012';
export const PARTNER_ROLE = 'partner-upload-role';
export const VENDOR_ROLE = 'old-vendor-role';
export const EC2_READONLY = 'arn:aws:iam::aws:policy/AmazonEC2ReadOnlyAccess';

/**
 * s3IamEnv (learner, batch-role + batch-1, the reports bucket) plus what a year of work left behind:
 * - the partner exchange bucket and partner-upload-role, shared with はやて物流 (999988887777) on purpose
 * - webapp-exports, made public "for a moment" to hand a customer list to an agency (a mistake)
 * - old-vendor-role, trusted by the old migration vendor (444455556666), last used 200 days ago
 * - batch-role with AmazonEC2ReadOnlyAccess attached for debugging long ago (only S3 is used)
 * The usage data is IAM's last-accessed information, the evidence the unused access analyzer reads.
 */
export function accessAnalyzerEnv(): AwsEnv {
  return s3IamEnv({}, (env) =>
    withStableIds('access-analyzer', () =>
      quietly(() => {
        const now = Date.now();
        const ago = (days: number) => now - days * DAY;
        const iso = (days: number) => new Date(ago(days)).toISOString();
        const batch = env.iamRoles.find((r) => r.roleName === 'batch-role')!;
        // the account (and batch-role) is older than the s3IamEnv default
        batch.createDate = iso(400);
        attachPolicy(env, 'role', 'batch-role', EC2_READONLY);

        createBucket(env, { name: EXCHANGE_BUCKET }, ago(300));
        putObject(env, EXCHANGE_BUCKET, 'exchange/2026-11/shipments.csv', { size: 4096, contentType: 'text/csv', body: 'order_id,tracking_no\n1001,HY-778812\n' }, ago(2));
        const partner = `arn:aws:iam::${PARTNER_ACCOUNT}:root`;
        putBucketPolicy(
          env,
          EXCHANGE_BUCKET,
          JSON.stringify({
            Version: '2012-10-17',
            Statement: [
              { Sid: 'PartnerHayateList', Effect: 'Allow', Principal: { AWS: partner }, Action: 's3:ListBucket', Resource: `arn:aws:s3:::${EXCHANGE_BUCKET}` },
              { Sid: 'PartnerHayateReadWrite', Effect: 'Allow', Principal: { AWS: partner }, Action: ['s3:GetObject', 's3:PutObject'], Resource: `arn:aws:s3:::${EXCHANGE_BUCKET}/*` },
            ],
          }),
          `arn:aws:iam::${env.accountId}:user/learner`,
        );

        createBucket(env, { name: EXPORTS_BUCKET }, ago(60));
        putObject(env, EXPORTS_BUCKET, 'customers/customers-2026-10.csv', { size: 52_011, contentType: 'text/csv', body: 'customer_id,name,email\n1,山田 太郎,yamada@example.com\n' }, ago(20));
        putPublicAccessBlock(env, EXPORTS_BUCKET, { blockPublicAcls: true, ignorePublicAcls: true, blockPublicPolicy: false, restrictPublicBuckets: false });
        putBucketPolicy(
          env,
          EXPORTS_BUCKET,
          JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'TemporaryShareForAgency', Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${EXPORTS_BUCKET}/*` }] }),
          `arn:aws:iam::${env.accountId}:user/learner`,
        );

        createRole(
          env,
          {
            roleName: PARTNER_ROLE,
            description: 'はやて物流 uploads shipment files',
            trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: partner }, Action: 'sts:AssumeRole', Condition: { StringEquals: { 'sts:ExternalId': 'hayate-webapp-2026' } } }] },
          },
          ago(300),
        );
        putInlinePolicy(env, 'role', PARTNER_ROLE, 'exchange-upload', { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: `arn:aws:s3:::${EXCHANGE_BUCKET}/*` }] });

        createRole(
          env,
          { roleName: VENDOR_ROLE, description: 'Migration support (2025)', trustPolicy: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { AWS: `arn:aws:iam::${VENDOR_ACCOUNT}:root` }, Action: 'sts:AssumeRole' }] }, policyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'] },
          ago(500),
        );

        const arn = (role: string) => env.iamRoles.find((r) => r.roleName === role)!.arn;
        env.accessAnalyzer = {
          analyzers: [],
          usage: {
            [batch.arn]: { lastAccessed: ago(1), services: { s3: ago(1) } },
            [arn(PARTNER_ROLE)]: { lastAccessed: ago(2), services: { s3: ago(2) } },
            [arn(VENDOR_ROLE)]: { lastAccessed: ago(200), services: { ec2: ago(200), s3: ago(201) } },
          },
        };
      }),
    ),
  );
}
