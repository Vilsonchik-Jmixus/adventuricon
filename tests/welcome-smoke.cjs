const { _electron, expect } = require('playwright/test');
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
  const firstTip = await tip().textContent();
  await master.locator('#screen-tip').click();
  await expect(tip()).not.toHaveText(firstTip);
  if (process.env.DM_SCREEN_CAPTURE) {
    await master.screenshot({ path: path.join(env.DM_SCREEN_DATA, 'workspace.png'), animations: 'disabled' });
  }

  const openingPlayer = app.waitForEvent('window');
  await master.locator('[data-detach="map"]').click();
  const player = await openingPlayer;
  await expect(player.locator('body')).toHaveClass(/player-map/);
  await expect(player.locator('#welcome-dialog')).toBeHidden();
  await expect(player.locator('#welcome-jingle')).not.toHaveAttribute('src', /.+/);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('?panel=map')).close());

  await settings().click();
  await master.getByLabel('Приветствие при запуске').uncheck();
  await master.getByLabel('Советы в шапке').uncheck();
  await app.close();

  app = await launch();
  master = await app.firstWindow();
  await expect(settings()).toBeVisible();
  await expect(welcome()).toBeHidden();
  await expect(master.locator('#screen-tip')).toBeHidden();
  await settings().click();
  await expect(master.getByRole('checkbox', { name: 'Джингл приветствия' })).not.toBeChecked();
  await master.emulateMedia({ reducedMotion: 'reduce' });
  await master.getByRole('button', { name: 'Показать приветствие' }).click();
  await expect(welcome()).toBeVisible();
  await expect(welcome()).toHaveCSS('animation-name', 'none');
  await expect(audio()).not.toHaveAttribute('src', /.+/);
  await master.getByRole('button', { name: 'Открыть ширму' }).click();
  await expect(welcome()).toBeHidden();
  await app.close();
  app = null;
  console.log('Welcome art, jingle, preferences, tips, detached player window and reduced motion passed.');
})().catch(async error => {
  console.error(error);
  await app?.close().catch(() => {});
  process.exitCode = 1;
});
