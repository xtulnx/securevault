// V2 workspaces reuse the storage, session and field editors in app.js.
Object.assign(state, {
  searchRequest: 0, workspaceRequest: 0, viewDensity: 'default', managedDatasetId: null,
  datasetTab: 'fields', editorMode: 'all', editorDirty: false,
  importStep: 1, importBusy: false, transferPackage: null, importPreview: null,
  exportDatasetId: null, descriptionTarget: null, detailTab: 'overview', categories: [], directoryDraft: []
});

const fieldZones = { indexes: '索引', display: '展示', normal: '普通', secrets: '敏感', hidden: '隐藏加密', ignore: '忽略' };
const workspaces = { search: 'search-workspace', datasets: 'dataset-manager-modal', dataset: 'dataset-detail-workspace', editor: 'dataset-modal', import: 'import-modal', apps: 'app-manager-modal', security: 'security-workspace' };
const legacy = {
  openDatasetEdit, openDatasetEditor, renderListConfig, renderRecords,
  openRecordDetail, closeRecordDetail, renderDetailSecrets, refreshAfterWrite,
  renderDatasetInfo: openDatasetInfo, importFile, sealVault, loadApps,
  updateDatasetDescriptionPreview
};

loadWorkspace = async function() {
  const request = ++state.workspaceRequest;
  const [datasets, tree, summary] = await Promise.all([api('/datasets'), api('/datasets/tree'), api('/vault/summary')]);
  if (!state.unlocked || request !== state.workspaceRequest) return;
  state.datasets = datasets.datasets; state.directories = tree.directories; state.summary = summary;
  await fetchRecords();
  if (!state.unlocked || request !== state.workspaceRequest) return;
  renderCategoryTree(); renderFilters(); renderIndexReference(); renderStats();
  for (const id of ['manager-new-dataset', 'manager-import', 'import-button', 'app-manager-button', 'security-settings-button']) $(`#${id}`).hidden = !state.canManage;
  await openLinkedRecord();
};

// Record links retain their target while locked, then use the normal detail
// flow after the workspace has loaded. Links never carry credentials or values.
let linkedRecordRequest = 0;
async function openLinkedRecord() {
  const hash = window.location.hash;
  if (!hash.startsWith('#record=') || !state.unlocked) return;
  const id = new URLSearchParams(hash.slice(1)).get('record');
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    showToast('记录链接无效', 'error');
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return;
  }
  const request = ++linkedRecordRequest;
  showWorkspace('search');
  if (state.workspace !== 'search') return;
  closeRecordDetail();
  await openRecordDetail(id);
  if (request !== linkedRecordRequest || window.location.hash !== hash || !state.unlocked) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}
window.addEventListener('hashchange', event => {
  linkedRecordRequest++;
  // Invalidate an in-flight record-link request even if the new hash is empty.
  if (window.location.hash.startsWith('#record=') || (event.oldURL && new URL(event.oldURL).hash.startsWith('#record='))) closeRecordDetail();
  if (window.location.hash.startsWith('#record=')) {
    if (state.unlocked) openLinkedRecord();
  }
});

function hasDisplayValue(value) {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.trim().length > 0);
}

function emptyValueLabel(value) {
  if (value === undefined) return '空值（未填写）';
  if (value === null) return '空值（JSON null）';
  return value === '' ? '空值（空字符串）' : '空值（仅含空白）';
}

function valueString(value, pretty = false) {
  if (!hasDisplayValue(value)) return '∅';
  return typeof value === 'object' ? JSON.stringify(value, null, pretty ? 2 : 0) : String(value);
}

function publicRecordValues(record) {
  return { ...(record.indexes || {}), ...(record.display || {}) };
}

function identifierKeys(dataset, record) {
  const values = publicRecordValues(record);
  const publicKeys = new Set((dataset?.fields || []).filter(f => ['indexes', 'display'].includes(f.zone)).map(f => f.source_key));
  const configured = (dataset?.display_config?.identifier_fields || []).filter(key => publicKeys.has(key));
  const hasValue = key => Object.hasOwn(values, key) && hasDisplayValue(values[key]);
  if (configured.some(hasValue)) return configured.filter(hasValue);
  const identity = (dataset?.identity_fields || []).filter(key => publicKeys.has(key));
  return identity.length && identity.every(hasValue) ? identity : [];
}

function recordIdentity(record, html = false) {
  const dataset = state.datasets.find(item => item.id === record.dataset_id);
  const values = publicRecordValues(record);
  const keys = identifierKeys(dataset, record);
  if (!keys.length) {
    const id = String(record.id || '');
    const compact = value => String(value).replace(/^rec_/, '');
    let size = 12;
    while (size < compact(id).length && state.records.some(item => item.id !== id && compact(item.id).slice(0, size) === compact(id).slice(0, size))) size++;
    const text = `记录 #${compact(id).slice(0, size)}`;
    return html ? escapeHtml(text) : text;
  }
  return keys.map(key => {
    const label = dataset.fields.find(field => field.source_key === key)?.display_name || key;
    const value = valueString(values[key]);
    return html ? `${escapeHtml(label)}：${highlightField(value, key, record)}` : `${label}：${value}`;
  }).join(' · ');
}

function queryClauses() {
  const tokens = [];
  let token = '', quote = null, escaped = false;
  for (const char of state.query) {
    if (escaped) { token += char; escaped = false; }
    else if (char === '\\') escaped = true;
    else if (quote) { if (char === quote) quote = null; else token += char; }
    else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) { if (token) tokens.push(token); token = ''; }
    else token += char;
  }
  if (token) tokens.push(token);
  return tokens.map(value => {
    const separator = value.indexOf(':');
    const field = separator < 0 ? null : value.slice(0, separator).toLowerCase();
    let raw = separator < 0 ? value : value.slice(separator + 1);
    const operator = /^[=^$~]/.test(raw) ? raw[0] : '';
    if (operator) raw = raw.slice(1);
    if (operator === '~') raw = raw.replace(/^\/+|\/+$/g, '');
    return { field, operator, value: raw };
  });
}

