#!/usr/bin/env node
// Live OneBot smoke — probe the running QanYiCat bridge over HTTP. Replaces
// the handful of curl calls we keep retyping after every QQ relaunch.
//
//   pnpm smoke                    # default 127.0.0.1:5700, no auth
//   QYC_BASE=http://host:port \
//   QYC_ACCESS_TOKEN=xxx \
//   pnpm smoke
//
// Exits 0 when every probe returns retcode 0; otherwise exits with the count
// of failures so CI / shell loops can branch on it.
//
// Each probe prints: ` ✓ get_status            12ms  online`
//                    ` ✗ get_friend_list       1ms   retcode=1500  msg=...`
// Truncates long replies. Doesn't follow redirects, doesn't retry.

import { performance } from 'node:perf_hooks';
import { argv, env, exit, stdout } from 'node:process';

const BASE = (env.QYC_BASE ?? 'http://127.0.0.1:5700').replace(/\/+$/, '');
const TOKEN = env.QYC_ACCESS_TOKEN;
const HEALTH_BASE = env.QYC_HEALTH_BASE; // e.g. http://127.0.0.1:5800
const TIMEOUT_MS = Number(env.QYC_TIMEOUT_MS ?? 5000);
const VERBOSE = argv.includes('--verbose') || argv.includes('-v');

// Each probe: { name, action, params, ok(data) → string|null }. ok returns a
// short summary string on success, or null when the response shape is wrong
// for what we asked (treated as failure even if retcode is 0).
const PROBES = [
  {
    name: 'get_status',
    action: 'get_status',
    params: {},
    ok: (d) => (typeof d?.online === 'boolean' ? `online=${d.online}` : null),
  },
  {
    name: 'get_login_info',
    action: 'get_login_info',
    params: {},
    ok: (d) => (d?.user_id ? `uin=${d.user_id} nick=${d.nickname ?? ''}` : null),
  },
  {
    name: 'get_version_info',
    action: 'get_version_info',
    params: {},
    ok: (d) => (d?.app_name ? `${d.app_name}/${d.app_version ?? ''}` : null),
  },
  {
    name: 'get_friend_list',
    action: 'get_friend_list',
    params: {},
    ok: (d) => (Array.isArray(d) ? `count=${d.length}` : null),
  },
  {
    name: 'get_group_list',
    action: 'get_group_list',
    params: {},
    ok: (d) => (Array.isArray(d) ? `count=${d.length}` : null),
  },
];

function colorize(s, code) {
  return stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}
const green = (s) => colorize(s, 32);
const red = (s) => colorize(s, 31);
const dim = (s) => colorize(s, 2);

async function probe({ name, action, params, ok }) {
  const url = `${BASE}/${action}`;
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;

  const t0 = performance.now();
  let resp, body, err;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await resp.json();
  } catch (e) {
    err = e;
  }
  const elapsed = Math.round(performance.now() - t0);

  if (err) {
    return { name, ok: false, elapsed, summary: `fetch error: ${err.message}` };
  }
  if (!resp.ok) {
    return { name, ok: false, elapsed, summary: `HTTP ${resp.status}` };
  }
  const retcode = body?.retcode;
  if (retcode !== 0) {
    return {
      name,
      ok: false,
      elapsed,
      summary: `retcode=${retcode} msg=${truncate(body?.message ?? body?.wording ?? '', 80)}`,
    };
  }
  const summary = ok(body.data);
  if (summary === null) {
    return { name, ok: false, elapsed, summary: `bad shape: ${truncate(JSON.stringify(body.data), 80)}` };
  }
  return { name, ok: true, elapsed, summary };
}

async function probeHealth() {
  if (!HEALTH_BASE) return null;
  const url = `${HEALTH_BASE.replace(/\/+$/, '')}/api/health`;
  const t0 = performance.now();
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = await resp.json();
    const elapsed = Math.round(performance.now() - t0);
    if (resp.status === 200 && body?.status === 'ok') {
      return { name: 'api/health', ok: true, elapsed, summary: `uin=${body.uin ?? '?'} uptime=${body.uptimeSec ?? '?'}s` };
    }
    return {
      name: 'api/health',
      ok: false,
      elapsed,
      summary: `HTTP ${resp.status} status=${body?.status ?? '?'}`,
    };
  } catch (e) {
    return { name: 'api/health', ok: false, elapsed: Math.round(performance.now() - t0), summary: `fetch error: ${e.message}` };
  }
}

function truncate(s, n) {
  if (typeof s !== 'string') s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function pad(s, n) {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main() {
  console.log(dim(`OneBot base: ${BASE}${TOKEN ? '  (with bearer token)' : ''}`));
  if (HEALTH_BASE) console.log(dim(`WebUI health: ${HEALTH_BASE}/api/health`));
  console.log('');

  const results = [];
  for (const p of PROBES) {
    const r = await probe(p);
    results.push(r);
    const mark = r.ok ? green(' ✓') : red(' ✗');
    console.log(`${mark} ${pad(r.name, 20)} ${dim(pad(`${r.elapsed}ms`, 7))} ${r.summary}`);
    if (VERBOSE && !r.ok) console.log(dim(`     url=${BASE}/${p.action}`));
  }

  const health = await probeHealth();
  if (health) {
    results.push(health);
    const mark = health.ok ? green(' ✓') : red(' ✗');
    console.log(`${mark} ${pad(health.name, 20)} ${dim(pad(`${health.elapsed}ms`, 7))} ${health.summary}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  if (failed.length === 0) {
    console.log(green(`all ${results.length} probes OK`));
    exit(0);
  } else {
    console.log(red(`${failed.length}/${results.length} probes FAILED`));
    exit(failed.length);
  }
}

await main();
