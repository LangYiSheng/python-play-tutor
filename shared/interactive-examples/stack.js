const items = {
  herb: {
    name: '药草', colors: { d:'#355636', g:'#5a9157', l:'#91b669', h:'#c3d986', b:'#8a6943', s:'#bf9660' },
    pixels: ['................','.........dd.....','........dggd....','.......dghld....','...ddd.dlgd.....','..dglgd.dg...dd.','..dghlgdgg.ddgd.','...dgggdg.dgld..','....ddggddgld...','......dggggd....','....dd.ggd......','...dggdgd.......','....dggbd.......','......dsbd......','.......dbd......','........d.......']
  },
  gem: {
    name: '水晶', colors: { d:'#425174', a:'#6176a5', b:'#7499c8', c:'#92c8da', l:'#c3ebeb', h:'#e8f4ea' },
    pixels: ['................','.......dd.......','......dcld......','.....dclhld.....','.....dclhld.....','....dbclhld.....','...dcbclhlad....','..dcbbcllcad....','..dlcbbllcad.dd.','..dclbbccbadcbd.','...dcabccbadcbd.','...dbabccbacbd..','....dabbbaabd...','.....daaaaad....','......ddddd.....','................']
  },
  mushroom: {
    name: '蘑菇', colors: { d:'#66483a', r:'#a95342', t:'#c9694e', s:'#e28a5c', h:'#fff0be', e:'#e6cfa0', b:'#b59872' },
    pixels: ['................','......dddd......','....ddstttdd....','...dshtsthhtrd..','..dshhtttthtrd..','..dttttthhttrd..','.dthtttthhttrrd.','.dthhttttttrrrd.','.drrrtttrrrrrrd.','..dddddddddddd..','......dehed.....','......dehed.....','.....dbeheed....','.....deeeeebd...','......dddddd....','................']
  }
};
const itemIds = Object.keys(items);
const goal = ['herb', 'mushroom', 'gem'];
const saved = practice.initialDraft;
const valid = saved && Array.isArray(saved.stack) && Array.isArray(saved.shelf)
  && saved.stack.length + saved.shelf.length === itemIds.length
  && itemIds.every(id => [...saved.stack, ...saved.shelf].includes(id));
let stack = valid ? [...saved.stack] : ['herb', 'gem'];
let shelf = valid ? [...saved.shelf] : ['mushroom'];
const slotsNode = document.getElementById('pack-slots');
const shelfNode = document.getElementById('pack-shelf');
const popButton = document.getElementById('pack-pop');
function sprite(item) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox','0 0 16 16');
  svg.setAttribute('class','pack-sprite');
  svg.setAttribute('aria-hidden','true');
  svg.setAttribute('shape-rendering','crispEdges');
  const paths = {};
  item.pixels.forEach((line, y) => Array.from(line).forEach((color, x) => {
    if (item.colors[color]) paths[color] = (paths[color] || '') + 'M' + x + ' ' + y + 'h1v1h-1z';
  }));
  for (const [color, path] of Object.entries(paths)) {
    const node = document.createElementNS(ns, 'path');
    node.setAttribute('d', path);
    node.setAttribute('fill', item.colors[color]);
    svg.append(node);
  }
  return svg;
}
function renderPack() {
  slotsNode.replaceChildren();
  shelfNode.replaceChildren();
  for (let layer = itemIds.length - 1; layer >= 0; layer--) {
    const item = items[stack[layer]];
    const slot = document.createElement('div');
    slot.className = 'pack-slot';
    if (item) {
      slot.append(sprite(item), document.createTextNode(item.name));
      if (layer === stack.length - 1) {
        slot.classList.add('is-top');
        const label = document.createElement('span');
        label.className = 'pack-tag';
        label.textContent = '栈顶';
        slot.append(label);
      }
    } else {
      slot.classList.add('is-empty');
      slot.textContent = '空位';
    }
    slotsNode.append(slot);
  }
  for (const id of shelf) {
    const item = items[id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pack-item';
    button.setAttribute('aria-label','入栈：' + item.name);
    button.append(sprite(item), document.createTextNode(item.name));
    button.addEventListener('click', () => {
      shelf = shelf.filter(value => value !== id);
      stack.push(id);
      changed(item.name + '已放到栈顶');
      (shelfNode.querySelector('button') || popButton).focus({preventScroll:true});
    });
    shelfNode.append(button);
  }
  if (!shelf.length) {
    const empty = document.createElement('p');
    empty.className = 'pack-empty';
    empty.textContent = '物架已空';
    shelfNode.append(empty);
  }
  document.getElementById('pack-count').textContent = shelf.length + ' 件';
  popButton.disabled = !stack.length;
}
function changed(message) {
  renderPack();
  document.getElementById('pack-live').textContent = message;
  practice.saveDraft({stack:[...stack], shelf:[...shelf]});
}
popButton.addEventListener('click', () => {
  if (!stack.length) return;
  const id = stack.pop();
  shelf.push(id);
  changed(items[id].name + '已放回物架');
  if (!stack.length) shelfNode.querySelector('button')?.focus({preventScroll:true});
});
practice.onGetState(() => ({
  背包从栈底到栈顶: stack.map(id => items[id].name),
  物架上: shelf.map(id => items[id].name)
}));
practice.onCheck(() => {
  if (goal.every((id, index) => stack[index] === id))
    return practice.correct('背包整理好了！水晶最后入栈，下一次取出的就是水晶。', stack);
  if (stack[0] && stack[0] !== 'herb')
    return practice.incorrect('药草要放在最底层。先取出栈顶物品，腾出底层的位置。', stack);
  if (stack[1] === 'gem')
    return practice.incorrect('水晶在蘑菇应占的那一层。先把上面的物品逐个取回架上，再按目标放入。', stack);
  if (stack.length < goal.length)
    return practice.incorrect('背包还没装齐。按目标从栈底往上看，下一个应放入' + items[goal[stack.length]].name + '。', stack);
  return practice.incorrect('再检查从栈底到栈顶的顺序。只有最上层的物品可以取出。', stack);
});
renderPack();
