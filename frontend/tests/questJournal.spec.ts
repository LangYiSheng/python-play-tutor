import {it, expect} from "vitest";
import {mount} from "@vue/test-utils";
import {createPinia, setActivePinia} from "pinia";
import {useSession} from "../src/shared/session";
import QuestJournal from "../src/features/QuestJournal.vue";
import GameHUD from "../src/features/GameHUD.vue";
import ChapterActivityList from "../src/features/ChapterActivityList.vue";
import {greeting, farewell, type TaskChapter, type ChapterTask, type TaskKind} from "../src/shared/chapterTasks";

const task = (kind:TaskKind, id:string, changes: Partial<ChapterTask> = {}):ChapterTask => ({
  kind, id, title:"活动 " + id, activity_id:id, required:true, completed:false, locked:false, lock_reason:null,current:0,total:2,unit:"题",...changes,
});
function setup() {
  const pinia=createPinia();setActivePinia(pinia);
  const session=useSession();
  session.taskChapters=[{id:1,title:"第一章",order_index:1,completed:false,tasks:[task("objective","a"),task("objective","b",{completed:true}),task("programming","c"),task("objective","extra",{required:false})]},
    {id:2,title:"第二章",order_index:2,completed:false,tasks:[task("reading","d",{material_id:2}),task("objective","e",{locked:true,lock_reason:"请先阅读必读资料"})]}];
  return {session, global:{plugins:[pinia]}};
}
it("lists parallel goals per chapter and shows the whole selected chapter",async()=>{
  const {session,global}=setup();
  const w=mount(QuestJournal,{global});
  expect(w.text()).toContain("拜访教授，完成客观题练习（1/2）");
  expect(w.text()).toContain("拜访练习场教练，完成编程题练习");
  expect(w.text()).toContain("选做");
  await w.findAll(".journal-goal").at(-1)!.trigger("click");
  expect(session.trackedQuest).toBe("2:reading");
  expect(w.get("main").text()).toContain("请先阅读必读资料");
});
it("switches the HUD between available targets and guides to its fixed NPC",async()=>{
  const {global}=setup(), w=mount(GameHUD,{global});
  await w.get('[aria-label="切换追踪目标"]').trigger("click");
  expect(w.get(".quest-next").text()).toContain("编程题练习");
  await w.findAll("button").find(b=>b.text()==="立即前往")!.trigger("click");
  expect(w.emitted("guide")).toEqual([["coach"]]);
});
it("offers unlocked practice across chapters and leaves locked items visible",async()=>{
  const {session,global}=setup(),w=mount(ChapterActivityList,{global,props:{category:"objective"}});
  expect(w.findAll(".task-row")).toHaveLength(4);
  expect(w.get(".task-row:disabled").text()).toContain("请先阅读必读资料");
  await w.get(".task-row").trigger("click");
  expect(session.workspace).toEqual({kind:"practice",activity_id:"a"});
});
it("gives progress-specific greetings and reports the newly unlocked practice",()=>{
  const {session}=setup();
  expect(greeting([], "reading").open).toBe(false);
  expect(greeting(session.taskChapters,"objective").open).toBe(true);
  expect(greeting([session.taskChapters[1]!],"objective").text).toContain("第二章");
  const after:TaskChapter[]=JSON.parse(JSON.stringify(session.taskChapters));
  after[1]!.tasks[0]!.completed=true;after[1]!.tasks[1]!.locked=false;
  expect(farewell(session.taskChapters,after,"reading")).toContain("教授");
});

it("uses the platform role name in goals, journal navigation and unlock dialogue", async () => {
  const {session, global} = setup();
  session.world = {
    player: {map_key: "town_hub", tile_x: 0, tile_y: 0, direction: "down"}, flags: [], chapters: [], default_role: null,
    npcs: [{key: "professor", name: "林老师", portrait: "", map_key: "workshop", tile_x: 2, tile_y: 3,
      direction: "down", sprite: {id: "chara_24", url: "", frame_width: 16, frame_height: 20}}],
  };
  const journal = mount(QuestJournal, {global});
  const hud = mount(GameHUD, {global});
  expect(journal.get(".journal-goal").text()).toBe("拜访林老师，完成客观题练习（1/2）");
  expect(journal.get(".town-secondary").text()).toBe("前往林老师");
  expect(hud.get(".quest-next").text()).toContain("拜访林老师");
  await journal.get(".town-secondary").trigger("click");
  expect(session.navigationTarget).toBe("professor");

  const before = session.taskChapters;
  const after: TaskChapter[] = JSON.parse(JSON.stringify(before));
  after[1]!.tasks[0]!.completed = true;
  after[1]!.tasks[1]!.locked = false;
  expect(farewell(before, after, "reading", session.world.npcs)).toContain("接下来可以去找林老师了");
  journal.unmount();
  hud.unmount();
});
