import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, choose, content, filterTable, nextUntilTask, pasteInto, search, startLesson, validateOk } from './helpers';

async function openTerminal(page: Page, name: string) {
  await search(page, 'instances', /インスタンス/);
  await content(page).getByRole('row', { name: new RegExp(name) }).getByRole('checkbox').check();
  await page.getByTestId('connect-instance').first().click();
  await page.getByTestId('eic-connect').click();
}

async function lookup(page: Page, attr: string, value?: string) {
  await search(page, 'event history', /イベント履歴/);
  await choose(page, 'lookup-attr', attr);
  const input = page.getByTestId('lookup-value').locator('input');
  if (value) await input.fill(value);
  else await pasteInto(input);
  await input.press('Enter');
}

test('26 CloudTrail: 接続できない → RevokeSecurityGroupIngress を発見 → 記録どおりに戻す → 自分の操作も記録される', async ({ page }) => {
  await startLesson(page, 'ssh-revoked');
  await nextUntilTask(page);
  await openTerminal(page, 'batch-1');
  await expect(page.getByTestId('eic-failed')).toContainText('Failed to connect to your instance');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'security', /セキュリティグループ.*EC2 の機能/);
  await filterTable(page, 'batch-sg');
  await content(page).getByRole('link', { name: /^sg-/ }).first().click();
  await expect(page.getByTestId('ingress-rules')).toContainText('198.51.100.24/32');
  await expect(page.getByTestId('ingress-rules')).not.toContainText('3.112.23.0/29');
  await validateOk(page);

  // copy the group id, look it up in CloudTrail
  await nextUntilTask(page);
  await content(page).getByRole('button', { name: /^sg-[0-9a-f]+ をコピー$/ }).first().click();
  await lookup(page, 'リソース名');
  await expect(page.getByTestId('event-history')).toContainText('tanaka');
  await content(page).getByRole('link', { name: 'RevokeSecurityGroupIngress' }).click();
  await expect(page.getByTestId('event-record')).toContainText('"cidrIp": "3.112.23.0/29"');
  await expect(page.getByTestId('event-record')).toContainText('aws-cli/');
  await validateOk(page);

  // restore exactly what was removed (from the referenced resource link)
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: /^sg-/ }).click();
  await page.getByTestId('edit-inbound').click();
  await page.getByRole('button', { name: 'ルールを追加' }).click();
  await choose(page, 'rule-type-1', 'SSH');
  const peer = page.getByTestId('rule-peer-1').locator('input');
  await peer.fill('3.112.23.0/29');
  await peer.press('Escape');
  await content(page).getByRole('textbox', { name: '説明' }).nth(1).fill('EC2 Instance Connect');
  await page.getByTestId('save-rules').click();
  await expect(page.getByTestId('ingress-rules')).toContainText('3.112.23.0/29');
  await validateOk(page);

  await nextUntilTask(page);
  await openTerminal(page, 'batch-1');
  const input = page.getByTestId('terminal-input');
  await input.fill('whoami');
  await input.press('Enter');
  await expect(page.getByTestId('terminal-output').last()).toHaveText('ec2-user');
  await validateOk(page);

  await nextUntilTask(page);
  await lookup(page, 'ユーザー名', 'learner');
  await content(page).getByRole('link', { name: 'AuthorizeSecurityGroupIngress' }).first().click();
  await expect(page.getByTestId('event-record')).toContainText('"userName": "learner"');
  await expect(page.getByTestId('event-record')).toContainText('"sessionCredentialFromConsole": "true"');
  await validateOk(page);
  await answerQuiz(page, /^CloudTrail$/);
  await answerQuiz(page, /^90 日$/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('27 AWS Config: 非準拠 2 件 → タイムラインで原因 → SG とバケットを直して準拠 → ルールを追加', async ({ page }) => {
  await startLesson(page, 'config-audit');
  await nextUntilTask(page);
  await search(page, 'config', /^AWS Config/);
  await expect(page.getByTestId('noncompliant-rules')).toContainText('2 個の非準拠ルール');
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByRole('link', { name: 'restricted-ssh' }).click();
  await page.getByTestId('rule-resources').getByRole('link', { name: /^sg-/ }).click();
  await expect(page.getByTestId('resource-events')).toContainText('AuthorizeSecurityGroupIngress');
  await expect(page.getByTestId('resource-events')).toContainText('tanaka');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'security', /セキュリティグループ.*EC2 の機能/);
  await filterTable(page, 'web-sg');
  await content(page).getByRole('link', { name: /^sg-/ }).first().click();
  await page.getByTestId('edit-inbound').click();
  await expect(page.getByTestId('rule-port-1').locator('input')).toHaveValue('22');
  await content(page).getByRole('button', { name: '削除' }).nth(1).click();
  await page.getByTestId('save-rules').click();
  await expect(page.getByTestId('ingress-rules')).not.toContainText('0.0.0.0/0');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'buckets', /バケット/);
  await content(page).getByRole('link', { name: 'webapp-share-123456789012' }).click();
  await content(page).getByRole('tab', { name: 'アクセス許可' }).click();
  await page.getByTestId('edit-bpa').click();
  await page.getByTestId('bpa-all').locator('input').check();
  await page.getByTestId('save-bpa').click();
  await page.getByTestId('bpa-confirm-input').locator('input').fill('確認');
  await page.getByTestId('bpa-confirm').click();
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'config rules', /ルール.*AWS Config の機能/);
  await page.getByTestId('add-config-rule').click();
  await page.getByRole('radio', { name: 'rds-storage-encrypted を選択' }).check();
  await content(page).getByRole('button', { name: '次へ' }).click();
  await expect(page.getByTestId('config-rule-name').locator('input')).toHaveValue('rds-storage-encrypted');
  await content(page).getByRole('button', { name: '次へ' }).click();
  await content(page).getByRole('button', { name: 'ルールを保存' }).click();
  await expect(page.getByText('ルール rds-storage-encrypted が追加されました')).toBeVisible();
  await expect(page.getByTestId('config-rules').getByRole('row', { name: /rds-storage-encrypted/ })).toContainText('準拠');
  await validateOk(page);
  await answerQuiz(page, /準拠しているか/);
  await answerQuiz(page, /タイムラインと CloudTrail/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
