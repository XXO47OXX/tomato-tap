import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageDashboard } from '../src/usage/usage-dashboard.mjs';

function entry(overrides = {}) {
  return {
    route: '/direct/v1/messages',
    vendor: 'provider-a',
    model: 'kimi-for-coding',
    input: 100,
    output: 50,
    inputCached: 0,
    credits: 120,
    vendorCny: 0,
    ...overrides,
  };
}

test('aggregates by route/vendor/model and total', () => {
  const dash = createUsageDashboard();
  dash.record(entry({ provider: 'api.kimi.com' }));
  dash.record(entry({ model: 'deepseek-v4-flash', input: 200, output: 25 }));
  dash.record(entry({ route: '/oa/v1', vendor: 'relay', provider: 'api.example.test', model: 'model-a', input: 10, output: 5, credits: 12 }));
  const s = dash.snapshot();
  assert.equal(s.total.requests, 3);
  assert.equal(s.total.input, 310);
  assert.equal(s.total.output, 80);
  assert.equal(s.total.credits, 252);

  const direct = s.byRoute.find((r) => r.key === '/direct/v1/messages');
  assert.equal(direct.requests, 2);
  assert.equal(direct.input, 300);

  const kimi = s.byModel.find((m) => m.key === 'kimi-for-coding');
  assert.equal(kimi.output, 50);
  const relayV = s.byVendor.find((v) => v.key === 'relay');
  assert.equal(relayV.requests, 1);
  assert.equal(s.byProvider.find((p) => p.key === 'api.kimi.com').requests, 1);
  assert.equal(s.byProvider.find((p) => p.key === 'provider-a').requests, 1);
  assert.equal(s.byProvider.find((p) => p.key === 'api.example.test').requests, 1);
});

test('model aggregation is case-insensitive while usage remains complete', () => {
  const dash = createUsageDashboard();
  dash.record(entry({ model: 'MiniMax-M3', input: 10, output: 2 }));
  dash.record(entry({ model: 'minimax-m3', input: 20, output: 3 }));
  const rows = dash.snapshot().byModel.filter((item) => item.key === 'minimax-m3');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].requests, 2);
  assert.equal(rows[0].input, 30);
  assert.equal(rows[0].output, 5);
});

test('infers real provider host from key or deployment', () => {
  const dash = createUsageDashboard({
    providerByKey: (name) => (name === 'kimi-key' ? 'api.kimi.com' : ''),
    providerByDeployment: (id) => (id === 'deepseek-slot' ? 'api.deepseek.com' : ''),
  });
  dash.record(entry({ key: 'kimi-key' }));
  dash.record(entry({ key: '', deployment: 'deepseek-slot', model: 'deepseek-v4-flash' }));
  const s = dash.snapshot();
  assert.equal(s.byProvider.find((p) => p.key === 'api.kimi.com').requests, 1);
  assert.equal(s.byProvider.find((p) => p.key === 'api.deepseek.com').requests, 1);
});

test('infers route from vendor for legacy rows', () => {
  const dash = createUsageDashboard();
  dash.record(entry({ route: null, vendor: 'provider-a' }));
  dash.record(entry({ route: null, vendor: 'relay' }));
  const s = dash.snapshot();
  assert.equal(s.byRoute.find((r) => r.key === 'unknown').requests, 1);
  assert.equal(s.byRoute.find((r) => r.key === '/oa/v1').requests, 1);
});

test('estimates CNY from the price table and distinguishes recorded cny', () => {
  const estimate = { 'kimi-for-coding': { input: 4, output: 16, inputCached: 0.5 } };
  const dash = createUsageDashboard({ estimate });
  // 100 in (0 cached) + 50 out → 100/1e6*4 + 50/1e6*16 = 0.0004 + 0.0008 = 0.0012
  dash.record(entry());
  let s = dash.snapshot();
  assert.ok(Math.abs(s.total.estCny - 0.0012) < 1e-12);
  // cached tokens priced at inputCached rate
  dash.record(entry({ input: 100, inputCached: 100, output: 0 }));
  s = dash.snapshot();
  assert.ok(Math.abs(s.total.estCny - 0.0012 - 0.00005) < 1e-12);
  // recorded cny is tracked separately from the estimate
  dash.record(entry({ vendorCny: 0.5 }));
  s = dash.snapshot();
  assert.equal(s.total.cny, 0.5);
});

test('classifies official Kimi token pricing as priced accounting, not estimate', () => {
  const estimate = { 'kimi-for-coding': { input: 4, output: 16, inputCached: 0.5 } };
  const dash = createUsageDashboard({ estimate });
  dash.record(entry({ provider: 'api.kimi.com' }));
  const s = dash.snapshot();
  assert.ok(Math.abs(s.total.tokenCny - 0.0012) < 1e-12);
  assert.equal(s.total.estCny, 0);
  assert.match(dash.buildHtml(new Date()), /按价记账/);
});

