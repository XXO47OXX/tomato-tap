import { compactCost } from './cost-format.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function fmt(value) {
  return Math.round(Number(value) || 0).toLocaleString('en-US');
}

export function fmtDuration(ms) {
  ms = Math.max(0, Number(ms) || 0);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0)}h`;
}

export function cost(bucket = {}) {
  return compactCost(bucket);
}

export function badge(label, kind = '') {
  return `<span class="badge ${kind}">${escapeHtml(label)}</span>`;
}

export function tags(items, limit = 8) {
  const list = Array.isArray(items) ? items : [];
  const visible = list.slice(0, limit).map((item) => `<span class="tag">${escapeHtml(item)}</span>`);
  if (list.length > limit) visible.push(`<span class="tag">+${list.length - limit}</span>`);
  return visible.join('');
}

export function toast(message, kind = '') {
  const region = $('#toast-region');
  const element = document.createElement('div');
  element.className = `toast ${kind}`;
  element.textContent = message;
  region.append(element);
  setTimeout(() => element.remove(), 4200);
}

export function openModal({ title, kicker = '', body }) {
  $('#modal-title').textContent = title;
  $('#modal-kicker').textContent = kicker;
  $('#modal-body').innerHTML = body;
  $('#modal').showModal();
}

export function closeModal() {
  $('#modal').close();
}

export function openDrawer({ title, kicker = '', body }) {
  $('#drawer-title').textContent = title;
  $('#drawer-kicker').textContent = kicker;
  $('#drawer-body').innerHTML = body;
  const layer = $('#drawer-layer');
  layer.hidden = false;
  requestAnimationFrame(() => layer.classList.add('open'));
}

export function closeDrawer() {
  const layer = $('#drawer-layer');
  layer.classList.remove('open');
  setTimeout(() => { layer.hidden = true; }, 190);
}

export function formObject(form) {
  return Object.fromEntries(new FormData(form).entries());
}
