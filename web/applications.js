// The application list, credential view and authorization editor share one source of state.
let applicationsRequest = 0;

function applicationStatus(app) {
  if (app.disabled) return { key: 'disabled', label: '已停用' };
  if (app.access_expires_at && app.access_expires_at * 1000 <= Date.now()) return { key: 'expired', label: '已到期' };
  if (!app.datasets?.length) return { key: 'unscoped', label: '未配置范围' };
  return { key: 'active', label: '可用' };
}
function applicationExpiry(app) {
  if (!app.access_expires_at) return '长期有效';
  const left = app.access_expires_at * 1000 - Date.now();
  if (left <= 0) return '需重新授权';
  const minutes = Math.ceil(left / 60000);
  return minutes < 60 ? `${minutes} 分钟后到期` : minutes < 1440 ? `${Math.ceil(minutes / 60)} 小时内到期` : `${Math.ceil(minutes / 1440)} 天内到期`;
}
function applicationDate(seconds) {
  return seconds ? new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false }) : '长期有效';
}
function applicationPermission(app) {
  return app.permission === 'secrets' ? '敏感信息查看' : '只读检索';
}
function applicationDataset(id) {
  return state.datasets.find(dataset => dataset.id === id);
}

function renderApplications() {
  const needle = $('#application-search').value.trim().toLowerCase();
  const filter = $('#application-filter').value;
  const apps = (state.apps || []).filter(app => `${app.name} ${app.id}`.toLowerCase().includes(needle)
    && (filter === 'all' || applicationStatus(app).key === filter));
  $('#application-count').textContent = apps.length === (state.apps || []).length ? `${apps.length} 个应用` : `${apps.length} / ${state.apps.length} 个应用`;
  $('#app-manager-list').innerHTML = apps.length ? `<div class="application-list-heading" aria-hidden="true"><span>应用</span><span>访问级别</span><span>授权范围</span><span>状态与期限</span><span>操作</span></div>${apps.map(app => {
    const status = applicationStatus(app);
    const datasets = app.datasets || [];
    const first = applicationDataset(datasets[0]);
    return `<article class="application-row" aria-label="${escapeHtml(app.name)}">
      <div class="application-name"><button class="application-name-button" data-app-view="${escapeHtml(app.id)}">${escapeHtml(app.name)}</button><code title="${escapeHtml(app.id)}">${escapeHtml(app.id)}</code></div>
      <div class="application-permission" data-label="访问级别"><span class="application-access ${app.permission === 'secrets' ? 'sensitive' : ''}">${applicationPermission(app)}</span></div>
      <div class="application-scope" data-label="授权范围"><span>${datasets.length} 个数据集</span><small>${escapeHtml((first ? datasetName(first) : '') || (datasets.length ? '查看授权明细' : '尚未授权'))}${datasets.length > 1 ? ` 等 ${datasets.length} 项` : ''}</small></div>
      <div class="application-state" data-label="状态与期限"><span class="application-status ${status.key}">${status.label}</span><small title="${escapeHtml(applicationDate(app.access_expires_at))}">${applicationExpiry(app)}</small></div>
      <div class="application-row-actions"><button class="clear-button" data-app-view="${escapeHtml(app.id)}">查看</button><button class="secondary-button app-configure" data-id="${escapeHtml(app.id)}">${status.key === 'expired' ? '重新授权' : '配置授权'}</button></div>
    </article>`;
  }).join('')}` : `<div class="application-empty"><h4>${state.apps?.length ? '没有匹配的应用' : '尚未接入应用'}</h4><p>${state.apps?.length ? '试试其他名称、应用 ID 或状态筛选。' : '创建应用，选择可访问的数据集，再保存应用 ID 和密钥。'}</p></div>`;
  $$('[data-app-view]').forEach(button => button.addEventListener('click', () => openAppDetails(button.dataset.appView)));
  $$('.app-configure').forEach(button => button.addEventListener('click', () => openAppScope(button.dataset.id)));
}

loadApps = async function() {
  const request = ++applicationsRequest;
  const epoch = state.sessionEpoch;
  const result = await api('/apps');
  if (!state.unlocked || epoch !== state.sessionEpoch || request !== applicationsRequest) return;
  state.apps = result.apps;
  $('#applications-error').hidden = true;
  renderApplications();
};

async function refreshApplications() {
  $('#refresh-apps').disabled = true;
  try { await loadApps(); }
  catch (error) { if (state.unlocked) { $('#applications-error').textContent = `列表刷新失败：${error.message}`; $('#applications-error').hidden = false; } }
  finally { $('#refresh-apps').disabled = false; }
}

