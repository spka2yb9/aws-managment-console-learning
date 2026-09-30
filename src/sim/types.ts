// Domain model of the simulated AWS account. Field names follow the EC2 / ELBv2 / RDS API shapes
// (camelCased) so what learners see in the console matches what they will later see in the CLI/SDK.
// The whole AwsEnv is plain JSON: it is structuredClone'd on every mutation and persisted to IndexedDB.

export interface Tag {
  key: string;
  value: string;
}

export interface Tagged {
  tags: Tag[];
}

export interface Vpc extends Tagged {
  vpcId: string;
  cidrBlock: string;
  state: 'available';
  isDefault: boolean;
  instanceTenancy: 'default';
  enableDnsSupport: boolean;
  enableDnsHostnames: boolean;
  dhcpOptionsId: string;
  /** The VPC's default network ACL (allows all traffic until edited). */
  defaultNetworkAclId: string;
}

export interface Subnet extends Tagged {
  subnetId: string;
  vpcId: string;
  cidrBlock: string;
  availabilityZone: string;
  mapPublicIpOnLaunch: boolean;
  state: 'available';
}

export interface Route {
  /** '' for a gateway endpoint route (it has destinationPrefixListId instead) */
  destinationCidrBlock: string;
  /** 'local' for the VPC route, an internet gateway id, or a gateway endpoint (vpce-) id. */
  gatewayId?: string;
  natGatewayId?: string;
  /** the AWS-managed prefix list of a gateway endpoint (S3: pl-61a54008) */
  destinationPrefixListId?: string;
  origin: 'CreateRouteTable' | 'CreateRoute' | 'CreateVpcEndpoint';
}

export interface NatGateway extends Tagged {
  natGatewayId: string;
  vpcId: string;
  subnetId: string;
  state: 'pending' | 'available' | 'deleting' | 'deleted';
  stateChangedAt: number;
  publicIp: string;
  privateIp: string;
  createTime: number;
}

/** Gateway endpoint (S3): route tables send S3 traffic to it instead of the NAT gateway / IGW. */
export interface VpcEndpoint extends Tagged {
  vpcEndpointId: string;
  vpcId: string;
  serviceName: string;
  type: 'Gateway';
  routeTableIds: string[];
  state: 'available';
  createdAt: number;
}

/** Simulator assumption for cost: a steady stream of data from a subnet (per month). */
export interface DataFlow {
  name: string;
  /** Name tag of the instance that sends it: no traffic while it is not running */
  source?: string;
  subnetId: string;
  destination: 's3' | 'internet';
  gbPerMonth: number;
}

export interface RouteTableAssociation {
  routeTableAssociationId: string;
  main: boolean;
  subnetId?: string;
}

export interface RouteTable extends Tagged {
  routeTableId: string;
  vpcId: string;
  routes: Route[];
  associations: RouteTableAssociation[];
}

export interface InternetGateway extends Tagged {
  internetGatewayId: string;
  attachments: { vpcId: string; state: 'available' }[];
}

/** '-1' = all traffic (all protocols, all ports). */
export type IpProtocol = 'tcp' | 'udp' | 'icmp' | '-1';

export interface SecurityGroupRule {
  securityGroupRuleId: string;
  ipProtocol: IpProtocol;
  /** -1 for all traffic / all ICMP. */
  fromPort: number;
  toPort: number;
  /** Exactly one of cidrIpv4 / referencedGroupId is set. */
  cidrIpv4?: string;
  referencedGroupId?: string;
  description?: string;
}

/**
 * Network ACL entry. Evaluated per direction in ascending ruleNumber order; the first entry whose protocol,
 * port range and CIDR match decides (allow / deny). No match = the implicit "*" rule: deny.
 */
export interface NetworkAclEntry {
  ruleNumber: number;
  egress: boolean;
  protocol: IpProtocol;
  ruleAction: 'allow' | 'deny';
  cidrBlock: string;
  /** tcp / udp only */
  fromPort?: number;
  toPort?: number;
}

export interface NetworkAcl extends Tagged {
  networkAclId: string;
  vpcId: string;
  isDefault: boolean;
  entries: NetworkAclEntry[];
  /** every subnet is associated with exactly one network ACL of its VPC */
  associations: { networkAclAssociationId: string; subnetId: string }[];
}

