import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  connectionsView,
  diagnosticsView,
  egressView,
  logicalForm,
  modelsView,
  overviewView,
  providerForm,
  providersView,
  runtimeView,
  setupView,
  usageView,
} from '../src/admin/web/views.js';

function fixture() {
  const provider = {
    id: 'provider-a',
    label: 'Provider A',
    baseUrl: 'https://api.example.test/v1',
    apiFormat: 'openai',
    auth: 'bearer',
    enabled: true,
    credential: { configured: true, source: 'file', writable: true },
    models: ['GLM-5.2', 'deepseek-v4-flash'],
    canonicalModels: ['glm-5.2', 'deepseek-v4-flash'],
    aliases: { 'glm-5.2': 'GLM-5.2' },
    userAgent: 'tomato-tap/0.1.0',
    cap: { min: 1, initial: 2, max: 4 },
    rateLimit: { requestsPerMinute: 60, mode: 'paced' },
  };
  const key = {
    name: 'sensitive-slot-label',
    deployment: 'provider-a',
    provider: 'Provider A',
    vendor: 'relay',
    inflight: 1,
    cap: 4,
    cooldown_remaining_ms: 0,
    total_2xx_today: 20,
    total_429_today: 1,
    total_5xx_today: 2,
    total_net_err_today: 1,
    canonical_models: ['glm-5.2', 'deepseek-v4-flash'],
  };
  const usage = {
    date: '2026-08-30',
    total: { requests: 20, input: 1_000, inputCached: 400, output: 300, tokenCny: 0.2 },
    byModel: [{ key: 'glm-5.2', requests: 20, input: 1_000, inputCached: 400, output: 300, tokenCny: 0.2 }],
    byProvider: [{ key: 'Provider A', requests: 20, input: 1_000, inputCached: 400, output: 300, tokenCny: 0.2 }],
    byRoute: [{ key: '/oa/v1', requests: 20, input: 1_000, inputCached: 400, output: 300, tokenCny: 0.2 }],
  };
  return {
    configuration: {
      configured: true,
      providers: [provider],
      realModels: [{
        name: 'glm-5.2',
        qualityTier: 'strong',
        capabilities: ['instruction_following'],
        thinkingAdapter: 'glm_disabled',
        maxInflight: 4,
        firstByteTimeoutMs: 120_000,
        totalTimeoutMs: 600_000,
      }],
      logicalModels: [{
        name: 'classifier',
        candidateStrategy: 'fair',
        candidates: ['glm-5.2'],
        requiredCapabilities: ['instruction_following'],
        maxInflight: 8,
        maxAttempts: 3,
        deadlineMs: 300_000,
        logicalAdmissionWaitMs: 30_000,
      }],
      settings: {},
      egress: {
        subscriptions: { configured: true, count: 2, source: 'file', writable: true },
        staticNodes: { configured: true, source: 'file', writable: true },
        sharedProxy: { configured: false, source: 'none', writable: true },
      },
      paths: {},
    },
    status: {
      key_pool: [key],
      runtime_config: { active_revision: 'revision-a', reload_count: 2 },
      access: { bind_host: '127.0.0.1' },
    },
    models: {
      logical: [{
        id: 'classifier',
        health: 'available',
        available: true,
        qualification: {
          counts: { ready: 1 },
          dispatchable_deployments: 1,
          configured_deployments: 1,
        },
      }],
    },
    usage_today: usage,
    access: { loopback_only: true },
  };
}

test('operator views render the compact workbench, provider ledger, and usage dimensions', () => {
  const data = fixture();
  assert.match(overviewView(data), /overview-summary/);
  assert.match(overviewView(data), /summary-ledger/);
  assert.match(providersView(data), /provider-table/);
  assert.doesNotMatch(providersView(data), /provider-card/);
  assert.match(modelsView(data), /relationship-workbench/);
  assert.match(modelsView(data), /miller-browser/);
  const usage = usageView(data.usage_today, 'today', 'provider');
  assert.match(usage, /Provider A/);
  assert.match(usage, /bar-width-20/);
  assert.doesNotMatch(usage, /style=/);
});

test('diagnostics expose selectable operator metadata according to server detail level', () => {
  const data = fixture();
  data.status.admin_detail_level = 'debug';
  data.status.key_pool[0].slot_id = 'key-001';
  data.status.key_pool[0].host = 'api.example.test';
  data.status.key_pool[0].outcomes_last_32 = '2xx×20 429×1';
  data.status.quota_infer_events = [{
    slot_id: 'key-001',
    key: 'sensitive-slot-label',
    vendor: 'relay',
    pattern: 'rate-limit',
    cooldown_s: 60,
    body_snippet: 'quota exceeded',
    ts: Date.now(),
  }];
  const debug = diagnosticsView(data, { provider: 'provider-a', slot: 'key-001' });
  assert.match(debug, /sensitive-slot-label/);
  assert.match(debug, /api\.example\.test/);
  assert.match(debug, /quota exceeded/);

  delete data.status.key_pool[0].name;
  delete data.status.key_pool[0].host;
  delete data.status.quota_infer_events[0].key;
  delete data.status.quota_infer_events[0].body_snippet;
  data.status.admin_detail_level = 'safe';
  const safe = diagnosticsView(data);
  assert.match(safe, /key-001/);
  assert.doesNotMatch(safe, /sensitive-slot-label|api\.example\.test|quota exceeded/);
});

