import type { CommandRecord } from '../../console/store';
import type { TaskContext } from '../../lesson/types';

/** aws calls typed on the learner's PC (newest last) */
export const awsCalls = (ctx: TaskContext) => ctx.commands.filter((c) => !c.instanceId && c.command);

/**
 * The newest aws call of `command` ('ec2 describe-vpcs') that succeeded and matches `pred`.
 * Use it for "look at ..." tasks; tasks that change something should check the env instead.
 */
export function ranAws(ctx: TaskContext, command: string, pred: (c: CommandRecord) => boolean = () => true): CommandRecord | undefined {
  return [...awsCalls(ctx)].reverse().find((c) => c.command === command && c.ok && pred(c));
}

/** The newest aws call of `command` that failed (optionally with this error code): "try it and see the error" tasks */
export function failedAws(ctx: TaskContext, command: string, errorCode?: string): CommandRecord | undefined {
  return [...awsCalls(ctx)].reverse().find((c) => c.command === command && !c.ok && (!errorCode || c.errorCode === errorCode));
}

/** A parameter of a recorded call as a string ('' when absent) */
export const param = (c: CommandRecord | undefined, name: string): string => {
  const v = c?.params?.[name];
  if (v === undefined) return '';
  if (Array.isArray(v) && v.every((x) => typeof x !== 'object')) return v.join(',');
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};


/** Is the terminal inside this EC2 instance right now (entered with aws ec2-instance-connect ssh and not left with exit)? */
export function insideInstance(ctx: TaskContext, instanceId: string | undefined): boolean {
  const events = ctx.commands.filter((c) => c.instanceId === instanceId || (c.command === 'ec2-instance-connect ssh' && c.ok && c.params?.['instance-id'] === instanceId));
  const last = events.at(-1);
  return !!last && !(last.instanceId === instanceId && /^\s*(exit|logout)\s*$/.test(last.line));
}
