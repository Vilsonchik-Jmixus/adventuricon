const assert = require('node:assert/strict');
const test = require('node:test');
const { ReleaseUpdater, releases } = require('../electron/release-updater.cjs');

const apiPath = '/repos/Vilsonchik-Jmixus/adventuricon/releases/latest';
const releasePath = new URL(releases).pathname;
const version = '5.1.1';
const installer = `Adventuricon-Setup-${version}.exe`;
const manifest = (file = installer, v = version) =>
  `version: ${v}\nfiles:\n  - url: ${file}\n    sha512: ${Buffer.alloc(64).toString('base64')}\n`;

function updater(platform, responses) {
  const requests = [];
  const provider = new ReleaseUpdater({}, {}, {
    platform,
    executor: {
      async request(options) {
        const { hostname, path } = options;
        requests.push([hostname, path]);
        if (!responses.has(path)) throw new Error(`Unexpected request: ${path}`);
        const response = responses.get(path);
        if (response instanceof Error) throw response;
        return response;
      },
    },
  });
  return { provider, requests };
}

test('the updater reads the Windows manifest directly and downloads from the exact release tag', async () => {
  const path = `${releasePath}/latest/download/latest.yml`;
  const { provider, requests } = updater('win32', new Map([[path, manifest()]]));
  const info = await provider.getLatestVersion();
  assert.equal(info.tag, `v${version}`);
  assert.equal(provider.resolveFiles(info)[0].url.href, `${releases}/download/v${version}/${installer}`);
  assert.deepEqual(requests, [['github.com', path]]);
});

test('a 504 on a direct manifest uses the API and reads the tagged Linux channel', async () => {
  const arch = process.env.TEST_UPDATER_ARCH || process.arch;
  const channel = `latest-linux${arch === 'x64' ? '' : '-' + arch}.yml`;
  const appImage = `Adventuricon-${version}-linux-${arch === 'x64' ? 'x86_64' : arch}.AppImage`;
  const directPath = `${releasePath}/latest/download/${channel}`;
  const taggedPath = `${releasePath}/download/v${version}/${channel}`;
  const { provider, requests } = updater('linux', new Map([
    [directPath, new Error('504 Gateway Timeout')],
    [apiPath, JSON.stringify({ tag_name: `v${version}`, draft: false, prerelease: false })],
    [taggedPath, manifest(appImage)],
  ]));
  const info = await provider.getLatestVersion();
  assert.equal(provider.resolveFiles(info)[0].url.href, `${releases}/download/v${version}/${appImage}`);
  assert.deepEqual(requests, [['github.com', directPath], ['api.github.com', apiPath], ['github.com', taggedPath]]);
});

test('an invalid direct manifest and inconsistent API release cannot select an installer', async () => {
  const { provider } = updater('win32', new Map([
    [`${releasePath}/latest/download/latest.yml`, '<html>504 Gateway Timeout</html>'],
    [apiPath, JSON.stringify({ tag_name: `v${version}` })],
    [`${releasePath}/download/v${version}/latest.yml`, manifest(installer, '5.1.0')],
  ]));
  await assert.rejects(provider.getLatestVersion(), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.errors[1].message, /do not match/);
    return true;
  });
});
