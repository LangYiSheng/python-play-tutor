请根据以下章节课件内容，命制 1 道 Python 编程题：
- 目标章节：{chapter_label}
- 编程形式：{coding_type_label}（coding_type = "{coding_type}"）
- 目标难度：{difficulty}（必须真实体现「{difficulty}」的思维复杂度）
- 教学用途：{usage}

{type_rules}
{syntax_constraint}
{knowledge}
{avoid}

章节参考材料（仅可基于以下材料涵盖的知识命题，严禁超纲；page_number 请填题目最主要依据的材料编号）：
{notes}

请严格按以下 JSON 结构输出（所有字段均为必填）：
{{
  "title": "简短明确的题目标题（8–28字）",
  "coding_type": "{coding_type}",
  "difficulty": "{difficulty}",
  "usage": "{usage}",
  "knowledge_points": ["从本章知识点原名中选择1至3个"],
  "tags": ["考点标签1", "考点标签2"],
  "page_number": 1,
  "prompt": "完整自包含题干，清晰分段包含【题目描述】【输入格式】【输出格式】",
  "starter_code": "...",
  "reference_solution": "...",
  "hints": ["提示1（思路方向）", "提示2（关键实现要点，不直接给答案）"],
  "explanation": "面向学生的详尽解析（不少于25字，讲清解题思路与易错点）",
  "samples": [
    {{"input": "输入1\n", "expected_output": "输出1\n"}},
    {{"input": "输入2\n", "expected_output": "输出2\n"}},
    {{"input": "输入3\n", "expected_output": "输出3\n"}}
  ],
  "hidden_cases": [
    {{"input": "隐藏输入1\n", "expected_output": "隐藏输出1\n"}},
    {{"input": "隐藏输入2\n", "expected_output": "隐藏输出2\n"}},
    {{"input": "隐藏输入3\n", "expected_output": "隐藏输出3\n"}},
    {{"input": "隐藏输入4\n", "expected_output": "隐藏输出4\n"}},
    {{"input": "隐藏输入5\n", "expected_output": "隐藏输出5\n"}}
  ]
}}
