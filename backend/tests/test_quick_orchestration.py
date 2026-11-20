from copy import deepcopy
from uuid import uuid4

import pytest
from sqlalchemy import event, select

from app.content_relations import set_material_chapters, set_question_chapters, set_question_knowledge_points
from app.course_content.presentation import progress_payload
from app.models import (
    Activity, ActivityProgress, AssessmentAttempt, Chapter, ChapterRelease, Classroom, CourseInstance, KnowledgePoint,
    LearningRecord, Material, Membership, Npc, PlayerQuest, Question, QuestDefinition, StoryDefinition, Submission, User,
)


@pytest.fixture
def course(db, teacher, student):
    classroom = Classroom(name="模板测试", join_code=uuid4().hex[:24], teacher_id=teacher["id"])
    db.add(classroom)
    db.flush()
    instance = CourseInstance(classroom_id=classroom.id, package_id="quick-test", name="选课", package_version="1")
    db.add(instance)
    db.add(Membership(user_id=student["id"], classroom_id=classroom.id))
    db.flush()
    fields = {"owner_id": teacher["id"], "course_instance_id": instance.id}
    selections = []
    for order, key in enumerate(("one", "two"), 1):
        chapter = Chapter(stable_id=key, title=f"第{order}章", order_index=order, **fields)
        db.add(chapter)
        db.flush()
        point = KnowledgePoint(stable_id=key+"-point", chapter_id=chapter.id, title="变量", **fields)
        material = Material(stable_id=key+"-slides", title="课件", kind="presentation", storage_key="private/file.pptx", status="ready",
                            content={"pages": [{"id": order, "page_no": 1}], "preview_key": "private/preview.pdf"}, **fields)
        db.add_all([point, material])
        db.flush()
        set_material_chapters(db, material.id, [chapter.id])
        for i in range(3):
            stable = f"{key}-{i}"
            q = Question(id="runtime-"+stable, stable_id=stable, kind="single_choice", title="选择", prompt="选择一个", status="ready", **fields)
            db.add(q)
            db.flush()
            set_question_chapters(db, q.id, [chapter.id])
            set_question_knowledge_points(db, q.id, [point.id])
        selections.append({"chapter_id": key, "material_ids": [material.stable_id], "knowledge_point_ids": [point.stable_id]})
    db.commit()
    url = f"/api/teacher/classrooms/{classroom.id}/quick-orchestration"
    recipe = {"template_id": "learn-practice-quiz", "chapters": selections, "practice_count": 1, "quiz_count": 1}
    return url, {"expected_revision": instance.revision, "recipe": recipe}, instance


def generate(client, teacher, url, body):
    kwargs = {"headers": teacher["headers"], "json": body}
    result = client.post(url+"/preview", **kwargs)
    assert result.status_code == 200, result.text
    result = result.json()
    assert result["token"] and not result["blockers"], result
    request = {**body, "token": result["token"]}
    applied = client.post(url+"/apply", headers=teacher["headers"], json=request)
    assert applied.status_code == 200, applied.text
    return applied.json()["revision"], request, result


def test_bank_counts_respect_chapter_review_status_and_practice_samples(client, db, teacher, course):
    url, draft, _ = course
    db.get(Question, "runtime-one-0").status = "draft"
    db.get(Question, "runtime-one-1").kind = "python"
    sampled = db.get(Question, "runtime-one-2")
    sampled.kind, sampled.samples = "python", [{"input": "1", "output": "1"}]
    other = db.get(Question, "runtime-two-0")
    point = db.scalar(select(KnowledgePoint).where(KnowledgePoint.stable_id == "one-point"))
    set_question_knowledge_points(db, other.id, [point.id])
    db.commit()

    catalog = client.get(url, headers=teacher["headers"]).json()
    first, second = [row["knowledge_points"][0]["available_questions"] for row in catalog["chapters"]]
    assert first == {"practice": {"python": 1}, "assessment": {"python": 2}}
    assert second == {"practice": {"single_choice": 2}, "assessment": {"single_choice": 2}}
    checked = client.post(url + "/preview", headers=teacher["headers"], json=draft).json()
    assert not checked["blockers"]
    assert checked["papers"] == [
        {"chapter_id": key, "practice": {"count": 1, "by_kind": {}, "individual": True, "point_counts": {key + "-point": 1}}, "assessment": {"count": 1, "by_kind": {kind: 1}}}
        for key, kind in (("one", "python"), ("two", "single_choice"))
    ]


