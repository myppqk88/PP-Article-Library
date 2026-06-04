from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, unquote, urlparse

from common import (
    INDEX_FIELDS,
    ROOT,
    apply_tracking_journals,
    atomic_write_text,
    load_env,
    load_settings,
    load_tracking_journals,
    now_text,
    project_path,
    read_csv,
    rel,
    scan_status_from_text,
    save_tracking_journals,
    sort_rows,
    sort_rows_for_view,
    subprocess_hidden_kwargs,
    text_quality,
    write_csv,
    write_xlsx,
)
from organize import (
    DEFAULT_NOTE_TEMPLATE,
    extract_manual_note,
    extract_pdf_text,
    generate_collections,
    load_or_generate_ai,
    render_note,
    row_from_ai,
    sha256_file,
)
import annotations as annot_module
import chat_history as chat_history_module
import citations as citations_module
import easyscholar as easyscholar_module
import excerpts as excerpts_module
import export_by_category as export_module
import yaml


WEB_DIR = ROOT / "web"
ENGLISH_EXCERPTS_PATH = ROOT / "library" / "index" / "english_excerpts.md"


# ---------------------------------------------------------------------------
# Browser-heartbeat watcher: 关闭浏览器后自动退出工作台
# ---------------------------------------------------------------------------
# 前端打开 index.html 后会每 ~15s 发一次 GET /api/heartbeat。后台 watcher
# 每 10s 检查一次：如果"曾经收到过心跳" 且 "上次心跳到现在 > IDLE_TIMEOUT
# 秒"，就调用 server.shutdown()，工作台进程随之退出。

_HEARTBEAT_LOCK = threading.Lock()
_HEARTBEAT_STATE: dict[str, Any] = {
    "last_seen": None,  # time.monotonic() 时间戳
    "ever_connected": False,
}


def heartbeat_now() -> None:
    with _HEARTBEAT_LOCK:
        _HEARTBEAT_STATE["last_seen"] = time.monotonic()
        _HEARTBEAT_STATE["ever_connected"] = True


def start_idle_watcher(server: ThreadingHTTPServer, idle_timeout: float) -> threading.Thread:
    def loop() -> None:
        while True:
            time.sleep(10)
            with _HEARTBEAT_LOCK:
                ever = _HEARTBEAT_STATE["ever_connected"]
                last = _HEARTBEAT_STATE["last_seen"]
            if not ever or last is None:
                # 浏览器还没连上过；继续等。
                continue
            if time.monotonic() - last > idle_timeout:
                print(
                    f"\n[auto-shutdown] 浏览器已离线 {idle_timeout:.0f}s，工作台自动退出。"
                )
                threading.Thread(target=server.shutdown, daemon=True).start()
                return

    thread = threading.Thread(target=loop, daemon=True, name="idle-watcher")
    thread.start()
    return thread


# ============================================================================
# Atomic settings.yaml save + papers.csv write lock.
#
# Previously settings.yaml was written via raw `path.write_text()` at 7 sites
# (each save endpoint), and papers.csv was load → mutate → save with no lock —
# two concurrent POSTs (e.g. user saving metadata while EasyScholar batch
# refresh runs) could interleave their save_rows and silently drop the loser's
# edits. Both fixed here.
# ============================================================================
_SETTINGS_YAML_PATH = ROOT / "config" / "settings.yaml"
_ROWS_LOCK = threading.RLock()  # reentrant: save_rows may be called inside lock


def save_settings_yaml(settings: dict[str, Any]) -> None:
    """Atomic settings.yaml save. Replaces 7 duplicated call sites."""
    atomic_write_text(
        _SETTINGS_YAML_PATH,
        yaml.safe_dump(settings, allow_unicode=True, sort_keys=False),
    )


def _default_codex_command() -> str:
    if sys.platform == "darwin":
        return "/Applications/Codex.app/Contents/Resources/codex"
    if sys.platform == "win32":
        # Codex Desktop on Windows ships as %LOCALAPPDATA%\Programs\codex\codex.exe
        # Falling back to "codex" lets a $PATH-installed binary work too.
        return "codex.exe"
    return "codex"


def _default_claude_command() -> str:
    """Best-effort default path for the Claude Code CLI binary."""
    if sys.platform == "win32":
        return "claude.cmd"
    return "claude"

PROVIDER_DEFAULTS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "base_url": "https://api.deepseek.com",
        "model": "deepseek-v4-flash",
        "api_key_env": "DEEPSEEK_API_KEY",
        "temperature": 0.2,
        "max_tokens": 3500,
        "timeout_seconds": 120,
    },
    "qwen": {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "model": "qwen-plus",
        "api_key_env": "QWEN_API_KEY",
        "temperature": 0.2,
        "max_tokens": 3500,
        "timeout_seconds": 120,
    },
    "openai_compatible": {
        "base_url": "",
        "model": "",
        "api_key_env": "OPENAI_API_KEY",
        "temperature": 0.2,
        "max_tokens": 3500,
        "timeout_seconds": 120,
    },
}
ORGANIZE_JOBS: dict[str, dict[str, Any]] = {}
ORGANIZE_LOCK = threading.Lock()


