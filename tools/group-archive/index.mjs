#!/usr/bin/env node
// Group archive — paginate get_group_msg_history (or get_friend_msg_history)
// against a running QanYiCat bridge and dump it as a human-readable markdown
// file. Zero-dep node, works against any OneBot 11 HTTP bridge.
//
// Usage:
//   node tools/group-archive/index.mjs --group 100002
//   node tools/group-archive/index.mjs --friend 10000 --count 1000 --out ./archives
//
// Flags:
//   --group <id>           group_id to archive (mutually exclusive with --friend)
//   --friend <uin>         friend uin to archive
//   --count <n>            max messages to fetch (default 500)
//   --batch <n>            messages per request (default 50, 100 max per OB11)
//   --out <dir>            output directory (default cwd)
//   --base <url>           OneBot HTTP base (default $QYC_BASE or http://127.0.0.1:5700)
//   --token <tok>          OneBot access token (default $QYC_ACCESS_TOKEN)
//   --raw                  also dump the raw JSON next to the markdown
//
// Output: <group_id|friend-uin>-<isoDateTime>.md (+ .json with --raw)

import { writeFileSync } from 'node:fs';
import { mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const argv = parseArgs(process.argv.slice(2));
if (argv.help) { printUsage(); process.exit(0); }

const groupId = argv.group ? String(argv.group) : null;
const friendUin = argv.friend ? String(argv.friend) : null;
if (!groupId && !friendUin) {
  fail('one of --group or --friend is required (try --help)');
}
if (groupId && friendUin) {
  fail('--group and --friend are mutually exclusive');
}

const TARGET_TOTAL = Number(argv.count ?? 500);
const BATCH = Math.min(100, Number(argv.batch ?? 50));
const OUT_DIR = resolve(String(argv.out ?? process.cwd()));
const BASE = String(argv.base ?? process.env.QYC_BASE ?? 'http://127.0.0.1:5700').replace(/\/+$/, '');
const TOKEN = argv.token ? String(argv.token) : process.env.QYC_ACCESS_TOKEN;

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const label = groupId ? `group ${groupId}` : `friend ${friendUin}`;
const action = groupId ? 'get_group_msg_history' : 'get_friend_msg_history';
const idField = groupId ? 'group_id' : 'user_id';
const idValue = groupId ?? friendUin;

console.log(`archiving ${label} via ${BASE} (target=${TARGET_TOTAL}, batch=${BATCH})`);

const seen = new Map(); // message_id → message
let anchor = undefined;
let consecutiveDuplicateBatches = 0;

while (seen.size < TARGET_TOTAL) {
  const params = { [idField]: idValue, count: Math.min(BATCH, TARGET_TOTAL - seen.size) };
  if (anchor) params.message_seq = anchor;
  const resp = await callAction(action, params);
  const messages = resp?.messages ?? [];
  if (messages.length === 0) {
    console.log('reached end of history (empty batch)');
    break;
  }

  let added = 0;
  for (const m of messages) {
    const id = String(m.message_id ?? m.messageId ?? '');
    if (!id || seen.has(id)) continue;
    seen.set(id, m);
    added++;
  }
  console.log(`  +${added} (total=${seen.size}/${TARGET_TOTAL})`);

  if (added === 0) {
    consecutiveDuplicateBatches++;
    if (consecutiveDuplicateBatches >= 2) {
      console.log('two consecutive batches with no new messages — assuming we hit the start');
      break;
    }
  } else {
    consecutiveDuplicateBatches = 0;
  }

  // Pick the oldest message in the batch as the next anchor; assumes a
  // chronological-asc time field is present (which OB11 message events carry).
  const oldest = messages.reduce((acc, m) => {
    if (!acc) return m;
    return Number(m.time ?? 0) < Number(acc.time ?? 0) ? m : acc;
  }, null);
  const nextAnchor = oldest?.message_id ?? oldest?.messageId;
  if (!nextAnchor || nextAnchor === anchor) {
    console.log('anchor did not advance — stopping');
    break;
  }
  anchor = String(nextAnchor);
}

const ordered = [...seen.values()].sort((a, b) => Number(a.time ?? 0) - Number(b.time ?? 0));
const isoNow = new Date().toISOString().replace(/[:.]/g, '-');
const slug = groupId ? `group-${groupId}` : `friend-${friendUin}`;
const mdPath = join(OUT_DIR, `${slug}-${isoNow}.md`);

writeFileSync(mdPath, renderMarkdown(label, ordered), 'utf-8');
console.log(`wrote ${ordered.length} messages → ${mdPath}`);

if (argv.raw) {
  const jsonPath = mdPath.replace(/\.md$/, '.json');
  writeFileSync(jsonPath, JSON.stringify(ordered, null, 2), 'utf-8');
  console.log(`wrote raw JSON → ${jsonPath}`);
}

// ---------------------------------------------------------------------------

async function callAction(name, params) {
  const headers = { 'content-type': 'application/json' };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const r = await fetch(`${BASE}/${name}`, {
    method: 'POST', headers, body: JSON.stringify(params),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
  const body = await r.json();
  if (body.retcode !== 0) {
    throw new Error(`${name}: retcode=${body.retcode} msg=${body.message ?? body.wording ?? ''}`);
  }
  return body.data;
}

function renderMarkdown(label, messages) {
  const lines = [];
  lines.push(`# Archive: ${label}`);
  lines.push('');
  lines.push(`Exported: ${new Date().toISOString()}`);
  lines.push(`Messages: ${messages.length}`);
  lines.push('');
  let lastDay = '';
  for (const m of messages) {
    const ts = new Date(Number(m.time ?? 0) * 1000);
    const day = ts.toISOString().slice(0, 10);
    if (day !== lastDay) {
      lines.push('');
      lines.push(`## ${day}`);
      lines.push('');
      lastDay = day;
    }
    const hhmm = ts.toISOString().slice(11, 19);
    const sender = m.sender ?? {};
    const card = sender.card ? ` (${sender.card})` : '';
    const senderLabel = `${sender.nickname ?? '?'}${card} [${m.user_id ?? sender.user_id ?? '?'}]`;
    const body = renderSegments(m.message ?? [], m.raw_message ?? '');
    lines.push(`**${hhmm}** \`${senderLabel}\``);
    lines.push('');
    for (const l of body.split('\n')) lines.push(`> ${l}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSegments(segments, fallback) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return fallback || '_(empty)_';
  }
  const out = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    switch (seg.type) {
      case 'text': out.push(String(d.text ?? '')); break;
      case 'at':   out.push(`@${d.qq ?? d.user_id ?? d.uid ?? '?'}`); break;
      case 'face': out.push(`:face_${d.id ?? '?'}:`); break;
      case 'reply': out.push(`↩️_reply(${d.id ?? '?'})_ `); break;
      case 'image': out.push(`![image](${d.url ?? d.file ?? '?'})`); break;
      case 'record': out.push(`🎤 _voice_(${d.file ?? '?'})`); break;
      case 'video': out.push(`🎬 _video_(${d.file ?? '?'})`); break;
      case 'file': out.push(`📎 _file_ ${d.file_name ?? d.fileName ?? d.file ?? '?'}`); break;
      case 'forward': out.push(`🗂 _forward_(${d.id ?? '?'})`); break;
      default: out.push(`[${seg.type}]`);
    }
  }
  return out.join('').trim() || fallback || '_(unrenderable)_';
}

function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[name] = true;
    } else {
      out[name] = next;
      i++;
    }
  }
  return out;
}

function printUsage() {
  console.log(`group-archive — dump OneBot msg history to markdown

  --group <id>      group_id (xor --friend)
  --friend <uin>    friend uin (xor --group)
  --count <n>       max messages (default 500)
  --batch <n>       per-request batch (default 50, max 100)
  --out <dir>       output dir (default cwd)
  --base <url>      OneBot base (default $QYC_BASE or http://127.0.0.1:5700)
  --token <tok>     bearer (default $QYC_ACCESS_TOKEN)
  --raw             also write raw JSON next to the .md`);
}

function fail(msg) { console.error(`error: ${msg}`); process.exit(2); }
