import { expect, test, type Page } from '@playwright/test';
import { content, nextUntilTask, panel, search } from './helpers';

/* 拡張機能のコース (42-47): 本番ビルドで、コンソール版のレッスンが開けて、最初の課題まで会話を進められること。
   課題の解き方はレッスンごとの単体テスト (src/lessons/l4x-*.test.ts) と jsdom の画面テストで確かめている */
const LESSONS = ['anti-ddos', 'guardduty', 'security-hub', 'access-analyzer', 'session-manager', 'zonal-shift'];

for (const id of LESSONS) {
  test(`console lesson ${id} opens and reaches its first task`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`./#/lessons/${id}`);
    await expect(panel(page)).toBeVisible();
    await expect(content(page)).toBeVisible();
    await nextUntilTask(page);
    expect(errors).toEqual([]);
  });
}

/* 新しいサービスの画面: 上の検索から開けて、例外なく描画されること */
const PAGES: [lesson: string, query: string, option: string | RegExp, text: string | RegExp][] = [
  ['guardduty', 'guardduty', /^GuardDuty/, '検出結果'],
  ['security-hub', 'security hub', /^Security Hub/, /Security Hub/],
  ['access-analyzer', 'access analyzer', /^Access Analyzer/, /アナライザー|結果/],
  ['session-manager', 'session manager', /^セッションマネージャー/, 'セッション'],
  ['zonal-shift', 'zonal shift', /^ゾーンシフト/, 'ゾーンシフト'],
];
for (const [lesson, query, option, text] of PAGES) {
  test(`console page for ${lesson} renders`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`./#/lessons/${lesson}`);
    await expect(panel(page)).toBeVisible();
    await search(page, query, option);
    await expect(content(page)).toContainText(text);
    expect(errors).toEqual([]);
  });
}

async function typeCommand(page: Page, line: string) {
  await page.getByTestId('cli-terminal').locator('.xterm-screen').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

test('CLI lesson of the extended course runs the new services', async ({ page }) => {
  await page.goto('./#/cli/lessons/guardduty');
  await expect(page.getByTestId('cli-terminal')).toContainText('aws help', { timeout: 30_000 });
  await typeCommand(page, "aws guardduty list-detectors --query 'DetectorIds[0]' --output text");
  await expect(page.getByTestId('cli-terminal')).toContainText(/learner@my-pc:~\$ aws guardduty list-detectors[^\n]*\s+\w{20,}/);
});

test('at an exercise, the panel tabs stay on screen and the hint opens the browser tab', async ({ page }) => {
  await page.goto('./#/lessons/anti-ddos');
  await nextUntilTask(page);
  await page.getByTestId('validate').scrollIntoViewIfNeeded();
  await expect(page.getByRole('tab', { name: 'ブラウザ' })).toBeInViewport();
  await page.getByTestId('open-browser-tab').click();
  await expect(page.getByTestId('browser-url')).toBeVisible();
});
