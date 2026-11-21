const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialState, reducer, hpValue, cellAt } = require('../electron/model.cjs');
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
  for (const c of s.combatants) s = reducer(s, { type: 'token:add', payload: { id: c.id } });
  s = reducer(s, { type: 'token:add', payload: { id: s.combatants[0].id } });
  assert.equal(s.tokens.length, 10);
  assert.equal(new Set(s.tokens.map(t => `${t.col},${t.row}`)).size, 10);
  assert.deepEqual({ col: s.tokens[8].col, row: s.tokens[8].row }, { col: 0, row: 1 });
});
test('Health changes are shared by reference to the combatant id, and can be undone', () => {
  const original = initialState();
  let s = reducer(original, { type: 'combatant:add', payload: { name: 'Орк', maxHp: 30 } });
  const id = s.combatants[0].id;
  s = reducer(s, { type: 'token:add', payload: { id } });
  s = reducer(s, { type: 'combatant:hp', payload: { id, expression: '-8' } });
  assert.equal(s.combatants.find(c => c.id === s.tokens[0].combatantId).hp, 22);
  s = reducer(s, { type: 'combatant:undo' }); assert.equal(s.combatants[0].hp, 30);
  assert.equal(original.combatants.length, 0);
  s = reducer(s, { type: 'combatant:remove', payload: { id } }); assert.equal(s.tokens.length, 0);
});
test('Rounds follow initiative and roll over at the end', () => {
  let s = initialState();
  s = reducer(s, { type: 'combatant:add', payload: { name: 'A', initiative: 3 } });
  s = reducer(s, { type: 'combatant:add', payload: { name: 'B', initiative: 18 } });
  s = reducer(s, { type: 'combat:next' }); assert.equal(s.turn, s.combatants[1].id);
  s = reducer(s, { type: 'combat:next' }); assert.equal(s.turn, s.combatants[0].id);
  s = reducer(s, { type: 'combat:next' }); assert.equal(s.round, 2);
});
test('Grid math respects offset and token movement rejects non-finite coordinates', () => {
  assert.deepEqual(cellAt({ grid: 64, offsetX: 10, offsetY: 20 }, 144, 151), { col: 2, row: 2 });
  let s = reducer(initialState(), { type: 'combatant:add', payload: {} }); const id = s.combatants[0].id;
  s = reducer(s, { type: 'token:add', payload: { id } });
  s = reducer(s, { type: 'token:move', payload: { id, col: -15, row: Infinity } });
  assert.equal(s.tokens[0].col, 0); assert.equal(s.tokens[0].row, 0);
});
test('Layout stays usable and music folder moves persist', () => {
  let s = reducer(initialState(), { type: 'layout:settings', payload: { left: 200, middle: 200, top: 0 } });
  assert.ok(s.layout.left + s.layout.middle <= 82); assert.equal(s.layout.top, 25);
  s = reducer(s, { type: 'music:add', payload: { title: 'Лес', asset: 'test.webm', folder: 'Общее' } });
  s = reducer(s, { type: 'music:move', payload: { id: s.music.tracks[0].id, folder: 'Атмосфера' } });
  assert.equal(s.music.tracks[0].folder, 'Атмосфера');
});
