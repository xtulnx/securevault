// V2 workspaces reuse the storage, session and field editors in app.js.
Object.assign(state, {
  searchRequest: 0, workspaceRequest: 0, viewDensity: 'default', managedDatasetId: null,
  datasetTab: 'fields', editorMode: 'all', editorDirty: false,
  importStep: 1, importBusy: false, importLoading: false, importRequest: 0, transferPackage: null, importPreview: null,
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
  return { id: model?.id || dataset?.schema_id, name: model?.name || dataset?.schema_name || '独立模型', version: model?.version || dataset?.schema_version,
    description: model?.description ?? dataset?.schema_description ?? '', definition: model?.definition || dataset || {},
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
  const metadata = model ? `${definition.fields?.length || 0} 个字段`
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
  state.referenceDetails = { kind, value, returnFocus: referenceFocus(document.activeElement) };
  $('#reference-info-title').textContent = model ? `数据模型：${value.name}` : datasetName(value);
  if (model) {
    const editable = value.id && value.available && state.catalog.schemas.some(item => item.id === value.id);
    $('#reference-info-content').innerHTML = `<p class="reference-caption">${escapeHtml(caption)}</p><dl class="dataset-info-summary"><div><dt>逻辑唯一 KEY</dt><dd>${escapeHtml(definition.identity_fields?.join(' + ') || '未设置')}</dd></div></dl>${value.error ? `<p class="security-note">${escapeHtml(value.error)}</p>` : ''}${value.note ? `<p class="security-note">${escapeHtml(value.note)}</p>` : ''}${modelFieldsOverview(definition)}${infoDescription(value.description, '模型描述', 'reference-description') || '<section class="info-description reference-description"><h4>模型描述</h4><p class="security-note">暂无模型描述</p></section>'}${editable ? '<div class="model-reference-actions"><button type="button" class="secondary-button" data-reference-model-edit>编辑模型</button></div>' : ''}`;
    $('#reference-info-content [data-reference-model-edit]')?.addEventListener('click', () => {
      if (!state.unlocked || !state.canManage) return;
      $('#reference-info-modal').close(); openSharedSchemaEditor(value.id);
    });
  } else {
    $('#reference-info-content').innerHTML = `<p class="reference-caption">${escapeHtml(caption)}</p>${value.error ? `<p class="security-note">${escapeHtml(value.error)}</p>` : ''}${datasetInformation(value, { modelEdit: state.datasets.includes(value) && value.schema_id })}${value.note ? `<p class="security-note">${escapeHtml(value.note)}</p>` : ''}`;
  }
  $('#reference-info-content [data-info-model-edit]')?.addEventListener('click', () => {
    if (!state.unlocked || !state.canManage) return;
    $('#reference-info-modal').close(); openSharedSchemaEditor(value.schema_id);
  });
  openDialog('reference-info-modal');
}
$('#close-reference-info').addEventListener('click', () => $('#reference-info-modal').close());
$('#reference-info-modal').addEventListener('close', () => {
  const returnFocus = state.referenceDetails?.returnFocus;
  state.referenceDetails = null; $('#reference-info-content').replaceChildren(); $('#reference-info-title').textContent = '查看详情';
  if (state.unlocked && document.activeElement === document.body) restoreReferenceFocus(returnFocus);
});
function referenceFocus(element) {
  const root = element?.closest('#editor-model-reference, #import-context');
  return root && element.dataset.reference ? { root, key: element.dataset.reference } : null;
}
function restoreReferenceFocus(target) {
  if (!target?.root.isConnected || target.root.closest('[hidden], [inert]')) return;
  [...target.root.querySelectorAll('[data-reference]')].find(button => button.dataset.reference === target.key)?.focus({ preventScroll: true });
}

function renderEditorModelReference() {
  const container = $('#editor-model-reference');
  const dataset = state.datasets.find(item => item.id === state.editDatasetId);
  const selected = $('#dataset-schema').value;
  container.hidden = !state.canManage || $('#dataset-basic-fields').hidden || !dataset?.schema_id && !selected;
  if (container.hidden) { container.replaceChildren(); return; }
  const value = referencedModel(dataset?.schema_id ? dataset : { schema_id: selected });
  container.innerHTML = `<p class="edit-scope-note">名称、目录、标签和数据集描述仅对当前数据集生效；字段与展示规则由模型统一管理。</p><article class="reference-card definition-model-reference"><div><span class="reference-caption">${dataset?.schema_id ? '引用的数据模型' : '将引用的数据模型'}</span><strong>${escapeHtml(value.name)}</strong><small>${value.definition.fields?.length || 0} 个字段</small></div><p class="description-summary">${escapeHtml(value.description?.trim() ? descriptionSummary(value.description) : value.error || '暂无模型说明')}</p><button type="button" class="clear-button" data-reference="model" aria-label="查看模型详情：${escapeHtml(value.name)}">查看详情</button></article>${state.referenceCatalogError ? '<button type="button" class="clear-button" data-retry-reference>重新加载模型说明</button>' : ''}`;
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
  if (state.importStep > 1) {
    const expanded = container.querySelector('.import-target-details')?.open;
    const context = target ? `${datasetLocator(target)} · 模型：${target.schema_name || '独立模型'}` : `新建数据集：${$('#transfer-category').value || source?.category_path || ''}`;
    html = `<details class="import-target-details" ${expanded ? 'open' : ''}><summary>目标：${escapeHtml(context)} · 查看说明</summary>${html}</details>`;
  }
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
  return state.datasets.filter(dataset => datasetInCategoryScope(dataset) && datasetMatchesLabels(dataset) && (!state.schemaFilter || dataset.schema_id === state.schemaFilter));
};
currentDataset = function() {
  const selected = state.datasets.find(dataset => dataset.id === state.selectedDatasetId && datasetInCategoryScope(dataset) && datasetMatchesLabels(dataset) && (!state.schemaFilter || dataset.schema_id === state.schemaFilter));
  const candidates = datasetCandidates();
  return selected || (candidates.length === 1 ? candidates[0] : null);
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
    datasetInCategoryScope(dataset) && datasetMatchesLabels(dataset) && (!state.schemaFilter || dataset.schema_id === state.schemaFilter));
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
    ? `<button class="reveal-secrets-button" data-action="open-secrets" data-record="${escapeHtml(record.id)}">敏感字段</button>`
    : `<button class="detail-button" data-action="open-detail" data-record="${escapeHtml(record.id)}">查看详情</button>`;
  const expiryAction = state.canManage ? `<button class="expired-toggle" data-expired-record="${escapeHtml(record.id)}" data-expired="${record.expired}">${record.expired ? '恢复有效' : '标记过期'}</button>` : '';
  return `<article class="record-card ${singleDataset ? 'single-dataset' : ''} ${record.expired ? 'is-expired' : ''} ${state.recordDetail?.id === record.id ? 'selected' : ''}" data-record-id="${escapeHtml(record.id)}" tabindex="-1">
    <div class="record-head"><div class="record-title">${source}<h4><button class="record-open" data-action="open-detail" data-record="${escapeHtml(record.id)}" title="${escapeHtml(recordIdentity(record))}">${recordIdentity(record, true)}</button>${expired}</h4></div></div>
    <div class="record-display" data-density="${escapeHtml(density)}" ${ordered.length ? '' : 'hidden'}><div class="record-summary">${fields}</div><details class="more-fields" ${remaining.length ? '' : 'hidden'}><summary>展开其余 ${remaining.length} 个字段</summary><div class="more-field-values">${remaining.map(field).join('')}</div></details></div>
    <div class="record-secrets">${record.secret_count ? `<span class="secret-count">${record.secret_count} 个敏感字段</span>` : ''}<div class="record-actions">${primaryAction}${expiryAction}</div></div>
  </article>`;
};

renderRecords = function() {
  if (typeof renderSearchTools === 'function') renderSearchTools();
  legacy.renderRecords();
  fitRecordSummaries();
  renderSearchScope(); renderSearchEmptyState();
  const scopedDataset = singleDatasetInSearchScope();
  $('#search-workspace').classList.toggle('has-single-dataset-scope', Boolean(scopedDataset));
  $('#search-workspace').classList.toggle('has-directory-scope', selectedCategories().length > 0);
  $('#search-scope-label').textContent = scopedDataset ? `${datasetLocator(scopedDataset)} · ${datasetLabelText(scopedDataset)}` : selectedCategories().length > 1 ? `${selectedCategories().length} 个目录` : '跨数据集查找';
  $$('.record-card, .record-table-row').forEach(card => card.addEventListener('click', event => {
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

// Never discard an incomplete condition: doing so would silently broaden the query.
function queryInputIssue(query) {
  const terms = []; let term = '', quoted = false;
  for (const char of query) {
    if (char === '"') quoted = !quoted;
    else if (/\s/u.test(char) && !quoted) { if (term) terms.push(term); term = ''; }
    else term += char;
  }
  if (quoted) return '引号尚未闭合';
  if (term) terms.push(term);
  for (const term of terms) {
    const colon = term.indexOf(':');
    if (colon === 0) return '字段名尚未填写';
    let value = colon < 0 ? term : term.slice(colon + 1);
    const operator = value[0];
    if (['=', '^', '$', '~'].includes(operator)) value = value.slice(1);
    if (operator === '~') value = value.replace(/^\/+|\/+$/g, '');
    if (!value) return '条件值尚未填写';
  }
  return '';
}
function searchInputStatus(message, outcome) {
  state.searchOutcome = outcome;
  $('#search-error').hidden = true;
  $('#search-status').hidden = !message; $('#search-status').textContent = message;
  $('#records-grid').setAttribute('aria-busy', 'false');
  $('#records-grid').dataset.searchStale = String(Boolean(message));
  if (message) { $('#previous-page').disabled = true; $('#next-page').disabled = true; }
}
function pauseSearchInput() {
  clearTimeout(state.searchTimer); state.searchTimer = null;
  state.searchRequest++; state.searchController?.abort(); state.searchController = null;
  searchInputStatus('等待输入完成；当前保留上次检索结果。', 'waiting');
}
function queueSearchFromInput(event) {
  state.query = event.target.value; state.page = 1;
  pauseSearchInput(); renderSearchScope();
  if (!state.unlocked || state.searchComposing || event.isComposing) return;
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    if (state.unlocked && state.workspace === 'search') fetchRecords().catch(() => {});
  }, 500);
}

fetchRecords = async function() {
  clearTimeout(state.searchTimer); state.searchTimer = null;
  state.searchController?.abort(); state.searchController = null;
  renderSearchScope(); renderDatasetActions();
  const request = ++state.searchRequest;
  const issue = state.searchComposing ? '输入法正在输入' : queryInputIssue(state.query);
  if (issue) { searchInputStatus(`${issue}；当前保留上次检索结果。`, 'invalid'); return false; }
  const controller = new AbortController(); state.searchController = controller;
  state.searchOutcome = 'loading';
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
    const result = await api(`/records/search?${params}`, { signal: controller.signal });
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
    state.searchOutcome = 'success'; $('#records-grid').dataset.searchStale = 'false';
    renderRecords(); renderDatasetActions();
  } catch (error) {
    if (error.name === 'AbortError' || request !== state.searchRequest || !state.unlocked || query !== state.query) return false;
    if (error.code === 'invalid_search_query' || error.status === 400 && /^(search operator requires a value|invalid search regex:)/.test(error.message)) {
      searchInputStatus('查询格式尚未有效；请检查条件值或正则表达式。当前保留上次检索结果。', 'invalid');
      return false;
    }
    state.searchOutcome = 'error';
    $('#search-error span').textContent = error.message;
    $('#search-error').hidden = false;
    $('#empty-state').hidden = true;
    throw error;
  } finally {
    if (request === state.searchRequest) {
      if (state.searchOutcome !== 'invalid') status.hidden = true;
      $('#records-grid').setAttribute('aria-busy', 'false');
      state.searchController = null;
    }
  }
};

showWorkspace = function(page) {
  if (!workspaces[page]) return;
  if (page !== state.workspace) {
    if (state.workspace === 'editor' && !confirmDiscardChanges(state.editorDirty, '数据集修改', state.editorDirty && $('#save-dataset').disabled)) return;
    if (state.workspace === 'import' && !confirmDiscardChanges(hasImportDraft(), '导入配置', state.importBusy || state.importLoading)) return;
    if (!confirmDiscardChanges(manualRecordDirty(), '记录修改', manualEditState?.busy)) return;
    if (!confirmDiscardChanges(sharedSchemaDirty(), '模型修改', state.schemaBusy)) return;
    if (manualEditState) closeManualRecord(true);
    if ($('#shared-schema-modal').open) closeSharedSchemaEditor(true);
    if (state.workspace === 'import') resetImport();
  }
  if (state.workspace === 'search') state.searchScroll = window.scrollY;
  closeDatasetDownloads();
  if (page !== 'search') closeRecordDetail();
  if (state.workspace === 'security' && page !== 'security') clearPasswordChange();
  const previousWorkspace = state.workspace;
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
  if (page === 'search' && previousWorkspace !== 'search' && state.searchOutcome === 'waiting') queueSearchFromInput({ target: $('#search-input') });
  if (typeof applySearchLayout === 'function') applySearchLayout();
  if (page === 'apps' && typeof loadAuthorizationEvents === 'function') loadAuthorizationEvents();
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
    : target.editor ? '保存到当前编辑草稿，随数据集保存生效。支持 Markdown 和 SQL 代码块。' : '描述仅属于此数据集，支持 Markdown 和 SQL 代码块。';
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
  if (!force && !confirmDiscardChanges(Boolean(state.descriptionTarget && $('#description-draft').value !== state.descriptionTarget.initial), '描述修改', state.descriptionSaving)) return;
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
      if (target.id && !target.editor) {
        await api(`/datasets/${encodeURIComponent(target.id)}`, { method: 'PATCH', body: JSON.stringify({ description: value }) });
        if (!current()) return;
        const dataset = state.datasets.find(item => item.id === target.id);
        if (dataset) dataset.description = value;
      }
      if (target.editor) { $('#dataset-description').value = value; state.editorDirty = true; updateDatasetDescriptionPreview(); }
      if (state.managedDatasetId === target.id) renderManagedDataset();
    }
    if (!current()) return;
    closeDescription(true);
    if (!target.editor) showToast(target.id ? '描述已保存' : '描述已加入新数据集草稿', 'success');
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
  const titles = { all: '修改数据集', fields: '修改结构', list: '修改展示规则', basic: '修改此数据集' };
  $('#dataset-title').textContent = titles[mode];
  if (mode === 'basic') $('#dataset-help').textContent = `仅修改 ${datasetName(shared)} 的名称、目录、标签与描述。`;
  $('#save-dataset').textContent = mode === 'list' ? '保存展示规则' : mode === 'fields' ? '保存结构' : '保存数据集';
  state.editorDirty = false;
  loadDatasetDimensions(datasetId);
  beginDatasetDefinitionDraft();
};

openDatasetEditor = function() {
  state.datasetEditorTrigger = document.activeElement;
  legacy.openDatasetEditor();
  if (state.editorReturn === 'dataset') $('#close-dataset').textContent = '← 返回数据集详情';
  updateDatasetNamePlaceholder();
  $('#dataset-description-preview-panel').open = false;
  if (!state.editDatasetId) {
    state.editorMode = 'all'; state.identifierEditing = false;
    $('#dataset-basic-fields').hidden = false; $('.dataset-description-editor').hidden = false;
    $('#schema-preview').hidden = true; state.editorDirty = false;
    loadDatasetDimensions(null);
    beginDatasetDefinitionDraft();
  }
};

returnFromDatasetEditor = function() {
  const target = state.editorReturn, trigger = state.datasetEditorTrigger, datasetId = state.editDatasetId;
  showWorkspace(target);
  if (state.workspace === 'editor') return;
  state.editDatasetId = null; state.editorDirty = false;
  if (target === 'datasets') renderDatasetManager();
  if (target === 'dataset') renderManagedDataset();
  window.scrollTo({ top: state.editorReturnScroll || 0 });
  const root = document.getElementById(workspaces[target]), stops = overlayTabStops(root);
  const replacement = trigger?.id ? document.getElementById(trigger.id) : null;
  const row = $$('.dataset-manager-row').find(item => item.querySelector('[data-dataset-id]')?.dataset.datasetId === datasetId);
  const fallback = target === 'dataset' ? $('#managed-edit') : target === 'datasets' ? row?.querySelector('.dataset-more-actions summary') : $('[data-action="edit"]') || $('#search-input');
  [trigger, replacement, fallback].find(element => element && stops.includes(element))?.focus({ preventScroll: true });
  state.datasetEditorTrigger = null;
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
  const epoch = state.sessionEpoch;
  const current = () => state.unlocked && epoch === state.sessionEpoch;
  state.datasetSaving = true; $('#save-dataset').disabled = true;
  $('#dataset-edit-error').hidden = true;
  setFormBusy($('#dataset-modal'), true);
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
      if (state.editorMode === 'all' || state.editorMode === 'basic' && $('#dataset-description').value !== (old.description || '')) body.description = $('#dataset-description').value;
      await api(`/datasets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
      if (!current()) return;
      if (state.editorReturn === 'search') {
        state.category = body.category_path || old.category_path;
        state.environment = 'all'; state.environmentTags = [];
        state.selectedDatasetId = id;
      }
    } else {
      const result = await api('/datasets', { method: 'POST', body: JSON.stringify({ ...body, description: $('#dataset-description').value, schema_id: $('#dataset-schema').value || null, fields: [], identity_fields: [], conflict_strategy: 'allow_mark' }) });
      if (!current()) return;
      state.managedDatasetId = result.dataset_id;
    }
    state.editorDirty = false;
    await refreshAfterWrite();
    if (!current()) return;
    returnFromDatasetEditor();
    showToast(id ? '数据集已更新' : '数据集已创建', 'success');
  } catch (error) { if (current()) { $('#dataset-edit-error').textContent = error.message; $('#dataset-edit-error').hidden = false; $('#dataset-edit-error').focus(); } }
  finally { if (epoch === state.sessionEpoch) { state.datasetSaving = false; setFormBusy($('#dataset-modal'), false); $('#save-dataset').disabled = false; } }
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
    return `<div class="dataset-manager-row"><div class="dataset-manager-name"><button class="dataset-name-link dataset-records-button" data-dataset-id="${id}" title="查看此数据集的记录"><strong>${escapeHtml(datasetName(dataset))}</strong></button><span class="dataset-directory"><small>目录</small> ${path}</span></div><span class="dataset-row-labels">${datasetLabelBadges(dataset)}</span><div class="dataset-manager-model">${model}</div><button class="dataset-record-count dataset-records-button" data-dataset-id="${id}" title="查看记录">${dataset.record_count || 0}</button><button class="dataset-field-count dataset-fields-button" data-dataset-id="${id}" title="查看字段定义">${dataset.fields?.length || 0}</button><code class="dataset-key">${escapeHtml(dataset.identity_fields?.join(' + ') || '未设置')}</code><div class="row-actions dataset-row-actions">${action('dataset-records-button', '记录')}${action('dataset-manage-button', '管理')}<details class="dataset-more-actions action-disclosure"><summary aria-label="${escapeHtml(datasetName(dataset))} 的更多操作">更多</summary><div class="action-disclosure-content">${state.canManage ? `${action('dataset-edit-button', '修改此数据集')}${action('dataset-import-button', '导入')}${action('dataset-new-record-button', '新增记录')}` : ''}${action('dataset-supplement-button', '附表')}${action('dataset-export-open', '导出')}</div></details></div></div>`;
  }).join('') + (!datasets.length ? '<p class="detail-empty">没有匹配的数据集</p>' : '');
  wireActionDisclosures($('#dataset-manager-list'));
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


function sharedModelScope(id, name) {
  const schema = state.catalog.schemas.find(item => item.id === id);
  const ids = schema?.dataset_ids || state.datasets.filter(item => item.schema_id === id).map(item => item.id);
  return `<section class="shared-model-scope"><strong>引用模型：${escapeHtml(name || schema?.name || id)} · ${schema ? '共' : '当前可见'} ${ids.length} 个数据集使用</strong><p>字段、逻辑 KEY、列表展示和附表结构随模型发布，对所有引用数据集生效；记录、名称、目录和标签按数据集独立管理。</p><details><summary>查看引用数据集（${ids.length}）</summary><ul>${ids.map(datasetId => {
    const dataset = state.datasets.find(item => item.id === datasetId);
    return `<li>${escapeHtml(dataset ? `${datasetLocator(dataset)} · ${datasetLabelText(dataset)}` : datasetId)}</li>`;
  }).join('')}</ul></details></section>`;
}

function renderManagedDataset() {
  const dataset = state.datasets.find(item => item.id === state.managedDatasetId);
  if (!dataset) return;
  const model = state.canManage && state.catalog.schemas.find(item => item.id === dataset.schema_id);
  const modelDataset = model ? { ...dataset, schema_description: model.description } : dataset;
  $('#dataset-detail-workspace .workspace-panel').classList.add('model-information');
  $('#dataset-detail-heading').innerHTML = `<div class="workspace-heading"><h2>${escapeHtml(datasetName(dataset))}</h2><div class="heading-actions">${state.canManage ? '<button id="managed-edit" class="secondary-button">修改此数据集</button>' : ''}<button id="managed-view-records" class="secondary-button">查看记录</button>${state.canManage ? '<button id="managed-import" class="secondary-button">导入…</button>' : ''}<button id="managed-export" class="secondary-button">导出…</button></div></div>${datasetMetadata(dataset)}`;
  const description = descriptionText(dataset.description);
  $('#dataset-detail-description').hidden = !description && !state.canManage;
  $('#dataset-detail-description').classList.toggle('empty-description', !description);
  $('#dataset-detail-description').innerHTML = `<div class="section-heading"><strong>数据集描述</strong>${state.canManage ? `<button id="managed-edit-description" class="clear-button">${description ? '修改描述' : '添加描述'}</button>` : ''}</div>${description ? `<p class="description-summary">${escapeHtml(description)}</p><details><summary>展开全文</summary><div class="markdown-content">${renderMarkdown(dataset.description)}</div></details>` : ''}`;
  $('#dataset-detail-tabs').replaceChildren(); $('#dataset-detail-tabs').hidden = true;
  $('#dataset-detail-body').removeAttribute('role'); $('#dataset-detail-body').removeAttribute('aria-labelledby');
  $('#dataset-detail-body').innerHTML = datasetModelInformation(modelDataset, { modelEdit: state.canManage && dataset.schema_id });
  const modelEdit = $('#dataset-detail-body [data-info-model-edit]');
  if (modelEdit) {
    modelEdit.id = 'managed-edit-model'; modelEdit.textContent = '修改共享模型';
    modelEdit.addEventListener('click', () => openSharedSchemaEditor(dataset.schema_id));
  }
  const modelDescription = $('#dataset-detail-body .dataset-model-description') || document.createElement('section');
  if (state.canManage && dataset.schema_id) {
    modelDescription.classList.add('dataset-model-description', 'info-description');
    if (!modelDescription.isConnected) { modelDescription.innerHTML = '<h4>数据模型描述</h4><p class="security-note">暂无模型描述</p>'; $('#dataset-detail-body .dataset-model-info').append(modelDescription); }
    const heading = document.createElement('div'); heading.className = 'section-heading';
    heading.append(modelDescription.querySelector('h4'));
    heading.insertAdjacentHTML('beforeend', `<button id="managed-model-note" class="clear-button">${modelDataset.schema_description?.trim() ? '修改描述' : '添加描述'}</button>`);
    modelDescription.prepend(heading);
    $('#managed-model-note').addEventListener('click', () => openModelDescription(dataset.schema_id));
  }
  $('#dataset-detail-body .dataset-model-fields:last-of-type .dataset-field-heading').insertAdjacentHTML('beforeend', `<button id="managed-supplement" class="clear-button">${state.canManage ? '管理附表数据' : '查看附表数据'}</button>`);
  $('#managed-edit')?.addEventListener('click', () => openDatasetEdit(dataset.id, 'basic'));
  $('#managed-edit-description')?.addEventListener('click', () => openDescription(dataset.id));
  $('#managed-supplement')?.addEventListener('click', () => openSupplement(dataset.id));
  $('#managed-import')?.addEventListener('click', () => openImport(dataset.id));
  $('#managed-export').addEventListener('click', () => openExport(dataset.id));
  $('#managed-view-records').addEventListener('click', () => openDatasetRecords(dataset.id));
}

function infoDescription(description, title, className) {
  if (!description?.trim()) return '';
  return `<section class="${className} info-description"><h4>${title}</h4><p class="description-summary">${escapeHtml(descriptionSummary(description))}</p><details><summary>展开全文</summary><div class="markdown-content">${renderMarkdown(description)}</div></details></section>`;
}

function effectiveModelList(definition) {
  const publicFields = (definition.fields || []).filter(field => ['indexes', 'display'].includes(field.zone));
  return (definition.list_fields?.length ? definition.list_fields : publicFields)
    .filter(field => field.visible !== false && publicFields.some(item => item.source_key === field.source_key))
    .sort((a, b) => (a.position || 0) - (b.position || 0));
}

function modelFieldsOverview(definition) {
  const list = effectiveModelList(definition), keys = new Set(definition.identity_fields || []);
  const identifiers = (definition.display_config?.identifier_fields || []).filter(key => (definition.fields || []).some(field => field.source_key === key && ['indexes', 'display'].includes(field.zone)));
  const table = (fields, supplement = false) => {
    const title = supplement ? '附表字段' : '主表字段';
    const rows = [...fields].sort((a, b) => (a.position || 0) - (b.position || 0));
    return `<section class="dataset-model-fields" aria-label="${title}"><div class="dataset-field-heading"><h5>${title}</h5>${supplement ? '' : `<p class="dataset-info-note">默认${definition.display_config?.density === 'full' ? '完整' : '摘要'} · 记录标识：${escapeHtml(identifiers.join(' + ') || '使用公开逻辑 KEY 或系统 ID')}</p>`}</div><div class="dataset-info-table-wrap" role="region" aria-label="${title}表格" tabindex="0"><table class="dataset-info-table"><thead><tr><th scope="col">序号</th><th scope="col">源字段</th><th scope="col">显示名称</th><th scope="col">用途</th>${supplement ? '' : '<th scope="col">唯一 KEY</th><th scope="col">检索展示</th>'}</tr></thead><tbody>${rows.map((field, index) => {
      const position = list.findIndex(item => item.source_key === field.source_key), item = list[position];
      const display = position < 0 ? '—' : ({ single_line: '单行', multiline: '多行', json: 'JSON' })[item.format] || '单行';
      const displayDetail = position < 0 ? '不展示' : `检索列表第 ${position + 1} 项，${display}`;
      return `<tr><td>${index + 1}</td><td><code>${escapeHtml(field.source_key)}</code></td><td>${escapeHtml(field.display_name || field.source_key)}</td><td><span class="tag">${escapeHtml(fieldZones[field.zone] || field.zone)}</span></td>${supplement ? '' : `<td>${keys.has(field.source_key) ? '是' : '—'}</td><td title="${displayDetail}" aria-label="${displayDetail}">${display}</td>`}</tr>`;
    }).join('') || `<tr><td colspan="${supplement ? 4 : 6}">${supplement ? '尚未定义附表字段' : '尚未定义主表字段'}</td></tr>`}</tbody></table></div></section>`;
  };
  return table(definition.fields || []) + table(definition.supplement_fields || [], true);
}

function datasetMetadata(dataset) {
  const cell = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<dl class="dataset-info-summary">${cell('目录路径', escapeHtml(dataset.category_path || ''))}${cell('标签', `<span class="dataset-dimensions">${datasetLabelBadges(dataset)}</span>`)}${cell('记录数量', `${dataset.record_count || 0} 条`)}${cell('重复处理', escapeHtml(dataset.conflict_strategy === 'allow_mark' || !dataset.conflict_strategy ? '允许导入并标记重复' : dataset.conflict_strategy))}</dl>`;
}
function datasetModelInformation(dataset, { modelEdit = false, headingId = '' } = {}) {
  return `<section class="dataset-model-info"><div class="dataset-info-model-heading"><h4${headingId ? ` id="${headingId}"` : ''} class="info-section-title">数据模型：${escapeHtml(dataset.schema_name || '独立模型')}</h4>${modelEdit ? '<button type="button" class="clear-button" data-info-model-edit>编辑模型</button>' : ''}</div><dl class="dataset-info-summary"><div><dt>逻辑唯一 KEY</dt><dd>${escapeHtml(dataset.identity_fields?.join(' + ') || '未设置')}</dd></div></dl><div${headingId ? ' id="dataset-info-model-content"' : ''}>${modelFieldsOverview(dataset)}</div>${infoDescription(dataset.schema_description, '数据模型描述', 'dataset-model-description')}</section>`;
}
function datasetInformation(dataset, options = {}) {
  return `<section class="dataset-instance-info">${datasetMetadata(dataset)}${infoDescription(dataset.description, '数据集描述', 'dataset-description-section')}</section>${datasetModelInformation(dataset, options)}`;
}

openDatasetInfo = function(id) {
  const dataset = state.datasets.find(item => item.id === id);
  if (!dataset) return;
  // Effective model snapshots also work for viewers without management catalog access.
  $('#dataset-info-title').textContent = datasetName(dataset);
  $('#dataset-info-content').innerHTML = datasetInformation(dataset, { modelEdit: state.canManage && dataset.schema_id, headingId: 'dataset-model-title' });
  $('#dataset-info-content [data-info-model-edit]')?.addEventListener('click', () => {
    if (!state.unlocked || !state.canManage) return;
    $('#dataset-info-modal').close(); openSharedSchemaEditor(dataset.schema_id);
  });
  closeDatasetDownloads();
  $('#dataset-info-modal').showModal();
  $('#dataset-info-modal').scrollTop = 0;
};
$('#dataset-info-modal').addEventListener('close', () => { $('#dataset-info-title').textContent = '数据集信息'; });

refreshAfterWrite = async function() {
  await legacy.refreshAfterWrite();
  if (state.workspace === 'datasets') renderDatasetManager();
  if (state.workspace === 'dataset') renderManagedDataset();
};

openSecrets = async function(id) { await openRecordDetail(id); if (state.recordDetail?.id === id) selectDetailTab('secrets'); };

openRecordDetail = async function(id) {
  clearCopyFeedback($('#record-detail-content'));
  $('#record-detail-modal').classList.toggle('docked', window.innerWidth >= 1360 && state.workspace === 'search');
  const previous = state.recordDetail, request = state.detailLoadRequest + 1;
  await legacy.openRecordDetail(id);
  if (state.recordDetail === previous || state.recordDetail?.id !== id || request !== state.detailLoadRequest) return;
  state.detailTab = 'overview';
  renderRecordDetailStructure();
  $('#record-detail-title').textContent = recordIdentity(state.recordDetail);
  const sourceDataset = state.datasets.find(item => item.id === state.recordDetail.dataset_id);
  $('#record-detail-meta').innerHTML = `${sourceDataset ? `<button type="button" class="record-dataset-link" title="查看数据集信息">${escapeHtml(datasetName(sourceDataset))}</button><span class="record-detail-path">${escapeHtml(sourceDataset.category_path)}</span>` : `<span>${escapeHtml(state.recordDetail.category || '')}</span>`}<span class="dataset-dimensions">${sourceDataset ? datasetLabelBadges(sourceDataset) : ''}</span>${state.recordDetail.expired ? '<span class="tag expired-tag">已过期</span>' : ''}`;
  $('#record-detail-meta .record-dataset-link')?.addEventListener('click', () => openDatasetInfo(sourceDataset.id));
  const tabs = { overview: '概览', ...(state.recordDetail.protected_fields?.length ? { secrets: '敏感字段' } : {}), ...(state.canManage || state.recordDetail.supplement_records?.length ? { supplement: '附表' } : {}) };
  $('#record-detail-tabs').innerHTML = Object.entries(tabs).map(([tab, label]) => `<button id="record-tab-${tab}" data-detail-tab="${tab}" role="tab" aria-controls="record-detail-content" aria-selected="${tab === state.detailTab}" tabindex="${tab === state.detailTab ? 0 : -1}">${label}</button>`).join('');
  $$('#record-detail-tabs button').forEach(button => button.addEventListener('click', () => selectDetailTab(button.dataset.detailTab)));
  $('#record-detail-modal').classList.add('detail-workspace');
  document.body.classList.add('detail-open');
  setDetailMode(); selectDetailTab('overview');
  $$('.record-card, .record-table-row').forEach(card => card.classList.toggle('selected', card.dataset.recordId === id));
};

function renderRecordDetailStructure() {
  const detail = state.recordDetail, root = $('#record-detail-content');
  const actions = $('#record-detail-actions');
  actions.replaceChildren();
  const edit = root.querySelector('#manual-edit-main'), remove = root.querySelector('#manual-delete-main');
  if (edit) { edit.textContent = '编辑记录'; actions.append(edit); }
  if (remove) { remove.textContent = '删除记录'; remove.classList.add('record-delete-action'); actions.append(remove); }
  root.querySelector(':scope > .row-actions')?.remove();
  const values = { ...(detail.indexes || {}), ...(detail.display || {}), ...(detail.normal || {}) };
  const dataset = state.datasets.find(item => item.id === detail.dataset_id);
  // Model order is stable across list density and source JSON key order. Unknown legacy fields remain visible.
  const keys = [...new Set([...(dataset?.fields || []).filter(field => ['indexes', 'display', 'normal'].includes(field.zone)).sort((a, b) => (a.position || 0) - (b.position || 0)).map(field => field.source_key), ...Object.keys(values)])];
  const visibleKeys = keys.filter(key => Object.hasOwn(values, key));
  const overview = document.createElement('section'); overview.className = 'detail-section'; overview.dataset.detailSection = 'overview';
  overview.innerHTML = `<h4 class="sr-only">主表字段</h4>${visibleKeys.length ? visibleKeys.map(key => detailRows({ [key]: values[key] }, detail.labels)).join('') : '<p class="detail-empty">此记录暂无公开字段，可按需查看敏感字段或附表。</p>'}`;
  const sections = [...root.querySelectorAll(':scope > .detail-section')];
  sections.slice(0, 3).forEach(section => section.remove());
  root.prepend(overview);
  for (const [index, tab] of ['secrets', 'supplement'].entries()) {
    const section = sections[index + 3]; if (!section) continue;
    section.dataset.detailSection = tab;
    section.querySelector('h4').classList.add('sr-only');
  }
  root.scrollTop = 0;
}

function selectDetailTab(tab) {
  if (state.detailTab !== tab) clearCopyFeedback($('#record-detail-content'));
  if (!$$('#record-detail-tabs button').some(button => button.dataset.detailTab === tab)) tab = 'overview';
  if (tab !== 'secrets') { state.reveal = null; state.detailRevealRequest++; renderDetailSecrets(); }
  state.detailTab = tab;
  for (const section of $$('#record-detail-content > .detail-section')) {
    const sectionTab = section.dataset.detailSection || ({ '受保护字段': 'secrets', '附表扩展数据': 'supplement' })[section.querySelector('h4')?.textContent] || 'overview';
    section.hidden = sectionTab !== tab;
  }
  $('#record-detail-actions').hidden = !state.canManage || tab !== 'overview';
  $('#record-detail-actions details')?.removeAttribute('open');
  $('#record-detail-content').scrollTop = 0;
  const sections = $$('#record-detail-content .detail-section');
  sections.forEach(section => section.classList.remove('first-visible-section'));
  sections.find(section => !section.hidden)?.classList.add('first-visible-section');
  $$('#record-detail-tabs button').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.detailTab === tab));
    button.tabIndex = button.dataset.detailTab === tab ? 0 : -1;
  });
  $('#record-detail-content').setAttribute('role', 'tabpanel');
  $('#record-detail-content').setAttribute('aria-labelledby', `record-tab-${tab}`);
}

