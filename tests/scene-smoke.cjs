const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: path.resolve('test-results', `scene-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
let app;
const state = page => page.evaluate(async () => (await window.dm.init()).state);
function point(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const world = document.querySelector('#map-world');
    const frame = world.parentElement.getBoundingClientRect();
    const matrix = new DOMMatrix(getComputedStyle(world).transform);
    const point = new DOMPoint(x, y).matrixTransform(matrix);
    return { x: frame.x + point.x, y: frame.y + point.y };
  }, { x, y });
}
async function click(page, x, y) {
  const at = await point(page, x, y);
  await page.mouse.click(at.x, at.y);
}
async function drag(page, x1, y1, x2, y2) {
  const start = await point(page, x1, y1), end = await point(page, x2, y2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}
function fogAlpha(page, x, y) {
  return page.locator('#map-fog').evaluate((canvas, { x, y }) => {
    const [, , width, height] = document.querySelector('#map-drawings').getAttribute('viewBox').split(' ').map(Number);
    return canvas.getContext('2d').getImageData(Math.floor(x * canvas.width / width),
      Math.floor(y * canvas.height / height), 1, 1).data[3];
  }, { x, y });
}
async function main() {
  app = await _electron.launch({ executablePath: require('electron'), args: [path.resolve('.')], env, timeout: 45_000 });
  const master = await app.firstWindow();
  await expect(master.locator('#version')).toHaveText(`v${require('../package.json').version}`);
  await master.click('#map-settings');
  const field = await master.locator('#grid-form [name="grid"]').boundingBox();
  const backdrop = await master.locator('#grid-dialog').boundingBox();
  await master.mouse.move(field.x + 19, field.y + 12);
  await master.mouse.down();
  await master.mouse.move(backdrop.x - 10, field.y + 12, { steps: 8 });
  await master.mouse.up();
  await expect(master.locator('#grid-dialog')).toBeVisible();
  await master.mouse.click(backdrop.x - 10, field.y + 12);
  await expect(master.locator('#grid-dialog')).toBeHidden();

  const firstMap = (await state(master)).activeMapId;
  await master.click('#create-map');
  await master.fill('#text-dialog-input', 'Подземелье');
  await master.check('#new-map-fog-enabled');
  await master.click('#text-dialog-submit');
  await expect(master.locator('#toggle-fog')).toHaveAttribute('aria-pressed', 'true');
  const dungeon = (await state(master)).activeMapId;
  await master.click('#open-library');
  await master.click('#create-character-template');
  await master.fill('#combatant-form [name="name"]', 'Лучник');
  await master.selectOption('#combatant-role', 'ally');
  await master.click('#editor-submit');
  await master.click('[data-library-map]');
  await click(master, 96, 96);
  await expect(master.locator('#map-tokens [aria-label="Лучник"]')).toBeVisible();
  await master.click('[data-token-remove]');
  await expect(master.locator('#remove-token-dialog')).toBeVisible();
  await master.click('#confirm-remove-token');
  await expect(master.locator('#map-tokens .token')).toHaveCount(0);
  await expect(master.locator('.combat-card')).toHaveCount(1);
  await master.click('[data-token-add]');
  await click(master, 96, 96);
  await click(master, 96, 96);
  await master.keyboard.press('Backspace');
  await expect(master.locator('#map-tokens .token')).toHaveCount(0);
  const target = await point(master, 96, 96);
  await master.evaluate(({ x, y }) => {
    const dataTransfer = new DataTransfer();
    document.querySelector('.combat-card').dispatchEvent(new DragEvent('dragstart', { dataTransfer, bubbles: true }));
    document.querySelector('#map-viewport').dispatchEvent(new DragEvent('drop', {
      dataTransfer, bubbles: true, cancelable: true, clientX: x, clientY: y,
    }));
  }, target);
  await expect(master.locator('#map-tokens .token')).toHaveCount(1);
  await master.locator('#map-tokens .token').dblclick();
  await expect(master.locator('#remove-token-dialog')).toBeVisible();
  await expect(master.locator('#remove-token-name')).toHaveText('Лучник');
  await master.keyboard.press('Escape');
  await expect(master.locator('#map-tokens .token')).toHaveCount(1);
  const destination = await point(master, 160, 96);
  await master.mouse.move(target.x, target.y);
  await master.mouse.down();
  await master.mouse.move(destination.x, destination.y);
  await expect(master.locator('#map-tokens .token.dragging')).toHaveCount(1);
  await master.locator('#map-tokens .token').dispatchEvent('lostpointercapture');
  await master.mouse.up();
  await expect(master.locator('#map-tokens .token.dragging')).toHaveCount(0);
  assert.equal((await state(master)).tokens[0].col, 1);

  await master.click('#edit-terrain');
  await expect(master.locator('#terrain-toolbar')).toBeVisible();
  await master.click('[data-terrain-tool="wall"]');
  await drag(master, 128, 4, 128, 64);
  await master.click('[data-terrain-tool="door"]');
  await drag(master, 128, 64, 128, 128);
  await master.click('[data-terrain-tool="wall"]');
  await drag(master, 128, 128, 128, 650);
  await master.click('[data-terrain-tool="light"]');
  await drag(master, 96, 96, 212, 96);
  await expect(master.locator('.scene-light')).toHaveCount(1);

  await master.click('#create-map-item');
  await master.fill('#item-name', 'Кованый ключ');
  const iconFile = path.join(env.DM_SCREEN_DATA, 'key.png');
  const imageBytes = await master.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#d79a43';
    ctx.fillRect(2, 8, 20, 5);
    return canvas.toDataURL().split(',')[1];
  });
  fs.writeFileSync(iconFile, Buffer.from(imageBytes, 'base64'));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, iconFile);
  await master.click('#choose-item-icon');
  await expect(master.locator('#item-icon-preview img')).toBeVisible();
  await master.click('#submit-map-item');
  await click(master, 96, 160);
  await expect(master.locator('.scene-item-name')).toHaveText('Кованый ключ');
  await master.evaluate(async () => {
    await dm.dispatch('combatant:add', { name: 'Скелет' });
    const { state } = await dm.init();
    const enemy = state.combatants.find(c => c.name === 'Скелет');
    await dm.dispatch('token:add', { id: enemy.id, col: 3, row: 1 });
  });
  await drag(master, 96, 96, 160, 96);
  assert.equal((await state(master)).tokens[0].col, 1);
  await expect(master.locator('#terrain-toolbar')).toBeHidden();
  master.once('dialog', dialog => dialog.accept());
  await master.click('#fog-reset');
  const pending = app.waitForEvent('window');
  await master.click('[data-detach="map"]');
  const player = await pending;
  await expect(master.locator('#map-fog')).toBeVisible();
  await expect(player.locator('#map-fog')).toBeVisible();
  for (const view of [master, player]) {
    await expect.poll(() => fogAlpha(view, 96, 96)).toBe(0);
    await expect.poll(() => fogAlpha(view, 160, 96)).toBe(255);
  }
  await expect(player.locator('#map-tokens [aria-label="Скелет"]')).toHaveCount(0);
  await expect(player.locator('.scene-item-name')).toHaveText('Кованый ключ');
  await expect.poll(() => player.locator('.scene-item-icon img').evaluate(img => img.naturalWidth)).toBe(24);
  await master.locator('[data-door-id]').click();
  await expect(player.locator('#map-tokens [aria-label="Скелет"]')).toBeVisible();
  await expect.poll(() => fogAlpha(player, 160, 96)).toBe(0);
  await drag(master, 96, 96, 160, 96);
  await expect.poll(async () => (await state(master)).tokens[0].col).toBe(2);
  await master.click('#toggle-fog');
  await expect(player.locator('#map-fog')).toBeHidden();
  await master.locator('#map-viewport').focus();
  await master.keyboard.press('f');
  await expect(player.locator('#map-fog')).toBeVisible();
  await master.click('#edit-terrain');
  await master.click('[data-terrain-tool="pen"]');
  await master.fill('#map-pen-color', '#e7354c');
  await master.selectOption('#map-pen-width', '12');
  await drag(master, 70, 210, 208, 252);
  const playerStroke = player.locator('#map-strokes path');
  await expect(playerStroke).toHaveAttribute('stroke', '#e7354c');
  await expect(playerStroke).toHaveAttribute('stroke-width', '12');
  assert.ok((await state(master)).drawings[0].points.length > 2);
  await master.click('#close-terrain');
  await master.selectOption('#map-select', firstMap);
  await expect(playerStroke).toHaveCount(0);
  await master.selectOption('#map-select', dungeon);
  await expect(playerStroke).toHaveCount(1);
  await expect.poll(async () => (await state(master)).tokens[0].col).toBe(2);
  await expect(master.locator('.scene-item-name')).toHaveText('Кованый ключ');
  const saved = JSON.parse(fs.readFileSync(path.join(env.DM_SCREEN_DATA, 'campaign.json'), 'utf8'));
  assert.equal(saved.boards.find(board => board.id === dungeon).tokens[0].col, 2);
  assert.equal(saved.boards.find(board => board.id === dungeon).drawings[0].color, '#e7354c');
  await master.click('#edit-terrain');
  await master.click('[data-terrain-tool="eraser"]');
  await click(master, 139, 231);
  await expect(playerStroke).toHaveCount(0);
  await master.click('[data-terrain-tool="window"]');
  await drag(master, 256, 128, 256, 320);
  await expect.poll(async () => (await state(master)).terrain.some(item => item.kind === 'window')).toBe(true);
  await master.click('[data-terrain-tool="eraser"]');
  for (const [kind, x, y] of [['light', 96, 96], ['wall', 128, 256], ['door', 128, 96], ['window', 256, 224]]) {
    const before = (await state(master)).terrain;
    await master.selectOption('#map-eraser-kind', kind);
    await click(master, x, y);
    await expect.poll(async () => (await state(master)).terrain.length).toBe(before.length - 1);
    const remaining = (await state(master)).terrain;
    assert.deepEqual(before.filter(item => !remaining.some(other => other.id === item.id)).map(item => item.kind), [kind]);
  }
  await expect(master.locator('.scene-light')).toHaveCount(0);
  await master.click('#close-terrain');
  assert.equal(saved.library[0].name, 'Лучник');
  const lssFile = path.join(env.DM_SCREEN_DATA, 'hero.json');
  fs.writeFileSync(lssFile, JSON.stringify({ jsonType: 'character', data: JSON.stringify({
    name: { value: 'ЛСС · Сова' }, stats: { dex: { score: 16 } },
    vitality: { 'hp-current': { value: 8 }, 'hp-max': { value: 21 }, initiative: { value: '[DEX] + 2' } },
  }) }));
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, lssFile);
  await master.keyboard.press('Escape');
  await master.click('#import-lss');
  await expect(master.locator('#import-portrait-hint')).toBeVisible();
  await master.click('#editor-submit');
  const imported = master.locator('.combat-card').filter({ hasText: 'ЛСС · Сова' });
  await expect(imported.locator('.hp-readout')).toHaveText('8 / 21');
  await expect(imported.locator('.combat-meta')).toContainText('Иниц. +5');
  if (process.env.DM_SCREEN_TEST_DND === '1') {
    const drop = (selector, url, at = { x: 0, y: 0 }) => master.evaluate(({ selector, url, at }) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('text/uri-list', url);
      document.querySelector(selector).dispatchEvent(new DragEvent('drop', {
        dataTransfer, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y,
      }));
    }, { selector, url, at });
    await drop('.combat-content', 'https://dnd.su/bestiary/4-goblin/');
    const goblin = master.locator('.combat-card').filter({ has: master.getByText('Гоблин', { exact: true }) });
    await expect(goblin.locator('.hp-readout')).toHaveText('7 / 7', { timeout: 25_000 });
    assert.equal((await state(master)).combatants.find(actor => actor.name === 'Гоблин').initiativeBonus, 2);
    await expect(goblin.locator('img')).toBeVisible();
    await drop('#map-viewport', 'https://next.dnd.su/items/16522-potion-of-healing/', await point(master, 160, 160));
    await expect(master.locator('.scene-item-name').filter({ hasText: 'Зелье лечения' })).toBeVisible({ timeout: 25_000 });
  }
  console.log('Scene editor, map placement, library, door collision, fog and dialog backdrop passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app?.close());