export interface SecurityGroup extends Tagged {
  groupId: string;
  groupName: string;
  description: string;
  vpcId: string;
  ingress: SecurityGroupRule[];
  egress: SecurityGroupRule[];
}

export type InstanceStateName = 'pending' | 'running' | 'stopping' | 'stopped' | 'shutting-down' | 'terminated';

/** What the simulated workload on an instance does. Not an AWS attribute: lessons describe it in dialogue. */
export interface SimulatedApp {
  port: number;
  healthCheckPath: string;
  /** shown in the response body (container images: the image version) */
  version?: string;
  /** The app queries this DB on every request; unreachable DB => HTTP 500. */
  dbInstanceIdentifier?: string;
}

export interface Instance extends Tagged {
  instanceId: string;
  imageId: string;
  instanceType: string;
  state: InstanceStateName;
  /** epoch ms of the last state change; drives pending->running etc. */
  stateChangedAt: number;
  vpcId: string;
  subnetId: string;
  availabilityZone: string;
  privateIpAddress: string;
  associatePublicIpAddress: boolean;
  publicIpAddress?: string;
  securityGroupIds: string[];
  keyName?: string;
  launchTime: string;
  platformDetails: string;
  app?: SimulatedApp;
  /** attached IAM instance profile (the role the instance's credentials come from) */
  iamInstanceProfileArn?: string;
  /** files in ec2-user's home directory (scripts, ~/.my.cnf ...) */
  homeFiles?: Record<string, string>;
  /** detailed monitoring: 1-minute CloudWatch metrics instead of 5-minute */
  detailedMonitoring?: boolean;
}

export interface Listener {
  listenerArn: string;
  protocol: 'HTTP';
  port: number;
  /** default action: forward */
  targetGroupArn: string;
}

export interface LoadBalancer {
  loadBalancerArn: string;
  loadBalancerName: string;
  dnsName: string;
  type: 'application';
  scheme: 'internet-facing' | 'internal';
  ipAddressType: 'ipv4';
  vpcId: string;
  state: 'provisioning' | 'active';
  stateChangedAt: number;
  createdTime: string;
  /** subnet ids, one per AZ. The LB node in each subnet gets the private IP in nodeIps. */
  subnetIds: string[];
  nodeIps: Record<string, string>;
  securityGroupIds: string[];
  listeners: Listener[];
}

export interface HealthCheck {
  protocol: 'HTTP';
  port: 'traffic-port' | number;
  path: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  healthyThresholdCount: number;
  unhealthyThresholdCount: number;
  matcher: string;
}

export interface RegisteredTarget {
  id: string;
  port: number;
}

export interface TargetGroup {
  targetGroupArn: string;
  targetGroupName: string;
  /** instance = EC2 instance ids; ip = IP addresses (Fargate tasks) */
  targetType: 'instance' | 'ip';
  protocol: 'HTTP';
  protocolVersion: 'HTTP1';
  port: number;
  vpcId: string;
  healthCheck: HealthCheck;
  targets: RegisteredTarget[];
}

export interface DbSubnetGroup {
  dbSubnetGroupName: string;
  description: string;
  vpcId: string;
  subnetIds: string[];
}

export type DbEngine = 'mysql' | 'postgres';
export type DbStatus = 'creating' | 'backing-up' | 'available' | 'modifying' | 'renaming' | 'stopping' | 'stopped' | 'starting' | 'deleting';

export interface DbInstance extends Tagged {
  dbInstanceIdentifier: string;
  dbiResourceId: string;
  engine: DbEngine;
  engineVersion: string;
  dbInstanceClass: string;
  status: DbStatus;
  statusChangedAt: number;
  masterUsername: string;
  dbName?: string;
  allocatedStorage: number;
  storageType: 'gp3' | 'gp2' | 'io1';
  storageEncrypted: boolean;
  port: number;
  endpointAddress: string;
  dbSubnetGroupName: string;
  vpcSecurityGroupIds: string[];
  publiclyAccessible: boolean;
  multiAZ: boolean;
  availabilityZone: string;
  /** subnet / IP of the primary's network interface (chosen from the subnet group). */
  subnetId: string;
  privateIpAddress: string;
  backupRetentionPeriod: number;
  preferredBackupWindow: string;
  instanceCreateTime: string;
  /** set when the class changes, so metrics before the change keep the old capacity */
  previousInstanceClass?: string;
  instanceClassChangedAt?: number;
  /** simulated contents: row counts per table over time (newest last); snapshots and point-in-time restores copy from it */
  data?: DbData[];
}

