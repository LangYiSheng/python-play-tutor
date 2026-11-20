import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, it, vi } from 'vitest';
import { mountInteractivePractice, type InteractiveResult } from '../../shared/interactivePractice';
import PracticeWorkspace from '../src/features/practice/PracticeWorkspace.vue';
import { api } from '../src/shared/api';
import { useSession } from '../src/shared/session';
import type { Activity } from '../src/shared/types';

vi.mock('../../shared/interactivePractice', () => ({ mountInteractivePractice: vi.fn() }));
const mountFrame = vi.mocked(mountInteractivePractice);
const practice: Activity = {
  id: 'workshop', chapter_id: 1, title: '小镇工坊', kind: 'practice', npc_key: null, role: null, assistant_allowed: true, resources: [],
  questions: [
    { id: 'lamps', kind: 'interactive', title: '巡灯', prompt: '点亮奇数路灯', options: [], samples: [],
      interactive: { html: '<div>lamp</div>', css: '', js: 'private-author-script' } },
    { id: 'other', kind: 'boolean', title: '判断', prompt: '请选择', options: [], samples: [] },
  ],
};
const key = 'draft:1:2:practice:workshop:lamps';
function start(kind = 'practice', realAssistant = false, activity = practice) {
  const pinia = createPinia();
  setActivePinia(pinia);
  const session = useSession();
  session.user = { id: 1, name: 'Test', student_id: '123', role: 'student' };
  session.classroomId = 2;
  vi.spyOn(session, 'activity').mockResolvedValue({ ...activity, kind });
  return mount(PracticeWorkspace, { props: { activityId: practice.id }, global: { plugins: [pinia], stubs: { AssistantPanel: !realAssistant } } });
}
function options() { return mountFrame.mock.lastCall![2]!; }
const accepted = { id: 'receipt', activity_id: 'workshop', question_id: 'lamps', mode: 'submit', status: 'accepted', feedback: { detail: '四盏路灯亮了' } };
afterEach(() => { vi.restoreAllMocks(); mountFrame.mockReset(); localStorage.clear(); sessionStorage.clear(); });

it('restores the practice draft across navigation and reload without sending it or author content to the assistant', async () => {
  const dispose = vi.fn();
  const getState = vi.fn();
  mountFrame.mockReturnValue({ check: vi.fn(), getState, dispose });
  const post = vi.spyOn(api, 'post');
  let wrapper = start();
  await flushPromises();
  options().onReady?.();
  options().onDraft?.({ start: 1 });
  await flushPromises();
  expect(JSON.parse(localStorage.getItem(key)!).answer).toEqual({ interactiveDraft: { start: 1 } });
  expect(wrapper.findComponent({ name: 'LearningSupportPanel' }).props('assistantState')).toEqual({ question_id: 'lamps' });
  expect(post).not.toHaveBeenCalled();
  await wrapper.get('button[aria-label="下一题"]').trigger('click');
  expect(dispose).toHaveBeenCalledOnce();
  await wrapper.get('button[aria-label="上一题"]').trigger('click');
  expect(options().initialDraft).toEqual({ start: 1 });
  wrapper.unmount();
  wrapper = start();
  await flushPromises();
  expect(options().initialDraft).toEqual({ start: 1 });
  expect(post).not.toHaveBeenCalled();
  expect(getState).not.toHaveBeenCalled();
  wrapper.unmount();
});

