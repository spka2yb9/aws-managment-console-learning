import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ButtonDropdown from '@cloudscape-design/components/button-dropdown';
import Container from '@cloudscape-design/components/container';
import Header from '@cloudscape-design/components/header';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import { useEffect, useRef, useState } from 'react';
import { SimBrowser } from '../console/SimBrowser';
import { LoadTestPanel } from '../console/pages/autoscaling';
import { LazyDiagram } from '../diagram/LazyDiagram';
import { DoneTask, ExercisePanel, QuizPanel, ResultPanel, StaticContent, ValidationSpinner } from './LessonRenderer';
import type { LessonEvent } from './machine';
import type { Lesson, TaskContext, ValidationResult } from './types';

export type LessonPhase = 'dialogue' | 'exercise' | 'validation' | 'result' | 'completed' | 'routing';

export function LessonPanel({
  lesson,
  phase,
  index,
  result,
  send,
  ctx,
  guide,
  onGuideChange,
  onRestart,
  onExit,
  nextLesson,
}: {
  lesson: Lesson;
  phase: LessonPhase;
  index: number;
  result: ValidationResult | null;
  send: (e: LessonEvent) => void;
  ctx: TaskContext;
  guide: boolean;
  onGuideChange: (v: boolean) => void;
  onRestart: () => void;
  onExit: () => void;
  nextLesson?: () => void;
}) {
  const total = lesson.steps.length;
  const step = lesson.steps[index];
  const currentRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState('talk');
  useEffect(() => {
    currentRef.current?.scrollIntoView?.({
      block: 'start',
      behavior: 'smooth',
    });
  }, [index, phase]);

  const current = (() => {
    if (phase === 'completed')
      return (
        <Container data-testid="lesson-complete">
          <SpaceBetween size="m">
            <Box variant="h2">🎉 Lesson Complete</Box>
            <Box>
              {lesson.number} {lesson.title} を修了しました。
            </Box>
            <SpaceBetween direction="horizontal" size="xs">
              {nextLesson && (
                <Button variant="primary" onClick={nextLesson} data-testid="next-lesson">
                  次のLessonへ
                </Button>
              )}
              <Button onClick={onExit}>コース一覧へ</Button>
              <Button variant="link" onClick={onRestart}>
                最初からやり直す
              </Button>
            </SpaceBetween>
          </SpaceBetween>
        </Container>
      );
    if (!step) return null;
    if (phase === 'dialogue')
      return (
        <SpaceBetween size="s">
          <StaticContent content={step} />
          <Box float="right">
            <Button variant="primary" onClick={() => send({ type: 'NEXT' })} data-testid="next">
              次へ
            </Button>
          </Box>
        </SpaceBetween>
      );
    if (phase === 'validation') return <ValidationSpinner />;
    if (phase === 'result' && result) return <ResultPanel result={result} onNext={() => send({ type: 'NEXT' })} onRetry={() => send({ type: 'RETRY' })} />;
    if (step.type === 'exercise') return <ExercisePanel ex={step} ctx={ctx} guide={guide} onGuideChange={onGuideChange} onSubmit={(r) => send({ type: 'SUBMIT', result: r })} />;
    if (step.type === 'quiz') return <QuizPanel key={index} quiz={step} onSubmit={(r) => send({ type: 'SUBMIT', result: r })} />;
    return null;
  })();

  return (
    <div className="lesson-panel" data-testid="lesson-panel">
      <SpaceBetween size="m">
        <div className="lesson-panel-header">
          <Header variant="h2" description={lesson.summary}>
            {lesson.number}. {lesson.title}
          </Header>
        </div>
        <div className="lesson-progress-row">
          <div data-testid="step-counter">
            <ProgressBar value={(Math.min(index, total) / total) * 100} label={`Step ${Math.min(index + 1, total)} / ${total}`} />
          </div>
          <ButtonDropdown
            variant="icon"
            ariaLabel="Lesson menu"
            items={[
              { id: 'restart', text: 'Lessonを最初からやり直す' },
              { id: 'exit', text: 'コース一覧へ戻る' },
            ]}
            onItemClick={(e) => (e.detail.id === 'restart' ? onRestart() : onExit())}
          />
        </div>
        <Tabs
          activeTabId={tab}
          onChange={(e) => setTab(e.detail.activeTabId)}
          tabs={[
            {
              id: 'talk',
              label: '会話',
              content: (
                <SpaceBetween size="l">
                  {lesson.steps.slice(0, Math.min(index, total)).map((c, i) => (
                    <div key={i} className="past-step">
                      <DoneTask content={c} />
                    </div>
                  ))}
                  <div ref={currentRef} className="current-step" data-testid="current-step">
                    {current}
                  </div>
                </SpaceBetween>
              ),
            },
            {
              id: 'diagram',
              label: '構成図',
              content: tab === 'diagram' && <LazyDiagram title="現在の構成 (Live)" spec="live" />,
            },
            { id: 'browser', label: 'ブラウザ', content: <SimBrowser /> },
            ...(lesson.loadTest ? [{ id: 'load', label: '負荷テスト', content: tab === 'load' && <LoadTestPanel /> }] : []),
          ]}
        />
      </SpaceBetween>
    </div>
  );
}
