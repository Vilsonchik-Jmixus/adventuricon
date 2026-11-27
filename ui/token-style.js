const TokenStyle = (() => {
  const frames = [
    ['gold', 'Чеканное золото', '#ffd58a', '#825020', 'round', 'rivets'],
    ['ruby', 'Рубин', '#ff8483', '#89294e', 'octagon', 'gems'],
    ['emerald', 'Изумруд', '#92e9af', '#235a47', 'diamond', 'gems'],
    ['sapphire', 'Сапфир', '#87caff', '#304994', 'octagon', 'gems'],
    ['amethyst', 'Аметист', '#ddb5ff', '#563386', 'diamond', 'gems'],
    ['frost', 'Мороз', '#cdfbff', '#47798f', 'star', 'gems'],
    ['embers', 'Жар', '#ffbc63', '#ac3e2a', 'star', 'runes'],
    ['ivy', 'Плющ', '#cae481', '#415f36', 'round', 'runes'],
    ['bone', 'Кость', '#f0dfb3', '#73645e', 'shield', 'rivets'],
    ['iron', 'Железо', '#bdcbd7', '#48556b', 'square', 'rivets'],
    ['moon', 'Лунный камень', '#e1e4ff', '#4d537d', 'round', 'gems'],
    ['sun', 'Солнце', '#ffe370', '#ad692c', 'star', 'rivets'],
    ['coral', 'Коралл', '#ffb7ae', '#a04a63', 'shield', 'gems'],
    ['tide', 'Прибой', '#7cebd8', '#2f688a', 'round', 'runes'],
    ['obsidian', 'Обсидиан', '#c3a8e5', '#363047', 'octagon', 'rivets'],
    ['moss', 'Мох', '#adcf75', '#55613c', 'square', 'runes'],
    ['rose', 'Роза', '#ffafd9', '#853b73', 'star', 'gems'],
    ['copper', 'Медь', '#f5ad7c', '#7d4f43', 'shield', 'rivets'],
    ['runes', 'Древние руны', '#f8e9ae', '#756a43', 'diamond', 'runes'],
    ['storm', 'Грозовое небо', '#a5b8ff', '#42395b', 'square', 'gems'],
  ];
  const catalogue = new Map(frames.map(frame => [frame[0], frame]));
  const size = value => [.5, 1, 2, 3].includes(Number(value)) ? Number(value) : 1;
  const frame = value => catalogue.get(value) ?? frames[0];
  return { frames, size, frame };
})();

if (typeof module !== 'undefined') module.exports = TokenStyle;
