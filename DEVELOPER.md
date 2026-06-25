# DEVELOPER.md · 文献工作台架构与维护指南

> 这份文档同时服务两类读者：
> 1. **未来的我（或换电脑后的我）** —— 拿到 fresh checkout，对着这份文档就能恢复对系统的全部认知。
> 2. **AI 编程助手（Claude / Codex / 等）** —— 在做任何修改前先读这份文档，理解约束，然后按文末「修改时的同步清单」走。

仓库是**双用途**的：
- 本地工作目录跑真实数据 ——「**个人系统**」。
- 这同一个目录提交到 GitHub 后就是「**公开模板**」，别人 `git clone` 后能上手用 —— 通过 `.gitignore` 隔离一切个人数据。

---

## 1. 系统概览

**做什么**：本地 PDF 文献整理 + 阅读 + AI 笔记 + 写作助手。无云依赖、所有数据本地，可在云盘里同步。

**技术栈**：
- 后端：Python 3 stdlib `http.server.ThreadingHTTPServer`（无 Flask / FastAPI）
- 前端：原生 ES module，无构建步骤。PDF 渲染走浏览器内置阅读器（iframe）。
- 数据：CSV / XLSX（papers 总索引）+ Markdown（笔记）+ YAML（配置）+ JSON（便签、AI 缓存、进度追踪）
- AI Provider：可切换 DeepSeek / Qwen / OpenAI 兼容 / 本机 Codex CLI；翻译走本地 Ollama 或 OpenAI 兼容 API
- 期刊等级：EasyScholar API（带磁盘缓存）

**启动入口**：
- macOS：`打开文献工作台.command` → `python3 scripts/server.py` → 自动打开浏览器
- Windows：`打开文献工作台.bat`
- 服务监听 `127.0.0.1:8765`，默认浏览器关闭 60s 后自动退出（心跳机制，见 §6.2）

---

## 2. 目录结构

```
.
├── DEVELOPER.md                   # 本文件
├── README.md                      # 公开版用户指南
├── requirements.txt               # pip deps
├── .env.example                   # API key 模板（实际 .env 被 gitignore）
├── .gitignore
├── docs/                          # 历史交付说明 / 开发笔记（不影响运行）
│
├── config/
│   ├── settings.yaml              # 实际配置（gitignored）
│   └── settings.example.yaml      # 模板（committed）
│
├── prompts/                       # AI 提示词 + 笔记模板
│   ├── note_prompt.md
│   ├── classify_prompt.md
│   └── note_template.md
│
├── scripts/                       # Python 后端
│   ├── server.py                  # 主服务（路由 + API）
│   ├── organize.py                # inbox 整理 + AI 笔记生成
│   ├── annotations.py             # 便签 CRUD（JSON 旁车存储）
│   ├── citations.py               # citation 文件 CRUD + 「帮我引用」
│   ├── easyscholar.py             # EasyScholar API + 字段映射
│   ├── export_by_category.py      # 按分类批量导出（CLI + library 双入口）
│   ├── common.py                  # 共享：INDEX_FIELDS / IO / 排序 / 期刊匹配
│   ├── import_sources_to_inbox.py # Zotero / 坚果云 → inbox 批量导入
│   └── zotero_import.py           # Zotero 本地数据库只读导入（元数据 / PDF / 笔记 / 批注）
│
├── web/                           # 浏览器前端
│   ├── index.html
│   ├── app.js                     # 状态机 + 所有交互
│   ├── pdf_viewer.js              # 极简 iframe 包装（API 兼容旧版 PDF.js）
│   ├── styles.css
│   ├── styles-features.css        # 增强功能样式
│   ├── styles-design.css          # 视觉打磨样式
│   ├── app-phase*.js              # 渐进增强功能模块（index.html 直接加载）
│   ├── app-design-*.js            # 视觉 / 交互增强模块（index.html 直接加载）
│   └── vendor/pdfjs/              # 历史 PDF.js 包，已 gitignore（当前 pdf_viewer.js 用 iframe；想切回需手动下载 PDF.js 解压到这里）
│
├── inbox/                         # 待整理 PDF 投递（个人数据，gitignored）
├── library/
│   ├── pdfs/                      # PDF 主库 (gitignored)
│   ├── notes/                     # 每篇 .md 笔记 (gitignored)
│   ├── text/                      # PDF 文本缓存 (gitignored)
│   ├── cache/                     # AI / EasyScholar 缓存 (gitignored)
│   ├── stickies/                  # 便签 JSON 旁车 (gitignored)
│   ├── chat_history/              # AI 问答历史迁移源 (gitignored)
│   ├── annotations/               # 历史注释数据占位 / 迁移残留 (gitignored)
│   └── index/                     # papers.csv / papers.xlsx / 进度 JSON (gitignored)
│
├── citations/                     # 写作助手核心：每篇论文一个 .md
│   ├── M1_open_science_policy.md  # ← 用户私有内容，gitignored
│   ├── ...
│   └── (template 在 citations.py:DEFAULT_CITATION_TEMPLATE 里)
│
├── collections/by_category/       # 按分类生成的索引页（gitignored，由 organize.py 重生成）
├── exports/                       # 按分类导出的临时材料包（gitignored）
│
├── list.xlsx                      # FT50/UTD24/ABS3-4 期刊追踪（gitignored；ship list.example.xlsx）
│
├── 打开文献工作台.command / .bat   # macOS / Windows 启动器
├── 整理新文献.command / .bat       # 命令行触发 organize
└── 按分类导出.command / .bat       # 命令行触发 export_by_category
```

