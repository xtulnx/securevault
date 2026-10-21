const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, extra = {}) {
  const w = page(t, true); await w.initialStatusCheck;
  const d = w.document, state = w.stateForTest;
  const app = { id: 'app', name: '回归应用', datasets: ['a'], permission: 'search', disabled: false, access_expires_at: Math.floor(Date.now() / 1000) + 900, ...extra };
  Object.assign(state, { unlocked: true, canManage: true, apps: [app], datasets: [
    { id: 'a', name: '测试账户', category_path: '业务/账户', environments: ['测试'] },
    { id: 'b', name: '生产账户', category_path: '业务/账户', environments: ['生产'] },
    { id: 'c', name: '外部账户', category_path: '外部/服务', environments: ['合作方'] },
  ] });
  const calls = [];
  w.api = async (route, options) => { calls.push({ route, options }); return route === '/apps' ? { apps: state.apps } : {}; };
  w.confirm = () => true;
  return { w, d, state, app, calls };
}
function change(w, input, value) {
  if (input.type === 'checkbox') input.checked = value; else input.value = value;
  input.dispatchEvent(new w.Event('change', { bubbles: true }));
}
function clipboard(w, writeText) { Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText } }); }
function detail(w, d, values) {
  d.querySelector('#record-detail-content').innerHTML = w.detailRows(values);
  return [...d.querySelectorAll('[data-copy-json]')];
}

test('authorization summary names additions and removals and preserves the original deadline on save', async t => {
  const { w, d, calls } = await setup(t);
  w.openAppScope('app');
  change(w, d.querySelector('#scope-datasets input[value="a"]'), false);
  change(w, d.querySelector('#scope-datasets input[value="b"]'), true);
  assert.match(d.querySelector('.scope-diff-counts').textContent, /新增 1 · 移除 1 · 保留 0/);
  assert.match(d.querySelector('[data-scope-diff="added"]').textContent, /生产账户/);
  assert.match(d.querySelector('[data-scope-diff="removed"]').textContent, /测试账户/);
  assert.match(d.querySelector('#scope-summary').textContent, /保持到期时间/);
  await w.saveAppScope();
  const body = JSON.parse(calls.find(call => call.options?.method === 'PATCH').options.body);
  assert.deepEqual(body.datasets, ['b']); assert.equal(body.access_ttl_seconds, undefined);
});

test('permission elevation and reenable consequences are explicit even when the scope is empty', async t => {
  const { w, d } = await setup(t, { disabled: true });
  w.openAppScope('app');
  change(w, d.querySelector('#scope-permission'), 'secrets');
  change(w, d.querySelector('#scope-datasets input[value="a"]'), false);
  const text = d.querySelector('#scope-summary').textContent;
  assert.match(text, /只读检索 → 敏感信息查看/);
  assert.match(text, /权限提升/); assert.match(text, /保存会重新启用/);
  assert.match(text, /无法读取任何数据/); assert.match(text, /保持到期时间/);
});

test('directory grouping and filtering preserve hidden selections and unchanged diff details', async t => {
  const { w, d } = await setup(t);
  w.openAppScope('app');
  assert.equal(d.querySelectorAll('.scope-directory-group').length, 2);
  change(w, d.querySelector('#scope-datasets input[value="b"]'), true);
  d.querySelector('[data-scope-diff="added"]').open = true;
  d.querySelector('#scope-search').value = '外部'; w.updateAppScope();
  assert.equal(d.querySelectorAll('.scope-directory-group:not([hidden])').length, 1);
  assert.match(d.querySelector('#scope-count').textContent, /已选 2 \/ 3 个 · 匹配 1 个/);
  assert.equal(d.querySelector('[data-scope-diff="added"]').open, true);
  d.querySelector('#scope-select-visible').click();
  assert.equal(d.querySelectorAll('#scope-datasets input:checked').length, 3);
  d.querySelector('#scope-clear-visible').click();
  assert.equal(d.querySelectorAll('#scope-datasets input:checked').length, 2);
  assert.match(d.querySelector('.scope-diff-counts').textContent, /新增 1 · 移除 0 · 保留 1/);
});

test('diff baseline is stable across list updates, and inaccessible removals are visible and escaped', async t => {
  const { w, d, app } = await setup(t, { datasets: ['a', '<deleted>'] });
  w.openAppScope('app');
  assert.match(d.querySelector('[data-scope-diff="removed"]').textContent, /已删除或不可见的数据集（<deleted>）/);
  assert.equal(d.querySelector('#scope-summary deleted'), null);
  app.datasets.push('b'); app.permission = 'secrets';
  change(w, d.querySelector('#scope-datasets input[value="b"]'), true);
  assert.match(d.querySelector('.scope-diff-counts').textContent, /新增 1 · 移除 1 · 保留 1/);
  assert.match(d.querySelector('#scope-summary').textContent, /只读检索 → 只读检索（不变）/);
});

test('expired and new application summaries describe the actual duration without a fictitious previous grant', async t => {
  const { w, d } = await setup(t, { access_expires_at: 1 });
  w.openAppScope('app');
  assert.match(d.querySelector('#scope-summary').textContent, /从保存起 30 分钟/);
  assert.match(d.querySelector('#scope-summary').textContent, /保存后恢复授权/);
  change(w, d.querySelector('#scope-ttl'), '0');
  assert.match(d.querySelector('#scope-summary').textContent, /保存后长期有效/);
  w.closeAppScope(true); w.openAppScope();
  assert.match(d.querySelector('#scope-summary').textContent, /创建后启用/);
  assert.doesNotMatch(d.querySelector('#scope-summary').textContent, /原到期|权限提升| → /);
});

