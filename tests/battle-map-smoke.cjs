const { _electron, expect } = require('playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const env = { ...process.env, DM_SCREEN_TEST: '1', DM_SCREEN_DATA: path.resolve('test-results', 'battle-map-' + Date.now()) };
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath = process.env.DM_SCREEN_EXECUTABLE;
  const app = await _electron.launch({ executablePath: executablePath || require('electron'), args: executablePath ? [] : [path.resolve('.')], env });
  try {
    const master = await app.firstWindow();
    await expect(master.locator('#version')).toHaveText('v5.0.0');
    const dispatch = (type, payload) => master.evaluate(async ({ type, payload }) => {
      const response = await dm.dispatch(type, payload);
      if (!response.ok) throw new Error(response.error);
      return (await dm.init()).state;
    }, { type, payload });
    const inspect = page => page.evaluate(async () => (await dm.init()).state);
    await master.keyboard.press('Escape');
    await expect(master.locator('#quit-adventuricon')).toBeVisible();
    await master.keyboard.press('Escape');
    await master.click('#add-combatant');
    await master.fill('#combatant-form [name="name"]', 'Каменный страж');
    await master.selectOption('#combatant-form [name="tokenSize"]', '3');
    await master.click('#token-frame-picker summary');
    await expect(master.locator('#token-frame-options button')).toHaveCount(20);
    await master.click('[data-frame="ruby"]');
    await master.click('#editor-submit');
    const guard = (await inspect(master)).combatants[0];
    assert.equal(guard.tokenFrame, 'ruby');
    assert.equal(guard.tokenSize, 3);
    await dispatch('token:add', { id: guard.id, col: 3, row: 2 });
    await master.click('#fit-map');
    const token = master.locator('#map-tokens [data-token]');
    await expect(token).toHaveAttribute('data-size', '3');
    const size = await token.evaluate(node => ({
      token: node.offsetWidth,
      grid: parseFloat(getComputedStyle(node).getPropertyValue('--grid-size')),
    }));
    assert.ok(Math.abs(size.token - size.grid * 3) <= 1, JSON.stringify(size));
    const opened = app.waitForEvent('window');
    await master.click('[data-detach="map"]');
    const player = await opened;
    await expect(player.locator('#map-tokens [data-token]')).toHaveCount(1);
    await token.click({ button: 'right' });
    await master.click('#token-toggle-visibility');
    await expect(token.locator('.token-secret')).toBeVisible();
    await expect(player.locator('#map-tokens [data-token]')).toHaveCount(0);
    const hidden = await inspect(player);
    assert.equal(hidden.mapCombatants.some(actor => actor.id === guard.id), false);
    await master.click('#reveal-hidden-enemies');
    await expect(player.locator('#map-tokens [data-token]')).toHaveCount(1);

    const viewport = master.locator('#map-viewport');
    const bounds = await viewport.boundingBox();
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await master.click('[data-map-tool="circle"]');
    await master.mouse.click(x, y);
    await expect(master.locator('#map-measure-label')).toHaveText('15 фут. · радиус');
    await master.mouse.wheel(0, -120);
    await expect(master.locator('#map-measure-label')).toHaveText('20 фут. · радиус');
    await master.keyboard.press('Escape');
    for (const [tool, suffix] of [['line', ''], ['square', ' · сторона'], ['cone', '']]) {
      await master.click(`[data-map-tool="${tool}"]`);
      await master.mouse.click(x, y);
      await expect(master.locator('#map-measure-overlay')).toHaveAttribute('data-measure', tool);
      await expect(master.locator('#map-measure-label')).toHaveText('15 фут.' + suffix);
      await master.keyboard.press('Escape');
    }
    await master.click('[data-map-tool="grid"]');
    const original = (await inspect(master)).map;
    await master.mouse.move(x, y);
    await master.mouse.down();
    await master.mouse.move(x + 26, y + 12);
    await master.mouse.up();
    await master.mouse.wheel(0, -120);
    const beforeNudge = await master.locator('#map-tool-hint').textContent();
    await viewport.dispatchEvent('wheel', { deltaY: -120, altKey: true });
    await expect(master.locator('#map-tool-hint')).not.toHaveText(beforeNudge);
    await master.click('#map-tool-apply');
    const updated = (await inspect(master)).map;
    assert.equal(updated.grid, original.grid + 1);
    assert.notEqual(updated.offsetX, original.offsetX);
    const saved = (await inspect(master)).tokens[0];
    assert.deepEqual([saved.col, saved.row], [3, 2]);

    await master.click('#show-notes');
    await master.click('[data-story-tool="text"]');
    await master.locator('#story-viewport').click({ position: { x: 70, y: 100 } });
    await master.fill('#story-body', 'Здесь ждёт проводник\nПароль: маяк');
    await master.click('#story-form [type="submit"]');
    await expect(master.locator('.story-free-text')).toContainText('Здесь ждёт проводник');
    assert.equal((await inspect(master)).story.notes[0].kind, 'text');
    await master.keyboard.press('Escape');
    const closed = app.waitForEvent('close');
    await master.click('#quit-adventuricon');
    await closed;
    console.log('PASS: 20 frames, 3×3, private tokens, area resizing, grid alignment, free text and quit.');
  } finally { await app.close().catch(() => {}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
