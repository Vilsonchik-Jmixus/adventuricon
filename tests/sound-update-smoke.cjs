const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');

const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: path.resolve('test-results', 'sound-update-' + Date.now()) };
delete env.ELECTRON_RUN_AS_NODE;
const executable = process.env.DM_SCREEN_EXECUTABLE;

async function main() {
  const app = await _electron.launch({ executablePath: executable || require('electron'), args: executable ? [] : [path.resolve('.')], env });
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#version')).toHaveText(`v${require('../package.json').version}`);
    await page.evaluate(() => {
      const play = retro.play;
      window.audioPlays = [];
      retro.play = (...args) => {
        window.audioPlays.push(args);
        return play(...args);
      };
    });
    const heard = id => expect.poll(() => page.evaluate(id => window.audioPlays.some(([key]) => key === id), id)).toBe(true);
    await page.click('#sound-pad-tab');
    await expect(page.locator('[data-sound-pad]')).toHaveCount(20);
    await page.click('[data-sound-pad="rain"]');
    await expect(page.locator('[data-sound-pad="rain"]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#stop-ambient');
    await expect(page.locator('[data-sound-pad="rain"]')).toHaveAttribute('aria-pressed', 'false');
    await page.click('#edit-sound-categories');
    await page.fill('#new-sound-category input', 'Таверна');
    await page.click('#new-sound-category button');
    await expect(page.locator('[data-category-for="rain"] option', { hasText: 'Таверна' })).toHaveCount(1);
    await page.selectOption('[data-category-for="rain"]', 'Таверна');
    await page.click('#sound-categories-dialog [data-close-dialog]');
    await page.selectOption('#sound-category', 'Таверна');
    await expect(page.locator('[data-sound-pad]:visible')).toHaveCount(1);
    await expect(page.locator('[data-sound-pad="rain"]')).toBeVisible();
    await page.selectOption('#sound-category', '');
    for (const [code, key, altKey, effect] of [['Numpad0', '0', false, 'fire'], ['Numpad0', '0', true, 'door']]) {
      await page.evaluate(({ code, key, altKey }) => {
        document.dispatchEvent(new KeyboardEvent('keydown', { code, key, ctrlKey: true, altKey, bubbles: true }));
      }, { code, key, altKey });
      await heard(effect);
    }
    const sheet = JSON.stringify({ jsonType: 'character', data: { name: { value: 'Страж' },
      vitality: { 'hp-current': { value: 7 }, 'hp-max': { value: 18 } } } });
    await app.evaluate(({ clipboard }, sheet) => clipboard.writeText(sheet), sheet);
    await page.click('#open-library');
    await page.click('#library-paste-lss');
    await expect(page.locator('#editor-title')).toHaveText('Импорт в заготовки');
    await page.selectOption('#combatant-form [name="movementSound"]', 'armor');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const context = canvas.getContext('2d');
      context.fillStyle = '#c99d63';
      context.fillRect(0, 0, 8, 8);
      return canvas.toDataURL();
    });
    const copyPng = () => app.evaluate(({ clipboard, ClipboardItem }, data) => {
      const bytes = Buffer.from(data.split(',')[1], 'base64');
      return clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
    }, png);
    await copyPng();
    await page.click('#paste-portrait');
    await expect(page.locator('#portrait-preview img')).toBeVisible();
    await page.click('#editor-submit');
    await expect(page.locator('#library-list')).toContainText('Страж');
    await page.click('#library-dialog [data-close-dialog]');
    await app.evaluate(({ clipboard }, sheet) => clipboard.writeText(sheet.replace('Страж', 'Мира')), sheet);
    await page.click('#paste-lss');
    await expect(page.locator('#editor-title')).toHaveText('Импорт в трекер');
    await copyPng();
    await page.click('#paste-portrait');
    await expect(page.locator('#portrait-preview img')).toBeVisible();
    await page.click('#editor-submit');
    await expect(page.locator('.combat-card')).toContainText('Мира');
    await expect(page.locator('.combat-card .hp-readout')).toHaveText('7 / 18');
    await page.evaluate(async () => {
      const { state } = await dm.init();
      const id = state.combatants[0].id;
      await dm.dispatch('token:add', { id, col: 2, row: 2 });
      await dm.dispatch('combatant:conditions', { id, conditions: ['poisoned'] });
      await dm.dispatch('combatant:add', { name: 'Волк', role: 'enemy' });
      await dm.dispatch('combat:roll-initiative', { role: 'enemy' });
    });
    await heard('poisoned');
    await heard('dice');
    await page.click('#fit-map');
    const token = page.locator('#map-tokens [data-token]');
    await expect(token).toBeVisible();
    const position = await token.boundingBox();
    assert.ok(position);
    await page.mouse.move(position.x + position.width / 2, position.y + position.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.down();
    await page.mouse.move(position.x + position.width * 2, position.y + position.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Control');
    await heard('step');
    const state = await page.evaluate(async () => (await dm.init()).state);
    assert.equal(state.library[0].movementSound, 'armor');
    assert.ok(state.library[0].image && state.combatants[0].image);
    await page.click('#open-round-events');
    await page.fill('#round-event-form [name="round"]', '1');
    await page.fill('#round-event-form [name="title"]', 'Страж у двери');
    await page.selectOption('#round-event-form [name="templateId"]', state.library[0].id);
    await page.click('#pick-round-cells');
    await expect(page.locator('#event-cell-picker')).toBeVisible();
    const point = await page.evaluate(() => {
      const frame = document.querySelector('#map-frame').getBoundingClientRect();
      const { x, y } = MapGeometry.transform(boardProjection.matrix, 4.5 * state.map.grid * boardLayout.zoom, 4.5 * state.map.grid * boardLayout.zoom);
      return { x: frame.left + x, y: frame.top + y };
    });
    await page.mouse.click(point.x, point.y);
    await expect(page.locator('.event-cell-marks i')).toHaveCount(1);
    await page.click('#event-cell-done');
    await expect(page.locator('#round-event-form [name="cells"]')).toHaveValue('4, 4');
    await page.click('#save-round-event');
    await expect(page.locator('#round-events-list')).toContainText('Страж у двери');
    await page.click('#round-events-dialog [data-close-dialog]');
    await page.click('#next-turn');
    await page.click('#open-round-events');
    await page.getByRole('button', { name: 'Запустить', exact: true }).click();
    await expect(page.locator('#round-events-list')).toContainText('Выполнено');
    await page.click('#round-events-dialog [data-close-dialog]');
    await expect(page.locator('#map-tokens [data-token]')).toHaveCount(2);
    const audioPath = '81c975aa-7637-4a2e-82a5-0c7375a31de9.wav';
    await fs.copyFile('ui/assets/welcome-jingle.wav', path.join(env.DM_SCREEN_DATA, 'assets', audioPath));
    await page.evaluate(async asset => {
      await dm.dispatch('music:add', { title: 'Проверка перемотки', asset });
      const track = (await dm.init()).state.music.tracks[0];
      await dm.dispatch('music:play', { id: track.id });
      await dm.dispatch('music:settings', { playing: false });
    }, audioPath);
    await page.click('#music-tracks-tab');
    await expect(page.locator('#music-seek')).toBeEnabled();
    const trackElement = await page.locator('.track').elementHandle();
    await page.evaluate(() => dm.dispatch('music:settings', { volume: .24 }));
    await expect(page.locator('#volume')).toHaveValue('24');
    assert.equal(await trackElement.evaluate(element => element.isConnected), true);
    const seek = async (window, fraction) => window.locator('#music-seek').evaluate((slider, fraction) => {
      slider.value = Number(slider.max) * fraction;
      slider.dispatchEvent(new Event('input'));
      slider.dispatchEvent(new Event('change'));
    }, fraction);
    const playback = () => page.locator('#audio').evaluate(audio => audio.currentTime / audio.duration);
    await seek(page, .5);
    await expect.poll(playback).toBeCloseTo(.5, 2);
    const detached = app.waitForEvent('window');
    await page.click('[data-detach="music"]');
    const music = await detached;
    await expect(music.locator('#music-seek')).toBeEnabled();
    await seek(music, .75);
    await expect.poll(playback).toBeCloseTo(.75, 2);
    await music.click('[data-detach="music"]');
    await page.click('#screen-settings');
    await page.locator('[data-sound-option="volume"]').evaluate(slider => {
      slider.value = 31;
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect.poll(() => page.evaluate(async () => (await dm.init()).soundPreferences.volume)).toBe(.31);
    const audioSettings = await page.evaluate(async () => dm.init());
    assert.equal(audioSettings.state.music.volume, .55);
    assert.equal(audioSettings.soundPreferences.assignment.rain, 'Таверна');
    console.log('PASS: both soundpad banks, ambient loops and categories, clipboard portraits, effects and footsteps, battle cues, and detached playback seeking.');
  } finally {
    await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
