"""Dialogue in a continuing course and in a teacher-designated final chapter."""

import json
from copy import deepcopy
from pathlib import Path

import pytest

from app.course_instances import remap_references
from app.course_packages.legacy_town import restore_ordinary_fingerprints
from app.teaching.quick_template.compiler import chapter_prefix
from app.teaching.quick_template.plan import digest
from app.teaching.quick_template.town_itinerary import town_chapter, town_farewell, town_public


def by_id(flow):
    return {node["id"]: node for node in flow["content"]["nodes"]}


def chapter(position, *, final=False, following=None, shelf_tour=False, public_chat=True):
    return town_chapter({"id": "chapter-a", "title": "音乐鉴赏"}, following, position, "quick-sample",
                        final=final, shelf_tour=shelf_tour, public_chat=public_chat)


def test_only_the_designated_final_chapter_graduates_or_promises_an_available_next_chapter():
    for index in (0, 1):
        _, ongoing, _ = chapter(index)
        nodes = by_id(ongoing)
        assert "这一章学完了" in nodes["report"]["text"]
        assert "下一章" not in nodes["chapter-handoff"]["text"]
        assert "这门课最后" not in " ".join(node.get("text", "") for node in nodes.values())
    _, middle, _ = chapter(1, following={"id": "chapter-b"})
    assert "领取下一章" in by_id(middle)["chapter-handoff"]["text"]


@pytest.mark.parametrize("position", [0, 2])
def test_final_chapter_keeps_the_route_and_binds_the_review_to_its_own_quiz(position):
    quest, final, _ = chapter(position, final=True, shelf_tour=True)
    _, original, _ = chapter(position)
    assert final["content"]["bindings"] == original["content"]["bindings"]
    assert len(quest["definition"]["nodes"]) == 8
    nodes = by_id(final)
    if position == 0:
        assert nodes["welcome-mayor"]["text"] == by_id(original)["welcome-mayor"]["text"]
        assert "要不要试试自己找资料" in nodes["done-lesson"]["text"]
    assert "最后一章" in nodes["done-lesson"]["text"]
    assert "最后一组练习" in nodes["done-practice"]["text"]
    assert nodes["score"]["routes"][0]["when"] == {"assessment_score": {"activity_id": "quick-sample-assessment", "min": 100}}
    assert nodes["score-all"]["next"] == nodes["score-review"]["next"] == "report"
    assert all(word in nodes["report"]["text"] for word in ("馆员", "会馆", "卷子", "{course_name}", "小问题"))
    assert nodes["report"]["checkpoint"] == "report"
    assert {choice["id"] for choice in nodes["report"]["choices"]} == {"break", "next"}


def test_optional_daily_talk_never_blocks_ordinary_lessons_and_preserves_off_duty_directions():
    _, familiar, _ = chapter(1)
    _, plain, directions = chapter(1, public_chat=False)
    for node in ("welcome-mayor", "invite-lesson", "invite-practice"):
        with_chat = by_id(familiar)[node]
        without_chat = by_id(plain)[node]
        assert [c for c in with_chat["choices"] if c["id"] != "chat"] == without_chat["choices"]
        assert "chat" not in [c["id"] for c in without_chat["choices"]]
        aside = next(c for c in with_chat["choices"] if c["id"] == "chat")
        options = by_id(familiar)[aside["next"]]
        assert options["type"] == "random" and len(options["next"]) >= 2
        for variant in options["next"]:
            assert by_id(familiar)[variant]["choices"] == without_chat["choices"]
    assert "read-again" in by_id(directions)
    for enabled in (True, False):
        public = by_id(town_public(public_chat=enabled))
        assert "signpost" in public and "journal" in public
        assert ("chat-lesson" in public) is enabled
    _, first, _ = chapter(0, shelf_tour=False)
    assert "要不要试试自己找资料" not in by_id(first)["done-lesson"]["text"]


