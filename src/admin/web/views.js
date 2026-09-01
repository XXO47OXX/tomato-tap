import { badge, cost, escapeHtml, fmt, fmtDuration, tags } from './ui.js';
import { costParts, costTotals } from './cost-format.js';
import {
  priceCatalogView,
  providerDrawer,
  providerLedger,
  relationshipWorkbench,
} from './workbenches.js';
import {
  formatCountdown,
  keyErrors,
  normalizeModelName,
  providerReady,
  proxyPolicyValue,
  slotModels,
  slotState,
  summarizeKeys,
} from './view-data.js';

export const PAGE_META = Object.freeze({
  overview: ['工作台', '运行与用量'],
  models: ['模型与路由', '任务入口、聚合模型与上游链路'],
  connections: ['上游与凭据', '地址、Key、并发与代理池'],
  diagnostics: ['诊断', '容量、冷却、重试与最近事件'],
  usage: ['用量与费用', '请求、Token 与成本'],
  settings: ['设置', '本地运行与数据保留'],
  setup: ['首次配置', '添加第一个上游'],
  providers: ['上游与凭据', '地址、Key、并发与代理池'],
  egress: ['上游与凭据', '地址、Key、并发与代理池'],
  runtime: ['诊断', '容量、冷却、重试与最近事件'],
});

export function overviewView(data) {
  const status = data.status || {};
  const keys = status.key_pool || [];
  const stats = summarizeKeys(keys);
  const providers = data.configuration.providers || [];
  const logical = data.models.logical || [];
  const usage = data.usage_today?.total || {};
  const configState = status.runtime_config || {};
  const readyProviders = providers.filter((provider) => providerReady(provider, keys)).length;
  const gatewayReady = data.configuration.configured && !configState.last_error;
  const pricedRequests = Number(usage.pricedRequests) || 0;
  const unpricedRequests = Number(usage.unpricedRequests) || 0;
  const pricingCoverage = Number(usage.requests) > 0
    ? `${(pricedRequests / Number(usage.requests) * 100).toFixed(1)}%`
    : '—';
  return `
    <section class="overview-summary ${gatewayReady ? '' : 'attention'}">
      <div class="gateway-state"><span class="square-lamp ${gatewayReady ? 'ok' : 'warn'}"></span><div><b>${gatewayReady ? '网关运行正常' : data.configuration.configured ? '配置需要处理' : '尚未配置'}</b><small class="mono">${escapeHtml(status.access?.bind_host || '127.0.0.1')} · ${escapeHtml(configState.active_revision || 'no revision')}</small></div></div>
      <dl class="summary-facts"><div><dt>上游</dt><dd class="mono">${readyProviders}/${providers.length}</dd></div><div><dt>可调度 Key</dt><dd class="mono">${fmt(stats.hot)}/${fmt(keys.length)}</dd></div><div><dt>冷却</dt><dd class="mono">${fmt(stats.cooling)}</dd></div><div><dt>活动 / 容量</dt><dd class="mono">${fmt(stats.inflight)}/${fmt(stats.cap)}</dd></div></dl>
      <div class="summary-actions"><button class="text-action" data-action="copy-endpoint" data-path="/oa/v1">复制 API 地址</button><button class="button secondary" data-action="${data.configuration.configured ? 'new-provider' : 'open-setup'}">${data.configuration.configured ? '添加上游' : '开始配置'}</button></div>
    </section>
    <section class="summary-ledger" aria-label="今日摘要">
      ${summaryMetric('今日请求', fmt(usage.requests), '来自今日用量账本')}
      ${summaryMetric('计价覆盖', pricingCoverage, `已计价 ${fmt(pricedRequests)} · 未计价 ${fmt(unpricedRequests)}`)}
      ${tokenSummaryMetric(usage)}
      ${costSummaryMetric('今日费用', usage)}
    </section>
    <section class="panel ledger-panel attention-panel">
      ${sectionTitle('需要处理', '<a href="#diagnostics" class="text-action">打开诊断</a>')}
      ${attentionList(providers, keys)}
    </section>
    <section class="section">
      <div class="section-head"><div><h2>逻辑模型状态</h2></div><a href="#models" class="text-action">配置模型</a></div>
      ${logicalTable(logical)}
    </section>
    <section class="section panel ledger-panel">
      ${sectionTitle('今日流量分布', '<a href="#usage" class="text-action">查看用量</a>')}
      ${trafficRows(data.usage_today?.byModel || [])}
    </section>`;
}

export function providersView(data, { embedded = false, filters = {} } = {}) {
  const providers = data.configuration.providers || [];
  const keys = data.status?.key_pool || [];
  const ready = providers.filter((provider) => providerReady(provider, keys)).length;
  const filtered = filterProviders(providers, keys, filters);
  const protocols = [...new Set(providers.map((provider) => provider.apiFormat || 'openai'))].sort();
  return `
    ${embedded ? '' : `<section class="page-summary">
      <div><h2>上游列表</h2></div>
      <dl><div><dt>已配置</dt><dd>${fmt(providers.length)}</dd></div><div><dt>可调度</dt><dd>${fmt(ready)}</dd></div><div><dt>API Key</dt><dd>仅显示掩码</dd></div></dl>
      <button class="button primary" data-action="new-provider">添加上游</button>
    </section>`}
    ${embedded ? providerFilterBar(filters, protocols, filtered.length, providers.length) : ''}
    <section class="section provider-ledger compact-ledger">
      ${filtered.length ? providerLedger(filtered, keys) : '<div class="empty-state compact"><h3>没有符合条件的上游</h3><p>调整搜索词或筛选条件。</p><button class="button ghost" data-action="provider-filter-reset">清除筛选</button></div>'}
    </section>`;
}

export function modelsView(data, focus = {}, perspective = 'logical', query = '') {
  const real = data.configuration.realModels || [];
  const logical = data.configuration.logicalModels || [];
  const providers = data.configuration.providers || [];
  const keys = data.status?.key_pool || [];
  const logicalStatus = data.models?.logical || [];
  return `
    <section class="page-summary">
      <div><h2>模型路由</h2></div>
      <dl><div><dt>任务入口</dt><dd>${fmt(logical.length)}</dd></div><div><dt>聚合模型</dt><dd>${fmt(real.length)}</dd></div><div><dt>上游</dt><dd>${fmt(providers.length)}</dd></div></dl>
      <div class="inline-actions"><a href="#connections" class="button secondary">管理上游与出口</a><button class="button primary" data-action="new-logical">新建逻辑模型</button></div>
    </section>
    ${relationshipWorkbench({ logicalModels: logical, realModels: real, providers, keys, logicalStatus, focus, perspective, query, detailLevel: data.status?.admin_detail_level || data.access?.detail_level || 'safe' })}
    <section class="section">
      <div class="section-head"><div><h2>聚合模型策略</h2></div></div>
      <div class="table-wrap"><table><thead><tr><th>聚合模型</th><th>供应来源</th><th>质量级别</th><th>能力</th><th>思考适配</th><th class="num">并发</th><th>首包 / 总超时</th><th>操作</th></tr></thead><tbody>
        ${real.map((model) => `<tr><td><div class="model-cell"><span class="square-lamp ${model.standaloneOnly ? 'warn' : 'ok'}"></span><span class="mono">${escapeHtml(model.name)}</span></div>${model.standaloneOnly ? '<small class="row-sub">仅限单独调用</small>' : ''}</td><td><div class="provider-models">${tags(modelProviders(model.name, providers), 4)}</div></td><td>${escapeHtml(model.qualityTier)}</td><td><div class="provider-models">${tags(model.capabilities, 6)}</div></td><td class="mono">${escapeHtml(model.thinkingAdapter)}</td><td class="num">${fmt(model.maxInflight)}</td><td class="mono">${fmtDuration(model.firstByteTimeoutMs)} / ${fmtDuration(model.totalTimeoutMs)}</td><td><button class="text-action" data-action="edit-real-model" data-id="${escapeHtml(model.name)}">编辑策略</button></td></tr>`).join('') || '<tr><td colspan="8">暂无真实模型</td></tr>'}
      </tbody></table></div>
    </section>`;
}

