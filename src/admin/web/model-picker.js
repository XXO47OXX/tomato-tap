const MAX_MODEL_NAME = 128;

export function parseModelImport(input) {
  const text = String(input || '').trim();
  if (!text) return [];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* plain text input */ }
  const raw = parsed == null ? text.split(/[\r\n,;]+/) : extractJsonModels(parsed);
  return raw.map(cleanModelName).filter(Boolean);
}

export function normalizeModelValues(values, existing = []) {
  const accepted = [];
  const duplicates = [];
  const invalid = [];
  const seen = new Set(existing.map((value) => String(value).trim().toLowerCase()));
  for (const raw of values || []) {
    const model = cleanModelName(raw);
    if (!model || model.length > MAX_MODEL_NAME || /[\u0000-\u001f\u007f]/.test(model)) {
      invalid.push(String(raw || ''));
      continue;
    }
    const identity = model.toLowerCase();
    if (seen.has(identity)) {
      duplicates.push(model);
      continue;
    }
    seen.add(identity);
    accepted.push(model);
  }
  return { accepted, duplicates, invalid };
}

export function initializeModelPickers(root = document) {
  for (const picker of root.querySelectorAll('[data-model-picker]')) {
    if (picker.dataset.mounted === 'true') continue;
    picker.dataset.mounted = 'true';
    picker._modelState = {
      values: decodeList(picker.dataset.values),
      catalog: decodeList(picker.dataset.catalog),
    };
    picker.addEventListener('click', (event) => handlePickerClick(picker, event));
    picker.querySelector('[data-model-search]')?.addEventListener('input', () => renderPicker(picker));
    picker.querySelector('[data-model-search]')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addFromSearch(picker);
    });
    renderPicker(picker);
  }
}

export function readPickerValues(form, name) {
  const field = form.querySelector(`[data-model-picker][data-picker-name="${cssEscape(name)}"] input[type="hidden"]`);
  return decodeList(field?.value);
}

export function mergePickerCatalog(picker, models, { select = false } = {}) {
  if (!picker?._modelState) return { accepted: [], duplicates: [], invalid: [] };
  const catalogReport = normalizeModelValues(models, picker._modelState.catalog);
  picker._modelState.catalog.push(...catalogReport.accepted);
  const selectionReport = select
    ? addValues(picker, models)
    : { accepted: [], duplicates: [], invalid: [] };
  renderPicker(picker);
  return { catalog: catalogReport, selection: selectionReport };
}

export function pickerFor(target) {
  return target?.closest?.('[data-model-picker]') || null;
}

export function setPickerStatus(picker, message, tone = '') {
  const field = picker?.querySelector?.('[data-model-status]');
  if (!field) return;
  field.textContent = String(message || '');
  field.dataset.tone = tone;
}

function handlePickerClick(picker, event) {
  const button = event.target.closest('[data-picker-action]');
  if (!button || !picker.contains(button)) return;
  event.preventDefault();
  const action = button.dataset.pickerAction;
  if (action === 'add') addFromSearch(picker);
  if (action === 'suggestion') addValues(picker, [button.dataset.model]);
  if (action === 'remove') removeValue(picker, button.dataset.model);
  if (action === 'up' || action === 'down') moveValue(picker, button.dataset.model, action);
  if (action === 'import') {
    const field = picker.querySelector('[data-model-bulk]');
    const report = addValues(picker, parseModelImport(field?.value));
    if (field) field.value = '';
    setPickerStatus(
      picker,
      `新增 ${report.accepted.length} · 重复 ${report.duplicates.length} · 无效 ${report.invalid.length}`,
      report.invalid.length ? 'warn' : 'ok',
    );
  }
  renderPicker(picker);
}

function addFromSearch(picker) {
  const input = picker.querySelector('[data-model-search]');
  const report = addValues(picker, [input?.value]);
  if (report.accepted.length && input) input.value = '';
  setPickerStatus(
    picker,
    report.accepted.length ? `已添加 ${report.accepted[0]}` : '该模型已存在或名称无效',
    report.accepted.length ? 'ok' : 'warn',
  );
  renderPicker(picker);
}