def test_ten_consecutive_ordinary_chapters_change_every_teaching_conversation():
    # Use identical chapter and student placeholders so a change of title alone cannot pass.
    visits = [by_id(chapter(position)[1]) for position in range(1, 11)]
    for node in ("welcome-mayor", "invite-lesson", "done-lesson", "invite-practice", "done-practice",
                 "invite-assessment", "score-all", "score-review", "report", "resume-lesson-1", "resume-practice-1",
                 "mayor-smalltalk-1", "smalltalk-lesson-1", "smalltalk-practice-1"):
        assert len({visit[node]["text"] for visit in visits}) == 10, node
    for index, visit in enumerate(visits, 1):
        plain = by_id(chapter(index, public_chat=False)[1])
        assert plain["report"] == visit["report"] and "smalltalk-lesson" not in plain
        assert visit["report"]["checkpoint"] == "report"
        assert "{chapter_name}" in visit["welcome-mayor"]["text"] and "{chapter_name}" in visit["report"]["text"]
        assert visit == by_id(chapter(index + 10)[1])
    first = by_id(chapter(0)[1])
    final = by_id(chapter(10, final=True)[1])
    assert all(v["welcome-mayor"]["text"] not in (first["welcome-mayor"]["text"], final["welcome-mayor"]["text"]) for v in visits)


def test_previous_ordinary_visit_upgrades_only_if_the_whole_graph_matches():
    previous = json.loads((Path(__file__).parent / "fixtures" / "quick-town-indoor-v1.json").read_text(encoding="utf-8"))
    # The next published ordinary route (no smalltalk, no final chapter) changed six speeches.
    nodes = {n["id"]: n for n in previous["shared_nodes"] + previous["last_nodes"]}
    for key, wording in {
        "welcome-mayor": "{name}，又见面了。上次来这里交卷，这回是来领《{chapter_name}》的资料吧？",
        "invite-lesson": "又见面啦，{name}。还是在这儿读书舒服吧？《{chapter_name}》的资料已经备好了。",
        "invite-practice": "来啦，老搭档。《{chapter_name}》读完了？那就让手和脑子一起试试。练习在这儿。",
        "invite-assessment": "《{chapter_name}》也练过了。你已经熟悉这里的规矩啦，准备好了就独立做一次测验。",
        "report": "《{chapter_name}》这一章学完了，{name}。今天就先到这里，出去走走吧。",
        "chapter-handoff": "今天这份学习安排已经完成了。想再看一眼哪页资料，就去馆里的书架找找。",
    }.items():
        nodes[key]["text"] = wording
    prefix = chapter_prefix("ordinary")
    _, new, _ = town_chapter({"id": "ordinary", "title": "音乐"}, None, 1, prefix, public_chat=False)
    old = deepcopy(new)
    old["content"]["nodes"] = remap_references([nodes[key] for key in previous["last_order"]],
                                              {"activity": {"sample-assessment": prefix + "-assessment"}})
    recipe = {"chapters": [{"chapter_id": "start"}, {"chapter_id": "ordinary"}], "final_chapter_id": None, "feature_ids": []}
    key = new["id"]

    def recognizes(flow):
        owned = {}
        restore_ordinary_fingerprints(owned, {key: flow}, {key: new}, recipe)
        return owned.get(key) == digest(flow)

    assert recognizes(old)
    edited = deepcopy(old)
    by_id(edited)["invite-lesson"]["text"] = "我专门为本班准备了这一段。"
    assert not recognizes(edited)
    edited = deepcopy(old)
    edited["content"]["entries"]["quick-course-reader"][0]["node"] = "end"
    assert not recognizes(edited)


def test_completed_course_offers_three_short_farewells_with_optional_smalltalk():
    for enabled in (True, False):
        flow = town_farewell("chapter-a", "quick-sample-quest", public_chat=enabled)
        assert flow["content"]["when"] == {"quest": {"id": "quick-sample-quest", "status": "complete"}}
        assert flow["chapter_id"] == "chapter-a" and flow["quest_id"] is None
        nodes = by_id(flow)
        for role in ("lesson", "practice", "assessment"):
            farewell = nodes["farewell-" + role]
            assert "\n\n" not in farewell["text"]
            choices = {c["id"]: c["next"] for c in farewell["choices"]}
            assert choices["leave"] == "end" and nodes[choices["advice"]]["next"] == "end"
            assert ("chat" in choices) is enabled
