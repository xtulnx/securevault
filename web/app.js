const state = {
  initialized: false,
  canManage: false,
  selectedDatasetId: null,
  unlocked: false,
  datasets: [],
  records: [],
  directories: [],
  summary: { records: 0, datasets: 0, protected_fields: 0 },
  query: "",
  category: "all",
  environment: "all",
  includeExpired: false,
  pendingBatchId: null,
  importTemplates: [],
  page: 1,
  pageSize: 40,
  total: 0,
  reveal: null,
  pendingReveal: null,
  secretModalRecordId: null,
  recordDetail: null,
  detailRevealRequest: 0,
  detailLoadRequest: 0,
  workspace: "search",
  securityReturn: "search",
  passwordChangeBusy: false,
  importReturn: "search",
  editorReturn: "search",
  editorReturnScroll: 0,
  timer: null,
  searchTimer: null,
  unlockAt: 0,
  lastActivity: 0,
  idleTimeout: 1800,
  maxSeconds: 14400
  ,persistent: false,
  theme: localStorage.getItem("securevault-theme") || "light"
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function searchNeedles() {
  return [...new Set(state.query.split(/\s+/).flatMap((token) => {
    const value = token.includes(":") ? token.slice(token.indexOf(":") + 1) : token;
    return [token, value].filter((item) => item.length > 0);
  }))].sort((a, b) => b.length - a.length);
}

function highlightValue(value) {
  const text = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
  const needles = searchNeedles();
  if (!needles.length) return escapeHtml(text);
  const pattern = new RegExp(`(${needles.map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    output += escapeHtml(text.slice(cursor, match.index));
    output += `<mark class="search-hit">${escapeHtml(match[0])}</mark>`;
    cursor = match.index + match[0].length;
  }
  return output + escapeHtml(text.slice(cursor));
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
  } catch (error) {
    await handleServiceOffline();
    throw error;
  }
  if (response.status === 503) await handleServiceOffline();
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 423 || (response.status === 401 && state.unlocked)) sealVault("会话已失效，请重新解锁", false);
    throw new Error(body.error || `请求失败 (${response.status})`);
  }
  return body;
}

function showToast(message, kind = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${kind}`;
  toast.textContent = message;
  $("#toast-region").appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => { toast.classList.remove("show"); setTimeout(() => toast.remove(), 250); }, 2600);
}

function setSealedView() {
  $("#app").classList.remove("is-unsealed");
  $("#app").classList.add("is-sealed");
}

function applyTheme(theme = state.theme) {
  state.theme = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("securevault-theme", state.theme);
  const button = $("#theme-toggle");
  if (button) { button.querySelector("span").textContent = state.theme === "light" ? "☾" : "☼"; button.querySelector("b").textContent = state.theme === "light" ? "暗色" : "浅色"; }
}

let statusCheckPending = false;

function setServiceStatus(status) {
  const label = { checking: "正在检测服务…", online: "服务在线", offline: "服务离线" }[status];
  $$('[data-service-status]').forEach((element) => {
    element.dataset.serviceStatus = status;
    element.querySelector('[data-service-status-label]').textContent = label;
  });
  $(".unlock-button").disabled = status !== "online";
}

async function handleServiceOffline() {
  setServiceStatus("offline");
  if (state.unlocked) await sealVault("服务连接已中断，数据空间已封印；服务恢复后请重新解锁", false);
}

async function checkStatus() {
  if (statusCheckPending) return;
  statusCheckPending = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  let status;
  try {
    status = await api("/vault/status", { cache: "no-store", signal: controller.signal });
    if (typeof status.initialized !== "boolean" || typeof status.sealed !== "boolean" || typeof status.persistent !== "boolean") {
      throw new Error("无效的服务状态响应");
    }
    setServiceStatus("online");
  } catch {
    await handleServiceOffline();
    return;
  } finally {
    clearTimeout(timeout);
    statusCheckPending = false;
  }
  try {
    state.canManage = Boolean(status.can_manage ?? !status.sealed);
    state.initialized = status.initialized;
    state.persistent = Boolean(status.persistent);
    $("#confirm-password-label").hidden = status.initialized;
    $("#confirm-password-wrap").hidden = status.initialized;
    $("#confirm-password").required = !status.initialized;
    $("#master-password").autocomplete = status.initialized ? "current-password" : "new-password";
    $("#master-password").minLength = status.initialized ? 1 : 12;
    $("#vault-mode-note").textContent = status.initialized ? "主密码用于解封数据密钥，不会保存明文。" : "首次使用请设置至少 12 个字符的主密码。";
    $(".unlock-button").lastChild.textContent = status.initialized ? " 解锁数据空间" : " 创建安全数据空间";
    if (status.sealed && state.unlocked) {
      await sealVault("服务端会话已失效，请重新解锁", false);
    }
    if (!status.sealed && state.canManage && !state.unlocked) {
      state.unlocked = true;
      const now = Date.now();
      state.unlockAt = now - (state.maxSeconds - (status.ttl_seconds_remaining ?? state.maxSeconds)) * 1000;
      state.lastActivity = now - (state.idleTimeout - (status.idle_seconds_remaining ?? state.idleTimeout)) * 1000;
      $("#app").classList.remove("is-sealed");
      $("#app").classList.add("is-unsealed");
      await loadWorkspace();
      startWatchdog();
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function unlockVault(event) {
  event.preventDefault();
  const password = $("#master-password").value;
  try {
    if (!state.initialized) {
      if ([...password].length < 12) throw new Error("主密码至少需要 12 个字符");
      if (password !== $("#confirm-password").value) throw new Error("两次输入的主密码不一致");
      await api("/vault/setup", { method: "POST", body: JSON.stringify({ password }) });
      state.initialized = true;
    } else {
      await api("/vault/unlock", { method: "POST", body: JSON.stringify({ password }) });
    }
    state.unlocked = true;
    state.canManage = true;
    state.unlockAt = Date.now();
    state.lastActivity = state.unlockAt;
    $("#app").classList.remove("is-sealed");
    $("#app").classList.add("is-unsealed");
    $("#master-password").value = "";
    $("#confirm-password").value = "";
    await loadWorkspace();
    startWatchdog();
    showToast("数据空间已解锁", "success");
  } catch (error) {
    showToast(error.message, "error");
    $("#master-password").select();
  }
}

async function sealVault(message = "数据空间已手动封印", callServer = true) {
  clearInterval(state.timer);
  state.unlocked = false;
  state.canManage = false;
  state.persistent = false;
  state.reveal = null;
  closeRecordDetail();
  if (typeof clearManualData === "function") clearManualData();
  $("#dataset-info-modal").close();
  $("#secrets-modal").hidden = true;
  $("#reveal-modal").hidden = true;
  $("#app-manager-modal").hidden = true;
  state.secretModalRecordId = null;
  showWorkspace("search");
  state.pendingReveal = null;
  state.pendingBatchId = null;
  state.currentBatchSources = [];
  $("#records-grid").replaceChildren();
  $("#secret-fields-list").replaceChildren();
  state.records = [];
  state.datasets = [];
  state.directories = [];
  renderDatasetActions();
  setSealedView();
  $("#batch-options").hidden = true; $("#batch-summary").hidden = true;
  $("#mapping-list").replaceChildren();
  $("#first-schema-fields").replaceChildren();
  $("#master-password").value = "";
  $("#confirm-password").value = "";
  if (callServer) await api("/vault/seal", { method: "POST" }).catch(() => {});
  showToast(message, "info");
}

function startWatchdog() {
  clearInterval(state.timer);
  state.timer = setInterval(() => {
    if (!state.unlocked) return;
    const now = Date.now();
    const idleLeft = state.idleTimeout - Math.floor((now - state.lastActivity) / 1000);
    const maxLeft = state.maxSeconds - Math.floor((now - state.unlockAt) / 1000);
    const remaining = Math.min(idleLeft, maxLeft);
    $("#idle-countdown").textContent = state.persistent ? "持续" : formatCountdown(Math.max(0, remaining));
    if (state.reveal && state.reveal.expiresAt <= Date.now()) {
      state.reveal = null;
    }
    if (state.secretModalRecordId) renderSecretFields();
    if (state.recordDetail) {
      const timer = $("#detail-protected-fields .secret-timer");
      if (!state.reveal && timer) renderDetailSecrets();
      else if (timer) timer.textContent = `${Math.max(0, Math.ceil((state.reveal.expiresAt - now) / 1000))}s`;
    }
    if (!state.persistent && remaining <= 0) sealVault("会话已超时并自动封印");
  }, 1000);
}

function formatCountdown(seconds) {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function touch() { if (state.unlocked) state.lastActivity = Date.now(); }

async function loadWorkspace() {
  const [datasets, tree, summary] = await Promise.all([
    api("/datasets"), api("/datasets/tree"), api("/vault/summary")
  ]);
  state.datasets = datasets.datasets;
  state.directories = tree.directories;
  state.summary = summary;
  await fetchRecords();
  renderCategoryTree();
  renderFilters();
  renderIndexReference();
  renderStats();
}

async function fetchRecords() {
  const params = new URLSearchParams({ q: state.query, page: String(state.page), limit: String(state.pageSize) });
  const dataset = currentDataset();
  if (dataset) params.set("dataset_id", dataset.id);
  if (state.category !== "all") params.set("category", state.category);
  if (state.environment !== "all") params.set("environment", state.environment);
  if (state.includeExpired) params.set("include_expired", "true");
  const result = await api(`/records/search?${params}`);
  const byId = new Map(state.datasets.map((dataset) => [dataset.id, dataset]));
  state.records = result.records.map((record) => {
    const dataset = byId.get(record.dataset_id);
    const labels = Object.fromEntries((dataset?.fields || []).map((field) => [field.source_key, field.display_name || field.source_key]));
    for (const [key, label] of Object.entries(record.supplement?.field_labels || {})) labels[`supplement.${key}`] = `附表 · ${label}`;
    return { ...record, fieldLabels: labels };
  });
  state.total = result.total;
  state.page = result.page;
  renderRecords();
  renderDatasetActions();
}

function environments() {
  const selected = state.datasets.filter((dataset) => state.category === "all" || dataset.category_path === state.category || dataset.category_path.startsWith(`${state.category}/`));
  return [...new Set(selected.map((dataset) => dataset.environment).filter(Boolean))].sort();
}

function categoryNodes() {
  return state.directories.map((item) => {
    const parts = item.path.split("/");
    return { path: item.path, name: parts.at(-1), depth: parts.length - 1, count: item.count };
  });
}

function renderCategoryTree() {
  $("#all-category-count").textContent = state.summary.records;
  $("#all-categories").classList.toggle("selected", state.category === "all");
  $("#category-tree").innerHTML = categoryNodes().map((node) => `<button class="tree-node ${state.category === node.path ? "selected" : ""}" data-category-path="${escapeHtml(node.path)}" style="--depth:${node.depth}"><span class="tree-branch">${node.depth ? "└" : ""}</span><span class="folder-icon">▰</span><b>${escapeHtml(node.name)}</b><em>${node.count}</em></button>`).join("");
  $("#active-category-path").textContent = state.category === "all" ? "ALL DATASETS" : state.category;
  $$('[data-category-path]').forEach((button) => button.addEventListener("click", () => selectCategory(button.dataset.categoryPath)));
}

function renderFilters() {
  $("#environment-filters").innerHTML = ["all", ...environments()].map((item) => `<button class="filter-chip ${state.environment === item ? "selected" : ""}" data-environment="${escapeHtml(item)}">${item === "all" ? "全部环境" : escapeHtml(item)}</button>`).join("");
  $$('[data-environment]').forEach((button) => button.addEventListener("click", async () => {
    state.environment = button.dataset.environment;
    state.selectedDatasetId = null;
    state.page = 1;
    await fetchRecords();
    renderFilters();
    renderIndexReference();
  }));
}

function datasetsInCurrentDirectory() {
  const dataset = currentDataset();
  if (dataset) return [dataset];
  return state.datasets.filter((dataset) => state.category === "all" || dataset.category_path === state.category || dataset.category_path.startsWith(`${state.category}/`));
}

function datasetCandidates() {
  if (state.category === "all") return [];
  return state.datasets.filter((dataset) => (dataset.category_path === state.category || dataset.category_path.startsWith(`${state.category}/`)) && (state.environment === "all" || dataset.environment === state.environment));
}

function currentDataset() {
  const candidates = datasetCandidates();
  return candidates.find((dataset) => dataset.id === state.selectedDatasetId) || (candidates.length === 1 ? candidates[0] : null);
}

function renderDatasetActions() {
  const container = $("#dataset-context-actions");
  const candidates = datasetCandidates();
  const dataset = currentDataset();
  container.hidden = !state.unlocked || !candidates.length;
  if (container.hidden) { container.replaceChildren(); return; }
  const icons = {
    view: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    edit: '<path d="m16 3 5 5-12 12-6 1 1-6L16 3Z"/><path d="m14 5 5 5"/>',
    supplement: '<path d="M4 4h16v16H4zM4 10h16M10 4v16"/>',
    new: '<path d="M12 4v16M4 12h16"/>',
    import: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6"/>',
  };
  const actions = [{ action: "view", label: "查看数据集" }, ...(state.canManage ? [{ action: "edit", label: "编辑数据集" }, { action: "import", label: "导入到此数据集" }, { action: "new", label: "新增主表记录" }, { action: "supplement", label: "管理数据集附表" }] : [])];
  const chooser = candidates.length > 1 || !dataset ? `<select id="search-dataset-select" aria-label="选择具体数据集"><option value="">当前目录全部数据集</option>${candidates.map((item) => `<option value="${escapeHtml(item.id)}" ${dataset?.id === item.id ? "selected" : ""}>${escapeHtml(item.category_path)} · ${escapeHtml(item.environment || "无环境")}</option>`).join("")}</select>` : "";
  container.innerHTML = chooser + (dataset ? actions.map(({ action, label }) => `<button type="button" class="icon-button dataset-context-action" data-action="${action}" title="${label}" aria-label="${label}"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[action]}</svg></button>`).join("") : "");
  $("#search-dataset-select")?.addEventListener("change", async (event) => {
    state.selectedDatasetId = event.target.value || null;
    state.page = 1;
    try { await fetchRecords(); renderIndexReference(); } catch (error) { showToast(error.message, "error"); }
  });
  container.querySelectorAll('[data-action]').forEach((button) => button.addEventListener("click", () => {
    if (button.dataset.action === "view") openDatasetInfo(dataset.id);
    else if (button.dataset.action === "edit") openDatasetEdit(dataset.id);
    else if (button.dataset.action === "new") openManualRecord("main", dataset.id);
    else if (button.dataset.action === "supplement") openSupplement(dataset.id);
    else openImport(dataset.id);
  }));
}

function insertSearchField(field) {
  const input = $("#search-input");
  const prefix = input.value.trim();
  input.value = `${prefix}${prefix ? " " : ""}${field}:`;
  state.query = input.value;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function renderIndexReference() {
  const datasets = datasetsInCurrentDirectory();
  const groups = datasets.map((dataset) => {
    const fields = [...(dataset.fields || []).filter((field) => field.zone === "indexes"), ...(dataset.supplement_fields || []).filter((field) => field.zone === "indexes").map((field) => ({ ...field, source_key: `supplement.${field.source_key}`, display_name: `附表 · ${field.display_name || field.source_key}` }))];
    if (!fields.length) return "";
    const buttons = fields.map((field) => `<button type="button" class="index-field-token" data-query-field="${escapeHtml(field.source_key)}" title="插入 ${escapeHtml(field.source_key)}:"><code>${escapeHtml(field.source_key)}</code>${field.display_name && field.display_name !== field.source_key ? `<span>${escapeHtml(field.display_name)}</span>` : ""}</button>`).join("");
    return `<div class="index-reference-group"><div><strong>${escapeHtml(dataset.category_path)}</strong><span>${dataset.environment ? escapeHtml(dataset.environment) : "无环境"}</span></div><div class="index-field-list">${buttons}</div></div>`;
  }).filter(Boolean);
  $("#index-reference-content").innerHTML = groups.join("") || '<p class="detail-empty">当前目录下没有已定义的索引字段。</p>';
  $$("[data-query-field]").forEach((button) => button.addEventListener("click", () => insertSearchField(button.dataset.queryField)));
}

async function selectCategory(category) {
  state.category = category;
  state.categories = [];
  state.selectedDatasetId = null;
  if (!environments().includes(state.environment)) state.environment = "all";
  state.page = 1;
  await fetchRecords();
  renderCategoryTree();
  renderFilters();
  renderIndexReference();
}

function allDisplay(record) {
  const dataset = state.datasets.find((item) => item.id === record.dataset_id);
  const display = record.display || {};
  const values = { ...record.indexes, ...display };
  const configured = (dataset?.list_fields || []).filter((field) => field.visible !== false).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  let result;
  if (configured.length) {
    result = configured.reduce((result, field) => {
      if (!(field.source_key in values)) return result;
      const value = values[field.source_key];
      result[field.source_key] = field.format === "json" && typeof value === "object" ? JSON.stringify(value) : value;
      return result;
    }, {});
  }
  else if (!Object.keys(display).length) result = { 分类: record.category, ...(record.environment ? { 环境: record.environment } : {}), ...record.indexes };
  else {
    result = { ...display };
    for (const [key, value] of Object.entries(record.indexes || {})) if ((record.matched_fields || []).includes(key)) result[key] = value;
  }
  for (const [key, value] of Object.entries(record.supplement?.display || {})) result[`supplement.${key}`] = value;
  for (const [key, value] of Object.entries(record.supplement?.indexes || {})) if ((record.matched_fields || []).includes(`supplement.${key}`)) result[`supplement.${key}`] = value;
  return result;
}

function recordCard(record) {
  const dataset = state.datasets.find((item) => item.id === record.dataset_id);
  const titleField = (dataset?.list_fields || []).filter((field) => field.visible !== false).sort((a, b) => (a.position ?? 0) - (b.position ?? 0))[0];
  const displayEntries = Object.entries(allDisplay(record)).filter(([key]) => key !== titleField?.source_key);
  const matched = new Set(record.matched_fields || []);
  const visibleEntries = [...displayEntries.filter(([key]) => matched.has(key)), ...displayEntries.filter(([key]) => !matched.has(key))].filter((entry, index, all) => all.findIndex((item) => item[0] === entry[0]) === index);
  const displayMarkup = visibleEntries.map(([key, value]) => { const format = dataset?.list_fields?.find((field) => field.source_key === key)?.format || "single_line"; return `<div class="data-point ${matched.has(key) ? "is-match" : ""}"><label>${highlightValue(record.fieldLabels[key] || key)}</label><span class="display-format-${escapeHtml(format)}" title="${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}">${highlightValue(value)}</span></div>`; }).join("");
  const environmentTag = record.environment ? `<span class="tag environment">${escapeHtml(record.environment)}</span>` : `<span class="tag optional-tag">无环境</span>`;
  const titleValue = titleField ? { ...record.indexes, ...record.display }[titleField.source_key] : null;
  const title = titleValue == null || titleValue === "" ? "未命名记录" : titleValue;
  return `<article class="record-card ${record.expired ? "is-expired" : ""}"><div class="record-head"><div class="record-title"><div class="record-tags"><span class="tag">${highlightValue(record.category)}</span>${environmentTag}${record.expired ? '<span class="tag expired-tag">已过期</span>' : ""}</div><h4>${highlightValue(title)}</h4><button class="detail-button" data-action="open-detail" data-record="${escapeHtml(record.id)}">查看全部详情</button></div></div><div class="record-display">${displayMarkup}</div><div class="record-secrets"><span class="secret-count">${record.secret_count} 个敏感字段</span>${record.secret_count ? `<button class="reveal-secrets-button" data-action="open-secrets" data-record="${escapeHtml(record.id)}">按需查看 <span>→</span></button>` : ""}</div><div class="card-footer"><span>最近更新 ${escapeHtml(record.updated)}</span><button class="expired-toggle" data-expired-record="${escapeHtml(record.id)}" data-expired="${record.expired}">${record.expired ? "恢复有效" : "标记过期"}</button></div></article>`;
}

function renderRecords() {
  $("#records-grid").innerHTML = state.records.map(recordCard).join("");
  $("#empty-state").hidden = state.total > 0;
  const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
  $("#pagination").hidden = state.total <= state.pageSize;
  $("#page-status").textContent = `第 ${state.page} / ${pages} 页`;
  $("#previous-page").disabled = state.page <= 1;
  $("#next-page").disabled = state.page >= pages;
  $("#result-summary").textContent = `${state.total} 条记录`;
  $$('[data-action="open-secrets"]').forEach((button) => button.addEventListener("click", () => openSecrets(button.dataset.record)));
  $$('[data-action="open-detail"]').forEach((button) => button.addEventListener("click", () => openRecordDetail(button.dataset.record)));
  $$('[data-expired-record]').forEach((button) => button.addEventListener("click", async () => {
    try { const expired = button.dataset.expired !== "true"; await api(`/records/${encodeURIComponent(button.dataset.expiredRecord)}/expired`, { method: "POST", body: JSON.stringify({ expired }) }); await refreshAfterWrite(); }
    catch (error) { showToast(error.message, "error"); }
  }));
}

function renderStats() {
  $("#record-count").textContent = String(state.summary.records).padStart(2, "0");
  $("#namespace-count").textContent = String(state.summary.datasets).padStart(2, "0");
  $("#secret-count").textContent = String(state.summary.protected_fields).padStart(2, "0");
}

function datasetOptions() {
  $("#import-dataset-select").innerHTML = state.datasets.map((dataset) => `<option value="${escapeHtml(dataset.id)}">${escapeHtml(dataset.category_path)}${dataset.environment ? ` · ${escapeHtml(dataset.environment)}` : ""}</option>`).join("");
  $("#import-button").disabled = state.datasets.length === 0;
}

async function refreshAfterWrite() {
  await loadWorkspace();
  datasetOptions();
}

async function showSecret(recordId, fieldName) {
  const result = await api(`/records/${encodeURIComponent(recordId)}/secrets/reveal`, { method: "POST", body: JSON.stringify({ field_name: fieldName }) });
  return result.value;
}

function openSecrets(recordId) {
  state.secretModalRecordId = recordId;
  const record = state.records.find((item) => item.id === recordId);
  $("#secrets-record-meta").textContent = `${record.category}${record.environment ? ` · ${record.environment}` : ""}`;
  renderSecretFields();
  $("#secrets-modal").hidden = false;
}

function detailRows(values, labels = {}) {
  return Object.entries(values || {}).map(([key, value]) => `<div class="detail-row"><span>${escapeHtml(labels[key] || key)}</span><strong>${highlightValue(value)}</strong></div>`).join("") || '<p class="detail-empty">无字段</p>';
}

async function openRecordDetail(recordId) {
  const request = ++state.detailLoadRequest;
  try {
    const detail = await api(`/records/${encodeURIComponent(recordId)}`);
    if (!state.unlocked || request !== state.detailLoadRequest) return;
    const dataset = state.datasets.find((item) => item.id === detail.dataset_id);
    const labels = Object.fromEntries((dataset?.fields || []).map((field) => [field.source_key, field.display_name || field.source_key]));
    $("#record-detail-title").textContent = labels.alias ? `${labels.alias} · 记录详情` : "记录详情";
    $("#record-detail-meta").textContent = `${detail.category}${detail.environment ? ` · ${detail.environment}` : ""}${detail.expired ? " · 已过期" : ""}`;
    state.reveal = null;
    state.recordDetail = { ...detail, labels };
    $("#record-detail-content").innerHTML = `${state.canManage ? `<div class="row-actions"><button id="manual-edit-main" class="secondary-button">编辑主表记录</button><button id="manual-delete-main" class="secondary-button danger-button">删除主表记录</button></div>` : ""}<section class="detail-section"><h4>索引字段</h4>${detailRows(detail.indexes, labels)}</section><section class="detail-section"><h4>展示字段</h4>${detailRows(detail.display, labels)}</section><section class="detail-section"><h4>普通字段</h4>${detailRows(detail.normal, labels)}</section><section class="detail-section"><h4>受保护字段</h4><p class="protected-fields-help">敏感字段可在此临时查看，30 秒后恢复掩码。</p><div id="detail-protected-fields"></div></section><section class="detail-section"><h4>附表扩展数据</h4><div id="record-supplement-content"></div></section>`;
    renderDetailSecrets();
    if (typeof renderRecordSupplement === "function") renderRecordSupplement(detail);
    $("#manual-edit-main")?.addEventListener("click", () => openManualRecord("main", detail.dataset_id, detail.id));
    $("#manual-delete-main")?.addEventListener("click", async () => {
      if (!window.confirm("删除此主表记录？它的附表数据将保留，可在附表管理中处理。")) return;
      try { await api(`/records/${encodeURIComponent(detail.id)}`, { method: "DELETE" }); closeRecordDetail(); await refreshAfterWrite(); } catch (error) { showToast(error.message, "error"); }
    });
    $("#record-detail-modal").hidden = false;
  } catch (error) { showToast(error.message, "error"); }
}

function closeRecordDetail() {
  state.detailLoadRequest++;
  state.detailRevealRequest++;
  state.recordDetail = null;
  state.reveal = null;
  $("#record-detail-modal").hidden = true;
  $("#record-detail-content").replaceChildren();
}

function renderDetailSecrets() {
  const detail = state.recordDetail;
  if (!detail) return;
  $("#detail-protected-fields").innerHTML = (detail.protected_fields || []).map((field) => {
    const revealed = state.reveal?.recordId === detail.id && state.reveal.field === field.field_name && state.reveal.expiresAt > Date.now();
    const remaining = revealed ? Math.ceil((state.reveal.expiresAt - Date.now()) / 1000) : 0;
    return `<div class="detail-row protected"><span>${escapeHtml(detail.labels[field.field_name] || field.field_name)}<small>${field.zone === "hidden" ? "隐藏加密字段" : "敏感字段"}</small></span><strong><span class="detail-secret-value ${revealed ? "revealed" : ""}">${escapeHtml(revealed ? state.reveal.value : field.masked)}</span>${field.zone === "secrets" ? `<span class="detail-secret-actions">${revealed ? `<span class="secret-timer">${remaining}s</span>` : ""}<button class="detail-secret-button" data-field="${escapeHtml(field.field_name)}">${revealed ? "立即隐藏" : "按需查看"}</button></span>` : '<small>仅加密存储，不可查看</small>'}</strong></div>`;
  }).join("") || '<p class="detail-empty">无受保护字段</p>';
  $$(".detail-secret-button").forEach((button) => button.addEventListener("click", async () => {
    const field = button.dataset.field;
    const request = ++state.detailRevealRequest;
    if (state.reveal?.recordId === detail.id && state.reveal.field === field) {
      state.reveal = null;
      renderDetailSecrets();
      return;
    }
    button.disabled = true;
    touch();
    try {
      const value = await showSecret(detail.id, field);
      if (state.recordDetail !== detail || request !== state.detailRevealRequest || !state.unlocked) return;
      state.reveal = { recordId: detail.id, field, value: typeof value === "string" ? value : JSON.stringify(value), expiresAt: Date.now() + 30000 };
    } catch (error) { showToast(error.message, "error"); }
    renderDetailSecrets();
  }));
}

function showWorkspace(page) {
  closeDatasetDownloads();
  if (state.workspace === "security" && page !== "security") clearPasswordChange();
  state.workspace = page;
  const sections = { security: "security-workspace", search: "search-workspace", datasets: "dataset-manager-modal", editor: "dataset-modal", import: "import-modal" };
  Object.entries(sections).forEach(([name, id]) => { $(`#${id}`).hidden = name !== page; });
  window.scrollTo({ top: 0 });
}

function clearPasswordChange() {
  $("#change-password-form").reset();
  $("#password-change-status").textContent = "";
}

function openSecuritySettings() {
  if (state.passwordChangeBusy) return;
  if (state.workspace !== "security") state.securityReturn = state.workspace;
  clearPasswordChange();
  showWorkspace("security");
  $("#rotation-current-password").focus();
}

async function changeMasterPassword(event) {
  event.preventDefault();
  if (state.passwordChangeBusy) return;
  const currentPassword = $("#rotation-current-password").value;
  const newPassword = $("#rotation-new-password").value;
  const confirmation = $("#rotation-confirm-password").value;
  const status = $("#password-change-status");
  if ([...newPassword].length < 12) { status.textContent = "新主密码至少需要 12 个字符"; return; }
  if (newPassword !== confirmation) { status.textContent = "两次输入的新主密码不一致"; return; }
  if (currentPassword === newPassword) { status.textContent = "新主密码必须与当前密码不同"; return; }
  state.passwordChangeBusy = true;
  ["#submit-password-change", "#cancel-password-change", "#close-security"].forEach((id) => { $(id).disabled = true; });
  status.textContent = "正在安全更换密码，请勿关闭页面…";
  try {
    const result = await api("/vault/password", { method: "POST", body: JSON.stringify({ current_password: currentPassword, new_password: newPassword, confirm_password: confirmation }) });
    await sealVault("主密码已更换，请使用新密码重新解锁", false);
    if (result.durability_warning) showToast("密码已生效，但磁盘持久化确认失败。请保留新密码并检查存储状态。", "error");
    if (result.audit_warning) showToast("密码已生效，但审计记录写入失败。", "error");
  } catch (error) {
    status.textContent = `${error.message}。若网络中断，请重新解锁确认密码状态。`;
    $("#rotation-current-password").value = "";
    $("#rotation-new-password").value = "";
    $("#rotation-confirm-password").value = "";
    showToast(error.message, "error");
  } finally {
    state.passwordChangeBusy = false;
    ["#submit-password-change", "#cancel-password-change", "#close-security"].forEach((id) => { $(id).disabled = false; });
  }
}

function openDatasetEditor() {
  state.editorReturn = state.workspace;
  state.editorReturnScroll = window.scrollY;
  $("#close-dataset").textContent = state.editorReturn === "search" ? "← 返回检索" : "← 返回数据集管理";
  showWorkspace("editor");
}

function returnFromDatasetEditor() {
  state.editDatasetId = null;
  if (state.editorReturn === "datasets") renderDatasetManager();
  showWorkspace(state.editorReturn);
  window.scrollTo({ top: state.editorReturnScroll });
}

function openDatasetManager() {
  $("#export-with-secrets").checked = false;
  renderDatasetManager();
  showWorkspace("datasets");
}

function openImport(datasetId = null) {
  if (!state.canManage) return;
  const preferred = typeof datasetId === "string" ? datasetId : currentDataset()?.id;
  state.importReturn = state.workspace === "search" ? "search" : "datasets";
  datasetOptions();
  if (preferred) $("#import-dataset-select").value = preferred;
  showWorkspace("import");
}

function closeDatasetDownloads() {
  $$(".dataset-download-menu").forEach((menu) => { menu.hidden = true; });
  $$(".dataset-download-toggle").forEach((button) => button.setAttribute("aria-expanded", "false"));
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".dataset-download")) closeDatasetDownloads();
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const toggle = $(".dataset-download-toggle[aria-expanded='true']");
  if (toggle) { closeDatasetDownloads(); toggle.focus(); }
});

function openDatasetEdit(datasetId) {
  if (!state.canManage) return;
  const dataset = state.datasets.find((item) => item.id === datasetId);
  if (!dataset) return;
  state.editDatasetId = dataset.id;
  $("#dataset-title").textContent = "编辑数据集属性";
  $("#dataset-help").textContent = "编辑目录、描述和字段性质。Schema 可在导入时继续演进。";
  $("#dataset-category").value = dataset.category_path;
  $("#dataset-environment").value = dataset.environment || "";
  $("#dataset-description").value = dataset.description || "";
  updateDatasetDescriptionPreview();
  renderSchemaFields((dataset.fields || []).map(field => ({ ...field, unique: (dataset.identity_fields || []).includes(field.source_key) })));
  renderListConfig(dataset.fields || [], dataset.list_fields || []);
  $("#save-dataset").innerHTML = "保存修改";
  openDatasetEditor();
}

function renderDatasetManager() {
  $("#dataset-manager-list").innerHTML = state.datasets.map((dataset) => `<div class="dataset-manager-row"><div><strong>${escapeHtml(dataset.category_path)}</strong><span>${dataset.environment ? `环境：${escapeHtml(dataset.environment)}` : "无环境标签"} · ${dataset.record_count} 条记录 · ${dataset.fields.length} 个字段 · KEY ${dataset.identity_fields.length ? escapeHtml(dataset.identity_fields.join(" + ")) : "未设置"}</span></div><div class="row-actions"><div class="dataset-download"><button class="secondary-button dataset-download-toggle" aria-expanded="false" aria-controls="download-${escapeHtml(dataset.id)}"><span aria-hidden="true">⤓</span> 下载 <span aria-hidden="true">▾</span></button><div id="download-${escapeHtml(dataset.id)}" class="dataset-download-menu" hidden><span class="download-menu-label">选择下载格式</span>${["json", "csv", "xlsx"].map((format) => `<button class="dataset-export-button" data-format="${format}" data-dataset-id="${escapeHtml(dataset.id)}">${format.toUpperCase()}</button>`).join("")}</div></div><button class="secondary-button dataset-view-button" data-dataset-id="${escapeHtml(dataset.id)}">查看</button><button class="secondary-button dataset-supplement-button" data-dataset-id="${escapeHtml(dataset.id)}">附表</button><button class="secondary-button dataset-new-record-button" data-dataset-id="${escapeHtml(dataset.id)}">新增记录</button><button class="secondary-button dataset-edit-button" data-dataset-id="${escapeHtml(dataset.id)}">编辑</button></div></div>`).join("") || '<p class="detail-empty">暂无数据集</p>';
  $$(".dataset-view-button").forEach((button) => button.addEventListener("click", () => openDatasetInfo(button.dataset.datasetId)));
  $$(".dataset-supplement-button").forEach((button) => button.addEventListener("click", () => openSupplement(button.dataset.datasetId)));
  $$(".dataset-new-record-button").forEach((button) => button.addEventListener("click", () => openManualRecord("main", button.dataset.datasetId)));
  $$(".dataset-edit-button").forEach((button) => button.addEventListener("click", () => openDatasetEdit(button.dataset.datasetId)));
  $$(".dataset-download-toggle").forEach((button) => button.addEventListener("click", () => {
    const menu = button.nextElementSibling;
    const open = menu.hidden;
    closeDatasetDownloads();
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  }));
  $$(".dataset-export-button").forEach((button) => button.addEventListener("click", () => {
    closeDatasetDownloads();
    button.closest(".dataset-download").querySelector(".dataset-download-toggle").focus();
    exportDataset(button.dataset.datasetId, button.dataset.format, $("#export-with-secrets").checked);
  }));
}

function updateDatasetDescriptionPreview() {
  $("#dataset-description-preview").innerHTML = renderMarkdown($("#dataset-description").value);
}

function openDatasetInfo(datasetId) {
  const dataset = state.datasets.find((item) => item.id === datasetId);
  if (!dataset) return;
  const zones = { indexes: "索引字段", display: "展示字段", secrets: "敏感字段（按需查看）", hidden: "隐藏加密字段", normal: "普通字段（仅详情展示）", ignore: "忽略字段（不保存）" };
  const formats = { single_line: "单行截断", multiline: "多行换行", json: "JSON" };
  const identity = new Set(dataset.identity_fields || []);
  const fields = [...dataset.fields].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const visible = (dataset.list_fields?.length ? dataset.list_fields : fields.filter((field) => ["indexes", "display"].includes(field.zone))).filter((field) => field.visible !== false && fields.some((definition) => definition.source_key === field.source_key && ["indexes", "display"].includes(definition.zone))).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  $("#dataset-info-content").innerHTML = `<dl class="dataset-info-summary"><div><dt>目录路径</dt><dd>${escapeHtml(dataset.category_path)}</dd></div><div><dt>环境标签</dt><dd>${escapeHtml(dataset.environment || "未设置")}</dd></div><div><dt>记录数量</dt><dd>${dataset.record_count} 条</dd></div><div><dt>字段数量</dt><dd>${fields.length} 个</dd></div><div><dt>逻辑唯一 KEY</dt><dd>${escapeHtml([...identity].join(" + ") || "未设置")}</dd></div><div><dt>重复处理</dt><dd>${dataset.conflict_strategy === "allow_mark" ? "允许导入并标记重复" : escapeHtml(dataset.conflict_strategy)}</dd></div></dl><section class="dataset-description-section"><h4>数据集描述</h4><div class="markdown-content">${dataset.description?.trim() ? renderMarkdown(dataset.description) : '<p class="dataset-info-note">暂无描述，可在编辑数据集中添加。</p>'}</div></section><h4>字段定义</h4><div class="dataset-info-table-wrap"><table class="dataset-info-table"><thead><tr><th>源字段</th><th>可读名称</th><th>数据区域</th><th>唯一 KEY</th></tr></thead><tbody>${fields.map((field) => `<tr><td>${escapeHtml(field.source_key)}</td><td>${escapeHtml(field.display_name || field.source_key)}</td><td>${escapeHtml(zones[field.zone] || field.zone)}</td><td>${identity.has(field.source_key) ? "是" : "—"}</td></tr>`).join("") || '<tr><td colspan="4">尚未定义字段</td></tr>'}</tbody></table></div><h4>检索列表展示</h4><p class="dataset-info-note">按展示顺序排列；普通、敏感、隐藏和忽略字段不会直接显示在检索列表中。</p><div class="dataset-info-table-wrap"><table class="dataset-info-table"><thead><tr><th>字段</th><th>展示名称</th><th>展示形式</th></tr></thead><tbody>${visible.map((field) => `<tr><td>${escapeHtml(field.source_key)}</td><td>${escapeHtml(field.display_name || field.source_key)}</td><td>${escapeHtml(formats[field.format || "single_line"] || field.format)}</td></tr>`).join("") || '<tr><td colspan="3">未配置可见字段</td></tr>'}</tbody></table></div>`;
  closeDatasetDownloads();
  $("#dataset-info-modal").showModal();
}

async function exportDataset(datasetId, format = "json", includeSecrets = false) {
  try {
    const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/export?format=${format}&include_secrets=${includeSecrets}`, { headers: { Accept: format === "xlsx" ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : format === "csv" ? "text/csv" : "application/json" } });
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `导出失败 (${response.status})`); }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `securevault-${datasetId}.${format}`; anchor.click(); URL.revokeObjectURL(url);
    showToast(`数据集已导出为 ${format.toUpperCase()}（${includeSecrets ? "包含机密" : "不含机密"}）`, "success");
  } catch (error) { showToast(error.message, "error"); }
}

async function loadApps() {
  const result = await api("/apps");
  $("#app-manager-list").innerHTML = result.apps.map((app) => {
    const selected = new Set(app.datasets || []);
    const expired = app.access_expires_at && app.access_expires_at * 1000 <= Date.now();
    const expiryText = app.access_expires_at ? (expired ? "授权已到期" : `授权至 ${new Date(app.access_expires_at * 1000).toLocaleString()}`) : "授权长期有效";
    const ttlSelection = !app.access_expires_at ? 0 : Math.max(0, app.access_expires_at - Math.floor(Date.now() / 1000)) <= 1800 ? 1800 : Math.max(0, app.access_expires_at - Math.floor(Date.now() / 1000)) <= 7200 ? 7200 : 28800;
    const choices = state.datasets.map((dataset) => `<label class="app-dataset-option"><input type="checkbox" value="${escapeHtml(dataset.id)}" ${selected.has(dataset.id) ? "checked" : ""}/><span><strong>${escapeHtml(dataset.category_path)}</strong><small>${dataset.environment ? escapeHtml(dataset.environment) : "无环境"}</small></span></label>`).join("") || '<p class="detail-empty">暂无可授权的数据集</p>';
    return `<div class="dataset-manager-row app-manager-row" data-app-row="${escapeHtml(app.id)}"><div><strong>${escapeHtml(app.name)}</strong><span>${escapeHtml(app.id)} · ${app.permission === "secrets" ? "可获取敏感信息" : "只搜索"} · 可见 ${selected.size} 个数据集 · ${app.disabled ? "已禁用" : "启用"} · ${escapeHtml(expiryText)}</span></div><div class="row-actions"><button class="secondary-button app-configure" data-id="${escapeHtml(app.id)}">配置权限</button><button class="secondary-button app-toggle" data-id="${escapeHtml(app.id)}" data-disabled="${app.disabled}">${app.disabled ? "启用" : "禁用"}</button><button class="secondary-button app-rotate" data-id="${escapeHtml(app.id)}">轮换 Key</button></div><div class="app-dataset-editor" hidden><label>访问级别<select class="app-permission-edit"><option value="search" ${app.permission === "search" ? "selected" : ""}>只搜索</option><option value="secrets" ${app.permission === "secrets" ? "selected" : ""}>可获取敏感信息</option></select></label><label>授权时效<select class="app-ttl-edit"><option value="1800" ${ttlSelection === 1800 ? "selected" : ""}>30 分钟</option><option value="7200" ${ttlSelection === 7200 ? "selected" : ""}>2 小时</option><option value="28800" ${ttlSelection === 28800 ? "selected" : ""}>8 小时</option><option value="0" ${ttlSelection === 0 ? "selected" : ""}>长期有效</option></select></label><div class="app-dataset-heading"><strong>可见数据集</strong><span>未勾选的数据集不可搜索、查看、解密或导出</span></div><div class="app-dataset-options">${choices}</div><div class="dialog-actions"><button class="primary-button app-save-scope" data-id="${escapeHtml(app.id)}">保存授权并重新开启</button></div></div></div>`;
  }).join("") || '<p class="detail-empty">暂无接入应用</p>';
  $$(".app-configure").forEach((button) => button.addEventListener("click", () => { const editor = button.closest(".app-manager-row").querySelector(".app-dataset-editor"); editor.hidden = !editor.hidden; button.textContent = editor.hidden ? "配置权限" : "收起配置"; }));
  $$(".app-save-scope").forEach((button) => button.addEventListener("click", async () => { try { const row = button.closest(".app-manager-row"); const datasets = [...row.querySelectorAll(".app-dataset-option input")].filter((input) => input.checked).map((input) => input.value); const permission = row.querySelector(".app-permission-edit").value; const access_ttl_seconds = Number(row.querySelector(".app-ttl-edit").value); await api(`/apps/${encodeURIComponent(button.dataset.id)}`, { method: "PATCH", body: JSON.stringify({ datasets, permission, access_ttl_seconds }) }); await loadApps(); showToast("应用授权已保存并重新开启", "success"); } catch (error) { showToast(error.message, "error"); } }));
  $$(".app-toggle").forEach((button) => button.addEventListener("click", async () => { try { await api(`/apps/${encodeURIComponent(button.dataset.id)}`, { method: "PATCH", body: JSON.stringify({ disabled: button.dataset.disabled !== "true" }) }); await loadApps(); } catch (error) { showToast(error.message, "error"); } }));
  $$(".app-rotate").forEach((button) => button.addEventListener("click", async () => { try { const result = await api(`/apps/${encodeURIComponent(button.dataset.id)}/rotate`, { method: "POST" }); showAppKey(result.key); } catch (error) { showToast(error.message, "error"); } }));
}

function renderSecretFields() {
  const record = state.records.find((item) => item.id === state.secretModalRecordId);
  if (!record) return;
  const fields = Array.isArray(record.secret_fields) ? record.secret_fields : [];
  $("#secret-fields-list").innerHTML = fields.map((field) => {
    const revealed = state.reveal?.recordId === record.id && state.reveal.field === field && state.reveal.expiresAt > Date.now();
    const remaining = revealed ? Math.ceil((state.reveal.expiresAt - Date.now()) / 1000) : 0;
    return `<div class="secret-row"><span class="secret-name" title="${escapeHtml(field)}">${escapeHtml(record.fieldLabels[field] || field)}</span><span class="secret-value ${revealed ? "revealed" : ""}">${revealed ? escapeHtml(state.reveal.value) : "••••••••••••••••"}</span><span class="secret-actions">${revealed ? `<span class="secret-timer">${remaining}s</span>` : ""}<button class="secret-action" data-secret-action="reveal" data-field="${escapeHtml(field)}" title="${revealed ? "隐藏字段" : "显式查看"}">${revealed ? "◌" : "◉"}</button><button class="secret-action" data-secret-action="copy" data-field="${escapeHtml(field)}" title="静默复制">▢</button></span></div>`;
  }).join("");
  $$('[data-secret-action]').forEach((button) => button.addEventListener("click", () => handleSecretAction(button.dataset.secretAction, button.dataset.field)));
}

async function handleSecretAction(action, field) {
  const recordId = state.secretModalRecordId;
  touch();
  try {
    if (action === "copy") {
      const value = await showSecret(recordId, field);
      if (!navigator.clipboard?.writeText) throw new Error("剪贴板不可用，请检查浏览器权限");
      await navigator.clipboard.writeText(typeof value === "string" ? value : JSON.stringify(value));
      showToast(`${field} 已复制到剪贴板`, "success");
      return;
    }
    if (state.reveal?.recordId === recordId && state.reveal.field === field) {
      state.reveal = null;
      renderSecretFields();
      return;
    }
    const value = await showSecret(recordId, field);
    state.reveal = { recordId, field, value: typeof value === "string" ? value : JSON.stringify(value), expiresAt: Date.now() + 30000 };
    renderSecretFields();
  } catch (error) { showToast(error.message, "error"); }
}

function moveRowToPosition(row, rowSelector, value, refresh) {
  const container = row.parentElement;
  const rows = [...container.querySelectorAll(rowSelector)];
  if (!rows.length) return;
  const requested = Number(value);
  if (!String(value).trim() || !Number.isInteger(requested)) { refresh(); return; }
  const target = Math.max(0, Math.min(rows.length - 1, requested - 1));
  const current = rows.indexOf(row);
  if (current < 0 || current === target) { refresh(); return; }
  if (target >= rows.length - 1) container.append(row);
  else container.insertBefore(row, rows[target + (target < current ? 0 : 1)]);
  refresh();
}

function renderSchemaFields(fields) {
  $("#schema-fields").innerHTML = fields.map((field, index) => `<div class="schema-field" data-original-source="${escapeHtml(field.source_key)}">${rowOrderControl(index, "字段顺序")}<input class="schema-source-key-input" value="${escapeHtml(field.source_key)}" aria-label="字段名称" /><input class="schema-field-label" value="${escapeHtml(field.display_name || field.source_key)}" aria-label="字段显示名称" /><select class="schema-field-zone" aria-label="字段区域">${fieldZoneOptions(field.zone)}</select><label class="schema-unique"><input class="schema-field-unique" type="checkbox" ${field.unique ? "checked" : ""} />唯一 KEY</label><span class="schema-order"><button type="button" data-schema-move="up" ${index === 0 ? "disabled" : ""} title="上移一行">↑</button><button type="button" data-schema-move="down" ${index === fields.length - 1 ? "disabled" : ""} title="下移一行">↓</button></span></div>`).join("");
  $("#schema-preview").hidden = false;
  $("#schema-preview .schema-column-head").hidden = !fields.length;
  $$('[data-schema-move]').forEach((button) => button.addEventListener("click", () => { const row = button.closest(".schema-field"); const sibling = button.dataset.schemaMove === "up" ? row.previousElementSibling : row.nextElementSibling; if (!sibling) return; if (button.dataset.schemaMove === "up") row.parentElement.insertBefore(row, sibling); else row.parentElement.insertBefore(sibling, row); renderSchemaOrderButtons(); }));
  bindRowOrder($("#schema-fields"), ".schema-field", renderSchemaOrderButtons);
  bindSchemaZoneControls($("#schema-fields"), true);
  renderSchemaOrderButtons();
}

function fieldZoneOptions(zone) {
  return Object.entries({ indexes: "索引字段", display: "展示字段", normal: "普通字段（仅详情）", secrets: "敏感字段", hidden: "隐藏加密字段", ignore: "忽略字段（不保存）" }).map(([value, label]) => `<option value="${value}" ${zone === value ? "selected" : ""}>${label}</option>`).join("");
}

function bindSchemaZoneControls(container, updateList = false) {
  container.querySelectorAll('.schema-field').forEach((row) => {
    const zone = row.querySelector('.schema-field-zone');
    const unique = row.querySelector('.schema-field-unique');
    const sync = () => {
      unique.disabled = zone.value === "ignore";
      if (unique.disabled) unique.checked = false;
    };
    sync();
    zone.addEventListener('change', () => {
      sync();
      if (updateList) {
        const fields = [...container.querySelectorAll('.schema-field')].map((field) => ({ source_key: field.querySelector('.schema-source-key-input').value.trim(), display_name: field.querySelector('.schema-field-label').value.trim(), zone: field.querySelector('.schema-field-zone').value }));
        renderListConfig(fields, readListConfig());
      }
    });
  });
}

function rowOrderControl(index, label) {
  return `<span class="schema-row-controls"><button type="button" class="row-drag-handle" aria-label="拖动第 ${index + 1} 行" title="拖动调整顺序">⠿</button><button type="button" class="schema-row-number" aria-label="第 ${index + 1} 行，点击修改顺序" title="点击输入目标行号">${index + 1}</button><input class="schema-position" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" value="${index + 1}" aria-label="${label}" hidden /></span>`;
}

function orderChanged(container, row, previous) {
  const current = [...container.children].indexOf(row);
  if (current === previous) return;
  container.dispatchEvent(new Event('change', { bubbles: true }));
  const status = $('#reorder-status');
  if (status) status.textContent = `已从第 ${previous + 1} 行移动到第 ${current + 1} 行`;
}

function bindRowOrder(container, rowSelector, refresh) {
  container.querySelectorAll(rowSelector).forEach(row => {
    const number = row.querySelector('.schema-row-number');
    const input = row.querySelector('.schema-position');
    const finish = commit => {
      if (input.hidden) return;
      const previous = [...container.children].indexOf(row);
      input.hidden = true; number.hidden = false;
      if (commit) moveRowToPosition(row, rowSelector, input.value, refresh);
      else refresh();
      orderChanged(container, row, previous);
    };
    number.addEventListener('click', () => {
      container.querySelectorAll('.schema-position:not([hidden])').forEach(other => other.blur());
      number.hidden = true; input.hidden = false;
      input.focus(); input.select();
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', event => {
      if (!['Enter', 'Escape'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      finish(event.key === 'Enter'); number.focus();
    });
    bindRowDrag(container, row, rowSelector, refresh);
  });
}

function bindRowDrag(container, row, rowSelector, refresh) {
  const handle = row.querySelector('.row-drag-handle');
  let drag = null;
  const clearMarker = () => container.querySelectorAll('.reorder-before, .reorder-after').forEach(item => item.classList.remove('reorder-before', 'reorder-after'));
  const locate = () => {
    clearMarker();
    const others = [...container.querySelectorAll(rowSelector)].filter(item => item !== row);
    drag.before = others.find(item => { const rect = item.getBoundingClientRect(); return drag.y < rect.top + rect.height / 2; }) || null;
    if (drag.before) drag.before.classList.add('reorder-before');
    else others.at(-1)?.classList.add('reorder-after');
  };
  const cleanup = () => {
    if (!drag) return;
    const previous = drag; drag = null;
    if (previous.frame) cancelAnimationFrame(previous.frame);
    if (handle.hasPointerCapture?.(previous.id)) handle.releasePointerCapture(previous.id);
    clearMarker(); row.classList.remove('reorder-dragging');
    document.body.classList.remove('reordering-fields');
  };
  const scroll = () => {
    if (!drag?.active) return;
    if (!handle.isConnected || container.closest('[hidden]')) { cleanup(); return; }
    const top = $('.topbar')?.getBoundingClientRect().bottom || 0;
    const speed = drag.y < top + 48 ? -12 : drag.y > innerHeight - 80 ? 12 : 0;
    if (speed) { window.scrollBy(0, speed); locate(); }
    drag.frame = requestAnimationFrame(scroll);
  };
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || handle.disabled) return;
    event.preventDefault();
    container.querySelector('.schema-position:not([hidden])')?.blur();
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, y: event.clientY, previous: [...container.children].indexOf(row), active: false };
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
    if (!drag.active) {
      drag.active = true; row.classList.add('reorder-dragging');
      document.body.classList.add('reordering-fields');
      drag.frame = requestAnimationFrame(scroll);
    }
    locate();
  });
  handle.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const { active, before, previous } = drag;
    cleanup();
    if (!active) return;
    if (before) container.insertBefore(row, before); else container.append(row);
    refresh(); orderChanged(container, row, previous); handle.focus();
  });
  handle.addEventListener('pointercancel', cleanup);
  handle.addEventListener('lostpointercapture', cleanup);
}