function highlightField(value, key, record) {
  const text = valueString(value);
  if (!state.query || !(record.matched_fields || []).includes(key)) return escapeHtml(text);
  const ranges = [];
  const matchInfo = record.match_info?.[key];
  if (matchInfo?.text === text) {
    for (const [start, end] of matchInfo.ranges || []) if (start >= 0 && end > start && end <= text.length) ranges.push([start, end]);
  }
  const normalized = key.toLowerCase();
  for (const clause of matchInfo?.text === text ? [] : queryClauses()) {
    let selected = clause.field;
    if (selected?.startsWith('附表.')) selected = `supplement.${selected.slice(3)}`;
    if (selected?.startsWith('indexes.') || selected?.startsWith('display.')) selected = selected.slice(selected.indexOf('.') + 1);
    if (selected && selected !== normalized && `supplement.${selected}` !== normalized) continue;
    if (!clause.value) continue;
    if (clause.operator === '~') {
      // Legacy API responses still show the matched field without running a
      // potentially expensive user regex in the UI thread.
      continue;
    }
    const target = text.toLowerCase(), needle = clause.value.toLowerCase();
    let start = target.indexOf(needle);
    while (start >= 0) {
      if ((!clause.operator || clause.operator === '=' && target === needle || clause.operator === '^' && start === 0 || clause.operator === '$' && start + needle.length === text.length)) ranges.push([start, start + needle.length]);
      start = target.indexOf(needle, start + Math.max(1, needle.length));
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  let html = '', cursor = 0;
  for (const [start, end] of merged) {
    html += escapeHtml(text.slice(cursor, start)) + `<mark class="search-hit">${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeHtml(text.slice(cursor));
}

allDisplay = function(record) {
  const dataset = state.datasets.find(item => item.id === record.dataset_id);
  const values = publicRecordValues(record);
  const eligible = new Set((dataset?.fields || []).filter(f => ['indexes', 'display'].includes(f.zone)).map(f => f.source_key));
  const result = Object.create(null);
  const supplement = record.supplement || {};
  const extension = { ...supplement.indexes, ...supplement.display };
  const configured = [...(dataset?.list_fields || [])].sort((a, b) => (a.position || 0) - (b.position || 0));
  const defaults = configured.length ? configured.filter(f => f.visible !== false).map(f => f.source_key) : [...eligible];
  for (const key of record.matched_fields || []) {
    if (key.startsWith('supplement.')) {
      const source = key.slice(11);
      if (Object.hasOwn(extension, source) && hasDisplayValue(extension[source])) result[key] = extension[source];
    } else if (eligible.has(key) && Object.hasOwn(values, key) && hasDisplayValue(values[key])) result[key] = values[key];
  }
  for (const key of defaults) {
    if (eligible.has(key) && Object.hasOwn(values, key) && hasDisplayValue(values[key])) result[key] = values[key];
  }
  for (const [key, value] of Object.entries(record.supplement?.display || {})) if (hasDisplayValue(value)) result[`supplement.${key}`] = value;
  return result;
};

function selectedCategories() {
  return state.category !== 'all' ? [state.category] : state.categories || [];
}

function datasetInCategoryScope(dataset) {
  const paths = selectedCategories();
  return !paths.length || paths.some(path => dataset.category_path === path || dataset.category_path.startsWith(`${path}/`));
}

environments = function() {
  return [...new Set(state.datasets.filter(datasetInCategoryScope).map(dataset => dataset.environment).filter(Boolean))].sort();
};
datasetCandidates = function() {
  if (!selectedCategories().length) return [];
  return state.datasets.filter(dataset => datasetInCategoryScope(dataset) && (state.environment === 'all' || dataset.environment === state.environment));
};
datasetsInCurrentDirectory = function() {
  const selected = currentDataset();
  return selected ? [selected] : state.datasets.filter(datasetInCategoryScope);
};

function normalizedDirectories(paths) {
  const unique = [...new Set(paths)];
  return unique.filter(path => !unique.some(parent => parent !== path && path.startsWith(`${parent}/`)));
}

function renderDirectoryOptions() {
  const search = $('#directory-search').value.trim().toLowerCase();
  const paths = state.directoryDraft;
  $('#directory-options').innerHTML = categoryNodes().filter(node => node.path.toLowerCase().includes(search)).map(node => {
    const covered = paths.some(parent => node.path.startsWith(`${parent}/`));
    const checked = covered || paths.includes(node.path);
    return `<label class="directory-option" style="--depth:${node.depth}"><input type="checkbox" value="${escapeHtml(node.path)}" ${checked ? 'checked' : ''} ${covered ? 'disabled' : ''} /><span><strong>${escapeHtml(node.name)}</strong>${covered ? '<small>已包含于父目录</small>' : ''}</span><em>${node.count}</em></label>`;
  }).join('') || '<p class="detail-empty">没有匹配的目录</p>';
  $('#directory-selection-count').textContent = paths.length ? `已选 ${paths.length} 个目录` : '全部目录';
  $('#directory-options').querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
    state.directoryDraft = normalizedDirectories(input.checked ? [...state.directoryDraft, input.value] : state.directoryDraft.filter(path => path !== input.value));
    renderDirectoryOptions();
    [...$('#directory-options').querySelectorAll('input')].find(item => item.value === input.value)?.focus({ preventScroll: true });
  }));
}

function openDirectoryPicker() {
  state.directoryDraft = normalizedDirectories(selectedCategories());
  $('#directory-search').value = ''; $('#directory-error').hidden = true;
  renderDirectoryOptions();
  $('#directory-toggle').setAttribute('aria-expanded', 'true');
  openDialog('directory-picker');
}

async function applyDirectoryPicker() {
  const paths = normalizedDirectories(state.directoryDraft);
  if (paths.length > 128) {
    $('#directory-error').textContent = '最多选择 128 个目录'; $('#directory-error').hidden = false; return;
  }
  state.category = paths.length === 1 ? paths[0] : 'all';
  state.categories = paths.length > 1 ? paths : [];
  state.selectedDatasetId = null; state.page = 1;
  if (!environments().includes(state.environment)) state.environment = 'all';
  $('#directory-picker').close();
  showWorkspace('search'); renderCategoryTree(); renderFilters(); renderIndexReference();
  try { await fetchRecords(); } catch (error) { showToast(error.message, 'error'); }
}

function singleDatasetInSearchScope() {
  const selected = currentDataset();
  if (selected) return selected;
  const candidates = state.datasets.filter(dataset =>
    datasetInCategoryScope(dataset) &&
    (state.environment === 'all' || dataset.environment === state.environment));
  return candidates.length === 1 ? candidates[0] : null;
}

recordCard = function(record) {
  const dataset = state.datasets.find(item => item.id === record.dataset_id);
  const titleKeys = new Set(identifierKeys(dataset, record));
  const matched = new Set(record.matched_fields || []);
  const entries = Object.entries(allDisplay(record)).filter(([key]) => !titleKeys.has(key));
  const ordered = [...entries.filter(([key]) => matched.has(key)), ...entries.filter(([key]) => !matched.has(key))];
  const density = state.viewDensity === 'default' ? dataset?.display_config?.density || 'summary' : state.viewDensity;
  const field = ([key, value]) => {
    const format = dataset?.list_fields?.find(item => item.source_key === key)?.format || 'single_line';
    const label = record.fieldLabels?.[key] || dataset?.fields?.find(f => f.source_key === key)?.display_name || key;
    return `<div class="data-point ${matched.has(key) ? 'is-match' : ''}"><label>${escapeHtml(label)}</label><span class="display-format-${escapeHtml(format)}" title="${escapeHtml(valueString(value))}">${highlightField(valueString(value, format === 'json'), key, record)}</span></div>`;
  };
  const limit = density === 'full' ? ordered.length : Math.max(3, Math.min(5, ordered.filter(([key]) => matched.has(key)).length));
  const fields = ordered.slice(0, limit).map(field).join('');
  const remaining = ordered.slice(limit);
  const scopedDataset = singleDatasetInSearchScope();
  const singleDataset = scopedDataset?.id === record.dataset_id;
  const source = singleDataset ? '' : `<div class="record-tags"><span>${escapeHtml(record.category)}</span><span class="tag environment ${/^(正式|prod|production)$/i.test(record.environment || '') ? 'production' : ''}">${escapeHtml(record.environment || '未设置')}</span></div>`;
  const expired = record.expired ? '<span class="tag expired-tag">已过期</span>' : '';
  const primaryAction = record.secret_count
    ? `<button class="reveal-secrets-button" data-action="open-secrets" data-record="${escapeHtml(record.id)}">按需查看</button>`
    : `<button class="detail-button" data-action="open-detail" data-record="${escapeHtml(record.id)}">查看详情</button>`;
  const expiryAction = state.canManage ? `<button class="expired-toggle" data-expired-record="${escapeHtml(record.id)}" data-expired="${record.expired}">${record.expired ? '恢复有效' : '标记过期'}</button>` : '';
  return `<article class="record-card ${singleDataset ? 'single-dataset' : ''} ${record.expired ? 'is-expired' : ''} ${state.recordDetail?.id === record.id ? 'selected' : ''}" data-record-id="${escapeHtml(record.id)}" tabindex="-1">
    <div class="record-head"><div class="record-title">${source}<h4><button class="record-open" data-action="open-detail" data-record="${escapeHtml(record.id)}" title="${escapeHtml(recordIdentity(record))}">${recordIdentity(record, true)}</button>${expired}</h4></div></div>
    <div class="record-display" data-density="${escapeHtml(density)}" ${ordered.length ? '' : 'hidden'}><div class="record-summary">${fields}</div><details class="more-fields" ${remaining.length ? '' : 'hidden'}><summary>展开其余 ${remaining.length} 个字段</summary><div class="more-field-values">${remaining.map(field).join('')}</div></details></div>
    <div class="record-secrets">${record.secret_count ? `<span class="secret-count">${record.secret_count} 个敏感字段</span>` : ''}<div class="record-actions">${primaryAction}${expiryAction}</div></div>
  </article>`;
};

renderRecords = function() {
  legacy.renderRecords();
  fitRecordSummaries();
  const scopedDataset = singleDatasetInSearchScope();
  $('#search-workspace').classList.toggle('has-single-dataset-scope', Boolean(scopedDataset));
  $('#search-workspace').classList.toggle('has-directory-scope', selectedCategories().length > 0);
  $('#search-scope-label').textContent = scopedDataset ? `${scopedDataset.category_path} · ${scopedDataset.environment || '未设置'}` : selectedCategories().length > 1 ? `${selectedCategories().length} 个目录` : '跨数据集查找';
  $$('.record-card').forEach(card => card.addEventListener('click', event => {
    if (!event.target.closest('button, summary, details, a, input') && !window.getSelection()?.toString()) openRecordDetail(card.dataset.recordId);
  }));
};

// Measure the actual field layout, so short values share available horizontal
// space while long values and the docked detail panel reduce the summary size.
function fitRecordSummaries() {
  for (const display of $$('.record-card .record-display:not([hidden])')) {
    const summary = display.querySelector('.record-summary');
    const more = display.querySelector('.more-fields');
    const extras = more.querySelector('.more-field-values');
    const width = display.getBoundingClientRect().width;
    if (!width) continue;
    const fields = [...summary.children, ...extras.children];
    summary.style.setProperty('--record-value-width', `${Math.max(160, Math.floor(width * .65))}px`);
    summary.append(...fields);
    const top = summary.getBoundingClientRect().top;
    const mobile = window.innerWidth < 768;
    const budget = mobile ? 82 : 50;
    let count = fields.length;
    if (display.dataset.density !== 'full') {
      count = fields.findIndex((field, index) => index > 0 && field.getBoundingClientRect().bottom - top > budget);
      if (count < 0) count = fields.length;
      extras.append(...fields.slice(count));
    }
    more.hidden = count === fields.length;
    more.querySelector('summary').textContent = `展开其余 ${fields.length - count} 个字段`;
  }
}

let summaryLayoutFrame = null;
function scheduleRecordLayout() {
  if (summaryLayoutFrame !== null) return;
  const run = () => { summaryLayoutFrame = null; fitRecordSummaries(); };
  if (typeof requestAnimationFrame === 'function') summaryLayoutFrame = requestAnimationFrame(run);
  else run();
}
if (typeof ResizeObserver === 'function') {
  let previousWidth = 0;
  const observer = new ResizeObserver(entries => {
    const width = Math.round(entries[0].contentRect.width);
    if (width && width !== previousWidth) { previousWidth = width; scheduleRecordLayout(); }
  });
  observer.observe($('#records-grid'));
}

fetchRecords = async function() {
  const request = ++state.searchRequest;
  const query = state.query;
  const params = new URLSearchParams({ q: query, page: String(state.page), limit: String(state.pageSize) });
  const dataset = currentDataset();
  if (dataset) params.set('dataset_id', dataset.id);
  const categories = selectedCategories();
  if (categories.length === 1) params.set('category', categories[0]);
  else if (categories.length > 1) params.set('categories', JSON.stringify(categories));
  if (state.environment !== 'all') params.set('environment', state.environment);
  if (state.includeExpired) params.set('include_expired', 'true');
  const status = $('#search-status');
  status.hidden = false; status.textContent = '正在更新检索结果…';
  $('#records-grid').setAttribute('aria-busy', 'true');
  $('#search-error').hidden = true;
  try {
    const result = await api(`/records/search?${params}`);
    if (!state.unlocked || request !== state.searchRequest || query !== state.query) return;
    if (!Array.isArray(result.records)) throw new Error('检索响应无效');
    const byId = new Map(state.datasets.map(item => [item.id, item]));
    state.records = result.records.map(record => {
      const dataset = byId.get(record.dataset_id);
      const labels = Object.fromEntries((dataset?.fields || []).map(field => [field.source_key, field.display_name || field.source_key]));
      for (const [key, label] of Object.entries(record.supplement?.field_labels || {})) labels[`supplement.${key}`] = `附表 · ${label}`;
      return { ...record, fieldLabels: labels };
    });
    state.total = result.total; state.page = result.page;
    renderRecords(); renderDatasetActions();
  } catch (error) {
    if (request === state.searchRequest && state.unlocked) {
      $('#search-error span').textContent = error.message;
      $('#search-error').hidden = false;
      $('#empty-state').hidden = true;
    }
    throw error;
  } finally {
    if (request === state.searchRequest) {
      status.hidden = true;
      $('#records-grid').setAttribute('aria-busy', 'false');
    }
  }
};

showWorkspace = function(page) {
  if (!workspaces[page]) return;
  if (state.workspace === 'editor' && page !== 'editor' && state.editorDirty && state.unlocked && !window.confirm('放弃未保存的数据集修改？')) return;
  if (state.workspace === 'search') state.searchScroll = window.scrollY;
  closeDatasetDownloads();
  if (page !== 'search') closeRecordDetail();
  if (state.workspace === 'security' && page !== 'security') clearPasswordChange();
  state.workspace = page;
  for (const [name, id] of Object.entries(workspaces)) $(`#${id}`).hidden = page !== name;
  const active = page === 'dataset' || page === 'editor' ? 'datasets' : page;
  const names = { search: '检索', datasets: '数据集', dataset: '数据集', editor: '数据集', import: '导入', apps: '接入应用', security: '安全设置' };
  $('#workspace-label').textContent = names[page];
  $('#app').dataset.workspace = page;
  for (const [id, name] of [['search-nav-button', 'search'], ['dataset-manager-button', 'datasets'], ['app-manager-button', 'apps'], ['security-settings-button', 'security']]) {
    const button = $(`#${id}`); button.classList.toggle('active', active === name);
    if (active === name) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('.category-sidebar').hidden = page !== 'search';
  $('.app-navigation').classList.remove('directory-open');
  window.scrollTo({ top: page === 'search' ? state.searchScroll || 0 : 0 });
};

function openDialog(id) {
  const dialog = $(`#${id}`);
  if (!dialog.open) dialog.showModal();
}

function descriptionText(text) {
  const container = document.createElement('div');
  container.innerHTML = renderMarkdown(text || '');
  return container.textContent.replace(/\s+/g, ' ').trim();
}

function descriptionSummary(text) { return descriptionText(text) || '暂无描述'; }

updateDatasetDescriptionPreview = function() {
  legacy.updateDatasetDescriptionPreview();
  const text = descriptionText($('#dataset-description').value);
  $('#dataset-description-summary').textContent = text;
  $('#dataset-description-summary').hidden = !text;
  $('#dataset-description-preview-panel').hidden = !text;
  if (!text) $('#dataset-description-preview-panel').open = false;
  $('#edit-description').textContent = text ? '修改描述' : '添加描述';
};

function openDescription(target = null) {
  const dataset = target ? state.datasets.find(item => item.id === target) : null;
  state.descriptionTarget = { id: target || state.editDatasetId || null, editor: !target, initial: target ? dataset.description || '' : $('#dataset-description').value };
  $('#description-draft').value = state.descriptionTarget.initial;
  $('#description-error').hidden = true;
  $('#description-draft-preview').innerHTML = renderMarkdown($('#description-draft').value);
  openDialog('description-edit-modal');
}

function closeDescription(force = false) {
  if (!force && state.descriptionTarget && $('#description-draft').value !== state.descriptionTarget.initial && !window.confirm('放弃未保存的描述修改？')) return;
  $('#description-edit-modal').close();
  $('#description-draft').value = ''; $('#description-draft-preview').replaceChildren();
  state.descriptionTarget = null;
}

async function saveDescription() {
  const target = state.descriptionTarget;
  if (!target || !state.canManage) return;
  const value = $('#description-draft').value;
  $('#save-description').disabled = true;
  try {
    if (target.id) {
      await api(`/datasets/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: JSON.stringify({ description: value }) });
      if (!state.unlocked || state.descriptionTarget !== target) return;
      const dataset = state.datasets.find(item => item.id === target.id);
      if (dataset) dataset.description = value;
    }
    if (target.editor) { $('#dataset-description').value = value; updateDatasetDescriptionPreview(); if (!target.id) state.editorDirty = true; }
    if (state.managedDatasetId === target.id) renderManagedDataset();
    closeDescription(true);
    showToast(target.id ? '描述已保存' : '描述已加入新数据集草稿', 'success');
  } catch (error) { $('#description-error').textContent = error.message; $('#description-error').hidden = false; }
  finally { $('#save-description').disabled = false; }
}

renderListConfig = function(fields, configured = []) {
  const chosen = new Set($('#record-identifier-fields')?.querySelectorAll('input:checked') ? [...$('#record-identifier-fields').querySelectorAll('input:checked')].map(input => input.value) : []);
  $('#list-config-fields').replaceChildren();
  legacy.renderListConfig(fields, configured);
  const dataset = state.datasets.find(item => item.id === state.editDatasetId);
  if (!state.identifierEditing) for (const key of dataset?.display_config?.identifier_fields || []) chosen.add(key);
  $('#record-identifier-fields').innerHTML = fields.filter(field => ['indexes', 'display'].includes(field.zone)).map(field => `<label><input type="checkbox" value="${escapeHtml(field.source_key)}" ${chosen.has(field.source_key) ? 'checked' : ''} />${escapeHtml(field.display_name || field.source_key)}</label>`).join('') || '<span>没有可选的公开字段</span>';
  if (!state.identifierEditing) $('#dataset-density').value = dataset?.display_config?.density || 'summary';
  state.identifierEditing = true;
  renderListPreview();
  $$('#list-config input, #list-config select').forEach(input => input.addEventListener('change', renderListPreview));

};

function readDisplayConfig() {
  return { identifier_fields: [...$('#record-identifier-fields').querySelectorAll('input:checked')].map(input => input.value), density: $('#dataset-density').value };
}

function renderListPreview() {
  const list = readListConfig().filter(field => field.visible);
  const sample = state.records.find(record => record.dataset_id === state.editDatasetId);
  const values = sample ? publicRecordValues(sample) : {};
  $('#list-config-preview').innerHTML = `<strong>列表预览</strong><p>${list.map(field => `<span>${escapeHtml(field.display_name)}：${escapeHtml(Object.hasOwn(values, field.source_key) ? valueString(values[field.source_key]) : '示例值')}</span>`).join('') || '无默认展示字段；查询命中字段仍按需显示。'}</p>`;
}

openDatasetEdit = function(datasetId, mode = 'all') {
  state.editorMode = mode;
  state.identifierEditing = false;
  $('#record-identifier-fields').replaceChildren();
  legacy.openDatasetEdit(datasetId);
  $('#dataset-basic-fields').hidden = !['all', 'basic'].includes(mode);
  $('.dataset-description-editor').hidden = !['all', 'basic'].includes(mode);
  $('#schema-preview').hidden = mode === 'basic' || mode === 'list';
  $('#list-config').hidden = mode === 'basic' || mode === 'fields' || !$('#list-config-fields').children.length;
  const titles = { all: '修改数据集', fields: '修改结构', list: '修改展示规则', basic: '修改基本信息' };
  $('#dataset-title').textContent = titles[mode];
  $('#save-dataset').textContent = mode === 'list' ? '保存展示规则' : mode === 'fields' ? '保存结构' : '保存数据集';
  state.editorDirty = false;
};

openDatasetEditor = function() {
  legacy.openDatasetEditor();
  $('#dataset-description-preview-panel').open = false;
  if (!state.editDatasetId) {
    state.editorMode = 'all'; state.identifierEditing = false;
    $('#dataset-basic-fields').hidden = false; $('.dataset-description-editor').hidden = false;
    $('#schema-preview').hidden = true; state.editorDirty = false;
  }
};

returnFromDatasetEditor = function() {
  const target = state.editorReturn;
  showWorkspace(target);
  if (state.workspace === 'editor') return;
  state.editDatasetId = null; state.editorDirty = false;
  if (target === 'datasets') renderDatasetManager();
  if (target === 'dataset') renderManagedDataset();
  window.scrollTo({ top: state.editorReturnScroll || 0 });
};

function readStructureListConfig(fields, previousFields) {
  const settings = [...$('#list-config-fields').children].map((row, position) => ({
    source_key: row.dataset.listSource, position,
    format: row.querySelector('.list-field-format').value,
    visible: row.querySelector('.list-field-visible').checked
  }));
  const publicFields = fields.filter(field => ['indexes', 'display'].includes(field.zone));
  const oldOrder = previousFields.filter(field => ['indexes', 'display'].includes(field.zone)).map(field => field.source_key);
  const nextOrder = publicFields.map(field => field.previous_source_key || field.source_key);
  const reordered = JSON.stringify(oldOrder) !== JSON.stringify(nextOrder);
  const rows = publicFields.map((field, index) => {
    const saved = settings.find(item => item.source_key === (field.previous_source_key || field.source_key));
    return { ...saved, source_key: field.source_key, display_name: field.display_name || field.source_key,
      position: reordered ? index : saved?.position ?? settings.length + index,
      format: saved?.format || 'single_line', visible: saved?.visible !== false };
  }).sort((a, b) => a.position - b.position);
  return rows.map((field, position) => ({ ...field, position }));
}

createDataset = async function() {
  if (state.datasetSaving || !state.canManage) return;
  state.datasetSaving = true; $('#save-dataset').disabled = true;
  try {
    const category = $('#dataset-category').value.trim();
    if (!category) throw new Error('请填写分类目录路径');
    const fields = $$('#schema-fields .schema-field').map((row, position) => {
      const source_key = row.querySelector('.schema-source-key-input').value.trim();
      return { source_key, previous_source_key: row.dataset.originalSource !== source_key ? row.dataset.originalSource : null, display_name: row.querySelector('.schema-field-label').value.trim(), zone: row.querySelector('.schema-field-zone').value, unique: row.querySelector('.schema-field-unique').checked, position };
    });
    const id = state.editDatasetId;
    let body = { category_path: category, environment: $('#dataset-environment').value.trim() || null, clear_environment: !$('#dataset-environment').value.trim() };
    if (id) {
      const old = state.datasets.find(item => item.id === id);
      if (['fields', 'all'].includes(state.editorMode)) {
        const changes = fields.filter(field => old.fields.some(previous => previous.source_key === (field.previous_source_key || field.source_key) && previous.zone !== field.zone));
        const keyChanged = JSON.stringify(old.identity_fields || []) !== JSON.stringify(fields.filter(field => field.unique).map(field => field.source_key));
        if ((changes.length || keyChanged) && !window.confirm(`确认保存结构变更？\n${changes.map(field => `${field.source_key} → ${fieldZones[field.zone]}${field.zone === 'ignore' ? '（清除已有值）' : ''}`).join('\n')}${keyChanged ? '\n逻辑 KEY 变更将影响去重与附表关联。' : ''}`)) return;
        body = { fields, identity_fields: fields.filter(field => field.unique).map(field => field.source_key), list_fields: readStructureListConfig(fields, old.fields), display_config: readDisplayConfig(), ...(state.editorMode === 'all' ? body : {}) };
      } else if (state.editorMode === 'list') body = { list_fields: readListConfig(), display_config: readDisplayConfig() };
      if (state.editorMode === 'all') body.description = $('#dataset-description').value;
      await api(`/datasets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (state.editorReturn === 'search') {
        state.category = body.category_path || old.category_path;
        state.environment = body.clear_environment ? 'all' : body.environment || old.environment || 'all';
        state.selectedDatasetId = id;
      }
    } else {
      const result = await api('/datasets', { method: 'POST', body: JSON.stringify({ ...body, description: $('#dataset-description').value, fields: [], identity_fields: [], conflict_strategy: 'allow_mark' }) });
      state.managedDatasetId = result.dataset_id;
    }
    state.editorDirty = false;
    await refreshAfterWrite();
    returnFromDatasetEditor();
    showToast(id ? '数据集已更新' : '数据集已创建', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  finally { state.datasetSaving = false; $('#save-dataset').disabled = false; }
};

renderDatasetManager = function() {
  const filter = $('#manager-search').value.trim().toLowerCase();
  const environment = $('#manager-environment').value;
  const environments = [...new Set(state.datasets.map(dataset => dataset.environment).filter(Boolean))].sort();
  $('#manager-environment').innerHTML = '<option value="">全部环境</option>' + environments.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  $('#manager-environment').value = environments.includes(environment) ? environment : '';
  const datasets = state.datasets.filter(dataset => (!environment || dataset.environment === environment) && `${dataset.category_path} ${dataset.description || ''} ${(dataset.fields || []).map(field => `${field.source_key} ${field.display_name}`).join(' ')}`.toLowerCase().includes(filter));
  $('#dataset-manager-list').innerHTML = `<div class="dataset-table-header"><span>数据集 / 目录</span><span>环境</span><span>记录</span><span>字段</span><span>逻辑唯一 KEY</span><span>操作</span></div>` + datasets.map(dataset => `<div class="dataset-manager-row"><div class="dataset-manager-name"><strong>${escapeHtml(dataset.category_path.split('/').at(-1))}</strong><span>${escapeHtml(dataset.category_path)}</span></div><span class="tag environment ${/^(正式|prod|production)$/i.test(dataset.environment || '') ? 'production' : ''}">${escapeHtml(dataset.environment || '未设置')}</span><span>${dataset.record_count || 0}</span><span>${dataset.fields?.length || 0}</span><code>${escapeHtml(dataset.identity_fields?.join(' + ') || '未设置')}</code><div class="row-actions"><button class="clear-button dataset-manage-button" data-dataset-id="${escapeHtml(dataset.id)}">管理</button><button class="clear-button dataset-export-open" data-dataset-id="${escapeHtml(dataset.id)}">导出</button><details class="row-menu"><summary aria-label="更多数据集操作">⋯</summary><div><button class="dataset-view-button" data-dataset-id="${escapeHtml(dataset.id)}">查看信息</button>${state.canManage ? `<button class="dataset-edit-button" data-dataset-id="${escapeHtml(dataset.id)}">修改数据集</button><button class="dataset-new-record-button" data-dataset-id="${escapeHtml(dataset.id)}">新增记录</button><button class="dataset-supplement-button" data-dataset-id="${escapeHtml(dataset.id)}">管理附表</button>` : ''}</div></details></div></div>`).join('') + (!datasets.length ? '<p class="detail-empty">没有匹配的数据集</p>' : '');
  const bind = (selector, action) => $$(selector).forEach(button => button.addEventListener('click', () => action(button.dataset.datasetId)));
  bind('.dataset-manage-button', openManagedDataset); bind('.dataset-export-open', openExport);
  bind('.dataset-view-button', openDatasetInfo); bind('.dataset-edit-button', openDatasetEdit);
  bind('.dataset-new-record-button', id => openManualRecord('main', id)); bind('.dataset-supplement-button', openSupplement);
};

function openManagedDataset(id) {
  state.managedDatasetId = id; state.datasetTab = 'fields';
  renderManagedDataset(); showWorkspace('dataset');
}

function schemaTable(dataset, fields = dataset.fields || []) {
  const keys = new Set(dataset.identity_fields || []);
  return `<div class="dataset-info-table-wrap"><table class="dataset-info-table"><thead><tr><th>源字段</th><th>显示名称</th><th>用途</th><th>唯一 KEY</th><th>列表展示</th><th>顺序</th></tr></thead><tbody>${fields.map(field => `<tr><td><code>${escapeHtml(field.source_key)}</code></td><td>${escapeHtml(field.display_name || field.source_key)}</td><td><span class="tag">${escapeHtml(fieldZones[field.zone] || field.zone)}</span></td><td>${keys.has(field.source_key) ? '是' : '—'}</td><td>${dataset.display_config?.identifier_fields?.includes(field.source_key) ? '记录标识' : dataset.list_fields?.find(item => item.source_key === field.source_key && item.visible !== false) ? { single_line: '单行', multiline: '多行', json: 'JSON' }[dataset.list_fields.find(item => item.source_key === field.source_key).format] || '单行' : '不展示'}</td><td>${(field.position || 0) + 1}</td></tr>`).join('') || '<tr><td colspan="6">暂无字段，可在首次导入时定义结构。</td></tr>'}</tbody></table></div>`;
}

function renderManagedDataset() {
  const dataset = state.datasets.find(item => item.id === state.managedDatasetId);
  if (!dataset) return;
  $('#dataset-detail-heading').innerHTML = `<div class="workspace-heading"><div><p>${escapeHtml(dataset.category_path)}</p><h2>${escapeHtml(dataset.category_path.split('/').at(-1))}</h2><span class="tag environment">${escapeHtml(dataset.environment || '未设置')}</span><span>${dataset.record_count || 0} 条记录 · ${dataset.fields.length} 个字段</span></div><div class="heading-actions"><button id="managed-view-records" class="secondary-button">查看记录</button>${state.canManage ? '<button id="managed-import" class="secondary-button">导入…</button>' : ''}<button id="managed-export" class="secondary-button">导出…</button></div></div>`;
  const description = descriptionText(dataset.description);
  $('#dataset-detail-description').hidden = !description && !state.canManage;
  $('#dataset-detail-description').classList.toggle('empty-description', !description);
  $('#dataset-detail-description').innerHTML = `<div class="section-heading"><strong>数据集描述</strong>${state.canManage ? `<button id="managed-edit-description" class="clear-button">${description ? '修改描述' : '添加描述'}</button>` : ''}</div>${description ? `<p class="description-summary">${escapeHtml(description)}</p><details><summary>展开全文</summary><div class="markdown-content">${renderMarkdown(dataset.description)}</div></details>` : ''}`;
  const tabs = { fields: '字段定义', list: '列表显示', supplement: '附表', basic: '基本信息' };
  $('#dataset-detail-tabs').innerHTML = Object.entries(tabs).map(([key, name]) => `<button role="tab" id="dataset-tab-${key}" aria-controls="dataset-detail-body" aria-selected="${state.datasetTab === key}" tabindex="${state.datasetTab === key ? 0 : -1}" data-dataset-tab="${key}">${name}</button>`).join('');
  $('#dataset-detail-body').setAttribute('role', 'tabpanel');
  $('#dataset-detail-body').setAttribute('aria-labelledby', `dataset-tab-${state.datasetTab}`);
  let content = '';
  if (state.datasetTab === 'fields') content = `<div class="section-heading"><h3>字段定义</h3>${state.canManage ? '<button id="managed-edit" class="secondary-button">修改结构</button>' : ''}</div><input id="managed-field-search" type="search" placeholder="查找字段…" aria-label="查找字段" /><div id="managed-fields">${schemaTable(dataset)}</div>`;
  if (state.datasetTab === 'list') content = `<div class="section-heading"><h3>列表显示</h3>${state.canManage ? '<button id="managed-edit" class="secondary-button">修改展示</button>' : ''}</div><p>记录标识：${escapeHtml(dataset.display_config?.identifier_fields?.join(' + ') || '使用公开逻辑 KEY 或系统 ID')}</p><p>默认密度：${dataset.display_config?.density === 'full' ? '完整' : '摘要'} · 查询命中字段临时前置</p>${schemaTable(dataset, dataset.fields.filter(field => ['indexes', 'display'].includes(field.zone)))}`;
  if (state.datasetTab === 'basic') content = `<div class="section-heading"><h3>基本信息</h3>${state.canManage ? '<button id="managed-edit" class="secondary-button">修改基本信息</button>' : ''}</div><dl class="dataset-info-summary"><div><dt>目录</dt><dd>${escapeHtml(dataset.category_path)}</dd></div><div><dt>环境</dt><dd>${escapeHtml(dataset.environment || '未设置')}</dd></div><div><dt>逻辑唯一 KEY</dt><dd>${escapeHtml(dataset.identity_fields.join(' + ') || '未设置')}</dd></div><div><dt>重复处理</dt><dd>以逻辑 KEY 匹配；导入时选择更新或跳过</dd></div></dl>`;
  if (state.datasetTab === 'supplement') content = `<div class="section-heading"><h3>附表结构</h3><button id="managed-supplement" class="secondary-button">${state.canManage ? '管理附表' : '查看附表'}</button></div><p>附表与主记录一对一关联，主表导入不会覆盖附表。</p>${schemaTable({ ...dataset, identity_fields: [], list_fields: [] }, dataset.supplement_fields || [])}`;
  $('#dataset-detail-body').innerHTML = content;
  $('#managed-field-search')?.addEventListener('input', event => { $('#managed-fields').innerHTML = schemaTable(dataset, dataset.fields.filter(field => `${field.source_key} ${field.display_name}`.toLowerCase().includes(event.target.value.toLowerCase()))); });
  $$('#dataset-detail-tabs button').forEach(button => button.addEventListener('click', () => { state.datasetTab = button.dataset.datasetTab; renderManagedDataset(); $(`#dataset-tab-${state.datasetTab}`).focus(); }));
  $('#managed-edit')?.addEventListener('click', () => openDatasetEdit(dataset.id, state.datasetTab));
  $('#managed-edit-description')?.addEventListener('click', () => openDescription(dataset.id));
  $('#managed-supplement')?.addEventListener('click', () => openSupplement(dataset.id));
  $('#managed-import')?.addEventListener('click', () => openImport(dataset.id));
  $('#managed-export').addEventListener('click', () => openExport(dataset.id));
  $('#managed-view-records').addEventListener('click', async () => {
    state.category = dataset.category_path; state.environment = dataset.environment || 'all'; state.selectedDatasetId = dataset.id; state.page = 1;
    showWorkspace('search'); await fetchRecords(); renderCategoryTree(); renderFilters(); renderIndexReference();
  });
}

openDatasetInfo = function(id) {
  legacy.renderDatasetInfo(id);
  const description = $('#dataset-info-content .dataset-description-section');
  if (description && !descriptionText(state.datasets.find(item => item.id === id)?.description)) { description.remove(); return; }
  if (description) {
    const content = description.querySelector('.markdown-content');
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = '展开全文'; details.append(summary, content);
    const text = document.createElement('p'); text.className = 'description-summary';
    text.textContent = descriptionSummary(state.datasets.find(item => item.id === id)?.description);
    description.append(text, details);
  }
};

refreshAfterWrite = async function() {
  await legacy.refreshAfterWrite();
  if (state.workspace === 'datasets') renderDatasetManager();
  if (state.workspace === 'dataset') renderManagedDataset();
};

openSecrets = async function(id) { await openRecordDetail(id); if (state.recordDetail?.id === id) selectDetailTab('secrets'); };

openRecordDetail = async function(id) {
  state.detailTab = 'overview';
  $('#record-detail-modal').classList.toggle('docked', window.innerWidth >= 1360 && state.workspace === 'search');
  await legacy.openRecordDetail(id);
  if (state.recordDetail?.id !== id) return;
  $('#record-detail-title').textContent = recordIdentity(state.recordDetail);
  const tabs = { overview: '概览', ...(state.recordDetail.protected_fields?.length ? { secrets: '敏感字段' } : {}), ...(state.canManage || state.recordDetail.supplement_records?.length ? { supplement: '附表' } : {}) };
  $('#record-detail-tabs').innerHTML = Object.entries(tabs).map(([tab, label]) => `<button data-detail-tab="${tab}" role="tab" aria-controls="record-detail-content" aria-selected="${tab === state.detailTab}">${label}</button>`).join('');
  $$('#record-detail-tabs button').forEach(button => button.addEventListener('click', () => selectDetailTab(button.dataset.detailTab)));
  $('#record-detail-modal').classList.add('detail-workspace');
  document.body.classList.add('detail-open');
  setDetailMode(); selectDetailTab('overview');
  $$('.record-card').forEach(card => card.classList.toggle('selected', card.dataset.recordId === id));
};

function selectDetailTab(tab) {
  if (!$$('#record-detail-tabs button').some(button => button.dataset.detailTab === tab)) tab = 'overview';
  if (tab !== 'secrets') { state.reveal = null; state.detailRevealRequest++; renderDetailSecrets(); }
  state.detailTab = tab;
  for (const section of $$('#record-detail-content .detail-section')) {
    const title = section.querySelector('h4')?.textContent;
    section.hidden = tab === 'overview' ? ['受保护字段', '附表扩展数据'].includes(title) || Boolean(section.querySelector('.detail-empty')) : tab === 'secrets' ? title !== '受保护字段' : title !== '附表扩展数据';
  }
  const sections = $$('#record-detail-content .detail-section');
  sections.forEach(section => section.classList.remove('first-visible-section'));
  sections.find(section => !section.hidden)?.classList.add('first-visible-section');
  $$('#record-detail-tabs button').forEach(button => button.setAttribute('aria-selected', String(button.dataset.detailTab === tab)));
}

function setDetailMode() {
  const docked = window.innerWidth >= 1360 && state.workspace === 'search' && Boolean(state.recordDetail);
  $('#record-detail-modal').classList.toggle('docked', docked);
  $('#record-detail-modal .detail-dialog').setAttribute('aria-modal', String(!docked));
  document.body.classList.toggle('detail-docked', docked);
  scheduleRecordLayout();
}

closeRecordDetail = function() {
  legacy.closeRecordDetail();
  document.body.classList.remove('detail-open', 'detail-docked');
  scheduleRecordLayout();
  $$('.record-card.selected').forEach(card => card.classList.remove('selected'));
};

renderDetailSecrets = function() {
  legacy.renderDetailSecrets();
  const detail = state.recordDetail;
  if (!detail) return;
  const hint = $('#record-detail-content .protected-fields-help');
  if (hint) hint.hidden = !(detail.protected_fields || []).some(field => field.zone === 'secrets');
  $$('#detail-protected-fields .detail-secret-value').forEach(element => { if (!element.textContent) element.textContent = '••••••••••••'; });
  const revealed = state.reveal;
  if (revealed?.recordId === detail.id) {
    const actions = $('#detail-protected-fields .detail-secret-value.revealed')?.parentElement.querySelector('.detail-secret-actions');
    if (actions) {
      const button = document.createElement('button'); button.className = 'detail-secret-button'; button.textContent = '复制';
      button.addEventListener('click', async () => {
        if (state.reveal !== revealed || revealed.expiresAt <= Date.now()) return;
        try { await navigator.clipboard.writeText(revealed.value); showToast('字段已复制', 'success'); } catch { showToast('剪贴板不可用', 'error'); }
      }); actions.append(button);
    }
  }
};

function openExport(id) {
  const dataset = state.datasets.find(item => item.id === id);
  if (!dataset) return;
  state.exportDatasetId = id;
  $('#export-target').textContent = `${dataset.category_path} · ${dataset.environment || '未设置'}`;
  $('#export-with-secrets').checked = false; $('#export-supplements').checked = false; $('#export-templates').checked = false;
  $('#export-format').value = 'json'; $('#export-error').hidden = true;
  $('#export-record-scope').value = 'all';
  $('input[name="export-content"][value="data"]').checked = true;
  updateExportOptions(); openDialog('export-modal');
}

function updateExportOptions() {
  const content = $('input[name="export-content"]:checked').value;
  $('#export-format').disabled = content !== 'data';
  if (content !== 'data') $('#export-format').value = 'json';
  $('#export-secret-wrap').hidden = content === 'schema';
  $('#export-record-scope-wrap').hidden = content === 'schema';
  $('#export-supplement-wrap').hidden = content !== 'package';
  $('#export-template-wrap').hidden = content === 'data';
  $('#export-content-note').textContent = { schema: '包含字段用途、唯一 KEY、描述、展示规则及附表结构，不含记录值。', data: '只导出记录，JSON / CSV / XLSX 不携带完整结构。', package: '原生数据集包可同时迁移结构与记录。未导出的机密值会保留缺省状态。' }[content];
  $('#confirm-export').textContent = content === 'schema' ? '导出结构' : content === 'package' ? '导出结构与数据' : $('#export-with-secrets').checked ? '导出含机密的数据' : '导出数据';
}

async function downloadExport() {
  const id = state.exportDatasetId;
  if (!id || state.exportBusy) return;
  state.exportBusy = true; $('#confirm-export').disabled = true;
  const content = $('input[name="export-content"]:checked').value;
  const format = content === 'data' ? $('#export-format').value : 'json';
  const params = new URLSearchParams({ content, format, include_expired: String($('#export-record-scope').value === 'all'), include_secrets: String(content !== 'schema' && $('#export-with-secrets').checked), include_templates: String(content !== 'data' && $('#export-templates').checked), include_supplements: String(content === 'package' && $('#export-supplements').checked) });
  try {
    const response = await fetch(`/api/datasets/${encodeURIComponent(id)}/export?${params}`);
    if (!response.ok) { const body = await response.json(); throw new Error(body.error || '导出失败'); }
    const blob = await response.blob();
    if (!state.unlocked || state.exportDatasetId !== id) return;
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `securevault-${id}${content === 'schema' ? '.schema' : content === 'package' ? '.dataset' : ''}.${format}`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    $('#export-modal').close(); $('#export-with-secrets').checked = false; state.exportDatasetId = null;
    showToast('数据集已导出', 'success');
  } catch (error) { $('#export-error').textContent = error.message; $('#export-error').hidden = false; }
  finally { state.exportBusy = false; $('#confirm-export').disabled = false; }
}

function setImportStep(step) {
  state.importStep = step;
  $$('#import-steps li').forEach(item => item.classList.toggle('active', Number(item.dataset.step) === step));
  $('#batch-options').hidden = step !== 2 || Boolean(state.transferPackage);
  $('#transfer-options').hidden = step !== 2 || !state.transferPackage;
  $('#import-confirmation').hidden = step !== 3;
  $('#ordinary-import-target').hidden = Boolean(state.transferPackage) || step === 3;
  $('.import-file-row').hidden = step === 3;
}

function resetImport() {
  state.transferPackage = null; state.transferRaw = null; state.importPreview = null; state.pendingBatchId = null;
  state.currentBatchSources = []; $('#mapping-list').replaceChildren();
  $('#batch-summary').hidden = true; $('#import-result').hidden = true;
  $('#import-action-error').hidden = true; $('#import-confirm-summary').replaceChildren();
  $('#skip-existing').checked = false; $('#delete-missing').checked = false;
  $('#transfer-skip').checked = false; $('#confirm-structure-changes').checked = false;
  $('#import-file').value = '';
  setImportStep(1);
}

openImport = function(id = null) {
  if (!state.canManage) return;
  state.importReturn = state.workspace === 'dataset' ? 'dataset' : state.workspace === 'search' ? 'search' : 'datasets';
  datasetOptions();
  const preferred = typeof id === 'string' ? id : currentDataset()?.id;
  if (preferred) $('#import-dataset-select').value = preferred;
  resetImport(); showWorkspace('import');
};

importFile = async function(file) {
  if (!file || state.importBusy) return;
  resetImport();
  if (/\.json$/i.test(file.name)) {
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      if (parsed?.format === 'securevault-dataset') {
        if (parsed.version !== 1 || !['schema', 'package'].includes(parsed.mode) || !parsed.schema) throw new Error('不支持的数据集文件版本或结构');
        state.transferPackage = parsed; state.transferRaw = raw;
        $('#transfer-skip').closest('label').hidden = parsed.mode === 'schema';
        $('#batch-summary').hidden = false;
        $('#batch-summary').textContent = `${file.name} · ${parsed.mode === 'schema' ? '仅结构' : '结构与数据'} · ${parsed.records?.length || 0} 条记录`;
        $('#transfer-target').innerHTML = '<option value="">新建数据集</option>' + state.datasets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.category_path)} · ${escapeHtml(item.environment || '未设置')}</option>`).join('');
        $('#transfer-category').value = parsed.schema.category_path || '';
        $('#transfer-environment').value = parsed.schema.environment || '';
        $('#transfer-schema-preview').innerHTML = `<h4>结构预览</h4>${schemaTable({ ...parsed.schema, fields: parsed.schema.fields || [] })}`;
        if (parsed.templates?.length) $('#transfer-schema-preview').insertAdjacentHTML('beforeend', `<details class="transfer-templates"><summary>映射模板 · ${parsed.templates.length} 个</summary>${parsed.templates.map((template, index) => `<label>导入模板名称<input data-transfer-template-name="${index}" value="${escapeHtml(template.name)}" /></label>`).join('')}<p>若名称与已有模板冲突，可在这里修改，不影响记录值。</p></details>`);
        setImportStep(2); return;
      }
    } catch (error) {
      if (state.transferPackage || /不支持/.test(error.message)) { state.transferPackage = null; showToast(error.message, 'error'); return; }
      // The ordinary uploader supplies precise JSON validation errors.
    }
  }
  await legacy.importFile(file);
  if (state.pendingBatchId) { labelSchemaControls($('#first-schema-fields')); setImportStep(2); }
};

renderMappings = function(sourceFields, targetFields, autoSelect = false, templates = []) {
  $('#mapping-list').innerHTML = sourceFields.map(source => {
    const template = templates.find(item => item.source_key === source);
    const selected = targetFields.find(field => field.source_key === (template?.target_key || source));
    return `<div class="mapping-row"><code>${escapeHtml(source)}</code><div class="mapping-target"><label class="mobile-field-label">目标字段</label><select aria-label="${escapeHtml(source)} 的目标字段" data-map-source="${escapeHtml(source)}"><option value="">忽略本次导入</option>${targetFields.map(field => `<option value="${escapeHtml(field.source_key)}" ${selected?.source_key === field.source_key ? 'selected' : ''}>${escapeHtml(field.display_name || field.source_key)} · ${escapeHtml(field.source_key)}${field.zone === 'ignore' ? '（忽略，不保存）' : ''}</option>`).join('')}<option value="__new">新增字段…</option></select><input aria-label="新字段名称" data-map-new="${escapeHtml(source)}" placeholder="新字段名称" hidden /></div><div class="mapping-path"><label class="mobile-field-label">JSON 路径</label><input aria-label="${escapeHtml(source)} 内的 JSON 路径" data-map-path="${escapeHtml(source)}" value="${escapeHtml(template?.json_path || '')}" placeholder="可选，例如 endpoint" /></div><span class="mapping-status">${selected ? '已对应' : '待选择'}</span></div>`;
  }).join('');
  $$('[data-map-source]').forEach(select => select.addEventListener('change', () => {
    const row = select.closest('.mapping-row'); row.querySelector('[data-map-new]').hidden = select.value !== '__new';
    row.querySelector('.mapping-status').textContent = select.value === '__new' ? '新增' : select.value ? '已对应' : '忽略';
  }));
};

function buildImportRequest() {
  const dataset = state.datasets.find(item => item.id === $('#import-dataset-select').value);
  if (!dataset || !state.pendingBatchId) throw new Error('请先选择目标数据集并上传文件');
  const mappings = $$('[data-map-source]').filter(select => select.value).map(select => {
    const row = select.closest('.mapping-row');
    const target_key = select.value === '__new' ? row.querySelector('[data-map-new]').value.trim() : select.value;
    if (!target_key) throw new Error('请填写新字段名称');
    return { source_key: select.dataset.mapSource, target_key, json_path: row.querySelector('[data-map-path]').value.trim() || null };
  });
  if (!mappings.length) throw new Error('至少选择一个导入字段');
  if (new Set(mappings.map(item => item.target_key)).size !== mappings.length) throw new Error('多个源字段不能同时写入同一个目标字段');
  let fields = [], identity = [...(dataset.identity_fields || [])];
  if (!dataset.fields.length) {
    fields = $$('#first-schema-fields .schema-field').flatMap(row => {
      const source = row.querySelector('.schema-source-key').textContent;
      const mapping = mappings.find(item => item.source_key === source);
      return mapping ? [{ source_key: mapping.target_key, display_name: row.querySelector('.schema-field-label').value.trim(), zone: row.querySelector('.schema-field-zone').value, unique: row.querySelector('.schema-field-unique').checked }] : [];
    });
    identity = fields.filter(field => field.unique).map(field => field.source_key);
  } else {
    fields = mappings.filter(mapping => !dataset.fields.some(field => field.source_key === mapping.target_key)).map(mapping => ({ source_key: mapping.target_key, display_name: mapping.target_key, zone: /key|secret|token|password|private/i.test(mapping.target_key) ? 'secrets' : 'indexes', unique: false }));
  }
  if ($('#delete-missing').checked && !identity.length) throw new Error('删除缺失记录需要完整的逻辑唯一 KEY');
  return { dataset_id: dataset.id, batch_id: state.pendingBatchId, mappings, evolved_fields: fields, evolved_identity_fields: identity, template_name: $('#mapping-template').value.trim() || null, skip_existing: $('#skip-existing').checked, delete_missing: $('#delete-missing').checked };
}

function buildTransferRequest() {
  if (!$('#transfer-category').value.trim()) throw new Error('请填写目标目录');
  const request = { package: state.transferRaw || state.transferPackage, dataset_id: $('#transfer-target').value || null, category_path: $('#transfer-category').value.trim(), environment: $('#transfer-environment').value.trim() || null, skip_existing: $('#transfer-skip').checked, template_names: $$('[data-transfer-template-name]').map(input => input.value.trim()) };
  if (new Blob([JSON.stringify(request)]).size > 16 * 1024 * 1024) throw new Error('单次原生导入超过 16 MiB，请拆分数据集包');
  return request;
}

commitImport = async function() {
  if (state.importBusy) return;
  state.importBusy = true; $('#commit-import').disabled = true; $('#preview-transfer').disabled = true;
  try {
    const transfer = Boolean(state.transferPackage);
    const request = transfer ? buildTransferRequest() : buildImportRequest();
    const preview = await api(transfer ? '/datasets/transfer/preview' : '/records/import/preview', { method: 'POST', body: JSON.stringify(request) });
    if (!state.unlocked) return;
    state.importPreview = { transfer, request, preview, mode: state.transferPackage?.mode };
    const stats = transfer ? preview.result : preview;
    const dataset = state.datasets.find(item => item.id === request.dataset_id);
    const target = transfer ? `${request.category_path} · ${request.environment || '未设置'}` : `${dataset.category_path} · ${dataset.environment || '未设置'}`;
    $('#import-confirm-summary').innerHTML = `<dl class="dataset-info-summary"><div><dt>目标</dt><dd>${escapeHtml(target)}</dd></div><div><dt>导入内容</dt><dd>${transfer ? state.transferPackage?.mode === 'schema' ? '仅结构' : '结构与数据' : '记录数据'}</dd></div><div><dt>新增 / 更新 / 跳过</dt><dd>${stats.imported || 0} / ${stats.updated || 0} / ${stats.skipped || 0}</dd></div><div><dt>删除旧记录</dt><dd>${stats.deleted_missing || 0}</dd></div></dl>${transfer && preview.changes.length ? `<h4>结构变更</h4><ul>${preview.changes.map(change => `<li>${escapeHtml(change)}</li>`).join('')}</ul>` : ''}<p>以上为当前预检结果。确认前尚未写入数据。</p>`;
    $('#confirm-structure-wrap').hidden = !transfer || !preview.changes.length;
    $('#confirm-structure-changes').checked = false; $('#import-action-error').hidden = true;
    setImportStep(3);
  } catch (error) { showToast(error.message, 'error'); }
  finally { state.importBusy = false; $('#commit-import').disabled = false; $('#preview-transfer').disabled = false; }
};

async function confirmImport() {
  const pending = state.importPreview;
  if (!pending || state.importBusy) return;
  if (pending.transfer && pending.preview.changes.length && !$('#confirm-structure-changes').checked) { $('#import-action-error').textContent = '请确认结构变更与影响'; $('#import-action-error').hidden = false; return; }
  state.importBusy = true; $('#confirm-import').disabled = true;
  try {
    const body = pending.transfer ? { ...pending.request, confirmation_token: pending.preview.confirmation_token, confirm_changes: $('#confirm-structure-changes').checked } : pending.request;
    const result = await api(pending.transfer ? '/datasets/transfer/import' : '/records/import', { method: 'POST', body: JSON.stringify(body) });
    if (!state.unlocked || state.importPreview !== pending) return;
    await refreshAfterWrite();
    $('#import-confirmation').hidden = true; $('#import-result').hidden = false;
    const structureOnly = pending.transfer && pending.mode === 'schema';
    $('#import-result').innerHTML = `<h3>${structureOnly ? '结构已导入' : '导入完成'}</h3>${pending.transfer ? `<p>${escapeHtml(pending.request.category_path)} · ${escapeHtml(pending.request.environment || '未设置')}</p>` : ''}<p>${structureOnly ? `${pending.request.dataset_id ? '已更新结构，保留已有记录' : '已创建空数据集'} · ${pending.preview.field_count} 个字段` : `新增 ${result.imported || 0} 条 · 更新 ${result.updated || 0} 条 · 跳过 ${result.skipped || 0} 条${result.deleted_missing ? ` · 删除 ${result.deleted_missing} 条` : ''}`}</p><button id="import-finish" class="primary-button">返回数据集</button>`;
    $('#import-finish').addEventListener('click', () => pending.transfer ? openManagedDataset(result.dataset_id) : showWorkspace(state.importReturn));
    state.pendingBatchId = null; state.transferPackage = null; state.transferRaw = null; state.importPreview = null;
  } catch (error) { $('#import-action-error').textContent = error.message; $('#import-action-error').hidden = false; }
  finally { state.importBusy = false; $('#confirm-import').disabled = false; }
}

function showAppKey(value, app = null) {
  if (!state.unlocked) return;
  $('#app-key-context').textContent = app ? app.name : '';
  $('#app-key-id').textContent = app?.id || '';
  $('#app-key-identity').hidden = !app?.id;
  $('#app-key-value').value = value; openDialog('app-key-modal');
}

// Overlay focus is controlled only for modal views; docked reading stays usable.
const overlayFrames = new Map();
let overlayOrder = [];
function modalElement() {
  // Native dialogs restore focus to their opener, including a dialog underneath.
  const focusedDialog = document.activeElement?.closest('dialog[open]');
  if (focusedDialog) return focusedDialog;
  const dialogs = [...document.querySelectorAll('dialog[open]')];
  if (dialogs.length) return dialogs.at(-1);
  return overlayOrder.filter(id => !document.getElementById(id).hidden && !document.getElementById(id).classList.contains('docked')).map(id => document.getElementById(id)).at(-1);
}

function updateOverlayFocus() {
  const modals = $$('.reveal-modal');
  for (const modal of modals) {
    if (!modal.hidden && !overlayFrames.has(modal.id)) {
      overlayFrames.set(modal.id, document.activeElement); overlayOrder.push(modal.id);
      if (!modal.classList.contains('docked')) modal.querySelector('button, input, select, textarea')?.focus();
    } else if (modal.hidden && overlayFrames.has(modal.id)) {
      const trigger = overlayFrames.get(modal.id); overlayFrames.delete(modal.id); overlayOrder = overlayOrder.filter(id => id !== modal.id);
      if (state.unlocked && trigger?.isConnected && !trigger.closest('[hidden]')) trigger.focus();
    }
  }
  const top = modalElement();
  $('#vault-screen').inert = Boolean(top && top.tagName !== 'DIALOG');
  for (const modal of modals) modal.inert = Boolean(top && top !== modal && !modal.hidden);
}

function closeTopOverlay() {
  const top = modalElement();
  if (!top) { $('.app-navigation').classList.remove('directory-open'); return; }
  if (top.id === 'description-edit-modal') { closeDescription(); return; }
  if (top.id === 'app-scope-modal') { closeAppScope(); return; }
  if (top.id === 'app-details-modal') { closeAppDetails(); return; }
  if (top.tagName === 'DIALOG') { top.close(); return; }
  const close = { 'manual-record-modal': closeManualRecord, 'supplement-modal': closeSupplement, 'record-detail-modal': closeRecordDetail, 'secrets-modal': () => { $('#secrets-modal').hidden = true; $('#secret-fields-list').replaceChildren(); state.secretModalRecordId = null; state.reveal = null; }, 'reveal-modal': () => { $('#reveal-modal').hidden = true; state.pendingReveal = null; } };
  close[top.id]?.();
}

sealVault = async function(...args) {
  state.searchRequest++; state.workspaceRequest++; state.editorDirty = false; state.importPreview = null; state.transferPackage = null; state.transferRaw = null;
  state.descriptionTarget = null; state.exportDatasetId = null; state.categories = []; state.directoryDraft = [];
  state.scopeEditing = null; state.appViewing = null; state.appDetailBusy = null; state.apps = [];
  $('#app-details-content').replaceChildren(); $('#scope-name').value = '';
  $('#app-key-context').textContent = ''; $('#app-key-id').textContent = '';
  $('#app-scope-modal').close(); $('#scope-datasets').replaceChildren(); $('#app-manager-list').replaceChildren();
  for (const dialog of $$('dialog[open]')) dialog.close();
  $('#description-draft').value = ''; $('#description-draft-preview').replaceChildren(); $('#app-key-value').value = '';
  $('#dataset-description').value = ''; $('#dataset-description-preview').replaceChildren();
  $('#dataset-manager-list').replaceChildren(); $('#dataset-detail-body').replaceChildren(); $('#dataset-detail-description').replaceChildren(); $('#dataset-detail-heading').replaceChildren();
  $('#transfer-schema-preview').replaceChildren(); $('#import-confirm-summary').replaceChildren();
  $('#import-file').value = ''; $('#list-config-preview').replaceChildren();
  await legacy.sealVault(...args);
};

// Initialization preserves established editor IDs and form handlers.
$('#record-detail-content').before(Object.assign(document.createElement('div'), { id: 'record-detail-tabs', className: 'page-tabs' }));
$('#record-detail-tabs').setAttribute('role', 'tablist');
$('#search-nav-button').addEventListener('click', () => showWorkspace('search'));
$('#directory-toggle').addEventListener('click', openDirectoryPicker);
$('#directory-search').addEventListener('input', renderDirectoryOptions);
$('#directory-select-all').addEventListener('click', () => { state.directoryDraft = []; renderDirectoryOptions(); });
$('#apply-directory-picker').addEventListener('click', applyDirectoryPicker);
for (const id of ['close-directory-picker', 'cancel-directory-picker']) $(`#${id}`).addEventListener('click', () => $('#directory-picker').close());
$('#directory-picker').addEventListener('close', () => { state.directoryDraft = []; $('#directory-options').replaceChildren(); $('#directory-search').value = ''; $('#directory-toggle').setAttribute('aria-expanded', 'false'); });
$('#view-density').addEventListener('change', event => { state.viewDensity = event.target.value; renderRecords(); });
$('#retry-search').addEventListener('click', () => fetchRecords().catch(() => {}));
$('#manager-search').addEventListener('input', renderDatasetManager);
$('#manager-environment').addEventListener('change', renderDatasetManager);
$('#close-dataset-detail').addEventListener('click', openDatasetManager);
$('#dataset-modal').addEventListener('input', event => { if (!event.target.matches('.schema-position')) state.editorDirty = true; });
$('#dataset-modal').addEventListener('change', event => { if (!event.target.matches('.schema-position')) state.editorDirty = true; });
$('#dataset-modal').addEventListener('click', event => {
  if (!event.target.closest('[data-schema-move], [data-list-move]')) return;
  state.editorDirty = true;
  renderListPreview();
});
$('#edit-description').addEventListener('click', () => openDescription());
$('#description-draft').addEventListener('input', () => { $('#description-draft-preview').innerHTML = renderMarkdown($('#description-draft').value); });
$('#save-description').addEventListener('click', saveDescription);
for (const id of ['close-description', 'cancel-description']) $(`#${id}`).addEventListener('click', () => closeDescription());
$('#description-edit-modal').addEventListener('cancel', event => { event.preventDefault(); closeDescription(); });
$('#confirm-export').addEventListener('click', downloadExport);
for (const id of ['close-export', 'cancel-export']) $(`#${id}`).addEventListener('click', () => $('#export-modal').close());
$$('input[name="export-content"], #export-with-secrets').forEach(input => input.addEventListener('change', updateExportOptions));
$('#export-modal').addEventListener('close', () => { $('#export-with-secrets').checked = false; state.exportDatasetId = null; });
$('#preview-transfer').addEventListener('click', () => commitImport());
$('#confirm-import').addEventListener('click', confirmImport);
$('#import-back').addEventListener('click', () => { state.importPreview = null; setImportStep(2); });
$('#import-dataset-select').addEventListener('change', resetImport);
$('#transfer-target').addEventListener('change', event => {
  const dataset = state.datasets.find(item => item.id === event.target.value);
  $('#transfer-category').value = dataset?.category_path || state.transferPackage?.schema.category_path || '';
  $('#transfer-environment').value = dataset?.environment || (dataset ? '' : state.transferPackage?.schema.environment || '');
});
for (const id of ['close-app-key', 'finish-app-key']) $(`#${id}`).addEventListener('click', () => $('#app-key-modal').close());
$('#app-key-modal').addEventListener('close', () => { $('#app-key-value').value = ''; $('#app-key-context').textContent = ''; $('#app-key-id').textContent = ''; });
$('#copy-app-key').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#app-key-value').value); showToast('应用密钥已复制', 'success'); } catch { showToast('剪贴板不可用', 'error'); } });
$('#records-grid').addEventListener('keydown', event => {
  if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key) || event.target.closest('input, textarea, select, summary')) return;
  const rows = $$('.record-card'); if (!rows.length) return;
  const index = rows.indexOf(event.target.closest('.record-card'));
  if (event.key === 'Enter') { if (index >= 0) { event.preventDefault(); openRecordDetail(rows[index].dataset.recordId); } return; }
  event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.querySelector('.record-open').focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeTopOverlay(); return; }
  if (event.key !== 'Tab') return;
  const top = modalElement(); if (!top || top.tagName === 'DIALOG') return;
  const focusable = [...top.querySelectorAll('button, input, select, textarea, summary, [tabindex="0"]')].filter(element => !element.disabled && !element.closest('[hidden]'));
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (modalElement() || !state.unlocked) return;
  showWorkspace('search');
  if (state.workspace === 'search') $('#search-input').focus();
}, true);
document.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key) || event.target.getAttribute('role') !== 'tab') return;
  const tabs = [...event.target.parentElement.querySelectorAll('[role="tab"]')], index = tabs.indexOf(event.target);
  event.preventDefault(); tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].click();
});
new MutationObserver(updateOverlayFocus).observe($('#app'), { attributes: true, attributeFilter: ['hidden', 'open'], subtree: true });
window.addEventListener('resize', () => { setDetailMode(); scheduleRecordLayout(); updateOverlayFocus(); });
window.addEventListener('beforeunload', event => { if (state.editorDirty && state.unlocked) { event.preventDefault(); event.returnValue = ''; } });
$('.density-select').title = '临时调整当前视图，不修改数据集默认配置';
$('#search-input').closest('.search-input-wrap').querySelector('kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
showWorkspace('search');

const navIcons = {
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  datasets: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  apps: '<path d="m10 14 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  security: '<path d="M3 5h18M3 12h18M3 19h18M7 2v6M16 9v6M9 16v6"/>',
  folder: '<path d="M2 6h8l2 3h10v12H2z"/>'
};
function svgIcon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${navIcons[name]}</svg>`; }
for (const [id, icon, label] of [['search-nav-button', 'search', '检索'], ['dataset-manager-button', 'datasets', '数据集'], ['app-manager-button', 'apps', '接入应用'], ['security-settings-button', 'security', '安全设置']]) $(`#${id}`).innerHTML = svgIcon(icon) + label;
$('.search-symbol').innerHTML = svgIcon('search');
$('.view-tools').prepend($('.expired-filter'));
const legacyCategoryTree = renderCategoryTree;
renderCategoryTree = function() {
  legacyCategoryTree();
  const paths = selectedCategories();
  $('#all-categories').classList.toggle('selected', !paths.length);
  $$('#category-tree [data-category-path]').forEach(button => button.classList.toggle('selected', paths.includes(button.dataset.categoryPath)));
  $$('.folder-icon').forEach(element => { element.innerHTML = svgIcon('folder'); });
};

$('.brand-icon').textContent = 'SV';

$('#export-secret-wrap').insertAdjacentHTML('beforebegin', '<label id="export-record-scope-wrap">记录范围<select id="export-record-scope"><option value="all">全部记录（含过期）</option><option value="active">仅有效记录</option></select></label>');
const legacyFilters = renderFilters;
renderFilters = function() {
  legacyFilters();
  const scope = $('#global-dataset-scope');
  scope.innerHTML = '<option value="">全部数据集</option>' + state.datasets.filter(dataset => state.environment === 'all' || dataset.environment === state.environment).map(dataset => `<option value="${escapeHtml(dataset.id)}">${escapeHtml(dataset.category_path)} · ${escapeHtml(dataset.environment || '未设置')}</option>`).join('');
  scope.value = currentDataset()?.id || '';
  $('#mobile-environment').innerHTML = ['all', ...environments()].map(value => `<option value="${escapeHtml(value)}">${value === 'all' ? '全部环境' : escapeHtml(value)}</option>`).join('');
  $('#mobile-environment').value = state.environment;
};
const scopeLabel = document.createElement('label');
scopeLabel.className = 'dataset-scope-select';
scopeLabel.innerHTML = '<select id="global-dataset-scope" aria-label="数据集范围"><option value="">全部数据集</option></select>';
$('.filter-row').insertBefore(scopeLabel, $('#clear-filters'));
const mobileEnvironment = document.createElement('label');
mobileEnvironment.className = 'mobile-environment-select';
mobileEnvironment.innerHTML = '<select id="mobile-environment" aria-label="检索环境"><option value="all">全部环境</option></select>';
$('.filter-row').insertBefore(mobileEnvironment, scopeLabel);
$('#mobile-environment').addEventListener('change', async event => {
  state.environment = event.target.value; state.selectedDatasetId = null; state.page = 1;
  try { await fetchRecords(); renderFilters(); renderIndexReference(); } catch (error) { showToast(error.message, 'error'); }
});
$('#global-dataset-scope').addEventListener('change', async event => {
  const dataset = state.datasets.find(item => item.id === event.target.value);
  state.category = dataset?.category_path || 'all'; state.categories = []; state.selectedDatasetId = dataset?.id || null; state.page = 1;
  try { await fetchRecords(); renderCategoryTree(); renderFilters(); renderIndexReference(); } catch (error) { showToast(error.message, 'error'); }
});

detailRows = function(values, labels = {}) {
  return Object.entries(values || {}).map(([key, value]) => `<div class="detail-row"><span>${escapeHtml(labels[key] || key)}</span><strong class="detail-public-value"><span ${hasDisplayValue(value) ? '' : `class="empty-value" title="${emptyValueLabel(value)}" aria-label="${emptyValueLabel(value)}"`}>${escapeHtml(valueString(value))}</span><button class="field-copy" data-copy-json="${escapeHtml(JSON.stringify(value))}" aria-label="复制 ${escapeHtml(labels[key] || key)}" type="button">复制</button></strong></div>`).join('') || '<p class="detail-empty">无字段</p>';
};
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy-json]');
  if (!button) return;
  try {
    const value = JSON.parse(button.dataset.copyJson);
    await navigator.clipboard.writeText(typeof value === 'string' ? value : JSON.stringify(value));
    showToast('字段已复制', 'success');
  } catch { showToast('剪贴板不可用', 'error'); }
});
// Fullscreen overlays retain an immediate seal action without trapping users in a form.
for (const panel of $$('.reveal-dialog, dialog')) {
  const button = document.createElement('button');
  button.className = 'secondary-button panel-lock'; button.type = 'button'; button.textContent = '立即封印';
  button.addEventListener('click', () => sealVault()); panel.append(button);
}