function setDetailMode() {
  const docked = window.innerWidth >= 1360 && state.workspace === 'search' && Boolean(state.recordDetail);
  $('#record-detail-modal').classList.toggle('docked', docked);
  $('#record-detail-modal .detail-dialog').setAttribute('aria-modal', String(!docked));
  document.body.classList.toggle('detail-docked', docked);
  if (typeof applySearchLayout === 'function') applySearchLayout();
  scheduleRecordLayout();
}

closeRecordDetail = function() {
  clearCopyFeedback();
  legacy.closeRecordDetail();
  $('#record-detail-actions').replaceChildren();
  $('#record-detail-actions').hidden = true;
  $('#record-detail-meta').replaceChildren();
  $('#record-detail-tabs').replaceChildren();
  document.body.classList.remove('detail-open', 'detail-docked');
  if (typeof applySearchLayout === 'function') applySearchLayout();
  scheduleRecordLayout();
  $$('.record-card.selected, .record-table-row.selected').forEach(card => card.classList.remove('selected'));
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
        try { await copyText(revealed.value); showToast('字段已复制', 'success'); } catch { showToast('剪贴板不可用', 'error'); }
      }); actions.append(button);
    }
  }
};

function openExport(id) {
  const dataset = state.datasets.find(item => item.id === id);
  if (!dataset) return;
  clearExportText();
  $('input[name="export-destination"][value="file"]').checked = true;
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
  const textOutput = $('input[name="export-destination"]:checked').value === 'text';
  $('#export-format option[value="xlsx"]').disabled = textOutput;
  if (textOutput && $('#export-format').value === 'xlsx') $('#export-format').value = 'json';
  $('#export-format').disabled = content !== 'data';
  if (content !== 'data') $('#export-format').value = 'json';
  $('#export-secret-wrap').hidden = content === 'schema';
  $('#export-record-scope-wrap').hidden = content === 'schema';
  $('#export-supplement-wrap').hidden = content !== 'package';
  $('#export-template-wrap').hidden = content === 'data';
  $('#export-content-note').textContent = { schema: '包含字段用途、唯一 KEY、描述、展示规则及附表结构，不含记录值。', data: '只导出记录，不携带完整结构。', package: '原生数据集包可同时迁移结构与记录。未导出的机密值会保留缺省状态。' }[content]
    + (textOutput ? ' 生成的文本可全选、复制，最多展示 2 MiB；XLSX 需下载文件。' : '')
    + ($('#export-format').value === 'toml' ? ' TOML 使用 [[records]]，不支持 null 或超出 64 位有符号范围的整数。' : '');
  $('#confirm-export').textContent = content === 'schema' ? '导出结构' : content === 'package' ? '导出结构与数据' : $('#export-with-secrets').checked ? '导出含机密的数据' : '导出数据';
  if (textOutput) $('#confirm-export').textContent = $('#export-with-secrets').checked && content !== 'schema' ? '生成含机密的文本' : '生成文本';
}

