import Box from '@cloudscape-design/components/box';
import Button from '@cloudscape-design/components/button';
import Checkbox from '@cloudscape-design/components/checkbox';
import ColumnLayout from '@cloudscape-design/components/column-layout';
import Container from '@cloudscape-design/components/container';
import FormField from '@cloudscape-design/components/form-field';
import Header from '@cloudscape-design/components/header';
import Hotspot from '@cloudscape-design/components/hotspot';
import Input from '@cloudscape-design/components/input';
import Multiselect from '@cloudscape-design/components/multiselect';
import RadioGroup from '@cloudscape-design/components/radio-group';
import SegmentedControl from '@cloudscape-design/components/segmented-control';
import Select from '@cloudscape-design/components/select';
import SpaceBetween from '@cloudscape-design/components/space-between';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Table from '@cloudscape-design/components/table';
import Textarea from '@cloudscape-design/components/textarea';
import Wizard from '@cloudscape-design/components/wizard';
import { useState } from 'react';
import { createAutoScalingGroup, createLaunchTemplate, deleteAutoScalingGroup, deletePolicy, liveInstances, loadTestSeries, putTargetTrackingPolicy, setTraffic, templateVersion, updateAutoScalingGroup } from '../../sim/autoscaling';
import { asgCpuMetric, metricFor } from '../../sim/cloudwatch';
import { AMIS, INSTANCE_TYPES } from '../../sim/ec2';
import { label, nameOf } from '../../sim/env';
import type { AutoScalingGroup, AwsError, TargetTrackingPolicy } from '../../sim/types';
import { sgOption, vpcOption } from '../options';
import { useConsole } from '../store';
import { ConsoleLink, CopyableValue, DeleteModal, EditForm, errorText, formatDate, NotFound, ResourceDetail, ResourceStatus, ResourceTable, ResourceTabs, useEnv, useNavigate } from '../ui';
import { Graph, MonitoringCharts, useNow } from './cloudwatch';

const asgPath = (name: string) => `/ec2/autoscaling/${encodeURIComponent(name)}`;
const METRIC_LABEL: Record<TargetTrackingPolicy['metric'], string> = { ASGAverageCPUUtilization: '平均 CPU 使用率', ALBRequestCountPerTarget: 'ターゲットあたりの Application Load Balancer リクエスト数' };
const LIFECYCLE: Record<string, string> = { Pending: 'Pending', InService: 'InService', Terminating: 'Terminating', Terminated: 'Terminated' };

// ---------------- launch templates ----------------

export function LaunchTemplateList() {
  const env = useEnv();
  const navigate = useNavigate();
  return (
    <ResourceTable
      title="起動テンプレート"
      description="起動テンプレートには、インスタンスを起動するための設定 (AMI、インスタンスタイプ、セキュリティグループ、ユーザーデータなど) を保存します。"
      resourceName="起動テンプレート"
      testId="lt-table"
      items={env.launchTemplates}
      trackBy={(t) => t.launchTemplateId}
      selectionType="none"
      actions={<Button variant="primary" onClick={() => navigate('/ec2/launch-templates/create')}>起動テンプレートを作成</Button>}
      columns={[
        { id: 'id', header: '起動テンプレート ID', cell: (t) => <ConsoleLink to={`/ec2/launch-templates/${t.launchTemplateId}`}>{t.launchTemplateId}</ConsoleLink>, value: (t) => t.launchTemplateId },
        { id: 'name', header: '起動テンプレート名', cell: (t) => t.launchTemplateName, value: (t) => t.launchTemplateName },
        { id: 'default', header: 'デフォルトのバージョン', cell: (t) => String(t.defaultVersionNumber) },
        { id: 'latest', header: '最新バージョン', cell: (t) => String(t.latestVersionNumber) },
        { id: 'time', header: '作成時間', cell: (t) => formatDate(t.createTime) },
      ]}
    />
  );
}

export function LaunchTemplateDetail({ id }: { id: string }) {
  const env = useEnv();
  const t = env.launchTemplates.find((x) => x.launchTemplateId === id);
  if (!t) return <NotFound what="起動テンプレート" id={id} />;
  const v = templateVersion(t, '$Default');
  return (
    <SpaceBetween size="l">
      <Header variant="h1">{`${t.launchTemplateId} (${t.launchTemplateName})`}</Header>
      <ResourceDetail
        title="起動テンプレートの詳細"
        columns={3}
        fields={[
          { label: '起動テンプレート ID', value: <CopyableValue value={t.launchTemplateId} /> },
          { label: '起動テンプレート名', value: t.launchTemplateName },
          { label: 'デフォルトのバージョン', value: String(t.defaultVersionNumber) },
        ]}
      />
      <ResourceDetail
        title={`バージョン ${v.versionNumber} の詳細${v.versionDescription ? ` - ${v.versionDescription}` : ''}`}
        columns={3}
        fields={[
          { label: 'AMI ID', value: v.imageId },
          { label: 'インスタンスタイプ', value: v.instanceType },
          { label: 'キーペア名', value: v.keyName },
          { label: 'セキュリティグループ ID', value: v.securityGroupIds.map((g) => label(g, env.securityGroups.find((x) => x.groupId === g))).join(', ') },
          { label: '詳細 CloudWatch モニタリング', value: v.detailedMonitoring ? '有効' : '無効' },
          { label: '作成時間', value: formatDate(v.createTime) },
        ]}
      />
      <Container header={<Header variant="h2">ユーザーデータ</Header>}>
        <pre className="code-block" data-testid="lt-user-data">{v.userData || '-'}</pre>
      </Container>
    </SpaceBetween>
  );
}

