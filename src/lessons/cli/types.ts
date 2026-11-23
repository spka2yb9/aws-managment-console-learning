import type { LessonContent } from '../../lesson/types';
import type { AwsEnv } from '../../sim/types';

/**
 * A console lesson turned into a CLI lesson. Steps keep their order and content; only the steps that talk about
 * the console (exercises, and dialogue that says "click ...") are replaced, by index into the console lesson's steps.
 * An array replaces one step with several (e.g. an extra exercise). The lesson id stays the same.
 */
export interface CliPatch {
  steps: Record<number, LessonContent | LessonContent[]>;
  /** files in the learner's home directory (relative paths). '.aws/config' overrides the default config. */
  files?: (env: AwsEnv) => Record<string, string>;
  summary?: string;
}

/** Each lesson file under src/lessons/cli/ exports `default` = { [lessonId]: CliPatch }. */
export type CliPatches = Record<string, CliPatch>;
