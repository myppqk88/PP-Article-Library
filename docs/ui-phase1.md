# Phase 1 — 视觉地基 + 4 主题切换

## 包含 3 个文件

| 文件 | 替换/新增 | 说明 |
|---|---|---|
| `web/index.html` | **替换** | 顶栏精简、侧栏 filter pills、分类 tab 重排（标题/作者首位、期刊在备注上）、加 theme picker 入口 |
| `web/styles.css` | **替换** | 新视觉系统 + 4 主题 + 所有原 class 名保留 |
| `web/app-phase1.js` | **新增** | 主题切换 + 顶栏 overflow menu + 重要性星级 + 阅读状态分段控件 + 便签颜色 + "/" 搜索快捷键 |

## 安装步骤

```bash
cd /path/to/article  # 你的项目根

# 0. 先 commit 当前状态，万一回滚
git add -A && git commit -m "snapshot before P1 frontend refactor"
git tag pre-p1

# 1. 把下载的 3 个文件放进 web/
cp ~/Downloads/index.html      web/
cp ~/Downloads/styles.css      web/
cp ~/Downloads/app-phase1.js   web/

# 2. 跑起来试试
python3 scripts/server.py

# 3. 没问题就 commit
git add web/index.html web/styles.css web/app-phase1.js
git commit -m "refactor(ui): adopt new visual system + 4 themes (P1)"

# 出问题：
git reset --hard pre-p1
```

## 重点验证清单

打开页面后：

- [ ] 顶栏只有 4 个东西：`[整理新文献]` / `[帮我引用▾]` / `[⋯]` / `[⚙]`
- [ ] 点 `⋯` 弹出下拉菜单包含：刷新扫描标记 / 批量刷新等级 / 按分类导出 / 打开总表
- [ ] 文献头部右侧出现 `帮我阅读` 和 `刷新等级`（不再在顶栏）
- [ ] 侧栏的 4 个 select 是横排 pill 样式，选了非默认值会变橙色
- [ ] 按 `/` 焦点跳到搜索框
- [ ] 分类 tab 的字段顺序：**标题/作者 → 分类路径 → 状态 → 期刊 → 备注**
- [ ] 重要性是 5 颗可点星，阅读状态是 6 段 segmented
- [ ] 设置 → 界面 tab 顶部有"主题色"切换：陶土橘 / 黑白 / 森林 / 深海
- [ ] 主题选了之后刷新页面还在（localStorage 记着）
- [ ] 笔记 tab 顶部是 `[预览][编辑]` segmented
- [ ] 便签输入框底部有 5 色圆点（颜色记在 add 按钮 data-color，P2 真正按颜色显示）

## 不在 Phase 1 范围内

下面这些下一阶段做，**Phase 1 后这些功能还和原版一致**：

- AI 多会话切换（P2）
- AI 回答可编辑追加（P2）
- AI 引用源跳页（P2）
- 命令面板 ⌘K（P3）
- 侧栏虚拟列表（P3）
- 视图模式切换 紧凑/舒展/表格（P3）
- 文献多选批量操作（P3）
- 笔记 Wiki link `[[paper_id]]`（P4）
- PDF 大纲侧栏（P4）
- 笔记分屏编辑（P4）
- 分类弹窗三列联动（P5）
- 设置弹窗左导航 + 连接状态卡（P5）
- 摘抄结构化卡片 + 入 citation（P5）

## 已知小事

- 便签颜色目前只是 UI 选中状态。app.js Phase 2 加上后端字段后才会真正按颜色显示卡片。Phase 1 你点颜色 → 加便签 → 便签都会以默认陶土橘显示（不影响功能）。
- 分类 tab 隐藏了 `<select id="importance">` 和 `<select id="readStatus">`，只显示新的星级 + 分段。星级 / 分段会和这俩 select 双向同步，所以原 app.js 的存档逻辑不变。
- 主题在 `localStorage["lit-hub-theme"]`，清缓存会重置回默认陶土橘。

## 出现问题时

最常见问题是：
1. **某个按钮点不动** —— 多半是 `app-phase1.js` 没加载。检查浏览器 console 有无 404
2. **重要性/阅读状态保存不上** —— 同上，星级和分段依赖 phase1.js 同步到底层 select
3. **顶栏 `⋯` 点了没反应** —— 同上
4. **主题不切换** —— 检查 settings → 界面 tab 里的 theme picker；按钮在那

回滚：`git reset --hard pre-p1`