---

## 3. 关键数据 schema

### 3.1 `library/index/papers.csv` 总索引

`INDEX_FIELDS` 在 `scripts/common.py` 顶部定义，**任何新增 / 重命名字段都要改这里 + 同步迁移现有 CSV**。当前字段（顺序敏感，写 CSV 时会按此顺序）：

```
paper_id, 标题, 英文标题, 中文标题, 作者, 年份, 期刊会议,
期刊分区, SSCI, SCI, UTD, FT50, ABS, 星标, 追踪期刊领域, 扫描件, DOI,
ZoteroKey, Zotero库, Zotero集合, Zotero标签, Zotero版本,
AI一句话总结, 一级分类_AI建议, 二级分类_AI建议,
一级分类, 二级分类, 三级分类, 人工分类, 最终分类,
关键词, 研究方法, 研究对象, 与我的论文关系,
期刊等级_自动, 期刊等级_人工,
重要性, 阅读状态,
PDF路径, 笔记路径, 原始路径, 文件哈希, 整理时间, AI模型, AI置信度,
我的备注
```

**多值字段**（用 `；` 分隔，前端 split / join 时用 `splitValues` / `joinUnique`）：
- `一级分类` / `二级分类` / `三级分类` / `最终分类` / `期刊等级_自动` / `期刊等级_人工`

**人工字段**（在 `config/settings.yaml:index.preserve_manual_fields`，重整时不会被 AI 覆盖）：
- `一级分类`, `二级分类`, `三级分类`, `人工分类`, `最终分类`, `重要性`, `阅读状态`, `我的备注`, `期刊等级_人工`

**自动 vs 人工双字段约定**：
- `期刊等级_自动`：只能由 `/api/easyscholar/refresh` 写入（`api_save_paper` 的 `allowed` 集合**显式拒绝**前端写它）
- `期刊等级_人工`：用户自由填，永远不被自动刷新覆盖
- 显示规则：`人工 || 自动`

