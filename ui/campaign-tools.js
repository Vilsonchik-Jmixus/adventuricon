function createCampaignTools({ getState, getContext, dispatch, search, quickActions, eventMapDoors, pickEventCells, openDialog, closeDialog, askText, navigate }) {
  const get = id => document.getElementById(id);
  const searchDialog = get('campaign-search-dialog'), query = get('campaign-query'), results = get('campaign-search-results');
  const roundDialog = get('round-events-dialog'), eventForm = get('round-event-form'), eventButton = get('open-round-events');
  const saveEvent = get('save-round-event'), chooseCells = get('pick-round-cells');
  const journalDialog = get('journal-dialog'), journalForm = get('journal-form'), sessionSelect = get('journal-session');
  const kinds = { action: 'Команда', sound: 'Звук', scene: 'Сцена', map: 'Карта', battle: 'Бой', actor: 'Участник',
    template: 'Заготовка', track: 'Трек', note: 'Заметка', session: 'Сессия', entry: 'Журнал' };
  const date = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  let searchRequest = 0, searchTimer, selectedResult = 0;
  let eventId = null, eventContext, lastEventBattle, lastEvents, pendingEvents = new Set(), doorRequest = 0;
  let sessionId, editingEntry = null, journalContext;

  function button(label, icon, action) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (icon) element.dataset.pixelIcon = icon;
    element.onclick = action;
    return element;
  }
  function label(text, className) {
    const element = document.createElement('span');
    element.className = className;
    element.textContent = text;
    return element;
  }
  function renderSearch() {
    clearTimeout(searchTimer);
    const revision = ++searchRequest, phrase = query.value.trim(), context = getContext();
    results.replaceChildren();
    const status = get('campaign-search-status');
    const normalize = value => value.toLocaleLowerCase('ru').replaceAll('ё', 'е');
    const words = normalize(phrase).split(/\s+/).filter(Boolean);
    const local = quickActions().filter(entry => words.length
      ? words.every(word => normalize(`${entry.title} ${entry.detail ?? ''} ${entry.keywords ?? ''}`).includes(word))
      : entry.suggested);
    function show(matches, retainSelection = false) {
      selectedResult = retainSelection ? Math.min(selectedResult, Math.max(0, matches.length - 1)) : 0;
      results.replaceChildren(...matches.map(entry => {
        const row = button('', null, () => {
          if (context.expectedCampaignId !== getContext().expectedCampaignId) return renderSearch();
          closeDialog(searchDialog);
          if (entry.run) entry.run();
          else if (entry.kind === 'session' || entry.kind === 'entry') openJournal(entry.parentId ?? entry.id, entry.kind === 'entry' ? entry.id : null);
          else navigate(entry);
        });
        row.className = 'campaign-result';
        row.append(label(kinds[entry.kind], 'result-kind'), label(entry.title, 'result-title'));
        if (entry.detail) row.append(label(entry.detail, 'result-detail'));
        return row;
      }));
      highlightResult();
    }
    show(local);
    status.textContent = phrase ? 'Поиск в кампании…' : 'Быстрые команды';
    if (!phrase) return;
    searchTimer = setTimeout(async () => {
      let response;
      try { response = await search({ query: phrase, expectedCampaignId: context.expectedCampaignId }); }
      catch { response = { error: 'Не удалось выполнить поиск по кампании.' }; }
      if (revision !== searchRequest || !searchDialog.open || context.expectedCampaignId !== getContext().expectedCampaignId) return;
      const matches = [...local, ...(response?.matches ?? [])];
      status.textContent = response?.error || (matches.length ? '' : 'Совпадений нет.');
      show(matches, true);
    }, 100);
  }
  function highlightResult(scroll = false) {
    [...results.children].forEach((row, index) => row.classList.toggle('selected', index === selectedResult));
    if (scroll) results.children[selectedResult]?.scrollIntoView({ block: 'nearest' });
  }
  get('open-campaign-search').onclick = () => {
    query.value = '';
    openDialog(searchDialog.id);
    renderSearch();
    query.focus();
  };
  query.oninput = renderSearch;
  query.onkeydown = event => {
    if (!results.children.length || !['Enter', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Enter') return results.children[selectedResult].click();
    selectedResult = Math.min(results.children.length - 1, Math.max(0, selectedResult + (event.key === 'ArrowDown' ? 1 : -1)));
    highlightResult(true);
  };

  function editEvent(entry) {
    const state = getState(), fields = eventForm.elements, actions = entry?.actions;
    eventId = entry?.id ?? null;
    eventContext = getContext();
    fields.round.value = entry?.round ?? Math.min(9999, state.round + (state.turn ? 1 : 0));
    fields.title.value = entry?.title ?? '';
    fields.mapId.replaceChildren(...state.mapChoices.map(map => new Option(map.title, map.id)));
    fields.mapId.value = actions?.mapId || state.activeMapId;
    if (!fields.mapId.value) fields.mapId.value = state.activeMapId;
    selectOptions(fields.templateId, state.library, 'Без подкрепления', actions?.templateId, 'name');
    selectOptions(fields.trackId, state.music.tracks, 'Текущая музыка', actions?.trackId);
    fields.cells.value = (actions?.cells ?? []).map(({ col, row }) => `${col}, ${row}`).join('; ');
    get('round-event-cells').hidden = !fields.templateId.value;
    showEventError('');
    refreshDoors(actions?.doorId);
    saveEvent.textContent = entry ? 'Сохранить' : 'Добавить событие';
    get('cancel-event-edit').hidden = !entry;
  }
  function selectOptions(field, entries, empty, selected, titleKey = 'title') {
    const options = [new Option(empty, ''), ...entries.map(item => new Option(item[titleKey], item.id))];
    if (selected && !entries.some(item => item.id === selected)) options.push(new Option('Недоступно — выбери заново', selected));
    field.replaceChildren(...options);
    field.value = selected || '';
  }
  function showEventError(error) {
    const output = get('round-event-error');
    output.textContent = error ?? '';
    output.hidden = !error;
  }
  async function refreshDoors(selected) {
    const ticket = ++doorRequest, fields = eventForm.elements;
    const mapId = fields.mapId.value, owner = eventContext;
    selectOptions(fields.doorId, [], 'Без открытия двери', selected);
    fields.doorId.disabled = true;
    saveEvent.disabled = true;
    const response = await eventMapDoors({ mapId, expectedCampaignId: owner.expectedCampaignId });
    if (ticket !== doorRequest) return;
    selectOptions(fields.doorId, response?.doors ?? [], 'Без открытия двери', selected, 'label');
    fields.doorId.disabled = false;
    saveEvent.disabled = false;
    if (response?.error) showEventError(response.error);
  }
  eventForm.elements.mapId.onchange = () => { showEventError(''); refreshDoors(); };
  eventForm.elements.templateId.onchange = () => { get('round-event-cells').hidden = !eventForm.elements.templateId.value; };
  chooseCells.hidden = !pickEventCells;
  function parseCells(input) {
    return input.trim().split(';').map(part => /^\s*(\d{1,4})\s*,\s*(\d{1,4})\s*$/.exec(part)).map(pair =>
      pair ? { col: Number(pair[1]), row: Number(pair[2]) } : null);
  }
  chooseCells.onclick = () => {
    const { mapId, cells } = eventForm.elements;
    if (mapId.value !== getState().activeMapId) return showEventError('Чтобы выбрать клетки мышью, сначала открой нужную карту.');
    const before = parseCells(cells.value).filter(Boolean);
    closeDialog(roundDialog);
    pickEventCells(before, next => {
      if (eventContext.expectedCampaignId !== getContext().expectedCampaignId ||
          eventContext.expectedBattleId !== getContext().expectedBattleId) return;
      if (next) cells.value = next.map(({ col, row }) => `${col}, ${row}`).join('; ');
      openDialog(roundDialog.id);
    });
  };
  function renderRoundEvents(force = false) {
    const state = getState();
    if (lastEventBattle !== state.activeBattleId) {
      pendingEvents = new Set();
      if (roundDialog.open) editEvent();
      lastEventBattle = state.activeBattleId;
    }
    const fired = new Set(state.roundEvents.filter(entry => entry.fired).map(entry => entry.id));
    pendingEvents = new Set([...pendingEvents].filter(id => fired.has(id)));
    eventButton.classList.toggle('event-pending', pendingEvents.size > 0);
    eventButton.dataset.count = pendingEvents.size || '';
    get('round-events-context').textContent = state.battleChoices.find(entry => entry.id === state.activeBattleId)?.title ?? '';
    if (!roundDialog.open || !force && lastEvents === state.roundEvents) return;
    lastEvents = state.roundEvents;
    const list = get('round-events-list');
    list.replaceChildren(...[...lastEvents].sort((a, b) => a.round - b.round).map(entry => {
      const row = document.createElement('div');
      row.className = 'round-event';
      const title = button(entry.title, null, () => { editEvent(entry); eventForm.elements.title.focus(); });
      const remove = button('', 'trash', () => {
        if (confirm('Удалить событие?')) dispatch('combat:event-remove', { id: entry.id }, getContext());
      });
      remove.setAttribute('aria-label', 'Удалить событие ' + entry.title);
      row.append(label('Раунд ' + entry.round, 'result-kind'), title, remove);
      if (entry.executed) row.append(label('Выполнено', 'result-detail'));
      else if (entry.actions && entry.fired) {
        const controls = document.createElement('div');
        controls.className = 'round-event-controls';
        const run = button('Запустить', 'play', async () => {
          const response = await dispatch('combat:event-run', { id: entry.id }, getContext());
          if (!response?.ok) showEventError(response?.error);
        });
        const delay = button('На раунд позже', 'clock', async () => {
          const response = await dispatch('combat:event-delay', { id: entry.id }, getContext());
          if (!response?.ok) showEventError(response?.error);
        });
        controls.append(run, delay);
        row.append(controls);
      } else if (entry.fired) row.append(label('Сработало', 'result-detail'));
      else if (entry.actions) row.append(label('Есть действия', 'result-detail'));
      return row;
    }));
    if (!lastEvents.length) list.append(label('Добавь напоминание для нужного раунда.', 'dialog-hint'));
  }
  eventButton.onclick = () => {
    pendingEvents.clear();
    editEvent();
    openDialog(roundDialog.id);
    renderRoundEvents(true);
  };
  get('cancel-event-edit').onclick = () => editEvent();
  eventForm.onsubmit = async event => {
    event.preventDefault();
    const { title, round, mapId, templateId, doorId, trackId, cells: rawCells } = Object.fromEntries(new FormData(eventForm));
    if (eventForm.elements.doorId.disabled) return;
    const cells = templateId ? parseCells(rawCells) : [];
    if (cells.includes(null)) return showEventError('Введи клетки как «4, 5; 5, 5».');
    const response = await dispatch('combat:event-save', { title, round, id: eventId,
      actions: { mapId, templateId, doorId, trackId, cells } }, eventContext);
    if (response?.ok) editEvent();
    else showEventError(response?.error);
  };

  function editJournal(entry) {
    editingEntry = entry?.id ?? null;
    journalContext = getContext();
    journalForm.elements.body.value = entry?.body ?? '';
    get('save-journal-entry').textContent = entry ? 'Сохранить' : 'Добавить запись';
    get('cancel-journal-edit').hidden = !entry;
  }
  function renderJournal(reveal = null) {
    if (!journalDialog.open) return;
    const { sessions, active } = getState().journal;
    const selected = sessions.find(entry => entry.id === sessionId) ?? sessions.find(entry => entry.id === active) ?? sessions[0];
    if (selected?.id !== sessionId) { sessionId = selected?.id; editJournal(); }
    sessionSelect.replaceChildren(...sessions.map(entry => new Option(entry.title, entry.id)));
    sessionSelect.value = sessionId ?? '';
    sessionSelect.disabled = !sessions.length;
    journalForm.hidden = !selected;
    const activeButton = get('journal-active');
    activeButton.hidden = !selected;
    activeButton.textContent = sessionId === active ? 'Завершить запись сессии' : 'Сделать текущей';
    get('journal-summary').textContent = selected
      ? [date.format(new Date(selected.date)), sessionId === active ? 'Текущая сессия' : 'Архив', 'Записей: ' + selected.entries.length].join(' · ')
      : 'Создай сессию, чтобы записывать итоги и события боя.';
    const list = get('journal-list');
    list.replaceChildren(...(selected?.entries ?? []).slice().reverse().map(entry => {
      const article = document.createElement('article'), header = document.createElement('div'), body = document.createElement('p');
      article.className = 'journal-entry';
      article.dataset.entry = entry.id;
      const recorded = entry.kind === 'event' ? 'Событие боя' : 'Запись мастера';
      header.append(label(recorded + ' · ' + date.format(new Date(entry.date)), 'result-detail'));
      body.textContent = entry.body;
      if (entry.kind !== 'event') {
        const edit = button('', 'pen', () => { editJournal(entry); journalForm.elements.body.focus(); });
        const remove = button('', 'trash', async () => {
          if (confirm('Удалить запись из журнала?') &&
              (await dispatch('journal:remove', { sessionId, id: entry.id }))?.ok && editingEntry === entry.id) editJournal();
        });
        edit.setAttribute('aria-label', 'Редактировать запись');
        remove.setAttribute('aria-label', 'Удалить запись');
        header.append(edit, remove);
      }
      article.append(header, body);
      return article;
    }));
    if (reveal) {
      const entry = [...list.children].find(row => row.dataset.entry === reveal);
      entry?.classList.add('selected');
      entry?.scrollIntoView({ block: 'nearest' });
    }
  }
  function openJournal(id, entryId) {
    sessionId = id ?? getState().journal.active;
    editJournal();
    openDialog(journalDialog.id);
    renderJournal(entryId);
  }
  get('open-journal').onclick = () => openJournal();
  get('new-journal-session').onclick = () => {
    closeDialog(journalDialog);
    const context = getContext();
    askText('Новая сессия', 'Название сессии', '', async title => {
      await dispatch('journal:session', { title }, context);
      openJournal();
    }, 'Создать', 'Сессия ' + (getState().journal.sessions.length + 1));
  };
  sessionSelect.onchange = () => { sessionId = sessionSelect.value; editJournal(); renderJournal(); };
  get('journal-active').onclick = () => dispatch('journal:activate', { id: sessionId === getState().journal.active ? null : sessionId });
  get('cancel-journal-edit').onclick = () => editJournal();
  journalForm.onsubmit = async event => {
    event.preventDefault();
    if ((await dispatch('journal:save', { id: editingEntry, sessionId, body: journalForm.elements.body.value }, journalContext))?.ok) editJournal();
  };
  return {
    render(before) {
      const state = getState();
      if (!before || before.roundEvents !== state.roundEvents || before.activeBattleId !== state.activeBattleId || before.battleChoices !== state.battleChoices) renderRoundEvents();
      if (!before || before.journal !== state.journal) renderJournal();
    },
    remind(events) {
      if (!roundDialog.open) events.forEach(entry => pendingEvents.add(entry.id));
      renderRoundEvents();
    }
  };
}
