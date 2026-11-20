"""Features a teacher may add to the town's required chapter route."""

from collections.abc import Callable, Collection
from dataclasses import dataclass

from app.teaching.quick_template.room_itinerary import add_shelf_tour


@dataclass(frozen=True)
class TownFeature:
    title: str
    description: str
    default_enabled: bool = True
    add_to_start: Callable[[dict, str, Collection[str]], None] | None = None


FEATURES = {
    "public_chat": TownFeature("小镇日常闲聊", "课间可以到三个房间找熟人聊天。"),
    "library_shelf_tour": TownFeature("认识图书馆的书架", "起始章读完后出现的全镇支线，课间或之后的章节都可以完成。", add_to_start=add_shelf_tour),
}
ROUTE_FIELDS = {"start_chapter_id", "final_chapter_id", "feature_ids"}


def feature_catalog():
    return [{"id": key, "title": item.title, "description": item.description, "default_enabled": item.default_enabled}
            for key, item in FEATURES.items()]


def route_options(recipe, chapter_ids):
    """Old recipes implicitly used both features and closed at the last selected chapter."""
    first = recipe.get("start_chapter_id", chapter_ids[0])
    if first != chapter_ids[0]:
        raise ValueError("起始章必须排在授课顺序第一位")
    last = recipe.get("final_chapter_id") if ROUTE_FIELDS.intersection(recipe) else chapter_ids[-1]
    if last is not None and last != chapter_ids[-1]:
        raise ValueError("最终章必须排在授课顺序最后一位，也可以暂不设置")
    enabled = recipe.get("feature_ids", ["public_chat", "library_shelf_tour"])
    if not isinstance(enabled, list) or any(not isinstance(key, str) or key not in FEATURES for key in enabled):
        raise ValueError("选中了未知的小镇功能")
    if len(set(enabled)) != len(enabled):
        raise ValueError("同一个小镇功能只能选择一次")
    return last, set(enabled)
