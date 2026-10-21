const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const fields = [
  { source_key: 'code', display_name: '编号', zone: 'indexes' },
  { source_key: 'payload', display_name: '地址', zone: 'display' },
  { source_key: 'token', display_name: '凭据', zone: 'secrets' },
];
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  const d = w.document, state = w.stateForTest, calls = [];
  const definition = { fields, identity_fields: ['code'], list_fields: [], display_config: {}, supplement_fields: [] };
  Object.assign(state, { unlocked: true, canManage: true, datasets: [
    { ...definition, id: 'a', name: '测试账户', category_path: '业务/账户', environments: ['甲', '测试'], schema_id: 'm', schema_name: '账户模型', record_count: 4 },
    { ...definition, id: 'b', name: '生产账户', category_path: '业务/账户/生产', environments: ['甲', '生产'], schema_id: 'm', schema_name: '账户模型', record_count: 3 },
    { ...definition, id: 'c', name: '外部账户', category_path: '外部', environments: ['乙'], schema_id: 'm2', schema_name: '外部模型', record_count: 1 },
  ], catalog: { schemas: [{ id: 'm', name: '账户模型', dataset_ids: ['a', 'b'], definition, version: 1 }], environments: [] } });
  w.api = async (route, options) => { calls.push({ route, options }); return route === '/catalog' ? state.catalog : { records: [], total: 0, page: 1 }; };
  return { w, d, state, calls };
}
function change(w, control, value) {
  control.value = value; control.dispatchEvent(new w.Event('change', { bubbles: true }));
}
async function prepareImport(ctx, sources = ['code', 'unknown']) {
  ctx.w.openImport('a'); await tick();
  ctx.state.pendingBatchId = 'batch';
  ctx.w.renderMappings(sources, fields);
  ctx.w.setImportStep(2);
}

test('dataset selection narrows the current directory and clearing it preserves directory and query', async t => {
  const { w, d, state, calls } = await setup(t);
  state.category = '业务'; state.query = 'code:^A';
  w.renderFilters();
  const select = d.querySelector('#global-dataset-scope');
  assert.deepEqual([...select.options].map(option => option.value), ['', 'a', 'b']);
  change(w, select, 'b'); await tick();
  assert.equal(state.category, '业务');
  let params = new URL(calls.at(-1).route, 'http://test').searchParams;
  assert.equal(params.get('dataset_id'), 'b'); assert.equal(params.get('category'), '业务');
  change(w, select, ''); await tick();
  params = new URL(calls.at(-1).route, 'http://test').searchParams;
  assert.equal(params.get('dataset_id'), null); assert.equal(params.get('category'), '业务');
  assert.equal(params.get('q'), 'code:^A');
});

test('an explicit dataset selected from all directories is included in the request', async t => {
  const { w, d, state, calls } = await setup(t);
  w.renderFilters(); change(w, d.querySelector('#global-dataset-scope'), 'c'); await tick();
  assert.equal(state.category, 'all');
  assert.equal(new URL(calls.at(-1).route, 'http://test').searchParams.get('dataset_id'), 'c');
  assert.match(d.querySelector('#search-scope-summary').textContent, /数据集：外部账户/);
});

test('clear filters retains advanced query while reset clears both query and scope', async t => {
  const { w, d, state, calls } = await setup(t);
  Object.assign(state, { category: '业务', environmentTags: ['甲'], schemaFilter: 'm', includeExpired: true, query: 'code:^A token:=x' });
  d.querySelector('#search-input').value = state.query;
  w.renderFilters(); d.querySelector('#clear-filters').click(); await tick();
  assert.equal(state.query, 'code:^A token:=x'); assert.equal(state.category, 'all'); assert.equal(state.schemaFilter, '');
  assert.equal(state.includeExpired, false);
  assert.equal(new URL(calls.at(-1).route, 'http://test').searchParams.get('q'), state.query);
  d.querySelector('#reset-search').click(); await tick();
  assert.equal(state.query, ''); assert.equal(d.querySelector('#search-input').value, '');
});

