import { expect, test, type Page } from '@playwright/test';
import { browseAlb, content, copyValue, filterTable, nextUntil, nextUntilTask, pasteInto, search, startLesson, validateOk } from './helpers';

async function diagramShows(page: Page, status: RegExp) {
  const d = page.getByTestId('current-step').getByTestId('diagram');
  await expect(d.getByTestId('diagram-status')).toHaveText(status);
  await expect(d.getByTestId('diagram-collisions')).toHaveAttribute('data-count', '0');
  await expect(d.locator('.react-flow__node').first()).toBeVisible();
  await expect(d.locator('.diagram-node img').first()).toBeVisible();
}

async function addRuleFromClipboard(page: Page, opts: { port?: string; type?: string }) {
  await page.getByTestId('edit-inbound').click();
  await page.getByRole('button', { name: 'ルールを追加' }).click();
  if (opts.type) {
    await page.getByTestId('rule-type-0').locator('button').first().click();
    await page.getByRole('option', { name: opts.type }).click();
  }
  if (opts.port) await page.getByTestId('rule-port-0').locator('input').fill(opts.port);
  const source = page.getByTestId('rule-peer-0').locator('input');
  await pasteInto(source);
  await source.press('Escape');
  await page.getByTestId('save-rules').click();
}

test('MVP 総合: Internet → ALB → EC2 → RDS を BLOCKED から ALL CONNECTED へ (構成図は重なり 0)', async ({ page }) => {
  await startLesson(page, 'mvp-final');
  await nextUntil(page, (step) => step.getByTestId('diagram'));
  await diagramShows(page, /BLOCKED/);
  await nextUntilTask(page);

  // ALB → EC2
  await search(page, 'load balancers', /ロードバランサー/);
  await content(page).getByRole('link', { name: 'web-alb' }).click();
  await content(page).getByRole('tab', { name: 'セキュリティ' }).click();
  const albSg = (await page.getByTestId('lb-security-groups').getByRole('link', { name: /^sg-/ }).textContent())!.trim();
  await copyValue(page, albSg);
  await search(page, 'security', /セキュリティグループ.*EC2 の機能/);
  await filterTable(page, 'web-sg');
  await content(page).getByRole('link', { name: /^sg-/ }).first().click();
  const webSg = (await page.getByTestId('sg-id').textContent())!.trim();
  await addRuleFromClipboard(page, { port: '3000' });
  await validateOk(page);

  // EC2 → RDS
  await copyValue(page, webSg);
  await search(page, 'databases', /データベース/);
  await content(page).getByRole('link', { name: 'webapp-db' }).click();
  await page.getByTestId('db-security-groups').getByRole('link', { name: /db-sg/ }).click();
  await addRuleFromClipboard(page, { type: 'MYSQL/Aurora' });
  await validateOk(page);

  await nextUntil(page, (step) => step.getByTestId('diagram'));
  await diagramShows(page, /ALL CONNECTED/);
  await nextUntilTask(page);
  await browseAlb(page, /200/, 'Database: connected');
  await validateOk(page);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