function addValues(picker, values) {
  const report = normalizeModelValues(values, picker._modelState.values);
  picker._modelState.values.push(...report.accepted);
  for (const value of report.accepted) {
    if (!picker._modelState.catalog.some((item) => item.toLowerCase() === value.toLowerCase())) {
      picker._modelState.catalog.push(value);
    }
  }
  return report;
}

function removeValue(picker, model) {
  const identity = String(model || '').toLowerCase();
  picker._modelState.values = picker._modelState.values.filter(
    (value) => value.toLowerCase() !== identity,
  );
}

function moveValue(picker, model, direction) {
  const index = picker._modelState.values.findIndex(
    (value) => value.toLowerCase() === String(model || '').toLowerCase(),
  );
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= picker._modelState.values.length) return;
  [picker._modelState.values[index], picker._modelState.values[target]] = [
    picker._modelState.values[target], picker._modelState.values[index],
  ];
}

function renderPicker(picker) {
  const { values, catalog } = picker._modelState;
  const hidden = picker.querySelector('input[type="hidden"]');
  if (hidden) hidden.value = JSON.stringify(values);
  const selected = picker.querySelector('[data-model-selected]');
  if (selected) {
    selected.replaceChildren(...values.map((model, index) => selectedChip(
      model,
      index,
      values.length,
      picker.dataset.ordered === 'true',
    )));
    if (!values.length) selected.append(emptyNote('尚未选择模型'));
  }
  const search = String(picker.querySelector('[data-model-search]')?.value || '').trim().toLowerCase();
  const selectedIds = new Set(values.map((value) => value.toLowerCase()));
  const suggestions = catalog.filter((model) => !selectedIds.has(model.toLowerCase()))
    .filter((model) => !search || model.toLowerCase().includes(search))
    .slice(0, 24);
  const list = picker.querySelector('[data-model-suggestions]');
  if (list) {
    list.replaceChildren(...suggestions.map(suggestionButton));
    if (!suggestions.length) list.append(emptyNote(search ? '没有匹配项，可直接添加当前 ID' : '暂无候选，可发现或批量导入'));
  }
  const count = picker.querySelector('[data-model-count]');
  if (count) count.textContent = `已选 ${values.length}`;
  picker.dispatchEvent(new CustomEvent('tomato-model-picker-change', { bubbles: true }));
}

function selectedChip(model, index, length, ordered) {
  const item = document.createElement('span');
  item.className = 'model-choice';
  const label = document.createElement('code');
  label.textContent = model;
  item.append(label);
  if (ordered) {
    item.append(smallButton('up', model, '↑', '上移', index === 0));
    item.append(smallButton('down', model, '↓', '下移', index === length - 1));
  }
  item.append(smallButton('remove', model, '×', '移除'));
  return item;
}

function smallButton(action, model, text, label, disabled = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.pickerAction = action;
  button.dataset.model = model;
  button.textContent = text;
  button.title = label;
  button.setAttribute('aria-label', `${label} ${model}`);
  button.disabled = disabled;
  return button;
}

function suggestionButton(model) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'model-suggestion';
  button.dataset.pickerAction = 'suggestion';
  button.dataset.model = model;
  const code = document.createElement('code');
  code.textContent = model;
  const mark = document.createElement('span');
  mark.textContent = '+';
  button.append(code, mark);
  return button;
}

function emptyNote(text) {
  const element = document.createElement('span');
  element.className = 'model-picker-empty';
  element.textContent = text;
  return element;
}

function extractJsonModels(payload) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return rows.map((row) => (typeof row === 'string' ? row : row?.id || row?.name || ''));
}

function cleanModelName(value) {
  let text = String(value || '').trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '').trim();
  if ((text.startsWith('`') && text.endsWith('`'))
      || (text.startsWith('"') && text.endsWith('"'))
      || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function decodeList(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return normalizeModelValues(Array.isArray(parsed) ? parsed : []).accepted;
  } catch {
    return [];
  }
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}
