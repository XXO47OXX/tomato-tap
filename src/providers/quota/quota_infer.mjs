// quota_infer.mjs — body-pattern-based 429 cooldown inference.
//
// When upstream returns 429 without a Retry-After header but a recognisable
// quota-exhaustion signal in the response body, this module infers a long
// cooldown so the dispatcher stops cycling through known-exhausted keys.
//
// Pattern registry is the single point of extension; adding a new vendor's
// pattern requires no other code changes.

export const VENDOR_CHATGPT_CODEX = 'chatgpt_codex';
export const VENDOR_MIMO          = 'mimo';

// Pattern fields:
//   vendor / keyName / keyNamePrefix : selector (all provided selectors must match)
//   match            : regex applied to body text
//   cooldownMs       : either fixed ms OR fn(text) → ms (parse details from body)
//   maxMs            : per-pattern cap (defends against pathological values)
//   label            : metric / log identifier
export const QUOTA_BODY_PATTERNS = [
  // Xiaomi mimo daily quota: body literal "quota exhausted". xiaomi resets at
  // Beijing midnight (UTC 16:00); 6h cooldown safely targets next reset.
  // Regex tolerant of capitalisation / surrounding whitespace.
  { vendor: VENDOR_MIMO,
    match: /\bquota[\s_]*exhausted\b/i,
    cooldownMs: () => 6 * 60 * 60 * 1000,
    maxMs: 24 * 60 * 60 * 1000,
    label: 'mimo-daily-quota' },
  // Opencode subscription: GoUsageLimitError or "<N>-hour/monthly usage limit
  // reached. Resets in N day/hour/min[ute]" — both Go (5h window) and $10/mo
  // share the same body shape, only the limit phrasing + reset unit differ.
  // Abbreviated "min" / "hr" tolerated; first-letter switch (d/h/m) avoids
  // ambiguity ("month" never appears with a number in this body).
  { keyNamePrefix: 'tomato_tap_relay_opencode',
    statusCodes: [429],
    match: /GoUsageLimitError|(\d+[-\s]*hour|monthly)[\s_]*(usage[\s_]*)?limit[\s_]*reached/i,
    cooldownMs: (text) => {
      const reset = text.match(/Resets in\s+([^."'}\]\n\r]+)/i);
      if (reset) {
        let total = 0;
        const units = reset[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/gi);
        for (const unit of units) {
          const n = Number(unit[1]);
          const u = unit[2].toLowerCase();
          if (u.startsWith('d')) total += n * 24 * 60 * 60 * 1000;
          else if (u.startsWith('h')) total += n * 60 * 60 * 1000;
          else if (u.startsWith('m')) total += n * 60 * 1000;
        }
        if (total > 0) return total;
      }
      return 3 * 24 * 60 * 60 * 1000;  // default 3 days
    },
    maxMs: 7 * 24 * 60 * 60 * 1000,
    label: 'opencode-monthly' },
  // Kimi quota errors may include an absolute or relative reset time.
  { signalProfile: 'kimi-coding', legacyKeyNamePrefix: 'tomato_tap_relay_kimicode',
    statusCodes: [403],
    match: /access_terminated_error|reached usage limit for this billing cycle/i,
    cooldownMs: (text) => parseRefreshTimeMs(text) ?? 6 * 60 * 60 * 1000,
    maxMs: 32 * 24 * 60 * 60 * 1000,
    label: 'kimi-billing-cycle' },
  // This rolling window has no reliable reset timestamp. Keep it under the
  // quota prober instead of inventing a fixed cooldown.
  { signalProfile: 'kimi-coding', legacyKeyNamePrefix: 'tomato_tap_relay_kimicode',
    statusCodes: [403],
    match: /5-hour usage limit|5-hour window/i,
    cooldownMs: () => null,
    label: 'kimi-5h-window' },
  // ChatGPT-codex Team OAuth: body has `error.resets_in_seconds`. Consolidated
  // here so all 429-cooldown inference lives in one place.
  { vendor: VENDOR_CHATGPT_CODEX,
    match: /resets_in_seconds|usage_limit_reached/i,
    cooldownMs: (text) => {
      try {
        const body = JSON.parse(text);
        const sec = body?.error?.resets_in_seconds ?? body?.resets_in_seconds;
        if (typeof sec === 'number' && sec > 0) return sec * 1000;
      } catch { /* fall through */ }
      return 60 * 60 * 1000;
    },
    maxMs: 7 * 24 * 60 * 60 * 1000,
    label: 'codex-resets-in-seconds' },
];

// Pattern hit counts are exported for the control-plane status payload.
export const quotaInferCounts = Object.create(null);

// Per-event ring buffer (newest last). Lets the dashboard show recent
// quota-infer triggers with key / vendor / cooldown / body snippet, not
// just aggregate counts. Bounded to avoid unbounded memory growth on
// proxies that run for weeks. Snippet truncated to keep payload small.
const EVENTS_MAX     = 100;
const SNIPPET_BYTES  = 120;
export const quotaInferEvents = [];

// Pure function: given a sendUpstreamBuffered-shaped `result` and the
// keyPick that produced it, return a (possibly new) result with retry-after
// injected. Idempotent: if retry-after already present, returns input.
export function inferLongCooldownFromBody(result, keyPick, knownSignal = undefined) {
  if (!result || result.status !== 429) return result;
  const headers = result.headers || {};
  if (headers['retry-after'] || headers['Retry-After']) return result;
  const signal = knownSignal === undefined ? detectQuotaSignal(result, keyPick) : knownSignal;
  if (!signal?.retryAfterMs) return result;
  return {
    ...result,
    headers: {
      ...headers,
      'retry-after': String(Math.floor(signal.retryAfterMs / 1000)),
    },
  };
}

export function detectQuotaSignal(result, keyPick) {
  if (!result) return null;
  const text = Buffer.isBuffer(result.body)
    ? result.body.toString('utf8')
    : String(result.body || '');
  for (const p of QUOTA_BODY_PATTERNS) {
    if (Array.isArray(p.statusCodes) && !p.statusCodes.includes(result.status)) continue;
    if (!p.statusCodes && result.status !== 429) continue;
    if (p.vendor && keyPick.vendor !== p.vendor) continue;
    if (p.keyName && keyPick.name !== p.keyName) continue;
    if (p.keyNamePrefix && !keyPick.name.startsWith(p.keyNamePrefix)) continue;
    if (p.signalProfile
        && keyPick.quotaSignalProfile !== p.signalProfile
        && !(p.legacyKeyNamePrefix && keyPick.name.startsWith(p.legacyKeyNamePrefix))) continue;
    if (!p.match.test(text)) continue;
    let ms = parseRetryAfterMs(result.headers);
    if (ms == null) ms = p.cooldownMs(text);
    if (ms != null && p.maxMs && ms > p.maxMs) ms = p.maxMs;
    if (ms != null && (!Number.isFinite(ms) || ms <= 0)) ms = null;
    quotaInferCounts[p.label] = (quotaInferCounts[p.label] || 0) + 1;
    quotaInferEvents.push({
      ts:           new Date().toISOString(),
      key:          keyPick.name,
      vendor:       keyPick.vendor,
      pattern:      p.label,
      cooldown_s:   ms == null ? null : Math.round(ms / 1000),
      body_snippet: redactSnippet(text),
    });
    if (quotaInferEvents.length > EVENTS_MAX) {
      quotaInferEvents.splice(0, quotaInferEvents.length - EVENTS_MAX);
    }
    const cooldown = ms == null ? 'unknown' : `${Math.round(ms / 1000)}s`;
    console.log(`[quota-infer] key=${keyPick.name} pattern=${p.label} → cooldown=${cooldown}`);
    return { matched: true, label: p.label, retryAfterMs: ms };
  }
  // Kimi Coding exposes a separate short-window rate/concurrency limit. A
  // bare 429 from this relay must not close its five-hour quota window; the
  // key-level short backoff is the correct response unless the
  // body matches the explicit billing-cycle 403 pattern above.
  if (result.status === 429 && keyPick?.quotaPolicy
      && keyPick.quotaSignalProfile !== 'kimi-coding'
      && !(keyPick.name || '').startsWith('tomato_tap_relay_kimicode')) {
    const ms = parseRetryAfterMs(result.headers);
    const label = 'generic-quota-429';
    quotaInferCounts[label] = (quotaInferCounts[label] || 0) + 1;
    quotaInferEvents.push({
      ts: new Date().toISOString(),
      key: keyPick.name,
      vendor: keyPick.vendor,
      pattern: label,
      cooldown_s: ms == null ? null : Math.round(ms / 1000),
      body_snippet: redactSnippet(text),
    });
    if (quotaInferEvents.length > EVENTS_MAX) {
      quotaInferEvents.splice(0, quotaInferEvents.length - EVENTS_MAX);
    }
    return { matched: true, label, retryAfterMs: ms };
  }
  return null;
}

// Extract a future refresh moment from quota-error prose. Handles absolute
// datetimes ("refreshed on 2026-09-01 00:00:00", "until Aug 20, 2026 08:00")
// and relative durations ("refreshed in 2 hours"). Returns ms-from-now or null.
function parseRefreshTimeMs(text) {
  const src = String(text || '');
  const keyword = /(?:refresh(?:ed)?|reset|resets|until)\b[^.!?\n]{0,80}/i.exec(src);
  const scope = keyword ? keyword[0] : src;
  const datetime = scope.match(
    /\d{4}-\d{1,2}-\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/i,
  );
  if (datetime) {
    const ts = Date.parse(datetime[0]);
    if (Number.isFinite(ts)) {
      const ms = ts - Date.now();
      if (ms > 60_000) return ms;
    }
  }
  const relative = scope.match(/\bin\s+(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\b/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    if (unit.startsWith('d')) return n * 24 * 60 * 60 * 1000;
    if (unit.startsWith('h')) return n * 60 * 60 * 1000;
    if (unit.startsWith('m')) return n * 60 * 1000;
  }
  return null;
}

function parseRetryAfterMs(headers = {}) {
  const value = headers['retry-after'] ?? headers['Retry-After'];
  if (value == null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(1, timestamp - Date.now());
}

function redactSnippet(text) {
  return text
    .slice(0, SNIPPET_BYTES)
    .replace(/\b(?:sk|ak)[-_][A-Za-z0-9+/=_-]{8,}\b/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
}
