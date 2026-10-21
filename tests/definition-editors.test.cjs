const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t) {
  const w=page(t,true);await w.initialStatusCheck;const d=w.document,state=w.stateForTest;
  const definition={fields:[{source_key:'code',display_name:'编号',zone:'indexes',position:0},{source_key:'token',display_name:'凭据',zone:'secrets',position:1}],identity_fields:['code'],list_fields:[{source_key:'code',position:0,format:'multiline',visible:true}],display_config:{identifier_fields:['code'],density:'summary'},supplement_fields:[{source_key:'note',display_name:'备注',zone:'normal',position:0}]};
  const model={id:'m',name:'模型',description:'原模型说明',dataset_ids:['a','b'],definition};
  Object.assign(state,{unlocked:true,canManage:true,datasets:['a','b'].map(id=>({...definition,id,name:'数据集'+id,category_path:'业务/'+id,environments:['测试'],schema_id:'m',schema_name:'模型',description:'原数据集描述',record_count:0})),catalog:{schemas:[model],environments:[]}});
  const calls=[];w.api=async(route,options)=>{if(route==='/catalog')return state.catalog;calls.push({route,options});return {saved:true};};
  return {w,d,state,calls};
}
function edit(w,element,value){element.value=value;element.dispatchEvent(new w.Event('input',{bubbles:true}));}
function moveNumber(w,row,value,key='Enter'){row.querySelector('.shared-row-number').click();const input=row.querySelector('.shared-position');edit(w,input,value);input.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
function undo(d,key){d.querySelector(`[data-property="${key}"] .definition-property-undo`).click();}
test('dataset properties track actual changes and undo restores focus and clean navigation state',async t=>{
  const {w,d,state,calls}=await setup(t);w.openDatasetEdit('a','basic');await tick();
  edit(w,d.querySelector('#dataset-name'),'新名称');assert.equal(state.editorDirty,true);
  assert.equal(d.querySelector('[data-property="dataset-name"] .definition-change-mark').hidden,false);
  undo(d,'dataset-name');assert.equal(d.querySelector('#dataset-name').value,'数据集a');assert.equal(d.activeElement.id,'dataset-name');assert.equal(state.editorDirty,false);assert.equal(calls.length,0);
  w.returnFromDatasetEditor();assert.notEqual(state.workspace,'editor');
});
test('label undo restores both committed tags and the uncommitted input without a request',async t=>{
  const {w,d,state,calls}=await setup(t);w.openDatasetEdit('a','basic');await tick();
  edit(w,d.querySelector('#dataset-environment-select'),'新标签');d.querySelector('#add-dataset-environment').click();
  assert.equal(state.environmentDraft.length,2);edit(w,d.querySelector('#dataset-environment-select'),'未提交');undo(d,'dataset-labels');
  assert.deepEqual(Array.from(state.environmentDraft),['测试']);assert.equal(d.querySelector('#dataset-environment-select').value,'');assert.equal(state.editorDirty,false);assert.equal(calls.length,0);
});
test('saving an unchanged description or recommitting an existing label stays clean',async t=>{
  const {w,d,state}=await setup(t);w.openDatasetEdit('a','basic');await tick();
  d.querySelector('#edit-description').click();await w.saveDescription();assert.equal(state.editorDirty,false);
  const input=d.querySelector('#dataset-environment-select');edit(w,input,'测试');input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  assert.equal(state.editorDirty,false);
});
test('dataset editor description stays in its draft and is saved together with other instance properties',async t=>{
  const {w,d,state,calls}=await setup(t);w.openDatasetEdit('a','basic');await tick();
  d.querySelector('#edit-description').click();d.querySelector('#description-draft').value='新描述';await w.saveDescription();
  assert.equal(calls.length,0);assert.equal(state.datasets[0].description,'原数据集描述');assert.equal(d.querySelector('#dataset-description').value,'新描述');
  undo(d,'dataset-description');assert.equal(d.querySelector('#dataset-description').value,'原数据集描述');assert.equal(state.editorDirty,false);
  d.querySelector('#edit-description').click();d.querySelector('#description-draft').value='最终描述';await w.saveDescription();await w.createDataset();
  const body=JSON.parse(calls[0].options.body);assert.equal(body.description,'最终描述');assert.equal(body.fields,undefined);assert.equal(body.schema_id,undefined);
});
test('shared field undo restores a renamed or ignored field, display settings and original order',async t=>{
  const {w,d}=await setup(t);await w.openSharedSchemaEditor('m');
  const first=d.querySelector('#shared-main-fields .catalog-field-row');
  edit(w,first.querySelector('.shared-source'),'renamed');const zone=first.querySelector('.shared-zone');zone.value='ignore';zone.dispatchEvent(new w.Event('change',{bubbles:true}));
  moveNumber(w,first,'2');assert.equal(w.sharedSchemaDirty(),true);assert.equal(d.activeElement,first.querySelector('.shared-row-number'));
  first.querySelector('.shared-undo').click();assert.equal(d.querySelector('#shared-main-fields').firstElementChild,first);
  const definition=w.readSharedDefinition();assert.equal(definition.fields[0].source_key,'code');assert.equal(definition.fields[0].zone,'indexes');assert.deepEqual(Array.from(definition.identity_fields),['code']);assert.equal(definition.list_fields[0].format,'multiline');assert.equal(definition.list_fields[0].visible,true);assert.equal(w.sharedSchemaDirty(),false);
});
test('model properties and descriptions can be undone without changing dataset metadata or publishing',async t=>{
  const {w,d,state,calls}=await setup(t);await w.openSharedSchemaEditor('m');
  edit(w,d.querySelector('#shared-schema-name'),'新模型');undo(d,'shared-schema-name');
  d.querySelector('#shared-edit-description').click();d.querySelector('#description-draft').value='模型草稿';await w.saveDescription();undo(d,'model-description');
  assert.equal(state.schemaDraft.description,'原模型说明');assert.equal(w.sharedSchemaDirty(),false);assert.equal(state.datasets[0].description,'原数据集描述');assert.equal(calls.length,0);
});
test('model display controls stay directly available and preserve their values in the draft',async t=>{
  const {w,d}=await setup(t);await w.openSharedSchemaEditor('m');const row=d.querySelector('#shared-main-fields .catalog-field-row');
  assert.equal(row.querySelector('details'),null);
  for(const selector of ['.shared-visible','.shared-identifier','.shared-format','.shared-row-number','.shared-position']) assert.ok(row.querySelector(selector));
  const format=row.querySelector('.shared-format');edit(w,format,'json');const identifier=row.querySelector('.shared-identifier');identifier.checked=false;identifier.dispatchEvent(new w.Event('change',{bubbles:true}));
  const definition=w.readSharedDefinition();assert.equal(definition.list_fields[0].format,'json');assert.deepEqual(Array.from(definition.display_config.identifier_fields),[]);
  const visible=row.querySelector('.shared-visible');visible.checked=false;visible.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(format.disabled,true);assert.equal(format.value,'json');
  visible.checked=true;visible.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(format.disabled,false);assert.equal(w.readSharedDefinition().list_fields[0].format,'json');
  row.querySelector('.shared-undo').click();assert.equal(w.sharedSchemaDirty(),false);
});
test('inline model controls explain unavailable display settings and warn only for an ignored field',async t=>{
  const {w,d}=await setup(t);await w.openSharedSchemaEditor('m');const row=d.querySelector('[data-original="token"]'),hint=row.querySelector('.definition-field-hint');
  assert.equal(row.querySelector('.shared-visible').disabled,true);assert.equal(hint.hidden,false);assert.match(hint.textContent,/不参与公开/);
  const zone=row.querySelector('.shared-zone');zone.value='ignore';zone.dispatchEvent(new w.Event('change',{bubbles:true}));assert.match(hint.textContent,/清除/);assert.equal(hint.classList.contains('danger-text'),true);
  row.querySelector('.shared-undo').click();assert.equal(zone.value,'secrets');assert.equal(hint.classList.contains('danger-text'),false);assert.equal(w.sharedSchemaDirty(),false);
});
test('removing a new model field restores a clean draft and returns focus to a neighbouring input',async t=>{
  const {w,d}=await setup(t);await w.openSharedSchemaEditor('m');
  d.querySelector('#shared-add-main').click();const container=d.querySelector('#shared-main-fields'),row=container.lastElementChild;
  assert.equal(row.dataset.original,'');assert.equal(d.activeElement,row.querySelector('.shared-source'));assert.equal(w.sharedSchemaDirty(),true);
  row.querySelector('.shared-remove').click();assert.equal(container.children.length,2);assert.equal(d.activeElement,container.lastElementChild.querySelector('.shared-source'));assert.equal(w.sharedSchemaDirty(),false);
  assert.equal(d.querySelector('#model-edit-summary').textContent,'未修改的内容保留原值。');
});
test('failed dataset saves retain the draft and restore controls, while sealing prevents late navigation',async t=>{
  const {w,d,state}=await setup(t);w.openDatasetEdit('a','basic');await tick();edit(w,d.querySelector('#dataset-name'),'保留草稿');
  w.api=async()=>{throw new Error('暂时无法保存');};await w.createDataset();assert.match(d.querySelector('#dataset-edit-error').textContent,/暂时/);assert.equal(d.querySelector('#dataset-name').value,'保留草稿');assert.equal(d.querySelector('#dataset-name').disabled,false);
  let finish;w.api=async()=>new Promise(resolve=>{finish=resolve;});const saving=w.createDataset();assert.equal(d.querySelector('#dataset-name').disabled,true);
  const pending=finish;w.api=async()=>({});await w.sealVault('',false);pending({});await saving;
  assert.equal(state.unlocked,false);assert.equal(d.querySelector('#dataset-name').value,'');assert.equal(d.querySelector('#dataset-name').disabled,false);assert.equal(d.querySelector('#dataset-edit-summary').textContent,'');
});

test('editing a field number is transient; Escape cancels without closing the model or dirtying the draft',async t=>{
  const {w,d}=await setup(t);await w.openSharedSchemaEditor('m');const row=d.querySelector('#shared-main-fields .catalog-field-row');
  moveNumber(w,row,'2','Escape');assert.equal(w.sharedSchemaDirty(),false);assert.equal(row.parentElement.firstElementChild,row);
  assert.equal(d.activeElement,row.querySelector('.shared-row-number'));assert.equal(d.querySelector('#shared-schema-modal').open,true);
  assert.equal(row.querySelector('.shared-position').value,'1');assert.equal(row.querySelector('.shared-position').hidden,true);
});
test('invalid numbers keep the field in place and Enter exposes a range error until corrected or cancelled',async t=>{
  const {w,d}=await setup(t);await w.openSharedSchemaEditor('m');const row=d.querySelector('#shared-main-fields .catalog-field-row');
  for(const value of ['', '0', '-1', '1.5', 'text', '3']) {
    moveNumber(w,row,value);const input=row.querySelector('.shared-position');assert.equal(input.hidden,false);assert.equal(input.getAttribute('aria-invalid'),'true');
    assert.match(input.validationMessage,/1.*2/);assert.equal(row.parentElement.firstElementChild,row);assert.equal(w.sharedSchemaDirty(),false);
    input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  }
  moveNumber(w,row,'2');assert.equal(row.parentElement.lastElementChild,row);assert.equal(w.sharedSchemaDirty(),true);
  row.querySelector('.shared-undo').click();assert.equal(w.sharedSchemaDirty(),false);
});
test('blur commits valid numbers, renumbers all rows and keeps supplemental ordering scoped to its own table',async t=>{
  const {w,d,state}=await setup(t);state.catalog.schemas[0].definition.supplement_fields.push({source_key:'extra',display_name:'附注',zone:'normal',position:1});await w.openSharedSchemaEditor('m');
  const rows=d.querySelector('#shared-supplement-fields'),row=rows.lastElementChild;row.querySelector('.shared-row-number').click();const input=row.querySelector('.shared-position');edit(w,input,'1');input.blur();
  assert.equal(rows.firstElementChild,row);assert.deepEqual([...rows.querySelectorAll('.shared-number-text')].map(x=>x.textContent),['1','2']);
  const definition=w.readSharedDefinition();assert.deepEqual(Array.from(definition.supplement_fields,f=>f.source_key),['extra','note']);assert.deepEqual(Array.from(definition.fields,f=>f.source_key),['code','token']);assert.deepEqual(Array.from(definition.identity_fields),['code']);
  row.querySelector('.shared-undo').click();assert.equal(w.sharedSchemaDirty(),false);
  row.querySelector('.shared-row-number').click();edit(w,input,'999');input.blur();assert.equal(input.hidden,true);assert.equal(rows.lastElementChild,row);assert.equal(w.sharedSchemaDirty(),false);
});
