from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from common import (
    INDEX_FIELDS,
    ROOT,
    apply_tracking_journal,
    apply_tracking_journals,
    atomic_write_text,
    clean_piece,
    list_to_text,
    load_env,
    load_settings,
    load_tracking_journals,
    now_text,
    project_path,
    read_csv,
    read_text_if_exists,
    rel,
    scan_status_from_text,
    sort_rows,
    subprocess_hidden_kwargs,
    text_quality,
    unique_path,
    write_csv,
    write_xlsx,
)

MANUAL_NOTE_START = "<!-- manual_note:start -->"
MANUAL_NOTE_END = "<!-- manual_note:end -->"

DEFAULT_NOTE_TEMPLATE = """# 文献速记

{one_sentence_summary}

## 基本信息

- 标题：{title}
- 作者：{authors}
- 年份：{year}
- 期刊/会议：{venue}
- DOI：{doi}
- PDF：{pdf_markdown_link}

## 研究问题

{research_question}

## 方法与数据

{methods_and_data}

## 核心结论

{main_findings}

## 重要观点

{quotable_points}

## 局限性

{limitations}

## 和我的论文的关系

{relation_to_my_research}

## 我的人工笔记

{manual_note}
"""


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def collect_pdfs(sources: list[Path], library_pdf_dir: Path) -> list[Path]:
    pdfs: list[Path] = []
    library_pdf_dir = library_pdf_dir.resolve()
    for source in sources:
        if not source.exists():
            continue
        if source.is_file() and source.suffix.lower() == ".pdf":
            candidates = [source]
        else:
            candidates = [p for p in source.rglob("*") if p.is_file() and p.suffix.lower() == ".pdf"]
        for pdf in candidates:
            try:
                resolved = pdf.resolve()
                resolved.relative_to(library_pdf_dir)
                continue
            except ValueError:
                pass
            pdfs.append(pdf)
    return sorted(set(pdfs), key=lambda p: str(p).lower())


def extract_pdf_text(
    path: Path,
    settings: dict[str, Any],
    file_hash: str = "",
    full: bool = False,
) -> tuple[str, dict[str, Any]]:
    """Extract text from a PDF.

    full=False (default): QUICK scan — first N + last M pages, small char cap.
        Used by 整理新文献 over the whole library where speed matters and only
        metadata + a summary is needed.
    full=True: read EVERY page, large char cap. Used by AI Q&A so the model
        can answer about the middle of a long paper, not just the first pages.
    """
    from pypdf import PdfReader

    meta: dict[str, Any] = {
        "pdf_file_name": path.name,
        "pdf_pages": "",
        "pdf_title": "",
        "pdf_author": "",
    }
    first_pages = int(settings["pdf"].get("quick_first_pages", 10))
    last_pages = int(settings["pdf"].get("quick_last_pages", 4))
    if full:
        max_chars = int(settings["pdf"].get("max_full_chars", 120000))
    else:
        max_chars = int(settings["pdf"].get("max_input_chars", 28000))

    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted:
            try:
                reader.decrypt("")
            except Exception:
                pass
        page_count = len(reader.pages)
        meta["pdf_pages"] = str(page_count)
        if reader.metadata:
            meta["pdf_title"] = str(reader.metadata.title or "")
            meta["pdf_author"] = str(reader.metadata.author or "")
        if full:
            # Every page, in order.
            page_indexes = list(range(page_count))
        else:
            page_indexes = list(range(min(first_pages, page_count)))
            if last_pages:
                page_indexes += list(range(max(first_pages, page_count - last_pages), page_count))
            page_indexes = sorted(set(i for i in page_indexes if 0 <= i < page_count))
        chunks: list[str] = []
        for i in page_indexes:
            try:
                text = reader.pages[i].extract_text() or ""
            except Exception:
                text = ""
            if text.strip():
                chunks.append(f"\n\n--- Page {i + 1} ---\n{text}")
            if sum(len(c) for c in chunks) >= max_chars:
                break
        text = "\n".join(chunks).strip()
    except Exception as exc:
        meta["pdf_error"] = f"{type(exc).__name__}: {exc}"
        text = ""

    if not text:
        text = extract_with_strings(path, max_chars)
        if text:
            meta["pdf_text_source"] = "strings"
    else:
        meta["pdf_text_source"] = "pypdf"

    # NFKC-normalize before quality scoring + length capping. CNKI / 中文学术
    # PDFs frequently use CJK Fullwidth Forms (U+FF00-FFEF) for Latin letters
    # and digits — `２０２３`, `ＤＯＩ`, `（４）` instead of `2023`, `DOI`, `(4)`.
    # BPE tokenizers like DeepSeek's barely merge these, so a 28K-char Chinese
    # paper can produce ~25K tokens instead of ~13K. That triples request time
    # for reasoning models and was the actual cause of the 120s timeouts on
    # 帮我阅读. NFKC also folds 「Ａ」→「A」, full-width punctuation → half-width.
    import unicodedata as _ud
    text = _ud.normalize("NFKC", text)

    # ---- OCR fallback for scanned PDFs --------------------------------
    # If text extraction returned too little OR scan_status says "是",
    # render pages and run the configured OCR engine. Result is cached to
    # library/text/{hash}.ocr.txt and merged with whatever pypdf/strings
    # produced (so partial-text PDFs still benefit).
    ocr_cfg = settings.get("ocr", {}) or {}
    ocr_enabled = bool(ocr_cfg.get("enabled", True))
    threshold = int(ocr_cfg.get("trigger_threshold", 500))
    scan_flag = scan_status_from_text(text)
    needs_ocr = ocr_enabled and (
        len(text.strip()) < threshold or scan_flag == "是"
    )
    if needs_ocr:
        try:
            from ocr import run_ocr_on_pdf
            ocr_text = run_ocr_on_pdf(path, settings, file_hash=file_hash)
            if ocr_text:
                ocr_text = _ud.normalize("NFKC", ocr_text)
                # Prefer OCR result, but keep any existing text as appendix
                if text.strip():
                    text = ocr_text + "\n\n[原始抽取]\n" + text
                else:
                    text = ocr_text
                meta["pdf_text_source"] = "ocr"
                meta["pdf_ocr_engine"] = str(ocr_cfg.get("engine", "rapidocr"))
        except Exception as exc:
            meta["pdf_ocr_error"] = f"{type(exc).__name__}: {exc}"

    quality = text_quality(text)
    meta.update({f"text_{key}": value for key, value in quality.items()})
    # If OCR produced text, the document isn't "blocked by scan" anymore —
    # mark status "OCR" so the UI knows OCR rescued it (no scary chip).
    if meta.get("pdf_text_source") == "ocr":
        meta["pdf_scan_status"] = "OCR"
    else:
        meta["pdf_scan_status"] = scan_status_from_text(text)
    return text[:max_chars], meta


