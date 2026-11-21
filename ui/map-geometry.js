const MapGeometry = (() => {
  function orientedSize(width, height, rotation) {
    return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
  }
  function project({ width, height, rotation, viewportWidth, viewportHeight, mode }) {
    const oriented = orientedSize(width, height, rotation);
    const fit = mode !== 'follow';
    const x = viewportWidth / oriented.width;
    const y = viewportHeight / oriented.height;
    const sx = !fit ? 1 : mode === 'fill' ? x : Math.min(x, y);
    const sy = !fit ? 1 : mode === 'fill' ? y : Math.min(x, y);
    const left = fit ? (viewportWidth - oriented.width * sx) / 2 : 0;
    const top = fit ? (viewportHeight - oriented.height * sy) / 2 : 0;
    const rotations = {
      0: [1, 0, 0, 1, 0, 0],
      90: [0, 1, -1, 0, height, 0],
      180: [-1, 0, 0, -1, width, height],
      270: [0, -1, 1, 0, 0, width]
    };
    const [a, b, c, d, dx, dy] = rotations[rotation] ?? rotations[0];
    const matrix = [a * sx, b * sy, c * sx, d * sy, left + dx * sx, top + dy * sy];
    return { matrix, width: fit ? viewportWidth : oriented.width, height: fit ? viewportHeight : oriented.height };
  }
  function inverse([a, b, c, d, dx, dy], x, y) {
    const det = a * d - b * c;
    return { x: (d * (x - dx) - c * (y - dy)) / det, y: (a * (y - dy) - b * (x - dx)) / det };
  }
  return { orientedSize, project, inverse };
})();
if (typeof module !== 'undefined') module.exports = MapGeometry;
