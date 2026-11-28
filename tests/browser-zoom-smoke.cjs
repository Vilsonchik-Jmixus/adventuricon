const { _electron: electron, expect } = require('playwright/test');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fs = require('node:fs/promises');
const env = {
  ...process.env,
  DM_SCREEN_TEST: '1',
  DM_SCREEN_REMOTE_TEST: '1',
  DM_SCREEN_DATA: path.join(root, 'test-results', `browser-zoom-${Date.now()}`)
};
delete env.ELECTRON_RUN_AS_NODE;

async function main() {
  const packed = process.env.DM_SCREEN_EXECUTABLE;
  const app = await electron.launch({ executablePath: packed || require('electron'), args: packed ? [] : [root], env });
  try {
    await app.evaluate(({ session }) => {
      for (const partition of ['persist:dm-info', 'persist:dm-characters', 'dm-web']) {
        session.fromPartition(partition).protocol.handle('https', () => new Response(
          '<!doctype html><title>Browser zoom fixture</title><body style="height: 4000px">Browser zoom fixture</body>',
          { headers: { 'content-type': 'text/html' } }
        ));
      }
    });
    const page = await app.firstWindow();
    await page.locator('#version').waitFor();
    const info = 'dnd.su';
    const sheets = 'longstoryshort.app';
    const web = 'duckduckgo.com';
    await page.evaluate(async () => {
      await window.dm.referenceAction('home');
      await window.dm.remoteAction('characters', 'home');
    });

    const read = host => app.evaluate(async ({ BrowserWindow }, host) => {
      for (const owner of BrowserWindow.getAllWindows()) {
        const view = owner.contentView.children.find(view => {
          const address = view.webContents?.getURL();
          return address?.startsWith('https:') && new URL(address).hostname === host;
        });
        if (!view || view.webContents.getTitle() !== 'Browser zoom fixture') continue;
        const contents = view.webContents;
        const width = await contents.executeJavaScript('innerWidth');
        return { zoom: contents.getZoomFactor(), width, owner: owner.webContents.getURL(), visible: view.getVisible() };
      }
      return null;
    }, host);
    const send = (host, input) => app.evaluate(async ({ BrowserWindow }, { host, input }) => {
      const owner = BrowserWindow.getAllWindows().find(owner => owner.contentView.children.some(view =>
        view.webContents?.getURL().startsWith(`https://${host}/`) && view.getVisible()
      ));
      const view = owner.contentView.children.find(view => view.webContents?.getURL().startsWith(`https://${host}/`));
      const contents = view.webContents;
      owner.show();
      owner.focus();
      contents.focus();
      if (input.type === 'mouseWheel' && process.platform === 'darwin') {
        // Address the renderer directly. Native test focus can move asynchronously on CI.
        const client = contents.debugger;
        const { width, height } = view.getBounds();
        client.attach();
        try {
          await client.sendCommand('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: Math.floor(width / 2), y: Math.floor(height / 2), deltaX: 0, deltaY: -input.deltaY,
            modifiers: input.modifiers.includes('control') ? 2 : input.modifiers.includes('meta') ? 4 : 0
          });
        } finally {
          client.detach();
        }
      } else {
        contents.sendInputEvent(input);
        if (input.type === 'keyDown') contents.sendInputEvent({ ...input, type: 'keyUp' });
      }
    }, { host, input });
    const wheel = (host, deltaY, modifiers = ['control']) => send(host, {
      type: 'mouseWheel', x: 50, y: 50, deltaY, wheelTicksY: Math.sign(deltaY), canScroll: true, modifiers
    });
    const key = (host, keyCode, modifiers = ['control']) => send(host, { type: 'keyDown', keyCode, modifiers });
    const poll = read => expect.poll(read, { timeout: 15_000 });
    await poll(() => read(info)).toMatchObject({ visible: true, zoom: 1 });
    await poll(() => read(sheets)).toMatchObject({ visible: true, zoom: 1 });
    const initialWidth = (await read(sheets)).width;
    const originalSize = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const size = window.getSize();
      window.setSize(940, 640);
      return size;
    });
    await expect.poll(() => page.evaluate(() => innerHeight)).toBeLessThanOrEqual(640);
    await poll(() => read(info)).toMatchObject({ visible: true });
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(...size), originalSize);
    await poll(async () => (await read(sheets)).width).toBe(initialWidth);

    await wheel(sheets, 120);
    await poll(async () => (await read(sheets)).width).toBeLessThan(initialWidth);
    expect((await read(info)).zoom).toBe(1);
    const enlarged = (await read(sheets)).zoom;
    await wheel(sheets, -120, []);
    expect((await read(sheets)).zoom).toBe(enlarged);
    await key(sheets, '0');
    await poll(async () => (await read(sheets)).width).toBe(initialWidth);
    await key(sheets, '=');
    await poll(async () => (await read(sheets)).zoom).toBeGreaterThan(1);
    await key(sheets, '-');
    await poll(async () => (await read(sheets)).zoom).toBe(1);

    await wheel(info, -120);
    await poll(async () => (await read(info)).zoom).toBeLessThan(1);
    const reduced = (await read(info)).zoom;
    await page.click('[data-reference-tab="web"]');
    await poll(() => read(web)).toMatchObject({ visible: true, zoom: 1 });
    await wheel(web, 120, [process.platform === 'darwin' ? 'meta' : 'control']);
    await poll(async () => (await read(web)).zoom).toBeGreaterThan(1);
    expect((await read(info)).zoom).toBe(reduced);

    await page.click('[data-reference-tab="info"]');
    const newWindow = app.waitForEvent('window');
    await page.click('[data-detach="info"]');
    await newWindow;
    await poll(() => read(info)).toMatchObject({ owner: expect.stringContaining('?panel=info'), visible: true, zoom: reduced });
    await key(info, '0');
    await poll(async () => (await read(info)).zoom).toBe(1);
    expect(await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === 'dm://app/index.html').webContents.getZoomFactor()
    )).toBe(1);
    const refWindow = app.windows().find(window => window.url().includes('?panel=info'));
    await refWindow.click('[data-reference-link="armor"]');
    await expect(refWindow.locator('#reference-query')).toHaveAttribute('title', /95-armor-and-shields/);
    await refWindow.keyboard.press('Control+Alt+T');
    await expect(refWindow.locator('#reference-extra-tabs [data-reference-tab]')).toHaveCount(1);
    await refWindow.click('[data-reference-link="spells"]');
    await expect(refWindow.locator('#reference-query')).toHaveAttribute('title', /\/spells\//);
    await refWindow.click('[data-reference-tab="info"]');
    await expect(refWindow.locator('#reference-query')).toHaveAttribute('title', /95-armor-and-shields/);
    await refWindow.click('[data-reference-nav="zoom-in"]');
    await expect(refWindow.locator('#reference-zoom')).toHaveText('110%');
    await refWindow.click('#reference-extra-tabs [data-reference-tab]');
    await expect(refWindow.locator('#reference-query')).toHaveAttribute('title', /\/spells\//);
    await expect(refWindow.locator('#reference-zoom')).toHaveText('110%');
    await refWindow.keyboard.press('Control+Alt+W');
    await expect(refWindow.locator('#reference-extra-tabs [data-reference-tab]')).toHaveCount(0);
    const saved = new Map(JSON.parse(await fs.readFile(path.join(env.DM_SCREEN_DATA, 'site-zoom.json'), 'utf8')));
    expect(saved.get('dnd.su')).toBe(1.1);
    console.log('PASS: browser zoom, detached window, independent tab history, and site zoom saved to disk.');
  } finally {
    await app.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
