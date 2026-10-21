const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const fields = [{ source_key:'code',display_name:'编号',zone:'indexes' },{ source_key:'memo',display_name:'备注',zone:'normal' },{ source_key:'json',display_name:'配置',zone:'normal' },{ source_key:'token',display_name:'凭据',zone:'secrets' }];
async function setup(t) {
  const w=page(t,true);await w.initialStatusCheck;
  Object.assign(w.stateForTest,{unlocked:true,canManage:true,datasets:[{id:'a',name:'测试',category_path:'测试',fields,identity_fields:['code'],list_fields:[]}]});
  const calls=[];
  w.api=async(path,options)=>{calls.push({path,options});return {id:'rec',dataset_id:'a',indexes:{code:0},display:{},normal:{memo:'原文',json:{enabled:false,count:0}},protected_fields:[{field_name:'token',zone:'secrets'}]};};
  await w.openManualRecord('main','a','rec');return {w,d:w.document,calls};
}
function input(w,element,value){element.value=value;element.dispatchEvent(new w.Event('input',{bubbles:true}));}
function action(w,row,value){row.querySelector(value === 'keep' ? '.manual-undo' : '.manual-clear').click();}
test('manual edits default to preserving all values and send only changed fields',async t=>{
  const {w,d,calls}=await setup(t);
  assert.ok([...d.querySelectorAll('.manual-field')].every(e=>e.dataset.action==='keep'));
  assert.equal(d.querySelector('[data-source="code"] .manual-value').tagName,'INPUT');
  assert.equal(d.querySelector('[data-source="json"] .manual-value').tagName,'TEXTAREA');
  input(w,d.querySelector('[data-source="memo"] .manual-value'),'已修改');
  assert.match(d.querySelector('#manual-change-summary').textContent,/修改 1 个字段/);
  await w.saveManualRecord();
  assert.deepEqual(JSON.parse(calls.find(c=>c.options?.method==='PATCH').options.body),{values:{memo:'已修改'},unset_fields:[]});
});
test('empty strings and deleting a value are distinct mutually exclusive actions',async t=>{
  const {w,d,calls}=await setup(t);
  input(w,d.querySelector('[data-source="memo"] .manual-value'),'');
  action(w,d.querySelector('[data-source="json"]'),'delete');
  assert.match(d.querySelector('#manual-change-summary').textContent,/将设为 null：配置/);
  await w.saveManualRecord();
  assert.deepEqual(JSON.parse(calls.find(c=>c.options?.method==='PATCH').options.body),{values:{memo:'',json:null},unset_fields:[]});
});
test('restoring keep clears sensitive drafts and removes dirty state',async t=>{
  const {w,d}=await setup(t),row=d.querySelector('[data-source="token"]');
  input(w,row.querySelector('.manual-value'),'synthetic-secret');assert.equal(w.manualRecordDirty(),true);
  action(w,row,'keep');assert.equal(row.querySelector('.manual-value').value,'');assert.equal(w.manualRecordDirty(),false);
  d.querySelector('[data-source="memo"] .manual-expand').click();
  assert.equal(d.querySelector('[data-source="memo"] .manual-value').tagName,'TEXTAREA');
  assert.equal(w.manualRecordDirty(),false);
});
test('JSON errors name and focus the field, retain drafts and prevent submission',async t=>{
  const {w,d,calls}=await setup(t),row=d.querySelector('[data-source="json"]');let toasts=0;w.showToast=()=>toasts++;
  input(w,row.querySelector('.manual-value'),'{\n"enabled": nope\n}');await w.saveManualRecord();
  assert.equal(calls.filter(c=>c.options?.method==='PATCH').length,0);
  assert.match(row.querySelector('.manual-field-error').textContent,/配置.*JSON 格式无效/);
  assert.equal(row.querySelector('.manual-value').getAttribute('aria-invalid'),'true');
  assert.equal(d.activeElement,row.querySelector('.manual-value'));assert.equal(toasts,0);
  assert.equal(d.querySelector('#manual-record-modal').hidden,false);
  input(w,row.querySelector('.manual-value'),'false');assert.equal(row.querySelector('.manual-field-error').hidden,true);
  await w.saveManualRecord();assert.equal(JSON.parse(calls.find(c=>c.options?.method==='PATCH').options.body).values.json,false);
});
test('application details and the one-time credential dialog expose local integration guides',async t=>{
  const {w,d}=await setup(t);w.stateForTest.apps=[{id:'app',name:'回归应用',datasets:['a'],permission:'search'}];w.openAppDetails('app');
  for(const root of [d.querySelector('#app-details-content'),d.querySelector('#app-key-modal')]){
    assert.equal(root.querySelectorAll('.application-guides a').length,2);
    assert.ok([...root.querySelectorAll('.application-guides a')].every(a=>a.getAttribute('href').startsWith('guide.html?guide=')));
  }
});
test('schema preview groups preserve every server change and escape field names',async t=>{
  const {w,d}=await setup(t);
  const changes=['<name> → renamed（重命名）','token：secrets → ignore（清除已有值）','note：normal → display','逻辑 KEY 变化，重新计算','更新列表展示与记录标识'];
  const container=d.createElement('div');container.innerHTML=w.schemaChangeGroups(changes);
  assert.equal(container.querySelectorAll('.schema-change-group').length,5);
  assert.equal(container.querySelectorAll('li').length,5);
  assert.equal(container.querySelector('name'),null);
  assert.equal(container.querySelector('.destructive-change').textContent,changes[1]);
});
test('JSON offset fallback handles invalid tokens, commas, strings and empty input',async t=>{
  const {w}=await setup(t);
  for(const raw of ['{\n"enabled": nope\n}','[1,]','{"x" 2}','"bad\\q"','', '{"a":"unterminated']){
    const offset=w.manualJsonErrorOffset(raw);assert.ok(offset>=0&&offset<=raw.length);
  }
  assert.equal(w.manualJsonErrorOffset('[1,]'),3);
  assert.equal(w.manualJsonErrorOffset('{"x" 2}'),5);
});
test('record save failures stay inline with the draft and clear when the editor closes',async t=>{
  const {w,d}=await setup(t);let toasts=0;w.showToast=()=>toasts++;
  input(w,d.querySelector('[data-source="memo"] .manual-value'),'保留失败草稿');
  w.api=async()=>{throw new Error('记录保存失败，请重试');};await w.saveManualRecord();
  assert.equal(d.querySelector('#manual-record-error').hidden,false);
  assert.match(d.querySelector('#manual-record-error').textContent,/保存失败/);
  assert.equal(d.querySelector('[data-source="memo"] .manual-value').value,'保留失败草稿');
  assert.equal(toasts,0);assert.equal(d.querySelector('#manual-record-save').disabled,false);
  w.closeManualRecord(true);assert.equal(d.querySelector('#manual-record-error').textContent,'');
});