def test_preview_lists_shortages_across_chapters_and_stages(client, teacher, course):
    url, draft, _ = course
    draft["recipe"].update(practice_count=4, quiz_count=5)
    for selection in draft["recipe"]["chapters"]:
        selection["question_plan"] = {"practice": {"mode": "total", "count": 4}, "assessment": {"mode": "total", "count": 5}}
    result = client.post(url + "/preview", headers=teacher["headers"], json=draft).json()
    assert result["token"] is None and result["papers"] == []
    assert result["adjustments"] == []
    assert len(result["blockers"]) == 4
    for chapter in ("第1章", "第2章"):
        for stage in ("练习", "测验"):
            assert any(chapter in message and stage in message for message in result["blockers"])


def test_interactive_stock_and_generated_questions_follow_the_stage(client, db, teacher, course):
    url, draft, _ = course
    interactive = db.get(Question, "runtime-one-0")
    interactive.kind = "interactive"
    db.commit()
    stock = client.get(url, headers=teacher["headers"]).json()["chapters"][0]["knowledge_points"][0]["available_questions"]
    assert stock == {"practice": {"single_choice": 2, "interactive": 1}, "assessment": {"single_choice": 2}}
    draft["recipe"].update(practice_count=3, quiz_count=3)
    draft["recipe"]["chapters"][0]["question_plan"] = {"practice": {"mode": "total", "count": 3, "by_kind": {"interactive": 1}}}
    _, _, result = generate(client, teacher, url, draft)
    practice, quiz = result["papers"][0]["practice"], result["papers"][0]["assessment"]
    assert practice["individual"] and practice["count"] == 3
    assert quiz == {"count": 2, "by_kind": {"single_choice": 2}}
    assert result["adjustments"] == [{"chapter_id": "one", "stage": "assessment", "requested": 3, "effective": 2}]


def test_generation_caps_inherited_counts_and_keeps_targets_for_later(client, db, teacher, course):
    url, draft, _ = course
    draft["recipe"].update(practice_count=4, quiz_count=5)
    revision, _, result = generate(client, teacher, url, draft)
    assert result["adjustments"] == [
        {"chapter_id": chapter, "stage": stage, "requested": target, "effective": 3}
        for chapter in ("one", "two") for stage, target in (("practice", 4), ("assessment", 5))
    ]
    assert all(row["practice"]["individual"] and row["practice"]["count"] == row["assessment"]["count"] == 3
               for row in result["papers"])
    headers = teacher["headers"]
    assert client.get(url, headers=headers).json()["recipe"] == draft["recipe"]
    draft["expected_revision"] = revision
    repeated = client.post(url + "/preview", headers=headers, json=draft).json()
    assert repeated["changes"] == {"added": 0, "updated": 0, "removed": 0}
    assert repeated["adjustments"] == result["adjustments"]

    existing = db.get(Question, "runtime-one-0")
    chapter = db.scalar(select(Chapter).where(Chapter.stable_id == "one", Chapter.course_instance_id == existing.course_instance_id))
    point = db.scalar(select(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter.id))
    extra = Question(id="runtime-one-extra", stable_id="one-extra", kind="single_choice", title="新增", prompt="选择一个",
                     status="ready", owner_id=existing.owner_id, course_instance_id=existing.course_instance_id)
    db.add(extra)
    db.flush()
    set_question_chapters(db, extra.id, [chapter.id])
    set_question_knowledge_points(db, extra.id, [point.id])
    db.commit()
    _, _, updated = generate(client, teacher, url, draft)
    assert updated["papers"][0]["practice"]["count"] == updated["papers"][0]["assessment"]["count"] == 4
    assert [item for item in updated["adjustments"] if item["chapter_id"] == "one"] == [
        {"chapter_id": "one", "stage": "assessment", "requested": 5, "effective": 4}
    ]


