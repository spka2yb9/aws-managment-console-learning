# AWS Console Learning Simulator

実AWSに一切接続せず、AWS マネジメントコンソール (日本語表示) そっくりの画面を操作しながら
VPC → ALB → EC2 → RDS の構成と通信トラブル、S3 / IAM の権限トラブル、CloudWatch による障害調査、CloudTrail / AWS Config による変更履歴と監査、RDS のバックアップと DR、Auto Scaling、コンテナ (ECS/Fargate) と非同期処理 (SQS/Lambda/EventBridge/Batch)、エッジ (Route 53 / ACM / CloudFront / WAF)、コストのトレードオフとマルチアカウント (Organizations / SCP / IAM Identity Center) を学ぶ、GitHub Pages 向けの静的 SPA です。

## コマンド

```bash
npm ci
npm run dev        # http://localhost:5173/
npm run lint
npm run typecheck
npm test           # Vitest (シミュレーションエンジン / レッスン検証 / 構成図レイアウト)
npm run build      # dist/ を GitHub Pages にそのまま置ける (相対 base + Hash Routing)
npm run e2e        # Playwright (本番ビルドを vite preview で起動して実行)
```

GitHub Actions: `.github/workflows/deploy.yml` (main push → ci → lint → typecheck → test → build → e2e → Pages deploy。どこかで失敗したら deploy しない)。
リポジトリの Settings → Pages で Source を "GitHub Actions" にしてください。

## 構成

| ディレクトリ | 内容 |
|---|---|
| `src/sim/` | AWS シミュレーションエンジン (Domain Model, CIDR, `evaluateRoute` / `isPublicSubnet`, `evaluateSecurityGroup` / `canConnect`, ネットワーク ACL (`evaluateNacl`: ルール番号順・ステートレス・エフェメラルポート), EC2 状態遷移, `isTargetHealthy`, RDS, HTTP 経路診断, IAM ポリシー評価 (`evaluateIamPermission`: 明示的な拒否 → 許可 → 暗黙的な拒否), S3 (ブロックパブリックアクセス / バケットポリシー / バージョニング), EC2 上の疑似 AWS CLI (`execCli`), CloudWatch (`cloudwatch.ts`: メトリクス・ログは env と時刻から決定的に生成、アラーム評価は AWS 形式の理由付き), CloudTrail (`cloudtrail.ts`: 各 API が `trail()` で記録。コンソール操作は learner として、シナリオは過去の他ユーザーの操作として記録), AWS Config (`config.ts`: マネージドルールを現在の設定から評価), RDS スナップショット / 特定時点への復元 (DB の中身は行数の履歴で表現)、EC2 上の `mysql` クライアントとシェルスクリプト、Auto Scaling (`autoscaling.ts`: 起動テンプレート / グループ / ターゲット追跡。負荷はシミュレーターの「負荷テスト」タブで req/s を指定), ECR / ECS on Fargate (`containers.ts`: ローリングデプロイ・イメージ取得失敗、IP ターゲット), SQS / Lambda (`serverless.ts`: 可視性タイムアウト・DLQ・再処理。Lambda はコードの代わりに動作モデルを実行), EventBridge / AWS Batch (`batch.ts`: rate / cron (UTC) スケジュール、ジョブロール), Route 53 / ACM / CloudFront / WAF (`edge.ts`: レコード検証 (Zone Apex の CNAME 不可・エイリアス)、DNS 検証による証明書発行、us-east-1 証明書と代替ドメイン名の検証、エッジキャッシュと無効化、IP セット / マネージドルールの評価とサンプリング。ブラウザの HTTP 診断は DNS → TLS → WAF → キャッシュ → オリジンの順), NAT ゲートウェイ / S3 ゲートウェイエンドポイント (`vpc.ts`: ルートのターゲット、削除でブラックホール), コスト (`cost.ts`: 現在の構成が 1 か月続いた場合の概算。EC2 / RDS (マルチ AZ) / ALB / NAT / データ転送 (経路と AZ 間) / ログ (取り込み・保持期間) / バックアップ), AWS Organizations / IAM Identity Center (`organizations.ts`: OU の継承に沿った SCP 評価、許可セットと割り当て、アクセスポータルでの許可セット AND SCP の判定)) |
| `src/console/` | 日本語版マネジメントコンソール UI (Cloudscape)。共通部品は `ui.tsx` |
| `src/lesson/` | レッスン型定義 (`LessonContent`)、XState の Lesson State Machine、会話 / 演習 / クイズの Renderer |
| `src/lessons/` | レッスンデータ 01〜19 + 09-2 (Network ACL) / 16-2 (Network ACL Troubleshooting) + 20〜23 (S3 / IAM / AccessDenied) + 24〜25 (CloudWatch / アプリが遅い) + 26〜27 (CloudTrail / AWS Config) + 28〜29 (バックアップ / RPO・RTO / DR) + 30〜31 (Auto Scaling) + 32〜34 (ECS / SQS・Lambda / EventBridge・Batch) + 35〜38 (Route 53 / ACM 証明書 / CloudFront キャッシュ / WAF) + 39〜41 (コスト vs 可用性 vs セキュリティ / Organizations と SCP / IAM Identity Center)。地の文なし: パス博士 / ノード君の会話のみ。会話の文体ルールは `src/lessons/STYLE.md` |
| `src/diagram/` | React Flow + ELK の構成図。AWS 公式 Architecture Icons (`src/assets/aws/`, Icon package 07312026) |
| `src/db.ts` | Dexie (IndexedDB): 進捗とコンソール状態の保存 |
