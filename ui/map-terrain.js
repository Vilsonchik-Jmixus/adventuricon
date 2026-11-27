function createMapTerrain({ getState, getLayout, getPoint, dispatch, redraw, expand, isExpanded, readOnly, editItem, editPortal, assetURL }) {
  const get = id => document.getElementById(id);
  const view = get('map-viewport'), toolbar = get('terrain-toolbar');
  const overlay = get('terrain-preview'), fogLayer = get('map-fog');
  const exploredLayer = document.createElement('canvas');
  const ink = get('map-drawings'), strokes = get('map-strokes'), previewStroke = get('map-draft-stroke');
  const tools = toolbar.querySelectorAll('[data-terrain-tool]');
  let editing = false, tool = 'select', selected = null, draft = null, acceptedMap, acceptedCampaign;
  let fogKey, exploredKey = '', exploredCells, visible = new Set(), cancelDrawing;
  let lastDrawings, lastTerrain, lastLightGrid, lastLightWalls, lastLights = [], inkViewBox;
  let wallTerrain, walls, itemsKey = [], doorsKey = [], lastActors, visionActors;
  let sightCache = new Map(), sightCacheWalls, sightCacheMap;
  const terrainColors = { wall: '#e99c75', window: '#8ed0ea' };
  const labels = {
    select: 'Выбери объект щелчком',
    wall: 'Проведи стену между двумя точками · Shift без привязки',
    door: 'Проведи дверь в проёме · Shift без привязки',
    window: 'Проведи окно в проёме · обзор в пределах одной клетки',
    light: 'Потяни от источника, чтобы задать радиус',
    pen: 'Веди мышью по карте, чтобы рисовать',
    eraser: 'Щёлкни по линии или по центру источника света',
  };

  function penPath(points) {
    const line = points.map(({ x, y }) => `${x} ${y}`).join(' L ');
    return `M ${line}${points.length === 1 ? ' h .1' : ''}`;
  }

  function renderDrawings(drawings, layout) {
    const viewBox = `0 0 ${layout.width / layout.zoom} ${layout.height / layout.zoom}`;
    if (inkViewBox !== viewBox) {
      inkViewBox = viewBox;
      ink.setAttribute('viewBox', viewBox);
    }
    if (lastDrawings === drawings) return;
    lastDrawings = drawings;
    const svg = 'http://www.w3.org/2000/svg';
    const previous = new Map([...strokes.children].map(node => [node.dataset.stroke, node]));
    let cursor = strokes.firstElementChild;
    for (const stroke of drawings) {
      const kept = previous.get(stroke.id);
      if (kept) {
        previous.delete(stroke.id);
        if (kept === cursor) cursor = cursor.nextElementSibling;
        else strokes.insertBefore(kept, cursor);
        continue;
      }
      const group = document.createElementNS(svg, 'g');
      group.dataset.stroke = stroke.id;
      const line = document.createElementNS(svg, 'path');
      line.setAttribute('d', penPath(stroke.points));
      line.setAttribute('stroke', stroke.color);
      line.setAttribute('stroke-width', stroke.width);
      group.append(line);
      if (!readOnly) {
        const hit = line.cloneNode();
        hit.setAttribute('class', 'map-stroke-hit');
        hit.setAttribute('stroke', 'transparent');
        hit.setAttribute('stroke-width', Math.max(stroke.width, 14));
        hit.dataset.mapStroke = stroke.id;
        group.append(hit);
      }
      strokes.insertBefore(group, cursor);
    }
    for (const node of previous.values()) node.remove();
  }

  function prepareCanvas(canvas, width, height) {
    const scale = Math.min(1, 1800 / Math.max(width, height));
    const w = Math.max(1, Math.ceil(width * scale)), h = Math.max(1, Math.ceil(height * scale));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(w / width, 0, 0, h / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
  }

  function renderLights(terrain, walls, zoom, grid) {
    const layer = get('map-lights');
    if (layer.style.getPropertyValue('--terrain-zoom') !== String(zoom)) layer.style.setProperty('--terrain-zoom', zoom);
    if (lastTerrain === terrain && lastLightGrid === grid) return;
    const gridChanged = lastLightGrid !== grid;
    lastTerrain = terrain;
    lastLightGrid = grid;
    const lights = terrain.filter(item => item.kind === 'light');
    const unchanged = lastLightWalls === walls && lastLights.length === lights.length && lastLights.every((light, index) =>
      light === lights[index] || light.radius === lights[index].radius && light.a.x === lights[index].a.x && light.a.y === lights[index].a.y);
    if (unchanged && (walls.length === 0 || !gridChanged)) return;
    lastLightWalls = walls;
    lastLights = lights;
    layer.replaceChildren(...lights.map(({ a, radius }) => {
      const light = document.createElement('span');
      light.className = 'scene-light';
      light.style.setProperty('--light-left', (a.x - radius) + 'px');
      light.style.setProperty('--light-top', (a.y - radius) + 'px');
      light.style.setProperty('--light-size', (radius * 2) + 'px');
      const points = MapGeometry.lightPolygon(a, radius, walls, grid).map(point =>
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
      ctx.strokeStyle = accent ? '#fff0b8' : terrainColors[item.kind] ?? (item.open ? '#add19a' : '#ffd18e');
      ctx.fillStyle = ctx.strokeStyle;
      ctx.lineWidth = unit * (accent ? 3 : 2);
      ctx.setLineDash(item.kind === 'window' || item.kind === 'door' && item.open ? [unit * 5, unit * 4] : []);
      ctx.beginPath();
      if (item.kind === 'item' || item.kind === 'portal') ctx.arc(item.a.x, item.a.y, unit * 5, 0, Math.PI * 2);
      else if (item.kind === 'light') ctx.arc(item.a.x, item.a.y, Math.max(1, item.radius), 0, Math.PI * 2);
      else { ctx.moveTo(item.a.x, item.a.y); ctx.lineTo(item.b.x, item.b.y); }
      ctx.stroke();
      for (const end of [item.a, item.b].filter(Boolean)) {
        ctx.fillRect(end.x - 2 * unit, end.y - 2 * unit, 4 * unit, 4 * unit);
      }
    }
  }

  function renderExploredFog(state, width, height) {
    const { grid, offsetX, offsetY } = state.map;
    const key = JSON.stringify([state.activeMapId, grid, offsetX, offsetY, width, height]);
    if (exploredKey === key && exploredCells === state.fog.explored) return;
    exploredKey = key;
    exploredCells = state.fog.explored;
    fogKey = null;
    const ctx = prepareCanvas(exploredLayer, width, height);
    ctx.fillStyle = '#100d0d';
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#ffffff55';
    ctx.beginPath();
    for (const cell of exploredCells) {
      const [col, row] = cell.split(',').map(Number);
      ctx.rect(col * grid + offsetX, row * grid + offsetY, grid, grid);
    }
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  function renderFog(state, walls, preview, width, height) {
    fogLayer.hidden = !state.fog.enabled;
    if (fogLayer.hidden) { fogKey = null; visible.clear(); return; }
    const visionIds = new Set(state.visionOrigins);
    if (lastActors !== state.mapCombatants) {
      lastActors = state.mapCombatants;
      visionActors = new Map(lastActors.map(actor => [actor.id, actor]));
    }
    const origins = state.tokens.filter(token => visionIds.has(token.combatantId)).map(token => {
      const id = token.combatantId, actor = visionActors.get(id);
      const { col, row } = id === preview?.id ? preview : token;
      return { id, col, row, size: TokenStyle.size(actor?.tokenSize), range: TokenStyle.vision(token.visionFeet ?? actor?.visionFeet) / 5 };
    });
    const { grid, offsetX, offsetY } = state.map;
    const geometry = `${state.activeMapId}:${grid}:${offsetX}:${offsetY}`;
    if (sightCacheWalls !== walls || sightCacheMap !== geometry) {
      sightCache = new Map();
      sightCacheWalls = walls;
      sightCacheMap = geometry;
    }
    renderExploredFog(state, width, height);
    const sameOrigin = (a, b) => a?.id === b.id && a.col === b.col && a.row === b.row && a.size === b.size && a.range === b.range;
    if (fogKey?.walls === walls && fogKey.geometry === geometry && fogKey.origins.length === origins.length &&
        fogKey.origins.every((origin, index) => sameOrigin(origin, origins[index]))) return;
    fogKey = { walls, origins, geometry };
    const updatedSight = new Map();
    visible = new Set();
    const ctx = prepareCanvas(fogLayer, width, height);
    ctx.drawImage(exploredLayer, 0, 0, width, height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#fff';
    for (const token of origins) {
      const cached = sightCache.get(token.id);
      const sight = sameOrigin(cached?.token, token) ? cached : {
        token, cells: MapGeometry.visibleCells(state.map, [token], walls),
        outline: MapGeometry.lightPolygon(MapGeometry.tokenCenter(state.map, token), grid * token.range, walls, grid)
      };
      updatedSight.set(token.id, sight);
      for (const cell of sight.cells) visible.add(cell);
      ctx.beginPath();
      for (const { x, y } of sight.outline) ctx.lineTo(x, y);
      ctx.closePath();
      ctx.fill();
    }
    sightCache = updatedSight;
    ctx.globalCompositeOperation = 'source-over';
  }

  function syncEditor(terrain) {
    const item = terrain.find(object => object.id === selected);
    toolbar.hidden = !editing;
    view.classList.toggle('terrain-editing', editing);
    view.classList.toggle('erasing-map', editing && tool === 'eraser');
    get('map-pen-options').hidden = !editing || tool !== 'pen';
    get('map-eraser-kind').hidden = !editing || tool !== 'eraser';
    get('edit-terrain').setAttribute('aria-pressed', String(editing));
    get('terrain-hint').textContent = labels[tool];
    get('terrain-remove').hidden = !item;
    get('edit-map-item').hidden = item?.kind !== 'item';
    get('edit-map-portal').hidden = item?.kind !== 'portal';
    get('terrain-door').hidden = item?.kind !== 'door';
    get('terrain-door').textContent = item?.open ? 'Закрыть дверь' : 'Открыть дверь';
    tools.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.terrainTool === tool)));
  }

  function render(state, layout, preview, campaign) {
    const terrain = state.terrain;
    const walls = wallsFor(terrain);
    if (acceptedMap !== state.activeMapId || acceptedCampaign !== campaign) {
      cancelDrawing?.();
      acceptedMap = state.activeMapId;
      acceptedCampaign = campaign;
      lastDrawings = null;
      strokes.replaceChildren();
      itemsKey = [];
      selected = draft = null;
    }
    if (editing && !isExpanded()) {
      cancelDrawing?.();
      editing = false;
      selected = draft = null;
    }
    get('edit-terrain').hidden = readOnly;
    get('toggle-fog').hidden = readOnly;
    get('fog-reset').hidden = readOnly;
    get('toggle-fog').setAttribute('aria-pressed', String(state.fog.enabled));
    get('toggle-fog').title = state.fog.enabled ? 'Рассеять туман · F на карте' : 'Наложить туман · F на карте';
    get('fog-reset').disabled = !state.fog.explored.length;
    syncEditor(terrain);
    renderLights(terrain, walls, layout.zoom, state.map.grid);
    renderDrawings(state.drawings, layout);
    renderEditor(terrain);
    renderFog(state, walls, preview, layout.width / layout.zoom, layout.height / layout.zoom);
    renderItems(state, layout);
    renderDoors(terrain, layout);
  }

  function renderItems(state, layout) {
    const visibility = readOnly && !fogLayer.hidden ? visible : null;
    const { terrain } = state;
    const { grid, offsetX, offsetY } = state.map;
    const items = terrain.filter(item => {
      if (item.kind !== 'item') return false;
      const col = Math.floor((item.a.x - offsetX) / grid), row = Math.floor((item.a.y - offsetY) / grid);
      return !visibility || visibility.has(`${col},${row}`);
    });
    const key = [layout.zoom, ...items];
    if (key.length === itemsKey.length && key.every((value, index) => value === itemsKey[index])) return;
    itemsKey = key;
    get('map-items').replaceChildren(...items.map(item => {
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
      } else icon.dataset.pixelIcon = 'bag';
      marker.append(icon, name);
      return marker;
    }));
  }

  function renderDoors(terrain, layout) {
    const layer = get('map-doors');
    const focusedDoor = document.activeElement?.dataset.doorId;
    const doors = readOnly || editing ? [] : terrain.filter(item => item.kind === 'door');
    const key = [layout.zoom, ...doors];
    if (key.length === doorsKey.length && key.every((value, index) => value === doorsKey[index])) return;
    doorsKey = key;
    layer.replaceChildren(...doors.map(door => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.doorId = door.id;
      button.title = door.open ? 'Закрыть дверь' : 'Открыть дверь';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(door.open));
      button.dataset.pixelIcon = door.open ? 'check' : 'door';
      button.style.left = (door.a.x + door.b.x) / 2 * layout.zoom + 'px';
      button.style.top = (door.a.y + door.b.y) / 2 * layout.zoom + 'px';
      return button;
    }));
    if (focusedDoor) [...layer.children].find(button => button.dataset.doorId === focusedDoor)?.focus({ preventScroll: true });
  }

  function setEditing(value) {
    cancelDrawing?.();
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

  function nearestTerrain(terrain, point, threshold) {
    let nearest, distance = threshold;
    for (const item of terrain) {
      const current = MapGeometry.distanceToSegment(point, item.a, item.b ?? item.a);
      if (current <= distance) { nearest = item; distance = current; }
    }
    return nearest;
  }

  function pointerDown(event, context) {
    if (!editing || event.button !== 0) return false;
    event.preventDefault();
    view.focus({ preventScroll: true });
    const point = getPoint(event), state = getState();
    const threshold = Math.max(5, Math.min(22, state.map.grid / 4));
    if (tool === 'eraser') {
      const kind = get('map-eraser-kind').value;
      if (kind === 'all' || kind === 'stroke') {
        const id = event.target.closest('[data-map-stroke]')?.dataset.mapStroke;
        if (id) {
          dispatch('map:erase', { id }, context);
          return true;
        }
      }
      const candidates = state.terrain.filter(item => kind === 'all' ? item.kind !== 'item' : item.kind === kind);
      const target = nearestTerrain(candidates, point, threshold);
      if (target) dispatch('terrain:remove', { id: target.id }, context);
      return true;
    }
    if (tool === 'pen') {
      if (cancelDrawing) return true;
      const start = snap(point, true);
      if (point.x !== start.x || point.y !== start.y) return true;
      const points = [start], color = get('map-pen-color').value, width = Number(get('map-pen-width').value);
      const controller = new AbortController(), options = { signal: controller.signal };
      const pointer = event.pointerId;
      cancelDrawing = () => {
        controller.abort();
        previewStroke.removeAttribute('d');
        if (view.hasPointerCapture(pointer)) view.releasePointerCapture(pointer);
        cancelDrawing = null;
      };
      previewStroke.setAttribute('stroke', color);
      previewStroke.setAttribute('stroke-width', width);
      previewStroke.setAttribute('d', penPath(points));
      view.setPointerCapture(pointer);
      const collect = e => {
        const end = snap(getPoint(e), true);
        const last = points.at(-1);
        if (points.length < 2000 && Math.hypot(end.x - last.x, end.y - last.y) >= 1) points.push(end);
        previewStroke.setAttribute('d', penPath(points));
      };
      view.addEventListener('pointermove', e => { if (e.pointerId === pointer) collect(e); }, options);
      view.addEventListener('pointercancel', e => { if (e.pointerId === pointer) cancelDrawing(); }, options);
      view.addEventListener('lostpointercapture', e => { if (e.pointerId === pointer) cancelDrawing(); }, options);
      view.addEventListener('pointerup', e => {
        if (e.pointerId !== pointer) return;
        collect(e);
        cancelDrawing();
        dispatch('map:draw', { points, color, width }, context);
      }, options);
      return true;
    }
    if (tool === 'select') {
      const nearest = nearestTerrain(state.terrain, point, threshold);
      selected = nearest?.id ?? null;
      syncEditor(state.terrain);
      renderEditor();
      return true;
    }
    if (cancelDrawing) return true;
    const kind = tool, free = event.shiftKey || kind === 'light';
    const start = snap(point, free);
    const make = end => kind === 'light'
      ? { kind, a: start, radius: Math.hypot(end.x - start.x, end.y - start.y) }
      : { kind, a: start, b: end };
    draft = make(start);
    const pointer = event.pointerId;
    const controller = new AbortController(), options = { signal: controller.signal };
    const move = e => {
      if (e.pointerId !== pointer) return;
      if (!editing || getState().activeMapId !== context.expectedMapId) return cancel();
      draft = make(snap(getPoint(e), free));
      renderEditor();
    };
    const cancel = cancelDrawing = () => {
      controller.abort();
      draft = null;
      if (view.hasPointerCapture(pointer)) view.releasePointerCapture(pointer);
      cancelDrawing = null;
      renderEditor();
    };
    view.setPointerCapture(pointer);
    view.addEventListener('pointermove', move, options);
    view.addEventListener('pointercancel', e => { if (e.pointerId === pointer) cancel(); }, options);
    view.addEventListener('lostpointercapture', e => { if (e.pointerId === pointer) cancel(); }, options);
    view.addEventListener('pointerup', e => {
      if (e.pointerId !== pointer) return;
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
  get('create-map-portal').onclick = () => editPortal?.();
  get('edit-map-portal').onclick = () => editPortal?.(getState().terrain.find(item => item.id === selected));
  get('fog-reset').onclick = () => {
    const expectedMapId = getState().activeMapId;
    if (confirm('Скрыть исследованные области этой карты? Текущий обзор жетонов сохранится.')) {
      dispatch('fog:reset', {}, { expectedMapId });
    }
  };
  tools.forEach(button => {
    button.onclick = () => {
      cancelDrawing?.();
      tool = button.dataset.terrainTool;
      selected = null;
      syncEditor(getState().terrain);
      renderEditor();
    };
  });

  function wallsFor(terrain) {
    if (wallTerrain !== terrain) {
      wallTerrain = terrain;
      const next = MapGeometry.blockingWalls(terrain);
      if (!MapGeometry.sameWalls(walls, next)) walls = next;
    }
    return walls;
  }
  function previewFog(state, layout, preview) {
    renderFog(state, wallsFor(state.terrain), preview, layout.width / layout.zoom, layout.height / layout.zoom);
    if (readOnly) renderItems(state, layout);
  }

  function tokenVisible(token, size) {
    if (fogLayer.hidden) return true;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (visible.has(`${token.col + x},${token.row + y}`)) return true;
    }
    return false;
  }
  return { render, pointerDown, toggleFog, previewFog, tokenVisible,
    hideEditor: () => editing && (setEditing(false), true), isEditing: () => editing };
}
