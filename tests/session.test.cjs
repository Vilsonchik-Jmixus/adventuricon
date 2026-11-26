const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { initialState, activeView, reducer } = require('../electron/model.cjs');
const { createCampaignStore, writeJSON } = require('../electron/campaigns.cjs');
const { rememberMapAction, rememberTravel, undoMapAction } = require('../electron/map-history.cjs');
const { routeDistance } = require('../ui/map-geometry.js');
const { roll, parse } = require('../ui/dice.js');
const { defaults, restoreShortcuts } = require('../ui/shortcuts.js');

test('Map transitions carry selected tokens together and avoid occupied cells on the destination', () => {
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); return activeView(state); };
  const source = state.activeMapId;
  const first = act('combatant:add', { name: 'Следопыт', role: 'player' }).combatants[0].id;
  const second = act('combatant:add', { name: 'Друид', role: 'ally' }).combatants[1].id;
  const guard = act('combatant:add', { name: 'Страж' }).combatants[2].id;
  act('token:add', { id: first, col: 1, row: 0 });
  act('token:add', { id: second, col: 2, row: 0 });
  act('token:add', { id: guard, col: 3, row: 0 });
  const target = act('map:create', { title: 'Подвал', fog: true }).activeMapId;
  act('token:add', { id: guard, col: 4, row: 3 });
  act('token:add', { id: first, col: 8, row: 8 });
  act('terrain:add', { kind: 'wall', a: { x: 256, y: 64 }, b: { x: 256, y: 512 } });
  act('map:select', { id: source });
  const portal = act('terrain:add', { kind: 'portal', a: { x: 160, y: 160 }, name: 'Лестница', targetMapId: target,
    exit: { col: 4, row: 3 } }).terrain[0];
  assert.throws(() => act('terrain:travel', { id: portal.id, ids: ['missing'] }), /Состав жетонов изменился/);
  const before = state.boards;
  const result = act('terrain:travel', { id: portal.id, ids: [first, second] });
  assert.equal(result.activeMapId, target);
  assert.deepEqual(state.boards.find(board => board.id === source).tokens.map(token => token.combatantId), [guard]);
  assert.deepEqual(result.tokens.map(token => token.combatantId), [guard, first, second]);
  assert.equal(new Set(result.tokens.map(token => `${token.col},${token.row}`)).size, 3);
  assert.ok(result.tokens.every(token => token.col >= 4), 'the group arrives on the same side of the wall as the exit');
  assert.ok(result.fog.explored.length);
  const transition = rememberTravel(...before, ...state.boards);
  const arrival = state.boards[1].tokens.find(token => token.combatantId === first);
  act('token:move', { id: first, col: 6, row: 4 });
  assert.throws(() => undoMapAction(state, transition), /последующие перемещения/);
  act('token:move', { id: first, col: arrival.col, row: arrival.row });
  act('token:move', { id: guard, col: 5, row: 3 });
  const restored = undoMapAction(state, transition);
  assert.equal(restored.activeMapId, source);
  assert.deepEqual(restored.boards[0].tokens.find(token => token.combatantId === first), before[0].tokens[0]);
  assert.equal(restored.boards[1].tokens.find(token => token.combatantId === guard).col, 5);
  assert.equal(restored.boards[1].tokens.find(token => token.combatantId === first).col, 8);
  assert.equal(act('map:remove', { id: target }).terrain.length, 0);
});

test('Scene sound presets keep loop ids bounded and leave legacy scene volume behavior intact', () => {
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); return activeView(state); };
  const sound = { loops: ['rain', 'rain', 'dice', 'dungeon'], ambientVolume: .3, musicVolume: .25, loop: false };
  const preset = act('scene:save', { title: 'Пещера', sound }).scenes[0];
  assert.deepEqual(preset.sound, { ...sound, loops: ['rain', 'dungeon'] });
  const playing = act('scene:open', { id: preset.id }).music;
  assert.equal(playing.volume, .25);
  assert.equal(playing.loop, false);
  const legacy = act('scene:save', { title: 'Без пресета' }).scenes.at(-1);
  assert.equal(act('scene:open', { id: legacy.id }).music.volume, .25);
});

