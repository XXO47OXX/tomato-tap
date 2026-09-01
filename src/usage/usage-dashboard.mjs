// Current-day usage aggregation and /__usage rendering.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { MODEL_PRICING, formatUnitPrice } from './model-pricing.mjs';

export const ROUTE_BY_VENDOR = Object.freeze({
  relay: '/oa/v1',
});

export function normalizeUsageModel(value) {
  return String(value || '').trim().toLowerCase();
}

export function freshUsageBucket() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    inputCached: 0,
    credits: 0,
    cny: 0,
    tokenCny: 0,
    estCny: 0,
    estUsd: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

export function addUsageBucket(target, source) {
  for (const field of [
    'requests', 'input', 'output', 'inputCached', 'credits', 'cny',
    'tokenCny', 'estCny', 'estUsd', 'pricedRequests', 'unpricedRequests',
  ]) target[field] += Number(source[field]) || 0;
}

function isAccountedTokenPrice(entry, quote) {
  if (quote?.currency !== 'CNY') return false;
  if (quote?.price?.costMode === 'accounted') return true;
  const provider = String(entry?.provider || '').trim().toLowerCase();
  const canonicalModel = String(
    quote?.price?.canonicalModel || quote?.price?.model || entry?.model || '',
  ).trim().toLowerCase();
  return provider === 'api.kimi.com' && canonicalModel.startsWith('kimi-');
}

export function addUsageEntry(bucket, entry, pricing = MODEL_PRICING, at = new Date()) {
  const input = Math.max(0, Number(entry.input) || 0);
  const output = Math.max(0, Number(entry.output) || 0);
  bucket.requests += 1;
  bucket.input += input;
  bucket.output += output;
  bucket.inputCached += Math.max(0, Number(entry.inputCached ?? entry.input_cached) || 0);
  bucket.credits += Number(entry.credits) || 0;

  const recordedCny = Math.max(0, Number(entry.vendorCny ?? entry.vendor_cny) || 0);
  bucket.cny += recordedCny;
  if (input + output <= 0 || recordedCny > 0) return;

  const quote = pricing.estimate(entry, { at });
  if (!quote.priced) {
    bucket.unpricedRequests += 1;
    return;
  }
  bucket.pricedRequests += 1;
  if (isAccountedTokenPrice(entry, quote)) bucket.tokenCny += quote.amount;
  else if (quote.currency === 'CNY') bucket.estCny += quote.amount;
  else if (quote.currency === 'USD') bucket.estUsd += quote.amount;
  else bucket.unpricedRequests += 1;
}

function resetBucket(bucket) {
  Object.assign(bucket, freshUsageBucket());
}

function rowsFromMap(map) {
  return [...map.entries()]
    .map(([key, bucket]) => ({ key, ...bucket }))
    .sort((a, b) => (b.input + b.output) - (a.input + a.output));
}

export function formatCostParts(bucket) {
  const parts = [];
  if (bucket.cny > 0) parts.push(`¥${Number(bucket.cny).toFixed(4)} <span class="tag actual">记账</span>`);
  if (bucket.tokenCny > 0) parts.push(`¥${Number(bucket.tokenCny).toFixed(4)} <span class="tag token">按价记账</span>`);
  if (bucket.estCny > 0) parts.push(`¥${Number(bucket.estCny).toFixed(4)} <span class="tag">估算</span>`);
  if (bucket.estUsd > 0) parts.push(`$${Number(bucket.estUsd).toFixed(4)} <span class="tag">估算</span>`);
  return parts.join('<br>') || '—';
}

