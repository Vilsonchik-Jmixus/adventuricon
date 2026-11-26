const { createReadStream } = require('node:fs');
const { stat } = require('node:fs/promises');
const { extname } = require('node:path');
const { Readable } = require('node:stream');

const types = {
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.flac': 'audio/flac'
};

async function audioResponse(file, request) {
  const type = types[extname(file).toLowerCase()];
  if (!type) return null;
  const { size } = await stat(file);
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(size) };
  const range = request.headers.get('range');
  const body = options => request.method === 'HEAD' || !size ? null : Readable.toWeb(createReadStream(file, options));
  if (!range) return new Response(body(), { headers });

  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  const invalid = () => new Response(null, {
    status: 416, headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }
  });
  if (!size || !match || !match[1] && !match[2]) return invalid();
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return invalid();
  return new Response(body({ start, end }), { status: 206, headers: {
    ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`
  } });
}

module.exports = { audioResponse };
