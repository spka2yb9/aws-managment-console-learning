import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, choose, content, nextUntil, nextUntilTask, openBrowserTab, openTalkTab, panel, pasteInto, search, startLesson, validateOk } from './helpers';

const REPORTS = 'webapp-reports-123456789012';
const SITE = 'webapp-public-site-123456789012';

async function openTerminal(page: Page, name: string) {
  await search(page, 'instances', /インスタンス/);
  await content(page).getByRole('row', { name: new RegExp(name) }).getByRole('checkbox').check();
  await page.getByTestId('connect-instance').first().click();
  await page.getByTestId('eic-connect').click();
  await expect(page.getByTestId('terminal')).toBeVisible();
}

async function sh(page: Page, line: string) {
  const input = page.getByTestId('terminal-input');
  await input.fill(line);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

const lastOutput = (page: Page) => page.getByTestId('terminal-output').last();
const current = (page: Page) => panel(page).getByTestId('current-step');

test('21 ブロックパブリックアクセスを緩め、GetObject だけを公開するとオブジェクト URL が 200 になる', async ({ page }) => {
  await startLesson(page, 's3-public-access');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: SITE }).click();
  await content(page).getByRole('link', { name: 'index.html' }).click();
  await content(page).getByRole('tab', { name: 'プロパティ' }).click();
  const url = (await page.getByTestId('object-url').textContent())!.trim();
  await page.getByRole('button', { name: `${url} をコピー` }).click();
  await openBrowserTab(page);
  await pasteInto(page.getByTestId('browser-url').locator('input'));
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText('403');
  await openTalkTab(page);
  await validateOk(page);

  await nextUntilTask(page);
  await page.getByRole('link', { name: SITE }).first().click();
  await content(page).getByRole('tab', { name: 'アクセス許可' }).click();
  // a public policy is rejected while BlockPublicPolicy is on
  await page.getByTestId('edit-bucket-policy').click();
  await page.getByTestId('bucket-policy-editor').locator('textarea').fill(JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: `arn:aws:s3:::${SITE}/*` }] }));
  await page.getByTestId('save-bucket-policy').click();
  await expect(content(page)).toContainText('BlockPublicPolicy');
  await content(page).getByRole('button', { name: 'キャンセル' }).click();

  await page.getByTestId('edit-bpa').click();
  await page.getByTestId('bpa-blockPublicPolicy').locator('input').uncheck();
  await page.getByTestId('bpa-restrictPublicBuckets').locator('input').uncheck();
  await page.getByTestId('save-bpa').click();
  await expect(page.getByTestId('bpa-confirm')).toBeDisabled();
  await page.getByTestId('bpa-confirm-input').locator('input').fill('確認');
  await page.getByTestId('bpa-confirm').click();
  await expect(page.getByText(/ブロックパブリックアクセス設定が正常に編集されました/)).toBeVisible();
  await validateOk(page);

  await nextUntil(page, (step) => step.getByRole('button', { name: 'コードをコピー' }));
  await current(page).getByRole('button', { name: 'コードをコピー' }).click();
  await nextUntilTask(page);
  await page.getByTestId('edit-bucket-policy').click();
  await pasteInto(page.getByTestId('bucket-policy-editor').locator('textarea'));
  await page.getByTestId('save-bucket-policy').click();
  await expect(page.getByTestId('bucket-policy')).toContainText('PublicReadGetObject');
  await validateOk(page);

  await openBrowserTab(page);
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText('200');
  await expect(page.getByTestId('browser-body')).toContainText('Welcome to webapp');
  await openTalkTab(page);
  await validateOk(page);
  await answerQuiz(page, /保存できない/);
  await answerQuiz(page, /CloudFront/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('22 EC2 に IAM ロールを付けると get-caller-identity が assumed-role になる', async ({ page }) => {
  await startLesson(page, 'iam-role');
  await nextUntilTask(page);
  await openTerminal(page, 'batch-1');
  await sh(page, 'aws sts get-caller-identity');
  await expect(lastOutput(page)).toContainText('Unable to locate credentials');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'roles', /ロール/);
  await content(page).getByRole('link', { name: 'batch-role' }).click();
  await content(page).getByRole('tab', { name: '信頼関係' }).click();
  await expect(page.getByTestId('trust-policy')).toContainText('ec2.amazonaws.com');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'instances', /インスタンス/);
  await content(page).getByRole('row', { name: /batch-1/ }).getByRole('checkbox').check();
  await content(page).getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: 'IAM ロールを変更' }).click();
  await choose(page, 'iam-role-select', 'batch-role');
  await page.getByTestId('update-iam-role').click();
  await validateOk(page);

  await nextUntilTask(page);
  await openTerminal(page, 'batch-1');
  await sh(page, 'aws sts get-caller-identity');
  await expect(lastOutput(page)).toContainText('assumed-role/batch-role/');
  await sh(page, `aws s3 ls s3://${REPORTS}/reports/2026/09/`);
  await expect(lastOutput(page)).toContainText('report-2026-09-28.csv');
  await validateOk(page);
  await answerQuiz(page, /引き受けられず/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('23 AccessDenied: バケットポリシーの明示的な拒否 → IAM ポリシーの Resource の誤りの順に直す', async ({ page }) => {
  await startLesson(page, 'access-denied');
  await nextUntil(page, (step) => step.getByRole('button', { name: 'コードをコピー' }));
  await current(page).getByRole('button', { name: 'コードをコピー' }).click();
  await nextUntilTask(page);
  await openTerminal(page, 'batch-1');
  // pasting two lines runs the first; the second waits at the prompt
  await pasteInto(page.getByTestId('terminal-input'));
  await expect(lastOutput(page)).toContainText('(403) when calling the HeadObject operation');
  await expect(page.getByTestId('terminal-input')).toHaveValue('aws sts get-caller-identity');
  await page.getByTestId('terminal-input').press('Enter');
  await expect(lastOutput(page)).toContainText('assumed-role/batch-role/');
  await validateOk(page);

  await nextUntilTask(page);
  const get = `aws s3api get-object --bucket ${REPORTS} --key reports/2026/09/report-2026-09-28.csv report.csv`;
  await sh(page, get);
  await expect(lastOutput(page)).toContainText('with an explicit deny in a resource-based policy');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'buckets', /バケット/);
  await content(page).getByRole('link', { name: REPORTS }).click();
  await content(page).getByRole('tab', { name: 'アクセス許可' }).click();
  await page.getByTestId('edit-bucket-policy').click();
  const editor = page.getByTestId('bucket-policy-editor').locator('textarea');
  const policy = JSON.parse(await editor.inputValue());
  policy.Statement = policy.Statement.filter((s: { Sid: string }) => s.Sid !== 'DenyLegacyBatch');
  await editor.fill(JSON.stringify(policy, null, 2));
  await page.getByTestId('save-bucket-policy').click();
  await expect(page.getByTestId('bucket-policy')).not.toContainText('DenyLegacyBatch');
  await expect(page.getByTestId('bucket-policy')).toContainText('DenyInsecureTransport');
  await validateOk(page);

  await nextUntilTask(page);
  await openTerminal(page, 'batch-1');
  await page.getByTestId('terminal-input').press('ArrowUp');
  await expect(page.getByTestId('terminal-input')).toHaveValue(get);
  await page.getByTestId('terminal-input').press('Enter');
  await expect(lastOutput(page)).toContainText('because no identity-based policy allows the s3:GetObject action');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'roles', /ロール/);
  await content(page).getByRole('link', { name: 'batch-role' }).click();
  await content(page).getByRole('link', { name: 'batch-s3-read' }).click();
  await page.getByTestId('edit-policy').click();
  const doc = page.getByTestId('policy-editor').locator('textarea');
  await doc.fill((await doc.inputValue()).replaceAll('webapp-report-', 'webapp-reports-'));
  await page.getByTestId('save-policy').click();
  await expect(page.getByTestId('policy-document')).toContainText(`arn:aws:s3:::${REPORTS}/*`);
  await validateOk(page);

  await nextUntilTask(page);
  await openTerminal(page, 'batch-1');
  await sh(page, `aws s3 cp s3://${REPORTS}/reports/2026/09/report-2026-09-28.csv .`);
  await expect(lastOutput(page)).toContainText('download:');
  await sh(page, 'cat report-2026-09-28.csv');
  await expect(lastOutput(page)).not.toContainText('No such file');
  await validateOk(page);
  await answerQuiz(page, /明示的な拒否がすべてに優先/);
  await answerQuiz(page, /get-caller-identity で身分/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
