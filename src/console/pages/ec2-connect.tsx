import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Link from '@cloudscape-design/components/link';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import Tabs from '@cloudscape-design/components/tabs';
import { useEffect, useRef, useState } from 'react';
import { prompt } from '../../sim/cli';
import { label, nameOf } from '../../sim/env';
import { publicDnsName } from '../../sim/ec2';
import { eicConnectivity } from '../../sim/network';
import { setInstanceProfile } from '../../sim/iam';
import type { AwsError } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, EditForm, NotFound, useEnv, useNavigate } from '../ui';

export function ConnectInstance({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const i = env.instances.find((x) => x.instanceId === id);
  const [tab, setTab] = useState('eic');
  if (!i) return <NotFound what="インスタンス" id={id} />;
  const problem = i.state !== 'running' ? 'インスタンスが実行中ではありません。' : !i.publicIpAddress ? 'インスタンスにパブリック IPv4 アドレスがないため、EC2 Instance Connect (パブリック) で接続できません。' : null;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={`次のいずれかのオプションを使用して、インスタンス ${i.instanceId} に接続します`}>インスタンスに接続</Header>
      <Tabs
        activeTabId={tab}
        onChange={(e) => setTab(e.detail.activeTabId)}
        tabs={[
          {
            id: 'eic',
            label: 'EC2 Instance Connect',
            content: (
              <Container>
                <SpaceBetween size="l">
                  <FormField label="インスタンス ID">{label(i.instanceId, i)}</FormField>
                  <FormField label="接続タイプ">
                    <RadioGroup value="public" items={[{ value: 'public', label: 'EC2 Instance Connect を使用して接続する', description: 'パブリック IPv4 アドレスを使用して接続します。' }, { value: 'endpoint', label: 'EC2 Instance Connect エンドポイントを使用して接続する', disabled: true, description: 'このシミュレーターでは未提供' }]} />
                  </FormField>
                  <FormField label="パブリック IPv4 アドレス">{i.publicIpAddress ?? '-'}</FormField>
                  <FormField label="ユーザー名">ec2-user</FormField>
                  {problem && <Alert type="error" header="接続できません">{problem}</Alert>}
                  <Box float="right">
                    <SpaceBetween direction="horizontal" size="xs">
                      <Button variant="link" onClick={() => navigate(`/ec2/instances/${id}`)}>キャンセル</Button>
                      <Hotspot hotspotId="ec2-connect-submit" direction="right">
                        <Button variant="primary" disabled={!!problem} onClick={() => navigate(`/ec2/instances/${id}/terminal`)} data-testid="eic-connect">接続</Button>
                      </Hotspot>
                    </SpaceBetween>
                  </Box>
                </SpaceBetween>
              </Container>
            ),
          },
          { id: 'ssm', label: 'セッションマネージャー', content: <Container><Box color="text-body-secondary">このシミュレーターでは未提供です。</Box></Container> },
          {
            id: 'ssh',
            label: 'SSH クライアント',
            content: (
              <Container>
                <SpaceBetween size="s">
                  <Box>SSH クライアントを使用して接続する例:</Box>
                  {i.publicIpAddress ? <CopyableValue value={`ssh -i "${i.keyName ?? 'key'}.pem" ec2-user@${publicDnsName(env, i.publicIpAddress)}`} /> : <Box>-</Box>}
                </SpaceBetween>
              </Container>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

/** EC2 Instance Connect browser terminal. */
export function InstanceTerminal({ id }: { id: string }) {
  const env = useEnv();
  const commands = useConsole((s) => s.commands);
  const runCommand = useConsole((s) => s.runCommand);
  const [line, setLine] = useState('');
  const [hist, setHist] = useState<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const i = env.instances.find((x) => x.instanceId === id);
  const mine = commands.filter((c) => c.instanceId === id);
  const lastClear = mine.map((c) => c.line.trim()).lastIndexOf('clear');
  const shown = mine.slice(lastClear + 1);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' }); // newer browsers return a Promise, which must not become the cleanup
  }, [shown.length]);
  const navigate = useNavigate();
  if (!i) return <NotFound what="インスタンス" id={id} />;
  if (!eicConnectivity(env, id).ok)
    // what the EC2 Instance Connect tab shows when SSH from the service can't get through (SG / NACL / route)
    return (
      <SpaceBetween size="s">
        <Header variant="h2">{`EC2 Instance Connect: ${i.instanceId} (${nameOf(i) || '-'})`}</Header>
        <div data-testid="eic-failed">
          <Alert type="error" header="Failed to connect to your instance" action={<Button onClick={() => navigate(`/ec2/instances/${id}/terminal`)}>再試行</Button>}>
            Error establishing SSH connection to your instance. Try again later.
          </Alert>
        </div>
      </SpaceBetween>
    );
  const p = prompt(i);
  const past = mine.map((c) => c.line);
  return (
    <SpaceBetween size="s">
      <Header variant="h2" description="EC2 Instance Connect のブラウザターミナル (シミュレーター)。help で使えるコマンドを表示します。" actions={<ConsoleLink to={`/ec2/instances/${id}`}>インスタンスの詳細に戻る</ConsoleLink>}>
        {`EC2 Instance Connect: ${i.instanceId} (${nameOf(i) || '-'})`}
      </Header>
      <div className="terminal" data-testid="terminal" onClick={() => inputRef.current?.focus()}>
        <div className="terminal-motd">{`   ,     #_\n   ~\\_  ####_        Amazon Linux 2023\n  ~~  \\_#####\\\n  ~~     \\###|\n  ~~       \\#/ ___   https://aws.amazon.com/linux/amazon-linux-2023\n   ~~       V~' '->\n    ~~~         /\n      ~~._.   _/\n         _/ _/\n       _/m/'`}</div>
        {shown.map((c, n) => (
          <div key={n} className="terminal-entry">
            <div>
              <span className="terminal-prompt">{p}</span> {c.line}
            </div>
            {c.output && <pre className={c.ok ? 'terminal-out' : 'terminal-err'} data-testid="terminal-output">{c.output}</pre>}
          </div>
        ))}
        {/* not a <form>: lesson hotspot buttons next to the input would hijack implicit (Enter) submission */}
        <div className="terminal-input-row">
          <span className="terminal-prompt">{p}</span>
          <Hotspot hotspotId="terminal-input" direction="right">
            <input
              ref={inputRef}
              className="terminal-input"
              value={line}
              onChange={(e) => setLine(e.target.value)}
              onPaste={(e) => {
                // like a real shell: every pasted line that ends with a newline runs, the rest stays in the prompt
                const text = e.clipboardData.getData('text');
                if (!text.includes('\n')) return;
                e.preventDefault();
                const parts = (line + text).split(/\r?\n/);
                const rest = parts.pop()!;
                parts.filter((l) => l.trim()).forEach((l) => runCommand(id, l));
                setLine(rest);
                setHist(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (!line.trim()) return;
                  runCommand(id, line);
                  setLine('');
                  setHist(null);
                } else if (e.key === 'ArrowUp' && past.length) {
                  const n = hist === null ? past.length - 1 : Math.max(0, hist - 1);
                  setHist(n);
                  setLine(past[n]);
                  e.preventDefault();
                } else if (e.key === 'ArrowDown' && hist !== null) {
                  const n = hist + 1;
                  setHist(n < past.length ? n : null);
                  setLine(n < past.length ? past[n] : '');
                  e.preventDefault();
                }
              }}
              aria-label="コマンド"
              spellCheck={false}
              autoComplete="off"
              autoFocus
              data-testid="terminal-input"
            />
          </Hotspot>
        </div>
        <div ref={endRef} />
      </div>
    </SpaceBetween>
  );
}

export function ModifyIamRole({ id }: { id: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const i = env.instances.find((x) => x.instanceId === id);
  const [arn, setArn] = useState(i?.iamInstanceProfileArn ?? '');
  const [error, setError] = useState<AwsError | null>(null);
  if (!i) return <NotFound what="インスタンス" id={id} />;
  const options = [{ value: '', label: 'IAM ロールがありません' }, ...env.instanceProfiles.map((p) => ({ value: p.arn, label: p.instanceProfileName, description: p.arn }))];
  return (
    <EditForm
      title="IAM ロールを変更"
      description="インスタンスにアタッチする IAM ロールを選択します。ロールはインスタンスプロファイルとしてアタッチされます。"
      submitText="IAM ロールの更新"
      submitTestId="update-iam-role"
      submitHotspotId="ec2-update-iam-role"
      onCancel={() => navigate(`/ec2/instances/${id}?tab=security`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => setInstanceProfile(d, id, arn || undefined), arn ? `IAM ロールがインスタンス ${id} に正常にアタッチされました` : `インスタンス ${id} から IAM ロールがデタッチされました`);
        if (r.ok) navigate(`/ec2/instances/${id}?tab=security`);
        else setError(r.error);
      }}
    >
      <Container>
        <SpaceBetween size="l">
          <FormField label="インスタンス ID">{label(i.instanceId, i)}</FormField>
          <FormField label="IAM ロール" description={<>インスタンスにアタッチする IAM ロールを選択するか、ロールを作成します。<Link href="#" onFollow={(e) => { e.preventDefault(); navigate('/iam/roles/create'); }}>新しい IAM ロールを作成</Link></>}>
            <Select selectedOption={options.find((o) => o.value === arn) ?? options[0]} options={options} onChange={(e) => setArn(e.detail.selectedOption.value!)} data-testid="iam-role-select" />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}
