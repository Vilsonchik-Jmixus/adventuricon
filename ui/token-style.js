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
    ['bronze-laurel', 'Бронзовый лавр', '#e6bf79', '#526045', 'laurel', 'inlay'],
    ['witchfire', 'Ведьмин огонь', '#96eec2', '#295a5a', 'flame', 'sparks'],
    ['garnet-crown', 'Гранатовая корона', '#ffac87', '#8c2938', 'crown', 'inlay'],
    ['silver-wings', 'Серебряные крылья', '#e2eefc', '#647594', 'wings', 'stripes'],
    ['mechanism', 'Часовой механизм', '#efd678', '#79553c', 'gear', 'rivets'],
    ['deep-pearl', 'Жемчуг глубин', '#caf8f1', '#397c82', 'petals', 'pearls'],
    ['dragon-scale', 'Драконья чешуя', '#e7cd78', '#a74832', 'shield', 'stripes'],
    ['winter-crown', 'Зимняя корона', '#dbfaff', '#5171b9', 'crown', 'sparks'],
    ['lotus', 'Розовый лотос', '#ffb9d7', '#8f528f', 'petals', 'inlay'],
    ['night-watch', 'Ночной дозор', '#a6ade6', '#333456', 'shield', 'inlay'],
    ['phoenix', 'Феникс', '#ffca77', '#b84d58', 'wings', 'sparks'],
    ['amber-forge', 'Янтарная кузня', '#ffc581', '#8c4b36', 'flame', 'rivets'],
    ['forest-warden', 'Страж леса', '#bfd791', '#426244', 'laurel', 'pearls'],
    ['royal-banner', 'Королевский стяг', '#f4d695', '#71509b', 'crown', 'pearls'],
    ['ocean-compass', 'Морской компас', '#8ceaff', '#2b5191', 'gear', 'inlay'],
    ['black-sun', 'Чёрное солнце', '#f1bc83', '#442e42', 'gear', 'sparks'],
    ['jade-talisman', 'Нефритовый талисман', '#baf1b4', '#30755e', 'octagon', 'inlay'],
    ['twilight-moth', 'Сумеречный мотылёк', '#d4acf2', '#625484', 'wings', 'pearls'],
    ['desert-bloom', 'Цветок пустыни', '#ffd49a', '#ac6270', 'petals', 'stripes'],
    ['dusk-rose', 'Сумеречная роза', '#f2a3b6', '#6a385f', 'laurel', 'sparks'],
  ];
  const catalogue = new Map(frames.map(frame => [frame[0], frame]));
  const size = value => [.5, 1, 2, 3].includes(Number(value)) ? Number(value) : 1;
  const frame = value => catalogue.get(value) ?? frames[0];
  return { frames, size, frame };
})();

if (typeof module !== 'undefined') module.exports = TokenStyle;
