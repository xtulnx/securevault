// Applications share the same workspace and use one explicit authorization drawer.
loadApps = async function() {
  const result = await api('/apps');
  if (!state.unlocked) return;
  state.apps = result.apps;
  $('#app-manager-list').innerHTML = '<div class="application-table-header"><span>应用</span><span>访问级别</span><span>范围</span><span>状态与到期</span><span>操作</span></div>' + result.apps.map(app => {
    const expired = app.access_expires_at && app.access_expires_at * 1000 <= Date.now();
    return `<div class="dataset-manager-row app-manager-row"><div><strong>${escapeHtml(app.name)}</strong><code>${escapeHtml(app.id)}</code></div><span>${app.permission === 'secrets' ? '可获取敏感信息' : '只搜索'}</span><span>${app.datasets?.length || 0} 个数据集</span><div class="application-state"><span class="tag">${app.disabled ? '已停用' : '启用'}</span><span class="tag ${expired ? 'expired-tag' : ''}">${expired ? '授权已到期' : app.access_expires_at ? '限时授权' : '长期有效'}</span>${app.access_expires_at ? `<small>${escapeHtml(new Date(app.access_expires_at * 1000).toLocaleString())}</small>` : ''}</div><div class="row-actions"><button class="clear-button app-configure" data-id="${escapeHtml(app.id)}">配置授权</button><details class="row-menu"><summary aria-label="更多应用操作">⋯</summary><div><button class="app-toggle" data-id="${escapeHtml(app.id)}" data-disabled="${app.disabled}">${app.disabled ? '启用' : '停用'}</button><button class="app-rotate" data-id="${escapeHtml(app.id)}">轮换密钥</button></div></details></div></div>`;
  }).join('') + (!result.apps.length ? '<p class="detail-empty">暂无接入应用，创建后再配置可访问的数据集。</p>' : '');
  $$('.app-configure').forEach(button => button.addEventListener('click', () => openAppScope(button.dataset.id)));
  $$('.app-toggle').forEach(button => button.addEventListener('click', async () => {
    try { await api(`/apps/${encodeURIComponent(button.dataset.id)}`, { method: 'PATCH', body: JSON.stringify({ disabled: button.dataset.disabled !== 'true' }) }); await loadApps(); }
    catch (error) { showToast(error.message, 'error'); }
  }));
  $$('.app-rotate').forEach(button => button.addEventListener('click', async () => {
    if (!window.confirm('轮换密钥后，使用旧密钥的应用将无法访问。确认继续？')) return;
    try { const result = await api(`/apps/${encodeURIComponent(button.dataset.id)}/rotate`, { method: 'POST' }); showAppKey(result.key); }
    catch (error) { showToast(error.message, 'error'); }
  }));
};

function appScopeBody() {
  return { permission: $('#scope-permission').value, access_ttl_seconds: Number($('#scope-ttl').value), datasets: [...$('#scope-datasets').querySelectorAll('input:checked')].map(input => input.value) };
}
function updateAppScope() {
  const needle = $('#scope-search').value.toLowerCase();
  $('#scope-datasets').querySelectorAll('.app-dataset-option').forEach(option => { option.hidden = !option.textContent.toLowerCase().includes(needle); });
  $('#scope-count').textContent = `已选 ${$('#scope-datasets').querySelectorAll('input:checked').length} 个数据集`;
}
function openAppScope(id) {
  const app = state.apps.find(item => item.id === id);
  if (!app || !state.canManage) return;
  $('#app-scope-title').textContent = `配置授权 · ${app.name}`;
  $('#scope-permission').value = app.permission;
  const left = app.access_expires_at ? app.access_expires_at - Date.now() / 1000 : 0;
  $('#scope-ttl').value = !app.access_expires_at ? '0' : left <= 1800 ? '1800' : left <= 7200 ? '7200' : '28800';
  $('#scope-datasets').innerHTML = state.datasets.map(dataset => `<label class="app-dataset-option"><input type="checkbox" value="${escapeHtml(dataset.id)}" ${(app.datasets || []).includes(dataset.id) ? 'checked' : ''} /><span><strong>${escapeHtml(dataset.category_path)}</strong><small>${escapeHtml(dataset.environment || '未设置')}</small></span></label>`).join('');
  $('#scope-search').value = ''; $('#scope-error').hidden = true; updateAppScope();
  state.scopeEditing = { id, initial: JSON.stringify(appScopeBody()) }; openDialog('app-scope-modal');
}
function closeAppScope(force = false) {
  if (!force && state.scopeEditing && JSON.stringify(appScopeBody()) !== state.scopeEditing.initial && !window.confirm('放弃未保存的授权修改？')) return;
  $('#app-scope-modal').close(); $('#scope-datasets').replaceChildren(); state.scopeEditing = null;
}
async function saveAppScope() {
  const editing = state.scopeEditing; if (!editing) return;
  $('#save-app-scope').disabled = true;
  try {
    await api(`/apps/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(appScopeBody()) });
    if (!state.unlocked || state.scopeEditing !== editing) return;
    closeAppScope(true); await loadApps(); showToast('授权已保存并重新开启', 'success');
  } catch (error) { $('#scope-error').textContent = error.message; $('#scope-error').hidden = false; }
  finally { $('#save-app-scope').disabled = false; }
}
for (const id of ['close-app-scope', 'cancel-app-scope']) $(`#${id}`).addEventListener('click', () => closeAppScope());
$('#app-scope-modal').addEventListener('cancel', event => { event.preventDefault(); closeAppScope(); });
$('#save-app-scope').addEventListener('click', saveAppScope);
$('#scope-search').addEventListener('input', updateAppScope);
$('#scope-datasets').addEventListener('change', updateAppScope);

// Bootstrap after all workspace modules and their controls have been installed.
state.workbenchReady = true;
checkStatus();
