const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { initialState, activeView, reducer } = require('../electron/model.cjs');
const { createCampaignStore, writeJSON } = require('../electron/campaigns.cjs');
const { rememberMapAction, undoMapAction } = require('../electron/map-history.cjs');
const { routeDistance } = require('../ui/map-geometry.js');

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