def extract_with_strings(path: Path, max_chars: int) -> str:
    try:
        result = subprocess.run(
            ["strings", "-n", "8", str(path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=40,
            check=False,
            **subprocess_hidden_kwargs(),
        )
        return (result.stdout or "")[:max_chars]
    except Exception:
        return ""


def classification_text(settings: dict[str, Any]) -> str:
    parts: list[str] = []
    categories = settings["classification"]["primary_categories"]
    for primary, seconds in categories.items():
        parts.append(f"{primary}: {', '.join(seconds)}")
    return "\n".join(parts)


def strip_json_fences(content: str) -> str:
    content = content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
    start = content.find("{")
    end = content.rfind("}")
    if start >= 0 and end >= start:
        return content[start : end + 1]
    return content


def call_ai(
    text: str,
    pdf_meta: dict[str, str],
    source_path: Path,
    settings: dict[str, Any],
    note_prompt: str,
    classify_prompt: str,
) -> dict[str, Any]:
    api = settings["api"]
    provider = str(api.get("provider", "")).strip().lower()
    schema_hint = {
        "title": "文献标题",
        "authors": ["作者1", "作者2"],
        "year": "年份，未识别则为空",
        "venue": "期刊或会议，未识别则为空",
        "doi": "DOI，未识别则为空",
        "short_title": "适合文件名的英文或拼音短标题，最多8个词",
        "one_sentence_summary": "中文一句话总结",
        "research_question": "研究问题",
        "methods_and_data": "方法与数据",
        "main_findings": ["核心结论1", "核心结论2"],
        "key_concepts": ["概念1", "概念2"],
        "quotable_points": [{"point": "可引用观点", "use_in_paper": "可用于论文哪里"}],
        "limitations": ["局限1"],
        "relation_to_my_research": "和我的博士论文的关系",
        "ai_primary_category": "从给定一级分类中选择一个",
        "ai_secondary_categories": ["从给定二级分类中选择，可多个"],
        "ai_keywords": ["关键词"],
        "method_tags": ["研究方法标签"],
        "research_object": "研究对象",
        "classification_reason": "分类理由",
        "confidence": 0.0,
    }
    system = (
        f"{note_prompt}\n\n{classify_prompt}\n\n"
        "分类体系如下：\n"
        f"{classification_text(settings)}\n\n"
        "请只返回一个合法 JSON 对象，不要返回 Markdown。JSON 字段参考：\n"
        f"{json.dumps(schema_hint, ensure_ascii=False, indent=2)}"
    )
    user = (
        f"来源文件名：{source_path.name}\n"
        f"PDF元数据：{json.dumps(pdf_meta, ensure_ascii=False)}\n\n"
        "PDF提取文本如下：\n"
        f"{text}"
    )
    if provider in {"codex", "codex_cli", "codex-cli"}:
        return call_codex_ai(system, user, settings)
    if provider in {"claude", "claude_cli", "claude-cli"}:
        return call_claude_ai(system, user, settings)
    return call_openai_ai(system, user, settings)


def call_openai_ai(system: str, user: str, settings: dict[str, Any]) -> dict[str, Any]:
    import requests

    api = settings["api"]
    key = os.environ.get(api["api_key_env"], "")
    if not key:
        raise RuntimeError(f"Missing API key env: {api['api_key_env']}")

    endpoint = api["base_url"].rstrip("/") + "/chat/completions"
    base_payload: dict[str, Any] = {
        "model": api["model"],
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": api.get("temperature", 0.2),
        "max_tokens": api.get("max_tokens", 3500),
        "response_format": {"type": "json_object"},
    }
    if api.get("thinking"):
        base_payload["thinking"] = api["thinking"]

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

    attempts = [
        base_payload,
        {k: v for k, v in base_payload.items() if k != "thinking"},
        {k: v for k, v in base_payload.items() if k not in {"thinking", "response_format"}},
    ]
    last_error = ""
    for payload in attempts:
        response = requests.post(
            endpoint,
            headers=headers,
            json=payload,
            timeout=int(api.get("timeout_seconds", 120)),
        )
        if response.status_code >= 400:
            last_error = f"{response.status_code}: {response.text[:500]}"
            continue
        data = response.json()
        content = data["choices"][0]["message"]["content"]
        try:
            parsed = json.loads(strip_json_fences(content))
        except Exception as exc:
            last_error = f"JSON parse failed: {exc}; content={content[:500]}"
            continue
        parsed["_usage"] = data.get("usage", {})
        return parsed
    raise RuntimeError(last_error or "AI request failed")


def call_codex_ai(system: str, user: str, settings: dict[str, Any]) -> dict[str, Any]:
    codex = settings.get("codex_cli", {}) or {}
    command = str(codex.get("command") or "/Applications/Codex.app/Contents/Resources/codex")
    sandbox = str(codex.get("sandbox") or "read-only")
    model = str(codex.get("model") or "gpt-5.4")
    timeout = int(codex.get("timeout_seconds", 180))
    prompt = (
        "你是本地文献整理助手。请严格遵守下面要求，只输出一个合法 JSON 对象。\n\n"
        f"{system}\n\n{user}"
    )
    with tempfile.NamedTemporaryFile("w+", encoding="utf-8", delete=False, suffix=".json") as out:
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
        "-m",
        model,
        "-",
    ]
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
    content = output_path.read_text(encoding="utf-8").strip() if output_path.exists() else ""
    output_path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "Codex CLI 调用失败")[-2000:])
    if not content:
        content = (result.stdout or "").strip()
    parsed = json.loads(strip_json_fences(content))
    parsed["_usage"] = {"provider": "codex_cli", "model": model}
    return parsed


