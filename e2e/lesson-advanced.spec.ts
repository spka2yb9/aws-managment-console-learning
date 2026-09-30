import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, choose, content, nextUntilTask, search, startLesson, validateOk } from './helpers';

const PROTECT_AUDIT = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', Action: ['cloudtrail:StopLogging', 'cloudtrail:DeleteTrail'], Resource: '*' }] }, null, 2);
const TOKYO_ONLY = JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Deny', NotAction: ['iam:*', 'organizations:*', 'sts:*', 'route53:*', 'cloudfront:*', 'support:*'], Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': ['ap-northeast-1'] } } }] }, null, 2);

async function actionMenu(page: Page, testId: string, item: string) {
  await page.getByTestId(testId).getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** point a private route table's default route at another NAT gateway */
async function repointRoute(page: Page, table: string, natId: string) {
  await search(page, 'route tables', /ルートテーブル/);
  await content(page).getByRole('row', { name: new RegExp(table) }).getByRole('link').first().click();
  await content(page).getByRole('tab', { name: 'ルート' }).click();
  await page.getByTestId('edit-routes').click();
  await page.getByTestId('route-target-0').locator('input').fill(natId);
  await page.getByTestId('route-target-0').locator('input').press('Escape');
  await page.getByTestId('save-routes').click();
  await expect(page.getByTestId('routes-table')).toContainText(natId);
}

async function deleteNat(page: Page, name: string) {
  await page.getByTestId('nat-table').getByRole('row', { name: new RegExp(name) }).getByRole('radio').check();
  await actionMenu(page, 'nat-actions', 'NAT ゲートウェイを削除');
  await page.getByTestId('delete-nat-input').locator('input').fill('削除');
  await page.getByTestId('delete-nat-confirm').click();
  await expect(page.getByTestId('nat-table').getByRole('row', { name: new RegExp(name) })).toContainText(/削除/);
}

/** AWS access portal: sign in as user to account with a permission set and call one API */
async function tryAccess(page: Page, user: string, account: string, ps: string, action: string, region: RegExp, expected: string | RegExp) {
  await search(page, 'access portal', /AWS アクセスポータル/);
  await choose(page, 'portal-user', new RegExp(`^${user}`));
  await page.getByTestId(`portal-try-${account}-${ps}`).click();
  const input = page.getByTestId('portal-action').locator('input');
  await input.fill(action);
  await input.press('Escape');
  await choose(page, 'portal-region', region);
  await page.getByTestId('portal-run').click();
  await expect(page.getByTestId('portal-result')).toContainText(expected);
}

test('39 コスト: 開発 DB をシングル AZ、S3 エンドポイント、NAT を 1 つに、デバッグログを 7 日 → 予算内', async ({ page }) => {
  test.setTimeout(180_000);
  await startLesson(page, 'cost-tradeoffs');
  await nextUntilTask(page);
  await search(page, 'cost', /コストと予算|請求とコスト管理/);
  await expect(page.getByTestId('budget')).toContainText('予測が予算を超えています');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'databases', /データベース/);
  await content(page).getByRole('link', { name: 'dev-db' }).click();
  await page.getByTestId('modify-db').click();
  await page.getByTestId('modify-db-multiaz').getByText('スタンバイインスタンスを作成しないでください').click();
  await choose(page, 'modify-db-retention', /^7 日$/);
  await page.getByTestId('modify-db-continue').click();
  await page.getByTestId('modify-db-submit').click();
  await expect(page.getByText(/DB インスタンス dev-db が正常に変更されました/)).toBeVisible();
  await search(page, 'snapshots', /スナップショット/);
  for (const snap of ['dev-db-before-migration-01', 'dev-db-before-migration-02', 'dev-db-test-2026-06', 'dev-db-test-2026-07']) {
    await page.getByTestId('manual-snapshots').getByRole('row', { name: new RegExp(snap) }).getByRole('radio').check();
    await actionMenu(page, 'snapshot-actions', 'スナップショットを削除');
    await expect(page.getByTestId('manual-snapshots').getByRole('row', { name: new RegExp(snap) })).toHaveCount(0);
  }
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'endpoints', /エンドポイント/);
  await page.getByTestId('create-endpoint').click();
  await choose(page, 'endpoint-vpc', /dev-vpc/);
  for (const az of ['1a', '1c', '1d']) await page.getByTestId(`endpoint-rt-dev-private-rt-${az}`).locator('input').check();
  await page.getByTestId('create-endpoint-submit').click();
  await expect(page.getByTestId('endpoint-table')).toContainText('com.amazonaws.ap-northeast-1.s3');
  await search(page, 'nat gateways', /NAT ゲートウェイ/);
  const nat1a = (await page.getByTestId('nat-table').getByRole('row', { name: /dev-nat-1a/ }).getByRole('link').textContent())!.trim();
  await repointRoute(page, 'dev-private-rt-1c', nat1a);
  await repointRoute(page, 'dev-private-rt-1d', nat1a);
  await search(page, 'nat gateways', /NAT ゲートウェイ/);
  await deleteNat(page, 'dev-nat-1c');
  await deleteNat(page, 'dev-nat-1d');
  await expect(page.getByTestId('nat-table').getByRole('row', { name: /dev-nat-1d/ })).toContainText('削除済み', { timeout: 15_000 });
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'log groups', /ロググループ/);
  await content(page).getByRole('link', { name: '/webapp/dev/debug' }).click();
  await actionMenu(page, 'log-group-actions', '保持設定を編集');
  await choose(page, 'retention-select', /^7 日$/);
  await page.getByTestId('retention-save').click();
  await expect(page.getByTestId('log-retention')).toHaveText('7 日');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'cost', /コストと予算|請求とコスト管理/);
  await expect(page.getByTestId('budget')).toContainText('予算内');
  await validateOk(page);
  await answerQuiz(page, /AZ が障害になると/);
  await answerQuiz(page, /ゲートウェイエンドポイント/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('40 Organizations: webapp-prod を Production へ → SCP で CloudTrail 停止を禁止 (Root) → Development は東京のみ', async ({ page }) => {
  test.setTimeout(180_000);
  await startLesson(page, 'organizations-scp');
  await nextUntilTask(page);
  await page.getByTestId('org-tree').getByRole('link', { name: 'webapp-prod' }).click();
  await expect(page.getByTestId('org-path')).toHaveText('Root / webapp-prod');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'organizations accounts', /AWS アカウント/);
  await page.getByRole('radio', { name: 'webapp-prod を選択' }).check();
  await page.getByTestId('org-move').click();
  await choose(page, 'move-destination', /^Production/);
  await page.getByTestId('move-submit').click();
  await expect(page.getByText('webapp-prod を Production に移動しました')).toBeVisible();
  await tryAccess(page, 'sato', '333333333333', 'AdministratorAccess', 'rds:DeleteDBSnapshot', /ap-northeast-1/, 'with an explicit deny in a service control policy');
  await validateOk(page);

  for (const [name, doc, target] of [['protect-audit', PROTECT_AUDIT, /^Root/], ['dev-tokyo-only', TOKYO_ONLY, /^Development/]] as const) {
    await nextUntilTask(page);
    await search(page, 'scp', /サービスコントロールポリシー/);
    await page.getByTestId('create-scp').click();
    await page.getByTestId('scp-name').locator('input').fill(name);
    await page.getByTestId('scp-editor').locator('textarea').fill(doc);
    await page.getByTestId('create-scp-submit').click();
    await page.getByTestId('scp-attach').click();
    await choose(page, 'attach-scp-select', target);
    await page.getByTestId('attach-scp-submit').click();
    await expect(page.getByTestId('scp-targets')).toContainText(target.source.slice(1));
    if (name === 'dev-tokyo-only') await tryAccess(page, 'node', '555555555555', 'AdministratorAccess', 'ec2:RunInstances', /us-east-1/, 'with an explicit deny in a service control policy');
    await validateOk(page);
  }
  await answerQuiz(page, /^使えない/);
  await answerQuiz(page, /^効かない/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('41 Identity Center: 全員が本番の管理者 → ReadOnlyAccess を作成 → 本番の割り当てを差し替え → ポータルで確認', async ({ page }) => {
  test.setTimeout(120_000);
  await startLesson(page, 'identity-center');
  await nextUntilTask(page);
  await search(page, 'access portal', /AWS アクセスポータル/);
  await choose(page, 'portal-user', /^node/);
  await expect(page.getByTestId('portal-accounts')).toContainText('AdministratorAccess');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'permission sets', /許可セット/);
  await page.getByTestId('create-permission-set').click();
  await page.getByTestId('create-permission-set-submit').click();
  await expect(page.getByTestId('permission-sets')).toContainText('ReadOnlyAccess');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'accounts assignments', /AWS アカウント \(割り当て\)/);
  await content(page).getByRole('link', { name: 'webapp-prod' }).click();
  await page.getByTestId('assign-access').click();
  await choose(page, 'assign-principal', /^Developers/);
  await choose(page, 'assign-permission-set', /^ReadOnlyAccess/);
  await page.getByTestId('assign-submit').click();
  await page.getByRole('radio', { name: 'Developers AdministratorAccess を選択' }).check();
  await page.getByTestId('remove-access').click();
  await expect(page.getByTestId('sso-assignments').getByRole('row', { name: /Developers/ })).toHaveCount(1);
  await validateOk(page);

  await nextUntilTask(page);
  await tryAccess(page, 'node', '333333333333', 'ReadOnlyAccess', 'ec2:DescribeInstances', /ap-northeast-1/, '許可されました');
  await tryAccess(page, 'node', '333333333333', 'ReadOnlyAccess', 'ec2:TerminateInstances', /ap-northeast-1/, 'because no identity-based policy allows the ec2:TerminateInstances action');
  await validateOk(page);
  await answerQuiz(page, /一時的な認証情報/);
  await answerQuiz(page, /両方が許可/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
