from app.models import CourseInstance
from app.narration import repository
from conftest import make_material, make_question


def drafts(client, db, classroom, teacher):
    cid, headers = classroom["id"], teacher["headers"]
    material = make_material(db, title="来源课件", kind="presentation", owner_id=teacher["id"],
                             content={"pages": [{"page_no": 1, "text": "原始资料"}]}, chapter_ids=[179])
    narration = repository.upsert(db, material, 1, text="原始讲稿", target_seconds=100)
    db.commit()
    response = client.post(f"/api/teacher/questions?classroom_id={cid}", headers=headers, json={
        "id": "review-question", "title": "待审练习", "kind": "fill", "prompt": "草稿", "answer": "Python",
        "chapter_ids": [179], "source": {"material_id": material.id, "page_no": 1}})
    assert response.status_code == 201, response.text
    return f"/api/teacher/classrooms/{cid}/content-review", material, narration, response.json()["id"]


def test_review_filtered_queue_and_transactional_decision(client, db, classroom, teacher, student):
    base, material, narration, question_id = drafts(client, db, classroom, teacher)
    headers = teacher["headers"]
    rows = client.get(base, headers=headers).json()["items"]
    selected = [r for r in rows if (r["kind"], r["id"]) in {("narration", str(narration.id)), ("question", question_id)}]
    assert len(selected) == 2
    assert next(r for r in selected if r["kind"] == "question")["material_title"] == material.title
    assert all(row["kind"] == "question" for row in client.get(base + "?kind=question&size=1", headers=headers).json()["items"])
    assert client.get(base, headers=student["headers"]).status_code == 403
    # An item changed after selection. The rest of the selection must not be accepted.
    stale = [dict(r, revision="old") if r["kind"] == "question" else r for r in selected]
    assert client.post(base + "/decisions", json={"decision": "accept", "items": stale}, headers=headers).status_code == 409
    assert db.get(type(narration), narration.id).status == "draft"
    result = client.post(base + "/decisions", json={"decision": "accept", "items": selected}, headers=headers)
    assert result.status_code == 200, result.text
    assert result.json()["count"] == 2
    assert db.get(type(narration), narration.id).status == "accepted"
    assert client.post(base + "/decisions", json={"decision": "accept", "items": selected}, headers=headers).status_code == 409


def test_edit_and_accept_narration_reject_question_and_class_isolation(client, db, classroom, teacher):
    base, material, narration, question_id = drafts(client, db, classroom, teacher)
    headers = teacher["headers"]
    second = client.post("/api/classrooms", json={"name": "隔离班级"}, headers=headers).json()["id"]
    db.add(CourseInstance(classroom_id=second, package_id="empty-course", name="空课程", package_version="1"))
    db.commit()
    other = f"/api/teacher/classrooms/{second}/content-review"
    assert client.get(other, headers=headers).json()["total"] == 0
    assert client.get(other + "/materials", headers=headers).json() == {"items": [], "total": 0, "page": 1, "question_count": 0}
    rows = client.get(base, headers=headers).json()["items"]
    narr = next(r for r in rows if r["kind"] == "narration" and r["id"] == str(narration.id))
    assert client.post(other + "/decisions", json={"decision": "accept", "items": [narr]}, headers=headers).status_code == 409
    detail = client.get(base + "/narrations/" + narr["id"], headers=headers).json()
    assert detail["raw_text"] == "原始资料"
    assert client.post(base + "/decisions", json={"decision": "accept", "items": [narr], "text": "已核对的新讲稿"}, headers=headers).status_code == 200
    assert repository.row(db, material.id, 1).text == "已核对的新讲稿"
    question = next(r for r in client.get(base + "?kind=question", headers=headers).json()["items"] if r["id"] == question_id)
    assert client.post(base + "/decisions", json={"decision": "reject", "items": [question]}, headers=headers).status_code == 200
    saved = client.get(f"/api/teacher/questions/{question_id}?classroom_id={classroom['id']}", headers=headers).json()
    assert saved["status"] == "disabled"


def test_queue_refuses_unusable_questions_and_changed_sources(client, db, classroom, teacher):
    base, material, narration, question_id = drafts(client, db, classroom, teacher)
    headers = teacher["headers"]
    path = f"/api/teacher/questions/{question_id}?classroom_id={classroom['id']}"
    assert client.put(path, headers=headers, json={"chapter_ids": []}).status_code == 200
    rows = client.get(base, headers=headers).json()["items"]
    selected = [r for r in rows if (r["kind"], r["id"]) in {("narration", str(narration.id)), ("question", question_id)}]
    result = client.post(base + "/decisions", json={"decision": "accept", "items": selected}, headers=headers)
    assert result.status_code == 422
    assert narration.status == "draft" and client.get(path, headers=headers).json()["status"] == "draft"
    material.content = {"pages": [{"page_no": 1, "text": "新版本原文"}]}
    db.commit()
    row = next(r for r in selected if r["kind"] == "narration")
    assert client.get(base + "/narrations/" + row["id"], headers=headers).json()["source_changed"] is True
    assert client.post(base + "/decisions", json={"decision": "accept", "items": [row]}, headers=headers).status_code == 409


