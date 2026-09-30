import AppLayout from '@cloudscape-design/components/app-layout';
import Autosuggest, { type AutosuggestProps } from '@cloudscape-design/components/autosuggest';
import BreadcrumbGroup from '@cloudscape-design/components/breadcrumb-group';
import Flashbar from '@cloudscape-design/components/flashbar';
import SideNavigation from '@cloudscape-design/components/side-navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { AppTopNav } from '../app/AppShell';
import { REGIONS, regionOf } from '../sim/env';
import { activeHref, FEATURES, SERVICES, SIDE_NAV } from './nav';
import { GLOBAL_SERVICES, matchRoute } from './routes';
import { useConsole } from './store';
import { useEnv } from './ui';

const SEARCH_OPTIONS: AutosuggestProps.OptionGroup[] = [
  { label: 'サービス', options: SERVICES.map((s) => ({ value: s.home, label: s.name, description: s.description })) },
  // English names stay searchable ("security", "instances"), like the real console search.
  { label: '機能', options: FEATURES.map((f) => ({ value: f.path, label: f.name, description: `${f.service} の機能`, filteringTags: [f.service, f.en, ...f.en.split(' ')] })) },
];

/** Unified search in the top bar ("Search [Alt+S]"): the fastest way to reach a service in the real console. */
function ServiceSearch() {
  const navigate = useConsole((s) => s.navigate);
  const [value, setValue] = useState('');
  // No Hotspot here: TopNavigation renders its search slot twice (one hidden copy for measuring).
  return (
    <div className="console-search" data-testid="service-search">
      <Autosuggest
        value={value}
        onChange={(e) => setValue(e.detail.value)}
        onSelect={(e) => {
          navigate(e.detail.value);
          setValue('');
        }}
        options={SEARCH_OPTIONS}
        placeholder="検索 [Alt+S]"
        ariaLabel="サービスと機能を検索"
        empty="一致するサービスはありません"
        hideEnteredTextOption
        filteringType="auto"
        expandToViewport
      />
    </div>
  );
}

function useAltS() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.code !== 'KeyS') return;
      e.preventDefault();
      const inputs = [...document.querySelectorAll<HTMLInputElement>('.console-search input')];
      inputs.find((i) => i.offsetParent !== null)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function ConsoleTopNav({ onExit, global }: { onExit: () => void; global?: boolean }) {
  useAltS();
  const region = useConsole((s) => s.region);
  const setRegion = useConsole((s) => s.setRegion);
  const navigate = useConsole((s) => s.navigate);
  const env = useConsole((s) => s.env);
  const r = regionOf(region);
  return (
    <AppTopNav
      search={<ServiceSearch />}
      utilities={[
        { type: 'menu-dropdown', text: 'サービス', iconName: 'menu', items: SERVICES.map((s) => ({ id: s.home, text: s.name, secondaryText: s.description })), onItemClick: (e) => navigate(e.detail.id) },
        global ? { type: 'button', text: 'グローバル', ariaLabel: 'リージョン: グローバル (このサービスはリージョンを選択する必要はありません)', disableUtilityCollapse: true } : {
          type: 'menu-dropdown',
          text: r.name.match(/\((.*)\)/)?.[1] ?? r.code,
          title: `${r.name} ${r.code}`,
          ariaLabel: `リージョン: ${r.name}`,
          items: REGIONS.map((x) => ({ id: x.code, text: x.name, secondaryText: x.code, iconName: x.code === region ? 'check' : undefined })),
          onItemClick: (e) => setRegion(e.detail.id),
        },
        {
          type: 'menu-dropdown',
          text: `learner @ ${env.accountId.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3')}`,
          iconName: 'user-profile',
          items: [
            { id: 'account', text: `アカウント ID: ${env.accountId.replace(/(\d{4})(\d{4})(\d{4})/, '$1-$2-$3')}`, disabled: true },
            { id: 'exit', text: 'レッスンを終了 (コース一覧へ)' },
          ],
          onItemClick: (e) => e.detail.id === 'exit' && onExit(),
        },
      ]}
    />
  );
}

export function ConsoleLayout({ lessonPanel, onExit }: { lessonPanel: ReactNode; onExit: () => void }) {
  const path = useConsole((s) => s.path);
  const navigate = useConsole((s) => s.navigate);
  const flashes = useConsole((s) => s.flashes);
  const env = useEnv();
  const [drawer, setDrawer] = useState<string | null>('lesson');
  // closed per service: going through the (nav-less) home page must not collapse the next service's nav
  const [navClosedFor, setNavClosedFor] = useState<string | null>(null);
  const m = matchRoute(path) ?? matchRoute('/console/home')!;
  const service = m.route.service;
  const crumbs = m.route.crumbs(m.params, env);
  const follow = (e: CustomEvent<{ href: string }>) => {
    e.preventDefault();
    if (e.detail.href && e.detail.href !== '#') navigate(e.detail.href);
  };
  return (
    <>
      <ConsoleTopNav onExit={onExit} global={GLOBAL_SERVICES.includes(service)} />
      <AppLayout
        headerSelector="#top-nav"
        navigationHide={service === 'console'}
        navigationOpen={navClosedFor !== service}
        onNavigationChange={(e) => setNavClosedFor(e.detail.open ? null : service)}
        minContentWidth={480}
        navigation={service !== 'console' && <SideNavigation header={SIDE_NAV[service].header} items={SIDE_NAV[service].items} activeHref={activeHref(path)} onFollow={follow} />}
        breadcrumbs={<BreadcrumbGroup items={crumbs.map((c) => ({ text: c.text, href: c.href || '#' }))} onFollow={follow} ariaLabel="パンくずリスト" />}
        notifications={<Flashbar items={flashes} />}
        contentType={m.route.contentType ?? 'default'}
        content={<div data-testid="console-content" key={path.split('?')[0]}>{m.route.render(m.params)}</div>}
        toolsHide
        drawers={[
          {
            id: 'lesson',
            content: lessonPanel,
            trigger: { iconName: 'contact' },
            ariaLabels: { drawerName: 'レッスン', closeButton: 'レッスンパネルを閉じる', triggerButton: 'レッスンパネルを開く', resizeHandle: 'レッスンパネルのサイズ変更' },
            resizable: true,
            defaultSize: 440,
          },
        ]}
        activeDrawerId={drawer}
        onDrawerChange={(e) => setDrawer(e.detail.activeDrawerId)}
      />
    </>
  );
}
