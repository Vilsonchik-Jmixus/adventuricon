const DND_HOME = 'https://dnd.su/';
const WEB_HOME = 'https://duckduckgo.com/';
const GEMINI = 'https://gemini.google.com/app';
const REFERENCE_LINKS = [
  ['classes', 'Классы', '/class/'],
  ['races', 'Расы', '/race/'],
  ['spells', 'Заклинания', '/spells/'],
  ['monsters', 'Бестиарий', '/bestiary/'],
  ['armor', 'Доспехи', '/articles/inventory/95-armor-and-shields/'],
  ['weapons', 'Оружие', '/articles/inventory/96-arms/'],
  ['gear', 'Снаряжение', '/articles/inventory/98-equipment/'],
  ['items', 'Маг. предметы', '/items/'],
  ['conditions', 'Состояния', '/articles/mechanics/27-conditions/']
].map(([id, name, route]) => ({ id, name, url: new URL(route, DND_HOME).href }));

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
function searchUrl(value, rulesOnly) {
  const phrase = String(value ?? '').trim().slice(0, 500);
  if (!phrase) throw new Error('Введите запрос');
  if (!rulesOnly && /^https?:\/\//i.test(phrase)) {
    const url = safeUrl(phrase);
    if (!url) throw new Error('Введите адрес HTTPS');
    return url;
  }
  const url = new URL(WEB_HOME);
  url.searchParams.set('q', rulesOnly ? `site:dnd.su ${phrase}` : phrase);
  url.searchParams.set('kl', 'ru-ru');
  return url.href;
}
module.exports = { DND_HOME, WEB_HOME, GEMINI, REFERENCE_LINKS, safeUrl, searchUrl };
