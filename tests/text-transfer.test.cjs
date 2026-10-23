const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, datasets: [{ id: 'ds', category_path: '业务/测试', fields: [{ source_key: 'code', zone: 'indexes', display_name: '编号' }], identity_fields: ['code'], list_fields: [] }] });
  return w;
}
function change(w, selector, value) {
  const element = w.document.querySelector(selector);
  if (element.type === 'radio') element.checked = true; else element.value = value;
  element.dispatchEvent(new w.Event('change', { bubbles: true }));
}
function textInput(w, value) {
  const input = w.document.querySelector('#import-text'); input.value = value;
  input.dispatchEvent(new w.Event('input', { bubbles: true }));
}
function openTextImport(w) { w.openImport('ds'); change(w, 'input[name="import-source"][value="text"]'); }
function openTextExport(w) { w.openExport('ds'); change(w, 'input[name="export-destination"][value="text"]'); }

test('pasted text parses into mapping, previews, and commits only after confirmation', async t => {
  const w = await setup(t), requests = []; openTextImport(w);
  textInput(w, '- code: "001"');
  w.fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/templates') ? { templates: [] } : url === '/api/imports/text' ? { batch_id: 'b', format: 'yaml', record_count: 1, source_fields: ['code'] } : { imported: 1 } };
  };
  await w.parseImportText();
  assert.equal(w.stateForTest.importStep, 2);
  assert.equal(w.document.querySelector('#import-text').value, '- code: "001"');
  assert.equal(JSON.parse(requests[0].options.body).format, 'auto');
  assert.equal(w.document.querySelector('#choose-file').hidden, true);
  assert.match(w.document.querySelector('#batch-summary').textContent, /YAML.*1 条/);
  assert.ok(!requests.some(r => r.url === '/api/records/import'));
  await w.commitImport();
  assert.equal(w.stateForTest.importStep, 3);
  assert.equal(w.document.querySelector('#import-text-panel').hidden, true);
  await w.confirmImport();
  assert.equal(requests.filter(r => r.url === '/api/records/import').length, 1);
  assert.equal(w.document.querySelector('#import-text').value, '');
});

test('editing raw text invalidates mapping and preview without discarding the edited text', async t => {
  const w = await setup(t); openTextImport(w); textInput(w, '[{"code":"old"}]');
  w.stateForTest.pendingBatchId = 'old'; w.stateForTest.importPreview = { request: {} }; w.setImportStep(2);
  textInput(w, '[{"code":"new"}]');
  assert.equal(w.stateForTest.pendingBatchId, null);
  assert.equal(w.stateForTest.importPreview, null);
  assert.equal(w.stateForTest.importStep, 1);
  assert.match(w.document.querySelector('#import-text').value, /new/);
  assert.equal(w.hasImportDraft(), true);
});

test('parse errors and size limits retain raw text and do not advance', async t => {
  const w = await setup(t); openTextImport(w); textInput(w, 'bad text');
  w.fetch = async () => ({ ok: false, status: 400, json: async () => ({ error: '请选择格式' }) });
  await w.parseImportText();
  assert.equal(w.document.querySelector('#import-text').value, 'bad text');
  assert.match(w.document.querySelector('#import-text-error').textContent, /请选择格式/);
  assert.equal(w.stateForTest.importStep, 1);
  textInput(w, '中'.repeat(350000));
  assert.equal(w.document.querySelector('#parse-import-text').disabled, true);
  let calls = 0; w.fetch = async () => { calls++; throw Error('unexpected'); };
  await w.parseImportText();
  assert.equal(calls, 0);
  assert.match(w.document.querySelector('#import-text-error').textContent, /1 MiB/);
});

test('native JSON pasted text keeps the exact large integer for later transfer', async t => {
  const w = await setup(t); openTextImport(w);
  const raw = '{"format":"securevault-dataset","version":1,"mode":"package","schema":{"category_path":"demo","fields":[]},"records":[{"source_id":"r","values":{"code":9007199254740993}}]}';
  textInput(w, raw);
  w.fetch = async () => { throw Error('should not upload a native package'); };
  await w.parseImportText();
  assert.equal(w.stateForTest.transferRaw, raw);
  assert.equal(w.stateForTest.importStep, 2);
  assert.equal(w.document.querySelector('#native-import-target').hidden, false);
});

test('late parse responses cannot repopulate a cleared text draft', async t => {
  const w = await setup(t); openTextImport(w); textInput(w, '[{"code":"a"}]');
  let resolve; w.fetch = () => new Promise(r => { resolve = r; });
  const pending = w.parseImportText();
  w.resetImport();
  resolve({ ok: true, json: async () => ({ batch_id: 'old', format: 'json', record_count: 1, source_fields: ['code'] }) });
  await pending;
  assert.equal(w.stateForTest.pendingBatchId, null);
  assert.equal(w.stateForTest.importStep, 1);
  assert.equal(w.document.querySelector('#import-text').value, '');
});

