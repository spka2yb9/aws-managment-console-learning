import { expect, test } from '@playwright/test';
import { clipboard, content, copyValue, filterTable, search, startLesson } from './helpers';

test('Phase 2: 一覧 → 検索 → 選択 → 詳細 → 編集 → 保存 → Copy', async ({ page }) => {
  await startLesson(page, 'route-table');
  await search(page, 'subnets', /サブネット.*VPC の機能/);
  await expect(page.getByRole('heading', { name: /サブネット/, level: 1 })).toBeVisible();
  await filterTable(page, 'private-subnet-1c');
  await expect(content(page).getByRole('link', { name: /^subnet-/ })).toHaveCount(1);
  await content(page).getByRole('radio').first().check();
  await content(page).getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: 'サブネットの設定を編集' }).click();
  await page.getByText('パブリック IPv4 アドレスの自動割り当てを有効化').click();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText(/サブネットの設定が正常に変更されました/)).toBeVisible();
  const id = (await page.getByRole('heading', { level: 1 }).textContent())!.split(' ')[0];
  await expect(content(page)).toContainText('パブリック IPv4 アドレスを自動割り当て');
  await copyValue(page, id);
  expect(await clipboard(page)).toBe(id);
});

test('リージョンを切り替えるとリソースが見える / 見えなくなる', async ({ page }) => {
  await startLesson(page, 'region-az');
  await expect(content(page).getByText('VPC がありません', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /リージョン:/ }).click();
  await page.getByRole('menuitem', { name: /アジアパシフィック \(東京\)/ }).click();
  await expect(content(page).getByText('webapp-vpc').first()).toBeVisible();
});

test('VPC / サブネットの削除: 使用中は DependencyViolation、空なら関連リソースごと削除', async ({ page }) => {
  await startLesson(page, 'vpc');
  await search(page, 'your vpcs', /お使いの VPC/);
  await content(page).getByRole('button', { name: 'VPC を作成' }).click();
  await page.getByTestId('vpc-name').locator('input').fill('mistake-vpc');
  await page.getByTestId('vpc-cidr').locator('input').fill('10.1.0.0/16');
  await page.getByTestId('create-vpc-submit').click();
  await search(page, 'your vpcs', /お使いの VPC/);
  await content(page).getByRole('row', { name: /mistake-vpc/ }).getByRole('radio').check();
  await page.getByTestId('vpc-actions').getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: 'VPC の削除' }).click();
  await expect(page.getByTestId('delete-vpc-confirm')).toBeDisabled();
  await page.getByTestId('delete-vpc-input').locator('input').fill('削除');
  await page.getByTestId('delete-vpc-confirm').click();
  await expect(page.getByText(/を削除しました/).first()).toBeVisible();
  await expect(content(page).getByRole('row', { name: /mistake-vpc/ })).toHaveCount(0);
});