**跨平台路径约定**：
- CSV 里的 `PDF路径` / `笔记路径` / `原始路径` 统一保存为 `/` 分隔的相对路径，如 `library/pdfs/foo.pdf`。
- Windows 的 Python 也能读取 `/`，所以不要按平台写成两套格式。
- `common.project_path()` 会兼容旧 Windows 反斜杠路径（`library\pdfs\foo.pdf`），先转换再查文件；`common.rel()` 写回时统一用 `/`。
- `/file?path=...` 返回给前端的 URL 也统一用 `/` 并做 URL encoding，避免 macOS 下把 `\` 当普通字符导致 PDF 显示 `file not found`。

### 3.2 `config/settings.yaml`

```yaml
project: { name, language }
paths: { inbox, library_pdfs, library_notes, index_dir, cache_dir, text_dir, collections_dir }
zotero: { data_dir }
api: { provider, base_url, model, api_key_env, temperature, max_tokens, timeout_seconds, thinking }
codex_cli: { command, model, sandbox, timeout_seconds }
easyscholar:
  enabled: bool
  api_key_env: str
  enabled_fields: [sciUp, sci, ssci, ahci, eii, esi, fms, utd24, ajg, cssci, ...]
translation:
  provider: ollama | openai_compatible
  ollama: { base_url, model, timeout_seconds }
  openai_compatible: { base_url, model, api_key_env, timeout_seconds }
pdf: { quick_first_pages, quick_last_pages, max_input_chars, image_dpi, max_image_pages }
tracking_journals: { path, sheet }
rename: { pattern, max_short_title_chars }
index:
  csv: library/index/papers.csv
  xlsx: library/index/papers.xlsx
  preserve_manual_fields: [...]
classification:
  custom_categories: []
  primary_categories:
    # 3 级嵌套结构。第二级是 dict (sec -> [tert,...])，第一级是 dict (primary -> {sec: [tert,...]})。
    # 兼容旧的 list 格式（仅二级，无三级）—— normalize_category_tree 自动迁移。
    C01 名称:
      二级A: [三级A1, 三级A2]
      二级B: []
provider_settings: { deepseek: {...}, qwen: {...}, openai_compatible: {...} }
```

### 3.3 `library/stickies/{paper_id}.json` 便签

```json
{
  "paper_id": "2024_Smith_Title",
  "stickies": [
    {
      "id": "20260514T143000-ab12cd",
      "content": "便签正文（Markdown）",
      "created_at": "2026-05-14T14:30:00Z",
      "updated_at": "2026-05-14T14:30:00Z"
    }
  ]
}
```

由 `scripts/annotations.py` 管理。删除文献时 `api_delete_paper` 会调 `delete_all_for_paper` 清理对应 JSON。

### 3.4 `citations/<name>.md` 写作上下文 + 引用记录

```markdown
# Citation: <display name>

<!-- WRITING_CONTEXT_START -->
> 这块是写作上下文。"帮我引用"功能会读取这里。
- 中心主题：...
- 内容范围 / 边界：...
- 预期写作章节：...
- 关键论点 / 立场：...
- 理论框架 / 核心概念：...
- 目标期刊 / 风格：...
- 不要的引用类型：...
<!-- WRITING_CONTEXT_END -->

## 引用记录

