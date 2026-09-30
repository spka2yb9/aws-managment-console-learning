import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FileUpload from '@cloudscape-design/components/file-upload';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Modal from '@cloudscape-design/components/modal';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Tabs from '@cloudscape-design/components/tabs';
import Toggle from '@cloudscape-design/components/toggle';
import { useState } from 'react';
import { regionOf } from '../../sim/env';
import { BPA_ALL_ON, bucketArn, bucketNameProblem, createBucket, currentObjects, deleteBucketPolicy, deleteObject, isPolicyPublic, objectArn, objectUrl, putBucketEncryption, putBucketPolicy, putBucketVersioning, putObject, putPublicAccessBlock } from '../../sim/s3';
import type { AwsError, BlockPublicAccess, Bucket, S3Object } from '../../sim/types';
import { useConsole } from '../store';
import { PolicyEditor } from './iam';
import { ActionMenu, ConsoleLink, CONSOLE_USER_ARN, CopyableValue, EditForm, formatDate, JsonBlock, NotFound, queryParam, ResourceDetail, ResourceTable, ResourceTabs, useGlobalEnv, useNavigate } from '../ui';

const bucketPath = (b: string) => `/s3/buckets/${b}`;
const objectPath = (b: string, key: string) => `/s3/buckets/${b}/object?key=${encodeURIComponent(key)}`;
const regionLabel = (code: string) => `${regionOf(code).name} ${code}`;

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

const BPA_LABELS: { key: keyof BlockPublicAccess; label: string; description: string }[] = [
  { key: 'blockPublicAcls', label: '新しいアクセスコントロールリスト (ACL) を介して付与されたバケットとオブジェクトへのパブリックアクセスをブロックする', description: '新しく追加されたバケットまたはオブジェクトに適用されるパブリックアクセス許可をブロックします。' },
  { key: 'ignorePublicAcls', label: '任意のアクセスコントロールリスト (ACL) を介して付与されたバケットとオブジェクトへのパブリックアクセスをブロックする', description: 'バケットとオブジェクトへのパブリックアクセスを付与するすべての ACL を無視します。' },
  { key: 'blockPublicPolicy', label: '新しいパブリックバケットポリシーまたはアクセスポイントポリシーを介して付与されたバケットとオブジェクトへのパブリックアクセスをブロックする', description: 'バケットやアクセスポイントへのパブリックアクセスを許可する新しいポリシーをブロックします。' },
  { key: 'restrictPublicBuckets', label: '任意のパブリックバケットポリシーまたはアクセスポイントポリシーを介したバケットとオブジェクトへのパブリックアクセスとクロスアカウントアクセスをブロックする', description: 'パブリックなポリシーを持つバケットに対して、パブリックアクセスとクロスアカウントアクセスを無視します。' },
];

const allOn = (b: BlockPublicAccess) => BPA_LABELS.every((l) => b[l.key]);

function BpaEditor({ value, onChange }: { value: BlockPublicAccess; onChange: (v: BlockPublicAccess) => void }) {
  return (
    <SpaceBetween size="s">
      <Checkbox checked={allOn(value)} indeterminate={!allOn(value) && BPA_LABELS.some((l) => value[l.key])} onChange={(e) => onChange(e.detail.checked ? { ...BPA_ALL_ON } : { blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false })} data-testid="bpa-all">
        <b>パブリックアクセスをすべて ブロック</b>
      </Checkbox>
      <div className="indent">
        <SpaceBetween size="xs">
          {BPA_LABELS.map((l) => (
            <Checkbox key={l.key} checked={value[l.key]} onChange={(e) => onChange({ ...value, [l.key]: e.detail.checked })} description={l.description} data-testid={`bpa-${l.key}`}>
              {l.label}
            </Checkbox>
          ))}
        </SpaceBetween>
      </div>
    </SpaceBetween>
  );
}

function accessSummary(b: Bucket): { type: 'success' | 'warning'; text: string } {
  const pub = isPolicyPublic(b.policy) && !b.blockPublicAccess.restrictPublicBuckets;
  return pub ? { type: 'warning', text: 'パブリック' } : { type: 'success', text: 'バケットとオブジェクトは非公開' };
}

