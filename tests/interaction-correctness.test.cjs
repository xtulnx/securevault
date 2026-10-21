const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const fields = [
  { source_key: 'code', display_name: '编号', zone: 'indexes', position: 0 },
  { source_key: 'memo', display_name: '备注', zone: 'normal', position: 1 },
  { source_key: 'token', display_name: '凭据', zone: 'secrets', position: 2 },
  { source_key: 'discard', display_name: '不保存', zone: 'ignore', position: 3 },
];
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  const state = w.stateForTest, d = w.document;
  const definition = { fields, identity_fields: ['code'], list_fields: [], display_config: { identifier_fields: ['code'] }, supplement_fields: [] };
  const dataset = { ...definition, id: 'ds', name: '演示数据', category_path: '演示/测试', schema_id: 'model', schema_name: '演示模型', environments: ['测试'], record_count: 1 };
  const model = { id: 'model', name: '演示模型', definition, dataset_ids: ['ds'], version: 1, description: '模型说明' };
  const record = { id: 'rec', dataset_id: 'ds', indexes: { code: '001' }, normal: { memo: '原备注' }, display: {}, secret_count: 1, expired: false, protected_fields: [{ field_name: 'token', zone: 'secrets' }], supplement_fields: [], supplement_records: [] };
  Object.assign(state, { unlocked: true, canManage: true, datasets: [dataset, { ...dataset, id: 'other' }], records: [record], catalog: { schemas: [model], environments: [] } });
  w.api = async route => route === '/catalog' ? state.catalog : route === '/records/rec' ? record : route.endsWith('/supplement') ? { fields, records: [], link_fields: ['code'], link_mode: 'indexes' } : { records: [record], page: 1, total: 1 };
  w.confirm = () => { throw new Error('Unexpected discard confirmation'); };
  return { w, d, state, dataset, record };
}
function edit(w, input, value) {
  input.value = value; input.dispatchEvent(new w.Event('input', { bubbles: true }));
}
function key(w, target, value) {
  const event = new w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true });
  target.dispatchEvent(event); return event;
}
function unloading(w) {
  const event = new w.Event('beforeunload', { cancelable: true });
  w.dispatchEvent(event); return event.defaultPrevented;
}
async function prepareImport(ctx) {
  const { w, state } = ctx;
  w.openImport('ds'); await tick();
  state.pendingBatchId = 'batch';
  w.renderMappings(['code', 'unknown'], fields, true); w.setImportStep(2);
}

test('manual record close, cancel, Escape and navigation preserve a rejected dirty draft', async t => {
  const { w, d, state } = await setup(t);
  await w.openManualRecord('main', 'ds', 'rec'); await tick();
  const input = d.querySelector('[data-source="memo"] .manual-value');
  edit(w, input, '编辑中的备注');
  let prompts = 0; w.confirm = () => { prompts++; return false; };
  d.querySelector('#manual-record-cancel').click();
  d.querySelector('#close-manual-record').click();
  key(w, input, 'Escape');
  w.showWorkspace('datasets');
  assert.equal(prompts, 4);
  assert.equal(state.workspace, 'search');
  assert.equal(d.querySelector('#manual-record-modal').hidden, false);
  assert.equal(input.value, '编辑中的备注');
  assert.equal(unloading(w), true);
  w.confirm = () => true; d.querySelector('#manual-record-cancel').click();
  assert.equal(d.querySelector('#manual-record-modal').hidden, true);
  assert.equal(d.querySelector('#manual-record-fields').children.length, 0);
  assert.equal(unloading(w), false);
  await tick();
});

test('unchanged and reverted records close immediately, while supplement association edits are guarded', async t => {
  const { w, d } = await setup(t);
  await w.openManualRecord('main', 'ds', 'rec');
  const input = d.querySelector('[data-source="memo"] .manual-value');
  edit(w, input, '暂改'); edit(w, input, '原备注');
  assert.equal(w.manualRecordDirty(), false);
  d.querySelector('#close-manual-record').click();
  await w.openManualRecord('supplement', 'ds', null, 'rec');
  edit(w, d.querySelector('#manual-parent-id'), 'another-record');
  w.confirm = () => false; d.querySelector('#manual-record-cancel').click();
  assert.equal(d.querySelector('#manual-record-modal').hidden, false);
  assert.equal(d.querySelector('#manual-parent-id').value, 'another-record');
  await tick();
});

