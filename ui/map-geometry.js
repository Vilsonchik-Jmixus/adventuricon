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
  function transform([a, b, c, d, dx, dy], x, y) {
    return { x: a * x + c * y + dx, y: b * x + d * y + dy };
  }
  const epsilon = 0.000001;
  const delta = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const wallLists = new WeakMap();
  function blockingWalls(terrain) {
    let walls = wallLists.get(terrain);
    if (!walls) {
      walls = terrain.filter(wall => wall.kind === 'wall' || wall.kind === 'window' || (wall.kind === 'door' && !wall.open));
      wallLists.set(terrain, walls);
    }
    return walls;
  }
  const cellCenter = (map, col, row) => ({
    x: map.offsetX + (col + 0.5) * map.grid, y: map.offsetY + (row + 0.5) * map.grid,
  });
  const validCell = cell => !!cell && [cell.col, cell.row].every(n => Number.isInteger(n) && n >= 0 && n <= 2000);
  function footprintsOverlap(a, b) {
    const as = Math.max(1, a.size ?? 1), bs = Math.max(1, b.size ?? 1);
    return a.col < b.col + bs && b.col < a.col + as && a.row < b.row + bs && b.row < a.row + as;
  }
  function tokenCenter(map, { col, row, size = 1 }) {
    const shift = (Math.max(1, size) - 1) / 2;
    return cellCenter(map, col + shift, row + shift);
  }
  function routeDistance(cells, alternating = false) {
    let straight = 0, diagonal = 0;
    for (let i = 1; i < cells.length; i++) {
      const x = Math.abs(cells[i].col - cells[i - 1].col), y = Math.abs(cells[i].row - cells[i - 1].row);
      diagonal += Math.min(x, y);
      straight += Math.abs(x - y);
    }
    return 5 * (straight + diagonal + (alternating ? Math.floor(diagonal / 2) : 0));
  }
  function routeBlocked(map, walls, cells, size = 1) {
    if (walls.length === 0) return false;
    const points = cells.map(cell => tokenCenter(map, { ...cell, size }));
    if (size <= 1) return points.slice(1).some((point, i) => blocked(walls, points[i], point));
    const half = map.grid * size / 2 - 0.01;
    return points.slice(1).some((to, i) => {
      const from = points[i];
      return walls.some(({ a, b }) => {
        // Separating axes for the wall segment and the square swept along this leg.
        const axes = [[1, 0], [0, 1], [from.y - to.y, to.x - from.x], [a.y - b.y, b.x - a.x]];
        return axes.every(([x, y]) => {
          const start = from.x * x + from.y * y, end = to.x * x + to.y * y;
          const first = a.x * x + a.y * y, last = b.x * x + b.y * y;
          const padding = half * (Math.abs(x) + Math.abs(y));
          return Math.min(first, last) <= Math.max(start, end) + padding &&
            Math.max(first, last) >= Math.min(start, end) - padding;
        });
      });
    });
  }
  function hit(originX, originY, rayX, rayY, { a, b }) {
    const edgeX = b.x - a.x, edgeY = b.y - a.y;
    const sideX = a.x - originX, sideY = a.y - originY;
    const det = rayX * edgeY - rayY * edgeX;
    if (Math.abs(det) < epsilon) {
      if (Math.abs(sideX * rayY - sideY * rayX) >= epsilon) return Infinity;
      const lengthSquared = rayX * rayX + rayY * rayY;
      const first = (sideX * rayX + sideY * rayY) / lengthSquared;
      const second = ((b.x - originX) * rayX + (b.y - originY) * rayY) / lengthSquared;
      return Math.max(first, second) > epsilon ? Math.max(Math.min(first, second), epsilon) : Infinity;
    }
    const alongEdge = (sideX * rayY - sideY * rayX) / det;
    const alongRay = (sideX * edgeY - sideY * edgeX) / det;
    return alongEdge >= -epsilon && alongEdge <= 1 + epsilon && alongRay > epsilon ? alongRay : Infinity;
  }
  function blocked(walls, from, to) {
    if (from.x === to.x && from.y === to.y) return false;
    const rayX = to.x - from.x, rayY = to.y - from.y;
    return walls.some(wall => hit(from.x, from.y, rayX, rayY, wall) <= 1 + epsilon);
  }
  function distanceToSegment(point, a, b) {
    const edge = delta(a, b), offset = delta(a, point);
    const lengthSquared = edge.x ** 2 + edge.y ** 2;
    const t = lengthSquared ? Math.max(0, Math.min(1, (offset.x * edge.x + offset.y * edge.y) / lengthSquared)) : 0;
    return distance(point, { x: a.x + t * edge.x, y: a.y + t * edge.y });
  }
  const sameWalls = (a, b) => a === b || a?.length === b.length &&
    b.every((wall, index) => {
      const previous = a[index];
      return previous === wall || previous.kind === wall.kind &&
        previous.a.x === wall.a.x && previous.a.y === wall.a.y &&
        previous.b.x === wall.b.x && previous.b.y === wall.b.y;
    });
  function nearbySightWalls(origin, radius, walls, windowRange) {
    return walls.filter(wall => {
      const distance = distanceToSegment(origin, wall.a, wall.b);
      return distance <= radius && (wall.kind !== 'window' || distance > windowRange);
    });
  }
  function lightPolygon(origin, radius, walls, windowRange = 0) {
    const nearby = nearbySightWalls(origin, radius, walls, windowRange);
    const angles = Array.from({ length: 72 }, (_, i) => i / 72 * Math.PI * 2 - Math.PI);
    for (const { a, b } of nearby) {
      for (const end of [a, b]) {
        const angle = Math.atan2(end.y - origin.y, end.x - origin.x);
        angles.push(angle - 0.0001, angle, angle + 0.0001);
      }
    }
    return angles.sort((a, b) => a - b).map(angle => {
      const rayX = Math.cos(angle), rayY = Math.sin(angle);
      let length = radius;
      for (const wall of nearby) length = Math.min(length, hit(origin.x, origin.y, rayX, rayY, wall));
      return { x: origin.x + rayX * length, y: origin.y + rayY * length };
    });
  }
  function visibleCells(map, origins, walls, range = 12) {
    const visible = new Set();
    for (const token of origins) {
      const shift = (Math.max(1, token.size ?? 1) - 1) / 2;
      const x = token.col + shift, y = token.row + shift;
      const origin = tokenCenter(map, token);
      const nearby = nearbySightWalls(origin, map.grid * range, walls, map.grid);
      for (let row = Math.max(0, Math.ceil(y - range)); row <= y + range; row++) {
        for (let col = Math.max(0, Math.ceil(x - range)); col <= x + range; col++) {
          if ((row - y) ** 2 + (col - x) ** 2 > range ** 2) continue;
          const cell = `${col},${row}`;
          if (!visible.has(cell) && !blocked(nearby, origin, cellCenter(map, col, row))) visible.add(cell);
        }
      }
    }
    return visible;
  }
  return { orientedSize, project, inverse, transform, cellCenter, validCell, routeDistance, routeBlocked,
    blockingWalls, sameWalls, blocked, lightPolygon, distanceToSegment, visibleCells, footprintsOverlap, tokenCenter };
})();
if (typeof module !== 'undefined') module.exports = MapGeometry;
