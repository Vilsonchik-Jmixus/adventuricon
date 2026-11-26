const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { initialState, migrateState, reducer } = require('../electron/model.cjs');
const SoundLibrary = require('../ui/sound-library.js');
const { pads, padShortcut } = SoundLibrary;

test('NumPad maps both banks and excludes top-row digits, navigation and extra modifiers', () => {
  assert.equal(new Set(pads.map(([id]) => id)).size, 20);
  for (let i = 0; i < 10; i++) {
    const input = { code: 'Numpad' + i, key: String(i), control: true };
    assert.equal(padShortcut(input), pads[i][0]);
    assert.equal(padShortcut({ ...input, alt: true }), pads[i + 10][0]);
    assert.equal(padShortcut({ ...input, code: 'Digit' + i }), null);
    assert.equal(padShortcut({ ...input, key: 'End' }), null);
    assert.equal(padShortcut({ ...input, shift: true }), null);
  }
});

test('all chip sounds synthesize non-empty, distinct waveforms; only ambient pads loop', () => {
  const samples = [];
  class AudioContext {
    createGain() { return { gain: {}, connect() {} }; }
    createBuffer(_, length) {
      const data = new Float32Array(length);
      samples.push(data);
      return { getChannelData: () => data };
    }
    createBufferSource() {
      return { connect() {}, start() {}, stop() { this.onended(); }, disconnect() {} };
    }
  }
  const script = fs.readFileSync(path.join(__dirname, '../ui/retro-audio.js'), 'utf8');
  const audio = vm.runInNewContext(script + '\ncreateRetroAudio()', { AudioContext, SoundLibrary });
  const sounds = [
    ...pads, ...SoundLibrary.moves.filter(([id]) => id !== 'none'),
    ...SoundLibrary.conditions.map(id => [id]), ['dice'], ['click']
  ];
  for (const [id, , loop] of sounds) {
    assert.equal(audio.play(id), Boolean(loop), id);
    if (loop) assert.equal(audio.play(id, null, true), false, id);
  }
  assert.equal(samples.length, sounds.length);
  const hashes = samples.map(sample => {
    assert.ok(sample.some(amplitude => Math.abs(amplitude) > .04));
    return createHash('sha256').update(Buffer.from(sample.buffer)).digest('hex');
  });
  assert.equal(new Set(hashes).size, sounds.length);
});

test('round actions have an explicit trigger, can be delayed and commit together or leave the map untouched', () => {
  let state = initialState();
  const apply = (type, payload) => { state = reducer(state, { type, payload }); };
  apply('combatant:add', { name: 'Мира' });
  const hero = state.battles[0].combatants[0];
  apply('token:add', { id: hero.id, col: 5, row: 5 });
  apply('library:save', { name: 'Страж', movementSound: 'armor' });
  apply('terrain:add', { kind: 'door', a: { x: 64, y: 64 }, b: { x: 128, y: 64 } });
  apply('music:add', { title: 'Бой', asset: 'test.wav' });
  const templateId = state.library[0].id, doorId = state.boards[0].terrain[0].id, trackId = state.music.tracks[0].id;
  const actions = { mapId: state.activeMapId, templateId, doorId, trackId, cells: [{ col: 4, row: 5 }, { col: 5, row: 5 }] };
  apply('combat:event-save', { title: 'Подкрепление', round: 1, actions });
  const event = state.battles[0].events[0];
  assert.throws(() => apply('combat:event-run', { id: event.id }), /ещё не готово/);
  apply('combat:next');
  apply('combat:event-delay', { id: event.id });
  assert.equal(state.battles[0].events[0].round, 2);
  apply('combat:next');
  assert.throws(() => apply('combat:event-run', { id: event.id }), /занята/);
  assert.equal(state.battles[0].combatants.length, 1);
  assert.equal(state.boards[0].terrain[0].open, false);
  assert.equal(state.music.current, null);
  apply('token:remove', { id: hero.id });
  apply('combat:event-run', { id: event.id });
  assert.equal(state.battles[0].combatants.length, 3);
  assert.equal(state.battles[0].combatants[2].movementSound, 'armor');
  assert.deepEqual(state.boards[0].tokens.map(({ col, row }) => [col, row]), [[4, 5], [5, 5]]);
  assert.equal(state.boards[0].terrain[0].open, true);
  assert.equal(state.music.current, trackId);
  state = migrateState(JSON.parse(JSON.stringify(state)));
  assert.equal(state.battles[0].events[0].executed, true);
  assert.throws(() => apply('combat:event-run', { id: event.id }), /уже запущено/);
});
