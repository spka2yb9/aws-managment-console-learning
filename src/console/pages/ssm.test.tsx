import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { byName } from '../../sim/env';
import { EC2_ROLE, SESSION_LOG_GROUP, sessionManagerEnv } from '../../sim/ext/ssm-scenario';
import { attachPolicy } from '../../sim/iam';
import { advanceTime } from '../../sim/time';
import { useConsole } from '../store';
import { EditPreferences, FleetManager, SessionManagerConnect, SessionTerminal, StartSessionPage } from './ssm';

function load(ready: boolean) {
  const env = sessionManagerEnv();
  if (ready) {
    attachPolicy(env, 'role', EC2_ROLE, 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore');
    advanceTime(env, Infinity);
  }
  useConsole.getState().load({ env, path: '/ssm/fleet-manager', region: env.region, visited: [], copied: [], browser: [], commands: [] });
  return { web: byName(env.instances, 'web-1')!.instanceId, batch: byName(env.instances, 'batch-1')!.instanceId };
}

// Cloudscape's tables and selects are slow in jsdom when the whole suite runs in parallel
describe('Systems Manager console', { timeout: 20_000 }, () => {
  it('Fleet Manager lists only registered nodes', () => {
    load(false);
    const { unmount } = render(<FleetManager />);
    expect(screen.getByText('マネージドノードがありません')).toBeInTheDocument();
    unmount();
    const { web } = load(true);
    render(<FleetManager />);
    const table = screen.getByTestId('ssm-nodes');
    expect(within(table).getByText(web)).toBeInTheDocument();
    expect(within(table).getByText('オンライン')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(2); // header + web-1 (batch-1 has no path to the endpoints)
  });

  it('the EC2 connect tab explains why the private instance is not online', () => {
    const { batch } = load(true);
    render(<SessionManagerConnect id={batch} />);
    expect(screen.getByText('SSM Agent がオンラインになっていません')).toBeInTheDocument();
    expect(within(screen.getByTestId('ssm-diagnosis')).getAllByText(/プライベート DNS 名を有効にしたインターフェイスエンドポイントが必要です/)).toHaveLength(3);
    expect(screen.getByTestId('ssm-connect')).toBeDisabled();
  });

  it('start a session, run a command as ssm-user, terminate it', async () => {
    const user = userEvent.setup();
    const { web } = load(true);
    const { unmount } = render(<StartSessionPage />);
    await user.type(screen.getByTestId('ssm-reason').querySelector('input')!, 'check web-1');
    await user.click(screen.getAllByLabelText(`${web} を選択`)[0]);
    await user.click(within(screen.getByTestId('ssm-start-submit')).getByRole('button'));
    const path = useConsole.getState().path;
    expect(path).toMatch(/^\/ssm\/session-manager\/learner-[0-9a-f]{17}$/);
    unmount();
    const id = path.split('/').pop()!;
    render(<SessionTerminal id={id} />);
    await user.type(screen.getByTestId('ssm-terminal-input'), 'whoami{Enter}');
    expect(screen.getByTestId('terminal-output')).toHaveTextContent('ssm-user');
    await user.click(screen.getByTestId('ssm-terminate'));
    expect(screen.getByTestId('ssm-terminated')).toBeInTheDocument();
    expect(useConsole.getState().env.ssm!.sessions[0]).toMatchObject({ sessionId: id, status: 'Terminated', reason: 'check web-1' });
  });

  it('preferences: turn on CloudWatch logging to the prepared log group', async () => {
    const user = userEvent.setup();
    load(true);
    render(<EditPreferences />);
    await user.click(within(screen.getByTestId('ssm-cw-enable')).getByRole('checkbox'));
    await user.click(within(screen.getByTestId('ssm-cw-group')).getByRole('button'));
    await user.click(await screen.findByRole('option', { name: SESSION_LOG_GROUP }));
    await user.click(within(screen.getByTestId('ssm-prefs-save')).getByRole('button'));
    expect(useConsole.getState().env.ssm!.preferences).toMatchObject({ cloudWatchLogGroupName: SESSION_LOG_GROUP, cloudWatchStreamingEnabled: true });
    expect(useConsole.getState().path).toBe('/ssm/session-manager?tab=preferences');
  });
});
