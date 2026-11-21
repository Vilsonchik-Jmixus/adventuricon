const hosts = new Set(['dnd.su', 'www.dnd.su', 'next.dnd.su', '5e14.dnd.su', 'www.5e14.dnd.su']);

function publicDndUrl(value, kind) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.port || url.username || url.password) return null;
    const pattern = kind === 'portrait' ? /^\/gallery\/.+\.(?:jpe?g|png|webp|gif)$/i
      : kind === 'creature' ? /^\/bestiary\/\d+[\w-]*\/?$/
        : /^\/items\/\d+[\w-]*\/?$/;
    if (!pattern.test(url.pathname)) return null;
    url.hash = '';
    url.search = '';
    if (kind !== 'portrait' && !url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch { return null; }
}

async function readPublicResponse(net, url, maxBytes) {
  const response = await net.fetch(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(12_000) });
  if (!response.ok || !response.body) throw new Error('Справочник dnd.su сейчас недоступен');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('Файл справочника слишком большой');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
  }
}
module.exports = { publicDndUrl, readPublicResponse };
