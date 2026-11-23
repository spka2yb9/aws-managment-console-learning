/* aws コマンドのサービス・オペレーションの定義の形と、オペレーションを書くための道具。
   オペレーションは src/cli/aws/services/*.ts に書く（registry.ts が自動で読み込む）。 */
import { AwsError, type AwsEnv, type Tag } from '../../sim/types';
import type { Shorthand } from './shorthand';

export type ParamType = 'string' | 'integer' | 'boolean' | 'list' | 'structure' | 'map' | 'timestamp';

export interface ParamSpec {
  /** CLI での名前 (ケバブケース): vpc-id → --vpc-id */
  name: string;
  type: ParamType;
  required?: boolean;
  /** list の要素: 文字列 (既定) か structure (shorthand / JSON) */
  of?: 'string' | 'structure';
  /** --name を書かずに並べる引数 (aws configure get region、aws s3 cp SRC DST) */
  positional?: boolean;
  /** ヘルプに出す説明 (日本語で 1 行) */
  desc?: string;
}

export type ParamValue = string | number | boolean | string[] | Shorthand | Shorthand[] | Record<string, unknown> | unknown[];

export interface OpContext {
  /** 変更系オペレーションでは書き換えてよい下書き (例外を投げれば何も変わらない)。参照系では書き換えないこと */
  env: AwsEnv;
  /** --region / AWS_REGION / ~/.aws/config の region */
  region: string;
  profile: string;
  /** 解析済みのパラメータ (キーは CLI の名前: 'vpc-id') */
  p: Record<string, ParamValue | undefined>;
  now: number;
  /** 学習者の PC のファイル (cwd からの相対パスも可)。無ければ null */
  readLocal(path: string): string | null;
  writeLocal(path: string, content: string): void;
  /** シェルの環境変数 */
  shellEnv: Record<string, string>;
  /** ターミナル側の機能 (EC2 Instance Connect でインスタンスに入る) */
  terminal: { connect(instanceId: string): void };
}

export interface Waiter {
  /** 1 回分の判定。true で待ち終わり。AwsError を投げれば失敗 */
  until(ctx: OpContext): boolean;
  /** 判定の間隔 (ミリ秒。シミュレーターなので実物より短い) と最大回数 */
  delayMs?: number;
  maxAttempts?: number;
}

export interface OperationSpec {
  /** CLI のサブコマンド名: 'create-subnet'。待機は 'wait instance-running' */
  name: string;
  /** API の名前 (エラーメッセージと CloudTrail): 既定は name をパスカルケースにしたもの */
  api?: string;
  desc: string;
  params: ParamSpec[];
  /** 環境を変えない (CloudTrail にも残らない) */
  readOnly?: boolean;
  /** 学習者の PC の中だけで完結する (aws configure など)。API 呼び出しとして記録しない */
  local?: boolean;
  /** 'regional' (既定): レッスンのリージョン以外では空のアカウントに見える / 'global': IAM・S3 のバケット一覧など、リージョンに関係ない */
  scope?: 'regional' | 'global';
  /** 返した文字列 (か RawResult) をそのまま出す (--output / --query は効かない。aws s3 ls など) */
  raw?: boolean;
  /** 待機 (aws ec2 wait ...) */
  waiter?: Waiter;
  /** ヘルプの「例」 */
  examples?: string[];
  /** 応答のオブジェクト (パスカルケースのキー) か、raw なら文字列。何も出さないなら undefined */
  run(ctx: OpContext): unknown;
}

/** raw なオペレーションが失敗を返すとき (exitCode が 0 でなければ標準エラーに出す) */
export interface RawResult {
  text: string;
  exitCode?: number;
  errorCode?: string;
}

export interface ServiceSpec {
  name: string;
  desc: string;
  ops: OperationSpec[];
}

export const service = (name: string, desc: string, ops: OperationSpec[]): ServiceSpec => ({ name, desc, ops });

/** CLI 側の引数の誤り (API を呼ぶ前に CLI が止めるもの)。メッセージをそのまま出し、終了コード 252 になる */
export class ParamError extends Error {}

/**
 * 認可のフック (src/cli/aws/auth/*.ts の default)。API を呼ぶ前に毎回呼ばれ、拒否するなら AwsError を投げる。
 * 既定のプロファイル (IAM ユーザー learner、管理者) では何もしない。IAM Identity Center のプロファイルなどで使う。
 */
export type Authorizer = (a: { ctx: OpContext; service: string; command: string; operation: string; readOnly: boolean; profileConfig: Record<string, string> }) => void;

/* ---- オペレーションを書くための道具 ---- */

