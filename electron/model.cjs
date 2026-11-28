const { randomUUID, randomInt } = require('node:crypto');
const { roleOf, effectsFor, MANUAL_IDS, revealsFog } = require('./combat-rules.cjs');
const { blockingWalls, validCell, routeBlocked, distanceToSegment, visibleCells, footprintsOverlap } = require('../ui/map-geometry.js');
const { moveSound, ambientIds } = require('../ui/sound-library.js');
const TokenStyle = require('../ui/token-style.js');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const text = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const newFog = (enabled = false) => ({ enabled, explored: [] });
const newStory = () => ({ notes: [], links: [], strokes: [] });
const newJournal = () => ({ active: null, sessions: [] });
const journalEntry = (body, kind = 'note') => ({ id: randomUUID(), body, kind, date: new Date().toISOString() });
const storyCoordinate = n => clamp(Math.round(finite(n, 0)), -1000000, 1000000);
const gameSizes = { left: 30, middle: 43, top: 65 };
const preparationSizes = { left: 25, middle: 47, top: 53 };
function restoreLayout(saved = {}) {
  return { ...gameSizes, windows: {}, ...saved, mode: saved.mode === 'preparation' ? 'preparation' : 'game',
    preparation: { ...preparationSizes, ...saved.preparation } };
}
function newBattle(title = 'Первый бой') {
  return { id: randomUUID(), title, linkedMapId: null, combatants: [], round: 1, turn: null, acted: [], manualOrder: null, history: [], events: [] };
}
function newBoard(title = 'Первая карта', demo = false) {
  return {
    id: randomUUID(), title, tokens: [], terrain: [], drawings: [], templates: [], notePins: [], fog: newFog(),
    map: { image: null, demo, grid: 64, offsetX: 0, offsetY: 0, opacity: 0.3, color: '#d8e6e0', visible: true, zoom: 1 }
  };
}
function initialState() {
  const battle = newBattle(), board = newBoard(undefined, true);
  return {
    schema: 2, revision: 0, battles: [battle], boards: [board],
    activeBattleId: battle.id, activeMapId: board.id, gallery: [], bookmarks: [], library: [], story: newStory(), scenes: [], journal: newJournal(),
    music: { folders: ['Общее', 'Бой', 'Атмосфера'], tracks: [], current: null, playing: false, volume: 0.55, loop: true },
    layout: restoreLayout()
  };
}
function migrateState(saved) {
  if (!saved || !saved.music || !saved.layout) throw new Error('Неверный формат сохранения');
  if (saved.schema === 2) {
    if (!Array.isArray(saved.battles) || !Array.isArray(saved.boards) ||
        !saved.battles.some(battle => battle.id === saved.activeBattleId) ||
        !saved.boards.some(board => board.id === saved.activeMapId)) {
      throw new Error('Бои или карты повреждены');
    }
    return { ...saved, layout: restoreLayout(saved.layout), battles: saved.battles.map(restoreRound), bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks : [],
      library: Array.isArray(saved.library) ? saved.library : [],
      story: { ...newStory(), ...saved.story },
      journal: Array.isArray(saved.journal?.sessions) ? saved.journal : newJournal(),
      scenes: Array.isArray(saved.scenes) ? saved.scenes : [],
      boards: saved.boards.map(board => ({ terrain: [], drawings: [], notePins: [], fog: newFog(), ...board,
        templates: Array.isArray(board.templates) ? board.templates : [] })) };
  }
  if (saved.schema !== 1 || !Array.isArray(saved.combatants) || !Array.isArray(saved.tokens) || !saved.map) {
    throw new Error('Неверный формат сохранения');
  }
  const { combatants, tokens, map, round, turn, history, gallery, ...base } = saved;
  const battle = restoreRound({ ...newBattle('Текущий бой'), acted: undefined,
    combatants, round: round ?? 1, turn: turn ?? null, history: history ?? [] });
  const board = { ...newBoard('Текущая карта'), map, tokens };
  return {
    ...base, schema: 2, layout: restoreLayout(base.layout), gallery: gallery ?? [], bookmarks: [], library: [], story: newStory(), scenes: [], journal: newJournal(),
    battles: [battle], boards: [board], activeBattleId: battle.id, activeMapId: board.id
  };
}
function battleOrder({ combatants, manualOrder }) {
  const byInitiative = [...combatants].sort((a, b) =>
    (b.initiative ?? -Infinity) === (a.initiative ?? -Infinity) ? 0 : (b.initiative ?? -Infinity) - (a.initiative ?? -Infinity));
  if (!manualOrder) return byInitiative;
  const ranks = new Map(manualOrder.map((id, index) => [id, index]));
  return byInitiative.sort((a, b) => {
    const first = ranks.get(a.id) ?? Infinity, second = ranks.get(b.id) ?? Infinity;
    return first === second ? 0 : first - second;
  });
}
function restoreRound(battle) {
  if (!Array.isArray(battle.events)) battle = { ...battle, events: [] };
  if (Array.isArray(battle.acted)) return battle;
  const ordered = battleOrder(battle);
  const current = ordered.findIndex(c => c.id === battle.turn);
  return { ...battle, acted: current > 0 ? ordered.slice(0, current).map(c => c.id) : [], manualOrder: null };
}
const actorViews = new WeakMap();
function describe(c) {
  if (!actorViews.has(c)) actorViews.set(c, { ...c, role: roleOf(c.role), initiativeBonus: c.initiativeBonus ?? 0, effects: effectsFor(c) });
  return actorViews.get(c);
}
let lastView, lastViewState;
const sameEntries = (first, second) => first?.length === second.length && second.every((entry, index) => entry === first[index]);
function choicesFor(entries, previous, choices, battle = false) {
  if (entries === previous) return choices;
  if (entries.length === choices?.length && entries.every(({ id, title, linkedMapId }, i) =>
    id === choices[i].id && title === choices[i].title && (!battle || linkedMapId === choices[i].linkedMapId))) return choices;
  return battle ? entries.map(({ id, title, linkedMapId }) => ({ id, title, linkedMapId })) : entries.map(({ id, title }) => ({ id, title }));
}
function activeView(state) {
  if (state === lastViewState) return lastView;
  const battle = state.battles.find(entry => entry.id === state.activeBattleId);
  const board = state.boards.find(entry => entry.id === state.activeMapId);
  const previousBattle = lastViewState?.battles.find(entry => entry.id === battle.id);
  const previousBoard = lastViewState?.boards.find(entry => entry.id === board.id);
  const rosterChanged = previousBattle?.combatants !== battle.combatants || lastView?.activeBattleId !== battle.id;
  const mapActorsChanged = lastViewState?.battles !== state.battles || lastView?.activeMapId !== board.id ||
    (previousBoard?.tokens !== board.tokens && !sameEntries(previousBoard?.tokens.map(token => token.combatantId),
      board.tokens.map(token => token.combatantId)));
  let mapCombatants = lastView?.mapCombatants, visionOrigins = lastView?.visionOrigins;
  if (mapActorsChanged) {
    const placed = new Set(board.tokens.map(token => token.combatantId));
    const actors = state.battles.flatMap(entry => entry.combatants.filter(c => placed.has(c.id)).map(describe));
    if (!sameEntries(mapCombatants, actors)) mapCombatants = actors;
  }
  if (mapActorsChanged || previousBoard?.tokens !== board.tokens &&
      !sameEntries(previousBoard?.tokens.map(token => !!token.hidden), board.tokens.map(token => !!token.hidden))) {
    const hidden = new Set(board.tokens.filter(token => token.hidden).map(token => token.combatantId));
    const origins = mapCombatants.filter(actor => !hidden.has(actor.id) && revealsFog(actor)).map(actor => actor.id);
    if (!sameEntries(visionOrigins, origins)) visionOrigins = origins;
  }
  const nextOrder = rosterChanged || previousBattle?.manualOrder !== battle.manualOrder ? battleOrder(battle).map(c => c.id) : lastView.order;
  lastView = {
    revision: state.revision, music: state.music, layout: state.layout, gallery: state.gallery, bookmarks: state.bookmarks, library: state.library, story: state.story,
    activeBattleId: battle.id, activeMapId: board.id, scenes: state.scenes, notePins: board.notePins,
    battleChoices: choicesFor(state.battles, lastViewState?.battles, lastView?.battleChoices, true),
    mapChoices: choicesFor(state.boards, lastViewState?.boards, lastView?.mapChoices),
    combatants: rosterChanged ? battle.combatants.map(describe) : lastView.combatants,
    order: sameEntries(lastView?.order, nextOrder) ? lastView.order : nextOrder,
    manualOrder: !!battle.manualOrder,
    round: battle.round, turn: battle.turn, acted: battle.acted, history: battle.history, roundEvents: battle.events, journal: state.journal,
    map: board.map, tokens: board.tokens, terrain: board.terrain, drawings: board.drawings, templates: board.templates, fog: board.fog,
    mapCombatants, visionOrigins
  };
  lastViewState = state;
  return lastView;
}
function hpValue(current, max, expression) {
  const s = String(expression).trim();
  if (!/^(?:[+-]\d+|=\d+|\d+)$/.test(s)) throw new Error('Введите -7, +5 или =20');
  const value = s.startsWith('=') ? Number(s.slice(1)) : /^[+-]/.test(s) ? current + Number(s) : Number(s);
  if (!Number.isSafeInteger(value)) throw new Error('Слишком большое число');
  return clamp(value, 0, max);
}
function cellAt(map, x, y) {
  return { col: Math.max(0, Math.floor((x - map.offsetX) / map.grid)), row: Math.max(0, Math.floor((y - map.offsetY) / map.grid)) };
}
function rememberHealth(battle, combatant) {
  battle.history.push({ id: combatant.id, hp: combatant.hp, maxHp: combatant.maxHp });
  battle.history = battle.history.slice(-50);
}
const initiativeBonus = (value, fallback = 0) => clamp(Math.round(finite(value, fallback)), -50, 50);
function copyCombatant(c, name = c.name) {
  return { ...c, id: randomUUID(), name, hp: c.maxHp, conditions: [], durations: {}, exhaustion: 0, initiativeRoll: null };
}
function conditionDurations(actor, durations) {
  const ids = actor.exhaustion > 0 ? [...actor.conditions, 'exhaustion'] : actor.conditions;
  return Object.fromEntries(ids.flatMap(id => {
    const rounds = durations?.[id];
    return Number.isInteger(rounds) && rounds >= 1 && rounds <= 99 ? [[id, rounds]] : [];
  }));
}
function advanceConditions(actor) {
  if (!actor.durations || !Object.keys(actor.durations).length) return actor;
  const next = { ...actor, conditions: actor.conditions.filter(id => actor.durations[id] !== 1),
    exhaustion: actor.durations.exhaustion === 1 ? 0 : actor.exhaustion };
  next.durations = conditionDurations(next, Object.fromEntries(
    Object.entries(actor.durations).map(([id, rounds]) => [id, rounds - 1])
  ));
  return next;
}
function characterFields(p) {
  return { name: text(p.name) || 'Безымянный', image: text(p.image, 100) || null,
    maxHp: clamp(Math.round(finite(p.maxHp, 10)), 1, 999999), role: roleOf(p.role),
    initiativeBonus: initiativeBonus(p.initiativeBonus), movementSound: moveSound(p.movementSound),
    tokenSize: TokenStyle.size(p.tokenSize), tokenFrame: TokenStyle.frame(p.tokenFrame)[0], visionFeet: TokenStyle.vision(p.visionFeet) };
}
function newCombatant(fields, hp = fields.maxHp) {
  return { ...fields, id: randomUUID(), hp, initiative: null, conditions: [], exhaustion: 0 };
}
const cellIndex = n => clamp(Math.round(finite(n, 0)), 0, 2000);
function tokenSizes(state) {
  return new Map(state.battles.flatMap(battle => battle.combatants.map(actor => [actor.id, TokenStyle.size(actor.tokenSize)])));
}
function tokenSizeFor(state, id) {
  for (const battle of state.battles) {
    const actor = battle.combatants.find(actor => actor.id === id);
    if (actor) return TokenStyle.size(actor.tokenSize);
  }
  return 1;
}
function placeToken(board, id, { col, row }, sizes, size) {
  if (board.tokens.some(t => t.combatantId === id)) return;
  const occupied = board.tokens.map(token => ({ ...token, size: sizes.get(token.combatantId) ?? 1 }));
  const fits = (col, row) => !occupied.some(token => footprintsOverlap({ col, row, size }, token));
  if (Number.isFinite(col) && Number.isFinite(row)) {
    col = cellIndex(col);
    row = cellIndex(row);
    if (!fits(col, row)) throw new Error('Эта клетка занята');
  } else {
    let index = 0;
    while (!fits(index % 8, Math.floor(index / 8))) index++;
    col = index % 8;
    row = Math.floor(index / 8);
  }
  board.tokens.push({ combatantId: id, col, row });
}
function portalCells(target, exit, tokens, sizes) {
  const moving = new Set(tokens.map(token => token.combatantId));
  const occupied = target.tokens.filter(token => !moving.has(token.combatantId)).map(token => ({ ...token, size: sizes.get(token.combatantId) ?? 1 }));
  const walls = blockingWalls(target.terrain);
  const exits = [];
  const candidates = [];
  for (let radius = 0; radius <= 12; radius++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const cell = { col: exit.col + dx, row: exit.row + dy };
        if (validCell(cell)) candidates.push(cell);
      }
    }
  }
  for (const token of tokens) {
    const size = sizes.get(token.combatantId) ?? 1;
    const cell = candidates.find(cell => !occupied.some(other => footprintsOverlap({ ...cell, size }, other)) &&
      !routeBlocked(target.map, walls, [exit, cell], size));
    if (!cell) throw new Error('Рядом с выходом не хватает свободных клеток');
    occupied.push({ ...cell, size });
    exits.push({ ...token, ...cell });
  }
  return exits;
}
function eventActions(payload, state) {
  const templateId = typeof payload.templateId === 'string' && payload.templateId || null;
  const doorId = typeof payload.doorId === 'string' && payload.doorId || null;
  const trackId = typeof payload.trackId === 'string' && payload.trackId || null;
  const map = state.boards.find(board => board.id === payload.mapId);
  const cells = Array.isArray(payload.cells) ? payload.cells : [];
  if (templateId && (!state.library.some(item => item.id === templateId) || !cells.length || cells.length > 12 ||
      cells.some(cell => !validCell(cell)) || new Set(cells.map(cell => `${cell.col},${cell.row}`)).size !== cells.length)) {
    throw new Error('Выбери заготовку и от 1 до 12 разных клеток с координатами от 0 до 2000');
  }
  if ((templateId || doorId) && !map) throw new Error('Выбери карту для действий');
  if (doorId && !map.terrain.some(item => item.id === doorId && item.kind === 'door')) throw new Error('Дверь не найдена на этой карте');
  if (trackId && !state.music.tracks.some(track => track.id === trackId)) throw new Error('Трек не найден');
  if (!templateId && !doorId && !trackId) return null;
  return { mapId: templateId || doorId ? map.id : null, templateId, cells: templateId ? cells.map(({ col, row }) => ({ col, row })) : [], doorId, trackId };
}
function canMoveToken(board, token, col, row, waypoints = [], size = 1) {
  return Array.isArray(waypoints) && waypoints.length <= 32 && waypoints.every(validCell) &&
    !routeBlocked(board.map, blockingWalls(board.terrain), [token, ...waypoints, { col, row }], size);
}
function updateExploration(state, board) {
  if (!board.fog.enabled) return;
  const placed = new Set(board.tokens.filter(token => !token.hidden).map(token => token.combatantId));
  const players = new Map();
  for (const { combatants } of state.battles) {
    for (const actor of combatants) if (placed.has(actor.id) && revealsFog(actor)) players.set(actor.id, actor);
  }
  const origins = board.tokens.filter(token => !token.hidden && players.has(token.combatantId))
    .map(token => {
      const actor = players.get(token.combatantId);
      return { ...token, size: TokenStyle.size(actor.tokenSize), range: TokenStyle.vision(token.visionFeet ?? actor.visionFeet) / 5 };
    });
  const seen = visibleCells(board.map, origins, blockingWalls(board.terrain));
  if (!seen.size) return;
  const explored = new Set(board.fog.explored);
  const previousSize = explored.size;
  for (const cell of seen) explored.add(cell);
  if (explored.size !== previousSize) board.fog.explored = [...explored].slice(-32000);
}
const terrainPoint = point => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('Укажи точку на карте');
  return { x: clamp(Math.round(point.x), 0, 512000), y: clamp(Math.round(point.y), 0, 512000) };
};
function replaceActive(entries, id, copy) {
  return entries.map(entry => entry.id === id ? copy(entry) : entry);
}
function copyForAction(state, type, p) {
  // Structural operations that touch several saved encounters still make a full transactional copy.
  const s = { ...state };
  if (type.startsWith('journal:')) return s;
  if (/^(combat:|combatant:)/.test(type) && type !== 'combatant:remove') {
    s.battles = replaceActive(state.battles, state.activeBattleId, battle => {
      const copy = { ...battle };
      if (['combatant:add', 'combatant:import', 'combatant:duplicate', 'combat:event-run'].includes(type)) copy.combatants = [...battle.combatants];
      if (['combatant:edit', 'combatant:hp', 'combatant:conditions', 'combat:initiative',
        'combatant:undo', 'combat:roll-initiative', 'combat:reset-initiative'].includes(type)) {
        const id = type === 'combatant:undo' ? battle.history.at(-1)?.id : p.id;
        copy.combatants = battle.combatants.map(c =>
          c.id === id || type === 'combat:reset-initiative' || type === 'combat:roll-initiative' && !p.id ? { ...c } : c);
      }
      if (['combatant:hp', 'combatant:edit', 'combatant:undo'].includes(type)) copy.history = [...battle.history];
      if (type === 'combat:next') copy.acted = [...battle.acted];
      return copy;
    });
    return s;
  }
  if (['terrain:travel', 'map:select', 'battle:select'].includes(type)) return s;
  if (type.startsWith('scene:')) {
    if (type === 'scene:open') s.music = { ...state.music };
    if (type === 'scene:save') s.scenes = p.id
      ? replaceActive(state.scenes, p.id, scene => ({ ...scene })) : [...state.scenes];
    return s;
  }
  if (/^(token:|template:|terrain:|fog:|map:(draw|erase|pin|unpin|settings|image|save)$)/.test(type)) {
    s.boards = replaceActive(state.boards, state.activeMapId, board => {
      const copy = { ...board };
      if (type === 'token:move' || type === 'token:settings') copy.tokens = board.tokens.map(token => token.combatantId === p.id ? { ...token } : token);
      if (type === 'token:add') copy.tokens = [...board.tokens];
      if (type === 'map:draw') copy.drawings = [...board.drawings];
      if (type === 'map:pin') copy.notePins = [...board.notePins];
      if (type === 'map:settings' || type === 'map:image') copy.map = { ...board.map };
      if (type === 'terrain:add') copy.terrain = [...board.terrain];
      if (type === 'terrain:edit-item' || type === 'terrain:door') copy.terrain = replaceActive(board.terrain, p.id, item => ({ ...item }));
      if (type === 'fog:enabled' || type === 'fog:reset') copy.fog = { ...board.fog };
      return copy;
    });
    return s;
  }
  if (type.startsWith('story:') && type !== 'story:remove') {
    s.story = { ...state.story };
    if (type === 'story:move' || type === 'story:save') {
      s.story.notes = p.id ? replaceActive(state.story.notes, p.id, note => ({ ...note })) : [...state.story.notes];
    }
    if (type === 'story:link') s.story.links = [...state.story.links];
    if (type === 'story:draw') s.story.strokes = [...state.story.strokes];
    return s;
  }
  if (type.startsWith('music:')) {
    s.music = { ...state.music };
    if (type === 'music:folder') s.music.folders = [...state.music.folders];
    if (type === 'music:add' || type === 'music:save-import') s.music.tracks = [...state.music.tracks];
    return s;
  }
  if (type.startsWith('layout:')) {
    s.layout = { ...state.layout, windows: { ...state.layout.windows }, preparation: { ...preparationSizes, ...state.layout.preparation } };
    return s;
  }
  const { journal, ...rest } = state;
  return { ...structuredClone(rest), journal };
}
function reducer(state, action) {
  const p = action.payload || {};
  const s = copyForAction(state, action.type, p);
  const battle = s.battles.find(entry => entry.id === s.activeBattleId);
  const board = s.boards.find(entry => entry.id === s.activeMapId);
  if (p.expectedBattleId && p.expectedBattleId !== battle.id &&
      /^(combatant:|combat:|battle:(save|duplicate)|token:add|library:deploy)/.test(action.type)) {
    throw new Error('Бой переключился. Открой действие заново.');
  }
  if (p.expectedMapId && p.expectedMapId !== board.id &&
      /^(token:|template:|terrain:|fog:|map:(draw|erase|image|settings|save|duplicate|pin|unpin)|library:deploy)/.test(action.type)) {
    throw new Error('Карта переключилась. Открой действие заново.');
  }
  switch (action.type) {
    case 'battle:create': {
      const next = newBattle(text(p.title) || 'Новый бой');
      s.battles.push(next);
      s.activeBattleId = next.id;
      break;
    }
    case 'battle:select': {
      const next = s.battles.find(entry => entry.id === p.id);
      if (!next) throw new Error('Бой не найден');
      s.activeBattleId = next.id;
      if (next.linkedMapId) s.activeMapId = next.linkedMapId;
      break;
    }
    case 'battle:save':
      battle.title = text(p.title) || battle.title;
      battle.linkedMapId = s.boards.some(entry => entry.id === p.linkedMapId) ? p.linkedMapId : null;
      break;
    case 'battle:duplicate': {
      const next = newBattle(text(p.title) || (battle.title + ' · копия'));
      next.linkedMapId = battle.linkedMapId;
      next.combatants = battle.combatants.map(c => copyCombatant(c));
      next.events = battle.events.map(event => ({ ...event, id: randomUUID(), fired: false, executed: false }));
      s.battles.push(next);
      s.activeBattleId = next.id;
      if (next.linkedMapId) s.activeMapId = next.linkedMapId;
      break;
    }
    case 'battle:remove': {
      const index = s.battles.findIndex(entry => entry.id === p.id);
      if (index < 0 || s.battles.length === 1) throw new Error('Оставь хотя бы один бой');
      const removed = s.battles.splice(index, 1)[0];
      for (const scene of s.scenes) if (scene.battleId === removed.id) scene.battleId = null;
      const ids = new Set(removed.combatants.map(c => c.id));
      for (const savedBoard of s.boards) savedBoard.tokens = savedBoard.tokens.filter(t => !ids.has(t.combatantId));
      if (removed.id === s.activeBattleId) {
        const next = s.battles[Math.min(index, s.battles.length - 1)];
        s.activeBattleId = next.id;
        if (next.linkedMapId) s.activeMapId = next.linkedMapId;
      }
      break;
    }
    case 'map:create': {
      const next = newBoard(text(p.title) || 'Новая карта');
      next.fog.enabled = p.fog === true;
      s.boards.push(next);
      s.activeMapId = next.id;
      break;
    }
    case 'map:select':
      if (!s.boards.some(entry => entry.id === p.id)) throw new Error('Карта не найдена');
      s.activeMapId = p.id;
      break;
    case 'map:save':
      board.title = text(p.title) || board.title;
      break;
    case 'map:duplicate': {
      const next = { ...newBoard(text(p.title) || (board.title + ' · копия')), map: { ...board.map },
        terrain: structuredClone(board.terrain), drawings: structuredClone(board.drawings), templates: structuredClone(board.templates),
        notePins: structuredClone(board.notePins), fog: newFog(board.fog.enabled) };
      s.boards.push(next);
      s.activeMapId = next.id;
      break;
    }
    case 'map:remove': {
      const index = s.boards.findIndex(entry => entry.id === p.id);
      if (index < 0 || s.boards.length === 1) throw new Error('Оставь хотя бы одну карту');
      s.boards.splice(index, 1);
      for (const entry of s.boards) entry.terrain = entry.terrain.filter(item => item.kind !== 'portal' || item.targetMapId !== p.id);
      for (const scene of s.scenes) if (scene.mapId === p.id) scene.mapId = null;
      for (const entry of s.battles) if (entry.linkedMapId === p.id) entry.linkedMapId = null;
      if (s.activeMapId === p.id) s.activeMapId = s.boards[Math.min(index, s.boards.length - 1)].id;
      break;
    }
    case 'scene:save': {
      const reference = (value, entries) => {
        if (!value) return null;
        if (!entries.some(entry => entry.id === value)) throw new Error('Элемент сцены уже удалён');
        return value;
      };
      const fields = { title: text(p.title) || 'Новая сцена',
        mapId: reference(p.mapId, s.boards), battleId: reference(p.battleId, s.battles),
        trackId: reference(p.trackId, s.music.tracks), noteId: reference(p.noteId, s.story.notes) };
      if (p.sound) {
        fields.sound = {
          loops: ambientIds.filter(id => Array.isArray(p.sound.loops) && p.sound.loops.includes(id)),
          ambientVolume: clamp(finite(p.sound.ambientVolume, 1), 0, 1),
          musicVolume: clamp(finite(p.sound.musicVolume, s.music.volume), 0, 1),
          loop: p.sound.loop === true
        };
      } else fields.sound = null;
      const scene = s.scenes.find(entry => entry.id === p.id);
      if (p.id && !scene) throw new Error('Сцена уже удалена');
      if (scene) Object.assign(scene, fields);
      else s.scenes.push({ id: randomUUID(), ...fields });
      break;
    }
    case 'scene:open': {
      const scene = s.scenes.find(entry => entry.id === p.id);
      if (!scene) throw new Error('Сцена уже удалена');
      if (scene.mapId && s.boards.some(entry => entry.id === scene.mapId)) s.activeMapId = scene.mapId;
      if (scene.battleId && s.battles.some(entry => entry.id === scene.battleId)) s.activeBattleId = scene.battleId;
      const track = s.music.tracks.find(entry => entry.id === scene.trackId);
      s.music.current = track?.id ?? null;
      s.music.playing = !!track;
      s.music.reset = (s.music.reset || 0) + 1;
      if (scene.sound) {
        s.music.volume = scene.sound.musicVolume;
        s.music.loop = scene.sound.loop;
        s.music.fadeIn = s.music.reset;
      }
      break;
    }
    case 'scene:remove':
      s.scenes = s.scenes.filter(entry => entry.id !== p.id);
      break;
    case 'combatant:add': {
      const fields = characterFields(p);
      battle.combatants.push(newCombatant(fields, clamp(Math.round(finite(p.hp, fields.maxHp)), 0, fields.maxHp)));
      break;
    }
    case 'combatant:import': {
      const fields = characterFields({ ...p, role: 'player' });
      const actor = newCombatant(fields, clamp(Math.round(finite(p.hp, fields.maxHp)), 0, fields.maxHp));
      battle.combatants.push(actor);
      break;
    }
    case 'library:save': {
      const index = s.library.findIndex(entry => entry.id === p.id);
      if (p.id && index < 0) throw new Error('Заготовка уже удалена');
      const entry = { id: p.id || randomUUID(), ...characterFields(p) };
      if (index < 0) s.library.push(entry);
      else s.library[index] = entry;
      break;
    }
    case 'library:remove':
      s.library = s.library.filter(entry => entry.id !== p.id);
      break;
    case 'library:deploy': {
      const entry = s.library.find(item => item.id === p.id);
      if (!entry) throw new Error('Заготовка уже удалена');
      const actor = newCombatant(entry);
      if (p.place === true) placeToken(board, actor.id, p, tokenSizes(s), TokenStyle.size(actor.tokenSize));
      battle.combatants.push(actor);
      break;
    }
    case 'combatant:duplicate': {
      const c = battle.combatants.find(c => c.id === p.id); if (!c) break;
      battle.combatants.push(copyCombatant(c, `${c.name} · копия`)); break;
    }
    case 'combatant:edit': {
      const c = battle.combatants.find(c => c.id === p.id);
      if (!c) throw new Error('Участник уже удалён');
      const maxHp = clamp(Math.round(finite(p.maxHp, c.maxHp)), 1, 999999);
      const hp = clamp(Math.round(finite(p.hp, c.hp)), 0, maxHp);
      const bonus = initiativeBonus(p.initiativeBonus, c.initiativeBonus ?? 0);
      if (hp !== c.hp || maxHp !== c.maxHp) rememberHealth(battle, c);
      Object.assign(c, {
        name: text(p.name) || c.name,
        image: 'image' in p ? text(p.image, 100) || null : c.image,
        movementSound: moveSound(p.movementSound, moveSound(c.movementSound)),
        tokenSize: TokenStyle.size(p.tokenSize ?? c.tokenSize),
        tokenFrame: TokenStyle.frame(p.tokenFrame ?? c.tokenFrame)[0],
        visionFeet: TokenStyle.vision(p.visionFeet ?? c.visionFeet),
        initiativeBonus: bonus, role: 'role' in p ? roleOf(p.role) : roleOf(c.role),
        hp, maxHp
      });
      break;
    }
    case 'combatant:remove':
      battle.combatants = battle.combatants.filter(c => c.id !== p.id);
      for (const savedBoard of s.boards) savedBoard.tokens = savedBoard.tokens.filter(t => t.combatantId !== p.id);
      battle.history = battle.history.filter(entry => entry.id !== p.id);
      battle.acted = battle.acted.filter(id => id !== p.id);
      if (battle.manualOrder) battle.manualOrder = battle.manualOrder.filter(id => id !== p.id);
      if (battle.turn === p.id) battle.turn = null; break;
    case 'combatant:hp': {
      const c = battle.combatants.find(c => c.id === p.id); if (!c) break;
      const next = hpValue(c.hp, c.maxHp, p.expression);
      if (next !== c.hp) { rememberHealth(battle, c); c.hp = next; }
      break;
    }
    case 'combatant:undo': {
      const previous = battle.history.pop();
      const c = previous && battle.combatants.find(c => c.id === previous.id);
      if (c) {
        c.maxHp = previous.maxHp ?? c.maxHp;
        c.hp = clamp(previous.hp, 0, c.maxHp);
      }
      break;
    }
    case 'combatant:conditions': {
      const c = battle.combatants.find(c => c.id === p.id);
      if (!c) throw new Error('Участник уже удалён');
      c.conditions = [...new Set(Array.isArray(p.conditions) ? p.conditions.filter(id => MANUAL_IDS.has(id)) : [])];
      c.exhaustion = clamp(Math.round(finite(p.exhaustion, 0)), 0, 6);
      c.durations = conditionDurations(c, Object.hasOwn(p, 'durations') ? p.durations : c.durations);
      break;
    }
    case 'combat:roll-initiative': {
      if (p.role && p.role !== 'enemy') throw new Error('Бросок доступен только за противников');
      const candidates = battle.combatants.filter(c => roleOf(c.role) === 'enemy' && (!p.id || c.id === p.id));
      if (!candidates.length) throw new Error('Нет участников для броска');
      for (const c of candidates) {
        const die = randomInt(1, 21), bonus = c.initiativeBonus ?? 0;
        c.initiative = die + bonus;
        c.initiativeRoll = { die, bonus };
      }
      break;
    }
    case 'combat:initiative': {
      const c = battle.combatants.find(c => c.id === p.id);
      if (!c) throw new Error('Участник не найден');
      const number = p.value === null ? null : Number(p.value);
      if (number !== null && (!Number.isInteger(number) || number < -100 || number > 1000)) {
        throw new Error('Введите целое число от −100 до 1000');
      }
      c.initiative = number;
      c.initiativeRoll = null;
      break;
    }
    case 'combat:move': {
      const ids = battleOrder(battle).map(c => c.id);
      const index = ids.indexOf(p.id);
      if (index === -1 || ![-1, 1].includes(p.delta)) break;
      const position = index + p.delta;
      if (position < 0 || position >= ids.length) break;
      [ids[index], ids[position]] = [ids[position], ids[index]];
      battle.manualOrder = ids;
      break;
    }
    case 'combat:sort':
      battle.manualOrder = null;
      break;
    case 'combat:reset-initiative':
      for (const c of battle.combatants) {
        c.initiative = null;
        c.initiativeRoll = null;
      }
      battle.manualOrder = null;
      battle.round = 1;
      battle.turn = null;
      battle.acted = [];
      if (battle.events.some(event => event.fired || event.executed)) {
        battle.events = battle.events.map(event => ({ ...event, fired: false, executed: false }));
      }
      break;
    case 'combat:event-save': {
      const label = text(p.title, 240), round = Number(p.round);
      if (!label || !Number.isInteger(round) || round < 1 || round > 9999) throw new Error('Укажи текст и номер раунда от 1 до 9999');
      const existing = p.id && battle.events.find(item => item.id === p.id);
      if (p.id && !existing) throw new Error('Событие уже удалено');
      if (!existing && battle.events.length >= 100) throw new Error('В одном бою помещается до 100 событий');
      const actions = eventActions(p.actions || {}, s);
      const keepsRound = existing?.round === round;
      const item = { id: existing?.id ?? randomUUID(), title: label, round, actions,
        fired: Boolean(keepsRound && existing.fired), executed: Boolean(keepsRound && existing.executed) };
      battle.events = existing ? replaceActive(battle.events, item.id, () => item) : [...battle.events, item];
      break;
    }
    case 'combat:event-remove':
      battle.events = battle.events.filter(event => event.id !== p.id);
      break;
    case 'combat:event-delay': {
      const event = battle.events.find(item => item.id === p.id);
      if (!event || !event.fired || event.executed || !event.actions || battle.round >= 9999) throw new Error('Событие нельзя отложить');
      battle.events = replaceActive(battle.events, event.id, item => ({ ...item, round: battle.round + 1, fired: false }));
      break;
    }
    case 'combat:event-run': {
      const event = battle.events.find(item => item.id === p.id);
      if (!event?.actions || !event.fired || event.executed) throw new Error('Событие ещё не готово или уже запущено');
      const actions = eventActions(event.actions, s);
      if (!actions) throw new Error('У события нет действий');
      if (actions.mapId && actions.mapId !== board.id) throw new Error('Открой карту, выбранную для этого события');
      if (actions.mapId) {
        const target = { ...board, tokens: [...board.tokens] };
        if (actions.templateId) {
          const entry = s.library.find(item => item.id === actions.templateId);
          const sizes = tokenSizes(s);
          for (const cell of actions.cells) {
            const actor = newCombatant(entry);
            const size = TokenStyle.size(actor.tokenSize);
            placeToken(target, actor.id, cell, sizes, size);
            sizes.set(actor.id, size);
            battle.combatants.push(actor);
          }
        }
        if (actions.doorId) target.terrain = replaceActive(board.terrain, actions.doorId, item => ({ ...item, open: true }));
        s.boards = replaceActive(s.boards, target.id, () => target);
      }
      if (actions.trackId) s.music = { ...s.music, current: actions.trackId, playing: true };
      battle.events = replaceActive(battle.events, event.id, item => ({ ...item, executed: true }));
      break;
    }
    case 'combat:next': {
      const order = battleOrder(battle).map(c => c.id);
      if (!order.length) break;
      if (battle.turn && !battle.acted.includes(battle.turn)) battle.acted.push(battle.turn);
      const next = order.find(id => !battle.acted.includes(id));
      if (next) battle.turn = next;
      else {
        battle.round++;
        battle.acted = [];
        battle.turn = order[0];
        if (battle.combatants.some(actor => actor.durations && Object.keys(actor.durations).length)) {
          battle.combatants = battle.combatants.map(advanceConditions);
        }
      }
      const due = battle.events.filter(event => !event.fired && event.round <= battle.round);
      if (due.length) {
        const ids = new Set(due.map(event => event.id));
        battle.events = battle.events.map(event => ids.has(event.id) ? { ...event, fired: true } : event);
        const session = s.journal.sessions.find(entry => entry.id === s.journal.active);
        if (session) s.journal = { ...s.journal, sessions: replaceActive(s.journal.sessions, session.id, entry => ({
          ...entry, entries: [...entry.entries, ...due.map(event => journalEntry(`${battle.title} · Раунд ${event.round}. ${event.title}`, 'event'))]
        })) };
      }
      break;
    }
    case 'journal:session': {
      const title = text(p.title);
      if (!title) throw new Error('Укажи название сессии');
      const session = { id: randomUUID(), title, date: new Date().toISOString(), entries: [] };
      s.journal = { active: session.id, sessions: [session, ...s.journal.sessions] };
      break;
    }
    case 'journal:activate':
      if (p.id !== null && !s.journal.sessions.some(entry => entry.id === p.id)) throw new Error('Сессия не найдена');
      s.journal = { ...s.journal, active: p.id };
      break;
    case 'journal:save':
    case 'journal:remove': {
      const session = s.journal.sessions.find(entry => entry.id === p.sessionId);
      if (!session) throw new Error('Сессия не найдена');
      const body = text(p.body, 5000);
      if (action.type === 'journal:save' && !body) throw new Error('Введи текст записи');
      const previous = p.id && session.entries.find(entry => entry.id === p.id);
      if (p.id && (!previous || previous.kind === 'event')) throw new Error('Запись недоступна для изменения');
      const entries = action.type === 'journal:remove' ? session.entries.filter(entry => entry.id !== p.id)
        : previous ? replaceActive(session.entries, p.id, entry => ({ ...entry, body }))
          : [...session.entries, journalEntry(body)];
      s.journal = { ...s.journal, sessions: replaceActive(s.journal.sessions, session.id, entry => ({ ...entry, entries })) };
      break;
    }
    case 'token:add': {
      const actor = battle.combatants.find(c => c.id === p.id);
      if (!actor) throw new Error('Участник уже удалён');
      placeToken(board, p.id, p, tokenSizes(s), TokenStyle.size(actor.tokenSize));
      break;
    }
    case 'token:move': {
      const t = board.tokens.find(t => t.combatantId === p.id);
      if (t) {
        const col = cellIndex(finite(p.col, t.col)), row = cellIndex(finite(p.row, t.row));
        const size = tokenSizeFor(s, p.id);
        if (!canMoveToken(board, t, col, row, p.waypoints, size)) throw new Error('Проход перекрыт');
        Object.assign(t, { col, row });
      }
      break;
    }
    case 'token:visibility': {
      const ids = new Set(Array.isArray(p.ids) ? p.ids : [p.id]);
      board.tokens = board.tokens.map(token => ids.has(token.combatantId) && Boolean(token.hidden) !== p.hidden
        ? { ...token, hidden: p.hidden === true } : token);
      break;
    }
    case 'token:remove': board.tokens = board.tokens.filter(t => t.combatantId !== p.id); break;
    case 'token:settings': {
      const token = board.tokens.find(token => token.combatantId === p.id);
      if (!token) throw new Error('Токен уже снят с карты');
      if ('elevation' in p) token.elevation = TokenStyle.elevation(p.elevation);
      if (p.visionFeet === null) delete token.visionFeet;
      else if ('visionFeet' in p) token.visionFeet = TokenStyle.vision(p.visionFeet);
      break;
    }
    case 'template:add': {
      if (!['line', 'circle', 'square', 'cone'].includes(p.kind)) throw new Error('Выбери форму шаблона');
      if (board.templates.length >= 100) throw new Error('На карте уже 100 шаблонов');
      const point = terrainPoint(p);
      const angle = finite(p.angle, 0) % (2 * Math.PI);
      const feet = clamp(Math.round(finite(p.feet, 15)), 5, 500);
      const end = p.kind === 'line' && p.end ? terrainPoint(p.end) : null;
      board.templates = [...board.templates, { id: randomUUID(), ...point, kind: p.kind, angle, feet, end }];
      break;
    }
    case 'template:remove':
      board.templates = board.templates.filter(template => template.id !== p.id);
      break;
    case 'terrain:add': {
      if (!['wall', 'door', 'window', 'light', 'item', 'portal'].includes(p.kind)) throw new Error('Выбери инструмент карты');
      const light = p.kind === 'light';
      if (board.terrain.filter(item => (item.kind === 'light') === light).length >= (light ? 24 : 400)) {
        throw new Error('На карте слишком много объектов этого типа');
      }
      const a = terrainPoint(p.a);
      if (p.kind === 'portal') {
        if (!s.boards.some(entry => entry.id === p.targetMapId && entry.id !== board.id)) throw new Error('Выбери другую карту');
        if (!validCell(p.exit ?? {})) throw new Error('Укажи клетку выхода от 0 до 2000');
        board.terrain.push({ id: randomUUID(), kind: 'portal', a, name: text(p.name) || 'Переход',
          targetMapId: p.targetMapId, exit: { col: p.exit.col, row: p.exit.row } });
      } else if (p.kind === 'item') {
        board.terrain.push({ id: randomUUID(), kind: 'item', a, name: text(p.name) || 'Предмет', image: text(p.image, 100) || null });
      } else if (!light) {
        const b = terrainPoint(p.b);
        if (distanceToSegment(a, b, b) < 2) throw new Error('Нарисуй отрезок между двумя точками');
        board.terrain.push({ id: randomUUID(), kind: p.kind, a, b, open: false });
      } else {
        board.terrain.push({ id: randomUUID(), kind: 'light', a, radius: clamp(finite(p.radius, board.map.grid * 3), 8, 8192) });
      }
      break;
    }
    case 'terrain:travel': {
      const portal = board.terrain.find(entry => entry.kind === 'portal' && entry.id === p.id);
      const target = portal && s.boards.find(entry => entry.id === portal.targetMapId && entry.id !== board.id);
      if (!target) throw new Error('Карта назначения недоступна');
      const available = new Set(board.tokens.map(token => token.combatantId));
      const ids = Array.isArray(p.ids) ? [...new Set(p.ids)] : [];
      if (ids.length > 100 || ids.some(id => !available.has(id))) throw new Error('Состав жетонов изменился');
      const moving = new Set(ids);
      const arrivals = portalCells(target, portal.exit, ids.map(id => board.tokens.find(token => token.combatantId === id)), tokenSizes(s));
      s.boards = s.boards.map(entry => {
        if (entry === board && ids.length) return { ...entry, tokens: entry.tokens.filter(token => !moving.has(token.combatantId)) };
        if (entry === target && ids.length) return { ...entry, tokens: [...entry.tokens.filter(token => !moving.has(token.combatantId)), ...arrivals] };
        return entry;
      });
      s.activeMapId = target.id;
      break;
    }
    case 'terrain:edit-item': {
      const item = board.terrain.find(object => object.id === p.id && object.kind === 'item');
      if (!item) throw new Error('Предмет уже удалён');
      item.name = text(p.name) || item.name;
      item.image = text(p.image, 100) || null;
      break;
    }
    case 'terrain:edit-portal': {
      if (!board.terrain.some(item => item.kind === 'portal' && item.id === p.id)) throw new Error('Переход уже удалён');
      if (!s.boards.some(entry => entry.id === p.targetMapId && entry.id !== board.id)) throw new Error('Выбери другую карту');
      if (!validCell(p.exit ?? {})) throw new Error('Укажи клетку выхода от 0 до 2000');
      board.terrain = replaceActive(board.terrain, p.id, item => ({ ...item, name: text(p.name) || 'Переход',
        targetMapId: p.targetMapId, exit: { col: p.exit.col, row: p.exit.row } }));
      break;
    }
    case 'terrain:door': {
      const door = board.terrain.find(item => item.id === p.id && item.kind === 'door');
      if (door) door.open = !door.open;
      break;
    }
    case 'terrain:remove':
      board.terrain = board.terrain.filter(item => item.id !== p.id);
      break;
    case 'map:draw': {
      if (board.drawings.length >= 500) throw new Error('На карте слишком много линий');
      if (!Array.isArray(p.points) || !p.points.length || p.points.length > 2000) throw new Error('Проведи линию на карте');
      board.drawings.push({
        id: randomUUID(), points: p.points.map(terrainPoint),
        color: /^#[a-f0-9]{6}$/i.test(p.color) ? p.color : '#ffd18e',
        width: clamp(finite(p.width, 6), 1, 32)
      });
      break;
    }
    case 'map:erase':
      board.drawings = board.drawings.filter(stroke => stroke.id !== p.id);
      break;
    case 'map:pin':
      if (!s.story.notes.some(note => note.id === p.noteId)) throw new Error('Заметка уже удалена');
      if (board.notePins.length >= 500) throw new Error('На карте слишком много заметок');
      board.notePins.push({ id: randomUUID(), noteId: p.noteId, ...terrainPoint(p) });
      break;
    case 'map:unpin':
      board.notePins = board.notePins.filter(pin => pin.id !== p.id);
      break;
    case 'fog:enabled':
      board.fog.enabled = p.enabled === true;
      break;
    case 'fog:reset':
      board.fog.explored = [];
      break;
    case 'map:settings':
      for (const [key, min, max] of [['grid', 16, 512], ['offsetX', -512, 512], ['offsetY', -512, 512], ['opacity', 0, 1], ['zoom', 0.01, 24]])
        if (key in p) board.map[key] = clamp(finite(p[key], board.map[key]), min, max);
      if (typeof p.visible === 'boolean') board.map.visible = p.visible;
      if (typeof p.playerHealth === 'boolean') board.map.playerHealth = p.playerHealth;
      if (['fit', 'fill', 'follow'].includes(p.playerFit)) board.map.playerFit = p.playerFit;
      if ([null, 0, 90, 180, 270].includes(p.playerRotation)) board.map.playerRotation = p.playerRotation;
      if (['equal', 'alternating'].includes(p.diagonals)) board.map.diagonals = p.diagonals;
      if ([0, 90, 180, 270].includes(p.rotation)) board.map.rotation = p.rotation;
      if (/^#[0-9a-f]{6}$/i.test(p.color)) board.map.color = p.color;
      break;
    case 'map:image': board.map.image = text(p.image, 100) || null; break;
    case 'gallery:add':
      s.gallery.unshift({ id: randomUUID(), image: p.image, title: text(p.title) || 'Иллюстрация' });
      break;
    case 'gallery:rename': {
      const item = s.gallery.find(entry => entry.id === p.id);
      if (item && text(p.title)) item.title = text(p.title);
      break;
    }
    case 'gallery:remove':
      s.gallery = s.gallery.filter(item => item.id !== p.id);
      break;
    case 'story:save': {
      const fields = { title: text(p.title) || 'Без названия', body: String(p.body ?? '').slice(0, 20000) };
      if (p.kind === 'text') {
        fields.body = fields.body.trim();
        if (!fields.body) throw new Error('Введите текст');
        fields.kind = 'text';
        fields.title = text(fields.body.split('\n')[0]);
      }
      if ('images' in p) fields.images = [...new Set(p.images)].slice(0, 12);
      if (p.id) {
        const note = s.story.notes.find(item => item.id === p.id);
        if (!note) throw new Error('Заметка уже удалена');
        Object.assign(note, fields);
      } else {
        s.story.notes.push({ id: randomUUID(), ...fields, x: storyCoordinate(p.x), y: storyCoordinate(p.y) });
      }
      break;
    }
    case 'story:move': {
      const note = s.story.notes.find(item => item.id === p.id);
      if (note) Object.assign(note, { x: storyCoordinate(p.x), y: storyCoordinate(p.y) });
      break;
    }
    case 'story:remove':
      s.story.notes = s.story.notes.filter(note => note.id !== p.id);
      s.story.links = s.story.links.filter(link => link.from !== p.id && link.to !== p.id);
      for (const savedBoard of s.boards) savedBoard.notePins = savedBoard.notePins.filter(pin => pin.noteId !== p.id);
      for (const scene of s.scenes) if (scene.noteId === p.id) scene.noteId = null;
      break;
    case 'story:link': {
      const { from, to } = p;
      if (from === to || !s.story.notes.some(note => note.id === from) || !s.story.notes.some(note => note.id === to)) {
        throw new Error('Выбери две разные заметки');
      }
      if (!s.story.links.some(link => link.from === from && link.to === to || link.from === to && link.to === from)) {
        s.story.links.push({ id: randomUUID(), from, to });
      }
      break;
    }
    case 'story:unlink':
      s.story.links = s.story.links.filter(link => link.id !== p.id);
      break;
    case 'story:draw': {
      const points = Array.isArray(p.points) ? p.points.slice(0, 2000)
        .filter(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))
        .map(point => point.map(storyCoordinate)) : [];
      if (points.length) s.story.strokes.push({ id: randomUUID(), points,
        color: /^#[a-f0-9]{6}$/i.test(p.color) ? p.color : '#dfad77', width: clamp(finite(p.width, 3), 1, 18) });
      break;
    }
    case 'story:erase': {
      const ids = new Set(Array.isArray(p.ids) ? p.ids : []);
      s.story.strokes = s.story.strokes.filter(stroke => !ids.has(stroke.id));
      break;
    }
    case 'bookmark:add':
      if (!s.bookmarks.some(item => item.url === p.url)) {
        s.bookmarks.unshift({ id: randomUUID(), title: text(p.title) || p.url, url: p.url, tab: p.tab });
        s.bookmarks = s.bookmarks.slice(0, 150);
      }
      break;
    case 'bookmark:remove':
      s.bookmarks = s.bookmarks.filter(item => item.id !== p.id);
      break;
    case 'music:folder': {
      const name = text(p.name, 50); if (name && !s.music.folders.includes(name)) s.music.folders.push(name); break;
    }
    case 'music:add':
      s.music.tracks.push({ id: randomUUID(), title: text(p.title) || 'Без названия', asset: text(p.asset, 100), folder: s.music.folders.includes(p.folder) ? p.folder : 'Общее', source: text(p.source, 300) }); break;
    case 'music:save-import': {
      const asset = text(p.asset, 100);
      const folder = s.music.folders.includes(p.folder) ? p.folder : 'Общее';
      if (p.previousAsset) {
        s.music.tracks = s.music.tracks.map(track => track.asset === p.previousAsset ? { ...track, asset } : track);
      }
      if (!s.music.tracks.some(track => track.asset === asset && track.folder === folder)) {
        s.music.tracks.push({ id: randomUUID(), title: text(p.title), asset, folder, source: text(p.source, 300) });
      }
      break;
    }
    case 'music:move': {
      if (s.music.folders.includes(p.folder)) {
        s.music.tracks = replaceActive(s.music.tracks, p.id, track => ({ ...track, folder: p.folder }));
      }
      break;
    }
    case 'music:remove':
      s.music.tracks = s.music.tracks.filter(t => t.id !== p.id);
      if (s.scenes.some(scene => scene.trackId === p.id)) {
        s.scenes = s.scenes.map(scene => scene.trackId === p.id ? { ...scene, trackId: null } : scene);
      }
      if (s.battles.some(entry => entry.events.some(event => event.actions?.trackId === p.id))) {
        s.battles = s.battles.map(entry => {
          if (!entry.events.some(event => event.actions?.trackId === p.id)) return entry;
          const events = entry.events.map(event => {
            if (event.actions?.trackId !== p.id) return event;
            const actions = { ...event.actions, trackId: null };
            return { ...event, actions: actions.templateId || actions.doorId ? actions : null };
          });
          return { ...entry, events };
        });
      }
      if (s.music.current === p.id) { s.music.current = null; s.music.playing = false; } break;
    case 'music:play':
      if (s.music.tracks.some(t => t.id === p.id)) { s.music.current = p.id; s.music.playing = true; } break;
    case 'music:settings':
      if (typeof p.playing === 'boolean') s.music.playing = p.playing;
      if (typeof p.loop === 'boolean') s.music.loop = p.loop;
      if ('volume' in p) s.music.volume = clamp(finite(p.volume, 0.55), 0, 1); break;
    case 'music:stop': s.music.playing = false; s.music.reset = (s.music.reset || 0) + 1; break;
    case 'layout:mode':
      if (!['game', 'preparation'].includes(p.mode)) throw new Error('Неизвестная раскладка');
      s.layout.mode = p.mode;
      break;
    case 'layout:settings': {
      const preparation = (p.mode ?? s.layout.mode) === 'preparation';
      const size = preparation ? s.layout.preparation : s.layout;
      if ('left' in p) size.left = clamp(finite(p.left, size.left), 18, 45);
      if ('middle' in p || 'left' in p) size.middle = clamp(finite(p.middle, size.middle), 18, 82 - size.left);
      if ('top' in p) size.top = clamp(finite(p.top, size.top), 25, 75);
      break;
    }
    case 'layout:window':
      if (['combat', 'music', 'map', 'info', 'characters'].includes(p.id)) s.layout.windows[p.id] = p.bounds || null; break;
    default: throw new Error('Неизвестная команда');
  }
  const beforeBoard = state.boards.find(item => item.id === state.activeMapId);
  const gridChanged = action.type === 'map:settings' &&
    ['grid', 'offsetX', 'offsetY'].some(key => board.map[key] !== beforeBoard.map[key]);
  if (action.type === 'map:image' || gridChanged) board.fog = { ...board.fog, explored: [] };
  let visionChanged = false;
  if (beforeBoard.fog.enabled && ['combatant:edit', 'combatant:hp', 'combatant:undo'].includes(action.type)) {
    const beforeBattle = state.battles.find(entry => entry.id === battle.id);
    const id = action.type === 'combatant:undo' ? beforeBattle.history.at(-1)?.id : p.id;
    if (board.tokens.some(token => token.combatantId === id)) {
      const previous = beforeBattle.combatants.find(c => c.id === id);
      const next = battle.combatants.find(c => c.id === id);
      visionChanged = !!previous && !!next && (revealsFog(previous) !== revealsFog(next) ||
        revealsFog(next) && (TokenStyle.size(previous.tokenSize) !== TokenStyle.size(next.tokenSize) ||
          TokenStyle.vision(previous.visionFeet) !== TokenStyle.vision(next.visionFeet)));
    }
  }
  const terrainChanged = action.type === 'terrain:door' ||
    action.type === 'terrain:add' && ['wall', 'door', 'window'].includes(p.kind) ||
    action.type === 'terrain:remove' && beforeBoard.terrain.some(item => item.id === p.id && ['wall', 'door', 'window'].includes(item.kind));
  if (visionChanged || gridChanged || terrainChanged || action.type === 'token:settings' && 'visionFeet' in p ||
      /^(token:(add|move|visibility)$|terrain:travel$|fog:|map:(image|select)$|battle:select$|scene:open$|library:deploy$|combat:event-run$)/.test(action.type)) {
    s.boards = replaceActive(s.boards, s.activeMapId, current => {
      if (!current.fog.enabled) return current;
      const updated = { ...current, fog: { ...current.fog } };
      updateExploration(s, updated);
      return updated.fog.explored === current.fog.explored ? current : updated;
    });
  }
  s.revision++;
  return s;
}
module.exports = { initialState, migrateState, activeView, reducer, hpValue, cellAt, canMoveToken };
