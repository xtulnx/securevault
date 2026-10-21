const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, values = {code: 'A-000', enabled: false}) {
  const w = page(t, true); await w.initialStatusCheck;
  const d = w.document, state = w.stateForTest;
  Object.assign(state, {unlocked:true,canManage:true,datasets:[],workspace:'search'});
  d.querySelector('#record-detail-content').innerHTML = w.detailRows(values);
  return {w,d,state,buttons:[...d.querySelectorAll('.field-copy')]};
}
function clipboard(w, writeText) { Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText}}); }

test('copy icons retain native button semantics, names and tooltips without extra tab stops',async t=>{
  const {w,d,buttons}=await setup(t,{'<img src=x>':'safe'});const [button]=buttons;
  assert.equal(button.type,'button');assert.equal(button.tabIndex,0);
  assert.equal(button.getAttribute('aria-label'),'复制 <img src=x>');assert.equal(button.title,'复制 <img src=x>');
  assert.equal(button.querySelector('svg').getAttribute('aria-hidden'),'true');assert.equal(button.querySelector('svg').getAttribute('focusable'),'false');
  assert.equal(button.querySelector('.field-copy-hint').textContent,'复制');assert.equal(button.querySelector('.field-copy-hint').getAttribute('aria-hidden'),'true');assert.equal(button.querySelector('img'),null);
  assert.equal(w.getComputedStyle(button).display,'inline-flex');assert.equal(w.getComputedStyle(button).visibility,'visible');
  assert.equal(button.getAttribute('tabindex'),null);
  assert.equal(d.querySelector('.detail-public-value').textContent.includes('safe'),true);
});

test('pending clipboard writes preserve focus, block duplicates and restore the icon after success',async t=>{
  const {w,d,buttons}=await setup(t);const [button]=buttons;let finish,copies=0,expire;
  const timeout=w.setTimeout;
  w.setTimeout=(callback,delay)=>delay===2500?(expire=callback,1):timeout(callback,delay);
  clipboard(w,()=>{copies++;return new Promise(resolve=>{finish=resolve;});});
  const markup=button.innerHTML;button.focus();button.click();button.click();
  assert.equal(copies,1);assert.equal(d.activeElement,button);assert.equal(button.disabled,false);
  assert.equal(button.getAttribute('aria-disabled'),'true');assert.equal(button.getAttribute('aria-busy'),'true');assert.equal(button.dataset.copyState,'busy');
  finish();await tick();assert.equal(d.activeElement,button);assert.equal(button.getAttribute('aria-disabled'),null);
  assert.equal(button.dataset.copyState,'success');assert.equal(button.querySelector('.field-copy-hint').textContent,'已复制');assert.match(button.getAttribute('aria-label'),/复制 code，已复制/);
  assert.match(button.nextElementSibling.textContent,/复制 code.*已复制/);
  expire();assert.equal(button.innerHTML,markup);assert.equal(button.title,'复制 code');assert.equal(button.querySelector('.field-copy-hint').textContent,'复制');assert.equal(button.dataset.copyState,undefined);
  assert.equal(d.activeElement,button);assert.equal(button.getAttribute('aria-label'),'复制 code');assert.equal(d.querySelector('.copy-feedback'),null);
});

test('failure keeps a retry hint and live status until retry succeeds without changing layout',async t=>{
  const {w,d,buttons}=await setup(t);const [button]=buttons;let timers=0;
  const timeout=w.setTimeout;w.setTimeout=(callback,delay)=>{if(delay===2500)timers++;return timeout(callback,delay);};
  clipboard(w,async()=>{throw new Error('Permission denied');});button.focus();button.click();await tick();
  assert.equal(button.dataset.copyState,'error');assert.equal(button.querySelector('.field-copy-hint').textContent,'重试复制');assert.equal(timers,0);
  assert.equal(button.disabled,false);assert.equal(d.activeElement,button);assert.match(button.getAttribute('aria-label'),/复制失败，可重试/);
  assert.match(button.nextElementSibling.textContent,/手动选择文本/);assert.equal(button.nextElementSibling.getAttribute('role'),'status');assert.ok(button.querySelector('svg'));
  let copied;clipboard(w,async text=>{copied=text;});button.click();await tick();assert.equal(copied,'A-000');assert.equal(button.dataset.copyState,'success');assert.equal(timers,1);
  assert.equal(d.querySelectorAll('.copy-feedback').length,1);
});

test('closing detail prevents late clipboard feedback from returning and clears persistent failures',async t=>{
  const {w,d,buttons}=await setup(t);const [button]=buttons;let finish;
  clipboard(w,()=>new Promise(resolve=>{finish=resolve;}));button.click();w.closeRecordDetail();finish();await tick();
  assert.equal(d.querySelector('#record-detail-content').textContent,'');assert.equal(d.querySelector('.copy-feedback'),null);
  assert.equal(button.getAttribute('aria-disabled'),null);assert.equal(button.dataset.copyState,undefined);assert.ok(button.querySelector('svg'));
});

test('tab switches clear field feedback without clearing an unrelated application key action',async t=>{
  const {w,d,buttons}=await setup(t);const [button]=buttons;
  d.querySelector('#record-detail-tabs').innerHTML='<button data-detail-tab="overview"></button><button data-detail-tab="supplement"></button>';
  clipboard(w,async()=>{throw new Error('denied');});button.click();await tick();
  const key=d.querySelector('#copy-app-key');await w.copyWithFeedback(key,'SYNTHETIC-ONLY');
  assert.equal(d.querySelectorAll('.copy-feedback').length,2);
  w.selectDetailTab('supplement');assert.equal(button.dataset.copyState,undefined);
  assert.equal(d.querySelectorAll('.copy-feedback').length,1);assert.match(key.nextElementSibling.textContent,/复制失败/);
  w.clearCopyFeedback();assert.equal(d.querySelectorAll('.copy-feedback').length,0);
});
