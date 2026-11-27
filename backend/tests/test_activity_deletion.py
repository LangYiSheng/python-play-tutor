from course_fixtures import create_test_class
import pytest
from copy import deepcopy
from datetime import timedelta
from app.models import (
    ActivityProgress, ActivityQuestion, AssessmentAttempt, Chapter, ChapterRelease, KnowledgePoint,
    LearningRecord, Material, MaterialChapter, Question, QuestionChapter,
    QuestionKnowledgePoint, Submission, now,
)
from app.integration_models import AssistantSession
from app.deletion_models import ContentDeletionPreview
from test_curriculum import another_teacher
from sqlalchemy import select
from app.models import Activity, CourseInstance


def preview(client, teacher, classroom, kind, key):
    response = client.post(f"/api/teacher/courses/{classroom['course_id']}/content-deletions/preview", headers=teacher["headers"],
                           json={"targets": [{"kind": kind, "id": str(key)}]})
    assert response.status_code == 200, response.text
    return response.json()


def confirm(client, teacher, classroom, plan):
    return client.post(f"/api/teacher/courses/{classroom['course_id']}/content-deletions/{plan['id']}/confirm", headers=teacher["headers"],
                       json={"confirmation": plan["confirmation"], "confirmed": True})


def test_unused_activity_preview_and_confirmation(client, db, teacher, classroom):
    result = client.post(f"/api/teacher/courses/{classroom['course_id']}/activities", headers=teacher["headers"],
                         json={"id": "delete-me", "title": "可删除练习", "kind": "practice", "chapter_id": 179, "published": False})
    assert result.status_code == 201, result.text
    key = result.json()["id"]
    plan = preview(client, teacher, classroom, "activity", key)
    assert not plan["blockers"], plan
    assert db.scalar(select(Activity).where(Activity.id == key)) is not None
    instance = db.get(CourseInstance, db.get(Activity, key).course_instance_id)
    revision = instance.revision
    result = confirm(client, teacher, classroom, plan)
    assert result.status_code == 200, result.text
    assert db.scalar(select(Activity).where(Activity.id == key)) is None
    retired = db.scalar(select(Activity).where(Activity.id == key).execution_options(include_deleted=True))
    assert retired.deleted_at is not None
    db.refresh(instance)
    assert instance.revision == revision + 1
    assert confirm(client, teacher, classroom, plan).json() == result.json()


@pytest.fixture
def authored(db, teacher, classroom):
    owner = teacher['id']
    chapter = Chapter(id=9001, title='待删章节', order_index=100, owner_id=owner)
    material = Material(id=9001, title='独立资料', owner_id=owner, content={'text': '保留原文'})
    point = KnowledgePoint(id=9001, chapter_id=9001, title='相关知识', owner_id=owner)
    questions = [Question(id=f'cascade-q{i}', title=f'题目{i}', kind='boolean', prompt='判断', owner_id=owner, status='ready') for i in range(2)]
    activity = Activity(id='cascade-a', chapter_id=9001, title='关联活动', kind='practice', owner_id=owner, content={'knowledge_point_ids': [9001]})
    db.add_all([chapter, material, point, *questions, activity])
    db.flush()
    db.add_all([MaterialChapter(material_id=9001, chapter_id=9001), MaterialChapter(material_id=9001, chapter_id=179)])
    for i, question in enumerate(questions):
        db.add_all([QuestionChapter(question_id=question.id, chapter_id=9001), QuestionChapter(question_id=question.id, chapter_id=179),
                    ActivityQuestion(activity_id=activity.id, question_id=question.id, order_index=i),
                    QuestionKnowledgePoint(question_id=question.id, knowledge_point_id=9001)])
    db.commit()
    return chapter, material, point, questions, activity


