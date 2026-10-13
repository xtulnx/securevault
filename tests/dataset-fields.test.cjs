const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

const dataset = (id, environment = 'prod') => ({ id, environment, category_path: '业务/产品', description: `## ${id} 说明`, fields: [], identity_fields: [], list_fields: [], record_count: 0, conflict_strategy: 'allow_mark' });

test('description textarea follows light and dark themes', async (t) => {
  const window = page(t, true);
  await window.initialStatusCheck;
  const textarea = window.document.querySelector('#dataset-description');
  window.applyTheme('light');
  assert.equal(window.getComputedStyle(textarea).backgroundColor, 'rgb(248, 251, 251)');
  window.applyTheme('dark');
  assert.equal(window.getComputedStyle(textarea).backgroundColor, 'rgba(5, 18, 28, 0.62)');
});

test('search has dataset-specific view, edit and import icons and limits management to owners', async (t) => {
  const window = page(t, true);
  await window.initialStatusCheck;
  const state = window.stateForTest;
  state.unlocked = true; state.canManage = true;
  state.datasets = [dataset('ds_product')]; state.category = '业务/产品';
  window.renderDatasetActions();
  const container = window.document.querySelector('#dataset-context-actions');
  assert.equal(container.hidden, false);
  assert.equal(container.querySelectorAll('button svg').length, 5);
  container.querySelector('[data-action="view"]').click();
  assert.equal(window.document.querySelector('#dataset-info-content h2').textContent, 'ds_product 说明');
  container.querySelector('[data-action="edit"]').click();
  assert.equal(state.editDatasetId, 'ds_product');
  assert.equal(state.editorReturn, 'search');
  window.document.querySelector('#cancel-dataset').click();
  container.querySelector('[data-action="import"]').click();
  assert.equal(window.document.querySelector('#import-dataset-select').value, 'ds_product');
  assert.equal(state.importReturn, 'search');
  state.canManage = false;
  window.renderDatasetActions();
  assert.ok(container.querySelector('[data-action="view"]'));
  assert.equal(container.querySelector('[data-action="edit"], [data-action="import"]'), null);
  state.category = 'all';
  window.renderDatasetActions();
  assert.equal(container.hidden, true);
  assert.equal(window.getComputedStyle(container).display, 'none');
});

test('multiple datasets sharing a directory require explicit selection and search by that ID', async (t) => {
  const window = page(t, true);
  await window.initialStatusCheck;
  const state = window.stateForTest;
  state.unlocked = true; state.canManage = true;
  state.datasets = [dataset('ds_prod'), dataset('ds_stage', 'staging')]; state.category = '业务/产品';
  window.renderDatasetActions();
  const container = window.document.querySelector('#dataset-context-actions');
  assert.equal(container.querySelector('[data-action="view"]'), null);
  const requests = [];
  window.fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => ({ records: [], total: 0, page: 1 }) };
  };
  const select = container.querySelector('select');
  select.value = 'ds_stage';
  select.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  assert.equal(new URL(requests[0], window.location.href).searchParams.get('dataset_id'), 'ds_stage');
  container.querySelector('[data-action="import"]').click();
  assert.equal(window.document.querySelector('#import-dataset-select').value, 'ds_stage');
  state.selectedDatasetId = null; state.environment = 'prod';
  window.renderDatasetActions();
  assert.equal(window.currentDataset().id, 'ds_prod');
  state.category = '业务';
  window.renderDatasetActions();
  assert.equal(window.currentDataset().id, 'ds_prod');
  assert.ok(container.querySelector('[data-action="view"]'));
  assert.equal(container.querySelector('select'), null);
});

test('ordinary and ignored schema zones stay out of list configuration and ignore cannot be a KEY', async (t) => {
  const window = page(t, true);
  await window.initialStatusCheck;
  const fields = [{ source_key: 'id', zone: 'indexes', unique: true }, { source_key: 'notes', zone: 'normal' }, { source_key: 'unused', zone: 'ignore', unique: false }];
  window.renderSchemaFields(fields);
  window.renderListConfig(fields);
  const document = window.document;
  assert.equal(document.querySelectorAll('#list-config-fields .list-config-row').length, 1);
  const rows = document.querySelectorAll('#schema-fields .schema-field');
  assert.equal(rows[1].querySelector('.schema-field-zone').value, 'normal');
  assert.equal(rows[2].querySelector('.schema-field-unique').disabled, true);
  const zone = rows[0].querySelector('.schema-field-zone');
  zone.value = 'ignore'; zone.dispatchEvent(new window.Event('change'));
  assert.equal(rows[0].querySelector('.schema-field-unique').checked, false);
  assert.equal(rows[0].querySelector('.schema-field-unique').disabled, true);
  assert.equal(window.readListConfig().length, 0);
  window.renderMappings(['notes', 'unused'], fields, true);
  assert.equal(document.querySelector('[data-map-source="unused"]').value, 'unused');
  assert.match(document.querySelector('[data-map-source="unused"] option:checked').textContent, /忽略，不保存/);
});

test('record details display ordinary fields in their own section', async (t) => {
  const window = page(t, true);
  await window.initialStatusCheck;
  const state = window.stateForTest;
  state.unlocked = true;
  state.datasets = [{ ...dataset('ds_product'), fields: [{ source_key: 'notes', display_name: '说明', zone: 'normal' }] }];
  window.fetch = async () => ({ ok: true, json: async () => ({ dataset_id: 'ds_product', category: '业务/产品', indexes: {}, display: {}, normal: { notes: '只在详情展示的普通内容' }, protected_fields: [] }) });
  await window.openRecordDetail('rec_test');
  const section = [...window.document.querySelectorAll('#record-detail-content .detail-section')].find((element) => element.querySelector('h4').textContent === '普通字段');
  assert.match(section.textContent, /说明/);
  assert.match(section.textContent, /只在详情展示的普通内容/);
});
