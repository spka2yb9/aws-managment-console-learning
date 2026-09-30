import { create } from 'zustand';
import { iamUserActor, withActor } from '../sim/cloudtrail';
import { mutate } from '../sim/env';
import { CLIENT_IP } from '../sim/network';
import { execCli } from '../sim/cli';
import { simulateHttp, type HttpResult } from '../sim/http';
import { recordWafSample, storeInCache } from '../sim/edge';
import { advanceTime, hasTransitions } from '../sim/time';
import { AwsError, type AwsEnv } from '../sim/types';
import type { FlashbarProps } from '@cloudscape-design/components/flashbar';

export type RunResult<T> = { ok: true; value: T } | { ok: false; error: AwsError };

export interface CommandRecord {
  instanceId: string;
  line: string;
  output: string;
  ok: boolean;
  operation?: string;
  errorCode?: string;
  file?: { name: string; body: string };
  at: number;
}

export interface ConsoleSnapshot {
  env: AwsEnv;
  path: string;
  region: string;
  visited: string[];
  copied: string[];
  browser: HttpResult[];
  /** commands typed into EC2 Instance Connect terminals (newest last) */
  commands: CommandRecord[];
}

interface ConsoleState extends ConsoleSnapshot {
  flashes: FlashbarProps.MessageDefinition[];
  load(s: ConsoleSnapshot): void;
  navigate(path: string): void;
  setRegion(region: string): void;
  /** Apply an operation atomically: on AwsError nothing changes and the error is returned for the form to show. */
  run<T>(op: (draft: AwsEnv) => T, success?: string | ((value: T) => string)): RunResult<T>;
  tick(now?: number): void;
  flash(type: FlashbarProps.Type, content: string, button?: { text: string; onClick: () => void }): void;
  recordCopy(text: string): void;
  browse(url: string): HttpResult;
  runCommand(instanceId: string, line: string): CommandRecord;
}

let flashSeq = 0;

export const useConsole = create<ConsoleState>()((set, get) => ({
  env: { accountId: '', region: '', vpcs: [], subnets: [], routeTables: [], internetGateways: [], networkAcls: [], securityGroups: [], keyPairs: [], instances: [], loadBalancers: [], targetGroups: [], dbSubnetGroups: [], dbInstances: [], dbSnapshots: [], iamUsers: [], iamRoles: [], iamPolicies: [], instanceProfiles: [], buckets: [], incidents: [], alarms: [], logGroups: [], trailEvents: [], configRules: [], launchTemplates: [], autoScalingGroups: [], traffic: [], ecrRepositories: [], ecsClusters: [], taskDefinitions: [], ecsServices: [], ecsTasks: [], sqsQueues: [], lambdaFunctions: [], eventSourceMappings: [], computeEnvironments: [], jobQueues: [], jobDefinitions: [], batchJobs: [], eventRules: [], hostedZones: [], certificates: [], distributions: [], webAcls: [], ipSets: [], natGateways: [], vpcEndpoints: [], dataFlows: [], budgets: [] },
  path: '/console/home',
  region: 'ap-northeast-1',
  visited: [],
  copied: [],
  browser: [],
  commands: [],
  flashes: [],
  load: (s) => set({ ...s, flashes: [] }),
  navigate: (path) => {
    const visited = get().visited.includes(path) ? get().visited : [...get().visited, path].slice(-200);
    set({ path, visited });
    window.scrollTo?.(0, 0);
  },
  setRegion: (region) => set({ region }),
  run: (op, success) => {
    try {
      // every console operation is an API call by the signed-in user, so CloudTrail records it
      const [env, value] = mutate(get().env, (d) => withActor(iamUserActor(d, 'learner', CLIENT_IP), Date.now(), () => op(d)));
      set({ env });
      if (success) get().flash('success', typeof success === 'string' ? success : success(value));
      return { ok: true, value };
    } catch (e) {
      if (e instanceof AwsError) return { ok: false, error: e };
      throw e;
    }
  },
  tick: (now = Date.now()) => {
    const { env } = get();
    if (!hasTransitions(env)) return;
    const [next, changed] = mutate(env, (d) => advanceTime(d, now));
    if (changed) set({ env: next });
  },
  flash: (type, content, button) => {
    const id = `flash-${++flashSeq}`;
    const dismiss = () => set({ flashes: get().flashes.filter((f) => f.id !== id) });
    const action = button ? { buttonText: button.text, onButtonClick: () => { dismiss(); button.onClick(); } } : {};
    set({ flashes: [{ id, type, content, dismissible: true, dismissLabel: 'Dismiss', onDismiss: dismiss, ...action }, ...get().flashes].slice(0, 3) });
  },
  recordCopy: (text) => set({ copied: [...get().copied.filter((c) => c !== text), text].slice(-50) }),
  browse: (url) => {
    const result = simulateHttp(get().env, url);
    // a request can change AWS state (the edge cache, WAF's sampled requests)
    const fx = result.effects;
    const env = fx?.cache || fx?.waf ? mutate(get().env, (d) => {
      if (fx.cache) storeInCache(d, fx.cache.distributionId, fx.cache.entry);
      if (fx.waf) recordWafSample(d, fx.waf.aclArn, fx.waf.sample);
    })[0] : get().env;
    set({ env, browser: [result, ...get().browser].slice(0, 20) });
    return result;
  },
  runCommand: (instanceId, line) => {
    const files = instanceFiles(get().commands, instanceId);
    // Commands may change the env (aws s3 cp / rm), so they run like any other operation.
    const [env, r] = mutate(get().env, (d) => execCli(d, instanceId, line, files));
    const rec: CommandRecord = { instanceId, line, at: Date.now(), ...r };
    set({ env, commands: [...get().commands, rec].slice(-100) });
    return rec;
  },
}));

export function snapshot(s: ConsoleSnapshot): ConsoleSnapshot {
  return { env: s.env, path: s.path, region: s.region, visited: s.visited, copied: s.copied, browser: s.browser, commands: s.commands };
}

/** The instance's home directory: app.log plus files downloaded with the CLI. */
export function instanceFiles(commands: CommandRecord[], instanceId: string): Record<string, string> {
  const files: Record<string, string> = { 'app.log': '2026-09-29T02:00:01Z batch started\n2026-09-29T02:00:02Z downloading report...\n' };
  for (const c of commands) if (c.instanceId === instanceId && c.file) files[c.file.name] = c.file.body;
  return files;
}

// Dev-only handle for poking at the simulator from the browser devtools.
if (import.meta.env.DEV) (globalThis as { __console?: typeof useConsole }).__console = useConsole;
