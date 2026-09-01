import {
  getAdminToken,
  getBootstrap,
  getPrices,
  getRedactedExport,
  getUsage,
  discoverProviderModels,
  reloadRuntime,
  removeLogicalModel,
  removeProvider,
  saveLogicalModel,
  saveEgress,
  saveRealModel,
  saveProvider,
  saveSettings,
  setAdminToken,
  setProviderEnabled,
} from './api.js';
import {
  initializeModelPickers,
  mergePickerCatalog,
  pickerFor,
  readPickerValues,
  setPickerStatus,
} from './model-picker.js';
import { $, $$, closeDrawer, closeModal, formObject, openDrawer, openModal, toast } from './ui.js';
import {
  PAGE_META,
  connectionsView,
  diagnosticsView,
  logicalForm,
  modelsView,
  overviewView,
  providerForm,
  providerDetailView,
  realModelForm,
  settingsView,
  setupView,
  usageView,
} from './views.js';

const state = {
  data: null,
  usage: null,
  usagePeriod: 'today',
  usageDimension: 'model',
  usageRange: null,
  usageTab: 'analysis',
  prices: null,
  priceFilters: { query: '', status: 'all', currency: 'all' },
  providerFilters: { query: '', status: 'all', protocol: 'all', egress: 'all' },
  connectionsTab: 'providers',
  diagnosticFocus: { provider: '', model: '', slot: '' },
  modelRouteFocus: { logical: '', real: '', provider: '' },
  modelPerspective: 'logical',
  modelRouteQuery: '',
  loading: false,
};

window.addEventListener('hashchange', render);
window.addEventListener('tomato-admin-auth-required', showAuth);
document.addEventListener('click', handleClick);
document.addEventListener('submit', handleSubmit);
document.addEventListener('change', (event) => {
  if (event.target.name === 'apiFormat') syncProtocolFields(event.target.form);
  if (event.target.name === 'proxyMode') syncProxyFields(event.target.form);
  if (event.target.name === 'routeGraphLogical') {
    state.modelRouteFocus = { logical: event.target.value, real: '', provider: '' };
    render();
  }
  if (event.target.name === 'diagnosticProvider') {
    state.diagnosticFocus = { provider: event.target.value, model: '', slot: '' };
    render();
  }
  if (event.target.name === 'diagnosticModel') {
    state.diagnosticFocus = { ...state.diagnosticFocus, model: event.target.value, slot: '' };
    render();
  }
  if (event.target.name === 'diagnosticSlot') {
    state.diagnosticFocus = { ...state.diagnosticFocus, slot: event.target.value };
    render();
  }
  if (event.target.name === 'priceStatus') {
    state.priceFilters.status = event.target.value;
    render();
  }
  if (event.target.name === 'priceCurrency') {
    state.priceFilters.currency = event.target.value;
    render();
  }
  if (event.target.name === 'providerStatus') {
    state.providerFilters.status = event.target.value;
    render();
  }
  if (event.target.name === 'providerProtocol') {
    state.providerFilters.protocol = event.target.value;
    render();
  }
  if (event.target.name === 'providerEgress') {
    state.providerFilters.egress = event.target.value;
    render();
  }
});
document.addEventListener('input', (event) => {
  if (event.target.form?.id === 'logical-form') syncLogicalPreview(event.target.form);
  if (event.target.name === 'routeQuery') {
    state.modelRouteQuery = event.target.value;
    renderKeepingFocus('routeQuery', event.target.selectionStart);
  }
  if (event.target.name === 'priceQuery') {
    state.priceFilters.query = event.target.value;
    renderKeepingFocus('priceQuery', event.target.selectionStart);
  }
  if (event.target.name === 'providerQuery') {
    state.providerFilters.query = event.target.value;
    renderKeepingFocus('providerQuery', event.target.selectionStart);
  }
});
document.addEventListener('tomato-model-picker-change', (event) => {
  const form = event.target.closest('form');
  if (form?.id === 'logical-form') syncLogicalPreview(form);
});
$('#auth-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  setAdminToken(new FormData(event.currentTarget).get('token'));
  $('#auth-modal').close();
  await refresh(true);
});