def json_bytes(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")


def safe_root_path(value: str) -> Path:
    path = project_path(unquote(value))
    resolved = path.resolve()
    root = ROOT.resolve()
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("path is outside project") from exc
    return resolved


def load_rows() -> list[dict[str, str]]:
    settings = load_settings()
    # Reads can race with writes; the lock is reentrant + cheap so we just
    # always take it. Returns a fresh list, no shared mutable state escapes.
    with _ROWS_LOCK:
        return read_csv(project_path(settings["index"]["csv"]))


# Track which mutation cycles should trigger the heavy xlsx + collections
# rewrite. These are expensive (~500ms each on 506 rows) so we batch them:
# CSV is updated synchronously (source of truth), xlsx + collections are
# debounced via a background thread.
_DEFERRED_REBUILD_TIMER: threading.Timer | None = None
_DEFERRED_REBUILD_LOCK = threading.Lock()
_DEFERRED_REBUILD_DELAY = 4.0  # seconds

# Last rebuild error, polled by frontend via /api/status so we can toast
# "papers.xlsx 被 Excel 占用" instead of dying silently in a daemon thread.
_LAST_REBUILD_ERROR: dict[str, Any] = {"ts": None, "kind": "", "message": ""}


def _do_deferred_rebuild() -> None:
    """Heavy step: rebuild xlsx + collections from the current CSV.
    Runs in a daemon thread, debounced after the latest mutation."""
    global _DEFERRED_REBUILD_TIMER
    try:
        settings = load_settings()
        with _ROWS_LOCK:
            rows = read_csv(project_path(settings["index"]["csv"]))
            write_xlsx(project_path(settings["index"]["xlsx"]), rows)
            generate_collections(rows, settings)
        # Success → clear any sticky error
        if _LAST_REBUILD_ERROR["ts"] is not None:
            _LAST_REBUILD_ERROR["ts"] = None
            _LAST_REBUILD_ERROR["kind"] = ""
            _LAST_REBUILD_ERROR["message"] = ""
    except PermissionError as exc:
        traceback.print_exc()
        _LAST_REBUILD_ERROR["ts"] = now_text()
        _LAST_REBUILD_ERROR["kind"] = "xlsx_locked"
        _LAST_REBUILD_ERROR["message"] = (
            "papers.xlsx 被其他程序占用（通常是 Excel 打开着）。"
            "请关闭 Excel 中的这个文件，然后再保存任何文献就会自动重试。"
            f"\n（原始：{exc}）"
        )
    except Exception as exc:
        traceback.print_exc()
        _LAST_REBUILD_ERROR["ts"] = now_text()
        _LAST_REBUILD_ERROR["kind"] = "rebuild_failed"
        _LAST_REBUILD_ERROR["message"] = f"papers.xlsx / collections 重建失败：{exc}"
    finally:
        with _DEFERRED_REBUILD_LOCK:
            _DEFERRED_REBUILD_TIMER = None


def _schedule_deferred_rebuild() -> None:
    """Schedule (or restart) the debounced xlsx + collections rebuild."""
    global _DEFERRED_REBUILD_TIMER
    with _DEFERRED_REBUILD_LOCK:
        if _DEFERRED_REBUILD_TIMER is not None:
            _DEFERRED_REBUILD_TIMER.cancel()
        _DEFERRED_REBUILD_TIMER = threading.Timer(
            _DEFERRED_REBUILD_DELAY, _do_deferred_rebuild
        )
        _DEFERRED_REBUILD_TIMER.daemon = True
        _DEFERRED_REBUILD_TIMER.start()


def _flush_deferred_rebuild_on_exit() -> None:
    """Run any pending xlsx + collections rebuild SYNCHRONOUSLY at shutdown.

    Without this, Ctrl-C within the 4s debounce window after a save would
    leave papers.xlsx + collections/ stale vs papers.csv until the next
    mutation.
    """
    global _DEFERRED_REBUILD_TIMER
    with _DEFERRED_REBUILD_LOCK:
        pending = _DEFERRED_REBUILD_TIMER is not None
        if _DEFERRED_REBUILD_TIMER is not None:
            _DEFERRED_REBUILD_TIMER.cancel()
            _DEFERRED_REBUILD_TIMER = None
    if pending:
        print("[shutdown] flushing pending xlsx + collections rebuild…", flush=True)
        try:
            _do_deferred_rebuild_sync()
        except Exception as exc:
            print(f"[shutdown] rebuild failed: {exc}", flush=True)


def _do_deferred_rebuild_sync() -> None:
    """Synchronous variant of _do_deferred_rebuild — used by atexit only."""
    settings = load_settings()
    with _ROWS_LOCK:
        rows = read_csv(project_path(settings["index"]["csv"]))
        write_xlsx(project_path(settings["index"]["xlsx"]), rows)
        generate_collections(rows, settings)


import atexit as _atexit
_atexit.register(_flush_deferred_rebuild_on_exit)


def _sweep_stale_tmp_files() -> None:
    """Remove .tmp leftovers from interrupted atomic_write_text calls.

    Safe because the corresponding real file is intact — atomic_write_text
    only calls os.replace AFTER writing the .tmp succeeded. A lingering .tmp
    means the write was interrupted, not committed. We only delete .tmp files
    older than 60s to avoid racing an in-flight write from another thread.
    """
    import time as _t
    cutoff = _t.time() - 60
    targets = [
        ROOT / "library" / "notes",
        ROOT / "library" / "index",
        ROOT / "library" / "text",
        ROOT / "library" / "cache",
        ROOT / "library" / "chat_history",
        ROOT / "library" / "annotations",
        ROOT / "config",
        ROOT / "citations",
    ]
    removed = 0
    for d in targets:
        if not d.exists():
            continue
        try:
            for tmp in d.glob("*.tmp"):
                try:
                    if tmp.stat().st_mtime < cutoff:
                        tmp.unlink()
                        removed += 1
                except OSError:
                    pass
        except OSError:
            pass
    if removed:
        print(f"[startup] swept {removed} stale .tmp file(s) from previous interrupted writes", flush=True)


def save_rows(rows: list[dict[str, str]]) -> None:
    """Persist papers.csv (the source of truth) under a global lock so two
    concurrent mutations don't load → modify → save and silently drop one
    side's edits.

    xlsx + collections rebuild runs in a debounced background thread —
    they're derivative artifacts and the synchronous overhead (~1s+ on
    506 rows) used to fire on every checkbox click."""
    settings = load_settings()
    with _ROWS_LOCK:
        apply_tracking_journals(rows, settings)
        rows = sort_rows(rows)
        write_csv(project_path(settings["index"]["csv"]), rows)
    _schedule_deferred_rebuild()


def current_model_label(settings: dict[str, Any]) -> str:
    provider = str(settings.get("api", {}).get("provider", "") or "")
    model = str(settings.get("api", {}).get("model", "") or "")
    if provider in {"codex", "codex_cli", "codex-cli"}:
        model = str(settings.get("codex_cli", {}).get("model") or "gpt-5.4")
    elif provider in {"claude", "claude_cli", "claude-cli"}:
        model = str(settings.get("claude_cli", {}).get("model") or "claude-sonnet-4-5")
    return f"{provider} / {model}".strip(" /")


def organize_job_snapshot(job_id: str) -> dict[str, Any]:
    with ORGANIZE_LOCK:
        job = dict(ORGANIZE_JOBS.get(job_id, {}))
        job["job_id"] = job_id
        return job


def update_organize_job(job_id: str, **updates: Any) -> None:
    with ORGANIZE_LOCK:
        job = ORGANIZE_JOBS.setdefault(job_id, {})
        job.update(updates)


def parse_organize_line(job_id: str, line: str) -> None:
    clean = line.strip()
    if not clean:
        return
    updates: dict[str, Any] = {"message": clean}
    model_match = re.search(r"模型：(.+)", clean)
    if model_match:
        updates["model"] = model_match.group(1).strip()
    total_match = re.search(r"发现\s+(\d+)\s+个 PDF", clean)
    if total_match:
        updates["total"] = int(total_match.group(1))
        updates["current"] = 0
    current_match = re.search(r"\[(\d+)/(\d+)\]\s+(.+)", clean)
    if current_match:
        updates["current"] = int(current_match.group(1))
        updates["total"] = int(current_match.group(2))
        updates["current_file"] = current_match.group(3)
    if "没有发现待整理 PDF" in clean:
        updates["current"] = 0
        updates["total"] = 0
    update_organize_job(job_id, **updates)
    with ORGANIZE_LOCK:
        logs = ORGANIZE_JOBS[job_id].setdefault("logs", [])
        logs.append(clean)
        del logs[:-80]


def run_organize_job(job_id: str) -> None:
    settings = load_settings()
    update_organize_job(
        job_id,
        status="running",
        current=0,
        total=0,
        model=current_model_label(settings),
        message="正在启动整理任务",
        returncode=None,
        logs=[],
    )
    cmd = [sys.executable, str(ROOT / "scripts" / "organize.py")]
    try:
        process = subprocess.Popen(
            cmd,
            cwd=str(ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            **subprocess_hidden_kwargs(),
        )
        update_organize_job(job_id, pid=process.pid)
        assert process.stdout is not None
        for line in process.stdout:
            parse_organize_line(job_id, line)
        returncode = process.wait()
        if returncode == 0:
            update_organize_job(job_id, status="done", returncode=returncode, message="整理完成")
        else:
            update_organize_job(job_id, status="error", returncode=returncode, message=f"整理失败：退出码 {returncode}")
    except Exception as exc:
        update_organize_job(job_id, status="error", returncode=-1, message=f"整理失败：{exc}")


def find_row(paper_id: str, rows: list[dict[str, str]]) -> dict[str, str] | None:
    for row in rows:
        if row.get("paper_id") == paper_id:
            return row
    return None


def _sanitize_category_name(value: str) -> str:
    """Strip characters that would shatter category-storage round-trip.

    The storage layer joins categories with `；` and splits on `；`/`;`, so
    a category name containing either separator would corrupt itself.
    Newlines and tabs break the CSV/Markdown rendering. Everything else
    (commas, colons, quotes, parens, Chinese punctuation) is fine.
    """
    return re.sub(r"[；;\r\n\t]+", " ", str(value or "")).strip()


def normalize_category_tree(raw_tree: Any) -> dict[str, dict[str, list[str]]]:
    """Normalize to nested 3-level structure: {primary: {secondary: [tertiary, ...]}}.

    Accepts either the old format (children is a flat `list[str]` of
    secondaries, no tertiaries) or the new nested dict format. Empty / bad
    entries are dropped. Order is preserved. Names with separator chars are
    sanitized rather than rejected so we never silently lose user data.
    """
    tree: dict[str, dict[str, list[str]]] = {}
    if not isinstance(raw_tree, dict):
        return tree
    for raw_primary, raw_children in raw_tree.items():
        primary = _sanitize_category_name(raw_primary)
        if not primary:
            continue
        secondaries: dict[str, list[str]] = {}
        if isinstance(raw_children, list):
            # 旧格式：列表里只放二级分类，没有三级
            for item in raw_children:
                sec = _sanitize_category_name(item)
                if sec and sec not in secondaries:
                    secondaries[sec] = []
        elif isinstance(raw_children, dict):
            for raw_sec, raw_thirds in raw_children.items():
                sec = _sanitize_category_name(raw_sec)
                if not sec or sec in secondaries:
                    continue
                tertiaries: list[str] = []
                if isinstance(raw_thirds, list):
                    for t in raw_thirds:
                        tname = _sanitize_category_name(t)
                        if tname and tname not in tertiaries:
                            tertiaries.append(tname)
                secondaries[sec] = tertiaries
        tree[primary] = secondaries
    return tree


def all_config_categories(settings: dict[str, Any]) -> list[str]:
    categories: list[str] = []
    tree = normalize_category_tree(settings.get("classification", {}).get("primary_categories", {}))
    for primary, secondaries in tree.items():
        categories.append(primary)
        for sec, tertiaries in secondaries.items():
            categories.append(sec)
            categories.extend(tertiaries)
    categories.extend(settings.get("classification", {}).get("custom_categories", []) or [])
    clean: list[str] = []
    for category in categories:
        value = str(category).strip()
        if value and value not in clean:
            clean.append(value)
    return clean


# The 7 fields that hold category tokens. Used by BOTH the sidebar count
# (categories_from_rows) and the paper filter (row_in_category) so the dropdown
# number and the filtered list are always consistent.
CATEGORY_FIELDS = (
    "最终分类",
    "一级分类",
    "二级分类",
    "三级分类",
    "人工分类",
    "一级分类_AI建议",
    "二级分类_AI建议",
)


def row_category_tokens(row: dict[str, str]) -> set[str]:
    """All distinct `；`-delimited category tokens present on one paper row."""
    tokens: set[str] = set()
    for field in CATEGORY_FIELDS:
        raw = row.get(field, "")
        if not raw:
            continue
        # Only split on `；` / `;` — commas are legitimate inside category
        # names (e.g. "Mapping ... in China: A Structural, Temporal, ...").
        for part in re.split(r"[；;]", raw):
            tok = part.strip()
            if tok:
                tokens.add(tok)
    return tokens


def row_in_category(row: dict[str, str], category: str) -> bool:
    """True iff `category` is an EXACT token of one of the row's category
    fields. Used by the paper filter — must mirror categories_from_rows so the
    dropdown count and the filtered list agree. NOT a substring match: a sloppy
    substring search would wrongly include papers that merely mention the
    category name in their notes/title (e.g. a manuscript title)."""
    if not category:
        return False
    return category in row_category_tokens(row)


def categories_from_rows(rows: list[dict[str, str]]) -> list[dict[str, Any]]:
    settings = load_settings()
    counts: dict[str, int] = {}
    for category in all_config_categories(settings):
        counts.setdefault(category, 0)
    for row in rows:
        # Count each paper ONCE per category. 最终分类 is normally a copy of
        # 一级/二级/三级分类, so summing every field occurrence triple-counts
        # the same paper — the sidebar number should be "how many papers are
        # in this category", not "how many field cells mention it".
        for category in row_category_tokens(row):
            counts[category] = counts.get(category, 0) + 1
    return [{"name": name, "count": count} for name, count in sorted(counts.items())]


# Backwards-compat alias (clean_category_tree was the old name).
def clean_category_tree(raw_tree: Any) -> dict[str, dict[str, list[str]]]:
    return normalize_category_tree(raw_tree)


def category_tree_payload() -> dict[str, Any]:
    settings = load_settings()
    tree = normalize_category_tree(settings.get("classification", {}).get("primary_categories", {}))
    return {"ok": True, "tree": tree}


def save_category_tree_payload(payload: dict[str, Any]) -> dict[str, Any]:
    settings = load_settings()
    tree = normalize_category_tree(payload.get("tree", {}))
    settings.setdefault("classification", {})["primary_categories"] = tree
    save_settings_yaml(settings)
    return settings


# ---------------------------------------------------------------------------
# Category rename helpers: keep paper rows in sync when a level gets renamed.
# ---------------------------------------------------------------------------


def _split_tokens(value: str) -> list[str]:
    # Only split on `；` / `;`; commas are legitimate inside category names.
    return [s.strip() for s in re.split(r"[；;]", str(value or "")) if s.strip()]


# ============================================================================
# Model detection — powers the "检测可用模型" picker so users never have to
# remember / spell model names.
# ============================================================================
def _detect_ollama_models(base_url: str) -> dict[str, Any]:
    """List models installed in a local Ollama via GET /api/tags."""
    import requests
    url = (base_url or "http://127.0.0.1:11434").rstrip("/") + "/api/tags"
    try:
        resp = requests.get(url, timeout=8)
        if resp.status_code >= 400:
            return {"ok": True, "source": "ollama",
                    "models": [], "error": f"Ollama 返回 HTTP {resp.status_code}"}
        data = resp.json()
        models = []
        for m in data.get("models", []):
            name = m.get("name") or m.get("model") or ""
            if name:
                size_gb = round((m.get("size", 0) or 0) / 1e9, 1)
                models.append({"id": name, "available": True,
                               "note": f"已安装{(' · ' + str(size_gb) + ' GB') if size_gb else ''}"})
        return {"ok": True, "source": "ollama", "models": models}
    except Exception as exc:
        return {"ok": True, "source": "ollama", "models": [],
                "error": f"连不上 Ollama（{base_url or 'http://127.0.0.1:11434'}）：{exc}"}


def _detect_openai_models(base_url: str, api_key_env: str) -> dict[str, Any]:
    """Probe an OpenAI-compatible /models endpoint. On failure, fall back to a
    curated list inferred from the base_url host."""
    import requests
    curated = _curated_for_base_url(base_url)
    if not base_url:
        return {"ok": True, "source": "curated", "models": curated,
                "error": "未填 Base URL，下面是常用模型清单（未实测）"}
    key = os.environ.get(api_key_env, "") if api_key_env else ""
    url = base_url.rstrip("/") + "/models"
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        resp = requests.get(url, headers=headers, timeout=12)
        if resp.status_code >= 400:
            return {"ok": True, "source": "curated", "models": curated,
                    "error": f"/models 返回 HTTP {resp.status_code}，下面是常用清单（未实测）"}
        data = resp.json()
        items = data.get("data") if isinstance(data, dict) else None
        if not items:
            return {"ok": True, "source": "curated", "models": curated,
                    "error": "该接口未返回模型列表，下面是常用清单（未实测）"}
        models = []
        for it in items:
            mid = it.get("id") if isinstance(it, dict) else str(it)
            if mid:
                models.append({"id": mid, "available": True, "note": "接口确认可用"})
        models.sort(key=lambda m: m["id"])
        return {"ok": True, "source": "api", "models": models}
    except Exception as exc:
        return {"ok": True, "source": "curated", "models": curated,
                "error": f"连接失败（{exc}），下面是常用清单（未实测）"}


def _curated_for_base_url(base_url: str) -> list[dict[str, Any]]:
    """Best-guess curated model list based on the API host."""
    host = (base_url or "").lower()
    if "deepseek" in host:
        return [
            {"id": "deepseek-chat", "available": False, "note": "快·便宜，整理/笔记首选"},
            {"id": "deepseek-reasoner", "available": False, "note": "推理强，慢"},
            {"id": "deepseek-v4-pro", "available": False, "note": "旗舰推理"},
            {"id": "deepseek-v4-flash", "available": False, "note": "轻量快速"},
        ]
    if "dashscope" in host or "aliyun" in host:
        return [
            {"id": "qwen-plus", "available": False, "note": "均衡·推荐"},
            {"id": "qwen-flash", "available": False, "note": "最快·最便宜"},
            {"id": "qwen-max", "available": False, "note": "能力最强"},
            {"id": "qwen-turbo", "available": False, "note": "轻量"},
            {"id": "qwen-vl-plus", "available": False, "note": "视觉·均衡"},
            {"id": "qwen-vl-max", "available": False, "note": "视觉·最强"},
        ]
    if "openai.com" in host or "api.openai" in host:
        return [
            {"id": "gpt-4o-mini", "available": False, "note": "便宜·够用"},
            {"id": "gpt-4o", "available": False, "note": "旗舰多模态"},
        ]
    return [{"id": "", "available": False, "note": "未知接口 — 请查该服务商文档手填模型名"}]


def _curated_codex_models() -> dict[str, Any]:
    """Codex CLI has no list-models API — curated set of known model names."""
    return {
        "ok": True, "source": "curated",
        "error": "Codex CLI 没有模型列表接口，下面是已知可用模型（按你的订阅而定）",
        "models": [
            {"id": "gpt-5.5", "available": False, "note": "最新·能力最强"},
            {"id": "gpt-5.4", "available": False, "note": "上一代·稳定"},
            {"id": "gpt-5.4-codex", "available": False, "note": "代码优化版"},
        ],
    }


def _claude_aliases() -> list[dict[str, Any]]:
    """The evergreen Claude model aliases — these ALWAYS resolve to the latest
    release of each tier, so they never go stale. Recommended over dated names."""
    return [
        {"id": "sonnet", "available": True, "note": "别名→当前最新 Sonnet（均衡·推荐，永不过时）"},
        {"id": "opus", "available": True, "note": "别名→当前最新 Opus（最强·最贵）"},
        {"id": "haiku", "available": True, "note": "别名→当前最新 Haiku（最快·最便宜）"},
    ]


def _claude_dated_models() -> list[dict[str, Any]]:
    """Known dated Claude model ids usable via the CLI's subscription auth.
    The CLI (logged in via `claude login`) can use these without an API key —
    they just can't be auto-enumerated without one. Refresh this when Anthropic
    ships new versions; or configure ANTHROPIC_API_KEY for live detection."""
    return [
        {"id": "claude-opus-4-7", "available": False, "note": "Opus 最新 · 订阅版"},
        {"id": "claude-sonnet-4-6", "available": False, "note": "Sonnet 最新 · 订阅版"},
        {"id": "claude-opus-4-1", "available": False, "note": "Opus 上一代"},
        {"id": "claude-sonnet-4-5", "available": False, "note": "Sonnet 上一代"},
        {"id": "claude-haiku-4-5", "available": False, "note": "Haiku · 最快"},
    ]


def _detect_claude_models() -> dict[str, Any]:
    """List Claude models.

    A hardcoded list goes stale (sonnet-4-5 → 4-6 → ...). So: if
    ANTHROPIC_API_KEY is configured, query Anthropic's real /v1/models endpoint
    and return the CURRENT model list (sonnet-4-6, opus-4-7, whatever is live).
    Without a key, fall back to the evergreen aliases — `sonnet` / `opus` /
    `haiku` always point to the latest release, so they're never wrong.
    """
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        try:
            import requests
            resp = requests.get(
                "https://api.anthropic.com/v1/models?limit=100",
                headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                timeout=12,
            )
            if resp.status_code < 400:
                data = resp.json()
                api_models = []
                for it in data.get("data", []):
                    mid = it.get("id", "")
                    if mid:
                        disp = it.get("display_name", "") or "Anthropic API 确认"
                        api_models.append({"id": mid, "available": True, "note": disp})
                # Newest first (ids sort roughly by version)
                api_models.sort(key=lambda m: m["id"], reverse=True)
                return {
                    "ok": True, "source": "api",
                    "error": "Anthropic API 实时返回当前全部模型 · 顶部 3 个别名永不过时",
                    "models": _claude_aliases() + api_models,
                }
            err = f"HTTP {resp.status_code}"
        except Exception as exc:
            err = str(exc)
        return {
            "ok": True, "source": "curated",
            "error": (f"用 ANTHROPIC_API_KEY 查 Anthropic /v1/models 失败（{err}）。"
                      "下面是别名 + 已知订阅模型；别名永不过时，带版本号的按你账号订阅而定。"),
            "models": _claude_aliases() + _claude_dated_models(),
        }
    # No API key — aliases + known dated ids. The CLI (claude login) CAN use
    # the dated models via subscription auth; they just can't be auto-listed.
    return {
        "ok": True, "source": "curated",
        "error": ("Claude CLI 走 `claude login` 订阅、不需要 API key —— 但也因此无法"
                  "自动列出带版本号的模型。下面：别名 sonnet/opus/haiku 永远指向最新版（推荐）；"
                  "带版本号的是已知订阅模型，能直接用；要更精确的实时列表，可在"
                  " Claude CLI 设置里填 ANTHROPIC_API_KEY。也可在下方「手动输入」直接打任意模型名。"),
        "models": _claude_aliases() + _claude_dated_models(),
    }


# ============================================================================
# Approximate / fuzzy search.
#
# The old search did a raw case-folded substring test — so pasting a title with
# one extra comma/colon/space (very common when copying) found nothing. This
# two-tier matcher fixes that:
#   Tier 1  normalized substring — strip ALL punctuation/symbols + collapse
#           whitespace on both sides, then substring test. An accidental extra
#           「，」「：」 simply vanishes, so the paste matches again.
#   Tier 2  ≥80% unit coverage — split the query into units (English words /
#           Chinese 2-gram bigrams) and require 80%+ of them to appear in the
#           normalized haystack. Catches a missing word or a small typo.
#           Bigrams (not single CJK chars) keep this specific enough to avoid
#           matching everything.
# ============================================================================
_SEARCH_COVERAGE_THRESHOLD = 0.8


def _normalize_search(text: str) -> str:
    """Lowercase; replace every non-alphanumeric / non-CJK char with a space;
    collapse runs of whitespace. Punctuation differences disappear."""
    s = str(text or "").lower()
    s = re.sub(r"[^0-9a-z一-鿿]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def _search_units(normalized_query: str) -> list[str]:
    """Break a normalized query into match units: each English word is one
    unit; each Chinese run becomes overlapping 2-char bigrams (or the single
    char if length 1)."""
    units: list[str] = []
    for word in normalized_query.split():
        if re.search(r"[一-鿿]", word):
            if len(word) == 1:
                units.append(word)
            else:
                units.extend(word[i:i + 2] for i in range(len(word) - 1))
        else:
            units.append(word)
    return units


def search_row_matches(query: str, haystack: str) -> bool:
    """True if `query` approximately occurs in `haystack`. See header above."""
    nq = _normalize_search(query)
    if not nq:
        return True  # empty query matches everything
    nh = _normalize_search(haystack)
    # Tier 1: normalized substring (punctuation / case / spacing tolerant)
    if nq in nh:
        return True
    # Tier 2: ≥80% unit coverage. Skip for very short queries — too few units
    # to fuzzy-match safely.
    units = _search_units(nq)
    if len(units) < 2:
        return False
    hits = sum(1 for u in units if u in nh)
    return hits / len(units) >= _SEARCH_COVERAGE_THRESHOLD


def _replace_token_in_field(row: dict[str, str], field: str, old: str, new: str) -> bool:
    """Replace token `old` with `new` inside `；`-delimited `field`. If `new`
    is empty, the token is removed. Dedupes the result. Returns True if the
    field actually changed.
    """
    if not old:
        return False
    tokens = _split_tokens(row.get(field, ""))
    if old not in tokens:
        return False
    new_tokens: list[str] = []
    for t in tokens:
        if t == old:
            if new and new not in new_tokens:
                new_tokens.append(new)
        else:
            if t not in new_tokens:
                new_tokens.append(t)
    row[field] = "；".join(new_tokens)
    return True


# 各级 rename 时要扫的字段。最终分类 永远扫。AI 建议字段也跟着改，避免
# UI 上下次再显示老名字。
_LEVEL_FIELDS: dict[str, list[str]] = {
    "primary": ["一级分类", "一级分类_AI建议", "最终分类"],
    "secondary": ["二级分类", "二级分类_AI建议", "最终分类"],
    "tertiary": ["三级分类", "最终分类"],
}


def migrate_rows_for_rename(level: str, old: str, new: str) -> int:
    """Walk all rows, rename token `old`→`new` in the fields tied to `level`.
    Saves rows on disk if anything changed. Returns count of rows touched.
    """
    if level not in _LEVEL_FIELDS or not old:
        return 0
    rows = load_rows()
    changed = 0
    for row in rows:
        touched = False
        for field in _LEVEL_FIELDS[level]:
            if _replace_token_in_field(row, field, old, new):
                touched = True
        if touched:
            changed += 1
    if changed:
        save_rows(rows)
    return changed


def paper_payload(row: dict[str, str]) -> dict[str, str]:
    payload = dict(row)
    pdf = row.get("PDF路径", "").replace("\\", "/")
    note = row.get("笔记路径", "").replace("\\", "/")
    payload["PDF路径"] = pdf
    payload["笔记路径"] = note
    payload["pdf_url"] = f"/file?path={quote(pdf, safe='/')}" if pdf else ""
    payload["note_url"] = f"/file?path={quote(note, safe='/')}" if note else ""
    return payload


def note_path_for(row: dict[str, str]) -> Path:
    note_rel = row.get("笔记路径", "")
    if not note_rel:
        raise ValueError("missing note path")
    return safe_root_path(note_rel)


def text_cache_path_for(row: dict[str, str], settings: dict[str, Any] | None = None) -> Path:
    settings = settings or load_settings()
    return project_path(settings["paths"]["text_dir"]) / f"{row.get('文件哈希', '')}.txt"


def ai_cache_path_for(row: dict[str, str], settings: dict[str, Any] | None = None) -> Path:
    settings = settings or load_settings()
    return project_path(settings["paths"]["cache_dir"]) / f"{row.get('文件哈希', '')}.json"


def remove_project_file(path: Path, deleted: list[str]) -> None:
    resolved = path.resolve()
    try:
        resolved.relative_to(ROOT.resolve())
    except ValueError:
        return
    if resolved.exists() and resolved.is_file():
        resolved.unlink()
        deleted.append(rel(resolved))


def cached_or_extract_text(row: dict[str, str]) -> tuple[str, dict[str, Any], Path]:
    settings = load_settings()
    text_path = text_cache_path_for(row, settings)
    if text_path.exists():
        text = text_path.read_text(encoding="utf-8")
        return text, text_quality(text), text_path
    pdf_rel = row.get("PDF路径", "")
    if not pdf_rel:
        raise ValueError("missing PDF path")
    pdf_path = safe_root_path(pdf_rel)
    text_path.parent.mkdir(parents=True, exist_ok=True)
    text, meta = extract_pdf_text(pdf_path, settings)
    atomic_write_text(text_path, text)
    quality = text_quality(text)
    quality["source"] = meta.get("pdf_text_source", "")
    return text, quality, text_path


def full_text_cache_path_for(row: dict[str, str], settings: dict[str, Any] | None = None) -> Path:
    """Separate cache for the FULL-PDF extraction (every page). Kept apart from
    the quick-scan {hash}.txt so 整理新文献 stays fast while AI Q&A gets the
    whole paper."""
    settings = settings or load_settings()
    return project_path(settings["paths"]["text_dir"]) / f"{row.get('文件哈希', '')}.full.txt"


def cached_or_extract_full_text(row: dict[str, str]) -> str:
    """Full text of the whole PDF (all pages), cached to {hash}.full.txt.

    Used by AI Q&A so the model can answer about the MIDDLE of a long paper —
    the quick-scan cache only has the first 10 + last 4 pages.
    """
    settings = load_settings()
    full_path = full_text_cache_path_for(row, settings)
    if full_path.exists():
        cached = full_path.read_text(encoding="utf-8")
        if cached.strip():
            return cached
    pdf_rel = row.get("PDF路径", "")
    if not pdf_rel:
        # Fall back to whatever quick-scan text we have
        return cached_or_extract_text(row)[0]
    pdf_path = safe_root_path(pdf_rel)
    if not pdf_path.exists():
        return cached_or_extract_text(row)[0]
    full_path.parent.mkdir(parents=True, exist_ok=True)
    text, _meta = extract_pdf_text(pdf_path, settings, file_hash=row.get("文件哈希", ""), full=True)
    if text.strip():
        atomic_write_text(full_path, text)
    return text


def update_row_scan_status(row: dict[str, str], settings: dict[str, Any]) -> bool:
    text_path = text_cache_path_for(row, settings)
    text = ""
    if text_path.exists():
        text = text_path.read_text(encoding="utf-8")
    else:
        pdf_rel = row.get("PDF路径", "")
        if pdf_rel:
            pdf_path = safe_root_path(pdf_rel)
            text, _meta = extract_pdf_text(pdf_path, settings)
            text_path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(text_path, text)
    status = scan_status_from_text(text)
    if row.get("扫描件", "") != status:
        row["扫描件"] = status
        return True
    return False


def parse_page_spec(page_spec: str, page_count: int, max_pages: int) -> list[int]:
    pages: list[int] = []
    for raw in re.split(r"[,\s，；;]+", page_spec.strip()):
        if not raw:
            continue
        if "-" in raw:
            start_raw, end_raw = raw.split("-", 1)
            start = int(start_raw)
            end = int(end_raw)
            if start > end:
                start, end = end, start
            candidates = range(start, end + 1)
        else:
            candidates = [int(raw)]
        for page in candidates:
            if page < 1 or page > page_count:
                raise ValueError(f"页码 {page} 超出范围，本 PDF 共 {page_count} 页")
            if page not in pages:
                pages.append(page)
            if len(pages) > max_pages:
                raise ValueError(f"一次最多读取 {max_pages} 页，请缩小页码范围")
    if not pages:
        raise ValueError("请填写要读取的页码，例如 1 或 1,3-5")
    return pages


def render_pdf_page_images(
    row: dict[str, str],
    page_spec: str,
    output_dir: Path,
    settings: dict[str, Any],
) -> list[dict[str, Any]]:
    try:
        import fitz
    except Exception as exc:
        raise RuntimeError("缺少 PDF 页面渲染组件 PyMuPDF，请先安装后再使用按页读图功能") from exc

    pdf_rel = row.get("PDF路径", "")
    if not pdf_rel:
        raise ValueError("当前文献缺少 PDF 路径")
    pdf_path = safe_root_path(pdf_rel)
    dpi = int(settings.get("pdf", {}).get("image_dpi", 150))
    max_pages = int(settings.get("pdf", {}).get("max_image_pages", 6))
    output_dir.mkdir(parents=True, exist_ok=True)
    images: list[dict[str, Any]] = []
    with fitz.open(str(pdf_path)) as doc:
        pages = parse_page_spec(page_spec, len(doc), max_pages)
        zoom = dpi / 72
        matrix = fitz.Matrix(zoom, zoom)
        for page_no in pages:
            page = doc[page_no - 1]
            pixmap = page.get_pixmap(matrix=matrix, alpha=False)
            png_bytes = pixmap.tobytes("png")
            image_path = output_dir / f"page-{page_no}.png"
            image_path.write_bytes(png_bytes)
            data_url = "data:image/png;base64," + base64.b64encode(png_bytes).decode("ascii")
            images.append({"page": page_no, "path": image_path, "data_url": data_url})
    return images


def read_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or "0")
    raw = handler.rfile.read(length) if length else b"{}"
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def update_env_file(key: str, value: str) -> None:
    if not key or not value:
        return
    env_path = ROOT / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    found = False
    new_lines = []
    for line in lines:
        if line.startswith(f"{key}="):
            new_lines.append(f"{key}={value}")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"{key}={value}")
    atomic_write_text(env_path, "\n".join(new_lines).rstrip() + "\n")
    os.environ[key] = value


def provider_settings_for(settings: dict[str, Any]) -> dict[str, dict[str, Any]]:
    api = settings.get("api", {})
    active_provider = str(api.get("provider", "deepseek")).strip() or "deepseek"
    stored = settings.get("provider_settings", {}) or {}
    result: dict[str, dict[str, Any]] = {}
    for provider, defaults in PROVIDER_DEFAULTS.items():
        item = dict(defaults)
        if isinstance(stored.get(provider), dict):
            item.update(stored[provider])
        if active_provider == provider:
            for key in ["base_url", "model", "api_key_env", "temperature", "max_tokens", "timeout_seconds"]:
                if api.get(key, "") != "":
                    item[key] = api[key]
        result[provider] = item
    return result


def save_settings_payload(payload: dict[str, Any]) -> dict[str, Any]:
    settings = load_settings()
    api = settings.setdefault("api", {})
    selected_provider = str(payload.get("provider", api.get("provider", "deepseek"))).strip() or "deepseek"
    stored = settings.setdefault("provider_settings", {})
    incoming_providers = payload.get("provider_settings", {}) or {}
    if isinstance(incoming_providers, dict):
        for provider, incoming in incoming_providers.items():
            if provider not in PROVIDER_DEFAULTS or not isinstance(incoming, dict):
                continue
            item = dict(PROVIDER_DEFAULTS[provider])
            if isinstance(stored.get(provider), dict):
                item.update(stored[provider])
            for key in ["base_url", "model", "api_key_env"]:
                if key in incoming:
                    item[key] = str(incoming[key]).strip()
            for key in ["temperature", "max_tokens", "timeout_seconds"]:
                if key in incoming and str(incoming[key]).strip():
                    item[key] = float(incoming[key]) if key == "temperature" else int(float(incoming[key]))
            if str(incoming.get("api_key", "")).strip():
                update_env_file(str(item.get("api_key_env", "")).strip(), str(incoming["api_key"]).strip())
            stored[provider] = item

    codex_payload = payload.get("codex_cli", {}) or {}
    codex = settings.setdefault("codex_cli", {})
    for key in ["command", "model", "sandbox"]:
        if key in codex_payload:
            value = str(codex_payload[key]).strip()
            codex[key] = "gpt-5.4" if key == "model" and not value else value
    if "timeout_seconds" in codex_payload and str(codex_payload["timeout_seconds"]).strip():
        codex["timeout_seconds"] = int(float(codex_payload["timeout_seconds"]))

    claude_payload = payload.get("claude_cli", {}) or {}
    claude = settings.setdefault("claude_cli", {})
    for key in ["command", "model"]:
        if key in claude_payload:
            value = str(claude_payload[key]).strip()
            if key == "model" and not value:
                value = "claude-sonnet-4-5"
            claude[key] = value
    if "timeout_seconds" in claude_payload and str(claude_payload["timeout_seconds"]).strip():
        claude["timeout_seconds"] = int(float(claude_payload["timeout_seconds"]))
    # Allow saving ANTHROPIC_API_KEY through this panel — convenient since
    # the Claude CLI also accepts it instead of OAuth.
    api_key = str(claude_payload.get("api_key", "")).strip()
    if api_key:
        update_env_file("ANTHROPIC_API_KEY", api_key)

    api["provider"] = selected_provider
    if selected_provider in PROVIDER_DEFAULTS:
        active = dict(PROVIDER_DEFAULTS[selected_provider])
        if isinstance(stored.get(selected_provider), dict):
            active.update(stored[selected_provider])
        for key in ["base_url", "model", "api_key_env", "temperature", "max_tokens", "timeout_seconds"]:
            api[key] = active.get(key, api.get(key, ""))
    elif selected_provider in {"codex", "codex_cli", "codex-cli"}:
        api["model"] = codex.get("model") or "gpt-5.4"
    elif selected_provider in {"claude", "claude_cli", "claude-cli"}:
        api["model"] = claude.get("model") or "claude-sonnet-4-5"

    # ---- Vision provider settings ----
    vision_payload = payload.get("vision", {}) or {}
    if vision_payload:
        vision_cfg = settings.setdefault("vision", {})
        if "provider" in vision_payload:
            v = str(vision_payload["provider"]).strip().lower()
            if v in {"qwen_vl", "openai_vision", "claude_cli", "claude"}:
                vision_cfg["provider"] = v
        for sub in ("qwen_vl", "openai_vision"):
            sub_payload = vision_payload.get(sub, {}) or {}
            if not sub_payload:
                continue
            sub_cfg = vision_cfg.setdefault(sub, {})
            for k in ["base_url", "model", "api_key_env"]:
                if k in sub_payload:
                    sub_cfg[k] = str(sub_payload[k]).strip()
            if "timeout_seconds" in sub_payload and str(sub_payload["timeout_seconds"]).strip():
                sub_cfg["timeout_seconds"] = int(float(sub_payload["timeout_seconds"]))
            # Write API key through to .env
            api_key = str(sub_payload.get("api_key", "")).strip()
            env_name = str(sub_cfg.get("api_key_env", "")).strip()
            if api_key and env_name:
                update_env_file(env_name, api_key)

    # ---- OCR settings ----
    ocr_payload = payload.get("ocr", {}) or {}
    if ocr_payload:
        ocr = settings.setdefault("ocr", {})
        if "enabled" in ocr_payload:
            ocr["enabled"] = bool(ocr_payload["enabled"])
        if "engine" in ocr_payload:
            engine = str(ocr_payload["engine"]).strip().lower()
            if engine in {"rapidocr", "easyocr", "cloud", "none"}:
                ocr["engine"] = engine
        if "trigger_threshold" in ocr_payload and str(ocr_payload["trigger_threshold"]).strip():
            ocr["trigger_threshold"] = int(float(ocr_payload["trigger_threshold"]))
        if "max_pages" in ocr_payload and str(ocr_payload["max_pages"]).strip():
            ocr["max_pages"] = int(float(ocr_payload["max_pages"]))
        cloud_payload = ocr_payload.get("cloud", {}) or {}
        if cloud_payload:
            cloud = ocr.setdefault("cloud", {})
            for k in ["base_url", "model", "api_key_env"]:
                if k in cloud_payload:
                    cloud[k] = str(cloud_payload[k]).strip()
            if "timeout_seconds" in cloud_payload and str(cloud_payload["timeout_seconds"]).strip():
                cloud["timeout_seconds"] = int(float(cloud_payload["timeout_seconds"]))
            # API key write-through to .env
            api_key = str(cloud_payload.get("api_key", "")).strip()
            env_name = str(cloud.get("api_key_env", "")).strip()
            if api_key and env_name:
                update_env_file(env_name, api_key)

    save_settings_yaml(settings)
    return settings


def settings_payload() -> dict[str, Any]:
    settings = load_settings()
    api = settings.get("api", {})
    env_name = api.get("api_key_env", "")
    provider_settings = provider_settings_for(settings)
    provider_payload: dict[str, dict[str, Any]] = {}
    for provider, item in provider_settings.items():
        env = str(item.get("api_key_env", ""))
        provider_payload[provider] = {
            "base_url": item.get("base_url", ""),
            "model": item.get("model", ""),
            "api_key_env": env,
            "has_api_key": bool(os.environ.get(env, "")),
            "temperature": item.get("temperature", 0.2),
            "max_tokens": item.get("max_tokens", 3500),
            "timeout_seconds": item.get("timeout_seconds", 120),
        }
    codex_cli = dict(settings.get("codex_cli", {}))
    codex_cli["model"] = codex_cli.get("model") or "gpt-5.4"
    claude_cli = dict(settings.get("claude_cli", {}))
    claude_cli["model"] = claude_cli.get("model") or "claude-sonnet-4-5"
    claude_cli["has_api_key"] = bool(os.environ.get("ANTHROPIC_API_KEY", ""))
    ocr_cfg = dict(settings.get("ocr", {}))
    ocr_cfg.setdefault("enabled", True)
    ocr_cfg.setdefault("engine", "rapidocr")
    ocr_cfg.setdefault("trigger_threshold", 500)
    ocr_cfg.setdefault("max_pages", 30)
    cloud = dict(ocr_cfg.get("cloud", {}))
    cloud_env = str(cloud.get("api_key_env", ""))
    cloud["has_api_key"] = bool(os.environ.get(cloud_env, "")) if cloud_env else False
    ocr_cfg["cloud"] = cloud
    # Probe whether the user actually has the chosen engine installed —
    # gives the UI a useful "未安装，请 pip install rapidocr-onnxruntime" hint.
    ocr_cfg["available"] = _probe_ocr_engines()

    # Vision provider — build payload with has_api_key flags for each sub-cfg
    vision_raw = settings.get("vision", {}) or {}
    vision_cfg: dict[str, Any] = {
        "provider": str(vision_raw.get("provider", "qwen_vl")).strip().lower() or "qwen_vl",
    }
    for sub_name, defaults in [
        ("qwen_vl", {
            "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "model": "qwen-vl-plus",
            "api_key_env": "QWEN_API_KEY",
            "timeout_seconds": 90,
        }),
        ("openai_vision", {
            "base_url": "https://api.openai.com/v1",
            "model": "gpt-4o-mini",
            "api_key_env": "OPENAI_API_KEY",
            "timeout_seconds": 90,
        }),
    ]:
        sub = dict(defaults)
        sub.update(vision_raw.get(sub_name, {}) or {})
        env_name_v = str(sub.get("api_key_env", ""))
        sub["has_api_key"] = bool(os.environ.get(env_name_v, "")) if env_name_v else False
        vision_cfg[sub_name] = sub
    # claude_cli reuses top-level config; just surface it for completeness
    vision_cfg["claude_cli"] = {
        "model": claude_cli.get("model", "claude-sonnet-4-5"),
        "has_api_key": claude_cli.get("has_api_key", False),
    }

    return {
        "ok": True,
        "api": {
            "provider": api.get("provider", ""),
            "base_url": api.get("base_url", ""),
            "model": api.get("model", ""),
            "api_key_env": env_name,
            "has_api_key": bool(os.environ.get(env_name, "")),
            "temperature": api.get("temperature", 0.2),
            "max_tokens": api.get("max_tokens", 3500),
            "timeout_seconds": api.get("timeout_seconds", 120),
        },
        "provider_settings": provider_payload,
        "codex_cli": codex_cli,
        "claude_cli": claude_cli,
        "ocr": ocr_cfg,
        "vision": vision_cfg,
    }


def onboarding_payload() -> dict[str, Any]:
    """Return first-run setup status for the browser onboarding wizard."""
    settings = load_settings()
    status = dict(settings.get("onboarding", {}) or {})
    payload = settings_payload()
    provider = str(payload.get("api", {}).get("provider", "")).strip().lower()
    main_ready = bool(payload.get("api", {}).get("has_api_key"))
    if provider in {"codex", "codex_cli", "codex-cli"}:
        main_ready = True
    if provider in {"claude", "claude_cli", "claude-cli"}:
        main_ready = True

    translation = translation_settings(settings)
    ollama_cfg = translation.get("ollama", {}) or {}
    ollama_base_url = str(ollama_cfg.get("base_url") or "http://127.0.0.1:11434")
    ollama = _quick_ollama_status(ollama_base_url)

    return {
        "ok": True,
        "completed": bool(status.get("completed", False)),
        "completed_at": status.get("completed_at", ""),
        "main_ready": main_ready,
        "active_provider": provider,
        "translation_provider": translation.get("provider", "ollama"),
        "ollama": ollama,
    }


def save_onboarding_payload(payload: dict[str, Any]) -> dict[str, Any]:
    settings = load_settings()
    onboarding = settings.setdefault("onboarding", {})
    onboarding["completed"] = bool(payload.get("completed", True))
    onboarding["completed_at"] = datetime.now().isoformat(timespec="seconds")
    save_settings_yaml(settings)
    return onboarding


def _quick_ollama_status(base_url: str) -> dict[str, Any]:
    """Short Ollama probe for first-run UI; never block app load for long."""
    import requests
    url = (base_url or "http://127.0.0.1:11434").rstrip("/") + "/api/tags"
    try:
        resp = requests.get(url, timeout=0.8)
        if resp.status_code >= 400:
            return {
                "running": False,
                "base_url": base_url,
                "models": [],
                "error": f"HTTP {resp.status_code}",
            }
        data = resp.json()
        models = []
        for item in data.get("models", []) or []:
            name = item.get("name") or item.get("model") or ""
            if name:
                models.append(name)
        return {"running": True, "base_url": base_url, "models": models[:20], "error": ""}
    except Exception as exc:
        return {
            "running": False,
            "base_url": base_url,
            "models": [],
            "error": str(exc)[:180],
        }


def _probe_ocr_engines() -> dict[str, bool]:
    """Cheap import probe so the UI can tell users which engines are usable."""
    import importlib.util
    return {
        "rapidocr": importlib.util.find_spec("rapidocr_onnxruntime") is not None,
        "easyocr": importlib.util.find_spec("easyocr") is not None,
        "cloud": True,  # cloud is always "available" — just needs a base_url
    }


def call_chat_ai(
    row: dict[str, str],
    question: str,
    note_text: str,
    pdf_text: str,
    image_pages: list[dict[str, Any]] | None = None,
    page_spec: str = "",
    history: list[dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    settings = load_settings()
    # When the user attaches PDF page images, route through the configured
    # vision provider — the main provider (typically DeepSeek) may be text-only.
    # Text-only calls bypass this and go through the main provider as before.
    if image_pages:
        return call_vision_ai(
            row, question, note_text, pdf_text, settings,
            image_pages, page_spec, history or [],
        )
    provider = str(settings.get("api", {}).get("provider", "")).strip().lower()
    if provider in {"codex", "codex_cli", "codex-cli"}:
        return call_codex_cli(
            row, question, note_text, pdf_text, settings,
            [], page_spec, history or [],
        )
    if provider in {"claude", "claude_cli", "claude-cli"}:
        return call_claude_cli(
            row, question, note_text, pdf_text, settings,
            [], page_spec, history or [],
        )
    return call_openai_compatible(
        row, question, note_text, pdf_text, settings,
        [], page_spec, history or [],
    )


def call_vision_ai(
    row: dict[str, str],
    question: str,
    note_text: str,
    pdf_text: str,
    settings: dict[str, Any],
    image_pages: list[dict[str, Any]],
    page_spec: str,
    history: list[dict[str, Any]],
) -> tuple[str, dict[str, Any]]:
    """Route an image-bearing chat call through the configured vision provider.

    The main text-only provider (DeepSeek etc.) can't handle images, so we
    swap settings.api with the chosen vision provider's config and dispatch
    to the existing implementations. `settings.vision.provider` picks which
    sub-provider handles it; users configure all three in 设置→视觉模型.
    """
    vision = settings.get("vision", {}) or {}
    sub_provider = str(vision.get("provider", "qwen_vl")).strip().lower()

    if sub_provider in {"claude", "claude_cli", "claude-cli"}:
        # Claude Code CLI handles images via `--image path` arg. The existing
        # call_claude_cli already accepts image_pages; pass through.
        return call_claude_cli(
            row, question, note_text, pdf_text, settings,
            image_pages, page_spec, history,
        )

    # qwen_vl / openai_vision: both speak OpenAI chat-completions schema and
    # accept image_url content parts. Build an overridden settings dict where
    # api block is swapped to the vision sub-provider, then route through
    # the existing call_openai_compatible.
    if sub_provider not in {"qwen_vl", "openai_vision"}:
        # Unknown provider — fall back to qwen_vl
        sub_provider = "qwen_vl"
    cfg = vision.get(sub_provider, {}) or {}
    base_url = str(cfg.get("base_url", "")).strip()
    model = str(cfg.get("model", "")).strip()
    api_key_env = str(cfg.get("api_key_env", "")).strip()
    if not base_url or not model:
        raise RuntimeError(
            f"视觉 provider「{sub_provider}」未配置 base_url 或 model。"
            "请到 设置 → 视觉模型 里填好再试。"
        )
    if api_key_env and not os.environ.get(api_key_env, ""):
        raise RuntimeError(
            f"视觉 provider「{sub_provider}」缺少 API key（环境变量 {api_key_env} 为空）。"
            "请到 设置 → 视觉模型 里填好 API key（会写入 .env）。"
        )
    override = dict(settings)
    override["api"] = {
        **settings.get("api", {}),
        "provider": "openai_compatible",  # bypass the deepseek-blocks-images guard
        "base_url": base_url,
        "model": model,
        "api_key_env": api_key_env,
        "timeout_seconds": int(cfg.get("timeout_seconds", 90)),
    }
    answer, usage = call_openai_compatible(
        row, question, note_text, pdf_text, override,
        image_pages, page_spec, history,
    )
    # Tag usage so frontend can show which vision provider handled it
    if isinstance(usage, dict):
        usage = dict(usage)
        usage["_vision_provider"] = sub_provider
        usage["_vision_model"] = model
    return answer, usage


def strip_think_blocks(text: str) -> str:
    return re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()


_TRANSLATE_SYSTEM = "你是严谨的学术翻译助手，只输出中文译文。"
_TRANSLATE_USER_TEMPLATE = (
    "请把下面选中的英文学术文本翻译成自然、准确的中文。"
    "要求：保留专有名词、模型名、缩写和引用编号；不要扩写；不要点评；"
    "如果原文不完整，按原文片段翻译。\n\n"
    "英文：\n{text}"
)


def translation_settings(settings: dict[str, Any]) -> dict[str, Any]:
    """Return the active translation provider config with sensible defaults.

    Also migrates the legacy flat layout (where `translation.base_url` /
    `translation.model` / `translation.timeout_seconds` lived directly under
    `translation`) into the new nested `translation.ollama` section.
    """
    translation = dict(settings.get("translation", {}) or {})
    legacy_base = translation.pop("base_url", None)
    legacy_model = translation.pop("model", None)
    legacy_timeout = translation.pop("timeout_seconds", None)
    translation.setdefault("provider", "ollama")
    ollama = dict(translation.get("ollama") or {})
    if legacy_base and not ollama.get("base_url"):
        ollama["base_url"] = legacy_base
    if legacy_model and not ollama.get("model"):
        ollama["model"] = legacy_model
    if legacy_timeout and not ollama.get("timeout_seconds"):
        ollama["timeout_seconds"] = legacy_timeout
    ollama.setdefault("base_url", "http://127.0.0.1:11434")
    ollama.setdefault("model", "qwen3:14b")
    ollama.setdefault("timeout_seconds", 120)
    translation["ollama"] = ollama
    compat = dict(translation.get("openai_compatible") or {})
    compat.setdefault("base_url", "")
    compat.setdefault("model", "")
    compat.setdefault("api_key_env", "OPENAI_API_KEY")
    compat.setdefault("timeout_seconds", 60)
    translation["openai_compatible"] = compat
    return translation


def call_ollama_translate(text: str, settings: dict[str, Any]) -> dict[str, Any]:
    import requests

    translation = translation_settings(settings)
    cfg = translation.get("ollama", {}) or {}
    base_url = str(cfg.get("base_url") or "http://127.0.0.1:11434").rstrip("/")
    model = str(cfg.get("model") or "qwen3:14b")
    timeout = int(cfg.get("timeout_seconds") or 120)
    prompt = "/no_think\n" + _TRANSLATE_USER_TEMPLATE.format(text=text.strip())
    response = requests.post(
        f"{base_url}/api/chat",
        json={
            "model": model,
            "stream": False,
            "messages": [
                {"role": "system", "content": _TRANSLATE_SYSTEM},
                {"role": "user", "content": prompt},
            ],
            "options": {"temperature": 0.1},
        },
        timeout=timeout,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"Ollama 请求失败：{response.status_code} {response.text[:500]}")
    data = response.json()
    content = data.get("message", {}).get("content") or data.get("response") or ""
    return {
        "translation": strip_think_blocks(str(content)),
        "model": model,
        "provider": "ollama",
    }


def call_openai_translate(text: str, settings: dict[str, Any]) -> dict[str, Any]:
    """Translate via an OpenAI-compatible chat completions endpoint.

    Works with DeepSeek, Qwen, OpenAI itself, Ollama's OpenAI-compatible proxy,
    or any endpoint that speaks `/v1/chat/completions`.
    """
    import requests

    translation = translation_settings(settings)
    cfg = translation.get("openai_compatible", {}) or {}
    base_url = str(cfg.get("base_url") or "").rstrip("/")
    if not base_url:
        raise RuntimeError("翻译 - OpenAI 兼容接口未配置 base_url")
    model = str(cfg.get("model") or "").strip()
    if not model:
        raise RuntimeError("翻译 - OpenAI 兼容接口未配置 model")
    api_key_env = str(cfg.get("api_key_env") or "OPENAI_API_KEY")
    api_key = os.environ.get(api_key_env, "")
    timeout = int(cfg.get("timeout_seconds") or 60)
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = {
        "model": model,
        "stream": False,
        "temperature": 0.1,
        "messages": [
            {"role": "system", "content": _TRANSLATE_SYSTEM},
            {"role": "user", "content": _TRANSLATE_USER_TEMPLATE.format(text=text.strip())},
        ],
    }
    response = requests.post(
        f"{base_url}/chat/completions",
        headers=headers,
        json=body,
        timeout=timeout,
    )
    if response.status_code >= 400:
        raise RuntimeError(f"翻译接口请求失败：{response.status_code} {response.text[:500]}")
    data = response.json()
    content = data["choices"][0]["message"]["content"]
    return {
        "translation": strip_think_blocks(str(content)),
        "model": model,
        "provider": "openai_compatible",
    }


def dispatch_translate(text: str, settings: dict[str, Any]) -> dict[str, Any]:
    translation = translation_settings(settings)
    provider = str(translation.get("provider") or "ollama").lower()
    if provider == "ollama":
        return call_ollama_translate(text, settings)
    if provider in {"openai", "openai_compatible", "deepseek", "qwen", "compatible"}:
        return call_openai_translate(text, settings)
    raise RuntimeError(f"未知的翻译 provider：{provider}")


def call_openai_compatible(
    row: dict[str, str],
    question: str,
    note_text: str,
    pdf_text: str,
    settings: dict[str, Any],
    image_pages: list[dict[str, Any]] | None = None,
    page_spec: str = "",
    history: list[dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    import requests

    api = settings["api"]
    provider = str(api.get("provider", "")).strip().lower()
    key = os.environ.get(api["api_key_env"], "")
    if not key:
        raise RuntimeError(f"缺少 API key：{api['api_key_env']}")
    image_pages = image_pages or []
    history = history or []
    if image_pages and provider == "deepseek":
        raise RuntimeError("DeepSeek 官方 Chat API 目前只接受文本消息，不能直接传 PDF 页面图片。请切换到 Codex CLI，或在 Qwen/兼容接口里配置支持视觉的模型。")

    # Cap the PDF text at the full-paper limit (default 120000 chars ≈ a whole
    # academic paper). The old 24000 cap silently cut off everything past the
    # first ~8 pages, so the model couldn't answer about the rest of the paper.
    _pdf_cap = int(settings.get("pdf", {}).get("max_full_chars", 120000))
    pdf_text = pdf_text[:_pdf_cap]
    note_text = note_text[:14000]
    # Paper context lives in the system prompt — that way previous turns
    # (saved as plain Q/A pairs without context) don't redundantly carry it.
    # Minimal prompt: one-line instruction + PDF text only. Index metadata and
    # the Markdown note are deliberately excluded — the PDF carries the content,
    # and the extras just made answers longer. Multi-turn history is carried
    # separately as chat messages (to_openai_messages), not in this system text.
    system = (
        "你是中文学术阅读助手。基于下面这篇论文的提取文本回答用户的问题，"
        "简洁直接、只说重点；信息不足就直说不知道。"
        "除非用户明确要求「详细」「列要点」，否则别长篇大论、别分多级标题罗列。\n\n"
        f"【论文提取文本】\n{pdf_text}"
    )
    user_text = question
    if image_pages:
        page_list = "，".join(str(item["page"]) for item in image_pages)
        user_text += (
            f"\n\n（我还附上了 PDF 指定页的页面图片，页码为：{page_list}。"
            "请优先阅读这些页面图片，不要假设未提供页面中的内容。）"
        )

    # Build messages: system → trimmed history → new user turn
    history_msgs = chat_history_module.to_openai_messages(history)
    user_content: str | list[dict[str, Any]]
    if image_pages:
        user_content = [{"type": "text", "text": user_text}]
        for item in image_pages:
            user_content.append({"type": "image_url", "image_url": {"url": item["data_url"]}})
    else:
        user_content = user_text
    messages: list[dict[str, Any]] = [{"role": "system", "content": system}]
    messages.extend(history_msgs)
    messages.append({"role": "user", "content": user_content})

    endpoint = api["base_url"].rstrip("/") + "/chat/completions"
    payload: dict[str, Any] = {
        "model": api["model"],
        "messages": messages,
        "temperature": 0.2,
        "max_tokens": min(int(api.get("max_tokens", 3500)), 2600),
    }
    if api.get("thinking"):
        payload["thinking"] = api["thinking"]

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    attempts = [payload, {k: v for k, v in payload.items() if k != "thinking"}]
    last_error = ""
    for item in attempts:
        response = requests.post(
            endpoint,
            headers=headers,
            json=item,
            timeout=int(api.get("timeout_seconds", 120)),
        )
        if response.status_code >= 400:
            last_error = f"{response.status_code}: {response.text[:500]}"
            continue
        data = response.json()
        answer = data["choices"][0]["message"]["content"].strip()
        return answer, data.get("usage", {})
    raise RuntimeError(last_error or "AI 请求失败")


def call_codex_cli(
    row: dict[str, str],
    question: str,
    note_text: str,
    pdf_text: str,
    settings: dict[str, Any],
    image_pages: list[dict[str, Any]] | None = None,
    page_spec: str = "",
    history: list[dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    codex = settings.get("codex_cli", {})
    command = codex.get("command") or _default_codex_command()
    sandbox = codex.get("sandbox") or "read-only"
    timeout = int(codex.get("timeout_seconds", 180))
    model = str(codex.get("model") or "gpt-5.4").strip()
    image_pages = image_pages or []
    history = history or []
    # Cap the PDF text at the full-paper limit (default 120000 chars ≈ a whole
    # academic paper). The old 24000 cap silently cut off everything past the
    # first ~8 pages, so the model couldn't answer about the rest of the paper.
    _pdf_cap = int(settings.get("pdf", {}).get("max_full_chars", 120000))
    pdf_text = pdf_text[:_pdf_cap]
    note_text = note_text[:14000]
    page_instruction = ""
    if image_pages:
        page_list = "，".join(str(item["page"]) for item in image_pages)
        page_instruction = (
            f"\n\n我还通过 --image 附上了 PDF 页面图片，页码为：{page_list}。"
            "请优先阅读这些页面图片，只基于已提供页面和文本缓存回答。"
        )
    history_prefix = chat_history_module.to_text_prefix(history)
    # Minimal prompt by design: one-line instruction + PDF text + the question
    # (plus prior turns only when multi-turn is on). The paper's index metadata
    # and the user's Markdown note are deliberately NOT included — the PDF text
    # already carries the content, and extra context just bloated answers.
    prompt = (
        "你是中文学术阅读助手。基于下面这篇论文的提取文本回答我的问题，"
        "简洁直接、只说重点；信息不足就直说不知道。"
        "除非我明确要求「详细」「列要点」，否则别长篇大论、别分多级标题罗列。\n\n"
        f"【论文提取文本】\n{pdf_text}\n\n"
        f"{history_prefix}"
        f"我的问题：{question}{page_instruction}\n"
    )
    with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False, suffix=".txt") as out:
        output_path = Path(out.name)
    cmd = [
        command,
        "exec",
        "-C",
        str(ROOT),
        "--skip-git-repo-check",
        "--sandbox",
        sandbox,
        "--ephemeral",
        "--output-last-message",
        str(output_path),
    ]
    for item in image_pages:
        cmd.extend(["-i", str(item["path"])])
    if model:
        cmd.extend(["-m", model])
    cmd.append("-")
    result = subprocess.run(
        cmd,
        input=prompt,
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
        **subprocess_hidden_kwargs(),
    )
    answer = output_path.read_text(encoding="utf-8").strip() if output_path.exists() else ""
    output_path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Codex CLI 调用失败")[-2000:])
    if not answer:
        answer = (result.stdout or "").strip()
    usage = {"provider": "codex_cli", "returncode": result.returncode}
    if image_pages:
        usage["image_pages"] = ",".join(str(item["page"]) for item in image_pages)
    return answer, usage


def call_claude_cli(
    row: dict[str, str],
    question: str,
    note_text: str,
    pdf_text: str,
    settings: dict[str, Any],
    image_pages: list[dict[str, Any]] | None = None,
    page_spec: str = "",
    history: list[dict[str, Any]] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Invoke the Claude Code CLI in non-interactive (`-p`) mode.

    Auth: user must have run `claude` interactively once to log in (OAuth
    cached to the user profile), OR have ANTHROPIC_API_KEY set in env.
    No special arg is needed here — the CLI handles auth itself.
    """
    cfg = settings.get("claude_cli", {}) or {}
    command = cfg.get("command") or _default_claude_command()
    timeout = int(cfg.get("timeout_seconds", 180))
    model = str(cfg.get("model") or "claude-sonnet-4-5").strip()
    image_pages = image_pages or []
    history = history or []
    # Cap the PDF text at the full-paper limit (default 120000 chars ≈ a whole
    # academic paper). The old 24000 cap silently cut off everything past the
    # first ~8 pages, so the model couldn't answer about the rest of the paper.
    _pdf_cap = int(settings.get("pdf", {}).get("max_full_chars", 120000))
    pdf_text = pdf_text[:_pdf_cap]
    note_text = note_text[:14000]
    page_instruction = ""
    if image_pages:
        page_list = "，".join(str(item["page"]) for item in image_pages)
        page_instruction = (
            f"\n\n（注：另有 PDF 页面图片附件 {page_list} — Claude CLI 当前以文本模式调用，"
            "图片无法直接读取。如需视觉理解，请改用 OpenAI 兼容接口配视觉模型。）"
        )
    history_prefix = chat_history_module.to_text_prefix(history)
    # Minimal prompt by design: one-line instruction + PDF text + the question
    # (plus prior turns only when multi-turn is on). The paper's index metadata
    # and the user's Markdown note are deliberately NOT included — the PDF text
    # already carries the content, and extra context just bloated answers.
    prompt = (
        "你是中文学术阅读助手。基于下面这篇论文的提取文本回答我的问题，"
        "简洁直接、只说重点；信息不足就直说不知道。"
        "除非我明确要求「详细」「列要点」，否则别长篇大论、别分多级标题罗列。\n\n"
        f"【论文提取文本】\n{pdf_text}\n\n"
        f"{history_prefix}"
        f"我的问题：{question}{page_instruction}\n"
    )
    # Pass the prompt via STDIN — it embeds the full PDF text and would blow
    # past the Windows 32767-char command-line limit if passed as a `-p` arg.
    cmd = [command, "-p", "--output-format", "text"]
    if model:
        cmd.extend(["--model", model])
    try:
        result = subprocess.run(
            cmd,
            input=prompt,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
            encoding="utf-8",
            errors="replace",
            **subprocess_hidden_kwargs(),
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            f"未找到 Claude CLI 可执行文件 `{command}`。请检查：\n"
            f"1) 已安装 Claude Code (https://claude.com/download)\n"
            f"2) 在设置→主模型→Claude CLI 里填写正确的绝对路径\n"
            f"   Mac/Linux 用 `which claude` 查；Windows 用 `where claude` 查\n"
            f"原始错误：{exc}"
        )
    except OSError as exc:
        raise RuntimeError(f"Claude CLI 启动失败：{exc}")
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        low = err.lower()
        if "not logged in" in low or "authentication" in low or "unauthorized" in low:
            raise RuntimeError(
                "Claude CLI 未登录。请在终端跑一次 `claude login` 走 OAuth，"
                "或在 .env 里配置 ANTHROPIC_API_KEY 然后重启工作台。\n"
                f"原始错误：{err[-1500:]}"
            )
        if "model" in low and ("not found" in low or "invalid" in low or "unknown" in low):
            raise RuntimeError(
                f"Claude CLI 拒绝模型名「{model}」。请在 设置→主模型→Claude CLI 改成"
                "有效模型，例如 claude-sonnet-4-5 / claude-opus-4-1 / claude-haiku-4-5。\n"
                f"原始错误：{err[-1000:]}"
            )
        raise RuntimeError((err or "Claude CLI 调用失败")[-2000:])
    answer = (result.stdout or "").strip()
    if not answer:
        raise RuntimeError(
            "Claude CLI 返回空结果。常见原因：模型名无效 / 未登录 / 额度用尽。"
            "stderr：" + (result.stderr or "")[-500:]
        )
    return answer, {"provider": "claude_cli", "model": model, "returncode": result.returncode}


def append_ai_answer(note_path: Path, question: str, answer: str) -> str:
    note = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
    block = (
        "\n\n# AI 问答记录\n\n"
        if "# AI 问答记录" not in note
        else "\n\n"
    )
    block += f"## {now_text()} - {question}\n\n{answer.strip()}\n"
    note = note.rstrip() + block
    atomic_write_text(note_path, note)
    return note


def append_custom_note(note_path: Path, title: str, content: str) -> str:
    note = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
    heading = title.strip() or "补充笔记"
    block = f"\n\n# {heading}\n\n{content.strip()}\n"
    note = note.rstrip() + block
    atomic_write_text(note_path, note)
    return note


def append_english_excerpt(row: dict[str, str], content: str) -> Path:
    ENGLISH_EXCERPTS_PATH.parent.mkdir(parents=True, exist_ok=True)
    if ENGLISH_EXCERPTS_PATH.exists():
        text = ENGLISH_EXCERPTS_PATH.read_text(encoding="utf-8")
    else:
        text = "# English Excerpts\n\n"
    title = row.get("英文标题") or row.get("标题") or row.get("paper_id") or "Untitled"
    meta = "；".join(
        part
        for part in [
            row.get("作者", ""),
            row.get("年份", ""),
            row.get("期刊会议", ""),
            row.get("DOI", ""),
        ]
        if part
    )
    block = f"\n\n## {now_text()} | {title}\n\n"
    if row.get("paper_id"):
        block += f"- Paper ID: {row['paper_id']}\n"
    if meta:
        block += f"- Source: {meta}\n"
    if row.get("PDF路径"):
        block += f"- PDF: {row['PDF路径']}\n"
    block += f"\n{content.strip()}\n"
    atomic_write_text(ENGLISH_EXCERPTS_PATH, text.rstrip() + block)
    return ENGLISH_EXCERPTS_PATH


def remove_english_excerpt_entries(row: dict[str, str]) -> bool:
    if not ENGLISH_EXCERPTS_PATH.exists():
        return False
    text = ENGLISH_EXCERPTS_PATH.read_text(encoding="utf-8")
    blocks = re.split(r"(?=\n## )", text)
    paper_id = row.get("paper_id", "")
    pdf_path = row.get("PDF路径", "")
    changed = False
    kept: list[str] = []
    for block in blocks:
        if block.startswith("\n## ") and ((paper_id and paper_id in block) or (pdf_path and pdf_path in block)):
            changed = True
            continue
        kept.append(block)
    if changed:
        atomic_write_text(ENGLISH_EXCERPTS_PATH, "".join(kept).rstrip() + "\n")
    return changed


class LiteratureHandler(BaseHTTPRequestHandler):
    server_version = "LiteratureHub/0.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{now_text()}] {self.address_string()} {fmt % args}")

    def _send_no_cache_headers(self) -> None:
        """Tell the browser to never cache. The whole workbench is a local
        dev environment where files change constantly — caching causes
        confusion ("I edited app.js but the page still shows old behavior")."""
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")

    def send_json(self, data: Any, status: int = 200) -> None:
        body = json_bytes(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_no_cache_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, message: str, status: int = 400) -> None:
        self.send_json({"ok": False, "error": message}, status)

    def do_GET(self) -> None:
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            query = parse_qs(parsed.query)
            if path == "/":
                return self.serve_static(WEB_DIR / "index.html")
            if path.startswith("/web/"):
                return self.serve_static(WEB_DIR / path.removeprefix("/web/"))
            if path == "/file":
                target = safe_root_path(query.get("path", [""])[0])
                return self.serve_file(target)
            if path == "/api/papers":
                return self.api_papers(query)
            if path == "/api/paper":
                return self.api_paper(query)
            if path == "/api/note":
                return self.api_note(query)
            if path == "/api/pdf-text":
                return self.api_pdf_text(query)
            if path == "/api/categories":
                rows = load_rows()
                return self.send_json({"ok": True, "categories": categories_from_rows(rows)})
            if path == "/api/category-tree":
                return self.send_json(category_tree_payload())
            if path == "/api/coauth-graph":
                return self.api_coauth_graph(query)
            if path == "/api/config":
                settings = load_settings()
                provider = settings["api"]["provider"]
                model = settings["api"]["model"]
                if provider in {"codex", "codex_cli", "codex-cli"}:
                    model = settings.get("codex_cli", {}).get("model") or "gpt-5.4"
                elif provider in {"claude", "claude_cli", "claude-cli"}:
                    model = settings.get("claude_cli", {}).get("model") or "claude-sonnet-4-5"
                return self.send_json(
                    {
                        "ok": True,
                        "model": model,
                        "provider": provider,
                        "count": len(load_rows()),
                    }
                )
            if path == "/api/settings":
                return self.send_json(settings_payload())
            if path == "/api/onboarding":
                return self.send_json(onboarding_payload())
            if path == "/api/prompts":
                return self.api_prompts()
            if path == "/api/tracking-journals":
                return self.api_tracking_journals()
            if path == "/api/organize/status":
                return self.api_organize_status(query)
            if path == "/api/annotations":
                return self.api_list_annotations(query)
            if path == "/api/translation-settings":
                return self.api_translation_settings()
            if path == "/api/easyscholar/settings":
                return self.api_easyscholar_settings()
            if path == "/api/heartbeat":
                heartbeat_now()
                # Piggyback any latched background-rebuild error so the
                # frontend can toast it without a separate poll.
                return self.send_json({
                    "ok": True,
                    "ts": time.time(),
                    "rebuild_error": dict(_LAST_REBUILD_ERROR) if _LAST_REBUILD_ERROR["ts"] else None,
                })
            if path == "/api/citations":
                return self.api_list_citations()
            if path == "/api/citation":
                return self.api_get_citation(query)
            if path == "/api/chat-history":
                return self.api_chat_history(query)
            if path == "/api/ui-settings":
                return self.api_get_ui_settings()
            if path == "/api/excerpts/list":
                return self.api_excerpts_list(query)
            if path == "/api/excerpts/stats":
                return self.api_excerpts_stats(query)
            if path == "/api/stickies/all":
                return self.api_stickies_all()
            if path == "/api/stickies/stats":
                return self.api_stickies_stats(query)
            if path == "/api/llm/ping":
                return self.api_llm_ping()
            return self.send_error_json("not found", HTTPStatus.NOT_FOUND)
        except Exception as exc:
            traceback.print_exc()
            return self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:
        try:
            parsed = urlparse(self.path)
            if parsed.path == "/api/note":
                return self.api_save_note()
            if parsed.path == "/api/note/append":
                return self.api_append_note()
            if parsed.path == "/api/paper":
                return self.api_save_paper()
            if parsed.path == "/api/paper/delete":
                return self.api_delete_paper()
            if parsed.path == "/api/paper/reprocess":
                return self.api_reprocess_paper()
            if parsed.path == "/api/paper/help-read":
                return self.api_help_read_paper()
            if parsed.path == "/api/paper/gen-summary":
                return self.api_gen_summary()
            if parsed.path == "/api/citation":
                return self.api_create_citation()
            if parsed.path == "/api/citation/save":
                return self.api_save_citation()
            if parsed.path == "/api/citation/delete":
                return self.api_delete_citation()
            if parsed.path == "/api/citation/help-cite":
                return self.api_help_cite()
            if parsed.path == "/api/chat-history/clear":
                return self.api_chat_history_clear()
            if parsed.path == "/api/ui-settings":
                return self.api_save_ui_settings()
            if parsed.path == "/api/settings":
                return self.api_save_settings()
            if parsed.path == "/api/onboarding":
                return self.api_save_onboarding()
            if parsed.path == "/api/prompts":
                return self.api_save_prompts()
            if parsed.path == "/api/tracking-journals":
                return self.api_save_tracking_journals()
            if parsed.path == "/api/category-tree":
                return self.api_save_category_tree()
            if parsed.path == "/api/category-tree/rename-primary":
                return self.api_rename_primary_category()
            if parsed.path == "/api/category-tree/rename-secondary":
                return self.api_rename_secondary_category()
            if parsed.path == "/api/category-tree/rename-tertiary":
                return self.api_rename_tertiary_category()
            if parsed.path == "/api/ask":
                return self.api_ask()
            if parsed.path == "/api/ask-multi":
                return self.api_ask_multi()
            if parsed.path == "/api/excerpt":
                return self.api_excerpt()
            if parsed.path == "/api/scan-status/refresh":
                return self.api_refresh_scan_status()
            if parsed.path == "/api/translate":
                return self.api_translate()
            if parsed.path == "/api/organize":
                return self.api_organize()
            if parsed.path == "/api/annotations":
                return self.api_create_annotation()
            if parsed.path == "/api/annotations/update":
                return self.api_update_annotation()
            if parsed.path == "/api/annotations/delete":
                return self.api_delete_annotation()
            if parsed.path == "/api/translation-settings":
                return self.api_save_translation_settings()
            if parsed.path == "/api/easyscholar/settings":
                return self.api_save_easyscholar_settings()
            if parsed.path == "/api/easyscholar/refresh":
                return self.api_easyscholar_refresh()
            if parsed.path == "/api/easyscholar/refresh-all":
                return self.api_easyscholar_refresh_all()
            if parsed.path == "/api/export/category":
                return self.api_export_category()
            if parsed.path == "/api/models/detect":
                return self.api_detect_models()
            return self.send_error_json("not found", HTTPStatus.NOT_FOUND)
        except Exception as exc:
            traceback.print_exc()
            return self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def serve_static(self, path: Path) -> None:
        path = path.resolve()
        try:
            path.relative_to(WEB_DIR.resolve())
        except ValueError:
            return self.send_error_json("static path outside web dir", HTTPStatus.FORBIDDEN)
        if not path.exists() or not path.is_file():
            return self.send_error_json("not found", HTTPStatus.NOT_FOUND)
        return self.serve_file(path)

    def serve_file(self, path: Path) -> None:
        if not path.exists() or not path.is_file():
            return self.send_error_json("file not found", HTTPStatus.NOT_FOUND)
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        # Append UTF-8 charset for text formats — otherwise Windows browsers
        # default to GBK and Chinese / mixed-encoding files render as mojibake.
        suffix = path.suffix.lower()
        text_suffixes = {".md", ".txt", ".csv", ".json", ".yaml", ".yml", ".html", ".js", ".mjs", ".css", ".xml", ".log"}
        if suffix in text_suffixes and "charset" not in content_type:
            if not content_type.startswith("text/"):
                if suffix == ".md":
                    content_type = "text/markdown"
                elif suffix == ".csv":
                    content_type = "text/csv"
                elif suffix == ".json":
                    content_type = "application/json"
                elif suffix in {".yaml", ".yml"}:
                    content_type = "text/yaml"
            content_type = f"{content_type}; charset=utf-8"
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        # Frontend assets (.html / .js / .mjs / .css) change frequently during
        # local dev — disable caching so users never need to hard-refresh.
        # PDFs and other large binary assets get a short cache to keep things
        # snappy when scrolling back to a paper.
        if suffix in {".html", ".js", ".mjs", ".css", ".md", ".json", ".yaml", ".yml", ".csv", ".txt"}:
            self._send_no_cache_headers()
        elif suffix == ".pdf":
            self.send_header("Cache-Control", "private, max-age=60")
        self.end_headers()
        self.wfile.write(body)

    def api_papers(self, query: dict[str, list[str]]) -> None:
        rows = [paper_payload(row) for row in load_rows()]
        search = (query.get("search", [""])[0] or "").strip().lower()
        category = (query.get("category", [""])[0] or "").strip()
        category_lower = category.lower()
        status = (query.get("read_status", query.get("status", [""]))[0] or "").strip().lower()
        importance = (query.get("importance", [""])[0] or "").strip().lower()
        sort_by = (query.get("sort_by", [""])[0] or "added").strip()
        sort_order = (query.get("sort_order", [""])[0] or "desc").strip()

        def has_human_category(row: dict[str, str]) -> bool:
            for field in ("一级分类", "二级分类", "人工分类", "最终分类"):
                if (row.get(field) or "").strip():
                    return True
            return False

        def has_ai_category(row: dict[str, str]) -> bool:
            for field in ("一级分类_AI建议", "二级分类_AI建议"):
                value = (row.get(field) or "").strip()
                if value and value not in ("待分类", "待 AI 整理"):
                    return True
            return False

        def matches(row: dict[str, str]) -> bool:
            haystack = " ".join(str(v) for v in row.values())
            # Approximate search: tolerant of stray punctuation / case / spacing
            # (Tier 1) and a missing word or small typo (Tier 2, ≥80% coverage).
            if search and not search_row_matches(search, haystack):
                return False
            if category == "__uncategorized":
                if has_human_category(row) or has_ai_category(row):
                    return False
            elif category == "__only_ai":
                if has_human_category(row) or not has_ai_category(row):
                    return False
            elif category:
                # Exact ；-token match on the category fields — mirrors
                # categories_from_rows so the dropdown count and this filtered
                # list always agree. The old code did `category in haystack`
                # (substring over ALL fields) which (a) over-counted papers
                # that merely mention the name in notes/title, and (b) for
                # short names like "RAG" matched any paper containing that
                # substring anywhere.
                if not row_in_category(row, category):
                    return False
            if status and status != (row.get("阅读状态", "").lower()):
                if not (status == "__blank" and not row.get("阅读状态", "").strip()):
                    return False
            if importance:
                row_importance = row.get("重要性", "").strip().lower()
                if importance == "__blank":
                    if row_importance:
                        return False
                elif importance != row_importance:
                    return False
            return True

        filtered = [row for row in rows if matches(row)]
        filtered = sort_rows_for_view(filtered, sort_by=sort_by, order=sort_order)
        return self.send_json({"ok": True, "papers": filtered, "total": len(rows), "count": len(filtered)})

    def api_paper(self, query: dict[str, list[str]]) -> None:
        paper_id = query.get("paper_id", [""])[0]
        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        return self.send_json({"ok": True, "paper": paper_payload(row)})

    def api_note(self, query: dict[str, list[str]]) -> None:
        paper_id = query.get("paper_id", [""])[0]
        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        path = note_path_for(row)
        content = path.read_text(encoding="utf-8") if path.exists() else ""
        return self.send_json({"ok": True, "content": content, "path": rel(path)})

    def api_pdf_text(self, query: dict[str, list[str]]) -> None:
        paper_id = query.get("paper_id", [""])[0]
        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        text, quality, text_path = cached_or_extract_text(row)
        return self.send_json(
            {
                "ok": True,
                "text": text,
                "quality": quality,
                "text_path": rel(text_path),
            }
        )

    def api_save_note(self) -> None:
        data = read_body(self)
        paper_id = data.get("paper_id", "")
        content = data.get("content", "")
        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        path = note_path_for(row)
        atomic_write_text(path, str(content))
        return self.send_json({"ok": True, "path": rel(path)})

    def api_save_paper(self) -> None:
        data = read_body(self)
        paper_id = data.get("paper_id", "")
        fields = data.get("fields", {})
        allowed = {
            "英文标题",
            "中文标题",
            "期刊会议",
            "期刊分区",
            "SSCI",
            "SCI",
            "UTD",
            "FT50",
            "ABS",
            "扫描件",
            "一级分类",
            "二级分类",
            "三级分类",
            "人工分类",
            "最终分类",
            "重要性",
            "阅读状态",
            "我的备注",
            "期刊等级_人工",
            "AI一句话总结",
            # 注意：期刊等级_自动 不能从前端写入，只能 EasyScholar 后端写
        }
        rows = load_rows()
        row = find_row(paper_id, rows)
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        for key, value in fields.items():
            if key in allowed:
                row[key] = str(value)
        save_rows(rows)
        return self.send_json({"ok": True, "paper": paper_payload(row)})

    def api_list_citations(self) -> None:
        items = citations_module.list_all()
        return self.send_json(
            {"ok": True, "citations": [c.to_payload() for c in items]}
        )

    def api_get_citation(self, query: dict[str, list[str]]) -> None:
        name = query.get("name", [""])[0]
        if not name:
            return self.send_error_json("missing citation name")
        try:
            cf = citations_module.load(name)
        except FileNotFoundError as exc:
            return self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
        payload = cf.to_payload()
        payload.update({"raw": cf.raw, "context": cf.context, "entries_text": cf.entries_text})
        return self.send_json({"ok": True, "citation": payload})

    def api_create_citation(self) -> None:
        data = read_body(self)
        name = str(data.get("name", "")).strip()
        display_name = str(data.get("display_name", "")).strip()
        if not name:
            return self.send_error_json("missing name")
        try:
            cf = citations_module.create(name, display_name or name)
        except ValueError as exc:
            return self.send_error_json(str(exc))
        return self.send_json({"ok": True, "citation": cf.to_payload()})

    def api_save_citation(self) -> None:
        """Persist the full markdown body for an existing citation file
        (used by the in-app Citation 管理 editor)."""
        data = read_body(self)
        name = str(data.get("name", "")).strip()
        raw = str(data.get("raw", ""))
        if not name:
            return self.send_error_json("missing name")
        cf = citations_module.write_raw(name, raw)
        return self.send_json({"ok": True, "citation": cf.to_payload()})

    def api_delete_citation(self) -> None:
        data = read_body(self)
        name = str(data.get("name", "")).strip()
        if not name:
            return self.send_error_json("missing name")
        removed = citations_module.delete(name)
        return self.send_json({"ok": True, "removed": removed})

    def api_help_cite(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        citation_name = str(data.get("citation", "")).strip()
        if not paper_id or not citation_name:
            return self.send_error_json("missing paper_id or citation")
        rows = load_rows()
        row = find_row(paper_id, rows)
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        try:
            cf = citations_module.load(citation_name)
        except FileNotFoundError as exc:
            return self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
        # gather paper context
        note_path = note_path_for(row)
        note_text = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
        text_path = text_cache_path_for(row)
        pdf_text = text_path.read_text(encoding="utf-8") if text_path.exists() else ""
        system_prompt, user_prompt = citations_module.build_help_cite_prompt(
            cf, row, pdf_text, note_text
        )
        # Reuse the chat dispatcher — it picks the configured provider
        # (DeepSeek / Qwen / OpenAI compatible / Codex CLI).
        settings = load_settings()
        provider = str(settings.get("api", {}).get("provider", "")).strip().lower()
        try:
            if provider in {"codex", "codex_cli", "codex-cli"}:
                # Codex CLI doesn't take system messages the same way; concat
                fake_row = {"paper_id": row.get("paper_id", "")}
                answer, usage = call_codex_cli(
                    fake_row,
                    user_prompt,
                    note_text="",
                    pdf_text="",
                    settings=settings,
                )
                answer = answer.strip()
            else:
                # call_openai_compatible expects a slightly different shape;
                # use a direct minimal call for clarity.
                answer = self._call_chat_minimal(system_prompt, user_prompt, settings)
        except Exception as exc:
            return self.send_error_json(f"AI 生成引用失败：{exc}")
        # Append the AI-produced markdown to the citation file
        cf2 = citations_module.append_entry(citation_name, answer)
        return self.send_json(
            {
                "ok": True,
                "entry": answer,
                "citation": cf2.to_payload(),
                "citation_path": str(cf2.path.relative_to(ROOT)).replace("\\", "/"),
            }
        )

    def _call_chat_minimal(self, system: str, user: str, settings: dict[str, Any]) -> str:
        import requests
        api = settings["api"]
        key = os.environ.get(api["api_key_env"], "")
        if not key:
            raise RuntimeError(f"缺少 API key：{api['api_key_env']}")
        endpoint = api["base_url"].rstrip("/") + "/chat/completions"
        payload = {
            "model": api["model"],
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": api.get("temperature", 0.2),
            "max_tokens": int(api.get("max_tokens", 3500)),
        }
        if api.get("thinking"):
            payload["thinking"] = api["thinking"]
        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        attempts = [payload, {k: v for k, v in payload.items() if k != "thinking"}]
        last_err = ""
        for body in attempts:
            r = requests.post(endpoint, headers=headers, json=body, timeout=int(api.get("timeout_seconds", 120)))
            if r.status_code >= 400:
                last_err = f"{r.status_code}: {r.text[:500]}"
                continue
            return r.json()["choices"][0]["message"]["content"].strip()
        raise RuntimeError(last_err or "AI request failed")

    def api_help_read_paper(self) -> None:
        """'帮我阅读'：AI re-reads the PDF and refreshes basic metadata + note +
        one-sentence summary + keywords. Does NOT touch classification fields
        (neither human nor AI suggestion), does NOT pop any popup. The renamed
        and simplified version of api_reprocess_paper.
        """
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        if not paper_id:
            return self.send_error_json("missing paper_id")
        rows = load_rows()
        row = find_row(paper_id, rows)
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        pdf_rel = row.get("PDF路径", "")
        note_rel = row.get("笔记路径", "")
        if not pdf_rel:
            return self.send_error_json("paper has no PDF path")
        pdf_path = safe_root_path(pdf_rel)
        if not pdf_path.exists():
            return self.send_error_json("PDF file missing on disk", HTTPStatus.NOT_FOUND)
        note_path = safe_root_path(note_rel) if note_rel else (
            project_path("library/notes") / f"{paper_id}.md"
        )
        settings = load_settings()
        new_hash = sha256_file(pdf_path)
        try:
            note_prompt_path = ROOT / "prompts" / "note_prompt.md"
            classify_prompt_path = ROOT / "prompts" / "classify_prompt.md"
            note_prompt = note_prompt_path.read_text(encoding="utf-8") if note_prompt_path.exists() else ""
            classify_prompt = classify_prompt_path.read_text(encoding="utf-8") if classify_prompt_path.exists() else ""
            ai = load_or_generate_ai(
                pdf_path, new_hash, settings, note_prompt, classify_prompt,
                force_ai=True, no_ai=False,
            )
        except Exception as exc:
            traceback.print_exc()
            return self.send_error_json(f"AI 重读失败：{exc}")

        # Update only metadata/summary fields; explicitly preserve both human
        # AND AI classification fields (the user wants to control category
        # separately).
        existing = dict(row)
        new_row = row_from_ai(ai, new_hash, pdf_path, pdf_path, note_path, settings, existing=existing)
        new_row["paper_id"] = paper_id
        new_row["笔记路径"] = rel(note_path)
        new_row["PDF路径"] = rel(pdf_path)
        # Preserve existing classification suggestions — the new "help-read" does
        # NOT update them. Only an explicit "重新整理本文献" (legacy /reprocess)
        # would.
        for field in ("一级分类_AI建议", "二级分类_AI建议"):
            new_row[field] = existing.get(field, "")

        for i, r in enumerate(rows):
            if r.get("paper_id") == paper_id:
                rows[i] = new_row
                break
        save_rows(rows)

        manual_note = extract_manual_note(note_path) if note_path.exists() else ""
        rendered = render_note(ai, new_row, rel(pdf_path), manual_note)
        note_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(note_path, rendered)

        return self.send_json(
            {
                "ok": True,
                "paper": paper_payload(new_row),
                "note": rendered,
                "model": settings.get("api", {}).get("model", ""),
            }
        )

    def api_gen_summary(self) -> None:
        """为单篇文献用 AI 生成「一句话总结」，写回 AI一句话总结 字段。

        只读取该篇 PDF 的全文文本喂给当前 provider，要求输出一句中文概括。
        不动分类、不动笔记、不动其它任何字段。
        """
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        if not paper_id:
            return self.send_error_json("missing paper_id")
        rows = load_rows()
        row = find_row(paper_id, rows)
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        try:
            pdf_text = cached_or_extract_full_text(row)
        except Exception as exc:
            traceback.print_exc()
            return self.send_error_json(f"PDF 文本提取失败：{exc}")
        if not (pdf_text or "").strip():
            return self.send_error_json(
                "提取不到 PDF 文本（可能是扫描件且未开启 OCR），无法生成总结"
            )
        question = (
            "请用一句简洁的中文（40 字以内）概括这篇论文的核心研究主题与主要发现。"
            "只输出这一句话本身，不要加任何前缀、引号、编号或解释。"
        )
        try:
            answer, _usage = call_chat_ai(row, question, "", pdf_text, history=[])
        except Exception as exc:
            traceback.print_exc()
            return self.send_error_json(f"AI 生成失败：{exc}")
        summary = " ".join(str(answer or "").split()).strip()
        summary = summary.strip("「」“”\"'　 ")
        if not summary:
            return self.send_error_json("AI 返回为空，请重试")
        row["AI一句话总结"] = summary
        save_rows(rows)
        return self.send_json(
            {"ok": True, "summary": summary, "paper": paper_payload(row)}
        )

    def api_reprocess_paper(self) -> None:
        """Re-run AI classification + note generation for one paper.

        Keeps the PDF in place (does not rename), preserves human-confirmed
        category fields and the manual-note section, force-refreshes AI
        cache, and re-applies tracking-journal stars.
        """
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        if not paper_id:
            return self.send_error_json("missing paper_id")
        rows = load_rows()
        row = find_row(paper_id, rows)
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        pdf_rel = row.get("PDF路径", "")
        note_rel = row.get("笔记路径", "")
        if not pdf_rel:
            return self.send_error_json("paper has no PDF path")
        pdf_path = safe_root_path(pdf_rel)
        if not pdf_path.exists():
            return self.send_error_json("PDF file missing on disk", HTTPStatus.NOT_FOUND)
        note_path = safe_root_path(note_rel) if note_rel else (
            project_path("library/notes") / f"{paper_id}.md"
        )
        settings = load_settings()
        # Recompute file hash so the cache key matches the current bytes
        # (annotations stamped via PyMuPDF change the hash; that's expected).
        new_hash = sha256_file(pdf_path)
        # Drop stale AI cache so force_ai gets a fresh result
        try:
            note_prompt_path = ROOT / "prompts" / "note_prompt.md"
            classify_prompt_path = ROOT / "prompts" / "classify_prompt.md"
            note_prompt = note_prompt_path.read_text(encoding="utf-8") if note_prompt_path.exists() else ""
            classify_prompt = classify_prompt_path.read_text(encoding="utf-8") if classify_prompt_path.exists() else ""
            ai = load_or_generate_ai(
                pdf_path, new_hash, settings, note_prompt, classify_prompt,
                force_ai=True, no_ai=False,
            )
        except Exception as exc:
            traceback.print_exc()
            return self.send_error_json(f"AI 重整失败：{exc}")

        # Build updated row, preserving manual fields per settings.preserve_manual_fields
        existing = dict(row)
        # row_from_ai recomputes paper_id from pdf path stem; we want the existing one.
        new_row = row_from_ai(ai, new_hash, pdf_path, pdf_path, note_path, settings, existing=existing)
        new_row["paper_id"] = paper_id  # do not rename
        new_row["笔记路径"] = rel(note_path)
        new_row["PDF路径"] = rel(pdf_path)

        # Replace the row in-place and persist
        for i, r in enumerate(rows):
            if r.get("paper_id") == paper_id:
                rows[i] = new_row
                break
        save_rows(rows)

        # Re-render note (preserving the user's manual-note section)
        manual_note = extract_manual_note(note_path) if note_path.exists() else ""
        rendered = render_note(ai, new_row, rel(pdf_path), manual_note)
        note_path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(note_path, rendered)

        return self.send_json(
            {
                "ok": True,
                "paper": paper_payload(new_row),
                "note": rendered,
                "ai_primary": new_row.get("一级分类_AI建议", ""),
                "ai_secondary": new_row.get("二级分类_AI建议", ""),
                "star": new_row.get("星标", ""),
                "journal_area": new_row.get("追踪期刊领域", ""),
                "model": settings.get("api", {}).get("model", ""),
            }
        )

    def api_delete_paper(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        rows = load_rows()
        row = find_row(paper_id, rows)
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)

        settings = load_settings()
        deleted: list[str] = []
        for field in ["PDF路径", "笔记路径"]:
            value = row.get(field, "")
            if value:
                remove_project_file(project_path(value), deleted)
        if row.get("文件哈希"):
            remove_project_file(text_cache_path_for(row, settings), deleted)
            remove_project_file(ai_cache_path_for(row, settings), deleted)
        if remove_english_excerpt_entries(row):
            deleted.append(rel(ENGLISH_EXCERPTS_PATH))
        # Clean up sticky-notes sidecar (JSON), if any.
        if annot_module.delete_all_for_paper(paper_id):
            deleted.append(rel(ROOT / "library" / "stickies" / f"{paper_id}.json"))

        remaining = [item for item in rows if item.get("paper_id") != paper_id]
        save_rows(remaining)
        return self.send_json(
            {
                "ok": True,
                "deleted": deleted,
                "count": len(remaining),
                "paper_id": paper_id,
            }
        )

    def api_append_note(self) -> None:
        data = read_body(self)
        paper_id = data.get("paper_id", "")
        title = str(data.get("title", "")).strip()
        content = str(data.get("content", "")).strip()
        if not content:
            return self.send_error_json("content is empty")
        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        path = note_path_for(row)
        note = append_custom_note(path, title, content)
        return self.send_json({"ok": True, "note": note, "path": rel(path)})

    def api_save_settings(self) -> None:
        data = read_body(self)
        settings = save_settings_payload(data)
        save_rows(load_rows())
        return self.send_json({"ok": True, "settings": settings_payload()})

    def api_save_onboarding(self) -> None:
        data = read_body(self)
        save_onboarding_payload(data)
        return self.send_json(onboarding_payload())

    def api_prompts(self) -> None:
        note_path = ROOT / "prompts" / "note_prompt.md"
        classify_path = ROOT / "prompts" / "classify_prompt.md"
        template_path = ROOT / "prompts" / "note_template.md"
        return self.send_json(
            {
                "ok": True,
                "note_prompt": note_path.read_text(encoding="utf-8") if note_path.exists() else "",
                "classify_prompt": classify_path.read_text(encoding="utf-8") if classify_path.exists() else "",
                "note_template": template_path.read_text(encoding="utf-8") if template_path.exists() else DEFAULT_NOTE_TEMPLATE,
            }
        )

    def api_save_prompts(self) -> None:
        data = read_body(self)
        prompt_dir = ROOT / "prompts"
        prompt_dir.mkdir(parents=True, exist_ok=True)
        atomic_write_text(prompt_dir / "note_prompt.md", str(data.get("note_prompt", "")).strip() + "\n")
        atomic_write_text(prompt_dir / "classify_prompt.md", str(data.get("classify_prompt", "")).strip() + "\n")
        template = str(data.get("note_template", "")).rstrip() or DEFAULT_NOTE_TEMPLATE.rstrip()
        atomic_write_text(prompt_dir / "note_template.md", template + "\n")
        return self.send_json({"ok": True})

    def api_tracking_journals(self) -> None:
        settings = load_settings()
        entries = load_tracking_journals(settings)
        path = project_path((settings.get("tracking_journals", {}) or {}).get("path", "list.xlsx"))
        return self.send_json({"ok": True, "entries": entries, "path": rel(path), "count": len(entries)})

    def api_save_tracking_journals(self) -> None:
        data = read_body(self)
        raw_entries = data.get("entries", [])
        if not isinstance(raw_entries, list):
            return self.send_error_json("entries must be a list")
        entries: list[dict[str, str]] = []
        for item in raw_entries:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            entries.append(
                {
                    "field": str(item.get("field", "")).strip(),
                    "name": name,
                    "ft50": str(item.get("ft50", "")).strip(),
                    "utd": str(item.get("utd", "")).strip(),
                    "abs": str(item.get("abs", "")).strip(),
                    "abs_subject": str(item.get("abs_subject", "")).strip(),
                }
            )
        settings = load_settings()
        path = save_tracking_journals(settings, entries)
        rows = load_rows()
        summary = apply_tracking_journals(rows, settings)
        save_rows(rows)
        return self.send_json(
            {
                "ok": True,
                "path": rel(path),
                "count": len(entries),
                "starred": summary.get("starred", 0),
                "changed": summary.get("changed", 0),
            }
        )

    def api_save_category_tree(self) -> None:
        data = read_body(self)
        save_category_tree_payload(data)
        save_rows(load_rows())
        return self.send_json(category_tree_payload())

    def api_rename_primary_category(self) -> None:
        data = read_body(self)
        old = str(data.get("old", "")).strip()
        new = str(data.get("new", "")).strip()
        if not old or not new:
            return self.send_error_json("old / new name 不能为空")
        if old == new:
            return self.send_error_json("新旧名称相同")
        settings = load_settings()
        tree = normalize_category_tree(
            settings.get("classification", {}).get("primary_categories", {})
        )
        if old not in tree:
            return self.send_error_json(f"一级分类「{old}」不存在")
        if new in tree:
            return self.send_error_json(f"一级分类「{new}」已存在，无法重命名")
        # 保留原顺序：用列表重建
        new_tree: dict[str, dict[str, list[str]]] = {}
        for primary, children in tree.items():
            new_tree[new if primary == old else primary] = children
        settings.setdefault("classification", {})["primary_categories"] = new_tree
        save_settings_yaml(settings)
        migrated = migrate_rows_for_rename("primary", old, new)
        return self.send_json(
            {"ok": True, "migrated": migrated, "tree": category_tree_payload()["tree"]}
        )

    def api_rename_secondary_category(self) -> None:
        data = read_body(self)
        primary = str(data.get("primary", "")).strip()
        old = str(data.get("old", "")).strip()
        new = str(data.get("new", "")).strip()
        if not primary or not old or not new:
            return self.send_error_json("primary / old / new 不能为空")
        if old == new:
            return self.send_error_json("新旧名称相同")
        settings = load_settings()
        tree = normalize_category_tree(
            settings.get("classification", {}).get("primary_categories", {})
        )
        if primary not in tree:
            return self.send_error_json(f"一级分类「{primary}」不存在")
        secondaries = tree[primary]
        if old not in secondaries:
            return self.send_error_json(f"二级分类「{old}」不在「{primary}」下")
        if new in secondaries:
            return self.send_error_json(f"「{primary}」下已存在二级分类「{new}」")
        new_secondaries: dict[str, list[str]] = {}
        for sec, tertiaries in secondaries.items():
            new_secondaries[new if sec == old else sec] = tertiaries
        tree[primary] = new_secondaries
        settings.setdefault("classification", {})["primary_categories"] = tree
        save_settings_yaml(settings)
        migrated = migrate_rows_for_rename("secondary", old, new)
        return self.send_json(
            {"ok": True, "migrated": migrated, "tree": category_tree_payload()["tree"]}
        )

    def api_rename_tertiary_category(self) -> None:
        data = read_body(self)
        primary = str(data.get("primary", "")).strip()
        secondary = str(data.get("secondary", "")).strip()
        old = str(data.get("old", "")).strip()
        new = str(data.get("new", "")).strip()
        if not primary or not secondary or not old or not new:
            return self.send_error_json("primary / secondary / old / new 不能为空")
        if old == new:
            return self.send_error_json("新旧名称相同")
        settings = load_settings()
        tree = normalize_category_tree(
            settings.get("classification", {}).get("primary_categories", {})
        )
        if primary not in tree or secondary not in tree[primary]:
            return self.send_error_json("找不到对应的二级分类")
        tertiaries = tree[primary][secondary]
        if old not in tertiaries:
            return self.send_error_json(f"三级分类「{old}」不存在")
        if new in tertiaries:
            return self.send_error_json(f"三级分类「{new}」已存在")
        tree[primary][secondary] = [new if t == old else t for t in tertiaries]
        settings.setdefault("classification", {})["primary_categories"] = tree
        save_settings_yaml(settings)
        migrated = migrate_rows_for_rename("tertiary", old, new)
        return self.send_json(
            {"ok": True, "migrated": migrated, "tree": category_tree_payload()["tree"]}
        )

    def api_ask(self) -> None:
        data = read_body(self)
        paper_id = data.get("paper_id", "")
        question = str(data.get("question", "")).strip()
        append = bool(data.get("append", False))
        use_images = bool(data.get("use_images", False))
        page_spec = str(data.get("page_spec", "")).strip()
        # default True: every ask feeds the trailing chat history back to the LLM
        use_history = bool(data.get("use_history", True))
        work_context_name = str(data.get("work_context", "")).strip()
        if not question:
            return self.send_error_json("question is empty")

        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        note_path = note_path_for(row)
        note_text = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
        # FULL-PDF text (every page) — the quick-scan cache only has the first
        # 10 + last 4 pages, so the model used to say it "can't see the later
        # pages" of long papers. cached_or_extract_full_text builds + caches
        # the whole paper on first ask.
        pdf_text = cached_or_extract_full_text(row)
        # Optional: prepend the active citation's WRITING_CONTEXT into the
        # note_text so the LLM treats it as part of the paper's situational
        # context. We label it clearly so the LLM doesn't confuse it with
        # the paper itself.
        if work_context_name:
            try:
                cf = citations_module.load(work_context_name)
                if cf.context.strip():
                    work_block = (
                        f"\n\n【当前写作工作语境：{cf.display_name}】\n"
                        f"（你正在为这篇 citation 工作。回答时优先考虑这篇文献能为下面这个写作主题贡献什么。）\n"
                        f"{cf.context.strip()}\n"
                    )
                    note_text = (note_text or "") + work_block
            except (FileNotFoundError, ValueError):
                pass
        prior_history = chat_history_module.load(paper_id) if use_history else []
        image_pages: list[dict[str, Any]] = []
        temp_dir: tempfile.TemporaryDirectory[str] | None = None
        try:
            if use_images:
                if not page_spec:
                    return self.send_error_json("请填写要让 AI 读取的页码，例如 1 或 1,3-5")
                temp_dir = tempfile.TemporaryDirectory(prefix="lit_pages_")
                image_pages = render_pdf_page_images(row, page_spec, Path(temp_dir.name), load_settings())
            answer, usage = call_chat_ai(
                row, question, note_text, pdf_text, image_pages, page_spec,
                history=prior_history,
            )
        finally:
            if temp_dir is not None:
                temp_dir.cleanup()
        new_note = None
        if append:
            new_note = append_ai_answer(note_path, question, answer)
        # Persist this turn (regardless of use_history — we still want the
        # log so the user can scroll back later).
        settings = load_settings()
        model_label = current_model_label(settings)
        history = chat_history_module.append_turn(
            paper_id, question, answer,
            model=model_label,
            usage=usage if isinstance(usage, dict) else {},
            image_pages=",".join(str(it["page"]) for it in image_pages) if image_pages else "",
        )
        return self.send_json({
            "ok": True,
            "answer": answer,
            "usage": usage,
            "note": new_note,
            "history": history,
        })

    def api_ask_multi(self) -> None:
        """Cross-paper Q&A over multiple papers' NOTE files (not their PDFs).

        POST {paper_ids: [...], question}
        Reads each paper's note .md, numbers them [1][2]..., asks the AI to
        synthesize an answer and cite sources by number. Papers with an empty
        or placeholder note are skipped and reported. Returns:
          {ok, answer, references: [{n, paper_id, title, authors, year}],
           skipped: [{paper_id, title, reason}], usage}
        """
        data = read_body(self)
        paper_ids = data.get("paper_ids", []) or []
        question = str(data.get("question", "")).strip()
        if not question:
            return self.send_error_json("question is empty")
        if not isinstance(paper_ids, list) or not paper_ids:
            return self.send_error_json("没有选中任何文献")

        rows = load_rows()
        entries: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []

        def note_is_placeholder(text: str) -> bool:
            """A note counts as 'empty' if, after dropping markdown headings
            and known placeholder tokens, almost nothing real is left."""
            kept: list[str] = []
            for line in text.splitlines():
                s = line.strip()
                if not s or s.startswith("#") or s.startswith("---"):
                    continue
                s = s.replace("待 AI 整理", "").replace("待整理", "").replace("未识别", "")
                s = s.replace("-", "").replace("*", "").strip()
                if s:
                    kept.append(s)
            return len("".join(kept)) < 60

        for pid in paper_ids:
            pid = str(pid).strip()
            row = find_row(pid, rows)
            title = ""
            if row:
                title = (row.get("英文标题") or row.get("标题")
                         or row.get("中文标题") or pid)
            if not row:
                skipped.append({"paper_id": pid, "title": pid, "reason": "未找到该文献"})
                continue
            try:
                note_path = note_path_for(row)
                note = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
            except Exception:
                note = ""
            if not note.strip() or note_is_placeholder(note):
                skipped.append({"paper_id": pid, "title": title, "reason": "笔记为空/占位符"})
                continue
            n = len(entries) + 1
            entries.append({
                "n": n,
                "paper_id": pid,
                "title": title,
                "authors": row.get("作者", ""),
                "year": row.get("年份", ""),
                "venue": row.get("期刊会议", ""),
                "note": note,
            })

        if not entries:
            return self.send_error_json(
                "选中的文献都没有有效笔记（空或仍是「待 AI 整理」占位符）。"
                "请先对它们做「帮我阅读」生成笔记。"
            )

        # Build the combined, numbered note text.
        blocks = [f"（下面是 {len(entries)} 篇文献的笔记，已用 [编号] 标注。请只依据这些笔记回答。）\n"]
        for e in entries:
            head = f"[{e['n']}] {e['title']}"
            byline = " · ".join(x for x in [e["authors"], str(e["year"]), e["venue"]] if x)
            if byline:
                head += f"\n（{byline}）"
            blocks.append(f"\n{'━' * 30}\n{head}\n\n{e['note'].strip()}")
        combined = "\n".join(blocks)

        multi_question = (
            f"{question}\n\n"
            "（回答要求：综合上面多篇文献笔记作答；凡用到某一篇的观点/数据，"
            "请在该句末尾用方括号标注其编号，例如 [2] 或 [1][3]；"
            "只依据笔记内容，信息不足就直说，不要编造。）"
        )

        # Reuse the normal provider dispatch. The combined notes ride in the
        # pdf_text slot; row/note are unused by the lean prompt. No images.
        answer, usage = call_chat_ai(
            {},  # synthetic empty row — the lean prompt no longer embeds it
            multi_question, "", combined,
            image_pages=None, page_spec="", history=[],
        )
        references = [
            {"n": e["n"], "paper_id": e["paper_id"], "title": e["title"],
             "authors": e["authors"], "year": e["year"]}
            for e in entries
        ]
        return self.send_json({
            "ok": True,
            "answer": answer,
            "references": references,
            "skipped": skipped,
            "usage": usage,
        })

    def api_excerpts_list(self, query: dict[str, list[str]]) -> None:
        scope = (query.get("scope", [""])[0] or "all").strip().lower()
        paper_id = (query.get("paper_id", [""])[0] or "").strip()
        sort = (query.get("sort", [""])[0] or "ts_desc").strip().lower()
        if scope == "paper" and not paper_id:
            return self.send_json({"ok": True, "cards": [], "scope": scope})
        if scope == "paper":
            cards = excerpts_module.list_for_paper(paper_id)
        else:
            cards = excerpts_module.list_all()
        if sort == "ts_asc":
            cards = sorted(cards, key=lambda c: c.ts)
        else:
            cards = sorted(cards, key=lambda c: c.ts, reverse=True)
        return self.send_json({
            "ok": True,
            "scope": scope,
            "paper_id": paper_id,
            "sort": sort,
            "cards": excerpts_module.to_payload(cards),
            "count": len(cards),
        })

    def api_excerpts_stats(self, query: dict[str, list[str]]) -> None:
        paper_id = (query.get("paper_id", [""])[0] or "").strip()
        return self.send_json({"ok": True, **excerpts_module.stats(paper_id)})

    def api_stickies_all(self) -> None:
        items = annot_module.list_all_stickies()
        # join paper title from index for nicer display
        rows = {r.get("paper_id"): r for r in load_rows()}
        for s in items:
            row = rows.get(s.get("paper_id"))
            if row:
                s["paper_title"] = row.get("英文标题") or row.get("标题") or s.get("paper_id")
                # year/author for compact label
                s["paper_year"] = row.get("年份", "")
                s["paper_author"] = row.get("作者", "").split("；")[0].split(",")[0].strip() if row.get("作者") else ""
        return self.send_json({"ok": True, "stickies": items, "count": len(items)})

    def api_stickies_stats(self, query: dict[str, list[str]]) -> None:
        paper_id = (query.get("paper_id", [""])[0] or "").strip()
        return self.send_json({"ok": True, **annot_module.stats_stickies(paper_id)})

    def api_detect_models(self) -> None:
        """Detect / list available models for a provider so the user can pick
        from a dropdown instead of typing model names by hand.

        POST body: {provider, base_url?, api_key_env?}
          provider: ollama | openai_compatible | codex | claude
        Returns: {ok, models: [{id, available, note}], source}
        """
        data = read_body(self)
        provider = str(data.get("provider", "")).strip().lower()
        base_url = str(data.get("base_url", "")).strip()
        api_key_env = str(data.get("api_key_env", "")).strip()

        if provider == "ollama":
            return self.send_json(_detect_ollama_models(base_url))
        if provider in {"codex", "codex_cli", "codex-cli"}:
            return self.send_json(_curated_codex_models())
        if provider in {"claude", "claude_cli", "claude-cli"}:
            return self.send_json(_detect_claude_models())
        # Everything else → OpenAI-compatible /models probe
        return self.send_json(_detect_openai_models(base_url, api_key_env))

    def api_llm_ping(self) -> None:
        """Verify the configured main-model provider responds. Returns:
          {ok, ok_provider, model, latency_ms, error?}
        Uses a tiny `1+1=?` prompt to avoid burning tokens.
        """
        import time as _time
        settings = load_settings()
        api = settings.get("api", {})
        provider = str(api.get("provider", "")).strip().lower()
        model = str(api.get("model", "")).strip()
        start = _time.monotonic()
        try:
            if provider in {"codex", "codex_cli", "codex-cli"}:
                # For Codex CLI just check the binary exists / is executable
                cmd = settings.get("codex_cli", {}).get("command") or _default_codex_command()
                import shutil as _shutil
                resolved = _shutil.which(cmd) or (Path(cmd).exists() and cmd)
                if not resolved:
                    raise RuntimeError(f"未找到 Codex CLI 可执行文件：{cmd}")
                model = str(settings.get("codex_cli", {}).get("model") or "gpt-5.4")
            elif provider in {"claude", "claude_cli", "claude-cli"}:
                # For Claude Code CLI just check the binary exists / is executable
                cmd = settings.get("claude_cli", {}).get("command") or _default_claude_command()
                import shutil as _shutil
                resolved = _shutil.which(cmd) or (Path(cmd).exists() and cmd)
                if not resolved:
                    raise RuntimeError(f"未找到 Claude CLI 可执行文件：{cmd}。请先安装 `npm install -g @anthropic-ai/claude-code` 并在终端运行 `claude login`。")
                model = str(settings.get("claude_cli", {}).get("model") or "claude-sonnet-4-5")
            else:
                # OpenAI-compatible — make a minimal call
                import requests
                key_env = str(api.get("api_key_env", "")).strip()
                key = os.environ.get(key_env, "") if key_env else ""
                if not key:
                    raise RuntimeError(f"未配置 API key（环境变量 {key_env or 'API_KEY'} 为空）")
                base_url = str(api.get("base_url", "")).rstrip("/")
                if not base_url:
                    raise RuntimeError("未配置 base_url")
                if not model:
                    raise RuntimeError("未配置 model")
                resp = requests.post(
                    f"{base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                    json={
                        "model": model,
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 5,
                        "temperature": 0,
                    },
                    timeout=20,
                )
                if resp.status_code >= 400:
                    raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")
            latency_ms = int((_time.monotonic() - start) * 1000)
            return self.send_json({
                "ok": True,
                "provider": provider,
                "model": model,
                "latency_ms": latency_ms,
            })
        except Exception as exc:
            latency_ms = int((_time.monotonic() - start) * 1000)
            return self.send_json({
                "ok": False,
                "provider": provider,
                "model": model,
                "latency_ms": latency_ms,
                "error": str(exc)[:300],
            })

    def api_get_ui_settings(self) -> None:
        settings = load_settings()
        ui = settings.get("ui", {}) or {}
        tabs = ui.get("inspector_tabs", {}) or {}
        return self.send_json({
            "ok": True,
            "inspector_tabs": {
                "note": True,
                "annot": bool(tabs.get("annot", True)),
                "ai": bool(tabs.get("ai", True)),
                "excerpt": bool(tabs.get("excerpt", True)),
                "meta": bool(tabs.get("meta", True)),
            },
        })

    def api_save_ui_settings(self) -> None:
        data = read_body(self)
        incoming = data.get("inspector_tabs", {}) or {}
        settings = load_settings()
        ui = settings.setdefault("ui", {})
        ui["inspector_tabs"] = {
            "note": True,
            "annot": bool(incoming.get("annot", True)),
            "ai": bool(incoming.get("ai", True)),
            "excerpt": bool(incoming.get("excerpt", True)),
            "meta": bool(incoming.get("meta", True)),
        }
        save_settings_yaml(settings)
        return self.send_json({"ok": True, "inspector_tabs": ui["inspector_tabs"]})

    def api_chat_history(self, query: dict[str, list[str]]) -> None:
        paper_id = query.get("paper_id", [""])[0]
        if not paper_id:
            return self.send_error_json("missing paper_id")
        return self.send_json({"ok": True, "history": chat_history_module.load(paper_id)})

    def api_coauth_graph(self, query: dict[str, list[str]]) -> None:
        """Build an author co-occurrence graph for papers in a given category.

        Query params:
            category: exact category token (matches across 一级/二级/三级/最终分类/AI建议).
                      Empty/missing → whole library.
            level:    "primary" | "secondary" | "tertiary" | "all" (default "all")
                      Restricts which category field is matched.
            min_papers: int (default 1) — drop authors with fewer than N papers
                      in the filtered set. Use 2+ to remove noise on big libs.

        Returns:
            {
              ok: true,
              category: ".",
              paper_count: N,
              nodes: [{id: "author", paper_count: K, papers: [paper_id,...]}],
              edges: [{source: "a", target: "b", weight: N_shared_papers}],
              stats: {total_authors: ..., total_edges: ..., max_degree: ...}
            }
        """
        category = (query.get("category", [""])[0] or "").strip()
        level = (query.get("level", ["all"])[0] or "all").strip().lower()
        try:
            min_papers = max(1, int(query.get("min_papers", ["1"])[0]))
        except (TypeError, ValueError):
            min_papers = 1

        # Map level → which row fields to scan
        level_to_fields = {
            "primary":   ["一级分类", "一级分类_AI建议"],
            "secondary": ["二级分类", "二级分类_AI建议"],
            "tertiary":  ["三级分类"],
            "all":       ["一级分类", "二级分类", "三级分类",
                          "人工分类", "最终分类",
                          "一级分类_AI建议", "二级分类_AI建议"],
        }
        fields = level_to_fields.get(level, level_to_fields["all"])

        rows = load_rows()

        def matches_category(row: dict[str, str]) -> bool:
            if not category:
                return True
            for f in fields:
                if category in _split_tokens(row.get(f, "")):
                    return True
            return False

        filtered = [r for r in rows if matches_category(r)]

        # Parse authors. Common separators in CSV: ; ； , 、
        # Don't split on Chinese full stops or English commas inside one name.
        def parse_authors(raw: str) -> list[str]:
            if not raw:
                return []
            # Split on ; ； 、 and unambiguous "; " "， "
            parts = re.split(r"[;；、]|(?:,\s+)|(?:，\s*)", raw)
            seen: set[str] = set()
            out: list[str] = []
            for p in parts:
                name = p.strip().strip(".").strip()
                # Drop pure initials like "A." / "X.Y." which are spurious splits
                if not name or len(name) < 2:
                    continue
                # Normalize whitespace
                name = re.sub(r"\s+", " ", name)
                key = name.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append(name)
            return out

        # Build: author -> [paper_id, ...]
        from collections import defaultdict
        author_papers: dict[str, list[str]] = defaultdict(list)
        for r in filtered:
            authors = parse_authors(r.get("作者", ""))
            pid = r.get("paper_id", "")
            for a in authors:
                author_papers[a].append(pid)

        # Filter by min_papers
        kept = {a: ps for a, ps in author_papers.items() if len(ps) >= min_papers}

        # Build edges: for each paper, every pair of (kept) authors gets an edge
        edge_counts: dict[tuple[str, str], int] = defaultdict(int)
        # Reverse map: paper -> [authors who are kept]
        paper_to_authors: dict[str, list[str]] = defaultdict(list)
        for a, ps in kept.items():
            for p in ps:
                paper_to_authors[p].append(a)
        for p, alist in paper_to_authors.items():
            alist = sorted(set(alist))
            for i in range(len(alist)):
                for j in range(i + 1, len(alist)):
                    edge_counts[(alist[i], alist[j])] += 1

        # Build node degrees for centrality
        degree: dict[str, int] = defaultdict(int)
        for (a, b), w in edge_counts.items():
            degree[a] += w
            degree[b] += w

        nodes = [
            {
                "id": a,
                "paper_count": len(ps),
                "degree": degree.get(a, 0),
                "papers": ps[:30],  # cap to keep response reasonable
            }
            for a, ps in kept.items()
        ]
        nodes.sort(key=lambda n: (-n["paper_count"], n["id"]))
        edges = [
            {"source": s, "target": t, "weight": w}
            for (s, t), w in edge_counts.items()
        ]
        edges.sort(key=lambda e: -e["weight"])

        return self.send_json({
            "ok": True,
            "category": category or "(全部)",
            "level": level,
            "min_papers": min_papers,
            "paper_count": len(filtered),
            "nodes": nodes,
            "edges": edges,
            "stats": {
                "total_authors": len(kept),
                "total_authors_unfiltered": len(author_papers),
                "total_edges": len(edges),
                "max_degree": max(degree.values()) if degree else 0,
                "max_paper_count": max((n["paper_count"] for n in nodes), default=0),
            },
        })

    def api_chat_history_clear(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        if not paper_id:
            return self.send_error_json("missing paper_id")
        removed = chat_history_module.clear(paper_id)
        return self.send_json({"ok": True, "removed": removed})

    def api_excerpt(self) -> None:
        data = read_body(self)
        paper_id = data.get("paper_id", "")
        append_note = bool(data.get("append_note", False))
        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        note_path = note_path_for(row)
        note_text = note_path.read_text(encoding="utf-8") if note_path.exists() else ""
        text_path = text_cache_path_for(row)
        pdf_text = text_path.read_text(encoding="utf-8") if text_path.exists() else ""
        question = (
            "请从这篇文献中摘录 6-8 条适合学术写作学习的英文原文句子或短语。"
            "必须只使用 PDF 提取文本中确实出现的英文原句或原文短语，不要翻译，不要编造。"
            "每条英文摘录控制在 25 个英文词以内；如果原句更长，请只摘录其中最有表达价值的短语或从句。"
            "优先选择适合文献综述、研究意义、方法描述、限制讨论、转折衔接的表达。"
            "请用 Markdown 输出，每条包含：英文原句/短语、中文用法说明、可用于论文写作的场景。"
            "如果 PDF 文本中没有足够清晰的英文原句，请明确说明。"
        )
        answer, usage = call_chat_ai(row, question, note_text, pdf_text)
        excerpt_path = append_english_excerpt(row, answer)
        new_note = None
        if append_note:
            new_note = append_custom_note(note_path, "英文好句摘抄", answer)
        return self.send_json(
            {
                "ok": True,
                "answer": answer,
                "usage": usage,
                "note": new_note,
                "excerpt_path": rel(excerpt_path),
                "excerpt_url": f"/file?path={rel(excerpt_path)}",
            }
        )

    def api_refresh_scan_status(self) -> None:
        settings = load_settings()
        rows = load_rows()
        changed = 0
        scanned = 0
        suspected = 0
        for row in rows:
            before = row.get("扫描件", "")
            if update_row_scan_status(row, settings):
                changed += 1
            after = row.get("扫描件", "")
            if after == "是":
                scanned += 1
            elif after == "疑似":
                suspected += 1
            if before and not after:
                changed += 0
        save_rows(rows)
        return self.send_json(
            {
                "ok": True,
                "changed": changed,
                "scanned": scanned,
                "suspected": suspected,
                "count": len(rows),
            }
        )

    def api_translate(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        selected_text = str(data.get("text", "")).strip()
        if not selected_text:
            return self.send_error_json("selected text is empty")
        if len(selected_text) > 6000:
            return self.send_error_json("选中文本太长，请少选一点再翻译")
        row = find_row(paper_id, load_rows())
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        result = dispatch_translate(selected_text, load_settings())
        return self.send_json({"ok": True, **result})

    def api_translation_settings(self) -> None:
        settings = load_settings()
        translation = translation_settings(settings)
        out = {
            "ok": True,
            "provider": translation.get("provider", "ollama"),
            "ollama": {
                "base_url": (translation.get("ollama") or {}).get("base_url", "http://127.0.0.1:11434"),
                "model": (translation.get("ollama") or {}).get("model", "qwen3:14b"),
                "timeout_seconds": (translation.get("ollama") or {}).get("timeout_seconds", 120),
            },
            "openai_compatible": {
                "base_url": (translation.get("openai_compatible") or {}).get("base_url", ""),
                "model": (translation.get("openai_compatible") or {}).get("model", ""),
                "api_key_env": (translation.get("openai_compatible") or {}).get("api_key_env", "OPENAI_API_KEY"),
                "has_api_key": bool(os.environ.get((translation.get("openai_compatible") or {}).get("api_key_env", "OPENAI_API_KEY"), "")),
                "timeout_seconds": (translation.get("openai_compatible") or {}).get("timeout_seconds", 60),
            },
        }
        return self.send_json(out)

    def api_save_translation_settings(self) -> None:
        data = read_body(self)
        settings = load_settings()
        existing = translation_settings(settings)
        provider = str(data.get("provider") or existing.get("provider") or "ollama").lower()
        ollama_in = data.get("ollama") or {}
        openai_in = data.get("openai_compatible") or {}
        new_translation = dict(existing)
        new_translation["provider"] = provider
        new_translation["ollama"] = {
            "base_url": str(ollama_in.get("base_url", existing.get("ollama", {}).get("base_url", "http://127.0.0.1:11434"))).strip() or "http://127.0.0.1:11434",
            "model": str(ollama_in.get("model", existing.get("ollama", {}).get("model", "qwen3:14b"))).strip() or "qwen3:14b",
            "timeout_seconds": int(float(ollama_in.get("timeout_seconds") or existing.get("ollama", {}).get("timeout_seconds") or 120)),
        }
        compat_existing = existing.get("openai_compatible", {}) or {}
        new_translation["openai_compatible"] = {
            "base_url": str(openai_in.get("base_url", compat_existing.get("base_url", ""))).strip(),
            "model": str(openai_in.get("model", compat_existing.get("model", ""))).strip(),
            "api_key_env": str(openai_in.get("api_key_env", compat_existing.get("api_key_env", "OPENAI_API_KEY"))).strip() or "OPENAI_API_KEY",
            "timeout_seconds": int(float(openai_in.get("timeout_seconds") or compat_existing.get("timeout_seconds") or 60)),
        }
        # Persist API key to .env if user provided one
        new_key = str(openai_in.get("api_key", "")).strip()
        if new_key:
            update_env_file(new_translation["openai_compatible"]["api_key_env"], new_key)
        settings["translation"] = new_translation
        save_settings_yaml(settings)
        return self.send_json({"ok": True})

    # ---- EasyScholar journal-rank lookup --------------------------------

    def api_easyscholar_settings(self) -> None:
        settings = load_settings()
        es = settings.get("easyscholar", {}) or {}
        env = (es.get("api_key_env") or "EASYSCHOLAR_SECRET_KEY").strip()
        enabled_fields = es.get("enabled_fields")
        if not isinstance(enabled_fields, list) or not enabled_fields:
            enabled_fields = list(easyscholar_module.DEFAULT_ENABLED_FIELDS)
        return self.send_json(
            {
                "ok": True,
                "enabled": bool(es.get("enabled", True)),
                "api_key_env": env,
                "has_api_key": bool(os.environ.get(env, "")),
                "enabled_fields": enabled_fields,
                "available_fields": [
                    {"key": k, "label": v}
                    for k, v in easyscholar_module.FIELD_LABELS.items()
                ],
            }
        )

    def api_save_easyscholar_settings(self) -> None:
        data = read_body(self)
        settings = load_settings()
        es = settings.setdefault("easyscholar", {})
        es["enabled"] = bool(data.get("enabled", True))
        env_name = (str(data.get("api_key_env", "")).strip() or "EASYSCHOLAR_SECRET_KEY")
        es["api_key_env"] = env_name
        raw_fields = data.get("enabled_fields")
        if isinstance(raw_fields, list):
            allowed = set(easyscholar_module.FIELD_LABELS.keys())
            cleaned: list[str] = []
            for item in raw_fields:
                key = str(item).strip()
                if key in allowed and key not in cleaned:
                    cleaned.append(key)
            es["enabled_fields"] = cleaned or list(easyscholar_module.DEFAULT_ENABLED_FIELDS)
        new_key = str(data.get("api_key", "")).strip()
        if new_key:
            update_env_file(env_name, new_key)
        # 旧的 overwrite_existing 选项不再需要：新的人工/自动双字段设计
        # 保证自动刷新永远不动「期刊等级_人工」字段。
        es.pop("overwrite_existing", None)
        save_settings_yaml(settings)
        return self.send_json({"ok": True})

    def _easyscholar_apply_one(
        self,
        row: dict[str, str],
        secret_key: str,
        enabled_fields: list[str],
        force_refresh: bool,
    ) -> dict[str, Any]:
        """Look up + write `期刊等级_自动` for one row. Never touches 人工 字段。
        Returns {ok, level_text, summary, before, after} or {ok:false, error}.
        """
        venue = (row.get("期刊会议", "") or "").strip()
        if not venue:
            return {"ok": False, "error": "无期刊会议"}
        try:
            result = easyscholar_module.derive_updates(
                venue,
                secret_key,
                force_refresh=force_refresh,
                enabled_fields=enabled_fields,
            )
        except easyscholar_module.EasyScholarError as exc:
            return {"ok": False, "error": str(exc)}
        level_text = result.get("level_text", "") or ""
        before = (row.get("期刊等级_自动", "") or "").strip()
        # 永远只更新「期刊等级_自动」，不动「期刊等级_人工」
        row["期刊等级_自动"] = level_text
        return {
            "ok": True,
            "level_text": level_text,
            "summary": result.get("summary", ""),
            "before": before,
            "changed": before != level_text,
        }

    def api_easyscholar_refresh(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        force = bool(data.get("force_refresh", False))
        rows = load_rows()
        row = find_row(paper_id, rows)
        if not row:
            return self.send_error_json("paper not found", HTTPStatus.NOT_FOUND)
        settings = load_settings()
        es = settings.get("easyscholar", {}) or {}
        env = (es.get("api_key_env") or "EASYSCHOLAR_SECRET_KEY").strip()
        key = os.environ.get(env, "")
        if not key:
            return self.send_error_json(
                f"环境变量 {env} 未配置 EasyScholar secret key。请在设置→期刊等级源里填写后保存。"
            )
        enabled_fields = es.get("enabled_fields") or list(easyscholar_module.DEFAULT_ENABLED_FIELDS)
        result = self._easyscholar_apply_one(row, key, enabled_fields, force)
        if not result.get("ok"):
            return self.send_error_json(result.get("error", "EasyScholar 查询失败"))
        if result.get("changed"):
            save_rows(rows)
            row = find_row(paper_id, load_rows()) or row
        return self.send_json(
            {
                "ok": True,
                "venue": row.get("期刊会议", ""),
                "summary": result.get("summary", ""),
                "level_text": result.get("level_text", ""),
                "before": result.get("before", ""),
                "changed": result.get("changed", False),
                "paper": paper_payload(row),
            }
        )

    def api_easyscholar_refresh_all(self) -> None:
        """Batch refresh `期刊等级_自动` for every paper. Never touches 人工.

        Returns counts; the per-paper detail is kept tiny to avoid huge
        payloads on a 441-paper library.
        """
        data = read_body(self)
        force = bool(data.get("force_refresh", False))
        only_empty = bool(data.get("only_empty", True))
        settings = load_settings()
        es = settings.get("easyscholar", {}) or {}
        env = (es.get("api_key_env") or "EASYSCHOLAR_SECRET_KEY").strip()
        key = os.environ.get(env, "")
        if not key:
            return self.send_error_json(
                f"环境变量 {env} 未配置 EasyScholar secret key。"
            )
        enabled_fields = es.get("enabled_fields") or list(easyscholar_module.DEFAULT_ENABLED_FIELDS)
        rows = load_rows()
        ok = 0
        changed = 0
        skipped_empty_venue = 0
        skipped_already = 0
        failed: list[dict[str, str]] = []
        for row in rows:
            if only_empty and (row.get("期刊等级_自动", "") or "").strip():
                skipped_already += 1
                continue
            venue = (row.get("期刊会议", "") or "").strip()
            if not venue:
                skipped_empty_venue += 1
                continue
            result = self._easyscholar_apply_one(row, key, enabled_fields, force)
            if not result.get("ok"):
                failed.append({"paper_id": row.get("paper_id", ""), "venue": venue, "error": result.get("error", "")})
                continue
            ok += 1
            if result.get("changed"):
                changed += 1
        if changed:
            save_rows(rows)
        return self.send_json(
            {
                "ok": True,
                "total": len(rows),
                "queried_ok": ok,
                "changed": changed,
                "skipped_empty_venue": skipped_empty_venue,
                "skipped_already_filled": skipped_already,
                "failed_count": len(failed),
                # only the first 20 to keep the response small
                "failed_sample": failed[:20],
            }
        )

    # ---- 按分类批量导出 ------------------------------------------------

    def api_export_category(self) -> None:
        data = read_body(self)
        label = str(data.get("category", "")).strip()
        match_mode = str(data.get("match_mode", "exact")).strip() or "exact"
        if not label:
            return self.send_error_json("请提供 category 字段")
        try:
            result = export_module.export_papers(label, match_mode=match_mode)
        except Exception as exc:  # noqa: BLE001
            return self.send_error_json(f"导出失败：{exc}")
        return self.send_json({"ok": True, **result})

    def _require_paper(self, paper_id: str) -> dict[str, str]:
        row = find_row(paper_id, load_rows())
        if not row:
            raise ValueError("paper not found")
        return row

    def api_list_annotations(self, query: dict[str, list[str]]) -> None:
        paper_id = (query.get("paper_id", [""])[0] or "").strip()
        try:
            self._require_paper(paper_id)
        except ValueError as exc:
            return self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
        try:
            stickies = annot_module.list_stickies(paper_id)
        except ValueError as exc:
            return self.send_error_json(str(exc))
        return self.send_json({"ok": True, "stickies": stickies})

    def api_create_annotation(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        try:
            self._require_paper(paper_id)
        except ValueError as exc:
            return self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
        try:
            sticky = annot_module.add_sticky(
                paper_id,
                str(data.get("content", "")),
                color=str(data.get("color", "clay")),
            )
        except ValueError as exc:
            return self.send_error_json(str(exc))
        return self.send_json({"ok": True, "sticky": sticky})

    def api_update_annotation(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        sticky_id = str(data.get("id", "")).strip()
        if not sticky_id:
            return self.send_error_json("missing sticky id")
        try:
            self._require_paper(paper_id)
        except ValueError as exc:
            return self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
        try:
            sticky = annot_module.update_sticky(
                paper_id,
                sticky_id,
                str(data.get("content", "")),
                color=data.get("color") if "color" in data else None,
            )
        except ValueError as exc:
            return self.send_error_json(str(exc))
        return self.send_json({"ok": True, "sticky": sticky})

    def api_delete_annotation(self) -> None:
        data = read_body(self)
        paper_id = str(data.get("paper_id", "")).strip()
        sticky_id = str(data.get("id", "")).strip()
        if not sticky_id:
            return self.send_error_json("missing sticky id")
        try:
            self._require_paper(paper_id)
        except ValueError as exc:
            return self.send_error_json(str(exc), HTTPStatus.NOT_FOUND)
        try:
            removed = annot_module.delete_sticky(paper_id, sticky_id)
        except ValueError as exc:
            return self.send_error_json(str(exc))
        return self.send_json({"ok": True, "removed": removed})

    def api_organize(self) -> None:
        running_id = ""
        with ORGANIZE_LOCK:
            for existing_id, job in ORGANIZE_JOBS.items():
                if job.get("status") == "running":
                    running_id = existing_id
                    break
        if running_id:
            return self.send_json({"ok": True, "job_id": running_id, "job": organize_job_snapshot(running_id)})
        job_id = uuid.uuid4().hex
        update_organize_job(job_id, status="queued", current=0, total=0, model=current_model_label(load_settings()), message="等待启动", logs=[])
        thread = threading.Thread(target=run_organize_job, args=(job_id,), daemon=True)
        thread.start()
        return self.send_json({"ok": True, "job_id": job_id, "job": organize_job_snapshot(job_id)})

    def api_organize_status(self, query: dict[str, list[str]]) -> None:
        job_id = query.get("job_id", [""])[0]
        if not job_id:
            with ORGANIZE_LOCK:
                job_id = next(reversed(ORGANIZE_JOBS), "") if ORGANIZE_JOBS else ""
        if not job_id or job_id not in ORGANIZE_JOBS:
            return self.send_error_json("organize job not found", HTTPStatus.NOT_FOUND)
        return self.send_json({"ok": True, "job": organize_job_snapshot(job_id)})


def main() -> None:
    # First-run bootstrap: copies settings.example.yaml -> settings.yaml,
    # .env.example -> .env, creates all data dirs, seeds default prompts.
    # Idempotent — costs ~5ms on warm runs.
    from common import bootstrap_project
    boot = bootstrap_project()
    if boot["copied"] or boot["created"]:
        print("=" * 60, flush=True)
        if boot["copied"]:
            print("[bootstrap] Copied template files:", flush=True)
            for f in boot["copied"]:
                print(f"    {f}", flush=True)
            print("    -> Edit .env with your API keys, then restart.", flush=True)
        if boot["created"]:
            print(f"[bootstrap] Created {len(boot['created'])} empty data dir(s).", flush=True)
        print("=" * 60, flush=True)

    # Clean up .tmp leftovers from any previously-interrupted atomic write.
    # Harmless if there are none; useful after Ctrl-C / OS sleep / kernel panic.
    _sweep_stale_tmp_files()
    parser = argparse.ArgumentParser(description="启动本地文献工作台网页。")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument(
        "--no-browser",
        action="store_true",
        help="启动后不要自动打开浏览器（默认会打开）。",
    )
    parser.add_argument(
        "--keep-alive",
        action="store_true",
        help="即使浏览器关闭也保持服务运行；默认浏览器无心跳 60s 后自动退出。",
    )
    parser.add_argument(
        "--idle-timeout",
        type=int,
        default=60,
        help="浏览器无心跳后自动关闭工作台的秒数（默认 60）。仅当未传 --keep-alive 时生效。",
    )
    args = parser.parse_args()

    load_env()
    server = ThreadingHTTPServer((args.host, args.port), LiteratureHandler)
    url = f"http://{args.host}:{args.port}"
    print(f"文献工作台已启动：{url}")
    if args.keep_alive:
        print("已开启 --keep-alive：浏览器关闭后仍保持运行，按 Ctrl+C 停止。")
    else:
        print(
            f"浏览器关闭超过 {args.idle_timeout}s 后会自动退出工作台；"
            "如需常驻请加 --keep-alive。"
        )

    if not args.no_browser:
        # 在另一个线程里延后 0.6s 打开浏览器，避免 serve_forever 之前阻塞。
        import webbrowser

        def _open_browser() -> None:
            try:
                webbrowser.open(url, new=2)
            except Exception as exc:  # noqa: BLE001
                print(f"自动打开浏览器失败：{exc}（请手动访问 {url}）")

        threading.Timer(0.6, _open_browser).start()

    if not args.keep_alive:
        start_idle_watcher(server, idle_timeout=float(args.idle_timeout))

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n收到中断，正在关闭服务…")
        server.shutdown()


if __name__ == "__main__":
    main()
