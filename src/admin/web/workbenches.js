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
      ${detail('路由权重', String(provider.weight || 1))}
      ${detail('回退条件', provider.fallbackAdmission === 'higher_weight_quota_closed' ? '仅高权重上游额度关闭时' : '正常候选')}
      ${provider.quota ? detail('额度探针', `${provider.quota.probeModel || '—'} · ${formatCountdown(provider.quota.probeIntervalMs || 0)}`) : ''}
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
  const needle = normalizeModelName(query);
  const matches = (...values) => !needle || normalizeModelName(values.flat().filter(Boolean).join(' ')).includes(needle);
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
  const relatedProviderIds = new Set(relatedProviders.map((provider) => provider.id));
  const indexedKeys = keys.map((key, index) => ({ key, index, id: keySlotId(key, index) }));
  const modelKeys = indexedKeys.filter(({ key }) => relatedProviderIds.has(key.deployment) && slotSupports(key, targetSet));
  const vendorGroups = groupVendors(modelKeys);
  const selectedVendor = vendorGroups.some((group) => group.id === focus.vendor) ? focus.vendor : '';
  const vendorProviders = selectedVendor
    ? relatedProviders.filter((provider) => modelKeys.some(({ key }) => key.deployment === provider.id && vendorId(key) === selectedVendor))
    : relatedProviders;
  const selectedProvider = vendorProviders.find((provider) => provider.id === focus.provider)?.id || '';
  const visibleProviders = selectedProvider ? vendorProviders.filter((provider) => provider.id === selectedProvider) : vendorProviders;
  const providerIds = new Set(visibleProviders.map((provider) => provider.id));
  const relatedKeys = indexedKeys.filter(({ key }) => providerIds.has(key.deployment)
    && slotSupports(key, targetSet));
  const selectedKey = relatedKeys.find(({ id }) => id === focus.key) || null;
  const egressGroups = groupEgress(selectedKey ? [selectedKey] : relatedKeys, providers);
  const selectedEgress = egressGroups.find((item) => item.id === focus.egress) || null;
  const logicalRuntime = logicalStatus.find(
    (item) => normalizeModelName(item.id || item.name) === normalizeModelName(selectedLogical.name),
  );
  const logicalHealth = logicalRuntime?.available || logicalRuntime?.health === 'available'
    ? { lamp: 'ok', label: '可用' }
    : { lamp: 'idle', label: healthName(logicalRuntime?.health) };
  const logicalNodes = logicalModels.filter((model) => (
    normalizeModelName(model.name) === normalizeModelName(selectedLogical.name)
    || matches(model.name, model.candidates, model.requiredCapabilities)
  ));
  const realNodes = candidates.filter((model) => normalizeModelName(model) === normalizeModelName(selectedReal) || matches(model));
  const providerNodes = vendorProviders.filter((provider) => provider.id === selectedProvider
    || matches(provider.id, provider.label, provider.baseUrl, provider.models, provider.canonicalModels, providerVendors(provider.id, modelKeys)));
  const keyNodes = relatedKeys.filter(({ key, id }) => id === selectedKey?.id
    || matches(id, key.name, key.vendor, key.provider, key.deployment, [...slotModels(key)]));
  const egressNodes = egressGroups.filter((item) => item.id === selectedEgress?.id || matches(item.id, item.label, item.detail));
  const activeLane = perspective === 'vendor' ? 'provider' : perspective;
  const selectedProviderRecord = providers.find((provider) => provider.id === selectedProvider) || null;
  return `<section class="relationship-workbench" id="model-route-workbench">
    <div class="workbench-toolbar">
      <div class="perspective-switch" aria-label="关系视角">
        ${perspectiveButton('logical', '任务逻辑模型', perspective)}
        ${perspectiveButton('real', '聚合模型', perspective)}
        ${perspectiveButton('vendor', '供应商', perspective)}
        ${perspectiveButton('provider', '上游', perspective)}
        ${perspectiveButton('key', 'Key', perspective)}
        ${perspectiveButton('egress', '出口', perspective)}
      </div>
      <label class="workbench-search"><span>搜索</span><input name="routeQuery" value="${escapeHtml(query)}" placeholder="模型、供应商、上游或 Key 槽位"></label>
    </div>
    <div class="chain-head" id="model-route-chain" tabindex="-1"><div><h3>关联链路</h3><p>多个供应来源统一调度；点击节点缩小可达路径。</p></div><div class="chain-scope"><span class="square-lamp ${logicalHealth.lamp}"></span>${pathSegment(selectedLogical.name, 'route-select-logical', selectedLogical.name)}${selectedReal ? pathArrow() + pathSegment(selectedReal, 'route-filter-real', selectedReal, { logical: selectedLogical.name }) : ''}${selectedProvider ? pathArrow() + pathSegment(providerLabel(providers, selectedProvider), 'route-filter-provider', selectedProvider, { logical: selectedLogical.name, real: selectedReal, vendor: selectedVendor }) : ''}${selectedKey ? pathArrow() + `<b class="mono">${escapeHtml(keyDisplayName(selectedKey.key, selectedKey.index, detailLevel))}</b>` : ''}${selectedEgress ? pathArrow() + `<b>${escapeHtml(selectedEgress.label)}</b>` : ''}<button class="text-action" data-action="route-filter-reset" data-logical="${escapeHtml(selectedLogical.name)}">重置</button></div></div>
    <div class="vendor-facets" aria-label="供应商筛选"><span>供应商</span><button class="${selectedVendor ? '' : 'active'}" data-action="route-filter-vendor" data-id="">全部 <b>${vendorGroups.length}</b></button>${vendorGroups.map((group) => `<button class="${group.id === selectedVendor ? 'active' : ''}" data-action="route-filter-vendor" data-id="${escapeHtml(group.id)}"><span class="square-lamp ${group.summary.lamp}"></span>${escapeHtml(group.id)} <b>${group.keys.length}</b></button>`).join('')}</div>
    <div class="relationship-layout">
      <div class="relationship-browser-shell">
        <div class="miller-browser" role="group" aria-label="模型调度关系">
      ${millerColumn('logical', '任务逻辑模型', `${logicalNodes.length}/${logicalModels.length}`, logicalNodes.map((model) => {
        const active = normalizeModelName(model.name) === normalizeModelName(selectedLogical.name);
        const runtime = logicalStatus.find((item) => normalizeModelName(item.id || item.name) === normalizeModelName(model.name));
        const state = runtime?.available || runtime?.health === 'available' ? { lamp: 'ok', label: '可用' } : { lamp: 'idle', label: healthName(runtime?.health) };
        return nodeButton('route-select-logical', model.name, model.name, `${model.candidates?.length || 0} 个候选 · ${state.label}`, state.lamp, active);
      }), activeLane)}
      ${millerColumn('real', '聚合模型', `${realNodes.length}/${candidates.length}`, realNodes.map((model) => {
        const modelProviders = providers.filter((provider) => providerSupports(provider, new Set([normalizeModelName(model)])));
        const modelSlots = keys.filter((key) => modelProviders.some((provider) => provider.id === key.deployment) && slotSupports(key, new Set([normalizeModelName(model)])));
        const state = slotSummary(modelSlots);
        return nodeButton('route-filter-real', model, model, `${modelProviders.length} 个上游 · ${modelSlots.length} 个 Key`, state.lamp, normalizeModelName(model) === normalizeModelName(selectedReal), { logical: selectedLogical.name });
      }), activeLane)}
      ${millerColumn('provider', '上游 / 实际模型', `${providerNodes.length}/${relatedProviders.length}`, providerNodes.map((provider) => {
        const slots = keys.filter((key) => key.deployment === provider.id && slotSupports(key, targetSet));
        const state = slotSummary(slots);
        const upstreamModels = providerUpstreamModels(provider, targetSet);
        const vendors = providerVendors(provider.id, modelKeys);
        return nodeButton('route-filter-provider', provider.id, provider.label || provider.id, `${upstreamModels.join('、') || '同名透传'} · ${slots.length} Key · ${vendors.join('、') || '未标注供应商'}`, state.lamp, provider.id === selectedProvider, { logical: selectedLogical.name, real: selectedReal, vendor: selectedVendor });
      }), activeLane)}
      ${millerColumn('key', 'Key', `${keyNodes.length}/${relatedKeys.length}`, keyNodes.map(({ key, index, id }) => {
        const state = slotState(key);
        const label = keyDisplayName(key, index, detailLevel);
        return nodeButton('route-filter-key', id, label, `${state.label} · ${fmt(key.inflight)}/${fmt(key.cap)} · ${vendorId(key)}`, state.lamp, id === selectedKey?.id);
      }), activeLane)}
      ${millerColumn('egress', '代理出口', `${egressNodes.length}/${egressGroups.length}`, egressNodes.map((item) => nodeButton('route-filter-egress', item.id, item.label, `${item.detail} · ${item.keys.length} Key`, item.lamp, item.id === selectedEgress?.id)), activeLane)}
        </div>
        <div class="relationship-keyboard-hint"><span><kbd>←</kbd><kbd>→</kbd> 切换层级</span><span><kbd>↑</kbd><kbd>↓</kbd> 选择节点</span><span><kbd>/</kbd> 搜索</span><span><kbd>Esc</kbd> 返回全路径</span></div>
      </div>
      ${relationshipInspector({ selectedLogical, selectedReal, selectedVendor, selectedProvider: selectedProviderRecord, selectedKey, selectedEgress, realModels, providers, keys: relatedKeys, logicalRuntime, detailLevel, vendorGroups })}
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

function perspectiveButton(value, label, active) {
  return `<button class="${value === active ? 'active' : ''}" data-action="route-perspective" data-perspective="${value}">${label}</button>`;
}

function millerColumn(lane, label, count, nodes, activeLane) {
  return `<section class="miller-column ${lane === activeLane ? 'perspective-active' : ''}" data-lane="${escapeHtml(lane)}"><header><span>${escapeHtml(label)}</span><b class="mono">${escapeHtml(count)}</b></header><div>${nodes.join('') || '<div class="miller-empty">没有匹配项</div>'}</div></section>`;
}

function nodeButton(action, id, label, detailText, lamp, active, extra = {}) {
  const data = Object.entries(extra).map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`).join('');
  return `<button class="miller-node ${active ? 'active' : ''}" data-action="${action}" data-id="${escapeHtml(id)}"${data}><span><span class="square-lamp ${lamp}"></span><b class="mono">${escapeHtml(label)}</b></span><small>${escapeHtml(detailText)}</small></button>`;
}

