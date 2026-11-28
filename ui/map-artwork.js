function createMapArtwork(image, redraw) {
  const records = new Map();
  let source, record, worker, detail = Infinity;
  function display() {
    if (!source) return;
    const url = record?.levels.find(level => level.size >= detail)?.url ?? source;
    if (image.getAttribute('src') !== url) image.src = url;
  }
  function setSource(next, wanted) {
    detail = wanted;
    if (source === next) return;
    worker?.terminate();
    worker = null;
    source = next;
    record = records.get(source);
    image.removeAttribute('src');
    image.hidden = !next;
    if (!source) return;
    if (records.has(source)) {
      records.delete(source);
      records.set(source, record);
    }
    // Animated maps and the built-in SVG keep their original image source.
    if (typeof Worker !== 'function') return display();
    if (!record && /\.(?:png|jpe?g|webp)(?:\?|$)/i.test(source)) {
      let active;
      try { active = new Worker('map-artwork-worker.js'); }
      catch { return display(); }
      worker = active;
      const finish = data => {
        if (worker !== active) return;
        active.terminate();
        worker = null;
        if (data) {
          record = { ...data, levels: data.levels.map(({ size, blob }) => ({ size, url: URL.createObjectURL(blob) })) };
          records.set(source, record);
          if (records.size > 3) {
            const [old, entry] = records.entries().next().value;
            records.delete(old);
            for (const level of entry.levels) URL.revokeObjectURL(level.url);
          }
          redraw();
        }
        display();
      };
      active.onmessage = event => finish(event.data);
      active.onerror = () => finish(null);
      active.postMessage({ source });
    } else display();
  }
  return {
    setSource,
    setDetail(value) {
      detail = value;
      if (!worker) display();
    },
    size() {
      if (record) return record;
      if (image.complete && image.naturalWidth) return { width: image.naturalWidth, height: image.naturalHeight };
      return null;
    },
  };
}