export function CreateLaunchTemplate() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [ami, setAmi] = useState(AMIS[0].imageId);
  const [type, setType] = useState('t3.micro');
  const [key, setKey] = useState(env.keyPairs[0] ?? '');
  const [sgs, setSgs] = useState<string[]>([]);
  const [monitoring, setMonitoring] = useState(true);
  const [userData, setUserData] = useState('');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="起動テンプレートを作成"
      submitText="起動テンプレートを作成"
      submitTestId="lt-submit"
      onCancel={() => navigate('/ec2/launch-templates')}
      error={error}
      onSubmit={() => {
        const r = run((d) => createLaunchTemplate(d, { name, description: desc, imageId: ami, instanceType: type, keyName: key || undefined, securityGroupIds: sgs, userData, detailedMonitoring: monitoring }), `起動テンプレート ${name.trim()} が正常に作成されました`);
        if (r.ok) navigate(`/ec2/launch-templates/${r.value}`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">起動テンプレート名と説明</Header>}>
        <SpaceBetween size="m">
          <FormField label="起動テンプレート名 - 必須"><Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="lt-name" /></FormField>
          <FormField label="テンプレートバージョンの説明"><Input value={desc} onChange={(e) => setDesc(e.detail.value)} /></FormField>
        </SpaceBetween>
      </Container>
      <Container header={<Header variant="h2">起動テンプレートの内容</Header>}>
        <SpaceBetween size="m">
          <FormField label="アプリケーションおよび OS イメージ (Amazon マシンイメージ)">
            <Select selectedOption={{ value: ami, label: AMIS.find((a) => a.imageId === ami)!.name }} options={AMIS.map((a) => ({ value: a.imageId, label: a.name, description: a.imageId }))} onChange={(e) => setAmi(e.detail.selectedOption.value!)} />
          </FormField>
          <FormField label="インスタンスタイプ">
            <Select selectedOption={{ value: type, label: type }} options={INSTANCE_TYPES.map((t) => ({ value: t.type, label: t.type, description: `${t.vcpu} vCPU ${t.memoryGiB} GiB メモリ` }))} onChange={(e) => setType(e.detail.selectedOption.value!)} />
          </FormField>
          <FormField label="キーペア (ログイン)">
            <Select selectedOption={key ? { value: key, label: key } : null} options={env.keyPairs.map((k) => ({ value: k, label: k }))} onChange={(e) => setKey(e.detail.selectedOption.value!)} />
          </FormField>
          <FormField label="セキュリティグループ">
            <Multiselect selectedOptions={env.securityGroups.filter((g) => sgs.includes(g.groupId)).map(sgOption)} options={env.securityGroups.map(sgOption)} onChange={(e) => setSgs(e.detail.selectedOptions.map((o) => o.value!))} placeholder="セキュリティグループを選択" />
          </FormField>
          <Checkbox checked={monitoring} onChange={(e) => setMonitoring(e.detail.checked)} description="1 分間隔でメトリクスを送信します (ターゲット追跡スケーリングに推奨)。">詳細 CloudWatch モニタリング</Checkbox>
          <FormField label="ユーザーデータ" description="起動時に実行するスクリプト。このシミュレーターでは webapp を起動するスクリプトでアプリが動きます。">
            <Textarea value={userData} onChange={(e) => setUserData(e.detail.value)} rows={4} className="code-textarea" />
          </FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- Auto Scaling groups ----------------

const updating = (g: AutoScalingGroup) => liveInstances(g).length !== g.desiredCapacity || g.instances.some((r) => r.lifecycleState === 'Pending' || r.lifecycleState === 'Terminating');

export function AsgList() {
  const env = useEnv();
  const navigate = useNavigate();
  return (
    <ResourceTable
      title="Auto Scaling グループ"
      resourceName="Auto Scaling グループ"
      testId="asg-table"
      items={env.autoScalingGroups}
      trackBy={(g) => g.autoScalingGroupName}
      selectionType="none"
      actions={
        <Hotspot hotspotId="asg-create" direction="right">
          <Button variant="primary" onClick={() => navigate('/ec2/autoscaling/create')} data-testid="create-asg">Auto Scaling グループを作成する</Button>
        </Hotspot>
      }
      columns={[
        { id: 'name', header: '名前', cell: (g) => <ConsoleLink to={asgPath(g.autoScalingGroupName)}>{g.autoScalingGroupName}</ConsoleLink>, value: (g) => g.autoScalingGroupName },
        { id: 'lt', header: '起動テンプレート/設定', cell: (g) => `${env.launchTemplates.find((t) => t.launchTemplateId === g.launchTemplate.launchTemplateId)?.launchTemplateName ?? g.launchTemplate.launchTemplateId} | バージョン ${g.launchTemplate.version === '$Latest' ? 'Latest' : 'Default'}` },
        { id: 'count', header: 'インスタンス', cell: (g) => String(liveInstances(g).length), value: (g) => liveInstances(g).length },
        { id: 'status', header: 'ステータス', cell: (g) => (updating(g) ? <StatusIndicator type="in-progress">容量を更新中</StatusIndicator> : '-') },
        { id: 'desired', header: '希望するキャパシティ', cell: (g) => String(g.desiredCapacity), value: (g) => g.desiredCapacity },
        { id: 'min', header: '最小', cell: (g) => String(g.minSize) },
        { id: 'max', header: '最大', cell: (g) => String(g.maxSize) },
        { id: 'az', header: 'アベイラビリティーゾーン', cell: (g) => [...new Set(g.subnetIds.map((s) => env.subnets.find((x) => x.subnetId === s)?.availabilityZone))].join(', ') },
      ]}
    />
  );
}

export function CreateAsgWizard() {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [ltId, setLtId] = useState(env.launchTemplates[0]?.launchTemplateId ?? '');
  const [version, setVersion] = useState<'$Default' | '$Latest'>('$Default');
  const lt = env.launchTemplates.find((t) => t.launchTemplateId === ltId);
  const ltVpc = env.securityGroups.find((g) => lt && templateVersion(lt, version).securityGroupIds.includes(g.groupId))?.vpcId;
  const [vpcId, setVpcId] = useState(ltVpc ?? env.vpcs.find((v) => !v.isDefault)?.vpcId ?? '');
  const [subnetIds, setSubnetIds] = useState<string[]>([]);
  const [lbMode, setLbMode] = useState<'none' | 'attach'>('none');
  const [tgArn, setTgArn] = useState('');
  const [elbHc, setElbHc] = useState(false);
  const [grace, setGrace] = useState('300');
  const [desired, setDesired] = useState('1');
  const [min, setMin] = useState('1');
  const [max, setMax] = useState('1');
  const [scaling, setScaling] = useState<'none' | 'target'>('none');
  const [policyName, setPolicyName] = useState('Target Tracking Policy');
  const [metric, setMetric] = useState<TargetTrackingPolicy['metric']>('ASGAverageCPUUtilization');
  const [target, setTarget] = useState('50');
  const [error, setError] = useState<AwsError | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const err = problem ?? errorText(error);
  const subnets = env.subnets.filter((s) => s.vpcId === vpcId);
  const tgs = env.targetGroups.filter((t) => t.vpcId === vpcId);
  const check = (to: number) => {
    if (to >= 1 && (!name.trim() || !lt)) return 'Auto Scaling グループ名と起動テンプレートを指定してください。';
    if (to >= 2 && !subnetIds.length) return 'サブネットを 1 つ以上選択してください。';
    if (to >= 3 && lbMode === 'attach' && !tgArn) return 'ターゲットグループを選択してください。';
    return null;
  };
  return (
    <div data-testid="create-asg-wizard">
      <Wizard
        activeStepIndex={step}
        onNavigate={(e) => {
          const p = e.detail.requestedStepIndex > step ? check(e.detail.requestedStepIndex) : null;
          setProblem(p);
          if (!p) setStep(e.detail.requestedStepIndex);
        }}
        onCancel={() => navigate('/ec2/autoscaling')}
        onSubmit={() => {
          const r = run((d) => {
            const n = createAutoScalingGroup(d, { name, launchTemplateId: ltId, version, minSize: Number(min), maxSize: Number(max), desiredCapacity: Number(desired), subnetIds, targetGroupArns: lbMode === 'attach' && tgArn ? [tgArn] : [], healthCheckType: elbHc ? 'ELB' : 'EC2', healthCheckGracePeriod: Number(grace) || 0 });
            if (scaling === 'target') putTargetTrackingPolicy(d, n, { policyName, metric, targetValue: Number(target) });
            return n;
          }, `Auto Scaling グループ ${name.trim()} が作成されました`);
          if (r.ok) navigate(asgPath(r.value));
          else setError(r.error);
        }}
        i18nStrings={{ stepNumberLabel: (n) => `ステップ ${n}`, collapsedStepsLabel: (n, t) => `ステップ ${n}/${t}`, navigationAriaLabel: 'ステップ', cancelButton: 'キャンセル', previousButton: '前へ', nextButton: '次へ', submitButton: 'Auto Scaling グループを作成', optional: 'オプション' }}
        submitButtonText="Auto Scaling グループを作成"
        steps={[
          {
            title: '起動テンプレートまたは設定を選択',
            errorText: err,
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">名前</Header>}>
                  <FormField label="Auto Scaling グループ名" constraintText="このアカウントの現在のリージョン内で一意である必要があります。">
                    <Input value={name} onChange={(e) => setName(e.detail.value)} data-testid="asg-name" />
                  </FormField>
                </Container>
                <Container header={<Header variant="h2">起動テンプレート</Header>}>
                  <SpaceBetween size="m">
                    <FormField label="起動テンプレート">
                      <Select selectedOption={lt ? { value: lt.launchTemplateId, label: lt.launchTemplateName } : null} options={env.launchTemplates.map((t) => ({ value: t.launchTemplateId, label: t.launchTemplateName, description: t.launchTemplateId }))} onChange={(e) => setLtId(e.detail.selectedOption.value!)} data-testid="asg-lt" />
                    </FormField>
                    <FormField label="バージョン">
                      <Select selectedOption={{ value: version, label: version === '$Default' ? 'Default (1)' : 'Latest' }} options={[{ value: '$Default', label: 'Default' }, { value: '$Latest', label: 'Latest' }]} onChange={(e) => setVersion(e.detail.selectedOption.value as typeof version)} />
                    </FormField>
                    {lt && (
                      <ColumnLayout columns={3} variant="text-grid">
                        <div><Box variant="awsui-key-label">AMI ID</Box>{templateVersion(lt, version).imageId}</div>
                        <div><Box variant="awsui-key-label">インスタンスタイプ</Box>{templateVersion(lt, version).instanceType}</div>
                        <div><Box variant="awsui-key-label">セキュリティグループ</Box>{templateVersion(lt, version).securityGroupIds.map((g) => env.securityGroups.find((x) => x.groupId === g)?.groupName ?? g).join(', ')}</div>
                      </ColumnLayout>
                    )}
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ),
          },
          {
            title: 'インスタンス起動オプションを選択',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">ネットワーク</Header>}>
                <SpaceBetween size="m">
                  <FormField label="VPC">
                    <Select selectedOption={vpcId ? vpcOption(env.vpcs.find((v) => v.vpcId === vpcId)!) : null} options={env.vpcs.map(vpcOption)} onChange={(e) => { setVpcId(e.detail.selectedOption.value!); setSubnetIds([]); setTgArn(''); }} data-testid="asg-vpc" />
                  </FormField>
                  <FormField label="アベイラビリティーゾーンとサブネット" description="複数の AZ のサブネットを選ぶと、Auto Scaling はインスタンスを AZ 間で均等に配置します。">
                    <Multiselect
                      selectedOptions={subnets.filter((s) => subnetIds.includes(s.subnetId)).map((s) => ({ value: s.subnetId, label: `${s.availabilityZone} | ${s.subnetId} (${nameOf(s)})`, description: s.cidrBlock }))}
                      options={subnets.map((s) => ({ value: s.subnetId, label: `${s.availabilityZone} | ${s.subnetId} (${nameOf(s)})`, description: s.cidrBlock }))}
                      onChange={(e) => setSubnetIds(e.detail.selectedOptions.map((o) => o.value!))}
                      placeholder="サブネットを選択"
                      data-testid="asg-subnets"
                    />
                  </FormField>
                </SpaceBetween>
              </Container>
            ),
          },
          {
            title: '詳細オプションを設定',
            isOptional: true,
            errorText: err,
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">ロードバランシング</Header>}>
                  <SpaceBetween size="m">
                    <RadioGroup value={lbMode} onChange={(e) => setLbMode(e.detail.value as typeof lbMode)} items={[{ value: 'none', label: 'ロードバランサーがありません' }, { value: 'attach', label: '既存のロードバランサーにアタッチする' }]} data-testid="asg-lb-mode" />
                    {lbMode === 'attach' && (
                      <FormField label="既存のロードバランサーターゲットグループ">
                        <Select selectedOption={tgArn ? { value: tgArn, label: tgs.find((t) => t.targetGroupArn === tgArn)?.targetGroupName } : null} options={tgs.map((t) => ({ value: t.targetGroupArn, label: t.targetGroupName, description: `HTTP:${t.port}` }))} onChange={(e) => setTgArn(e.detail.selectedOption.value!)} placeholder="ターゲットグループを選択" data-testid="asg-tg" />
                      </FormField>
                    )}
                  </SpaceBetween>
                </Container>
                <Container header={<Header variant="h2">ヘルスチェック</Header>}>
                  <SpaceBetween size="m">
                    <Checkbox checked={elbHc} onChange={(e) => setElbHc(e.detail.checked)} description="EC2 のステータスチェックに加えて、ロードバランサーのヘルスチェックで異常なインスタンスも置き換えます。" data-testid="asg-elb-hc">
                      Elastic Load Balancing のヘルスチェックをオンにする
                    </Checkbox>
                    <FormField label="ヘルスチェックの猶予期間" description="起動したインスタンスのヘルスチェックを開始するまでの秒数。">
                      <Input value={grace} onChange={(e) => setGrace(e.detail.value)} type="number" />
                    </FormField>
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ),
          },
          {
            title: 'グループサイズとスケーリングを設定',
            isOptional: true,
            errorText: err,
            content: (
              <SpaceBetween size="l">
                <Container header={<Header variant="h2">グループサイズ</Header>}>
                  <ColumnLayout columns={3}>
                    <FormField label="希望するキャパシティ"><Input value={desired} onChange={(e) => setDesired(e.detail.value)} type="number" data-testid="asg-desired" /></FormField>
                    <FormField label="希望する最小キャパシティ"><Input value={min} onChange={(e) => setMin(e.detail.value)} type="number" data-testid="asg-min" /></FormField>
                    <FormField label="希望する最大キャパシティ"><Input value={max} onChange={(e) => setMax(e.detail.value)} type="number" data-testid="asg-max" /></FormField>
                  </ColumnLayout>
                </Container>
                <Container header={<Header variant="h2">自動スケーリング - オプション</Header>}>
                  <SpaceBetween size="m">
                    <RadioGroup value={scaling} onChange={(e) => setScaling(e.detail.value as typeof scaling)} items={[{ value: 'none', label: 'スケーリングポリシーなし' }, { value: 'target', label: 'ターゲット追跡スケーリングポリシー' }]} data-testid="asg-scaling" />
                    {scaling === 'target' && <PolicyFields name={policyName} setName={setPolicyName} metric={metric} setMetric={setMetric} target={target} setTarget={setTarget} />}
                  </SpaceBetween>
                </Container>
              </SpaceBetween>
            ),
          },
          {
            title: '確認',
            errorText: err,
            content: (
              <Container header={<Header variant="h2">確認</Header>}>
                <ColumnLayout columns={3} variant="text-grid">
                  <div><Box variant="awsui-key-label">名前</Box>{name || '-'}</div>
                  <div><Box variant="awsui-key-label">起動テンプレート</Box>{lt?.launchTemplateName ?? '-'}</div>
                  <div><Box variant="awsui-key-label">サブネット</Box>{subnetIds.length} 個</div>
                  <div><Box variant="awsui-key-label">ターゲットグループ</Box>{lbMode === 'attach' ? (tgs.find((t) => t.targetGroupArn === tgArn)?.targetGroupName ?? '-') : 'なし'}</div>
                  <div><Box variant="awsui-key-label">ヘルスチェック</Box>{elbHc ? 'EC2, ELB' : 'EC2'}</div>
                  <div><Box variant="awsui-key-label">希望 / 最小 / 最大</Box>{`${desired} / ${min} / ${max}`}</div>
                  <div><Box variant="awsui-key-label">スケーリング</Box>{scaling === 'target' ? `${METRIC_LABEL[metric]} を ${target} に維持` : 'なし'}</div>
                </ColumnLayout>
              </Container>
            ),
          },
        ]}
      />
    </div>
  );
}

