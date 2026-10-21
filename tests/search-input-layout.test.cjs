const {test}=require('node:test');
const assert=require('node:assert/strict');
const {page}=require('./helpers/web-page.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function setup(t) {
  const w=page(t,true);await w.initialStatusCheck;
  const d=w.document,s=w.stateForTest;
  Object.assign(s,{unlocked:true,canManage:true,workspace:'search',datasets:[],records:[],query:'',total:0,page:1});
  Object.defineProperty(w,'innerWidth',{value:1440,configurable:true});
  w.applySearchLayout();
  const calls=[],toasts=[],realApi=w.api;
  w.api=async(route,options)=>{calls.push({route,options});return {records:[],total:0,page:1};};
  w.showToast=(...args)=>toasts.push(args);
  return {w,d,s,calls,toasts,realApi};
}
function fakeTimers(w){let id=0;const pending=new Map();w.setTimeout=(fn,delay)=>{pending.set(++id,{fn,delay});return id;};w.clearTimeout=id=>pending.delete(id);return {pending,async run(delay){for(const [id,timer] of [...pending])if(timer.delay===delay){pending.delete(id);timer.fn();}await tick();}};}
function input(w,value,composing=false){const el=w.document.querySelector('#search-input');el.value=value;el.dispatchEvent(new w.InputEvent('input',{bubbles:true,isComposing:composing}));return el;}
function key(w,el,key,extra={}){el.dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));}
function pointer(w,el,type,x,id=7){const e=new w.MouseEvent(type,{bubbles:true,cancelable:true,button:0,clientX:x});Object.defineProperty(e,'pointerId',{value:id});el.dispatchEvent(e);}

test('typing batches into a 500ms trailing search; Enter flushes once without a duplicate timer',async t=>{
  const {w,d,calls}=await setup(t),clock=fakeTimers(w);
  input(w,'a');input(w,'ab');input(w,'abc');
  assert.equal(calls.length,0);assert.equal([...clock.pending.values()].filter(x=>x.delay===500).length,1);
  await clock.run(180);assert.equal(calls.length,0);await clock.run(500);
  assert.equal(calls.length,1);assert.equal(new URL(calls[0].route,'http://test').searchParams.get('q'),'abc');
  const el=input(w,'abcd');key(w,el,'Enter');await tick();await clock.run(500);
  assert.equal(calls.length,2);assert.equal(d.querySelector('#search-status').hidden,true);
});

test('IME composition and incomplete clauses never send a broadened query or toast',async t=>{
  const {w,d,calls,toasts,s}=await setup(t),clock=fakeTimers(w),el=d.querySelector('#search-input');
  el.dispatchEvent(new w.CompositionEvent('compositionstart'));input(w,'中',true);await clock.run(500);
  key(w,el,'Enter',{isComposing:true});assert.equal(calls.length,0);
  el.value='中文';el.dispatchEvent(new w.CompositionEvent('compositionend'));input(w,'中文');await clock.run(500);
  assert.equal(calls.length,1);
  for(const query of ['cid:', 'code:=', 'code:~/', 'code:^', '"尚未完成', ':value']) {input(w,query);await clock.run(500);}
  assert.equal(calls.length,1);assert.equal(toasts.length,0);assert.equal(s.searchOutcome,'invalid');
  assert.equal(d.querySelector('#search-error').hidden,true);assert.match(d.querySelector('#search-status').textContent,/保留上次检索结果/);
  assert.equal(d.querySelector('#next-page').disabled,true);
});

test('backend regex validation keeps old results and a quiet local status; network failure remains actionable',async t=>{
  const {w,d,s,toasts}=await setup(t);s.records=[{id:'last'}];s.query='code:~[';
  w.api=async()=>{throw Object.assign(new Error('invalid search regex: unclosed class'),{status:400});};
  assert.equal(await w.fetchRecords(),false);assert.equal(s.records[0].id,'last');assert.equal(s.searchOutcome,'invalid');
  assert.equal(d.querySelector('#search-error').hidden,true);assert.equal(d.querySelector('#search-status').hidden,false);assert.equal(toasts.length,0);
  s.query='code:valid';w.api=async()=>{throw new Error('暂时不可用');};
  await assert.rejects(w.fetchRecords(),/暂时不可用/);assert.equal(d.querySelector('#search-error').hidden,false);assert.match(d.querySelector('#search-error').textContent,/暂时不可用/);
});

