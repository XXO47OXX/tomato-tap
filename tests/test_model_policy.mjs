import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { loadModelPolicy, resolveLogicalRequest, realModelPolicy } from '../src/routing/model-policy.mjs';

let sequence = 0;

function withPolicy(raw, fn) {
  const path = `/tmp/tomato-model-policy-${process.pid}-${sequence++}.json`;
  writeFileSync(path, JSON.stringify(raw));
  try {
    return fn(path);
  } finally {
    unlinkSync(path);
  }
}

function basePolicy() {
  return {
    schemaVersion: 1,
    realModels: {
      'strong-a': {
        qualityTier: 'strong',
        capabilities: ['strict_json', 'domain_context'],
        thinkingAdapter: 'none',
        maxInflight: 3,
        initialLatencyMs: 1000,
        firstByteTimeoutMs: 2000,
        totalTimeoutMs: 5000,
      },
    },
    taskSubtypes: {
      classification: {
        requiredCapabilities: ['strict_json', 'domain_context'],
        qualityTier: 'strong',
        candidates: ['strong-a'],
        maxAttempts: 3,
        deadlineMs: 4000,
        sessionAffinity: true,
        allowWeakFallback: false,
      },
    },
    logicalModels: {
      classifier: {
        candidates: ['strong-a'],
        requiredCapabilities: ['strict_json'],
        allowedTaskSubtypes: ['classification'],
        maxInflight: 4,
        maxAttempts: 8,
        deadlineMs: 90000,
      },
    },
  };
}

withPolicy(basePolicy(), (path) => {
  const policy = loadModelPolicy({ path });
  assert.equal(realModelPolicy(policy, 'STRONG-A').name, 'strong-a');
  const request = resolveLogicalRequest(policy, 'CLASSIFIER', 'classification');
  assert.deepEqual(request.candidates, ['strong-a']);
  assert.deepEqual(request.requiredCapabilities, ['strict_json', 'domain_context']);
  assert.equal(request.maxAttempts, 3);
  assert.equal(request.deadlineMs, 4000);
  assert.equal(request.maxInflight, 4);
  assert.equal(request.sessionAffinity, true);
  assert.equal(request.allowWeakFallback, false);
  assert.equal(request.candidateStrategy, 'fair');
  assert.equal(realModelPolicy(policy, 'strong-a').maxTokensMultiplier, 1);
  assert.equal(resolveLogicalRequest(policy, 'unconfigured-model', ''), null);
  assert.equal(resolveLogicalRequest(policy, 'classifier-fast', ''), null);
});

withPolicy(basePolicy(), (path) => {
  const raw = basePolicy();
  raw.logicalModels.classifier.allowWeakFallback = false;
  writeFileSync(path, JSON.stringify(raw));
  const request = resolveLogicalRequest(loadModelPolicy({ path }), 'classifier');
  assert.equal(request.allowWeakFallback, false);
});

withPolicy(basePolicy(), (path) => {
  const raw = basePolicy();
  raw.logicalModels.classifier.candidateStrategy = 'adaptive';
  writeFileSync(path, JSON.stringify(raw));
  const policy = loadModelPolicy({ path });
  assert.equal(resolveLogicalRequest(policy, 'classifier', 'classification').candidateStrategy, 'adaptive');

  raw.taskSubtypes.classification.candidateStrategy = 'ordered';
  writeFileSync(path, JSON.stringify(raw));
  const subtypeOverride = loadModelPolicy({ path });
  assert.equal(resolveLogicalRequest(subtypeOverride, 'classifier', 'classification').candidateStrategy, 'ordered');
});

withPolicy(basePolicy(), (path) => {
  const raw = basePolicy();
  raw.logicalModels.classifier.request = {
    temperature: 0,
    stream: false,
    maxOutputTokens: 1000,
  };
  raw.taskSubtypes.classification.request = {
    reasoningEffort: 'low',
    maxOutputTokens: 500,
  };
  raw.logicalModels.classifier.sessionAffinity = true;
  raw.logicalModels.classifier.allowWeakFallback = false;
  raw.logicalModels.classifier.protected = true;
  raw.logicalModels.classifier.minReadySlots = 2;
  raw.logicalModels.classifier.preferDifferentFromPrevious = true;
  delete raw.taskSubtypes.classification.sessionAffinity;
  delete raw.taskSubtypes.classification.allowWeakFallback;
  writeFileSync(path, JSON.stringify(raw));

  const request = resolveLogicalRequest(loadModelPolicy({ path }), 'classifier', 'classification');
  assert.deepEqual({ ...request.requestPolicy }, {
    reasoningEffort: 'low',
    temperature: 0,
    stream: false,
    maxOutputTokens: 500,
    maxInputTokens: null,
  });
  assert.equal(request.sessionAffinity, true);
  assert.equal(request.allowWeakFallback, false);
  assert.equal(request.protected, true);
  assert.equal(request.minReadySlots, 2);
  assert.equal(request.preferDifferentFromPrevious, true);
});

