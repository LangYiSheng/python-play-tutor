# 讲义内容流水线实施计划（原文整理 → 校准 → 讲解稿）

状态：待实施（P0 未开始）。实施完成后结论并入[架构](../architecture.md)与[内容规范](../content-authoring.md)，本文件删除。
日期：2026-11-19

## 1. 目标

1. 每页在「原始解析文本」之外，新增 `title`、`topic`、`tags`，作为知识图谱与 RAG 的结构化字段。
2. 新增「整理稿」：在原始文本上做极轻微优化，偏讲义口吻，保留原文证据，作为 RAG chunk。
3. 讲解稿（口播稿）与整理稿彻底分开：先整理 → 再整册校准（原文纠错 + tag 归并）→ 再生成讲解稿。
4. 讲解稿改为多页窗口生成，提高跨页连贯性；梳理、校准、讲解三段自动接续，老师只点一次。

## 2. 术语

| 名称 | 含义 | 存放 |
| --- | --- | --- |
| 原始文本 raw | pypdf 抽取的文本，永不改写 | `Material.content.pages[].text` |
| 整理稿 | 轻优化、偏讲义、RAG chunk | `page_contents.text`（新表） |
| 讲解稿 | 口播台词，学生听到的内容 | `page_narrations.text`（不变） |
| title / topic / tags | 本页标题、本页主题、知识标签 | `page_contents` |
| tag 字典 | `别名 → 标准名`，课程级共享 | `material_tag_dicts`（新表） |

## 3. 已定决策

| 项 | 决定 |
| --- | --- |
| 整理稿存储 | A1：新表 `page_contents`，raw 保持不动 |
| tag 字典作用域 | 课程实例级（`course_instance_id`） |
| 窗口页数 | 梳理 4 页 / 校准 4 页 / 讲解 4 页 |
| 讲解稿上下文 | 600 字状态回看 + 后 2 页纯文本前瞻（不发图） |
| 流程 | 一键到底，三段自动接续 |
| 审校页原文 | 展示整理稿；raw 收进「查看原始文本」折叠区 |
| 窗口化去留 | P3.5 实测后定（4 组对照） |
| 梳理发图阈值 | 页文本 <600 字发图（覆盖 0–199 全部 88 页）；4 页窗图上限 = 4 |
| 缺图处理 | 一律写 `image_state`（sent/policy/skipped/render_failed），禁止静默截断；梳理阶段渲染失败 = 该页失败 |
| 自动应用原文修正 | 接受（无人工确认；靠 `status=draft` + 长度/片段校验 + 报告 diff 兜底） |
| 课程包导出 | 暂缓：课程包不由本需求负责人维护，等对方确认后再排 |

## 4. 现状事实（已核对）

- `Material.content.pages[]` 只有 `id / page_no / title(恒为「第N页」)/ text`；pptx 经 LibreOffice 转 PDF，不读演讲者备注。
- `PageNarration.text` 是讲解稿，被 5 处消费：学生字幕 `LectureStage.vue:164`、TTS `audio.py`、助教上下文 `assistant_context.py:143`、课程包 `narration_contract.py:12`、校准输入 `calibrate.py::participating`。
- 校准是报告制（`NarrationCalibration.report`），不改稿；`apply` 才按 issue 逐页重生成。
- 窗口常量：`WINDOW=4`、`WINDOW_TEXT_BUDGET=9000`、`SHRUNK_TEXT_BUDGET=4500`、`IMAGE_LIMIT=4`、`SHRUNK_IMAGE_LIMIT=2`、`SLICE_SECONDS=45`、`CALIBRATE_VERSION="cal-v2"`。
- 后台任务已就绪：`jobs.py` worker（`CONCURRENCY=3`、每 2 秒扫描）、`repository.enqueue/acquire/beat/release`、`interrupt_running()`、`JOB_STALE_SECONDS=300`。
- 真实课件（第 1 讲 103 页）实测：原文总量 9383 字；57 页 <60 字（必须发图）；4 页窗零超限；5 页窗 2 窗超图；6 页窗 3 窗；8 页窗 6 窗。
- 校准实测（50 页 13 窗）：`shrunk_windows` 两轮为空；开思考单窗最长 33.5 s；两次 `httpx.ReadTimeout`；`finish_reason=length` 无自动重试。
- 仓库无 tags / embedding / pgvector；迁移用 alembic（32 个版本）。

