const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
async function download(url, dest) {
  const r = await fetch(url, { headers: { 'User-Agent': 'DM-Screen-Build' } });
  if (!r.ok) throw new Error(`${r.status}: ${url}`);
  await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
}
(async () => {
  const root = path.resolve(__dirname, '..', '.tools');
  await fs.mkdir(root, { recursive: true });
  const npm = await (await fetch('https://registry.npmjs.org/npm/latest')).json();
  await download(npm.dist.tarball, path.join(root, 'npm.tgz'));
  execFileSync('tar', ['-xzf', path.join(root, 'npm.tgz'), '-C', root]);
  const gh = await (await fetch('https://api.github.com/repos/cli/cli/releases/latest', { headers: { 'User-Agent': 'DM-Screen-Build' } })).json();
  const asset = gh.assets.find(a => a.name.endsWith('windows_amd64.zip'));
  await download(asset.browser_download_url, path.join(root, 'gh.zip'));
  execFileSync('tar', ['-xf', path.join(root, 'gh.zip'), '-C', root]);
  console.log('Build tools downloaded.');
})().catch(e => { console.error(e.message); process.exit(1); });
