from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from app import learning_rules
from app.learning_rules import record_video, validate_learning


def test_learning_config_validates_actual_pages_and_video_boundaries():
    handout = SimpleNamespace(kind="pdf", content={"pages": [{"id": 101, "page_no": 1}, {"id": 102, "page_no": 2}]})
    video = SimpleNamespace(kind="video", content={"duration_seconds": 120})
    valid = {"reading": {"scope": "range", "start_page": 1, "end_page": 2},
             "highlights": {"pages": [{"start_page": 1, "end_page": 1, "label": "重点"}]}}
    assert validate_learning({"learning": valid}, "lesson", handout, resolve=True) == valid
    assert validate_learning({"learning": {"video": {"minimum_seconds": 180}}}, "lesson", video, resolve=True)
    assert validate_learning({"learning": {"reading": {"scope": "pages", "page_ids": [101]}, "highlights": valid["highlights"]}}, "lesson", handout, resolve=True)
    invalid = [
        {"reading": {"scope": "all", "start_page": 1}},
        {"reading": {"scope": "range", "start_page": 2, "end_page": 1}},
        {"reading": {"scope": "range", "start_page": True, "end_page": 2}},
        {"reading": {"scope": "all"}, "video": {"minimum_seconds": 5}},
        {"video": {"minimum_seconds": True}},
        {"video": {"minimum_seconds": 0}},
        {"unknown": True},
        {"highlights": {"pages": [{"start_page": 1, "end_page": 9, "label": "不存在"}]}},
        {"highlights": {"pages": [{"start_page": 1, "end_page": 2, "label": " "}]}},
    ]
    for learning in invalid:
        with pytest.raises(ValueError):
            validate_learning({"learning": learning}, "lesson", handout, resolve=True)
    for learning in ({"video": {"minimum_seconds": 5}}, {"highlights": {"video": [{"start_seconds": 5, "end_seconds": 130, "label": "越界"}]}}):
        with pytest.raises(ValueError):
            validate_learning({"learning": learning}, "lesson", handout if "video" in learning else video, resolve=True)
    with pytest.raises(ValueError, match="活动资料项"):
        validate_learning({"completion": {"required_page_ids": [101]}, "learning": {"reading": {"scope": "all"}}}, "lesson", handout, resolve=True)
    with pytest.raises(ValueError, match="只有阅读活动"):
        validate_learning({"learning": {"reading": {"scope": "all"}}}, "practice")


@pytest.fixture
def clock(monkeypatch):
    value = [datetime(2026, 11, 7, tzinfo=timezone.utc)]
    monkeypatch.setattr(learning_rules, "utcnow", lambda: value[0])

    def advance(seconds):
        value[0] += timedelta(seconds=seconds)
    return advance


def test_video_clock_blocks_seek_replay_parallel_sessions_and_paused_time(clock):
    session = str(uuid4())
    state, changed = record_video({}, session, 1, 0, True, 120)
    assert changed and state["watched_seconds"] == 0
    clock(5)
    state, _ = record_video(state, session, 2, 5, True, 120)
    assert state["watched_seconds"] == 5
    clock(5)
    duplicate, changed = record_video(state, session, 2, 5, True, 120)
    assert duplicate == state and not changed
    with pytest.raises(ValueError, match="另一条"):
        record_video(state, session, 2, 6, True, 120)
    with pytest.raises(ValueError, match="不连续"):
        record_video(state, session, 4, 10, True, 120)
    with pytest.raises(ValueError, match="另一个播放会话"):
        record_video(state, str(uuid4()), 1, 5, True, 120)
    state, _ = record_video(state, session, 3, 100, True, 120)
    assert state["watched_seconds"] == 5  # Seek is a new baseline, never playback evidence.
    clock(5)
    state, _ = record_video(state, session, 4, 105, True, 120)
    assert state["watched_seconds"] == 10
    clock(2)
    state, _ = record_video(state, session, 5, 107, False, 120)
    assert state["watched_seconds"] == 12
    clock(40)
    state, _ = record_video(state, session, 6, 108, False, 120)
    assert state["watched_seconds"] == 12
    new_session = str(uuid4())
    state, _ = record_video(state, new_session, 1, 0, True, 120)
    clock(5)
    state, _ = record_video(state, new_session, 2, 5, True, 120)
    assert state["watched_seconds"] == 17  # Rewatch counts actual playback time.
    clock(30)
    state, _ = record_video(state, new_session, 3, 35, True, 120)
    assert state["watched_seconds"] == 17  # Long offline gaps never earn time.


def test_video_playback_rates_count_actual_wall_time_without_fast_forward_credit(clock):
    for rate in (.5, 1.5, 2, 4):
        session = str(uuid4())
        state, _ = record_video({}, session, 1, 0, True, 120, rate)
        clock(5)
        state, _ = record_video(state, session, 2, 5 * rate, True, 120, rate)
        assert state["watched_seconds"] == 5
        with pytest.raises(ValueError, match="另一条"):
            record_video(state, session, 2, 5 * rate, True, 120, 1)
    session = str(uuid4())
    state, _ = record_video({}, session, 1, 0, True, 120, 2)
    clock(5)
    state, _ = record_video(state, session, 2, 50, True, 120, 2)
    assert state["watched_seconds"] == 0  # Reported rate is bounded; a seek still earns nothing.
