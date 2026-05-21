"""Citation files: per-writing-task markdown files with a parsable header
(writing context) + an entries section (manually edited + AI-appended).

Layout on disk:
  citations/
    my_review_article.md
    dissertation_chapter_2.md
    grant_background.md
    ...

Each file is structured as:

    # Citation: {display_name}

    <!-- WRITING_CONTEXT_START -->
    [user-editable context: writing topic, scope, key claims, theoretical frame]
    <!-- WRITING_CONTEXT_END -->

    ## 引用记录

    [auto-appended entries below]

The `WRITING_CONTEXT_START/END` markers are parsed by `read_context()` and
sent to the LLM as the situational context for "帮我引用" prompts.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import ROOT  # noqa: E402


CITATIONS_DIR = ROOT / "citations"

# Block markers (do not change without migrating existing files)
_CTX_START = "<!-- WRITING_CONTEXT_START -->"
_CTX_END = "<!-- WRITING_CONTEXT_END -->"
_ENTRIES_HEADING = "## 引用记录"

DEFAULT_TEMPLATE = """# Citation: {display_name}

<!-- WRITING_CONTEXT_START -->
> 这块是写作上下文。"帮我引用"功能会读取这里的内容作为 AI 生成引用建议时的语境。
> 用 Markdown 自由编辑。建议至少填写下面几项。

- **中心主题**：（这份 citation 服务的具体研究问题或论文中心论点）
- **内容范围 / 边界**：（哪些主题属于、哪些不属于）
- **预期写作章节**：（例如 Introduction / Literature Review §X / Methodology / Discussion）
- **关键论点 / 立场**：（你已经形成的判断，或还在论证中的观点）
- **理论框架 / 核心概念**：（要用到的关键概念、传统、学派）
- **目标期刊 / 风格**：（影响引用句风格：综合期刊 vs 专科 vs 综述）
- **不要的引用类型**：（明确排除的角度，避免 AI 给出无关引用）

<!-- WRITING_CONTEXT_END -->

## 引用记录

<!-- 下面的条目由"帮我引用"功能追加，每条对应一篇文献。手动编辑、删除、移动都可以。 -->

"""


# ---- name safety ----

_NAME_SAFE = re.compile(r"[^\w一-鿿\-]+", re.UNICODE)


def safe_name(name: str) -> str:
    name = (name or "").strip()
    cleaned = _NAME_SAFE.sub("_", name)
    cleaned = re.sub(r"_+", "_", cleaned).strip("_-")
    return cleaned[:64] or "untitled"


def ensure_dir() -> Path:
    CITATIONS_DIR.mkdir(parents=True, exist_ok=True)
    return CITATIONS_DIR


# ---- parsing ----

@dataclass
class CitationFile:
    name: str        # safe file basename without .md
    path: Path
    display_name: str
    context: str     # body between markers
    entries_text: str  # body after "## 引用记录"
    raw: str

    def entry_count(self) -> int:
        return sum(1 for line in self.entries_text.splitlines() if line.startswith("### "))

    def to_payload(self) -> dict[str, Any]:
        stat = self.path.stat() if self.path.exists() else None
        return {
            "name": self.name,
            "display_name": self.display_name,
            "path": str(self.path.relative_to(ROOT)).replace("\\", "/"),
            "entry_count": self.entry_count(),
            "context_chars": len(self.context.strip()),
            "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds") if stat else "",
        }


def parse(raw: str, name: str, path: Path) -> CitationFile:
    """Parse raw markdown into a CitationFile."""
    # display name from H1
    display = name
    m = re.search(r"^# (?:Citation:\s*)?(.+?)\s*$", raw, flags=re.MULTILINE)
    if m:
        display = m.group(1).strip()
    # writing context block
    context = ""
    if _CTX_START in raw and _CTX_END in raw:
        context = raw.split(_CTX_START, 1)[1].split(_CTX_END, 1)[0].strip()
    # entries text after "## 引用记录"
    entries_text = ""
    if _ENTRIES_HEADING in raw:
        entries_text = raw.split(_ENTRIES_HEADING, 1)[1].lstrip("\n").rstrip() + "\n"
    return CitationFile(
        name=name,
        path=path,
        display_name=display,
        context=context,
        entries_text=entries_text,
        raw=raw,
    )


def load(name: str) -> CitationFile:
    safe = safe_name(name)
    path = CITATIONS_DIR / f"{safe}.md"
    if not path.exists():
        raise FileNotFoundError(f"citation '{safe}' not found")
    raw = path.read_text(encoding="utf-8")
    return parse(raw, safe, path)


def list_all() -> list[CitationFile]:
    ensure_dir()
    out: list[CitationFile] = []
    for p in sorted(CITATIONS_DIR.glob("*.md")):
        try:
            raw = p.read_text(encoding="utf-8")
            out.append(parse(raw, p.stem, p))
        except Exception:
            continue
    return out


# ---- write ----

def create(name: str, display_name: str = "") -> CitationFile:
    ensure_dir()
    safe = safe_name(name)
    path = CITATIONS_DIR / f"{safe}.md"
    if path.exists():
        raise ValueError(f"citation '{safe}' already exists")
    content = DEFAULT_TEMPLATE.format(display_name=(display_name.strip() or safe))
    from common import atomic_write_text
    atomic_write_text(path, content)
    return parse(content, safe, path)


def delete(name: str) -> bool:
    safe = safe_name(name)
    path = CITATIONS_DIR / f"{safe}.md"
    if not path.exists():
        return False
    path.unlink()
    return True


def write_raw(name: str, raw: str) -> CitationFile:
    """Persist the full citation file. Used by the in-app editor."""
    ensure_dir()
    safe = safe_name(name)
    path = CITATIONS_DIR / f"{safe}.md"
    from common import atomic_write_text
    atomic_write_text(path, raw)
    return parse(raw, safe, path)


def append_entry(name: str, entry_markdown: str) -> CitationFile:
    """Append an entry to the citation's '引用记录' section, separated by a blank line."""
    cf = load(name)
    entry = entry_markdown.rstrip() + "\n"
    new_raw = cf.raw.rstrip() + "\n\n" + entry
    return write_raw(name, new_raw)


