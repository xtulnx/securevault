const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const fields = [
  { source_key: 'code', display_name: '编号', zone: 'indexes' },
  { source_key: 'enabled', display_name: '启用', zone: 'display' },
  { source_key: 'payload', display_name: '配置', zone: 'display' },
  { source_key: 'private', display_name: '密钥', zone: 'secrets' },
];
const dataset = { id: 'a', name: '账户', category_path: '业务/测试', environments: ['内部', '测试'], schema_id: 'm', schema_name: '模型', fields, identity_fields: ['code'], list_fields: [], supplement_fields: [{ source_key: 'status', display_name: '状态', zone: 'display' }] };
const record = { id: 'rec-a', dataset_id: 'a', indexes: { code: 0 }, display: { enabled: false, payload: { x: '<img src=x>' } }, normal: { private: 'never-show' }, secret_count: 1, matched_fields: ['enabled'], expired: false };
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  const d = w.document, state = w.stateForTest;
  Object.assign(state, { unlocked: true, canManage: true, datasets: [dataset, { ...dataset, id: 'b', category_path: '其他' }], records: [record], total: 1, selectedDatasetId: 'a', catalog: { schemas: [], environments: [] } });
  w.api = async path => path === '/catalog' ? state.catalog : { records: [record], total: 1, page: 1 };
  return { w, d, state };
}
function change(w, input, value) {
  if (input.type === 'checkbox') input.checked = value; else input.value = value;
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
}
test('single dataset table preserves typed public values and separates sensitive actions', async t => {
  const { w, d } = await setup(t);
  w.renderRecords(); change(w, d.querySelector('#result-view'), 'table');
  const table = d.querySelector('.record-table');
  assert.match(table.textContent, /编号：0/); assert.match(table.textContent, /false/);
  assert.match(table.textContent, /<img src=x>/); assert.equal(table.querySelector('img'), null);
  assert.doesNotMatch(table.textContent, /never-show/); assert.equal(d.querySelector('[data-table-column="private"]'), null);
  assert.ok(table.querySelector('.is-match')); assert.ok(table.querySelector('[data-action="open-secrets"]'));
  assert.match(table.querySelector('caption').textContent, /当前第 1 页，1 条/);
});
test('column visibility and width are isolated by dataset and clear on seal', async t => {
  const { w, d, state } = await setup(t);
  w.renderRecords(); change(w, d.querySelector('#result-view'), 'table');
  change(w, d.querySelector('[data-table-column="enabled"]'), false);
  change(w, d.querySelector('[data-table-width="payload"]'), 9999);
  assert.equal(d.querySelector('[data-table-width="payload"]').value, '640');
  assert.doesNotMatch(d.querySelector('.record-table thead').textContent, /启用/);
  state.selectedDatasetId = 'b'; state.records = []; w.renderRecords();
  assert.equal(d.querySelector('[data-table-column="enabled"]').checked, true);
  state.selectedDatasetId = null; w.renderRecords();
  assert.equal(d.querySelector('.record-table'), null);
  assert.equal(d.querySelector('#result-view option[value="table"]').disabled, true);
  await w.sealVault('test', false);
  assert.equal(d.querySelector('#table-column-list').textContent, '');
  state.unlocked = true; state.datasets = [dataset]; w.renderRecords(); change(w, d.querySelector('#result-view'), 'table');
  assert.equal(d.querySelector('[data-table-width="payload"]').value, '220');
});
test('table keyboard movement and child buttons retain separate behavior', async t => {
  const { w, d, state } = await setup(t); state.records.push({ ...record, id: 'rec-b' }); state.total = 2;
  let opened; w.openRecordDetail = id => { opened = id; };
  w.renderRecords(); change(w, d.querySelector('#result-view'), 'table');
  const buttons = d.querySelectorAll('.record-open');
  buttons[0].dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(d.activeElement, buttons[1]);
  const event = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  d.querySelector('[data-action="open-secrets"]').dispatchEvent(event);
  assert.equal(event.defaultPrevented, false); assert.equal(opened, undefined);
  buttons[1].click(); assert.equal(opened, 'rec-b');
});
test('table columns follow the configured list order instead of schema field order', async t => {
  const { w, d, state } = await setup(t);
  state.datasets[0] = { ...state.datasets[0], list_fields: [{source_key:'code',position:2,visible:true},{source_key:'payload',position:0,visible:true},{source_key:'enabled',position:1,visible:true}] };
  w.renderRecords(); change(w, d.querySelector('#result-view'), 'table');
  assert.deepEqual([...d.querySelectorAll('.record-table thead th')].map(e=>e.textContent),['记录标识','配置','启用','编号','操作']);
});
test('table avoids assigning a new schema to stale rows and handles special field names', async t => {
  const { w, d, state } = await setup(t);
  state.datasets = [{ ...dataset, fields: [...fields, { source_key: 'constructor', display_name: '构造参数', zone: 'display' }] }, state.datasets[1]];
  state.records = [{ ...record, display: { ...record.display, constructor: 'visible' } }];
  w.renderRecords(); change(w, d.querySelector('#result-view'), 'table');
  assert.equal(d.querySelector('[data-table-width="constructor"]').value, '220');
  change(w, d.querySelector('[data-table-width="constructor"]'), 320);
  assert.match(d.querySelector('.record-table').textContent, /visible/);
  state.selectedDatasetId = 'b'; w.renderRecords();
  assert.equal(d.querySelector('.record-table'), null);
});
test('saved queries capture all filters and restore one request at page one without local storage', async t => {
  const { w, d, state } = await setup(t); const calls = []; let query;
  Object.assign(state, { query: 'enabled:=false', categories: ['业务', '其他'], category: 'all', environmentTags: ['内部', '测试'], schemaFilter: 'm', includeExpired: true, page: 3 });
  w.api = async (path, options) => {
    calls.push({ path, options });
    if (path === '/saved-queries') { query = { id: 'q1', ...JSON.parse(options.body) }; return query; }
    return { records: [], total: 0, page: 1 };
  };
  d.querySelector('#saved-query-name').value = '常用范围';
  await w.saveQuery('create');
  assert.deepEqual(query.filters, { q: 'enabled:=false', categories: ['业务', '其他'], labels: ['内部', '测试'], dataset_id: 'a', schema_id: 'm', include_expired: true });
  Object.assign(state, { query: 'changed', categories: [], category: '其他', environmentTags: [], includeExpired: false });
  await w.applySavedQuery();
  const searches = calls.filter(call => call.path.startsWith('/records/search?'));
  assert.equal(searches.length, 1);
  const params = new URL('http://localhost' + searches[0].path).searchParams;
  assert.equal(params.get('dataset_id'), 'a'); assert.equal(params.get('q'), 'enabled:=false');
  assert.equal(params.get('page'), '1'); assert.equal(params.get('include_expired'), 'true');
  assert.equal(params.get('schema_id'), 'm');
  assert.equal(params.get('environment_tags'), '["内部","测试"]');
  assert.equal(w.localStorage.getItem('saved-queries'), null);
  assert.equal(w.sessionStorage.length, 0);
});
test('stale saved dataset scope never silently broadens the current search', async t => {
  const { w, d, state } = await setup(t);
  const filters = { q: 'saved', categories: ['业务'], labels: [], dataset_id: 'a', schema_id: null, include_expired: false };
  w.api = async () => ({ queries: [{ id: 'q', name: '移动前', filters }] });
  await w.loadSavedQueries(); change(w, d.querySelector('#saved-query-select'), 'q');
  state.datasets = [{ ...dataset, category_path: '已移动' }]; state.query = 'keep';
  let searches = 0; w.api = async () => { searches++; };
  await w.applySavedQuery();
  assert.equal(state.query, 'keep'); assert.equal(searches, 0);
  assert.match(d.querySelector('#saved-query-status').textContent, /未应用/);
});
test('query save failure retains name and filters; deleting preserves active search', async t => {
  const { w, d, state } = await setup(t);
  const filters = w.captureQueryFilters();
  w.api = async () => ({ queries: [{ id: 'q', name: '已保存', filters }] });
  await w.loadSavedQueries(); change(w, d.querySelector('#saved-query-select'), 'q');
  d.querySelector('#saved-query-name').value = '重命名';
  w.api = async () => { throw new Error('保存失败'); };
  await w.saveQuery('update');
  assert.equal(d.querySelector('#saved-query-name').value, '重命名');
  assert.match(d.querySelector('#saved-query-status').textContent, /保存失败/);
  state.query = 'keep'; w.api = async () => ({ deleted: true });
  await w.saveQuery('delete');
  assert.equal(state.query, 'keep'); assert.equal(d.querySelector('#saved-query-select').options.length, 1);
});
test('late saved query responses cannot repopulate the sealed interface', async t => {
  const { w, d, state } = await setup(t); let resolve;
  state.query = 'private-query'; d.querySelector('#search-input').value = state.query;
  w.api = () => new Promise(done => { resolve = done; });
  const pending = w.loadSavedQueries();
  await w.sealVault('test', false);
  resolve({ queries: [{ id: 'late', name: 'private query', filters: {} }] }); await pending;
  assert.equal(d.querySelector('#saved-query-select').options.length, 1);
  assert.equal(d.querySelector('#saved-query-status').textContent, '');
  assert.equal(state.query, ''); assert.equal(d.querySelector('#search-input').value, '');
});
async function parentSetup(t) {
  const ctx = await setup(t), { w } = ctx;
  w.api = async path => path.includes('/records/search?') ? { records: [record], total: 21 } : path.endsWith('/supplement') ? { fields: [{ source_key: 'note', zone: 'normal' }], records: [], link_mode: 'id', link_fields: [] } : { ...record, supplement_records: [] };
  await w.openManualRecord('supplement', 'a'); return ctx;
}
test('parent cards expose readable identity, occupancy and paginated scoped requests', async t => {
  const { w, d } = await parentSetup(t);
  let params;
  w.api = async path => { params = new URL('http://localhost' + path).searchParams; return { records: [record, { ...record, id: 'occupied', expired: true, supplement: { id: 'other' } }], total: 21 }; };
  await w.searchManualParents(2);
  assert.equal(params.get('dataset_id'), 'a'); assert.equal(params.get('limit'), '10'); assert.equal(params.get('page'), '2');
  assert.match(d.querySelector('#manual-parent-results').textContent, /编号：0/);
  assert.equal(d.querySelector('[data-parent-select="occupied"]').disabled, true);
  d.querySelector('[data-parent-select="rec-a"]').click();
  assert.match(d.querySelector('#manual-parent-selected').textContent, /已选择：编号：0/);
  assert.equal(d.querySelector('#manual-parent-id').value, 'rec-a');
  assert.equal(d.querySelector('#manual-parent-page').textContent, '第 2 / 3 页');
  assert.equal(d.querySelector('#manual-parent-advanced').open, false);
});
test('parent search latest result wins, and sealing clears cards and selected identity', async t => {
  const { w, d } = await parentSetup(t); let finish;
  w.api = () => new Promise(resolve => { finish = resolve; });
  const old = w.searchManualParents();
  w.api = async () => ({ records: [{ ...record, id: 'new' }], total: 1 });
  await w.searchManualParents();
  finish({ records: [{ ...record, id: 'old' }], total: 1 }); await old;
  assert.equal(d.querySelector('[data-parent-select="old"]'), null);
  assert.ok(d.querySelector('[data-parent-select="new"]'));
  await w.sealVault('test', false);
  assert.equal(d.querySelector('#manual-parent-results').textContent, '');
  assert.equal(d.querySelector('#manual-parent-selected').textContent, '');
});
test('invalid, occupied and cross-dataset IDs cannot be saved, and failures retain field drafts', async t => {
  const { w, d } = await parentSetup(t); const writes = [];
  const input = d.querySelector('.manual-value'); input.value = '保留草稿'; input.dispatchEvent(new w.Event('input', {bubbles:true}));
  d.querySelector('#manual-parent-id').value = 'foreign';
  w.api = async (path, options) => { if (options?.method) writes.push(path); return { ...record, id: 'foreign', dataset_id: 'b' }; };
  await w.saveManualRecord(); assert.equal(writes.length, 0); assert.equal(input.value, '保留草稿');
  w.api = async () => ({ ...record, id: 'foreign', supplement_records: [{ id: 'occupied' }] });
  await w.saveManualRecord(); assert.equal(writes.length, 0); assert.equal(d.querySelector('#manual-record-modal').hidden, false);
});
test('parent selection validates fresh occupancy before submitting the exact link', async t => {
  const { w, d } = await parentSetup(t); const calls = [];
  d.querySelector('[data-parent-select="rec-a"]').click();
  w.openSupplement = async () => {};
  w.api = async (path, options) => { calls.push({ path, options }); return options?.method === 'POST' ? { id: 'sup-new' } : { ...record, supplement_records: [] }; };
  await w.saveManualRecord();
  assert.equal(calls[0].path, '/records/rec-a');
  const write = calls.find(call => call.options?.method === 'POST');
  assert.equal(JSON.parse(write.options.body).main_record_id, 'rec-a');
  assert.equal(d.querySelector('#manual-record-modal').hidden, true);
});
