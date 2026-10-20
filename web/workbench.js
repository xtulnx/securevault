// V2 workspaces reuse the storage, session and field editors in app.js.
Object.assign(state, {
  searchRequest: 0, workspaceRequest: 0, viewDensity: 'default', managedDatasetId: null,
  datasetTab: 'fields', editorMode: 'all', editorDirty: false,
  importStep: 1, importBusy: false, transferPackage: null, importPreview: null,
  environmentTags: [], managerTags: [], environmentDraft: [], transferEnvironmentDraft: [], exportDatasetId: null, descriptionTarget: null, detailTab: 'overview', categories: [], directoryDraft: []
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
  renderDimensionFilters();
  if (state.environment !== 'all' && !environments().includes(state.environment)) state.environment = 'all';
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
  if (state.schemaFilter && dataset.schema_id !== state.schemaFilter) return false;
  const paths = selectedCategories();
  return !paths.length || paths.some(path => dataset.category_path === path || dataset.category_path.startsWith(`${path}/`));
}

function datasetName(dataset) { return dataset?.name?.trim() || dataset?.category_path?.split('/').at(-1) || '未命名数据集'; }
function datasetLocator(dataset) { return dataset?.name?.trim() ? `${datasetName(dataset)} · ${dataset.category_path}` : dataset?.category_path || ''; }
function updateDatasetNamePlaceholder() {
  const fallback = $('#dataset-category').value.trim().split('/').at(-1);
  $('#dataset-name').placeholder = fallback ? `留空时显示“${fallback}”` : '留空时使用目录末级名称';
}
$('#dataset-category').addEventListener('input', updateDatasetNamePlaceholder);

// Reference views use metadata snapshots only; opening them never changes editor or import drafts.
function referencedModel(dataset) {
  const model = state.canManage ? state.catalog.schemas.find(item => item.id === dataset?.schema_id) : null;
  return { name: model?.name || dataset?.schema_name || '独立模型', version: model?.version || dataset?.schema_version,
    description: model?.description || '', definition: model?.definition || dataset || {},
    available: Boolean(model), error: !model && dataset?.schema_id
      ? state.referenceCatalogError || (state.referenceCatalogLoaded ? '未找到此数据模型，请重新加载。' : '正在加载模型说明…') : '' };
}
function fileDatasetReference() {
  const pack = state.transferPackage, schema = pack?.schema;
  if (!schema) return null;
  const environments = [...datasetLabels(schema)];
  if (schema.customer && !environments.includes(schema.customer)) environments.push(schema.customer);
  return { ...schema, environments, record_count: pack.records?.length || 0 };
}
function fileModelReference(dataset) {
  return { name: dataset?.schema_name || dataset?.category_path || '新建独立模型', description: dataset?.schema_description || '',
    definition: dataset || {}, available: true, note: '文件中的模型定义；新建导入会建立独立模型。' };
}
function referenceCard(kind, value, key, caption) {
  const model = kind === 'model', description = value.description || '';
  const title = model ? value.name : datasetName(value);
  const definition = model ? value.definition : value;
  const metadata = model ? [value.version ? `v${value.version}` : '', `${definition.fields?.length || 0} 个字段`].filter(Boolean).join(' · ')
    : `${value.category_path || ''} · ${value.record_count || 0} 条记录`;
  return `<article class="reference-card"><div class="section-heading"><span class="reference-caption">${caption}</span><button type="button" class="clear-button" data-reference="${key}" aria-label="查看${model ? '模型' : '数据集'}详情：${escapeHtml(title)}">查看详情</button></div><h4>${escapeHtml(title)}</h4><p class="reference-meta">${escapeHtml(metadata)}</p>${model ? '' : `<div class="dataset-dimensions">${datasetLabelBadges(value)}</div>`}<p class="description-summary">${escapeHtml(description.trim() ? descriptionSummary(description) : value.error || (model ? '暂无模型说明，可在模型中记录取数步骤或 SQL。' : '暂无数据集描述'))}</p>${value.note ? `<p class="security-note">${escapeHtml(value.note)}</p>` : ''}</article>`;
}
function bindReferenceCards(container, entries) {
  container.querySelectorAll('[data-reference]').forEach(button => button.addEventListener('click', () => {
    const entry = entries[button.dataset.reference];
    if (entry) openReferenceDetails(entry.kind, entry.value, entry.caption);
  }));
  container.querySelector('[data-retry-reference]')?.addEventListener('click', reloadReferenceCatalog);
}
function openReferenceDetails(kind, value, caption) {
  if (!state.unlocked || !state.canManage || !value) return;
  const model = kind === 'model', definition = model ? value.definition : value;
  state.referenceDetails = { kind, value };
  $('#reference-info-title').textContent = model ? value.name : datasetName(value);
  const summary = model
    ? `<div><dt>版本</dt><dd>${value.version ? `v${escapeHtml(value.version)}` : '未提供版本'}</dd></div><div><dt>主表 / 附表字段</dt><dd>${definition.fields?.length || 0} / ${definition.supplement_fields?.length || 0}</dd></div><div><dt>逻辑唯一 KEY</dt><dd>${escapeHtml(definition.identity_fields?.join(' + ') || '未设置')}</dd></div>`
    : `<div><dt>目录</dt><dd>${escapeHtml(value.category_path || '')}</dd></div><div><dt>标签</dt><dd>${datasetLabelBadges(value)}</dd></div><div><dt>记录 / 字段</dt><dd>${value.record_count || 0} / ${value.fields?.length || 0}</dd></div><div><dt>数据模型</dt><dd>${escapeHtml(value.schema_name || '独立模型')}${value.schema_version ? ` · v${escapeHtml(value.schema_version)}` : ''}</dd></div>`;
  $('#reference-info-content').innerHTML = `<p class="reference-caption">${escapeHtml(caption)}</p><dl class="dataset-info-summary">${summary}</dl><section class="reference-description"><h4>${model ? '模型说明 / 数据获取方法' : '数据集描述'}</h4>${value.description?.trim() ? `<div class="markdown-content">${renderMarkdown(value.description)}</div>` : `<p class="security-note">${escapeHtml(value.error || '暂无描述')}</p>`}</section>${value.note ? `<p class="security-note">${escapeHtml(value.note)}</p>` : ''}<details class="reference-fields"><summary>字段定义 · ${definition.fields?.length || 0}</summary>${schemaTable(definition)}</details>${model && definition.supplement_fields?.length ? `<details class="reference-fields"><summary>附表字段 · ${definition.supplement_fields.length}</summary>${schemaTable({ fields: definition.supplement_fields, identity_fields: [], list_fields: [] })}</details>` : ''}`;
  openDialog('reference-info-modal');
}
$('#close-reference-info').addEventListener('click', () => $('#reference-info-modal').close());
$('#reference-info-modal').addEventListener('close', () => { state.referenceDetails = null; $('#reference-info-content').replaceChildren(); $('#reference-info-title').textContent = '查看详情'; });

function renderEditorModelReference() {
  const container = $('#editor-model-reference');
  const dataset = state.datasets.find(item => item.id === state.editDatasetId);
  const selected = $('#dataset-schema').value;
  container.hidden = !state.canManage || $('#dataset-basic-fields').hidden || !dataset?.schema_id && !selected;
  if (container.hidden) { container.replaceChildren(); return; }
  const value = referencedModel(dataset?.schema_id ? dataset : { schema_id: selected });
  container.innerHTML = referenceCard('model', value, 'model', dataset?.schema_id ? '引用的数据模型' : '将引用的数据模型') + (state.referenceCatalogError ? '<button type="button" class="clear-button" data-retry-reference>重新加载模型说明</button>' : '');
  bindReferenceCards(container, { model: { kind: 'model', value, caption: '引用的数据模型' } });
}
function renderImportContext() {
  const container = $('#import-context');
  container.hidden = !state.canManage || !state.unlocked;
  if (container.hidden) { container.replaceChildren(); return; }
  const source = fileDatasetReference();
  const id = source ? $('#transfer-target').value : $('#import-dataset-select').value;
  const target = state.datasets.find(item => item.id === id);
  const entries = {};
  let html = '';
  if (target) {
    const model = referencedModel(target);
    entries.dataset = { kind: 'dataset', value: target, caption: '当前目标数据集' };
    entries.model = { kind: 'model', value: model, caption: '当前引用的数据模型' };
    html = `<h4 class="reference-group-title">${source ? '当前目标信息' : '目标信息'}</h4><div class="reference-grid">${referenceCard('dataset', target, 'dataset', '数据集')}${referenceCard('model', model, 'model', '数据模型')}</div>`;
  } else if (source) {
    const next = { ...source, category_path: $('#transfer-category').value || source.category_path, environments: [...state.transferEnvironmentDraft], record_count: 0 };
    const model = fileModelReference({ ...source, schema_name: source.schema_name || next.category_path });
    next.schema_name = model.name;
    next.note = `文件包含 ${source.record_count} 条记录，预览确认后导入。`;
    entries.dataset = { kind: 'dataset', value: next, caption: '将新建的数据集' };
    entries.model = { kind: 'model', value: model, caption: '将新建的独立数据模型' };
    html = `<h4 class="reference-group-title">将新建的数据集与模型</h4><div class="reference-grid">${referenceCard('dataset', next, 'dataset', '数据集')}${referenceCard('model', model, 'model', '数据模型')}</div>`;
  } else html = '<p class="security-note">请先选择目标数据集；原生数据集文件也可直接导入并新建数据集。</p>';
  if (source && target) {
    const model = fileModelReference(source);
    entries.source = { kind: 'dataset', value: source, caption: '文件中的数据集' };
    entries.sourceModel = { kind: 'model', value: model, caption: '文件中的模型说明' };
    html += `<details class="import-source-details"><summary>查看文件中的数据集与模型信息</summary><div class="reference-grid">${referenceCard('dataset', source, 'source', '文件中的数据集')}${referenceCard('model', model, 'sourceModel', '文件中的数据模型')}</div><p class="security-note">文件与目标的结构差异将在确认导入前列出；目标共享模型的说明保留。</p></details>`;
  }
  if (state.referenceCatalogError && target?.schema_id) html += '<p class="security-note">模型说明未能加载。<button type="button" class="clear-button" data-retry-reference>重新加载</button></p>';
  container.innerHTML = html;
  bindReferenceCards(container, entries);
}
async function reloadReferenceCatalog() {
  if (!state.canManage || !state.unlocked) return;
  const epoch = state.sessionEpoch;
  state.referenceCatalogError = null;
  try { await loadCatalog(); }
  catch (error) {
    if (state.unlocked && epoch === state.sessionEpoch) state.referenceCatalogError = '模型说明加载失败，请重试。';
  }
  if (state.unlocked && epoch === state.sessionEpoch && typeof document !== 'undefined') { renderEditorModelReference(); renderImportContext(); }
}

function datasetLabels(dataset) {
  return Array.isArray(dataset?.environments) ? dataset.environments : dataset?.environment ? [dataset.environment] : [];
}
function datasetLabelText(dataset) { return datasetLabels(dataset).join(' / ') || '未指定标签'; }
function selectedEnvironmentTags() { return state.environmentTags.length ? state.environmentTags : state.environment !== 'all' ? [state.environment] : []; }
function datasetMatchesLabels(dataset) { return selectedEnvironmentTags().every(label => datasetLabels(dataset).includes(label)); }
function datasetLabelBadges(dataset) { return datasetLabels(dataset).map(label => datasetDimensionBadge('environment', label)).join('') || datasetDimensionBadge('environment', null); }
environments = function() {
  return [...new Set(state.datasets.filter(datasetInCategoryScope).flatMap(datasetLabels))].sort();
};
datasetCandidates = function() {
  if (!selectedCategories().length) return [];
  return state.datasets.filter(dataset => datasetInCategoryScope(dataset) && datasetMatchesLabels(dataset));
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
    datasetMatchesLabels(dataset));
  return candidates.length === 1 ? candidates[0] : null;
}

