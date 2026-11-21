function createMapTerrain({ getState, getLayout, getPoint, dispatch, redraw, expand, isExpanded, readOnly, editItem, assetURL }) {
  const get = id => document.getElementById(id);
  const view = get('map-viewport'), toolbar = get('terrain-toolbar');
  const overlay = get('terrain-preview'), fogLayer = get('map-fog');
  const tools = toolbar.querySelectorAll('[data-terrain-tool]');
  let editing = false, tool = 'select', selected = null, draft = null, acceptedMap;
  let lightsKey = '', fogKey = '', visible = new Set();
  const labels = {
    select: 'Выбери объект щелчком',
    wall: 'Проведи стену между двумя точками · Shift без привязки',
    door: 'Проведи дверь в проёме · Shift без привязки',
    light: 'Потяни от источника, чтобы задать радиус',
  };

  function prepareCanvas(canvas, width, height) {
    const scale = Math.min(1, 1800 / Math.max(width, height));
    const w = Math.max(1, Math.ceil(width * scale)), h = Math.max(1, Math.ceil(height * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(w / width, 0, 0, h / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  function renderLights(terrain, walls, zoom) {
    const layer = get('map-lights');
    layer.style.setProperty('--terrain-zoom', zoom);
    const key = JSON.stringify(terrain);
    if (key === lightsKey) return;
    lightsKey = key;
    layer.replaceChildren(...terrain.filter(item => item.kind === 'light').map(({ a, radius }) => {
      const light = document.createElement('span');
      light.className = 'scene-light';
      light.style.setProperty('--light-left', (a.x - radius) + 'px');
      light.style.setProperty('--light-top', (a.y - radius) + 'px');
      light.style.setProperty('--light-size', (radius * 2) + 'px');
      const points = MapGeometry.lightPolygon(a, radius, walls).map(point =>
        `${(50 + (point.x - a.x) / radius * 50).toFixed(2)}% ${(50 + (point.y - a.y) / radius * 50).toFixed(2)}%`);
      light.style.clipPath = `polygon(${points.join(',')})`;
      return light;
    }));
  }

  function renderEditor(terrain = getState().terrain) {
    overlay.hidden = !editing;
    if (!editing || !getLayout()) return;
    const { width, height, zoom } = getLayout();
    const ctx = prepareCanvas(overlay, width / zoom, height / zoom);
    const unit = Math.max(1, Math.min(width / zoom, height / zoom) / 550);
    for (const item of draft ? [...terrain, draft] : terrain) {
      const accent = item === draft || item.id === selected;
      ctx.strokeStyle = accent ? '#fff0b8' : item.kind === 'wall' ? '#e99c75' : item.open ? '#add19a' : '#ffd18e';
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = unit * (accent ? 3 : 2);
      ctx.setLineDash(item.kind === 'door' && item.open ? [unit * 5, unit * 4] : []);
      ctx.beginPath();
      if (item.kind === 'item') ctx.arc(item.a.x, item.a.y, unit * 5, 0, Math.PI * 2);
      else if (item.kind === 'light') ctx.arc(item.a.x, item.a.y, Math.max(1, item.radius), 0, Math.PI * 2);
      else { ctx.moveTo(item.a.x, item.a.y); ctx.lineTo(item.b.x, item.b.y); }
      ctx.stroke();
      for (const end of [item.a, item.b].filter(Boolean)) {
        ctx.fillRect(end.x - 2 * unit, end.y - 2 * unit, 4 * unit, 4 * unit);
      }
    }
  }

  function renderFog(state, walls, preview, width, height) {
    fogLayer.hidden = !readOnly || !state.fog.enabled;
    if (fogLayer.hidden) { fogKey = ''; visible = new Set(); return; }
    const origins = state.tokens.filter(token => state.visionOrigins.includes(token.combatantId)).map(token =>
      token.combatantId === preview?.id ? preview : token);
    const { grid, offsetX, offsetY } = state.map;
    const key = JSON.stringify([state.activeMapId, grid, offsetX, offsetY, state.fog.explored, walls, origins, width, height]);
    if (fogKey === key) return;
    fogKey = key;
    visible = MapGeometry.visibleCells(state.map, origins, walls);
    const ctx = prepareCanvas(fogLayer, width, height);
    ctx.fillStyle = '#100d0d';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#ffffff55';
    ctx.beginPath();
    for (const cell of state.fog.explored) {
      const [col, row] = cell.split(',').map(Number);
      ctx.rect(col * grid + offsetX, row * grid + offsetY, grid, grid);
    }
    ctx.fill();
    ctx.fillStyle = '#fff';
    for (const { col, row } of origins) {
      const outline = MapGeometry.lightPolygon(MapGeometry.cellCenter(state.map, col, row), grid * 12, walls);
      ctx.beginPath();
      for (const { x, y } of outline) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function syncEditor(terrain) {
    const item = terrain.find(object => object.id === selected);
    toolbar.hidden = !editing;
    view.classList.toggle('terrain-editing', editing);
    get('edit-terrain').setAttribute('aria-pressed', String(editing));
    get('terrain-hint').textContent = labels[tool];
    get('terrain-remove').hidden = !item;
    get('edit-map-item').hidden = item?.kind !== 'item';
    get('terrain-door').hidden = item?.kind !== 'door';
    get('terrain-door').textContent = item?.open ? 'Закрыть дверь' : 'Открыть дверь';
    tools.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.terrainTool === tool)));
  }

  function render(state, layout, preview) {
    const terrain = state.terrain, walls = MapGeometry.blockingWalls(terrain.filter(item => item.kind !== 'light'));
    if (acceptedMap !== state.activeMapId) { acceptedMap = state.activeMapId; selected = draft = null; }
    if (editing && !isExpanded()) { editing = false; selected = draft = null; }
    get('edit-terrain').hidden = readOnly;
    get('toggle-fog').hidden = readOnly;
    get('toggle-fog').setAttribute('aria-pressed', String(state.fog.enabled));
    get('toggle-fog').title = state.fog.enabled ? 'Рассеять туман · F на карте' : 'Наложить туман · F на карте';
    get('fog-reset').disabled = !state.fog.explored.length;
    syncEditor(terrain);
    renderLights(terrain, walls, layout.zoom);
    renderEditor(terrain);
    renderFog(state, walls, preview, layout.width / layout.zoom, layout.height / layout.zoom);
    get('map-items').replaceChildren(...terrain.filter(item => {
      if (item.kind !== 'item') return false;
      const { grid, offsetX, offsetY } = state.map;
      const col = Math.floor((item.a.x - offsetX) / grid), row = Math.floor((item.a.y - offsetY) / grid);
      return fogLayer.hidden || visible.has(`${col},${row}`);
    }).map(item => {
      const marker = document.createElement('div'), icon = document.createElement('span'), name = document.createElement('span');
      marker.className = 'scene-item';
      marker.style.left = item.a.x * layout.zoom + 'px';
      marker.style.top = item.a.y * layout.zoom + 'px';
      icon.className = 'scene-item-icon';
      name.className = 'scene-item-name';
      name.textContent = item.name;
      if (item.image) {
        const image = document.createElement('img');
        image.src = assetURL(item.image);
        image.alt = '';
        icon.append(image);
      } else icon.textContent = '◆';
      marker.append(icon, name);
      return marker;
    }));

    const layer = get('map-doors');
    const focusedDoor = document.activeElement?.dataset.doorId;
    const doors = readOnly || editing ? [] : terrain.filter(item => item.kind === 'door');
    layer.replaceChildren(...doors.map(door => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.doorId = door.id;
      button.title = door.open ? 'Закрыть дверь' : 'Открыть дверь';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(door.open));
      button.textContent = door.open ? '◇' : '◆';
      button.style.left = (door.a.x + door.b.x) / 2 * layout.zoom + 'px';
      button.style.top = (door.a.y + door.b.y) / 2 * layout.zoom + 'px';
      return button;
    }));
    if (focusedDoor) [...layer.children].find(button => button.dataset.doorId === focusedDoor)?.focus({ preventScroll: true });
  }

  function setEditing(value) {
    editing = value;
    tool = 'select';
    selected = draft = null;
    redraw();
  }

  function snap(point, free) {
    const { grid, offsetX, offsetY } = getState().map;
    const { zoom, width, height } = getLayout();
    return {
      x: Math.max(0, Math.min(width / zoom, free ? point.x : Math.round((point.x - offsetX) / grid) * grid + offsetX)),
      y: Math.max(0, Math.min(height / zoom, free ? point.y : Math.round((point.y - offsetY) / grid) * grid + offsetY)),
    };
  }

  function pointerDown(event, context) {
    if (!editing || event.button !== 0) return false;
    event.preventDefault();
    view.focus({ preventScroll: true });
    const point = getPoint(event), state = getState();
    if (tool === 'select') {
      const threshold = Math.max(5, Math.min(22, state.map.grid / 4));
      const nearest = state.terrain.map(item => {
        const distance = MapGeometry.distanceToSegment(point, item.a, item.b ?? item.a);
        return { id: item.id, distance };
      }).filter(item => item.distance <= threshold).sort((a, b) => a.distance - b.distance)[0];
      selected = nearest?.id ?? null;
      syncEditor(state.terrain);
      renderEditor();
      return true;
    }
    const kind = tool, free = event.shiftKey || kind === 'light';
    const start = snap(point, free);
    const make = end => kind === 'light'
      ? { kind, a: start, radius: Math.hypot(end.x - start.x, end.y - start.y) }
      : { kind, a: start, b: end };
    draft = make(start);
    const controller = new AbortController(), options = { signal: controller.signal };
    const move = e => {
      if (!editing || getState().activeMapId !== context.expectedMapId) return cancel();
      draft = make(snap(getPoint(e), free));
      renderEditor();
    };
    const cancel = () => {
      controller.abort();
      draft = null;
      renderEditor();
    };
    view.setPointerCapture(event.pointerId);
    view.addEventListener('pointermove', move, options);
    view.addEventListener('pointercancel', cancel, options);
    view.addEventListener('lostpointercapture', cancel, options);
    view.addEventListener('pointerup', e => {
      if (!editing || getState().activeMapId !== context.expectedMapId) return cancel();
      const item = make(snap(getPoint(e), free));
      cancel();
      if (kind === 'light') {
        if (item.radius < 8) item.radius = state.map.grid * 3;
      } else if (Math.hypot(item.a.x - item.b.x, item.a.y - item.b.y) < 2) return;
      dispatch('terrain:add', item, context);
    }, options);
    return true;
  }

  const toggleFog = () => dispatch('fog:enabled', { enabled: !getState().fog.enabled });
  get('toggle-fog').onclick = toggleFog;
  get('edit-terrain').onclick = async () => {
    if (readOnly) return;
    if (!isExpanded()) await expand();
    setEditing(!editing);
  };
  get('close-terrain').onclick = () => setEditing(false);
  get('terrain-door').onclick = () => dispatch('terrain:door', { id: selected });
  get('map-doors').addEventListener('click', e => {
    const id = e.target.closest('[data-door-id]')?.dataset.doorId;
    if (id && !readOnly) dispatch('terrain:door', { id });
  });
  get('terrain-remove').onclick = () => dispatch('terrain:remove', { id: selected });
  get('create-map-item').onclick = () => editItem();
  get('edit-map-item').onclick = () => editItem(getState().terrain.find(item => item.id === selected));
  get('fog-reset').onclick = () => {
    if (confirm('Сбросить открытые области на этой карте?')) dispatch('fog:reset');
  };
  tools.forEach(button => {
    button.onclick = () => { tool = button.dataset.terrainTool; selected = null; syncEditor(getState().terrain); renderEditor(); };
  });

  return { render, pointerDown, toggleFog, hideEditor: () => editing && (setEditing(false), true),
    isEditing: () => editing, tokenVisible: token => fogLayer.hidden || visible.has(`${token.col},${token.row}`) };
}
