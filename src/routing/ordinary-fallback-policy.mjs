export const FALLBACK_ADMISSION_ALWAYS = 'always';
export const FALLBACK_ADMISSION_HIGHER_WEIGHT_QUOTA_CLOSED =
  'higher_weight_quota_closed';

const FALLBACK_ADMISSIONS = new Set([
  FALLBACK_ADMISSION_ALWAYS,
  FALLBACK_ADMISSION_HIGHER_WEIGHT_QUOTA_CLOSED,
]);

export function normalizeFallbackAdmission(value) {
  const normalized = String(value || FALLBACK_ADMISSION_ALWAYS).trim().toLowerCase();
  if (!FALLBACK_ADMISSIONS.has(normalized)) {
    throw new Error(`invalid fallback admission policy: ${normalized}`);
  }
  return normalized;
}

export function ordinaryCandidateAdmitted({
  candidate,
  keyPool = [],
  vendor = '',
  requestedModel = '',
  format = '',
  quotaStatus = () => ({ managed: false, state: 'open', closedKind: '' }),
} = {}) {
  if (!candidate) return false;
  const admission = normalizeFallbackAdmission(candidate.fallbackAdmission);
  if (admission === FALLBACK_ADMISSION_ALWAYS || !requestedModel) return true;

  const candidateWeight = weight(candidate);
  const higher = keyPool.filter((peer) => (
    peer !== candidate
      && (!vendor || peer.vendor === vendor)
      && supportsFormat(peer, format)
      && supportsModel(peer, requestedModel)
      && weight(peer) > candidateWeight
  ));
  if (higher.length === 0) return true;

  return higher.every((peer) => {
    const quota = quotaStatus(peer.deploymentId);
    return quota?.managed === true
      && ['closed', 'half_open'].includes(quota.state)
      && quota.closedKind === 'quota';
  });
}

function supportsFormat(candidate, format) {
  return !format || !(candidate.apiFormats instanceof Set) || candidate.apiFormats.has(format);
}

function supportsModel(candidate, requestedModel) {
  if (!(candidate.modelSet instanceof Set)) return true;
  const wanted = String(requestedModel).toLowerCase();
  return [...candidate.modelSet].some((model) => String(model).toLowerCase() === wanted);
}

function weight(candidate) {
  const value = Number(candidate?.baseWeight);
  return Number.isFinite(value) && value > 0 ? value : 1;
}
