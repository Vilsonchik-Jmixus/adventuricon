const { randomUUID } = require('node:crypto');
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const finite = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
const text = (v, max = 120) => String(v ?? '').trim().slice(0, max);
function initialState() {
  return {
    schema: 1, revision: 0, combatants: [], tokens: [], round: 1, turn: null, history: [], gallery: [],
    map: { image: null, grid: 64, offsetX: 0, offsetY: 0, opacity: 0.3, color: '#d8e6e0', visible: true, zoom: 1 },
    music: { folders: ['Общее', 'Бой', 'Атмосфера'], tracks: [], current: null, playing: false, volume: 0.55, loop: true },
    layout: { left: 32, middle: 34, top: 52, windows: {} }
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
function rememberHealth(state, combatant) {
  state.history.push({ id: combatant.id, hp: combatant.hp, maxHp: combatant.maxHp });
  state.history = state.history.slice(-50);
}
function reducer(state, action) {
  const s = structuredClone(state), p = action.payload || {};
  switch (action.type) {
    case 'combatant:add': {
      const maxHp = clamp(Math.round(finite(p.maxHp, 10)), 1, 999999);
      s.combatants.push({ id: randomUUID(), name: text(p.name) || 'Безымянный', image: text(p.image, 100) || null, maxHp, hp: maxHp, initiative: clamp(Math.round(finite(p.initiative, 0)), -100, 1000) });
      break;
    }
    case 'combatant:duplicate': {
      const c = s.combatants.find(c => c.id === p.id); if (!c) break;
      s.combatants.push({ ...c, id: randomUUID(), name: `${c.name} · копия`, hp: c.maxHp }); break;
    }
    case 'combatant:edit': {
      const c = s.combatants.find(c => c.id === p.id);
      if (!c) throw new Error('Участник уже удалён');
      const maxHp = clamp(Math.round(finite(p.maxHp, c.maxHp)), 1, 999999);
      const hp = clamp(Math.round(finite(p.hp, c.hp)), 0, maxHp);
      if (hp !== c.hp || maxHp !== c.maxHp) rememberHealth(s, c);
      Object.assign(c, {
        name: text(p.name) || c.name,
        image: 'image' in p ? text(p.image, 100) || null : c.image,
        initiative: clamp(Math.round(finite(p.initiative, c.initiative)), -100, 1000),
        hp, maxHp
      });
      break;
    }
    case 'combatant:remove':
      s.combatants = s.combatants.filter(c => c.id !== p.id); s.tokens = s.tokens.filter(t => t.combatantId !== p.id);
      s.history = s.history.filter(entry => entry.id !== p.id);
      if (s.turn === p.id) s.turn = null; break;
    case 'combatant:hp': {
      const c = s.combatants.find(c => c.id === p.id); if (!c) break;
      const next = hpValue(c.hp, c.maxHp, p.expression);
      if (next !== c.hp) { rememberHealth(s, c); c.hp = next; }
      break;
    }
    case 'combatant:undo': {
      const previous = s.history.pop();
      const c = previous && s.combatants.find(c => c.id === previous.id);
      if (c) {
        c.maxHp = previous.maxHp ?? c.maxHp;
        c.hp = clamp(previous.hp, 0, c.maxHp);
      }
      break;
    }
    case 'combat:next': {
      const order = [...s.combatants].sort((a, b) => b.initiative - a.initiative);
      if (!order.length) break;
      const idx = order.findIndex(c => c.id === s.turn);
      if (idx === order.length - 1) s.round++;
      s.turn = order[(idx + 1) % order.length].id; break;
    }
    case 'token:add': {
      if (!s.combatants.some(c => c.id === p.id) || s.tokens.some(t => t.combatantId === p.id)) break;
      let index = 0;
      while (s.tokens.some(t => t.col === index % 8 && t.row === Math.floor(index / 8))) index++;
      s.tokens.push({ combatantId: p.id, col: index % 8, row: Math.floor(index / 8) }); break;
    }
    case 'token:move': {
      const t = s.tokens.find(t => t.combatantId === p.id);
      if (t) { t.col = clamp(Math.round(finite(p.col, t.col)), 0, 2000); t.row = clamp(Math.round(finite(p.row, t.row)), 0, 2000); } break;
    }
    case 'token:remove': s.tokens = s.tokens.filter(t => t.combatantId !== p.id); break;
    case 'map:settings':
      for (const [key, min, max] of [['grid', 16, 256], ['offsetX', -512, 512], ['offsetY', -512, 512], ['opacity', 0, 1], ['zoom', 0.01, 3]])
        if (key in p) s.map[key] = clamp(finite(p[key], s.map[key]), min, max);
      if (typeof p.visible === 'boolean') s.map.visible = p.visible;
      if (typeof p.playerHealth === 'boolean') s.map.playerHealth = p.playerHealth;
      if (/^#[0-9a-f]{6}$/i.test(p.color)) s.map.color = p.color;
      break;
    case 'map:image': s.map.image = text(p.image, 100) || null; break;
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
  s.revision++;
  return s;
}
module.exports = { initialState, reducer, hpValue, cellAt };
