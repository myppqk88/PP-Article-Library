# PP Article Library

一个**源码公开、非商用、本地优先**的文献整理 + PDF 阅读 + AI 笔记 + 学术写作助手。

- Python 3 + 原生浏览器 JS，零云依赖（除非你自己接 AI provider）
- 所有数据存在本地文件夹，可以放云盘里跨设备同步
- 支持 macOS / Windows / Linux（任何能跑 Python 3 + Chrome 系浏览器的系统都行）
- 当前 `v0.2.2` 提供 macOS / Windows 分开的下载包；源码启动器仍保留给高级用户

> **macOS 用户请先看这里**
>
> `v0.2.2` 的 Mac 包做了本机 ad-hoc 签名，但没有 Apple Developer 付费公证。从 GitHub 下载后，macOS 仍可能提示：
>
> `Apple 无法验证“PP Article Library.app”是否包含可能危害 Mac 安全或泄漏隐私的恶意软件。`
>
> 这是 macOS 对未公证网络下载 App 的安全提醒，不代表本项目会上传你的 PDF、笔记或 API key。完全免提示需要 Apple Developer 付费签名和公证，本项目暂不承担该成本。免费版如果被拦，请按下面「macOS 第一次打开」处理。

## 适合你吗？

适合：
- 写论文 / 写综述 / 写文献综述章节
- 需要按主题 + 按论文章节双重组织几百到几千篇 PDF
- 想让 AI 帮你做"读一篇 → 决定要不要引 → 引到哪一节 → 写出引用句"全链路
- 不想把 PDF 和笔记交给云厂商

不适合：
- 想要团队协作（这是单人工具）
- 主要看小说 / 网页 / EPub（PDF 优先）

## 快速开始

### 普通用户下载

