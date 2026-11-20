"""Build the town's reusable introductions, chapter tasks and free conversations."""

from app.teaching.quick_template.itinerary import SIGNPOST_ID, STAGES
from app.teaching.quick_template.ordinary_dialogue import ORDINARY_VISITS
from app.teaching.quick_template.town_dialogue import chapter_ending, choice, line, mayor_introduction, route, stage_dialogue, variations
from app.teaching.world.rules import reachable_cells


# The building names here match the map legend and the directions spoken by the cast.
ROOMS = {
    "lesson": ("图书管理员", "图书馆", "library", "librarian_doc", 6, "照看馆内资料，耐心地陪学生阅读。"),
    "practice": ("练习场教练", "练习会馆", "arena", "arena_guard", 4, "陪学生动手尝试，鼓励他们利用题目反馈继续练习。"),
    "assessment": ("镇长", "镇长大厅", "mayor_hall", "mayor_py", 2, "接待来镇上学习的学生，主持测验，陪学生回顾所学。"),
}


def town_cast(existing):
    managed = {stage.npc_id for stage in STAGES.values()}
    others = [p["placement"] for p in existing if p["id"] not in managed and p["placement"]]
    result = []
    for kind, (name, _, room, portrait, sprite, persona) in ROOMS.items():
        occupied = {(p["tile_x"], p["tile_y"]) for p in others if p["map_key"] == room}
        free = reachable_cells(room) - occupied
        if not free:
            raise ValueError(f"{name}所在的房间没有可放置角色的位置")
        x, y = min(free, key=lambda p: (abs(p[0] - 9) + abs(p[1] - 5), p))
        result.append({"id": STAGES[kind].npc_id, "name": name, "persona": persona,
                       "portrait": f"builtin:portrait:{portrait}", "sprite": f"builtin:sprite:chara_{sprite}",
                       "placement": {"map_key": room, "tile_x": x, "tile_y": y, "direction": "down"},
                       "appearance_condition": {"always": True}})
    return result


DAILY_CHAT = {
    "lesson": ("我给常读的书夹了张纸条，今天翻开才发现，纸条上只写着「别忘了」。这下我得重新想想，到底别忘了什么。",
               "你来得正好，{name}。馆里安静下来时，连翻页的声音都听得清。你喜欢这样的地方，还是热闹一点的？",
               "有人习惯从第一页读起，我有时先翻目录，挑个顺眼的标题。你呢？架上的资料可以随你翻。"),
    "practice": ("刚收好桌上的纸，我自己又抽了一张出来。忽然想到个想试的法子，怕转身就忘，得先写下来。",
                 "嗨，{name}，来坐会儿？镇长说我讲话太像带练习，连叫人喝口水都爱说「我们先试一口」。",
                 "把椅子往里挪一挪，这里就多出个舒服的位置了。今天只是路过也好，歇够了再走。"),
    "assessment": ("我今天给馆员送回一支铅笔，回来才发现把自己的那支也落在馆里了。看来待会儿还得去一趟。",
                   "{name}，如果有人第一次来小镇，要你来带路，你最想先带他去哪儿？我总爱先带人去图书馆。",
                   "大厅里最热闹的时候，是大家各自学完、顺路过来坐一坐的时候。你今天也可以坐会儿再走。"),
}


def town_public(*, public_chat=True):
    entries = {f"interaction:{SIGNPOST_ID}": [route("signpost")]}
    nodes = [line("signpost", "镇长大厅在镇子中央偏北，图书馆在西边，练习会馆在东南边。你想看看自己当前的目标吗？",
                  choices=[choice("journal", "打开任务簿", "journal"), choice("leave", "我知道了", "end")]),
             {"id": "journal", "type": "action", "action": "open_workspace", "workspace": "journal", "next": "end"}]
    for kind, texts in DAILY_CHAT.items():
        node = f"chat-{kind}" if public_chat else "directions"
        entries[STAGES[kind].npc_id] = [route(node)]
        if public_chat:
            nodes.extend(variations(node, texts))
    if not public_chat:
        nodes.append(line("directions", "可以打开任务簿查看学习安排。想自己找资料，图书馆里的书架随时能翻。"))
    return {"id": "quick-course-directions", "quest_id": None, "chapter_id": None,
            "content": {"schema_version": 1, "mode": "public", "title": "小镇日常" if public_chat else "小镇指路", "entries": entries,
                        "bindings": {}, "nodes": [*nodes, {"id": "end", "type": "end"}]}}