test('failed authorization saves keep the draft and summary; closing clears both', async t => {
  const { w, d } = await setup(t);
  w.openAppScope('app'); change(w, d.querySelector('#scope-permission'), 'secrets');
  w.api = async () => { throw new Error('模拟保存失败'); };
  await w.saveAppScope();
  assert.equal(d.querySelector('#app-scope-modal').open, true);
  assert.match(d.querySelector('#scope-error').textContent, /模拟保存失败/);
  assert.match(d.querySelector('#scope-summary').textContent, /权限提升/);
  assert.equal(d.querySelector('#save-app-scope').disabled, false);
  w.closeAppScope(true);
  assert.equal(d.querySelector('#scope-summary').textContent, '');
  assert.equal(d.querySelector('#scope-summary-status').textContent, '');
});

test('long and multiline values collapse independently, escape markup and keep a full copy target', async t => {
  const { w, d } = await setup(t);
  const long = '<img src=x onerror=alert(1)>' + '长内容'.repeat(160);
  detail(w, d, { long, short: '短文本', lines: '1\n2\n3\n4\n5' });
  assert.equal(d.querySelectorAll('.detail-value-disclosure').length, 2);
  assert.equal(d.querySelector('.detail-value-disclosure').open, false);
  assert.equal(d.querySelector('.detail-full-value').textContent, long);
  assert.equal(d.querySelector('.detail-full-value').tabIndex, 0);
  assert.equal(d.querySelector('.detail-full-value').getAttribute('role'), 'region');
  assert.equal(d.querySelector('#record-detail-content img'), null);
  d.querySelector('.detail-value-disclosure').open = true;
  assert.equal([...d.querySelectorAll('.detail-value-disclosure')][1].open, false);
  const copied = []; clipboard(w, async value => copied.push(value));
  d.querySelector('[data-copy-json]').click(); await tick();
  assert.deepEqual(copied, [long]);
  assert.equal(d.querySelector('[data-copy-json]').textContent, '已复制');
});

test('copying preserves zero, false, null, empty and whitespace strings rather than their visual placeholders', async t => {
  const { w, d } = await setup(t);
  const buttons = detail(w, d, { zero: 0, off: false, nil: null, empty: '', whitespace: '  \n' });
  const copied = []; clipboard(w, async value => copied.push(value));
  for (const button of buttons) { button.click(); await tick(); }
  assert.deepEqual(copied, ['0', 'false', 'null', '', '  \n']);
  assert.equal(d.querySelectorAll('.empty-value').length, 3);
});

test('formatted JSON remains exact JSON on copy and does not expose protected fields', async t => {
  const { w, d } = await setup(t);
  const value = { active: false, nested: { count: 0, list: [1, 2, 3] } };
  const [button] = detail(w, d, { configuration: value });
  assert.ok(d.querySelector('.detail-full-value').textContent.includes('\n'));
  let copied; clipboard(w, async text => { copied = text; });
  button.click(); await tick();
  assert.deepEqual(JSON.parse(copied), value);
  assert.equal(d.querySelector('[data-field]'), null);
});

test('clipboard failures remain next to the button and a retry succeeds without duplicate pending copies', async t => {
  const { w, d } = await setup(t);
  const [button] = detail(w, d, { value: 'copy-me' });
  clipboard(w, async () => { throw new Error('denied'); });
  button.click(); await tick();
  assert.equal(button.textContent, '重试复制'); assert.equal(button.disabled, false);
  assert.match(button.parentElement.querySelector('.copy-feedback').textContent, /复制失败/);
  let finish, copies = 0;
  clipboard(w, () => { copies++; return new Promise(resolve => { finish = resolve; }); });
  button.click(); button.click();
  assert.equal(button.disabled, false); assert.equal(button.getAttribute('aria-disabled'), 'true'); assert.equal(copies, 1);
  finish(); await tick();
  assert.equal(button.textContent, '已复制'); assert.equal(button.disabled, false);
  w.clearCopyFeedback();
  assert.equal(button.textContent, '复制'); assert.equal(button.getAttribute('aria-label'), '复制 value');
});

test('pending clipboard completion and authorization summaries cannot repopulate a sealed view', async t => {
  const { w, d } = await setup(t);
  w.openAppScope('app'); change(w, d.querySelector('#scope-permission'), 'secrets');
  const [button] = detail(w, d, { value: 'only-in-test' });
  let finish; clipboard(w, () => new Promise(resolve => { finish = resolve; }));
  button.click(); await w.sealVault('', false);
  finish(); await tick();
  assert.equal(d.querySelector('#scope-summary').textContent, '');
  assert.equal(d.querySelector('#scope-summary-status').textContent, '');
  assert.equal(d.querySelectorAll('.copy-feedback').length, 0);
  assert.equal(d.querySelector('#record-detail-content').textContent, '');
});

test('one-time key copying uses local feedback and closing clears both key and feedback', async t => {
  const { w, d } = await setup(t);
  let copied; clipboard(w, async value => { copied = value; });
  w.showAppKey('SYNTHETIC-KEY', { id: 'app', name: '测试' });
  d.querySelector('#copy-app-key').click(); await tick();
  assert.equal(copied, 'SYNTHETIC-KEY');
  assert.equal(d.querySelector('#copy-app-key').textContent, '已复制');
  d.querySelector('#finish-app-key').click();
  assert.equal(d.querySelector('#app-key-value').value, '');
  assert.equal(d.querySelector('#copy-app-key').textContent, '复制密钥');
  assert.equal(d.querySelectorAll('.copy-feedback').length, 0);
});
