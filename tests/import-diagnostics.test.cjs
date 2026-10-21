const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const w = page(t, true); await w.initialStatusCheck;
  const d = w.document, state = w.stateForTest;
  const fields = [{ source_key: 'code', zone: 'indexes' }, { source_key: 'payload', zone: 'normal' }];
  Object.assign(state, { unlocked: true, canManage: true, datasets: [{ id: 'a', name: '回归', category_path: '导入/回归', fields, identity_fields: ['code'], environments: [] }] });
  const originalApi = w.api;
  w.api = async () => ({}); w.openImport('a'); await tick();
  state.pendingBatchId = 'batch'; w.renderMappings(['code', 'payload'], fields); w.setImportStep(2);
  const row = d.querySelector('[data-map-source="payload"]').closest('.mapping-row');
  row.querySelector('[data-map-path]').value = 'items.0.id'; row.querySelector('details').open = true;
  return { w, d, state, row, originalApi };
}
const sample = (reveal = false) => ({ record_count: 4, rows: [{ row: 1, message: '抽取成功', before: { present: true, masked: !reveal, type: 'string', text: reveal ? '<script>SYNTHETIC</script>' : undefined }, after: { present: true, masked: !reveal, type: 'boolean', text: reveal ? 'false' : undefined } }] });
const report = (n = 1) => ({ checked_rows: 30, error_count: n, warning_count: 0, issue_limit: 10000, truncated: false, issues: Array.from({ length: n }, (_, i) => ({ scope: 'records', row: i + 1, severity: 'error', source_key: 'payload', target_key: 'payload', json_path: 'items.0.id', code: 'invalid_json', message: '<script>不是有效 JSON</script>' })) });

test('samples start masked, reveal only on explicit action, preserve falsy text and auto-hide', async t => {
  const { w, d, row } = await setup(t); const calls = [];
  let expire; const original = w.setTimeout;
  w.setTimeout = (callback, delay) => delay === 30000 ? (expire = callback, 1) : original(callback, delay);
  w.api = async (route, options) => { const request = JSON.parse(options.body); calls.push({ route, request }); return sample(request.reveal); };
  await w.previewMappingSample(row);
  assert.equal(calls[0].request.reveal, false); assert.equal(calls[0].request.json_path, 'items.0.id');
  assert.ok(!row.textContent.includes('SYNTHETIC')); assert.match(row.textContent, /••••/);
  [...row.querySelectorAll('button')].find(button => button.textContent.includes('查看样例值')).click(); await tick();
  assert.equal(calls[1].request.reveal, true); assert.match(row.textContent, /抽取后：false/);
  assert.match(row.textContent, /<script>SYNTHETIC<\/script>/); assert.equal(row.querySelector('script'), null);
  expire(); assert.ok(!row.textContent.includes('SYNTHETIC')); assert.match(row.textContent, /自动隐藏/);
  assert.equal(d.querySelector('[data-preview-sample]').disabled, false);
});

test('path edits, template rerenders and sealing discard late sample responses and clear raw values', async t => {
  const { w, d, state, row } = await setup(t); let resolve;
  w.api = async () => new Promise(done => { resolve = done; });
  const pending = w.previewMappingSample(row, true);
  row.querySelector('input[data-map-path]').dispatchEvent(new w.Event('input', { bubbles: true }));
  resolve(sample(true)); await pending; assert.ok(!row.textContent.includes('SYNTHETIC'));
  w.api = async () => sample(true); await w.previewMappingSample(row, true); assert.match(row.textContent, /SYNTHETIC/);
  w.renderMappings(['code'], state.datasets[0].fields); assert.ok(!d.querySelector('#mapping-list').textContent.includes('SYNTHETIC'));
  const nextRow = d.querySelector('.mapping-row');
  w.api = async () => new Promise(done => { resolve = done; });
  const delayed = w.previewMappingSample(nextRow, true); await w.sealVault('', false); resolve(sample(true)); await delayed;
  assert.equal(d.querySelector('#mapping-list').textContent, ''); assert.equal(state.importSampleTimer, null);
});

test('all row errors block confirmation, paginate safely and locate folded mapping fields', async t => {
  const { w, d, state, row } = await setup(t); const calls = [];
  w.api = async route => { calls.push(route); return { valid: false, diagnostics: report(25) }; };
  await w.commitImport();
  assert.equal(state.importStep, 2); assert.equal(state.importPreview, null); assert.equal(state.importBusy, false);
  assert.match(d.querySelector('#import-diagnostics').textContent, /25 项错误/);
  assert.equal(d.querySelectorAll('.import-issue').length, 20); assert.equal(d.querySelector('#import-diagnostics script'), null);
  [...d.querySelectorAll('#import-diagnostics button')].find(button => button.textContent === '下一页').click();
  assert.equal(d.querySelectorAll('.import-issue').length, 5);
  row.hidden = true; row.querySelector('details').open = false;
  d.querySelector('.import-issue button').click();
  assert.equal(row.hidden, false); assert.equal(row.querySelector('details').open, true);
  assert.equal(d.activeElement, row.querySelector('[data-map-path]'));
  await w.confirmImport(); assert.equal(calls.length, 1);
  d.querySelector('#skip-existing').dispatchEvent(new w.Event('change', { bubbles: true }));
  assert.equal(d.querySelector('#import-diagnostics').hidden, true); assert.equal(state.importDiagnostics, null);
});

