# AWS Management Console Learning Simulator 開発ロードマップ

React + TypeScriptで、実際のAWS Management Consoleに高い再現度で近づけたWeb UIを操作しながら、AWSをステップバイステップで学習できるWebアプリケーションを開発してください。

本アプリは、

**GitHub Pagesへ静的デプロイして公開するPC専用SPA**

とします。

実AWSには一切接続しません。

以下は禁止します。

```text
AWS Account
AWS SDK
AWS API
Backend Server
External Database
SSR
Server Actions
Serverless Backend
Actual AWS Resources
```

すべて、

```text
React
TypeScript
Vite
IndexedDB
Browser-side Simulation
Static Assets
GitHub Pages
```

だけで完結させてください。

---

# 0. 最終ゴール

このサービスを学習したWebエンジニアが、実際のAWS Management Consoleを開いた際に、

```text
画面構成を理解できる

目的のServiceを探せる

Resourceを検索できる

Resource IDをCopy / Pasteできる

VPC / Subnet / Route Tableを設定できる

Security Groupを設定できる

EC2を設定できる

ALB / Target Groupを設定できる

RDSを設定できる

IAMを調査できる

CloudWatchから障害原因を絞れる

CloudTrailから変更履歴を追える

AWS構成図を読める

障害発生時に原因を切り分けられる
```

状態を目指してください。

---

# 1. 最重要方針

優先順位は以下です。

```text
★★★★★ AWS Management Console再現度

★★★★★ AWS Simulation精度

★★★★★ Step-by-Step学習体験

★★★★★ GitHub Pagesで完全動作

★★★★★ AWS仕様の正確性

★★★★★ 障害対応教材

★★★★☆ AWS公式Architecture Icons

★★★★☆ Copy / Paste / Search等の実務操作

★★★★☆ 構成図品質

★★★★☆ Security

★★★★☆ Observability

★★★☆☆ CLI / IaC参考知識

☆☆☆☆☆ Mobile対応
```

---

# 2. 開発方針

最初から大量のAWS Serviceを実装しないでください。

必ず、

```text
小さく完成
↓
E2Eで確認
↓
次のService追加
```

という順番で進めてください。

各Phaseは、

**前Phaseが完成条件を満たしてから次へ進む**

ことを基本としてください。

---

# Phase 0 — Project Foundation

最初にアプリ全体の土台だけを作ります。

AWS Service実装はまだ行いません。

---

## 0-1. Project作成

以下で開始してください。

```text
React
TypeScript
Vite
```

TypeScriptは、

```text
strict: true
```

を有効にしてください。

---

## 0-2. 最初に導入するLibrary

まず以下だけ導入してください。

```text
@cloudscape-design/components
@cloudscape-design/global-styles

@tanstack/react-router
またはGitHub Pagesに適したRouter

zustand

xstate
@xstate/react

dexie
dexie-react-hooks

zod

vitest
@testing-library/react
playwright
```

まだ不要なLibraryを大量導入しないでください。

---

## 0-3. GitHub Pages対応

最初の段階で、

```text
npm run build
```

した成果物がGitHub Pagesで動くようにしてください。

後回しにしないでください。

対応：

```text
Vite base path

Hash Routing
または404 fallback

Asset path

Browser reload

Direct access
```

---

## 0-4. GitHub Actions

最初から、

```text
main push
↓
npm ci
↓
lint
↓
typecheck
↓
test
↓
build
↓
GitHub Pages deploy
```

を構築してください。

Buildに失敗した場合はDeployしないでください。

---

## 0-5. 基本Navigation

この段階では、

```text
Courses
Progress
Prompt
```

だけで構いません。

---

## 0-6. Promptページ

最初から実装してください。

表示内容：

```text
この開発指示Prompt全文
```

機能：

```text
Copy Prompt
```

のみ。

不要：

```text
Edit
Delete
Search
Import
Export
複数Prompt
```

---

## Phase 0 完成条件

```text
GitHub Pagesで表示できる

Reloadしても壊れない

Navigationできる

Prompt全文をCopyできる

TypeScript Errorなし

Unit Test実行可能

Playwright実行可能
```

---

# Phase 1 — Learning UI Prototype

ここではAWS Serviceより先に、

**教材としての基本体験**

を完成させてください。

最初の題材は、

```text
Security Group
```

のダミーLessonで構いません。

---

## 1-1. パス博士 / ノード君

登場人物：

```text
パス博士
左側

ノード君
右側
```

会話は吹き出しで表示してください。

第一候補：

```text
@cloudscape-design/chat-components
```

---

## 1-2. 会話ルール

本文は、