test('deepseek peak/off-peak pricing by request time', () => {
  const estimate = {
    'deepseek-v4-flash': {
      inputCached: 0.05, input: 1.5, output: 4.5,
      peak: { inputCached: 0.1, input: 3.0, output: 9.0 },
    },
  };
  const costAt = (iso) => {
    const dash = createUsageDashboard({ estimate, now: () => new Date(iso) });
    dash.record(entry({
      model: 'deepseek-v4-flash',
      input: 1_000_000, output: 0, inputCached: 0, credits: 0,
    }));
    return dash.snapshot().total.estCny;
  };
  // off-peak: UTC 12:00 == Beijing 20:00 → base input 1.5
  assert.ok(Math.abs(costAt('2026-08-17T12:00:00Z') - 1.5) < 1e-9);
  // peak: UTC 02:00 == Beijing 10:00 → peak input 3.0
  assert.ok(Math.abs(costAt('2026-08-17T02:00:00Z') - 3.0) < 1e-9);
  // backfilled rows price at their own timestamp
  const dash = createUsageDashboard({ estimate });
  dash.record({ ...entry({ model: 'deepseek-v4-flash', input: 1_000_000, output: 0, inputCached: 0, credits: 0 }), _at: '2026-08-17T02:00:00Z' });
  assert.ok(Math.abs(dash.snapshot().total.estCny - 3.0) < 1e-9);
});

test('resets aggregates on UTC day change', () => {
  let current = new Date('2026-08-16T23:59:59Z');
  const dash = createUsageDashboard({ now: () => current });
  dash.record(entry());
  assert.equal(dash.snapshot().total.requests, 1);
  current = new Date('2026-08-17T00:00:01Z');
  dash.record(entry());
  const s = dash.snapshot();
  assert.equal(s.date, '2026-08-17');
  assert.equal(s.total.requests, 1); // buckets were reset at midnight
  assert.equal(s.byModel.length, 1);
});

test('infers vendor from key via vendorByKey for legacy failure rows', () => {
  const dash = createUsageDashboard({
    vendorByKey: (name) => (name.includes('example') ? 'relay' : null),
  });
  dash.record({ key: 'tomato_tap_relay_example_grok', status: 524, error: true, model: 'model-a' });
  const s = dash.snapshot();
  assert.equal(s.byVendor.find((v) => v.key === 'relay').requests, 1);
  assert.equal(s.byRoute.find((r) => r.key === '/oa/v1').requests, 1);
  assert.ok(!s.byRoute.some((r) => r.key === 'unknown'));
  // rows that still resolve to nothing are bucketed under "unknown" and
  // rendered with the legacy-format label
  dash.record({ key: 'some_old_key', status: 500, error: true });
  const s2 = dash.snapshot();
  assert.equal(s2.byRoute.find((r) => r.key === 'unknown').requests, 1);
  assert.match(dash.buildHtml(new Date()), /unknown（旧格式）/);
});

test('buildHtml renders dashboard sections and escapes values', () => {
  const dash = createUsageDashboard();
  dash.record(entry({ model: 'kimi-for-coding <script>' }));
  const html = dash.buildHtml(new Date('2026-08-16T12:00:00Z'));
  assert.match(html, /Tomato Tap 用量面板/);
  assert.match(html, /按接口（route）/);
  assert.match(html, /按模型/);
  assert.match(html, /按提供商（上游主机 \/ 本地部署）/);
  assert.match(html, /kimi-for-coding &lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('scanTodayFromLog backfills only today rows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-dash-'));
  const path = join(dir, 'usage.log');
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(path, [
    JSON.stringify({ ts: `${today}T00:00:01.000Z`, route: '/direct/v1/messages', vendor: 'provider-a', model: 'kimi-for-coding', input: 10, output: 5, input_cached: 0, credits: 12, vendor_cny: 0 }),
    JSON.stringify({ ts: `${today}T01:00:01.000Z`, vendor: 'relay', model: 'model-a', input: 30, output: 10, input_cached: 0, credits: 32, vendor_cny: 0 }),
    JSON.stringify({ ts: '2026-01-01T00:00:01.000Z', vendor: 'mimo', model: 'mimo-v2.5', input: 999, output: 999, input_cached: 0, credits: 1, vendor_cny: 0 }),
    'not json\n',
  ].join('\n'));
  try {
    const dash = createUsageDashboard();
    const n = await dash.scanTodayFromLog(path);
    assert.equal(n, 2);
    const s = dash.snapshot();
    assert.equal(s.total.requests, 2);
    assert.equal(s.total.input, 40);
    assert.equal(s.byModel.find((m) => m.key === 'kimi-for-coding').output, 5);
    // Explicit routes remain stable during ledger backfill.
    assert.equal(s.byRoute.find((r) => r.key === '/direct/v1/messages').requests, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanTodayFromLog can backfill a rotated archive and active ledger together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-dash-rotated-'));
  const active = join(dir, 'usage.log');
  const archive = `${active}.2026-08-30.jsonl`;
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(archive, `${JSON.stringify({
    ts: `${today}T00:00:01.000Z`, vendor: 'relay', model: 'model-a', input: 10, output: 1,
  })}\n`);
  writeFileSync(active, `${JSON.stringify({
    ts: `${today}T00:01:01.000Z`, vendor: 'relay', model: 'model-a', input: 20, output: 2,
  })}\n`);
  try {
    const dash = createUsageDashboard();
    assert.equal(await dash.scanTodayFromLog([archive, active]), 2);
    assert.equal(dash.snapshot().total.requests, 2);
    assert.equal(dash.snapshot().total.input, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
