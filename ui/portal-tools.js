function createPortalTools({ getState, context, selectedToken, dispatch, openDialog, closeDialog, preview, assetURL, place, toast }) {
  const get = id => document.getElementById(id);
  const editor = get('map-portal-editor'), form = editor.querySelector('form');
  const travel = get('map-portal-travel'), party = get('portal-travel-tokens'), layer = get('map-portals');
  const previewHost = get('portal-map-preview'), previewMap = get('portal-exit-map');
  const previewImage = previewMap.querySelector('img');
  let draft, destination, renderKey = [], lastTerrain, portals = [];
  let previewGrid;

  function edit(portal) {
    const maps = getState().mapChoices.filter(map => map.id !== getState().activeMapId);
    if (!maps.length) return toast('Сначала создай карту назначения');
    draft = { portal, context: context(), previewRequest: 0 };
    form.elements.targetMapId.replaceChildren(...maps.map(map => new Option(map.title, map.id)));
    form.elements.targetMapId.value = portal?.targetMapId ?? maps[0].id;
    form.elements.name.value = portal?.name ?? '';
    form.elements.col.value = portal?.exit.col ?? 0;
    form.elements.row.value = portal?.exit.row ?? 0;
    previewHost.hidden = true;
    previewGrid = null;
    openDialog(editor.id);
  }

  function positionPreview() {
    if (!previewGrid || previewHost.hidden) return;
    const { grid, offsetX, offsetY } = previewGrid;
    const width = previewImage.naturalWidth || 1600, height = previewImage.naturalHeight || 1100;
    previewMap.style.aspectRatio = width + ' / ' + height;
    const field = get('portal-exit-grid'), mark = get('portal-exit-marker');
    const rect = previewMap.getBoundingClientRect();
    field.style.backgroundSize = `${grid / width * rect.width}px ${grid / height * rect.height}px`;
    field.style.backgroundPosition = `${offsetX / width * rect.width}px ${offsetY / height * rect.height}px`;
    const cell = { col: form.elements.col.valueAsNumber, row: form.elements.row.valueAsNumber };
    const point = MapGeometry.cellCenter(previewGrid, cell.col, cell.row);
    mark.hidden = !MapGeometry.validCell(cell) || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height;
    mark.style.left = point.x / width * 100 + '%';
    mark.style.top = point.y / height * 100 + '%';
  }
  previewImage.onload = positionPreview;
  previewImage.onerror = () => { previewImage.hidden = true; previewImage.removeAttribute('src'); positionPreview(); };
  new ResizeObserver(positionPreview).observe(previewMap);
  form.elements.col.oninput = form.elements.row.oninput = positionPreview;
  form.elements.targetMapId.onchange = () => {
    draft.previewRequest++;
    previewHost.hidden = true;
    previewGrid = null;
  };
  get('portal-pick-exit').onclick = async () => {
    const current = draft, mapId = form.elements.targetMapId.value;
    const request = ++current.previewRequest;
    const data = await preview({ mapId, expectedCampaignId: current.context.expectedCampaignId });
    if (!data?.ok || draft !== current || !editor.open || current.previewRequest !== request) return;
    previewGrid = data;
    previewImage.removeAttribute('src');
    const url = data.image ? assetURL(data.image) : data.demo ? 'assets/demo-map.svg' : null;
    previewImage.hidden = !url;
    if (url) previewImage.src = url;
    previewHost.hidden = false;
    positionPreview();
    previewMap.focus({ preventScroll: true });
  };
  previewMap.onclick = event => {
    if (!previewGrid || !event.detail) return;
    const bounds = previewMap.getBoundingClientRect();
    const { grid, offsetX, offsetY } = previewGrid;
    const x = (event.clientX - bounds.left) / bounds.width * (previewImage.naturalWidth || 1600);
    const y = (event.clientY - bounds.top) / bounds.height * (previewImage.naturalHeight || 1100);
    form.elements.col.value = Math.max(0, Math.min(2000, Math.floor((x - offsetX) / grid)));
    form.elements.row.value = Math.max(0, Math.min(2000, Math.floor((y - offsetY) / grid)));
    positionPreview();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    const { name, targetMapId, col, row } = form.elements;
    const data = { name: name.value.trim(), targetMapId: targetMapId.value, exit: { col: col.valueAsNumber, row: row.valueAsNumber } };
    if (!data.name) return;
    if (draft.portal) {
      if (!(await dispatch('terrain:edit-portal', { ...data, id: draft.portal.id }, draft.context))?.ok) return;
      closeDialog(editor);
    } else {
      closeDialog(editor);
      place({ ...data, kind: 'portal', context: draft.context });
    }
  };

  function open(portal) {
    const state = getState(), target = state.mapChoices.find(map => map.id === portal.targetMapId);
    if (!target) return toast('Карта назначения недоступна');
    destination = { id: portal.id, context: context() };
    get('portal-travel-title').textContent = portal.name + ' → ' + target.title;
    const actors = new Map(state.mapCombatants.map(actor => [actor.id, actor]));
    party.replaceChildren(...state.tokens.flatMap(({ combatantId }) => {
      const actor = actors.get(combatantId);
      if (!actor) return [];
      const label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox';
      box.name = 'actor';
      box.value = combatantId;
      box.dataset.allied = String(actor.role === 'player' || actor.role === 'ally');
      box.checked = combatantId === selectedToken();
      label.append(box, actor.name);
      return [label];
    }));
    get('portal-select-party').disabled = !party.querySelector('[data-allied=true]');
    get('portal-clear-party').disabled = !party.children.length;
    openDialog(travel.id);
  }
  get('portal-select-party').onclick = () => {
    for (const box of party.querySelectorAll('input')) box.checked = box.dataset.allied === 'true';
  };
  get('portal-clear-party').onclick = () => {
    for (const box of party.querySelectorAll('input')) box.checked = false;
  };
  travel.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    const form = event.currentTarget, button = form.querySelector('button[type=submit]');
    const ids = new FormData(form).getAll('actor'), current = destination;
    button.disabled = true;
    try {
      if ((await dispatch('terrain:travel', { id: current.id, ids }, current.context))?.ok && travel.open && destination === current) closeDialog(travel);
    } finally { button.disabled = false; }
  };

  function render(zoom, editing) {
    const { terrain } = getState();
    if (lastTerrain !== terrain) {
      lastTerrain = terrain;
      portals = terrain.filter(item => item.kind === 'portal');
    }
    const key = [zoom, editing, ...portals];
    if (key.length === renderKey.length && key.every((value, index) => value === renderKey[index])) return;
    renderKey = key;
    layer.replaceChildren(...portals.map(portal => {
      const marker = document.createElement(editing ? 'span' : 'button');
      marker.dataset.portalId = portal.id;
      marker.dataset.pixelIcon = 'door';
      marker.style.left = portal.a.x * zoom + 'px';
      marker.style.top = portal.a.y * zoom + 'px';
      if (!editing) {
        marker.type = 'button';
        marker.title = portal.name;
        marker.setAttribute('aria-label', portal.name);
        marker.onclick = () => open(portal);
        marker.oncontextmenu = event => { event.preventDefault(); edit(portal); };
      }
      return marker;
    }));
  }
  return { edit, render };
}
