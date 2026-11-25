const normalize = value => String(value ?? '').toLocaleLowerCase('ru').replaceAll('ё', 'е');

function searchCampaign(state, query) {
  const words = normalize(query).trim().slice(0, 160).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const results = [];
  function add(kind, item, title, detail = '', parentId) {
    const name = normalize(title), description = normalize(detail);
    if (!words.every(word => name.includes(word) || description.includes(word))) return;
    const score = words.reduce((sum, word) => sum + (name.startsWith(word) ? 3 : name.includes(word) ? 2 : 0), 0);
    const detailMatch = words.find(word => description.includes(word));
    const start = detailMatch ? Math.max(0, description.indexOf(detailMatch) - 28) : 0;
    results.push({ kind, id: item.id, parentId, title, detail: detail.slice(start, start + 125), score });
  }
  for (const item of state.scenes) add('scene', item, item.title);
  for (const item of state.boards) add('map', item, item.title);
  for (const battle of state.battles) {
    add('battle', battle, battle.title);
    for (const actor of battle.combatants) add('actor', actor, actor.name, battle.title, battle.id);
  }
  for (const item of state.story.notes) add('note', item, item.title, item.body);
  for (const session of state.journal.sessions) {
    add('session', session, session.title);
    for (const entry of session.entries) add('entry', entry, session.title, entry.body, session.id);
  }
  return results.sort((a, b) => b.score - a.score).slice(0, 60);
}

module.exports = { searchCampaign };
