import { createHashHistory, createRootRoute, createRoute, createRouter, Navigate, Outlet, redirect } from '@tanstack/react-router';
import { CoursesPage } from '../pages/CoursesPage';
import { LessonPage } from '../pages/LessonPage';
import { ProgressPage } from '../pages/ProgressPage';
import { PromptPage } from '../pages/PromptPage';

const rootRoute = createRootRoute({ component: Outlet });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: '/', beforeLoad: () => { throw redirect({ to: '/courses' }); } }),
  createRoute({ getParentRoute: () => rootRoute, path: '/courses', component: CoursesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/progress', component: ProgressPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/prompt', component: PromptPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/lessons/$lessonId', component: LessonPage }),
]);

// Hash history: GitHub Pages serves only index.html, so reload / direct access must not hit the server path.
export const router = createRouter({ routeTree, history: createHashHistory(), defaultNotFoundComponent: () => <Navigate to="/courses" /> });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
