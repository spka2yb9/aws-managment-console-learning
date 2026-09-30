import Alert from '@cloudscape-design/components/alert';
import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import RadioGroup from '@cloudscape-design/components/radio-group';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import Toggle from '@cloudscape-design/components/toggle';
import { useState } from 'react';
import { changeRecord, createInvalidation, createValidationRecords, deleteCertificate, requestCertificate, updateDistribution, updateIpSet } from '../../sim/edge';
import { regionOf } from '../../sim/env';
import type { AwsEnv, AwsError, Certificate, DnsRecord, Distribution, WafRule } from '../../sim/types';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, DeleteModal, EditForm, formatDate, NotFound, ResourceDetail, ResourceTable, ResourceTabs, useGlobalEnv, useNavigate, useSelection } from '../ui';

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const certId = (c: Certificate) => c.certificateArn.split('/').pop()!;
const certPath = (c: Certificate) => `/acm/certificates/${certId(c)}`;
const distPath = (id: string) => `/cloudfront/distributions/${id}`;

// ---------------- Route 53 ----------------

export function HostedZoneList() {
  const env = useGlobalEnv();
  return (
    <ResourceTable
      title="ホストゾーン"
      resourceName="ホストゾーン"
      testId="hosted-zones"
      items={env.hostedZones}
      trackBy={(z) => z.id}
      selectionType="none"
      columns={[
        { id: 'name', header: 'ホストゾーン名', cell: (z) => <ConsoleLink to={`/route53/hostedzones/${z.id}`}>{z.name}</ConsoleLink>, value: (z) => z.name },
        { id: 'type', header: 'タイプ', cell: () => 'パブリック' },
        { id: 'records', header: 'レコード数', cell: (z) => String(z.records.length) },
        { id: 'comment', header: '説明', cell: (z) => z.comment ?? '-' },
        { id: 'id', header: 'ホストゾーン ID', cell: (z) => z.id, value: (z) => z.id },
      ]}
    />
  );
}

const recordValue = (r: DnsRecord) => (r.aliasTarget ? `${r.aliasTarget}.` : r.values.join('\n'));

export function HostedZoneDetail({ id }: { id: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const z = env.hostedZones.find((x) => x.id === id);
  const [selected, setSelected] = useSelection(z?.records ?? [], (r) => `${r.name} ${r.type}`);
  if (!z) return <NotFound what="ホストゾーン" id={id} />;
  const deletable = selected.length === 1 && !(selected[0].name === z.name && ['NS', 'SOA'].includes(selected[0].type));
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description="パブリックホストゾーン">{z.name}</Header>
      <ResourceDetail
        title="ホストゾーンの詳細"
        columns={3}
        fields={[
          { label: 'ホストゾーン ID', value: <CopyableValue value={z.id} /> },
          { label: '説明', value: z.comment },
          { label: 'ネームサーバー', value: <span className="pre-line">{z.records.find((r) => r.type === 'NS')?.values.join('\n')}</span> },
        ]}
      />
      <ResourceTable
        title="レコード"
        resourceName="レコード"
        variant="container"
        testId="dns-records"
        items={z.records}
        trackBy={(r) => `${r.name} ${r.type}`}
        selectedItems={selected}
        onSelectionChange={setSelected}
        actions={
          <SpaceBetween direction="horizontal" size="xs">
            <Button disabled={!deletable} onClick={() => run((d) => changeRecord(d, z.id, 'DELETE', selected[0]), `レコード ${selected[0].name} (${selected[0].type}) を削除しました`) && setSelected([])} data-testid="delete-record">レコードを削除</Button>
            <Button disabled={!deletable} onClick={() => navigate(`/route53/hostedzones/${z.id}/edit-record?${new URLSearchParams({ name: selected[0].name, type: selected[0].type })}`)} data-testid="edit-record">レコードを編集</Button>
            <Hotspot hotspotId="route53-create-record" direction="right">
              <Button variant="primary" onClick={() => navigate(`/route53/hostedzones/${z.id}/create-record`)} data-testid="create-record">レコードを作成</Button>
            </Hotspot>
          </SpaceBetween>
        }
        columns={[
          { id: 'name', header: 'レコード名', cell: (r) => r.name, value: (r) => r.name, width: 220 },
          { id: 'type', header: 'タイプ', cell: (r) => r.type, value: (r) => r.type, width: 90 },
          { id: 'policy', header: 'ルーティングポリシー', cell: () => 'シンプル', width: 120 },
          { id: 'alias', header: 'エイリアス', cell: (r) => (r.aliasTarget ? 'はい' : 'いいえ'), width: 100 },
          { id: 'value', header: '値/トラフィックのルーティング先', cell: (r) => <span className="pre-line">{recordValue(r)}</span>, value: recordValue },
          { id: 'ttl', header: 'TTL (秒)', cell: (r) => (r.ttl === undefined ? '-' : String(r.ttl)) },
        ]}
      />
    </SpaceBetween>
  );
}