export const pascal = (kebab: string) => kebab.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** パラメータを文字列で (無ければ undefined) */
export function str(ctx: OpContext, name: string): string | undefined {
  const v = ctx.p[name];
  return v === undefined ? undefined : Array.isArray(v) ? String(v[0]) : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** 必須の文字列パラメータ */
export function req(ctx: OpContext, name: string): string {
  const v = str(ctx, name);
  if (v === undefined || v === '') throw new AwsError('MissingParameter', `The request must contain the parameter ${pascal(name)}`);
  return v;
}

export function int(ctx: OpContext, name: string): number | undefined {
  const v = ctx.p[name];
  return v === undefined ? undefined : Number(v);
}

export function bool(ctx: OpContext, name: string): boolean | undefined {
  const v = ctx.p[name];
  return v === undefined ? undefined : v === true || v === 'true' || v === 'True';
}

/** 文字列のリスト (--instance-ids i-1 i-2 / i-1,i-2 / '["i-1"]') */
export function strs(ctx: OpContext, name: string): string[] {
  const v = ctx.p[name];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x)));
}

/** structure のリスト (shorthand でも JSON でも、キーはそのまま: Key / Value)。1 つだけ渡されても配列にする */
export function structs(ctx: OpContext, name: string): Record<string, unknown>[] {
  const v = ctx.p[name];
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x));
}

export function struct(ctx: OpContext, name: string): Record<string, unknown> | undefined {
  const v = ctx.p[name];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** shorthand / JSON の値を文字列の配列に (Values=a / Values=a,b / "Values": ["a"]) */
export const list = (v: unknown): string[] => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String));

/** AWS 形式のタグ */
export const tagsOut = (tags: Tag[]) => tags.map((t) => ({ Key: t.key, Value: t.value }));
/** --tags Key=Name,Value=x / --tag-specifications の Tags を sim の形へ */
export const tagsIn = (v: unknown): Tag[] => (Array.isArray(v) ? v : v ? [v] : []).filter((t): t is Record<string, unknown> => !!t && typeof t === 'object').map((t) => ({ key: String(t.Key ?? ''), value: String(t.Value ?? '') }));

/** --tag-specifications 'ResourceType=vpc,Tags=[{Key=Name,Value=x}]' の Name タグ */
export function nameFromTagSpecs(ctx: OpContext, resourceType?: string): string | undefined {
  for (const s of structs(ctx, 'tag-specifications')) {
    if (resourceType && s.ResourceType && s.ResourceType !== resourceType) continue;
    const name = tagsIn(s.Tags).find((t) => t.key === 'Name');
    if (name) return name.value;
  }
  return undefined;
}

/** CLI v2 の日時の書き方 (ISO 8601、UTC) */
export const iso = (t: number | string | undefined) => (t === undefined ? undefined : new Date(t).toISOString().replace(/\.\d{3}Z$/, '+00:00'));

/* ---- EC2 の --filters ----
   fields: フィルター名 → その値 (複数あれば配列)。tag:キー と tag-key はタグから自動で引く。値の * は任意の文字列 */
export type FilterFields<T> = Record<string, (item: T) => string | string[] | boolean | undefined>;

export function applyFilters<T extends object>(ctx: OpContext, items: T[], fields: FilterFields<T>): T[] {
  const raw = structs(ctx, 'filters');
  raw.forEach((f, i) => {
    if (f.Name !== undefined && typeof f.Name !== 'string') throw new ParamError(`Parameter validation failed:\nInvalid type for parameter Filters[${i}].Name, value: ${JSON.stringify(f.Name)}, type: <class 'dict'>, valid types: <class 'str'>`);
    if (list(f.Values).some((v) => v === '[object Object]')) throw new ParamError(`Parameter validation failed:\nInvalid type for parameter Filters[${i}].Values, valid types: <class 'list'> of <class 'str'>`);
  });
  const filters = raw.map((f) => ({ name: String(f.Name ?? ''), values: list(f.Values) }));
  for (const f of filters) {
    if (!f.name.startsWith('tag:') && f.name !== 'tag-key' && !(f.name in fields)) throw new AwsError('InvalidParameterValue', `The filter '${f.name}' is invalid`);
  }
  const match = (want: string, got: string) => new RegExp(`^${want.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(got);
  return items.filter((item) =>
    filters.every((f) => {
      const tags = (item as { tags?: Tag[] }).tags;
      const got = f.name.startsWith('tag:') ? tags?.filter((t) => t.key === f.name.slice(4)).map((t) => t.value) : f.name === 'tag-key' ? tags?.map((t) => t.key) : fields[f.name](item);
      const values = (Array.isArray(got) ? got : got === undefined ? [] : [got]).map((x) => String(x));
      return f.values.some((w) => values.some((g) => match(w, g)));
    }),
  );
}

/** --xxx-ids で絞り込む。見つからない ID があれば NotFound */
export function byIds<T>(items: T[], ids: string[], idOf: (x: T) => string, notFound: (id: string) => AwsError): T[] {
  if (!ids.length) return items;
  for (const id of ids) if (!items.some((x) => idOf(x) === id)) throw notFound(id);
  return items.filter((x) => ids.includes(idOf(x)));
}

export { AwsError };
