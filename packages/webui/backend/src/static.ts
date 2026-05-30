import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';

/**
 * Mount the React SPA dist as static assets with `index.html` fallback for
 * any non-API route. Resolution order for the dist directory:
 *   1. Explicit `staticRoot` option from the caller
 *   2. `QANYICAT_WEBUI_STATIC_ROOT` env var
 *   3. Common monorepo siblings: ../webui-frontend/dist, ../../frontend/dist
 *
 * If nothing is found we mount no handler — the API still works, the dashboard
 * just isn't served. This keeps the WebUI usable in dev (Vite dev server)
 * without forcing a production build.
 */
export interface StaticOptions {
  /** Absolute path to the frontend dist directory. */
  staticRoot?: string;
}

export function mountStatic(app: Hono, opts: StaticOptions = {}): string | null {
  const root = resolveStaticRoot(opts.staticRoot);
  if (!root) return null;
  const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');

  app.get('/*', (c) => {
    // Anything under /api is handled before this catch-all by Hono's match
    // order, so we don't need to gate on it explicitly.
    const rawPath = new URL(c.req.url).pathname;
    const safe = sanitizePath(rawPath);
    const candidate = join(root, safe);
    if (
      candidate.startsWith(root) &&
      existsSync(candidate) &&
      statSync(candidate).isFile()
    ) {
      const buf = readFileSync(candidate);
      const ct = mimeTypeFor(candidate);
      return new Response(buf, { headers: { 'content-type': ct } });
    }
    // SPA fallback: route doesn't map to a file → serve index.html so
    // client-side routing takes over.
    return c.html(indexHtml);
  });

  return root;
}

function resolveStaticRoot(explicit?: string): string | null {
  const envRoot = process.env['QANYICAT_WEBUI_STATIC_ROOT'];
  const candidates = [
    explicit,
    envRoot,
    // Built backend lives at packages/webui/backend/dist/backend/src; the
    // sibling frontend's dist is up the tree.
    siblingFromBackendDist(),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

function siblingFromBackendDist(): string {
  // Walk up from this file's compiled location to the workspace's webui dir,
  // then over to frontend/dist. Resilient against the dist/backend/src nesting
  // tsc produces with rootDir=../.
  const here = dirname(fileURLToPath(import.meta.url));
  // From .../packages/webui/backend/dist/backend/src/static.js
  return resolve(here, '..', '..', '..', '..', 'frontend', 'dist');
}

function sanitizePath(raw: string): string {
  // Strip leading slash; reject path traversal.
  const decoded = decodeURIComponent(raw).replace(/^\/+/, '');
  if (decoded.includes('..')) return '';
  return decoded;
}

function mimeTypeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'application/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    default:
      return 'application/octet-stream';
  }
}
