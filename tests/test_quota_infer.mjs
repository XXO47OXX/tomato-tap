// test_quota_infer.mjs — sanity tests for body-pattern-based 429 cooldown
// inference. Run: node test_quota_infer.mjs

import {
  detectQuotaSignal,
  inferLongCooldownFromBody,
  QUOTA_BODY_PATTERNS,
  quotaInferCounts,
} from '../src/providers/quota/quota_infer.mjs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else      { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
}

function mk429(body) {
  return { status: 429, headers: {}, body: Buffer.from(body, 'utf8'), networkError: null };
}

console.log('--- non-429 passthrough ---');
{
  const r200 = { status: 200, headers: {}, body: Buffer.from('{}'), networkError: null };
  const out = inferLongCooldownFromBody(r200, { vendor: 'mimo', name: 'x' });
  check('200_passthrough', out === r200);

  const r401 = { status: 401, headers: {}, body: Buffer.from('{"error":"bad"}'), networkError: null };
  const out2 = inferLongCooldownFromBody(r401, { vendor: 'mimo', name: 'x' });
  check('401_passthrough', out2 === r401);
}

console.log('\n--- already has Retry-After ---');
{
  const r = { status: 429, headers: { 'retry-after': '60' }, body: Buffer.from('{"error":"quota exhausted"}'), networkError: null };
  const out = inferLongCooldownFromBody(r, { vendor: 'mimo', name: 'mimo_api_cn_104' });
  check('already_has_retry_after_no_op', out === r);
}

console.log('\n--- mimo "quota exhausted" pattern ---');
{
  const out = inferLongCooldownFromBody(
    mk429('{"error":{"code":"429","message":"quota exhausted","type":"limitation"}}'),
    { vendor: 'mimo', name: 'mimo_api_cn_104' }
  );
  check('mimo.injected',      out.headers['retry-after'] !== undefined);
  check('mimo.is_6h',         out.headers['retry-after'] === String(6 * 3600));
  check('mimo.status_preserved', out.status === 429);
  check('mimo.body_preserved',   out.body.length > 0);
}

console.log('\n--- mimo regex tolerance ---');
{
  const variations = [
    'Quota Exhausted',                              // capitalisation
    '"quota_exhausted"',                            // underscore
    'error: Quota   Exhausted',                     // extra whitespace
  ];
  for (const v of variations) {
    const out = inferLongCooldownFromBody(mk429(`{"error":"${v}"}`), { vendor: 'mimo', name: 'k' });
    check(`mimo.tolerant_${v.slice(0, 18).replace(/\s+/g,'_')}`, out.headers['retry-after'] === String(6 * 3600));
  }
}

console.log('\n--- mimo wrong vendor → no infer ---');
{
  const out = inferLongCooldownFromBody(
    mk429('{"error":"quota exhausted"}'),
    { vendor: 'minimax', name: 'minimax_api_1' }
  );
  check('wrong_vendor_no_match', out.headers['retry-after'] === undefined);
}

console.log('\n--- opencode "Resets in 3 days" pattern ---');
{
  const body = '{"type":"error","error":{"type":"GoUsageLimitError","message":"Monthly usage limit reached. Resets in 3 days. To continue..."}}';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'relay', name: 'tomato_tap_relay_opencode' });
  check('opencode.matched', out.headers['retry-after'] !== undefined);
  check('opencode.is_3d',   out.headers['retry-after'] === String(3 * 24 * 3600));
}

console.log('\n--- opencode "Resets in 5 hours" ---');
{
  const body = '{"error":{"type":"GoUsageLimitError","message":"Resets in 5 hours"}}';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'relay', name: 'tomato_tap_relay_opencode' });
  check('opencode.is_5h', out.headers['retry-after'] === String(5 * 3600));
}

console.log('\n--- opencode "Resets in 30 minutes" (plural s) ---');
{
  const body = '{"error":{"type":"GoUsageLimitError","message":"Resets in 30 minutes"}}';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'relay', name: 'tomato_tap_relay_opencode' });
  check('opencode.is_30min', out.headers['retry-after'] === String(30 * 60));
}

console.log('\n--- opencode "Resets in 3hr 16min" and numbered relay key ---');
{
  const body = '{"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 3hr 16min."}}';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'relay', name: 'tomato_tap_relay_opencode6' });
  check('opencode.numbered_key_matched', out.headers['retry-after'] !== undefined);
  check('opencode.is_3h16m', out.headers['retry-after'] === String((3 * 3600) + (16 * 60)));
}

