// A small stand in for the Anthropic Usage and Cost Analytics API, built from the documented
// request and response shapes. It aggregates a fixed list of facts by whatever group_by[] asks for,
// pages 3 rows at a time, and can inject a 429 and an expired cursor (410).
import { createServer } from 'node:http';

export const KEY = 'sk-ant-admin01-TESTSECRET-abc123XYZ';
const TOKEN_TYPES = [
  ['uncached_input_tokens', 'uncached'],
  ['cache_creation.ephemeral_5m_input_tokens', 'cw5'],
  ['cache_creation.ephemeral_1h_input_tokens', 'cw1h'],
  ['cache_read_input_tokens', 'read'],
  ['output_tokens', 'out'],
];
const JANE = { type: 'user_actor', user_id: 'user_01Jane', email_address: 'Jane.Doe@Example.com', name: 'Jane Doe', deleted: false };
const KEY_ACTOR = { type: 'api_actor', api_key_id: 'apikey_01Prod' };

// One fact per combination per day. Costs are in millionths of a cent (integers) to keep sums exact.
function factsFor(day) {
  const base = { date: day, inference_geo: null, context_window: '0-200k', speed: 'standard' };
  return [
    { ...base, model: 'claude-opus-5-5', workspace_id: 'wrkspc_01Prod', api_key_id: 'apikey_01Prod', service_tier: 'standard',
      product: 'messages_api', actor: KEY_ACTOR, uncached: 1000, cw5: 200, cw1h: 0, read: 3000, out: 500, requests: 10,
      cost: { uncached: 500_000000n, cw5: 125_000000n, cw1h: 0n, read: 150_000000n, out: 1250_000000n }, web: 20_000000n },
    { ...base, model: 'claude-haiku-5-5', workspace_id: 'wrkspc_01Jobs', api_key_id: 'apikey_01Batch', service_tier: 'batch',
      inference_geo: 'us', product: 'message_batches_api', actor: { type: 'api_actor', api_key_id: 'apikey_01Batch' },
      uncached: 5000, cw5: 0, cw1h: 0, read: 0, out: 800, requests: 40,
      cost: { uncached: 27_500000n, cw5: 0n, cw1h: 0n, read: 0n, out: 22_000000n }, web: 0n },
    { ...base, model: 'claude-opus-5-5', workspace_id: 'wrkspc_01Code', api_key_id: null, service_tier: 'standard', speed: 'fast',
      product: 'claude_code', actor: JANE, uncached: 400, cw5: 100, cw1h: 50, read: 9000, out: 300, requests: 25,
      cost: { uncached: 300_000000n, cw5: 90_000000n, cw1h: 70_000000n, read: 60_000000n, out: 900_000000n }, web: 0n },
    // Code execution: no model, no tier.
    { ...base, model: null, workspace_id: 'wrkspc_01Prod', api_key_id: 'apikey_01Prod', service_tier: null, context_window: null,
      speed: null, product: null, actor: null, uncached: 0, cw5: 0, cw1h: 0, read: 0, out: 0, requests: 2,
      cost: { uncached: 0n, cw5: 0n, cw1h: 0n, read: 0n, out: 0n }, web: 5_000000n },
  ];
}

const cents = (v) => `${v / 1_000000n}.${String(v % 1_000000n).padStart(6, '0')}`;
const DIMS = ['actor', 'actor_type', 'api_key_id', 'context_window', 'inference_geo', 'model', 'product', 'service_tier', 'speed', 'workspace_id'];

