// jsdom: the ARC pages and the ALB attribute page drive the simulator like the lesson does.
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { configOf, zonalShiftEnabled } from '../../sim/ext/zonalshift';
import { zonalShiftEnv } from '../../sim/ext/zonalshift-scenario';
import { useConsole } from '../store';
import { AutoshiftList, ConfigureAutoshift, EditLbAttributes, StartZonalShift, ZonalShiftList } from './arc';
import { MetricsPage } from './cloudwatch';

const load = (path: string) => act(() => useConsole.getState().load({ env: zonalShiftEnv(), path, region: 'ap-northeast-1', visited: [], copied: [], browser: [], commands: [] }));
const env = () => useConsole.getState().env;
const lb = () => env().loadBalancers[0];
/** Cloudscape Select / Multiselect: open the dropdown, pick the option */
async function choose(user: ReturnType<typeof userEvent.setup>, testId: string, option: string | RegExp) {
  await user.click(within(screen.getByTestId(testId)).getAllByRole('button')[0]);
  await user.click(screen.getAllByRole('option', { name: option })[0]);
}

describe('ARC console pages', { timeout: 30_000 }, () => {
  afterEach(cleanup);

  it('ロードバランサー属性を編集: ARC ゾーンシフト統合を有効化して保存', async () => {
    const user = userEvent.setup();
    load('/ec2/load-balancers/web-alb/edit-attributes');
    render(<EditLbAttributes name="web-alb" />);
    await user.click(within(screen.getByTestId('zonal-shift-toggle')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('save-lb-attributes')).getByRole('button'));
    expect(zonalShiftEnabled(lb())).toBe(true);
    expect(useConsole.getState().path).toBe('/ec2/load-balancers/web-alb?tab=attributes');
  });

  it('ゾーンシフトを開始 → 一覧に出る → キャンセル', async () => {
    const user = userEvent.setup();
    load('/arc/zonal-shift/start');
    act(() => void useConsole.getState().run((d) => (d.loadBalancers[0].attributes = { 'zonal_shift.config.enabled': 'true' })));
    render(<StartZonalShift />);
    const submit = within(screen.getByTestId('start-shift-submit')).getByRole('button');
    expect(submit).toBeDisabled();
    await choose(user, 'shift-az', 'apne1-az2 (ap-northeast-1c)');
    await user.click(within(screen.getByTestId('shift-resources')).getByRole('radio'));
    await user.type(within(screen.getByTestId('shift-comment')).getByRole('textbox'), '1c gray failure');
    await user.click(within(screen.getByTestId('shift-ack')).getByRole('checkbox'));
    await user.click(submit);
    expect(env().zonalShift!.shifts).toMatchObject([{ awayFrom: 'apne1-az2', status: 'ACTIVE', comment: '1c gray failure', resourceIdentifier: lb().loadBalancerArn }]);
    expect(useConsole.getState().path).toBe('/arc/zonal-shift');
    cleanup();

    render(<ZonalShiftList />);
    const table = screen.getByTestId('zonal-shift-table');
    expect(within(table).getByText('アクティブ')).toBeInTheDocument();
    expect(within(table).getByText('適用済み')).toBeInTheDocument();
    await user.click(within(table).getByRole('radio'));
    await user.click(within(screen.getByTestId('zonal-shift-actions')).getByRole('button'));
    await user.click(screen.getByText('ゾーンシフトをキャンセル'));
    await user.click(screen.getByTestId('cancel-shift-confirm'));
    expect(env().zonalShift!.shifts[0].status).toBe('CANCELED');
  });

  it('ゾーンオートシフトを設定: 結果アラーム web-alb-5xx、有効化', async () => {
    const user = userEvent.setup();
    load('/arc/zonal-autoshift/configure');
    act(() => void useConsole.getState().run((d) => (d.loadBalancers[0].attributes = { 'zonal_shift.config.enabled': 'true' })));
    render(<ConfigureAutoshift />);
    await choose(user, 'autoshift-resource', /web-alb/);
    await choose(user, 'outcome-alarms', /^web-alb-5xx /);
    await user.click(within(screen.getByTestId('autoshift-ack')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('autoshift-submit')).getByRole('button'));
    const c = configOf(env(), lb().loadBalancerArn)!;
    expect(c.zonalAutoshiftStatus).toBe('ENABLED');
    expect(c.practiceRunConfiguration!.outcomeAlarms.map((a) => a.alarmIdentifier.split(':').pop())).toEqual(['web-alb-5xx']);
    cleanup();
    render(<AutoshiftList />);
    expect(within(screen.getByTestId('autoshift-table')).getByText('設定済み')).toBeInTheDocument();
  });

  it('CloudWatch: AppELB 別、AZ 別メトリクスに 3 つの AZ が並ぶ', () => {
    load('/cloudwatch/metrics?ns=AWS%2FApplicationELB%3AAZ');
    render(<MetricsPage />);
    const table = screen.getByTestId('metric-table');
    for (const az of ['ap-northeast-1a', 'ap-northeast-1c', 'ap-northeast-1d']) expect(within(table).getAllByText(az)).toHaveLength(3);
  });
});
