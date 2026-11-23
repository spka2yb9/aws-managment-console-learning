/* aws ec2 — インスタンスの起動・停止・終了、セキュリティグループの付け替え、キーペア、IAM インスタンスプロファイル */
import { trail } from '../../../sim/cloudtrail';
import { getInstance } from '../../../sim/env';
import { modifyInstanceSecurityGroups, rebootInstances, runInstances, startInstances, stopInstances, terminateInstances } from '../../../sim/ec2';
import { setInstanceProfile } from '../../../sim/iam';
import type { AwsEnv, InstanceStateName } from '../../../sim/types';
import { instanceOut } from '../shapes';
import { AwsError, bool, nameFromTagSpecs, req, service, str, strs, struct, type OpContext, type OperationSpec } from '../types';
import { taggable } from './ec2-core';

const STATE_CODE: Record<InstanceStateName, number> = { pending: 0, running: 16, 'shutting-down': 32, terminated: 48, stopping: 64, stopped: 80 };
const state = (s: InstanceStateName) => ({ Code: STATE_CODE[s], Name: s });

function stateChange(key: string, fn: (env: AwsEnv, ids: string[]) => void) {
  return (ctx: OpContext) => {
    const ids = strs(ctx, 'instance-ids');
    if (!ids.length) throw new AwsError('MissingParameter', 'The request must contain the parameter InstanceIds');
    const before = ids.map((id) => getInstance(ctx.env, id).state);
    fn(ctx.env, ids);
    return { [key]: ids.map((id, n) => ({ CurrentState: state(getInstance(ctx.env, id).state), InstanceId: id, PreviousState: state(before[n]) })) };
  };
}

const profileArn = (ctx: OpContext) => {
  const p = struct(ctx, 'iam-instance-profile');
  if (!p) return undefined;
  if (typeof p.Arn !== 'string' && typeof p.Name !== 'string') throw new AwsError('MissingParameter', 'The request must contain the parameter iamInstanceProfile.arn or iamInstanceProfile.name');
  const found = ctx.env.instanceProfiles.find((x) => (p.Arn && x.arn === p.Arn) || (p.Name && x.instanceProfileName === p.Name));
  if (!found) throw new AwsError('InvalidParameterValue', `Value (${String(p.Arn ?? p.Name)}) for parameter iamInstanceProfile.${p.Arn ? 'arn' : 'name'} is invalid. Invalid IAM Instance Profile ${p.Arn ? 'ARN' : 'name'}`);
  return found.arn;
};

const assocId = (instanceId: string) => `iip-assoc-${instanceId.slice(2)}`;
const assocOut = (env: AwsEnv, instanceId: string, st: string) => {
  const i = getInstance(env, instanceId);
  const p = env.instanceProfiles.find((x) => x.arn === i.iamInstanceProfileArn);
  return { AssociationId: assocId(instanceId), InstanceId: instanceId, IamInstanceProfile: p ? { Arn: p.arn, Id: p.instanceProfileId } : {}, State: st };
};
const byAssoc = (env: AwsEnv, id: string) => {
  const i = env.instances.find((x) => x.iamInstanceProfileArn && assocId(x.instanceId) === id);
  if (!i) throw new AwsError('InvalidAssociationID.NotFound', `An association with ID ${id} does not exist.`);
  return i;
};

const ids = { name: 'instance-ids', type: 'list' as const, required: true, desc: 'インスタンス ID (複数可)' };

