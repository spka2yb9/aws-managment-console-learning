import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ANTI_DDOS, DEFAULT_EXEMPT } from '../../sim/ext/antiddos';
import { antiDdosEnv } from '../../sim/ext/antiddos-scenario';
import { groupRule, GROUP_RULE, counting, onTop, protecting, appExempt } from '../../lessons/l42-anti-ddos';
import { useConsole } from '../store';
import { AddManagedRuleGroups, EditManagedRuleGroup } from './antiddos';
import { WebAclDetail } from './edge';

const load = (path: string) => useConsole.getState().load({ env: antiDdosEnv(), path, region: 'ap-northeast-1', visited: [], copied: [], browser: [], commands: [] });
const env = () => useConsole.getState().env;

/** Cloudscape Select: open it, pick the option */
async function choose(user: ReturnType<typeof userEvent.setup>, select: HTMLElement, option: string | RegExp) {
  await user.click(within(select).getByRole('button'));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('WAF console: Anti-DDoS (lesson 42)', () => {
  it('adds the rule group in Count on top, then the sampled requests show its labels', async () => {
    const user = userEvent.setup();
    load('/wafv2/webacls/webapp-acl/add-managed-rule-groups');
    const { unmount } = render(<AddManagedRuleGroups name="webapp-acl" />);
    expect(screen.getByText('AWS マネージドルールグループ')).toBeInTheDocument();
    expect(screen.queryByText('ブロックの感度レベル')).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId(`add-${ANTI_DDOS}`)).getByRole('checkbox'));
    // the group's settings appear with AWS's defaults
    expect(screen.getByText('ブロックの感度レベル')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /低/, checked: true })).toBeInTheDocument();
    expect(screen.getByLabelText('除外 URI の正規表現 1')).toHaveValue(DEFAULT_EXEMPT);
    await choose(user, screen.getByTestId('antiddos-override-all'), 'カウント (Count)');
    // new rules go to the bottom: move it to the top
    const priority = within(screen.getByTestId('waf-priority'));
    expect(priority.getAllByRole('row').at(-1)).toHaveTextContent(GROUP_RULE);
    await user.click(screen.getByTestId('waf-move-up'));
    await user.click(screen.getByTestId('waf-move-up'));
    await user.click(within(screen.getByTestId('waf-rules-save')).getByRole('button'));
    expect(groupRule(env())).toBeDefined();
    expect(counting(env()) && onTop(env())).toBe(true);
    expect(useConsole.getState().path).toBe('/wafv2/webacls/webapp-acl?tab=rules');
    unmount();

    // samples filtered by the group: COUNT with Anti-DDoS labels
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
    useConsole.getState().navigate(`/wafv2/webacls/webapp-acl?tab=overview&rule=${GROUP_RULE}`);
    render(<WebAclDetail name="webapp-acl" />);
    vi.useRealTimers();
    const samples = within(screen.getByTestId('waf-samples'));
    expect(samples.getAllByText('awswaf:managed:aws:anti-ddos:event-detected').length).toBeGreaterThan(0);
    expect(samples.getAllByText('COUNT').length).toBeGreaterThan(0);
    expect(samples.queryByText('ALLOW')).not.toBeInTheDocument();
  });

  it('edits the group: exempts /app/ and removes the Count overrides', async () => {
    const user = userEvent.setup();
    load('/wafv2/webacls/webapp-acl/add-managed-rule-groups');
    render(<AddManagedRuleGroups name="webapp-acl" />);
    await user.click(within(screen.getByTestId(`add-${ANTI_DDOS}`)).getByRole('checkbox'));
    await choose(user, screen.getByTestId('antiddos-override-all'), 'カウント (Count)');
    await user.click(within(screen.getByTestId('waf-rules-save')).getByRole('button'));
    expect(counting(env())).toBe(true);

    const { container } = render(<EditManagedRuleGroup name="webapp-acl" rule={GROUP_RULE} />);
    const page = within(container);
    expect(page.getByRole('heading', { name: `${GROUP_RULE} を編集` })).toBeInTheDocument();
    await user.click(page.getByTestId('antiddos-exempt-add'));
    await user.type(page.getByLabelText('除外 URI の正規表現 2'), '/app/');
    await choose(user, page.getByTestId('antiddos-override-all'), 'すべてのオーバーライドを削除');
    await user.click(within(page.getByTestId('waf-rules-save')).getByRole('button'));
    expect(appExempt(env()) && protecting(env())).toBe(true);
  });

  it('shows the API error on the form (an invalid regex)', async () => {
    const user = userEvent.setup();
    load('/wafv2/webacls/webapp-acl/add-managed-rule-groups');
    render(<AddManagedRuleGroups name="webapp-acl" />);
    await user.click(within(screen.getByTestId(`add-${ANTI_DDOS}`)).getByRole('checkbox'));
    await user.click(screen.getByTestId('antiddos-exempt-add'));
    await user.type(screen.getByLabelText('除外 URI の正規表現 2'), '(');
    await user.click(within(screen.getByTestId('waf-rules-save')).getByRole('button'));
    expect(screen.getAllByTestId('form-error')[0]).toHaveTextContent('REGEX_STRING');
    expect(groupRule(env())).toBeUndefined();
  });
});