test('manual saving prevents duplicate submission and closing; failure retains input and success clears protection', async t => {
  const { w, d } = await setup(t);
  await w.openManualRecord('main', 'ds', 'rec');
  const input = d.querySelector('[data-source="memo"] .manual-value');
  edit(w, input, '待保存');
  const pending = deferred(); let writes = 0;
  w.api = async () => { writes++; return pending.promise; };
  const saving = w.saveManualRecord();
  await w.saveManualRecord();
  w.closeManualRecord(); key(w, input, 'Escape');
  assert.equal(writes, 1);
  assert.equal(input.disabled, true);
  assert.equal(d.querySelector('#manual-record-modal').hidden, false);
  pending.reject(new Error('模拟保存失败')); await saving;
  assert.equal(input.value, '待保存');
  assert.equal(input.disabled, false);
  assert.equal(unloading(w), true);
  w.api = async () => ({ id: 'rec' }); w.openRecordDetail = async () => {};
  await w.saveManualRecord();
  assert.equal(d.querySelector('#manual-record-modal').hidden, true);
  assert.equal(unloading(w), false);
  await tick();
});

test('sealing bypasses discard guards and a late record save cannot restore the editor', async t => {
  const { w, d, state } = await setup(t);
  await w.openManualRecord('main', 'ds', 'rec');
  edit(w, d.querySelector('[data-source="token"] .manual-value'), 'DEMO_ONLY_DRAFT');
  const pending = deferred(); w.api = async () => pending.promise;
  const saving = w.saveManualRecord();
  await w.sealVault('', false);
  assert.equal(state.unlocked, false);
  assert.equal(d.querySelector('#manual-record-fields').textContent, '');
  pending.resolve({ id: 'rec' }); await saving;
  assert.equal(d.querySelector('#manual-record-modal').hidden, true);
  assert.equal(unloading(w), false);
  await tick();
});

test('model close button, Escape, native cancel and navigation use the same dirty guard', async t => {
  const { w, d, state } = await setup(t);
  await w.openSharedSchemaEditor('model');
  edit(w, d.querySelector('#shared-schema-name'), '修改后的模型');
  let prompts = 0; w.confirm = () => { prompts++; return false; };
  d.querySelector('#close-shared-schema').click();
  key(w, d.querySelector('#shared-schema-name'), 'Escape');
  const cancel = new w.Event('cancel', { cancelable: true });
  d.querySelector('#shared-schema-modal').dispatchEvent(cancel);
  w.showWorkspace('datasets');
  assert.equal(prompts, 4); assert.equal(cancel.defaultPrevented, true);
  assert.equal(state.workspace, 'search');
  assert.equal(d.querySelector('#shared-schema-modal').open, true);
  assert.equal(unloading(w), true);
  w.confirm = () => true; d.querySelector('#close-shared-schema').click();
  assert.equal(state.schemaDraft, null);
  assert.equal(d.querySelector('#shared-main-fields').children.length, 0);
  assert.equal(unloading(w), false);
  await tick();
});

test('model snapshots detect description and field order changes and allow a fully reverted form to close', async t => {
  const { w, d, state } = await setup(t);
  await w.openSharedSchemaEditor('model');
  edit(w, d.querySelector('#shared-schema-name'), '临时名称');
  edit(w, d.querySelector('#shared-schema-name'), '演示模型');
  assert.equal(w.sharedSchemaDirty(), false);
  state.schemaDraft.description = '新的描述';
  assert.equal(w.sharedSchemaDirty(), true);
  state.schemaDraft.description = '模型说明';
  const row = d.querySelectorAll('#shared-main-fields .catalog-field-row')[1];
  row.querySelector('.shared-row-number').click();row.querySelector('.shared-position').value='1';row.querySelector('.shared-position').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  assert.equal(w.sharedSchemaDirty(), true);
  row.querySelector('.shared-row-number').click();row.querySelector('.shared-position').value='2';row.querySelector('.shared-position').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  assert.equal(w.sharedSchemaDirty(), false);
  d.querySelector('#close-shared-schema').click();
  assert.equal(d.querySelector('#shared-schema-modal').open, false);
  await tick();
});

