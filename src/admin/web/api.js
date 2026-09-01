const TOKEN_KEY = 'tomato-tap-admin-token';

export function getAdminToken() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

export function setAdminToken(value) {
  const token = String(value || '');
  if (token) sessionStorage.setItem(TOKEN_KEY, token);
  else sessionStorage.removeItem(TOKEN_KEY);
}

export async function getBootstrap() {
  return request('/admin/api/bootstrap');
}

export async function getRedactedExport() {
  return request('/admin/api/export');
}

export async function saveProvider(payload) {
  return request('/admin/api/providers', { method: 'POST', body: payload });
}

export async function discoverProviderModels(payload) {
  return request('/admin/api/providers/discover-models', { method: 'POST', body: payload });
}

export async function setProviderEnabled(id, enabled) {
  return request(`/admin/api/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: { enabled },
  });
}

export async function removeProvider(id, confirm) {
  return request(`/admin/api/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE', body: { confirm, clearCredential: true },
  });
}

export async function saveLogicalModel(payload) {
  return request('/admin/api/logical-models', { method: 'POST', body: payload });
}

export async function saveRealModel(payload) {
  return request('/admin/api/real-models', { method: 'POST', body: payload });
}

export async function removeLogicalModel(name, confirm) {
  return request(`/admin/api/logical-models/${encodeURIComponent(name)}`, {
    method: 'DELETE', body: { confirm },
  });
}

export async function saveSettings(payload) {
  return request('/admin/api/settings', { method: 'PUT', body: payload });
}

export async function saveEgress(payload) {
  return request('/admin/api/egress', { method: 'PUT', body: payload });
}

export async function reloadRuntime() {
  return request('/admin/api/reload', { method: 'POST', body: {} });
}

export async function getUsage(query = '') {
  const separator = query ? '&' : '';
  return request(`/__usage?${query}${separator}format=json`, { adminHeaders: false });
}

export async function getPrices() {
  return request('/__usage?view=prices&format=json', { adminHeaders: false });
}

async function request(path, { method = 'GET', body, adminHeaders = true } = {}) {
  const headers = { accept: 'application/json' };
  const token = getAdminToken();
  if (token && adminHeaders) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    headers['x-tomato-tap-admin'] = 'console';
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await response.json(); } catch { /* handled below */ }
  if (response.status === 401 && adminHeaders) {
    window.dispatchEvent(new CustomEvent('tomato-admin-auth-required'));
  }
  if (!response.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`);
  }
  return payload;
}
