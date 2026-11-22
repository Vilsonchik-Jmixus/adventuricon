const fields = {
  'token:add': 'tokens', 'token:move': 'tokens', 'token:remove': 'tokens', 'library:deploy': 'tokens',
  'terrain:add': 'terrain', 'terrain:edit-item': 'terrain', 'terrain:door': 'terrain', 'terrain:remove': 'terrain',
  'map:pin': 'notePins', 'map:unpin': 'notePins', 'fog:enabled': 'fog', 'fog:reset': 'fog',
};
const mapKeys = ['image', 'grid', 'offsetX', 'offsetY', 'opacity', 'color', 'visible', 'rotation', 'diagonals'];

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
  if (!field || JSON.stringify(before[field]) === JSON.stringify(after[field])) return null;
  return { field, previous: before[field] };
}

function undoMapAction(state, entry) {
  const board = state.boards.find(item => item.id === state.activeMapId);
  let previous = entry.previous;
  if (entry.added) previous = board.drawings.filter(stroke => stroke.id !== entry.added);
  if (entry.removed) previous = board.drawings.toSpliced(entry.index, 0, entry.removed);
  if (entry.field === 'tokens') {
    const ids = new Set(state.battles.flatMap(battle => battle.combatants.map(actor => actor.id)));
    previous = previous.filter(token => ids.has(token.combatantId));
  }
  if (entry.field === 'notePins') previous = previous.filter(pin => state.story.notes.some(note => note.id === pin.noteId));
  if (entry.field === 'map') previous = { ...board.map, ...previous };
  return { ...state, revision: state.revision + 1,
    boards: state.boards.map(item => item === board ? { ...item, [entry.field]: previous, fog: entry.fog ?? (entry.field === 'fog' ? previous : item.fog) } : item) };
}

module.exports = { rememberMapAction, undoMapAction };