**地の文0**

としてください。

例：

```text
ノード君：
Security GroupってFirewallなんですか？

パス博士：
大まかにはそう考えてよい。
だが通常のFirewallと少し違う点もあるのだ。
```

---

## 1-3. Lesson Renderer

LessonをReact Componentへ直接書かず、

```ts
type LessonContent =
  | DialogueContent
  | DiagramContent
  | TableContent
  | CodeContent
  | ConsoleExerciseContent
  | QuizContent;
```

のような構造化データとして描画してください。

---

## 1-4. Lesson State Machine

XStateで、

```text
Dialogue
↓
Exercise
↓
Validation
↓
Result
↓
Dialogue
```

を実装してください。

---

## 1-5. Beginner Tutorial UI

右側または補助Panelに、

```text
Step 2 / 5

Hint

Current objective
```

を表示してください。

Cloudscapeの、

```text
TutorialPanel
AnnotationContext
Hotspot
```

が利用可能なら積極的に使用してください。

---

## 1-6. Progress

Lessonについて、

```text
Not Started
In Progress
Completed
```

をDexieへ保存してください。

Reloadしても続きから開始できるようにしてください。

---

## Phase 1 完成条件

Security Groupについて、

```text
会話
↓
操作説明
↓
仮Console
↓
操作
↓
Validation
↓
会話
↓
Lesson Complete
```

が一通り動くこと。

この時点ではAWS Simulation精度は簡易実装で構いません。

---

# Phase 2 — AWS Management Console Shell

次にAWS風Management Consoleの基盤を作ります。

---

## 2-1. Cloudscape Layout

基本UI：

```text
Top Navigation

Side Navigation

Breadcrumb

Page Header

Content

Learning Panel
```

を構築してください。

---

## 2-2. PC専用Layout

基本：

```text
┌──────────────────────────────────────────────────┐
│ AWS風 Top Navigation                  Region ▼   │
├─────────────┬──────────────────────┬─────────────┤
│ Service Nav │ Management Console   │ Lesson      │
│             │                      │ Panel       │
│             │                      │             │
└─────────────┴──────────────────────┴─────────────┘
```

スマートフォン対応は不要です。

---

## 2-3. Console基本Component

共通化してください。

```text
ResourceTable

ResourceDetail

ResourceTabs

CreateWizard

EditForm

StatusIndicator

CopyableValue

ResourceSearch

ActionMenu
```

---

## 2-4. Copy Component

以下のようなUIを共通Component化してください。

```text
sg-0123456789abcdef0    [Copy]
```

コピー後：

```text
Copied
```

を表示。

---

## 2-5. Search / Filter

Cloudscapeの、

```text
Table
PropertyFilter
Pagination
collection-hooks
```

等を利用して、

```text
Search
Filter
Sort
Pagination
```

を共通化してください。

---

## Phase 2 完成条件

Dummy Resourceを使って、

```text
一覧
↓
検索
↓
Resource選択
↓
Detail
↓
Edit
↓
Save
↓
Copy
```

がAWS Management Console風UIで動作すること。

---

# Phase 3 — VPC Simulation Core

最初の本格的AWS Serviceとして、

**VPC**

から実装してください。

---

## 3-1. Domain Model

最低限、

```text
VPC
Subnet
Route Table
Internet Gateway
Security Group
```

をTypeScriptのDomain Modelとして定義してください。

---

## 3-2. VPC画面

実AWSを参考に、

```text
Your VPCs

Subnets

Route Tables

Internet Gateways

Security Groups
```

を実装してください。

---

## 3-3. CIDR

導入：

```text
ipaddr.js
```

以下を判定してください。

```text
Valid CIDR

Subnet belongs to VPC

CIDR overlap
```

---

## 3-4. Route Table Simulation

実装：

```ts
evaluateRoute()
```

例：

```text
0.0.0.0/0
→ Internet Gateway
```

を評価してください。

---

## 3-5. Public Subnet判定

```ts
isPublicSubnet()
```

を実装。

Subnet名で判定してはいけません。

Routing条件から判定してください。

---

## 3-6. 最初の本格Lesson

Lesson：

```text
Public Subnetとは？
```

学習：

```text
会話
↓
VPC Console
↓
Route Table
↓
Edit routes
↓
0.0.0.0/0 → IGW
↓
Save
↓
Private → Public
↓
理由を会話で確認
```

---

## Phase 3 完成条件

ユーザーがManagement Console風UIからRoute Tableを変更すると、

Simulation Engineが、

```text
Private
↓
Public
```

を正しく判定すること。

---

# Phase 4 — Security Group Simulation