export function egressView(data, { embedded = false } = {}) {
  const egress = data.configuration.egress || {};
  const providers = data.configuration.providers || [];
  const keys = data.status?.key_pool || [];
  const proxied = providers.filter((provider) => proxyPolicyValue(provider.proxy) !== 'direct').length;
  const assigned = new Set(keys.map((key) => key.proxy_node).filter(Boolean)).size;
  return `
    ${embedded ? '' : `<section class="page-summary">
      <div><h2>代理池与固定出口</h2></div>
      <dl><div><dt>代理上游</dt><dd>${fmt(proxied)}</dd></div><div><dt>活动节点</dt><dd>${fmt(assigned)}</dd></div><div><dt>订阅源</dt><dd>${fmt(egress.subscriptions?.count || 0)}</dd></div></dl>
      <button class="button secondary" data-action="reload">刷新运行状态</button>
    </section>`}
    <div class="notice-line"><span class="square-lamp ok"></span><span>订阅与节点信息仅保存到本机 <code>.env</code>，保存后不再展示。粘性出口不可用时，保持绑定关系并进入冷却，不会自动切换出口 IP。</span></div>
    <section class="egress-source-grid section">
      ${egressSourceCard('订阅源', egress.subscriptions, `${fmt(egress.subscriptions?.count || 0)} 个`)}
      ${egressSourceCard('静态节点', egress.staticNodes, egress.staticNodes?.configured ? '已写入本地' : '未配置')}
      ${egressSourceCard('共享 HTTP 代理', egress.sharedProxy, egress.sharedProxy?.fallback ? '使用 HTTPS_PROXY' : egress.sharedProxy?.configured ? '已配置' : '未配置')}
    </section>
    <section class="section panel panel-pad">
      <div class="panel-title"><div><h3>代理源设置</h3><p>留空保持现值；订阅和节点立即生效，共享 HTTP 代理重启后生效</p></div>${badge('保存后不再展示', 'info')}</div>
      <form id="egress-form" class="field-grid">
        <label class="field full"><span>订阅 URL</span><textarea name="subscriptionUrls" placeholder="每行一个 http(s) 订阅地址"></textarea><small>${secretSettingHint(egress.subscriptions)}</small></label>
        <label class="check-field"><input type="checkbox" name="clearSubscriptionUrls" ${egress.subscriptions?.writable === false ? 'disabled' : ''}>清除现有订阅地址</label>
        <span></span>
        <label class="field full"><span>静态 VLESS 节点或 Base64 订阅</span><textarea name="staticNodes" placeholder="可粘贴多行 vless://…；保存时自动编码"></textarea><small>${secretSettingHint(egress.staticNodes)}</small></label>
        <label class="check-field"><input type="checkbox" name="clearStaticNodes" ${egress.staticNodes?.writable === false ? 'disabled' : ''}>清除静态节点</label>
        <span></span>
        <label class="field full"><span>共享 HTTP(S) 代理</span><input name="sharedProxyUrl" type="password" autocomplete="new-password" placeholder="http://127.0.0.1:7890"><small>${secretSettingHint(egress.sharedProxy)}</small></label>
        <label class="check-field"><input type="checkbox" name="clearSharedProxy" ${egress.sharedProxy?.writable === false ? 'disabled' : ''}>清除专用共享代理</label>
        <div class="form-actions field full"><button class="button primary">保存</button></div>
      </form>
    </section>
    <section class="section">
      <div class="section-head"><div><h2>上游 Key 与出口</h2><p>固定出口优先，其次使用上游策略，最后直连</p></div><a class="text-action" href="#connections">管理上游</a></div>
      ${egressBindingTable(providers, keys)}
    </section>`;
}

export function connectionsView(data, tab = 'providers', filters = {}) {
  const providers = data.configuration.providers || [];
  const keys = data.status?.key_pool || [];
  const ready = providers.filter((provider) => providerReady(provider, keys)).length;
  const egress = data.configuration.egress || {};
  const activeTab = tab === 'egress' ? 'egress' : 'providers';
  return `
    <div class="connections-toolbar">
      <div class="segmented count-tabs" aria-label="上游配置视图">
        <button class="${activeTab === 'providers' ? 'active' : ''}" data-action="connections-tab" data-tab="providers">上游与 Key <span>${fmt(providers.length)}</span></button>
        <button class="${activeTab === 'egress' ? 'active' : ''}" data-action="connections-tab" data-tab="egress">代理池与出口 <span>${fmt(egress.subscriptions?.count || 0)}</span></button>
      </div>
      <div class="connections-actions"><span class="dispatch-summary"><span class="square-lamp ${ready ? 'ok' : 'idle'}"></span><b class="mono">${fmt(ready)}</b> 可调度</span><button class="button primary" data-action="new-provider">添加上游</button></div>
    </div>
    ${activeTab === 'providers' ? providersView(data, { embedded: true, filters }) : egressView(data, { embedded: true })}`;
}

export function diagnosticsView(data, focus = {}) {
  const status = data.status || {};
  const keys = status.key_pool || [];
  const providers = data.configuration.providers || [];
  const stats = summarizeKeys(keys);
  const runtime = status.runtime_config || {};
  const detailLevel = status.admin_detail_level || data.access?.detail_level || 'safe';
  const selectedProvider = providers.some((provider) => provider.id === focus.provider)
    ? focus.provider
    : '';
  const providerKeys = selectedProvider
    ? keys.filter((key) => key.deployment === selectedProvider)
    : keys;
  const models = [...new Set(providerKeys.flatMap((key) => [...slotModels(key)]))].sort();
  const selectedModel = models.includes(normalizeModelName(focus.model))
    ? normalizeModelName(focus.model)
    : '';
  const modelKeys = selectedModel
    ? providerKeys.filter((key) => slotModels(key).has(selectedModel))
    : providerKeys;
  const selectedSlot = modelKeys.some((key, index) => keySlotId(key, keys.indexOf(key)) === focus.slot)
    ? focus.slot
    : '';
  const visibleKeys = selectedSlot
    ? modelKeys.filter((key) => keySlotId(key, keys.indexOf(key)) === selectedSlot)
    : modelKeys;
  const events = (status.quota_infer_events || []).filter((event) => (
    !selectedSlot || event.slot_id === selectedSlot || event.key === visibleKeys[0]?.name
  ));
  const health = diagnosticHealth(status, stats, keys.length);
  const issues = diagnosticIssues(keys);
  return `
    <div class="diagnostic-health ${health.tone}"><span class="square-lamp ${health.lamp}"></span><b>${escapeHtml(health.label)}</b><span>${escapeHtml(health.detail)}</span><small>${fmt(stats.hot)} 可调度 · ${fmt(stats.cooling)} 冷却 · ${fmt(stats.inflight)}/${fmt(stats.cap)} 活动/容量 · ${escapeHtml(formatEventTime(data.generated_at))}</small><button class="text-action" data-action="reload">重载</button></div>
    <section class="diagnostic-action-grid section">
      <div class="panel ledger-panel diagnostic-issues">
        ${sectionTitle('当前异常', `<span class="diagnostic-count">${fmt(issues.length)} 个槽位需要关注</span>`)}
        ${diagnosticIssuesTable(issues, keys, detailLevel)}
      </div>
      <div class="panel ledger-panel diagnostic-capacity">
        ${sectionTitle('容量与恢复', `<a href="#settings" class="text-action">${escapeHtml(detailLevelName(detailLevel))}视图</a>`)}
        <div class="diagnostic-inline-stats">
          <div><span>重试恢复</span><b class="mono">${fmt(retryRecovered(status.retry_stats_today))}</b></div>
          <div><span>额度识别</span><b class="mono">${fmt(sumObject(status.quota_infer_counts))}</b></div>
          <div><span>持久化</span><b>${status.quota_persistence_healthy === false || status.cooldown_persistence_healthy === false ? '异常' : '正常'}</b></div>
        </div>
        ${cooldownBuckets(keys)}
        ${retryCompact(status.retry_stats_today)}
        <div class="diagnostic-revision mono">配置 ${escapeHtml(runtime.active_revision || '—')}</div>
      </div>
    </section>
    <section class="section panel panel-pad diagnostic-explorer">
      <div class="panel-title"><div><h3>逐层定位</h3><p>按上游、模型和 Key 槽位缩小范围；留空表示全部。</p></div><span class="mono muted">${fmt(visibleKeys.length)} 个槽位</span></div>
      <div class="diagnostic-filters">
        ${diagnosticSelect('diagnosticProvider', '上游', selectedProvider, providers.map((provider) => [provider.id, provider.label || provider.id]))}
        ${diagnosticSelect('diagnosticModel', '模型', selectedModel, models.map((model) => [model, model]))}
        ${diagnosticSelect('diagnosticSlot', 'Key 槽位', selectedSlot, modelKeys.map((key) => {
          const index = keys.indexOf(key);
          const slot = keySlotId(key, index);
          return [slot, keyDisplayName(key, index, detailLevel)];
        }))}
        <button class="button ghost" data-action="diagnostic-reset">清除筛选</button>
      </div>
      ${diagnosticKeyTable(visibleKeys, keys, detailLevel)}
    </section>
    <section class="section">
      <div class="section-head"><div><h2>最近额度与限流事件</h2><p>最近 100 条内存事件，进程重启后清空。${detailLevel === 'debug' ? '当前显示上游响应片段。' : ''}</p></div><span class="mono muted">${fmt(events.length)} 条</span></div>
      ${diagnosticEventsTable(events, detailLevel)}
    </section>`;
}

