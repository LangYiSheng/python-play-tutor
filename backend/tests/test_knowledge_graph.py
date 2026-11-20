from datetime import timedelta

from sqlalchemy import select

from app.models import KnowledgePoint, Material, MaterialChapter, now
from app.narration import repository
from app.narration.models import NarrationJob


def test_overview_and_source_evidence(client, db, classroom, teacher, student):
    path = "/api/teacher/course-graph"
    params = {"classroom_id": classroom["id"]}
    headers = teacher["headers"]
    graph = client.get(path, params=params, headers=headers).json()
    deck = next(row for row in graph["materials"] if row["id"] == 186)
    assert deck["chapter_ids"] == [179]
    assert "pages" not in deck and "questions" not in graph

    point = db.scalars(select(KnowledgePoint).where(KnowledgePoint.chapter_id == 179)).first()
    source = db.get(Material, 186)
    source.content = {"pages": [{"id": 77000, "page_no": 4}, {"id": 77001, "page_no": 5}]}
    second = db.get(Material, 187)
    second.content = {"pages": [{"id": 77002, "page_no": 1}, {"id": 77001, "page_no": 2}]}
    point.content = {"page_refs": [77000, 77001, 77002]}
    db.add(MaterialChapter(material_id=186, chapter_id=180))
    db.commit()
    info = client.get(f"{path}/points/{point.id}", params=params, headers=headers).json()
    assert sorted(info["sources"], key=lambda x: x["material_id"]) == [
        {"material_id": 186, "pages": [4]}, {"material_id": 187, "pages": [1]}]
    detail = client.get(f"{path}/materials/186", params=params, headers=headers).json()
    assert detail["points"] == [{"id": point.id, "title": point.title, "chapter_id": 179, "pages": [4]}]
    assert detail["narrations"] == detail["audio"] == 0
    assert client.get(path + "/tasks", params=params, headers=headers).json() == []
    assert client.get(path, params=params, headers=student["headers"]).status_code == 403
    assert client.get(f"{path}/points/{point.id}", params={"classroom_id": 99999}, headers=headers).status_code in (403, 404)


def test_graph_uses_current_audio_and_live_job_evidence(client, db, classroom, teacher):
    path = "/api/teacher/course-graph"
    params = {"classroom_id": classroom["id"]}
    headers = teacher["headers"]
    material = db.get(Material, 186)
    first = repository.upsert(db, material, 1, text="第一页的讲解")
    first.status = "accepted"
    first.audio_key = "narrations/test.wav"
    first.audio_text_hash = repository.text_hash(first.text)
    repository.upsert(db, material, 2, text="第二页的草稿")
    job = NarrationJob(material_id=material.id, status="running", started_at=now(),
                       kind="pipeline", progress={"stage": "digest", "done": 2, "total": 7})
    db.add(job)
    db.commit()
    def read(suffix):
        return client.get(path + suffix, params=params, headers=headers).json()
    detail = read("/materials/186")
    assert (detail["narrations"], detail["drafts"], detail["audio"]) == (2, 1, 1)
    assert [(j["stage"], j["done"], j["total"]) for j in read("/tasks")] == [("digest", 2, 7)]
    first.text += "已修改"
    job.started_at = now() - timedelta(days=1)
    db.commit()
    assert read("/materials/186")["audio"] == 0
    interrupted, = read("/tasks")
    assert interrupted["status"] == "interrupted" and not interrupted["retryable"]
