const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const sources = ['code', 'artist_id', 'artist_name', 'bundle_ids'];
const fields = [{ source_key: 'code', zone: 'indexes' }, { source_key: 'payload', zone: 'secrets' }];
async function setup(t, source = 'text', targetFields = fields) {
  const w = page(t, true); await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, datasets: [{ id: 'ds', category_path: '组装/测试', fields: targetFields, identity_fields: targetFields.length ? ['code'] : [], list_fields: [] }] });
  w.openImport('ds');
  const requests = [];
  w.fetch = async (url, options) => {
    requests.push({ url, options });
    let data = {};
    if (url === '/api/imports/text' || url === '/api/imports/upload') data = { batch_id: 'b', filename: 'artists.yaml', format: 'yaml', record_count: 2, source_fields: sources };
    if (url.endsWith('/templates')) data = { templates: [] };
    if (url === '/api/records/import/preview') data = { valid: true, updated: 2 };
    if (url === '/api/records/import') data = { imported: 2 };
    return { ok: true, json: async () => data };
  };
  if (source === 'text') {
    change(w, 'input[name="import-source"][value="text"]');
    w.document.querySelector('#import-text').value = '- code: one\n  artist_id: "001"\n  artist_name: 王X\n  bundle_ids: [app.one]';
    await w.parseImportText();
  } else await w.importFile(new w.File(['fixture'], 'artists.yaml'));
  return { w, d: w.document, requests };
}
function change(w, selector, value) {
  const control = w.document.querySelector(selector);
  if (control.type === 'radio') control.checked = true; else control.value = value;
  control.dispatchEvent(new w.Event('change', { bubbles: true }));
}
function assign(w, source, path, target = 'payload') {
  change(w, `[data-map-source="${source}"]`, target);
  const control = w.document.querySelector(`[data-map-target-path="${source}"]`);
  control.value = path; control.dispatchEvent(new w.Event('input', { bubbles: true }));
}
function assembly(w) {
  assign(w, 'artist_id', 'artist.id'); assign(w, 'artist_name', 'artist.name'); assign(w, 'bundle_ids', 'bundle_ids');
}
for (const source of ['file', 'text']) test(`${source} import builds a shared JSON target and submits only after preview`, async t => {
  const { w, d, requests } = await setup(t, source); assembly(w);
  const request = w.buildImportRequest();
  assert.deepEqual(request.mappings.map(m => m.target_path).join(','), ',artist.id,artist.name,bundle_ids');
  assert.equal(request.evolved_fields.length, 0);
  await w.commitImport(); assert.equal(w.stateForTest.importStep, 3);
  assert.match(d.querySelector('#import-confirm-summary').textContent, /整字段替换.*旧属性不合并/);
  assert.equal(requests.some(r => r.url === '/api/records/import'), false);
  await w.confirmImport();
  const submitted = JSON.parse(requests.find(r => r.url === '/api/records/import').options.body);
  assert.equal(submitted.mappings[1].target_path, 'artist.id');
  assert.equal(submitted.mappings[2].target_key, 'payload');
});

test('conflicting JSON paths remain visible and cannot reach server preview', async t => {
  const { w, d, requests } = await setup(t); assembly(w);
  for (const path of ['artist.id', 'artist', '']) {
    assign(w, 'artist_name', path); await w.commitImport();
    assert.equal(requests.some(r => r.url === '/api/records/import/preview'), false);
    assert.equal(d.querySelectorAll('[data-map-target-path][aria-invalid="true"]').length, path ? 2 : 3);
    assert.match(d.querySelector('#import-config-error').textContent, /冲突|同一个目标/);
    assert.equal(d.querySelector('[data-map-target-path="artist_id"]').closest('details').open, true);
  }
  for (const path of ['artist..id', 'items.0.id', 'items[0].id', 'artist.*']) {
    assign(w, 'artist_name', path); assert.throws(() => w.buildImportRequest(), /目标 JSON 属性路径/);
  }
  assign(w, 'artist_name', 'artist.identifier'); assert.doesNotThrow(() => w.buildImportRequest());
});

test('mapping templates restore source and target paths without collapsing configured rows', async t => {
  const { w, d } = await setup(t); assembly(w);
  const templates = w.buildImportRequest().mappings;
  templates[1].json_path = 'artist.id';
  w.renderMappings(sources, fields, true, templates);
  assert.equal(d.querySelector('[data-map-path="artist_id"]').value, 'artist.id');
  assert.equal(d.querySelector('[data-map-target-path="artist_id"]').value, 'artist.id');
  assert.equal(d.querySelector('[data-map-source="artist_id"]').value, 'payload');
  assert.equal(d.querySelector('[data-map-target-path="artist_id"]').closest('.mapping-row').hidden, false);
  assert.equal(d.querySelector('[data-map-target-path="artist_id"]').closest('details').open, true);
  const restored = w.buildImportRequest().mappings;
  assert.equal(JSON.stringify(restored), JSON.stringify(templates));
});

test('new JSON fields are defined once and do not duplicate their schema', async t => {
  const { w, d } = await setup(t);
  for (const [source, path] of [['artist_id', 'artist.id'], ['artist_name', 'artist.name'], ['bundle_ids', 'bundle_ids']]) {
    assign(w, source, path, '__new'); d.querySelector(`[data-map-new="${source}"]`).value = 'new_payload';
  }
  const request = w.buildImportRequest();
  assert.equal(request.evolved_fields.length, 1);
  assert.equal(request.evolved_fields[0].source_key, 'new_payload');
  assert.equal(request.evolved_fields[0].zone, 'normal');
});

test('target property edits invalidate in-flight previews and sample requests carry null semantics', async t => {
  const { w, d } = await setup(t); assembly(w);
  let resolve; w.api = () => new Promise(done => { resolve = done; });
  const pending = w.commitImport(); assign(w, 'artist_name', 'artist.title');
  resolve({ valid: true, updated: 1 }); await pending;
  assert.equal(w.stateForTest.importPreview, null);
  let sample;
  w.api = async (_, options) => { sample = JSON.parse(options.body); return { rows: [], record_count: 2 }; };
  await w.previewMappingSample(d.querySelector('[data-map-source="artist_name"]').closest('.mapping-row'), false);
  assert.equal(sample.target_path, 'artist.title'); assert.equal(sample.reveal, false);
});

test('first import deduplicates assembled schema and rejects conflicting field protection', async t => {
  const { w, d } = await setup(t, 'text', []);
  for (const [source, path] of [['artist_id', 'artist.id'], ['artist_name', 'artist.name'], ['bundle_ids', 'bundle_ids']]) {
    assign(w, source, path, '__new'); d.querySelector(`[data-map-new="${source}"]`).value = 'payload';
  }
  const rows = [...d.querySelectorAll('#first-schema-fields .schema-field')];
  rows[0].querySelector('.schema-field-unique').checked = true;
  let request = w.buildImportRequest();
  assert.equal(request.evolved_fields.length, 2);
  assert.equal(request.evolved_identity_fields.join(','), 'code');
  assert.equal(request.evolved_fields[1].source_key, 'payload');
  rows[1].querySelector('.schema-field-zone').value = 'secrets';
  assert.throws(() => w.buildImportRequest(), /用途和唯一 KEY 设置必须一致/);
  rows.slice(1).forEach(row => { row.querySelector('.schema-field-zone').value = 'secrets'; });
  request = w.buildImportRequest();
  assert.equal(request.evolved_fields[1].zone, 'secrets');
});