async function transferResponse(response, fallback, readJson = true, current = () => state.unlocked) {
  if (response.ok) return readJson ? response.json() : response;
  const body = await response.json().catch(() => ({}));
  if (current() && (response.status === 401 || response.status === 423)) await sealVault('会话已失效，请重新解锁', false);
  throw new Error(body.error || (response.status === 413 ? '内容超过请求大小限制，请缩小批次后重试' : `${fallback} (${response.status})`));
}

async function readExportText(response, current) {
  const limit = 2 * 1024 * 1024;
  const tooLarge = () => new Error('文本超过 2 MiB 展示上限，请缩小数据范围或选择下载文件');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new Blob([text]).size > limit) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0, complete = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (!current()) return '';
      if (done) { complete = true; break; }
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function downloadExport() {
  const id = state.exportDatasetId;
  if (!id || state.exportBusy) return;
  const generation = state.exportRequest = (state.exportRequest || 0) + 1, epoch = state.sessionEpoch;
  const current = () => state.unlocked && state.sessionEpoch === epoch && state.exportDatasetId === id && state.exportRequest === generation;
  const controller = new AbortController(); state.exportController = controller;
  const textOutput = $('input[name="export-destination"]:checked').value === 'text';
  $('#export-error').hidden = true;
  $('#export-text').value = ''; $('#export-text-result').hidden = true;
  state.exportBusy = true; $('#confirm-export').disabled = true;
  const content = $('input[name="export-content"]:checked').value;
  const format = content === 'data' ? $('#export-format').value : 'json';
  const params = new URLSearchParams({ content, format, include_expired: String($('#export-record-scope').value === 'all'), include_secrets: String(content !== 'schema' && $('#export-with-secrets').checked), include_templates: String(content !== 'data' && $('#export-templates').checked), include_supplements: String(content === 'package' && $('#export-supplements').checked) });
  try {
    const response = await fetch(`/api/datasets/${encodeURIComponent(id)}/export?${params}`, { signal: controller.signal });
    if (!current()) return;
    await transferResponse(response, '导出失败', false, current);
    if (textOutput) {
      const text = await readExportText(response, current);
      if (!current()) return;
      const size = new Blob([text]).size;
      if (size > 2 * 1024 * 1024) throw new Error('文本超过 2 MiB 展示上限，请缩小数据范围或选择下载文件');
      $('#export-text').value = text;
      $('#export-text-summary').textContent = `${format.toUpperCase()} · ${text.length.toLocaleString()} 字符 · ${(size / 1024).toFixed(1)} KiB${params.get('include_secrets') === 'true' ? ' · 包含机密字段' : ''}${text ? '' : ' · 当前范围无记录'}`;
      $('#export-copy-status').textContent = '';
      $('#export-text-result').hidden = false;
      $('#export-text').focus();
      return;
    }
    const blob = await response.blob();
    if (!current()) return;
    if (!await saveDownload(blob, `securevault-${id}${content === 'schema' ? '.schema' : content === 'package' ? '.dataset' : ''}.${format}`)) return;
    if (!current()) return;
    $('#export-modal').close(); $('#export-with-secrets').checked = false; state.exportDatasetId = null;
    showToast('数据集已导出', 'success');
  } catch (error) { if (current()) { $('#export-error').textContent = error.message; $('#export-error').hidden = false; } }
  finally { if (current()) { state.exportBusy = false; state.exportController = null; $('#confirm-export').disabled = false; } }
}

function clearExportText() {
  state.exportController?.abort(); state.exportController = null;
  state.exportRequest = (state.exportRequest || 0) + 1;
  state.exportBusy = false;
  $('#confirm-export').disabled = false;
  $('#export-text').value = ''; $('#export-text-result').hidden = true;
  $('#export-text-summary').textContent = ''; $('#export-copy-status').textContent = '';
  $('#export-error').hidden = true; $('#export-error').textContent = '';
}

async function copyExportText() {
  if (!state.unlocked || $('#export-text-result').hidden) return;
  const request = state.exportRequest, epoch = state.sessionEpoch;
  try {
    await copyText($('#export-text').value);
    if (state.unlocked && request === state.exportRequest && epoch === state.sessionEpoch) $('#export-copy-status').textContent = '已复制全部文本';
  } catch {
    if (state.unlocked && request === state.exportRequest && epoch === state.sessionEpoch) {
      $('#export-copy-status').textContent = '无法访问剪贴板，已全选文本，请手动复制';
      $('#export-text').focus(); $('#export-text').select();
    }
  }
}

function clearImportText() {
  $('#import-text').value = ''; $('#import-text-format').value = 'auto';
  $('#import-text-error').hidden = true; $('#import-text-error').textContent = '';
  updateImportTextCount();
}

function updateImportTextCount() {
  const text = $('#import-text').value, bytes = new Blob([text]).size;
  $('#import-text-count').textContent = `${text.length.toLocaleString()} 字符 · ${text ? text.split('\n').length.toLocaleString() : 0} 行 · ${(bytes / 1024).toFixed(1)} / 1024 KiB`;
  $('#parse-import-text').disabled = !text.trim() || bytes > 1024 * 1024 || state.importLoading || state.importBusy;
  $('#parse-import-text').textContent = state.pendingBatchId || state.transferPackage ? '重新解析文本' : '解析文本';
}

function clearImportSelection() {
  state.importSourceFile = null; state.importSheets = [];
  $('#import-node-path').value = ''; $('#import-sheet').replaceChildren();
}

function applyImportSelection(batch) {
  state.importSheets = batch.sheets || [];
  $('#import-sheet').innerHTML = (batch.selection_required ? '<option value="">请选择工作表</option>' : '') + state.importSheets.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (batch.sheet) $('#import-sheet').value = batch.sheet;
  renderImportSource();
}

function renderImportSelection() {
  const text = $('input[name="import-source"]:checked').value === 'text';
  const file = state.importSourceFile;
  const tabular = text ? $('#import-text-format').value === 'csv' : /\.(xlsx|xls|csv)$/i.test(file?.name || '');
  $('#import-record-selection').hidden = state.importStep === 3 || Boolean(state.transferPackage);
  $('#import-node-path-wrap').hidden = tabular; $('#import-node-path-help').hidden = tabular;
  $('#import-sheet-wrap').hidden = text || !(state.importSheets?.length);
  $('#import-reparse-file-wrap').hidden = text || !file;
  $('#import-selected-file').textContent = file?.name || '';
  $('#reparse-import-file').disabled = state.importLoading || state.importBusy || Boolean(state.importSheets?.length > 1 && !$('#import-sheet').value);
}

function renderImportSource() {
  const text = $('input[name="import-source"]:checked').value === 'text';
  $('#import-source-switch').hidden = state.importStep === 3;
  $('#import-text-panel').hidden = !text || state.importStep === 3;
  $('#choose-file').hidden = text;
  $('.import-file-row').hidden = state.importStep === 3 || (text && !state.pendingBatchId && !state.transferPackage);
  updateImportTextCount(); renderImportSelection();
}

function invalidateImportText() {
  if (state.pendingBatchId || state.transferPackage || state.importPreview || state.importLoading) resetImport(true);
  $('#import-text-error').hidden = true;
  updateImportTextCount(); renderImportSelection();
}

async function parseImportText() {
  if (!state.unlocked || state.importLoading || state.importBusy) return;
  const text = $('#import-text').value, format = $('#import-text-format').value;
  const nodePath = format === 'csv' ? '' : $('#import-node-path').value.trim();
  resetImport(true);
  const generation = state.importRequest, epoch = state.sessionEpoch;
  const current = () => state.unlocked && generation === state.importRequest && epoch === state.sessionEpoch;
  state.importLoading = true; setFormBusy($('#import-modal'), true);
  $('#import-text-error').hidden = true;
  try {
    if (!text.trim()) throw new Error('请先粘贴需要导入的文本');
    if (new Blob([text]).size > 1024 * 1024) throw new Error('粘贴文本最多支持 1 MiB，请缩小批次或使用文件导入');
    if (['auto', 'json'].includes(format)) {
      let native = false;
      try { native = JSON.parse(text.replace(/^\uFEFF/, ''))?.format === 'securevault-dataset'; } catch {}
      if (native && $('#import-node-path').value.trim()) throw new Error('原生数据集包使用完整根节点，请清空记录节点');
      if (native && loadNativeText(text, '粘贴文本 · JSON 数据集包')) return;
    }
    const datasetId = $('#import-dataset-select').value;
    if (!datasetId) throw new Error('请先创建或选择目标数据集');
    const batch = await api('/imports/text', { method: 'POST', body: JSON.stringify({ text, format, node_path: nodePath }) });
    if (!current()) return;
    await configureImportBatch(batch, datasetId, current);
    if (!current()) return;
    $('#batch-summary').textContent = `粘贴文本 · ${batch.format.toUpperCase()}${nodePath ? ` · 节点：${nodePath}` : ''} · ${batch.record_count} 条 · ${batch.source_fields.length} 个源字段`;
    labelSchemaControls($('#first-schema-fields')); setImportStep(2);
  } catch (error) {
    if (current()) {
      state.pendingBatchId = null; state.transferPackage = null; state.transferRaw = null; setImportStep(1);
      $('#import-text-error').textContent = error.message; $('#import-text-error').hidden = false; $('#import-text-error').focus();
    }
  } finally {
    if (current()) { state.importLoading = false; setFormBusy($('#import-modal'), false); updateImportTextCount(); renderImportSelection(); }
  }
}