async function copyApplicationId(id) {
  try { await navigator.clipboard.writeText(id); showToast('应用 ID 已复制', 'success'); }
  catch { showToast('无法复制，请手动选择应用 ID', 'error'); }
}

function openAppDetails(id) {
  const app = state.apps.find(item => item.id === id);
  if (!app || !state.canManage) return;
  state.appViewing = id;
  const status = applicationStatus(app);
  $('#app-details-title').textContent = app.name;
  $('#app-details-subtitle').textContent = '应用详情';
  $('#app-details-error').hidden = true;
  $('#app-details-content').innerHTML = `<div class="application-identity"><div><small>应用 ID</small><code>${escapeHtml(app.id)}</code></div><button id="copy-detail-app-id" class="clear-button" type="button">复制 ID</button></div>
    <dl class="application-facts"><div><dt>访问级别</dt><dd>${applicationPermission(app)}</dd></div><div><dt>应用状态</dt><dd><span class="application-status ${status.key}">${status.label}</span></dd></div><div><dt>授权到期</dt><dd>${escapeHtml(applicationDate(app.access_expires_at))}</dd></div></dl>
    <section class="application-granted"><h4>可访问的数据集 <span>${app.datasets?.length || 0}</span></h4>${app.datasets?.length ? `<ul>${app.datasets.map(id => { const dataset = applicationDataset(id); return `<li><div>${dataset ? `<button class="application-dataset-link" type="button" data-dataset-id="${escapeHtml(id)}" aria-label="查看数据集基本信息：${escapeHtml(datasetLocator(dataset))}">${escapeHtml(datasetLocator(dataset))}</button>` : '<strong>数据集已删除</strong>'}${!dataset ? `<code>${escapeHtml(id)}</code>` : ''}</div><span class="tag">${escapeHtml(datasetLabelText(dataset))}</span></li>`; }).join('')}</ul>` : '<p class="application-caption">尚未选择数据集，此应用无法读取任何数据。请先配置授权。</p>'}</section>`;
  $('#copy-detail-app-id').addEventListener('click', () => copyApplicationId(app.id));
  $$('#app-details-content .application-dataset-link').forEach(button => button.addEventListener('click', () => openDatasetInfo(button.dataset.datasetId)));
  $('#details-toggle').textContent = app.disabled ? '启用应用' : '停用应用';
  $('#details-toggle').classList.toggle('danger-button', !app.disabled);
  $('#details-authorize').textContent = status.key === 'expired' ? '重新授权' : '配置授权';
  for (const id of ['details-toggle', 'details-rotate', 'details-authorize']) $(`#${id}`).disabled = Boolean(state.appDetailBusy);
  openDialog('app-details-modal');
}
function closeAppDetails() {
  $('#app-details-modal').close();
  state.appViewing = null;
  $('#app-details-content').replaceChildren();
}
async function changeApplicationState() {
  const app = state.apps.find(item => item.id === state.appViewing);
  if (!app || state.appDetailBusy) return;
  if (app.disabled && ((app.access_expires_at && app.access_expires_at * 1000 <= Date.now()) || !app.datasets?.length)) { openAppScope(app.id); return; }
  if (!app.disabled && !window.confirm(`停用「${app.name}」？此应用将立即无法访问数据，之后可重新启用。`)) return;
  await maintainApplication(app, async () => {
    await api(`/apps/${encodeURIComponent(app.id)}`, { method: 'PATCH', body: JSON.stringify({ disabled: !app.disabled }) });
    return { disabled: !app.disabled, message: app.disabled ? '应用已启用' : '应用已停用' };
  });
}
async function rotateApplicationKey() {
  const app = state.apps.find(item => item.id === state.appViewing);
  if (!app || state.appDetailBusy || !window.confirm(`轮换「${app.name}」的密钥？旧密钥会立即失效，请同步更新接入端配置。`)) return;
  await maintainApplication(app, async () => {
    const result = await api(`/apps/${encodeURIComponent(app.id)}/rotate`, { method: 'POST' });
    return { key: result.key };
  });
}
async function maintainApplication(app, operation) {
  const epoch = state.sessionEpoch;
  const pending = {};
  state.appDetailBusy = pending;
  for (const id of ['details-toggle', 'details-rotate', 'details-authorize']) $(`#${id}`).disabled = true;
  try {
    const result = await operation();
    if (!state.unlocked || epoch !== state.sessionEpoch) return;
    if (result.key) { closeAppDetails(); showAppKey(result.key, app); }
    else {
      app.disabled = result.disabled;
      showToast(result.message, 'success');
      await refreshApplications();
      if (state.unlocked && state.appViewing === app.id) openAppDetails(app.id);
    }
  } catch (error) {
    if (state.unlocked && state.appViewing === app.id && epoch === state.sessionEpoch) { $('#app-details-error').textContent = error.message; $('#app-details-error').hidden = false; }
  } finally {
    if (state.appDetailBusy === pending) {
      state.appDetailBusy = null;
      for (const id of ['details-toggle', 'details-rotate', 'details-authorize']) $(`#${id}`).disabled = false;
    }
  }
}

