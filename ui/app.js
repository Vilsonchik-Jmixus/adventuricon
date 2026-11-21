/* The renderer never reads local files directly. All mutations go through validated IPC. */
const $ = id => document.getElementById(id);
const api = window.dm;
const detachedPanel = new URLSearchParams(location.search).get('panel');
let state, detached = [], currentFolder = 'Общее', portrait = null, expanded = null;
let editingCombatant = null;
let toastTimer, textSubmit, draggingToken = false, animating = false, musicBusy = false, currentUpdate;
const assetURL = name => `dm://app/assets/${encodeURIComponent(name)}`;
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500); }
async function result(promise) { const value = await promise; if (value?.error) toast(value.error); return value; }
const dispatch = (type, payload = {}) => result(api.dispatch(type, payload));
function openDialog(id) { $(id).showModal(); syncRemoteBounds(); }
function closeDialog(dialog) { dialog.close(); syncRemoteBounds(); }
function avatar(c, cls = 'avatar') { return `<span class="${cls}">${c.image ? `<img src="${assetURL(c.image)}" alt="">` : escapeHTML(c.name.slice(0, 1).toUpperCase())}</span>`; }
function renderCombat() {
  $('combat-count').textContent = state.combatants.length;
  $('round').textContent = `Раунд ${state.round}`;
  $('undo-hp').disabled = !state.history.length;
  $('next-turn').disabled = !state.combatants.length;
  // Preserve unfinished HP input across changes arriving from another window.
  const drafts = new Map([...document.querySelectorAll('.hp-form input')].map(el => [el.closest('form').dataset.id, el.value]));
  const focused = document.activeElement?.closest('.hp-form')?.dataset.id;
  const order = [...state.combatants].sort((a, b) => b.initiative - a.initiative);
  $('combat-list').innerHTML = order.length ? order.map(c => `<article class="combat-card ${state.turn === c.id ? 'active-turn' : ''} ${c.hp === 0 ? 'dead' : ''}" data-id="${c.id}"><div class="combat-main">${avatar(c)}<div class="combat-details"><strong class="combat-name">${escapeHTML(c.name)}</strong><div class="combat-meta">Инициатива ${c.initiative}${state.turn === c.id ? ' · Ходит сейчас' : ''}</div></div><button type="button" class="hp-readout" data-edit="${c.id}" title="Изменить текущие и максимальные ХП">${c.hp}<small> / ${c.maxHp}</small></button></div><div class="hp-bar"><div style="width:${c.hp / c.maxHp * 100}%"></div></div><div class="combat-bottom"><form class="hp-form" data-id="${c.id}"><input aria-label="Изменение ХП ${escapeHTML(c.name)}" placeholder="−7 / +5" value="${escapeHTML(drafts.get(c.id) || '')}" maxlength="12"><button title="Применить ХП">↵</button></form><button class="to-map" ${state.tokens.some(t => t.combatantId === c.id) ? `data-token-focus="${c.id}" title="Показать жетон на карте"` : `data-token-add="${c.id}"`}>${state.tokens.some(t => t.combatantId === c.id) ? '✓ На карте' : '◇ На карту'}</button><button class="card-menu" data-edit="${c.id}" title="Редактировать участника" aria-label="Редактировать участника">✎</button><button class="card-menu" data-duplicate="${c.id}" title="Дублировать">⧉</button><button class="card-menu" data-remove="${c.id}" title="Удалить">×</button></div></article>`).join('') : '<div class="empty-state"><span class="empty-symbol">⚔</span><strong>Бойцов пока нет</strong></div>';
  if (focused) document.querySelector(`.hp-form[data-id="${focused}"] input`)?.focus();
}
function renderMap() {
  const m = state.map, zoom = m.zoom;
  const img = $('map-image'), src = m.image ? assetURL(m.image) : new URL('assets/demo-map.svg', location.href).href;
  if (img.src !== src) img.src = src;
  const width = img.naturalWidth || 1600, height = img.naturalHeight || 1100;
  $('map-world').style.width = `${Math.max(width, ...state.tokens.map(t => (t.col + 2) * m.grid + m.offsetX)) * zoom}px`;
  $('map-world').style.height = `${Math.max(height, ...state.tokens.map(t => (t.row + 2) * m.grid + m.offsetY)) * zoom}px`;
  img.style.width = `${width * zoom}px`; img.style.height = `${height * zoom}px`;
  const world = $('map-world');
  world.style.setProperty('--grid-size', m.grid * zoom + 'px'); world.style.setProperty('--grid-color', m.color);
  world.style.setProperty('--grid-x', m.offsetX * zoom + 'px'); world.style.setProperty('--grid-y', m.offsetY * zoom + 'px');
  world.style.setProperty('--grid-opacity', m.visible ? m.opacity : 0);
  $('map-viewport').classList.toggle('has-map', !!m.image);
  $('zoom-label').textContent = `${Math.round(zoom * 100)}%`;
  $('token-count').textContent = state.tokens.length;
  if (draggingToken) return;
  $('map-tokens').innerHTML = state.tokens.map(t => {
    const c = state.combatants.find(c => c.id === t.combatantId); if (!c) return '';
    return `<button class="token ${c.hp === 0 ? 'dead' : ''} ${state.turn === c.id ? 'active-turn' : ''}" data-token="${c.id}" title="${escapeHTML(c.name)} · ${c.hp}/${c.maxHp} ХП. Двойное нажатие: убрать" style="left:${(m.offsetX + t.col * m.grid) * zoom}px;top:${(m.offsetY + t.row * m.grid) * zoom}px">${avatar(c, 'token-body')}<span class="token-hp">${c.hp}/${c.maxHp}</span></button>`;
  }).join('');
}
function renderMusic() {
  if (!state.music.folders.includes(currentFolder)) currentFolder = state.music.folders[0];
  $('folders').innerHTML = state.music.folders.map(f => `<button class="folder ${f === currentFolder ? 'selected' : ''}" data-folder="${escapeHTML(f)}">${escapeHTML(f)}</button>`).join('');
  const tracks = state.music.tracks.filter(t => t.folder === currentFolder);
  $('track-list').innerHTML = tracks.length ? tracks.map(t => `<div class="track ${state.music.current === t.id ? 'current' : ''}"><button class="track-play" data-play="${t.id}" title="Воспроизвести">▶</button><span class="track-title" title="${escapeHTML(t.title)}">${escapeHTML(t.title)}</span><select data-move-track="${t.id}" aria-label="Папка трека">${state.music.folders.map(f => `<option ${t.folder === f ? 'selected' : ''}>${escapeHTML(f)}</option>`).join('')}</select><button class="track-delete" data-delete-track="${t.id}" title="Удалить трек">×</button></div>`).join('') : '<div class="empty-state"><span class="empty-symbol">♫</span><strong>В этой папке пока нет треков</strong></div>';
  const current = state.music.tracks.find(t => t.id === state.music.current);
  $('current-title').textContent = current?.title || 'Выберите трек';
  $('play-pause').textContent = state.music.playing ? 'Ⅱ' : '▶';
  $('loop-music').classList.toggle('enabled', state.music.loop);
  if (document.activeElement !== $('volume')) $('volume').value = state.music.volume * 100;
  // One permanent audio owner prevents double playback when the music panel detaches.
  if (!detachedPanel) {
    const audio = $('audio'); audio.volume = state.music.volume; audio.loop = state.music.loop;
    if (audio.dataset.reset !== String(state.music.reset || 0)) { if (audio.readyState) audio.currentTime = 0; audio.dataset.reset = String(state.music.reset || 0); }
    if (!current) { audio.pause(); audio.removeAttribute('src'); delete audio.dataset.asset; }
    else {
      if (audio.dataset.asset !== current.asset) { audio.src = assetURL(current.asset); audio.dataset.asset = current.asset; }
      if (state.music.playing && audio.paused) audio.play().catch(() => { toast('Не удалось воспроизвести файл. Попробуйте другой формат.'); dispatch('music:settings', { playing: false }); });
      else if (!state.music.playing && !audio.paused) audio.pause();
    }
  }
}
function renderLayout() {
  const w = $('workspace'); w.style.setProperty('--left', state.layout.left + '%'); w.style.setProperty('--middle', state.layout.middle + '%'); w.style.setProperty('--top', state.layout.top + '%');
  document.querySelectorAll('[data-panel]').forEach(panel => panel.classList.toggle('is-detached', !detachedPanel && detached.includes(panel.dataset.panel)));
}
function renderAll() { renderLayout(); renderCombat(); renderMap(); renderMusic(); requestAnimationFrame(syncRemoteBounds); }
function syncRemoteBounds() {
  const modal = !!document.querySelector('dialog[open]');
  document.querySelectorAll('[data-remote-surface]').forEach(el => {
    const panel = el.closest('.panel'); const rect = el.getBoundingClientRect();
    const visible = !modal && !animating && !panel.hidden && !panel.classList.contains('is-detached') && (!expanded || panel.dataset.panel === expanded);
    api.remoteBounds(el.dataset.remoteSurface, visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
  });
}
async function expandPanel(id) {
  if (detachedPanel) return result(api.fullscreen());
  const panel = document.querySelector(`[data-panel="${id}"]`), before = panel.getBoundingClientRect();
  if (expanded && expanded !== id) document.querySelector(`[data-panel="${expanded}"]`).classList.remove('expanded');
  const opening = expanded !== id;
  expanded = opening ? id : null;
  panel.classList.toggle('expanded', opening); $('workspace').classList.toggle('has-expanded', opening);
  const after = panel.getBoundingClientRect(); animating = true; syncRemoteBounds();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await panel.animate([{ transformOrigin: '0 0', transform: `translate(${before.x - after.x}px,${before.y - after.y}px) scale(${before.width / after.width},${before.height / after.height})`, opacity: 0.8 }, { transformOrigin: '0 0', transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.75,.25,1)' }).finished.catch(() => {});
  }
  animating = false; syncRemoteBounds();
}
async function loadMap(promise) {
  const r = await result(promise); if (r?.asset) { await dispatch('map:image', { image: r.asset }); toast('Карта загружена'); }
}
function askText(title, label, hint, callback, submit = 'Добавить') {
  $('text-dialog-title').textContent = title; $('text-dialog-label').textContent = label;
  $('text-dialog-input').value = ''; $('text-dialog-input').placeholder = title.includes('YouTube') ? 'https://www.youtube.com/watch?v=…' : '';
  $('text-dialog-hint').textContent = hint; $('text-dialog-submit').textContent = submit; textSubmit = callback;
  openDialog('text-dialog'); $('text-dialog-input').focus();
}
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-close-dialog')) closeDialog(button.closest('dialog'));
  else if (button.dataset.detach) { if (detachedPanel) await result(api.dock()); else await result(api.detach(button.dataset.detach)); }
  else if (button.dataset.focus) await result(api.detach(button.dataset.focus));
  else if (button.dataset.expand) await expandPanel(button.dataset.expand);
  else if (button.dataset.remote) { const [id, action] = button.dataset.remote.split(':'); await result(api.remoteAction(id, action)); }
  else if (button.dataset.tokenAdd) { await dispatch('token:add', { id: button.dataset.tokenAdd }); toast('Боец добавлен на карту'); }
  else if (button.dataset.tokenFocus) await result(api.showToken(button.dataset.tokenFocus));
  else if (button.dataset.edit) openCombatantEditor(state.combatants.find(c => c.id === button.dataset.edit));
  else if (button.dataset.duplicate) await dispatch('combatant:duplicate', { id: button.dataset.duplicate });
  else if (button.dataset.remove) await dispatch('combatant:remove', { id: button.dataset.remove });
  else if (button.dataset.folder) { currentFolder = button.dataset.folder; renderMusic(); }
  else if (button.dataset.play) await dispatch('music:play', { id: button.dataset.play });
  else if (button.dataset.deleteTrack) await dispatch('music:remove', { id: button.dataset.deleteTrack });
});
function openCombatantEditor(combatant) {
  const form = $('combatant-form');
  form.reset();
  editingCombatant = combatant?.id ?? null;
  portrait = combatant?.image ?? null;
  $('editor-title').textContent = combatant ? 'Редактировать участника' : 'Добавить участника';
  $('editor-submit').textContent = combatant ? 'Сохранить' : 'Добавить в трекер';
  $('current-hp-field').hidden = !combatant;
  form.elements.hp.disabled = !combatant;
  form.elements.hp.required = !!combatant;
  if (combatant) {
    for (const field of ['name', 'hp', 'maxHp', 'initiative']) form.elements[field].value = combatant[field];
  }
  $('portrait-preview').innerHTML = portrait ? `<img src="${assetURL(portrait)}" alt="Портрет">` : '＋';
  openDialog('editor');
}
$('add-combatant').onclick = () => openCombatantEditor();
$('choose-portrait').onclick = async () => { const r = await result(api.importFile('image')); if (r?.asset) { portrait = r.asset; $('portrait-preview').innerHTML = `<img src="${assetURL(portrait)}" alt="Портрет">`; } };
$('combatant-form').onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const payload = { name: f.get('name'), maxHp: Number(f.get('maxHp')), initiative: Number(f.get('initiative')), image: portrait };
  if (editingCombatant) Object.assign(payload, { id: editingCombatant, hp: Number(f.get('hp')) });
  const r = await dispatch(editingCombatant ? 'combatant:edit' : 'combatant:add', payload);
  if (r?.ok) closeDialog($('editor'));
};
$('combat-list').addEventListener('submit', async e => {
  if (!e.target.matches('.hp-form')) return; e.preventDefault();
  const input = e.target.querySelector('input'), expression = input.value.replace('−', '-');
  input.value = ''; const r = await dispatch('combatant:hp', { id: e.target.dataset.id, expression });
  if (!r?.ok) { input.value = expression; renderCombat(); }
});
$('next-turn').onclick = () => dispatch('combat:next');
$('undo-hp').onclick = () => dispatch('combatant:undo');
$('import-map').onclick = () => loadMap(api.importFile('image'));
$('paste-map').onclick = () => loadMap(api.pasteImage());
$('map-image').onload = () => { if (state) renderMap(); };
$('map-settings').onclick = () => {
  const form = $('grid-form');
  for (const key of ['grid', 'offsetX', 'offsetY', 'opacity', 'color']) form.elements[key].value = state.map[key];
  form.elements.visible.checked = state.map.visible; openDialog('grid-dialog');
};
$('grid-form').onsubmit = e => {
  e.preventDefault(); const f = e.target;
  dispatch('map:settings', { grid: Number(f.elements.grid.value), offsetX: Number(f.elements.offsetX.value), offsetY: Number(f.elements.offsetY.value), opacity: Number(f.elements.opacity.value), color: f.elements.color.value, visible: f.elements.visible.checked }); closeDialog($('grid-dialog'));
};
const viewport = $('map-viewport');
let zoomRequest = 0;
async function setZoom(value, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
  const request = ++zoomRequest, old = state.map.zoom;
  const x = (viewport.scrollLeft + anchorX) / old;
  const y = (viewport.scrollTop + anchorY) / old;
  const zoom = Math.max(0.01, Math.min(3, value));
  const response = await dispatch('map:settings', { zoom });
  if (response?.ok && request === zoomRequest) {
    viewport.scrollLeft = x * zoom - anchorX;
    viewport.scrollTop = y * zoom - anchorY;
  }
}
$('zoom-in').onclick = () => setZoom(state.map.zoom * 1.25);
$('zoom-out').onclick = () => setZoom(state.map.zoom / 1.25);
$('fit-map').onclick = async () => {
  const image = $('map-image');
  if (!image.naturalWidth) return;
  const target = Math.min((viewport.clientWidth - 8) / image.naturalWidth, (viewport.clientHeight - 8) / image.naturalHeight, 3);
  await setZoom(target, 0, 0);
  viewport.scrollTo(0, 0);
};
viewport.addEventListener('wheel', e => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  setZoom(state.map.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });
viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 || e.target.closest('[data-token]') || e.target === viewport) return;
  const { scrollLeft, scrollTop } = viewport;
  const startX = e.clientX, startY = e.clientY;
  viewport.classList.add('panning');
  viewport.setPointerCapture(e.pointerId);
  const move = event => viewport.scrollTo(scrollLeft - event.clientX + startX, scrollTop - event.clientY + startY);
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('lostpointercapture', () => {
    viewport.removeEventListener('pointermove', move);
    viewport.classList.remove('panning');
  }, { once: true });
});
$('map-viewport').addEventListener('dragover', e => { e.preventDefault(); });
$('map-viewport').addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files[0]) loadMap(api.importDrop(e.dataTransfer.files[0], 'image')); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && expanded) { e.preventDefault(); expandPanel(expanded); }
  if (e.key === 'F11') { e.preventDefault(); result(api.fullscreen()); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) { e.preventDefault(); loadMap(api.pasteImage()); }
});
$('map-tokens').addEventListener('dblclick', e => { const token = e.target.closest('[data-token]'); if (token) dispatch('token:remove', { id: token.dataset.token }); });
$('map-tokens').addEventListener('pointerdown', e => {
  const token = e.target.closest('[data-token]'); if (!token || e.button !== 0) return;
  e.preventDefault(); draggingToken = true; token.classList.add('dragging'); token.setPointerCapture(e.pointerId);
  const id = token.dataset.token, m = { ...state.map }, z = m.zoom, rect = $('map-world').getBoundingClientRect();
  let col = 0, row = 0, moved = false;
  const move = event => {
    moved = true;
    col = Math.max(0, Math.floor(((event.clientX - rect.left) / z - m.offsetX) / m.grid));
    row = Math.max(0, Math.floor(((event.clientY - rect.top) / z - m.offsetY) / m.grid));
    token.style.left = `${(m.offsetX + col * m.grid) * z}px`; token.style.top = `${(m.offsetY + row * m.grid) * z}px`;
  };
  const stop = () => {
    token.removeEventListener('pointermove', move); token.removeEventListener('pointerup', stop); token.removeEventListener('pointercancel', cancel);
    draggingToken = false; token.classList.remove('dragging');
    if (moved) dispatch('token:move', { id, col, row }); else renderMap();
  };
  const cancel = () => { moved = false; stop(); };
  token.addEventListener('pointermove', move); token.addEventListener('pointerup', stop); token.addEventListener('pointercancel', cancel);
});
$('import-audio').onclick = async () => { const r = await result(api.importFile('audio')); if (r?.asset) dispatch('music:add', { title: r.title, asset: r.asset, folder: currentFolder }); };
$('add-folder').onclick = () => askText('Новая папка', 'Название папки', '', async name => { await dispatch('music:folder', { name }); currentFolder = name; renderMusic(); });
$('import-youtube').onclick = () => {
  if (musicBusy) return toast('Трек уже загружается');
  askText('Аудио с YouTube', 'Ссылка на видео', `Трек сохранится в папке «${currentFolder}».`,
    url => result(api.downloadMusic(url, currentFolder)), 'Загрузить аудио');
};
$('cancel-music').onclick = () => result(api.cancelMusic());
$('text-form').onsubmit = e => { e.preventDefault(); const value = $('text-dialog-input').value.trim(); if (value) { const cb = textSubmit; closeDialog($('text-dialog')); Promise.resolve(cb(value)).catch(err => toast(err.message)); } };
$('track-list').addEventListener('change', e => { if (e.target.dataset.moveTrack) dispatch('music:move', { id: e.target.dataset.moveTrack, folder: e.target.value }); });
$('play-pause').onclick = () => {
  if (!state.music.current && state.music.tracks.length) dispatch('music:play', { id: state.music.tracks.find(t => t.folder === currentFolder)?.id || state.music.tracks[0].id });
  else dispatch('music:settings', { playing: !state.music.playing });
};
$('stop-music').onclick = () => dispatch('music:stop');
$('loop-music').onclick = () => dispatch('music:settings', { loop: !state.music.loop });
$('volume').oninput = e => { if (!detachedPanel) $('audio').volume = Number(e.target.value) / 100; };
$('volume').onchange = e => dispatch('music:settings', { volume: Number(e.target.value) / 100 });
$('audio').onended = () => { if (!state.music.loop) dispatch('music:settings', { playing: false }); };
$('audio').onerror = () => { if (state?.music.playing) { toast('Аудиофайл недоступен или имеет неподдерживаемый формат'); dispatch('music:settings', { playing: false }); } };
$('help').onclick = () => openDialog('help-dialog');
document.querySelectorAll('dialog').forEach(d => { d.addEventListener('close', syncRemoteBounds); d.addEventListener('click', e => { if (e.target === d) { const r = d.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeDialog(d); } }); });
function updateUI(status) { currentUpdate = status; $('updates').textContent = status.phase === 'available' ? `↓ Версия ${status.version}` : status.phase === 'downloaded' ? '↻ Установить обновление' : ['checking', 'downloading'].includes(status.phase) ? status.text : '↻ Обновления'; }
function updateMusicStatus(status) {
  musicBusy = ['loading', 'stopping'].includes(status.phase);
  $('music-transfer').hidden = !status.text;
  $('music-status').textContent = status.text;
  $('cancel-music').hidden = status.phase !== 'loading';
  $('import-youtube').disabled = musicBusy;
  const progress = $('music-progress');
  progress.hidden = !musicBusy;
  if (Number.isFinite(status.percent)) progress.value = status.percent;
  else progress.removeAttribute('value');
}
async function focusToken(id) {
  if (detachedPanel && detachedPanel !== 'map' || !detachedPanel && detached.includes('map')) return;
  if (expanded && expanded !== 'map') await expandPanel(expanded);
  const token = [...$('map-tokens').children].find(button => button.dataset.token === id);
  if (!token) return;
  token.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  token.focus({ preventScroll: true });
}
$('updates').onclick = () => result(api.update(currentUpdate?.phase === 'available' ? 'download' : currentUpdate?.phase === 'downloaded' ? 'install' : 'check'));
api.onStatus(status => {
  if (status.scope === 'update') { updateUI(status); if (['available', 'downloaded', 'error', 'latest'].includes(status.phase)) toast(status.text); }
  else if (status.scope === 'music') updateMusicStatus(status);
  else if (status.scope === 'map-focus') focusToken(status.id);
  else toast(status.text);
});
function beginResize(e, kind, panel) {
  if (e.button !== 0) return;
  if (detachedPanel) {
    e.preventDefault(); const target = e.currentTarget;
    const startX = e.screenX, startY = e.screenY, width = window.outerWidth, height = window.outerHeight;
    let latest = { width, height, screenX: startX, screenY: startY };
    target.setPointerCapture(e.pointerId);
    const move = event => { latest = { width: width + event.screenX - startX, height: height + event.screenY - startY, screenX: event.screenX, screenY: event.screenY }; api.resizeWindow(latest); };
    const finish = () => { target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', finish); api.resizeWindow({ ...latest, snap: Math.abs(latest.screenX - startX) + Math.abs(latest.screenY - startY) > 20 }); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', finish); return;
  }
  if (expanded) return;
  e.preventDefault(); const target = e.currentTarget, work = $('workspace'), bounds = work.getBoundingClientRect();
  const initial = { ...state.layout }; let next = { ...initial }, lastX = e.clientX, lastY = e.clientY;
  work.classList.add('dragging'); target.setPointerCapture(e.pointerId);
  const move = event => {
    lastX = event.clientX; lastY = event.clientY;
    const x = (event.clientX - bounds.left) / bounds.width * 100, y = (event.clientY - bounds.top) / bounds.height * 100;
    if (kind === 'left' || (kind === 'corner' && ['combat', 'music'].includes(panel))) next.left = Math.max(18, Math.min(45, x));
    if (kind === 'middle' || (kind === 'corner' && ['info', 'map'].includes(panel))) next.middle = Math.max(18, Math.min(82 - next.left, x - next.left));
    if (kind === 'top' || (kind === 'corner' && ['combat', 'info'].includes(panel))) next.top = Math.max(25, Math.min(75, y));
    work.style.setProperty('--left', next.left + '%'); work.style.setProperty('--middle', next.middle + '%'); work.style.setProperty('--top', next.top + '%'); syncRemoteBounds();
  };
  const finish = () => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', cancel);
    work.classList.remove('dragging');
    if (kind === 'corner' && lastX > bounds.right - 45 && lastY > bounds.bottom - 45) { renderLayout(); expandPanel(panel); }
    else dispatch('layout:settings', next);
  };
  const cancel = () => { next = initial; finish(); };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', cancel);
}
document.querySelectorAll('[data-split]').forEach(el => el.addEventListener('pointerdown', e => beginResize(e, el.dataset.split)));
document.querySelectorAll('.resize-grip').forEach(el => el.addEventListener('pointerdown', e => beginResize(e, 'corner', el.closest('[data-panel]').dataset.panel)));
new ResizeObserver(syncRemoteBounds).observe($('workspace'));
window.addEventListener('resize', syncRemoteBounds);
api.onState(value => { state = value.state; detached = value.detached; renderAll(); });
(async () => {
  const initial = await api.init(); state = initial.state; detached = initial.detached; updateUI(initial.updateStatus); updateMusicStatus(initial.musicStatus);
  $('version').textContent = `v${initial.version}`;
  if (detachedPanel) {
    document.body.classList.add('detached');
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== detachedPanel; });
    const dock = document.querySelector(`[data-detach="${detachedPanel}"]`); dock.textContent = '↙'; dock.title = 'Вернуть в ширму';
    document.title = document.querySelector(`[data-panel="${detachedPanel}"] h1`).textContent + ' · Ширма мастера';
  }
  renderAll();
})();