def test_groups_count_shared_materials_once_and_include_orphans(client, db, classroom, teacher, student):
    from app.content_relations import set_material_chapters, set_question_chapters
    from app.models import Question

    base, material, row, qid = drafts(client, db, classroom, teacher)
    h = teacher["headers"]
    set_material_chapters(db, material.id, [180, 179])
    set_question_chapters(db, qid, [180, 179])
    make_question(db, chapter_ids=[], id="review-orphan", title="无出处题", kind="fill", prompt="x",
                  owner_id=teacher["id"], source={"material_id": str(material.id)}).status = "draft"
    make_question(db, chapter_ids=[180], id="review-second", title="需试答", kind="interactive", prompt="x",
                  owner_id=teacher["id"]).status = "draft"
    make_question(db, chapter_ids=[], id="review-foreign", title="其他所有者的草稿", kind="fill", prompt="x",
                  owner_id=student["id"]).status = "draft"
    db.commit()
    assert client.get(base + "/summary", headers=h).json() == {
        "total": 4, "material_count": 1, "question_count": 3, "narration_count": 1}
    assert client.get(base + "/summary", headers=student["headers"]).status_code == 403
    first = client.get(base + "/groups?page=1&size=1", headers=h).json()
    assert first["total"] == 3 and first["item_total"] == 4
    assert [(g["chapter_id"], g["count"], g["eligible_count"]) for g in first["items"]] == [(179, 2, 2)]
    second = client.get(base + "/groups?page=2&size=1", headers=h).json()["items"][0]
    assert (second["chapter_id"], second["eligible_count"]) == (180, 0)
    orphan = client.get(base + "/groups?page=3&size=1", headers=h).json()["items"][0]
    assert (orphan["chapter_id"], orphan["chapter_title"], orphan["count"]) == (0, "未归章", 1)
    materials = client.get(base + "/groups/179/materials", headers=h).json()
    assert materials["chapter_title"] == first["items"][0]["chapter_title"]
    assert [(g["material_id"], g["material_title"], g["count"]) for g in materials["items"]] == [(material.id, material.title, 2)]
    orphan_group = client.get(base + "/groups/0/materials", headers=h).json()["items"][0]
    assert orphan_group["material_id"] == 0 and orphan_group["material_title"] == "无来源资料"
    items = client.get(base + f"?chapter_id=179&material_id={material.id}&kind=question", headers=h).json()
    assert items["chapter_title"] == materials["chapter_title"] and items["material_title"] == material.title
    assert items["total"] == 1 and items["items"][0]["id"] == qid
    assert client.get(base + "?chapter_id=0&material_id=0", headers=h).json()["items"][0]["id"] == "review-orphan"
    assert client.get(base + "/groups/999999/materials", headers=h).status_code == 404
    assert db.get(Question, qid).status == "draft" and row.status == "draft"


def test_material_queue_groups_by_deck_and_links_first_pending_page(client, db, classroom, teacher, student):
    from app.content_relations import set_material_chapters
    from app.narration.models import PageNarration

    base, slides, original, _ = drafts(client, db, classroom, teacher)
    h = teacher["headers"]
    set_material_chapters(db, slides.id, [180, 179])
    original.status = "accepted"
    pdf = make_material(db, kind="pdf", title=slides.title)
    foreign = make_material(db, kind="pdf", title="其他所有者", owner_id=student["id"])
    video = make_material(db, kind="video", title="视频")
    for material, page, status in [(slides, 11, "draft"), (slides, 2, "draft"), (slides, 3, "rejected"),
                                   (pdf, 8, "draft"), (foreign, 5, "draft"), (video, 1, "draft")]:
        db.add(PageNarration(material_id=material.id, page_no=page, status=status))
    db.commit()

    assert client.get(base + "/materials", headers=student["headers"]).status_code == 403
    assert client.get(base + "/summary", headers=h).json() == {
        "total": 4, "material_count": 2, "question_count": 1, "narration_count": 3}
    first = client.get(base + "/materials?size=1", headers=h).json()
    assert first == {"page": 1, "total": 2, "question_count": 1, "items": [
        {"material_id": slides.id, "material_title": slides.title, "material_kind": "presentation",
         "narration_count": 2, "first_page_no": 2}]}
    second = client.get(base + "/materials?size=1&page=99", headers=h).json()
    assert second == {"page": 2, "total": 2, "question_count": 1, "items": [
        {"material_id": pdf.id, "material_title": pdf.title, "material_kind": "pdf",
         "narration_count": 1, "first_page_no": 8}]}

    repository.row(db, slides.id, 2).status = "accepted"
    repository.row(db, pdf.id, 8).status = "accepted"
    db.commit()
    remaining = client.get(base + "/materials?page=2&size=1", headers=h).json()
    assert remaining["page"] == remaining["total"] == 1
    assert [(r["material_id"], r["narration_count"], r["first_page_no"]) for r in remaining["items"]] == [(slides.id, 1, 11)]
    repository.row(db, slides.id, 11).status = "accepted"
    db.commit()
    assert client.get(base + "/materials", headers=h).json() == {"page": 1, "total": 0, "question_count": 1, "items": []}


