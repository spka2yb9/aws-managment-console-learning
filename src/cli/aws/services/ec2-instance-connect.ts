/* aws ec2-instance-connect ssh — コンソール版の「接続」ボタン (EC2 Instance Connect) と同じ条件で、インスタンスのシェルに入る。
   入った後は sim/cli.ts の execCli が 1 行ずつ動かす (exit で戻る) */
import { getInstance } from '../../../sim/env';
import { eicConnectivity } from '../../../sim/network';
import { AwsError } from '../../../sim/types';
import { req, service } from '../types';

export default service('ec2-instance-connect', 'EC2 Instance Connect (インスタンスに SSH で入る)', [
  {
    name: 'ssh',
    desc: 'EC2 Instance Connect でインスタンスに SSH 接続する (exit で戻る)',
    params: [
      { name: 'instance-id', type: 'string', required: true, desc: '接続するインスタンスの ID' },
      { name: 'os-user', type: 'string', desc: 'ログインするユーザー (既定: ec2-user)' },
      { name: 'connection-type', type: 'string', desc: 'direct / eice / auto (このシミュレーターはパブリック IP への direct だけ)' },
    ],
    readOnly: true,
    raw: true,
    examples: ['aws ec2-instance-connect ssh --instance-id i-0123456789abcdef0'],
    run(ctx) {
      const i = getInstance(ctx.env, req(ctx, 'instance-id'));
      if (i.state !== 'running') throw new AwsError('EC2InstanceStateInvalidException', 'Unable to connect to instance because it is not in running state.');
      if (!i.publicIpAddress) throw new AwsError('EC2InstanceStateInvalidException', 'Unable to connect to instance because it does not have a public IPv4 address. (このシミュレーターは EC2 Instance Connect エンドポイントには未対応です)');
      if (!eicConnectivity(ctx.env, i.instanceId).ok)
        return { exitCode: 255, errorCode: 'ConnectTimeout', text: `ssh: connect to host ${i.publicIpAddress} port 22: Connection timed out\n(シミュレーター) EC2 Instance Connect は、このリージョンの EC2_INSTANCE_CONNECT の IP 範囲から TCP 22 で接続します。セキュリティグループ・ネットワーク ACL・ルートを確かめてください` };
      ctx.terminal.connect(i.instanceId);
      return `   ,     #_\n   ~\\_  ####_        Amazon Linux 2023\n  ~~  \\_#####\\\n  ~~     \\###|\n  ~~       \\#/ ___   https://aws.amazon.com/linux/amazon-linux-2023\n   ~~       V~' '->\n    ~~~         /\n      ~~._.   _/\n         _/ _/\n       _/m/'\n(シミュレーター) ${i.instanceId} に接続しました。exit で PC に戻ります。help で使えるコマンドが見られます`;
    },
  },
]);
