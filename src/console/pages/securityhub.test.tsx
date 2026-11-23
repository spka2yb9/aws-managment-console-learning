import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NEWSLETTER_BUCKET, securityHubEnv } from '../../sim/ext/securityhub-scenario';
import { controlStatus } from '../../sim/ext/securityhub';
import { matchRoute } from '../routes';
import { useConsole } from '../store';

/** renders whatever page the console path points at (navigation works like in the app) */
function Page() {
  const path = useConsole((s) => s.path);
  const m = matchRoute(path)!;
  return <>{m.route.render(m.params)}</>;
}

const open = (path: string) => {
  useConsole.getState().navigate(path);
  return render(<Page />);
};
const hub = () => useConsole.getState().env.securityHub!;

describe('Security Hub CSPM console', () => {
  // jsdom has no scrolling (navigate() scrolls to the top)
  beforeAll(() => vi.spyOn(window, 'scrollTo').mockImplementation(() => {}));
  beforeEach(() => {
    const env = securityHubEnv();
    useConsole.getState().load({ env, path: '/securityhub/home', region: env.region, visited: [], copied: [], browser: [], commands: [] });
  });

  it('enables Security Hub CSPM with both default standards and shows the score and failed controls', async () => {
    const user = userEvent.setup();
    open('/securityhub/home');
    expect(screen.getByText('AWS 基礎セキュリティのベストプラクティス v1.0.0 を有効化')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Security Hub CSPM を有効にする' }));
    expect(hub().standards.map((s) => s.key)).toEqual(['fsbp', 'cis']);
    expect(screen.getByTestId('sh-score')).toHaveTextContent('33%');
    expect(screen.getByTestId('sh-score')).toHaveTextContent('12 件中 4 件のコントロールが合格');
    expect(screen.getByTestId('sh-failed-CRITICAL')).toHaveTextContent('2');
    const failed = within(screen.getByTestId('sh-failed-controls'));
    expect(failed.getByText('EC2.19')).toBeInTheDocument();
    expect(failed.getByText('RDS.2')).toBeInTheDocument();
    // GuardDuty's finding came in too
    expect(screen.getByText('GuardDuty')).toBeInTheDocument();
  });

  it('suppresses a finding with a note from the control page; the control passes', async () => {
    const user = userEvent.setup();
    open('/securityhub/home');
    await user.click(screen.getByRole('button', { name: 'Security Hub CSPM を有効にする' }));
    useConsole.getState().navigate('/securityhub/controls/S3.8');
    expect(await screen.findByTestId('sh-control-status')).toHaveTextContent('失敗');
    const assets = hub().findings.find((f) => f.controlId === 'S3.8' && f.resource.id.endsWith(NEWSLETTER_BUCKET))!;
    await user.click(screen.getByRole('checkbox', { name: `${assets.resource.id} を選択` }));
    await user.click(screen.getByRole('button', { name: 'ワークフローのステータス' }));
    await user.click(screen.getByText('抑制済み'));
    await user.type(screen.getByRole('textbox', { name: /メモ/ }), 'ニュースレター画像は意図して公開');
    await user.click(screen.getByRole('button', { name: 'ステータスの設定' }));
    const f = hub().findings.find((x) => x.id === assets.id)!;
    expect(f.workflow).toBe('SUPPRESSED');
    expect(f.note?.text).toBe('ニュースレター画像は意図して公開');
    expect(controlStatus(useConsole.getState().env, 'S3.8')).toBe('PASSED');
    expect(screen.getByTestId('sh-control-status')).toHaveTextContent('合格');
  });

  it('creates an automation rule for dev-tagged resources, with a preview of the matching findings', async () => {
    const user = userEvent.setup();
    open('/securityhub/home');
    await user.click(screen.getByRole('button', { name: 'Security Hub CSPM を有効にする' }));
    useConsole.getState().navigate('/securityhub/automations');
    await user.click(await screen.findByRole('button', { name: 'ルールを作成' }));
    await user.type(screen.getByRole('textbox', { name: 'ルール名' }), 'dev-low-priority');
    await user.type(screen.getByRole('textbox', { name: '説明' }), '開発環境の検出結果は優先度を下げる');
    await user.type(screen.getByRole('textbox', { name: 'タグキー' }), 'Environment');
    await user.type(screen.getByRole('textbox', { name: '値' }), 'dev');
    // dev-sandbox's EC2.8 / EC2.9, dev-sg's checks and GuardDuty's finding
    expect(within(screen.getByTestId('sh-rule-preview')).getAllByText(/dev-sandbox|dev-sg/).length).toBeGreaterThan(2);
    await user.click(within(screen.getByTestId('sh-action-severity')).getByRole('button'));
    await user.click(screen.getByText('LOW'));
    await user.type(screen.getByRole('textbox', { name: 'メモ' }), '開発環境');
    await user.click(screen.getByRole('button', { name: 'ルールを作成' }));
    expect(hub().automationRules).toHaveLength(1);
    expect(hub().automationRules[0]).toMatchObject({ ruleName: 'dev-low-priority', ruleOrder: 1, ruleStatus: 'ENABLED', criteria: { ResourceTags: [{ Key: 'Environment', Value: 'dev', Comparison: 'EQUALS' }] } });
    expect(hub().automationRules[0].actions[0].FindingFieldsUpdate).toMatchObject({ Severity: { Label: 'LOW' }, Note: { Text: '開発環境' } });
    expect(useConsole.getState().path).toBe('/securityhub/automations');
    expect(await screen.findByText('dev-low-priority')).toBeInTheDocument();
  });
});
