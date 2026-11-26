"""Validate package content references and teaching definitions before import."""

from pathlib import Path

from app.course_packages.snapshot import FIELDS
from app.course_instances import MODEL_NAMES, remap_references
from app.course_packages.contracts import EXTRAS, PACKAGE_MODELS
from app.course_packages.manifest import PackageError
from app.materials.uploads import validate_upload
from app.models import Activity, Chapter, CourseExample, KnowledgePoint, Material


def _object(value, keys, required=None):
    if not isinstance(value, dict) or set(value) - set(keys) or not set(required or []).issubset(value):
        raise PackageError("课程对象字段缺失或包含未知字段")


def _short(value, maximum=100):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= maximum


def _bounded(value, depth=0, budget=None):
    budget = [0] if budget is None else budget
    budget[0] += 1
    if depth > 24 or budget[0] > 200000:
        raise PackageError("课程配置嵌套或对象数量超限")
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise PackageError("配置字段必须为字符串")
        for item in value.values():
            _bounded(item, depth + 1, budget)
    elif isinstance(value, list):
        for item in value:
            _bounded(item, depth + 1, budget)
    elif value is not None and type(value) not in (str, int, float, bool):
        raise PackageError("配置只支持JSON值")
    elif isinstance(value, float):
        import math

        if not math.isfinite(value):
            raise PackageError("配置不能包含非有限数字")


def validate_practice(row, converted, maps):
    from app.practice_rules import PracticeRules, allocate_initial, practice_question_available

    if row["kind"] != "practice" or row["question_ids"]:
        raise PackageError("知识点规则只能配置在无固定选题的练习中")
    content = row["content"]
    rules = PracticeRules.model_validate(content["practice_rules"]).model_dump()
    points = {g["knowledge_point_id"] for g in rules["goals"]}
    if set(content.get("knowledge_point_ids", [])) != points:
        raise PackageError("练习知识点与目标不一致")
    titles = {maps["knowledge_point"][key]: point["title"] for key, point in converted["knowledge_point"].items()
              if point["chapter_id"] == row["chapter_id"]}
    if not points.issubset(titles):
        raise PackageError("练习目标必须来自活动所属章节")
    if type(content.get("published", True)) is not bool:
        raise PackageError("练习发布状态无效")
    if content.get("published", True):
        pool = {point: {} for point in points}
        for question in converted["question"].values():
            available = practice_question_available(question["kind"], question["status"], bool(question["samples"]))
            matches_kind = (content["practice_kind"] == "programming") == (question["kind"] == "python")
            if available and matches_kind and row["chapter_id"] in question["chapter_ids"]:
                for point in points.intersection(question["knowledge_point_ids"]):
                    pool[point][question["id"]] = question["kind"]
        allocate_initial(rules, pool, shuffle=False, point_titles=titles)


