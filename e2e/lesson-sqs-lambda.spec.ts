import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, content, nextUntilTask, search, startLesson, validateOk } from './helpers';

async function openQueue(page: Page, name: string) {
  await search(page, 'queues', /キュー.*SQS/);
  await content(page).getByRole('link', { name, exact: true }).click();
}

async function send(page: Page, queue: string, body: string) {
  await openQueue(page, queue);
  await page.getByTestId('send-receive').click();
  await page.getByTestId('message-body').locator('textarea').fill(body);
  await page.getByTestId('send-message').click();
  await expect(page.getByText(/メッセージ ID .* を送信しました/).first()).toBeVisible();
}

async function openFunction(page: Page) {
  await search(page, 'functions', /関数.*Lambda/);
  await content(page).getByRole('link', { name: 'process-order' }).click();
}

test('33 SQS + Lambda: 失敗する注文 → ログで原因 → 環境変数を直す → DLQ 再処理 → 壊れたメッセージは DLQ へ', async ({ page }) => {
  test.setTimeout(150_000);
  await startLesson(page, 'sqs-lambda');
  await nextUntilTask(page);
  await send(page, 'orders-queue', '{"orderId": 2001, "amount": 1200}');
  await openFunction(page);
  await content(page).getByRole('tab', { name: 'モニタリング' }).click();
  await page.getByTestId('view-logs').click();
  await content(page).getByTestId('log-stream-table').getByRole('link').first().click();
  await expect(page.getByTestId('log-events')).toContainText('BUCKET is not set');
  await validateOk(page);

  await nextUntilTask(page);
  await openFunction(page);
  await content(page).getByRole('tab', { name: '設定' }).click();
  await page.getByTestId('edit-env').click();
  await page.getByRole('button', { name: '環境変数の追加' }).click();
  await page.getByTestId('env-key-0').locator('input').fill('BUCKET');
  await page.getByTestId('env-value-0').locator('input').fill('webapp-orders-123456789012');
  await page.getByTestId('save-env').click();
  await expect(page.getByTestId('lambda-env')).toContainText('webapp-orders-123456789012');
  await page.waitForTimeout(11_000); // the failed message comes back after the 10 s visibility timeout
  await validateOk(page);

  await nextUntilTask(page);
  await openQueue(page, 'orders-dlq');
  await expect(page.getByTestId('queue-visible')).toHaveText('3');
  await page.getByTestId('start-redrive').click();
  await page.getByTestId('confirm-redrive').click();
  await expect(page.getByText('3 件のメッセージを orders-queue に移動しました')).toBeVisible();
  await expect(page.getByTestId('queue-visible')).toHaveText('0');
  await page.waitForTimeout(2000);
  await validateOk(page);

  await nextUntilTask(page);
  await send(page, 'orders-queue', '{"orderId": 3001,');
  await openQueue(page, 'orders-dlq');
  await expect(page.getByTestId('queue-visible')).toHaveText('1', { timeout: 50_000 });
  await validateOk(page);
  await answerQuiz(page, /失われずに待てる/);
  await answerQuiz(page, /原因を調べて直す/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
