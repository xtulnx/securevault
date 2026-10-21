const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));
const event = (id = 1, reason = 'expired') => ({ id, app_id: 'reader', app_name: '检索工具', reason, operation: 'search', first_at: 1700000000, last_at: 1700000001, count: 3, unread: true, ignored: false });
async function setup(t, events = [event()]) {
  const w = page(t, true); await w.initialStatusCheck;
  Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
  Object.assign(w.stateForTest, { unlocked: true, canManage: true, sessionId: 'current', workspace: 'apps', apps: [{ id: 'reader', name: '检索工具', permission: 'search', datasets: ['d'], disabled: false, access_expires_at: 1 }], datasets: [{ id: 'd', name: '合成数据', category_path: '回归', fields: [] }] });
  let summary = { revision: events.length, unread: events.length, muted: false };
  const requests = [];
  w.fetch = async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/vault/status') return response({ initialized: true, sealed: false, persistent: false, can_manage: true, session_id: 'current', authorization_notice: summary });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      for (const item of events) { if (body.seen_ids?.includes(item.id)) item.unread = false; if (body.ignore_id === item.id) { item.ignored = true; item.unread = false; } }
      summary = { revision: summary.revision + 1, muted: body.muted ?? summary.muted, unread: 0 };
      summary.unread = summary.muted ? 0 : events.filter(item => item.unread && !item.ignored).length;
      return response({ session_id: 'current', summary });
    }
    return response({ session_id: 'current', summary, events: structuredClone(events) });
  };
  return { w, $: selector => w.document.querySelector(selector), requests, events };
}
test('locked or offline home can switch themes with native keyboard buttons and persists the shared preference', async t => {
  const w = page(t, true); await w.initialStatusCheck;
  const button = w.document.querySelector('#sealed-theme-toggle');
  assert.equal(button.type, 'button');
  assert.equal(button.closest('#sealed-screen'), null);
  assert.notEqual(w.getComputedStyle(button).display, 'none');
  w.applyTheme('light'); button.focus(); button.click();
  assert.equal(w.document.documentElement.dataset.theme, 'dark');
  assert.equal(w.localStorage.getItem('securevault-theme'), 'dark');
  assert.equal(button.getAttribute('aria-label'), '切换为浅色主题');
  assert.equal(w.document.querySelector('#theme-toggle').getAttribute('aria-label'), '切换为浅色主题');
  w.document.querySelector('#app').classList.add('is-unsealed');
  assert.equal(w.getComputedStyle(button).display, 'none');
});
test('owner notice updates the red dot accessibly without a toast or an extra background request', async t => {
  const { w, $, requests } = await setup(t);
  w.stateForTest.workspace = 'search';
  w.syncAuthorizationNotice({ revision: 1, unread: 2, muted: false });
  assert.equal($('#authorization-notice-dot').hidden, false);
  assert.match($('#app-manager-button').getAttribute('aria-label'), /2 类新/);
  assert.equal(requests.length, 0);
  w.syncAuthorizationNotice({ revision: 0, unread: 0, muted: false });
  assert.equal($('#authorization-notice-dot').hidden, false, 'stale summaries cannot erase a newer notice');
});
test('only visible event groups are marked read; remaining groups keep their badge until expanded', async t => {
  const { w, $, requests } = await setup(t, Array.from({ length: 10 }, (_, i) => event(i + 1)));
  await w.loadAuthorizationEvents();
  assert.equal(w.document.querySelectorAll('.authorization-event').length, 8);
  assert.deepEqual(JSON.parse(requests[1].options.body), { session_id: 'current', seen_ids: [1,2,3,4,5,6,7,8] });
  assert.equal(w.stateForTest.authorizationNotice.unread, 2);
  assert.equal($('#authorization-events-more').hidden, false);
  $('#authorization-events-more').click(); await settle();
  assert.equal(w.document.querySelectorAll('.authorization-event').length, 10);
  assert.equal(w.stateForTest.authorizationNotice.unread, 0);
});
test('background pages and leaving the workspace do not acknowledge events', async t => {
  const { w, requests } = await setup(t);
  Object.defineProperty(w.document, 'hidden', { value: true, configurable: true });
  await w.loadAuthorizationEvents();
  assert.equal(requests.length, 1);
  Object.defineProperty(w.document, 'hidden', { value: false, configurable: true });
  w.stateForTest.workspace = 'search';
  await w.loadAuthorizationEvents();
  assert.equal(requests.length, 2);
});
test('reason-specific actions open existing authorization controls without granting permissions automatically', async t => {
  for (const [reason, focus] of [['expired', '#scope-ttl'], ['secrets_permission', '#scope-permission'], ['no_datasets', '#scope-search'], ['dataset_scope', '#scope-search']]) {
    const { w, $, requests } = await setup(t, [event(1, reason)]);
    await w.loadAuthorizationEvents();
    $('[data-auth-action="configure"]').click();
    assert.equal($('#app-scope-modal').open, true);
    assert.equal(w.document.activeElement, $(focus));
    assert.equal($('#scope-permission').value, 'search');
    assert.equal($('#scope-datasets input').checked, true);
    assert.equal(requests.filter(request => request.options.method === 'PATCH').length, 0);
  }
});
test('owner-only interfaces explain that application authorization cannot grant management access', async t => {
  const { w, $ } = await setup(t, [event(1, 'owner_required')]);
  await w.loadAuthorizationEvents();
  assert.equal($('[data-auth-action="configure"]'), null);
  assert.match($('#authorization-events-list').textContent, /应用授权无法开放此接口/);
  $('[data-auth-action="view"]').click();
  assert.equal($('#app-details-modal').open, true);
});
test('ignoring a grouped event and muting the session are explicit, separate choices', async t => {
  const { w, $, requests } = await setup(t);
  await w.loadAuthorizationEvents();
  $('[data-auth-action="ignore"]').click(); await settle();
  assert.match($('#authorization-events-list').textContent, /已忽略此类/);
  assert.equal($('[data-auth-action="ignore"]'), null);
  assert.equal(w.document.activeElement, $('#authorization-events-status'));
  $('#authorization-mute').click(); await settle();
  assert.equal($('#authorization-mute').getAttribute('aria-pressed'), 'true');
  assert.match($('#authorization-events-status').textContent, /事件仍会记录/);
  assert.equal($('#authorization-notice-dot').hidden, true);
  assert.equal(requests.some(request => request.url !== '/api/apps/authorization-events'), false);
  $('#authorization-mute').click(); await settle();
  assert.equal($('#authorization-mute').getAttribute('aria-pressed'), 'false');
});
test('deleted apps remain readable with no broken edit path and untrusted names render as text', async t => {
  const entry = event(); entry.app_name = '<img src=x onerror=alert(1)>'; entry.app_id = 'deleted';
  const { w, $ } = await setup(t, [entry]);
  await w.loadAuthorizationEvents();
  assert.equal($('#authorization-events-list img'), null);
  assert.match($('#authorization-events-list').textContent, /<img src=x/);
  assert.match($('#authorization-events-list').textContent, /应用已删除/);
  assert.equal($('[data-auth-action="configure"]'), null);
});
test('late event responses cannot repopulate the page after sealing or session rotation', async t => {
  const { w, $ } = await setup(t);
  let resolve;
  w.fetch = () => new Promise(done => { resolve = done; });
  const loading = w.loadAuthorizationEvents();
  await w.sealVault('test', false);
  resolve(response({ session_id: 'current', summary: { revision: 1, unread: 1 }, events: [event()] }));
  await loading;
  assert.equal($('#authorization-events-list').textContent, '');
  assert.equal($('#authorization-notice-dot').hidden, true);
  assert.equal(w.stateForTest.authorizationEvents.length, 0);
});
test('a response for another server session cannot expose events in this session', async t => {
  const { w, $ } = await setup(t);
  w.fetch = async () => response({ session_id: 'another', summary: { revision: 1, unread: 1 }, events: [event()] });
  await w.loadAuthorizationEvents();
  assert.equal($('#authorization-events-list').textContent, '');
});
test('event and reminder failures preserve the badge and provide an inline retry path', async t => {
  const { w, $ } = await setup(t);
  w.stateForTest.workspace = 'search';
  w.syncAuthorizationNotice({ revision: 1, unread: 1 });
  w.stateForTest.workspace = 'apps';
  w.fetch = async () => response({ error: '合成故障' }, 500);
  await w.loadAuthorizationEvents();
  assert.equal($('#authorization-events-error').hidden, false);
  assert.match($('#authorization-events-error').textContent, /刷新重试/);
  assert.equal($('#authorization-notice-dot').hidden, false);
  await w.changeAuthorizationReminder({ muted: true });
  assert.match($('#authorization-events-error').textContent, /设置未保存/);
  assert.equal($('#authorization-mute').disabled, false);
  assert.equal($('#authorization-notice-dot').hidden, false);
});
test('events behind a modal stay unread and returning to a visible application page acknowledges them', async t => {
  const { w, requests } = await setup(t);
  w.openAppScope('reader');
  await w.loadAuthorizationEvents();
  assert.equal(requests.length, 0);
  assert.equal(w.stateForTest.authorizationEvents.length, 0);
  w.closeAppScope(true);
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await settle();
  assert.equal(requests.filter(request => request.options.method === 'POST').length, 1);
  assert.equal(w.stateForTest.authorizationNotice.unread, 0);
});
test('closing an event configuration returns focus to its current event action', async t => {
  const { w, $ } = await setup(t);
  await w.loadAuthorizationEvents();
  $('[data-auth-action="configure"]').focus();
  $('[data-auth-action="configure"]').click();
  w.renderAuthorizationEvents();
  w.closeAppScope(true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(w.document.activeElement, $('[data-auth-action="configure"]'));
});
test('a list fetch started before ignore cannot restore the old event snapshot', async t => {
  const { w, $ } = await setup(t);
  await w.loadAuthorizationEvents();
  let finish;
  w.fetch = async (_url, options = {}) => options.method === 'POST'
    ? response({ session_id: 'current', summary: { revision: 3, unread: 0, muted: false } })
    : new Promise(resolve => { finish = resolve; });
  const loading = w.loadAuthorizationEvents();
  await w.changeAuthorizationReminder({ ignore_id: 1 });
  finish(response({ session_id: 'current', summary: { revision: 1, unread: 1, muted: false }, events: [event()] }));
  await loading;
  assert.match($('#authorization-events-list').textContent, /已忽略此类/);
  assert.equal($('#authorization-notice-dot').hidden, true);
  assert.equal(w.stateForTest.authorizationEventsBusy, false);
});