function renderSchemaOrderButtons() {
  const rows = $$("#schema-fields .schema-field");
  rows.forEach((row, index) => { const buttons = row.querySelectorAll("[data-schema-move]"); buttons[0].disabled = index === 0; buttons[1].disabled = index === rows.length - 1; const input = row.querySelector(".schema-position"); if (input) { input.value = index + 1; input.setAttribute("aria-description", `共 ${rows.length} 行，输入目标行号后移动`); } const number = row.querySelector(".schema-row-number"); if (number) { number.textContent = index + 1; number.setAttribute("aria-label", `第 ${index + 1} 行，点击修改顺序`); } const handle = row.querySelector(".row-drag-handle"); if (handle) { handle.disabled = rows.length < 2; handle.setAttribute("aria-label", `拖动第 ${index + 1} 行`); } });
}

function renderListConfig(fields, configured = []) {
  const eligible = fields.filter((field) => ["indexes", "display"].includes(field.zone));
  if (!eligible.length) { $("#list-config").hidden = true; return; }
  const saved = new Map(configured.map((field, index) => [field.source_key, { ...field, position: field.position ?? index }]));
  const rows = eligible.map((field, index) => saved.has(field.source_key) ? { ...field, ...saved.get(field.source_key) } : { ...field, position: configured.length + index, visible: true, format: "single_line" }).sort((a, b) => a.position - b.position);
  $("#list-config").hidden = false;
  $("#list-config-fields").innerHTML = rows.map((field, index) => `<div class="list-config-row" data-list-source="${escapeHtml(field.source_key)}">${rowOrderControl(index, "列表字段顺序")}<label class="list-config-visible"><input type="checkbox" class="list-field-visible" ${field.visible !== false ? "checked" : ""} />显示</label><span class="list-config-name"><strong>${escapeHtml(field.display_name || field.source_key)}</strong><code>${escapeHtml(field.source_key)}</code></span><select class="list-field-format" aria-label="展示形式"><option value="single_line" ${field.format === "single_line" ? "selected" : ""}>单行截断</option><option value="multiline" ${field.format === "multiline" ? "selected" : ""}>多行换行</option><option value="json" ${field.format === "json" ? "selected" : ""}>JSON</option></select><span class="schema-order"><button type="button" data-list-move="up" ${index === 0 ? "disabled" : ""} title="上移一行">↑</button><button type="button" data-list-move="down" ${index === rows.length - 1 ? "disabled" : ""} title="下移一行">↓</button></span></div>`).join("");
  $$('[data-list-move]').forEach((button) => button.addEventListener("click", () => { const row = button.closest(".list-config-row"); const sibling = button.dataset.listMove === "up" ? row.previousElementSibling : row.nextElementSibling; if (!sibling) return; if (button.dataset.listMove === "up") row.parentElement.insertBefore(row, sibling); else row.parentElement.insertBefore(sibling, row); renderListOrderButtons(); }));
  bindRowOrder($("#list-config-fields"), ".list-config-row", renderListOrderButtons);
  renderListOrderButtons();
}