def test_chapter_cascade_preserves_shared_bank_and_history(client, db, teacher, student, classroom, authored):
    chapter, material, point, questions, activity = authored
    fields = {'user_id': student['id'], 'classroom_id': classroom['id'], 'activity_id': activity.id}
    records = [ActivityProgress(**fields, completed=True, visited_pages=[1, 2]), LearningRecord(**fields, data={'grade': 100}),
               AssessmentAttempt(**fields, state='submitted', question_ids=[q.id for q in questions], answers={questions[0].id: True}),
               Submission(**fields, question_id=questions[0].id, idempotency_key='historic', status='accepted', feedback={'passed': True}),
               AssistantSession(**fields)]
    db.add_all(records)
    db.add(ChapterRelease(classroom_id=classroom['id'], chapter_id=9001, status='published'))
    dependent = db.get(ChapterRelease, (classroom['id'], 180))
    db.commit()
    for record in records:
        db.refresh(record)
    original = [{c.name: deepcopy(getattr(r, c.name)) for c in r.__table__.columns} for r in records]
    plan = preview(client, teacher, classroom, 'chapter', chapter.id)
    assert not plan['blockers'], plan
    assert {r['kind'] for r in plan['remove']} == {'chapter', 'knowledge_point', 'activity'}
    assert plan['affected_students'] == 1
    assert {'material', 'question', 'history'} <= {r['kind'] for r in plan['preserve']}
    assert confirm(client, teacher, classroom, plan).status_code == 200
    for r, saved in zip(records, original):
        db.refresh(r)
        assert {c.name: getattr(r, c.name) for c in r.__table__.columns} == saved
    assert db.scalar(select(Chapter).where(Chapter.id == chapter.id)) is None
    assert db.scalar(select(KnowledgePoint).where(KnowledgePoint.id == point.id)) is None
    assert db.scalar(select(Activity).where(Activity.id == activity.id)) is None
    assert db.scalar(select(Material).where(Material.id == material.id))
    assert db.scalar(select(Question).where(Question.id == questions[0].id))
    assert db.get(MaterialChapter, (material.id, 179))
    assert db.get(QuestionChapter, (questions[0].id, 179))
    assert db.get(MaterialChapter, (material.id, 9001)) is None
    assert db.get(QuestionKnowledgePoint, (questions[0].id, 9001)) is None
    db.refresh(dependent)
    assert dependent.status == 'published'
    # Retired chapter order slots may be reused without changing the old chapter.
    db.add(Chapter(title='新章节', order_index=100, owner_id=teacher['id']))
    db.commit()
    receipt = client.get(f'/api/submissions/{records[3].id}', params={'classroom_id': classroom['id']}, headers=student['headers'])
    assert receipt.status_code == 200, receipt.text
    assert client.get(f'/api/activities/{activity.id}', params={'classroom_id': classroom['id']}, headers=student['headers']).status_code in {403, 404}


def test_material_removal_preserves_chapter_practice_question_and_source_file(client, db, teacher, classroom, authored):
    _, material, _, questions, activity = authored
    material.storage_key = 'private/keep.txt'
    questions[0].source = {'material_id': material.id, 'page_no': 2, 'note': '原始引用说明'}
    db.commit()
    plan = preview(client, teacher, classroom, 'material', material.id)
    assert not plan['blockers'], plan
    assert {r['kind'] for r in plan['remove']} == {'material'}
    assert confirm(client, teacher, classroom, plan).status_code == 200
    db.refresh(material)
    db.refresh(questions[0])
    assert material.storage_key == 'private/keep.txt' and material.content == {'text': '保留原文'}
    assert questions[0].source == {'note': '原始引用说明'}
    assert db.scalar(select(Activity).where(Activity.id == activity.id)) is not None
    assert db.scalar(select(Question).where(Question.id == questions[0].id))


