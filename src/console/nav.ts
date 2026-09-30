import type { SideNavigationProps } from '@cloudscape-design/components/side-navigation';
import type { ServiceId } from './routes';

export interface ServiceInfo {
  id: ServiceId;
  name: string;
  description: string;
  home: string;
}

export const SERVICES: ServiceInfo[] = [
  { id: 'ec2', name: 'EC2', description: 'クラウド内の仮想サーバー', home: '/ec2/home' },
  { id: 'vpc', name: 'VPC', description: '独立したクラウドリソース', home: '/vpc/home' },
  { id: 'rds', name: 'RDS', description: 'マネージド型リレーショナルデータベースサービス', home: '/rds/home' },
  { id: 's3', name: 'S3', description: 'クラウド内のスケーラブルなストレージ', home: '/s3/buckets' },
  { id: 'iam', name: 'IAM', description: 'AWS リソースへのアクセスの管理', home: '/iam/home' },
  { id: 'cloudwatch', name: 'CloudWatch', description: 'リソースとアプリケーションのモニタリング', home: '/cloudwatch/home' },
  { id: 'cloudtrail', name: 'CloudTrail', description: 'ユーザーアクティビティと API 使用状況の追跡', home: '/cloudtrail/events' },
  { id: 'config', name: 'AWS Config', description: 'リソースのインベントリと変更の追跡', home: '/config/home' },
  { id: 'ecs', name: 'Elastic Container Service', description: 'コンテナを実行するための、安全で信頼性が高くスケーラブルな方法', home: '/ecs/clusters' },
  { id: 'ecr', name: 'Elastic Container Registry', description: 'フルマネージド型のコンテナレジストリ', home: '/ecr/repositories' },
  { id: 'lambda', name: 'Lambda', description: 'サーバーについて考えることなくコードを実行', home: '/lambda/functions' },
  { id: 'sqs', name: 'Simple Queue Service', description: 'マネージド型メッセージキュー', home: '/sqs/queues' },
  { id: 'events', name: 'Amazon EventBridge', description: 'イベントとスケジュールでアプリケーションをつなぐサーバーレスイベントバス', home: '/events/rules' },
  { id: 'batch', name: 'Batch', description: 'あらゆる規模のバッチジョブをフルマネージド型で実行', home: '/batch/jobs' },
  { id: 'route53', name: 'Route 53', description: 'スケーラブルな DNS とドメイン名の登録', home: '/route53/hostedzones' },
  { id: 'cloudfront', name: 'CloudFront', description: 'グローバルなコンテンツ配信ネットワーク', home: '/cloudfront/distributions' },
  { id: 'acm', name: 'Certificate Manager', description: 'SSL/TLS 証明書のプロビジョニングと管理', home: '/acm/certificates' },
  { id: 'wafv2', name: 'WAF & Shield', description: '一般的なウェブの脆弱性からウェブアプリケーションを保護', home: '/wafv2/webacls' },
  { id: 'billing', name: '請求とコスト管理', description: 'コストの確認と予算の管理', home: '/billing/home' },
  { id: 'organizations', name: 'AWS Organizations', description: '複数の AWS アカウントを一元管理', home: '/organizations/accounts' },
  { id: 'sso', name: 'IAM Identity Center', description: '複数の AWS アカウントへのワークフォースアクセスを管理', home: '/sso/home' },
];