console.log('\n--- structured quota signals ---');
{
  const body = '{"error":{"type":"GoUsageLimitError","message":"5-hour usage limit reached. Resets in 4hr 28min."}}';
  const signal = detectQuotaSignal(
    mk429(body),
    { vendor: 'relay', name: 'tomato_tap_relay_opencode8' },
  );
  check('signal.opencode_matched', signal?.matched === true);
  check('signal.opencode_label', signal?.label === 'opencode-monthly');
  check('signal.opencode_duration', signal?.retryAfterMs === ((4 * 60 + 28) * 60 * 1000));

  const withHeader = mk429(body);
  withHeader.headers['retry-after'] = '60';
  const headerSignal = detectQuotaSignal(
    withHeader,
    { vendor: 'relay', name: 'tomato_tap_relay_opencode8' },
  );
  check('signal.header_wins', headerSignal?.retryAfterMs === 60_000);
}

console.log('\n--- Kimi reset-less 403 signal ---');
{
  const kimi403 = {
    status: 403,
    headers: {},
    body: Buffer.from(JSON.stringify({
      error: {
        type: 'access_terminated_error',
        message: 'You have reached usage limit for this billing cycle. It will be refreshed in next cycle.',
      },
    })),
    networkError: null,
  };
  const signal = detectQuotaSignal(
    kimi403,
    { vendor: 'relay', name: 'tomato_tap_relay_kimicode2' },
  );
  check('signal.kimi_matched', signal?.matched === true);
  check('signal.kimi_label', signal?.label === 'kimi-billing-cycle');
  check('signal.kimi_fallback_6h', signal?.retryAfterMs === 6 * 60 * 60 * 1000);

  const unrelated = detectQuotaSignal(
    { ...kimi403, body: Buffer.from('{"error":"forbidden"}') },
    { vendor: 'relay', name: 'tomato_tap_relay_kimicode2' },
  );
  check('signal.unrelated_403_ignored', unrelated === null);
}

console.log('\n--- Kimi refresh datetime + relative + cap ---');
{
  const mkKimi = (message) => ({
    status: 403,
    headers: {},
    body: Buffer.from(JSON.stringify({
      error: { type: 'access_terminated_error', message },
    })),
    networkError: null,
  });
  const kimiPick = { vendor: 'relay', name: 'tomato_tap_relay_kimicode_env' };

  const rel = detectQuotaSignal(
    mkKimi('Reached usage limit for this billing cycle. Quota will be refreshed in 2 hours.'),
    kimiPick,
  );
  check('signal.kimi_relative_2h', rel?.retryAfterMs === 2 * 3600 * 1000);

  const in2d = detectQuotaSignal(
    mkKimi(`Reached usage limit. Quota will be refreshed on ${new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString().slice(0, 19)}Z.`),
    kimiPick,
  );
  const drift = in2d?.retryAfterMs - 2 * 24 * 3600 * 1000;
  check('signal.kimi_datetime_2d', Number.isFinite(drift) && Math.abs(drift) < 5_000);

  const far = detectQuotaSignal(
    mkKimi('Reached usage limit. Refreshed on 2099-01-01 00:00:00.'),
    kimiPick,
  );
  check('signal.kimi_datetime_capped_32d', far?.retryAfterMs === 32 * 24 * 3600 * 1000);
}

console.log('\n--- Kimi 5-hour window 403 (reset-less, prober re-checks) ---');
{
  const fiveHour = detectQuotaSignal(
    {
      status: 403,
      headers: {},
      body: Buffer.from(JSON.stringify({
        error: { message: "You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends." },
      })),
      networkError: null,
    },
    { vendor: 'relay', name: 'tomato_tap_relay_kimicode_env' },
  );
  check('signal.kimi_5h_matched', fiveHour?.matched === true);
  check('signal.kimi_5h_label', fiveHour?.label === 'kimi-5h-window');
  check('signal.kimi_5h_no_fixed_cooldown', fiveHour?.retryAfterMs == null);
}

