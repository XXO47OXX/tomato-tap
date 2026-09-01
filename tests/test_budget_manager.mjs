import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';

import { createBudgetManager } from '../src/usage/budget-manager.mjs';

const path = `/tmp/tomato-tap-budget-manager-${process.pid}.json`;
const manager = createBudgetManager({
  path,
  env: {},
  parseRequest: (buffer) => JSON.parse(Buffer.from(buffer).toString('utf8')),
  isWeekendAtUtcOffset: (date) => [0, 6].includes(date.getUTCDay()),
  logger: { log: () => {} },
});

try {
  const vendor = {
    constraints: { peakHoursUTC: [[0, 24]], dailyCnyCap: 0 },
    pricing: {
      offPeakWeekends: true,
      billingUtcOffsetMinutes: 0,
      peakMultiplier: 2,
      currency: 'CNY',
      unit: 'million_tokens',
      requestReserve: { inputTokenEstimate: 'utf8_bytes', defaultOutputTokens: 10 },
      models: [{ match: 'model', inputCached: 1, inputMiss: 2, output: 3 }],
    },
  };

  assert.equal(
    manager.isVendorPeakPeriod(vendor, new Date('2026-08-31T12:00:00Z')),
    true,
  );
  assert.equal(
    manager.isVendorPeakPeriod(vendor, new Date('2026-08-30T12:00:00Z')),
    false,
  );
  assert.equal(manager.inWindow(new Date('2026-08-31T12:00:00Z')), true);
  assert.equal(manager.modelMultiplier('mimo-v2.5-pro'), 2);
  assert.equal(manager.modelMultiplier('ordinary-model'), 1);
} finally {
  manager.close();
  try { unlinkSync(path); } catch {}
  try { unlinkSync(`${path}.tmp`); } catch {}
}

const customPath = `/tmp/tomato-tap-budget-manager-custom-${process.pid}.json`;
const custom = createBudgetManager({
  path: customPath,
  env: { TOMATO_TAP_MODEL_CREDIT_MULTIPLIERS: '{"customer-premium":3}' },
  parseRequest: (buffer) => JSON.parse(Buffer.from(buffer).toString('utf8')),
  isWeekendAtUtcOffset: () => false,
  logger: { log: () => {} },
});
try {
  assert.equal(custom.modelMultiplier('customer-premium-v2'), 3);
  assert.equal(custom.modelMultiplier('mimo-v2.5-pro'), 2);
} finally {
  custom.close();
  try { unlinkSync(customPath); } catch {}
  try { unlinkSync(`${customPath}.tmp`); } catch {}
}

console.log('test_budget_manager: ok');