const ops: OperationSpec[] = [
  {
    name: 'run-instances',
    desc: 'EC2 インスタンスを起動する',
    params: [
      { name: 'image-id', type: 'string', required: true, desc: 'AMI ID (aws ec2 describe-images で一覧)' },
      { name: 'instance-type', type: 'string', desc: 'インスタンスタイプ (既定 t3.micro)' },
      { name: 'key-name', type: 'string', desc: 'キーペア名' },
      { name: 'subnet-id', type: 'string', desc: 'サブネット ID (省略するとデフォルト VPC)' },
      { name: 'security-group-ids', type: 'list', desc: 'セキュリティグループ ID (省略すると VPC の default)' },
      { name: 'count', type: 'string', desc: '台数 (2 や 1:3)' },
      { name: 'associate-public-ip-address', type: 'boolean', desc: 'パブリック IP を付ける / 付けない (省略するとサブネットの設定どおり)' },
      { name: 'iam-instance-profile', type: 'structure', desc: 'Name=ロール名 か Arn=...' },
      { name: 'tag-specifications', type: 'list', of: 'structure', desc: "'ResourceType=instance,Tags=[{Key=Name,Value=web-1}]'" },
      { name: 'user-data', type: 'string', desc: '(このシミュレーターでは無視)' },
    ],
    examples: ["aws ec2 run-instances --image-id ami-0d52744d6551d851e --instance-type t3.micro --subnet-id subnet-0123456789abcdef0 --security-group-ids sg-0123456789abcdef0 --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=web-3}]'"],
    run(ctx) {
      const def = ctx.env.vpcs.find((v) => v.isDefault);
      const subnetId = str(ctx, 'subnet-id') ?? ctx.env.subnets.find((s) => s.vpcId === def?.vpcId)?.subnetId;
      if (!subnetId) throw new AwsError('VPCIdNotSpecified', 'No default VPC for this user. GroupName is only supported for EC2-Classic and default VPC.');
      const subnet = ctx.env.subnets.find((s) => s.subnetId === subnetId);
      const sgs = strs(ctx, 'security-group-ids');
      const groups = sgs.length ? sgs : ctx.env.securityGroups.filter((g) => g.vpcId === subnet?.vpcId && g.groupName === 'default').map((g) => g.groupId);
      const count = Number((str(ctx, 'count') ?? '1').split(':')[0]) || 1;
      const arn = profileArn(ctx);
      const created = runInstances(ctx.env, { name: nameFromTagSpecs(ctx, 'instance'), imageId: req(ctx, 'image-id'), instanceType: str(ctx, 'instance-type') ?? 't3.micro', keyName: str(ctx, 'key-name'), subnetId, securityGroupIds: groups, associatePublicIpAddress: bool(ctx, 'associate-public-ip-address'), count });
      if (arn) for (const id of created) setInstanceProfile(ctx.env, id, arn);
      for (const id of created) {
        const r = taggable(ctx.env, id)!;
        for (const s of [ctx.p['tag-specifications']].flat().filter(Boolean) as Record<string, unknown>[])
          for (const t of [s.Tags].flat().filter(Boolean) as Record<string, unknown>[]) if (t.Key !== 'Name' && (!s.ResourceType || s.ResourceType === 'instance')) r.tags.push({ key: String(t.Key), value: String(t.Value ?? '') });
      }
      return { Groups: [], Instances: created.map((id) => instanceOut(ctx.env, getInstance(ctx.env, id))), OwnerId: ctx.env.accountId, ReservationId: `r-${created[0].slice(2)}` };
    },
  },
  { name: 'start-instances', desc: '停止中のインスタンスを起動する', params: [ids], run: stateChange('StartingInstances', (env, x) => startInstances(env, x)) },
  { name: 'stop-instances', desc: 'インスタンスを停止する', params: [ids], run: stateChange('StoppingInstances', (env, x) => stopInstances(env, x)) },
  { name: 'terminate-instances', desc: 'インスタンスを終了 (削除) する。元には戻せない', params: [ids], run: stateChange('TerminatingInstances', (env, x) => terminateInstances(env, x)) },
  {
    name: 'reboot-instances',
    desc: 'インスタンスを再起動する',
    params: [ids],
    run(ctx) {
      rebootInstances(ctx.env, strs(ctx, 'instance-ids'));
      return undefined;
    },
  },
  {
    name: 'modify-instance-attribute',
    desc: 'インスタンスの属性を変える (このシミュレーターではセキュリティグループの付け替え --groups だけ)',
    params: [
      { name: 'instance-id', type: 'string', required: true, desc: 'インスタンス ID' },
      { name: 'groups', type: 'list', desc: '付けるセキュリティグループ ID (全部を並べる。今付いているものと入れ替わる)' },
    ],
    run(ctx) {
      const groups = strs(ctx, 'groups');
      if (!groups.length) throw new AwsError('MissingParameter', 'このシミュレーターの modify-instance-attribute は --groups だけに対応しています');
      modifyInstanceSecurityGroups(ctx.env, req(ctx, 'instance-id'), groups);
      return undefined;
    },
  },
  {
    name: 'create-key-pair',
    desc: 'キーペアを作成する (秘密鍵は作成時の 1 回しか表示されない)',
    params: [{ name: 'key-name', type: 'string', required: true, desc: 'キーペア名' }],
    run(ctx) {
      const name = req(ctx, 'key-name');
      if (ctx.env.keyPairs.includes(name)) throw new AwsError('InvalidKeyPair.Duplicate', `The keypair already exists`);
      ctx.env.keyPairs.push(name);
      trail(ctx.env, { source: 'ec2', name: 'CreateKeyPair', resources: [], request: { keyName: name }, response: { keyName: name, keyFingerprint: '1f:51:ae:28:bf:89:e9:d8:1f:25:5d:37:2d:7d:b8:ca:9f:f5:f1:6f' } });
      return { KeyFingerprint: '1f:51:ae:28:bf:89:e9:d8:1f:25:5d:37:2d:7d:b8:ca:9f:f5:f1:6f', KeyMaterial: '-----BEGIN RSA PRIVATE KEY-----\n(シミュレーター: 本物の秘密鍵ではありません)\n-----END RSA PRIVATE KEY-----', KeyName: name, KeyPairId: `key-0${name.length.toString(16).padStart(16, 'b')}` };
    },
  },
  {
    name: 'delete-key-pair',
    desc: 'キーペアを削除する',
    params: [{ name: 'key-name', type: 'string', required: true, desc: 'キーペア名' }],
    run(ctx) {
      const name = req(ctx, 'key-name');
      ctx.env.keyPairs = ctx.env.keyPairs.filter((k) => k !== name);
      return { Return: true };
    },
  },
  {
    name: 'associate-iam-instance-profile',
    desc: 'インスタンスに IAM インスタンスプロファイル (ロール) を付ける',
    params: [
      { name: 'instance-id', type: 'string', required: true, desc: 'インスタンス ID' },
      { name: 'iam-instance-profile', type: 'structure', required: true, desc: 'Name=プロファイル名 か Arn=...' },
    ],
    run(ctx) {
      const i = getInstance(ctx.env, req(ctx, 'instance-id'));
      if (i.iamInstanceProfileArn) throw new AwsError('IncorrectState', `There is an existing association for instance ${i.instanceId}`);
      setInstanceProfile(ctx.env, i.instanceId, profileArn(ctx));
      return { IamInstanceProfileAssociation: assocOut(ctx.env, i.instanceId, 'associating') };
    },
  },
  {
    name: 'replace-iam-instance-profile-association',
    desc: 'インスタンスの IAM インスタンスプロファイルを付け替える',
    params: [
      { name: 'association-id', type: 'string', required: true, desc: '関連付け ID (iip-assoc-...)' },
      { name: 'iam-instance-profile', type: 'structure', required: true, desc: 'Name=プロファイル名 か Arn=...' },
    ],
    run(ctx) {
      const i = byAssoc(ctx.env, req(ctx, 'association-id'));
      setInstanceProfile(ctx.env, i.instanceId, profileArn(ctx));
      return { IamInstanceProfileAssociation: assocOut(ctx.env, i.instanceId, 'associating') };
    },
  },
  {
    name: 'disassociate-iam-instance-profile',
    desc: 'インスタンスから IAM インスタンスプロファイルを外す',
    params: [{ name: 'association-id', type: 'string', required: true, desc: '関連付け ID (iip-assoc-...)' }],
    run(ctx) {
      const i = byAssoc(ctx.env, req(ctx, 'association-id'));
      const out = assocOut(ctx.env, i.instanceId, 'disassociating');
      setInstanceProfile(ctx.env, i.instanceId, undefined);
      return { IamInstanceProfileAssociation: out };
    },
  },
  {
    name: 'describe-iam-instance-profile-associations',
    desc: 'インスタンスに付いている IAM インスタンスプロファイルの一覧',
    params: [
      { name: 'association-ids', type: 'list', desc: '関連付け ID で絞る' },
      { name: 'filters', type: 'list', of: 'structure', desc: 'Name=instance-id,Values=i-...' },
    ],
    readOnly: true,
    run(ctx) {
      const want = strs(ctx, 'association-ids');
      const byInstance = [ctx.p.filters].flat().filter(Boolean).flatMap((f) => ((f as Record<string, unknown>).Name === 'instance-id' ? [(f as Record<string, unknown>).Values].flat().map(String) : []));
      return {
        IamInstanceProfileAssociations: ctx.env.instances
          .filter((i) => i.iamInstanceProfileArn && i.state !== 'terminated')
          .filter((i) => (!want.length || want.includes(assocId(i.instanceId))) && (!byInstance.length || byInstance.includes(i.instanceId)))
          .map((i) => assocOut(ctx.env, i.instanceId, 'associated')),
      };
    },
  },
];

export default service('ec2', '', ops);