/** Features ("sub-pages") indexed by the unified search, like the real console search results. */
export const FEATURES = [
  { name: 'お使いの VPC', en: 'Your VPCs', service: 'VPC', path: '/vpc/vpcs' },
  { name: 'サブネット', en: 'Subnets', service: 'VPC', path: '/vpc/subnets' },
  { name: 'ルートテーブル', en: 'Route tables', service: 'VPC', path: '/vpc/route-tables' },
  { name: 'インターネットゲートウェイ', en: 'Internet gateways igw', service: 'VPC', path: '/vpc/igws' },
  { name: 'ネットワーク ACL', en: 'Network ACLs NACL', service: 'VPC', path: '/vpc/network-acls' },
  { name: 'NAT ゲートウェイ', en: 'NAT gateways', service: 'VPC', path: '/vpc/nat-gateways' },
  { name: 'エンドポイント', en: 'Endpoints VPC endpoint gateway S3', service: 'VPC', path: '/vpc/endpoints' },
  { name: 'セキュリティグループ', en: 'Security groups', service: 'VPC', path: '/vpc/security-groups' },
  { name: 'インスタンス', en: 'Instances', service: 'EC2', path: '/ec2/instances' },
  { name: 'セキュリティグループ', en: 'Security groups', service: 'EC2', path: '/ec2/security-groups' },
  { name: 'ロードバランサー', en: 'Load balancers ALB ELB', service: 'EC2', path: '/ec2/load-balancers' },
  { name: 'ターゲットグループ', en: 'Target groups', service: 'EC2', path: '/ec2/target-groups' },
  { name: '起動テンプレート', en: 'Launch templates', service: 'EC2', path: '/ec2/launch-templates' },
  { name: 'Auto Scaling グループ', en: 'Auto Scaling groups ASG', service: 'EC2', path: '/ec2/autoscaling' },
  { name: 'データベース', en: 'Databases', service: 'RDS', path: '/rds/databases' },
  { name: 'サブネットグループ', en: 'Subnet groups', service: 'RDS', path: '/rds/subnet-groups' },
  { name: 'スナップショット', en: 'Snapshots RDS backups', service: 'RDS', path: '/rds/snapshots' },
  { name: 'バケット', en: 'Buckets S3', service: 'S3', path: '/s3/buckets' },
  { name: 'ロール', en: 'Roles', service: 'IAM', path: '/iam/roles' },
  { name: 'ユーザー', en: 'Users', service: 'IAM', path: '/iam/users' },
  { name: 'ポリシー', en: 'Policies', service: 'IAM', path: '/iam/policies' },
  { name: 'ポリシーシミュレーター', en: 'Policy simulator', service: 'IAM', path: '/iam/simulator' },
  { name: 'すべてのアラーム', en: 'Alarms', service: 'CloudWatch', path: '/cloudwatch/alarms' },
  { name: 'ロググループ', en: 'Log groups Logs', service: 'CloudWatch', path: '/cloudwatch/logs' },
  { name: 'すべてのメトリクス', en: 'All metrics Metrics', service: 'CloudWatch', path: '/cloudwatch/metrics' },
  { name: 'イベント履歴', en: 'Event history CloudTrail', service: 'CloudTrail', path: '/cloudtrail/events' },
  { name: 'ルール', en: 'Rules Config rules', service: 'AWS Config', path: '/config/rules' },
  { name: 'リソース', en: 'Resources Config inventory', service: 'AWS Config', path: '/config/resources' },
  { name: 'クラスター', en: 'Clusters ECS Fargate', service: 'ECS', path: '/ecs/clusters' },
  { name: 'タスク定義', en: 'Task definitions ECS', service: 'ECS', path: '/ecs/task-definitions' },
  { name: 'プライベートリポジトリ', en: 'Repositories ECR images', service: 'ECR', path: '/ecr/repositories' },
  { name: '関数', en: 'Functions Lambda', service: 'Lambda', path: '/lambda/functions' },
  { name: 'キュー', en: 'Queues SQS', service: 'SQS', path: '/sqs/queues' },
  { name: 'ルール', en: 'EventBridge rules schedule', service: 'EventBridge', path: '/events/rules' },
  { name: 'ジョブ', en: 'Batch jobs', service: 'Batch', path: '/batch/jobs' },
  { name: 'ホストゾーン', en: 'Hosted zones Route 53 DNS', service: 'Route 53', path: '/route53/hostedzones' },
  { name: '証明書', en: 'Certificates ACM SSL TLS', service: 'Certificate Manager', path: '/acm/certificates' },
  { name: 'ディストリビューション', en: 'Distributions CloudFront CDN', service: 'CloudFront', path: '/cloudfront/distributions' },
  { name: 'ウェブ ACL', en: 'Web ACLs WAF', service: 'WAF & Shield', path: '/wafv2/webacls' },
  { name: 'IP セット', en: 'IP sets WAF', service: 'WAF & Shield', path: '/wafv2/ipsets' },
  { name: 'コストと予算', en: 'Billing Cost Explorer Budgets cost', service: '請求とコスト管理', path: '/billing/home' },
  { name: 'AWS アカウント', en: 'Organizations accounts OU', service: 'AWS Organizations', path: '/organizations/accounts' },
  { name: 'サービスコントロールポリシー', en: 'Organizations SCP service control policies', service: 'AWS Organizations', path: '/organizations/policies' },
  { name: '許可セット', en: 'Identity Center permission sets SSO', service: 'IAM Identity Center', path: '/sso/permission-sets' },
  { name: 'AWS アカウント (割り当て)', en: 'Identity Center accounts assignments SSO', service: 'IAM Identity Center', path: '/sso/accounts' },
  { name: 'AWS アクセスポータル', en: 'Identity Center access portal SSO', service: 'IAM Identity Center', path: '/sso/portal' },
];

