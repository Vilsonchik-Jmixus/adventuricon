const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: path.resolve('test-results', `map-fill-07-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
let app;
(async () => {
  const exe = process.env.DM_SCREEN_EXECUTABLE;
  app = await _electron.launch({ executablePath: exe || require('electron'), args: exe ? [] : [path.resolve('.')], env, timeout: 45_000 });
  const master = await app.firstWindow();
  await expect(master.locator('#version')).toHaveText(`v${require('../package.json').version}`);
  const png = await master.evaluate(() => {
    const image = document.createElement('canvas');
    image.width = 240; image.height = 350;
    const ctx = image.getContext('2d');
    ctx.fillStyle = '#e9bf90';
    ctx.fillRect(0, 0, 240, 350);
    ctx.fillStyle = '#422617';
    ctx.fillRect(0, 0, 80, 120);
    return image.toDataURL().split(',')[1];
  });
  const image = '0157dece-f7ae-4bac-a0ae-e9a7b0782ce2.png';
  fs.writeFileSync(path.join(env.DM_SCREEN_DATA, 'assets', image), Buffer.from(png, 'base64'));
  await master.evaluate(async image => {
    await window.dm.dispatch('map:image', { image });
    await window.dm.dispatch('map:settings', { grid: 24, zoom: 0.2 });
    await window.dm.dispatch('combatant:add', { role: 'player', name: 'Тестовый игрок' });
    await window.dm.dispatch('combatant:add', { role: 'enemy', name: 'Страж' });
    const id = (await window.dm.init()).state.combatants[0].id;
    await window.dm.dispatch('token:add', { id });
    await window.dm.dispatch('token:move', { id, row: 2, col: 3 });
  }, image);
  const pending = app.waitForEvent('window');
  await master.click('[data-detach="map"]');
  const player = await pending;
  await expect(player.locator('#map-viewport')).toHaveClass(/fitted-map/);
  const gaps = page => page.evaluate(() => {
    const image = document.querySelector('#map-image').getBoundingClientRect();
    const view = document.querySelector('#map-viewport').getBoundingClientRect();
    return Math.abs(image.left - view.left) + Math.abs(image.right - view.right) +
      Math.abs(image.top - view.top) + Math.abs(image.bottom - view.bottom);
  });
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('?panel=map'));
    w.setBounds({ x: 0, y: 0, width: 1240, height: 700 });
  });
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('?panel=map')).maximize());
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('?panel=map'));
    window.show();
    window.focus();
  });
  // macOS can handle F11 at the system level. Exercise the on-screen control there.
  if (process.platform === 'darwin') await player.locator('[data-expand="map"]').click();
  else await player.keyboard.press('F11');
  await expect(player.locator('body')).toHaveClass(/player-fullscreen/, { timeout: 15_000 });
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  await player.keyboard.press('Escape');
  await expect(player.locator('body')).not.toHaveClass(/player-fullscreen/, { timeout: 15_000 });
  await master.click('#rotate-map-right');
  await expect.poll(() => player.locator('#map-image').evaluate(img => getComputedStyle(img.parentElement).transform)).toMatch(/^matrix\(0, /);
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  await master.click('[data-expand="map"]');
  await master.locator('.panel.map').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
  await expect.poll(() => gaps(master)).toBeLessThan(3);
  const point = (x, y) => master.evaluate(({ x, y }) => {
    const world = document.querySelector('#map-world');
    const frame = world.parentElement.getBoundingClientRect();
    const offset = new DOMPoint(x, y).matrixTransform(new DOMMatrix(getComputedStyle(world).transform));
    return { x: frame.x + offset.x, y: frame.y + offset.y };
  }, { x, y });
  const before = await point(3.5 * 24, 2.5 * 24);
  const after = await point(4.5 * 24, 6.5 * 24);
  assert.ok(await master.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.token') !== null, before));
  await master.mouse.move(before.x, before.y); await master.mouse.down();
  await master.mouse.move(after.x, after.y, { steps: 8 }); await master.mouse.up();
  await expect.poll(() => master.evaluate(async () => (await window.dm.init()).state.tokens.map(({ row, col }) => [row, col]))).toEqual([[6, 4]]);
  await master.keyboard.press('Escape');
  const order = () => master.locator('.combat-name').allTextContents();
  await master.locator('[data-order-delta="-1"]').last().click();
  await expect.poll(order).toEqual(['Страж', 'Тестовый игрок']);
  await expect(master.locator('#reset-order')).toBeVisible();
  await master.click('#next-turn');
  await master.click('#next-turn');
  await expect(master.locator('#round')).toHaveText('Раунд 1 · 1/2');
  await master.click('#next-turn');
  await expect(master.locator('#round')).toHaveText('Раунд 2 · 0/2');
  await master.click('#reset-order');
  await expect.poll(order).toEqual(['Тестовый игрок', 'Страж']);
  console.log('PASS: portrait map at 20% fills/resizes in separate screen and master expansion, rotates, draggable grid stays aligned, manual order advances rounds.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (!app) return;
  const timeout = setTimeout(() => app.process().kill(), 8000);
  try { await app.close(); }
  finally { clearTimeout(timeout); }
});
