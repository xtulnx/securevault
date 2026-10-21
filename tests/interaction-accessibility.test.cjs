const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const fields = [{source_key:'code',display_name:'编号',zone:'indexes',position:0},{source_key:'memo',display_name:'备注',zone:'normal',position:1}];
async function setup(t) {
  const w=page(t,true); await w.initialStatusCheck;
  const d=w.document, state=w.stateForTest;
  const record={id:'rec',dataset_id:'a',indexes:{code:'A-000'},display:{},normal:{memo:'备注'},protected_fields:[],supplement_records:[]};
  Object.assign(state,{unlocked:true,canManage:true,workspace:'search',datasets:[{id:'a',name:'回归数据',category_path:'回归',fields,identity_fields:['code'],list_fields:[]}],records:[record],catalog:{schemas:[],environments:[]}});
  w.api=async route=>route==='/saved-queries'?{queries:[]}:route==='/records/rec'?record:{records:[record],total:1,page:1};
  w.renderRecords();
  return {w,d,state};
}
function key(w,element,key,shiftKey=false) {
  const event=new w.KeyboardEvent('keydown',{key,shiftKey,bubbles:true,cancelable:true});element.dispatchEvent(event);return event;
}
test('modal tab stops exclude collapsed settings, inactive tabs, CSS-hidden and disabled controls',async t=>{
  const {w,d}=await setup(t);await w.openManualRecord('main','a','rec');await tick();
  const modal=d.querySelector('#manual-record-modal');
  const row=modal.querySelector('.manual-field'), options=row.querySelector('details');
  assert.ok(!w.overlayTabStops(modal).includes(row.querySelector('.manual-type')));
  options.open=true;assert.ok(w.overlayTabStops(modal).includes(row.querySelector('.manual-type')));
  options.open=false;
  const sample=d.createElement('div');sample.innerHTML='<a href="#">链接</a><button tabindex="-1">非顺序按钮</button><button style="display:none">隐藏</button><fieldset disabled><button>禁用</button></fieldset><div style="visibility:hidden"><button>不可见</button></div>';
  modal.querySelector('section').append(sample);
  const stops=w.overlayTabStops(modal);
  assert.ok(stops.includes(sample.querySelector('a')));assert.ok([...sample.querySelectorAll('button')].every(button=>!stops.includes(button)));
  await w.openRecordDetail('rec');
  assert.equal(w.overlayTabStops(d.querySelector('#record-detail-modal')).filter(el=>el.getAttribute('role')==='tab').length,1);
});
test('modal Tab and Shift+Tab loop over the actual available controls',async t=>{
  const {w,d}=await setup(t);await w.openManualRecord('main','a','rec');await tick();
  const modal=d.querySelector('#manual-record-modal'),stops=w.overlayTabStops(modal),first=stops[0],last=stops.at(-1);
  first.focus();assert.equal(key(w,first,'Tab',true).defaultPrevented,true);assert.equal(d.activeElement,last);
  last.focus();assert.equal(key(w,last,'Tab').defaultPrevented,true);assert.equal(d.activeElement,first);
  d.body.tabIndex=-1;d.body.focus();assert.equal(key(w,d.body,'Tab').defaultPrevented,true);assert.equal(d.activeElement,first);
});
test('native query dialogs retain keyboard focus at both boundaries while preserving Escape return',async t=>{
  const {w,d}=await setup(t);d.querySelector('#saved-queries-panel').focus();w.openSavedQueries();await tick();
  const dialog=d.querySelector('#saved-queries-modal'),first=d.querySelector('#close-saved-queries'),last=dialog.querySelector('.panel-lock');
  first.focus();assert.equal(key(w,first,'Tab',true).defaultPrevented,true);assert.equal(d.activeElement,last);
  assert.equal(key(w,last,'Tab').defaultPrevented,true);assert.equal(d.activeElement,first);
  key(w,first,'Escape');assert.equal(dialog.open,false);assert.equal(d.activeElement.id,'saved-queries-panel');
});
test('docked details become a focused modal on resize and keep an existing detail focus',async t=>{
  const {w,d}=await setup(t);
  Object.defineProperty(w,'innerWidth',{value:1440,configurable:true});
  const opener=d.querySelector('.record-open');opener.focus();await w.openRecordDetail('rec');await tick();
  assert.equal(d.activeElement,opener);assert.equal(d.querySelector('#vault-screen').inert,false);
  Object.defineProperty(w,'innerWidth',{value:390,configurable:true});w.dispatchEvent(new w.Event('resize'));
  assert.equal(d.activeElement.id,'close-record-detail');assert.equal(d.querySelector('#vault-screen').inert,true);
  const copy=d.querySelector('.field-copy');copy.focus();
  Object.defineProperty(w,'innerWidth',{value:1440,configurable:true});w.dispatchEvent(new w.Event('resize'));
  assert.equal(d.querySelector('#vault-screen').inert,false);assert.equal(d.activeElement,copy);
  Object.defineProperty(w,'innerWidth',{value:390,configurable:true});w.dispatchEvent(new w.Event('resize'));
  assert.equal(d.activeElement,copy);
});
test('closing an editor opened from detail returns to its record even if results were rebuilt',async t=>{
  const {w,d}=await setup(t);const opener=d.querySelector('.record-open');opener.focus();
  await w.openRecordDetail('rec');await tick();d.querySelector('#manual-edit-main').focus();
  await w.openManualRecord('main','a','rec');await tick();
  assert.equal(d.activeElement.id,'close-manual-record');
  w.renderRecords();const replacement=d.querySelector('.record-open');assert.notEqual(replacement,opener);
  w.closeManualRecord(true);await tick();assert.equal(d.activeElement,replacement);
});
test('closing details reopened after a save returns to the rebuilt record instead of the page body',async t=>{
  const {w,d}=await setup(t);d.querySelector('.record-open').focus();
  w.renderRecords();assert.equal(d.activeElement,d.body);
  await w.openRecordDetail('rec');await tick();w.closeRecordDetail();await tick();
  assert.equal(d.activeElement,d.querySelector('.record-open'));
});
test('failed query saves recover the initiating focus after disabling it without stealing focus from another control',async t=>{
  const {w,d}=await setup(t);w.openSavedQueries();await tick();d.querySelector('#saved-query-name').value='键盘查询';
  const button=d.querySelector('#saved-query-create'),dialog=d.querySelector('#saved-queries-modal');let reject;
  w.api=async()=>new Promise((_,no)=>{reject=no;});button.focus();const saving=w.saveQuery('create');
  // Real browsers blur a disabled focused control; model that browser behavior explicitly.
  dialog.tabIndex=-1;dialog.focus();reject(new Error('可重试'));await saving;
  assert.equal(d.activeElement,button);assert.match(d.querySelector('#saved-query-status').textContent,/可重试/);
  button.focus();const second=w.saveQuery('create');d.querySelector('#close-saved-queries').focus();reject(new Error('再次失败'));await second;
  assert.equal(d.activeElement.id,'close-saved-queries');
});
test('query deletion restores a usable list control and late completion cannot reopen a sealed modal',async t=>{
  const {w,d}=await setup(t);const filters=w.captureQueryFilters();w.api=async()=>({queries:[{id:'q',name:'待删除',filters}]});
  w.openSavedQueries();await tick();const select=d.querySelector('#saved-query-select');select.value='q';select.dispatchEvent(new w.Event('change'));
  const button=d.querySelector('#saved-query-delete'),dialog=d.querySelector('#saved-queries-modal');let finish;
  w.api=async()=>new Promise(resolve=>{finish=resolve;});button.focus();const deleting=w.saveQuery('delete');dialog.tabIndex=-1;dialog.focus();finish({});await deleting;
  assert.equal(button.disabled,true);assert.equal(d.activeElement,select);
  d.querySelector('#saved-query-name').value='迟到';d.querySelector('#saved-query-create').focus();const saving=w.saveQuery('create');
  const pending=finish;w.api=async()=>({});await w.sealVault('',false);pending({id:'late',name:'迟到',filters});await saving;
  assert.equal(dialog.open,false);assert.equal(d.querySelector('#saved-query-name').value,'');
});
test('secondary menu actions hand dialogs a visible focus return target before opening',async t=>{
  const {w,d}=await setup(t);let focusAtOpen,openAtOpen;
  w.openExport=()=>{focusAtOpen=d.activeElement;openAtOpen=d.querySelector('.dataset-more-actions').open;};w.renderDatasetManager();
  const menu=d.querySelector('.dataset-more-actions'),button=menu.querySelector('.dataset-export-open'),summary=menu.querySelector('summary');
  menu.open=true;button.focus();button.click();
  assert.equal(focusAtOpen,summary);assert.equal(openAtOpen,false);
});
