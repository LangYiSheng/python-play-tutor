function drawTown(canvas, litIndices) {
  const width = 384, height = 112;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const lit = new Set(litIndices);
  function box(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  }
  // Short horizontal runs keep curves and diagonal edges on the pixel grid.
  function oval(x, y, rx, ry, color) {
    for (let row = -ry; row <= ry; row++) {
      const span = Math.floor(rx * Math.sqrt(1 - (row / (ry + 0.3)) ** 2));
      box(x - span, y + row, span * 2 + 1, 1, color);
    }
  }
  function ridge(points, color) {
    for (let i = 1; i < points.length; i++) {
      const [x0, y0] = points[i - 1], [x1, y1] = points[i];
      for (let x = x0; x < x1; x += 2) {
        const y = Math.round((y0 + (y1 - y0) * (x - x0) / (x1 - x0)) / 2) * 2;
        box(x, y, 2, height - y, color);
      }
    }
  }
  box(0, 0, width, height, '#172b46');
  [['#1c3451', 15], ['#223e59', 27], ['#29495f', 37], ['#315267', 49]].forEach(([c, y]) => box(0, y, width, height - y, c));
  let seed = 703;
  function random() {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  }
  for (let i = 0; i < 62; i++) {
    const x = Math.floor(random() * width), y = Math.floor(random() * 45) + 1;
    box(x, y, i % 8 === 0 ? 2 : 1, 1, i % 4 === 0 ? '#b0c6c9' : '#627f95');
  }
  [[53, 12], [171, 23], [346, 12]].forEach(([x, y]) => {
    box(x - 1, y, 3, 1, '#829da9'); box(x, y - 1, 1, 3, '#829da9');
    box(x, y, 1, 1, '#e3d8aa');
  });
  oval(286, 20, 13, 13, '#2e4859');
  oval(286, 20, 10, 10, '#9fae9e');
  oval(286, 19, 9, 9, '#ddcf9d');
  box(282, 14, 4, 2, '#bcbf9d'); box(288, 22, 4, 2, '#c4c29c');
  box(290, 20, 2, 2, '#c4c29c'); box(281, 23, 2, 1, '#bcbf9d');
  [[3, 29, 21], [89, 20, 28], [203, 11, 18], [315, 31, 24]].forEach(([x, y, w]) => {
    box(x, y, w, 2, '#2d4760'); box(x + 7, y - 2, w - 13, 2, '#2c455d');
    box(x + w - 5, y + 2, 12, 1, '#314a60');
  });
  ridge([[0, 40], [15, 43], [41, 27], [54, 36], [71, 31], [104, 49], [137, 29], [146, 32], [159, 26], [186, 45], [205, 39], [218, 44], [247, 25], [268, 39], [286, 35], [310, 47], [344, 30], [363, 39], [384, 32]], '#34546a');
  ridge([[0, 52], [21, 45], [39, 51], [76, 38], [96, 49], [114, 43], [135, 51], [167, 37], [192, 53], [221, 43], [238, 49], [256, 42], [280, 51], [306, 37], [334, 49], [360, 42], [384, 48]], '#28495b');
  function pine(x, base, size, color) {
    for (let row = 0; row < size; row += 2) {
      const half = Math.floor(row * .23 + (row % 8 < 4 ? 0 : 1));
      box(x - half, base - size + row, half * 2 + 1, 2, color);
    }
    box(x - 1, base - 3, 3, 6, color);
  }
  for (let x = 0; x < width + 5; x += 5) {
    pine(x, 68, 10 + Math.floor(random() * 17), '#213f4d');
  }
  box(0, 67, width, 15, '#203a43');
  function windowAt(x, y, warm) {
    box(x - 1, y - 1, 6, 7, '#273a43');
    box(x, y, 4, 4, warm ? '#b29d71' : '#577283');
    box(x, y, 1, 4, warm ? '#cfad77' : '#6b8190');
    box(x + 2, y, 1, 4, '#4d5551'); box(x - 1, y + 4, 6, 1, '#607078');
  }
  function cottage(x, base, w, h, roofHeight, warm) {
    const top = base - h;
    box(x, top, w, h, '#48575d');
    box(x + 2, top + 1, w - 6, h - 2, '#596366');
    box(x + w - 8, top + 1, 7, h - 1, '#414f58');
    box(x + w - 9, top - roofHeight, 4, roofHeight - 1, '#48505a');
    box(x + w - 10, top - roofHeight - 1, 6, 2, '#586373');
    for (let r = 0; r < roofHeight; r++) {
      const inset = roofHeight - 1 - r;
      box(x - 2 + inset, top - roofHeight + r, w + 4 - inset * 2, 1, r % 4 === 0 ? '#536575' : '#3e5161');
    }
    box(x - 2, top, w + 4, 2, '#2b404c');
    const doorX = x + Math.floor(w / 2);
    box(doorX, base - 8, 4, 8, '#33444a');
    box(doorX + 3, base - 5, 1, 1, '#938d6d');
    windowAt(x + 4, base - 9, warm);
    if (w > 22) windowAt(x + w - 8, base - 9, warm);
    box(x - 1, base, w + 2, 2, '#293d42');
  }
  [[-7, 72, 24, 11, 6, false], [41, 70, 31, 12, 8, true],
   [79, 72, 20, 9, 6, false], [128, 70, 28, 13, 8, false],
   [165, 73, 25, 10, 5, true], [212, 72, 30, 10, 7, false],
   [275, 72, 27, 12, 7, true], [340, 71, 32, 11, 9, false]].forEach(args => cottage(...args));
  // A slate-roofed bell tower gives the little town a recognizable skyline.
  box(246, 48, 11, 24, '#59666c'); box(253, 48, 4, 24, '#414f59');
  for (let row = 0; row < 9; row++) {
    const edge = Math.floor(row * .8);
    box(251 - edge, 39 + row, edge * 2 + 1, 1, '#506372');
  }
  box(251, 36, 1, 4, '#819090'); box(244, 48, 15, 2, '#324652');
  windowAt(250, 53, true);
  [[10, 77, 23], [29, 77, 16], [110, 78, 26], [119, 77, 17], [193, 77, 19],
   [200, 77, 26], [263, 76, 16], [314, 78, 25], [324, 77, 19], [382, 76, 26]].forEach(([x, y, s]) => pine(x, y, s, '#1d3840'));
  box(0, 76, width, 8, '#263e44');
  for (let x = 1; x < width; x += 12) {
    box(x, 77, 2, 5, '#44565b'); box(x + 2, 78, 10, 1, '#384e54');
  }
  box(0, 83, width, 2, '#475a61'); box(0, 85, width, 2, '#2a404b');
  box(0, 87, width, 25, '#354953');
  for (let row = 0; row < 4; row++) {
    for (let x = -8 + (row % 2) * 6; x < width; x += 13) {
      const offset = Math.floor(random() * 3);
      box(x + offset, 90 + row * 6, 4 + Math.floor(random() * 6), 1, row % 2 ? '#3f535b' : '#41565d');
      box(x + offset - 2, 91 + row * 6, 2, 1, '#30444e');
    }
  }
  for (let i = 0; i < 8; i++) {
    const x = (i + .5) * width / 8;
    const on = lit.has(i);
    oval(x + 2, 103, 9, 2, '#2b4049');
    if (on) {
      oval(x, 102, 15, 3, 'rgba(244,183,85,.14)');
      oval(x, 101, 10, 2, 'rgba(255,197,94,.19)');
      oval(x, 68, 17, 16, 'rgba(255,184,71,.08)');
      oval(x, 68, 12, 12, 'rgba(255,192,71,.12)');
      oval(x, 68, 9, 9, 'rgba(255,201,91,.20)');
    }
    box(x - 1, 75, 4, 25, '#172e37');
    box(x, 76, 1, 22, on ? '#ae9463' : '#72848a');
    box(x - 2, 96, 5, 4, '#253944'); box(x - 1, 96, 1, 4, '#68797a');
    box(x - 4, 100, 9, 3, '#1b3039'); box(x - 3, 100, 7, 1, '#65777b');
    box(x - 4, 63, 9, 9, '#263c43');
    box(x - 3, 64, 7, 7, on ? '#ffd17b' : '#75909b');
    box(x - 2, 64, 5, 5, on ? '#fff0b2' : '#627f8d');
    box(x, 64, 1, 7, on ? '#e7af64' : '#526d7a');
    box(x - 3, 72, 7, 2, '#263b42'); box(x - 2, 74, 5, 2, '#263b42');
    box(x - 2, 73, 5, 1, on ? '#d4aa68' : '#72858a');
    box(x - 6, 62, 13, 2, '#192f38'); box(x - 4, 60, 9, 2, '#304751');
    box(x - 2, 58, 5, 2, '#435d67'); box(x, 56, 1, 2, '#95a1a0');
    box(x - 4, 62, 9, 1, on ? '#b5976b' : '#70858d');
  }
}
const controls = ['start', 'stop', 'step'].map(id => document.getElementById(id));
const defaults = {start: 0, stop: 8, step: 2};
const bounds = [[0, 7], [0, 8], [1, 4]];
controls.forEach((select, index) => {
  const [min, max] = bounds[index];
  for (let i = min; i <= max; i++) select.add(new Option(String(i), String(i)));
  const saved = practice.initialDraft?.[select.id];
  select.value = String(Number.isInteger(saved) && saved >= min && saved <= max ? saved : defaults[select.id]);
  select.addEventListener('change', () => {
    renderLamps();
    practice.saveDraft(Object.fromEntries(controls.map(select => [select.id, Number(select.value)])));
  });
});
const labels = Array.from({length: 8}, (_, index) => {
  const label = document.createElement('span');
  label.textContent = index;
  document.getElementById('indices').append(label);
  return label;
});
function litIndices() {
  const [start, stop, step] = controls.map(select => Number(select.value));
  const lit = [];
  for (let i = start; i < stop; i += step) lit.push(i);
  return lit;
}
function renderLamps() {
  const lit = litIndices();
  drawTown(document.getElementById('town'), lit);
  labels.forEach((label, index) => label.classList.toggle('on', lit.includes(index)));
  document.getElementById('lit').textContent = lit.length ? '当前亮灯　' + lit.join('、') + ' 号' : '当前没有亮灯';
}
renderLamps();
practice.onGetState(() => ({
  起点: Number(controls[0].value), 终点: Number(controls[1].value), 步长: Number(controls[2].value),
  当前亮灯编号: litIndices()
}));
practice.onCheck(() => {
  const lit = litIndices();
  const goal = [1, 3, 5, 7];
  if (goal.length === lit.length && goal.every((lamp, i) => lit[i] === lamp)) {
    practice.correct('四盏奇数号路灯都亮了。循环从 1 开始，每次前进 2，在到达终点 8 前停止。', lit);
  } else if (!lit.length) {
    practice.incorrect('一盏灯也没有亮。步长为正数时，起点需要小于终点。', lit);
  } else {
    const missing = goal.filter(lamp => !lit.includes(lamp));
    const extra = lit.filter(lamp => !goal.includes(lamp));
    const differences = [];
    if (missing.length) differences.push('还缺 ' + missing.join('、') + ' 号');
    if (extra.length) differences.push('多亮了 ' + extra.join('、') + ' 号');
    practice.incorrect(differences.join('，') + '。调整参数后可以再提交。', lit);
  }
});
