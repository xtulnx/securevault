const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));
const app = (extra = {}) => ({ id: 'app-1', name: 'Raycast', permission: 'search', disabled: false, datasets: ['prod'], access_expires_at: Math.floor(Date.now() / 1000) + 900, ...extra });
async function setup(t, apps = [app()]) {
  const w = page(t, true);
  await w.initialStatusCheck;
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, apps, datasets: [
    { id: 'prod', category_path: '支付/商户', environment: 'prod' },
    { id: 'dev', category_path: '研发/工具', environment: 'dev' },
    { id: 'test', category_path: '研发/工具', environment: 'test' },
  ] });
  w.confirm = () => true;
  const requests = [];
  w.fetch = async (url, options = {}) => { requests.push({ url, options }); return response(url.endsWith('/apps') ? { apps } : {}); };
  w.renderApplications();
  return { w, requests, $: selector => w.document.querySelector(selector) };
}

test('application search and state filters distinguish active, expired, disabled and unconfigured apps', async t => {
  const { w, $ } = await setup(t, [app(), app({ id: 'expired', name: '过期脚本', access_expires_at: 1 }), app({ id: 'disabled', name: '停用脚本', disabled: true }), app({ id: 'empty', name: '新应用', datasets: [] })]);
  assert.equal(w.document.querySelectorAll('.application-row').length, 4);
  for (const [filter, name] of [['active', 'Raycast'], ['expired', '过期脚本'], ['disabled', '停用脚本'], ['unscoped', '新应用']]) {
    $('#application-filter').value = filter; w.renderApplications();
    assert.equal(w.document.querySelectorAll('.application-row').length, 1);
    assert.equal($('.application-name-button').textContent, name);
  }
  $('#application-filter').value = 'all'; $('#application-search').value = 'APP-1'; w.renderApplications();
  assert.equal($('.application-name-button').textContent, 'Raycast');
  $('#application-search').value = 'missing'; w.renderApplications();
  assert.match($('#app-manager-list').textContent, /没有匹配的应用/);
});

test('viewing an application exposes its full identity and named authorized scope without an overflowing action menu', async t => {
  const { w, $ } = await setup(t, [app({ datasets: ['prod', 'dev'] })]);
  $('.application-row-actions [data-app-view]').click();
  assert.equal($('#app-details-modal').open, true);
  assert.match($('#app-details-content').textContent, /app-1/);
  assert.match($('#app-details-content').textContent, /支付\/商户/);
  assert.match($('#app-details-content').textContent, /研发\/工具/);
  assert.equal($('#app-manager-list details'), null);
  $('#details-authorize').click();
  assert.equal($('#app-details-modal').open, false);
  assert.equal($('#app-scope-modal').open, true);
});

test('dataset names open existing information without leaving application details; Escape closes the focused dialog first', async t => {
  const { w, $ } = await setup(t, [app({ datasets: ['prod', 'dev', 'deleted'] })]);
  w.stateForTest.datasets.forEach(dataset => Object.assign(dataset, { fields: [], identity_fields: [], record_count: 0, conflict_strategy: 'allow_mark' }));
  const info = $('#dataset-info-modal');
  info.showModal = function() { this.open = true; $('#close-dataset-info').focus(); };
  info.close = w.HTMLDialogElement.prototype.close;
  w.openAppDetails('app-1');
  const name = $('.application-dataset-link[data-dataset-id="prod"]');
  name.click();
  assert.equal(info.open, true);
  assert.equal($('#app-details-modal').open, true);
  assert.match($('#dataset-info-content').textContent, /支付\/商户/);
  assert.match($('#dataset-info-content').textContent, /记录数量/);
  assert.match($('#dataset-info-model-content').textContent, /尚未定义主表字段/);
  assert.match($('#dataset-info-model-content').textContent, /尚未定义附表字段/);
  assert.equal($('#app-details-content [data-dataset-id="deleted"]'), null);
  assert.equal(w.getComputedStyle($('.application-granted li:last-child')).borderBottomWidth, '0px');
  w.document.activeElement.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(info.open, false);
  assert.equal($('#app-details-modal').open, true);
  assert.equal(w.stateForTest.appViewing, 'app-1');
  assert.equal($('#dataset-info-content').textContent, '');
  assert.equal($('#dataset-info-title').textContent, '数据集信息');
  name.focus();
  name.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('#app-details-modal').open, false);
  assert.equal(w.stateForTest.appViewing, null);
});

