const operator = document.querySelector('#operator');
const limit = document.querySelector('#limit');
const rules = {
  '<': (w, n) => w < n, '<=': (w, n) => w <= n,
  '>': (w, n) => w > n, '>=': (w, n) => w >= n,
};
const saved = practice.initialDraft;
if (Object.hasOwn(rules, saved?.op)) operator.value = saved.op;
if ([2, 3, 4].includes(saved?.limit)) limit.value = String(saved.limit);
const weights = [2, 3, 4, 5];
function destinations() {
  return weights.map(w => rules[operator.value](w, Number(limit.value)) ? '轻件区' : '重件区');
}
function render() {
  document.querySelector('#parcels').replaceChildren(...destinations().map((dest, i) => {
    const tile = document.createElement('span');
    tile.className = 'tile';
    const label = document.createElement('small');
    label.textContent = dest;
    tile.append(weights[i] + ' kg', label);
    return tile;
  }));
}
for (const input of [operator, limit]) input.addEventListener('change', () => {
  render();
  practice.saveDraft({op: operator.value, limit: Number(limit.value)});
});
render();
practice.onGetState(() => ({
  当前条件: 'weight ' + operator.value + ' ' + limit.value,
  包裹去向: destinations().map((dest, i) => ({千克: weights[i], 区域: dest}))
}));
practice.onCheck(() => {
  const actual = destinations();
  const wrong = weights.findIndex((w, i) => actual[i] !== (w <= 3 ? '轻件区' : '重件区'));
  if (wrong < 0) practice.correct('四个包裹都进了对应区域。', actual);
  else practice.incorrect('再看看 ' + weights[wrong] + ' kg 的包裹应该进入哪个区域。', actual);
});
