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
  const api = { pads, ambientIds, moves, conditions, preferenceDefaults, padShortcut,
    moveSound: (id, fallback = 'step') => moves.some(([key]) => key === id) ? id : fallback };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.SoundLibrary = api;
})();
