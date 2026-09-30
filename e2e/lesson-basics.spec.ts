import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, choose, content, filterTable, nextUntil, nextUntilTask, search, startLesson, validateOk } from './helpers';

/** Fill the サブネットを作成 form (VPC webapp-vpc) and submit it. */
async function createSubnet(page: Page, name: string, cidr: string, az?: string) {
  await choose(page, 'subnet-vpc', /webapp-vpc/);
  await page.getByTestId('subnet-name').locator('input').fill(name);
  if (az) await choose(page, 'subnet-az', new RegExp(az));
  await page.getByTestId('subnet-cidr').locator('input').fill(cidr);
  await page.getByTestId('create-subnet-submit').click();
}

test('Lesson 01 AWSとは: 検索バーで EC2 インスタンスと VPC を開き、責任共有モデルのクイズに答える', async ({ page }) => {
  await startLesson(page, 'what-is-aws');
  await nextUntilTask(page);
  await search(page, 'ec2', /^EC2.*仮想サーバー/);
  await page.getByRole('navigation').getByRole('link', { name: 'インスタンス', exact: true }).click();
  await expect(content(page).getByTestId('instances-table')).toContainText('web-1');
  await search(page, 'vpc', /^VPC.*独立したクラウドリソース/);
  await validateOk(page);
  await nextUntilTask(page);
  await answerQuiz(page, /^利用者/);
  await nextUntil(page, (s) => s.getByTestId('lesson-complete'));
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('Lesson 04 CIDR: VPC の外の CIDR はエラー、内側の 10.0.100.0/24 で作成できる', async ({ page }) => {
  await startLesson(page, 'cidr');
  await nextUntilTask(page);
  await answerQuiz(page, '251 個');
  await answerQuiz(page, /10\.0\.5\.0\/24/);
  await nextUntilTask(page);

  await content(page).getByRole('button', { name: 'サブネットを作成' }).click();
  await createSubnet(page, 'cidr-practice', '10.1.0.0/24');
  await expect(content(page).getByText("The CIDR '10.1.0.0/24' is invalid.").first()).toBeVisible();
  await page.getByTestId('subnet-cidr').locator('input').fill('10.0.100.0/24');
  await page.getByTestId('create-subnet-submit').click();
  await expect(page.getByText(/1 個のサブネットが正常に作成されました/)).toBeVisible();
  await validateOk(page);

  await nextUntilTask(page);
  await answerQuiz(page, /10\.0\.2\.0\/24/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('Lesson 05 Subnet: 2 つの AZ に public-subnet-1a / 1c を作成する', async ({ page }) => {
  await startLesson(page, 'subnet');
  await nextUntilTask(page);

  await content(page).getByRole('button', { name: 'サブネットを作成' }).click();
  await createSubnet(page, 'public-subnet-1a', '10.0.1.0/24', 'ap-northeast-1a');
  await expect(page.getByText(/1 個のサブネットが正常に作成されました/)).toBeVisible();
  await search(page, 'subnets', /サブネット.*VPC の機能/);
  await content(page).getByRole('button', { name: 'サブネットを作成' }).click();
  await createSubnet(page, 'public-subnet-1c', '10.0.2.0/24', 'ap-northeast-1c');
  await expect(content(page)).toContainText('ap-northeast-1c');
  await search(page, 'subnets', /サブネット.*VPC の機能/);
  await filterTable(page, 'public-subnet');
  await expect(content(page).getByRole('link', { name: /^subnet-/ })).toHaveCount(2);
  await validateOk(page);

  await nextUntilTask(page);
  await answerQuiz(page, /^いいえ/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});

test('Lesson 08 Internet Gateway: IGW を作成・アタッチし、public-rt に 0.0.0.0/0 → IGW を追加する', async ({ page }) => {
  await startLesson(page, 'internet-gateway');
  await nextUntilTask(page);

  await page.getByTestId('create-igw').click();
  await page.getByTestId('igw-name').locator('input').fill('webapp-igw');
  await page.getByTestId('create-igw-submit').click();
  await expect(content(page)).toContainText('Detached');
  await page.getByTestId('igw-actions').getByRole('button', { name: 'アクション' }).click();
  await page.getByRole('menuitem', { name: 'VPC にアタッチ' }).click();
  await page.getByTestId('attach-igw-vpc').locator('input').click();
  await page.getByRole('option', { name: /webapp-vpc/ }).click();
  await page.getByTestId('attach-igw-submit').click();
  await expect(page.getByText(/に正常にアタッチされました/)).toBeVisible();
  await expect(content(page)).toContainText('Attached');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'route tables', /ルートテーブル/);
  await filterTable(page, 'public-rt');
  await content(page).getByRole('link', { name: /^rtb-/ }).first().click();
  await page.getByTestId('edit-routes').click();
  await page.getByTestId('add-route').click();
  await page.getByTestId('route-dest-0').locator('input').fill('0.0.0.0/0');
  await page.getByTestId('route-target-0').locator('input').fill('igw-');
  await page.getByRole('option', { name: /webapp-igw/ }).click();
  await page.getByTestId('save-routes').click();
  await expect(page.getByText(/のルートが正常に更新されました/)).toBeVisible();
  await expect(page.getByTestId('routes-table')).toContainText('0.0.0.0/0');
  await expect(page.getByTestId('routes-table')).toContainText('アクティブ');
  await validateOk(page);

  await nextUntilTask(page);
  await answerQuiz(page, /ブラックホール/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
