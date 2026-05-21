"""One-shot migration: repair category fields comma-joined by the old buggy
phase5 save (which used `.join(",")` instead of `.join("；")`).

THE HARD CASE this version handles: a category name can itself contain commas
(e.g. "Mapping Open Science Policy in China: A Structural, Temporal, and
Spatial Analysis"). A naive comma-split shatters it. So we disambiguate using
the known category names from the config tree:

  1. Split the field on `；` first (already-correct separators).
  2. For each segment that still contains `,`, protect every comma-containing
     known category name (and its no-space variant) by replacing it with a
     placeholder, THEN split the remainder on `,`, then restore.
  3. Only rewrite the field if every resulting token is a known category name
     (safety: never touch a value we can't fully account for).

Run once:  python scripts/_fix_comma_joined_categories.py
Idempotent — safe to re-run; prints "nothing to fix" when clean.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import read_csv, write_csv, load_settings, ROOT  # noqa: E402

CATEGORY_FIELDS = ["一级分类", "二级分类", "三级分类", "最终分类", "人工分类"]


def known_category_names(settings) -> set[str]:
    tree = settings.get("classification", {}).get("primary_categories", {})
    names: set[str] = set()
    for primary, children in tree.items():
        names.add(primary)
        if isinstance(children, dict):
            for sec, thirds in children.items():
                names.add(sec)
                if isinstance(thirds, list):
                    names.update(thirds)
        elif isinstance(children, list):
            names.update(children)
    return names


def repair_value(value: str, known: set[str]) -> tuple[str, bool]:
    """Return (repaired_value, changed)."""
    raw = (value or "").strip()
    if not raw or "," not in raw:
        return value, False

    # Comma-containing known names, longest first so the greedy protect
    # consumes the most specific name.
    comma_names = sorted((n for n in known if "," in n), key=len, reverse=True)

    final_tokens: list[str] = []
    # Split on ； first; each segment may still hold comma-joined tokens.
    for segment in re.split(r"[；;]", raw):
        seg = segment.strip()
        if not seg:
            continue
        if "," not in seg:
            final_tokens.append(seg)
            continue
        # Protect comma-containing known names with placeholders.
        work = seg
        placeholders: dict[str, str] = {}
        idx = 0
        for name in comma_names:
            # canonical + no-space variant ("A, B, C" vs "A,B,C")
            for variant in (name, name.replace(", ", ",")):
                if variant and variant in work:
                    ph = f"\x00{idx}\x00"
                    work = work.replace(variant, ph)
                    placeholders[ph] = name  # restore to CANONICAL
                    idx += 1
        # Now safe to split on comma.
        for part in work.split(","):
            p = part.strip()
            if not p:
                continue
            final_tokens.append(placeholders.get(p, p))

    # Dedupe preserving order.
    seen: set[str] = set()
    deduped: list[str] = []
    for t in final_tokens:
        if t and t not in seen:
            seen.add(t)
            deduped.append(t)

    # Safety: only commit if EVERY token is a known category name. If any
    # token is unknown we can't be sure we parsed correctly — leave it alone.
    if not deduped or not all(t in known for t in deduped):
        return value, False

    new_val = "；".join(deduped)
    return (new_val, new_val != raw)


def main() -> None:
    settings = load_settings()
    known = known_category_names(settings)
    print(f"known category names: {len(known)}")
    comma_names = [n for n in known if "," in n]
    print(f"  of which contain commas: {len(comma_names)}")
    for n in comma_names:
        print(f"    · {n}")
    print()

    csv_path = ROOT / "library" / "index" / "papers.csv"
    rows = read_csv(csv_path)

    fixed = 0
    for r in rows:
        for field in CATEGORY_FIELDS:
            old = r.get(field, "") or ""
            new, changed = repair_value(old, known)
            if changed:
                print(f"  [{field}] {r.get('paper_id','')[:55]}")
                print(f"      OLD: {old!r}")
                print(f"      NEW: {new!r}")
                r[field] = new
                fixed += 1

    if fixed:
        write_csv(csv_path, rows)
        print(f"\nRepaired {fixed} field(s). papers.csv written.")
    else:
        print("Nothing to fix — all category fields are clean.")


if __name__ == "__main__":
    main()
