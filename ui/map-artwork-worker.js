self.onmessage = async ({ data: { source } }) => {
  let bitmap;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error('Map image unavailable');
    const blob = await response.blob();
    if (/\.webp(?:\?|$)/i.test(source)) {
      const header = new Uint8Array(await blob.slice(12, 21).arrayBuffer());
      if (String.fromCharCode(...header.slice(0, 4)) === 'VP8X' && (header[8] & 2)) {
        self.postMessage(null);
        return;
      }
    }
    bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    const levels = [];
    for (const size of [1024, 2048]) {
      if (longest <= size * 1.25) break;
      const scale = size / longest;
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      levels.push({ size, blob: await canvas.convertToBlob({ type: 'image/webp', quality: .92 }) });
    }
    self.postMessage({ width, height, levels });
  } catch {
    self.postMessage(null);
  } finally {
    bitmap?.close();
  }
};
