import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Grid from '@cloudscape-design/components/grid';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { AWS_ICONS } from '../../diagram/icons';
import { SERVICES } from '../nav';
import { useConsole } from '../store';
import { ConsoleLink } from '../ui';

const SERVICE_ICON = { ec2: AWS_ICONS.ec2, vpc: AWS_ICONS.vpc, rds: AWS_ICONS.rds, s3: AWS_ICONS.s3, iam: AWS_ICONS.iam, cloudwatch: AWS_ICONS.cloudwatch, cloudtrail: AWS_ICONS.cloudtrail, config: AWS_ICONS.config, ecs: AWS_ICONS.ecs, ecr: AWS_ICONS.ecr, lambda: AWS_ICONS.lambda, sqs: AWS_ICONS.sqs, events: AWS_ICONS.eventbridge, batch: AWS_ICONS.batch, route53: AWS_ICONS.route53, cloudfront: AWS_ICONS.cloudfront, acm: AWS_ICONS.acm, wafv2: AWS_ICONS.waf, billing: AWS_ICONS.billing, organizations: AWS_ICONS.organizations, sso: AWS_ICONS.identityCenter } as Record<string, string>;

export function ConsoleHome() {
  const visited = useConsole((s) => s.visited);
  const recent = SERVICES.filter((s) => visited.some((p) => p.startsWith(`/${s.id}/`)));
  const serviceLink = (s: (typeof SERVICES)[number]) => (
    <div key={s.id} className="service-link">
      <img src={SERVICE_ICON[s.id]} width={24} height={24} alt="" />
      <div>
        <ConsoleLink to={s.home}>{s.name}</ConsoleLink>
        <Box variant="small" display="block" color="text-body-secondary">{s.description}</Box>
      </div>
    </div>
  );
  return (
    <SpaceBetween size="l">
      <Header variant="h1">コンソールのホーム</Header>
      <Grid gridDefinition={[{ colspan: 6 }, { colspan: 6 }]}>
        <Container header={<Header variant="h2">最近アクセスしたサービス</Header>} fitHeight>
          {recent.length ? <SpaceBetween size="s">{recent.map(serviceLink)}</SpaceBetween> : <Box color="text-body-secondary">最近アクセスしたサービスはありません。上部の検索バーから AWS のサービスを探してみましょう。</Box>}
        </Container>
        <Container header={<Header variant="h2">AWS へようこそ</Header>} fitHeight>
          <SpaceBetween size="s">
            <Box>これは学習用シミュレーターです。実際の AWS アカウントには一切接続しません。</Box>
            <Box>実際のコンソールと同じように、検索バー (Alt+S) または「サービス」メニューからサービスを開きます。</Box>
          </SpaceBetween>
        </Container>
      </Grid>
      <Container header={<Header variant="h2">すべてのサービス</Header>}>
        <ColumnLayout columns={3}>{SERVICES.map(serviceLink)}</ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}
