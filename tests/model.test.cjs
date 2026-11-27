const { test } = require('node:test');
const assert = require('node:assert/strict');
const { initialState, migrateState, activeView, reducer, hpValue, cellAt } = require('../electron/model.cjs');
const { CONDITIONS, playerMapActors } = require('../electron/combat-rules.cjs');
const { REFERENCE_LINKS, safeUrl, searchUrl } = require('../electron/reference.cjs');
const MapGeometry = require('../ui/map-geometry.js');
const { readCharacter } = require('../electron/lss-import.cjs');
const { encodeCampaign } = require('../electron/campaigns.cjs');
const { publicDndUrl } = require('../electron/dnd-import.cjs');
test('Workspace presets retain separate sizes after switching and reloading an older layout', () => {
  let state = migrateState({ ...initialState(), layout: { left: 31, middle: 36, top: 56, windows: {} } });
  const act = (type, payload) => { state = reducer(state, { type, payload }); };
  act('layout:mode', { mode: 'preparation' });
  act('layout:settings', { left: 27, middle: 43, top: 62 });
  act('layout:mode', { mode: 'game' });
  act('layout:settings', { left: 34 });
  const layout = migrateState(JSON.parse(encodeCampaign(state))).layout;
  assert.equal(layout.mode, 'game');
  assert.deepEqual([layout.left, layout.middle, layout.top], [34, 36, 56]);
  assert.deepEqual(layout.preparation, { left: 27, middle: 43, top: 62 });
});
test('Conditions count completed rounds, keep permanent effects and survive save and initiative reset', () => {
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); };
  act('combatant:add', { name: 'Мира' });
  act('combatant:add', { name: 'Страж' });
  const [first] = activeView(state).combatants;
  act('combatant:conditions', { id: first.id, conditions: ['prone', 'poisoned'], exhaustion: 2,
    durations: { prone: 2, exhaustion: 1, blinded: 1 } });
  act('combat:next');
  act('combat:next');
  assert.deepEqual(activeView(state).combatants[0].durations, { prone: 2, exhaustion: 1 });
  act('combat:next');
  assert.deepEqual(activeView(state).combatants[0].durations, { prone: 1 });
  assert.equal(activeView(state).combatants[0].exhaustion, 0);
  state = migrateState(JSON.parse(encodeCampaign(state)));
  act('combat:reset-initiative');
  assert.equal(activeView(state).combatants[0].effects.find(effect => effect.id === 'prone').rounds, 1);
  for (let i = 0; i < 3; i++) act('combat:next');
  assert.deepEqual(activeView(state).combatants[0].conditions, ['poisoned']);
  assert.deepEqual(activeView(state).combatants[0].durations, {});
});
test('Story cards, connections and drawings survive reload while deleting a card removes its links', () => {
  let s = migrateState({ ...initialState(), story: undefined });
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s).story; };
  const first = act('story:save', { title: 'У ворот', body: '— Кто там?\n— Свои.', x: 20, y: 30 }).notes[0];
  const second = act('story:save', { title: 'Пароль', body: 'Три стука.', x: 300, y: 50 }).notes[1];
  act('story:link', { from: first.id, to: second.id });
  assert.equal(act('story:link', { from: second.id, to: first.id }).links.length, 1);
  act('story:move', { id: first.id, x: -83, y: 45146 });
  act('story:save', { id: second.id, title: 'Знак', body: second.body });
  act('story:draw', { points: [[-20, 44040], [55, 44074]], color: '#cc4422', width: 4 });
  s = migrateState(JSON.parse(JSON.stringify(s)));
  const story = activeView(s).story;
  assert.deepEqual(story.notes[0], { ...first, x: -83, y: 45146 });
  assert.equal(story.notes[1].title, 'Знак');
  assert.equal(story.notes[1].x, 300);
  assert.equal(story.links[0].to, second.id);
  assert.deepEqual(story.strokes[0].points, [[-20, 44040], [55, 44074]]);
  assert.equal(act('story:erase', { ids: [story.strokes[0].id] }).strokes.length, 0);
  assert.equal(act('story:remove', { id: first.id }).links.length, 0);
  assert.equal(activeView(s).story.notes[0].id, second.id);
});
test('HP commands, bounds and invalid expressions', () => {
  assert.equal(hpValue(12, 20, '-7'), 5);
  assert.equal(hpValue(12, 20, '+99'), 20);
  assert.equal(hpValue(12, 20, '-99'), 0);
  assert.equal(hpValue(12, 20, '=17'), 17);
  assert.throws(() => hpValue(12, 20, '7+4'));
  assert.throws(() => hpValue(12, 20, 'NaN'));
});
test('Map drawings migrate, stay attached to their map and can be erased from a copy', () => {
  const previous = initialState();
  delete previous.boards[0].drawings;
  let s = migrateState(previous);
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  const original = s.activeMapId;
  assert.deepEqual(activeView(s).drawings, []);
  const points = [{ x: 25, y: 40 }, { x: 70, y: 45 }];
  const [stroke] = act('map:draw', { points, expectedMapId: original, color: '#e7354c', width: 12 }).drawings;
  const copy = act('map:duplicate', {}).activeMapId;
  assert.notEqual(copy, original);
  assert.deepEqual(activeView(s).drawings, [stroke]);
  assert.throws(() => act('map:draw', { points, expectedMapId: original }), /Карта переключилась/);
  assert.deepEqual(act('map:erase', { id: stroke.id, expectedMapId: copy }).drawings, []);
  s = migrateState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(act('map:select', { id: original }).drawings, [stroke]);
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
test('Templates deploy independent actors and explicit token cells stay with each map', () => {
  let s = migrateState({ ...initialState(), library: undefined });
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  const firstMap = s.activeMapId;
  const template = act('library:save', { name: 'Гоблин', role: 'enemy', maxHp: 18, initiativeBonus: 3 }).library[0];
  const first = act('library:deploy', { id: template.id, place: true, col: 3, row: 2 }).combatants[0];
  assert.throws(() => act('library:deploy', { id: template.id, place: true, col: 3, row: 2 }), /занята/);
  const secondMap = act('map:create', { title: 'Мост' }).activeMapId;
  act('token:add', { id: first.id, col: 7, row: 4 });
  const copies = act('library:deploy', { id: template.id, place: true, col: 2, row: 1 }).combatants;
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].id, copies[1].id);
  act('combatant:hp', { id: first.id, expression: '-5' });
  act('library:remove', { id: template.id });
  s = migrateState(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(act('map:select', { id: firstMap }).tokens, [{ combatantId: first.id, col: 3, row: 2 }]);
  assert.deepEqual(act('token:remove', { id: first.id }).combatants.map(actor => actor.hp), [13, 18]);
  assert.equal(act('map:select', { id: secondMap }).tokens.length, 2);
});
test('Closed doors block path and sight; fog is optional, remembered and reset per board', () => {
  let s = initialState();
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  const mapId = act('map:create', { title: 'Подземелье', fog: true }).activeMapId;
  const hero = act('combatant:add', { name: 'Лучник', role: 'player' }).combatants[0].id;
  act('terrain:add', { kind: 'wall', a: { x: 128, y: 0 }, b: { x: 128, y: 64 } });
  const door = act('terrain:add', { kind: 'door', a: { x: 128, y: 64 }, b: { x: 128, y: 192 } }).terrain[1];
  act('terrain:add', { kind: 'wall', a: { x: 128, y: 192 }, b: { x: 128, y: 1700 } });
  act('terrain:add', { kind: 'light', a: { x: 96, y: 96 }, radius: 128 });
  const closed = act('token:add', { id: hero, col: 1, row: 1 });
  assert.ok(closed.fog.explored.includes('1,7'));
  assert.ok(!closed.fog.explored.includes('1,8'));
  assert.ok(!closed.fog.explored.includes('2,1'));
  assert.throws(() => act('token:move', { id: hero, col: 3, row: 1 }), /Проход перекрыт/);
  const nearby = MapGeometry.blockingWalls(closed.terrain);
  assert.equal(nearby.length, 3);
  assert.ok(MapGeometry.lightPolygon({ x: 96, y: 96 }, 128, nearby).every(point => point.x <= 128.01 || point.y < 0));
  act('terrain:door', { id: door.id });
  assert.ok(act('token:move', { id: hero, col: 3, row: 1 }).fog.explored.includes('2,1'));
  act('terrain:door', { id: door.id });
  const reset = act('fog:reset');
  assert.ok(!reset.fog.explored.includes('1,1'));
  assert.ok(reset.fog.explored.includes('3,1'));
  assert.equal(act('map:create', { title: 'Двор' }).fog.enabled, false);
  assert.ok(act('map:select', { id: mapId }).fog.explored.includes('3,1'));
  assert.equal(act('fog:enabled', { enabled: false }).fog.enabled, false);
  assert.ok(act('fog:enabled', { enabled: true }).fog.explored.includes('3,1'));
});
test('placed tokens remember elevation and override the sight of their prototype for one map', () => {
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); return activeView(state); };
  const mapId = act('fog:enabled', { enabled: true }).activeMapId;
  const id = act('combatant:add', { name: 'Лучник', role: 'player', visionFeet: 40 }).combatants[0].id;
  assert.ok(act('token:add', { id, col: 4, row: 4 }).fog.explored.includes('12,4'));
  act('token:settings', { id, elevation: -15, visionFeet: 10 });
  assert.ok(!act('fog:reset').fog.explored.includes('7,4'));
  state = migrateState(JSON.parse(encodeCampaign(state)));
  assert.equal(activeView(state).tokens[0].elevation, -15);
  const fog = activeView(state).fog;
  assert.equal(act('token:settings', { id, elevation: 55 }).fog, fog);
  act('map:create', { title: 'Двор', fog: true });
  assert.ok(act('token:add', { id, col: 4, row: 4 }).fog.explored.includes('12,4'));
  assert.equal(act('map:select', { id: mapId }).tokens[0].visionFeet, 10);
  assert.ok(act('token:settings', { id, visionFeet: null }).fog.explored.includes('12,4'));
});