test('model preview and publication block closing while pending and preserve a failed draft', async t => {
  const { w, d, state } = await setup(t);
  await w.openSharedSchemaEditor('model');
  edit(w, d.querySelector('#shared-schema-name'), '待发布');
  const pending = deferred();
  w.api = async () => pending.promise;
  d.querySelector('#preview-shared-schema').click();
  assert.equal(d.querySelector('#shared-schema-name').disabled, true);
  w.closeSharedSchemaEditor();
  assert.equal(d.querySelector('#shared-schema-modal').open, true);
  pending.reject(new Error('模拟预检失败')); await tick();
  assert.equal(d.querySelector('#shared-schema-name').disabled, false);
  assert.equal(d.querySelector('#shared-schema-name').value, '待发布');
  assert.match(d.querySelector('#shared-schema-error').textContent, /预检失败/);
  const publishing = deferred();
  w.api = async route => route === '/schemas/preview' ? { confirmation_token: 'token', changes: [] } : route === '/catalog' ? state.catalog : publishing.promise;
  d.querySelector('#preview-shared-schema').click(); await tick();
  d.querySelector('#publish-shared-schema').click();
  w.closeSchemaPreview(); key(w, d.querySelector('#schema-preview-modal'), 'Escape');
  assert.equal(d.querySelector('#schema-preview-modal').open, true);
  publishing.reject(new Error('模拟发布失败')); await tick();
  assert.match(d.querySelector('#schema-preview-error').textContent, /发布失败/);
  assert.equal(d.querySelector('#publish-shared-schema').disabled, false);
  w.closeSchemaPreview();
  assert.equal(d.querySelector('#shared-schema-name').value, '待发布');
  await tick();
});

test('import back, workspace change, target change and file replacement retain a rejected draft', async t => {
  const ctx = await setup(t), { w, d, state } = ctx;
  await prepareImport(ctx);
  edit(w, d.querySelector('[data-map-path]'), 'nested.code');
  let prompts = 0; w.confirm = () => { prompts++; return false; };
  d.querySelector('#close-import').click();
  w.showWorkspace('datasets');
  d.querySelector('#import-dataset-select').value = 'other';
  d.querySelector('#import-dataset-select').dispatchEvent(new w.Event('change'));
  let fileRead = false;
  await w.importFile({ name: 'replacement.json', text: async () => { fileRead = true; return '{}'; } });
  assert.equal(prompts, 4); assert.equal(fileRead, false);
  assert.equal(state.workspace, 'import');
  assert.equal(d.querySelector('#import-dataset-select').value, 'ds');
  assert.equal(d.querySelector('[data-map-path]').value, 'nested.code');
  assert.equal(state.pendingBatchId, 'batch');
  assert.equal(unloading(w), true);
  w.confirm = () => true; w.showWorkspace('search');
  assert.equal(state.workspace, 'search'); assert.equal(state.pendingBatchId, null);
  assert.equal(d.querySelector('#mapping-summary'), null);
  assert.equal(unloading(w), false);
  await tick();
});

test('unresolved mappings cannot preview; explicit ignore has matching status, counts and confirmation details', async t => {
  const ctx = await setup(t), { w, d, state } = ctx;
  await prepareImport(ctx);
  const unresolved = d.querySelector('[data-map-source="unknown"]');
  assert.equal(unresolved.options[unresolved.selectedIndex].textContent, '请选择处理方式…');
  assert.match(d.querySelector('#mapping-counts').textContent, /未处理 1/);
  let previews = 0;
  w.api = async () => { previews++; return { imported: 1, updated: 0, skipped: 0 }; };
  await w.commitImport();
  assert.equal(previews, 0); assert.equal(state.importStep, 2);
  assert.equal(d.activeElement, unresolved); assert.equal(unresolved.getAttribute('aria-invalid'), 'true');
  d.querySelector('#ignore-unresolved-mappings').click();
  assert.equal(unresolved.options[unresolved.selectedIndex].textContent, '忽略本次导入');
  assert.equal(unresolved.closest('.mapping-row').querySelector('.mapping-status').textContent, '明确忽略');
  assert.match(d.querySelector('#mapping-counts').textContent, /忽略 1 · 未处理 0/);
  assert.deepEqual(Array.from(w.buildImportRequest().mappings, m => m.source_key), ['code']);
  await w.commitImport();
  assert.equal(previews, 1); assert.equal(state.importStep, 3);
  assert.match(d.querySelector('.ignored-import-fields').textContent, /unknown/);
  d.querySelector('#import-back').click();
  assert.equal(unresolved.options[unresolved.selectedIndex].dataset.mappingAction, 'ignore');
  await tick();
});

