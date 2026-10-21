// Manual record editing and the independent per-dataset supplementary table.
let supplementState = null;
let manualEditState = null;
let supplementRequest = 0;
let manualEditRequest = 0;
let manualParentRequest = 0;
const supplementReveals = new Map();

function clearManualData() {
  setFormBusy($('#manual-record-modal'), false);
  supplementRequest++;
  manualEditRequest++;
  supplementState = null;
  manualEditState = null;
  supplementReveals.forEach((entry) => clearTimeout(entry.timer));
  supplementReveals.clear();
  $('#supplement-modal').hidden = true;
  $('#manual-record-modal').hidden = true;
  $('#supplement-schema-fields').replaceChildren();
  $('#supplement-records').replaceChildren();
  $('#manual-record-fields').replaceChildren();
  $('#manual-record-context').textContent = '';
  $('#manual-change-summary').textContent = '';
  $('#manual-record-error').textContent = ''; $('#manual-record-error').hidden = true;
  $('#manual-parent-id').value = '';
  $('#manual-parent-search').value = '';
  $('#manual-parent-options').replaceChildren();
  clearManualParents();
}

function bindSupplementSecrets(container) {
  container.querySelectorAll('[data-supplement-reveal]').forEach((button) => button.addEventListener('click', async () => {
    const { supplementReveal: id, field } = button.dataset;
    const key = `${id}\x1f${field}`;
    const output = button.parentElement.querySelector('.supplement-secret-value');
    const previous = supplementReveals.get(key);
    if (previous) { clearTimeout(previous.timer); supplementReveals.delete(key); output.textContent = '••••••••'; button.textContent = '查看'; return; }
    button.disabled = true;
    const request = supplementRequest;
    try {
      const result = await api(`/supplement/${encodeURIComponent(id)}/secrets/reveal`, { method: 'POST', body: JSON.stringify({ field_name: field }) });
      if (!state.unlocked || !output.isConnected || request !== supplementRequest) return;
      output.textContent = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
      button.textContent = '隐藏（30 秒）';
      const timer = setTimeout(() => { output.textContent = '••••••••'; button.textContent = '查看'; supplementReveals.delete(key); }, 30000);
      supplementReveals.set(key, { timer });
    } catch (error) { showToast(error.message, 'error'); }
    finally { button.disabled = false; }
  }));
}

function supplementMarkup(row, fields, manage = false, showLink = true) {
  const labels = Object.fromEntries(fields.map((field) => [field.source_key, field.display_name || field.source_key]));
  const secrets = row.protected_fields.map((field) => `<div class="detail-row protected"><span>${escapeHtml(labels[field.field_name] || field.field_name)}<small>${field.zone === 'secrets' ? '敏感字段' : '隐藏加密字段'}</small></span><strong><span class="supplement-secret-value">••••••••</span>${field.zone === 'secrets' ? `<button class="detail-secret-button" data-supplement-reveal="${escapeHtml(row.id)}" data-field="${escapeHtml(field.field_name)}">查看</button>` : '<small>仅加密存储，不可查看</small>'}</strong></div>`).join('');
  const linkInfo = showLink ? `<header><strong>${row.orphan ? '失联记录' : '已关联'}</strong><code>${escapeHtml(row.main_record_id)}</code><span>${escapeHtml(row.updated)}</span></header><p class="dataset-info-note">${escapeHtml(row.link.mode === 'id' ? '系统主键关联' : '索引关联')}：${escapeHtml(JSON.stringify(row.link.values))}</p>` : '';
  return `<article class="supplement-row ${row.orphan ? 'is-orphan' : ''}">${linkInfo}${detailRows(row.values, labels)}${secrets}${manage ? `<div class="row-actions">${!row.orphan ? `<button class="secondary-button" data-supplement-parent="${escapeHtml(row.main_record_id)}">查看主记录</button>` : ''}<button class="secondary-button" data-supplement-edit="${escapeHtml(row.id)}">编辑 / 重新关联</button><button class="secondary-button danger-button" data-supplement-delete="${escapeHtml(row.id)}">删除</button></div>` : ''}</article>`;
}

function renderRecordSupplement(detail) {
  const target = $('#record-supplement-content');
  if (!target) return;
  const fields = detail.supplement_fields || [];
  target.innerHTML = (detail.supplement_records || []).map((row) => supplementMarkup(row, fields, false, false)).join('') || '<p class="detail-empty">暂无附表记录</p>';
  if (state.canManage) {
    const tools = document.createElement('div');
    tools.className = 'row-actions';
    const existing = (detail.supplement_records || [])[0];
    tools.innerHTML = `<button class="secondary-button" data-edit-supplement>${existing ? '编辑附表' : '＋ 添加附表'}</button><button class="secondary-button" data-open-supplement>管理附表</button>`;
    target.appendChild(tools);
    tools.querySelector('[data-edit-supplement]').addEventListener('click', async () => {
      await openSupplement(detail.dataset_id, false);
      if (supplementState) openManualRecord('supplement', detail.dataset_id, existing?.id || null, detail.id, detail.id);
    });
    tools.querySelector('[data-open-supplement]').addEventListener('click', () => openSupplement(detail.dataset_id));
  }
  bindSupplementSecrets(target);
}

