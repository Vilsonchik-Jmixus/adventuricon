const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');

const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: path.resolve('test-results', `story-${Date.now()}`) };
delete env.ELECTRON_RUN_AS_NODE;
const exe = process.env.DM_SCREEN_EXECUTABLE;
let app;
const launch = () => _electron.launch({
  executablePath: exe || require('electron'), args: exe ? [] : [path.resolve('.')], env, timeout: 45_000,
});
const story = page => page.evaluate(async () => (await window.dm.init()).state.story);
async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 9 });
  await page.mouse.up();
}
async function center(locator) {
  const box = await locator.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function openBoard(page) {
  await expect(page.locator('#version')).toHaveText(`v${require('../package.json').version}`);
  await page.click('#show-notes');
  await page.click('[data-expand="characters"]');
  await page.locator('.characters').evaluate(panel => Promise.all(panel.getAnimations().map(animation => animation.finished)));
}
async function main() {
  app = await launch();
  let page = await app.firstWindow();
  await openBoard(page);
  for (const [title, text] of [['Первая встреча', '— Входи.\n— Добрый вечер.'], ['Погоня', 'Стража появляется из переулка.']]) {
    await page.click('#story-add');
    await page.fill('#story-title', title);
    await page.fill('#story-body', text);
    await page.locator('#story-form [type="submit"]').click();
    await expect(page.locator('.story-note-title', { hasText: title })).toBeVisible();
  }
  assert.equal((await story(page)).notes[0].body, '— Входи.\n— Добрый вечер.');
  const first = page.locator('.story-note').filter({ hasText: 'Первая встреча' });
  const second = page.locator('.story-note').filter({ hasText: 'Погоня' });
  await drag(page, await center(first.locator('.story-pin')), await center(second));
  await expect(page.locator('.story-rope')).toHaveCount(1);
  const line = await page.locator('.story-rope').getAttribute('d');
  const title = await center(first.locator('.story-note-title'));
  await drag(page, title, { x: title.x + 25, y: title.y + 164 });
  await expect(page.locator('.story-rope')).not.toHaveAttribute('d', line);
  await expect.poll(async () => (await story(page)).notes[0].y).toBe(180);

  const bounds = await page.locator('#story-viewport').boundingBox();
  const a = { x: bounds.x + 34, y: bounds.y + 82 }, b = { x: a.x + 105, y: a.y + 22 };
  await page.click('[data-story-tool="pen"]');
  await drag(page, a, b);
  await expect(page.locator('.story-mark')).toHaveCount(1);
  await page.click('[data-story-tool="eraser"]');
  await page.mouse.click((a.x + b.x) / 2, (a.y + b.y) / 2);
  await expect(page.locator('.story-mark')).toHaveCount(0);
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await openBoard(page);
  await expect(page.locator('.story-rope')).toHaveCount(1);
  await expect.poll(async () => (await story(page)).notes[0].y).toBe(180);
  await page.locator('.story-note-title', { hasText: 'Первая встреча' }).click();
  await expect(page.locator('#story-body')).toHaveValue('— Входи.\n— Добрый вечер.');
  await page.getByRole('button', { name: 'Убрать связь с заметкой «Погоня»' }).click();
  await expect(page.locator('.story-rope')).toHaveCount(0);
  console.log('Story cards, movable ropes, pencil, eraser and campaign reload passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => app?.close());
