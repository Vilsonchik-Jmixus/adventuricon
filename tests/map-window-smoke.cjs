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
  const nativeFullscreen = process.env.DM_SCREEN_TEST_NO_NATIVE_FULLSCREEN !== '1';
  const reportFullscreen = active => app.evaluate(({ BrowserWindow }, active) => {
    const window = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('?panel=map'));
    window.webContents.send('status', { scope: 'player-fullscreen', active });
  }, active);
  if (!nativeFullscreen) {
    // Hosted Intel macOS can hang during the AppKit Space transition.
    // Drive the renderer event here; the other runners exercise the native transition.
    console.log('Testing fullscreen renderer layout without the native AppKit Space transition.');
    await reportFullscreen(true);
  } else if (process.platform === 'darwin') {
    // macOS can handle F11 at the system level. Exercise the on-screen control there.
    await player.locator('[data-expand="map"]').click();
  } else {
    await player.keyboard.press('F11');
  }
  await expect(player.locator('body')).toHaveClass(/player-fullscreen/, { timeout: 15_000 });
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  if (nativeFullscreen) await player.keyboard.press('Escape');
  else await reportFullscreen(false);
  await expect(player.locator('body')).not.toHaveClass(/player-fullscreen/, { timeout: 15_000 });
  await master.click('#rotate-map-right');
  await expect.poll(() => player.locator('#map-image').evaluate(img => getComputedStyle(img.parentElement).transform)).toMatch(/^matrix\(0, /);
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  const angle = page => page.locator('#map-world').evaluate(world => world.style.getPropertyValue('--token-orientation'));
  const previewPending = app.waitForEvent('window');
  await master.click('#open-player-preview');
  const preview = await previewPending;
  await expect.poll(() => angle(preview)).toBe('-90deg');
  await master.click('#player-settings');
  await master.selectOption('#player-rotation', '0');
  await expect.poll(() => angle(player)).toBe('0deg');
  await expect.poll(() => angle(preview)).toBe('0deg');
  assert.equal(await angle(master), '-90deg');
  await player.click('#rotate-player-left');
  await expect(master.locator('#player-rotation')).toHaveValue('270');
  await expect.poll(() => angle(preview)).toBe('-270deg');
  await player.keyboard.press('Shift+ArrowRight');
  await expect(master.locator('#player-rotation')).toHaveValue('0');
  await player.keyboard.press('Shift+ArrowLeft');
  await expect.poll(() => angle(preview)).toBe('-270deg');
  assert.equal(await angle(master), '-90deg');
  await expect.poll(() => gaps(player)).toBeLessThan(3);
  const previewWrite = await preview.evaluate(async () => {
    const { state, campaignId } = await dm.init();
    return dm.rotatePlayerMap(90, { expectedMapId: state.activeMapId, expectedCampaignId: campaignId });
  });
  assert.equal(previewWrite.ok, false);
  await master.locator('#player-dialog [data-close-dialog]').click();
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
  await expect.poll(() => player.evaluate(async () => (await dm.init()).state.tokens.map(({ row, col }) => [row, col]))).toEqual([[6, 4]]);
  await master.click('[data-expand="map"]');
  await master.click('#player-settings');
  await master.selectOption('#player-fit', 'follow');
  await master.locator('#player-dialog [data-close-dialog]').click();
  await master.click('#zoom-in');
  await master.evaluate(() => dm.dispatch('map:settings', { zoom: 12 }));
  const masterCenter = await master.evaluate(() => {
    const view = document.querySelector('#map-viewport');
    const transform = new DOMMatrix(getComputedStyle(document.querySelector('#map-world')).transform);
    const center = new DOMPoint(132 * 12, 158 * 12).matrixTransform(transform);
    view.scrollTo(center.x - view.clientWidth / 2, center.y - view.clientHeight / 2);
    return [view.scrollLeft + view.clientWidth / 2, view.scrollTop + view.clientHeight / 2];
  });
  assert.ok(masterCenter.every(value => value > 0));
  await expect.poll(() => player.evaluate(() => {
    const view = document.querySelector('#map-viewport');
    const transform = new DOMMatrix(getComputedStyle(document.querySelector('#map-world')).transform);
    const center = new DOMPoint(view.scrollLeft + view.clientWidth / 2, view.scrollTop + view.clientHeight / 2).matrixTransform(transform.inverse());
    return [Math.round(center.x / 12), Math.round(center.y / 12)];
  })).toEqual([132, 158]);
  const saved = JSON.parse(fs.readFileSync(path.join(env.DM_SCREEN_DATA, 'campaign.json'), 'utf8'));
  assert.deepEqual([saved.boards[0].map.rotation, saved.boards[0].map.playerRotation], [90, 270]);
  await master.click('#player-settings');
  await master.selectOption('#player-rotation', '');
  await expect.poll(() => angle(player)).toBe('-90deg');
  await expect.poll(() => angle(preview)).toBe('-90deg');
  await master.locator('#player-dialog [data-close-dialog]').click();
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
  console.log('PASS: portrait map fills both screens, independent rotations sync to preview and persist, follow camera and token placement stay aligned.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (!app) return;
  const timeout = setTimeout(() => {
    console.error('Electron did not close within eight seconds.');
    app.process().kill('SIGKILL');
    process.exit(1);
  }, 8000);
  try { await app.close(); }
  finally { clearTimeout(timeout); }
});