## 5. 目标流水线

```
上传 → 解析（raw pages，不变）
        ↓
  ① 梳理文本（digest）     每 4 页一窗 → title/topic/tags/整理稿
        ↓ 自动
  ② 整册校准（calibrate）  原文纠错（raw 对照 + 前后页）+ tag 归并（课程级字典）
        ↓ 自动应用 fixes + tag_map
  ③ 生成讲解稿（script）   每 4 页一窗 + 600 字状态回看 + 2 页纯文本前瞻
        ↓
  ④ 批量合成音频（已有，不变）
```

每段都是 `NarrationJob` 的一个 stage，共用锁、心跳、断点续跑；失败可从断点续跑。

## 6. 数据模型

### 6.1 新表 `page_contents`

```
material_id      FK materials.id, ondelete CASCADE, index
page_no          int           (material_id + page_no 唯一)
title            str(120)     本页标题
topic            str(240)     本页主题（一句话）
tags             JSON list    整理时的原始标签（未归并）
raw_text_hash    str(64)      生成整理稿时 raw 的 hash，用于判 stale
text             Text         整理稿（RAG chunk）
source           str(16)      parsed | ai | teacher
status           str(16)      draft | accepted | stale
image_state      str(16)      sent | policy | skipped | render_failed（本页整理时是否带了页图）
model            str(80)
prompt_version   str(24)
input_hash       str(64)
updated_at       datetime
```

### 6.2 新表 `material_tag_dicts`

```
course_instance_id  FK course_instances.id, index
alias               str(80)
canonical           str(80)
source_material_id  FK materials.id, nullable
created_at          datetime
唯一约束 (course_instance_id, alias)
```

### 6.3 不变的部分

- `page_narrations.text` 仍是讲解稿（学生字幕、TTS 零改动；课程包见 §3 暂缓）。
- `NarrationCalibration` 表保留；`report` 新增 `fixes`、`tag_map`、`tag_stats`。
- `NarrationJob.progress` 新增 `chain` / `stage`。

### 6.4 backfill（迁移内执行）

把现有 `Material.content.pages[]` 灌入 `page_contents`：`title="第N页"`、`topic=""`、`tags=[]`、`text=raw`、`source="parsed"`、`status="draft"`、`raw_text_hash=source_hash`。老资料不重跑也有数据，标记为「未梳理」。

## 7. LLM 契约

### 7.1 梳理（digest，4 页一窗）

输入：本窗 4 页 raw（**页文本 <600 字即附页图**，图上限 = 窗页数 4）+ 前 1 页整理稿尾部 300 字 + 后 1 页 raw 前 100 字。

```json
{"pages": [{"page_no": 6, "title": "监督学习与KNN", "topic": "用距离度量做分类",
            "tags": ["KNN", "距离度量", "分类"], "text": "整理后的原文"}]}
```

规则：只修错字、断行、串行、重复序号、乱码；不改写、不扩写、不删知识点；拿不准保留原样。tags 2–6 个、2–8 字、名词短语。

校验：页号集合必须与窗口完全一致；缺页/多页/越界 → 该窗失败并记录，不静默补空。

### 7.2 校准（calibrate，4 页一窗 + 前后各 1 页）

```json
{"fixes": [{"page_no": 7, "text": "修正后的整理稿", "reason": "OCR 把「向量」识别成「向置」"}],
 "issues": [{"page_no": 8, "kind": "ocr|order|tag|flow", "detail": "一句话"}],
 "tags": ["本窗出现的标签"]}
```

tag 归并（整册一次或分批 + 两轮合并）：

```json
{"a": "a", "c": "a"}
```

