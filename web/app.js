const state = {
  initialized: false,
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
  timer: null,
  searchTimer: null,
  unlockAt: 0,
  lastActivity: 0,
  idleTimeout: 1800,
  maxSeconds: 14400
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 423) sealVault("数据空间已封印，请重新解锁");
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

async function checkStatus() {
  try {
    const status = await api("/vault/status");
    state.initialized = status.initialized;
    $("#confirm-password-label").hidden = status.initialized;
    $("#confirm-password-wrap").hidden = status.initialized;
    $("#confirm-password").required = !status.initialized;
    $("#master-password").autocomplete = status.initialized ? "current-password" : "new-password";
    $("#master-password").minLength = status.initialized ? 1 : 12;
    $("#vault-mode-note").textContent = status.initialized ? "主密码只用于本机解锁，不会保存明文。" : "首次使用请设置至少 12 个字符的主密码。";
    $(".unlock-button").lastChild.textContent = status.initialized ? " 解锁数据空间" : " 创建安全数据空间";
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function unlockVault(event) {
  event.preventDefault();
  const password = $("#master-password").value;
  try {
    if (!state.initialized) {
      if (password.length < 12) throw new Error("主密码至少需要 12 个字符");
      if (password !== $("#confirm-password").value) throw new Error("两次输入的主密码不一致");
      await api("/vault/setup", { method: "POST", body: JSON.stringify({ password }) });
      state.initialized = true;
    } else {
      await api("/vault/unlock", { method: "POST", body: JSON.stringify({ password }) });
    }
    state.unlocked = true;
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
  state.reveal = null;
  state.pendingReveal = null;
  state.pendingBatchId = null;
  state.currentBatchSources = [];
  state.records = [];
  state.datasets = [];
  state.directories = [];
  setSealedView();
  $("#batch-options").hidden = true;
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
    $("#idle-countdown").textContent = formatCountdown(Math.max(0, remaining));
    if (state.reveal && state.reveal.expiresAt <= Date.now()) {
      state.reveal = null;
      if (state.secretModalRecordId) renderSecretFields();
    }
    if (remaining <= 0) sealVault("会话已超时并自动封印");
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
  renderStats();
}

async function fetchRecords() {
  const params = new URLSearchParams({ q: state.query, page: String(state.page), limit: String(state.pageSize) });
  if (state.category !== "all") params.set("category", state.category);
  if (state.environment !== "all") params.set("environment", state.environment);
  if (state.includeExpired) params.set("include_expired", "true");
  const result = await api(`/records/search?${params}`);
  const byId = new Map(state.datasets.map((dataset) => [dataset.id, dataset]));
  state.records = result.records.map((record) => {
    const dataset = byId.get(record.dataset_id);
    const labels = Object.fromEntries((dataset?.fields || []).map((field) => [field.source_key, field.display_name || field.source_key]));
    return { ...record, fieldLabels: labels };
  });
  state.total = result.total;
  state.page = result.page;
  renderRecords();
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
    state.page = 1;
    await fetchRecords();
    renderFilters();
  }));
}

async function selectCategory(category) {
  state.category = category;
  if (!environments().includes(state.environment)) state.environment = "all";
  state.page = 1;
  await fetchRecords();
  renderCategoryTree();
  renderFilters();
}

function allDisplay(record) {
  const display = record.display || {};
  if (Object.keys(display).length) return display;
  return { 分类: record.category, ...(record.environment ? { 环境: record.environment } : {}), ...record.indexes };
}

