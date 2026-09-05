const MODEL_PERSPECTIVES = new Set(['logical', 'real', 'vendor', 'provider', 'key', 'egress']);
const MODEL_FOCUS_FIELDS = ['logical', 'real', 'vendor', 'provider', 'key', 'egress'];

export function parseAdminHash(hash = '') {
  const raw = String(hash).replace(/^#\/?/, '');
  const separator = raw.indexOf('?');
  const route = separator >= 0 ? raw.slice(0, separator) : raw;
  const query = separator >= 0 ? raw.slice(separator + 1) : '';
  return { route: route || 'overview', params: new URLSearchParams(query) };
}

export function readModelRouteState(hash = '') {
  const { route, params } = parseAdminHash(hash);
  const requestedPerspective = params.get('view') || 'logical';
  const focus = Object.fromEntries(MODEL_FOCUS_FIELDS.map((field) => [field, params.get(field) || '']));
  return {
    route,
    perspective: MODEL_PERSPECTIVES.has(requestedPerspective) ? requestedPerspective : 'logical',
    query: params.get('q') || '',
    focus,
  };
}

export function buildModelRouteHash({ perspective = 'logical', query = '', focus = {} } = {}) {
  const params = new URLSearchParams();
  if (perspective !== 'logical' && MODEL_PERSPECTIVES.has(perspective)) params.set('view', perspective);
  for (const field of MODEL_FOCUS_FIELDS) {
    if (focus[field]) params.set(field, focus[field]);
  }
  if (query) params.set('q', query);
  const suffix = params.toString();
  return `#models${suffix ? `?${suffix}` : ''}`;
}

