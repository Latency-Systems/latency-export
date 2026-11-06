#!/usr/bin/env node
// Latency collector. Reads usage and cost totals from your Anthropic organization
// and writes latency-bundle.json for your Latency audit.
//
// What it does, in order:
//   1. Asks for your key. It stays in memory only: never written to disk, printed, or put in the bundle.
//   2. Calls two read only endpoints, /v1/organizations/analytics/usage and /cost. Nothing else. No telemetry.
//   3. Replaces every ID and email with a salted hash. Drops names.
//   4. Prints a summary, writes latency-bundle.json (to send) and latency-names.local.json (to keep).
//
// Zero dependencies. Node 22 or newer. Docs: platform.claude.com/docs/en/manage-claude/usage-cost-analytics-api

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

export const VERSION = '0.1.0';
const API_VERSION = '2026-10-21';
const BETA = 'analytics-usage-cost-2026-08-24';
const EARLIEST = Date.UTC(2026, 0, 1), DAY = 86_400_000; // the API has no data before Jan 1 2026

// Five dimensions is the API maximum per query (cost_type and token_type don't count).
const CORE = ['model', 'workspace_id', 'api_key_id', 'service_tier', 'inference_geo'];
export const QUERIES = [
  { id: 'usage_daily', endpoint: 'usage', group_by: CORE },
  { id: 'cost_daily', endpoint: 'cost', group_by: [...CORE, 'cost_type', 'token_type'] },
  { id: 'people_daily', endpoint: 'cost', group_by: ['actor', 'product', 'model'] },
  { id: 'modes_daily', endpoint: 'cost', group_by: ['model', 'product', 'service_tier', 'speed', 'context_window'] },
  { id: 'month_total', endpoint: 'cost', group_by: [], monthly: true },
];
const ID_DIMS = { workspace_id: 'workspaces', api_key_id: 'api_keys' };

// ---------- safety helpers ----------

// Enum values from the API (model names, tiers, products). Anything else becomes "other",
// so free text can never reach the bundle.
const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;
export const tok = (v) => (v == null ? null : TOKEN.test(v) && !/^sk-/i.test(v) ? v : 'other');

