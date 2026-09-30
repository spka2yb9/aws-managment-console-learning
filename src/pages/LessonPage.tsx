import AnnotationContext, { type AnnotationContextProps } from '@cloudscape-design/components/annotation-context';
import Box from '@cloudscape-design/components/box';
import Spinner from '@cloudscape-design/components/spinner';
import { Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { z } from 'zod';
import { ConsoleLayout } from '../console/ConsoleLayout';
import { snapshot, useConsole, type ConsoleSnapshot } from '../console/store';
import { db, type LessonSession } from '../db';
import { LessonPanel, type LessonPhase } from '../lesson/LessonPanel';
import { taskProgress } from '../lesson/LessonRenderer';
import { lessonMachine } from '../lesson/machine';
import { stepKind, type Lesson } from '../lesson/types';
import { findLesson, nextLessonOf } from '../lessons';
import { emptyEnv } from '../sim/env';

// Sessions come from IndexedDB (possibly written by an older app version): validate the shape, else start fresh.
const sessionSchema = z.object({
  env: z.object({ accountId: z.string(), region: z.string(), vpcs: z.array(z.any()), subnets: z.array(z.any()), routeTables: z.array(z.any()), internetGateways: z.array(z.any()), networkAcls: z.array(z.any()), securityGroups: z.array(z.any()), instances: z.array(z.any()), loadBalancers: z.array(z.any()), targetGroups: z.array(z.any()), dbSubnetGroups: z.array(z.any()), dbInstances: z.array(z.any()), dbSnapshots: z.array(z.any()), keyPairs: z.array(z.string()), iamRoles: z.array(z.any()), iamUsers: z.array(z.any()), iamPolicies: z.array(z.any()), instanceProfiles: z.array(z.any()), buckets: z.array(z.any()), incidents: z.array(z.any()), alarms: z.array(z.any()), logGroups: z.array(z.any()), trailEvents: z.array(z.any()), configRules: z.array(z.any()), launchTemplates: z.array(z.any()), autoScalingGroups: z.array(z.any()), traffic: z.array(z.any()), ecrRepositories: z.array(z.any()), ecsClusters: z.array(z.any()), taskDefinitions: z.array(z.any()), ecsServices: z.array(z.any()), ecsTasks: z.array(z.any()), sqsQueues: z.array(z.any()), lambdaFunctions: z.array(z.any()), eventSourceMappings: z.array(z.any()), computeEnvironments: z.array(z.any()), jobQueues: z.array(z.any()), jobDefinitions: z.array(z.any()), batchJobs: z.array(z.any()), eventRules: z.array(z.any()), hostedZones: z.array(z.any()), certificates: z.array(z.any()), distributions: z.array(z.any()), webAcls: z.array(z.any()), ipSets: z.array(z.any()), natGateways: z.array(z.any()), vpcEndpoints: z.array(z.any()), dataFlows: z.array(z.any()), budgets: z.array(z.any()) }).passthrough(),
  path: z.string(),
  region: z.string(),
  visited: z.array(z.string()),
  copied: z.array(z.string()),
  browser: z.array(z.any()),
  commands: z.array(z.any()),
});

function fresh(lesson: Lesson): ConsoleSnapshot {
  const env = lesson.scenario();
  return { env, path: lesson.startPath, region: lesson.startRegion ?? env.region, visited: [], copied: [], browser: [], commands: [] };
}

export function restore(lesson: Lesson, s: LessonSession | undefined): ConsoleSnapshot {
  // resource lists added by later versions are missing from older sessions: they start empty instead of discarding the learner's work
  const upgraded = s && typeof s.env === 'object' && s.env ? { ...s, env: { ...emptyEnv(s.env.region), ...s.env } } : s;
  const parsed = sessionSchema.safeParse(upgraded);
  return parsed.success ? ((parsed.data as unknown as ConsoleSnapshot)) : fresh(lesson);
}

const plain = (s: string) => s.replace(/`|\*\*/g, '');

const I18N: AnnotationContextProps.I18nStrings = {
  nextButtonText: 'Next',
  previousButtonText: 'Previous',
  finishButtonText: 'OK',
  labelDismissAnnotation: 'Hide guide',
  labelHotspot: (open) => (open ? 'Close guide' : 'Open guide'),
  stepCounterText: () => '',
  taskTitle: (_, title) => title,
};

function LessonRunner({ lesson, startIndex }: { lesson: Lesson; startIndex: number }) {
  const navigate = useNavigate();
  const [state, send] = useMachine(lessonMachine, { input: { kinds: lesson.steps.map(stepKind), index: startIndex } });
  const [guide, setGuide] = useState(true);
  const ctx = useConsole(useShallow(snapshot));
  const index = state.context.index;
  const completed = state.matches('completed');

  useEffect(() => {
    void db.progress.get(lesson.id).then((p) =>
      db.progress.put({ lessonId: lesson.id, status: completed ? 'completed' : 'in-progress', stepIndex: index, updatedAt: Date.now(), completedAt: completed ? (p?.completedAt ?? Date.now()) : p?.completedAt }),
    );
  }, [lesson.id, index, completed]);

  useEffect(() => {
    // Save on every change (changes happen at human speed), so a reload always resumes from the latest state.
    const save = () => db.sessions.put({ lessonId: lesson.id, ...snapshot(useConsole.getState()), updatedAt: Date.now() });
    const unsub = useConsole.subscribe(save);
    void save();
    const tick = setInterval(() => useConsole.getState().tick(), 1000);
    return () => {
      clearInterval(tick);
      unsub();
    };
  }, [lesson.id]);

  const step = lesson.steps[index];
  const task = step?.type === 'exercise' && state.matches('exercise') ? step.tasks[taskProgress(step, ctx).current] : undefined;
  const taskNo = step?.type === 'exercise' ? taskProgress(step, ctx).current + 1 : 0;
  // One single-step tutorial per task: AnnotationContext restarts on a new tutorial object, which lets the lesson
  // (not the popover's Next button) decide which hotspot is active.
  const tutorial = useMemo<AnnotationContextProps.Tutorial | null>(
    () =>
      guide && task?.hotspotId
        ? { title: lesson.title, description: '', completedScreenDescription: '', completed: false, tasks: [{ title: `Task ${taskNo}: ${plain(task.title)}`, steps: [{ title: plain(task.title), content: plain(task.hint), hotspotId: task.hotspotId }] }] }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guide, task?.id, lesson.id],
  );

  const restart = () => {
    useConsole.getState().load(fresh(lesson));
    send({ type: 'RESTART' });
  };
  const next = nextLessonOf(lesson.id);
  return (
    <AnnotationContext currentTutorial={tutorial} onStartTutorial={() => setGuide(true)} onExitTutorial={() => setGuide(false)} onFinish={() => setGuide(false)} i18nStrings={I18N}>
      <ConsoleLayout
        onExit={() => navigate({ to: '/courses' })}
        lessonPanel={
          <LessonPanel
            lesson={lesson}
            phase={state.value as LessonPhase}
            index={index}
            result={state.context.result}
            send={send}
            ctx={ctx}
            guide={guide}
            onGuideChange={setGuide}
            onRestart={restart}
            onExit={() => navigate({ to: '/courses' })}
            nextLesson={next ? () => navigate({ to: '/lessons/$lessonId', params: { lessonId: next.id } }) : undefined}
          />
        }
      />
    </AnnotationContext>
  );
}

export function LessonPage() {
  const { lessonId } = useParams({ from: '/lessons/$lessonId' });
  const lesson = findLesson(lessonId);
  const [start, setStart] = useState<{ id: string; index: number } | null>(null);
  useEffect(() => {
    if (!lesson) return;
    let cancelled = false;
    void Promise.all([db.progress.get(lesson.id), db.sessions.get(lesson.id)]).then(([p, s]) => {
      if (cancelled) return;
      useConsole.getState().load(p ? restore(lesson, s) : fresh(lesson));
      setStart({ id: lesson.id, index: p?.stepIndex ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [lesson]);
  if (!lesson) return <Navigate to="/courses" />;
  if (start?.id !== lesson.id)
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  return <LessonRunner key={lesson.id} lesson={lesson} startIndex={start.index} />;
}
