const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ffmpegRelease = 'autobuild-2026-11-20-12-40';
const ffmpegArchive = 'ffmpeg-n9.0.2-61-gd59078794d-win64-lgpl-shared-9.0.zip';
const ffmpegHash = '4bb5e4c160463533d2e020bdc9b8429e9d1b8cdff1cddafa264db09a25f56069';
async function get(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'DM-Screen-Build' },
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}
async function prepareYtDlp(dir) {
  const release = await (await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
  const executable = release.assets.find(a => a.name === 'yt-dlp.exe');
  const checksums = release.assets.find(a => a.name === 'SHA2-256SUMS');
  if (!executable || !checksums) throw new Error('Не найдены файлы yt-dlp');
  const sums = await (await get(checksums.browser_download_url)).text();
  const expected = sums.split('\n').find(line => /\s+\*?yt-dlp\.exe\s*$/.test(line))?.split(/\s+/)[0];
  const bytes = Buffer.from(await (await get(executable.browser_download_url)).arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || actual !== expected) throw new Error('Контрольная сумма yt-dlp не совпала');
  await fs.writeFile(path.join(dir, 'yt-dlp.exe'), bytes);
  await fs.writeFile(path.join(dir, 'VERSION.txt'), `${release.tag_name}\nSHA256 ${actual}\nhttps://github.com/yt-dlp/yt-dlp\n`);
  const license = await (await get(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.tag_name}/LICENSE`)).text();
  await fs.writeFile(path.join(dir, 'yt-dlp-LICENSE.txt'), license);
  await fs.writeFile(path.join(dir, 'SOURCE.txt'), `Unmodified official yt-dlp Windows binary.\nCorresponding source for version ${release.tag_name}:\nhttps://github.com/yt-dlp/yt-dlp/archive/refs/tags/${release.tag_name}.tar.gz\nWindows build and dependencies: https://github.com/yt-dlp/yt-dlp/tree/${release.tag_name}/bundle\nLicense details: https://github.com/yt-dlp/yt-dlp/tree/${release.tag_name}#license\n`);
  console.log(`yt-dlp ${release.tag_name}: SHA256 verified`);
}
async function prepareFfmpeg(dir) {
  const source = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/${ffmpegRelease}/${ffmpegArchive}`;
  const staging = path.resolve(dir, '..', 'ffmpeg-build');
  await fs.mkdir(staging, { recursive: true });
  const archive = path.join(staging, ffmpegArchive);
  let bytes = await fs.readFile(archive).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  const matches = buffer => buffer && createHash('sha256').update(buffer).digest('hex') === ffmpegHash;
  if (!matches(bytes)) {
    bytes = Buffer.from(await (await get(source)).arrayBuffer());
    if (!matches(bytes)) throw new Error('Контрольная сумма FFmpeg не совпала');
    await fs.writeFile(archive, bytes);
  }
  const members = execFileSync('tar.exe', ['-tf', archive], { encoding: 'utf8' }).split(/\r?\n/);
  const files = members.filter(name =>
    /^[\w.-]+\/(?:bin\/(?:ffmpeg\.exe|[\w-]+\.dll)|(?:LICENSE|COPYING|README)[\w.-]*)$/i.test(name));
  if (!files.some(name => name.endsWith('/ffmpeg.exe')) || !files.some(name => name.endsWith('.dll'))) {
    throw new Error('В архиве отсутствует FFmpeg или его библиотеки');
  }
  execFileSync('tar.exe', ['-xf', archive, '-C', staging, ...files], { windowsHide: true });
  const target = path.join(dir, 'ffmpeg');
  await fs.mkdir(target, { recursive: true });
  for (const member of files) await fs.copyFile(path.join(staging, member), path.join(target, path.basename(member)));
  const version = execFileSync(path.join(target, 'ffmpeg.exe'), ['-version'], { encoding: 'utf8', windowsHide: true });
  const encoders = execFileSync(path.join(target, 'ffmpeg.exe'), ['-hide_banner', '-encoders'], { encoding: 'utf8', windowsHide: true });
  if (!encoders.includes('libmp3lame')) throw new Error('В сборке FFmpeg отсутствует кодек MP3');
  await fs.writeFile(path.join(target, 'BUILD.txt'), `${version}\nArchive: ${source}\nSHA256 ${ffmpegHash}\nBuild scripts: https://github.com/FFmpeg-Builds/FFmpeg-Builds\nFFmpeg source: https://github.com/FFmpeg/FFmpeg/tree/d59078794d\n`);
  console.log('FFmpeg: SHA256 verified, MP3 encoder available');
}
(async () => {
  const dir = path.resolve(__dirname, '..', '.tools', 'media');
  await fs.mkdir(dir, { recursive: true });
  await Promise.all([prepareYtDlp(dir), prepareFfmpeg(dir)]);
})().catch(e => { console.error(e.message); process.exit(1); });