<!-- 由"帮我引用"功能追加，每条对应一篇文献 -->
```

`WRITING_CONTEXT_START/END` 之间的内容是「帮我引用」生成时的 prompt 语境来源。手动 + AI 共同维护。

---

## 4. HTTP API（`scripts/server.py`）

服务监听 `127.0.0.1:8765`，所有 API 返回 `{ok: bool, ...}` JSON。

### 路由表（GET 在前，POST 在后）

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/config` | GET | 当前 provider / model / 文献数 |
| `/api/settings` | GET / POST | 模型设置（DeepSeek/Qwen/OpenAI/Codex） |
| `/api/translation-settings` | GET / POST | 翻译设置 |
| `/api/easyscholar/settings` | GET / POST | EasyScholar key + enabled_fields |
| `/api/easyscholar/refresh` | POST | 单篇期刊等级刷新（只动 `期刊等级_自动`） |
| `/api/easyscholar/refresh-all` | POST | 批量；参数 `only_empty` / `force_refresh` |
| `/api/prompts` | GET / POST | 整理 prompt + 笔记模板 |
| `/api/tracking-journals` | GET / POST | list.xlsx 期刊追踪表 |
| `/api/categories` | GET | 分类列表（含计数） |
| `/api/category-tree` | GET / POST | 三级分类树（嵌套 dict） |
| `/api/category-tree/rename-primary` | POST | 重命名 + **同步迁移所有文献的相关字段** |
| `/api/category-tree/rename-secondary` | POST | 同上 |
| `/api/category-tree/rename-tertiary` | POST | 同上 |
| `/api/papers` | GET | 列表，参数 `search` / `category` / `read_status` / `importance` / `sort_by` / `sort_order` |
| `/api/paper` | GET / POST | 单篇 GET 取详情；POST 保存。allowed 字段在 `api_save_paper` 里硬编码 |
| `/api/paper/delete` | POST | 联动清理 PDF / 笔记 / 文本缓存 / AI 缓存 / 便签 JSON / english_excerpts 摘抄 |
| `/api/paper/help-read` | POST | AI 重读单篇刷新元数据 |
| `/api/paper/reprocess` | POST | 重新跑 organize 流程 |
| `/api/note` | GET / POST | 单篇 markdown 笔记 |
| `/api/note/append` | POST | 追加内容到笔记（带标题） |
| `/api/annotations` | GET / POST | 便签列表 / 创建 |
| `/api/annotations/update` | POST | 修改便签内容 |
| `/api/annotations/delete` | POST | 删除便签 |
| `/api/citations` | GET | citation 文件列表 |
| `/api/citation` | GET / POST | 单个 citation GET 取内容；POST 新建 |
| `/api/citation/save` | POST | 保存编辑 |
| `/api/citation/delete` | POST | 删除 |
| `/api/citation/help-cite` | POST | AI 根据 citation 上下文 + 当前文献生成引用记录 |
| `/api/ask` | POST | 对当前文献提问 |
| `/api/excerpt` | POST | AI 提英文好句到 english_excerpts.md |
| `/api/translate` | POST | 调翻译 provider |
| `/api/scan-status/refresh` | POST | 批量重判扫描件 |
| `/api/inbox/select-pdfs` | POST | 打开系统 PDF 多选窗口，复制到 `inbox/`，前端随后启动 organize |
| `/api/organize` | POST | 后台启动 organize 整理任务，返回 job_id |
| `/api/organize/status` | GET | 查询整理进度 |
| `/api/export/category` | POST | 按分类导出 PDF + 笔记到 `exports/<label>_<timestamp>/` |
| `/api/zotero/detect` | GET | 检测默认 Zotero 数据目录和已保存路径 |
| `/api/zotero/select-dir` | POST | 打开系统文件夹选择器，选择 Zotero 数据目录 |
| `/api/zotero/preview` | POST | 只读预览 Zotero 可导入文献、PDF、笔记、批注数量 |
| `/api/zotero/import` | POST | 从 Zotero 只读导入元数据 / PDF / 笔记 / 批注到本系统 |
| `/api/heartbeat` | GET | 心跳。前端每 15s 调一次；watcher 触发自动退出 |
| `/file?path=...` | GET | 受限路径下的静态文件（仅 ROOT 内） |
| `/web/...` | GET | 前端静态资源 |

### 心跳与自动退出（§6.2）

- 后端 `start_idle_watcher` 后台线程每 10s 检查；如果"曾收到过心跳"且"距上次心跳 > IDLE_TIMEOUT 秒"，调 `server.shutdown()` 退出进程
- CLI 控制：`--keep-alive` 禁用，`--idle-timeout N` 自定义超时
- 前端 `startHeartbeat()` 每 15s + 切回前台 ping 一次

---

## 5. 前端架构（`web/app.js`）

单文件 ES module，~2400 行。**核心是一个 `state` 对象 + 一组 `render*` 函数**。

