const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const sql = 'SELECT code, name\nFROM demo_products\nWHERE enabled = 1;\n';
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  const definition = { fields: [{ source_key: 'code', display_name: '编号', zone: 'indexes', position: 0 }], identity_fields: ['code'], list_fields: [], display_config: {}, supplement_fields: [] };
  const models = ['a', 'b'].map(id => ({ id: 'model-' + id, name: id === 'a' ? '产品模型' : '账号模型', version: 3, description: id === 'a' ? '## 取数方法\n\n```sql\n' + sql + '```' : '账号数据请从演示控制台导出。', definition, dataset_ids: [id] }));
  const datasets = models.map((model, index) => ({ ...definition, id: index ? 'b' : 'a', name: index ? '账号凭据' : '产品凭据', category_path: index ? '示例/账号' : '示例/产品', environments: ['客户A', index ? '生产' : '测试'], description: index ? '生产实例备注' : '测试实例备注', schema_id: model.id, schema_name: model.name, schema_version: model.version, record_count: index ? 20 : 10 }));
  const state = w.stateForTest;
  Object.assign(state, { unlocked: true, canManage: true, datasets, catalog: { schemas: models, environments: [] } });
  const calls = [];
  w.api = async (route, options) => { calls.push({ route, options }); return route === '/catalog' ? { schemas: models, environments: [] } : {}; };
  return { w, d: w.document, state, models, datasets, calls };
}

test('basic editing shows the referenced model and full acquisition notes without leaving or changing its draft', async t => {
  const { w, d, state, calls } = await setup(t);
  w.openDatasetEdit('a', 'basic'); await tick();
  assert.equal(d.querySelector('#editor-model-reference').hidden, false);
  assert.match(d.querySelector('#editor-model-reference').textContent, /产品模型/);
  assert.match(d.querySelector('#editor-model-reference').textContent, /取数方法/);
  d.querySelector('#dataset-name').value = '正在编辑的名称'; state.editorDirty = true;
  d.querySelector('#editor-model-reference [data-reference]').click();
  assert.equal(d.querySelector('#reference-info-modal').open, true);
  assert.equal(d.querySelector('#reference-info-content pre code').textContent, sql);
  assert.equal(d.querySelector('#reference-info-content textarea, #reference-info-content input'), null);
  d.querySelector('#close-reference-info').click();
  assert.equal(state.workspace, 'editor'); assert.equal(state.editDatasetId, 'a'); assert.equal(state.editorDirty, true);
  assert.equal(d.querySelector('#dataset-name').value, '正在编辑的名称');
  assert.ok(calls.every(call => !call.options?.method));
});

test('ordinary import shows dataset and model before file selection and details preserve mappings and import options', async t => {
  const { w, d, state } = await setup(t);
  w.openImport('a'); await tick();
  assert.match(d.querySelector('#import-context').textContent, /产品凭据/);
  assert.match(d.querySelector('#import-context').textContent, /产品模型/);
  assert.match(d.querySelector('#import-context').textContent, /取数方法/);
  state.pendingBatchId = 'batch-keep';
  w.renderMappings(['code'], state.datasets[0].fields, true); w.setImportStep(2);
  d.querySelector('[data-map-path]').value = 'product.code'; d.querySelector('#mapping-template').value = '保留映射';
  d.querySelector('#skip-existing').checked = true;
  d.querySelector('#import-context [data-reference="dataset"]').click();
  assert.match(d.querySelector('#reference-info-content').textContent, /测试实例备注/);
  d.querySelector('#close-reference-info').click();
  d.querySelector('#import-context [data-reference="model"]').click();
  assert.equal(d.querySelector('#reference-info-content pre code').textContent, sql);
  d.querySelector('#close-reference-info').click();
  assert.equal(state.pendingBatchId, 'batch-keep'); assert.equal(state.importStep, 2);
  assert.equal(d.querySelector('[data-map-path]').value, 'product.code');
  assert.equal(d.querySelector('#mapping-template').value, '保留映射'); assert.equal(d.querySelector('#skip-existing').checked, true);
  w.confirm = () => true;
  d.querySelector('#import-dataset-select').value = 'b'; d.querySelector('#import-dataset-select').dispatchEvent(new w.Event('change'));
  assert.match(d.querySelector('#import-context').textContent, /账号模型/);
  assert.ok(!d.querySelector('#import-context').textContent.includes('产品模型'));
});

