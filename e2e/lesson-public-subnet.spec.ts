import { expect, test } from '@playwright/test';
import { answerQuiz, content, filterTable, nextUntilTask, startLesson, validateOk } from './helpers';

test('Phase 3: ルートテーブルを編集すると Private → Public と判定される', async ({ page }) => {
  await startLesson(page, 'public-private-subnet');
  await nextUntilTask(page);
  await filterTable(page, 'public-subnet-1a');
  await content(page).getByRole('link', { name: /^subnet-/ }).first().click();
  await content(page).getByRole('link', { name: /public-rt/ }).first().click();
  await expect(page.getByTestId('routes-table')).not.toContainText('0.0.0.0/0');
  await validateOk(page);
  await nextUntilTask(page);

  await page.getByTestId('edit-routes').click();
  await page.getByTestId('add-route').click();
  await page.getByTestId('route-dest-0').locator('input').fill('0.0.0.0/0');
  await page.getByTestId('route-target-0').locator('input').fill('igw-');
  await page.getByRole('option', { name: /webapp-igw/ }).click();
  await page.getByTestId('save-routes').click();
  await expect(page.getByText(/のルートが正常に更新されました/)).toBeVisible();
  await expect(page.getByTestId('routes-table')).toContainText('0.0.0.0/0');
  await expect(page.getByTestId('routes-table')).toContainText('アクティブ');
  await validateOk(page);
  await nextUntilTask(page);
  await answerQuiz(page, 'local (VPC 内)');
  await answerQuiz(page, /Private \(main route table/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
  await page.goto('./#/progress');
  await expect(page.getByTestId('progress-table')).toContainText('Completed');
});