function PolicyFields(p: { name: string; setName: (v: string) => void; metric: TargetTrackingPolicy['metric']; setMetric: (v: TargetTrackingPolicy['metric']) => void; target: string; setTarget: (v: string) => void }) {
  return (
    <SpaceBetween size="m">
      <FormField label="スケーリングポリシー名"><Input value={p.name} onChange={(e) => p.setName(e.detail.value)} data-testid="policy-name" /></FormField>
      <FormField label="メトリクスタイプ" description="メトリクスがターゲット値に近づくように、インスタンスを増減します。">
        <Select selectedOption={{ value: p.metric, label: METRIC_LABEL[p.metric] }} options={Object.entries(METRIC_LABEL).map(([value, l]) => ({ value, label: l }))} onChange={(e) => p.setMetric(e.detail.selectedOption.value as TargetTrackingPolicy['metric'])} data-testid="policy-metric" />
      </FormField>
      <FormField label="ターゲット値" description={p.metric === 'ASGAverageCPUUtilization' ? 'CPU 使用率 (%)' : '1 分あたりのターゲットあたりリクエスト数'}>
        <Input value={p.target} onChange={(e) => p.setTarget(e.detail.value)} type="number" data-testid="policy-target" />
      </FormField>
    </SpaceBetween>
  );
}

