const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');

function harness(fetch) {
  const elements = new Map();
  const badges = [0, 1].map(() => ({ dataset: {}, label: {}, querySelector() { return this.label; } }));
  const timers = new Map();
  const messages = [];
  let timerId = 0;
  const context = vm.createContext({
    fetch, AbortController,
    localStorage: { getItem: () => null },
    document: {
      addEventListener() {},
      querySelector(selector) {
        if (!elements.has(selector)) elements.set(selector, {
          lastChild: {}, classList: {
            values: new Set(),
            add(value) { this.values.add(value); },
            remove(value) { this.values.delete(value); },
            has(value) { return this.values.has(value); },
          },
          close() {}, replaceChildren() { this.cleared = true; },
        });
        return elements.get(selector);
      },
      querySelectorAll: () => badges,
    },
    setTimeout(callback) { timers.set(++timerId, callback); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval() {},
    closeRecordDetail() {}, showWorkspace() {},
    renderDatasetActions() {},
    showToastForTest: (message) => messages.push(message),
  });
  // Load the application functions without attaching the page's event handlers.
  vm.runInContext(source.slice(0, source.indexOf('function startWatchdog(')), context);
  vm.runInContext('showToast = showToastForTest;', context);
  return {
    check: () => vm.runInContext('checkStatus()', context),
    run: (code) => vm.runInContext(code, context),
    badges, elements, timers, messages,
  };
}

const response = (body = { initialized: true, sealed: true, persistent: false }, status = 200) => ({
  ok: status < 400, status, json: async () => body,
});

test('stopping and restarting the service updates both badges and unlock availability', async () => {
  let running = true;
  const app = harness(async (url, options) => {
    assert.equal(url, '/api/vault/status');
    assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    if (!running) throw new TypeError('Failed to fetch');
    return response();
  });
  for (const online of [true, false, true]) {
    running = online;
    await app.check();
    for (const badge of app.badges) {
      assert.equal(badge.dataset.serviceStatus, online ? 'online' : 'offline');
      assert.equal(badge.label.textContent, online ? '服务在线' : '服务离线');
    }
    assert.equal(app.elements.get('.unlock-button').disabled, !online);
    assert.equal(app.timers.size, 0);
    assert.equal(app.messages.length, 0);
  }
});

test('503 after unlock immediately seals the page and clears cached records, then recovers online', async () => {
  let stopped = true;
  const requests = [];
  const app = harness(async (url) => {
    requests.push(url);
    return stopped ? response({ error: 'unavailable' }, 503) : response();
  });
  app.run('state.unlocked = true; state.records = [{ secret: "cached" }]; state.datasets = [{}];');
  // A normal API operation must handle disconnects without waiting for a heartbeat.
  await assert.rejects(app.run('api("/records")'));
  assert.equal(app.run('state.unlocked'), false);
  assert.equal(app.run('state.records.length'), 0);
  assert.equal(app.run('state.datasets.length'), 0);
  assert.equal(app.elements.get('#records-grid').cleared, true);
  assert.equal(app.elements.get('#reveal-modal').hidden, true);
  assert.equal(app.elements.get('#app-manager-modal').hidden, true);
  assert.ok(app.elements.get('#app').classList.has('is-sealed'));
  assert.equal(app.badges[0].dataset.serviceStatus, 'offline');
  assert.equal(app.elements.get('.unlock-button').disabled, true);
  await app.check();
  assert.equal(app.messages.length, 1);
  stopped = false;
  await app.check();
  assert.equal(app.badges[0].dataset.serviceStatus, 'online');
  assert.equal(app.elements.get('.unlock-button').disabled, false);
  assert.equal(app.run('state.unlocked'), false);
  assert.ok(!requests.includes('/api/vault/seal'));
});

test('heartbeat seals an unlocked page on connection failure or timeout', async () => {
  for (const stalled of [false, true]) {
    const app = harness(async (_url, { signal }) => {
      if (!stalled) throw new TypeError('Failed to fetch');
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    app.run('state.unlocked = true;');
    const pending = app.check();
    if (stalled) [...app.timers.values()][0]();
    await pending;
    assert.equal(app.run('state.unlocked'), false);
    assert.equal(app.badges[0].dataset.serviceStatus, 'offline');
    assert.equal(app.messages.length, 1);
  }
});

test('a restarted service with a sealed session clears a stale unlocked view even without a failed heartbeat', async () => {
  const app = harness(async () => response());
  app.run('state.unlocked = true;');
  await app.check();
  assert.equal(app.run('state.unlocked'), false);
  assert.equal(app.badges[0].dataset.serviceStatus, 'online');
  assert.equal(app.messages.length, 1);
});

test('503 and invalid successful responses never report online', async () => {
  for (const result of [response({ error: 'unavailable' }, 503), response({}), response(null)]) {
    const app = harness(async () => result);
    await app.check();
    assert.equal(app.badges[0].dataset.serviceStatus, 'offline');
  }
});

test('a stalled request times out, does not overlap, and can recover', async () => {
  let calls = 0;
  const app = harness(async (_url, { signal }) => {
    calls++;
    if (calls > 1) return response();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  });
  const pending = app.check();
  await app.check();
  assert.equal(calls, 1);
  [...app.timers.values()][0]();
  await pending;
  assert.equal(app.badges[0].dataset.serviceStatus, 'offline');
  await app.check();
  assert.equal(app.badges[0].dataset.serviceStatus, 'online');
  assert.equal(calls, 2);
});
