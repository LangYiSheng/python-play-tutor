import {expect, test} from '@playwright/test';

declare global {
  interface Window {
    exercise: {
      mount(id: string, js?: string): void;
      getState(): Promise<unknown>;
      check(): Promise<{correct: boolean; value: unknown; message: string}>;
    };
  }
}

test('交互题的实际 iframe 支持作答、草稿恢复和脚本错误后的重新载入', async ({page}) => {
  const url = process.env.E2E_VITE_URL;
  test.skip(!url, '需要本地学生端 Vite 服务');
  await page.goto(url + '/e2e/fixtures/interactivePractice.html');
  const status = page.locator('output');
  const exercise = page.frameLocator('iframe');
  await expect(status).toHaveText('ready');
  await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(exercise.locator('html')).toHaveCSS('color', 'rgb(81, 59, 40)');
  expect((await page.evaluate(() => window.exercise.check())).correct).toBe(false);
  expect(await page.evaluate(() => window.exercise.getState())).toEqual({起点: 0, 终点: 8, 步长: 2, 当前亮灯编号: [0, 2, 4, 6]});
  await exercise.getByLabel('起点 start').selectOption('1');
  expect(await page.evaluate(() => window.exercise.check())).toMatchObject({correct: true, value: [1, 3, 5, 7]});
  await page.evaluate(() => window.exercise.mount('range'));
  await expect(status).toHaveText('ready');
  await expect(exercise.getByLabel('起点 start')).toHaveValue('1');
  expect(await page.evaluate(() => window.exercise.getState())).toMatchObject({起点: 1, 当前亮灯编号: [1, 3, 5, 7]});

  await page.evaluate(() => window.exercise.mount('range', 'practice.onCheck(() => {})'));
  await expect(status).toHaveText('ready');
  expect(await page.evaluate(() => window.exercise.check().then(() => 'unexpected', error => error.message))).toContain('没有调用');
  await expect(status).toContainText('没有调用');

  await page.evaluate(() => window.exercise.mount('range', 'practice.onCheck(() => practice.correct("完成", Array(2)))'));
  await expect(status).toHaveText('ready');
  expect(await page.evaluate(() => window.exercise.check().then(() => 'unexpected', error => error.message))).toContain('格式无效');

  await page.evaluate(() => window.exercise.mount('stack'));
  await expect(status).toHaveText('ready');
  expect(await page.evaluate(() => window.exercise.getState())).toEqual({背包从栈底到栈顶: ['药草', '水晶'], 物架上: ['蘑菇']});
  await exercise.getByRole('button', {name: '取出栈顶'}).click();
  await exercise.getByRole('button', {name: '入栈：蘑菇'}).click();
  await exercise.getByRole('button', {name: '入栈：水晶'}).click();
  expect(await page.evaluate(() => window.exercise.check())).toMatchObject({correct: true, value: ['herb', 'mushroom', 'gem']});
});

test('自编练习可用不同操作和数据结构返回状态、恢复草稿和判定', async ({page}) => {
  const url = process.env.E2E_VITE_URL;
  test.skip(!url, '需要本地学生端 Vite 服务');
  await page.goto(url + '/e2e/fixtures/interactivePractice.html');
  const frame = page.frameLocator('iframe');
  const state = () => page.evaluate(() => window.exercise.getState());
  const check = () => page.evaluate(() => window.exercise.check());
  async function mount(id: string) {
    await page.evaluate(id => window.exercise.mount(id), id);
    await expect(page.locator('output')).toHaveText('ready');
  }

  await mount('slice');
  expect(await check()).toMatchObject({correct: false});
  await frame.getByLabel('起点').selectOption('1');
  expect(await state()).toMatchObject({起始索引: 1, 已选站点: ['果园']});
  await frame.getByLabel('终点').selectOption('4');
  expect(await check()).toMatchObject({correct: true, value: ['果园', '书屋', '车站']});

  await mount('branch');
  expect(await check()).toMatchObject({correct: false});
  await frame.getByLabel('比较符号').selectOption('<=');
  expect(await state()).toMatchObject({当前条件: 'weight <= 3', 包裹去向: [
    {千克: 2, 区域: '轻件区'}, {千克: 3, 区域: '轻件区'}, {千克: 4, 区域: '重件区'}, {千克: 5, 区域: '重件区'}]});
  expect(await check()).toMatchObject({correct: true, value: ['轻件区', '轻件区', '重件区', '重件区']});
  await frame.getByLabel('比较符号').selectOption('<');
  await frame.getByLabel('重量界限').selectOption('4');
  expect(await check()).toMatchObject({correct: true});

  await mount('loop');
  const input = frame.getByLabel('本轮结束的 total');
  expect(await check()).toMatchObject({correct: false, value: []});
  await input.fill('2');
  expect(await state()).toMatchObject({已记录的逐轮累计值: [], 正在填写的累计值: 2});
  await frame.getByRole('button', {name: '记入本轮'}).click();
  await input.fill('7');
  await mount('slice');
  expect(await state()).toEqual({起始索引: 1, 结束索引: 4, 已选站点: ['果园', '书屋', '车站']});
  await mount('loop');
  expect(await state()).toEqual({已记录的逐轮累计值: [2], 下一轮收入: 5, 正在填写的累计值: 7});
  await frame.getByRole('button', {name: '记入本轮'}).click();
  await input.fill('9');
  await frame.getByRole('button', {name: '记入本轮'}).click();
  expect(await check()).toMatchObject({correct: false, value: [2, 7, 9]});
  await frame.getByRole('button', {name: '撤回一轮'}).click();
  await input.fill('10');
  await frame.getByRole('button', {name: '记入本轮'}).click();
  expect(await check()).toMatchObject({correct: true, value: [2, 7, 10]});
});

test('读取状态失败保留判题能力，退出本题取消在途读取', async ({page}) => {
  const url = process.env.E2E_VITE_URL;
  test.skip(!url, '需要本地学生端 Vite 服务');
  await page.goto(url + '/e2e/fixtures/interactivePractice.html');
  for (const [getter, expected] of [
    ['', '未注册'], ['() => undefined', '有效 JSON'], ['async () => 42', '同步返回'],
    ['() => { practice.saveDraft(1); }', '不能保存草稿'], ['() => { throw Error("读取失败"); }', '读取失败'],
  ]) {
    await page.evaluate(getter => window.exercise.mount('range', 'practice.onCheck(() => practice.incorrect("再试一次"));' +
      (getter ? 'practice.onGetState(' + getter + ')' : '')), getter);
    await expect(page.locator('output')).toHaveText('ready');
    expect(await page.evaluate(() => window.exercise.getState().catch(error => error.message))).toContain(expected);
    expect(await page.evaluate(() => window.exercise.check())).toMatchObject({correct: false, value: null});
  }
  expect(await page.evaluate(() => {
    const reading = window.exercise.getState().catch(error => error.message);
    window.exercise.mount('stack');
    return reading;
  })).toContain('已退出本题');
  await expect(page.locator('output')).toHaveText('ready');
  expect(await page.evaluate(() => window.exercise.getState())).toMatchObject({物架上: ['蘑菇']});
});
