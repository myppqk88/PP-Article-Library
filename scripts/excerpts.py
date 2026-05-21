"""Parse library/index/english_excerpts.md into structured cards.

File format (produced by `append_english_excerpt` in server.py):

    ## YYYY-MM-DD HH:MM:SS | {paper title}

    - Paper ID: {paper_id}
    - Source: {authors}; {year}; {venue}; {doi}
    - PDF: library/pdfs/{filename}.pdf

    {AI-generated content — usually numbered list:
     1. "English quote text"
        用法：Chinese explanation
     2. ...}

Each top-level `##` heading starts a new block. The AI content varies; we
parse it as best-effort numbered list, falling back to "loose" mode if
needed.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402


EXCERPTS_PATH = ROOT / "library" / "index" / "english_excerpts.md"


@dataclass
class ExcerptCard:
    """One quotable excerpt card."""
    quote: str
    note: str
    paper_id: str
    paper_title: str
    page: str         # optional, e.g. "3" or "3-5"
    tag: str          # optional thematic tag from AI
    ts: str           # block timestamp YYYY-MM-DD HH:MM:SS
    source: str       # author / year / venue summary line


_BLOCK_HEADER = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s*\|\s*(.+?)\s*$", re.MULTILINE)
_META_PAPER_ID = re.compile(r"^-\s*Paper ID\s*:\s*(.+?)\s*$", re.MULTILINE)
_META_SOURCE = re.compile(r"^-\s*Source\s*:\s*(.+?)\s*$", re.MULTILINE)
_META_PDF = re.compile(r"^-\s*PDF\s*:\s*(.+?)\s*$", re.MULTILINE)

# Numbered item split (1. 2. 3.) — both ASCII and CJK forms
_ITEM_SPLIT = re.compile(r"\n\s*\d+\s*[\.、]\s*")

# Use-explanation line markers
_NOTE_PREFIX = re.compile(r"^[\-•\s]*(?:用法|中文|解读|含义|说明|意思|场景)\s*[:：]\s*(.+)$")

# Page reference
_PAGE_REF = re.compile(r"\bp\.?\s*(\d+(?:-\d+)?)", re.IGNORECASE)


_QUOTE_LABEL_PREFIX = re.compile(
    r"^\s*[*_`]*\s*(?:英文原句|英文|Quote|quote|原句|引用|Sentence)\s*\d*\s*[*_`]*\s*[:：]\s*[*_`]*\s*"
)
_TRAILING_MARKERS = re.compile(r"[\s*_`\"“”'\\]+$")
_PREFACE_LINES = (
    "以下是", "根据您", "根据上", "下面是", "由于", "由于该", "由于本",
    "**说明", "说明", "注：", "提示：", "Note:", "***",
)


def _strip_markdown_emphasis(s: str) -> str:
    """Remove leading/trailing ** / * / _ / ` markers around a quote."""
    s = s.strip()
    # Repeatedly peel off matching emphasis markers at both ends
    for _ in range(4):
        new = re.sub(r"^[*_`]{1,3}", "", s)
        new = re.sub(r"[*_`]{1,3}$", "", new)
        if new == s:
            break
        s = new.strip()
    return s


