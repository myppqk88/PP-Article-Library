# 文献工作台 — 全量交付（P1 + P2-P5）

所有 P2–P5 文件都设计成**叠加到 P1 之上**，向 app.js 添加行为而不直接修改它。

## 文件清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `web/index.html` | **替换** P1 | 加新 link 和 5 个 script tag + 新增 3 个弹窗骨架（命令面板/批量条/分类 v2） |
| `web/styles.css` | 保持 P1 | 不变 |
| `web/styles-features.css` | **新增** | P2–P5 所有新组件样式 |
| `web/app.js` | **不动** | 你的原文件，保留 |
| `web/app-phase1.js` | 保持 P1 | 不变（主题/星级/分段/便签色/⌥ 等） |
| `web/app-phase2.js` | **新增** | AI 多会话 + 可编辑追加 + 引用 [p.N] 跳页 |
| `web/app-phase3.js` | **新增** | ⌘K 命令面板 + 视图模式 + 多选批量 |
| `web/app-phase4.js` | **新增** | Wiki link `[[paper_id]]` + 笔记分屏 |
| `web/app-phase5.js` | **新增** | 分类三列联动弹窗 + 摘抄卡片 + 连接状态卡 |

## 安装步骤

```bash
cd /path/to/article

# 0. snapshot
git add -A && git commit -m "snapshot before P2-P5"
git tag pre-p2p5

# 1. 拷文件（P1 的三个之前已经在 web/，这里只覆盖 index.html + 新增 6 个）
cp ~/Downloads/index.html              web/
cp ~/Downloads/styles-features.css     web/
cp ~/Downloads/app-phase2.js           web/
cp ~/Downloads/app-phase3.js           web/
cp ~/Downloads/app-phase4.js           web/
cp ~/Downloads/app-phase5.js           web/

# 2. 跑
python3 scripts/server.py

# 3. 试一圈，OK 就 commit
git add web/
git commit -m "feat(ui): P2-P5 — AI multi-conv + cmd palette + view modes + wiki links + 3-col cat + excerpt cards"

# 出 bug，按段回滚：
# 单独移除某个 phase：删除对应 app-phaseN.js + 在 index.html 注释掉它的 script 标签
# 全部回滚：git reset --hard pre-p2p5
```

## 测试清单（按文件)

### app-phase2.js — AI 多会话
- [ ] AI tab 顶部出现一行会话 chips：`[新建] [默认会话 N]`
- [ ] 第一次打开任一文献：原有的服务器端 history 自动迁移成「默认会话（迁移自旧版）」
- [ ] 点「新建」→ 输入名字 → 空白会话
- [ ] 会话之间切换，message 区互不污染
- [ ] 点会话 chip 的 `⋮` → 选 1/2/3 → 重命名/删除/复制
- [ ] AI 回答下 hover 出现：复制 / 追加到笔记… / 重生成
- [ ] 点「追加到笔记…」→ 当场展开可编辑面板，预填 AI 原文，可改可加标题
- [ ] 追加目标：本文笔记 / 便签 二选一
- [ ] AI 回答里的 `[p.7]` `p.12-15` 等自动变 chip，点击 → PDF iframe 跳到该页

### app-phase3.js — 命令面板 + 视图 + 多选
- [ ] 任意位置按 `⌘K` (Mac) 或 `Ctrl+K` 弹命令面板
- [ ] 空查询：显示命令 + 最近文献
- [ ] 输入关键字 → 模糊匹配文献标题 / 作者 / venue + 命令
- [ ] `↑↓` 选 / `Enter` 打开 / `Esc` 关
- [ ] 侧栏 paperCount 上方出现「舒展 / 紧凑 / 表格」3 段切换
- [ ] 紧凑模式：单行标题，无 chip
- [ ] 表格模式：网格三列（标题 / venue / 年）
- [ ] 视图选了刷新还在（localStorage）
- [ ] 旁边「选择多篇」按钮 → 进多选模式
- [ ] 卡片左侧出现 checkbox 占位，点卡片 = 选中（不打开文献）
- [ ] 底部出现黑色批量条：N 已选 + 改分类 / 改状态 / 导出 / 删除 / ✕
- [ ] 改分类：弹 prompt 输入一级名（只支持一级，复杂多级用单篇）
- [ ] 改状态：弹 prompt 输入状态名（待读/已读/精读等）
- [ ] 删除：批量删，逐个调 API