test('connections combine upstream and egress management without duplicating navigation pages', () => {
  const data = fixture();
  assert.match(connectionsView(data, 'providers'), /上游与 Key/);
  assert.match(connectionsView(data, 'providers'), /Provider A/);
  assert.doesNotMatch(connectionsView(data, 'providers'), /连接管理|检查模型路由|每个配置 ID/);
  assert.match(connectionsView(data, 'egress'), /代理池与出口/);
  assert.match(connectionsView(data, 'egress'), /订阅源/);
});

test('connections filter a large provider ledger by query, status, protocol, and egress', () => {
  const data = fixture();
  data.configuration.providers.push({
    ...data.configuration.providers[0],
    id: 'provider-b',
    label: 'Provider B',
    apiFormat: 'anthropic',
    proxy: { mode: 'sticky-auto' },
  });
  data.status.key_pool.push({
    ...data.status.key_pool[0],
    deployment: 'provider-b',
    provider: 'Provider B',
    cooldown_remaining_ms: 60_000,
  });
  const filtered = connectionsView(data, 'providers', {
    query: 'provider b',
    status: 'cooling',
    protocol: 'anthropic',
    egress: 'proxy',
  });
  assert.match(filtered, /provider-filter-bar/);
  assert.match(filtered, /显示 <b class="mono">1<\/b> \/ 2/);
  assert.match(filtered, /Provider B/);
  assert.doesNotMatch(filtered, />Provider A</);
});

test('diagnostic capacity separates dispatchable, cooling, and non-cooling unavailable slots', () => {
  const data = fixture();
  data.status.key_pool.push({
    ...data.status.key_pool[0],
    name: 'expired-slot',
    slot_id: 'key-002',
    expired: true,
    inflight: 0,
  });
  const html = diagnosticsView(data);
  assert.match(html, /当前异常/);
  assert.match(html, /暂不可调度/);
  assert.match(html, /更换凭证/);
  assert.match(html, /可调度<\/span><b class="mono">1<\/b>/);
});

