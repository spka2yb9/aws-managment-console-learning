import Dexie, { type EntityTable } from 'dexie';
import type { CommandRecord } from './console/store';
import type { HttpResult } from './sim/http';
import type { AwsEnv } from './sim/types';

export type LessonStatus = 'not-started' | 'in-progress' | 'completed';

export interface LessonProgress {
  lessonId: string;
  status: LessonStatus;
  /** index of the current step (steps.length when completed) */
  stepIndex: number;
  updatedAt: number;
  completedAt?: number;
}

/** Console state of a lesson in progress, so a reload continues exactly where the learner was. */
export interface LessonSession {
  lessonId: string;
  env: AwsEnv;
  path: string;
  region: string;
  visited: string[];
  copied: string[];
  browser: HttpResult[];
  commands: CommandRecord[];
  updatedAt: number;
}

export const db = new Dexie('aws-learning-simulator') as Dexie & {
  progress: EntityTable<LessonProgress, 'lessonId'>;
  sessions: EntityTable<LessonSession, 'lessonId'>;
};

db.version(1).stores({ progress: 'lessonId, status', sessions: 'lessonId' });
