const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

const status = (idle = 1800, ttl = 21600, id = 'owner-session') => ({
  initialized: true, sealed: false, can_manage: true, persistent: false,
  session_id: id, idle_seconds_remaining: idle, ttl_seconds_remaining: ttl,
  idle_timeout_seconds: 1800, max_session_seconds: 21600, warning_seconds: 600,
});
const response = body => ({ ok: true, status: 200, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, initial = status()) {
  const w = page(t, true);
  await w.initialStatusCheck;
  let now = 100000;
  w.performance.now = () => now;
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: false });
  w.stateForTest.unlocked = true;
  w.syncSession(initial);
  const requests = [];
  w.fetch = async (url, options) => {
    requests.push({ url, options });
    return response(initial);
  };
  let watchdog;
  w.setInterval = (callback, delay) => {
    assert.equal(delay, 1000);
    watchdog = callback;
    return 1;
  };
  w.startWatchdog();
  return {
    w, requests, advance: ms => { now += ms; },
    watchdog: () => watchdog(),
    tick: async () => { watchdog(); await settle(); },
  };
}

test('idle warnings start at ten minutes, and real input clears them without extending the hard limit', async t => {
  const { w, requests, advance, tick } = await setup(t);
  const countdown = w.document.querySelector('#idle-countdown');
  assert.equal(countdown.hidden, true);
  advance(1199000);
  w.updateSessionIndicator();
  assert.equal(countdown.hidden, true);
  advance(1000);
  w.updateSessionIndicator();
  assert.equal(countdown.hidden, false);
  assert.equal(countdown.textContent, '空闲锁定 10:00');
  const originalUnlock = w.stateForTest.unlockAt;
  w.fetch = async (url, options) => {
    requests.push({ url, options });
    return response(status(1800, 20400));
  };
  w.touch({ isTrusted: true, type: 'keydown' });
  assert.equal(countdown.hidden, false);
  assert.equal(requests.length, 0);
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/vault/activity');
  assert.equal(countdown.hidden, true);
  assert.equal(w.stateForTest.unlockAt, originalUnlock);
});

test('six hour warnings remain while active, and warn about saving work', async t => {
  const { w, tick } = await setup(t, status(1800, 600));
  w.stateForTest.persistent = true;
  w.syncSession(status(1800, 600));
  assert.equal(w.stateForTest.persistent, false);
  const countdown = w.document.querySelector('#idle-countdown');
  assert.equal(countdown.textContent, '解锁时限 10:00');
  assert.match(countdown.closest('.session-pill').title, /保存修改/);
  w.touch({ isTrusted: true, type: 'input' });
  await tick();
  assert.equal(countdown.hidden, false);
  assert.equal(countdown.textContent, '解锁时限 10:00');
});

test('real activity is throttled and the final event is flushed with its actual age', async t => {
  const { w, requests, advance, tick } = await setup(t);
  w.touch({ isTrusted: true, type: 'pointerdown' });
  await tick();
  advance(1000);
  w.touch({ isTrusted: true, type: 'input' });
  w.touch({ isTrusted: true, type: 'pointermove' });
  assert.equal(requests.length, 1);
  advance(14000);
  await tick();
  assert.equal(requests.length, 2);
  assert.deepEqual(JSON.parse(requests[1].options.body), { session_id: 'owner-session', idle_ms: 14000 });
  advance(15000);
  await tick();
  assert.equal(requests.length, 2, 'timers without new input never renew the session');
});

test('input bursts only record time while each watchdog tick renders once and reports stay throttled', async t => {
  const { w, requests, advance, tick } = await setup(t, status(600));
  const countdown = w.document.querySelector('#idle-countdown');
  const render = w.updateSessionIndicator;
  let renders = 0;
  w.updateSessionIndicator = () => { renders++; render(); };
  const query = w.document.querySelector.bind(w.document);
  let queries = 0;
  w.document.querySelector = selector => { queries++; return query(selector); };
  const burst = () => {
    for (let i = 0; i < 1000; i++) {
      advance(0.2);
      w.touch({ isTrusted: true, type: ['pointermove', 'keydown', 'wheel', 'touchmove'][i % 4] });
    }
  };
  burst();
  assert.equal(w.stateForTest.activityAt, w.performance.now());
  assert.equal(renders, 0);
  assert.equal(queries, 0, 'input handlers never query or update interface elements');
  assert.equal(requests.length, 0);
  assert.equal(countdown.textContent, '空闲锁定 10:00');
  await tick();
  assert.equal(renders, 1, 'the async report response does not trigger another render');
  assert.equal(countdown.hidden, true);
  assert.equal(requests.length, 1);
  advance(1000);
  burst();
  await tick();
  assert.equal(renders, 2);
  assert.equal(requests.length, 1);
  advance(14000);
  await tick();
  assert.equal(renders, 3);
  assert.equal(requests.length, 2);
  const { idle_ms } = JSON.parse(requests[1].options.body);
  assert.ok(idle_ms >= 13999 && idle_ms <= 14001, 'the trailing report retains the last actual input age');
});

