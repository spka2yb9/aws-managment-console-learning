import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, content, nextUntilTask, search, startLesson, validateOk } from './helpers';

const ORDERS = '1284112';

async function terminal(page: Page) {
  await search(page, 'instances', /インスタンス/);
  await content(page).getByRole('row', { name: /batch-1/ }).getByRole('checkbox').check();
  await page.getByTestId('connect-instance').first().click();
  await page.getByTestId('eic-connect').click();
}

async function sh(page: Page, line: string) {
  const input = page.getByTestId('terminal-input');
  await input.fill(line);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  return page.getByTestId('terminal-output').last();
}

async function openDb(page: Page, id: string) {
  await search(page, 'databases', /データベース/);
  await content(page).getByRole('link', { name: id, exact: true }).click();
}

/** db-sg instead of the preselected default group */
async function pickDbSg(page: Page) {
  await page.getByTestId('restore-sgs').locator('button').first().click();
  await page.getByRole('option', { name: /default sg-/ }).click();
  await page.getByRole('option', { name: /^db-sg sg-/ }).click();
  await page.keyboard.press('Escape');
}

const available = (page: Page) => expect(content(page).getByText('利用可能').first()).toBeVisible({ timeout: 20_000 });

async function rename(page: Page, from: string, to: string) {
  await openDb(page, from);
  await available(page);
  await page.getByTestId('modify-db').click();
  await page.getByTestId('modify-db-identifier').locator('input').fill(to);
  await page.getByTestId('modify-db-continue').click();
  await page.getByTestId('modify-db-submit').click();
  await expect(page.getByText(`DB インスタンス ${from} が正常に変更されました`)).toBeVisible();
}

test('28 スナップショット → 移行スクリプトで全件削除 → 復元 (db-sg) → 確認 → 名前を入れ替えて切り替え', async ({ page }) => {
  await startLesson(page, 'rds-snapshot');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: 'webapp-db', exact: true }).click();
  await content(page).getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: 'スナップショットの取得' }).click();
  await page.getByTestId('snapshot-name').locator('input').fill('webapp-db-before-migration');
  await page.getByTestId('take-snapshot-submit').click();
  await expect(page.getByTestId('manual-snapshots').getByRole('row', { name: /webapp-db-before-migration/ })).toContainText('利用可能', { timeout: 15_000 });
  await validateOk(page);

  await nextUntilTask(page);
  await terminal(page);
  await expect(await sh(page, './migrate.sh')).toContainText('[2/2] Done.');
  await expect(await sh(page, 'mysql -e "SELECT COUNT(*) FROM orders"')).toContainText('|        0 |');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'snapshots', /スナップショット/);
  await page.getByTestId('manual-snapshots').getByRole('row', { name: /webapp-db-before-migration/ }).getByRole('radio').check();
  await page.getByTestId('snapshot-actions').getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: 'スナップショットを復元' }).click();
  await page.getByTestId('restore-identifier').locator('input').fill('webapp-db-restored');
  await pickDbSg(page);
  await page.getByTestId('restore-submit').click();
  await expect(page.getByTestId('db-security-groups')).toContainText('db-sg');
  await available(page);
  await validateOk(page);

  await nextUntilTask(page);
  const endpoint = (await page.getByTestId('db-endpoint').textContent())!.trim();
  expect(endpoint).toMatch(/^webapp-db-restored\./);
  await terminal(page);
  await expect(await sh(page, `mysql -h ${endpoint} -e "SELECT COUNT(*) FROM orders"`)).toContainText(ORDERS);
  await validateOk(page);

  await nextUntilTask(page);
  await rename(page, 'webapp-db', 'webapp-db-broken');
  await rename(page, 'webapp-db-restored', 'webapp-db');
  await openDb(page, 'webapp-db');
  await available(page);
  await validateOk(page);
  await answerQuiz(page, /^12 時間$/);
  await answerQuiz(page, /新しい DB インスタンスが作られ/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('29 特定時点への復元: ログで事故時刻 → その 1 分前に復元 → 件数が戻る', async ({ page }) => {
  await startLesson(page, 'rpo-rto-dr');
  await nextUntilTask(page);
  await terminal(page);
  const log = (await (await sh(page, 'cat cleanup.log')).textContent())!;
  const [, date, time] = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) \+0900 cleanup: DELETE/.exec(log)!;
  await validateOk(page);

  // one minute before the DELETE, in JST
  const before = new Date(Date.parse(`${date}T${time}+09:00`) - 60_000 + 9 * 3_600_000).toISOString();
  await nextUntilTask(page);
  await openDb(page, 'webapp-db');
  await content(page).getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: '特定時点への復元' }).click();
  await page.getByTestId('pitr-mode').getByRole('radio', { name: /カスタム日時/ }).check();
  await page.getByTestId('pitr-date').locator('input').fill(before.slice(0, 10).replaceAll('-', '/'));
  await page.getByTestId('pitr-time').locator('input').fill(before.slice(11, 19));
  await page.getByTestId('restore-identifier').locator('input').fill('webapp-db-pitr');
  await pickDbSg(page);
  await page.getByTestId('pitr-submit').click();
  await available(page);
  await validateOk(page);

  await nextUntilTask(page);
  const endpoint = (await page.getByTestId('db-endpoint').textContent())!.trim();
  await terminal(page);
  await expect(await sh(page, `mysql -h ${endpoint} -e "SELECT COUNT(*) FROM orders"`)).toContainText(ORDERS);
  await validateOk(page);
  await nextUntilTask(page);
  await answerQuiz(page, /^バックアップと復元$/);
  await answerQuiz(page, /^ウォームスタンバイ$/);
  await answerQuiz(page, /AZ 全体の障害/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