def test_manual_shortage_preserves_other_inherited_adjustments(client, teacher, course):
    url, draft, _ = course
    draft["recipe"].update(practice_count=4, quiz_count=5)
    draft["recipe"]["chapters"][0]["question_plan"] = {"practice": {"mode": "total", "count": 4}}
    result = client.post(url + "/preview", headers=teacher["headers"], json=draft).json()
    assert result["token"] is None and len(result["blockers"]) == 1
    assert "第1章" in result["blockers"][0] and "还缺 1 道" in result["blockers"][0]
    assert [(row["chapter_id"], row["stage"]) for row in result["adjustments"]] == [
        ("one", "assessment"), ("two", "practice"), ("two", "assessment")
    ]


def test_preview_snapshot_batches_question_links_and_omits_answers(db, course):
    from app.course_content.snapshot import snapshot_content

    _, _, instance = course
    connection = db.connection()
    statements = []

    def capture(_conn, _cursor, statement, _params, _context, _many):
        statements.append(statement.lower())

    event.listen(connection, "before_cursor_execute", capture)
    try:
        data, secrets, *_ = snapshot_content(db, instance, include_secrets=False)
    finally:
        event.remove(connection, "before_cursor_execute", capture)
    assert len(data["question"]) == 6 and all(row["chapter_ids"] and row["knowledge_point_ids"] for row in data["question"])
    for table in ("question_chapters", "question_knowledge_points"):
        assert sum(table in statement for statement in statements) == 1
    assert not secrets and not any("question_secrets" in statement for statement in statements)


def test_preview_reports_advanced_edits_to_fixed_and_individual_practice(client, db, teacher, course):
    from app.content_relations import set_activity_questions

    url, draft, instance = course
    draft["recipe"]["practice_count"] = 4
    draft["expected_revision"], _, _ = generate(client, teacher, url, draft)
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance.id, Chapter.stable_id == "one"))
    practice = db.scalar(select(Activity).where(Activity.chapter_id == chapter.id, Activity.kind == "practice"))
    practice.content = {key: value for key, value in practice.content.items() if key != "practice_rules"}
    set_activity_questions(db, practice, ["runtime-one-2", "runtime-one-1"])
    db.commit()
    checked = client.post(url + "/preview", headers=teacher["headers"], json=draft).json()
    assert not checked["blockers"]
    assert checked["papers"][0]["practice"] == {"count": 2, "by_kind": {"single_choice": 2}}
    assert checked["adjustments"] == [{"chapter_id": "two", "stage": "practice", "requested": 4, "effective": 3}]
    point = db.scalar(select(KnowledgePoint).where(KnowledgePoint.chapter_id == chapter.id))
    set_activity_questions(db, practice, [])
    practice.content = {**practice.content, "practice_rules": {"goals": [
        {"knowledge_point_id": point.id, "total": 1, "by_kind": {"single_choice": 2}},
    ]}}
    db.commit()
    checked = client.post(url + "/preview", headers=teacher["headers"], json=draft).json()
    assert not checked["blockers"]
    assert checked["papers"][0]["practice"] == {"count": 2, "by_kind": {}, "individual": True, "point_counts": {"one-point": 2}}