function legacyPricingAdapter(estimate) {
  const table = estimate || {};
  function resolve(model, { at = new Date() } = {}) {
    const raw = table[model];
    if (!raw) return null;
    const hour = at.getUTCHours();
    const inPeak = !!raw.peak && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
    const active = inPeak ? raw.peak : raw;
    return {
      model,
      canonicalModel: model,
      provider: 'test/local',
      currency: 'CNY',
      unit: 'million_tokens',
      input: Number(active.input) || 0,
      inputCached: Number(active.inputCached ?? active.input) || 0,
      output: Number(active.output) || 0,
      source: 'legacy estimate map',
      sourceUrl: '',
    };
  }
  return {
    resolve,
    estimate(entry, { at } = {}) {
      const price = resolve(entry.model, { at });
      if (!price) return { priced: false, amount: 0, currency: '', price: null };
      const input = Number(entry.input) || 0;
      const cached = Math.min(input, Number(entry.inputCached ?? entry.input_cached) || 0);
      const output = Number(entry.output) || 0;
      return {
        priced: true,
        currency: 'CNY',
        amount: ((input - cached) * price.input + cached * price.inputCached + output * price.output) / 1_000_000,
        price,
      };
    },
    stats(models) {
      const priced = models.filter((model) => resolve(model)).length;
      return { configured: models.length, priced, unpriced: models.length - priced, coverage: models.length ? priced / models.length : 1, catalogEntries: Object.keys(table).length, source: {} };
    },
  };
}

