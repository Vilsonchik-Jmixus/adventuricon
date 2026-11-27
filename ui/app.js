/* The renderer never reads local files directly. All mutations go through validated IPC. */
const $ = id => document.getElementById(id);
const api = window.dm;
const windowParams = new URLSearchParams(location.search);
const detachedPanel = windowParams.get('panel');
const isPreview = windowParams.has('preview');
const isPlayerMap = detachedPanel === 'map';
let state, detached = [], currentFolder = 'Общее', expanded = null;
let editingCombatant = null, editingContext, gridContext, playerSettingsContext, managedSlot;
let toastTimer, textSubmit, draggingToken = false, animating = false, musicBusy = false, currentUpdate;
let mapCamera = null, previewToken = null, pendingMapFrame = 0;
let previewFrameInfo, campaignId, campaignChoices, canUndoMap = false, rulerShortcut;
let restoreMapCamera = false, cancelTokenDrag = null;
let masterAutoFit = false, expandedMapMode = 'fill', boardLayout, boardProjection;
let playerBlackout = false;
let selectedToken = null, placement = null, removal = null, editingTemplate = null;
let mapItemDraft = null, importedCharacter = null, readingCharacter = false;
let cancelEventCells;
let musicPosition, seekingTrack = false, cancelMusicFade;
const retro = !detachedPanel ? createRetroAudio() : null;
const soundTools = isPlayerMap ? null : createSoundTools({ retro, api, result, openDialog, toast });
if (!isPlayerMap && (!detachedPanel || detachedPanel === 'combat')) {
  createDiceMenu({ onToggle: syncRemoteBounds, playSound: () => result(api.soundDice()), toast });
}
const tokenDragType = 'application/x-dm-screen-token';
let combatRoles = {}, conditionDefinitions = [], conditionEdit, initiativeContext;
let reference = { tab: 'info', pages: {} };
let referenceTabsKey;
let shortcutBindings = DmShortcuts.defaults;
let presentation = null, recentImages = [], charactersTab = 'sheets', selectedImage = null, previewImage = null;
const workspaceTabs = { game: 'sheets', preparation: 'notes' };
const workspaceMode = () => state?.layout.mode ?? 'game';
const workspaceSizes = () => workspaceMode() === 'preparation' ? state.layout.preparation : state.layout;
const assetURL = name => `dm://app/assets/${encodeURIComponent(name)}?campaign=${encodeURIComponent(campaignId ?? 'main')}`;
const escapeHTML = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function toast(message) { $('toast').textContent = message; $('toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').classList.remove('show'), 4500); }
async function result(promise) { const value = await promise; if (value?.error) toast(value.error); return value; }
const currentContext = () => ({ expectedBattleId: state?.activeBattleId, expectedMapId: state?.activeMapId, expectedCampaignId: campaignId });
const dispatch = (type, payload = {}, context = currentContext()) => result(api.dispatch(type, { ...payload, ...context }));
const mirrorMap = (preview, mapId = state.activeMapId) => api.mirrorMap({ ...preview, mapId, campaignId });
function openDialog(id) {
  const dice = $('dice-menu');
  if (dice.matches(':popover-open')) dice.hidePopover();
  $(id).showModal();
  syncRemoteBounds();
}
function closeDialog(dialog) { dialog.close(); syncRemoteBounds(); }
const textField = target => target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]');
function imageDraft(dialog, { choose, paste, remove, status, preview, limit = 1 }) {
  let assets = [], request = 0, busy = false;
  function update(next, message = '') {
    assets = next;
    preview(next);
    if (remove) remove.hidden = !assets.length;
    status.textContent = message;
    status.hidden = !message;
  }
  function setBusy(value) {
    busy = value;
    choose.disabled = paste.disabled = value;
    if (value) dialog.setAttribute('aria-busy', 'true');
    else dialog.removeAttribute('aria-busy');
  }
  function reset(next = []) {
    request++;
    setBusy(false);
    update(next.filter(Boolean));
  }
  async function read(load) {
    if (busy || !dialog.open) return;
    if (limit > 1 && assets.length >= limit) {
      update(assets, `В заметке помещается до ${limit} картинок.`);
      return;
    }
    const pending = ++request;
    const campaign = campaignId;
    setBusy(true);
    try {
      const response = await load();
      if (pending !== request || !dialog.open || campaign !== campaignId) return;
      if (response?.asset) update(limit === 1 ? [response.asset] : [...assets, response.asset]);
      else if (response?.error) update(assets, response.error);
    } catch {
      if (pending === request && dialog.open && campaign === campaignId) update(assets, 'Не удалось загрузить изображение.');
    } finally {
      if (pending === request) setBusy(false);
    }
  }
  const pasteImage = () => read(() => api.pasteImage());
  choose.onclick = () => read(() => api.importFile('image'));
  paste.onclick = pasteImage;
  if (remove) remove.onclick = () => reset();
  dialog.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyV' && !textField(event.target)) {
      event.preventDefault();
      pasteImage();
    }
  });
  dialog.addEventListener('paste', event => {
    if (!Array.from(event.clipboardData?.items ?? []).some(item => item.kind === 'file')) return;
    event.preventDefault();
    pasteImage();
  });
  dialog.addEventListener('dragover', event => {
    if (event.dataTransfer.types.includes('Files')) event.preventDefault();
  });
  dialog.addEventListener('drop', event => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    event.preventDefault();
    read(() => api.importDrop(file, 'image'));
  });
  return { reset, pasteImage, remove: asset => update(assets.filter(entry => entry !== asset)),
    get assets() { return assets; }, get busy() { return busy; } };
}
const portraitDraft = imageDraft($('editor'), {
  choose: $('choose-portrait'), paste: $('paste-portrait'), remove: $('remove-portrait'), status: $('portrait-status'),
  preview: ([asset]) => { $('portrait-preview').innerHTML = asset ? `<img src="${assetURL(asset)}" alt="Портрет">` : '＋'; }
});
const noteDraft = imageDraft($('story-dialog'), {
  choose: $('choose-story-image'), paste: $('paste-story-image'), status: $('story-image-status'), limit: 12,
  preview: assets => {
    const preview = $('story-image-preview');
    preview.hidden = !assets.length;
    preview.replaceChildren(...assets.map((asset, index) => {
      const tile = document.createElement('div'), image = document.createElement('img'), remove = document.createElement('button');
      image.src = assetURL(asset);
      image.alt = `Изображение ${index + 1}`;
      remove.type = 'button';
      remove.dataset.pixelIcon = 'trash';
      remove.setAttribute('aria-label', `Убрать изображение ${index + 1}`);
      remove.onclick = () => noteDraft.remove(asset);
      tile.append(image, remove);
      return tile;
    }));
  }
});
function renderTheme(id) {
  if (!Object.hasOwn(ScreenThemes, id)) return;
  const root = document.documentElement;
  const theme = ScreenThemes[id];
  if (id === 'tavern') delete root.dataset.theme;
  else root.dataset.theme = id;
  root.style.setProperty('--theme-base', theme.background);
  root.style.setProperty('--theme-accent', theme.accent);
  $('theme-brand-icon').src = themeIcon(id);
  for (const button of $('screen-themes').children) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === id));
  }
}
function populateThemePicker() {
  $('screen-themes').replaceChildren(...Object.entries(ScreenThemes).map(([id, theme]) => {
    const button = document.createElement('button');
    button.className = 'screen-theme';
    button.type = 'button';
    button.dataset.themeChoice = id;
    const swatch = document.createElement('span');
    swatch.className = 'theme-swatch';
    swatch.setAttribute('aria-hidden', 'true');
    swatch.style.setProperty('--swatch-base', theme.background);
    swatch.style.setProperty('--swatch-accent', theme.accent);
    button.append(swatch, theme.name);
    button.onclick = () => result(api.setTheme(id));
    return button;
  }));
}
function avatar(c, cls = 'avatar') { return `<span class="${cls}">${c.image ? `<img src="${assetURL(c.image)}" alt="">` : escapeHTML(c.name.slice(0, 1).toUpperCase())}</span>`; }
function combatPortrait(c) {
  if (!c.image) return avatar(c);
  return `<button class="portrait-button" data-preview-portrait="${c.id}" title="Открыть портрет" aria-label="Открыть портрет: ${escapeHTML(c.name)}">${avatar(c)}</button>`;
}
function conditionChips(actor, compact = false) {
  return actor.effects.map(effect => `<span class="condition-chip" data-condition="${effect.id}" title="${escapeHTML(effect.name)}${effect.rounds ? ` · Раундов осталось ${effect.rounds}` : ''}">
    ${escapeHTML(compact ? effect.badge : effect.name)}${effect.rounds ? ` · ${effect.rounds}` : ''}
  </span>`).join('');
}
function rollText(c) {
  const roll = c.initiativeRoll;
  if (!roll) return '';
  return `d20 ${roll.die} ${roll.bonus >= 0 ? '+' : '−'} ${Math.abs(roll.bonus)} = ${c.initiative}`;
}
function combatCard(c, placed, index, count, acted) {
  const bonus = c.role !== 'enemy' && c.initiativeBonus !== 0 ? `Иниц. ${c.initiativeBonus > 0 ? '+' : ''}${c.initiativeBonus}` : '';
  const details = [combatRoles[c.role], rollText(c), bonus, state.turn === c.id && 'Ходит сейчас',
    acted.has(c.id) && 'Ход завершён'].filter(Boolean);
  return `<article class="combat-card ${state.turn === c.id ? 'active-turn' : ''} ${c.hp === 0 ? 'dead' : ''}" data-id="${c.id}" draggable="true">
    <div class="combat-main">${combatPortrait(c)}<div class="combat-details">
      <strong class="combat-name" title="${escapeHTML(c.name)}">${escapeHTML(c.name)}</strong>
      <div class="combat-meta" title="${escapeHTML(details.join(' · '))}">${escapeHTML(details.join(' · '))}</div>
    </div><div class="queue-arrows">
      <button type="button" class="card-menu" data-order-id="${c.id}" data-order-delta="-1" aria-label="Выше в очереди: ${escapeHTML(c.name)}" ${index === 0 ? 'disabled' : ''} data-pixel-icon="turn"></button>
      <button type="button" class="card-menu" data-order-id="${c.id}" data-order-delta="1" aria-label="Ниже в очереди: ${escapeHTML(c.name)}" ${index + 1 === count ? 'disabled' : ''} data-pixel-icon="turn"></button>
    </div><button type="button" class="hp-readout" data-pixel-icon="heart" data-edit="${c.id}" title="Изменить ХП">${c.hp}<small> / ${c.maxHp}</small></button></div>
    <div class="hp-bar"><div style="width:${c.hp / c.maxHp * 100}%"></div></div>
    <div class="combat-bottom">
      <form class="hp-form" data-id="${c.id}"><input aria-label="Изменение ХП ${escapeHTML(c.name)}" placeholder="−7 / +5" maxlength="12"><button title="Применить ХП" data-pixel-icon="check"></button></form>
      <button class="to-map" ${placed ? `data-token-remove="${c.id}" title="Убрать с карты · Shift + щелчок показывает жетон"` : `data-token-add="${c.id}" title="Выбрать клетку на карте"`} data-pixel-icon="${placed ? 'check' : 'token'}">${placed ? 'На карте' : 'На карту'}</button>
      <button class="card-menu condition-button" data-conditions="${c.id}" title="Состояния" aria-label="Состояния ${escapeHTML(c.name)}" data-pixel-icon="shield"></button>
      <button class="card-menu initiative-value" data-initiative="${c.id}" title="Вписать инициативу" aria-label="Инициатива ${escapeHTML(c.name)}" data-pixel-icon="${c.role === 'enemy' ? 'pen' : 'dice'}">${c.initiative ?? '—'}</button>
      ${c.role === 'enemy' ? `<button class="card-menu initiative-icon" data-roll-actor="${c.id}" title="Бросить инициативу" aria-label="Бросить инициативу ${escapeHTML(c.name)}" data-pixel-icon="dice"></button>` : ''}
      <button class="card-menu" data-edit="${c.id}" title="Редактировать участника" aria-label="Редактировать участника" data-pixel-icon="pen"></button>
      <button class="card-menu" data-duplicate="${c.id}" title="Дублировать" data-pixel-icon="copy"></button>
      <button class="card-menu" data-remove="${c.id}" title="Удалить" data-pixel-icon="trash"></button>
    </div>
    ${c.effects.length ? `<div class="card-conditions">${conditionChips(c)}</div>` : ''}
  </article>`;
}
const hpDrafts = new Map();
let combatBattle;
const cardMarkup = new WeakMap();
function renderCards(list, cards, key, empty = '') {
  const existing = new Map([...list.children].map(node => [node.dataset[key], node]));
  const keep = new Set(cards.map(({ id }) => id));
  for (const [id, node] of existing) if (!keep.has(id)) node.remove();
  if (!cards.length) {
    list.innerHTML = empty;
    return;
  }
  const template = document.createElement('template');
  let cursor = list.firstElementChild;
  for (const { id, html } of cards) {
    const old = existing.get(id);
    let node = old;
    if (!node || cardMarkup.get(node) !== html) {
      template.innerHTML = html;
      node = template.content.firstElementChild;
      cardMarkup.set(node, html);
      if (old) {
        old.replaceWith(node);
        if (old === cursor) cursor = node;
      }
    }
    if (node !== cursor) list.insertBefore(node, cursor);
    cursor = node.nextElementSibling;
  }
}
function renderCombat() {
  $('combat-count').textContent = state.combatants.length;
  $('round').textContent = `Раунд ${state.round} · ${state.acted.length}/${state.combatants.length}`;
  $('round').title = 'Номер раунда и количество завершённых ходов';
  $('undo-hp').disabled = !state.history.length;
  $('next-turn').disabled = !state.combatants.length;
  $('roll-initiative').disabled = !state.combatants.length;
  $('reset-order').hidden = !state.manualOrder;
  if (combatBattle !== state.activeBattleId) {
    combatBattle = state.activeBattleId;
    hpDrafts.clear();
    $('combat-search').value = $('combat-role-filter').value = '';
  }
  $('combat-search-row').hidden = !state.combatants.length;
  const query = $('combat-search').value.trim().toLocaleLowerCase('ru');
  const role = $('combat-role-filter').value;
  const focus = document.activeElement;
  const focused = focus?.closest('.hp-form')?.dataset.id;
  const byId = new Map(state.combatants.map(c => [c.id, c]));
  const current = byId.get(state.turn);
  $('current-turn').hidden = !current;
  if (current) {
    $('turn-actor').textContent = current.name;
    $('turn-actor').title = `Ходит ${current.name} · Перейти к карточке`;
    $('turn-hp').textContent = `${current.hp}/${current.maxHp}`;
    for (const button of $('current-turn').querySelectorAll('[data-quick-hp]')) {
      button.disabled = button.dataset.quickHp.startsWith('-') ? current.hp === 0 : current.hp === current.maxHp;
    }
  }
  const placed = new Set(state.tokens.map(t => t.combatantId));
  const acted = new Set(state.acted);
  const cards = state.order.flatMap((id, index) => {
    const c = byId.get(id);
    return (role && role !== c.role || query && !c.name.toLocaleLowerCase('ru').includes(query)) ? [] :
      [{ id, html: combatCard(c, placed.has(id), index, state.order.length, acted) }];
  });
  const list = $('combat-list');
  renderCards(list, cards, 'id', `<div class="empty-state"><strong>${state.combatants.length ? 'Никого не нашли' : 'Бойцов пока нет'}</strong></div>`);
  for (const id of hpDrafts.keys()) if (!byId.has(id)) hpDrafts.delete(id);
  for (const input of list.querySelectorAll('.hp-form input')) {
    const value = hpDrafts.get(input.form.dataset.id) ?? '';
    if (input.value !== value) input.value = value;
  }
  ambience.combat(list, byId, state.activeBattleId, state.turn, state.round);
  if (focused && document.activeElement !== focus) list.querySelector(`.hp-form[data-id="${CSS.escape(focused)}"] input`)?.focus();
  if ($('initiative-dialog').open) renderInitiative();
}
let lastTokenActors, mapActorLookup;
function mapActors() {
  if (lastTokenActors !== state.mapCombatants) {
    lastTokenActors = state.mapCombatants;
    mapActorLookup = new Map(lastTokenActors.map(actor => [actor.id, actor]));
  }
  return mapActorLookup;
}
function frameMarkup(id) {
  const [, , light, shade, shape, decoration] = TokenStyle.frame(id);
  return `<span class="pixel-token-frame" data-shape="${shape}" data-decoration="${decoration}" style="--frame-light:${light};--frame-shade:${shade}" aria-hidden="true"></span>`;
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
  let worldWidth = width, worldHeight = height;
  if (mode === 'follow') {
    const actors = mapActors();
    for (const token of state.tokens) {
      const span = Math.max(1, TokenStyle.size(actors.get(token.combatantId)?.tokenSize)) + 1;
      worldWidth = Math.max(worldWidth, (token.col + span) * m.grid + m.offsetX);
      worldHeight = Math.max(worldHeight, (token.row + span) * m.grid + m.offsetY);
    }
  }
  boardLayout = {
    width: worldWidth * zoom, height: worldHeight * zoom,
    rotation: (isPlayerMap ? m.playerRotation : null) ?? m.rotation ?? 0, mode, zoom
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
  $('fit-map').setAttribute('aria-pressed', String(mode === 'fit'));
  $('token-count').textContent = state.tokens.length;
  $('player-settings').hidden = !!detachedPanel || !detached.some(id => id === 'map' || id === 'preview');
  $('undo-map').disabled = !canUndoMap;
  layoutMap();
  mapScene.render(state, boardLayout, previewToken, campaignId);
  portalTools?.render(zoom, mapScene.isEditing());
  if (!isPlayerMap) renderNotePins(zoom);
  renderMapTokens(zoom);
  mapTools?.render();
  if (mapTools) {
    const count = hiddenEnemies().length;
    const reveal = $('reveal-hidden-enemies');
    reveal.hidden = count === 0;
    if (count) reveal.textContent = `Раскрыть врагов (${count})`;
  }
  if (restoreMapCamera && img.complete) {
    restoreMapCamera = false;
    if (mapCamera && mode === 'follow') centerMapCamera(mapCamera);
    else viewport.scrollTo(0, 0);
    if (!isPlayerMap) queueMapCamera();
  }
  if (isPlayerMap) paintPlayerMap();
}
function renderMapTokens(zoom) {
  if (draggingToken) return;
  const m = state.map;
  if (selectedToken && !state.tokens.some(t => t.combatantId === selectedToken)) selectedToken = null;
  const focusedToken = document.activeElement?.dataset.token;
  const actors = mapActors();
  const tokens = state.tokens.flatMap(t => {
    const c = actors.get(t.combatantId); if (!c) return [];
    const size = TokenStyle.size(c.tokenSize);
    if (isPlayerMap && !mapScene.tokenVisible(t.combatantId === previewToken?.id ? previewToken : t, size)) return [];
    const hp = Number.isFinite(c.hp) ? `${c.hp}/${c.maxHp}` : '';
    const details = [c.name, hp && `${hp} ХП`, ...c.effects.map(effect => effect.name)].filter(Boolean).join(' · ');
    const html = `<button class="token ${c.hp === 0 ? 'dead' : ''} ${state.turn === c.id ? 'active-turn' : ''} ${selectedToken === c.id ? 'selected-token' : ''}" data-token="${c.id}" data-size="${size}" title="${escapeHTML(details + (t.hidden ? ' · Скрыт от игроков' : ''))}" aria-label="${escapeHTML(c.name)}">
      <span class="token-face">${avatar(c, 'token-body')}${frameMarkup(c.tokenFrame)}${t.hidden ? '<span class="token-secret" data-pixel-icon="eye" aria-label="Скрыт от игроков"></span>' : ''}${hp ? `<span class="token-hp">${hp}</span>` : ''}
      ${c.effects.length ? `<span class="token-conditions">${conditionChips(c, true)}</span>` : ''}</span>
    </button>`;
    return [{ id: c.id, html, col: t.col, row: t.row }];
  });
  const tokenLayer = $('map-tokens');
  renderCards(tokenLayer, tokens, 'token');
  for (const [index, { col, row }] of tokens.entries()) {
    positionToken(tokenLayer.children[index], m, col, row, zoom);
  }
  if (focusedToken) [...$('map-tokens').children].find(token => token.dataset.token === focusedToken)?.focus({ preventScroll: true });
  if (isPlayerMap) {
    const visibleIds = new Set([...$('map-tokens').children].map(button => button.dataset.token));
    const unique = new Map(state.mapCombatants.filter(c => visibleIds.has(c.id)).flatMap(c => c.effects.map(effect => [effect.badge, effect.name])));
    const legend = $('map-condition-legend');
    const content = [...unique].filter(([badge, name]) => badge !== name)
      .map(([badge, name]) => `<span><b>${escapeHTML(badge)}</b> ${escapeHTML(name)}</span>`).join('');
    legend.hidden = !content;
    if (legend.innerHTML !== content) legend.innerHTML = content;
  }
}
let renderedMusic = {};
function renderMusic() {
  const { folders, tracks, current: trackId } = state.music;
  if (!folders.includes(currentFolder)) currentFolder = folders[0];
  const folderChanged = renderedMusic.folder !== currentFolder || renderedMusic.folders !== folders;
  const listChanged = folderChanged || renderedMusic.tracks !== tracks;
  if (folderChanged) {
    $('folders').innerHTML = state.music.folders.map(f => `<button class="folder ${f === currentFolder ? 'selected' : ''}" data-folder="${escapeHTML(f)}" data-pixel-icon="folder">${escapeHTML(f)}</button>`).join('');
  }
  if (listChanged) {
    const folderTracks = tracks.filter(t => t.folder === currentFolder);
    const options = folders.map(f => `<option${f === currentFolder ? ' selected' : ''}>${escapeHTML(f)}</option>`).join('');
    $('track-list').innerHTML = folderTracks.length ? folderTracks.map(t => `<div class="track"><button class="track-play" data-play="${t.id}" title="Воспроизвести" data-pixel-icon="play"></button><span class="track-title" title="${escapeHTML(t.title)}">${escapeHTML(t.title)}</span><select data-move-track="${t.id}" aria-label="Папка трека">${options}</select><button class="track-delete" data-delete-track="${t.id}" title="Удалить трек" data-pixel-icon="trash"></button></div>`).join('') : '<div class="empty-state"><strong>В этой папке пока нет треков</strong></div>';
  }
  if (listChanged || renderedMusic.trackId !== trackId) {
    $('track-list').querySelector('.track.current')?.classList.remove('current');
    $('track-list').querySelector(`[data-play="${CSS.escape(trackId ?? '')}"]`)?.closest('.track').classList.add('current');
    seekingTrack = false;
  }
  renderedMusic = { folder: currentFolder, folders, tracks, trackId };
  const current = tracks.find(t => t.id === trackId);
  $('current-title').textContent = current?.title || 'Выберите трек';
  $('play-pause').dataset.pixelIcon = state.music.playing ? 'pause' : 'play';
  $('play-pause').setAttribute('aria-label', state.music.playing ? 'Пауза' : 'Воспроизвести');
  $('loop-music').classList.toggle('enabled', state.music.loop);
  if (document.activeElement !== $('volume')) $('volume').value = state.music.volume * 100;
  // One permanent audio owner prevents double playback when the music panel detaches.
  if (!detachedPanel) {
    const audio = $('audio'), reset = state.music.reset || 0;
    const source = current ? assetURL(current.asset) : null;
    const sourceChanged = (audio.dataset.source ?? null) !== source;
    audio.loop = state.music.loop;
    const resetting = audio.dataset.reset !== String(reset);
    if (resetting) {
      if (audio.readyState) audio.currentTime = 0;
      audio.dataset.reset = String(reset);
    }
    if (resetting || sourceChanged || !state.music.playing) cancelMusicFade?.();
    if (!cancelMusicFade) audio.volume = state.music.volume;
    if (!current) {
      if (audio.hasAttribute('src')) { audio.pause(); audio.removeAttribute('src'); audio.load(); delete audio.dataset.source; }
    }
    else {
      if (sourceChanged) { audio.src = source; audio.dataset.source = source; }
      if (resetting && state.music.playing && state.music.fadeIn === reset) {
        audio.volume = 0;
        let frame;
        const startFade = () => {
          const start = performance.now();
          const update = now => {
            const fraction = Math.max(0, Math.min(1, (now - start) / 350));
            audio.volume = state.music.volume * fraction;
            if (fraction < 1) frame = requestAnimationFrame(update);
            else cancelMusicFade = null;
          };
          frame = requestAnimationFrame(update);
        };
        cancelMusicFade = () => {
          audio.removeEventListener('playing', startFade);
          cancelAnimationFrame(frame);
          cancelMusicFade = null;
        };
        if (!audio.paused && audio.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) startFade();
        else audio.addEventListener('playing', startFade, { once: true });
      }
      if (state.music.playing && audio.paused) {
        const context = currentContext();
        const currentTrack = current.id;
        audio.play().catch(error => {
          if (error.name === 'AbortError' || context.expectedCampaignId !== campaignId || state.music.current !== currentTrack) return;
          toast('Не удалось воспроизвести файл. Попробуйте другой формат.');
          dispatch('music:settings', { playing: false }, context);
        });
      }
      else if (!state.music.playing && !audio.paused) audio.pause();
    }
  }
  renderMusicPosition();
}
function trackClock(seconds) {
  const total = Math.floor(seconds);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}
function renderMusicPosition() {
  if (!state?.music) return;
  const position = musicPosition?.campaignId === campaignId && musicPosition.trackId === state.music.current ? musicPosition : null;
  const slider = $('music-seek');
  slider.disabled = !(position?.duration > 0);
  slider.max = position?.duration || 1;
  if (!seekingTrack || slider.disabled) slider.value = position?.time || 0;
  const time = trackClock(Number(slider.value)), duration = trackClock(position?.duration || 0);
  if ($('music-time').textContent !== time) $('music-time').textContent = time;
  if ($('music-duration').textContent !== duration) $('music-duration').textContent = duration;
}
function reportMusicPosition() {
  if (!state?.music) return;
  const audio = $('audio');
  const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
  const time = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
  musicPosition = { campaignId, trackId: state.music.current, duration, time };
  renderMusicPosition();
  if (detached.includes('music')) api.publishMusicPosition(musicPosition);
}
function seekTrack(request) {
  const audio = $('audio');
  if (!state?.music.current || request.campaignId !== campaignId || request.trackId !== state.music.current ||
      !Number.isFinite(request.time) || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
  audio.currentTime = Math.max(0, Math.min(audio.duration, request.time));
  reportMusicPosition();
}
function renderDetachedPanels() {
  document.querySelectorAll('[data-panel]').forEach(panel =>
    panel.classList.toggle('is-detached', !detachedPanel && panel.dataset.panel !== 'map' &&
      !(panel.dataset.panel === 'characters' && charactersTab !== 'sheets') && detached.includes(panel.dataset.panel)));
}
function renderLayout() {
  const w = $('workspace'), sizes = workspaceSizes();
  w.style.setProperty('--left', sizes.left + '%');
  w.style.setProperty('--middle', sizes.middle + '%');
  w.style.setProperty('--top', sizes.top + '%');
  if (!detachedPanel && w.dataset.mode !== workspaceMode()) {
    w.dataset.mode = workspaceMode();
    $('workspace-modes').hidden = false;
    $('preparation-scenes').hidden = workspaceMode() !== 'preparation';
    document.querySelectorAll('[data-workspace-mode]').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.workspaceMode === workspaceMode())));
    selectCharacters(workspaceTabs[workspaceMode()]);
  }
  renderDetachedPanels();
}
$('workspace-modes').addEventListener('click', async event => {
  const mode = event.target.closest('[data-workspace-mode]')?.dataset.workspaceMode;
  if (!mode || mode === workspaceMode()) return;
  if (expanded) await expandPanel(expanded);
  await dispatch('layout:mode', { mode });
});
function renderAll() {
  if (isPlayerMap) {
    renderMap();
    renderPresentation();
    return;
  }
  renderLayout(); renderSlots(); renderCombat(); renderMap(); renderMusic(); renderPresentation();
  if ($('bookmarks-dialog').open) renderBookmarks();
  if ($('library-dialog').open) renderLibrary();
  if (charactersTab === 'gallery') renderGallery();
  if (charactersTab === 'notes') storyBoard.render();
  if (!detachedPanel) sessionTools.render();
  requestAnimationFrame(syncRemoteBounds);
}
function syncRemoteBounds() {
  const modal = !!document.querySelector('dialog[open]');
  const diceBounds = document.querySelector('#dice-menu:popover-open')?.getBoundingClientRect();
  document.querySelectorAll('[data-remote-surface]').forEach(el => {
    const panel = el.closest('.panel'); const rect = el.getBoundingClientRect();
    const failed = reference.pages[el.dataset.remoteSurface]?.failed;
    const overlapsDice = diceBounds && rect.left < diceBounds.right && rect.right > diceBounds.left &&
      rect.top < diceBounds.bottom && rect.bottom > diceBounds.top;
    const visible = !failed && !modal && !overlapsDice && !animating && !el.closest('[hidden]') && !panel.classList.contains('is-detached') &&
      (!expanded || panel.dataset.panel === expanded);
    api.remoteBounds(el.dataset.remoteSurface, visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null);
  });
}
function renderReference() {
  const { tab, kind, pages, tabs } = reference;
  const extra = $('reference-extra-tabs'), tabsKey = JSON.stringify(tabs);
  if (tabsKey !== referenceTabsKey) {
    referenceTabsKey = tabsKey;
    extra.hidden = !tabs.length;
    extra.replaceChildren(...tabs.map(entry => {
      const group = document.createElement('div'), open = document.createElement('button'), close = document.createElement('button');
      open.type = close.type = 'button';
      open.dataset.referenceTab = entry.id;
      open.textContent = open.title = entry.title;
      close.dataset.closeReferenceTab = entry.id;
      close.dataset.pixelIcon = 'close';
      close.setAttribute('aria-label', 'Закрыть вкладку ' + entry.title);
      group.append(open, close);
      return group;
    }));
  }
  for (const button of document.querySelectorAll('[data-reference-tab]')) {
    button.setAttribute('aria-pressed', String(button.dataset.referenceTab === tab));
  }
  $('rules-surface').hidden = kind !== 'info';
  $('web-surface').hidden = kind !== 'web';
  $(kind === 'info' ? 'rules-surface' : 'web-surface').dataset.remoteSurface = tab;
  $('reference-links').hidden = kind !== 'info';
  $('reference-query').placeholder = kind === 'info' ? 'Поиск по dnd.su' : 'Веб-поиск или HTTPS-адрес';
  const page = pages[tab];
  $('reference-zoom').textContent = (page?.zoom ?? 100) + '%';
  $('sheets-zoom').textContent = reference.sheetsZoom + '%';
  const card = dndCardLink(page?.url);
  const drag = $('drag-dnd-card');
  drag.hidden = !card;
  if (card) {
    drag.textContent = card.kind === 'creature' ? 'В бой' : 'На карту';
    drag.dataset.pixelIcon = card.kind === 'creature' ? 'swords' : 'bag';
    drag.title = card.kind === 'creature' ? 'Добавить или перетащить существо в трекер'
      : 'Добавить или перетащить предмет на карту';
  }
  document.querySelector('[data-reference-nav="back"]').disabled = !page?.canBack;
  document.querySelector('[data-reference-nav="forward"]').disabled = !page?.canForward;
  $('reference-query').title = page?.url || '';
  const message = document.querySelector(`[data-reference-message="${kind}"]`);
  message.textContent = page?.failed ? 'Страница недоступна. Обнови её или открой в браузере.' : kind === 'info' ? 'Справочник dnd.su' : 'Поиск в интернете';
  $('save-bookmark').disabled = !page?.bookmarkable;
  syncRemoteBounds();
}
function renderBookmarks() {
  $('bookmarks-empty').hidden = !!state.bookmarks.length;
  $('bookmarks-list').innerHTML = state.bookmarks.map(item => `<div class="bookmark-row">
    <button type="button" class="quiet" data-bookmark="${item.id}" title="${escapeHTML(item.url)}">${escapeHTML(item.title)}</button>
    <button type="button" class="quiet" data-remove-bookmark="${item.id}" aria-label="Удалить закладку: ${escapeHTML(item.title)}" data-pixel-icon="trash"></button>
  </div>`).join('');
}
$('reference-form').onsubmit = async event => {
  event.preventDefault();
  const field = $('reference-query');
  if (field.value.trim()) await result(api.referenceAction('search', field.value));
};
$('open-bookmarks').onclick = () => { renderBookmarks(); openDialog('bookmarks-dialog'); };
$('new-reference-tab').onclick = () => result(api.referenceAction('new-tab'));
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
function askText(title, label, hint, callback, submit = 'Добавить', initialValue = '', chooseFog = false) {
  $('text-dialog-title').textContent = title; $('text-dialog-label').textContent = label;
  $('text-dialog-input').value = initialValue; $('text-dialog-input').placeholder = title.includes('YouTube') ? 'https://www.youtube.com/watch?v=…' : '';
  $('text-dialog-hint').textContent = hint; $('text-dialog-submit').textContent = submit; textSubmit = callback;
  $('new-map-fog').hidden = !chooseFog;
  $('new-map-fog-enabled').checked = false;
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
    askText(slotInfo(kind).create, 'Название', '', title => dispatch(`${kind}:create`, {
      title, fog: kind === 'map' && $('new-map-fog-enabled').checked,
    }), 'Создать', '', kind === 'map');
  $(`manage-${kind}`).onclick = () => {
    const { options, id, heading } = slotInfo(kind);
    const entry = options.find(item => item.id === id);
    managedSlot = { kind, id, context: currentContext() };
    $('slot-title').textContent = heading;
    $('slot-name').value = entry.title;
    $('linked-map-field').hidden = kind !== 'battle';
    $('slot-hint').textContent = kind === 'battle' ? 'Копия перенесёт участников с полными ХП и начнётся с первого раунда.'
      : 'Копия сохранит изображение, сетку, стены, двери и свет. Жетоны можно расставить заново.';
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
  else if (button.dataset.closeReferenceTab) await result(api.referenceAction('close-tab', button.dataset.closeReferenceTab));
  else if (button.dataset.referenceLink) await result(api.referenceAction(e.ctrlKey || e.metaKey ? 'shortcut-tab' : 'shortcut', button.dataset.referenceLink));
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
    await beginPlacement('actor', button.dataset.tokenAdd);
  }
  else if (button.dataset.tokenRemove) {
    const id = button.dataset.tokenRemove;
    if (e.shiftKey) await result(api.showToken(id));
    else askRemoveToken(id);
  }
  else if (button.dataset.libraryBattle) await dispatch('library:deploy', { id: button.dataset.libraryBattle });
  else if (button.dataset.libraryMap) {
    closeDialog($('library-dialog'));
    await beginPlacement('template', button.dataset.libraryMap);
  }
  else if (button.dataset.libraryEdit) {
    const entry = state.library.find(item => item.id === button.dataset.libraryEdit);
    if (entry) openCombatantEditor(entry, true);
  }
  else if (button.dataset.libraryRemove) {
    if (confirm('Удалить заготовку?')) await dispatch('library:remove', { id: button.dataset.libraryRemove });
  }
  else if (button.dataset.edit) openCombatantEditor(state.combatants.find(c => c.id === button.dataset.edit));
  else if (button.dataset.duplicate) await dispatch('combatant:duplicate', { id: button.dataset.duplicate });
  else if (button.dataset.remove) await dispatch('combatant:remove', { id: button.dataset.remove });
  else if (button.dataset.folder) { currentFolder = button.dataset.folder; renderMusic(); }
  else if (button.dataset.play) await dispatch('music:play', { id: button.dataset.play });
  else if (button.dataset.deleteTrack) await dispatch('music:remove', { id: button.dataset.deleteTrack });
});
const storyBoard = createStoryBoard({ getStory: () => state?.story, dispatch, openDialog, closeDialog, assetURL, imageDraft: noteDraft });
function selectCharacters(tab) {
  charactersTab = tab;
  if (!detachedPanel) workspaceTabs[workspaceMode()] = tab;
  for (const [id, panel] of [['sheets', 'sheet-content'], ['gallery', 'gallery'], ['notes', 'story']]) {
    const selected = id === tab;
    $(`show-${id}`).setAttribute('aria-pressed', String(selected));
    $(panel).hidden = !selected;
  }
  renderDetachedPanels();
  if (tab === 'gallery') renderGallery();
  if (tab === 'notes') storyBoard.render();
  syncRemoteBounds();
}
async function openStoryNote(id) {
  if (!state.story.notes.some(note => note.id === id)) return;
  if (expanded && expanded !== 'characters') await expandPanel(expanded);
  selectCharacters('notes');
  storyBoard.reveal(id);
}
const sessionTools = createSessionTools({
  getState: () => state, getCampaigns: () => ({ profiles: campaignChoices, active: campaignId }),
  dispatch, campaign: api.campaign, openDialog, closeDialog, askText, showNote: openStoryNote,
});
const campaignTools = createCampaignTools({
  getState: () => state, getContext: currentContext, dispatch, search: api.campaignSearch,
  eventMapDoors: api.eventMapDoors, pickEventCells: detachedPanel ? null : pickEventCells,
  openDialog, closeDialog, askText,
  async navigate(entry) {
    if (entry.kind === 'scene') return sessionTools.openScene(state.scenes.find(scene => scene.id === entry.id));
    if (entry.kind === 'note') {
      const sent = !detachedPanel && detached.includes('characters') &&
        (await result(api.workspaceCommand({ panel: 'characters', command: 'note', id: entry.id })))?.sent;
      if (!sent) await openStoryNote(entry.id);
      return;
    }
    const action = entry.kind === 'map' ? 'map:select' : 'battle:select';
    if (!(await dispatch(action, { id: entry.parentId ?? entry.id }))?.ok) return;
    if (entry.kind === 'map') {
      if (expanded && expanded !== 'map') await expandPanel(expanded);
      viewport.focus({ preventScroll: true });
    } else if (entry.kind === 'actor') {
      const sent = !detachedPanel && detached.includes('combat') &&
        (await result(api.workspaceCommand({ panel: 'combat', command: 'actor', id: entry.id })))?.sent;
      if (!sent) await focusCombatant(entry.id);
    }
  }
});
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
ambience.fadeImage($('gallery-image'));
ambience.fadeImage($('presented-image'));
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
    if (charactersTab === 'gallery') renderGallery();
  }
}
$('show-sheets').onclick = () => selectCharacters('sheets');
$('show-gallery').onclick = () => selectCharacters('gallery');
$('show-notes').onclick = () => selectCharacters('notes');
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
function renderLibrary() {
  $('library-empty').hidden = !!state.library.length;
  $('library-list').innerHTML = state.library.map(entry => `
    <div class="library-entry">${avatar(entry)}<div class="library-name">
      <b>${escapeHTML(entry.name)}</b><small>${escapeHTML(combatRoles[entry.role])} · ${entry.maxHp} ХП</small>
    </div>
    <button type="button" data-library-battle="${entry.id}" data-pixel-icon="swords">В бой</button>
    <button type="button" data-library-map="${entry.id}" data-pixel-icon="map">На карту</button>
    <button type="button" class="card-menu" data-library-edit="${entry.id}" aria-label="Редактировать заготовку" data-pixel-icon="pen"></button>
    <button type="button" class="card-menu" data-library-remove="${entry.id}" aria-label="Удалить заготовку" data-pixel-icon="trash"></button>
    </div>`).join('');
}
$('open-library').onclick = () => { renderLibrary(); openDialog('library-dialog'); };
$('create-character-template').onclick = () => openCombatantEditor(null, true);
function askRemoveToken(id) {
  const actor = state.mapCombatants.find(entry => entry.id === id);
  if (!actor) return;
  removal = { id, context: currentContext() };
  $('remove-token-name').textContent = actor.name;
  openDialog('remove-token-dialog');
}
$('confirm-remove-token').onclick = () => {
  const { id, context } = removal;
  closeDialog($('remove-token-dialog'));
  dispatch('token:remove', { id }, context);
};
async function importLss(file, template = false, fromClipboard = false) {
  if (readingCharacter) return;
  const context = currentContext();
  readingCharacter = true;
  try {
    const response = await result(api.importLss(file, { ...context, template, fromClipboard }));
    if (!response?.ok || context.expectedCampaignId !== campaignId ||
        !template && context.expectedBattleId !== state.activeBattleId) return;
    if (template && $('library-dialog').open) closeDialog($('library-dialog'));
    else if (document.querySelector('dialog[open]')) return;
    openCombatantEditor(response.actor, template, response);
  } finally {
    readingCharacter = false;
  }
}
function dndCardLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || (url.hostname !== 'dnd.su' && !url.hostname.endsWith('.dnd.su'))) return null;
    const section = /^\/(bestiary|items)\/\d+[\w-]*\/?$/.exec(url.pathname)?.[1];
    if (section) return { url: url.href, kind: section === 'bestiary' ? 'creature' : 'item' };
  } catch { /* The current reference page might not have a URL yet. */ }
  return null;
}
function droppedDndLink(data, kind) {
  const html = data.getData('text/html');
  const href = html && new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]')?.getAttribute('href');
  const candidates = [data.getData('text/uri-list'), data.getData('text/plain'), href ?? ''].join('\n').split(/\r?\n/);
  return candidates.map(line => dndCardLink(line.trim())).find(card => card?.kind === kind)?.url;
}
async function readDndCard(link, kind) {
  const response = await result(api.readDndCard(link, kind));
  if (!response?.ok) return null;
  const document = new DOMParser().parseFromString(response.html, 'text/html');
  const heading = document.querySelector('meta[property="og:title"]')?.content ?? document.title;
  const name = heading.split(/\s+[/—]\s+/)[0].trim().slice(0, 120);
  if (!name) return toast('Не удалось прочитать название карточки dnd.su');
  const item = { name };
  if (kind === 'creature') {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const words = [];
    while (walker.nextNode()) {
      if (!walker.currentNode.parentElement?.closest('script,style')) words.push(walker.currentNode.data);
    }
    const text = words.join(' ').replace(/\s+/g, ' ').replaceAll('−', '-');
    const hp = /Хиты\s*:?\s*(\d+)/iu.exec(text);
    if (!hp) return toast('В карточке dnd.su не найдены ХП существа');
    const stats = text.slice(hp.index, hp.index + 1000);
    const initiative = /Инициатива\s*:?\s*([+-]?\s*\d+)/iu.exec(text.slice(Math.max(0, hp.index - 260), hp.index + 160));
    const dex = /\sЛов(?:кость)?\s+(\d+)/iu.exec(stats);
    item.maxHp = Number(hp[1]);
    item.initiativeBonus = initiative ? Number(initiative[1].replace(/\s/g, '')) : dex ? Math.floor((Number(dex[1]) - 10) / 2) : 0;
    item.role = 'enemy';
  }
  const cover = document.querySelector('meta[property="og:image"]')?.content;
  const illustration = cover?.includes('/gallery/') ? cover : document.querySelector('img.gallery-image')?.getAttribute('src');
  if (illustration) {
    try { item.image = (await api.readDndIcon(new URL(illustration, response.source).href))?.asset; }
    catch { /* The card remains usable without a portrait. */ }
  }
  return item;
}
async function importDndCreature(link) {
  const context = currentContext();
  const actor = await readDndCard(link, 'creature');
  if (actor && (await dispatch('combatant:add', actor, context))?.ok) toast(`${actor.name} добавлен из dnd.su`);
}
const currentDndCard = () => dndCardLink(reference.pages[reference.tab]?.url);
$('drag-dnd-card').addEventListener('dragstart', event => {
  const card = currentDndCard();
  if (!card) { event.preventDefault(); return; }
  event.dataTransfer.setData('text/uri-list', card.url);
  event.dataTransfer.setData('text/plain', card.url);
  event.dataTransfer.effectAllowed = 'copy';
});
$('drag-dnd-card').onclick = async () => {
  const card = currentDndCard();
  if (!card) return;
  if (card.kind === 'creature') return importDndCreature(card.url);
  // A detached reference window can still pass the link to the main window by dragging it.
  if (detachedPanel) return toast('Перетащи кнопку «На карту» на карту мастера');
  const context = currentContext();
  const item = await readDndCard(card.url, 'item');
  if (!item || context.expectedMapId !== state.activeMapId) return;
  await beginItemPlacement(item, context);
};
$('import-lss').onclick = () => importLss();
$('paste-lss').onclick = () => importLss(null, false, true);
$('library-import-lss').onclick = () => importLss(null, true);
$('library-paste-lss').onclick = () => importLss(null, true, true);
const combatContent = document.querySelector('.combat-content');
combatContent.addEventListener('dragover', event => {
  if (event.dataTransfer.types.some(type => ['Files', 'text/uri-list', 'text/plain', 'text/html'].includes(type))) event.preventDefault();
});
combatContent.addEventListener('drop', async event => {
  const link = droppedDndLink(event.dataTransfer, 'creature');
  const file = event.dataTransfer.files[0];
  if (!link && !file?.name.toLowerCase().endsWith('.json')) return;
  event.preventDefault();
  if (link) await importDndCreature(link);
  else importLss(file);
});
const libraryDialog = $('library-dialog');
libraryDialog.addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
libraryDialog.addEventListener('drop', event => {
  const file = event.dataTransfer.files[0];
  if (!file?.name.toLowerCase().endsWith('.json')) return;
  event.preventDefault();
  importLss(file, true);
});
document.addEventListener('paste', event => {
  if (!state || isPlayerMap || textField(event.target)) return;
  const template = libraryDialog.open;
  if (!template && (document.querySelector('dialog[open]') || !event.target.closest('.combat'))) return;
  const file = [...event.clipboardData.files].find(item => item.name.toLowerCase().endsWith('.json'));
  const content = event.clipboardData.getData('text/plain').trimStart();
  if (!file && !content.startsWith('{')) return;
  event.preventDefault();
  importLss(file, template, !file);
});
$('combat-list').addEventListener('dragstart', event => {
  const card = event.target.closest('.combat-card');
  if (!card) return;
  event.dataTransfer.setData(tokenDragType, JSON.stringify({ kind: 'actor', id: card.dataset.id, ...currentContext() }));
  event.dataTransfer.effectAllowed = 'copyMove';
});