function renderListOrderButtons() {
  const rows = $$("#list-config-fields .list-config-row");
  rows.forEach((row, index) => { const buttons = row.querySelectorAll("[data-list-move]"); buttons[0].disabled = index === 0; buttons[1].disabled = index === rows.length - 1; const input = row.querySelector(".schema-position"); if (input) { input.value = index + 1; input.setAttribute("aria-description", `共 ${rows.length} 行，输入目标行号后移动`); } const number = row.querySelector(".schema-row-number"); if (number) { number.textContent = index + 1; number.setAttribute("aria-label", `第 ${index + 1} 行，点击修改顺序`); } const handle = row.querySelector(".row-drag-handle"); if (handle) { handle.disabled = rows.length < 2; handle.setAttribute("aria-label", `拖动第 ${index + 1} 行`); } });
}

function readListConfig() {
  const eligible = new Set($$("#schema-fields .schema-field").filter((row) => ["indexes", "display"].includes(row.querySelector('.schema-field-zone').value)).map((row) => row.querySelector('.schema-source-key-input').value.trim()));
  return $$("#list-config-fields .list-config-row").filter((row) => eligible.has(row.dataset.listSource)).map((row, position) => ({ source_key: row.dataset.listSource, display_name: row.querySelector(".list-config-name strong").textContent, position, format: row.querySelector(".list-field-format").value, visible: row.querySelector(".list-field-visible").checked }));
}