export const int = (v) => {
  if (v == null) return 0;
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Unexpected token count: ${v}`);
  return v;
};

// Amounts arrive as decimal strings in cents, for example "41280.000000" is $412.80.
// We keep the exact string and never parse it as a float.
export const dec = (v) => {
  if (typeof v !== 'string' || !/^-?\d+(\.\d+)?$/.test(v)) throw new Error('Unexpected amount format');
  return v;
};

// Every string in the bundle must be a short token with no spaces, no "@", no key prefix.
const SAFE = /^[A-Za-z0-9._:/-]{0,100}$/;
export function assertSafe(bundle, secrets = []) {
  const text = JSON.stringify(bundle);
  for (const s of secrets) if (s && text.includes(s)) throw new Error('Refusing to write: bundle contains your key');
  if (/sk-ant-/i.test(text)) throw new Error('Refusing to write: bundle contains something that looks like a key');
  if (text.includes('@')) throw new Error('Refusing to write: bundle contains an email address');
  const walk = (v) => {
    if (typeof v === 'string' && !SAFE.test(v)) throw new Error(`Refusing to write: unexpected text in bundle (${v.slice(0, 20)})`);
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(bundle);
}

// ---------- hashing ----------

export function makeHasher(salt, names) {
  const h = (v, kind) => {
    if (v == null || v === '') return null;
    const id = 'h_' + createHmac('sha256', salt).update(String(v)).digest('hex').slice(0, 32);
    if (names && kind) names[kind][id] = String(v);
    return id;
  };
  const actor = (a) => {
    if (!a) return { actor_type: null, actor: null, actor_email: null, actor_deleted: null };
    const raw = a.user_id ?? a.service_account_id ?? a.api_key_id
      ?? `${a.provider?.type}:${a.subject ?? a.provider?.signed_principal ?? a.provider?.project_number ?? ''}`;
    // An api_actor's ID is its API key ID, so it hashes to the same value as api_key_id.
    const id = h(raw, a.type === 'api_actor' ? 'api_keys' : null);
    const email = a.email_address ? a.email_address.trim().toLowerCase() : null;
    if (names && a.type !== 'api_actor') names.actors[id] = { type: a.type, id: raw, email, name: a.name ?? null };
    return { actor_type: tok(a.type), actor: id, actor_email: h(email), actor_deleted: a.deleted ?? null };
  };
  return { h, actor };
}

// ---------- normalizing API rows ----------

export function normalize(row, q, hasher) {
  const g = row.group ?? {};
  const out = { date: row.starting_at.slice(0, 10) };
  for (const d of q.group_by) {
    if (d === 'actor') Object.assign(out, hasher.actor(g.actor));
    else if (ID_DIMS[d]) out[d] = hasher.h(g[d], ID_DIMS[d]);
    else out[d] = tok(g[d]);
  }
  const u = row.usage, c = row.cost;
  if (u) Object.assign(out, {
    uncached_input: int(u.uncached_input_tokens),
    cache_write_5m: int(u.cache_creation?.ephemeral_5m_input_tokens),
    cache_write_1h: int(u.cache_creation?.ephemeral_1h_input_tokens),
    cache_read: int(u.cache_read_input_tokens),
    output: int(u.output_tokens),
    web_search: int(u.server_tool_use?.web_search_requests),
  });
  if (c?.currency && c.currency !== 'USD') throw new Error(`Unexpected currency ${c.currency}`);
  if (c) Object.assign(out, { amount_cents: dec(c.amount), list_amount_cents: dec(c.list_amount) });
  const requests = (u ?? c)?.requests;
  out.requests = requests == null ? null : int(requests);
  return out;
}

// ---------- date windows ----------
// Last N full calendar months. A month is "final" once it ended 7+ days ago,
// because Anthropic revises totals until about the 7th of the next month.
const iso = (t) => new Date(t).toISOString().replace('.000', '');
export function monthWindows(n, now = Date.now()) {
  const d = new Date(now), out = [];
  for (let i = n; i >= 1; i--) {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1);
    const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i + 1, 1);
    if (start < EARLIEST || start < now - 365 * DAY) continue;
    out.push({ month: iso(start).slice(0, 7), starting_at: iso(start), ending_at: iso(end), final: now - end >= 7 * DAY });
  }
  return out;
}

export function sinceWindow(since, now = Date.now()) { // for testing: a start date up to the start of today (UTC), 31 days max
  const start = Date.parse(`${since}T00:00:00Z`), end = Math.min(start + 31 * DAY, now - (now % DAY));
  if (!(end > start) || start < EARLIEST) throw new Error('--since must be a date this year and before today, as YYYY-MM-DD.');
  return [{ month: since.slice(0, 7), starting_at: iso(start), ending_at: iso(end), final: false }];
}

// ---------- HTTP ----------
export function makeClient({ baseUrl, key, auth, paceMs, log }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(base.hostname)) {
    throw new Error('Base URL must use https');
  }
  const headers = {
    'anthropic-version': API_VERSION,
    'anthropic-beta': BETA,
    'user-agent': `latency-collect/${VERSION}`,
    ...(auth === 'bearer' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }),
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = 0, calls = 0;

  async function get(endpoint, params) {
    const url = new URL(`/v1/organizations/analytics/${endpoint}`, base);
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) url.searchParams.append(k, x);
    if (url.origin !== base.origin) throw new Error('Blocked a request to an unexpected host');
    for (let attempt = 1; ; attempt++) {
      const wait = last + paceMs - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
      calls++;
      let res;
      try {
        res = await fetch(url, { headers });
      } catch (e) {
        if (attempt < 5) { await sleep(2 ** attempt * 500); continue; }
        throw new Error(`Network error: ${e.cause?.code ?? e.message}`);
      }
      if (res.ok) return res.json();
      if (res.status === 410) throw Object.assign(new Error('cursor expired'), { status: 410 });
      if ((res.status === 429 || res.status >= 500) && attempt < 6) {
        const after = Number(res.headers.get('retry-after'));
        log(`  waiting (HTTP ${res.status}), attempt ${attempt}`);
        await sleep((after > 0 ? Math.min(after, 60) : 2 ** attempt) * 1000);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      const hint = { 401: 'The key was rejected. Check it was copied fully and has not expired.',
        403: 'The key does not have access. Use an Admin key (Console) or an Analytics key (Claude Enterprise).' }[res.status] ?? '';
      throw new Error(`HTTP ${res.status} ${body?.error?.type ?? ''} ${body?.error?.message ?? ''} ${hint}`.trim());
    }
  }

  // Fetch every page. If a cursor expires mid way (HTTP 410), start the query over.
  async function all(endpoint, params) {
    for (let tries = 0; tries < 3; tries++) {
      const rows = [];
      let page = null, refreshed = null;
      try {
        do {
          const r = await get(endpoint, { ...params, limit: 1000, ...(page ? { page } : {}) });
          rows.push(...r.data);
          refreshed = r.data_refreshed_at ?? refreshed;
          page = r.has_more ? r.next_page : null;
        } while (page);
        return { rows, refreshed };
      } catch (e) {
        if (e.status !== 410) throw e;
      }
    }
    throw new Error('Pagination kept expiring. Try again in a few minutes.');
  }
  return { all, calls: () => calls };
}

// ---------- collecting one organization ----------

export async function collectOrg({ client, months, hasher, log }) {
  const tables = Object.fromEntries(QUERIES.map((q) => [q.id, []]));
  const queries = [];
  let refreshed = null; // latest data_refreshed_at seen
  for (const q of QUERIES) {
    for (const m of months) {
      const params = { starting_at: m.starting_at, ending_at: m.ending_at, 'group_by[]': q.group_by };
      if (!q.monthly) Object.assign(params, { time_bucket_width: '1d', order_by: 'time', order: 'asc' });
      const r = await client.all(q.endpoint, params);
      tables[q.id].push(...r.rows.map((row) => normalize(row, q, hasher)));
      if (r.refreshed && (!refreshed || r.refreshed > refreshed)) refreshed = r.refreshed;
      queries.push({ id: q.id, month: m.month, rows: r.rows.length });
      log(`  ${q.id.padEnd(13)} ${m.month}  ${r.rows.length} rows`);
    }
  }
  return { tables, queries, data_refreshed_at: refreshed };
}

// ---------- summary ----------

const units = (s) => { // decimal cents string to BigInt millionths of a cent
  const neg = s.startsWith('-');
  const [i, f = ''] = s.replace('-', '').split('.');
  const v = BigInt(i) * 1_000_000n + BigInt((f + '000000').slice(0, 6));
  return neg ? -v : v;
};
const usd = (u) => '$' + (Number(u / 1_000_000n) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (a, b) => (b > 0n ? `${(Number((a * 1000n) / b) / 10).toFixed(1)}%` : 'n/a');
const sumBy = (rows, key, pick = (r) => units(r.amount_cents)) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) ?? 0n) + pick(r));
  return [...m].sort((a, b) => (b[1] > a[1] ? 1 : -1));
};

export function summarize(source, months) {
  const t = source.tables;
  const lines = [], warnings = [];
  const total = t.cost_daily.reduce((s, r) => s + units(r.amount_cents), 0n);
  lines.push(`  Spend by month`);
  for (const m of months) {
    const monthTotal = t.month_total.filter((r) => r.date.startsWith(m.month)).reduce((s, r) => s + units(r.amount_cents), 0n);
    const daily = t.cost_daily.filter((r) => r.date.startsWith(m.month)).reduce((s, r) => s + units(r.amount_cents), 0n);
    const gap = monthTotal > 0n && (daily - monthTotal) * 100n / monthTotal;
    if (gap && (gap > 1n || gap < -1n)) warnings.push(`daily_vs_total_gap:${m.month}`);
    if (!m.final) warnings.push(`month_not_final:${m.month}`);
    lines.push(`    ${m.month}   ${usd(monthTotal).padStart(14)}${m.final ? '' : '   still being revised by Anthropic'}`);
  }
  lines.push(`  Spend by model`);
  for (const [model, v] of sumBy(t.cost_daily, 'model').slice(0, 8)) {
    lines.push(`    ${String(model ?? 'tools and other').padEnd(28)} ${usd(v).padStart(14)}  ${pct(v, total).padStart(6)}`);
  }
  const u = t.usage_daily.reduce((a, r) => ({ read: a.read + r.cache_read,
    input: a.input + r.uncached_input + r.cache_read + r.cache_write_5m + r.cache_write_1h }), { read: 0, input: 0 });
  const share = (rows, key, value) => pct(rows.filter((r) => r[key] === value).reduce((s, r) => s + units(r.amount_cents), 0n), total);
  lines.push(`  Input tokens read from cache: ${u.input ? ((u.read / u.input) * 100).toFixed(1) + '%' : 'n/a'}`);
  lines.push(`  Share of spend: batch ${share(t.cost_daily, 'service_tier', 'batch')}, priority ${share(t.cost_daily, 'service_tier', 'priority_on_demand')}, ` +
    `US only processing ${share(t.cost_daily, 'inference_geo', 'us')}, fast mode ${share(t.modes_daily, 'speed', 'fast')}`);
  lines.push(`  Spend by product`);
  for (const [p, v] of sumBy(t.modes_daily, 'product').slice(0, 6)) lines.push(`    ${String(p ?? 'other').padEnd(28)} ${usd(v).padStart(14)}`);
  const count = (rows, key, f = () => true) => new Set(rows.filter(f).map((r) => r[key]).filter(Boolean)).size;
  lines.push(`  People with usage: ${count(t.people_daily, 'actor', (r) => r.actor_type === 'user_actor')}. ` +
    `API keys: ${count(t.usage_daily, 'api_key_id')}. Workspaces: ${count(t.usage_daily, 'workspace_id')}.`);
  return { lines, warnings };
}

// ---------- key input ----------

async function askHidden(question) {
  const { stdin, stdout } = process;
  stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let s = '';
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\u0003') process.exit(130); // Ctrl+C
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n');
          return resolve(s.trim());
        }
        s = c === '\u007f' ? s.slice(0, -1) : s + c;
      }
    };
    stdin.on('data', onData);
  });
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return (await rl.question(question).finally(() => rl.close())).trim().toLowerCase();
}

// ---------- main ----------

const HELP = `Usage: node latency-collect.mjs --audit <id> --salt <salt> [options]

  --audit <id>        Audit ID from Latency
  --salt <salt>       Hashing salt from Latency
  --months <n>        Full months to collect (default 3)
  --out <file>        Bundle path (default latency-bundle.json)
  --names-out <file>  Local name map path (default latency-names.local.json)
  --no-names          Skip the local name map
  --base-url <url>    API base URL (default https://api.anthropic.com)
  --bearer            Send the key as a Bearer token (OAuth or cloud tokens)
  --since <date>      Instead of full months, collect from this date (YYYY-MM-DD) to today. For testing.
  --pace-ms <n>       Minimum gap between requests (default 1100, the org limit is 60 per minute)

Set LATENCY_KEY to skip the key prompt.`;

export async function main(argv = process.argv.slice(2)) {
  const { values: o } = parseArgs({ args: argv, options: {
    audit: { type: 'string' }, salt: { type: 'string' }, months: { type: 'string', default: '3' },
    out: { type: 'string', default: 'latency-bundle.json' },
    'names-out': { type: 'string', default: 'latency-names.local.json' },
    'no-names': { type: 'boolean', default: false }, bearer: { type: 'boolean', default: false },
    'base-url': { type: 'string', default: 'https://api.anthropic.com' },
    'pace-ms': { type: 'string', default: '1100' }, help: { type: 'boolean', default: false }, since: { type: 'string' },
  } });
  if (o.help) return console.log(HELP);
  if (!o.audit || !TOKEN.test(o.audit)) throw new Error('Missing or invalid --audit. Use the command Latency sent you.');
  if (!o.salt || o.salt.length < 16) throw new Error('Missing or short --salt. Use the command Latency sent you.');

  const keys = [];
  const log = (s) => { for (const k of keys) s = s.split(k).join('[key]'); console.log(s); };
  const months = o.since ? sinceWindow(o.since) : monthWindows(Number(o.months));
  if (!months.length) throw new Error('No months in range. Anthropic data starts Jan 1 2026.');
  const names = o['no-names'] ? null : { actors: {}, api_keys: {}, workspaces: {} };
  const hasher = makeHasher(o.salt, names);

  log(`Latency collector ${VERSION}`);
  log(`Audit ${o.audit}. Collecting ${months[0].month} to ${months.at(-1).month}.`);
  log(`Use a Console Admin key, or a Claude Enterprise Analytics key. Input is hidden.\n`);

  const sources = [];
  while (true) {
    let key = sources.length === 0 ? process.env.LATENCY_KEY?.trim() : null;
    if (!key) {
      if (!process.stdin.isTTY) throw new Error('No key. Run this in a terminal, or set LATENCY_KEY.');
      key = await askHidden(`Key for organization ${sources.length + 1}: `);
    }
    if (!key) throw new Error('No key entered.');
    keys.push(key);
    if (/^sk-ant-api/.test(key)) log('Note: this looks like a regular API key. Usage data needs an Admin key.');
    const client = makeClient({ baseUrl: o['base-url'], key, auth: o.bearer ? 'bearer' : 'x-api-key', paceMs: Number(o['pace-ms']), log });
    log('Fetching. This usually takes under five minutes.');
    const org = await collectOrg({ client, months, hasher, log });
    sources.push({ provider: 'anthropic', org: sources.length + 1, key_kind: key.startsWith('sk-ant-admin') ? 'admin_key' : 'other_key',
      base_host: new URL(o['base-url']).host, requests_made: client.calls(), ...org });
    if (process.env.LATENCY_KEY || !process.stdin.isTTY) break;
    if ((await ask('\nAdd another Anthropic organization, for example Claude Enterprise as well as Console? [y/N] ')) !== 'y') break;
  }

  const warnings = [];
  for (const s of sources) {
    log(`\nSummary for organization ${s.org}`);
    const sum = summarize(s, months);
    sum.lines.forEach((l) => log(l));
    warnings.push(...sum.warnings.map((w) => `org${s.org}:${w}`));
  }

  const self = createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
  const bundle = {
    schema: 'latency-bundle/1',
    collector: { name: 'latency-collect', version: VERSION, sha256: self },
    audit_id: o.audit,
    salt_check: hasher.h('latency-salt-check'),
    created_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    months,
    warnings,
    sources,
  };
  assertSafe(bundle, keys);
  const json = JSON.stringify(bundle, null, 1);
  writeFileSync(o.out, json + '\n');
  if (names) writeFileSync(o['names-out'], JSON.stringify(names, null, 2) + '\n', { mode: 0o600 });

  log(`\nWrote ${o.out} (${(json.length / 1e6).toFixed(1)} MB, sha256 ${createHash('sha256').update(json + '\n').digest('hex').slice(0, 16)}).`);
  log('It holds totals only: no prompts, no outputs, no names, no emails. Open it and check before sending.');
  if (names) log(`Wrote ${o['names-out']}. Keep this one. It maps hashes back to your IDs and emails. Do not send it.`);
  if (warnings.some((w) => w.includes('month_not_final'))) log('Note: the latest month is still being revised. Rerun after the 7th for final numbers.');
  log('\nYou can now revoke the key you used.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => {
    const msg = String(e?.message ?? e).replace(/sk-ant-[A-Za-z0-9_-]+/g, '[key]');
    console.error(`\nStopped: ${msg}`);
    process.exit(1);
  });
}