it('checks only on explicit submission, can submit the initial state, and retries the frozen receipt after reopening', async () => {
  const result: InteractiveResult = { value: [1, 3, 5, 7], correct: true, message: '四盏路灯亮了' };
  const check = vi.fn().mockResolvedValue(result);
  mountFrame.mockReturnValue({ check, getState: vi.fn(), dispose: vi.fn() });
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('网络断开')).mockResolvedValue(accepted);
  vi.spyOn(api, 'get').mockResolvedValue({ completed: false, accepted_question_ids: ['lamps'] });
  let wrapper = start();
  await flushPromises();
  expect(wrapper.get('.submission-actions button').attributes()).toHaveProperty('disabled');
  options().onReady?.();
  await flushPromises();
  expect(check).not.toHaveBeenCalled();
  await wrapper.get('.submission-actions button').trigger('click');
  await flushPromises();
  expect(wrapper.text()).toContain('网络断开');
  expect(wrapper.get('.submission-actions button:not(.primary)').attributes()).toHaveProperty('disabled');
  const request = post.mock.calls[0]![1];
  expect(request).toMatchObject({ question_id: 'lamps', mode: 'submit', answer: result, code: '', idempotency_key: expect.any(String) });
  expect(JSON.stringify(request)).not.toContain('private-author-script');
  wrapper.unmount();
  wrapper = start();
  await flushPromises();
  expect(wrapper.get('.submission-actions button').text()).toBe('重试提交');
  expect(wrapper.get('.submission-actions button:not(.primary)').attributes()).toHaveProperty('disabled');
  await wrapper.get('.submission-actions button').trigger('click');
  await flushPromises();
  expect(check).toHaveBeenCalledOnce();
  expect(post.mock.calls[1]![1]).toEqual(request);
  expect(wrapper.get('.submission-result').text()).toContain('回答正确');
  expect(wrapper.get('.submission-result').text()).toContain('四盏路灯亮了');
  wrapper.unmount();
});

it('keeps local failures and late checks out of submissions', async () => {
  let resolve!: (result: InteractiveResult) => void;
  const check = vi.fn(() => new Promise<InteractiveResult>(done => { resolve = done; }));
  mountFrame.mockReturnValue({ check, getState: vi.fn(), dispose: vi.fn() });
  const post = vi.spyOn(api, 'post');
  const wrapper = start();
  await flushPromises();
  options().onError?.('脚本初始化失败');
  await flushPromises();
  expect(wrapper.text()).toContain('脚本初始化失败');
  expect(wrapper.get('.submission-actions button').attributes()).toHaveProperty('disabled');
  await wrapper.get('.error button').trigger('click');
  options().onReady?.();
  await flushPromises();
  await wrapper.get('.submission-actions button').trigger('click');
  expect(wrapper.get('.submission-actions button:not(.primary)').attributes()).toHaveProperty('disabled');
  wrapper.unmount();
  resolve({ value: null, correct: false, message: '稍后返回的回执' });
  await flushPromises();
  expect(post).not.toHaveBeenCalled();
});