def _default_claude_cmd() -> str:
    import sys as _sys
    return "claude.cmd" if _sys.platform.startswith("win") else "claude"


def call_claude_ai(system: str, user: str, settings: dict[str, Any]) -> dict[str, Any]:
    cfg = settings.get("claude_cli", {}) or {}
    command = str(cfg.get("command") or _default_claude_cmd())
    model = str(cfg.get("model") or "claude-sonnet-4-5").strip()
    timeout = int(cfg.get("timeout_seconds", 240))
    prompt = (
        "你是本地文献整理助手。请严格遵守下面要求，只输出一个合法 JSON 对象，不要任何前后缀、不要 Markdown 围栏。\n\n"
        f"{system}\n\n{user}"
    )
    # CRITICAL: pass the prompt via STDIN, not as a `-p` command-line argument.
    # The prompt embeds the full PDF text (up to ~28000 chars). Windows
    # CreateProcess caps the whole command line at 32767 chars, so a long PDF
    # silently fails to launch the process — the batch then falls back to a
    # blank placeholder ("整理出来都是空白"). `claude -p` with no prompt arg
    # reads the prompt from stdin, exactly like `call_codex_ai` uses `input=`.
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
            f"未找到 Claude CLI 可执行文件：{command}。\n"
            "请先在终端运行：npm install -g @anthropic-ai/claude-code，然后 claude login。"
        ) from exc
    except OSError as exc:
        raise RuntimeError(f"Claude CLI 启动失败：{exc}") from exc
    if result.returncode != 0:
        err = (result.stderr or result.stdout or "").strip()
        low = err.lower()
        if "not logged in" in low or "authentication" in low or "unauthorized" in low:
            raise RuntimeError("Claude CLI 未登录。请在终端运行：claude login")
        if "model" in low and ("not found" in low or "invalid" in low or "unknown" in low):
            raise RuntimeError(
                f"Claude CLI 拒绝模型名「{model}」。请在 设置→主模型→Claude CLI 改成有效模型，"
                f"例如 claude-sonnet-4-5 / claude-opus-4-1 / claude-haiku-4-5。\n原始：{err[-800:]}"
            )
        raise RuntimeError((err or "Claude CLI 调用失败")[-2000:])
    content = (result.stdout or "").strip()
    if not content:
        raise RuntimeError(
            "Claude CLI 返回了空结果。可能原因：模型名无效 / 未登录 / 额度用尽。"
            f"stderr：{(result.stderr or '')[-500:]}"
        )
    parsed = json.loads(strip_json_fences(content))
    parsed["_usage"] = {"provider": "claude_cli", "model": model}
    return parsed