withPolicy(basePolicy(), (path) => {
  const raw = basePolicy();
  raw.logicalModels.classifier.sessionAffinity = true;
  raw.taskSubtypes.classification.sessionAffinity = false;
  writeFileSync(path, JSON.stringify(raw));
  assert.equal(
    resolveLogicalRequest(loadModelPolicy({ path }), 'classifier', 'classification').sessionAffinity,
    false,
  );
});

const invalidCases = [
  ['unknown candidate', (p) => { p.logicalModels.classifier.candidates = ['missing']; }, /unknown candidate/i],
  ['candidate capability mismatch', (p) => {
    p.logicalModels.classifier.requiredCapabilities = ['domain_context'];
    p.realModels['strong-a'].capabilities = ['strict_json'];
  }, /lacks required capabilities/i],
  ['standalone-only candidate', (p) => {
    p.realModels['strong-a'].standaloneOnly = true;
  }, /standalone-only/i],
  ['invalid capability syntax', (p) => {
    p.realModels['strong-a'].capabilities = ['bad capability'];
  }, /invalid capability/i],
  ['duplicate case-insensitive model', (p) => { p.realModels['STRONG-A'] = p.realModels['strong-a']; }, /duplicate/i],
  ['subtype not allowed', (p) => { p.logicalModels.classifier.allowedTaskSubtypes = []; }, /not allowed/i],
  ['non-positive deadline', (p) => { p.logicalModels.classifier.deadlineMs = 0; }, /positive/i],
  ['unknown candidate strategy', (p) => { p.logicalModels.classifier.candidateStrategy = 'fastest'; }, /candidateStrategy/i],
  ['unknown request policy field', (p) => { p.logicalModels.classifier.request = { typo: true }; }, /unknown field/i],
  ['invalid request reasoning', (p) => { p.logicalModels.classifier.request = { reasoningEffort: 'extreme' }; }, /reasoningEffort/i],
  ['invalid route boolean', (p) => { p.logicalModels.classifier.sessionAffinity = 'yes'; }, /sessionAffinity must be boolean/i],
  ['token multiplier below one', (p) => { p.realModels['strong-a'].maxTokensMultiplier = 0.5; }, /maxTokensMultiplier/i],
];

for (const [label, mutate, expected] of invalidCases) {
  const raw = basePolicy();
  mutate(raw);
  withPolicy(raw, (path) => {
    assert.throws(() => loadModelPolicy({ path }), expected, label);
  });
}

withPolicy(basePolicy(), (path) => {
  const policy = loadModelPolicy({ path });
  assert.throws(
    () => resolveLogicalRequest(policy, 'classifier', 'unknown_subtype'),
    /does not allow task subtype/i,
  );
});

withPolicy(basePolicy(), (path) => {
  const raw = basePolicy();
  raw.realModels['strong-a'].capabilities.push('customer_defined:vision.v2');
  writeFileSync(path, JSON.stringify(raw));
  assert.equal(
    realModelPolicy(loadModelPolicy({ path }), 'strong-a').capabilities.includes(
      'customer_defined:vision.v2',
    ),
    true,
  );
});

const starterPolicy = loadModelPolicy({
  path: new URL("../config/models.json", import.meta.url).pathname,
});
const starterRoute = resolveLogicalRequest(starterPolicy, "balanced", "");
const starterModel = realModelPolicy(starterPolicy, "example-model");
assert(starterRoute, "starter logical model must load");
assert.deepEqual(starterRoute.candidates, ["example-model"]);
assert.deepEqual(starterRoute.requiredCapabilities, ["instruction_following"]);
assert.equal(starterRoute.maxInflight, 4);
assert.equal(starterModel.qualityTier, "standard");
assert.deepEqual(starterModel.capabilities, ["instruction_following"]);
assert.equal(starterModel.thinkingAdapter, "none");

console.log("All model-policy tests passed.");
