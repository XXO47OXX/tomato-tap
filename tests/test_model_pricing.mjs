import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelPricing } from '../src/usage/model-pricing.mjs';

function fixture() {
  return createModelPricing({
    catalog: {
      schemaVersion: 1,
      source: { syncedAt: '2026-08-21T00:00:00.000Z' },
      providers: {
        'x-ai': {
          'grok-4.20-non-reasoning': {
            currency: 'USD', unit: 'million_tokens', input: 2, inputCached: 0.2, output: 6,
          },
        },
        openrouter: {
          'x-ai/grok-4.20-non-reasoning': {
            currency: 'USD', unit: 'million_tokens', input: 3, inputCached: 0.3, output: 9,
          },
        },
      },
    },
    overrides: {
      schemaVersion: 1,
      aliases: { 'grok-4.20-fast': 'grok-4.20-non-reasoning', 'metered-fast': 'metered-model' },
      models: {
        'metered-model': {
          currency: 'CNY', input: 1.5, inputCached: 0.05, output: 4.5,
          peak: { input: 3, inputCached: 0.1, output: 9 },
          peakHoursUtc: [[1, 4]],
          offPeakWeekends: true,
          billingUtcOffsetMinutes: 480,
        },
      },
    },
  });
}

test('alias resolution prefers the official provider catalog entry', () => {
  const pricing = fixture();
  const price = pricing.resolve('grok-4.20-fast');
  assert.equal(price.provider, 'x-ai');
  assert.equal(price.input, 2);
  assert.equal(price.output, 6);
});

test('local peak pricing and cached-token cost are applied', () => {
  const pricing = fixture();
  const quote = pricing.estimate({
    model: 'metered-fast', input: 1_000_000, inputCached: 500_000, output: 100_000,
  }, { at: new Date('2026-08-21T02:00:00.000Z') });
  assert.equal(quote.currency, 'CNY');
  assert.equal(quote.amount, 0.5 * 3 + 0.5 * 0.1 + 0.1 * 9);
});

test('weekends in the billing timezone always use off-peak pricing', () => {
  const pricing = fixture();
  const quote = pricing.estimate({
    model: 'metered-fast', input: 1_000_000, inputCached: 500_000, output: 100_000,
  }, { at: new Date('2026-08-22T02:00:00.000Z') });
  assert.equal(quote.currency, 'CNY');
  assert.equal(quote.price.priceBand, undefined);
  assert.equal(quote.amount, 0.5 * 1.5 + 0.5 * 0.05 + 0.1 * 4.5);
});

test('historical weekend peak snapshots are corrected to off-peak pricing', () => {
  const pricing = fixture();
  const quote = pricing.estimate({
    model: 'metered-fast', input: 1_000_000, output: 100_000,
    pricing: {
      source: 'usage.log price snapshot', provider: 'local-override',
      catalog_model: 'metered-model', currency: 'CNY', unit: 'million_tokens',
      input: 3, input_cached: 0.1, output: 9, price_band: 'peak',
    },
  }, { at: new Date('2026-08-22T02:00:00.000Z') });
  assert.equal(quote.price.priceBand, undefined);
  assert.equal(quote.amount, 1.5 + 0.1 * 4.5);
});

test('stored price snapshot wins over a later catalog value', () => {
  const pricing = fixture();
  const quote = pricing.estimate({
    model: 'grok-4.20-fast', input: 1_000_000, output: 1_000_000,
    pricing: {
      source: 'usage.log price snapshot', provider: 'x-ai', catalog_model: 'old-model',
      currency: 'USD', unit: 'million_tokens', input: 1, input_cached: 0.1, output: 4,
    },
  });
  assert.equal(quote.amount, 5);
  assert.equal(quote.price.model, 'old-model');
});

test('dated override changes price exactly at its effective instant', () => {
  const pricing = createModelPricing({
    catalog: { schemaVersion: 1, source: {}, providers: {} },
    overrides: {
      schemaVersion: 1,
      models: {
        'dated-model': {
          currency: 'CNY', input: 1, output: 2,
          effectiveFrom: '2026-08-22T16:00:00.000Z',
          previous: { currency: 'CNY', input: 3, output: 4 },
        },
      },
    },
  });
  const before = pricing.resolve('dated-model', { at: new Date('2026-08-22T15:59:59.999Z') });
  const after = pricing.resolve('dated-model', { at: new Date('2026-08-22T16:00:00.000Z') });
  assert.equal(before.input, 3);
  assert.equal(before.output, 4);
  assert.equal(after.input, 1);
  assert.equal(after.output, 2);

  const corrected = pricing.estimate({
    model: 'dated-model', input: 1_000_000, output: 1_000_000,
    pricing: {
      provider: 'local-override', currency: 'CNY', unit: 'million_tokens',
      input: 3, input_cached: 3, output: 4, price_band: 'standard',
    },
  }, { at: new Date('2026-08-22T16:00:00.000Z') });
  assert.equal(corrected.amount, 3);
});

test('public provider prices load separately from private local overrides', () => {
  const publicPricing = createModelPricing();
  const publicPrice = publicPricing.resolve('kimi-for-coding');
  assert.equal(publicPrice.provider, 'provider-default');
  assert.equal(publicPrice.currency, 'CNY');
  assert.equal(publicPrice.costMode, 'accounted');

  const overridden = createModelPricing({
    overrides: {
      schemaVersion: 1,
      aliases: {},
      models: {
        'kimi-k2.7-code': {
          currency: 'CNY', input: 1, inputCached: 0.5, output: 2,
        },
      },
    },
  }).resolve('kimi-for-coding');
  assert.equal(overridden.provider, 'local-override');
  assert.equal(overridden.input, 1);
});