function datasetDimensionBadge(kind, value) {
  const label = '标签';
  const text = escapeHtml(value || '未指定');
  return `<span class="tag dimension-badge ${kind}${value ? '' : ' unspecified'}" title="${label}：${text}" aria-label="${label}：${text}"><b>${text}</b></span>`;
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
  const source = singleDataset ? '' : `<div class="record-tags"><span>${escapeHtml(dataset ? datasetLocator(dataset) : record.category)}</span>${datasetLabelBadges(dataset || record)}</div>`;
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
  $('#search-scope-label').textContent = scopedDataset ? `${datasetLocator(scopedDataset)} · ${datasetLabelText(scopedDataset)}` : selectedCategories().length > 1 ? `${selectedCategories().length} 个目录` : '跨数据集查找';
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
  const labels = selectedEnvironmentTags();
  if (labels.length) params.set('environment_tags', JSON.stringify(labels));
  if (state.schemaFilter) params.set('schema_id', state.schemaFilter);
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
  showDescriptionEditor({ kind: 'dataset', id: target || state.editDatasetId || null, editor: !target, initial: target ? dataset.description || '' : $('#dataset-description').value });
}

function showDescriptionEditor(target) {
  state.descriptionTarget = { ...target, epoch: state.sessionEpoch };
  $('#description-edit-title').textContent = target.kind === 'model' ? '修改模型描述' : '修改数据集描述';
  $('#description-edit-context').textContent = target.kind === 'model'
    ? `${target.name} · ${target.editor ? '保存到模型草稿，随模型发布生效。' : '保存后所有引用此模型的数据集共用此描述。'}`
    : '描述仅属于此数据集，支持 Markdown 和 SQL 代码块。';
  $('#description-draft').value = target.initial;
  $('#description-draft').placeholder = target.kind === 'model' ? '记录用途、数据来源、提取步骤或 SQL…' : '记录此数据集的说明…';
  $('#description-error').hidden = true;
  $('#save-description').disabled = false;
  $('#description-preview-panel').open = false;
  $('#description-draft-preview').innerHTML = renderMarkdown(target.initial);
  openDialog('description-edit-modal');
}

function openModelDescription(id, editor = false) {
  if (!state.canManage) return;
  const model = state.catalog.schemas.find(item => item.id === id);
  if ((editor && !state.schemaDraft) || (!editor && !model)) return;
  showDescriptionEditor({ kind: 'model', id, editor, draft: editor ? state.schemaDraft : null,
    name: editor ? $('#shared-schema-name').value || '新数据模型' : model.name,
    initial: (editor ? state.schemaDraft.description : model.description) || '' });
}

function closeDescription(force = false) {
  if (!force && state.descriptionSaving) return;
  if (!force && state.descriptionTarget && $('#description-draft').value !== state.descriptionTarget.initial && !window.confirm('放弃未保存的描述修改？')) return;
  $('#description-edit-modal').close();
  $('#description-draft').value = ''; $('#description-draft-preview').replaceChildren();
  $('#description-edit-context').textContent = '';
  state.descriptionTarget = null;
}

