import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, it, vi } from 'vitest';
import PracticeWorkspace from '../src/features/practice/PracticeWorkspace.vue';
import { evaluateBrowserSubmission } from '../src/features/practice/browserSubmission';
import { useSession } from '../src/shared/session';
import { api } from '../src/shared/api';

vi.mock('../src/features/practice/browserSubmission', () => ({evaluateBrowserSubmission: vi.fn()}));
const cases = [{input:'hello',output:'hello',stdout:'hello\n',stderr:''}];
async function setup() {
  const pinia = createPinia(); setActivePinia(pinia);
  const session = useSession();
  session.user = {id:1,name:'Test',student_id:'123',role:'student'}; session.classroomId = 2;
  vi.spyOn(session, 'activity').mockResolvedValue({id:'practice',chapter_id:1,title:'练习',kind:'practice',npc_key:'',assistant_allowed:false,resources:[],
    questions:[{id:'python',kind:'python',title:'Echo',prompt:'Echo',samples:[{input:'hello',output:'hello'}],starter_code:'print(input())'}]});
  vi.spyOn(api, 'get').mockResolvedValue({completed:false,accepted_question_ids:['python']});
  const wrapper = mount(PracticeWorkspace, {props:{activityId:'practice'},global:{plugins:[pinia],stubs:{AssistantPanel:true,ProgrammingQuestion:true}}});
  await flushPromises();
  return {wrapper, session};
}
afterEach(() => { vi.restoreAllMocks(); vi.mocked(evaluateBrowserSubmission).mockReset(); localStorage.clear(); sessionStorage.clear(); });

it('evaluates before saving, preserves the receipt across network retries and restores completion', async () => {
  const {wrapper} = await setup();
  let resolve!: (value: typeof cases) => void;
  vi.mocked(evaluateBrowserSubmission).mockImplementation(() => new Promise(done => {resolve=done;}));
  const post = vi.spyOn(api, 'post').mockRejectedValueOnce(new Error('offline')).mockResolvedValue({id:'receipt',question_id:'python',activity_id:'practice',mode:'submit',status:'accepted',feedback:{source:'browser_practice',passed_count:1,total_count:1}});
  const card = wrapper.findComponent({name:'ProgrammingQuestion'});
  card.vm.$emit('submit','submit'); await flushPromises();
  expect(post).not.toHaveBeenCalled(); expect(card.props('busy')).toBe(true);
  resolve(cases); await flushPromises();
  expect(post.mock.calls[0]?.[1]).toMatchObject({code:'print(input())',browser_cases:cases});
  card.vm.$emit('submit','submit'); await flushPromises();
  expect(evaluateBrowserSubmission).toHaveBeenCalledOnce();
  expect(post.mock.calls[1]?.[1]).toEqual(post.mock.calls[0]?.[1]);
  expect(card.props('result').status).toBe('accepted');
  expect(JSON.parse(localStorage.getItem('draft:1:2:python')!).submission_id).toBe('receipt');
  wrapper.unmount();
});

it.each(['unmount','account'])('does not send an old browser result after %s', async reason => {
  const {wrapper,session} = await setup();
  let resolve!: (value: typeof cases) => void;
  let signal!: AbortSignal;
  vi.mocked(evaluateBrowserSubmission).mockImplementation((_code,_samples,abort) => {signal=abort;return new Promise(done => {resolve=done;});});
  const post = vi.spyOn(api,'post');
  wrapper.findComponent({name:'ProgrammingQuestion'}).vm.$emit('submit','submit'); await flushPromises();
  if(reason==='unmount') wrapper.unmount(); else session.user = null;
  await flushPromises(); expect(signal.aborted).toBe(true);
  resolve(cases); await flushPromises(); expect(post).not.toHaveBeenCalled();
  if(reason!=='unmount') wrapper.unmount();
});

it('resolves a saved pre-upgrade request without running or changing its evidence', async () => {
  const pending={key:'legacy-request',mode:'submit',answer:'',code:'print(input())'};
  localStorage.setItem('draft:1:2:python',JSON.stringify({answer:'',code:pending.code,pending}));
  const {wrapper}=await setup();
  const post=vi.spyOn(api,'post').mockResolvedValue({id:'old-receipt',question_id:'python',activity_id:'practice',mode:'submit',status:'accepted',feedback:{passed_count:3,total_count:3}});
  wrapper.findComponent({name:'ProgrammingQuestion'}).vm.$emit('submit','submit'); await flushPromises();
  expect(evaluateBrowserSubmission).not.toHaveBeenCalled();
  expect(post.mock.calls[0]?.[1]).toMatchObject({idempotency_key:'legacy-request',code:pending.code,browser_cases:undefined});
  expect(wrapper.findComponent({name:'ProgrammingQuestion'}).props('result').id).toBe('old-receipt');
  wrapper.unmount();
});
