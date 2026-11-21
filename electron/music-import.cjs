const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const CANCELLED = 'Загрузка отменена';

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  const killer = spawn(exe, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.once('error', () => child.kill());
  killer.once('close', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
}

function beginMusicImport({ assets, tools, source, cached, nodePath, report, save }) {
  const id = randomUUID(), asset = id + '.mp3', prefix = id + '.youtube.';
  const output = path.join(assets, asset);
  let child, inactivity, reason;

  function stop(message = CANCELLED) {
    if (reason) return;
    reason = message;
    clearTimeout(inactivity);
    report('stopping', message);
    if (child) killTree(child);
  }

  function run(exe, args, onLine, timeoutMessage, env = process.env) {
    if (reason) throw new Error(reason);
    const processHandle = spawn(exe, args, { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = processHandle;
    const resetTimer = () => {
      clearTimeout(inactivity);
      inactivity = setTimeout(() => stop(timeoutMessage), 45_000);
    };
    resetTimer();
    const lines = createInterface({ input: processHandle.stdout });
    lines.on('line', line => { if (!reason && onLine(line)) resetTimer(); });
    let errorText = '', startError;
    processHandle.stderr.setEncoding('utf8');
    processHandle.stderr.on('data', data => { errorText = (errorText + data).slice(-3000); });
    return new Promise((resolve, reject) => {
      processHandle.once('error', error => { startError = error; });
      processHandle.once('close', code => {
        clearTimeout(inactivity);
        child = null;
        lines.close();
        if (reason || startError) reject(new Error(reason || 'Не удалось запустить обработку аудио'));
        else resolve({ code, errorText });
      });
    });
  }

  async function download() {
    report('loading', 'Подключение к YouTube…');
    let title, lastBytes = -1;
    const result = await run(path.join(tools, 'yt-dlp.exe'), [
      '--ignore-config', '--no-playlist', '--no-warnings', '--no-simulate',
      '--socket-timeout', '10', '--retries', '2', '--fragment-retries', '2',
      '--extractor-retries', '1', '--concurrent-fragments', '4', '--abort-on-unavailable-fragments',
      '--progress', '--newline', '--color', 'never', '--progress-delta', '0.5',
      '--progress-template', 'download:DM_PROGRESS %(progress.downloaded_bytes)s %(progress._percent_str)s',
      '--max-filesize', '1G', '--js-runtimes', `node:${nodePath}`,
      '-f', 'bestaudio[protocol=https]/bestaudio', '--print', 'after_move:DM_TITLE %(title)j',
      '-o', path.join(assets, prefix + '%(ext)s'), '--', source
    ], line => {
      if (line.startsWith('DM_TITLE ')) {
        try { title = JSON.parse(line.slice(9)); } catch { /* Use a default title. */ }
      }
      const progress = line.match(/^DM_PROGRESS\s+(\d+)\s*(\d+(?:\.\d+)?)?/);
      if (!progress || Number(progress[1]) <= lastBytes) return false;
      lastBytes = Number(progress[1]);
      const percent = progress[2] ? Math.min(100, Math.round(Number(progress[2]))) : null;
      report('loading', percent === null ? `Получено ${(lastBytes / 1024 ** 2).toFixed(1)} МБ` : `Загружено ${percent}%`, percent);
      return true;
    }, 'YouTube перестал передавать данные. Попробуйте ещё раз или добавьте аудиофайл.',
    { ...process.env, PYTHONIOENCODING: 'utf-8', ELECTRON_RUN_AS_NODE: '1' });
    if (result.code !== 0) {
      throw new Error(/ssl|timed out|connection|network/i.test(result.errorText)
        ? 'Соединение с YouTube прервалось. Попробуйте ещё раз или добавьте аудиофайл.'
        : 'YouTube не отдал аудио для этого видео. Попробуйте другую ссылку.');
    }
    const file = (await fs.readdir(assets)).find(name => name.startsWith(prefix) && /\.(m4a|webm|mp3|ogg|mp4|opus|aac)$/.test(name));
    if (!file) throw new Error('YouTube не передал поддерживаемый аудиофайл');
    return { file, title };
  }

  const done = (async () => {
    let saved = false;
    try {
      const { file, title } = cached ? { file: cached.asset, title: cached.title } : await download();
      if (reason) throw new Error(reason);
      if (file.endsWith('.mp3')) {
        await fs.rename(path.join(assets, file), output);
      } else {
        report('loading', 'Конвертация в MP3…');
        const result = await run(path.join(tools, 'ffmpeg', 'ffmpeg.exe'), [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1',
          '-protocol_whitelist', 'file', '-i', path.join(assets, file),
          '-map', '0:a:0', '-c:a', 'libmp3lame', '-q:a', '3', '-n', output
        ], line => line.startsWith('out_time_us='), 'Конвертер перестал отвечать. Попробуйте ещё раз.');
        if (result.code !== 0) throw new Error('Не удалось преобразовать аудио в MP3');
      }
      if (reason) throw new Error(reason);
      if (!(await fs.stat(output)).size) throw new Error('Конвертер создал пустой MP3');
      if (reason) throw new Error(reason);
      save({ asset, title, previousAsset: cached?.asset });
      saved = true;
      report('done', 'MP3 добавлен в папку');
      return { ok: true };
    } catch (error) {
      const canceled = reason === CANCELLED;
      report(canceled ? 'idle' : 'error', error.message);
      return canceled ? { canceled: true } : { ok: false, error: error.message };
    } finally {
      const files = await fs.readdir(assets).catch(() => []);
      await Promise.all(files.filter(file => file.startsWith(prefix) || (!saved && file === asset))
        .map(file => fs.unlink(path.join(assets, file)).catch(() => {})));
    }
  })();
  return { stop, done };
}

module.exports = { beginMusicImport };