def fallback_ai(path: Path, pdf_meta: dict[str, str], error: str = "") -> dict[str, Any]:
    title = pdf_meta.get("pdf_title") or path.stem
    return {
        "title": title,
        "authors": [pdf_meta.get("pdf_author") or "未识别"],
        "year": guess_year(path.name),
        "venue": "",
        "doi": "",
        "short_title": clean_piece(title, 60),
        "one_sentence_summary": "待 AI 整理",
        "research_question": "待 AI 整理",
        "methods_and_data": "待 AI 整理",
        "main_findings": [],
        "key_concepts": [],
        "quotable_points": [],
        "limitations": [],
        "relation_to_my_research": "待人工判断",
        "ai_primary_category": "待分类",
        "ai_secondary_categories": [],
        "ai_keywords": [],
        "method_tags": [],
        "research_object": "",
        "classification_reason": f"未完成 AI 整理。{error}".strip(),
        "confidence": 0,
    }


def guess_year(value: str) -> str:
    match = re.search(r"(19|20)\d{2}", value)
    return match.group(0) if match else "Unknown"


def first_author(ai: dict[str, Any]) -> str:
    authors = ai.get("authors") or []
    if isinstance(authors, str):
        authors = re.split(r"[;,；，]", authors)
    if authors:
        name = str(authors[0]).strip()
    else:
        name = "Unknown"
    name = re.sub(r"\bet\s+al\.?$|等$", "", name, flags=re.I).strip()
    if "," in name:
        name = name.split(",", 1)[0]
    return clean_piece(name, 32)


def make_pdf_name(ai: dict[str, Any], settings: dict[str, Any]) -> str:
    year = clean_piece(str(ai.get("year") or "Unknown"), 16)
    author = first_author(ai)
    short_title = ai.get("short_title") or ai.get("title") or "Untitled"
    short_title = clean_piece(str(short_title), int(settings["rename"].get("max_short_title_chars", 72)))
    return f"{year}_{author}_{short_title}.pdf"


def make_note_name(pdf_name: str) -> str:
    return f"{Path(pdf_name).stem}.md"


def extract_manual_note(existing_note: Path) -> str:
    text = read_text_if_exists(existing_note)
    if MANUAL_NOTE_START in text and MANUAL_NOTE_END in text:
        return text.split(MANUAL_NOTE_START, 1)[1].split(MANUAL_NOTE_END, 1)[0].strip()
    marker = "# 我的人工笔记"
    if marker not in text:
        return ""
    return text.split(marker, 1)[1].strip()


def yaml_list(values: Any) -> str:
    if not values:
        return "[]"
    if isinstance(values, str):
        values = [v.strip() for v in re.split(r"[;；,，]", values) if v.strip()]
    return "[" + ", ".join(json.dumps(str(v), ensure_ascii=False) for v in values) + "]"


def read_note_template() -> str:
    path = ROOT / "prompts" / "note_template.md"
    template = read_text_if_exists(path).strip()
    return template or DEFAULT_NOTE_TEMPLATE


