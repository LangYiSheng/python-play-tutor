const coins = [2, 5, 3];
const input = document.querySelector('#total');
const record = document.querySelector('#record');
const undo = document.querySelector('#undo');
const saved = practice.initialDraft;
const valid = n => Number.isInteger(n) && n >= 0 && n <= 99;
const history = Array.isArray(saved?.history) && saved.history.length <= coins.length && saved.history.every(valid) ? [...saved.history] : [];
if (valid(saved?.entry)) input.value = String(saved.entry);
function entry() {
  return valid(input.valueAsNumber) ? input.valueAsNumber : null;
}
function render() {
  const done = history.length === coins.length;
  document.querySelector('#turn').textContent = done ? '三轮已记录，可以提交或撤回修改。' : '第 ' + (history.length + 1) + ' 轮：本轮收到 ' + coins[history.length] + ' 枚金币。';
  input.disabled = done;
  record.disabled = done || entry() === null;
  undo.disabled = history.length === 0;
  document.querySelector('#ledger').textContent = '已记录的 total：' + (history.join(' → ') || '暂无');
}
function changed() { render(); practice.saveDraft({history, entry: entry()}); }
record.addEventListener('click', () => { if (entry() !== null && history.length < coins.length) history.push(entry()); input.value = ''; changed(); });
undo.addEventListener('click', () => { if (history.length) input.value = String(history.pop()); changed(); });
input.addEventListener('input', changed);
render();
practice.onGetState(() => ({已记录的逐轮累计值: [...history], 下一轮收入: coins[history.length] ?? null, 正在填写的累计值: entry()}));
practice.onCheck(() => {
  if (history.length !== coins.length) return practice.incorrect('还有未记录的轮次。', history);
  let total = 0;
  for (let i = 0; i < coins.length; i++) {
    total += coins[i];
    if (history[i] !== total) return practice.incorrect('第 ' + (i + 1) + ' 轮的累计值需要再算一次，可撤回到这一轮。', history);
  }
  practice.correct('三轮的累计值都记录正确。', history);
});
