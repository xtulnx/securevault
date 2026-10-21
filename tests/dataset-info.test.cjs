const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, canManage: false, datasets: [{
    id: 'a', name: '当前账户', category_path: '业务/账户', environments: ['生产'], record_count: 7,
    description: '## 数据集说明', schema_name: '共享账户模型', schema_id: 'model', schema_version: 99,
    schema_description: '## 模型说明\n\n```sql\nSELECT code FROM accounts;\n```',
    fields: [{ source_key: 'code', zone: 'indexes', position: 1 }, { source_key: 'name', zone: 'display', position: 0 }, { source_key: 'secret', zone: 'secrets', position: 2 }],
    identity_fields: ['code'], list_fields: [{ source_key: 'secret', visible: true }, { source_key: 'code', visible: true, format: 'multiline' }],
    display_config: { identifier_fields: ['code'], density: 'full' },
    supplement_fields: [{ source_key: 'memo', display_name: '备注', zone: 'normal' }]
  }] });
  w.api = async () => { throw new Error('This read-only view must not request the management catalog'); };
  w.openDatasetInfo('a'); return w;
}
test('dataset information separates instance metadata and model definition without exposing versions or editing controls', async t => {
  const w = await setup(t), d = w.document;
  const instance = d.querySelector('.dataset-instance-info'), model = d.querySelector('.dataset-model-info');
  assert.deepEqual([...instance.querySelectorAll('dt')].map(x => x.textContent), ['目录路径', '标签', '记录数量', '重复处理']);
  assert.equal(d.querySelector('#dataset-info-title').textContent, '当前账户');
  assert.equal(d.querySelector('#dataset-instance-title'), null);
  assert.equal(instance.querySelector('.dimension-badge').getAttribute('aria-label'), '标签：生产');
  assert.equal(d.querySelector('#dataset-model-title').textContent, '数据模型：共享账户模型');
  assert.doesNotMatch(model.textContent, /统一管理|模型名称|主表字段数量|附表字段数量/);
  assert.deepEqual([...model.querySelectorAll('.dataset-info-summary dt')].map(x => x.textContent), ['逻辑唯一 KEY']);
  assert.equal(d.querySelector('#dataset-info-model-tabs, .info-tab-count, #dataset-info-content [role="tab"]'), null);
  assert.doesNotMatch(instance.textContent, /当前账户/); assert.doesNotMatch(instance.textContent, /逻辑唯一|字段定义|共享账户模型/);
  assert.match(model.textContent, /共享账户模型/); assert.match(model.textContent, /逻辑唯一 KEY/);
  assert.equal(d.querySelector('.dataset-description-section h2').textContent, '数据集说明');
  assert.equal(d.querySelector('.dataset-model-description pre code').textContent, 'SELECT code FROM accounts;\n');
  assert.equal(model.querySelector('.dataset-model-fields tbody tr code').textContent, 'name');
  assert.equal(d.querySelector('.dataset-model-description').previousElementSibling.id, 'dataset-info-model-content');
  assert.equal(model.querySelector('[data-action="edit"]'), null);
  assert.doesNotMatch(model.textContent, /版本|99/);
});
test('main and supplementary definitions share one view with ordinals and complete display rules', async t => {
  const w = await setup(t), d = w.document;
  const sections = d.querySelectorAll('.dataset-model-fields');
  assert.equal(sections.length, 2);
  assert.equal(sections[0].getAttribute('aria-label'), '主表字段');
  assert.equal(sections[1].getAttribute('aria-label'), '附表字段');
  const rows = [...sections[0].querySelectorAll('tbody tr')];
  assert.deepEqual(rows.map(row => row.cells[0].textContent), ['1', '2', '3']);
  assert.deepEqual(rows.map(row => row.cells[1].textContent), ['name', 'code', 'secret']);
  assert.equal(rows[1].cells[4].textContent, '是');
  assert.equal(rows[1].cells[5].textContent, '多行');
  assert.equal(rows[1].cells[5].title, '检索列表第 1 项，多行');
  assert.equal(rows[1].cells[5].getAttribute('aria-label'), '检索列表第 1 项，多行');
  assert.equal(rows[2].cells[5].textContent, '—');
  assert.equal(rows[2].cells[5].getAttribute('aria-label'), '不展示');
  assert.match(sections[0].querySelector('.dataset-field-heading').textContent, /默认完整 · 记录标识：code/);
  assert.equal(sections[1].querySelector('tbody tr').cells[0].textContent, '1');
  assert.equal(sections[1].querySelector('tbody tr').cells[1].textContent, 'memo');
  assert.equal(sections[1].querySelectorAll('th').length, 4);
  assert.equal(sections[0].querySelector('.dataset-info-table-wrap').getAttribute('tabindex'), '0');
});
test('empty descriptions are omitted and legacy models retain visible field defaults and empty supplementary state', async t => {
  const w = await setup(t), ds = w.stateForTest.datasets[0], d = w.document;
  Object.assign(ds, { description: ' \n ', schema_description: '', schema_id: null, schema_name: null, list_fields: [], supplement_fields: [] });
  w.openDatasetInfo('a');
  assert.equal(d.querySelector('.dataset-description-section, .dataset-model-description'), null);
  assert.match(d.querySelector('.dataset-model-info').textContent, /独立模型/);
  const mainRows = d.querySelectorAll('.dataset-model-fields:first-child tbody tr');
  assert.equal(mainRows.length, 3);
  assert.equal(mainRows[0].cells[5].textContent, '单行');
  assert.equal(mainRows[0].cells[5].title, '检索列表第 1 项，单行');
  assert.equal(mainRows[1].cells[5].textContent, '单行');
  assert.equal(mainRows[1].cells[5].title, '检索列表第 2 项，单行');
  assert.equal(mainRows[2].cells[5].textContent, '—');
  assert.match(d.querySelector('.dataset-model-fields:last-child').textContent, /尚未定义附表字段/);
  ds.schema_description = '<img src="x" onerror="alert(1)">\n\n[unsafe](javascript:alert(1))';
  w.openDatasetInfo('a');
  assert.equal(d.querySelector('.dataset-model-description img, .dataset-model-description [onerror], .dataset-model-description a[href^="javascript:"]'), null);
});
