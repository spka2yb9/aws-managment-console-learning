// AWS Systems Manager: フリートマネージャー (managed nodes) and セッションマネージャー (sessions, history, preferences),
// plus the Session Manager tab of the EC2 "インスタンスに接続" page.
import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import Container from '@cloudscape-design/components/container';
import ExpandableSection from '@cloudscape-design/components/expandable-section';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import { useEffect, useRef, useState } from 'react';
import { label, mutate, nameOf } from '../../sim/env';
import { diagnoseNode, exitSession, managedNodes, pingStatus, preferencesOf, sessionCommand, sessionOf, SSM_PROMPT, startSession, terminateSession, terminatedMessage, updatePreferences, type PingStatus, type SsmSession } from '../../sim/ext/ssm';
import type { Check } from '../../sim/network';
import type { AwsError } from '../../sim/types';
import { instanceFiles, useConsole } from '../store';
import { ActionMenu, CONSOLE_USER_ARN, ConsoleLink, EditForm, formatDate, NotFound, ResourceDetail, ResourceTable, ResourceTabs, useEnv, useNavigate, useSelection } from '../ui';

const sessionPath = (id: string) => `/ssm/session-manager/${id}`;

function Ping({ status }: { status: PingStatus }) {
  return status === 'Online' ? <StatusIndicator type="success">オンライン</StatusIndicator> : <StatusIndicator type="error">接続が失われました</StatusIndicator>;
}

/** StartSession as the console user, then open the session's terminal tab. */
function useStartSession() {
  const run = useConsole((s) => s.run);
  const navigate = useNavigate();
  return (target: string, reason?: string) => {
    const r = run((d) => startSession(d, { target, reason, userName: 'learner', ownerArn: CONSOLE_USER_ARN(d) }));
    if (r.ok) navigate(sessionPath(r.value));
    return r;
  };
}

/** A command typed into the session's shell: runs as ssm-user and is recorded like the EC2 Instance Connect terminal. */
function runInSession(s: SsmSession, line: string) {
  const st = useConsole.getState();
  const at = Date.now();
  if (/^\s*(exit|logout)\s*$/.test(line)) {
    st.recordCommand({ instanceId: s.target, line, output: `Exiting session with sessionId: ${s.sessionId}.`, ok: true, at });
    st.run((d) => exitSession(d, s.sessionId, at));
    return;
  }
  const [env, r] = mutate(st.env, (d) => sessionCommand(d, s.sessionId, line, instanceFiles(st.commands, s.target), at));
  useConsole.setState({ env, commands: [...st.commands, { instanceId: s.target, line, at, ...r }].slice(-200) });
}

function Diagnosis({ title, checks }: { title: string; checks: Check[] }) {
  return (
    <ExpandableSection headerText={title} defaultExpanded variant="footer" data-testid="ssm-diagnosis">
      <ul className="trace-list">
        {checks.map((c, j) => (
          <li key={j}>
            <StatusIndicator type={c.ok ? 'success' : 'error'}>{c.label}</StatusIndicator>
            <Box variant="small" display="block" color="text-body-secondary">{c.detail}</Box>
          </li>
        ))}
      </ul>
    </ExpandableSection>
  );
}