export interface DbData {
  at: number;
  tables: Record<string, number>;
}

export interface DbSnapshot {
  dbSnapshotIdentifier: string;
  dbSnapshotArn: string;
  dbInstanceIdentifier: string;
  snapshotType: 'manual' | 'automated';
  status: 'creating' | 'available';
  statusChangedAt: number;
  snapshotCreateTime: string;
  engine: DbEngine;
  engineVersion: string;
  masterUsername: string;
  dbName?: string;
  allocatedStorage: number;
  encrypted: boolean;
  availabilityZone: string;
  vpcId: string;
  port: number;
  /** the data at snapshot time */
  tables: Record<string, number>;
}

export interface AwsEnv {
  accountId: string;
  /** Region the resources live in. The console region selector may point elsewhere (and then shows nothing). */
  region: string;
  vpcs: Vpc[];
  subnets: Subnet[];
  routeTables: RouteTable[];
  internetGateways: InternetGateway[];
  networkAcls: NetworkAcl[];
  securityGroups: SecurityGroup[];
  keyPairs: string[];
  instances: Instance[];
  loadBalancers: LoadBalancer[];
  targetGroups: TargetGroup[];
  dbSubnetGroups: DbSubnetGroup[];
  dbInstances: DbInstance[];
  /** manual DB snapshots (automated ones are derived from each instance's backup settings) */
  dbSnapshots: DbSnapshot[];
  /** IAM is global: users / roles / customer managed policies / instance profiles of the account */
  iamUsers: IamUser[];
  iamRoles: IamRole[];
  iamPolicies: ManagedPolicy[];
  instanceProfiles: InstanceProfile[];
  /** S3 buckets of the account (each lives in one Region, the console lists all of them) */
  buckets: Bucket[];
  /** CloudWatch (regional). Metrics and log events are not stored: they are generated from the env and these incidents. */
  incidents: Incident[];
  alarms: MetricAlarm[];
  logGroups: LogGroup[];
  /** CloudTrail event history (management events, newest last) */
  trailEvents: TrailEvent[];
  /** AWS Config rules; evaluations are computed from the current env */
  configRules: ConfigRule[];
  launchTemplates: LaunchTemplate[];
  autoScalingGroups: AutoScalingGroup[];
  /** load test settings of the simulator (newest last); none = normal daily traffic */
  traffic: TrafficSetting[];
  ecrRepositories: EcrRepository[];
  ecsClusters: EcsCluster[];
  taskDefinitions: TaskDefinition[];
  ecsServices: EcsService[];
  ecsTasks: EcsTask[];
  sqsQueues: SqsQueue[];
  lambdaFunctions: LambdaFunction[];
  eventSourceMappings: EventSourceMapping[];
  computeEnvironments: ComputeEnvironment[];
  jobQueues: JobQueue[];
  jobDefinitions: JobDefinition[];
  batchJobs: BatchJob[];
  eventRules: EventRule[];
  hostedZones: HostedZone[];
  certificates: Certificate[];
  distributions: Distribution[];
  webAcls: WebAcl[];
  ipSets: IpSet[];
  natGateways: NatGateway[];
  vpcEndpoints: VpcEndpoint[];
  dataFlows: DataFlow[];
  /** AWS Budgets: a monthly cost budget */
  budgets: { budgetName: string; limitUsd: number }[];
  /** AWS Organizations, seen from the management account (this env's account) */
  organization?: Organization;
  identityCenter?: IdentityCenter;
}

// ---------------- Organizations / IAM Identity Center ----------------

export interface OrgAccount {
  id: string;
  name: string;
  email: string;
  /** root or OU id */
  parentId: string;
  joinedAt: number;
}

export interface OrgUnit {
  id: string;
  arn: string;
  name: string;
  parentId: string;
}

/** a service control policy */
export interface OrgPolicy {
  id: string;
  arn: string;
  name: string;
  description?: string;
  awsManaged: boolean;
  document: PolicyDocument;
  /** root / OU / account ids it is attached to */
  targets: string[];
}

export interface Organization {
  id: string;
  arn: string;
  managementAccountId: string;
  rootId: string;
  ous: OrgUnit[];
  accounts: OrgAccount[];
  policies: OrgPolicy[];
}

export interface SsoUser {
  userName: string;
  displayName: string;
  email: string;
  groups: string[];
}