```js
const state = {
  papers, selected, note, preview, total,
  categories, categoryTree,           // categoryTree: {primary: {sec: [tert]}}
  treeSelectedPrimary, treeSelectedSecondary,
  categoryDraft: { primaries: [], secondaries: [], tertiaries: [] },  // 多一级多二级多三级
  activeProvider, activeSettingsTab,
  trackingJournals,
  translating, rendering,
  organizeJobId, organizePollTimer,
  viewer,                              // PDFViewer 实例（iframe 包装）
  stickies, editingStickyId,
  sidebarCollapsed,
  citations, activeCitation,
  activeTranslationProvider,
};
```

**关键约定**：
1. 分类字段全多值。`getConfirmedPrimaries / getConfirmedSecondaries / getConfirmedTertiaries` 返回数组。单数版（`getConfirmedPrimary`）只是 plural[0] 的便捷封装。
2. 期刊等级显示走 `renderRankChips(text)` —— 按 `；` split 后每个 chip 套 `rankChipColorClass(chip)` CSS 类着色。
3. 分类弹窗有两个独立窗：`#categoryModal`（选当前文献分类，小窗）和 `#treeManagerModal`（编辑体系，3 列大窗）。
4. 重命名调专用 API，不走 `saveCategoryTree`，这样后端能同步迁移所有文献。
5. PDF 阅读器是浏览器原生（iframe），不再用 PDF.js 渲染。翻译靠用户复制后点「翻译剪贴板」。

---

## 6. 后端关键模块

### 6.1 `scripts/common.py`

- `INDEX_FIELDS`：CSV 列定义（顺序敏感）
- `read_csv` / `write_csv` / `write_xlsx`：总表 IO
- `sort_rows`：CSV / xlsx 在磁盘上的排序（按 年份 desc）
- `sort_rows_for_view`：网页列表的排序（`added` / `year` / `importance` / `read_status`，asc/desc）
- `apply_tracking_journals`：根据 list.xlsx 给每篇文献打 FT50/UTD/ABS/星标
- `clean_piece` / `unique_path` / `now_text`：文件名 / 路径辅助
- `text_quality` / `scan_status_from_text`：判扫描件

### 6.2 `scripts/server.py`

- 单类 `LiteratureHandler(BaseHTTPRequestHandler)` 处理所有 GET / POST
- 路由分发在 `do_GET` / `do_POST`
- `category` 相关：`normalize_category_tree`（兼容旧 list 格式）、`migrate_rows_for_rename`（rename 时扫所有 row 替换 token）
- `_HEARTBEAT_STATE` + `start_idle_watcher`：浏览器心跳 → 闲置自动退出
- `update_env_file(key, value)`：把 API key 写到 `.env`，前端只看 has_api_key bool

### 6.3 `scripts/organize.py`

整理流程：
1. 扫 `inbox/*.pdf`
2. 对每个 PDF：抽文本（PyMuPDF，缓存到 `library/text/<sha256>.txt`）→ 调 AI 提元数据 → 渲染笔记模板 → 移 PDF 到 `library/pdfs/` 并按 `rename.pattern` 重命名 → 写 papers.csv
3. 重整既有文献时保护 `preserve_manual_fields`

### 6.4 `scripts/zotero_import.py`

Zotero 本地导入。只读用户选择的 Zotero 数据目录（必须包含 `zotero.sqlite`，PDF 通常在 `storage/`）：

1. 自动检测常见路径（macOS `~/Zotero`，Windows `%USERPROFILE%\Zotero`），也支持网页里选择 / 粘贴路径
2. 先复制 `zotero.sqlite` 临时快照再读取，避免 Zotero 开着时数据库锁住
3. 读取 items / creators / tags / collections / child notes / PDF attachments / PDF annotations，兼容 `creatorData` 表和直接 `creators.firstName/lastName` 两种 schema
4. 预览阶段不复制文件，只统计总数、新增数、重复数、PDF/笔记/批注数量
5. 导入阶段按 `ZoteroKey` → DOI → PDF hash 去重；复制 PDF 到 `library/pdfs/`，生成 Markdown 笔记到 `library/notes/`
6. 不调用 AI、不修改 Zotero 数据库、不写回 Zotero
7. Zotero Collections 默认写入 `Zotero集合`，并可带入 `最终分类`；Tags 写入 `Zotero标签` 和 `关键词`

