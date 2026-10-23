const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, datasets: [], catalog: { schemas: [], environments: [] } });
  const calls = [];
  w.api = async (url, options) => {
    calls.push({ url, options });
    if (url === '/catalog') return { schemas: [], environments: [] };
    if (url === '/imports/text') return { batch_id: 'new-batch', source_fields: ['code', 'artist_id'], record_count: 1, format: 'json' };
    if (url === '/records/import/preview') return { valid: true, imported: 1 };
    if (url === '/records/import') return { dataset_id: 'created', imported: 1, created_dataset: true };
    return {};
  };
  return { w, d: w.document, calls };
}
function fill(w, id, value) {
  const input = w.document.getElementById(id); input.value = value;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
}
for (const source of ['text', 'file']) test(`${source} import can define a model without any existing dataset and creates only after confirmation`, async t => {
  const { w, d, calls } = await setup(t);
  w.openImport();
  assert.equal(d.querySelector('#import-button').disabled, false);
  assert.equal(d.querySelector('#import-dataset-select').value, '__new');
  assert.equal(d.querySelector('#import-new-dataset').hidden, false);
  fill(w, 'import-new-category', '业务/艺人'); fill(w, 'import-new-name', '艺人配置');
  fill(w, 'import-new-schema-name', '艺人模型'); fill(w, 'import-new-tags', '测试, 客户A');
  fill(w, 'import-new-schema-description', '字段说明');
  if (source === 'text') {
    const radio = d.querySelector('input[name="import-source"][value="text"]'); radio.checked = true;
    radio.dispatchEvent(new w.Event('change', { bubbles: true }));
    fill(w, 'import-text', '{"code":"001","artist_id":"002"}'); await w.parseImportText();
  } else {
    w.fetch = async () => ({ ok: true, json: async () => ({ batch_id: 'new-batch', source_fields: ['code', 'artist_id'], record_count: 1, filename: 'artists.yaml' }) });
    await w.importFile(new w.File(['fixture'], 'artists.yaml'));
  }
  assert.equal(d.querySelector('#first-schema').hidden, false);
  assert.equal(calls.some(call => /\/templates|^\/datasets$/.test(call.url)), false);
  const schemaRows = d.querySelectorAll('#first-schema-fields .schema-field');
  schemaRows[0].querySelector('.schema-field-unique').checked = true;
  const request = w.buildImportRequest();
  assert.equal(request.dataset_id, ''); assert.equal(request.new_dataset.schema_name, '艺人模型');
  assert.equal(request.new_dataset.schema_description, '字段说明');
  assert.equal(request.evolved_fields.length, 2); assert.equal(request.evolved_identity_fields.join(','), 'code');
  assert.equal(request.new_dataset.environment_names.join(','), '测试,客户A');
  await w.commitImport();
  assert.equal(w.stateForTest.importStep, 3);
  assert.match(d.querySelector('#import-confirm-summary').textContent, /将创建独立数据模型：艺人模型/);
  assert.equal(calls.some(call => call.url === '/records/import'), false);
  let opened; w.openManagedDataset = id => { opened = id; };
  await w.confirmImport(); d.querySelector('#import-finish').click();
  assert.equal(opened, 'created');
  assert.equal(JSON.parse(calls.find(call => call.url === '/records/import').options.body).new_dataset.name, '艺人配置');
  assert.equal(d.querySelector('#import-new-name').value, '');
});

test('new target metadata is required, edits invalidate previews, cancellation never creates an empty dataset', async t => {
  const { w, d, calls } = await setup(t); w.openImport();
  fill(w, 'import-text', '{"code":"001"}'); await w.parseImportText();
  assert.throws(() => w.buildImportRequest(), /目标目录和新数据模型名称/);
  fill(w, 'import-new-category', '导入/新建'); fill(w, 'import-new-schema-name', '模型');
  let resolve; w.api = () => new Promise(done => { resolve = done; });
  const pending = w.commitImport(); fill(w, 'import-new-schema-name', '改变后的模型');
  resolve({ valid: true, imported: 1 }); await pending;
  assert.equal(w.stateForTest.importPreview, null);
  w.resetImport();
  assert.equal(calls.some(call => call.url === '/datasets' || call.url === '/records/import'), false);
  assert.equal(d.querySelector('#import-new-schema-name').value, '');
});

const impact = { allowed: true, name: '实例A', category_path: '测试/实例A', records: 3, protected_fields: 2, supplements: 1, templates: 1, scoped_apps: 2, disabled_apps: 1, confirmation_token: 'token', expires_at: 123 };
test('physical deletion requires exact name and sends the preview token with visible impact', async t => {
  const { w, d } = await setup(t); const calls = [];
  w.api = async (url, options) => { calls.push({ url, options }); return url.endsWith('/deletion-preview') ? impact : { deleted: true }; };
  await w.openPhysicalDelete('datasets', 'a');
  assert.match(d.querySelector('#physical-delete-impact').textContent, /3 条主表记录.*2 个加密字段.*1 条附表记录/);
  assert.match(d.querySelector('#physical-delete-impact').textContent, /自动禁用/);
  fill(w, 'physical-delete-name', '实例'); await w.confirmPhysicalDelete();
  assert.equal(calls.length, 1);
  fill(w, 'physical-delete-name', '实例A'); assert.equal(d.querySelector('#confirm-physical-delete').disabled, false);
  await w.confirmPhysicalDelete();
  assert.equal(calls[1].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[1].options.body), { confirmation_token: 'token', expected_name: '实例A', expires_at: 123 });
  assert.equal(d.querySelector('#physical-delete-modal').open, false);
});

test('referenced models show blockers and cannot delete; failed confirmation requires a fresh preview', async t => {
  const { w, d } = await setup(t);
  w.api = async () => ({ allowed: false, name: '共享模型', datasets: [{ id: 'a', name: '实例A', category_path: '目录' }] });
  await w.openPhysicalDelete('schemas', 'schema');
  assert.match(d.querySelector('#physical-delete-impact').textContent, /先迁移引用或删除关联数据集/);
  assert.equal(d.querySelector('#physical-delete-name-wrap').hidden, true);
  w.api = async (_, options) => { if (options.method === 'DELETE') throw new Error('预检已失效'); return impact; };
  await w.openPhysicalDelete('datasets', 'a'); fill(w, 'physical-delete-name', '实例A');
  await w.confirmPhysicalDelete();
  assert.equal(w.stateForTest.deletionPreview, null);
  assert.equal(d.querySelector('#confirm-physical-delete').disabled, true);
  assert.match(d.querySelector('#physical-delete-error').textContent, /重新检查/);
});

test('cancelled deletion previews cannot reappear when their response arrives', async t => {
  const { w, d } = await setup(t); let resolve;
  w.api = () => new Promise(done => { resolve = done; });
  const pending = w.openPhysicalDelete('datasets', 'a');
  d.querySelector('#cancel-physical-delete').click(); resolve(impact); await pending;
  assert.equal(w.stateForTest.deletionPreview, null);
  assert.equal(d.querySelector('#physical-delete-impact').textContent, '');
});
