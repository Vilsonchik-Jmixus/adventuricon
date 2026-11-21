const { app, BrowserWindow, WebContentsView, ipcMain, protocol, net, dialog, clipboard, session, shell, screen, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { initialState, reducer } = require('./model.cjs');
const { autoUpdater } = require('electron-updater');
const TEST = process.env.DM_SCREEN_TEST === '1';
if (process.env.DM_SCREEN_DATA) app.setPath('userData', process.env.DM_SCREEN_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'dm', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
const PANELS = ['combat', 'music', 'map', 'info', 'characters'];
const REMOTE = { info: 'https://dnd.su/', characters: 'https://longstoryshort.app/characters/list/' };
const windows = new Map(), remotes = new Map();
let mainWindow, state, store, assets, quitting = false, downloadProcess = null;
let updateStatus = { scope: 'update', phase: 'idle', text: 'Обновления' };
let musicStatus = { scope: 'music', phase: 'idle', text: '' };
function localSender(event) {
  const url = event.senderFrame?.url || '';
  if (!url.startsWith('dm://app/') || !BrowserWindow.fromWebContents(event.sender)) throw new Error('Недопустимый источник');
}
function sendAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && w.webContents.getURL().startsWith('dm://app/')) w.webContents.send(channel, payload);
}
function broadcast() { sendAll('state', { state, detached: [...windows.keys()] }); }
function commit(action) {
  const next = reducer(state, action);
  fs.writeFileSync(`${store}.tmp`, JSON.stringify(next), 'utf8');
  fs.renameSync(`${store}.tmp`, store);
  state = next; broadcast(); return { ok: true };
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
function boundsOnScreen(bounds, defaults) {
  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return defaults;
  const displays = screen.getAllDisplays();
  const visible = displays.some(d => bounds.x + bounds.width > d.workArea.x + 80 && bounds.x < d.workArea.x + d.workArea.width - 80 && bounds.y + bounds.height > d.workArea.y + 80 && bounds.y < d.workArea.y + d.workArea.height - 80);
  if (!visible) return defaults;
  return { x: bounds.x, y: bounds.y, width: Math.max(360, Math.min(bounds.width, 7680)), height: Math.max(300, Math.min(bounds.height, 4320)) };
}
function secureWindow(options = {}) {
  const w = new BrowserWindow({ width: 1500, height: 950, minWidth: 940, minHeight: 640, backgroundColor: '#221711', show: false, icon: path.join(__dirname, '..', 'ui', 'assets', 'icon.ico'), ...options,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('dm://app/')) e.preventDefault(); });
  w.once('ready-to-show', () => { if (!TEST) w.show(); });
  return w;
}
function attachRemote(id, owner) {
  let record = remotes.get(id);
  if (!record) {
    const view = new WebContentsView({ webPreferences: { partition: `persist:dm-${id}`, nodeIntegration: false, contextIsolation: true, sandbox: true } });
    record = { view, owner: null };
    remotes.set(id, record);
    view.webContents.setWindowOpenHandler(({ url }) => {
      // Authentication popups share only this site's browser session, without app APIs.
      if (!/^https:\/\//.test(url)) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: { width: 850, height: 720, autoHideMenuBar: true, webPreferences: { partition: `persist:dm-${id}`, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    });
    view.webContents.on('will-navigate', (e, url) => { if (!/^https?:\/\//.test(url)) e.preventDefault(); });
    view.webContents.on('did-fail-load', (_, code, message, url, isMainFrame) => {
      if (isMainFrame && code !== -3) sendAll('status', { scope: id, text: `Не удалось открыть сайт: ${message}. Нажмите ↻ для повтора.` });
    });
    view.webContents.loadURL(REMOTE[id]).catch(() => {});
  }
  if (record.owner !== owner) {
    if (record.owner && !record.owner.isDestroyed()) record.owner.contentView.removeChildView(record.view);
    owner.contentView.addChildView(record.view); record.owner = owner;
  }
  return record.view;
}
function detach(id) {
  if (!PANELS.includes(id)) throw new Error('Неизвестная панель');
  if (windows.has(id)) { windows.get(id).show(); windows.get(id).focus(); return { ok: true }; }
  const bounds = boundsOnScreen(state.layout.windows[id], { width: id === 'map' ? 1000 : 650, height: 750 });
  const w = secureWindow({ ...bounds, minWidth: 360, minHeight: 300, title: 'Ширма · ' + id, autoHideMenuBar: true });
  windows.set(id, w);
  w.loadURL(`dm://app/index.html?panel=${id}`);
  let timer;
  const saveBounds = () => { clearTimeout(timer); timer = setTimeout(() => { if (!w.isDestroyed() && !quitting) commit({ type: 'layout:window', payload: { id, bounds: w.getNormalBounds() } }); }, 300); };
  w.on('move', saveBounds); w.on('resize', saveBounds);
  w.on('close', () => {
    clearTimeout(timer);
    if (!quitting) commit({ type: 'layout:window', payload: { id, bounds: w.getNormalBounds() } });
    const remote = remotes.get(id);
    if (remote?.owner === w && mainWindow && !mainWindow.isDestroyed()) {
      w.contentView.removeChildView(remote.view); mainWindow.contentView.addChildView(remote.view); remote.owner = mainWindow; remote.view.setVisible(false);
    }
  });
  w.on('closed', () => { windows.delete(id); if (!quitting) broadcast(); });
  broadcast(); return { ok: true };
}
function setupIPC() {
  handle('init', () => ({ state, detached: [...windows.keys()], version: app.getVersion(), updateStatus, musicStatus, test: TEST }));
  handle('dispatch', (_, action) => {
    if (!action || typeof action.type !== 'string' || JSON.stringify(action).length > 10000) throw new Error('Неверная команда');
    if (['map:image', 'combatant:add', 'combatant:edit'].includes(action.type) && action.payload?.image) assetName(action.payload.image);
    if (action.type === 'music:add') assetName(action.payload?.asset);
    return commit(action);
  });
  handle('import-file', async (event, { kind }) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { properties: ['openFile'], filters: [{ name: kind === 'audio' ? 'Музыка' : 'Изображения', extensions: kind === 'audio' ? ['mp3', 'wav', 'ogg', 'm4a', 'webm', 'flac'] : ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
    return result.canceled ? { canceled: true } : importAsset(result.filePaths[0], kind);
  });
  handle('import-drop', (_, { path: file, kind }) => importAsset(file, kind));
  handle('paste-image', async () => {
    const items = await clipboard.read();
    for (const item of items) {
      const type = item.types.find(t => ['image/png', 'image/jpeg', 'image/webp'].includes(t));
      if (type) {
        const bytes = Buffer.from(await (await item.getType(type)).arrayBuffer());
        if (bytes.length > 40 * 1024 * 1024) throw new Error('Изображение больше 40 МБ');
        const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[type];
        const asset = randomUUID() + ext; fs.writeFileSync(path.join(assets, asset), bytes); return { ok: true, asset };
      }
      // Windows Explorer puts a copied image file's path in FileNameW.
      const fileType = item.types.find(t => t.includes('osclipboard') && t.includes('FileNameW'));
      if (fileType) {
        const bytes = Buffer.from(await (await item.getType(fileType)).arrayBuffer());
        const file = bytes.toString('utf16le').split('\0')[0];
        if (path.isAbsolute(file)) return importAsset(file, 'image');
      }
    }
    throw new Error('В буфере обмена нет изображения');
  });
  handle('detach', (_, id) => detach(id));
  handle('show-token', (_, id) => {
    if (!state.tokens.some(token => token.combatantId === id)) return { ok: false, error: 'Жетон уже убран с карты' };
    const mapWindow = windows.get('map');
    if (mapWindow) {
      mapWindow.show();
      mapWindow.focus();
    }
    sendAll('status', { scope: 'map-focus', id });
    return { ok: true };
  });
  handle('dock', event => { const w = BrowserWindow.fromWebContents(event.sender); if (w !== mainWindow) w.close(); return { ok: true }; });
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
      localSender(event); if ((TEST && process.env.DM_SCREEN_REMOTE_TEST !== '1') || !REMOTE[id]) return;
      const owner = BrowserWindow.fromWebContents(event.sender);
      if ((windows.get(id) || mainWindow) !== owner) return;
      const view = attachRemote(id, owner);
      if (!bounds || bounds.width < 5 || bounds.height < 5) { view.setVisible(false); return; }
      const [maxW, maxH] = owner.getContentSize();
      const x = Math.max(0, Math.round(bounds.x)), y = Math.max(0, Math.round(bounds.y));
      view.setBounds({ x, y, width: Math.max(1, Math.min(maxW - x, Math.round(bounds.width))), height: Math.max(1, Math.min(maxH - y, Math.round(bounds.height))) }); view.setVisible(true);
    } catch { /* Window may close during a resize. */ }
  });
  handle('remote-action', async (_, { id, action }) => {
    if (!REMOTE[id]) throw new Error('Неизвестный сайт');
    const wc = remotes.get(id)?.view.webContents;
    if (action === 'external') await shell.openExternal(wc?.getURL() || REMOTE[id]);
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
function downloadMusic({ url, folder }) {
  const videoId = youtubeVideoId(url);
  if (!videoId) throw new Error('Вставьте HTTPS-ссылку на отдельное видео YouTube');
  if (downloadProcess) throw new Error('Дождитесь завершения текущей загрузки');
  const source = `https://www.youtube.com/watch?v=${videoId}`;
  const cached = state.music.tracks.find(track => youtubeVideoId(track.source) === videoId &&
    fs.existsSync(path.join(assets, assetName(track.asset))));
  if (cached) {
    if (!state.music.tracks.some(track => track.asset === cached.asset && track.folder === folder)) {
      commit({ type: 'music:add', payload: { ...cached, source, folder } });
    }
    reportMusic('done', 'Трек уже сохранён на компьютере');
    return { ok: true };
  }
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'media', 'yt-dlp.exe') : path.join(__dirname, '..', '.tools', 'media', 'yt-dlp.exe');
  if (!fs.existsSync(executable)) throw new Error('Загрузчик не найден. Выполните npm run tools и пересоберите программу.');
  const id = randomUUID();
  reportMusic('loading', 'Подключение к YouTube…');
  const child = spawn(executable, [
    '--ignore-config', '--no-playlist', '--no-warnings', '--no-simulate',
    '--socket-timeout', '10', '--retries', '2', '--fragment-retries', '2',
    '--extractor-retries', '1', '--concurrent-fragments', '4', '--abort-on-unavailable-fragments',
    '--progress', '--newline', '--color', 'never', '--progress-delta', '0.5',
    '--progress-template', 'download:DM_PROGRESS %(progress.downloaded_bytes)s %(progress._percent_str)s',
    '--max-filesize', '1G', '--js-runtimes', `node:${process.execPath}`,
    '-f', 'bestaudio[ext=m4a]/bestaudio', '--print', 'after_move:DM_TITLE %(title)j',
    '-o', path.join(assets, `${id}.%(ext)s`), '--', source
  ], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ELECTRON_RUN_AS_NODE: '1' } });
  let title, reason, inactivity, downloaded = -1;
  const stop = message => {
    if (reason) return;
    reason = message;
    clearTimeout(inactivity);
    reportMusic('stopping', message);
    // The packaged Windows loader spawns a child. Kill the entire job.
    if (child.pid && process.platform === 'win32') {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', () => child.kill());
      killer.once('close', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
    } else child.kill();
  };
  downloadProcess = { stop };
  const refreshTimeout = () => {
    clearTimeout(inactivity);
    inactivity = setTimeout(() => stop('YouTube перестал передавать данные. Попробуйте ещё раз или добавьте аудиофайл.'), 45_000);
  };
  refreshTimeout();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (reason) return;
    const progress = line.match(/^DM_PROGRESS\s+(\d+)\s*(\d+(?:\.\d+)?)?/);
    if (progress && Number(progress[1]) > downloaded) {
      downloaded = Number(progress[1]);
      refreshTimeout();
      const percent = progress[2] ? Math.min(100, Math.round(Number(progress[2]))) : null;
      const mb = (downloaded / 1024 ** 2).toFixed(1);
      reportMusic('loading', percent === null ? `Получено ${mb} МБ` : `Загружено ${percent}%`, percent);
    }
    if (line.startsWith('DM_TITLE ')) {
      try { title = JSON.parse(line.slice(9)); } catch { /* Fall back to the video ID. */ }
    }
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-3000); });
  return new Promise(resolve => {
    child.once('error', e => { reason ||= `Не удалось запустить загрузчик: ${e.message}`; });
    child.once('close', code => {
      clearTimeout(inactivity);
      lines.close();
      downloadProcess = null;
      let files = [];
      try {
        files = fs.readdirSync(assets).filter(file => file.startsWith(id + '.'));
        if (reason) throw new Error(reason);
        if (code !== 0) throw new Error(/ssl|timed out|connection|network/i.test(stderr)
          ? 'Соединение с YouTube прервалось. Попробуйте ещё раз или добавьте аудиофайл.'
          : 'YouTube не отдал аудио для этого видео. Попробуйте другую ссылку.');
        const asset = files.find(file => /\.(m4a|webm|mp3|ogg|mp4)$/.test(file));
        if (!asset) throw new Error('YouTube не передал поддерживаемый аудиофайл');
        commit({ type: 'music:add', payload: { title: title || videoId, asset, folder, source } });
        reportMusic('done', 'Трек сохранён для прослушивания без интернета');
        resolve({ ok: true });
      } catch (e) {
        for (const file of files) {
          try { fs.unlinkSync(path.join(assets, file)); } catch { /* A file may already be gone. */ }
        }
        const canceled = reason === 'Загрузка отменена';
        reportMusic(canceled ? 'idle' : 'error', e.message);
        resolve(canceled ? { canceled: true } : { ok: false, error: e.message });
      }
    });
  });
}
function setupUpdater() {
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
      if (saved.schema !== 1 || !Array.isArray(saved.combatants) || !Array.isArray(saved.tokens) || !saved.map || !saved.music || !saved.layout) throw new Error('Неверный формат');
      state = saved; state.music.playing = false;
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
      if (u.pathname.startsWith('/assets/') && !['/assets/demo-map.svg', '/assets/PressStart2P-Regular.ttf'].includes(u.pathname)) file = path.join(assets, assetName(decodeURIComponent(u.pathname.slice(8))));
      else {
        const allowed = ['index.html', 'app.js', 'styles.css', 'tavern.css', 'tavern-art.js', 'assets/demo-map.svg', 'assets/PressStart2P-Regular.ttf'];
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
  for (const id of Object.keys(REMOTE)) session.fromPartition(`persist:dm-${id}`).setPermissionRequestHandler((_, __, cb) => cb(false));
  Menu.setApplicationMenu(null);
  setupIPC(); setupUpdater();
  mainWindow = secureWindow({ title: 'Интерактивная ширма мастера' });
  mainWindow.on('close', () => { quitting = true; for (const w of windows.values()) w.close(); });
  await mainWindow.loadURL('dm://app/index.html');
});
app.on('before-quit', () => { quitting = true; downloadProcess?.stop('Загрузка отменена'); });
app.on('window-all-closed', () => app.quit());