test('new input aborts the active request and rejects a stale success even when the text cycles back',async t=>{
  const {w,s,calls}=await setup(t),clock=fakeTimers(w);let finish;
  w.api=(route,options)=>{calls.push({route,options});return new Promise(resolve=>{finish=resolve;});};
  s.query='old';const pending=w.fetchRecords();const signal=calls[0].options.signal;
  input(w,'new');input(w,'old');assert.equal(signal.aborted,true);
  finish({records:[{id:'stale'}],total:1,page:1});await pending;assert.equal(s.records.length,0);
  w.api=async()=>({records:[],total:0,page:1});await clock.run(500);assert.equal(s.searchOutcome,'success');
});

test('request abort is not treated as a service outage or an invalid session',async t=>{
  const {w,s,realApi}=await setup(t);let outages=0;w.handleServiceOffline=async()=>{outages++;};
  w.fetch=async()=>{throw new w.DOMException('aborted','AbortError');};
  await assert.rejects(realApi('/records/search'),{name:'AbortError'});assert.equal(outages,0);assert.equal(s.unlocked,true);
});

test('inserting a query field cancels earlier input work and waits for the condition value',async t=>{
  const {w,calls,s}=await setup(t),clock=fakeTimers(w);input(w,'old');w.insertSearchField('cid');
  assert.equal(s.query,'old cid:');await clock.run(500);assert.equal(calls.length,0);
});

test('leaving search suppresses the delayed request and returning resumes it; sealing clears it',async t=>{
  const {w,s,calls}=await setup(t),clock=fakeTimers(w);input(w,'wait');w.showWorkspace('datasets');await clock.run(500);assert.equal(calls.length,0);
  w.showWorkspace('search');await clock.run(500);assert.equal(calls.length,1);
  input(w,'sealed');await w.sealVault('',false);await clock.run(500);assert.equal(s.unlocked,false);assert.ok(calls.every(c=>!c.route.includes('q=sealed')));
});

test('desktop separators expose bounded values and keyboard resizing keeps the results usable',async t=>{
  const {w,d,s}=await setup(t);d.body.classList.add('detail-docked');w.applySearchLayout();
  const nav=d.querySelector('#search-navigation-resizer'),detail=d.querySelector('#search-detail-resizer');
  assert.equal(nav.getAttribute('role'),'separator');assert.equal(detail.hidden,false);
  key(w,nav,'ArrowRight');assert.equal(nav.getAttribute('aria-valuenow'),'232');
  key(w,detail,'ArrowLeft',{shiftKey:true});assert.equal(detail.getAttribute('aria-valuenow'),'544');
  key(w,detail,'End');const layout=w.applySearchLayout();assert.ok(layout.width-layout.navigation-layout.details>=520);
  assert.equal(detail.getAttribute('aria-valuenow'),detail.getAttribute('aria-valuemax'));
  key(w,nav,'Home');assert.equal(nav.getAttribute('aria-valuenow'),'176');
  key(w,nav,'Enter');assert.equal(nav.getAttribute('aria-valuenow'),'216');
  assert.equal(JSON.parse(w.localStorage.getItem('securevault-search-layout-v1')).navigation,216);
  s.workspace='editor';w.applySearchLayout();assert.equal(nav.hidden,true);assert.equal(detail.hidden,true);
});

