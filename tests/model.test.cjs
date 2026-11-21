const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialState, migrateState, activeView, reducer, hpValue, cellAt } = require('../electron/model.cjs');
const { CONDITIONS, playerMapActors } = require('../electron/combat-rules.cjs');
const { REFERENCE_LINKS, safeUrl, searchUrl } = require('../electron/reference.cjs');
const MapGeometry = require('../ui/map-geometry.js');
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
  s = reducer(s, { type: 'combat:initiative', payload: { id: first.id, value: 3 } });
  s = reducer(s, { type: 'combat:initiative', payload: { id: second.id, value: 18 } });
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
  assert.deepEqual(migrated.battles[0].combatants, legacy.combatants);
  for (const field of ['turn', 'round', 'history', 'tokens', 'map', 'music', 'gallery']) {
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
test('Only enemies roll initiative; player scores are entered after creation', () => {
  let s = initialState();
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  const playerId = act('combatant:add', { role: 'player', initiative: 13 }).combatants[0].id;
  assert.equal(activeView(s).combatants[0].initiative, null);
  act('combat:initiative', { id: playerId, value: 13 });
  const allyId = act('combatant:add', { role: 'ally', initiativeBonus: -2 }).combatants[1].id;
  act('combat:initiative', { id: allyId, value: 5 });
  act('combatant:add', { initiativeBonus: 4 });
  const [player, ally, enemy] = act('combat:roll-initiative', { role: 'enemy' }).combatants;
  assert.equal(player.initiative, 13);
  assert.equal(ally.initiative, 5);
  assert.ok(enemy.initiativeRoll.die >= 1 && enemy.initiativeRoll.die <= 20);
  assert.equal(enemy.initiative, enemy.initiativeRoll.die + 4);
  assert.throws(() => act('combat:roll-initiative', { role: 'ally' }), /только за противников/);
  assert.throws(() => act('combat:roll-initiative', { id: ally.id }), /Нет участников/);
  assert.throws(() => act('combat:roll-initiative', { id: player.id }), /Нет участников/);
});
test('Manual queue and mid-round initiative changes preserve completed turns and round count', () => {
  let s = initialState();
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  for (const name of ['А', 'Б', 'В']) act('combatant:add', { name });
  const [a, b, c] = activeView(s).combatants.map(item => item.id);
  act('combat:initiative', { id: a, value: 18 });
  act('combat:initiative', { id: b, value: 12 });
  act('combat:initiative', { id: c, value: 3 });
  assert.equal(act('combat:next').turn, a);
  assert.equal(act('combat:next').turn, b);
  assert.deepEqual(act('combat:move', { id: c, delta: -1 }).order, [a, c, b]);
  assert.deepEqual(act('combat:initiative', { id: a, value: 0 }).order, [a, c, b]);
  assert.deepEqual(act('combat:sort').order, [b, c, a]);
  const third = act('combat:next');
  assert.equal(third.turn, c);
  assert.equal(third.round, 1);
  assert.deepEqual(third.acted, [a, b]);
  const nextRound = act('combat:next');
  assert.equal(nextRound.round, 2);
  assert.equal(nextRound.turn, b);
  assert.deepEqual(nextRound.acted, []);
});
test('All quarter turns cover the viewport and preserve the inverse coordinate for a grid point', () => {
  for (const rotation of [0, 90, 180, 270]) {
    const { matrix: [a, b, c, d, e, f] } = MapGeometry.project({
      width: 240, height: 350, rotation, viewportWidth: 1917, viewportHeight: 986, mode: 'fill'
    });
    const transform = (x, y) => [a * x + c * y + e, b * x + d * y + f];
    const corners = [transform(0, 0), transform(240, 0), transform(240, 350), transform(0, 350)];
    assert.deepEqual(corners.map(p => p.map(Math.round)).sort(), [[0, 0], [0, 986], [1917, 0], [1917, 986]].sort());
    const [x, y] = transform(84, 156);
    const restored = MapGeometry.inverse([a, b, c, d, e, f], x, y);
    assert.ok(Math.abs(restored.x - 84) < 1e-8 && Math.abs(restored.y - 156) < 1e-8);
  }
});
test('Hidden enemy HP stays outside the player projection and automatic unconscious clears on recovery', () => {
  assert.equal(CONDITIONS.length, 15);
  let s = initialState();
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  const ally = act('combatant:add', { role: 'ally', maxHp: 25 }).combatants[0].id;
  const enemy = act('combatant:add', { maxHp: 60 }).combatants[1].id;
  act('token:add', { id: ally });
  act('token:add', { id: enemy });
  act('combatant:conditions', { id: enemy, conditions: ['poisoned', 'fake', 'poisoned'], exhaustion: 9 });
  let publicActors = playerMapActors(act('combatant:hp', { id: enemy, expression: '=0' }).mapCombatants, true);
  assert.equal(publicActors[0].hp, 25);
  assert.ok(!Object.hasOwn(publicActors[1], 'hp') && !Object.hasOwn(publicActors[1], 'maxHp'));
  assert.deepEqual(publicActors[1].effects.map(e => e.id), ['unconscious', 'exhaustion', 'poisoned']);
  publicActors = playerMapActors(act('combatant:hp', { id: enemy, expression: '+6' }).mapCombatants, false);
  assert.ok(publicActors.every(actor => !Object.hasOwn(actor, 'hp')));
  assert.deepEqual(publicActors[1].effects.map(e => e.id), ['exhaustion', 'poisoned']);
  act('combatant:conditions', { id: enemy, conditions: ['unconscious'] });
  assert.equal(act('combatant:hp', { id: enemy, expression: '+1' }).mapCombatants[1].effects[0].id, 'unconscious');
});
test('Reference routes only admit HTTPS pages and encode rules search without leaking into another parameter', () => {
  assert.equal(REFERENCE_LINKS.length, 9);
  assert.ok(REFERENCE_LINKS.every(link => new URL(link.url).hostname === 'dnd.su'));
  for (const input of ['file:///test', 'dm://app/index.html', 'javascript:void(0)', 'https://alice:password@dnd.su/']) {
    assert.equal(safeUrl(input), null);
  }
  assert.equal(new URL(searchUrl('огненный шар & тест', true)).searchParams.get('q'), 'site:dnd.su огненный шар & тест');
  assert.equal(searchUrl('https://dnd.su/items/', false), 'https://dnd.su/items/');
});
