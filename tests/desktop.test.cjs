const test = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');

test('desktop downloads pass bytes to the native picker and preserve cancellation', async t => {
  const window = page(t, true);
  window.__SECUREVAULT_DESKTOP__ = true;
  const calls = [];
  window.__TAURI__ = { core: { invoke: async (command, args) => { calls.push({ command, args }); return false; } } };
  const blob = { size: 3, arrayBuffer: async () => Uint8Array.from([0, 127, 255]).buffer };
  assert.equal(await window.saveDownload(blob, 'export.xlsx'), false);
  assert.equal(calls[0].command, 'desktop_save');
  assert.equal(calls[0].args.name, 'export.xlsx');
  assert.deepEqual(Array.from(calls[0].args.bytes), [0, 127, 255]);
  await assert.rejects(window.saveDownload({ size: 65 * 1024 * 1024 }, 'too-large'), /64 MiB/);
  assert.equal(calls.length, 1);
});

test('copy uses native IPC only in desktop and preserves browser clipboard behavior', async t => {
  const window = page(t, true), calls = [];
  window.navigator.clipboard = { writeText: async value => calls.push(['browser', value]) };
  await window.copyText('browser value');
  window.__SECUREVAULT_DESKTOP__ = true;
  window.__TAURI__ = { core: { invoke: async (command, args) => calls.push([command, args.text]) } };
  await window.copyText('desktop value');
  assert.deepEqual(calls, [['browser', 'browser value'], ['desktop_copy', 'desktop value']]);
});

test('native close reports unsaved state and active exports without discarding edits', async t => {
  const window = page(t, true), calls = [];
  await window.initialStatusCheck;
  window.__SECUREVAULT_DESKTOP__ = true;
  window.__TAURI__ = { core: { invoke: async (command, args) => calls.push([command, args.dirty]) } };
  window.stateForTest.unlocked = true;
  window.stateForTest.editorDirty = true;
  window.secureVaultRequestClose();
  assert.equal(window.stateForTest.editorDirty, true);
  window.stateForTest.editorDirty = false;
  window.stateForTest.exportBusy = true;
  window.secureVaultRequestClose();
  window.stateForTest.exportBusy = false;
  window.secureVaultRequestClose();
  assert.deepEqual(calls, [['desktop_close', true], ['desktop_close', true], ['desktop_close', false]]);
});

test('directory entries remain hidden in browsers; native selection reports drafts without clearing them', async t => {
  const window = page(t, true), calls = [];
  await window.initialStatusCheck;
  assert.ok([...window.document.querySelectorAll('[data-desktop-only]')].every(element => element.hidden));
  await window.secureVaultSelectDirectory(true);
  assert.equal(calls.length, 0);
  window.__SECUREVAULT_DESKTOP__ = true;
  window.__TAURI__ = { core: { invoke: async (command, args) => { calls.push([command, args]); } } };
  window.stateForTest.unlocked = true;
  window.stateForTest.editorDirty = true;
  await window.secureVaultSelectDirectory(true);
  assert.equal(window.stateForTest.editorDirty, true);
  assert.equal(calls[0][0], 'desktop_select_directory');
  assert.equal(calls[0][1].existingOnly, true);
  assert.equal(calls[0][1].dirty, true);
  window.stateForTest.editorDirty = false;
  await window.secureVaultSelectDirectory(false);
  assert.equal(calls[1][1].existingOnly, false);
  assert.equal(calls[1][1].dirty, false);
  window.document.querySelector('#desktop-directory-dialog').showModal();
  window.__TAURI__.core.invoke = async () => { throw new Error('目标保险库正在使用'); };
  window.stateForTest.editorDirty = true;
  await window.secureVaultSelectDirectory(true);
  const error = window.document.querySelector('#desktop-directory-error');
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /目标保险库正在使用/);
  assert.equal(window.stateForTest.editorDirty, true);
});
