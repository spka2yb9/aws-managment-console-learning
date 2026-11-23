/* aws ecr — 参照系 (リポジトリと、その中のイメージのタグ・ダイジェスト) */
import type { EcrRepository } from '../../../sim/types';
import { AwsError, iso, service, str, structs, strs, type OpContext, type OperationSpec } from '../types';

const notFound = (ctx: OpContext, name: string) => new AwsError('RepositoryNotFoundException', `The repository with name '${name}' does not exist in the registry with id '${ctx.env.accountId}'`);

const repoOf = (ctx: OpContext): EcrRepository => {
  const name = str(ctx, 'repository-name')!;
  const r = ctx.env.ecrRepositories.find((x) => x.repositoryName === name);
  if (!r) throw notFound(ctx, name);
  return r;
};

/** --image-ids imageTag=v2 / imageDigest=sha256:... で絞る。無いものは ImageNotFoundException (実物は failures に入るが、describe-images はエラーになる) */
function images(ctx: OpContext, r: EcrRepository) {
  const want = structs(ctx, 'image-ids');
  for (const w of want) {
    if (!r.images.some((i) => (w.imageTag ? i.imageTags.includes(String(w.imageTag)) : i.imageDigest === w.imageDigest)))
      throw new AwsError('ImageNotFoundException', `The image with imageId {imageDigest:'${w.imageDigest ?? 'null'}', imageTag:'${w.imageTag ?? 'null'}'} does not exist within the repository with name '${r.repositoryName}' in the registry with id '${ctx.env.accountId}'`);
  }
  const list = want.length ? r.images.filter((i) => want.some((w) => (w.imageTag ? i.imageTags.includes(String(w.imageTag)) : i.imageDigest === w.imageDigest))) : r.images;
  return [...list].sort((a, b) => a.pushedAt - b.pushedAt);
}

const imageIds = { name: 'image-ids', type: 'list', of: 'structure', desc: 'imageTag=v1 / imageDigest=sha256:... で絞る' } as const;

const ops: OperationSpec[] = [
  {
    name: 'describe-repositories',
    desc: 'リポジトリの一覧 (URI)',
    params: [{ name: 'repository-names', type: 'list', desc: 'リポジトリ名で絞る' }],
    readOnly: true,
    run(ctx) {
      const names = strs(ctx, 'repository-names');
      for (const n of names) if (!ctx.env.ecrRepositories.some((r) => r.repositoryName === n)) throw notFound(ctx, n);
      return {
        repositories: ctx.env.ecrRepositories
          .filter((r) => !names.length || names.includes(r.repositoryName))
          .map((r) => ({ repositoryArn: r.repositoryArn, registryId: ctx.env.accountId, repositoryName: r.repositoryName, repositoryUri: r.repositoryUri, createdAt: iso(r.createdAt), imageTagMutability: 'MUTABLE', imageScanningConfiguration: { scanOnPush: false }, encryptionConfiguration: { encryptionType: 'AES256' } })),
      };
    },
  },
  {
    name: 'describe-images',
    desc: 'リポジトリのイメージ (タグ・ダイジェスト・サイズ・プッシュした日時)',
    params: [{ name: 'repository-name', type: 'string', required: true, desc: 'リポジトリ名' }, imageIds],
    readOnly: true,
    examples: ['aws ecr describe-images --repository-name webapp', "aws ecr describe-images --repository-name webapp --query 'imageDetails[].imageTags'"],
    run(ctx) {
      const r = repoOf(ctx);
      return {
        imageDetails: images(ctx, r).map((i) => ({
          registryId: ctx.env.accountId,
          repositoryName: r.repositoryName,
          imageDigest: i.imageDigest,
          ...(i.imageTags.length ? { imageTags: i.imageTags } : {}),
          imageSizeInBytes: i.sizeInBytes,
          imagePushedAt: iso(i.pushedAt),
          imageManifestMediaType: 'application/vnd.docker.distribution.manifest.v2+json',
          artifactMediaType: 'application/vnd.docker.container.image.v1+json',
        })),
      };
    },
  },
  {
    name: 'list-images',
    desc: 'リポジトリのイメージのタグとダイジェストだけを並べる',
    params: [{ name: 'repository-name', type: 'string', required: true, desc: 'リポジトリ名' }],
    readOnly: true,
    run(ctx) {
      const r = repoOf(ctx);
      return { imageIds: images(ctx, r).flatMap((i) => (i.imageTags.length ? i.imageTags.map((t) => ({ imageDigest: i.imageDigest, imageTag: t })) : [{ imageDigest: i.imageDigest }])) };
    },
  },
];

export default service('ecr', 'Amazon ECR (コンテナイメージのリポジトリ)', ops);