test('synthetic events, hidden pages, normal API calls, polling, focus and visibility do not renew idle time', async t => {
  const { w, requests } = await setup(t);
  const original = w.stateForTest.lastActivity;
  w.touch({ isTrusted: false });
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a' }));
  Object.defineProperty(w.document, 'hidden', { configurable: true, value: true });
  w.touch({ isTrusted: true });
  await w.api('/records/search');
  await w.checkStatus();
  w.dispatchEvent(new w.Event('focus'));
  w.document.dispatchEvent(new w.Event('visibilitychange'));
  await settle();
  assert.equal(w.stateForTest.lastActivity, original);
  assert.equal(requests.filter(r => r.url.endsWith('/vault/activity')).length, 0);
});

test('server status synchronizes another tab activity and a stale watchdog cannot seal that session', async t => {
  const { w, requests, advance, tick } = await setup(t, status(1));
  advance(2000);
  w.fetch = async (url, options) => { requests.push({ url, options }); return response(status(1795, 21598)); };
  await tick();
  assert.equal(w.stateForTest.unlocked, true);
  await tick();
  assert.equal(w.document.querySelector('#idle-countdown').hidden, true);
  assert.ok(w.sessionRemaining().seconds >= 1794);
  assert.equal(requests.some(r => r.url.endsWith('/vault/seal')), false);
});

test('a server expired session clears sensitive page data without sending a global seal request', async t => {
  const { w, requests } = await setup(t);
  w.stateForTest.records = [{ secret: 'cached' }];
  w.fetch = async (url, options) => {
    requests.push({ url, options });
    return response({ initialized: true, sealed: true, can_manage: false, persistent: false });
  };
  await w.checkStatus();
  assert.equal(w.stateForTest.unlocked, false);
  assert.equal(w.stateForTest.records.length, 0);
  assert.equal(requests.some(r => r.url.endsWith('/vault/seal')), false);
});

test('in-flight activity and status responses cannot overwrite a freshly unlocked session', async t => {
  const { w, watchdog } = await setup(t);
  let finishActivity, finishStatus;
  w.fetch = url => new Promise(resolve => {
    if (url.endsWith('/vault/activity')) finishActivity = resolve;
    else finishStatus = resolve;
  });
  w.touch({ isTrusted: true });
  watchdog();
  const pendingStatus = w.checkStatus();
  w.syncSession(status(1800, 21600, 'new-session'));
  finishActivity(response(status(1, 1)));
  finishStatus(response({ initialized: true, sealed: true, persistent: false }));
  await pendingStatus;
  await settle();
  assert.equal(w.stateForTest.unlocked, true);
  assert.equal(w.stateForTest.sessionId, 'new-session');
  assert.equal(w.document.querySelector('#idle-countdown').hidden, true);
});

test('system clock changes do not interrupt input reporting or alter local session deadlines', async t => {
  const { w, requests, advance, tick } = await setup(t);
  const original = w.stateForTest.unlockAt;
  w.Date.now = () => 0;
  w.touch({ isTrusted: true });
  await tick();
  advance(15000);
  w.Date.now = () => 99999999999999;
  w.touch({ isTrusted: true });
  await tick();
  assert.equal(requests.length, 2);
  assert.ok(w.stateForTest.unlockAt <= original + 15000);
  assert.equal(w.document.querySelector('#idle-countdown').hidden, true);
});

test('sleep cannot turn an old unreported input into a fresh interaction', async t => {
  const { w, requests, advance, tick } = await setup(t);
  let wall = 1000000;
  w.Date.now = () => wall;
  w.touch({ isTrusted: true });
  await tick();
  advance(1000);
  wall += 1000;
  w.touch({ isTrusted: true });
  advance(15000);
  wall += 1800000;
  await tick();
  assert.equal(requests.length, 1, 'the pending input predates the entire idle timeout');
});

test('fresh input after sleep is reported on the next tick even when the monotonic clock paused', async t => {
  const { w, requests, advance, tick } = await setup(t);
  let wall = 1000000;
  w.Date.now = () => wall;
  w.touch({ isTrusted: true });
  await tick();
  advance(1000);
  wall += 29 * 60000;
  w.touch({ isTrusted: true });
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(JSON.parse(requests[1].options.body).idle_ms, 0);
});

test('a stalled activity report times out and clears the local unlocked view', async t => {
  const { w, watchdog } = await setup(t);
  let timeout;
  w.setTimeout = callback => { timeout = callback; return 1; };
  w.clearTimeout = () => {};
  w.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  w.touch({ isTrusted: true });
  assert.equal(w.stateForTest.activityRequest, false);
  watchdog();
  assert.equal(w.stateForTest.activityRequest, true);
  timeout();
  await settle();
  assert.equal(w.stateForTest.activityRequest, false);
  assert.equal(w.stateForTest.unlocked, false);
});
