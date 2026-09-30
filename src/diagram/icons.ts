// Official AWS Architecture Icons (Asset Package 07312026), bundled as static assets — never hotlinked.
import alb from '../assets/aws/alb.svg';
import client from '../assets/aws/client.svg';
import cloudtrail from '../assets/aws/cloudtrail.svg';
import cloudwatch from '../assets/aws/cloudwatch.svg';
import config from '../assets/aws/config.svg';
import ecs from '../assets/aws/ecs.svg';
import ecr from '../assets/aws/ecr.svg';
import lambda from '../assets/aws/lambda.svg';
import sqs from '../assets/aws/sqs.svg';
import eventbridge from '../assets/aws/eventbridge.svg';
import batch from '../assets/aws/batch.svg';
import route53 from '../assets/aws/route53.svg';
import cloudfront from '../assets/aws/cloudfront.svg';
import acm from '../assets/aws/acm.svg';
import waf from '../assets/aws/waf.svg';
import billing from '../assets/aws/billing.svg';
import organizations from '../assets/aws/organizations.svg';
import identityCenter from '../assets/aws/identity-center.svg';
import ec2Instance from '../assets/aws/ec2-instance.svg';
import ec2 from '../assets/aws/ec2.svg';
import elb from '../assets/aws/elb.svg';
import groupAwsCloud from '../assets/aws/group-aws-cloud.svg';
import groupPrivateSubnet from '../assets/aws/group-private-subnet.svg';
import groupPublicSubnet from '../assets/aws/group-public-subnet.svg';
import groupRegion from '../assets/aws/group-region.svg';
import groupVpc from '../assets/aws/group-vpc.svg';
import iam from '../assets/aws/iam.svg';
import internetGateway from '../assets/aws/internet-gateway.svg';
import internet from '../assets/aws/internet.svg';
import natGateway from '../assets/aws/nat-gateway.svg';
import rdsInstance from '../assets/aws/rds-instance.svg';
import rds from '../assets/aws/rds.svg';
import s3 from '../assets/aws/s3.svg';
import users from '../assets/aws/users.svg';
import vpcRouter from '../assets/aws/vpc-router.svg';
import vpc from '../assets/aws/vpc.svg';

export const AWS_ICONS = {
  ec2,
  ec2Instance,
  rds,
  rdsInstance,
  alb,
  elb,
  vpc,
  internetGateway,
  natGateway,
  vpcRouter,
  s3,
  iam,
  cloudwatch,
  cloudtrail,
  config,
  ecs,
  ecr,
  lambda,
  sqs,
  eventbridge,
  batch,
  route53,
  cloudfront,
  acm,
  waf,
  billing,
  organizations,
  identityCenter,
  users,
  internet,
  client,
} as const;

export type AwsIconKey = keyof typeof AWS_ICONS;

export const AWS_GROUP_ICONS = {
  cloud: groupAwsCloud,
  region: groupRegion,
  vpc: groupVpc,
  'public-subnet': groupPublicSubnet,
  'private-subnet': groupPrivateSubnet,
} as const;