test('editing an active authorization preserves its original expiry unless a new duration is chosen', async t => {
  const { w, requests, $ } = await setup(t);
  w.openAppScope('app-1');
  assert.equal($('#scope-ttl').value, 'keep');
  await w.saveAppScope();
  const patch = requests.find(r => r.options.method === 'PATCH');
  assert.deepEqual(JSON.parse(patch.options.body), { permission: 'search', datasets: ['prod'], disabled: false });
  assert.equal($('#app-scope-modal').open, false);
});

test('expired and disabled applications are explicitly reenabled with the selected new duration', async t => {
  const { w, requests, $ } = await setup(t, [app({ disabled: true, access_expires_at: 1 })]);
  w.openAppScope('app-1');
  assert.equal($('#scope-ttl').value, '1800');
  assert.equal($('#scope-keep-expiry').hidden, true);
  assert.equal($('#save-app-scope').textContent, '保存并启用');
  await w.saveAppScope();
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.disabled, false);
  assert.equal(body.access_ttl_seconds, 1800);
});

test('dataset filtering, selecting matches and clearing matches preserve hidden choices', async t => {
  const { w, $ } = await setup(t);
  w.openAppScope('app-1');
  $('#scope-search').value = '研发'; w.updateAppScope();
  $('#scope-select-visible').click();
  assert.equal($('#scope-datasets input[value="prod"]').checked, true);
  assert.equal($('#scope-datasets input[value="dev"]').checked, true);
  assert.equal($('#scope-datasets input[value="test"]').checked, true);
  $('#scope-search').value = 'dev'; w.updateAppScope();
  $('#scope-clear-visible').click();
  assert.equal($('#scope-datasets input[value="prod"]').checked, true);
  assert.equal($('#scope-datasets input[value="dev"]').checked, false);
  assert.equal($('#scope-datasets input[value="test"]').checked, true);
  $('#scope-only-selected').checked = true; $('#scope-search').value = ''; w.updateAppScope();
  assert.equal($('#scope-datasets input[value="dev"]').closest('label').hidden, true);
  assert.match($('#scope-count').textContent, /已选 2 \/ 3/);
});

test('creation submits name, scope, permission and duration together, then shows an identified one-time key', async t => {
  const { w, requests, $ } = await setup(t, []);
  w.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    return response(options.method === 'POST' ? { id: 'created-app', key: 'SYNTHETIC-ONE-TIME-KEY' } : { apps: [] });
  };
  $('#new-app-button').click();
  $('#scope-name').value = '  夜间同步  ';
  $('#scope-permission').value = 'secrets';
  $('#scope-datasets input[value="dev"]').checked = true;
  await w.saveAppScope();
  assert.equal(requests[0].url, '/api/apps');
  assert.deepEqual(JSON.parse(requests[0].options.body), { name: '夜间同步', permission: 'secrets', datasets: ['dev'], access_ttl_seconds: 1800 });
  assert.equal($('#app-scope-modal').open, false);
  assert.equal($('#app-key-modal').open, true);
  assert.equal($('#app-key-value').value, 'SYNTHETIC-ONE-TIME-KEY');
  assert.equal($('#app-key-id').textContent, 'created-app');
  $('#finish-app-key').click();
  assert.equal($('#app-key-value').value, '');
  assert.equal($('#app-key-id').textContent, '');
});

test('saving prevents duplicate requests and closing; failure preserves the editable draft', async t => {
  const { w, requests, $ } = await setup(t);
  let finish;
  w.fetch = (url, options = {}) => { requests.push({ url, options }); return new Promise(resolve => { finish = resolve; }); };
  w.openAppScope('app-1'); $('#scope-permission').value = 'secrets';
  const saving = w.saveAppScope();
  await w.saveAppScope(); w.closeAppScope();
  assert.equal(requests.length, 1);
  assert.equal($('#app-scope-modal').open, true);
  assert.equal($('#scope-permission').disabled, true);
  finish(response({ error: '保存失败，请重试' }, 500));
  await saving;
  assert.equal($('#scope-error').hidden, false);
  assert.equal($('#scope-permission').value, 'secrets');
  assert.equal($('#scope-permission').disabled, false);
  assert.equal($('#save-app-scope').disabled, false);
});

