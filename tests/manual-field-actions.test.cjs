const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const fields = ['code','text','flag','object','empty','absent','secret'].map((key,i)=>({source_key:key,display_name:key,zone:key==='code'?'indexes':key==='secret'?'secrets':'normal',position:i}));
async function setup(t) {
  const w=page(t,true);await w.initialStatusCheck;const d=w.document;
  Object.assign(w.stateForTest,{unlocked:true,canManage:true,datasets:[{id:'a',name:'回归',category_path:'回归',fields,identity_fields:['code'],list_fields:[]}]});
  const calls=[];w.api=async(route,options)=>{calls.push({route,options});return {id:'r',dataset_id:'a',indexes:{code:'001'},normal:{text:'001',flag:false,object:{count:0},empty:null},protected_fields:[{field_name:'secret',zone:'secrets'}]};};
  await w.openManualRecord('main','a','r');return {w,d,calls,row:key=>d.querySelector(`[data-source="${key}"]`)};
}
function edit(w,input,value) {input.value=value;input.dispatchEvent(new w.Event('input',{bubbles:true}));}
test('modified fields expose accessible icon undo and return to clean state with focus on the original value',async t=>{
  const {w,d,row}=await setup(t);const r=row('text'),input=r.querySelector('.manual-value');
  assert.equal(d.querySelector('select.manual-action'),null);assert.equal(r.querySelector('.manual-undo').hidden,true);
  assert.match(r.querySelector('.manual-clear').getAttribute('aria-label'),/设为 null/);
  edit(w,input,'changed');assert.equal(r.dataset.action,'write');assert.equal(r.querySelector('.manual-change-mark').hidden,false);assert.equal(r.querySelector('.manual-undo').hidden,false);
  assert.ok([...r.querySelectorAll('svg')].every(svg=>svg.getAttribute('aria-hidden')==='true'&&svg.getAttribute('focusable')==='false'));
  r.querySelector('.manual-undo').click();assert.equal(input.value,'001');assert.equal(r.dataset.action,'keep');assert.equal(w.manualRecordDirty(),false);assert.equal(d.activeElement,input);
});
test('clearing writes explicit null, distinct from empty strings and omitted protected values',async t=>{
  const {w,row,calls}=await setup(t);
  edit(w,row('text').querySelector('.manual-value'),'');row('object').querySelector('.manual-clear').click();
  assert.equal(row('object').querySelector('.manual-value').disabled,true);assert.match(row('object').querySelector('.manual-field-state').textContent,/null/);
  assert.equal(row('object').querySelector('.manual-clear').getAttribute('aria-pressed'),'true');
  await w.saveManualRecord();const body=JSON.parse(calls.find(c=>c.options?.method==='PATCH').options.body);
  assert.deepEqual(body,{values:{text:'',object:null},unset_fields:[]});assert.equal(Object.hasOwn(body.values,'secret'),false);
});
test('KEY fields reject icon clearing while still allowing edits and undo',async t=>{
  const {w,row}=await setup(t),r=row('code');assert.equal(r.querySelector('.manual-clear').getAttribute('aria-disabled'),'true');
  r.querySelector('.manual-clear').click();assert.equal(r.dataset.action,'keep');assert.equal(w.manualRecordDirty(),false);
  edit(w,r.querySelector('.manual-value'),'002');r.querySelector('.manual-undo').click();assert.equal(r.querySelector('.manual-value').value,'001');
});
test('existing null stays clean while clearing an absent value is an explicit change',async t=>{
  const {w,row}=await setup(t);row('empty').querySelector('.manual-clear').click();assert.equal(w.manualRecordDirty(),false);
  row('absent').querySelector('.manual-clear').click();assert.equal(w.manualRecordDirty(),true);assert.equal(row('absent').dataset.action,'null');
  row('absent').querySelector('.manual-undo').click();assert.equal(w.manualRecordDirty(),false);
  row('text').querySelector('.manual-clear').click();row('text').querySelector('.manual-clear').click();
  assert.equal(row('text').querySelector('.manual-clear').getAttribute('aria-pressed'),'false');assert.equal(row('text').querySelector('.manual-value').value,'001');assert.equal(w.manualRecordDirty(),false);
});
test('undo clears protected drafts without revealing or submitting the original secret',async t=>{
  const {w,row,calls}=await setup(t);const r=row('secret'),input=r.querySelector('.manual-value');
  edit(w,input,'synthetic-draft');r.querySelector('.manual-clear').click();assert.equal(input.value,'');
  r.querySelector('.manual-undo').click();assert.equal(input.value,'');assert.equal(input.type,'password');assert.equal(input.disabled,false);
  await w.saveManualRecord();assert.deepEqual(JSON.parse(calls.find(c=>c.options?.method==='PATCH').options.body),{values:{},unset_fields:[]});
});
test('original value types guide input without coercing numeric-looking text or restricting JSON changes',async t=>{
  const {w,row,calls}=await setup(t);assert.equal(row('text').querySelector('.manual-type').value,'text');assert.equal(row('flag').querySelector('.manual-type').value,'json');
  edit(w,row('text').querySelector('.manual-value'),'002');edit(w,row('flag').querySelector('.manual-value'),'0');
  await w.saveManualRecord();assert.deepEqual(JSON.parse(calls.find(c=>c.options?.method==='PATCH').options.body).values,{text:'002',flag:0});
});
test('clearing an invalid JSON draft can be undone or saved without parsing the discarded draft',async t=>{
  const {w,row,calls}=await setup(t);const r=row('object');edit(w,r.querySelector('.manual-value'),'{invalid');await w.saveManualRecord();
  assert.equal(r.querySelector('.manual-value').getAttribute('aria-invalid'),'true');r.querySelector('.manual-clear').click();assert.equal(r.querySelector('.manual-field-error').hidden,true);
  r.querySelector('.manual-undo').click();assert.deepEqual(JSON.parse(r.querySelector('.manual-value').value),{count:0});assert.equal(w.manualRecordDirty(),false);
  r.querySelector('.manual-clear').click();await w.saveManualRecord();assert.deepEqual(JSON.parse(calls.find(c=>c.options?.method==='PATCH').options.body).values,{object:null});
});
test('busy saves block field actions and a failed save retains null state for retry and undo',async t=>{
  const {w,row}=await setup(t);const r=row('text');r.querySelector('.manual-clear').click();let fail;
  w.api=async()=>new Promise((_,reject)=>{fail=reject;});const saving=w.saveManualRecord();
  assert.equal(r.querySelector('.manual-undo').disabled,true);r.querySelector('.manual-undo').click();assert.equal(r.dataset.action,'null');
  fail(new Error('保存失败'));await saving;assert.equal(r.dataset.action,'null');assert.equal(r.querySelector('.manual-undo').disabled,false);assert.equal(r.querySelector('.manual-value').disabled,true);
  r.querySelector('.manual-undo').click();assert.equal(r.querySelector('.manual-value').value,'001');assert.equal(w.manualRecordDirty(),false);
});
test('field settings stay local, close before the editor on Escape, and expose only one floating panel',async t=>{
  const {w,d,row}=await setup(t),first=row('text').querySelector('.manual-field-options'),second=row('flag').querySelector('.manual-field-options');
  assert.match(first.querySelector('summary').getAttribute('aria-label'),/text.*字段设置/);
  first.open=true;first.dispatchEvent(new w.Event('toggle'));
  assert.equal(w.getComputedStyle(first.querySelector('.manual-field-settings')).position,'fixed');
  second.open=true;second.dispatchEvent(new w.Event('toggle'));assert.equal(first.open,false);
  second.querySelector('.manual-type').focus();second.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(second.open,false);assert.equal(d.querySelector('#manual-record-modal').hidden,false);assert.equal(d.activeElement,second.querySelector('summary'));
  assert.equal(w.manualRecordDirty(),false);
});
