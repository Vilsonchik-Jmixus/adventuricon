const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const data = path.resolve('test-results', `session-${Date.now()}`);
const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const state = page => page.evaluate(async () => (await dm.init()).state);
let app;

function mapPoint(page, x, y) {
  return page.evaluate(({ x, y }) => {
    const world = document.querySelector('#map-world');
    const frame = world.parentElement.getBoundingClientRect();
    const transformed = new DOMPoint(x, y).matrixTransform(new DOMMatrix(getComputedStyle(world).transform));
    return { x: frame.x + transformed.x, y: frame.y + transformed.y };
  }, { x, y });
}

async function main() {
  const exe = process.env.DM_SCREEN_EXECUTABLE;
  app = await _electron.launch({ executablePath: exe || require('electron'), args: exe ? [] : [path.resolve('.')], env, timeout: 45000 });
  const master = await app.firstWindow();
  await expect(master.locator('#version')).toHaveText(`v${require('../package.json').version}`);
  const { activeBattleId: battle, activeMapId: map } = await state(master);
  const asset = '00576024-07e0-4a5d-9c8f-2f92d4dcc6fb.png';
  fs.copyFileSync(path.resolve('ui/assets/icon.png'), path.join(data, 'assets', asset));
  await master.evaluate(async asset => {
    await dm.dispatch('gallery:add', { image: asset, title: 'Иллюстрация' });
    await dm.dispatch('story:save', { title: 'Секретная реплика', body: 'Один стук', x: 600, y: 650 });
    await dm.dispatch('combatant:add', { name: 'Разведчик', role: 'player' });
    const { state } = await dm.init();
    await dm.dispatch('token:add', { id: state.combatants[0].id, col: 1, row: 1 });
    await dm.dispatch('terrain:add', { kind: 'wall', a: { x: 128, y: 0 }, b: { x: 128, y: 123 } });
  }, asset);
  await master.click('[data-expand="map"]');
  await master.locator('.panel.map').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
  const from = await mapPoint(master, 96, 96), waypoint = await mapPoint(master, 96, 160), to = await mapPoint(master, 224, 160);
  await master.mouse.move(from.x, from.y);
  await master.mouse.down();
  await master.mouse.move(waypoint.x, waypoint.y);
  await master.keyboard.press('f');
  await master.mouse.move(to.x, to.y);
  await expect(master.locator('#movement-ruler output')).toHaveText('15 фут.');
  await master.mouse.up();
  await expect.poll(async () => (await state(master)).tokens[0].col).toBe(3);
  await master.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect.poll(async () => (await state(master)).tokens[0].col).toBe(1);
  await expect(master.locator('#movement-ruler')).toBeHidden();

  await master.click('#edit-terrain');
  await master.click('#pin-map-note');
  await master.locator('#map-note-form [type=submit]').click();
  await master.mouse.click(to.x, to.y);
  const pin = master.locator('[data-note-pin]');
  await expect(pin).toHaveCount(1);
  await pin.click();
  await expect(master.locator('.story-note.revealed')).toContainText('Секретная реплика');
  const previewOpening = app.waitForEvent('window');
  await master.click('#open-player-preview');
  const preview = await previewOpening;
  await expect(preview).toHaveTitle('Предпросмотр экрана игроков');
  await expect(preview.locator('[data-note-pin]')).toHaveCount(0);
  assert.equal((await state(preview)).story, undefined);
  assert.equal((await state(preview)).notePins, undefined);

  const { gallery } = await state(master);
  const playerOpening = app.waitForEvent('window');
  await master.evaluate(id => dm.showPlayers('gallery', id), gallery[0].id);
  const player = await playerOpening;
  for (const window of [preview, player]) await expect(window.locator('#presented-image')).toBeVisible();
  await expect.poll(async () => {
    const getSize = window => window.locator('#map-viewport').evaluate(element => [element.clientWidth, element.clientHeight]);
    return JSON.stringify(await getSize(preview)) === JSON.stringify(await getSize(player));
  }).toBe(true);
  await master.click('#return-map');
  await expect(preview.locator('#presented-image')).toBeHidden();

  await master.click('#open-session-scenes');
  await master.click('#new-session-scene');
  await master.fill('#session-scene-form [name=title]', 'Побег');
  await master.selectOption('#session-scene-form [name=noteId]', { label: 'Секретная реплика' });
  await master.locator('#session-scene-form [type=submit]').click();
  await master.keyboard.press('Escape');
  await master.evaluate(async () => {
    await dm.dispatch('battle:create', { title: 'Дежурный бой' });
    await dm.dispatch('map:create', { title: 'Другая карта' });
  });
  await master.click('#open-session-scenes');
  await master.getByRole('button', { name: 'Побег', exact: true }).click();
  await expect.poll(async () => (await state(master)).activeMapId).toBe(map);
  assert.equal((await state(master)).activeBattleId, battle);
  await expect(master.locator('.story-note.revealed')).toContainText('Секретная реплика');

  const archive = path.join(data, 'backup.tar.gz');
  await app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, archive);
  await master.click('#open-campaigns');
  await master.click('#campaign-export');
  await expect(master.locator('#campaign-status')).toHaveText('Архив сохранён');
  await master.click('#campaign-create');
  await master.fill('#text-dialog-input', 'Новая группа');
  await master.click('#text-dialog-submit');
  await expect(master.locator('#campaign-select option:checked')).toHaveText('Новая группа');
  assert.equal((await state(master)).story.notes.length, 0);
  await expect(preview.locator('#player-blackout')).toBeVisible();
  await master.click('#campaign-import');
  await expect(master.locator('#campaign-select option:checked')).toHaveText('Первая кампания · копия');
  assert.equal((await state(master)).story.notes[0].title, 'Секретная реплика');
  assert.equal((await state(master)).notePins.length, 1);
  assert.equal((await state(master)).scenes[0].title, 'Побег');
  console.log('Ruler, waypoints, Ctrl+Z, private map pins, exact player frame, scenes and campaign archive UI passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (!app) return;
  const timeout = setTimeout(() => { app.process().kill('SIGKILL'); process.exit(1); }, 8000);
  try { await app.close(); } finally { clearTimeout(timeout); }
});
