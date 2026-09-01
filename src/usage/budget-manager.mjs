import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import { parseInteger } from '../config/config-values.mjs';

// Public provider defaults. Private deployments may prepend additional rules
// through TOMATO_TAP_MODEL_CREDIT_MULTIPLIERS.
const DEFAULT_MODEL_MULTIPLIERS = Object.freeze([
  Object.freeze({ match: 'mimo-v2.5-pro', multiplier: 2 }),
  Object.freeze({ match: 'mimo-v2.5', multiplier: 1 }),
  Object.freeze({ match: 'mimo-v2-pro', multiplier: 2 }),
  Object.freeze({ match: 'mimo-v2-omni', multiplier: 1 }),
  Object.freeze({ match: 'mimo-v2', multiplier: 1 }),
]);

export function createBudgetManager({
  path,
  env = process.env,
  parseRequest,
  isWeekendAtUtcOffset,
  onDailyReset = () => {},
  logger = console,
} = {}) {
  if (!path) throw new Error('budget-manager: path is required');
  if (typeof parseRequest !== 'function') {
    throw new Error('budget-manager: parseRequest is required');
  }
  if (typeof isWeekendAtUtcOffset !== 'function') {
    throw new Error('budget-manager: isWeekendAtUtcOffset is required');
  }

  const settings = readSettings(env);
  const budget = loadBudget(path, settings.totalBudget, logger);
  const vendorSpendToday = {};
  replaceObject(
    vendorSpendToday,
    budget.vendor_spend_today && typeof budget.vendor_spend_today === 'object'
      ? budget.vendor_spend_today
      : { _date: utcDate(Date.now()) },
  );
  budget.vendor_spend_today = vendorSpendToday;

  let resetDate = utcDate(Date.now());
  const resetTimer = setInterval(() => {
    const now = Date.now();
    const date = utcDate(now);
    if (date === resetDate) return;
    logger.log?.(`[budget] daily reset (used=${budget.used}, date=${resetDate} -> ${date})`);
    resetState(date);
    onDailyReset(now);
    resetDate = date;
  }, 60_000);
  resetTimer.unref?.();

  function resetState(date) {
    replaceObject(vendorSpendToday, { _date: date });
    budget.used = 0;
    budget.by_model = {};
    budget.vendor_spend_today = vendorSpendToday;
    saveBudget();
  }

  function saveBudget() {
    const temporary = `${path}.tmp`;
    writeFileSync(
      temporary,
      JSON.stringify({ ...budget, updated_at: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
    renameSync(temporary, path);
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
  }

  function inWindow(now = new Date()) {
    const hour = now.getUTCHours();
    return hour >= settings.windowStartUtcHour && hour < settings.windowEndUtcHour;
  }

  function resetDailyVendorSpend(nowTs) {
    const date = utcDate(nowTs);
    if (vendorSpendToday._date === date) return;
    replaceObject(vendorSpendToday, { _date: date });
    budget.vendor_spend_today = vendorSpendToday;
    saveBudget();
  }

  function checkVendorConstraints(vendor, vendorConfig) {
    const constraints = vendorConfig?.constraints;
    if (!constraints) return null;

    if (constraints.disabledInPeak && constraints.peakHoursUTC
        && !isVendorOffPeakWeekend(vendorConfig)) {
      const hour = new Date().getUTCHours();
      for (const [start, end] of constraints.peakHoursUTC) {
        if (hour >= start && hour < end) {
          return `vendor "${vendor}" disabled during peak hours (UTC ${start}:00-${end}:00)`;
        }
      }
    }

    if (constraints.dailyCnyCap > 0) {
      const spend = currentVendorSpend(vendor);
      const used = Number(spend.cny || 0) + Number(spend.reservedCny || 0);
      if (used >= constraints.dailyCnyCap) {
        const resetHours = 24 - new Date().getUTCHours();
        return `vendor "${vendor}" daily CNY budget exhausted (${used.toFixed(6)}/${constraints.dailyCnyCap}, resets in ~${resetHours}h)`;
      }
    }
    return null;
  }

  function recordVendorSpend(vendor, credits) {
    if (!credits || credits <= 0) return;
    const previous = currentVendorSpend(vendor);
    vendorSpendToday[vendor] = {
      ...previous,
      credits: Number(previous.credits || 0) + credits,
    };
  }

  function recordVendorCnySpend(vendor, cny) {
    if (!cny || cny <= 0) return;
    const previous = currentVendorSpend(vendor);
    vendorSpendToday[vendor] = {
      ...previous,
      cny: Number(previous.cny || 0) + cny,
    };
  }

  function reserveVendorCny(vendor, cny) {
    if (!cny || cny <= 0) return;
    const previous = currentVendorSpend(vendor);
    vendorSpendToday[vendor] = {
      ...previous,
      reservedCny: Number(previous.reservedCny || 0) + cny,
    };
  }

  function releaseVendorCny(vendor, cny) {
    if (!cny || cny <= 0) return;
    const previous = currentVendorSpend(vendor);
    vendorSpendToday[vendor] = {
      ...previous,
      reservedCny: Math.max(0, Number(previous.reservedCny || 0) - cny),
    };
  }

  function estimateVendorCny(vendorConfig, model, usage, now = new Date()) {
    const price = priceForModel(vendorConfig?.pricing, model);
    if (!price) return 0;
    const peakMultiplier = isVendorPeakPeriod(vendorConfig, now)
      ? Number(vendorConfig?.pricing?.peakMultiplier || 1)
      : 1;
    const cached = Math.max(0, Number(usage.inputCached || 0));
    const miss = Math.max(
      0,
      Number(usage.inputMiss ?? Math.max(0, usage.input - cached)) || 0,
    );
    const output = Math.max(0, Number(usage.output || 0));
    return peakMultiplier * (
      (cached / 1_000_000) * price.inputCached
      + (miss / 1_000_000) * price.inputMiss
      + (output / 1_000_000) * price.output
    );
  }

  function extractRequestedModel(requestBuffer) {
    return parseRequest(requestBuffer)?.model || null;
  }

  function estimateRequestReserveCny(vendorConfig, model, requestBuffer) {
    if (!vendorConfig?.pricing || !vendorConfig?.constraints?.dailyCnyCap) return 0;
    if (!priceForModel(vendorConfig.pricing, model)) return 0;
    const reserve = vendorConfig.pricing.requestReserve || {};
    const inputMiss = reserve.inputTokenEstimate === 'utf8_bytes' ? requestBuffer.length : 0;
    const body = parseRequest(requestBuffer);
    const requestedOutput = Number(
      body?.max_tokens ?? body?.max_completion_tokens ?? reserve.defaultOutputTokens ?? 0,
    );
    const output = Number.isFinite(requestedOutput) && requestedOutput > 0 ? requestedOutput : 0;
    return estimateVendorCny(
      vendorConfig,
      model,
      { input: inputMiss, inputCached: 0, inputMiss, output },
    );
  }

  function checkVendorCnyReservation(vendor, vendorConfig, reserveCny) {
    const cap = Number(vendorConfig?.constraints?.dailyCnyCap || 0);
    if (!cap || !reserveCny) return null;
    const spend = currentVendorSpend(vendor);
    const current = Number(spend.cny || 0) + Number(spend.reservedCny || 0);
    if (current + reserveCny > cap) {
      return `vendor "${vendor}" daily CNY budget would exceed cap (${current.toFixed(6)} + reserve ${reserveCny.toFixed(6)} > ${cap})`;
    }
    return null;
  }

  function checkVendorPricingCoverage(vendor, vendorConfig, model) {
    const cap = Number(vendorConfig?.constraints?.dailyCnyCap || 0);
    if (!cap) return null;
    if (!vendorConfig?.pricing) {
      return `vendor "${vendor}" has a CNY cap but no pricing config`;
    }
    if (!priceForModel(vendorConfig.pricing, model)) {
      return `vendor "${vendor}" model "${model || '(missing)'}" has no CNY pricing config`;
    }
    return null;
  }

  function currentVendorSpend(vendor) {
    return vendorSpendToday[vendor] && typeof vendorSpendToday[vendor] === 'object'
      ? vendorSpendToday[vendor]
      : {};
  }

  function isVendorOffPeakWeekend(vendorConfig, now = new Date()) {
    return vendorConfig?.pricing?.offPeakWeekends === true
      && isWeekendAtUtcOffset(now, vendorConfig.pricing.billingUtcOffsetMinutes);
  }

  function isVendorPeakPeriod(vendorConfig, now = new Date()) {
    return !isVendorOffPeakWeekend(vendorConfig, now)
      && isPeakHourUtc(now, vendorConfig?.constraints?.peakHoursUTC);
  }

  return Object.freeze({
    budget,
    vendorSpendToday,
    settings,
    modelMultiplier: (model) => modelMultiplier(model, [
      ...settings.modelCreditMultipliers,
      ...DEFAULT_MODEL_MULTIPLIERS,
    ]),
    saveBudget,
    inWindow,
    resetDailyVendorSpend,
    checkVendorConstraints,
    recordVendorSpend,
    recordVendorCnySpend,
    reserveVendorCny,
    releaseVendorCny,
    estimateVendorCny,
    extractRequestedModel,
    estimateRequestReserveCny,
    checkVendorCnyReservation,
    checkVendorPricingCoverage,
    isVendorPeakPeriod,
    close: () => clearInterval(resetTimer),
  });
}

function readSettings(env) {
  const totalBudget = parseInteger(
    env.TOMATO_TAP_DAILY_CREDIT_BUDGET,
    'TOMATO_TAP_DAILY_CREDIT_BUDGET',
    { defaultValue: Number.MAX_SAFE_INTEGER, min: 1 },
  );
  const windowStartUtcHour = parseInteger(
    env.TOMATO_TAP_WINDOW_START_UTC_HOUR,
    'TOMATO_TAP_WINDOW_START_UTC_HOUR',
    { defaultValue: 0, min: 0, max: 23 },
  );
  const windowEndUtcHour = parseInteger(
    env.TOMATO_TAP_WINDOW_END_UTC_HOUR,
    'TOMATO_TAP_WINDOW_END_UTC_HOUR',
    { defaultValue: 24, min: 1, max: 24 },
  );
  if (windowStartUtcHour >= windowEndUtcHour) {
    throw new Error('TOMATO_TAP_WINDOW_START_UTC_HOUR must be lower than TOMATO_TAP_WINDOW_END_UTC_HOUR');
  }
  const offPeakMultiplier = Number(env.TOMATO_TAP_OFFPEAK_MULTIPLIER || 1);
  if (!Number.isFinite(offPeakMultiplier) || offPeakMultiplier <= 0) {
    throw new Error('TOMATO_TAP_OFFPEAK_MULTIPLIER must be a positive number');
  }
  return Object.freeze({
    totalBudget,
    windowStartUtcHour,
    windowEndUtcHour,
    offPeakMultiplier,
    modelCreditMultipliers: parseModelCreditMultipliers(
      env.TOMATO_TAP_MODEL_CREDIT_MULTIPLIERS,
    ),
  });
}

function loadBudget(path, totalBudget, logger) {
  const today = utcDate(Date.now());
  if (!existsSync(path)) {
    return { used: 0, total: totalBudget, by_model: {}, vendor_spend_today: { _date: today } };
  }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (utcDate(Date.parse(value.updated_at || '')) !== today) {
      logger.log?.(`[budget] daily reset (last=${value.updated_at || 'unknown'}, used=${value.used || 0} -> 0)`);
      return {
        used: 0,
        total: Number(value.total) || totalBudget,
        by_model: {},
        vendor_spend_today: { _date: today },
      };
    }
    return {
      used: Number(value.used) || 0,
      total: Number(value.total) || totalBudget,
      by_model: value.by_model && typeof value.by_model === 'object' ? value.by_model : {},
      vendor_spend_today: value.vendor_spend_today && typeof value.vendor_spend_today === 'object'
        ? value.vendor_spend_today
        : { _date: today },
    };
  } catch {
    return { used: 0, total: totalBudget, by_model: {}, vendor_spend_today: { _date: today } };
  }
}

function modelMultiplier(model, rules) {
  const normalized = String(model || '').toLowerCase();
  return rules.find(({ match }) => normalized.includes(match))?.multiplier || 1;
}

function parseModelCreditMultipliers(value) {
  if (!String(value || '').trim()) return Object.freeze([]);
  let document;
  try {
    document = JSON.parse(value);
  } catch (error) {
    throw new Error(`TOMATO_TAP_MODEL_CREDIT_MULTIPLIERS must be JSON: ${error.message}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('TOMATO_TAP_MODEL_CREDIT_MULTIPLIERS must be a JSON object');
  }
  const rules = Object.entries(document).map(([rawMatch, rawMultiplier]) => {
    const match = String(rawMatch || '').trim().toLowerCase();
    const multiplier = Number(rawMultiplier);
    if (!match || !Number.isFinite(multiplier) || multiplier <= 0) {
      throw new Error(
        'TOMATO_TAP_MODEL_CREDIT_MULTIPLIERS values must be positive numbers',
      );
    }
    return Object.freeze({ match, multiplier });
  });
  rules.sort((a, b) => b.match.length - a.match.length);
  return Object.freeze(rules);
}

function priceForModel(pricing, model) {
  if (!pricing || pricing.currency !== 'CNY' || pricing.unit !== 'million_tokens') return null;
  const normalized = String(model || '').toLowerCase();
  return pricing.models.find(({ match }) => normalized.includes(match)) || null;
}

function isPeakHourUtc(now, ranges) {
  if (!ranges) return false;
  const hour = now.getUTCHours();
  return ranges.some(([start, end]) => hour >= start && hour < end);
}

function utcDate(timestamp) {
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : '';
}

function replaceObject(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}
