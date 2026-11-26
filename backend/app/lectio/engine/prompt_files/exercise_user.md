请基于以下材料内容生成试题。
{blocks}
{knowledge}返回 JSON 对象格式：
{{
  "questions": [
    {{
      "type": "single|multiple|judge|blank|short",
      "question": "...",
      "page_number": "...",
      "options": {{"a": "...", "b": "...", "c": "...", "d": "..."}},
      "answer": "a" 或 ["a", "c"] 或 "唯一标准答案" 或 "参考答案要点...",
      "explanation": "...",
      "knowledge_points": ["...", "..."]
    }}
  ],
  "summary": "本章核心要点简要总结"
}}
注意：若题型为填空题（blank），题干中只能有且仅有 1 个 ____ 空位，answer 填该单空的标准答案字符串。
仅输出 JSON。

材料内容：
{notes}
