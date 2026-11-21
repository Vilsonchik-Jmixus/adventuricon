// The lantern uses an integer grid to stay sharp at small sizes.
const lantern = document.querySelector('[data-pixel="lantern"]').getContext('2d');
for (const [color, x, y, width, height] of [
  ['#1b100c', 3, 2, 18, 20],
  ['#69452b', 2, 4, 20, 16],
  ['#a97b50', 4, 3, 16, 1],
  ['#3d2718', 4, 5, 16, 15],
  ['#b47f4d', 10, 4, 4, 3],
  ['#d0a06b', 8, 7, 8, 2],
  ['#996039', 7, 9, 10, 8],
  ['#d19658', 9, 9, 6, 8],
  ['#f2ca8a', 11, 11, 2, 5],
  ['#bb8957', 7, 17, 10, 2]
]) {
  lantern.fillStyle = color;
  lantern.fillRect(x, y, width, height);
}
