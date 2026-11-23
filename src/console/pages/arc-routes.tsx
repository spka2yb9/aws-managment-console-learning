import type { ConsoleRoute, Crumb } from '../routes';
import { useConsole } from '../store';
import { AutoshiftList, ConfigureAutoshift, EditLbAttributes, StartZonalShift, ZonalShiftList } from './arc';

const ARC: Crumb = { text: 'Application Recovery Controller', href: '/arc/zonal-shift' };
const SHIFTS: Crumb = { text: 'ゾーンシフト', href: '/arc/zonal-shift' };
const AUTO: Crumb = { text: 'ゾーンオートシフト', href: '/arc/zonal-autoshift' };
const here = (text: string): Crumb => ({ text, href: '' });

export const ARC_ROUTES: ConsoleRoute[] = [
  { pattern: '/arc/zonal-shift', service: 'arc', contentType: 'table', crumbs: () => [ARC, here('ゾーンシフト')], render: () => <ZonalShiftList /> },
  { pattern: '/arc/zonal-shift/start', service: 'arc', contentType: 'form', crumbs: () => [ARC, SHIFTS, here('ゾーンシフトを開始')], render: () => <StartZonalShift key={useConsole.getState().path} /> },
  { pattern: '/arc/zonal-autoshift', service: 'arc', crumbs: () => [ARC, here('ゾーンオートシフト')], render: () => <AutoshiftList /> },
  { pattern: '/arc/zonal-autoshift/configure', service: 'arc', contentType: 'form', crumbs: () => [ARC, AUTO, here('ゾーンオートシフトを設定')], render: () => <ConfigureAutoshift key={useConsole.getState().path} /> },
  // the ALB's 属性 tab (EC2 console): ARC ゾーンシフト統合 is a load balancer attribute
  {
    pattern: '/ec2/load-balancers/:name/edit-attributes',
    service: 'ec2',
    contentType: 'form',
    crumbs: (p) => [{ text: 'EC2', href: '/ec2/home' }, { text: 'ロードバランサー', href: '/ec2/load-balancers' }, { text: p.name, href: `/ec2/load-balancers/${p.name}` }, here('ロードバランサー属性を編集')],
    render: (p) => <EditLbAttributes name={p.name} key={p.name} />,
  },
];
