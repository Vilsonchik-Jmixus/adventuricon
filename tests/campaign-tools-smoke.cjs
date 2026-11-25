const { _electron: electron, expect } = require('playwright/test');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: path.join(root, 'test-results', `campaign-tools-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
const packed = process.env.DM_SCREEN_EXECUTABLE;
const launch = () => electron.launch({ executablePath: packed || require('electron'), args: packed ? [] : [root], env });

async function main() {
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await expect(page.locator('#version')).toHaveText(`v${require('../package.json').version}`);
    await expect(page).toHaveTitle('Адвенчурикон');
    await page.evaluate(async () => {
      for (const [type, payload] of [
        ['battle:save', { title: 'У ворот' }], ['combatant:add', { name: 'Страж ворот' }],
        ['story:save', { title: 'Письмо', body: 'Печать с серебряной луной', x: 120, y: 130 }],
        ['journal:session', { title: 'Ночная игра' }]
      ]) {
        const response = await window.dm.dispatch(type, payload);
        if (!response.ok) throw new Error(response.error);
      }
    });
    await page.keyboard.press('Control+Alt+K');
    await page.fill('#campaign-query', 'серебряной');
    await expect(page.locator('#campaign-search-results button')).toHaveCount(1);
    await page.press('#campaign-query', 'Enter');
    await expect(page.locator('#story .story-note')).toHaveCount(1);
    const card = page.locator('.story-note');
    const size = (await card.boundingBox()).width;
    await page.click('#story-zoom-in');
    await expect(page.locator('#story-zoom-reset')).toHaveText('125%');
    expect((await card.boundingBox()).width).toBeGreaterThan(size);
    await page.click('#story-zoom-out');
    expect((await card.boundingBox()).width).toBeCloseTo(size, 0);

    await page.keyboard.press('Control+Alt+E');
    await page.fill('#round-event-form [name="round"]', '2');
    await page.fill('#round-event-form [name="title"]', 'Прибывает подкрепление');
    await page.click('#save-round-event');
    await expect(page.locator('#round-events-list')).toContainText('Прибывает подкрепление');
    await page.click('#round-events-dialog [data-close-dialog]');
    await page.keyboard.press('Control+Alt+N');
    await expect(page.locator('#current-turn')).toBeVisible();
    await page.keyboard.press('Control+Alt+N');
    await expect(page.locator('#round')).toContainText('Раунд 2');
    await expect(page.locator('#open-round-events')).toHaveClass(/event-pending/);
    await page.keyboard.press('Control+Alt+J');
    await expect(page.locator('#journal-list')).toContainText('Раунд 2. Прибывает подкрепление');
    await page.fill('#journal-form textarea', 'Игроки спасли посыльного');
    await page.click('#save-journal-entry');
    await expect(page.locator('#journal-list')).toContainText('Игроки спасли посыльного');
    await page.click('#journal-dialog [data-close-dialog]');

    await page.click('#screen-settings');
    await page.click('#open-shortcuts');
    await page.selectOption('#shortcut-bindings [name="search"]', 'Q');
    await page.click('#shortcuts-form [type="submit"]');
    await expect(page.locator('#shortcuts-dialog')).not.toBeVisible();
    await page.keyboard.press('Control+Alt+Q');
    await page.fill('#campaign-query', 'посыльного');
    await expect(page.locator('#campaign-search-results')).toContainText('Ночная игра');
    await page.press('#campaign-query', 'Enter');
    await expect(page.locator('#journal-list .selected')).toContainText('Игроки спасли посыльного');

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator('#open-campaign-search')).toHaveAttribute('aria-keyshortcuts', 'Control+Alt+Q');
    await page.keyboard.press('Control+Alt+J');
    await expect(page.locator('#journal-list')).toContainText('Игроки спасли посыльного');
    console.log('PASS: search, story zoom, round reminders, session journal and customizable persisted shortcuts.');
  } finally {
    await app.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
