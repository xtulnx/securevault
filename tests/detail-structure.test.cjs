const { test } = require('node:test');
const assert = require('node:assert/strict');
const { page } = require('./helpers/web-page.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, canManage = true) {
  const w = page(t, true); await w.initialStatusCheck;
  const fields = [
    { source_key: '10', display_name: '十', zone: 'normal', position: 0 },
    { source_key: 'code', display_name: '编号', zone: 'indexes', position: 1 },
    { source_key: '2', display_name: '二', zone: 'display', position: 2 },
    { source_key: 'token', display_name: '口令', zone: 'secrets', position: 3 },
  ];
  const dataset = { id: 'a', name: '账户实例', category_path: '业务/账户', environments: ['测试'], record_count: 1, description: '实例说明', schema_id: 'm', schema_name: '账户模型', schema_description: '共用说明', fields, identity_fields: ['code'], list_fields: [], supplement_fields: [] };
  const record = { id: 'rec', dataset_id: 'a', indexes: { code: 'C-1' }, display: { 2: false }, normal: { 10: 0, memo: null }, protected_fields: [{field_name: 'token', zone: 'secrets', masked: '••••'}], supplement_records: [] };
  const model = { id: 'm', name: '账户模型', dataset_ids: ['a'], description: '共用说明', definition: dataset };
  const state = w.stateForTest;
  Object.assign(state, { unlocked: true, canManage, workspace: 'search', datasets: [dataset], records: [record], catalog: { schemas: [model], environments: [] } });
  const calls = [];
  w.api = async (route, options) => { calls.push({route,options}); return route === '/catalog' ? state.catalog : route === '/records/rec' ? record : {}; };
  return {w, d:w.document, state, dataset, record, calls};
}

test('record overview follows model order including numeric keys, preserves legacy values, and keeps actions outside scrolling fields', async t => {
  const {w,d}=await setup(t); await w.openRecordDetail('rec');
  assert.deepEqual([...d.querySelectorAll('[data-detail-section="overview"] .detail-row > span')].map(el=>el.textContent), ['十','编号','二','memo']);
  assert.deepEqual([...d.querySelectorAll('[data-detail-section="overview"] [data-copy-json]')].map(el=>JSON.parse(el.dataset.copyJson)), [0,'C-1',false,null]);
  assert.equal(d.querySelectorAll('[data-detail-section="overview"]').length,1);
  assert.equal(d.querySelector('#record-detail-content #manual-edit-main'),null);
  assert.equal(d.querySelector('#manual-edit-main').parentElement.id,'record-detail-actions');
  assert.equal(d.querySelector('#manual-delete-main').parentElement.id,'record-detail-actions');
  assert.equal(d.querySelector('#manual-delete-main').closest('details'),null);
  assert.equal(d.querySelector('#record-detail-content').tabIndex,0);
  assert.equal(d.querySelector('#record-detail-header .dialog-icon'),null);
  assert.equal(d.querySelector('#record-detail-meta .dimension-badge').getAttribute('aria-label'),'标签：测试');
});

test('tab navigation switches semantic sections and footer without leaking reveal values or focusable destructive actions', async t => {
  const {w,d,state}=await setup(t); await w.openRecordDetail('rec');
  const tab=d.querySelector('#record-tab-overview'); tab.focus();
  tab.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  assert.equal(state.detailTab,'secrets'); assert.equal(d.activeElement.id,'record-tab-secrets');
  assert.equal(d.querySelector('#record-detail-actions').hidden,true);
  assert.equal(d.querySelector('[data-detail-section="overview"]').hidden,true);
  assert.equal(d.querySelector('[data-detail-section="secrets"]').hidden,false);
  assert.ok(!w.overlayTabStops(d.querySelector('#record-detail-modal')).includes(d.querySelector('#manual-delete-main')));
  state.reveal={recordId:'rec',field:'token',value:'TEST_ONLY',expiresAt:Date.now()+30000};
  w.selectDetailTab('overview'); assert.equal(state.reveal,null);
  assert.doesNotMatch(d.querySelector('#detail-protected-fields').textContent,/TEST_ONLY/);
  assert.equal(d.querySelector('#record-detail-actions').hidden,false);
});

test('record context opens only its dataset and editing retains the selected record', async t => {
  const {w,d,dataset}=await setup(t); await w.openRecordDetail('rec');
  d.querySelector('#record-detail-meta button').click();
  assert.equal(d.querySelector('#dataset-info-title').textContent,dataset.name);
  assert.match(d.querySelector('#dataset-info-content').textContent,/账户模型/);
  let args; w.openManualRecord=(...values)=>{args=values;};
  d.querySelector('#manual-edit-main').click();
  assert.deepEqual(args,['main','a','rec']);
});

test('empty overview remains explanatory, readonly roles have no writes, and closing clears fixed header and actions', async t => {
  const {w,d,record,calls}=await setup(t,false);
  Object.assign(record,{indexes:{},display:{},normal:{}});await w.openRecordDetail('rec');
  assert.match(d.querySelector('[data-detail-section="overview"]').textContent,/暂无公开字段/);
  assert.equal(d.querySelector('[data-detail-section="overview"]').hidden,false);
  assert.equal(d.querySelector('#record-detail-actions').hidden,true);
  assert.equal(d.querySelector('#manual-edit-main,#manual-delete-main'),null);
  w.closeRecordDetail();
  assert.equal(d.querySelector('#record-detail-meta').textContent,'');
  assert.equal(d.querySelector('#record-detail-tabs').textContent,'');
  assert.equal(d.querySelector('#record-detail-actions').textContent,'');
  assert.ok(calls.every(call=>!call.options?.method));
});