export function runtimeView(data) {
  const status = data.status || {};
  const keys = status.key_pool || [];
  const stats = summarizeKeys(keys);
  const runtime = status.runtime_config || {};
  return `
    <section class="page-summary">
      <div><h2>运行时与冷却</h2></div>
      <dl><div><dt>可调度</dt><dd>${fmt(stats.hot)}</dd></div><div><dt>冷却</dt><dd>${fmt(stats.cooling)}</dd></div><div><dt>活动 / 容量</dt><dd>${fmt(stats.inflight)} / ${fmt(stats.cap)}</dd></div></dl>
      <button class="button secondary" data-action="reload">立即重载</button>
    </section>
    <section class="runtime-grid section">
      <div class="panel ledger-panel">
        ${sectionTitle('配置版本')}
        <dl class="runtime-definitions">
          ${definition('当前版本', runtime.active_revision || '—')}
          ${definition('待切换版本', runtime.pending_revision || '无')}
          ${definition('重载次数', fmt(runtime.reload_count))}
          ${definition('活动请求', fmt(runtime.active_requests))}
          ${definition('额度状态', status.quota_persistence_healthy === false ? '异常' : '正常')}
          ${definition('冷却状态', status.cooldown_persistence_healthy === false ? '异常' : '正常')}
        </dl>
        ${runtime.last_error ? `<div class="callout danger break">${escapeHtml(runtime.last_error)}</div>` : '<div class="notice-line compact"><span class="square-lamp ok"></span><span>当前配置校验通过。</span></div>'}
      </div>
      <div class="panel ledger-panel">
        ${sectionTitle('冷却队列')}
        ${cooldownList(keys, 10)}
      </div>
    </section>
    <section class="section">
      <div class="section-head"><div><h2>Key 槽位</h2><p>不显示凭证内容</p></div><span class="mono muted">${fmt(keys.length)} 个槽位</span></div>
      ${runtimeKeyTable(keys)}
    </section>`;
}

export function usageView(usage, period = 'today', dimension = 'model', options = {}) {
  if (!usage) return '<div class="loading-card"><span class="spinner"></span>正在聚合用量…</div>';
  const tab = options.tab === 'prices' ? 'prices' : 'analysis';
  const sectionTabs = `<div class="view-tabs" aria-label="用量与费用视图"><button class="${tab === 'analysis' ? 'active' : ''}" data-action="usage-tab" data-tab="analysis">用量与费用</button><button class="${tab === 'prices' ? 'active' : ''}" data-action="usage-tab" data-tab="prices">价格目录</button></div>`;
  if (tab === 'prices') return `${sectionTabs}${priceCatalogView(options.prices, options.priceFilters)}`;
  const total = usage.total || {};
  const today = !usage.period;
  const rows = today
    ? ({ model: usage.byModel, provider: usage.byProvider, vendor: usage.byVendor, route: usage.byRoute })[dimension] || []
    : usage.rows || [];
  const activeDimension = today ? dimension : usage.dimension || dimension;
  return `
    ${sectionTabs}
    <div class="toolbar">
      <div class="segmented" aria-label="统计周期">
        ${periodButton('today', '今日', period)}${periodButton('week', '本周', period)}${periodButton('month', '本月', period)}${periodButton('custom', '自定义', period)}
      </div>
      <span class="toolbar-spacer"></span>
      ${dimensionButton('model', '按模型', activeDimension)}
      ${dimensionButton('provider', '按上游', activeDimension)}
      ${dimensionButton('vendor', '按供应商', activeDimension)}
      ${dimensionButton('route', '按接口', activeDimension)}
    </div>
    <form id="usage-range" class="toolbar" ${period === 'custom' ? '' : 'hidden'}>
      <label class="field"><span>开始</span><input name="from" type="date" value="${period === 'custom' && usage.period === 'custom' ? escapeHtml(usage.from || '') : ''}" required></label>
      <label class="field"><span>结束</span><input name="to" type="date" value="${period === 'custom' && usage.period === 'custom' ? escapeHtml(usage.to || '') : ''}" required></label>
      <button class="button primary">查询</button>
    </form>
    <section class="usage-summary">
      ${summaryMetric('请求数', fmt(total.requests), '包含内部重试')}
      ${summaryMetric('输入 Token', fmt(total.input), `缓存 ${fmt(total.inputCached)}`)}
      ${summaryMetric('输出 Token', fmt(total.output), `合计 ${fmt((total.input || 0) + (total.output || 0))}`)}
      <div class="cost-summary-cell"><span>费用</span>${costSummary(total)}</div>
    </section>
    <section class="section panel ledger-panel">
      ${sectionTitle(`按${dimensionLabel(activeDimension)}统计`)}
      ${usageBars(rows)}
    </section>
    <section class="section">
      <div class="section-head"><div><h2>明细</h2><p>${escapeHtml(usage.from || usage.date || '')}${usage.to ? ` → ${escapeHtml(usage.to)}` : ''} · ${dimensionLabel(activeDimension)}</p></div><button class="text-action" data-action="usage-tab" data-tab="prices">查看价格目录</button></div>
      ${usageTable(rows, activeDimension)}
    </section>`;
}

export function providerDetailView(data, id) {
  const provider = (data.configuration.providers || []).find((item) => item.id === id);
  return providerDrawer(provider, data.status?.key_pool || [], data.status?.admin_detail_level || data.access?.detail_level || 'safe');
}

export function settingsView(data) {
  const settings = data.configuration.settings || {};
  const sample = data.status?.sample_logging || {};
  return `
    <div class="grid-2">
      <section class="panel panel-pad">
        <div class="panel-title"><div><h3>运行路径</h3><p>只显示末三级目录，不暴露工作站完整路径</p></div></div>
        <dl class="provider-meta">
          ${definition('密钥文件', data.configuration.paths.env)}
          ${definition('上游配置', data.configuration.paths.relays)}
          ${definition('模型配置', data.configuration.paths.models)}
          ${definition('监听地址', data.status?.access?.bind_host || '127.0.0.1')}
        </dl>
        <button class="button secondary" data-action="export-config">导出脱敏配置</button>
      </section>
      <section class="panel panel-pad">
        <div class="panel-title"><div><h3>安全状态</h3><p>开源版默认仅监听本机</p></div></div>
        <div class="callout ${data.access?.loopback_only ? '' : 'warn'}">${data.access?.loopback_only
          ? '控制台仅通过 loopback 访问。客户端请求默认可信，不需要二级 Key。'
          : data.access?.token_required
            ? '控制台已启用管理令牌。请同时使用主机防火墙限制来源。'
            : '非 loopback 监听且未设置管理令牌，写入 API 已自动关闭。'}</div>
      </section>
    </div>
    <section class="section panel panel-pad">
      <div class="panel-title"><div><h3>本地运行设置</h3><p>这些进程级选项保存后需要重启；上游 Key、地址和模型不需要重启。</p></div>${badge('重启后生效', 'warn')}</div>
      <form id="settings-form" class="field-grid">
        <label class="field"><span>实例级诊断显示上限</span><select name="TOMATO_TAP_ADMIN_DETAIL_LEVEL">
          <option value="safe" ${selected(settings.TOMATO_TAP_ADMIN_DETAIL_LEVEL || 'safe', 'safe')}>安全：匿名槽位</option>
          <option value="operator" ${selected(settings.TOMATO_TAP_ADMIN_DETAIL_LEVEL, 'operator')}>运维：显示 Key 名称与 host</option>
          <option value="debug" ${selected(settings.TOMATO_TAP_ADMIN_DETAIL_LEVEL, 'debug')}>调试：再显示响应片段</option>
        </select><small>对访问本实例控制台的所有管理员生效，不是个人偏好。完整 API Key 在任何级别都不会返回浏览器。</small></label>
        <label class="field"><span>允许状态接口显示上游 host</span><select name="TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS"><option value="false" ${selected(settings.TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS || 'false', 'false')}>关闭</option><option value="true" ${selected(settings.TOMATO_TAP_EXPOSE_UPSTREAM_HOSTS, 'true')}>开启</option></select><small>运维或调试级别下仍需开启此项才能看到 Key 对应 host。</small></label>
        ${settingField('TOMATO_TAP_DEFAULT_USER_AGENT', '缺失 UA 的回退值', settings, '留空则不添加')}
        <label class="field"><span>记录原始样本</span><select name="TOMATO_TAP_SAMPLES_ENABLED"><option value="false" ${selected(settings.TOMATO_TAP_SAMPLES_ENABLED, 'false')}>关闭（推荐）</option><option value="true" ${selected(settings.TOMATO_TAP_SAMPLES_ENABLED, 'true')}>开启</option></select><small>当前：${sample.enabled ? '已开启' : '已关闭'}。样本可能含提示词与响应。</small></label>
        ${settingField('TOMATO_TAP_SAMPLES_RETENTION', '样本保留时间', settings, '24h')}
        ${settingField('TOMATO_TAP_SAMPLES_MAX_SIZE', '样本最大空间', settings, '512MiB')}
        ${settingField('TOMATO_TAP_USAGE_RETENTION', '用量日志保留时间', settings, '90d')}
        ${settingField('TOMATO_TAP_USAGE_ARCHIVE_MAX_SIZE', '用量归档最大空间', settings, '4GiB')}
        <div class="form-actions field full"><button class="button primary">保存设置</button></div>
      </form>
    </section>`;
}

