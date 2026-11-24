"""Run a generated course through normal teacher, game and exchange entry points."""

import io
import json
import zipfile
from uuid import uuid4

import pytest
from pypdf import PdfWriter
from sqlalchemy.orm import sessionmaker

from app.materials import jobs
from conftest import move_player
from test_course_exchange import apply, export, preview


def ok(response):
    assert response.is_success, response.text
    return response.json()


@pytest.fixture
def lesson_plan(client, db, teacher, student, tmp_path, monkeypatch, request):
    monkeypatch.setenv("REBORN_STORAGE_ROOT", str(tmp_path / "media"))
    monkeypatch.setenv("REBORN_COURSE_EXCHANGE_ROOT", str(tmp_path / "packages"))
    monkeypatch.setattr(jobs, "SessionLocal", sessionmaker(db.bind, expire_on_commit=False))
    headers = teacher["headers"]
    course = ok(client.post("/api/teacher/courses", headers=headers, json={"name": "音乐入门"}))
    path = f"/api/teacher/courses/{course['id']}"
    assert ok(client.get(path + "/classrooms", headers=headers)) == []
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=200)
    writer.add_blank_page(width=300, height=200)
    pdf = io.BytesIO()
    writer.write(pdf)
    for index, title in enumerate(["节奏与节拍", "旋律与乐句"]):
        chapter = ok(client.post(path + "/chapters", headers=headers, json={"title": title}))
        point = ok(client.post(path + "/knowledge-points", headers=headers,
                               json={"chapter_id": chapter["id"], "title": title, "content": {"teaching_sample": {
                                   "reading": f"读前想想{title}", "practice": f"练习前想想{title}",
                                   "reflection": f"来讲讲{title}的例子",
                               }}}))
        media = ok(client.post(path + "/materials/upload", headers=headers,
                               data={"title": title, "chapter_ids": json.dumps([chapter["id"]])},
                               files={"file": ("lesson.pdf", pdf.getvalue(), "application/pdf")}))
        jobs.process_material(media["id"])
        for number in range(2):
            ok(client.post(path + "/questions", headers=headers, json={
                "id": f"q-{index}-{number}", "title": title, "prompt": "听音乐时可以跟着打拍子。", "kind": "boolean",
                "answer": True, "source_type": "imported", "status": "ready",
                "chapter_ids": [chapter["id"]], "knowledge_point_ids": [point["id"]],
            }))
    db.expire_all()
    quick = f"{path}/quick-orchestration"
    catalog = ok(client.get(quick, headers=headers))
    selections = [{
        "chapter_id": row["id"], "knowledge_point_ids": [point["id"] for point in row["knowledge_points"]],
        "material_ids": [material["id"] for material in row["materials"] if material["available"]],
    } for row in catalog["chapters"]]
    recipe = {"template_id": "learn-practice-quiz", "chapters": selections, "practice_count": 1, "quiz_count": 1}
    if getattr(request, "param", None) == "ongoing":
        recipe.update(start_chapter_id=selections[0]["chapter_id"], final_chapter_id=None, feature_ids=[])
    elif getattr(request, "param", None):
        recipe["dialogue_style"] = request.param
    body = {"recipe": recipe, "expected_revision": catalog["revision"]}
    planned = ok(client.post(quick + "/preview", headers=headers, json=body))
    assert not planned["blockers"], planned
    assert "镇长" in planned["welcome_dialogue"] and "音乐入门" in planned["welcome_dialogue"]
    assert "{name}" not in planned["welcome_dialogue"]
    assert [len(row["goals"]) for row in planned["quests"] if row["kind"] == "main"] == [8, 8]
    ok(client.post(quick + "/apply", headers=headers, json={**body, "token": planned["token"]}))
    chapter_ids = ok(client.get(path + "/ids", headers=headers))["chapter"]
    classroom = ok(client.post(path + "/classrooms", headers=headers, json={"name": "音乐体验班"}))
    cid = classroom["id"]
    ok(client.post("/api/classrooms/join", headers=student["headers"], json={"join_code": classroom["join_code"]}))
    assert ok(client.get(f"/api/teacher/classrooms/{cid}/releases", headers=headers)) == []
    for chapter_id in chapter_ids.values():
        ok(client.put(f"/api/teacher/classrooms/{cid}/releases/{chapter_id}", headers=headers, json={"status": "published"}))
    return cid, course['id'], recipe