test('new, mapped and schema-ignored fields stay distinct, including a real field named __new', async t => {
  const ctx = await setup(t), { w, d } = ctx;
  await prepareImport(ctx);
  w.renderMappings(['code', 'discard', '__new', 'unknown'], [...fields, { source_key: '__new', zone: 'indexes' }]);
  const select = d.querySelector('[data-map-source="unknown"]');
  select.selectedIndex = select.options.length - 1;
  select.dispatchEvent(new w.Event('change'));
  assert.equal(select.closest('.mapping-row').querySelector('[data-map-new]').hidden, false);
  assert.throws(() => w.buildImportRequest(), /新字段名称/);
  edit(w, select.closest('.mapping-row').querySelector('[data-map-new]'), 'added');
  const request = w.buildImportRequest();
  assert.deepEqual(Array.from(request.mappings, m => m.target_key), ['code', 'discard', '__new', 'added']);
  assert.equal(d.querySelector('[data-map-source="__new"]').closest('.mapping-row').querySelector('[data-map-new]').hidden, true);
  assert.match(d.querySelector('#mapping-counts').textContent, /已映射 2 · 新增 1 · 忽略 1 · 未处理 0/);
  await tick();
});

test('import freezes the preview request, retains configuration on failure and clears protection on success', async t => {
  const ctx = await setup(t), { w, d, state } = ctx;
  await prepareImport(ctx); d.querySelector('#ignore-unresolved-mappings').click();
  const preview = deferred(); w.api = async () => preview.promise;
  const loading = w.commitImport();
  w.showWorkspace('search');
  assert.equal(state.workspace, 'import');
  assert.equal(d.querySelector('[data-map-source]').disabled, true);
  preview.reject(new Error('模拟预检失败')); await loading;
  assert.equal(state.importStep, 2);
  assert.equal(d.querySelector('[data-map-source]').disabled, false);
  w.api = async () => ({ imported: 1 });
  await w.commitImport();
  const saving = deferred(); w.api = async () => saving.promise;
  const submission = w.confirmImport();
  w.showWorkspace('datasets');
  assert.equal(state.workspace, 'import');
  saving.reject(new Error('模拟写入失败')); await submission;
  assert.equal(state.importStep, 3); assert.ok(state.importPreview);
  assert.match(d.querySelector('#import-action-error').textContent, /写入失败/);
  w.api = async () => ({ imported: 1 });
  await w.confirmImport();
  assert.equal(state.importPreview, null); assert.equal(unloading(w), false);
  d.querySelector('#import-finish').click();
  assert.equal(state.workspace, 'dataset');
  assert.equal(state.managedDatasetId, 'ds');
  await tick();
});

test('late native file reads and ordinary uploads cannot repopulate a sealed import', async t => {
  for (const native of [true, false]) {
    const ctx = await setup(t), { w, d, state } = ctx;
    w.openImport('ds'); await tick();
    const pending = deferred();
    const file = native ? { name: 'sample.json', text: () => pending.promise } : new w.File(['code\\n001'], 'sample.csv', { type: 'text/csv' });
    if (!native) w.fetch = () => pending.promise;
    const loading = w.importFile(file);
    assert.equal(unloading(w), true);
    await w.sealVault('', false);
    if (native) pending.resolve(JSON.stringify({ format: 'securevault-dataset', version: 1, mode: 'schema', schema: { fields, category_path: '演示' } }));
    else pending.resolve({ ok: true, json: async () => ({ batch_id: 'late', source_fields: ['code'], filename: 'sample.csv' }) });
    await loading;
    assert.equal(state.transferPackage, null); assert.equal(state.pendingBatchId, null);
    assert.equal(d.querySelector('#mapping-list').children.length, 0);
    assert.equal(state.unlocked, false);
    await tick();
  }
});