function appScopeBody() {
  const body = { permission: $('#scope-permission').value, datasets: [...$('#scope-datasets').querySelectorAll('input:checked')].map(input => input.value) };
  if ($('#scope-ttl').value !== 'keep') body.access_ttl_seconds = Number($('#scope-ttl').value);
  if (state.scopeEditing?.create) body.name = $('#scope-name').value.trim();
  else body.disabled = false;
  return body;
}
function updateAppScope() {
  const needle = $('#scope-search').value.trim().toLowerCase();
  const onlySelected = $('#scope-only-selected').checked;
  const options = [...$('#scope-datasets').querySelectorAll('.app-dataset-option')];
  let visible = 0;
  for (const option of options) {
    option.hidden = !option.textContent.toLowerCase().includes(needle) || (onlySelected && !option.querySelector('input').checked);
    if (!option.hidden) visible++;
  }
  const selected = $('#scope-datasets').querySelectorAll('input:checked').length;
  $('#scope-count').textContent = `已选 ${selected} / ${options.length} 个`;
  $('#scope-empty').hidden = visible > 0;
  $('#scope-empty').textContent = !options.length ? '暂无数据集，请先在数据集页面创建数据集。' : onlySelected ? '没有匹配的已选数据集。取消“只看已选”可继续选择。' : '没有匹配的数据集，试试其他目录或环境。';
  $('#scope-select-visible').disabled = !visible || Boolean(state.scopeEditing?.busy);
  $('#scope-clear-visible').disabled = !visible || Boolean(state.scopeEditing?.busy);
  $('#scope-permission-note').textContent = $('#scope-permission').value === 'secrets'
    ? '允许检索、导出和按需查看敏感字段；隐藏加密字段不可查看。' : '允许检索、查看和导出公开数据；无法解密敏感字段。';
  $('#scope-permission-note').classList.toggle('sensitive-note', $('#scope-permission').value === 'secrets');
  const ttl = $('#scope-ttl').value;
  const app = state.apps?.find(item => item.id === state.scopeEditing?.id);
  const duration = ttl === 'keep' ? `到期时间保持为：${applicationDate(app?.access_expires_at)}` : ttl === '0' ? '保存后长期有效' : `保存后 ${Number(ttl) / 3600 >= 1 ? `${Number(ttl) / 3600} 小时` : `${Number(ttl) / 60} 分钟`}内有效`;
  $('#scope-summary').textContent = selected ? `可访问 ${selected} 个数据集。${duration}。` : '未选择数据集，保存后此应用无法读取任何数据。';
}
function openAppScope(id = null) {
  if (!state.canManage || state.scopeEditing?.busy) return;
  const app = id ? state.apps.find(item => item.id === id) : null;
  if (id && !app) return;
  closeAppDetails();
  const create = !app;
  const expired = app?.access_expires_at && app.access_expires_at * 1000 <= Date.now();
  $('#app-scope-title').textContent = create ? '创建应用' : `配置授权 · ${app.name}`;
  $('#scope-subtitle').textContent = create ? '选择访问范围，创建后保存一次性密钥。' : app.disabled ? '应用当前已停用，保存后将重新启用。' : expired ? '授权已到期，请选择新的授权期限。' : '修改访问范围，当前到期时间默认保持不变。';
  $('#scope-name-field').hidden = !create;
  $('#scope-name').required = create;
  $('#scope-name').value = '';
  $('#scope-permission').value = app?.permission || 'search';
  $('#scope-keep-expiry').hidden = create || Boolean(expired);
  $('#scope-ttl').value = create || expired ? '1800' : 'keep';
  $('#scope-datasets').innerHTML = state.datasets.map(dataset => `<label class="app-dataset-option"><input type="checkbox" value="${escapeHtml(dataset.id)}" ${(app?.datasets || []).includes(dataset.id) ? 'checked' : ''} /><span><strong>${escapeHtml(datasetLocator(dataset))}</strong><small>${escapeHtml(datasetLabelText(dataset))}</small></span></label>`).join('');
  $('#scope-search').value = '';
  $('#scope-only-selected').checked = false;
  $('#scope-error').hidden = true;
  state.scopeEditing = { id, create, epoch: state.sessionEpoch, busy: false };
  setScopeBusy(false);
  $('#save-app-scope').textContent = create ? '创建并生成密钥' : app.disabled || expired ? '保存并启用' : '保存授权';
  updateAppScope();
  state.scopeEditing.initial = JSON.stringify(appScopeBody());
  openDialog('app-scope-modal');
  if (create) $('#scope-name').focus();
}
function closeAppScope(force = false) {
  if (!force && state.scopeEditing?.busy) return;
  if (!force && state.scopeEditing && JSON.stringify(appScopeBody()) !== state.scopeEditing.initial && !window.confirm('放弃未保存的授权修改？')) return;
  $('#app-scope-modal').close();
  $('#scope-datasets').replaceChildren();
  $('#scope-name').value = '';
  state.scopeEditing = null;
}
function setScopeBusy(busy) {
  $('#app-scope-form').querySelectorAll('input, select, button').forEach(control => { control.disabled = busy; });
  if (!busy) updateAppScope();
}
async function saveAppScope(event) {
  event?.preventDefault();
  const editing = state.scopeEditing;
  if (!editing || editing.busy || !state.unlocked) return;
  const body = appScopeBody();
  if (editing.create && !body.name) { $('#scope-error').textContent = '请填写应用名称。'; $('#scope-error').hidden = false; $('#scope-name').focus(); return; }
  editing.busy = true;
  const label = $('#save-app-scope').textContent;
  setScopeBusy(true);
  $('#save-app-scope').textContent = editing.create ? '正在创建…' : '正在保存…';
  $('#scope-error').hidden = true;
  try {
    const result = await api(editing.create ? '/apps' : `/apps/${encodeURIComponent(editing.id)}`, { method: editing.create ? 'POST' : 'PATCH', body: JSON.stringify(body) });
    if (!state.unlocked || editing.epoch !== state.sessionEpoch || state.scopeEditing !== editing) return;
    closeAppScope(true);
    if (editing.create) showAppKey(result.key, { id: result.id, name: body.name });
    else showToast(body.disabled === false && label === '保存并启用' ? '授权已保存，应用已启用' : '应用授权已保存', 'success');
    await refreshApplications();
  } catch (error) {
    if (state.unlocked && state.scopeEditing === editing) { $('#scope-error').textContent = error.message; $('#scope-error').hidden = false; }
  } finally {
    editing.busy = false;
    if (!state.scopeEditing || state.scopeEditing === editing) {
      setScopeBusy(false);
      $('#save-app-scope').textContent = label;
    }
  }
}
function selectVisibleAppDatasets(checked) {
  $('#scope-datasets').querySelectorAll('.app-dataset-option:not([hidden]) input').forEach(input => { input.checked = checked; });
  updateAppScope();
}