export function createUsageDashboard({
  pricing,
  estimate,
  now,
  vendorByKey,
  providerByKey,
  providerByDeployment,
} = {}) {
  pricing = pricing || (estimate ? legacyPricingAdapter(estimate) : MODEL_PRICING);
  const byRoute = new Map();
  const byVendor = new Map();
  const byProvider = new Map();
  const byModel = new Map();
  const total = freshUsageBucket();
  const clock = now || (() => new Date());
  const dateStr = () => clock().toISOString().slice(0, 10);
  let date = dateStr();
  let scannedAt = 0;

  function mapBucket(map, key) {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = freshUsageBucket();
      map.set(key, bucket);
    }
    return bucket;
  }

  function record(entry) {
    if (!entry || typeof entry !== 'object') return;
    const today = dateStr();
    if (today !== date) {
      date = today;
      resetBucket(total);
      for (const map of [byRoute, byVendor, byProvider, byModel]) map.clear();
    }
    const vendor = entry.vendor
      || (entry.key && typeof vendorByKey === 'function' ? vendorByKey(entry.key) : '')
      || '';
    const provider = entry.provider
      || (entry.key && typeof providerByKey === 'function' ? providerByKey(entry.key) : '')
      || (entry.deployment && typeof providerByDeployment === 'function'
        ? providerByDeployment(entry.deployment)
        : '')
      || vendor
      || 'unknown';
    const route = entry.route || ROUTE_BY_VENDOR[vendor] || 'unknown';
    const at = entry._at || entry.ts ? new Date(entry._at || entry.ts) : clock();
    const usageEntry = { ...entry, route, vendor, provider };
    addUsageEntry(total, usageEntry, pricing, at);
    addUsageEntry(mapBucket(byRoute, route), usageEntry, pricing, at);
    if (vendor) addUsageEntry(mapBucket(byVendor, vendor), usageEntry, pricing, at);
    addUsageEntry(mapBucket(byProvider, provider), usageEntry, pricing, at);
    const aggregateModel = normalizeUsageModel(entry.model);
    if (aggregateModel) addUsageEntry(mapBucket(byModel, aggregateModel), usageEntry, pricing, at);
  }

  function snapshot() {
    return {
      date,
      scannedAt,
      total: { ...total },
      byRoute: rowsFromMap(byRoute),
      byVendor: rowsFromMap(byVendor),
      byProvider: rowsFromMap(byProvider),
      byModel: rowsFromMap(byModel),
    };
  }

  async function scanTodayFromLog(pathOrPaths) {
    const wanted = dateStr();
    let count = 0;
    const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
    for (const path of paths.filter(Boolean)) {
      try {
        const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.includes(wanted)) continue;
          try {
            const row = JSON.parse(line);
            if (!row.ts?.startsWith(`${wanted}T`)) continue;
            record({
              ...row,
              inputCached: row.input_cached,
              inputMiss: row.input_miss,
              vendorCny: row.vendor_cny,
              _at: row.ts,
            });
            count++;
          } catch { /* malformed historical row */ }
        }
      } catch { /* missing or concurrently rotated log */ }
    }
    scannedAt = Date.now();
    return count;
  }

  function buildHtml(renderedAt = new Date()) {
    const s = snapshot();
    const fmtInt = (n) => Math.round(n || 0).toLocaleString('en-US');
    const card = (label, value) =>
      `<div class="card"><div class="card-label">${label}</div><div class="card-value">${value}</div></div>`;

    const tableRows = (rows, dimension) => rows.map((row) => {
      const price = dimension === 'model' ? pricing.resolve(row.key, { at: renderedAt }) : null;
      const unit = formatUnitPrice(price);
      const unitCells = dimension === 'model'
        ? `<td>${unit === '未公开' ? '—' : unit.input}</td><td>${unit === '未公开' ? '—' : unit.inputCached}</td><td>${unit === '未公开' ? '—' : unit.output}</td><td class="source">${price ? `${escapeHtml(price.provider)}<br><a href="${escapeHtml(price.sourceUrl || '#')}">${escapeHtml(price.source)}</a>` : '未公开/非 token 计费'}</td>`
        : '';
      return `<tr>
        <td class="mono">${escapeHtml(row.key === 'unknown' ? 'unknown（旧格式）' : row.key)}</td>
        <td>${fmtInt(row.requests)}</td><td>${fmtInt(row.input)}</td><td>${fmtInt(row.output)}</td>
        <td>${fmtInt(row.input + row.output)}</td><td>${fmtInt(row.credits)}</td>
        ${unitCells}<td>${formatCostParts(row)}</td>
      </tr>`;
    }).join('');

    const table = (title, rows, dimension) => {
      const unitHead = dimension === 'model'
        ? '<th>输入单价</th><th>缓存单价</th><th>输出单价</th><th>价格来源</th>'
        : '';
      const dimensionLabel = dimension === 'model' ? '模型'
        : dimension === 'vendor' ? '内部厂商'
        : dimension === 'provider' ? '提供商（上游）'
        : '接口';
      return `<h2>${title}</h2><div class="table-wrap"><table><thead><tr><th>${dimensionLabel}</th><th>请求数</th><th>输入</th><th>输出</th><th>合计 tokens</th><th>credits</th>${unitHead}<th>费用</th></tr></thead><tbody>${tableRows(rows, dimension) || '<tr><td colspan="11">暂无数据</td></tr>'}</tbody></table></div>`;
    };

    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tomato Tap 用量面板</title>${usageCss()}</head><body>
      <h1>Tomato Tap 用量面板</h1>
      <nav><a href="/admin/#usage">统一控制台</a><a class="active" href="/__usage">今日</a><a href="/__usage?period=week">本周</a><a href="/__usage?period=month">本月</a><a href="/__usage?view=prices">模型单价</a><a href="/__usage?format=json">JSON</a></nav>
      <div class="meta">数据日期（UTC）：${escapeHtml(s.date)} · 更新：${escapeHtml(renderedAt.toISOString())} · 内部重试按 attempt 计数；有上游 usage 的失败 attempt 计入费用</div>
      <div class="cards">
        ${card('今日请求数', fmtInt(s.total.requests))}${card('输入 tokens', fmtInt(s.total.input))}${card('输出 tokens', fmtInt(s.total.output))}${card('合计 tokens', fmtInt(s.total.input + s.total.output))}${card('credits', fmtInt(s.total.credits))}${card('费用', formatCostParts(s.total))}
      </div>
      ${table('按接口（route）', s.byRoute, 'route')}
      ${table('按提供商（上游主机 / 本地部署）', s.byProvider, 'provider')}
      ${table('按模型（单价均为 / 百万 token）', s.byModel, 'model')}
      ${table('按内部厂商（vendor）', s.byVendor, 'vendor')}
      <div class="note"><b>费用口径：</b>供应商返回的 <code>vendor_cny</code> 标为“记账”；Kimi 官方接口和明确声明 <code>costMode: accounted</code> 的 token 单价标为“按价记账”；其余缺少供应商账单的请求使用公开价格目录或本地覆盖表估算。订阅、赠送额度和中转站的实际扣费可能与列表价不同。历史明细在 <code>usage.log</code>。</div>
    </body></html>`;
  }

  function buildPriceHtml(models, renderedAt = new Date()) {
    const unique = [...new Set(models.map(String).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const coverage = pricing.stats(unique);
    const rows = unique.map((model) => {
      const price = pricing.resolve(model, { at: renderedAt });
      const unit = formatUnitPrice(price);
      return `<tr><td class="mono">${escapeHtml(model)}</td><td class="mono">${escapeHtml(price?.canonicalModel || '—')}</td><td>${unit === '未公开' ? '—' : unit.input}</td><td>${unit === '未公开' ? '—' : unit.inputCached}</td><td>${unit === '未公开' ? '—' : unit.output}</td><td>${price ? escapeHtml(price.currency) : '—'}</td><td>${price ? `${escapeHtml(price.provider)} · <a href="${escapeHtml(price.sourceUrl || '#')}">${escapeHtml(price.source)}</a>` : '未公开 / 套餐别名 / 非 token 计费'}</td></tr>`;
    }).join('');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tomato Tap 模型单价</title>${usageCss()}</head><body>
      <h1>Tomato Tap 模型单价</h1><nav><a href="/admin/#usage">统一控制台</a><a href="/__usage">今日</a><a href="/__usage?period=week">本周</a><a href="/__usage?period=month">本月</a><a class="active" href="/__usage?view=prices">模型单价</a><a href="/__usage?view=prices&format=json">JSON</a></nav>
      <div class="meta">已配置 ${coverage.configured} 个模型名 · 有 token 单价 ${coverage.priced} · 未公开/非 token 计费 ${coverage.unpriced} · Portkey 目录 ${coverage.catalogEntries} 条 · 同步 ${escapeHtml(coverage.source.syncedAt || '未知')}</div>
      <div class="table-wrap"><table><thead><tr><th>请求模型名</th><th>归一模型</th><th>输入单价</th><th>缓存单价</th><th>输出单价</th><th>币种</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="note">所有单价均为每百万 token。没有公开 token 单价的模型不会被硬填为 0；免费、订阅或按请求计费也会明确保留为未公开，避免产生虚假成本。</div>
    </body></html>`;
  }

  return { record, snapshot, scanTodayFromLog, buildHtml, buildPriceHtml };
}