def test_student_visits_the_town_and_completes_both_chapters(client, db, student, teacher, lesson_plan):
    from app.integration_models import AssistantCall
    from app.models import Npc
    from app.world_config import load_world_config
    from sqlalchemy import select

    cid, course_id, recipe = lesson_plan
    headers, params = {**student["headers"], "X-Dialogue-Format": "template"}, {"classroom_id": cid}
    actor = ok(client.get("/api/auth/me", headers=headers))
    classrooms = ok(client.get("/api/classrooms", headers=headers))
    assert actor["name"] == "学生" and next(row["course_name"] for row in classrooms if row["id"] == cid) == "音乐入门"
    maps = ok(client.get(f"/api/teacher/courses/{course_id}/ids", headers=teacher["headers"]))

    def world():
        return ok(client.get("/api/world", params=params, headers=headers))

    def step(view, action="advance", **fields):
        return ok(client.post(f"/api/story/sessions/{view['id']}/{action}", headers=headers, json={
            **params, "event_id": str(uuid4()), "revision": view["revision"], **fields,
        }))

    def read_to_choice_or_exit(view):
        for _ in range(12):
            if view["status"] != "active" or view["node"].get("choices"):
                return view
            view = step(view)
        pytest.fail("Dialogue did not reach a choice or exit")

    def meet(role):
        npc = db.get(Npc, maps["npc"]["quick-course-" + role])
        # Each room connects to the square. Use its real exit before traversing to another room.
        current = world()["player"]["map_key"]
        if current not in ("town_hub", npc.map_key):
            spawn = load_world_config()["default_spawn"]
            move_player(client, headers, cid, "town_hub", spawn["tile_x"], spawn["tile_y"])
        move_player(client, headers, cid, npc.map_key, npc.tile_x, npc.tile_y)
        return ok(client.post("/api/story/interactions", headers=headers, json={**params, "npc_key": npc.key}))

    ordered = [maps["chapter"][row["chapter_id"]] for row in recipe["chapters"]]
    initial = world()
    assert {npc["name"] for npc in initial["npcs"]} == {"镇长", "图书管理员", "练习场教练"}
    assert [q["chapter_id"] for q in initial["quests"]] == [ordered[0]]
    goals = initial["quests"][0]["nodes"]
    assert [n["id"] for n in goals if n["status"] == "ready"] == ["welcome"]
    assert len(goals) == 8
    early = meet("reader")
    assert "镇长" in early["node"]["text"]
    assert read_to_choice_or_exit(early)["status"] == "ended"
    def visit_shelf():
        move_player(client, headers, cid, "library", 15, 8)
        visit = ok(client.post("/api/story/interactions", headers=headers, json={**params, "interaction_id": "library_shelf"}))
        assert visit["node"]["action"] == "open_workspace" and visit["node"]["workspace"] == "library"
        return visit

    browse = step(visit_shelf())
    assert browse["status"] == "ended" and all(q["kind"] != "side" for q in browse["world"]["quests"])
    assert [row["title"] for row in ok(client.get("/api/library", params=params, headers=headers))] == ["节奏与节拍"]

    for index, chapter_id in enumerate(ordered):
        mayor = meet("guide")
        assert mayor["chapter_id"] == chapter_id
        assert mayor["node"]["id"] == "welcome-mayor" and "{name}" in mayor["node"]["text"]
        legacy = ok(client.get("/api/story/current", params=params, headers=student["headers"]))
        assert legacy["id"] == mayor["id"] and "chapter_id" not in legacy and "学生" in legacy["node"]["text"]
        if index == 0:
            assert "{course_name}" in mayor["node"]["text"] and "音乐入门" in legacy["node"]["text"]
        else:
            assert "{chapter_name}" in mayor["node"]["text"] and "旋律与乐句" in legacy["node"]["text"]
            rest = step(mayor, choice="later")
            assert read_to_choice_or_exit(rest)["status"] == "ended"
            assert read_to_choice_or_exit(meet("reader"))["status"] == "ended"
            mayor = step(meet("guide"), choice="begin")
        ask = step(read_to_choice_or_exit(mayor), choice="where")
        assert "图书馆" in ask["node"]["text"] and "西" in ask["node"]["text"]
        farewell = step(read_to_choice_or_exit(ask), choice="leave")
        assert read_to_choice_or_exit(farewell)["status"] == "ended"

        for role, kind in [("reader", "lesson"), ("coach", "practice"), ("guide", "assessment")]:
            invite = read_to_choice_or_exit(meet(role))
            assert invite["node"]["id"] == f"invite-{kind}"
            if index == 0 and kind == "lesson":
                assert "{chapter_name}" in invite["node"]["text"]
                assert next(ch["title"] for ch in invite["world"]["chapters"] if ch["id"] == invite["chapter_id"]) == "节奏与节拍"
                assert read_to_choice_or_exit(step(invite, choice="later"))["status"] == "ended"
                invite = meet(role)
                assert invite["node"]["id"].startswith("ready-lesson-")
            activity_view = read_to_choice_or_exit(step(invite, choice="start"))
            assert activity_view["status"] == "waiting" and activity_view["activity"]["kind"] == kind
            activity = activity_view["activity"]["id"]
            detail = ok(client.get(f"/api/activities/{activity}", params=params, headers=headers))
            if kind == "lesson":
                for row in detail["resources"]:
                    material = row["material"]
                    for page in material["pages"]:
                        ok(client.post(f"/api/activities/{activity}/progress", headers=headers, json={
                            **params, "material_id": material["id"], "page_no": page["page_no"],
                        }))
                        if index == 0 and page["page_no"] == 1:
                            paused = step(activity_view, "return")
                            assert paused["node"]["id"] == "paused-lesson"
                            assert read_to_choice_or_exit(paused)["status"] == "ended"
                            resume = meet(role)
                            assert resume["node"]["id"].startswith("resume-lesson-")
                            activity_view = read_to_choice_or_exit(step(resume, choice="start"))
                            assert activity_view["activity"]["id"] == activity
            elif kind == "practice":
                question = detail["questions"][0]
                receipt = ok(client.post("/api/submissions", headers=headers, json={
                    **params, "activity_id": activity, "question_id": question["id"], "answer": True, "idempotency_key": str(uuid4()),
                }))
                assert receipt["status"] == "accepted"
            else:
                paper = ok(client.get(f"/api/activities/{activity}/assessment", params=params, headers=headers))
                result = ok(client.post(f"/api/activities/{activity}/assessment/submit", headers=headers, json={
                    **params, "idempotency_key": str(uuid4()), "answers": [{"question_id": q, "answer": bool(index)} for q in paper["question_ids"]],
                }))
                assert result["completed"] and result["score"] == 100 * index
            finished = step(activity_view, "return")
            assert finished["node"]["id"] == f"done-{kind}" and finished["chapter_id"] == chapter_id
            if kind == "assessment":
                feedback = step(finished)
                assert feedback["node"]["id"] == ("score-all" if index else "score-review")
                report = read_to_choice_or_exit(feedback)
                assert report["node"]["id"] == "report"
                assert step(report, choice="break")["status"] == "ended"
            else:
                assert read_to_choice_or_exit(finished)["status"] == "ended"

        quests = world()["quests"]
        assert next(q for q in quests if q["chapter_id"] == chapter_id and q["kind"] == "main")["status"] == "complete"
        # Finishing the optional shelf tour is not a prerequisite for chapter two.
        assert any(q["kind"] == "side" and q["status"] != "complete" for q in quests)
        during_break = meet("coach")
        assert during_break["mode"] == "public"
        if index == len(ordered) - 1:
            assert during_break["node"]["id"] == "farewell-practice"
            during_break = step(during_break, choice="leave")
        else:
            assert during_break["node"]["id"].startswith("chat-practice-")
        assert read_to_choice_or_exit(during_break)["status"] == "ended"
    move_player(client, headers, cid, "town_hub", 8, 22)
    visit = visit_shelf()
    tour = next(q for q in visit["world"]["quests"] if q["kind"] == "side")
    assert tour["status"] == "active"
    fake = client.post("/api/events", headers=headers, json={
        **params, "quest_id": tour["id"], "node_id": "open-shelf", "event_id": str(uuid4()),
        "evidence": {"object_id": "library_shelf", "workspace": "library"},
    })
    assert fake.status_code == 422
    request = {**params, "revision": visit["revision"], "event_id": str(uuid4())}
    for _ in range(2):
        response = ok(client.post(f"/api/story/sessions/{visit['id']}/advance", headers=headers, json=request))
        assert response["status"] == "ended"
        assert next(q for q in response["world"]["quests"] if q["id"] == tour["id"])["status"] == "complete"
    assert len(ok(client.get("/api/library", params=params, headers=headers))) == 2
    assert db.scalar(select(AssistantCall.id).limit(1)) is None


