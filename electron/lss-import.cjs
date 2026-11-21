function number(value, fallback) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formula(value, variables) {
  if (value == null || value === '') return null;
  const expression = String(value).replace(/\s+/g, '').replaceAll('−', '-');
  if (!/^[+-]?(?:\d+|\[[A-Z]+\])(?:[+-](?:\d+|\[[A-Z]+\]))*$/.test(expression)) return null;
  const terms = expression.match(/[+-]?(?:\d+|\[[A-Z]+\])/g);
  const sum = terms.reduce((total, term) => {
    const key = /\[([A-Z]+)\]/.exec(term)?.[1];
    return total + (key ? (term.startsWith('-') ? -1 : 1) * (variables[key] ?? NaN) : Number(term));
  }, 0);
  return Number.isFinite(sum) ? sum : null;
}

function readCharacter(raw) {
  const document = JSON.parse(raw);
  if (document?.jsonType !== 'character') throw new Error('Выбери JSON-экспорт персонажа Long Story Short');
  const data = typeof document.data === 'string' ? JSON.parse(document.data) : document.data ?? document;
  const name = data?.name?.value;
  if (typeof name !== 'string' || !name.trim()) throw new Error('В листе Long Story Short нет имени персонажа');
  const variables = Object.fromEntries(['str', 'dex', 'con', 'int', 'wis', 'cha'].map(key =>
    [key.toUpperCase(), Math.floor((number(data.stats?.[key]?.score, 10) - 10) / 2)]));
  variables.PROF = number(data.proficiencyCustom || data.proficiency, 0);
  variables.LVL = number(data.info?.level?.value, 1);
  let maxHp = number(data.vitality?.['hp-max']?.value, 10);
  const initiative = data.vitality?.initiative?.value;
  const override = formula(initiative, variables);
  let initiativeBonus = override ?? variables.DEX;
  for (const bonus of Array.isArray(data.bonuses) ? data.bonuses : []) {
    if (!['initiative', 'hp.max'].includes(bonus?.target) || bonus.enabled === false) continue;
    const amount = formula(bonus.expr ?? bonus.value, variables);
    if (amount === null) continue;
    if (bonus.target === 'hp.max') maxHp = bonus.mode === 'set' ? amount : maxHp + amount;
    else initiativeBonus = bonus.mode === 'set' ? amount : initiativeBonus + amount;
  }
  const portrait = data.avatar?.webp || data.avatar?.jpeg;
  const base64 = typeof portrait === 'string' ? portrait.replace(/^data:image\/(?:webp|jpeg);base64,/, '') : '';
  return {
    name, maxHp, hp: number(data.vitality?.['hp-current']?.value, maxHp), initiativeBonus,
    portrait: base64.length <= 7_000_000 && /^[A-Za-z0-9+/]+={0,2}$/.test(base64) ? Buffer.from(base64, 'base64') : null,
    initiativeNeedsReview: !!initiative && override === null
  };
}
module.exports = { readCharacter };