function recordCard(record) {
  const displayMarkup = Object.entries(allDisplay(record)).slice(0, 5).map(([key, value]) => `<div class="data-point"><label>${escapeHtml(record.fieldLabels[key] || key)}</label><span title="${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}">${escapeHtml(typeof value === "object" ? JSON.stringify(value) : value)}</span></div>`).join("");
  const environmentTag = record.environment ? `<span class="tag environment">${escapeHtml(record.environment)}</span>` : `<span class="tag optional-tag">无环境</span>`;
  const title = record.indexes.alias || record.indexes.merchant_id || Object.values(record.indexes)[0] || record.id;
  return `<article class="record-card ${record.expired ? "is-expired" : ""}"><div class="record-head"><div class="record-title"><div class="record-tags"><span class="tag">${escapeHtml(record.category)}</span>${environmentTag}${record.expired ? '<span class="tag expired-tag">已过期</span>' : ""}</div><h4>${escapeHtml(title)}</h4><span class="record-id">${escapeHtml(record.id)}</span></div></div><div class="record-display">${displayMarkup}</div><div class="record-secrets"><span class="secret-count">${record.secret_count} 个敏感字段</span>${record.secret_count ? `<button class="reveal-secrets-button" data-action="open-secrets" data-record="${escapeHtml(record.id)}">按需查看 <span>→</span></button>` : ""}</div><div class="card-footer"><span>最近更新 ${escapeHtml(record.updated)}</span><button class="expired-toggle" data-expired-record="${escapeHtml(record.id)}" data-expired="${record.expired}">${record.expired ? "恢复有效" : "标记过期"}</button></div></article>`;
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
  $("#secrets-record-meta").textContent = `${record.category}${record.environment ? ` · ${record.environment}` : ""} · ${record.id}`;
  renderSecretFields();
  $("#secrets-modal").hidden = false;
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

function renderSchemaFields(fields) {
  $("#schema-fields").innerHTML = fields.map((field) => `<div class="schema-field"><code class="schema-source-key">${escapeHtml(field.source_key)}</code><input class="schema-field-label" value="${escapeHtml(field.display_name)}" aria-label="字段显示名称" /><select class="schema-field-zone" aria-label="字段区域"><option value="indexes" ${field.zone === "indexes" ? "selected" : ""}>索引字段</option><option value="display" ${field.zone === "display" ? "selected" : ""}>展示字段</option><option value="hidden" ${field.zone === "hidden" ? "selected" : ""}>隐藏加密字段</option><option value="secrets" ${field.zone === "secrets" ? "selected" : ""}>敏感字段</option></select><label class="schema-unique"><input class="schema-field-unique" type="checkbox" ${field.unique ? "checked" : ""} />唯一 KEY</label></div>`).join("");
  $("#schema-preview").hidden = false;
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
      await api(`/datasets/${encodeURIComponent(state.editDatasetId)}`, { method: "PATCH", body: JSON.stringify({ category_path: categoryPath, environment: $("#dataset-environment").value.trim() || null, clear_environment: !$("#dataset-environment").value.trim() }) });
      state.editDatasetId = null;
      $("#dataset-modal").hidden = true;
      await refreshAfterWrite();
      showToast("数据集属性已更新", "success");
      return;
    }
    const result = await api("/datasets", { method: "POST", body: JSON.stringify({
      category_path: categoryPath,
      environment: $("#dataset-environment").value.trim() || null,
      fields: [],
      identity_fields: [],
      conflict_strategy: "allow_mark",
    }) });
    $("#dataset-modal").hidden = true;
    state.category = result.category_path;
    state.environment = "all";
    state.page = 1;
    await refreshAfterWrite();
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
        return `<div class="schema-field"><code class="schema-source-key">${escapeHtml(source)}</code><input class="schema-field-label" value="${escapeHtml(source.replace(/[_.-]/g, " "))}" aria-label="字段显示名称" /><select class="schema-field-zone"><option value="indexes" ${suggestedZone === "indexes" ? "selected" : ""}>索引字段</option><option value="display">展示字段</option><option value="hidden">隐藏加密字段</option><option value="secrets" ${suggestedZone === "secrets" ? "selected" : ""}>敏感字段</option></select><label class="schema-unique"><input class="schema-field-unique" type="checkbox" />唯一 KEY</label></div>`;
      }).join("");
      renderMappings(batch.source_fields, batch.source_fields.map((source) => ({ source_key: source, display_name: source })), true);
    } else {
      $("#first-schema").hidden = true;
      renderMappings(batch.source_fields, knownFields, true);
    }
    $$('[data-map-source]').forEach((select) => select.addEventListener("change", () => { $(`[data-map-new="${CSS.escape(select.dataset.mapSource)}"]`).hidden = select.value !== "__new"; }));
    $("#batch-options").hidden = false;
    $("#import-file").value = "";
  } catch (error) { showToast(error.message || "文件无法解析", "error"); }
}

