export function classify403Scope({ vendor, requestedModel }) {
  if (String(vendor || '').toLowerCase() === 'relay' && String(requestedModel || '').trim()) {
    return 'model';
  }
  return 'key';
}