test('text export preserves exact response, copies explicitly, and never downloads', async t => {
  const w = await setup(t); openTextExport(w);
  const raw = '[{"code":9007199254740993,"text":"<script>value</script>"}]';
  let downloaded = false, copied;
  w.saveDownload = async () => { downloaded = true; };
  w.copyText = async text => { copied = text; };
  w.fetch = async () => ({ ok: true, text: async () => raw });
  await w.downloadExport();
  assert.equal(w.document.querySelector('#export-text').value, raw);
  assert.equal(w.document.querySelector('#export-modal').open, true);
  assert.equal(downloaded, false); assert.equal(copied, undefined);
  await w.copyExportText(); assert.equal(copied, raw);
  assert.match(w.document.querySelector('#export-copy-status').textContent, /已复制/);
  change(w, '#export-format', 'yaml');
  assert.equal(w.document.querySelector('#export-text').value, '');
  assert.equal(w.document.querySelector('#export-text-result').hidden, true);
});

test('text output excludes XLSX and supports native JSON packages', async t => {
  const w = await setup(t); w.openExport('ds'); change(w, '#export-format', 'xlsx');
  change(w, 'input[name="export-destination"][value="text"]');
  assert.equal(w.document.querySelector('#export-format').value, 'json');
  assert.equal(w.document.querySelector('#export-format option[value="xlsx"]').disabled, true);
  change(w, 'input[name="export-content"][value="package"]');
  let url; w.fetch = async value => { url = value; return { ok: true, text: async () => '{"format":"securevault-dataset"}' }; };
  await w.downloadExport();
  assert.match(url, /content=package/);
  assert.match(w.document.querySelector('#export-text').value, /securevault-dataset/);
  w.document.querySelector('#export-modal').close();
  assert.equal(w.document.querySelector('#export-text').value, '');
});

test('clipboard failure selects the entire result for manual copying', async t => {
  const w = await setup(t); openTextExport(w);
  w.fetch = async () => ({ ok: true, text: async () => 'abc\ndef' });
  await w.downloadExport();
  w.copyText = async () => { throw Error('denied'); }; await w.copyExportText();
  const input = w.document.querySelector('#export-text');
  assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, 7);
  assert.match(w.document.querySelector('#export-copy-status').textContent, /手动复制/);
});

test('late export response cannot populate a reopened dialog for the same dataset', async t => {
  const w = await setup(t); openTextExport(w);
  let resolve, signal; w.fetch = (_, options) => { signal = options.signal; return new Promise(r => { resolve = r; }); };
  const pending = w.downloadExport();
  w.document.querySelector('#export-modal').close(); openTextExport(w);
  assert.equal(signal.aborted, true);
  resolve({ ok: true, text: async () => 'stale secret' }); await pending;
  assert.equal(w.document.querySelector('#export-text').value, '');
  assert.equal(w.stateForTest.exportBusy, false);
});

test('oversize text export reports a limit without a partial result or download', async t => {
  const w = await setup(t); openTextExport(w);
  w.fetch = async () => ({ ok: true, text: async () => 'x'.repeat(2 * 1024 * 1024 + 1) });
  w.saveDownload = async () => { throw Error('must not download'); };
  await w.downloadExport();
  assert.match(w.document.querySelector('#export-error').textContent, /2 MiB/);
  assert.equal(w.document.querySelector('#export-text').value, '');
  assert.equal(w.document.querySelector('#export-text-result').hidden, true);
});

test('sealing clears both text areas and invalidates pending output', async t => {
  const w = await setup(t); openTextImport(w); textInput(w, 'private input'); openTextExport(w);
  w.document.querySelector('#export-text').value = 'private output';
  w.fetch = async () => ({ ok: true, json: async () => ({}) });
  await w.sealVault('locked', false);
  assert.equal(w.document.querySelector('#import-text').value, '');
  assert.equal(w.document.querySelector('#export-text').value, '');
});

test('changing target keeps pasted source and format but invalidates the old batch', async t => {
  const w = await setup(t); openTextImport(w); textInput(w, '- code: "001"');
  change(w, '#import-text-format', 'yaml');
  w.stateForTest.pendingBatchId = 'old'; w.stateForTest.importPreview = { request: {} };
  w.confirm = () => true;
  change(w, '#import-dataset-select', 'ds');
  assert.equal(w.document.querySelector('#import-text').value, '- code: "001"');
  assert.equal(w.document.querySelector('#import-text-format').value, 'yaml');
  assert.equal(w.stateForTest.pendingBatchId, null);
  assert.equal(w.stateForTest.importPreview, null);
});

