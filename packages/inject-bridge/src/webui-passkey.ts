import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * On-disk passkey file. Auto-created on first bridge boot when nothing else
 * supplies a password; survives QQ restarts so the user doesn't have to
 * re-set `QANYICAT_WEBUI_PASSWORD` every launch. Env vars override the file
 * when set.
 */
export interface WebUIPasskeyFile {
  password: string;
  jwtSecret: string;
}

export interface WebUIPasskeyResolved {
  password: string;
  jwtSecret: string;
  /** Where the values came from (used in startup logs). */
  source: 'env' | 'file' | 'generated';
  /** Absolute path the file lives at, if any. */
  path: string;
}

const DEFAULT_FILENAME = 'qanyicat.webui.passkey.json';

/**
 * Picks the WebUI password + jwtSecret using this priority:
 *  1. Env vars (`QANYICAT_WEBUI_PASSWORD` / `QANYICAT_WEBUI_JWT_SECRET`) — both
 *     of them, atomic. If only one is set, fall through to the file/generated
 *     path for the other.
 *  2. Persisted file (path from `QANYICAT_WEBUI_PASSKEY_PATH` or CWD default).
 *  3. Fresh random values written back to the file (16-byte hex for password,
 *     32-byte hex for jwtSecret).
 *
 * Values that come from env are NOT written back — the env was an explicit
 * one-shot override and the operator likely wants it to stay that way.
 */
export function resolveWebUIPasskey(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): WebUIPasskeyResolved {
  const path = env['QANYICAT_WEBUI_PASSKEY_PATH'] ?? join(cwd, DEFAULT_FILENAME);
  const envPassword = env['QANYICAT_WEBUI_PASSWORD'];
  const envJwt = env['QANYICAT_WEBUI_JWT_SECRET'];

  if (envPassword && envJwt) {
    return { password: envPassword, jwtSecret: envJwt, source: 'env', path };
  }

  const fromFile = readPasskeyFile(path);
  if (fromFile) {
    return {
      password: envPassword ?? fromFile.password,
      jwtSecret: envJwt ?? fromFile.jwtSecret,
      source: envPassword || envJwt ? 'env' : 'file',
      path,
    };
  }

  const generated: WebUIPasskeyFile = {
    password: envPassword ?? randomHex(16),
    jwtSecret: envJwt ?? randomHex(32),
  };
  try {
    writePasskeyFile(path, generated);
  } catch {
    // Best-effort: if disk is read-only we still return the values, the
    // operator just won't have persistence. Logged by the caller.
  }
  return {
    password: generated.password,
    jwtSecret: generated.jwtSecret,
    source: envPassword || envJwt ? 'env' : 'generated',
    path,
  };
}

function readPasskeyFile(path: string): WebUIPasskeyFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<WebUIPasskeyFile>;
    if (typeof raw.password === 'string' && raw.password.length > 0
        && typeof raw.jwtSecret === 'string' && raw.jwtSecret.length > 0) {
      return { password: raw.password, jwtSecret: raw.jwtSecret };
    }
    return null;
  } catch {
    return null;
  }
}

function writePasskeyFile(path: string, contents: WebUIPasskeyFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(contents, null, 2), 'utf8');
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
