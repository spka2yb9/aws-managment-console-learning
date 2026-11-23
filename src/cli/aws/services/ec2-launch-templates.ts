/* aws ec2 — 起動テンプレート (Auto Scaling グループが起動する中身の設計図) */
import { createLaunchTemplate, getLaunchTemplate } from '../../../sim/autoscaling';
import { trail } from '../../../sim/cloudtrail';
import { getSg } from '../../../sim/env';
import { AMIS } from '../../../sim/ec2';
import type { AwsEnv, LaunchTemplate, LaunchTemplateVersion } from '../../../sim/types';
import { applyFilters, AwsError, iso, list, service, str, strs, struct, type OpContext, type OperationSpec } from '../types';

/** ユーザーデータは API では Base64 (run-instances と違い、起動テンプレートでは CLI が自動で変換しない) */
const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
function fromBase64(s: string): string {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
  } catch {
    throw new AwsError('InvalidUserData.Malformed', 'Invalid BASE64 encoding of user data.');
  }
}

const createdBy = (env: AwsEnv) => `arn:aws:iam::${env.accountId}:user/learner`;

const templateOut = (env: AwsEnv, t: LaunchTemplate) => ({
  LaunchTemplateId: t.launchTemplateId,
  LaunchTemplateName: t.launchTemplateName,
  CreateTime: iso(t.createTime),
  CreatedBy: createdBy(env),
  DefaultVersionNumber: t.defaultVersionNumber,
  LatestVersionNumber: t.latestVersionNumber,
});

const versionOut = (env: AwsEnv, t: LaunchTemplate, v: LaunchTemplateVersion) => ({
  LaunchTemplateId: t.launchTemplateId,
  LaunchTemplateName: t.launchTemplateName,
  VersionNumber: v.versionNumber,
  ...(v.versionDescription ? { VersionDescription: v.versionDescription } : {}),
  CreateTime: iso(v.createTime),
  CreatedBy: createdBy(env),
  DefaultVersion: v.versionNumber === t.defaultVersionNumber,
  LaunchTemplateData: {
    ImageId: v.imageId,
    InstanceType: v.instanceType,
    ...(v.keyName ? { KeyName: v.keyName } : {}),
    Monitoring: { Enabled: v.detailedMonitoring },
    SecurityGroupIds: v.securityGroupIds,
    ...(v.userData ? { UserData: toBase64(v.userData) } : {}),
  },
});

/** --launch-template-id か --launch-template-name で 1 つ */
function pick(ctx: OpContext): LaunchTemplate {
  const id = str(ctx, 'launch-template-id');
  const name = str(ctx, 'launch-template-name');
  if (id) return getLaunchTemplate(ctx.env, id);
  if (!name) throw new AwsError('MissingParameter', 'The request must include either the launch template ID or the launch template name.');
  const t = ctx.env.launchTemplates.find((x) => x.launchTemplateName === name);
  if (!t) throw new AwsError('InvalidLaunchTemplateName.NotFoundException', `The specified launch template, with template name ${name}, does not exist.`);
  return t;
}

/** --launch-template-data (JSON / shorthand) を sim の形に */
function templateData(ctx: OpContext, base?: LaunchTemplateVersion) {
  const d = struct(ctx, 'launch-template-data') ?? {};
  const monitoring = d.Monitoring as { Enabled?: unknown } | undefined;
  return {
    imageId: d.ImageId !== undefined ? String(d.ImageId) : base?.imageId,
    instanceType: d.InstanceType !== undefined ? String(d.InstanceType) : (base?.instanceType ?? 't3.micro'),
    keyName: d.KeyName !== undefined ? String(d.KeyName) : base?.keyName,
    securityGroupIds: d.SecurityGroupIds !== undefined ? list(d.SecurityGroupIds) : (base?.securityGroupIds ?? []),
    userData: d.UserData !== undefined ? fromBase64(String(d.UserData)) : base?.userData,
    detailedMonitoring: monitoring ? monitoring.Enabled === true || monitoring.Enabled === 'true' : (base?.detailedMonitoring ?? false),
  };
}