$('#new-app-button').addEventListener('click', () => openAppScope());
$('#application-search').addEventListener('input', renderApplications);
$('#application-filter').addEventListener('change', renderApplications);
$('#refresh-apps').addEventListener('click', refreshApplications);
$('#close-app-details').addEventListener('click', closeAppDetails);
$('#app-details-modal').addEventListener('cancel', event => { event.preventDefault(); closeAppDetails(); });
$('#details-authorize').addEventListener('click', () => openAppScope(state.appViewing));
$('#details-toggle').addEventListener('click', changeApplicationState);
$('#details-rotate').addEventListener('click', rotateApplicationKey);
$('#copy-app-key-id').addEventListener('click', () => copyApplicationId($('#app-key-id').textContent));
for (const id of ['close-app-scope', 'cancel-app-scope']) $(`#${id}`).addEventListener('click', () => closeAppScope());
$('#app-scope-modal').addEventListener('cancel', event => { event.preventDefault(); closeAppScope(); });
$('#app-scope-form').addEventListener('submit', saveAppScope);
$('#scope-search').addEventListener('input', updateAppScope);
for (const id of ['scope-only-selected', 'scope-permission', 'scope-ttl', 'scope-datasets']) $(`#${id}`).addEventListener('change', updateAppScope);
$('#scope-select-visible').addEventListener('click', () => selectVisibleAppDatasets(true));
$('#scope-clear-visible').addEventListener('click', () => selectVisibleAppDatasets(false));

// Bootstrap after all workspace modules and their controls have been installed.
state.workbenchReady = true;
checkStatus();
