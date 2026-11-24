function createStoryBoard({ getStory, dispatch, openDialog, closeDialog, assetURL, imageDraft }) {
  const get = id => document.getElementById(id);
  const viewport = get('story-viewport'), world = get('story-world');
  const cards = get('story-cards'), ropes = get('story-ropes'), strokes = get('story-strokes');
  const draftPath = get('story-draft'), message = get('story-instruction');
  const dialog = get('story-dialog');
  let tool = 'move', source = null, gesture, ignoreClick = false;
  let editing, newPosition, lastRender;
  const renderedNotes = new WeakMap();
  let cameraX = 0, cameraY = 0;
  const limit = 1000000;

  const cardFor = id => cards.querySelector(`[data-story-note="${CSS.escape(id)}"]`);
  const coordinate = n => Math.max(-limit, Math.min(limit, Math.round(n)));
  function moveCamera(x, y) {
    cameraX = coordinate(x);
    cameraY = coordinate(y);
    world.style.transform = `translate(${-cameraX}px, ${-cameraY}px)`;
    viewport.style.backgroundPosition = `${-cameraX % 18}px ${-cameraY % 18}px`;
  }
  const pointAt = event => {
    const bounds = world.getBoundingClientRect();
    return { x: coordinate(event.clientX - bounds.left), y: coordinate(event.clientY - bounds.top) };
  };
  function pathElement(d, className) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', className);
    return path;
  }
  function drawStroke(points) {
    if (points.length === 1) return `M ${points[0].join(' ')} h .1`;
    return 'M ' + points.map(point => point.join(' ')).join(' L ');
  }
  function cardBounds(card) {
    return { x: card.offsetLeft, y: card.offsetTop, width: card.offsetWidth, height: card.offsetHeight };
  }
  function center({ x, y, width, height }) { return { x: x + width / 2, y: y + height / 2 }; }
  function edgeOf(note, target) {
    const origin = center(note), dx = target.x - origin.x, dy = target.y - origin.y;
    if (dx === 0 && dy === 0) return origin;
    const ratio = Math.min(note.width / (2 * Math.abs(dx)), note.height / (2 * Math.abs(dy)));
    return { x: origin.x + dx * ratio, y: origin.y + dy * ratio };
  }
  function ropePath(a, b) {
    const sag = Math.min(28, Math.hypot(a.x - b.x, a.y - b.y) / 7);
    return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${(a.y + b.y) / 2 + sag} ${b.x} ${b.y}`;
  }
  function drawRopes() {
    const { links } = getStory();
    const nodes = new Map(Array.from(cards.children, card => [card.dataset.storyNote, cardBounds(card)]));
    ropes.replaceChildren(...links.flatMap(link => {
      const a = nodes.get(link.from), b = nodes.get(link.to);
      return a && b ? [pathElement(ropePath(edgeOf(a, center(b)), edgeOf(b, center(a))), 'story-rope')] : [];
    }));
  }
  function updateControls() {
    viewport.dataset.tool = tool;
    get('story-pen-options').hidden = tool !== 'pen';
    document.querySelectorAll('[data-story-tool]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.storyTool === tool));
    });
    message.hidden = !source;
    message.textContent = source ? 'Выбери вторую карточку. Esc отменяет связь.' : '';
    for (const card of cards.children) card.classList.toggle('connecting', card.dataset.storyNote === source);
  }
  function fillLinks() {
    const { notes, links } = getStory(), list = get('story-links');
    const related = links.filter(link => link.from === editing || link.to === editing);
    list.hidden = !related.length;
    list.replaceChildren(...related.flatMap(link => {
      const other = notes.find(note => note.id === (link.from === editing ? link.to : link.from));
      if (!other) return [];
      const row = document.createElement('div'), name = document.createElement('span'), remove = document.createElement('button');
      name.textContent = other.title;
      remove.type = 'button';
      remove.textContent = '×';
      remove.dataset.storyUnlink = link.id;
      remove.setAttribute('aria-label', 'Убрать связь с заметкой «' + other.title + '»');
      row.append(name, remove);
      return [row];
    }));
  }
  function placeCard(card, note) {
    card.style.left = note.x + 'px';
    card.style.top = note.y + 'px';
  }
  function createCard(note) {
    const card = document.createElement('article'), title = document.createElement('button');
    const body = document.createElement('p'), pin = document.createElement('button');
    card.className = 'story-note';
    card.dataset.storyNote = note.id;
    placeCard(card, note);
    title.type = 'button';
    title.className = 'story-note-title';
    title.title = 'Щёлкни для редактирования, потяни для перемещения';
    title.textContent = note.title;
    body.className = 'story-note-body';
    body.textContent = note.body;
    pin.type = 'button';
    pin.className = 'story-pin';
    pin.title = 'Потяни к другой карточке, чтобы связать';
    pin.setAttribute('aria-label', 'Связать заметку «' + note.title + '»');
    card.append(title);
    const images = note.images ?? [];
    if (images.length) {
      const attachments = document.createElement('div');
      attachments.className = 'story-note-images';
      for (const asset of images) {
        const image = document.createElement('img');
        image.className = 'story-note-image';
        image.alt = '';
        image.src = assetURL(asset);
        image.draggable = false;
        attachments.append(image);
      }
      card.append(attachments);
    }
    card.append(body, pin);
    renderedNotes.set(card, note);
    return card;
  }
  function render() {
    if (gesture) return;
    const story = getStory();
    if (!story) return;
    if (lastRender === story) return;
    const previous = lastRender;
    lastRender = story;
    const focused = document.activeElement?.closest('[data-story-note]')?.dataset.storyNote;
    if (story.notes !== previous?.notes) {
      const existing = new Map([...cards.children].map(card => [card.dataset.storyNote, card]));
      for (const note of story.notes) {
        const card = existing.get(note.id);
        const before = card && renderedNotes.get(card);
        existing.delete(note.id);
        if (!card) cards.append(createCard(note));
        else if (before.title !== note.title || before.body !== note.body ||
          (before.images ?? []).join(',') !== (note.images ?? []).join(',')) card.replaceWith(createCard(note));
        else {
          placeCard(card, note);
          renderedNotes.set(card, note);
        }
      }
      for (const card of existing.values()) card.remove();
    }
    if (story.strokes !== previous?.strokes) strokes.replaceChildren(...story.strokes.flatMap(mark => {
      const d = drawStroke(mark.points), path = pathElement(d, 'story-mark'), hit = pathElement(d, 'story-hit');
      path.style.stroke = mark.color;
      path.style.strokeWidth = mark.width;
      hit.style.strokeWidth = Math.max(15, mark.width);
      hit.dataset.storyStroke = mark.id;
      return [path, hit];
    }));
    get('story-empty').hidden = !!story.notes.length || !!story.strokes.length;
    if (source && !story.notes.some(note => note.id === source)) source = null;
    drawRopes();
    updateControls();
    if (focused) cardFor(focused)?.querySelector('.story-note-title').focus({ preventScroll: true });
    if (dialog.open) fillLinks();
  }
  function firstFreePosition(fields) {
    const left = cameraX + 16, top = cameraY + 16;
    const all = Array.from(cards.children, cardBounds);
    const candidate = createCard({ ...fields, id: '', x: 0, y: 0 });
    candidate.style.visibility = 'hidden';
    cards.append(candidate);
    const { width, height } = cardBounds(candidate);
    candidate.remove();
    const columns = Math.max(1, Math.floor(viewport.clientWidth / (width + 20)));
    let index = 0, x, y;
    do {
      x = left + index % columns * (width + 20);
      y = top + Math.floor(index / columns) * (height + 20);
      index++;
    } while (y < limit && all.some(note =>
      x < note.x + note.width + 8 && x + width + 8 > note.x &&
      y < note.y + note.height + 8 && y + height + 8 > note.y));
    return { x, y };
  }
  function edit(note, position) {
    editing = note?.id ?? null;
    newPosition = position;
    get('story-title').value = note?.title ?? '';
    get('story-body').value = note?.body ?? '';
    imageDraft.reset(note?.images);
    get('story-delete').hidden = !note;
    fillLinks();
    openDialog(dialog.id);
  }
  async function connect(from, to) {
    source = null;
    updateControls();
    if (from !== to) await dispatch('story:link', { from, to });
  }
  get('story-add').onclick = () => edit();
  get('story-home').onclick = () => {
    const { notes, strokes } = getStory();
    const marker = notes[0];
    const [x, y] = marker ? [marker.x, marker.y] : strokes[0]?.points[0] ?? [16, 16];
    moveCamera(x - 16, y - 16);
    viewport.focus({ preventScroll: true });
  };
  get('story-form').onsubmit = async event => {
    event.preventDefault();
    if (imageDraft.busy) return;
    const fields = { title: get('story-title').value, body: get('story-body').value, images: imageDraft.assets };
    const position = editing ? null : newPosition ?? firstFreePosition(fields);
    const response = await dispatch('story:save', { id: editing, ...position, ...fields });
    if (response?.ok) closeDialog(dialog);
  };
  get('story-delete').onclick = async () => {
    if (confirm('Удалить заметку и её связи?') && (await dispatch('story:remove', { id: editing }))?.ok) closeDialog(dialog);
  };
  get('story-links').onclick = event => {
    const id = event.target.closest('[data-story-unlink]')?.dataset.storyUnlink;
    if (id) dispatch('story:unlink', { id });
  };
  document.querySelectorAll('[data-story-tool]').forEach(button => {
    button.onclick = () => { tool = button.dataset.storyTool; source = null; updateControls(); };
  });
  cards.onclick = event => {
    if (ignoreClick || tool !== 'move') return;
    const card = event.target.closest('[data-story-note]');
    if (!card) return;
    const id = card.dataset.storyNote;
    if (source) {
      if (source === id) { source = null; updateControls(); }
      else connect(source, id);
    } else if (event.target.closest('.story-pin')) {
      source = id;
      updateControls();
    } else if (event.target.closest('.story-note-title')) {
      const note = getStory().notes.find(item => item.id === id);
      if (note) edit(note);
    }
  };
  viewport.addEventListener('dblclick', event => {
    if (!ignoreClick && tool === 'move' && !event.target.closest('[data-story-note]')) edit(null, pointAt(event));
  });
  function eraseAt(event) {
    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-story-stroke]');
    if (!hit) return;
    gesture.removed.add(hit.dataset.storyStroke);
    hit.previousElementSibling.style.visibility = 'hidden';
    hit.style.visibility = 'hidden';
  }
  function move(event) {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const point = pointAt(event);
    const dx = event.clientX - gesture.clientX, dy = event.clientY - gesture.clientY;
    gesture.moved ||= Math.hypot(dx, dy) > 3;
    if (gesture.kind === 'link' && gesture.moved) {
      draftPath.setAttribute('class', 'story-rope-preview');
      draftPath.setAttribute('d', ropePath(edgeOf(cardBounds(gesture.card), point), point));
    }
    if (gesture.kind === 'move' && gesture.moved) {
      const { note, offset, card } = gesture;
      gesture.position = { id: note.id, x: coordinate(point.x - offset.x), y: coordinate(point.y - offset.y) };
      placeCard(card, gesture.position);
      drawRopes();
    }
    if (gesture.kind === 'pan') moveCamera(gesture.left - dx, gesture.top - dy);
    if (gesture.kind === 'pen' && gesture.points.length < 2000) {
      const [lastX, lastY] = gesture.points.at(-1);
      if (Math.hypot(point.x - lastX, point.y - lastY) >= 2) gesture.points.push([point.x, point.y]);
      draftPath.setAttribute('d', drawStroke(gesture.points));
    }
    if (gesture.kind === 'eraser') eraseAt(event);
  }
  function finish(event, apply) {
    if (!gesture || (event && event.pointerId !== gesture.pointerId)) return false;
    const completed = gesture;
    gesture = null;
    completed.card?.classList.remove('moving');
    viewport.classList.remove('panning');
    if (completed.capture.hasPointerCapture(completed.pointerId)) completed.capture.releasePointerCapture(completed.pointerId);
    draftPath.removeAttribute('d');
    draftPath.removeAttribute('style');
    draftPath.removeAttribute('class');
    ignoreClick = completed.moved;
    setTimeout(() => { ignoreClick = false; }, 0);
    if (!apply) { lastRender = null; render(); return true; }
    if (completed.kind === 'move' && completed.position) dispatch('story:move', completed.position).then(restoreOnFailure);
    if (completed.kind === 'link' && completed.moved) {
      const id = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-story-note]')?.dataset.storyNote;
      if (id) connect(completed.id, id);
    }
    if (completed.kind === 'pen') dispatch('story:draw', { points: completed.points, width: completed.width, color: completed.color });
    if (completed.kind === 'eraser' && completed.removed.size) dispatch('story:erase', { ids: [...completed.removed] }).then(restoreOnFailure);
    render();
    return true;
  }
  function restoreOnFailure(response) {
    if (!response?.ok) { lastRender = null; render(); }
  }
  viewport.addEventListener('pointerdown', event => {
    if (gesture || (event.button !== 0 && event.button !== 1)) return;
    const card = event.target.closest('[data-story-note]');
    const note = card && getStory().notes.find(item => item.id === card.dataset.storyNote);
    if (event.button === 0 && card && (tool !== 'move' || (!event.target.closest('.story-pin, .story-note-title')))) return;
    const point = pointAt(event);
    const capture = card ? event.target : viewport;
    const input = { capture, clientX: event.clientX, clientY: event.clientY, pointerId: event.pointerId, moved: false };
    if (event.button === 1 || (tool === 'move' && !note)) {
      gesture = { ...input, kind: 'pan', left: cameraX, top: cameraY };
      viewport.classList.add('panning');
    } else if (note) {
      const kind = event.target.closest('.story-pin') ? 'link' : 'move';
      gesture = { ...input, kind, id: note.id, note, card, offset: { x: point.x - note.x, y: point.y - note.y } };
      if (kind === 'move') card.classList.add('moving');
    } else if (tool === 'pen') {
      const color = get('story-color').value, width = Number(get('story-width').value);
      gesture = { ...input, kind: 'pen', points: [[point.x, point.y]], width, color };
      draftPath.style.stroke = color;
      draftPath.style.strokeWidth = width;
      draftPath.setAttribute('d', drawStroke(gesture.points));
    } else {
      gesture = { ...input, kind: 'eraser', removed: new Set() };
      eraseAt(event);
    }
    capture.setPointerCapture(event.pointerId);
    if (!card || event.button === 1) { event.preventDefault(); viewport.focus({ preventScroll: true }); }
  });
  viewport.addEventListener('wheel', event => {
    if (event.ctrlKey) return;
    event.preventDefault();
    if (gesture) return;
    const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    const horizontal = event.shiftKey && !event.deltaX;
    moveCamera(cameraX + (horizontal ? event.deltaY : event.deltaX) * unit,
      cameraY + (horizontal ? 0 : event.deltaY) * unit);
  }, { passive: false });
  cards.addEventListener('focusin', event => {
    if (gesture) return;
    const card = event.target.closest('.story-note');
    const target = card.getBoundingClientRect();
    const frame = viewport.getBoundingClientRect();
    if (target.right <= frame.left || target.left >= frame.right ||
        target.bottom <= frame.top || target.top >= frame.bottom) {
      moveCamera(card.offsetLeft - 16, card.offsetTop - 16);
    }
  });
  viewport.addEventListener('pointermove', move);
  viewport.addEventListener('pointerup', event => finish(event, true));
  viewport.addEventListener('pointercancel', event => finish(event, false));
  viewport.addEventListener('lostpointercapture', event => finish(event, false));
  viewport.addEventListener('keydown', event => {
    if (event.key !== 'Escape') {
      if (event.target !== viewport || gesture || event.altKey || event.ctrlKey || event.metaKey) return;
      const offset = { ArrowLeft: [-48, 0], ArrowRight: [48, 0], ArrowUp: [0, -48], ArrowDown: [0, 48],
        PageUp: [0, -viewport.clientHeight + 32], PageDown: [0, viewport.clientHeight - 32] }[event.key];
      if (offset) {
        event.preventDefault();
        moveCamera(cameraX + offset[0], cameraY + offset[1]);
      }
      return;
    }
    const canceled = finish(null, false) || !!source;
    if (canceled) {
      source = null;
      event.stopPropagation();
      event.preventDefault();
      updateControls();
    }
  });
  new ResizeObserver(() => {
    if (getStory() && viewport.clientWidth) drawRopes();
  }).observe(viewport);
  function reveal(id) {
    const card = cardFor(id);
    if (!card) return;
    moveCamera(card.offsetLeft - 16, card.offsetTop - 16);
    card.classList.add('revealed');
    card.querySelector('.story-note-title').focus({ preventScroll: true });
    setTimeout(() => card.classList.remove('revealed'), 1600);
  }
  return { render, reveal, pasteNewNote: () => { edit(); imageDraft.pasteImage(); } };
}
