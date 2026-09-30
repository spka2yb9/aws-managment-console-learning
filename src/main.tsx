import '@cloudscape-design/global-styles/index.css';
import './app/app.css';
import { I18nProvider } from '@cloudscape-design/components/i18n';
import messages from '@cloudscape-design/components/i18n/messages/all.ja';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { router } from './app/router';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider locale="ja" messages={[messages]}>
      <RouterProvider router={router} />
    </I18nProvider>
  </StrictMode>,
);