export function setupView(data = {}) {
  return `<section class="setup-shell">
    <div class="setup-intro">
      <p class="eyebrow">首次配置</p><h2>添加你的第一个上游</h2>
      <p>配置保存在本机；上游地址、User-Agent 和 API Key 不会写入仓库。</p>
      <div class="setup-steps">
        <div class="setup-step"><b>连接上游</b><span>填写 Base URL、协议和 API Key</span></div>
        <div class="setup-step"><b>选择模型</b><span>可同时创建 balanced 逻辑模型</span></div>
        <div class="setup-step"><b>开始调用</b><span>保存后从统一入口使用</span></div>
      </div>
    </div>
    <div class="setup-form"><form id="setup-provider-form">${providerFields(null, true, data.configuration?.realModels || [])}<div class="form-actions"><button class="button primary">保存并启用</button></div></form></div>
  </section>`;
}

export function providerForm(provider = null, realModels = [], { isNew = false } = {}) {
  return `<form id="provider-form">${providerFields(provider, false, realModels, isNew)}<div class="form-actions"><button type="button" class="button ghost" data-action="close-modal">取消</button><button class="button primary">保存</button></div></form>`;
}

export function logicalForm(model = null, realModels = []) {
  const candidates = model?.candidates || [];
  const request = model?.request || {};
  const planUrl = model?.name
    ? `/__route/plan?model=${encodeURIComponent(model.name)}`
    : '';
  return `<form id="logical-form" class="field-grid">
    <label class="field"><span>逻辑模型名</span><input name="name" value="${escapeHtml(model?.name || '')}" placeholder="balanced" required></label>
    <label class="field"><span>调度策略</span><select name="candidateStrategy"><option value="fair" ${selected(model?.candidateStrategy, 'fair')}>公平轮转</option><option value="ordered" ${selected(model?.candidateStrategy, 'ordered')}>按顺序回退</option><option value="adaptive" ${selected(model?.candidateStrategy, 'adaptive')}>健康 / 延迟自适应</option></select><small>自适应会优先选择实时成功率、空闲容量和延迟更好的候选。</small></label>
    ${modelPickerField({ name: 'candidates', values: candidates, catalog: realModels.map((item) => item.name), label: '候选真实模型', ordered: true })}
    <label class="field full"><span>必需能力</span><input name="requiredCapabilities" value="${escapeHtml((model?.requiredCapabilities || ['instruction_following']).join(', '))}"></label>
    <label class="field"><span>质量级别约束</span><input name="qualityTier" value="${escapeHtml(model?.qualityTier || '')}" placeholder="留空：允许能力匹配的模型"></label>
    <label class="field"><span>最大并发</span><input name="maxInflight" type="number" min="1" value="${model?.maxInflight || 8}"></label>
    <label class="field"><span>最大尝试次数</span><input name="maxAttempts" type="number" min="1" value="${model?.maxAttempts || 3}"></label>
    <label class="field"><span>总截止时间（ms）</span><input name="deadlineMs" type="number" min="1000" value="${model?.deadlineMs || 300000}"></label>
    <label class="field"><span>拥塞等待（ms）</span><input name="logicalAdmissionWaitMs" type="number" min="0" value="${model?.logicalAdmissionWaitMs || 30000}"></label>
    <details class="advanced field full"><summary>请求策略、会话亲和与容量保护</summary><div class="field-grid">
      <label class="field"><span>推理强度</span><select name="requestReasoningEffort"><option value="">不覆盖下游请求</option>${['none', 'minimal', 'low', 'medium', 'high', 'max'].map((effort) => `<option value="${effort}" ${selected(request.reasoningEffort, effort)}>${effort}</option>`).join('')}</select></label>
      <label class="field"><span>Temperature</span><input name="requestTemperature" type="number" min="0" max="2" step="0.01" value="${request.temperature ?? ''}" placeholder="不覆盖"></label>
      <label class="field"><span>流式响应</span><select name="requestStream"><option value="">不覆盖</option><option value="true" ${selected(String(request.stream), 'true')}>强制开启</option><option value="false" ${selected(String(request.stream), 'false')}>强制关闭</option></select></label>
      <label class="field"><span>最大输出 Token</span><input name="requestMaxOutputTokens" type="number" min="1" value="${request.maxOutputTokens || ''}" placeholder="不限制"></label>
      <label class="field"><span>最大输入 Token（估算）</span><input name="requestMaxInputTokens" type="number" min="1" value="${request.maxInputTokens || ''}" placeholder="不限制"></label>
      <label class="field"><span>强模型预留槽</span><input name="minReadySlots" type="number" min="0" value="${model?.minReadySlots || 0}"></label>
      <label class="check-field"><input name="sessionAffinity" type="checkbox" ${model?.sessionAffinity ? 'checked' : ''}>同一 session 优先保持模型</label>
      <label class="check-field"><input name="preferDifferentFromPrevious" type="checkbox" ${model?.preferDifferentFromPrevious ? 'checked' : ''}>优先避开上一次模型</label>
      <label class="check-field"><input name="allowWeakFallback" type="checkbox" ${model?.allowWeakFallback === false ? '' : 'checked'}>允许弱质量级别回退</label>
      <label class="check-field"><input name="protected" type="checkbox" ${model?.protected ? 'checked' : ''}>保护该逻辑模型的强模型容量</label>
    </div></details>
    <div class="route-preview field full"><span>路由预览</span><div><code data-preview-logical>${escapeHtml(model?.name || 'logical-model')}</code><i>→</i><code data-preview-candidates>${escapeHtml(candidates.join(' → ') || '选择候选模型')}</code><i>→</i><code>响应（含真实模型）</code></div><small>策略 <b data-preview-strategy>${escapeHtml(model?.candidateStrategy || 'fair')}</b> · 截止时间 <b data-preview-deadline>${fmtDuration(model?.deadlineMs || 300000)}</b> · User-Agent 与出口由命中的上游 Key 决定</small></div>
    <div class="form-actions field full">${planUrl ? `<a class="button secondary" href="${escapeHtml(planUrl)}" target="_blank" rel="noreferrer">查看当前路由</a>` : ''}<button type="button" class="button ghost" data-action="close-modal">取消</button><button class="button primary">保存</button></div>
  </form>`;
}

export function realModelForm(model) {
  const capabilities = model?.capabilities || [];
  return `<form id="real-model-form" class="field-grid">
    <label class="field full"><span>真实模型 ID</span><input name="name" value="${escapeHtml(model?.name || '')}" readonly></label>
    <label class="field"><span>质量级别</span><input name="qualityTier" value="${escapeHtml(model?.qualityTier || 'standard')}" placeholder="standard / strong / flagship" required></label>
    <label class="field"><span>思考适配</span><select name="thinkingAdapter"><option value="none" ${selected(model?.thinkingAdapter, 'none')}>不改写</option><option value="glm_disabled" ${selected(model?.thinkingAdapter, 'glm_disabled')}>关闭 GLM 思考</option><option value="deepseek_disabled" ${selected(model?.thinkingAdapter, 'deepseek_disabled')}>关闭 DeepSeek 思考</option><option value="longcat_disabled" ${selected(model?.thinkingAdapter, 'longcat_disabled')}>关闭 LongCat 思考</option><option value="kimi_low" ${selected(model?.thinkingAdapter, 'kimi_low')}>Kimi reasoning low</option><option value="minimax_split" ${selected(model?.thinkingAdapter, 'minimax_split')}>MiniMax reasoning split</option></select></label>
    <label class="field full"><span>能力标签</span><input name="capabilities" value="${escapeHtml(capabilities.join(', '))}" placeholder="例如 instruction_following, structured_output"><small>逗号分隔，由你的业务自行定义；逻辑模型会按标签筛选候选模型。</small></label>
    <label class="field"><span>模型级最大并发</span><input name="maxInflight" type="number" min="1" value="${model?.maxInflight || 4}" required></label>
    <label class="field"><span>Token 倍率</span><input name="maxTokensMultiplier" type="number" min="1" max="100" step="0.1" value="${model?.maxTokensMultiplier || 1}" required></label>
    <label class="field"><span>预估初始延迟（ms）</span><input name="initialLatencyMs" type="number" min="1" value="${model?.initialLatencyMs || 1500}" required></label>
    <label class="field"><span>首包超时（ms）</span><input name="firstByteTimeoutMs" type="number" min="1" value="${model?.firstByteTimeoutMs || 120000}" required></label>
    <label class="field"><span>整次请求超时（ms）</span><input name="totalTimeoutMs" type="number" min="1" value="${model?.totalTimeoutMs || 600000}" required></label>
    <label class="check-field"><input name="standaloneOnly" type="checkbox" ${model?.standaloneOnly ? 'checked' : ''}>仅允许单独调用，不加入逻辑模型</label>
    <div class="form-actions field full"><button type="button" class="button ghost" data-action="close-modal">取消</button><button class="button primary">保存模型策略</button></div>
  </form>`;
}