test('scope chips remove individual labels and directories while keeping unrelated conditions', async t => {
  const { w, d, state, calls } = await setup(t);
  Object.assign(state, { categories: ['业务', '外部'], environmentTags: ['甲', '测试'], schemaFilter: 'm', query: '001' });
  w.renderFilters();
  d.querySelector('[data-scope-kind="label"][data-scope-value="测试"]').click(); await tick();
  assert.deepEqual([...state.environmentTags], ['甲']);
  d.querySelector('[data-scope-kind="directory"][data-scope-value="外部"]').click(); await tick();
  assert.equal(state.category, '业务'); assert.equal(state.schemaFilter, 'm'); assert.equal(state.query, '001');
  assert.equal(new URL(calls.at(-1).route, 'http://test').searchParams.get('category'), '业务');
});

test('empty states distinguish missing datasets and filtered results, with widening that preserves query', async t => {
  const { w, d, state } = await setup(t);
  state.query = 'missing'; state.environmentTags = ['测试'];
  await w.fetchRecords();
  assert.match(d.querySelector('#empty-state h3').textContent, /当前条件/);
  assert.equal(d.querySelector('#widen-search').hidden, false);
  d.querySelector('#widen-search').click(); await tick();
  assert.equal(state.query, 'missing'); assert.equal(state.environmentTags.length, 0);
  state.datasets = []; await w.fetchRecords();
  assert.match(d.querySelector('#empty-state h3').textContent, /还没有数据集/);
  assert.equal(d.querySelector('#widen-search').hidden, true);
});

test('dataset editing and shared model editing expose distinct scopes and routes', async t => {
  const { w, d, state } = await setup(t);
  w.openManagedDataset('a', 'basic'); await tick();
  assert.equal(d.querySelector('#dataset-detail-heading .shared-model-scope'), null);
  assert.equal(d.querySelector('#dataset-detail-tabs').hidden, true);
  assert.equal(d.querySelector('#managed-edit').textContent, '修改此数据集');
  d.querySelector('#managed-edit').click(); await tick();
  assert.equal(state.workspace, 'editor'); assert.equal(state.editDatasetId, 'a');
  assert.match(d.querySelector('#editor-model-reference').textContent, /仅对当前数据集生效/);
  w.openManagedDataset('a', 'fields'); await tick();
  assert.equal(d.querySelector('#managed-edit-model').textContent, '修改共享模型');
  d.querySelector('#managed-edit-model').click(); await tick();
  assert.equal(d.querySelector('#shared-schema-modal').open, true);
  assert.match(d.querySelector('#shared-schema-scope').textContent, /共 2 个数据集/);
});

test('model preview totals use server results and destructive changes expand with before and after keys', async t => {
  const { w, d } = await setup(t);
  w.api = async () => ({ confirmation_token: 'token', changes: [
    { id: 'a', category_path: '业务/账户', environments: ['测试'], record_count: 4, supplement_count: 2, changes: ['token：secrets → ignore（清除已有值）', '逻辑 KEY 变化'] },
    { id: 'b', category_path: '业务/账户/生产', environments: ['生产'], record_count: 3, supplement_count: 1, changes: ['更新列表展示与记录标识'] },
  ] });
  await w.previewSchemaOperation({ schema_id: 'm', definition: { identity_fields: ['payload'] } }, 'shared-schema-error');
  assert.match(d.querySelector('.model-impact-summary').textContent, /2 个数据集，共 7 条主表 \/ 3 条附表/);
  assert.equal(d.querySelector('.has-destructive-change').open, true);
  assert.match(d.querySelector('.has-destructive-change').textContent, /code → payload/);
  assert.equal(d.querySelector('.catalog-impact:not(.has-destructive-change)').open, false);
});