def test_quick_preview_renders_the_saved_custom_finale(client, teacher, lesson_plan):
    cid, course_id, recipe = lesson_plan
    headers = teacher["headers"]
    path = f"/api/teacher/courses/{course_id}"
    native = ok(client.get(path + "/authoring", headers=headers))
    last = recipe["chapters"][-1]["chapter_id"]
    flow = next(row for row in native["flows"] if row["chapter_id"] == last and row["quest_id"])
    report = next(node for node in flow["content"]["nodes"] if node["id"] == "report")
    report["text"] = "{name}，你学到了《{course_name}》的最后一章《{chapter_name}》。我们回头见。"
    update = ok(client.put(path + "/authoring", headers=headers, json={
        "expected_revision": native["revision"], **{key: native[key] for key in ("quests", "flows", "npcs", "configuration")},
    }))
    view = ok(client.post(path + "/quick-orchestration/preview", headers=headers, json={
        "expected_revision": update["revision"], "recipe": recipe,
    }))
    assert not view["blockers"], view
    assert view["closing_dialogue"] == "同学，你学到了《音乐入门》的最后一章《旋律与乐句》。我们回头见。"


@pytest.mark.parametrize("lesson_plan", [None, "teaching-sample", "ongoing"], indirect=True)
def test_imported_plan_can_switch_templates_without_duplicating_definitions(client, db, teacher, lesson_plan):
    from app.course_instances import classroom_course

    cid, course_id, recipe = lesson_plan
    headers = teacher["headers"]
    quick = f"/api/teacher/courses/{course_id}/quick-orchestration"
    first, second = recipe["chapters"]
    first["question_plan"] = {"practice": {"mode": "by_point", "points": [{
        "knowledge_point_id": first["knowledge_point_ids"][0], "count": 2, "by_kind": {"boolean": 2},
    }]}}
    second["question_plan"] = {"practice": {"mode": "total", "count": 1}, "assessment": {"mode": "total", "count": 2, "by_kind": {"boolean": 2}}}
    update = {"recipe": recipe, "expected_revision": ok(client.get(quick, headers=headers))["revision"]}
    checked = ok(client.post(quick + "/preview", headers=headers, json=update))
    assert not checked["blockers"], checked
    assert [(row["practice"]["count"], row["assessment"]["count"]) for row in checked["papers"]] == [(2, 1), (1, 2)]
    ok(client.post(quick + "/apply", headers=headers, json={**update, "token": checked["token"]}))
    source_editor = f"/api/teacher/courses/{course_id}/authoring"
    original = ok(client.get(source_editor, headers=headers))
    next(npc for npc in original["npcs"] if npc["id"] == "quick-course-reader")["name"] = "林老师"
    ok(client.put(source_editor, headers=headers, json={
        "expected_revision": original["revision"], **{key: original[key] for key in ("quests", "flows", "npcs", "configuration")},
    }))
    target = ok(client.post("/api/teacher/courses", headers=headers, json={"name": "隔壁班"}))["id"]
    package = export(client, teacher, classroom_course(db, cid))
    has_tour = "library_shelf_tour" in recipe.get("feature_ids", ["library_shelf_tour"])
    with zipfile.ZipFile(io.BytesIO(package)) as archive:
        assert len([p for p in archive.namelist() if p.startswith("world/quests/")]) == int(has_tour)
    planned = preview(client, teacher, target, package)
    assert planned["diff"]["quick_orchestration"]["added"]
    ok(apply(client, teacher, target, planned))
    path = f"/api/teacher/courses/{target}/quick-orchestration"
    catalog = ok(client.get(path, headers=headers))
    assert catalog["recipe"] == recipe
    restored = ok(client.post(path + "/preview", headers=headers, json={"expected_revision": catalog["revision"], "recipe": recipe}))
    assert restored["blockers"] == [] and restored["changes"] == {"added": 0, "updated": 0, "removed": 0}
    assert "音乐入门" in restored["welcome_dialogue"]
    assert [q["chapter_id"] for q in restored["quests"] if q["kind"] == "side"] == ([None] if has_tour else [])
    from copy import deepcopy

    shorter = deepcopy(recipe)
    for key in ("start_chapter_id", "final_chapter_id", "feature_ids"):
        shorter.pop(key, None)
    shorter.update(template_id="learn-practice", quiz_count=0)
    del shorter["chapters"][1]["question_plan"]["assessment"]
    body = {"expected_revision": catalog["revision"], "recipe": shorter}
    changed = ok(client.post(path + "/preview", headers=headers, json=body))
    # Switching to the historical outdoor route also changes the reader's placement.
    # An independent edit to that same NPC must be explicitly reconciled first.
    if changed["blockers"]:
        assert all("林老师" in reason for reason in changed["blockers"])
        target_editor = f"/api/teacher/courses/{target}/authoring"
        live = ok(client.get(target_editor, headers=headers))
        next(npc for npc in live["npcs"] if npc["id"] == "quick-course-reader")["name"] = "图书管理员"
        result = ok(client.put(target_editor, headers=headers, json={
            "expected_revision": live["revision"], **{key: live[key] for key in ("quests", "flows", "npcs", "configuration")},
        }))
        body["expected_revision"] = result["revision"]
        changed = ok(client.post(path + "/preview", headers=headers, json=body))
    assert not changed["blockers"], changed
    assert [row["practice"]["count"] for row in changed["papers"]] == [2, 1]
    assert all("assessment" not in row for row in changed["papers"])
    ok(client.post(path + "/apply", headers=headers, json={**body, "token": changed["token"]}))
    native = ok(client.get(f"/api/teacher/courses/{target}/authoring", headers=headers))
    assert len(native["quests"]) == 2 and {row["kind"] for row in native["catalog"]["activities"]} == {"lesson", "practice"}
    assert ok(client.get(f"/api/teacher/courses/{course_id}/quick-orchestration", headers=headers))["recipe"] == recipe
