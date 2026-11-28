请根据以下章节课件内容与约束，命制 1 道原创且可直接自动评测的 Python 编程题：
- 目标章节：{chapter_label}
- 编程形式：{coding_type_label}（coding_type = "{coding_type}"）
- 目标难度：{difficulty}（必须真实体现「{difficulty}」的思维复杂度）
- 教学用途：{usage}

{type_rules}
{syntax_constraint}
{knowledge}
{avoid}

章节参考材料（仅可基于以下材料涵盖的知识命题，严禁超纲；`page_number` 填题目最主要依据的材料编号）：
{notes}

请严格按以下 JSON 结构输出（`reasoning` 为精炼内部校验草稿，入库自动丢弃；其余字段均为必填）：
{{
  "reasoning": "【内部构思与沙箱预检，精炼3-5句】① 选定的新微场景与考点；② 核对未超纲、无参 input() 与沙箱安全；③ 确认 starter_code 在公开样例上无法通过（fill_code 确认骨架逐字一致）；④ 确认 3+5 组用例互不重复且覆盖五类边界。",
  "title": "简短明确的题目标题（8–28字，体现场景或核心任务）",
  "coding_type": "{coding_type}",
  "difficulty": "{difficulty}",
  "usage": "{usage}",
  "knowledge_points": ["从本章知识点清单原名中选择1至3个"],
  "tags": ["考点标签1", "考点标签2"],
  "page_number": 1,
  "prompt": "【题目描述】...\n【输入格式】...\n【输出格式】...",
  "starter_code": "...",
  "reference_solution": "...",
  "hints": ["提示1（拆解问题思路方向）", "提示2（关键语法或边界提醒，不直接给完整代码）"],
  "explanation": "解题思路：...\n关键细节：...\n易错提醒：...（70–220字纯文本分段，禁用**等Markdown符号，客观第三人称，严禁草稿独白或引用课件页码）",
  "samples": [
    {{"input": "公开输入1\n", "expected_output": "公开输出1\n"}},
    {{"input": "公开输入2\n", "expected_output": "公开输出2\n"}},
    {{"input": "公开输入3\n", "expected_output": "公开输出3\n"}}
  ],
  "hidden_cases": [
    {{"input": "隐藏输入1（常规值）\n", "expected_output": "隐藏输出1\n"}},
    {{"input": "隐藏输入2（零值/空或单元素）\n", "expected_output": "隐藏输出2\n"}},
    {{"input": "隐藏输入3（临界阈值相等）\n", "expected_output": "隐藏输出3\n"}},
    {{"input": "隐藏输入4（负数或极值）\n", "expected_output": "隐藏输出4\n"}},
    {{"input": "隐藏输入5（格式/精度/大小写边界）\n", "expected_output": "隐藏输出5\n"}}
  ]
}}
仅输出 JSON。
