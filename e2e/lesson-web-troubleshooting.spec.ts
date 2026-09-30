import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, browseAlb, content, copyValue, filterTable, nextUntilTask, openBrowserTab, openTalkTab, pasteInto, search, startLesson, validateOk } from './helpers';

async function openSg(page: Page, name: string) {
  await search(page, 'security', /セキュリティグループ.*EC2 の機能/);
  await filterTable(page, name);
  await content(page).getByRole('link', { name: /^sg-/ }).first().click();
  await expect(page.getByTestId('sg-id')).toBeVisible();
}

test('15 Internet → ALB → EC2 → RDS: 通信経路の診断を読み、SG の鎖を辿る', async ({ page }) => {
  await startLesson(page, 'web-connectivity');
  await nextUntilTask(page);
  await browseAlb(page, /200/);
  await openBrowserTab(page);
  await page.getByTestId('browser-trace').getByText('通信経路の診断').click();
  await expect(page.getByTestId('browser-trace')).toContainText('ネットワーク ACL');
  await openTalkTab(page);
  await validateOk(page);

  await nextUntilTask(page);
  await openSg(page, 'web-sg');
  await page.getByTestId('ingress-rules').getByRole('link', { name: /alb-sg/ }).click();
  await expect(page.getByRole('heading', { name: /alb-sg/ })).toBeVisible();
  await openSg(page, 'db-sg');
  await expect(page.getByTestId('ingress-rules')).toContainText('web-sg');
  await validateOk(page);

  await answerQuiz(page, /Public subnet の ALB が受けて/);
  await answerQuiz(page, /ルールを変えずに済む/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('17 502: web-tg のポート 80 → web-1/web-2 を 3000 で登録し直し、80 を登録解除 → 200', async ({ page }) => {
  await startLesson(page, 'target-unhealthy');
  await nextUntilTask(page);
  await browseAlb(page, /502/);
  await search(page, 'target groups', /ターゲットグループ/);
  await content(page).getByRole('link', { name: 'web-tg' }).click();
  const targets = page.getByTestId('registered-targets');
  await expect(targets).toContainText('Health checks failed');
  await validateOk(page);

  await nextUntilTask(page);
  await page.getByTestId('register-targets').click();
  await page.getByRole('checkbox', { name: 'web-1 を選択' }).check();
  await page.getByRole('checkbox', { name: 'web-2 を選択' }).check();
  const port = page.getByTestId('target-port').locator('input');
  await expect(port).toHaveValue('80');
  await port.fill('3000');
  await page.getByTestId('include-pending').click();
  await expect(page.getByTestId('pending-targets')).toContainText('3000');
  await page.getByTestId('register-pending').click();
  for (const box of await targets.getByRole('checkbox', { name: /:80 を選択$/ }).all()) await box.check();
  await page.getByTestId('deregister').click();
  await expect(targets.getByRole('checkbox', { name: /:80 を選択$/ })).toHaveCount(0);
  await expect(targets.getByText('正常', { exact: true })).toHaveCount(2);
  await validateOk(page);

  await nextUntilTask(page);
  await browseAlb(page, /200/);
  await validateOk(page);
  await answerQuiz(page, /504 Gateway Time-out/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('18 500 connect ETIMEDOUT: db-sg のソースを web-sg の ID に貼り替え → Database: connected', async ({ page }) => {
  await startLesson(page, 'ec2-rds-troubleshooting');
  await nextUntilTask(page);
  await browseAlb(page, /500/, 'connect ETIMEDOUT');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'databases', /データベース/);
  await content(page).getByRole('link', { name: 'webapp-db' }).click();
  await page.getByTestId('db-security-groups').getByRole('link', { name: /db-sg/ }).click();
  await expect(page.getByTestId('ingress-rules')).toContainText('10.0.1.0/24');
  await validateOk(page);

  // web-1 → セキュリティ → web-sg (the tab only links the SG; the ID is copied on its detail page)
  await nextUntilTask(page);
  await search(page, 'instances', /インスタンス/);
  await content(page).getByRole('row', { name: /web-1/ }).getByRole('link').first().click();
  await content(page).getByRole('tab', { name: 'セキュリティ' }).click();
  await content(page).getByRole('link', { name: /\(web-sg\)/ }).click();
  const webSg = (await page.getByTestId('sg-id').textContent())!.trim();
  await copyValue(page, webSg);
  await openSg(page, 'db-sg');
  await page.getByTestId('edit-inbound').click();
  const source = page.getByTestId('rule-peer-0').locator('input');
  await pasteInto(source);
  await expect(source).toHaveValue(webSg);
  await source.press('Escape');
  await page.getByTestId('save-rules').click();
  await expect(page.getByTestId('ingress-rules')).toContainText(`${webSg} / web-sg`);
  await validateOk(page);

  await nextUntilTask(page);
  await browseAlb(page, /200/, 'Database: connected');
  await validateOk(page);
  await answerQuiz(page, /入れ替えや台数増加/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