def test_native_content_repeat_and_reorder(client, db, teacher, student, course):
    url, draft, instance = course
    headers = teacher["headers"]
    editor = client.get(url, headers=headers).json()
    [full] = editor["templates"]
    features = full.pop("features")
    assert [option["id"] for option in features] == ["public_chat", "library_shelf_tour"]
    assert all(option["title"] and option["description"] and option["default_enabled"] for option in features)
    assert full == {"id": "learn-practice-quiz", "title": "学课件、做练习、做测验", "stages": [
        {"kind": "lesson", "label": "学课件", "location": "图书馆"},
        {"kind": "practice", "label": "做练习", "location": "练习会馆"},
        {"kind": "assessment", "label": "做测验", "location": "镇长大厅"},
    ]}
    assert editor["recipe"] is None and [c["id"] for c in editor["chapters"]] == ["one", "two"]
    assert editor["chapters"][0]["materials"] == [{"id": "one-slides", "title": "课件", "available": True}]
    assert client.get(url, headers=student["headers"]).status_code == 403
    revision, receipt, preview = generate(client, teacher, url, draft)
    assert "选课" in preview["welcome_dialogue"] and "镇长" in preview["welcome_dialogue"]
    assert client.post(url+"/apply", headers=headers, json=receipt).json() == {"revision": revision}
    editor = client.get(url, headers=headers).json()
    assert editor["recipe"] == draft["recipe"]
    unchanged = {**draft, "expected_revision": revision}
    new_rev, _, preview = generate(client, teacher, url, unchanged)
    assert new_rev == revision and preview["changes"] == {"added": 0, "updated": 0, "removed": 0}
    # An unrelated edit to a generated NPC survives recompilation of chapter order.
    npc = db.scalar(select(Npc).where(Npc.course_instance_id == instance.id))
    npc.name = "张老师"
    db.commit()
    next_draft = deepcopy(unchanged)
    next_draft["recipe"]["chapters"].reverse()
    latest, _, _ = generate(client, teacher, url, next_draft)
    assert latest == revision + 1 and db.get(Npc, npc.key).name == "张老师"
    chapters = {row.stable_id: row for row in db.scalars(select(Chapter).where(Chapter.course_instance_id == instance.id))}
    assert db.get(ChapterRelease, (instance.classroom_id, chapters["one"].id)).prerequisite_chapter_id == chapters["two"].id
    assert db.get(ChapterRelease, (instance.classroom_id, chapters["two"].id)).prerequisite_chapter_id is None
    activities = list(db.scalars(select(Activity).where(Activity.course_instance_id == instance.id)))
    assert len(activities) == 6 and len({a.id for a in activities}) == 6
    assert client.post(url+"/apply", headers=headers, json=receipt).status_code == 409


@pytest.mark.parametrize("status", ["active", "complete"])
def test_upgrading_and_changing_the_tour_trigger_preserves_granted_quest(client, db, teacher, student, course, monkeypatch, status):
    from dataclasses import replace

    from app.models import LearningEvent, NodeState
    from app.teaching.quick_template.compiler import chapter_prefix
    from app.teaching.quick_template.features import FEATURES
    from app.teaching.quick_template.room_itinerary import shelf_tour_definition

    url, draft, instance = course
    stable = chapter_prefix("one") + "-shelves"
    def old_tour(result, prefix, owned_quests):
        result["quest"].append(shelf_tour_definition(prefix, quest_id=stable, chapter_id="one"))

    with monkeypatch.context() as patch:
        patch.setitem(FEATURES, "library_shelf_tour", replace(FEATURES["library_shelf_tour"], add_to_start=old_tour))
        draft["expected_revision"], _, _ = generate(client, teacher, url, draft)
    old = db.scalar(select(QuestDefinition).where(QuestDefinition.stable_id == stable))
    old_key = old.id
    player = PlayerQuest(user_id=student["id"], classroom_id=instance.classroom_id, quest_id=old_key, status=status)
    db.add(player)
    db.flush()
    player_id = player.id
    if status == "complete":
        evidence = {"object_id": "library_shelf"}
        db.add(NodeState(player_quest_id=player_id, node_id="open-shelf", evidence=evidence))
        db.add(LearningEvent(event_id="visited", user_id=student["id"], classroom_id=instance.classroom_id,
                             player_quest_id=player_id, node_id="open-shelf", evidence=evidence))
    db.commit()
    for chapter_id in ("one", "two"):
        if chapter_id == "two":
            draft["recipe"]["chapters"].reverse()
        draft["expected_revision"], _, preview = generate(client, teacher, url, draft)
        assert preview["reset_impact"] is None
        [side] = [q for q in preview["quests"] if q["kind"] == "side"]
        assert side["id"] == stable and side["chapter_id"] is None and side["available_after"]
        db.expire_all()
        assert db.get(QuestDefinition, old_key).chapter_id is None
        assert db.get(PlayerQuest, player_id).status == status
        world = client.get("/api/world", params={"classroom_id": instance.classroom_id}, headers=student["headers"]).json()
        [shown] = [q for q in world["quests"] if q["kind"] == "side"]
        assert shown["id"] == old_key and shown["status"] == status and shown["chapter_id"] is None
        if status == "complete":
            assert shown["nodes"][0]["status"] == "complete"
            assert db.scalar(select(LearningEvent).where(LearningEvent.player_quest_id == player_id)).event_id == "visited"


