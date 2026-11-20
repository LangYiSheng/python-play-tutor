"""Resolve the three supported dialogue fields in one pass over plain text."""

import re


DIALOGUE_FIELD = re.compile(r"(?<!\{)\{(name|course_name|chapter_name)\}(?!\})")


def render_dialogue(text, *, name, course_name, chapter_name):
    values = {"name": name, "course_name": course_name or "这门课程", "chapter_name": chapter_name or "本章"}
    return DIALOGUE_FIELD.sub(lambda match: values[match[1]], text)
