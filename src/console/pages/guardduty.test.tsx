import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { byName } from '../../sim/env';
import { metadataOptions, sessionsRevokedBefore } from '../../sim/ext/credentials';
import { ADMIN_ROLE, FINDING_IDS, guardDutyEnv, STOLEN_KEY } from '../../sim/ext/guardduty-scenario';
import { useConsole } from '../store';
import { CreateSuppressionRule, GdFindings, GdSummary, ModifyMetadataOptions, RevokeSessions } from './guardduty';

const load = (path: string) => {
  const env = guardDutyEnv();
  useConsole.getState().load({ env, path, region: env.region, visited: [], copied: [], browser: [], commands: [] });
  return env;
};
const state = () => useConsole.getState();

// Cloudscape in jsdom is slow: give each interaction test some room
vi.setConfig({ testTimeout: 30_000 });

describe('GuardDuty console', () => {
  it('summary counts the current findings by severity', () => {
    load('/guardduty/home');
    render(<GdSummary />);
    expect(within(screen.getByTestId('summary-high')).getByText('1')).toBeInTheDocument();
    expect(within(screen.getByTestId('summary-critical')).getByText('0')).toBeInTheDocument();
  });

  it('findings: open the High finding, then archive it with the Portscan', async () => {
    const user = userEvent.setup();
    const env = load('/guardduty/findings');
    render(<GdFindings />);
    const table = screen.getByTestId('gd-findings');
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3 findings
    await user.click(screen.getByTestId(`finding-${FINDING_IDS.exfiltration}`));
    expect(state().path).toBe(`/guardduty/findings?id=${FINDING_IDS.exfiltration}`);
    const detail = await screen.findByTestId('gd-finding-detail');
    expect(within(detail).getByTestId('gd-access-key')).toHaveTextContent(STOLEN_KEY);
    expect(within(detail).getByText('Amsterdam, Netherlands')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: `${FINDING_IDS.exfiltration} を選択` }));
    await user.click(screen.getByRole('checkbox', { name: `${FINDING_IDS.portscan} を選択` }));
    await user.click(within(screen.getByTestId('gd-actions')).getByRole('button'));
    await user.click(screen.getByText('アーカイブ', { selector: '[role="menuitem"] *' }));
    const archived = state().env.guardDuty!.findings.filter((f) => f.service.archived).map((f) => f.id).sort();
    expect(archived).toEqual([FINDING_IDS.exfiltration, FINDING_IDS.portscan].sort());
    expect(within(screen.getByTestId('gd-findings')).getAllByRole('row')).toHaveLength(2); // only the Low finding is current
    expect(env.guardDuty!.findings.every((f) => !f.service.archived)).toBe(true); // the store works on copies
  });

  it('creates a suppression rule for scanner-1 and previews what it matches', async () => {
    const user = userEvent.setup();
    const env = load('/guardduty/suppression-rules/create');
    const scanner = byName(env.instances, 'scanner-1')!.instanceId;
    render(<CreateSuppressionRule />);
    const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId).querySelector('input')!, { target: { value } });
    type('gd-rule-name', 'scanner-portscan');
    type('gd-rule-value-0', 'Recon:EC2/Portscan');
    await user.click(screen.getByTestId('gd-rule-add'));
    type('gd-rule-value-1', scanner);
    expect(within(screen.getByTestId('gd-rule-matches')).getAllByText(/performing outbound port scans/)).toHaveLength(1);
    await user.click(within(screen.getByTestId('gd-suppression-submit')).getByRole('button'));
    expect(state().env.guardDuty!.filters).toMatchObject([{ name: 'scanner-portscan', action: 'ARCHIVE', criterion: { type: { Equals: ['Recon:EC2/Portscan'] }, 'resource.instanceDetails.instanceId': { Equals: [scanner] } } }]);
    expect(state().path).toBe('/guardduty/suppression-rules');
  });

  it('EC2: requires IMDSv2 on admin-1', async () => {
    const user = userEvent.setup();
    const env = load('/ec2/instances');
    const id = byName(env.instances, 'admin-1')!.instanceId;
    render(<ModifyMetadataOptions id={id} />);
    await user.click(within(screen.getByTestId('imds-tokens')).getByLabelText(/必須/));
    await user.click(within(screen.getByTestId('imds-save')).getByRole('button'));
    expect(metadataOptions(byName(state().env.instances, 'admin-1')!)).toEqual({ httpTokens: 'required', httpPutResponseHopLimit: 1, httpEndpoint: 'enabled' });
    expect(state().path).toBe(`/ec2/instances/${id}`);
  });

  it('IAM: revokes the role sessions after the acknowledgement', async () => {
    const user = userEvent.setup();
    load(`/iam/roles/${ADMIN_ROLE}?tab=revoke`);
    render(<RevokeSessions name={ADMIN_ROLE} />);
    await user.click(screen.getByTestId('revoke-sessions'));
    const confirm = within(screen.getByTestId('revoke-sessions-confirm')).queryByRole('button') ?? screen.getByTestId('revoke-sessions-confirm');
    expect(confirm).toBeDisabled();
    await user.click(within(screen.getByTestId('revoke-sessions-ack')).getByRole('checkbox'));
    await user.click(screen.getByTestId('revoke-sessions-confirm'));
    expect(sessionsRevokedBefore(state().env, ADMIN_ROLE)).toBeGreaterThan(Date.now());
    expect(await screen.findByText('アクティブなセッションは取り消されています')).toBeInTheDocument();
  });
});
