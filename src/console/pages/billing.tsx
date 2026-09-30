import Box from '@cloudscape-design/components/box';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { COST_CATEGORIES, costLines, formatUsd, totalOf, TRADEOFFS } from '../../sim/cost';
import { ResourceTable, useGlobalEnv } from '../ui';
import { useNow } from './cloudwatch';

/** 請求とコスト管理: the month-end forecast of the current configuration, by service, environment and resource. */
export function BillingHome() {
  const env = useGlobalEnv();
  const now = useNow(60_000);
  const lines = costLines(env, now);
  const total = totalOf(lines);
  const budget = env.budgets[0];
  const byEnv = (e: string) => totalOf(lines.filter((l) => l.environment === e));
  const categories = COST_CATEGORIES.map((category) => ({ category, usd: totalOf(lines.filter((l) => l.category === category)) })).filter((c) => lines.some((l) => l.category === c.category));
  const broken = lines.filter((l) => l.broken);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="現在の構成が 1 か月続いた場合の予測です (学習用の概算: 東京リージョンのオンデマンド料金、USD)。">
        請求とコスト管理 ホーム
      </Header>
      <Container header={<Header variant="h2">今月の予測コスト</Header>}>
        <ColumnLayout columns={budget ? 3 : 2} variant="text-grid">
          <div>
            <Box variant="awsui-key-label">月末までの予測 (合計)</Box>
            <Box fontSize="display-l" fontWeight="bold"><span data-testid="cost-total">{formatUsd(total)}</span></Box>
          </div>
          <div>
            <Box variant="awsui-key-label">環境別 (タグ Environment / 名前)</Box>
            <Box>本番: <span data-testid="cost-prod">{formatUsd(byEnv('本番'))}</span></Box>
            <Box>開発: <span data-testid="cost-dev">{formatUsd(byEnv('開発'))}</span></Box>
          </div>
          {budget && (
            <div data-testid="budget">
              <Box variant="awsui-key-label">予算: {budget.budgetName}</Box>
              <ProgressBar
                value={Math.min(100, Math.round((total / budget.limitUsd) * 100))}
                status={total > budget.limitUsd ? 'error' : 'in-progress'}
                additionalInfo={`予算 ${formatUsd(budget.limitUsd)} / 予測 ${formatUsd(total)}`}
                resultText={`予算超過の予測: ${formatUsd(total - budget.limitUsd)}`}
                description={total > budget.limitUsd ? '予測が予算を超えています' : '予算内に収まる予測です'}
              />
              {total <= budget.limitUsd && <StatusIndicator>予算内</StatusIndicator>}
            </div>
          )}
        </ColumnLayout>
      </Container>
      {broken.length > 0 && (
        <Container header={<Header variant="h2">通信できないデータの流れ</Header>}>
          {broken.map((l) => <div key={l.resource}><StatusIndicator type="error">{`${l.resource}: ${l.usage}`}</StatusIndicator></div>)}
        </Container>
      )}
      <Table
        variant="container"
        data-testid="cost-by-service"
        header={<Header description="安くするレバーと、その代わりに失うもの">サービス別のコスト</Header>}
        items={categories}
        columnDefinitions={[
          { id: 'cat', header: 'サービス', cell: (c) => c.category },
          { id: 'usd', header: '予測コスト', cell: (c) => formatUsd(c.usd) },
          { id: 'share', header: '割合', cell: (c) => `${total ? Math.round((c.usd / total) * 100) : 0}%` },
          { id: 'trade', header: 'トレードオフ (コスト vs 可用性 vs セキュリティ)', cell: (c) => <Box variant="small">{TRADEOFFS[c.category]}</Box> },
        ]}
        wrapLines
      />
      <ResourceTable
        title="コストの内訳"
        resourceName="明細"
        variant="container"
        testId="cost-lines"
        items={lines}
        trackBy={(l) => l.id}
        selectionType="none"
        pageSize={50}
        columns={[
          { id: 'category', header: 'サービス', cell: (l) => l.category, value: (l) => l.category, width: 150 },
          { id: 'environment', header: '環境', cell: (l) => l.environment, value: (l) => l.environment, width: 90 },
          { id: 'usd', header: '予測コスト', cell: (l) => formatUsd(l.usd), value: (l) => l.usd, width: 120 },
          { id: 'resource', header: 'リソース', cell: (l) => l.resource, value: (l) => l.resource },
          { id: 'usage', header: '使用量', cell: (l) => (l.broken ? <StatusIndicator type="error">{l.usage}</StatusIndicator> : l.usage) },
        ]}
      />
    </SpaceBetween>
  );
}