def render_note(ai: dict[str, Any], row: dict[str, str], pdf_rel: str, manual_note: str) -> str:
    findings = ai.get("main_findings") or []
    concepts = ai.get("key_concepts") or []
    quotable = ai.get("quotable_points") or []
    limitations = ai.get("limitations") or []

    def bullets(values: Any) -> str:
        if not values:
            return "- 未识别"
        lines = []
        for item in values:
            if isinstance(item, dict):
                text = "；".join(f"{k}: {v}" for k, v in item.items() if v)
            else:
                text = str(item)
            lines.append(f"- {text}")
        return "\n".join(lines)

    pdf_file = Path(pdf_rel).name
    manual = f"{MANUAL_NOTE_START}\n{manual_note.strip()}\n{MANUAL_NOTE_END}"
    values = {
        "paper_id": row.get("paper_id", ""),
        "title": row.get("标题", ""),
        "english_title": row.get("英文标题", ""),
        "chinese_title": row.get("中文标题", ""),
        "authors": row.get("作者", ""),
        "year": row.get("年份", ""),
        "venue": row.get("期刊会议", ""),
        "doi": row.get("DOI", "") or "未识别",
        "pdf_file": pdf_file,
        "pdf_path": pdf_rel,
        "pdf_markdown_link": f"[{pdf_file}]({pdf_rel})",
        "one_sentence_summary": ai.get("one_sentence_summary") or "未识别",
        "research_question": ai.get("research_question") or "未识别",
        "methods_and_data": ai.get("methods_and_data") or "未识别",
        "main_findings": bullets(findings),
        "key_concepts": bullets(concepts),
        "quotable_points": bullets(quotable),
        "limitations": bullets(limitations),
        "relation_to_my_research": ai.get("relation_to_my_research") or "待人工判断",
        "ai_primary_category": row.get("一级分类_AI建议", ""),
        "ai_secondary_categories": row.get("二级分类_AI建议", ""),
        "manual_categories": row.get("人工分类", ""),
        "final_categories": row.get("最终分类", ""),
        "status": row.get("阅读状态", ""),
        "importance": row.get("重要性", ""),
        "journal_flags": row.get("期刊标签", ""),
        "tracking_star": row.get("星标", ""),
        "tracking_area": row.get("追踪期刊领域", ""),
        "classification_reason": ai.get("classification_reason") or "未识别",
        "confidence": ai.get("confidence", ""),
        "manual_note": manual,
    }
    template = read_note_template()
    if "{manual_note}" not in template:
        template = template.rstrip() + "\n\n# 我的人工笔记\n\n{manual_note}\n"
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{" + key + "}", str(value))
    return rendered.rstrip() + "\n"


def row_from_ai(
    ai: dict[str, Any],
    file_hash: str,
    source_path: Path,
    pdf_path: Path,
    note_path: Path,
    settings: dict[str, Any],
    existing: dict[str, str] | None = None,
) -> dict[str, str]:
    existing = existing or {}
    preserve = set(settings["index"].get("preserve_manual_fields", []))
    title = str(ai.get("title") or pdf_path.stem)
    authors = ai.get("authors") or []
    if isinstance(authors, list):
        author_text = "；".join(str(a) for a in authors if a)
    else:
        author_text = str(authors)
    year = str(ai.get("year") or guess_year(pdf_path.name))
    paper_id = pdf_path.stem

    row = {field: existing.get(field, "") for field in INDEX_FIELDS}
    updates = {
        "paper_id": paper_id,
        "标题": title,
        "英文标题": existing.get("英文标题") or title,
        "中文标题": existing.get("中文标题", ""),
        "作者": author_text,
        "年份": year,
        "期刊会议": str(ai.get("venue") or ""),
        "扫描件": existing.get("扫描件") or str(ai.get("_scan_status") or ""),
        "DOI": str(ai.get("doi") or ""),
        "AI一句话总结": str(ai.get("one_sentence_summary") or ""),
        "一级分类_AI建议": normalize_primary_category(str(ai.get("ai_primary_category") or "待分类"), settings),
        "二级分类_AI建议": normalize_secondary_categories(ai.get("ai_secondary_categories"), settings),
        "一级分类": existing.get("一级分类", ""),
        "二级分类": existing.get("二级分类", ""),
        "关键词": list_to_text(ai.get("ai_keywords")),
        "研究方法": list_to_text(ai.get("method_tags")),
        "研究对象": str(ai.get("research_object") or ""),
        "与我的论文关系": str(ai.get("relation_to_my_research") or ""),
        "阅读状态": existing.get("阅读状态") or "AI初整",
        "PDF路径": rel(pdf_path),
        "笔记路径": rel(note_path),
        "原始路径": rel(source_path),
        "文件哈希": file_hash,
        "整理时间": now_text(),
        "AI模型": settings["api"]["model"],
        "AI置信度": str(ai.get("confidence", "")),
    }
    for key, value in updates.items():
        if key in preserve and existing.get(key):
            continue
        row[key] = value
    for key in preserve:
        if existing.get(key):
            row[key] = existing[key]
    return row


