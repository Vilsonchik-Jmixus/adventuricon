const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialState, migrateState, activeView, reducer, hpValue, cellAt } = require('../electron/model.cjs');
test('HP commands, bounds and invalid expressions', () => {
  assert.equal(hpValue(12, 20, '-7'), 5);
  assert.equal(hpValue(12, 20, '+99'), 20);
  assert.equal(hpValue(12, 20, '-99'), 0);
  assert.equal(hpValue(12, 20, '=17'), 17);
  assert.throws(() => hpValue(12, 20, '7+4'));
  assert.throws(() => hpValue(12, 20, 'NaN'));
});
test('A combatant can be placed once; occupied cells are skipped', () => {
  let s = initialState();
  for (let i = 0; i < 10; i++) s = reducer(s, { type: 'combatant:add', payload: { name: `Гоблин ${i}`, maxHp: 12 } });
  const fighters = activeView(s).combatants;
  for (const c of fighters) s = reducer(s, { type: 'token:add', payload: { id: c.id } });
  const { tokens } = activeView(reducer(s, { type: 'token:add', payload: { id: fighters[0].id } }));
  assert.equal(tokens.length, 10);
  assert.equal(new Set(tokens.map(t => `${t.col},${t.row}`)).size, 10);
  assert.deepEqual({ col: tokens[8].col, row: tokens[8].row }, { col: 0, row: 1 });
});
test('Health changes are shared by reference to the combatant id, and can be undone', () => {
  const original = initialState();
  let s = reducer(original, { type: 'combatant:add', payload: { name: 'Орк', maxHp: 30 } });
  const id = activeView(s).combatants[0].id;
  s = reducer(s, { type: 'token:add', payload: { id } });
  s = reducer(s, { type: 'combatant:hp', payload: { id, expression: '-8' } });
  assert.equal(activeView(s).mapCombatants[0].hp, 22);
  s = reducer(s, { type: 'combatant:undo' }); assert.equal(activeView(s).combatants[0].hp, 30);
  assert.equal(activeView(original).combatants.length, 0);
  s = reducer(s, { type: 'combatant:remove', payload: { id } }); assert.equal(activeView(s).tokens.length, 0);
});
test('Rounds follow initiative and roll over at the end', () => {
  let s = initialState();
  s = reducer(s, { type: 'combatant:add', payload: { name: 'A', initiative: 3 } });
  s = reducer(s, { type: 'combatant:add', payload: { name: 'B', initiative: 18 } });
  const [first, second] = activeView(s).combatants;
  s = reducer(s, { type: 'combat:next' }); assert.equal(activeView(s).turn, second.id);
  s = reducer(s, { type: 'combat:next' }); assert.equal(activeView(s).turn, first.id);
  s = reducer(s, { type: 'combat:next' }); assert.equal(activeView(s).round, 2);
});
test('Grid math respects offset and token movement rejects non-finite coordinates', () => {
  assert.deepEqual(cellAt({ grid: 64, offsetX: 10, offsetY: 20 }, 144, 151), { col: 2, row: 2 });
  let s = reducer(initialState(), { type: 'combatant:add', payload: {} }); const id = activeView(s).combatants[0].id;
  s = reducer(s, { type: 'token:add', payload: { id } });
  s = reducer(s, { type: 'token:move', payload: { id, col: -15, row: Infinity } });
  assert.equal(activeView(s).tokens[0].col, 0); assert.equal(activeView(s).tokens[0].row, 0);
});
test('Legacy saves preserve the current fight, map, undo and token references', () => {
  const legacy = {
    schema: 1, revision: 7, layout: { windows: {} }, music: { tracks: [] }, gallery: [{ id: 'art' }],
    combatants: [{ id: 'orc', name: 'Орк', hp: 7, maxHp: 10 }], turn: 'orc', round: 3,
    history: [{ id: 'orc', hp: 10 }], tokens: [{ combatantId: 'orc', col: 2, row: 5 }],
    map: { grid: 49, image: 'old.png', zoom: 0.75 }
  };
  const migrated = migrateState(legacy);
  assert.equal(migrated.schema, 2);
  const v = activeView(migrated);
  for (const field of ['combatants', 'turn', 'round', 'history', 'tokens', 'map', 'music', 'gallery']) {
    assert.deepEqual(v[field], legacy[field]);
  }
  assert.equal(activeView(reducer(migrated, { type: 'combatant:undo' })).mapCombatants[0].hp, 10);
});
test('Boards retain their tokens across battle switches, while a linked battle can select its own board', () => {
  let s = initialState();
  const play = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  const firstBattle = s.activeBattleId, firstMap = s.activeMapId;
  const fighter = play('combatant:add', { name: 'Орк', maxHp: 25 }).combatants[0].id;
  play('token:add', { id: fighter });
  play('token:move', { id: fighter, col: 4, row: 2 });
  play('map:settings', { grid: 50, offsetX: -7, zoom: 0.6 });
  play('battle:save', { linkedMapId: firstMap });
  const nextMap = play('map:create', { title: 'Башня' }).activeMapId;
  play('token:add', { id: fighter });
  play('token:move', { id: fighter, col: 9, row: 8 });
  play('map:settings', { grid: 98 });
  play('combatant:hp', { id: fighter, expression: '-7' });
  play('combat:next');
  const secondBattle = play('battle:create', { title: 'Дозор' }).activeBattleId;
  const other = play('combatant:add', { name: 'Дозорный' }).combatants[0].id;
  play('battle:save', { linkedMapId: nextMap });
  const restored = play('battle:select', { id: firstBattle });
  assert.equal(restored.activeMapId, firstMap);
  assert.equal(restored.turn, fighter);
  assert.equal(restored.combatants[0].hp, 18);
  assert.equal(restored.map.grid, 50);
  assert.equal(restored.map.zoom, 0.6);
  assert.equal(restored.tokens[0].col, 4);
  const tower = play('battle:select', { id: secondBattle });
  assert.equal(tower.activeMapId, nextMap);
  assert.equal(tower.map.grid, 98);
  assert.equal(tower.combatants[0].id, other);
  assert.equal(tower.mapCombatants[0].id, fighter);
  assert.equal(tower.tokens[0].col, 9);
  assert.throws(() => play('map:settings', { grid: 99, expectedMapId: firstMap }), /переключилась/);
  const afterDeletion = play('battle:remove', { id: firstBattle });
  assert.equal(afterDeletion.tokens.length, 0);
  assert.equal(play('map:select', { id: firstMap }).tokens.length, 0);
  const afterMapRemoval = play('map:remove', { id: nextMap });
  assert.equal(afterMapRemoval.battleChoices[0].linkedMapId, null);
});
test('Layout stays usable and music folder moves persist', () => {
  let s = reducer(initialState(), { type: 'layout:settings', payload: { left: 200, middle: 200, top: 0 } });
  assert.ok(s.layout.left + s.layout.middle <= 82); assert.equal(s.layout.top, 25);
  s = reducer(s, { type: 'music:add', payload: { title: 'Лес', asset: 'test.webm', folder: 'Общее' } });
  s = reducer(s, { type: 'music:move', payload: { id: s.music.tracks[0].id, folder: 'Атмосфера' } });
  assert.equal(s.music.tracks[0].folder, 'Атмосфера');
});