// ---------------- buckets ----------------

export function BucketList() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const [sel, setSel] = useState<string[]>([]);
  const items = env.buckets;
  const selected = items.filter((b) => sel.includes(b.name));
  return (
    <ResourceTable
      title="汎用バケット"
      description="バケットは S3 に保存されるデータのコンテナです。"
      resourceName="バケット"
      testId="bucket-table"
      items={items}
      trackBy={(b) => b.name}
      selectedItems={selected}
      onSelectionChange={(xs) => setSel(xs.map((b) => b.name))}
      columns={[
        { id: 'name', header: '名前', cell: (b) => <ConsoleLink to={bucketPath(b.name)}>{b.name}</ConsoleLink>, value: (b) => b.name },
        { id: 'region', header: 'AWS リージョン', cell: (b) => regionLabel(b.region), value: (b) => b.region },
        { id: 'access', header: 'アクセス', cell: (b) => <StatusIndicator type={accessSummary(b).type}>{accessSummary(b).text}</StatusIndicator> },
        { id: 'date', header: '作成日', cell: (b) => formatDate(b.creationDate) },
      ]}
      actions={
        <SpaceBetween direction="horizontal" size="xs">
          <Button disabled={selected.length !== 1} onClick={() => { void navigator.clipboard?.writeText(bucketArn(selected[0].name)); useConsole.getState().recordCopy(bucketArn(selected[0].name)); useConsole.getState().flash('success', `${bucketArn(selected[0].name)} をコピーしました`); }}>ARN をコピー</Button>
          <Button variant="primary" onClick={() => navigate('/s3/create')} data-testid="create-bucket">バケットを作成</Button>
        </SpaceBetween>
      }
    />
  );
}

