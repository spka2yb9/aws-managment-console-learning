import { createActor } from 'xstate';
import { lessonMachine, VALIDATION_MS } from './machine';

describe('lesson machine', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('Dialogue -> Exercise -> Validation -> Result -> Dialogue -> Completed', () => {
    const a = createActor(lessonMachine, { input: { kinds: ['narrative', 'task', 'narrative'], index: 0 } }).start();
    expect(a.getSnapshot().value).toBe('dialogue');
    a.send({ type: 'NEXT' });
    expect(a.getSnapshot().value).toBe('exercise');
    a.send({ type: 'SUBMIT', result: { ok: false, lines: [] } });
    expect(a.getSnapshot().value).toBe('validation');
    vi.advanceTimersByTime(VALIDATION_MS);
    expect(a.getSnapshot().value).toBe('result');
    a.send({ type: 'NEXT' }); // not passed: ignored
    expect(a.getSnapshot().value).toBe('result');
    a.send({ type: 'RETRY' });
    a.send({ type: 'SUBMIT', result: { ok: true, lines: [] } });
    vi.advanceTimersByTime(VALIDATION_MS);
    a.send({ type: 'NEXT' });
    expect(a.getSnapshot().value).toBe('dialogue');
    expect(a.getSnapshot().context.index).toBe(2);
    a.send({ type: 'NEXT' });
    expect(a.getSnapshot().value).toBe('completed');
  });

  it('resumes at a saved step', () => {
    const a = createActor(lessonMachine, { input: { kinds: ['narrative', 'task'], index: 1 } }).start();
    expect(a.getSnapshot().value).toBe('exercise');
    a.send({ type: 'RESTART' });
    expect(a.getSnapshot().context.index).toBe(0);
    expect(a.getSnapshot().value).toBe('dialogue');
  });
});