await refresh(true);
setInterval(() => refresh(false), 10_000);

async function refresh(forceRender = false) {
  if (state.loading) return;
  state.loading = true;
  try {
    state.data = await getBootstrap();
    setConnection(true);
    if (!state.usage) state.usage = state.data.usage_today;
    const runtime = state.data.status?.runtime_config || {};
    $('#reload-state').textContent = runtime.last_error
      ? `配置错误：${runtime.last_error}`
      : runtime.pending_revision ? '等待安全切换' : '配置已应用';
    const route = currentRoute();
    if ((!state.data.configuration.configured && !location.hash) || route === 'setup') {
      if (!location.hash) location.hash = 'setup';
    }
    if (forceRender || ['overview', 'providers', 'connections', 'models', 'egress', 'runtime', 'diagnostics', 'settings', 'setup'].includes(route)) render();
  } catch (error) {
    setConnection(false);
    if (!state.data) $('#app').innerHTML = `<div class="callout danger">无法连接本地网关：${escapeText(error.message)}</div>`;
  } finally {
    state.loading = false;
  }
}

function render() {
  if (!state.data) return;
  const route = currentRoute();
  const normalizedRoute = route === 'providers' || route === 'egress'
    ? 'connections'
    : route === 'runtime' ? 'diagnostics' : route;
  if (route === 'providers') state.connectionsTab = 'providers';
  if (route === 'egress') state.connectionsTab = 'egress';
  const meta = PAGE_META[normalizedRoute] || PAGE_META.overview;
  $('#page-title').textContent = meta[0];
  $('#page-kicker').textContent = meta[1];
  $$('.main-nav a').forEach((link) => link.classList.toggle('active', link.dataset.route === normalizedRoute));
  let html;
  if (normalizedRoute === 'connections') html = connectionsView(state.data, state.connectionsTab, state.providerFilters);
  else if (normalizedRoute === 'models') html = modelsView(state.data, state.modelRouteFocus, state.modelPerspective, state.modelRouteQuery);
  else if (normalizedRoute === 'diagnostics') html = diagnosticsView(state.data, state.diagnosticFocus);
  else if (route === 'usage') html = usageView(state.usage, state.usagePeriod, state.usageDimension, {
    tab: state.usageTab,
    prices: state.prices,
    priceFilters: state.priceFilters,
  });
  else if (route === 'settings') html = settingsView(state.data);
  else if (route === 'setup') html = setupView(state.data);
  else html = overviewView(state.data);
  $('#app').innerHTML = html;
  initializeModelPickers($('#app'));
}

