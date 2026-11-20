import type { InteractiveSource, JsonValue } from './interactiveValues';
import rangeHtml from './interactive-examples/range.html?raw';
import rangeCss from './interactive-examples/range.css?raw';
import rangeJs from './interactive-examples/range.js?raw';
import stackHtml from './interactive-examples/stack.html?raw';
import stackCss from './interactive-examples/stack.css?raw';
import stackJs from './interactive-examples/stack.js?raw';

export const interactiveExamples: {
  id: string; title: string; prompt: string; source: InteractiveSource; target: JsonValue;
}[] = [
  {
    id: 'range', title: '点亮小镇路灯',
    prompt: '天黑了。调整 range 的起点、终点和步长，让 0 至 7 号路灯中只有 1、3、5、7 号亮起，再提交答案。',
    source: {html: rangeHtml, css: rangeCss, js: rangeJs}, target: [1, 3, 5, 7],
  },
  {
    id: 'stack', title: '整理采集背包',
    prompt: '背包只能从栈顶取放物品。点击“取出栈顶”可暂放到物架，点击物架上的物品可放回背包。请让背包从栈底到栈顶依次为药草、蘑菇、水晶。',
    source: {html: stackHtml, css: stackCss, js: stackJs}, target: ['herb', 'mushroom', 'gem'],
  },
];
