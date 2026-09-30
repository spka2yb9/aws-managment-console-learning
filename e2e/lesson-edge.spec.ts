import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, choose, content, nextUntilTask, openBrowserTab, openTalkTab, search, startLesson, validateOk } from './helpers';

const APEX = 'webapp-shop.example';
const WWW = `www.${APEX}`;

/** open a URL in the simulated browser and check the status line (and body) */
async function go(page: Page, url: string, status: RegExp, body?: string, headers?: string) {
  await openBrowserTab(page);
  await page.getByTestId('browser-url').locator('input').fill(url);
  await page.getByTestId('browser-go').click();
  await expect(page.getByTestId('browser-status')).toContainText(status);
  if (body) await expect(page.getByTestId('browser-body')).toContainText(body);
  if (headers) await expect(page.getByTestId('browser-headers')).toContainText(headers);
  await openTalkTab(page);
}

async function distributionDomain(page: Page) {
  await search(page, 'distributions', /ディストリビューション/);
  return (await content(page).getByTestId('distributions').getByText(/cloudfront\.net/).first().textContent())!.trim();
}

test('35 Route 53: www なしが引けない → ホストゾーン → Zone Apex は CNAME 不可、エイリアス A で ALB へ', async ({ page }) => {
  await startLesson(page, 'route53-dns');
  await nextUntilTask(page);
  await go(page, `http://${WWW}`, /HTTP 200/);
  await go(page, `http://${APEX}`, /ERR_NAME_NOT_RESOLVED/);
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByRole('link', { name: APEX }).click();
  const alb = (await page.getByTestId('dns-records').getByText(/elb\.amazonaws\.com/).first().textContent())!.trim().replace(/\.$/, '');
  await validateOk(page);

  await nextUntilTask(page);
  await page.getByTestId('create-record').click();
  await choose(page, 'record-type', /^CNAME/);
  await page.getByTestId('record-value').locator('textarea').fill(alb);
  await page.getByTestId('create-record-submit').click();
  await expect(page.getByTestId('form-error').first()).toContainText('is not permitted at apex');
  await choose(page, 'record-type', /^A(\s|$)/);
  await page.getByTestId('record-alias').locator('input').check();
  await choose(page, 'alias-target', new RegExp(alb.replace(/\./g, '\\.')));
  await page.getByTestId('create-record-submit').click();
  await expect(page.getByTestId('dns-records').getByRole('row', { name: new RegExp(`^.*${APEX.replace(/\./g, '\\.')} A シンプル はい`) })).toBeVisible();
  await go(page, `http://${APEX}`, /HTTP 200/);
  await validateOk(page);
  await answerQuiz(page, /^A レコード \(エイリアス\)/);
  await answerQuiz(page, /^最大 300 秒/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('36 ACM: www だけ証明書エラー → us-east-1 で www を含む証明書 → DNS 検証 → CloudFront に代替ドメイン名と証明書', async ({ page }) => {
  await startLesson(page, 'acm-certificate');
  await nextUntilTask(page);
  await go(page, `https://${WWW}`, /ERR_CERT_COMMON_NAME_INVALID/);
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByTestId('distributions').getByRole('link').first().click();
  await expect(page.getByTestId('distribution-aliases')).toHaveText(APEX);
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'certificate manager', /Certificate Manager/);
  await page.getByRole('button', { name: /リージョン:/ }).click();
  await page.getByRole('menuitem', { name: /米国東部 \(バージニア北部\)/ }).click();
  await page.getByTestId('request-certificate').click();
  await page.getByTestId('cert-name-0').locator('input').fill(APEX);
  await page.getByTestId('cert-name-add').click();
  await page.getByTestId('cert-name-1').locator('input').fill(WWW);
  await page.getByTestId('request-certificate-submit').click();
  await expect(page.getByTestId('cert-status')).toContainText('検証保留中');
  await page.getByTestId('acm-create-records').click();
  await expect(page.getByTestId('cert-status')).toContainText('発行済み', { timeout: 15_000 });
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'distributions', /ディストリビューション/);
  await content(page).getByTestId('distributions').getByRole('link').first().click();
  await page.getByTestId('edit-distribution').click();
  await page.getByTestId('alias-add').click();
  await page.getByTestId('alias-1').locator('input').fill(WWW);
  await choose(page, 'distribution-cert-select', new RegExp(`${APEX}, ${WWW}`.replace(/\./g, '\\.')));
  await page.getByTestId('edit-distribution-submit').click();
  await expect(page.getByTestId('distribution-aliases')).toContainText(WWW);
  await expect(page.getByTestId('distribution-status')).not.toContainText('デプロイ中', { timeout: 15_000 });
  await go(page, `https://${WWW}`, /HTTP 200/);
  await validateOk(page);
  await answerQuiz(page, /^米国東部/);
  await answerQuiz(page, /^webapp-shop\.example$/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('37 CloudFront: X-Cache Hit で古いページ → TTL 1 日 → /index.html を無効化 → 新しいページ', async ({ page }) => {
  await startLesson(page, 'cloudfront-cache');
  await nextUntilTask(page);
  const domain = await distributionDomain(page);
  await go(page, `https://${domain}`, /HTTP 200/, '夏のセール', 'X-Cache: Hit from cloudfront');
  await search(page, 'buckets', /バケット/);
  await content(page).getByRole('link', { name: 'webapp-static-123456789012' }).click();
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'distributions', /ディストリビューション/);
  await content(page).getByTestId('distributions').getByRole('link').first().click();
  await content(page).getByRole('tab', { name: 'ビヘイビア' }).click();
  await expect(page.getByTestId('behavior-ttl')).toHaveText('86400');
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByRole('tab', { name: '無効化' }).click();
  await page.getByTestId('create-invalidation').click();
  await page.getByTestId('invalidation-paths').locator('textarea').fill('/index.html');
  await page.getByTestId('create-invalidation-submit').click();
  await expect(page.getByTestId('invalidations').getByRole('row', { name: /index\.html 完了/ })).toBeVisible({ timeout: 10_000 });
  await go(page, `https://${domain}`, /HTTP 200/, '秋のキャンペーン', 'X-Cache: Miss from cloudfront');
  await validateOk(page);
  await answerQuiz(page, /ファイル名にバージョン/);
  await answerQuiz(page, /^1 パス$/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('38 WAF: 社内から 403 → サンプルで block-bad-ips → IP セットを /32 に → <script> はマネージドルールでブロック', async ({ page }) => {
  await startLesson(page, 'waf-blocked');
  await nextUntilTask(page);
  const domain = await distributionDomain(page);
  await go(page, `https://${domain}`, /HTTP 403/, 'Request blocked');
  await search(page, 'web acls', /ウェブ ACL/);
  await content(page).getByRole('link', { name: 'webapp-acl' }).click();
  await expect(page.getByTestId('waf-samples').getByRole('row', { name: /198\.51\.100\.24 BLOCK block-bad-ips/ })).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByRole('tab', { name: 'ルール' }).click();
  await content(page).getByRole('link', { name: /IP セット bad-ips/ }).click();
  await page.getByTestId('edit-ipset').click();
  await page.getByTestId('ipset-editor').locator('textarea').fill('198.51.100.77/32');
  await page.getByTestId('edit-ipset-submit').click();
  await expect(page.getByTestId('ipset-addresses')).toContainText('198.51.100.77/32');
  await validateOk(page);

  await nextUntilTask(page);
  await go(page, `https://${domain}`, /HTTP 200/);
  await go(page, `https://${domain}/?q=<script>alert(1)</script>`, /HTTP 403/);
  await validateOk(page);
  await answerQuiz(page, /^256 個$/);
  await answerQuiz(page, /^まず Count/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
