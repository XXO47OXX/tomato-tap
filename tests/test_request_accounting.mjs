import assert from 'node:assert/strict';
import test from 'node:test';

import { createRequestAccounting } from '../src/usage/request-accounting.mjs';

function fixture() {
  const ledger = [];
  const dashboard = [];
  const charges = [];
  const budget = { used: 0, by_model: {}, total: 10_000 };
  const vendorSpendToday = {};
  const accounting = createRequestAccounting({
    ledger: { append: (entry) => ledger.push(entry) },
    dashboard: { record: (entry) => dashboard.push(entry) },
    pricing: { snapshot: () => ({ source: 'test' }) },
    extractUsage: (body) => {
      const value = JSON.parse(Buffer.from(body || '').toString('utf8') || '{}').usage || {};
      return {
        input: Number(value.prompt_tokens) || 0,
        output: Number(value.completion_tokens) || 0,
        inputCached: Number(value.prompt_tokens_details?.cached_tokens) || 0,
        inputMiss: Math.max(
          0,
          (Number(value.prompt_tokens) || 0)
            - (Number(value.prompt_tokens_details?.cached_tokens) || 0),
        ),
      };
    },
    getVendors: () => ({ relay: {} }),
    budgetManager: {
      budget,
      vendorSpendToday,
      settings: { offPeakMultiplier: 1 },
      modelMultiplier: () => 1,
      saveBudget: () => {},
      resetDailyVendorSpend: () => {},
      recordVendorSpend: (vendor, credits) => charges.push({ vendor, credits }),
      recordVendorCnySpend: () => {},
      estimateVendorCny: (_vendor, _model, usage) => (
        usage.input + usage.output > 0 ? 0.25 : 0
      ),
      estimateRequestReserveCny: () => 0,
    },
  });
  return { accounting, ledger, dashboard, charges, budget };
}

test('invalid logical attempts preserve billable upstream usage', () => {
  const { accounting, ledger, dashboard, budget } = fixture();
  accounting.recordLogicalAttempt({
    id: 'request-1',
    requestedModel: 'balanced',
    resolvedModel: 'real-a',
    result: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        usage: {
          prompt_tokens: 12,
          completion_tokens: 3,
          prompt_tokens_details: { cached_tokens: 2 },
        },
      })),
    },
    keyPick: { vendor: 'relay', deploymentId: 'relay-a' },
    attempt: 1,
    requestBody: Buffer.from('{}'),
    routePrefix: '/oa/v1',
    failureClass: 'empty_content',
  });

  assert.equal(ledger.length, 1);
  assert.equal(dashboard.length, 1);
  assert.equal(ledger[0].event, 'logical_attempt');
  assert.equal(ledger[0].id, 'request-1:attempt:1');
  assert.equal(ledger[0].request_id, 'request-1');
  assert.equal(ledger[0].valid, false);
  assert.equal(ledger[0].billable, true);
  assert.equal(ledger[0].input, 12);
  assert.equal(ledger[0].input_cached, 2);
  assert.equal(ledger[0].output, 3);
  assert.equal(ledger[0].vendor_cny, 0.25);
  assert.equal(budget.used, 15);
});

test('network attempts remain auditable without fabricating a charge', () => {
  const { accounting, ledger, budget } = fixture();
  accounting.recordLogicalAttempt({
    id: 'request-2',
    requestedModel: 'balanced',
    resolvedModel: 'real-a',
    result: { status: 0, headers: {}, body: Buffer.alloc(0) },
    keyPick: { vendor: 'relay', deploymentId: 'relay-a' },
    attempt: 2,
    requestBody: Buffer.from('{}'),
    routePrefix: '/oa/v1',
    failureClass: 'network',
  });

  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].billable, false);
  assert.equal(ledger[0].usage_missing, true);
  assert.equal(ledger[0].failure_class, 'network');
  assert.equal(budget.used, 0);
});