test('closing a dirty draft requires discarding it while searches alone do not dirty authorization', async t => {
  const { w, $ } = await setup(t);
  let confirmations = 0;
  w.confirm = () => { confirmations++; return false; };
  w.openAppScope('app-1'); $('#scope-search').value = 'dev'; w.updateAppScope(); w.closeAppScope();
  assert.equal(confirmations, 0);
  w.openAppScope('app-1'); $('#scope-permission').value = 'secrets'; w.closeAppScope();
  assert.equal(confirmations, 1);
  assert.equal($('#app-scope-modal').open, true);
});

test('late application responses cannot repopulate the list or expose credentials after sealing', async t => {
  const { w, $ } = await setup(t);
  let finish;
  w.openAppScope(); $('#scope-name').value = 'new';
  w.fetch = () => new Promise(resolve => { finish = resolve; });
  const saving = w.saveAppScope();
  await w.sealVault('测试封印', false);
  finish(response({ id: 'late', key: 'SHOULD-NOT-BE-SHOWN' }));
  await saving;
  assert.equal($('#app-key-modal').open, false);
  assert.equal($('#app-key-value').value, '');
  assert.equal($('#app-manager-list').textContent, '');
});

test('newer application fetch wins and untrusted names are displayed as text', async t => {
  const { w, $ } = await setup(t);
  const pending = [];
  w.fetch = () => new Promise(resolve => pending.push(resolve));
  const first = w.loadApps(), second = w.loadApps();
  pending[1](response({ apps: [app({ name: '<img src=x onerror=alert(1)>' })] })); await second;
  pending[0](response({ apps: [app({ name: 'stale' })] })); await first;
  assert.equal($('.application-name-button').textContent, '<img src=x onerror=alert(1)>');
  assert.equal($('#app-manager-list img'), null);
});

test('a completed save cannot overwrite a newer draft while its list refresh is pending', async t => {
  const { w, $ } = await setup(t);
  let finishRefresh;
  w.fetch = async (_url, options = {}) => options.method === 'PATCH' ? response({}) : new Promise(resolve => { finishRefresh = resolve; });
  w.openAppScope('app-1');
  const saving = w.saveAppScope();
  await settle();
  w.openAppScope();
  $('#scope-name').value = '新草稿';
  finishRefresh(response({ apps: [app()] }));
  await saving;
  assert.equal($('#app-scope-modal').open, true);
  assert.equal($('#scope-name').value, '新草稿');
  assert.equal($('#save-app-scope').textContent, '创建并生成密钥');
});

test('rotation and disabling have explicit confirmation and cannot act on a dismissed prompt', async t => {
  const { w, requests, $ } = await setup(t);
  w.openAppDetails('app-1'); w.confirm = () => false;
  await w.rotateApplicationKey(); await w.changeApplicationState();
  assert.equal(requests.length, 0);
  w.confirm = () => true;
  w.fetch = async (url, options = {}) => { requests.push({ url, options }); return response({ key: 'ROTATED-TEST-KEY' }); };
  await w.rotateApplicationKey();
  assert.equal(requests[0].url, '/api/apps/app-1/rotate');
  assert.equal($('#app-key-value').value, 'ROTATED-TEST-KEY');
  assert.equal($('#app-key-id').textContent, 'app-1');
  assert.equal($('#app-details-modal').open, false);
});

test('late credential rotation cannot leak a key or unset a new session operation after sealing', async t => {
  const { w, $ } = await setup(t);
  const pending = [];
  w.fetch = () => new Promise(resolve => pending.push(resolve));
  w.openAppDetails('app-1');
  const oldRotation = w.rotateApplicationKey();
  await w.sealVault('测试封印', false);
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, apps: [app()] });
  w.openAppDetails('app-1');
  assert.equal($('#details-rotate').disabled, false);
  const newRotation = w.rotateApplicationKey();
  pending[0](response({ key: 'OLD-SESSION-KEY' }));
  await oldRotation;
  assert.equal($('#app-key-value').value, '');
  assert.ok(w.stateForTest.appDetailBusy);
  pending[1](response({ key: 'NEW-SESSION-KEY' }));
  await newRotation;
  assert.equal($('#app-key-value').value, 'NEW-SESSION-KEY');
});