def _parse_block_content(content: str) -> list[dict[str, str]]:
    """Parse a block's content into [{quote, note, page, tag}]."""
    content = content.strip()
    if not content:
        return []
    # Strip refusal blocks
    if "无法从" in content[:200] and "摘录" in content[:200]:
        return []

    # Try numbered list split first (1. 2. 3. / 1、 2、 / **1.** **1、**)
    # Also handle `--- **1.**` and `---\n1.` separators
    normalized = re.sub(r"\n-{2,}\s*", "\n", content)
    # Strip leading **N.** style markers before splitting
    normalized = re.sub(r"\n\s*\*+\s*(\d+)\s*[\.、]\s*\*+", r"\n\1.", normalized)
    parts = _ITEM_SPLIT.split("\n" + normalized)
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) < 2:
        parts = re.split(r"\n\s*[-•]\s+", "\n" + normalized)
        parts = [p.strip() for p in parts if p.strip()]

    cards: list[dict[str, str]] = []
    for raw in parts:
        # Skip preface lines
        first_line_preview = raw[:50].strip()
        if any(first_line_preview.startswith(p) for p in _PREFACE_LINES):
            continue

        lines = [l.strip() for l in raw.split("\n") if l.strip()]
        if not lines:
            continue

        quote_parts: list[str] = []
        note = ""
        page = ""
        tag = ""
        i = 0
        while i < len(lines):
            line = lines[i]
            # Try note prefix first — if matched, stop collecting quote
            m = _NOTE_PREFIX.match(line)
            if m:
                note = m.group(1).strip()
                j = i + 1
                while j < len(lines):
                    if _NOTE_PREFIX.match(lines[j]):
                        break
                    note += " " + lines[j].strip()
                    j += 1
                break
            # Strip label prefix like "**英文原句**："
            cleaned = _QUOTE_LABEL_PREFIX.sub("", line)
            quote_parts.append(cleaned)
            i += 1

        quote = " ".join(quote_parts).strip()
        # Strip all surrounding emphasis markers and outer quote marks
        quote = _strip_markdown_emphasis(quote)
        quote = re.sub(r'^["“”\'`]+|["“”\'`]+$', "", quote).strip()
        quote = _strip_markdown_emphasis(quote)
        # Strip trailing separators like " ---" or "**" residue
        quote = re.sub(r"\s*[-—]{2,}.*$", "", quote).strip()
        quote = _TRAILING_MARKERS.sub("", quote).strip()
        # Clean note similarly
        note = _strip_markdown_emphasis(note).strip()
        note = re.sub(r'^["“”\'`]+|["“”\'`]+$', "", note).strip()

        # Pull page out
        pm = _PAGE_REF.search(quote + " " + note)
        if pm:
            page = pm.group(1)
        if not quote:
            continue
        # Skip if the quote has no real English content (likely Chinese preface)
        eng_chars = len(re.findall(r"[A-Za-z]", quote))
        if eng_chars < 12:
            continue
        # Skip if quote is mostly explanation in Chinese
        if eng_chars < len(quote) * 0.3:
            continue
        cards.append({"quote": quote, "note": note, "page": page, "tag": tag})
    return cards


# mtime-keyed cache so /api/excerpts/list and /api/excerpts/stats —
# both called on every paper switch — don't re-parse the entire file.
_LIST_CACHE: dict[str, Any] = {"mtime": None, "cards": None}


def list_all() -> list[ExcerptCard]:
    """Return every excerpt card found in the file. Cached on file mtime."""
    if not EXCERPTS_PATH.exists():
        return []
    try:
        mtime = EXCERPTS_PATH.stat().st_mtime
    except OSError:
        mtime = None
    if mtime is not None and _LIST_CACHE["mtime"] == mtime and _LIST_CACHE["cards"] is not None:
        # Cards are frozen-in-spirit (callers only read attributes) so we can
        # share them. Return a fresh list to isolate caller's list mutations.
        return list(_LIST_CACHE["cards"])
    raw = EXCERPTS_PATH.read_text(encoding="utf-8")
    # Split by `## ` blocks
    headers = list(_BLOCK_HEADER.finditer(raw))
    cards: list[ExcerptCard] = []
    for idx, m in enumerate(headers):
        ts = m.group(1)
        title = m.group(2)
        start = m.end()
        end = headers[idx + 1].start() if idx + 1 < len(headers) else len(raw)
        body = raw[start:end]
        # Parse metadata
        paper_id_m = _META_PAPER_ID.search(body)
        source_m = _META_SOURCE.search(body)
        paper_id = paper_id_m.group(1).strip() if paper_id_m else ""
        source = source_m.group(1).strip() if source_m else ""
        # Strip metadata lines from body to leave just AI content
        content = re.sub(r"^-\s*(?:Paper ID|Source|PDF)\s*:.*$", "", body, flags=re.MULTILINE).strip()
        items = _parse_block_content(content)
        for item in items:
            cards.append(
                ExcerptCard(
                    quote=item["quote"],
                    note=item["note"],
                    paper_id=paper_id,
                    paper_title=title,
                    page=item["page"],
                    tag=item.get("tag", ""),
                    ts=ts,
                    source=source,
                )
            )
    _LIST_CACHE["mtime"] = mtime
    _LIST_CACHE["cards"] = list(cards)
    return cards


def list_for_paper(paper_id: str) -> list[ExcerptCard]:
    if not paper_id:
        return []
    return [c for c in list_all() if c.paper_id == paper_id]


def stats(paper_id: str = "") -> dict[str, int]:
    all_cards = list_all()
    total = len(all_cards)
    paper_count = sum(1 for c in all_cards if c.paper_id == paper_id) if paper_id else 0
    # number of distinct papers with at least one excerpt
    distinct_papers = len({c.paper_id for c in all_cards if c.paper_id})
    return {
        "paper": paper_count,
        "total": total,
        "papers_with_excerpts": distinct_papers,
    }


def to_payload(cards: list[ExcerptCard]) -> list[dict[str, Any]]:
    return [asdict(c) for c in cards]
