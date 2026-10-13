const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

const dataset = () => ({ id: 'ds', category_path: '支付/商户', environment: 'prod', description: '## 说明\n\n只读描述', record_count: 1, conflict_strategy: 'allow_mark', fields: [
  { source_key: 'merchant_id', display_name: '商户号', zone: 'indexes', position: 0 },
  { source_key: 'enabled', display_name: '启用', zone: 'display', position: 1 },
  { source_key: 'callback', display_name: '回调地址', zone: 'display', position: 2 },
  { source_key: 'secret', display_name: '密钥', zone: 'secrets', position: 3 }
], identity_fields: ['merchant_id'], list_fields: [{ source_key: 'callback', visible: true, format: 'multiline' }], display_config: { identifier_fields: ['merchant_id', 'enabled'], density: 'summary' } });
const record = () => ({ id: 'rec-001', dataset_id: 'ds', category: '支付/商户', environment: 'prod', indexes: { merchant_id: 0 }, display: { enabled: false, callback: 'https://pay.example.test' }, secret_count: 1, matched_fields: ['callback'], fieldLabels: { callback: '回调地址' } });
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, datasets: [dataset()], records: [record()] });
  return w;
}

test('record identity preserves zero, false, composite identifiers and stable fallback without names', async t => {
  const w = await setup(t);
  assert.equal(w.recordIdentity(record()), '商户号：0 · 启用：false');
  w.stateForTest.datasets[0].display_config.identifier_fields = [];
  assert.equal(w.recordIdentity(record()), '商户号：0');
  w.stateForTest.datasets[0].identity_fields = [];
  assert.match(w.recordIdentity(record()), /^记录 #rec-001$/);
  w.stateForTest.datasets[0].display_config.identifier_fields = ['secret'];
  assert.ok(!w.recordIdentity(record()).includes('secret'));
});

test('actual matched public fields appear even when hidden from the default list; other hidden fields stay hidden', async t => {
  const w = await setup(t), ds = w.stateForTest.datasets[0];
  ds.list_fields = [{ source_key: 'enabled', visible: false }, { source_key: 'callback', visible: false }];
  w.stateForTest.query = 'callback:^https';
  const html = w.recordCard(record());
  assert.match(html, /class="search-hit">https<\/mark>/);
  assert.ok(!html.includes('未命名'));
  assert.deepEqual(Object.keys(w.allDisplay(record())), ['callback']);
  assert.ok(!html.includes('https://pay.example.test</mark>'));
  const r = { ...record(), matched_fields: [] };
  assert.deepEqual(Object.keys(w.allDisplay(r)), []);
});

test('field-qualified, suffix, regex and quoted queries highlight only the matching field and escape HTML', async t => {
  const w = await setup(t), r = record();
  w.stateForTest.query = 'callback:$test';
  assert.equal(w.highlightField('https://pay.example.test', 'callback', r), 'https://pay.example.<mark class="search-hit">test</mark>');
  assert.equal(w.highlightField('test', 'enabled', r), 'test');
  w.stateForTest.query = 'callback:~pay\\.example';
  assert.match(w.highlightField('pay.example', 'callback', { ...r, match_info: { callback: { text: 'pay.example', ranges: [[0, 11]] } } }), /search-hit/);
  w.stateForTest.query = 'callback:"pay example"';
  assert.equal(w.highlightField('<pay example>', 'callback', r), '&lt;<mark class="search-hit">pay example</mark>&gt;');
});

test('summary preserves server relevance order across main and supplementary matches before defaults', async t => {
  const w = await setup(t);
  const r = { ...record(), matched_fields: ['supplement.code', 'callback', 'merchant_id'],
    supplement: { indexes: { code: 'pay' }, display: { note: 'linked' } } };
  assert.deepEqual(Object.keys(w.allDisplay(r)), ['supplement.code', 'callback', 'merchant_id', 'supplement.note']);
});

test('out-of-order searches and sealed responses cannot replace current results', async t => {
  const w = await setup(t), pending = [];
  w.fetch = () => new Promise(resolve => pending.push(resolve));
  w.stateForTest.query = 'first'; const first = w.fetchRecords();
  w.stateForTest.query = 'second'; const second = w.fetchRecords();
  pending[1]({ ok: true, json: async () => ({ records: [{ ...record(), id: 'new' }], total: 1, page: 1 }) }); await second;
  pending[0]({ ok: true, json: async () => ({ records: [{ ...record(), id: 'stale' }], total: 1, page: 1 }) }); await first;
  assert.equal(w.stateForTest.records[0].id, 'new');
  const late = w.fetchRecords(); w.stateForTest.unlocked = false;
  pending[2]({ ok: true, json: async () => ({ records: [record()], total: 1, page: 1 }) }); await late;
  assert.equal(w.stateForTest.records[0].id, 'new');
});

test('dataset management shows a compact readonly description and saves only an explicitly edited description', async t => {
  const w = await setup(t), requests = [];
  w.openManagedDataset('ds');
  assert.equal(w.document.querySelector('#dataset-detail-description textarea'), null);
  assert.equal(w.document.querySelector('#description-edit-modal').open, false);
  w.document.querySelector('#managed-edit-description').click();
  assert.equal(w.document.querySelector('#description-edit-modal').open, true);
  w.document.querySelector('#description-draft').value = '## 更新';
  w.fetch = async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; };
  await w.saveDescription();
  assert.deepEqual(JSON.parse(requests[0].options.body), { description: '## 更新' });
  assert.equal(w.stateForTest.datasets[0].description, '## 更新');
  assert.equal(w.document.querySelector('#description-edit-modal').open, false);
});