次にSecurity Groupを本格実装します。

---

## 4-1. SG Domain

```text
Inbound Rule

Outbound Rule

Protocol

Port

CIDR

Security Group Reference
```

---

## 4-2. Security Group Engine

```ts
evaluateSecurityGroup()
canConnect()
```

を実装してください。

---

## 4-3. SG Console

実AWSに近い、

```text
Security Groups

Details

Inbound rules

Outbound rules

Tags

Edit inbound rules
```

を再現してください。

---

## 4-4. Copy / Paste Lesson

最重要Lessonの1つです。

```text
ALB SG IDをCopy

↓

EC2 SGを開く

↓

Inbound rules

↓

Edit inbound rules

↓

SourceへPaste

↓

Save
```

まで操作させてください。

---

## Phase 4 完成条件

以下を判定できること。

```text
TCP 3000
Source sg-alb
```

なら通信可能。

```text
TCP 3001
```

なら通信不可。

---

# Phase 5 — EC2

次にEC2です。

---

## 5-1. EC2 Console

実装：

```text
Instances

Launch instances

Instance detail

Networking

Security

Monitoring
```

---

## 5-2. Instance State

```text
Pending
Running
Stopping
Stopped
Terminated
```

をシミュレーションしてください。

---

## 5-3. EC2とSubnet

EC2が、

```text
どのVPC

どのSubnet

どのSecurity Group
```

に属しているかSimulation Engineと連携してください。

---

## Phase 5 完成条件

```text
VPC
↓
Subnet
↓
EC2
↓
Security Group
```

の関係を管理画面から辿れること。

---

# Phase 6 — ALB / Target Group

Web Application通信を完成させます。

---

## 6-1. Load Balancer

実装：

```text
Load Balancers

Scheme

VPC

Subnet

Security Groups

Listeners
```

---

## 6-2. Target Group

実装：

```text
Target Groups

Target Type

Protocol

Port

Registered Targets

Health Check
```

---

## 6-3. Health Check Engine

```ts
isTargetHealthy()
```

を実装。

最低限、

```text
EC2 Running

Target登録済

Port一致

Security Group許可
```

を評価してください。

---

## 6-4. 初めての障害Lesson

症状：

```text
502 Bad Gateway
```

または、

```text
Target Unhealthy
```

ユーザーが、

```text
Load Balancer
↓
Target Groups
↓
Target Health
↓
Security Group
```

を調査。

修正すると復旧。

---

## Phase 6 完成条件

```text
Internet
↓
ALB
↓
EC2
```

の通信成立 / 不成立を説明できること。

---

# Phase 7 — RDS

Web Applicationの基本構成を完成させます。

---

## 7-1. RDS Console

```text
Databases

Create database

Connectivity

Security

Monitoring

Backup
```

---

## 7-2. RDS Simulation

最低限、

```text
Engine
VPC
Subnet Group
Security Group
Public Access
Status
```

を扱ってください。

---

## 7-3. EC2 → RDS

```ts
canConnect()
```

で、

```text
EC2
↓ TCP 3306
RDS
```

を判定してください。

---

## 7-4. Troubleshooting

症状：

```text
Application cannot connect to database
```

ユーザーが、

```text
RDS
↓
Connectivity
↓
Security Group
↓
Inbound Rule
```

を確認。

---

## Phase 7 完成条件

```text
Internet
↓
ALB
↓
EC2
↓
RDS
```

というWeb Application構成が一通りシミュレーションできること。

---

# Phase 8 — AWS Architecture Diagram

ここで初めてReact Flowを導入してください。

それ以前は必須ではありません。

---

## 8-1. Library

```text
@xyflow/react
elkjs
```

を導入してください。

---

## 8-2. AWS公式Architecture Icons

AWS公式のArchitecture Icon Packageを使用してください。

SVGは、

```text
src/assets/aws/
```

へ保存。

外部Hotlinkは禁止。

---

## 8-3. Icon Registry

```ts
AWS_ICONS.ec2
AWS_ICONS.rds
AWS_ICONS.alb
```

のように使用できるRegistryを作ってください。

---

## 8-4. 最初のDiagram

まず、

```text
Internet
↓
ALB
↓
EC2
↓
RDS
```

だけを実装してください。

---

## 8-5. VPC Group

次に、

```text
VPC

├ Public Subnet
│  └ ALB
│
└ Private Subnet
   ├ EC2
   └ RDS
```

を実装してください。

---

## 8-6. Collision Engine

必須：

```text
Node overlap = 0

Label overlap = 0

Edge Label overlap = 0

Group Label overlap = 0
```

---

## 8-7. Layout Pipeline

