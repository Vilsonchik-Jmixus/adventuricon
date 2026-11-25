const assert = require('node:assert/strict');
const { test } = require('node:test');
const { initialState, migrateState, reducer } = require('../electron/model.cjs');
const { searchCampaign } = require('../electron/campaign-search.cjs');
const { defaults, matchShortcut, validateShortcuts } = require('../ui/shortcuts.js');

test('round events are specific to a battle, journaled once, and rearmed after initiative reset', () => {
  let state = initialState();
  const apply = (type, payload) => { state = reducer(state, { type, payload }); };
  const firstBattle = state.activeBattleId;
  apply('journal:session', { title: 'Ночная игра' });
  apply('combatant:add', { name: 'Страж' });
  apply('combat:event-save', { title: 'Огонь в башне', round: 2 });
  apply('combat:next');
  assert.equal(state.journal.sessions[0].entries.length, 0);
  apply('battle:create', { title: 'Другой бой' });
  apply('combatant:add', { name: 'Волк' });
  apply('combat:next');
  apply('combat:next');
  assert.equal(state.journal.sessions[0].entries.length, 0);
  apply('battle:select', { id: firstBattle });
  apply('combat:next');
  apply('combat:next');
  assert.deepEqual(state.journal.sessions[0].entries.map(item => item.kind), ['event']);
  assert.match(state.journal.sessions[0].entries[0].body, /Раунд 2.*Огонь в башне/);
  state = migrateState(JSON.parse(JSON.stringify(state)));
  apply('combat:reset-initiative');
  assert.equal(state.battles[0].events[0].fired, false);
  apply('journal:activate', { id: null });
  apply('combat:next');
  apply('combat:next');
  assert.equal(state.battles[0].events[0].fired, true);
  assert.equal(state.journal.sessions[0].entries.length, 1);
});

test('campaign search finds off-battle actors, text in notes and journal entries', () => {
  let state = initialState();
  const apply = (type, payload) => { state = reducer(state, { type, payload }); };
  const oldBattle = state.activeBattleId;
  apply('combatant:add', { name: 'Орёл' });
  apply('battle:create', { title: 'Лес' });
  apply('story:save', { title: 'Лес', body: 'Тайная дверь у реки' });
  apply('journal:session', { title: 'Ночная игра' });
  apply('journal:save', { sessionId: state.journal.active, body: 'Ключ передали орлу' });
  assert.equal(searchCampaign(state, 'ОРЕЛ')[0].parentId, oldBattle);
  assert.equal(searchCampaign(state, 'дверь реки')[0].kind, 'note');
  assert.equal(searchCampaign(state, 'ключ')[0].kind, 'entry');
  assert.deepEqual(searchCampaign(state, 'неизвестно'), []);
});

test('shortcut preferences reject duplicates and use physical Ctrl Alt letter combinations', () => {
  assert.ok(validateShortcuts(defaults));
  assert.equal(validateShortcuts({ ...defaults, search: defaults.journal }), null);
  const preferences = validateShortcuts({ ...defaults, search: 'Q' });
  assert.equal(matchShortcut({ code: 'KeyQ', ctrlKey: true, altKey: true }, preferences), 'search');
  assert.equal(matchShortcut({ code: 'KeyK', control: true, alt: true }, preferences), null);
  assert.equal(matchShortcut({ code: 'KeyQ', control: true }, preferences), null);
});