test('import prioritizes unresolved and JSON path fields and expanding all retains mappings', async t => {
  const ctx = await setup(t), { w, d } = ctx; await prepareImport(ctx);
  w.renderMappings(['code', 'payload', 'unknown'], fields, true, [{ source_key: 'payload', target_key: 'payload', json_path: 'endpoint' }]);
  assert.equal(d.querySelector('[data-map-source="code"]').closest('.mapping-row').hidden, true);
  assert.equal(d.querySelector('[data-map-source="unknown"]').closest('.mapping-row').hidden, false);
  assert.equal(d.querySelector('[data-map-source="payload"]').closest('.mapping-row').hidden, false);
  assert.equal(d.querySelector('[data-map-path="payload"]').closest('details').open, true);
  d.querySelector('#toggle-mapping-fields').click();
  assert.equal(d.querySelector('[data-map-source="code"]').closest('.mapping-row').hidden, false);
  assert.equal(d.querySelector('[data-map-path="payload"]').value, 'endpoint');
});

test('mapping errors are inline and navigable, duplicate destinations remain visible', async t => {
  const ctx = await setup(t), { w, d, calls } = ctx; await prepareImport(ctx);
  await w.commitImport();
  assert.equal(d.querySelector('#import-config-error').hidden, false);
  assert.match(d.querySelector('#import-config-error').textContent, /未处理/);
  d.querySelector('#import-config-error button').click();
  assert.equal(d.activeElement.dataset.mapSource, 'unknown');
  assert.equal(calls.some(call => call.route === '/records/import/preview'), false);
  change(w, d.querySelector('[data-map-source="unknown"]'), 'code');
  await w.commitImport();
  assert.equal(d.querySelectorAll('#mapping-list [aria-invalid="true"]').length, 2);
  assert.equal(d.querySelector('[data-map-source="code"]').closest('.mapping-row').hidden, false);
  assert.match(d.querySelector('#import-config-error').textContent, /同一个目标/);
});

test('preview errors keep configuration and retry separates counts with target-specific deletion warning', async t => {
  const ctx = await setup(t), { w, d, state } = ctx; await prepareImport(ctx, ['code']);
  w.api = async () => { throw new Error('服务暂不可用'); };
  await w.commitImport();
  assert.equal(state.importStep, 2); assert.equal(state.pendingBatchId, 'batch');
  assert.match(d.querySelector('#import-config-error').textContent, /服务暂不可用/);
  d.querySelector('#delete-missing').checked = true;
  w.api = async () => ({ imported: 2, updated: 1, skipped: 3, deleted_missing: 4 });
  await w.commitImport();
  assert.equal(state.importStep, 3);
  assert.match(d.querySelector('.import-deletion-warning').textContent, /测试账户.*删除 4 条/);
  assert.match(d.querySelector('#import-confirm-summary').textContent, /新增2 条更新1 条跳过3 条/);
  d.querySelector('#import-back').click();
  assert.equal(d.querySelector('#delete-missing').checked, true);
  assert.equal(d.querySelector('[data-map-source="code"]').value, 'code');
});

test('dataset secondary actions remain available under a labelled disclosure', async t => {
  const { w, d } = await setup(t); w.renderDatasetManager();
  const row = d.querySelector('.dataset-manager-row');
  assert.equal(row.querySelector('.dataset-more-actions').open, false);
  assert.match(row.querySelector('.dataset-more-actions summary').getAttribute('aria-label'), /测试账户/);
  assert.equal(row.querySelectorAll('.dataset-more-actions button').length, 5);
  assert.equal(row.querySelector('.dataset-manage-button').textContent, '管理');
});

test('sealing clears added scope metadata, model references and inline import errors', async t => {
  const ctx = await setup(t), { w, d, state } = ctx;
  state.query = 'private-query'; w.renderFilters();
  await prepareImport(ctx); await w.commitImport();
  await w.sealVault('', false);
  assert.equal(d.querySelector('#search-scope-summary').textContent, '');
  assert.equal(d.querySelector('#import-config-error').textContent, '');
  assert.equal(d.querySelector('#shared-schema-scope').textContent, '');
  await tick();
});
