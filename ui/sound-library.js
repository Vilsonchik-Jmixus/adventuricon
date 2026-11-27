(function () {
  const pads = [
    ['fire', 'Огненная магия'], ['ice', 'Ледяная магия'], ['thunder', 'Звуковая магия'],
    ['sword', 'Удар мечом'], ['shot', 'Выстрел'], ['blunt', 'Тяжёлый удар'],
    ['bow', 'Выстрел из лука'], ['blast', 'Взрыв'], ['heal', 'Исцеление'], ['portal', 'Портал'],
    ['door', 'Скрип двери'], ['coins', 'Монеты'], ['monster', 'Рёв чудовища'],
    ['bell', 'Колокол'], ['trap', 'Ловушка'], ['water', 'Всплеск'],
    ['rain', 'Дождь', true], ['campfire', 'Костёр', true], ['wind', 'Ветер', true], ['dungeon', 'Подземелье', true]
  ];
  const moves = [
    ['step', 'Пешком'], ['armor', 'Тяжёлые доспехи'], ['fly', 'Полёт'], ['slither', 'Ползание'], ['none', 'Без звука']
  ];
  const conditions = [
    'unconscious', 'frightened', 'exhaustion', 'invisible', 'incapacitated', 'deafened',
    'petrified', 'restrained', 'blinded', 'poisoned', 'charmed', 'stunned', 'paralyzed', 'prone', 'grappled'
  ];
  const categories = ['Магия', 'Бой', 'Атмосфера'];
  const assignment = Object.fromEntries(pads.map(([id], index) => [id,
    [0, 1, 2, 8, 9].includes(index) ? 'Магия' : index < 10 ? 'Бой' : 'Атмосфера']));
  const preferenceDefaults = { enabled: true, volume: .48, clicks: true, dice: true, effects: true, movement: true,
    categories, assignment };
  function padShortcut(input, fromPage = false) {
    const digit = /^Numpad([0-9])$/.exec(input.code);
    const locked = fromPage ? input.getModifierState('NumLock') || input.key === digit?.[1]
      : input.key === digit?.[1] || input.modifiers?.includes('numlock');
    if (!digit || !locked || !(input.ctrlKey ?? input.control) ||
        (input.shiftKey ?? input.shift) || (input.metaKey ?? input.meta) || input.getModifierState?.('AltGraph')) return null;
    return pads[Number(digit[1]) + ((input.altKey ?? input.alt) ? 10 : 0)][0];
  }
  const ambientIds = pads.filter(([, , loop]) => loop).map(([id]) => id);
  const additions = [
    ['Магия', 'spell', [
      ['Магическая стрела', 440, 1], ['Энергетический щит', 330, 2], ['Молния', 175, 3], ['Снятие чар', 587, 4],
      ['Тёмное проклятие', 131, 5], ['Призыв фамильяра', 392, 6], ['Искра света', 784, 7], ['Благословение', 523, 8],
      ['Руна открывается', 262, 9], ['Щит отражает удар', 349, 10], ['Сон', 247, 11], ['Воскрешение', 659, 12]
    ]],
    ['Бой', 'combat', [
      ['Столкновение клинков', 1120, 1], ['Удар по щиту', 189, 2], ['Треск копья', 330, 3], ['Удар кинжалом', 780, 4],
      ['Взмах топора', 155, 5], ['Залп арбалета', 482, 6], ['Рикошет', 976, 7], ['Ломаются доспехи', 607, 8],
      ['Падение на камень', 116, 9], ['Стрела в дерево', 210, 10], ['Хруст кости', 286, 11], ['Осыпь камней', 91, 12]
    ]],
    ['Существа', 'beast', [
      ['Рычание волка', 133, 1], ['Храп огра', 82, 2], ['Крик гоблина', 365, 3], ['Дыхание дракона', 68, 4],
      ['Визг летучей мыши', 920, 5], ['Шипение змеи', 422, 6], ['Каркание ворона', 239, 7], ['Ржание лошади', 294, 8],
      ['Пение сирены', 524, 9], ['Треск скелета', 198, 10], ['Топот тролля', 96, 11], ['Вой призрака', 313, 12]
    ]],
    ['Таверна', 'tavern', [
      ['Звон кружек', 660, 1], ['Перелистывание книги', 292, 2], ['Ключ в замке', 804, 3], ['Пробка из бутылки', 190, 4],
      ['Звон у входа', 988, 5], ['Лютня барда', 393, 6], ['Барабан', 132, 7], ['Шелест пергамента', 313, 8],
      ['Пересыпание монет', 544, 9], ['Задвижка', 264, 10], ['Бьётся стекло', 1295, 11], ['Тост', 588, 12]
    ]],
    ['Дорога', 'trail', [
      ['Веточка под ногой', 232, 1], ['Шаги по гравию', 180, 2], ['Шаги по снегу', 270, 3], ['Галоп', 106, 4],
      ['Скрип телеги', 145, 5], ['Гром вдали', 80, 6], ['Хруст льда', 396, 7], ['Падение в воду', 160, 8],
      ['Сигнальный рог', 220, 9], ['Свист ветра', 545, 10], ['Крылья большой птицы', 174, 11], ['Туманная тропа', 260, 12]
    ]],
    ['Подземелье', 'dungeon', [
      ['Нажимная плита', 190, 1], ['Капля в пещере', 587, 2], ['Движение цепей', 450, 3], ['Решётка падает', 101, 4],
      ['Щелчок ловушки', 545, 5], ['Вылет дротиков', 780, 6], ['Саркофаг открывается', 89, 7], ['Ломается замок', 236, 8],
      ['Эхо в пустом зале', 342, 9], ['Колесо механизма', 159, 10], ['Тайная дверь', 291, 11], ['Подземный обвал', 73, 12]
    ]],
    ['Атмосфера', 'ambient', [
      ['Капли в пещере', 169, 1], ['Ночной лес', 211, 2], ['Лёгкий дождь', 276, 3], ['Метель', 99, 4],
      ['Берег моря', 143, 5], ['Река', 198, 6], ['Жаровня', 245, 7], ['Механическая комната', 80, 8],
      ['Шёпот в руинах', 112, 9], ['Волшебное поле', 157, 10], ['Шумная таверна', 121, 11], ['Тяжёлый ливень', 301, 12]
    ]]
  ];
  const catalogue = [
    ...pads.map(([id, label, loop]) => ({ id, label, loop: !!loop, category: assignment[id] })),
    ...additions.flatMap(([category, group, sounds]) => sounds.map(([label, pitch, style], index) =>
      ({ id: `chip-${group}-${index + 1}`, label, pitch, style, group, loop: group === 'ambient', category })))
  ];
  const byId = new Map(catalogue.map(sound => [sound.id, sound]));
  const stockProfile = { id: 'standard', name: 'Стандартный', slots: {} };
  function padSlot(preferences, id) {
    const profile = preferences.profiles?.find(entry => entry.id === preferences.selectedProfile) ?? stockProfile;
    if (profile.slots[id]) return profile.slots[id];
    if (profile.id !== stockProfile.id) return { name: '', sound: null, category: '', loop: false };
    const sound = byId.get(id);
    return { name: sound.label, sound: id, category: preferences.assignment[id], loop: sound.loop };
  }
  const api = { pads, ambientIds, moves, conditions, preferenceDefaults, padShortcut, catalogue, stockProfile, padSlot,
    catalogSound: id => byId.get(id),
    moveSound: (id, fallback = 'step') => moves.some(([key]) => key === id) ? id : fallback };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.SoundLibrary = api;
})();
