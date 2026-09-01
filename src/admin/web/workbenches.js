import { escapeHtml, fmt, tags } from './ui.js';
import {
  formatCountdown,
  keyErrors,
  normalizeModelName,
  providerReady,
  proxyModeName,
  proxyPolicyValue,
  slotModels,
  slotState,
  slotSummary,
  summarizeKeys,
} from './view-data.js';

export function providerLedger(providers = [], keys = []) {
  if (!providers.length) {
    return '<div class="empty-state"><h3>还没有上游</h3><p>添加一个 OpenAI 或 Anthropic 兼容服务。API Key 只保存在本机。</p><button class="button primary" data-action="new-provider">添加第一个上游</button></div>';
  }
  return `<div class="table-wrap provider-table"><table><thead><tr>
    <th>状态 / 上游</th><th>协议与地址</th><th>模型</th><th class="num">Key</th>
    <th class="num">活动 / 容量</th><th class="num">今日 2XX / 错误</th><th>出口</th><th class="row-actions">操作</th>
  </tr></thead><tbody>${providers.map((provider) => providerRow(provider, keys)).join('')}</tbody></table></div>`;
}

export function providerDrawer(provider, keys = [], detailLevel = 'safe') {
  if (!provider) return '<div class="drawer-empty">找不到该上游。</div>';
  const slots = keys.filter((key) => key.deployment === provider.id);
  const summary = summarizeKeys(slots);
  const ready = providerReady(provider, keys);
  const lamp = !provider.enabled ? 'off' : ready ? 'ok' : summary.cooling ? 'warn' : 'idle';
  const status = !provider.enabled ? '已停用' : ready ? '可调度' : summary.cooling ? '部分冷却' : '等待探测';
  return `<div class="drawer-stack">
    <div class="drawer-status"><span class="square-lamp ${lamp}"></span><div><b>${escapeHtml(status)}</b><small>${fmt(summary.hot)} 个可调度 Key · ${fmt(summary.cooling)} 个冷却</small></div></div>
    <dl class="detail-list">
      ${detail('配置 ID', provider.id)}
      ${detail('Base URL', provider.baseUrl || '—', 'break')}
      ${detail('协议', `${provider.apiFormat || 'openai'} · ${provider.auth || 'bearer'}`)}
      ${detail('凭证', provider.credential?.configured ? `已设置 · ${provider.credential.source || 'local'}` : '未设置')}
      ${detail('并发', `${fmt(summary.inflight)} / ${fmt(summary.cap)}`)}
      ${detail('今日结果', `${fmt(summary.success)} 次 2XX · ${fmt(summary.errors)} 次错误`)}
      ${detail('出口策略', proxyModeName(proxyPolicyValue(provider.proxy)))}
    </dl>
    <section class="drawer-section"><header><h3>模型</h3><span>${fmt(provider.models?.length)} 个</span></header><div class="tag-cloud">${tags(provider.models || [], 80) || '<span class="muted">未配置模型</span>'}</div></section>
    <section class="drawer-section"><header><h3>Key 槽位</h3><span>${fmt(slots.length)} 个</span></header>${drawerSlots(slots, keys, detailLevel)}</section>
    <div class="drawer-actions"><button class="button secondary" data-action="clone-provider" data-id="${escapeHtml(provider.id)}">新增 Key</button><button class="button primary" data-action="edit-provider" data-id="${escapeHtml(provider.id)}">编辑上游</button></div>
  </div>`;
}

