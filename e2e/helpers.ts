import { expect, type Locator, type Page } from '@playwright/test';

export const panel = (page: Page) => page.getByTestId('lesson-panel');
export const content = (page: Page) => page.getByTestId('console-content');
const current = (page: Page) => page.getByTestId('current-step');

export async function startLesson(page: Page, id: string) {
  await page.goto(`./#/lessons/${id}`);
  await expect(panel(page)).toBeVisible();
}

/** Click 次へ until the current step is an exercise or a quiz. */
export async function nextUntilTask(page: Page) {
  for (let i = 0; i < 30; i++) {
    if ((await current(page).getByTestId('exercise-panel').count()) || (await current(page).getByTestId('quiz-panel').count())) return;
    await current(page).getByTestId('next').click();
  }
  throw new Error('no task step reached');
}

/** Click 次へ until `target` (looked up inside the current step) is there. */
export async function nextUntil(page: Page, target: (step: Locator) => Locator) {
  for (let i = 0; i < 30; i++) {
    // steps may render lazily (the diagram): give the target a moment before moving on
    const found = await target(current(page)).first().waitFor({ timeout: 3000 }).then(() => true, () => false);
    if (found) return;
    await current(page).getByTestId('next').click();
  }
  throw new Error('target step not reached');
}

export async function validateOk(page: Page) {
  await page.getByTestId('validate').click();
  await expect(page.getByTestId('result-ok')).toBeVisible();
  await current(page).getByTestId('next').click();
}

export async function answerQuiz(page: Page, option: string | RegExp) {
  const quiz = page.getByTestId('quiz-panel');
  await quiz.getByText(option).click();
  await quiz.getByTestId('answer').click();
  await expect(page.getByTestId('result-ok')).toBeVisible();
  await current(page).getByTestId('next').click();
}

/** Unified search in the top bar (English keywords work, like the real console). */
export async function search(page: Page, text: string, option: string | RegExp) {
  const box = page.getByRole('combobox', { name: 'サービスと機能を検索' });
  await box.fill(text);
  await page.getByRole('option', { name: option }).first().click();
}

/** Cloudscape Select: open by test id then choose option. */
export async function choose(page: Page, testId: string, option: string | RegExp) {
  await page.getByTestId(testId).locator('button').first().click();
  await page.getByRole('option', { name: option }).first().click();
}

export async function filterTable(page: Page, text: string) {
  const f = content(page).getByRole('combobox').first();
  await f.fill(text);
  await f.press('Enter');
}

export async function copyValue(page: Page, value: string) {
  await page.getByRole('button', { name: `${value} をコピー` }).first().click();
  await expect(page.getByText('コピーしました').first()).toBeVisible();
}

export async function clipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

/** Paste the clipboard into an input the way a user does (select all, Ctrl+V). */
export async function pasteInto(input: Locator) {
  await input.click();
  await input.press('ControlOrMeta+A');
  await input.press('ControlOrMeta+V');
}

export async function openBrowserTab(page: Page) {
  await panel(page).getByRole('tab', { name: 'ブラウザ' }).click();
}

export async function openTalkTab(page: Page) {
  await panel(page).getByRole('tab', { name: '会話' }).click();
}

/** Copy the ALB DNS name from the load balancer list and open it in the simulated browser. */
export async function browseAlb(page: Page, expected: RegExp, body?: string) {
  await search(page, 'load balancers', /ロードバランサー/);
  const dns = (await content(page).getByTestId('lb-table').getByText(/elb\.amazonaws\.com/).first().textContent())!.trim();
  await copyValue(page, dns);
  await openBrowserTab(page);
  const url = page.getByTestId('browser-url').locator('input');
  await pasteInto(url);
  await expect(url).toHaveValue(dns);
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText(expected);
  if (body) await expect(page.getByTestId('browser-body')).toContainText(body);
  await openTalkTab(page);
}