test('model relationship workbench traces logical model to an anonymous key', () => {
  const data = fixture();
  const html = modelsView(data, {
    logical: 'classifier',
    real: 'glm-5.2',
    provider: 'provider-a',
  });
  assert.match(html, /关联链路/);
  assert.match(html, /任务逻辑模型/);
  assert.match(html, /聚合模型/);
  assert.match(html, /上游 \/ 实际模型/);
  assert.match(html, /classifier/);
  assert.match(html, /glm-5\.2/);
  assert.match(html, /GLM-5\.2/);
  assert.match(html, /Provider A/);
  assert.match(html, /#001/);
  assert.match(html, /多个供应来源统一调度/);
  assert.match(html, /1\/1/);
  assert.doesNotMatch(html, /sensitive-slot-label/);
});

test('model relationship explorer narrows key slots after selecting a provider', () => {
  const data = fixture();
  data.configuration.providers.push({
    ...data.configuration.providers[0],
    id: 'provider-b',
    label: 'Provider B',
  });
  data.status.key_pool.push({
    ...data.status.key_pool[0],
    deployment: 'provider-b',
    provider: 'Provider B',
  });
  const all = modelsView(data, { logical: 'classifier', real: 'glm-5.2' });
  const focused = modelsView(data, {
    logical: 'classifier',
    real: 'glm-5.2',
    provider: 'provider-a',
  });
  assert.match(all, /#001/);
  assert.match(all, /#002/);
  assert.match(focused, /#001/);
  assert.doesNotMatch(focused, /#002/);
});

test('model workbench supports provider perspective without losing the relationship chain', () => {
  const html = modelsView(fixture(), { logical: 'classifier' }, 'provider', 'Provider A');
  assert.match(html, /data-perspective="provider"/);
  assert.match(html, /provider-table/);
  assert.match(html, /Provider A/);
  assert.match(html, /miller-browser/);
});

test('usage integrates the price catalog and keeps native currencies separate', () => {
  const data = fixture();
  data.usage_today.total.cny = 0.3;
  data.usage_today.total.estUsd = 2.4;
  data.usage_today.byModel[0].cny = 0.3;
  data.usage_today.byModel[0].estUsd = 2.4;
  const usage = usageView(data.usage_today, 'today', 'model');
  assert.match(usage, /CNY/);
  assert.match(usage, /USD/);
  assert.match(usage, /按上游/);
  assert.match(usage, /按供应商/);
  assert.doesNotMatch(usage, /原币种并列|不做汇率换算|同一行有人民币和美元时并列显示/);
  assert.doesNotMatch(usage, /¥[^<]+ \+ .*\$/);
  assert.match(usage, /id="usage-range" class="toolbar" hidden/);

  const prices = usageView(data.usage_today, 'today', 'model', {
    tab: 'prices',
    prices: {
      coverage: { configured: 2, priced: 2, unpriced: 0, catalogEntries: 10 },
      data: [
        { model: 'GLM-5.2', price: { canonicalModel: 'glm-5.2', provider: 'z-ai', currency: 'CNY', input: 1, inputCached: 0.2, output: 4, source: 'local' } },
        { model: 'glm-5.2', price: { canonicalModel: 'glm-5.2', provider: 'z-ai', currency: 'CNY', input: 1, inputCached: 0.2, output: 4, source: 'local' } },
      ],
    },
    priceFilters: { query: '', status: 'all', currency: 'all' },
  });
  assert.match(prices, /price-catalog/);
  assert.match(prices, /价格目录/);
  assert.match(prices, /GLM-5\.2/);
});

test('logical model editor exposes adaptive and layered request policy controls', () => {
  const model = {
    ...fixture().configuration.logicalModels[0],
    candidateStrategy: 'adaptive',
    request: { reasoningEffort: 'low', temperature: 0, stream: false },
  };
  const html = logicalForm(model, fixture().configuration.realModels);
  assert.match(html, /value="adaptive" selected/);
  assert.match(html, /name="requestReasoningEffort"/);
  assert.match(html, /name="requestTemperature"/);
  assert.match(html, /name="sessionAffinity"/);
  assert.match(html, /\/__route\/plan\?model=classifier/);
});

test('runtime view exposes slot state without exposing internal key labels', () => {
  const html = runtimeView(fixture());
  assert.match(html, /#001/);
  assert.match(html, /就绪/);
  assert.doesNotMatch(html, /sensitive-slot-label/);
});

test('egress view exposes policies and redacted bindings without secret inputs', () => {
  const data = fixture();
  data.configuration.providers[0].proxy = { mode: 'sticky-auto' };
  data.status.key_pool[0].proxy_mode = 'sticky-auto';
  data.status.key_pool[0].proxy_node = 'redacted-node-id';
  data.status.key_pool[0].proxy_listener = 'running';
  data.configuration.egress.sharedProxy = {
    configured: true, source: 'network-env', writable: true, fallback: true,
  };
  const html = egressView(data);
  assert.match(html, /代理池与固定出口/);
  assert.match(html, /redacted-node-id/);
  assert.match(html, /自动粘性/);
  assert.match(html, /使用 HTTPS_PROXY/);
  assert.doesNotMatch(html, /sensitive-slot-label/);
});

test('operator copy avoids decorative bilingual labels', () => {
  const data = fixture();
  const html = [
    overviewView(data),
    providersView(data),
    modelsView(data),
    egressView(data),
    runtimeView(data),
    usageView(data.usage_today),
  ].join('\n');
  assert.doesNotMatch(
    html,
    /LOCAL CONTROL PLANE|PROVIDER HEALTH|COOLDOWNS & QUEUE|MANAGE|DETAILS|MODEL SLOTS|STANDALONE ONLY|NO ACTIVE COOLDOWNS|NO TRAFFIC RECORDED TODAY/,
  );
  assert.match(html, /需要处理/);
  assert.match(html, /模型与路由|模型路由/);
  assert.match(html, /仅显示掩码|不再展示/);
});

test('operator shell uses one language for navigation and headings', () => {
  const shell = readFileSync(new URL('../src/admin/web/index.html', import.meta.url), 'utf8');
  assert.match(shell, /本地模型网关/);
  assert.match(shell, /<span>模型与路由<\/span>/);
  assert.match(shell, /<span>诊断<\/span>/);
  assert.match(shell, /<span>上游与凭据<\/span>/);
  assert.doesNotMatch(shell, /data-route="providers"|data-route="egress"|data-route="runtime"/);
  assert.doesNotMatch(
    shell,
    /MODEL CONTROL PLANE|LOCAL CONTROL PLANE|Overview<\/small>|Providers<\/small>|Runtime<\/small>/,
  );
  assert.doesNotMatch(shell, /<i aria-hidden="true">0[1-9]<\/i>/);
});

test('operator forms and summaries do not use decorative step numbers', () => {
  const data = fixture();
  const html = [
    providersView(data),
    modelsView(data),
    runtimeView(data),
    setupView(data),
    providerForm(null, data.configuration.realModels),
  ].join('\n');
  assert.doesNotMatch(html, /summary-index|<legend><i>|setup-step"><b>[123]<\/b>/);
});