test('native import keeps file model notes separate from an existing model with the same name and preserves raw input', async t => {
  const { w, d, state } = await setup(t);
  w.openImport('a'); await tick();
  const file = { format: 'securevault-dataset', version: 1, mode: 'schema', schema: { name: '文件中的产品', category_path: '文件/产品', environments: ['预发布'], schema_name: '产品模型', schema_description: '文件专用提取方法', description: '文件数据集备注', fields: [] }, records: [] };
  const raw = JSON.stringify(file);
  await w.importFile({ name: 'demo.schema.json', text: async () => raw });
  assert.equal(d.querySelectorAll('#transfer-schema-preview .dataset-model-fields').length, 2);
  assert.equal(d.querySelector('#transfer-schema-preview th').textContent, '序号');
  assert.equal(d.querySelector('#transfer-schema-preview [role="region"]').tabIndex, 0);
  assert.match(d.querySelector('#import-context').textContent, /文件专用提取方法/);
  assert.ok(!d.querySelector('#import-context').textContent.includes('SELECT code'));
  d.querySelector('#transfer-category').value = '目标/新目录'; d.querySelector('#transfer-category').dispatchEvent(new w.Event('input'));
  assert.match(d.querySelector('#import-context').textContent, /目标\/新目录/);
  d.querySelector('#transfer-target').value = 'a'; d.querySelector('#transfer-target').dispatchEvent(new w.Event('change'));
  assert.equal(d.querySelector('.import-target-details').open, false);
  assert.match(d.querySelector('.import-target-details > .reference-grid').textContent, /取数方法/);
  assert.match(d.querySelector('.import-source-details').textContent, /文件专用提取方法/);
  d.querySelector('.import-target-details').open = true;
  d.querySelector('.import-source-details').open = true;
  d.querySelector('[data-reference="sourceModel"]').click();
  assert.match(d.querySelector('#reference-info-content').textContent, /文件专用提取方法/);
  assert.ok(!d.querySelector('#reference-info-content').textContent.includes('SELECT code'));
  d.querySelector('#close-reference-info').click();
  assert.equal(state.transferRaw, raw); assert.equal(d.querySelector('#transfer-target').value, 'a'); assert.equal(state.importStep, 2);
});

test('late catalog loads use the current target and sealing clears acquisition notes without resurrecting a view', async t => {
  const { w, d, state, models } = await setup(t);
  state.catalog.schemas = [];
  let resolveCatalog;
  w.api = async () => new Promise(resolve => { resolveCatalog = resolve; });
  w.openImport('a');
  d.querySelector('#import-dataset-select').value = 'b'; d.querySelector('#import-dataset-select').dispatchEvent(new w.Event('change'));
  resolveCatalog({ schemas: models, environments: [] }); await tick();
  assert.match(d.querySelector('#import-context').textContent, /账号数据请从演示控制台导出/);
  assert.ok(!d.querySelector('#import-context').textContent.includes('取数方法'));
  w.openImport('a'); const finish = resolveCatalog;
  await w.sealVault('', false); finish({ schemas: models, environments: [] }); await tick();
  assert.equal(d.querySelector('#import-context').textContent, ''); assert.equal(d.querySelector('#editor-model-reference').textContent, '');
  assert.equal(d.querySelector('#reference-info-content').textContent, ''); assert.equal(state.referenceDetails, null);
});

test('catalog failure remains retryable and readonly reference views safely render file descriptions and field positions', async t => {
  const { w, d, state, models } = await setup(t);
  state.catalog.schemas = [];
  w.api = async () => { throw new Error('connection failed'); };
  w.openImport('a'); await tick();
  assert.match(d.querySelector('#import-context').textContent, /重新加载/);
  state.pendingBatchId = 'keep';
  w.api = async () => ({ schemas: models, environments: [] });
  d.querySelector('[data-retry-reference]').click(); await tick();
  assert.equal(state.pendingBatchId, 'keep'); assert.match(d.querySelector('#import-context').textContent, /取数方法/);
  w.openReferenceDetails('model', { name: '<script>bad()</script>', version: '<img src=x>', description: '<script>bad()</script>\n\n```sql\nSELECT 1;\n```', definition: { fields: [{ source_key: 'code', zone: 'indexes', position: '<img src=x>' }] } }, '文件信息');
  assert.equal(d.querySelector('#reference-info-content script, #reference-info-content img'), null);
  assert.equal(d.querySelector('#reference-info-content pre code').textContent, 'SELECT 1;\n');
  d.querySelector('#close-reference-info').click(); state.canManage = false;
  w.renderImportContext(); w.renderEditorModelReference();
  assert.equal(d.querySelector('#import-context').hidden, true); assert.equal(d.querySelector('#editor-model-reference').hidden, true);
  w.openReferenceDetails('model', models[0], '不应打开'); assert.equal(d.querySelector('#reference-info-modal').open, false);
});

test('invalid native structure leaves no partial file context and the original target remains selectable', async t => {
  const { w, d, state } = await setup(t);
  w.openImport('a'); await tick();
  const raw = JSON.stringify({ format: 'securevault-dataset', version: 1, mode: 'schema', schema: { name: '坏文件', fields: {} } });
  await w.importFile({ name: 'invalid.schema.json', text: async () => raw });
  assert.equal(state.transferPackage, null); assert.equal(state.importStep, 1);
  assert.equal(d.querySelector('#native-import-target').hidden, true); assert.equal(d.querySelector('#ordinary-import-target').hidden, false);
  assert.equal(d.querySelector('#import-dataset-select').value, 'a');
  assert.match(d.querySelector('#import-context').textContent, /产品凭据/);
  assert.ok(!d.querySelector('#import-context').textContent.includes('坏文件'));
});