type AliasKind = 'alb' | 'cloudfront';
const ALIAS_KINDS: { value: AliasKind; label: string }[] = [
  { value: 'alb', label: 'Application Load Balancer と Classic Load Balancer へのエイリアス' },
  { value: 'cloudfront', label: 'CloudFront ディストリビューションへのエイリアス' },
];
const aliasOptions = (env: AwsEnv, kind: AliasKind) =>
  kind === 'alb' ? env.loadBalancers.map((l) => ({ value: l.dnsName, label: l.dnsName, description: l.loadBalancerName })) : env.distributions.map((d) => ({ value: d.domainName, label: d.domainName, description: d.comment }));

/** "レコードを作成", or with `edit` the "レコードを編集" form for an existing record (name + type). */
export function CreateRecord({ id, edit }: { id: string; edit?: { name: string; type: string } }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const z = env.hostedZones.find((x) => x.id === id);
  const current = edit ? z?.records.find((r) => r.name === edit.name && r.type === edit.type) : undefined;
  const [sub, setSub] = useState(current && z ? current.name.slice(0, -z.name.length).replace(/\.$/, '') : '');
  const [type, setType] = useState<DnsRecord['type']>(current?.type ?? 'A');
  const [alias, setAlias] = useState(!!current?.aliasTarget);
  const [kind, setKind] = useState<AliasKind>(current?.aliasTarget?.endsWith('.cloudfront.net') ? 'cloudfront' : 'alb');
  const [target, setTarget] = useState(current?.aliasTarget ?? '');
  const [value, setValue] = useState(current?.values.join('\n') ?? '');
  const [ttl, setTtl] = useState(String(current?.ttl ?? 300));
  const [error, setError] = useState<AwsError | null>(null);
  if (!z) return <NotFound what="ホストゾーン" id={id} />;
  if (edit && !current) return <NotFound what="レコード" id={`${edit.name} (${edit.type})`} />;
  const canAlias = type === 'A' || type === 'AAAA';
  const name = sub.trim() ? `${sub.trim()}.${z.name}` : z.name;
  const back = `/route53/hostedzones/${z.id}`;
  return (
    <EditForm
      title={current ? 'レコードを編集' : 'レコードを作成'}
      submitText={current ? '保存' : 'レコードを作成'}
      submitTestId="create-record-submit"
      submitHotspotId="route53-create-record-submit"
      onCancel={() => navigate(back)}
      error={error}
      onSubmit={() => {
        const rec: DnsRecord = alias && canAlias ? { name, type, values: [], aliasTarget: target } : { name, type, ttl: Number(ttl), values: lines(value) };
        // same name and type: UPSERT; renamed or retyped: the old record goes, a new one is created (one change batch)
        const same = current && current.name === name.toLowerCase() && current.type === type;
        const r = run(
          (d) => {
            if (current && !same) changeRecord(d, z.id, 'DELETE', current);
            changeRecord(d, z.id, same ? 'UPSERT' : 'CREATE', rec);
          },
          `レコード ${name} が正常に${current ? '更新' : '作成'}されました`,
        );
        if (r.ok) navigate(back);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2" description="シンプルルーティングのレコードを 1 件作成します。">クイック作成</Header>}>
        <SpaceBetween size="m">
          <FormField label="レコード名" description="ルートドメイン (Zone Apex) のレコードを作成するには、空白のままにします。">
            <div className="input-with-suffix">
              <Input value={sub} onChange={(e) => setSub(e.detail.value)} placeholder="www" data-testid="record-name" />
              <Box variant="code">.{z.name}</Box>
            </div>
          </FormField>
          <FormField label="レコードタイプ">
            <Select
              selectedOption={{ value: type, label: type }}
              options={(['A', 'AAAA', 'CNAME', 'TXT', 'MX'] as const).map((t) => ({ value: t, label: t, description: { A: 'IPv4 アドレスと一部の AWS リソースにトラフィックをルーティング', AAAA: 'IPv6 アドレスにトラフィックをルーティング', CNAME: '別のドメイン名にトラフィックをルーティング', TXT: 'テキストレコード (検証など)', MX: 'メールサーバーを指定' }[t] }))}
              onChange={(e) => setType(e.detail.selectedOption.value as DnsRecord['type'])}
              data-testid="record-type"
            />
          </FormField>
          {canAlias && <Toggle checked={alias} onChange={(e) => setAlias(e.detail.checked)} data-testid="record-alias">エイリアス</Toggle>}
          {alias && canAlias ? (
            <FormField label="トラフィックのルーティング先">
              <SpaceBetween size="xs">
                <Select selectedOption={ALIAS_KINDS.find((k) => k.value === kind)!} options={ALIAS_KINDS} onChange={(e) => { setKind(e.detail.selectedOption.value as AliasKind); setTarget(''); }} data-testid="alias-kind" />
                {kind === 'alb' && <Select selectedOption={{ value: 'ap-northeast-1', label: regionOf('ap-northeast-1').name }} options={[{ value: 'ap-northeast-1', label: regionOf('ap-northeast-1').name }]} disabled />}
                <Select selectedOption={target ? { value: target, label: target } : null} placeholder="エンドポイントを選択" options={aliasOptions(env, kind)} onChange={(e) => setTarget(e.detail.selectedOption.value!)} empty="エンドポイントがありません" data-testid="alias-target" />
              </SpaceBetween>
            </FormField>
          ) : (
            <>
              <FormField label="値" description="1 行に 1 つずつ入力します。">
                <Textarea value={value} onChange={(e) => setValue(e.detail.value)} rows={2} placeholder={type === 'CNAME' ? 'web-alb-1234567890.ap-northeast-1.elb.amazonaws.com' : '192.0.2.235'} data-testid="record-value" />
              </FormField>
              <FormField label="TTL (秒)"><Input value={ttl} onChange={(e) => setTtl(e.detail.value)} type="number" /></FormField>
            </>
          )}
          <FormField label="ルーティングポリシー"><Select selectedOption={{ value: 'simple', label: 'シンプルルーティング' }} options={[{ value: 'simple', label: 'シンプルルーティング' }]} disabled /></FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- ACM (regional: certificates live in the Region they were requested in) ----------------

function useRegionCertificates() {
  const env = useGlobalEnv();
  const region = useConsole((s) => s.region);
  return { env, region, certs: env.certificates.filter((c) => c.region === region) };
}

const CertStatus = ({ c }: { c: Certificate }) => (c.status === 'ISSUED' ? <StatusIndicator>発行済み</StatusIndicator> : <StatusIndicator type="pending">検証保留中</StatusIndicator>);
const usedBy = (env: AwsEnv, c: Certificate) => env.distributions.filter((d) => d.certificateArn === c.certificateArn);

export function CertificateList() {
  const { env, region, certs } = useRegionCertificates();
  const navigate = useNavigate();
  return (
    <ResourceTable
      title="証明書"
      description={`${regionOf(region).name} (${region}) の証明書`}
      resourceName="証明書"
      testId="certificates"
      items={certs}
      trackBy={(c) => c.certificateArn}
      selectionType="none"
      actions={
        <Hotspot hotspotId="acm-request" direction="right">
          <Button variant="primary" onClick={() => navigate('/acm/certificates/request')} data-testid="request-certificate">リクエスト</Button>
        </Hotspot>
      }
      columns={[
        { id: 'id', header: '証明書 ID', cell: (c) => <ConsoleLink to={certPath(c)}>{certId(c)}</ConsoleLink>, value: certId },
        { id: 'domain', header: 'ドメイン名', cell: (c) => c.domainName, value: (c) => c.domainName },
        { id: 'names', header: '追加の名前', cell: (c) => c.subjectAlternativeNames.slice(1).join(', ') || '-' },
        { id: 'type', header: 'タイプ', cell: () => 'Amazon 発行' },
        { id: 'status', header: 'ステータス', cell: (c) => <CertStatus c={c} />, value: (c) => c.status },
        { id: 'used', header: '使用中', cell: (c) => (usedBy(env, c).length ? 'はい' : 'いいえ') },
      ]}
    />
  );
}

/** a list of names with 追加 / 削除 (certificate domain names, CloudFront alternate domain names) */
function NameList({ names, onChange, addText, placeholder, testId }: { names: string[]; onChange: (n: string[]) => void; addText: string; placeholder: string; testId: string }) {
  return (
    <SpaceBetween size="xs">
      {names.map((n, i) => (
        <div key={i} className="input-with-suffix" data-testid={`${testId}-${i}`}>
          <Input value={n} onChange={(e) => onChange(names.map((x, j) => (j === i ? e.detail.value : x)))} placeholder={placeholder} />
          <Button formAction="none" onClick={() => onChange(names.filter((_, j) => j !== i))} disabled={names.length === 1 && i === 0 && testId === 'cert-name'}>削除</Button>
        </div>
      ))}
      <Button formAction="none" onClick={() => onChange([...names, ''])} data-testid={`${testId}-add`}>{addText}</Button>
    </SpaceBetween>
  );
}

export function RequestCertificate() {
  const region = useConsole((s) => s.region);
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [names, setNames] = useState(['']);
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="パブリック証明書をリクエスト"
      submitText="リクエスト"
      submitTestId="request-certificate-submit"
      submitHotspotId="acm-request-submit"
      onCancel={() => navigate('/acm/certificates')}
      error={error}
      onSubmit={() => {
        const [first, ...rest] = names.map((n) => n.trim()).filter(Boolean);
        const r = run((d) => requestCertificate(d, { domainName: first ?? '', subjectAlternativeNames: rest, region }), (arn) => `証明書 ${String(arn).split('/').pop()} をリクエストしました`);
        if (r.ok) navigate(`/acm/certificates/${String(r.value).split('/').pop()}`);
        else setError(r.error);
      }}
    >
      <Alert type="info" header={`リージョン: ${regionOf(region).name} (${region})`}>
        証明書は、リクエストしたリージョンでのみ使えます。<b>CloudFront で使う証明書は、米国東部 (バージニア北部) us-east-1 でリクエストする</b>必要があります。
      </Alert>
      <Container header={<Header variant="h2">ドメイン名</Header>}>
        <FormField label="完全修飾ドメイン名" description="例: www.example.com。*.example.com のようなワイルドカードは、1 つ下の階層の名前をすべて保護します (example.com 自体は含みません)。">
          <NameList names={names} onChange={setNames} addText="この証明書に別の名前を追加" placeholder="example.com" testId="cert-name" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">検証方法</Header>}>
        <RadioGroup value="dns" items={[{ value: 'dns', label: 'DNS 検証 - 推奨', description: 'ドメインの DNS 設定に CNAME レコードを追加して、所有していることを証明します。' }, { value: 'email', label: 'E メール検証', disabled: true, description: 'このシミュレーターでは未提供' }]} />
      </Container>
    </EditForm>
  );
}

export function CertificateDetail({ id }: { id: string }) {
  const { env, certs } = useRegionCertificates();
  const run = useConsole((s) => s.run);
  const navigate = useNavigate();
  const [deleting, setDeleting] = useState(false);
  const c = certs.find((x) => certId(x) === id);
  if (!c) return <NotFound what="証明書" id={id} />;
  const validated = (v: Certificate['validation'][number]) => c.status === 'ISSUED' || env.hostedZones.some((z) => z.records.some((r) => r.type === 'CNAME' && r.name === v.cnameName.toLowerCase()));
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<Button onClick={() => setDeleting(true)} data-testid="delete-certificate">削除</Button>}>{id}</Header>
      {deleting && (
        <DeleteModal
          header="証明書を削除"
          testId="delete-cert"
          onClose={() => setDeleting(false)}
          onDelete={() => {
            const r = run((d) => deleteCertificate(d, c.certificateArn), `証明書 ${id} を削除しました`);
            if (r.ok) navigate('/acm/certificates');
            return r;
          }}
        >
          <Box>証明書 {c.subjectAlternativeNames.join(', ')} を削除しますか? CloudFront などで使用中の証明書は削除できません。</Box>
        </DeleteModal>
      )}
      <ResourceDetail
        title="証明書のステータス"
        columns={3}
        fields={[
          { label: '識別子', value: id },
          { label: 'ARN', value: <CopyableValue value={c.certificateArn} iconOnly /> },
          { label: 'タイプ', value: 'Amazon 発行' },
          { label: 'ステータス', value: <span data-testid="cert-status"><CertStatus c={c} /></span> },
          { label: 'リクエスト日時', value: formatDate(c.createdAt) },
          { label: '発行日時', value: c.issuedAt ? formatDate(c.issuedAt) : '-' },
        ]}
      />
      <Table
        variant="container"
        data-testid="cert-domains"
        header={
          <Header
            counter={`(${c.validation.length})`}
            description="DNS 検証: 各 CNAME レコードをドメインの DNS に追加すると、数分で発行されます。"
            actions={
              c.status === 'PENDING_VALIDATION' && (
                <Hotspot hotspotId="acm-create-records" direction="right">
                  <Button onClick={() => run((d) => createValidationRecords(d, c.certificateArn), 'Route 53 に DNS レコードを作成しました。検証が完了するまで数分かかります')} data-testid="acm-create-records">Route 53 でレコードを作成</Button>
                </Hotspot>
              )
            }
          >
            ドメイン
          </Header>
        }
        items={c.validation}
        columnDefinitions={[
          { id: 'domain', header: 'ドメイン', cell: (v) => v.domainName },
          { id: 'status', header: 'ステータス', cell: (v) => (c.status === 'ISSUED' ? <StatusIndicator>成功</StatusIndicator> : <StatusIndicator type="pending">{validated(v) ? '検証中' : '検証保留中'}</StatusIndicator>) },
          { id: 'name', header: 'CNAME 名', cell: (v) => <CopyableValue value={`${v.cnameName}.`} /> },
          { id: 'value', header: 'CNAME 値', cell: (v) => <CopyableValue value={`${v.cnameValue}.`} /> },
        ]}
      />
      <Container header={<Header variant="h2">関連付けられたリソース</Header>}>
        {usedBy(env, c).length ? usedBy(env, c).map((d) => <Box key={d.id}>{d.arn}</Box>) : <Box color="text-body-secondary">この証明書はどのリソースにも関連付けられていません。</Box>}
      </Container>
    </SpaceBetween>
  );
}

// ---------------- CloudFront (global) ----------------

const originName = (env: AwsEnv, d: Distribution) => (d.origin.kind === 's3' ? `${d.origin.bucket}.s3.${env.region}.amazonaws.com` : (env.loadBalancers.find((l) => l.loadBalancerName === (d.origin as { loadBalancerName: string }).loadBalancerName)?.dnsName ?? d.origin.loadBalancerName));
const lastModified = (d: Distribution) => (d.status === 'InProgress' ? <StatusIndicator type="in-progress">デプロイ中</StatusIndicator> : formatDate(d.lastModified));
const POLICY_LABEL: Record<Distribution['viewerProtocolPolicy'], string> = { 'allow-all': 'HTTP and HTTPS', 'redirect-to-https': 'Redirect HTTP to HTTPS', 'https-only': 'HTTPS only' };

export function DistributionList() {
  const env = useGlobalEnv();
  return (
    <ResourceTable
      title="ディストリビューション"
      resourceName="ディストリビューション"
      testId="distributions"
      items={env.distributions}
      trackBy={(d) => d.id}
      selectionType="none"
      columns={[
        { id: 'id', header: 'ID', cell: (d) => <ConsoleLink to={distPath(d.id)}>{d.id}</ConsoleLink>, value: (d) => d.id },
        { id: 'desc', header: '説明', cell: (d) => d.comment ?? '-', value: (d) => d.comment ?? '' },
        { id: 'domain', header: 'ドメイン名', cell: (d) => d.domainName, value: (d) => d.domainName },
        { id: 'aliases', header: '代替ドメイン名', cell: (d) => d.aliases.join(', ') || '-', value: (d) => d.aliases.join(' ') },
        { id: 'origin', header: 'オリジン', cell: (d) => originName(env, d) },
        { id: 'status', header: 'ステータス', cell: (d) => (d.enabled ? <StatusIndicator>有効</StatusIndicator> : <StatusIndicator type="stopped">無効</StatusIndicator>) },
        { id: 'modified', header: '最終変更日', cell: lastModified },
      ]}
    />
  );
}

export function DistributionDetail({ id }: { id: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const d = env.distributions.find((x) => x.id === id);
  if (!d) return <NotFound what="ディストリビューション" id={id} />;
  const cert = env.certificates.find((c) => c.certificateArn === d.certificateArn);
  const acl = env.webAcls.find((a) => a.arn === d.webAclArn);
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={d.comment}>{d.id}</Header>
      <ResourceTabs
        tabs={[
          {
            id: 'general',
            label: '一般',
            content: (
              <SpaceBetween size="l">
                <ResourceDetail
                  title="詳細"
                  columns={3}
                  fields={[
                    { label: 'ディストリビューションドメイン名', value: <CopyableValue value={d.domainName} testId="distribution-domain" /> },
                    { label: 'ARN', value: <CopyableValue value={d.arn} iconOnly /> },
                    { label: '最終変更日', value: <span data-testid="distribution-status">{lastModified(d)}</span> },
                  ]}
                />
                <ResourceDetail
                  title="設定"
                  columns={3}
                  actions={
                    <Hotspot hotspotId="cloudfront-edit" direction="right">
                      <Button onClick={() => navigate(`${distPath(d.id)}/edit`)} data-testid="edit-distribution">編集</Button>
                    </Hotspot>
                  }
                  fields={[
                    { label: '代替ドメイン名', value: <span data-testid="distribution-aliases">{d.aliases.join('\n') || '-'}</span> },
                    { label: 'カスタム SSL 証明書', value: cert ? <span data-testid="distribution-cert">{cert.subjectAlternativeNames.join(', ')}</span> : '-' },
                    { label: 'AWS WAF', value: acl ? <ConsoleLink to={`/wafv2/webacls/${acl.name}`}>{acl.name}</ConsoleLink> : '-' },
                    { label: '料金クラス', value: 'すべてのエッジロケーションを使用する (最高のパフォーマンス)' },
                    { label: 'サポートされている HTTP バージョン', value: 'HTTP/2, HTTP/1.1, HTTP/1.0' },
                    { label: 'デフォルトルートオブジェクト', value: d.origin.kind === 's3' ? 'index.html' : '-' },
                  ]}
                />
              </SpaceBetween>
            ),
          },
          {
            id: 'origins',
            label: 'オリジン',
            content: (
              <Table
                variant="container"
                header={<Header counter="(1)">オリジン</Header>}
                items={[d]}
                columnDefinitions={[
                  { id: 'name', header: 'オリジンドメイン', cell: (x) => originName(env, x) },
                  { id: 'type', header: 'オリジンタイプ', cell: (x) => (x.origin.kind === 's3' ? 'S3' : 'Elastic Load Balancer') },
                  { id: 'access', header: 'オリジンアクセス', cell: (x) => (x.origin.kind === 's3' ? 'オリジンアクセスコントロール (OAC)' : '-') },
                  { id: 'proto', header: 'プロトコル', cell: (x) => (x.origin.kind === 's3' ? '-' : 'HTTP のみ (ポート 80)') },
                ]}
              />
            ),
          },
          {
            id: 'behaviors',
            label: 'ビヘイビア',
            content: (
              <Table
                variant="container"
                header={
                  <Header counter="(1)" actions={<Button onClick={() => navigate(`${distPath(d.id)}/behaviors/edit`)} data-testid="edit-behavior">編集</Button>}>
                    ビヘイビア
                  </Header>
                }
                items={[d]}
                columnDefinitions={[
                  { id: 'path', header: 'パスパターン', cell: () => 'デフォルト (*)' },
                  { id: 'origin', header: 'オリジン', cell: (x) => originName(env, x) },
                  { id: 'policy', header: 'ビューワープロトコルポリシー', cell: (x) => POLICY_LABEL[x.viewerProtocolPolicy] },
                  { id: 'ttl', header: 'デフォルト TTL (秒)', cell: (x) => <span data-testid="behavior-ttl">{x.defaultTtl}</span> },
                ]}
              />
            ),
          },
          {
            id: 'invalidations',
            label: '無効化',
            content: (
              <Table
                variant="container"
                data-testid="invalidations"
                header={
                  <Header
                    counter={`(${d.invalidations.length})`}
                    description="キャッシュからファイルを削除します。次のリクエストでは、オリジンから最新のファイルを取得します。"
                    actions={
                      <Hotspot hotspotId="cloudfront-invalidate" direction="right">
                        <Button variant="primary" onClick={() => navigate(`${distPath(d.id)}/invalidations/create`)} data-testid="create-invalidation">無効化を作成</Button>
                      </Hotspot>
                    }
                  >
                    無効化
                  </Header>
                }
                items={d.invalidations}
                empty={<Box color="text-body-secondary">無効化はありません</Box>}
                columnDefinitions={[
                  { id: 'id', header: '無効化 ID', cell: (i) => i.id },
                  { id: 'paths', header: 'オブジェクトパス', cell: (i) => i.paths.join(', ') },
                  { id: 'status', header: 'ステータス', cell: (i) => (i.status === 'Completed' ? <StatusIndicator>完了</StatusIndicator> : <StatusIndicator type="in-progress">進行中</StatusIndicator>) },
                  { id: 'created', header: '作成日', cell: (i) => formatDate(i.createdAt) },
                ]}
              />
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

export function EditDistribution({ id }: { id: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const d = env.distributions.find((x) => x.id === id);
  const [aliases, setAliases] = useState(d?.aliases ?? []);
  const [cert, setCert] = useState(d?.certificateArn ?? '');
  const [acl, setAcl] = useState(d?.webAclArn ?? '');
  const [error, setError] = useState<AwsError | null>(null);
  if (!d) return <NotFound what="ディストリビューション" id={id} />;
  // like the real console: only us-east-1 certificates can be chosen
  const certs = env.certificates.filter((c) => c.region === 'us-east-1' && c.status === 'ISSUED');
  const certOption = (arn: string) => {
    const c = env.certificates.find((x) => x.certificateArn === arn);
    return c ? { value: arn, label: c.subjectAlternativeNames.join(', '), description: certId(c) } : null;
  };
  const acls = env.webAcls.filter((a) => a.scope === 'CLOUDFRONT');
  return (
    <EditForm
      title="設定を編集"
      submitText="変更を保存"
      submitTestId="edit-distribution-submit"
      submitHotspotId="cloudfront-edit-submit"
      onCancel={() => navigate(distPath(d.id))}
      error={error}
      onSubmit={() => {
        const r = run((x) => updateDistribution(x, d.id, { aliases: aliases.map((a) => a.trim()).filter(Boolean), certificateArn: cert || undefined, webAclArn: acl || undefined }), `ディストリビューション ${d.id} を更新しました。変更のデプロイには数分かかります`);
        if (r.ok) navigate(distPath(d.id));
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">設定</Header>}>
        <SpaceBetween size="m">
          <FormField label="代替ドメイン名 (CNAME) - オプション" description="このディストリビューションで使うカスタムドメイン名。証明書でカバーされている必要があります。">
            <NameList names={aliases} onChange={setAliases} addText="項目を追加" placeholder="www.example.com" testId="alias" />
          </FormField>
          <FormField label="カスタム SSL 証明書 - オプション" description="証明書は米国東部 (バージニア北部) リージョン (us-east-1) の ACM にある必要があります。">
            <Select
              selectedOption={certOption(cert)}
              placeholder="証明書を選択"
              options={[{ value: '', label: 'デフォルトの CloudFront 証明書 (*.cloudfront.net)' }, ...certs.map((c) => certOption(c.certificateArn)!)]}
              onChange={(e) => setCert(e.detail.selectedOption.value!)}
              empty="us-east-1 に発行済みの証明書がありません"
              data-testid="distribution-cert-select"
            />
          </FormField>
          <FormField label="AWS WAF ウェブ ACL - オプション">
            <Select selectedOption={acl ? { value: acl, label: acls.find((a) => a.arn === acl)?.name ?? acl } : { value: '', label: 'なし' }} options={[{ value: '', label: 'なし' }, ...acls.map((a) => ({ value: a.arn, label: a.name }))]} onChange={(e) => setAcl(e.detail.selectedOption.value!)} />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function EditBehavior({ id }: { id: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const d = env.distributions.find((x) => x.id === id);
  const [policy, setPolicy] = useState(d?.viewerProtocolPolicy ?? 'redirect-to-https');
  const [ttl, setTtl] = useState(String(d?.defaultTtl ?? 86400));
  const [error, setError] = useState<AwsError | null>(null);
  if (!d) return <NotFound what="ディストリビューション" id={id} />;
  const back = `${distPath(d.id)}?tab=behaviors`;
  return (
    <EditForm
      title="ビヘイビアを編集"
      submitText="変更を保存"
      onCancel={() => navigate(back)}
      error={error}
      onSubmit={() => {
        const r = run((x) => updateDistribution(x, d.id, { viewerProtocolPolicy: policy, defaultTtl: Math.max(0, Number(ttl) || 0) }), `ビヘイビアを更新しました`);
        if (r.ok) navigate(back);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">デフォルト (*)</Header>}>
        <SpaceBetween size="m">
          <FormField label="ビューワープロトコルポリシー">
            <RadioGroup value={policy} onChange={(e) => setPolicy(e.detail.value as typeof policy)} items={Object.entries(POLICY_LABEL).map(([value, label]) => ({ value, label }))} />
          </FormField>
          <FormField label="デフォルト TTL (秒)" description="オリジンが Cache-Control を返さないとき、エッジでキャッシュする時間。86400 = 1 日。">
            <Input value={ttl} onChange={(e) => setTtl(e.detail.value)} type="number" data-testid="behavior-ttl-input" />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function CreateInvalidationPage({ id }: { id: string }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [paths, setPaths] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  const back = `${distPath(id)}?tab=invalidations`;
  return (
    <EditForm
      title="無効化を作成"
      submitText="無効化を作成"
      submitTestId="create-invalidation-submit"
      submitHotspotId="cloudfront-invalidate-submit"
      onCancel={() => navigate(back)}
      error={error}
      onSubmit={() => {
        const r = run((x) => createInvalidation(x, id, lines(paths)), (inv) => `無効化 ${inv} を作成しました`);
        if (r.ok) navigate(back);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">オブジェクトパス</Header>}>
        <FormField label="オブジェクトパスを追加" description="1 行に 1 つ。/ で始めます。例: /index.html、/images/*、すべて削除するなら /*">
          <Textarea value={paths} onChange={(e) => setPaths(e.detail.value)} rows={4} placeholder="/index.html" data-testid="invalidation-paths" />
        </FormField>
      </Container>
    </EditForm>
  );
}

// ---------------- WAF (CloudFront scope = global) ----------------

const statementText = (env: AwsEnv, s: WafRule['statement']) =>
  s.kind === 'ip-set' ? `IP セット ${env.ipSets.find((x) => x.arn === s.ipSetArn)?.name ?? s.ipSetArn} に一致する送信元 IP` : s.kind === 'managed' ? `AWS マネージドルールグループ: ${s.name}` : `URI パスが ${s.value} で始まる`;
const WafAction = ({ a }: { a: string }) => <StatusIndicator type={a === 'BLOCK' || a === 'Block' ? 'error' : a === 'COUNT' || a === 'Count' ? 'info' : 'success'}>{a}</StatusIndicator>;

export function WebAclList() {
  const env = useGlobalEnv();
  return (
    <ResourceTable
      title="ウェブ ACL"
      description="グローバル (CloudFront)"
      resourceName="ウェブ ACL"
      items={env.webAcls}
      trackBy={(a) => a.arn}
      selectionType="none"
      columns={[
        { id: 'name', header: '名前', cell: (a) => <ConsoleLink to={`/wafv2/webacls/${a.name}`}>{a.name}</ConsoleLink>, value: (a) => a.name },
        { id: 'scope', header: 'スコープ', cell: (a) => (a.scope === 'CLOUDFRONT' ? 'グローバル (CloudFront)' : 'リージョン') },
        { id: 'rules', header: 'ルール', cell: (a) => String(a.rules.length) },
        { id: 'default', header: 'デフォルトアクション', cell: (a) => a.defaultAction },
      ]}
    />
  );
}

export function WebAclDetail({ name }: { name: string }) {
  const env = useGlobalEnv();
  const a = env.webAcls.find((x) => x.name === name);
  if (!a) return <NotFound what="ウェブ ACL" id={name} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{a.name}</Header>
      <ResourceTabs
        tabs={[
          {
            id: 'overview',
            label: '概要',
            content: (
              <Table
                variant="container"
                data-testid="waf-samples"
                header={<Header counter={`(${a.samples.length})`} description="このウェブ ACL が検査したリクエストのサンプル (新しい順)">サンプリングされたリクエスト</Header>}
                items={a.samples}
                empty={<Box color="text-body-secondary">サンプリングされたリクエストはありません</Box>}
                columnDefinitions={[
                  { id: 'ip', header: '送信元 IP', cell: (s) => s.clientIp },
                  { id: 'action', header: 'アクション', cell: (s) => <WafAction a={s.action} /> },
                  { id: 'rule', header: '一致したルール', cell: (s) => s.rule ?? 'デフォルトアクション' },
                  { id: 'uri', header: 'URI', cell: (s) => <Box variant="code">{s.uri}</Box> },
                  { id: 'at', header: '時刻', cell: (s) => formatDate(s.at) },
                  { id: 'host', header: 'ホスト', cell: (s) => s.host },
                ]}
              />
            ),
          },
          {
            id: 'rules',
            label: 'ルール',
            content: (
              <Table
                variant="container"
                data-testid="waf-rules"
                header={<Header counter={`(${a.rules.length})`} description={`上から (優先度の小さい順に) 評価し、最初に一致したルールのアクションを使います。どれにも一致しなければデフォルトアクション (${a.defaultAction}) です。`}>ルール</Header>}
                items={a.rules}
                columnDefinitions={[
                  { id: 'name', header: '名前', cell: (r) => r.name },
                  { id: 'prio', header: '優先度', cell: (r) => String(r.priority) },
                  { id: 'action', header: 'アクション', cell: (r) => <WafAction a={r.action} /> },
                  { id: 'stmt', header: 'ステートメント', cell: (r) => (r.statement.kind === 'ip-set' ? <ConsoleLink to={`/wafv2/ipsets/${env.ipSets.find((x) => x.arn === (r.statement as { ipSetArn: string }).ipSetArn)?.name}`}>{statementText(env, r.statement)}</ConsoleLink> : statementText(env, r.statement)) },
                ]}
              />
            ),
          },
          {
            id: 'resources',
            label: '関連付けられた AWS リソース',
            content: (
              <Container header={<Header variant="h2">関連付けられた AWS リソース</Header>}>
                {env.distributions.filter((d) => d.webAclArn === a.arn).map((d) => <Box key={d.id}><ConsoleLink to={distPath(d.id)}>{`${d.id} (${d.domainName})`}</ConsoleLink></Box>)}
              </Container>
            ),
          },
        ]}
      />
    </SpaceBetween>
  );
}

export function IpSetList() {
  const env = useGlobalEnv();
  return (
    <ResourceTable
      title="IP セット"
      description="グローバル (CloudFront)"
      resourceName="IP セット"
      items={env.ipSets}
      trackBy={(s) => s.arn}
      selectionType="none"
      columns={[
        { id: 'name', header: '名前', cell: (s) => <ConsoleLink to={`/wafv2/ipsets/${s.name}`}>{s.name}</ConsoleLink>, value: (s) => s.name },
        { id: 'desc', header: '説明', cell: (s) => s.description ?? '-' },
        { id: 'count', header: 'IP アドレス', cell: (s) => String(s.addresses.length) },
      ]}
    />
  );
}

export function IpSetDetail({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const s = env.ipSets.find((x) => x.name === name);
  if (!s) return <NotFound what="IP セット" id={name} />;
  return (
    <SpaceBetween size="l">
      <Header variant="h1" description={s.description}>{s.name}</Header>
      <Table
        variant="container"
        data-testid="ipset-addresses"
        header={
          <Header
            counter={`(${s.addresses.length})`}
            actions={
              <Hotspot hotspotId="waf-edit-ipset" direction="right">
                <Button onClick={() => navigate(`/wafv2/ipsets/${s.name}/edit`)} data-testid="edit-ipset">IP アドレスを編集</Button>
              </Hotspot>
            }
          >
            IP アドレス
          </Header>
        }
        items={s.addresses.map((cidr) => ({ cidr }))}
        columnDefinitions={[{ id: 'cidr', header: 'IP アドレス (CIDR)', cell: (x) => x.cidr }]}
      />
    </SpaceBetween>
  );
}

export function EditIpSet({ name }: { name: string }) {
  const env = useGlobalEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const s = env.ipSets.find((x) => x.name === name);
  const [text, setText] = useState(s?.addresses.join('\n') ?? '');
  const [error, setError] = useState<AwsError | null>(null);
  if (!s) return <NotFound what="IP セット" id={name} />;
  return (
    <EditForm
      title={`${s.name} を編集`}
      submitText="保存"
      submitTestId="edit-ipset-submit"
      submitHotspotId="waf-edit-ipset-submit"
      onCancel={() => navigate(`/wafv2/ipsets/${s.name}`)}
      error={error}
      onSubmit={() => {
        const r = run((x) => updateIpSet(x, s.arn, lines(text)), `IP セット ${s.name} を更新しました`);
        if (r.ok) navigate(`/wafv2/ipsets/${s.name}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">IP アドレス</Header>}>
        <FormField label="IP アドレス" description="1 行に 1 つ、CIDR 形式で入力します。1 つの IP アドレスだけなら /32 (例: 192.0.2.44/32)。">
          <Textarea value={text} onChange={(e) => setText(e.detail.value)} rows={5} data-testid="ipset-editor" />
        </FormField>
      </Container>
    </EditForm>
  );
}
