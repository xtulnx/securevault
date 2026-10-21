const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const definitions = [{ source_key:'code', display_name:'编号', zone:'indexes', position:0 }, { source_key:'notes', display_name:'说明', zone:'normal', position:1 }, { source_key:'password', display_name:'密码', zone:'secrets', position:2 }];
const addonFields = [{ source_key:'memo',display_name:'备注',zone:'normal',position:0 },{ source_key:'access',display_name:'凭据',zone:'secrets',position:1 }];
const dataset = { id:'ds',category_path:'业务/产品',fields:definitions,identity_fields:['code'],list_fields:[],record_count:1 };
const addonRow = { id:'sup',main_record_id:'rec',orphan:false,link:{mode:'indexes',fields:['code'],values:{code:'001'}},values:{memo:'手工\n备注'},protected_fields:[{field_name:'access',zone:'secrets'}],updated:'2026-10-10' };
const table = { fields:addonFields,records:[addonRow],link_fields:['code'],link_mode:'indexes' };
async function setup(t) { const w=page(t,true);await w.initialStatusCheck;w.stateForTest.unlocked=true;w.stateForTest.canManage=true;w.stateForTest.datasets=[dataset];return w; }

test('main editor preserves JSON types and omits untouched secrets, with an explicit delete action', async(t) => {
  const w=await setup(t), d=w.document, requests=[];
  w.fetch=async(url,options={})=>{requests.push({url,...options});return {ok:true,json:async()=>url.endsWith('/rec')&&options.method==='PATCH'?{id:'rec'}:{id:'rec',dataset_id:'ds',indexes:{code:'001'},normal:{notes:{sql:'SELECT 1;'}},display:{},protected_fields:[{field_name:'password',zone:'secrets'}]}};};
  await w.openManualRecord('main','ds','rec');
  const secret=d.querySelector('[data-source="password"]');assert.equal(secret.dataset.action,'keep');assert.equal(secret.querySelector('.manual-value').value,'');
  assert.equal(d.querySelector('[data-source="notes"] .manual-type').value,'json');
  const notes=d.querySelector('[data-source="notes"]');notes.querySelector('.manual-clear').click();
  await w.saveManualRecord();
  const patch=requests.find((r)=>r.method==='PATCH');const body=JSON.parse(patch.body);
  assert.deepEqual(body,{values:{notes:null},unset_fields:[]});
  assert.equal(d.querySelector('#manual-record-modal').hidden,true);assert.equal(d.querySelector('#manual-record-fields').textContent,'');
});

test('new main records support multiline strings and structured values',async(t)=>{
  const w=await setup(t), d=w.document, requests=[];
  w.fetch=async(url,options={})=>{requests.push({url,...options});return {ok:true,json:async()=>options.method==='POST'?{id:'new'}:{id:'new',dataset_id:'ds',indexes:{},normal:{},protected_fields:[]}};};
  await w.openManualRecord('main','ds');
  const set=(key,value,type='text')=>{const row=d.querySelector(`[data-source="${key}"]`);if(value.includes('\n'))w.expandManualField(row);row.querySelector('.manual-value').value=value;row.querySelector('.manual-value').dispatchEvent(new w.Event('input', {bubbles:true}));row.querySelector('.manual-type').value=type;};
  set('code','002');set('notes','SELECT *\nFROM users;');set('password','{"nested":"private"}','json');
  await w.saveManualRecord();
  const request=requests.find((r)=>r.method==='POST');assert.equal(request.url,'/api/datasets/ds/records');assert.deepEqual(JSON.parse(request.body).values,{code:'002',notes:'SELECT *\nFROM users;',password:{nested:'private'}});
});

