const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

const dataset = { id: 'ds', category_path: '业务/产品', environment: '正式', fields: [
  { source_key: 'code', display_name: '编号', zone: 'indexes', position: 0 },
], identity_fields: ['code'], list_fields: [], display_config: {}, supplement_fields: [] };
const detail = id => ({ id, dataset_id: 'ds', category: dataset.category_path, environment: '正式',
  indexes: { code: id }, display: {}, normal: {}, protected_fields: [], supplement_records: [], supplement_fields: [] });
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const tick = () => new Promise(resolve => setImmediate(resolve));

function workspaceResponse(url) {
  if (url === '/api/datasets') return { datasets: [dataset] };
  if (url === '/api/datasets/tree') return { directories: [] };
  if (url === '/api/vault/summary') return { records: 0, datasets: 1, protected_fields: 0 };
  if (url.startsWith('/api/records/search')) return { records: [], total: 0, page: 1, limit: 40 };
  return detail(url.split('/').at(-1));
}

test('a record link waits for unlock, then opens a record outside the current search page', async t => {
  const w = page(t, true, 'http://127.0.0.1:4180/#record=rec-a');
  await w.initialStatusCheck;
  const requests = [];
  w.fetch = async (url, options) => {
    requests.push({ url, options });
    return response(workspaceResponse(url));
  };
  await w.openLinkedRecord();
  assert.equal(requests.length, 0);
  assert.equal(w.location.hash, '#record=rec-a');
  w.document.querySelector('#master-password').value = 'test-password-123';
  await w.unlockVault({ preventDefault() {} });
  assert.equal(w.stateForTest.recordDetail.id, 'rec-a');
  assert.equal(w.stateForTest.records.length, 0);
  assert.equal(w.document.querySelector('#record-detail-modal').hidden, false);
  assert.equal(w.document.querySelector('#record-detail-title').textContent, '编号：rec-a');
  assert.equal(w.location.hash, '');
  assert.equal(requests.filter(request => request.url === '/api/records/rec-a').length, 1);
  assert.ok(!requests.some(request => request.url.includes('secrets/reveal')));
});

test('an existing owner session opens the linked record after loading its workspace', async t => {
  const w = page(t, true, 'http://127.0.0.1:4180/#record=rec-b');
  await w.initialStatusCheck;
  w.fetch = async url => response(url === '/api/vault/status'
    ? { initialized: true, sealed: false, can_manage: true, persistent: false }
    : workspaceResponse(url));
  await w.checkStatus();
  assert.equal(w.stateForTest.recordDetail.id, 'rec-b');
  assert.equal(w.location.hash, '');
});

test('malformed and missing record links cannot open arbitrary paths or leave old detail visible', async t => {
  const w = page(t, true);
  await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, datasets: [dataset] });
  const requests = [];
  w.fetch = async url => { requests.push(url); return response({ error: 'record not found' }, 404); };
  w.history.replaceState(null, '', '#record=..%2Fapps');
  await w.openLinkedRecord();
  assert.equal(requests.length, 0);
  assert.equal(w.location.hash, '');
  w.history.replaceState(null, '', '#record=rec-missing');
  await w.openLinkedRecord();
  assert.deepEqual(requests, ['/api/records/rec-missing']);
  assert.equal(w.stateForTest.recordDetail, null);
  assert.equal(w.document.querySelector('#record-detail-modal').hidden, true);
  assert.equal(w.location.hash, '');
});

test('a newer record link wins over a delayed previous request', async t => {
  const w = page(t, true);
  await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, datasets: [dataset] });
  let finishOld;
  w.fetch = url => url.endsWith('/rec-old')
    ? new Promise(resolve => { finishOld = resolve; })
    : Promise.resolve(response(detail('rec-new')));
  w.history.replaceState(null, '', '#record=rec-old');
  const pending = w.openLinkedRecord();
  const oldURL = w.location.href;
  w.history.replaceState(null, '', '#record=rec-new');
  w.dispatchEvent(new w.HashChangeEvent('hashchange', { oldURL, newURL: w.location.href }));
  await tick();
  assert.equal(w.stateForTest.recordDetail.id, 'rec-new');
  finishOld(response(detail('rec-old')));
  await pending;
  assert.equal(w.stateForTest.recordDetail.id, 'rec-new');
  assert.equal(w.location.hash, '');
});

test('a record link respects the existing unsaved-editor cancellation', async t => {
  const w = page(t, true);
  await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, datasets: [dataset], workspace: 'editor', editorDirty: true });
  let requests = 0;
  w.fetch = async () => { requests++; return response(detail('rec-a')); };
  w.confirm = () => false;
  w.history.replaceState(null, '', '#record=rec-a');
  await w.openLinkedRecord();
  assert.equal(requests, 0);
  assert.equal(w.stateForTest.workspace, 'editor');
  assert.equal(w.stateForTest.editorDirty, true);
  assert.equal(w.location.hash, '#record=rec-a');
});
