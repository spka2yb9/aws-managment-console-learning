import type { ConsoleSnapshot } from '../console/store';
import type { DiagramSpec } from '../diagram/spec';
import type { AwsEnv } from '../sim/types';

// Lessons are data, rendered by LessonRenderer. Rule: no narration ("地の文0") — every explanation is a
// DialogueLine spoken by パス博士 (hakase, left) or ノード君 (node, right). Only UI chrome (objectives, task
// titles, hints) is written as instructions.

export type Speaker = 'hakase' | 'node';

export interface DialogueLine {
  speaker: Speaker;
  text: string;
}

export interface DialogueContent {
  type: 'dialogue';
  lines: DialogueLine[];
}

export interface DiagramContent {
  type: 'diagram';
  title: string;
  /** 'live' = the current simulated environment with connectivity status */
  diagram: 'live' | DiagramSpec;
}

export interface TableContent {
  type: 'table';
  title: string;
  columns: string[];
  rows: string[][];
}

export interface CodeContent {
  type: 'code';
  title: string;
  language: 'bash' | 'json' | 'text';
  code: string;
}

/** What validators and task checks can look at. */
export type TaskContext = ConsoleSnapshot;

export interface ExerciseTask {
  id: string;
  title: string;
  hint: string;
  /** Cloudscape Hotspot id placed in the console UI; shows an annotation next to it for this task. */
  hotspotId?: string;
  /** Once true the task stays done (sticky), so navigating away doesn't un-check it. */
  done: (ctx: TaskContext) => boolean;
}

export interface ValidationResult {
  ok: boolean;
  /** feedback spoken by the characters */
  lines: DialogueLine[];
}

export interface ConsoleExerciseContent {
  type: 'exercise';
  title: string;
  objective: string;
  tasks: ExerciseTask[];
  validate: (ctx: TaskContext) => ValidationResult;
}

export interface QuizContent {
  type: 'quiz';
  question: DialogueLine;
  options: string[];
  answer: number;
  /** spoken after a correct answer */
  explanation: DialogueLine[];
  /** spoken after a wrong answer (default: a generic nudge) */
  wrong?: DialogueLine[];
}

export type LessonContent = DialogueContent | DiagramContent | TableContent | CodeContent | ConsoleExerciseContent | QuizContent;

export interface Lesson {
  id: string;
  number: string;
  title: string;
  summary: string;
  minutes: number;
  /** initial simulated environment (not a sandbox: each lesson prepares exactly what it needs) */
  scenario: () => AwsEnv;
  startPath: string;
  /** console region at start (default: the env region) */
  startRegion?: string;
  /** show the simulator's load generator tab (Auto Scaling lessons) */
  loadTest?: boolean;
  steps: LessonContent[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  lessons: Lesson[];
}

export function stepKind(c: LessonContent): 'narrative' | 'task' {
  return c.type === 'exercise' || c.type === 'quiz' ? 'task' : 'narrative';
}

export const ok = (...lines: DialogueLine[]): ValidationResult => ({ ok: true, lines });
export const ng = (...lines: DialogueLine[]): ValidationResult => ({ ok: false, lines });
export const hakase = (text: string): DialogueLine => ({ speaker: 'hakase', text });
export const node = (text: string): DialogueLine => ({ speaker: 'node', text });