function relationshipInspector({
  selectedLogical, selectedReal, selectedVendor, selectedProvider, selectedKey, selectedEgress,
  realModels, providers, keys, logicalRuntime, detailLevel, vendorGroups,
}) {
  let kicker = '任务逻辑模型';
  let title = selectedLogical.name;
  let state = logicalRuntime?.available || logicalRuntime?.health === 'available'
    ? { lamp: 'ok', label: '可用' }
    : { lamp: 'idle', label: healthName(logicalRuntime?.health) };
  let rows = [
    detail('策略', strategyName(selectedLogical.candidateStrategy)),
    detail('候选模型', `${selectedLogical.candidates?.length || 0} 个`),
    detail('最大尝试', selectedLogical.maxAttempts || '—'),
    detail('请求期限', selectedLogical.deadlineMs ? formatCountdown(selectedLogical.deadlineMs) : '—'),
  ];
  let models = selectedLogical.candidates || [];
  let actions = `<button class="button secondary" data-action="edit-logical" data-id="${escapeHtml(selectedLogical.name)}">编辑逻辑模型</button>`;

  if (selectedReal) {
    const real = realModels.find((item) => normalizeModelName(item.name) === normalizeModelName(selectedReal)) || {};
    const modelKeys = keys.filter(({ key }) => slotModels(key).has(normalizeModelName(selectedReal))).map(({ key }) => key);
    state = slotSummary(modelKeys);
    kicker = '聚合模型';
    title = selectedReal;
    rows = [
      detail('质量级别', real.qualityTier || '—'),
      detail('思考适配', real.thinkingAdapter || '—'),
      detail('最大并发', real.maxInflight || '—'),
      detail('可达 Key', modelKeys.length),
    ];
    models = real.capabilities || [];
    actions = `<button class="button secondary" data-action="edit-real-model" data-id="${escapeHtml(selectedReal)}">编辑聚合策略</button>`;
  }

  if (selectedVendor) {
    const vendor = vendorGroups.find((item) => item.id === selectedVendor);
    const stats = summarizeKeys(vendor?.keys.map(({ key }) => key) || []);
    state = vendor?.summary || { lamp: 'off', label: '没有槽位' };
    kicker = '供应商分组';
    title = selectedVendor;
    rows = [
      detail('上游', vendor?.providers.size || 0),
      detail('Key', vendor?.keys.length || 0),
      detail('可调度', stats.hot),
      detail('冷却', stats.cooling),
    ];
    models = [...(vendor?.models || [])];
    actions = '';
  }

  if (selectedProvider) {
    const providerKeys = keys.filter(({ key }) => key.deployment === selectedProvider.id).map(({ key }) => key);
    const summary = summarizeKeys(providerKeys);
    state = !selectedProvider.enabled
      ? { lamp: 'off', label: '已停用' }
      : slotSummary(providerKeys);
    kicker = '上游';
    title = selectedProvider.label || selectedProvider.id;
    rows = [
      detail('配置 ID', selectedProvider.id),
      detail('协议', `${selectedProvider.apiFormat || 'openai'} · ${selectedProvider.auth || 'bearer'}`),
      detail('地址', selectedProvider.baseUrl || '—', 'break'),
      detail('活动 / 容量', `${fmt(summary.inflight)} / ${fmt(summary.cap)}`),
      detail('出口策略', proxyModeName(proxyPolicyValue(selectedProvider.proxy))),
    ];
    models = selectedProvider.models || [];
    actions = `<button class="button secondary" data-action="inspect-provider" data-id="${escapeHtml(selectedProvider.id)}">完整详情</button><button class="button primary" data-action="edit-provider" data-id="${escapeHtml(selectedProvider.id)}">编辑上游</button>`;
  }

  if (selectedKey) {
    const key = selectedKey.key;
    state = slotState(key);
    kicker = 'Key 槽位';
    title = keyDisplayName(key, selectedKey.index, detailLevel);
    const provider = providers.find((item) => item.id === key.deployment);
    const egress = egressForKey(key, provider);
    rows = [
      detail('上游', provider?.label || key.deployment || '—'),
      detail('供应商', vendorId(key)),
      detail('活动 / 容量', `${fmt(key.inflight)} / ${fmt(key.cap)}`),
      detail('今日 2XX / 错误', `${fmt(key.total_2xx_today)} / ${fmt(keyErrors(key))}`),
      detail('出口', egress.label),
      detail('冷却原因', key.cooldown_reason || '—'),
    ];
    models = [...slotModels(key)];
    actions = provider ? `<button class="button secondary" data-action="inspect-provider" data-id="${escapeHtml(provider.id)}">查看所属上游</button>` : '';
  }

  if (selectedEgress) {
    state = { lamp: selectedEgress.lamp, label: selectedEgress.lamp === 'bad' ? '出口异常' : '已关联' };
    kicker = '代理出口';
    title = selectedEgress.label;
    rows = [
      detail('路由方式', selectedEgress.detail),
      detail('关联 Key', selectedEgress.keys.length),
      detail('出口标识', selectedEgress.id),
    ];
    models = [];
    actions = '<a class="button secondary" href="#connections">管理出口</a>';
  }

  return `<aside class="relationship-inspector" aria-live="polite">
    <header><span>${escapeHtml(kicker)}</span><h3>${escapeHtml(title)}</h3></header>
    <div class="inspector-state"><span class="square-lamp ${state.lamp}"></span><b>${escapeHtml(state.label)}</b></div>
    <dl class="relationship-detail-list">${rows.join('')}</dl>
    ${models.length ? `<section><span>关联能力与模型</span><div class="tag-cloud">${tags(models, 12)}</div></section>` : ''}
    ${actions ? `<footer>${actions}</footer>` : ''}
  </aside>`;
}

