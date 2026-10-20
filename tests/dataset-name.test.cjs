const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  const dataset = { id: 'a', name: '产品凭据', category_path: '示例业务/产品', environments: ['客户A', '测试'], schema_id: 'model', schema_name: '产品模型', fields: [], identity_fields: [], list_fields: [], description: '', record_count: 0 };
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, datasets: [dataset] });
  const calls = [];
  w.api = async (route, options) => {
    if (route === '/catalog') return { schemas: [], environments: [] };
    calls.push({ route, body: options?.body ? JSON.parse(options.body) : null });
    return { dataset_id: 'new', category_path: '示例业务/产品' };
  };
  return { w, d: w.document, dataset, calls };
}

test('basic editor loads and updates a separate name without submitting model fields or changing label selection', async t => {
  const { w, d, dataset, calls } = await setup(t);
  w.openDatasetEdit('a', 'basic'); await tick();
  assert.equal(d.querySelector('#dataset-name').value, '产品凭据');
  assert.equal(d.querySelector('#dataset-category').value, dataset.category_path);
  d.querySelector('#dataset-name').value = '  产品访问配置  ';
  await w.createDataset();
  assert.deepEqual(calls[0], { route: '/datasets/a', body: { name: '产品访问配置', category_path: '示例业务/产品', environment_names: ['客户A', '测试'] } });
  assert.equal(calls[0].body.fields, undefined); assert.equal(calls[0].body.schema_id, undefined);
  w.openDatasetEdit('a', 'basic'); await tick(); d.querySelector('#dataset-name').value = '';
  await w.createDataset(); assert.equal(calls[1].body.name, '');
});

test('new datasets reset the previous name, submit an optional name and validate its length', async t => {
  const { w, d, calls } = await setup(t);
  w.openDatasetEdit('a', 'basic'); await tick();
  d.querySelector('#new-dataset-button').click(); await tick();
  assert.equal(d.querySelector('#dataset-name').value, '');
  d.querySelector('#dataset-category').value = '示例业务/产品';
  d.querySelector('#dataset-category').dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(d.querySelector('#dataset-name').placeholder, '留空时显示“产品”');
  d.querySelector('#dataset-name').value = 'x'.repeat(121); await w.createDataset(); assert.equal(calls.length, 0);
  d.querySelector('#dataset-name').value = '产品实例'; await w.createDataset(); assert.equal(calls[0].body.name, '产品实例');
  assert.equal(calls[0].body.category_path, '示例业务/产品');
});

test('display names appear in management, detail and selectors while directory-based filtering remains intact', async t => {
  const { w, d, dataset } = await setup(t);
  w.renderDatasetManager();
  assert.equal(d.querySelector('.dataset-name-link').textContent, '产品凭据');
  assert.match(d.querySelector('.dataset-directory').textContent, /示例业务\/产品/);
  d.querySelector('#manager-search').value = '凭据'; w.renderDatasetManager();
  assert.equal(d.querySelectorAll('.dataset-manager-row').length, 1);
  w.openManagedDataset('a', 'basic');
  assert.equal(d.querySelector('#dataset-detail-heading h2').textContent, '产品凭据');
  assert.match(d.querySelector('#dataset-detail-body').textContent, /名称产品凭据/);
  w.renderFilters();
  assert.match(d.querySelector('#global-dataset-scope option[value="a"]').textContent, /产品凭据 · 示例业务\/产品/);
  assert.equal(w.datasetName({ category_path: '旧业务/旧目录' }), '旧目录');
  assert.equal(w.datasetLocator({ category_path: '旧业务/旧目录' }), '旧业务/旧目录');
  dataset.name = '<script>bad()</script>';
  w.renderManagedDataset(); assert.equal(d.querySelector('#dataset-detail-heading script'), null);
  await w.sealVault('', false); assert.equal(d.querySelector('#dataset-name').value, '');
});
