/* CLI 版のレッスン画面のモンキーテスト: ターミナルへのでたらめなキー入力・貼り付けと、レッスンパネルのボタンのでたらめなクリック。
   ページの例外 (pageerror) と console.error が出たら負け。最後にターミナルがまだ応答するかを確かめる。
   MONKEY_SEED / MONKEY_STEPS で再現・増量できる */
import { expect, test, type Page } from '@playwright/test';

const SEED = Number(process.env.MONKEY_SEED ?? 1);
const STEPS = Number(process.env.MONKEY_STEPS ?? 150);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ['aws ', 'ec2 ', 's3 ', 'describe-', 'describe-instances ', 'help ', '--query ', "'Vpcs[0]' ", '--output ', 'table ', 'text ', '| ', 'head ', '$(', ')', '"', "'", '\\', 'curl ', 'ls ', 'cd ..', 'echo ', '; ', '&& ', 'sleep 1 ', 'for i in 1 2; do echo $i; done', 'aws ec2 wait instance-running ', 'aws configure ', 'exit', '日本語', '😀', '\t'];
const KEYS = ['Enter', 'Enter', 'Tab', 'Backspace', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete', 'Escape', 'Control+C', 'Control+L', 'Control+A', 'Control+E', 'Control+U', 'Control+W', 'Control+K', 'Control+D', 'Control+R', 'PageUp'];
const BUTTONS = ['next', 'show-command', 'insert-command', 'validate', 'retry', 'open-browser-tab', 'answer'];

async function monkey(page: Page, r: () => number, steps: number) {
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const term = page.getByTestId('cli-terminal').locator('.xterm-screen');
  for (let i = 0; i < steps; i++) {
    const roll = r();
    if (roll < 0.45) {
      await term.click();
      await page.keyboard.type(pick(WORDS));
    } else if (roll < 0.75) {
      await term.click();
      await page.keyboard.press(pick(KEYS));
    } else if (roll < 0.8) {
      await term.click();
      // 貼り付け (改行を含む)
      await page.keyboard.insertText(Array.from({ length: 1 + Math.floor(r() * 3) }, () => pick(WORDS)).join('\n'));
    } else if (roll < 0.95) {
      const b = page.getByTestId(pick(BUTTONS));
      const n = await b.count();
      if (n) await b.nth(Math.floor(r() * n)).click({ timeout: 1000 }).catch(() => {});
    } else if (roll < 0.98) {
      const tab = page.getByRole('tab', { name: pick(['会話', '構成図']) });
      if (await tab.count()) await tab.first().click({ timeout: 1000 }).catch(() => {});
    } else {
      await page.setViewportSize({ width: 700 + Math.floor(r() * 1000), height: 500 + Math.floor(r() * 600) });
    }
    if (r() < 0.3) await page.waitForTimeout(50);
  }
}

for (const lesson of ['what-is-aws', 'web-connectivity', 'anti-ddos', 'session-manager']) {
  test(`CLI monkey: ${lesson}`, async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => m.type() === 'error' && errors.push(`console.error: ${m.text()}`));
    await page.goto(`./#/cli/lessons/${lesson}`);
    await expect(page.getByTestId('cli-terminal')).toContainText('aws help', { timeout: 30_000 });
    await monkey(page, rng(SEED * 100 + lesson.length), STEPS);
    // ターミナルがまだ応答する: 入力途中の行や実行中のコマンドを Ctrl+C で捨ててから打つ
    await page.setViewportSize({ width: 1600, height: 1000 });
    const term = page.getByTestId('cli-terminal');
    await term.locator('.xterm-screen').click();
    await page.keyboard.press('Control+C');
    await page.keyboard.type('echo alive-$((40+2))');
    await page.keyboard.press('Enter');
    await expect(term).toContainText('alive-42', { timeout: 15_000 });
    expect(errors).toEqual([]);
  });
}