export function CreateBucketPage() {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [bpa, setBpa] = useState<BlockPublicAccess>({ ...BPA_ALL_ON });
  const [ack, setAck] = useState(false);
  const [versioning, setVersioning] = useState('disabled');
  const [sse, setSse] = useState<'AES256' | 'aws:kms'>('AES256');
  const [error, setError] = useState<AwsError | null>(null);
  const [touched, setTouched] = useState(false);
  const problem = name ? bucketNameProblem(name) : 'バケット名を入力してください。';
  const needAck = !allOn(bpa);
  return (
    <EditForm
      title="バケットを作成"
      description="バケットは S3 に保存されるデータのコンテナです。"
      submitText="バケットを作成"
      submitTestId="create-bucket-submit"
      submitHotspotId="s3-create-submit"
      onCancel={() => navigate('/s3/buckets')}
      error={error}
      onSubmit={() => {
        setTouched(true);
        if (problem || (needAck && !ack)) return;
        const r = run((d) => createBucket(d, { name, region: env.region, versioning: versioning === 'enabled', sseAlgorithm: sse, blockPublicAccess: bpa }), (n) => `バケット「${n}」が正常に作成されました`);
        if (r.ok) navigate(bucketPath(r.value));
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">全般的な設定</Header>}>
        <SpaceBetween size="l">
          <FormField label="AWS リージョン">{regionLabel(env.region)}</FormField>
          <FormField label="バケットタイプ">
            <RadioGroup value="general" items={[{ value: 'general', label: '汎用', description: 'ほとんどのユースケースやアクセスパターンに推奨されます。' }, { value: 'directory', label: 'ディレクトリ', disabled: true, description: 'このシミュレーターでは未提供' }]} />
          </FormField>
          <FormField label="バケット名" description="バケット名は、すべての AWS アカウントのすべての AWS リージョンでグローバルに一意である必要があります。" constraintText="バケット名は 3〜63 文字で、小文字、数字、ドット (.)、ハイフン (-) のみを使用できます。" errorText={touched && problem ? problem : undefined}>
            <Input value={name} onChange={(e) => setName(e.detail.value)} placeholder="myawsbucket" data-testid="bucket-name" />
          </FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="ACL は無効にして、バケットポリシーでアクセスを管理することをお勧めします。">オブジェクト所有者</Header>}>
        <RadioGroup value="enforced" items={[{ value: 'enforced', label: 'ACL 無効 (推奨)', description: 'このバケット内のすべてのオブジェクトは、このアカウントによって所有されます。アクセスはポリシーのみを使用して指定されます。' }, { value: 'acl', label: 'ACL 有効', disabled: true, description: 'このシミュレーターでは未提供' }]} />
      </Container>
      <Container header={<Header variant="h2" description="パブリックアクセスは、ACL、バケットポリシー、アクセスポイントポリシー、またはそのすべてを介してバケットとオブジェクトに付与されます。">このバケットのブロックパブリックアクセス設定</Header>}>
        <SpaceBetween size="m">
          <BpaEditor value={bpa} onChange={setBpa} />
          {needAck && (
            <Alert type="warning">
              <SpaceBetween size="s">
                <Box>「パブリックアクセスをすべて ブロック」をオフにすると、このバケットとバケット内のオブジェクトがパブリックになる可能性があります。</Box>
                <Checkbox checked={ack} onChange={(e) => setAck(e.detail.checked)} data-testid="bpa-ack">
                  現在の設定により、このバケットとバケット内のオブジェクトがパブリックになる可能性があることを承認します。
                </Checkbox>
                {touched && !ack && <Box color="text-status-error">承認が必要です。</Box>}
              </SpaceBetween>
            </Alert>
          )}
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2" description="バージョニングは、オブジェクトの複数のバリアントを同じバケットに保持する手段です。">バケットのバージョニング</Header>}>
        <RadioGroup value={versioning} onChange={(e) => setVersioning(e.detail.value)} items={[{ value: 'disabled', label: '無効にする' }, { value: 'enabled', label: '有効にする' }]} data-testid="bucket-versioning" />
      </Container>
      <Container header={<Header variant="h2" description="このバケットに保存された新しいオブジェクトには、サーバー側の暗号化が自動的に適用されます。">デフォルトの暗号化</Header>}>
        <FormField label="暗号化タイプ">
          <RadioGroup value={sse} onChange={(e) => setSse(e.detail.value as typeof sse)} items={[{ value: 'AES256', label: 'Amazon S3 マネージドキーを用いたサーバー側の暗号化 (SSE-S3)' }, { value: 'aws:kms', label: 'AWS Key Management Service キーを用いたサーバー側の暗号化 (SSE-KMS)', description: 'aws/s3 (AWS マネージドキー) を使用します' }]} />
        </FormField>
      </Container>
    </EditForm>
  );
}

function ObjectsTab({ b }: { b: Bucket }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const path = useConsole((s) => s.path);
  const prefix = queryParam(path, 'prefix') ?? '';
  const [showVersions, setShowVersions] = useState(false);
  const [sel, setSel] = useState<string[]>([]);
  const all = showVersions ? b.objects : currentObjects(b);
  const under = all.filter((o) => o.key.startsWith(prefix));
  const folders = [...new Set(under.map((o) => o.key.slice(prefix.length)).filter((k) => k.includes('/')).map((k) => k.split('/')[0] + '/'))];
  type Row = { id: string; name: string; folder?: string; o?: S3Object };
  const rows: Row[] = [
    ...folders.map((f) => ({ id: `folder:${f}`, name: f, folder: prefix + f })),
    ...under.filter((o) => !o.key.slice(prefix.length).includes('/')).map((o) => ({ id: `${o.key}#${o.versionId}`, name: o.key.slice(prefix.length), o })),
  ];
  const selectedObjects = rows.filter((r) => sel.includes(r.id) && r.o).map((r) => r.o!);
  const crumbs = prefix.split('/').filter(Boolean);
  return (
    <SpaceBetween size="s">
      {!!prefix && (
        <Box>
          <ConsoleLink to={`${bucketPath(b.name)}?tab=objects`}>{b.name}</ConsoleLink>
          {crumbs.map((c, n) => (
            <span key={n}>
              {' / '}
              <ConsoleLink to={`${bucketPath(b.name)}?tab=objects&prefix=${encodeURIComponent(crumbs.slice(0, n + 1).join('/') + '/')}`}>{c}</ConsoleLink>
            </span>
          ))}
        </Box>
      )}
      <Table<Row>
        variant="container"
        data-testid="objects-table"
        header={
          <Header
            counter={`(${rows.length})`}
            description="オブジェクトは Amazon S3 に保存される基本的なエンティティです。"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                {b.versioning !== 'Disabled' && <Toggle checked={showVersions} onChange={(e) => setShowVersions(e.detail.checked)}>バージョンの表示</Toggle>}
                <Button
                  disabled={!selectedObjects.length}
                  onClick={() => {
                    run((d) => selectedObjects.forEach((o) => deleteObject(d, b.name, o.key)), `${selectedObjects.length} 個のオブジェクトを削除しました`);
                    setSel([]);
                  }}
                >
                  削除
                </Button>
                <Hotspot hotspotId="s3-upload" direction="right">
                  <Button variant="primary" onClick={() => navigate(`${bucketPath(b.name)}/upload${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`)} data-testid="upload">アップロード</Button>
                </Hotspot>
              </SpaceBetween>
            }
          >
            オブジェクト
          </Header>
        }
        items={rows}
        trackBy="id"
        selectionType="multi"
        selectedItems={rows.filter((r) => sel.includes(r.id))}
        onSelectionChange={(e) => setSel(e.detail.selectedItems.map((r) => r.id))}
        isItemDisabled={(r) => !!r.folder}
        ariaLabels={{ itemSelectionLabel: (_, r) => `${r.name} を選択`, allItemsSelectionLabel: () => 'すべて選択', selectionGroupLabel: 'オブジェクト' }}
        empty={<Box textAlign="center" color="inherit"><b>オブジェクトがありません</b><Box color="inherit">このバケットにはオブジェクトがありません。</Box></Box>}
        columnDefinitions={[
          { id: 'name', header: '名前', cell: (r) => (r.folder ? <ConsoleLink to={`${bucketPath(b.name)}?tab=objects&prefix=${encodeURIComponent(r.folder)}`}>{r.name}</ConsoleLink> : r.o?.deleteMarker ? `${r.name} (削除マーカー)` : <ConsoleLink to={objectPath(b.name, r.o!.key)}>{r.name}</ConsoleLink>) },
          ...(showVersions ? [{ id: 'ver', header: 'バージョン ID', cell: (r: Row) => r.o?.versionId ?? '' }] : []),
          { id: 'type', header: 'タイプ', cell: (r) => (r.folder ? 'フォルダ' : r.o?.deleteMarker ? '削除マーカー' : r.name.split('.').pop() ?? '-') },
          { id: 'date', header: '最終更新日時', cell: (r) => (r.o ? formatDate(r.o.lastModified) : '-') },
          { id: 'size', header: 'サイズ', cell: (r) => (r.o && !r.o.deleteMarker ? fmtSize(r.o.size) : '-') },
          { id: 'class', header: 'ストレージクラス', cell: (r) => (r.o && !r.o.deleteMarker ? 'スタンダード' : '-') },
        ]}
      />
    </SpaceBetween>
  );
}