function setTokenFrame(id) {
  const [key, name] = TokenStyle.frame(id);
  $('combatant-form').elements.tokenFrame.value = key;
  $('token-frame-label').textContent = name;
  for (const button of $('token-frame-options').children) button.setAttribute('aria-pressed', String(button.dataset.frame === key));
}
$('token-frame-options').innerHTML = TokenStyle.frames.map(([id, name]) =>
  `<button type="button" data-frame="${id}" title="${name}" aria-label="${name}">${frameMarkup(id)}</button>`).join('');
$('token-frame-options').onclick = event => {
  const choice = event.target.closest('button[data-frame]');
  if (choice) setTokenFrame(choice.dataset.frame);
};
function openCombatantEditor(combatant, template = false, imported = null) {
  const form = $('combatant-form');
  form.reset();
  form.elements.tokenSize.value = TokenStyle.size(combatant?.tokenSize);
  setTokenFrame(combatant?.tokenFrame);
  $('token-frame-picker').open = false;
  importedCharacter = imported;
  editingCombatant = template ? null : combatant?.id ?? null;
  editingTemplate = template ? combatant?.id ?? '' : null;
  editingContext = currentContext();
  portraitDraft.reset([combatant?.image]);
  form.elements.role.value = combatant?.role ?? 'enemy';
  form.elements.initiativeBonus.value = Math.max(-50, Math.min(50, Math.round(combatant?.initiativeBonus ?? 0)));
  form.elements.movementSound.value = SoundLibrary.moveSound(combatant?.movementSound);
  $('sound-preview-step').disabled = form.elements.movementSound.value === 'none';
  $('editor-title').textContent = template ? (combatant ? 'Редактировать заготовку' : 'Новая заготовка')
    : (combatant ? 'Редактировать участника' : 'Добавить участника');
  if (imported) $('editor-title').textContent = template ? 'Импорт в заготовки' : 'Импорт в трекер';
  $('import-portrait-hint').hidden = !imported;
  $('import-portrait-hint').textContent = imported
    ? `Проверь портрет. Можно оставить картинку из JSON, выбрать файл или вставить изображение из буфера.${imported.initiativeNeedsReview ? ' Проверь бонус инициативы из листа.' : ''}`
    : '';
  $('editor-submit').textContent = template || editingCombatant ? 'Сохранить' : 'Добавить в трекер';
  $('save-template-copy').hidden = !editingCombatant;
  const showHp = !!editingCombatant || !!imported && !template;
  $('current-hp-field').hidden = !showHp;
  form.elements.hp.disabled = !showHp;
  form.elements.hp.required = showHp;
  if (combatant) {
    form.elements.name.value = combatant.name;
    form.elements.maxHp.value = Math.max(1, Math.min(999999, Math.round(combatant.maxHp)));
    if (showHp) form.elements.hp.value = Math.max(0, Math.min(Number(form.elements.maxHp.value), Math.round(combatant.hp)));
  }
  openDialog('editor');
}
$('add-combatant').onclick = () => openCombatantEditor();
$('save-template-copy').onclick = () => {
  if ($('combatant-form').reportValidity()) saveCombatant(true);
};
$('combatant-form').onsubmit = async e => {
  e.preventDefault();
  await saveCombatant(false);
};
async function saveCombatant(copyTemplate) {
  if (portraitDraft.busy) return;
  const form = $('combatant-form'), f = new FormData(form);
  const payload = {
    name: f.get('name'), maxHp: Number(f.get('maxHp')),
    initiativeBonus: Number(form.elements.initiativeBonus.value),
    role: f.get('role'), image: portraitDraft.assets[0] ?? null, movementSound: f.get('movementSound'),
    tokenSize: Number(f.get('tokenSize')), tokenFrame: f.get('tokenFrame')
  };
  const template = editingTemplate !== null || copyTemplate;
  if (template && editingTemplate) payload.id = editingTemplate;
  if (!template && editingCombatant) Object.assign(payload, { id: editingCombatant, hp: Number(f.get('hp')) });
  if (!template && importedCharacter) payload.hp = Number(f.get('hp'));
  const r = await dispatch(template ? 'library:save' : editingCombatant ? 'combatant:edit' : 'combatant:add', payload, editingContext);
  if (r?.ok) {
    closeDialog($('editor'));
    if (template && importedCharacter) $('open-library').click();
  }
  if (r?.ok && copyTemplate) toast('Персонаж сохранён в заготовках');
}
$('combat-list').addEventListener('submit', async e => {
  if (!e.target.matches('.hp-form')) return; e.preventDefault();
  const input = e.target.querySelector('input'), expression = input.value.replace('−', '-');
  const id = e.target.dataset.id, context = currentContext();
  input.value = '';
  hpDrafts.delete(id);
  const r = await dispatch('combatant:hp', { id, expression }, context);
  if (!r?.ok && context.expectedBattleId === state.activeBattleId && context.expectedCampaignId === campaignId && !hpDrafts.has(id)) {
    hpDrafts.set(id, expression);
    renderCombat();
  }
});
$('combat-list').addEventListener('input', event => {
  if (event.target.form?.matches('.hp-form')) hpDrafts.set(event.target.form.dataset.id, event.target.value);
});
$('combat-search').oninput = renderCombat;
$('combat-role-filter').onchange = renderCombat;
async function focusCombatant(id) {
  if (!id) return;
  if (expanded && expanded !== 'combat') await expandPanel(expanded);
  const selector = `.combat-card[data-id="${CSS.escape(id)}"] .initiative-value`;
  if (!$('combat-list').querySelector(selector)) {
    $('combat-search').value = $('combat-role-filter').value = '';
    renderCombat();
  }
  $('combat-list').querySelector(selector)?.focus();
}
$('turn-actor').onclick = () => focusCombatant(state.turn);
$('current-turn').addEventListener('click', event => {
  const expression = event.target.closest('[data-quick-hp]')?.dataset.quickHp;
  if (expression && state.turn) dispatch('combatant:hp', { id: state.turn, expression });
});
$('next-turn').onclick = () => dispatch('combat:next');
$('reset-order').onclick = () => dispatch('combat:sort');
function renderInitiative() {
  for (const button of document.querySelectorAll('[data-roll-role]')) {
    button.disabled = !state.combatants.some(c => c.role === button.dataset.rollRole);
  }
  const hasProgress = state.round !== 1 || state.turn || state.manualOrder || state.combatants.some(c => c.initiative != null);
  $('reset-initiative').disabled = !hasProgress;
  if (!hasProgress) $('initiative-reset-confirm').hidden = true;
  $('initiative-results').innerHTML = state.combatants
    .filter(c => c.initiativeRoll)
    .sort((a, b) => b.initiative - a.initiative)
    .map(c => `<div><strong>${escapeHTML(c.name)}</strong><span>${escapeHTML(rollText(c))}</span></div>`).join('');
}
$('roll-initiative').onclick = () => {
  initiativeContext = currentContext();
  $('initiative-reset-confirm').hidden = true;
  renderInitiative();
  openDialog('initiative-dialog');
};
$('reset-initiative').onclick = () => {
  $('initiative-reset-confirm').hidden = false;
  $('cancel-initiative-reset').focus();
};
$('cancel-initiative-reset').onclick = () => {
  $('initiative-reset-confirm').hidden = true;
  $('reset-initiative').focus();
};
$('confirm-initiative-reset').onclick = async () => {
  if ((await dispatch('combat:reset-initiative', {}, initiativeContext))?.ok) {
    closeDialog($('initiative-dialog'));
    toast('Инициатива сброшена. Начинается первый раунд.');
  }
};
function openConditions(id) {
  const actor = state.combatants.find(c => c.id === id);
  if (!actor) return;
  conditionEdit = { id, context: currentContext() };
  $('condition-actor').textContent = actor.name;
  $('auto-unconscious').hidden = actor.hp !== 0;
  $('exhaustion-level').value = actor.exhaustion ?? 0;
  $('exhaustion-duration').value = actor.durations?.exhaustion ?? '';
  $('exhaustion-duration').disabled = !actor.exhaustion;
  const selected = new Set(actor.conditions ?? []);
  $('condition-list').innerHTML = conditionDefinitions.filter(effect => effect.id !== 'exhaustion').map(effect =>
    `<div class="condition-duration"><label class="checkbox-label"><input type="checkbox" name="condition" value="${effect.id}" ${selected.has(effect.id) ? 'checked' : ''}> ${escapeHTML(effect.name)}</label><input type="number" name="duration-${effect.id}" data-duration min="1" max="99" placeholder="—" aria-label="Раундов для состояния ${escapeHTML(effect.name)}" value="${Number(actor.durations?.[effect.id]) || ''}" ${selected.has(effect.id) ? '' : 'disabled'}></div>`
  ).join('');
  openDialog('condition-dialog');
}
$('condition-list').onchange = event => {
  if (event.target.name === 'condition') event.target.closest('.condition-duration').querySelector('[data-duration]').disabled = !event.target.checked;
};
$('exhaustion-level').onchange = event => { $('exhaustion-duration').disabled = event.target.value === '0'; };
$('condition-form').onsubmit = async event => {
  event.preventDefault();
  const data = new FormData(event.target);
  const conditions = data.getAll('condition'), exhaustion = Number($('exhaustion-level').value);
  const durations = Object.fromEntries(conditions.map(id => [id, Number(data.get('duration-' + id))]));
  if (exhaustion) durations.exhaustion = Number(data.get('exhaustion-duration'));
  const response = await dispatch('combatant:conditions', {
    id: conditionEdit.id, conditions, exhaustion, durations
  }, conditionEdit.context);
  if (response?.ok) closeDialog($('condition-dialog'));
};
let tokenMenu;
$('map-tokens').addEventListener('contextmenu', event => {
  const token = event.target.closest('[data-token]');
  if (isPlayerMap || !token) return;
  event.preventDefault();
  const entry = state.tokens.find(item => item.combatantId === token.dataset.token);
  if (!entry) return;
  pickToken(entry.combatantId);
  tokenMenu = { id: entry.combatantId, hidden: Boolean(entry.hidden), context: currentContext() };
  $('token-actions-title').textContent = mapActors().get(entry.combatantId)?.name ?? 'Токен';
  $('token-toggle-visibility').textContent = entry.hidden ? 'Показать игрокам' : 'Скрыть от игроков';
  openDialog('token-actions-dialog');
});
$('token-toggle-visibility').onclick = async () => {
  const { id, hidden, context } = tokenMenu;
  if ((await dispatch('token:visibility', { id, hidden: !hidden }, context))?.ok && $('token-actions-dialog').open) {
    closeDialog($('token-actions-dialog'));
  }
};
$('token-open-conditions').onclick = () => {
  closeDialog($('token-actions-dialog'));
  openConditions(tokenMenu.id);
};
$('undo-hp').onclick = () => dispatch('combatant:undo');
$('import-map').onclick = () => loadMap(api.importFile('image'));
$('paste-map').onclick = () => loadMap(api.pasteImage());
$('map-image').onload = () => { if (state) renderMap(); };
$('map-settings').onclick = () => {
  mapTools?.close();
  gridContext = currentContext();
  const form = $('grid-form');
  for (const key of ['grid', 'offsetX', 'offsetY', 'opacity', 'color']) form.elements[key].value = state.map[key];
  form.elements.diagonals.value = state.map.diagonals ?? 'equal';
  form.elements.visible.checked = state.map.visible; openDialog('grid-dialog');
};
function readGridSettings(form) {
  const { grid, offsetX, offsetY, opacity, color, visible, diagonals } = form.elements;
  return { grid: Number(grid.value), offsetX: Number(offsetX.value), offsetY: Number(offsetY.value),
    opacity: Number(opacity.value), color: color.value, visible: visible.checked, diagonals: diagonals.value };
}
$('grid-form').onsubmit = async e => {
  e.preventDefault();
  const response = await dispatch('map:settings', readGridSettings(e.target), gridContext);
  if (response?.ok) closeDialog($('grid-dialog'));
};
const viewport = $('map-viewport');
const mapTools = !detachedPanel ? createMapTools({
  viewport, getState: () => state, getLayout: () => boardLayout, pointAt: mapPointAt,
  dispatch, context: currentContext,
}) : null;
if (mapTools) {
  const activateMapTool = (tool, settings) => {
    if (cancelEventCells) cancelEventCells();
    cancelTokenDrag?.();
    setPlacement(null);
    mapScene.hideEditor();
    mapTools.select(tool, settings);
  };
  mapTools.bar.onclick = event => {
    const button = event.target.closest('[data-map-tool]');
    if (button && state) activateMapTool(button.dataset.mapTool);
  };
  const adjustGrid = $('adjust-grid-with-mouse');
  adjustGrid.hidden = false;
  adjustGrid.onclick = () => {
    const form = $('grid-form');
    if (!form.reportValidity()) return;
    const settings = readGridSettings(form);
    closeDialog($('grid-dialog'));
    activateMapTool('grid', settings);
  };
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.id = 'reveal-hidden-enemies';
  reveal.dataset.pixelIcon = 'eye';
  reveal.hidden = true;
  reveal.onclick = () => {
    const ids = hiddenEnemies();
    if (ids.length) dispatch('token:visibility', { ids, hidden: false });
  };
  mapTools.bar.querySelector('.map-measure-group').after(reveal);
  $('edit-terrain').addEventListener('click', () => mapTools.close(), { capture: true });
}
function hiddenEnemies() {
  const actors = mapActors();
  return state.tokens.filter(token => token.hidden && actors.get(token.combatantId)?.role === 'enemy').map(token => token.combatantId);
}
const mapScene = createMapTerrain({
  getState: () => state,
  getLayout: () => boardLayout,
  getPoint(event) {
    const point = mapPointAt(event.clientX, event.clientY);
    return { x: point.x / boardLayout.zoom, y: point.y / boardLayout.zoom };
  },
  dispatch, redraw: renderMap,
  expand: () => expandPanel('map'), isExpanded: () => expanded === 'map', readOnly: isPlayerMap,
  editItem: openMapItemEditor, editPortal: portal => portalTools?.edit(portal), assetURL,
});
const portalTools = isPlayerMap || detachedPanel ? null : createPortalTools({
  getState: () => state, context: currentContext, selectedToken: () => selectedToken,
  dispatch, openDialog, closeDialog, toast, preview: data => result(api.portalMapPreview(data)), assetURL,
  place(entry) {
    mapScene.hideEditor();
    setPlacement(entry);
    viewport.focus({ preventScroll: true });
  },
});