export function FleetManager() {
  const env = useEnv();
  const start = useStartSession();
  const nodes = managedNodes(env);
  const [selected, setSelected] = useSelection(nodes, (n) => n.instance.instanceId);
  const one = selected[0];
  return (
    <ResourceTable
      title="マネージドノード"
      description="SSM Agent が Systems Manager に登録したノードです。セッションマネージャーで接続できるのは、SSM Agent の ping ステータスがオンラインのノードです。"
      resourceName="マネージドノード"
      testId="ssm-nodes"
      items={nodes}
      trackBy={(n) => n.instance.instanceId}
      selectedItems={selected}
      onSelectionChange={setSelected}
      actions={
        <Hotspot hotspotId="ssm-node-actions" direction="left">
          <ActionMenu text="ノードアクション" testId="ssm-node-actions" items={[{ text: '接続', items: [{ id: 'terminal', text: 'ターミナルセッションを開始', disabled: one?.pingStatus !== 'Online', onClick: () => start(one!.instance.instanceId) }] }]} />
        </Hotspot>
      }
      columns={[
        { id: 'id', header: 'ノード ID', cell: (n) => <ConsoleLink to={`/ec2/instances/${n.instance.instanceId}`}>{n.instance.instanceId}</ConsoleLink>, value: (n) => n.instance.instanceId },
        { id: 'name', header: 'ノード名', cell: (n) => n.name || '-', value: (n) => n.name },
        { id: 'ping', header: 'SSM Agent ping ステータス', cell: (n) => <Ping status={n.pingStatus} />, value: (n) => n.pingStatus },
        { id: 'platform', header: 'プラットフォームタイプ', cell: (n) => n.platformType, value: (n) => n.platformType },
        { id: 'os', header: 'オペレーティングシステム', cell: (n) => `${n.platformName} ${n.platformVersion}` },
        { id: 'ip', header: 'IP アドレス', cell: (n) => n.instance.privateIpAddress, value: (n) => n.instance.privateIpAddress },
        { id: 'agent', header: 'SSM Agent バージョン', cell: (n) => n.agentVersion },
        { id: 'ping-time', header: '最後の ping', cell: (n) => formatDate(n.lastPingAt) },
        { id: 'source', header: 'ソースタイプ', cell: () => 'AWS::EC2::Instance' },
      ]}
    />
  );
}

function SessionTable({ history }: { history: boolean }) {
  const env = useEnv();
  const run = useConsole((s) => s.run);
  const items = [...(env.ssm?.sessions ?? [])].filter((s) => (history ? s.status === 'Terminated' : s.status === 'Connected')).reverse();
  const [selected, setSelected] = useSelection(items, (s) => s.sessionId);
  const target = (s: SsmSession) => label(s.target, env.instances.find((i) => i.instanceId === s.target));
  return (
    <ResourceTable
      title={history ? 'セッション履歴' : 'セッション'}
      resourceName="セッション"
      variant="container"
      headerVariant="h2"
      testId={history ? 'ssm-history' : 'ssm-sessions'}
      items={items}
      trackBy={(s) => s.sessionId}
      selectionType={history ? 'none' : 'single'}
      selectedItems={selected}
      onSelectionChange={setSelected}
      actions={
        !history && (
          <Hotspot hotspotId="ssm-sessions-terminate" direction="left">
            <Button disabled={!selected.length} onClick={() => run((d) => terminateSession(d, selected[0].sessionId), `セッション ${selected[0].sessionId} を終了しました`)} data-testid="ssm-sessions-terminate">終了</Button>
          </Hotspot>
        )
      }
      columns={[
        { id: 'id', header: 'セッション ID', cell: (s) => (history ? s.sessionId : <ConsoleLink to={sessionPath(s.sessionId)}>{s.sessionId}</ConsoleLink>), value: (s) => s.sessionId },
        { id: 'owner', header: '所有者', cell: (s) => s.owner, value: (s) => s.owner },
        { id: 'target', header: 'インスタンス ID', cell: target, value: target },
        { id: 'status', header: 'ステータス', cell: (s) => (s.status === 'Connected' ? <StatusIndicator type="success">接続済み</StatusIndicator> : <StatusIndicator type="stopped">終了済み</StatusIndicator>) },
        { id: 'start', header: '開始日', cell: (s) => formatDate(s.startDate), value: (s) => s.startDate },
        ...(history ? [{ id: 'end', header: '終了日', cell: (s: SsmSession) => (s.endDate ? formatDate(s.endDate) : '-') }] : []),
        { id: 'reason', header: '理由', cell: (s) => s.reason ?? '-' },
        ...(history
          ? [{ id: 'output', header: '出力の場所', cell: (s: SsmSession) => (s.logGroupName ? <ConsoleLink to={`/cloudwatch/logs/events?${new URLSearchParams({ group: s.logGroupName, stream: s.sessionId })}`}>CloudWatch Logs</ConsoleLink> : '-') }]
          : []),
      ]}
    />
  );
}