```text
Node生成
↓
Nodeサイズ計測
↓
Group計算
↓
ELK
↓
Collision Check
↓
Edge Routing
↓
Label Placement
↓
Final Validation
```

---

## Phase 8 完成条件

長いResource名や複数Nodeでも、

```text
Node
Text
Edge
Label
Group
```

が重ならないこと。

---

# Phase 9 — S3 / IAM

ここからSecurity領域を広げます。

---

## 9-1. S3

```text
Buckets
Objects
Permissions
Block Public Access
Bucket Policy
Versioning
Encryption
```

---

## 9-2. IAM

```text
Users
Roles
Policies
Trust Policy
Identity Policy
Resource Policy
Explicit Deny
```

---

## 9-3. IAM Engine

```ts
evaluateIamPermission()
```

を実装。

---

## 9-4. AccessDenied Lesson

例：

```text
EC2からS3へアクセス

↓

AccessDenied
```

ユーザーが、

```text
EC2 Role
↓
IAM Policy
↓
S3 Policy
```

を追う。

---

# Phase 10 — CloudWatch / Observability

本番運用能力へ進みます。

---

## 10-1. Chart

導入：

```text
recharts
```

Cloudscapeを外枠に使用。

---

## 10-2. Metrics

最低限：

```text
EC2 CPUUtilization

ALB TargetResponseTime

RDS CPUUtilization

RDS DatabaseConnections

RDS FreeStorageSpace
```

---

## 10-3. CloudWatch Logs

仮想Logを用意してください。

---

## 10-4. 障害Lesson

例：

```text
アプリが遅い
```

↓

```text
ALB Response Time ↑
EC2 CPU正常
RDS CPU 95%
```

↓

```text
RDSが原因
```

と判断。

---

# Phase 11 — CloudTrail / AWS Config

運用調査能力を追加します。

---

## 11-1. CloudTrail

仮想Event：

```text
誰が
いつ
どのAction
どのResource
```

を保持してください。

---

## 11-2. Lesson

```text
昨日からEC2へ接続できない
```

↓

CloudTrailで、

```text
RevokeSecurityGroupIngress
```

を発見。

---

## 11-3. AWS Config

Compliance：

```text
COMPLIANT
NON_COMPLIANT
```

を扱ってください。

---

# Phase 12 — Backup / Restore / DR

Reliabilityを追加します。

---

## 12-1. RDS Snapshot

```text
Snapshot
Restore
New RDS
Endpoint
```

---

## 12-2. RPO / RTO

会話教材で説明してください。

---

## 12-3. DR

上級教材：

```text
Backup and Restore
Pilot Light
Warm Standby
Multi-site
```

---

# Phase 13 — Auto Scaling

---

## 13-1. Auto Scaling Group

```text
Minimum
Desired
Maximum
Target Tracking
```

---

## 13-2. Traffic Simulation

```text
100 req/s
↓
2 instances

1000 req/s
↓
CPU 80%
↓
4 instances
↓
CPU 45%
```

を可視化してください。

---

# Phase 14 — Containers / Async

ここまで来てから、

```text
ECR
ECS
Fargate
Lambda
SQS
EventBridge
AWS Batch
```

を追加してください。

初期Phaseでは実装しないでください。

---

# Phase 15 — DNS / CDN / Security Edge

追加：

```text
Route 53
ACM
CloudFront
WAF
```

---

## Lesson例

```text
DNS misconfiguration

Certificate problem

CloudFront cache issue

WAF blocked request
```

など。

---

# Phase 16 — Cost / Multi-account / Advanced

最後に上級設計領域を追加してください。

---

## Cost

```text
EC2
RDS
ALB
NAT Gateway
Data Transfer
Logging
Backup
```

を、

```text
Cost
vs
Availability
vs
Security
```

のTrade-offとして教えてください。

---

## Multi-account

```text
AWS Organizations
OU
SCP
Production
Staging
Development
Security
IAM Identity Center
```

---

# 17. 各Phase共通の完成条件

各Phaseでは、

```text
Domain Logic

AWS Management Console UI

Lesson

Simulation

Validation

Unit Test

E2E Test
```

まで揃えてください。

UIだけ作って次へ進まないでください。

---

# 18. 各AWS Serviceの実装テンプレート

新しいServiceを追加する際は、基本的に、

```text
1. AWS公式仕様確認

2. AWS Management Console UI確認

3. Domain Model

4. Simulation Logic

5. Console UI

6. Beginner Lesson

7. Intermediate Lesson

8. Troubleshooting Lesson

9. Unit Test

10. Playwright E2E
```

の順で進めてください。

---