function renderItemIcon() {
  const preview = $('item-icon-preview');
  preview.replaceChildren();
  if (mapItemDraft.image) {
    const image = document.createElement('img');
    image.src = assetURL(mapItemDraft.image);
    image.alt = '';
    preview.append(image);
  } else preview.textContent = '◆';
  $('clear-item-icon').hidden = !mapItemDraft.image;
}
function openMapItemEditor(item) {
  mapItemDraft = { id: item?.id, image: item?.image ?? null, context: currentContext() };
  $('item-name').value = item?.name ?? '';
  $('submit-map-item').textContent = item ? 'Сохранить' : 'Разместить на карте';
  renderItemIcon();
  openDialog('map-item-dialog');
}
async function loadItemIcon(promise) {
  const draft = mapItemDraft;
  const chosen = await result(promise);
  if (chosen?.asset && mapItemDraft === draft && $('map-item-dialog').open) {
    draft.image = chosen.asset;
    renderItemIcon();
  }
}
$('choose-item-icon').onclick = () => loadItemIcon(api.importFile('image'));
$('map-item-dialog').addEventListener('dragover', event => {
  if (event.dataTransfer.types.includes('Files')) event.preventDefault();
});
$('map-item-dialog').addEventListener('drop', event => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  event.preventDefault();
  loadItemIcon(api.importDrop(file, 'image'));
});
$('clear-item-icon').onclick = () => { mapItemDraft.image = null; renderItemIcon(); };
async function beginItemPlacement(item, context) {
  if (expanded && expanded !== 'map') await expandPanel('map');
  mapScene.hideEditor();
  setPlacement({ kind: 'item', name: item.name, image: item.image, context });
  viewport.focus({ preventScroll: true });
}
$('map-item-form').onsubmit = async event => {
  event.preventDefault();
  const name = $('item-name').value.trim();
  if (!name) return;
  const { id, image, context } = mapItemDraft;
  closeDialog($('map-item-dialog'));
  if (id) await dispatch('terrain:edit-item', { id, name, image }, context);
  else {
    if (context.expectedMapId !== state.activeMapId) return toast('Карта переключилась. Создай предмет заново.');
    await beginItemPlacement({ name, image }, context);
  }
};

