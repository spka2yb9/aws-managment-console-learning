import type { Course, Lesson } from '../lesson/types';
import { lesson01, lesson02, lesson03, lesson04, lesson05 } from './l01-05-basics';
import { lesson06, lesson07, lesson08 } from './l06-08-routing';
import { lesson09 } from './l09-security-group';
import { lessonNacl, lessonNaclTroubleshooting } from './l-nacl';
import { lesson20, lesson21, lesson22, lesson23 } from './l20-23-s3-iam';
import { lesson24, lesson25 } from './l24-25-cloudwatch';
import { lesson26, lesson27 } from './l26-27-audit';
import { lesson28, lesson29 } from './l28-29-backup';
import { lesson30, lesson31 } from './l30-31-autoscaling';
import { lesson32 } from './l32-ecs';
import { lesson33 } from './l33-sqs-lambda';
import { lesson34 } from './l34-batch';
import { lesson35, lesson36, lesson37, lesson38 } from './l35-38-edge';
import { lesson39, lesson40, lesson41 } from './l39-41-cost-org';
import { lesson10, lesson11, lesson12, lesson13, lesson14, lesson15 } from './l10-15-webapp';
import { lesson16, lesson17, lesson18, lesson19 } from './l16-19-troubleshooting';

export const COURSES: Course[] = [
  { id: 'basics', title: 'AWS の基礎', description: 'クラウドの考え方、Management Console、Region / AZ', lessons: [lesson01, lesson02] },
  { id: 'network', title: 'ネットワーク (VPC)', description: 'VPC / CIDR / Subnet / Route Table / Internet Gateway / Security Group / Network ACL', lessons: [lesson03, lesson04, lesson05, lesson06, lesson07, lesson08, lesson09, lessonNacl] },
  { id: 'webapp', title: 'Web アプリケーション基盤', description: 'EC2 / ALB / Target Group / Health Check / RDS と通信経路', lessons: [lesson10, lesson11, lesson12, lesson13, lesson14, lesson15] },
  { id: 'troubleshooting', title: 'トラブルシューティング', description: '504 / 502 / 500 を症状から原因まで切り分ける', lessons: [lesson16, lessonNaclTroubleshooting, lesson17, lesson18] },
  { id: 'final', title: 'MVP 総合演習', description: 'Internet → ALB → EC2 → RDS を自分の手で ALL CONNECTED に', lessons: [lesson19] },
  { id: 's3-iam', title: 'セキュリティ: S3 / IAM', description: 'バケットとオブジェクト、ブロックパブリックアクセス、IAM ロール、AccessDenied の切り分け', lessons: [lesson20, lesson21, lesson22, lesson23] },
  { id: 'observability', title: '運用監視: CloudWatch', description: 'メトリクス・アラーム・ログで「遅い」「おかしい」の原因を絞り込む', lessons: [lesson24, lesson25] },
  { id: 'audit', title: '運用調査: CloudTrail / AWS Config', description: '変更履歴 (誰が・いつ・何を) と設定の準拠状況で、原因と問題を見つける', lessons: [lesson26, lesson27] },
  { id: 'reliability', title: '信頼性: バックアップと DR', description: 'スナップショットと特定時点への復元、RPO / RTO、DR 戦略', lessons: [lesson28, lesson29] },
  { id: 'scaling', title: 'スケーリング: Auto Scaling', description: '起動テンプレート、Auto Scaling グループ、ターゲット追跡スケーリングと負荷テスト', lessons: [lesson30, lesson31] },
  { id: 'containers', title: 'コンテナと非同期処理', description: 'ECR / ECS (Fargate)、SQS と Lambda、EventBridge と AWS Batch', lessons: [lesson32, lesson33, lesson34] },
  { id: 'edge', title: 'エッジ: DNS / 証明書 / CDN / WAF', description: 'Route 53、ACM、CloudFront、AWS WAF で、独自ドメインの HTTPS サイトを届けて守る', lessons: [lesson35, lesson36, lesson37, lesson38] },
  { id: 'advanced', title: '上級: コストとマルチアカウント', description: 'コスト vs 可用性 vs セキュリティのトレードオフ、AWS Organizations と SCP、IAM Identity Center', lessons: [lesson39, lesson40, lesson41] },
];

export const ALL_LESSONS: Lesson[] = COURSES.flatMap((c) => c.lessons);

export function findLesson(id: string): Lesson | undefined {
  return ALL_LESSONS.find((l) => l.id === id);
}

export function nextLessonOf(id: string): Lesson | undefined {
  const i = ALL_LESSONS.findIndex((l) => l.id === id);
  return i >= 0 ? ALL_LESSONS[i + 1] : undefined;
}
