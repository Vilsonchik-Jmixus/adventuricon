const measurementSvg = 'http://www.w3.org/2000/svg';
const measurementNames = { line: 'Линия', circle: 'Круг', square: 'Квадрат', cone: 'Конус' };
function measurementPath(kind, { x, y, angle, feet, end }, grid) {
  const range = grid * feet / 5;
  const point = direction => [x + Math.cos(direction) * range, y + Math.sin(direction) * range].join(' ');
  if (kind === 'circle') return `M ${x - range} ${y} a ${range} ${range} 0 1 0 ${range * 2} 0 a ${range} ${range} 0 1 0 ${-range * 2} 0 Z`;
  if (kind === 'square') {
    const dx = Math.cos(angle) < 0 ? -range : range, dy = Math.sin(angle) < 0 ? -range : range;
    return `M ${x} ${y} h ${dx} v ${dy} h ${-dx} Z`;
  }
  if (kind === 'cone') return `M ${x} ${y} L ${point(angle - Math.PI / 4)} A ${range} ${range} 0 0 1 ${point(angle + Math.PI / 4)} Z`;
  return `M ${x} ${y} L ${end ? `${end.x} ${end.y}` : point(angle)}`;
}

function createMapTemplates({ readOnly, openMenu }) {
  const layer = document.createElementNS(measurementSvg, 'svg');
  layer.id = 'map-templates';
  if (readOnly) layer.setAttribute('aria-hidden', 'true');
  document.getElementById('map-world').append(layer);
  let entries, grid, viewBox, selected;
  function select(id) {
    selected = id;
    for (const group of layer.children) group.classList.toggle('selected', group.dataset.mapTemplate === id);
  }
  if (!readOnly) {
    layer.onpointerdown = event => { if (event.target.closest('[data-template-handle]')) event.stopPropagation(); };
    layer.onclick = event => {
      if (event.target.closest('[data-template-handle]')) select(event.target.closest('[data-map-template]').dataset.mapTemplate);
    };
    const open = event => {
      const marker = event.target.closest('[data-template-handle]');
      if (!marker) return;
      event.preventDefault();
      event.stopPropagation();
      const id = marker.closest('[data-map-template]').dataset.mapTemplate;
      select(id);
      openMenu(entries.find(entry => entry.id === id));
    };
    layer.oncontextmenu = open;
    layer.onkeydown = event => { if (event.key === 'Enter' || event.key === 'Delete') open(event); };
  }
  function render(templates, nextGrid, { width, height, zoom }) {
    const bounds = `0 0 ${width / zoom} ${height / zoom}`;
    if (viewBox !== bounds) { viewBox = bounds; layer.setAttribute('viewBox', bounds); }
    if (entries === templates && grid === nextGrid) return;
    entries = templates;
    grid = nextGrid;
    layer.replaceChildren(...templates.map(template => {
      const group = document.createElementNS(measurementSvg, 'g');
      const shape = document.createElementNS(measurementSvg, 'path');
      group.dataset.mapTemplate = template.id;
      group.dataset.shape = template.kind;
      group.classList.toggle('selected', template.id === selected);
      shape.setAttribute('d', measurementPath(template.kind, template, grid));
      group.append(shape);
      if (!readOnly) {
        const marker = document.createElementNS(measurementSvg, 'circle');
        marker.setAttribute('data-template-handle', '');
        marker.setAttribute('cx', template.x);
        marker.setAttribute('cy', template.y);
        marker.setAttribute('r', Math.max(7, Math.min(25, grid / 5)));
        marker.setAttribute('tabindex', '0');
        marker.setAttribute('role', 'button');
        marker.setAttribute('aria-label', `${measurementNames[template.kind]} · ${template.feet} фут. · Действия шаблона`);
        const title = document.createElementNS(measurementSvg, 'title');
        title.textContent = marker.getAttribute('aria-label');
        marker.append(title);
        group.append(marker);
      }
      return group;
    }));
  }
  return { render, select };
}

