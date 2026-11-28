(function () {
  const definitions = [
    ['search', 'K', 'Быстрый поиск и команды'],
    ['reference-address', 'L', 'Поле поиска в справочнике'],
    ['reference-new', 'T', 'Новая вкладка в справочнике'],
    ['reference-close', 'W', 'Закрыть вкладку справочника'],
    ['next-turn', 'N', 'Следующий ход'],
    ['new-combatant', 'A', 'Добавить участника боя'],
    ['scenes', 'S', 'Открыть сцены'],
    ['journal', 'J', 'Открыть журнал сессий'],
    ['round-events', 'E', 'Открыть события боя'],
    ['music', 'M', 'Воспроизвести музыку или поставить на паузу'],
    ['blackout', 'B', 'Затемнить или вернуть экран игроков'],
    ['fog', 'F', 'Включить или выключить туман войны'],
    ['fullscreen', 'P', 'Полноэкранный режим'],
    ['shortcut-help', 'H', 'Настройки горячих клавиш'],
    ['dice', 'D', 'Меню бросков'],
    ['workspace', 'G', 'Переключить «Ведение» и «Подготовку»']
  ];
  const defaults = Object.fromEntries(definitions.map(([id, letter]) => [id, letter]));
  function restoreShortcuts(value) {
    const saved = Object.fromEntries(definitions.filter(([id]) => Object.hasOwn(value ?? {}, id)).map(([id]) => [id, value[id]]));
    const used = new Set(Object.values(saved));
    for (const [id, preferred] of definitions) {
      if (Object.hasOwn(saved, id)) continue;
      saved[id] = [preferred, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find(letter => !used.has(letter));
      used.add(saved[id]);
    }
    return validateShortcuts({ ...defaults, ...saved }) ?? defaults;
  }
  function validateShortcuts(value) {
    const keys = definitions.map(([id]) => value?.[id]);
    if (!keys.every(letter => typeof letter === 'string' && /^[A-Z]$/.test(letter)) || new Set(keys).size !== keys.length) return null;
    return Object.fromEntries(definitions.map(([id], index) => [id, keys[index]]));
  }
  function matchShortcut(input, bindings) {
    const ctrl = input.ctrlKey ?? input.control;
    const meta = input.metaKey ?? input.meta;
    const alt = input.altKey ?? input.alt;
    const shift = !!(input.shiftKey ?? input.shift);
    if (!ctrl || !alt || meta || shift || input.getModifierState?.('AltGraph')) return null;
    return definitions.find(([id]) => input.code === 'Key' + bindings[id])?.[0] ?? null;
  }
  const api = { definitions, defaults, validateShortcuts, restoreShortcuts, matchShortcut };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.DmShortcuts = api;
})();
