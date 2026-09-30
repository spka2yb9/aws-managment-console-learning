import { expect, test, type Page } from '@playwright/test';
import { startLesson } from './helpers';

async function savedFor(page: Page, lessonId: string) {
  return page.evaluate(async (id) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('aws-learning-simulator');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const transaction = database.transaction(['progress', 'sessions'], 'readonly');
      const get = (store: string) => new Promise<boolean>((resolve, reject) => {
        const request = transaction.objectStore(store).get(id);
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
      });
      const [progress, session] = await Promise.all([get('progress'), get('sessions')]);
      return { progress, session };
    } finally {
      database.close();
    }
  }, lessonId);
}

test('Progress can reset one lesson or a course without clearing other lessons', async ({ page }) => {
  for (const id of ['what-is-aws', 'region-az', 'vpc']) {
    await startLesson(page, id);
    await expect.poll(() => savedFor(page, id)).toEqual({ progress: true, session: true });
  }

  await page.goto('./#/progress');
  await page.getByTestId('reset-lesson-what-is-aws').click();
  await expect(page.getByRole('dialog')).toContainText('進捗と保存された学習状態を削除');
  await page.getByRole('button', { name: 'キャンセル' }).click();
  expect(await savedFor(page, 'what-is-aws')).toEqual({ progress: true, session: true });

  await page.getByTestId('reset-lesson-what-is-aws').click();
  await page.getByRole('button', { name: 'リセットする' }).click();
  await expect.poll(() => savedFor(page, 'what-is-aws')).toEqual({ progress: false, session: false });
  await expect(page.getByTestId('reset-lesson-what-is-aws')).toBeDisabled();
  expect(await savedFor(page, 'region-az')).toEqual({ progress: true, session: true });
  expect(await savedFor(page, 'vpc')).toEqual({ progress: true, session: true });

  await page.getByTestId('reset-course-basics').click();
  await page.getByRole('button', { name: 'リセットする' }).click();
  await expect.poll(() => savedFor(page, 'region-az')).toEqual({ progress: false, session: false });
  expect(await savedFor(page, 'vpc')).toEqual({ progress: true, session: true });
  await expect(page.getByTestId('reset-course-basics')).toBeDisabled();
});
