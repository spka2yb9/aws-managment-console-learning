import { expect, test } from '@playwright/test';
import { answerQuiz, content, nextUntilTask, search, startLesson, validateOk } from './helpers';

const POLICY = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: 'arn:aws:s3:::webapp-reports-123456789012/reports/*' }] }, null, 2);

test('34 EventBridge + Batch: UTC の cron → 失敗ジョブのログ → ジョブロールに PutObject → 再実行 → rate(1 minute) で確認して無効化', async ({ page }) => {
  test.setTimeout(180_000);
  await startLesson(page, 'eventbridge-batch');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: 'daily-report-schedule' }).click();
  await expect(page.getByTestId('schedule-expression')).toHaveText('cron(0 17 * * ? *)');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'batch jobs', /ジョブ.*Batch/);
  await content(page).getByRole('row', { name: /FAILED/ }).first().getByRole('link').first().click();
  await expect(page.getByTestId('job-failed')).toBeVisible();
  await page.getByTestId('job-log-link').click();
  await expect(page.getByTestId('log-events')).toContainText('is not authorized to perform: s3:PutObject');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'roles', /ロール/);
  await content(page).getByRole('link', { name: 'report-job-role' }).click();
  await page.getByTestId('add-permissions').click();
  await page.getByRole('menuitem', { name: 'インラインポリシーを作成' }).click();
  await page.getByTestId('inline-editor').locator('textarea').fill(POLICY);
  await page.getByTestId('inline-name').locator('input').fill('write-reports');
  await page.getByTestId('create-inline-submit').click();
  await expect(page.getByText(/write-reports/).first()).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'batch jobs', /ジョブ.*Batch/);
  await page.getByTestId('submit-job').click();
  await page.getByTestId('job-name').locator('input').fill('daily-report-rerun');
  await page.getByTestId('submit-job-submit').click();
  await expect(page.getByTestId('job-status')).toContainText('SUCCEEDED', { timeout: 20_000 });
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'eventbridge rules', /ルール.*EventBridge/);
  await page.getByTestId('create-rule').click();
  await page.getByTestId('rule-name').locator('input').fill('report-test');
  await content(page).getByRole('button', { name: '次へ' }).click();
  await page.getByTestId('rate-value').locator('input').fill('1');
  await page.getByTestId('rate-unit').locator('button').first().click();
  await page.getByRole('option', { name: 'minute', exact: true }).click();
  await content(page).getByRole('button', { name: '次へ' }).click();
  await content(page).getByRole('button', { name: '次へ' }).click();
  await content(page).getByRole('button', { name: 'ルールの作成' }).click();
  await expect(page.getByTestId('schedule-expression')).toHaveText('rate(1 minute)');
  await search(page, 'batch jobs', /ジョブ.*Batch/);
  await expect(page.getByTestId('batch-jobs').getByRole('row', { name: /report-test.*SUCCEEDED/ })).toBeVisible({ timeout: 80_000 });
  await search(page, 'eventbridge rules', /ルール.*EventBridge/);
  await content(page).getByRole('link', { name: 'report-test' }).click();
  await page.getByTestId('toggle-rule').click();
  await expect(page.getByTestId('rule-state')).toContainText('無効');
  await validateOk(page);
  await answerQuiz(page, /^cron\(0 0 \* \* \? \*\)$/);
  await answerQuiz(page, /AWS Batch/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