test('failed refresh and late record requests cannot restructure a stale record or bring back closed details', async t => {
  const {w,d}=await setup(t);await w.openRecordDetail('rec');
  w.selectDetailTab('secrets');
  const original=d.querySelector('[data-detail-section="overview"]');
  w.api=async()=>{throw new Error('offline');};await w.openRecordDetail('rec');
  assert.equal(d.querySelector('[data-detail-section="overview"]'),original);
  assert.equal(w.stateForTest.detailTab,'secrets');
  assert.equal(d.querySelector('#record-tab-secrets').getAttribute('aria-selected'),'true');
  let finish; w.api=()=>new Promise(resolve=>{finish=resolve;});
  const pending=w.openRecordDetail('other');w.closeRecordDetail();finish({id:'other',dataset_id:'a'});await pending;
  assert.equal(d.querySelector('#record-detail-modal').hidden,true);
  assert.equal(d.querySelector('#record-detail-actions').textContent,'');
});

test('management and import dataset references use the same model fields without duplicate tabs or metadata cards', async t => {
  const {w,d,state,dataset,calls}=await setup(t);
  w.openDatasetInfo('a');
  const fields=d.querySelector('#dataset-info-model-content').innerHTML;
  w.openManagedDataset('a','list');await tick();
  assert.equal(d.querySelector('#dataset-detail-tabs').hidden,true);
  assert.equal(d.querySelector('#dataset-detail-body .shared-model-scope'),null);
  assert.equal(d.querySelectorAll('#dataset-detail-heading dt').length,4);
  assert.equal(d.querySelectorAll('#dataset-detail-body .dataset-model-fields').length,2);
  assert.equal(d.querySelector('#managed-edit-model').textContent,'修改共享模型');
  assert.match(d.querySelector('#managed-supplement').textContent,/附表数据/);
  w.openReferenceDetails('dataset',dataset,'当前目标数据集');
  assert.equal(d.querySelector('#reference-info-content .dataset-model-info > div:nth-of-type(2)').innerHTML,fields);
  assert.equal(d.querySelector('#reference-info-content .reference-fields'),null);
  assert.equal(d.querySelectorAll('#reference-info-content dt').length,5);
  assert.ok(d.querySelector('#reference-info-content [data-info-model-edit]'));
  w.openReferenceDetails('dataset',{...dataset},'文件中的数据集');
  assert.equal(d.querySelector('#reference-info-content [data-info-model-edit]'),null);
  assert.ok(calls.every(call=>!call.options?.method));
});

test('management dataset and model editing keep their distinct save scope and show shared impact only in the editor', async t => {
  const {w,d,state}=await setup(t);w.openManagedDataset('a');await tick();
  d.querySelector('#managed-edit').click();await tick();
  assert.equal(state.workspace,'editor');assert.equal(state.editDatasetId,'a');assert.equal(state.editorMode,'basic');
  w.openManagedDataset('a');await tick();d.querySelector('#managed-edit-model').click();await tick();
  assert.equal(d.querySelector('#shared-schema-modal').open,true);
  assert.match(d.querySelector('#shared-schema-scope').textContent,/所有引用数据集生效/);
});

test('Escape closes the focused docked detail and restores its result opener', async t => {
  const {w,d}=await setup(t);Object.defineProperty(w,'innerWidth',{value:1440,configurable:true});
  w.renderRecords();const opener=d.querySelector('.record-open');opener.focus();
  await w.openRecordDetail('rec');await tick();
  const remove=d.querySelector('#manual-delete-main'); remove.focus();
  remove.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
  await tick();assert.equal(d.querySelector('#record-detail-modal').hidden,true);assert.equal(d.activeElement,opener);
});

test('dataset editor back label and keyboard focus return to the actual management detail entry', async t => {
  const {w,d,state}=await setup(t);w.openManagedDataset('a');await tick();
  d.querySelector('#managed-edit').focus();d.querySelector('#managed-edit').click();await tick();
  assert.equal(d.querySelector('#close-dataset').textContent,'← 返回数据集详情');
  d.querySelector('#cancel-dataset').click();await tick();
  assert.equal(state.workspace,'dataset');assert.equal(d.activeElement.id,'managed-edit');
});

test('catalog refresh preserves the model reference focus when replacing its editor and import cards', async t => {
  const {w,d}=await setup(t);
  w.openImport('a');await tick();
  d.querySelector('#import-context [data-reference="dataset"]').focus();
  await w.loadCatalog();
  assert.equal(d.activeElement.dataset.reference,'dataset');
  assert.equal(d.activeElement.closest('#import-context').id,'import-context');
  w.openDatasetEdit('a','basic');await tick();
  d.querySelector('#editor-model-reference [data-reference]').focus();
  await w.loadCatalog();assert.equal(d.activeElement.dataset.reference,'model');
  assert.equal(d.activeElement.closest('#editor-model-reference').id,'editor-model-reference');
});

test('a native dataset dialog relies on browser inertness so its record opener can receive focus on close', async t => {
  const {w,d}=await setup(t);await w.openRecordDetail('rec');await tick();
  const record=d.querySelector('#record-detail-modal'),link=d.querySelector('.record-dataset-link');
  d.querySelector('#dataset-info-modal').showModal=function(){this.open=true;};
  link.focus();link.click();await tick();
  assert.equal(d.querySelector('#dataset-info-modal').open,true);
  assert.equal(record.inert,false);
  assert.equal(w.modalElement().id,'dataset-info-modal');
});