规则：映射自身闭合（`a→a`）；只合并同义/近义；不得把上下位概念合并（「变量」与「变量作用域」必须分开）。报告给 `tag_stats: {before, after, merged}` 与完整 `tag_map` 供老师否决。

### 7.3 讲解稿（script，4 页一窗）

输入：本窗整理稿（title/topic/tags/text）+ 碎片页图 + 600 字状态（术语表 40 条 + 已用开头句式 + 上一窗末尾 120 字）+ 后 2 页纯文本前瞻（title + 开头 80 字，无图）。

```json
{"pages": [{"page_no": 6, "text": "口播稿", "bridge_in": "承接上一页的一句", "anchors": ["原文锚点"]}]}
```

校验：每页 240–360 字（越界记 warning 不失败）；`anchors` ≤6 条、每条 ≤200 字；页号集合必须一致。

## 8. 阶段计划

### P0 · 契约与文档（0.5–1 天）

- `docs/api-contract.md`：`POST /narrations/digest`（202 + `{job}`）、`GET /narrations` 增 `title/topic/tags/raw_text`、校准报告增 `fixes/tag_map/tag_stats`、job 增 `stage`。
- `docs/content-authoring.md`：三层文本定义、「轻优化」允许边界、tag 命名与归并规则、窗口信息预算表。
- `docs/architecture.md`：四段流水线 + 后台 stage 链 + 单进程假设。
- 产出：三个 JSON schema 定稿，后续代码按此写。

### P1 · 数据模型与迁移（1–2 天）

- `backend/app/narration/models.py`：`PageContent`、`MaterialTagDict`。
- `backend/app/narration/repository.py`：`content_row/content_rows/upsert_content/visible_contents/sync_content_staleness/canonical_tags/record_tag_map`。
- alembic 一个新版本：建表 + backfill + 索引 + 唯一约束。
- 测试：迁移 up/down、backfill 页数一致、`sync_content_staleness`（重传文件后整理稿转 stale）。
- 验证：`pytest tests/test_narration_content.py`；迁移在本地临时库上跑 up → down → up。

### P2 · 「梳理文本」任务（2–3 天）

- `jobs.py`：新增 operation `digest`；`task_commands.py`：`digest_deck()`（入队 + 前置校验）+ `run_digest()`（逐窗循环、每窗 commit + beat）。
- 窗口：`WINDOW_DIGEST=4`；`input_policy` 增 `purpose="digest"`（**<600 字发图**，4 页窗图上限 = 4，实测零超限）。
- 每页写入 `image_state`：`sent` / `policy`（按策略不发图）/ `skipped`；渲染失败记 `render_failed` **并让该页失败**，不落整理稿。
- 幂等：页级 `input_hash = sha256(raw_text_hash + prompt 指纹 + 模型 + effort)`；整册 `DIGEST_VERSION="digest-v1"` + 页 revision 组成 deck 指纹，未变则零调用。
- 失败：单窗失败记 `failed: [{page_no, error}]`，续跑按页重入队（复用 `retry_pages`）。
- 测试：`tests/test_narration_digest.py`（缺页拒绝、越界拒绝、幂等复用、断点续跑、图片策略、失败不写半截）。
- 前端可见结果：审校页显示整理稿；进度 `done/total` 以窗计。

### P3 · 校准改造（3–4 天，风险最高）

- `calibrate.py`：
  - 输入改为「整理稿 + raw 对照 + 前后各 1 页」且**图上限 = 窗页数**，输出 `fixes/issues/tags`；
  - 新增 `FIX_VERSION`、`CALIBRATE_VERSION="cal-v3"`；
  - `apply` 语义改为「应用 fixes 到 `page_contents`（`status=draft`）+ 写入 tag 字典」，不再触发讲解稿重生成；
  - `fixes` 应用前校验：页号在窗口内、长度差 ≤30%、不含新增知识（用「原文片段必须大部分保留」做规则校验），不通过则降级为 issue 不落库。
