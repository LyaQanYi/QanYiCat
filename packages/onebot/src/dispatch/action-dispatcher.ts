import type { InstanceContext } from '@qanyicat/core';
import { getAction } from '@qanyicat/protocol';

export interface DispatchResult {
  status: 'ok' | 'failed';
  retcode: number;
  data: unknown;
  message?: string;
  echo?: string;
}

export class ActionDispatcher {
  constructor(private readonly ctx: InstanceContext) {}

  async invoke(unifiedName: string, params: unknown, echo?: string): Promise<DispatchResult> {
    const handler = getAction(unifiedName);
    if (!handler) {
      const result: DispatchResult = {
        status: 'failed',
        retcode: 1404,
        data: null,
        message: `unknown action: ${unifiedName}`,
      };
      if (echo !== undefined) result.echo = echo;
      return result;
    }
    try {
      const data = await handler(this.ctx, params);
      const result: DispatchResult = { status: 'ok', retcode: 0, data };
      if (echo !== undefined) result.echo = echo;
      return result;
    } catch (e: unknown) {
      const result: DispatchResult = {
        status: 'failed',
        retcode: 1500,
        data: null,
        message: e instanceof Error ? e.message : String(e),
      };
      if (echo !== undefined) result.echo = echo;
      return result;
    }
  }
}