type Items = SideNavigationProps['items'];
const link = (text: string, href: string) => ({ type: 'link' as const, text, href });

export const SIDE_NAV: Record<Exclude<ServiceId, 'console'>, { header: SideNavigationProps.Header; items: Items }> = {
  vpc: {
    header: { text: 'VPC ダッシュボード', href: '/vpc/home' },
    items: [
      {
        type: 'section',
        text: '仮想プライベートクラウド',
        items: [link('お使いの VPC', '/vpc/vpcs'), link('サブネット', '/vpc/subnets'), link('ルートテーブル', '/vpc/route-tables'), link('インターネットゲートウェイ', '/vpc/igws'), link('NAT ゲートウェイ', '/vpc/nat-gateways'), link('エンドポイント', '/vpc/endpoints')],
      },
      { type: 'section', text: 'セキュリティ', items: [link('ネットワーク ACL', '/vpc/network-acls'), link('セキュリティグループ', '/vpc/security-groups')] },
    ],
  },
  ec2: {
    header: { text: 'EC2', href: '/ec2/home' },
    items: [
      link('ダッシュボード', '/ec2/home'),
      { type: 'section', text: 'インスタンス', items: [link('インスタンス', '/ec2/instances'), link('起動テンプレート', '/ec2/launch-templates')] },
      { type: 'section', text: 'ネットワーク & セキュリティ', items: [link('セキュリティグループ', '/ec2/security-groups')] },
      { type: 'section', text: 'ロードバランシング', items: [link('ロードバランサー', '/ec2/load-balancers'), link('ターゲットグループ', '/ec2/target-groups')] },
      { type: 'section', text: 'Auto Scaling', items: [link('Auto Scaling グループ', '/ec2/autoscaling')] },
    ],
  },
  rds: {
    header: { text: 'Aurora and RDS', href: '/rds/home' },
    items: [link('ダッシュボード', '/rds/home'), link('データベース', '/rds/databases'), link('スナップショット', '/rds/snapshots'), link('サブネットグループ', '/rds/subnet-groups')],
  },
  s3: {
    header: { text: 'Amazon S3', href: '/s3/buckets' },
    items: [{ type: 'section', text: 'バケット', items: [link('汎用バケット', '/s3/buckets')] }],
  },
  iam: {
    header: { text: 'Identity and Access Management (IAM)', href: '/iam/home' },
    items: [
      link('ダッシュボード', '/iam/home'),
      { type: 'section', text: 'アクセス管理', items: [link('ユーザー', '/iam/users'), link('ロール', '/iam/roles'), link('ポリシー', '/iam/policies')] },
      { type: 'section', text: 'ツール', items: [link('ポリシーシミュレーター', '/iam/simulator')] },
    ],
  },
  cloudwatch: {
    header: { text: 'CloudWatch', href: '/cloudwatch/home' },
    items: [
      { type: 'section', text: 'アラーム', items: [link('すべてのアラーム', '/cloudwatch/alarms')] },
      { type: 'section', text: 'ログ', items: [link('ロググループ', '/cloudwatch/logs')] },
      { type: 'section', text: 'メトリクス', items: [link('すべてのメトリクス', '/cloudwatch/metrics')] },
    ],
  },
  cloudtrail: {
    header: { text: 'CloudTrail', href: '/cloudtrail/events' },
    items: [link('イベント履歴', '/cloudtrail/events')],
  },
  ecs: {
    header: { text: 'Amazon Elastic Container Service', href: '/ecs/clusters' },
    items: [link('クラスター', '/ecs/clusters'), link('タスク定義', '/ecs/task-definitions'), { type: 'section', text: 'Amazon ECR', items: [link('リポジトリ', '/ecr/repositories')] }],
  },
  lambda: {
    header: { text: 'Lambda', href: '/lambda/functions' },
    items: [link('関数', '/lambda/functions')],
  },
  events: {
    header: { text: 'Amazon EventBridge', href: '/events/rules' },
    items: [{ type: 'section', text: 'バス', items: [link('ルール', '/events/rules')] }],
  },
  batch: {
    header: { text: 'AWS Batch', href: '/batch/jobs' },
    items: [link('ジョブ', '/batch/jobs'), link('ジョブキュー', '/batch/job-queues'), link('ジョブ定義', '/batch/job-definitions'), link('コンピューティング環境', '/batch/compute-environments')],
  },
  sqs: {
    header: { text: 'Amazon SQS', href: '/sqs/queues' },
    items: [link('キュー', '/sqs/queues')],
  },
  ecr: {
    header: { text: 'Amazon Elastic Container Registry', href: '/ecr/repositories' },
    items: [{ type: 'section', text: 'プライベートレジストリ', items: [link('リポジトリ', '/ecr/repositories')] }],
  },
  route53: {
    header: { text: 'Route 53', href: '/route53/hostedzones' },
    items: [link('ホストゾーン', '/route53/hostedzones')],
  },
  acm: {
    header: { text: 'AWS Certificate Manager', href: '/acm/certificates' },
    items: [link('証明書をリクエスト', '/acm/certificates/request'), link('証明書を一覧表示', '/acm/certificates')],
  },
  cloudfront: {
    header: { text: 'CloudFront', href: '/cloudfront/distributions' },
    items: [link('ディストリビューション', '/cloudfront/distributions')],
  },
  wafv2: {
    header: { text: 'WAF & Shield', href: '/wafv2/webacls' },
    items: [{ type: 'section', text: 'AWS WAF', items: [link('ウェブ ACL', '/wafv2/webacls'), link('IP セット', '/wafv2/ipsets')] }],
  },
  billing: {
    header: { text: '請求とコスト管理', href: '/billing/home' },
    items: [link('ホーム', '/billing/home')],
  },
  organizations: {
    header: { text: 'AWS Organizations', href: '/organizations/accounts' },
    items: [link('AWS アカウント', '/organizations/accounts'), { type: 'section', text: 'ポリシー', items: [link('サービスコントロールポリシー', '/organizations/policies')] }],
  },
  sso: {
    header: { text: 'IAM Identity Center', href: '/sso/home' },
    items: [
      link('ダッシュボード', '/sso/home'),
      { type: 'section', text: 'ユーザーとグループ', items: [link('ユーザー', '/sso/users'), link('グループ', '/sso/groups')] },
      { type: 'section', text: 'マルチアカウント許可', items: [link('AWS アカウント', '/sso/accounts'), link('許可セット', '/sso/permission-sets')] },
      link('AWS アクセスポータル', '/sso/portal'),
    ],
  },
  config: {
    header: { text: 'AWS Config', href: '/config/home' },
    items: [link('ダッシュボード', '/config/home'), link('ルール', '/config/rules'), link('リソース', '/config/resources')],
  },
};

/** Side nav highlights the list page a detail/edit page belongs to. */
export function activeHref(path: string): string {
  const p = path.split('?')[0];
  const all = Object.values(SIDE_NAV).flatMap((s) => (s.items ?? []).flatMap((i) => ('items' in i ? (i.items ?? []) : [i])).map((i) => ('href' in i ? i.href : '')));
  return all.filter((h) => h && (p === h || p.startsWith(h + '/'))).sort((a, b) => b.length - a.length)[0] ?? p;
}