export function AsgDetail({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [deleting, setDeleting] = useState(false);
  const g = env.autoScalingGroups.find((x) => x.autoScalingGroupName === name);
  if (!g) return <NotFound what="Auto Scaling グループ" id={name} />;
  const lt = env.launchTemplates.find((t) => t.launchTemplateId === g.launchTemplate.launchTemplateId);
  const ids = new Set(g.instances.map((r) => r.instanceId));
  return (
    <SpaceBetween size="l">
      <Header variant="h1" actions={<Button onClick={() => setDeleting(true)} data-testid="asg-delete">削除</Button>}>{name}</Header>
      {deleting && (
        <DeleteModal
          header="Auto Scaling グループを削除"
          testId="delete-asg"
          onClose={() => setDeleting(false)}
          onDelete={() => {
            const r = run((d) => deleteAutoScalingGroup(d, name), `Auto Scaling グループ ${name} を削除しました`);
            if (r.ok) navigate('/ec2/autoscaling');
            return r;
          }}
        >
          <Box>{name} を削除しますか? グループが管理している {liveInstances(g).length} 台のインスタンスも終了されます。</Box>
        </DeleteModal>
      )}
      <Container header={<Header variant="h2" actions={<Button onClick={() => navigate(`${asgPath(name)}/edit`)} data-testid="asg-edit">編集</Button>}>グループの詳細</Header>}>
        <ColumnLayout columns={4} variant="text-grid">
          <div data-testid="asg-desired-value"><Box variant="awsui-key-label">希望するキャパシティ</Box>{g.desiredCapacity}</div>
          <div><Box variant="awsui-key-label">最小キャパシティ</Box>{g.minSize}</div>
          <div><Box variant="awsui-key-label">最大キャパシティ</Box>{g.maxSize}</div>
          <div><Box variant="awsui-key-label">ステータス</Box>{updating(g) ? <StatusIndicator type="in-progress">容量を更新中</StatusIndicator> : '-'}</div>
          <div><Box variant="awsui-key-label">起動テンプレート</Box>{lt ? <ConsoleLink to={`/ec2/launch-templates/${lt.launchTemplateId}`}>{lt.launchTemplateName}</ConsoleLink> : '-'}</div>
          <div><Box variant="awsui-key-label">ヘルスチェックのタイプ</Box>{g.healthCheckType === 'ELB' ? 'EC2, ELB' : 'EC2'}</div>
          <div><Box variant="awsui-key-label">作成時刻</Box>{formatDate(g.createdTime)}</div>
          <div><Box variant="awsui-key-label">Auto Scaling グループ ARN</Box><CopyableValue value={g.autoScalingGroupARN} iconOnly /></div>
        </ColumnLayout>
      </Container>
      <ResourceTabs
        tabs={[
          {
            id: 'activity',
            label: 'アクティビティ',
            content: (
              <Table
                variant="container"
                data-testid="asg-activity"
                wrapLines
                header={<Header counter={`(${g.activities.length})`}>アクティビティ履歴</Header>}
                items={g.activities}
                empty="アクティビティはありません"
                columnDefinitions={[
                  { id: 'status', header: 'ステータス', cell: () => <StatusIndicator type="success">成功</StatusIndicator>, width: 110 },
                  { id: 'desc', header: '説明', cell: (a) => a.description },
                  { id: 'cause', header: '原因', cell: (a) => <Box variant="small">{a.cause}</Box> },
                  { id: 'time', header: '開始時刻', cell: (a) => formatDate(a.startTime), width: 220 },
                ]}
              />
            ),
          },
          {
            id: 'scaling',
            label: '自動スケーリング',
            content: (
              <Table
                variant="container"
                data-testid="asg-policies"
                header={
                  <Header counter={`(${g.policies.length})`} actions={<Hotspot hotspotId="asg-create-policy" direction="right"><Button onClick={() => navigate(`${asgPath(name)}/create-policy`)} data-testid="create-policy">動的スケーリングポリシーを作成</Button></Hotspot>}>
                    動的スケーリングポリシー
                  </Header>
                }
                items={g.policies}
                empty="ポリシーはありません"
                columnDefinitions={[
                  { id: 'name', header: 'ポリシー名', cell: (p) => p.policyName },
                  { id: 'type', header: 'ポリシータイプ', cell: () => 'ターゲット追跡スケーリング' },
                  { id: 'cond', header: '実行するアクション', cell: (p) => `${METRIC_LABEL[p.metric]} を ${p.targetValue} に維持するため、必要に応じてキャパシティユニットを追加または削除する` },
                  { id: 'actions', header: '', cell: (p) => <Button variant="inline-link" onClick={() => run((d) => deletePolicy(d, name, p.policyName), `ポリシー ${p.policyName} を削除しました`)}>削除</Button> },
                ]}
              />
            ),
          },
          {
            id: 'instances',
            label: 'インスタンス管理',
            content: (
              <Table
                variant="container"
                data-testid="asg-instances"
                header={<Header counter={`(${liveInstances(g).length})`}>インスタンス</Header>}
                items={g.instances.filter((r) => r.lifecycleState !== 'Terminated')}
                empty="インスタンスはありません"
                columnDefinitions={[
                  { id: 'id', header: 'インスタンス ID', cell: (r) => <ConsoleLink to={`/ec2/instances/${r.instanceId}`}>{r.instanceId}</ConsoleLink> },
                  { id: 'life', header: 'ライフサイクル', cell: (r) => LIFECYCLE[r.lifecycleState] },
                  { id: 'health', header: 'ヘルスステータス', cell: (r) => <StatusIndicator type={r.healthStatus === 'Healthy' ? 'success' : 'error'}>{r.healthStatus}</StatusIndicator> },
                  { id: 'state', header: 'インスタンスの状態', cell: (r) => { const i = env.instances.find((x) => x.instanceId === r.instanceId); return i ? <ResourceStatus state={i.state} /> : '-'; } },
                  { id: 'az', header: 'アベイラビリティーゾーン', cell: (r) => r.availabilityZone },
                  { id: 'lt', header: '起動テンプレート/設定', cell: (r) => `${lt?.launchTemplateName ?? '-'} | バージョン ${r.launchTemplateVersion}` },
                ]}
              />
            ),
          },
          {
            id: 'monitoring',
            label: 'モニタリング',
            content: <MonitoringCharts columns={3} metrics={[asgCpuMetric(name), metricFor('AWS/AutoScaling', 'GroupInServiceInstances', name), metricFor('AWS/AutoScaling', 'GroupDesiredCapacity', name)]} />,
          },
        ]}
      />
      <Box variant="small" color="text-body-secondary">{`管理中のインスタンス: ${[...ids].length} 台 (終了したものを含む過去 24 時間)`}</Box>
    </SpaceBetween>
  );
}

const subnetLabel = (s: { availabilityZone: string; subnetId: string; cidrBlock: string; tags: { key: string; value: string }[] }) => ({ value: s.subnetId, label: `${s.availabilityZone} | ${s.subnetId} (${nameOf(s)})`, description: s.cidrBlock });

/** "Auto Scaling グループを編集": size, launch template version, subnets, target groups and health checks. */
export function EditAsg({ name }: { name: string }) {
  const env = useEnv();
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const g = env.autoScalingGroups.find((x) => x.autoScalingGroupName === name);
  const [desired, setDesired] = useState(String(g?.desiredCapacity ?? 1));
  const [min, setMin] = useState(String(g?.minSize ?? 1));
  const [max, setMax] = useState(String(g?.maxSize ?? 1));
  const [version, setVersion] = useState<'$Default' | '$Latest'>(g?.launchTemplate.version ?? '$Default');
  const [subnetIds, setSubnetIds] = useState(g?.subnetIds ?? []);
  const [tgArns, setTgArns] = useState(g?.targetGroupArns ?? []);
  const [elbHc, setElbHc] = useState(g?.healthCheckType === 'ELB');
  const [grace, setGrace] = useState(String(g?.healthCheckGracePeriod ?? 300));
  const [error, setError] = useState<AwsError | null>(null);
  if (!g) return <NotFound what="Auto Scaling グループ" id={name} />;
  const vpcId = env.subnets.find((x) => x.subnetId === g.subnetIds[0])?.vpcId;
  const subnets = env.subnets.filter((x) => x.vpcId === vpcId);
  const tgs = env.targetGroups.filter((t) => t.vpcId === vpcId);
  const tgOption = (t: (typeof tgs)[number]) => ({ value: t.targetGroupArn, label: t.targetGroupName, description: `HTTP:${t.port}` });
  return (
    <EditForm
      title={`${name} を編集`}
      submitText="更新"
      submitTestId="asg-update"
      onCancel={() => navigate(asgPath(name))}
      error={error}
      onSubmit={() => {
        const r = run((d) => updateAutoScalingGroup(d, name, { minSize: Number(min), maxSize: Number(max), desiredCapacity: Number(desired), version, subnetIds, targetGroupArns: tgArns, healthCheckType: elbHc ? 'ELB' : 'EC2', healthCheckGracePeriod: Number(grace) }), `Auto Scaling グループ ${name} が更新されました`);
        if (r.ok) navigate(`${asgPath(name)}?tab=activity`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">グループサイズ</Header>}>
        <ColumnLayout columns={3}>
          <FormField label="希望するキャパシティ"><Input value={desired} onChange={(e) => setDesired(e.detail.value)} type="number" data-testid="edit-desired" /></FormField>
          <FormField label="最小キャパシティ"><Input value={min} onChange={(e) => setMin(e.detail.value)} type="number" data-testid="edit-min" /></FormField>
          <FormField label="最大キャパシティ"><Input value={max} onChange={(e) => setMax(e.detail.value)} type="number" data-testid="edit-max" /></FormField>
        </ColumnLayout>
      </Container>
      <Container header={<Header variant="h2">起動テンプレート</Header>}>
        <FormField label="バージョン" description="変更後に起動するインスタンスから、このバージョンが使われます。">
          <Select selectedOption={{ value: version, label: version === '$Default' ? 'Default' : 'Latest' }} options={[{ value: '$Default', label: 'Default' }, { value: '$Latest', label: 'Latest' }]} onChange={(e) => setVersion(e.detail.selectedOption.value as typeof version)} data-testid="edit-version" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">ネットワーク</Header>}>
        <FormField label="アベイラビリティーゾーンとサブネット" description="変更後に起動するインスタンスから、新しいサブネットに配置されます。">
          <Multiselect selectedOptions={subnets.filter((x) => subnetIds.includes(x.subnetId)).map(subnetLabel)} options={subnets.map(subnetLabel)} onChange={(e) => setSubnetIds(e.detail.selectedOptions.map((o) => o.value!))} placeholder="サブネットを選択" data-testid="edit-subnets" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">ロードバランシング</Header>}>
        <FormField label="ロードバランサーのターゲットグループ" description="追加したターゲットグループには、実行中のインスタンスが登録されます。外したターゲットグループからは登録解除されます。">
          <Multiselect selectedOptions={tgs.filter((t) => tgArns.includes(t.targetGroupArn)).map(tgOption)} options={tgs.map(tgOption)} onChange={(e) => setTgArns(e.detail.selectedOptions.map((o) => o.value!))} placeholder="ターゲットグループを選択" data-testid="edit-tgs" />
        </FormField>
      </Container>
      <Container header={<Header variant="h2">ヘルスチェック</Header>}>
        <SpaceBetween size="m">
          <Checkbox checked={elbHc} onChange={(e) => setElbHc(e.detail.checked)} description="EC2 のステータスチェックに加えて、ロードバランサーのヘルスチェックで異常なインスタンスも置き換えます。" data-testid="edit-elb-hc">
            Elastic Load Balancing のヘルスチェックをオンにする
          </Checkbox>
          <FormField label="ヘルスチェックの猶予期間 (秒)"><Input value={grace} onChange={(e) => setGrace(e.detail.value)} type="number" data-testid="edit-grace" /></FormField>
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

export function CreatePolicy({ name }: { name: string }) {
  const navigate = useNavigate();
  const run = useConsole((s) => s.run);
  const [policyName, setPolicyName] = useState('Target Tracking Policy');
  const [metric, setMetric] = useState<TargetTrackingPolicy['metric']>('ASGAverageCPUUtilization');
  const [target, setTarget] = useState('50');
  const [error, setError] = useState<AwsError | null>(null);
  return (
    <EditForm
      title="動的スケーリングポリシーを作成"
      submitText="作成"
      submitTestId="policy-submit"
      submitHotspotId="asg-policy-submit"
      onCancel={() => navigate(`${asgPath(name)}?tab=scaling`)}
      error={error}
      onSubmit={() => {
        const r = run((d) => putTargetTrackingPolicy(d, name, { policyName, metric, targetValue: Number(target) }), `スケーリングポリシー ${policyName.trim()} が作成されました`);
        if (r.ok) navigate(`${asgPath(name)}?tab=scaling`);
        else setError(r.error);
      }}
    >
      <Container header={<Header variant="h2">ポリシー</Header>}>
        <SpaceBetween size="m">
          <FormField label="ポリシータイプ">
            <Select selectedOption={{ value: 'target', label: 'ターゲット追跡スケーリング' }} options={[{ value: 'target', label: 'ターゲット追跡スケーリング' }, { value: 'step', label: 'ステップスケーリング', disabled: true, description: 'このシミュレーターでは未提供' }]} onChange={() => undefined} />
          </FormField>
          <PolicyFields name={policyName} setName={setPolicyName} metric={metric} setMetric={setMetric} target={target} setTarget={setTarget} />
        </SpaceBetween>
      </Container>
    </EditForm>
  );
}

// ---------------- the simulator's load generator (lesson panel tab) ----------------

const LOADS = [
  { id: 'normal', text: '通常', rps: undefined },
  { id: '100', text: '100 req/s', rps: 100 },
  { id: '500', text: '500 req/s', rps: 500 },
  { id: '1000', text: '1000 req/s', rps: 1000 },
];

export function LoadTestPanel() {
  const env = useEnv();
  const run = useConsole((s) => s.run);
  const now = useNow(5000);
  const g = env.autoScalingGroups[0];
  const current = env.traffic?.[env.traffic.length - 1]?.rps;
  const selected = LOADS.find((l) => l.rps === current)?.id ?? 'normal';
  const start = now - 5 * 60_000;
  const series = loadTestSeries(env, g, start, now, 5000);
  const last = series[series.length - 1];
  const graph = (label: string, key: 'rps' | 'inService' | 'cpu', unit?: 'Percent' | 'Count') => (
    <Graph series={[{ label, data: series.filter((p) => p[key] !== undefined).map((p) => ({ t: p.t, v: p[key]! })) }]} start={start} end={now} unit={unit} height={110} />
  );
  return (
    <SpaceBetween size="m">
      <Box variant="small" color="text-body-secondary">シミュレーターの負荷発生ツールです (AWS の機能ではありません)。web-alb へのリクエスト数を変えて、Auto Scaling の動きを観察します。</Box>
      <SegmentedControl label="リクエスト/秒" selectedId={selected} onChange={(e) => run((d) => setTraffic(d, LOADS.find((l) => l.id === e.detail.selectedId)!.rps, Date.now()))} options={LOADS.map((l) => ({ id: l.id, text: l.text }))} data-testid="load-select" />
      <ColumnLayout columns={3} variant="text-grid">
        <div><Box variant="awsui-key-label">リクエスト</Box><span data-testid="load-rps">{`${Math.round(last?.rps ?? 0)} req/s`}</span></div>
        <div><Box variant="awsui-key-label">InService</Box><span data-testid="load-instances">{g ? `${last?.inService ?? 0} 台 (希望 ${g.desiredCapacity})` : '-'}</span></div>
        <div><Box variant="awsui-key-label">平均 CPU</Box><span data-testid="load-cpu">{last?.cpu !== undefined ? `${last.cpu.toFixed(1)} %` : '-'}</span></div>
      </ColumnLayout>
      <Container header={<Header variant="h3">リクエスト (req/s)</Header>}>{graph('リクエスト', 'rps')}</Container>
      {g && <Container header={<Header variant="h3">{`InService のインスタンス数 (${g.autoScalingGroupName})`}</Header>}>{graph('インスタンス', 'inService', 'Count')}</Container>}
      {g && <Container header={<Header variant="h3">平均 CPU 使用率 (%)</Header>}>{graph('CPU', 'cpu', 'Percent')}</Container>}
    </SpaceBetween>
  );
}