async function detectSchema() {
  try {
    showToast("Schema 将在首次导入时从文件识别", "info");
  } catch (error) { showToast(error.message, "error"); }
}

async function createDataset() {
  try {
    const categoryPath = $("#dataset-category").value.trim();
    if (!categoryPath) throw new Error("请填写分类目录路径");
    if (state.editDatasetId) {
      const editedId = state.editDatasetId;
      const fields = $$("#schema-fields .schema-field").map((row, position) => { const sourceKey = row.querySelector(".schema-source-key-input").value.trim(); const original = row.dataset.originalSource; return { source_key: sourceKey, previous_source_key: original !== sourceKey ? original : null, display_name: row.querySelector(".schema-field-label").value.trim(), zone: row.querySelector(".schema-field-zone").value, unique: row.querySelector(".schema-field-unique").checked, position }; });
      const identityFields = fields.filter((field) => field.unique).map((field) => field.source_key);
      await api(`/datasets/${encodeURIComponent(state.editDatasetId)}`, { method: "PATCH", body: JSON.stringify({ category_path: categoryPath, description: $("#dataset-description").value, environment: $("#dataset-environment").value.trim() || null, clear_environment: !$("#dataset-environment").value.trim(), fields, identity_fields: identityFields, list_fields: readListConfig() }) });
      if (state.editorReturn === "search") {
        state.category = categoryPath;
        state.environment = $("#dataset-environment").value.trim() || "all";
        state.selectedDatasetId = editedId;
        state.page = 1;
      }
      state.editDatasetId = null;
      await refreshAfterWrite();
      returnFromDatasetEditor();
      showToast("数据集属性已更新", "success");
      return;
    }
    const result = await api("/datasets", { method: "POST", body: JSON.stringify({
      category_path: categoryPath,
      description: $("#dataset-description").value,
      environment: $("#dataset-environment").value.trim() || null,
      fields: [],
      identity_fields: [],
      conflict_strategy: "allow_mark",
    }) });
    state.category = result.category_path;
    state.environment = "all";
    state.page = 1;
    await refreshAfterWrite();
    returnFromDatasetEditor();
    showToast("数据集已创建，可首次导入时定义 Schema", "success");
  } catch (error) { showToast(error.message, "error"); }
}