test('an ordinary import previews once and writes only after final confirmation, without an early schema PATCH', async t => {
  const w = await setup(t), requests = [];
  w.openImport('ds'); w.stateForTest.pendingBatchId = 'batch';
  w.renderMappings(['merchant_id'], w.stateForTest.datasets[0].fields, true); w.setImportStep(2);
  w.fetch = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ imported: 1, updated: 0, skipped: 0 }) };
  };
  await w.commitImport();
  assert.equal(w.stateForTest.importStep, 3);
  assert.deepEqual(requests.map(r => r.url), ['/api/records/import/preview']);
  await w.confirmImport();
  assert.deepEqual(requests.map(r => r.url), ['/api/records/import/preview', '/api/records/import']);
  assert.equal(w.document.querySelector('#import-result').hidden, false);
});

test('schema files can be staged without an existing dataset and preserve the native structure for preview', async t => {
  const w = await setup(t); w.stateForTest.datasets = [];
  w.openImport();
  const schema = { ...dataset(), category_path: '迁移/商户' };
  const packageFile = { format: 'securevault-dataset', version: 1, mode: 'schema', schema, records: [] };
  await w.importFile({ name: 'merchant.schema.json', text: async () => JSON.stringify(packageFile) });
  assert.equal(w.stateForTest.importStep, 2);
  assert.equal(w.document.querySelector('#transfer-category').value, '迁移/商户');
  assert.equal(w.document.querySelector('#transfer-target').value, '');
  assert.equal(JSON.parse(w.buildTransferRequest().package).mode, 'schema');
  assert.equal(w.document.querySelector('#batch-options').hidden, true);
});

test('export secret selection is scoped to one dialog and schema export hides value choices', async t => {
  const w = await setup(t), d = w.document;
  w.openExport('ds'); d.querySelector('#export-with-secrets').checked = true;
  d.querySelector('#export-modal').close(); w.openExport('ds');
  assert.equal(d.querySelector('#export-with-secrets').checked, false);
  d.querySelector('input[name="export-content"][value="schema"]').checked = true; w.updateExportOptions();
  assert.equal(d.querySelector('#export-secret-wrap').hidden, true);
  assert.equal(d.querySelector('#export-format').disabled, true);
  assert.equal(d.querySelector('#confirm-export').textContent, '导出结构');
});

test('mapping controls keep JSON path in its own labelled cell when the new-field input is hidden', async t => {
  const w = await setup(t); w.renderMappings(['callback'], w.stateForTest.datasets[0].fields, true);
  const row = w.document.querySelector('.mapping-row');
  assert.equal(row.children.length, 4);
  assert.equal(row.children[2].querySelector('[data-map-path]').getAttribute('aria-label'), 'callback 内的 JSON 路径');
  assert.equal(row.children[1].querySelector('[data-map-new]').hidden, true);
});