export interface PermissionSet {
  name: string;
  arn: string;
  description?: string;
  managedPolicyArns: string[];
  sessionDuration: string;
  createdAt: number;
}

export interface AccountAssignment {
  accountId: string;
  permissionSetArn: string;
  principalType: 'USER' | 'GROUP';
  principalName: string;
}

export interface IdentityCenter {
  instanceArn: string;
  identityStoreId: string;
  region: string;
  users: SsoUser[];
  groups: { groupName: string; description?: string }[];
  permissionSets: PermissionSet[];
  assignments: AccountAssignment[];
}

// ---------------- Route 53 / ACM / CloudFront / WAF ----------------

export interface DnsRecord {
  /** fully qualified, lower case, without the trailing dot */
  name: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SOA';
  ttl?: number;
  values: string[];
  /** alias A record: an AWS resource's DNS name (ALB, CloudFront distribution, S3 website) */
  aliasTarget?: string;
}

export interface HostedZone {
  id: string;
  /** apex, e.g. webapp-shop.example */
  name: string;
  comment?: string;
  records: DnsRecord[];
  createdAt: number;
}

export interface Certificate {
  certificateArn: string;
  domainName: string;
  subjectAlternativeNames: string[];
  /** ACM is regional; CloudFront only accepts certificates from us-east-1 */
  region: string;
  status: 'PENDING_VALIDATION' | 'ISSUED';
  validation: { domainName: string; cnameName: string; cnameValue: string }[];
  createdAt: number;
  issuedAt?: number;
}

export interface CachedObject {
  path: string;
  status: number;
  body: string;
  cachedAt: number;
}

export interface Distribution {
  id: string;
  arn: string;
  domainName: string;
  comment?: string;
  enabled: boolean;
  status: 'InProgress' | 'Deployed';
  statusChangedAt: number;
  /** "alternate domain names (CNAMEs)" */
  aliases: string[];
  certificateArn?: string;
  origin: { kind: 's3'; bucket: string } | { kind: 'alb'; loadBalancerName: string };
  viewerProtocolPolicy: 'allow-all' | 'redirect-to-https' | 'https-only';
  /** seconds the edge keeps an object (cache policy default TTL) */
  defaultTtl: number;
  webAclArn?: string;
  cache: CachedObject[];
  invalidations: { id: string; paths: string[]; status: 'InProgress' | 'Completed'; createdAt: number }[];
  lastModified: number;
}

export interface WafRule {
  name: string;
  priority: number;
  action: 'Block' | 'Allow' | 'Count';
  statement: { kind: 'ip-set'; ipSetArn: string } | { kind: 'managed'; vendor: 'AWS'; name: string } | { kind: 'uri-starts-with'; value: string };
}

export interface WebAcl {
  name: string;
  arn: string;
  scope: 'CLOUDFRONT' | 'REGIONAL';
  defaultAction: 'Allow' | 'Block';
  rules: WafRule[];
  /** the last requests it saw (the console's "sampled requests") */
  samples: { at: number; clientIp: string; method: string; uri: string; host: string; rule?: string; action: 'ALLOW' | 'BLOCK' | 'COUNT' }[];
}

export interface IpSet {
  name: string;
  arn: string;
  scope: 'CLOUDFRONT' | 'REGIONAL';
  description?: string;
  addresses: string[];
}

// ---------------- AWS Batch / EventBridge ----------------

export interface ComputeEnvironment {
  computeEnvironmentName: string;
  computeEnvironmentArn: string;
  type: 'MANAGED';
  resourceType: 'FARGATE';
  maxvCpus: number;
  subnets: string[];
  securityGroupIds: string[];
  state: 'ENABLED' | 'DISABLED';
  status: 'VALID';
}

export interface JobQueue {
  jobQueueName: string;
  jobQueueArn: string;
  priority: number;
  state: 'ENABLED' | 'DISABLED';
  computeEnvironmentOrder: string[];
}

export interface JobDefinition {
  jobDefinitionName: string;
  revision: number;
  jobDefinitionArn: string;
  image: string;
  vcpus: string;
  memory: string;
  command: string[];
  jobRoleArn?: string;
  executionRoleArn?: string;
  /** what the container does (the simulator's model of its code) */
  behavior: 'daily-report';
}

export type BatchJobStatus = 'SUBMITTED' | 'PENDING' | 'RUNNABLE' | 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