async function importFile(file) {
  if (!file) return;
  try {
    const datasetId = $("#import-dataset-select").value;
    if (!datasetId) throw new Error("请先创建一个数据集");
    const form = new FormData(); form.append("file", file);
    const response = await fetch("/api/imports/upload", { method: "POST", body: form });
    const batch = await response.json();
    if (!response.ok) throw new Error(batch.error || `上传失败 (${response.status})`);
    const existingDataset = state.datasets.find((item) => item.id === datasetId);
    if ($("#delete-missing").checked && !existingDataset?.identity_fields?.length) throw new Error("该数据集尚未配置逻辑唯一 KEY，不能按批次删除旧记录");
    state.pendingBatchId = batch.batch_id;
    $("#batch-summary").textContent = `${batch.filename} · ${batch.record_count} 条 · ${batch.source_fields.length} 个源字段`;
    const dataset = state.datasets.find((item) => item.id === datasetId);
    const templateResult = await api(`/datasets/${encodeURIComponent(datasetId)}/templates`);
    state.importTemplates = templateResult.templates;
    state.currentBatchSources = batch.source_fields;
    $("#mapping-template-select").innerHTML = `<option value="">不使用已保存模板</option>${state.importTemplates.map((template, index) => `<option value="${index}">${escapeHtml(template.name)}</option>`).join("")}`;
    const knownFields = dataset?.fields || [];
    if (!knownFields.length) {
      $("#first-schema").hidden = false;
      $("#first-schema-fields").innerHTML = batch.source_fields.map((source) => {
        const suggestedZone = /key|secret|token|password|private/i.test(source) ? "secrets" : "indexes";
        return `<div class="schema-field"><code class="schema-source-key">${escapeHtml(source)}</code><input class="schema-field-label" value="${escapeHtml(source.replace(/[_.-]/g, " "))}" aria-label="字段显示名称" /><select class="schema-field-zone">${fieldZoneOptions(suggestedZone)}</select><label class="schema-unique"><input class="schema-field-unique" type="checkbox" />唯一 KEY</label></div>`;
      }).join("");
      bindSchemaZoneControls($("#first-schema-fields"));
      renderMappings(batch.source_fields, batch.source_fields.map((source) => ({ source_key: source, display_name: source })), true);
    } else {
      $("#first-schema").hidden = true;
      renderMappings(batch.source_fields, knownFields, true);
    }
    $$('[data-map-source]').forEach((select) => select.addEventListener("change", () => { $(`[data-map-new="${CSS.escape(select.dataset.mapSource)}"]`).hidden = select.value !== "__new"; }));
    $("#batch-options").hidden = false; $("#batch-summary").hidden = false;
    $("#import-file").value = "";
  } catch (error) { showToast(error.message || "文件无法解析", "error"); }
}