def test_author_can_publish_a_town_quest_before_any_chapter_opens(client, db, teacher, student, course):
    _, _, instance = course
    params = {"classroom_id": instance.classroom_id}
    definition = {"id": "visit-the-library", "title": "认识图书馆", "chapter_id": None, "kind": "side",
                  "nodes": [{"id": "shelf", "type": "INTERACT_OBJECT", "target": "library_shelf", "title": "看一看书架"}]}
    controls = {"headers": teacher["headers"], "params": params}
    without_chapter = client.post("/api/teacher/quests/validate", **controls, json={"definition": {**definition, "kind": "main"}})
    assert without_chapter.status_code == 422
    response = client.post("/api/teacher/quests", **controls, json={"definition": definition})
    assert response.status_code == 201, response.text
    world = client.get("/api/world", params=params, headers=student["headers"]).json()
    assert not any(ch["available"] for ch in world["chapters"])
    assert [(q["title"], q["chapter_id"]) for q in world["quests"]] == [("认识图书馆", None)]
    foreign_activity = db.get(Activity, "ch1-lesson")
    assert foreign_activity.course_instance_id != instance.id
    foreign = client.post("/api/teacher/quests/validate", **controls, json={
        "definition": {**definition, "when": {"activity_completed": foreign_activity.id}},
    })
    assert foreign.status_code == 404


def test_saved_short_template_remains_available_for_editing(client, teacher, course):
    url, draft, _ = course
    draft["recipe"].update(template_id="learn-practice", quiz_count=0)
    generate(client, teacher, url, draft)
    editor = client.get(url, headers=teacher["headers"]).json()
    full, shorter = editor["templates"]
    assert full["id"] == "learn-practice-quiz"
    assert shorter["id"] == "learn-practice" and [s["kind"] for s in shorter["stages"]] == ["lesson", "practice"]
    assert editor["recipe"] == draft["recipe"]


def test_publish_remove_and_restore_optional_features_and_final_chapter(client, db, teacher, course):
    url, draft, instance = course
    draft["recipe"].update(start_chapter_id="one", final_chapter_id=None, feature_ids=[])
    for enabled in (False, True, False, True):
        draft["recipe"]["feature_ids"] = ["public_chat", "library_shelf_tour"] if enabled else []
        draft["recipe"]["final_chapter_id"] = "two" if enabled else None
        revision, _, preview = generate(client, teacher, url, draft)
        draft["expected_revision"] = revision
        editor = client.get(url, headers=teacher["headers"]).json()
        assert editor["recipe"] == draft["recipe"]
        assert bool(preview["closing_dialogue"]) == enabled
        stories = {s.stable_id: s for s in db.scalars(select(StoryDefinition).where(StoryDefinition.course_instance_id == instance.id))}
        quests = list(db.scalars(select(QuestDefinition).where(QuestDefinition.course_instance_id == instance.id)))
        assert "quick-course-bookshelves" in stories and "quick-course-directions" in stories
        assert any(key.endswith("-quest-farewell") for key in stories) == enabled
        assert sum(q.definition["kind"] == "side" for q in quests) == int(enabled)