async function openSupplement(datasetId, visible = true) {
  const request = ++supplementRequest;
  try {
    const result = await api(`/datasets/${encodeURIComponent(datasetId)}/supplement`);
    if (!state.unlocked || request !== supplementRequest) return;
    if (supplementState?.datasetId !== datasetId) $('#supplement-only-orphans').checked = false;
    supplementState = { ...result, datasetId };
    if (visible) {
      supplementReveals.forEach((entry) => clearTimeout(entry.timer));
      supplementReveals.clear();
      closeRecordDetail();
      $('#supplement-title').textContent = `${state.datasets.find((item) => item.id === datasetId)?.category_path || ''} · 附表`;
      $('#supplement-modal').hidden = false;
      renderSupplement();
    }
  } catch (error) { showToast(error.message, 'error'); }
}

function closeSupplement() {
  supplementRequest++;
  supplementReveals.forEach((entry) => clearTimeout(entry.timer));
  supplementReveals.clear();
  supplementState = null;
  $('#supplement-modal').hidden = true;
  $('#supplement-schema-fields').replaceChildren();
  $('#supplement-records').replaceChildren();
}

function renderSupplement(keepSchema = false) {
  const table = supplementState;
  if (!table) return;
  const orphanCount = table.records.filter((row) => row.orphan).length;
  $('#supplement-link-status').textContent = `关联依据：${table.link_mode === 'id' ? '主表系统主键' : table.link_fields.join(' + ')} · ${table.records.length} 条附表记录 · ${orphanCount} 条失联记录`;
  $('#supplement-cleanup').disabled = !orphanCount || !state.canManage;
  $('#supplement-new').disabled = !table.fields.some((field) => field.zone !== 'ignore') || !state.canManage;
  const dataset = state.datasets.find(item => item.id === table.datasetId);
  $('#supplement-schema-panel').hidden = !state.canManage || Boolean(dataset?.schema_id);
  let sharedEntry = $('#supplement-shared-schema');
  if (!sharedEntry) {
    sharedEntry = document.createElement('button'); sharedEntry.id = 'supplement-shared-schema'; sharedEntry.className = 'secondary-button';
    sharedEntry.textContent = '编辑共享附表结构'; $('#supplement-schema-panel').before(sharedEntry);
    sharedEntry.addEventListener('click', () => {
      const current = state.datasets.find(item => item.id === supplementState?.datasetId);
      if (current?.schema_id) openSharedSchemaEditor(current.schema_id);
    });
  }
  sharedEntry.hidden = !state.canManage || !dataset?.schema_id;
  if (!keepSchema) $('#supplement-schema-fields').innerHTML = table.fields.map((field) => supplementSchemaRow(field)).join('');
  const onlyOrphans = $('#supplement-only-orphans').checked;
  $('#supplement-records').innerHTML = table.records.filter((row) => !onlyOrphans || row.orphan).map((row) => supplementMarkup(row, table.fields, state.canManage)).join('') || '<p class="detail-empty">暂无记录</p>';
  bindSupplementSchemaRows();
  bindSupplementSecrets($('#supplement-records'));
  $('#supplement-records').querySelectorAll('[data-supplement-edit]').forEach((button) => button.addEventListener('click', () => openManualRecord('supplement', table.datasetId, button.dataset.supplementEdit)));
  $('#supplement-records').querySelectorAll('[data-supplement-parent]').forEach((button) => button.addEventListener('click', () => { closeSupplement(); openRecordDetail(button.dataset.supplementParent); }));
  $('#supplement-records').querySelectorAll('[data-supplement-delete]').forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('删除这条附表记录？此操作不会删除主表数据。')) return;
    try { await api(`/datasets/${encodeURIComponent(table.datasetId)}/supplement/records/${encodeURIComponent(button.dataset.supplementDelete)}`, { method: 'DELETE' }); await refreshAfterWrite(); await openSupplement(table.datasetId); } catch (error) { showToast(error.message, 'error'); }
  }));
}