async function saveDescription() {
  const target = state.descriptionTarget;
  if (!target || !state.canManage || state.descriptionSaving) return;
  const current = () => state.unlocked && state.sessionEpoch === target.epoch && state.descriptionTarget === target;
  const value = $('#description-draft').value;
  state.descriptionSaving = true; $('#save-description').disabled = true;
  try {
    if (target.kind === 'model') {
      if (target.editor) {
        if (state.schemaDraft !== target.draft) return;
        state.schemaDraft.description = value;
        updateModelDescriptionPreview();
      } else {
        const request = { schema_id: target.id, description: value };
        const preview = await api('/schemas/preview', { method: 'POST', body: JSON.stringify(request) });
        if (!current()) return;
        await api('/schemas/publish', { method: 'POST', body: JSON.stringify({ ...request, confirmation_token: preview.confirmation_token }) });
        if (!current()) return;
        await refreshAfterWrite();
        if (!current()) return;
        if (await loadCatalog() && current()) {
          renderCatalog(); renderSchemaView();
          if (state.managedDatasetId) renderManagedDataset();
          renderDatasetManager();
        }
      }
    } else {
      if (target.id) {
        await api(`/datasets/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: JSON.stringify({ description: value }) });
        if (!current()) return;
        const dataset = state.datasets.find(item => item.id === target.id);
        if (dataset) dataset.description = value;
      }
      if (target.editor) { $('#dataset-description').value = value; updateDatasetDescriptionPreview(); if (!target.id) state.editorDirty = true; }
      if (state.managedDatasetId === target.id) renderManagedDataset();
    }
    if (!current()) return;
    closeDescription(true);
    showToast(target.kind === 'model' && target.editor ? '描述已加入模型草稿' : target.id ? '描述已保存' : '描述已加入新数据集草稿', 'success');
  } catch (error) { if (current()) { $('#description-error').textContent = error.message; $('#description-error').hidden = false; } }
  finally { if (state.descriptionTarget === target || !state.descriptionTarget) { state.descriptionSaving = false; $('#save-description').disabled = false; } }
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
  const shared = state.datasets.find(dataset => dataset.id === datasetId);
  if (shared?.schema_id && ['fields', 'list'].includes(mode)) { openSharedSchemaEditor(shared.schema_id); return; }
  if (shared?.schema_id && mode === 'all') mode = 'basic';
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
  if (mode === 'basic') $('#dataset-help').textContent = '编辑名称、目录与标签，数据集描述可单独维护。';
  $('#save-dataset').textContent = mode === 'list' ? '保存展示规则' : mode === 'fields' ? '保存结构' : '保存数据集';
  state.editorDirty = false;
  loadDatasetDimensions(datasetId);
};

openDatasetEditor = function() {
  legacy.openDatasetEditor();
  updateDatasetNamePlaceholder();
  $('#dataset-description-preview-panel').open = false;
  if (!state.editDatasetId) {
    state.editorMode = 'all'; state.identifierEditing = false;
    $('#dataset-basic-fields').hidden = false; $('.dataset-description-editor').hidden = false;
    $('#schema-preview').hidden = true; state.editorDirty = false;
    loadDatasetDimensions(null);
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
    const name = $('#dataset-name').value.trim();
    if ([...name].length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) throw new Error('数据集名称最多 120 个字符，不能包含控制字符');
    let body = { name, category_path: category, ...readDatasetEnvironments() };
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
        state.environment = 'all'; state.environmentTags = [];
        state.selectedDatasetId = id;
      }
    } else {
      const result = await api('/datasets', { method: 'POST', body: JSON.stringify({ ...body, description: $('#dataset-description').value, schema_id: $('#dataset-schema').value || null, fields: [], identity_fields: [], conflict_strategy: 'allow_mark' }) });
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
  const labels = [...new Set(state.datasets.flatMap(datasetLabels))].sort();
  state.managerTags = state.managerTags.filter(label => labels.includes(label));
  $('#manager-environment').innerHTML = labelFilterButtons(labels, state.managerTags);
  $$('#manager-environment [data-environment]').forEach(button => button.addEventListener('click', () => {
    state.managerTags = toggleLabel(state.managerTags, button.dataset.environment);
    renderDatasetManager();
  }));
  const datasets = state.datasets.filter(dataset => (!$('#manager-schema').value || dataset.schema_id === $('#manager-schema').value) && state.managerTags.every(label => datasetLabels(dataset).includes(label)) && `${datasetLabelText(dataset)} ${dataset.name || ''} ${dataset.schema_name || ''} ${dataset.category_path} ${dataset.description || ''} ${(dataset.fields || []).map(field => `${field.source_key} ${field.display_name}`).join(' ')}`.toLowerCase().includes(filter));
  $('#dataset-manager-list').innerHTML = `<div class="dataset-table-header"><span>数据集 / 目录</span><span>标签</span><span>数据模型</span><span>记录</span><span>字段</span><span>逻辑唯一 KEY</span><span>操作</span></div>` + datasets.map(dataset => {
    const id = escapeHtml(dataset.id), path = escapeHtml(dataset.category_path);
    const action = (css, text) => `<button class="clear-button ${css}" data-dataset-id="${id}">${text}</button>`;
    const model = state.canManage && dataset.schema_id ? `<button class="dataset-model-button" data-dataset-id="${id}" title="查看数据模型">${escapeHtml(dataset.schema_name || '独立模型')}</button>` : `<span>${escapeHtml(dataset.schema_name || '独立模型')}</span>`;
    return `<div class="dataset-manager-row"><div class="dataset-manager-name"><button class="dataset-name-link dataset-records-button" data-dataset-id="${id}" title="查看此数据集的记录"><strong>${escapeHtml(datasetName(dataset))}</strong></button><span class="dataset-directory"><small>目录</small> ${path}</span></div><span class="dataset-row-labels">${datasetLabelBadges(dataset)}</span><div class="dataset-manager-model">${model}</div><button class="dataset-record-count dataset-records-button" data-dataset-id="${id}" title="查看记录">${dataset.record_count || 0}</button><button class="dataset-field-count dataset-fields-button" data-dataset-id="${id}" title="查看字段定义">${dataset.fields?.length || 0}</button><code class="dataset-key">${escapeHtml(dataset.identity_fields?.join(' + ') || '未设置')}</code><div class="row-actions dataset-row-actions">${action('dataset-manage-button', '信息')}${state.canManage ? `${action('dataset-edit-button', '编辑')}${action('dataset-import-button', '导入')}${action('dataset-new-record-button', '新增')}` : ''}${action('dataset-supplement-button', '附表')}${action('dataset-export-open', '导出')}</div></div>`;
  }).join('') + (!datasets.length ? '<p class="detail-empty">没有匹配的数据集</p>' : '');
  const bind = (selector, action) => $$(selector).forEach(button => button.addEventListener('click', () => action(button.dataset.datasetId)));
  bind('.dataset-manage-button', id => openManagedDataset(id, 'basic'));
  bind('.dataset-records-button', openDatasetRecords);
  bind('.dataset-fields-button', id => { const dataset = state.datasets.find(item => item.id === id); if (state.canManage && dataset?.schema_id) openSharedSchemaView(dataset.schema_id); else openManagedDataset(id, 'fields'); });
  bind('.dataset-model-button', id => openSharedSchemaView(state.datasets.find(item => item.id === id).schema_id));
  bind('.dataset-export-open', openExport); bind('.dataset-edit-button', openDatasetEdit);
  bind('.dataset-import-button', openImport); bind('.dataset-new-record-button', id => openManualRecord('main', id)); bind('.dataset-supplement-button', openSupplement);
};

async function openDatasetRecords(id) {
  const dataset = state.datasets.find(item => item.id === id);
  if (!dataset) return;
  state.category = dataset.category_path; state.categories = []; state.environment = 'all'; state.environmentTags = [];
  state.schemaFilter = ''; state.query = ''; $('#search-input').value = ''; state.selectedDatasetId = id; state.page = 1;
  showWorkspace('search'); renderDimensionFilters(); renderCategoryTree(); renderFilters(); renderIndexReference();
  try { await fetchRecords(); } catch (error) { showToast(error.message, 'error'); }
}

function openManagedDataset(id, tab = 'fields') {
  state.managedDatasetId = id; state.datasetTab = tab;
  renderManagedDataset(); showWorkspace('dataset');
  if (state.canManage) loadCatalog().then(loaded => { if (loaded && state.managedDatasetId === id && state.workspace === 'dataset') renderManagedDataset(); }).catch(error => { if (state.unlocked) showToast(error.message, 'error'); });
}

function schemaTable(dataset, fields = dataset.fields || []) {
  const keys = new Set(dataset.identity_fields || []);
  return `<div class="dataset-info-table-wrap"><table class="dataset-info-table"><thead><tr><th>源字段</th><th>显示名称</th><th>用途</th><th>唯一 KEY</th><th>列表展示</th><th>顺序</th></tr></thead><tbody>${fields.map(field => `<tr><td><code>${escapeHtml(field.source_key)}</code></td><td>${escapeHtml(field.display_name || field.source_key)}</td><td><span class="tag">${escapeHtml(fieldZones[field.zone] || field.zone)}</span></td><td>${keys.has(field.source_key) ? '是' : '—'}</td><td>${dataset.display_config?.identifier_fields?.includes(field.source_key) ? '记录标识' : dataset.list_fields?.find(item => item.source_key === field.source_key && item.visible !== false) ? { single_line: '单行', multiline: '多行', json: 'JSON' }[dataset.list_fields.find(item => item.source_key === field.source_key).format] || '单行' : '不展示'}</td><td>${(Number.isInteger(field.position) && field.position >= 0 ? field.position : 0) + 1}</td></tr>`).join('') || '<tr><td colspan="6">暂无字段，可在首次导入时定义结构。</td></tr>'}</tbody></table></div>`;
}

function renderManagedDataset() {
  const dataset = state.datasets.find(item => item.id === state.managedDatasetId);
  if (!dataset) return;
  $('#dataset-detail-heading').innerHTML = `<div class="workspace-heading"><div><p>${escapeHtml(dataset.category_path)}</p><h2>${escapeHtml(datasetName(dataset))}</h2><div class="dataset-dimensions">${datasetLabelBadges(dataset)}</div><span>${dataset.record_count || 0} 条记录 · ${dataset.fields.length} 个字段</span><p>${escapeHtml(dataset.schema_name || '独立模型')}${dataset.schema_version ? ` · v${dataset.schema_version}` : ''}</p></div><div class="heading-actions"><button id="managed-view-records" class="secondary-button">查看记录</button>${state.canManage ? '<button id="managed-import" class="secondary-button">导入…</button>' : ''}<button id="managed-export" class="secondary-button">导出…</button></div></div>`;
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
  if (state.datasetTab === 'basic') content = `<div class="section-heading"><h3>基本信息</h3>${state.canManage ? '<button id="managed-edit" class="secondary-button">修改基本信息</button>' : ''}</div><dl class="dataset-info-summary"><div><dt>名称</dt><dd>${escapeHtml(datasetName(dataset))}${dataset.name?.trim() ? '' : '<small class="security-note">（随目录末级名称显示）</small>'}</dd></div><div><dt>目录</dt><dd>${escapeHtml(dataset.category_path)}</dd></div><div><dt>标签</dt><dd>${datasetLabelBadges(dataset)}</dd></div><div><dt>数据模型</dt><dd>${state.canManage && dataset.schema_id ? `<button id="managed-model-details" class="clear-button">${escapeHtml(dataset.schema_name || '独立模型')}${dataset.schema_version ? ` · v${dataset.schema_version}` : ''}</button>` : escapeHtml(dataset.schema_name || '独立模型')}</dd></div><div><dt>逻辑唯一 KEY</dt><dd>${escapeHtml(dataset.identity_fields.join(' + ') || '未设置')}</dd></div><div><dt>重复处理</dt><dd>以逻辑 KEY 匹配；导入时选择更新或跳过</dd></div></dl>`;
  if (state.datasetTab === 'basic' && state.canManage && dataset.schema_id) {
    const model = state.catalog.schemas.find(item => item.id === dataset.schema_id);
    content += `<section class="dataset-model-note"><div class="section-heading"><h4>模型说明</h4><button id="managed-model-note" class="clear-button">编辑模型说明</button></div>${model?.description ? `<div class="markdown-content">${renderMarkdown(model.description)}</div>` : '<p class="security-note">可在模型中记录共用的数据来源、提取步骤或 SQL。</p>'}</section>`;
  }
  if (state.datasetTab === 'supplement') content = `<div class="section-heading"><h3>附表结构</h3><button id="managed-supplement" class="secondary-button">${state.canManage ? '管理附表' : '查看附表'}</button></div><p>附表与主记录一对一关联，主表导入不会覆盖附表。</p>${schemaTable({ ...dataset, identity_fields: [], list_fields: [] }, dataset.supplement_fields || [])}`;
  $('#dataset-detail-body').innerHTML = content;
  $('#managed-field-search')?.addEventListener('input', event => { $('#managed-fields').innerHTML = schemaTable(dataset, dataset.fields.filter(field => `${field.source_key} ${field.display_name}`.toLowerCase().includes(event.target.value.toLowerCase()))); });
  $$('#dataset-detail-tabs button').forEach(button => button.addEventListener('click', () => { state.datasetTab = button.dataset.datasetTab; renderManagedDataset(); $(`#dataset-tab-${state.datasetTab}`).focus(); }));
  $('#managed-model-details')?.addEventListener('click', () => openReferenceDetails('model', referencedModel(dataset), '引用的数据模型'));
  $('#managed-model-note')?.addEventListener('click', () => openModelDescription(dataset.schema_id));
  $('#managed-edit')?.addEventListener('click', () => openDatasetEdit(dataset.id, state.datasetTab));
  $('#managed-edit-description')?.addEventListener('click', () => openDescription(dataset.id));
  $('#managed-supplement')?.addEventListener('click', () => openSupplement(dataset.id));
  $('#managed-import')?.addEventListener('click', () => openImport(dataset.id));
  $('#managed-export').addEventListener('click', () => openExport(dataset.id));
  $('#managed-view-records').addEventListener('click', () => openDatasetRecords(dataset.id));
}

openDatasetInfo = function(id) {
  legacy.renderDatasetInfo(id);
  const dataset = state.datasets.find(item => item.id === id);
  const summary = $('#dataset-info-content .dataset-info-summary');
  if (summary && dataset?.schema_id) summary.insertAdjacentHTML('beforeend', `<div><dt>数据模型</dt><dd>${escapeHtml(dataset.schema_name || '')}</dd></div>`);
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
  const sourceDataset = state.datasets.find(item => item.id === state.recordDetail.dataset_id);
  if (sourceDataset) $('#record-detail-meta').textContent = `${datasetLocator(sourceDataset)} · ${datasetLabelText(sourceDataset)}${state.recordDetail.expired ? ' · 已过期' : ''}`;
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
  $('#export-target').textContent = `${datasetLocator(dataset)} · ${datasetLabelText(dataset)}`;
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
  $('#native-import-target').hidden = !state.transferPackage || step === 3;
  $('.import-file-row').hidden = step === 3;
  renderImportContext();
}

function resetImport() {
  state.transferPackage = null; state.transferRaw = null; state.importPreview = null; state.pendingBatchId = null;
  state.currentBatchSources = []; $('#mapping-list').replaceChildren();
  state.transferEnvironmentDraft = []; $('#transfer-environment').value = ''; renderTransferEnvironmentDraft();
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
  reloadReferenceCatalog();
};

importFile = async function(file) {
  if (!file || state.importBusy) return;
  resetImport();
  if (/\.json$/i.test(file.name)) {
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw);
      if (parsed?.format === 'securevault-dataset') {
        if (parsed.version !== 1 || !['schema', 'package'].includes(parsed.mode) || !parsed.schema || !Array.isArray(parsed.schema.fields) || (parsed.schema.supplement_fields !== undefined && !Array.isArray(parsed.schema.supplement_fields)) || (parsed.records !== undefined && !Array.isArray(parsed.records))) throw new Error('不支持的数据集文件版本或结构');
        state.transferPackage = parsed; state.transferRaw = raw;
        $('#transfer-skip').closest('label').hidden = parsed.mode === 'schema';
        $('#batch-summary').hidden = false;
        $('#batch-summary').textContent = `${file.name} · ${parsed.mode === 'schema' ? '仅结构' : '结构与数据'} · ${parsed.records?.length || 0} 条记录`;
        $('#transfer-target').innerHTML = '<option value="">新建数据集</option>' + state.datasets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(datasetLocator(item))} · ${escapeHtml(datasetLabelText(item))}</option>`).join('');
        $('#transfer-category').value = parsed.schema.category_path || '';
        state.transferEnvironmentDraft = [...datasetLabels(fileDatasetReference())]; renderTransferEnvironmentDraft();
        $('#transfer-schema-preview').innerHTML = `<h4>结构预览</h4>${parsed.schema.name ? `<p>数据集名称：${escapeHtml(parsed.schema.name)}</p>` : ''}${schemaTable({ ...parsed.schema, fields: parsed.schema.fields || [] })}`;
        if (parsed.templates?.length) $('#transfer-schema-preview').insertAdjacentHTML('beforeend', `<details class="transfer-templates"><summary>映射模板 · ${parsed.templates.length} 个</summary>${parsed.templates.map((template, index) => `<label>导入模板名称<input data-transfer-template-name="${index}" value="${escapeHtml(template.name)}" /></label>`).join('')}<p>若名称与已有模板冲突，可在这里修改，不影响记录值。</p></details>`);
        setImportStep(2); return;
      }
    } catch (error) {
      if (state.transferPackage || /不支持/.test(error.message)) { resetImport(); showToast(error.message, 'error'); return; }
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
  commitTransferEnvironmentInput();
  const request = { package: state.transferRaw || state.transferPackage, dataset_id: $('#transfer-target').value || null, category_path: $('#transfer-category').value.trim(), environments: [...state.transferEnvironmentDraft], skip_existing: $('#transfer-skip').checked, template_names: $$('[data-transfer-template-name]').map(input => input.value.trim()) };
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
    const target = transfer ? `${request.category_path} · ${datasetLabelText(request)}` : `${datasetLocator(dataset)} · ${datasetLabelText(dataset)}`;
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
    $('#import-result').innerHTML = `<h3>${structureOnly ? '结构已导入' : '导入完成'}</h3>${pending.transfer ? `<p>${escapeHtml(pending.request.category_path)} · ${escapeHtml(datasetLabelText(pending.request))}</p>` : ''}<p>${structureOnly ? `${pending.request.dataset_id ? '已更新结构，保留已有记录' : '已创建空数据集'} · ${pending.preview.field_count} 个字段` : `新增 ${result.imported || 0} 条 · 更新 ${result.updated || 0} 条 · 跳过 ${result.skipped || 0} 条${result.deleted_missing ? ` · 删除 ${result.deleted_missing} 条` : ''}`}</p><button id="import-finish" class="primary-button">返回数据集</button>`;
    $('#import-finish').addEventListener('click', () => pending.transfer ? openManagedDataset(result.dataset_id) : showWorkspace(state.importReturn));
    state.pendingBatchId = null; state.transferPackage = null; state.transferRaw = null; state.importPreview = null;
    $('#import-context').hidden = true;
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
  clearCatalogState();
  state.searchRequest++; state.workspaceRequest++; state.editorDirty = false; state.importPreview = null; state.transferPackage = null; state.transferRaw = null;
  state.descriptionTarget = null; state.exportDatasetId = null; state.categories = []; state.directoryDraft = [];
  state.scopeEditing = null; state.appViewing = null; state.appDetailBusy = null; state.apps = [];
  $('#app-details-content').replaceChildren(); $('#scope-name').value = '';
  $('#app-key-context').textContent = ''; $('#app-key-id').textContent = '';
  $('#app-scope-modal').close(); $('#scope-datasets').replaceChildren(); $('#app-manager-list').replaceChildren();
  for (const dialog of $$('dialog[open]')) dialog.close();
  $('#description-draft').value = ''; $('#description-draft-preview').replaceChildren(); $('#app-key-value').value = '';
  $('#dataset-name').value = ''; $('#dataset-name').placeholder = '留空时使用目录末级名称';
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
$('#manager-schema').addEventListener('change', renderDatasetManager);
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
  state.transferEnvironmentDraft = [...datasetLabels(dataset || fileDatasetReference())];
  $('#transfer-environment').value = ''; renderTransferEnvironmentDraft();
  renderImportContext();
});
for (const id of ['transfer-category', 'transfer-environment']) $('#' + id).addEventListener('input', renderImportContext);
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
function toggleLabel(selected, value) { return value === '' ? [] : selected.includes(value) ? selected.filter(label => label !== value) : [...selected, value]; }
function labelFilterButtons(labels, selected) {
  const button = (value, text, active) => `<button class="filter-chip ${active ? 'selected' : ''}" data-environment="${escapeHtml(value)}" aria-pressed="${active}">${escapeHtml(text)}</button>`;
  return button('', '全部标签', !selected.length) + labels.map(label => button(label, label, selected.includes(label))).join('');
}
renderFilters = function() {
  const selected = selectedEnvironmentTags();
  $('#environment-filters').innerHTML = labelFilterButtons(environments(), selected);
  $$('#environment-filters [data-environment]').forEach(button => button.addEventListener('click', async () => {
    state.environmentTags = toggleLabel(selectedEnvironmentTags(), button.dataset.environment);
    state.environment = state.environmentTags.length === 1 ? state.environmentTags[0] : 'all';
    state.selectedDatasetId = null; state.page = 1;
    try { await fetchRecords(); renderFilters(); renderIndexReference(); } catch (error) { showToast(error.message, 'error'); }
  }));
  const scope = $('#global-dataset-scope');
  scope.innerHTML = '<option value="">全部数据集</option>' + state.datasets.filter(dataset => (!state.schemaFilter || dataset.schema_id === state.schemaFilter) && datasetMatchesLabels(dataset)).map(dataset => `<option value="${escapeHtml(dataset.id)}">${escapeHtml(datasetLocator(dataset))} · ${escapeHtml(datasetLabelText(dataset))}</option>`).join('');
  scope.value = currentDataset()?.id || '';
};
const scopeLabel = document.createElement('label');
scopeLabel.className = 'dataset-scope-select';
scopeLabel.innerHTML = '<select id="global-dataset-scope" aria-label="数据集范围"><option value="">全部数据集</option></select>';
$('.filter-row').insertBefore(scopeLabel, $('#clear-filters'));
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

// Shared definitions and independent instance dimensions.
Object.assign(state, { catalog: { schemas: [], environments: [] }, schemaFilter: '', catalogTab: 'schemas', schemaDraft: null, schemaPublication: null, catalogBusy: false });
function dimensionOptions(items, selected, empty) {
  items = items.map(item => {
    if (!item.dataset_ids || items.filter(other => other.name === item.name).length < 2) return item;
    const instance = state.datasets.find(dataset => item.dataset_ids.includes(dataset.id));
    return { ...item, name: `${item.name} · ${instance ? datasetLabelText(instance) || instance.id.slice(-8) : item.id.slice(-8)}` };
  });
  return `<option value="">${empty}</option>` + items.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === selected ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('');
}
function renderDimensionFilters() {
  for (const [kind, property, label] of [['schema', 'schema_name', '模型']]) {
    const entries = [...new Map(state.datasets.filter(d => d[`${kind}_id`]).map(d => [d[`${kind}_id`], { id: d[`${kind}_id`], name: d[property] || d[`${kind}_id`] }])).values()];
    for (const prefix of ['manager', 'search']) {
      const select = $(`#${prefix}-${kind}`);
      const selected = prefix === 'search' ? state[`${kind}Filter`] : select.value;
      select.innerHTML = dimensionOptions(entries, selected, `全部${label}`);
      if (prefix === 'search' && selected && !entries.some(e => e.id === selected)) state[`${kind}Filter`] = '';
    }
  }
  for (const id of ['manage-schemas', 'manage-environments']) $(`#${id}`).hidden = !state.canManage;
}
async function loadCatalog() {
  const epoch = state.sessionEpoch;
  const result = await api('/catalog');
  if (!state.unlocked || epoch !== state.sessionEpoch || typeof document === 'undefined') return false;
  state.catalog = { schemas: result.schemas || [], environments: result.environments || [] };
  state.referenceCatalogLoaded = true; state.referenceCatalogError = null;
  renderEditorModelReference(); renderImportContext(); renderTransferEnvironmentDraft();
  return true;
}
function renderEnvironmentSuggestions() {
  const labels = [...new Set([...state.catalog.environments.map(item => item.name), ...state.datasets.flatMap(datasetLabels)])];
  $('#dataset-environment-options').innerHTML = labels.filter(label => !state.environmentDraft.includes(label)).map(label => `<option value="${escapeHtml(label)}"></option>`).join('');
}
function renderEnvironmentDraft() {
  $('#dataset-environment-tags').innerHTML = state.environmentDraft.map((label, index) => `<span class="selected-label" role="listitem"><span>${escapeHtml(label)}</span><button type="button" class="remove-label" data-label-index="${index}" aria-label="移除标签：${escapeHtml(label)}">×</button></span>`).join('');
  $$('#dataset-environment-tags button').forEach(button => button.addEventListener('click', () => {
    state.environmentDraft.splice(Number(button.dataset.labelIndex), 1); state.editorDirty = true;
    renderEnvironmentDraft(); $('#dataset-environment-select').focus();
  }));
  renderEnvironmentSuggestions();
}
function appendLabelInput(draft, value) {
  // An exact existing suggestion is one literal label. Other input supports batch entry.
  const known = [...draft, ...state.catalog.environments.map(item => item.name), ...state.datasets.flatMap(datasetLabels)];
  const labels = known.includes(value) ? [value] : value.split(/[,，;；\r\n]+/).map(label => label.trim()).filter(Boolean);
  for (const label of labels) {
    if (!known.includes(label) && ([...label].length > 120 || /[\p{Cc}]/u.test(label))) throw new Error('标签名称需为 1 至 120 个字符，不能包含控制字符');
  }
  const next = [...new Set([...draft, ...labels])];
  if (next.length > 64) throw new Error('最多添加 64 个标签');
  return next;
}
function commitEnvironmentInput() {
  const input = $('#dataset-environment-select');
  state.environmentDraft = appendLabelInput(state.environmentDraft, input.value);
  input.value = ''; renderEnvironmentDraft();
}
function renderTransferEnvironmentDraft() {
  $('#transfer-environment-tags').innerHTML = state.transferEnvironmentDraft.map((label, index) => `<span class="selected-label" role="listitem"><span>${escapeHtml(label)}</span><button type="button" class="remove-label" data-label-index="${index}" aria-label="移除标签：${escapeHtml(label)}">×</button></span>`).join('');
  $$('#transfer-environment-tags button').forEach(button => button.addEventListener('click', () => {
    state.transferEnvironmentDraft.splice(Number(button.dataset.labelIndex), 1);
    renderTransferEnvironmentDraft(); renderImportContext(); $('#transfer-environment').focus();
  }));
  const labels = [...new Set([...state.catalog.environments.map(item => item.name), ...state.datasets.flatMap(datasetLabels)])];
  $('#transfer-environment-options').innerHTML = labels.filter(label => !state.transferEnvironmentDraft.includes(label)).map(label => `<option value="${escapeHtml(label)}"></option>`).join('');
}
function commitTransferEnvironmentInput() {
  const input = $('#transfer-environment');
  state.transferEnvironmentDraft = appendLabelInput(state.transferEnvironmentDraft, input.value);
  input.value = ''; renderTransferEnvironmentDraft(); renderImportContext();
}
$('#add-transfer-environment').addEventListener('click', () => {
  try { commitTransferEnvironmentInput(); $('#transfer-environment').focus(); } catch (error) { showToast(error.message, 'error'); }
});
$('#transfer-environment').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); try { commitTransferEnvironmentInput(); } catch (error) { showToast(error.message, 'error'); } }
});
function readDatasetEnvironments() {
  commitEnvironmentInput();
  // Send names as the authoritative selection. The server reuses existing labels.
  return { environment_names: [...state.environmentDraft] };
}
async function loadDatasetDimensions(id) {
  const dataset = state.datasets.find(d => d.id === id);
  state.environmentDraft = [...datasetLabels(dataset)];
  $('#dataset-environment-select').value = ''; renderEnvironmentDraft();
  $('#dataset-schema').innerHTML = dimensionOptions(state.catalog.schemas, null, '新建独立模型');
  $('#dataset-schema').dataset.touched = '';
  $('#dataset-schema-label').hidden = Boolean(id);
  renderEditorModelReference();
  try {
    if (!await loadCatalog() || state.editDatasetId !== id) return;
    renderEnvironmentSuggestions();
    if (!$('#dataset-schema').dataset.touched) $('#dataset-schema').innerHTML = dimensionOptions(state.catalog.schemas, null, '新建独立模型');
  } catch (error) { if (state.unlocked && state.editDatasetId === id && typeof document !== 'undefined') { state.referenceCatalogError = '模型说明加载失败，请重试。'; renderEditorModelReference(); showToast(error.message, 'error'); } }
}
$('#add-dataset-environment').addEventListener('click', () => { try { commitEnvironmentInput(); state.editorDirty = true; $('#dataset-environment-select').focus(); } catch (error) { showToast(error.message, 'error'); } });
$('#dataset-environment-select').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); try { commitEnvironmentInput(); state.editorDirty = true; } catch (error) { showToast(error.message, 'error'); } }
});
$('#dataset-environment-select').addEventListener('input', () => { state.editorDirty = true; });
$('#dataset-schema').addEventListener('change', event => { event.target.dataset.touched = 'true'; renderEditorModelReference(); });
for (const kind of ['schema']) $('#search-' + kind).addEventListener('change', async event => {
  state[kind + 'Filter'] = event.target.value; state.selectedDatasetId = null; state.page = 1;
  try { await fetchRecords(); renderFilters(); renderIndexReference(); } catch (error) { showToast(error.message, 'error'); }
});
$('#clear-filters').addEventListener('click', () => { state.environmentTags = []; state.environment = 'all'; state.schemaFilter = ''; renderDimensionFilters(); });
async function openCatalog(tab = 'schemas') {
  if (!state.canManage) return;
  state.catalogTab = tab; $('#catalog-error').hidden = true;
  openDialog('catalog-modal');
  try { if (await loadCatalog()) renderCatalog(); }
  catch (error) { catalogError('catalog-error', error); }
}
function catalogError(id, error) { const node = $('#' + id); node.textContent = error.message; node.hidden = false; }
function renderCatalog() {
  const kind = state.catalogTab;
  const title = { schemas: '数据模型', environments: '标签' }[kind];
  $('#catalog-title').textContent = title;
  $('#catalog-name').hidden = kind === 'schemas';
  $('#catalog-create').textContent = `＋ 新建${title}`;
  $('#catalog-note').textContent = kind === 'schemas' ? '结构统一维护；数据、导入和应用授权按数据集实例独立管理。已有数据集需手动选择合并。' : '标签可在数据集中直接添加，保存时创建或复用。仍被引用的标签不能删除。';
  $$('[data-catalog-tab]').forEach(button => button.setAttribute('aria-selected', String(button.dataset.catalogTab === kind)));
  $('#catalog-list').innerHTML = state.catalog[kind].map(item => kind === 'schemas'
    ? `<article class="catalog-item"><div><button class="catalog-model-link" data-view-schema="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button><small>v${item.version} · ${item.definition.fields.length} 个字段 · ${item.dataset_ids.length} 个数据集</small><small>${escapeHtml(item.dataset_ids.slice(0, 3).map(id => { const d = state.datasets.find(dataset => dataset.id === id); return d ? [d.category_path, datasetLabelText(d)].filter(Boolean).join(' · ') : id; }).join('；'))}${item.dataset_ids.length > 3 ? '…' : ''}</small>${item.description ? `<details class="catalog-model-note"><summary>模型说明</summary><div class="markdown-content">${renderMarkdown(item.description)}</div></details>` : ''}</div><div class="row-actions"><button class="secondary-button" data-edit-schema="${escapeHtml(item.id)}">编辑模型</button><button class="secondary-button" data-merge-schema="${escapeHtml(item.id)}">合并数据集</button>${!item.dataset_ids.length ? `<button class="clear-button" data-delete-catalog="${escapeHtml(item.id)}">删除</button>` : ''}</div></article>`
    : `<article class="catalog-item"><label class="catalog-rename"><span class="sr-only">${title}名称</span><input value="${escapeHtml(item.name)}" maxlength="120" data-name-catalog="${escapeHtml(item.id)}" /></label><div class="row-actions"><button class="secondary-button" data-rename-catalog="${escapeHtml(item.id)}">保存名称</button><button class="clear-button" data-delete-catalog="${escapeHtml(item.id)}">删除</button></div></article>`).join('') || '<p class="detail-empty">暂无项目</p>';
  $$('[data-view-schema]').forEach(b => b.addEventListener('click', () => openSharedSchemaView(b.dataset.viewSchema)));
  $$('[data-edit-schema]').forEach(b => b.addEventListener('click', () => openSharedSchemaEditor(b.dataset.editSchema)));
  $$('[data-merge-schema]').forEach(b => b.addEventListener('click', () => openSchemaMerge(b.dataset.mergeSchema)));
  $$('[data-rename-catalog]').forEach(b => b.addEventListener('click', () => mutateCatalog(async () => {
    const input = [...$$('[data-name-catalog]')].find(i => i.dataset.nameCatalog === b.dataset.renameCatalog);
    await api(`/catalog/${kind}/${encodeURIComponent(b.dataset.renameCatalog)}`, { method: 'PATCH', body: JSON.stringify({ name: input.value }) });
  })));
  $$('[data-delete-catalog]').forEach(b => b.addEventListener('click', () => {
    const item = state.catalog[kind].find(item => item.id === b.dataset.deleteCatalog);
    if (!window.confirm(`删除${title}「${item?.name || ''}」？此操作无法撤销。`)) return;
    mutateCatalog(async () => {
      await api(kind === 'schemas' ? `/schemas/${encodeURIComponent(b.dataset.deleteCatalog)}` : `/catalog/${kind}/${encodeURIComponent(b.dataset.deleteCatalog)}`, { method: 'DELETE' });
    });
  }));
}
async function mutateCatalog(operation) {
  if (state.catalogBusy) return;
  const epoch = state.sessionEpoch;
  state.catalogBusy = true; $('#catalog-error').hidden = true;
  try {
    await operation();
    if (!state.unlocked || epoch !== state.sessionEpoch) return;
    await refreshAfterWrite();
    if (await loadCatalog()) renderCatalog();
    $('#catalog-name').value = '';
  } catch (error) { if (state.unlocked && epoch === state.sessionEpoch) catalogError('catalog-error', error); }
  finally { state.catalogBusy = false; }
}
$('#catalog-create').addEventListener('click', () => {
  if (state.catalogTab === 'schemas') { openSharedSchemaEditor(null); return; }
  mutateCatalog(() => api(`/catalog/${state.catalogTab}`, { method: 'POST', body: JSON.stringify({ name: $('#catalog-name').value }) }));
});
$$('[data-catalog-tab]').forEach(b => b.addEventListener('click', () => { state.catalogTab = b.dataset.catalogTab; $('#catalog-error').hidden = true; renderCatalog(); }));
for (const kind of ['schemas', 'environments']) $('#manage-' + kind).addEventListener('click', () => openCatalog(kind));
$('#close-catalog').addEventListener('click', () => $('#catalog-modal').close());