function labelSchemaControls(container) {
  for (const [selector, title] of [['.schema-source-key-input', '源字段'], ['.schema-field-label', '显示名称'], ['.schema-field-zone', '字段用途'], ['.list-field-format', '展示形式']]) {
    container.querySelectorAll(selector).forEach(input => {
      if (input.parentElement.classList.contains('labelled-field')) return;
      const label = document.createElement('label'); label.className = 'labelled-field';
      const caption = document.createElement('span'); caption.className = 'mobile-field-label'; caption.textContent = title;
      input.before(label); label.append(caption, input);
    });
  }
}
const legacySchemaFields = renderSchemaFields;
renderSchemaFields = function(fields) { legacySchemaFields(fields); labelSchemaControls($('#schema-fields')); };
const legacyConfiguredList = renderListConfig;
renderListConfig = function(fields, configured) { legacyConfiguredList(fields, configured); labelSchemaControls($('#list-config-fields')); };
const legacyTheme = applyTheme;
applyTheme = function(theme = state.theme) {
  legacyTheme(theme);
  $('#theme-toggle span').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${state.theme === 'light' ? '<path d="M20 15a9 9 0 0 1-11-11 9 9 0 1 0 11 11Z"/>' : '<circle cx="12" cy="12" r="5"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3M4 4l2 2m12 12 2 2M4 20l2-2M18 6l2-2"/>'}</svg>`;
  document.querySelector('meta[name="theme-color"]').content = state.theme === 'light' ? '#f5f7f9' : '#0d151e';
};
$('#lock-button span').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3M4 10h16v12H4zM12 15v3"/></svg>';
applyTheme();
