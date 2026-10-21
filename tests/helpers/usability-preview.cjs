// Disposable browser regression fixture. Serves real web assets and synthetic,
// in-memory API responses only; never reads or writes the vault directory.
// Run: node tests/helpers/usability-preview.cjs
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const web = path.resolve(__dirname, '../../web');
const fields = [
  { source_key: 'code', display_name: '账户编号', zone: 'indexes', position: 0 },
  { source_key: 'name', display_name: '名称', zone: 'display', position: 1 },
  { source_key: 'endpoint', display_name: '服务地址', zone: 'display', position: 2 },
  { source_key: 'token', display_name: '凭据', zone: 'secrets', position: 3 },
];
const definition = { fields, identity_fields: ['code'], list_fields: fields.slice(0, 3).map((field, position) => ({ source_key: field.source_key, display_name: field.display_name, visible: true, position, format: 'single_line' })), display_config: { identifier_fields: ['code'], density: 'summary' }, supplement_fields: [{ source_key: 'memo', display_name: '备注', zone: 'normal' }] };
const datasets = ['test', 'prod', 'external'].map((id, index) => ({ ...definition, id, name: ['测试账户', '生产账户', '外部账户'][index], category_path: index === 2 ? '外部/服务' : '业务/账户', schema_id: 'accounts', schema_name: '账户模型', schema_version: 1, schema_description: '共享账户字段，按数据集独立存储记录。', environments: [index === 2 ? '合作方' : '内部', index === 1 ? '生产' : '测试'], description: '用于浏览器回归的合成数据。', record_count: id === 'test' ? 23 : 6 }));
const catalog = { schemas: [{ id: 'accounts', name: '账户模型', version: 1, dataset_ids: datasets.map(d => d.id), definition, description: '共享账户字段，按数据集独立存储记录。' }], environments: [] };
const records = datasets.flatMap(dataset => Array.from({ length: dataset.id === 'test' ? 23 : 6 }, (_, i) => ({ id: `${dataset.id}-${i}`, dataset_id: dataset.id, category: dataset.category_path, environments: dataset.environments, indexes: { code: `AC-${dataset.id}-${100 + i}` }, display: { name: `示例服务 ${i + 1}`, endpoint: `https://service-${i + 1}.example.test` }, normal: {}, secret_count: 1, expired: false, protected_fields: [{ field_name: 'token', zone: 'secrets' }], supplement_fields: [], supplement_records: [] })));
records[0].normal = { '任务说明': '这是一段用于验证长内容展开、复制和换行的合成文字。\n'.repeat(16), '配置 JSON': { enabled: false, retries: 0, regions: ['测试区域 A', '测试区域 B'], endpoint: 'https://example.test/' + 'long-segment/'.repeat(24) }, '空值': null, '空字符串': '', '零值': 0 };
const apps = [
  { id: 'demo-reader', name: '检索工具', permission: 'search', datasets: ['test'], disabled: false, access_expires_at: Math.floor(Date.now() / 1000) + 1800 },
  { id: 'demo-sync', name: '每日报表同步服务（暂停中）', permission: 'search', datasets: ['test', 'external'], disabled: true, access_expires_at: null },
];
const queries = [];
const supplements = [{ id: 'occupied', main_record_id: 'test-1', values: { memo: '已有关联' }, protected_fields: [], orphan: false, link: { mode: 'id', values: {} }, updated: '2026-10-20' }];
records[1].supplement = { id: 'occupied' };
records[1].supplement_records = [supplements[0]];
const searchRequests = [];
let sealed = process.env.PREVIEW_SEALED === '1';
let noticeRevision = 4, muted = false;
const authorizationEvents = ['expired', 'secrets_permission', 'no_datasets', 'owner_required'].map((reason, i) => ({ id: i + 1, app_id: 'demo-reader', app_name: '检索工具', reason, operation: i === 1 ? 'reveal' : i === 3 ? 'management' : 'search', first_at: 1792551600, last_at: 1792551600 + i, count: i + 1, unread: true, ignored: false }));
const authorizationNotice = () => ({ revision: noticeRevision, muted, unread: muted ? 0 : authorizationEvents.filter(event => event.unread && !event.ignored).length });
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    const file = path.resolve(web, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store'); res.end(fs.readFileSync(file)); return;
  }
  let raw = ''; for await (const chunk of req) raw += chunk;
  let body = {}; if (req.headers['content-type']?.includes('application/json') && raw) body = JSON.parse(raw);
  const route = url.pathname.slice(4); let result = {};
  if (route === '/__fixture/searches') result = { queries: searchRequests };
  else if (route === '/vault/status') result = { initialized: true, sealed, persistent: false, can_manage: !sealed, session_id: sealed ? null : 'synthetic-session', authorization_notice: sealed ? null : authorizationNotice(), role: 'admin', idle_timeout_seconds: 1800 };
  else if (route === '/vault/unlock') { sealed = false; result = { sealed: false, persistent: false, session_id: 'synthetic-session', can_manage: true, authorization_notice: authorizationNotice() }; }
  else if (route === '/vault/seal') { sealed = true; result = { sealed: true }; }
  else if (route === '/datasets') result = { datasets };
  else if (route === '/datasets/tree') result = { directories: [{ name: '业务', path: '业务', count: 12, children: [{ name: '账户', path: '业务/账户', count: 12, children: [] }] }, { name: '外部', path: '外部', count: 6, children: [{ name: '服务', path: '外部/服务', count: 6, children: [] }] }] };
  else if (route === '/vault/summary') result = { datasets: 3, records: records.length, protected_fields: records.length };
  else if (route === '/catalog') result = catalog;
  else if (route === '/saved-queries' && req.method === 'GET') result = { queries };
  else if (route === '/saved-queries' && req.method === 'POST') { result = { id: 'query-' + Date.now(), ...body }; queries.push(result); }
  else if (route.startsWith('/saved-queries/')) {
    const index = queries.findIndex(query => query.id === route.split('/').at(-1));
    if (req.method === 'DELETE') { if (index >= 0) queries.splice(index, 1); result = { deleted: true }; }
    else if (index >= 0) { Object.assign(queries[index], body); result = queries[index]; }
  }
  else if (/^\/datasets\/[^/]+\/supplement$/.test(route)) result = { fields: definition.supplement_fields, records: supplements, link_mode: 'id', link_fields: [] };
  else if (/^\/datasets\/[^/]+\/supplement\/records/.test(route) && req.method === 'POST') {
    const row = { id: 'fixture-supplement', main_record_id: body.main_record_id, values: body.values, protected_fields: [], orphan: false, link: { mode: 'id', values: {} }, updated: '2026-10-20' };
    supplements.push(row); const parent = records.find(record => record.id === row.main_record_id);
    if (parent) { parent.supplement = { id: row.id }; parent.supplement_records = [row]; }
    result = { id: row.id };
  }
  else if (route === '/apps/authorization-events') {
    if (req.method === 'POST') {
      for (const event of authorizationEvents) { if (body.seen_ids?.includes(event.id)) event.unread = false; if (body.ignore_id === event.id) { event.ignored = true; event.unread = false; } }
      if (typeof body.muted === 'boolean') muted = body.muted;
      noticeRevision++;
    }
    result = { session_id: 'synthetic-session', summary: authorizationNotice(), events: authorizationEvents };
  }
  else if (route === '/apps' && req.method === 'GET') result = { apps };
  else if (route.startsWith('/apps/') && req.method === 'PATCH') {
    const app = apps.find(item => item.id === route.split('/').at(-1));
    if (app) {
      const { access_ttl_seconds: ttl, ...changes } = body;
      Object.assign(app, changes);
      if (ttl !== undefined) app.access_expires_at = ttl ? Math.floor(Date.now() / 1000) + ttl : null;
      result = { saved: true };
    }
  }
  else if (route === '/records/search') {
    searchRequests.push(url.searchParams.get('q') || '');
    const p = url.searchParams, categories = p.has('categories') ? JSON.parse(p.get('categories')) : p.has('category') ? [p.get('category')] : [];
    const labels = JSON.parse(p.get('environment_tags') || '[]');
    const found = records.filter(record => (!p.get('dataset_id') || record.dataset_id === p.get('dataset_id')) && (!categories.length || categories.some(category => record.category === category || record.category.startsWith(category + '/'))) && labels.every(label => record.environments.includes(label)) && (!p.get('q') || JSON.stringify(record.indexes).includes(p.get('q'))));
    const page = Number(p.get('page') || 1), limit = Number(p.get('limit') || 40);
    result = { records: found.slice((page - 1) * limit, page * limit), total: found.length, page };
  } else if (/^\/records\/[^/]+$/.test(route) && req.method === 'GET') result = records.find(r => r.id === route.split('/').at(-1)) || {};
  else if (route.endsWith('/templates')) result = { templates: [] };
  else if (route === '/imports/upload') result = { batch_id: 'demo-batch', filename: 'browser-regression.csv', record_count: 6, source_fields: ['code', 'name', 'endpoint', 'unknown'] };
  else if (route === '/records/import/preview') result = { imported: 2, updated: 3, skipped: 1, deleted_missing: body.delete_missing ? 2 : 0 };
  else if (route === '/records/import') result = { imported: 2, updated: 3, skipped: 1, deleted_missing: body.delete_missing ? 2 : 0 };
  else if (route === '/schemas/preview') result = { confirmation_token: 'fixture-preview', changes: datasets.map(d => ({ id: d.id, category_path: d.category_path, environments: d.environments, record_count: 6, supplement_count: 0, changes: body.definition?.fields?.some(f => f.zone === 'ignore') ? ['token：secrets → ignore（清除已有值）'] : ['更新列表展示与记录标识'] })) };
  res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(result));
}).listen(4189, '127.0.0.1', () => process.stdout.write('Synthetic UI regression server: http://127.0.0.1:4189\n'));
