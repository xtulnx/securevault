// Search efficiency features share the existing scope, pagination and detail
// flows. Column preferences are temporary; saved queries live in the vault.
const tablePreferences = new Map();
let resultView = 'summary';
let savedQueries = [];
let savedQueryRequest = 0;
let savedQueryBusy = false;
let savedQuerySaving = false;
let savedQueryFocus = null;

function tableFields(dataset) {
  return [...(dataset?.fields || []).map(field => ({ ...field, key: field.source_key })),
    ...(dataset?.supplement_fields || []).map(field => ({ ...field, key: `supplement.${field.source_key}`, display_name: `附表 · ${field.display_name || field.source_key}` }))]
    .filter(field => ['indexes', 'display'].includes(field.zone));
}
function tableSettings(dataset) {
  const fields = tableFields(dataset);
  let settings = tablePreferences.get(dataset.id);
  if (!settings) {
    const defaults = dataset.list_fields?.filter(field => field.visible !== false).slice().sort((a, b) => (a.position || 0) - (b.position || 0)).map(field => field.source_key);
    settings = { keys: defaults?.length ? defaults : fields.slice(0, 5).map(field => field.key), widths: Object.create(null) };
    tablePreferences.set(dataset.id, settings);
  }
  settings.keys = settings.keys.filter(key => fields.some(field => field.key === key));
  return settings;
}
function activeRecordTableDataset() {
  const dataset = resultView === 'table' ? singleDatasetInSearchScope() : null;
  return dataset && state.records.every(record => record.dataset_id === dataset.id) ? dataset : null;
}
function renderSearchTools() {
  const dataset = singleDatasetInSearchScope(), active = Boolean(activeRecordTableDataset());
  $('#result-view').value = active ? 'table' : 'summary';
  $('#result-view option[value="table"]').disabled = !dataset;
  $('#result-view-help').textContent = dataset ? '表格只显示公开字段；列与宽度仅在本次解锁期间保留。' : '限定为单个数据集后可使用表格比较记录。';
  $('.density-select').hidden = active;
  $('#table-columns').hidden = !active;
  $('#saved-queries-panel').hidden = !state.canManage;
  $('#records-grid').classList.toggle('table-results', active);
  if (!dataset || !active) return;
  const fields = tableFields(dataset), settings = tableSettings(dataset);
  $('#table-column-list').innerHTML = fields.map(field => `<div class="table-column-option"><label><input type="checkbox" data-table-column="${escapeHtml(field.key)}" ${settings.keys.includes(field.key) ? 'checked' : ''}>${escapeHtml(field.display_name || field.source_key)}</label><label>宽度<input type="number" min="120" max="640" step="20" value="${settings.widths[field.key] || 220}" data-table-width="${escapeHtml(field.key)}" aria-label="${escapeHtml(field.display_name || field.source_key)}列宽（像素）"></label></div>`).join('') || '<p>没有可显示的公开字段，仍可通过记录标识打开详情。</p>';
}
function recordTableMarkup(dataset) {
  const settings = tableSettings(dataset), available = tableFields(dataset), fields = settings.keys.map(key => available.find(field => field.key === key)).filter(Boolean);
  const header = fields.map(field => `<th scope="col" style="width:${settings.widths[field.key] || 220}px">${escapeHtml(field.display_name || field.source_key)}</th>`).join('');
  const rows = state.records.map(record => {
    const values = { ...publicRecordValues(record) };
    for (const [key, value] of Object.entries(publicRecordValues(record.supplement || {}))) values[`supplement.${key}`] = value;
    const cells = fields.map(field => `<td class="${record.matched_fields?.includes(field.key) ? 'is-match' : ''}"><span class="table-cell-value" title="${escapeHtml(Object.hasOwn(values, field.key) ? valueString(values[field.key]) : '未填写')}">${highlightField(valueString(values[field.key]), field.key, record)}</span></td>`).join('');
    return `<tr class="record-table-row ${record.expired ? 'is-expired' : ''} ${state.recordDetail?.id === record.id ? 'selected' : ''}" data-record-id="${escapeHtml(record.id)}"><th scope="row"><button class="record-open" data-action="open-detail" data-record="${escapeHtml(record.id)}">${recordIdentity(record, true)}</button>${record.expired ? '<span class="tag expired-tag">已过期</span>' : ''}</th>${cells}<td><div class="table-row-actions">${record.secret_count ? `<button class="clear-button" data-action="open-secrets" data-record="${escapeHtml(record.id)}">敏感字段</button>` : ''}${state.canManage ? `<button class="clear-button" data-expired-record="${escapeHtml(record.id)}" data-expired="${record.expired}">${record.expired ? '恢复有效' : '标记过期'}</button>` : ''}</div></td></tr>`;
  }).join('');
  const width = 240 + 160 + fields.reduce((sum, field) => sum + (settings.widths[field.key] || 220), 0);
  return `<div class="record-table-scroll" role="region" aria-label="记录表格，可横向滚动" tabindex="0"><table class="record-table" style="width:${width}px"><caption>${escapeHtml(datasetName(dataset))} · 当前第 ${state.page} 页，${state.records.length} 条 / 共 ${state.total} 条</caption><thead><tr><th scope="col" style="width:240px">记录标识</th>${header}<th scope="col" style="width:160px">操作</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function captureQueryFilters() {
  return { q: state.query, categories: [...selectedCategories()], labels: [...selectedEnvironmentTags()],
    dataset_id: state.selectedDatasetId || null, schema_id: state.schemaFilter || null, include_expired: state.includeExpired };
}
function queryScopeMarkup(filters) {
  const dataset = state.datasets.find(item => item.id === filters.dataset_id);
  const model = state.catalog.schemas.find(item => item.id === filters.schema_id) || state.datasets.find(item => item.schema_id === filters.schema_id);
  const entries = [['搜索词', filters.q || '全部记录'], ['目录', filters.categories.length ? filters.categories.join('、') : '全部目录'], ['标签（同时满足）', filters.labels.length ? filters.labels.join('、') : '全部标签'], ['数据集', filters.dataset_id ? dataset ? datasetLocator(dataset) : '已不可用的数据集' : '范围内全部数据集'], ['数据模型', filters.schema_id ? model?.schema_name || model?.name || '已不可用的模型' : '全部模型'], ['记录范围', filters.include_expired ? '包含过期记录' : '仅有效记录']];
  return `<dl>${entries.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>`;
}
function renderQueryScopes() {
  $('#saved-query-current').innerHTML = queryScopeMarkup(captureQueryFilters());
  const selected = selectedSavedQuery();
  $('#saved-query-preview').innerHTML = selected ? `<h4>${escapeHtml(selected.name)}</h4>${queryScopeMarkup(selected.filters)}${unavailableQueryScope(selected.filters) ? `<p class="inline-error">${escapeHtml(unavailableQueryScope(selected.filters))}，应用前需要更新条件。</p>` : ''}` : '<p>选择查询以查看完整条件。</p>';
}
function openSavedQueries() {
  if (!state.unlocked || !state.canManage) return;
  renderQueryScopes(); openDialog('saved-queries-modal');
  $('.saved-queries-body').scrollTop = 0;
  loadSavedQueries();
}
function closeSavedQueries(force = false) {
  if (savedQuerySaving && !force) { savedQueryStatus('正在保存，请稍候；完成后可关闭。'); return false; }
  $('#saved-queries-modal').close();
  savedQueryFocus = null;
  if (state.unlocked && !force) $('#saved-queries-panel').focus();
  return true;
}
function selectedSavedQuery() { return savedQueries.find(query => query.id === $('#saved-query-select').value); }
function savedQueryStatus(message, error = false) {
  $('#saved-query-status').textContent = message;
  $('#saved-query-status').classList.toggle('inline-error', error);
}
function renderSavedQueries(selected = '') {
  $('#saved-query-select').innerHTML = '<option value="">选择已保存的查询</option>' + savedQueries.map(query => `<option value="${escapeHtml(query.id)}">${escapeHtml(query.name)}</option>`).join('');
  $('#saved-query-select').value = selected;
  renderQueryScopes(); updateSavedQueryButtons();
}
function updateSavedQueryButtons() {
  const dialog = $('#saved-queries-modal');
  if (savedQueryBusy && !savedQueryFocus && dialog.contains(document.activeElement)
    && document.activeElement.matches('#saved-query-apply, #saved-query-update, #saved-query-delete, #saved-query-create, #saved-query-refresh, #saved-query-select, #saved-query-name')) savedQueryFocus = document.activeElement;
  for (const id of ['saved-query-apply', 'saved-query-update', 'saved-query-delete']) $('#' + id).disabled = savedQueryBusy || !selectedSavedQuery();
  for (const id of ['saved-query-create', 'saved-query-refresh', 'saved-query-select', 'saved-query-name']) $('#' + id).disabled = savedQueryBusy;
  if (!savedQueryBusy) {
    if (dialog.open && savedQueryFocus && [document.body, dialog].includes(document.activeElement)) {
      (savedQueryFocus.disabled ? $('#saved-query-select') : savedQueryFocus).focus();
    }
    savedQueryFocus = null;
  }
}
async function loadSavedQueries() {
  if (!state.unlocked || !state.canManage || savedQueryBusy) return;
  const request = ++savedQueryRequest, epoch = state.sessionEpoch, selected = $('#saved-query-select').value;
  savedQueryStatus('正在加载常用查询…'); savedQueryBusy = true; updateSavedQueryButtons();
  try {
    const result = await api('/saved-queries');
    if (!state.unlocked || epoch !== state.sessionEpoch || request !== savedQueryRequest) return;
    if (!Array.isArray(result.queries)) throw new Error('常用查询响应无效');
    savedQueries = result.queries; renderSavedQueries(selected);
    savedQueryStatus(savedQueries.length ? `已保存 ${savedQueries.length} 个查询` : '暂无常用查询，可保存当前搜索词与全部筛选条件。');
  } catch (error) { if (state.unlocked && request === savedQueryRequest) savedQueryStatus(error.message, true); }
  finally { if (request === savedQueryRequest) { savedQueryBusy = false; updateSavedQueryButtons(); } }
}
function unavailableQueryScope(filters) {
  const datasets = state.datasets;
  if (filters.dataset_id && !datasets.some(dataset => dataset.id === filters.dataset_id)) return '原数据集已不可用';
  if (filters.schema_id && !datasets.some(dataset => dataset.schema_id === filters.schema_id)) return '原模型已不可用';
  if (filters.categories.some(path => !datasets.some(dataset => dataset.category_path === path || dataset.category_path.startsWith(path + '/')))) return '原目录已不可用';
  if (filters.labels.some(label => !datasets.some(dataset => datasetLabels(dataset).includes(label)))) return '原标签已不可用';
  const dataset = datasets.find(item => item.id === filters.dataset_id);
  if (dataset && ((filters.schema_id && dataset.schema_id !== filters.schema_id)
    || !filters.labels.every(label => datasetLabels(dataset).includes(label))
    || (filters.categories.length && !filters.categories.some(path => dataset.category_path === path || dataset.category_path.startsWith(path + '/'))))) return '原数据集已不属于保存的范围';
  return '';
}
async function applySavedQuery() {
  const query = selectedSavedQuery();
  if (!query || savedQueryBusy || !state.unlocked || !state.canManage) return;
  const filters = query.filters, unavailable = unavailableQueryScope(filters);
  if (unavailable) { savedQueryStatus(`${unavailable}。未应用查询；请调整当前筛选后更新此查询。`, true); return; }
  clearTimeout(state.searchTimer);
  closeRecordDetail();
  state.query = filters.q; $('#search-input').value = filters.q;
  state.category = filters.categories.length === 1 ? filters.categories[0] : 'all';
  state.categories = filters.categories.length > 1 ? [...filters.categories] : [];
  state.environment = 'all'; state.environmentTags = [...filters.labels];
  state.schemaFilter = filters.schema_id || ''; state.selectedDatasetId = filters.dataset_id;
  state.includeExpired = filters.include_expired; $('#include-expired').checked = filters.include_expired;
  const epoch = state.sessionEpoch, request = ++savedQueryRequest;
  savedQueryBusy = true; updateSavedQueryButtons();
  try {
    await refreshSearchScope();
    if (!state.unlocked || epoch !== state.sessionEpoch || request !== savedQueryRequest) return;
    const failed = !$('#search-error').hidden || state.searchOutcome === 'invalid';
    savedQueryStatus(failed ? state.searchOutcome === 'invalid' ? '条件尚未有效，未执行检索；请检查条件值或正则表达式。' : '条件已应用，但检索失败，请重试。' : `已应用“${query.name}”`, failed);
    if (!failed) closeSavedQueries();
  } finally { if (request === savedQueryRequest) { savedQueryBusy = false; updateSavedQueryButtons(); } }
}
async function saveQuery(mode) {
  if (!state.unlocked || !state.canManage || savedQueryBusy) return;
  const selected = selectedSavedQuery(), name = $('#saved-query-name').value.trim();
  if (mode !== 'create' && !selected) return;
  if (mode !== 'delete' && (!name || [...name].length > 80)) { savedQueryStatus('请输入 1 至 80 字的查询名称。', true); $('#saved-query-name').focus(); return; }
  const epoch = state.sessionEpoch, request = ++savedQueryRequest;
  savedQueryBusy = true; savedQuerySaving = true; updateSavedQueryButtons(); savedQueryStatus('正在保存…');
  try {
    const result = await api('/saved-queries' + (mode === 'create' ? '' : `/${encodeURIComponent(selected.id)}`), {
      method: mode === 'create' ? 'POST' : mode === 'delete' ? 'DELETE' : 'PATCH',
      ...(mode === 'delete' ? {} : { body: JSON.stringify({ name, filters: captureQueryFilters() }) })
    });
    if (!state.unlocked || epoch !== state.sessionEpoch || request !== savedQueryRequest) return;
    if (mode === 'delete') savedQueries = savedQueries.filter(query => query.id !== selected.id);
    else { savedQueries = savedQueries.filter(query => query.id !== result.id); savedQueries.push(result); }
    renderSavedQueries(mode === 'delete' ? '' : result.id);
    if (mode === 'delete') $('#saved-query-name').value = '';
    savedQueryStatus(mode === 'delete' ? '已删除常用查询，当前搜索条件保留。' : '已保存当前搜索词和全部筛选条件。');
  } catch (error) { if (state.unlocked && request === savedQueryRequest) savedQueryStatus(error.message, true); }
  finally { if (request === savedQueryRequest) { savedQueryBusy = false; savedQuerySaving = false; updateSavedQueryButtons(); } }
}
function clearSearchTools() {
  savedQueryRequest++; savedQueryBusy = false; savedQuerySaving = false; savedQueries = []; resultView = 'summary'; tablePreferences.clear();
  clearTimeout(state.searchTimer); state.query = ''; $('#search-input').value = '';
  closeSavedQueries(true); $('#saved-query-name').value = '';
  renderSavedQueries(); savedQueryStatus('');
  $('#saved-query-current').replaceChildren(); $('#saved-query-preview').replaceChildren();
  $('#table-column-list').replaceChildren(); $('#table-columns').open = false; $('#table-columns').hidden = true;
  $('#result-view').value = 'summary'; $('.density-select').hidden = false; $('#records-grid').classList.remove('table-results');
}

$('#result-view').addEventListener('change', event => { resultView = event.target.value; renderRecords(); });
$('#table-column-list').addEventListener('change', event => {
  const dataset = activeRecordTableDataset(); if (!dataset) return;
  const settings = tableSettings(dataset), input = event.target;
  if (input.matches('[data-table-column]')) settings.keys = input.checked ? [...settings.keys, input.dataset.tableColumn] : settings.keys.filter(key => key !== input.dataset.tableColumn);
  if (input.matches('[data-table-width]')) settings.widths[input.dataset.tableWidth] = Math.max(120, Math.min(640, Number(input.value) || 220));
  const attribute = input.matches('[data-table-column]') ? 'data-table-column' : 'data-table-width', key = input.getAttribute(attribute);
  renderRecords();
  [...$('#table-column-list').querySelectorAll(`[${attribute}]`)].find(control => control.getAttribute(attribute) === key)?.focus();
});
$('#table-columns-reset').addEventListener('click', () => { const dataset = activeRecordTableDataset(); if (dataset) { tablePreferences.delete(dataset.id); renderRecords(); } });
$('#saved-queries-panel').addEventListener('click', openSavedQueries);
$('#close-saved-queries').addEventListener('click', () => closeSavedQueries());
$('#saved-queries-modal').addEventListener('cancel', event => { event.preventDefault(); closeSavedQueries(); });
$('#saved-query-refresh').addEventListener('click', loadSavedQueries);
$('#saved-query-select').addEventListener('change', () => { $('#saved-query-name').value = selectedSavedQuery()?.name || ''; renderQueryScopes(); updateSavedQueryButtons(); });
$('#saved-query-apply').addEventListener('click', applySavedQuery);
for (const mode of ['create', 'update', 'delete']) $('#saved-query-' + mode).addEventListener('click', () => saveQuery(mode));
if (state.unlocked) renderRecords();