function supplementSchemaRow(field = { source_key: '', display_name: '', zone: 'normal' }) {
  return `<div class="supplement-schema-row" data-original-source="${escapeHtml(field.source_key)}"><input class="supplement-source" aria-label="附表字段名" placeholder="字段名" value="${escapeHtml(field.source_key)}"><input class="supplement-label" aria-label="附表字段显示名称" placeholder="可读名称" value="${escapeHtml(field.display_name)}"><select class="supplement-zone" aria-label="附表字段区域">${fieldZoneOptions(field.zone)}</select><button class="secondary-button" type="button" data-remove-supplement-field aria-label="移除字段">×</button></div>`;
}
function bindSupplementSchemaRows() {
  $('#supplement-schema-fields').querySelectorAll('[data-remove-supplement-field]').forEach((button) => { button.onclick = () => button.closest('.supplement-schema-row').remove(); });
}
async function saveSupplementSchema() {
  if (!supplementState || !state.canManage) return;
  const datasetId = supplementState.datasetId;
  const fields = [...$('#supplement-schema-fields').querySelectorAll('.supplement-schema-row')].map((row, position) => ({ source_key: row.querySelector('.supplement-source').value.trim(), previous_source_key: row.dataset.originalSource || null, display_name: row.querySelector('.supplement-label').value.trim(), zone: row.querySelector('.supplement-zone').value, position, unique: false }));
  if (fields.some((field) => !field.source_key) || new Set(fields.map((field) => field.source_key)).size !== fields.length) { showToast('字段名不能为空或重复', 'error'); return; }
  if (supplementState.fields.some((old) => !fields.some((next) => (next.previous_source_key || next.source_key) === old.source_key && next.zone !== 'ignore')) && !window.confirm('移除或忽略字段将清除该字段的所有附表数据，是否保存？')) return;
  $('#supplement-save-schema').disabled = true;
  try { await api(`/datasets/${encodeURIComponent(datasetId)}/supplement`, { method: 'PATCH', body: JSON.stringify({ fields }) }); await refreshAfterWrite(); await openSupplement(datasetId); showToast('附表字段已保存', 'success'); } catch (error) { showToast(error.message, 'error'); }
  finally { $('#supplement-save-schema').disabled = false; }
}