1. 打开 [GitHub Releases](https://github.com/myppqk88/PP-Article-Library/releases)
2. 下载对应系统：
   - macOS：`PP-Article-Library-v0.2.2-macOS.zip`
   - Windows：`PP-Article-Library-v0.2.2-Windows.zip`
3. 解压到一个新文件夹
4. 进文件夹，双击：
   - macOS：`PP Article Library.app`
   - Windows：`Start PP Article Library.bat`
5. 首次启动会自动：
   - 探测系统 Python（PATH / Anaconda / 官方安装路径）
   - 安装必需 Python 包：PyYAML、requests、openpyxl、PyMuPDF、pypdf
   - 从 settings.example.yaml 复制出 settings.yaml
   - 从 .env.example 复制出 .env
   - 建好所有数据目录（library/、citations/、inbox/ 等）
6. 浏览器自动打开 → 进 设置 → 主模型，填一个 API key 就能用

macOS 会弹出一个“终端 / Terminal”进度窗口，能看到 pip 下载和安装过程。看到浏览器打开后，不要关闭这个终端窗口；关闭窗口会停止本地服务。

`v0.2.2` 暂不内置 Python。多数研究者电脑里已经有 Python / Anaconda；如果没有，先安装 Python 3.10+，Windows 安装时勾选 `Add Python to PATH`。

路径说明：工作台内部统一把 PDF / 笔记路径保存成 `library/pdfs/xxx.pdf` 这种 `/` 写法。Windows 和 macOS 都能读取；旧数据里如果混有 Windows 的 `\` 路径，启动后也会自动兼容，所以跨系统迁移时不会因为路径分隔符不同而找不到 PDF。

### macOS 第一次打开

如果直接双击出现黄色警告，先试这个：

1. 点「完成」，不要点「移到废纸篓」。
2. 回到 Finder，对 `PP Article Library.app` 右键 / 双指点按。
3. 选择「打开」。
4. 如果系统设置里出现「仍要打开 / Open Anyway」，也可以在那里允许一次。

如果仍然不行，说明 macOS 对这个浏览器下载包加了 quarantine 隔离标记。免费未公证 App 无法在运行前自己解除这个标记，需要你在本机确认一次。最短操作如下，不用 `cd`：

```text
1. 打开“终端 / Terminal”
2. 输入下面这句，末尾留一个空格：

   xattr -dr com.apple.quarantine

3. 把整个解压后的 PP-Article-Library-v0.2.2-macOS 文件夹拖进终端窗口
4. 按回车
5. 再双击 PP Article Library.app
```

如果你就是解压在“下载”目录，也可以直接复制这一整句：

```bash
xattr -dr com.apple.quarantine "$HOME/Downloads/PP-Article-Library-v0.2.2-macOS" && open "$HOME/Downloads/PP-Article-Library-v0.2.2-macOS/PP Article Library.app"
```

`v0.2.2` 的 Mac 包里也有一份 `MAC_FIRST_RUN.txt`，写的就是这几步。由于没有 Apple Developer 付费公证，第一次安全提示无法完全消除；这不是代码能在免费未公证状态下绕过的东西。

### Git 用户

```bash
git clone https://github.com/myppqk88/PP-Article-Library.git literature-hub
cd literature-hub
./打开文献工作台.command  # macOS
```

### 手动启动（如果脚本启动器跑不了）

```bash
cd literature-hub
pip install -r requirements.txt
python3 scripts/server.py
```

server.py 会自动做上面 1-3 步的所有初始化工作。**唯一需要你手填的就是 API key**——可以在网页 设置 → 主模型 里直接填（会写入 `.env`），也可以提前编辑 `.env` 文件。

浏览器会自动打开 `http://127.0.0.1:8765`。

**关闭方式**：直接关浏览器窗口。约 60 秒后工作台会自动退出（基于心跳检测）。如果想保持运行不退出，加 `--keep-alive`：

```bash
python3 scripts/server.py --keep-alive   # Ctrl+C 才退
```

## 日常工作流

1. **导入 PDF**：把新 PDF 拖进 `inbox/` → 网页右上点「整理新文献」→ AI 抽元数据、建初始笔记和 AI 分类建议、移入 `library/pdfs/`
2. **打开一篇**：左栏列表点一篇 → 中间 PDF 阅读器加载，右栏笔记 / AI / 分类 / 便签 4 个 tab
3. **阅读 + 翻译**：在 PDF 里选中英文 → ⌘C → 点页面右上「翻译剪贴板」（走本地 Ollama 或 OpenAI 兼容 API）
4. **写笔记**：右栏「笔记」tab 默认预览，点「编辑」切到 Markdown 编辑器。"我的人工笔记"段在 AI 重读时被保护
5. **分类**：右栏「分类」tab → 点分类框 → 弹分类管理窗
   - 一级 / 二级 / 三级三层结构，每层都能多选
   - 一篇文献可以同时挂多个一级（比如学科分类 + "M1 我的论文一引用集"）
   - 「编辑分类体系」嵌套窗里能新增 / 重命名 / 删除任一级，**重命名会自动同步所有已分类文献**
6. **便签**：右栏「便签」tab。每篇文献独立的 JSON 便签集，跟 PDF 解耦（删除文献时自动清理）
7. **追问 AI**：右栏「AI」tab，对当前文献提问。可选「按页读图」喂图片给 vision 模型（扫描件用）

## 写作助手（核心）

为每篇正在写的论文建一份 **citation 文件**（在 `citations/` 目录）：
- 顶部「写作上下文」区（手写）：中心主题、范围边界、预期章节、关键论点、理论框架、目标期刊
- 「引用记录」区（手写 + AI 追加）：每条对应一篇文献的具体引用建议

工作流：
- 顶栏「**帮我阅读**」：AI 重读当前 PDF → 刷新元数据 + 笔记。不动分类和人工字段。
- 顶栏「**帮我引用**」：旁边下拉选 citation 文件 → AI 读「这篇文献 + 该 citation 的写作上下文」→ 生成一条引用记录追加到该 citation 末尾

进设置 → 引用文件管理 编辑 `<!-- WRITING_CONTEXT_START/END -->` 之间的内容，让 AI 知道这篇论文要写什么。

## 期刊等级自动匹配（可选）

接入 [EasyScholar API](https://www.easyscholar.cc/)：

1. 注册账号，到「开放接口」拿到 secretKey
2. 启动工作台 → 设置 → 期刊等级源 → 粘贴 secretKey → 保存
3. 勾选要查的字段（中科院升级 / SCI / SSCI / FMS / UTD24 / AJG / CSSCI / ...）
4. 顶栏「刷新等级」（单篇）或「批量刷新等级」（全库）

查到的结果写入 `期刊等级_自动` 字段；你手填的 `期刊等级_人工` 字段独立存储，**永远不会被自动刷新覆盖**。显示时优先用人工值。

## 批量按分类导出

顶栏「按分类导出」→ 选任一分类（一/二/三级都行）→ 一键导出到：

```
exports/<分类名>_<时间戳>/
├── pdfs/<paper_id>.pdf
├── notes/<paper_id>.md
├── 文献清单.csv
├── 文献清单.xlsx
└── README.md
```

PDF 和笔记文件名一致，方便配对。

## 目录结构

```
.
├── inbox/             ← 待整理 PDF 放这里
├── library/
│   ├── pdfs/          ← 整理后 PDF 主库
│   ├── notes/         ← 每篇一份 .md 笔记
│   ├── text/          ← PDF 文本缓存（喂给 AI 用）
│   ├── cache/         ← AI / EasyScholar 回包缓存
│   ├── stickies/      ← 便签 JSON
│   └── index/         ← papers.csv / papers.xlsx 总表
├── citations/         ← 每篇在写论文一份 .md
├── config/
│   ├── settings.yaml          ← 你的本地配置
│   └── settings.example.yaml  ← 配置模板
├── prompts/           ← AI 提示词 + 笔记模板
├── scripts/           ← Python 后端（server.py / organize.py / 等）
├── web/               ← 浏览器前端（原生 ES module）
├── exports/           ← 批量导出的临时材料包
├── list.xlsx          ← 可选本地文件：你追踪的期刊（默认不上传）
└── .env               ← API keys（已 gitignore）
```

数据目录（`library/`、`inbox/`、`citations/`、`exports/`）都在 `.gitignore` 里，clone 这个仓库不会拿到任何人的私人 PDF / 笔记 / 写作上下文。

## 配置 AI Provider

`.env` 至少需要一个 AI provider 的 key：

| Provider | env 变量 | 备注 |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | 性价比高，推荐 |
| 阿里 Qwen | `QWEN_API_KEY` | 经 `dashscope.aliyuncs.com/compatible-mode/v1` |
| 任意 OpenAI 兼容 | `OPENAI_API_KEY` | 自填 base_url，能接 OpenAI / Moonshot / Together / 任何兼容接口 |
| Codex CLI | （走 `codex login` 的本地缓存） | 把你的 ChatGPT/Codex 订阅当 API 用，无需单独 API key |
| Claude Code CLI | （走 `claude login` 的本地缓存，或 `ANTHROPIC_API_KEY`） | 把 Claude Code Pro/Max 订阅当 API 用 |
| EasyScholar | `EASYSCHOLAR_SECRET_KEY` | 期刊等级查询（可选） |

在工作台「设置 → 模型设置」里切换 provider 和填具体的 base_url / model / API key（key 会写回 `.env`）。

### Codex CLI 配置（用 ChatGPT/Codex 订阅当 API）

1. **安装**：从 [openai.com/codex](https://openai.com/codex/) 下载（macOS 是 `Codex.app`），或 `brew install codex`。
2. **登录**：终端跑一次 `codex login`，浏览器走 OAuth，凭据缓存到 `~/.codex/`。
3. **工作台**：「设置 → 模型 → Codex CLI」标签
   - **Codex CLI 路径**：
     - macOS：`/Applications/Codex.app/Contents/Resources/codex`
     - Windows：`codex.cmd`（在 PATH 中就行；否则填绝对路径，比如 `C:\Users\<you>\AppData\Roaming\npm\codex.cmd`）
     - 不填留空，会用平台默认
   - **Codex 模型**：默认 `gpt-5.4`；可填 `gpt-5.4-codex`、`gpt-4o` 等你订阅支持的
   - **沙盒**：`read-only` 就够了
4. **切到 Codex 后**：「设置 → 主模型」下拉里选 `codex_cli`，保存。整理新文献、帮我阅读、AI 问答都会走 Codex。

### Claude Code CLI 配置（用 Claude Pro/Max 订阅当 API）

1. **安装**：`npm install -g @anthropic-ai/claude-code`（需要 Node.js 18+）。
2. **登录**：终端跑一次 `claude login`，浏览器走 OAuth，凭据缓存到 `~/.config/claude/`（macOS/Linux）或 `%APPDATA%\Claude\`（Windows）。
   - 或者直接在工作台「Claude CLI」标签的 **ANTHROPIC_API_KEY** 字段填你的 Anthropic key，会写入 `.env`。两种方式 CLI 都能识别。
3. **工作台**：「设置 → 模型 → Claude CLI」标签
   - **Claude CLI 路径**：
     - macOS/Linux：`claude`（在 PATH 中即可，留空也行）
     - Windows：`claude.cmd`（npm 全局装包后会在 `%APPDATA%\npm\claude.cmd`；如果没在 PATH 里就填绝对路径）
   - **Claude 模型**：默认 `claude-sonnet-4-5`；可填 `claude-opus-4-1`、`claude-haiku-4-5`
   - **超时秒数**：默认 240（Claude 在长文上比较稳但慢）
4. **切到 Claude 后**：「设置 → 主模型」下拉里选 `claude_cli`，保存。整理新文献 / 帮我阅读 / AI 问答都会走 Claude Code CLI。

> 两个 CLI provider 的好处：**你已经在 ChatGPT Plus / Codex / Claude Pro 上付了月费，调用次数走订阅额度不走 API 计费**。缺点：单次调用的延迟比 API 高一些（30–90s），不支持视觉模型。

**翻译**默认走本地 [Ollama](https://ollama.com/)，零成本：`brew install ollama && ollama pull qwen2.5:14b`。也可改成 OpenAI 兼容 API。

### 扫描件 OCR fallback

PDF 文本抽取不到内容时（扫描件），工作台会自动调本地 OCR 引擎识别文字再喂给 AI。**默认引擎 `rapidocr-onnxruntime`**：

- 走 `pip install -r requirements.txt` 自动装好（~50MB，模型已打包，无需联网下载）
- 跨平台（macOS / Windows / Linux），不依赖 Tesseract 等系统级二进制
- 中文识别率约 92%，对印刷体扫描件够用
- 结果缓存到 `library/text/{hash}.ocr.txt`，重复打开同一篇不重复 OCR

**触发条件**（在 设置 → OCR 里可改）：PDF 抽出的文本 < 500 字符 或 启发式标记为扫描件 → 自动跑 OCR。

**切其他引擎**：
- `easyocr` — 准但重（需 PyTorch ~350MB），`pip install easyocr`
- `cloud` — 调任意 OpenAI 兼容的视觉接口做 OCR（阿里通义 VL / 火山豆包 / GPT-4o）。在 设置→OCR→云 OCR 配置 里填 base_url + model + key

## 命令行用法

```bash
python3 scripts/server.py                     # 启动网页
python3 scripts/server.py --no-browser        # 不自动开浏览器
python3 scripts/server.py --keep-alive        # 关浏览器后不自动退出
python3 scripts/server.py --idle-timeout 300  # 自定义心跳超时(秒)

python3 scripts/organize.py                   # 手动整理 inbox（也可在网页点按钮）
python3 scripts/organize.py --limit 3         # 只测前 3 篇
python3 scripts/organize.py --no-ai           # 不调 AI，只建占位
python3 scripts/organize.py --force-ai        # 强制重跑 AI

python3 scripts/export_by_category.py 开放科学          # 按关键词宽松匹配
python3 scripts/export_by_category.py 开放科学 --exact  # 按分类 token 精确匹配
```

## 跨设备同步

项目放在云盘里（坚果云 / iCloud / Dropbox）即可在多台电脑间共享。
- `library/` 数据是单一来源
- `config/settings.yaml` 你的偏好
- 不同平台的二进制依赖（`.deps_macos/` / `.deps_windows/`）可选；不存在时用系统 site-packages

## 进一步阅读

- [DEVELOPER.md](DEVELOPER.md) — 架构、数据 schema、API 路由、修改时的同步清单。
  贡献代码 / 让 AI 助手帮你改系统时**强烈建议先读这份**。
- [CHANGELOG.md](CHANGELOG.md) — 版本更新记录。

## 许可

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE.md)。

你可以为了个人研究、学习、教育、公益、公共研究等非商业目的使用、修改和分发本项目。商业使用需要先获得作者单独许可。

这是一份“源码公开、非商用”的软件许可；它不是 OSI 定义下的开放源代码许可。
