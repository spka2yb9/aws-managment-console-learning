import Alert from '@cloudscape-design/components/alert';
import AttributeEditor from '@cloudscape-design/components/attribute-editor';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import { useState } from 'react';
import { invokeFunction, receiveMessages, sendMessage, sourceQueuesOf, startMessageMoveTask, updateEventSourceMapping, updateFunctionConfiguration, type InvokeResult } from '../../sim/serverless';
import type { AwsError, SqsMessage, SqsQueue } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, EditForm, formatDate, JsonBlock, NotFound, ResourceDetail, ResourceTable, ResourceTabs, useEnv, useNavigate } from '../ui';
import { useNow } from './cloudwatch';

const queuePath = (name: string) => `/sqs/queues/${name}`;
const fnPath = (name: string) => `/lambda/functions/${name}`;
const logsPath = (fn: string) => `/cloudwatch/logs/group?${new URLSearchParams({ name: `/aws/lambda/${fn}` })}`;
const counts = (q: SqsQueue, now: number) => ({ visible: q.messages.filter((m) => m.visibleAt <= now).length, inFlight: q.messages.filter((m) => m.visibleAt > now).length });

// ---------------- SQS ----------------

export function QueueList() {
  const env = useEnv();
  const now = useNow(3000);
  return (
    <ResourceTable
      title="キュー"
      resourceName="キュー"
      testId="sqs-queues"
      items={env.sqsQueues}
      trackBy={(q) => q.queueName}
      selectionType="none"
      columns={[
        { id: 'name', header: '名前', cell: (q) => <ConsoleLink to={queuePath(q.queueName)}>{q.queueName}</ConsoleLink>, value: (q) => q.queueName },
        { id: 'type', header: 'タイプ', cell: () => '標準' },
        { id: 'created', header: '作成日時', cell: (q) => formatDate(q.createdAt) },
        { id: 'visible', header: '利用可能なメッセージ', cell: (q) => String(counts(q, now).visible), value: (q) => counts(q, now).visible },
        { id: 'inflight', header: '処理中のメッセージ', cell: (q) => String(counts(q, now).inFlight) },
        { id: 'enc', header: '暗号化', cell: () => 'Amazon SQS キー (SSE-SQS)' },
      ]}
    />
  );
}

export function QueueDetail({ name }: { name: string }) {
  const env = useEnv();
  const now = useNow(3000);
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [confirm, setConfirm] = useState(false);
  const q = env.sqsQueues.find((x) => x.queueName === name);
  if (!q) return <NotFound what="キュー" id={name} />;
  const dlq = env.sqsQueues.find((x) => x.queueArn === q.redrivePolicy?.deadLetterTargetArn);
  const sources = sourceQueuesOf(env, q);
  const triggers = env.eventSourceMappings.filter((m) => m.eventSourceArn === q.queueArn);
  const c = counts(q, now);
  return (
    <SpaceBetween size="l">
      <Header
        variant="h1"
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            {sources.length > 0 && (
              <Hotspot hotspotId="sqs-redrive" direction="right">
                <Button disabled={!q.messages.length} onClick={() => setConfirm(true)} data-testid="start-redrive">DLQ 再処理を開始</Button>
              </Hotspot>
            )}
            <Hotspot hotspotId="sqs-send-receive" direction="right">
              <Button variant="primary" onClick={() => navigate(`${queuePath(name)}/send-receive`)} data-testid="send-receive">メッセージを送受信</Button>
            </Hotspot>
          </SpaceBetween>
        }
      >
        {name}
      </Header>
      <ResourceDetail
        columns={4}
        fields={[
          { label: '名前', value: name },
          { label: 'タイプ', value: '標準' },
          { label: 'ARN', value: <CopyableValue value={q.queueArn} iconOnly /> },
          { label: 'URL', value: <CopyableValue value={q.queueUrl} iconOnly /> },
          { label: '利用可能なメッセージ', value: <span data-testid="queue-visible">{c.visible}</span> },
          { label: '処理中のメッセージ', value: <span data-testid="queue-inflight">{c.inFlight}</span> },
          { label: '可視性タイムアウト', value: `${q.visibilityTimeout} 秒` },
          { label: 'メッセージ保持期間', value: `${Math.round(q.messageRetentionPeriod / 86400)} 日` },
          { label: 'デッドレターキュー', value: dlq ? <ConsoleLink to={queuePath(dlq.queueName)}>{dlq.queueName}</ConsoleLink> : '-' },
          { label: '最大受信数', value: q.redrivePolicy ? String(q.redrivePolicy.maxReceiveCount) : '-' },
          { label: 'このキューを DLQ とするキュー', value: sources.map((s) => s.queueName).join(', ') || '-' },
        ]}
      />
      <ResourceTabs
        tabs={[
          {
            id: 'triggers',
            label: 'Lambda トリガー',
            content: (
              <Table
                variant="container"
                header={<Header counter={`(${triggers.length})`}>Lambda トリガー</Header>}
                items={triggers}
                empty="Lambda トリガーはありません"
                columnDefinitions={[
                  { id: 'fn', header: 'Lambda 関数', cell: (m) => <ConsoleLink to={fnPath(m.functionName)}>{m.functionName}</ConsoleLink> },
                  { id: 'state', header: 'ステータス', cell: (m) => (m.enabled ? <StatusIndicator>有効</StatusIndicator> : <StatusIndicator type="stopped">無効</StatusIndicator>) },
                  { id: 'result', header: '最後の処理結果', cell: (m) => m.lastProcessingResult },
                  { id: 'batch', header: 'バッチサイズ', cell: (m) => String(m.batchSize) },
                ]}
              />
            ),
          },
        ]}
      />
      {confirm && (
        <Modal
          visible
          header="DLQ 再処理を開始"
          onDismiss={() => setConfirm(false)}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setConfirm(false)}>キャンセル</Button>
                <Button
                  variant="primary"
                  data-testid="confirm-redrive"
                  onClick={() => {
                    run((d) => startMessageMoveTask(d, name), (n) => `${n} 件のメッセージを ${sources[0].queueName} に移動しました`);
                    setConfirm(false);
                  }}
                >
                  DLQ 再処理
                </Button>
              </SpaceBetween>
            </Box>
          }
        >
          {`${q.messages.length} 件のメッセージを、送信元キュー ${sources[0]?.queueName} に戻します。受信回数はリセットされます。原因を直してから実行してください。`}
        </Modal>
      )}
    </SpaceBetween>
  );
}