function renderMappings(sourceFields, targetFields, autoSelect = false, templateMappings = []) {
  $("#mapping-list").innerHTML = sourceFields.map((source) => {
    const template = templateMappings.find((mapping) => mapping.source_key === source);
    const selected = targetFields.find((field) => field.source_key === (template?.target_key || source));
    const opts = targetFields.map((field) => `<option value="${escapeHtml(field.source_key)}" ${selected?.source_key === field.source_key ? "selected" : ""}>${escapeHtml(field.display_name || field.source_key)} · ${escapeHtml(field.source_key)}${field.zone === "ignore" ? "（忽略，不保存）" : ""}</option>`).join("");
    return `<div class="mapping-row"><code>${escapeHtml(source)}</code><select data-map-source="${escapeHtml(source)}"><option value="">忽略本次导入</option>${opts}<option value="__new">新增字段…</option></select><input data-map-new="${escapeHtml(source)}" placeholder="新字段名称" hidden /><input data-map-path="${escapeHtml(source)}" value="${escapeHtml(template?.json_path || "")}" placeholder="JSON 路径，如 account.id" /></div>`;
  }).join("");
  $$('[data-map-source]').forEach((select) => select.addEventListener("change", () => { $(`[data-map-new="${CSS.escape(select.dataset.mapSource)}"]`).hidden = select.value !== "__new"; }));
}