function clearImportSamples() {
  state.importSampleRequest = (state.importSampleRequest || 0) + 1;
  clearTimeout(state.importSampleTimer); state.importSampleTimer = null;
  $$('[data-sample-result]').forEach(node => node.replaceChildren());
  $$('[data-preview-sample]').forEach(button => { button.disabled = false; });
}
async function previewMappingSample(row, reveal = false) {
  if (!state.unlocked || !state.pendingBatchId || state.importBusy || state.importLoading) return;
  clearImportSamples();
  const serial = state.importSampleRequest, generation = state.importRequest, epoch = state.sessionEpoch, batch = state.pendingBatchId;
  const current = () => state.unlocked && epoch === state.sessionEpoch && generation === state.importRequest && serial === state.importSampleRequest && batch === state.pendingBatchId && row.isConnected;
  const output = row.querySelector('[data-sample-result]'), button = row.querySelector('[data-preview-sample]');
  button.disabled = true; output.textContent = '正在检查样例…';
  try {
    const samples = await api(`/imports/${encodeURIComponent(batch)}/samples`, { method: 'POST', body: JSON.stringify({ source_key: row.querySelector('[data-map-source]').dataset.mapSource, json_path: row.querySelector('[data-map-path]').value.trim() || null, reveal }) });
    if (!current()) return;
    output.replaceChildren();
    const info = document.createElement('p'); info.textContent = `前 ${samples.rows.length} 条 / 共 ${samples.record_count} 条。${reveal ? '样例值将在 30 秒后隐藏。' : '样例值默认隐藏。'}`; output.append(info);
    const display = value => !value?.present ? '（不存在）' : value.masked ? `••••（${value.type}）` : `${value.type === 'string' && value.text === '' ? '""（空字符串）' : value.text}${value.truncated ? '…（已截断）' : ''}`;
    for (const item of samples.rows) {
      const sample = document.createElement('section'); sample.className = 'mapping-sample-row';
      const title = document.createElement('strong'); title.textContent = `第 ${item.row} 条 · ${item.message}`;
      const before = document.createElement('pre'), after = document.createElement('pre');
      before.textContent = `原始值：${display(item.before)}`; after.textContent = `抽取后：${display(item.after)}`;
      sample.append(title, before, after); output.append(sample);
    }
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'clear-button';
    toggle.textContent = reveal ? '立即隐藏样例值' : '查看样例值（30 秒）';
    toggle.addEventListener('click', () => { if (reveal) { clearImportSamples(); output.textContent = '样例值已隐藏'; } else previewMappingSample(row, true); });
    output.append(toggle);
    if (reveal) state.importSampleTimer = setTimeout(() => { if (current()) { clearImportSamples(); output.textContent = '样例值已自动隐藏'; } }, 30000);
  } catch (error) { if (current()) output.textContent = error.message; }
  finally { if (current()) button.disabled = false; }
}
function clearImportDiagnostics() {
  state.importDiagnostics = null;
  if (state.importReportUrl) URL.revokeObjectURL(state.importReportUrl);
  state.importReportUrl = null;
  $('#import-diagnostics').replaceChildren(); $('#import-diagnostics').hidden = true;
}
function renderImportDiagnostics(report, request, transfer) {
  const context = { report, request, transfer, page: 0 };
  state.importDiagnostics = context;
  drawImportDiagnostics(context);
}
function drawImportDiagnostics(context) {
  if (state.importDiagnostics !== context) return;
  const { report, transfer } = context, panel = $('#import-diagnostics');
  panel.replaceChildren(); panel.hidden = false;
  const heading = document.createElement('h4'); heading.textContent = '批量检查报告';
  const summary = document.createElement('p'); summary.setAttribute('role', 'status');
  summary.textContent = `已检查 ${report.checked_rows} 条记录 · ${report.error_count} 项错误 · ${report.warning_count} 项提醒。${report.error_count ? '请修复错误后重新预检，尚未写入任何记录。' : '预检通过；请核对提醒后再确认导入。'}${report.truncated ? `报告仅保留前 ${report.issue_limit} 项，计数覆盖全部记录。` : ''}`;
  const help = document.createElement('small'); help.textContent = '记录从 1 开始编号，不含 CSV / XLSX 表头；原生包的主表、附表分别编号。报告不包含记录值。' + (transfer ? '' : '普通导入更新匹配记录时，未写入的旧字段值会被清除；跳过已存在的 KEY 可保留整条旧记录。');
  panel.append(heading, summary, help);
  const start = context.page * 20, end = Math.min(start + 20, report.issues.length);
  for (const issue of report.issues.slice(start, end)) {
    const item = document.createElement('article'); item.className = 'import-issue';
    const text = document.createElement('p');
    const scope = { records: '主表', supplements: '附表', templates: '模板' }[issue.scope] || issue.scope;
    text.textContent = `${issue.severity === 'error' ? '错误' : '提醒'} · ${scope}第 ${issue.row} 条 · ${issue.message}`;
    const location = document.createElement('code'); location.textContent = [issue.source_key, issue.target_key && `→ ${issue.target_key}`, issue.json_path && `路径 ${issue.json_path}`].filter(Boolean).join(' ') || issue.code;
    item.append(text, location);
    if (!transfer && issue.source_key) {
      const locate = document.createElement('button'); locate.type = 'button'; locate.className = 'clear-button'; locate.textContent = '定位字段';
      locate.addEventListener('click', () => {
        if (state.importStep === 3) { state.importPreview = null; setImportStep(2); }
        const control = $$('[data-map-source]').find(select => select.dataset.mapSource === issue.source_key);
        if (!control) return;
        const row = control.closest('.mapping-row'); row.hidden = false; row.querySelector('details').open = true;
        (issue.json_path ? row.querySelector('[data-map-path]') : control).focus();
      }); item.append(locate);
    }
    panel.append(item);
  }
  if (report.issues.length) {
    const nav = document.createElement('div'); nav.className = 'import-report-actions';
    for (const [label, delta] of [['上一页', -1], ['下一页', 1]]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'clear-button'; button.textContent = label;
      button.disabled = delta < 0 ? context.page === 0 : end === report.issues.length;
      button.addEventListener('click', () => { context.page += delta; drawImportDiagnostics(context); }); nav.append(button);
    }
    const range = document.createElement('span'); range.textContent = `${start + 1}–${end} / ${report.issues.length} 项`;
    nav.append(range); panel.append(nav);
  }
  const download = document.createElement('button'); download.type = 'button'; download.className = 'secondary-button'; download.textContent = '下载 CSV 检查报告';
  const error = document.createElement('p'); error.className = 'inline-error'; error.setAttribute('role', 'alert'); error.hidden = true;
  download.addEventListener('click', async () => {
    const epoch = state.sessionEpoch, generation = state.importRequest;
    const current = () => state.unlocked && epoch === state.sessionEpoch && generation === state.importRequest && state.importDiagnostics === context;
    download.disabled = true; error.hidden = true;
    try {
      const blob = await api(`${transfer ? '/datasets/transfer/report' : '/records/import/report'}?format=csv`, { method: 'POST', body: JSON.stringify(context.request), responseType: 'blob' });
      if (!current()) return;
      if (window.__SECUREVAULT_DESKTOP__) { await saveDownload(blob, 'securevault-import-report.csv'); return; }
      const url = URL.createObjectURL(blob); state.importReportUrl = url;
      const link = document.createElement('a'); link.href = url; link.download = 'securevault-import-report.csv'; link.click();
      setTimeout(() => { URL.revokeObjectURL(url); if (state.importReportUrl === url) state.importReportUrl = null; }, 0);
    } catch (failure) { if (current()) { error.textContent = failure.message; error.hidden = false; } }
    finally { if (current()) download.disabled = false; }
  });
  panel.append(download, error);
}

function setImportStep(step) {
  clearImportSamples();
  state.importStep = step;
  $$('#import-steps li').forEach(item => {
    const active = Number(item.dataset.step) === step;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
  });
  $('#batch-options').hidden = step !== 2 || Boolean(state.transferPackage);
  $('#transfer-options').hidden = step !== 2 || !state.transferPackage;
  $('#import-confirmation').hidden = step !== 3;
  $('#ordinary-import-target').hidden = Boolean(state.transferPackage) || step === 3;
  $('#native-import-target').hidden = !state.transferPackage || step === 3;
  $('.import-file-row').hidden = step === 3;
  renderImportSource();
  renderImportContext();
}

function hasImportDraft() {
  return Boolean(state.pendingBatchId || state.transferPackage || state.importPreview || $('#import-text').value || state.importSourceFile);
}

function resetImport(preserveText = false) {
  if (!preserveText) { clearImportText(); clearImportSelection(); }
  clearImportDiagnostics(); clearImportSamples();
  state.importRequest++;
  state.importLoading = false; state.importBusy = false;
  setFormBusy($('#import-modal'), false);
  state.transferPackage = null; state.transferRaw = null; state.importPreview = null; state.pendingBatchId = null;
  state.currentBatchSources = []; $('#mapping-list').replaceChildren();
  $('#mapping-summary')?.remove(); clearImportConfigErrors();
  state.importTemplates = [];
  $('#mapping-template').value = ''; $('#mapping-template-select').replaceChildren();
  $('#first-schema-fields').replaceChildren(); $('#first-schema').hidden = true;
  state.importTarget = state.unlocked ? $('#import-dataset-select').value : null;
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
  const origin = state.workspace;
  if (origin === 'import' && !confirmDiscardChanges(hasImportDraft(), '导入配置', state.importBusy || state.importLoading)) return;
  showWorkspace('import');
  if (state.workspace !== 'import') return;
  state.importReturn = origin === 'import' ? state.importReturn : origin === 'dataset' ? 'dataset' : origin === 'search' ? 'search' : 'datasets';
  datasetOptions();
  const preferred = typeof id === 'string' ? id : currentDataset()?.id;
  if (preferred) $('#import-dataset-select').value = preferred;
  resetImport();
  reloadReferenceCatalog();
};

