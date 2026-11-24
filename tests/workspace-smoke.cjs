const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const directory = path.resolve('test-results', `workspace-${Date.now()}`);
const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.DM_SCREEN_EXECUTABLE || require('electron');
const args = process.env.DM_SCREEN_EXECUTABLE ? [] : [path.resolve('.')];
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp2sAAAAASUVORK5CYII=';
const shortcut = process.platform === 'darwin' ? 'Meta+v' : 'Control+v';
let app;

const snapshot = page => page.evaluate(async () => (await dm.init()).state);
const loaded = locator => expect.poll(() => locator.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
const pasteInField = locator => locator.evaluate((field, base64) => {
  const data = new DataTransfer();
  data.items.add(new File([Uint8Array.from(atob(base64), byte => byte.charCodeAt(0))], 'image.png', { type: 'image/png' }));
  field.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
}, image);
async function launch() {
  app = await _electron.launch({ executablePath, args, env });
  const page = await app.firstWindow();
  await expect(page.locator('#version')).toHaveText(`v${require('../package.json').version}`);
  return page;
}

async function main() {
  let page = await launch();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ clipboard }, base64) => {
    clipboard.read = async () => [{ types: ['image/png'], getType: async () => new Blob([Buffer.from(base64, 'base64')]) }];
  }, image);
  await page.click('#add-combatant');
  await page.fill('#combatant-form [name="name"]', 'Мира');
  await page.selectOption('#combatant-role', 'player');
  await page.press('#paste-portrait', shortcut);
  await expect(page.locator('#portrait-preview img')).toHaveCount(1);
  await loaded(page.locator('#portrait-preview img'));
  await page.click('#editor-submit');
  await loaded(page.locator('.combat-card img'));

  await page.click('#show-notes');
  await page.click('#story-add');
  await page.fill('#story-title', 'Карта сокровищ');
  await page.fill('#story-body', 'Спрятана у причала.');
  await pasteInField(page.locator('#story-body'));
  await loaded(page.locator('#story-image-preview img'));
  await pasteInField(page.locator('#story-body'));
  await expect(page.locator('#story-image-preview img')).toHaveCount(2);
  await page.locator('#story-form [type="submit"]').click();
  await loaded(page.locator('.story-note-image').last());
  await expect(page.locator('.story-note-image')).toHaveCount(2);
  await expect(page.locator('.story-note-body')).toHaveText('Спрятана у причала.');

  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#973f3d';
    ctx.fillRect(0, 0, 8, 8);
    return canvas.toDataURL('image/webp');
  });
  assert.match(dataUrl, /^data:image\/webp;base64,/);
  const lssFile = path.join(directory, 'lss.json');
  await fs.writeFile(lssFile, JSON.stringify({ jsonType: 'character', version: '2', data: JSON.stringify({
    name: { value: 'Лучник' }, avatar: { webp: dataUrl }, stats: { dex: { score: 16 } },
    vitality: { 'hp-current': { value: 7 }, 'hp-max': { value: 16 } }
  }) }));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, lssFile);
  await page.click('#import-lss');
  const archer = page.locator('.combat-card', { hasText: 'Лучник' });
  await loaded(archer.locator('img'));
  await expect(archer.locator('.hp-readout')).toContainText('7');
  const roster = await snapshot(page);
  const [mira, imported] = roster.combatants;
  assert.match(imported.image, /\.webp$/);
  assert.equal(imported.initiativeBonus, 3);
  await page.evaluate(async ([first, second]) => {
    await dm.dispatch('token:add', { id: first });
    await dm.dispatch('token:add', { id: second, col: 2, row: 2 });
    await dm.dispatch('fog:enabled', { enabled: true });
    await dm.dispatch('combat:initiative', { id: first, value: 18 });
    await dm.dispatch('combat:next');
    await dm.dispatch('combat:next');
    await dm.dispatch('combat:next');
  }, [mira.id, imported.id]);
  await expect(page.locator('#round')).toHaveText('Раунд 2 · 0/2');
  await page.fill('#combat-search', 'луЧ');
  await expect(page.locator('.combat-name')).toHaveText(['Лучник']);
  await page.click('#jump-to-turn');
  await expect(page.locator('.combat-name')).toHaveCount(2);
  await page.click('#roll-initiative');
  await expect(page.locator('[data-roll-role="enemy"]')).toBeDisabled();
  await page.click('#reset-initiative');
  await page.click('#confirm-initiative-reset');
  await expect(page.locator('#round')).toHaveText('Раунд 1 · 0/2');
  await expect(page.locator('.initiative-value')).toHaveText(['—', '—']);
  await expect(page.locator('#map-tokens .token')).toHaveCount(2);

  const patch = await page.evaluate(async () => {
    const stable = ['.combat-card', '.token', '.story-note', '.story-note-image'].map(selector => [selector, document.querySelector(selector)]);
    const message = new Promise(resolve => {
      const off = dm.onState(value => { off(); resolve(value); });
    });
    await dm.dispatch('music:settings', { volume: 0.37 });
    return { fields: Object.keys((await message).state).sort(), kept: stable.every(([selector, node]) => node === document.querySelector(selector)) };
  });
  assert.deepEqual(patch, { fields: ['music', 'revision'], kept: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  await page.screenshot({ path: path.join(directory, 'workspace-wide.png') });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(965, 680));
  await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(980);
  const visible = await page.evaluate(() => {
    const map = document.querySelector('.map').getBoundingClientRect();
    const left = document.querySelector('.combat').getBoundingClientRect();
    const right = document.querySelector('.characters').getBoundingClientRect();
    return map.height > left.height && left.right <= map.left && map.right <= right.left;
  });
  assert.ok(visible);
  await page.screenshot({ path: path.join(directory, 'workspace-compact.png') });
  assert.deepEqual(errors, []);
  await app.close();
  page = await launch();
  await page.click('#show-notes');
  await expect(page.locator('.story-note-image')).toHaveCount(2);
  await loaded(page.locator('.story-note-image').last());
  await loaded(page.locator('.combat-card', { hasText: 'Лучник' }).locator('img'));
  await expect(page.locator('#round')).toHaveText('Раунд 1 · 0/2');
  console.log('PASS: clipboard portraits and notes, embedded LSS WebP, initiative reset, roster search, targeted window updates, layout and restart.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await app?.close(); });