$("#mapping-template-select").addEventListener("change", (event) => {
  const template = state.importTemplates[Number(event.target.value)];
  if (!template) return;
  const dataset = state.datasets.find((item) => item.id === $("#import-dataset-select").value);
  renderMappings(state.currentBatchSources || [], dataset?.fields || [], true, template.mappings);
});

async function commitImport() {
  const datasetId = $("#import-dataset-select").value;
  try {
    const finalMappingsTarget = (source) => $$('[data-map-source]').find((select) => select.dataset.mapSource === source)?.value;
    const mappings = $$("[data-map-source]").filter((select) => select.value).map((select) => ({ source_key: select.dataset.mapSource, target_key: select.value === "__new" ? $(`[data-map-new="${CSS.escape(select.dataset.mapSource)}"]`).value.trim() : select.value, json_path: $(`[data-map-path="${CSS.escape(select.dataset.mapSource)}"]`).value.trim() || null })).filter((mapping) => mapping.target_key);
    const dataset = state.datasets.find((d) => d.id === datasetId);
    let identityFields = dataset?.identity_fields || [];
    if (dataset?.fields?.length) {
      const added = [];
      for (const select of $$('[data-map-source]')) {
        if (select.value !== "__new") continue;
        const target = $(`[data-map-new="${CSS.escape(select.dataset.mapSource)}"]`).value.trim();
        if (target) added.push({ source_key: target, display_name: target, zone: /key|secret|token|password|private/i.test(target) ? "secrets" : "indexes", unique: false });
        select.value = target;
      }
      if (added.length) {
        state.evolvedFields = [...dataset.fields, ...added];
        await api(`/datasets/${encodeURIComponent(datasetId)}`, { method: "PATCH", body: JSON.stringify({ fields: added, merge_fields: true }) });
      } else state.evolvedFields = [];
    }
    if (!dataset?.fields?.length) {
      const fields = $$("#first-schema-fields .schema-field").map((row) => ({ source_key: row.querySelector(".schema-source-key").textContent, display_name: row.querySelector(".schema-field-label").value.trim(), zone: row.querySelector(".schema-field-zone").value, unique: row.querySelector(".schema-field-unique").checked }));
      for (const select of $$('[data-map-source]')) if (select.value === "__new") select.value = $(`[data-map-new="${CSS.escape(select.dataset.mapSource)}"]`).value.trim();
      identityFields = fields.filter((field) => field.unique).map((field) => finalMappingsTarget(field.source_key) || field.source_key);
      state.evolvedFields = fields.map((field) => ({ ...field, source_key: finalMappingsTarget(field.source_key) || field.source_key }));
    } else if ($$("[data-map-source]").some((select) => select.value === "__new")) {
      const added = [];
      for (const select of $$("[data-map-source]")) {
        if (select.value !== "__new") continue;
        const source = select.dataset.mapSource;
        const target = $(`[data-map-new="${CSS.escape(source)}"]`).value.trim();
        if (!target) continue;
        const original = dataset.fields.find((field) => field.source_key === source);
        added.push({ ...(original || {}), source_key: target, display_name: target, zone: original?.zone || (/key|secret|token|password|private/i.test(target) ? "secrets" : "indexes"), unique: false });
        select.value = target;
      }
      state.evolvedFields = [...dataset.fields, ...added];
      await api(`/datasets/${encodeURIComponent(datasetId)}`, { method: "PATCH", body: JSON.stringify({ fields: added, merge_fields: true }) });
    } else state.evolvedFields = [];
    const finalMappings = $$("[data-map-source]").filter((select) => select.value && select.value !== "__new").map((select) => ({ source_key: select.dataset.mapSource, target_key: select.value, json_path: $(`[data-map-path="${CSS.escape(select.dataset.mapSource)}"]`).value.trim() || null }));
    const result = await api("/records/import", { method: "POST", body: JSON.stringify({ dataset_id: datasetId, batch_id: state.pendingBatchId, mappings: finalMappings, evolved_fields: state.evolvedFields || [], evolved_identity_fields: identityFields, template_name: $("#mapping-template").value.trim() || null, skip_existing: $("#skip-existing").checked, delete_missing: $("#delete-missing").checked }) });
    state.evolvedFields = [];
    state.currentBatchSources = [];
    $("#mapping-template").value = "";
    $("#mapping-template-select").value = "";
    $("#skip-existing").checked = false;
    $("#delete-missing").checked = false;
    showWorkspace(state.importReturn); $("#batch-options").hidden = true; $("#batch-summary").hidden = true; state.pendingBatchId = null;
    await refreshAfterWrite();
    if (state.importReturn === "datasets") renderDatasetManager();
    const stats = result.import || result;
    showToast(`导入完成：${stats.imported ?? 0} 条，更新 ${stats.updated ?? 0} 条${result.deleted_missing ? `，删除 ${result.deleted_missing} 条` : ""}`, "success");
  } catch (error) { showToast(error.message, "error"); }
}