def test_question_unlinks_and_only_cascades_empty_activity(client, db, teacher, classroom, authored):
    _, _, _, questions, activity = authored
    single = Activity(id='single', chapter_id=9001, title='单题活动', kind='practice', owner_id=teacher['id'])
    db.add(single)
    db.flush()
    db.add(ActivityQuestion(activity_id=single.id, question_id=questions[0].id, order_index=0))
    db.commit()
    plan = preview(client, teacher, classroom, 'question', questions[0].id)
    assert not plan['blockers'], plan
    assert {r['id'] for r in plan['remove']} == {questions[0].id, single.id}
    assert any(r['id'] == activity.id for r in plan['detach'])
    assert confirm(client, teacher, classroom, plan).status_code == 200
    assert db.scalar(select(Activity).where(Activity.id == activity.id))
    assert db.scalar(select(Activity).where(Activity.id == single.id)) is None
    assert [r.question_id for r in db.scalars(select(ActivityQuestion).where(ActivityQuestion.activity_id == activity.id))] == [questions[1].id]


@pytest.mark.parametrize('change', ['revision', 'history', 'expired', 'wrong_text', 'unchecked'])
def test_stale_or_incomplete_confirmation_never_deletes(client, db, teacher, student, classroom, authored, change):
    *_, activity = authored
    plan = preview(client, teacher, classroom, 'activity', activity.id)
    if change == 'revision':
        db.get(CourseInstance, activity.course_instance_id).revision += 1
    elif change == 'history':
        db.add(LearningRecord(user_id=student['id'], classroom_id=classroom['id'], activity_id=activity.id))
    elif change == 'expired':
        db.get(ContentDeletionPreview, plan['id']).created_at = now() - timedelta(minutes=16)
    db.commit()
    body = {'confirmation': 'wrong' if change == 'wrong_text' else plan['confirmation'], 'confirmed': change != 'unchecked'}
    result = client.post(f"/api/teacher/courses/{classroom['course_id']}/content-deletions/{plan['id']}/confirm", headers=teacher['headers'], json=body)
    assert result.status_code in {409, 422}, result.text
    assert db.scalar(select(Activity).where(Activity.id == activity.id))
    assert db.get(ContentDeletionPreview, plan['id']).result is None


def test_preview_permission_scope_and_blocked_foreign_owned_dependency(client, db, teacher, student, classroom, authored):
    chapter, _, _, _, activity = authored
    other = another_teacher(db)
    body = {'targets': [{'kind': 'chapter', 'id': str(chapter.id)}]}
    for actor in (student, other):
        assert client.post(f"/api/teacher/courses/{classroom['course_id']}/content-deletions/preview", headers=actor['headers'], json=body).status_code == 403
    activity.owner_id = other['id']
    db.commit()
    plan = preview(client, teacher, classroom, 'chapter', chapter.id)
    assert any('无权删除' in r['message'] for r in plan['blockers'])
    assert confirm(client, teacher, classroom, plan).status_code == 409
    assert db.scalar(select(Chapter).where(Chapter.id == chapter.id))
    second = create_test_class(client, json={'name': '另一个班'}, headers=teacher['headers']).json()
    assert client.post(f"/api/teacher/courses/{second['course_id']}/content-deletions/{plan['id']}/confirm", headers=teacher['headers'],
        json={'confirmation': plan['confirmation'], 'confirmed': True}).status_code in {404, 409}


def test_batch_dependency_closure_and_old_delete_cannot_bypass(client, db, teacher, classroom, authored):
    chapter, material, _, questions, activity = authored
    for path in (f'chapters/{chapter.id}', f'materials/{material.id}', f'questions/{questions[0].id}', f'activities/{activity.id}'):
        assert client.delete(f"/api/teacher/courses/{classroom['course_id']}/{path}", headers=teacher['headers']).status_code == 409
    result = client.post(f"/api/teacher/courses/{classroom['course_id']}/content-deletions/preview", headers=teacher['headers'], json={
        'targets': [{'kind': 'question', 'id': q.id} for q in questions]})
    assert result.status_code == 200, result.text
    plan = result.json()
    assert not plan['blockers'], plan
    assert plan['confirmation'] == '删除所选2项' and len(plan['remove']) == 3
    assert confirm(client, teacher, classroom, plan).status_code == 200
    assert db.scalar(select(Activity).where(Activity.id == activity.id)) is None