# 19. Lesson作成優先順位

各Serviceで、

```text
① Concept

② 基本設定

③ よくある誤解

④ 実Console操作

⑤ 設定結果

⑥ Troubleshooting
```

まで作ってから次Serviceへ進んでください。

---

# 20. 最初に作るLesson一覧

MVPでは最低限以下を完成させてください。

```text
01 AWSとは

02 Region / Availability Zone

03 VPCとは

04 CIDRとは

05 Subnetとは

06 Public / Private Subnet

07 Route Table

08 Internet Gateway

09 Security Group

10 EC2

11 ALB

12 Target Group

13 Health Check

14 RDS

15 Web Application Connectivity

16 Security Group Troubleshooting

17 Target Unhealthy Troubleshooting

18 EC2 → RDS Troubleshooting
```

---

# 21. MVPの最終課題

MVP最後には、

```text
Internet
↓
ALB
↓
EC2
↓
RDS
```

という構成を題材にした総合Lessonを作ってください。

ただしSandboxではありません。

Lesson側で初期環境を用意します。

ユーザーはManagement Consoleから必要な設定を行います。

---

# 22. MVP総合Lesson例

初期状態：

```text
ALB → EC2
Blocked

EC2 → RDS
Blocked
```

ユーザーが、

```text
ALB Security Group確認

↓

SG ID Copy

↓

EC2 Security Groupへ移動

↓

Inbound Rule修正

↓

ALB → EC2 Connected
```

次に、

```text
RDS Security Group確認

↓

EC2 SGをSourceに設定

↓

EC2 → RDS Connected
```

最終的に、

```text
Internet
↓
ALB
↓
EC2
↓
RDS

ALL CONNECTED
```

となります。

---

# 23. MVP完成条件

Phase 0〜8程度までで、

最低限以下を満たしてください。

```text
GitHub Pagesで動く

Reload可能

Course開始可能

パス博士 / ノード君の会話

Management Console操作

VPC

Subnet

Route Table

Internet Gateway

Security Group

EC2

ALB

Target Group

RDS

Copy / Paste

Search

Simulation

Troubleshooting

AWS公式Architecture Icons

React Flow Diagram

Diagram Collision回避

Progress保存

Prompt Copy
```

---

# 24. 開発時の優先判断

迷った場合は、

```text
この機能は実際のAWS業務へ移ったとき役立つか？
```

を基準にしてください。

例えば、

```text
豪華なAnimation
```

より、

```text
Resource ID Copy

Search

Security Group調査

CloudWatch調査

Target Health確認
```

を優先してください。

---

# 25. 実装を急がない領域

初期段階では以下を後回しにしてください。

```text
ECS
EKS
Lambda
SQS
EventBridge
Batch
CloudFront
WAF
Organizations
Control Tower
Advanced DR
Advanced Cost Optimization
Terraform
```

まず、

```text
VPC
EC2
ALB
RDS
```

を完璧にしてください。

---

# 26. GitHub Pages完成条件

最終的に以下を確認してください。

```text
GitHub Pagesから表示

Subpath Asset正常

Browser Reload正常

AWS Icon正常

Lesson正常

Simulation正常

IndexedDB正常

React Flow正常

Copy / Paste正常

Prompt Copy正常

Build失敗時Deployなし
```

---

# 27. 最終的な開発順

最重要順に並べると、

```text
Phase 0
GitHub Pages / Project Foundation

↓

Phase 1
Dialogue / Lesson Engine

↓

Phase 2
AWS Management Console Shell

↓

Phase 3
VPC / Subnet / Route Table / IGW

↓

Phase 4
Security Group

↓

Phase 5
EC2

↓

Phase 6
ALB / Target Group

↓

Phase 7
RDS

↓

Phase 8
AWS Architecture Diagram

↓

Phase 9
IAM / S3

↓

Phase 10
CloudWatch

↓

Phase 11
CloudTrail / Config

↓

Phase 12
Backup / DR

↓

Phase 13
Auto Scaling

↓

Phase 14
ECS / Lambda / SQS / EventBridge / Batch

↓

Phase 15
Route 53 / ACM / CloudFront / WAF

↓

Phase 16
Cost / Multi-account / Advanced
```

この順番を基本としてください。

特に、

**Phase 3〜7のWeb Application基盤を高品質に完成させるまでは、AWS Serviceを横に増やしすぎない**

ことを重要ルールとします。

最初の大きな到達点は、

**実AWSを一切使わず、GitHub Pages上だけで、VPC → ALB → EC2 → RDSの構成と通信トラブルをAWS Management Console風UIから学習・操作・修復できる状態**

です。