### 6.5 `scripts/annotations.py`

便签 JSON CRUD。**不再写 PDF**（早期版本用 PyMuPDF 直写过高亮 / 下划线 / 便签到 PDF，已废弃）。`fitz` 在此模块未被 import，所以即使 PyMuPDF 没装也能用便签 + EasyScholar 等。

### 6.6 `scripts/easyscholar.py`

- `FIELD_LABELS`：EasyScholar API 字段 → 中文标签的映射（`sciUp` → "中科院(升级)" 等）
- `FIELD_ALIASES`：用户 key → API 实际字段别名（`eii` 同时尝试 `ei`）
- `lookup(name, key)`：HTTP GET + 磁盘缓存（`library/cache/easyscholar/`），节流 1.2s
- `derive_updates(name, key, enabled_fields=...)` 返回 `{level_text: "中科院1区；SSCI；..."}`
- 拼接格式：`{label}{value}`，无冒号；boolean-like 值（"是" / "Y"）只显示 label

### 6.7 `scripts/export_by_category.py`

CLI + Library 双入口：
- `export_papers(label, match_mode='exact')`：精确 token 匹配（网页用），导出到 `exports/<label>_<timestamp>/{pdfs,notes}/`，**PDF 和笔记同名**（`{paper_id}.pdf` + `{paper_id}.md`）
- `main()`：兼容旧 CLI，默认 loose 模式（substring 匹配）

---

## 7. 修改时的同步清单（IMPORTANT）

**每次改动后，按下表勾一遍，避免破坏 GitHub 公开版**：

| 改动类型 | 必须同步的事 |
|---|---|
| 加新的 `INDEX_FIELDS` 字段 | ① 改 `common.py:INDEX_FIELDS` ② 如人工字段加进 `settings.example.yaml:index.preserve_manual_fields` 和我的 `settings.yaml` ③ 若前端要保存它，加进 `server.py:api_save_paper:allowed` ④ 更新 `DEVELOPER.md §3.1` |
| 加新的 `settings.yaml` 配置项 | ① 改我的 `config/settings.yaml` ② **同步改 `config/settings.example.yaml`**（不含个人值） ③ 更新 `DEVELOPER.md §3.2` |
| 加新的 API 路由 | ① 写 handler ② 路由分发 ③ **更新 `DEVELOPER.md §4` 路由表** ④ 前端 fetch 调用 |
| 加新的 Python 包依赖 | ① 在脚本里 import ② **加进 `requirements.txt`** ③ 在 `DEVELOPER.md §1` 技术栈中提一下 |
| 加新的数据目录 (如 `library/foo/`) | ① 在 `.gitignore` 加 `library/foo/*` ② 在 `library/foo/.gitkeep` 创建占位 ③ 在 `DEVELOPER.md §2` 目录树补一行 |
| 改发布包 / 启动方式 | ① 更新 `packaging/build_release.py` ② 本地跑 `python3 packaging/build_release.py --version vX.Y.Z` ③ 更新 README/CHANGELOG ④ 发布 Release assets |
| 改 EasyScholar 字段映射 | 改 `FIELD_LABELS` 和 `FIELD_ALIASES` —— 用户的 settings.yaml:easyscholar.enabled_fields 若用到老 key 不影响（mapping 不存在就跳过） |
| 改分类树结构 | 必须保持 `normalize_category_tree` 向后兼容（旧的 list 格式自动转新格式） |
| 改 papers.csv schema | 写一次性迁移：让 `read_csv` 能读旧 CSV（缺列填空字符串，由 `INDEX_FIELDS` 兜底） |
| 加 / 改前端 UI | 改对应的 HTML + CSS + JS。如果新增按钮，在 `bindEvents()` 里绑事件 |

