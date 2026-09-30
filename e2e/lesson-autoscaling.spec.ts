import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, browseAlb, choose, content, nextUntilTask, openTalkTab, panel, search, startLesson, validateOk } from './helpers';

const next = (page: Page) => content(page).getByRole('button', { name: '次へ' }).click();
const inServiceCount = (page: Page) => page.getByTestId('asg-instances').getByText('InService', { exact: true }).count();

async function loadTest(page: Page, rps: string) {
  await panel(page).getByRole('tab', { name: '負荷テスト' }).click();
  await page.getByTestId('load-select').getByRole('button', { name: rps }).click();
}

test('30 Auto Scaling グループ: 503 → 作成 (2 AZ / web-tg / ELB) → 200 → 1 台終了しても自動で置き換わる', async ({ page }) => {
  test.setTimeout(120_000);
  await startLesson(page, 'asg-basics');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: /^lt-/ }).click();
  await expect(page.getByTestId('lt-user-data')).toContainText('webapp --port 3000');
  await validateOk(page);

  await nextUntilTask(page);
  await browseAlb(page, /503/);
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'auto scaling', /Auto Scaling グループ/);
  await page.getByTestId('create-asg').click();
  await page.getByTestId('asg-name').locator('input').fill('webapp-asg');
  await choose(page, 'asg-lt', 'webapp-lt');
  await next(page);
  await page.getByTestId('asg-subnets').locator('button').first().click();
  await page.getByRole('option', { name: /private-subnet-1a/ }).click();
  await page.getByRole('option', { name: /private-subnet-1c/ }).click();
  await page.keyboard.press('Escape');
  await next(page);
  await page.getByTestId('asg-lb-mode').getByRole('radio', { name: '既存のロードバランサーにアタッチする' }).check();
  await choose(page, 'asg-tg', 'web-tg');
  await page.getByTestId('asg-elb-hc').locator('input').check();
  await next(page);
  await page.getByTestId('asg-desired').locator('input').fill('2');
  await page.getByTestId('asg-min').locator('input').fill('2');
  await page.getByTestId('asg-max').locator('input').fill('6');
  await next(page);
  await content(page).getByRole('button', { name: 'Auto Scaling グループを作成' }).click();
  await expect(page.getByText('Auto Scaling グループ webapp-asg が作成されました')).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByRole('tab', { name: 'インスタンス管理' }).click();
  await expect.poll(() => inServiceCount(page), { timeout: 15_000 }).toBe(2);
  await browseAlb(page, /200/);
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'instances', /インスタンス/);
  await content(page).getByRole('row', { name: /webapp-asg.*実行中/ }).first().getByRole('checkbox').check();
  await content(page).getByRole('button', { name: 'インスタンスの状態' }).first().click();
  await page.getByRole('menuitem', { name: 'インスタンスを終了 (削除)' }).click();
  await search(page, 'auto scaling', /Auto Scaling グループ/);
  await content(page).getByRole('link', { name: 'webapp-asg' }).click();
  await content(page).getByRole('tab', { name: 'アクティビティ' }).click();
  await expect(page.getByTestId('asg-activity')).toContainText('EC2 health check indicating it has been terminated or stopped', { timeout: 15_000 });
  await content(page).getByRole('tab', { name: 'インスタンス管理' }).click();
  await expect.poll(() => inServiceCount(page), { timeout: 20_000 }).toBe(2);
  await expect(page.getByTestId('asg-instances').getByText('Pending', { exact: true })).toHaveCount(0);
  await validateOk(page);
  await answerQuiz(page, /3 台に戻る/);
  await answerQuiz(page, /ELB のヘルスチェックをオン/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('31 ターゲット追跡: 100 req/s は 2 台 → 1000 req/s で CPU 80% → 4 台で 45% → 100 req/s で 2 台に戻る', async ({ page }) => {
  test.setTimeout(240_000);
  await startLesson(page, 'asg-target-tracking');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: 'webapp-asg' }).click();
  await content(page).getByRole('tab', { name: '自動スケーリング' }).click();
  await page.getByTestId('create-policy').click();
  await page.getByTestId('policy-name').locator('input').fill('cpu50');
  await page.getByTestId('policy-submit').click();
  await expect(page.getByTestId('asg-policies')).toContainText('cpu50');
  await validateOk(page);

  await nextUntilTask(page);
  await loadTest(page, '100 req/s');
  await expect(page.getByTestId('load-instances')).toContainText('2 台 (希望 2)');
  await openTalkTab(page);
  await validateOk(page);

  await nextUntilTask(page);
  await loadTest(page, '1000 req/s');
  await expect(page.getByTestId('load-instances')).toContainText('4 台 (希望 4)', { timeout: 60_000 });
  await expect.poll(async () => parseFloat((await page.getByTestId('load-cpu').textContent()) ?? '100'), { timeout: 15_000 }).toBeLessThan(50);
  await openTalkTab(page);
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByRole('tab', { name: 'アクティビティ' }).click();
  await expect(page.getByTestId('asg-activity')).toContainText('triggered policy cpu50 changing the desired capacity from 2 to 4');
  await validateOk(page);

  await nextUntilTask(page);
  await loadTest(page, '100 req/s');
  await expect(page.getByTestId('load-instances')).toContainText('2 台 (希望 2)', { timeout: 120_000 });
  await openTalkTab(page);
  await validateOk(page);
  await answerQuiz(page, /^6 台$/);
  await answerQuiz(page, /コストが増え続けない/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
