const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, dialog, clipboard, session, shell, screen, Menu, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { beginMusicImport, mediaTools } = require('./music-import.cjs');
const { initialState, migrateState, activeView, reducer, canMoveToken } = require('./model.cjs');
const { readCharacter } = require('./lss-import.cjs');
const { publicDndUrl, readPublicResponse } = require('./dnd-import.cjs');
const { ROLES, CONDITIONS, playerMapActors } = require('./combat-rules.cjs');
const { DND_HOME, WEB_HOME, GEMINI, REFERENCE_LINKS, safeUrl, searchUrl } = require('./reference.cjs');
const { autoUpdater } = require('electron-updater');
const TEST = process.env.DM_SCREEN_TEST === '1';
const mac = process.platform === 'darwin';
const appImage = process.platform === 'linux' && !!process.env.APPIMAGE;
const canAutoUpdate = process.platform === 'win32' || appImage;
const releasesUrl = 'https://github.com/Vilsonchik-Jmixus/interactive-dm-screen/releases/latest';
if (appImage) app.commandLine.appendSwitch('disable-setuid-sandbox');
if (process.env.DM_SCREEN_DATA) app.setPath('userData', process.env.DM_SCREEN_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'dm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const PANELS = ['combat', 'music', 'map', 'info', 'characters'];
const REMOTE = { info: DND_HOME, web: WEB_HOME, characters: 'https://longstoryshort.app/characters/list/' };
const partitionFor = id => id === 'web' ? 'dm-web' : `persist:dm-${id}`;
const remotePanelFor = id => id === 'web' ? 'info' : id;
let referenceTab = 'info';
const windows = new Map(), remotes = new Map();
let mainWindow, state, store, assets, quitting = false, downloadProcess = null;
let updateStatus = app.isPackaged && !canAutoUpdate
  ? { scope: 'update', phase: 'releases', text: 'Версии на GitHub ↗' }
  : { scope: 'update', phase: 'idle', text: 'Обновления' };
let musicStatus = { scope: 'music', phase: 'idle', text: '' };
const mapCameras = new Map();
let playerBlackout = false;
let presentation = null;
let recentImages = [];
function localSender(event) {
  const url = event.senderFrame?.url || '';
  if (!url.startsWith('dm://app/') || !BrowserWindow.fromWebContents(event.sender)) throw new Error('Недопустимый источник');
}
function sendAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL().startsWith('dm://app/')) w.webContents.send(channel, payload);
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
  if (owner === windows.get('map')?.webContents) {
    return {
      state: { activeMapId: view.activeMapId, map: view.map, tokens: view.tokens,
        mapCombatants: playerMapActors(view.mapCombatants, view.map.playerHealth !== false),
        visionOrigins: view.mapCombatants.filter(actor => actor.role === 'player' && actor.hp > 0).map(actor => actor.id),
        terrain: view.terrain, fog: view.fog, turn: view.turn },
      detached: ['map'], presentation, recentImages: [], mapCamera
    };
  }
  return {
    state: view, detached: [...windows.keys()], presentation,
    recentImages: recentImages.map(resolveImage).filter(Boolean), mapCamera
  };
}
function broadcast() {
  const view = activeView(state);
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.webContents.getURL().startsWith('dm://app/')) {
      w.webContents.send('state', windowState(w.webContents, view));
    }
  }
}
function commit(action) {
  const next = reducer(state, action);
  fs.writeFileSync(`${store}.tmp`, JSON.stringify(next), 'utf8');
  fs.renameSync(`${store}.tmp`, store);
  state = next;
  if (action.type === 'map:remove') mapCameras.delete(action.payload.id);
  if (action.type === 'map:settings' && 'rotation' in action.payload) mapCameras.delete(state.activeMapId);
  broadcast();
  return { ok: true };
}
function handle(name, fn) {
  ipcMain.handle(name, async (event, payload) => {
    localSender(event);
    try { return await fn(event, payload); }
    catch (err) { return { ok: false, error: String(err.message || err).slice(0, 400) }; }
  });
}
function assetName(value) {
  if (typeof value !== 'string' || !/^[a-f0-9-]+\.(png|jpg|jpeg|webp|gif|mp3|wav|ogg|m4a|mp4|webm|flac)$/i.test(value)) throw new Error('Неверное имя файла');
  return value;
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
  const icon = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const w = new BrowserWindow({ width: 1500, height: 950, minWidth: 940, minHeight: 640, backgroundColor: '#221711', show: false, icon: path.join(__dirname, '..', 'ui', 'assets', icon), ...options,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('dm://app/')) e.preventDefault(); });
  w.once('ready-to-show', () => {
    if (TEST) return;
    if (showInactive) w.showInactive();
    else w.show();
  });
  return w;
}
function attachRemote(id, owner) {
  let record = remotes.get(id);
  if (!record) {
    const view = new WebContentsView({ webPreferences: { partition: partitionFor(id), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    view.setVisible(false);
    record = { view, owner: null, requested: REMOTE[id], failed: false };
    remotes.set(id, record);
    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url, disposition }) => {
      const destination = safeUrl(url);
      if (!destination) return { action: 'deny' };
      if (id !== 'characters') {
        if (['foreground-tab', 'background-tab'].includes(disposition)) {
          setImmediate(() => { if (!wc.isDestroyed()) loadRemote(record, destination); });
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
      wc.on('did-navigate', () => { record.failed = false; reportReference(); });
      for (const event of ['did-finish-load', 'did-navigate-in-page', 'page-title-updated', 'did-stop-loading']) {
        wc.on(event, reportReference);
      }
    }
    loadRemote(record, REMOTE[id]);
  }
  if (record.owner !== owner) {
    if (record.owner && !record.owner.isDestroyed()) record.owner.contentView.removeChildView(record.view);
    owner.contentView.addChildView(record.view); record.owner = owner;
  }
  return record.view;
}
function loadRemote(record, url) {
  record.failed = false;
  record.requested = url;
  return record.view.webContents.loadURL(url).catch(() => {});
}
function referenceState() {
  const pages = {};
  for (const tab of ['info', 'web']) {
    const record = remotes.get(tab);
    const wc = record?.view.webContents;
    const loaded = wc && !wc.isDestroyed() ? safeUrl(wc.getURL()) : null;
    pages[tab] = {
      url: record?.failed ? record.requested : loaded || record?.requested || REMOTE[tab],
      title: loaded && !record.failed ? wc.getTitle() : '',
      bookmarkable: !!loaded && !record.failed && !wc.isLoadingMainFrame(),
      failed: !!record?.failed,
      canBack: wc?.navigationHistory.canGoBack() ?? false,
      canForward: wc?.navigationHistory.canGoForward() ?? false
    };
  }
  return { tab: referenceTab, pages };
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
  let tab = referenceTab, destination = null;
  if (action === 'tab' && ['info', 'web'].includes(value)) tab = value;
  else if (action === 'shortcut') {
    tab = 'info';
    destination = REFERENCE_LINKS.find(link => link.id === value)?.url;
    if (!destination) throw new Error('Раздел не найден');
  } else if (action === 'search') {
    destination = searchUrl(value, tab === 'info');
    tab = 'web';
  } else if (action === 'bookmark') {
    const item = state.bookmarks.find(entry => entry.id === value);
    destination = safeUrl(item?.url);
    if (!destination) throw new Error('Закладка не найдена');
    tab = item.tab === 'info' ? 'info' : 'web';
  } else if (!['back', 'forward', 'reload', 'external', 'save-bookmark', 'home'].includes(action)) {
    throw new Error('Неизвестная команда справочника');
  }
  referenceTab = tab;
  const wc = attachRemote(tab, owner).webContents;
  const record = remotes.get(tab);
  reportReference();
  if (destination) await loadRemote(record, destination);
  else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  else if (action === 'reload') await loadRemote(record, record.failed ? record.requested : safeUrl(wc.getURL()) || record.requested);
  else if (action === 'home') await loadRemote(record, REMOTE[tab]);
  else if (action === 'external') {
    const address = safeUrl(referenceState().pages[tab].url);
    if (address) await shell.openExternal(address);
  } else if (action === 'save-bookmark') {
    const page = referenceState().pages[tab];
    if (!page.bookmarkable) throw new Error('Дождись, пока страница загрузится');
    return commit({ type: 'bookmark:add', payload: { url: page.url, title: page.title, tab } });
  }
  return { ok: true };
}
function detach(id, focus = true) {
  if (!PANELS.includes(id)) throw new Error('Неизвестная панель');
  if (windows.has(id)) {
    const window = windows.get(id);
    if (focus && !TEST) { window.show(); window.focus(); }
    return { ok: true };
  }
  const defaults = { width: id === 'map' ? 1000 : 650, height: 750 };
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
  w.loadURL(`dm://app/index.html?panel=${id}`);
  let timer;
  const saveBounds = () => { clearTimeout(timer); timer = setTimeout(() => { if (!w.isDestroyed() && !quitting) commit({ type: 'layout:window', payload: { id, bounds: w.getNormalBounds() } }); }, 300); };
  w.on('move', saveBounds); w.on('resize', saveBounds);
  w.on('close', () => {
    clearTimeout(timer);
    if (!quitting) commit({ type: 'layout:window', payload: { id, bounds: w.getNormalBounds() } });
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
    w.on('enter-full-screen', () => w.webContents.send('status', { scope: 'player-fullscreen', active: true }));
    w.on('leave-full-screen', () => w.webContents.send('status', { scope: 'player-fullscreen', active: false }));
  }
  broadcast(); return { ok: true };
}
function setupIPC() {
  handle('init', event => ({ ...windowState(event.sender), version: app.getVersion(), updateStatus, musicStatus,
    playerBlackout, conditionDefinitions: CONDITIONS, combatRoles: ROLES, referenceLinks: REFERENCE_LINKS,
    reference: referenceState(), test: TEST, mac, welcomeAtStart: !TEST || process.env.DM_SCREEN_WELCOME_TEST === '1' }));
  handle('dispatch', (event, action) => {
    if (event.sender === windows.get('map')?.webContents) throw new Error('Экраном управляет мастер');
    if (!action || typeof action.type !== 'string' || JSON.stringify(action).length > 10000) throw new Error('Неверная команда');
    if (['map:image', 'combatant:add', 'combatant:edit', 'library:save', 'terrain:add', 'terrain:edit-item'].includes(action.type) && action.payload?.image) assetName(action.payload.image);
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
  handle('import-file', async (event, { kind }) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openFile'], filters: [{ name: kind === 'audio' ? 'Музыка' : 'Изображения', extensions: kind === 'audio' ? ['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac'] : ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
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
    const bytes = await readPublicResponse(net, source, 5 * 1024 * 1024);
    const icon = nativeImage.createFromBuffer(bytes);
    if (icon.isEmpty()) return { ok: true };
    return pasteImageBytes(icon.resize({ width: Math.min(384, icon.getSize().width) }).toPNG(), '.png');
  });
  handle('import-lss', async (event, { file, expectedBattleId }) => {
    if (event.sender === windows.get('map')?.webContents) throw new Error('Экраном управляет мастер');
    if (!file) {
      const chosen = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
        properties: ['openFile'], filters: [{ name: 'Лист Long Story Short', extensions: ['json'] }],
      });
      if (chosen.canceled) return { canceled: true };
      [file] = chosen.filePaths;
    }
    if (state.activeBattleId !== expectedBattleId) throw new Error('Бой переключился. Повтори импорт.');
    if (path.extname(file).toLowerCase() !== '.json' || fs.statSync(file).size > 12 * 1024 * 1024) {
      throw new Error('Выбери JSON-файл Long Story Short размером до 12 МБ');
    }
    const { portrait, initiativeNeedsReview, ...actor } = readCharacter(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const image = portrait && nativeImage.createFromBuffer(portrait);
    if (image && !image.isEmpty()) actor.image = pasteImageBytes(image.resize({ width: 384 }).toPNG(), '.png').asset;
    return { ...commit({ type: 'combatant:import', payload: { ...actor, expectedBattleId } }), initiativeNeedsReview };
  });
  handle('paste-image', async () => {
    const items = await clipboard.read().catch(() => []);
    for (const item of items) {
      const type = item.types.find(t => ['image/png', 'image/jpeg', 'image/webp'].includes(t));
      if (type) {
        const bytes = Buffer.from(await (await item.getType(type)).arrayBuffer());
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type];
        return pasteImageBytes(bytes, ext);
      }
      // Windows Explorer puts a copied image file's path in FileNameW.
      const fileType = item.types.find(t => t.includes('osclipboard') && t.includes('FileNameW'));
      if (fileType) {
        const bytes = Buffer.from(await (await item.getType(fileType)).arrayBuffer());
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
  ipcMain.on('mirror-map', (event, preview) => {
    if (event.sender !== mainWindow?.webContents || !preview) return;
    if (preview.mapId !== state.activeMapId) return;
    const camera = preview.camera;
    if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.y)) mapCameras.set(state.activeMapId, camera);
    if (typeof preview.blackout === 'boolean') playerBlackout = preview.blackout;
    const ping = preview.ping;
    const mirror = windows.get('map');
    if (!mirror || mirror.isDestroyed()) return;
    const token = preview.token;
    const board = state.boards.find(item => item.id === state.activeMapId);
    const original = token && board.tokens.find(item => item.combatantId === token.id);
    const valid = original && [token.col, token.row].every(n => Number.isInteger(n) && n >= 0 && n <= 2000) &&
      canMoveToken(board, original, token.col, token.row);
    mirror.webContents.send('status', {
      scope: 'map-preview', mapId: state.activeMapId, camera: mapCameras.get(state.activeMapId) ?? null,
      blackout: playerBlackout,
      ...(ping && Number.isFinite(ping.x) && Number.isFinite(ping.y) ? { ping } : {}),
      ...(Object.hasOwn(preview, 'token') ? { token: valid ? token : null } : {})
    });
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
      localSender(event); if ((TEST && process.env.DM_SCREEN_REMOTE_TEST !== '1') || !Object.hasOwn(REMOTE, id)) return;
      const owner = BrowserWindow.fromWebContents(event.sender);
      if ((windows.get(remotePanelFor(id)) || mainWindow) !== owner) return;
      if (!bounds && !remotes.has(id)) return;
      const view = attachRemote(id, owner);
      if (!bounds || remotes.get(id).failed || bounds.width < 5 || bounds.height < 5) { view.setVisible(false); return; }
      const [maxW, maxH] = owner.getContentSize();
      const x = Math.max(0, Math.round(bounds.x)), y = Math.max(0, Math.round(bounds.y));
      view.setBounds({ x, y, width: Math.max(1, Math.min(maxW - x, Math.round(bounds.width))), height: Math.max(1, Math.min(maxH - y, Math.round(bounds.height))) }); view.setVisible(true);
    } catch { /* Window may close during a resize. */ }
  });
  handle('reference-action', referenceAction);
  handle('remote-action', async (_, { id, action }) => {
    if (!Object.hasOwn(REMOTE, id)) throw new Error('Неизвестный сайт');
    const wc = remotes.get(id)?.view.webContents;
    if (action === 'external') await shell.openExternal(safeUrl(wc?.getURL()) || REMOTE[id]);
    else if (wc && action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (wc && action === 'reload') wc.reload();
    else if (wc && action === 'home') await wc.loadURL(REMOTE[id]);
    return { ok: true };
  });
  handle('download-music', (_, p) => downloadMusic(p));
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
function youtubeVideoId(value) {
  let url;
  try { url = new URL(value); }
  catch { return null; }
  const hosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname)) return null;
  const id = url.hostname === 'youtu.be' ? url.pathname.slice(1)
    : url.pathname === '/watch' ? url.searchParams.get('v')
    : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)\/?$/)?.[1];
  return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
}
function reportMusic(phase, text, percent = null) {
  musicStatus = { scope: 'music', phase, text, percent };
  sendAll('status', musicStatus);
}
async function downloadMusic({ url, folder }) {
  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error('Вставьте HTTPS-ссылку на отдельное видео YouTube');
  if (downloadProcess) throw new Error('Дождитесь завершения текущей загрузки');
  if (!state.music.folders.includes(folder)) folder = 'Общее';
  const source = 'https://www.youtube.com/watch?v=' + videoId;
  const available = state.music.tracks.filter(track => youtubeVideoId(track.source) === videoId &&
    fs.existsSync(path.join(assets, assetName(track.asset))));
  const mp3 = available.find(track => track.asset.endsWith('.mp3'));
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
  assets = path.join(app.getPath('userData'), 'assets'); fs.mkdirSync(assets, { recursive: true });
  store = path.join(app.getPath('userData'), 'campaign.json');
  state = initialState();
  if (fs.existsSync(store)) {
    try {
      const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
      state = migrateState(saved);
      if (saved.schema === 1) {
        try { fs.copyFileSync(store, store + '.v1.bak', fs.constants.COPYFILE_EXCL); }
        catch (error) { if (error.code !== 'EEXIST') console.warn('Не удалось сохранить копию предыдущего формата:', error.message); }
      }
      state.music.playing = false;
    } catch {
      fs.copyFileSync(store, store + `.backup-${Date.now()}`);
      dialog.showErrorBox('Не удалось прочитать кампанию', 'Сохранена резервная копия файла. Открыта новая кампания.');
    }
  }
  protocol.handle('dm', async request => {
    const u = new URL(request.url);
    try {
      if (u.hostname !== 'app') return new Response('Forbidden', { status: 403 });
      let file;
      const bundledAssets = ['/assets/demo-map.svg', '/assets/PressStart2P-Regular.ttf', '/assets/welcome-tavern.webp', '/assets/welcome-jingle.wav'];
      if (u.pathname.startsWith('/assets/') && !bundledAssets.includes(u.pathname)) file = path.join(assets, assetName(decodeURIComponent(u.pathname.slice(8))));
      else {
        const allowed = ['index.html', 'app.js', 'map-geometry.js', 'map-terrain.js', 'styles.css', 'tavern.css', 'tavern-art.js', 'ambience.css', 'ambience.js', 'scene.css', ...bundledAssets.map(asset => asset.slice(1))];
        const relative = u.pathname.slice(1) || 'index.html';
        if (!allowed.includes(relative)) return new Response('Not found', { status: 404 });
        file = path.join(__dirname, '..', 'ui', relative);
      }
      const result = await net.fetch(pathToFileURL(file).href, { headers: request.headers });
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
  mainWindow = secureWindow({ title: 'Интерактивная ширма мастера' });
  mainWindow.on('close', () => { quitting = true; for (const w of windows.values()) w.close(); });
  await mainWindow.loadURL('dm://app/index.html');
});
app.on('before-quit', () => { quitting = true; downloadProcess?.stop('Загрузка отменена'); });
app.on('window-all-closed', () => app.quit());
