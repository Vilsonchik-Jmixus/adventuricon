const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { initialState, migrateState, reducer } = require('../electron/model.cjs');
const { encodeCampaign } = require('../electron/campaigns.cjs');
const { youtubeVideoId } = require('../electron/music-import.cjs');
const SoundLibrary = require('../ui/sound-library.js');
const { pads, padShortcut } = SoundLibrary;

test('YouTube import canonicalizes common video links and rejects other hosts and playlists', () => {
  const id = 'aqz-KE-bpKQ';
  for (const url of [
    `https://www.youtube.com/watch?v=${id}&list=example`,
    `youtu.be/${id}/?si=example`,
    `http://music.youtube.com/watch/?v=${id}`,
    `https://youtube.com/shorts/${id}/`,
    `https://m.youtube.com/live/${id}`,
    `https://youtube.com/embed/${id}`
  ]) assert.equal(youtubeVideoId(url), id, url);
  for (const url of ['https://www.youtube.com/playlist?list=example',
    `https://youtube.com.example.org/watch?v=${id}`, `https://name@youtu.be/${id}`,
    `https://youtu.be:1234/${id}`, 'https://youtu.be/short', undefined]) {
    assert.equal(youtubeVideoId(url), null, url);
  }
});

test('music changes preserve unrelated campaign data and remove deleted tracks from battle events', () => {
  let state = initialState();
  const run = (type, payload) => { state = reducer(state, { type, payload }); };
  run('music:add', { title: 'Таверна', asset: 'track.mp3' });
  const track = state.music.tracks[0];
  run('combat:event-save', { title: 'Музыка', round: 1, actions: { trackId: track.id } });
  const board = state.boards[0];
  const previous = state;
  encodeCampaign(previous);
  run('music:settings', { volume: .3 });
  assert.equal(state.music.tracks, previous.music.tracks);
  run('music:move', { id: track.id, folder: 'Бой' });
  assert.equal(track.folder, 'Общее');
  assert.equal(JSON.parse(encodeCampaign(state)).music.tracks[0].folder, 'Бой');
  run('music:remove', { id: track.id });
  assert.equal(state.battles[0].events[0].actions, null);
  assert.equal(previous.battles[0].events[0].actions.trackId, track.id);
  assert.equal(state.boards[0], board);
});

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
    createGain() { return { gain: { setTargetAtTime() {}, cancelScheduledValues() {} }, connect() {}, disconnect() {} }; }
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