**绝不能 commit 进 git 的东西**（确认 `.gitignore` 覆盖）：
- `.env`（API keys）
- `library/pdfs/*.pdf`、`library/notes/*.md`、`library/text/*.txt`、`library/cache/**`、`library/index/papers.csv`、`library/index/papers.xlsx`、`library/index/note_rewrite_progress.json`、`library/index/english_excerpts.md`、`library/stickies/*.json`、`library/chat_history/*.json`、`library/annotations/*`
- `citations/M*.md` / `citations/*.md`（个人写作上下文 —— 模板格式见 `citations.py:DEFAULT_CITATION_TEMPLATE`）
- `collections/by_category/**`、`exports/**`
- `config/settings.yaml`（gitignore 它；ship `settings.example.yaml`）
- `list.xlsx`（gitignore 它；ship `list.example.xlsx` 如果有）
- `检索词体系_Google_Scholar.md`、`API_KEYS.md` 等个人笔记
- `.deps/`、`.deps_macos/`、`.deps_windows/`（打包的 Python 依赖）
- `__pycache__/`、`.DS_Store`、`.server.log`、`.server.err`

---

## 8. 新用户上手流程（公开版）

`README.md` 给最终用户看；这里是 AI 助手验证步骤的依据。

1. `git clone <repo>`
2. `cd <repo>` 然后 `pip install -r requirements.txt`（推荐 venv）
3. `cp config/settings.example.yaml config/settings.yaml`
4. `cp .env.example .env`，按需填入 API keys（DeepSeek / Qwen / OpenAI / EasyScholar）
5. （可选）`cp list.example.xlsx list.xlsx` 维护自己的追踪期刊
6. 双击启动器或 `python3 scripts/server.py`
7. 浏览器自动打开 `http://127.0.0.1:8765`
8. 把 PDF 拖进 `inbox/`，点页面右上「整理新文献」

---

## 9. 已知约束 / 历史决策

- **PDF 阅读器走 iframe** 而非 PDF.js：因为 PDF.js 文字层选区不精确；用户接受牺牲"自动划词翻译"换"原生精确选区"，复制后点工具栏「翻译剪贴板」补偿（§6.2 的心跳逻辑也用 fetch + ⌘C/⌘V 来配合）
- **便签从 PDF 内层搬到右栏 JSON 旁车**：原因同上，PyMuPDF 直写 PDF 改变文件 hash，体验割裂
- **一级分类多值**：一篇文献能同时属于多个一级（如 `C09 开放科学`+`M1 我的论文集`），用 `；` 分隔
- **期刊等级双字段** (`_自动` / `_人工`)：自动刷新永不覆盖人工填的，前端 `api_save_paper:allowed` 显式拒绝前端写自动字段
- **分类重命名走专用 API**，因为 `saveCategoryTree`（全树覆盖）无法识别 rename vs add+delete，无法迁移文献分类字段
- **三级嵌套结构 + 向后兼容**：`normalize_category_tree` 自动把旧 list 格式（仅二级）转新 dict 格式
- **浏览器关闭后自动退出**：基于心跳，60s 默认。`--keep-alive` 可禁用
- **`exports/` 是临时材料包**，时间戳后缀，gitignore 整个目录

---

## 10. 变更日志（每次重大修改时追加一行）

> 写日期 + 一句话；细节在 git commit message 里。