def test_retired_question_does_not_change_locked_paper(client, db, teacher, student, classroom):
    from app.models import User
    from test_assessments import hand_in
    paper = hand_in(client, db, student, classroom)
    assert paper.status_code == 201, paper.text
    saved = paper.json()
    db.get(User, teacher['id']).role = 'admin'
    db.commit()
    plan = preview(client, teacher, classroom, 'question', saved['question_ids'][0])
    assert not plan['blockers'], plan
    assert confirm(client, teacher, classroom, plan).status_code == 200
    view = client.get('/api/activities/ch1-assessment', params={'classroom_id': classroom['id']}, headers=student['headers'])
    assert view.status_code == 200, view.text
    assert [q['id'] for q in view.json()['questions']] == saved['question_ids']
    receipt = client.get('/api/activities/ch1-assessment/assessment', params={'classroom_id': classroom['id']}, headers=student['headers'])
    assert receipt.status_code == 200, receipt.text
    assert receipt.json() == saved


def test_package_import_cannot_hard_delete_parent_of_retired_content(client, db, teacher, classroom, authored):
    from app.course_packages.snapshot import package_snapshot
    from app.course_packages.impact import preview_impact
    chapter, _, _, _, activity = authored
    plan = preview(client, teacher, classroom, 'activity', activity.id)
    assert confirm(client, teacher, classroom, plan).status_code == 200
    instance = db.get(CourseInstance, activity.course_instance_id)
    data, answers, _, _ = package_snapshot(db, instance)
    data['chapter'] = [c for c in data['chapter'] if c['id'] != chapter.stable_id]
    bundle = {'data': data, 'secrets': answers, 'course': {}, 'assets': [],
              'manifest': {key: getattr(instance,key) for key in ('package_id','name','package_version')}}
    impact = preview_impact(db, instance, bundle)
    assert any('历史保留内容引用' in message for message in impact['blockers'])
    assert db.scalar(select(Chapter).where(Chapter.id == chapter.id))


def test_material_delete_retires_sole_source_studio_points_and_trims_shared(client, db, teacher, classroom):
    owner = teacher['id']
    chapter = Chapter(id=9101, title='删除测试章', order_index=101, owner_id=owner)
    mat_a = Material(id=9101, stable_id='mat-del-a', title='旧课件A', owner_id=owner, content={'pages': []})
    mat_b = Material(id=9102, stable_id='mat-del-b', title='保留课件B', owner_id=owner, content={'pages': []})
    kp_sole = KnowledgePoint(
        id=9101,
        chapter_id=9101,
        title='仅来自A的知识点',
        owner_id=owner,
        content={'course_studio': {'section': '1.1', 'brief': 'A独有', 'sources': [{'material_stable_id': 'mat-del-a', 'pages': [1, 2]}]}},
    )
    kp_shared = KnowledgePoint(
        id=9102,
        chapter_id=9101,
        title='A和B共有的知识点',
        owner_id=owner,
        content={
            'course_studio': {
                'section': '1.2',
                'brief': '共有',
                'sources': [
                    {'material_stable_id': 'mat-del-a', 'pages': [3]},
                    {'material_stable_id': 'mat-del-b', 'pages': [5]},
                ],
            }
        },
    )
    kp_manual = KnowledgePoint(id=9103, chapter_id=9101, title='手工知识点', owner_id=owner, content={'summary_markdown': ''})
    db.add_all([chapter, mat_a, mat_b, kp_sole, kp_shared, kp_manual])
    db.flush()
    db.add_all([MaterialChapter(material_id=9101, chapter_id=9101), MaterialChapter(material_id=9102, chapter_id=9101)])
    db.commit()

    plan = preview(client, teacher, classroom, 'material', mat_a.id)
    assert not plan['blockers'], plan
    assert {(r['kind'], r['id']) for r in plan['remove']} == {('material', '9101'), ('knowledge_point', '9101')}
    assert any(d['kind'] == 'knowledge_point' and d['id'] == '9102' for d in plan['detach'])

    res = confirm(client, teacher, classroom, plan)
    assert res.status_code == 200, res.text
    assert db.scalar(select(KnowledgePoint).where(KnowledgePoint.id == 9101)) is None
    kept_shared = db.scalar(select(KnowledgePoint).where(KnowledgePoint.id == 9102))
    assert kept_shared is not None
    assert kept_shared.content['course_studio']['sources'] == [{'material_stable_id': 'mat-del-b', 'pages': [5]}]
    assert db.scalar(select(KnowledgePoint).where(KnowledgePoint.id == 9103)) is not None


