const { _electron: electron, expect } = require('playwright/test');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_REMOTE_TEST: '1', DM_SCREEN_DATA: path.join(root, 'test-results', `remote-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
let app;
(async () => {
  app = await electron.launch({ executablePath: require('electron'), args: [root], env });
  const page = await app.firstWindow();
  await expect.poll(async () => app.evaluate(({ webContents }) => webContents.getAllWebContents().filter(w => /^https:\/\//.test(w.getURL())).length), { timeout: 60000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => app.evaluate(async ({ webContents }) => {
    const list = webContents.getAllWebContents().filter(w => /^https:\/\//.test(w.getURL()));
    return Promise.all(list.map(async w => ({ id: w.id, url: w.getURL(), ready: await w.executeJavaScript('document.readyState'), title: await w.executeJavaScript('document.title') })));
  }), { timeout: 60000 }).toEqual(expect.arrayContaining([
    expect.objectContaining({ url: expect.stringContaining('dnd.su'), ready: 'complete' }),
    expect.objectContaining({ url: expect.stringContaining('longstoryshort.app'), ready: 'complete' })
  ]));
  const sites = await app.evaluate(async ({ webContents }) => Promise.all(webContents.getAllWebContents().filter(w => /^https:\/\//.test(w.getURL())).map(async w => ({ id: w.id, url: w.getURL(), title: await w.executeJavaScript('document.title'), text: (await w.executeJavaScript('document.body.innerText')).slice(0, 180), nodeEnabled: w.getLastWebPreferences().nodeIntegration, preload: w.getLastWebPreferences().preload }))));
  for (const site of sites) { assert.equal(site.nodeEnabled, false); assert.ok(!site.preload); assert.ok(!/404|ERR_|not found/i.test(site.title), JSON.stringify(site)); }
  const original = sites.find(s => s.url.includes('longstoryshort')).id;
  assert.ok(sites.find(s => s.url.includes('longstoryshort')).url.includes('/characters/list/'));
  const sheetVisible = () => app.evaluate(({ BrowserWindow }, id) => {
    const main = BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === 'dm://app/index.html');
    return main.contentView.children.find(view => view.webContents?.id === id)?.getVisible();
  }, original);
  await page.click('#show-gallery');
  await expect(page.locator('#gallery')).toBeVisible();
  await expect.poll(sheetVisible).toBe(false);
  await page.click('#show-sheets');
  await expect.poll(sheetVisible).toBe(true);
  const pending = app.waitForEvent('window'); await page.click('[data-detach="characters"]'); const other = await pending;
  await other.waitForFunction(() => document.body.classList.contains('detached'));
  await expect.poll(async () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('panel=characters')).some(w => w.contentView.children.some(v => v.webContents?.id === id)), original)).toBe(true);
  await page.click('#show-gallery');
  await expect(page.locator('#gallery')).toBeVisible();
  await other.click('[data-detach="characters"]');
  await page.click('[data-reference-link="armor"]');
  await expect(page.locator('#reference-query')).toHaveAttribute('title', /dnd\.su\/articles\/inventory\/95-armor-and-shields/);
  await page.click('#open-bookmarks');
  await expect(page.locator('#save-bookmark')).toBeEnabled({ timeout: 30_000 });
  await page.click('#save-bookmark');
  await expect(page.locator('#bookmarks-list [data-bookmark]')).toHaveCount(1);
  await page.click('#bookmarks-dialog [data-close-dialog]');
  await page.fill('#reference-query', 'огненный шар');
  await page.press('#reference-query', 'Enter');
  await expect(page.locator('#web-surface')).toBeVisible();
  await expect(page.locator('#reference-query')).toHaveAttribute('title', /duckduckgo\.com.*q=site%3Adnd\.su/);
  // Each tab keeps its own page and the web view has no privileged bridge.
  await page.click('[data-reference-tab="info"]');
  await expect(page.locator('#reference-query')).toHaveAttribute('title', /95-armor-and-shields/);
  const pendingRef = app.waitForEvent('window');
  await page.click('[data-detach="info"]');
  const refWindow = await pendingRef;
  await refWindow.click('[data-reference-tab="web"]');
  const infoViewState = await app.evaluate(({ BrowserWindow }) => {
    const owner = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('?panel=info'));
    return owner.contentView.children.filter(view => view.webContents).map(view => {
      const preferences = view.webContents.getLastWebPreferences();
      return { url: view.webContents.getURL(), node: preferences.nodeIntegration, sandbox: preferences.sandbox, preload: preferences.preload };
    });
  });
  assert.ok(infoViewState.some(view => /duckduckgo\.com/.test(view.url) && !view.node && view.sandbox && !view.preload));
  await refWindow.click('[data-detach="info"]');
  await page.click('#open-bookmarks');
  await page.click('#bookmarks-list [data-bookmark]');
  await expect(page.locator('#reference-query')).toHaveAttribute('title', /95-armor-and-shields/);
  console.log(JSON.stringify(sites, null, 2));
  console.log('PASS: live dnd.su shortcuts and bookmark, web search and separate tab history, isolated browser views, native reparenting.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (app) await app.close(); });
