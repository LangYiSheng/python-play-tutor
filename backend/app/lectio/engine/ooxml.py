"""Pure stdlib OOXML (.docx / .xlsx) builders with no third-party dependencies."""

from __future__ import annotations

import io
import re
import zipfile
from collections.abc import Sequence
from typing import Any
from xml.sax.saxutils import escape

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" '
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    "</Types>"
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
    'Target="word/document.xml"/>'
    "</Relationships>"
)

DOC_RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" '
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
    'Target="styles.xml"/>'
    "</Relationships>"
)

W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'

BAD_XML_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def clean_xml_text(value: Any) -> str:
    """Strip XML 1.0 illegal control characters."""
    return BAD_XML_RE.sub("", str(value or ""))


def xml_escape(value: Any, entities: dict[str, str] | None = None) -> str:
    """Sanitize control chars and XML-escape text."""
    return escape(clean_xml_text(value), entities or {})


def docx_style(
    style_id: str,
    name: str,
    size: int,
    *,
    bold: bool = False,
    before: int = 0,
    after: int = 120,
    extra: str = "",
    based: bool = True,
    east_asia_font: str = "微软雅黑",
    line: int = 400,
    color: str = "",
) -> str:
    """Build a single OOXML paragraph style element."""
    default_attr = ' w:default="1"' if style_id == "Normal" else ""
    based_xml = '<w:basedOn w:val="Normal"/>' if based and style_id != "Normal" else ""
    bold_xml = "<w:b/>" if bold else ""
    color_xml = f'<w:color w:val="{color}"/>' if color else ""
    return (
        f'<w:style w:type="paragraph" w:styleId="{style_id}"{default_attr}>'
        f'<w:name w:val="{name}"/>'
        f"{based_xml}"
        f'<w:pPr><w:spacing w:before="{before}" w:after="{after}" w:line="{line}" w:lineRule="auto"/>{extra}</w:pPr>'
        f'<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="{east_asia_font}"/>'
        f'{bold_xml}{color_xml}<w:sz w:val="{size}"/><w:szCs w:val="{size}"/></w:rPr></w:style>'
    )


STYLES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f"<w:styles {W_NS}>"
    + docx_style("Normal", "Normal", 22)
    + docx_style("Title", "Title", 40, bold=True, after=320, extra='<w:jc w:val="center"/>')
    + docx_style("Heading1", "heading 1", 28, bold=True, before=360, after=160, extra='<w:keepNext/><w:outlineLvl w:val="0"/>')
    + docx_style("Heading2", "heading 2", 24, bold=True, before=200, after=100, extra='<w:keepNext/><w:outlineLvl w:val="1"/>')
    + docx_style("Body", "Body", 22, extra='<w:ind w:firstLine="440"/>')
    + docx_style("Bullet", "Bullet", 22, after=60, extra='<w:ind w:left="440" w:hanging="220"/>')
    + docx_style(
        "Quote",
        "Quote",
        21,
        extra='<w:ind w:left="440"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BBBBBB"/></w:pBdr>',
    )
    + "</w:styles>"
)


def docx_paragraph(text: str, style: str = "Normal") -> str:
    """Create a styled OOXML paragraph node."""
    safe = xml_escape(text)
    return f'<w:p><w:pPr><w:pStyle w:val="{style}"/></w:pPr><w:r><w:t xml:space="preserve">{safe}</w:t></w:r></w:p>'


def build_docx_zip(
    body_parts: Sequence[str],
    *,
    styles_xml: str = STYLES,
    margin: int = 1440,
) -> bytes:
    """Pack OOXML paragraph/table fragments into a valid .docx byte archive."""
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f"<w:document {W_NS}><w:body>"
        + "".join(body_parts)
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        f'<w:pgMar w:top="{margin}" w:right="{margin}" w:bottom="{margin}" w:left="{margin}" '
        'w:header="720" w:footer="720" w:gutter="0"/>'
        "</w:sectPr></w:body></w:document>"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", CONTENT_TYPES)
        archive.writestr("_rels/.rels", RELS)
        archive.writestr("word/_rels/document.xml.rels", DOC_RELS)
        archive.writestr("word/styles.xml", styles_xml)
        archive.writestr("word/document.xml", document)
    return buffer.getvalue()


def _column_letter(index: int) -> str:
    name = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        name = chr(65 + rem) + name
    return name


def _resolve_widths(rows: Sequence[Sequence[Any]], widths: Sequence[int] | None) -> list[int]:
    max_cols = max((len(r) for r in rows), default=1)
    if widths is not None:
        return (list(widths) + [18] * max_cols)[:max_cols]
    return [18] * max_cols


