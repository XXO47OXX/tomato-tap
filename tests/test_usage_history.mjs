import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsageHistory } from '../src/usage/usage-history.mjs';

function row(overrides = {}) {
  return {
    ts: '2026-08-10T02:00:00.000Z',
    route: '/direct/v1/messages',
    vendor: 'provider-a',
    model: 'kimi-for-coding',
    input: 100,
    output: 50,
    input_cached: 0,
    credits: 120,
    vendor_cny: 0,
    ...overrides,
  };
}

function makeLog(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'usage-hist-'));
  const path = join(dir, 'usage.log');
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, path };
}

test('sync aggregates by date and combo, query by day/model/route', async () => {
  const { dir, path } = makeLog([
    row({ provider: 'api.kimi.com' }),
    row({ ts: '2026-08-10T03:00:00.000Z', provider: 'api.deepseek.com', model: 'deepseek-v4-flash', input: 200, output: 25 }),
    row({ ts: '2026-08-11T01:00:00.000Z', model: 'kimi-k3', input: 500, output: 100 }),
    row({ ts: '2026-08-12T01:00:00.000Z', route: '/oa/v1', vendor: 'relay', model: 'model-a', input: 10, output: 5 }),
  ]);
  try {
    const hist = createUsageHistory({ path });
    const n = await hist.sync();
    assert.equal(n, 4);
    assert.deepEqual(hist.snapshotStats(), { days: 3, rows: 4, offset: statSync(path).size, syncedAt: hist.snapshotStats().syncedAt });

    // 按天汇总 direct 接口
    const byDay = hist.query({ from: '2026-08-10', to: '2026-08-12', dimension: 'date', route: '/direct/v1/messages' });
    assert.equal(byDay.total.requests, 3);
    assert.equal(byDay.total.input, 800);
    assert.equal(byDay.rows.length, 2); // 08-10 和 08-11
    assert.deepEqual(byDay.rows.map((r) => r.key).sort(), ['2026-08-10', '2026-08-11']);

    // 按模型：direct 接口的 kimi/ds 分布
    const byModel = hist.query({ from: '2026-08-10', to: '2026-08-12', dimension: 'model', route: '/direct/v1/messages' });
    assert.deepEqual(byModel.rows.map((r) => r.key).sort(), ['deepseek-v4-flash', 'kimi-for-coding', 'kimi-k3']);
    const kimi = byModel.rows.find((r) => r.key === 'kimi-for-coding');
    assert.equal(kimi.input, 100);
    assert.ok(kimi.tokenCny > 0);
    assert.equal(kimi.estCny, 0);

    const byProvider = hist.query({
      from: '2026-08-10', to: '2026-08-12', dimension: 'provider', route: '/direct/v1/messages',
    });
    assert.equal(byProvider.rows.find((r) => r.key === 'api.kimi.com').requests, 1);
    assert.equal(byProvider.rows.find((r) => r.key === 'api.deepseek.com').requests, 1);
    const deepseekOnly = hist.query({
      from: '2026-08-10', to: '2026-08-12', provider: 'api.deepseek.com', dimension: 'model',
    });
    assert.equal(deepseekOnly.total.requests, 1);
    assert.equal(deepseekOnly.rows[0].key, 'deepseek-v4-flash');

    // 按月合并
    const byMonth = hist.query({ from: '2026-08-01', to: '2026-08-31', granularity: 'month', dimension: 'date' });
    assert.equal(byMonth.rows.length, 1);
    assert.equal(byMonth.rows[0].key, '2026-08');
    assert.equal(byMonth.total.requests, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history dimension selector is labeled and submits immediately', async () => {
  const { dir, path } = makeLog([row({ provider: 'api.kimi.com' })]);
  try {
    const hist = createUsageHistory({ path });
    await hist.sync();
    const params = {
      period: 'custom', from: '2026-08-10', to: '2026-08-10',
      granularity: 'day', dimension: 'model', route: '', provider: '', vendor: '', model: '',
    };
    const result = hist.query(params);
    const html = hist.buildHtml(result, params);
    assert.match(html, /汇总维度 <select name="dimension" onchange="this\.form\.requestSubmit\(\)">/);
    assert.match(html, /<option value="model" selected>按模型<\/option>/);
    assert.match(html, /切换统计维度：/);
    assert.match(html, /class="active" href="\/__usage\?[^\"]*dimension=model[^\"]*">按模型<\/a>/);
    assert.match(html, />按提供商<\/a>/);
    assert.match(html, /<th>模型<\/th>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history merges model names that differ only by case', async () => {
  const { dir, path } = makeLog([
    row({ model: 'MiniMax-M3', input: 10, output: 2 }),
    row({ ts: '2026-08-10T03:00:00.000Z', model: 'minimax-m3', input: 20, output: 3 }),
  ]);
  try {
    const hist = createUsageHistory({ path });
    await hist.sync();
    const result = hist.query({
      from: '2026-08-10', to: '2026-08-10', dimension: 'model', model: 'MINIMAX-M3',
    });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].key, 'minimax-m3');
    assert.equal(result.rows[0].requests, 2);
    assert.equal(result.rows[0].input, 30);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incremental sync reads only appended rows', async () => {
  const { dir, path } = makeLog([row()]);
  try {
    const hist = createUsageHistory({ path });
    await hist.sync();
    assert.equal(hist.query({ dimension: 'date' }).total.requests, 1);
    appendFileSync(path, JSON.stringify(row({ ts: '2026-08-13T01:00:00.000Z' })) + '\n');
    const n = await hist.sync();
    assert.equal(n, 1); // 只读新增行
    assert.equal(hist.query({ dimension: 'date' }).total.requests, 2);
    // 幂等：再次 sync 不重复读
    assert.equal(await hist.sync(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('vendor inference for legacy key-only rows and range filters', async () => {
  const { dir, path } = makeLog([
    { ts: '2026-08-14T01:00:00.000Z', status: 524, error: true, key: 'tomato_tap_relay_example_grok' },
    row({ ts: '2026-08-15T01:00:00.000Z', model: 'kimi-for-coding' }),
  ]);
  try {
    const hist = createUsageHistory({
      path,
      vendorByKey: (name) => (name && name.includes('example') ? 'relay' : ''),
      providerByKey: (name) => (name && name.includes('example') ? 'example.example' : ''),
    });
    await hist.sync();
    // 旧格式失败行经 key 推断 → relay → /oa/v1
    const relay = hist.query({ from: '2026-08-01', to: '2026-08-31', dimension: 'route' });
    assert.equal(relay.rows.find((r) => r.key === '/oa/v1').requests, 1);
    const provider = hist.query({ from: '2026-08-01', to: '2026-08-31', dimension: 'provider' });
    assert.equal(provider.rows.find((r) => r.key === 'example.example').requests, 1);
    // 范围过滤：只看 08-15
    const oneDay = hist.query({ from: '2026-08-15', to: '2026-08-15', dimension: 'model' });
    assert.equal(oneDay.total.requests, 1);
    assert.equal(oneDay.rows[0].key, 'kimi-for-coding');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('week/month presets and weekly granularity use inclusive UTC ranges', async () => {
  const { dir, path } = makeLog([
    row({ ts: '2026-08-02T01:00:00.000Z' }), // previous month/week
    row({ ts: '2026-08-03T01:00:00.000Z' }), // Monday
    row({ ts: '2026-08-09T23:00:00.000Z' }), // Sunday
    row({ ts: '2026-08-10T01:00:00.000Z' }), // next Monday
  ]);
  try {
    const hist = createUsageHistory({ path, now: () => new Date('2026-08-12T12:00:00.000Z') });
    await hist.sync();
    const week = hist.query({ period: 'week' });
    assert.equal(week.from, '2026-08-10');
    assert.equal(week.to, '2026-08-12');
    assert.equal(week.total.requests, 1);
    const month = hist.query({ period: 'month', granularity: 'week' });
    assert.equal(month.from, '2026-08-01');
    assert.equal(month.total.requests, 4);
    assert.deepEqual(month.rows.map((item) => item.key), ['2026-W31', '2026-W32', '2026-W33']);
    const custom = hist.query({ from: '2026-08-03', to: '2026-08-09' });
    assert.equal(custom.total.requests, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incomplete tail is retried and truncation rebuilds without duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-hist-tail-'));
  const path = join(dir, 'usage.log');
  try {
    writeFileSync(path, JSON.stringify(row()), 'utf8');
    const hist = createUsageHistory({ path });
    assert.equal(await hist.sync(), 0);
    appendFileSync(path, '\n');
    assert.equal(await hist.sync(), 1);
    assert.equal(hist.query({ period: 'all' }).total.requests, 1);
    writeFileSync(path, `${JSON.stringify(row({ ts: '2026-09-01T00:00:00.000Z', input: 1 }))}\n`);
    assert.equal(await hist.sync(), 1);
    const all = hist.query({ period: 'all' });
    assert.equal(all.total.requests, 1);
    assert.equal(all.total.input, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history follows inode-preserving ledger rotation without double counting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-hist-rotate-'));
  const path = join(dir, 'usage.log');
  const archive = `${path}.2026-08-30.jsonl`;
  try {
    writeFileSync(path, `${JSON.stringify(row())}\n`);
    const hist = createUsageHistory({ path });
    assert.equal(await hist.sync(), 1);
    renameSync(path, archive);
    writeFileSync(path, `${JSON.stringify(row({ ts: '2026-08-11T01:00:00.000Z' }))}\n`);
    assert.equal(await hist.sync(), 1);
    assert.equal(hist.query({ period: 'all' }).total.requests, 2);
    assert.equal(await hist.sync(), 0);
    assert.equal(hist.query({ period: 'all' }).total.requests, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