function manualFieldRow(field, values, index = 0, required = false) {
  const exists = Object.hasOwn(values, field.source_key), value = values[field.source_key];
  const jsonValue = exists && typeof value !== 'string';
  const protectedField = ['secrets', 'hidden'].includes(field.zone);
  const text = exists ? (jsonValue ? JSON.stringify(value, null, 2) : value) : '';
  const label = field.display_name || field.source_key, multiline = (value !== null && typeof value === 'object') || /[\r\n]/.test(text) || text.length > 160;
  const editor = multiline ? `<textarea rows="${jsonValue ? 4 : 3}"` : `<input type="${protectedField ? 'password' : 'text'}"`;
  return `<div class="manual-field" data-source="${escapeHtml(field.source_key)}" data-error-id="manual-field-error-${index}" data-action="keep" data-null-blocked="${required}"><label for="manual-field-${index}" class="manual-field-label"><strong>${escapeHtml(label)}<span class="manual-change-mark" aria-hidden="true" hidden> *</span></strong><span class="manual-field-meta">${label !== field.source_key ? `<code>${escapeHtml(field.source_key)}</code>` : ''}${required ? '<span class="manual-required">KEY · 必填</span>' : ''}<span class="manual-zone">${escapeHtml({indexes:'索引', display:'展示', normal:'普通', secrets:'敏感', hidden:'隐藏加密'}[field.zone] || field.zone)}</span></span><span class="manual-field-state" hidden></span></label><div class="manual-field-editor">${editor} id="manual-field-${index}" class="manual-value" aria-label="${escapeHtml(label)}" spellcheck="false" autocomplete="off" placeholder="${protectedField ? '输入新值才修改，默认保留' : '输入后自动标记为修改'}"${multiline ? `>${escapeHtml(text)}</textarea>` : ` value="${escapeHtml(text)}">`}<p id="manual-field-error-${index}" class="manual-field-error" role="alert" hidden></p></div><div class="manual-field-actions"><button type="button" class="manual-field-icon manual-undo" aria-label="撤回 ${escapeHtml(label)} 的修改" title="撤回 ${escapeHtml(label)} 的修改" hidden>${svgIcon('undo')}</button><button type="button" class="manual-field-icon manual-clear" aria-label="清空 ${escapeHtml(label)}（设为 null）${required ? '，逻辑 KEY 必填，不可清空' : ''}" title="${required ? '逻辑 KEY 必填，不可清空' : `清空 ${escapeHtml(label)}（设为 null）`}" aria-pressed="false"${required ? ' aria-disabled="true"' : ''}>${svgIcon('clearValue')}</button></div><details class="manual-field-options action-disclosure"><summary aria-label="${escapeHtml(label)}的字段设置" title="字段设置">${svgIcon('more')}<span class="manual-type-caption sr-only">${jsonValue ? 'JSON' : '文本'}</span></summary><div class="action-disclosure-content manual-field-settings"><strong>字段设置</strong><label>输入格式<select class="manual-type" aria-label="${escapeHtml(label)}值类型"><option value="text" ${!jsonValue ? 'selected' : ''}>文本</option><option value="json" ${jsonValue ? 'selected' : ''}>JSON / 数字 / 布尔</option></select></label><button type="button" class="clear-button manual-expand" aria-label="${escapeHtml(label)}使用多行输入${protectedField ? '（显示输入内容）' : ''}" ${multiline ? 'hidden' : ''}>使用多行输入${protectedField ? '（显示内容）' : ''}</button><small>仅影响当前值，不修改数据模型。</small></div></details></div>`;
}
function expandManualField(row) {
  const input = row.querySelector('.manual-value');
  if (input.tagName === 'TEXTAREA') return;
  const textarea = document.createElement('textarea');
  for (const attribute of input.attributes) if (attribute.name !== 'type' && attribute.name !== 'value') textarea.setAttribute(attribute.name, attribute.value);
  textarea.value = input.value; textarea.rows = 4; textarea.disabled = input.disabled;
  input.replaceWith(textarea); row.querySelector('.manual-expand').hidden = true;
}
function syncManualField(row, reset = false) {
  const original = manualEditState?.originalFields.get(row.dataset.source); if (!original) return;
  const input = row.querySelector('.manual-value'), type = row.querySelector('.manual-type');
  if (reset) { input.value = original.value; type.value = original.type; row.dataset.action = 'keep'; }
  const action = row.dataset.action;
  row.querySelector('.manual-type-caption').textContent = type.value === 'json' ? 'JSON' : '文本';
  input.disabled = action === 'null'; type.disabled = action === 'null';
  row.querySelector('.manual-expand').disabled = action === 'null';
  input.placeholder = action === 'null' ? '保存后设为 null' : original.placeholder;
  row.querySelector('.manual-undo').hidden = action === 'keep';
  row.querySelector('.manual-clear').setAttribute('aria-pressed', String(action === 'null'));
  row.querySelector('.manual-change-mark').hidden = action === 'keep';
  const status = row.querySelector('.manual-field-state');
  status.hidden = action === 'keep'; status.textContent = action === 'null' ? '待清空 · null' : action === 'write' ? '已修改' : '';
  input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
  row.querySelector('.manual-field-error').hidden = true;
  updateManualSummary();
}
function updateManualSummary() {
  if (!manualEditState) return;
  const rows = [...$('#manual-record-fields').querySelectorAll('.manual-field')];
  const writing = rows.filter(row => row.dataset.action === 'write'), clearing = rows.filter(row => row.dataset.action === 'null');
  $('#manual-change-summary').textContent = `待保存：修改 ${writing.length} 个字段 · 清空 ${clearing.length} 个值 · 保留 ${rows.length - writing.length - clearing.length} 个字段` + (clearing.length ? `。将设为 null：${clearing.map(row => row.querySelector('label strong').textContent.replace(/ \*$/, '')).join('、')}` : '');
}
// Locate syntax errors even in browsers whose JSON.parse message omits an offset.
function manualJsonErrorOffset(raw) {
  let i = 0;
  const stack = [{ kind: 'root', expect: 'value' }];
  const string = () => {
    i++;
    while (i < raw.length) {
      const ch = raw[i++];
      if (ch === '"') return true;
      if (ch.charCodeAt(0) < 32) { i--; return false; }
      if (ch === '\\') {
        if (raw[i] === 'u') { i++; for (let n = 0; n < 4; n++, i++) if (!/[0-9a-f]/i.test(raw[i] || '')) return false; }
        else if ('"\\/bfnrt'.includes(raw[i] || '') && i < raw.length) i++;
        else return false;
      }
    }
    return false;
  };
  while (stack.length) {
    while (/[ \t\r\n]/.test(raw[i] || '') && i < raw.length) i++;
    const top = stack.at(-1), ch = raw[i];
    if (top.expect === 'end') return i;
    if (top.expect === 'key' || top.expect === 'firstKey') {
      if (ch === '}' && top.expect === 'firstKey') { i++; stack.pop(); continue; }
      if (ch !== '"' || !string()) return i;
      top.expect = 'colon'; continue;
    }
    if (top.expect === 'colon') { if (ch !== ':') return i; i++; top.expect = 'value'; continue; }
    if (top.expect === 'comma') {
      if (ch === (top.kind === 'object' ? '}' : ']')) { i++; stack.pop(); continue; }
      if (ch !== ',') return i;
      i++; top.expect = top.kind === 'object' ? 'key' : 'value'; continue;
    }
    if (top.expect === 'firstValue' && ch === ']') { i++; stack.pop(); continue; }
    top.expect = top.kind === 'root' ? 'end' : 'comma';
    if (ch === '{' || ch === '[') { i++; stack.push({ kind: ch === '{' ? 'object' : 'array', expect: ch === '{' ? 'firstKey' : 'firstValue' }); continue; }
    if (ch === '"') { if (!string()) return i; continue; }
    const literal = { t: 'true', f: 'false', n: 'null' }[ch];
    if (literal) { for (const letter of literal) { if (raw[i] !== letter) return i; i++; } continue; }
    const number = raw.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (!number) return i;
    i += number[0].length;
  }
  return i;
}
function parseManualJson(row, raw) {
  try { return JSON.parse(raw); }
  catch (error) {
    const position = Number(error.message.match(/position (\d+)/)?.[1] ?? manualJsonErrorOffset(raw));
    const direct = error.message.match(/line (\d+) column (\d+)/);
    const before = raw.slice(0, position), lines = before.split('\n');
    const location = direct ? `第 ${direct[1]} 行、第 ${direct[2]} 列` : `第 ${lines.length} 行、第 ${lines.at(-1).length + 1} 列附近`;
    const input = row.querySelector('.manual-value'), output = row.querySelector('.manual-field-error');
    output.textContent = `“${row.querySelector('label strong').textContent}”JSON 格式无效：${location}。`;
    output.hidden = false; input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', output.id); input.focus();
    const validation = new Error(output.textContent); validation.manualFieldValidation = true; throw validation;
  }
}