test('pointer drag persists on release, Escape and pointer cancellation restore the original width',async t=>{
  const {w,d}=await setup(t),handle=d.querySelector('#search-navigation-resizer');
  pointer(w,handle,'pointerdown',216);pointer(w,handle,'pointermove',296);assert.equal(handle.getAttribute('aria-valuenow'),'296');
  pointer(w,handle,'pointerup',296);assert.equal(JSON.parse(w.localStorage.getItem('securevault-search-layout-v1')).navigation,296);
  pointer(w,handle,'pointerdown',296);pointer(w,handle,'pointermove',350);key(w,handle,'Escape');assert.equal(handle.getAttribute('aria-valuenow'),'296');assert.equal(d.body.classList.contains('resizing-search-columns'),false);
  pointer(w,handle,'pointerdown',296);pointer(w,handle,'pointermove',200);pointer(w,handle,'pointercancel',200);assert.equal(handle.getAttribute('aria-valuenow'),'296');
  handle.dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));assert.equal(handle.getAttribute('aria-valuenow'),'216');
});

test('saved widths survive responsive clamping, hide on mobile and do not resize other workspaces',async t=>{
  const {w,d,s}=await setup(t);d.body.classList.add('detail-docked');w.setSearchColumnWidth('details',680);w.saveSearchLayout();
  Object.defineProperty(w,'innerWidth',{value:1360,configurable:true});w.applySearchLayout();
  assert.ok(Number(d.querySelector('#search-detail-resizer').getAttribute('aria-valuenow'))<680);
  Object.defineProperty(w,'innerWidth',{value:390,configurable:true});w.applySearchLayout();
  assert.equal(d.querySelector('#search-detail-resizer').hidden,true);assert.equal(d.querySelector('#search-navigation-resizer').hidden,true);
  Object.defineProperty(w,'innerWidth',{value:1440,configurable:true});w.applySearchLayout();assert.equal(d.querySelector('#search-detail-resizer').getAttribute('aria-valuenow'),'680');
  w.localStorage.setItem('securevault-search-layout-v1','{"navigation":"999px","details":-4}');const prefs=w.readSearchLayout();assert.equal(prefs.navigation,216);assert.equal(prefs.details,340);
});

test('direct record deletion retains its confirmation and has no disclosure wrapper',async t=>{
  const {w,d,s}=await setup(t);s.datasets=[{id:'a',name:'A',category_path:'a',fields:[]}];
  w.api=async()=>({id:'r',dataset_id:'a',indexes:{},display:{},normal:{},protected_fields:[]});await w.openRecordDetail('r');
  const button=d.querySelector('#manual-delete-main');assert.equal(button.closest('details'),null);assert.equal(button.textContent,'删除记录');
  let confirms=0,writes=0;w.confirm=()=>{confirms++;return false;};w.api=async()=>{writes++;return {};};button.click();await tick();assert.equal(confirms,1);assert.equal(writes,0);
});

test('an invalid saved query stays open with local feedback and does not report a successful search',async t=>{
  const {w,d,s}=await setup(t);const filters={q:'code:',categories:[],labels:[],dataset_id:null,schema_id:null,include_expired:false};
  w.api=async()=>({queries:[{id:'bad',name:'未完成的查询',filters}]});await w.loadSavedQueries();
  d.querySelector('#saved-query-select').value='bad';d.querySelector('#saved-queries-modal').showModal();
  let searches=0;w.api=async()=>{searches++;return {records:[],total:0,page:1};};await w.applySavedQuery();
  assert.equal(searches,0);assert.equal(s.searchOutcome,'invalid');assert.equal(d.querySelector('#saved-queries-modal').open,true);
  assert.match(d.querySelector('#saved-query-status').textContent,/未执行检索/);
});

test('desktop navigation stays resizable in a smaller window with a clamped center minimum',async t=>{
  const {w,d}=await setup(t);Object.defineProperty(w,'innerWidth',{value:900,configurable:true});
  w.applySearchLayout();const handle=d.querySelector('#search-navigation-resizer');assert.equal(handle.hidden,false);
  key(w,handle,'End');const layout=w.applySearchLayout();assert.ok(layout.width-layout.navigation>=520);
  assert.equal(d.querySelector('#search-detail-resizer').hidden,true);
});
