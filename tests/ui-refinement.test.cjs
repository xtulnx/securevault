const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const fields = [{ source_key:'code',display_name:'编号',zone:'indexes',position:0 },{source_key:'enabled',display_name:'enabled',zone:'display',position:1},{source_key:'config',display_name:'配置',zone:'normal',position:2},{source_key:'token',display_name:'凭据',zone:'secrets',position:3}];
async function setup(t) {
  const w = page(t,true); await w.initialStatusCheck;
  const d=w.document,state=w.stateForTest;
  const definition={fields,identity_fields:['code'],list_fields:[],display_config:{},supplement_fields:[]};
  const models=['a','b'].map(id=>({id:'m-'+id,name:'模型'+id,version:37,description:'',definition,dataset_ids:[id]}));
  const datasets=models.map((model,i)=>({...definition,id:i?'b':'a',name:i?'乙数据集':'甲数据集',category_path:i?'其他':'业务/账户',environments:['测试'],record_count:1,schema_id:model.id,schema_name:model.name,schema_version:37}));
  Object.assign(state,{unlocked:true,canManage:true,datasets,catalog:{schemas:models,environments:[]},records:[],selectedDatasetId:'a',category:'all',categories:[],environmentTags:[],query:'enabled:=false'});
  const calls=[];
  w.api=async(route,options)=>{calls.push({route,options});return route==='/catalog'?state.catalog:route==='/saved-queries'?{queries:[]}:{records:[],total:0,page:1};};
  return {w,d,state,calls,models};
}
const change=(w,input,value)=>{input.value=value;input.dispatchEvent(new w.Event('change',{bubbles:true}));};

test('saved queries open in a dialog with complete current scope and close without changing search',async t=>{
  const {w,d,state}=await setup(t); w.renderRecords();
  d.querySelector('#saved-queries-panel').click();await tick();
  assert.equal(d.querySelector('#saved-queries-modal').open,true);
  assert.equal(d.querySelector('#saved-queries-panel').tagName,'BUTTON');
  assert.equal(d.querySelector('#search-workspace #saved-query-name'),null);
  assert.match(d.querySelector('#saved-query-current').textContent,/enabled:=false/);
  assert.match(d.querySelector('#saved-query-current').textContent,/甲数据集/);
  d.querySelector('#saved-query-name').value='保留草稿';
  d.querySelector('#close-saved-queries').click();
  assert.equal(d.querySelector('#saved-queries-modal').open,false);
  assert.equal(d.activeElement,d.querySelector('#saved-queries-panel'));assert.equal(state.query,'enabled:=false');
  d.querySelector('#saved-queries-panel').click();await tick(); assert.equal(d.querySelector('#saved-query-name').value,'保留草稿');
  d.querySelector('#saved-queries-modal').dispatchEvent(new w.Event('cancel',{cancelable:true}));
  assert.equal(d.querySelector('#saved-queries-modal').open,false);
});

test('selected query details escape content and applying closes the dialog with one scoped request',async t=>{
  const {w,d,state}=await setup(t);
  const filters={q:'code:=0 <script>',categories:['业务'],labels:['测试'],dataset_id:'a',schema_id:'m-a',include_expired:true};
  const calls=[];
  w.api=async route=>{calls.push(route);return route==='/saved-queries'?{queries:[{id:'q',name:'<img src=x>',filters}]}:{records:[],total:0,page:1};};
  w.openSavedQueries();await tick();change(w,d.querySelector('#saved-query-select'),'q');
  assert.equal(d.querySelector('#saved-query-preview img, #saved-query-preview script'),null);
  assert.match(d.querySelector('#saved-query-preview').textContent,/code:=0 <script>/);
  assert.match(d.querySelector('#saved-query-preview').textContent,/包含过期记录/);
  await w.applySavedQuery();assert.equal(d.querySelector('#saved-queries-modal').open,false);
  const searches=calls.filter(route=>route.startsWith('/records/search?'));assert.equal(searches.length,1);
  assert.equal(new URL(searches[0],'http://localhost').searchParams.get('dataset_id'),'a');assert.equal(state.query,filters.q);
});

test('saved query mutation blocks closing, failures keep the draft, and sealing clears late results',async t=>{
  const {w,d}=await setup(t); w.openSavedQueries();await tick();
  d.querySelector('#saved-query-name').value='待保存';let resolve;
  w.api=async()=>new Promise(done=>{resolve=done;});const saving=w.saveQuery('create');
  assert.equal(w.closeSavedQueries(),false);assert.equal(d.querySelector('#saved-queries-modal').open,true);
  assert.match(d.querySelector('#saved-query-status').textContent,/正在保存/);
  await w.sealVault('',false);resolve({id:'late',name:'待保存',filters:{}});await saving;
  assert.equal(d.querySelector('#saved-queries-modal').open,false);assert.equal(d.querySelector('#saved-query-name').value,'');
  assert.equal(d.querySelector('#saved-query-current').textContent,'');assert.equal(d.querySelector('#saved-query-preview').textContent,'');
  assert.equal(d.querySelector('#saved-query-select').options.length,1);
});

