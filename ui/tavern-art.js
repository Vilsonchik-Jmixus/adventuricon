// Draw on a small integer grid so edges stay sharp at any window size.
for (const canvas of document.querySelectorAll('[data-pixel]')) {
  const ctx = canvas.getContext('2d');
  const rect = (color, x, y, width, height) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, width, height);
  };
  if (canvas.dataset.pixel === 'lantern') {
    rect('#1b100c', 3, 2, 18, 20);
    rect('#69452b', 2, 4, 20, 16);
    rect('#a97b50', 4, 3, 16, 1);
    rect('#3d2718', 4, 5, 16, 15);
    rect('#b47f4d', 10, 4, 4, 3);
    rect('#d0a06b', 8, 7, 8, 2);
    rect('#996039', 7, 9, 10, 8);
    rect('#d19658', 9, 9, 6, 8);
    rect('#f2ca8a', 11, 11, 2, 5);
    rect('#bb8957', 7, 17, 10, 2);
    continue;
  }

  rect('#2a1b13', 0, 22, 112, 2);
  rect('#513420', 1, 21, 110, 1);
  rect('#42291c', 9, 2, 94, 17);
  rect('#4b3020', 10, 3, 92, 1);
  for (let row = 0; row < 4; row++) {
    rect('#352218', 9, 5 + row * 4, 94, 1);
    for (let x = 13 + (row % 2) * 5; x < 102; x += 10) rect('#352218', x, 6 + row * 4, 1, 3);
  }
  rect('#6e4a33', 40, 2, 32, 3);
  rect('#573925', 43, 5, 26, 16);
  rect('#332015', 47, 8, 18, 12);
  rect('#22150f', 49, 7, 14, 13);
  rect('#63402a', 45, 20, 22, 2);
  rect('#704229', 49, 18, 14, 2);
  rect('#a75d38', 50, 15, 12, 3);
  rect('#c18049', 52, 12, 7, 6);
  rect('#dc9c57', 54, 11, 3, 7);
  rect('#edb674', 55, 15, 3, 3);
  for (const x of [20, 86]) {
    rect('#2a1a11', x, 10, 6, 11);
    rect('#996d4c', x + 1, 11, 4, 3);
    rect('#63442e', x + 1, 14, 4, 6);
    rect('#cb955c', x + 2, 7, 2, 4);
  }
}
