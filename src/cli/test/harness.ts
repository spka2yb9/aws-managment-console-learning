/* テスト用: レッスンのシナリオで CliShell を起動し、コマンドを打った結果を返す */
import { useConsole, type ConsoleSnapshot } from '../../console/store';
import type { AwsEnv } from '../../sim/types';
import { CliShell } from '../shell/shell';

export async function bootShell(env: AwsEnv, files: Record<string, string> = {}) {
  const snap: ConsoleSnapshot = { env, path: '/cli', region: env.region, visited: [], copied: [], browser: [], commands: [] };
  useConsole.getState().load(snap);
  const shell = new CliShell();
  await shell.reset(files);
  const sh = async (line: string) => {
    const r = await shell.run(line);
    return { ...r, out: r.stdout + r.stderr };
  };
  return { shell, sh, state: () => useConsole.getState() };
}