function providerFields(provider, setup, realModels = [], isNew = false) {
  const cap = provider?.cap || { min: 1, initial: 1, max: 4 };
  const modelCatalog = [...new Set([
    ...(provider?.models || []),
    ...realModels.map((item) => typeof item === 'string' ? item : item.name),
  ].filter(Boolean))];
  const proxyMode = proxyPolicyValue(provider?.proxy);
  return `<div class="provider-form-sections">
    ${provider?.templateProviderId ? `<input type="hidden" name="templateProviderId" value="${escapeHtml(provider.templateProviderId)}">` : ''}
    <fieldset class="form-section"><legend><span><b>连接与凭证</b></span></legend><div class="field-grid">
      <label class="field"><span>配置 ID</span><input name="id" value="${escapeHtml(provider?.id || '')}" placeholder="provider-a-key-02" pattern="[a-z0-9][a-z0-9._-]{0,63}" ${provider && !isNew ? 'readonly' : ''} required><small>用于区分本地上游配置，不会发送给上游。</small></label>
      <label class="field"><span>显示名称</span><input name="label" value="${escapeHtml(provider?.label || '')}" placeholder="My Provider" required></label>
      <label class="field full"><span>Base URL</span><input name="baseUrl" type="url" value="${escapeHtml(provider?.baseUrl || '')}" placeholder="https://api.example.com/v1" required><small>不要填写 <code>/chat/completions</code> 或 <code>/messages</code>。</small></label>
      <label class="field"><span>上游协议</span><select name="apiFormat"><option value="openai" ${selected(provider?.apiFormat, 'openai')}>OpenAI Chat Completions</option><option value="anthropic" ${selected(provider?.apiFormat, 'anthropic')}>Anthropic Messages</option></select></label>
      <label class="field"><span>鉴权头</span><select name="auth"><option value="bearer" ${selected(provider?.auth, 'bearer')}>Authorization: Bearer</option><option value="x-api-key" ${selected(provider?.auth, 'x-api-key')}>x-api-key</option></select></label>
      <label class="field full"><span>API Key（只写）</span><div class="secret-state">${provider?.credential?.configured ? badge(`已配置 · ${provider.credential.source === 'process' ? '进程环境' : '本地文件'}`, 'ok') : badge('尚未配置', 'warn')}${provider?.credential?.writable === false ? '<span class="small muted">进程环境优先，控制台无法覆盖</span>' : ''}</div><input name="apiKey" type="password" autocomplete="new-password" placeholder="${provider?.credential?.configured ? '留空表示保持现有 Key' : '粘贴上游 API Key'}" ${provider?.credential?.writable === false ? 'disabled' : ''}></label>
    </div></fieldset>
    <fieldset class="form-section"><legend><span><b>模型与请求</b></span></legend><div class="field-grid">
      ${modelPickerField({ name: 'models', values: provider?.models || [], catalog: modelCatalog, label: '模型列表', discover: true })}
      <label class="field full"><span>User-Agent</span><input name="userAgent" value="${escapeHtml(provider?.userAgent || '')}" placeholder="留空：原样透传下游 User-Agent"><small>只有明确填写才覆盖；适配器必须使用固定 UA 时会由协议层显式处理。</small></label>
      <label class="field"><span>逻辑模型</span><input name="logicalModel" value="${setup ? 'balanced' : ''}" placeholder="可选，例如 balanced"><small>填写后会把 OpenAI 格式模型加入该逻辑入口；仅支持 Anthropic 的上游不会加入。</small></label>
      <label class="field"><span>思考适配</span><select name="thinkingAdapter"><option value="none" ${selected(provider?.thinkingAdapter, 'none')}>不改写</option><option value="glm_disabled" ${selected(provider?.thinkingAdapter, 'glm_disabled')}>关闭 GLM 思考</option><option value="deepseek_disabled" ${selected(provider?.thinkingAdapter, 'deepseek_disabled')}>关闭 DeepSeek 思考</option><option value="longcat_disabled" ${selected(provider?.thinkingAdapter, 'longcat_disabled')}>关闭 LongCat 思考</option><option value="kimi_low" ${selected(provider?.thinkingAdapter, 'kimi_low')}>Kimi low</option><option value="minimax_split" ${selected(provider?.thinkingAdapter, 'minimax_split')}>MiniMax reasoning split</option></select></label>
    </div></fieldset>
    <fieldset class="form-section compact-section"><legend><span><b>流控与出口</b></span></legend>
      <details class="advanced"><summary>并发、RPM、代理与启停</summary><div class="field-grid">
        <label class="field"><span>最小并发</span><input name="capMin" type="number" min="1" value="${cap.min || 1}"></label>
        <label class="field"><span>初始并发</span><input name="capInitial" type="number" min="1" value="${cap.initial || 1}"></label>
        <label class="field"><span>最大并发</span><input name="capMax" type="number" min="1" value="${cap.max || 4}"></label>
        <label class="field"><span>每分钟请求数（RPM）</span><input name="requestsPerMinute" type="number" min="1" value="${provider?.rateLimit?.requestsPerMinute || ''}" placeholder="留空表示不限制"></label>
        <label class="field"><span>限流方式</span><select name="rateLimitMode"><option value="paced" ${selected(provider?.rateLimit?.mode, 'paced')}>均匀节流</option><option value="fixed-window" ${selected(provider?.rateLimit?.mode, 'fixed-window')}>固定窗口</option></select></label>
        <label class="field"><span>模型级最大并发</span><input name="modelMaxInflight" type="number" min="1" value="${provider?.modelMaxInflight || 4}"></label>
        <label class="field"><span>出口策略</span><select name="proxyMode"><option value="direct" ${selected(proxyMode, 'direct')}>直连</option><option value="shared" ${selected(proxyMode, 'shared')}>共享 HTTP 代理</option><option value="sticky-auto" ${selected(proxyMode, 'sticky-auto')}>自动粘性节点</option><option value="sticky" ${selected(proxyMode, 'sticky')}>固定节点 ID</option><option value="fixed-http" ${selected(proxyMode, 'fixed-http')}>该 Key 独立 HTTP 代理</option></select><small>${provider?.fixedProxy?.writable === false ? '固定代理由进程环境提供，控制台不能替换地址。' : '订阅和节点在“出口”页面配置。'}</small></label>
        <label class="field" data-proxy-node-field><span>固定节点 ID</span><input name="proxyNode" value="${escapeHtml(provider?.proxy?.node || '')}" placeholder="例如 8f3a…"><small>节点失效后保持绑定并冷却，不自动换 IP。</small></label>
        <label class="field" data-fixed-proxy-field><span>独立 HTTP(S) 代理（只写）</span><input name="fixedProxyUrl" type="password" autocomplete="new-password" placeholder="${provider?.fixedProxy?.configured ? '留空保持现有代理' : 'http://127.0.0.1:7890'}" ${provider?.fixedProxy?.writable === false ? 'disabled' : ''}><small>切换到其他出口策略会清除本地文件中的独立代理。</small></label>
        <label class="check-field"><input name="enabled" type="checkbox" ${provider?.enabled === false ? '' : 'checked'}>保存后启用</label>
      </div></details>
    </fieldset>
  </div>`;
}

function modelPickerField({
  name,
  values = [],
  catalog = [],
  label,
  discover = false,
  ordered = false,
}) {
  const selectedValues = JSON.stringify(values);
  const catalogValues = JSON.stringify([...new Set([...catalog, ...values].filter(Boolean))]);
  return `<div class="field full model-picker-field"><span>${escapeHtml(label)}</span>
    <div class="model-picker" data-model-picker data-picker-name="${escapeHtml(name)}" data-values="${escapeHtml(selectedValues)}" data-catalog="${escapeHtml(catalogValues)}" data-ordered="${ordered ? 'true' : 'false'}">
      <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(selectedValues)}">
      <div class="model-picker-toolbar">
        <input data-model-search autocomplete="off" placeholder="搜索或输入完整模型 ID">
        <button type="button" class="button secondary" data-picker-action="add">添加当前 ID</button>
        ${discover ? '<button type="button" class="button ghost" data-action="discover-models">从上游发现</button>' : ''}
      </div>
      <div class="model-picker-columns">
        <div><div class="model-picker-caption"><span>已选择</span><b data-model-count class="mono">已选 0</b></div><div class="model-selected" data-model-selected></div></div>
        <div><div class="model-picker-caption"><span>候选目录</span><small>点击添加</small></div><div class="model-suggestions" data-model-suggestions></div></div>
      </div>
      <details class="model-bulk"><summary>批量粘贴或导入 <code>/models</code> JSON</summary><textarea data-model-bulk placeholder="每行一个模型，或粘贴 { &quot;data&quot;: [{ &quot;id&quot;: &quot;…&quot; }] }"></textarea><button type="button" class="button secondary" data-picker-action="import">解析并加入</button></details>
      <small class="model-picker-status" data-model-status>未知模型 ID 也允许保存；名称按大小写不敏感去重，但保留首次输入的原始拼写。</small>
    </div>
  </div>`;
}

function egressSourceCard(title, source = {}, detail) {
  const configured = source?.configured === true;
  return `<article class="panel egress-source-card"><span class="square-lamp ${configured ? 'ok' : 'idle'}"></span><div><h3>${escapeHtml(title)}</h3><small>${escapeHtml(detail)}</small></div>${badge(configured ? `已配置 · ${settingSourceName(source.source)}` : '未配置', configured ? 'ok' : 'warn')}</article>`;
}

