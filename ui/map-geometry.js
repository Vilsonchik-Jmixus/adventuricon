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
  const epsilon = 0.000001;
  const delta = (a, b) => ({ x: b.x - a.x, y: b.y - a.y });
  const cross = (a, b) => a.x * b.y - a.y * b.x;
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const blockingWalls = walls => walls.filter(wall =>
    wall.kind === 'wall' || wall.kind === 'window' || (wall.kind === 'door' && !wall.open));
  const cellCenter = (map, col, row) => ({
    x: map.offsetX + (col + 0.5) * map.grid, y: map.offsetY + (row + 0.5) * map.grid,
  });
  const validCell = cell => !!cell && [cell.col, cell.row].every(n => Number.isInteger(n) && n >= 0 && n <= 2000);
  function routeDistance(cells, alternating = false) {
    let straight = 0, diagonal = 0;
    for (let i = 1; i < cells.length; i++) {
      const x = Math.abs(cells[i].col - cells[i - 1].col), y = Math.abs(cells[i].row - cells[i - 1].row);
      diagonal += Math.min(x, y);
      straight += Math.abs(x - y);
    }
    return 5 * (straight + diagonal + (alternating ? Math.floor(diagonal / 2) : 0));
  }
  function routeBlocked(map, walls, cells) {
    const points = cells.map(({ col, row }) => cellCenter(map, col, row));
    return points.slice(1).some((point, i) => blocked(walls, points[i], point));
  }
  function hit(origin, ray, { a, b }) {
    const edge = delta(a, b), side = delta(origin, a), det = cross(ray, edge);
    if (Math.abs(det) < epsilon) {
      if (Math.abs(cross(side, ray)) >= epsilon) return Infinity;
      const dot = v => (v.x * ray.x + v.y * ray.y) / (ray.x ** 2 + ray.y ** 2);
      const first = dot(side), second = dot(delta(origin, b));
      return Math.max(first, second) > epsilon ? Math.max(Math.min(first, second), epsilon) : Infinity;
    }
    const alongEdge = cross(side, ray) / det, alongRay = cross(side, edge) / det;
    return alongEdge >= -epsilon && alongEdge <= 1 + epsilon && alongRay > epsilon ? alongRay : Infinity;
  }
  function blocked(walls, from, to) {
    if (from.x === to.x && from.y === to.y) return false;
    const ray = delta(from, to);
    return walls.some(wall => hit(from, ray, wall) <= 1 + epsilon);
  }
  function distanceToSegment(point, a, b) {
    const edge = delta(a, b), offset = delta(a, point);
    const lengthSquared = edge.x ** 2 + edge.y ** 2;
    const t = lengthSquared ? Math.max(0, Math.min(1, (offset.x * edge.x + offset.y * edge.y) / lengthSquared)) : 0;
    return distance(point, { x: a.x + t * edge.x, y: a.y + t * edge.y });
  }
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
      const ray = { x: Math.cos(angle), y: Math.sin(angle) };
      const length = nearby.reduce((nearest, wall) => Math.min(nearest, hit(origin, ray, wall)), radius);
      return { x: origin.x + ray.x * length, y: origin.y + ray.y * length };
    });
  }
  function visibleCells(map, origins, walls, range = 12) {
    const visible = new Set();
    for (const { col: x, row: y } of origins) {
      const origin = cellCenter(map, x, y);
      const nearby = nearbySightWalls(origin, map.grid * range, walls, map.grid);
      for (let row = Math.max(0, y - range); row <= y + range; row++) {
        for (let col = Math.max(0, x - range); col <= x + range; col++) {
          if ((row - y) ** 2 + (col - x) ** 2 > range ** 2) continue;
          const cell = `${col},${row}`;
          if (!visible.has(cell) && !blocked(nearby, origin, cellCenter(map, col, row))) visible.add(cell);
        }
      }
    }
    return visible;
  }
  return { orientedSize, project, inverse, cellCenter, validCell, routeDistance, routeBlocked,
    blockingWalls, blocked, lightPolygon, distanceToSegment, visibleCells };
})();
if (typeof module !== 'undefined') module.exports = MapGeometry;