def test_reviewable_question_filter_matches_counter_but_normal_catalog_shows_shared(client, db, classroom, teacher, student):
    from app.models import User

    base, _, _, own = drafts(client, db, classroom, teacher)
    h = teacher["headers"]
    for key, owner in [("shared-q", None), ("foreign-q", student["id"])]:
        make_question(db, chapter_ids=[179], id=key, title=key, kind="fill", prompt="草稿", owner_id=owner).status = "draft"
    db.commit()
    path = f"/api/teacher/questions?classroom_id={classroom['id']}"
    review_page = client.get(path + "&reviewable=true", headers=h).json()
    assert [r["id"] for r in review_page["items"]] == [own]
    assert review_page["total"] == client.get(base + "/materials", headers=h).json()["question_count"] == 1
    regular = client.get(path + "&page=1&status=draft", headers=h).json()
    assert {r["id"] for r in regular["items"]} == {own, "shared-q"}
    assert client.get(path + "&reviewable=true&status=ready", headers=h).json()["total"] == 0

    db.get(User, teacher["id"]).role = "admin"
    db.commit()
    admin_page = client.get(path + "&reviewable=true", headers=h).json()
    assert {r["id"] for r in admin_page["items"]} == {own, "shared-q", "foreign-q"}
    assert admin_page["total"] == client.get(base + "/summary", headers=h).json()["question_count"] == 3


def test_chapter_accept_verifies_full_scope_and_skips_interactive(client, db, classroom, teacher):
    from app.models import Question

    base, material, row, qid = drafts(client, db, classroom, teacher)
    h = teacher["headers"]
    make_question(db, chapter_ids=[179], id="review-interactive", title="需试答", kind="interactive", prompt="x",
                  owner_id=teacher["id"]).status = "draft"
    db.commit()
    path = base + "/groups/179"
    preview = client.get(path + "/preview", headers=h).json()
    assert [preview[k] for k in ("count", "question_count", "narration_count", "excluded_count")] == [2, 1, 1, 1]
    body = {"expected_count": 2, "token": preview["token"]}
    assert client.post(path + "/accept", json={**body, "kind": "question"}, headers=h).status_code == 409
    assert client.post(path + "/accept", json={**body, "expected_count": 1}, headers=h).status_code == 409
    repository.upsert(db, material, 1, text="同一条草稿在确认前发生修改")
    db.commit()
    assert client.post(path + "/accept", json=body, headers=h).status_code == 409
    assert db.get(Question, qid).status == "draft"
    preview = client.get(path + "/preview", headers=h).json()
    body["token"] = preview["token"]
    result = client.post(path + "/accept", json=body, headers=h)
    assert result.status_code == 200, result.text
    assert result.json()["count"] == 2 and row.status == "accepted" and db.get(Question, qid).status == "ready"
    assert client.post(path + "/accept", json=body, headers=h).status_code == 409
    remaining = client.get(base + "/groups?kind=question", headers=h).json()["items"][0]
    assert remaining["count"] == 1 and remaining["eligible_count"] == 0


def test_chapter_accept_uses_every_page_and_never_accepts_new_arrivals(client, db, classroom, teacher):
    from sqlalchemy import func, select
    from app.narration.models import PageNarration

    base, material, _, _ = drafts(client, db, classroom, teacher)
    h = teacher["headers"]
    material.content = {"pages": [{"page_no": i, "text": "原始资料"} for i in range(1, 103)]}
    for i in range(2, 102):
        repository.upsert(db, material, i, text=f"第 {i} 页讲稿")
    db.commit()
    path = base + "/groups/179"
    preview = client.get(path + "/preview?kind=narration", headers=h).json()
    assert preview["count"] == 101
    body = {"kind": "narration", "expected_count": 101, "token": preview["token"]}
    repository.upsert(db, material, 102, text="新生成的草稿")
    db.commit()
    assert client.post(path + "/accept", json=body, headers=h).status_code == 409
    preview = client.get(path + "/preview?kind=narration", headers=h).json()
    result = client.post(path + "/accept", json={**body, "expected_count": 102, "token": preview["token"]}, headers=h)
    assert result.status_code == 200, result.text
    assert db.scalar(select(func.count()).select_from(PageNarration).where(
        PageNarration.status == "accepted", PageNarration.material_id == material.id)) == 102
    assert client.get(base + "/summary", headers=h).json()["total"] == 1
