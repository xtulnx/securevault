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

async function copyApplicationId(id, button) {
  await copyWithFeedback(button, id, '应用 ID 已复制');
}

function applicationGuides() {
  return '<nav class="application-guides" aria-label="接入说明"><a href="guide.html?guide=httpyac" target="_blank" rel="noopener noreferrer">httpyac 接入说明</a><a href="guide.html?guide=raycast" target="_blank" rel="noopener noreferrer">Raycast 接入说明</a></nav>';
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
    <section class="application-granted"><h4>可访问的数据集 <span>${app.datasets?.length || 0}</span></h4>${app.datasets?.length ? `<ul>${app.datasets.map(id => { const dataset = applicationDataset(id); return `<li><div>${dataset ? `<button class="application-dataset-link" type="button" data-dataset-id="${escapeHtml(id)}" aria-label="查看数据集基本信息：${escapeHtml(datasetLocator(dataset))}">${escapeHtml(datasetLocator(dataset))}</button>` : '<strong>数据集已删除</strong>'}${!dataset ? `<code>${escapeHtml(id)}</code>` : ''}</div><span class="tag">${escapeHtml(datasetLabelText(dataset))}</span></li>`; }).join('')}</ul>` : '<p class="application-caption">尚未选择数据集，此应用无法读取任何数据。请先配置授权。</p>'}</section>${applicationGuides()}`;
  $('#copy-detail-app-id').addEventListener('click', event => copyApplicationId(app.id, event.currentTarget));
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
function renderAppScopeChanges() {
  const editing = state.scopeEditing;
  if (!editing) { $('#scope-summary').replaceChildren(); $('#scope-summary-status').textContent = ''; return; }
  const before = editing.baseline, after = appScopeBody();
  const previous = new Set(before.datasets), next = new Set(after.datasets);
  const added = [...next].filter(id => !previous.has(id)), removed = [...previous].filter(id => !next.has(id));
  const keep = after.datasets.length - added.length;
  const ttl = $('#scope-ttl').value;
  const duration = ttl === 'keep' ? `保持到期时间：${applicationDate(before.access_expires_at)}` : ttl === '0' ? '保存后长期有效' : `从保存起 ${Number(ttl) >= 3600 ? `${Number(ttl) / 3600} 小时` : `${Number(ttl) / 60} 分钟`}`;
  const expired = Boolean(before.access_expires_at && before.access_expires_at * 1000 <= Date.now());
  const permission = applicationPermission(after);
  const elevated = !editing.create && before.permission !== 'secrets' && after.permission === 'secrets';
  const status = editing.create ? '创建后启用' : before.disabled ? '保存后重新启用' : expired && ttl !== 'keep' ? '保存后恢复授权' : '保持启用';
  const expanded = new Set($$('#scope-summary details[open]').map(item => item.dataset.scopeDiff));
  const list = (kind, label, ids) => ids.length ? `<details data-scope-diff="${kind}" ${expanded.has(kind) ? 'open' : ''}><summary>${label} ${ids.length} 个数据集 · 查看清单</summary><ul>${ids.map(id => {
    const dataset = applicationDataset(id);
    return `<li>${escapeHtml(dataset ? `${datasetLocator(dataset)} · ${datasetLabelText(dataset)}` : `已删除或不可见的数据集（${id}）`)}</li>`;
  }).join('')}</ul></details>` : '';
  const warnings = [
    elevated ? '权限提升：将允许解密并查看所选数据集的敏感字段。' : '',
    before.disabled ? '此应用当前已停用；本次保存会重新启用。' : '',
    expired && ttl === 'keep' ? '授权已到期；保持到期时间不会恢复访问，请选择新的期限。' : '',
    !after.datasets.length ? '未选择数据集，保存后此应用无法读取任何数据。' : '',
  ].filter(Boolean);
  $('#scope-summary').innerHTML = `<h4>保存后的授权</h4><p class="scope-diff-counts">可访问 ${after.datasets.length} 个数据集 · 新增 ${added.length} · 移除 ${removed.length} · 保留 ${keep}</p><dl class="scope-change-facts"><div><dt>访问级别</dt><dd>${editing.create ? permission : `${applicationPermission(before)} → ${permission}`}${!editing.create && before.permission === after.permission ? '（不变）' : ''}</dd></div><div><dt>授权期限</dt><dd>${!editing.create && ttl !== 'keep' ? `原到期：${escapeHtml(applicationDate(before.access_expires_at))}<br>` : ''}${escapeHtml(duration)}</dd></div><div><dt>应用状态</dt><dd>${status}</dd></div></dl>${warnings.map(warning => `<p class="scope-change-warning">${escapeHtml(warning)}</p>`).join('')}${list('added', '新增', added)}${list('removed', '移除', removed)}`;
  $('#scope-summary-status').textContent = `可访问 ${after.datasets.length} 个数据集，新增 ${added.length}，移除 ${removed.length}。${permission}。${duration}。${warnings.join('')}`;
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
  for (const group of $$('#scope-datasets .scope-directory-group')) {
    const matches = [...group.querySelectorAll('.app-dataset-option')].filter(option => !option.hidden);
    group.hidden = !matches.length;
    group.querySelector('.scope-group-count').textContent = `${matches.length} 项匹配`;
  }
  const selected = $('#scope-datasets').querySelectorAll('input:checked').length;
  $('#scope-count').textContent = `已选 ${selected} / ${options.length} 个 · 匹配 ${visible} 个`;
  $('#scope-empty').hidden = visible > 0;
  $('#scope-empty').textContent = !options.length ? '暂无数据集，请先在数据集页面创建数据集。' : onlySelected ? '没有匹配的已选数据集。取消“只看已选”可继续选择。' : '没有匹配的数据集，试试其他目录或环境。';
  $('#scope-select-visible').disabled = !visible || Boolean(state.scopeEditing?.busy);
  $('#scope-clear-visible').disabled = !visible || Boolean(state.scopeEditing?.busy);
  $('#scope-permission-note').textContent = $('#scope-permission').value === 'secrets'
    ? '允许检索、导出和按需查看敏感字段；隐藏加密字段不可查看。' : '允许检索、查看和导出公开数据；无法解密敏感字段。';
  $('#scope-permission-note').classList.toggle('sensitive-note', $('#scope-permission').value === 'secrets');
  renderAppScopeChanges();
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
  const groups = new Map();
  for (const dataset of state.datasets) {
    const directory = dataset.category_path || '未分类';
    if (!groups.has(directory)) groups.set(directory, []);
    groups.get(directory).push(dataset);
  }
  $('#scope-datasets').innerHTML = [...groups].map(([directory, datasets]) => `<fieldset class="scope-directory-group"><legend>${escapeHtml(directory)} <span class="scope-group-count"></span></legend>${datasets.map(dataset => `<label class="app-dataset-option"><input type="checkbox" value="${escapeHtml(dataset.id)}" ${(app?.datasets || []).includes(dataset.id) ? 'checked' : ''} /><span><strong>${escapeHtml(datasetLocator(dataset))}</strong><small>${escapeHtml(datasetLabelText(dataset))}</small></span></label>`).join('')}</fieldset>`).join('');
  $('#scope-search').value = '';
  $('#scope-only-selected').checked = false;
  $('#scope-error').hidden = true;
  $('#scope-summary').replaceChildren();
  state.scopeEditing = { id, create, epoch: state.sessionEpoch, busy: false, baseline: { permission: app?.permission || 'search', datasets: [...(app?.datasets || [])], disabled: Boolean(app?.disabled), access_expires_at: app?.access_expires_at || null } };
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
  $('#scope-summary').replaceChildren(); $('#scope-summary-status').textContent = '';
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
$('#copy-app-key-id').addEventListener('click', event => copyApplicationId($('#app-key-id').textContent, event.currentTarget));
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

// Only owner status carries this summary. No events or mute choices persist locally.
function clearAuthorizationEvents() {
  state.authorizationEvents = [];
  state.authorizationNotice = null;
  state.authorizationEventsRevision = null;
  state.authorizationReturnFocus = null;
  state.authorizationEventsRequest = (state.authorizationEventsRequest || 0) + 1;
  state.authorizationEventsBusy = false;
  state.authorizationActionBusy = false;
  state.authorizationEventsLimit = 8;
  $('#authorization-events-list').replaceChildren();
  $('#authorization-events-status').textContent = '';
  $('#authorization-events-error').hidden = true;
  $('#authorization-events-more').hidden = true;
  $('#authorization-mute').disabled = false;
  renderAuthorizationNotice();
}
function renderAuthorizationNotice() {
  const button = $('#app-manager-button');
  const unread = state.authorizationNotice?.unread || 0;
  let badge = $('#authorization-notice-dot');
  if (!badge) { badge = document.createElement('span'); badge.id = 'authorization-notice-dot'; badge.className = 'authorization-notice-dot'; badge.setAttribute('aria-hidden', 'true'); button.append(badge); }
  badge.hidden = !unread;
  button.setAttribute('aria-label', unread ? `接入应用，${unread} 类新授权事件` : '接入应用');
}
function syncAuthorizationNotice(summary) {
  if (!summary) return;
  if ((state.authorizationNotice?.revision || 0) > summary.revision) return;
  const changed = state.authorizationEventsRevision !== summary.revision;
  const visibleUnread = (state.authorizationEvents || []).slice(0, state.authorizationEventsLimit || 8).some(event => event.unread);
  state.authorizationNotice = summary;
  renderAuthorizationNotice();
  if ((changed || visibleUnread) && state.unlocked && state.canManage && state.workspace === 'apps' && !document.hidden && !modalElement()) loadAuthorizationEvents();
}
const authorizationReasons = {
  expired: ['应用授权已到期', '延长授权期限后，应用才可继续访问。', '重新授权'],
  disabled: ['应用已停用', '若仍需接入，可在配置授权中确认范围并重新启用。', '配置授权'],
  no_datasets: ['没有可访问的数据集', '未授权数据集，或原授权数据集已删除。空检索结果不代表授权已就绪。', '选择数据集'],
  dataset_scope: ['目标数据集未授权', '请核对调用目标与授权范围；仅授予确有需要的数据集。', '配置数据集'],
  secrets_permission: ['无敏感信息查看权限', '当前仅允许公开数据访问。确需敏感信息时，请审核后调整访问级别。', '审核权限'],
  owner_required: ['请求了管理接口', '此接口仅允许管理员会话使用。请调整接入端调用，应用授权无法开放此接口。', null],
};
function renderAuthorizationEvents() {
  const events = state.authorizationEvents || [];
  const muted = Boolean(state.authorizationNotice?.muted);
  const focus = document.activeElement?.closest('[data-auth-action]');
  const focusKey = focus ? [focus.dataset.authAction, focus.dataset.eventId] : null;
  $('#authorization-mute').textContent = muted ? '恢复本次解锁提醒' : '本次解锁不再提醒';
  $('#authorization-mute').setAttribute('aria-pressed', String(muted));
  $('#authorization-events-status').textContent = muted ? '本次解锁已关闭红点提醒，事件仍会记录；重新解锁后恢复。' : events.length ? `${events.length} 类事件 · 查看后标为已读；相同原因持续发生时仅更新次数。` : '本次解锁暂无授权事件。';
  $('#authorization-events-list').innerHTML = events.slice(0, state.authorizationEventsLimit || 8).map(event => {
    const [title, explanation, action] = authorizationReasons[event.reason] || ['访问受阻', '请核对应用接入配置。', null];
    const app = state.apps?.find(app => app.id === event.app_id);
    const operation = { search: '检索', detail: '记录详情', reveal: '敏感信息查看', export: '导出', datasets: '获取数据集', management: '管理操作' }[event.operation] || '访问';
    return `<article class="authorization-event"><div class="authorization-event-body"><h5>${escapeHtml(event.app_name)}<span>${escapeHtml(title)}</span>${event.ignored ? '<small>已忽略此类</small>' : ''}</h5><p>${escapeHtml(explanation)}</p><small><code>${escapeHtml(event.app_id)}</code> · ${operation} · ${escapeHtml(applicationDate(event.last_at))} · ${event.count} 次</small></div><div class="authorization-event-actions">${app ? `<button class="secondary-button" type="button" data-auth-action="${action ? 'configure' : 'view'}" data-event-id="${event.id}">${action || '查看应用'}</button>` : '<span class="application-caption">应用已删除</span>'}${event.reason === 'no_datasets' && !state.datasets.length ? `<button class="clear-button" type="button" data-auth-action="datasets" data-event-id="${event.id}">管理数据集</button>` : ''}${!event.ignored ? `<button class="clear-button" type="button" data-auth-action="ignore" data-event-id="${event.id}" aria-label="忽略 ${escapeHtml(event.app_name)} 的${escapeHtml(title)}事件">忽略此类</button>` : ''}</div></article>`;
  }).join('');
  $('#authorization-events-more').hidden = events.length <= (state.authorizationEventsLimit || 8);
  if (focusKey) [...$('#authorization-events-list').querySelectorAll('[data-auth-action]')].find(button => button.dataset.authAction === focusKey[0] && button.dataset.eventId === focusKey[1])?.focus();
}
async function acknowledgeAuthorizationEvents(body) {
  const epoch = state.sessionEpoch, session = state.sessionId;
  const result = await api('/apps/authorization-events', { method: 'POST', body: JSON.stringify({ session_id: session, ...body }) });
  if (!state.unlocked || epoch !== state.sessionEpoch || result.session_id !== session) return false;
  if ((state.authorizationNotice?.revision || 0) <= result.summary.revision) state.authorizationNotice = result.summary;
  renderAuthorizationNotice();
  return true;
}
async function loadAuthorizationEvents() {
  if (!state.unlocked || !state.canManage || state.authorizationEventsBusy || state.authorizationActionBusy || modalElement()) return;
  const epoch = state.sessionEpoch, session = state.sessionId;
  const request = state.authorizationEventsRequest = (state.authorizationEventsRequest || 0) + 1;
  state.authorizationEventsBusy = true;
  const current = () => state.unlocked && epoch === state.sessionEpoch && request === state.authorizationEventsRequest;
  try {
    const result = await api('/apps/authorization-events');
    if (!current() || result.session_id !== session || !Array.isArray(result.events) || modalElement()) return;
    state.authorizationEvents = result.events;
    state.authorizationEventsRevision = result.summary.revision;
    if ((state.authorizationNotice?.revision || 0) <= result.summary.revision) state.authorizationNotice = result.summary;
    $('#authorization-events-error').hidden = true;
    renderAuthorizationNotice(); renderAuthorizationEvents();
    // Only acknowledge a rendered snapshot while the page is visible. New groups after
    // this snapshot stay unread; polling and merely clicking the navigation do not clear them.
    const seen = result.events.slice(0, state.authorizationEventsLimit || 8).filter(event => event.unread).map(event => event.id);
    if (state.workspace === 'apps' && !document.hidden && !modalElement() && seen.length) {
      if (await acknowledgeAuthorizationEvents({ seen_ids: seen }) && current()) {
        state.authorizationEvents.forEach(event => { if (seen.includes(event.id)) event.unread = false; });
      }
    }
  } catch (error) {
    if (current()) { $('#authorization-events-error').textContent = `授权事件加载失败：${error.message}。请点击刷新重试。`; $('#authorization-events-error').hidden = false; }
  } finally { if (current()) state.authorizationEventsBusy = false; }
}
async function changeAuthorizationReminder(body) {
  if (state.authorizationActionBusy || !state.unlocked) return;
  const epoch = state.sessionEpoch;
  state.authorizationActionBusy = true;
  // A fetch started before this action must not restore an older event snapshot.
  state.authorizationEventsRequest = (state.authorizationEventsRequest || 0) + 1;
  state.authorizationEventsBusy = false;
  $('#authorization-mute').disabled = true;
  $$('#authorization-events-list button').forEach(button => { button.disabled = true; });
  try {
    if (await acknowledgeAuthorizationEvents(body)) {
      if (body.ignore_id) { const event = state.authorizationEvents?.find(event => event.id === body.ignore_id); if (event) { event.ignored = true; event.unread = false; } }
      renderAuthorizationEvents();
      if (body.ignore_id) $('#authorization-events-status').focus();
    }
  } catch (error) {
    if (state.unlocked && epoch === state.sessionEpoch) { $('#authorization-events-error').textContent = `提醒设置未保存：${error.message}`; $('#authorization-events-error').hidden = false; }
  } finally {
    if (epoch === state.sessionEpoch) { state.authorizationActionBusy = false; $('#authorization-mute').disabled = false; $$('#authorization-events-list button').forEach(button => { button.disabled = false; }); }
  }
}
$('#authorization-events-status').tabIndex = -1;
$('#authorization-mute').addEventListener('click', () => changeAuthorizationReminder({ muted: !state.authorizationNotice?.muted }));
$('#authorization-events-list').addEventListener('click', event => {
  const button = event.target.closest('[data-auth-action]');
  if (!button || state.authorizationActionBusy) return;
  const entry = state.authorizationEvents?.find(item => String(item.id) === button.dataset.eventId);
  if (!entry) return;
  if (button.dataset.authAction === 'ignore') changeAuthorizationReminder({ ignore_id: entry.id });
  else if (button.dataset.authAction === 'datasets') openDatasetManager();
  else if (button.dataset.authAction === 'configure') {
    state.authorizationReturnFocus = { id: entry.id, action: 'configure', epoch: state.sessionEpoch };
    openAppScope(entry.app_id);
    const control = { expired: '#scope-ttl', disabled: '#scope-ttl', secrets_permission: '#scope-permission', no_datasets: '#scope-search', dataset_scope: '#scope-search' }[entry.reason];
    if (control) $(control)?.focus();
  } else { state.authorizationReturnFocus = { id: entry.id, action: 'view', epoch: state.sessionEpoch }; openAppDetails(entry.app_id); }
});
function restoreAuthorizationEventFocus() {
  const target = state.authorizationReturnFocus;
  if (!target || !state.unlocked || target.epoch !== state.sessionEpoch || state.workspace !== 'apps' || modalElement()) return;
  const active = document.activeElement;
  if (active !== document.body && !active?.closest('#app-scope-modal, #app-details-modal') && !active?.matches('[data-auth-action]')) return;
  const button = [...$('#authorization-events-list').querySelectorAll('[data-auth-action]')].find(button => button.dataset.eventId === String(target.id) && button.dataset.authAction === target.action);
  (button || $('#app-manager-button')).focus();
  state.authorizationReturnFocus = null;
}
for (const id of ['app-scope-modal', 'app-details-modal']) $(`#${id}`).addEventListener('close', () => setTimeout(restoreAuthorizationEventFocus, 0));
$('#authorization-events-more').addEventListener('click', () => { state.authorizationEventsLimit = (state.authorizationEventsLimit || 8) + 20; renderAuthorizationEvents(); loadAuthorizationEvents(); });
$('#refresh-apps').addEventListener('click', loadAuthorizationEvents);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.workspace === 'apps') loadAuthorizationEvents();
});
clearAuthorizationEvents();