function aggregate(endpoint, q) {
  const start = new Date(q.get('starting_at'));
  const end = new Date(q.get('ending_at'));
  const daily = q.get('time_bucket_width') === '1d';
  const groupBy = q.getAll('group_by[]');
  const dims = groupBy.filter((d) => DIMS.includes(d));
  const facts = [];
  for (const d of [1, 15]) { // two active days per month keeps fixtures small
    const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), d));
    if (day >= start && day < end) facts.push(...factsFor(day));
  }
  const rows = new Map();
  for (const f of facts) {
    const group = Object.fromEntries(DIMS.map((d) => [d, null]));
    for (const d of dims) group[d] = d === 'actor_type' ? f.actor?.type ?? null : f[d];
    const s = daily ? f.date : start;
    const e = daily ? new Date(+f.date + 86_400_000) : end;
    const k = JSON.stringify([s, group]);
    const r = rows.get(k) ?? { starting_at: s.toISOString().replace('.000', ''), ending_at: e.toISOString().replace('.000', ''), group, facts: [] };
    r.facts.push(f);
    rows.set(k, r);
  }
  const out = [];
  for (const r of rows.values()) {
    const sum = (fn) => r.facts.reduce((a, f) => a + fn(f), typeof fn(r.facts[0]) === 'bigint' ? 0n : 0);
    if (endpoint === 'usage') {
      out.push({ starting_at: r.starting_at, ending_at: r.ending_at, group: r.group, usage: {
        uncached_input_tokens: sum((f) => f.uncached), cache_read_input_tokens: sum((f) => f.read), output_tokens: sum((f) => f.out),
        cache_creation: { ephemeral_5m_input_tokens: sum((f) => f.cw5), ephemeral_1h_input_tokens: sum((f) => f.cw1h) },
        server_tool_use: { web_search_requests: 0 }, requests: sum((f) => f.requests),
        total_tokens: sum((f) => f.uncached + f.read + f.out + f.cw5 + f.cw1h) } });
      continue;
    }
    const row = (extra, amount, requests) => out.push({ starting_at: r.starting_at, ending_at: r.ending_at,
      group: { ...r.group, cost_type: null, token_type: null, ...extra },
      cost: { currency: 'USD', amount: cents(amount), list_amount: cents(amount + amount / 4n), requests } });
    if (groupBy.includes('token_type')) {
      for (const [type, k] of TOKEN_TYPES) row({ cost_type: 'tokens', token_type: type }, sum((f) => f.cost[k]), null);
      row({ cost_type: 'web_search' }, sum((f) => f.web), null);
    } else {
      row({}, sum((f) => Object.values(f.cost).reduce((a, b) => a + b, 0n) + f.web), sum((f) => f.requests));
    }
  }
  return out;
}

export function startMock({ fail429 = true, fail410 = true } = {}) {
  const log = [];
  let sent429 = !fail429;
  let sent410 = !fail410;
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    log.push({ path: url.pathname, query: url.search, headers: req.headers });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.headers['x-api-key'] !== KEY) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (req.headers['anthropic-beta'] !== 'analytics-usage-cost-2026-08-24' || !req.headers['anthropic-version']) {
      return send(400, { type: 'error', error: { type: 'invalid_request_error', message: 'missing headers' } });
    }
    const m = url.pathname.match(/^\/v1\/organizations\/analytics\/(usage|cost)$/);
    if (!m) return send(404, { type: 'error', error: { type: 'not_found_error', message: 'not found' } });
    if (!sent429) { sent429 = true; return send(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '0.01' }); }
    const page = Number((url.searchParams.get('page') ?? 'p0').slice(1));
    if (page > 0 && !sent410 && url.searchParams.getAll('group_by[]').includes('token_type')) {
      sent410 = true;
      return send(410, { type: 'error', error: { type: 'cursor_expired', message: 'cursor expired' } });
    }
    const rows = aggregate(m[1], url.searchParams);
    const size = 3;
    const slice = rows.slice(page * size, page * size + size);
    const more = (page + 1) * size < rows.length;
    send(200, { data: slice, has_more: more, next_page: more ? `p${page + 1}` : null, data_refreshed_at: '2026-11-06T04:00:00Z' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, log, close: () => new Promise((r) => server.close(r)),
  })));
}
