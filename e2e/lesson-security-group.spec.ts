import { expect, test } from '@playwright/test';
import { answerQuiz, choose, content, copyValue, filterTable, nextUntilTask, openBrowserTab, openTalkTab, panel, pasteInto, search, startLesson, validateOk } from './helpers';

test('Phase 1: Security Group lesson — dialogue → console → validation → dialogue → Lesson Complete, resumable', async ({ page }) => {
  await startLesson(page, 'security-group');
  await expect(panel(page).getByText('Security Group ってFirewallなんですか')).toBeVisible();
  await nextUntilTask(page);

  // validating too early fails and asks to retry
  await page.getByTestId('validate').click();
  await expect(page.getByTestId('result-ng')).toBeVisible();
  await page.getByTestId('retry').click();

  await search(page, 'security', /セキュリティグループ.*VPC の機能/);
  await expect(page.getByRole('heading', { name: /セキュリティグループ/, level: 1 })).toBeVisible();
  await filterTable(page, 'web-server');
  await content(page).getByRole('link', { name: /^sg-/ }).first().click();
  await page.getByTestId('edit-inbound').click();
  await page.getByRole('button', { name: 'ルールを追加' }).click();
  await choose(page, 'rule-type-1', 'HTTP');
  await choose(page, 'rule-peer-type-1', 'Anywhere-IPv4');
  await page.getByTestId('save-rules').click();
  await expect(page.getByText(/インバウンドセキュリティグループルールが正常に変更されました/)).toBeVisible();
  await expect(page.getByTestId('ingress-rules')).toContainText('HTTP');

  // reload mid-lesson: step and console state survive (IndexedDB)
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId('ingress-rules')).toContainText('HTTP');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'instances', /インスタンス/);
  const ip = (await content(page).getByTestId('instances-table').getByText(/^203\.0\.113\./).first().textContent())!.trim();
  await copyValue(page, ip);
  await openBrowserTab(page);
  await pasteInto(page.getByTestId('browser-url').locator('input'));
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText('200');
  await openTalkTab(page);
  await validateOk(page);

  await answerQuiz(page, /ステートフル/);
  await page.getByTestId('current-step').getByTestId('next').click();
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
