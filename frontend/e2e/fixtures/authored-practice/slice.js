const stops = ['广场', '果园', '书屋', '车站', '码头'];
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
function slice() {
  return stops.slice(Number(start.value), Number(stop.value));
}
function draw() {
  const selected = slice();
  document.querySelector('#route').textContent = '本段路线：' + (selected.join(' → ') || '空');
  document.querySelectorAll('.tile').forEach((tile, i) => tile.classList.toggle('selected', selected.includes(stops[i])));
}
stops.forEach((name, i) => {
  const tile = document.createElement('span');
  tile.className = 'tile';
  const label = document.createElement('small');
  label.textContent = '索引 ' + i;
  tile.append(name, label);
  document.querySelector('#stops').append(tile);
});
for (const select of [start, stop]) {
  for (let i = 0; i <= stops.length; i++) select.add(new Option(String(i), String(i)));
  const saved = practice.initialDraft?.[select.id];
  select.value = String(Number.isInteger(saved) && saved >= 0 && saved <= stops.length ? saved : select === start ? 0 : 2);
  select.addEventListener('change', () => {
    draw();
    practice.saveDraft({start: Number(start.value), stop: Number(stop.value)});
  });
}
draw();
practice.onGetState(() => ({起始索引: Number(start.value), 结束索引: Number(stop.value), 已选站点: slice()}));
practice.onCheck(() => {
  const route = slice();
  if (route.join('/') === '果园/书屋/车站') practice.correct('三站均已选中，结束索引对应的站点未包含在内。', route);
  else practice.incorrect('对照首站和末站，检查切片的起点以及不包含在结果中的结束索引。', route);
});
