import Spinner from '@cloudscape-design/components/spinner';
import { lazy, Suspense } from 'react';
import type { DiagramSpec } from './spec';

// React Flow + ELK are ~half of the bundle: load them only when a diagram is shown.
const DiagramView = lazy(() => import('./DiagramView').then((m) => ({ default: m.DiagramView })));

export function LazyDiagram(props: { title: string; spec: DiagramSpec | 'live' }) {
  return (
    <Suspense fallback={<Spinner />}>
      <DiagramView {...props} />
    </Suspense>
  );
}