test('measurement templates are saved separately for each map and can be removed without changing tokens', () => {
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); return activeView(state); };
  const firstMap = state.activeMapId;
  const [circle] = act('template:add', { kind: 'circle', x: 96, y: 128, feet: 35 }).templates;
  assert.equal(act('map:create', { title: 'Двор' }).templates.length, 0);
  assert.throws(() => act('template:remove', { id: circle.id, expectedMapId: firstMap }), /Карта переключилась/);
  state = migrateState(JSON.parse(encodeCampaign(state)));
  const restored = act('map:select', { id: firstMap });
  assert.deepEqual(restored.templates, [circle]);
  const cleared = act('template:remove', { id: circle.id });
  assert.equal(cleared.templates.length, 0);
  assert.equal(cleared.tokens, restored.tokens);
});
test('Window walls stop tokens and allow sight and light from nearby origins', () => {
  let s = initialState();
  const act = (type, payload) => { s = reducer(s, { type, payload }); return activeView(s); };
  act('fog:enabled', { enabled: true });
  const hero = act('combatant:add', { name: 'Лучник', role: 'player' }).combatants[0].id;
  const [window] = act('terrain:add', { kind: 'window', a: { x: 128, y: 0 }, b: { x: 128, y: 1200 } }).terrain;
  const near = act('token:add', { id: hero, col: 1, row: 2 });
  assert.ok(near.fog.explored.includes('2,2'));
  const walls = MapGeometry.blockingWalls(near.terrain);
  assert.ok(MapGeometry.lightPolygon({ x: 96, y: 160 }, 150, walls, 64).some(point => point.x > 128));
  assert.ok(MapGeometry.lightPolygon({ x: 32, y: 160 }, 150, walls, 64).every(point => point.x <= 128.01));
  assert.throws(() => act('token:move', { id: hero, col: 2, row: 2 }), /Проход перекрыт/);
  act('token:move', { id: hero, col: 0, row: 2 });
  assert.ok(!act('fog:reset').fog.explored.includes('2,2'));
  act('terrain:remove', { id: window.id });
  assert.equal(act('token:move', { id: hero, col: 2, row: 2 }).tokens[0].col, 2);
});
test('Long Story Short export imports current and maximum HP, portrait bytes and initiative bonus', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jp2sAAAAASUVORK5CYII=';
  const data = { name: { value: 'Лучник' }, stats: { dex: { score: 16 } }, proficiency: 2,
    vitality: { 'hp-current': { value: 9 }, 'hp-max': { value: 15 }, initiative: { value: '[DEX] + [PROF]' } },
    avatar: { webp: 'https://example.invalid/image.webp', png: `data:image/png;base64, ${png}` } };
  const result = readCharacter(JSON.stringify({ jsonType: 'character', data: JSON.stringify(data) }));
  assert.equal(result.name, 'Лучник');
  assert.equal(result.hp, 9);
  assert.equal(result.maxHp, 15);
  assert.equal(result.initiativeBonus, 5);
  assert.equal(result.portrait.bytes.toString('base64'), png);
  assert.equal(result.portrait.extension, '.png');
  assert.equal(readCharacter(JSON.stringify({ jsonType: 'character', data: { ...data, avatar: null } })).portrait, null);
  assert.equal(result.initiativeNeedsReview, false);
  assert.throws(() => readCharacter('{}'), /Long Story Short/);
});
test('Initiative reset restarts only the current battle without clearing health or placed tokens', () => {
  let state = initialState();
  const act = (type, payload) => { state = reducer(state, { type, payload }); };
  act('combatant:add', { name: 'Лучник', role: 'player' });
  act('combatant:add', { name: 'Волк', initiativeBonus: 3 });
  const [player, enemy] = activeView(state).combatants;
  act('combatant:hp', { id: enemy.id, expression: '-2' });
  act('combatant:conditions', { id: enemy.id, conditions: ['prone'] });
  act('token:add', { id: enemy.id });
  act('combat:initiative', { id: player.id, value: 14 });
  act('combat:roll-initiative', { id: enemy.id });
  act('combat:move', { id: activeView(state).order[0], delta: 1 });
  for (let i = 0; i < 3; i++) act('combat:next');
  assert.equal(activeView(state).round, 2);
  const previous = state;
  act('combat:reset-initiative');
  const view = activeView(state);
  assert.deepEqual([view.round, view.turn, view.acted, view.manualOrder], [1, null, [], false]);
  assert.ok(view.combatants.every(actor => actor.initiative === null && actor.initiativeRoll === null));
  assert.deepEqual(view.order, [player.id, enemy.id]);
  assert.deepEqual([view.combatants[1].hp, view.combatants[1].initiativeBonus, view.combatants[1].conditions], [8, 3, ['prone']]);
  assert.equal(view.tokens, activeView(previous).tokens);
  assert.equal(previous.battles[0].round, 2);
});
test('Frequent edits reuse large collections and serialize the latest immutable draft', () => {
  const act = (s, type, payload) => reducer(s, { type, payload });
  let previous = act(initialState(), 'combatant:add', { name: 'Страж', role: 'player' });
  const [actor] = activeView(previous).combatants;
  previous = act(previous, 'token:add', { id: actor.id, col: 4, row: 4 });
  previous = act(previous, 'fog:enabled', { enabled: true });
  previous = act(previous, 'story:save', { title: 'Таверна', body: 'Записка', images: ['abc.webp', 'def.png'] });
  previous = act(previous, 'map:draw', { points: [{ x: 2, y: 5 }, { x: 150, y: 260 }] });
  const before = activeView(previous);
  const saved = JSON.parse(encodeCampaign(previous));
  const music = act(previous, 'music:settings', { volume: 0.4 });
  const musicView = activeView(music);
  for (const key of ['combatants', 'tokens', 'story', 'drawings', 'fog', 'mapCombatants', 'mapChoices', 'battleChoices']) {
    assert.equal(musicView[key], before[key]);
  }
  const injured = act(music, 'combatant:hp', { id: actor.id, expression: '-1' });
  assert.equal(activeView(injured).fog, before.fog);
  const moved = act(injured, 'token:move', { id: actor.id, col: 20, row: 21 });
  assert.equal(activeView(moved).drawings, before.drawings);
  assert.equal(activeView(moved).tokens[0].col, 20);
  assert.ok(activeView(moved).fog.explored.includes('20,21'));
  const note = activeView(moved).story.notes[0];
  const edited = act(moved, 'story:save', { id: note.id, title: 'Мост', body: note.body });
  assert.deepEqual(activeView(edited).story.notes[0].images, ['abc.webp', 'def.png']);
  assert.deepEqual(JSON.parse(encodeCampaign(edited)), JSON.parse(JSON.stringify(edited)));
  assert.deepEqual(JSON.parse(encodeCampaign(previous)), saved);
});
test('Reference imports are restricted to individual public DnD.su cards and gallery images', () => {
  assert.equal(publicDndUrl('https://dnd.su/bestiary/4-goblin?ref=1#top', 'creature'), 'https://dnd.su/bestiary/4-goblin/');
  assert.ok(publicDndUrl('https://next.dnd.su/items/16522-potion-of-healing/', 'item'));
  assert.equal(publicDndUrl('https://dnd.su.evil.test/bestiary/4-goblin/', 'creature'), null);
  assert.equal(publicDndUrl('https://dnd.su/items/', 'item'), null);
  assert.equal(publicDndUrl('https://dnd.su/gallery/bestiary/test.svg', 'portrait'), null);
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