function sharedFieldRow(field, d, supplement = false) {
  const list = d.list_fields?.find(f => f.source_key === field.source_key);
  const publicField = ['indexes', 'display'].includes(field.zone || 'indexes');
  const label = (text, control, check = false) => `<label${check ? ' class="model-check"' : ''}><span class="model-control-caption">${text}</span>${control}</label>`;
  return `<div class="catalog-field-row${supplement ? ' supplement-field-row' : ''}" data-original="${escapeHtml(field.source_key || '')}" data-list-position="${list?.position ?? ''}" data-list-present="${Boolean(list)}">
    <span class="model-field-number" aria-hidden="true"></span>
    ${label('源字段', `<input class="shared-source" value="${escapeHtml(field.source_key || '')}" />`)}
    ${label('显示名称', `<input class="shared-label" value="${escapeHtml(field.display_name || '')}" />`)}
    ${label('用途', `<select class="shared-zone">${fieldZoneOptions(field.zone || 'indexes')}</select>`)}
    ${supplement ? '' : `${label('唯一 KEY', `<input type="checkbox" class="shared-key" ${field.zone === 'ignore' ? 'disabled' : ''} ${d.identity_fields?.includes(field.source_key) ? 'checked' : ''} />`, true)}${label('记录标识', `<input type="checkbox" class="shared-identifier" ${publicField ? '' : 'disabled'} ${d.display_config?.identifier_fields?.includes(field.source_key) ? 'checked' : ''} />`, true)}${label('列表展示', `<input type="checkbox" class="shared-visible" ${publicField ? '' : 'disabled'} ${publicField && (Array.isArray(d.list_fields) ? Boolean(list && list.visible !== false) : true) ? 'checked' : ''} />`, true)}${label('展示形式', `<select class="shared-format">${Object.entries({ single_line: '单行', multiline: '多行', json: 'JSON' }).map(([value, text]) => `<option value="${value}" ${list?.format === value ? 'selected' : ''}>${text}</option>`).join('')}</select>`)}`}
    <div class="row-actions"><button type="button" class="clear-button shared-up" aria-label="上移字段">↑</button><button type="button" class="clear-button shared-down" aria-label="下移字段">↓</button>${!field.source_key ? '<button type="button" class="clear-button shared-remove" aria-label="移除新增字段">×</button>' : ''}</div>
  </div>`;
}
function bindSharedFieldRow(row) {
  row.querySelector('.shared-remove')?.addEventListener('click', () => row.remove());
  row.querySelector('.shared-up').addEventListener('click', () => { if (row.previousElementSibling) row.parentElement.insertBefore(row, row.previousElementSibling); });
  row.querySelector('.shared-down').addEventListener('click', () => { if (row.nextElementSibling) row.parentElement.insertBefore(row.nextElementSibling, row); });
  row.querySelector('.shared-zone').addEventListener('change', () => {
    const zone = row.querySelector('.shared-zone').value;
    for (const selector of ['.shared-identifier', '.shared-visible']) { const input = row.querySelector(selector); if (input) { input.disabled = !['indexes', 'display'].includes(zone); if (input.disabled) input.checked = false; } }
    const key = row.querySelector('.shared-key'); if (key) { key.disabled = zone === 'ignore'; if (key.disabled) key.checked = false; }
  });
}
async function openSharedSchemaView(id) {
  if (!state.canManage) return;
  const epoch = state.sessionEpoch;
  try {
    if (!await loadCatalog() || epoch !== state.sessionEpoch) return;
    if (!state.catalog.schemas.some(model => model.id === id)) throw new Error('数据模型不存在，请刷新后重试');
    state.schemaViewId = id; state.schemaViewTab = 'fields';
    $('#schema-view-description-details').open = false;
    renderSchemaView(); openDialog('schema-view-modal');
  } catch (error) { if (state.unlocked && epoch === state.sessionEpoch) showToast(error.message, 'error'); }
}
function renderSchemaView() {
  const model = state.catalog.schemas.find(item => item.id === state.schemaViewId);
  if (!model || !state.canManage) return;
  const d = model.definition;
  $('#schema-view-title').textContent = model.name;
  $('#schema-view-scope').textContent = `v${model.version} · ${d.fields.length} 个字段 · ${model.dataset_ids.length} 个数据集引用`;
  $('#schema-view-description-summary').textContent = descriptionSummary(model.description);
  $('#schema-view-description').textContent = model.description?.trim() ? '修改描述' : '添加描述';
  $('#schema-view-description-details').hidden = !model.description?.trim();
  $('#schema-view-description-content').innerHTML = renderMarkdown(model.description || '');
  const tabs = { fields: '字段定义', list: '检索展示', supplement: '附表字段' };
  $('#schema-view-tabs').innerHTML = Object.entries(tabs).map(([key, label]) => `<button role="tab" id="model-tab-${key}" aria-controls="schema-view-content" aria-selected="${state.schemaViewTab === key}" tabindex="${state.schemaViewTab === key ? 0 : -1}" data-model-tab="${key}">${label}</button>`).join('');
  $('#schema-view-content').setAttribute('role', 'tabpanel');
  $('#schema-view-content').setAttribute('aria-labelledby', `model-tab-${state.schemaViewTab}`);
  let content = schemaTable(d);
  if (state.schemaViewTab === 'list') {
    const list = (d.list_fields || []).filter(field => field.visible !== false).sort((a, b) => (a.position || 0) - (b.position || 0));
    content = `<p class="security-note">以下默认规则共享给引用此模型的数据集。查询命中字段会临时前置，检索页可临时切换展示密度。</p><dl class="dataset-info-grid"><dt>记录标识</dt><dd>${escapeHtml(d.display_config?.identifier_fields?.join(' + ') || '使用公开逻辑 KEY 或系统 ID')}</dd><dt>默认密度</dt><dd>${d.display_config?.density === 'full' ? '完整' : '摘要'}</dd></dl><div class="dataset-info-table-wrap"><table class="dataset-info-table"><thead><tr><th>展示顺序</th><th>字段</th><th>展示形式</th></tr></thead><tbody>${list.map((field, i) => `<tr><td>${i + 1}</td><td>${escapeHtml(field.display_name || d.fields.find(f => f.source_key === field.source_key)?.display_name || field.source_key)} <code>${escapeHtml(field.source_key)}</code></td><td>${({ single_line: '单行', multiline: '多行', json: 'JSON' })[field.format] || '单行'}</td></tr>`).join('') || '<tr><td colspan="3">未配置列表展示字段</td></tr>'}</tbody></table></div>`;
  }
  if (state.schemaViewTab === 'supplement') content = schemaTable({ ...d, identity_fields: [], list_fields: [], display_config: {} }, d.supplement_fields || []);
  $('#schema-view-content').innerHTML = content;
  $$('[data-model-tab]').forEach(button => button.addEventListener('click', () => { state.schemaViewTab = button.dataset.modelTab; renderSchemaView(); }));
}
$('#close-schema-view').addEventListener('click', () => $('#schema-view-modal').close());
$('#schema-view-edit').addEventListener('click', () => { const id = state.schemaViewId; $('#schema-view-modal').close(); openSharedSchemaEditor(id); });
$('#schema-view-description').addEventListener('click', () => openModelDescription(state.schemaViewId));
async function openSharedSchemaEditor(id) {
  if (!state.canManage) return;
  const epoch = state.sessionEpoch;
  try {
    if (!await loadCatalog() || epoch !== state.sessionEpoch) return;
    const schema = id ? state.catalog.schemas.find(s => s.id === id) : null;
    if (id && !schema) throw new Error('结构不存在，请刷新后重试');
    state.schemaDraft = { id, description: schema?.description || '', originalDescription: schema?.description || '', version: schema?.version, originalOrder: schema?.definition.fields.map(f => f.source_key) || [] };
    const d = schema?.definition || { fields: [], identity_fields: [], list_fields: [], display_config: {}, supplement_fields: [] };
    $('#shared-schema-title').textContent = id ? '编辑数据模型' : '新建数据模型';
    $('#shared-schema-name').value = schema?.name || '';
    $('#shared-description-details').open = false;
    updateModelDescriptionPreview();
    $('#shared-schema-scope').textContent = `引用此模型的数据集：${schema?.dataset_ids.length || 0} 个。发布前将预览全部影响。`;
    $('#shared-density').value = d.display_config?.density || 'summary';
    $('#shared-main-fields').innerHTML = d.fields.map(f => sharedFieldRow(f, d)).join('');
    $('#shared-supplement-fields').innerHTML = d.supplement_fields.map(f => sharedFieldRow(f, d, true)).join('');
    $$('#shared-schema-modal .catalog-field-row').forEach(bindSharedFieldRow);
    state.schemaDraft.originalDefinitionDraft = JSON.stringify(readSharedDefinition());
    $('#shared-schema-error').hidden = true; openDialog('shared-schema-modal');
  } catch (error) { showToast(error.message, 'error'); }
}
function updateModelDescriptionPreview() {
  const description = state.schemaDraft?.description || '';
  $('#model-description-summary').textContent = descriptionSummary(description);
  $('#shared-edit-description').textContent = description.trim() ? '修改描述' : '添加描述';
  $('#shared-description-details').hidden = !description.trim();
  $('#shared-schema-description-preview').innerHTML = description.trim() ? renderMarkdown(description) : '';
}
$('#shared-edit-description').addEventListener('click', () => openModelDescription(state.schemaDraft?.id, true));
function readSharedDefinition() {
  const readFields = selector => [...$(selector).children].map((row, position) => {
    const source_key = row.querySelector('.shared-source').value.trim();
    return { source_key, previous_source_key: row.dataset.original && row.dataset.original !== source_key ? row.dataset.original : null, display_name: row.querySelector('.shared-label').value.trim(), zone: row.querySelector('.shared-zone').value, unique: row.querySelector('.shared-key')?.checked || false, position };
  });
  const fields = readFields('#shared-main-fields');
  const rows = [...$('#shared-main-fields').children];
  const identity_fields = fields.filter((f, i) => rows[i].querySelector('.shared-key').checked).map(f => f.source_key);
  const identifier_fields = fields.filter((f, i) => rows[i].querySelector('.shared-identifier').checked).map(f => f.source_key);
  const reordered = JSON.stringify(rows.map(row => row.dataset.original)) !== JSON.stringify(state.schemaDraft?.originalOrder || []);
  const list_fields = fields.flatMap((f, i) => ['indexes', 'display'].includes(f.zone) && (rows[i].dataset.listPresent === 'true' || rows[i].querySelector('.shared-visible').checked) ? [{ source_key: f.source_key, display_name: f.display_name, position: reordered ? i : Number(rows[i].dataset.listPosition || i), format: rows[i].querySelector('.shared-format').value, visible: rows[i].querySelector('.shared-visible').checked }] : []).sort((a, b) => a.position - b.position);
  return { fields, identity_fields, list_fields, display_config: { identifier_fields, density: $('#shared-density').value }, supplement_fields: readFields('#shared-supplement-fields') };
}
for (const kind of ['main', 'supplement']) $('#shared-add-' + kind).addEventListener('click', () => {
  const container = $('#shared-' + kind + '-fields');
  container.insertAdjacentHTML('beforeend', sharedFieldRow({}, {}, kind === 'supplement'));
  bindSharedFieldRow(container.lastElementChild); container.lastElementChild.querySelector('input').focus();
});
$('#preview-shared-schema').addEventListener('click', () => {
  const definition = readSharedDefinition();
  const unchanged = state.schemaDraft?.id && JSON.stringify(definition) === state.schemaDraft.originalDefinitionDraft;
  const description = state.schemaDraft?.description || '';
  const descriptionChanged = !state.schemaDraft?.id || description !== state.schemaDraft.originalDescription;
  previewSchemaOperation({ schema_id: state.schemaDraft?.id || null, name: $('#shared-schema-name').value, ...(descriptionChanged ? { description } : {}), ...(unchanged ? {} : { definition }) }, 'shared-schema-error');
});
$('#close-shared-schema').addEventListener('click', () => $('#shared-schema-modal').close());
function openSchemaMerge(id) {
  const schema = state.catalog.schemas.find(s => s.id === id);
  if (!schema) return;
  state.mergeSchemaId = id;
  $('#schema-merge-title').textContent = `合并到「${schema.name}」`;
  $('#schema-merge-note').textContent = '选择要引用此模型的已有数据集。数据集 ID、标签和应用授权保留；字段差异将在下一步预览。目标模型必须包含源数据集的全部字段。';
  $('#schema-merge-list').innerHTML = state.datasets.map(d => `<label class="app-dataset-option"><input type="checkbox" value="${escapeHtml(d.id)}" ${d.schema_id === id ? 'checked disabled' : ''} /><span><strong>${escapeHtml(datasetLocator(d))}</strong><small>${escapeHtml(datasetLabelText(d))} · ${escapeHtml(d.schema_name || '')}${d.schema_id === id ? '（已引用）' : ''}</small></span></label>`).join('');
  $('#schema-merge-search').value = ''; $('#schema-merge-error').hidden = true; openDialog('schema-merge-modal');
}
$('#schema-merge-search').addEventListener('input', event => {
  for (const row of $$('#schema-merge-list label')) row.hidden = !row.textContent.toLowerCase().includes(event.target.value.trim().toLowerCase());
});
$('#preview-schema-merge').addEventListener('click', () => {
  const ids = $$('#schema-merge-list input:checked:not(:disabled)').map(i => i.value);
  if (!ids.length) { catalogError('schema-merge-error', new Error('请至少选择一个待合并的数据集')); return; }
  previewSchemaOperation({ schema_id: state.mergeSchemaId, dataset_ids: ids }, 'schema-merge-error');
});
$('#close-schema-merge').addEventListener('click', () => $('#schema-merge-modal').close());
async function previewSchemaOperation(request, errorId) {
  if (state.schemaBusy || !state.canManage) return;
  const epoch = state.sessionEpoch;
  state.schemaBusy = true; $('#' + errorId).hidden = true;
  try {
    const preview = await api('/schemas/preview', { method: 'POST', body: JSON.stringify(request) });
    if (!state.unlocked || epoch !== state.sessionEpoch) return;
    state.schemaPublication = { request, token: preview.confirmation_token };
    $('#schema-preview-content').innerHTML = `<p>模型：${escapeHtml(request.name || state.catalog.schemas.find(s => s.id === request.schema_id)?.name || '')}</p>${request.description !== undefined ? `<details class="model-description-publication"><summary>本次模型说明${request.description.trim() ? '' : '（清空）'}</summary><div class="markdown-content">${renderMarkdown(request.description)}</div></details>` : ''}<p>涉及 ${preview.changes.length} 个数据集。记录与应用授权继续按数据集独立管理。</p>` + preview.changes.map(d => `<section class="catalog-impact"><h4>${escapeHtml(d.category_path)}</h4><p>${escapeHtml(datasetLabelText(d))} · ${d.record_count} 条主表 / ${d.supplement_count} 条附表</p><ul>${(d.changes.length ? d.changes : ['模型一致，保留数据并更新模型引用']).map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul></section>`).join('');
    $('#schema-preview-error').hidden = true; openDialog('schema-preview-modal');
  } catch (error) { if (state.unlocked && epoch === state.sessionEpoch) catalogError(errorId, error); }
  finally { state.schemaBusy = false; }
}
$('#publish-shared-schema').addEventListener('click', async () => {
  const publication = state.schemaPublication;
  if (!publication || state.schemaBusy || !state.canManage) return;
  const epoch = state.sessionEpoch;
  state.schemaBusy = true; $('#publish-shared-schema').disabled = true; $('#schema-preview-error').hidden = true;
  try {
    await api('/schemas/publish', { method: 'POST', body: JSON.stringify({ ...publication.request, confirmation_token: publication.token }) });
    if (!state.unlocked || epoch !== state.sessionEpoch) return;
    for (const id of ['schema-preview-modal', 'shared-schema-modal', 'schema-merge-modal']) $('#' + id).close();
    state.schemaPublication = null; state.schemaDraft = null;
    const supplementId = supplementState?.datasetId;
    await refreshAfterWrite(); if (await loadCatalog()) renderCatalog();
    if (supplementId && state.unlocked && epoch === state.sessionEpoch) await openSupplement(supplementId);
    showToast('数据模型已发布', 'success');
  } catch (error) { if (state.unlocked && epoch === state.sessionEpoch) catalogError('schema-preview-error', error); }
  finally { state.schemaBusy = false; $('#publish-shared-schema').disabled = false; }
});
$('#close-schema-preview').addEventListener('click', () => { $('#schema-preview-modal').close(); state.schemaPublication = null; });
function clearCatalogState() {
  state.catalog = { schemas: [], environments: [] }; state.schemaDraft = null; state.schemaPublication = null;
  state.schemaFilter = ''; state.mergeSchemaId = null;
  for (const id of ['catalog-list', 'shared-main-fields', 'shared-supplement-fields', 'schema-merge-list', 'schema-preview-content']) $('#' + id).replaceChildren();
  for (const id of ['catalog-name', 'shared-schema-name', 'schema-merge-search']) $('#' + id).value = '';
  $('#shared-schema-description-preview').replaceChildren(); $('#shared-description-details').open = false;
  state.schemaViewId = null; state.schemaViewTab = 'fields'; state.descriptionSaving = false;
  state.referenceCatalogLoaded = false; state.referenceCatalogError = null; state.referenceDetails = null;
  for (const id of ['import-context', 'editor-model-reference', 'reference-info-content']) { $('#' + id).replaceChildren(); $('#' + id).hidden = id !== 'reference-info-content'; }
  $('#reference-info-title').textContent = '查看详情';
  for (const id of ['schema-view-title', 'schema-view-scope', 'schema-view-description-summary', 'schema-view-description-content', 'schema-view-tabs', 'schema-view-content', 'model-description-summary', 'description-edit-context']) $('#' + id).replaceChildren();
  state.environmentDraft = []; state.transferEnvironmentDraft = []; state.environmentTags = []; state.managerTags = []; state.environment = 'all';
  $('#dataset-environment-select').value = ''; $('#dataset-environment-tags').replaceChildren(); $('#dataset-environment-options').replaceChildren();
  $('#transfer-environment').value = ''; $('#transfer-environment-tags').replaceChildren(); $('#transfer-environment-options').replaceChildren();
  for (const id of ['dataset-schema', 'manager-schema', 'search-schema', 'manager-environment', 'environment-filters', 'global-dataset-scope']) $('#' + id).replaceChildren();
}
