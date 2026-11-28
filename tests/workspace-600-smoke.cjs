const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { _electron, expect } = require('playwright/test');

const directory = path.resolve('test-results', `workspace-600-${Date.now()}`);
const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: directory };
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.DM_SCREEN_EXECUTABLE;
const launch = () => _electron.launch({ executablePath: executablePath || require('electron'),
  args: executablePath ? [] : [path.resolve('.')], env });

async function main() {
  let app = await launch();
  try {
    let page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#version')).toHaveText(`v${require('../package.json').version}`);
    const command = async (type, payload) => {
      const res = await page.evaluate(([type, payload]) => dm.dispatch(type, payload), [type, payload]);
      assert.ok(res.ok, res.error);
    };
    const search = async (query, title) => {
      await page.click('#open-campaign-search');
      await page.fill('#campaign-query', query);
      await page.locator('#campaign-search-results').getByRole('button', { name: title }).click();
    };
    await expect(page.locator('#quick-soundpad button')).toHaveCount(4);
    await page.keyboard.press('Control+Alt+g');
    await expect(page.locator('#workspace')).toHaveAttribute('data-mode', 'preparation');
    await expect(page.locator('#story')).toBeVisible();
    await expect(page.locator('#quick-soundpad')).toBeHidden();
    await command('layout:settings', { left: 26, middle: 45, top: 55 });
    await search('ведение', /Ведение/);
    await expect(page.locator('#workspace')).toHaveAttribute('data-mode', 'game');
    await command('layout:settings', { left: 29, middle: 40, top: 62 });
    await page.click('#screen-settings');
    await page.check('[data-screen-option="motion"]');
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', '');
    await page.keyboard.press('Escape');
    await page.locator('[data-expand="map"]').click();
    await expect(page.locator('.map-gold-frame i')).toHaveCount(4);
    await expect(page.locator('.map-gold-frame')).toBeVisible();
    await expect(page.locator('.map-gold-frame')).toHaveCSS('pointer-events', 'none');
    await search('туман', /Включить туман войны/);
    await expect(page.locator('#toggle-fog')).toHaveAttribute('aria-pressed', 'true');
    await search('костер', /Костёр/);
    await expect.poll(() => page.evaluate(async () => (await dm.init()).activePads)).toContain('campfire');
    await search('остановить фоновые', /Остановить фоновые звуки/);
    await expect.poll(() => page.evaluate(async () => (await dm.init()).activePads)).toEqual([]);
    await page.locator('[data-expand="map"]').click();
    await command('combatant:add', { name: 'Каменный гоблин', role: 'player' });
    await search('каменный гоблин', /Каменный гоблин/);
    await expect(page.locator('#combat-list')).toContainText('Каменный гоблин');
    await search('туман', /Рассеять туман войны/);

    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 4200;
      canvas.height = 3000;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#b57a49'; ctx.fillRect(0, 0, 4200, 3000);
      ctx.fillStyle = '#f5db9d'; ctx.fillRect(12, 23, 260, 210);
      return canvas.toDataURL().split(',')[1];
    });
    const imagePath = path.join(directory, 'large-map.png');
    await fs.writeFile(imagePath, Buffer.from(png, 'base64'));
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, imagePath);
    await page.click('#import-map');
    const image = page.locator('#map-image');
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBeGreaterThan(0);
    await expect(image).toHaveAttribute('src', /^blob:/);
    assert.deepEqual(await page.evaluate(() => {
      const { width, height } = mapArtwork.size();
      return [width, height];
    }), [4200, 3000]);
    const onOpen = app.waitForEvent('window');
    await page.click('[data-detach="map"]');
    const player = await onOpen;
    await expect(player.locator('.map-gold-frame')).toBeHidden();
    await expect(player.locator('#map-image')).toHaveAttribute('src', /^blob:/);
    await expect(player.locator('html')).toHaveAttribute('data-reduced-motion', '');
    await expect(page.locator('#map-player-status')).toHaveText('Карта видна игрокам');
    for (let step = 0; step < 18 && (await image.getAttribute('src')).startsWith('blob:'); step++) {
      const previous = await page.locator('#zoom-label').textContent();
      await page.click('#zoom-in');
      await expect(page.locator('#zoom-label')).not.toHaveText(previous);
    }
    await expect(image).toHaveAttribute('src', /^dm:\/\/app\/assets\//);
    await expect.poll(() => image.evaluate(node => node.naturalWidth)).toBe(4200);
    await page.click('#fit-map');
    await expect(image).toHaveAttribute('src', /^blob:/);
    assert.deepEqual(errors, []);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('#workspace')).toHaveAttribute('data-mode', 'game');
    assert.equal(await page.locator('#workspace').evaluate(node => node.style.getPropertyValue('--middle')), '40%');
    await page.keyboard.press('Control+Alt+g');
    await expect(page.locator('#workspace')).toHaveAttribute('data-mode', 'preparation');
    assert.equal(await page.locator('#workspace').evaluate(node => node.style.getPropertyValue('--middle')), '45%');
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', '');
    console.log('PASS: workspace modes, keyboard navigation, motion preference, commands, sounds, actors, large-map detail and player screen.');
  } finally { await app.close().catch(() => {}); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