test('failed query search retains the dialog and its retryable result status',async t=>{
  const {w,d}=await setup(t);const filters=w.captureQueryFilters();
  w.api=async route=>route==='/saved-queries'?{queries:[{id:'q',name:'待重试',filters}]}:Promise.reject(new Error('检索断开'));
  w.openSavedQueries();await tick();change(w,d.querySelector('#saved-query-select'),'q');
  await w.applySavedQuery();assert.equal(d.querySelector('#saved-queries-modal').open,true);
  assert.match(d.querySelector('#saved-query-status').textContent,/检索失败/);assert.equal(d.querySelector('#saved-query-apply').disabled,false);
});

test('compact editing preserves value types and hides advanced settings while keeping actions visible',async t=>{
  const {w,d}=await setup(t);
  w.api=async()=>({id:'rec',dataset_id:'a',indexes:{code:0},display:{enabled:false},normal:{config:{count:0}},protected_fields:[{field_name:'token',zone:'secrets'}]});
  await w.openManualRecord('main','a','rec');
  const enabled=d.querySelector('[data-source="enabled"]'),token=d.querySelector('[data-source="token"]');
  assert.equal(enabled.querySelector('label code'),null);assert.equal(enabled.querySelector('.manual-value').value,'false');
  assert.equal(enabled.querySelector('.manual-type').value,'json');assert.equal(enabled.querySelector('details').open,false);
  assert.equal(enabled.querySelector('.manual-field-actions').parentElement,enabled);
  assert.equal(token.querySelector('.manual-value').type,'password');assert.equal(token.querySelector('.manual-value').value,'');
  assert.match(d.querySelector('#manual-record-context').textContent,/甲数据集.*编号：0/);
  change(w,enabled.querySelector('.manual-type'),'text');assert.equal(enabled.dataset.action,'write');
  enabled.querySelector('.manual-undo').click();assert.equal(enabled.dataset.action,'keep');assert.equal(enabled.querySelector('.manual-type-caption').textContent,'JSON');
  w.closeManualRecord(true);assert.equal(d.querySelector('#manual-record-context').textContent,'');
});

test('manager more actions float without participating in row layout and dismiss on outside click or Escape',async t=>{
  const {w,d}=await setup(t);w.renderDatasetManager();
  const menus=[...d.querySelectorAll('.dataset-more-actions')],first=menus[0];
  first.open=true;first.dispatchEvent(new w.Event('toggle'));
  assert.equal(w.getComputedStyle(first.querySelector('.action-disclosure-content')).position,'fixed');
  assert.equal(first.querySelectorAll('button').length,5);assert.ok(first.querySelector('summary').getAttribute('aria-label').includes('甲数据集'));
  menus[1].open=true;menus[1].dispatchEvent(new w.Event('toggle'));assert.equal(first.open,false);
  d.body.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(menus[1].open,false);
  first.open=true;first.querySelector('summary').focus();
  Object.defineProperty(w,'innerHeight',{value:1,configurable:true});w.dispatchEvent(new w.Event('resize'));assert.equal(first.open,true);
  Object.defineProperty(w,'innerHeight',{value:900,configurable:true});w.dispatchEvent(new w.Event('resize'));assert.equal(first.open,true);
  first.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  assert.equal(first.open,false);assert.equal(d.activeElement,first.querySelector('summary'));
});

test('search keeps dataset actions while model editing moves into the scoped dataset information',async t=>{
  const {w,d,state}=await setup(t),opened=[];w.openSharedSchemaEditor=id=>opened.push(id);
  w.renderDatasetActions();const actions=d.querySelector('#dataset-context-actions');
  assert.equal(actions.hidden,false);assert.ok(actions.querySelector('[data-action="view"]'));assert.ok(actions.querySelector('[data-action="edit"]'));
  assert.equal(actions.querySelector('.search-model-actions,[data-model-action]'),null);
  actions.querySelector('[data-action="view"]').click();
  d.querySelector('[data-info-model-edit]').click();assert.deepEqual(opened,['m-a']);
  state.selectedDatasetId='b';w.renderDatasetActions();
  actions.querySelector('[data-action="view"]').click();d.querySelector('[data-info-model-edit]').click();assert.deepEqual(opened,['m-a','m-b']);
  state.canManage=false;w.renderDatasetActions();actions.querySelector('[data-action="view"]').click();
  assert.equal(d.querySelector('[data-info-model-edit]'),null);
  assert.equal(actions.querySelector('[data-action="edit"],.search-model-actions'),null);
});

test('daily model displays omit version numbers while metadata stays available for publication',async t=>{
  const {w,d,state,models}=await setup(t);
  w.renderDatasetManager();assert.doesNotMatch(d.querySelector('#dataset-manager-list').textContent,/v37/);
  await w.openSharedSchemaView('m-a');assert.doesNotMatch(d.querySelector('#schema-view-scope').textContent,/v37/);
  assert.doesNotMatch(w.referenceCard('model',{...models[0]},'model','数据模型'),/v37/);
  assert.equal(state.catalog.schemas[0].version,37);
});
