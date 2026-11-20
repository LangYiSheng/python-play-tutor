"""Town roles, routes and dialogue for the reading, practice and quiz template."""

from dataclasses import dataclass

from app.teaching.world.rules import reachable_cells


@dataclass(frozen=True)
class Stage:
    npc_id: str
    role: str
    location: str
    label: str
    goal_type: str


# Each role is outdoors so even a newly created course needs no building permissions.
STAGES = {
    "lesson": Stage("quick-course-reader", "导读员", "图书馆门前", "学课件", "STUDY_LESSON"),
    "practice": Stage("quick-course-coach", "练习教练", "东侧练习场", "做练习", "COMPLETE_PRACTICE"),
    "assessment": Stage("quick-course-guide", "课程向导", "南侧广场", "做测验", "PASS_ASSESSMENT"),
}
SIGNPOST_ID = "quick-course-signpost"


def characters(existing, stages):
    roles = {stage.npc_id for stage in STAGES.values()}
    occupied = {
        (row["placement"]["tile_x"], row["placement"]["tile_y"])
        for row in existing
        if row["id"] not in roles and row["placement"] and row["placement"]["map_key"] == "town_hub"
    }
    # Leave the actual library door, spawn and itinerant sign unobstructed.
    occupied.update({(8, 22), (22, 36), (23, 34)})
    anchors = {
        "lesson": (10, 23, "librarian_doc", 5, "善于用提问引导学生阅读课件。"),
        "practice": (38, 25, "arena_guard", 7, "鼓励学生动手练习，留意每次尝试的反馈。"),
        "assessment": (21, 34, "mayor_py", 6, "在广场接待学生，帮助他们回顾所学。"),
    }
    result = []
    for kind, (x, y, portrait, sprite, persona) in anchors.items():
        if kind not in stages:
            continue
        free = reachable_cells("town_hub") - occupied
        px, py = min(free, key=lambda cell: (abs(cell[0] - x) + abs(cell[1] - y), cell))
        occupied.add((px, py))
        stage = STAGES[kind]
        result.append({
            "id": stage.npc_id, "name": stage.role, "persona": persona,
            "portrait": f"builtin:portrait:{portrait}", "sprite": f"builtin:sprite:chara_{sprite}",
            "placement": {"map_key": "town_hub", "tile_x": px, "tile_y": py, "direction": "down"},
            "appearance_condition": {"always": True},
        })
    return result


def signpost():
    return {
        "id": SIGNPOST_ID, "label": "课程路标", "prompt": "查看学习路线", "trigger": "click", "map_key": "town_hub",
        "target": {"region": {"x": 23, "y": 34, "width": 1, "height": 1}},
    }


def public_route(stages):
    entry = [{"when": {"always": True}, "node": "welcome"}]
    directions = "图书馆门前读课件，东侧练习场做练习"
    if "assessment" in stages:
        directions += "，南侧广场做测验"
    return {
        "id": "quick-course-directions", "chapter_id": None, "quest_id": None,
        "content": {
            "schema_version": 1, "title": "小镇学习路线", "mode": "public", "bindings": {},
            "entries": {key: entry for key in [f"interaction:{SIGNPOST_ID}", *(STAGES[kind].npc_id for kind in stages)]},
            "nodes": [
                {"id": "welcome", "type": "dialogue", "text": f"{directions}。想看看你现在该去哪里吗？",
                 "choices": [{"id": "journal", "label": "查看我的任务", "next": "journal"},
                             {"id": "later", "label": "我知道了", "next": "end"}]},
                {"id": "journal", "type": "action", "action": "open_workspace", "workspace": "journal", "next": "end"},
                {"id": "end", "type": "end"},
            ],
        },
    }