export function relationshipWorkbench({
  logicalModels = [], realModels = [], providers = [], keys = [], logicalStatus = [],
  focus = {}, perspective = 'logical', query = '', detailLevel = 'safe',
} = {}) {
  if (!logicalModels.length) return '';
  const selectedLogical = logicalModels.find(
    (item) => normalizeModelName(item.name) === normalizeModelName(focus.logical),
  ) || logicalModels[0];
  const candidates = uniqueModels(selectedLogical.candidates || []);
  const selectedReal = candidates.find(
    (name) => normalizeModelName(name) === normalizeModelName(focus.real),
  ) || '';
  const targetModels = selectedReal ? [selectedReal] : candidates;
  const targetSet = new Set(targetModels.map(normalizeModelName));
  const relatedProviders = providers.filter((provider) => providerSupports(provider, targetSet));
  const selectedProvider = relatedProviders.find((provider) => provider.id === focus.provider)?.id || '';
  const visibleProviders = selectedProvider
    ? relatedProviders.filter((provider) => provider.id === selectedProvider)
    : relatedProviders;
  const providerIds = new Set(visibleProviders.map((provider) => provider.id));
  const indexedKeys = keys.map((key, index) => ({ key, index }));
  const relatedKeys = indexedKeys.filter(({ key }) => providerIds.has(key.deployment)
    && slotSupports(key, targetSet));
  const logicalRuntime = logicalStatus.find(
    (item) => normalizeModelName(item.id || item.name) === normalizeModelName(selectedLogical.name),
  );
  const logicalHealth = logicalRuntime?.available || logicalRuntime?.health === 'available'
    ? { lamp: 'ok', label: '可用' }
    : { lamp: 'idle', label: healthName(logicalRuntime?.health) };
  return `<section class="relationship-workbench" id="model-route-workbench">
    <div class="workbench-toolbar">
      <div class="perspective-switch" aria-label="关系视角">
        ${perspectiveButton('logical', '任务逻辑模型', perspective)}
        ${perspectiveButton('real', '聚合模型', perspective)}
        ${perspectiveButton('vendor', '供应商', perspective)}
        ${perspectiveButton('provider', '上游', perspective)}
        ${perspectiveButton('key', 'Key', perspective)}
      </div>
      <label class="workbench-search"><span>搜索</span><input name="routeQuery" value="${escapeHtml(query)}" placeholder="模型、供应商、上游或 Key 槽位"></label>
    </div>
    <div class="perspective-stage">${perspectiveTable({ perspective, query, logicalModels, realModels, providers, keys, logicalStatus, detailLevel })}</div>
    <div class="chain-head" id="model-route-chain" tabindex="-1"><div><h3>关联链路</h3><p>任务入口 → 聚合模型 → 上游实际模型与服务 → Key。</p></div><div class="chain-scope"><span class="square-lamp ${logicalHealth.lamp}"></span><b class="mono">${escapeHtml(selectedLogical.name)}</b>${selectedReal ? `<i>→</i><b class="mono">${escapeHtml(selectedReal)}</b>` : ''}${selectedProvider ? `<i>→</i><b>${escapeHtml(providerLabel(providers, selectedProvider))}</b>` : ''}</div></div>
    <div class="chain-note">聚合模型把同能力模型的多个供应来源统一调度；上游节点同时显示实际发送给供应商的模型名。点击左侧项目会逐级缩小右侧范围。</div>
    <div class="miller-browser">
      ${millerColumn('任务逻辑模型', `${logicalModels.length}/${logicalModels.length}`, logicalModels.map((model) => {
        const active = normalizeModelName(model.name) === normalizeModelName(selectedLogical.name);
        const runtime = logicalStatus.find((item) => normalizeModelName(item.id || item.name) === normalizeModelName(model.name));
        const state = runtime?.available || runtime?.health === 'available' ? { lamp: 'ok', label: '可用' } : { lamp: 'idle', label: healthName(runtime?.health) };
        return nodeButton('route-select-logical', model.name, model.name, `${model.candidates?.length || 0} 个候选 · ${state.label}`, state.lamp, active);
      }))}
      ${millerColumn('聚合模型', `${candidates.length}/${realModels.length}`, candidates.map((model) => {
        const modelProviders = providers.filter((provider) => providerSupports(provider, new Set([normalizeModelName(model)])));
        const modelSlots = keys.filter((key) => modelProviders.some((provider) => provider.id === key.deployment) && slotSupports(key, new Set([normalizeModelName(model)])));
        const state = slotSummary(modelSlots);
        return nodeButton('route-filter-real', model, model, `${modelProviders.length} 个上游 · ${modelSlots.length} 个 Key`, state.lamp, normalizeModelName(model) === normalizeModelName(selectedReal), { logical: selectedLogical.name });
      }))}
      ${millerColumn('上游 / 实际模型', `${relatedProviders.length}/${providers.length}`, relatedProviders.map((provider) => {
        const slots = keys.filter((key) => key.deployment === provider.id && slotSupports(key, targetSet));
        const state = slotSummary(slots);
        const upstreamModels = providerUpstreamModels(provider, targetSet);
        return nodeButton('route-filter-provider', provider.id, provider.label || provider.id, `${upstreamModels.join('、') || '同名透传'} · ${slots.length} 个 Key · ${state.label}`, state.lamp, provider.id === selectedProvider, { logical: selectedLogical.name, real: selectedReal });
      }))}
      ${millerColumn('Key', `${relatedKeys.length}/${keys.length}`, relatedKeys.map(({ key, index }) => {
        const state = slotState(key);
        const label = detailLevel === 'safe' ? `#${String(index + 1).padStart(3, '0')}` : key.name || `#${String(index + 1).padStart(3, '0')}`;
        return `<article class="miller-node key-node"><span><span class="square-lamp ${state.lamp}"></span><b class="mono">${escapeHtml(label)}</b></span><small>${escapeHtml(state.label)} · ${fmt(key.inflight)}/${fmt(key.cap)}</small></article>`;
      }))}
    </div>
  </section>`;
}

export function priceCatalogView(payload, filters = {}) {
  if (!payload) return '<div class="loading-card"><span class="spinner"></span>正在读取价格目录…</div>';
  const query = normalizeModelName(filters.query);
  const status = filters.status || 'all';
  const currency = String(filters.currency || 'all').toUpperCase();
  const groups = groupPrices(payload.data || []).filter((group) => {
    if (query && !group.search.includes(query)) return false;
    if (status === 'priced' && !group.price) return false;
    if (status === 'unpriced' && group.price) return false;
    if (currency !== 'ALL' && String(group.price?.currency || '').toUpperCase() !== currency) return false;
    return true;
  });
  const coverage = payload.coverage || {};
  return `<section class="price-catalog">
    <div class="catalog-summary"><div><span>当前模型名</span><b>${fmt(coverage.configured)}</b></div><div><span>已有单价</span><b>${fmt(coverage.priced)}</b></div><div><span>未公开或非 Token 计费</span><b>${fmt(coverage.unpriced)}</b></div><div><span>目录记录</span><b>${fmt(coverage.catalogEntries)}</b></div></div>
    <div class="catalog-toolbar">
      <label class="workbench-search"><span>搜索</span><input name="priceQuery" value="${escapeHtml(filters.query || '')}" placeholder="模型、别名或价格来源"></label>
      <label><span>状态</span><select name="priceStatus"><option value="all" ${status === 'all' ? 'selected' : ''}>全部</option><option value="priced" ${status === 'priced' ? 'selected' : ''}>已有单价</option><option value="unpriced" ${status === 'unpriced' ? 'selected' : ''}>未公开</option></select></label>
      <label><span>币种</span><select name="priceCurrency"><option value="all" ${currency === 'ALL' ? 'selected' : ''}>全部</option><option value="CNY" ${currency === 'CNY' ? 'selected' : ''}>CNY</option><option value="USD" ${currency === 'USD' ? 'selected' : ''}>USD</option></select></label>
      <span class="catalog-count">显示 ${fmt(groups.length)} 组</span>
    </div>
    <div class="table-wrap price-table"><table><thead><tr><th>归一模型</th><th>请求别名</th><th>目录提供方</th><th class="num">输入</th><th class="num">缓存</th><th class="num">输出</th><th>币种</th><th>来源</th></tr></thead><tbody>${groups.map(priceRow).join('') || '<tr><td colspan="8">没有符合筛选条件的价格记录</td></tr>'}</tbody></table></div>
    <div class="catalog-note">单价均按每 1M Token 展示。价格目录保留原币种；免费、订阅或按请求计费不会被填成 0。</div>
  </section>`;
}

function providerRow(provider, keys) {
  const slots = keys.filter((key) => key.deployment === provider.id);
  const summary = summarizeKeys(slots);
  const ready = providerReady(provider, keys);
  const lamp = !provider.enabled ? 'off' : ready ? 'ok' : summary.cooling ? 'warn' : 'idle';
  const state = !provider.enabled ? '停用' : ready ? '就绪' : summary.cooling ? `冷却 ${summary.cooling}` : '探测';
  const label = provider.label || provider.id;
  const showId = normalizeModelName(label) !== normalizeModelName(provider.id);
  return `<tr class="clickable-row" data-action="inspect-provider" data-id="${escapeHtml(provider.id)}">
    <td><div class="entity-title"><span class="square-lamp ${lamp}"></span><div><b>${escapeHtml(label)}</b>${showId ? `<small class="mono">${escapeHtml(provider.id)}</small>` : ''}</div></div><span class="state-text ${lamp}">${state}</span></td>
    <td><b>${escapeHtml(provider.apiFormat || 'openai')}</b><small class="row-sub mono ellipsis" title="${escapeHtml(provider.baseUrl || '')}">${escapeHtml(provider.baseUrl || '—')}</small></td>
    <td><div class="table-tag-line">${tags(provider.models || [], 3)}</div><small class="row-sub">${fmt(provider.models?.length)} 个模型</small></td>
    <td class="num mono">${fmt(slots.length)}</td><td class="num mono">${fmt(summary.inflight)} / ${fmt(summary.cap)}</td><td class="num mono">${fmt(summary.success)} / ${fmt(summary.errors)}</td>
    <td>${escapeHtml(proxyModeName(proxyPolicyValue(provider.proxy)))}</td>
    <td class="row-actions"><button class="text-action" data-action="inspect-provider" data-id="${escapeHtml(provider.id)}">查看</button><button class="text-action" data-action="edit-provider" data-id="${escapeHtml(provider.id)}">编辑</button></td>
  </tr>`;
}

function drawerSlots(slots, allKeys, detailLevel) {
  if (!slots.length) return '<div class="quiet-state compact"><span class="square-lamp idle"></span><div><b>尚未加载 Key 槽位</b></div></div>';
  return `<div class="drawer-slot-list">${slots.map((key) => {
    const index = allKeys.indexOf(key);
    const label = detailLevel === 'safe' ? `#${String(index + 1).padStart(3, '0')}` : key.name || `#${String(index + 1).padStart(3, '0')}`;
    const state = slotState(key);
    return `<div><span class="square-lamp ${state.lamp}"></span><b class="mono">${escapeHtml(label)}</b><span>${escapeHtml(state.label)}</span><small class="mono">${fmt(key.inflight)}/${fmt(key.cap)}</small></div>`;
  }).join('')}</div>`;
}

function detail(label, value, classes = '') {
  return `<div><dt>${escapeHtml(label)}</dt><dd class="${classes}">${escapeHtml(value)}</dd></div>`;
}

function perspectiveTable({ perspective, query, logicalModels, realModels, providers, keys, logicalStatus, detailLevel }) {
  const needle = normalizeModelName(query);
  const includes = (...values) => !needle || values.some((value) => normalizeModelName(value).includes(needle));
  if (perspective === 'real') {
    const rows = realModels.filter((model) => includes(model.name, model.qualityTier, ...(model.capabilities || []))).map((model) => {
      const logical = logicalModels.filter((item) => (item.candidates || []).some((name) => normalizeModelName(name) === normalizeModelName(model.name)));
      const modelProviders = providers.filter((provider) => providerSupports(provider, new Set([normalizeModelName(model.name)])));
      const slots = keys.filter((key) => modelProviders.some((provider) => provider.id === key.deployment) && slotSupports(key, new Set([normalizeModelName(model.name)])));
      const state = slotSummary(slots);
      return `<tr><td><div class="entity-title"><span class="square-lamp ${state.lamp}"></span><b class="mono">${escapeHtml(model.name)}</b></div></td><td>${tags(logical.map((item) => item.name), 5)}</td><td>${fmt(modelProviders.length)}</td><td>${fmt(slots.length)}</td><td>${escapeHtml(model.qualityTier || '—')}</td><td>${escapeHtml(state.label)}</td><td><button class="text-action" data-action="edit-real-model" data-id="${escapeHtml(model.name)}">策略</button></td></tr>`;
    });
    return entityTable('<th>聚合模型</th><th>任务入口</th><th class="num">上游</th><th class="num">Key</th><th>质量</th><th>状态</th><th>操作</th>', rows, 7);
  }
  if (perspective === 'vendor') {
    const groups = new Map();
    keys.forEach((key) => {
      const vendor = key.vendor || 'unknown';
      const group = groups.get(vendor) || { vendor, providers: new Set(), slots: [], models: new Set() };
      group.providers.add(key.deployment || key.provider || 'unknown');
      group.slots.push(key);
      slotModels(key).forEach((model) => group.models.add(model));
      groups.set(vendor, group);
    });
    const rows = [...groups.values()].filter((group) => includes(group.vendor, ...group.providers, ...group.models)).map((group) => {
      const stats = summarizeKeys(group.slots);
      return `<tr><td><div class="entity-title"><span class="square-lamp ${stats.hot ? 'ok' : stats.cooling ? 'warn' : 'idle'}"></span><b>${escapeHtml(group.vendor)}</b></div></td><td class="num">${fmt(group.providers.size)}</td><td class="num">${fmt(group.slots.length)}</td><td class="num">${fmt(stats.hot)}</td><td class="num">${fmt(stats.cooling)}</td><td>${tags([...group.models], 5)}</td></tr>`;
    });
    return entityTable('<th>供应商</th><th class="num">上游</th><th class="num">Key</th><th class="num">可调度</th><th class="num">冷却</th><th>模型</th>', rows, 6);
  }
  if (perspective === 'provider') {
    const rows = providers.filter((provider) => includes(provider.id, provider.label, provider.baseUrl, ...(provider.models || []))).map((provider) => providerRow(provider, keys));
    return entityTable('<th>状态 / 上游</th><th>协议与地址</th><th>模型</th><th class="num">Key</th><th class="num">活动 / 容量</th><th class="num">今日 2XX / 错误</th><th>出口</th><th>操作</th>', rows, 8, 'provider-table');
  }
  if (perspective === 'key') {
    const rows = keys.map((key, index) => ({ key, index })).filter(({ key, index }) => includes(key.name, key.vendor, key.provider, key.deployment, `#${String(index + 1).padStart(3, '0')}`, ...slotModels(key))).map(({ key, index }) => {
      const state = slotState(key);
      const label = detailLevel === 'safe' ? `#${String(index + 1).padStart(3, '0')}` : key.name || `#${String(index + 1).padStart(3, '0')}`;
      return `<tr><td><div class="entity-title"><span class="square-lamp ${state.lamp}"></span><b class="mono">${escapeHtml(label)}</b></div></td><td>${escapeHtml(key.provider || key.deployment || 'unknown')}</td><td>${escapeHtml(key.vendor || '—')}</td><td>${tags([...slotModels(key)], 4)}</td><td class="num mono">${fmt(key.inflight)} / ${fmt(key.cap)}</td><td>${escapeHtml(state.label)}</td><td class="num">${fmt(keyErrors(key))}</td></tr>`;
    });
    return entityTable('<th>Key 槽位</th><th>上游</th><th>供应商</th><th>模型</th><th class="num">活动 / 容量</th><th>状态</th><th class="num">错误</th>', rows, 7);
  }
  const rows = logicalModels.filter((model) => includes(model.name, ...(model.candidates || []), ...(model.requiredCapabilities || []))).map((model) => {
    const candidates = new Set((model.candidates || []).map(normalizeModelName));
    const modelProviders = providers.filter((provider) => providerSupports(provider, candidates));
    const providerIds = new Set(modelProviders.map((provider) => provider.id));
    const slots = keys.filter((key) => providerIds.has(key.deployment) && slotSupports(key, candidates));
    const runtime = logicalStatus.find((item) => normalizeModelName(item.id || item.name) === normalizeModelName(model.name));
    const available = runtime?.available || runtime?.health === 'available';
    return `<tr><td><div class="entity-title"><span class="square-lamp ${available ? 'ok' : 'idle'}"></span><b class="mono">${escapeHtml(model.name)}</b></div></td><td>${tags(model.candidates || [], 5)}</td><td class="num">${fmt(modelProviders.length)}</td><td class="num">${fmt(slots.length)}</td><td>${escapeHtml(strategyName(model.candidateStrategy))}</td><td>${escapeHtml(available ? '可用' : healthName(runtime?.health))}</td><td><button class="text-action" data-action="route-select-logical" data-reveal="chain" data-id="${escapeHtml(model.name)}">查看链路</button></td></tr>`;
  });
  return entityTable('<th>任务逻辑模型</th><th>聚合模型</th><th class="num">上游</th><th class="num">Key</th><th>策略</th><th>状态</th><th>操作</th>', rows, 7);
}