test('native label arrays survive punctuation, target changes, pending additions and sealing', async t => {
  const { w, d, state } = await setup(t);
  const labels = ['客户A,区域 / 主站;备站', '生产；正式', ' 旧标签 '];
  const file = { format: 'securevault-dataset', version: 1, mode: 'schema', schema: { category_path: '文件/产品', environments: labels, fields: [] }, records: [] };
  w.openImport('a'); await tick();
  await w.importFile({ name: 'demo.schema.json', text: async () => JSON.stringify(file) });
  assert.deepEqual(Array.from(w.buildTransferRequest().environments), labels);
  assert.equal(d.querySelectorAll('#transfer-environment-tags .selected-label').length, 3);
  d.querySelector('#transfer-environment').value = ' 新标签,含逗号;和分号 ';
  assert.deepEqual(Array.from(w.buildTransferRequest().environments), [...labels, '新标签', '含逗号', '和分号']);
  assert.equal(d.querySelector('#transfer-environment').value, '');
  d.querySelector('#transfer-environment-tags button').click();
  assert.deepEqual(Array.from(w.buildTransferRequest().environments), [...labels.slice(1), '新标签', '含逗号', '和分号']);
  d.querySelector('#transfer-target').value = 'a'; d.querySelector('#transfer-target').dispatchEvent(new w.Event('change'));
  assert.deepEqual(Array.from(w.buildTransferRequest().environments), ['客户A', '测试']);
  await w.sealVault('', false);
  assert.equal(state.transferEnvironmentDraft.length, 0);
  assert.equal(d.querySelector('#transfer-environment-tags').textContent, '');
  assert.equal(d.querySelector('#transfer-environment-options').textContent, '');
});

test('basic tag editing batches new names while preserving existing labels and Unicode limits', async t => {
  const { w, d, state, calls } = await setup(t);
  const old = ' 旧客户,区域 / 主站;备站 ';
  state.datasets[0].environments = [old, '生产'];
  w.openDatasetEdit('a', 'basic'); await tick();
  d.querySelector('#dataset-environment-select').value = ' 新客户,区域;甲 ';
  await w.createDataset();
  const saved = calls.find(call => call.options?.method === 'PATCH');
  assert.deepEqual(JSON.parse(saved.options.body).environment_names, [old, '生产', '新客户', '区域', '甲']);
  assert.deepEqual(Array.from(w.appendLabelInput([], old)), [old]);
  assert.deepEqual(Array.from(w.appendLabelInput([], '客户A，生产;客户A；测试')), ['客户A', '生产', '测试']);
  assert.equal(w.appendLabelInput([], '🌱'.repeat(120))[0], '🌱'.repeat(120));
  assert.throws(() => w.appendLabelInput([], '🌱'.repeat(121)), /120/);
  assert.throws(() => w.appendLabelInput([], '新\u0085标签'), /控制字符/);
});

test('referenced model viewing and editing share compact fields and preserve the surrounding dataset draft', async t => {
  const { w, d, state, calls } = await setup(t);
  state.catalog.schemas[0].description = '';
  w.openDatasetEdit('a', 'basic'); await tick();
  d.querySelector('#dataset-name').value = '未保存的数据集名称';
  d.querySelector('#dataset-name').dispatchEvent(new w.Event('input', { bubbles: true }));
  d.querySelector('#editor-model-reference [data-reference]').click();
  assert.equal(d.querySelectorAll('#reference-info-content .dataset-model-fields').length, 2);
  assert.equal(d.querySelector('#reference-info-content [role="tab"], #reference-info-content .reference-fields'), null);
  assert.match(d.querySelector('#reference-info-content').textContent, /暂无模型描述/);
  d.querySelector('[data-reference-model-edit]').click(); await tick();
  assert.equal(d.querySelector('#reference-info-modal').open, false);
  assert.equal(d.querySelector('#shared-schema-modal').open, true);
  assert.equal(state.schemaDraft.id, 'model-a');
  assert.equal(state.workspace, 'editor');
  assert.equal(state.editDatasetId, 'a');
  assert.equal(d.querySelector('#dataset-name').value, '未保存的数据集名称');
  assert.equal(state.editorDirty, true);
  assert.ok(calls.every(call => !call.options?.method));
});

test('file model snapshots never provide an edit action for a live model with the same name', async t => {
  const { w, d, models } = await setup(t);
  w.openReferenceDetails('model', { ...w.fileModelReference({ schema_name: models[0].name, fields: [] }) }, '文件中的数据模型');
  assert.equal(d.querySelector('[data-reference-model-edit]'), null);
  assert.equal(d.querySelectorAll('#reference-info-content .dataset-model-fields').length, 2);
});
