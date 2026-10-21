// Desktop reading widths are presentation preferences, independent of vault data.
var searchLayoutPreferences;
var searchLayoutDrag = null;
var searchLayoutKey = 'securevault-search-layout-v1';
var searchLayoutDefaults = { navigation: 216, details: 480 };
function readSearchLayout() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(searchLayoutKey)); } catch {}
  const read = (key, min, max) => typeof stored?.[key] === 'number' && Number.isFinite(stored[key])
    ? Math.max(min, Math.min(max, stored[key])) : searchLayoutDefaults[key];
  return { navigation: read('navigation', 176, 360), details: read('details', 340, 760) };
}
function searchLayoutBounds() {
  const width = document.documentElement.clientWidth || window.innerWidth;
  const docked = document.body.classList.contains('detail-docked');
  const navigationMax = Math.max(176, Math.min(360, width - 520 - (docked ? 340 : 0)));
  const navigation = Math.max(176, Math.min(navigationMax, searchLayoutPreferences.navigation));
  const detailMax = Math.max(340, Math.min(760, width - navigation - 520));
  const details = Math.max(340, Math.min(detailMax, searchLayoutPreferences.details));
  return { width, docked, navigation, details, navigationMax: Math.max(176, Math.min(360, width - 520 - (docked ? details : 0))), detailMax };
}
function applySearchLayout() {
  if (!searchLayoutPreferences) return;
  const layout = searchLayoutBounds(), search = state.workspace === 'search' && state.unlocked;
  const root = $('#app');
  root.style.setProperty('--search-nav-width', `${layout.navigation}px`);
  root.style.setProperty('--search-detail-width', `${layout.details}px`);
  for (const [key, id, min, max] of [['navigation', 'search-navigation-resizer', 176, layout.navigationMax], ['details', 'search-detail-resizer', 340, layout.detailMax]]) {
    const handle = $('#' + id); if (!handle) continue;
    handle.hidden = !search || layout.width < (key === 'navigation' ? 768 : 1360) || key === 'details' && !layout.docked;
    handle.setAttribute('aria-valuemin', String(min)); handle.setAttribute('aria-valuemax', String(Math.round(max)));
    handle.setAttribute('aria-valuenow', String(Math.round(layout[key])));
    handle.setAttribute('aria-valuetext', `${Math.round(layout[key])} 像素`);
  }
  if (searchLayoutDrag?.handle.hidden) cancelSearchResize();
  scheduleRecordLayout();
  return layout;
}
function saveSearchLayout() {
  try { localStorage.setItem(searchLayoutKey, JSON.stringify(searchLayoutPreferences)); } catch {}
}
function setSearchColumnWidth(key, value) {
  const layout = searchLayoutBounds();
  const min = key === 'navigation' ? 176 : 340;
  // Resizing one boundary keeps the other boundary in place.
  const max = key === 'navigation' ? Math.min(360, layout.width - 520 - (layout.docked ? layout.details : 0)) : layout.detailMax;
  searchLayoutPreferences[key] = Math.round(Math.max(min, Math.min(Math.max(min, max), value)));
  applySearchLayout();
}
function finishSearchResize(cancel = false) {
  const drag = searchLayoutDrag; if (!drag) return;
  searchLayoutDrag = null;
  if (cancel) searchLayoutPreferences = drag.original;
  else saveSearchLayout();
  document.body.classList.remove('resizing-search-columns');
  if (drag.handle.hasPointerCapture?.(drag.pointerId)) drag.handle.releasePointerCapture(drag.pointerId);
  applySearchLayout();
}
function cancelSearchResize() { finishSearchResize(true); }
function createSearchResizer(key, label, parent) {
  const handle = document.createElement('div');
  handle.id = key === 'navigation' ? 'search-navigation-resizer' : 'search-detail-resizer';
  handle.className = 'search-column-resizer'; handle.tabIndex = 0;
  handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', label);
  handle.setAttribute('aria-controls', key === 'navigation' ? 'app-navigation search-workspace' : 'search-workspace record-detail-modal');
  handle.setAttribute('aria-description', '拖动调整宽度；方向键微调，Shift 加速；Home 最小，End 最大；Enter 或双击恢复默认。');
  handle.title = '拖动调整宽度 · 双击恢复默认 · 方向键微调';
  const reset = () => { setSearchColumnWidth(key, searchLayoutDefaults[key]); saveSearchLayout(); };
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', event => {
    if (handle.hidden || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Enter') { reset(); return; }
    const layout = searchLayoutBounds(), delta = (event.shiftKey ? 64 : 16) * (key === 'details' ? -1 : 1);
    const width = event.key === 'Home' ? 0 : event.key === 'End' ? Infinity : layout[key] + (event.key === 'ArrowRight' ? delta : -delta);
    setSearchColumnWidth(key, width); saveSearchLayout();
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || handle.hidden || !state.unlocked || searchLayoutDrag) return;
    event.preventDefault(); handle.focus();
    searchLayoutDrag = { key, handle, pointerId: event.pointerId, start: event.clientX, width: searchLayoutBounds()[key], original: { ...searchLayoutPreferences } };
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add('resizing-search-columns');
  });
  handle.addEventListener('pointermove', event => {
    const drag = searchLayoutDrag;
    if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
    setSearchColumnWidth(key, drag.width + (event.clientX - drag.start) * (key === 'details' ? -1 : 1));
  });
  handle.addEventListener('pointerup', event => { if (searchLayoutDrag?.handle === handle && event.pointerId === searchLayoutDrag.pointerId) finishSearchResize(); });
  handle.addEventListener('pointercancel', cancelSearchResize);
  handle.addEventListener('lostpointercapture', cancelSearchResize);
  parent.append(handle);
}
searchLayoutPreferences = readSearchLayout();
$('.app-navigation').id = 'app-navigation';
createSearchResizer('navigation', '调整目录栏宽度', $('#vault-screen'));
createSearchResizer('details', '调整记录详情宽度', $('#record-detail-modal'));
window.addEventListener('resize', applySearchLayout);
window.addEventListener('blur', cancelSearchResize);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !searchLayoutDrag) return;
  event.preventDefault(); event.stopImmediatePropagation(); cancelSearchResize();
}, true);
applySearchLayout();