async function openManualRecord(kind, datasetId, recordId = null, parentId = null, returnRecordId = null) {
  if (!state.canManage) return;
  if (manualEditState && !closeManualRecord()) return;
  const request = ++manualEditRequest;
  try {
    const dataset = state.datasets.find((item) => item.id === datasetId);
    if (!dataset) return;
    let definitions, values, row;
    if (kind === 'main') {
      definitions = dataset.fields;
      const detail = recordId ? await api(`/records/${encodeURIComponent(recordId)}`) : {};
      row = detail;
      values = { ...detail.indexes, ...detail.display, ...detail.normal };
    } else {
      if (supplementState?.datasetId !== datasetId) await openSupplement(datasetId, false);
      if (!supplementState) return;
      definitions = supplementState.fields;
      row = supplementState.records.find((item) => recordId ? item.id === recordId : parentId && !item.orphan && item.main_record_id === parentId);
      recordId = row?.id || recordId;
      values = row?.values || {};
    }
    if (!state.unlocked || request !== manualEditRequest) return;
    manualEditState = { kind, datasetId, recordId, returnRecordId, fields: definitions, busy: false, parentPage: 1, parentRows: [], parentSelection: null, originalFields: new Map() };
    $('#manual-record-title').textContent = `${recordId ? '编辑' : '新增'}${kind === 'main' ? '主表' : '附表'}记录`;
    $('#manual-record-context').textContent = `${datasetName(dataset)} · ${recordId ? (kind === 'main' ? recordIdentity({ ...row, id: recordId, dataset_id: datasetId }) : '附表记录') : '新记录'} · ${dataset.category_path}`;
    $('#manual-record-help').textContent = kind === 'main' ? '未编辑字段保留原值；批量导入可能覆盖手工修改。' : '附表数据独立保存，主表导入不会覆盖。每条主记录最多关联一条附表记录，不同用途通过附表字段扩展。';
    $('#manual-parent-picker').hidden = kind !== 'supplement';
    $('#manual-parent-id').value = parentId || row?.main_record_id || '';
    $('#manual-parent-id').dataset.original = row?.main_record_id || '';
    clearManualParents();
    $('#manual-parent-search').value = '';
    $('#manual-parent-options').innerHTML = '<option value="">检索并选择主记录，或保留当前关联</option>';
    $('#manual-record-fields').innerHTML = definitions.filter((field) => field.zone !== 'ignore').sort((a,b) => a.position - b.position).map((field, index) => manualFieldRow(field, values, index, kind === 'main' && (dataset.identity_fields || []).includes(field.source_key))).join('') || '<p>请先配置字段，再新增记录。</p>';
    wireActionDisclosures($('#manual-record-fields'));
    for (const row of $('#manual-record-fields').querySelectorAll('.manual-field')) manualEditState.originalFields.set(row.dataset.source, { value: row.querySelector('.manual-value').value, type: row.querySelector('.manual-type').value, placeholder: row.querySelector('.manual-value').placeholder, isNull: Object.hasOwn(values, row.dataset.source) && values[row.dataset.source] === null });
    $('#manual-record-error').textContent = ''; $('#manual-record-error').hidden = true;
    updateManualSummary();
    manualEditState.initial = manualRecordDraft();
    $('#manual-record-modal').hidden = false;
    $('#manual-record-modal .manual-record-body').scrollTop = 0;
    closeRecordDetail();
    if (kind === 'supplement') await searchManualParents();
  } catch (error) { showToast(error.message, 'error'); }
}