def test_direct_knowledge_point_deletion_unlinks_questions_and_preserves_them(client, db, teacher, classroom, authored):
    _, _, point, questions, _ = authored
    plan = preview(client, teacher, classroom, 'knowledge_point', point.id)
    assert not plan['blockers'], plan
    assert {(r['kind'], r['id']) for r in plan['remove']} == {('knowledge_point', str(point.id))}
    assert any(d['kind'] == 'question' and d['id'] == questions[0].id for d in plan['detach'])

    res = confirm(client, teacher, classroom, plan)
    assert res.status_code == 200, res.text
    assert db.scalar(select(KnowledgePoint).where(KnowledgePoint.id == point.id)) is None
    assert db.scalar(select(Question).where(Question.id == questions[0].id)) is not None
    assert db.get(QuestionKnowledgePoint, (questions[0].id, point.id)) is None


def test_knowledge_point_deletion_can_opt_in_to_delete_sole_related_questions(client, db, teacher, classroom):
    owner = teacher['id']
    chapter = Chapter(id=9201, title='可选删题章', order_index=102, owner_id=owner)
    kp_del = KnowledgePoint(id=9201, chapter_id=9201, title='待删知识点', owner_id=owner)
    kp_keep = KnowledgePoint(id=9202, chapter_id=9201, title='保留知识点', owner_id=owner)
    q_sole = Question(id='opt-del-sole', title='独属题', kind='boolean', prompt='判断1', owner_id=owner, status='ready')
    q_shared = Question(id='opt-del-shared', title='共享题', kind='boolean', prompt='判断2', owner_id=owner, status='ready')
    db.add_all([chapter, kp_del, kp_keep, q_sole, q_shared])
    db.flush()
    db.add_all([
        QuestionChapter(question_id='opt-del-sole', chapter_id=9201),
        QuestionChapter(question_id='opt-del-shared', chapter_id=9201),
        QuestionKnowledgePoint(question_id='opt-del-sole', knowledge_point_id=9201),
        QuestionKnowledgePoint(question_id='opt-del-shared', knowledge_point_id=9201),
        QuestionKnowledgePoint(question_id='opt-del-shared', knowledge_point_id=9202),
    ])
    db.commit()

    # Default preview reports 1 sole related question without removing it
    base_plan = preview(client, teacher, classroom, 'knowledge_point', kp_del.id)
    assert base_plan['related_question_count'] == 1
    assert {(r['kind'], r['id']) for r in base_plan['remove']} == {('knowledge_point', '9201')}

    # Opt-in preview includes only the sole-linked question, keeping the shared question detached & preserved
    opt_res = client.post(
        f"/api/teacher/courses/{classroom['course_id']}/content-deletions/preview",
        headers=teacher['headers'],
        json={'targets': [{'kind': 'knowledge_point', 'id': '9201'}], 'include_related_questions': True},
    )
    assert opt_res.status_code == 200, opt_res.text
    opt_plan = opt_res.json()
    assert opt_plan['related_question_count'] == 1
    assert {(r['kind'], r['id']) for r in opt_plan['remove']} == {('knowledge_point', '9201'), ('question', 'opt-del-sole')}
    assert any(d['kind'] == 'question' and d['id'] == 'opt-del-shared' for d in opt_plan['detach'])

    conf = confirm(client, teacher, classroom, opt_plan)
    assert conf.status_code == 200, conf.text
    assert db.scalar(select(KnowledgePoint).where(KnowledgePoint.id == 9201)) is None
    assert db.scalar(select(Question).where(Question.id == 'opt-del-sole')) is None
    assert db.scalar(select(Question).where(Question.id == 'opt-del-shared')) is not None
