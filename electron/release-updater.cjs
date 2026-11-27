const { GitHubProvider } = require('electron-updater/out/providers/GitHubProvider');
const { parseUpdateInfo } = require('electron-updater/out/providers/Provider');

const repository = 'Vilsonchik-Jmixus/adventuricon';
const releases = `https://github.com/${repository}/releases`;
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

class ReleaseUpdater extends GitHubProvider {
  constructor(options, updater, runtime) {
    const [owner, repo] = repository.split('/');
    super({ ...options, owner, repo }, updater, runtime);
  }

  async getLatestVersion() {
    const channelFile = `${this.channel}.yml`;
    const request = (url, headers) => this.executor.request({
      ...this.createRequestOptions(url, headers),
      timeout: 12000,
    });
    const readManifest = async (url, expectedTag) => {
      const info = parseUpdateInfo(await request(url), channelFile, url);
      if (typeof info?.version !== 'string' || !stableVersion.test(info.version)) {
        throw new Error('Invalid version in the update manifest');
      }
      const tag = `v${info.version}`;
      if (expectedTag && tag !== expectedTag) throw new Error('Update manifest and release tag do not match');
      // Resolve installers and blockmaps under the exact tag even when discovery uses the latest alias.
      return { ...info, tag };
    };
    try {
      return await readManifest(new URL(`${releases}/latest/download/${channelFile}`));
    } catch (directError) {
      try {
        const api = new URL(`https://api.github.com/repos/${repository}/releases/latest`);
        const release = JSON.parse(await request(api, { Accept: 'application/vnd.github+json' }));
        const tag = release?.tag_name;
        if (typeof tag !== 'string' || !tag.startsWith('v') || !stableVersion.test(tag.slice(1)) || release.draft || release.prerelease) {
          throw new Error('Invalid stable release from the GitHub API');
        }
        return await readManifest(new URL(`${releases}/download/${tag}/${channelFile}`), tag);
      } catch (apiError) {
        throw new AggregateError([directError, apiError], 'Could not load the latest update manifest from GitHub');
      }
    }
  }
}

module.exports = { ReleaseUpdater, releases };
