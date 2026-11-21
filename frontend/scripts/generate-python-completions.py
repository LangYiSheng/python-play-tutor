#!/usr/bin/env python3
"""Generate lazy Python stdlib member completions for the browser editor.

Run with the Python 3.12 used by the local Pyodide runtime:

    python scripts/generate-python-completions.py

The generated JSON is checked in, so the frontend build does not need Python.
Re-run this script after changing the Pyodide/Python runtime. Module names come
from ``sys.stdlib_module_names``; function signatures and first-line docstrings
come from ``inspect``. No member list is maintained by hand.
"""
from __future__ import annotations

import importlib
import inspect
import json
import re
import sys
from pathlib import Path

OUTPUT = Path(__file__).resolve().parent.parent / "public" / "python-completions"
SKIP_MODULES = {
    "antigravity",
    "ensurepip",
    "idlelib",
    "pydoc",
    "test",
    "this",
    "tkinter",
    "turtle",
    "turtledemo",
    "venv",
    # Windows-only modules are not importable in the Pyodide Linux runtime.
    "msilib",
    "msvcrt",
    "nt",
    "ntpath",
    "nturl2path",
    "winreg",
    "winsound",
}


def text(value: object, limit: int) -> str:
    cleaned = " ".join(str(value).split())
    return cleaned[:limit]


def member(name: str, value: object) -> dict[str, object] | None:
    if name.startswith("_") or inspect.ismodule(value):
        return None
    if inspect.isclass(value):
        kind = "class"
    elif callable(value):
        kind = "function"
    else:
        kind = "constant"
    signature = ""
    doc = "" if kind == "constant" else text(inspect.getdoc(value) or "", 160)
    if kind != "constant":
        try:
            signature = text(inspect.signature(value), 120)
        except (TypeError, ValueError):
            signature = ""
        if not signature:
            leading = re.match(rf"{re.escape(name)}\(([^)]*)\)", doc)
            if leading:
                signature = f"({leading.group(1)})"
    return {"name": name, "kind": kind, "signature": signature, "doc": doc}


def module_data(name: str, value: object) -> list[dict[str, object]]:
    members = []
    for member_name in dir(value):
        try:
            item = member(member_name, getattr(value, member_name))
        except Exception:
            continue
        if item is not None:
            members.append(item)
    return sorted(members, key=lambda row: str(row["name"]).lower())


def main() -> None:
    if not hasattr(sys, "stdlib_module_names"):
        raise SystemExit("需要 Python 3.10+ 的 sys.stdlib_module_names")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for stale in OUTPUT.glob("*.json"):
        stale.unlink()

    generated: list[str] = []
    for name in sorted(sys.stdlib_module_names):
        if name.startswith("_") or name in SKIP_MODULES:
            continue
        try:
            module = importlib.import_module(name)
            members = module_data(name, module)
        except Exception:
            continue
        if not members:
            continue
        (OUTPUT / f"{name}.json").write_text(
            json.dumps({"name": name, "members": members}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )
        generated.append(name)

    (OUTPUT / "manifest.json").write_text(
        json.dumps({"python": sys.version.split()[0], "modules": generated}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    total = sum(path.stat().st_size for path in OUTPUT.glob("*.json"))
    print(f"Generated {len(generated)} stdlib modules, {total / 1024:.0f} KiB, in {OUTPUT}")


if __name__ == "__main__":
    main()
