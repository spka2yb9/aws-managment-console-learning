// @vitest-environment node
// 作業用: LESSONS=06,07 npx vitest run src/lessons/cli/outline.test.ts --silent=false で、レッスンのステップの番号と種類を出す
import { ALL_LESSONS } from '..';
it('outline', () => {
  const ids = ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.LESSONS ?? '').split(',');
  for (const l of ALL_LESSONS.filter((x) => ids.includes(x.id) || ids.includes(x.number))) {
    console.log(`== ${l.number} ${l.id} ${l.title}`);
    l.steps.forEach((s, i) => console.log(`  [${i}] ${s.type} ${s.type === 'dialogue' ? s.lines[0].text.slice(0, 50) : s.type === 'exercise' ? s.title + ' / ' + s.tasks.map((t) => t.id).join(',') : s.type === 'quiz' ? s.question.text.slice(0, 40) : 'title' in s ? s.title : ''}`));
  }
});