function createMapTools({ viewport, getState, getLayout, pointAt, dispatch, context }) {
  const bar = document.createElement('div');
  bar.id = 'map-quick-tools';
  bar.innerHTML = `<div class="map-measure-group" role="group" aria-label="Измерение на карте">
      <button type="button" data-map-tool="line" title="Измерить расстояние">Линейка</button>
      <button type="button" data-map-tool="circle" title="Радиус круга">Круг</button>
      <button type="button" data-map-tool="square" title="Сторона квадрата">Квадрат</button>
      <button type="button" data-map-tool="cone" title="Дальность конуса 90°">Конус</button>
    </div>
    <div id="map-tool-controls" hidden><output id="map-tool-hint"></output>
      <button type="button" id="map-tool-apply" data-pixel-icon="check">Применить</button>
      <button type="button" id="map-tool-close" data-pixel-icon="close" aria-label="Выйти из инструмента"></button></div>`;
  viewport.parentElement.before(bar);
  const world = document.getElementById('map-world');
  const overlay = document.createElementNS(measurementSvg, 'svg');
  overlay.id = 'map-measure-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('hidden', '');
  const path = document.createElementNS(overlay.namespaceURI, 'path');
  overlay.append(path);
  const label = document.createElement('output');
  label.id = 'map-measure-label';
  label.hidden = true;
  world.append(overlay, label);
  const controls = bar.querySelector('#map-tool-controls');
  const hint = bar.querySelector('#map-tool-hint');
  const apply = bar.querySelector('#map-tool-apply');
  let mode, draft, measure, drag, selectedContext, frame = 0;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  function worldPoint(event) {
    const point = pointAt(event.clientX, event.clientY);
    const zoom = getLayout().zoom;
    return { x: point.x / zoom, y: point.y / zoom };
  }
  function render() {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    if (!getLayout()) return;
    const { zoom, width, height } = getLayout();
    // SVG elements need the attribute for the CSS selector to hide the preview.
    overlay.toggleAttribute('hidden', !measure);
    label.hidden = !measure;
    apply.hidden = !draft && !measure;
    apply.textContent = draft ? 'Применить' : 'Оставить на карте';
    if (draft) {
      const { grid, offsetX, offsetY } = draft;
      world.style.setProperty('--grid-size', grid * zoom + 'px');
      world.style.setProperty('--grid-x', offsetX * zoom + 'px');
      world.style.setProperty('--grid-y', offsetY * zoom + 'px');
      world.style.setProperty('--grid-color', draft.color);
      world.style.setProperty('--grid-opacity', Math.max(.4, draft.opacity));
      hint.value = `Тяни сетку · Колесо меняет клетку · Alt + колесо сдвигает сетку · Esc отменяет · ${grid} px · X ${offsetX}, Y ${offsetY}`;
    }
    if (!measure) {
      path.removeAttribute('d');
      return;
    }
    const { grid } = getState().map;
    const { x, y, feet } = measure;
    overlay.setAttribute('viewBox', `0 0 ${width / zoom} ${height / zoom}`);
    overlay.dataset.measure = mode;
    path.setAttribute('d', measurementPath(mode, measure, grid));
    label.value = `${measure.ruleFeet ?? feet} фут.${mode === 'circle' ? ' · радиус' : mode === 'square' ? ' · сторона' : ''}`;
    label.style.left = x * zoom + 'px';
    label.style.top = y * zoom + 'px';
  }
  function queueRender() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(); });
  }
  function close() {
    if (!mode) return false;
    const restoreGrid = Boolean(draft);
    mode = draft = measure = drag = null;
    controls.hidden = true;
    viewport.classList.remove('using-map-tool');
    for (const button of bar.querySelectorAll('[data-map-tool]')) button.setAttribute('aria-pressed', 'false');
    if (restoreGrid) {
      const { map } = getState(), { zoom } = getLayout();
      world.style.setProperty('--grid-size', map.grid * zoom + 'px');
      world.style.setProperty('--grid-x', map.offsetX * zoom + 'px');
      world.style.setProperty('--grid-y', map.offsetY * zoom + 'px');
      world.style.setProperty('--grid-color', map.color);
      world.style.setProperty('--grid-opacity', map.visible ? map.opacity : 0);
    }
    render();
    return true;
  }
  function select(next, gridSettings) {
    const wasActive = mode === next;
    close();
    if (wasActive || !getLayout()) return;
    mode = next;
    selectedContext = context();
    draft = gridSettings;
    controls.hidden = false;
    hint.value = 'Поставь или протяни область · Колесо меняет размер · Esc закрывает';
    viewport.classList.add('using-map-tool');
    for (const button of bar.querySelectorAll('[data-map-tool]')) {
      button.setAttribute('aria-pressed', String(button.dataset.mapTool === mode));
    }
    render();
    viewport.focus({ preventScroll: true });
  }
  bar.querySelector('#map-tool-close').onclick = close;
  apply.onclick = async () => {
    if (!draft && !measure) return;
    const type = draft ? 'map:settings' : 'template:add';
    const settings = draft ?? { ...measure, kind: mode, feet: measure.ruleFeet ?? measure.feet };
    const target = selectedContext;
    apply.disabled = true;
    try {
      const response = await dispatch(type, settings, target);
      if (response?.ok && selectedContext === target) close();
    } finally { apply.disabled = false; }
  };
  for (const button of bar.querySelectorAll('[data-map-tool]')) button.setAttribute('aria-pressed', 'false');
  function pointerDown(event) {
    if (!mode || event.button !== 0) return false;
    event.preventDefault();
    viewport.focus({ preventScroll: true });
    const point = worldPoint(event);
    const { width, height, zoom } = getLayout();
    if (!draft && (point.x < 0 || point.y < 0 || point.x >= width / zoom || point.y >= height / zoom)) return true;
    drag = { id: event.pointerId, point, x: draft?.offsetX, y: draft?.offsetY };
    if (!draft) measure = { ...point, feet: measure?.feet ?? 15, angle: 0 };
    viewport.setPointerCapture(event.pointerId);
    queueRender();
    return true;
  }
  viewport.addEventListener('pointermove', event => {
    if (event.pointerId !== drag?.id) return;
    const point = worldPoint(event), dx = point.x - drag.point.x, dy = point.y - drag.point.y;
    if (draft) {
      draft.offsetX = clamp(Math.round(drag.x + dx), -512, 512);
      draft.offsetY = clamp(Math.round(drag.y + dy), -512, 512);
    } else {
      const distance = mode === 'square' ? Math.max(Math.abs(dx), Math.abs(dy)) : Math.hypot(dx, dy);
      if (distance < 2) return;
      measure.angle = Math.atan2(dy, dx);
      measure.feet = clamp(Math.round(distance / getState().map.grid) * 5, 5, 500);
      if (mode === 'line') {
        const steps = { col: Math.round(dx / getState().map.grid), row: Math.round(dy / getState().map.grid) };
        measure.ruleFeet = MapGeometry.routeDistance([{ col: 0, row: 0 }, steps], getState().map.diagonals === 'alternating');
        measure.end = point;
      }
    }
    queueRender();
  });
  for (const type of ['lostpointercapture', 'pointerup', 'pointercancel']) {
    viewport.addEventListener(type, event => { if (event.pointerId === drag?.id) drag = null; });
  }
  function wheel(event) {
    if (!mode) return false;
    event.preventDefault();
    if (!event.deltaY) return true;
    if (draft) {
      const direction = event.deltaY < 0 ? 1 : -1;
      if (event.altKey) {
        const axis = event.shiftKey ? 'offsetY' : 'offsetX';
        draft[axis] = clamp(draft[axis] + direction, -512, 512);
      } else draft.grid = clamp(draft.grid + direction * (event.shiftKey ? 8 : 1), 16, 512);
    } else {
      measure ??= { ...worldPoint(event), feet: 15, angle: 0 };
      measure.feet = clamp((measure.ruleFeet ?? measure.feet) + (event.deltaY < 0 ? 5 : -5), 5, 500);
      delete measure.ruleFeet;
      delete measure.end;
    }
    queueRender();
    return true;
  }
  return { bar, render, close, select, pointerDown, wheel, active: () => Boolean(mode) };
}
