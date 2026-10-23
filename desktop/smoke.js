(async () => {
  try {
    const waitFor = async predicate => {
      const deadline = Date.now() + 20000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error('等待界面状态超时'); await new Promise(resolve => setTimeout(resolve, 50)); }
    };
    await waitFor(() => typeof state !== 'undefined' && state.workbenchReady && window.secureVaultRequestClose);
    if (!window.__SECUREVAULT_DESKTOP__ || typeof saveDownload !== 'function') throw new Error('桌面桥接未加载');
    if ([...document.querySelectorAll('[data-desktop-only]')].some(element => element.hidden)) throw new Error('桌面目录入口未显示');
    const stage = sessionStorage.getItem('desktop-smoke-stage');
    const status = await api('/vault/status');
    if (stage === 'second') {
      if (status.initialized || state.unlocked) throw new Error('切换到新目录后仍显示旧保险库');
      const directory = await desktopInvoke('desktop_directory_info');
      if (!directory.endsWith('smoke-second-vault')) throw new Error('当前目录未更新');
      await api('/vault/setup', { method: 'POST', body: JSON.stringify({ password: 'SECOND_DESKTOP_SMOKE_ONLY_PASSWORD' }) });
      sessionStorage.setItem('desktop-smoke-stage', 'returned');
      await desktopInvoke('desktop_smoke_switch', { original: true });
      return;
    }
    if (stage === 'returned') {
      if (!status.initialized || !status.sealed || state.unlocked) throw new Error('原保险库未保留或自动解锁');
      await api('/vault/unlock', { method: 'POST', body: JSON.stringify({ password: sessionStorage.getItem('desktop-smoke-password') }) });
      const queries = await api('/saved-queries');
      if (!queries.queries.some(query => query.name === 'directory-switch-preserved')) throw new Error('原保险库数据丢失');
      await checkStatus();
      await sealVault();
      sessionStorage.clear();
      await desktopInvoke('desktop_smoke_result', { error: null });
      return;
    }
    if (status.initialized || state.unlocked) throw new Error('测试必须从空的封印保险库开始');
    const password = 'DESKTOP_SMOKE_ONLY_' + crypto.randomUUID();
    await api('/vault/setup', { method: 'POST', body: JSON.stringify({ password }) });
    await checkStatus();
    await waitFor(() => state.unlocked);
    const summary = await api('/vault/summary');
    if (summary.records !== 0) throw new Error('空保险库记录数异常');
    state.editorDirty = true;
    if (!hasUnsavedChanges()) throw new Error('退出保护未检测到编辑状态');
    state.editorDirty = false;
    await sealVault();
    if (state.unlocked) throw new Error('封印未清理界面状态');
    await api('/vault/unlock', { method: 'POST', body: JSON.stringify({ password }) });
    await checkStatus();
    await waitFor(() => state.unlocked);
    await api('/datasets');
    await api('/apps');
    await api('/saved-queries', { method: 'POST', body: JSON.stringify({ name: 'directory-switch-preserved', filters: { q: 'preserved value' } }) });
    sessionStorage.setItem('desktop-smoke-password', password);
    sessionStorage.setItem('desktop-smoke-stage', 'second');
    await desktopInvoke('desktop_smoke_switch', { original: false });
  } catch (error) {
    await window.__TAURI__.core.invoke('desktop_smoke_result', { error: String(error.stack || error) });
  }
})();
