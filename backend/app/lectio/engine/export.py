"""Pure in-memory Markdown and Word (.docx) exporters for source digests and scripts."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass

from .ooxml import build_docx_zip, docx_paragraph
from .text_utils import strip_pause_marks

EXPORT_KINDS: dict[str, str] = {
    "source": "整理稿",
    "script": "口播讲稿",
}

FORMATS: dict[str, str] = {
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "md": "text/markdown",
}


@dataclass
class ExportPage:
    """One exportable page from PageContent or PageNarration."""

    index: int
    topic: str = ""
    section: str = ""
    text: str = ""


def parse_blocks(text: str) -> list[tuple[str, str]]:
    """Split page text into simple OOXML block tuples (kind, content)."""
    blocks: list[tuple[str, str]] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or re.fullmatch(r"-{3,}|\*{3,}", line):
            continue
        heading = re.match(r"^#{1,6}\s+(.*)$", line)
        bullet = re.match(r"^(?:[-*+]|\d+[.、)])\s+(.*)$", line)
        quote = re.match(r"^>\s?(.*)$", line)
        if heading:
            blocks.append(("heading", _plain(heading.group(1))))
        elif bullet:
            blocks.append(("bullet", _plain(bullet.group(1))))
        elif quote:
            if quote.group(1).strip():
                blocks.append(("quote", _plain(quote.group(1))))
        else:
            blocks.append(("paragraph", _plain(line)))
    return blocks


def _plain(text: str) -> str:
    t = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    t = re.sub(r"__(.+?)__", r"\1", t)
    t = re.sub(r"`([^`]+)`", r"\1", t)
    return t.strip()


def page_heading(page: ExportPage) -> str:
    """Format a page heading line."""
    return f"第 {page.index} 页" + (f"　{page.topic}" if page.topic else "")


def _clean_pages(pages: Sequence[ExportPage], kind: str) -> list[ExportPage]:
    if kind not in EXPORT_KINDS:
        raise ValueError("kind 只能是 source 或 script")
    cleaned: list[ExportPage] = []
    for p in pages:
        text = (p.text or "").strip()
        if kind == "script":
            text = strip_pause_marks(text).strip()
        if not text:
            continue
        cleaned.append(ExportPage(index=p.index, topic=p.topic.strip(), section=p.section.strip(), text=text))
    return cleaned


def build_markdown(title: str, pages: Sequence[ExportPage], kind: str = "script") -> str:
    """Render cleaned pages to UTF-8 Markdown."""
    cleaned = _clean_pages(pages, kind)
    label = EXPORT_KINDS[kind]
    out = [f"# {title} {label}", ""]
    for page in cleaned:
        out += [f"## {page_heading(page)}", "", page.text, ""]
    return "\n".join(out).rstrip() + "\n"


def build_docx(title: str, pages: Sequence[ExportPage], kind: str = "script") -> bytes:
    """Render cleaned pages to a Word (.docx) byte payload."""
    cleaned = _clean_pages(pages, kind)
    label = EXPORT_KINDS[kind]
    body: list[str] = [docx_paragraph(f"{title} {label}", "Title")]
    for page in cleaned:
        body.append(docx_paragraph(page_heading(page), "Heading1"))
        for block_kind, content in parse_blocks(page.text):
            if block_kind == "heading":
                body.append(docx_paragraph(content, "Heading2"))
            elif block_kind == "bullet":
                body.append(docx_paragraph("• " + content, "Bullet"))
            elif block_kind == "quote":
                body.append(docx_paragraph(content, "Quote"))
            else:
                body.append(docx_paragraph(content, "Body"))
    return build_docx_zip(body)