it('resets only this exercise, with a fresh frame and persisted empty draft while keeping the official receipt and progress', async () => {
  const mountOptions = { check: vi.fn(), getState: vi.fn(), dispose: vi.fn() };
  mountFrame.mockReturnValue(mountOptions);
  const post = vi.spyOn(api, 'post');
  const get = vi.spyOn(api, 'get').mockImplementation(async path =>
    path.startsWith('/submissions/') ? accepted : { accepted_question_ids: ['lamps'], completed: false });
  const other = { ...practice.questions[0]!, id: 'backpack', title: '整理背包' };
  const activity = { ...practice, questions: [...practice.questions, other] };
  const otherKey = 'draft:1:2:practice:workshop:backpack', otherDraft = { items: ['宝石'] };
  localStorage.setItem(key, JSON.stringify({ answer: { interactiveDraft: { start: 1 } }, code: '', submission_id: 'receipt' }));
  const otherSaved = JSON.stringify({ answer: { interactiveDraft: otherDraft }, code: '' });
  localStorage.setItem(otherKey, otherSaved);
  let wrapper = start('practice', false, activity);
  await flushPromises();
  expect(options().initialDraft).toEqual({ start: 1 });
  const oldFrame = wrapper.get('iframe').element, oldCallbacks = options();
  oldCallbacks.onError?.('载入此前的草稿失败');
  await flushPromises();
  expect(wrapper.text()).toContain('载入此前的草稿失败');
  get.mockClear();
  await wrapper.get('.submission-actions button:not(.primary)').trigger('click');
  expect(mountOptions.dispose).toHaveBeenCalledOnce();
  expect(mountFrame).toHaveBeenCalledTimes(2);
  expect(wrapper.get('iframe').element).not.toBe(oldFrame);
  expect(options().initialDraft).toBeUndefined();
  expect(wrapper.text()).not.toContain('载入此前的草稿失败');
  expect(wrapper.get('.submission-result').text()).toContain('四盏路灯亮了');
  expect(wrapper.get('[aria-label="活动总进度"]').attributes('value')).toBe('1');
  oldCallbacks.onDraft?.({ start: 9 });
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ answer: null, submission_id: 'receipt' });
  expect(localStorage.getItem(otherKey)).toBe(otherSaved);
  expect(get).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  expect(mountOptions.check).not.toHaveBeenCalled();
  expect(mountOptions.getState).not.toHaveBeenCalled();
  // Exercises can change their UI without publishing a draft. A second reset must still rebuild the frame.
  await wrapper.get('.submission-actions button:not(.primary)').trigger('click');
  expect(mountFrame).toHaveBeenCalledTimes(3);
  await wrapper.get('button[aria-label="下一题"]').trigger('click');
  expect(wrapper.find('.submission-actions button:not(.primary)').exists()).toBe(false);
  await wrapper.get('button[aria-label="下一题"]').trigger('click');
  expect(options().initialDraft).toEqual(otherDraft);
  await wrapper.get('button[aria-label="上一题"]').trigger('click');
  await wrapper.get('button[aria-label="上一题"]').trigger('click');
  expect(options().initialDraft).toBeUndefined();
  wrapper.unmount();
  wrapper = start('practice', false, activity);
  await flushPromises();
  expect(options().initialDraft).toBeUndefined();
  expect(wrapper.get('.submission-result').text()).toContain('四盏路灯亮了');
  wrapper.unmount();
});

it('can reset after a failed historical receipt lookup and waits for the new frame before accepting submissions', async () => {
  const check = vi.fn().mockResolvedValue({ correct: false, value: 0, message: '再试一次' });
  mountFrame.mockReturnValue({ check, getState: vi.fn(), dispose: vi.fn() });
  const get = vi.spyOn(api, 'get').mockRejectedValue(new Error('回执暂时不可用'));
  const post = vi.spyOn(api, 'post').mockResolvedValue({ ...accepted, id: 'new-receipt', status: 'wrong_answer' });
  localStorage.setItem(key, JSON.stringify({ answer: { interactiveDraft: { start: 5 } }, code: '', submission_id: 'old-receipt' }));
  const wrapper = start();
  await flushPromises();
  expect(get).toHaveBeenCalledWith('/submissions/old-receipt?classroom_id=2');
  const previous = options();
  previous.onReady?.();
  await flushPromises();
  const submit = wrapper.get('.submission-actions button.primary');
  expect(submit.attributes()).not.toHaveProperty('disabled');

  await wrapper.get('.submission-actions button:not(.primary)').trigger('click');
  expect(options()).not.toBe(previous);
  expect(options().initialDraft).toBeUndefined();
  expect(JSON.parse(localStorage.getItem(key)!)).toMatchObject({ answer: null, submission_id: 'old-receipt' });
  previous.onReady?.();
  await flushPromises();
  expect(submit.attributes()).toHaveProperty('disabled');
  await submit.trigger('click');
  expect(check).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  options().onReady?.();
  await flushPromises();
  expect(submit.attributes()).not.toHaveProperty('disabled');
  await submit.trigger('click');
  await flushPromises();
  expect(check).toHaveBeenCalledOnce();
  expect(post).toHaveBeenCalledOnce();
  wrapper.unmount();
});