def test_switch_template_requires_current_impact_and_preserves_attempt(client, db, teacher, student, course):
    url, draft, instance = course
    rev, _, _ = generate(client, teacher, url, draft)
    headers = teacher["headers"]
    draft.update(expected_revision=rev)
    draft["recipe"].update(template_id="learn-practice", quiz_count=0)
    preview = client.post(url+"/preview", headers=headers, json=draft).json()
    assert preview["token"] and preview["reset_impact"] is None
    quest = db.scalar(select(QuestDefinition).where(QuestDefinition.course_instance_id == instance.id))
    learner = PlayerQuest(user_id=student["id"], classroom_id=instance.classroom_id, quest_id=quest.id, status="active")
    db.add(learner)
    db.commit()
    refused = client.post(url+"/apply", headers=headers, json={**draft, "token": preview["token"]})
    assert refused.status_code == 409 and db.get(PlayerQuest, learner.id)
    preview = client.post(url+"/preview", headers=headers, json=draft).json()
    assert preview["reset_impact"]["students"] == 1
    quiz = db.scalar(select(Activity).where(Activity.course_instance_id == instance.id, Activity.kind == "assessment"))
    attempt = AssessmentAttempt(activity_id=quiz.id, classroom_id=instance.classroom_id, user_id=student["id"])
    db.add(attempt)
    db.commit()
    assert client.post(url+"/apply", headers=headers, json={**draft, "token": preview["token"]}).status_code == 409
    blocked = client.post(url+"/preview", headers=headers, json=draft).json()
    assert blocked["token"] is None and "学习记录" in "".join(blocked["blockers"])
    assert db.get(AssessmentAttempt, attempt.id) and db.get(PlayerQuest, learner.id)


def test_failed_preview_and_switch_without_history(client, db, teacher, course):
    url, draft, instance = course
    headers = teacher["headers"]
    bad = deepcopy(draft)
    bad["recipe"]["chapters"][0]["material_ids"] = ["two-slides"]
    preview = client.post(url+"/preview", headers=headers, json=bad).json()
    assert not preview["token"] and preview["blockers"] and instance.revision == draft["expected_revision"]
    rev, _, _ = generate(client, teacher, url, draft)
    draft.update(expected_revision=rev)
    draft["recipe"].update(template_id="learn-practice", quiz_count=0)
    draft["recipe"]["chapters"].pop()
    _, _, preview = generate(client, teacher, url, draft)
    assert preview["changes"]["removed"] > 0
    activities = db.scalars(select(Activity).where(Activity.course_instance_id == instance.id)).all()
    assert {a.kind for a in activities} == {"lesson", "practice"} and len(activities) == 2
    stories = db.scalars(select(StoryDefinition).where(StoryDefinition.course_instance_id == instance.id)).all()
    assert len(stories) == 2


def test_preserves_quiz_with_formal_submissions_before_paper_recovery(client, db, teacher, student, course):
    from app.content_relations import activity_questions

    url, draft, instance = course
    draft["expected_revision"], _, _ = generate(client, teacher, url, draft)
    quiz = db.scalar(select(Activity).where(Activity.course_instance_id == instance.id, Activity.kind == "assessment"))
    question = activity_questions(db, quiz)[0]
    db.add(Submission(user_id=student["id"], classroom_id=instance.classroom_id, activity_id=quiz.id,
                      question_id=question.id, idempotency_key="legacy-quiz", mode="submit", status="accepted", feedback={}))
    db.commit()
    draft["recipe"]["quiz_count"] = 2
    result = client.post(url + "/preview", json=draft, headers=teacher["headers"]).json()
    assert result["token"] is None and "试卷" in "".join(result["blockers"])
    assert [q.id for q in activity_questions(db, quiz)] == [question.id]


def test_deselecting_a_retired_chapter_does_not_restore_its_old_release(client, db, teacher, course):
    from test_activity_deletion import confirm, preview

    url, draft, instance = course
    chapter = db.scalar(select(Chapter).where(Chapter.course_instance_id == instance.id, Chapter.stable_id == "two"))
    db.add(ChapterRelease(classroom_id=instance.classroom_id, chapter_id=chapter.id, status="published"))
    db.commit()
    generate(client, teacher, url, draft)
    classroom = {"id": instance.classroom_id}
    deletion = preview(client, teacher, classroom, "chapter", chapter.id)
    assert not deletion["blockers"], deletion["blockers"]
    response = confirm(client, teacher, classroom, deletion)
    assert response.is_success, response.text
    draft["recipe"]["chapters"].pop()
    draft["expected_revision"] = client.get(url, headers=teacher["headers"]).json()["revision"]
    generate(client, teacher, url, draft)
    assert db.get(ChapterRelease, (classroom["id"], chapter.id)).status == "paused"


