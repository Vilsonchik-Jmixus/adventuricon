/* The renderer never reads local files directly. All mutations go through validated IPC. */
const $ = id => document.getElementById(id);
const api = window.dm;
const detachedPanel = new URLSearchParams(location.search).get('panel');
const isPlayerMap = detachedPanel === 'map';
let state, detached = [], currentFolder = 'Общее', portrait = null, expanded = null;
let editingCombatant = null, editingContext, gridContext, playerSettingsContext, managedSlot;
let toastTimer, textSubmit, draggingToken = false, animating = false, musicBusy = false, currentUpdate;
let mapCamera = null, previewToken = null, pendingMapFrame = 0;
let restoreMapCamera = false, cancelTokenDrag = null;
let masterAutoFit = false, expandedMapMode = 'fill', boardLayout, boardProjection;
let playerBlackout = false;
let combatRoles = {}, conditionDefinitions = [], conditionEdit, initiativeContext;
let reference = { tab: 'info', pages: {} };
let presentation = null, recentImages = [], galleryOpen = false, selectedImage = null, previewImage = null;
const assetURL = name => `dm://app/assets/${encodeURIComponent(name)}`;
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500); }
async function result(promise) { const value = await promise; if (value?.error) toast(value.error); return value; }
const currentContext = () => ({ expectedBattleId: state?.activeBattleId, expectedMapId: state?.activeMapId });
const dispatch = (type, payload = {}, context = currentContext()) => result(api.dispatch(type, { ...payload, ...context }));
const mirrorMap = (preview, mapId = state.activeMapId) => api.mirrorMap({ ...preview, mapId });
function openDialog(id) { $(id).showModal(); syncRemoteBounds(); }
function closeDialog(dialog) { dialog.close(); syncRemoteBounds(); }
function avatar(c, cls = 'avatar') { return `<span class="${cls}">${c.image ? `<img src="${assetURL(c.image)}" alt="">` : escapeHTML(c.name.slice(0, 1).toUpperCase())}</span>`; }
function combatPortrait(c) {
  if (!c.image) return avatar(c);
  return `<button class="portrait-button" data-preview-portrait="${c.id}" title="Открыть портрет" aria-label="Открыть портрет: ${escapeHTML(c.name)}">${avatar(c)}</button>`;
}
function conditionChips(actor, compact = false) {
  return actor.effects.map(effect => `<span class="condition-chip" data-condition="${effect.id}" title="${escapeHTML(effect.name)}">
    ${escapeHTML(compact ? effect.badge : effect.name)}
  </span>`).join('');
}
function rollText(c) {
  const roll = c.initiativeRoll;
  if (!roll) return '';
  return `d20 ${roll.die} ${roll.bonus >= 0 ? '+' : '−'} ${Math.abs(roll.bonus)} = ${c.initiative}`;
}
function combatCard(c, draft, placed, index, count) {
  const details = [combatRoles[c.role], rollText(c), state.turn === c.id && 'Ходит сейчас',
    state.acted.includes(c.id) && 'Ход завершён'].filter(Boolean);
  return `<article class="combat-card ${state.turn === c.id ? 'active-turn' : ''} ${c.hp === 0 ? 'dead' : ''}" data-id="${c.id}">
    <div class="combat-main">${combatPortrait(c)}<div class="combat-details">
      <strong class="combat-name">${escapeHTML(c.name)}</strong>
      <div class="combat-meta" title="${escapeHTML(details.join(' · '))}">${escapeHTML(details.join(' · '))}</div>
    </div><div class="queue-arrows">
      <button type="button" class="card-menu" data-order-id="${c.id}" data-order-delta="-1" aria-label="Выше в очереди: ${escapeHTML(c.name)}" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="card-menu" data-order-id="${c.id}" data-order-delta="1" aria-label="Ниже в очереди: ${escapeHTML(c.name)}" ${index + 1 === count ? 'disabled' : ''}>↓</button>
    </div><button type="button" class="hp-readout" data-edit="${c.id}" title="Изменить ХП">${c.hp}<small> / ${c.maxHp}</small></button></div>
    <div class="hp-bar"><div style="width:${c.hp / c.maxHp * 100}%"></div></div>
    <div class="combat-bottom">
      <form class="hp-form" data-id="${c.id}"><input aria-label="Изменение ХП ${escapeHTML(c.name)}" placeholder="−7 / +5" value="${escapeHTML(draft || '')}" maxlength="12"><button title="Применить ХП">↵</button></form>
      <button class="to-map" ${placed ? `data-token-focus="${c.id}" title="Показать жетон на карте"` : `data-token-add="${c.id}"`}>${placed ? '✓ На карте' : '◇ На карту'}</button>
      <button class="card-menu condition-button" data-conditions="${c.id}" title="Состояния" aria-label="Состояния ${escapeHTML(c.name)}">◆</button>
      <button class="card-menu initiative-value" data-initiative="${c.id}" title="Вписать инициативу" aria-label="Инициатива ${escapeHTML(c.name)}">${c.initiative ?? '—'}</button>
      ${c.role === 'enemy' ? `<button class="card-menu initiative-icon" data-roll-actor="${c.id}" title="Бросить инициативу" aria-label="Бросить инициативу ${escapeHTML(c.name)}">d20</button>` : ''}
      <button class="card-menu" data-edit="${c.id}" title="Редактировать участника" aria-label="Редактировать участника">✎</button>
      <button class="card-menu" data-duplicate="${c.id}" title="Дублировать">⧉</button>
      <button class="card-menu" data-remove="${c.id}" title="Удалить">×</button>
    </div>
    ${c.effects.length ? `<div class="card-conditions">${conditionChips(c)}</div>` : ''}
  </article>`;
}
function renderCombat() {
  $('combat-count').textContent = state.combatants.length;
  $('round').textContent = `Раунд ${state.round} · ${state.acted.length}/${state.combatants.length}`;
  $('round').title = 'Номер раунда и количество завершённых ходов';
  $('undo-hp').disabled = !state.history.length;
  $('next-turn').disabled = !state.combatants.length;
  $('roll-initiative').disabled = !state.combatants.some(c => c.role === 'enemy');
  $('reset-order').hidden = !state.manualOrder;
  // Preserve unfinished HP input across changes arriving from another window.
  const drafts = new Map([...document.querySelectorAll('.hp-form input')].map(el => [el.closest('form').dataset.id, el.value]));
  const focused = document.activeElement?.closest('.hp-form')?.dataset.id;
  const byId = new Map(state.combatants.map(c => [c.id, c]));
  const order = state.order.map(id => byId.get(id));
  const placed = new Set(state.tokens.map(t => t.combatantId));
  const empty = '<div class="empty-state"><span class="empty-symbol">⚔</span><strong>Бойцов пока нет</strong></div>';
  $('combat-list').innerHTML = order.length
    ? order.map((c, index) => combatCard(c, drafts.get(c.id), placed.has(c.id), index, order.length)).join('')
    : empty;
  if (focused) document.querySelector(`.hp-form[data-id="${focused}"] input`)?.focus();
  if ($('initiative-dialog').open) renderInitiative();
}
function renderMap() {
  const m = state.map;
  const img = $('map-image');
  const src = m.image ? assetURL(m.image) : m.demo === false ? null : new URL('assets/demo-map.svg', location.href).href;
  if (src && img.src !== src) {
    img.removeAttribute('src');
    img.src = src;
  } else if (!src && img.hasAttribute('src')) img.removeAttribute('src');
  img.hidden = !src;
  const zoom = mapDrawingZoom();
  const width = (img.complete && img.naturalWidth) || 1600, height = (img.complete && img.naturalHeight) || 1100;
  const mode = mapMode();
  boardLayout = {
    width: (mode === 'follow' ? Math.max(width, ...state.tokens.map(t => (t.col + 2) * m.grid + m.offsetX)) : width) * zoom,
    height: (mode === 'follow' ? Math.max(height, ...state.tokens.map(t => (t.row + 2) * m.grid + m.offsetY)) : height) * zoom,
    rotation: m.rotation ?? 0, mode, zoom
  };
  img.style.width = `${width * zoom}px`; img.style.height = `${height * zoom}px`;
  const world = $('map-world');
  world.style.width = `${boardLayout.width}px`;
  world.style.height = `${boardLayout.height}px`;
  world.style.setProperty('--token-orientation', `${-boardLayout.rotation}deg`);
  world.style.setProperty('--grid-size', m.grid * zoom + 'px'); world.style.setProperty('--grid-color', m.color);
  world.style.setProperty('--grid-x', m.offsetX * zoom + 'px'); world.style.setProperty('--grid-y', m.offsetY * zoom + 'px');
  world.style.setProperty('--grid-opacity', m.visible ? m.opacity : 0);
  $('zoom-label').textContent = mode === 'follow' ? `${Math.round(zoom * 100)}%` : 'Авто';
  $('token-count').textContent = state.tokens.length;
  $('player-settings').hidden = !!detachedPanel || !detached.includes('map');
  layoutMap();
  if (draggingToken) return;
  const actors = new Map(state.mapCombatants.map(actor => [actor.id, actor]));
  $('map-tokens').innerHTML = state.tokens.map(t => {
    const c = actors.get(t.combatantId); if (!c) return '';
    const hp = Number.isFinite(c.hp) ? `${c.hp}/${c.maxHp}` : '';
    const details = [c.name, hp && `${hp} ХП`, ...c.effects.map(effect => effect.name)].filter(Boolean).join(' · ');
    return `<button class="token ${c.hp === 0 ? 'dead' : ''} ${state.turn === c.id ? 'active-turn' : ''}" data-token="${c.id}" title="${escapeHTML(details)}" style="left:${(m.offsetX + t.col * m.grid) * zoom}px;top:${(m.offsetY + t.row * m.grid) * zoom}px">
      <span class="token-face">${avatar(c, 'token-body')}${hp ? `<span class="token-hp">${hp}</span>` : ''}
      ${c.effects.length ? `<span class="token-conditions">${conditionChips(c, true)}</span>` : ''}</span>
    </button>`;
  }).join('');
  if (restoreMapCamera && img.complete) {
    restoreMapCamera = false;
    viewport.scrollTo(
      mapCamera ? mapCamera.x * zoom - viewport.clientWidth / 2 : 0,
      mapCamera ? mapCamera.y * zoom - viewport.clientHeight / 2 : 0
    );
    if (!isPlayerMap) queueMapCamera();
  }
  if (isPlayerMap) {
    const unique = new Map(state.mapCombatants.flatMap(c => c.effects.map(effect => [effect.badge, effect.name])));
    const legend = $('map-condition-legend');
    const content = [...unique].filter(([badge, name]) => badge !== name)
      .map(([badge, name]) => `<span><b>${escapeHTML(badge)}</b> ${escapeHTML(name)}</span>`).join('');
    legend.hidden = !content;
    legend.innerHTML = content;
    paintPlayerMap();
  }
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
  document.querySelectorAll('[data-panel]').forEach(panel =>
    panel.classList.toggle('is-detached', !detachedPanel && panel.dataset.panel !== 'map' &&
      !(panel.dataset.panel === 'characters' && galleryOpen) && detached.includes(panel.dataset.panel)));
}
function renderAll() {
  if (isPlayerMap) {
    renderMap();
    renderPresentation();
    return;
  }
  renderLayout(); renderSlots(); renderCombat(); renderMap(); renderMusic(); renderPresentation();
  if ($('bookmarks-dialog').open) renderBookmarks();
  if (galleryOpen) renderGallery();
  requestAnimationFrame(syncRemoteBounds);
}
function syncRemoteBounds() {
  const modal = !!document.querySelector('dialog[open]');
  document.querySelectorAll('[data-remote-surface]').forEach(el => {
    const panel = el.closest('.panel'); const rect = el.getBoundingClientRect();
    const failed = reference.pages[el.dataset.remoteSurface]?.failed;
    const visible = !failed && !modal && !animating && !el.closest('[hidden]') && !panel.classList.contains('is-detached') &&
      (!expanded || panel.dataset.panel === expanded);
    api.remoteBounds(el.dataset.remoteSurface, visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
  });
}
function renderReference() {
  const { tab, pages } = reference;
  for (const button of document.querySelectorAll('[data-reference-tab]')) {
    button.setAttribute('aria-pressed', String(button.dataset.referenceTab === tab));
  }
  $('rules-surface').hidden = tab !== 'info';
  $('web-surface').hidden = tab !== 'web';
  $('reference-links').hidden = tab !== 'info';
  $('reference-query').placeholder = tab === 'info' ? 'Поиск по dnd.su' : 'Веб-поиск или HTTPS-адрес';
  const page = pages[tab];
  document.querySelector('[data-reference-nav="back"]').disabled = !page?.canBack;
  document.querySelector('[data-reference-nav="forward"]').disabled = !page?.canForward;
  $('reference-query').title = page?.url || '';
  const message = document.querySelector(`[data-reference-message="${tab}"]`);
  message.textContent = page?.failed ? 'Страница недоступна. Обнови её или открой в браузере.' : tab === 'info' ? 'Справочник dnd.su' : 'Поиск в интернете';
  $('save-bookmark').disabled = !page?.bookmarkable;
  syncRemoteBounds();
}
function renderBookmarks() {
  $('bookmarks-empty').hidden = !!state.bookmarks.length;
  $('bookmarks-list').innerHTML = state.bookmarks.map(item => `<div class="bookmark-row">
    <button type="button" class="quiet" data-bookmark="${item.id}" title="${escapeHTML(item.url)}">${escapeHTML(item.title)}</button>
    <button type="button" class="quiet" data-remove-bookmark="${item.id}" aria-label="Удалить закладку: ${escapeHTML(item.title)}">×</button>
  </div>`).join('');
}
$('reference-form').onsubmit = async event => {
  event.preventDefault();
  const field = $('reference-query');
  if (field.value.trim()) await result(api.referenceAction('search', field.value));
};
$('open-bookmarks').onclick = () => { renderBookmarks(); openDialog('bookmarks-dialog'); };
$('save-bookmark').onclick = async () => {
  if ((await result(api.referenceAction('save-bookmark')))?.ok) toast('Страница в закладках');
};
$('open-gemini').onclick = async () => {
  const response = await result(api.referenceAction('gemini', $('reference-query').value));
  if (response?.copied) toast('Вопрос скопирован. Вставь его в Gemini.');
};
async function expandPanel(id) {
  if (detachedPanel) return result(api.fullscreen());
  const panel = document.querySelector(`[data-panel="${id}"]`), before = panel.getBoundingClientRect();
  const wasMap = expanded === 'map';
  if (expanded && expanded !== id) document.querySelector(`[data-panel="${expanded}"]`).classList.remove('expanded');
  const opening = expanded !== id;
  expanded = opening ? id : null;
  if (opening && id === 'map') expandedMapMode = 'fill';
  panel.classList.toggle('expanded', opening); $('workspace').classList.toggle('has-expanded', opening);
  if (wasMap || expanded === 'map') renderMap();
  const after = panel.getBoundingClientRect(); animating = true; syncRemoteBounds();
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await panel.animate([{ transformOrigin: '0 0', transform: `translate(${before.x - after.x}px,${before.y - after.y}px) scale(${before.width / after.width},${before.height / after.height})`, opacity: 0.8 }, { transformOrigin: '0 0', transform: 'none', opacity: 1 }], { duration: 220, easing: 'cubic-bezier(.2,.75,.25,1)' }).finished.catch(() => {});
  }
  animating = false; syncRemoteBounds();
}
async function loadMap(promise) {
  const context = currentContext();
  const r = await result(promise);
  if (r?.asset && (await dispatch('map:image', { image: r.asset }, context))?.ok) {
    if (context.expectedMapId === state.activeMapId) { masterAutoFit = true; renderMap(); }
    toast('Карта загружена');
  }
}
function askText(title, label, hint, callback, submit = 'Добавить', initialValue = '') {
  $('text-dialog-title').textContent = title; $('text-dialog-label').textContent = label;
  $('text-dialog-input').value = initialValue; $('text-dialog-input').placeholder = title.includes('YouTube') ? 'https://www.youtube.com/watch?v=…' : '';
  $('text-dialog-hint').textContent = hint; $('text-dialog-submit').textContent = submit; textSubmit = callback;
  openDialog('text-dialog'); $('text-dialog-input').focus();
}
function slotInfo(kind) {
  return kind === 'battle'
    ? { options: state.battleChoices, id: state.activeBattleId, heading: 'Настройки боя', create: 'Новый бой' }
    : { options: state.mapChoices, id: state.activeMapId, heading: 'Настройки карты', create: 'Новая карта' };
}
function syncOptions(select, options, selected) {
  const signature = JSON.stringify(options.map(({ id, title }) => [id, title]));
  if (select.dataset.options !== signature) {
    select.replaceChildren(...options.map(({ id, title }) => new Option(title, id)));
    select.dataset.options = signature;
  }
  select.value = selected ?? '';
}
function renderSlots() {
  for (const kind of ['battle', 'map']) {
    const { options, id } = slotInfo(kind);
    syncOptions($(`${kind}-select`), options, id);
  }
}
for (const kind of ['battle', 'map']) {
  $(`${kind}-select`).onchange = async e => {
    const response = await dispatch(`${kind}:select`, { id: e.target.value });
    if (!response?.ok) renderSlots();
  };
  $(`create-${kind}`).onclick = () =>
    askText(slotInfo(kind).create, 'Название', '', title => dispatch(`${kind}:create`, { title }), 'Создать');
  $(`manage-${kind}`).onclick = () => {
    const { options, id, heading } = slotInfo(kind);
    const entry = options.find(item => item.id === id);
    managedSlot = { kind, id, context: currentContext() };
    $('slot-title').textContent = heading;
    $('slot-name').value = entry.title;
    $('linked-map-field').hidden = kind !== 'battle';
    $('slot-hint').textContent = kind === 'battle' ? 'Копия перенесёт участников с полными ХП и начнётся с первого раунда.'
      : 'Копия сохранит изображение и настройки сетки. Жетоны можно расставить заново.';
    $('delete-slot').disabled = options.length <= 1;
    if (kind === 'battle') {
      syncOptions($('linked-map'), [{ id: '', title: 'Не переключать карту' }, ...state.mapChoices], entry.linkedMapId);
    }
    openDialog('slot-dialog');
  };
}
$('slot-form').onsubmit = async e => {
  e.preventDefault();
  const { kind, context } = managedSlot;
  const response = await dispatch(`${kind}:save`, { title: $('slot-name').value, linkedMapId: $('linked-map').value }, context);
  if (response?.ok) closeDialog($('slot-dialog'));
};
$('duplicate-slot').onclick = async () => {
  const { kind, context } = managedSlot;
  const name = $('slot-name').value.trim();
  const response = await dispatch(`${kind}:duplicate`, { title: name ? name + ' · копия' : '' }, context);
  if (response?.ok) closeDialog($('slot-dialog'));
};
$('delete-slot').onclick = async () => {
  const { kind, id } = managedSlot;
  const message = kind === 'battle'
    ? 'Удалить бой, его участников и их жетоны со всех карт?'
    : 'Удалить карту, её настройки и расстановку жетонов?';
  if (confirm(message) && (await dispatch(`${kind}:remove`, { id }))?.ok) closeDialog($('slot-dialog'));
};
document.addEventListener('click', async e => {
  const button = e.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-close-dialog')) closeDialog(button.closest('dialog'));
  else if (button.dataset.detach) { if (detachedPanel) await result(api.dock()); else await result(api.detach(button.dataset.detach)); }
  else if (button.dataset.focus) await result(api.detach(button.dataset.focus));
  else if (button.dataset.expand) await expandPanel(button.dataset.expand);
  else if (button.dataset.remote) { const [id, action] = button.dataset.remote.split(':'); await result(api.remoteAction(id, action)); }
  else if (button.dataset.referenceNav) await result(api.referenceAction(button.dataset.referenceNav));
  else if (button.dataset.referenceTab) await result(api.referenceAction('tab', button.dataset.referenceTab));
  else if (button.dataset.referenceLink) await result(api.referenceAction('shortcut', button.dataset.referenceLink));
  else if (button.dataset.bookmark) {
    closeDialog($('bookmarks-dialog'));
    await result(api.referenceAction('bookmark', button.dataset.bookmark));
  }
  else if (button.dataset.removeBookmark) await result(api.referenceAction('remove-bookmark', button.dataset.removeBookmark));
  else if (button.dataset.conditions) openConditions(button.dataset.conditions);
  else if (button.dataset.initiative) {
    const actor = state.combatants.find(c => c.id === button.dataset.initiative);
    const context = currentContext();
    if (actor) askText('Инициатива', 'Результат броска', actor.name,
      value => dispatch('combat:initiative', { id: actor.id, value }, context), 'Сохранить', String(actor.initiative ?? ''));
  }
  else if (button.dataset.orderId) await dispatch('combat:move', { id: button.dataset.orderId, delta: Number(button.dataset.orderDelta) });
  else if (button.dataset.rollActor) await dispatch('combat:roll-initiative', { id: button.dataset.rollActor });
  else if (button.dataset.rollRole) await dispatch('combat:roll-initiative', { role: button.dataset.rollRole }, initiativeContext);
  else if (button.dataset.previewPortrait) showImagePreview({ source: 'portrait', id: button.dataset.previewPortrait });
  else if (button.dataset.galleryId !== undefined) {
    selectedImage = button.dataset.galleryId; renderGallery();
    [...$('gallery-list').children].find(el => el.dataset.galleryId === selectedImage)?.focus();
  }
  else if (button.dataset.recent !== undefined) showImagePreview(recentImages[Number(button.dataset.recent)]);
  else if (button.dataset.tokenAdd) {
    if ((await dispatch('token:add', { id: button.dataset.tokenAdd }))?.ok) toast('Боец добавлен на карту');
  }
  else if (button.dataset.tokenFocus) await result(api.showToken(button.dataset.tokenFocus));
  else if (button.dataset.edit) openCombatantEditor(state.combatants.find(c => c.id === button.dataset.edit));
  else if (button.dataset.duplicate) await dispatch('combatant:duplicate', { id: button.dataset.duplicate });
  else if (button.dataset.remove) await dispatch('combatant:remove', { id: button.dataset.remove });
  else if (button.dataset.folder) { currentFolder = button.dataset.folder; renderMusic(); }
  else if (button.dataset.play) await dispatch('music:play', { id: button.dataset.play });
  else if (button.dataset.deleteTrack) await dispatch('music:remove', { id: button.dataset.deleteTrack });
});
function selectGallery(open) {
  galleryOpen = open;
  $('show-gallery').setAttribute('aria-pressed', String(open));
  $('show-sheets').setAttribute('aria-pressed', String(!open));
  $('gallery').hidden = !open;
  $('sheet-content').hidden = open;
  renderLayout();
  if (open) renderGallery();
  syncRemoteBounds();
}
function selectedGalleryImage() {
  return state.gallery.find(item => item.id === selectedImage);
}
function renderGallery() {
  if (!state) return;
  const item = selectedGalleryImage() || state.gallery[0];
  selectedImage = item?.id ?? null;
  $('gallery-empty').hidden = !!item;
  $('gallery-preview').hidden = !item;
  if (item) {
    const image = $('gallery-image'), url = assetURL(item.image);
    if (image.src !== url) image.src = url;
    $('gallery-title').textContent = item.title;
    $('gallery-title').title = item.title;
    const showing = presentation?.source === 'gallery' && presentation.id === item.id;
    $('present-gallery').textContent = showing ? 'На экране игроков' : 'Показать игрокам';
    $('present-gallery').disabled = showing;
  }
  $('gallery-list').innerHTML = state.gallery.map(entry => `<button class="gallery-tile" data-gallery-id="${entry.id}"
      aria-pressed="${entry.id === selectedImage}" title="${escapeHTML(entry.title)}">
      <img src="${assetURL(entry.image)}" alt="" loading="lazy"><span>${escapeHTML(entry.title)}</span>
    </button>`).join('');
  $('gallery-history').hidden = !recentImages.length;
  $('gallery-recent').innerHTML = recentImages.map((entry, index) => `<button class="gallery-tile" data-recent="${index}" title="${escapeHTML(entry.title)}">
      <img src="${assetURL(entry.image)}" alt="" loading="lazy"><span>${escapeHTML(entry.title)}</span>
    </button>`).join('');
}
function renderPresentation() {
  $('display-label').hidden = isPlayerMap || !presentation;
  $('return-map').hidden = isPlayerMap || !presentation;
  if (presentation && !isPlayerMap) $('display-label').textContent = `Игрокам: ${presentation.title}`;
  if (!isPlayerMap) return;
  $('player-art').hidden = !presentation;
  const image = $('presented-image');
  if (presentation) {
    const url = assetURL(presentation.image);
    if (image.src !== url) image.src = url;
  } else image.removeAttribute('src');
  document.body.classList.toggle('showing-art', !!presentation);
}
function showImagePreview(ref) {
  if (!ref) return;
  const image = ref.source === 'gallery'
    ? state.gallery.find(item => item.id === ref.id)
    : state.combatants.find(combatant => combatant.id === ref.id) ?? ref;
  if (!image?.image) return;
  previewImage = ref;
  $('image-dialog-title').textContent = image.title ?? image.name;
  $('image-dialog-preview').src = assetURL(image.image);
  openDialog('image-dialog');
}
async function presentImage(ref) {
  const response = await result(api.showPlayers(ref.source, ref.id));
  if (response?.ok && response.covered && ref.source !== 'map') toast('Сними затемнение в настройках экрана игроков, чтобы показать изображение');
  return response?.ok;
}
async function importGallery(promise) {
  const image = await result(promise);
  if (!image?.asset) return;
  const saved = await dispatch('gallery:add', { image: image.asset, title: image.title });
  if (saved?.id) {
    selectedImage = saved.id;
    if (galleryOpen) renderGallery();
  }
}
$('show-sheets').onclick = () => selectGallery(false);
$('show-gallery').onclick = () => selectGallery(true);
$('import-gallery').onclick = () => importGallery(api.importFile('image'));
$('paste-gallery').onclick = () => importGallery(api.pasteImage());
$('gallery').addEventListener('dragover', e => e.preventDefault());
$('gallery').addEventListener('drop', async e => {
  e.preventDefault();
  // Read the complete FileList before awaiting, as drag data then expires.
  for (const file of [...e.dataTransfer.files]) await importGallery(api.importDrop(file, 'image'));
});
$('present-gallery').onclick = () => { if (selectedImage) presentImage({ source: 'gallery', id: selectedImage }); };
$('enlarge-gallery').onclick = () => showImagePreview({ source: 'gallery', id: selectedImage });
$('present-preview').onclick = async () => {
  if (previewImage && await presentImage(previewImage)) closeDialog($('image-dialog'));
};
$('rename-gallery').onclick = () => {
  const item = selectedGalleryImage();
  if (item) askText('Переименовать изображение', 'Название', '', title =>
    dispatch('gallery:rename', { id: item.id, title }), 'Сохранить', item.title);
};
$('remove-gallery').onclick = async () => {
  if (selectedImage) await dispatch('gallery:remove', { id: selectedImage });
};
$('return-map').onclick = () => presentImage({ source: 'map' });
function openCombatantEditor(combatant) {
  const form = $('combatant-form');
  form.reset();
  editingCombatant = combatant?.id ?? null;
  editingContext = currentContext();
  portrait = combatant?.image ?? null;
  form.elements.role.value = combatant?.role ?? 'enemy';
  form.elements.initiativeBonus.value = combatant?.initiativeBonus ?? 0;
  updateBonusField();
  $('editor-title').textContent = combatant ? 'Редактировать участника' : 'Добавить участника';
  $('editor-submit').textContent = combatant ? 'Сохранить' : 'Добавить в трекер';
  $('current-hp-field').hidden = !combatant;
  form.elements.hp.disabled = !combatant;
  form.elements.hp.required = !!combatant;
  if (combatant) {
    for (const field of ['name', 'hp', 'maxHp']) form.elements[field].value = combatant[field];
  }
  $('portrait-preview').innerHTML = portrait ? `<img src="${assetURL(portrait)}" alt="Портрет">` : '＋';
  openDialog('editor');
}
function updateBonusField() {
  const form = $('combatant-form');
  const nonEnemy = form.elements.role.value !== 'enemy';
  $('initiative-bonus-field').hidden = nonEnemy;
  form.elements.initiativeBonus.disabled = nonEnemy;
}
$('combatant-role').onchange = updateBonusField;
$('add-combatant').onclick = () => openCombatantEditor();
$('choose-portrait').onclick = async () => { const r = await result(api.importFile('image')); if (r?.asset) { portrait = r.asset; $('portrait-preview').innerHTML = `<img src="${assetURL(portrait)}" alt="Портрет">`; } };
$('combatant-form').onsubmit = async e => {
  e.preventDefault(); const f = new FormData(e.target);
  const payload = {
    name: f.get('name'), maxHp: Number(f.get('maxHp')),
    ...(f.has('initiativeBonus') ? { initiativeBonus: Number(f.get('initiativeBonus')) } : {}),
    role: f.get('role'), image: portrait
  };
  if (editingCombatant) Object.assign(payload, { id: editingCombatant, hp: Number(f.get('hp')) });
  const r = await dispatch(editingCombatant ? 'combatant:edit' : 'combatant:add', payload, editingContext);
  if (r?.ok) closeDialog($('editor'));
};
$('combat-list').addEventListener('submit', async e => {
  if (!e.target.matches('.hp-form')) return; e.preventDefault();
  const input = e.target.querySelector('input'), expression = input.value.replace('−', '-');
  input.value = ''; const r = await dispatch('combatant:hp', { id: e.target.dataset.id, expression });
  if (!r?.ok) { input.value = expression; renderCombat(); }
});
$('next-turn').onclick = () => dispatch('combat:next');
$('reset-order').onclick = () => dispatch('combat:sort');
function renderInitiative() {
  for (const button of document.querySelectorAll('[data-roll-role]')) {
    button.disabled = !state.combatants.some(c => c.role === button.dataset.rollRole);
  }
  $('initiative-results').innerHTML = state.combatants
    .filter(c => c.initiativeRoll)
    .sort((a, b) => b.initiative - a.initiative)
    .map(c => `<div><strong>${escapeHTML(c.name)}</strong><span>${escapeHTML(rollText(c))}</span></div>`).join('');
}
$('roll-initiative').onclick = () => {
  initiativeContext = currentContext();
  renderInitiative();
  openDialog('initiative-dialog');
};
function openConditions(id) {
  const actor = state.combatants.find(c => c.id === id);
  if (!actor) return;
  conditionEdit = { id, context: currentContext() };
  $('condition-actor').textContent = actor.name;
  $('auto-unconscious').hidden = actor.hp !== 0;
  $('exhaustion-level').value = actor.exhaustion ?? 0;
  const selected = new Set(actor.conditions ?? []);
  $('condition-list').innerHTML = conditionDefinitions.filter(effect => effect.id !== 'exhaustion').map(effect =>
    `<label class="checkbox-label"><input type="checkbox" name="condition" value="${effect.id}" ${selected.has(effect.id) ? 'checked' : ''}> ${escapeHTML(effect.name)}</label>`
  ).join('');
  openDialog('condition-dialog');
}
$('condition-form').onsubmit = async event => {
  event.preventDefault();
  const data = new FormData(event.target);
  const response = await dispatch('combatant:conditions', {
    id: conditionEdit.id, conditions: data.getAll('condition'), exhaustion: Number($('exhaustion-level').value)
  }, conditionEdit.context);
  if (response?.ok) closeDialog($('condition-dialog'));
};
$('map-tokens').addEventListener('contextmenu', event => {
  const token = event.target.closest('[data-token]');
  if (isPlayerMap || !token) return;
  event.preventDefault();
  openConditions(token.dataset.token);
});
$('undo-hp').onclick = () => dispatch('combatant:undo');
$('import-map').onclick = () => loadMap(api.importFile('image'));
$('paste-map').onclick = () => loadMap(api.pasteImage());
$('map-image').onload = () => { if (state) renderMap(); };
$('map-settings').onclick = () => {
  gridContext = currentContext();
  const form = $('grid-form');
  for (const key of ['grid', 'offsetX', 'offsetY', 'opacity', 'color']) form.elements[key].value = state.map[key];
  form.elements.visible.checked = state.map.visible; openDialog('grid-dialog');
};
$('grid-form').onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  const response = await dispatch('map:settings', { grid: Number(f.elements.grid.value), offsetX: Number(f.elements.offsetX.value), offsetY: Number(f.elements.offsetY.value), opacity: Number(f.elements.opacity.value), color: f.elements.color.value, visible: f.elements.visible.checked }, gridContext);
  if (response?.ok) closeDialog($('grid-dialog'));
};
const viewport = $('map-viewport');
function queueMapCamera() {
  if (detachedPanel || pendingMapFrame || restoreMapCamera || !state) return;
  const mapId = state.activeMapId;
  pendingMapFrame = requestAnimationFrame(() => {
    pendingMapFrame = 0;
    if (mapId !== state.activeMapId || mapMode() !== 'follow' || !viewport.clientWidth || !viewport.clientHeight) return;
    const zoom = state.map.zoom;
    mirrorMap({ camera: {
      x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
      y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom
    } }, mapId);
  });
}
function paintPlayerMap() {
  if (!state) return;
  const zoom = mapDrawingZoom();
  layoutMap();
  if (mapMode() === 'follow' && mapCamera) viewport.scrollTo(mapCamera.x * zoom - viewport.clientWidth / 2, mapCamera.y * zoom - viewport.clientHeight / 2);
  if (!previewToken) return;
  const token = [...$('map-tokens').children].find(button => button.dataset.token === previewToken.id);
  if (token) positionToken(token, state.map, previewToken.col, previewToken.row, zoom);
}
function mapDrawingZoom() {
  return mapMode() === 'follow' ? state.map.zoom : 1;
}
function mapMode() {
  const image = $('map-image');
  if (!image.complete || !image.naturalWidth) return 'follow';
  if (isPlayerMap) return state.map.playerFit ?? 'fill';
  if (expanded === 'map') return expandedMapMode;
  return masterAutoFit ? 'fit' : 'follow';
}
function layoutMap() {
  if (!boardLayout || !viewport.clientWidth || !viewport.clientHeight) return;
  const frame = $('map-frame');
  boardProjection = MapGeometry.project({ ...boardLayout, viewportWidth: viewport.clientWidth, viewportHeight: viewport.clientHeight });
  frame.style.width = boardProjection.width + 'px';
  frame.style.height = boardProjection.height + 'px';
  $('map-world').style.transform = `matrix(${boardProjection.matrix.join(',')})`;
  const fitted = boardLayout.mode !== 'follow';
  viewport.classList.toggle('fitted-map', fitted);
  if (fitted) viewport.scrollTo(0, 0);
}
function mapPointAt(x, y) {
  const frame = $('map-frame').getBoundingClientRect();
  return MapGeometry.inverse(boardProjection.matrix, x - frame.left, y - frame.top);
}
function positionToken(token, map, col, row, zoom = map.zoom) {
  token.style.left = `${(map.offsetX + col * map.grid) * zoom}px`;
  token.style.top = `${(map.offsetY + row * map.grid) * zoom}px`;
}
viewport.addEventListener('scroll', queueMapCamera, { passive: true });
new ResizeObserver(() => {
  if (isPlayerMap) paintPlayerMap();
  else { layoutMap(); queueMapCamera(); }
}).observe(viewport);
let zoomRequest = 0;
async function changeZoom(factor, anchorX = viewport.clientWidth / 2, anchorY = viewport.clientHeight / 2) {
  if (!boardProjection) return;
  const mapId = state.activeMapId;
  const request = ++zoomRequest;
  const viewportRect = viewport.getBoundingClientRect();
  const original = mapPointAt(viewportRect.x + anchorX, viewportRect.y + anchorY);
  const oldZoom = boardLayout.zoom;
  const [a, b, c, d] = boardProjection.matrix;
  const displayedZoom = Math.min(Math.hypot(a, b), Math.hypot(c, d)) * oldZoom;
  const zoom = Math.max(0.01, Math.min(24, displayedZoom * factor));
  masterAutoFit = false;
  expandedMapMode = 'follow';
  const response = await dispatch('map:settings', { zoom });
  if (response?.ok && request === zoomRequest && mapId === state.activeMapId) {
    const [aa, bb, cc, dd, dx, dy] = boardProjection.matrix;
    const x = original.x / oldZoom * zoom;
    const y = original.y / oldZoom * zoom;
    viewport.scrollLeft = aa * x + cc * y + dx - anchorX;
    viewport.scrollTop = bb * x + dd * y + dy - anchorY;
    queueMapCamera();
  }
}
$('zoom-in').onclick = () => changeZoom(1.25);
$('zoom-out').onclick = () => changeZoom(1 / 1.25);
$('fit-map').onclick = () => {
  if (expanded === 'map') expandedMapMode = 'fit';
  else masterAutoFit = true;
  renderMap();
};
function rotateMap(delta) {
  const rotation = ((state.map.rotation ?? 0) + delta + 360) % 360;
  dispatch('map:settings', { rotation });
}
$('rotate-map-left').onclick = () => rotateMap(-90);
$('rotate-map-right').onclick = () => rotateMap(90);
viewport.addEventListener('wheel', e => {
  if (isPlayerMap) { e.preventDefault(); return; }
  if (!e.ctrlKey) return;
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  changeZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });
viewport.addEventListener('pointerdown', e => {
  if (isPlayerMap || e.button !== 0 || e.target.closest('[data-token]') || e.target === viewport || !boardProjection) return;
  viewport.focus({ preventScroll: true });
  if (e.shiftKey && !detachedPanel) {
    const point = mapPointAt(e.clientX, e.clientY);
    const zoom = mapDrawingZoom();
    const ping = { x: point.x / zoom, y: point.y / zoom };
    showMapPing(ping);
    mirrorMap({ ping });
    return;
  }
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
function showMapPing({ x, y }) {
  if (!state || (isPlayerMap && playerBlackout)) return;
  $('map-world').querySelector('.map-ping')?.remove();
  const ping = document.createElement('span');
  ping.className = 'map-ping';
  const zoom = mapDrawingZoom();
  ping.style.left = x * zoom + 'px';
  ping.style.top = y * zoom + 'px';
  $('map-world').append(ping);
  setTimeout(() => ping.remove(), 1200);
}
$('player-settings').onclick = () => {
  playerSettingsContext = currentContext();
  $('toggle-player-health').checked = state.map.playerHealth !== false;
  $('toggle-player-blackout').checked = playerBlackout;
  $('player-fit').value = state.map.playerFit ?? 'fill';
  openDialog('player-dialog');
};
$('toggle-player-health').onchange = e => dispatch('map:settings', { playerHealth: e.target.checked }, playerSettingsContext);
$('player-fit').onchange = e => dispatch('map:settings', { playerFit: e.target.value }, playerSettingsContext);
$('toggle-player-blackout').onchange = e => {
  playerBlackout = e.target.checked;
  $('player-settings').setAttribute('aria-pressed', String(playerBlackout));
  mirrorMap({ blackout: playerBlackout });
};
$('map-viewport').addEventListener('dragover', e => { e.preventDefault(); });
$('map-viewport').addEventListener('drop', e => { e.preventDefault(); if (!isPlayerMap && e.dataTransfer.files[0]) loadMap(api.importDrop(e.dataTransfer.files[0], 'image')); });
document.addEventListener('keydown', e => {
  if (e.ctrlKey && e.key.toLowerCase() === 'l' && (!detachedPanel || detachedPanel === 'info') &&
      !$('workspace').querySelector('.info.is-detached') && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    if (expanded && expanded !== 'info') expandPanel(expanded);
    $('reference-query').focus();
    $('reference-query').select();
  }
  if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
    if (expanded) { e.preventDefault(); expandPanel(expanded); }
    else if (isPlayerMap && document.body.classList.contains('player-fullscreen')) result(api.fullscreen());
  }
  if (e.key === 'F11') { e.preventDefault(); result(api.fullscreen()); }
  if (!isPlayerMap && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
    e.preventDefault();
    if (galleryOpen && (!expanded || expanded === 'characters') && !document.activeElement?.closest('[data-panel="map"]')) {
      importGallery(api.pasteImage());
    } else loadMap(api.pasteImage());
  }
});
$('map-tokens').addEventListener('dblclick', e => { const token = e.target.closest('[data-token]'); if (token && !isPlayerMap) dispatch('token:remove', { id: token.dataset.token }); });
$('map-tokens').addEventListener('pointerdown', e => {
  const token = e.target.closest('[data-token]'); if (!token || isPlayerMap || e.button !== 0 || !boardProjection) return;
  e.preventDefault(); draggingToken = true; token.classList.add('dragging'); token.setPointerCapture(e.pointerId);
  const id = token.dataset.token, m = { ...state.map }, z = mapDrawingZoom();
  const context = currentContext();
  let col = 0, row = 0, moved = false, previewFrame = 0;
  const move = event => {
    moved = true;
    const point = mapPointAt(event.clientX, event.clientY);
    col = Math.max(0, Math.floor((point.x / z - m.offsetX) / m.grid));
    row = Math.max(0, Math.floor((point.y / z - m.offsetY) / m.grid));
    positionToken(token, m, col, row, z);
    if (detached.includes('map') && !previewFrame) {
      previewFrame = requestAnimationFrame(() => {
        previewFrame = 0;
        mirrorMap({ token: { id, col, row } }, context.expectedMapId);
      });
    }
  };
  const stop = async () => {
    token.removeEventListener('pointermove', move); token.removeEventListener('pointerup', stop); token.removeEventListener('pointercancel', cancel);
    draggingToken = false; token.classList.remove('dragging');
    cancelTokenDrag = null;
    cancelAnimationFrame(previewFrame);
    if (moved) await dispatch('token:move', { id, col, row }, context);
    else renderMap();
    if (detached.includes('map')) mirrorMap({ token: null }, context.expectedMapId);
  };
  const cancel = () => { moved = false; stop(); };
  cancelTokenDrag = cancel;
  token.addEventListener('pointermove', move); token.addEventListener('pointerup', stop); token.addEventListener('pointercancel', cancel);
});
$('import-audio').onclick = async () => { const r = await result(api.importFile('audio')); if (r?.asset) dispatch('music:add', { title: r.title, asset: r.asset, folder: currentFolder }); };
$('add-folder').onclick = () => askText('Новая папка', 'Название папки', '', async name => { await dispatch('music:folder', { name }); currentFolder = name; renderMusic(); });
$('import-youtube').onclick = () => {
  if (musicBusy) return toast('Трек уже загружается');
  askText('MP3 с YouTube', 'Ссылка на видео', `MP3 появится в папке «${currentFolder}».`,
    url => result(api.downloadMusic(url, currentFolder)), 'Скачать MP3');
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
  if (detachedPanel) return;
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
  else if (status.scope === 'reference') {
    reference = status;
    if (!isPlayerMap) renderReference();
  }
  else if (status.scope === 'player-fullscreen' && isPlayerMap) {
    document.body.classList.toggle('player-fullscreen', status.active);
    renderMap();
  }
  else if (status.scope === 'map-preview' && isPlayerMap) {
    if (status.mapId !== state?.activeMapId) return;
    mapCamera = status.camera;
    playerBlackout = status.blackout;
    $('player-blackout').hidden = !playerBlackout;
    if (Object.hasOwn(status, 'token')) {
      previewToken = status.token;
      if (previewToken) paintPlayerMap();
      else renderMap();
    } else paintPlayerMap();
    if (status.ping) showMapPing(status.ping);
  }
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
function readWindowState(value) {
  const switched = state?.activeMapId !== value.state.activeMapId;
  const rotated = !switched && (state?.map.rotation ?? 0) !== (value.state.map.rotation ?? 0);
  if (switched || rotated) {
    cancelTokenDrag?.();
    cancelAnimationFrame(pendingMapFrame);
    pendingMapFrame = 0;
    previewToken = null;
    mapCamera = value.mapCamera;
    restoreMapCamera = true;
    if (!isPlayerMap) masterAutoFit = rotated && expanded !== 'map';
    $('map-world').querySelector('.map-ping')?.remove();
  }
  state = value.state;
  detached = value.detached;
  presentation = value.presentation;
  recentImages = value.recentImages;
}
api.onState(value => { readWindowState(value); renderAll(); });
(async () => {
  const initial = await api.init(); readWindowState(initial); updateUI(initial.updateStatus); updateMusicStatus(initial.musicStatus);
  combatRoles = initial.combatRoles;
  conditionDefinitions = initial.conditionDefinitions;
  reference = initial.reference;
  $('combatant-role').replaceChildren(...Object.entries(combatRoles).map(([id, label]) => new Option(label, id)));
  $('reference-links').innerHTML = initial.referenceLinks.map(link =>
    `<button type="button" data-reference-link="${link.id}" title="${escapeHTML(link.name)}">${escapeHTML(link.name)}</button>`
  ).join('');
  playerBlackout = initial.playerBlackout;
  $('version').textContent = `v${initial.version}`;
  if (detachedPanel) {
    document.body.classList.add('detached');
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== detachedPanel; });
    const dock = document.querySelector(`[data-detach="${detachedPanel}"]`); dock.textContent = '↙'; dock.title = 'Вернуть в ширму';
    const title = document.querySelector(`[data-panel="${detachedPanel}"] h1`)?.textContent ?? 'Листы персонажей';
    document.title = title + ' · Ширма мастера';
    if (isPlayerMap) {
      document.body.classList.add('player-map');
      document.querySelector('.map h1').textContent = 'Карта игроков';
      document.title = 'Карта игроков · Ширма мастера';
      viewport.inert = true;
      $('player-blackout').hidden = !playerBlackout;
    }
  }
  renderAll();
  if (!isPlayerMap) renderReference();
  queueMapCamera();
})();
