import { readFileSync, existsSync } from 'node:fs';
import { Value } from '@sinclair/typebox/value';
import { QanYiCatConfigSchema, type QanYiCatConfig } from './schema';

export interface LoadConfigOptions {
  path: string;
}

/**
 * Reads JSON config, applies schema defaults, validates, then merges
 * `QANYICAT_*` env-var overrides. Env overrides win — useful in Docker /
 * headless deployments where the on-disk config volume is read-only.
 */
export function loadConfig(opts: LoadConfigOptions): QanYiCatConfig {
  const raw: unknown = existsSync(opts.path) ? JSON.parse(readFileSync(opts.path, 'utf8')) : {};
  const withDefaults = Value.Default(QanYiCatConfigSchema, raw);
  const merged = applyEnvOverrides(withDefaults as Partial<QanYiCatConfig>);
  const errors = [...Value.Errors(QanYiCatConfigSchema, merged)];
  if (errors.length > 0) {
    const msg = errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    throw new Error(`[loadConfig] schema validation failed: ${msg}`);
  }
  return merged as QanYiCatConfig;
}

function applyEnvOverrides(cfg: Partial<QanYiCatConfig>): Partial<QanYiCatConfig> {
  const out = structuredClone(cfg);
  const execPath = process.env['QANYICAT_QQ_EXEC_PATH'];
  if (execPath) (out.qq ??= {}).execPath = execPath;
  const ver = process.env['QANYICAT_QQ_VERSION'];
  if (ver) (out.qq ??= {}).version = ver;
  const logLevel = process.env['QANYICAT_LOG_LEVEL'];
  if (logLevel && ['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    (out.log ??= { level: 'info', toFile: false }).level = logLevel as 'debug' | 'info' | 'warn' | 'error';
  }
  return out;
}