- tag 归并：整册标签 → 分批调用 → 两轮合并 → `report["tag_map"]` + `material_tag_dicts`。
- 报告字段：`fixes`（含 before/after）、`fixes_applied`、`tag_map`、`tag_stats`、`usage`。
- 旧代码下线：讲解稿审计（`participating` 基于 `page_narrations`）改为「整理稿参与」；保留 `issues` 字段但只记 flow/tag/ocr。
- 测试：`test_narration_calibration.py` 重写为「整理稿校准」语义；新增 fixes 越界拒绝、长度差拒绝、tag 映射闭合、报告不含则 apply 拒绝。
- 风险：这是对现有 18 个用例的语义重写，必须先跑旧用例基线再改。

### P3.5 · 窗口化对照实验（1–2 天）

4 组 × 同一 20 页（第 1 讲第 1–20 页），同模型、同 effort、同 `target_seconds`：

| 组 | 输入 |
| --- | --- |
| A | 现状：逐页 + 前 4 页稿全文 + 上一页尾 120 字 |
| B | 5 页窗 + 前 5 页稿全文 + 后 3 页原文 |
| C | 5 页窗 + 600 字状态 + 2 页纯文本前瞻 |
| D | 4 页窗 + 600 字状态 + 2 页纯文本前瞻 |

指标：字数达标率（260–340）、同窗 8-gram 重复率、前向引用错误数（人工抽 10 处）、术语不一致数、prompt/completion、缓存命中、单窗延迟、`length` 次数、超图次数。

判定（先写死）：D 字数达标率 ≥ A 的 90% 且重复率降 ≥30% → 采用 D；D 明显变薄 → 退回 A，只在同 topic/tag 重合 ≥2 的邻域用 6 页窗。

过程数据记录在本地忽略目录，不纳入 Git；结论回写到本文件与[内容规范](../content-authoring.md)。

真实基线（用于对比，已实测）：4 页窗零超图；开思考单窗最长 33.5 s；`shrunk_windows` 为空。

### P3.6 · 放大前必须补的兜底（1–2 天）

- `finish_reason=length` 自动重试一次（缩窗或降页数），仍失败才报错。
- **取消静默图片截断**：所有窗口的 `image_limit` = 窗页数；`_window_payload` 不再无声丢图，缺图必须写 `image_state` 并在报告汇总「N 页未带图」。
- 单窗超时按窗重试 + 断点续跑（lease/heartbeat 已有）。
- 测试：`test_narration_regressions.py` 增 length 重试、图上限不截断、`image_state` 落库、超时重试。

### P4 · 讲解稿窗口生成（2–3 天）

- 新 operation `script`；`prompts.py` 升 `narr-v6`（输入从 raw 变整理稿，幂等键必变，需提前告知全量重生成成本）。
- 窗口：4 页 + 600 字状态 + 2 页纯文本前瞻（按 P3.5 结论可调）。
- 落库：`PageNarration` 不变；`input_hash` = 窗口 hash + 页内序 + prompt 指纹 + 模型 + effort + 上文 hash。
- 单页返工：保留逐页接口，注入同窗其余 3 页稿作为上下文，避免风格跳。
- 链：`digest → calibrate → script`，`progress.chain` 驱动；进程重启后 `status=done` 且 `chain_remaining` 非空的任务继续。
- 测试：窗口切分/缺页、跨页不重复、anchors 上限、单页返工、链式续跑、重启恢复。
- 验证：真机 103 页（假模型 stub）全链跑通，记录调用数、耗时、`length` 次数。

### P5 · 前端（2–3 天）

`admin/src/features/materials/narration/`：

- 按钮合并为「一键梳理文本」+ 进度条三段（梳理 → 校准 → 讲解稿）；保留「接受全部草稿」「批量合成音频」。
- 审校页：原文区显示整理稿；新增「查看原始文本」折叠（只读 raw）；顶部显示可编辑 `title` / `tags`（手工改 tag 落库，`source="teacher"`）；`image_state != sent` 时显示「本页无图证据」徽标。
- 校准页：新增「原文修正」diff 表（前/后并排 + 原因）与「tag 合并」表（`c → a`，可勾选否决）。
- 失败展示：`failed` 页码列表 + 原因；「校准完成自动应用」需在 UI 明确说明。
- 测试：`narration-review.test.tsx` 增三段进度、fixes/tag 表格渲染、折叠原始文本、tag 编辑提交。