test('supplement manager survives closing and reopening, supports re-linking and orphan cleanup',async(t)=>{
  const w=await setup(t), d=w.document, requests=[];w.confirm=()=>true;
  const orphan={...addonRow,orphan:true,main_record_id:'deleted'};
  w.fetch=async(url,options={})=>{requests.push({url,...options});return {ok:true,json:async()=>url.endsWith('/records/replacement')?{id:'replacement',dataset_id:'ds',indexes:{code:'002'},supplement_records:[]}:url.includes('/records/search')?{records:[{id:'rec',indexes:{code:'001'}}]}:url.includes('/cleanup')?{deleted:1}:url.includes('/records/sup')?{id:'sup'}:{...table,records:[addonRow,orphan]}};};
  await w.openSupplement('ds');assert.equal(d.querySelectorAll('.supplement-row').length,2);
  w.closeSupplement();await w.openSupplement('ds');assert.equal(d.querySelectorAll('.supplement-row').length,2);
  await w.openManualRecord('supplement','ds','sup');assert.equal(d.querySelector('#manual-parent-options').value,'rec');d.querySelector('#manual-parent-id').value='replacement';await w.saveManualRecord();
  const patch=requests.find((r)=>r.method==='PATCH');assert.equal(JSON.parse(patch.body).main_record_id,'replacement');assert.ok(!Object.hasOwn(JSON.parse(patch.body).values,'access'));
  d.querySelector('#supplement-cleanup').click();await new Promise((r)=>setImmediate(r));
  assert.ok(requests.some((r)=>r.url==='/api/datasets/ds/supplement/cleanup'&&r.method==='POST'));
});

test('supplement schema renames carry their original keys, fields and editors follow theme',async(t)=>{
  const w=await setup(t), d=w.document, requests=[];
  w.fetch=async(url,options={})=>{requests.push({url,...options});return {ok:true,json:async()=>url.includes('/records/search')?{records:[{id:'rec',indexes:{code:'001'}}]}:table};};
  await w.openSupplement('ds');d.querySelector('.supplement-source').value='new_memo';
  await w.saveSupplementSchema();const body=JSON.parse(requests.find((r)=>r.method==='PATCH').body);assert.equal(body.fields[0].previous_source_key,'memo');assert.equal(body.fields[0].source_key,'new_memo');
  await w.openManualRecord('supplement','ds','sup');const textarea=d.querySelector('#manual-record-fields textarea');
  w.applyTheme('light');assert.equal(w.getComputedStyle(textarea).backgroundColor,'rgb(248, 251, 251)');w.applyTheme('dark');assert.equal(w.getComputedStyle(textarea).backgroundColor,'rgba(5, 18, 28, 0.62)');
});

test('sealing clears manual data and late responses cannot reopen an editor or show supplement secrets',async(t)=>{
  const w=await setup(t), d=w.document;
  w.fetch=async()=>({ok:true,json:async()=>table});await w.openSupplement('ds');await w.openManualRecord('supplement','ds','sup');
  d.querySelector('[data-source="access"] .manual-value').value='typed-secret';
  w.clearManualData();assert.equal(d.querySelector('#manual-record-modal').hidden,true);assert.equal(d.querySelector('#manual-record-fields').textContent,'');assert.equal(d.querySelector('#supplement-records').textContent,'');
  let resolve;w.fetch=()=>new Promise((r)=>{resolve=r;});const pending=w.openManualRecord('main','ds','rec');w.stateForTest.unlocked=false;w.clearManualData();resolve({ok:true,json:async()=>({indexes:{code:'late'},normal:{},display:{}})});await pending;
  assert.equal(d.querySelector('#manual-record-modal').hidden,true);assert.equal(d.querySelector('#manual-record-fields').textContent,'');
});

