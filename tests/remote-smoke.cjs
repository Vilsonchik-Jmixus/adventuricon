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
  const pending = app.waitForEvent('window'); await page.click('[data-detach="characters"]'); const other = await pending;
  await other.waitForFunction(() => document.body.classList.contains('detached'));
  await expect.poll(async () => app.evaluate(({ BrowserWindow }, id) => BrowserWindow.getAllWindows().filter(w => w.webContents.getURL().includes('panel=characters')).some(w => w.contentView.children.some(v => v.webContents?.id === id)), original)).toBe(true);
  await other.click('[data-detach="characters"]');
  console.log(JSON.stringify(sites, null, 2));
  console.log('PASS: real websites loaded, isolated browser views, native reparenting preserves the LSS webContents/session. Login is not automated.');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => { if (app) await app.close(); });