function PreferencesView() {
  const env = useEnv();
  const navigate = useNavigate();
  const p = preferencesOf(env);
  const cw = !!p.cloudWatchLogGroupName;
  return (
    <ResourceDetail
      title="設定"
      columns={3}
      actions={
        <Hotspot hotspotId="ssm-prefs-edit" direction="left">
          <Button onClick={() => navigate('/ssm/session-manager/edit-preferences')} data-testid="ssm-prefs-edit">編集</Button>
        </Hotspot>
      }
      fields={[
        { label: 'アイドルセッションタイムアウト', value: `${p.idleSessionTimeout} 分` },
        { label: 'CloudWatch のログ記録', value: <span data-testid="ssm-pref-cw">{cw ? '有効' : '無効'}</span> },
        { label: 'CloudWatch ロググループ', value: cw ? p.cloudWatchLogGroupName : '-' },
        { label: 'ログオプション', value: cw ? (p.cloudWatchStreamingEnabled ? 'セッションログのストリーム' : 'セッションログのアップロード') : '-' },
        { label: 'S3 のログ記録', value: p.s3BucketName ? p.s3BucketName : '無効' },
        { label: 'Run As サポート', value: p.runAsEnabled ? '有効' : '無効' },
      ]}
    />
  );
}

export function SessionManagerHome() {
  const navigate = useNavigate();
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        description="ブラウザや AWS CLI から、インバウンドポートを開けず、踏み台ホストも SSH キーも使わずにマネージドノードに接続します。"
        actions={
          <Hotspot hotspotId="ssm-start-session" direction="left">
            <Button variant="primary" onClick={() => navigate('/ssm/session-manager/start')} data-testid="ssm-start-session">セッションの開始</Button>
          </Hotspot>
        }
      >
        セッションマネージャー
      </Header>
      <ResourceTabs
        tabs={[
          { id: 'sessions', label: 'セッション', content: <SessionTable history={false} /> },
          { id: 'history', label: 'セッション履歴', content: <SessionTable history /> },
          { id: 'preferences', label: '設定', content: <PreferencesView /> },
        ]}
      />
    </SpaceBetween>
  );
}

