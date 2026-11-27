const fields = {
  'token:add': 'tokens', 'token:move': 'tokens', 'token:remove': 'tokens', 'token:visibility': 'tokens', 'token:settings': 'tokens', 'library:deploy': 'tokens',
  'template:add': 'templates', 'template:remove': 'templates',
  'terrain:add': 'terrain', 'terrain:edit-item': 'terrain', 'terrain:edit-portal': 'terrain', 'terrain:door': 'terrain', 'terrain:remove': 'terrain',
  'map:pin': 'notePins', 'map:unpin': 'notePins', 'fog:enabled': 'fog', 'fog:reset': 'fog',
};
const mapKeys = ['image', 'grid', 'offsetX', 'offsetY', 'opacity', 'color', 'visible', 'rotation', 'diagonals'];
const sameCell = (a, b) => a === b || a?.col === b?.col && a?.row === b?.row;
const sameToken = (a, b) => sameCell(a, b) && Boolean(a?.hidden) === Boolean(b?.hidden) &&
  (a?.elevation ?? 0) === (b?.elevation ?? 0) && a?.visionFeet === b?.visionFeet;
const tokensById = tokens => new Map(tokens.map(token => [token.combatantId, token]));

function tokenChanges(before, after) {
  if (before === after) return [];
  const oldTokens = tokensById(before), newTokens = tokensById(after);
  return [...new Set([...oldTokens.keys(), ...newTokens.keys()])].flatMap(id => {
    const previous = oldTokens.get(id), current = newTokens.get(id);
    return sameToken(previous, current) ? [] : [{ id, previous, current }];
  });
}

function rememberTravel(source, target, nextSource, nextTarget) {
  return { field: 'travel', from: source.id, to: target.id,
    sourceChanges: tokenChanges(source.tokens, nextSource.tokens), targetChanges: tokenChanges(target.tokens, nextTarget.tokens) };
}

function rememberMapAction(action, before, after) {
  if (action.type === 'map:image' || action.type === 'map:settings') {
    const changed = mapKeys.filter(key => before.map[key] !== after.map[key]);
    if (!changed.length) return null;
    return { field: 'map', previous: Object.fromEntries(changed.map(key => [key, before.map[key]])),
      fog: changed.some(key => ['image', 'grid', 'offsetX', 'offsetY'].includes(key)) ? before.fog : undefined };
  }
  if (action.type === 'map:draw' && after.drawings.length > before.drawings.length) {
    return { field: 'drawings', added: after.drawings.at(-1).id };
  }
  if (action.type === 'map:erase') {
    const index = before.drawings.findIndex(stroke => stroke.id === action.payload.id);
    return index < 0 ? null : { field: 'drawings', index, removed: before.drawings[index] };
  }
  const field = fields[action.type];
  if (field === 'tokens') {
    const changes = tokenChanges(before.tokens, after.tokens);
    return changes.length ? { field, changes } : null;
  }
  if (!field || JSON.stringify(before[field]) === JSON.stringify(after[field])) return null;
  return { field, previous: before[field] };
}

function restoreTokens(tokens, changes, existing, strict = false) {
  const current = tokensById(tokens);
  const eligible = changes.filter(change => {
    if (!existing.has(change.id)) return false;
    if (sameToken(current.get(change.id), change.current)) return true;
    if (strict) throw new Error('Жетоны уже переместились. Сначала отмени последующие перемещения.');
    return false;
  });
  const moving = new Set(eligible.map(change => change.id));
  const stationary = tokens.filter(token => !moving.has(token.combatantId));
  const restored = eligible.flatMap(change => change.previous ? [change.previous] : []);
  if (strict && restored.some(token => stationary.some(other => sameCell(token, other)))) {
    throw new Error('Клетка для возврата занята. Освободи её и повтори отмену.');
  }
  return [...stationary, ...restored];
}

function undoMapAction(state, entry) {
  if (entry.field === 'travel') {
    const source = state.boards.find(map => map.id === entry.from);
    const target = state.boards.find(map => map.id === entry.to);
    if (!source || !target) throw new Error('Одна из карт перехода удалена');
    const existing = new Set(state.battles.flatMap(battle => battle.combatants.map(actor => actor.id)));
    const restore = (board, changes) => changes.length ? { ...board, tokens: restoreTokens(board.tokens, changes, existing, true) } : board;
    return { ...state, revision: state.revision + 1, activeMapId: source.id,
      boards: state.boards.map(map => map === source ? restore(map, entry.sourceChanges) :
        map === target ? restore(map, entry.targetChanges) : map) };
  }
  const board = state.boards.find(item => item.id === state.activeMapId);
  let previous = entry.previous;
  if (entry.added) previous = board.drawings.filter(stroke => stroke.id !== entry.added);
  if (entry.removed) previous = board.drawings.toSpliced(entry.index, 0, entry.removed);
  if (entry.field === 'tokens') {
    const ids = new Set(state.battles.flatMap(battle => battle.combatants.map(actor => actor.id)));
    previous = restoreTokens(board.tokens, entry.changes, ids);
  }
  if (entry.field === 'notePins') previous = previous.filter(pin => state.story.notes.some(note => note.id === pin.noteId));
  if (entry.field === 'terrain') previous = previous.filter(item => item.kind !== 'portal' || state.boards.some(map => map.id === item.targetMapId));
  if (entry.field === 'map') previous = { ...board.map, ...previous };
  return { ...state, revision: state.revision + 1,
    boards: state.boards.map(item => item === board ? { ...item, [entry.field]: previous, fog: entry.fog ?? (entry.field === 'fog' ? previous : item.fog) } : item) };
}

module.exports = { rememberMapAction, rememberTravel, undoMapAction };
