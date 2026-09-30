import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import CopyToClipboard from '@cloudscape-design/components/copy-to-clipboard';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import Header from '@cloudscape-design/components/header';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Toggle from '@cloudscape-design/components/toggle';
import { useState } from 'react';
import { LazyDiagram } from '../diagram/LazyDiagram';
import { Dialogue, richText } from './Dialogue';
import type { ConsoleExerciseContent, LessonContent, QuizContent, TaskContext, ValidationResult } from './types';
import { hakase } from './types';

/** Task i counts as done if its check passes or any later task is already done (progress never goes backwards). */
export function taskProgress(ex: ConsoleExerciseContent, ctx: TaskContext) {
  const raw = ex.tasks.map((t) => t.done(ctx));
  const done = raw.map((_, i) => raw.slice(i).some(Boolean));
  const current = done.indexOf(false);
  return { done, current: current === -1 ? ex.tasks.length : current };
}

/** Narrative content: dialogue, table, code and diagrams. */
export function StaticContent({ content }: { content: LessonContent }) {
  switch (content.type) {
    case 'dialogue':
      return <Dialogue lines={content.lines} />;
    case 'table':
      return (
        <Table<{ i: number; cells: string[] }>
          variant="embedded"
          wrapLines
          header={<Header variant="h3">{content.title}</Header>}
          items={content.rows.map((cells, i) => ({ i, cells }))}
          columnDefinitions={content.columns.map((c, n) => ({ id: String(n), header: c, cell: (r) => richText(r.cells[n]) }))}
        />
      );
    case 'code':
      return (
        <Container header={<Header variant="h3" actions={<CopyToClipboard variant="icon" textToCopy={content.code} copyButtonAriaLabel="コードをコピー" copySuccessText="コピーしました" copyErrorText="コピーに失敗しました" />}>{content.title}</Header>}>
          <pre className="code-block" data-language={content.language}>{content.code}</pre>
        </Container>
      );
    case 'diagram':
      return <LazyDiagram title={content.title} spec={content.diagram} />;
    default:
      return null;
  }
}

export function ExercisePanel({ ex, ctx, onSubmit, guide, onGuideChange }: { ex: ConsoleExerciseContent; ctx: TaskContext; onSubmit: (r: ValidationResult) => void; guide: boolean; onGuideChange: (v: boolean) => void }) {
  const { done, current } = taskProgress(ex, ctx);
  const task = ex.tasks[current];
  return (
    <Container
      data-testid="exercise-panel"
      header={
        <Header variant="h3" description={<>Task {Math.min(current + 1, ex.tasks.length)} / {ex.tasks.length}</>} actions={<Toggle checked={guide} onChange={(e) => onGuideChange(e.detail.checked)}>ガイド表示</Toggle>}>
          {ex.title}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <div>
          <Box variant="awsui-key-label">Current objective</Box>
          <div data-testid="current-objective">{richText(ex.objective)}</div>
        </div>
        <ol className="task-list" data-testid="task-list">
          {ex.tasks.map((t, i) => (
            <li key={t.id} className={i === current ? 'task-current' : undefined} data-done={done[i]}>
              <StatusIndicator type={done[i] ? 'success' : i === current ? 'in-progress' : 'pending'}>{richText(t.title)}</StatusIndicator>
            </li>
          ))}
        </ol>
        {!!task?.hint && (
          <ExpandableSection headerText="Hint" variant="footer" defaultExpanded data-testid="hint">
            {richText(task.hint)}
          </ExpandableSection>
        )}
        <Box float="right">
          <Button variant="primary" onClick={() => onSubmit(ex.validate(ctx))} data-testid="validate">
            検証する
          </Button>
        </Box>
      </SpaceBetween>
    </Container>
  );
}

export function QuizPanel({ quiz, onSubmit }: { quiz: QuizContent; onSubmit: (r: ValidationResult) => void }) {
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <SpaceBetween size="s">
      <Dialogue lines={[quiz.question]} />
      <Container data-testid="quiz-panel">
        <SpaceBetween size="m">
          <RadioGroup value={choice} onChange={(e) => setChoice(e.detail.value)} items={quiz.options.map((o, i) => ({ value: String(i), label: richText(o) }))} />
          <Box float="right">
            <Button
              variant="primary"
              disabled={choice === null}
              data-testid="answer"
              onClick={() =>
                onSubmit(Number(choice) === quiz.answer ? { ok: true, lines: quiz.explanation } : { ok: false, lines: quiz.wrong ?? [hakase('うーむ、惜しい。もう一度考えてみるのだ。')] })
              }
            >
              回答する
            </Button>
          </Box>
        </SpaceBetween>
      </Container>
    </SpaceBetween>
  );
}

export function ValidationSpinner() {
  return (
    <Box textAlign="center" padding="m" data-testid="validating">
      <Spinner /> 検証中…
    </Box>
  );
}

export function ResultPanel({ result, onNext, onRetry }: { result: ValidationResult; onNext: () => void; onRetry: () => void }) {
  return (
    <SpaceBetween size="s">
      <div data-testid={result.ok ? 'result-ok' : 'result-ng'}>
        <StatusIndicator type={result.ok ? 'success' : 'warning'}>{result.ok ? 'Validation passed' : 'まだ条件を満たしていません'}</StatusIndicator>
      </div>
      <Dialogue lines={result.lines} />
      <Box float="right">
        {result.ok ? (
          <Button variant="primary" onClick={onNext} data-testid="next">次へ</Button>
        ) : (
          <Button onClick={onRetry} data-testid="retry">もう一度</Button>
        )}
      </Box>
    </SpaceBetween>
  );
}

/** Compact transcript line for a finished task step. */
export function DoneTask({ content }: { content: LessonContent }) {
  if (content.type === 'exercise') return <StatusIndicator type="success">{content.title} — 完了</StatusIndicator>;
  if (content.type === 'quiz')
    return (
      <SpaceBetween size="xs">
        <Dialogue lines={[content.question]} />
        <StatusIndicator type="success">正解: {richText(content.options[content.answer])}</StatusIndicator>
      </SpaceBetween>
    );
  return <StaticContent content={content} />;
}