const ops: OperationSpec[] = [
  {
    name: 'describe-launch-templates',
    desc: '起動テンプレートの一覧',
    params: [
      { name: 'launch-template-ids', type: 'list', desc: 'ID で絞る' },
      { name: 'launch-template-names', type: 'list', desc: '名前で絞る' },
      { name: 'filters', type: 'list', of: 'structure', desc: '例: Name=launch-template-name,Values=webapp-lt' },
    ],
    readOnly: true,
    run(ctx) {
      const ids = strs(ctx, 'launch-template-ids');
      const names = strs(ctx, 'launch-template-names');
      for (const id of ids) getLaunchTemplate(ctx.env, id);
      for (const n of names) if (!ctx.env.launchTemplates.some((t) => t.launchTemplateName === n)) throw new AwsError('InvalidLaunchTemplateName.NotFoundException', 'At least one of the launch templates specified in the request does not exist.');
      const items = ctx.env.launchTemplates.filter((t) => (!ids.length || ids.includes(t.launchTemplateId)) && (!names.length || names.includes(t.launchTemplateName)));
      return { LaunchTemplates: applyFilters(ctx, items, { 'launch-template-name': (t) => t.launchTemplateName, 'create-time': (t) => t.createTime }).map((t) => templateOut(ctx.env, t)) };
    },
  },
  {
    name: 'describe-launch-template-versions',
    desc: '起動テンプレートのバージョンと中身 (AMI・インスタンスタイプ・ユーザーデータ (Base64) など)',
    params: [
      { name: 'launch-template-id', type: 'string', desc: '起動テンプレート ID' },
      { name: 'launch-template-name', type: 'string', desc: '起動テンプレート名' },
      { name: 'versions', type: 'list', desc: "バージョン: 番号、'$Latest'、'$Default'" },
    ],
    readOnly: true,
    examples: ["aws ec2 describe-launch-template-versions --launch-template-name my-template --versions '$Default'"],
    run(ctx) {
      const t = pick(ctx);
      const want = strs(ctx, 'versions');
      const nums = want.map((v) => (v === '$Latest' ? t.latestVersionNumber : v === '$Default' ? t.defaultVersionNumber : Number(v)));
      if (nums.some((n) => !t.versions.some((v) => v.versionNumber === n))) throw new AwsError('InvalidLaunchTemplateId.VersionNotFound', `Could not find launch template version ${want.join(', ')} for launch template ${t.launchTemplateId}.`);
      const versions = t.versions.filter((v) => !nums.length || nums.includes(v.versionNumber)).sort((a, b) => b.versionNumber - a.versionNumber);
      return { LaunchTemplateVersions: versions.map((v) => versionOut(ctx.env, t, v)) };
    },
  },
  {
    name: 'create-launch-template',
    desc: '起動テンプレートを作る (UserData は Base64 で渡す)',
    params: [
      { name: 'launch-template-name', type: 'string', required: true, desc: '名前' },
      { name: 'version-description', type: 'string', desc: 'バージョンの説明' },
      { name: 'launch-template-data', type: 'structure', required: true, desc: 'ImageId / InstanceType / KeyName / SecurityGroupIds / UserData (Base64) / Monitoring={Enabled=true}' },
    ],
    examples: ['aws ec2 create-launch-template --launch-template-name my-template --launch-template-data file://template.json'],
    run(ctx) {
      const d = templateData(ctx);
      if (!d.imageId) throw new AwsError('MissingParameter', 'The request must contain the parameter ImageId (このシミュレーターでは ImageId が必要です)');
      const id = createLaunchTemplate(ctx.env, { name: str(ctx, 'launch-template-name')!, description: str(ctx, 'version-description'), ...d, imageId: d.imageId }, ctx.now);
      return { LaunchTemplate: templateOut(ctx.env, getLaunchTemplate(ctx.env, id)) };
    },
  },
  {
    name: 'create-launch-template-version',
    desc: '起動テンプレートの新しいバージョンを作る (--source-version の中身を引き継いで一部を変える)',
    params: [
      { name: 'launch-template-id', type: 'string', desc: '起動テンプレート ID' },
      { name: 'launch-template-name', type: 'string', desc: '起動テンプレート名' },
      { name: 'source-version', type: 'string', desc: '元にするバージョン (番号、$Latest、$Default)' },
      { name: 'version-description', type: 'string', desc: 'バージョンの説明' },
      { name: 'launch-template-data', type: 'structure', required: true, desc: '変える項目 (create-launch-template と同じ形)' },
    ],
    run(ctx) {
      const t = pick(ctx);
      const sv = str(ctx, 'source-version');
      const base = sv ? t.versions.find((v) => v.versionNumber === (sv === '$Latest' ? t.latestVersionNumber : sv === '$Default' ? t.defaultVersionNumber : Number(sv))) : undefined;
      if (sv && !base) throw new AwsError('InvalidLaunchTemplateId.VersionNotFound', `Could not find launch template version ${sv} for launch template ${t.launchTemplateId}.`);
      const d = templateData(ctx, base);
      if (!d.imageId) throw new AwsError('MissingParameter', 'The request must contain the parameter ImageId (--source-version で元のバージョンを引き継げます)');
      if (!AMIS.some((a) => a.imageId === d.imageId)) throw new AwsError('InvalidAMIID.NotFound', `The image id '[${d.imageId}]' does not exist`);
      d.securityGroupIds.forEach((g) => getSg(ctx.env, g));
      const v: LaunchTemplateVersion = { versionNumber: t.latestVersionNumber + 1, versionDescription: str(ctx, 'version-description'), ...d, imageId: d.imageId, createTime: new Date(ctx.now).toISOString() };
      t.versions.push(v);
      t.latestVersionNumber = v.versionNumber;
      trail(ctx.env, { source: 'ec2', name: 'CreateLaunchTemplateVersion', resources: [['AWS::EC2::LaunchTemplate', t.launchTemplateId]], request: { launchTemplateId: t.launchTemplateId, sourceVersion: sv, launchTemplateData: { imageId: v.imageId, instanceType: v.instanceType } }, response: { launchTemplateVersion: { launchTemplateId: t.launchTemplateId, versionNumber: v.versionNumber } } });
      return { LaunchTemplateVersion: versionOut(ctx.env, t, v) };
    },
  },
];

export default service('ec2', '', ops);