export interface BatchJob {
  jobId: string;
  jobName: string;
  jobArn: string;
  jobQueue: string;
  jobDefinition: string;
  status: BatchJobStatus;
  statusChangedAt: number;
  statusReason?: string;
  exitCode?: number;
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  logStreamName?: string;
  /** who submitted it (a user, or an EventBridge rule) */
  submittedBy: string;
}

export interface EventRule {
  name: string;
  arn: string;
  description?: string;
  /** rate(...) or cron(...) (UTC) */
  scheduleExpression: string;
  state: 'ENABLED' | 'DISABLED';
  targets: { id: string; arn: string; jobDefinition: string; jobName: string }[];
  createdAt: number;
  /** the scheduler has fired every occurrence up to here */
  evaluatedUntil: number;
}

// ---------------- SQS / Lambda ----------------

export interface SqsMessage {
  messageId: string;
  body: string;
  md5OfBody: string;
  sentAt: number;
  receiveCount: number;
  /** in flight until then (visibility timeout); visible when <= now */
  visibleAt: number;
}

export interface SqsQueue {
  queueName: string;
  queueUrl: string;
  queueArn: string;
  /** seconds */
  visibilityTimeout: number;
  messageRetentionPeriod: number;
  redrivePolicy?: { deadLetterTargetArn: string; maxReceiveCount: number };
  createdAt: number;
  messages: SqsMessage[];
}

/** what the function's code does (the simulator runs this model instead of the code shown in the editor) */
export type LambdaBehavior = 'order-processor';

export interface LambdaFunction {
  functionName: string;
  functionArn: string;
  runtime: string;
  handler: string;
  roleArn: string;
  /** seconds */
  timeout: number;
  memorySize: number;
  environment: Record<string, string>;
  code: string;
  behavior: LambdaBehavior;
  lastModified: number;
}

export interface EventSourceMapping {
  uuid: string;
  functionName: string;
  eventSourceArn: string;
  batchSize: number;
  enabled: boolean;
  lastProcessingResult: string;
  createdAt: number;
}

// ---------------- ECR / ECS ----------------

export interface EcrImage {
  imageTags: string[];
  imageDigest: string;
  pushedAt: number;
  sizeInBytes: number;
  /** what the image runs when started (the simulator's stand-in for the container's code) */
  app: SimulatedApp;
}

export interface EcrRepository {
  repositoryName: string;
  repositoryArn: string;
  repositoryUri: string;
  createdAt: number;
  images: EcrImage[];
}

export interface EcsCluster {
  clusterName: string;
  clusterArn: string;
  createdAt: number;
}

export interface ContainerDefinition {
  name: string;
  image: string;
  essential: boolean;
  portMappings: { containerPort: number; protocol: 'tcp' }[];
  environment: { name: string; value: string }[];
}

export interface TaskDefinition {
  family: string;
  revision: number;
  taskDefinitionArn: string;
  cpu: string;
  memory: string;
  networkMode: 'awsvpc';
  requiresCompatibilities: ['FARGATE'];
  executionRoleArn?: string;
  taskRoleArn?: string;
  containerDefinitions: ContainerDefinition[];
  status: 'ACTIVE' | 'INACTIVE';
  registeredAt: number;
}

export interface EcsDeployment {
  id: string;
  status: 'PRIMARY' | 'ACTIVE';
  taskDefinition: string;
  rolloutState: 'IN_PROGRESS' | 'COMPLETED';
  createdAt: number;
}

export interface EcsService {
  serviceName: string;
  serviceArn: string;
  clusterArn: string;
  taskDefinition: string;
  desiredCount: number;
  launchType: 'FARGATE';
  subnets: string[];
  securityGroups: string[];
  assignPublicIp: 'ENABLED' | 'DISABLED';
  loadBalancers: { targetGroupArn: string; containerName: string; containerPort: number }[];
  healthCheckGracePeriodSeconds: number;
  deployments: EcsDeployment[];
  /** newest first */
  events: { id: string; createdAt: number; message: string }[];
  createdAt: number;
  /** when the scheduler may try again after tasks failed to start */
  retryAt?: number;
}

export type EcsTaskStatus = 'PROVISIONING' | 'PENDING' | 'RUNNING' | 'DEPROVISIONING' | 'STOPPED';