def chapter_task(chapter, prefix, stages, *, role_names=None):
    chapter_id = chapter["id"]
    task_title = f"{chapter['title']} · 小镇研习"[:200]
    task_id = f"{prefix}-quest"
    goals, bindings = [], {}
    for i, kind in enumerate(stages):
        stage = STAGES[kind]
        activity_id = f"{prefix}-{kind}"
        role = role_names[kind] if role_names else stage.role
        goals.append({"id": kind, "type": stage.goal_type, "title": f"到{stage.location}找{role}{stage.label}",
                      "target": stage.npc_id, "navigation_target": stage.npc_id, "activity_id": activity_id,
                      "dependencies": [stages[i - 1]] if i else []})
        bindings[kind] = {"goal_id": kind, "activity_id": activity_id}
    quest = {"id": task_id, "title": task_title, "chapter_id": chapter_id,
             "definition": {"id": task_id, "title": task_title, "chapter_id": chapter_id, "kind": "main", "nodes": goals, "effects": []}}
    return quest, bindings


def chapter_journey(chapter, previous, following, topic, position, prefix, stages):
    title = chapter["title"]
    quest, bindings = chapter_task(chapter, prefix, stages)
    welcome = (f"欢迎来到小镇！今天我们一起读《{title}》。"
               if previous is None else f"上次的《{previous['title']}》学得怎么样？这次我们来读《{title}》。")
    invitations = {
        "lesson": welcome + f"翻开课件，先留意「{topic}」。",
        "practice": (f"刚才在课件里见过「{topic}」了吧？现在试着自己解一道题。"
                     if position % 2 == 0 else f"又往前走了一步！这次来练练「{topic}」，看看你的思路能不能用起来。"),
        "assessment": f"欢迎回到广场。《{title}》的练习已经做完了，准备好独立试试了吗？",
    }
    finish = (f"下一站是《{following['title']}》，到图书馆门前找导读员吧。"
              if following else "你走完了这次课程的学习路线！")
    feedback = {
        "lesson": "课件读完了。去东侧练习场找练习教练，把刚才的想法用起来吧。",
        "practice": ("这一组练习完成了！准备好后，去南侧广场找课程向导做测验。"
                     if "assessment" in stages else f"《{title}》的练习完成了。{finish}"),
        "assessment": f"《{title}》的测验完成了。{finish}",
    }
    entries, nodes = {}, []
    for kind in stages:
        stage = STAGES[kind]
        entries[stage.npc_id] = [
            {"when": {"goal_complete": kind}, "node": f"done-{kind}"},
            {"when": {"activity_started": kind}, "node": f"resume-{kind}"},
            {"when": {"goal_ready": kind}, "node": f"invite-{kind}"},
            {"when": {"always": True}, "node": "directions"},
        ]
        choices = [{"id": "start", "label": stage.label, "next": f"open-{kind}"}, {"id": "later", "label": "稍后再来", "next": "end"}]
        nodes.extend([
            {"id": f"invite-{kind}", "type": "dialogue", "text": invitations[kind], "choices": choices},
            {"id": f"resume-{kind}", "type": "dialogue", "text": f"欢迎回来，我们继续《{title}》吧。", "choices": choices},
            {"id": f"open-{kind}", "type": "activity", "binding": kind,
             "returns": {"completed": f"done-{kind}", "suspended": "paused", "unavailable": "unavailable"}},
            {"id": f"done-{kind}", "type": "dialogue", "text": feedback[kind], "next": "end"},
        ])
    nodes.extend([
        {"id": "directions", "type": "dialogue", "text": "打开任务日志，看看下一站该找谁吧。", "next": "end"},
        {"id": "paused", "type": "dialogue", "text": "先歇一会儿吧。准备好再来找我，我们接着学。", "next": "end"},
        {"id": "unavailable", "type": "dialogue", "text": "这项活动暂时打不开，请联系老师查看。", "next": "end"},
        {"id": "end", "type": "end"},
    ])
    story = {"id": f"{prefix}-journey", "chapter_id": chapter["id"], "quest_id": quest["id"],
             "content": {"schema_version": 1, "title": quest["title"], "mode": "task", "priority": -position,
                         "bindings": bindings, "entries": entries, "nodes": nodes}}
    return quest, story
