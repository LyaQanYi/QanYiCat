#!/usr/bin/env node
// File watcher — subscribes to QanYiCat's OneBot 11 WebSocket and archives
// every incoming file / image / video / voice attachment to a local dir.
//
// Demonstrates the msg.recv → get_<media> chain: WS message event arrives,
// we walk its segments for media identifiers, call the matching OB11 action
// to resolve a URL (or local NT cache path), then copy out.
//
// Run:
//   QANYICAT_FILES_DIR=./archive node tools/file-watcher/index.mjs
//
// Env:
//   QANYICAT_WS_URL          default ws://127.0.0.1:5710
//   QANYICAT_HTTP_URL        default http://127.0.0.1:5700  (for callAction)
//   QANYICAT_ACCESS_TOKEN    optional bearer
//   QANYICAT_FILES_DIR       output dir (default ./archive)
//   QANYICAT_KINDS           comma list of kinds to archive (default "file,image,video,record")
//   QANYICAT_ONLY_GROUPS     comma list of group_ids to filter (default any)
//   QANYICAT_ONLY_USERS      comma list of user_ids to filter (default any)

import WebSocket from 'ws';
import { mkdirSync, existsSync, createWriteStream, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const WS_URL = process.env.QANYICAT_WS_URL || 'ws://127.0.0.1:5710';
const HTTP_URL = (process.env.QANYICAT_HTTP_URL || 'http://127.0.0.1:5700').replace(/\/+$/, '');
const TOKEN = process.env.QANYICAT_ACCESS_TOKEN;
const FILES_DIR = resolve(process.env.QANYICAT_FILES_DIR || './archive');
const KINDS = new Set((process.env.QANYICAT_KINDS || 'file,image,video,record').split(',').map((s) => s.trim()).filter(Boolean));
const ONLY_GROUPS = parseList(process.env.QANYICAT_ONLY_GROUPS);
const ONLY_USERS = parseList(process.env.QANYICAT_ONLY_USERS);

const KIND_TO_ACTION = {
  file: 'get_file',
  image: 'get_image',
  video: 'get_video',
  record: 'get_record',
};

if (!existsSync(FILES_DIR)) mkdirSync(FILES_DIR, { recursive: true });

log(`watching ${WS_URL} → ${FILES_DIR}`);
log(`kinds=${[...KINDS].join(',')}${ONLY_GROUPS ? ` groups=${[...ONLY_GROUPS].join(',')}` : ''}${ONLY_USERS ? ` users=${[...ONLY_USERS].join(',')}` : ''}`);

connect();

function connect() {
  const headers = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {};
  const ws = new WebSocket(WS_URL, { headers });
  let backoff = 1000;

  ws.on('open', () => { backoff = 1000; log('connected'); });
  ws.on('error', (e) => log(`ws error: ${e.message}`));
  ws.on('close', () => {
    log(`disconnected; reconnecting in ${backoff}ms`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });

  ws.on('message', async (data) => {
    let event;
    try { event = JSON.parse(data.toString()); }
    catch { return; }
    if (event.post_type !== 'message') return;
    if (ONLY_GROUPS && event.message_type === 'group' && !ONLY_GROUPS.has(String(event.group_id))) return;
    if (ONLY_USERS && !ONLY_USERS.has(String(event.user_id))) return;

    const segments = Array.isArray(event.message) ? event.message : [];
    for (const seg of segments) {
      if (!seg || !KINDS.has(seg.type)) continue;
      const action = KIND_TO_ACTION[seg.type];
      const fileId = seg.data?.file ?? seg.data?.file_id;
      if (!action || !fileId) continue;
      try {
        await archiveOne(action, seg, event);
      } catch (e) {
        log(`  ✗ ${seg.type} ${fileId.slice(0, 20)}…: ${e.message}`);
      }
    }
  });
}

async function archiveOne(action, segment, event) {
  const fileId = segment.data.file ?? segment.data.file_id;
  const resp = await callAction(action, { file: fileId });
  if (!resp || !resp.url) {
    log(`  · ${segment.type} ${fileId.slice(0, 20)}…: no url (mediaIndex miss?)`);
    return;
  }
  const stem = pickFilename(segment, event, fileId);
  const dst = join(FILES_DIR, stem);

  if (resp.url.startsWith('file://')) {
    const src = fileURLToPath(resp.url);
    copyFileSync(src, dst);
    log(`  ✓ ${segment.type} → ${dst} (from cache ${src})`);
    return;
  }

  // Remote URL — stream it via fetch.
  const r = await fetch(resp.url, { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${resp.url}`);
  await pipeline(r.body, createWriteStream(dst));
  log(`  ✓ ${segment.type} → ${dst} (from ${resp.url.slice(0, 60)}…)`);
}

function pickFilename(segment, event, fileId) {
  const orig = segment.data.file_name ?? segment.data.fileName ?? segment.data.name;
  const safeOrig = orig ? orig.replace(/[\\/:*?"<>|]/g, '_') : '';
  const stamp = new Date((event.time ?? Date.now() / 1000) * 1000).toISOString().replace(/[:.]/g, '-');
  const tag = event.message_type === 'group' ? `g${event.group_id}` : `u${event.user_id}`;
  const id = String(fileId).slice(0, 10);
  return safeOrig
    ? `${stamp}_${tag}_${id}_${safeOrig}`
    : `${stamp}_${tag}_${id}.${defaultExtFor(segment.type)}`;
}

function defaultExtFor(kind) {
  switch (kind) {
    case 'image': return 'jpg';
    case 'video': return 'mp4';
    case 'record': return 'silk';
    default: return 'bin';
  }
}

async function callAction(name, params) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${HTTP_URL}/${name}`, {
    method: 'POST', headers, body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const body = await r.json();
  if (body.retcode !== 0) {
    throw new Error(`${name}: retcode=${body.retcode} ${body.message ?? ''}`);
  }
  return body.data;
}

function parseList(s) {
  if (!s || !s.trim()) return null;
  return new Set(s.split(',').map((x) => x.trim()).filter(Boolean));
}

function log(s) { console.log(`[${new Date().toISOString()}] ${s}`); }
