"""Export PDFs + notes for papers matching a category.

Two entry points:

- CLI (`python3 scripts/export_by_category.py <keyword>`): exports any paper
  whose searchable category fields contain `keyword`. Keeps the old behavior
  so the `按分类导出.command` launcher script still works.

- Library (`export_papers(label, ...)`): used by the web server's
  `/api/export/category` endpoint.

Output layout (same on both paths):

    exports/<safe-label>_<YYYYMMDD_HHMM>/
        pdfs/<paper_id>.pdf
        notes/<paper_id>.md
        文献清单.csv
        文献清单.xlsx
        README.md

PDF and note files share the same stem (`<paper_id>`) so they line up
between the two folders.
"""

from __future__ import annotations

import argparse
import shutil
from datetime import datetime
from pathlib import Path
from typing import Any

from common import ROOT, clean_piece, load_settings, project_path, read_csv, rel, write_csv, write_xlsx


# Fields that the category filter searches in. These match `categories_from_rows`
# in server.py + the previous CLI behavior.
_CATEGORY_FIELDS = [
    "一级分类",
    "二级分类",
    "三级分类",
    "人工分类",
    "最终分类",
    "一级分类_AI建议",
    "二级分类_AI建议",
]


def _split_tokens(value: str) -> list[str]:
    # Only split on `；` / `;` — commas are legitimate inside category names.
    import re as _re
    return [s.strip() for s in _re.split(r"[；;]", str(value or "")) if s.strip()]


def row_in_category(row: dict[str, str], label: str) -> bool:
    """True if `label` appears as a token in any category field of `row`.

    Token-based match: "C09 开放科学" doesn't accidentally match "C09 开放科学政策".
    """
    label = (label or "").strip()
    if not label:
        return False
    for field in _CATEGORY_FIELDS:
        if label in _split_tokens(row.get(field, "")):
            return True
    return False


def row_loose_match(row: dict[str, str], keyword: str) -> bool:
    """Legacy CLI behavior: substring match across category fields + 标题 + 关键词."""
    haystack = " ".join(
        row.get(field, "")
        for field in [
            *_CATEGORY_FIELDS,
            "关键词",
            "标题",
            "AI一句话总结",
        ]
    )
    return keyword.lower() in haystack.lower()


def _copy_if_exists(source: Path, target: Path) -> bool:
    if not source.exists():
        return False
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)
    return True


def export_papers(
    label: str,
    *,
    rows: list[dict[str, str]] | None = None,
    output_root: Path | None = None,
    match_mode: str = "exact",
) -> dict[str, Any]:
    """Export every paper matching `label`. Returns a summary dict.

    match_mode = "exact"  → token-equal in category fields (recommended; what
                             the new UI uses; e.g. label="开放科学" only matches
                             rows that have "开放科学" as one of their tokens,
                             not "开放科学政策").
    match_mode = "loose"  → legacy substring-in-haystack match.
    """
    if not (label or "").strip():
        raise ValueError("label 不能为空")
    settings = load_settings()
    if rows is None:
        rows = read_csv(project_path(settings["index"]["csv"]))
    if match_mode == "loose":
        matches = [row for row in rows if row_loose_match(row, label)]
    else:
        matches = [row for row in rows if row_in_category(row, label)]

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    base_root = output_root or (ROOT / "exports")
    out_dir = base_root / f"{clean_piece(label, 50)}_{stamp}"
    pdf_dir = out_dir / "pdfs"
    note_dir = out_dir / "notes"

    exported_rows: list[dict[str, str]] = []
    pdf_ok = 0
    note_ok = 0
    pdf_missing: list[str] = []
    note_missing: list[str] = []

    for row in matches:
        exported = dict(row)
        paper_id = (row.get("paper_id") or "").strip() or clean_piece(row.get("标题", ""), 50)
        # 强制让 PDF / 笔记同名：用 paper_id 当 stem，保留原扩展名
        pdf_src = project_path(row.get("PDF路径", ""))
        note_src = project_path(row.get("笔记路径", ""))
        readme_pdf = readme_note = ""
        if pdf_src and pdf_src.exists():
            target_pdf = pdf_dir / f"{paper_id}{pdf_src.suffix or '.pdf'}"
            _copy_if_exists(pdf_src, target_pdf)
            exported["PDF路径"] = rel(target_pdf)
            readme_pdf = str(target_pdf.relative_to(out_dir))
            pdf_ok += 1
        else:
            pdf_missing.append(paper_id)
        if note_src and note_src.exists():
            target_note = note_dir / f"{paper_id}.md"
            _copy_if_exists(note_src, target_note)
            exported["笔记路径"] = rel(target_note)
            readme_note = str(target_note.relative_to(out_dir))
            note_ok += 1
        else:
            note_missing.append(paper_id)
        exported["_readme_pdf"] = readme_pdf
        exported["_readme_note"] = readme_note
        exported_rows.append(exported)

    if exported_rows:
        write_csv(out_dir / "文献清单.csv", exported_rows)
        write_xlsx(out_dir / "文献清单.xlsx", exported_rows)
        lines = [f"# {label} · 文献导出", "",
                 f"共 {len(exported_rows)} 篇 · PDF {pdf_ok} 个 · 笔记 {note_ok} 个", ""]
        for row in exported_rows:
            title = row.get("英文标题") or row.get("标题") or row.get("paper_id", "")
            year = row.get("年份", "")
            authors = row.get("作者", "")
            links = []
            if row.get("_readme_pdf"):
                links.append(f"[PDF]({row['_readme_pdf']})")
            if row.get("_readme_note"):
                links.append(f"[笔记]({row['_readme_note']})")
            lines.append(f"- {year} {authors} — {title} {' · '.join(links)}")
        from common import atomic_write_text
        atomic_write_text(out_dir / "README.md", "\n".join(lines) + "\n")

    return {
        "label": label,
        "match_mode": match_mode,
        "matched": len(exported_rows),
        "pdf_ok": pdf_ok,
        "note_ok": note_ok,
        "pdf_missing": pdf_missing,
        "note_missing": note_missing,
        "out_dir": str(out_dir),
        "out_dir_rel": rel(out_dir),
        "pdf_dir_rel": rel(pdf_dir),
        "note_dir_rel": rel(note_dir),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="按分类或关键词导出 PDF 和笔记副本。")
    parser.add_argument("keyword", help="分类关键词，例如：开放科学 / AI辅助同行评议 / 数字人")
    parser.add_argument(
        "--exact",
        action="store_true",
        help="只匹配分类字段里的精确 token（推荐）。默认走宽松匹配以兼容老脚本。",
    )
    args = parser.parse_args()
    result = export_papers(args.keyword, match_mode="exact" if args.exact else "loose")
    if not result["matched"]:
        print(f"没有匹配到「{args.keyword}」的文献。")
        return
    print(
        f"已导出 {result['matched']} 篇到：{result['out_dir']}\n"
        f"  PDF {result['pdf_ok']} 个 · 笔记 {result['note_ok']} 个"
    )
    if result["pdf_missing"]:
        print(f"  缺 PDF：{len(result['pdf_missing'])} 篇")
    if result["note_missing"]:
        print(f"  缺笔记：{len(result['note_missing'])} 篇")


if __name__ == "__main__":
    main()