function entityTable(head, rows, colspan, classes = '') {
  return `<div class="table-wrap entity-table ${classes}"><table><thead><tr>${head}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${colspan}">当前视角没有匹配项</td></tr>`}</tbody></table></div>`;
}

function perspectiveButton(value, label, active) {
  return `<button class="${value === active ? 'active' : ''}" data-action="route-perspective" data-perspective="${value}">${label}</button>`;
}

function millerColumn(label, count, nodes) {
  return `<section class="miller-column"><header><span>${escapeHtml(label)}</span><b class="mono">${escapeHtml(count)}</b></header><div>${nodes.join('') || '<div class="miller-empty">没有匹配项</div>'}</div></section>`;
}

function nodeButton(action, id, label, detailText, lamp, active, extra = {}) {
  const data = Object.entries(extra).map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`).join('');
  return `<button class="miller-node ${active ? 'active' : ''}" data-action="${action}" data-id="${escapeHtml(id)}"${data}><span><span class="square-lamp ${lamp}"></span><b class="mono">${escapeHtml(label)}</b></span><small>${escapeHtml(detailText)}</small></button>`;
}

function uniqueModels(models) {
  return [...new Map(models.map((name) => [normalizeModelName(name), name])).values()];
}

function providerSupports(provider, models) {
  const exposed = [
    ...(provider.canonicalModels || []),
    ...Object.keys(provider.aliases || {}),
    ...(provider.models || []),
  ];
  return exposed.some((model) => models.has(normalizeModelName(model)));
}