### app-phase4.js — Wiki link + 分屏
- [ ] 在笔记里写 `[[paper_id]]` 或 `[[标题片段]]` → 预览模式自动渲染为橙色 chip
- [ ] 点 chip → 跳到那篇文献
- [ ] 找不到匹配的 chip：灰色 wiki-broken 样式 + tooltip 提示
- [ ] 笔记 tab 的 seg 多了「分屏」按钮
- [ ] 点分屏：左编辑 / 右预览，输入实时渲染

### app-phase5.js — 分类弹窗 + 摘抄卡片 + 连接状态
- [ ] 在「分类」tab 点「分类」框 → 打开**新的三列联动**弹窗（不再是旧的纵向 chip）
- [ ] 顶部 breadcrumb 显示当前已选路径（每个一级独立一行）
- [ ] 三列：一级 / 二级（按选中一级动态显示）/ 三级（按选中二级动态显示）
- [ ] 行点击 = 聚焦；行的 checkbox 点击 = 加入/移出选择
- [ ] hover 每行显示「✎ × 」重命名/删除
- [ ] 每列底部内联新增
- [ ] AI 建议的分类前缀「AI」徽标
- [ ] 「全部清空」一键清掉所有选择
- [ ] 「应用到当前文献」→ 保存 + 关闭 + 侧栏刷新
- [ ] 摘抄 tab 点「从当前文献摘抄好句」→ 返回的 AI 文本**自动结构化**为 N 张引言卡
- [ ] 每张卡：引号 + quote + 用法说明 + hover 出 复制/入便签/×
- [ ] 「入便签」一键把 quote 收进**便签**（黄色色块）
- [ ] 设置弹窗 → 模型 tab 顶部多一个「连接状态」卡，「测试连接」按钮 ping `/api/config`

## 已知局限 / 我没做的

- **PDF 大纲侧栏**：你目前用浏览器原生 PDF iframe，无法读 PDF outline。要做必须切到 pdf.js 自渲染（半天起的工程）。**未实施**。
- **批量改多级分类**：phase3.js 的批量改分类只支持一级。复杂多级请单篇用 phase5.js 三列弹窗。
- **批量导出**：phase3.js 的「导出」只是提示用户走顶栏 ⋯ → 按分类导出。
- **AI 引用跳页**只对 `[p.N]` / `p.N` / `p.N-M` 这种格式起作用。你可以在「设置 → 提示词」里教 AI 输出这种标记。
- **多会话存 localStorage** = 浏览器清缓存会丢历史。服务器端的 `library/chat_history/` 是迁移源，不再写入。如果你想多机同步，需要后端改造（不在本次范围）。
- **摘抄删除**只是本次显示移除，不会改 `english_excerpts.md` 文件。要清理请直接编辑那个文件。

## 出问题时

| 现象 | 多半原因 |
|---|---|
| AI 会话条不出现 | app-phase2.js 没加载 / 浏览器没刷新 |
| `⌘K` 不响应 | app-phase3.js 没加载 |
| 分类弹窗还是旧的纵向 chip | app-phase5.js 没加载，或浏览器从老缓存里读了 index.html |
| 笔记 wiki link 不渲染 | app-phase4.js 没加载，或 `[[xxx]]` 在代码块里（不会渲染） |
| 多会话消息丢了 | 浏览器换了 / 清了缓存。服务器 `library/chat_history/{paper_id}.json` 仍有 P1 之前的记录 |

按段回滚：删除对应 `app-phaseN.js` 文件，在 `index.html` 注释掉它的 `<script>` 行即可。