def _xlsx_styles_xml(header_fill: str = "") -> str:
    color = re.sub(r"[^0-9A-Fa-f]", "", (header_fill or "").lstrip("#")).upper()
    fills = [
        '<fill><patternFill patternType="none"/></fill>',
        '<fill><patternFill patternType="gray125"/></fill>',
    ]
    header_xf = '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    if len(color) in (6, 8):
        rgb = color if len(color) == 8 else f"FF{color}"
        fills.append(f'<fill><patternFill patternType="solid"><fgColor rgb="{rgb}"/></patternFill></fill>')
        header_xf = '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>'
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="微软雅黑"/></font>'
        '<font><b/><sz val="11"/><name val="微软雅黑"/></font></fonts>'
        f'<fills count="{len(fills)}">{"".join(fills)}</fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        f'<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>{header_xf}</cellXfs>'
        "</styleSheet>"
    )


def _worksheet_xml(rows: Sequence[Sequence[Any]], widths: Sequence[int] | None = None) -> str:
    col_widths = _resolve_widths(rows, widths)
    cols = "".join(f'<col min="{i}" max="{i}" width="{w}" customWidth="1"/>' for i, w in enumerate(col_widths, 1))
    cols_xml = f"<cols>{cols}</cols>" if cols else ""
    body: list[str] = []
    for r, row in enumerate(rows, 1):
        style = ' s="1"' if r == 1 else ""
        cells = "".join(
            f'<c r="{_column_letter(c)}{r}" t="inlineStr"{style}>'
            f'<is><t xml:space="preserve">{xml_escape(value)}</t></is></c>'
            for c, value in enumerate(row)
        )
        body.append(f'<row r="{r}">{cells}</row>')
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        f'{cols_xml}<sheetData>{"".join(body)}</sheetData></worksheet>'
    )


def _safe_sheet_name(name: str, used: set[str], fallback: str) -> str:
    cleaned = re.sub(r'[:\\/?*\[\]]+', "_", clean_xml_text(name)).strip()[:31] or fallback
    cand = cleaned
    n = 2
    while cand in used:
        suffix = f"_{n}"
        cand = cleaned[: max(1, 31 - len(suffix))] + suffix
        n += 1
    used.add(cand)
    return cand


def build_xlsx_sheets(
    sheets: Sequence[tuple[str, Sequence[Sequence[Any]], Sequence[int] | None]],
    header_fill: str = "",
) -> bytes:
    """Build a multi-sheet .xlsx workbook using stdlib zipfile only."""
    if not sheets:
        return build_xlsx([[]], header_fill=header_fill)
    used_names: set[str] = set()
    sheet_entries: list[tuple[int, str, str]] = []
    for idx, (raw_name, rows, widths) in enumerate(sheets, 1):
        sname = _safe_sheet_name(raw_name, used_names, f"Sheet{idx}")
        sheet_entries.append((idx, sname, _worksheet_xml(rows, widths)))

    overrides = "".join(
        f'<Override PartName="/xl/worksheets/sheet{idx}.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        for idx, _, _ in sheet_entries
    )
    sheet_tags = "".join(
        f'<sheet name="{xml_escape(sname, {chr(34): "&quot;"})}" sheetId="{idx}" r:id="rId{idx}"/>'
        for idx, sname, _ in sheet_entries
    )
    style_rid = len(sheet_entries) + 1
    wb_rels = "".join(
        f'<Relationship Id="rId{idx}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        f'Target="worksheets/sheet{idx}.xml"/>'
        for idx, _, _ in sheet_entries
    ) + (
        f'<Relationship Id="rId{style_rid}" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    )

    files: dict[str, str] = {
        "[Content_Types].xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            f"{overrides}"
            '<Override PartName="/xl/styles.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" '
            'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="xl/workbook.xml"/>'
            "</Relationships>"
        ),
        "xl/workbook.xml": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f"<sheets>{sheet_tags}</sheets></workbook>"
        ),
        "xl/_rels/workbook.xml.rels": (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            f'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{wb_rels}</Relationships>'
        ),
        "xl/styles.xml": _xlsx_styles_xml(header_fill),
    }
    for idx, _, xml in sheet_entries:
        files[f"xl/worksheets/sheet{idx}.xml"] = xml

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return buf.getvalue()


def build_xlsx(
    rows: Sequence[Sequence[Any]],
    sheet_name: str = "习题",
    widths: Sequence[int] | None = None,
    header_fill: str = "",
) -> bytes:
    """Build a single-sheet .xlsx workbook."""
    return build_xlsx_sheets([(sheet_name, rows, widths)], header_fill=header_fill)