function loadNativeText(raw, label) {
  raw = raw.replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw);
  if (parsed?.format !== 'securevault-dataset') return false;
  if (parsed.version !== 1 || !['schema', 'package'].includes(parsed.mode) || !parsed.schema || !Array.isArray(parsed.schema.fields) || (parsed.schema.supplement_fields !== undefined && !Array.isArray(parsed.schema.supplement_fields)) || (parsed.records !== undefined && !Array.isArray(parsed.records))) throw new Error('不支持的数据集文件版本或结构');
  state.transferPackage = parsed; state.transferRaw = raw;
  $('#transfer-skip').closest('label').hidden = parsed.mode === 'schema';
  $('#batch-summary').hidden = false;
  $('#batch-summary').textContent = `${label} · ${parsed.mode === 'schema' ? '仅结构' : '结构与数据'} · ${parsed.records?.length || 0} 条记录`;
  $('#transfer-target').innerHTML = '<option value="">新建数据集</option>' + state.datasets.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(datasetLocator(item))} · ${escapeHtml(datasetLabelText(item))}</option>`).join('');
  $('#transfer-category').value = parsed.schema.category_path || '';
  state.transferEnvironmentDraft = [...datasetLabels(fileDatasetReference())]; renderTransferEnvironmentDraft();
  $('#transfer-schema-preview').innerHTML = `<h4>结构预览</h4>${parsed.schema.name ? `<p>数据集名称：${escapeHtml(parsed.schema.name)}</p>` : ''}<div class="model-information">${modelFieldsOverview(parsed.schema)}</div>`;
  if (parsed.templates?.length) $('#transfer-schema-preview').insertAdjacentHTML('beforeend', `<details class="transfer-templates"><summary>映射模板 · ${parsed.templates.length} 个</summary>${parsed.templates.map((template, index) => `<label>导入模板名称<input data-transfer-template-name="${index}" value="${escapeHtml(template.name)}" /></label>`).join('')}<p>若名称与已有模板冲突，可在这里修改，不影响记录值。</p></details>`);
  setImportStep(2); return true;
}

importFile = async function(file, reparse = false) {
  if (!file || !confirmDiscardChanges(reparse ? Boolean(state.pendingBatchId || state.importPreview) : hasImportDraft(), '导入配置', state.importBusy || state.importLoading)) return;
  resetImport(true); clearImportText();
  state.importSourceFile = file;
  if (!reparse) { state.importSheets = []; $('#import-sheet').replaceChildren(); }
  renderImportSource();
  const request = state.importRequest, epoch = state.sessionEpoch;
  const current = () => state.unlocked && request === state.importRequest && epoch === state.sessionEpoch;
  state.importLoading = true; setFormBusy($('#import-modal'), true);
  try {
    if (/\.json$/i.test(file.name)) {
      try {
        const raw = await file.text();
        if (!current()) return;
        if ($('#import-node-path').value.trim() && JSON.parse(raw.replace(/^\uFEFF/, ''))?.format === 'securevault-dataset') throw new Error('不支持对原生数据集包选择节点，请清空记录节点');
        if (loadNativeText(raw, file.name)) return;
      } catch (error) {
        if (!current()) return;
        if (state.transferPackage || /不支持/.test(error.message)) { resetImport(); showToast(error.message, 'error'); return; }
        // The ordinary uploader supplies precise JSON validation errors.
      }
    }
    await legacy.importFile(file, current);
    if (current() && state.pendingBatchId) { labelSchemaControls($('#first-schema-fields')); setImportStep(2); }
  } finally {
    if (current()) { state.importLoading = false; setFormBusy($('#import-modal'), false); renderImportSource(); }
  }
};

function mappingDisposition(select) {
  const option = select.options[select.selectedIndex];
  const action = option?.dataset.mappingAction || 'mapped';
  if (action !== 'mapped' && action !== 'new') return action;
  const schemaRow = !$('#first-schema').hidden && $$('#first-schema-fields .schema-field').find(row => row.querySelector('.schema-source-key').textContent === select.dataset.mapSource);
  return option?.dataset.fieldZone === 'ignore' || (schemaRow && schemaRow.querySelector('.schema-field-zone').value === 'ignore') ? 'ignore' : action;
}

function updateMappingSummary() {
  const counts = { pending: 0, mapped: 0, ignore: 0, new: 0 };
  const selects = $$('[data-map-source]');
  const targets = selects.map(select => select.value).filter(value => value && value !== '__new');
  let collapsed = 0;
  for (const select of selects) {
    const action = mappingDisposition(select), row = select.closest('.mapping-row');
    counts[action]++;
    row.querySelector('[data-map-new]').hidden = select.options[select.selectedIndex]?.dataset.mappingAction !== 'new';
    row.querySelector('.mapping-status').textContent = { pending: '未处理', mapped: '已映射', ignore: '明确忽略', new: '新增字段' }[action];
    if (action !== 'pending') select.removeAttribute('aria-invalid');
    const duplicate = select.value && targets.filter(value => value === select.value).length > 1;
    row.hidden = Boolean(state.mappingFocus && row.dataset.autoMapped === 'true' && action === 'mapped' && !duplicate && !row.querySelector('[data-map-path]').value.trim());
    if (row.hidden) collapsed++;
  }
  $('#mapping-counts').textContent = `已映射 ${counts.mapped} · 新增 ${counts.new} · 忽略 ${counts.ignore} · 未处理 ${counts.pending}`;
  $('#ignore-unresolved-mappings').hidden = !counts.pending;
  $('#toggle-mapping-fields').textContent = state.mappingFocus ? `查看全部字段（已折叠 ${collapsed} 项自动映射）` : '只看需要配置的字段';
  $('#toggle-mapping-fields').setAttribute('aria-expanded', String(!state.mappingFocus));
}

renderMappings = function(sourceFields, targetFields, autoSelect = false, templates = []) {
  clearImportDiagnostics(); clearImportSamples();
  if (!$('#mapping-summary')) {
    const summary = document.createElement('div'); summary.id = 'mapping-summary'; summary.className = 'section-heading';
    summary.innerHTML = '<p id="mapping-counts" role="status"></p><div class="mapping-summary-actions"><button id="toggle-mapping-fields" class="clear-button" type="button" aria-controls="mapping-list"></button><button id="ignore-unresolved-mappings" class="clear-button" type="button">忽略全部未处理字段</button></div>';
    $('#mapping-list').before(summary);
    $('#ignore-unresolved-mappings').addEventListener('click', () => {
      clearImportConfigErrors();
      for (const select of $$('[data-map-source]')) if (mappingDisposition(select) === 'pending') select.selectedIndex = 1;
      updateMappingSummary();
    });
    $('#toggle-mapping-fields').addEventListener('click', () => { state.mappingFocus = !state.mappingFocus; updateMappingSummary(); });
  }
  state.mappingFocus = true;
  clearImportConfigErrors();
  $('#mapping-list').innerHTML = sourceFields.map(source => {
    const template = templates.find(item => item.source_key === source);
    const selected = targetFields.find(field => field.source_key === (template?.target_key || source));
    return `<div class="mapping-row"><code>${escapeHtml(source)}</code><div class="mapping-target"><label class="mobile-field-label">目标字段</label><select aria-label="${escapeHtml(source)} 的目标字段" data-map-source="${escapeHtml(source)}"><option value="" data-mapping-action="pending" disabled ${selected ? '' : 'selected'}>请选择处理方式…</option><option value="" data-mapping-action="ignore">忽略本次导入</option>${targetFields.map(field => `<option value="${escapeHtml(field.source_key)}" data-field-zone="${escapeHtml(field.zone || '')}" ${selected?.source_key === field.source_key ? 'selected' : ''}>${escapeHtml(field.display_name || field.source_key)} · ${escapeHtml(field.source_key)}${field.zone === 'ignore' ? '（忽略，不保存）' : ''}</option>`).join('')}<option value="__new" data-mapping-action="new">新增字段…</option></select><input aria-label="新字段名称" data-map-new="${escapeHtml(source)}" placeholder="新字段名称" hidden /></div><div class="mapping-path"><label class="mobile-field-label">JSON 路径</label><input aria-label="${escapeHtml(source)} 内的 JSON 路径" data-map-path="${escapeHtml(source)}" value="${escapeHtml(template?.json_path || '')}" placeholder="可选，例如 endpoint" /></div><span class="mapping-status"></span></div>`;
  }).join('');
  $$('.mapping-row').forEach((row, index) => {
    const select = row.querySelector('[data-map-source]');
    row.dataset.autoMapped = String(mappingDisposition(select) === 'mapped');
    const path = row.querySelector('.mapping-path');
    const details = document.createElement('details');
    details.className = 'mapping-path-options'; details.open = Boolean(path.querySelector('input').value);
    details.innerHTML = '<summary>JSON 路径（可选）</summary>';
    path.before(details); details.append(path);
    const help = document.createElement('small'); help.textContent = '点分隔字段，数字段表示数组下标，例如 items.0.id。仅检查前 3 条；完整错误见下一步预检。';
    const sample = document.createElement('div'); sample.className = 'mapping-sample';
    sample.innerHTML = '<button type="button" class="clear-button" data-preview-sample>预览路径样例</button><div data-sample-result role="status" aria-live="polite"></div>';
    details.append(help, sample);
    sample.querySelector('button').addEventListener('click', () => previewMappingSample(row, false));
    row.querySelectorAll('input, select').forEach((control, controlIndex) => { control.id = `mapping-${index}-${controlIndex}`; });
    row.addEventListener('input', () => { row.dataset.autoMapped = 'false'; clearImportConfigErrors(); });
    select.addEventListener('change', () => { row.dataset.autoMapped = 'false'; clearImportConfigErrors(); updateMappingSummary(); });
  });
  updateMappingSummary();
};

function clearImportConfigErrors() {
  $('#import-config-error').hidden = true; $('#import-config-error').replaceChildren();
  $$('#mapping-list [aria-invalid]').forEach(control => { control.removeAttribute('aria-invalid'); control.removeAttribute('aria-describedby'); });
  $$('.mapping-field-error').forEach(error => error.remove());
}
function importFieldError(control, message) {
  const row = control.closest('.mapping-row'); row.hidden = false;
  const disclosure = control.closest('details'); if (disclosure) disclosure.open = true;
  control.setAttribute('aria-invalid', 'true');
  const error = document.createElement('small'); error.className = 'mapping-field-error'; error.id = `${control.id}-error`; error.textContent = message;
  control.setAttribute('aria-describedby', error.id); control.after(error);
}
function showImportConfigError(message) {
  const container = $('#import-config-error');
  container.replaceChildren(); container.hidden = false;
  const text = document.createElement('p'); text.textContent = message; container.append(text);
  $$('#mapping-list [aria-invalid="true"]').forEach(control => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'clear-button';
    button.textContent = `定位：${control.closest('.mapping-row').querySelector('code').textContent}`;
    button.addEventListener('click', () => { control.closest('.mapping-row').hidden = false; control.focus(); });
    container.append(button);
  });
  if (!$('#mapping-list [aria-invalid="true"]')) container.focus();
}

function buildImportRequest() {
  clearImportConfigErrors();
  const dataset = state.datasets.find(item => item.id === $('#import-dataset-select').value);
  if (!dataset || !state.pendingBatchId) throw new Error('请先选择目标数据集并上传文件');
  const unresolved = $$('[data-map-source]').filter(select => mappingDisposition(select) === 'pending');
  if (unresolved.length) {
    unresolved.forEach(select => importFieldError(select, '请选择映射、新增或明确忽略'));
    unresolved[0].focus();
    throw new Error(`还有 ${unresolved.length} 个未处理字段，请选择映射、新增或明确忽略`);
  }
  const mappings = $$('[data-map-source]').filter(select => select.value).map(select => {
    const row = select.closest('.mapping-row');
    const target_key = select.options[select.selectedIndex]?.dataset.mappingAction === 'new' ? row.querySelector('[data-map-new]').value.trim() : select.value;
    if (!target_key) { const input = row.querySelector('[data-map-new]'); importFieldError(input, '请填写新字段名称'); input.focus(); throw new Error('请填写新字段名称'); }
    return { source_key: select.dataset.mapSource, target_key, json_path: row.querySelector('[data-map-path]').value.trim() || null };
  });
  if (!mappings.length) throw new Error('至少选择一个导入字段');
  if (new Set(mappings.map(item => item.target_key)).size !== mappings.length) {
    const duplicates = mappings.filter(item => mappings.filter(other => other.target_key === item.target_key).length > 1);
    for (const item of duplicates) importFieldError($$('[data-map-source]').find(select => select.dataset.mapSource === item.source_key), `目标字段 ${item.target_key} 被重复使用`);
    $('#mapping-list [aria-invalid]').focus();
    throw new Error('多个源字段不能同时写入同一个目标字段');
  }
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
  if (state.importBusy || state.importLoading) return;
  const generation = state.importRequest, epoch = state.sessionEpoch, configVersion = state.importConfigVersion;
  const current = () => state.unlocked && generation === state.importRequest && epoch === state.sessionEpoch && configVersion === state.importConfigVersion;
  try {
    clearImportConfigErrors(); clearImportDiagnostics(); clearImportSamples();
    state.importPreview = null;
    const transfer = Boolean(state.transferPackage);
    const request = transfer ? buildTransferRequest() : buildImportRequest();
    const ignored = transfer ? [] : $$('[data-map-source]').filter(select => mappingDisposition(select) === 'ignore').map(select => select.dataset.mapSource);
    state.importBusy = true; setFormBusy($('#import-modal'), true);
    const preview = await api(transfer ? '/datasets/transfer/preview' : '/records/import/preview', { method: 'POST', body: JSON.stringify(request) });
    if (!current()) return;
    if (preview.diagnostics) renderImportDiagnostics(preview.diagnostics, request, transfer);
    if (preview.valid === false || preview.diagnostics?.error_count > 0) {
      setImportStep(2); $('#import-diagnostics').focus(); return;
    }
    state.importPreview = { transfer, request, preview, mode: state.transferPackage?.mode };
    const stats = transfer ? preview.result : preview;
    const dataset = state.datasets.find(item => item.id === request.dataset_id);
    const target = transfer ? `${request.category_path} · ${datasetLabelText(request)}` : `${datasetLocator(dataset)} · ${datasetLabelText(dataset)}`;
    $('#import-confirm-summary').innerHTML = `<dl class="dataset-info-summary"><div><dt>目标</dt><dd>${escapeHtml(target)}</dd></div><div><dt>导入内容</dt><dd>${transfer ? state.transferPackage?.mode === 'schema' ? '仅结构' : '结构与数据' : '记录数据'}</dd></div><div><dt>新增</dt><dd>${stats.imported || 0} 条</dd></div><div><dt>更新</dt><dd>${stats.updated || 0} 条</dd></div><div><dt>跳过</dt><dd>${stats.skipped || 0} 条</dd></div><div><dt>删除旧记录</dt><dd>${stats.deleted_missing || 0} 条</dd></div></dl>${transfer && preview.changes.length ? `<h4>结构变更</h4><ul>${preview.changes.map(change => `<li>${escapeHtml(change)}</li>`).join('')}</ul>` : ''}<p>以上为当前预检结果。确认前尚未写入数据。</p>`;
    if (!transfer && !request.skip_existing) $('#import-confirm-summary').insertAdjacentHTML('beforeend', '<p class="import-deletion-warning" role="note">更新匹配的逻辑 KEY 会替换该记录的字段值，本批次未写入或忽略的旧字段也会被清除。若需保留整条旧记录，请返回配置并选择“跳过已存在的唯一 KEY”。</p>');
    if (stats.deleted_missing) $('#import-confirm-summary').insertAdjacentHTML('afterbegin', `<p class="import-deletion-warning" role="note">将从目标数据集 ${escapeHtml(target)} 删除 ${stats.deleted_missing} 条本批次缺失的旧记录。请核对文件是否覆盖需要保留的记录。</p>`);
    if (ignored.length) $('#import-confirm-summary').insertAdjacentHTML('beforeend', `<section class="ignored-import-fields"><h4>不会导入的源字段（${ignored.length}）</h4><ul>${ignored.map(source => `<li><code>${escapeHtml(source)}</code></li>`).join('')}</ul></section>`);
    $('#confirm-structure-wrap').hidden = !transfer || !preview.changes.length;
    $('#confirm-structure-changes').checked = false; $('#import-action-error').hidden = true;
    setImportStep(3);
  } catch (error) { if (current()) showImportConfigError(error.message); }
  finally { if (generation === state.importRequest && epoch === state.sessionEpoch) { state.importBusy = false; setFormBusy($('#import-modal'), false); } }
};

async function confirmImport() {
  const pending = state.importPreview;
  if (!pending || state.importBusy) return;
  if (pending.transfer && pending.preview.changes.length && !$('#confirm-structure-changes').checked) { $('#import-action-error').textContent = '请确认结构变更与影响'; $('#import-action-error').hidden = false; return; }
  const generation = state.importRequest, epoch = state.sessionEpoch;
  const current = () => state.unlocked && generation === state.importRequest && epoch === state.sessionEpoch && state.importPreview === pending;
  state.importBusy = true; setFormBusy($('#import-modal'), true);
  try {
    const body = pending.transfer ? { ...pending.request, confirmation_token: pending.preview.confirmation_token, confirm_changes: $('#confirm-structure-changes').checked } : pending.request;
    const result = await api(pending.transfer ? '/datasets/transfer/import' : '/records/import', { method: 'POST', body: JSON.stringify(body) });
    if (!current()) return;
    await refreshAfterWrite();
    if (!current()) return;
    $('#import-confirmation').hidden = true; $('#import-result').hidden = false;
    const structureOnly = pending.transfer && pending.mode === 'schema';
    $('#import-result').innerHTML = `<h3>${structureOnly ? '结构已导入' : '导入完成'}</h3>${pending.transfer ? `<p>${escapeHtml(pending.request.category_path)} · ${escapeHtml(datasetLabelText(pending.request))}</p>` : ''}<p>${structureOnly ? `${pending.request.dataset_id ? '已更新结构，保留已有记录' : '已创建空数据集'} · ${pending.preview.field_count} 个字段` : `新增 ${result.imported || 0} 条 · 更新 ${result.updated || 0} 条 · 跳过 ${result.skipped || 0} 条${result.deleted_missing ? ` · 删除 ${result.deleted_missing} 条` : ''}`}</p><button id="import-finish" class="primary-button">查看目标数据集</button>`;
    $('#import-finish').addEventListener('click', () => openManagedDataset(pending.transfer ? result.dataset_id : pending.request.dataset_id, 'basic'));
    clearImportDiagnostics(); clearImportSamples();
    state.pendingBatchId = null; state.transferPackage = null; state.transferRaw = null; state.importPreview = null;
    clearImportText(); clearImportSelection();
    $('#import-context').hidden = true;
  } catch (error) { if (current()) { $('#import-action-error').textContent = error.message; $('#import-action-error').hidden = false; } }
  finally {
    if (generation === state.importRequest && epoch === state.sessionEpoch) { state.importBusy = false; setFormBusy($('#import-modal'), false); }
  }
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
function overlayTabStops(root) {
  return [...root.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]')].filter(element => {
    if (element.disabled || element.matches(':disabled') || element.tabIndex < 0 || element.closest('[hidden], [inert]')) return false;
    for (let parent = element; parent && root.contains(parent); parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility)) return false;
      if (parent.matches('details:not([open])') && !parent.querySelector(':scope > summary')?.contains(element)) return false;
    }
    return true;
  });
}
function overlayReturnTarget(frame) {
  const trigger = frame.trigger;
  if (trigger?.isConnected && trigger !== document.body && !trigger.closest('[hidden]')) return trigger;
  return frame.recordId ? $$('.record-open').find(button => button.closest('[data-record-id]')?.dataset.recordId === frame.recordId) : null;
}
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
  let restoreFocus = null;
  const entered = [];
  for (const modal of modals) {
    if (!modal.hidden && !overlayFrames.has(modal.id)) {
      const trigger = document.activeElement === document.body && restoreFocus ? restoreFocus : document.activeElement;
      overlayFrames.set(modal.id, { trigger, recordId: modal.id === 'record-detail-modal' ? state.recordDetail?.id : trigger?.closest('[data-record-id]')?.dataset.recordId, modal: !modal.classList.contains('docked') });
      overlayOrder.push(modal.id);
      if (!modal.classList.contains('docked')) entered.push(modal);
    } else if (modal.hidden && overlayFrames.has(modal.id)) {
      const trigger = overlayReturnTarget(overlayFrames.get(modal.id)); overlayFrames.delete(modal.id); overlayOrder = overlayOrder.filter(id => id !== modal.id);
      if (state.unlocked && trigger) restoreFocus = trigger;
    } else if (!modal.hidden) {
      const frame = overlayFrames.get(modal.id), isModal = !modal.classList.contains('docked');
      if (isModal && !frame.modal) entered.push(modal);
      frame.modal = isModal;
    }
  }
  const top = modalElement();
  $('#vault-screen').inert = Boolean(top && top.tagName !== 'DIALOG');
  // Native dialogs provide their own inertness; duplicating it blocks the browser's return focus.
  for (const modal of modals) modal.inert = Boolean(top && top.tagName !== 'DIALOG' && top !== modal && !modal.hidden);
  // A focus attempt made before removing inert is ignored by real browsers.
  if (entered.includes(top)) {
    if (!top.contains(document.activeElement)) overlayTabStops(top)[0]?.focus();
  } else if (restoreFocus && !restoreFocus.closest('[inert]')) restoreFocus.focus();
}

function closeTopOverlay() {
  const top = modalElement();
  if (!top) {
    if (document.activeElement?.closest('#record-detail-modal.docked')) closeRecordDetail();
    $('.app-navigation').classList.remove('directory-open'); return;
  }
  if (top.id === 'saved-queries-modal') { closeSavedQueries(); return; }
  if (top.id === 'description-edit-modal') { closeDescription(); return; }
  if (top.id === 'app-scope-modal') { closeAppScope(); return; }
  if (top.id === 'app-details-modal') { closeAppDetails(); return; }
  if (top.id === 'shared-schema-modal') { closeSharedSchemaEditor(); return; }
  if (top.id === 'schema-preview-modal') { closeSchemaPreview(); return; }
  if (top.id === 'schema-merge-modal' && state.schemaBusy) return;
  if (top.tagName === 'DIALOG') { top.close(); return; }
  const close = { 'manual-record-modal': closeManualRecord, 'supplement-modal': closeSupplement, 'record-detail-modal': closeRecordDetail, 'secrets-modal': () => { $('#secrets-modal').hidden = true; $('#secret-fields-list').replaceChildren(); state.secretModalRecordId = null; state.reveal = null; }, 'reveal-modal': () => { $('#reveal-modal').hidden = true; state.pendingReveal = null; } };
  close[top.id]?.();
}

sealVault = async function(...args) {
  clearImportDiagnostics(); clearImportSamples(); clearImportText(); clearImportSelection(); clearExportText();
  if (typeof clearSearchTools === 'function') clearSearchTools();
  clearCopyFeedback();
  clearTimeout(state.searchTimer); state.searchController?.abort(); state.searchController = null; state.searchComposing = false; state.searchOutcome = null;
  searchInputStatus('', null);
  if (typeof cancelSearchResize === 'function') cancelSearchResize();
  state.importRequest++; state.importLoading = false; state.importBusy = false;
  state.importTarget = null;
  setFormBusy($('#import-modal'), false);
  $('#mapping-summary')?.remove(); clearImportConfigErrors();
  clearCatalogState();
  state.searchRequest++; state.workspaceRequest++; state.editorDirty = false; state.importPreview = null; state.transferPackage = null; state.transferRaw = null;
  state.descriptionTarget = null; state.exportDatasetId = null; state.categories = []; state.directoryDraft = [];
  state.scopeEditing = null; state.appViewing = null; state.appDetailBusy = null; state.apps = [];
  $('#app-details-content').replaceChildren(); $('#scope-name').value = '';
  $('#app-key-context').textContent = ''; $('#app-key-id').textContent = '';
  $('#app-scope-modal').close(); $('#scope-datasets').replaceChildren(); $('#app-manager-list').replaceChildren();
  for (const dialog of $$('dialog[open]')) dialog.close();
  $('#description-draft').value = ''; $('#description-draft-preview').replaceChildren(); $('#app-key-value').value = '';
  state.datasetEditorTrigger = null;
  $('#dataset-name').value = ''; $('#dataset-name').placeholder = '留空时使用目录末级名称';
  $('#dataset-description').value = ''; $('#dataset-description-preview').replaceChildren();
  $('#dataset-manager-list').replaceChildren(); $('#dataset-detail-body').replaceChildren(); $('#dataset-detail-description').replaceChildren(); $('#dataset-detail-heading').replaceChildren();
  $('#transfer-schema-preview').replaceChildren(); $('#import-confirm-summary').replaceChildren();
  $('#import-file').value = ''; $('#list-config-preview').replaceChildren();
  await legacy.sealVault(...args);
};

// Initialization preserves established editor IDs and form handlers.
$('#record-detail-tabs').setAttribute('aria-label', '记录详情');
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
$('#export-modal').addEventListener('change', () => { clearExportText(); updateExportOptions(); });
$('#export-modal').addEventListener('close', () => { clearExportText(); $('#export-with-secrets').checked = false; state.exportDatasetId = null; });
$('#copy-export-text').addEventListener('click', copyExportText);
$('#select-export-text').addEventListener('click', () => { $('#export-text').focus(); $('#export-text').select(); });
$('#clear-export-text').addEventListener('click', clearExportText);
$('#parse-import-text').addEventListener('click', parseImportText);
$('#import-node-path').addEventListener('input', invalidateImportText);
$('#import-sheet').addEventListener('change', () => { resetImport(true); renderImportSource(); });
$('#reparse-import-file').addEventListener('click', () => importFile(state.importSourceFile, true));
$('#import-text').addEventListener('input', invalidateImportText);
$('#import-text-format').addEventListener('change', invalidateImportText);
$('#clear-import-text').addEventListener('click', () => resetImport());
$$('input[name="import-source"]').forEach(input => input.addEventListener('change', () => {
  const previous = state.importSource || 'file';
  if (!confirmDiscardChanges(Boolean(state.pendingBatchId || state.transferPackage), '导入配置', state.importBusy || state.importLoading)) {
    $(`input[name="import-source"][value="${previous}"]`).checked = true; return;
  }
  state.importSource = input.value; state.importSourceFile = null; state.importSheets = []; $('#import-sheet').replaceChildren(); resetImport(true); renderImportSource();
}));
$('#transfer-options').before($('#import-config-error'));
$('#preview-transfer').addEventListener('click', () => commitImport());
$('#confirm-import').addEventListener('click', confirmImport);
$('#import-back').addEventListener('click', () => { state.importPreview = null; setImportStep(2); });
$('#import-dataset-select').addEventListener('change', event => {
  if (!confirmDiscardChanges(Boolean(state.pendingBatchId || state.transferPackage || state.importPreview), '导入配置', state.importBusy || state.importLoading)) {
    event.target.value = state.importTarget || ''; return;
  }
  resetImport(true);
});
$('#first-schema-fields').addEventListener('change', () => { if ($('#mapping-summary')) updateMappingSummary(); });
$('#transfer-target').addEventListener('change', event => {
  const dataset = state.datasets.find(item => item.id === event.target.value);
  $('#transfer-category').value = dataset?.category_path || state.transferPackage?.schema.category_path || '';
  state.transferEnvironmentDraft = [...datasetLabels(dataset || fileDatasetReference())];
  $('#transfer-environment').value = ''; renderTransferEnvironmentDraft();
  renderImportContext();
});
for (const id of ['transfer-category', 'transfer-environment']) $('#' + id).addEventListener('input', renderImportContext);
for (const id of ['close-app-key', 'finish-app-key']) $(`#${id}`).addEventListener('click', () => $('#app-key-modal').close());
$('#app-key-modal').addEventListener('close', () => { clearCopyFeedback(); $('#app-key-value').value = ''; $('#app-key-context').textContent = ''; $('#app-key-id').textContent = ''; });
$('#copy-app-key').addEventListener('click', event => copyWithFeedback(event.currentTarget, $('#app-key-value').value, '应用密钥已复制'));
$('#records-grid').addEventListener('keydown', event => {
  if (!['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key) || !event.target.matches('.record-open, .record-card, #records-grid')) return;
  const rows = $$('.record-card, .record-table-row'); if (!rows.length) return;
  const index = rows.indexOf(event.target.closest('.record-card, .record-table-row'));
  if (event.key === 'Enter') {
    // Buttons retain native Enter/Space activation; only a focused row needs a handler.
    if (event.target.matches('.record-card') && index >= 0) { event.preventDefault(); openRecordDetail(rows[index].dataset.recordId); }
    return;
  }
  event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.querySelector('.record-open').focus();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); closeTopOverlay(); return; }
  if (event.key !== 'Tab') return;
  const top = modalElement(); if (!top) return;
  const focusable = overlayTabStops(top);
  const first = focusable[0], last = focusable.at(-1);
  if (!top.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
  else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
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
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || event.target.getAttribute('role') !== 'tab') return;
  const list = event.target.closest('[role="tablist"]');
  if (!list) return;
  const tabs = [...list.querySelectorAll('[role="tab"]')].filter(tab => !tab.disabled && !tab.hidden), index = tabs.indexOf(event.target);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  event.preventDefault(); tabs[next]?.click();
  // Some tab views replace their buttons while rendering.
  list.querySelector('[role="tab"][aria-selected="true"]')?.focus();
});
new MutationObserver(updateOverlayFocus).observe($('#app'), { attributes: true, attributeFilter: ['hidden', 'open'], subtree: true });
window.addEventListener('resize', () => { setDetailMode(); scheduleRecordLayout(); updateOverlayFocus(); });
function hasUnsavedChanges() {
  const descriptionDirty = state.descriptionTarget && $('#description-draft').value !== state.descriptionTarget.initial;
  const scopeDirty = state.scopeEditing && JSON.stringify(appScopeBody()) !== state.scopeEditing.initial;
  return Boolean(state.unlocked && (state.editorDirty || manualRecordDirty() || sharedSchemaDirty() || hasImportDraft() || descriptionDirty || scopeDirty || state.importLoading || state.importBusy || state.schemaBusy || manualEditState?.busy || state.exportBusy));
}
window.secureVaultRequestClose = () => {
  if (window.__SECUREVAULT_DESKTOP__) desktopInvoke('desktop_close', { dirty: hasUnsavedChanges() });
};
window.secureVaultSelectDirectory = async existingOnly => {
  if (!window.__SECUREVAULT_DESKTOP__) return;
  $('#desktop-directory-error').hidden = true;
  try {
    await desktopInvoke('desktop_select_directory', { existingOnly, dirty: hasUnsavedChanges() });
  } catch (error) {
    const message = String(error.message || error);
    if ($('#desktop-directory-dialog').open) {
      $('#desktop-directory-error').textContent = message;
      $('#desktop-directory-error').hidden = false;
    } else { showToast(message, 'error'); }
  }
};
window.secureVaultDirectoryChanged = () => {
  // Native code calls this only after the old session ended (including rollback).
  clearInterval(state.timer);
  state.unlocked = false;
  state.sessionEpoch++;
  document.body.inert = true;
  window.location.reload();
};
async function showDesktopDirectory() {
  if (!window.__SECUREVAULT_DESKTOP__) return;
  try {
    $('#desktop-current-directory').textContent = await desktopInvoke('desktop_directory_info');
    $('#desktop-directory-error').hidden = true;
    $('#desktop-directory-dialog').showModal();
  } catch (error) { showToast(String(error.message || error), 'error'); }
}
// The installed version is injected before page scripts run; displaying it
// does not depend on the vault status request or on unlocking the vault.
if (window.__SECUREVAULT_DESKTOP__ && typeof window.__SECUREVAULT_VERSION__ === 'string') {
  document.querySelectorAll('[data-desktop-version]').forEach(element => {
    element.textContent = `${element.dataset.versionPrefix || ''}v${window.__SECUREVAULT_VERSION__}`;
    element.title = `SecureVault 桌面版 ${window.__SECUREVAULT_VERSION__}`;
    element.hidden = false;
  });
}
document.querySelectorAll('[data-desktop-only]').forEach(element => { element.hidden = !window.__SECUREVAULT_DESKTOP__; });
document.querySelectorAll('[data-desktop-directory]').forEach(button => button.addEventListener('click', showDesktopDirectory));
document.querySelectorAll('[data-desktop-open]').forEach(button => button.addEventListener('click', () => window.secureVaultSelectDirectory(true)));
$('#desktop-directory-switch').addEventListener('click', () => window.secureVaultSelectDirectory(false));
$('#desktop-directory-close').addEventListener('click', () => $('#desktop-directory-dialog').close());
window.addEventListener('beforeunload', event => {
  if (hasUnsavedChanges()) {
    event.preventDefault(); event.returnValue = '';
  }
});
$('.density-select').title = '临时调整当前视图，不修改数据集默认配置';
$('#search-input').closest('.search-input-wrap').querySelector('kbd').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
showWorkspace('search');