function clearManualParents() {
  manualParentRequest++;
  for (const id of ['manual-parent-results', 'manual-parent-selected', 'manual-parent-status', 'manual-parent-page']) $('#' + id).replaceChildren();
  $('#manual-parent-advanced').open = false;
  $('#manual-parent-prev').disabled = true; $('#manual-parent-next').disabled = true;
}
function parentOccupied(record) {
  return Boolean(record.supplement?.id && record.supplement.id !== manualEditState?.recordId)
    || Boolean(record.supplement_records?.some(row => row.id !== manualEditState?.recordId));
}
function parentIdentity(record) {
  return recordIdentity({ ...record, dataset_id: manualEditState?.datasetId });
}
function renderSelectedParent() {
  if (!manualEditState) return;
  const id = $('#manual-parent-id').value.trim(), selected = manualEditState.parentSelection;
  const original = $('#manual-parent-id').dataset.original;
  $('#manual-parent-selected').innerHTML = selected?.id === id
    ? `<strong>已选择：${escapeHtml(parentIdentity(selected))}</strong>${selected.expired ? '<span class="tag expired-tag">已过期</span>' : ''}<small>${id === original ? '保留当前关联' : original ? '保存后将替换原关联' : '保存后建立关联'}</small>`
    : `<strong>${id ? '当前关联尚未载入识别信息' : '尚未选择主记录'}</strong>${id ? `<small>${escapeHtml(id)}${id === original ? ' · 如原记录已删除，可检索后重新关联' : ' · 保存前将验证此 ID'}</small>` : ''}`;
}
function selectManualParent(record) {
  if (!manualEditState || manualEditState.busy || parentOccupied(record)) return;
  $('#manual-parent-id').value = record.id;
  manualEditState.parentSelection = record;
  $('#manual-parent-options').value = record.id;
  renderManualParentResults(); renderSelectedParent();
}
function renderManualParentResults() {
  const editing = manualEditState; if (!editing) return;
  $('#manual-parent-results').innerHTML = editing.parentRows.map(record => {
    const occupied = parentOccupied(record), selected = record.id === $('#manual-parent-id').value;
    const values = publicRecordValues(record), dataset = state.datasets.find(d => d.id === editing.datasetId);
    const fields = Object.entries(values).filter(([key]) => dataset?.fields.some(field => field.source_key === key && ['indexes', 'display'].includes(field.zone)));
    return `<article class="parent-result ${selected ? 'selected' : ''}"><div><strong>${escapeHtml(parentIdentity(record))}</strong>${record.expired ? '<span class="tag expired-tag">已过期</span>' : ''}<details><summary>查看识别信息</summary><dl>${fields.map(([key, value]) => `<dt>${escapeHtml(dataset.fields.find(field => field.source_key === key)?.display_name || key)}</dt><dd>${escapeHtml(valueString(value))}</dd>`).join('')}</dl><small>系统 ID：${escapeHtml(record.id)}</small></details></div><button class="secondary-button" data-parent-select="${escapeHtml(record.id)}" aria-pressed="${selected}" ${occupied || editing.busy ? 'disabled' : ''}>${occupied ? '已有附表' : selected ? '已选择' : '选择此记录'}</button></article>`;
  }).join('');
}
async function searchManualParents(page = 1) {
  if (!manualEditState || manualEditState.busy) return;
  const editing = manualEditState, request = ++manualParentRequest;
  page = Number.isInteger(page) ? Math.max(1, page) : 1;
  editing.parentRows = []; renderManualParentResults(); renderSelectedParent();
  $('#manual-parent-options').replaceChildren();
  $('#manual-parent-status').textContent = '正在检索主记录…';
  $('#manual-parent-prev').disabled = true; $('#manual-parent-next').disabled = true;
  try {
    const params = new URLSearchParams({ dataset_id: editing.datasetId, q: $('#manual-parent-search').value, include_expired: 'true', limit: '10', page: String(page) });
    const result = await api(`/records/search?${params}`);
    if (manualEditState !== editing || !state.unlocked || request !== manualParentRequest) return;
    if (!Array.isArray(result.records)) throw new Error('主记录检索响应无效');
    editing.parentRows = result.records; editing.parentPage = page;
    const selected = result.records.find(record => record.id === $('#manual-parent-id').value && !parentOccupied(record));
    if (selected) editing.parentSelection = selected;
    $('#manual-parent-options').innerHTML = '<option value="">选择当前页主记录</option>' + result.records.map(record => `<option value="${escapeHtml(record.id)}" ${record.id === $('#manual-parent-id').value ? 'selected' : ''} ${parentOccupied(record) ? 'disabled' : ''}>${escapeHtml(parentIdentity(record))} · ${escapeHtml(record.id)}${parentOccupied(record) ? '（已有附表）' : ''}</option>`).join('');
    const total = Number.isFinite(result.total) ? result.total : result.records.length, pages = Math.max(1, Math.ceil(total / 10));
    $('#manual-parent-status').textContent = total ? `${total} 条匹配记录 · 已有关联附表的记录不可选择` : '没有匹配的主记录，请调整搜索词。';
    $('#manual-parent-page').textContent = `第 ${page} / ${pages} 页`;
    $('#manual-parent-prev').disabled = page <= 1; $('#manual-parent-next').disabled = page >= pages;
    renderManualParentResults(); renderSelectedParent();
  } catch (error) {
    if (manualEditState === editing && state.unlocked && request === manualParentRequest) $('#manual-parent-status').textContent = `检索失败：${error.message}。可重新点击检索。`;
  }
}
async function verifyManualParent() {
  const editing = manualEditState; if (!editing) return null;
  const id = $('#manual-parent-id').value.trim();
  if (!id) throw new Error('请先选择关联的主记录');
  const result = await api(`/records/${encodeURIComponent(id)}`);
  if (manualEditState !== editing || !state.unlocked || $('#manual-parent-id').value.trim() !== id) return null;
  if (result.id !== id || result.dataset_id !== editing.datasetId) throw new Error('主记录不存在或不属于当前数据集');
  if (parentOccupied(result)) throw new Error('此主记录已有附表，请选择其他记录');
  editing.parentSelection = result; renderSelectedParent();
  return result;
}

