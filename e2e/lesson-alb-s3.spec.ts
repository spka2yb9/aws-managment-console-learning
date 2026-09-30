import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, browseAlb, choose, content, copyValue, nextUntilTask, openBrowserTab, openTalkTab, search, startLesson, validateOk } from './helpers';

const ASSETS = 'webapp-assets-123456789012';

async function bothHealthy(page: Page) {
  await expect(page.getByTestId('registered-targets').getByText('正常', { exact: true })).toHaveCount(2, { timeout: 20_000 });
}

test('11 ALB を Public subnet 1a/1c・alb-sg・HTTP:80 → web-tg で作り、DNS 名で 200 が返る', async ({ page }) => {
  await startLesson(page, 'alb');
  await nextUntilTask(page);
  await page.getByTestId('create-lb').click();
  await page.getByTestId('create-alb').click();
  await page.getByTestId('alb-name').locator('input').fill('web-alb');
  await choose(page, 'alb-vpc', /webapp-vpc/);
  for (const az of ['a', 'c']) {
    await page.getByTestId(`alb-az-ap-northeast-1${az}`).getByRole('checkbox').check();
    await choose(page, `alb-subnet-ap-northeast-1${az}`, new RegExp(`public-subnet-1${az}`));
  }
  await page.getByTestId('alb-sgs').locator('button').first().click();
  await page.getByRole('option', { name: /alb-sg/ }).click();
  await page.keyboard.press('Escape');
  await choose(page, 'alb-tg', /web-tg/);
  await page.getByTestId('create-alb-submit').click();
  await expect(content(page).getByText('アクティブ').first()).toBeVisible({ timeout: 20_000 });
  await validateOk(page);

  await nextUntilTask(page);
  await browseAlb(page, /200/, 'Hello from');
  await validateOk(page);
  await answerQuiz(page, /2 つ以上の、異なる AZ/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('12 白紙の web-tg で 503 → web-1/web-2 を 3000 で登録して healthy → 200', async ({ page }) => {
  await startLesson(page, 'target-group');
  await nextUntilTask(page);
  await browseAlb(page, /503/);
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'target groups', /ターゲットグループ/);
  await content(page).getByRole('link', { name: 'web-tg' }).click();
  await page.getByTestId('register-targets').click();
  await page.getByRole('checkbox', { name: 'web-1 を選択' }).check();
  await page.getByRole('checkbox', { name: 'web-2 を選択' }).check();
  await expect(page.getByTestId('target-port').locator('input')).toHaveValue('3000');
  await page.getByTestId('include-pending').click();
  await expect(page.getByTestId('pending-targets')).toContainText('web-2');
  await page.getByTestId('register-pending').click();
  await bothHealthy(page);
  await validateOk(page);

  await nextUntilTask(page);
  await openBrowserTab(page);
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText('200');
  await openTalkTab(page);
  await validateOk(page);
  await answerQuiz(page, /ALB が EC2 上のアプリに接続するポート/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('13 ヘルスチェックパス /healthz の 404 で全台異常 (fail open) → /health に直して healthy', async ({ page }) => {
  await startLesson(page, 'health-check');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: 'web-tg' }).click();
  await expect(page.getByTestId('registered-targets')).toContainText('[404]', { timeout: 20_000 });
  await browseAlb(page, /200/);
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'target groups', /ターゲットグループ/);
  await content(page).getByRole('link', { name: 'web-tg' }).click();
  await content(page).getByRole('tab', { name: 'ヘルスチェック' }).click();
  await expect(content(page)).toContainText('/healthz');
  await page.getByTestId('edit-health-check').click();
  await page.getByTestId('hc-path').locator('input').fill('/health');
  await page.getByTestId('save-health-check').click();
  await content(page).getByRole('tab', { name: 'ターゲット' }).click();
  await bothHealthy(page);
  await validateOk(page);
  await answerQuiz(page, /良くない/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('20 S3: プレフィックスをたどり、バージョニング有効のバケットを作ってアップロードし S3 URI をコピー', async ({ page }) => {
  await startLesson(page, 's3-basics');
  await nextUntilTask(page);
  await search(page, 'S3', /^S3/);
  await content(page).getByRole('link', { name: 'webapp-reports-123456789012' }).click();
  for (const p of ['reports/', '2026/', '09/']) await content(page).getByRole('link', { name: p, exact: true }).click();
  await expect(page.getByTestId('objects-table')).toContainText('report-2026-09-28.csv');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'buckets', /バケット/);
  await page.getByTestId('create-bucket').click();
  await page.getByTestId('bucket-name').locator('input').fill(ASSETS);
  await page.getByTestId('bucket-versioning').getByText('有効にする').click();
  await page.getByTestId('create-bucket-submit').click();
  await expect(content(page).getByRole('heading', { name: ASSETS })).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await page.getByTestId('upload').click();
  await page.getByTestId('upload-files').locator('input[type=file]').setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hello s3') });
  await page.getByTestId('upload-submit').click();
  await expect(page.getByTestId('upload-success')).toBeVisible();
  await content(page).getByRole('button', { name: '閉じる' }).click();
  await content(page).getByRole('link', { name: 'hello.txt' }).click();
  await copyValue(page, `s3://${ASSETS}/hello.txt`);
  await validateOk(page);
  await answerQuiz(page, /既に誰かが使っている/);
  await answerQuiz(page, /削除マーカー/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
