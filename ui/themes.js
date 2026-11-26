const ScreenThemes = Object.freeze({
  tavern: { name: 'Таверна', background: '#211610', accent: '#d5a872' },
  dark: { name: 'Чёрный сумрак', background: '#15171d', accent: '#c3b18b' },
  light: { name: 'Белая надежда', background: '#f7f3eb', accent: '#77531f' },
  red: { name: 'Бордовый', background: '#251f24', accent: '#d7a2ac' },
  orange: { name: 'Терракота', background: '#28221f', accent: '#d3a38a' },
  yellow: { name: 'Янтарный', background: '#27251f', accent: '#d0bd86' },
  green: { name: 'Шалфей', background: '#202622', accent: '#a6bda0' },
  cyan: { name: 'Морская волна', background: '#1e2528', accent: '#93bcbe' },
  blue: { name: 'Сумерки', background: '#20222b', accent: '#9dacd2' },
  violet: { name: 'Сиреневый', background: '#25212d', accent: '#baa8d2' },
  moon: { name: 'Лунное серебро', background: '#1c2026', accent: '#a7bed0' },
  parchment: { name: 'Старый пергамент', background: '#f0e2c4', accent: '#80542d' },
});

function themeIcon(id) {
  return id === 'tavern' ? 'assets/icon.png' : `assets/themes/${id}.png`;
}

if (typeof module !== 'undefined') module.exports = { ScreenThemes, themeIcon };