test('authorization editing filters without deselecting and saves only the chosen scope and duration', async t => {
  const w = await setup(t), requests = [];
  w.stateForTest.apps = [{ id: 'app', name: '测试应用', permission: 'search', datasets: ['ds'], disabled: true, access_expires_at: null }];
  w.openAppScope('app');
  w.document.querySelector('#scope-search').value = 'does-not-match'; w.updateAppScope();
  assert.equal(w.document.querySelector('#scope-datasets input').checked, true);
  w.document.querySelector('#scope-ttl').value = '1800';
  w.fetch = async (url, options = {}) => { requests.push({ url, options }); return { ok: true, json: async () => url.endsWith('/apps') ? { apps: [] } : {} }; };
  await w.saveAppScope();
  assert.deepEqual(JSON.parse(requests[0].options.body), { permission: 'search', access_ttl_seconds: 1800, datasets: ['ds'] });
  assert.equal(w.document.querySelector('#app-scope-modal').open, false);
});


test('native transfer keeps original JSON text so large integers are not rounded by the browser', async t => {
  const w = await setup(t);
  const file = JSON.stringify({ format: 'securevault-dataset', version: 1, mode: 'package', schema: dataset(), records: [{ source_id: 'r', values: { merchant_id: 'M-1', count: 'LARGE_LITERAL' } }] }).replace('"LARGE_LITERAL"', '9007199254740993');
  await w.importFile({ name: 'native.dataset.json', text: async () => file });
  assert.ok(w.buildTransferRequest().package.includes('9007199254740993'));
});

test('sealing discards late workspace metadata, native file text, and one-time application keys', async t => {
  const w = await setup(t), pending = [];
  w.fetch = () => new Promise(resolve => pending.push(resolve));
  w.stateForTest.transferRaw = '{"secret":"DEMO_ONLY"}';
  w.document.querySelector('#app-key-value').value = 'DEMO_ONLY_KEY';
  const loading = w.loadWorkspace();
  await w.sealVault('测试封印', false);
  pending[0]({ ok: true, json: async () => ({ datasets: [dataset()] }) });
  pending[1]({ ok: true, json: async () => ({ directories: [] }) });
  pending[2]({ ok: true, json: async () => ({ records: 1, datasets: 1 }) });
  await loading;
  assert.equal(w.stateForTest.datasets.length, 0);
  assert.equal(w.stateForTest.transferRaw, null);
  assert.equal(w.document.querySelector('#app-key-value').value, '');
});

test('refresh restores an existing owner session with the server remaining lifetime', async t => {
  const w = await setup(t);
  w.stateForTest.unlocked = false;
  w.fetch = async url => ({ ok: true, json: async () => url.endsWith('/vault/status') ? {
    initialized: true, sealed: false, can_manage: true, persistent: false, idle_seconds_remaining: 900, ttl_seconds_remaining: 3600
  } : url.endsWith('/datasets/tree') ? { directories: [] } : url.endsWith('/datasets') ? { datasets: [dataset()] } : url.endsWith('/vault/summary') ? { records: 1, datasets: 1, protected_fields: 1 } : { records: [record()], total: 1, page: 1 } });
  await w.checkStatus();
  assert.equal(w.stateForTest.unlocked, true);
  assert.equal(w.document.querySelector('#app').classList.contains('is-unsealed'), true);
  assert.ok(Math.abs((Date.now() - w.stateForTest.unlockAt) / 1000 - 10800) < 2);
});