test('row keyboard navigation leaves action buttons, disclosure and editable controls to native activation', async t => {
  const { w, d } = await setup(t);
  d.querySelector('#records-grid').innerHTML = ['a', 'b'].map(id => `<article class="record-card" data-record-id="${id}" tabindex="-1"><button class="record-open">标题 ${id}</button><button class="expired-toggle">标记过期</button><button class="reveal-secrets-button">按需查看</button><details><summary>更多</summary></details><input /><div contenteditable="true">文字</div></article>`).join('');
  const opened = []; w.openRecordDetail = id => opened.push(id);
  for (const selector of ['.expired-toggle', '.reveal-secrets-button', 'summary', 'input', '[contenteditable]']) {
    const target = d.querySelector(selector);
    for (const value of ['Enter', ' ', 'ArrowDown']) assert.equal(key(w, target, value).defaultPrevented, false, selector);
  }
  assert.deepEqual(opened, []);
  const first = d.querySelector('.record-open');
  d.querySelector('#records-grid').focus();
  key(w, d.activeElement, 'ArrowDown');
  assert.equal(d.activeElement, first);
  assert.equal(key(w, first, 'Enter').defaultPrevented, false);
  key(w, first, 'ArrowDown');
  assert.equal(d.activeElement, d.querySelectorAll('.record-open')[1]);
  key(w, d.activeElement, 'ArrowUp'); assert.equal(d.activeElement, first);
  key(w, d.querySelector('.record-card'), 'Enter'); assert.deepEqual(opened, ['a']);
  await tick();
});

test('record tabs support continuous navigation and model information uses keyboard reachable field tables', async t => {
  const { w, d } = await setup(t);
  await w.openRecordDetail('rec');
  const list = d.querySelector('#record-detail-tabs');
  list.querySelector('[aria-selected="true"]').focus();
  key(w, d.activeElement, 'ArrowRight');
  assert.equal(d.activeElement.id, 'record-tab-secrets');
  key(w, d.activeElement, 'ArrowRight');
  assert.equal(d.activeElement.id, 'record-tab-supplement');
  key(w, d.activeElement, 'Home'); assert.equal(d.activeElement.id, 'record-tab-overview');
  key(w, d.activeElement, 'End'); assert.equal(d.activeElement.id, 'record-tab-supplement');
  assert.equal(list.querySelectorAll('[tabindex="0"]').length, 1);
  assert.equal(d.querySelector('#record-detail-content').getAttribute('aria-labelledby'), 'record-tab-supplement');
  w.closeRecordDetail(); await w.openSharedSchemaView('model');
  assert.equal(d.querySelector('#schema-view-tabs, [data-model-tab]'), null);
  const modelTable = d.querySelector('#schema-view-content [role="region"]');
  modelTable.focus(); assert.equal(d.activeElement, modelTable);
  assert.equal(modelTable.getAttribute('aria-label'), '主表字段表格');
  await tick();
});

test('import steps expose exactly one current step through forward and backward transitions', async t => {
  const { w, d } = await setup(t);
  for (const step of [1, 2, 3, 2]) {
    w.setImportStep(step);
    assert.equal(d.querySelectorAll('#import-steps [aria-current="step"]').length, 1);
    assert.equal(d.querySelector('#import-steps [aria-current="step"]').dataset.step, String(step));
  }
  await tick();
});

test('closing modal record details restores focus only after the search workspace is interactive again', async t => {
  const { w, d } = await setup(t);
  w.renderRecords();
  const opener = d.querySelector('.record-open'); opener.focus();
  await w.openRecordDetail('rec'); await tick();
  assert.equal(d.querySelector('#vault-screen').inert, true);
  const originalFocus = opener.focus.bind(opener);
  let inertOnFocus = null;
  opener.focus = () => { inertOnFocus = d.querySelector('#vault-screen').inert; originalFocus(); };
  w.closeRecordDetail(); await tick();
  assert.equal(inertOnFocus, false);
  assert.equal(d.activeElement, opener);
});

test('catalog tabs share keyboard selection and tabpanel semantics', async t => {
  const { w, d } = await setup(t);
  await w.openCatalog('schemas');
  d.querySelector('#catalog-tab-schemas').focus();
  key(w, d.activeElement, 'ArrowRight');
  assert.equal(d.activeElement.id, 'catalog-tab-environments');
  assert.equal(d.querySelector('#catalog-list').getAttribute('aria-labelledby'), 'catalog-tab-environments');
  assert.equal(d.querySelectorAll('#catalog-tabs [tabindex="0"]').length, 1);
  key(w, d.activeElement, 'Home');
  assert.equal(d.activeElement.id, 'catalog-tab-schemas');
  await tick();
});