const navIcons = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  undo: '<path d="M3 10h11a6 6 0 0 1 0 12h-3M3 10l6-6M3 10l6 6"/>',
  clearValue: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  search: '<circle cx="10" cy="10" r="7"/><path d="m15 15 6 6"/>',
  datasets: '<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/>',
  apps: '<path d="m10 14 4-4m-6 6-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m4 2 1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
  security: '<path d="M3 5h18M3 12h18M3 19h18M7 2v6M16 9v6M9 16v6"/>',
  copy: '<rect x="9" y="9" width="11" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  copied: '<path d="m5 12 4 4L19 6"/>',
  copyPending: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  copyError: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  folder: '<path d="M2 6h8l2 3h10v12H2z"/>'
};
function svgIcon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${navIcons[name]}</svg>`; }
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
  scope.innerHTML = '<option value="">当前范围内全部数据集</option>' + state.datasets.filter(dataset => datasetInCategoryScope(dataset) && datasetMatchesLabels(dataset)).map(dataset => `<option value="${escapeHtml(dataset.id)}">${escapeHtml(datasetLocator(dataset))} · ${escapeHtml(datasetLabelText(dataset))}</option>`).join('');
  scope.value = state.selectedDatasetId || '';
  renderSearchScope();
};
const scopeLabel = document.createElement('label');
scopeLabel.className = 'dataset-scope-select';
scopeLabel.innerHTML = '<select id="global-dataset-scope" aria-label="当前范围内的数据集"><option value="">当前范围内全部数据集</option></select>';
$('.filter-row').insertBefore(scopeLabel, $('#clear-filters'));
$('#global-dataset-scope').addEventListener('change', async event => {
  const dataset = state.datasets.find(item => item.id === event.target.value);
  state.selectedDatasetId = dataset && datasetInCategoryScope(dataset) && datasetMatchesLabels(dataset) ? dataset.id : null; state.page = 1;
  try { await fetchRecords(); renderCategoryTree(); renderFilters(); renderIndexReference(); } catch (error) { showToast(error.message, 'error'); }
});

function searchScopeCount() {
  return selectedCategories().length + selectedEnvironmentTags().length + Number(Boolean(state.schemaFilter)) + Number(Boolean(state.selectedDatasetId)) + Number(state.includeExpired);
}
function renderSearchScope() {
  const items = [];
  const chip = (kind, value, label) => `<button type="button" class="scope-chip" data-scope-kind="${kind}" data-scope-value="${escapeHtml(value)}" aria-label="移除${escapeHtml(label)}" title="${escapeHtml(label)}"><span>${escapeHtml(label)}</span><b aria-hidden="true">×</b></button>`;
  for (const path of selectedCategories()) items.push(chip('directory', path, `目录：${path}（含子目录）`));
  for (const label of selectedEnvironmentTags()) items.push(chip('label', label, `标签：${label}`));
  if (state.schemaFilter) items.push(chip('schema', '', `模型：${state.datasets.find(d => d.schema_id === state.schemaFilter)?.schema_name || state.schemaFilter}`));
  const dataset = state.datasets.find(d => d.id === state.selectedDatasetId);
  if (dataset) items.push(chip('dataset', '', `数据集：${datasetName(dataset)}`));
  if (state.includeExpired) items.push(chip('expired', '', '含过期记录'));
  if (state.query.trim()) items.push(chip('query', '', `搜索：${state.query}`));
  $('#search-scope-summary').innerHTML = '<strong>当前范围</strong>' + (items.join('') || '<span>全部目录 · 全部标签 · 全部模型 · 有效记录</span>');
  $('#search-filters-label').textContent = `筛选条件${searchScopeCount() ? ` · 已选 ${searchScopeCount()}` : ''}`;
  $('#clear-filters').disabled = !searchScopeCount();
  $('#reset-search').disabled = !searchScopeCount() && !state.query;
}
async function refreshSearchScope() {
  state.page = 1; clearTimeout(state.searchTimer);
  renderDimensionFilters(); renderCategoryTree(); renderFilters(); renderIndexReference();
  try { await fetchRecords(); } catch (error) { showToast(error.message, 'error'); }
}
function clearSearchScope(resetQuery = false) {
  state.environmentTags = []; state.schemaFilter = ''; state.environment = 'all';
  state.selectedDatasetId = null; state.category = 'all'; state.categories = []; state.includeExpired = false;
  $('#include-expired').checked = false;
  if (resetQuery) { state.query = ''; $('#search-input').value = ''; }
  return refreshSearchScope();
}
$('#reset-search').addEventListener('click', () => clearSearchScope(true));
$('#widen-search').addEventListener('click', () => clearSearchScope());
$('#search-scope-summary').addEventListener('click', async event => {
  const button = event.target.closest('[data-scope-kind]');
  if (!button) return;
  const kind = button.dataset.scopeKind, value = button.dataset.scopeValue;
  if (kind === 'directory') {
    const paths = selectedCategories().filter(path => path !== value);
    state.category = paths.length === 1 ? paths[0] : 'all'; state.categories = paths.length > 1 ? paths : [];
    state.selectedDatasetId = null;
  }
  if (kind === 'label') { state.environmentTags = selectedEnvironmentTags().filter(label => label !== value); state.environment = 'all'; }
  if (kind === 'schema') state.schemaFilter = '';
  if (kind === 'dataset') state.selectedDatasetId = null;
  if (kind === 'expired') { state.includeExpired = false; $('#include-expired').checked = false; }
  if (kind === 'query') { state.query = ''; $('#search-input').value = ''; }
  await refreshSearchScope();
  if (state.unlocked && state.workspace === 'search') ($('#search-scope-summary button') || $('#search-input')).focus();
});
function renderSearchEmptyState() {
  const empty = $('#empty-state');
  empty.querySelector('h3').textContent = !state.datasets.length ? '还没有数据集' : searchScopeCount() || state.query.trim() ? '当前条件下没有匹配记录' : '还没有有效记录';
  empty.querySelector('p').textContent = !state.datasets.length ? (state.canManage ? '在数据集管理中创建数据集，再导入或新增记录。' : '当前没有可访问的数据集，请联系管理员。') : searchScopeCount() ? '可移除上方单个条件，或清除筛选扩大范围；搜索词会保留。' : state.query.trim() ? '试试更短的搜索词，或检查“筛选规则与搜索语法”。' : '可包含过期记录，或进入数据集新增、导入记录。';
  $('#widen-search').hidden = !state.datasets.length || !searchScopeCount();
}
if (typeof matchMedia === 'function') {
  const mobileSearch = matchMedia('(max-width: 767px)');
  const update = () => { $('#search-filters').open = !mobileSearch.matches; };
  update(); mobileSearch.addEventListener('change', update);
}

detailRows = function(values, labels = {}) {
  return Object.entries(values || {}).map(([key, value]) => {
    const label = labels[key] || key, text = valueString(value, true);
    const long = text.length > 240 || text.split('\n').length > 4;
    const content = long
      ? `<details class="detail-value-disclosure"><summary><span class="long-value-preview">${escapeHtml([...text].slice(0, 120).join(''))}…</span><span class="value-expand-label">展开完整内容（${text.length} 字符）</span><span class="value-collapse-label">收起完整内容</span><span class="sr-only"> · ${escapeHtml(label)}</span></summary><span class="detail-full-value${typeof value === 'object' && value !== null ? ' detail-json-value' : ''}" tabindex="0" role="region" aria-label="完整字段内容：${escapeHtml(label)}">${escapeHtml(text)}</span></details>`
      : `<span ${hasDisplayValue(value) ? '' : `class="empty-value" title="${emptyValueLabel(value)}" aria-label="${emptyValueLabel(value)}"`}>${escapeHtml(text)}</span>`;
    return `<div class="detail-row"><span>${escapeHtml(label)}</span><strong class="detail-public-value">${content}<button class="field-copy" data-copy-json="${escapeHtml(JSON.stringify(value))}" aria-label="复制 ${escapeHtml(label)}" title="复制 ${escapeHtml(label)}" type="button">${svgIcon('copy')}<span class="field-copy-hint" aria-hidden="true">复制</span></button></strong></div>`;
  }).join('') || '<p class="detail-empty">无字段</p>';
};

const copyFeedback = new Map();
function restoreCopyButton(button, feedback) {
  clearTimeout(feedback.timer);
  button.innerHTML = feedback.markup;
  if (feedback.title === null) button.removeAttribute('title'); else button.title = feedback.title;
  if (feedback.ariaDisabled === null) button.removeAttribute('aria-disabled'); else button.setAttribute('aria-disabled', feedback.ariaDisabled);
  if (feedback.ariaLabel === null) button.removeAttribute('aria-label'); else button.setAttribute('aria-label', feedback.ariaLabel);
  button.disabled = false; button.removeAttribute('aria-busy');
  delete button.dataset.copyState;
  feedback.status.remove();
  copyFeedback.delete(button);
}
function clearCopyFeedback(root = null) {
  for (const [button, feedback] of copyFeedback) if (!root || root.contains(button)) restoreCopyButton(button, feedback);
}
function setCopyButtonFeedback(button, stateName, label) {
  if (button.classList.contains('field-copy')) {
    const icon = { busy: 'copyPending', success: 'copied', error: 'copyError' }[stateName];
    button.innerHTML = `${svgIcon(icon)}<span class="field-copy-hint" aria-hidden="true">${escapeHtml(label)}</span>`;
    button.title = label;
  } else button.textContent = label;
  button.dataset.copyState = stateName;
}
async function copyWithFeedback(button, value, message = '字段已复制') {
  if (!button || !state.unlocked || copyFeedback.get(button)?.busy) return;
  const previous = copyFeedback.get(button);
  if (previous) restoreCopyButton(button, previous);
  const status = document.createElement('span'); status.className = 'copy-feedback sr-only'; status.setAttribute('role', 'status');
  button.after(status);
  const iconButton = button.classList.contains('field-copy');
  const feedback = { label: button.textContent, markup: button.innerHTML, title: button.getAttribute('title'), ariaDisabled: button.getAttribute('aria-disabled'), ariaLabel: button.getAttribute('aria-label'), status, busy: true };
  copyFeedback.set(button, feedback);
  const epoch = state.sessionEpoch;
  const current = () => state.unlocked && epoch === state.sessionEpoch && button.isConnected && copyFeedback.get(button) === feedback;
  setCopyButtonFeedback(button, 'busy', '复制中…');
  // Keep icon buttons focusable during clipboard permission prompts and pending writes.
  button.disabled = !iconButton; button.setAttribute('aria-disabled', 'true'); button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-label', `${feedback.ariaLabel || feedback.label}，正在复制`);
  try {
    await copyText(value);
    if (!current()) return;
    setCopyButtonFeedback(button, 'success', '已复制');
    status.textContent = iconButton ? `${feedback.ariaLabel || '字段'}：已复制` : message;
    button.setAttribute('aria-label', `${feedback.ariaLabel || feedback.label}，已复制`);
  } catch {
    if (!current()) return;
    setCopyButtonFeedback(button, 'error', '重试复制');
    button.setAttribute('aria-label', `${feedback.ariaLabel || feedback.label}，复制失败，可重试`);
    status.textContent = '复制失败，请重试或手动选择文本。';
  } finally {
    feedback.busy = false;
    if (current()) {
      button.disabled = false; button.removeAttribute('aria-busy'); button.removeAttribute('aria-disabled');
      if (!iconButton || button.dataset.copyState !== 'error') feedback.timer = setTimeout(() => { if (copyFeedback.get(button) === feedback) restoreCopyButton(button, feedback); }, 2500);
    } else if (copyFeedback.get(button) === feedback) restoreCopyButton(button, feedback);
  }
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-copy-json]');
  if (!button) return;
  try {
    const value = JSON.parse(button.dataset.copyJson);
    await copyWithFeedback(button, typeof value === 'string' ? value : JSON.stringify(value));
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
  const focus = referenceFocus(document.activeElement);
  renderEditorModelReference(); renderImportContext(); renderTransferEnvironmentDraft();
  if (document.activeElement === document.body) restoreReferenceFocus(focus);
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
    state.importConfigVersion = (state.importConfigVersion || 0) + 1;
    clearImportDiagnostics(); clearImportSamples(); state.importPreview = null;
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
$('#add-dataset-environment').addEventListener('click', () => { try { commitEnvironmentInput(); $('#dataset-environment-select').focus(); } catch (error) { showToast(error.message, 'error'); } });
$('#dataset-environment-select').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); try { commitEnvironmentInput(); } catch (error) { showToast(error.message, 'error'); } }
});
$('#dataset-environment-select').addEventListener('input', () => { state.editorDirty = true; });
$('#dataset-schema').addEventListener('change', event => { event.target.dataset.touched = 'true'; renderEditorModelReference(); });
for (const kind of ['schema']) $('#search-' + kind).addEventListener('change', async event => {
  state[kind + 'Filter'] = event.target.value; state.selectedDatasetId = null; state.page = 1;
  try { await fetchRecords(); renderFilters(); renderIndexReference(); } catch (error) { showToast(error.message, 'error'); }
});

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
  $('#catalog-list').setAttribute('role', 'tabpanel');
  $('#catalog-list').setAttribute('aria-labelledby', `catalog-tab-${kind}`);
  const title = { schemas: '数据模型', environments: '标签' }[kind];
  $('#catalog-title').textContent = title;
  $('#catalog-name').hidden = kind === 'schemas';
  $('#catalog-create').textContent = `＋ 新建${title}`;
  $('#catalog-note').textContent = kind === 'schemas' ? '结构统一维护；数据、导入和应用授权按数据集实例独立管理。已有数据集需手动选择合并。' : '标签可在数据集中直接添加，保存时创建或复用。仍被引用的标签不能删除。';
  $$('[data-catalog-tab]').forEach(button => {
    button.setAttribute('aria-selected', String(button.dataset.catalogTab === kind));
    button.tabIndex = button.dataset.catalogTab === kind ? 0 : -1;
  });
  $('#catalog-list').innerHTML = state.catalog[kind].map(item => kind === 'schemas'
    ? `<article class="catalog-item"><div><button class="catalog-model-link" data-view-schema="${escapeHtml(item.id)}">${escapeHtml(item.name)}</button><small>${item.definition.fields.length} 个字段 · ${item.dataset_ids.length} 个数据集</small><small>${escapeHtml(item.dataset_ids.slice(0, 3).map(id => { const d = state.datasets.find(dataset => dataset.id === id); return d ? [d.category_path, datasetLabelText(d)].filter(Boolean).join(' · ') : id; }).join('；'))}${item.dataset_ids.length > 3 ? '…' : ''}</small>${item.description ? `<details class="catalog-model-note"><summary>模型说明</summary><div class="markdown-content">${renderMarkdown(item.description)}</div></details>` : ''}</div><div class="row-actions"><button class="secondary-button" data-edit-schema="${escapeHtml(item.id)}">编辑模型</button><button class="secondary-button" data-merge-schema="${escapeHtml(item.id)}">合并数据集</button>${!item.dataset_ids.length ? `<button class="clear-button" data-delete-catalog="${escapeHtml(item.id)}">删除</button>` : ''}</div></article>`
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
  const caption = field.display_name || field.source_key || '新增字段';
  const label = (text, control, check = false) => `<label${check ? ' class="model-check"' : ''}><span class="model-control-caption">${text}</span>${control}</label>`;
  return `<div class="catalog-field-row${supplement ? ' supplement-field-row' : ''}" data-original="${escapeHtml(field.source_key || '')}" data-list-position="${list?.position ?? ''}" data-list-present="${Boolean(list)}">
    <span class="model-field-number"><button type="button" class="shared-row-number" title="点击修改序号"><span class="shared-number-text"></span></button><input class="shared-position" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" hidden /></span>
    ${label('源字段', `<input class="shared-source" value="${escapeHtml(field.source_key || '')}" />`)}
    ${label('显示名称', `<input class="shared-label" value="${escapeHtml(field.display_name || '')}" />`)}
    ${label('用途', `<select class="shared-zone">${fieldZoneOptions(field.zone || 'indexes')}</select>`)}
    ${supplement ? '' : label('逻辑 KEY', `<input type="checkbox" class="shared-key" ${field.zone === 'ignore' ? 'disabled' : ''} ${d.identity_fields?.includes(field.source_key) ? 'checked' : ''} />`, true)}

    <div class="definition-display-controls">
    ${supplement ? '' : `${label('列表展示', `<input type="checkbox" class="shared-visible" ${publicField ? '' : 'disabled'} ${publicField && (Array.isArray(d.list_fields) ? Boolean(list && list.visible !== false) : true) ? 'checked' : ''} />`, true)}${label('记录标识', `<input type="checkbox" class="shared-identifier" ${publicField ? '' : 'disabled'} ${d.display_config?.identifier_fields?.includes(field.source_key) ? 'checked' : ''} />`, true)}${label('展示形式', `<select class="shared-format" ${publicField ? '' : 'disabled'}>${Object.entries({ single_line: '单行', multiline: '多行', json: 'JSON' }).map(([value, text]) => `<option value="${value}" ${list?.format === value ? 'selected' : ''}>${text}</option>`).join('')}</select>`)}`}
    <small class="definition-field-hint" hidden></small></div>
    <div class="definition-row-actions"><span class="definition-row-state sr-only" role="status"></span><button type="button" class="definition-icon shared-undo" aria-label="撤回 ${escapeHtml(caption)} 的修改" title="撤回字段修改" hidden>${svgIcon('undo')}</button>${!field.source_key ? `<button type="button" class="definition-icon shared-remove" aria-label="移除新增字段" title="移除新增字段">${svgIcon('clearValue')}</button>` : ''}</div>
  </div>`;
}
function bindSharedFieldRow(row) {
  trackSharedDefinitionRow(row);
  row.querySelector('.shared-remove')?.addEventListener('click', () => {
    const next = row.nextElementSibling || row.previousElementSibling, add = row.closest('#shared-main-fields') ? $('#shared-add-main') : $('#shared-add-supplement');
    row.remove(); (next?.querySelector('.shared-source') || add).focus();
  });
  const number = row.querySelector('.shared-row-number'), position = row.querySelector('.shared-position');
  const finishPosition = (commit, refocus = false) => {
    if (position.hidden || state.schemaBusy) return;
    const container = row.parentElement, total = container.children.length;
    const previous = [...container.children].indexOf(row), value = position.value.trim();
    const valid = /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= total;
    if (commit && !valid) {
      if (refocus) {
        position.setCustomValidity(`请输入 1 至 ${total} 之间的整数序号`);
        position.setAttribute('aria-invalid', 'true'); position.reportValidity(); return;
      }
      showToast(`序号无效，已保留原位置；请输入 1 至 ${total} 之间的整数`, 'error');
      commit = false;
    }
    position.setCustomValidity(''); position.removeAttribute('aria-invalid');
    position.hidden = true; number.hidden = false;
    if (commit) moveRowToPosition(row, '.catalog-field-row', value, () => refreshDefinitionEditor($('#shared-schema-modal')));
    else refreshDefinitionEditor($('#shared-schema-modal'));
    orderChanged(container, row, previous);
    if (refocus) number.focus();
  };
  number.addEventListener('click', () => {
    if (state.schemaBusy) return;
    $$('#shared-schema-modal .shared-position:not([hidden])').forEach(input => input.blur());
    position.value = [...row.parentElement.children].indexOf(row) + 1;
    number.hidden = true; position.hidden = false; position.focus(); position.select();
  });
  position.addEventListener('input', () => { position.setCustomValidity(''); position.removeAttribute('aria-invalid'); });
  position.addEventListener('blur', () => finishPosition(true));
  position.addEventListener('keydown', event => {
    if (!['Enter', 'Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); finishPosition(event.key === 'Enter', true);
  });
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
    state.schemaViewId = id;
    $('#schema-view-description-details').open = false;
    renderSchemaView(); openDialog('schema-view-modal');
  } catch (error) { if (state.unlocked && epoch === state.sessionEpoch) showToast(error.message, 'error'); }
}
function renderSchemaView() {
  const model = state.catalog.schemas.find(item => item.id === state.schemaViewId);
  if (!model || !state.canManage) return;
  const d = model.definition;
  $('#schema-view-title').textContent = `数据模型：${model.name}`;
  $('#schema-view-scope').textContent = `${model.dataset_ids.length} 个数据集引用`;
  $('#schema-view-description-summary').textContent = model.description?.trim() ? descriptionSummary(model.description) : '暂无模型描述';
  $('#schema-view-description').textContent = model.description?.trim() ? '修改描述' : '添加描述';
  $('#schema-view-description-details').hidden = !model.description?.trim();
  $('#schema-view-description-content').innerHTML = renderMarkdown(model.description || '');
  $('#schema-view-summary').innerHTML = `<div><dt>逻辑唯一 KEY</dt><dd>${escapeHtml(d.identity_fields?.join(' + ') || '未设置')}</dd></div>`;
  $('#schema-view-content').innerHTML = modelFieldsOverview(d);
}
$('#close-schema-view').addEventListener('click', () => $('#schema-view-modal').close());
$('#schema-view-edit').addEventListener('click', () => { const id = state.schemaViewId; $('#schema-view-modal').close(); openSharedSchemaEditor(id); });
$('#schema-view-description').addEventListener('click', () => openModelDescription(state.schemaViewId));
async function openSharedSchemaEditor(id) {
  if (!state.canManage) return;
  if ($('#shared-schema-modal').open && !closeSharedSchemaEditor()) return;
  const epoch = state.sessionEpoch;
  try {
    if (!await loadCatalog() || epoch !== state.sessionEpoch) return;
    const schema = id ? state.catalog.schemas.find(s => s.id === id) : null;
    if (id && !schema) throw new Error('结构不存在，请刷新后重试');
    state.schemaDraft = { id, description: schema?.description || '', originalDescription: schema?.description || '', version: schema?.version, originalOrder: schema?.definition.fields.map(f => f.source_key) || [] };
    const d = schema?.definition || { fields: [], identity_fields: [], list_fields: [], display_config: {}, supplement_fields: [] };
    $('#shared-schema-title').textContent = id ? '修改共享模型' : '新建数据模型';
    $('#shared-schema-name').value = schema?.name || '';
    $('#shared-description-details').open = false;
    updateModelDescriptionPreview();
    $('#shared-schema-scope').innerHTML = id ? sharedModelScope(id, schema.name) : '新模型尚未被数据集引用。';
    $('#shared-density').value = d.display_config?.density || 'summary';
    $('#shared-main-fields').innerHTML = d.fields.map(f => sharedFieldRow(f, d)).join('');
    $('#shared-supplement-fields').innerHTML = d.supplement_fields.map(f => sharedFieldRow(f, d, true)).join('');
    $$('#shared-schema-modal .catalog-field-row').forEach(bindSharedFieldRow);
    state.schemaDraft.originalDefinitionDraft = JSON.stringify(readSharedDefinition());
    state.schemaDraft.initial = sharedSchemaDraftValues();
    beginModelDefinitionDraft();
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
function sharedSchemaDraftValues() {
  return JSON.stringify([sharedFieldFormValues($('#shared-schema-modal')), state.schemaDraft?.description || '']);
}
function sharedSchemaDirty() {
  return Boolean($('#shared-schema-modal').open && state.schemaDraft && state.schemaDraft.initial !== sharedSchemaDraftValues());
}
function setSchemaBusy(busy) {
  state.schemaBusy = busy;
  for (const id of ['shared-schema-modal', 'schema-merge-modal', 'schema-preview-modal']) setFormBusy($('#' + id), busy);
}
function closeSharedSchemaEditor(force = false) {
  if (!force && !confirmDiscardChanges(sharedSchemaDirty(), '模型修改', state.schemaBusy)) return false;
  $('#shared-schema-modal').close();
  definitionDrafts.delete($('#shared-schema-modal'));
  $('#shared-main-fields').replaceChildren(); $('#shared-supplement-fields').replaceChildren();
  $('#shared-schema-name').value = '';
  state.schemaDraft = null;
  updateModelDescriptionPreview();
  return true;
}
function closeSchemaPreview() {
  if (state.schemaBusy) return;
  $('#schema-preview-modal').close(); state.schemaPublication = null;
}
for (const kind of ['main', 'supplement']) $('#shared-add-' + kind).addEventListener('click', () => {
  const container = $('#shared-' + kind + '-fields');
  container.insertAdjacentHTML('beforeend', sharedFieldRow({}, {}, kind === 'supplement'));
  bindSharedFieldRow(container.lastElementChild); container.lastElementChild.querySelector('.shared-source').focus();
});
$('#preview-shared-schema').addEventListener('click', () => {
  const definition = readSharedDefinition();
  const unchanged = state.schemaDraft?.id && JSON.stringify(definition) === state.schemaDraft.originalDefinitionDraft;
  const description = state.schemaDraft?.description || '';
  const descriptionChanged = !state.schemaDraft?.id || description !== state.schemaDraft.originalDescription;
  previewSchemaOperation({ schema_id: state.schemaDraft?.id || null, name: $('#shared-schema-name').value, ...(descriptionChanged ? { description } : {}), ...(unchanged ? {} : { definition }) }, 'shared-schema-error');
});
$('#close-shared-schema').addEventListener('click', () => closeSharedSchemaEditor());
$('#shared-schema-modal').addEventListener('cancel', event => { event.preventDefault(); closeSharedSchemaEditor(); });
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
$('#close-schema-merge').addEventListener('click', () => { if (!state.schemaBusy) $('#schema-merge-modal').close(); });
$('#schema-merge-modal').addEventListener('cancel', event => { if (state.schemaBusy) event.preventDefault(); });
function schemaChangeGroups(changes) {
  const groups = new Map();
  for (const change of changes.length ? changes : ['模型一致，保留数据并更新模型引用']) {
    const group = change.includes('清除') ? '清除字段值' : change.includes('逻辑 KEY') ? '逻辑 KEY 与关联' : change.includes('重命名') ? '字段重命名' : /(?:indexes|display|normal|secrets|hidden|ignore).*→|用途/.test(change) ? '字段用途' : '字段与展示配置';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(change);
  }
  return [...groups].map(([group, items]) => `<section class="schema-change-group"><h5>${group}</h5><ul>${items.map(change => `<li class="${change.includes('清除') ? 'destructive-change' : ''}">${escapeHtml(change)}</li>`).join('')}</ul></section>`).join('');
}
async function previewSchemaOperation(request, errorId) {
  if (state.schemaBusy || !state.canManage) return;
  const epoch = state.sessionEpoch;
  setSchemaBusy(true); $('#' + errorId).hidden = true;
  try {
    const preview = await api('/schemas/preview', { method: 'POST', body: JSON.stringify(request) });
    if (!state.unlocked || epoch !== state.sessionEpoch) return;
    state.schemaPublication = { request, token: preview.confirmation_token };
    const affected = preview.changes;
    const clearing = affected.filter(d => d.changes.some(change => change.includes('清除'))).length;
    const keyChanges = affected.filter(d => d.changes.some(change => change.includes('逻辑 KEY'))).length;
    const mainCount = affected.reduce((sum, d) => sum + d.record_count, 0), supplementCount = affected.reduce((sum, d) => sum + d.supplement_count, 0);
    $('#schema-preview-content').innerHTML = `<p>模型：${escapeHtml(request.name || state.catalog.schemas.find(s => s.id === request.schema_id)?.name || '')}</p>${request.description !== undefined ? `<details class="model-description-publication"><summary>本次模型说明${request.description.trim() ? '' : '（清空）'}</summary><div class="markdown-content">${renderMarkdown(request.description)}</div></details>` : ''}<p class="model-impact-summary">涉及 ${affected.length} 个数据集，共 ${mainCount} 条主表 / ${supplementCount} 条附表。${clearing ? `其中 ${clearing} 个数据集将清除字段值。` : ''}${keyChanges ? `其中 ${keyChanges} 个数据集的逻辑 KEY 将变化。` : ''}</p><p>以下为服务端预检；记录与应用授权继续按数据集独立管理。</p>` + affected.map(d => {
      const danger = d.changes.some(change => change.includes('清除'));
      const dataset = state.datasets.find(item => item.id === d.id);
      const nextKeys = request.definition?.identity_fields;
      const keysChanged = dataset && nextKeys && JSON.stringify(dataset.identity_fields) !== JSON.stringify(nextKeys);
      return `<details class="catalog-impact ${danger ? 'has-destructive-change' : ''}" ${danger ? 'open' : ''}><summary>${escapeHtml(dataset ? datasetName(dataset) : d.category_path)} · ${escapeHtml(datasetLabelText(d))} · ${d.changes.length} 项变更${danger ? ' · 将清除值' : ''}</summary><p>${escapeHtml(d.category_path)} · ${d.record_count} 条主表 / ${d.supplement_count} 条附表</p>${keysChanged ? `<p>逻辑 KEY：${escapeHtml(dataset.identity_fields.join(' + ') || '未设置')} → ${escapeHtml(nextKeys.join(' + ') || '未设置')}</p>` : ''}${schemaChangeGroups(d.changes)}</details>`;
    }).join('');
    $('#schema-preview-error').hidden = true; openDialog('schema-preview-modal');
  } catch (error) { if (state.unlocked && epoch === state.sessionEpoch) catalogError(errorId, error); }
  finally { if (epoch === state.sessionEpoch) setSchemaBusy(false); }
}
$('#publish-shared-schema').addEventListener('click', async () => {
  const publication = state.schemaPublication;
  if (!publication || state.schemaBusy || !state.canManage) return;
  const epoch = state.sessionEpoch;
  setSchemaBusy(true); $('#schema-preview-error').hidden = true;
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
  finally { if (epoch === state.sessionEpoch) setSchemaBusy(false); }
});
$('#close-schema-preview').addEventListener('click', closeSchemaPreview);
$('#schema-preview-modal').addEventListener('cancel', event => { event.preventDefault(); closeSchemaPreview(); });
function clearCatalogState() {
  setSchemaBusy(false);
  state.catalog = { schemas: [], environments: [] }; state.schemaDraft = null; state.schemaPublication = null;
  state.schemaFilter = ''; state.mergeSchemaId = null;
  for (const id of ['scope-summary', 'scope-summary-status', 'search-scope-summary', 'shared-schema-scope', 'catalog-list', 'shared-main-fields', 'shared-supplement-fields', 'schema-merge-list', 'schema-preview-content']) $('#' + id).replaceChildren();
  for (const id of ['catalog-name', 'shared-schema-name', 'schema-merge-search']) $('#' + id).value = '';
  $('#shared-schema-description-preview').replaceChildren(); $('#shared-description-details').open = false;
  state.schemaViewId = null; state.descriptionSaving = false;
  state.referenceCatalogLoaded = false; state.referenceCatalogError = null; state.referenceDetails = null;
  for (const id of ['import-context', 'editor-model-reference', 'reference-info-content']) { $('#' + id).replaceChildren(); $('#' + id).hidden = id !== 'reference-info-content'; }
  $('#reference-info-title').textContent = '查看详情';
  for (const id of ['schema-view-title', 'schema-view-scope', 'schema-view-description-summary', 'schema-view-description-content', 'schema-view-summary', 'schema-view-content', 'model-description-summary', 'description-edit-context']) $('#' + id).replaceChildren();
  state.environmentDraft = []; state.transferEnvironmentDraft = []; state.environmentTags = []; state.managerTags = []; state.environment = 'all';
  $('#dataset-environment-select').value = ''; $('#dataset-environment-tags').replaceChildren(); $('#dataset-environment-options').replaceChildren();
  $('#transfer-environment').value = ''; $('#transfer-environment-tags').replaceChildren(); $('#transfer-environment-options').replaceChildren();
  for (const id of ['dataset-schema', 'manager-schema', 'search-schema', 'manager-environment', 'environment-filters', 'global-dataset-scope']) $('#' + id).replaceChildren();
}

for (const eventName of ['input', 'change']) $('#import-modal').addEventListener(eventName, event => {
  if (event.target.closest('#batch-options, #transfer-options, #native-import-target, #ordinary-import-target')) {
    state.importConfigVersion = (state.importConfigVersion || 0) + 1;
    clearImportSamples(); clearImportDiagnostics(); state.importPreview = null;
  }
});

// Secondary actions float above the list so expanding a disclosure never resizes its row.
function closeActionDisclosures(restoreFocus = false, except = null) {
  $$('.action-disclosure[open]').forEach(details => {
    if (details === except) return;
    details.open = false;
    if (restoreFocus) details.querySelector('summary').focus();
  });
}
function positionActionDisclosure(details) {
  // Collapsed/hidden windows can briefly report a one-pixel viewport during resize.
  if (window.innerWidth < 120 || window.innerHeight < 120) return;
  const menu = details.querySelector('.action-disclosure-content'), anchor = details.querySelector('summary').getBoundingClientRect();
  if (anchor.bottom < 0 || anchor.top > window.innerHeight) { details.open = false; return; }
  menu.style.maxHeight = `${Math.max(120, window.innerHeight - 24)}px`;
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(12, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 12))}px`;
  menu.style.top = `${Math.max(12, anchor.bottom + bounds.height + 6 <= window.innerHeight - 12 ? anchor.bottom + 6 : anchor.top - bounds.height - 6)}px`;
}
function wireActionDisclosures(root) {
  root.querySelectorAll('.action-disclosure').forEach(details => {
    details.addEventListener('toggle', () => {
      if (!details.open || !details.isConnected) return;
      closeActionDisclosures(false, details);
      positionActionDisclosure(details);
    });
    // Give dialogs a visible return target before their action handler runs.
    details.addEventListener('click', event => {
      if (!event.target.closest('.action-disclosure-content button')) return;
      details.open = false;
      details.querySelector('summary').focus();
    }, true);
  });
}
document.addEventListener('click', event => {
  $$('.action-disclosure[open]').forEach(details => { if (!details.contains(event.target)) { details.open = false; } });
});
document.addEventListener('focusin', event => {
  if (!event.target.matches('button, input, select, textarea, a, summary, [tabindex]')) return;
  $$('.action-disclosure[open]').forEach(details => { if (!details.contains(event.target)) { details.open = false; } });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('.action-disclosure[open]')) {
    event.preventDefault(); event.stopImmediatePropagation(); closeActionDisclosures(true);
  }
}, true);
window.addEventListener('resize', () => $$('.action-disclosure[open]').forEach(positionActionDisclosure));
document.addEventListener('scroll', event => {
  if (!event.target.closest?.('.action-disclosure-content')) $$('.action-disclosure[open]').forEach(positionActionDisclosure);
}, true);