### P6 · 下游与 RAG 契约（1–2 天）

| 消费方 | 改动 |
| --- | --- |
| `assistant_context.py` | 原文取整理稿；raw 与讲解稿分开标注 |
| `course_packages/narration_contract.py` | **本轮不动**（暂缓，等课程包负责人确认版本与字段） |
| `LectureStage.vue` | 不变（仍用讲解稿） |
| RAG | 只定契约：chunk = 一页，`page_id = material_id:page_no`；`tags_canonical` 作过滤维度；embedding 与检索接口本轮不引入 |

### P7 · 验证（1–2 天）

- 单测：窗口切分、缺页/越界、tag 映射闭合、fixes 校验、幂等、迁移 up/down、backfill、链式续跑。
- 集成（真课件 103 页 + 假模型）：梳理 26 窗 → 校准 26 窗 → 讲解稿 26 窗 → 音频抽 5 页；记录调用数/耗时/缓存。
- 文档：`node scripts/check-docs.mjs`、`git diff --check`。
- 后端：`ruff check app tests`、`mypy`（narration 严格）、相关 pytest。
- 前端：`npx vitest run`、`npx tsc --noEmit`。

## 9. 成本与缓存

- 窗口化的成本收益来自「少发重复前缀与历史」，不是缓存命中（前缀命中率两边都约 39%）。
- 每页输入：现状串行 ≈ 1800 tokens → 窗口化 ≈ 550 tokens（按实测 830 tokens/页 + 1000 历史推算）。
- 真实数据：整册原文 9383 字，接近单窗 9000 字预算 → 文本从来不是瓶颈；瓶颈是碎片页图片（57/103 页 <60 字）。
- 梳理阶段把发图阈值提到 600，多出 31 页（60–199 字）带图 ≈ **+28k tokens/册**（按 ~900 tokens/图），一册只跑一次。

## 10. 风险

1. **`narr-v6` 幂等键全量失效**：整理稿一换，所有讲解稿必重跑一次，属一次性成本，须提前告知。
2. **P3 是对现有校准语义的重写**：18 个用例需重写，先跑基线。
3. **自动应用 fixes 无人工确认**：靠「长度差 ≤30% + 原文片段保留」规则校验 + `status=draft` + 报告 diff 兜底；学生端仍只接受 accepted。
4. **窗口失败面**：一窗 4 页，`failed` 必须记页码，重试按页。
5. **tag 过度合并**：`c → a` 必须可视、可否决，不静默生效。
6. **链式任务卡住**：stage 之间靠 `chain_remaining` 恢复；若进程在两次 enqueue 之间死掉，靠启动扫描补跑。
7. **缺图不可察觉**：原文整理时缺图不会报错，只会让整理稿永久缺块，并被后续校准/讲解/RAG 继承。对策：发图阈值按阶段分级（梳理 600）、图上限 = 窗页数、`image_state` 落库并在审校页/报告里展示；梳理阶段渲染失败直接算该页失败。

## 11. 剩余待确认（不阻塞 P0/P1）

1. 旧资料 backfill 的页是否保留 `source="parsed"` 作为「未梳理」标记。
   作用：① RAG/助教注入时可标注「此页尚未梳理，内容为原始解析文本」，避免模型把 OCR 噪声当教材；
   ② 后台能显示「已梳理 X/Y 页」，支持只对未梳理页跑 digest；
   ③ 区分 `source` 变化（parsed → ai）才能判断「是否真的梳理过」。
   若不需要该中间态，可改为迁移时不 backfill（老资料在梳理前没有 title/tags 可显示）。建议保留。

已确认：自动应用原文修正（接受）；课程包导出暂缓。