test('record detail directly edits its single supplement and returns with saved values',async(t)=>{
  const w=await setup(t),d=w.document,requests=[];let memo='旧备注';
  const detail=()=>({id:'rec',dataset_id:'ds',category:'业务/产品',indexes:{code:'001'},display:{},normal:{},protected_fields:[],supplement_fields:addonFields,supplement_records:[{...addonRow,values:{memo}}]});
  w.fetch=async(url,options={})=>{
    requests.push({url,...options});
    if(options.method==='PATCH'){memo=JSON.parse(options.body).values.memo;return {ok:true,json:async()=>({id:'sup'})};}
    return {ok:true,json:async()=>url.includes('/records/search')?{records:[{id:'rec',indexes:{code:'001'},supplement:{id:'sup'}}]}:url.endsWith('/supplement')?{...table,records:[{...addonRow,values:{memo}}]}:detail()};
  };
  await w.openRecordDetail('rec');
  assert.equal(d.querySelector('[data-edit-supplement]').textContent,'编辑附表');assert.equal(d.querySelector('[data-new-supplement]'),null);
  d.querySelector('[data-edit-supplement]').click();await new Promise((r)=>setImmediate(r));
  assert.equal(d.querySelector('#manual-record-title').textContent,'编辑附表记录');assert.equal(d.querySelector('#record-detail-modal').hidden,true);
  const input=d.querySelector('[data-source="memo"] .manual-value');input.value='新备注';input.dispatchEvent(new w.Event('input', {bubbles:true}));
  assert.equal(d.querySelector('#manual-parent-options option[value="rec"]').disabled,false);
  await w.saveManualRecord();
  const patch=requests.find((r)=>r.method==='PATCH');assert.equal(patch.url,'/api/datasets/ds/supplement/records/sup');assert.deepEqual(JSON.parse(patch.body),{values:{memo:'新备注'},unset_fields:[]});
  assert.equal(d.querySelector('#record-detail-modal').hidden,false);assert.match(d.querySelector('#record-supplement-content').textContent,/新备注/);
  w.stateForTest.canManage=false;await w.openRecordDetail('rec');assert.equal(d.querySelector('[data-edit-supplement]'),null);
});

test('empty supplement detail adds one record and occupied parents cannot be selected',async(t)=>{
  const w=await setup(t),d=w.document,requests=[];let created=false;
  const detail=()=>({id:'rec',dataset_id:'ds',category:'业务/产品',indexes:{code:'001'},display:{},normal:{},protected_fields:[],supplement_fields:addonFields,supplement_records:created?[addonRow]:[]});
  w.fetch=async(url,options={})=>{requests.push({url,...options});if(options.method==='POST'){created=true;return {ok:true,json:async()=>({id:'sup'})};}return {ok:true,json:async()=>url.includes('/records/search')?{records:[{id:'rec',indexes:{code:'001'}},{id:'other',indexes:{code:'002'},supplement:{id:'occupied'}}]}:url.endsWith('/supplement')?{...table,records:[]}:detail()};};
  await w.openRecordDetail('rec');assert.equal(d.querySelector('[data-edit-supplement]').textContent,'＋ 添加附表');
  d.querySelector('[data-edit-supplement]').click();await new Promise((r)=>setImmediate(r));
  assert.equal(d.querySelector('#manual-parent-options option[value="other"]').disabled,true);
  await w.saveManualRecord();assert.equal(JSON.parse(requests.find((r)=>r.method==='POST').body).main_record_id,'rec');
  assert.equal(d.querySelector('[data-edit-supplement]').textContent,'编辑附表');
});

test('supplement search fields have namespaced query tokens, labels, and highlighted list values',async(t)=>{
  const w=await setup(t),d=w.document;
  w.stateForTest.datasets=[{...dataset,list_fields:[{source_key:'code',visible:true}],supplement_fields:[{source_key:'code',display_name:'自定义编号',zone:'indexes'},{source_key:'status',display_name:'状态',zone:'display'}]}];
  w.renderIndexReference();const token=d.querySelector('[data-query-field="supplement.code"]');assert.match(token.textContent,/附表 · 自定义编号/);token.click();assert.equal(d.querySelector('#search-input').value,'supplement.code:');
  w.fetch=async()=>({ok:true,json:async()=>({records:[{id:'rec',dataset_id:'ds',category:'业务/产品',indexes:{code:'主编号'},display:{},matched_fields:['supplement.code'],supplement:{id:'sup',indexes:{code:'附表编号'},display:{status:'已确认'},field_labels:{code:'自定义编号',status:'状态'}},secret_count:0}],total:1,page:1})});
  w.stateForTest.query = 'supplement.code:附表';
  await w.fetchRecords();assert.match(d.querySelector('.data-point.is-match').textContent,/附表 · 自定义编号.*附表编号/);assert.match(d.querySelector('#records-grid').textContent,/附表 · 状态.*已确认/);
});
