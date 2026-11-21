const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
async function get(url) {
  const response = await fetch(url, { headers: { 'User-Agent': 'DM-Screen-Build' } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response;
}
(async () => {
  const release = await (await get('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest')).json();
  const executable = release.assets.find(a => a.name === 'yt-dlp.exe');
  const checksums = release.assets.find(a => a.name === 'SHA2-256SUMS');
  if (!executable || !checksums) throw new Error('Не найдены файлы yt-dlp');
  const sums = await (await get(checksums.browser_download_url)).text();
  const expected = sums.split('\n').find(line => /\s+\*?yt-dlp\.exe\s*$/.test(line))?.split(/\s+/)[0];
  const bytes = Buffer.from(await (await get(executable.browser_download_url)).arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (!expected || actual !== expected) throw new Error('Контрольная сумма yt-dlp не совпала');
  const dir = path.resolve(__dirname, '..', '.tools', 'media'); await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'yt-dlp.exe'), bytes);
  await fs.writeFile(path.join(dir, 'VERSION.txt'), `${release.tag_name}\nSHA256 ${actual}\nhttps://github.com/yt-dlp/yt-dlp\n`);
  const license = await (await get(`https://raw.githubusercontent.com/yt-dlp/yt-dlp/${release.tag_name}/LICENSE`)).text();
  await fs.writeFile(path.join(dir, 'yt-dlp-LICENSE.txt'), license);
  await fs.writeFile(path.join(dir, 'SOURCE.txt'), `Unmodified official yt-dlp Windows binary.\nCorresponding source for version ${release.tag_name}:\nhttps://github.com/yt-dlp/yt-dlp/archive/refs/tags/${release.tag_name}.tar.gz\nWindows build and dependencies: https://github.com/yt-dlp/yt-dlp/tree/${release.tag_name}/bundle\nLicense details: https://github.com/yt-dlp/yt-dlp/tree/${release.tag_name}#license\n`);
  console.log(`yt-dlp ${release.tag_name}: SHA256 verified`);
})().catch(e => { console.error(e.message); process.exit(1); });
