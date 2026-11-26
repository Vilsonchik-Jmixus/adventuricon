const fs = require('node:fs/promises');
const { constants, accessSync } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

const CANCELLED = 'Загрузка отменена';
const windows = process.platform === 'win32';
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
const streamRejected = /\b(?:403|404|410)\b|requested format is not available|no video formats found|no audio formats|(?:signature|challenge) solving failed/i;

function youtubeVideoId(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  let url;
  try { url = new URL(input.includes('://') ? input : 'https://' + input); }
  catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol) || !youtubeHosts.has(url.hostname) ||
      url.username || url.password || url.port) return null;
  const pathname = url.pathname.replace(/\/$/, '');
  const id = url.hostname.endsWith('youtu.be') ? pathname.slice(1)
    : pathname === '/watch' ? url.searchParams.get('v')
    : pathname.match(/^\/(?:shorts|live|embed|v)\/([^/]+)$/)?.[1];
  return /^[a-zA-Z0-9_-]{11}$/.test(id || '') ? id : null;
}

function downloadError(detail) {
  if (/sign in|login required|private video|members.only|age.restrict/i.test(detail)) {
    return 'YouTube требует входа или ограничивает доступ к ролику. Добавьте его как аудиофайл.';
  }
  if (/not available in your country|geo.restrict/i.test(detail)) {
    return 'Этот ролик недоступен в вашем регионе. Выберите другой ролик или добавьте аудиофайл.';
  }
  if (/not currently live|will begin|premieres in|live event|is live/i.test(detail)) {
    return 'Эфир пока недоступен для импорта. Добавьте ссылку на запись после его завершения.';
  }
  if (/too large|larger than max|larger than .*max-filesize/i.test(detail)) return 'Аудиофайл больше 1 ГБ.';
  if (/ssl|timed out|connection|network|resolve host|http error 429/i.test(detail)) {
    return 'Связь с YouTube прервалась или сервис ограничил запросы. Попробуйте позже или добавьте аудиофайл.';
  }
  if (streamRejected.test(detail)) return 'YouTube не разрешил загрузить доступные потоки. Попробуйте другую ссылку или добавьте аудиофайл.';
  return 'YouTube не отдал аудио для этого видео. Проверьте, что ролик открывается, или добавьте аудиофайл.';
}

function executable(file) {
  try { accessSync(file, constants.X_OK); return file; }
  catch { return null; }
}