async function handleClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  try {
    if (action === 'new-provider') return showProvider();
    if (action === 'close-drawer') { closeDrawer(); return; }
    if (action === 'inspect-provider') {
      const provider = state.data.configuration.providers.find((item) => item.id === target.dataset.id);
      openDrawer({
        kicker: '上游详情',
        title: provider?.label || target.dataset.id,
        body: providerDetailView(state.data, target.dataset.id),
      });
      return;
    }
    if (action === 'connections-tab') {
      state.connectionsTab = target.dataset.tab === 'egress' ? 'egress' : 'providers';
      return render();
    }
    if (action === 'diagnostic-reset') {
      state.diagnosticFocus = { provider: '', model: '', slot: '' };
      return render();
    }
    if (action === 'diagnostic-focus') {
      state.diagnosticFocus = {
        provider: target.dataset.provider || '',
        model: target.dataset.model || '',
        slot: target.dataset.slot || '',
      };
      render();
      revealDiagnosticExplorer();
      return;
    }
    if (action === 'provider-filter-reset') {
      state.providerFilters = { query: '', status: 'all', protocol: 'all', egress: 'all' };
      return render();
    }
    if (action === 'edit-provider') {
      closeDrawer();
      return showProvider(state.data.configuration.providers.find((item) => item.id === target.dataset.id));
    }
    if (action === 'clone-provider') {
      closeDrawer();
      return showProvider(null, state.data.configuration.providers.find((item) => item.id === target.dataset.id));
    }
    if (action === 'toggle-provider') {
      await busy(target, () => setProviderEnabled(target.dataset.id, target.dataset.enabled === 'true'));
      toast('上游状态已保存并生效');
      return refresh(true);
    }
    if (action === 'remove-provider') {
      const confirmation = prompt(`输入 ${target.dataset.id} 确认移除。API Key 与该 Key 的独立代理也会从本地文件删除。`);
      if (confirmation !== target.dataset.id) return;
      await busy(target, () => removeProvider(target.dataset.id, confirmation));
      toast('上游已移除');
      return refresh(true);
    }
    if (action === 'new-logical') return showLogical();
    if (action === 'edit-real-model') {
      return showRealModel(state.data.configuration.realModels.find(
        (item) => item.name.toLowerCase() === target.dataset.id.toLowerCase(),
      ));
    }
    if (action === 'edit-logical') {
      return showLogical(state.data.configuration.logicalModels.find((item) => item.name === target.dataset.id));
    }
    if (action === 'remove-logical') {
      const confirmation = prompt(`输入 ${target.dataset.id} 确认移除逻辑模型。`);
      if (confirmation !== target.dataset.id) return;
      await busy(target, () => removeLogicalModel(target.dataset.id, confirmation));
      toast('逻辑模型已移除');
      return refresh(true);
    }
    if (action === 'route-filter-real') {
      const active = state.modelRouteFocus.real === target.dataset.id;
      state.modelRouteFocus = {
        logical: target.dataset.logical,
        real: active ? '' : target.dataset.id,
        provider: '',
      };
      return render();
    }
    if (action === 'route-filter-provider') {
      const active = state.modelRouteFocus.provider === target.dataset.id;
      state.modelRouteFocus = {
        logical: target.dataset.logical,
        real: target.dataset.real || '',
        provider: active ? '' : target.dataset.id,
      };
      return render();
    }
    if (action === 'route-filter-reset') {
      state.modelRouteFocus = { logical: target.dataset.logical, real: '', provider: '' };
      return render();
    }
    if (action === 'route-select-logical') {
      state.modelRouteFocus = { logical: target.dataset.id, real: '', provider: '' };
      render();
      if (target.dataset.reveal === 'chain') revealModelChain();
      return;
    }
    if (action === 'route-perspective') {
      state.modelPerspective = target.dataset.perspective || 'logical';
      return render();
    }
    if (action === 'open-setup') { location.hash = 'setup'; return; }
    if (action === 'close-modal') { closeModal(); return; }
    if (action === 'reload') {
      await busy(target, reloadRuntime);
      toast('配置已重新加载');
      return refresh(true);
    }
    if (action === 'export-config') {
      const payload = await getRedactedExport();
      const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
      const href = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = href;
      link.download = `tomato-tap-redacted-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
      return;
    }
    if (action === 'usage-period') return loadUsagePeriod(target.dataset.period);
    if (action === 'usage-tab') {
      state.usageTab = target.dataset.tab === 'prices' ? 'prices' : 'analysis';
      if (state.usageTab === 'prices' && !state.prices) state.prices = await getPrices();
      return render();
    }
    if (action === 'usage-dimension') {
      state.usageDimension = target.dataset.dimension;
      return loadUsagePeriod(state.usagePeriod);
    }
    if (action === 'copy-endpoint') {
      await copyText(`${location.origin}${target.dataset.path}`);
      toast('调用地址已复制');
      return;
    }
    if (action === 'discover-models') {
      const picker = pickerFor(target);
      const form = target.closest('form');
      const value = formObject(form);
      setPickerStatus(picker, '正在读取上游 /models…');
      const result = await busy(target, () => discoverProviderModels({
        id: value.id || '',
        baseUrl: value.baseUrl,
        apiFormat: value.apiFormat,
        auth: value.auth,
        apiKey: value.apiKey || '',
      }));
      mergePickerCatalog(picker, result.models || []);
      setPickerStatus(picker, `发现 ${result.count || result.models?.length || 0} 个模型；搜索后逐项添加`, 'ok');
      return;
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function revealModelChain() {
  requestAnimationFrame(() => {
    const chain = $('#model-route-chain');
    if (!chain) return;
    chain.scrollIntoView({ behavior: 'smooth', block: 'start' });
    chain.focus({ preventScroll: true });
    chain.classList.add('just-focused');
    window.setTimeout(() => chain.classList.remove('just-focused'), 900);
  });
}

function revealDiagnosticExplorer() {
  requestAnimationFrame(() => {
    const explorer = $('.diagnostic-explorer');
    if (!explorer) return;
    explorer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    explorer.classList.add('just-focused');
    window.setTimeout(() => explorer.classList.remove('just-focused'), 900);
  });
}

async function handleSubmit(event) {
  const form = event.target;
  if (!['provider-form', 'setup-provider-form', 'logical-form', 'real-model-form', 'egress-form', 'settings-form', 'usage-range'].includes(form.id)) return;
  event.preventDefault();
  try {
    if (form.id === 'provider-form' || form.id === 'setup-provider-form') {
      await busy(form.querySelector('[type="submit"], button:not([type])'), () => saveProvider(providerPayload(form)));
      closeModalIfOpen();
      toast('上游已保存，完整 API Key 不再展示');
      await refresh(true);
      if (form.id === 'setup-provider-form') location.hash = 'overview';
      return;
    }
    if (form.id === 'logical-form') {
      await busy(form.querySelector('[type="submit"], button:not([type])'), () => saveLogicalModel(logicalPayload(form)));
      closeModal();
      toast('逻辑模型已保存并生效');
      return refresh(true);
    }
    if (form.id === 'real-model-form') {
      await busy(form.querySelector('[type="submit"], button:not([type])'), () => saveRealModel(realModelPayload(form)));
      closeModal();
      toast('聚合模型策略已保存并生效');
      return refresh(true);
    }
    if (form.id === 'egress-form') {
      const value = formObject(form);
      const payload = {
        subscriptionUrls: value.subscriptionUrls || '',
        staticNodes: value.staticNodes || '',
        sharedProxyUrl: value.sharedProxyUrl || '',
        clearSubscriptionUrls: form.elements.clearSubscriptionUrls?.checked === true,
        clearStaticNodes: form.elements.clearStaticNodes?.checked === true,
        clearSharedProxy: form.elements.clearSharedProxy?.checked === true,
      };
      const result = await busy(
        form.querySelector('button[type="submit"], button:not([type])'),
        () => saveEgress(payload),
      );
      toast(result.restart_required
        ? '出口配置已保存；共享 HTTP 代理将在重启后生效'
        : '出口配置已保存并生效');
      return refresh(true);
    }
    if (form.id === 'settings-form') {
      await busy(form.querySelector('button'), () => saveSettings(formObject(form)));
      toast('设置已保存；重启 Tomato Tap 后生效');
      return refresh(true);
    }
    if (form.id === 'usage-range') {
      const values = formObject(form);
      state.usageRange = { from: values.from, to: values.to };
      state.usage = await getUsage(`period=custom&from=${encodeURIComponent(values.from)}&to=${encodeURIComponent(values.to)}&granularity=day&dimension=${state.usageDimension}`);
      state.usagePeriod = 'custom';
      return render();
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

function showProvider(provider = null, template = null) {
  const draft = template ? {
    ...template,
    id: '',
    templateProviderId: template.id,
    enabled: true,
    credential: { configured: false, source: 'none', writable: true },
    fixedProxy: { configured: false, source: 'none', writable: true },
    proxy: template.proxy?.mode === 'fixed-http'
      ? false
      : template.proxy?.mode === 'sticky'
        ? { mode: 'sticky-auto' }
        : template.proxy,
  } : provider;
  openModal({
    kicker: '上游配置',
    title: provider ? `编辑 ${provider.label}` : template ? `为 ${template.label} 新增 Key` : '添加上游',
    body: providerForm(draft, state.data.configuration.realModels, { isNew: Boolean(template) }),
  });
  syncProtocolFields($('#provider-form'));
  syncProxyFields($('#provider-form'));
  initializeModelPickers($('#modal-body'));
  syncLogicalPreview($('#logical-form'));
}

function showLogical(model = null) {
  openModal({
    kicker: '逻辑模型',
    title: model ? `编辑 ${model.name}` : '新建逻辑模型',
    body: logicalForm(model, state.data.configuration.realModels),
  });
  initializeModelPickers($('#modal-body'));
}

function showRealModel(model) {
  if (!model) throw new Error('找不到真实模型');
  openModal({
    kicker: '真实模型策略',
    title: `编辑 ${model.name}`,
    body: realModelForm(model),
  });
}

async function loadUsagePeriod(period) {
  state.usagePeriod = period;
  if (period === 'custom') {
    if (state.usageRange) {
      const { from, to } = state.usageRange;
      state.usage = await getUsage(`period=custom&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&granularity=day&dimension=${state.usageDimension}`);
    }
    render();
    return;
  }
  state.usage = period === 'today'
    ? state.data.usage_today
    : await getUsage(`period=${period}&granularity=day&dimension=${state.usageDimension}`);
  render();
}

function providerPayload(form) {
  const value = formObject(form);
  return {
    id: value.id,
    templateProviderId: value.templateProviderId || '',
    label: value.label,
    baseUrl: value.baseUrl,
    apiFormat: value.apiFormat,
    auth: value.auth,
    apiKey: value.apiKey || '',
    models: readPickerValues(form, 'models'),
    userAgent: value.userAgent || '',
    logicalModel: value.logicalModel || '',
    thinkingAdapter: value.thinkingAdapter || 'none',
    capabilities: ['instruction_following'],
    logicalCapabilities: ['instruction_following'],
    cap: { min: value.capMin, initial: value.capInitial, max: value.capMax },
    requestsPerMinute: value.requestsPerMinute || null,
    rateLimitMode: value.rateLimitMode,
    modelMaxInflight: value.modelMaxInflight,
    proxy: proxyPayload(value.proxyMode, value.proxyNode),
    fixedProxyUrl: value.fixedProxyUrl || '',
    enabled: form.elements.enabled?.checked !== false,
  };
}

function logicalPayload(form) {
  const value = formObject(form);
  return {
    name: value.name,
    candidates: readPickerValues(form, 'candidates'),
    requiredCapabilities: csv(value.requiredCapabilities),
    qualityTier: value.qualityTier || '',
    candidateStrategy: value.candidateStrategy,
    maxInflight: value.maxInflight,
    maxAttempts: value.maxAttempts,
    deadlineMs: value.deadlineMs,
    logicalAdmissionWaitMs: value.logicalAdmissionWaitMs,
    sessionAffinity: form.elements.sessionAffinity?.checked === true,
    preferDifferentFromPrevious: form.elements.preferDifferentFromPrevious?.checked === true,
    allowWeakFallback: form.elements.allowWeakFallback?.checked !== false,
    protected: form.elements.protected?.checked === true,
    minReadySlots: value.minReadySlots || 0,
    request: {
      reasoningEffort: value.requestReasoningEffort || null,
      temperature: value.requestTemperature === '' ? null : Number(value.requestTemperature),
      stream: value.requestStream === '' ? null : value.requestStream === 'true',
      maxOutputTokens: value.requestMaxOutputTokens === ''
        ? null
        : Number(value.requestMaxOutputTokens),
      maxInputTokens: value.requestMaxInputTokens === ''
        ? null
        : Number(value.requestMaxInputTokens),
    },
  };
}

function realModelPayload(form) {
  const value = formObject(form);
  return {
    name: value.name,
    qualityTier: value.qualityTier,
    capabilities: csv(value.capabilities),
    thinkingAdapter: value.thinkingAdapter,
    maxInflight: value.maxInflight,
    maxTokensMultiplier: value.maxTokensMultiplier,
    initialLatencyMs: value.initialLatencyMs,
    firstByteTimeoutMs: value.firstByteTimeoutMs,
    totalTimeoutMs: value.totalTimeoutMs,
    standaloneOnly: form.elements.standaloneOnly?.checked === true,
  };
}

function lines(value) {
  return String(value || '').split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
}

function proxyPayload(mode, node) {
  if (mode === 'shared') return true;
  if (mode === 'sticky-auto') return { mode: 'sticky-auto' };
  if (mode === 'sticky') return { mode: 'sticky', node: String(node || '').trim() };
  if (mode === 'fixed-http') return { mode: 'fixed-http' };
  return false;
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.className = 'clipboard-field';
  document.body.append(field);
  field.select();
  document.execCommand('copy');
  field.remove();
}

async function busy(button, operation) {
  if (!button) return operation();
  const previous = button.textContent;
  button.disabled = true;
  button.textContent = '处理中…';
  try { return await operation(); }
  finally { button.disabled = false; button.textContent = previous; }
}

function currentRoute() {
  const route = location.hash.replace(/^#\/?/, '').split('?')[0];
  return PAGE_META[route] ? route : 'overview';
}

function setConnection(online) {
  $('#connection-dot').className = `status-dot ${online ? 'online' : 'offline'}`;
  $('#connection-label').textContent = online ? '本地网关在线' : '连接中断';
}

function showAuth() {
  if (!$('#auth-modal').open) $('#auth-modal').showModal();
}

function syncProtocolFields(form) {
  if (!form) return;
  const anthropic = form.elements.apiFormat?.value === 'anthropic';
  const logical = form.elements.logicalModel;
  if (logical) {
    logical.disabled = anthropic;
    if (anthropic) {
      if (logical.value) logical.dataset.previous = logical.value;
      logical.value = '';
    } else if (!logical.value && logical.dataset.previous) {
      logical.value = logical.dataset.previous;
    }
  }
  if (anthropic && form.elements.auth?.value === 'bearer') {
    form.elements.auth.value = 'x-api-key';
  }
}

function syncProxyFields(form) {
  if (!form) return;
  const field = form.querySelector('[data-proxy-node-field]');
  if (field) field.hidden = form.elements.proxyMode?.value !== 'sticky';
  const fixed = form.querySelector('[data-fixed-proxy-field]');
  if (fixed) fixed.hidden = form.elements.proxyMode?.value !== 'fixed-http';
}

function syncLogicalPreview(form) {
  if (!form) return;
  const candidates = readPickerValues(form, 'candidates');
  const strategy = form.elements.candidateStrategy?.value || 'fair';
  const separator = strategy === 'ordered' ? ' → ' : ' ⇄ ';
  const set = (selector, value) => {
    const element = form.querySelector(selector);
    if (element) element.textContent = value;
  };
  set('[data-preview-logical]', form.elements.name?.value.trim() || 'logical-model');
  set('[data-preview-candidates]', candidates.join(separator) || '选择候选模型');
  set('[data-preview-strategy]', strategy);
  const deadline = Number(form.elements.deadlineMs?.value || 0);
  set('[data-preview-deadline]', deadline >= 60_000 ? `${Math.round(deadline / 60_000)}m` : `${Math.round(deadline / 1000)}s`);
}

function closeModalIfOpen() {
  if ($('#modal').open) closeModal();
}

function renderKeepingFocus(name, position) {
  render();
  const input = document.querySelector(`[name="${name}"]`);
  if (!input) return;
  input.focus();
  if (typeof input.setSelectionRange === 'function') input.setSelectionRange(position, position);
}

function escapeText(value) {
  const element = document.createElement('span');
  element.textContent = String(value || '');
  return element.innerHTML;
}

if (getAdminToken()) setConnection(false);
