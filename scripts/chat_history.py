"""Per-paper persistent AI chat history.

Each paper gets its own JSON file at `library/chat_history/{paper_id}.json`.
The file is a flat list of message objects in chronological order:

    [
      {"role": "user",      "content": "...", "ts": "2026-05-12T14:32:01Z"},
      {"role": "assistant", "content": "...", "ts": "...", "model": "...",
       "usage": {...}, "image_pages": "1,3"}
    ]

Paper text and Markdown notes are NOT embedded in the saved messages — they
are re-injected as the system prompt each turn so they stay fresh after
"帮我阅读" updates the note.
"""

from __future__ import annotations

import json
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402


HISTORY_DIR = ROOT / "library" / "chat_history"
_LOCK = threading.Lock()

# How many trailing turns we feed back to the LLM. 6 = three Q/A pairs.
DEFAULT_HISTORY_TURNS = 6


def _path_for(paper_id: str) -> Path:
    """Return the chat-history file path. paper_id is a safe filename in this
    project (it's the same string used to name PDFs and notes)."""
    safe = paper_id.strip()
    if not safe or any(ch in safe for ch in "\\/"):
        raise ValueError(f"invalid paper_id: {paper_id!r}")
    return HISTORY_DIR / f"{safe}.json"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(paper_id: str) -> list[dict[str, Any]]:
    path = _path_for(paper_id)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return data
    except Exception:
        return []
    return []


def save(paper_id: str, history: list[dict[str, Any]]) -> None:
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    path = _path_for(paper_id)
    with _LOCK:
        from common import atomic_write_text
        atomic_write_text(
            path,
            json.dumps(history, ensure_ascii=False, indent=2),
        )


def clear(paper_id: str) -> bool:
    path = _path_for(paper_id)
    if path.exists():
        path.unlink()
        return True
    return False


def append_turn(
    paper_id: str,
    question: str,
    answer: str,
    *,
    model: str = "",
    usage: dict[str, Any] | None = None,
    image_pages: str = "",
) -> list[dict[str, Any]]:
    ts_q = now_iso()
    ts_a = now_iso()
    history = load(paper_id)
    history.append({"role": "user", "content": question, "ts": ts_q})
    a_entry: dict[str, Any] = {
        "role": "assistant",
        "content": answer,
        "ts": ts_a,
        "model": model,
    }
    if usage:
        a_entry["usage"] = usage
    if image_pages:
        a_entry["image_pages"] = image_pages
    history.append(a_entry)
    save(paper_id, history)
    return history


def trail(history: list[dict[str, Any]], n: int = DEFAULT_HISTORY_TURNS) -> list[dict[str, Any]]:
    """Return the last n messages, but never start on an assistant turn (that
    would confuse the LLM about who said what). Drops leading assistant if any."""
    if not history:
        return []
    tail = history[-n:]
    while tail and tail[0].get("role") == "assistant":
        tail = tail[1:]
    return tail


def to_openai_messages(
    history: list[dict[str, Any]], turns: int = DEFAULT_HISTORY_TURNS
) -> list[dict[str, str]]:
    """Map saved history → OpenAI-style message list (only role/content)."""
    return [
        {"role": str(m.get("role", "user")), "content": str(m.get("content", ""))}
        for m in trail(history, turns)
    ]


def to_text_prefix(
    history: list[dict[str, Any]], turns: int = DEFAULT_HISTORY_TURNS
) -> str:
    """For backends like Codex CLI that don't take a `messages` list, render
    the trailing history as a plain-text prefix."""
    items = trail(history, turns)
    if not items:
        return ""
    out_lines = ["【先前对话】"]
    for m in items:
        role = "用户" if m.get("role") == "user" else "助手"
        out_lines.append(f"{role}: {m.get('content', '').strip()}")
    out_lines.append("")
    return "\n".join(out_lines)
