from __future__ import annotations

import html
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Any

from common import (
    INDEX_FIELDS,
    ROOT,
    atomic_write_text,
    clean_piece,
    now_text,
    project_path,
    rel,
    unique_path,
)
from organize import (
    MANUAL_NOTE_END,
    MANUAL_NOTE_START,
    guess_year,
    make_note_name,
    make_pdf_name,
    sha256_file,
)


ZOTERO_EXCLUDED_ITEM_TYPES = {"attachment", "note", "annotation"}
ZOTERO_NOTE_SOURCE_LABEL = "Zotero 导入"


def normalize_zotero_dir(value: str | Path) -> Path:
    raw = str(value or "").strip().strip('"').strip("'")
    if raw.startswith("~"):
        raw = os.path.expanduser(raw)
    path = Path(raw)
    if not path.is_absolute():
        path = (ROOT / path).resolve()
    return path


def validate_zotero_dir(value: str | Path) -> dict[str, Any]:
    try:
        path = normalize_zotero_dir(value)
    except Exception:
        path = Path(str(value or ""))
    db = path / "zotero.sqlite"
    storage = path / "storage"
    return {
        "path": str(path),
        "exists": path.exists(),
        "has_db": db.exists() and db.is_file(),
        "has_storage": storage.exists() and storage.is_dir(),
        "valid": db.exists() and db.is_file(),
    }


def default_zotero_candidates(configured: str = "") -> list[dict[str, Any]]:
    home = Path.home()
    candidates: list[tuple[str, Path]] = []
    if configured:
        candidates.append(("已保存的位置", normalize_zotero_dir(configured)))
    if sys.platform == "darwin":
        candidates.extend([
            ("macOS 默认位置", home / "Zotero"),
            ("macOS 旧版应用数据位置", home / "Library" / "Application Support" / "Zotero"),
        ])
    elif sys.platform == "win32":
        user_profile = Path(os.environ.get("USERPROFILE", str(home)))
        appdata = os.environ.get("APPDATA", "")
        local_appdata = os.environ.get("LOCALAPPDATA", "")
        candidates.append(("Windows 默认位置", user_profile / "Zotero"))
        if appdata:
            candidates.append(("Windows AppData 位置", Path(appdata) / "Zotero"))
        if local_appdata:
            candidates.append(("Windows LocalAppData 位置", Path(local_appdata) / "Zotero"))
    else:
        candidates.extend([
            ("Linux 默认位置", home / "Zotero"),
            ("Linux 旧版配置位置", home / ".zotero" / "zotero"),
        ])

    seen: set[str] = set()
    result: list[dict[str, Any]] = []
    for label, path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        info = validate_zotero_dir(path)
        info["label"] = label
        result.append(info)
    return result


