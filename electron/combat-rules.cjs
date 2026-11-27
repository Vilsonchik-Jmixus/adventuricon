const ROLES = {
  player: 'Персонаж игрока',
  ally: 'Союзник',
  enemy: 'Противник'
};

// Names follow dnd.su's D&D 5e (2014) condition reference.
const CONDITIONS = [
  ['unconscious', 'Бессознательный', 'Без созн.'],
  ['frightened', 'Испуганный', 'Испуг'],
  ['exhaustion', 'Истощение', 'Истощ.'],
  ['invisible', 'Невидимый', 'Невид.'],
  ['incapacitated', 'Недееспособный', 'Недеесп.'],
  ['deafened', 'Оглохший', 'Глух'],
  ['petrified', 'Окаменевший', 'Камень'],
  ['restrained', 'Опутанный', 'Опутан'],
  ['blinded', 'Ослеплённый', 'Слеп'],
  ['poisoned', 'Отравленный', 'Яд'],
  ['charmed', 'Очарованный', 'Очар.'],
  ['stunned', 'Ошеломлённый', 'Оглуш.'],
  ['paralyzed', 'Парализованный', 'Парал.'],
  ['prone', 'Сбитый с ног', 'Ничком'],
  ['grappled', 'Схваченный', 'Схвачен']
].map(([id, name, badge]) => ({ id, name, badge }));

const MANUAL_IDS = new Set(CONDITIONS.filter(item => item.id !== 'exhaustion').map(item => item.id));
const roleOf = value => Object.hasOwn(ROLES, value) ? value : 'enemy';
const mayShareHp = actor => roleOf(actor.role) !== 'enemy';
const revealsFog = actor => mayShareHp(actor) && actor.hp > 0;
function effectsFor(actor) {
  const active = new Set(actor.conditions ?? []);
  if (actor.hp === 0) active.add('unconscious');
  if (actor.exhaustion > 0) active.add('exhaustion');
  return CONDITIONS.filter(({ id }) => active.has(id)).map(({ id, name, badge }) => ({
    id, name: id === 'exhaustion' ? `${name} · ${actor.exhaustion}` : name,
    badge: id === 'exhaustion' ? `${badge} ${actor.exhaustion}` : badge,
    ...(actor.durations?.[id] > 0 ? { rounds: actor.durations[id] } : {})
  }));
}
function playerMapActors(actors, shareHealth) {
  return actors.map(({ id, name, image, role, effects, hp, maxHp, tokenSize, tokenFrame, visionFeet }) => ({
    id, name, image, role, effects, tokenSize, tokenFrame, visionFeet,
    ...(shareHealth && mayShareHp({ role }) ? { hp, maxHp } : {})
  }));
}
module.exports = { ROLES, CONDITIONS, MANUAL_IDS, roleOf, effectsFor, playerMapActors, revealsFog };
