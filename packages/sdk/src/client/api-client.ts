import { ActionFailedError, TransportClosedError } from '../errors.js';
import type { SdkEvent, SdkEventMap, Disposable } from '../types/index.js';
import type { ParamOf, ResultOf, ActionParamMap, ActionResultMap } from '../actions/types.js';
import { createWebSocketClient, type WsClient } from './ws.js';
import { createHttpClient, type HttpClient } from './http.js';

export interface QanYiCatClientOptions {
  ws?: string;
  http?: string;
  token?: string;
}

interface PendingCall {
  resolve(data: unknown): void;
  reject(err: Error): void;
}

export class QanYiCatApiClient {
  private ws: WsClient | null = null;
  private http: HttpClient | null = null;
  private pending = new Map<string, PendingCall>();
  private listeners = new Map<keyof SdkEventMap, Set<(p: SdkEventMap[keyof SdkEventMap]) => void>>();
  private echoCounter = 0;

  constructor(private readonly opts: QanYiCatClientOptions) {
    if (opts.ws) {
      this.ws = createWebSocketClient({
        url: opts.ws,
        ...(opts.token !== undefined ? { token: opts.token } : {}),
      });
      this.ws.onEvent((e) => this.dispatchEvent(e));
      this.ws.onResponse((r) => this.dispatchResponse(r));
    }
    if (opts.http) {
      this.http = createHttpClient({
        baseUrl: opts.http,
        ...(opts.token !== undefined ? { token: opts.token } : {}),
      });
    }
  }

  async callAction<K extends keyof ActionParamMap & keyof ActionResultMap>(
    name: K,
    params: ParamOf<K>
  ): Promise<ResultOf<K>> {
    if (this.ws) {
      const echo = `q${++this.echoCounter}`;
      return new Promise<ResultOf<K>>((resolve, reject) => {
        this.pending.set(echo, {
          resolve: (data) => resolve(data as ResultOf<K>),
          reject,
        });
        this.ws!.send({ action: name, params, echo });
      });
    }
    if (this.http) {
      const resp = (await this.http.call(name, params)) as {
        status?: string;
        retcode?: number;
        data?: unknown;
        message?: string;
      };
      if (resp.status === 'failed') {
        throw new ActionFailedError(name, resp.retcode ?? -1, resp.message ?? 'unknown');
      }
      return resp.data as ResultOf<K>;
    }
    throw new TransportClosedError('no transport configured');
  }

  on<E extends keyof SdkEventMap>(event: E, handler: (payload: SdkEventMap[E]) => void): Disposable {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (p: SdkEventMap[keyof SdkEventMap]) => void);
    return {
      dispose: () => {
        this.listeners.get(event)?.delete(handler as (p: SdkEventMap[keyof SdkEventMap]) => void);
      },
    };
  }

  close(): void {
    this.ws?.close();
    for (const [, p] of this.pending) p.reject(new TransportClosedError());
    this.pending.clear();
  }

  private dispatchEvent(e: SdkEvent): void {
    const set = this.listeners.get(e.kind);
    if (!set) return;
    for (const fn of set) (fn as (p: SdkEvent) => void)(e);
  }

  private dispatchResponse(r: unknown): void {
    const resp = r as { echo?: string; status?: string; retcode?: number; data?: unknown; message?: string };
    const pending = resp.echo ? this.pending.get(resp.echo) : undefined;
    if (!pending) return;
    this.pending.delete(resp.echo!);
    if (resp.status === 'failed') {
      pending.reject(new ActionFailedError('?', resp.retcode ?? -1, resp.message ?? 'unknown'));
    } else {
      pending.resolve(resp.data);
    }
  }
}