console.log('\n--- Kimi quota profile is independent of the credential name ---');
{
  const signal = detectQuotaSignal(
    {
      status: 403,
      headers: {},
      body: Buffer.from(JSON.stringify({ error: { message: 'Reached usage limit for this billing cycle.' } })),
      networkError: null,
    },
    { vendor: 'relay', name: 'tomato_tap_relay_custom', quotaSignalProfile: 'kimi-coding' },
  );
  check('signal.kimi_profile_matched', signal?.matched === true);
  check('signal.kimi_profile_label', signal?.label === 'kimi-billing-cycle');
}

console.log('\n--- generic quota-managed 429 signals ---');
{
  const quotaKey = {
    vendor: 'relay',
    name: 'tomato_tap_relay_stepfun4',
    quotaPolicy: { probeIntervalMs: 300000 },
  };
  const withReset = detectQuotaSignal(
    { status: 429, headers: { 'retry-after': '90' }, body: Buffer.alloc(0) },
    quotaKey,
  );
  check('signal.generic_429_reset', withReset?.retryAfterMs === 90_000);
  check('signal.generic_429_label', withReset?.label === 'generic-quota-429');

  const withoutReset = detectQuotaSignal(
    { status: 429, headers: {}, body: Buffer.from('rate limited') },
    quotaKey,
  );
  check('signal.generic_429_unknown_reset', withoutReset?.retryAfterMs === null);

  const unmanaged = detectQuotaSignal(
    { status: 429, headers: {}, body: Buffer.alloc(0) },
    { vendor: 'relay', name: 'tomato_tap_relay_plain' },
  );
  check('signal.unmanaged_bodyless_429_ignored', unmanaged === null);

  const kimiShortWindow = detectQuotaSignal(
    { status: 429, headers: { 'retry-after': '30' }, body: Buffer.from('rate limited') },
    {
      vendor: 'relay',
      name: 'tomato_tap_relay_custom',
      quotaPolicy: { probeIntervalMs: 300000 },
      quotaSignalProfile: 'kimi-coding',
    },
  );
  check('signal.kimi_profile_short_429_ignored', kimiShortWindow === null);
}

console.log('\n--- opencode fallback (unparseable timing) ---');
{
  const body = '{"error":{"type":"GoUsageLimitError","message":"limit reached"}}';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'relay', name: 'tomato_tap_relay_opencode' });
  check('opencode.fallback_3d', out.headers['retry-after'] === String(3 * 24 * 3600));
}

console.log('\n--- opencode keyName matters ---');
{
  const body = '{"error":{"type":"GoUsageLimitError","message":"limit"}}';
  // wrong keyName for opencode pattern → no infer
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'relay', name: 'tomato_tap_relay_8216' });
  check('opencode.wrong_key_no_match', out.headers['retry-after'] === undefined);
}

console.log('\n--- codex resets_in_seconds ---');
{
  const body = '{"error":{"type":"usage_limit_reached","resets_in_seconds":3871}}';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'chatgpt_codex', name: 'chatgpt_codex_xxx' });
  check('codex.matched', out.headers['retry-after'] !== undefined);
  check('codex.is_3871', out.headers['retry-after'] === String(3871));
}

console.log('\n--- codex cap at 7d ---');
{
  // 30 days in seconds — should be capped to 7d
  const body = '{"error":{"resets_in_seconds":2592000}}';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'chatgpt_codex', name: 'k' });
  check('codex.cap_7d', out.headers['retry-after'] === String(7 * 24 * 3600));
}

console.log('\n--- codex fallback when body unparseable ---');
{
  const body = 'this body has resets_in_seconds in the text but is not JSON';
  const out = inferLongCooldownFromBody(mk429(body), { vendor: 'chatgpt_codex', name: 'k' });
  check('codex.fallback_1h', out.headers['retry-after'] === String(3600));
}

console.log('\n--- empty body 429 → no infer ---');
{
  const r = { status: 429, headers: {}, body: Buffer.alloc(0), networkError: null };
  const out = inferLongCooldownFromBody(r, { vendor: 'mimo', name: 'k' });
  check('empty_body_no_infer', out.headers['retry-after'] === undefined);
}

console.log('\n--- quotaInferCounts incremented ---');
{
  check('counts.mimo_present',     typeof quotaInferCounts['mimo-daily-quota'] === 'number');
  check('counts.opencode_present', typeof quotaInferCounts['opencode-monthly'] === 'number');
  check('counts.codex_present',    typeof quotaInferCounts['codex-resets-in-seconds'] === 'number');
}

console.log(`\n=== summary: ${pass} passed, ${fail} failed ===`);
process.exit(fail === 0 ? 0 : 1);