function mediaTools(dir) {
  if (windows) {
    return {
      downloader: executable(path.join(dir, 'yt-dlp.exe')),
      ffmpeg: executable(path.join(dir, 'ffmpeg', 'ffmpeg.exe')),
    };
  }
  // GUI launches on macOS may omit Homebrew and MacPorts from PATH.
  const search = [...(process.env.PATH || '').split(path.delimiter),
    '/opt/homebrew/bin', '/opt/local/bin', '/usr/local/bin', '/usr/bin'];
  const ffmpeg = search.filter(p => path.isAbsolute(p))
    .map(p => path.join(p, 'ffmpeg')).find(executable);
  return { downloader: executable(path.join(dir, 'yt-dlp')), ffmpeg };
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (!windows) {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') child.kill(); }
    return;
  }
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  const killer = spawn(exe, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  killer.once('error', () => child.kill());
  killer.once('close', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
}

function beginMusicImport({ assets, downloader, ffmpeg, source, cached, nodePath, report, save }) {
  const id = randomUUID(), asset = id + '.mp3';
  const output = path.join(assets, asset);
  let child, inactivity, reason, staging;

  function stop(message = CANCELLED) {
    if (reason) return;
    reason = message;
    clearTimeout(inactivity);
    report('stopping', message);
    if (child) killTree(child);
  }

  function run(exe, args, onLine, timeoutMessage, env = process.env) {
    if (reason) throw new Error(reason);
    const processHandle = spawn(exe, args, { windowsHide: true, detached: !windows, env, stdio: ['ignore', 'pipe', 'pipe'] });
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

  async function download(format, message) {
    report('loading', message);
    let title, lastBytes = -1, skipped = '';
    const result = await run(downloader, [
      '--ignore-config', '--no-playlist', '--no-simulate',
      '--socket-timeout', '10', '--retries', '2', '--fragment-retries', '2',
      '--extractor-retries', '1', '--concurrent-fragments', '4', '--abort-on-unavailable-fragments',
      '--progress', '--newline', '--color', 'never', '--progress-delta', '0.5',
      '--progress-template', 'download:DM_PROGRESS %(progress.downloaded_bytes)s %(progress._percent_str)s',
      '--match-filter', '!is_live & !is_upcoming', '--max-filesize', '1G',
      '--no-js-runtimes', '--js-runtimes', `node:${nodePath}`, '--ffmpeg-location', ffmpeg,
      '-f', format, '--print', 'after_move:DM_TITLE %(title)j',
      '-o', path.join(staging, 'track.%(ext)s'), '--', source
    ], line => {
      if (line.startsWith('DM_TITLE ')) {
        try { title = JSON.parse(line.slice(9)); } catch { /* Use a default title. */ }
      }
      if (/does not pass filter/i.test(line)) skipped = 'live event';
      const progress = line.match(/^DM_PROGRESS\s+(\d+)\s*(\d+(?:\.\d+)?)?/);
      if (!progress || Number(progress[1]) <= lastBytes) return false;
      lastBytes = Number(progress[1]);
      const percent = progress[2] ? Math.min(100, Math.round(Number(progress[2]))) : null;
      report('loading', percent === null ? `Получено ${(lastBytes / 1024 ** 2).toFixed(1)} МБ` : `Загружено ${percent}%`, percent);
      return true;
    }, 'YouTube перестал передавать данные. Попробуйте ещё раз или добавьте аудиофайл.',
    { ...process.env, PYTHONIOENCODING: 'utf-8', ELECTRON_RUN_AS_NODE: '1' });
    const name = result.code === 0 && (await fs.readdir(staging)).find(name =>
      /^track\.(m4a|webm|mp3|ogg|mp4|opus|aac|mkv|m4v|ts|wav|flac)$/i.test(name));
    return { file: name ? path.join(staging, name) : null, title, detail: skipped || result.errorText };
  }

  async function fetchTrack() {
    staging = await fs.mkdtemp(path.join(assets, '.youtube-'));
    let result = await download('bestaudio[protocol=https]/bestaudio/best[height<=360]',
      'Подключение к YouTube…');
    if (!result.file && streamRejected.test(result.detail)) {
      await Promise.all((await fs.readdir(staging)).map(name => fs.unlink(path.join(staging, name))));
      result = await download('bestaudio[protocol^=m3u8]/best[protocol^=m3u8][height<=360]/best[height<=360]/best[height<=480]',
        'YouTube отклонил поток. Пробуем другой формат…');
    }
    if (!result.file) throw new Error(downloadError(result.detail));
    return result;
  }

  const done = (async () => {
    let saved = false;
    try {
      const { file, title } = cached ? { file: path.join(assets, cached.asset), title: cached.title } : await fetchTrack();
      if (reason) throw new Error(reason);
      if (file.endsWith('.mp3')) {
        await fs.rename(file, output);
      } else {
        report('loading', 'Конвертация в MP3…');
        const result = await run(ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-progress', 'pipe:1',
          '-protocol_whitelist', 'file', '-i', file,
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
      if (staging) {
        const files = await fs.readdir(staging).catch(() => []);
        await Promise.all(files.map(name => fs.unlink(path.join(staging, name)).catch(() => {})));
        await fs.rmdir(staging).catch(() => {});
      }
      if (!saved) await fs.unlink(output).catch(() => {});
    }
  })();
  return { stop, done };
}

module.exports = { beginMusicImport, mediaTools, youtubeVideoId };
