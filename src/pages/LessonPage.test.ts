import { describe, expect, it } from 'vitest';
import type { LessonSession } from '../db';
import { findLesson } from '../lessons';
import { restore } from './LessonPage';

describe('session restore', () => {
  it('a session saved before newer resource lists existed keeps its work and gets the new lists empty', () => {
    const lesson = findLesson('vpc')!;
    const env = lesson.scenario() as unknown as Record<string, unknown>;
    delete env.natGateways;
    delete env.budgets;
    (env.vpcs as { tags: { key: string; value: string }[] }[])[0].tags = [{ key: 'Name', value: 'learner-made' }];
    const old = { lessonId: lesson.id, env, path: '/vpc/vpcs', region: 'ap-northeast-1', visited: ['/vpc/vpcs'], copied: [], browser: [], commands: [], updatedAt: 0 } as unknown as LessonSession;
    const s = restore(lesson, old);
    expect(s.path).toBe('/vpc/vpcs');
    expect(s.env.vpcs[0].tags).toEqual([{ key: 'Name', value: 'learner-made' }]);
    expect([s.env.natGateways, s.env.budgets]).toEqual([[], []]);
  });

  it('a broken session starts the lesson fresh', () => {
    const lesson = findLesson('vpc')!;
    expect(restore(lesson, { lessonId: lesson.id, env: 42 } as unknown as LessonSession).path).toBe(lesson.startPath);
  });
});