export function SendReceive({ name }: { name: string }) {
  const env = useEnv();
  const run = useConsole((s) => s.run);
  const [body, setBody] = useState('');
  const [received, setReceived] = useState<SqsMessage[]>([]);
  const [open, setOpen] = useState<SqsMessage | null>(null);
  const [error, setError] = useState<AwsError | null>(null);
  const q = env.sqsQueues.find((x) => x.queueName === name);
  if (!q) return <NotFound what="キュー" id={name} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={q.queueUrl}>メッセージを送受信</Header>
      <Container header={<Header variant="h2" actions={<Hotspot hotspotId="sqs-send" direction="right"><Button variant="primary" disabled={!body} onClick={() => { const r = run((d) => sendMessage(d, name, body), (id) => `メッセージ ID ${id} を送信しました`); if (r.ok) setBody(''); else setError(r.error); }} data-testid="send-message">メッセージを送信</Button></Hotspot>}>メッセージを送信</Header>}>
        <SpaceBetween size="s">
          {error && <Alert type="error">{error.message}</Alert>}
          <FormField label="メッセージ本文">
            <Textarea value={body} onChange={(e) => setBody(e.detail.value)} rows={4} placeholder='例: {"orderId": 2001, "amount": 1200}' className="code-textarea" data-testid="message-body" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Table
        variant="container"
        data-testid="received-messages"
        header={
          <Header
            counter={`(${received.length})`}
            description="ポーリングで受信したメッセージは、可視性タイムアウトの間ほかの受信者 (Lambda など) から見えなくなり、受信回数も増えます。"
            actions={<Button onClick={() => { const r = run((d) => receiveMessages(d, name, 10)); if (r.ok) setReceived(r.value); }} data-testid="poll-messages">メッセージをポーリング</Button>}
          >
            メッセージを受信
          </Header>
        }
        items={received}
        empty="ポーリングして、キューのメッセージを受信します"
        columnDefinitions={[
          { id: 'id', header: 'ID', cell: (m) => <Button variant="inline-link" onClick={() => setOpen(m)}>{m.messageId}</Button> },
          { id: 'sent', header: '送信日時', cell: (m) => formatDate(m.sentAt) },
          { id: 'size', header: 'サイズ', cell: (m) => `${new Blob([m.body]).size} バイト` },
          { id: 'count', header: '受信回数', cell: (m) => String(m.receiveCount) },
          { id: 'body', header: '本文', cell: (m) => <Box variant="code">{m.body.slice(0, 60)}</Box> },
        ]}
      />
      {open && (
        <Modal visible header={`メッセージ: ${open.messageId}`} onDismiss={() => setOpen(null)} footer={<Box float="right"><Button onClick={() => setOpen(null)}>完了</Button></Box>}>
          <SpaceBetween size="s">
            <Box variant="awsui-key-label">本文</Box>
            <pre className="code-block">{open.body}</pre>
            <Box variant="small">{`MD5: ${open.md5OfBody} / 受信回数: ${open.receiveCount}`}</Box>
          </SpaceBetween>
        </Modal>
      )}
    </SpaceBetween>
  );
}