function providerUpstreamModels(provider, canonicalModels) {
  const aliases = provider.aliases || {};
  const results = [];
  for (const canonical of canonicalModels) {
    const mapped = Object.entries(aliases).find(
      ([name]) => normalizeModelName(name) === normalizeModelName(canonical),
    )?.[1];
    if (mapped) results.push(mapped);
    else {
      const direct = (provider.models || []).find(
        (name) => normalizeModelName(name) === normalizeModelName(canonical),
      );
      if (direct) results.push(direct);
    }
  }
  return uniqueModels(results);
}

function slotSupports(slot, models) {
  if (!models.size) return false;
  const available = slotModels(slot);
  if (!available.size) return true;
  return [...models].some((model) => available.has(model));
}

function providerLabel(providers, id) {
  return providers.find((provider) => provider.id === id)?.label || id;
}

function healthName(value) {
  return ({
    available: '可用',
    ready: '已验证',
    probing: '探测中',
    congested: '拥塞',
    cooldown: '冷却中',
    unhealthy: '验证失败',
    blocked: '已阻止',
  })[value] || '探测中';
}

function strategyName(value) {
  return ({ ordered: '顺序', fair: '公平', adaptive: '自适应' })[value] || value || '公平';
}

function groupPrices(rows) {
  const groups = new Map();
  rows.forEach((row) => {
    const price = row.price || null;
    const canonical = normalizeModelName(price?.canonicalModel || row.model) || 'unknown';
    const signature = price
      ? [canonical, price.provider, price.currency, price.input, price.inputCached, price.output].join('\u0000')
      : `${canonical}\u0000unpriced`;
    const group = groups.get(signature) || { canonical, price, aliases: [], search: '' };
    group.aliases.push(row.model);
    group.search = normalizeModelName([canonical, price?.provider, price?.source, ...group.aliases].join(' '));
    groups.set(signature, group);
  });
  return [...groups.values()].sort((a, b) => a.canonical.localeCompare(b.canonical));
}

function priceRow(group) {
  const price = group.price;
  const source = price?.sourceUrl && /^https?:\/\//.test(price.sourceUrl)
    ? `<a class="text-action" href="${escapeHtml(price.sourceUrl)}" target="_blank" rel="noreferrer">${escapeHtml(price.source || '查看来源')}</a>`
    : escapeHtml(price?.source || '未公开 / 套餐 / 非 Token 计费');
  return `<tr><td><b class="mono">${escapeHtml(group.canonical)}</b></td><td><div class="alias-list">${tags(group.aliases, 5)}</div></td><td>${escapeHtml(price?.provider || '—')}</td><td class="num mono">${unitPrice(price?.input)}</td><td class="num mono">${unitPrice(price?.inputCached ?? price?.input)}</td><td class="num mono">${unitPrice(price?.output)}</td><td>${escapeHtml(price?.currency || '—')}</td><td>${source}</td></tr>`;
}

function unitPrice(value) {
  return value === undefined || value === null ? '—' : Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 });
}
