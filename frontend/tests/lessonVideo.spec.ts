import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {defineComponent, h, ref} from "vue";
import {mount, flushPromises, type VueWrapper} from "@vue/test-utils";
import {createPinia, setActivePinia} from "pinia";
import {useChapterParticipation, type ParticipationSample} from "../src/features/learning/useChapterParticipation";
import {api} from "../src/shared/api";
import {useSession} from "../src/shared/session";
let wrapper:VueWrapper|undefined;
beforeEach(()=>{setActivePinia(createPinia());});
afterEach(async()=>{wrapper?.unmount();await flushPromises();vi.restoreAllMocks();});
function setup(value:ParticipationSample) {
  const session=useSession();session.user={id:1,role:"student",name:"同学",student_id:"10"};session.classroomId=2;
  const sample=ref<ParticipationSample|null>(value);
  const task={id:"reading:3:4",material_id:4,title:"资料",kind:"reading" as const,current:0,total:2,unit:"页",required:true,completed:false,locked:false,lock_reason:null};
  session.taskChapters=[{id:3,title:"第一章",order_index:0,completed:false,tasks:[task]}];
  const post=vi.spyOn(api,"post").mockResolvedValue(task);
  wrapper=mount(defineComponent({setup(){useChapterParticipation(3,4,sample);return()=>h("main");}}));
  return {sample,post,session};
}
it("sends displayed page IDs and stops when the reader is covered",async()=>{
  const {sample,post,session}=setup({visible:true,page_id:82});await flushPromises();
  sample.value={visible:true,page_id:94};await flushPromises();
  sample.value=null;await flushPromises();
  expect(post.mock.calls.map(([url,body])=>[url,(body as ParticipationSample).page_id,(body as ParticipationSample).visible])).toEqual(
    [[82,true],[94,true],[94,false]].map(parts=>["/chapters/3/materials/4/participation?classroom_id=2",...parts]));
  await session.flushParticipation();
  expect(post).toHaveBeenCalledTimes(3);
});
it("reports video position, playback and rate, without claiming elapsed time",async()=>{
  const {post,sample,session}=setup({visible:true,position:1,playing:true,playback_rate:1});
  await flushPromises();sample.value={visible:true,position:8,playing:true,playback_rate:2};await flushPromises();
  await session.flushParticipation();
  expect(post.mock.lastCall?.[1]).toMatchObject({position:8,playing:false,visible:false,playback_rate:2,sequence:3});
  expect(post.mock.lastCall?.[1]).not.toHaveProperty("seconds");
});
it("retries the same packet before sending later evidence and isolates classroom switches",async()=>{
  const {post,sample,session}=setup({visible:true,page_id:82});
  post.mockRejectedValueOnce(new Error("离线"));
  await flushPromises();sample.value={visible:true,page_id:94};await flushPromises();
  expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
  expect(post.mock.calls[2]?.[1]).toMatchObject({page_id:94,sequence:2});
  session.classroomId=5;await session.flushParticipation();
  expect(post).toHaveBeenCalledTimes(3);
});
