import { expect, test, type Page } from '@playwright/test';
import { nextUntilTask } from './helpers';

/** type into the xterm terminal (it listens on its hidden textarea) */
async function typeCommand(page: Page, line: string) {
  await page.getByTestId('cli-terminal').locator('.xterm-screen').click();
  await page.keyboard.type(line);
  await page.keyboard.press('Enter');
}

test('CLI lesson: typing aws commands completes the exercise and moves on', async ({ page }) => {
  await page.goto('./#/cli');
  await expect(page.getByRole('heading', { name: 'Courses (AWS CLI)', level: 1 })).toBeVisible();
  await page.getByTestId('start-what-is-aws').click();
  await expect(page.getByTestId('lesson-panel')).toBeVisible();
  // the terminal is ready when the banner is shown
  await expect(page.getByTestId('cli-terminal')).toContainText('aws help', { timeout: 30_000 });
  await nextUntilTask(page);
  await expect(page.getByTestId('current-objective')).toContainText('aws ec2 describe-instances');

  await typeCommand(page, 'aws ec2 describe-instances');
  await expect(page.getByTestId('cli-terminal')).toContainText('"OwnerId": "123456789012"');
  await expect(page.getByTestId('task-list').locator('li').first()).toHaveAttribute('data-done', 'true');

  // the example command can be typed into the terminal from the hint
  await page.getByTestId('show-command').click();
  await expect(page.getByTestId('command-example')).toHaveText('aws ec2 describe-vpcs');
  await page.getByTestId('insert-command').click();
  await page.keyboard.press('Enter');

  // all tasks done and validation passes: the lesson moves on without pressing 検証する
  await expect(page.getByTestId('result-ok')).toBeVisible();
});

test('CLI lesson: progress and the simulated account survive a reload', async ({ page }) => {
  await page.goto('./#/cli/lessons/vpc');
  await expect(page.getByTestId('cli-terminal')).toContainText('aws help', { timeout: 30_000 });
  await typeCommand(page, "aws ec2 create-vpc --cidr-block 10.0.0.0/16 --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=webapp-vpc}]' --query Vpc.CidrBlock --output text");
  await expect(page.getByTestId('cli-terminal')).toContainText('10.0.0.0/16');
  await page.reload();
  await expect(page.getByTestId('cli-terminal')).toContainText('aws help', { timeout: 30_000 });
  // the new terminal does not show the earlier output: the CIDR can only come from the restored account
  await typeCommand(page, "aws ec2 describe-vpcs --filters Name=tag:Name,Values=webapp-vpc --query 'Vpcs[0].CidrBlock' --output text");
  await expect(page.getByTestId('cli-terminal')).toContainText('10.0.0.0/16');
});

test('CLI terminal: the prompt stays on screen after the window shrinks', async ({ page }) => {
  await page.goto('./#/cli/lessons/vpc');
  const term = page.getByTestId('cli-terminal');
  await expect(term).toContainText('aws help', { timeout: 30_000 });
  await typeCommand(page, 'seq 1 80');
  await expect(term).toContainText('80');
  await page.setViewportSize({ width: 900, height: 600 });
  // the terminal is refitted to the smaller window: its rows end inside the window, so the prompt line is visible
  await expect.poll(async () => (await term.locator('.xterm-screen').boundingBox())!.y + (await term.locator('.xterm-screen').boundingBox())!.height).toBeLessThanOrEqual(600);
});