function secretSettingHint(source = {}) {
  if (source.fallback) return '当前使用 HTTPS_PROXY/https_proxy 兼容回退；可填写专用地址覆盖。清除专用值不会关闭进程环境回退。';
  if (source.writable === false) return '当前由进程环境提供，控制台只能查看状态，不能覆盖。';
  return source.configured ? '本地已配置。留空保持原值，完整内容不再展示。' : '当前未配置。保存后写入权限为 0600 的本地文件。';
}

function egressBindingTable(providers, keys) {
  if (!providers.length) return '<div class="empty-state compact"><p>先添加上游，再选择出口策略。</p></div>';
  return `<div class="table-wrap"><table><thead><tr><th>上游</th><th>策略</th><th>节点</th><th>监听</th><th>最近状态</th><th>操作</th></tr></thead><tbody>${providers.map((provider) => {
    const slots = keys.filter((key) => key.deployment === provider.id);
    const nodes = [...new Set(slots.map((key) => key.proxy_node).filter(Boolean))];
    const listeners = [...new Set(slots.map((key) => key.proxy_listener).filter(Boolean))];
    const errors = [...new Set(slots.map((key) => key.proxy_error).filter(Boolean))];
    return `<tr><td><b>${escapeHtml(provider.label)}</b><small class="row-sub mono">${escapeHtml(provider.id)}</small></td><td>${escapeHtml(proxyPolicyName(provider.proxy))}</td><td class="mono">${escapeHtml(nodes.join(', ') || '—')}</td><td class="mono">${escapeHtml(listeners.join(', ') || (proxyPolicyValue(provider.proxy) === 'direct' ? '直连' : '等待节点'))}</td><td class="state-text ${errors.length ? 'bad' : 'ok'}">${escapeHtml(errors.join(', ') || '正常')}</td><td><button class="text-action" data-action="edit-provider" data-id="${escapeHtml(provider.id)}">编辑策略</button></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function proxyPolicyName(proxy) {
  return ({
    direct: '直连',
    shared: '共享代理',
    'sticky-auto': '自动粘性',
    sticky: '固定节点',
    'fixed-http': 'Key 独立代理',
  })[proxyPolicyValue(proxy)];
}

function modelProviders(modelName, providers) {
  const identity = normalizeModelName(modelName);
  return providers.filter((provider) => (provider.models || []).some(
    (candidate) => normalizeModelName(candidate) === identity,
  )).map((provider) => provider.label || provider.id);
}

function logicalTable(logical) {
  return `<div class="table-wrap"><table><thead><tr><th>逻辑模型</th><th>资格状态</th><th class="num">已验证</th><th class="num">可派发</th><th class="num">已配置</th></tr></thead><tbody>${logical.map((item) => {
    const available = item.available || item.health === 'available';
    const state = item.health || (available ? 'available' : 'probing');
    return `<tr><td><div class="model-cell"><span class="square-lamp ${available ? 'ok' : state === 'cooldown' ? 'warn' : 'idle'}"></span><span class="mono">${escapeHtml(item.id)}</span></div></td><td class="mono state-text ${available ? 'ok' : 'idle'}">${escapeHtml(eligibilityStateName(state))}</td><td class="num">${fmt(item.qualification?.counts?.ready ?? item.ready_deployments ?? item.ready)}</td><td class="num">${fmt(item.qualification?.dispatchable_deployments ?? item.eligible_deployments ?? item.dispatchable)}</td><td class="num">${fmt(item.qualification?.configured_deployments ?? item.configured)}</td></tr>`;
  }).join('') || '<tr><td colspan="5">暂无逻辑模型状态</td></tr>'}</tbody></table></div>`;
}

function runtimeKeyTable(keys) {
  if (!keys.length) return '<div class="empty-state compact"><p>当前没有已加载的 Key 槽位。</p></div>';
  return `<div class="table-wrap"><table><thead><tr><th>槽位</th><th>上游 / Deployment</th><th>状态</th><th class="num">活动 / 容量</th><th class="num">2XX</th><th class="num">错误</th><th>模型</th></tr></thead><tbody>${keys.map((key, index) => {
    const cooling = Number(key.cooldown_remaining_ms) > 0;
    const busy = Number(key.inflight) >= Number(key.cap);
    const lamp = key.expired ? 'bad' : cooling ? 'warn' : busy ? 'idle' : 'ok';
    const state = key.expired ? '已过期' : cooling ? `冷却 ${formatCountdown(key.cooldown_remaining_ms)}` : busy ? '已满' : '就绪';
    const models = key.canonical_models || key.model_set || key.upstream_models || [];
    return `<tr><td class="mono">#${String(index + 1).padStart(3, '0')}</td><td><b>${escapeHtml(key.provider || key.vendor || 'unknown')}</b><small class="row-sub mono">${escapeHtml(key.deployment || '—')}</small></td><td><div class="model-cell"><span class="square-lamp ${lamp}"></span><span class="mono state-text ${lamp}">${escapeHtml(state)}</span></div>${key.cooldown_reason ? `<small class="row-sub">${escapeHtml(key.cooldown_reason)}</small>` : ''}</td><td class="num mono">${fmt(key.inflight)} / ${fmt(key.cap)}</td><td class="num">${fmt(key.total_2xx_today)}</td><td class="num">${fmt(keyErrors(key))}</td><td><div class="model-list-compact">${tags(models, 3)}</div></td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function diagnosticHealth(status, stats, keyCount) {
  if (status.runtime_config?.last_error) {
    return { tone: 'bad', lamp: 'bad', label: '配置异常', detail: status.runtime_config.last_error };
  }
  if (status.quota_persistence_healthy === false || status.cooldown_persistence_healthy === false) {
    return { tone: 'bad', lamp: 'bad', label: '状态持久化异常', detail: '额度或冷却状态可能在重启后丢失' };
  }
  if (keyCount > 0 && stats.hot === 0) {
    return { tone: 'bad', lamp: 'bad', label: '无可调度容量', detail: '所有 Key 槽位均已满、冷却或不可用' };
  }
  if (stats.cooling > 0) {
    return { tone: 'warn', lamp: 'warn', label: '部分降级', detail: `${fmt(stats.cooling)} 个 Key 槽位处于冷却` };
  }
  return { tone: 'ok', lamp: 'ok', label: keyCount ? '运行健康' : '等待配置', detail: keyCount ? '当前有可调度容量' : '添加上游后开始探测' };
}

function diagnosticSelect(name, label, selectedValue, options) {
  const unique = [...new Map(options.map(([value, text]) => [String(value), String(text)])).entries()];
  return `<label class="field"><span>${escapeHtml(label)}</span><select name="${escapeHtml(name)}"><option value="">全部</option>${unique.map(([value, text]) => `<option value="${escapeHtml(value)}" ${selectedValue === value ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></label>`;
}

function diagnosticKeyTable(visibleKeys, allKeys, detailLevel) {
  if (!visibleKeys.length) return '<div class="empty-state compact"><p>当前筛选范围没有 Key 槽位。</p></div>';
  return `<div class="table-wrap diagnostic-key-table"><table><thead><tr><th>Key 槽位</th><th>上游 / host</th><th>状态</th><th class="num">活动 / 容量</th><th>最近结果</th><th class="num">401 / 403 / 429 / 5XX</th></tr></thead><tbody>${visibleKeys.map((key) => {
    const index = allKeys.indexOf(key);
    const state = slotState(key);
    const host = detailLevel === 'safe' ? '已隐藏' : key.host || '未启用 host 显示';
    return `<tr><td><b class="mono">${escapeHtml(keyDisplayName(key, index, detailLevel))}</b><small class="row-sub mono">${escapeHtml(keySlotId(key, index))}</small></td><td><b>${escapeHtml(key.provider || key.vendor || key.deployment || 'unknown')}</b><small class="row-sub mono break">${escapeHtml(host)}</small></td><td><div class="model-cell"><span class="square-lamp ${state.lamp}"></span><span>${escapeHtml(state.label)}</span></div>${key.cooldown_reason ? `<small class="row-sub">${escapeHtml(key.cooldown_reason)}</small>` : ''}</td><td class="num mono">${fmt(key.inflight)} / ${fmt(key.cap)}</td><td class="mono">${escapeHtml(key.outcomes_last_32 || '—')}</td><td class="num mono">${fmt(key.total_401_today)} / ${fmt(key.total_403_today)} / ${fmt(key.total_429_today)} / ${fmt(key.total_5xx_today)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function diagnosticIssues(keys) {
  return keys.filter((key) => slotState(key).lamp !== 'ok').sort((left, right) => {
    const weight = (key) => {
      if (key.proxy_error || key.expired) return 0;
      if (Number(key.cooldown_remaining_ms) > 0) return 1;
      return 2;
    };
    return weight(left) - weight(right)
      || Number(right.cooldown_remaining_ms || 0) - Number(left.cooldown_remaining_ms || 0);
  });
}

function diagnosticIssuesTable(issues, allKeys, detailLevel) {
  if (!issues.length) {
    return '<div class="quiet-state"><span class="square-lamp ok"></span><div><b>没有需要处理的槽位</b><small>当前 Key 均可调度</small></div></div>';
  }
  const visible = issues.slice(0, 12);
  return `<div class="table-wrap embedded-table diagnostic-issue-table"><table><thead><tr><th>Key 槽位</th><th>上游</th><th>原因</th><th>恢复</th><th></th></tr></thead><tbody>${visible.map((key) => {
    const index = allKeys.indexOf(key);
    const state = slotState(key);
    const slot = keySlotId(key, index);
    const model = [...slotModels(key)][0] || '';
    const reason = key.proxy_error || key.cooldown_reason || state.label;
    const recovery = key.proxy_error ? '检查出口' : key.expired ? '更换凭证' : Number(key.cooldown_remaining_ms) > 0 ? formatCountdown(key.cooldown_remaining_ms) : '等待空闲';
    const reasonDetail = String(reason) === String(state.label)
      ? ''
      : `<small class="row-sub ellipsis" title="${escapeHtml(reason)}">${escapeHtml(reason)}</small>`;
    return `<tr><td><div class="entity-title"><span class="square-lamp ${state.lamp}"></span><b class="mono">${escapeHtml(keyDisplayName(key, index, detailLevel))}</b></div></td><td>${escapeHtml(key.deployment || key.provider || key.vendor || 'unknown')}</td><td><b>${escapeHtml(state.label)}</b>${reasonDetail}</td><td class="mono">${escapeHtml(recovery)}</td><td class="row-actions"><button class="text-action" data-action="diagnostic-focus" data-provider="${escapeHtml(key.deployment || '')}" data-model="${escapeHtml(model)}" data-slot="${escapeHtml(slot)}">定位</button></td></tr>`;
  }).join('')}</tbody></table></div>${issues.length > visible.length ? `<div class="table-footnote">另有 ${fmt(issues.length - visible.length)} 个异常槽位，可在下方逐层定位中筛选。</div>` : ''}`;
}

function diagnosticEventsTable(events, detailLevel) {
  const visible = [...events].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 100);
  if (!visible.length) return '<div class="quiet-state"><span class="square-lamp ok"></span><div><b>当前范围没有额度识别事件</b></div></div>';
  return `<div class="table-wrap"><table><thead><tr><th>时间</th><th>Key 槽位</th><th>供应商</th><th>模式</th><th>冷却</th>${detailLevel === 'debug' ? '<th>响应片段</th>' : ''}</tr></thead><tbody>${visible.map((event) => `<tr><td class="mono">${escapeHtml(formatEventTime(event.ts))}</td><td class="mono">${escapeHtml(event.key || event.slot_id || '—')}</td><td>${escapeHtml(event.vendor || '—')}</td><td class="mono">${escapeHtml(event.pattern || '—')}</td><td class="mono">${formatCountdown(Number(event.cooldown_s || 0) * 1000)}</td>${detailLevel === 'debug' ? `<td class="mono break diagnostic-snippet">${escapeHtml(event.body_snippet || '—')}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function cooldownBuckets(keys) {
  const buckets = [
    ['可调度', (key, ms) => ms <= 0 && slotState(key).lamp === 'ok'],
    ['暂不可调度', (key, ms) => ms <= 0 && slotState(key).lamp !== 'ok'],
    ['1 分钟内恢复', (_key, ms) => ms > 0 && ms <= 60_000],
    ['1–10 分钟恢复', (_key, ms) => ms > 60_000 && ms <= 600_000],
    ['10–60 分钟恢复', (_key, ms) => ms > 600_000 && ms <= 3_600_000],
    ['1 小时以上', (_key, ms) => ms > 3_600_000],
  ];
  return `<div class="bucket-list">${buckets.map(([label, match]) => {
    const count = keys.filter((key) => match(key, Number(key.cooldown_remaining_ms) || 0)).length;
    return `<div><span>${label}</span><b class="mono">${fmt(count)}</b></div>`;
  }).join('')}</div>`;
}

function retryCompact(retry = {}) {
  const failed = Number(retry.all_attempts_failed) || 0;
  const exhausted = Number(retry.pool_exhausted) || 0;
  const noRetry = Number(retry.no_retry) || 0;
  if (!failed && !exhausted && !noRetry && retryRecovered(retry) === 0) {
    return '<div class="diagnostic-retry quiet"><span class="square-lamp ok"></span><span>今天没有重试事件</span></div>';
  }
  return `<div class="diagnostic-retry"><span>今日重试</span><b>恢复 ${fmt(retryRecovered(retry))}</b><b>失败 ${fmt(failed)}</b><b>池耗尽 ${fmt(exhausted)}</b></div>`;
}

function providerFilterBar(filters, protocols, visible, total) {
  const status = filters.status || 'all';
  const protocol = filters.protocol || 'all';
  const egress = filters.egress || 'all';
  return `<div class="provider-filter-bar">
    <label class="workbench-search"><span>搜索</span><input name="providerQuery" value="${escapeHtml(filters.query || '')}" placeholder="名称、ID、地址或模型"></label>
    <label><span>状态</span><select name="providerStatus"><option value="all" ${selected(status, 'all')}>全部</option><option value="ready" ${selected(status, 'ready')}>可调度</option><option value="cooling" ${selected(status, 'cooling')}>冷却</option><option value="probing" ${selected(status, 'probing')}>探测</option><option value="missing" ${selected(status, 'missing')}>缺少凭证</option><option value="disabled" ${selected(status, 'disabled')}>已停用</option></select></label>
    <label><span>协议</span><select name="providerProtocol"><option value="all">全部</option>${protocols.map((value) => `<option value="${escapeHtml(value)}" ${selected(protocol, value)}>${escapeHtml(value)}</option>`).join('')}</select></label>
    <label><span>出口</span><select name="providerEgress"><option value="all" ${selected(egress, 'all')}>全部</option><option value="direct" ${selected(egress, 'direct')}>直连</option><option value="proxy" ${selected(egress, 'proxy')}>使用代理</option></select></label>
    <span class="provider-filter-count">显示 <b class="mono">${fmt(visible)}</b> / ${fmt(total)}</span>
    <button class="text-action" data-action="provider-filter-reset">清除</button>
  </div>`;
}

function filterProviders(providers, keys, filters = {}) {
  const query = String(filters.query || '').trim().toLowerCase();
  return providers.filter((provider) => {
    const slots = keys.filter((key) => key.deployment === provider.id);
    const summary = summarizeKeys(slots);
    const ready = providerReady(provider, keys);
    const status = !provider.enabled
      ? 'disabled'
      : !provider.credential?.configured
        ? 'missing'
        : ready
          ? 'ready'
          : summary.cooling > 0
            ? 'cooling'
            : 'probing';
    const proxy = proxyPolicyValue(provider.proxy) === 'direct' ? 'direct' : 'proxy';
    const haystack = [
      provider.id, provider.label, provider.baseUrl, provider.apiFormat,
      ...(provider.models || []), ...(provider.canonicalModels || []),
      ...Object.keys(provider.aliases || {}), ...Object.values(provider.aliases || {}),
    ].join('\n').toLowerCase();
    return (!query || haystack.includes(query))
      && (!filters.status || filters.status === 'all' || filters.status === status)
      && (!filters.protocol || filters.protocol === 'all' || filters.protocol === (provider.apiFormat || 'openai'))
      && (!filters.egress || filters.egress === 'all' || filters.egress === proxy);
  });
}

function retryRecovered(retry = {}) {
  return ['retried_1_success', 'retried_2_success', 'retried_3_success']
    .reduce((sum, key) => sum + (Number(retry?.[key]) || 0), 0);
}

function sumObject(value) {
  return Object.values(value || {}).reduce((sum, item) => sum + (Number(item) || 0), 0);
}

function keySlotId(key, index) {
  return key?.slot_id || `key-${String(index + 1).padStart(3, '0')}`;
}

function keyDisplayName(key, index, detailLevel) {
  const slot = keySlotId(key, index);
  return detailLevel === 'safe' ? slot : key?.name || slot;
}

function detailLevelName(value) {
  return ({ safe: '安全', operator: '运维', debug: '调试' })[value] || '安全';
}

function formatEventTime(value) {
  const number = Number(value);
  const date = new Date(number > 0 && number < 10_000_000_000 ? number * 1000 : value);
  return Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleString('zh-CN', { hour12: false });
}

function usageTable(rows, dimension) {
  return `<div class="table-wrap"><table><thead><tr><th>${dimensionLabel(dimension)}</th><th class="num">请求</th><th class="num">输入</th><th class="num">缓存命中</th><th class="num">输出</th><th class="num">合计</th><th>费用</th></tr></thead><tbody>${rows.map((row) => {
    const key = row.key ?? row.label ?? row.dimension ?? '—';
    return `<tr><td class="mono">${escapeHtml(key)}</td><td class="num">${fmt(row.requests)}</td><td class="num">${fmt(row.input)}</td><td class="num">${fmt(row.inputCached)}</td><td class="num">${fmt(row.output)}</td><td class="num">${fmt((row.input || 0) + (row.output || 0))}</td><td class="mono">${cost(row)}</td></tr>`;
  }).join('') || '<tr><td colspan="7">该时间段暂无数据</td></tr>'}</tbody></table></div>`;
}

function cooldownList(keys, limit = 6) {
  const cooling = (keys || [])
    .filter((key) => Number(key.cooldown_remaining_ms) > 0)
    .sort((a, b) => a.cooldown_remaining_ms - b.cooldown_remaining_ms)
    .slice(0, limit);
  if (!cooling.length) return '<div class="quiet-state"><span class="square-lamp ok"></span><div><b>当前没有冷却项</b></div></div>';
  return `<div class="cooldown-list">${cooling.map((key) => `<div class="cooldown-row"><span class="square-lamp warn"></span><div><b>${escapeHtml(key.provider || key.deployment || key.vendor || 'unknown')}</b><small>${escapeHtml(key.cooldown_reason || '临时错误')}</small></div><time class="mono">${formatCountdown(key.cooldown_remaining_ms)}</time></div>`).join('')}</div>`;
}

function trafficRows(rows) {
  if (!rows?.length) return '<div class="quiet-state"><span class="square-lamp idle"></span><div><b>今天还没有调用记录</b></div></div>';
  const visible = rows.slice(0, 8);
  const max = Math.max(...visible.map((row) => Number(row.input || 0) + Number(row.output || 0) || Number(row.requests || 0)), 1);
  return `<div class="traffic-ledger">${visible.map((row) => {
    const value = Number(row.input || 0) + Number(row.output || 0) || Number(row.requests || 0);
    return `<div class="traffic-line"><span class="mono">${escapeHtml(row.key || 'unknown')}</span><div class="traffic-rule"><i class="${barWidthClass(value, max)}"></i></div><b class="mono">${fmt(row.requests)} 次</b><small class="mono">${fmt(value)} Token</small></div>`;
  }).join('')}</div>`;
}

function usageBars(rows) {
  if (!rows?.length) return '<div class="quiet-state"><span class="square-lamp idle"></span><div><b>所选时间段暂无数据</b></div></div>';
  const visible = rows.slice(0, 10);
  const max = Math.max(...visible.map((row) => Number(row.input || 0) + Number(row.output || 0) || Number(row.requests || 0)), 1);
  return `<div class="usage-bars">${visible.map((row) => {
    const tokens = Number(row.input || 0) + Number(row.output || 0);
    const value = tokens || Number(row.requests || 0);
    return `<div class="usage-bar-row"><span class="usage-bar-label mono" title="${escapeHtml(row.key || 'unknown')}">${escapeHtml(row.key || 'unknown')}</span><div class="usage-bar-track"><i class="${barWidthClass(value, max)}"></i></div><b class="mono">${fmt(tokens)} Token</b><span class="mono">${cost(row)}</span></div>`;
  }).join('')}</div>`;
}

function barWidthClass(value, max) {
  return `bar-width-${Math.max(1, Math.min(20, Math.ceil((Number(value) || 0) / Math.max(1, Number(max) || 1) * 20)))}`;
}

function sectionTitle(label, action = '') {
  return `<div class="ledger-title"><div><h3>${escapeHtml(label)}</h3></div>${action}</div>`;
}

function summaryMetric(label, value, sub) {
  return `<div class="summary-metric"><span>${escapeHtml(label)}</span><b class="mono">${escapeHtml(value)}</b><small>${escapeHtml(sub)}</small></div>`;
}

function tokenSummaryMetric(bucket) {
  return `<div class="summary-metric token-summary"><span>Token</span><div class="token-totals"><b class="mono"><i>输入</i>${fmt(bucket.input)}</b><b class="mono"><i>输出</i>${fmt(bucket.output)}</b></div><small>其中缓存命中 ${fmt(bucket.inputCached)}</small></div>`;
}

function costSummaryMetric(label, bucket) {
  return `<div class="cost-summary-cell"><span>${escapeHtml(label)}</span>${costSummary(bucket)}</div>`;
}

function costSummary(bucket) {
  const totals = costTotals(bucket);
  const parts = costParts(bucket);
  if (!totals.length) return '<b class="mono">—</b>';
  return `<div class="currency-totals">${totals.map((total) => `<b class="mono"><i>${total.currency}</i>${escapeHtml(total.text)}</b>`).join('')}</div><div class="cost-methods">${parts.map((part) => `<span class="cost-method ${part.key}"><i>${escapeHtml(part.label)}</i><b class="mono">${escapeHtml(part.text)}</b></span>`).join('')}</div>`;
}

function attentionList(providers, keys) {
  const providerMap = new Map(providers.map((provider) => [provider.id, provider]));
  const items = [];
  const missingCredentials = providers.filter((provider) => provider.enabled && !provider.credential?.configured);
  if (missingCredentials.length) {
    items.push({
      lamp: 'bad',
      title: `缺少凭证（${fmt(missingCredentials.length)} 个上游）`,
      detail: summarizeNames(missingCredentials.map((provider) => provider.label || provider.id)),
      rank: 0,
      href: '#connections',
      action: '去配置',
    });
  }
  const coolingKeys = keys.filter((key) => Number(key.cooldown_remaining_ms) > 0)
    .sort((a, b) => Number(a.cooldown_remaining_ms) - Number(b.cooldown_remaining_ms));
  if (coolingKeys.length) {
    const coolingProviders = [...new Set(coolingKeys.map((key) => providerMap.get(key.deployment)?.label || key.provider || key.deployment || key.vendor || 'unknown'))];
    items.push({
      lamp: 'warn',
      title: `Key 冷却（${fmt(coolingKeys.length)} 个）`,
      detail: `${summarizeNames(coolingProviders)} · 最早 ${formatCountdown(coolingKeys[0].cooldown_remaining_ms)} 后恢复`,
      rank: 1,
      href: '#diagnostics',
      action: '查看队列',
    });
  }
  const probing = providers.filter((provider) => provider.enabled && provider.credential?.configured && !providerReady(provider, keys));
  if (probing.length) {
    items.push({
      lamp: 'idle',
      title: `等待资格探测（${fmt(probing.length)} 个上游）`,
      detail: summarizeNames(probing.map((provider) => provider.label || provider.id)),
      rank: 2,
      href: '#diagnostics',
      action: '查看诊断',
    });
  }
  const visible = items.sort((a, b) => a.rank - b.rank);
  if (!visible.length) return '<div class="quiet-state"><span class="square-lamp ok"></span><div><b>当前没有需要处理的资源问题</b><small>上游、Key 和配置状态均正常</small></div></div>';
  return `<div class="attention-list">${visible.map((item) => `<div><span class="square-lamp ${item.lamp}"></span><div><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.detail)}</small></div><a class="text-action" href="${escapeHtml(item.href)}">${escapeHtml(item.action)}</a></div>`).join('')}</div>`;
}

function summarizeNames(names, limit = 4) {
  const visible = names.slice(0, limit);
  const overflow = names.length - visible.length;
  return `${visible.join('、')}${overflow > 0 ? ` 等 ${fmt(names.length)} 个` : ''}`;
}

function dimensionButton(value, label, active) {
  return `<button class="button secondary dimension-button ${value === active ? 'active' : ''}" data-action="usage-dimension" data-dimension="${value}">${label}</button>`;
}

function definition(label, value, classes = '') {
  return `<div class="definition ${classes}"><dt>${escapeHtml(label)}</dt><dd title="${escapeHtml(value)}">${escapeHtml(value ?? '—')}</dd></div>`;
}

function emptyProviders() {
  return '<div class="empty-state"><h3>还没有上游</h3><p>添加一个 OpenAI 或 Anthropic 兼容服务。API Key 只保存在本机，保存后仅显示掩码。</p><button class="button primary" data-action="new-provider">添加第一个上游</button></div>';
}

function periodButton(value, label, active) {
  return `<button class="${value === active ? 'active' : ''}" data-action="usage-period" data-period="${value}">${label}</button>`;
}

function dimensionLabel(value) {
  return ({ model: '模型', provider: '上游', route: '接口', vendor: '供应商', date: '日期' })[value] || value || '日期';
}

function eligibilityStateName(value) {
  return ({
    available: '可用',
    ready: '已验证',
    probing: '探测中',
    congested: '拥塞',
    cooldown: '冷却中',
    unhealthy: '验证失败',
    blocked: '已阻止',
    expired: '已过期',
    missing_credential: '缺少 API Key',
    disabled: '已停用',
    unavailable: '不可用',
  })[String(value || '').toLowerCase()] || value || '未知';
}

function settingSourceName(value) {
  return ({ process: '进程环境', file: '本地文件', 'network-env': '代理环境变量' })[value]
    || '本地';
}

function settingField(name, label, settings, placeholder) {
  return `<label class="field"><span>${escapeHtml(label)}</span><input name="${name}" value="${escapeHtml(settings[name] || '')}" placeholder="${escapeHtml(placeholder)}"></label>`;
}

function selected(actual, expected) {
  return String(actual || '') === expected ? 'selected' : '';
}
