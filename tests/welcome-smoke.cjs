const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');

const env = {
  ...process.env,
  DM_SCREEN_TEST: '1',
  DM_SCREEN_WELCOME_TEST: '1',
  DM_SCREEN_DATA: path.resolve('test-results', `welcome-${Date.now()}`),
};
delete env.ELECTRON_RUN_AS_NODE;
const exe = process.env.DM_SCREEN_EXECUTABLE;
const launch = () => _electron.launch({
  executablePath: exe || require('electron'),
  args: exe ? [] : [path.resolve('.')],
  env,
  timeout: 45_000,
});

let app;
(async () => {
  app = await launch();
  let master = await app.firstWindow();
  if (process.env.DM_SCREEN_CAPTURE) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].showInactive());
  }
  const welcome = () => master.locator('#welcome-dialog');
  const audio = () => master.locator('#welcome-jingle');
  const settings = () => master.getByRole('button', { name: 'Оформление и звук' });
  const tip = () => master.locator('#tip-text');
  await expect(welcome()).toBeVisible();
  await expect.poll(() => master.locator('#welcome-art-image').evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  await expect.poll(() => audio().evaluate(el => el.currentTime)).toBeGreaterThan(0);

  // Muting stops only the greeting track and survives a full app restart.
  await master.getByRole('button', { name: 'Джингл приветствия' }).click();
  await expect.poll(() => audio().evaluate(el => el.paused)).toBe(true);
  await expect(master.locator('#audio')).not.toHaveAttribute('src', /.+/);
  if (process.env.DM_SCREEN_CAPTURE) {
    await master.screenshot({ path: path.join(env.DM_SCREEN_DATA, 'welcome.png'), animations: 'disabled' });
  }
  await master.keyboard.press('Escape');
  await expect(welcome()).toBeHidden();
  const garland = master.locator('#holiday-lights');
  await garland.evaluate(element => { element.hidden = false; });
  await expect(garland.locator('i')).toHaveCount(13);
  const bulb = garland.locator('i').first();
  const colors = await bulb.evaluate(element => {
    const [animation] = element.getAnimations();
    animation.pause();
    return [0, 3000].map(time => {
      animation.currentTime = time;
      return getComputedStyle(element).color;
    });
  });
  assert.notEqual(...colors, 'the first pixel bulb changes color');
  const [strand, brand] = await Promise.all([garland.boundingBox(), master.locator('.brand').boundingBox()]);
  assert.ok(strand.y + strand.height <= brand.y, 'the strand fits above the toolbar');
  const firstTip = await tip().textContent();
  await master.locator('#screen-tip').click();
  await expect(tip()).not.toHaveText(firstTip);
  if (process.env.DM_SCREEN_CAPTURE) {
    await master.screenshot({ path: path.join(env.DM_SCREEN_DATA, 'workspace.png'), animations: 'disabled' });
  }

  if (process.platform === 'win32') {
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const setIcon = window.setIcon.bind(window);
      const setOverlayIcon = window.setOverlayIcon.bind(window);
      window.setIcon = image => { window.testIcon = image.toPNG(); setIcon(image); };
      window.setOverlayIcon = (image, description) => {
        window.testOverlay = image?.toPNG();
        setOverlayIcon(image, description);
      };
    });
  }
  await settings().click();
  await expect(master.locator('.screen-theme')).toHaveCount(10);
  const light = master.getByRole('button', { name: 'Белая надежда', exact: true });
  await light.click();
  await expect(master.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(master.locator('#theme-brand-icon')).toHaveAttribute('src', 'assets/themes/light.png');
  await expect.poll(() => master.locator('#theme-brand-icon').evaluate(img => img.naturalWidth)).toBe(256);
  if (process.env.DM_SCREEN_CAPTURE) {
    await master.keyboard.press('Escape');
    await master.screenshot({ path: path.join(env.DM_SCREEN_DATA, 'light.png'), animations: 'disabled' });
    await settings().click();
  }
  await master.getByRole('button', { name: 'Чёрный сумрак', exact: true }).click();
  await expect(master.locator('html')).toHaveCSS('color-scheme', 'dark');
  await expect(master.locator('#theme-brand-icon')).toHaveAttribute('src', 'assets/themes/dark.png');
  await expect.poll(() => master.locator('#theme-brand-icon').evaluate(img => img.naturalWidth)).toBe(256);
  const blue = master.getByRole('button', { name: 'Сумерки', exact: true });
  await blue.click();
  await expect(blue).toHaveAttribute('aria-pressed', 'true');
  await expect(master.locator('html')).toHaveCSS('--theme-base', '#20222b');
  await expect(master.locator('#theme-brand-icon')).toHaveAttribute('src', 'assets/themes/blue.png');
  await expect.poll(() => master.locator('#theme-brand-icon').evaluate(img => img.naturalWidth)).toBe(256);
  if (process.platform === 'win32') {
    const nativeIcons = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return [window.testIcon?.length, window.testOverlay?.length];
    });
    assert.ok(nativeIcons.every(length => length > 0), 'the themed icon and taskbar overlay reach the native window');
  }
  if (process.env.DM_SCREEN_CAPTURE) {
    await master.screenshot({ path: path.join(env.DM_SCREEN_DATA, 'themes.png'), animations: 'disabled' });
  }
  await master.keyboard.press('Escape');

  const openingPlayer = app.waitForEvent('window');
  await master.locator('[data-detach="map"]').click();
  const player = await openingPlayer;
  await expect(player.locator('body')).toHaveClass(/player-map/);
  await expect(player.locator('#welcome-dialog')).toBeHidden();
  await expect(player.locator('#welcome-jingle')).not.toHaveAttribute('src', /.+/);
  await expect(player.locator('html')).toHaveAttribute('data-theme', 'blue');

  await settings().click();
  await master.getByRole('button', { name: 'Шалфей', exact: true }).click();
  await expect(player.locator('html')).toHaveAttribute('data-theme', 'green');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('?panel=map')).close());
  await master.getByLabel('Приветствие при запуске').uncheck();
  await master.getByLabel('Советы в шапке').uncheck();
  await app.close();

  app = await launch();
  master = await app.firstWindow();
  await expect(settings()).toBeVisible();
  await expect(welcome()).toBeHidden();
  await expect(master.locator('#screen-tip')).toBeHidden();
  await settings().click();
  await expect(master.locator('html')).toHaveAttribute('data-theme', 'green');
  await expect(master.getByRole('button', { name: 'Шалфей', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(master.getByRole('checkbox', { name: 'Джингл приветствия' })).not.toBeChecked();
  await master.emulateMedia({ reducedMotion: 'reduce' });
  await expect(master.locator('#holiday-lights i').first()).toHaveCSS('animation-name', 'none');
  await master.getByRole('button', { name: 'Показать приветствие' }).click();
  await expect(welcome()).toBeVisible();
  await expect(welcome()).toHaveCSS('animation-name', 'none');
  await expect(audio()).not.toHaveAttribute('src', /.+/);
  await master.getByRole('button', { name: 'Открыть ширму' }).click();
  await expect(welcome()).toBeHidden();
  await settings().click();
  await master.getByRole('button', { name: 'Таверна', exact: true }).click();
  await expect(master.locator('html[data-theme]')).toHaveCount(0);
  await expect(master.locator('#theme-brand-icon')).toHaveAttribute('src', 'assets/icon.png');
  await expect.poll(() => master.locator('#theme-brand-icon').evaluate(img => img.naturalWidth)).toBeGreaterThanOrEqual(512);
  await app.close();
  app = null;
  console.log('Pixel lights, light and dark themes, native icon, detached window, restart, welcome, tips and reduced motion passed.');
})().catch(async error => {
  console.error(error);
  await app?.close().catch(() => {});
  process.exitCode = 1;
});