def town_farewell(chapter_id, quest_id, *, public_chat=True):
    replies = {
        "lesson": ("回来看书啦，{name}？《{course_name}》已经读到最后一章，你在馆里也算是老读者了。给你留着位置呢。",
                   "以后怎么挑资料？", "先想一个你真想弄明白的问题。带着它去翻目录，找到能帮上忙的那一页，再慢慢读。"),
        "practice": ("来跟我道个别？这门课的练习咱们已经做完了。哪天你自己琢磨出个有意思的做法，欢迎再回来。",
                     "以后怎么自己练？", "挑一道你做过的题，先把条件换一点，猜猜结果。再亲手试一遍，看看跟你想的差在哪儿。"),
        "assessment": ("{name}，又见面啦。《{course_name}》的最后一张卷子已经交过了。今天来坐坐，我一样高兴。",
                       "离开前，再给我一句建议吧。", "挑一个你愿意讲给朋友听的收获。讲着讲着，如果碰上了新的问题，就把它记下来，等下次找答案。"),
    }
    entries, nodes = {}, []
    for kind, (greeting, question, answer) in replies.items():
        key = f"farewell-{kind}"
        entries[STAGES[kind].npc_id] = [route(key)]
        options = [choice("advice", question, key + "-advice"), choice("leave", "回头见", "end")]
        if public_chat:
            options.insert(1, choice("chat", "聊聊镇上的近况", "chat-" + kind))
            nodes.extend(variations("chat-" + kind, DAILY_CHAT[kind]))
        nodes.extend([line(key, greeting, choices=options), line(key + "-advice", answer)])
    return {"id": quest_id + "-farewell", "quest_id": None, "chapter_id": chapter_id,
            "content": {"schema_version": 1, "mode": "public", "title": "结课后的小镇", "priority": -1,
                        "when": {"quest": {"id": quest_id, "status": "complete"}},
                        "entries": entries, "bindings": {}, "nodes": [*nodes, {"id": "end", "type": "end"}]}}


def _chapter_task(chapter, prefix, first):
    goals, bindings = [], {}
    story = f"{prefix}-journey"
    quest_id = f"{prefix}-quest"

    def add(key, title, kind, *, visit=False):
        npc = STAGES[kind].npc_id
        goal = {"id": key, "title": title, "target": npc, "navigation_target": npc,
                "dependencies": [goals[-1]["id"]] if goals else []}
        if visit:
            goal.update(type="PLAY_DIALOGUE", dialogue_id=f"story:{story}:{key}")
        else:
            goal.update(type=STAGES[kind].goal_type, activity_id=f"{prefix}-{kind}")
            bindings[kind] = {"goal_id": key, "activity_id": goal["activity_id"]}
        goals.append(goal)

    add("welcome", "前往镇长大厅，拜访镇长" if first else "回到镇长大厅，领取本章学习安排", "assessment", visit=True)
    add("meet-lesson", "进入图书馆，认识图书管理员" if first else "到图书馆领取本章资料", "lesson", visit=True)
    add("lesson", "完成本章资料阅读", "lesson")
    add("meet-practice", "前往练习会馆，认识练习场教练" if first else "到练习会馆找教练领取本章练习", "practice", visit=True)
    add("practice", "完成本章知识点练习", "practice")
    add("meet-assessment", "回到镇长大厅，向镇长领取测验", "assessment", visit=True)
    add("assessment", "完成本章测验并交卷", "assessment")
    add("report", "听取镇长的章节总结", "assessment", visit=True)
    title = f"{chapter['title']} · 小镇研习"[:200]
    return {"id": quest_id, "title": title, "chapter_id": chapter["id"],
            "definition": {"id": quest_id, "chapter_id": chapter["id"], "kind": "main", "title": title, "nodes": goals, "effects": []}}, bindings


