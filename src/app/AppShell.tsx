import AppLayout from '@cloudscape-design/components/app-layout';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import TopNavigation from '@cloudscape-design/components/top-navigation';
import { useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export const LOGO = `${import.meta.env.BASE_URL}favicon.svg`;

/** Top bar shared by app pages and the console. Always says "Simulator" so nobody mistakes it for the real AWS. */
export function AppTopNav({ utilities = [], search }: { utilities?: Parameters<typeof TopNavigation>[0]['utilities']; search?: ReactNode }) {
  return (
    <div id="top-nav" className="top-nav">
      <TopNavigation
        identity={{ href: '#/courses', title: 'AWS Learning Simulator', logo: { src: LOGO, alt: 'Simulator' } }}
        search={search}
        utilities={[{ type: 'button', text: 'SIMULATOR', title: '学習用シミュレーター: 実AWSには一切接続しません', ariaLabel: 'シミュレーター: これは実際の AWS コンソールではありません', disableUtilityCollapse: true }, ...(utilities ?? [])]}
      />
    </div>
  );
}

export function AppShell({ active, children }: { active: '/courses' | '/progress' | '/prompt'; children: ReactNode }) {
  const navigate = useNavigate();
  return (
    <>
      <AppTopNav />
      <AppLayout
        headerSelector="#top-nav"
        toolsHide
        navigation={
          <SideNavigation
            header={{ text: 'AWS Learning', href: '#/courses' }}
            activeHref={`#${active}`}
            onFollow={(e) => {
              e.preventDefault();
              navigate({ to: e.detail.href.slice(1) });
            }}
            items={[
              { type: 'link', text: 'Courses', href: '#/courses' },
              { type: 'link', text: 'Progress', href: '#/progress' },
              { type: 'link', text: 'Prompt', href: '#/prompt' },
            ]}
          />
        }
        content={children}
      />
    </>
  );
}
