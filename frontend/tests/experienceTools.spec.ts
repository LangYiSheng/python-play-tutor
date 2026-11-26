import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import DeveloperWorkspace from '../src/features/developer/DeveloperWorkspace.vue';
import { useSession } from '../src/shared/session';
import { api } from '../src/shared/api';

let wrapper: VueWrapper | undefined;
const overview = {chapters:[{id:179,title:'第一章',available:true,status:'published'}],materials:[],activities:[{id:'practice',chapter_id:179,title:'练习',kind:'practice',published:true,questions:3}],quests:[{id:'arrival',title:'初来小镇',chapter_id:179,nodes:[{id:'welcome',title:'欢迎',status:'ready'}]}],checkpoints:[]};
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(20, 20, 140, 34)] as unknown as DOMRectList);
  setActivePinia(createPinia());
  const session = useSession();
  session.user = {id:7,name:'学生',student_id:'7',role:'student',dev_tools_enabled:true};
  session.classroomId = 2;
  session.classes = [{id:2,name:"体验班",teacher_id:10}];
  api.setToken("fixture-experience");
  vi.spyOn(api,'get').mockResolvedValue(overview);
});
afterEach(() => { wrapper?.unmount(); wrapper = undefined; vi.restoreAllMocks(); sessionStorage.clear(); localStorage.clear(); });
async function tool(tab = "content") {
  wrapper = mount(DeveloperWorkspace);
  await wrapper.get(`#developer-tab-${tab}`).trigger("click");
  await flushPromises();
  return wrapper;
}

async function choose(w: VueWrapper, selector: string, label: string) {
  const trigger = w.get(selector);
  await trigger.trigger('click');
  const options = w.get(`[id="${trigger.attributes('aria-controls')}"]`).findAll('[role="option"]');
  expect(options.map(option => option.text())).toContain(label);
  await options.find(option => option.text() === label)!.trigger('click');
}

it('opens an authorized activity at the requested question without marking progress', async () => {
  const post = vi.spyOn(api,'post').mockResolvedValue({workspace:{kind:'practice',activity_id:'practice',question_no:2}});
  const session = useSession(), navigate = vi.spyOn(session,'navigate');
  const w = await tool();
  await choose(w, '#developer-activity', '练习');
  await w.get('#developer-question').setValue('2');
  await w.findAll('button').find(b=>b.text()==='打开活动')!.trigger('click');
  await flushPromises();
  expect(post).toHaveBeenCalledExactlyOnceWith('/dev/experience/open', {classroom_id:2,kind:'activity',target:'practice',page_no:1,question_no:2,video_time:0});
  expect(navigate).toHaveBeenCalledWith({kind:'practice',activity_id:'practice',question_no:2});
});


it('ignores a late content response after switching account', async () => {
  let finish!: (value: unknown) => void;
  vi.spyOn(api,'post').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const session = useSession(), navigate = vi.spyOn(session,'navigate');
  const w = await tool();
  await choose(w, '#developer-activity', '练习');
  await w.findAll('button').find(b=>b.text()==='打开活动')!.trigger('click');
  session.user = {...session.user!,id:8};
  await flushPromises();
  finish({workspace:{kind:'practice',activity_id:'practice'}});
  await flushPromises();
  expect(navigate).not.toHaveBeenCalled();
});


it('reuses a frozen checkpoint payload after uncertain failure, including across tab switches', async () => {
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('连接中断')).mockResolvedValueOnce({});
  const w = await tool('checkpoints');
  sessionStorage.setItem('read:7:2:question:practice', '1');
  await w.get('#developer-checkpoint-name').setValue('练习前');
  await w.get('form').trigger('submit');
  await flushPromises();
  expect(w.get('[role=alert]').text()).toBe('连接中断');
  const initial = structuredClone(post.mock.calls[0]![1]);
  sessionStorage.setItem('read:7:2:question:practice', '2');
  await w.get('#developer-tab-account').trigger('click');
  await w.get('#developer-tab-checkpoints').trigger('click');
  await w.get('form').trigger('submit');
  await flushPromises();
  expect(post.mock.calls[1]![1]).toEqual(initial);
  expect(w.get('#developer-checkpoint-name').element).toHaveProperty('value', '');
  expect(w.text()).toContain('检查点已保存。');
});


it('keeps checkpoint restore separate from reset and sends the preview fingerprint', async () => {
  vi.mocked(api.get).mockImplementation(async path => path.includes('/preview')
    ? { expected: 'checkpoint-token', name: '练习前' }
    : { ...overview, checkpoints: [{ id: 'cp1', name: '练习前', created_at: '2026-11-15T00:00:00Z', valid: true }] });
  const restart = vi.spyOn(useSession(), 'restartCurrentClassroom').mockResolvedValue(true);
  const w = await tool('checkpoints');
  await w.findAll('button').find(button => button.text() === '恢复')!.trigger('click');
  await flushPromises();
  expect(restart).not.toHaveBeenCalled();
  await w.get('.developer-confirm .town-primary').trigger('click');
  expect(restart).toHaveBeenCalledExactlyOnceWith({
    path: '/dev/experience/checkpoints/cp1/restore',
    body: { classroom_id: 2, expected: 'checkpoint-token' },
    restore: true,
  });
});