# ---- help-cite prompt builder ----

def build_help_cite_prompt(
    citation: CitationFile,
    paper_row: dict[str, str],
    pdf_text: str,
    note_text: str,
) -> tuple[str, str]:
    """Return (system_prompt, user_prompt) for the help-cite LLM call.

    The LLM should output a single Markdown entry that we will append to
    the citation file's '引用记录' section.
    """
    system = (
        "你是学术写作引用助手。我会给你两样东西：(1) 我正在撰写的一个 citation 的"
        "写作上下文（目标主题、章节、立场、理论框架等），(2) 一篇相关文献的笔记和正文"
        "节选。你的任务是：判断这篇文献能为这个 citation 的写作贡献什么，并按"
        "固定格式输出一条 Markdown 条目。\n\n"
        "重要规则：\n"
        "1. 严格围绕 citation 的写作上下文判断。不要泛泛说这篇文献的总体意义。\n"
        "2. 如果完全不相关，输出相关性=不相关并简短说明原因。\n"
        "3. 引用句草稿优先用目标语种（看 citation 上下文里的『目标期刊』或语言提示）。\n"
        "4. 不要编造文献中没有的内容。\n"
        "5. 只输出一个 Markdown 条目，不要别的解释或前言。\n\n"
        "输出格式：\n\n"
        "### {paper_id}（{年份} {第一作者英文姓}，{简短标题}）\n\n"
        "- **可引用观点**：（1-2 句具体观点，紧扣 citation 主题）\n"
        "- **建议章节**：（Introduction / Literature Review §X / Methodology / Discussion / Limitations 等）\n"
        "- **引用方式**：（paraphrase 改写 / direct quote 直引 / methodological reference 方法借鉴 / data reference 数据对照 / counter-example 反例）\n"
        "- **引用句草稿**：（一句目标语言的引用句，含 in-text citation 格式）\n"
        "- **相关性**：强 / 中 / 弱 / 不相关\n"
    )
    paper_brief = {
        "paper_id": paper_row.get("paper_id", ""),
        "title": paper_row.get("英文标题") or paper_row.get("标题", ""),
        "中文标题": paper_row.get("中文标题", ""),
        "作者": paper_row.get("作者", ""),
        "年份": paper_row.get("年份", ""),
        "期刊会议": paper_row.get("期刊会议", ""),
        "DOI": paper_row.get("DOI", ""),
        "AI一句话总结": paper_row.get("AI一句话总结", ""),
        "关键词": paper_row.get("关键词", ""),
        "研究方法": paper_row.get("研究方法", ""),
        "研究对象": paper_row.get("研究对象", ""),
    }
    import json
    user = (
        "【citation 写作上下文】\n"
        f"{citation.display_name}\n\n"
        f"{citation.context.strip() or '（未填写）'}\n\n"
        "【文献基本信息】\n"
        f"{json.dumps(paper_brief, ensure_ascii=False, indent=2)}\n\n"
        "【现有笔记节选】\n"
        f"{note_text[:6000]}\n\n"
        "【PDF 提取文本（节选）】\n"
        f"{pdf_text[:14000]}\n"
    )
    return system, user