export function usageCss() {
  return `<style>
    body{font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;margin:24px;background:#f6f7f9;color:#1a1a1a}h1{font-size:21px;margin:0 0 10px}h2{font-size:15px;margin:22px 0 8px}nav{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}nav a{padding:5px 10px;border-radius:6px;background:#fff;border:1px solid #dfe3e8;text-decoration:none;color:#2d6cdf;font-size:13px}nav a.active{background:#2d6cdf;color:#fff;border-color:#2d6cdf}.meta{color:#666;font-size:13px;margin-bottom:16px}.cards{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:20px}.card{background:#fff;border:1px solid #e2e4e8;border-radius:8px;padding:12px 16px;min-width:130px}.card-label{font-size:12px;color:#666;margin-bottom:4px}.card-value{font-size:18px;font-weight:600}.table-wrap{overflow-x:auto}table{border-collapse:collapse;background:#fff;border:1px solid #e2e4e8;width:100%;font-size:13px}th,td{padding:7px 11px;text-align:right;border-bottom:1px solid #eef0f2;white-space:nowrap}th:first-child,td:first-child{text-align:left}thead th{background:#fafbfc;color:#555;font-weight:600;position:sticky;top:0}tr:hover td{background:#f7faff}.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px}.source{font-size:11px;color:#666}.tag{font-size:11px;color:#0a6c3c;background:#e6f4ec;border-radius:4px;padding:1px 5px;margin-left:4px}.tag.actual{color:#694600;background:#fff2c7}.tag.token{color:#184a7a;background:#e5f1ff}.note{font-size:12px;color:#666;line-height:1.7;background:#fff;border:1px dashed #d4d7db;border-radius:8px;padding:10px 14px;margin-top:18px}a{color:#2d6cdf}code{font-family:ui-monospace,monospace}
  </style>`;
}

export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
