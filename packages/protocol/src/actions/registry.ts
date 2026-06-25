import type { InstanceContext } from '@qanyicat/core';

export type ActionHandler<P, R> = (ctx: InstanceContext, params: P) => Promise<R>;

export interface ActionRegistration<P, R> {
  name: string;
  handler: ActionHandler<P, R>;
}

const registry = new Map<string, ActionHandler<unknown, unknown>>();

export function registerAction<P, R>(name: string, handler: ActionHandler<P, R>): void {
  if (registry.has(name)) {
    throw new Error(`[actionRegistry] duplicate action: ${name}`);
  }
  registry.set(name, handler as ActionHandler<unknown, unknown>);
}

export function getAction(name: string): ActionHandler<unknown, unknown> | undefined {
  return registry.get(name);
}

export function listActions(): string[] {
  return [...registry.keys()];
}

/** Test/debug only — production code should not call this. */
export function _resetActionRegistry(): void {
  registry.clear();
}
