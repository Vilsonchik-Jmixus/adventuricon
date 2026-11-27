const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, dialog, clipboard, session, shell, screen, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { beginMusicImport, mediaTools, youtubeVideoId } = require('./music-import.cjs');
const { activeView, reducer, canMoveToken } = require('./model.cjs');
const { readCharacter } = require('./lss-import.cjs');
const { publicDndUrl, readPublicResponse } = require('./dnd-import.cjs');
const { ROLES, CONDITIONS, playerMapActors, effectsFor } = require('./combat-rules.cjs');
const { DND_HOME, WEB_HOME, GEMINI, REFERENCE_LINKS, safeUrl, searchUrl } = require('./reference.cjs');
const { autoUpdater } = require('electron-updater');
const { ScreenThemes, themeIcon } = require('../ui/themes.js');
const { createCampaignStore, writeJSON, encodeCampaign, assetPattern } = require('./campaigns.cjs');
const { rememberMapAction, rememberTravel, undoMapAction } = require('./map-history.cjs');
const { defaults: shortcutDefaults, validateShortcuts, restoreShortcuts, matchShortcut } = require('../ui/shortcuts.js');
const { searchCampaign } = require('./campaign-search.cjs');
const { pads, ambientIds, preferenceDefaults, padShortcut, moveSound } = require('../ui/sound-library.js');
const { audioResponse } = require('./audio-response.cjs');
const TEST = process.env.DM_SCREEN_TEST === '1';
const mac = process.platform === 'darwin';
const appImage = process.platform === 'linux' && !!process.env.APPIMAGE;
const canAutoUpdate = process.platform === 'win32' || appImage;
const releasesUrl = 'https://github.com/Vilsonchik-Jmixus/adventuricon/releases/latest';
app.setName('Адвентурикон');
if (appImage) app.commandLine.appendSwitch('disable-setuid-sandbox');
app.setPath('userData', process.env.DM_SCREEN_DATA || path.join(app.getPath('appData'), 'interactive-dm-screen'));
protocol.registerSchemesAsPrivileged([{ scheme: 'dm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const PANELS = ['combat', 'music', 'map', 'info', 'characters'];
const REMOTE = { info: DND_HOME, web: WEB_HOME, characters: 'https://longstoryshort.app/characters/list/' };
const remoteZoomFactors = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const referenceTabs = new Map([['info', { kind: 'info' }], ['web', { kind: 'web' }]]);
const remoteKind = id => id === 'characters' ? id : referenceTabs.get(id)?.kind;
const partitionFor = kind => kind === 'web' ? 'dm-web' : `persist:dm-${kind}`;
const remotePanelFor = id => id === 'characters' ? id : 'info';
let referenceTab = 'info';
let zoomStore;
let siteZoom = new Map();
let shortcutStore;
let shortcuts = shortcutDefaults;
let soundStore, soundPreferences = preferenceDefaults;
let activePads = [];
let musicPosition = null;
const padIds = new Set(pads.map(([id]) => id));
const soundToMaster = payload => mainWindow?.webContents.send('status', { scope: 'retro-sound', ...payload });
function normalizeSoundPreferences(value) {
  const categories = Array.isArray(value?.categories) ? value.categories.slice(0, 32)
    .filter(name => typeof name === 'string').map(name => name.trim().slice(0, 40)).filter(Boolean) : preferenceDefaults.categories;
  const unique = categories.filter((name, index) => categories.findIndex(item => item.toLowerCase() === name.toLowerCase()) === index);
  const assignments = value?.assignment && typeof value.assignment === 'object' ? value.assignment : preferenceDefaults.assignment;
  return {
    ...Object.fromEntries(Object.entries(preferenceDefaults).filter(([, fallback]) => typeof fallback === 'boolean')
      .map(([key, fallback]) => [key, typeof value?.[key] === 'boolean' ? value[key] : fallback])),
    volume: typeof value?.volume === 'number' && Number.isFinite(value.volume) ? Math.min(1, Math.max(0, value.volume)) : preferenceDefaults.volume,
    categories: unique,
    assignment: Object.fromEntries(pads.map(([id]) => [id, unique.includes(assignments[id]) ? assignments[id] : '']))
  };
}
const windows = new Map(), remotes = new Map(), windowSnapshots = new WeakMap();
const publicActors = new WeakMap();
let mainWindow, state, store, assets, quitting = false, downloadProcess = null;
let campaigns, campaignBusy = false;
const mapHistory = new Map();
let updateStatus = app.isPackaged && !canAutoUpdate
  ? { scope: 'update', phase: 'releases', text: 'Версии на GitHub ↗' }
  : { scope: 'update', phase: 'idle', text: 'Обновления' };
let musicStatus = { scope: 'music', phase: 'idle', text: '' };
const mapCameras = new Map();
let playerBlackout = false;
let presentation = null;
let recentImages = [];
let currentTheme = 'tavern';
let themeStore;
const themeImages = new Map();

function getThemeImage(id) {
  if (!themeImages.has(id)) themeImages.set(id, nativeImage.createFromPath(path.join(__dirname, '..', 'ui', themeIcon(id))));
  return themeImages.get(id);
}

function applyWindowTheme(window) {
  window.setBackgroundColor(ScreenThemes[currentTheme].background);
  if (!mac) window.setIcon(getThemeImage(currentTheme));
  if (process.platform === 'win32' && window === mainWindow) {
    const marker = currentTheme === 'tavern' ? null : getThemeImage(currentTheme).resize({ width: 16 });
    window.setOverlayIcon(marker, `Тема «${ScreenThemes[currentTheme].name}»`);
  }
}
function localSender(event) {
  const url = event.senderFrame?.url || '';
  if (!url.startsWith('dm://app/') || !BrowserWindow.fromWebContents(event.sender)) throw new Error('Недопустимый источник');
}
function sendAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL().startsWith('dm://app/')) w.webContents.send(channel, payload);
}
const playerSurface = owner => ['map', 'preview'].some(id => windows.get(id)?.webContents === owner);
function playerFrame() {
  const player = windows.get('map');
  return player && !player.isDestroyed() ? { size: player.getContentSize(), fullscreen: player.isFullScreen() } : null;
}
function syncPlayerFrame() {
  windows.get('preview')?.webContents.send('status', { scope: 'player-frame', frame: playerFrame() });
}
function resolveImage(ref) {
  if (!ref) return null;
  const item = ref.source === 'gallery'
    ? state.gallery.find(entry => entry.id === ref.id)
    : state.battles.flatMap(battle => battle.combatants).find(entry => entry.id === ref.id);
  return item?.image ? { ...ref, image: item.image, title: item.title ?? item.name } : null;
}
function windowState(owner, view = activeView(state)) {
  const mapCamera = mapCameras.get(view.activeMapId) ?? null;
  if (playerSurface(owner)) {
    const shareHealth = view.map.playerHealth !== false;
    const { tokens, hidden } = playerTokens(view.tokens);
    let actors = publicActors.get(view.mapCombatants);
    if (!actors) { actors = new WeakMap(); publicActors.set(view.mapCombatants, actors); }
    if (!actors.has(hidden)) {
      const visible = view.mapCombatants.filter(actor => !hidden.has(actor.id));
      actors.set(hidden, [playerMapActors(visible, false), playerMapActors(visible, true)]);
    }
    return {
      state: { activeMapId: view.activeMapId, map: view.map, tokens,
        mapCombatants: actors.get(hidden)[Number(shareHealth)],
        visionOrigins: view.visionOrigins,
        terrain: playerTerrain(view.terrain), drawings: view.drawings, fog: view.fog, turn: hidden.has(view.turn) ? null : view.turn },
      detached: ['map'], presentation, recentImages: [], mapCamera, campaignId: campaigns.index.active, playerBlackout, playerFrame: playerFrame()
    };
  }
  return {
    state: view, detached: [...windows.keys()], presentation, playerBlackout, campaignId: campaigns.index.active,
    campaigns: campaigns.index.profiles, canUndoMap: !!mapHistory.get(state.activeMapId)?.length,
    recentImages: recentImages.map(resolveImage).filter(Boolean), mapCamera
  };
}
let lastTokenProjection = { hidden: new Set(), tokens: [] };
function playerTokens(tokens) {
  if (lastTokenProjection.source === tokens) return lastTokenProjection;
  const hidden = new Set(tokens.filter(token => token.hidden).map(token => token.combatantId));
  const visible = hidden.size ? tokens.filter(token => !token.hidden) : tokens;
  const previous = lastTokenProjection;
  lastTokenProjection = {
    source: tokens,
    hidden: hidden.size === previous.hidden.size && [...hidden].every(id => previous.hidden.has(id)) ? previous.hidden : hidden,
    tokens: visible.length === previous.tokens.length && visible.every((token, i) => token === previous.tokens[i]) ? previous.tokens : visible,
  };
  return lastTokenProjection;
}
const visibleTerrain = new WeakMap();
function playerTerrain(terrain) {
  if (!visibleTerrain.has(terrain)) {
    visibleTerrain.set(terrain, terrain.some(item => item.kind === 'portal') ? terrain.filter(item => item.kind !== 'portal') : terrain);
  }
  return visibleTerrain.get(terrain);
}
function changedFields(next, previous) {
  return Object.fromEntries(Object.entries(next).filter(([key, value]) => previous[key] !== value));
}
function broadcast() {
  const view = activeView(state);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.getURL().startsWith('dm://app/')) {
      const owner = w.webContents;
      const previous = windowSnapshots.get(owner);
      if (!previous) continue;
      const next = windowState(owner, view);
      for (const key of ['detached', 'recentImages', 'playerFrame']) {
        if (JSON.stringify(next[key]) === JSON.stringify(previous[key])) next[key] = previous[key];
      }
      const { state: localState, ...metadata } = changedFields(next, previous);
      const fields = localState ? changedFields(localState, previous.state) : {};
      if (fields.music && previous.state.music && next.campaignId === previous.campaignId) {
        fields.music = changedFields(fields.music, previous.state.music);
      }
      windowSnapshots.set(owner, next);
      if (Object.keys(fields).length || Object.keys(metadata).length) owner.send('state', { ...metadata, state: fields });
    }
  }
}
function commit(action) {
  if (action.payload?.expectedCampaignId && campaigns.index.active !== action.payload.expectedCampaignId) {
    throw new Error('Кампания переключилась. Повтори действие.');
  }
  const priorBoards = state.boards;
  const next = reducer(state, action);
  const oldBattle = state.battles.find(entry => entry.id === state.activeBattleId);
  const nextBattle = next.battles.find(entry => entry.id === oldBattle.id);
  const fired = action.type === 'combat:next' && nextBattle.events !== oldBattle.events
    ? nextBattle.events.filter((item, index) => item.fired && !oldBattle.events[index]?.fired) : [];
  const board = state.boards.find(entry => entry.id === state.activeMapId);
  const after = next.boards.find(entry => entry.id === board.id);
  const undo = after && rememberMapAction(action, board, after);
  writeJSON(store, next, encodeCampaign);
  state = next;
  if (action.type === 'scene:open' || action.type === 'terrain:travel') presentation = null;
  if (undo) mapHistory.set(board.id, [...(mapHistory.get(board.id) ?? []), undo].slice(-30));
  if (action.type === 'terrain:travel') {
    const targetId = state.activeMapId;
    const previousTarget = priorBoards.find(map => map.id === targetId);
    const nextTarget = state.boards.find(map => map.id === targetId);
    const entry = rememberTravel(board, previousTarget, after, nextTarget);
    mapHistory.set(targetId, [...(mapHistory.get(targetId) ?? []), entry].slice(-30));
  }
  if (action.type === 'map:remove') {
    mapCameras.delete(action.payload.id);
    mapHistory.delete(action.payload.id);
    for (const [id, entries] of mapHistory) mapHistory.set(id, entries.filter(entry => entry.from !== action.payload.id));
  }
  if (action.type === 'map:settings' && 'rotation' in action.payload) mapCameras.delete(state.activeMapId);
  broadcast();
  if (action.type === 'scene:open') {
    const sound = state.scenes.find(scene => scene.id === action.payload.id)?.sound;
    if (sound) soundToMaster({ ambience: sound });
  }
  if (fired.length) {
    for (const owner of new Set([mainWindow, windows.get('combat')])) {
      if (owner && !owner.isDestroyed()) owner.webContents.send('status', { scope: 'round-events', events: fired });
    }
  }
  if (action.type === 'combat:roll-initiative' && nextBattle.combatants.some((actor, i) =>
    actor.initiativeRoll && actor.initiativeRoll !== oldBattle.combatants[i]?.initiativeRoll)) {
    soundToMaster({ id: 'dice', category: 'dice' });
  }
  if (['combatant:conditions', 'combatant:hp', 'combatant:edit', 'combatant:undo'].includes(action.type)) {
    const id = action.payload?.id ?? oldBattle.history.at(-1)?.id;
    const previous = oldBattle.combatants.find(actor => actor.id === id);
    const actor = nextBattle.combatants.find(candidate => candidate.id === id);
    if (actor && previous && state.boards.some(map => map.tokens.some(token => token.combatantId === id))) {
      const earlier = new Set(effectsFor(previous).map(effect => effect.id));
      const added = effectsFor(actor).filter(effect => !earlier.has(effect.id) ||
        effect.id === 'exhaustion' && actor.exhaustion > previous.exhaustion);
      if (added.length) soundToMaster({ ids: added.map(effect => effect.id), category: 'effects' });
    }
  }
  return { ok: true };
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, payload) => {
    localSender(event);
    try {
      if (playerSurface(event.sender) && !['init', 'dock', 'fullscreen', 'rotate-player-map'].includes(name)) throw new Error('Экраном управляет мастер');
      return await fn(event, payload);
    }
    catch (err) { return { ok: false, error: String(err.message || err).slice(0, 400) }; }
  });
}
function assetName(value) {
  if (typeof value !== 'string' || !assetPattern.test(value)) throw new Error('Неверное имя файла');
  return value;
}
function checkCampaign(id) {
  if (id !== campaigns.index.active) throw new Error('Кампания переключилась. Повтори действие.');
}
function importAsset(file, kind) {
  const ext = path.extname(file).toLowerCase();
  const allowed = kind === 'audio' ? ['.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.flac'] : ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  if (!allowed.includes(ext)) throw new Error('Этот формат не поддерживается');
  if (fs.statSync(file).size > (kind === 'audio' ? 1024 : 40) * 1024 * 1024) throw new Error('Файл слишком большой');
  const name = randomUUID() + ext;
  fs.copyFileSync(file, path.join(assets, name));
  return { ok: true, asset: name, title: path.basename(file, ext) };
}
function pasteImageBytes(bytes, ext) {
  if (bytes.length > 40 * 1024 * 1024) throw new Error('Изображение больше 40 МБ');
  const asset = randomUUID() + ext;
  fs.writeFileSync(path.join(assets, asset), bytes);
  return { ok: true, asset };
}
function boundsOnScreen(bounds, defaults) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return defaults;
  const displays = screen.getAllDisplays();
  const visible = displays.some(d => bounds.x + bounds.width > d.workArea.x + 80 && bounds.x < d.workArea.x + d.workArea.width - 80 && bounds.y + bounds.height > d.workArea.y + 80 && bounds.y < d.workArea.y + d.workArea.height - 80);
  if (!visible) return defaults;
  return { x: bounds.x, y: bounds.y, width: Math.max(360, Math.min(bounds.width, 7680)), height: Math.max(300, Math.min(bounds.height, 4320)) };
}
function secureWindow(options = {}, showInactive = false) {
  const w = new BrowserWindow({ width: 1500, height: 950, minWidth: 940, minHeight: 640,
    backgroundColor: ScreenThemes[currentTheme].background, show: false, icon: getThemeImage(currentTheme), ...options,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (mac) w.webContents.on('before-input-event', (_, input) => {
    w.webContents.setIgnoreMenuShortcuts(!!matchShortcut(input, shortcuts) || !!input.meta && !input.shift && input.code === 'KeyZ');
  });
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('dm://app/')) e.preventDefault(); });
  if (process.platform === 'win32') w.on('show', () => applyWindowTheme(w));
  w.once('ready-to-show', () => {
    if (TEST) return;
    if (showInactive) w.showInactive();
    else w.show();
  });
  return w;
}
function zoomHost(record) {
  const address = safeUrl(record.view.webContents.getURL()) || record.requested;
  return new URL(address).hostname;
}
function restoreRemoteZoom(record) {
  record.view.webContents.setZoomFactor(siteZoom.get(zoomHost(record)) ?? 1);
}
function adjustRemoteZoom(record, direction) {
  const host = zoomHost(record);
  const current = siteZoom.get(host) ?? 1;
  const next = direction === 'reset' ? 1 : direction === 'in'
    ? remoteZoomFactors.find(factor => factor > current + 0.001)
    : remoteZoomFactors.findLast(factor => factor < current - 0.001);
  if (next === undefined || next === current) return;
  const updated = new Map(siteZoom);
  if (next === 1) updated.delete(host);
  else {
    if (updated.size >= 500 && !updated.has(host)) updated.delete(updated.keys().next().value);
    updated.set(host, next);
  }
  try { writeJSON(zoomStore, [...updated]); }
  catch (error) { console.warn('Не удалось сохранить масштаб:', error.message); }
  siteZoom = updated;
  for (const entry of remotes.values()) {
    if (!entry.view.webContents.isDestroyed() && zoomHost(entry) === host) restoreRemoteZoom(entry);
  }
  reportReference();
}
function attachRemote(id, owner) {
  let record = remotes.get(id);
  if (!record) {
    const kind = remoteKind(id);
    const view = new WebContentsView({ webPreferences: { partition: partitionFor(kind), nodeIntegration: false, contextIsolation: true, sandbox: true,
      ...(mac ? { preload: path.join(__dirname, 'remote-zoom-preload.cjs') } : {}) } });
    view.setVisible(false);
    record = { view, owner: null, requested: referenceTabs.get(id)?.initialUrl || REMOTE[kind], failed: false };
    remotes.set(id, record);
    const wc = view.webContents;
    wc.setZoomMode('isolated');
    if (!mac) wc.on('zoom-changed', (_, direction) => adjustRemoteZoom(record, direction));
    wc.on('before-input-event', (event, input) => {
      const pad = padShortcut(input);
      if (pad && input.type === 'keyDown') {
        event.preventDefault();
        if (!input.isAutoRepeat) soundToMaster({ id: pad, pad: true });
        return;
      }
      if (input.type === 'keyDown' && !input.isAutoRepeat) {
        if (input.key === 'Escape' && !input.control && !input.meta && !input.alt && !input.shift) {
          event.preventDefault();
          openMasterSettings();
          return;
        }
        const command = matchShortcut(input, shortcuts);
        if (command) {
          const target = command === 'fullscreen' || command.startsWith('reference-') && remotePanelFor(id) === 'info' ? record.owner : mainWindow;
          if (target && !target.isDestroyed()) {
            event.preventDefault();
            if (target !== record.owner && !TEST) { target.show(); target.focus(); }
            target.webContents.focus();
            target.webContents.send('status', { scope: 'shortcut', command });
            return;
          }
        }
      }
      if (input.type !== 'keyDown' || input.alt || !(input.control || (mac && input.meta))) return;
      const direction = ['Digit0', 'Numpad0'].includes(input.code) ? 'reset'
        : ['Equal', 'NumpadAdd'].includes(input.code) ? 'in'
          : ['Minus', 'NumpadSubtract'].includes(input.code) ? 'out' : null;
      if (!direction) return;
      event.preventDefault();
      adjustRemoteZoom(record, direction);
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const destination = safeUrl(url);
      if (!destination) return { action: 'deny' };
      if (id !== 'characters') {
        if (['foreground-tab', 'background-tab'].includes(disposition)) {
          setImmediate(() => {
            if (!wc.isDestroyed() && record.owner && !record.owner.isDestroyed()) {
              openReferenceTab(record.owner, kind, destination, disposition === 'foreground-tab');
            }
          });
        }
        return { action: 'deny' };
      }
      // Authentication popups share only this site's browser session, without app APIs.
      return { action: 'allow', overrideBrowserWindowOptions: { width: 850, height: 720, autoHideMenuBar: true, webPreferences: { partition: `persist:dm-${id}`, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    });
    const limitNavigation = event => {
      const destination = safeUrl(event.url);
      if (!destination || (id !== 'characters' && new URL(destination).hostname === 'accounts.google.com')) event.preventDefault();
    };
    wc.on('will-navigate', limitNavigation);
    wc.on('will-redirect', limitNavigation);
    wc.on('did-navigate', () => {
      record.failed = false;
      restoreRemoteZoom(record);
      reportReference();
    });
    wc.on('did-fail-load', (_, code, message, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      if (id === 'characters') sendAll('status', { scope: id, text: `Не удалось открыть сайт: ${message}. Нажмите ↻ для повтора.` });
      else {
        record.failed = true;
        if (safeUrl(url)) record.requested = url;
        view.setVisible(false);
        reportReference();
      }
    });
    if (id !== 'characters') {
      wc.on('did-start-navigation', ({ url, isMainFrame }) => {
        if (isMainFrame && safeUrl(url)) {
          record.failed = false;
          record.requested = url;
          reportReference();
        }
      });
      for (const event of ['did-finish-load', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) {
        wc.on(event, reportReference);
      }
    }
    loadRemote(record, record.requested);
  }
  if (record.owner !== owner) {
    if (record.owner && !record.owner.isDestroyed()) record.owner.contentView.removeChildView(record.view);
    owner.contentView.addChildView(record.view); record.owner = owner;
  }
  return record.view;
}
function selectReferenceTab(id) {
  if (referenceTab !== id) remotes.get(referenceTab)?.view.setVisible(false);
  referenceTab = id;
}
function openReferenceTab(owner, kind, url, foreground = true) {
  if (referenceTabs.size >= 10) {
    owner.webContents.send('status', { scope: 'reference-notice', text: 'Закрой вкладку, чтобы открыть новую. Всего доступно 10 вкладок.' });
    return;
  }
  const id = randomUUID();
  referenceTabs.set(id, { kind, initialUrl: url });
  if (foreground) selectReferenceTab(id);
  attachRemote(id, owner);
  reportReference();
}
function closeReferenceTab(owner, id) {
  if (Object.hasOwn(REMOTE, id) || !referenceTabs.has(id)) return;
  const ids = [...referenceTabs.keys()];
  if (referenceTab === id) selectReferenceTab(ids[ids.indexOf(id) - 1]);
  referenceTabs.delete(id);
  const record = remotes.get(id);
  if (record) {
    record.owner?.contentView.removeChildView(record.view);
    remotes.delete(id);
    record.view.webContents.close();
  }
  attachRemote(referenceTab, owner);
  reportReference();
}
function loadRemote(record, url) {
  record.failed = false;
  record.requested = url;
  return record.view.webContents.loadURL(url).catch(() => {});
}
function referenceState() {
  const pages = {};
  const tabs = [];
  for (const [tab, { kind }] of referenceTabs) {
    const record = remotes.get(tab);
    const wc = record?.view.webContents;
    const loaded = wc && !wc.isDestroyed() ? safeUrl(wc.getURL()) : null;
    pages[tab] = {
      url: record?.failed ? record.requested : loaded || record?.requested || REMOTE[kind],
      title: loaded && !record.failed ? wc.getTitle() : '',
      bookmarkable: !!loaded && !record.failed && !wc.isLoadingMainFrame(),
      failed: !!record?.failed,
      canBack: wc?.navigationHistory.canGoBack() ?? false,
      canForward: wc?.navigationHistory.canGoForward() ?? false,
      zoom: Math.round((record ? siteZoom.get(zoomHost(record)) ?? 1 : 1) * 100)
    };
    if (!Object.hasOwn(REMOTE, tab)) tabs.push({ id: tab, title: pages[tab].title || new URL(pages[tab].url).hostname });
  }
  const sheets = remotes.get('characters');
  return { tab: referenceTab, kind: remoteKind(referenceTab), pages, tabs,
    sheetsZoom: Math.round((sheets ? siteZoom.get(zoomHost(sheets)) ?? 1 : siteZoom.get('longstoryshort.app') ?? 1) * 100) };
}
function reportReference() {
  if (!quitting) sendAll('status', { scope: 'reference', ...referenceState() });
}
async function referenceAction(event, { action, value }) {
  const owner = windows.get('info') || mainWindow;
  if (event.sender !== owner?.webContents) throw new Error('Открой справочник, чтобы продолжить');
  if (action === 'gemini') {
    const query = typeof value === 'string' ? value.trim().slice(0, 500) : '';
    if (query) await clipboard.writeText(query);
    await shell.openExternal(GEMINI);
    return { ok: true, copied: !!query };
  }
  if (action === 'remove-bookmark') return commit({ type: 'bookmark:remove', payload: { id: value } });
  if (action === 'new-tab') { openReferenceTab(owner, remoteKind(referenceTab)); return { ok: true }; }
  if (action === 'close-tab') { closeReferenceTab(owner, value ?? referenceTab); return { ok: true }; }
  let tab = referenceTab, destination = null;
  const extra = !Object.hasOwn(REMOTE, tab);
  if (action === 'tab' && referenceTabs.has(value)) tab = value;
  else if (action === 'shortcut' || action === 'shortcut-tab') {
    if (!extra || remoteKind(tab) !== 'info') tab = 'info';
    destination = REFERENCE_LINKS.find(link => link.id === value)?.url;
    if (!destination) throw new Error('Раздел не найден');
    if (action === 'shortcut-tab') { openReferenceTab(owner, 'info', destination); return { ok: true }; }
  } else if (action === 'search') {
    destination = searchUrl(value, remoteKind(tab) === 'info');
    if (!extra) tab = 'web';
  } else if (action === 'bookmark') {
    const item = state.bookmarks.find(entry => entry.id === value);
    destination = safeUrl(item?.url);
    if (!destination) throw new Error('Закладка не найдена');
    tab = item.tab === 'info' ? 'info' : 'web';
  } else if (!['back', 'forward', 'reload', 'external', 'save-bookmark', 'home', 'zoom-in', 'zoom-out', 'zoom-reset'].includes(action)) {
    throw new Error('Неизвестная команда справочника');
  }
  selectReferenceTab(tab);
  const wc = attachRemote(tab, owner).webContents;
  const record = remotes.get(tab);
  reportReference();
  if (destination) await loadRemote(record, destination);
  else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === 'reload') await loadRemote(record, record.failed ? record.requested : safeUrl(wc.getURL()) || record.requested);
  else if (action === 'home') await loadRemote(record, REMOTE[remoteKind(tab)]);
  else if (action.startsWith('zoom-')) adjustRemoteZoom(record, action.slice(5));
  else if (action === 'external') {
    const address = safeUrl(referenceState().pages[tab].url);
    if (address) await shell.openExternal(address);
  } else if (action === 'save-bookmark') {
    const page = referenceState().pages[tab];
    if (!page.bookmarkable) throw new Error('Дождись, пока страница загрузится');
    return commit({ type: 'bookmark:add', payload: { url: page.url, title: page.title, tab: remoteKind(tab) } });
  }
  return { ok: true };
}
function detach(id, focus = true) {
  if (!PANELS.includes(id) && id !== 'preview') throw new Error('Неизвестная панель');
  if (windows.has(id)) {
    const window = windows.get(id);
    if (focus && !TEST) { window.show(); window.focus(); }
    return { ok: true };
  }
  const defaults = { width: id === 'map' ? 1000 : 650, height: id === 'preview' ? 420 : 750 };
  if (id === 'map' && mainWindow && !TEST) {
    const primary = screen.getDisplayMatching(mainWindow.getBounds());
    const second = screen.getAllDisplays().find(display => display.id !== primary.id)?.workArea;
    if (second) Object.assign(defaults, {
      width: Math.min(defaults.width, second.width), height: Math.min(defaults.height, second.height),
      x: second.x + 24, y: second.y + 24
    });
  }
  const bounds = boundsOnScreen(state.layout.windows[id], defaults);
  const w = secureWindow({ ...bounds, minWidth: 360, minHeight: 300, title: 'Ширма · ' + id, autoHideMenuBar: true }, !focus);
  windows.set(id, w);
  w.loadURL(id === 'preview' ? 'dm://app/index.html?panel=map&preview=1' : `dm://app/index.html?panel=${id}`);
  let timer;
  const saveBounds = () => { clearTimeout(timer); timer = setTimeout(() => { if (!w.isDestroyed() && !quitting) commit({ type: 'layout:window', payload: { id, bounds: w.getNormalBounds() } }); }, 300); };
  if (id !== 'preview') { w.on('move', saveBounds); w.on('resize', saveBounds); }
  if (id === 'map') w.on('resize', syncPlayerFrame);
  w.on('close', () => {
    clearTimeout(timer);
    if (!quitting && id !== 'preview') commit({ type: 'layout:window', payload: { id, bounds: w.getNormalBounds() } });
    for (const remote of remotes.values()) {
      if (remote.owner === w && mainWindow && !mainWindow.isDestroyed()) {
        w.contentView.removeChildView(remote.view); mainWindow.contentView.addChildView(remote.view); remote.owner = mainWindow; remote.view.setVisible(false);
      }
    }
  });
  w.on('closed', () => {
    windows.delete(id);
    if (id === 'map') presentation = null;
    if (!quitting) broadcast();
  });
  if (id === 'map') {
    for (const [event, active] of [['enter-full-screen', true], ['leave-full-screen', false]]) w.on(event, () => {
      w.webContents.send('status', { scope: 'player-fullscreen', active });
      syncPlayerFrame();
    });
  }
  broadcast(); return { ok: true };
}
function switchCampaign(id) {
  if (id === campaigns.index.active) return;
  if (downloadProcess) throw new Error('Дождись завершения загрузки музыки или отмени её');
  const next = campaigns.select(id);
  ({ state, assets, file: store } = next);
  mapHistory.clear();
  mapCameras.clear();
  presentation = null;
  recentImages = [];
  playerBlackout = windows.has('map');
  broadcast();
  soundToMaster({ ambience: { loops: [], ambientVolume: 1 } });
}
function openMasterSettings() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!TEST) { mainWindow.show(); mainWindow.focus(); }
  mainWindow.webContents.focus();
  mainWindow.webContents.send('status', { scope: 'open-settings' });
}
function setupIPC() {
  handle('open-master-settings', () => { openMasterSettings(); return { ok: true }; });
  handle('quit-app', event => {
    if (event.sender !== mainWindow.webContents) throw new Error('Команда доступна в главном окне');
    setImmediate(() => app.quit());
    return { ok: true };
  });
  handle('portal-map-preview', (_, { mapId, expectedCampaignId }) => {
    checkCampaign(expectedCampaignId);
    const board = state.boards.find(entry => entry.id === mapId);
    if (!board) throw new Error('Карта не найдена');
    const { image, grid, offsetX, offsetY, demo } = board.map;
    return { ok: true, image, grid, offsetX, offsetY, demo };
  });
  handle('event-map-doors', (_, { mapId, expectedCampaignId }) => {
    checkCampaign(expectedCampaignId);
    const board = state.boards.find(entry => entry.id === mapId);
    if (!board) throw new Error('Карта не найдена');
    const doors = board.terrain.filter(item => item.kind === 'door');
    return { ok: true, doors: doors.map(({ id, a }, index) => ({
      id, label: `Дверь ${index + 1} · ${Math.floor((a.x - board.map.offsetX) / board.map.grid)}, ${Math.floor((a.y - board.map.offsetY) / board.map.grid)}`
    })) };
  });
  handle('campaign-search', (_, { query, expectedCampaignId }) => {
    checkCampaign(expectedCampaignId);
    return { ok: true, matches: searchCampaign(state, query) };
  });
  handle('master-shortcut', (_, command) => {
    if (typeof command !== 'string' || !Object.hasOwn(shortcutDefaults, command)) throw new Error('Команда недоступна');
    if (!TEST) { mainWindow.show(); mainWindow.focus(); }
    mainWindow.webContents.send('status', { scope: 'shortcut', command });
    return { ok: true };
  });
  handle('workspace-command', (event, { panel, command, id }) => {
    const allowed = (panel === 'characters' && command === 'note') || (panel === 'combat' && command === 'actor') ||
      (panel === 'info' && ['reference-address', 'reference-new', 'reference-close'].includes(command));
    if (!allowed || event.sender !== mainWindow.webContents) throw new Error('Команда недоступна');
    const target = windows.get(panel);
    if (!target || target.isDestroyed()) return { ok: true, sent: false };
    if (!TEST) { target.show(); target.focus(); }
    target.webContents.send('status', { scope: 'workspace-command', command, id });
    return { ok: true, sent: true };
  });
  handle('init', event => {
    const snapshot = windowState(event.sender);
    windowSnapshots.set(event.sender, snapshot);
    return { ...snapshot, version: app.getVersion(), updateStatus, musicStatus,
      mainFullscreen: event.sender === mainWindow?.webContents && mainWindow.isFullScreen(),
      conditionDefinitions: CONDITIONS, combatRoles: ROLES, referenceLinks: REFERENCE_LINKS,
      reference: referenceState(), shortcuts, soundPreferences, activePads, musicPosition, test: TEST, mac, theme: currentTheme, welcomeAtStart: !TEST || process.env.DM_SCREEN_WELCOME_TEST === '1' };
  });
  handle('sound-preferences', (_, values) => {
    const next = normalizeSoundPreferences({ ...soundPreferences, ...values });
    writeJSON(soundStore, next);
    soundPreferences = next;
    sendAll('status', { scope: 'sound-preferences', preferences: next });
    return { ok: true };
  });
  handle('sound-assign-category', (_, { id, category }) => {
    if (!padIds.has(id) || category !== '' && !soundPreferences.categories.includes(category)) throw new Error('Категория или звук не найдены');
    const next = { ...soundPreferences, assignment: { ...soundPreferences.assignment, [id]: category } };
    writeJSON(soundStore, next);
    soundPreferences = next;
    sendAll('status', { scope: 'sound-preferences', preferences: next });
    return { ok: true };
  });
  handle('sound-pad', (_, id) => {
    if (!padIds.has(id) && id !== 'stop-ambient') throw new Error('Звук не найден');
    soundToMaster({ id, pad: true });
    return { ok: true };
  });
  handle('sound-pad-state', (event, ids) => {
    if (event.sender !== mainWindow.webContents || !Array.isArray(ids) || ids.length > ambientIds.length || ids.some(id => !ambientIds.includes(id))) {
      throw new Error('Недопустимое состояние звуков');
    }
    activePads = ids;
    windows.get('music')?.webContents.send('status', { scope: 'sound-pad-state', ids });
    return { ok: true };
  });
  handle('sound-click', () => { soundToMaster({ id: 'click', category: 'clicks' }); return { ok: true }; });
  handle('sound-dice', () => { soundToMaster({ id: 'dice', category: 'dice' }); return { ok: true }; });
  handle('sound-movement-preview', (_, id) => { soundToMaster({ id: moveSound(id) }); return { ok: true }; });
  ipcMain.on('music-position', (event, data) => {
    if (event.sender !== mainWindow?.webContents || data?.campaignId !== campaigns.index.active ||
        data.trackId !== state.music.current || !Number.isFinite(data.duration) || !Number.isFinite(data.time)) return;
    const duration = Math.max(0, data.duration);
    musicPosition = { campaignId: data.campaignId, trackId: data.trackId, duration, time: Math.max(0, Math.min(data.time, duration)) };
    windows.get('music')?.webContents.send('status', { scope: 'music-position', ...musicPosition });
  });
  handle('music-seek', (event, data) => {
    if (event.sender !== windows.get('music')?.webContents || !Number.isFinite(data?.time) ||
        !data.trackId || data.trackId !== state.music.current || data.campaignId !== campaigns.index.active) {
      throw new Error('Трек изменился или не загружен');
    }
    mainWindow.webContents.send('status', { scope: 'music-seek', campaignId: data.campaignId, trackId: data.trackId, time: data.time });
    return { ok: true };
  });
  handle('set-shortcuts', (_, value) => {
    const next = validateShortcuts(value);
    if (!next) throw new Error('У каждой команды должна быть своя буква от A до Z');
    writeJSON(shortcutStore, next);
    shortcuts = next;
    sendAll('status', { scope: 'shortcuts', bindings: shortcuts });
    return { ok: true };
  });
  handle('set-theme', (event, id) => {
    if (event.sender !== mainWindow?.webContents || typeof id !== 'string' || !Object.hasOwn(ScreenThemes, id)) {
      throw new Error('Неизвестная тема оформления');
    }
    if (currentTheme === id) return { ok: true };
    fs.writeFileSync(`${themeStore}.tmp`, JSON.stringify({ theme: id }), 'utf8');
    fs.renameSync(`${themeStore}.tmp`, themeStore);
    currentTheme = id;
    app.dock?.setIcon(getThemeImage(id));
    for (const window of BrowserWindow.getAllWindows()) applyWindowTheme(window);
    sendAll('status', { scope: 'appearance-theme', theme: id });
    return { ok: true };
  });
  handle('dispatch', (event, action) => {
    if (event.sender === windows.get('map')?.webContents) throw new Error('Экраном управляет мастер');
    if (!action || typeof action.type !== 'string') throw new Error('Неверная команда');
    const limit = ['story:save', 'story:draw', 'map:draw'].includes(action.type) ? 125000 : 10000;
    if (JSON.stringify(action).length > limit) throw new Error('Неверная команда');
    if (['map:image', 'combatant:add', 'combatant:edit', 'library:save', 'terrain:add', 'terrain:edit-item'].includes(action.type) && action.payload?.image) assetName(action.payload.image);
    if (action.type === 'story:save' && action.payload && 'images' in action.payload) {
      const images = action.payload.images;
      if (!Array.isArray(images) || images.length > 12) throw new Error('В заметке помещается до 12 картинок');
      for (const value of images) {
        const image = assetName(value);
        if (!/\.(png|jpe?g|webp|gif)$/i.test(image) || !fs.existsSync(path.join(assets, image))) throw new Error('Изображение заметки отсутствует');
      }
    }
    if (action.type === 'music:add') assetName(action.payload?.asset);
    if (action.type === 'gallery:add') {
      const name = assetName(action.payload?.image);
      if (!/\.(png|jpe?g|webp|gif)$/i.test(name) || !fs.existsSync(path.join(assets, name))) {
        throw new Error('Изображение отсутствует');
      }
    }
    if (['music:save-import', 'bookmark:add', 'bookmark:remove', 'combatant:import'].includes(action.type)) throw new Error('Команда недоступна');
    const result = commit(action);
    return action.type === 'gallery:add' ? { ...result, id: state.gallery[0].id } : result;
  });
  handle('map-undo', (_, context = {}) => {
    if (context.expectedCampaignId !== campaigns.index.active || context.expectedMapId !== state.activeMapId) {
      throw new Error('Карта переключилась');
    }
    const history = mapHistory.get(state.activeMapId);
    if (!history?.length) return { ok: true };
    const entry = history.at(-1);
    const next = undoMapAction(state, entry);
    writeJSON(store, next, encodeCampaign);
    state = next;
    if (entry.field === 'map') mapCameras.delete(state.activeMapId);
    history.pop();
    broadcast();
    return { ok: true };
  });
  handle('campaign', async (event, { action, id, name }) => {
    if (event.sender !== mainWindow.webContents || campaignBusy) throw new Error('Дождись завершения операции с кампанией');
    if (action === 'select') switchCampaign(id);
    else if (action === 'create') {
      if (downloadProcess) throw new Error('Дождись завершения загрузки музыки или отмени её');
      switchCampaign(campaigns.create(name));
    } else if (action === 'rename') {
      campaigns.rename(id, name);
      broadcast();
    } else if (action === 'export' || action === 'import') {
      campaignBusy = true;
      try {
        const filters = [{ name: 'Архив кампании', extensions: ['tar.gz'] }];
        if (action === 'export') {
          const chosen = await dialog.showSaveDialog(mainWindow, { defaultPath: 'campaign.tar.gz', filters });
          if (chosen.canceled || !chosen.filePath) return { canceled: true };
          await campaigns.exportArchive(chosen.filePath, state);
        } else {
          if (downloadProcess) throw new Error('Дождись завершения загрузки музыки или отмени её');
          const chosen = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters });
          if (chosen.canceled) return { canceled: true };
          switchCampaign(await campaigns.importArchive(chosen.filePaths[0]));
        }
      } finally { campaignBusy = false; }
    } else throw new Error('Неизвестное действие кампании');
    return { ok: true };
  });
  handle('import-file', async (event, { kind }) => {
    const active = campaigns.index.active;
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openFile'], filters: [{ name: kind === 'audio' ? 'Музыка' : 'Изображения', extensions: kind === 'audio' ? ['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac'] : ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    checkCampaign(active);
    return result.canceled ? { canceled: true } : importAsset(result.filePaths[0], kind);
  });
  handle('import-drop', (_, { path: file, kind }) => importAsset(file, kind));
  handle('read-dnd-card', async (event, { url, kind }) => {
    if (event.sender === windows.get('map')?.webContents || !['creature', 'item'].includes(kind)) throw new Error('Импорт доступен мастеру');
    const source = publicDndUrl(url, kind);
    if (!source) throw new Error('Перетащи ссылку на отдельную карточку dnd.su');
    const bytes = await readPublicResponse(net, source, 2 * 1024 * 1024);
    return { ok: true, source, html: bytes.toString('utf8') };
  });
  handle('read-dnd-icon', async (event, url) => {
    if (event.sender === windows.get('map')?.webContents) throw new Error('Импорт доступен мастеру');
    const source = publicDndUrl(url, 'portrait');
    if (!source) return { ok: true };
    const active = campaigns.index.active;
    const bytes = await readPublicResponse(net, source, 5 * 1024 * 1024);
    checkCampaign(active);
    const icon = nativeImage.createFromBuffer(bytes);
    if (icon.isEmpty()) return { ok: true };
    return pasteImageBytes(icon.resize({ width: Math.min(384, icon.getSize().width) }).toPNG(), '.png');
  });
  handle('import-lss', async (event, { file, expectedBattleId, template, fromClipboard }) => {
    const active = campaigns.index.active;
    if (!file && !fromClipboard) {
      const chosen = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        properties: ['openFile'], filters: [{ name: 'Лист Long Story Short', extensions: ['json'] }],
      });
      if (chosen.canceled) return { canceled: true };
      [file] = chosen.filePaths;
    }
    checkCampaign(active);
    if (!file && !fromClipboard) return { canceled: true };
    if (!template && state.activeBattleId !== expectedBattleId) throw new Error('Бой переключился. Повтори импорт.');
    const maxBytes = 12 * 1024 * 1024;
    if (!fromClipboard && (path.extname(file).toLowerCase() !== '.json' || fs.statSync(file).size > maxBytes)) {
      throw new Error('Выбери JSON-файл Long Story Short размером до 12 МБ');
    }
    const raw = fromClipboard ? await clipboard.readText() : fs.readFileSync(file, 'utf8');
    checkCampaign(active);
    if (!template && state.activeBattleId !== expectedBattleId) throw new Error('Бой переключился. Повтори импорт.');
    if (Buffer.byteLength(raw) > maxBytes) throw new Error('JSON должен быть размером до 12 МБ');
    if (!raw.trim()) throw new Error('В буфере обмена нет JSON');
    const { portrait, initiativeNeedsReview, ...actor } = readCharacter(raw.replace(/^\uFEFF/, ''));
    if (portrait) actor.image = pasteImageBytes(portrait.bytes, portrait.extension).asset;
    return { ok: true, actor: { ...actor, role: 'player' }, initiativeNeedsReview };
  });
  handle('paste-image', async () => {
    const active = campaigns.index.active;
    const items = await clipboard.read().catch(() => []);
    checkCampaign(active);
    for (const item of items) {
      const type = item.types.find(t => ['image/png', 'image/jpeg', 'image/webp'].includes(t));
      if (type) {
        const bytes = Buffer.from(await (await item.getType(type)).arrayBuffer());
        checkCampaign(active);
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type];
        return pasteImageBytes(bytes, ext);
      }
      // Windows Explorer puts a copied image file's path in FileNameW.
      const fileType = item.types.find(t => t.includes('osclipboard') && t.includes('FileNameW'));
      if (fileType) {
        const bytes = Buffer.from(await (await item.getType(fileType)).arrayBuffer());
        checkCampaign(active);
        const file = bytes.toString('utf16le').split('\0')[0];
        if (path.isAbsolute(file)) return importAsset(file, 'image');
      }
    }
    const image = clipboard.readImage();
    if (!image.isEmpty()) return pasteImageBytes(image.toPNG(), '.png');
    const formats = clipboard.availableFormats();
    for (const format of ['public.file-url', 'text/uri-list', 'x-special/gnome-copied-files']) {
      if (!formats.includes(format)) continue;
      const uri = clipboard.readBuffer(format).toString('utf8').split(/[\r\n\0]+/).find(line => line.startsWith('file://'));
      if (uri) return importAsset(fileURLToPath(uri), 'image');
    }
    throw new Error('В буфере обмена нет изображения');
  });
  handle('detach', (_, id) => detach(id));
  handle('show-players', (event, { source, id }) => {
    if (event.sender === windows.get('map')?.webContents) throw new Error('Экраном управляет мастер');
    if (source === 'map') presentation = null;
    else {
      if (!['gallery', 'portrait'].includes(source)) throw new Error('Неизвестный источник изображения');
      const ref = { source, id };
      const image = resolveImage(ref);
      if (!image) throw new Error('Изображение не найдено');
      presentation = image;
      recentImages = [ref, ...recentImages.filter(item => item.source !== source || item.id !== id)].slice(0, 12);
      if (!windows.has('map')) detach('map', false);
    }
    broadcast();
    return { ok: true, covered: playerBlackout };
  });
  handle('show-token', (_, id) => {
    if (!activeView(state).tokens.some(token => token.combatantId === id)) return { ok: false, error: 'Жетон уже убран с карты' };
    sendAll('status', { scope: 'map-focus', id });
    return { ok: true };
  });
  handle('place-token', (event, { kind, id, expectedBattleId, expectedMapId }) => {
    if (event.sender !== windows.get('combat')?.webContents || !['actor', 'template'].includes(kind)) {
      throw new Error('Размещение доступно в трекере боя');
    }
    if (expectedBattleId !== state.activeBattleId || expectedMapId !== state.activeMapId) throw new Error('Карта или бой переключились');
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('status', { scope: 'map-place', kind, id, expectedBattleId, expectedMapId });
    return { ok: true };
  });
  handle('dock', event => { const w = BrowserWindow.fromWebContents(event.sender); if (w !== mainWindow) w.close(); return { ok: true }; });
  handle('rotate-player-map', (event, { delta, expectedCampaignId, expectedMapId }) => {
    if (event.sender !== windows.get('map')?.webContents || ![-90, 90].includes(delta)) {
      throw new Error('Поворот доступен в окне карты игроков');
    }
    if (expectedMapId !== state.activeMapId || expectedCampaignId !== campaigns.index.active) throw new Error('Карта переключилась');
    const { map } = state.boards.find(board => board.id === state.activeMapId);
    const playerRotation = ((map.playerRotation ?? map.rotation ?? 0) + delta + 360) % 360;
    return commit({ type: 'map:settings', payload: { playerRotation, expectedCampaignId, expectedMapId } });
  });
  ipcMain.on('mirror-map', (event, preview) => {
    if (event.sender !== mainWindow?.webContents || !preview) return;
    if (preview.mapId !== state.activeMapId || (preview.campaignId && preview.campaignId !== campaigns.index.active)) return;
    const camera = preview.camera;
    if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.y)) mapCameras.set(state.activeMapId, camera);
    if (typeof preview.blackout === 'boolean') playerBlackout = preview.blackout;
    const ping = preview.ping;
    const token = preview.token;
    const board = state.boards.find(item => item.id === state.activeMapId);
    const original = token && board.tokens.find(item => item.combatantId === token.id);
    const movingActor = original && !original.hidden && activeView(state).mapCombatants.find(actor => actor.id === token.id);
    const valid = movingActor && [token.col, token.row].every(n => Number.isInteger(n) && n >= 0 && n <= 2000) &&
      canMoveToken(board, original, token.col, token.row, token.waypoints, movingActor.tokenSize);
    const message = {
      scope: 'map-preview', mapId: state.activeMapId, camera: mapCameras.get(state.activeMapId) ?? null,
      blackout: playerBlackout,
      ...(ping && Number.isFinite(ping.x) && Number.isFinite(ping.y) ? { ping } : {}),
      ...(Object.hasOwn(preview, 'token') ? { token: valid ? token : null } : {})
    };
    for (const id of ['map', 'preview']) windows.get(id)?.webContents.send('status', message);
  });
  handle('fullscreen', event => { const w = BrowserWindow.fromWebContents(event.sender); w.setFullScreen(!w.isFullScreen()); return { ok: true }; });
  ipcMain.on('resize-window', (event, p) => {
    try {
      localSender(event); const w = BrowserWindow.fromWebContents(event.sender);
      if (w === mainWindow || !Number.isFinite(p.width) || !Number.isFinite(p.height)) return;
      const area = screen.getDisplayMatching(w.getBounds()).workArea;
      w.setSize(Math.max(360, Math.min(Math.round(p.width), area.width)), Math.max(300, Math.min(Math.round(p.height), area.height)));
      if (p.snap && p.screenX > area.x + area.width - 40 && p.screenY > area.y + area.height - 40) w.setFullScreen(true);
    } catch { /* The detached window may have closed mid-drag. */ }
  });
  ipcMain.on('remote-bounds', (event, { id, bounds }) => {
    try {
      localSender(event); if ((TEST && process.env.DM_SCREEN_REMOTE_TEST !== '1') || !remoteKind(id)) return;
      const owner = BrowserWindow.fromWebContents(event.sender);
      if ((windows.get(remotePanelFor(id)) || mainWindow) !== owner) return;
      if (!bounds || id !== 'characters' && id !== referenceTab) {
        const record = remotes.get(id);
        if (record?.owner === owner) record.view.setVisible(false);
        return;
      }
      const view = attachRemote(id, owner);
      if (remotes.get(id).failed || bounds.width < 5 || bounds.height < 5) { view.setVisible(false); return; }
      const [maxW, maxH] = owner.getContentSize();
      const x = Math.max(0, Math.round(bounds.x)), y = Math.max(0, Math.round(bounds.y));
      view.setBounds({ x, y, width: Math.max(1, Math.min(maxW - x, Math.round(bounds.width))), height: Math.max(1, Math.min(maxH - y, Math.round(bounds.height))) }); view.setVisible(true);
    } catch { /* Window may close during a resize. */ }
  });
  handle('reference-action', referenceAction);
  if (mac) ipcMain.on('remote-wheel-zoom', (event, direction) => {
    if ((direction !== 'in' && direction !== 'out') || event.senderFrame !== event.sender.mainFrame) return;
    const record = [...remotes.values()].find(item => item.view.webContents === event.sender);
    if (record?.view.getVisible()) adjustRemoteZoom(record, direction);
  });
  handle('remote-action', async (event, { id, action }) => {
    if (!Object.hasOwn(REMOTE, id)) throw new Error('Неизвестный сайт');
    const record = remotes.get(id);
    const wc = record?.view.webContents;
    if (['zoom-in', 'zoom-out', 'zoom-reset'].includes(action)) {
      if (!record || event.sender !== record.owner?.webContents) throw new Error('Открой страницу, чтобы изменить масштаб');
      adjustRemoteZoom(record, action.slice(5));
      return { ok: true };
    }
    if (action === 'external') await shell.openExternal(safeUrl(wc?.getURL()) || REMOTE[id]);
    else if (wc && action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (wc && action === 'reload') wc.reload();
    else if (wc && action === 'home') await wc.loadURL(REMOTE[id]);
    return { ok: true };
  });
  handle('download-music', (_, p) => {
    if (campaignBusy) throw new Error('Дождись завершения операции с кампанией');
    return downloadMusic(p);
  });
  handle('cancel-music', () => {
    downloadProcess?.stop('Загрузка отменена');
    return { ok: true };
  });
  handle('update', async (_, action) => {
    if (!app.isPackaged || TEST) return { ok: false, error: 'Обновления доступны в установленной версии. Сборки — на GitHub Releases.' };
    if (!canAutoUpdate) {
      if (action === 'check') await shell.openExternal(releasesUrl);
      return { ok: true };
    }
    if (action === 'check') await autoUpdater.checkForUpdates();
    else if (action === 'download' && updateStatus.phase === 'available') await autoUpdater.downloadUpdate();
    else if (action === 'install' && updateStatus.phase === 'downloaded') { autoUpdater.quitAndInstall(false, true); }
    return { ok: true };
  });
}
function reportMusic(phase, text, percent = null) {
  musicStatus = { scope: 'music', phase, text, percent };
  sendAll('status', musicStatus);
}
async function downloadMusic({ url, folder }) {
  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error('Вставьте ссылку на отдельное видео YouTube');
  if (downloadProcess) throw new Error('Дождитесь завершения текущей загрузки');
  if (!state.music.folders.includes(folder)) folder = 'Общее';
  const source = 'https://www.youtube.com/watch?v=' + videoId;
  const available = state.music.tracks.filter(track => {
    if (youtubeVideoId(track.source) !== videoId || !assetPattern.test(track.asset)) return false;
    const file = fs.statSync(path.join(assets, track.asset), { throwIfNoEntry: false });
    return file?.isFile() && file.size > 0;
  });
  const mp3 = available.find(track => /\.mp3$/i.test(track.asset));
  const save = ({ asset, title, previousAsset }) => commit({
    type: 'music:save-import',
    payload: { asset, title: title || videoId, previousAsset, folder, source }
  });
  if (mp3) {
    save(mp3);
    reportMusic('done', 'MP3 уже сохранён на компьютере');
    return { ok: true };
  }
  const tools = app.isPackaged ? path.join(process.resourcesPath, 'media') : path.join(__dirname, '..', '.tools', 'media');
  const cached = available[0];
  const { downloader, ffmpeg } = mediaTools(tools);
  if (!cached && !downloader) throw new Error('Не найден загрузчик YouTube');
  if (!ffmpeg) {
    throw new Error(mac ? 'Для импорта с YouTube установите FFmpeg (brew install ffmpeg).'
      : process.platform === 'linux' ? 'Для импорта с YouTube установите пакет ffmpeg через менеджер пакетов.'
      : 'Не найден конвертер MP3');
  }
  const job = beginMusicImport({ assets, downloader, ffmpeg, source, cached, nodePath: process.execPath, report: reportMusic, save });
  downloadProcess = job;
  try { return await job.done; }
  finally { downloadProcess = null; }
}
function setupUpdater() {
  if (!canAutoUpdate) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const status = (phase, text, extra = {}) => { updateStatus = { scope: 'update', phase, text, ...extra }; sendAll('status', updateStatus); };
  autoUpdater.on('checking-for-update', () => status('checking', 'Проверяем обновления…'));
  autoUpdater.on('update-available', info => status('available', `Доступна версия ${info.version}`, { version: info.version }));
  autoUpdater.on('update-not-available', () => status('latest', 'Установлена последняя версия'));
  autoUpdater.on('download-progress', p => status('downloading', `Обновление: ${Math.round(p.percent)}%`));
  autoUpdater.on('update-downloaded', () => status('downloaded', 'Обновление готово. Перезапустить?'));
  autoUpdater.on('error', e => status('error', 'Не удалось проверить обновления. Попробуйте позже.', { detail: e.message.slice(0, 200) }));
  if (app.isPackaged && !TEST) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 10000).unref();
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000).unref();
  }
}
app.whenReady().then(async () => {
  campaigns = createCampaignStore(app.getPath('userData'));
  let opened;
  try { opened = campaigns.load(campaigns.index.active, true); }
  catch (error) {
    console.warn('Не удалось открыть активную кампанию:', error.message);
    opened = campaigns.select('main', true);
    dialog.showErrorBox('Кампания недоступна', 'Открыта первая кампания.');
  }
  ({ state, assets, file: store } = opened);
  if (opened.recovered) dialog.showErrorBox('Не удалось прочитать кампанию', 'Сохранена резервная копия файла. Открыта новая кампания.');
  themeStore = path.join(app.getPath('userData'), 'appearance.json');
  zoomStore = path.join(app.getPath('userData'), 'site-zoom.json');
  shortcutStore = path.join(app.getPath('userData'), 'shortcuts.json');
  soundStore = path.join(app.getPath('userData'), 'retro-audio.json');
  if (fs.existsSync(soundStore)) {
    try { soundPreferences = normalizeSoundPreferences(JSON.parse(fs.readFileSync(soundStore, 'utf8'))); }
    catch (error) { console.warn('Не удалось прочитать настройки звука:', error.message); }
  }
  if (fs.existsSync(shortcutStore)) {
    try { shortcuts = restoreShortcuts(JSON.parse(fs.readFileSync(shortcutStore, 'utf8'))); }
    catch (error) { console.warn('Не удалось прочитать горячие клавиши:', error.message); }
  }
  if (fs.existsSync(zoomStore)) {
    try {
      const saved = JSON.parse(fs.readFileSync(zoomStore, 'utf8'));
      siteZoom = new Map(saved.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' &&
        entry[0].length <= 253 && remoteZoomFactors.includes(entry[1])).slice(0, 500));
    } catch (error) { console.warn('Не удалось прочитать масштаб сайтов:', error.message); }
  }
  if (fs.existsSync(themeStore)) {
    try {
      const { theme } = JSON.parse(fs.readFileSync(themeStore, 'utf8'));
      if (typeof theme === 'string' && Object.hasOwn(ScreenThemes, theme)) currentTheme = theme;
    } catch (error) { console.warn('Не удалось прочитать тему оформления:', error.message); }
  }
  app.dock?.setIcon(getThemeImage(currentTheme));
  protocol.handle('dm', async request => {
    const u = new URL(request.url);
    try {
      if (u.hostname !== 'app') return new Response('Forbidden', { status: 403 });
      let file;
      const bundledAssets = ['/assets/demo-map.svg', '/assets/PressStart2P-Regular.ttf', '/assets/welcome-tavern.webp', '/assets/welcome-jingle.wav',
        '/assets/tavern-toolbar.png', '/assets/control-pixels.svg',
        ...Object.keys(ScreenThemes).map(id => '/' + themeIcon(id))];
      if (u.pathname.startsWith('/assets/') && !bundledAssets.includes(u.pathname)) {
        const campaign = u.searchParams.get('campaign');
        if (campaign && campaign !== campaigns.index.active) return new Response('Not found', { status: 404 });
        file = path.join(assets, assetName(decodeURIComponent(u.pathname.slice(8))));
      }
      else {
        const allowed = ['index.html', 'app.js', 'map-geometry.js', 'map-terrain.js', 'styles.css', 'tavern.css', 'themes.js', 'themes.css',
          'ambience.css', 'ambience.js', 'scene.css', 'story.js', 'story.css', 'session.js', 'session.css', 'workspace.css', 'icons.css',
          'shortcuts.js', 'campaign-tools.js', 'campaign-tools.css', 'sound-library.js', 'retro-audio.js', 'sound-tools.js', 'sound-tools.css',
          'dice.js', 'dice.css', 'portal-tools.js', 'token-style.js', 'map-tools.js', 'map-tools.css',
          ...bundledAssets.map(asset => asset.slice(1))];
        const relative = u.pathname.slice(1) || 'index.html';
        if (!allowed.includes(relative)) return new Response('Not found', { status: 404 });
        file = path.join(__dirname, '..', 'ui', relative);
      }
      const result = await audioResponse(file, request) ?? await net.fetch(pathToFileURL(file).href, { headers: request.headers });
      const headers = new Headers(result.headers);
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
      return new Response(result.body, { status: result.status, headers });
    } catch { return new Response('Not found', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_, __, callback) => callback(false));
  for (const id of Object.keys(REMOTE)) {
    const browserSession = session.fromPartition(partitionFor(id));
    browserSession.setPermissionRequestHandler((_, __, cb) => cb(false));
    browserSession.setPermissionCheckHandler(() => false);
    if (id === 'web') browserSession.on('will-download', event => event.preventDefault());
  }
  Menu.setApplicationMenu(mac ? Menu.buildFromTemplate([
    { role: 'appMenu' },
    { label: 'Правка', submenu: ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].map(role => ({ role })) },
    { label: 'Окно', submenu: [{ role: 'minimize' }, { role: 'close' }, { role: 'togglefullscreen' }] },
  ]) : null);
  setupIPC(); setupUpdater();
  mainWindow = secureWindow({
    title: 'Адвентурикон',
    fullscreen: !TEST || process.env.DM_SCREEN_TEST_START_FULLSCREEN === '1'
  });
  for (const [event, active] of [['enter-full-screen', true], ['leave-full-screen', false]]) {
    mainWindow.on(event, () => mainWindow.webContents.send('status', { scope: 'main-fullscreen', active }));
  }
  mainWindow.on('close', () => { quitting = true; for (const w of windows.values()) w.close(); });
  await mainWindow.loadURL('dm://app/index.html');
});
app.on('before-quit', () => { quitting = true; downloadProcess?.stop('Загрузка отменена'); });
app.on('window-all-closed', () => app.quit());
