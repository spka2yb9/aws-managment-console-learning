/* aws ec2 modify-instance-metadata-options — インスタンスメタデータサービス (IMDS) の設定。--http-tokens required で IMDSv2 を必須にする。
   コンソールの「インスタンスメタデータオプションを変更」と同じ sim/ext/credentials.ts の関数を使う */
import { modifyInstanceMetadataOptions } from '../../../sim/ext/credentials';
import { int, req, service, str } from '../types';

export default service('ec2', '', [
  {
    name: 'modify-instance-metadata-options',
    desc: 'インスタンスメタデータサービス (IMDS) の設定を変える (IMDSv2 を必須にする など)',
    params: [
      { name: 'instance-id', type: 'string', required: true, desc: 'インスタンス ID' },
      { name: 'http-tokens', type: 'string', desc: 'optional (IMDSv1 も使える) / required (IMDSv2 のトークンが必須)' },
      { name: 'http-put-response-hop-limit', type: 'integer', desc: 'トークンの PUT の応答が届くホップ数 (1〜64)' },
      { name: 'http-endpoint', type: 'string', desc: 'enabled / disabled (disabled にすると IMDS 自体が使えない)' },
    ],
    examples: ['aws ec2 modify-instance-metadata-options --instance-id i-0123456789abcdef0 --http-tokens required --http-endpoint enabled'],
    run(ctx) {
      const id = req(ctx, 'instance-id');
      const o = modifyInstanceMetadataOptions(ctx.env, id, {
        httpTokens: str(ctx, 'http-tokens') as 'optional' | 'required' | undefined,
        httpEndpoint: str(ctx, 'http-endpoint') as 'enabled' | 'disabled' | undefined,
        httpPutResponseHopLimit: int(ctx, 'http-put-response-hop-limit'),
      });
      // the change is applied asynchronously: the response says pending, describe-instances says applied
      return { InstanceId: id, InstanceMetadataOptions: { State: 'pending', HttpTokens: o.httpTokens, HttpPutResponseHopLimit: o.httpPutResponseHopLimit, HttpEndpoint: o.httpEndpoint, HttpProtocolIpv6: 'disabled', InstanceMetadataTags: 'disabled' } };
    },
  },
]);