// ---------------- Lambda ----------------

export function FunctionList() {
  const env = useEnv();
  return (
    <ResourceTable
      title="関数"
      resourceName="関数"
      testId="lambda-functions"
      items={env.lambdaFunctions}
      trackBy={(f) => f.functionName}
      selectionType="none"
      columns={[
        { id: 'name', header: '関数名', cell: (f) => <ConsoleLink to={fnPath(f.functionName)}>{f.functionName}</ConsoleLink>, value: (f) => f.functionName },
        { id: 'pkg', header: 'パッケージタイプ', cell: () => 'Zip' },
        { id: 'runtime', header: 'ランタイム', cell: (f) => f.runtime },
        { id: 'modified', header: '最終更新日時', cell: (f) => formatDate(f.lastModified) },
      ]}
    />
  );
}

export function FunctionDetail({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [event, setEvent] = useState(JSON.stringify({ Records: [{ body: '{"orderId": 9001, "amount": 500}' }] }, null, 2));
  const [result, setResult] = useState<InvokeResult | null>(null);
  const [parseError, setParseError] = useState('');
  const f = env.lambdaFunctions.find((x) => x.functionName === name);
  if (!f) return <NotFound what="関数" id={name} />;
  const triggers = env.eventSourceMappings.filter((m) => m.functionName === name);
  const envVars = Object.entries(f.environment);
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{name}</Header>
      <Container header={<Header variant="h2">関数の概要</Header>}>
        <ColumnLayout columns={3} variant="text-grid">
          <div><Box variant="awsui-key-label">トリガー</Box>{triggers.map((m) => <div key={m.uuid}><ConsoleLink to={queuePath(m.eventSourceArn.split(':').pop()!)}>{`SQS: ${m.eventSourceArn.split(':').pop()}`}</ConsoleLink></div>)}</div>
          <div><Box variant="awsui-key-label">関数 ARN</Box><CopyableValue value={f.functionArn} iconOnly /></div>
          <div><Box variant="awsui-key-label">最終更新日時</Box>{formatDate(f.lastModified)}</div>
        </ColumnLayout>
      </Container>
      <ResourceTabs
        tabs={[
          {
            id: 'code',
            label: 'コード',
            content: (
              <Container header={<Header variant="h2" description="このシミュレーターではコードを編集・実行できません。関数の動作はこのコードどおりにシミュレーションされます。">コードソース</Header>}>
                <pre className="code-block" data-testid="lambda-code">{f.code}</pre>
              </Container>
            ),
          },
          {
            id: 'test',
            label: 'テスト',
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2" actions={<Button variant="primary" onClick={() => { try { const ev = JSON.parse(event); setParseError(''); const r = run((d) => invokeFunction(d, name, ev)); if (r.ok) setResult(r.value); } catch { setParseError('イベント JSON が正しくありません。'); } }} data-testid="lambda-test">テスト</Button>}>テストイベント</Header>}>
                  <FormField label="イベント JSON" errorText={parseError || undefined}>
                    <Textarea value={event} onChange={(e) => setEvent(e.detail.value)} rows={8} className="code-textarea" />
                  </FormField>
                </Container>
                {result && (
                  <div data-testid="lambda-result">
                    <Alert type={result.ok ? 'success' : 'error'} header={result.ok ? '関数の実行: 成功' : '関数の実行: 失敗'}>
                      <SpaceBetween size="s">
                        <JsonBlock value={result.response} />
                        <Box variant="awsui-key-label">ログ出力</Box>
                        <pre className="log-message">{result.logs.join('\n')}</pre>
                      </SpaceBetween>
                    </Alert>
                  </div>
                )}
              </SpaceBetween>
            ),
          },
          {
            id: 'monitor',
            label: 'モニタリング',
            content: (
              <Container header={<Header variant="h2">ログ</Header>}>
                <SpaceBetween size="s">
                  <Box>関数のログ (console.log・エラー・START / END / REPORT) は CloudWatch Logs に送られます。</Box>
                  <Hotspot hotspotId="lambda-logs" direction="right">
                    <Button onClick={() => navigate(logsPath(name))} data-testid="view-logs" iconName="external" iconAlign="right">CloudWatch ログを表示</Button>
                  </Hotspot>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            id: 'config',
            label: '設定',
            content: (
              <SpaceBetween size="l">
                <ResourceDetail title="一般設定" columns={3} fields={[{ label: 'メモリ', value: `${f.memorySize} MB` }, { label: 'タイムアウト', value: `${f.timeout} 秒` }, { label: 'ランタイム', value: f.runtime }, { label: 'ハンドラ', value: f.handler }]} />
                <Table
                  variant="container"
                  data-testid="lambda-env"
                  header={<Header counter={`(${envVars.length})`} actions={<Hotspot hotspotId="lambda-edit-env" direction="right"><Button onClick={() => navigate(`${fnPath(name)}/edit-env`)} data-testid="edit-env">編集</Button></Hotspot>}>環境変数</Header>}
                  items={envVars}
                  empty="環境変数はありません"
                  columnDefinitions={[
                    { id: 'k', header: 'キー', cell: ([k]) => k },
                    { id: 'v', header: '値', cell: ([, v]) => v },
                  ]}
                />
                <Table
                  variant="container"
                  header={<Header counter={`(${triggers.length})`}>トリガー</Header>}
                  items={triggers}
                  columnDefinitions={[
                    { id: 'src', header: 'イベントソース', cell: (m) => `SQS: ${m.eventSourceArn.split(':').pop()}` },
                    { id: 'state', header: '状態', cell: (m) => (m.enabled ? '有効' : '無効') },
                    { id: 'act', header: '', cell: (m) => <Button variant="inline-link" onClick={() => run((d) => updateEventSourceMapping(d, m.uuid, !m.enabled), `トリガーを${m.enabled ? '無効' : '有効'}にしました`)}>{m.enabled ? '無効化' : '有効化'}</Button> },
                  ]}
                />
                <ResourceDetail title="アクセス権限" columns={1} fields={[{ label: '実行ロール', value: <ConsoleLink to={`/iam/roles/${f.roleArn.split('/').pop()}`}>{f.roleArn.split('/').pop()}</ConsoleLink> }]} />
              </SpaceBetween>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

export function EditEnvironment({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const f = env.lambdaFunctions.find((x) => x.functionName === name);
  const [items, setItems] = useState<{ key: string; value: string }[]>(Object.entries(f?.environment ?? {}).map(([key, value]) => ({ key, value })));
  const [error, setError] = useState<AwsError | null>(null);
  if (!f) return <NotFound what="関数" id={name} />;
  return (
    <EditForm
      title="環境変数の編集"
      submitText="保存"
      submitTestId="save-env"
      submitHotspotId="lambda-save-env"
      onCancel={() => navigate(`${fnPath(name)}?tab=config`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => updateFunctionConfiguration(d, name, { environment: Object.fromEntries(items.filter((i) => i.key.trim()).map((i) => [i.key.trim(), i.value])) }), `関数 ${name} が正常に更新されました。`);
        if (r.ok) navigate(`${fnPath(name)}?tab=config`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">環境変数</Header>}>
        <AttributeEditor
          items={items}
          addButtonText="環境変数の追加"
          removeButtonText="削除"
          empty="環境変数はありません"
          onAddButtonClick={() => setItems([...items, { key: '', value: '' }])}
          onRemoveButtonClick={(e) => setItems(items.filter((_, n) => n !== e.detail.itemIndex))}
          definition={[
            { label: 'キー', control: (item, n) => <Input value={item.key} onChange={(e) => setItems(items.map((x, i) => (i === n ? { ...x, key: e.detail.value } : x)))} data-testid={`env-key-${n}`} /> },
            { label: '値', control: (item, n) => <Input value={item.value} onChange={(e) => setItems(items.map((x, i) => (i === n ? { ...x, value: e.detail.value } : x)))} data-testid={`env-value-${n}`} /> },
          ]}
        />
      </Container>
    </EditForm>
  );
}