export interface EcsTask {
  taskArn: string;
  clusterArn: string;
  /** service:NAME for service tasks */
  group: string;
  taskDefinitionArn: string;
  lastStatus: EcsTaskStatus;
  desiredStatus: 'RUNNING' | 'STOPPED';
  statusChangedAt: number;
  subnetId: string;
  availabilityZone: string;
  privateIpAddress: string;
  securityGroupIds: string[];
  createdAt: number;
  startedAt?: number;
  stoppedAt?: number;
  stopCode?: 'TaskFailedToStart' | 'EssentialContainerExited' | 'ServiceSchedulerInitiated' | 'UserInitiated';
  stoppedReason?: string;
  containers: { name: string; image: string; lastStatus: 'PENDING' | 'RUNNING' | 'STOPPED'; reason?: string }[];
}

// ---------------- Auto Scaling ----------------

export interface LaunchTemplateVersion {
  versionNumber: number;
  versionDescription?: string;
  imageId: string;
  instanceType: string;
  keyName?: string;
  securityGroupIds: string[];
  /** user data; a script that starts "webapp" makes the instance serve the app (see appFromUserData) */
  userData?: string;
  detailedMonitoring: boolean;
  createTime: string;
}

export interface LaunchTemplate {
  launchTemplateId: string;
  launchTemplateName: string;
  defaultVersionNumber: number;
  latestVersionNumber: number;
  versions: LaunchTemplateVersion[];
  createTime: string;
}

export interface AsgInstance {
  instanceId: string;
  lifecycleState: 'Pending' | 'InService' | 'Terminating' | 'Terminated';
  healthStatus: 'Healthy' | 'Unhealthy';
  availabilityZone: string;
  launchTemplateVersion: string;
  launchedAt: number;
  /** when it started / stopped receiving traffic (kept after termination for the metric history) */
  inServiceAt?: number;
  outOfServiceAt?: number;
}

export interface TargetTrackingPolicy {
  policyName: string;
  policyARN: string;
  metric: 'ASGAverageCPUUtilization' | 'ALBRequestCountPerTarget';
  targetValue: number;
  /** how long the metric has been above / below the target (scale-out / scale-in hold) */
  highSince?: number;
  lowSince?: number;
}

export interface ScalingActivity {
  activityId: string;
  startTime: number;
  statusCode: 'Successful';
  description: string;
  cause: string;
}

export interface AutoScalingGroup {
  autoScalingGroupName: string;
  autoScalingGroupARN: string;
  launchTemplate: { launchTemplateId: string; version: '$Default' | '$Latest' };
  minSize: number;
  maxSize: number;
  desiredCapacity: number;
  subnetIds: string[];
  targetGroupArns: string[];
  healthCheckType: 'EC2' | 'ELB';
  healthCheckGracePeriod: number;
  instances: AsgInstance[];
  policies: TargetTrackingPolicy[];
  /** newest first */
  activities: ScalingActivity[];
  desiredHistory: { at: number; value: number }[];
  createdTime: string;
}

export interface TrafficSetting {
  at: number;
  /** requests per second; undefined = back to the normal daily traffic */
  rps?: number;
}

// ---------------- CloudTrail / Config ----------------

export interface TrailEvent {
  eventId: string;
  eventTime: number;
  eventName: string;
  /** e.g. ec2.amazonaws.com */
  eventSource: string;
  awsRegion: string;
  sourceIPAddress: string;
  userAgent: string;
  userIdentity: { type: 'IAMUser' | 'AssumedRole'; principalId: string; arn: string; accountId: string; accessKeyId: string; userName: string };
  readOnly: boolean;
  /** [resource type, resource name], e.g. ['AWS::EC2::SecurityGroup', 'sg-0abc...'] */
  resources: [string, string][];
  requestParameters: unknown;
  responseElements: unknown;
  requestId: string;
}

export interface ConfigRule {
  configRuleName: string;
  /** managed rule identifier, e.g. INCOMING_SSH_DISABLED */
  identifier: string;
  configRuleId: string;
  configRuleArn: string;
  createdAt: number;
}

// ---------------- CloudWatch ----------------

/** A production problem that shapes the generated metrics and logs from `startedAt` on. */
export interface Incident {
  /** db-slow-query: a query without an index scans the whole table on every request */
  kind: 'db-slow-query';
  /** DBInstanceIdentifier */
  target: string;
  startedAt: number;
}

export interface Dimension {
  name: string;
  value: string;
}

