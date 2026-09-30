import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, choose, content, nextUntilTask, search, startLesson, validateOk } from './helpers';

const tab = (page: Page, name: string) => content(page).getByRole('tab', { name }).click();
const chart = (page: Page, metric: string) => page.getByTestId(`chart-${metric}`).getByTestId('metric-graph');

/** CloudWatch > アラームの作成 wizard, all four steps */
async function createAlarm(page: Page, metric: RegExp, threshold: string, name: string, period: string) {
  await page.getByTestId('create-alarm').click();
  await choose(page, 'alarm-metric', metric);
  await expect(page.getByTestId('alarm-period')).toContainText(period);
  await page.getByTestId('alarm-threshold').locator('input').fill(threshold);
  await expect(content(page).getByTestId('metric-graph')).toBeVisible();
  await content(page).getByRole('button', { name: '次へ' }).click();
  await content(page).getByRole('button', { name: '次へ' }).click();
  await page.getByTestId('alarm-name').locator('input').fill(name);
  await content(page).getByRole('button', { name: '次へ' }).click();
  await content(page).getByRole('button', { name: 'アラームの作成' }).click();
  await expect(page.getByText(`アラーム「${name}」が正常に作成されました`)).toBeVisible();
}

test('24 CloudWatch: モニタリングタブ → 2 本のメトリクスをグラフ化 → EC2 CPU のアラームは OK', async ({ page }) => {
  await startLesson(page, 'cloudwatch-basics');
  await nextUntilTask(page);
  await content(page).getByRole('row', { name: /web-1/ }).getByRole('link').first().click();
  await tab(page, 'モニタリング');
  await expect(chart(page, 'CPUUtilization')).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByText('メトリクスで表示').first().click();
  await expect(page.getByTestId('metrics-graph').getByTestId('metric-graph')).toBeVisible();
  await content(page).getByRole('row', { name: /web-2.*CPUUtilization/ }).getByRole('checkbox').check();
  await expect(content(page).getByRole('tab', { name: 'グラフ化したメトリクス (2)' })).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await page.getByRole('link', { name: 'すべてのアラーム' }).click();
  await createAlarm(page, /web-1 CPUUtilization/, '70', 'web-1-cpu-high', '5 分');
  await expect(page.getByTestId('alarm-table').getByRole('row', { name: /web-1-cpu-high/ })).toContainText('OK');
  await validateOk(page);
  await answerQuiz(page, /データ不足/);
  await answerQuiz(page, /^最大$/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('25 アプリが遅い: ALB 応答時間 ↑ / EC2 CPU 正常 / RDS CPU 高 → スロークエリログ → アラーム → スケールアップで OK', async ({ page }) => {
  await startLesson(page, 'app-slow');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: 'web-alb' }).click();
  await tab(page, 'モニタリング');
  await expect(chart(page, 'TargetResponseTime')).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'instances', /インスタンス/);
  await content(page).getByRole('row', { name: /web-1/ }).getByRole('link').first().click();
  await tab(page, 'モニタリング');
  await expect(chart(page, 'CPUUtilization')).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'databases', /データベース/);
  await content(page).getByRole('link', { name: 'webapp-db' }).click();
  await tab(page, 'モニタリング');
  await expect(chart(page, 'DatabaseConnections')).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'log groups', /ロググループ/);
  await content(page).getByRole('link', { name: '/aws/rds/instance/webapp-db/slowquery' }).click();
  await content(page).getByRole('link', { name: 'webapp-db' }).click();
  const filter = page.getByTestId('log-filter').locator('input');
  await filter.fill('Rows_examined');
  await filter.press('Enter');
  await expect(page.getByTestId('log-events')).toContainText('SELECT * FROM orders WHERE customer_id');
  await expect(page.getByTestId('log-events')).toContainText('Rows_examined: 24');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'alarms', /すべてのアラーム/);
  await createAlarm(page, /webapp-db CPUUtilization/, '80', 'webapp-db-cpu-high', '1 分');
  await expect(page.getByTestId('alarm-table').getByRole('row', { name: /webapp-db-cpu-high/ })).toContainText('アラーム状態');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'databases', /データベース/);
  await content(page).getByRole('link', { name: 'webapp-db' }).click();
  await page.getByTestId('modify-db').click();
  await choose(page, 'modify-db-class', 'db.m7g.xlarge');
  await page.getByTestId('modify-db-continue').click();
  await page.getByTestId('modify-db-submit').click();
  await expect(page.getByText(/DB インスタンス webapp-db が正常に変更されました/)).toBeVisible();
  await expect(content(page).getByText('変更中')).toHaveCount(0, { timeout: 15_000 });
  await search(page, 'alarms', /すべてのアラーム/);
  await expect(page.getByTestId('alarm-table').getByRole('row', { name: /webapp-db-cpu-high/ })).toContainText('OK', { timeout: 15_000 });
  await validateOk(page);
  await answerQuiz(page, /インデックスのないクエリ/);
  await answerQuiz(page, /インデックスを作成/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('アラームの編集: しきい値を変えて保存すると同じ名前のまま更新される', async ({ page }) => {
  await startLesson(page, 'cloudwatch-basics');
  await search(page, 'alarms', /すべてのアラーム/);
  await createAlarm(page, /web-1 CPUUtilization/, '70', 'web-1-cpu-high', '5 分');
  await content(page).getByRole('link', { name: 'web-1-cpu-high' }).click();
  await page.getByTestId('alarm-edit').click();
  await page.getByTestId('alarm-threshold').locator('input').fill('85');
  for (let i = 0; i < 2; i++) await content(page).getByRole('button', { name: '次へ' }).click();
  await expect(page.getByTestId('alarm-name').locator('input')).toBeDisabled();
  await content(page).getByRole('button', { name: '次へ' }).click();
  await content(page).getByRole('button', { name: 'アラームの更新' }).click();
  await expect(page.getByText('アラーム「web-1-cpu-high」が正常に更新されました')).toBeVisible();
  await expect(content(page).getByText(/CPUUtilization > 85/).first()).toBeVisible();
  await search(page, 'alarms', /すべてのアラーム/);
  await expect(page.getByTestId('alarm-table').getByRole('row', { name: /web-1-cpu-high/ })).toHaveCount(1);
});
