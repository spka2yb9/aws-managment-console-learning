import type { Lesson } from '../../lesson/types';
import type { CliPatch, CliPatches } from './types';

// Every l*.ts file contributes patches for its lessons (several authors can work on separate files).
const modules = import.meta.glob<{ default: CliPatches }>('./l*.ts', { eager: true });

export const CLI_PATCHES: Record<string, CliPatch> = {};
for (const [file, mod] of Object.entries(modules)) {
  for (const [id, patch] of Object.entries(mod.default ?? {})) {
    if (CLI_PATCHES[id]) throw new Error(`CLI patch for ${id} is defined twice (${file})`);
    CLI_PATCHES[id] = patch;
  }
}

/** The CLI version of a lesson, or undefined when no patch exists yet. */
export function cliLesson(lesson: Lesson): Lesson | undefined {
  const patch = CLI_PATCHES[lesson.id];
  if (!patch) return undefined;
  return { ...lesson, summary: patch.summary ?? lesson.summary, steps: lesson.steps.flatMap((s, i) => (i in patch.steps ? [patch.steps[i]].flat() : [s])) };
}

export const cliFiles = (lesson: Lesson, env: Parameters<NonNullable<CliPatch['files']>>[0]) => CLI_PATCHES[lesson.id]?.files?.(env) ?? {};