test('row numbers edit on demand, commit with Enter, and cancel with Escape without dirtying the schema', async t => {
  const w = await setup(t), document = w.document;
  w.renderSchemaFields(dataset().fields);
  const rows = () => [...document.querySelectorAll('#schema-fields .schema-field')];
  const row = rows()[2], number = row.querySelector('.schema-row-number'), input = row.querySelector('.schema-position');
  assert.equal(input.hidden, true);
  w.stateForTest.editorDirty = false;
  number.click(); assert.equal(input.hidden, false); assert.equal(document.activeElement, input);
  input.value = '1'; input.dispatchEvent(new w.Event('input', { bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(input.hidden, true); assert.equal(number.hidden, false);
  assert.equal(rows()[2], row); assert.equal(input.value, '3'); assert.equal(w.stateForTest.editorDirty, false);
  number.click(); input.value = '1';
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(rows()[0], row); assert.equal(input.hidden, true); assert.equal(document.activeElement, number);
  assert.deepEqual(rows().map(item => item.querySelector('.schema-row-number').textContent), ['1', '2', '3', '4']);
  assert.equal(w.stateForTest.editorDirty, true);
  number.click(); input.value = '4'; input.blur();
  assert.equal(rows()[3], row); assert.equal(input.hidden, true);
});

test('handle dragging commits field and list order only on release and cancellation leaves values intact', async t => {
  const w = await setup(t), document = w.document;
  w.requestAnimationFrame = () => 1; w.cancelAnimationFrame = () => {};
  w.renderSchemaFields(dataset().fields); w.renderListConfig(dataset().fields);
  function pointer(handle, type, y) {
    handle.dispatchEvent(new w.MouseEvent(type, { bubbles: true, button: 0, clientX: 10, clientY: y }));
  }
  for (const selector of ['#schema-fields', '#list-config-fields']) {
    const container = document.querySelector(selector), rows = [...container.children];
    rows.forEach((row, index) => { row.getBoundingClientRect = () => ({ top: index * 60, height: 50 }); });
    const handle = rows[0].querySelector('.row-drag-handle');
    w.stateForTest.editorDirty = false;
    pointer(handle, 'pointerdown', 10); pointer(handle, 'pointermove', 230);
    assert.equal(container.children[0], rows[0]);
    assert.equal(rows[0].classList.contains('reorder-dragging'), true);
    pointer(handle, 'pointercancel', 230);
    assert.equal(container.children[0], rows[0]); assert.equal(w.stateForTest.editorDirty, false);
    assert.equal(document.body.classList.contains('reordering-fields'), false);
    pointer(handle, 'pointerdown', 10); pointer(handle, 'pointermove', 230); pointer(handle, 'pointerup', 230);
    assert.equal(container.lastElementChild, rows[0]);
    assert.equal(w.stateForTest.editorDirty, true);
    assert.deepEqual([...container.querySelectorAll('.schema-row-number')].map(item => item.textContent), rows.map((_, i) => String(i + 1)));
    assert.equal(container.querySelector('.reorder-before, .reorder-after'), null);
    assert.equal(rows[0].querySelector('.schema-source-key-input')?.value || rows[0].dataset.listSource, 'merchant_id');
  }
  assert.deepEqual(Array.from(w.readListConfig(), field => field.source_key), ['enabled', 'callback', 'merchant_id']);
});

test('search cards suppress repeated source only for a single dataset scope, preserve expired status, and never show update times', async t => {
  const w = await setup(t), state = w.stateForTest;
  const r = { ...record(), updated: '2026-10-09 14:26:24', expired: true };
  const inspect = () => { const host = w.document.createElement('div'); host.innerHTML = w.recordCard(r); return host; };
  let card = inspect();
  assert.equal(card.querySelector('.record-tags'), null);
  assert.equal(card.querySelector('.expired-tag').textContent, '已过期');
  assert.equal(card.querySelector('.card-footer'), null);
  assert.ok(!card.textContent.includes(r.updated));
  const other = { ...dataset(), id: 'other', category_path: '基础设施/云服务', environment: 'test' };
  state.datasets.push(other);
  card = inspect(); // A page with one source is still a cross-dataset search.
  assert.equal(card.querySelector('.record-tags').textContent, '支付/商户prod');
  state.environment = 'prod';
  assert.equal(inspect().querySelector('.record-tags'), null);
  state.environment = 'all'; state.category = '支付';
  assert.equal(inspect().querySelector('.record-tags'), null);
  state.category = '支付/商户'; state.datasets.push({ ...dataset(), id: 'other-env', environment: 'test' });
  assert.ok(inspect().querySelector('.record-tags'));
  state.selectedDatasetId = 'ds';
  assert.equal(inspect().querySelector('.record-tags'), null);
  // A stale row from a different source must not lose its identifying context.
  assert.ok(w.recordCard({ ...r, dataset_id: 'other', category: other.category_path }).includes('record-tags'));
  w.renderRecords();
  assert.equal(w.document.querySelector('#search-scope-label').textContent, '支付/商户 · prod');
});

test('empty values disappear from summaries and composite titles without hiding zero, false, or literal strings', async t => {
  const w = await setup(t), ds = w.stateForTest.datasets[0];
  ds.fields = ['id', 'blank', 'spaces', 'nil', 'missing', 'zero', 'off', 'literal'].map(source_key => ({ source_key, zone: 'display' }));
  ds.list_fields = []; ds.display_config = { identifier_fields: ['id', 'blank', 'nil'], density: 'full' };
  const r = { ...record(), indexes: {}, matched_fields: [], display: { id: 'D1016', blank: '', spaces: '  \n ', nil: null, missing: undefined, zero: 0, off: false, literal: '空字符串' } };
  assert.equal(w.recordIdentity(r), 'id：D1016');
  assert.deepEqual(Object.keys(w.allDisplay(r)), ['id', 'zero', 'off', 'literal']);
  const host = w.document.createElement('div'); host.innerHTML = w.recordCard(r);
  assert.deepEqual([...host.querySelectorAll('.data-point label')].map(el => el.textContent), ['zero', 'off', 'literal']);
  assert.deepEqual([...host.querySelectorAll('.data-point span')].map(el => el.textContent), ['0', 'false', '空字符串']);
  host.innerHTML = w.detailRows({ blank: '', nil: null, literal: 'null' });
  assert.deepEqual([...host.querySelectorAll('.empty-value')].map(el => el.textContent), ['∅', '∅']);
  assert.equal(host.querySelectorAll('.empty-value')[1].getAttribute('title'), '空值（JSON null）');
  assert.equal(host.querySelectorAll('.detail-public-value > span')[2].textContent, 'null');
});

test('saving schema order updates search display order while preserving formats and visibility', async t => {
  const w = await setup(t), state = w.stateForTest;
  const ds = state.datasets[0];
  ds.list_fields = [
    { source_key: 'enabled', position: 0, visible: false, format: 'json' },
    { source_key: 'callback', position: 1, visible: true, format: 'multiline' },
    { source_key: 'merchant_id', position: 2, visible: true, format: 'single_line' }
  ];
  w.openDatasetEdit('ds', 'fields');
  const rows = [...w.document.querySelectorAll('#schema-fields .schema-field')];
  rows[2].querySelector('.schema-row-number').click();
  rows[2].querySelector('.schema-position').value = '1';
  rows[2].querySelector('.schema-position').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  let body;
  w.fetch = async (url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; };
  await w.createDataset();
  assert.deepEqual(body.fields.map(field => field.source_key), ['callback', 'merchant_id', 'enabled', 'secret']);
  assert.deepEqual(body.list_fields.map(field => field.source_key), ['callback', 'merchant_id', 'enabled']);
  assert.equal(body.list_fields[0].format, 'multiline');
  assert.equal(body.list_fields[2].format, 'json'); assert.equal(body.list_fields[2].visible, false);
  Object.assign(ds, body);
  assert.deepEqual(Object.keys(w.allDisplay({ ...record(), matched_fields: [] })), ['callback', 'merchant_id']);
});

test('mobile directory selection is a cancellable draft and applies a union of multiple paths before returning to search', async t => {
  const w = await setup(t), state = w.stateForTest, requests = [];
  state.directories = [{ path: '支付', count: 1 }, { path: '支付/商户', count: 1 }, { path: '系统', count: 2 }];
  state.datasets.push({ ...dataset(), id: 'ds_other', category_path: '系统/Webhook' });
  w.fetch = async url => { requests.push(url); return { ok: true, json: async () => ({ records: [record()], total: 1, page: 1 }) }; };
  w.document.querySelector('#directory-toggle').click();
  const option = path => w.document.querySelector(`#directory-options input[value="${path}"]`);
  option('支付').checked = true; option('支付').dispatchEvent(new w.Event('change'));
  assert.equal(option('支付/商户').checked, true); assert.equal(option('支付/商户').disabled, true);
  w.document.querySelector('#cancel-directory-picker').click();
  assert.equal(state.category, 'all'); assert.equal(requests.length, 0);
  w.openDirectoryPicker();
  for (const path of ['支付/商户', '系统']) { option(path).checked = true; option(path).dispatchEvent(new w.Event('change')); }
  await w.applyDirectoryPicker();
  assert.equal(w.document.querySelector('#directory-picker').open, false);
  assert.equal(state.workspace, 'search');
  const query = new URL(requests[0], 'http://localhost').searchParams;
  assert.deepEqual(JSON.parse(query.get('categories')), ['支付/商户', '系统']);
  assert.equal(query.has('category'), false); assert.equal(query.has('dataset_id'), false);
  assert.equal(w.datasetCandidates().length, 2);
  assert.equal(w.document.querySelector('#search-scope-label').textContent, '2 个目录');
  await w.selectCategory('支付');
  assert.equal(state.categories.length, 0);
  assert.equal(new URL(requests.at(-1), 'http://localhost').searchParams.get('category'), '支付');
});

test('detail omits the system record ID and removes the border from the first visible section on every tab', async t => {
  const w = await setup(t);
  w.fetch = async () => ({ ok: true, json: async () => ({ ...record(), normal: {}, indexes: {}, display: { enabled: false }, protected_fields: [] }) });
  await w.openRecordDetail('rec-001');
  assert.equal(w.document.querySelector('.system-record-info'), null);
  const first = w.document.querySelector('#record-detail-content .first-visible-section');
  assert.equal(first.querySelector('h4').textContent, '展示字段');
  assert.equal(w.getComputedStyle(first).borderTopWidth, '0px');
  w.selectDetailTab('secrets');
  assert.equal(w.document.querySelector('.first-visible-section h4').textContent, '展示字段');
  assert.equal(w.document.querySelector('[data-detail-tab="secrets"]'), null);
});

test('empty dataset descriptions omit readonly sections and expansion while keeping the add action for owners', async t => {
  const w = await setup(t), ds = w.stateForTest.datasets[0], d = w.document;
  ds.description = ' \n ';
  w.openDatasetInfo('ds');
  assert.equal(d.querySelector('#dataset-info-content .dataset-description-section'), null);
  w.openDatasetEdit('ds');
  assert.equal(d.querySelector('#dataset-description-preview-panel').hidden, true);
  assert.equal(d.querySelector('#dataset-description-summary').hidden, true);
  assert.equal(d.querySelector('#edit-description').textContent, '添加描述');
  w.openManagedDataset('ds');
  assert.equal(d.querySelector('#dataset-detail-description details'), null);
  assert.equal(d.querySelector('#managed-edit-description').textContent, '添加描述');
  w.stateForTest.canManage = false; w.renderManagedDataset();
  assert.equal(d.querySelector('#dataset-detail-description').hidden, true);
  ds.description = '## 有说明'; w.renderManagedDataset(); w.openDatasetInfo('ds');
  assert.equal(d.querySelector('#dataset-detail-description').hidden, false);
  assert.ok(d.querySelector('#dataset-info-content .dataset-description-section details'));
});

test('existing protected fields keep their detail tab and only decryptable secrets display the reveal explanation', async t => {
  const w = await setup(t), d = w.document;
  let fields = [{ field_name: 'secret', zone: 'secrets', masked: '••••' }];
  w.fetch = async () => ({ ok: true, json: async () => ({ ...record(), protected_fields: fields }) });
  await w.openRecordDetail('rec-001'); w.selectDetailTab('secrets');
  assert.ok(d.querySelector('[data-detail-tab="secrets"]'));
  assert.equal(d.querySelector('.protected-fields-help').hidden, false);
  assert.ok(d.querySelector('#detail-protected-fields .detail-secret-button'));
  w.closeRecordDetail(); fields = [{ field_name: 'private', zone: 'hidden', masked: '••••' }];
  await w.openRecordDetail('rec-001'); w.selectDetailTab('secrets');
  assert.equal(d.querySelector('.protected-fields-help').hidden, true);
  assert.ok(d.querySelector('#detail-protected-fields .protected'));
});
