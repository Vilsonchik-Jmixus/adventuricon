const { randomUUID, randomInt } = require('node:crypto');
const { roleOf, effectsFor, MANUAL_IDS } = require('./combat-rules.cjs');
const { blockingWalls, blocked, cellCenter, distanceToSegment, visibleCells } = require('../ui/map-geometry.js');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const text = (v, max = 120) => String(v ?? '').trim().slice(0, max);
const newFog = (enabled = false) => ({ enabled, explored: [] });
function newBattle(title = 'Первый бой') {
  return { id: randomUUID(), title, linkedMapId: null, combatants: [], round: 1, turn: null, acted: [], manualOrder: null, history: [] };
}
function newBoard(title = 'Первая карта', demo = false) {
  return {
    id: randomUUID(), title, tokens: [], terrain: [], fog: newFog(),
    map: { image: null, demo, grid: 64, offsetX: 0, offsetY: 0, opacity: 0.3, color: '#d8e6e0', visible: true, zoom: 1 }
  };
}
function initialState() {
  const battle = newBattle(), board = newBoard(undefined, true);
  return {
    schema: 2, revision: 0, battles: [battle], boards: [board],
    activeBattleId: battle.id, activeMapId: board.id, gallery: [], bookmarks: [], library: [],
    music: { folders: ['Общее', 'Бой', 'Атмосфера'], tracks: [], current: null, playing: false, volume: 0.55, loop: true },
    layout: { left: 32, middle: 34, top: 52, windows: {} }
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
    return { ...saved, battles: saved.battles.map(restoreRound), bookmarks: Array.isArray(saved.bookmarks) ? saved.bookmarks : [],
      library: Array.isArray(saved.library) ? saved.library : [],
      boards: saved.boards.map(board => ({ terrain: [], fog: newFog(), ...board })) };
  }
  if (saved.schema !== 1 || !Array.isArray(saved.combatants) || !Array.isArray(saved.tokens) || !saved.map) {
    throw new Error('Неверный формат сохранения');
  }
  const { combatants, tokens, map, round, turn, history, gallery, ...base } = saved;
  const battle = restoreRound({ ...newBattle('Текущий бой'), acted: undefined,
    combatants, round: round ?? 1, turn: turn ?? null, history: history ?? [] });
  const board = { ...newBoard('Текущая карта'), map, tokens };
  return {
    ...base, schema: 2, gallery: gallery ?? [], bookmarks: [], library: [],
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
  if (Array.isArray(battle.acted)) return battle;
  const ordered = battleOrder(battle);
  const current = ordered.findIndex(c => c.id === battle.turn);
  return { ...battle, acted: current > 0 ? ordered.slice(0, current).map(c => c.id) : [], manualOrder: null };
}
function activeView(state) {
  const battle = state.battles.find(entry => entry.id === state.activeBattleId);
  const board = state.boards.find(entry => entry.id === state.activeMapId);
  const placed = new Set(board.tokens.map(token => token.combatantId));
  const describe = c => ({ ...c, role: roleOf(c.role), initiativeBonus: c.initiativeBonus ?? 0, effects: effectsFor(c) });
  return {
    revision: state.revision, music: state.music, layout: state.layout, gallery: state.gallery, bookmarks: state.bookmarks, library: state.library,
    activeBattleId: battle.id, activeMapId: board.id,
    battleChoices: state.battles.map(({ id, title, linkedMapId }) => ({ id, title, linkedMapId })),
    mapChoices: state.boards.map(({ id, title }) => ({ id, title })),
    combatants: battle.combatants.map(describe), order: battleOrder(battle).map(c => c.id), manualOrder: !!battle.manualOrder,
    round: battle.round, turn: battle.turn, acted: battle.acted, history: battle.history,
    map: board.map, tokens: board.tokens, terrain: board.terrain, fog: board.fog,
    mapCombatants: state.battles.flatMap(entry => entry.combatants.filter(c => placed.has(c.id)).map(describe))
  };
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
  return { ...c, id: randomUUID(), name, hp: c.maxHp, conditions: [], exhaustion: 0, initiativeRoll: null };
}
function characterFields(p) {
  return { name: text(p.name) || 'Безымянный', image: text(p.image, 100) || null,
    maxHp: clamp(Math.round(finite(p.maxHp, 10)), 1, 999999), role: roleOf(p.role),
    initiativeBonus: initiativeBonus(p.initiativeBonus) };
}
function newCombatant(fields, hp = fields.maxHp) {
  return { ...fields, id: randomUUID(), hp, initiative: null, conditions: [], exhaustion: 0 };
}
const cellIndex = n => clamp(Math.round(finite(n, 0)), 0, 2000);
function placeToken(board, id, { col, row }) {
  if (board.tokens.some(t => t.combatantId === id)) return;
  if (Number.isFinite(col) && Number.isFinite(row)) {
    col = cellIndex(col);
    row = cellIndex(row);
    if (board.tokens.some(t => t.col === col && t.row === row)) throw new Error('Эта клетка занята');
  } else {
    const occupied = new Set(board.tokens.map(t => `${t.col},${t.row}`));
    let index = 0;
    while (occupied.has(`${index % 8},${Math.floor(index / 8)}`)) index++;
    col = index % 8;
    row = Math.floor(index / 8);
  }
  board.tokens.push({ combatantId: id, col, row });
}
function canMoveToken(board, token, col, row) {
  return !blocked(blockingWalls(board.terrain), cellCenter(board.map, token.col, token.row), cellCenter(board.map, col, row));
}
function updateExploration(state, board) {
  if (!board.fog.enabled) return;
  const players = new Set(state.battles.flatMap(battle => battle.combatants
    .filter(actor => actor.role === 'player' && actor.hp > 0).map(actor => actor.id)));
  const origins = board.tokens.filter(token => players.has(token.combatantId));
  const seen = visibleCells(board.map, origins, blockingWalls(board.terrain));
  board.fog.explored = [...new Set([...board.fog.explored, ...seen])].slice(-32000);
}
const terrainPoint = point => {
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) throw new Error('Укажи точку на карте');
  return { x: clamp(Math.round(point.x), 0, 512000), y: clamp(Math.round(point.y), 0, 512000) };
};
function reducer(state, action) {
  const s = structuredClone(state), p = action.payload || {};
  const battle = s.battles.find(entry => entry.id === s.activeBattleId);
  const board = s.boards.find(entry => entry.id === s.activeMapId);
  if (p.expectedBattleId && p.expectedBattleId !== battle.id &&
      /^(combatant:|combat:|battle:(save|duplicate)|token:add|library:deploy)/.test(action.type)) {
    throw new Error('Бой переключился. Открой действие заново.');
  }
  if (p.expectedMapId && p.expectedMapId !== board.id &&
      /^(token:|terrain:|fog:|map:(image|settings|save|duplicate)|library:deploy)/.test(action.type)) {
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
      s.battles.push(next);
      s.activeBattleId = next.id;
      if (next.linkedMapId) s.activeMapId = next.linkedMapId;
      break;
    }
    case 'battle:remove': {
      const index = s.battles.findIndex(entry => entry.id === p.id);
      if (index < 0 || s.battles.length === 1) throw new Error('Оставь хотя бы один бой');
      const removed = s.battles.splice(index, 1)[0];
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
        terrain: structuredClone(board.terrain), fog: newFog(board.fog.enabled) };
      s.boards.push(next);
      s.activeMapId = next.id;
      break;
    }
    case 'map:remove': {
      const index = s.boards.findIndex(entry => entry.id === p.id);
      if (index < 0 || s.boards.length === 1) throw new Error('Оставь хотя бы одну карту');
      s.boards.splice(index, 1);
      for (const entry of s.battles) if (entry.linkedMapId === p.id) entry.linkedMapId = null;
      if (s.activeMapId === p.id) s.activeMapId = s.boards[Math.min(index, s.boards.length - 1)].id;
      break;
    }
    case 'combatant:add': {
      battle.combatants.push(newCombatant(characterFields(p)));
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
      if (p.place === true) placeToken(board, actor.id, p);
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
      }
      break;
    }
    case 'token:add': {
      if (!battle.combatants.some(c => c.id === p.id)) throw new Error('Участник уже удалён');
      placeToken(board, p.id, p);
      break;
    }
    case 'token:move': {
      const t = board.tokens.find(t => t.combatantId === p.id);
      if (t) {
        const col = cellIndex(finite(p.col, t.col)), row = cellIndex(finite(p.row, t.row));
        if (!canMoveToken(board, t, col, row)) throw new Error('Дальше стена или закрытая дверь');
        Object.assign(t, { col, row });
      }
      break;
    }
    case 'token:remove': board.tokens = board.tokens.filter(t => t.combatantId !== p.id); break;
    case 'terrain:add': {
      if (!['wall', 'door', 'light', 'item'].includes(p.kind)) throw new Error('Выбери инструмент карты');
      const light = p.kind === 'light';
      if (board.terrain.filter(item => (item.kind === 'light') === light).length >= (light ? 24 : 400)) {
        throw new Error('На карте слишком много объектов этого типа');
      }
      const a = terrainPoint(p.a);
      if (p.kind === 'item') {
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
    case 'terrain:edit-item': {
      const item = board.terrain.find(object => object.id === p.id && object.kind === 'item');
      if (!item) throw new Error('Предмет уже удалён');
      item.name = text(p.name) || item.name;
      item.image = text(p.image, 100) || null;
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
    case 'fog:enabled':
      board.fog.enabled = p.enabled === true;
      break;
    case 'fog:reset':
      board.fog.explored = [];
      break;
    case 'map:settings':
      for (const [key, min, max] of [['grid', 16, 256], ['offsetX', -512, 512], ['offsetY', -512, 512], ['opacity', 0, 1], ['zoom', 0.01, 24]])
        if (key in p) board.map[key] = clamp(finite(p[key], board.map[key]), min, max);
      if (typeof p.visible === 'boolean') board.map.visible = p.visible;
      if (typeof p.playerHealth === 'boolean') board.map.playerHealth = p.playerHealth;
      if (['fit', 'fill', 'follow'].includes(p.playerFit)) board.map.playerFit = p.playerFit;
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
      for (const track of s.music.tracks) {
        if (p.previousAsset && track.asset === p.previousAsset) track.asset = asset;
      }
      if (!s.music.tracks.some(track => track.asset === asset && track.folder === folder)) {
        s.music.tracks.push({ id: randomUUID(), title: text(p.title), asset, folder, source: text(p.source, 300) });
      }
      break;
    }
    case 'music:move': {
      const t = s.music.tracks.find(t => t.id === p.id); if (t && s.music.folders.includes(p.folder)) t.folder = p.folder; break;
    }
    case 'music:remove':
      s.music.tracks = s.music.tracks.filter(t => t.id !== p.id);
      if (s.music.current === p.id) { s.music.current = null; s.music.playing = false; } break;
    case 'music:play':
      if (s.music.tracks.some(t => t.id === p.id)) { s.music.current = p.id; s.music.playing = true; } break;
    case 'music:settings':
      if (typeof p.playing === 'boolean') s.music.playing = p.playing;
      if (typeof p.loop === 'boolean') s.music.loop = p.loop;
      if ('volume' in p) s.music.volume = clamp(finite(p.volume, 0.55), 0, 1); break;
    case 'music:stop': s.music.playing = false; s.music.reset = (s.music.reset || 0) + 1; break;
    case 'layout:settings':
      if ('left' in p) s.layout.left = clamp(finite(p.left, 32), 18, 45);
      if ('middle' in p) s.layout.middle = clamp(finite(p.middle, 34), 18, 82 - s.layout.left);
      if ('top' in p) s.layout.top = clamp(finite(p.top, 52), 25, 75); break;
    case 'layout:window':
      if (['combat', 'music', 'map', 'info', 'characters'].includes(p.id)) s.layout.windows[p.id] = p.bounds || null; break;
    default: throw new Error('Неизвестная команда');
  }
  if (action.type === 'map:image' || action.type === 'map:settings' &&
      ['grid', 'offsetX', 'offsetY'].some(key => board.map[key] !== state.boards.find(item => item.id === board.id).map[key])) {
    board.fog.explored = [];
  }
  if (/^(token:|terrain:|fog:|map:(image|settings|select)|battle:select|library:deploy|combatant:(edit|hp|undo))/.test(action.type)) {
    updateExploration(s, s.boards.find(item => item.id === s.activeMapId));
  }
  s.revision++;
  return s;
}
module.exports = { initialState, migrateState, activeView, reducer, hpValue, cellAt, canMoveToken };