def validate_bundle(bundle, root):
    """Validate portable references and full graphs before any database/storage writes."""
    from types import SimpleNamespace

    from app.course_content.question_contracts import QuestionInput
    from app.chapter_tasks.rules import validate_rule

    try:
        _bounded(bundle)
        data = bundle["data"]
        indexed, maps = {}, {}
        for model in PACKAGE_MODELS:
            fields = set(FIELDS[model])
            kind, items = MODEL_NAMES[model], data[MODEL_NAMES[model]]
            if not isinstance(items, list) or len(items) > 10000:
                raise PackageError("课程领域条目超限")
            indexed[kind] = {}
            for row in items:
                keys = {"id", *fields, *EXTRAS.get(model, set())}
                _object(row, keys, keys)
                if not _short(row["id"]) or row["id"] in indexed[kind]:
                    raise PackageError("课程稳定ID无效或重复")
                if "title" in row and not _short(row["title"], 200):
                    raise PackageError("课程标题无效")
                if any(not isinstance(row[field], dict) for field in ("content", "definition", "source") if field in row):
                    raise PackageError("课程内容必须为对象")
                indexed[kind][row["id"]] = row
            maps[kind] = {key: (i + 1 if model in {Chapter, Material, KnowledgePoint, CourseExample} else key) for i, key in enumerate(indexed[kind])}
        # Typed conversion resolves every declared foreign reference, including conditions.
        converted = {kind: {key: remap_references(row, maps) for key, row in items.items()} for kind, items in indexed.items()}
        for model in (KnowledgePoint, Material, Activity):
            for row in indexed[MODEL_NAMES[model]].values():
                if "chapter_id" in row and row["chapter_id"] is None:
                    raise PackageError("此类课程条目必须绑定章节")
        orders = [row["order_index"] for row in data["chapter"]]
        if any(type(order) is not int or not 0 <= order <= 100000 for order in orders) or len(set(orders)) != len(orders):
            raise PackageError("章节顺序无效或重复")
        secret_map = {}
        for row in bundle["secrets"]:
            _object(row, {"id", "answer", "hidden_cases"}, {"id", "answer", "hidden_cases"})
            if row["id"] not in indexed["question"] or row["id"] in secret_map:
                raise PackageError("私有答案引用缺失或重复")
            secret_map[row["id"]] = row
        if set(secret_map) != set(indexed["question"]):
            raise PackageError("每道题必须具有私有答案记录（草稿可为空）")
        assets = {asset["id"]: asset for asset in bundle["assets"]}
        for row in data["material"]:
            if row["kind"] not in {"text", "pdf", "video", "presentation"} or row["status"] not in {"ready", "failed", "missing"}:
                raise PackageError("资料类型或状态无效")
            if row["error"] is not None and not isinstance(row["error"], str):
                raise PackageError("资料错误信息无效")
            if row["asset_id"] is not None and row["asset_id"] not in assets:
                raise PackageError("资料引用缺失资源")
            if "preview_key" in row["content"] or "storage_key" in row["content"]:
                raise PackageError("课程包不能包含服务器存储键")
            if row["preview_asset_id"] is not None:
                preview_asset = assets.get(row["preview_asset_id"])
                if not preview_asset or preview_asset["media_type"] != "application/pdf":
                    raise PackageError("转换预览必须引用实际PDF资源")
                validate_upload(root / preview_asset["path"], ".pdf")
            if row["kind"] != "text" and row["asset_id"] is None:
                raise PackageError("完整课程包不能包含缺失媒体")
            pages = row["content"].get("pages", [])
            if not isinstance(pages, list) or len(pages) > 10000:
                raise PackageError("资料页数据无效")
            ids, numbers = set(), set()
            for page in pages:
                if not isinstance(page, dict) or type(page.get("id")) is not int or type(page.get("page_no")) is not int:
                    raise PackageError("资料页需要原始整数ID与页码")
                if page["id"] in ids or page["page_no"] in numbers or page["id"] < 1 or page["page_no"] < 1:
                    raise PackageError("资料页重复或页码无效")
                ids.add(page["id"])
                numbers.add(page["page_no"])
            if len(row["chapter_ids"]) != len(set(row["chapter_ids"])):
                raise PackageError("资料章节关联重复")
            points = row["task_points"]
            if not isinstance(points, list) or len(points) != len(row["chapter_ids"]):
                raise PackageError("每个资料章节关联需要一条任务点配置")
            for point in points:
                keys = {"chapter_id", "required", "rule", "order_index"}
                _object(point, keys, keys)
                if type(point["required"]) is not bool or type(point["order_index"]) is not int or point["order_index"] < 0:
                    raise PackageError("资料必读设置或顺序无效")
                validate_rule(point["rule"], SimpleNamespace(**row), point["required"])
            if {p["chapter_id"] for p in points} != set(row["chapter_ids"]):
                raise PackageError("资料任务点归属与章节不一致")
            if row["asset_id"]:
                asset = assets[row["asset_id"]]
                from app.materials.uploads import KINDS

                suffix = Path(asset["path"]).suffix.lower()
                if KINDS.get(suffix) != row["kind"]:
                    raise PackageError("资料类型与资源文件不匹配")
                if row["kind"] == "presentation" and row["status"] == "ready" and not row["preview_asset_id"]:
                    text_only = suffix == ".pptx" and any(isinstance(page.get("text"), str) and page["text"].strip() for page in pages)
                    if not text_only:
                        raise PackageError("已就绪演示文稿缺少转换预览PDF或可读页文本")
                validate_upload(root / asset["path"], suffix)
        for key, row in converted["question"].items():
            QuestionInput.model_validate({**row, **{field: secret_map[key][field] for field in ("answer", "hidden_cases")}}, strict=True)
            portable = indexed["question"][key]
            for point_id in portable["knowledge_point_ids"]:
                if indexed["knowledge_point"][point_id]["chapter_id"] not in portable["chapter_ids"]:
                    raise PackageError("题目知识点必须属于关联章节")
            source = portable["source"]
            if "page_no" in source and (
                "material_id" not in source
                or source["page_no"] not in {page["page_no"] for page in indexed["material"][source["material_id"]]["content"].get("pages", [])}
            ):
                raise PackageError("题目来源页不存在")
        for row in data["activity"]:
            content = row["content"]
            if row["kind"] not in {"practice", "assessment"} or type(content.get("required", True)) is not bool:
                raise PackageError("任务点类型或必做设置无效")
            if row["kind"] == "practice" and content.get("practice_kind") not in {"objective", "programming"}:
                raise PackageError("请选择客观题或编程题练习")
            if row["kind"] == "assessment" and content.get("required", True) is False:
                raise PackageError("测验必须完成")
            if type(content.get("published", True)) is not bool or type(content.get("order_index", 0)) is not int or not 0 <= content.get("order_index", 0) <= 100000:
                raise PackageError("活动发布状态或顺序无效")
            if content.get("published", True) and not row["question_ids"] and "practice_rules" not in content:
                raise PackageError("发布的练习和测验至少需要一道题")
            if "practice_rules" in row["content"]:
                validate_practice(converted["activity"][row["id"]], converted, maps)
            if "question_ids" in row["content"]:
                raise PackageError("活动题集只能声明于结构化question_ids关联")
            if len(set(row["question_ids"])) != len(row["question_ids"]):
                raise PackageError("活动题目重复")
            for question_id in row["question_ids"]:
                question = indexed["question"][question_id]
                if row["kind"] == "practice" and (content["practice_kind"] == "programming") != (question["kind"] == "python"):
                    raise PackageError("题型与练习类别不一致")
                if question["kind"] == "interactive" and row["kind"] != "practice":
                    raise PackageError("交互练习题只能用于练习活动")
                if row["chapter_id"] not in question["chapter_ids"] or question["status"] != "ready":
                    raise PackageError("活动题目必须已就绪并属于当前章节")
        course = bundle["course"]
        _object(course, {"schema_version", "title"}, {"schema_version", "title"})
        if course["schema_version"] != 4 or not _short(course["title"], 200):
            raise PackageError("课程目录格式无效")
        from app.course_packages.exams import validate_exams
        from app.course_packages.narration_contract import validate_narrations

        validate_narrations(bundle, root)
        validate_exams(bundle)
    except (ValueError, TypeError, KeyError, AttributeError, RecursionError) as exc:
        if isinstance(exc, PackageError):
            raise
        raise PackageError(f"课程语义校验失败：{exc}") from exc