function pathSegment(label, action, id, extra = {}) {
  const data = Object.entries(extra).map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`).join('');
  return `<button data-action="${action}" data-id="${escapeHtml(id)}" data-path="true"${data}>${escapeHtml(label)}</button>`;
}

function pathArrow() {
  return '<i aria-hidden="true">→</i>';
}

function keySlotId(key, index) {
  return key?.slot_id || `key-${String(index + 1).padStart(3, '0')}`;
}

function keyDisplayName(key, index, detailLevel) {
  const slot = keySlotId(key, index);
  return detailLevel === 'safe' ? `#${String(index + 1).padStart(3, '0')}` : key?.name || slot;
}

function vendorId(key) {
  return key?.vendor || '未标注';
}

function groupVendors(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const id = vendorId(entry.key);
    const group = groups.get(id) || { id, keys: [], providers: new Set(), models: new Set() };
    group.keys.push(entry);
    group.providers.add(entry.key.deployment || entry.key.provider || 'unknown');
    slotModels(entry.key).forEach((model) => group.models.add(model));
    groups.set(id, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    summary: slotSummary(group.keys.map(({ key }) => key)),
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function providerVendors(providerId, entries) {
  return [...new Set(entries.filter(({ key }) => key.deployment === providerId).map(({ key }) => vendorId(key)))];
}

function egressForKey(key, provider) {
  const node = key.proxy_node || key.proxyNode || '';
  const profile = key.proxy_profile || key.proxyProfile || '';
  const mode = key.proxy_mode || key.proxyMode || proxyPolicyValue(provider?.proxy);
  if (node) return { id: `node:${node}`, label: node, detail: `${proxyModeName(mode)} · 固定节点` };
  if (profile) return { id: `profile:${profile}`, label: profile, detail: `${proxyModeName(mode)} · 代理配置` };
  return { id: `mode:${mode}`, label: proxyModeName(mode), detail: mode === 'direct' ? '不经过代理池' : '由出口策略选择节点' };
}

function groupEgress(entries, providers) {
  const groups = new Map();
  for (const entry of entries) {
    const provider = providers.find((item) => item.id === entry.key.deployment);
    const descriptor = egressForKey(entry.key, provider);
    const group = groups.get(descriptor.id) || { ...descriptor, keys: [] };
    group.keys.push(entry);
    groups.set(group.id, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    lamp: group.keys.some(({ key }) => key.proxy_error) ? 'bad' : slotSummary(group.keys.map(({ key }) => key)).lamp,
  }));
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
