const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const tar = require('tar');
const { initialState, migrateState } = require('./model.cjs');

const mainId = 'main';
const assetPattern = /^[a-f0-9-]+\.(?:png|jpg|jpeg|webp|gif|mp3|wav|ogg|m4a|mp4|webm|flac)$/i;
const profileId = /^(?:main|[a-f0-9-]{36})$/;
const megabyte = 1024 * 1024;
const tidyName = (name, fallback) => String(name ?? '').trim().slice(0, 100) || fallback;

function writeJSON(file, value) {
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), 'utf8');
  fs.renameSync(file + '.tmp', file);
}

function createCampaignStore(root) {
  const indexFile = path.join(root, 'campaigns.json');
  const defaults = { active: mainId, profiles: [{ id: mainId, name: 'Первая кампания' }] };
  let index = defaults;
  if (fs.existsSync(indexFile)) {
    try {
      const stored = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
      const profiles = stored.profiles.filter(entry => profileId.test(entry.id) && typeof entry.name === 'string');
      if (profiles.some(entry => entry.id === mainId)) {
        index = { profiles, active: profiles.some(entry => entry.id === stored.active) ? stored.active : mainId };
      }
    } catch (error) { console.warn('Не удалось прочитать список кампаний:', error.message); }
  }
  function paths(id) {
    if (!profileId.test(id)) throw new Error('Кампания не найдена');
    const directory = id === mainId ? root : path.join(root, 'campaigns', id);
    return { directory, assets: path.join(directory, 'assets'), file: path.join(directory, 'campaign.json') };
  }
  function load(id, recover = false) {
    if (!index.profiles.some(entry => entry.id === id)) throw new Error('Кампания не найдена');
    const result = paths(id);
    fs.mkdirSync(result.assets, { recursive: true });
    let state = initialState(), recovered = false;
    if (fs.existsSync(result.file)) {
      try {
        const saved = JSON.parse(fs.readFileSync(result.file, 'utf8'));
        state = migrateState(saved);
        if (saved.schema === 1 && !fs.existsSync(result.file + '.v1.bak')) fs.copyFileSync(result.file, result.file + '.v1.bak');
      } catch (error) {
        if (!recover) throw error;
        fs.copyFileSync(result.file, result.file + `.backup-${Date.now()}`);
        recovered = true;
      }
    } else if (id !== mainId) throw new Error('Файл кампании не найден');
    state.music.playing = false;
    return { ...result, state, recovered };
  }
  function save(next) {
    writeJSON(indexFile, next);
    index = next;
  }
  function register(id, name) {
    save({ active: index.active, profiles: [...index.profiles, { id, name: tidyName(name, 'Новая кампания') }] });
    return id;
  }
  function create(name) {
    const id = randomUUID(), target = paths(id);
    fs.mkdirSync(target.assets, { recursive: true });
    writeJSON(target.file, initialState());
    return register(id, name);
  }
  function select(id, recover = false) {
    const result = load(id, recover);
    save({ ...index, active: id });
    return result;
  }
  function rename(id, name) {
    if (!index.profiles.some(entry => entry.id === id)) throw new Error('Кампания не найдена');
    save({ ...index, profiles: index.profiles.map(entry => entry.id === id ? { ...entry, name: tidyName(name, entry.name) } : entry) });
  }
  async function exportArchive(destination, state) {
    const source = paths(index.active);
    const directory = await fsp.mkdtemp(path.join(root, '.campaign-export-'));
    const output = destination + `.${randomUUID()}.tmp`;
    try {
      const name = index.profiles.find(entry => entry.id === index.active).name;
      await fsp.writeFile(path.join(directory, 'campaign.json'), JSON.stringify(state));
      await fsp.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ format: 1, name }));
      await fsp.mkdir(path.join(directory, 'assets'));
      const media = (await fsp.readdir(source.assets, { withFileTypes: true }))
        .filter(entry => entry.isFile() && assetPattern.test(entry.name)).map(entry => `assets/${entry.name}`);
      for (const file of media) {
        const from = path.join(source.directory, file), to = path.join(directory, file);
        await fsp.link(from, to).catch(() => fsp.copyFile(from, to));
      }
      await tar.create({ cwd: directory, gzip: true, file: output, portable: true, strict: true }, ['campaign.json', 'manifest.json', ...media]);
      await fsp.rename(output, destination);
    } finally {
      await fsp.rm(output, { force: true });
      await fsp.rm(directory, { recursive: true, force: true });
    }
  }
  async function importArchive(file) {
    const id = randomUUID(), target = paths(id);
    await fsp.mkdir(target.assets, { recursive: true });
    try {
      const seen = new Set();
      let invalid = false, bytes = 0;
      await tar.extract({ cwd: target.directory, file, strict: true, filter: (name, entry) => {
        const config = name === 'campaign.json' || name === 'manifest.json';
        const media = name.startsWith('assets/') && assetPattern.test(name.slice(7));
        bytes += entry.size;
        if (invalid || !['File', 'OldFile'].includes(entry.type) || (!config && !media) ||
            !Number.isSafeInteger(entry.size) || entry.size < 0 ||
            entry.size > (config ? 128 : 1024) * megabyte || bytes > 16 * 1024 * megabyte ||
            seen.size >= 10000 || seen.has(name.toLowerCase())) {
          invalid = true;
          return false;
        }
        seen.add(name.toLowerCase());
        return true;
      } });
      if (invalid) throw new Error('Архив содержит неподдерживаемые файлы');
      const manifest = JSON.parse(await fsp.readFile(path.join(target.directory, 'manifest.json'), 'utf8'));
      if (manifest.format !== 1) throw new Error('Неподдерживаемая версия архива');
      const state = migrateState(JSON.parse(await fsp.readFile(target.file, 'utf8'), (key, value) => {
        if ((key === 'id' || key.endsWith('Id')) && value != null && !/^[a-z0-9_-]{1,128}$/i.test(value)) {
          throw new Error('Архив содержит повреждённые идентификаторы');
        }
        return value;
      }));
      writeJSON(target.file, state);
      await fsp.rm(path.join(target.directory, 'manifest.json'));
      return register(id, tidyName(manifest.name, 'Кампания') + ' · копия');
    } catch (error) {
      await fsp.rm(target.directory, { recursive: true, force: true });
      throw error;
    }
  }
  return { get index() { return index; }, load, select, create, rename, exportArchive, importArchive };
}

module.exports = { createCampaignStore, writeJSON, assetPattern };
