import { assign, setup } from 'xstate';
import type { ValidationResult } from './types';

export type StepKind = 'narrative' | 'task';

export interface LessonMachineContext {
  kinds: StepKind[];
  index: number;
  result: ValidationResult | null;
}

export type LessonEvent = { type: 'NEXT' } | { type: 'SUBMIT'; result: ValidationResult } | { type: 'RETRY' } | { type: 'RESTART' };

export const VALIDATION_MS = 500;

/**
 * Dialogue -> Exercise -> Validation -> Result -> Dialogue ...
 * Narrative steps (dialogue/diagram/table/code) advance with NEXT. Task steps (exercise/quiz) SUBMIT a
 * ValidationResult; "validation" is a short visible checking state, then "result" either advances (passed)
 * or goes back to the exercise (RETRY).
 */
export const lessonMachine = setup({
  types: {
    context: {} as LessonMachineContext,
    input: {} as { kinds: StepKind[]; index: number },
    events: {} as LessonEvent,
  },
  guards: {
    atEnd: ({ context }) => context.index >= context.kinds.length,
    isTask: ({ context }) => context.kinds[context.index] === 'task',
    passed: ({ context }) => !!context.result?.ok,
  },
  actions: {
    advance: assign({ index: ({ context }) => context.index + 1, result: null }),
    clearResult: assign({ result: null }),
    storeResult: assign({ result: ({ event }) => (event.type === 'SUBMIT' ? event.result : null) }),
    restart: assign({ index: 0, result: null }),
  },
}).createMachine({
  id: 'lesson',
  context: ({ input }) => ({ kinds: input.kinds, index: Math.min(input.index, input.kinds.length), result: null }),
  initial: 'routing',
  on: { RESTART: { target: '.routing', actions: 'restart' } },
  states: {
    routing: {
      always: [{ guard: 'atEnd', target: 'completed' }, { guard: 'isTask', target: 'exercise' }, { target: 'dialogue' }],
    },
    dialogue: { on: { NEXT: { target: 'routing', actions: 'advance' } } },
    exercise: { on: { SUBMIT: { target: 'validation', actions: 'storeResult' } } },
    validation: { after: { [VALIDATION_MS]: 'result' } },
    result: {
      on: {
        NEXT: { guard: 'passed', target: 'routing', actions: 'advance' },
        RETRY: { target: 'exercise', actions: 'clearResult' },
      },
    },
    completed: {},
  },
});