function renderMappings(sourceFields, targetFields, autoSelect = false, templateMappings = []) {
  $("#mapping-list").innerHTML = sourceFields.map((source) => {
    const template = templateMappings.find((mapping) => mapping.source_key === source);
    const selected = targetFields.find((field) => field.source_key === (template?.target_key || source));
    const opts = targetFields.map((field) => `<option value="${escapeHtml(field.source_key)}" ${selected?.source_key === field.source_key ? "selected" : ""}>${escapeHtml(field.display_name || field.source_key)} · ${escapeHtml(field.source_key)}</option>`).join("");
    return `<div class="mapping-row"><code>${escapeHtml(source)}</code><select data-map-source="${escapeHtml(source)}"><option value="">忽略</option>${opts}<option value="__new">新增字段…</option></select><input data-map-new="${escapeHtml(source)}" placeholder="新字段名称" hidden /><input data-map-path="${escapeHtml(source)}" value="${escapeHtml(template?.json_path || "")}" placeholder="JSON 路径，如 account.id" /></div>`;
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
    $("#import-modal").hidden = true; $("#batch-options").hidden = true; state.pendingBatchId = null;
    await refreshAfterWrite();
    const stats = result.import || result;
    showToast(`导入完成：${stats.imported ?? 0} 条，更新 ${stats.updated ?? 0} 条${result.deleted_missing ? `，删除 ${result.deleted_missing} 条` : ""}`, "success");
  } catch (error) { showToast(error.message, "error"); }
}

$("#unlock-form").addEventListener("submit", unlockVault);
$("#toggle-password").addEventListener("click", () => { const input = $("#master-password"); input.type = input.type === "password" ? "text" : "password"; });
$("#lock-button").addEventListener("click", () => sealVault());
$("#all-categories").addEventListener("click", () => selectCategory("all"));
$("#search-input").addEventListener("input", (event) => {
  state.query = event.target.value;
  state.page = 1;
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => fetchRecords().catch((error) => showToast(error.message, "error")), 180);
});
$("#clear-filters").addEventListener("click", async () => {
  state.query = ""; state.category = "all"; state.environment = "all"; state.page = 1;
  $("#search-input").value = "";
  await fetchRecords(); renderCategoryTree(); renderFilters();
});
$("#previous-page").addEventListener("click", async () => { if (state.page > 1) { state.page--; await fetchRecords(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
$("#next-page").addEventListener("click", async () => { if (state.page * state.pageSize < state.total) { state.page++; await fetchRecords(); window.scrollTo({ top: 0, behavior: "smooth" }); } });
$("#new-dataset-button").addEventListener("click", () => { $("#dataset-modal").hidden = false; $("#dataset-category").focus(); });
$("#edit-dataset-button").addEventListener("click", () => {
  const dataset = state.datasets.find((item) => item.category_path === state.category);
  if (!dataset) { showToast("请先选择具体分类下的数据集", "info"); return; }
  state.editDatasetId = dataset.id;
  $("#dataset-title").textContent = "编辑数据集属性";
  $("#dataset-help").textContent = "修改目录路径或环境标签。";
  $("#dataset-category").value = dataset.category_path;
  $("#dataset-environment").value = dataset.environment || "";
  $("#save-dataset").innerHTML = "保存修改";
  $("#dataset-modal").hidden = false;
});
$("#import-button").addEventListener("click", () => { datasetOptions(); $("#import-modal").hidden = false; });
$("#choose-file").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", (event) => importFile(event.target.files[0]));
$("#commit-import").addEventListener("click", commitImport);
$("#include-expired").addEventListener("change", async (event) => { state.includeExpired = event.target.checked; state.page = 1; await fetchRecords(); });
$("#close-import").addEventListener("click", () => { $("#import-modal").hidden = true; });
$("#close-reveal").addEventListener("click", () => { $("#reveal-modal").hidden = true; state.pendingReveal = null; });
$("#close-secrets").addEventListener("click", () => { $("#secrets-modal").hidden = true; state.secretModalRecordId = null; state.reveal = null; });
$("#cancel-reveal").addEventListener("click", () => { $("#reveal-modal").hidden = true; state.pendingReveal = null; });
$("#confirm-reveal").addEventListener("click", () => { if (state.pendingReveal) handleSecretAction("reveal", state.pendingReveal.field); $("#reveal-modal").hidden = true; });
$("#detect-schema")?.addEventListener("click", detectSchema);
$("#save-dataset").addEventListener("click", createDataset);
$("#close-dataset").addEventListener("click", () => { $("#dataset-modal").hidden = true; });
$("#cancel-dataset").addEventListener("click", () => { $("#dataset-modal").hidden = true; });
$("#load-dataset-file")?.addEventListener("click", () => $("#dataset-file")?.click());
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); $("#search-input").focus(); }
  if (event.key === "Escape") { ["#reveal-modal", "#import-modal", "#dataset-modal", "#secrets-modal"].forEach((selector) => { $(selector).hidden = true; }); }
});
document.addEventListener("pointerdown", touch, { passive: true });

const toastStyle = document.createElement("style");
toastStyle.textContent = ".toast-region{position:fixed;z-index:20;right:20px;bottom:20px;display:grid;gap:8px}.toast{padding:11px 14px;border:1px solid var(--line-strong);border-radius:7px;background:#102c3d;color:#c8dbe3;font-size:11px;box-shadow:0 10px 30px rgba(0,0,0,.3);opacity:0;transform:translateY(8px);transition:opacity .25s,transform .25s}.toast.show{opacity:1;transform:none}.toast.success{border-color:rgba(103,216,223,.45)}.toast.error{border-color:rgba(239,126,135,.45);color:#ffc5c9}";
document.head.appendChild(toastStyle);

setSealedView();
checkStatus();
