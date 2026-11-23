import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createAnalyzer } from '../../sim/ext/accessanalyzer';
import { accessAnalyzerEnv, EXPORTS_BUCKET, VENDOR_ROLE } from '../../sim/ext/accessanalyzer-scenario';
import { deleteBucketPolicy } from '../../sim/s3';
import { useConsole } from '../store';
import { CreateAnalyzerPage, CreateArchiveRulePage, FindingDetail, FindingList, UnusedFindingDetail } from './access-analyzer';

const state = () => useConsole.getState();
const external = () => state().env.accessAnalyzer!.analyzers.find((a) => a.type === 'ACCOUNT')!;
const unused = () => state().env.accessAnalyzer!.analyzers.find((a) => a.type === 'ACCOUNT_UNUSED_ACCESS')!;

beforeEach(() => {
  const env = accessAnalyzerEnv();
  state().load({ env, path: '/iam/access-analyzer/findings', region: env.region, visited: [], copied: [], browser: [], commands: [] });
});
afterEach(cleanup);

describe('IAM Access Analyzer console', () => {
  it('without an analyzer, リソース分析 offers to create one; the form creates it and lists the findings', async () => {
    const user = userEvent.setup();
    render(<FindingList unused={false} />);
    expect(screen.getByText('外部アクセスアナライザーがありません')).toBeInTheDocument();
    await user.click(screen.getByTestId('aa-create-analyzer'));
    expect(state().path).toBe('/iam/access-analyzer/analyzers/create?type=external');
    cleanup();

    render(<CreateAnalyzerPage />);
    expect((screen.getByTestId('aa-analyzer-name').querySelector('input') as HTMLInputElement).value).toMatch(/^ExternalAccess-ConsoleAnalyzer-[0-9a-f]{8}$/);
    await user.click(within(screen.getByTestId('aa-create-submit')).getByRole('button'));
    expect(external().findings).toHaveLength(4);
    expect(state().path).toBe('/iam/access-analyzer/findings');
    cleanup();

    render(<FindingList unused={false} />);
    const table = screen.getByTestId('aa-findings');
    expect(within(table).getByText(EXPORTS_BUCKET)).toBeInTheDocument();
    expect(within(table).getByText('すべてのプリンシパル (*)')).toBeInTheDocument();
    expect(within(table).getAllByText('AWS アカウント: 999988887777')).toHaveLength(2);
  });

  it('an archive rule previews the matching active findings and archives them', async () => {
    const user = userEvent.setup();
    state().run((d) => createAnalyzer(d, { name: 'ext', type: 'ACCOUNT' }));
    render(<CreateArchiveRulePage analyzer="ext" />);
    await user.type(screen.getByTestId('aa-rule-value-0').querySelector('input')!, '999988887777');
    expect(within(screen.getByTestId('aa-rule-preview')).getAllByText('AWS アカウント: 999988887777')).toHaveLength(2);
    await user.click(screen.getByTestId('aa-rule-create-archive'));
    expect(external().archiveRules).toHaveLength(1);
    expect(external().findings.filter((f) => f.status === 'ARCHIVED')).toHaveLength(2);
    expect(state().path).toBe('/iam/access-analyzer/analyzers/view?name=ext');
  });

  it('rescan resolves the finding after the bucket policy is fixed', async () => {
    const user = userEvent.setup();
    state().run((d) => createAnalyzer(d, { name: 'ext', type: 'ACCOUNT' }));
    const f = external().findings.find((x) => x.resource === `arn:aws:s3:::${EXPORTS_BUCKET}`)!;
    render(<FindingDetail analyzer="ext" id={f.id} />);
    expect(screen.getByTestId('aa-finding-status')).toHaveTextContent('アクティブ');
    state().run((d) => deleteBucketPolicy(d, EXPORTS_BUCKET));
    await user.click(screen.getByTestId('aa-rescan'));
    expect(screen.getByTestId('aa-finding-status')).toHaveTextContent('解決済み');
    expect(state().env.trailEvents.at(-1)?.eventName).toBe('StartResourceScan');
  });

  it('an unused role finding deletes the role from its recommendation', async () => {
    const user = userEvent.setup();
    state().run((d) => createAnalyzer(d, { name: 'unused', type: 'ACCOUNT_UNUSED_ACCESS' }));
    const f = unused().findings.find((x) => x.findingType === 'UnusedIAMRole')!;
    render(<UnusedFindingDetail analyzer="unused" id={f.id} />);
    expect(screen.getByText('未使用のロール')).toBeInTheDocument();
    await user.click(screen.getByTestId('aa-delete-role'));
    await user.type(screen.getByTestId('aa-delete-role-input').querySelector('input')!, '削除');
    await user.click(screen.getByTestId('aa-delete-role-confirm'));
    expect(state().env.iamRoles.some((r) => r.roleName === VENDOR_ROLE)).toBe(false);
  });
});
