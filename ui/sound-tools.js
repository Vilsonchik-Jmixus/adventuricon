function createSoundTools({ retro, api, result, openDialog, toast }) {
  const get = id => document.getElementById(id);
  const pad = get('sound-pad'), tracks = get('music-tracks');
  const { pads, moves, preferenceDefaults, padShortcut, padSlot, stockProfile } = SoundLibrary;
  let preferences = preferenceDefaults, active = new Set(), playing = false;
  const manualLoops = new Map(), sceneLoops = new Set(), media = new Map();
  const buttons = new Map();
  let layoutKey;
  const editor = createSoundpadEditor({ api, result, openDialog, getPreferences: () => preferences });
  const category = get('sound-category'), categoryDialog = get('sound-categories-dialog'), assignments = get('sound-assignments');
  const removeChoice = get('remove-category-choice'), removeCategory = get('remove-sound-category');
  function renderFilter() {
    const filter = category.value;
    for (const button of pad.querySelectorAll('[data-sound-pad]')) {
      button.hidden = !!filter && padSlot(preferences, button.dataset.soundPad).category !== filter;
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
    assignments.replaceChildren(...pads.map(([id], index) => {
      const label = document.createElement('label'), select = document.createElement('select');
      const slot = padSlot(preferences, id);
      label.append(slot.name || `Кнопка ${index + 1}`, select);
      select.replaceChildren(new Option('Без категории', ''), ...options());
      select.value = slot.category;
      select.dataset.categoryFor = id;
      select.onchange = () => result(api.assignPadCategory(id, select.value));
      return label;
    }));
  }
  for (const [index, [id]] of pads.entries()) {
    const button = document.createElement('button'), key = document.createElement('kbd'), label = document.createElement('span');
    button.type = 'button';
    button.dataset.soundPad = id;
    key.textContent = String(index % 10);
    label.className = 'pad-label';
    button.append(key, label);
    button.onclick = () => {
      const slot = padSlot(preferences, id);
      if (!slot.sound && !slot.asset) return editor.open(id);
      trigger(id);
    };
    button.oncontextmenu = event => { event.preventDefault(); editor.open(id); };
    buttons.set(id, { button, label });
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
  function setActive(ids, running = ids.length > 0) {
    active = new Set(ids);
    playing = running;
    for (const button of pad.querySelectorAll('[aria-pressed][data-sound-pad]')) {
      button.setAttribute('aria-pressed', String(active.has(button.dataset.soundPad)));
    }
    get('stop-ambient').disabled = !playing;
  }
  function stopMedia(key) {
    const audio = media.get(key);
    if (!audio) return;
    media.delete(key);
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
  }
  function stopSlot(id) {
    manualLoops.delete(id);
    retro.stop(`slot:${id}`);
    stopMedia(id);
  }
  function clearSlots() {
    for (const id of manualLoops.keys()) stopSlot(id);
    for (const key of media.keys()) stopMedia(key);
  }
  function reportActive() {
    const ids = pads.map(([id]) => id).filter(id => manualLoops.has(id) || sceneLoops.has(padSlot(preferences, id).sound));
    const running = !!(manualLoops.size || sceneLoops.size);
    if (running === playing && ids.length === active.size && ids.every(id => active.has(id))) return;
    setActive(ids, running);
    result(api.soundPadState(ids, running));
  }
  function playFile(slot, key, loop) {
    stopMedia(key);
    const audio = new Audio(`dm://app/soundpad/${encodeURIComponent(slot.asset)}`);
    audio.volume = preferences.volume;
    audio.loop = loop;
    media.set(key, audio);
    audio.onended = () => { if (media.get(key) === audio) stopMedia(key); };
    const failed = () => {
      if (media.get(key) !== audio) return;
      stopMedia(key);
      if (loop) { manualLoops.delete(key); reportActive(); }
      toast('Аудиофайл саундпада не воспроизводится');
    };
    audio.onerror = failed;
    audio.play().catch(failed);
  }
  function trigger(id) {
    if (!retro) return result(api.soundPad(id));
    if (id === 'stop-ambient') {
      for (const key of manualLoops.keys()) stopSlot(key);
      for (const sound of sceneLoops) retro.stop(sound);
      sceneLoops.clear();
      reportActive();
      return;
    }
    if (!preferences.enabled) return;
    const slot = padSlot(preferences, id);
    if (manualLoops.has(id)) { stopSlot(id); reportActive(); return; }
    if (!slot.asset && sceneLoops.has(slot.sound)) {
      retro.stop(slot.sound);
      sceneLoops.delete(slot.sound);
      reportActive();
      return;
    }
    if (slot.asset) playFile(slot, id, slot.loop);
    else if (slot.sound) retro.play(slot.sound, null, false, 0, `slot:${id}`, slot.loop);
    if (slot.loop && (slot.sound || slot.asset)) { manualLoops.set(id, true); reportActive(); }
  }
  function apply(next) {
    const current = next.profiles?.find(profile => profile.id === next.selectedProfile) ?? stockProfile;
    const key = JSON.stringify([current, current.id === stockProfile.id ? next.assignment : null, next.categories]);
    const changed = layoutKey !== key;
    if (retro && layoutKey && changed) {
      if (preferences.selectedProfile !== next.selectedProfile) clearSlots();
      else for (const [id] of pads) {
        const before = padSlot(preferences, id), after = padSlot(next, id);
        if (before.sound !== after.sound || before.asset !== after.asset || before.loop !== after.loop) stopSlot(id);
      }
    }
    preferences = next;
    for (const input of fields.querySelectorAll('[data-sound-option]')) {
      const value = next[input.dataset.soundOption];
      if (input.type === 'range') input.value = Math.round(value * 100);
      else input.checked = value;
    }
    retro?.apply(next);
    for (const audio of media.values()) audio.volume = next.volume;
    if (!next.enabled && retro) {
      clearSlots();
      sceneLoops.clear();
    }
    if (changed) {
      layoutKey = key;
      for (const [index, [id]] of pads.entries()) {
        const slot = padSlot(next, id), { button, label } = buttons.get(id);
        const empty = !slot.asset && !slot.sound;
        label.textContent = empty ? '+ Назначить' : slot.name || SoundLibrary.catalogSound(slot.sound)?.label || slot.sourceName || 'MP3';
        button.classList.toggle('empty-pad', empty);
        button.title = `Num Lock · Ctrl + ${index >= 10 ? 'Alt + ' : ''}NumPad ${index % 10}${slot.loop ? ' · Цикл' : ''}`;
        if (slot.loop) button.setAttribute('aria-pressed', String(active.has(id)));
        else button.removeAttribute('aria-pressed');
      }
      editor.render();
      renderCategories();
    }
    if (retro && (changed || !next.enabled)) reportActive();
  }
  function status(message) {
    if (!retro) return;
    if (message.ambience) {
      clearSlots();
      sceneLoops.clear();
      for (const id of retro.setAmbience(message.ambience)) sceneLoops.add(id);
      reportActive();
    }
    else if (message.padPreview && preferences.enabled) {
      if (message.padPreview.asset) playFile(message.padPreview, 'preview', false);
      else if (message.padPreview.sound) retro.play(message.padPreview.sound, null, false, 0, 'preview', false);
    }
    else if (message.pad) trigger(message.id);
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
        button.matches('#dice-form [type=submit]') ||
        button.matches('[data-roll-actor], [data-roll-role]') || !preferences.enabled || !preferences.clicks) return;
    if (retro) retro.play('click', 'clicks');
    else result(api.soundClick());
  }, { capture: true });
  function entries() {
    return pads.flatMap(([id]) => {
      const slot = padSlot(preferences, id);
      if (!slot.sound && !slot.asset) return [];
      return [{ id, title: slot.name || SoundLibrary.catalogSound(slot.sound)?.label || slot.sourceName || 'MP3',
        category: slot.category, loop: slot.loop }];
    });
  }
  return { apply, status, setActive, shortcut, trigger, entries, importStatus: editor.importStatus };
}

