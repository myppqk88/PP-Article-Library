"""Sticky notes storage (JSON sidecar, one file per paper).

Earlier versions of this module stamped highlights / underlines / sticky notes
directly into the PDF file via PyMuPDF. The user dropped highlight + underline
entirely (text selection on top of the PDF.js text layer was unreliable) and
asked for sticky notes to live in a plain JSON file next to the library, so
this module is now a thin JSON CRUD over `library/stickies/{paper_id}.json`.

Each file looks like:

    {
      "paper_id": "...",
      "stickies": [
        {
          "id": "20260514T143000-ab12cd",
          "content": "便签正文（自由 Markdown）",
          "created_at": "2026-05-14T14:30:00Z",
          "updated_at": "2026-05-14T14:30:00Z"
        }
      ]
    }

PyMuPDF is no longer imported here, which also lets the workbench start
without a working `fitz` install.
"""

from __future__ import annotations

import json
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from common import ROOT


STICKIES_DIR = ROOT / "library" / "stickies"


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
    return f"{stamp}-{secrets.token_hex(3)}"


def _path_for(paper_id: str) -> Path:
    paper_id = str(paper_id or "").strip()
    if not paper_id:
        raise ValueError("paper_id is required")
    # paper_id 已经在整理时清洗过文件名安全字符，这里再加一层保护：
    # 不允许 "/" / ".." 之类的路径片段。
    if "/" in paper_id or "\\" in paper_id or ".." in paper_id:
        raise ValueError("invalid paper_id")
    return STICKIES_DIR / f"{paper_id}.json"


def _load(paper_id: str) -> dict[str, Any]:
    path = _path_for(paper_id)
    if not path.exists():
        return {"paper_id": paper_id, "stickies": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"paper_id": paper_id, "stickies": []}
    if not isinstance(data, dict):
        return {"paper_id": paper_id, "stickies": []}
    stickies = data.get("stickies")
    if not isinstance(stickies, list):
        stickies = []
    cleaned: list[dict[str, Any]] = []
    for item in stickies:
        if not isinstance(item, dict):
            continue
        sid = str(item.get("id") or "").strip()
        if not sid:
            continue
        cleaned.append(
            {
                "id": sid,
                "content": str(item.get("content") or ""),
                "created_at": str(item.get("created_at") or ""),
                "updated_at": str(item.get("updated_at") or item.get("created_at") or ""),
            }
        )
    return {"paper_id": paper_id, "stickies": cleaned}


def _save(paper_id: str, payload: dict[str, Any]) -> None:
    from common import atomic_write_text
    path = _path_for(paper_id)
    atomic_write_text(
        path,
        json.dumps(payload, ensure_ascii=False, indent=2),
    )


def list_stickies(paper_id: str) -> list[dict[str, Any]]:
    data = _load(paper_id)
    # newest first
    return sorted(
        data.get("stickies", []),
        key=lambda item: item.get("created_at", ""),
        reverse=True,
    )


_VALID_STICKY_COLORS = {"clay", "yellow", "green", "blue", "pink", "brown", "amber", "red", "orange"}


def _normalize_color(value: Any, default: str = "clay") -> str:
    v = str(value or "").strip().lower()
    return v if v in _VALID_STICKY_COLORS else default


def add_sticky(paper_id: str, content: str, color: str = "clay") -> dict[str, Any]:
    content = str(content or "").rstrip()
    data = _load(paper_id)
    now = _now_iso()
    sticky = {
        "id": _new_id(),
        "content": content,
        "color": _normalize_color(color),
        "created_at": now,
        "updated_at": now,
    }
    data["stickies"].append(sticky)
    _save(paper_id, data)
    return sticky


def update_sticky(paper_id: str, sticky_id: str, content: str, color: str | None = None) -> dict[str, Any]:
    sticky_id = str(sticky_id or "").strip()
    if not sticky_id:
        raise ValueError("sticky id is required")
    data = _load(paper_id)
    for item in data["stickies"]:
        if item.get("id") == sticky_id:
            item["content"] = str(content or "").rstrip()
            if color is not None:
                item["color"] = _normalize_color(color, item.get("color") or "clay")
            item["updated_at"] = _now_iso()
            _save(paper_id, data)
            return item
    raise ValueError(f"sticky {sticky_id} not found")


def delete_sticky(paper_id: str, sticky_id: str) -> bool:
    sticky_id = str(sticky_id or "").strip()
    if not sticky_id:
        raise ValueError("sticky id is required")
    data = _load(paper_id)
    before = len(data["stickies"])
    data["stickies"] = [item for item in data["stickies"] if item.get("id") != sticky_id]
    if len(data["stickies"]) == before:
        return False
    _save(paper_id, data)
    return True


def list_all_stickies() -> list[dict[str, Any]]:
    """Cross-paper: return every sticky from every file, each with the
    owning paper_id injected for routing back."""
    out: list[dict[str, Any]] = []
    if not STICKIES_DIR.exists():
        return out
    for path in STICKIES_DIR.glob("*.json"):
        paper_id = path.stem
        try:
            import json as _json
            data = _json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for item in data.get("stickies", []) or []:
            entry = dict(item)
            entry["paper_id"] = paper_id
            out.append(entry)
    # newest first
    out.sort(key=lambda s: s.get("updated_at", s.get("created_at", "")), reverse=True)
    return out


def stats_stickies(paper_id: str = "") -> dict[str, int]:
    all_stickies = list_all_stickies()
    paper = sum(1 for s in all_stickies if s.get("paper_id") == paper_id) if paper_id else 0
    distinct_papers = len({s.get("paper_id", "") for s in all_stickies if s.get("paper_id")})
    return {
        "paper": paper,
        "total": len(all_stickies),
        "papers_with_stickies": distinct_papers,
    }


def delete_all_for_paper(paper_id: str) -> bool:
    """Used by the paper-delete pipeline to clean up the sidecar JSON."""
    try:
        path = _path_for(paper_id)
    except ValueError:
        return False
    if not path.exists():
        return False
    try:
        path.unlink()
    except OSError:
        return False
    return True
