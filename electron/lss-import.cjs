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

function imageFormat(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function readPortrait(avatar) {
  const sources = typeof avatar === 'string' ? [avatar] : [avatar?.webp, avatar?.jpeg, avatar?.png, avatar?.jpg];
  for (const source of sources) {
    if (typeof source !== 'string' || source.length > 12 * 1024 * 1024) continue;
    const base64 = source.trim().replace(/^data:image\/(?:webp|jpe?g|png);base64,/i, '').replace(/\s/g, '');
    if (base64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) continue;
    const bytes = Buffer.from(base64, 'base64');
    const extension = imageFormat(bytes);
    if (extension) return { bytes, extension };
  }
  return null;
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
  return {
    name, maxHp, hp: number(data.vitality?.['hp-current']?.value, maxHp), initiativeBonus,
    portrait: readPortrait(data.avatar),
    initiativeNeedsReview: !!initiative && override === null
  };
}
module.exports = { readCharacter };