export function StartSessionPage() {
  const env = useEnv();
  const navigate = useNavigate();
  const start = useStartSession();
  const [reason, setReason] = useState('');
  const nodes = managedNodes(env).filter((n) => n.pingStatus === 'Online' && n.instance.state === 'running');
  const [selected, setSelected] = useSelection(nodes, (n) => n.instance.instanceId);
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="セッションの開始"
      submitText="セッションを開始"
      submitTestId="ssm-start-submit"
      submitHotspotId="ssm-start-submit"
      submitDisabled={!selected.length}
      onCancel={() => navigate('/ssm/session-manager')}
      error={error}
      onSubmit={() => {
        const r = start(selected[0].instance.instanceId, reason);
        if (!r.ok) setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">セッションの詳細</Header>}>
        <FormField label="セッションの理由 - オプション" description="セッションの理由はセッション履歴に表示されます。最大 256 文字です。">
          <Input value={reason} onChange={(e) => setReason(e.detail.value)} placeholder="例: バッチのログを確認する" data-testid="ssm-reason" />
        </FormField>
      </Container>
      <ResourceTable
        title="ターゲットインスタンス"
        description="接続するマネージドノードを選択します。"
        resourceName="インスタンス"
        variant="container"
        headerVariant="h2"
        testId="ssm-targets"
        items={nodes}
        trackBy={(n) => n.instance.instanceId}
        selectedItems={selected}
        onSelectionChange={setSelected}
        columns={[
          { id: 'name', header: 'インスタンス名', cell: (n) => n.name || '-', value: (n) => n.name },
          { id: 'id', header: 'インスタンス ID', cell: (n) => n.instance.instanceId, value: (n) => n.instance.instanceId },
          { id: 'agent', header: 'エージェントのバージョン', cell: (n) => n.agentVersion },
          { id: 'state', header: 'インスタンスの状態', cell: () => <StatusIndicator type="success">実行中</StatusIndicator> },
          { id: 'az', header: 'アベイラビリティーゾーン', cell: (n) => n.instance.availabilityZone },
          { id: 'platform', header: 'プラットフォーム', cell: (n) => n.platformName },
        ]}
      />
      {(managedNodes(env).length < env.instances.filter((i) => i.state === 'running').length) && (
        <Alert type="info" header="インスタンスが表示されない場合">
          一覧に出てくるのは、SSM Agent がオンラインのマネージドノードだけです。インスタンスの IAM ロールに AmazonSSMManagedInstanceCore があるか、インスタンスから ssm / ssmmessages / ec2messages のエンドポイントに HTTPS (443) で届くかを確認します。EC2 の「インスタンスに接続」→「セッションマネージャー」タブで、インスタンスごとの診断を見られます。
        </Alert>
      )}
    </EditForm>
  );
}

export function EditPreferences() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const p = preferencesOf(env);
  const [timeout, setTimeoutValue] = useState(p.idleSessionTimeout);
  const [cw, setCw] = useState(!!p.cloudWatchLogGroupName);
  const [stream, setStream] = useState(p.cloudWatchLogGroupName ? p.cloudWatchStreamingEnabled : true);
  const [group, setGroup] = useState(p.cloudWatchLogGroupName);
  const [error, setError] = useState<AwsError | null>(null);
  const groups = env.logGroups.map((g) => ({ value: g.logGroupName, label: g.logGroupName }));
  return (
    <EditForm
      title="設定を編集"
      description="このリージョンのセッションマネージャーの設定です。変更は、このあと開始するセッションに適用されます。"
      submitText="保存"
      submitTestId="ssm-prefs-save"
      submitHotspotId="ssm-prefs-save"
      submitDisabled={cw && !group}
      onCancel={() => navigate('/ssm/session-manager?tab=preferences')}
      error={error}
      onSubmit={() => {
        const r = run((d) => updatePreferences(d, { idleSessionTimeout: timeout.trim(), cloudWatchLogGroupName: cw ? group : '', cloudWatchStreamingEnabled: cw ? stream : p.cloudWatchStreamingEnabled }), '設定が保存されました');
        if (r.ok) navigate('/ssm/session-manager?tab=preferences');
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">全般</Header>}>
        <FormField label="アイドルセッションタイムアウト" description="何も操作しないままこの時間 (1〜60 分) が過ぎると、セッションを終了します。" constraintText="分">
          <Input type="number" value={timeout} onChange={(e) => setTimeoutValue(e.detail.value)} />
        </FormField>
      </Container>
      <Container header={<Header variant="h2" description="セッションのコマンドと出力を CloudWatch Logs のロググループに送ります。ログストリームの名前はセッション ID です。">CloudWatch のログ記録</Header>}>
        <SpaceBetween size="m">
          <Checkbox checked={cw} onChange={(e) => setCw(e.detail.checked)} data-testid="ssm-cw-enable">有効にする</Checkbox>
          {cw && (
            <>
              <FormField label="ログオプション">
                <RadioGroup
                  value={stream ? 'stream' : 'upload'}
                  onChange={(e) => setStream(e.detail.value === 'stream')}
                  items={[
                    { value: 'stream', label: 'セッションログのストリーム', description: '推奨。コマンドを実行するたびに、セッションデータを JSON 形式で CloudWatch Logs に送ります。' },
                    { value: 'upload', label: 'セッションログのアップロード', description: 'セッションが終了したときに、セッションのログをまとめて送ります。' },
                  ]}
                />
              </FormField>
              <Checkbox checked={false} disabled description="ロググループで暗号化が有効になっていない場合は、オフにする必要があります (このシミュレーターのロググループは KMS で暗号化されていません)。">
                暗号化された CloudWatch ロググループのみを許可する
              </Checkbox>
              <FormField label="CloudWatch Logs" description="セッションログを送る既存のロググループを選択します。インスタンスの IAM ロールには logs:CreateLogStream と logs:PutLogEvents の許可が必要です。">
                <Select selectedOption={groups.find((g) => g.value === group) ?? null} placeholder="ロググループを選択" options={groups} onChange={(e) => setGroup(e.detail.selectedOption.value!)} data-testid="ssm-cw-group" />
              </FormField>
            </>
          )}
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">S3 のログ記録</Header>}>
        <Checkbox checked={false} disabled description="このシミュレーターでは未提供です。">有効にする</Checkbox>
      </Container>
    </EditForm>
  );
}

/** The session's browser terminal (a tab of its own in the real console). */
export function SessionTerminal({ id }: { id: string }) {
  const env = useEnv();
  const commands = useConsole((s) => s.commands);
  const run = useConsole((s) => s.run);
  const [line, setLine] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const s = sessionOf(env, id);
  const mine = s ? commands.filter((c) => c.instanceId === s.target && c.at >= s.startDate && (!s.endDate || c.at <= s.endDate)) : [];
  const lastClear = mine.map((c) => c.line.trim()).lastIndexOf('clear');
  const shown = mine.slice(lastClear + 1);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [shown.length]);
  if (!s) return <NotFound what="セッション" id={id} />;
  const i = env.instances.find((x) => x.instanceId === s.target);
  const connected = s.status === 'Connected';
  return (
    <SpaceBetween size="s">
      <Header
        variant="h1"
        description={`インスタンス ID: ${s.target}${i && nameOf(i) ? ` (${nameOf(i)})` : ''}`}
        actions={
          <Hotspot hotspotId="ssm-terminate" direction="left">
            <Button disabled={!connected} onClick={() => run((d) => terminateSession(d, id), `セッション ${id} を終了しました`)} data-testid="ssm-terminate">終了</Button>
          </Hotspot>
        }
      >
        {`セッション ID: ${id}`}
      </Header>
      <div className="terminal" data-testid="ssm-terminal" onClick={() => inputRef.current?.focus()}>
        {shown.map((c, n) => (
          <div key={n} className="terminal-entry">
            <div>
              <span className="terminal-prompt">{SSM_PROMPT}</span> {c.line}
            </div>
            {c.output && <pre className={c.ok ? 'terminal-out' : 'terminal-err'} data-testid="terminal-output">{c.output}</pre>}
          </div>
        ))}
        {connected ? (
          <div className="terminal-input-row">
            <span className="terminal-prompt">{SSM_PROMPT}</span>
            <Hotspot hotspotId="ssm-terminal-input" direction="right">
              <input
                ref={inputRef}
                className="terminal-input"
                value={line}
                onChange={(e) => setLine(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                  e.preventDefault();
                  if (!line.trim()) return;
                  runInSession(s, line);
                  setLine('');
                }}
                aria-label="コマンド"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                data-testid="ssm-terminal-input"
              />
            </Hotspot>
          </div>
        ) : (
          <pre className="terminal-err" data-testid="ssm-terminated">{terminatedMessage(id)}</pre>
        )}
        <div ref={endRef} />
      </div>
      {!connected && (
        <Box>
          <ConsoleLink to="/ssm/session-manager?tab=history">セッション履歴</ConsoleLink> で、このセッションの記録を確認できます。
        </Box>
      )}
    </SpaceBetween>
  );
}

/** EC2 > インスタンスに接続 > セッションマネージャー */
export function SessionManagerConnect({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const start = useStartSession();
  const [error, setError] = useState<AwsError | null>(null);
  const i = env.instances.find((x) => x.instanceId === id);
  const online = pingStatus(env, id) === 'Online';
  return (
    <Container>
      <SpaceBetween size="l">
        <FormField label="インスタンス ID">{label(id, i)}</FormField>
        <Box>
          セッションマネージャーの使用:
          <ul>
            <li>SSH キーや踏み台ホストを使用せずにインスタンスに接続します。</li>
            <li>セッションは AWS Key Management Service キーを使用して保護されます。</li>
            <li>セッションのコマンドと詳細を、Amazon S3 バケットまたは CloudWatch Logs ロググループにログ記録できます。</li>
            <li>
              セッションは、セッションマネージャーの <ConsoleLink to="/ssm/session-manager?tab=preferences">設定</ConsoleLink> ページで設定します。
            </li>
          </ul>
        </Box>
        {!online && (
          <div data-testid="ssm-not-online">
            <Alert type="warning" header="SSM Agent がオンラインになっていません">
              SSM Agent は、Systems Manager のエンドポイントに接続して自身をサービスに登録できませんでした。
              <Diagnosis title="(シミュレーター) SSM Agent の診断" checks={diagnoseNode(env, id).checks} />
            </Alert>
          </div>
        )}
        {error && <Alert type="error" header={error.code}>{error.message}</Alert>}
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button variant="link" onClick={() => navigate(`/ec2/instances/${id}`)}>キャンセル</Button>
            <Hotspot hotspotId="ec2-ssm-connect" direction="right">
              <Button
                variant="primary"
                disabled={!online}
                onClick={() => {
                  const r = start(id);
                  if (!r.ok) setError(r.error);
                }}
                data-testid="ssm-connect"
              >
                接続
              </Button>
            </Hotspot>
          </SpaceBetween>
        </Box>
      </SpaceBetween>
    </Container>
  );
}