// Definition editors share the record editor's local change tracking and explicit undo.
const definitionDrafts = new Map();
let sharedDefinitionRows = new WeakMap();
function definitionProperty(controlId, title) {
  const control = $('#' + controlId), label = control.closest('label');
  const row = document.createElement('div'); row.className = 'definition-property'; row.dataset.property = controlId;
  if (label.id) row.id = label.id;
  label.before(row);
  const caption = document.createElement('label'); caption.htmlFor = controlId; caption.className = 'definition-property-label';
  caption.innerHTML = `${escapeHtml(title)}<span class="definition-change-mark" aria-hidden="true" hidden> *</span>`;
  const value = document.createElement('div'); value.className = 'definition-property-value';
  [...label.childNodes].filter(node => node.nodeType !== Node.TEXT_NODE).forEach(node => value.append(node));
  row.append(caption, value); label.remove();
  addDefinitionUndo(row, title);
  return row;
}
function addDefinitionUndo(row, title) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'definition-icon definition-property-undo'; button.hidden = true;
  button.setAttribute('aria-label', `撤回 ${title} 的修改`); button.title = `撤回 ${title} 的修改`; button.innerHTML = svgIcon('undo');
  button.addEventListener('click', () => undoDefinitionProperty(row)); row.append(button);
}
function definitionDescription(section, key, buttonId, title) {
  section.classList.add('definition-property'); section.dataset.property = key;
  const heading = section.querySelector('.section-heading');
  const caption = document.createElement('div'); caption.className = 'definition-property-label';
  caption.innerHTML = `${escapeHtml(title)}<span class="definition-change-mark" aria-hidden="true" hidden> *</span>`;
  const edit = $('#' + buttonId); edit.classList.add('definition-description-edit');
  const value = document.createElement('div'); value.className = 'definition-property-value';
  [...section.children].filter(node => node !== heading).forEach(node => value.append(node));
  value.prepend(edit); heading.remove(); section.append(caption, value); addDefinitionUndo(section, title);
}
function definitionProperties(root) { return [...root.querySelectorAll('.definition-property')]; }
function readDefinitionProperty(key) {
  if (key === 'dataset-labels') return { labels: [...state.environmentDraft], input: $('#dataset-environment-select').value };
  if (key === 'model-description') return state.schemaDraft?.description || '';
  return $('#' + key).value;
}
function definitionEditorValues(root) {
  return JSON.stringify([formValues(root), root.id === 'dataset-modal' ? [...state.environmentDraft] : state.schemaDraft?.description || '']);
}
function beginDatasetDefinitionDraft() {
  const root = $('#dataset-modal');
  definitionDrafts.set(root, { properties: new Map(definitionProperties(root).map(row => [row.dataset.property, readDefinitionProperty(row.dataset.property)])), full: definitionEditorValues(root) });
  $('#dataset-edit-error').hidden = true; refreshDefinitionEditor(root);
  if (state.workspace === 'editor' && (document.activeElement === document.body || document.activeElement.closest('[hidden]'))) root.querySelector('#dataset-basic-fields:not([hidden]) input, #schema-preview:not([hidden]) input, #list-config:not([hidden]) input')?.focus();
}
function beginModelDefinitionDraft() {
  const root = $('#shared-schema-modal');
  definitionDrafts.set(root, { properties: new Map(definitionProperties(root).map(row => [row.dataset.property, readDefinitionProperty(row.dataset.property)])) });
  refreshDefinitionEditor(root);
}
function refreshDefinitionEditor(root) {
  const draft = definitionDrafts.get(root); if (!draft || !state.unlocked) return;
  let changed = 0;
  for (const row of definitionProperties(root)) {
    const dirty = JSON.stringify(readDefinitionProperty(row.dataset.property)) !== JSON.stringify(draft.properties.get(row.dataset.property));
    row.dataset.changed = String(dirty); row.querySelector('.definition-change-mark').hidden = !dirty;
    row.querySelector('.definition-property-undo').hidden = !dirty;
    if (dirty && !row.hidden) changed++;
  }
  if (root.id === 'dataset-modal') {
    state.editorDirty = draft.full !== definitionEditorValues(root);
    $('#dataset-edit-summary').textContent = changed ? `待保存：修改 ${changed} 项，保存后仅对当前数据集生效。` : state.editorDirty ? '待保存：结构或展示规则已修改。' : '未修改的内容保留原值。';
  } else if (state.schemaDraft) {
    let rowsChanged = 0, added = 0;
    for (const container of [$('#shared-main-fields'), $('#shared-supplement-fields')]) {
      [...container.children].forEach((row, index) => {
        const original = sharedDefinitionRows.get(row); if (!original) return;
        const isNew = !row.dataset.original;
        const dirty = isNew || original.index !== index || original.values !== JSON.stringify(sharedFieldFormValues(row));
        row.dataset.changed = String(dirty); row.dataset.newField = String(isNew);
        row.querySelector('.shared-undo').hidden = !dirty || isNew;
        row.querySelector('.definition-row-mark').hidden = !dirty;
        const caption = row.querySelector('.shared-label').value || row.querySelector('.shared-source').value || '新增';
        row.setAttribute('aria-label', caption + '字段');
        const number = row.querySelector('.shared-row-number'), position = row.querySelector('.shared-position');
        row.querySelector('.shared-number-text').textContent = index + 1;
        number.setAttribute('aria-label', `${caption}：第 ${index + 1} 行，点击修改序号`);
        number.title = `${caption}：点击修改序号`;
        position.setAttribute('aria-label', `${caption}的目标序号`);
        position.setAttribute('aria-description', `输入 1 至 ${container.children.length}；Enter 确认，Escape 取消`);
        if (position.hidden) position.value = index + 1;
        row.querySelector('.shared-undo').setAttribute('aria-label', `撤回 ${caption} 的修改`);
        row.querySelector('.definition-row-state').textContent = dirty ? `${caption}：${isNew ? '新增字段' : '已修改'}` : '';
        if (!state.schemaBusy) {
          const zone = row.querySelector('.shared-zone').value, publicField = ['indexes', 'display'].includes(zone);
          const format = row.querySelector('.shared-format'); if (format) format.disabled = !publicField || !row.querySelector('.shared-visible').checked;
          const hint = row.querySelector('.definition-field-hint');
          hint.textContent = zone === 'ignore' ? '发布后将清除此字段的已有值。' : !publicField && format ? '此用途不参与公开列表展示与记录标识。' : '';
          hint.hidden = !hint.textContent; hint.classList.toggle('danger-text', zone === 'ignore');
        }
        if (dirty) isNew ? added++ : rowsChanged++;
      });
    }
    $('#model-edit-summary').textContent = changed || rowsChanged || added ? `待预览：${changed} 项属性 · ${rowsChanged} 个字段修改${added ? ` · ${added} 个新增字段` : ''}` : '未修改的内容保留原值。';
  }
}
function undoDefinitionProperty(row) {
  const root = row.closest('#dataset-modal, #shared-schema-modal');
  if (!root || state.datasetSaving || state.schemaBusy) return;
  const key = row.dataset.property, draft = definitionDrafts.get(root); if (!draft) return;
  const value = draft.properties.get(key);
  if (key === 'dataset-labels') { state.environmentDraft = [...value.labels]; $('#dataset-environment-select').value = value.input; renderEnvironmentDraft(); }
  else if (key === 'model-description') { state.schemaDraft.description = value; updateModelDescriptionPreview(); }
  else { $('#' + key).value = value; if (key === 'dataset-description') updateDatasetDescriptionPreview(); else $('#' + key).dispatchEvent(new Event('change', { bubbles: true })); }
  refreshDefinitionEditor(root);
  const focus = key === 'dataset-labels' ? $('#dataset-environment-select') : key === 'dataset-description' ? $('#edit-description') : key === 'model-description' ? $('#shared-edit-description') : $('#' + key);
  focus.focus();
}
function sharedFieldFormValues(root) { return formValues(root).filter(([key]) => key !== 'shared-position'); }
function trackSharedDefinitionRow(row) {
  row.setAttribute('role', 'group');
  const controls = [...row.querySelectorAll('input:not(.shared-position), select')];
  sharedDefinitionRows.set(row, { index: [...row.parentElement.children].indexOf(row), values: JSON.stringify(sharedFieldFormValues(row)), controls: controls.map(input => ({ input, value: input.value, checked: input.checked })) });
  const marker = document.createElement('span'); marker.className = 'definition-row-mark'; marker.textContent = ' *'; marker.hidden = true; row.querySelector('.shared-row-number').append(marker);
  row.querySelector('.shared-undo').addEventListener('click', () => {
    if (state.schemaBusy) return;
    const original = sharedDefinitionRows.get(row);
    original.controls.forEach(({ input, value, checked }) => { input.value = value; if (input.type === 'checkbox') input.checked = checked; });
    row.querySelector('.shared-zone').dispatchEvent(new Event('change', { bubbles: true }));
    const siblings = [...row.parentElement.children].filter(item => item !== row);
    row.parentElement.insertBefore(row, siblings[original.index] || null);
    refreshDefinitionEditor($('#shared-schema-modal')); row.querySelector('.shared-source').focus();
  });
}

