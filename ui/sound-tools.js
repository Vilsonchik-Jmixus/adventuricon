function createSoundTools({ retro, api, result, openDialog, toast }) {
  const get = id => document.getElementById(id);
  const pad = get('sound-pad'), tracks = get('music-tracks');
  const { pads, moves, preferenceDefaults, padShortcut } = SoundLibrary;
  let preferences = preferenceDefaults, active = new Set();
  const category = get('sound-category'), categoryDialog = get('sound-categories-dialog'), assignments = get('sound-assignments');
  const removeChoice = get('remove-category-choice'), removeCategory = get('remove-sound-category');
  function renderFilter() {
    const filter = category.value;
    for (const button of pad.querySelectorAll('[data-sound-pad]')) {
      button.hidden = !!filter && preferences.assignment[button.dataset.soundPad] !== filter;
    }
    for (const bank of pad.querySelectorAll('fieldset')) bank.hidden = !bank.querySelector('[data-sound-pad]:not([hidden])');
  }
  category.onchange = renderFilter;
  get('edit-sound-categories').onclick = () => { openDialog(categoryDialog.id); renderCategories(); };
  get('new-sound-category').onsubmit = async event => {
    event.preventDefault();
    const input = event.currentTarget.elements.name;
    const name = input.value.trim();
    if (!name) return;
    if (preferences.categories.some(value => value.toLowerCase() === name.toLowerCase())) return toast('Такая категория уже есть');
    if (preferences.categories.length >= 32) return toast('Можно создать до 32 категорий');
    if ((await result(api.soundPreferences({ categories: [...preferences.categories, name] })))?.ok) input.value = '';
  };
  removeChoice.onchange = () => { removeCategory.disabled = !removeChoice.value; };
  removeCategory.onclick = () => {
    const name = removeChoice.value;
    if (name && confirm(`Удалить категорию «${name}»? Звуки останутся в общем списке.`)) {
      result(api.soundPreferences({ categories: preferences.categories.filter(value => value !== name) }));
    }
  };
  function renderCategories() {
    const options = () => preferences.categories.map(name => new Option(name, name));
    const current = category.value;
    category.replaceChildren(new Option('Все звуки', ''), ...options());
    category.value = preferences.categories.includes(current) ? current : '';
    renderFilter();
    if (!categoryDialog.open && assignments.children.length) return;
    const previousRemoval = removeChoice.value;
    removeChoice.replaceChildren(new Option('Выбери категорию', ''), ...options());
    removeChoice.value = preferences.categories.includes(previousRemoval) ? previousRemoval : '';
    removeChoice.onchange();
    assignments.replaceChildren(...pads.map(([id, name]) => {
      const label = document.createElement('label'), select = document.createElement('select');
      label.append(name, select);
      select.replaceChildren(new Option('Без категории', ''), ...options());
      select.value = preferences.assignment[id];
      select.dataset.categoryFor = id;
      select.onchange = () => result(api.assignPadCategory(id, select.value));
      return label;
    }));
  }
  for (const [index, [id, name, loop]] of pads.entries()) {
    const button = document.createElement('button'), key = document.createElement('kbd');
    button.type = 'button';
    button.dataset.soundPad = id;
    key.textContent = String(index % 10);
    button.append(key, name);
    button.title = `Num Lock · Ctrl + ${index >= 10 ? 'Alt + ' : ''}NumPad ${index % 10}${loop ? ' · Цикл' : ''}`;
    if (loop) button.setAttribute('aria-pressed', 'false');
    button.onclick = () => trigger(id);
    get(index < 10 ? 'sound-pad-a' : 'sound-pad-b').append(button);
  }
  get('music-tracks-tab').onclick = () => select(false);
  get('sound-pad-tab').onclick = () => select(true);
  get('stop-ambient').onclick = () => trigger('stop-ambient');
  get('sound-preview-step').onclick = () => {
    const id = get('combatant-form').elements.movementSound.value;
    if (id === 'none') return;
    if (retro) retro.play(id);
    else result(api.soundMovementPreview(id));
  };
  get('combatant-form').elements.movementSound.addEventListener('change', event => {
    get('sound-preview-step').disabled = event.target.value === 'none';
  });
  get('combatant-form').elements.movementSound.replaceChildren(...moves.map(([id, label]) => new Option(label, id)));
  const fields = get('sound-options');
  fields.onchange = () => {
    const next = Object.fromEntries([...fields.querySelectorAll('[data-sound-option]')].map(input =>
      [input.dataset.soundOption, input.type === 'range' ? Number(input.value) / 100 : input.checked]));
    result(api.soundPreferences(next));
  };
  function select(showPad) {
    tracks.hidden = showPad;
    pad.hidden = !showPad;
    get('music-tracks-tab').setAttribute('aria-pressed', String(!showPad));
    get('sound-pad-tab').setAttribute('aria-pressed', String(showPad));
  }
  function setActive(ids, report = false) {
    active = new Set(ids);
    for (const button of pad.querySelectorAll('[aria-pressed][data-sound-pad]')) {
      button.setAttribute('aria-pressed', String(active.has(button.dataset.soundPad)));
    }
    get('stop-ambient').disabled = !active.size;
    if (report && retro) result(api.soundPadState([...active]));
  }
  function trigger(id) {
    if (!retro) return result(api.soundPad(id));
    if (id === 'stop-ambient') {
      for (const id of active) retro.stop(id);
      setActive([], true);
      return;
    }
    if (!preferences.enabled) return;
    const looping = retro.play(id, null, true);
    if (looping || active.has(id)) {
      if (looping) active.add(id);
      else active.delete(id);
      setActive(active, true);
    }
  }
  function apply(next) {
    const catalogueChanged = JSON.stringify(preferences.categories) !== JSON.stringify(next.categories) ||
      pads.some(([id]) => preferences.assignment[id] !== next.assignment[id]);
    preferences = next;
    for (const input of fields.querySelectorAll('[data-sound-option]')) {
      const value = next[input.dataset.soundOption];
      if (input.type === 'range') input.value = Math.round(value * 100);
      else input.checked = value;
    }
    retro?.apply(next);
    if (!next.enabled && active.size) setActive([], !!retro);
    if (catalogueChanged || !category.options.length) renderCategories();
  }
  function status(message) {
    if (!retro) return;
    if (message.pad) trigger(message.id);
    else if (message.ids) message.ids.forEach((id, index) => {
      setTimeout(() => retro.play(id, message.category), index * 175);
    });
    else retro.play(message.id, message.category);
  }
  function shortcut(event) {
    const id = padShortcut(event, true);
    if (!id) return false;
    event.preventDefault();
    if (!event.repeat) trigger(id);
    return true;
  }
  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled || button.closest('#sound-pad, #sound-options') || button.id === 'sound-preview-step' ||
        button.matches('[data-roll-actor], [data-roll-role]') || !preferences.enabled || !preferences.clicks) return;
    if (retro) retro.play('click', 'clicks');
    else result(api.soundClick());
  }, { capture: true });
  return { apply, status, setActive, shortcut };
}
