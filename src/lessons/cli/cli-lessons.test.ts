// @vitest-environment node
/* CLI 版レッスンの検査
   - コンソール版の演習はすべて CLI 版に差し替わっている (コンソールを操作する演習が残っていない)
   - CLI 版の演習のタスクには、すべてコマンド例がある
   - 模範解答: タスクのコマンド例を順に本物のシェル (Lifo + aws) で打つと、どの演習も検証に通る。
     また、その演習のコマンドを打つ前には検証に通らない (前の演習の操作だけで済んでしまう演習が無い) */
import { timing } from '../../cli/aws/aws';
import { bootShell } from '../../cli/test/harness';
import type { ConsoleExerciseContent, Lesson, TaskContext } from '../../lesson/types';
import { ALL_LESSONS } from '..';
import { CLI_PATCHES, cliFiles, cliLesson } from '.';

const patched = ALL_LESSONS.filter((l) => CLI_PATCHES[l.id]);

describe('CLI lesson patches', () => {
  it.each(patched.map((l) => [l.number, l] as const))('%s replaces every console exercise', (_, lesson) => {
    const patch = CLI_PATCHES[lesson.id];
    for (const i of Object.keys(patch.steps).map(Number)) expect(lesson.steps[i], `step ${i} exists`).toBeDefined();
    lesson.steps.forEach((s, i) => {
      if (s.type === 'exercise') expect(i in patch.steps, `exercise at step ${i} (${s.title}) has a CLI version`).toBe(true);
    });
    for (const s of cliLesson(lesson)!.steps) {
      if (s.type !== 'exercise') continue;
      expect(new Set(s.tasks.map((t) => t.id)).size).toBe(s.tasks.length);
      expect(s.tasks.filter((t) => !t.command || !t.hint.trim()).map((t) => t.id), `${s.title}: tasks without a command example or hint`).toEqual([]);
    }
  });
});

describe('CLI lesson model solutions', () => {
  let now = Date.now();
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    // waiters and curl's timeout advance the simulated clock instead of sleeping
    timing.sleep = async (ms: number) => {
      now += ms;
      vi.setSystemTime(now);
    };
  });
  afterAll(() => vi.useRealTimers());

  it.each(patched.map((l) => [l.number, l] as const))('%s', async (_, base) => {
    const lesson = cliLesson(base) as Lesson;
    const env = lesson.scenario();
    const { sh, state } = await bootShell(env, cliFiles(lesson, env));
    const ctx = (): TaskContext => state();
    const exercises = lesson.steps.filter((s): s is ConsoleExerciseContent => s.type === 'exercise');
    for (const ex of exercises) {
      expect(ex.validate(ctx()).ok, `${ex.title}: passes before its commands were typed`).toBe(false);
      for (const t of ex.tasks) {
        const cmd = typeof t.command === 'function' ? t.command(ctx()) : t.command!;
        const r = await sh(cmd);
        // a little simulated time passes between commands (instances boot, ...)
        now += 2000;
        vi.setSystemTime(now);
        state().tick();
        expect(t.done(ctx()), `${ex.title} / ${t.id}: not done after \`${cmd}\`\n${r.out}`).toBe(true);
      }
      const v = ex.validate(ctx());
      expect(v.ok, `${ex.title}: ${v.lines.map((l) => l.text).join(' / ')}`).toBe(true);
    }
  });
});
