import { expect, test } from '@playwright/test';
import { answerQuiz, browseAlb, content, copyValue, filterTable, nextUntilTask, pasteInto, search, startLesson, validateOk } from './helpers';

test('Phase 4/6: 504 → ターゲットのヘルス → ALB の SG ID をコピー → EC2 の SG に貼り付け → 200', async ({ page }) => {
  await startLesson(page, 'sg-troubleshooting');
  await nextUntilTask(page);
  await browseAlb(page, /504/);
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'load balancers', /ロードバランサー/);
  await content(page).getByRole('link', { name: 'web-alb' }).click();
  await content(page).getByRole('link', { name: /web-tg/ }).click();
  await expect(page.getByTestId('registered-targets')).toContainText('Request timed out');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'load balancers', /ロードバランサー/);
  await content(page).getByRole('link', { name: 'web-alb' }).click();
  await content(page).getByRole('tab', { name: 'セキュリティ' }).click();
  const albSg = (await page.getByTestId('lb-security-groups').getByRole('link', { name: /^sg-/ }).textContent())!.trim();
  await copyValue(page, albSg);

  await search(page, 'security', /セキュリティグループ.*EC2 の機能/);
  await filterTable(page, 'web-sg');
  await content(page).getByRole('link', { name: /^sg-/ }).first().click();
  await page.getByTestId('edit-inbound').click();
  await page.getByRole('button', { name: 'ルールを追加' }).click();
  await page.getByTestId('rule-port-1').locator('input').fill('3000');
  const source = page.getByTestId('rule-peer-1').locator('input');
  await pasteInto(source);
  await expect(source).toHaveValue(albSg);
  await source.press('Escape');
  await page.getByTestId('save-rules').click();
  await expect(page.getByTestId('ingress-rules')).toContainText(`${albSg} / alb-sg`);
  await validateOk(page);

  await nextUntilTask(page);
  await browseAlb(page, /200/);
  await validateOk(page);
  await answerQuiz(page, /通信できない/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
