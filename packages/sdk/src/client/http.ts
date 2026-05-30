export interface HttpClientOptions {
  baseUrl: string;
  token?: string;
}

export interface HttpClient {
  call(action: string, params: unknown): Promise<unknown>;
}

export function createHttpClient(opts: HttpClientOptions): HttpClient {
  return {
    async call(action, params) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
      const res = await fetch(`${opts.baseUrl}/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params ?? {}),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res.json();
    },
  };
}