def _visiting_between_tasks(chapter, first, prefix, position):
    """An in-progress chapter has its own directions when visiting a different role."""
    quest_id = f"{prefix}-quest"

    def complete(goal):
        return {"goal": {"quest_id": quest_id, "id": goal, "status": "complete"}}

    entries = {
        STAGES["lesson"].npc_id: [route("read-before-quiz", **complete("practice")), route("read-again", **complete("lesson")), route("wait-for-mayor")],
        STAGES["practice"].npc_id: [route("practice-finished", **complete("practice")), route("wait-for-reading", **complete("welcome")),
                                    route("wait-for-mayor")],
        STAGES["assessment"].npc_id: [route("go-to-coach", **complete("lesson")), route("go-to-library")],
    }
    nodes = [line("read-before-quiz", "要在测验前复习一下《{chapter_name}》吗？课件就在书架上，想看哪一页都可以。"),
             line("read-again", "《{chapter_name}》的资料已经读过一遍了。想回头找某一页，可以翻这里的书架。要做练习，就去东南边的练习会馆。"),
             line("practice-finished", "你已经完成这章的练习了。想参加测验，去镇长大厅找镇长；想先复习，可以回图书馆。"),
             line("wait-for-mayor", "初次来镇里吗？先到镇子中央偏北的镇长大厅报个到，镇长会跟你说说学习安排。"),
             line("wait-for-reading", "你的练习我会备好。先去西边的图书馆读本章资料，读完了我们再见。"),
             line("go-to-coach", "这章的阅读已经完成了。教练在东南边的练习会馆等你，练习做完后再回来找我。"),
             line("go-to-library", "图书管理员在镇西的图书馆里。她那里有这章的资料。你也可以看看左上角，找找现在要做的事。"),
             {"id": "end", "type": "end"}]
    when = {"quest": {"id": quest_id, "status": "active"}}
    if not first:
        when = {"all": [when, complete("welcome")]}
        # Subsequent chapters only activate their directions after the student accepts.
        entries[STAGES["lesson"].npc_id][-1] = route("go-to-library")
        entries[STAGES["practice"].npc_id][-1] = route("wait-for-reading")
        nodes = [node for node in nodes if node["id"] != "wait-for-mayor"]
    return {"id": f"{prefix}-around-town", "chapter_id": chapter["id"], "quest_id": None,
            "content": {"schema_version": 1, "title": "本章途中 · " + chapter["title"][:190], "mode": "public",
                        "priority": position, "when": when, "bindings": {}, "entries": entries, "nodes": nodes}}


def town_chapter(chapter, following, position, prefix, *, final=False, shelf_tour=True, public_chat=True):
    first = position == 0
    ordinary = ORDINARY_VISITS[(position - 1) % len(ORDINARY_VISITS)] if not first and not final else None
    quest, bindings = _chapter_task(chapter, prefix, first)
    entries = {}
    nodes = mayor_introduction(position, ordinary=ordinary, public_chat=public_chat)
    for kind in ROOMS:
        routes = []
        if kind == "assessment":
            routes.extend([route("welcome-mayor", goal_ready="welcome"), route("done-assessment", goal_ready="report")])
        routes.extend([route(f"resume-{kind}", all=[{"goal_ready": kind}, {"activity_started": kind}]), route(f"ready-{kind}", goal_ready=kind),
                       route(f"invite-{kind}", goal_ready=f"meet-{kind}"), route("directions")])
        entries[STAGES[kind].npc_id] = routes
        nodes.extend(stage_dialogue(kind, position, final=final, ordinary=ordinary, public_chat=public_chat))
    completed_reading = ("这门课最后一章也读完了，{name}。谢谢你来馆里和我一起读书。下一站是练习会馆；往后想找哪一页，书架随时能翻。"
                         if final else "这章读完了。想回顾资料可以随时翻书架；准备好动手时，去练习会馆找教练。")
    if first and shelf_tour:
        tour = "要不要试试自己找资料？看那边的书架，走过去互动，就能翻阅课程资料。"
        completed_reading = (completed_reading + "\n\n" + tour if final else
                             "你把本章的资料都读完了。" + tour + "\n\n有空再试也行。下一站是东南边的练习会馆，教练会陪你练一练。")
    completed_practice = ("咱们把这门课最后一组练习做完了！下次自己动手时，也记得给自己留点尝试的时间。"
                          "镇长在大厅等你做最后的测验，回头见，{name}。" if final else
                          "这一组练习你做完了。准备好了就回镇长大厅，找镇长领取《{chapter_name}》的测验。")
    nodes.extend([line("done-lesson", ordinary.reading.finished if ordinary else completed_reading),
                  line("done-practice", ordinary.practice.finished if ordinary else completed_practice),
                  *chapter_ending(bindings["assessment"]["activity_id"], following, final=final, ordinary=ordinary),
                  line("directions", "看看左上角的任务目标，那里写着现在该做什么。"),
                  line("unavailable", "这项活动暂时打不开，请联系老师查看。"), {"id": "end", "type": "end"}])
    story = {"id": f"{prefix}-journey", "chapter_id": chapter["id"], "quest_id": quest["id"],
             "content": {"schema_version": 1, "mode": "task", "title": quest["title"], "priority": -position,
                         "bindings": bindings, "entries": entries, "nodes": nodes}}
    return quest, story, _visiting_between_tasks(chapter, first, prefix, position)