- 2026-06-25 新增网页「添加 PDF」入口：系统文件选择器多选 PDF，复制到 `inbox/` 后沿用原整理流程
- 2026-05-21 Citation 管理入口从设置移到顶栏「帮我引用」下拉框右侧 `+`，作为独立弹窗打开
- 2026-06-05 新增 Zotero 本地只读导入：支持选择 Zotero 数据目录，预览后导入元数据、PDF、普通笔记、PDF 批注，并记录 ZoteroKey / 集合 / 标签用于去重和分类
- 2026-06-04 新增首次启动配置向导：引导用户填写主 AI、翻译、EasyScholar、视觉模型和 OCR，并在 `config/settings.yaml:onboarding.completed` 记录完成状态
- 2026-05-22 GitHub 首页补充 logo 与图文导览素材，公开 README 更新为 v0.2.3 下载说明
- 2026-05-22 Windows 端优化同步：新增一句话总结、阅读区压缩、元信息表单瘦身、笔记护眼背景和 EasyScholar 等级格式修正
- 2026-05-21 README 重写为中英双版 GitHub 首页，macOS 首次打开直接给 `xattr` 解除隔离流程
- 2026-05-21 README 补充 macOS 未签名下载警告与首次打开步骤，明确 v0.2.0 目标是无付费签名前提下尽量简化启动
- 2026-05-21 v0.2.2 改 macOS `.app` 启动体验：双击后打开 Terminal 进度窗口，显示依赖安装和服务启动日志
- 2026-05-21 v0.2.1 修正 macOS 未公证 App 说明：补充 quarantine 解除步骤、Mac 包内 `MAC_FIRST_RUN.txt`、打包时尝试 ad-hoc 签名
- 2026-05-21 v0.2.0 发布包：新增 `packaging/build_release.py`，生成 macOS `.app` 包装器和 Windows 独立 zip 入口
- 2026-05-21 v0.1.0 发布准备：改用 PolyForm Noncommercial License 1.0.0，补充 NOTICE/CHANGELOG，并明确当前为源码启动版
- 2026-05-21 公开仓库整理：补充 chat_history/annotations 忽略规则，防止个人问答和历史注释数据进入 GitHub
- 2026-05-21 路径跨平台兼容：CSV 统一保存 `/` 路径，读取层兼容旧 Windows `\` 路径，修复 macOS PDF `file not found`
- 2026-05-21 公开版移除个人 manuscript 批处理遗留：`manuscript_v` 不再作为模板目录，旧批量重写脚本保留在本机 `.local/` 不上传
- 2026-05-15 一级分类支持多值；新增「按分类导出」UI 路由 `/api/export/category`
- 2026-05-15 心跳机制：浏览器关闭 60s 后服务自动退出（`--keep-alive` 禁用）
- 2026-05-15 EasyScholar 拼接格式去冒号；期刊等级 chip 按 label 前缀着色
- 2026-05-15 分类树升级三级嵌套（向后兼容 list 格式）；rename API 同步迁移文献分类字段
- 2026-05-14 期刊等级双字段（`_自动` / `_人工`）；批量刷新接口
- 2026-05-14 EasyScholar API 集成；设置→期刊等级源 tab
- 2026-05-14 PDF 阅读器改 iframe；翻译改「剪贴板」模式
- 2026-05-13 注释功能（高亮/下划线/便签 PDF 层）拆除；便签独立到 `library/stickies/*.json`
- 2026-05-13 列表加排序下拉；分类筛选刷新后保持
- 2026-05-13 启动器自动打开浏览器

---

## 11. 给 AI 助手的指令模板

如果未来某次会话开始时你（AI 助手）打开了一个 fresh checkout，请把下面这段当作你的 system context：

> 这是文献工作台仓库。先读 `DEVELOPER.md`（本文件）了解架构，再看用户的具体需求。任何改动必须按 §7「修改时的同步清单」走，确保 GitHub 公开版与个人系统同步。改完语法检查 `python3 -m py_compile scripts/*.py` 和 `node --check web/*.js`，端到端用 `python3 scripts/server.py --no-browser --keep-alive` 测一下。提交前确认 `.gitignore` 没有放过个人数据，特别是 `.env`、`library/pdfs/`、`papers.csv`、`citations/M*.md` 这几条。
