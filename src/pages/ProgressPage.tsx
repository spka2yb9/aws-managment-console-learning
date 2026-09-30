import Alert from '@cloudscape-design/components/alert';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import Link from '@cloudscape-design/components/link';
import Modal from '@cloudscape-design/components/modal';
import ProgressBar from '@cloudscape-design/components/progress-bar';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { useState } from 'react';
import { AppShell } from '../app/AppShell';
import { db, type LessonStatus } from '../db';
import { ALL_LESSONS, COURSES } from '../lessons';

export function StatusBadge({ status }: { status: LessonStatus }) {
  const [type, text] = ({ 'not-started': ['pending', 'Not Started'], 'in-progress': ['in-progress', 'In Progress'], completed: ['success', 'Completed'] } as const)[status];
  return <StatusIndicator type={type}>{text}</StatusIndicator>;
}

type ResetTarget = { label: string; lessonIds: string[] };

export function ProgressPage() {
  const navigate = useNavigate();
  const saved = useLiveQuery(async () => ({ progress: await db.progress.toArray(), sessionIds: await db.sessions.toCollection().primaryKeys() }), []);
  const [resetTarget, setResetTarget] = useState<ResetTarget | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState(false);
  const progress = new Map(saved?.progress.map((p) => [p.lessonId, p]));
  const active = new Set([...progress.keys(), ...(saved?.sessionIds ?? [])]);
  const done = ALL_LESSONS.filter((lesson) => progress.get(lesson.id)?.status === 'completed').length;

  const confirmReset = async () => {
    if (!resetTarget || resetting) return;
    setResetting(true);
    setError(false);
    try {
      await db.transaction('rw', db.progress, db.sessions, async () => {
        await db.progress.bulkDelete(resetTarget.lessonIds);
        await db.sessions.bulkDelete(resetTarget.lessonIds);
      });
      setResetTarget(null);
    } catch {
      setError(true);
    } finally {
      setResetting(false);
    }
  };

  return (
    <AppShell active="/progress">
      <ContentLayout header={<Header variant="h1" description="学習の進み具合はこのブラウザの IndexedDB に保存されます。">Progress</Header>}>
        <SpaceBetween size="l">
          <Container>
            <ProgressBar value={(done / ALL_LESSONS.length) * 100} label="Overall" description={`${done} / ${ALL_LESSONS.length} lessons completed`} />
          </Container>
          <div data-testid="progress-table">
            <SpaceBetween size="l">
              {COURSES.map((course) => {
                const rows = course.lessons.map((lesson) => ({ lesson, p: progress.get(lesson.id) }));
                const lessonIds = course.lessons.map((lesson) => lesson.id);
                const completed = rows.filter((r) => r.p?.status === 'completed').length;
                return (
                  <Table
                    key={course.id}
                    header={
                      <Header
                        variant="h2"
                        description={course.description}
                        counter={`(${completed}/${rows.length})`}
                        actions={<Button data-testid={`reset-course-${course.id}`} disabled={!saved || resetting || !lessonIds.some((id) => active.has(id))} onClick={() => { setError(false); setResetTarget({ label: course.title, lessonIds }); }}>セクションをリセット</Button>}
                      >
                        {course.title}
                      </Header>
                    }
                    items={rows}
                    trackBy={(r) => r.lesson.id}
                    columnDefinitions={[
                      { id: 'n', header: '#', cell: (r) => r.lesson.number, width: 60 },
                      { id: 't', header: 'Lesson', cell: (r) => <Link href={`#/lessons/${r.lesson.id}`} onFollow={(e) => { e.preventDefault(); navigate({ to: '/lessons/$lessonId', params: { lessonId: r.lesson.id } }); }}>{r.lesson.title}</Link> },
                      { id: 's', header: 'Status', cell: (r) => <StatusBadge status={r.p?.status ?? 'not-started'} /> },
                      { id: 'step', header: 'Step', cell: (r) => (r.p ? `${Math.min(r.p.stepIndex + 1, r.lesson.steps.length)} / ${r.lesson.steps.length}` : '-') },
                      { id: 'u', header: 'Last activity', cell: (r) => (r.p ? new Date(r.p.updatedAt).toLocaleString() : '-') },
                      { id: 'reset', header: 'Reset', cell: (r) => <Button wrapText={false} data-testid={`reset-lesson-${r.lesson.id}`} disabled={!saved || resetting || !active.has(r.lesson.id)} onClick={() => { setError(false); setResetTarget({ label: r.lesson.title, lessonIds: [r.lesson.id] }); }}>リセット</Button>, width: 120 },
                    ]}
                  />
                );
              })}
            </SpaceBetween>
          </div>
        </SpaceBetween>
      </ContentLayout>
      <Modal
        visible={resetTarget !== null}
        onDismiss={() => { if (!resetting) setResetTarget(null); }}
        closeAriaLabel="閉じる"
        header="進捗をリセット"
        footer={
          <SpaceBetween direction="horizontal" size="xs">
            <Button disabled={resetting} onClick={() => setResetTarget(null)}>キャンセル</Button>
            <Button variant="primary" loading={resetting} onClick={() => void confirmReset()}>リセットする</Button>
          </SpaceBetween>
        }
      >
        <SpaceBetween size="s">
          <div>「{resetTarget?.label}」の進捗と保存された学習状態を削除します。次に開くと最初から始まります。</div>
          {error && <Alert type="error">リセットに失敗しました。もう一度お試しください。</Alert>}
        </SpaceBetween>
      </Modal>
    </AppShell>
  );
}