function manualRecordDraft() {
  return JSON.stringify([$('#manual-parent-id').value, [...$('#manual-record-fields').querySelectorAll('.manual-field')].map(row => [row.dataset.source, row.dataset.action, row.querySelector('.manual-value').value, row.querySelector('.manual-type').value])]);
}
function manualRecordDirty() {
  return Boolean(manualEditState && manualEditState.initial !== manualRecordDraft());
}
function closeManualRecord(force = false) {
  if (force !== true && !confirmDiscardChanges(manualRecordDirty(), '记录修改', manualEditState?.busy)) return false;
  setFormBusy($('#manual-record-modal'), false);
  manualEditRequest++;
  manualEditState = null;
  $('#manual-record-modal').hidden = true;
  $('#manual-record-fields').replaceChildren();
  $('#manual-record-context').textContent = '';
  $('#manual-change-summary').textContent = '';
  $('#manual-record-error').textContent = ''; $('#manual-record-error').hidden = true;
  $('#manual-parent-id').value = '';
  $('#manual-parent-search').value = '';
  $('#manual-parent-options').replaceChildren();
  clearManualParents();
  return true;
}
async function saveManualRecord() {
  const editing = manualEditState;
  if (!editing || editing.busy || !state.canManage) return;
  const values = Object.create(null), unset_fields = [];
  $('#manual-record-error').hidden = true;
  try {
    $('#manual-record-fields').querySelectorAll('.manual-field').forEach((row) => {
      const key = row.dataset.source;
      const action = row.dataset.action;
      if (action === 'null') values[key] = null;
      else if (action === 'write') { const raw = row.querySelector('.manual-value').value; values[key] = row.querySelector('.manual-type').value === 'json' ? parseManualJson(row, raw) : raw; }
    });
    const body = { values, unset_fields };
    const parent = $('#manual-parent-id').value.trim();
    if (editing.kind === 'supplement' && (!editing.recordId || parent !== $('#manual-parent-id').dataset.original)) {
      editing.busy = true; manualParentRequest++; setFormBusy($('#manual-record-modal'), true);
      if (!await verifyManualParent()) return;
    }
    if (editing.kind === 'supplement' && (!editing.recordId || parent !== $('#manual-parent-id').dataset.original)) body.main_record_id = parent;
    const path = editing.kind === 'main' ? (editing.recordId ? `/records/${encodeURIComponent(editing.recordId)}` : `/datasets/${encodeURIComponent(editing.datasetId)}/records`) : `/datasets/${encodeURIComponent(editing.datasetId)}/supplement/records${editing.recordId ? `/${encodeURIComponent(editing.recordId)}` : ''}`;
    editing.busy = true;
    setFormBusy($('#manual-record-modal'), true);
    const result = await api(path, { method: editing.recordId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    if (manualEditState !== editing || !state.unlocked) return;
    closeManualRecord(true);
    if (editing.kind === 'main') { await refreshAfterWrite(); await openRecordDetail(result.id); }
    else {
      await refreshAfterWrite();
      if (editing.returnRecordId) await openRecordDetail(editing.returnRecordId);
      else await openSupplement(editing.datasetId);
    }
    showToast('记录已保存', 'success');
  } catch (error) { if (manualEditState === editing && state.unlocked && !error.manualFieldValidation) { $('#manual-record-error').textContent = error.message; $('#manual-record-error').hidden = false; } }
  finally {
    if (manualEditState === editing) { editing.busy = false; setFormBusy($('#manual-record-modal'), false); }
  }
}

$('#close-supplement').addEventListener('click', closeSupplement);
$('#supplement-add-field').addEventListener('click', () => { $('#supplement-schema-fields').insertAdjacentHTML('beforeend', supplementSchemaRow()); bindSupplementSchemaRows(); });
$('#supplement-save-schema').addEventListener('click', saveSupplementSchema);
$('#supplement-only-orphans').addEventListener('change', () => renderSupplement(true));
$('#supplement-new').addEventListener('click', () => { if (supplementState) openManualRecord('supplement', supplementState.datasetId); });
$('#supplement-cleanup').addEventListener('click', async () => {
  if (!supplementState || !state.canManage || !window.confirm('批量删除当前无法关联主表的附表记录？此操作无法撤销。')) return;
  const datasetId = supplementState.datasetId;
  $('#supplement-cleanup').disabled = true;
  try { const result = await api(`/datasets/${encodeURIComponent(datasetId)}/supplement/cleanup`, { method: 'POST', body: '{}' }); await refreshAfterWrite(); await openSupplement(datasetId); showToast(`已清理 ${result.deleted} 条失联记录`, 'success'); } catch (error) { showToast(error.message, 'error'); }
  finally { if (supplementState) renderSupplement(); }
});
$('#close-manual-record').addEventListener('click', closeManualRecord);
$('#manual-record-cancel').addEventListener('click', closeManualRecord);
$('#manual-record-save').addEventListener('click', saveManualRecord);
$('#manual-parent-find').addEventListener('click', searchManualParents);
$('#manual-parent-options').addEventListener('change', event => { const row = manualEditState?.parentRows.find(row => row.id === event.target.value); if (row) selectManualParent(row); });
$('#manual-parent-results').addEventListener('click', event => { const button = event.target.closest('[data-parent-select]'); const row = manualEditState?.parentRows.find(row => row.id === button?.dataset.parentSelect); if (row) selectManualParent(row); });
$('#manual-parent-prev').addEventListener('click', () => searchManualParents((manualEditState?.parentPage || 1) - 1));
$('#manual-parent-next').addEventListener('click', () => searchManualParents((manualEditState?.parentPage || 1) + 1));
$('#manual-parent-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); searchManualParents(); } });
$('#manual-parent-id').addEventListener('input', () => { if (manualEditState) manualEditState.parentSelection = null; renderSelectedParent(); });
$('#manual-parent-verify').addEventListener('click', async () => {
  const editing = manualEditState; if (!editing || editing.busy) return;
  editing.busy = true; setFormBusy($('#manual-record-modal'), true);
  try { if (await verifyManualParent()) $('#manual-parent-status').textContent = '已验证主记录，保存后生效。'; }
  catch (error) { if (manualEditState === editing && state.unlocked) $('#manual-parent-status').textContent = error.message; }
  finally { if (manualEditState === editing) { editing.busy = false; setFormBusy($('#manual-record-modal'), false); } }
});

$('#manual-record-fields').addEventListener('input', event => {
  if (!event.target.matches('.manual-value') || !manualEditState || manualEditState.busy) return;
  const row = event.target.closest('.manual-field'), original = manualEditState.originalFields.get(row.dataset.source);
  row.dataset.action = event.target.value === original.value && row.querySelector('.manual-type').value === original.type ? 'keep' : 'write';
  syncManualField(row);
});
$('#manual-record-fields').addEventListener('change', event => {
  const row = event.target.closest('.manual-field'); if (!row || !manualEditState || manualEditState.busy) return;
  if (event.target.matches('.manual-type')) {
    const original = manualEditState.originalFields.get(row.dataset.source);
    row.dataset.action = row.querySelector('.manual-value').value === original.value && event.target.value === original.type ? 'keep' : 'write';
    if (event.target.value === 'json') expandManualField(row);
  }
  syncManualField(row);
});
$('#manual-record-fields').addEventListener('click', event => {
  const button = event.target.closest('button'), row = button?.closest('.manual-field');
  if (!row || !manualEditState || manualEditState.busy) return;
  if (button.matches('.manual-undo')) {
    syncManualField(row, true); row.querySelector('.manual-value').focus();
  } else if (button.matches('.manual-clear')) {
    if (row.dataset.nullBlocked === 'true') return;
    if (row.dataset.action === 'null' || manualEditState.originalFields.get(row.dataset.source).isNull) {
      syncManualField(row, true); row.querySelector('.manual-value').focus(); return;
    }
    row.dataset.action = 'null'; row.querySelector('.manual-value').value = ''; syncManualField(row);
  } else if (button.matches('.manual-expand')) {
    expandManualField(row); row.querySelector('.manual-value').focus();
  }
});
