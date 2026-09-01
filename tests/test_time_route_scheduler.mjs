import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeRouteScheduler } from '../src/routing/time-route-scheduler.mjs';

const deployments = [
  { deploymentId: 'a', vendor: 'alpha', name: 'alpha-1' },
  { deploymentId: 'b', vendor: 'beta', name: 'beta-1' },
  { deploymentId: 'c', vendor: 'gamma', name: 'gamma-1' },
];

const at = (iso) => Date.parse(iso);

test('disabled policy is transparent', () => {
  const scheduler = createTimeRouteScheduler({ enabled: false, rules: [] });
  assert.deepEqual(scheduler.filterDeployments(deployments, { logicalModel: 'classifier', now: at('2026-08-27T10:00:00Z') }).deployments, deployments);
});

test('prefer applies only inside the configured window', () => {
  const scheduler = createTimeRouteScheduler({
    enabled: true,
    timezone: 'UTC',
    rules: [{ id: 'beta-morning', action: 'prefer', vendors: ['beta'], timeRanges: ['09:00-12:00'] }],
  });
  assert.deepEqual(scheduler.filterDeployments(deployments, { now: at('2026-08-27T10:00:00Z') }).deployments.map((d) => d.deploymentId), ['b', 'a', 'c']);
  assert.deepEqual(scheduler.filterDeployments(deployments, { now: at('2026-08-27T13:00:00Z') }).deployments.map((d) => d.deploymentId), ['a', 'b', 'c']);
});

test('only and forbid compose, and only falls back when non-strict', () => {
  const scheduler = createTimeRouteScheduler({
    enabled: true,
    timezone: 'UTC',
    strict: false,
    rules: [
      { id: 'only-beta', action: 'only', logicalModels: ['balanced'], vendors: ['beta'] },
      { id: 'forbid-beta', action: 'forbid', vendors: ['beta'] },
    ],
  });
  // Forbid is applied before only; the empty result safely falls back.
  assert.deepEqual(scheduler.filterDeployments(deployments, { logicalModel: 'balanced', now: at('2026-08-27T10:00:00Z') }).deployments, deployments);
});

test('cross-midnight window is active on both sides of midnight', () => {
  const scheduler = createTimeRouteScheduler({
    enabled: true,
    timezone: 'UTC',
    rules: [{ id: 'night', action: 'only', vendors: ['gamma'], timeRanges: ['22:00-02:00'] }],
  });
  assert.deepEqual(scheduler.filterDeployments(deployments, { now: at('2026-08-27T23:00:00Z') }).deployments.map((d) => d.deploymentId), ['c']);
  assert.deepEqual(scheduler.filterDeployments(deployments, { now: at('2026-08-28T01:00:00Z') }).deployments.map((d) => d.deploymentId), ['c']);
});