def _connect(db_path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


def _snapshot_db(db_path: Path, snapshot_dir: Path) -> Path:
    """Copy Zotero's SQLite DB before reading.

    Zotero commonly keeps `zotero.sqlite` locked while the app is open. Reading
    a short-lived copy lets users import without closing Zotero and keeps this
    module strictly read-only toward the real database.
    """
    target = snapshot_dir / "zotero.sqlite"
    shutil.copy2(db_path, target)
    for suffix in ("-wal", "-shm"):
        sidecar = db_path.with_name(db_path.name + suffix)
        if sidecar.exists():
            try:
                shutil.copy2(sidecar, target.with_name(target.name + suffix))
            except OSError:
                pass
    return target


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return bool(row)


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    try:
        return {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.Error:
        return set()


def _chunks(values: list[int], size: int = 800) -> list[list[int]]:
    return [values[i : i + size] for i in range(0, len(values), size)]


def _placeholders(values: list[int]) -> str:
    return ",".join("?" for _ in values)


def _normalize_doi(value: str) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"^https?://(dx\.)?doi\.org/", "", text)
    text = re.sub(r"^doi:\s*", "", text)
    return text.strip()


def _clean_year(value: str) -> str:
    match = re.search(r"(19|20)\d{2}", str(value or ""))
    return match.group(0) if match else ""


def _creator_name(row: sqlite3.Row) -> str:
    short = str(row["shortName"] or "").strip() if "shortName" in row.keys() else ""
    first = str(row["firstName"] or "").strip() if "firstName" in row.keys() else ""
    last = str(row["lastName"] or "").strip() if "lastName" in row.keys() else ""
    if short:
        return short
    if first and last:
        return f"{first} {last}".strip()
    return last or first


def _html_to_markdown(value: str) -> str:
    text = str(value or "")
    if not text:
        return ""
    text = re.sub(r"(?i)<\s*br\s*/?\s*>", "\n", text)
    text = re.sub(r"(?i)</\s*(p|div|li|h[1-6]|blockquote)\s*>", "\n", text)
    text = re.sub(r"(?i)<\s*li[^>]*>", "- ", text)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _resolve_attachment_path(zotero_dir: Path, attachment: dict[str, Any]) -> Path | None:
    raw = str(attachment.get("path") or "").strip()
    key = str(attachment.get("key") or "").strip()
    if raw.startswith("storage:") and key:
        return zotero_dir / "storage" / key / raw.split(":", 1)[1]
    if raw:
        path = Path(os.path.expanduser(raw))
        if path.is_absolute():
            return path
        candidate = zotero_dir / raw
        if candidate.exists():
            return candidate
    return None


def _fetch_field_values(conn: sqlite3.Connection, item_ids: list[int]) -> dict[int, dict[str, str]]:
    values: dict[int, dict[str, str]] = {item_id: {} for item_id in item_ids}
    if not item_ids:
        return values
    sql = """
        SELECT idata.itemID, fields.fieldName, itemDataValues.value
        FROM itemData idata
        JOIN fields ON fields.fieldID = idata.fieldID
        JOIN itemDataValues ON itemDataValues.valueID = idata.valueID
        WHERE idata.itemID IN ({})
    """
    for chunk in _chunks(item_ids):
        for row in conn.execute(sql.format(_placeholders(chunk)), chunk):
            values[int(row["itemID"])][str(row["fieldName"])] = str(row["value"] or "")
    return values


def _fetch_creators(conn: sqlite3.Connection, item_ids: list[int]) -> dict[int, list[str]]:
    creators: dict[int, list[str]] = {item_id: [] for item_id in item_ids}
    if not item_ids or not _table_exists(conn, "itemCreators"):
        return creators
    if _table_exists(conn, "creatorData"):
        sql = """
            SELECT itemCreators.itemID, creatorData.firstName, creatorData.lastName, creatorData.shortName
            FROM itemCreators
            JOIN creators ON creators.creatorID = itemCreators.creatorID
            JOIN creatorData ON creatorData.creatorDataID = creators.creatorDataID
            WHERE itemCreators.itemID IN ({})
            ORDER BY itemCreators.itemID, itemCreators.orderIndex
        """
    else:
        sql = """
            SELECT itemCreators.itemID, creators.firstName, creators.lastName, '' AS shortName
            FROM itemCreators
            JOIN creators ON creators.creatorID = itemCreators.creatorID
            WHERE itemCreators.itemID IN ({})
            ORDER BY itemCreators.itemID, itemCreators.orderIndex
        """
    for chunk in _chunks(item_ids):
        for row in conn.execute(sql.format(_placeholders(chunk)), chunk):
            name = _creator_name(row)
            if name:
                creators[int(row["itemID"])].append(name)
    return creators


def _fetch_tags(conn: sqlite3.Connection, item_ids: list[int]) -> dict[int, list[str]]:
    tags: dict[int, list[str]] = {item_id: [] for item_id in item_ids}
    if not item_ids or not _table_exists(conn, "itemTags"):
        return tags
    sql = """
        SELECT itemTags.itemID, tags.name
        FROM itemTags
        JOIN tags ON tags.tagID = itemTags.tagID
        WHERE itemTags.itemID IN ({})
        ORDER BY tags.name
    """
    for chunk in _chunks(item_ids):
        for row in conn.execute(sql.format(_placeholders(chunk)), chunk):
            value = str(row["name"] or "").strip()
            if value and value not in tags[int(row["itemID"])]:
                tags[int(row["itemID"])].append(value)
    return tags


def _fetch_collections(conn: sqlite3.Connection, item_ids: list[int]) -> dict[int, list[str]]:
    collections: dict[int, list[str]] = {item_id: [] for item_id in item_ids}
    if not item_ids or not _table_exists(conn, "collectionItems"):
        return collections
    sql = """
        SELECT collectionItems.itemID, collections.collectionName
        FROM collectionItems
        JOIN collections ON collections.collectionID = collectionItems.collectionID
        WHERE collectionItems.itemID IN ({})
        ORDER BY collections.collectionName
    """
    for chunk in _chunks(item_ids):
        for row in conn.execute(sql.format(_placeholders(chunk)), chunk):
            value = str(row["collectionName"] or "").strip()
            if value and value not in collections[int(row["itemID"])]:
                collections[int(row["itemID"])].append(value)
    return collections


def _fetch_attachments(conn: sqlite3.Connection, item_ids: list[int], zotero_dir: Path) -> dict[int, list[dict[str, Any]]]:
    attachments: dict[int, list[dict[str, Any]]] = {item_id: [] for item_id in item_ids}
    if not item_ids or not _table_exists(conn, "itemAttachments"):
        return attachments
    sql = """
        SELECT itemAttachments.parentItemID, itemAttachments.itemID, itemAttachments.path,
               itemAttachments.contentType, items.key
        FROM itemAttachments
        JOIN items ON items.itemID = itemAttachments.itemID
        WHERE itemAttachments.parentItemID IN ({})
        ORDER BY itemAttachments.parentItemID, itemAttachments.itemID
    """
    for chunk in _chunks(item_ids):
        for row in conn.execute(sql.format(_placeholders(chunk)), chunk):
            content_type = str(row["contentType"] or "").lower()
            raw_path = str(row["path"] or "")
            is_pdf = content_type == "application/pdf" or raw_path.lower().endswith(".pdf")
            if not is_pdf:
                continue
            attachment = {
                "item_id": int(row["itemID"]),
                "key": str(row["key"] or ""),
                "path": raw_path,
                "content_type": str(row["contentType"] or ""),
            }
            resolved = _resolve_attachment_path(zotero_dir, attachment)
            attachment["resolved_path"] = str(resolved) if resolved else ""
            attachment["exists"] = bool(resolved and resolved.exists())
            attachments[int(row["parentItemID"])].append(attachment)
    return attachments


def _fetch_notes(conn: sqlite3.Connection, item_ids: list[int]) -> dict[int, list[str]]:
    notes: dict[int, list[str]] = {item_id: [] for item_id in item_ids}
    if not item_ids or not _table_exists(conn, "itemNotes"):
        return notes
    cols = _columns(conn, "itemNotes")
    parent_col = "parentItemID" if "parentItemID" in cols else "sourceItemID" if "sourceItemID" in cols else ""
    if not parent_col or "note" not in cols:
        return notes
    sql = f"""
        SELECT {parent_col} AS parentID, note
        FROM itemNotes
        WHERE {parent_col} IN ({{}})
        ORDER BY itemID
    """
    for chunk in _chunks(item_ids):
        for row in conn.execute(sql.format(_placeholders(chunk)), chunk):
            value = _html_to_markdown(str(row["note"] or ""))
            if value:
                notes[int(row["parentID"])].append(value)
    return notes


def _fetch_annotations(
    conn: sqlite3.Connection,
    attachments_by_parent: dict[int, list[dict[str, Any]]],
) -> dict[int, list[str]]:
    annotations: dict[int, list[str]] = {item_id: [] for item_id in attachments_by_parent}
    if not _table_exists(conn, "itemAnnotations"):
        return annotations
    cols = _columns(conn, "itemAnnotations")
    if "parentItemID" not in cols:
        return annotations
    attachment_to_parent: dict[int, int] = {}
    for parent_id, attachments in attachments_by_parent.items():
        for attachment in attachments:
            if attachment.get("item_id"):
                attachment_to_parent[int(attachment["item_id"])] = parent_id
    attachment_ids = list(attachment_to_parent)
    if not attachment_ids:
        return annotations
    select_cols = ["parentItemID"]
    for col in ["type", "text", "comment", "pageLabel", "color", "sortIndex"]:
        if col in cols:
            select_cols.append(col)
    order_col = "sortIndex" if "sortIndex" in cols else "itemID" if "itemID" in cols else "parentItemID"
    sql = f"""
        SELECT {", ".join(select_cols)}
        FROM itemAnnotations
        WHERE parentItemID IN ({{}})
        ORDER BY parentItemID, {order_col}
    """
    for chunk in _chunks(attachment_ids):
        for row in conn.execute(sql.format(_placeholders(chunk)), chunk):
            parent_id = attachment_to_parent.get(int(row["parentItemID"]))
            if not parent_id:
                continue
            parts = []
            page = str(row["pageLabel"] or "").strip() if "pageLabel" in row.keys() else ""
            text = _html_to_markdown(str(row["text"] or "")) if "text" in row.keys() else ""
            comment = _html_to_markdown(str(row["comment"] or "")) if "comment" in row.keys() else ""
            if page:
                parts.append(f"p. {page}")
            if text:
                parts.append(text)
            if comment:
                parts.append(f"备注：{comment}")
            line = " — ".join(parts).strip()
            if line:
                annotations[parent_id].append(line)
    return annotations


def read_zotero_items(zotero_dir_value: str | Path, limit: int = 0) -> list[dict[str, Any]]:
    zotero_dir = normalize_zotero_dir(zotero_dir_value)
    status = validate_zotero_dir(zotero_dir)
    if not status["valid"]:
        raise FileNotFoundError("请选择包含 zotero.sqlite 的 Zotero 数据目录。")
    db_path = zotero_dir / "zotero.sqlite"
    with tempfile.TemporaryDirectory(prefix="pp-zotero-") as tmp:
        snapshot = _snapshot_db(db_path, Path(tmp))
        conn = _connect(snapshot)
        try:
            items = _read_zotero_items_from_connection(conn, zotero_dir, limit)
        finally:
            conn.close()
    return items


def _read_zotero_items_from_connection(
    conn: sqlite3.Connection,
    zotero_dir: Path,
    limit: int = 0,
) -> list[dict[str, Any]]:
    deleted_join = "LEFT JOIN deletedItems ON deletedItems.itemID = items.itemID" if _table_exists(conn, "deletedItems") else ""
    deleted_filter = "AND deletedItems.itemID IS NULL" if deleted_join else ""
    rows = conn.execute(
        f"""
        SELECT items.itemID, items.key, items.version, items.dateAdded, items.dateModified, itemTypes.typeName
        FROM items
        JOIN itemTypes ON itemTypes.itemTypeID = items.itemTypeID
        {deleted_join}
        WHERE itemTypes.typeName NOT IN ({",".join("?" for _ in ZOTERO_EXCLUDED_ITEM_TYPES)})
        {deleted_filter}
        ORDER BY items.dateAdded DESC
        """,
        tuple(ZOTERO_EXCLUDED_ITEM_TYPES),
    ).fetchall()
    if limit and limit > 0:
        rows = rows[:limit]
    item_ids = [int(row["itemID"]) for row in rows]
    field_values = _fetch_field_values(conn, item_ids)
    creators = _fetch_creators(conn, item_ids)
    tags = _fetch_tags(conn, item_ids)
    collections = _fetch_collections(conn, item_ids)
    attachments = _fetch_attachments(conn, item_ids, zotero_dir)
    notes = _fetch_notes(conn, item_ids)
    annotations = _fetch_annotations(conn, attachments)

    items: list[dict[str, Any]] = []
    for row in rows:
        item_id = int(row["itemID"])
        fields = field_values.get(item_id, {})
        title = fields.get("title") or fields.get("caseName") or fields.get("nameOfAct") or fields.get("subject") or ""
        date_value = fields.get("date") or fields.get("dateDecided") or fields.get("dateEnacted") or ""
        venue = (
            fields.get("publicationTitle")
            or fields.get("conferenceName")
            or fields.get("proceedingsTitle")
            or fields.get("bookTitle")
            or fields.get("publisher")
            or fields.get("websiteTitle")
            or ""
        )
        item_attachments = attachments.get(item_id, [])
        items.append(
            {
                "item_id": item_id,
                "key": str(row["key"] or ""),
                "version": str(row["version"] or ""),
                "item_type": str(row["typeName"] or ""),
                "date_added": str(row["dateAdded"] or ""),
                "date_modified": str(row["dateModified"] or ""),
                "title": title or str(row["key"] or "Untitled"),
                "authors": creators.get(item_id, []),
                "year": _clean_year(date_value) or _clean_year(str(row["dateAdded"] or "")) or "Unknown",
                "date": date_value,
                "venue": venue,
                "doi": fields.get("DOI") or "",
                "url": fields.get("url") or "",
                "abstract": fields.get("abstractNote") or "",
                "short_title": fields.get("shortTitle") or title or "",
                "tags": tags.get(item_id, []),
                "collections": collections.get(item_id, []),
                "notes": notes.get(item_id, []),
                "annotations": annotations.get(item_id, []),
                "attachments": item_attachments,
                "pdf_count": len(item_attachments),
                "available_pdf_count": sum(1 for att in item_attachments if att.get("exists")),
            }
        )
    return items


def _existing_indexes(rows: list[dict[str, str]]) -> dict[str, set[str]]:
    return {
        "zotero_keys": {str(row.get("ZoteroKey", "")).strip() for row in rows if row.get("ZoteroKey")},
        "dois": {_normalize_doi(row.get("DOI", "")) for row in rows if _normalize_doi(row.get("DOI", ""))},
        "hashes": {str(row.get("文件哈希", "")).strip() for row in rows if row.get("文件哈希")},
        "paper_ids": {str(row.get("paper_id", "")).strip() for row in rows if row.get("paper_id")},
    }


def duplicate_reason(item: dict[str, Any], rows: list[dict[str, str]]) -> str:
    indexes = _existing_indexes(rows)
    key = str(item.get("key") or "").strip()
    doi = _normalize_doi(str(item.get("doi") or ""))
    if key and key in indexes["zotero_keys"]:
        return "ZoteroKey 已存在"
    if doi and doi in indexes["dois"]:
        return "DOI 已存在"
    return ""


def preview_zotero_library(zotero_dir_value: str | Path, rows: list[dict[str, str]], limit: int = 0) -> dict[str, Any]:
    zotero_dir = normalize_zotero_dir(zotero_dir_value)
    items = read_zotero_items(zotero_dir, limit=limit)
    duplicates = 0
    samples: list[dict[str, Any]] = []
    for item in items:
        reason = duplicate_reason(item, rows)
        if reason:
            duplicates += 1
        if len(samples) < 8:
            samples.append(
                {
                    "title": item.get("title", ""),
                    "authors": "；".join(item.get("authors") or []),
                    "year": item.get("year", ""),
                    "doi": item.get("doi", ""),
                    "collections": "；".join(item.get("collections") or []),
                    "tags": "；".join(item.get("tags") or []),
                    "has_pdf": bool(item.get("available_pdf_count")),
                    "duplicate": bool(reason),
                    "duplicate_reason": reason,
                }
            )
    return {
        "ok": True,
        "path": str(zotero_dir),
        "valid": True,
        "total_items": len(items),
        "with_pdf": sum(1 for item in items if item.get("available_pdf_count")),
        "with_notes": sum(1 for item in items if item.get("notes")),
        "with_annotations": sum(1 for item in items if item.get("annotations")),
        "with_collections": sum(1 for item in items if item.get("collections")),
        "with_tags": sum(1 for item in items if item.get("tags")),
        "duplicates": duplicates,
        "new_items": max(0, len(items) - duplicates),
        "samples": samples,
    }


def _build_ai_stub(item: dict[str, Any]) -> dict[str, Any]:
    title = str(item.get("title") or "Untitled")
    return {
        "title": title,
        "authors": item.get("authors") or ["未识别"],
        "year": item.get("year") or guess_year(title),
        "venue": item.get("venue") or "",
        "doi": item.get("doi") or "",
        "short_title": item.get("short_title") or title,
    }


def _unique_paper_id(stem: str, used: set[str]) -> str:
    base = clean_piece(stem, 120)
    candidate = base
    idx = 2
    while candidate in used:
        candidate = f"{base}_{idx}"
        idx += 1
    used.add(candidate)
    return candidate


def _copy_first_pdf(item: dict[str, Any], settings: dict[str, Any]) -> tuple[Path | None, str, str]:
    available = [att for att in item.get("attachments") or [] if att.get("exists") and att.get("resolved_path")]
    if not available:
        return None, "", ""
    source = Path(str(available[0]["resolved_path"]))
    ai = _build_ai_stub(item)
    pdf_dir = project_path(settings.get("paths", {}).get("library_pdfs", "library/pdfs"))
    pdf_dir.mkdir(parents=True, exist_ok=True)
    target = unique_path(pdf_dir / make_pdf_name(ai, settings))
    shutil.copy2(source, target)
    return target, sha256_file(target), str(source)


def _note_markdown(item: dict[str, Any], row: dict[str, str], pdf_rel: str) -> str:
    lines = [
        f"# {row.get('标题') or row.get('paper_id')}",
        "",
        "## Zotero 元数据",
        "",
        f"- Zotero Key: {row.get('ZoteroKey', '') or '未识别'}",
        f"- 类型: {item.get('item_type', '') or '未识别'}",
        f"- 作者: {row.get('作者', '') or '未识别'}",
        f"- 年份: {row.get('年份', '') or '未识别'}",
        f"- 期刊 / 会议: {row.get('期刊会议', '') or '未识别'}",
        f"- DOI: {row.get('DOI', '') or '未识别'}",
        f"- URL: {item.get('url', '') or '未识别'}",
        f"- Collections: {row.get('Zotero集合', '') or '无'}",
        f"- Tags: {row.get('Zotero标签', '') or '无'}",
        f"- PDF: {pdf_rel or '无本地 PDF'}",
        "",
    ]
    abstract = str(item.get("abstract") or "").strip()
    if abstract:
        lines.extend(["## Zotero 摘要", "", abstract, ""])
    notes = [n for n in item.get("notes") or [] if str(n).strip()]
    if notes:
        lines.extend(["## Zotero 笔记", ""])
        for i, note in enumerate(notes, start=1):
            lines.extend([f"### Note {i}", "", str(note).strip(), ""])
    annotations = [a for a in item.get("annotations") or [] if str(a).strip()]
    if annotations:
        lines.extend(["## Zotero PDF 批注", ""])
        for item_text in annotations:
            lines.append(f"- {item_text}")
        lines.append("")
    lines.extend([
        "## AI 整理",
        "",
        "这篇文献由 Zotero 导入，尚未运行 AI 精读。需要时可在右上角点击「帮我阅读」。",
        "",
        "# 我的人工笔记",
        "",
        MANUAL_NOTE_START,
        "",
        MANUAL_NOTE_END,
        "",
    ])
    return "\n".join(lines)


def import_zotero_library(
    zotero_dir_value: str | Path,
    rows: list[dict[str, str]],
    settings: dict[str, Any],
    options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    options = options or {}
    import_notes = bool(options.get("import_notes", True))
    import_annotations = bool(options.get("import_annotations", True))
    collections_to_categories = bool(options.get("collections_to_categories", True))
    tags_to_keywords = bool(options.get("tags_to_keywords", True))
    copy_pdfs = bool(options.get("copy_pdfs", True))
    limit = int(options.get("limit", 0) or 0)

    zotero_dir = normalize_zotero_dir(zotero_dir_value)
    items = read_zotero_items(zotero_dir, limit=limit)
    existing = _existing_indexes(rows)
    used_ids = set(existing["paper_ids"])
    imported = 0
    skipped = 0
    pdf_copied = 0
    notes_created = 0
    pdf_missing = 0
    warnings: list[str] = []
    new_rows = [dict(row) for row in rows]

    for item in items:
        key = str(item.get("key") or "").strip()
        doi_norm = _normalize_doi(str(item.get("doi") or ""))
        if key and key in existing["zotero_keys"]:
            skipped += 1
            continue
        if doi_norm and doi_norm in existing["dois"]:
            skipped += 1
            continue

        pdf_path: Path | None = None
        pdf_hash = ""
        source_path = ""
        if copy_pdfs:
            try:
                pdf_path, pdf_hash, source_path = _copy_first_pdf(item, settings)
            except OSError as exc:
                warnings.append(f"{item.get('title', 'Untitled')} 的 PDF 复制失败：{exc}")
        if pdf_path and pdf_hash in existing["hashes"]:
            try:
                pdf_path.unlink(missing_ok=True)
            except OSError:
                pass
            skipped += 1
            continue
        if pdf_path:
            pdf_copied += 1
            existing["hashes"].add(pdf_hash)
            paper_id = _unique_paper_id(pdf_path.stem, used_ids)
            pdf_rel = rel(pdf_path)
        else:
            if item.get("pdf_count"):
                pdf_missing += 1
            ai = _build_ai_stub(item)
            fallback_stem = Path(make_pdf_name(ai, settings)).stem
            paper_id = _unique_paper_id(fallback_stem, used_ids)
            pdf_rel = ""

        note_dir = project_path(settings.get("paths", {}).get("library_notes", "library/notes"))
        note_dir.mkdir(parents=True, exist_ok=True)
        note_path = unique_path(note_dir / make_note_name(f"{paper_id}.pdf"))

        authors = "；".join(str(v).strip() for v in item.get("authors") or [] if str(v).strip())
        collections = "；".join(str(v).strip() for v in item.get("collections") or [] if str(v).strip())
        tags = "；".join(str(v).strip() for v in item.get("tags") or [] if str(v).strip())
        row = {field: "" for field in INDEX_FIELDS}
        row.update(
            {
                "paper_id": paper_id,
                "标题": str(item.get("title") or paper_id),
                "英文标题": str(item.get("title") or paper_id),
                "作者": authors or "未识别",
                "年份": str(item.get("year") or "Unknown"),
                "期刊会议": str(item.get("venue") or ""),
                "DOI": str(item.get("doi") or ""),
                "ZoteroKey": key,
                "Zotero库": str(zotero_dir),
                "Zotero集合": collections,
                "Zotero标签": tags,
                "Zotero版本": str(item.get("version") or ""),
                "AI一句话总结": "Zotero 导入，待 AI 整理",
                "关键词": tags if tags_to_keywords else "",
                "阅读状态": "待读",
                "最终分类": collections if collections_to_categories else "",
                "PDF路径": pdf_rel,
                "笔记路径": rel(note_path),
                "原始路径": source_path or str(zotero_dir),
                "文件哈希": pdf_hash,
                "整理时间": now_text(),
                "AI模型": ZOTERO_NOTE_SOURCE_LABEL,
                "AI置信度": "metadata",
            }
        )
        note_item = dict(item)
        if not import_notes:
            note_item["notes"] = []
        if not import_annotations:
            note_item["annotations"] = []
        atomic_write_text(note_path, _note_markdown(note_item, row, pdf_rel))
        notes_created += 1
        new_rows.append(row)
        imported += 1
        if key:
            existing["zotero_keys"].add(key)
        if doi_norm:
            existing["dois"].add(doi_norm)

    return {
        "ok": True,
        "path": str(zotero_dir),
        "rows": new_rows,
        "imported": imported,
        "skipped": skipped,
        "pdf_copied": pdf_copied,
        "notes_created": notes_created,
        "pdf_missing": pdf_missing,
        "warnings": warnings[:20],
        "total_items": len(items),
    }