function PropertiesTab({ b }: { b: Bucket }) {
  const navigate = useNavigate();
  return (
    <SpaceBetween size="l">
      <ResourceDetail
        title="バケットの概要"
        columns={3}
        fields={[
          { label: 'AWS リージョン', value: regionLabel(b.region) },
          { label: 'Amazon リソースネーム (ARN)', value: <CopyableValue value={bucketArn(b.name)} /> },
          { label: '作成日', value: formatDate(b.creationDate) },
        ]}
      />
      <Container header={<Header variant="h2" description="バージョニングを使用すると、オブジェクトの複数のバリアントを同じバケットに保持できます。" actions={<Button onClick={() => navigate(`${bucketPath(b.name)}/edit-versioning`)} data-testid="edit-versioning">編集</Button>}>バケットのバージョニング</Header>}>
        <FormField label="バケットのバージョニング">{{ Disabled: '無効', Enabled: '有効', Suspended: '停止' }[b.versioning]}</FormField>
      </Container>
      <Container header={<Header variant="h2" description="このバケットに保存された新しいオブジェクトには、サーバー側の暗号化が自動的に適用されます。" actions={<Button onClick={() => navigate(`${bucketPath(b.name)}/edit-encryption`)}>編集</Button>}>デフォルトの暗号化</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <FormField label="暗号化タイプ">{b.encryption.sseAlgorithm === 'AES256' ? 'Amazon S3 マネージドキーを用いたサーバー側の暗号化 (SSE-S3)' : 'AWS Key Management Service キーを用いたサーバー側の暗号化 (SSE-KMS)'}</FormField>
          <FormField label="バケットキー">{b.encryption.bucketKeyEnabled ? '有効' : '無効'}</FormField>
        </ColumnLayout>
      </Container>
    </SpaceBetween>
  );
}

function PermissionsTab({ b }: { b: Bucket }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const summary = accessSummary(b);
  return (
    <SpaceBetween size="l">
      <Container header={<Header variant="h2">アクセス許可の概要</Header>}>
        <StatusIndicator type={summary.type}>{summary.text}</StatusIndicator>
      </Container>
      <Container
        data-testid="bpa-container"
        header={
          <Header variant="h2" description="パブリックアクセスは、ACL、バケットポリシー、アクセスポイントポリシー、またはそのすべてを介してバケットとオブジェクトに付与されます。" actions={<Hotspot hotspotId="s3-edit-bpa" direction="right"><Button onClick={() => navigate(`${bucketPath(b.name)}/edit-bpa`)} data-testid="edit-bpa">編集</Button></Hotspot>}>
            ブロックパブリックアクセス (バケット設定)
          </Header>
        }
      >
        <SpaceBetween size="xs">
          <StatusIndicator type={allOn(b.blockPublicAccess) ? 'success' : 'warning'}>パブリックアクセスをすべて ブロック: {allOn(b.blockPublicAccess) ? 'オン' : 'オフ'}</StatusIndicator>
          {BPA_LABELS.map((l) => (
            <Box key={l.key} variant="small" color="text-body-secondary">
              {b.blockPublicAccess[l.key] ? '✓ オン' : '✕ オフ'} — {l.label}
            </Box>
          ))}
        </SpaceBetween>
      </Container>
      <Container
        header={
          <Header
            variant="h2"
            description="JSON で記述されたバケットポリシーは、バケットに保存されているオブジェクトへのアクセスを提供します。"
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button disabled={!b.policy} onClick={() => run((d) => deleteBucketPolicy(d, b.name), `バケット「${b.name}」のバケットポリシーを削除しました`)} data-testid="delete-bucket-policy">削除</Button>
                <Hotspot hotspotId="s3-edit-policy" direction="right">
                  <Button onClick={() => navigate(`${bucketPath(b.name)}/edit-policy`)} data-testid="edit-bucket-policy">編集</Button>
                </Hotspot>
              </SpaceBetween>
            }
          >
            バケットポリシー
          </Header>
        }
      >
        {b.policy ? <JsonBlock value={b.policy} testId="bucket-policy" /> : <Box color="text-body-secondary">表示するポリシーはありません。</Box>}
      </Container>
      <Container header={<Header variant="h2">オブジェクト所有者</Header>}>
        <Box>バケット所有者の強制 — ACL は無効になっています。このバケット内のすべてのオブジェクトはこのアカウントが所有し、アクセスはポリシーのみで制御されます。</Box>
      </Container>
    </SpaceBetween>
  );
}

