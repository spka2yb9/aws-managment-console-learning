import Badge from '@cloudscape-design/components/badge';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Cards from '@cloudscape-design/components/cards';
import ContentLayout from '@cloudscape-design/components/content-layout';
import Header from '@cloudscape-design/components/header';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { useNavigate } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { AppShell } from '../app/AppShell';
import { db, type LessonStatus } from '../db';
import type { Lesson } from '../lesson/types';
import { COURSES } from '../lessons';
import { StatusBadge } from './ProgressPage';

export function CoursesPage() {
  const navigate = useNavigate();
  const progress = useLiveQuery(() => db.progress.toArray(), []) ?? [];
  const statusOf = (id: string): LessonStatus => progress.find((p) => p.lessonId === id)?.status ?? 'not-started';
  const open = (l: Lesson) => navigate({ to: '/lessons/$lessonId', params: { lessonId: l.id } });
  return (
    <AppShell active="/courses">
      <ContentLayout
        header={
          <Header variant="h1" description="実AWSに一切接続せず、AWS Management Console そっくりの画面を操作しながら学ぶコースです。">
            Courses
          </Header>
        }
      >
        <SpaceBetween size="xl">
          {COURSES.map((c) => (
            <Cards<Lesson>
              key={c.id}
              header={<Header variant="h2" description={c.description} counter={`(${c.lessons.filter((l) => statusOf(l.id) === 'completed').length}/${c.lessons.length})`}>{c.title}</Header>}
              items={c.lessons}
              trackBy="id"
              cardsPerRow={[{ cards: 1 }, { minWidth: 700, cards: 2 }, { minWidth: 1100, cards: 3 }]}
              cardDefinition={{
                header: (l) => (
                  <span data-testid={`lesson-card-${l.id}`}>
                    {l.number}. {l.title}
                  </span>
                ),
                sections: [
                  { id: 'summary', content: (l) => l.summary },
                  {
                    id: 'meta',
                    content: (l) => (
                      <SpaceBetween direction="horizontal" size="xs" alignItems="center">
                        <StatusBadge status={statusOf(l.id)} />
                        <Badge>{l.minutes} min</Badge>
                      </SpaceBetween>
                    ),
                  },
                  {
                    id: 'action',
                    content: (l) => (
                      <Box float="right">
                        <Button variant={statusOf(l.id) === 'completed' ? 'normal' : 'primary'} onClick={() => open(l)} data-testid={`start-${l.id}`}>
                          {{ 'not-started': 'Start', 'in-progress': 'Continue', completed: 'Review' }[statusOf(l.id)]}
                        </Button>
                      </Box>
                    ),
                  },
                ],
              }}
            />
          ))}
        </SpaceBetween>
      </ContentLayout>
    </AppShell>
  );
}