def normalize_primary_category(value: str, settings: dict[str, Any]) -> str:
    value = value.strip()
    categories = list(settings["classification"]["primary_categories"].keys())
    if value in categories:
        return value
    for category in categories:
        code = category.split(" ", 1)[0]
        if value == code or value.startswith(code):
            return category
    return value or "待分类"


def normalize_secondary_categories(value: Any, settings: dict[str, Any]) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        parts = [v.strip() for v in re.split(r"[;；,，]", value) if v.strip()]
    elif isinstance(value, list):
        parts = [str(v).strip() for v in value if str(v).strip()]
    else:
        parts = [str(value).strip()]

    primary_categories = list(settings["classification"]["primary_categories"].keys())
    primary_codes = {category.split(" ", 1)[0] for category in primary_categories}
    cleaned: list[str] = []
    for part in parts:
        if part in primary_categories:
            continue
        if part in primary_codes:
            continue
        if any(part.startswith(code + " ") for code in primary_codes):
            continue
        if part not in cleaned:
            cleaned.append(part)
    return "；".join(cleaned)


def delete_duplicate_from_inbox(source_path: Path, inbox: Path) -> None:
    try:
        source_path.resolve().relative_to(inbox.resolve())
    except ValueError:
        return
    source_path.unlink(missing_ok=True)


def import_pdf(
    source_path: Path,
    ai: dict[str, Any],
    settings: dict[str, Any],
    action: str,
    existing_pdf: str = "",
) -> Path:
    pdf_dir = project_path(settings["paths"]["library_pdfs"])
    pdf_dir.mkdir(parents=True, exist_ok=True)
    if existing_pdf:
        existing_path = project_path(existing_pdf)
        if existing_path.exists():
            return existing_path

    desired = pdf_dir / make_pdf_name(ai, settings)
    target = unique_path(desired)
    if action == "move":
        shutil.move(str(source_path), str(target))
    else:
        shutil.copy2(str(source_path), str(target))
    return target


def load_or_generate_ai(
    source_path: Path,
    file_hash: str,
    settings: dict[str, Any],
    note_prompt: str,
    classify_prompt: str,
    force_ai: bool,
    no_ai: bool,
) -> dict[str, Any]:
    cache_dir = project_path(settings["paths"]["cache_dir"])
    text_dir = project_path(settings["paths"]["text_dir"])
    cache_dir.mkdir(parents=True, exist_ok=True)
    text_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{file_hash}.json"
    text_path = text_dir / f"{file_hash}.txt"

    if cache_path.exists() and not force_ai:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        # Defensive: caches from before the silent-failure fix can contain
        # placeholder data with _error set. Don't return those — fall through
        # to a fresh AI call.
        if not cached.get("_error"):
            return cached

    text, pdf_meta = extract_pdf_text(source_path, settings, file_hash=file_hash)
    atomic_write_text(text_path, text)
    if no_ai:
        ai = fallback_ai(source_path, pdf_meta, "本次使用 --no-ai，未调用模型。")
        ai["_pdf_meta"] = pdf_meta
        ai["_scan_status"] = pdf_meta.get("pdf_scan_status", "")
        atomic_write_text(cache_path, json.dumps(ai, ensure_ascii=False, indent=2))
        return ai
    try:
        ai = call_ai(text, pdf_meta, source_path, settings, note_prompt, classify_prompt)
    except Exception as exc:
        # IMPORTANT: do NOT silently fall back to placeholder data and cache it.
        # The previous behavior caused 帮我阅读 to claim success while writing
        # 「待 AI 整理」placeholders to the user's note + poisoning the cache.
        # In batch mode (`organize.py`), the CLI is the caller — it catches this
        # and prints a per-file error so the batch keeps going. In single-paper
        # endpoints (api_help_read_paper, api_reprocess_paper), this raise
        # propagates back up and the API returns ok:false with the real error.
        if force_ai:
            raise RuntimeError(f"AI 调用失败：{exc}") from exc
        # Non-force batch mode: tolerate the failure with a placeholder, but
        # mark _error so callers that want to can detect it. Don't poison the
        # cache — write the placeholder for THIS run only, don't persist.
        ai = fallback_ai(source_path, pdf_meta, f"AI 调用失败：{exc}")
        ai["_error"] = str(exc)
        ai["_pdf_meta"] = pdf_meta
        ai["_scan_status"] = pdf_meta.get("pdf_scan_status", "")
        return ai
    ai["_pdf_meta"] = pdf_meta
    ai["_scan_status"] = pdf_meta.get("pdf_scan_status", "")
    atomic_write_text(cache_path, json.dumps(ai, ensure_ascii=False, indent=2))
    return ai