it.each(['queued', 'submission_unknown'])('preserves the draft while a restored submission is %s', async status => {
  mountFrame.mockReturnValue({ check: vi.fn(), getState: vi.fn(), dispose: vi.fn() });
  let resolve!: (value: unknown) => void;
  vi.spyOn(api, 'get').mockImplementation(() => new Promise(done => { resolve = done; }));
  const old = JSON.stringify({ answer: { interactiveDraft: 1 }, code: '', submission_id: 'receipt' });
  localStorage.setItem(key, old);
  const wrapper = start();
  await flushPromises();
  const reset = wrapper.get('.submission-actions button:not(.primary)');
  resolve({ ...accepted, status });
  await flushPromises();
  expect(reset.attributes()).toHaveProperty('disabled');
  await reset.trigger('click');
  expect(mountFrame).toHaveBeenCalledOnce();
  expect(localStorage.getItem(key)).toBe(old);
  wrapper.unmount();
});

it('rejects a misconfigured assessment before loading a frame or creating an attempt', async () => {
  const get = vi.spyOn(api, 'get');
  const wrapper = start('assessment');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('交互练习题仅可用于练习');
  expect(mountFrame).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  wrapper.unmount();
});

function mockChat() {
  vi.spyOn(api, 'get').mockResolvedValue({ available: true, reason: '' });
  const post = vi.spyOn(api, 'post').mockResolvedValue({ id: 'chat' });
  const stream = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
    new Response(new ReadableStream({ start(controller) { controller.close(); } })));
  return { post, stream };
}

it('reads the mounted exercise only on Send, keeping its question ID if the student navigates while reading', async () => {
  const { post, stream } = mockChat();
  const check = vi.fn();
  let resolve!: (state: { lit: number[] }) => void;
  const getState = vi.fn(() => new Promise<{ lit: number[] }>(done => { resolve = done; }));
  mountFrame.mockReturnValue({ check, getState, dispose: vi.fn() });
  const wrapper = start('practice', true);
  await flushPromises();
  options().onReady?.();
  options().onDraft?.({ privateDraft: 'only on this device' });
  await wrapper.get('[role="tab"][aria-controls$="-assistant"]').trigger('click');
  const draftBefore = localStorage.getItem(key);
  await wrapper.get('textarea').setValue('哪些路灯亮着？');
  expect(getState).not.toHaveBeenCalled();
  await wrapper.get('.assistant-composer').trigger('submit');
  expect(getState).toHaveBeenCalledOnce();
  expect(stream).not.toHaveBeenCalled();
  await wrapper.get('button[aria-label="下一题"]').trigger('click');
  resolve({ lit: [0, 2, 4, 6] });
  await flushPromises();
  const body = JSON.parse(stream.mock.calls[0]![1]!.body as string);
  expect(body.state).toEqual({ question_id: 'lamps', interactive_state: { available: true, value: { lit: [0, 2, 4, 6] } } });
  expect(check).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).toBe(draftBefore);
  expect(post.mock.calls.map(call => call[0])).toEqual(['/assistant/sessions']);
  await wrapper.get('textarea').setValue('我在做哪一题？');
  await wrapper.get('.assistant-composer').trigger('submit');
  await flushPromises();
  expect(JSON.parse(stream.mock.calls[1]![1]!.body as string).state).toEqual({ question_id: 'other', answer: '', code: '' });
  expect(getState).toHaveBeenCalledOnce();
  wrapper.unmount();
});

it('still sends the question when the exercise has no readable state, without using the local draft as a fallback', async () => {
  const { stream } = mockChat();
  const check = vi.fn();
  mountFrame.mockReturnValue({ check, getState: vi.fn().mockRejectedValue(new Error('未注册 getState')), dispose: vi.fn() });
  const wrapper = start('practice', true);
  await flushPromises();
  options().onReady?.();
  options().onDraft?.({ privateDraft: 'only on this device' });
  await wrapper.get('textarea').setValue('怎样开始？');
  await wrapper.get('.assistant-composer').trigger('submit');
  await flushPromises();
  expect(JSON.parse(stream.mock.calls[0]![1]!.body as string).state).toEqual({ question_id: 'lamps', interactive_state: { available: false } });
  expect(check).not.toHaveBeenCalled();
  wrapper.unmount();
});