export type Statistic = 'Average' | 'Maximum' | 'Minimum' | 'Sum' | 'SampleCount';
export type ComparisonOperator = 'GreaterThanThreshold' | 'GreaterThanOrEqualToThreshold' | 'LessThanThreshold' | 'LessThanOrEqualToThreshold';

export interface MetricAlarm {
  alarmName: string;
  alarmArn: string;
  alarmDescription?: string;
  namespace: string;
  metricName: string;
  dimensions: Dimension[];
  statistic: Statistic;
  /** seconds */
  period: number;
  evaluationPeriods: number;
  datapointsToAlarm: number;
  threshold: number;
  comparisonOperator: ComparisonOperator;
  treatMissingData: 'missing';
  createdAt: number;
}

export interface LogGroup {
  logGroupName: string;
  arn: string;
  creationTime: number;
  /** who writes into it: app = the web app on every instance with an app (one stream per instance) */
  source: { kind: 'app' } | { kind: 'rds-slowquery'; dbInstanceIdentifier: string } | { kind: 'stored' };
  /** events written by the service itself (Lambda, Batch), for source.kind = stored */
  events?: StoredLogEvent[];
  /** undefined = 失効しない (never expire) */
  retentionInDays?: number;
  /** simulator assumption for cost: GB ingested per month */
  ingestionGbPerMonth?: number;
}

export interface StoredLogEvent {
  timestamp: number;
  message: string;
  logStreamName: string;
}

// ---------------- IAM ----------------

export type StringOrList = string | string[];

export interface PolicyStatement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action?: StringOrList;
  NotAction?: StringOrList;
  Resource?: StringOrList;
  NotResource?: StringOrList;
  Principal?: '*' | Record<string, StringOrList>;
  NotPrincipal?: '*' | Record<string, StringOrList>;
  Condition?: Record<string, Record<string, StringOrList | boolean>>;
}

export interface PolicyDocument {
  Version?: string;
  Id?: string;
  Statement: PolicyStatement | PolicyStatement[];
}

export interface ManagedPolicy {
  policyName: string;
  policyId: string;
  arn: string;
  path: string;
  awsManaged: boolean;
  description: string;
  document: PolicyDocument;
  createDate: string;
  updateDate: string;
}

export interface InlinePolicy {
  policyName: string;
  document: PolicyDocument;
}

export interface IamRole {
  roleName: string;
  roleId: string;
  arn: string;
  path: string;
  description: string;
  createDate: string;
  maxSessionDuration: number;
  /** trust policy: who may assume the role */
  assumeRolePolicyDocument: PolicyDocument;
  attachedPolicyArns: string[];
  inlinePolicies: InlinePolicy[];
  tags: Tag[];
}

export interface IamUser {
  userName: string;
  userId: string;
  arn: string;
  path: string;
  createDate: string;
  consoleAccess: boolean;
  attachedPolicyArns: string[];
  inlinePolicies: InlinePolicy[];
  tags: Tag[];
}

export interface InstanceProfile {
  instanceProfileName: string;
  instanceProfileId: string;
  arn: string;
  roleNames: string[];
}

// ---------------- S3 ----------------

export interface S3Object {
  key: string;
  /** 'null' for objects written while versioning was never enabled */
  versionId: string;
  isLatest: boolean;
  deleteMarker?: boolean;
  size: number;
  lastModified: string;
  etag: string;
  storageClass: 'STANDARD';
  contentType: string;
  serverSideEncryption: 'AES256' | 'aws:kms';
  /** small text body so the simulated browser / CLI can show something */
  body?: string;
}

export interface BlockPublicAccess {
  blockPublicAcls: boolean;
  ignorePublicAcls: boolean;
  blockPublicPolicy: boolean;
  restrictPublicBuckets: boolean;
}

export interface Bucket {
  name: string;
  region: string;
  creationDate: string;
  blockPublicAccess: BlockPublicAccess;
  policy?: PolicyDocument;
  versioning: 'Disabled' | 'Enabled' | 'Suspended';
  encryption: { sseAlgorithm: 'AES256' | 'aws:kms'; bucketKeyEnabled: boolean };
  /** every version of every object; the current one has isLatest */
  objects: S3Object[];
  tags: Tag[];
}

/** Error in the AWS API shape: `Code: message`, shown in the console the way AWS shows API errors. */
export class AwsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
