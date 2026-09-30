import { expect, test } from '@playwright/test';
import { answerQuiz, choose, content, copyValue, filterTable, nextUntilTask, openBrowserTab, openTalkTab, pasteInto, search, startLesson, validateOk } from './helpers';

test('Network ACL: ステートレスな戻り通信をアウトバウンドルールで許可するとタイムアウトが解消する', async ({ page }) => {
  await startLesson(page, 'network-acl');
  await nextUntilTask(page);

  // symptom: timeout, and the trace points at the ACL's return traffic
  const ip = (await content(page).getByTestId('instances-table').getByText(/^203\.0\.113\./).first().textContent())!.trim();
  await copyValue(page, ip);
  await openBrowserTab(page);
  await pasteInto(page.getByTestId('browser-url').locator('input'));
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText('ERR_CONNECTION_TIMED_OUT');
  await expect(page.getByTestId('browser-trace')).toContainText('戻り通信');
  await openTalkTab(page);
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'network acl', /ネットワーク ACL/);
  await filterTable(page, 'public-nacl');
  await content(page).getByRole('link', { name: /^acl-/ }).first().click();
  await content(page).getByRole('tab', { name: 'アウトバウンドルール' }).click();
  await expect(page.getByTestId('nacl-outbound-rules')).toContainText('拒否');
  await validateOk(page);

  await nextUntilTask(page);
  await page.getByTestId('nacl-edit-outbound').click();
  await page.getByRole('button', { name: '新しいルールを追加' }).click();
  await expect(page.getByTestId('nacl-rule-number-0').locator('input')).toHaveValue('100');
  await choose(page, 'nacl-rule-type-0', 'カスタム TCP');
  await page.getByTestId('nacl-rule-port-0').locator('input').fill('1024-65535');
  await page.getByTestId('nacl-save-rules').click();
  await expect(page.getByText(/アウトバウンドルールが正常に更新されました/)).toBeVisible();
  await expect(page.getByTestId('nacl-outbound-rules')).toContainText('1024 - 65535');
  await validateOk(page);

  await openBrowserTab(page);
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText('200');
  await openTalkTab(page);
  await validateOk(page);
  await answerQuiz(page, /通らない/);
  await answerQuiz(page, /適用されない/);
  await answerQuiz(page, /ネットワーク ACL に小さい番号/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('サブネットの「ネットワーク ACL」タブから関連付けを変更できる', async ({ page }) => {
  await startLesson(page, 'nacl-troubleshooting');
  await search(page, 'subnets', /サブネット.*VPC の機能/);
  await filterTable(page, 'private-subnet-1a');
  await content(page).getByRole('link', { name: /^subnet-/ }).first().click();
  await content(page).getByRole('tab', { name: 'ネットワーク ACL' }).click();
  await expect(content(page)).toContainText('private-nacl');
  await page.getByRole('button', { name: 'ネットワーク ACL の関連付けを編集' }).click();
  await choose(page, 'subnet-nacl-select', /デフォルト/);
  await page.getByTestId('save-subnet-nacl').click();
  await expect(page.getByText(/ネットワーク ACL の関連付けが正常に更新されました/)).toBeVisible();
  await expect(content(page)).toContainText('VPC のデフォルトのネットワーク ACL です。');
});
