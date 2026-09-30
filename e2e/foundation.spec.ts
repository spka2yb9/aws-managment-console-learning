import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

test('navigation, reload and direct access work with hash routing', async ({ page }) => {
  await page.goto('./');
  await expect(page).toHaveURL(/#\/courses$/);
  await expect(page.getByRole('heading', { name: 'Courses', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Progress' }).click();
  await expect(page.getByRole('heading', { name: 'Progress', level: 1 })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Progress', level: 1 })).toBeVisible();
  await page.goto('./#/prompt');
  await expect(page.getByRole('heading', { name: 'Prompt', level: 1 })).toBeVisible();
  await page.goto('./#/no-such-page');
  await expect(page).toHaveURL(/#\/courses$/);
});

test('Prompt page shows the full prompt and copies it', async ({ page }) => {
  const prompt = readFileSync('src/prompt/prompt.md', 'utf8');
  await page.goto('./#/prompt');
  await expect(page.getByTestId('prompt-text')).toContainText('Phase 16 — Cost / Multi-account / Advanced');
  await page.getByRole('button', { name: 'Copy Prompt' }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(prompt);
});