test('Dice formulas keep the highest and lowest results and apply signed groups', () => {
  const rolls = [4, 19, 5, 2, 3];
  const result = roll('2d20kh1 + 2d6kl1 − d4 + 3', () => rolls.shift());
  assert.equal(result.total, 21);
  assert.deepEqual(result.groups[0].dice.map(die => die.kept), [false, true]);
  assert.deepEqual(result.groups[1].dice.map(die => die.kept), [false, true]);
  for (const invalid of ['d20d20', '2d20kh3', '101d6', 'd99', '0d6', '2+3']) assert.throws(() => parse(invalid));
  const { dice, ...saved } = defaults;
  const restored = restoreShortcuts({ ...saved, search: dice });
  assert.equal(restored.search, dice);
  assert.notEqual(restored.dice, dice);
});

test('Scenes open their explicit map and battle, with music and a story note', () => {
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); return activeView(state); };
  const map = state.activeMapId, battle = state.activeBattleId;
  const other = act('map:create', { title: 'Порт' }).activeMapId;
  act('battle:save', { linkedMapId: other });
  const note = act('story:save', { title: 'Пароль' }).story.notes[0];
  const track = act('music:add', { asset: 'a.ogg' }).music.tracks[0];
  const scene = act('scene:save', { title: 'Погоня', mapId: map, battleId: battle, noteId: note.id, trackId: track.id }).scenes[0];
  const view = act('scene:open', { id: scene.id });
  assert.equal(view.activeMapId, map);
  assert.equal(view.activeBattleId, battle);
  assert.equal(view.music.current, track.id);
  assert.equal(view.music.playing, true);
  const pinned = act('map:pin', { noteId: note.id, x: 80, y: 40 });
  assert.equal(pinned.notePins[0].noteId, note.id);
  assert.deepEqual(act('story:remove', { id: note.id }).notePins, []);
  assert.equal(activeView(state).scenes[0].noteId, null);
});

test('Ruler measures each leg and an explicit waypoint can go around a wall', () => {
  const start = { col: 1, row: 1 }, corner = { col: 1, row: 2 }, end = { col: 3, row: 2 };
  assert.equal(routeDistance([start, corner, end]), 15);
  assert.equal(routeDistance([{ col: 0, row: 0 }, { col: 1, row: 1 }, { col: 2, row: 2 }], true), 15);
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); return activeView(state); };
  const actor = act('combatant:add', { name: 'Боец' }).combatants[0].id;
  act('token:add', { id: actor, ...start });
  act('terrain:add', { kind: 'wall', a: { x: 128, y: 0 }, b: { x: 128, y: 122 } });
  assert.throws(() => act('token:move', { id: actor, ...end }), /Проход перекрыт/);
  assert.throws(() => act('token:move', { id: actor, ...end, waypoints: [{ col: -1, row: 1 }] }), /Проход перекрыт/);
  assert.equal(act('token:move', { id: actor, ...end, waypoints: [corner] }).tokens[0].col, 3);
});

test('Undo restores one erased stroke and preserves changes outside the map', () => {
  let state = reducer(initialState(), { type: 'map:draw', payload: { points: [{ x: 1, y: 2 }] } });
  const before = state.boards[0];
  const action = { type: 'map:erase', payload: { id: before.drawings[0].id } };
  state = reducer(state, action);
  const entry = rememberMapAction(action, before, state.boards[0]);
  state = reducer(state, { type: 'story:save', payload: { title: 'Позже' } });
  const restored = activeView(undoMapAction(state, entry));
  assert.deepEqual(restored.drawings, before.drawings);
  assert.equal(restored.story.notes[0].title, 'Позже');
});

test('Campaigns keep legacy data separate and import a backup with its media as a new copy', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dm-screen-campaign-'));
  try {
    const manager = createCampaignStore(root);
    const first = manager.load('main');
    const state = reducer(first.state, { type: 'gallery:add', payload: { image: 'a.png', title: 'Первая' } });
    writeJSON(first.file, state);
    await fs.writeFile(path.join(first.assets, 'a.png'), 'media bytes');
    const archive = path.join(root, 'backup.tar.gz');
    await manager.exportArchive(archive, state);
    const next = manager.create('Вторая');
    assert.equal(manager.select(next).state.gallery.length, 0);
    const imported = await manager.importArchive(archive);
    const copy = manager.select(imported);
    assert.equal(copy.state.gallery[0].title, 'Первая');
    assert.equal(await fs.readFile(path.join(copy.assets, 'a.png'), 'utf8'), 'media bytes');
    assert.equal(manager.load('main').state.gallery[0].title, 'Первая');
    assert.equal(createCampaignStore(root).index.active, imported);
    await fs.writeFile(archive, 'broken archive');
    await assert.rejects(manager.importArchive(archive));
    assert.equal(manager.index.profiles.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
