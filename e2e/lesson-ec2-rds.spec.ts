import { expect, test } from '@playwright/test';
import { choose, content, nextUntilTask, startLesson, validateOk } from './helpers';

test('Phase 5: 正しい VPC / サブネット / SG で EC2 を起動し、実行中になる', async ({ page }) => {
  await startLesson(page, 'ec2');
  await nextUntilTask(page);
  await page.getByRole('link', { name: 'インスタンス', exact: true }).first().click();
  await page.getByTestId('launch-instances').click();
  await page.getByTestId('launch-name').locator('input').fill('my-first-ec2');
  await choose(page, 'launch-key', 'webapp-key');
  await choose(page, 'launch-vpc', /webapp-vpc/);
  await choose(page, 'launch-subnet', /public-subnet-1a/);
  await choose(page, 'launch-public-ip', /^有効化$/);
  await page.getByTestId('launch-sgs').locator('button').first().click();
  await page.getByRole('option', { name: /web-server-sg/ }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('launch-submit').click();
  await expect(page.getByTestId('launch-success')).toBeVisible();
  await page.getByTestId('launch-success').getByRole('link').click();
  await expect(content(page).getByText('実行中').first()).toBeVisible({ timeout: 10_000 });
  await validateOk(page);
  // VPC → Subnet → EC2 → SG are linked from the instance page
  await expect(content(page).getByRole('link', { name: /public-subnet-1a/ }).first()).toBeVisible();
});

test('Phase 7: RDS を作成し、アプリから接続できる', async ({ page }) => {
  await startLesson(page, 'rds');
  await nextUntilTask(page);
  await page.getByTestId('create-database').click();
  await page.getByTestId('db-identifier').locator('input').fill('webapp-db');
  await page.getByTestId('db-password').locator('input').fill('Sup3rSecret!');
  await page.getByTestId('db-password-confirm').locator('input').fill('Sup3rSecret!');
  await page.getByTestId('db-sgs').locator('button').first().click();
  await page.getByRole('option', { name: /db-sg/ }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('create-db-submit').click();
  await expect(page.getByText(/データベース webapp-db を作成しています/)).toBeVisible();
  await expect(page.getByTestId('db-table')).toContainText('利用可能', { timeout: 20_000 });
  await validateOk(page);
});
