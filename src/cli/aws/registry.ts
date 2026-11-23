/* services/*.ts を全部読み込んで、サービス名ごとにまとめる。同じサービスを複数のファイルに分けて書いてよい。
   同じオペレーションを 2 か所で定義したら、先に読んだほうを使い、DUPLICATES に残す (registry.test.ts が失敗する) */
import type { OperationSpec, ServiceSpec } from './types';

const modules = import.meta.glob<{ default: ServiceSpec | ServiceSpec[] }>('./services/*.ts', { eager: true });

export const SERVICES = new Map<string, { name: string; desc: string; ops: Map<string, OperationSpec> }>();
export const DUPLICATES: string[] = [];

for (const [file, mod] of Object.entries(modules)) {
  for (const s of [mod.default].flat()) {
    if (!s) continue;
    const entry = SERVICES.get(s.name) ?? { name: s.name, desc: s.desc, ops: new Map() };
    if (!entry.desc) entry.desc = s.desc;
    for (const op of s.ops) {
      if (entry.ops.has(op.name)) DUPLICATES.push(`aws ${s.name} ${op.name} (${file})`);
      else entry.ops.set(op.name, op);
    }
    SERVICES.set(s.name, entry);
  }
}

export const serviceNames = () => [...SERVICES.keys()].sort();