def test_adjusting_learning_content_rechecks_new_objectives_but_keeps_old_evidence(client, db, teacher, student, course):
    url, draft, instance = course
    draft["recipe"]["chapters"] = draft["recipe"]["chapters"][:1]
    draft["recipe"].update(template_id="learn-practice", quiz_count=0)
    rev, _, _ = generate(client, teacher, url, draft)
    activities = {row.kind: row for row in db.scalars(select(Activity).where(Activity.course_instance_id == instance.id))}
    lesson, practice = activities["lesson"], activities["practice"]
    learner = db.get(User, student["id"])
    scope = {"classroom_id": instance.classroom_id, "user_id": learner.id}
    original = lesson.resources[0].material_id
    # Both slides have page number and page ID 1. Evidence must remain attached to the original material.
    replacement = Material(stable_id="new-slides", title="新课件", kind="pdf", status="ready", storage_key="private/new.pdf",
                           content={"pages": [{"id": 1, "page_no": 1}]}, owner_id=teacher["id"], course_instance_id=instance.id)
    db.add(replacement)
    db.flush()
    set_material_chapters(db, replacement.id, [lesson.chapter_id])
    record = LearningRecord(activity_id=lesson.id, **scope)
    progress = ActivityProgress(activity_id=lesson.id, page_no=1, completed=True,
                                visited_pages=[1], media_progress={"reading_pages": {str(original): [1]}}, **scope)
    from app.practice_sessions import open_session
    session = open_session(db, learner, instance.classroom_id, practice)
    session.items = [{**item, "status": "accepted"} for item in session.items]
    answer = Submission(activity_id=practice.id, question_id=session.items[0]["question_id"], idempotency_key="answer", status="accepted", **scope)
    quest = db.scalar(select(QuestDefinition).where(QuestDefinition.course_instance_id == instance.id))
    completed = PlayerQuest(quest_id=quest.id, status="complete", **scope)
    db.add_all([record, progress, answer, completed])
    db.commit()
    assert progress_payload(db, learner, instance.classroom_id, lesson)["completed"]
    assert progress_payload(db, learner, instance.classroom_id, practice)["completed"]
    draft.update(expected_revision=rev)
    draft["recipe"]["practice_count"] = 2
    protected = client.post(url + "/preview", headers=teacher["headers"], json=draft).json()
    assert not protected["token"] and any("个人题单" in reason for reason in protected["blockers"])
    draft["recipe"]["practice_count"] = 1
    draft["recipe"]["chapters"][0]["material_ids"] = ["new-slides"]
    _, _, preview = generate(client, teacher, url, draft)
    assert preview["reset_impact"]["students"] == 1 and len(preview["reset_impact"]["quests"]) == 1
    db.expire_all()
    assert not db.scalar(select(PlayerQuest).where(PlayerQuest.quest_id == quest.id))
    assert db.get(LearningRecord, record.id) and db.get(Submission, answer.id)
    assert not progress_payload(db, learner, instance.classroom_id, lesson)["completed"]
    assert progress_payload(db, learner, instance.classroom_id, practice)["completed"]


def test_filters_other_teacher_sources_and_preserves_manual_release(client, db, teacher, admin_account, course):
    url, draft, instance = course
    foreign = User(student_id="1230000999", name="另一教师", role="teacher", password_hash="test")
    db.add(foreign)
    db.flush()
    point = db.scalar(select(KnowledgePoint).where(KnowledgePoint.course_instance_id == instance.id, KnowledgePoint.stable_id == "one-point"))
    point.owner_id = foreign.id
    db.commit()
    for headers in (teacher["headers"], admin_account["headers"]):
        assert client.get(url, headers=headers).json()["chapters"][0]["knowledge_points"] == []
        assert client.post(url+"/preview", json=draft, headers=headers).json()["token"] is None
    point.owner_id = teacher["id"]
    db.add(ChapterRelease(classroom_id=instance.classroom_id, chapter_id=point.chapter_id, status="paused"))
    db.commit()
    original = client.post(url+"/preview", json=draft, headers=teacher["headers"]).json()
    assert original["token"] is None and "已有独立设置" in "".join(original["blockers"])
    assert db.get(ChapterRelease, (instance.classroom_id, point.chapter_id)).status == "paused"