test('native packages with a UTF-8 BOM follow native transfer for files and pasted text', async t => {
  const w = await setup(t);
  const raw = '{"format":"securevault-dataset","version":1,"mode":"package","schema":{"category_path":"demo","fields":[]},"records":[{"source_id":"r","values":{"code":9007199254740993}}]}';
  for (const source of ['file', 'text']) {
    w.fetch = async url => { assert.ok(!url.startsWith('/api/imports/')); return { ok: true, json: async () => ({ schemas: [], datasets: [] }) }; };
    w.resetImport(); w.openImport('ds');
    if (source === 'file') await w.importFile({ name: 'native.JSON', text: async () => '\uFEFF' + raw });
    else { change(w, 'input[name="import-source"][value="text"]'); textInput(w, '\uFEFF' + raw); await w.parseImportText(); }
    assert.equal(w.stateForTest.transferRaw, raw);
    assert.equal(w.stateForTest.importStep, 2);
    assert.equal(w.stateForTest.pendingBatchId, null);
  }
});

test('file template failures do not leave a usable batch or advance to mapping', async t => {
  const w = await setup(t); w.openImport('ds');
  w.fetch = async url => url === '/api/imports/upload'
    ? { ok: true, json: async () => ({ batch_id: 'batch', filename: 'records.yaml', record_count: 1, source_fields: ['code'] }) }
    : { ok: false, status: 500, json: async () => ({ error: 'templates unavailable' }) };
  await w.importFile(new w.File(['- code: 1'], 'records.yaml'));
  assert.equal(w.stateForTest.pendingBatchId, null);
  assert.equal(w.stateForTest.importStep, 1);
  assert.equal(w.document.querySelector('#batch-options').hidden, true);
});

test('non-JSON HTTP errors have a useful message and expired export sessions clear text', async t => {
  const w = await setup(t); openTextExport(w);
  w.fetch = async () => ({ ok: false, status: 413, json: async () => { throw Error('not JSON'); } });
  await w.downloadExport();
  assert.match(w.document.querySelector('#export-error').textContent, /大小限制/);
  w.fetch = async () => ({ ok: false, status: 423, json: async () => ({ error: 'locked' }) });
  await w.downloadExport();
  assert.equal(w.stateForTest.unlocked, false);
  assert.equal(w.document.querySelector('#export-text').value, '');
});

test('an old file response cannot seal a newer session', async t => {
  const w = await setup(t); w.openImport('ds');
  let resolve; w.fetch = () => new Promise(r => { resolve = r; });
  const pending = w.importFile(new w.File(['x'], 'records.yaml'));
  w.stateForTest.sessionEpoch++; w.resetImport();
  resolve({ ok: false, status: 401, json: async () => ({ error: 'expired old session' }) });
  await pending;
  assert.equal(w.stateForTest.unlocked, true);
  assert.equal(w.stateForTest.pendingBatchId, null);
});

test('streamed text export bounds memory, preserves split Unicode and cancels oversize responses', async t => {
  const w = await setup(t); w.TextDecoder = TextDecoder;
  const bytes = new TextEncoder().encode('中文😀\n9007199254740993');
  let cancelled = false, released = false;
  const response = chunks => ({ body: { getReader: () => ({
    read: async () => chunks.length ? { done: false, value: chunks.shift() } : { done: true },
    cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; }
  }) } });
  assert.equal(await w.readExportText(response([bytes.slice(0, 1), bytes.slice(1, 7), bytes.slice(7)]), () => true), '中文😀\n9007199254740993');
  assert.equal(cancelled, false); assert.equal(released, true);
  const chunks = [new Uint8Array(1024 * 1024), new Uint8Array(1024 * 1024 + 1), new Uint8Array(100)];
  await assert.rejects(w.readExportText(response(chunks), () => true), /2 MiB/);
  assert.equal(cancelled, true); assert.equal(chunks.length, 1);
});

test('text node paths survive edits, are submitted, and never reuse an old preview', async t => {
  const w = await setup(t); openTextImport(w);
  textInput(w, '[[private_key.keys]]\ncode="001"');
  const path = w.document.querySelector('#import-node-path'); path.value = 'private_key.keys';
  const requests = [];
  w.fetch = async (url, options) => { if (url === '/api/imports/text') requests.push(JSON.parse(options.body)); return { ok: true, json: async () => url === '/api/imports/text' ? { batch_id: 'b', format: 'toml', record_count: 1, source_fields: ['code'] } : { templates: [] } }; };
  await w.parseImportText(); assert.equal(requests[0].node_path, 'private_key.keys');
  path.value = 'private_key.keys.0'; path.dispatchEvent(new w.Event('input', { bubbles: true }));
  assert.equal(w.stateForTest.pendingBatchId, null); assert.equal(w.stateForTest.importPreview, null);
  await w.parseImportText(); assert.equal(requests[1].node_path, 'private_key.keys.0');
  w.resetImport(); assert.equal(path.value, '');
});