function createSoundpadEditor({ api, result, openDialog, getPreferences }) {
  const get = id => document.getElementById(id);
  const dialog = get('soundpad-settings'), profiles = get('soundpad-profile');
  const profileForm = get('soundpad-profile-form'), form = get('soundpad-slot-form');
  const fields = form.elements, youtube = get('soundpad-youtube-url'), info = get('soundpad-import-status');
  const { pads, padSlot, catalogue, catalogSound, stockProfile } = SoundLibrary;
  let profileId, draftAsset, busy = false;
  const profile = () => getPreferences().profiles?.find(item => item.id === getPreferences().selectedProfile) ?? stockProfile;
  const edit = values => result(api.editSoundpad({ id: profileId, ...values }));
  const status = text => { info.hidden = !text; info.value = text || ''; };
  const labelFor = index => `Ctrl + ${index >= 10 ? 'Alt + ' : ''}NumPad ${index % 10}`;
  const libraryGroups = Map.groupBy(catalogue, sound => sound.category);
  fields.sound.append(new Option('Без звука', ''));
  for (const [category, items] of libraryGroups) {
    const group = document.createElement('optgroup');
    group.label = category;
    group.append(...items.map(sound => new Option(sound.label + (sound.loop ? ' · цикл' : ''), sound.id)));
    fields.sound.append(group);
  }
  function loadSlot() {
    const slot = padSlot(getPreferences(), fields.slot.value);
    draftAsset = slot.asset ? { asset: slot.asset, title: slot.sourceName } : null;
    fields.name.value = slot.name;
    fields.sound.value = slot.sound ?? '';
    fields.category.value = slot.category;
    fields.loop.checked = slot.loop;
    youtube.value = '';
    status(draftAsset?.title);
  }
  function open(id) {
    const active = profile();
    profileId = active.id;
    profileForm.elements.name.value = active.name;
    get('delete-soundpad').hidden = active.id === stockProfile.id;
    fields.slot.replaceChildren(...pads.map(([key], i) => new Option(labelFor(i) + (padSlot(getPreferences(), key).name ? " · " + padSlot(getPreferences(), key).name : ""), key)));
    fields.category.replaceChildren(new Option('Без категории', ''), ...getPreferences().categories.map(name => new Option(name, name)));
    fields.slot.value = id ?? pads[0][0];
    loadSlot();
    openDialog(dialog.id);
  }
  const value = () => ({ name: fields.name.value, sound: fields.sound.value, category: fields.category.value,
    loop: fields.loop.checked, asset: draftAsset?.asset, sourceName: draftAsset?.title });
  profiles.onchange = () => edit({ type: 'select', id: profiles.value });
  get('configure-soundpad').onclick = () => open();
  get('new-soundpad').onclick = async () => {
    const count = getPreferences().profiles?.length ?? 1;
    const response = await edit({ type: 'create', name: `Саундпад ${count}` });
    if (response?.ok) open();
  };
  fields.slot.onchange = loadSlot;
  fields.sound.onchange = () => {
    const entry = catalogSound(fields.sound.value);
    draftAsset = null;
    fields.loop.checked = entry?.loop === true;
    if (!fields.name.value && entry) fields.name.value = entry.label;
    status('');
  };
  profileForm.onsubmit = async event => {
    event.preventDefault();
    await edit({ type: 'rename', name: profileForm.elements.name.value });
  };
  get('delete-soundpad').onclick = async () => {
    if (confirm(`Удалить «${profileForm.elements.name.value}»?`) && (await edit({ type: 'remove' }))?.ok) {
      dialog.querySelector('[data-close-dialog]').click();
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (!busy && (await edit({ type: 'save', slot: fields.slot.value, value: value() }))?.ok) status('Кнопка сохранена');
  };
  get('clear-soundpad-slot').onclick = async () => {
    if ((await edit({ type: 'save', slot: fields.slot.value, value: {} }))?.ok) loadSlot();
  };
  get('preview-soundpad').onclick = () => result(api.previewSoundpad(value()));
  async function importAudio(url) {
    if (busy) return;
    const target = { profileId, slot: fields.slot.value };
    busy = true;
    const controls = [...form.querySelectorAll('input, select, button:not(#soundpad-cancel-import)')];
    controls.forEach(control => { control.disabled = true; });
    get('soundpad-cancel-import').hidden = !url;
    status(url ? 'Получаем звук с YouTube…' : 'Выбор MP3…');
    try {
      const response = await result(api.importSoundpad(url));
      if (!dialog.open || profileId !== target.profileId || fields.slot.value !== target.slot) return;
      if (response?.ok) {
        draftAsset = response;
        fields.sound.value = '';
        if (!fields.name.value) fields.name.value = response.title;
        status(response.title || 'MP3 загружен');
      } else status(response?.error || '');
    } finally {
      busy = false;
      controls.forEach(control => { control.disabled = false; });
      get('soundpad-cancel-import').hidden = true;
    }
  }
  get('soundpad-import-mp3').onclick = () => importAudio();
  get('soundpad-import-youtube').onclick = () => importAudio(youtube.value.trim() || ' ');
  get('soundpad-cancel-import').onclick = () => result(api.cancelSoundpad());
  const importStatus = message => { if (busy && dialog.open) status(message.text); };
  function render() {
    profiles.replaceChildren(...(getPreferences().profiles ?? [stockProfile]).map(({ id, name }) => new Option(name, id)));
    profiles.value = profile().id;
  }
  return { render, open, importStatus };
}
