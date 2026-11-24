from sqlalchemy import event

from app.narration import repository
from conftest import make_material


def test_approving_many_pages_reads_each_deck_once(client, db, classroom, teacher):
    pages = [{"page_no": page, "text": str(page)} for page in range(1, 53)]
    deck = make_material(db, title="批量审校", kind="pdf", chapter_ids=[179], content={"pages": pages},
                         owner_id=teacher["id"])
    for page in pages:
        repository.upsert(db, deck, page["page_no"], text="讲解")
    db.commit()
    base = f"/api/teacher/courses/{classroom['course_id']}/content-review"
    headers = teacher["headers"]
    drafts = client.get(base, params={"kind": "narration", "size": 100}, headers=headers).json()["items"]
    selected = [{"id": row["id"], "kind": row["kind"], "revision": row["revision"]}
                for row in drafts if row["title"] == deck.title]
    assert len(selected) == 52
    queries = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            queries.append(statement)

    event.listen(db.bind, "before_cursor_execute", record)
    try:
        for batch in (selected[:2], selected[2:]):
            queries.clear()
            result = client.post(base + "/decisions", json={"items": batch, "decision": "accept"}, headers=headers)
            assert result.status_code == 200, result.text
            assert result.json()["count"] == len(batch)
            assert sum("materials.content" in sql for sql in queries) == 1
            assert sum("FROM page_contents" in sql for sql in queries) == 1
    finally:
        event.remove(db.bind, "before_cursor_execute", record)
