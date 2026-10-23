const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

async function setup(t) {
  const w = page(t, true);
  await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, datasets: [{
    id: 'ds', category_path: '业务/测试', environment: null, record_count: 1,
    fields: [{ source_key: 'code', display_name: '编号', zone: 'indexes', position: 0 }],
    identity_fields: ['code'], list_fields: [], display_config: {}
  }] });
  return w;
}

for (const format of ['jsonl', 'yaml', 'yml', 'toml']) {
  test(`${format} import uploads through the ordinary mapping and preview workflow`, async t => {
    const w = await setup(t), requests = [];
    w.openImport('ds');
    assert.ok(w.document.querySelector('#import-file').accept.split(',').includes(`.${format}`));
    w.fetch = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => url === '/api/imports/upload'
        ? { batch_id: 'batch', filename: `records.${format}`, record_count: 1, source_fields: ['code'] }
        : { templates: [] } };
    };
    await w.importFile(new w.File(['code'], `records.${format}`));
    assert.equal(requests[0].url, '/api/imports/upload');
    assert.equal(requests[0].options.body.get('file').name, `records.${format}`);
    assert.equal(w.stateForTest.importStep, 2);
    assert.equal(w.stateForTest.pendingBatchId, 'batch');
    assert.equal(w.stateForTest.transferPackage, null);
    assert.equal(w.document.querySelector('[data-map-source="code"]').value, 'code');
    assert.ok(!requests.some(r => r.url === '/api/records/import'));
  });

  test(`${format} export passes the selected format and saves the matching extension`, async t => {
    const w = await setup(t), saved = [], requests = [];
    w.openExport('ds');
    const select = w.document.querySelector('#export-format');
    select.value = format;
    assert.equal(select.value, format);
    w.saveDownload = async (blob, filename) => { saved.push(filename); return true; };
    w.fetch = async url => { requests.push(new URL(url, w.location.href)); return { ok: true, blob: async () => new w.Blob(['data']) }; };
    await w.downloadExport();
    assert.equal(requests[0].searchParams.get('format'), format);
    assert.equal(requests[0].searchParams.get('content'), 'data');
    assert.equal(requests[0].searchParams.get('include_secrets'), 'false');
    assert.deepEqual(saved, [`securevault-ds.${format}`]);
    w.openExport('ds');
    select.value = format;
    w.document.querySelector('input[name="export-content"][value="schema"]').checked = true;
    w.updateExportOptions();
    assert.equal(select.disabled, true);
    assert.equal(select.value, 'json');
  });
}

test('TOML export incompatibility remains visible and allows choosing another format', async t => {
  const w = await setup(t);
  w.openExport('ds');
  w.document.querySelector('#export-format').value = 'toml';
  w.fetch = async () => ({ ok: false, json: async () => ({ error: 'TOML 无法表示 null，请选择 JSON、JSONL 或 YAML 导出' }) });
  await w.downloadExport();
  assert.equal(w.document.querySelector('#export-modal').open, true);
  assert.equal(w.document.querySelector('#export-error').hidden, false);
  assert.match(w.document.querySelector('#export-error').textContent, /null/);
  assert.equal(w.document.querySelector('#confirm-export').disabled, false);
  assert.equal(w.stateForTest.exportBusy, false);
});

test('nested record selection is sent for files and changing it invalidates the old batch', async t => {
  const w = await setup(t); w.openImport('ds');
  const path = w.document.querySelector('#import-node-path'); path.value = 'private_key.keys';
  const sent = [];
  w.fetch = async (url, options) => { if (url === '/api/imports/upload') sent.push(options.body); return { ok: true, json: async () => url === '/api/imports/upload' ? { batch_id: 'b', filename: 'keys.toml', record_count: 2, source_fields: ['code'], node_path: 'private_key.keys' } : { templates: [] } }; };
  const file = new w.File(['[[private_key.keys]]\ncode="001"'], 'keys.toml');
  await w.importFile(file);
  assert.equal(sent[0].get('node_path'), 'private_key.keys');
  assert.match(w.document.querySelector('#batch-summary').textContent, /节点：private_key.keys/);
  path.value = 'private_key.other'; path.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(w.stateForTest.pendingBatchId, null); assert.equal(w.stateForTest.importStep, 1);
  assert.equal(w.stateForTest.importSourceFile, file);
  await w.importFile(file, true); assert.equal(sent[1].get('node_path'), 'private_key.other');
  await w.sealVault('locked', false); assert.equal(w.stateForTest.importSourceFile, null); assert.equal(path.value, '');
});

test('multi-sheet upload requires selection before mapping and reuploads the selected sheet', async t => {
  const w = await setup(t); w.openImport('ds');
  const sheets = ['说明', '数据 & <2>']; const requests = [];
  w.fetch = async (url, options) => {
    if (url === '/api/imports/upload') requests.push(options.body);
    const sheet = options?.body?.get?.('sheet');
    return { ok: true, json: async () => url === '/api/imports/upload' ? sheet ? { batch_id: 'b', filename: 'multi.xlsx', record_count: 1, source_fields: ['code'], sheets, sheet } : { selection_required: true, sheets, filename: 'multi.xlsx' } : { templates: [] } };
  };
  const file = new w.File(['xlsx'], 'multi.xlsx'); await w.importFile(file);
  assert.equal(w.stateForTest.pendingBatchId, null); assert.equal(w.stateForTest.importStep, 1);
  assert.equal(w.document.querySelector('#import-sheet-wrap').hidden, false);
  assert.equal(w.document.querySelector('#reparse-import-file').disabled, true);
  const sheet = w.document.querySelector('#import-sheet'); sheet.value = sheets[1]; sheet.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.document.querySelector('#reparse-import-file').disabled, false);
  await w.importFile(file, true);
  assert.equal(requests[1].get('sheet'), sheets[1]); assert.equal(requests[1].get('node_path'), null);
  assert.equal(w.stateForTest.importStep, 2); assert.match(w.document.querySelector('#batch-summary').textContent, /工作表：数据 & <2>/);
  sheet.value = sheets[0]; sheet.dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(w.stateForTest.pendingBatchId, null); assert.equal(w.stateForTest.importStep, 1);
});
