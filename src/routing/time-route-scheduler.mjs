// Reorder or filter qualified deployments by time window.

const DAY_NAMES = new Map([
  ['sun', 0], ['sunday', 0], ['mon', 1], ['monday', 1],
  ['tue', 2], ['tues', 2], ['tuesday', 2], ['wed', 3], ['wednesday', 3],
  ['thu', 4], ['thur', 4], ['thurs', 4], ['thursday', 4],
  ['fri', 5], ['friday', 5], ['sat', 6], ['saturday', 6],
]);

export function loadTimeRoutePolicy({ path } = {}) {
  if (!path) return defaultPolicy();
  let raw;
  try {
    raw = JSON.parse(requireRead(path));
  } catch (error) {
    if (error?.code === 'ENOENT') return defaultPolicy();
    throw new Error(`time-route-scheduler: invalid policy: ${error.message}`);
  }
  return normalizePolicy(raw);
}

export function createTimeRouteScheduler(policy = defaultPolicy()) {
  const normalized = normalizePolicy(policy);

  function snapshot(now = Date.now()) {
    const active = activeRules(now);
    return {
      enabled: normalized.enabled,
      timezone: normalized.timezone,
      strict: normalized.strict,
      active_rule_ids: active.map((rule) => rule.id),
      rule_count: normalized.rules.length,
      evaluated_at: new Date(now).toISOString(),
    };
  }

  function filterDeployments(deployments, { logicalModel = '', now = Date.now() } = {}) {
    const original = Array.isArray(deployments) ? deployments : [];
    if (!normalized.enabled) return { deployments: original, state: snapshot(now) };
    const active = activeRules(now);
    if (active.length === 0) return { deployments: original, state: snapshot(now) };

    let selected = original;
    let fallbackUsed = false;
    const forbid = active.filter((rule) => rule.action === 'forbid' && matchesScope(rule, logicalModel));
    if (forbid.length) selected = selected.filter((deployment) => !forbid.some((rule) => matchesDeployment(rule, deployment)));

    const only = active.find((rule) => rule.action === 'only' && matchesScope(rule, logicalModel));
    if (only) {
      const narrowed = selected.filter((deployment) => matchesDeployment(only, deployment));
      if (narrowed.length || normalized.strict) selected = narrowed;
      else { selected = original; fallbackUsed = true; }
    }

    const preferred = active.filter((rule) => rule.action === 'prefer' && matchesScope(rule, logicalModel));
    for (const rule of preferred) {
      const matching = selected.filter((deployment) => matchesDeployment(rule, deployment));
      const rest = selected.filter((deployment) => !matchesDeployment(rule, deployment));
      selected = [...matching, ...rest];
    }
    return {
      deployments: selected,
      state: { ...snapshot(now), fallback_used: fallbackUsed },
    };
  }

  function activeRules(now) {
    return normalized.rules
      .filter((rule) => rule.enabled && ruleMatchesTime(rule, now, normalized.timezone))
      .sort((a, b) => b.priority - a.priority || a.order - b.order);
  }

  return Object.freeze({ filterDeployments, snapshot });
}

export function normalizePolicy(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('time-route-scheduler: policy must be an object');
  const timezone = typeof raw.timezone === 'string' && raw.timezone ? raw.timezone : 'Asia/Shanghai';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw new Error(`time-route-scheduler: invalid timezone ${timezone}`); }
  const rules = Array.isArray(raw.rules) ? raw.rules.map((rule, order) => normalizeRule(rule, order)) : [];
  return Object.freeze({
    schemaVersion: Number(raw.schemaVersion || 1),
    enabled: raw.enabled === true,
    timezone,
    strict: raw.strict === true,
    rules: Object.freeze(rules),
  });
}

function normalizeRule(raw, order) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`time-route-scheduler: rule ${order} must be an object`);
  const action = ['prefer', 'only', 'forbid'].includes(raw.action) ? raw.action : 'prefer';
  const scope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  const match = raw.match && typeof raw.match === 'object' ? raw.match : {};
  return Object.freeze({
    id: String(raw.id || `rule-${order + 1}`), enabled: raw.enabled !== false,
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0, order, action,
    logicalModels: values(scope.logicalModels ?? raw.logicalModels),
    vendors: values(scope.vendors ?? raw.vendors), routes: values(scope.routes ?? raw.routes),
    relayAliases: values(scope.relayAliases ?? raw.relayAliases),
    deploymentIds: values(scope.deploymentIds ?? raw.deploymentIds),
    days: normalizeDays(match.days ?? raw.days),
    timeRanges: normalizeRanges(match.timeRanges ?? raw.timeRanges),
  });
}

function values(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item).trim().toLowerCase()).filter(Boolean);
}

function normalizeDays(value) {
  return values(value).map((item) => DAY_NAMES.has(item) ? DAY_NAMES.get(item) : Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item <= 6);
}

function normalizeRanges(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map((range) => {
    if (typeof range === 'string') { const [start, end] = range.split('-'); return { start, end }; }
    return { start: range?.start, end: range?.end };
  }).map((range) => ({ start: parseMinute(range.start), end: parseMinute(range.end) })).filter((range) => range.start != null && range.end != null);
}

function parseMinute(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute < 1440 ? minute : null;
}

function ruleMatchesTime(rule, now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const get = (type) => parts.find((part) => part.type === type)?.value;
  const day = DAY_NAMES.get(String(get('weekday')).toLowerCase());
  const minute = Number(get('hour')) * 60 + Number(get('minute'));
  if (rule.days.length && !rule.days.includes(day)) return false;
  if (!rule.timeRanges.length) return true;
  return rule.timeRanges.some((range) => range.start <= range.end
    ? minute >= range.start && minute < range.end
    : minute >= range.start || minute < range.end);
}

function matchesScope(rule, logicalModel) {
  return !rule.logicalModels.length || rule.logicalModels.includes('*') || rule.logicalModels.includes(String(logicalModel).toLowerCase());
}

function matchesDeployment(rule, deployment) {
  const match = (list, value) => !list.length || list.includes('*') || list.includes(String(value || '').toLowerCase());
  return match(rule.vendors, deployment.vendor)
    && match(rule.routes, deployment.route || deployment.pathPrefix)
    && match(rule.relayAliases, deployment.relayAlias || deployment.name)
    && match(rule.deploymentIds, deployment.deploymentId);
}

function defaultPolicy() { return { schemaVersion: 1, enabled: false, timezone: 'Asia/Shanghai', strict: false, rules: [] }; }
function requireRead(path) {
  return readFileSync(path, 'utf8');
}

import { readFileSync } from 'node:fs';