def generate_collections(rows: list[dict[str, str]], settings: dict[str, Any]) -> None:
    out_dir = project_path(settings["paths"]["collections_dir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    by_category: dict[str, list[dict[str, str]]] = {}
    for row in rows:
        categories: list[str] = []
        for field in ["最终分类", "一级分类", "二级分类", "人工分类", "一级分类_AI建议", "二级分类_AI建议"]:
            value = row.get(field, "")
            if value:
                # Only split on `；` / `;`; commas are legitimate inside
                # category names (e.g. "Mapping ... A Structural, Temporal, ...").
                categories.extend([v.strip() for v in re.split(r"[;；]", value) if v.strip()])
        for category in sorted(set(categories)):
            by_category.setdefault(category, []).append(row)

    for old in out_dir.glob("*.md"):
        old.unlink()

    overview_lines = ["# 分类索引", ""]
    for category, items in sorted(by_category.items(), key=lambda kv: kv[0]):
        file_name = clean_piece(category, 80) + ".md"
        overview_lines.append(f"- [{category}]({file_name})：{len(items)} 篇")
        lines = [f"# {category}", ""]
        for row in sort_rows(items):
            note = row.get("笔记路径", "")
            pdf = row.get("PDF路径", "")
            title = row.get("标题") or row.get("paper_id")
            year = row.get("年份", "")
            authors = row.get("作者", "")
            summary = row.get("AI一句话总结", "")
            note_link = f"[笔记](../../{note})" if note else "笔记"
            pdf_link = f"[PDF](../../{pdf})" if pdf else "PDF"
            lines.append(f"- {year} {authors}：{title}。{note_link} / {pdf_link}")
            if summary:
                lines.append(f"  - {summary}")
        atomic_write_text(out_dir / file_name, "\n".join(lines) + "\n")
    atomic_write_text(out_dir / "_全部分类.md", "\n".join(overview_lines) + "\n")


def persist_csv_state(rows_by_hash: dict[str, dict[str, str]], row_order: list[str], settings: dict[str, Any]) -> None:
    index_csv = project_path(settings["index"]["csv"])
    rows = [rows_by_hash[h] for h in row_order if h in rows_by_hash]
    write_csv(index_csv, sort_rows(rows))


def source_action(source_path: Path, settings: dict[str, Any], forced: str | None) -> str:
    if forced:
        return forced
    inbox = project_path(settings["paths"]["inbox"]).resolve()
    try:
        source_path.resolve().relative_to(inbox)
        return "move"
    except ValueError:
        return "copy"


def main() -> None:
    parser = argparse.ArgumentParser(description="整理 PDF 文献，生成 Markdown 笔记和索引表。")
    parser.add_argument("--source", action="append", help="额外指定 PDF 或文件夹来源，可重复。")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 篇，用于测试。")
    parser.add_argument("--force-ai", action="store_true", help="忽略缓存，重新调用 AI。")
    parser.add_argument("--no-ai", action="store_true", help="不调用 AI，只建立占位索引。")
    parser.add_argument("--move", action="store_true", help="把来源 PDF 移入库。")
    parser.add_argument("--copy", action="store_true", help="把来源 PDF 复制入库。")
    args = parser.parse_args()

    # First-run bootstrap (same as server.py)
    from common import bootstrap_project
    boot = bootstrap_project()
    if boot["copied"]:
        print("[bootstrap] Copied template files:", boot["copied"])
        print("[bootstrap] Edit .env with your API keys and re-run.")

    load_env()
    settings = load_settings()
    provider = str(settings.get("api", {}).get("provider", ""))
    model = str(settings.get("api", {}).get("model", ""))
    if provider in {"codex", "codex_cli", "codex-cli"}:
        model = str(settings.get("codex_cli", {}).get("model") or "gpt-5.4")
    elif provider in {"claude", "claude_cli", "claude-cli"}:
        model = str(settings.get("claude_cli", {}).get("model") or "claude-sonnet-4-5")
    print(f"模型：{provider} / {model}", flush=True)
    tracking_entries = load_tracking_journals(settings)
    note_prompt = read_text_if_exists(ROOT / "prompts" / "note_prompt.md")
    classify_prompt = read_text_if_exists(ROOT / "prompts" / "classify_prompt.md")

    sources = [project_path(settings["paths"]["inbox"])]
    sources.extend(project_path(p) for p in settings["paths"].get("initial_sources", []))
    if args.source:
        sources.extend(project_path(p) for p in args.source)

    index_csv = project_path(settings["index"]["csv"])
    index_xlsx = project_path(settings["index"]["xlsx"])
    rows = read_csv(index_csv)
    tracking_summary = apply_tracking_journals(rows, settings)
    rows_by_hash = {row["文件哈希"]: row for row in rows if row.get("文件哈希")}
    row_order = [row["文件哈希"] for row in rows if row.get("文件哈希")]

    pdfs = collect_pdfs(sources, project_path(settings["paths"]["library_pdfs"]))
    if args.limit:
        pdfs = pdfs[: args.limit]
    if not pdfs:
        if tracking_summary["changed"]:
            rows = sort_rows(rows)
            write_csv(index_csv, rows)
            write_xlsx(index_xlsx, rows)
            generate_collections(rows, settings)
            print(f"已根据 list.xlsx 更新追踪期刊星标：{tracking_summary['starred']} 篇。", flush=True)
        print("没有发现待整理 PDF。", flush=True)
        return

    print(f"发现 {len(pdfs)} 个 PDF，开始整理。", flush=True)
    seen_hashes: set[str] = set()
    for idx, pdf in enumerate(pdfs, start=1):
        print(f"[{idx}/{len(pdfs)}] {pdf}", flush=True)
        file_hash = sha256_file(pdf)
        if file_hash in seen_hashes:
            delete_duplicate_from_inbox(pdf, project_path(settings["paths"]["inbox"]))
            print("  本轮重复文件，已删除 inbox 中的重复副本。", flush=True)
            continue
        seen_hashes.add(file_hash)

        existing = rows_by_hash.get(file_hash)
        if existing and existing.get("PDF路径") and project_path(existing["PDF路径"]).exists() and not args.force_ai:
            cache_path = project_path(settings["paths"]["cache_dir"]) / f"{file_hash}.json"
            if cache_path.exists():
                ai = json.loads(cache_path.read_text(encoding="utf-8"))
                pdf_path = project_path(existing["PDF路径"])
                note_path = project_path(existing["笔记路径"]) if existing.get("笔记路径") else project_path(settings["paths"]["library_notes"]) / make_note_name(pdf_path.name)
                manual_note = extract_manual_note(note_path)
                row = row_from_ai(ai, file_hash, pdf, pdf_path, note_path, settings, existing=existing)
                apply_tracking_journal(row, tracking_entries)
                atomic_write_text(note_path, render_note(ai, row, "../pdfs/" + pdf_path.name, manual_note))
                rows_by_hash[file_hash] = row
                if file_hash not in row_order:
                    row_order.append(file_hash)
                persist_csv_state(rows_by_hash, row_order, settings)
                print("  已入库，刷新索引；未调用 AI。", flush=True)
            else:
                print("  已入库，跳过 AI 调用。", flush=True)
            delete_duplicate_from_inbox(pdf, project_path(settings["paths"]["inbox"]))
            continue

        ai = load_or_generate_ai(
            source_path=pdf,
            file_hash=file_hash,
            settings=settings,
            note_prompt=note_prompt,
            classify_prompt=classify_prompt,
            force_ai=args.force_ai,
            no_ai=args.no_ai,
        )

        forced_action = "move" if args.move else "copy" if args.copy else None
        action = source_action(pdf, settings, forced_action)
        pdf_path = import_pdf(pdf, ai, settings, action=action, existing_pdf=existing.get("PDF路径", "") if existing else "")
        note_path = project_path(settings["paths"]["library_notes"]) / make_note_name(pdf_path.name)
        manual_note = extract_manual_note(note_path)
        pdf_rel_from_note = "../pdfs/" + pdf_path.name
        row = row_from_ai(ai, file_hash, pdf, pdf_path, note_path, settings, existing=existing)
        apply_tracking_journal(row, tracking_entries)
        atomic_write_text(note_path, render_note(ai, row, pdf_rel_from_note, manual_note))
        rows_by_hash[file_hash] = row
        if file_hash not in row_order:
            row_order.append(file_hash)
        persist_csv_state(rows_by_hash, row_order, settings)

        if ai.get("_error"):
            print(f"  AI 整理失败，已建立占位记录：{ai['_error']}", flush=True)
        else:
            print(f"  已整理：{row['paper_id']}", flush=True)

    rows = [rows_by_hash[h] for h in row_order if h in rows_by_hash]
    apply_tracking_journals(rows, settings)
    rows = sort_rows(rows)
    write_csv(index_csv, rows)
    write_xlsx(index_xlsx, rows)
    generate_collections(rows, settings)
    print(f"完成：{len(rows)} 条记录。", flush=True)
    print(f"总表：{rel(index_csv)}", flush=True)
    print(f"Excel：{rel(index_xlsx)}", flush=True)
    print(f"分类索引：{settings['paths']['collections_dir']}/_全部分类.md", flush=True)


if __name__ == "__main__":
    main()
