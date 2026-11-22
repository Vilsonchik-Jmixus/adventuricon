function createSessionTools({ getState, getCampaigns, dispatch, campaign, openDialog, closeDialog, askText, showNote }) {
  const get = id => document.getElementById(id);
  const campaignDialog = get('campaign-dialog'), scenesDialog = get('session-scenes');
  const campaignSelect = get('campaign-select'), campaignStatus = get('campaign-status');
  const scenes = get('session-scene-list'), sceneEditor = get('session-scene-edit'), form = get('session-scene-form');
  let editingScene;

  function renderCampaigns() {
    const { profiles, active } = getCampaigns();
    if (!profiles) return;
    campaignSelect.replaceChildren(...profiles.map(profile => new Option(profile.name, profile.id)));
    campaignSelect.value = active;
    get('open-campaigns').title = profiles.find(profile => profile.id === active)?.name ?? 'Кампании';
  }
  async function changeCampaign(action, extra = {}) {
    const buttons = [...campaignDialog.querySelectorAll('button:not([data-close-dialog]), select')];
    buttons.forEach(button => { button.disabled = true; });
    campaignStatus.hidden = false;
    campaignStatus.textContent = action === 'export' ? 'Подготовка архива…' : action === 'import' ? 'Импорт кампании…' : 'Сохранение…';
    try {
      const response = await campaign({ action, ...extra });
      campaignStatus.textContent = response?.error ?? (response?.ok ? (action === 'export' ? 'Архив сохранён' : 'Готово') : '');
    } catch (error) {
      campaignStatus.textContent = error.message;
    } finally {
      buttons.forEach(button => { button.disabled = false; });
      campaignStatus.hidden = !campaignStatus.textContent;
      renderCampaigns();
    }
  }
  get('open-campaigns').onclick = () => { renderCampaigns(); openDialog(campaignDialog.id); };
  campaignSelect.onchange = () => changeCampaign('select', { id: campaignSelect.value });
  for (const action of ['create', 'rename']) get('campaign-' + action).onclick = () => {
    const { profiles, active } = getCampaigns();
    closeDialog(campaignDialog);
    askText(action === 'create' ? 'Создать кампанию' : 'Переименовать кампанию', 'Название', '', async name => {
      openDialog(campaignDialog.id);
      await changeCampaign(action, { id: active, name });
    }, 'Сохранить', action === 'rename' ? profiles.find(profile => profile.id === active)?.name : '');
  };
  for (const action of ['export', 'import']) get('campaign-' + action).onclick = () => changeCampaign(action);

  function editScene(entry) {
    const state = getState();
    editingScene = entry?.id;
    form.elements.title.value = entry?.title ?? '';
    const fields = [
      ['mapId', state.mapChoices, 'Текущая карта', state.activeMapId],
      ['battleId', state.battleChoices, 'Текущий бой', state.activeBattleId],
      ['trackId', state.music.tracks, 'Без музыки', state.music.current],
      ['noteId', state.story.notes, 'Без заметки', ''],
    ];
    for (const [key, options, empty, current] of fields) {
      const select = form.elements[key];
      select.replaceChildren(new Option(empty, ''), ...options.map(item => new Option(item.title, item.id)));
      select.value = (entry ? entry[key] : current) ?? '';
    }
    get('delete-session-scene').hidden = !entry;
    closeDialog(scenesDialog);
    openDialog(sceneEditor.id);
  }
  function renderScenes() {
    const state = getState();
    scenes.replaceChildren(...state.scenes.map(entry => {
      const row = document.createElement('div');
      row.className = 'session-scene';
      const title = document.createElement('button'), edit = document.createElement('button');
      title.type = edit.type = 'button';
      title.textContent = entry.title;
      title.title = 'Открыть сцену';
      title.onclick = async () => {
        if (!(await dispatch('scene:open', { id: entry.id }))?.ok) return;
        closeDialog(scenesDialog);
        if (entry.noteId) showNote(entry.noteId);
      };
      edit.textContent = '✎';
      edit.setAttribute('aria-label', 'Изменить сцену ' + entry.title);
      edit.onclick = () => editScene(entry);
      row.append(title, edit);
      return row;
    }));
  }
  get('open-session-scenes').onclick = () => { renderScenes(); openDialog(scenesDialog.id); };
  get('new-session-scene').onclick = () => editScene();
  form.onsubmit = async event => {
    event.preventDefault();
    if (!(await dispatch('scene:save', { ...Object.fromEntries(new FormData(form)), id: editingScene }))?.ok) return;
    closeDialog(sceneEditor);
    renderScenes();
    openDialog(scenesDialog.id);
  };
  get('delete-session-scene').onclick = async () => {
    if (!confirm('Удалить эту сцену?') || !(await dispatch('scene:remove', { id: editingScene }))?.ok) return;
    closeDialog(sceneEditor);
    renderScenes();
    openDialog(scenesDialog.id);
  };
  return { render() {
    if (campaignDialog.open) renderCampaigns();
    if (scenesDialog.open) renderScenes();
  } };
}
