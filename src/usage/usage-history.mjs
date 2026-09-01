// Incremental date/route/vendor/provider/model index over usage ledgers.

import { createReadStream, statSync } from 'node:fs';
import { MODEL_PRICING, formatUnitPrice } from './model-pricing.mjs';
import { listUsageLogFiles } from './usage-ledger.mjs';
import {
  ROUTE_BY_VENDOR,
  addUsageBucket,
  addUsageEntry,
  escapeHtml,
  formatCostParts,
  freshUsageBucket,
  normalizeUsageModel,
  usageCss,
} from './usage-dashboard.mjs';

const SEP = '\u0000';
const comboKey = (route, vendor, provider, model) => [
  route || '', vendor || '', provider || '', model || '',
].join(SEP);
function splitCombo(key) {
  const [route, vendor, provider, model] = key.split(SEP);
  return {
    route: route || '',
    vendor: vendor || '',
    provider: provider || '',
    model: model || '',
  };
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateText(date) {
  return date.toISOString().slice(0, 10);
}

function utcDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function addUtcDays(date, days) {
  return new Date(date.getTime() + days * 86_400_000);
}

function isoWeekKey(dateTextValue) {
  const date = utcDate(dateTextValue);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86_400_000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function resolveUsageRange({ period = '', from = '', to = '', now = new Date() } = {}) {
  const today = dateText(now);
  let normalizedPeriod = String(period || '').toLowerCase();
  let start = String(from || '').trim();
  let end = String(to || '').trim();

  if (start || end) normalizedPeriod = 'custom';
  // Preserve query({}) as the all-history API.
  if (!normalizedPeriod) normalizedPeriod = 'all';
  if (!['today', 'week', 'month', 'custom', 'all'].includes(normalizedPeriod)) {
    throw new Error(`unsupported period: ${period}`);
  }

  if (normalizedPeriod === 'today') start = end = today;
  if (normalizedPeriod === 'week') {
    const date = utcDate(today);
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    start = dateText(addUtcDays(date, -mondayOffset));
    end = today;
  }
  if (normalizedPeriod === 'month') {
    start = `${today.slice(0, 7)}-01`;
    end = today;
  }
  if (normalizedPeriod === 'all') start = end = '';
  if (normalizedPeriod === 'custom') {
    if (start && !validDate(start)) throw new Error(`invalid from date: ${start}`);
    if (end && !validDate(end)) throw new Error(`invalid to date: ${end}`);
    if (!end) end = today;
  }
  if (start && end && start > end) throw new Error('from date must not be after to date');
  return { period: normalizedPeriod, from: start, to: end };
}

export function createUsageHistory({
  path,
  pricing = MODEL_PRICING,
  now,
  vendorByKey,
  providerByKey,
  providerByDeployment,
} = {}) {
  const clock = now || (() => new Date());
  const byDate = new Map();
  const vendorCache = new Map();
  const providerCache = new Map();
  const sources = new Map();
  let syncedAt = 0;
  let syncPromise = null;

  function resolveVendor(key) {
    if (!key) return '';
    if (vendorCache.has(key)) return vendorCache.get(key);
    const vendor = typeof vendorByKey === 'function' ? vendorByKey(key) || '' : '';
    vendorCache.set(key, vendor);
    return vendor;
  }

  function resolveProvider(key, deployment, vendor) {
    const cacheKey = `${key || ''}\u0000${deployment || ''}`;
    if (providerCache.has(cacheKey)) return providerCache.get(cacheKey);
    const provider = (key && typeof providerByKey === 'function' ? providerByKey(key) : '')
      || (deployment && typeof providerByDeployment === 'function'
        ? providerByDeployment(deployment)
        : '')
      || vendor
      || 'unknown';
    providerCache.set(cacheKey, provider);
    return provider;
  }

  function bucketFor(date, key) {
    let day = byDate.get(date);
    if (!day) {
      day = new Map();
      byDate.set(date, day);
    }
    let bucket = day.get(key);
    if (!bucket) {
      bucket = freshUsageBucket();
      day.set(key, bucket);
    }
    return bucket;
  }

  function recordRow(row) {
    if (!row || typeof row !== 'object' || !row.ts) return false;
    const date = String(row.ts).slice(0, 10);
    if (!validDate(date)) return false;
    const vendor = row.vendor || resolveVendor(row.key) || '';
    const provider = row.provider || resolveProvider(row.key, row.deployment, vendor);
    const route = row.route || ROUTE_BY_VENDOR[vendor] || 'unknown';
    const model = normalizeUsageModel(row.model);
    const entry = {
      ...row,
      route,
      vendor,
      provider,
      inputCached: row.inputCached ?? row.input_cached,
      inputMiss: row.inputMiss ?? row.input_miss,
      vendorCny: row.vendorCny ?? row.vendor_cny,
      _at: row.ts,
    };
    addUsageEntry(
      bucketFor(date, comboKey(route, vendor, provider, model)),
      entry,
      pricing,
      new Date(row.ts),
    );
    return true;
  }

  async function sync() {
    if (syncPromise) return syncPromise;
    syncPromise = (async () => {
      const paths = await listUsageLogFiles(path);
      const files = [];
      for (const filePath of paths) {
        try {
          const stat = statSync(filePath);
          const identity = `${stat.dev}:${stat.ino || filePath}`;
          files.push({ path: filePath, identity, size: stat.size });
        } catch { /* file rotated or removed between listing and stat */ }
      }

      const liveIdentities = new Set(files.map((file) => file.identity));
      const sourceRemoved = [...sources.keys()].some((identity) => !liveIdentities.has(identity));
      const sourceTruncated = files.some((file) => (
        sources.has(file.identity) && file.size < sources.get(file.identity).offset
      ));
      if (sourceRemoved || sourceTruncated) {
        byDate.clear();
        vendorCache.clear();
        providerCache.clear();
        sources.clear();
      }
      let count = 0;
      for (const file of files) {
        const source = sources.get(file.identity) || { offset: 0, path: file.path };
        source.path = file.path;
        sources.set(file.identity, source);
        if (file.size === source.offset) continue;

        const stream = createReadStream(file.path, {
          start: source.offset,
          end: file.size - 1,
          encoding: 'utf8',
        });
        let pending = '';
        for await (const chunk of stream) {
          pending += chunk;
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line) continue;
            try {
              if (recordRow(JSON.parse(line))) count++;
            } catch { /* malformed complete line */ }
          }
        }
        // Do not advance past an incomplete final line; the next sync retries
        // it after the writer appends the terminating newline.
        source.offset = file.size - Buffer.byteLength(pending, 'utf8');
      }
      if (count > 0 || sourceRemoved || sourceTruncated) syncedAt = Date.now();
      return count;
    })();
    try {
      return await syncPromise;
    } finally {
      syncPromise = null;
    }
  }

  function query({
    period = '', from = '', to = '', granularity = 'day', dimension = 'date',
    route = '', vendor = '', provider = '', model = '',
  } = {}) {
    const range = resolveUsageRange({ period, from, to, now: clock() });
    const validGranularity = ['day', 'week', 'month'].includes(granularity) ? granularity : 'day';
    const validDimension = ['date', 'model', 'vendor', 'provider', 'route'].includes(dimension)
      ? dimension
      : 'date';
    const normalizedModelFilter = normalizeUsageModel(model);
    const rows = new Map();
    const total = freshUsageBucket();

    for (const date of [...byDate.keys()].sort()) {
      if (range.from && date < range.from) continue;
      if (range.to && date > range.to) continue;
      for (const [key, bucket] of byDate.get(date)) {
        const parts = splitCombo(key);
        if (route && parts.route !== route) continue;
        if (vendor && parts.vendor !== vendor) continue;
        if (provider && parts.provider !== provider) continue;
        if (normalizedModelFilter && parts.model !== normalizedModelFilter) continue;
        const label = validDimension === 'model' ? parts.model
          : validDimension === 'vendor' ? parts.vendor
          : validDimension === 'provider' ? parts.provider
          : validDimension === 'route' ? parts.route
          : validGranularity === 'month' ? date.slice(0, 7)
          : validGranularity === 'week' ? isoWeekKey(date)
          : date;
        if (!label) continue;
        addUsageBucket(total, bucket);
        const aggregate = rows.get(label) || freshUsageBucket();
        addUsageBucket(aggregate, bucket);
        rows.set(label, aggregate);
      }
    }

    const resultRows = [...rows.entries()].map(([key, bucket]) => ({ key, ...bucket }));
    if (validDimension === 'date') resultRows.sort((a, b) => a.key.localeCompare(b.key));
    else resultRows.sort((a, b) => (b.input + b.output) - (a.input + a.output));
    return {
      ...range,
      granularity: validGranularity,
      dimension: validDimension,
      filters: { route, vendor, provider, model: normalizedModelFilter },
      rows: resultRows,
      total,
      syncedAt,
    };
  }

  function snapshotStats() {
    let rows = 0;
    for (const day of byDate.values()) rows += day.size;
    const offset = [...sources.values()].reduce((total, source) => total + source.offset, 0);
    return { days: byDate.size, rows, offset, syncedAt };
  }

  function buildHtml(result, params, renderedAt = new Date()) {
    const fmtInt = (n) => Math.round(n || 0).toLocaleString('en-US');
    const maxTokens = Math.max(1, ...result.rows.map((row) => row.input + row.output));
    const cards = [
      ['请求数', fmtInt(result.total.requests)], ['输入 tokens', fmtInt(result.total.input)],
      ['输出 tokens', fmtInt(result.total.output)], ['合计 tokens', fmtInt(result.total.input + result.total.output)],
      ['credits', fmtInt(result.total.credits)], ['费用', formatCostParts(result.total)],
    ].map(([label, value]) => `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div></div>`).join('');

    const modelDimension = result.dimension === 'model';
    const unitHead = modelDimension ? '<th>输入单价</th><th>缓存单价</th><th>输出单价</th>' : '';
    const rows = result.rows.map((row) => {
      const width = Math.max(1, Math.round(((row.input + row.output) / maxTokens) * 100));
      const unit = modelDimension ? formatUnitPrice(pricing.resolve(row.key, { at: renderedAt })) : null;
      const unitCells = modelDimension
        ? `<td>${unit === '未公开' ? '—' : unit.input}</td><td>${unit === '未公开' ? '—' : unit.inputCached}</td><td>${unit === '未公开' ? '—' : unit.output}</td>`
        : '';
      return `<tr><td class="mono">${escapeHtml(row.key)}</td><td>${fmtInt(row.requests)}</td><td>${fmtInt(row.input)}</td><td>${fmtInt(row.output)}</td><td>${fmtInt(row.input + row.output)}</td><td>${fmtInt(row.credits)}</td>${unitCells}<td>${formatCostParts(row)}</td><td class="bar-cell"><div class="bar" style="width:${width}%"></div></td></tr>`;
    }).join('');

    const select = (name, value, options, autoSubmit = false) => `<select name="${name}"${autoSubmit ? ' onchange="this.form.requestSubmit()"' : ''}>${options.map(([key, label]) => `<option value="${key}"${key === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`;
    const dimensionOptions = [['date', '按日期'], ['model', '按模型'], ['provider', '按提供商'], ['route', '按接口'], ['vendor', '按内部厂商']];
    const dimensionButtons = dimensionOptions.map(([key, text]) => `<a class="${result.dimension === key ? 'active' : ''}" href="${escapeHtml(usageHref(params, { dimension: key }))}">${text}</a>`).join('');
    const label = result.dimension === 'model' ? '模型'
      : result.dimension === 'vendor' ? '内部厂商'
      : result.dimension === 'provider' ? '提供商（上游）'
      : result.dimension === 'route' ? '接口'
      : '日期';
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tomato Tap 用量历史</title>${usageCss()}<style>.toolbar{background:#fff;border:1px solid #e2e4e8;border-radius:8px;padding:12px 16px;margin-bottom:16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;font-size:13px}.toolbar input,.toolbar select{padding:4px 6px;border:1px solid #d4d7db;border-radius:5px}.toolbar button{padding:5px 14px;border:0;border-radius:5px;background:#2d6cdf;color:#fff;cursor:pointer}.dimension-switch{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 12px}.dimension-switch span{font-size:13px;font-weight:600;color:#555}.dimension-switch a{padding:7px 14px;border:1px solid #b9c6d8;border-radius:6px;background:#fff;color:#2d6cdf;text-decoration:none;font-size:13px;font-weight:600}.dimension-switch a.active{background:#2d6cdf;border-color:#2d6cdf;color:#fff}.bar-cell{min-width:100px}.bar{height:9px;background:#4a90d9;border-radius:5px;min-width:2px}</style></head><body>
      <h1>Tomato Tap 用量历史</h1><nav><a href="/admin/#usage">统一控制台</a><a href="/__usage">今日</a><a class="${result.period === 'week' ? 'active' : ''}" href="/__usage?period=week">本周</a><a class="${result.period === 'month' ? 'active' : ''}" href="/__usage?period=month">本月</a><a href="/__usage?view=prices">模型单价</a><a href="${escapeHtml(jsonHref(params))}">JSON</a></nav>
      <div class="meta">UTC ${escapeHtml(result.from || '最早')} ~ ${escapeHtml(result.to || '今天')} · ${result.granularity === 'week' ? '按周' : result.granularity === 'month' ? '按月' : '按天'} · 维度 ${escapeHtml(result.dimension)} · 更新 ${escapeHtml(renderedAt.toISOString())}</div>
      <div class="dimension-switch"><span>切换统计维度：</span>${dimensionButtons}</div>
      <form class="toolbar" method="get" action="/__usage">
        <input type="hidden" name="period" value="custom"><label>开始 <input type="date" name="from" value="${escapeHtml(result.from)}"></label><label>结束 <input type="date" name="to" value="${escapeHtml(result.to)}"></label>
        <label>时间粒度 ${select('granularity', result.granularity, [['day', '按天'], ['week', '按周'], ['month', '按月']], true)}</label><label>汇总维度 ${select('dimension', result.dimension, dimensionOptions, true)}</label>
        <label>接口 <input name="route" value="${escapeHtml(params.route || '')}" placeholder="/oa/v1"></label><label>提供商 <input name="provider" value="${escapeHtml(params.provider || '')}" placeholder="api.kimi.com"></label><label>内部厂商 <input name="vendor" value="${escapeHtml(params.vendor || '')}"></label><label>模型 <input name="model" value="${escapeHtml(params.model || '')}"></label><button type="submit">查询</button>
      </form>
      <div class="cards">${cards}</div><div class="table-wrap"><table><thead><tr><th>${label}</th><th>请求数</th><th>输入</th><th>输出</th><th>合计 tokens</th><th>credits</th>${unitHead}<th>费用</th><th>占比</th></tr></thead><tbody>${rows || '<tr><td colspan="12">该时间段内无数据</td></tr>'}</tbody></table></div>
      <div class="note">本周按 UTC 周一开始，本月按 UTC 自然月。自定义开始/结束日期均为包含边界。价格口径与今日面板一致。</div>
    </body></html>`;
  }

  return { sync, query, snapshotStats, buildHtml };
}

function jsonHref(params) {
  return usageHref(params, { format: 'json' });
}

function usageHref(params, overrides = {}) {
  const query = new URLSearchParams({ ...params, ...overrides });
  return `/__usage?${query.toString()}`;
}