function pickToken(id) {
  selectedToken = id;
  for (const token of $('map-tokens').children) token.classList.toggle('selected-token', token.dataset.token === id);
}
function setPlacement(value) {
  if (value) mapTools?.close();
  placement = value;
  const hint = $('placement-hint');
  hint.hidden = !placement;
  hint.textContent = placement ? `${placement.name} · выбери клетку · Esc отменяет` : '';
  viewport.classList.toggle('placing-token', !!placement);
}
async function beginPlacement(kind, id, context = currentContext()) {
  if (detachedPanel) return result(api.placeToken({ kind, id, ...context }));
  if (context.expectedMapId !== state.activeMapId || context.expectedBattleId !== state.activeBattleId) return;
  const item = (kind === 'template' ? state.library : state.combatants).find(actor => actor.id === id);
  if (!item) return;
  if (expanded && expanded !== 'map') await expandPanel('map');
  mapScene.hideEditor();
  pickToken(null);
  setPlacement({ kind, id, context, name: item.name });
  viewport.focus({ preventScroll: true });
}
function placementCell(event) {
  if (!boardProjection) return null;
  const { map } = state;
  const point = mapPointAt(event.clientX, event.clientY), zoom = boardLayout.zoom;
  if (point.x < 0 || point.y < 0 || point.x >= boardLayout.width || point.y >= boardLayout.height) return null;
  const col = Math.max(0, Math.min(2000, Math.floor((point.x / zoom - map.offsetX) / map.grid)));
  const row = Math.max(0, Math.min(2000, Math.floor((point.y / zoom - map.offsetY) / map.grid)));
  return { col, row };
}
async function pickEventCells(initial, done) {
  mapTools?.close();
  setPlacement(null);
  mapScene.hideEditor();
  if (expanded && expanded !== 'map') await expandPanel(expanded);
  const bar = $('event-cell-picker'), counter = $('event-cell-count'), picked = [...initial];
  const marks = document.createElement('div');
  marks.className = 'event-cell-marks';
  marks.setAttribute('aria-hidden', 'true');
  $('map-world').append(marks);
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };
  const update = () => {
    counter.textContent = picked.length ? 'Выбрано клеток: ' + picked.length : 'Выбери до 12 клеток на карте';
    marks.replaceChildren(...picked.map(({ col, row }) => {
      const mark = document.createElement('i');
      mark.style.setProperty('--col', col);
      mark.style.setProperty('--row', row);
      return mark;
    }));
  };
  const finish = save => {
    controller.abort();
    marks.remove();
    bar.hidden = true;
    viewport.classList.remove('event-cell-picking');
    cancelEventCells = null;
    done(save ? picked : null);
  };
  function choose(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const cell = placementCell(event);
    if (!cell) return;
    const index = picked.findIndex(other => other.col === cell.col && other.row === cell.row);
    if (index >= 0) picked.splice(index, 1);
    else if (picked.length < 12) picked.push(cell);
    update();
  }
  bar.hidden = false;
  viewport.classList.add('event-cell-picking');
  cancelEventCells = () => finish(false);
  viewport.addEventListener('pointerdown', choose, options);
  viewport.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, options);
  $('event-cell-done').addEventListener('click', () => finish(true), options);
  $('event-cell-cancel').addEventListener('click', cancelEventCells, options);
  viewport.focus({ preventScroll: true });
  update();
}
async function putItem(item, cell, map, context) {
  const a = MapGeometry.cellCenter(map, cell.col, cell.row);
  return dispatch('terrain:add', { kind: 'item', name: item.name, image: item.image, a }, context);
}
let pinsKey = [];
function renderNotePins(zoom) {
  const key = [campaignId, state.notePins, state.notePins.length ? state.story.notes : null, zoom];
  if (key.every((value, index) => value === pinsKey[index])) return;
  pinsKey = key;
  const notes = new Map(state.story.notes.map(note => [note.id, note.title]));
  const layer = $('map-note-pins');
  const focused = document.activeElement?.dataset.notePin;
  layer.replaceChildren(...state.notePins.filter(pin => notes.has(pin.noteId)).map(pin => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.notePin = pin.id;
    button.dataset.pixelIcon = 'scroll';
    button.title = notes.get(pin.noteId) + ' · ПКМ — убрать метку';
    button.setAttribute('aria-label', notes.get(pin.noteId));
    button.style.left = pin.x * zoom + 'px';
    button.style.top = pin.y * zoom + 'px';
    button.onclick = () => openStoryNote(pin.noteId);
    button.oncontextmenu = event => {
      event.preventDefault();
      if (confirm('Убрать метку с карты?')) dispatch('map:unpin', { id: pin.id });
    };
    return button;
  }));
  if (focused) [...layer.children].find(button => button.dataset.notePin === focused)?.focus({ preventScroll: true });
}
$('pin-map-note').onclick = () => {
  if (!state.story.notes.length) return toast('Сначала создай заметку на сюжетной доске');
  $('map-note-choice').replaceChildren(...state.story.notes.map(note => new Option(note.title, note.id)));
  openDialog('map-note-dialog');
};
$('map-note-form').onsubmit = event => {
  event.preventDefault();
  const note = state.story.notes.find(entry => entry.id === $('map-note-choice').value);
  if (!note) return;
  closeDialog($('map-note-dialog'));
  mapScene.hideEditor();
  setPlacement({ kind: 'note', id: note.id, context: currentContext(), name: note.title });
  viewport.focus({ preventScroll: true });
};
$('undo-map').onclick = () => result(api.undoMap(currentContext()));
$('open-player-preview').onclick = () => result(api.detach('preview'));
async function placeAt(event, entry) {
  const cell = placementCell(event);
  if (!entry) return;
  if (!cell) return toast('Выбери клетку внутри карты');
  const payload = { id: entry.id, ...cell };
  const alreadyOnMap = state.tokens.some(token => token.combatantId === entry.id);
  const response = entry.kind === 'note' ? await dispatch('map:pin', { noteId: entry.id, ...MapGeometry.cellCenter(state.map, cell.col, cell.row) }, entry.context)
    : entry.kind === 'portal' ? await dispatch('terrain:add', { kind: 'portal', name: entry.name, targetMapId: entry.targetMapId,
      exit: entry.exit, a: MapGeometry.cellCenter(state.map, cell.col, cell.row) }, entry.context)
    : entry.kind === 'item' ? await putItem(entry, cell, state.map, entry.context)
    : entry.kind === 'template' ? await dispatch('library:deploy', { ...payload, place: true }, entry.context)
    : await dispatch(alreadyOnMap ? 'token:move' : 'token:add', payload, entry.context);
  if (response?.ok) {
    setPlacement(null);
    if (entry.kind === 'actor') pickToken(entry.id);
    viewport.focus({ preventScroll: true });
  }
}
function queueMapCamera() {
  if (detachedPanel || pendingMapFrame || restoreMapCamera || !state) return;
  const mapId = state.activeMapId;
  pendingMapFrame = requestAnimationFrame(() => {
    pendingMapFrame = 0;
    if (mapId !== state.activeMapId || !boardProjection || mapMode() !== 'follow' || !viewport.clientWidth || !viewport.clientHeight) return;
    // Share the center in image coordinates so each window can project it through its own rotation.
    const center = MapGeometry.inverse(boardProjection.matrix,
      viewport.scrollLeft + viewport.clientWidth / 2, viewport.scrollTop + viewport.clientHeight / 2);
    mirrorMap({ camera: { x: center.x / boardLayout.zoom, y: center.y / boardLayout.zoom } }, mapId);
  });
}
function centerMapCamera(camera) {
  if (!boardProjection) return;
  const { x, y } = MapGeometry.transform(boardProjection.matrix, camera.x * boardLayout.zoom, camera.y * boardLayout.zoom);
  viewport.scrollTo(x - viewport.clientWidth / 2, y - viewport.clientHeight / 2);
}
function paintPlayerMap() {
  if (!state) return;
  const zoom = mapDrawingZoom();
  layoutMap();
  if (mapMode() === 'follow' && mapCamera) centerMapCamera(mapCamera);
  if (!previewToken) return;
  const token = [...$('map-tokens').children].find(button => button.dataset.token === previewToken.id);
  if (token) positionToken(token, state.map, previewToken.col, previewToken.row, zoom);
}
function resizePreview() {
  if (!isPreview) return;
  const [width, height] = previewFrameInfo?.size ?? [innerWidth, innerHeight];
  const scale = Math.min(innerWidth / width, innerHeight / height);
  document.body.style.width = width + 'px';
  document.body.style.height = height + 'px';
  document.body.style.setProperty('--preview-height', height + 'px');
  document.body.style.transform = `translate(${(innerWidth - width * scale) / 2}px, ${(innerHeight - height * scale) / 2}px) scale(${scale})`;
  document.body.classList.toggle('player-fullscreen', !!previewFrameInfo?.fullscreen);
}
if (isPreview) addEventListener('resize', () => { resizePreview(); if (state) renderMap(); });
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
  const size = TokenStyle.size(token.dataset.size);
  const unit = map.grid * zoom, inset = Math.max(0, (1 - size) / 2);
  token.style.left = `${map.offsetX * zoom + (col + inset) * unit}px`;
  token.style.top = `${map.offsetY * zoom + (row + inset) * unit}px`;
  token.style.setProperty('--token-span', `${unit * size}px`);
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
    const { x, y } = MapGeometry.transform(boardProjection.matrix, original.x / oldZoom * zoom, original.y / oldZoom * zoom);
    viewport.scrollTo(x - anchorX, y - anchorY);
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
const rotatePlayerMap = delta => result(api.rotatePlayerMap(delta, currentContext()));
$('rotate-player-left').onclick = () => rotatePlayerMap(-90);
$('rotate-player-right').onclick = () => rotatePlayerMap(90);
viewport.addEventListener('wheel', e => {
  if (isPlayerMap) { e.preventDefault(); return; }
  if (mapTools?.wheel(e)) return;
  if (!e.ctrlKey) return;
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  changeZoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - rect.left, e.clientY - rect.top);
}, { passive: false });
viewport.addEventListener('pointerdown', e => {
  if (isPlayerMap || e.button !== 0 || !boardProjection) return;
  if (mapTools?.pointerDown(e)) return;
  if (e.target.closest('[data-door-id], [data-note-pin], button[data-portal-id]')) return;
  if (placement) {
    e.preventDefault();
    placeAt(e, placement);
    return;
  }
  if (mapScene.pointerDown(e, currentContext())) return;
  if (e.shiftKey && !detachedPanel) {
    const point = mapPointAt(e.clientX, e.clientY);
    if (point.x < 0 || point.y < 0 || point.x >= boardLayout.width || point.y >= boardLayout.height) return;
    e.preventDefault();
    const zoom = mapDrawingZoom();
    const ping = { x: point.x / zoom, y: point.y / zoom };
    showMapPing(ping);
    mirrorMap({ ping });
    return;
  }
  if (e.target.closest('[data-token]') || e.target === viewport) return;
  pickToken(null);
  viewport.focus({ preventScroll: true });
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
  $('player-rotation').value = state.map.playerRotation ?? '';
  openDialog('player-dialog');
};
$('toggle-player-health').onchange = e => dispatch('map:settings', { playerHealth: e.target.checked }, playerSettingsContext);
$('player-fit').onchange = e => dispatch('map:settings', { playerFit: e.target.value }, playerSettingsContext);
$('player-rotation').onchange = async e => {
  const value = e.target.value;
  if (!(await dispatch('map:settings', { playerRotation: value === '' ? null : Number(value) }, playerSettingsContext))?.ok) {
    e.target.value = state.map.playerRotation ?? '';
  }
};
$('toggle-player-blackout').onchange = e => {
  playerBlackout = e.target.checked;
  $('player-settings').setAttribute('aria-pressed', String(playerBlackout));
  mirrorMap({ blackout: playerBlackout });
};
viewport.addEventListener('dragover', e => {
  if (!isPlayerMap) e.preventDefault();
});
viewport.addEventListener('drop', async e => {
  e.preventDefault();
  if (isPlayerMap) return;
  if (e.dataTransfer.types.includes(tokenDragType)) {
    let dragged;
    try { dragged = JSON.parse(e.dataTransfer.getData(tokenDragType)); } catch { return; }
    if (dragged?.kind === 'actor' && typeof dragged.id === 'string' &&
        dragged.expectedBattleId === state.activeBattleId && dragged.expectedMapId === state.activeMapId) {
      placeAt(e, { ...dragged, context: currentContext() });
    }
  } else {
    const link = droppedDndLink(e.dataTransfer, 'item');
    if (link) {
      const context = currentContext(), map = state.map, cell = placementCell(e);
      if (!cell) return;
      const item = await readDndCard(link, 'item');
      if (item) await putItem(item, cell, map, context);
    } else if (e.dataTransfer.files[0]) loadMap(api.importDrop(e.dataTransfer.files[0], 'image'));
  }
});
function renderShortcutSettings(bindings = shortcutBindings) {
  $('shortcut-error').textContent = '';
  $('shortcut-bindings').replaceChildren(...DmShortcuts.definitions.map(([id, , name]) => {
    const label = document.createElement('label');
    label.textContent = name;
    const select = document.createElement('select');
    select.name = id;
    select.replaceChildren(...Array.from('ABCDEFGHIJKLMNOPQRSTUVWXYZ', letter => new Option('Ctrl + Alt + ' + letter, letter)));
    select.value = bindings[id];
    label.append(select);
    return label;
  }));
}
function openShortcutSettings() {
  if ($('screen-settings-dialog').open) closeDialog($('screen-settings-dialog'));
  renderShortcutSettings();
  openDialog('shortcuts-dialog');
}
function updateShortcuts(bindings) {
  shortcutBindings = bindings;
  const buttons = { dice: 'toggle-dice-menu', search: 'open-campaign-search', journal: 'open-journal', 'next-turn': 'next-turn',
    'new-combatant': 'add-combatant', 'round-events': 'open-round-events', 'reference-new': 'new-reference-tab',
    'reference-address': 'reference-query', music: 'play-pause', scenes: 'open-session-scenes' };
  for (const [id, , title] of DmShortcuts.definitions) {
    if (!buttons[id]) continue;
    const element = $(buttons[id]);
    element.title = `${title} · Ctrl + Alt + ${bindings[id]}`;
    element.setAttribute('aria-keyshortcuts', 'Control+Alt+' + bindings[id]);
  }
}
$('open-shortcuts').onclick = openShortcutSettings;
$('reset-shortcuts').onclick = () => renderShortcutSettings(DmShortcuts.defaults);
$('shortcuts-form').onsubmit = async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget));
  if (!DmShortcuts.validateShortcuts(values)) {
    const repeated = Object.values(values).filter((letter, index, all) => all.indexOf(letter) < index);
    $('shortcut-error').textContent = 'Эти буквы уже заняты: ' + [...new Set(repeated)].join(', ');
    return;
  }
  const response = await api.setShortcuts(values);
  if (response?.ok) closeDialog($('shortcuts-dialog'));
  else $('shortcut-error').textContent = response?.error ?? 'Не удалось сохранить сочетания.';
};
async function runReferenceCommand(command) {
  if (!detachedPanel && detached.includes('info') &&
      (await result(api.workspaceCommand({ panel: 'info', command })))?.sent) return;
  if (expanded && expanded !== 'info') await expandPanel(expanded);
  if (command === 'reference-address') {
    $('reference-query').focus();
    $('reference-query').select();
  } else await result(api.referenceAction(command === 'reference-new' ? 'new-tab' : 'close-tab'));
}
function runShortcut(command) {
  if (!state || isPlayerMap || document.querySelector('dialog[open]') || draggingToken) return;
  if (detachedPanel && command !== 'fullscreen' && !(detachedPanel === 'combat' && command === 'dice') &&
      !(detachedPanel === 'info' && command.startsWith('reference-'))) {
    return result(api.masterShortcut(command));
  }
  if (command.startsWith('reference-')) return runReferenceCommand(command);
  const controls = { dice: 'toggle-dice-menu', search: 'open-campaign-search', journal: 'open-journal', 'next-turn': 'next-turn',
    'new-combatant': 'add-combatant', 'round-events': 'open-round-events', music: 'play-pause', scenes: 'open-session-scenes' };
  if (controls[command]) return $(controls[command]).click();
  if (command === 'shortcut-help') return openShortcutSettings();
  if (command === 'fullscreen') return result(api.fullscreen());
  if (command === 'fog') return mapScene.toggleFog();
  if (command === 'blackout' && detached.includes('map')) {
    $('toggle-player-blackout').checked = !playerBlackout;
    $('toggle-player-blackout').dispatchEvent(new Event('change'));
  }
}
document.addEventListener('keydown', e => {
  if (soundTools?.shortcut(e)) return;
  const modal = document.querySelector('dialog[open]');
  const command = !isPlayerMap && DmShortcuts.matchShortcut(e, shortcutBindings);
  if (command && !modal) {
    e.preventDefault();
    if (!e.repeat) runShortcut(command);
    return;
  }
  if (isPlayerMap && !isPreview && !modal && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey &&
      ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
    e.preventDefault();
    if (!e.repeat && state) rotatePlayerMap(e.key === 'ArrowLeft' ? -90 : 90);
    return;
  }
  const onMap = !isPlayerMap && !modal && e.target.closest('#map-viewport');
  if (onMap && draggingToken && !e.repeat && e.code === 'KeyF' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    rulerShortcut?.(e.altKey);
    return;
  }
  if (!isPlayerMap && !modal && e.target.closest('.map') && !draggingToken &&
      (e.ctrlKey || e.metaKey) && !e.shiftKey && e.code === 'KeyZ') {
    e.preventDefault();
    result(api.undoMap(currentContext()));
    return;
  }
  if (onMap && !e.altKey && !e.ctrlKey && !e.metaKey && !e.repeat) {
    if (e.key === 'Backspace' && selectedToken && !draggingToken && !mapScene.isEditing()) {
      e.preventDefault();
      dispatch('token:remove', { id: selectedToken });
      return;
    }
    if (e.code === 'KeyF') { e.preventDefault(); mapScene.toggleFog(); return; }
  }
  if (e.key === 'Escape' && !modal) {
    if ($('dice-menu').matches(':popover-open')) return;
    if (cancelEventCells) { e.preventDefault(); cancelEventCells(); return; }
    if (cancelTokenDrag) { e.preventDefault(); cancelTokenDrag(); return; }
    if (mapTools?.close()) { e.preventDefault(); return; }
    if (placement) { e.preventDefault(); setPlacement(null); return; }
    if (mapScene.hideEditor()) { e.preventDefault(); return; }
    if (!isPlayerMap && state && !e.repeat) {
      e.preventDefault();
      if (detachedPanel) result(api.openMasterSettings());
      else $('screen-settings').click();
    }
    else if (isPlayerMap && document.body.classList.contains('player-fullscreen')) result(api.fullscreen());
  }
  if (e.key === 'F11') { e.preventDefault(); result(api.fullscreen()); }
  if (!isPlayerMap && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) && !document.querySelector('dialog[open]')) {
    if (e.target.closest('.combat')) return;
    e.preventDefault();
    if (charactersTab === 'notes' && document.activeElement?.closest('#story')) return storyBoard.pasteNewNote();
    if (charactersTab === 'gallery' && (!expanded || expanded === 'characters') && !document.activeElement?.closest('[data-panel="map"]')) {
      importGallery(api.pasteImage());
    } else loadMap(api.pasteImage());
  }
});
$('map-tokens').addEventListener('dblclick', e => {
  const token = e.target.closest('[data-token]');
  if (token && !isPlayerMap && !placement && !mapScene.isEditing()) askRemoveToken(token.dataset.token);
});
$('map-tokens').addEventListener('focusin', e => {
  if (!isPlayerMap && e.target.dataset.token) pickToken(e.target.dataset.token);
});
function drawMovementRuler(map, cells, blocked) {
  const layer = $('movement-ruler');
  const frame = $('map-frame').getBoundingClientRect(), view = viewport.getBoundingClientRect();
  const [a, b, c, d, x, y] = boardProjection.matrix;
  const points = cells.map(cell => {
    const center = MapGeometry.cellCenter(map, cell.col, cell.row);
    return { x: (a * center.x + c * center.y) * boardLayout.zoom + x + frame.left - view.left,
      y: (b * center.x + d * center.y) * boardLayout.zoom + y + frame.top - view.top };
  });
  layer.hidden = false;
  layer.style.left = viewport.scrollLeft + 'px';
  layer.style.top = viewport.scrollTop + 'px';
  layer.style.width = viewport.clientWidth + 'px';
  layer.style.height = viewport.clientHeight + 'px';
  layer.dataset.blocked = String(blocked);
  layer.querySelector('polyline').setAttribute('points', points.map(point => `${point.x},${point.y}`).join(' '));
  const label = layer.querySelector('output');
  label.textContent = MapGeometry.routeDistance(cells, map.diagonals === 'alternating') + ' фут.' + (blocked ? ' · преграда' : '');
  const end = points.at(-1);
  label.style.left = Math.max(0, Math.min(end.x + 10, viewport.clientWidth - label.offsetWidth - 2)) + 'px';
  label.style.top = Math.max(0, Math.min(end.y - 32, viewport.clientHeight - label.offsetHeight - 2)) + 'px';
}
$('map-tokens').addEventListener('pointerdown', e => {
  const token = e.target.closest('[data-token]'); if (!token || isPlayerMap || placement || mapTools?.active() || mapScene.isEditing() || e.shiftKey || e.button !== 0 || !boardProjection) return;
  const id = token.dataset.token, m = { ...state.map }, z = mapDrawingZoom();
  const original = state.tokens.find(t => t.combatantId === id);
  if (!original) return;
  token.focus({ preventScroll: true });
  pickToken(id);
  e.preventDefault(); draggingToken = true; token.classList.add('dragging'); token.setPointerCapture(e.pointerId);
  const context = currentContext();
  const revision = state.revision;
  const previewsFog = state.fog.enabled && state.visionOrigins.includes(id);
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const waypoints = [];
  const actor = mapActors().get(id), size = TokenStyle.size(actor?.tokenSize);
  const movementSound = SoundLibrary.moveSound(actor?.movementSound);
  const grab = mapPointAt(e.clientX, e.clientY);
  const grabCol = Math.floor((grab.x / z - m.offsetX) / m.grid) - original.col;
  const grabRow = Math.floor((grab.y / z - m.offsetY) / m.grid) - original.row;
  let lastStep = -Infinity;
  let position = original, cursor = original, moved = false, blocked = false, previewFrame = 0;
  const mirrors = () => detached.some(panel => panel === 'map' || panel === 'preview');
  const sameCell = (a, b) => a.col === b.col && a.row === b.row;
  const refresh = () => {
    blocked = MapGeometry.routeBlocked(m, MapGeometry.blockingWalls(state.terrain), [original, ...waypoints, cursor], size);
    if (!blocked && !sameCell(position, cursor)) {
      moved = true;
      position = cursor;
    }
    drawMovementRuler(m, [original, ...waypoints, position], blocked);
    positionToken(token, m, position.col, position.row, z);
    if ((previewsFog || mirrors()) && !previewFrame) {
      previewFrame = requestAnimationFrame(() => {
        previewFrame = 0;
        const preview = { id, ...position, waypoints };
        if (previewsFog) mapScene.previewFog(state, boardLayout, preview);
        if (mirrors() && !original.hidden) mirrorMap({ token: preview }, context.expectedMapId);
      });
    }
  };
  const move = event => {
    const point = mapPointAt(event.clientX, event.clientY);
    const target = { col: Math.max(0, Math.min(2000, Math.floor((point.x / z - m.offsetX) / m.grid) - grabCol)),
      row: Math.max(0, Math.min(2000, Math.floor((point.y / z - m.offsetY) / m.grid) - grabRow)) };
    if (sameCell(target, cursor)) return;
    cursor = target;
    const previous = position;
    refresh();
    if (event.ctrlKey && !sameCell(previous, position) && event.timeStamp - lastStep >= 140 && movementSound !== 'none') {
      lastStep = event.timeStamp;
      retro?.play(movementSound, 'movement');
    }
  };
  rulerShortcut = undo => {
    if (undo && waypoints.length) {
      waypoints.pop();
      position = waypoints.at(-1) ?? original;
    } else if (!undo && waypoints.length < 32 && !sameCell(position, waypoints.at(-1) ?? original)) {
      waypoints.push({ col: position.col, row: position.row });
    }
    refresh();
  };
  const finish = async commit => {
    listeners.abort();
    draggingToken = false; token.classList.remove('dragging');
    cancelTokenDrag = null;
    rulerShortcut = null;
    $('movement-ruler').hidden = true;
    cancelAnimationFrame(previewFrame);
    if (commit && (waypoints.length || !sameCell(position, original))) {
      if (!(await dispatch('token:move', { id, col: position.col, row: position.row, waypoints }, context))?.ok) renderMap();
    }
    else if (moved || revision !== state.revision) renderMap();
    if (commit && blocked) toast('Проход перекрыт');
    if (mirrors()) mirrorMap({ token: null }, context.expectedMapId);
  };
  const cancel = () => finish(false);
  cancelTokenDrag = cancel;
  token.addEventListener('pointermove', move, options);
  token.addEventListener('pointerup', () => finish(true), options);
  token.addEventListener('pointercancel', cancel, options);
  token.addEventListener('lostpointercapture', cancel, options);
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
$('music-seek').oninput = event => {
  seekingTrack = true;
  $('music-time').textContent = trackClock(Number(event.target.value));
};
$('music-seek').onchange = event => {
  const request = { campaignId, trackId: state.music.current, time: Number(event.target.value) };
  seekingTrack = false;
  if (detachedPanel) result(api.seekMusic(request));
  else seekTrack(request);
};
for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'emptied', 'seeked']) {
  if (!detachedPanel) $('audio').addEventListener(event, reportMusicPosition);
}
$('volume').oninput = e => {
  if (detachedPanel) return;
  cancelMusicFade?.();
  $('audio').volume = Number(e.target.value) / 100;
};
$('volume').onchange = e => dispatch('music:settings', { volume: Number(e.target.value) / 100 });
$('audio').onended = () => { if (!state.music.loop) dispatch('music:settings', { playing: false }); };
$('audio').onerror = () => { if (state?.music.playing) { toast('Аудиофайл недоступен или имеет неподдерживаемый формат'); dispatch('music:settings', { playing: false }); } };
$('help').onclick = () => openDialog('help-dialog');
$('quit-adventuricon').onclick = () => result(api.quit());
$('screen-fullscreen').onclick = () => result(api.fullscreen());
function renderMainFullscreen(active) {
  if (detachedPanel) return;
  const button = $('screen-fullscreen');
  button.hidden = false;
  button.setAttribute('aria-pressed', String(active));
  const label = active ? 'Выйти из полного экрана' : 'Перейти в полноэкранный режим';
  button.title = `${label} · F11`;
  button.setAttribute('aria-label', label);
}
document.querySelectorAll('dialog').forEach(dialog => {
  let startedOnBackdrop = false;
  const onBackdrop = event => {
    if (event.target !== dialog) return false;
    const bounds = dialog.getBoundingClientRect();
    return event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom;
  };
  dialog.addEventListener('pointerdown', event => { startedOnBackdrop = event.button === 0 && onBackdrop(event); });
  dialog.addEventListener('pointercancel', () => { startedOnBackdrop = false; });
  dialog.addEventListener('click', event => {
    if (startedOnBackdrop && onBackdrop(event)) closeDialog(dialog);
    startedOnBackdrop = false;
  });
  dialog.addEventListener('close', () => { startedOnBackdrop = false; syncRemoteBounds(); });
});
function updateUI(status) {
  currentUpdate = status;
  const button = $('updates');
  button.dataset.pixelIcon = status.phase === 'available' ? 'download' : status.phase === 'releases' ? 'external' : 'repeat';
  button.textContent = status.phase === 'available' ? `Версия ${status.version}`
    : status.phase === 'downloaded' ? 'Установить обновление'
      : ['checking', 'downloading', 'releases'].includes(status.phase) ? status.text.replace(/\s+↗$/, '') : 'Обновления';
}
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
  else if (status.scope === 'appearance-theme') renderTheme(status.theme);
  else if (status.scope === 'main-fullscreen') renderMainFullscreen(status.active);
  else if (status.scope === 'player-frame' && isPreview) {
    previewFrameInfo = status.frame;
    resizePreview();
    if (state) renderMap();
  }
  else if (status.scope === 'music') updateMusicStatus(status);
  else if (status.scope === 'shortcuts') updateShortcuts(status.bindings);
  else if (status.scope === 'sound-preferences') soundTools?.apply(status.preferences);
  else if (status.scope === 'retro-sound') soundTools?.status(status);
  else if (status.scope === 'sound-pad-state') soundTools?.setActive(status.ids);
  else if (status.scope === 'music-position') { musicPosition = status; renderMusicPosition(); }
  else if (status.scope === 'music-seek' && !detachedPanel) seekTrack(status);
  else if (status.scope === 'shortcut') runShortcut(status.command);
  else if (status.scope === 'open-settings' && !document.querySelector('dialog[open]')) $('screen-settings').click();
  else if (status.scope === 'workspace-command') {
    if (status.command === 'note') openStoryNote(status.id);
    else if (status.command === 'actor') focusCombatant(status.id);
    else if (!document.querySelector('dialog[open]')) runReferenceCommand(status.command);
  }
  else if (status.scope === 'round-events') {
    if (!isPlayerMap) {
      campaignTools.remind(status.events);
      toast(status.events.map(entry => `Раунд ${entry.round}. ${entry.title}`).join('\n'));
    }
  }
  else if (status.scope === 'map-focus') focusToken(status.id);
  else if (status.scope === 'map-place' && !detachedPanel) beginPlacement(status.kind, status.id, status);
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
      if (previewToken && !state.fog.enabled) paintPlayerMap();
      else if (boardLayout) {
        mapScene.previewFog(state, boardLayout, previewToken);
        renderMapTokens(boardLayout.zoom);
        paintPlayerMap();
      }
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
  const mode = workspaceMode(), { left, middle, top } = workspaceSizes();
  const initial = { left, middle, top };
  const centerPanel = mode === 'preparation' ? 'characters' : 'map';
  const topRight = mode === 'preparation' ? 'map' : 'characters';
  let next = { ...initial }, lastX = e.clientX, lastY = e.clientY;
  work.classList.add('dragging'); target.setPointerCapture(e.pointerId);
  const move = event => {
    lastX = event.clientX; lastY = event.clientY;
    const x = (event.clientX - bounds.left) / bounds.width * 100, y = (event.clientY - bounds.top) / bounds.height * 100;
    if (kind === 'left' || (kind === 'corner' && ['combat', 'music'].includes(panel))) next.left = Math.max(18, Math.min(45, x));
    if (kind === 'middle' || (kind === 'corner' && ['characters', 'map', 'info'].includes(panel))) {
      const width = panel === centerPanel || kind === 'middle' ? x - next.left : initial.middle + (event.clientX - e.clientX) / bounds.width * 100;
      next.middle = Math.max(18, Math.min(82 - next.left, width));
    }
    if (kind === 'top' || (kind === 'corner' && ['combat', topRight].includes(panel))) next.top = Math.max(25, Math.min(75, y));
    work.style.setProperty('--left', next.left + '%'); work.style.setProperty('--middle', next.middle + '%'); work.style.setProperty('--top', next.top + '%'); syncRemoteBounds();
  };
  const finish = () => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', cancel);
    work.classList.remove('dragging');
    if (kind === 'corner' && lastX > bounds.right - 45 && lastY > bounds.bottom - 45) { renderLayout(); expandPanel(panel); }
    else dispatch('layout:settings', { ...next, mode });
  };
  const cancel = () => { next = initial; finish(); };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', cancel);
}
document.querySelectorAll('[data-split]').forEach(el => el.addEventListener('pointerdown', e => beginResize(e, el.dataset.split)));
document.querySelectorAll('.resize-grip').forEach(el => el.addEventListener('pointerdown', e => beginResize(e, 'corner', el.closest('[data-panel]').dataset.panel)));
new ResizeObserver(syncRemoteBounds).observe($('workspace'));
window.addEventListener('resize', syncRemoteBounds);
let windowSnapshot;
function readWindowState(value) {
  const previous = windowSnapshot;
  const changingCampaign = !!campaignId && campaignId !== value.campaignId;
  const switched = changingCampaign || state?.activeMapId !== value.state.activeMapId;
  const rotated = !switched && !isPlayerMap && (state?.map.rotation ?? 0) !== (value.state.map.rotation ?? 0);
  if (switched && $('player-dialog').open) closeDialog($('player-dialog'));
  if (switched) {
    mapTools?.close();
    for (const id of ['grid-dialog', 'map-portal-editor', 'map-portal-travel', 'token-actions-dialog']) if ($(id).open) closeDialog($(id));
  }
  if (switched || state?.activeBattleId !== value.state.activeBattleId) setPlacement(null);
  if (switched) selectedToken = null;
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
  if (changingCampaign && !isPlayerMap) {
    for (const dialog of document.querySelectorAll('dialog[open]:not(#campaign-dialog)')) closeDialog(dialog);
    selectedImage = previewImage = null;
    currentFolder = 'Общее';
    $('audio').pause();
    cancelMusicFade?.();
    delete $('audio').dataset.source;
    combatBattle = null;
  }
  state = value.state;
  if ($('player-dialog').open) $('player-rotation').value = state.map.playerRotation ?? '';
  campaignId = value.campaignId;
  campaignChoices = value.campaigns;
  canUndoMap = value.canUndoMap;
  playerBlackout = value.playerBlackout;
  if (!previous || previous.playerBlackout !== playerBlackout) {
    $('player-blackout').hidden = !playerBlackout;
    $('player-settings').setAttribute('aria-pressed', String(playerBlackout));
  }
  if (isPreview && (!previous || previous.playerFrame !== value.playerFrame)) {
    previewFrameInfo = value.playerFrame;
    resizePreview();
  }
  detached = value.detached;
  presentation = value.presentation;
  recentImages = value.recentImages;
  windowSnapshot = value;
}
const pendingState = [];
function applyWindowPatch(patch) {
  const campaignChanged = Object.hasOwn(patch, 'campaignId') && campaignId !== patch.campaignId;
  const before = state, next = { ...state, ...patch.state };
  if (patch.state.music && !campaignChanged) next.music = { ...before.music, ...patch.state.music };
  const updated = (...keys) => campaignChanged || keys.some(key => Object.hasOwn(patch.state, key));
  const metadata = (...keys) => campaignChanged || keys.some(key => Object.hasOwn(patch, key));
  readWindowState({ ...windowSnapshot, ...patch, state: next });
  if (cancelEventCells && (campaignChanged || before.activeMapId !== next.activeMapId || before.activeBattleId !== next.activeBattleId)) cancelEventCells();
  const layoutChanged = updated('layout') || metadata('detached');
  if (!detachedPanel && metadata('detached') && detached.includes('music')) reportMusicPosition();
  const mapChanged = updated('activeMapId', 'map', 'tokens', 'terrain', 'drawings', 'fog', 'visionOrigins', 'mapCombatants', 'turn', 'notePins') ||
    metadata('detached', 'canUndoMap', 'playerFrame') || (!isPlayerMap && next.story.notes !== before.story.notes && next.notePins.length);
  if (isPlayerMap) {
    if (mapChanged) renderMap();
    if (metadata('presentation')) renderPresentation();
    return;
  }
  if (layoutChanged) renderLayout();
  campaignTools.render(campaignChanged ? null : before);
  const slotsChanged = updated('battleChoices', 'mapChoices', 'activeBattleId', 'activeMapId');
  if (slotsChanged) renderSlots();
  const placementChanged = next.tokens !== before.tokens &&
    (next.tokens.length !== before.tokens.length || next.tokens.some((token, index) => token.combatantId !== before.tokens[index].combatantId));
  if (updated('combatants', 'activeBattleId', 'order', 'manualOrder', 'round', 'turn', 'acted', 'history') || placementChanged) renderCombat();
  if (mapChanged) renderMap();
  if (updated('music')) renderMusic();
  if (metadata('presentation')) renderPresentation();
  if (updated('bookmarks') && $('bookmarks-dialog').open) renderBookmarks();
  if (updated('library') && $('library-dialog').open) renderLibrary();
  if ((updated('gallery') || metadata('recentImages')) && charactersTab === 'gallery') renderGallery();
  if (updated('story') && charactersTab === 'notes') storyBoard.render();
  if (!detachedPanel && (before.layout.mode !== next.layout.mode ||
      updated('scenes') || metadata('campaigns', 'detached'))) sessionTools.render();
  if (layoutChanged || slotsChanged) requestAnimationFrame(syncRemoteBounds);
}
let initialized = false;
api.onState(value => initialized ? applyWindowPatch(value) : pendingState.push(value));
(async () => {
  const initial = await api.init(); readWindowState(initial); updateUI(initial.updateStatus); updateMusicStatus(initial.musicStatus);
  if (!detachedPanel) populateThemePicker();
  renderTheme(initial.theme);
  renderMainFullscreen(initial.mainFullscreen);
  if (initial.mac) {
    document.querySelectorAll('[data-paste-shortcut]').forEach(label => { label.textContent = '⌘V'; });
  }
  combatRoles = initial.combatRoles;
  conditionDefinitions = initial.conditionDefinitions;
  reference = initial.reference;
  updateShortcuts(initial.shortcuts);
  soundTools?.apply(initial.soundPreferences);
  soundTools?.setActive(initial.activePads);
  musicPosition = initial.musicPosition;
  $('combatant-role').replaceChildren(...Object.entries(combatRoles).map(([id, label]) => new Option(label, id)));
  $('combat-role-filter').append(...Object.entries(combatRoles).map(([id, label]) => new Option(label, id)));
  const referenceIcons = { classes: 'people', races: 'people', spells: 'spark', monsters: 'swords', armor: 'shield',
    weapons: 'swords', gear: 'bag', items: 'spark', conditions: 'heart' };
  $('reference-links').innerHTML = initial.referenceLinks.map(link =>
    `<button type="button" data-pixel-icon="${referenceIcons[link.id] ?? 'book'}" data-reference-link="${link.id}" title="${escapeHTML(link.name)}">${escapeHTML(link.name)}</button>`
  ).join('');
  playerBlackout = initial.playerBlackout;
  $('version').textContent = `v${initial.version}`;
  if (detachedPanel) {
    document.body.classList.add('detached');
    document.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== detachedPanel; });
    const dock = document.querySelector(`[data-detach="${detachedPanel}"]`);
    dock.dataset.pixelIcon = 'dock';
    dock.title = 'Вернуть в ширму';
    dock.setAttribute('aria-label', dock.title);
    const title = document.querySelector(`[data-panel="${detachedPanel}"] h1`)?.textContent ?? 'Листы персонажей';
    document.title = title + ' · Адвентурикон';
    if (isPlayerMap) {
      document.body.classList.add('player-map');
      if (isPreview) document.body.classList.add('preview-screen');
      document.querySelector('.map h1').textContent = 'Карта игроков';
      document.title = isPreview ? 'Предпросмотр экрана игроков' : 'Карта игроков · Адвентурикон';
      viewport.inert = true;
      $('rotate-player-left').hidden = $('rotate-player-right').hidden = isPreview;
      $('player-blackout').hidden = !playerBlackout;
      resizePreview();
    }
  }
  renderAll();
  if (!isPlayerMap) campaignTools.render();
  initialized = true;
  for (const patch of pendingState.splice(0)) applyWindowPatch(patch);
  if (!isPlayerMap) renderReference();
  queueMapCamera();
  if (!detachedPanel) ambience.start({ openDialog, closeDialog, showAtStart: initial.welcomeAtStart });
  const now = new Date(), month = now.getMonth(), day = now.getDate();
  $('holiday-lights').hidden = !!detachedPanel || !(month === 11 || month === 10 && day >= 20 || month === 0 && day <= 14);
})();