for (const [id, title] of [['dataset-name', '名称（可选）'], ['dataset-category', '分类目录'], ['dataset-schema', '数据模型'], ['shared-schema-name', '模型名称'], ['shared-density', '默认展示密度']]) definitionProperty(id, title);
const datasetLabelsProperty = $('.dataset-label-editor');
datasetLabelsProperty.classList.add('definition-property'); datasetLabelsProperty.dataset.property = 'dataset-labels';
const datasetLabelsCaption = datasetLabelsProperty.querySelector('label'); datasetLabelsCaption.classList.add('definition-property-label'); datasetLabelsCaption.insertAdjacentHTML('beforeend', '<span class="definition-change-mark" aria-hidden="true" hidden> *</span>');
const datasetLabelsValue = document.createElement('div'); datasetLabelsValue.className = 'definition-property-value';
[...datasetLabelsProperty.children].filter(node => node !== datasetLabelsCaption).forEach(node => datasetLabelsValue.append(node)); datasetLabelsProperty.append(datasetLabelsValue); addDefinitionUndo(datasetLabelsProperty, '标签');
definitionDescription($('.dataset-description-editor'), 'dataset-description', 'edit-description', '数据集描述');
definitionDescription($('#shared-schema-modal .model-description-card'), 'model-description', 'shared-edit-description', '模型说明');
$('.dataset-dialog').classList.add('definition-editor');
$('#shared-schema-modal').classList.add('definition-editor');
const originalDatasetDescriptionPreview = updateDatasetDescriptionPreview;
updateDatasetDescriptionPreview = function(...args) { originalDatasetDescriptionPreview(...args); refreshDefinitionEditor($('#dataset-modal')); };
const originalModelDescriptionPreview = updateModelDescriptionPreview;
updateModelDescriptionPreview = function(...args) { originalModelDescriptionPreview(...args); refreshDefinitionEditor($('#shared-schema-modal')); };
const originalEnvironmentDraft = renderEnvironmentDraft;
renderEnvironmentDraft = function(...args) { originalEnvironmentDraft(...args); refreshDefinitionEditor($('#dataset-modal')); };
for (const root of [$('#dataset-modal'), $('#shared-schema-modal')]) {
  for (const type of ['input', 'change', 'click']) root.addEventListener(type, () => refreshDefinitionEditor(root));
}
const originalDefinitionSeal = sealVault;
sealVault = async function(...args) {
  definitionDrafts.clear(); sharedDefinitionRows = new WeakMap();
  state.datasetSaving = false; setFormBusy($('#dataset-modal'), false);
  for (const id of ['dataset-edit-summary', 'model-edit-summary', 'dataset-edit-error']) $('#' + id).replaceChildren();
  $$('.definition-property[data-changed="true"]').forEach(row => { row.dataset.changed = 'false'; row.querySelector('.definition-change-mark').hidden = true; row.querySelector('.definition-property-undo').hidden = true; });
  return originalDefinitionSeal(...args);
};
const datasetDefinitionFooter = document.createElement('footer'); datasetDefinitionFooter.className = 'definition-editor-footer';
$('#dataset-edit-summary').before(datasetDefinitionFooter);
datasetDefinitionFooter.append($('#dataset-edit-summary'), $('#dataset-edit-error'), $('#dataset-modal .dialog-actions'));
$('#dataset-edit-error').tabIndex = -1;
$('#shared-schema-modal').addEventListener('close', () => definitionDrafts.delete($('#shared-schema-modal')));