$("#unlock-form").addEventListener("submit", unlockVault);
$("#toggle-password").addEventListener("click", () => { const input = $("#master-password"); input.type = input.type === "password" ? "text" : "password"; });
$("#lock-button").addEventListener("click", () => sealVault());
$("#theme-toggle").addEventListener("click", () => applyTheme(state.theme === "light" ? "dark" : "light"));
$("#all-categories").addEventListener("click", () => selectCategory("all"));
$("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value;
  state.page = 1;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => fetchRecords().catch((error) => showToast(error.message, "error")), 180);
});
$("#clear-filters").addEventListener("click", async () => {
  state.query = ""; state.selectedDatasetId = null; state.category = "all"; state.categories = []; state.environment = "all"; state.includeExpired = false; state.page = 1;
  $("#include-expired").checked = false;
  $("#search-input").value = "";
  await fetchRecords(); renderCategoryTree(); renderFilters();
});
$("#previous-page").addEventListener("click", async () => { if (state.page > 1) { state.page--; await fetchRecords(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
$("#next-page").addEventListener("click", async () => { if (state.page * state.pageSize < state.total) { state.page++; await fetchRecords(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
$("#security-settings-button").addEventListener("click", () => openSecuritySettings());
$("#change-password-form").addEventListener("submit", changeMasterPassword);
["#close-security", "#cancel-password-change"].forEach((id) => $(id).addEventListener("click", () => { if (!state.passwordChangeBusy) showWorkspace(state.securityReturn); }));
$("#dataset-manager-button").addEventListener("click", () => openDatasetManager());
$("#manager-new-dataset").addEventListener("click", () => $("#new-dataset-button").click());
$("#manager-import").addEventListener("click", () => openImport());
$("#app-manager-button").addEventListener("click", async () => { try { await loadApps(); showWorkspace("apps"); } catch (error) { showToast(error.message, "error"); } });
$("#create-app").addEventListener("click", async () => { try { const name = $("#app-name").value.trim(); if (!name) throw new Error("请填写应用名称"); const result = await api("/apps", { method: "POST", body: JSON.stringify({ name, permission: $("#app-permission").value, datasets: [] }) }); $("#app-name").value = ""; await loadApps(); showAppKey(result.key); } catch (error) { showToast(error.message, "error"); } });
$("#new-dataset-button").addEventListener("click", () => { state.editDatasetId = null; state.evolvedFields = []; state.currentBatchSources = []; $("#dataset-title").textContent = "定义数据集"; $("#dataset-help").textContent = "可先创建空数据集，首次导入时再定义 Schema。"; $("#dataset-category").value = ""; $("#dataset-environment").value = ""; $("#dataset-description").value = ""; updateDatasetDescriptionPreview(); renderSchemaFields([]); $("#list-config").hidden = true; $("#list-config-fields").replaceChildren(); $("#first-schema-fields").replaceChildren(); $("#first-schema").hidden = true; $("#save-dataset").innerHTML = "创建数据集 <span>↗</span>"; openDatasetEditor(); $("#dataset-category").focus(); });
$("#edit-dataset-button").addEventListener("click", () => {
  const dataset = currentDataset();
  if (dataset) openDatasetEdit(dataset.id);
  else openDatasetManager();
});
$("#import-button").addEventListener("click", () => openImport());
$("#choose-file").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (event) => importFile(event.target.files[0]));
$("#commit-import").addEventListener("click", () => commitImport());
$("#include-expired").addEventListener("change", async (event) => { state.includeExpired = event.target.checked; state.page = 1; await fetchRecords(); });
$("#close-import").addEventListener("click", () => showWorkspace(state.importReturn));
$("#close-reveal").addEventListener("click", () => { $("#reveal-modal").hidden = true; state.pendingReveal = null; });
$("#close-secrets").addEventListener("click", () => { $("#secret-fields-list").replaceChildren(); $("#secrets-modal").hidden = true; state.secretModalRecordId = null; state.reveal = null; });
$("#close-record-detail").addEventListener("click", () => closeRecordDetail());
$("#close-dataset-info").addEventListener("click", () => $("#dataset-info-modal").close());
$("#dataset-info-modal").addEventListener("click", (event) => {
  if (event.target !== event.currentTarget) return;
  const bounds = event.currentTarget.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) event.currentTarget.close();
});
$("#dataset-info-modal").addEventListener("close", () => $("#dataset-info-content").replaceChildren());
$("#close-dataset-manager").addEventListener("click", () => showWorkspace("search"));
$("#close-app-manager").addEventListener("click", () => { showWorkspace("search"); });
$("#cancel-reveal").addEventListener("click", () => { $("#reveal-modal").hidden = true; state.pendingReveal = null; });
$("#confirm-reveal").addEventListener("click", () => { if (state.pendingReveal) handleSecretAction("reveal", state.pendingReveal.field); $("#reveal-modal").hidden = true; });
$("#detect-schema")?.addEventListener("click", detectSchema);
$("#dataset-description").addEventListener("input", () => {
  if ($("#dataset-description-preview-panel").open) updateDatasetDescriptionPreview();
});
$("#dataset-description-preview-panel").addEventListener("toggle", () => {
  if ($("#dataset-description-preview-panel").open) updateDatasetDescriptionPreview();
});
$("#save-dataset").addEventListener("click", () => createDataset());
$("#close-dataset").addEventListener("click", () => returnFromDatasetEditor());
$("#cancel-dataset").addEventListener("click", () => returnFromDatasetEditor());
$("#load-dataset-file")?.addEventListener("click", () => $("#dataset-file")?.click());
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search-input").focus(); }

});
document.addEventListener("pointerdown", touch, { passive: true });

const toastStyle = document.createElement("style");
toastStyle.textContent = ".toast-region{position:fixed;z-index:20;right:20px;bottom:20px;display:grid;gap:8px}.toast{padding:11px 14px;border:1px solid var(--line-strong);border-radius:7px;background:#102c3d;color:#c8dbe3;font-size:11px;box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}.toast.show{opacity:1;transform:none}.toast.success{border-color:rgba(103,216,223,.45)}.toast.error{border-color:rgba(239,126,135,.45);color:#ffc5c9}";
document.head.appendChild(toastStyle);

applyTheme();
setSealedView();
setInterval(() => { if (state.workbenchReady) checkStatus(); }, 5000);
window.addEventListener("focus", () => { if (state.workbenchReady) checkStatus(); });
window.addEventListener("online", () => { if (state.workbenchReady) checkStatus(); });
window.addEventListener("offline", handleServiceOffline);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.workbenchReady) checkStatus();
});
