const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const modulePath = pathToFileURL(path.join(__dirname, '../extensions/httpyac/securevault.mjs')).href;

async function fixture(t, options = {}) {
  const { loadFields } = await import(modulePath);
  const requests = [];
  const datasets = options.datasets || [
    { id: 'a-prod', name: '商户凭据', category_path: '示例/产品', environments: ['客户A', '生产'], schema_id: 'model-a' },
    { id: 'a-test', name: '商户凭据', category_path: '示例/产品', environments: ['客户A', '测试'], schema_id: 'model-a' },
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ url, headers: req.headers, method: req.method });
    let value;
    if (url.pathname.endsWith('/client/datasets')) value = { datasets };
    else if (url.pathname.endsWith('/records/search')) value = options.search || { total: 1, records: [{ id: 'rec' }] };
    else if (url.pathname.endsWith('/secrets/reveal')) value = { value: 'DEMO_ONLY_SECRET' };
    else value = options.detail || { id: 'rec', dataset_id: 'a-prod', indexes: { code: 0 }, display: { enabled: false }, protected_fields: [{ field_name: 'token', zone: 'secrets' }] };
    res.writeHead(options.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const config = { baseUrl: `http://127.0.0.1:${server.address().port}/prefix`, appId: 'DEMO_APP', appKey: 'DEMO_KEY', fields: { code: 'code', enabled: 'enabled' } };
  return { requests, load: args => loadFields({ ...config, ...args }) };
}

test('httpyac serializes ordered literal tags as JSON intersection and combines model and dataset IDs', async t => {
  const { load, requests } = await fixture(t);
  const result = await load({ datasetId: 'a-prod', schemaId: 'model-a', category: '示例', tags: [' 客户A ', '生产', '客户A', 'a,b / c'], query: 'code:=0' });
  assert.deepEqual({ ...result }, { code: 0, enabled: false });
  const { url, headers } = requests[0];
  assert.equal(url.pathname, '/prefix/api/records/search');
  assert.deepEqual(JSON.parse(url.searchParams.get('environment_tags')), [' 客户A ', '生产', '客户A', 'a,b / c']);
  assert.equal(url.searchParams.get('schema_id'), 'model-a');
  assert.equal(url.searchParams.get('dataset_id'), 'a-prod');
  assert.equal(url.searchParams.get('q'), 'code:=0');
  assert.equal(url.searchParams.has('environment'), false);
  assert.equal(headers['x-app-key'], 'DEMO_KEY');
  assert.ok(!url.href.includes('DEMO_KEY'));
});

test('httpyac keeps legacy single environment as one additional tag without splitting names', async t => {
  const { load, requests } = await fixture(t);
  await load({ tags: ['客户A'], environment: '生产 / 主站' });
  assert.deepEqual(JSON.parse(requests[0].url.searchParams.get('environment_tags')), ['客户A', '生产 / 主站']);
  assert.equal(requests[0].url.searchParams.get('environment'), '生产 / 主站');
});

test('httpyac resolves display names only in authorized metadata and applies every scope before search', async t => {
  const { load, requests } = await fixture(t);
  await load({ datasetName: ' 商户凭据 ', tags: ['客户A', '生产'], category: '示例', schemaId: 'model-a' });
  assert.equal(requests[0].url.pathname, '/prefix/api/client/datasets');
  assert.equal(requests[1].url.searchParams.get('dataset_id'), 'a-prod');
  assert.ok(requests.every(request => !request.url.pathname.endsWith('/catalog')));
});

test('httpyac refuses ambiguous or unmatched names before searching or revealing fields', async t => {
  const { load, requests } = await fixture(t);
  await assert.rejects(load({ datasetName: '商户凭据' }), /名称匹配到 2 个数据集/);
  await assert.rejects(load({ datasetName: '商户凭据', tags: ['客户B'] }), /授权范围内未找到/);
  await assert.rejects(load({ datasetName: '商户凭据', datasetId: 'a-test', tags: ['生产'] }), /授权范围内未找到/);
  await assert.rejects(load({ datasetName: '商户凭据', schemaId: 'other-model' }), /授权范围内未找到/);
  assert.ok(requests.every(request => request.url.pathname.endsWith('/client/datasets')));
});

test('httpyac uses the directory leaf for unnamed datasets and respects explicit empty tags over legacy values', async t => {
  const { load, requests } = await fixture(t, { datasets: [{ id: 'a-prod', category_path: '示例/产品', environment: '旧标签', environments: [] }] });
  await load({ datasetName: '产品' });
  await assert.rejects(load({ datasetName: '产品', tags: ['旧标签'] }), /授权范围内未找到/);
  assert.equal(requests[1].url.searchParams.get('dataset_id'), 'a-prod');
});

test('httpyac rejects invalid tags and mixed direct IDs before any request', async t => {
  const { load, requests } = await fixture(t);
  for (const tags of ['客户A,生产', [null], [''], Array.from({ length: 65 }, (_, i) => String(i))]) {
    await assert.rejects(load({ tags }), /tags|标签/);
  }
  for (const filter of [{ tags: ['生产'] }, { schemaId: 'model' }, { datasetName: '商户凭据' }]) {
    await assert.rejects(load({ recordId: 'rec', ...filter }), /二选一/);
  }
  assert.equal(requests.length, 0);
});

test('httpyac requires a unique search result and never reveals fields on mismatch', async t => {
  for (const total of [0, 2]) {
    const { load, requests } = await fixture(t, { search: { total, records: [] } });
    await assert.rejects(load({ tags: ['客户A', '生产'], fields: ['secrets.token'] }), /未找到|缩小检索范围/);
    assert.equal(requests.length, 1);
  }
});

test('httpyac verifies selected dataset before accessing secrets and retains direct record compatibility', async t => {
  const { load, requests } = await fixture(t);
  await assert.rejects(load({ datasetId: 'other', fields: ['secrets.token'] }), /详情响应格式异常/);
  assert.equal(requests.length, 2);
  assert.deepEqual({ ...await load({ recordId: 'rec', fields: { token: 'secrets.token' } }) }, { token: 'DEMO_ONLY_SECRET' });
  assert.equal(requests.at(-1).url.pathname, '/prefix/api/records/rec/secrets/reveal');
  assert.equal(requests.at(-1).method, 'POST');
});

test('httpyac does not fall back after denied, revoked or locked metadata requests', async t => {
  for (const status of [401, 403, 423]) {
    const { load, requests } = await fixture(t, { status });
    await assert.rejects(load({ datasetName: '商户凭据', tags: ['客户A', '生产'] }), new RegExp(`HTTP ${status}`));
    assert.equal(requests.length, 1);
  }
});


test('httpyac preserves exact legacy tag spelling instead of trimming or splitting it', async t => {
  const label = ' 客户A,区域 / 主站;备站 ';
  const { load, requests } = await fixture(t, { datasets: [{ id: 'a-prod', name: '商户凭据', category_path: '示例/产品', environments: [label, '生产'] }] });
  await load({ datasetName: '商户凭据', tags: [label, '生产'] });
  assert.deepEqual(JSON.parse(requests[1].url.searchParams.get('environment_tags')), [label, '生产']);
  await assert.rejects(load({ datasetName: '商户凭据', tags: [label.trim(), '生产'] }), /授权范围内未找到/);
});