test('warnings stay visible on confirmation and returning to locate a field invalidates the pending preview', async t => {
  const { w, d, state } = await setup(t); const diagnostics = report(); diagnostics.error_count = 0; diagnostics.warning_count = 1; diagnostics.issues[0].severity = 'warning';
  w.api = async () => ({ valid: true, imported: 1, diagnostics }); await w.commitImport();
  assert.equal(state.importStep, 3); assert.match(d.querySelector('#import-diagnostics').textContent, /1 项提醒/);
  d.querySelector('.import-issue button').click(); assert.equal(state.importStep, 2); assert.equal(state.importPreview, null);
});

test('CSV download uses the checked configuration and revokes the temporary URL; errors are retryable', async t => {
  const { w, d, state } = await setup(t); const calls = [], urls = [], downloads = [];
  const request = w.buildImportRequest();
  w.URL.createObjectURL = blob => { assert.equal(blob.size, 3); return 'blob:report'; };
  w.URL.revokeObjectURL = url => urls.push(url);
  w.HTMLAnchorElement.prototype.click = function() { downloads.push(this.download); };
  w.renderImportDiagnostics(report(), request, false);
  w.api = async (route, options) => { calls.push({ route, options }); return new w.Blob(['csv']); };
  d.querySelector('#import-diagnostics > button').click(); await tick(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(calls[0].route, '/records/import/report?format=csv'); assert.equal(calls[0].options.responseType, 'blob');
  assert.deepEqual(JSON.parse(calls[0].options.body), JSON.parse(JSON.stringify(request)));
  assert.deepEqual(downloads, ['securevault-import-report.csv']); assert.deepEqual(urls, ['blob:report']); assert.equal(state.importReportUrl, null);
  w.api = async () => { throw new Error('批次过期'); };
  d.querySelector('#import-diagnostics > button').click(); await tick();
  assert.match(d.querySelector('#import-diagnostics [role="alert"]').textContent, /批次过期/);
  assert.equal(d.querySelector('#import-diagnostics > button').disabled, false);
});

test('late downloads and preflight responses cannot repopulate reports after sealing', async t => {
  const { w, d, state } = await setup(t); let resolve; let created = false;
  w.URL.createObjectURL = () => { created = true; return 'blob:late'; };
  w.renderImportDiagnostics(report(), w.buildImportRequest(), false);
  w.api = async () => new Promise(done => { resolve = done; });
  d.querySelector('#import-diagnostics > button').click(); await w.sealVault('', false); resolve(new w.Blob(['csv'])); await tick();
  assert.equal(created, false); assert.equal(state.importDiagnostics, null); assert.equal(d.querySelector('#import-diagnostics').textContent, '');
});

test('native report requests preserve the original package text and use the native endpoint', async t => {
  const { w, d, state } = await setup(t);
  const raw = '{"format":"securevault-dataset","version":1,"mode":"package","schema":{"category_path":"测试","environments":["测试标签"],"fields":[]},"records":[{"source_id":"x","values":{"id":9007199254740993}}]}';
  w.confirm = () => true; await w.importFile({ name: 'native.json', text: async () => raw });
  w.api = async (route, options) => {
    assert.equal(JSON.parse(options.body).package, raw);
    return { valid: false, diagnostics: report() };
  };
  await w.commitImport(); assert.equal(state.importPreview, null); assert.equal(d.querySelectorAll('.import-issue button').length, 0);
  w.api = async (route, options) => { assert.equal(route, '/datasets/transfer/report?format=csv'); assert.equal(JSON.parse(options.body).package, raw); throw new Error('下载失败'); };
  d.querySelector('#import-diagnostics > button').click(); await tick(); assert.match(d.querySelector('#import-diagnostics').textContent, /下载失败/);
  d.querySelector('#transfer-environment-tags button').click();
  assert.equal(state.importDiagnostics, null); assert.equal(d.querySelector('#import-diagnostics').hidden, true);
});

test('API blob responses preserve session expiration handling', async t => {
  const { w, state, originalApi } = await setup(t);
  w.api = originalApi;
  w.fetch = async () => ({ status: 423, ok: false, json: async () => ({ error: 'sealed' }) });
  await assert.rejects(w.api('/records/import/report?format=csv', { responseType: 'blob' }), /sealed/);
  await tick(); assert.equal(state.unlocked, false);
});

test('ordinary updates disclose missing-field replacement and stale edited previews are discarded', async t => {
  const { w, d, state, row } = await setup(t);
  w.api = async () => ({ valid: true, imported: 0, updated: 2, diagnostics: { ...report(0), warning_count: 0 } });
  await w.commitImport(); assert.match(d.querySelector('#import-confirm-summary').textContent, /未写入或忽略的旧字段也会被清除/);
  d.querySelector('#import-back').click();
  let resolve;
  w.api = async () => new Promise(done => { resolve = done; });
  const pending = w.commitImport();
  row.querySelector('[data-map-path]').dispatchEvent(new w.Event('input', { bubbles: true }));
  resolve({ valid: false, diagnostics: report(2) }); await pending;
  assert.equal(state.importPreview, null); assert.equal(state.importBusy, false); assert.equal(d.querySelector('#import-diagnostics').hidden, true);
});
