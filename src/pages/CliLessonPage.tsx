/* CLI 版のレッスン。左に会話と演習 (コンソール版と同じ LessonPanel)、右にターミナル。
   シミュレーターの状態はコンソール版と同じ useConsole に持ち、進捗と状態は cli:<lessonId> で別に保存する。
   演習のタスクがすべて終わり、検証にも通るようになったら、コマンドを打った時点で自動で次へ進む。 */
import Box from '@cloudscape-design/components/box';
import Spinner from '@cloudscape-design/components/spinner';
import { Navigate, useNavigate, useParams } from '@tanstack/react-router';
import { useMachine } from '@xstate/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { AppTopNav } from '../app/AppShell';
import { CliShell } from '../cli/shell/shell';
import { Terminal } from '../cli/terminal/Terminal';
import type { TerminalController } from '../cli/terminal/TerminalController';
import { snapshot, useConsole } from '../console/store';
import { db } from '../db';
import { LessonPanel, type LessonPhase } from '../lesson/LessonPanel';
import { taskProgress } from '../lesson/LessonRenderer';
import { lessonMachine } from '../lesson/machine';
import { stepKind, type Lesson } from '../lesson/types';
import { findLesson, nextLessonOf } from '../lessons';
import { cliFiles, cliLesson } from '../lessons/cli';
import { fresh, restore } from './LessonPage';

export const cliKey = (id: string) => `cli:${id}`;

const BANNER = '\x1b[2mAWS CLI 学習用シミュレーター (aws-cli/2 互換)。実際の AWS には接続しません。\r\naws help で使えるサービスの一覧、aws <サービス> help でサブコマンドの一覧が出ます。\x1b[0m\r\n\r\n';

/** The CLI lesson after `lesson` that has a CLI version */
function nextCliLesson(id: string): Lesson | undefined {
  for (let l = nextLessonOf(id); l; l = nextLessonOf(l.id)) if (cliLesson(l)) return l;
  return undefined;
}

function CliRunner({ lesson, startIndex }: { lesson: Lesson; startIndex: number }) {
  const navigate = useNavigate();
  const [state, send] = useMachine(lessonMachine, { input: { kinds: lesson.steps.map(stepKind), index: startIndex } });
  const ctx = useConsole(useShallow(snapshot));
  const index = state.context.index;
  const completed = state.matches('completed');
  const key = cliKey(lesson.id);
  const shell = useMemo(() => new CliShell(), []);
  const ctl = useRef<TerminalController | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void db.progress.get(key).then((p) =>
      db.progress.put({ lessonId: key, status: completed ? 'completed' : 'in-progress', stepIndex: index, updatedAt: Date.now(), completedAt: completed ? (p?.completedAt ?? Date.now()) : p?.completedAt }),
    );
  }, [key, index, completed]);

  useEffect(() => {
    const save = () => db.sessions.put({ lessonId: key, ...snapshot(useConsole.getState()), updatedAt: Date.now() });
    const unsub = useConsole.subscribe(save);
    void save();
    const tick = setInterval(() => useConsole.getState().tick(), 1000);
    return () => {
      clearInterval(tick);
      unsub();
    };
  }, [key]);

  /* ターミナルの中身 (Lifo のシェル) を作り直す。始めたときと「最初からやり直す」のとき */
  const boot = useCallback(async () => {
    ctl.current?.lock('ターミナルを準備しています…');
    await shell.reset(cliFiles(lesson, useConsole.getState().env));
    setReady(true);
    ctl.current?.reset(BANNER);
  }, [shell, lesson]);

  useEffect(() => {
    let alive = true;
    void shell.reset(cliFiles(lesson, useConsole.getState().env)).then(() => {
      if (!alive) return;
      setReady(true);
      ctl.current?.reset(BANNER);
    });
    return () => {
      alive = false;
      shell.destroy();
    };
  }, [shell, lesson]);

  const attach = useCallback(
    (c: TerminalController) => {
      ctl.current = c;
      if (ready) c.reset(BANNER);
      else c.lock('ターミナルを準備しています…');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /* コマンドを打って先へ進む: タスクが全部終わっていて検証にも通るなら、ボタンを押さなくても検証に進む */
  const step = lesson.steps[index];
  const inExercise = state.matches('exercise');
  useEffect(() => {
    if (!inExercise || step?.type !== 'exercise') return;
    if (taskProgress(step, ctx).current < step.tasks.length) return;
    const r = step.validate(ctx);
    if (r.ok) send({ type: 'SUBMIT', result: r });
  }, [ctx, inExercise, step, send]);

  const restart = () => {
    useConsole.getState().load(fresh(lesson));
    send({ type: 'RESTART' });
    void boot();
  };
  const next = nextCliLesson(lesson.id);
  const exit = () => navigate({ to: '/cli' });
  return (
    <>
      <AppTopNav utilities={[{ type: 'button', text: 'CLI 版のコース一覧', iconName: 'angle-left', onClick: exit }]} />
      <div className="cli-workspace">
        <div className="cli-lesson">
          <LessonPanel
            lesson={lesson}
            phase={state.value as LessonPhase}
            index={index}
            result={state.context.result}
            send={send}
            ctx={ctx}
            guide={false}
            onGuideChange={() => {}}
            onRestart={restart}
            onExit={exit}
            nextLesson={next ? () => navigate({ to: '/cli/lessons/$lessonId', params: { lessonId: next.id } }) : undefined}
            onInsert={(cmd) => ctl.current?.insert(cmd)}
          />
        </div>
        <div className="cli-terminal">
          <Terminal shell={shell} onReady={attach} />
        </div>
      </div>
    </>
  );
}

export function CliLessonPage() {
  const { lessonId } = useParams({ from: '/cli/lessons/$lessonId' });
  const base = findLesson(lessonId);
  const lesson = useMemo(() => base && cliLesson(base), [base]);
  const [start, setStart] = useState<{ id: string; index: number } | null>(null);
  useEffect(() => {
    if (!lesson) return;
    let cancelled = false;
    void Promise.all([db.progress.get(cliKey(lesson.id)), db.sessions.get(cliKey(lesson.id))]).then(([p, s]) => {
      if (cancelled) return;
      useConsole.getState().load(p ? restore(lesson, s) : fresh(lesson));
      setStart({ id: lesson.id, index: p?.stepIndex ?? 0 });
    });
    return () => {
      cancelled = true;
    };
  }, [lesson]);
  if (!lesson) return <Navigate to="/cli" />;
  if (start?.id !== lesson.id)
    return (
      <Box textAlign="center" padding="xxl">
        <Spinner size="large" />
      </Box>
    );
  return <CliRunner key={lesson.id} lesson={lesson} startIndex={start.index} />;
}
