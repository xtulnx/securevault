// Manual record editing and the independent per-dataset supplementary table.
let supplementState = null;
let manualEditState = null;
let supplementRequest = 0;
let manualEditRequest = 0;
const supplementReveals = new Map();

function clearManualData() {
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
  $('#manual-parent-id').value = '';
  $('#manual-parent-search').value = '';
  $('#manual-parent-options').replaceChildren();
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
  $('#supplement-schema-panel').hidden = !state.canManage;
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

function manualFieldRow(field, values) {
  const exists = Object.hasOwn(values, field.source_key);
  const value = values[field.source_key];
  const jsonValue = exists && typeof value !== 'string';
  const protectedField = ['secrets', 'hidden'].includes(field.zone);
  return `<div class="manual-field" data-source="${escapeHtml(field.source_key)}"><label><strong>${escapeHtml(field.display_name || field.source_key)}</strong><code>${escapeHtml(field.source_key)}</code><span>${escapeHtml({indexes:'索引', display:'展示', normal:'普通', secrets:'敏感', hidden:'隐藏加密'}[field.zone] || field.zone)}</span></label><textarea class="manual-value" aria-label="${escapeHtml(field.display_name || field.source_key)}" rows="${protectedField ? '2' : '3'}" spellcheck="false" autocomplete="off" placeholder="${protectedField ? '填写新值；未勾选写入时保留原值' : '支持多行文本'}">${escapeHtml(exists ? (jsonValue ? JSON.stringify(value, null, 2) : value) : '')}</textarea><div class="manual-field-options"><label><input type="checkbox" class="manual-write" ${exists ? 'checked' : ''}>写入此字段</label><label>类型<select class="manual-type"><option value="text" ${!jsonValue ? 'selected' : ''}>文本</option><option value="json" ${jsonValue ? 'selected' : ''}>JSON / 数字 / 布尔</option></select></label><label><input type="checkbox" class="manual-unset">删除此字段值</label></div></div>`;
}

async function openManualRecord(kind, datasetId, recordId = null, parentId = null, returnRecordId = null) {
  if (!state.canManage) return;
  const request = ++manualEditRequest;
  try {
    const dataset = state.datasets.find((item) => item.id === datasetId);
    if (!dataset) return;
    let definitions, values, row;
    if (kind === 'main') {
      definitions = dataset.fields;
      const detail = recordId ? await api(`/records/${encodeURIComponent(recordId)}`) : {};
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
    manualEditState = { kind, datasetId, recordId, returnRecordId, fields: definitions };
    $('#manual-record-title').textContent = `${recordId ? '编辑' : '新增'}${kind === 'main' ? '主表' : '附表'}记录`;
    $('#manual-record-help').textContent = kind === 'main' ? '主表仍以批量导入更新为主，后续导入可能覆盖手工修改。敏感字段未写入时保留原值。' : '附表数据独立保存，主表导入不会覆盖。每条主记录最多关联一条附表记录，不同用途通过附表字段扩展。';
    $('#manual-parent-picker').hidden = kind !== 'supplement';
    $('#manual-parent-id').value = parentId || row?.main_record_id || '';
    $('#manual-parent-id').dataset.original = row?.main_record_id || '';
    $('#manual-parent-search').value = '';
    $('#manual-parent-options').innerHTML = '<option value="">检索并选择主记录，或保留当前关联</option>';
    $('#manual-record-fields').innerHTML = definitions.filter((field) => field.zone !== 'ignore').sort((a,b) => a.position - b.position).map((field) => manualFieldRow(field, values)).join('') || '<p>请先配置字段，再新增记录。</p>';
    $('#manual-record-fields').querySelectorAll('.manual-value').forEach((input) => input.addEventListener('input', () => { const row = input.closest('.manual-field'); row.querySelector('.manual-write').checked = true; row.querySelector('.manual-unset').checked = false; }));
    $('#manual-record-fields').querySelectorAll('.manual-unset').forEach((input) => input.addEventListener('change', () => { if (input.checked) input.closest('.manual-field').querySelector('.manual-write').checked = false; }));
    $('#manual-record-modal').hidden = false;
    closeRecordDetail();
    if (kind === 'supplement') await searchManualParents();
  } catch (error) { showToast(error.message, 'error'); }
}

async function searchManualParents() {
  if (!manualEditState) return;
  const editing = manualEditState;
  try {
    const params = new URLSearchParams({ dataset_id: editing.datasetId, q: $('#manual-parent-search').value, include_expired: 'true', limit: '100' });
    const result = await api(`/records/search?${params}`);
    if (manualEditState !== editing || !state.unlocked) return;
    $('#manual-parent-options').innerHTML = '<option value="">选择关联主记录（最多显示 100 条，可检索）</option>' + result.records.map((row) => `<option value="${escapeHtml(row.id)}" ${row.id === $('#manual-parent-id').value ? 'selected' : ''} ${row.supplement?.id && row.supplement.id !== editing.recordId ? 'disabled' : ''}>${escapeHtml(Object.values(row.indexes).map((value) => typeof value === 'object' ? JSON.stringify(value) : value).join(' · ') || '无索引')} · ${escapeHtml(row.id)}${row.supplement?.id && row.supplement.id !== editing.recordId ? '（已有附表）' : ''}</option>`).join('');
  } catch (error) { showToast(error.message, 'error'); }
}

function closeManualRecord() {
  manualEditRequest++;
  manualEditState = null;
  $('#manual-record-modal').hidden = true;
  $('#manual-record-fields').replaceChildren();
  $('#manual-parent-id').value = '';
  $('#manual-parent-search').value = '';
  $('#manual-parent-options').replaceChildren();
}
async function saveManualRecord() {
  const editing = manualEditState;
  if (!editing || !state.canManage) return;
  const values = Object.create(null), unset_fields = [];
  try {
    $('#manual-record-fields').querySelectorAll('.manual-field').forEach((row) => {
      const key = row.dataset.source;
      if (row.querySelector('.manual-unset').checked) unset_fields.push(key);
      else if (row.querySelector('.manual-write').checked) { const raw = row.querySelector('.manual-value').value; values[key] = row.querySelector('.manual-type').value === 'json' ? JSON.parse(raw) : raw; }
    });
    const body = { values, unset_fields };
    const parent = $('#manual-parent-id').value.trim();
    if (editing.kind === 'supplement' && (!editing.recordId || parent !== $('#manual-parent-id').dataset.original)) body.main_record_id = parent;
    const path = editing.kind === 'main' ? (editing.recordId ? `/records/${encodeURIComponent(editing.recordId)}` : `/datasets/${encodeURIComponent(editing.datasetId)}/records`) : `/datasets/${encodeURIComponent(editing.datasetId)}/supplement/records${editing.recordId ? `/${encodeURIComponent(editing.recordId)}` : ''}`;
    $('#manual-record-save').disabled = true;
    const result = await api(path, { method: editing.recordId ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    if (manualEditState !== editing || !state.unlocked) return;
    closeManualRecord();
    if (editing.kind === 'main') { await refreshAfterWrite(); await openRecordDetail(result.id); }
    else {
      await refreshAfterWrite();
      if (editing.returnRecordId) await openRecordDetail(editing.returnRecordId);
      else await openSupplement(editing.datasetId);
    }
    showToast('记录已保存', 'success');
  } catch (error) { showToast(error instanceof SyntaxError ? 'JSON 字段格式无效，请检查输入' : error.message, 'error'); }
  finally { $('#manual-record-save').disabled = false; }
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
$('#manual-parent-options').addEventListener('change', (event) => { if (event.target.value) $('#manual-parent-id').value = event.target.value; });
