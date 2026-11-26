"""Render one PDF page to a bounded JPEG so the model can read what the text layer lost.

Measured on a real lecture deck: 85% of slides carry fewer than 200 characters of text,
and 51% effectively none. The image is therefore the primary input for `presentation`
material; the text layer only supplies anchors.

Poppler builds differ (the Windows 25.02 build has no `-jpeg`), so pages are rendered to
PNG and encoded here — uniform across platforms and keeps the quality knob in one place.
"""

import io
import os
import shutil
import subprocess
import tempfile
from collections import OrderedDict
from pathlib import Path
from threading import Lock

from ..models import Material
from app.materials.storage import get_storage, storage_root

TARGET_WIDTH = 1600  # 16:9 -> 900 high, ~1.44M px, still inside the provider's per-image token cap
JPEG_QUALITY = 82
MAX_BYTES = 3 * 1024 * 1024
TIMEOUT_SECONDS = 60
_CACHE_LIMIT = 48
_PAGE_CACHE: OrderedDict[tuple[str, str, int], bytes] = OrderedDict()
_PAGE_CACHE_LOCK = Lock()

_WINRT_RENDER_SCRIPT = r"""
param([string]$PdfPath, [int]$PageNo, [string]$OutPath, [int]$TargetWidth)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
})[0]
function AwaitOp($op, $resultType) {
  $task = $asTaskGeneric.MakeGenericMethod($resultType).Invoke($null, @($op))
  $task.Wait() | Out-Null
  return $task.Result
}
function AwaitAct($act) {
  $task = $asTaskAction.Invoke($null, @($act))
  $task.Wait() | Out-Null
}
[void][Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime]
[void][Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType=WindowsRuntime]
[void][Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]

$file = AwaitOp ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
$doc = AwaitOp ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
if ($PageNo -lt 1 -or $PageNo -gt $doc.PageCount) { exit 2 }
$page = $doc.GetPage([uint32]($PageNo - 1))
$opts = New-Object Windows.Data.Pdf.PdfPageRenderOptions
$opts.DestinationWidth = [uint32]$TargetWidth
$stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
AwaitAct ($page.RenderToStreamAsync($stream, $opts))
$size = [uint32]$stream.Size
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
[void](AwaitOp ($reader.LoadAsync($size)) ([uint32]))
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($OutPath, $bytes)
$reader.Dispose(); $stream.Dispose(); $page.Dispose()
"""


def _render_with_windows_winrt(source: Path, page_no: int, out_png: Path, tmp: Path) -> bool:
    """Render one PDF page on local Windows using built-in WinRT Windows.Data.Pdf (zero external tools)."""
    ps = shutil.which("powershell.exe") or shutil.which("powershell")
    if not ps:
        return False
    script = tmp / "winrt_pdf_page.ps1"
    script.write_text(_WINRT_RENDER_SCRIPT, encoding="utf-8")
    try:
        proc = subprocess.run(
            [
                ps,
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(script),
                "-PdfPath",
                str(source.resolve()),
                "-PageNo",
                str(page_no),
                "-OutPath",
                str(out_png.resolve()),
                "-TargetWidth",
                str(TARGET_WIDTH),
            ],
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ValueError("页图渲染超时") from exc
    if proc.returncode == 2:
        raise ValueError("页图渲染失败，可能页码超出范围")
    return proc.returncode == 0 and out_png.exists() and out_png.stat().st_size > 0


def source_key(material: Material) -> str | None:
    """The converted preview is what students read, so it is what the teacher narrates."""
    content = material.content or {}
    preview = content.get("preview_key")
    if isinstance(preview, str) and preview.strip():
        return preview
    return material.storage_key


def render_page_pdf(material: Material, page_no: int) -> bytes | None:
    """Slice one exact PDF page so browser preview stays strictly synced to page_no."""
    if page_no < 1:
        return None
    key = source_key(material)
    if not key or not key.lower().endswith(".pdf"):
        return None
    from pypdf import PdfReader, PdfWriter

    storage = get_storage()
    with tempfile.TemporaryDirectory(prefix="narr-pdf-", dir=storage_root()) as tmp_name:
        source = Path(tmp_name) / "source.pdf"
        try:
            storage.copy_to(key, source)
        except (FileNotFoundError, OSError):
            return None
        reader = PdfReader(str(source))
        if page_no > len(reader.pages):
            return None
        writer = PdfWriter()
        writer.add_page(reader.pages[page_no - 1])
        buf = io.BytesIO()
        writer.write(buf)
        return buf.getvalue()


def render_page(material: Material, page_no: int) -> bytes | None:
    """Return JPEG bytes for one page, or None when the material has no readable source."""
    if page_no < 1:
        raise ValueError("页图渲染失败，可能页码超出范围")
    key = source_key(material)
    if not key or not key.lower().endswith(".pdf"):
        return None
    cache_key = (str(storage_root()), key, page_no)
    with _PAGE_CACHE_LOCK:
        cached = _PAGE_CACHE.get(cache_key)
        if cached is not None:
            _PAGE_CACHE.move_to_end(cache_key)
            return cached

    binary = shutil.which("pdftoppm")
    use_winrt = binary is None and os.name == "nt"
    if binary is None and not use_winrt:
        raise ValueError("缺少 PDF 渲染工具（poppler-utils），无法生成页图")
    storage = get_storage()
    with tempfile.TemporaryDirectory(prefix="narr-", dir=storage_root()) as tmp_name:
        tmp = Path(tmp_name)
        source = tmp / "source.pdf"
        storage.copy_to(key, source)
        if binary is not None:
            prefix = tmp / f"page-{page_no}"
            command = [binary, "-png", "-f", str(page_no), "-l", str(page_no),
                       "-scale-to-x", str(TARGET_WIDTH), "-scale-to-y", "-1", str(source), str(prefix)]
            try:
                subprocess.run(command, check=True, timeout=TIMEOUT_SECONDS, capture_output=True)
            except subprocess.TimeoutExpired as exc:
                raise ValueError("页图渲染超时") from exc
            except subprocess.CalledProcessError as exc:
                raise ValueError("页图渲染失败，可能页码超出范围") from exc
            produced = sorted(tmp.glob("page-*.png"))
            if not produced:
                return None
            encoded = _encode(produced[0])
        else:
            out_png = tmp / f"page-{page_no}.png"
            if not _render_with_windows_winrt(source, page_no, out_png, tmp):
                raise ValueError("缺少 PDF 渲染工具（poppler-utils），无法生成页图")
            encoded = _encode(out_png)

    with _PAGE_CACHE_LOCK:
        _PAGE_CACHE[cache_key] = encoded
        _PAGE_CACHE.move_to_end(cache_key)
        while len(_PAGE_CACHE) > _CACHE_LIMIT:
            _PAGE_CACHE.popitem(last=False)
    return encoded


def _encode(png: Path) -> bytes:
    """JPEG keeps a 1600x900 slide around 200KB, well under the request budget."""
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - Pillow is a locked dependency
        raise ValueError("缺少图片编码依赖，无法生成页图") from exc
    buffer = io.BytesIO()
    with Image.open(png) as image:
        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
            rgba = image.convert("RGBA")
            canvas = Image.new("RGB", rgba.size, (255, 255, 255))
            canvas.paste(rgba, mask=rgba.split()[3])
            canvas.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        else:
            image.convert("RGB").save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
    data = buffer.getvalue()
    if len(data) > MAX_BYTES:
        raise ValueError("页图过大，无法作为讲解输入")
    return data
