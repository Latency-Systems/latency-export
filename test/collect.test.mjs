import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertSafe, makeHasher, monthWindows, tok } from '../latency-collect.mjs';
import { KEY, startMock } from './mock-api.mjs';

const SCRIPT = fileURLToPath(new URL('../latency-collect.mjs', import.meta.url));
const SALT = 'test-salt-0123456789abcdef';

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

describe('full run against the mock API', () => {
  let mock, dir, result, bundle, bundleText, names;
  before(async () => {
    mock = await startMock();
    dir = mkdtempSync(join(tmpdir(), 'latency-collect-'));
    result = await run(['--audit', 'test-001', '--salt', SALT, '--base-url', mock.url, '--pace-ms', '0',
      '--out', join(dir, 'bundle.json'), '--names-out', join(dir, 'names.json')], { LATENCY_KEY: KEY });
    bundleText = readFileSync(join(dir, 'bundle.json'), 'utf8');
    bundle = JSON.parse(bundleText);
    names = JSON.parse(readFileSync(join(dir, 'names.json'), 'utf8'));
  });
  after(() => mock.close());

  test('exits cleanly', () => assert.equal(result.code, 0, result.stderr));

  test('key never appears in output or files', () => {
    for (const text of [result.stdout, result.stderr, bundleText, JSON.stringify(names)]) assert.ok(!text.includes(KEY));
    assert.ok(!/sk-ant-/.test(bundleText));
  });

  test('bundle has no emails, names or raw IDs', () => {
    for (const s of ['@', 'Jane', 'Doe', 'user_01Jane', 'apikey_01', 'wrkspc_01']) assert.ok(!bundleText.includes(s), s);
  });

  test('local name map lets the client reverse the hashes', () => {
    const jane = Object.values(names.actors).find((a) => a.id === 'user_01Jane');
    assert.equal(jane.email, 'jane.doe@example.com');
    assert.ok(Object.values(names.api_keys).includes('apikey_01Prod'));
    assert.ok(Object.values(names.workspaces).includes('wrkspc_01Code'));
  });

  test('only calls the two analytics endpoints, with the required headers', () => {
    for (const r of mock.log) {
      assert.match(r.path, /^\/v1\/organizations\/analytics\/(usage|cost)$/);
      assert.equal(r.headers['anthropic-beta'], 'analytics-usage-cost-2026-08-24');
      assert.ok(r.headers['anthropic-version']);
    }
  });

  test('collects every query for every month', () => {
    const s = bundle.sources[0];
    assert.equal(s.queries.length, 5 * bundle.months.length);
    assert.equal(bundle.months.length, 3);
  });

  test('expired cursor restarts the query without duplicate rows', () => {
    const rows = bundle.sources[0].tables.cost_daily;
    const keys = rows.map((r) => JSON.stringify(r));
    assert.equal(new Set(keys).size, keys.length);
    // 4 facts a day, 2 days a month, 3 months, 6 cost rows each (5 token types and web search)
    assert.equal(rows.length, 4 * 2 * 3 * 6);
  });

  test('same ID hashes the same way across tables', () => {
    const t = bundle.sources[0].tables;
    const keyHash = t.usage_daily.find((r) => r.service_tier === 'batch').api_key_id;
    assert.ok(t.people_daily.some((r) => r.actor_type === 'api_actor' && r.actor === keyHash));
  });

  test('amounts stay exact decimal strings and daily rows match monthly totals', () => {
    const t = bundle.sources[0].tables;
    assert.ok(t.cost_daily.every((r) => /^\d+\.\d{6}$/.test(r.amount_cents)));
    assert.ok(!bundle.warnings.some((w) => w.includes('daily_vs_total_gap')), bundle.warnings.join(','));
  });

  test('prints a readable summary', () => {
    assert.match(result.stdout, /Spend by model/);
    assert.match(result.stdout, /claude-opus-5-5/);
    assert.match(result.stdout, /People with usage: 1. API keys: 2. Workspaces: 3./);
    assert.match(result.stdout, /Do not send it/);
  });

  test('client facing output has no dashes as punctuation', () => {
    assert.ok(!/[–—]| - /.test(result.stdout));
  });
});

test('wrong key stops without writing a bundle or echoing the key', async () => {
  const mock = await startMock();
  const dir = mkdtempSync(join(tmpdir(), 'latency-collect-'));
  const wrong = 'sk-ant-admin01-WRONGKEY-999';
  const r = await run(['--audit', 'x', '--salt', SALT, '--base-url', mock.url, '--pace-ms', '0', '--out', join(dir, 'b.json')],
    { LATENCY_KEY: wrong });
  await mock.close();
  assert.equal(r.code, 1);
  assert.match(r.stderr, /HTTP 401/);
  assert.ok(!r.stdout.includes(wrong) && !r.stderr.includes(wrong));
  assert.ok(!existsSync(join(dir, 'b.json')));
});

test('refuses to run without audit and salt', async () => {
  const r = await run(['--audit', 'x'], { LATENCY_KEY: KEY });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /salt/);
});

test('refuses plain http to a remote host', async () => {
  const r = await run(['--audit', 'x', '--salt', SALT, '--base-url', 'http://example.com'], { LATENCY_KEY: KEY });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /https/);
});

test('assertSafe blocks free text, emails and keys', () => {
  assert.throws(() => assertSafe({ a: 'hello world' }), /unexpected text/);
  assert.throws(() => assertSafe({ a: 'x@y.com' }), /email/);
  assert.throws(() => assertSafe({ a: 'sk-ant-api03-zzz' }), /key/);
  assert.throws(() => assertSafe({ a: 'abc' }, ['abc']), /your key/);
  assert.doesNotThrow(() => assertSafe({ a: 'claude-opus-5-5', b: '2026-09-01T00:00:00Z', c: '41280.000000', d: null, e: 3 }));
});

test('tok turns anything unexpected into "other"', () => {
  assert.equal(tok('claude-sonnet-5-5'), 'claude-sonnet-5-5');
  assert.equal(tok('cache_creation.ephemeral_1h_input_tokens'), 'cache_creation.ephemeral_1h_input_tokens');
  assert.equal(tok('My secret project'), 'other');
  assert.equal(tok('sk-ant-admin01-x'), 'other');
  assert.equal(tok(null), null);
});

test('hashes are stable per salt and differ across salts', () => {
  const a = makeHasher('salt-one-0123456789', null).h('apikey_1');
  assert.equal(a, makeHasher('salt-one-0123456789', null).h('apikey_1'));
  assert.notEqual(a, makeHasher('salt-two-0123456789', null).h('apikey_1'));
  assert.match(a, /^h_[0-9a-f]{32}$/);
});

test('month windows: last 3 full months, latest marked not final until the 7th', () => {
  const nov6 = monthWindows(3, Date.UTC(2026, 10, 6));
  assert.deepEqual(nov6.map((m) => m.month), ['2026-08', '2026-09', '2026-10']);
  assert.deepEqual(nov6.map((m) => m.final), [true, true, false]);
  assert.equal(nov6[0].starting_at, '2026-08-01T00:00:00Z');
  assert.equal(nov6[2].ending_at, '2026-11-01T00:00:00Z');
  assert.equal(monthWindows(3, Date.UTC(2026, 10, 9)).at(-1).final, true);
  assert.deepEqual(monthWindows(3, Date.UTC(2026, 1, 10)).map((m) => m.month), ['2026-01']); // no data before 2026
});

test('script stays short enough to read', () => {
  const lines = readFileSync(SCRIPT, 'utf8').split('\n').length;
  assert.ok(lines <= 400, `${lines} lines`);
});
