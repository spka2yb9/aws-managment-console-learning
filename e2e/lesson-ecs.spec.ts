import { expect, test, type Page } from '@playwright/test';
import { answerQuiz, browseAlb, choose, content, nextUntilTask, search, startLesson, validateOk } from './helpers';

async function openService(page: Page) {
  await search(page, 'clusters', /クラスター/);
  await content(page).getByRole('link', { name: 'webapp-cluster' }).click();
  await content(page).getByRole('link', { name: 'webapp-svc' }).click();
}

/** new revision from `from` with the image tag replaced, then point the service at it */
async function deploy(page: Page, from: string, tag: string, revision: string) {
  await search(page, 'task definitions', /タスク定義/);
  await content(page).getByRole('link', { name: from }).click();
  await page.getByTestId('new-revision').click();
  const image = page.getByTestId('revision-image').locator('input');
  await image.fill((await image.inputValue()).replace(/:[^:/]+$/, `:${tag}`));
  await page.getByTestId('revision-submit').click();
  await expect(page.getByText(`タスク定義 ${revision} が正常に作成されました`)).toBeVisible();
  await openService(page);
  await page.getByTestId('update-service').click();
  await choose(page, 'service-td', new RegExp(`${revision}(?!\\d)`));
  await page.getByTestId('update-service-submit').click();
  await expect(page.getByText('サービス webapp-svc が更新されました').first()).toBeVisible();
}

test('32 ECS: v1 → :v2 は CannotPullContainerError (v1 は動き続ける) → ECR で本当のタグ → v2.0 にローリングデプロイ', async ({ page }) => {
  test.setTimeout(120_000);
  await startLesson(page, 'ecs-fargate');
  await nextUntilTask(page);
  await content(page).getByRole('link', { name: 'webapp-cluster' }).click();
  await content(page).getByRole('link', { name: 'webapp-svc' }).click();
  await expect(page.getByTestId('service-counts')).toContainText('2 実行中');
  await browseAlb(page, /200/, 'webapp v1');
  await validateOk(page);

  await nextUntilTask(page);
  await deploy(page, 'webapp:1', 'v2', 'webapp:2');
  await validateOk(page);

  await nextUntilTask(page);
  await content(page).getByRole('tab', { name: 'タスク' }).click();
  await page.getByTestId('task-filter').getByRole('button', { name: '停止済み' }).click();
  await expect(page.getByTestId('ecs-tasks').getByRole('link').first()).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('ecs-tasks').getByRole('link').first().click();
  await expect(page.getByTestId('stopped-reason')).toContainText('CannotPullContainerError');
  await expect(page.getByTestId('stopped-reason')).toContainText('webapp:v2: not found');
  await browseAlb(page, /200/, 'webapp v1');
  await validateOk(page);

  await nextUntilTask(page);
  await search(page, 'repositories', /プライベートリポジトリ/);
  await content(page).getByRole('link', { name: 'webapp' }).click();
  await expect(page.getByTestId('ecr-images')).toContainText('v2.0');
  await deploy(page, 'webapp:2', 'v2.0', 'webapp:3');
  await expect(page.getByTestId('deployment-state')).toContainText('完了', { timeout: 30_000 });
  await browseAlb(page, /200/, 'webapp v2.0');
  await validateOk(page);
  await answerQuiz(page, /古いタスク \(v1\) が応答し続けた/);
  await answerQuiz(page, /新しいリビジョン/);
  await expect(page.getByTestId('lesson-complete')).toBeVisible();
});