export function BucketDetail({ name }: { name: string }) {
  const env = useGlobalEnv();
  const b = env.buckets.find((x) => x.name === name);
  if (!b) return <NotFound what="バケット" id={name} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={<StatusIndicator type={accessSummary(b).type}>{accessSummary(b).text}</StatusIndicator>}>
        {b.name}
      </Header>
      <ResourceTabs
        tabs={[
          { id: 'objects', label: 'オブジェクト', content: <ObjectsTab b={b} /> },
          { id: 'properties', label: 'プロパティ', content: <PropertiesTab b={b} /> },
          { id: 'permissions', label: 'アクセス許可', content: <PermissionsTab b={b} /> },
        ]}
      />
    </SpaceBetween>
  );
}

// ---------------- edits ----------------

export function EditBucketPolicy({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const b = env.buckets.find((x) => x.name === name);
  const [text, setText] = useState(() => (b?.policy ? JSON.stringify(b.policy, null, 2) : ''));
  const [error, setError] = useState<AwsError | null>(null);
  if (!b) return <NotFound what="バケット" id={name} />;
  return (
    <EditForm
      title="バケットポリシーを編集"
      description="JSON で記述されたバケットポリシーは、バケットに保存されているオブジェクトへのアクセスを提供します。"
      submitText="変更の保存"
      submitTestId="save-bucket-policy"
      submitHotspotId="s3-save-policy"
      onCancel={() => navigate(`${bucketPath(name)}?tab=permissions`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => (text.trim() ? putBucketPolicy(d, name, text, CONSOLE_USER_ARN(d)) : deleteBucketPolicy(d, name)), `バケット「${name}」のバケットポリシーが正常に編集されました`);
        if (r.ok) navigate(`${bucketPath(name)}?tab=permissions`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">バケットポリシー</Header>}>
        <SpaceBetween size="m">
          <FormField label="バケット ARN">
            <CopyableValue value={bucketArn(name)} />
          </FormField>
          <PolicyEditor value={text} onChange={setText} kind="resource" bucket={name} label="ポリシー" description="オブジェクトの ARN は arn:aws:s3:::バケット名/キー の形式です (バケット全体のオブジェクトは /* )。" testId="bucket-policy-editor" />
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function EditBpa({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const b = env.buckets.find((x) => x.name === name);
  const [bpa, setBpa] = useState<BlockPublicAccess>(b?.blockPublicAccess ?? BPA_ALL_ON);
  const [confirm, setConfirm] = useState(false);
  const [word, setWord] = useState('');
  if (!b) return <NotFound what="バケット" id={name} />;
  const save = () => {
    run((d) => putPublicAccessBlock(d, name, bpa), `バケット「${name}」のブロックパブリックアクセス設定が正常に編集されました`);
    navigate(`${bucketPath(name)}?tab=permissions`);
  };
  return (
    <>
      <EditForm title="ブロックパブリックアクセス (バケット設定) を編集" submitText="変更の保存" submitTestId="save-bpa" submitHotspotId="s3-save-bpa" onCancel={() => navigate(`${bucketPath(name)}?tab=permissions`)} error={null} onSubmit={() => setConfirm(true)}>
        <Container header={<Header variant="h2" description="AWS では、特定のユースケースでパブリックアクセスが必要な場合を除き、「パブリックアクセスをすべて ブロック」をオンにすることをお勧めします。">ブロックパブリックアクセス (バケット設定)</Header>}>
          <BpaEditor value={bpa} onChange={setBpa} />
        </Container>
      </EditForm>
      {confirm && (
        <Modal
          visible
          header="ブロックパブリックアクセス (バケット設定) を編集しますか?"
          onDismiss={() => setConfirm(false)}
          footer={
            <Box float="right">
              <SpaceBetween direction="horizontal" size="xs">
                <Button variant="link" onClick={() => setConfirm(false)}>キャンセル</Button>
                <Button variant="primary" disabled={word !== '確認'} onClick={save} data-testid="bpa-confirm">確認</Button>
              </SpaceBetween>
            </Box>
          }
        >
          <SpaceBetween size="m">
            <Box>この設定の変更は、このバケットとその中のすべてのオブジェクトに影響します。これにより、一部のオブジェクトがパブリックになる可能性があります。</Box>
            <FormField label="この設定を確認するには、フィールドに「確認」と入力します。">
              <Input value={word} onChange={(e) => setWord(e.detail.value)} placeholder="確認" data-testid="bpa-confirm-input" />
            </FormField>
          </SpaceBetween>
        </Modal>
      )}
    </>
  );
}

export function EditVersioning({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const b = env.buckets.find((x) => x.name === name);
  const [status, setStatus] = useState(b?.versioning === 'Enabled' ? 'Enabled' : 'Suspended');
  if (!b) return <NotFound what="バケット" id={name} />;
  return (
    <EditForm
      title="バケットのバージョニングを編集"
      submitText="変更の保存"
      submitTestId="save-versioning"
      onCancel={() => navigate(`${bucketPath(name)}?tab=properties`)}
      error={null}
      onSubmit={() => {
        run((d) => putBucketVersioning(d, name, status as 'Enabled' | 'Suspended'), `バケット「${name}」のバケットのバージョニングが正常に編集されました`);
        navigate(`${bucketPath(name)}?tab=properties`);
      }}
    >
      <Container header={<Header variant="h2" description="一度有効にしたバージョニングは無効に戻せません (停止のみ可能)。">バケットのバージョニング</Header>}>
        <RadioGroup value={status} onChange={(e) => setStatus(e.detail.value)} items={[{ value: 'Suspended', label: b.versioning === 'Disabled' ? '無効にする' : '停止する', description: '以降のオブジェクトの新しいバージョンは作成されません。既存のバージョンは保持されます。' }, { value: 'Enabled', label: '有効にする' }]} data-testid="versioning-radio" />
      </Container>
    </EditForm>
  );
}

export function EditEncryption({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const b = env.buckets.find((x) => x.name === name);
  const [sse, setSse] = useState<'AES256' | 'aws:kms'>(b?.encryption.sseAlgorithm ?? 'AES256');
  if (!b) return <NotFound what="バケット" id={name} />;
  return (
    <EditForm
      title="デフォルトの暗号化を編集"
      submitText="変更の保存"
      onCancel={() => navigate(`${bucketPath(name)}?tab=properties`)}
      error={null}
      onSubmit={() => {
        run((d) => putBucketEncryption(d, name, sse), `バケット「${name}」のデフォルトの暗号化が正常に編集されました`);
        navigate(`${bucketPath(name)}?tab=properties`);
      }}
    >
      <Container header={<Header variant="h2">デフォルトの暗号化</Header>}>
        <RadioGroup value={sse} onChange={(e) => setSse(e.detail.value as typeof sse)} items={[{ value: 'AES256', label: 'Amazon S3 マネージドキーを用いたサーバー側の暗号化 (SSE-S3)' }, { value: 'aws:kms', label: 'AWS Key Management Service キーを用いたサーバー側の暗号化 (SSE-KMS)', description: 'aws/s3 (AWS マネージドキー)' }]} />
      </Container>
    </EditForm>
  );
}

// ---------------- objects ----------------

const readText = (f: File) =>
  f.size < 64 * 1024 && /^text\/|json|xml|javascript/.test(f.type || 'text/plain') ? f.text() : Promise.resolve(undefined);

export function UploadObjects({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const path = useConsole((s) => s.path);
  const prefix = queryParam(path, 'prefix') ?? '';
  const [files, setFiles] = useState<File[]>([]);
  const [done, setDone] = useState<string[] | null>(null);
  const b = env.buckets.find((x) => x.name === name);
  if (!b) return <NotFound what="バケット" id={name} />;
  if (done)
    return (
      <SpaceBetween size="l">
        <Alert type="success" header="正常にアップロードされました" data-testid="upload-success">{done.length} 個のファイルを s3://{name}/{prefix} にアップロードしました。</Alert>
        <Button variant="primary" onClick={() => navigate(`${bucketPath(name)}?tab=objects${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`)}>閉じる</Button>
      </SpaceBetween>
    );
  return (
    <EditForm
      title="アップロード"
      description="ファイルを S3 にアップロードします。(シミュレーター: ファイル名・サイズ・小さなテキストの内容のみを保存し、外部には送信しません)"
      submitText="アップロード"
      submitTestId="upload-submit"
      submitDisabled={!files.length}
      onCancel={() => navigate(`${bucketPath(name)}?tab=objects`)}
      error={null}
      onSubmit={() => {
        void Promise.all(files.map(readText)).then((bodies) => {
          const keys = files.map((f) => prefix + f.name);
          run((d) => files.forEach((f, n) => putObject(d, name, keys[n], { size: f.size, contentType: f.type || undefined, body: bodies[n] })), `${files.length} 個のファイルをアップロードしました`);
          setDone(keys);
        });
      }}
    >
      <Container header={<Header variant="h2" description="アップロードするファイルを選択します。">ファイルとフォルダ</Header>}>
        <FileUpload value={files} onChange={(e) => setFiles(e.detail.value)} multiple showFileSize showFileLastModified i18nStrings={{ uploadButtonText: (m) => (m ? 'ファイルを追加' : 'ファイルを選択'), dropzoneText: (m) => (m ? 'ここにファイルをドロップ' : 'ここにファイルをドロップ'), removeFileAriaLabel: (i) => `ファイル ${i + 1} を削除`, limitShowFewer: '少なく表示', limitShowMore: 'さらに表示', errorIconAriaLabel: 'エラー' }} data-testid="upload-files" />
      </Container>
      <Container header={<Header variant="h2">送信先</Header>}>
        <FormField label="送信先">s3://{name}/{prefix}</FormField>
      </Container>
    </EditForm>
  );
}

export function ObjectDetail({ name }: { name: string }) {
  const env = useGlobalEnv();
  const path = useConsole((s) => s.path);
  const key = queryParam(path, 'key') ?? '';
  const [tab, setTab] = useState('properties');
  const b = env.buckets.find((x) => x.name === name);
  const versions = b?.objects.filter((o) => o.key === key) ?? [];
  const o = versions.find((x) => x.isLatest && !x.deleteMarker);
  if (!b || !o) return <NotFound what="オブジェクト" id={key} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<ActionMenu items={[{ id: 'copy-uri', text: 'S3 URI をコピー', onClick: () => { void navigator.clipboard?.writeText(`s3://${name}/${key}`); useConsole.getState().recordCopy(`s3://${name}/${key}`); } }]} />}>
        {key.split('/').pop()}
      </Header>
      <Tabs
        activeTabId={tab}
        onChange={(e) => setTab(e.detail.activeTabId)}
        tabs={[
          {
            id: 'properties',
            label: 'プロパティ',
            content: (
              <SpaceBetween size="l">
                <ResourceDetail
                  title="オブジェクトの概要"
                  columns={2}
                  fields={[
                    { label: '所有者', value: env.accountId },
                    { label: 'AWS リージョン', value: regionLabel(b.region) },
                    { label: '最終更新日時', value: formatDate(o.lastModified) },
                    { label: 'サイズ', value: fmtSize(o.size) },
                    { label: 'タイプ', value: o.contentType },
                    { label: 'キー', value: <CopyableValue value={key} /> },
                    { label: 'S3 URI', value: <CopyableValue value={`s3://${name}/${key}`} testId="s3-uri" /> },
                    { label: 'Amazon リソースネーム (ARN)', value: <CopyableValue value={objectArn(name, key)} /> },
                    { label: 'エンティティタグ (Etag)', value: o.etag.replaceAll('"', '') },
                    { label: 'オブジェクト URL', value: <Hotspot hotspotId="s3-object-url" direction="right"><CopyableValue value={objectUrl(b, key)} testId="object-url" /></Hotspot> },
                  ]}
                />
                <ResourceDetail title="サーバー側の暗号化の設定" columns={2} fields={[{ label: '暗号化タイプ', value: o.serverSideEncryption === 'AES256' ? 'Amazon S3 マネージドキーを用いたサーバー側の暗号化 (SSE-S3)' : 'SSE-KMS (aws/s3)' }]} />
              </SpaceBetween>
            ),
          },
          {
            id: 'versions',
            label: 'バージョン',
            content: (
              <Table<S3Object>
                variant="container"
                header={<Header counter={`(${versions.length})`}>バージョン</Header>}
                items={[...versions].reverse()}
                columnDefinitions={[
                  { id: 'v', header: 'バージョン ID', cell: (v) => `${v.versionId}${v.isLatest ? ' (最新バージョン)' : ''}` },
                  { id: 't', header: 'タイプ', cell: (v) => (v.deleteMarker ? '削除マーカー' : key.split('.').pop()) },
                  { id: 'd', header: '最終更新日時', cell: (v) => formatDate(v.lastModified) },
                  { id: 's', header: 'サイズ', cell: (v) => (v.deleteMarker ? '-' : fmtSize(v.size)) },
                ]}
              />
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}
