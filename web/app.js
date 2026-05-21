import { PDFViewer } from "/web/pdf_viewer.js";

const state = {
  papers: [],
  selected: null,
  note: "",
  preview: true,
  total: 0,
  categories: [],
  categoryTree: {},
  treeSelectedPrimary: "",
  treeSelectedSecondary: "",
  categoryDraft: { primaries: [], secondaries: [], tertiaries: [] },
  activeProvider: "deepseek",
  activeSettingsTab: "model",
  trackingJournals: [],
  translating: false,
  rendering: false,
  organizeJobId: "",
  organizePollTimer: null,
  viewer: null,
  stickies: [],
  editingStickyId: "",
  sidebarCollapsed: false,
  citations: [],
  activeCitation: "",
  activeTranslationProvider: "ollama",
  chatHistory: [],
  workContext: "",
  uiTabs: { note: true, annot: true, ai: true, excerpt: true, meta: true },
};

const $ = (id) => document.getElementById(id);

const providerIds = {
  deepseek: {
    base_url: "deepseekBaseUrl",
    model: "deepseekModel",
    api_key_env: "deepseekKeyEnv",
    api_key: "deepseekApiKey",
  },
  qwen: {
    base_url: "qwenBaseUrl",
    model: "qwenModel",
    api_key_env: "qwenKeyEnv",
    api_key: "qwenApiKey",
  },
  openai_compatible: {
    base_url: "openaiCompatibleBaseUrl",
    model: "openaiCompatibleModel",
    api_key_env: "openaiCompatibleKeyEnv",
    api_key: "openaiCompatibleApiKey",
  },
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

// ----------------------------------------------------------------------
// Toast notifications — surfaces errors that would otherwise die in
// console.error. Loaders that fail silently used to leave the user staring
// at an empty panel with no idea why (便签 / 摘抄 / 历史 / 设置 加载失败).
// Usage: notify.error("加载便签失败：" + err.message)
//        notify.info("已复制到剪贴板")
// ----------------------------------------------------------------------
const notify = (() => {
  let host = null;
  function getHost() {
    if (host && host.isConnected) return host;
    host = document.createElement("div");
    host.id = "appToastHost";
    host.style.cssText =
      "position:fixed;bottom:18px;right:18px;display:flex;flex-direction:column;gap:8px;" +
      "z-index:9999;pointer-events:none;max-width:380px;";
    document.body.appendChild(host);
    return host;
  }
  function make(kind, msg, persist) {
    const t = document.createElement("div");
    const isErr = kind === "error";
    t.style.cssText =
      "pointer-events:auto;font-size:12.5px;line-height:1.5;padding:10px 14px;border-radius:8px;" +
      "box-shadow:0 4px 14px -4px rgba(20,14,8,0.2);word-break:break-word;display:flex;gap:8px;align-items:flex-start;" +
      (isErr
        ? "background:#fcebe8;color:#8b2f24;border:1px solid #e8c5be;"
        : "background:var(--dc-bg-panel,#fff);color:var(--dc-text,#2b2620);border:1px solid var(--dc-border,#d9d6cf);");
    const text = document.createElement("span");
    text.style.cssText = "flex:1;white-space:pre-wrap;";
    text.textContent = msg;
    const close = document.createElement("button");
    close.textContent = "×";
    close.style.cssText =
      "background:transparent;border:none;cursor:pointer;font-size:14px;line-height:1;" +
      "padding:0 2px;color:inherit;opacity:0.6;";
    close.onclick = () => t.remove();
    t.append(text, close);
    getHost().appendChild(t);
    if (!persist) {
      setTimeout(() => t.remove(), isErr ? 8000 : 3000);
    }
    return t;
  }
  return {
    info: (msg) => make("info", msg, false),
    error: (msg) => make("error", msg, false),
    errorPersist: (msg) => make("error", msg, true),
  };
})();

function debounce(fn, delay = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function escapeHtml(text = "") {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function markdownLite(text) {
  const visible = String(text).replace(/<!-- manual_note:(start|end) -->/g, "");
  const escaped = escapeHtml(visible);
  return escaped
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^- (.*)$/gm, "<li>$1</li>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/\n/g, "<br>");
}

// Split a stored category value into individual tags.
// IMPORTANT: We only split on the fullwidth `；` and halfwidth `;`, NEVER on
// commas — commas are a legitimate character inside category names (e.g.
// "Mapping Open Science Policy in China: A Structural, Temporal, and Spatial
// Analysis"). All stored category values are joined with `；` by joinUnique,
// so splitting on `；` is round-trip safe.
function splitValues(value = "") {
  return String(value)
    .split(/[；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinUnique(values) {
  const clean = [];
  for (const item of values) {
    const value = String(item || "").trim();
    if (value && !clean.includes(value)) clean.push(value);
  }
  return clean.join("；");
}

function getEnglishTitle(paper) {
  return paper["英文标题"] || paper["标题"] || paper.paper_id || "";
}

function getChineseTitle(paper) {
  return paper["中文标题"] || "";
}

function isScannedPaper(paper) {
  const value = paper?.["扫描件"] || "";
  return value === "是" || value === "疑似";
}

function shortAuthors(paper, maxAuthors = 3) {
  const raw = String(paper?.["作者"] || "").trim();
  if (!raw) return "";
  // 作者字段可能用 "；" / "，" / ", " / "; " / " and " 分隔
  const parts = raw
    .replace(/\s+and\s+/gi, "；")
    .replace(/[,，;]/g, "；")
    .split("；")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length <= maxAuthors) return parts.join("；");
  return `${parts.slice(0, maxAuthors).join("；")} 等`;
}

function paperLabel(paper) {
  const year = paper?.["年份"] || "";
  const authors = shortAuthors(paper, 3);
  return `${year} ${authors}`.trim();
}

function paperVenue(paper) {
  return String(paper?.["期刊会议"] || "").trim();
}

function paperRankManual(paper) {
  return String(paper?.["期刊等级_人工"] || "").trim();
}

function paperRankAuto(paper) {
  return String(paper?.["期刊等级_自动"] || "").trim();
}

// 「生效等级」= 人工字段非空就用人工，否则用自动
function paperEffectiveRank(paper) {
  return paperRankManual(paper) || paperRankAuto(paper);
}

// 按 label 前缀分配一个色调 class，前端 CSS 里有对应配色。
function rankChipColorClass(chip) {
  if (chip.startsWith("中科院")) return "rank-cas";
  if (chip.startsWith("SSCI")) return "rank-ssci";
  if (chip.startsWith("SCI") || chip.startsWith("AHCI")) return "rank-sci";
  if (chip.startsWith("EI")) return "rank-ei";
  if (chip.startsWith("ESI")) return "rank-esi";
  if (chip.startsWith("FMS")) return "rank-fms";
  if (chip.startsWith("UTD")) return "rank-utd";
  if (chip.startsWith("AJG") || chip.startsWith("ABS")) return "rank-ajg";
  if (chip.startsWith("CSSCI") || chip.startsWith("CSCD") || chip.startsWith("北大核心")) return "rank-cn";
  if (chip.startsWith("CCF")) return "rank-ccf";
  if (chip.startsWith("IF")) return "rank-if";
  return "rank-default";
}

// 把 "中科院1区；SSCI；FMS A" 这种字符串渲染成一组带色的 chip。
function renderRankChips(rankText, opts = {}) {
  const text = String(rankText || "").trim();
  if (!text) return "";
  const chips = text
    .split(/[；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!chips.length) return "";
  const sourceTitle = opts.sourceTitle || "";
  const titleAttr = sourceTitle ? ` title="${escapeHtml(sourceTitle)}"` : "";
  return `<span class="rank-chip-row"${titleAttr}>${chips
    .map((c) => `<span class="rank-chip ${rankChipColorClass(c)}">${escapeHtml(c)}</span>`)
    .join("")}</span>`;
}

function primaryNames() {
  return Object.keys(state.categoryTree);
}

function secondaryNames(primary) {
  const node = state.categoryTree[primary];
  if (!node) return [];
  // 兼容旧格式：可能是数组
  return Array.isArray(node) ? [...node] : Object.keys(node);
}

function tertiaryNames(primary, secondary) {
  const node = state.categoryTree[primary];
  if (!node || Array.isArray(node)) return [];
  return Array.isArray(node[secondary]) ? [...node[secondary]] : [];
}

function getConfirmedTertiaries(paper) {
  if (!paper) return [];
  return splitValues(paper["三级分类"]);
}

// 一级分类是多值：用 ；分隔。下面两组函数：plural 返回数组（推荐用），
// 单值版保留是为了旧调用方少改；单值版返回数组的第一项。
function getConfirmedPrimaries(paper) {
  if (!paper) return [];
  const raw = paper["一级分类"];
  if (raw) return splitValues(raw);
  // 旧数据可能没单独写一级，只在 最终分类 里。从 最终分类 里捞出注册过的一级名。
  const finalParts = splitValues(paper["最终分类"]);
  const names = new Set(primaryNames());
  return finalParts.filter((item) => names.has(item));
}

function getConfirmedPrimary(paper) {
  return getConfirmedPrimaries(paper)[0] || "";
}

function getDisplayPrimaries(paper) {
  const confirmed = getConfirmedPrimaries(paper);
  if (confirmed.length) return confirmed;
  return paper?.["一级分类_AI建议"] ? [paper["一级分类_AI建议"]] : [];
}

function getDisplayPrimary(paper) {
  return getDisplayPrimaries(paper)[0] || "";
}

function getConfirmedSecondaries(paper) {
  if (!paper) return [];
  if (paper["二级分类"]) return splitValues(paper["二级分类"]);
  // 没有显式的「二级分类」字段时，从「最终分类」里剔除一级名得到二级
  const primaries = new Set(getConfirmedPrimaries(paper));
  const finalParts = splitValues(paper["最终分类"]).filter((item) => !primaries.has(item));
  return finalParts;
}

function getDisplaySecondaries(paper) {
  const confirmed = getConfirmedSecondaries(paper);
  return confirmed.length ? confirmed : splitValues(paper["二级分类_AI建议"]);
}

function finalCategory(primaries, secondaries, tertiaries = []) {
  // primaries 既接受 string 又接受 string[]，让旧调用方少改
  const primaryList = Array.isArray(primaries) ? primaries : (primaries ? [primaries] : []);
  return joinUnique([...primaryList, ...secondaries, ...tertiaries]);
}

function classificationText(paper) {
  const primaries = getConfirmedPrimaries(paper);
  const secondaries = getConfirmedSecondaries(paper);
  const tertiaries = getConfirmedTertiaries(paper);
  if (primaries.length || secondaries.length || tertiaries.length) {
    return finalCategory(primaries, secondaries, tertiaries) || "未设置";
  }
  const aiPrimary = paper?.["一级分类_AI建议"] || "";
  const aiSecondaries = splitValues(paper?.["二级分类_AI建议"] || "");
  return aiPrimary ? `AI建议：${finalCategory([aiPrimary], aiSecondaries)}` : "未设置";
}

function paperBadges(paper) {
  const badges = [];
  if (paper["星标"]) badges.push("★追踪");
  for (const key of ["期刊分区", "SSCI", "SCI", "UTD", "FT50", "ABS"]) {
    const value = paper[key];
    if (value && value !== "否" && value !== "false" && value !== "0") {
      badges.push(key === "期刊分区" ? value : key);
    }
  }
  if (isScannedPaper(paper)) badges.push(paper["扫描件"] === "疑似" ? "疑似扫描件" : "扫描件");
  const primaries = getDisplayPrimaries(paper);
  const secondaries = getDisplaySecondaries(paper);
  badges.push(...primaries);
  badges.push(...secondaries.slice(0, 2));
  return splitValues(joinUnique(badges));
}

function renderBadges(paper) {
  const badges = paperBadges(paper);
  if (!badges.length) return "";
  return `<div class="badge-row">${badges.map((item) => `<span class="badge">${escapeHtml(item)}</span>`).join("")}</div>`;
}

async function loadConfig() {
  const data = await api("/api/config");
  $("modelLabel").textContent = `${data.provider} · ${data.model || "默认模型"} · ${data.count} 篇`;
}

function showProviderPanel(provider) {
  state.activeProvider = provider;
  document.querySelectorAll("#providerTabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.provider === provider);
  });
  document.querySelectorAll("[data-provider-panel]").forEach((panel) => {
    panel.classList.toggle("hidden", panel.dataset.providerPanel !== provider);
  });
}

function showSettingsTab(tab) {
  state.activeSettingsTab = tab;
  document.querySelectorAll("#settingsTabs button").forEach((button) => {
    button.classList.toggle("active", button.dataset.settingsTab === tab);
  });
  for (const name of ["model", "translation", "ocr", "vision", "easyscholar", "citations", "ui", "prompts", "journals"]) {
    const el = $(`${name}SettingsSection`);
    if (el) el.classList.toggle("hidden", name !== tab);
  }
  if (tab === "citations") {
    loadCitationManager().catch((e) => { console.error(e); notify.error("citation 加载失败：" + e.message); });
  }
  if (tab === "easyscholar") {
    loadEasyscholarSettings().catch((e) => { console.error(e); notify.error("EasyScholar 设置加载失败：" + e.message); });
  }
  if (tab === "ocr") {
    loadOcrSettings().catch((e) => { console.error(e); notify.error("OCR 设置加载失败：" + e.message); });
  }
  if (tab === "vision") {
    loadVisionSettings().catch((e) => { console.error(e); notify.error("视觉设置加载失败：" + e.message); });
  }
  if (tab === "ui") {
    populateUiSettings();
  }
}

function populateUiSettings() {
  const t = state.uiTabs || {};
  if ($("uiTabAnnot")) $("uiTabAnnot").checked = t.annot !== false;
  if ($("uiTabAi")) $("uiTabAi").checked = t.ai !== false;
  if ($("uiTabExcerpt")) $("uiTabExcerpt").checked = t.excerpt !== false;
  if ($("uiTabMeta")) $("uiTabMeta").checked = t.meta !== false;
}

function applyTabVisibility() {
  const t = state.uiTabs || {};
  const map = { annot: t.annot !== false, ai: t.ai !== false, excerpt: t.excerpt !== false, meta: t.meta !== false };
  document.querySelectorAll('#inspectorTabs .tab').forEach((btn) => {
    const name = btn.dataset.tab;
    if (name === "note") { btn.style.display = ""; return; }
    btn.style.display = map[name] ? "" : "none";
  });
  const activeBtn = document.querySelector('#inspectorTabs .tab.active');
  if (activeBtn && activeBtn.style.display === "none") {
    const noteBtn = document.querySelector('#inspectorTabs .tab[data-tab="note"]');
    if (noteBtn) noteBtn.click();
  }
}

async function saveUiSettings() {
  const tabs = {
    note: true,
    annot: $("uiTabAnnot").checked,
    ai: $("uiTabAi").checked,
    excerpt: $("uiTabExcerpt").checked,
    meta: $("uiTabMeta").checked,
  };
  const btn = $("saveUiBtn");
  const status = $("uiSaveStatus");
  btn.disabled = true;
  status.textContent = "保存中…";
  try {
    await api("/api/ui-settings", {
      method: "POST",
      body: JSON.stringify({ inspector_tabs: tabs }),
    });
    state.uiTabs = tabs;
    applyTabVisibility();
    status.textContent = "已保存，立即生效";
  } catch (e) {
    status.textContent = `保存失败：${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadUiSettings() {
  try {
    const data = await api("/api/ui-settings");
    state.uiTabs = { note: true, ...(data.inspector_tabs || {}) };
  } catch {
    // default — all visible
  }
  applyTabVisibility();
}

async function loadCitationManager() {
  const data = await api("/api/citations");
  state.citations = data.citations || [];
  const list = $("citationList");
  $("citationCount").textContent = `共 ${state.citations.length} 份`;
  list.innerHTML = "";
  for (const c of state.citations) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `citation-item${state.activeCitation === c.name ? " active" : ""}`;
    item.innerHTML = `
      <span class="citation-display">${escapeHtml(c.display_name || c.name)}</span>
      <span class="citation-name">${escapeHtml(c.name)}.md</span>
      <span class="citation-meta">${c.entry_count} 条记录 · ${c.context_chars} 字上下文</span>
    `;
    item.addEventListener("click", () => openCitationInEditor(c.name));
    list.appendChild(item);
  }
  if (state.activeCitation && state.citations.some((c) => c.name === state.activeCitation)) {
    // refresh editor contents if still focused
    openCitationInEditor(state.activeCitation, { silent: true });
  }
  // also refresh the topbar dropdown
  loadCitationList().catch(() => {});
}

async function openCitationInEditor(name, opts = {}) {
  try {
    const data = await api(`/api/citation?name=${encodeURIComponent(name)}`);
    state.activeCitation = name;
    $("citationEditorTitle").textContent = `${data.citation.display_name || name} · ${name}.md`;
    $("citationEditor").value = data.citation.raw || "";
    $("saveCitationBtn").disabled = false;
    $("deleteCitationBtn").disabled = false;
    $("citationEditorStatus").textContent = opts.silent ? "" : "已加载";
    document.querySelectorAll(".citation-item").forEach((el) => {
      const isActive = el.querySelector(".citation-name")?.textContent === `${name}.md`;
      el.classList.toggle("active", isActive);
    });
  } catch (e) {
    $("citationEditorStatus").textContent = `加载失败：${e.message}`;
  }
}

async function saveCurrentCitation() {
  if (!state.activeCitation) return;
  $("saveCitationBtn").disabled = true;
  $("citationEditorStatus").textContent = "保存中…";
  try {
    await api("/api/citation/save", {
      method: "POST",
      body: JSON.stringify({ name: state.activeCitation, raw: $("citationEditor").value }),
    });
    $("citationEditorStatus").textContent = "已保存";
    await loadCitationManager();
  } catch (e) {
    $("citationEditorStatus").textContent = `保存失败：${e.message}`;
  } finally {
    $("saveCitationBtn").disabled = false;
  }
}

async function deleteCurrentCitation() {
  if (!state.activeCitation) return;
  if (!confirm(`删除 citation 文件「${state.activeCitation}.md」？此操作不可撤销。`)) return;
  try {
    await api("/api/citation/delete", {
      method: "POST",
      body: JSON.stringify({ name: state.activeCitation }),
    });
    state.activeCitation = "";
    $("citationEditor").value = "";
    $("citationEditorTitle").textContent = "选择左侧文件开始编辑";
    $("saveCitationBtn").disabled = true;
    $("deleteCitationBtn").disabled = true;
    $("citationEditorStatus").textContent = "已删除";
    await loadCitationManager();
  } catch (e) {
    $("citationEditorStatus").textContent = `删除失败：${e.message}`;
  }
}

async function createCitation() {
  const name = $("newCitationName").value.trim();
  const display = $("newCitationDisplay").value.trim();
  if (!name) {
    $("citationEditorStatus").textContent = "请填写文件名";
    return;
  }
  try {
    const data = await api("/api/citation", {
      method: "POST",
      body: JSON.stringify({ name, display_name: display }),
    });
    $("newCitationName").value = "";
    $("newCitationDisplay").value = "";
    state.activeCitation = data.citation.name;
    await loadCitationManager();
    openCitationInEditor(data.citation.name);
  } catch (e) {
    $("citationEditorStatus").textContent = `创建失败：${e.message}`;
  }
}

function showTranslationProviderPanel(provider) {
  state.activeTranslationProvider = provider;
  document.querySelectorAll("#translationProviderTabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.transProvider === provider);
  });
  document.querySelectorAll("[data-trans-panel]").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.transPanel !== provider);
  });
}

async function loadTranslationSettings() {
  const data = await api("/api/translation-settings");
  $("translationOllamaUrl").value = data.ollama?.base_url || "";
  $("translationOllamaModel").value = data.ollama?.model || "";
  $("translationOllamaTimeout").value = data.ollama?.timeout_seconds || 120;
  $("translationOpenaiUrl").value = data.openai_compatible?.base_url || "";
  $("translationOpenaiModel").value = data.openai_compatible?.model || "";
  $("translationOpenaiKeyEnv").value = data.openai_compatible?.api_key_env || "OPENAI_API_KEY";
  $("translationOpenaiApiKey").value = "";
  $("translationOpenaiApiKey").placeholder = data.openai_compatible?.has_api_key ? "已配置，留空不修改" : "尚未配置";
  $("translationOpenaiTimeout").value = data.openai_compatible?.timeout_seconds || 60;
  showTranslationProviderPanel(data.provider || "ollama");
  $("translationStatus").textContent = "";
}

async function saveTranslationSettings() {
  $("saveTranslationBtn").disabled = true;
  $("translationStatus").textContent = "保存中";
  try {
    await api("/api/translation-settings", {
      method: "POST",
      body: JSON.stringify({
        provider: state.activeTranslationProvider || "ollama",
        ollama: {
          base_url: $("translationOllamaUrl").value,
          model: $("translationOllamaModel").value,
          timeout_seconds: $("translationOllamaTimeout").value,
        },
        openai_compatible: {
          base_url: $("translationOpenaiUrl").value,
          model: $("translationOpenaiModel").value,
          api_key_env: $("translationOpenaiKeyEnv").value,
          api_key: $("translationOpenaiApiKey").value,
          timeout_seconds: $("translationOpenaiTimeout").value,
        },
      }),
    });
    $("translationOpenaiApiKey").value = "";
    $("translationStatus").textContent = "已保存";
    await loadTranslationSettings();
  } catch (error) {
    $("translationStatus").textContent = error.message;
  } finally {
    $("saveTranslationBtn").disabled = false;
  }
}

async function loadEasyscholarSettings() {
  try {
    const data = await api("/api/easyscholar/settings");
    $("easyscholarEnabled").checked = !!data.enabled;
    $("easyscholarKeyEnv").value = data.api_key_env || "EASYSCHOLAR_SECRET_KEY";
    $("easyscholarApiKey").value = "";
    $("easyscholarApiKey").placeholder = data.has_api_key ? "已配置，留空不修改" : "尚未配置";
    // 渲染可勾选字段
    const fields = Array.isArray(data.available_fields) ? data.available_fields : [];
    const enabled = new Set(Array.isArray(data.enabled_fields) ? data.enabled_fields : []);
    const grid = $("easyscholarFieldList");
    if (grid) {
      grid.innerHTML = fields
        .map((field) => `
          <label class="checkline">
            <input type="checkbox" data-field="${escapeHtml(field.key)}" ${enabled.has(field.key) ? "checked" : ""} />
            <span>${escapeHtml(field.label)} <span class="muted" style="font-size:10px">${escapeHtml(field.key)}</span></span>
          </label>
        `)
        .join("");
    }
    $("easyscholarStatus").textContent = "";
    refreshRefreshRankBtnState();
  } catch (e) {
    $("easyscholarStatus").textContent = `加载失败：${e.message}`;
  }
}

function collectEnabledFields() {
  const grid = $("easyscholarFieldList");
  if (!grid) return [];
  return Array.from(grid.querySelectorAll("input[type=checkbox]"))
    .filter((cb) => cb.checked)
    .map((cb) => cb.dataset.field);
}

async function loadOcrSettings() {
  try {
    const data = await api("/api/settings");
    const ocr = data.ocr || {};
    if ($("ocrEnabled")) $("ocrEnabled").checked = ocr.enabled !== false;
    if ($("ocrEngine")) $("ocrEngine").value = ocr.engine || "rapidocr";
    if ($("ocrTriggerThreshold")) $("ocrTriggerThreshold").value = ocr.trigger_threshold || 500;
    if ($("ocrMaxPages")) $("ocrMaxPages").value = ocr.max_pages || 30;
    const cloud = ocr.cloud || {};
    if ($("ocrCloudBaseUrl")) $("ocrCloudBaseUrl").value = cloud.base_url || "";
    if ($("ocrCloudModel")) $("ocrCloudModel").value = cloud.model || "";
    if ($("ocrCloudKeyEnv")) $("ocrCloudKeyEnv").value = cloud.api_key_env || "";
    if ($("ocrCloudTimeout")) $("ocrCloudTimeout").value = cloud.timeout_seconds || 90;
    if ($("ocrCloudApiKey")) {
      $("ocrCloudApiKey").value = "";
      $("ocrCloudApiKey").placeholder = cloud.has_api_key ? "已配置，留空不修改" : "尚未配置";
    }
    // Available-engine hint
    const hint = $("ocrAvailHint");
    if (hint) {
      const avail = ocr.available || {};
      const parts = [];
      parts.push(avail.rapidocr ? "✓ rapidocr 已安装" : "✗ rapidocr 未安装（pip install rapidocr-onnxruntime）");
      parts.push(avail.easyocr ? "✓ easyocr 已安装" : "✗ easyocr 未安装（pip install easyocr）");
      hint.textContent = parts.join(" · ");
    }
  } catch (e) {
    if ($("ocrStatus")) $("ocrStatus").textContent = `加载失败：${e.message}`;
  }
}

async function saveOcrSettings() {
  if (!$("saveOcrBtn")) return;
  $("saveOcrBtn").disabled = true;
  $("ocrStatus").textContent = "保存中…";
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        provider: state.activeProvider,  // keep current provider intact
        ocr: {
          enabled: $("ocrEnabled").checked,
          engine: $("ocrEngine").value,
          trigger_threshold: $("ocrTriggerThreshold").value,
          max_pages: $("ocrMaxPages").value,
          cloud: {
            base_url: $("ocrCloudBaseUrl")?.value || "",
            model: $("ocrCloudModel")?.value || "",
            api_key_env: $("ocrCloudKeyEnv")?.value || "",
            api_key: $("ocrCloudApiKey")?.value || "",
            timeout_seconds: $("ocrCloudTimeout")?.value || "",
          },
        },
      }),
    });
    if ($("ocrCloudApiKey")) $("ocrCloudApiKey").value = "";
    $("ocrStatus").textContent = "已保存";
    await loadOcrSettings();
  } catch (e) {
    $("ocrStatus").textContent = `失败：${e.message}`;
  } finally {
    $("saveOcrBtn").disabled = false;
  }
}

async function loadVisionSettings() {
  try {
    const data = await api("/api/settings");
    const v = data.vision || {};
    const provider = v.provider || "qwen_vl";
    if ($("visionProvider")) $("visionProvider").value = provider;
    const qwen = v.qwen_vl || {};
    if ($("visionQwenBaseUrl")) $("visionQwenBaseUrl").value = qwen.base_url || "";
    if ($("visionQwenModel")) $("visionQwenModel").value = qwen.model || "";
    if ($("visionQwenKeyEnv")) $("visionQwenKeyEnv").value = qwen.api_key_env || "";
    if ($("visionQwenTimeout")) $("visionQwenTimeout").value = qwen.timeout_seconds || 90;
    if ($("visionQwenApiKey")) {
      $("visionQwenApiKey").value = "";
      $("visionQwenApiKey").placeholder = qwen.has_api_key ? "已配置，留空不修改" : "尚未配置";
    }
    const oai = v.openai_vision || {};
    if ($("visionOpenaiBaseUrl")) $("visionOpenaiBaseUrl").value = oai.base_url || "";
    if ($("visionOpenaiModel")) $("visionOpenaiModel").value = oai.model || "";
    if ($("visionOpenaiKeyEnv")) $("visionOpenaiKeyEnv").value = oai.api_key_env || "";
    if ($("visionOpenaiTimeout")) $("visionOpenaiTimeout").value = oai.timeout_seconds || 90;
    if ($("visionOpenaiApiKey")) {
      $("visionOpenaiApiKey").value = "";
      $("visionOpenaiApiKey").placeholder = oai.has_api_key ? "已配置，留空不修改" : "尚未配置";
    }
    const claude = v.claude_cli || {};
    if ($("visionClaudeCurrentModel")) $("visionClaudeCurrentModel").textContent = claude.model || "claude-sonnet-4-5";
    // Active hint
    const hint = $("visionActiveHint");
    if (hint) {
      const subKeyOk = {
        qwen_vl: qwen.has_api_key,
        openai_vision: oai.has_api_key,
        claude_cli: claude.has_api_key,
      }[provider];
      const subModel = {
        qwen_vl: qwen.model,
        openai_vision: oai.model,
        claude_cli: claude.model,
      }[provider];
      hint.textContent = subKeyOk
        ? `当前激活：${provider} · ${subModel || "(未填模型)"} · API key 已配置`
        : `当前激活：${provider} · ${subModel || "(未填模型)"} · ⚠ API key 未配置，请在下方填写`;
    }
    // Show the matching sub-panel
    showVisionPanel(provider);
  } catch (e) {
    if ($("visionStatus")) $("visionStatus").textContent = `加载失败：${e.message}`;
  }
}

function showVisionPanel(name) {
  document.querySelectorAll("#visionProviderTabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.visionPanel === name);
  });
  document.querySelectorAll("[data-vision-panel-section]").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.visionPanelSection !== name);
  });
}

async function saveVisionSettings() {
  if (!$("saveVisionBtn")) return;
  $("saveVisionBtn").disabled = true;
  $("visionStatus").textContent = "保存中…";
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        provider: state.activeProvider,
        vision: {
          provider: $("visionProvider")?.value || "qwen_vl",
          qwen_vl: {
            base_url: $("visionQwenBaseUrl")?.value || "",
            model: $("visionQwenModel")?.value || "",
            api_key_env: $("visionQwenKeyEnv")?.value || "",
            api_key: $("visionQwenApiKey")?.value || "",
            timeout_seconds: $("visionQwenTimeout")?.value || "",
          },
          openai_vision: {
            base_url: $("visionOpenaiBaseUrl")?.value || "",
            model: $("visionOpenaiModel")?.value || "",
            api_key_env: $("visionOpenaiKeyEnv")?.value || "",
            api_key: $("visionOpenaiApiKey")?.value || "",
            timeout_seconds: $("visionOpenaiTimeout")?.value || "",
          },
        },
      }),
    });
    if ($("visionQwenApiKey")) $("visionQwenApiKey").value = "";
    if ($("visionOpenaiApiKey")) $("visionOpenaiApiKey").value = "";
    $("visionStatus").textContent = "已保存";
    await loadVisionSettings();
  } catch (e) {
    $("visionStatus").textContent = `失败：${e.message}`;
  } finally {
    $("saveVisionBtn").disabled = false;
  }
}

async function saveEasyscholarSettings() {
  $("saveEasyscholarBtn").disabled = true;
  $("easyscholarStatus").textContent = "保存中…";
  try {
    await api("/api/easyscholar/settings", {
      method: "POST",
      body: JSON.stringify({
        enabled: $("easyscholarEnabled").checked,
        api_key_env: $("easyscholarKeyEnv").value,
        api_key: $("easyscholarApiKey").value,
        enabled_fields: collectEnabledFields(),
      }),
    });
    $("easyscholarApiKey").value = "";
    $("easyscholarStatus").textContent = "已保存";
    await loadEasyscholarSettings();
  } catch (e) {
    $("easyscholarStatus").textContent = `失败：${e.message}`;
  } finally {
    $("saveEasyscholarBtn").disabled = false;
  }
}

async function refreshRankCurrentPaper() {
  if (!state.selected) return;
  const btn = $("refreshRankBtn");
  if (!btn) return;
  const forceRefresh = false; // 默认走缓存；按住 shift 时强制刷新
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "查询中…";
  try {
    const data = await api("/api/easyscholar/refresh", {
      method: "POST",
      body: JSON.stringify({
        paper_id: state.selected.paper_id,
        force_refresh: forceRefresh,
        apply: true,
      }),
    });
    state.selected = data.paper;
    renderSelected();
    await loadPapers();
    const lines = [
      `期刊：${data.venue || ""}`,
      `EasyScholar 返回：${data.summary || "（空）"}`,
    ];
    if (data.changed) {
      if (data.before) {
        lines.push(`\n「期刊等级_自动」已更新：`, `  原：${data.before}`, `  新：${data.level_text}`);
      } else {
        lines.push(`\n「期刊等级_自动」首次写入：${data.level_text}`);
      }
    } else if ((data.level_text || "").trim()) {
      lines.push(`\n「期刊等级_自动」未变（与上次相同）。`);
    } else {
      lines.push(`\nEasyScholar 在你勾选的字段下没有返回内容。可去设置里多勾几个字段试试。`);
    }
    const manualVal = (state.selected["期刊等级_人工"] || "").trim();
    if (manualVal) {
      lines.push(`\n注意：当前「期刊等级_人工」非空（${manualVal}），列表/上方显示用的是人工值。`);
    }
    btn.textContent = data.changed ? "已更新 ✓" : "查询完成";
    setTimeout(() => alert(lines.join("\n")), 50);
    setTimeout(() => { btn.textContent = originalText; btn.disabled = !state.selected; }, 1800);
  } catch (e) {
    btn.textContent = originalText;
    btn.disabled = !state.selected;
    alert(`刷新期刊等级失败：${e.message}`);
  }
}

function refreshRefreshRankBtnState() {
  const btn = $("refreshRankBtn");
  if (btn) btn.disabled = !state.selected;
}

function openExportCategoryModal() {
  // 用现有分类计数 API 填充下拉
  const select = $("exportCategorySelect");
  if (!select) return;
  select.innerHTML = "";
  // 把分类树按层级铺出来 + 兜底列入「未挂在树里但有文献用到」的分类
  const tree = state.categoryTree || {};
  const seen = new Set();
  const addOption = (value, label) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    select.appendChild(opt);
  };
  for (const [primary, node] of Object.entries(tree)) {
    addOption(primary, `一级：${primary}`);
    const secs = Array.isArray(node) ? node.map((s) => [s, []]) : Object.entries(node || {});
    for (const [sec, terts] of secs) {
      addOption(sec, `　二级：${sec}（@${primary}）`);
      for (const tert of terts || []) {
        addOption(tert, `　　三级：${tert}（@${sec}）`);
      }
    }
  }
  // 其它分类（出现在 state.categories 但不在树里）
  for (const name of state.categories || []) {
    if (!seen.has(name)) addOption(name, name);
  }
  $("exportCategoryStatus").textContent = "";
  $("exportCategoryResult").textContent = "";
  $("exportCategoryModal").classList.remove("hidden");
}

async function runExportCategory() {
  const category = $("exportCategorySelect").value;
  if (!category) {
    $("exportCategoryStatus").textContent = "请先选一个分类";
    return;
  }
  const btn = $("runExportCategoryBtn");
  btn.disabled = true;
  $("exportCategoryStatus").textContent = "导出中…（文件多时可能要几十秒）";
  $("exportCategoryResult").textContent = "";
  try {
    const data = await api("/api/export/category", {
      method: "POST",
      body: JSON.stringify({ category, match_mode: "exact" }),
    });
    $("exportCategoryStatus").textContent = `完成：${data.matched} 篇`;
    const lines = [
      `导出目录：${data.out_dir_rel}`,
      `  PDF：${data.pdf_ok} 个（在 ${data.pdf_dir_rel}/）`,
      `  笔记：${data.note_ok} 个（在 ${data.note_dir_rel}/）`,
    ];
    if ((data.pdf_missing || []).length) lines.push(`  缺 PDF：${data.pdf_missing.length} 篇`);
    if ((data.note_missing || []).length) lines.push(`  缺笔记：${data.note_missing.length} 篇`);
    $("exportCategoryResult").textContent = lines.join("\n");
  } catch (e) {
    $("exportCategoryStatus").textContent = `失败：${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function refreshRankAll() {
  const btn = $("refreshRankAllBtn");
  if (!btn) return;
  const onlyEmpty = confirm(
    "批量刷新期刊等级\n\n" +
    "点「确定」：只查询「期刊等级_自动」为空的文献（推荐，节省 EasyScholar 配额）\n" +
    "点「取消」后再选 OK：刷新全部文献（即使已有自动等级也重查）\n\n" +
    "注意：手工填写的「期刊等级_人工」字段永远不会被覆盖。"
  );
  let force = false;
  if (!onlyEmpty) {
    if (!confirm("确认刷新全部文献（即使已有自动等级也会重查）？这会消耗较多 EasyScholar 配额。")) {
      return;
    }
    force = true;
  }
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "批量查询中…";
  try {
    const data = await api("/api/easyscholar/refresh-all", {
      method: "POST",
      body: JSON.stringify({
        only_empty: onlyEmpty,
        force_refresh: force,
      }),
    });
    const lines = [
      `共 ${data.total} 篇`,
      `查询成功：${data.queried_ok} 篇 · 实际写入变化：${data.changed} 篇`,
      `跳过（已有自动等级）：${data.skipped_already_filled} 篇`,
      `跳过（无期刊会议字段）：${data.skipped_empty_venue} 篇`,
      `失败：${data.failed_count} 篇`,
    ];
    if ((data.failed_sample || []).length) {
      lines.push("\n失败样例（最多 20 条）：");
      for (const item of data.failed_sample) {
        lines.push(`  ${item.paper_id} | ${item.venue} → ${item.error}`);
      }
    }
    btn.textContent = "完成 ✓";
    await loadPapers();
    if (state.selected) {
      const paperData = await api(`/api/paper?paper_id=${encodeURIComponent(state.selected.paper_id)}`);
      state.selected = paperData.paper;
      renderSelected();
    }
    setTimeout(() => alert(lines.join("\n")), 50);
  } catch (e) {
    alert(`批量刷新失败：${e.message}`);
  } finally {
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1200);
  }
}

function setProviderValues(provider, item = {}) {
  const ids = providerIds[provider];
  if (!ids) return;
  $(ids.base_url).value = item.base_url || "";
  $(ids.model).value = item.model || "";
  $(ids.api_key_env).value = item.api_key_env || "";
  $(ids.api_key).value = "";
  $(ids.api_key).placeholder = item.has_api_key ? "已配置，留空不修改" : "尚未配置";
}

function getProviderValues(provider) {
  const ids = providerIds[provider];
  return {
    base_url: $(ids.base_url).value,
    model: $(ids.model).value,
    api_key_env: $(ids.api_key_env).value,
    api_key: $(ids.api_key).value,
  };
}

async function loadSettings() {
  const data = await api("/api/settings");
  setProviderValues("deepseek", data.provider_settings?.deepseek || {});
  setProviderValues("qwen", data.provider_settings?.qwen || {});
  setProviderValues("openai_compatible", data.provider_settings?.openai_compatible || {});
  $("codexCommand").value = data.codex_cli.command || "";
  $("codexModel").value = data.codex_cli.model || "";
  $("codexSandbox").value = data.codex_cli.sandbox || "read-only";
  $("codexTimeout").value = data.codex_cli.timeout_seconds || 180;
  const claudeCfg = data.claude_cli || {};
  if ($("claudeCommand")) $("claudeCommand").value = claudeCfg.command || "";
  if ($("claudeModel")) $("claudeModel").value = claudeCfg.model || "";
  if ($("claudeTimeout")) $("claudeTimeout").value = claudeCfg.timeout_seconds || 240;
  if ($("claudeApiKey")) {
    $("claudeApiKey").value = "";
    $("claudeApiKey").placeholder = claudeCfg.has_api_key
      ? "已配置 ANTHROPIC_API_KEY，留空不修改"
      : "可走 claude login，无需填这里";
  }
  showProviderPanel(data.api.provider || "deepseek");
  showSettingsTab(state.activeSettingsTab || "model");
}

async function saveSettings() {
  $("saveSettingsBtn").disabled = true;
  $("settingsStatus").textContent = "保存中";
  try {
    await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        provider: state.activeProvider,
        provider_settings: {
          deepseek: getProviderValues("deepseek"),
          qwen: getProviderValues("qwen"),
          openai_compatible: getProviderValues("openai_compatible"),
        },
        codex_cli: {
          command: $("codexCommand").value,
          model: $("codexModel").value,
          sandbox: $("codexSandbox").value,
          timeout_seconds: $("codexTimeout").value,
        },
        claude_cli: {
          command: $("claudeCommand") ? $("claudeCommand").value : "",
          model: $("claudeModel") ? $("claudeModel").value : "",
          timeout_seconds: $("claudeTimeout") ? $("claudeTimeout").value : "",
          api_key: $("claudeApiKey") ? $("claudeApiKey").value : "",
        },
      }),
    });
    for (const ids of Object.values(providerIds)) $(ids.api_key).value = "";
    if ($("claudeApiKey")) $("claudeApiKey").value = "";
    $("settingsStatus").textContent = "已保存";
    await loadConfig();
    await loadSettings();
  } catch (error) {
    $("settingsStatus").textContent = error.message;
  } finally {
    $("saveSettingsBtn").disabled = false;
  }
}

async function loadPrompts() {
  const data = await api("/api/prompts");
  $("notePromptEditor").value = data.note_prompt || "";
  $("classifyPromptEditor").value = data.classify_prompt || "";
  $("noteTemplateEditor").value = data.note_template || "";
  $("promptsStatus").textContent = "";
}

async function savePrompts() {
  $("savePromptsBtn").disabled = true;
  $("promptsStatus").textContent = "保存中";
  try {
    await api("/api/prompts", {
      method: "POST",
      body: JSON.stringify({
        note_prompt: $("notePromptEditor").value,
        classify_prompt: $("classifyPromptEditor").value,
        note_template: $("noteTemplateEditor").value,
      }),
    });
    $("promptsStatus").textContent = "已保存，下次整理新文献时生效";
  } catch (error) {
    $("promptsStatus").textContent = error.message;
  } finally {
    $("savePromptsBtn").disabled = false;
  }
}

function optionHtml(value, label, current) {
  return `<option value="${escapeHtml(value)}" ${String(current || "") === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderTrackingJournals() {
  const container = $("journalRows");
  container.innerHTML = "";
  state.trackingJournals.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "journal-row";
    row.dataset.index = String(index);
    row.innerHTML = `
      <input data-field="field" value="${escapeHtml(entry.field || "")}" placeholder="领域口径" />
      <input data-field="name" value="${escapeHtml(entry.name || "")}" placeholder="期刊名称" />
      <select data-field="ft50">
        ${optionHtml("", "否/空", entry.ft50)}
        ${optionHtml("是", "是", entry.ft50)}
      </select>
      <select data-field="utd">
        ${optionHtml("", "否/空", entry.utd)}
        ${optionHtml("是", "是", entry.utd)}
      </select>
      <select data-field="abs">
        ${optionHtml("", "否/空", entry.abs)}
        ${optionHtml("是", "是", entry.abs)}
        ${optionHtml("需核验", "需核验", entry.abs)}
      </select>
      <input data-field="abs_subject" value="${escapeHtml(entry.abs_subject || "")}" placeholder="ABS学科" />
      <button class="secondary danger" type="button">删除</button>
    `;
    row.querySelectorAll("input, select").forEach((input) => {
      input.addEventListener("input", () => {
        state.trackingJournals[index][input.dataset.field] = input.value;
      });
      input.addEventListener("change", () => {
        state.trackingJournals[index][input.dataset.field] = input.value;
      });
    });
    row.querySelector("button").addEventListener("click", () => {
      state.trackingJournals.splice(index, 1);
      renderTrackingJournals();
    });
    container.appendChild(row);
  });
}

async function loadTrackingJournals() {
  const data = await api("/api/tracking-journals");
  state.trackingJournals = data.entries || [];
  $("journalsStatus").textContent = `${data.path || "list.xlsx"} · ${data.count || 0} 条`;
  renderTrackingJournals();
}

function addTrackingJournal() {
  state.trackingJournals.unshift({ field: "", name: "", ft50: "", utd: "", abs: "", abs_subject: "" });
  renderTrackingJournals();
}

function collectTrackingJournals() {
  return state.trackingJournals
    .map((item) => ({
      field: String(item.field || "").trim(),
      name: String(item.name || "").trim(),
      ft50: String(item.ft50 || "").trim(),
      utd: String(item.utd || "").trim(),
      abs: String(item.abs || "").trim(),
      abs_subject: String(item.abs_subject || "").trim(),
    }))
    .filter((item) => item.name);
}

async function saveTrackingJournals() {
  $("saveJournalsBtn").disabled = true;
  $("journalsStatus").textContent = "保存中";
  try {
    const data = await api("/api/tracking-journals", {
      method: "POST",
      body: JSON.stringify({ entries: collectTrackingJournals() }),
    });
    $("journalsStatus").textContent = `已保存 ${data.count} 条 · 星标 ${data.starred} 篇`;
    await loadConfig();
    await loadCategories();
    await loadPapers();
    await loadTrackingJournals();
  } catch (error) {
    $("journalsStatus").textContent = error.message;
  } finally {
    $("saveJournalsBtn").disabled = false;
  }
}

async function loadCategoryTree() {
  const data = await api("/api/category-tree");
  state.categoryTree = data.tree || {};
  if (!state.treeSelectedPrimary || !state.categoryTree[state.treeSelectedPrimary]) {
    state.treeSelectedPrimary = primaryNames()[0] || "";
  }
  renderCategoryTree();
}

async function saveCategoryTree(quiet = false) {
  $("treeSaveStatus").textContent = "保存中";
  await api("/api/category-tree", {
    method: "POST",
    body: JSON.stringify({ tree: state.categoryTree }),
  });
  $("treeSaveStatus").textContent = quiet ? "分类体系已保存" : "已保存分类体系";
  await loadCategoryTree();
  await loadCategories();
  if (state.selected) renderSelected();
}

async function loadCategories() {
  const data = await api("/api/categories");
  state.categories = data.categories.map((item) => item.name);
  const counts = new Map(data.categories.map((item) => [item.name, item.count]));
  const treeNames = new Set();
  const select = $("categorySelect");
  // 保留当前筛选值，重建后还原(避免分类完/整理完跳回"全部分类")
  const prevValue = select.value;
  select.innerHTML = `
    <option value="">全部分类</option>
    <option value="__uncategorized">未分类（无任何分类标签）</option>
    <option value="__only_ai">仅有 AI 建议（人工未确认）</option>
  `;
  const datalist = $("categoryOptions");
  datalist.innerHTML = "";

  for (const [primary, node] of Object.entries(state.categoryTree)) {
    treeNames.add(primary);
    const group = document.createElement("optgroup");
    group.label = primary;
    const allOption = document.createElement("option");
    allOption.value = primary;
    allOption.textContent = `全部：${primary} (${counts.get(primary) || 0})`;
    group.appendChild(allOption);
    // 兼容旧 list 格式（理论上后端已经 normalize 成 dict，但保险一下）
    const secondaryEntries = Array.isArray(node)
      ? node.map((s) => [s, []])
      : Object.entries(node || {});
    for (const [secondary, tertiaries] of secondaryEntries) {
      treeNames.add(secondary);
      const option = document.createElement("option");
      option.value = secondary;
      option.textContent = `二级：${secondary} (${counts.get(secondary) || 0})`;
      group.appendChild(option);
      for (const tertiary of tertiaries || []) {
        treeNames.add(tertiary);
        const tOption = document.createElement("option");
        tOption.value = tertiary;
        tOption.textContent = `　　三级：${tertiary} (${counts.get(tertiary) || 0})`;
        group.appendChild(tOption);
      }
    }
    select.appendChild(group);
  }

  const otherItems = data.categories.filter((item) => !treeNames.has(item.name));
  if (otherItems.length) {
    const otherGroup = document.createElement("optgroup");
    otherGroup.label = "其他";
    for (const item of otherItems) {
      const option = document.createElement("option");
      option.value = item.name;
      option.textContent = `${item.name} (${item.count})`;
      otherGroup.appendChild(option);
    }
    select.appendChild(otherGroup);
  }

  for (const item of data.categories) {
    const dataOption = document.createElement("option");
    dataOption.value = item.name;
    datalist.appendChild(dataOption);
  }
  // 还原此前选择的分类(如果重建后仍存在)
  if (prevValue) {
    const stillExists = Array.from(select.options).some((opt) => opt.value === prevValue);
    if (stillExists) select.value = prevValue;
  }
}

async function loadPapers() {
  const search = encodeURIComponent($("searchInput").value.trim());
  const category = encodeURIComponent($("categorySelect").value.trim());
  const readStatus = encodeURIComponent($("readStatusFilter").value.trim());
  const importance = encodeURIComponent($("importanceFilter").value.trim());
  const sortValue = ($("sortSelect")?.value || "added:desc").trim();
  const [sortBy, sortOrder] = sortValue.includes(":") ? sortValue.split(":") : ["added", "desc"];
  const data = await api(
    `/api/papers?search=${search}&category=${category}&read_status=${readStatus}&importance=${importance}&sort_by=${encodeURIComponent(sortBy)}&sort_order=${encodeURIComponent(sortOrder)}`
  );
  state.papers = data.papers;
  state.total = data.total;
  renderPaperList(data.count, data.total);
  if (state.selected && !data.papers.some((paper) => paper.paper_id === state.selected.paper_id)) {
    state.selected = null;
  }
  if (!state.selected && data.papers.length) {
    selectPaper(data.papers[0].paper_id);
  } else if (!data.papers.length) {
    clearSelectedView();
  }
}

function renderPaperList(count, total) {
  $("paperCount").textContent = `${count} / ${total} 篇`;
  const list = $("paperList");
  list.innerHTML = "";
  for (const paper of state.papers) {
    const item = document.createElement("button");
    item.className = `paper-item${state.selected?.paper_id === paper.paper_id ? " active" : ""}`;
    item.setAttribute("data-paper-id", paper.paper_id);  // hook for hover-preview
    const venue = paperVenue(paper);
    const rank = paperEffectiveRank(paper);
    const rankSource = paperRankManual(paper) ? "人工等级" : (paperRankAuto(paper) ? "自动等级" : "");
    item.innerHTML = `
      <div class="paper-title">${escapeHtml(getEnglishTitle(paper))}</div>
      <div class="paper-sub">${escapeHtml(paperLabel(paper))}</div>
      ${getChineseTitle(paper) ? `<div class="paper-title-zh">${escapeHtml(getChineseTitle(paper))}</div>` : ""}
      ${venue ? `<div class="paper-venue">${escapeHtml(venue)}</div>` : ""}
      ${renderRankChips(rank, { sourceTitle: rankSource })}
      ${renderBadges(paper)}
    `;
    item.addEventListener("click", () => selectPaper(paper.paper_id));
    list.appendChild(item);
  }
}

async function selectPaper(paperId) {
  // CRITICAL: flush any pending autosave for the CURRENT paper BEFORE
  // switching state.selected. Without this, a debounced save fires after
  // state.selected has already been swapped → POST writes new paper_id +
  // old textarea content → wrong note overwritten.
  if (state.pendingNoteSave) {
    await flushAutosave();
  }
  const paperData = await api(`/api/paper?paper_id=${encodeURIComponent(paperId)}`);
  state.selected = paperData.paper;
  const noteData = await api(`/api/note?paper_id=${encodeURIComponent(paperId)}`);
  state.note = noteData.content;
  state.editingStickyId = "";
  renderSelected();
  renderPaperList(state.papers.length, state.total);
  // 便签独立请求，失败也不影响其他面板
  loadStickies().catch((e) => {
    console.error("loadStickies failed", e);
    notify.error("加载便签失败：" + e.message);
  });
  // 加载这篇文献的历史对话
  loadChatHistoryFor(paperId).catch((e) => {
    console.error("loadChatHistory failed", e);
    notify.error("加载历史对话失败：" + e.message);
  });
}

function setCheck(id, value) {
  $(id).checked = Boolean(value && value !== "否" && value !== "false" && value !== "0");
}

function renderClassificationBox(paper) {
  $("classificationSummary").textContent = classificationText(paper);
  const confirmed = getConfirmedPrimary(paper) || getConfirmedSecondaries(paper).length;
  $("classificationHint").textContent = confirmed
    ? "点击调整分类或编辑分类体系"
    : "尚未人工确认，点击采用/修改 AI 建议";
}

function renderSelected() {
  const paper = state.selected;
  if (!paper) return;
  state.rendering = true;
  $("paperTitle").textContent = getEnglishTitle(paper);
  $("paperMeta").textContent = paperLabel(paper);
  const venueLine = $("paperVenueLine");
  if (venueLine) {
    const venue = paperVenue(paper);
    const quartile = String(paper["期刊分区"] || "").trim();
    const parts = [];
    if (venue) parts.push(venue);
    if (quartile) parts.push(quartile);
    venueLine.textContent = parts.join(" · ");
  }
  const rankLine = $("paperRankLine");
  if (rankLine) {
    const rank = paperEffectiveRank(paper);
    const source = paperRankManual(paper) ? "人工等级（永不被自动刷新覆盖）" : (paperRankAuto(paper) ? "EasyScholar 自动等级" : "");
    rankLine.innerHTML = renderRankChips(rank, { sourceTitle: source });
  }
  $("openPdfLink").href = paper.pdf_url;
  $("deletePaperBtn").disabled = false;
  const helpReadBtn = $("helpReadBtn");
  if (helpReadBtn) helpReadBtn.disabled = false;
  const refreshRankBtn = $("refreshRankBtn");
  if (refreshRankBtn) refreshRankBtn.disabled = false;
  const helpCiteBtn = $("helpCiteBtn");
  if (helpCiteBtn) helpCiteBtn.disabled = !(state.citations || []).length;
  if (state.viewer) {
    state.viewer.load(paper.paper_id, paper.pdf_url).catch((err) =>
      console.error("viewer load failed", err)
    );
  }
  // text reader is kept hidden; translation now works directly on the PDF text layer
  $("textReader").classList.add("hidden");
  $("noteEditor").value = state.note;
  $("notePreview").innerHTML = `<p>${markdownLite(state.note)}</p>`;
  $("noteSaveStatus").textContent = "";

  $("titleEn").value = paper["英文标题"] || paper["标题"] || "";
  $("titleZh").value = paper["中文标题"] || "";
  $("venue").value = paper["期刊会议"] || "";
  $("journalQuartile").value = paper["期刊分区"] || "";
  if ($("journalRankManual")) $("journalRankManual").value = paperRankManual(paper);
  if ($("journalRankAuto")) {
    const autoVal = paperRankAuto(paper);
    if (autoVal) {
      $("journalRankAuto").innerHTML = `<span class="muted">EasyScholar 自动：</span>${renderRankChips(autoVal)}`;
    } else {
      $("journalRankAuto").innerHTML = '<span class="muted">EasyScholar 自动：—（未查询过，可点顶栏「刷新等级」）</span>';
    }
  }
  setCheck("flagSSCI", paper["SSCI"]);
  setCheck("flagSCI", paper["SCI"]);
  setCheck("flagUTD", paper["UTD"]);
  setCheck("flagFT50", paper["FT50"]);
  setCheck("flagABS", paper["ABS"]);
  renderClassificationBox(paper);
  $("importance").value = paper["重要性"] || "";
  $("readStatus").value = paper["阅读状态"] || "";
  $("myRemark").value = paper["我的备注"] || "";
  $("metaSaveStatus").textContent = "";
  // Hide AI 一级/二级 once the user has confirmed a primary category — the
  // AI suggestion is only useful while the paper is still uncategorized.
  const humanConfirmed = !!(paper["一级分类"] || "").trim();
  const aiRows = humanConfirmed
    ? ""
    : `
      <dt>AI一级</dt><dd>${escapeHtml(paper["一级分类_AI建议"] || "")}</dd>
      <dt>AI二级</dt><dd>${escapeHtml(paper["二级分类_AI建议"] || "")}</dd>
    `;
  $("aiMeta").innerHTML = `
    ${aiRows}
    <dt>关键词</dt><dd>${escapeHtml(paper["关键词"] || "")}</dd>
    <dt>方法</dt><dd>${escapeHtml(paper["研究方法"] || "")}</dd>
    <dt>追踪期刊</dt><dd>${escapeHtml(paper["星标"] ? `${paper["星标"]} ${paper["追踪期刊领域"] || ""}` : "")}</dd>
    <dt>DOI</dt><dd>${escapeHtml(paper["DOI"] || "")}</dd>
  `;
  $("aiAnswer").textContent = "";
  $("appendContent").value = "";
  $("appendTitle").value = "AI 问答记录";
  $("aiStatus").textContent = "";
  $("imageAskToggle").checked = isScannedPaper(paper);
  $("imagePageInput").value = isScannedPaper(paper) ? ($("imagePageInput").value || "1") : "";
  $("imageAskHint").textContent = isScannedPaper(paper)
    ? `这篇已标记为${paper["扫描件"] === "疑似" ? "疑似扫描件" : "扫描件"}，提问时可指定页码让 AI 读页面图片。`
    : "普通文字层 PDF 一般不需要勾选；若正文提取失败，也可以手动勾选并指定页码。";
  updateImageAskSummary();
  state.rendering = false;
}

function formatStickyTime(iso) {
  if (!iso) return "";
  // iso 形如 "2026-05-14T14:30:00Z"
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderStickyList() {
  const list = $("stickyList");
  if (!list) return;
  const items = state.stickies || [];
  $("stickyPanelCount").textContent = `${items.length} 条便签`;
  if (!state.selected) {
    list.innerHTML = '<div class="sticky-empty">选择一篇文献后，便签会保存到 library/stickies/{paper_id}.json。</div>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<div class="sticky-empty">这篇文献还没有便签。在上方输入框写一条然后点「添加便签」。</div>';
    return;
  }
  list.innerHTML = items
    .map((sticky) => {
      const isEditing = state.editingStickyId === sticky.id;
      const time = sticky.updated_at && sticky.updated_at !== sticky.created_at
        ? `更新于 ${formatStickyTime(sticky.updated_at)}`
        : `${formatStickyTime(sticky.created_at)}`;
      if (isEditing) {
        return `
          <div class="sticky-item editing" data-sticky-id="${escapeHtml(sticky.id)}">
            <textarea class="sticky-edit-input" spellcheck="false">${escapeHtml(sticky.content)}</textarea>
            <div class="sticky-actions">
              <button class="sticky-save" type="button">保存</button>
              <button class="sticky-cancel secondary" type="button">取消</button>
            </div>
          </div>
        `;
      }
      const color = sticky.color || "clay";
      return `
        <div class="sticky-item sticky-color-${escapeHtml(color)}" data-sticky-id="${escapeHtml(sticky.id)}" data-sticky-color="${escapeHtml(color)}">
          <div class="sticky-content">${escapeHtml(sticky.content) || '<span class="muted">（空便签）</span>'}</div>
          <div class="sticky-meta">
            <span class="sticky-time muted">${escapeHtml(time)}</span>
            <button class="sticky-edit secondary" type="button">编辑</button>
            <button class="sticky-delete secondary danger" type="button">删除</button>
          </div>
        </div>
      `;
    })
    .join("");
  // 绑定事件
  list.querySelectorAll(".sticky-item").forEach((node) => {
    const id = node.dataset.stickyId;
    node.querySelector(".sticky-edit")?.addEventListener("click", () => {
      state.editingStickyId = id;
      renderStickyList();
    });
    node.querySelector(".sticky-cancel")?.addEventListener("click", () => {
      state.editingStickyId = "";
      renderStickyList();
    });
    node.querySelector(".sticky-save")?.addEventListener("click", async () => {
      const textarea = node.querySelector(".sticky-edit-input");
      const content = textarea ? textarea.value : "";
      await saveStickyEdit(id, content);
    });
    node.querySelector(".sticky-delete")?.addEventListener("click", () => deleteSticky(id));
  });
}

async function loadStickies() {
  if (!state.selected) {
    state.stickies = [];
    state.editingStickyId = "";
    renderStickyList();
    return;
  }
  try {
    const data = await api(`/api/annotations?paper_id=${encodeURIComponent(state.selected.paper_id)}`);
    state.stickies = data.stickies || [];
  } catch (e) {
    state.stickies = [];
    $("stickyStatus").textContent = `加载失败：${e.message}`;
  }
  renderStickyList();
}

async function addSticky() {
  if (!state.selected) return;
  const input = $("stickyNewInput");
  const content = input.value.trim();
  if (!content) return;
  const color = $("stickyAddBtn")?.dataset?.color || "clay";
  $("stickyAddBtn").disabled = true;
  $("stickyStatus").textContent = "保存中…";
  try {
    const data = await api("/api/annotations", {
      method: "POST",
      body: JSON.stringify({ paper_id: state.selected.paper_id, content, color }),
    });
    state.stickies.unshift(data.sticky);
    input.value = "";
    $("stickyStatus").textContent = "已添加";
    renderStickyList();
  } catch (e) {
    $("stickyStatus").textContent = `失败：${e.message}`;
  } finally {
    $("stickyAddBtn").disabled = !input.value.trim();
  }
}

async function saveStickyEdit(id, content) {
  if (!state.selected) return;
  $("stickyStatus").textContent = "保存中…";
  try {
    const data = await api("/api/annotations/update", {
      method: "POST",
      body: JSON.stringify({ paper_id: state.selected.paper_id, id, content }),
    });
    const idx = state.stickies.findIndex((s) => s.id === id);
    if (idx >= 0) state.stickies[idx] = data.sticky;
    state.editingStickyId = "";
    $("stickyStatus").textContent = "已更新";
    renderStickyList();
  } catch (e) {
    $("stickyStatus").textContent = `失败：${e.message}`;
  }
}

async function deleteSticky(id) {
  if (!state.selected) return;
  if (!confirm("确认删除这条便签？")) return;
  $("stickyStatus").textContent = "删除中…";
  try {
    await api("/api/annotations/delete", {
      method: "POST",
      body: JSON.stringify({ paper_id: state.selected.paper_id, id }),
    });
    state.stickies = state.stickies.filter((s) => s.id !== id);
    if (state.editingStickyId === id) state.editingStickyId = "";
    $("stickyStatus").textContent = "已删除";
    renderStickyList();
  } catch (e) {
    $("stickyStatus").textContent = `失败：${e.message}`;
  }
}

function setSidebarCollapsed(collapsed) {
  state.sidebarCollapsed = collapsed;
  document.querySelector(".app-shell").classList.toggle("sidebar-collapsed", collapsed);
  const btn = $("sidebarToggle");
  if (btn) btn.textContent = collapsed ? "›" : "‹";
  try { localStorage.setItem("dc-sidebar-collapsed", collapsed ? "1" : "0"); } catch {}
}

// Restore on boot
(function restoreSidebar() {
  try {
    if (localStorage.getItem("dc-sidebar-collapsed") === "1") {
      // Defer until DOM is parsed
      document.addEventListener("DOMContentLoaded", () => setSidebarCollapsed(true), { once: true });
    }
  } catch {}
})();

async function translateClipboard() {
  if (state.translating) return;
  let sourceText = "";
  // 1. Prefer a LIVE selection on the main page (note panel / metadata /
  //    excerpt / anywhere outside the PDF iframe) — no Ctrl+C needed, just
  //    select and click.
  const liveSel = (window.getSelection && window.getSelection().toString()) || "";
  if (liveSel.trim().length >= 2) {
    sourceText = liveSel;
  } else {
    // 2. Fall back to the OS clipboard. The PDF renders inside an <iframe>;
    //    browser security forbids the parent page from reading an iframe's
    //    selection, so text selected IN the PDF must still be Ctrl+C'd first.
    try {
      sourceText = await navigator.clipboard.readText();
    } catch (error) {
      alert(
        `无法读取剪贴板：${error.message}\n\n` +
        `· 网页里的文字（笔记/元数据等）：选中后直接点翻译即可\n` +
        `· PDF 里的文字：选中后先按 Ctrl+C，再点翻译`
      );
      return;
    }
  }
  const cleanText = sourceText.trim().replace(/\s+/g, " ");
  if (cleanText.length < 2) {
    alert(
      "没有检测到可翻译的文字。\n\n" +
      "· 网页里的文字：选中后直接点翻译\n" +
      "· PDF 里的文字：选中后先 Ctrl+C，再点翻译"
    );
    return;
  }
  state.translating = true;
  $("translatePopup").classList.remove("hidden");
  $("translateSource").textContent = cleanText;
  $("translateStatus").textContent = "翻译中…";
  $("translateResult").textContent = "";
  try {
    const data = await api("/api/translate", {
      method: "POST",
      body: JSON.stringify({
        paper_id: state.selected?.paper_id || "",
        text: cleanText,
      }),
    });
    $("translateResult").textContent = data.translation || "";
    $("translateStatus").textContent = `模型：${data.model || "ollama"}`;
  } catch (error) {
    $("translateStatus").textContent = error.message;
  } finally {
    state.translating = false;
  }
}

function clearSelectedView() {
  state.selected = null;
  state.note = "";
  state.stickies = [];
  state.editingStickyId = "";
  state.chatHistory = [];
  renderChatHistory();
  $("paperTitle").textContent = "选择一篇文献";
  $("paperMeta").textContent = "";
  const venueLine = $("paperVenueLine");
  if (venueLine) venueLine.textContent = "";
  const rankLine = $("paperRankLine");
  if (rankLine) rankLine.innerHTML = "";
  if (state.viewer) state.viewer.load("", "");
  $("translatePopup").classList.add("hidden");
  $("openPdfLink").removeAttribute("href");
  $("deletePaperBtn").disabled = true;
  const helpReadBtn = $("helpReadBtn");
  if (helpReadBtn) helpReadBtn.disabled = true;
  const refreshRankBtn = $("refreshRankBtn");
  if (refreshRankBtn) refreshRankBtn.disabled = true;
  const helpCiteBtn = $("helpCiteBtn");
  if (helpCiteBtn) helpCiteBtn.disabled = true;
  $("noteEditor").value = "";
  $("notePreview").innerHTML = "";
  $("classificationSummary").textContent = "未设置";
  $("classificationHint").textContent = "点击选择或管理一级/二级分类";
  $("aiAnswer").textContent = "";
  $("appendContent").value = "";
  renderStickyList();
}

async function saveNote(quiet = false) {
  if (!state.selected) return;
  // Manual save: cancel any pending autosave and save SYNCHRONOUSLY with
  // the current editor contents bound to the current paper_id.
  if (state.noteSaveTimer) {
    clearTimeout(state.noteSaveTimer);
    state.noteSaveTimer = null;
  }
  state.pendingNoteSave = null;
  $("saveNoteBtn").disabled = true;
  $("noteSaveStatus").textContent = "保存中";
  const paperId = state.selected.paper_id;
  const content = $("noteEditor").value;
  try {
    await api("/api/note", {
      method: "POST",
      body: JSON.stringify({ paper_id: paperId, content }),
    });
    // Only sync state.note if user is still on the same paper
    if (state.selected && state.selected.paper_id === paperId) {
      state.note = content;
      $("notePreview").innerHTML = `<p>${markdownLite(state.note)}</p>`;
      $("noteSaveStatus").textContent = quiet ? "已自动同步笔记" : "已保存笔记";
    }
  } finally {
    $("saveNoteBtn").disabled = false;
  }
}

// ----------------------------------------------------------------------
// Race-free autosave. Previously a 1s debounce read `state.selected.paper_id`
// AND `noteEditor.value` at execution time — if the user switched to paper B
// during the debounce window, the autosave would POST paper-B's id with
// paper-A's content and silently overwrite B's note. Now we snapshot both
// the paper_id and the textarea content at INPUT time, so the payload is
// bound to the right paper even if the user has since navigated away.
// ----------------------------------------------------------------------
function scheduleAutosave() {
  if (!state.selected) return;
  state.pendingNoteSave = {
    paperId: state.selected.paper_id,
    content: $("noteEditor").value,
  };
  if (state.noteSaveTimer) clearTimeout(state.noteSaveTimer);
  state.noteSaveTimer = setTimeout(flushAutosave, 1000);
}

async function flushAutosave() {
  if (state.noteSaveTimer) { clearTimeout(state.noteSaveTimer); state.noteSaveTimer = null; }
  const payload = state.pendingNoteSave;
  state.pendingNoteSave = null;
  if (!payload) return;
  try {
    await api("/api/note", {
      method: "POST",
      body: JSON.stringify({ paper_id: payload.paperId, content: payload.content }),
    });
    // Only update editor-side state if we're still on the same paper
    if (state.selected && state.selected.paper_id === payload.paperId) {
      state.note = payload.content;
      $("notePreview").innerHTML = `<p>${markdownLite(state.note)}</p>`;
      $("noteSaveStatus").textContent = "已自动同步笔记";
    }
  } catch (error) {
    if (state.selected && state.selected.paper_id === payload.paperId) {
      $("noteSaveStatus").textContent = error.message;
    }
  }
}

// Kept as alias so existing call sites still work
const autosaveNote = scheduleAutosave;

function metaFields() {
  // IMPORTANT: this panel has NO category inputs. It must NOT send
  // 一级/二级/三级/人工/最终分类 — previously it re-sent them from
  // state.selected, and if state.selected was stale (e.g. the category
  // modal saved but didn't sync state.selected back), the meta save
  // overwrote real categories with empty strings (data-loss bug).
  // Category fields are owned SOLELY by the classification modal.
  return {
    英文标题: $("titleEn").value,
    中文标题: $("titleZh").value,
    期刊会议: $("venue").value,
    期刊分区: $("journalQuartile").value,
    期刊等级_人工: $("journalRankManual")?.value || "",
    SSCI: $("flagSSCI").checked ? "是" : "",
    SCI: $("flagSCI").checked ? "是" : "",
    UTD: $("flagUTD").checked ? "是" : "",
    FT50: $("flagFT50").checked ? "是" : "",
    ABS: $("flagABS").checked ? "是" : "",
    重要性: $("importance").value,
    阅读状态: $("readStatus").value,
    我的备注: $("myRemark").value,
  };
}

async function saveMeta(quiet = false) {
  if (!state.selected) return;
  $("saveMetaBtn").disabled = true;
  $("metaSaveStatus").textContent = "同步中";
  const data = await api("/api/paper", {
    method: "POST",
    body: JSON.stringify({ paper_id: state.selected.paper_id, fields: metaFields() }),
  });
  state.selected = data.paper;
  $("saveMetaBtn").disabled = false;
  $("metaSaveStatus").textContent = quiet ? "已自动同步总表" : "已同步总表";
  renderClassificationBox(state.selected);
  await loadCategories();
  await loadPapers();
}

const autosaveMeta = debounce(() => {
  if (state.rendering) return;
  saveMeta(true).catch((error) => {
    $("metaSaveStatus").textContent = error.message;
  });
}, 900);

function openCategoryModal(opts = {}) {
  if (!state.selected) return;
  const preferAi = !!opts.preferAi;
  const aiPrimary = state.selected["一级分类_AI建议"] || "";
  const aiSecondaries = splitValues(state.selected["二级分类_AI建议"] || "");
  const confirmedPrimaries = getConfirmedPrimaries(state.selected);
  const confirmedSecondaries = getConfirmedSecondaries(state.selected);
  const confirmedTertiaries = getConfirmedTertiaries(state.selected);
  const primaries = preferAi
    ? (aiPrimary ? [aiPrimary] : (confirmedPrimaries.length ? confirmedPrimaries : []))
    : (confirmedPrimaries.length ? confirmedPrimaries : (aiPrimary ? [aiPrimary] : []));
  const secondaries = preferAi && aiSecondaries.length
    ? aiSecondaries
    : (confirmedSecondaries.length ? confirmedSecondaries : aiSecondaries);
  state.categoryDraft = {
    primaries: [...primaries],
    secondaries: [...secondaries],
    tertiaries: [...confirmedTertiaries],
  };
  if (!state.treeSelectedPrimary) {
    state.treeSelectedPrimary = primaries[0] || primaryNames()[0] || "";
  }
  renderPaperPrimaryChoices();
  renderPaperSecondaryChoices();
  renderPaperTertiaryChoices();
  $("paperCategoryAiHint").textContent = `AI建议：${classificationText({
    "一级分类_AI建议": aiPrimary,
    "二级分类_AI建议": state.selected["二级分类_AI建议"] || "",
  })}`;
  $("categorySaveStatus").textContent = opts.statusHint || "";
  $("categoryModal").classList.remove("hidden");
}

// 当前文献勾选一级（多选 chip-grid）
function renderPaperPrimaryChoices() {
  const host = $("paperPrimaryList");
  if (!host) return;
  const selected = state.categoryDraft.primaries;
  host.innerHTML = "";
  const allPrimaries = primaryNames();
  if (!allPrimaries.length) {
    host.innerHTML = '<span class="muted">还没有一级分类，去「编辑分类体系」新增</span>';
    return;
  }
  for (const primary of allPrimaries) {
    const label = document.createElement("label");
    label.className = "chip-check";
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(primary)}" ${selected.includes(primary) ? "checked" : ""} /> <span>${escapeHtml(primary)}</span>`;
    label.querySelector("input").addEventListener("change", (event) => {
      const value = event.target.value;
      if (event.target.checked) {
        state.categoryDraft.primaries = splitValues(joinUnique([...state.categoryDraft.primaries, value]));
      } else {
        state.categoryDraft.primaries = state.categoryDraft.primaries.filter((p) => p !== value);
        // 取消某个一级时，把它下面的二级、三级也清掉
        const dropSecs = new Set(secondaryNames(value));
        if (dropSecs.size) {
          state.categoryDraft.secondaries = state.categoryDraft.secondaries.filter((s) => !dropSecs.has(s));
        }
        const dropThirds = new Set();
        for (const s of dropSecs) {
          for (const t of tertiaryNames(value, s)) dropThirds.add(t);
        }
        if (dropThirds.size) {
          state.categoryDraft.tertiaries = state.categoryDraft.tertiaries.filter((t) => !dropThirds.has(t));
        }
      }
      renderPaperSecondaryChoices();
    });
    host.appendChild(label);
  }
}

function renderPaperSecondaryChoices() {
  const host = $("paperSecondaryList");
  if (!host) return;
  host.innerHTML = "";
  const primaries = state.categoryDraft.primaries;
  const selected = state.categoryDraft.secondaries;
  if (!primaries.length) {
    host.innerHTML = '<span class="muted">先勾选一级分类，二级选项会出现在这里</span>';
    renderPaperTertiaryChoices();
    return;
  }
  let any = false;
  for (const primary of primaries) {
    const children = secondaryNames(primary);
    const group = document.createElement("div");
    group.className = "tertiary-group";
    const head = document.createElement("div");
    head.className = "tertiary-group-head";
    head.textContent = primary;
    group.appendChild(head);
    if (!children.length) {
      const empty = document.createElement("span");
      empty.className = "muted";
      empty.textContent = "（无二级分类）";
      group.appendChild(empty);
    } else {
      for (const child of children) {
        any = true;
        const label = document.createElement("label");
        label.className = "chip-check";
        label.innerHTML = `<input type="checkbox" value="${escapeHtml(child)}" ${selected.includes(child) ? "checked" : ""} /> <span>${escapeHtml(child)}</span>`;
        label.querySelector("input").addEventListener("change", (event) => {
          const value = event.target.value;
          if (event.target.checked) {
            state.categoryDraft.secondaries = splitValues(joinUnique([...state.categoryDraft.secondaries, value]));
          } else {
            state.categoryDraft.secondaries = state.categoryDraft.secondaries.filter((s) => s !== value);
            // 取消二级时连带它下面的三级也清掉
            const drops = new Set(tertiaryNames(primary, value));
            if (drops.size) {
              state.categoryDraft.tertiaries = state.categoryDraft.tertiaries.filter((t) => !drops.has(t));
            }
          }
          renderPaperTertiaryChoices();
        });
        group.appendChild(label);
      }
    }
    host.appendChild(group);
  }
  if (!any) {
    const hint = document.createElement("div");
    hint.className = "muted";
    hint.style.marginTop = "6px";
    hint.textContent = "（所选一级下都没有二级分类，去「编辑分类体系」添加）";
    host.appendChild(hint);
  }
  renderPaperTertiaryChoices();
}

function renderPaperTertiaryChoices() {
  const host = $("paperTertiaryList");
  if (!host) return;
  const primaries = state.categoryDraft.primaries;
  const selectedSecondaries = state.categoryDraft.secondaries;
  const selectedTertiaries = state.categoryDraft.tertiaries;
  host.innerHTML = "";
  if (!primaries.length || !selectedSecondaries.length) {
    host.innerHTML = '<span class="muted">先勾选二级分类，三级选项会出现在这里</span>';
    return;
  }
  // 三级要从所有(一级, 二级)对里去聚合
  let any = false;
  for (const primary of primaries) {
    for (const sec of selectedSecondaries) {
      // 只有当 sec 真在这个 primary 下，才显示其三级
      if (!secondaryNames(primary).includes(sec)) continue;
      const tertiaries = tertiaryNames(primary, sec);
      if (!tertiaries.length) continue;
      any = true;
      const group = document.createElement("div");
      group.className = "tertiary-group";
      const head = document.createElement("div");
      head.className = "tertiary-group-head";
      head.textContent = `${primary} › ${sec}`;
      group.appendChild(head);
      for (const tert of tertiaries) {
        const label = document.createElement("label");
        label.className = "chip-check";
        label.innerHTML = `<input type="checkbox" value="${escapeHtml(tert)}" ${selectedTertiaries.includes(tert) ? "checked" : ""} /> <span>${escapeHtml(tert)}</span>`;
        label.querySelector("input").addEventListener("change", (event) => {
          const v = event.target.value;
          if (event.target.checked) {
            state.categoryDraft.tertiaries = splitValues(joinUnique([...state.categoryDraft.tertiaries, v]));
          } else {
            state.categoryDraft.tertiaries = state.categoryDraft.tertiaries.filter((item) => item !== v);
          }
        });
        group.appendChild(label);
      }
      host.appendChild(group);
    }
  }
  if (!any) {
    const hint = document.createElement("div");
    hint.className = "muted";
    hint.style.marginTop = "6px";
    hint.textContent = "（所选二级下还没有三级分类）";
    host.appendChild(hint);
  }
}

function renderCategoryTree() {
  const primaryList = $("primaryCategoryList");
  if (!primaryList) return;
  const names = primaryNames();
  // 保证选中是有效的
  if (!state.treeSelectedPrimary || !state.categoryTree[state.treeSelectedPrimary]) {
    state.treeSelectedPrimary = names[0] || "";
  }
  const secs = secondaryNames(state.treeSelectedPrimary);
  if (state.treeSelectedSecondary && !secs.includes(state.treeSelectedSecondary)) {
    state.treeSelectedSecondary = "";
  }
  if (!state.treeSelectedSecondary && secs.length) {
    state.treeSelectedSecondary = secs[0];
  }
  // 一级
  primaryList.innerHTML = "";
  for (const primary of names) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tree-list-item${primary === state.treeSelectedPrimary ? " active" : ""}`;
    button.textContent = primary;
    button.addEventListener("click", () => {
      state.treeSelectedPrimary = primary;
      state.treeSelectedSecondary = "";
      renderCategoryTree();
    });
    primaryList.appendChild(button);
  }
  // 二级
  const secondaryList = $("secondaryCategoryList");
  if (secondaryList) {
    secondaryList.innerHTML = "";
    const secHead = $("secondaryColHead");
    if (secHead) secHead.textContent = state.treeSelectedPrimary
      ? `二级分类（${state.treeSelectedPrimary}）`
      : "二级分类";
    if (!state.treeSelectedPrimary) {
      secondaryList.innerHTML = '<div class="muted">先选中一级分类</div>';
    } else if (!secs.length) {
      secondaryList.innerHTML = '<div class="muted">还没有二级分类</div>';
    } else {
      for (const sec of secs) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = `tree-list-item${sec === state.treeSelectedSecondary ? " active" : ""}`;
        item.textContent = sec;
        item.addEventListener("click", () => {
          state.treeSelectedSecondary = sec;
          renderCategoryTree();
        });
        secondaryList.appendChild(item);
      }
    }
  }
  // 三级
  const tertiaryList = $("tertiaryCategoryList");
  if (tertiaryList) {
    tertiaryList.innerHTML = "";
    const tertHead = $("tertiaryColHead");
    if (tertHead) {
      tertHead.textContent = state.treeSelectedSecondary
        ? `三级分类（${state.treeSelectedSecondary}）`
        : "三级分类";
    }
    if (!state.treeSelectedSecondary) {
      tertiaryList.innerHTML = '<div class="muted">先选中二级分类</div>';
    } else {
      const tertiaries = tertiaryNames(state.treeSelectedPrimary, state.treeSelectedSecondary);
      if (!tertiaries.length) {
        tertiaryList.innerHTML = '<div class="muted">还没有三级分类</div>';
      } else {
        for (const tert of tertiaries) {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "tree-list-item";
          item.textContent = tert;
          // 三级用一个 dataset 暂存
          item.dataset.tertiary = tert;
          item.addEventListener("click", () => {
            // 高亮选中三级，方便后续重命名/删除
            tertiaryList.querySelectorAll(".tree-list-item").forEach((n) => n.classList.remove("active"));
            item.classList.add("active");
          });
          tertiaryList.appendChild(item);
        }
      }
    }
  }
}

function getSelectedTertiary() {
  const tertiaryList = $("tertiaryCategoryList");
  if (!tertiaryList) return "";
  const active = tertiaryList.querySelector(".tree-list-item.active");
  return active ? (active.dataset.tertiary || active.textContent || "").trim() : "";
}

function flashTreeStatus(msg, isError = false) {
  const el = $("treeSaveStatus");
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? "var(--danger)" : "";
  if (!isError) {
    setTimeout(() => {
      el.textContent = "每次新增/重命名/删除会立即保存到 settings.yaml";
      el.style.color = "";
    }, 2500);
  }
}

// --- 一级 ---

async function addPrimary() {
  const name = ($("newPrimaryInput")?.value || "").trim();
  if (!name) return flashTreeStatus("请先输入名称", true);
  if (state.categoryTree[name]) return flashTreeStatus(`「${name}」已存在`, true);
  state.categoryTree[name] = {};
  state.treeSelectedPrimary = name;
  $("newPrimaryInput").value = "";
  renderCategoryTree();
  flashTreeStatus("保存中…");
  try {
    await saveCategoryTree(true);
    flashTreeStatus(`已新增一级分类「${name}」`);
  } catch (e) {
    flashTreeStatus(`保存失败：${e.message}`, true);
  }
}

async function renamePrimary() {
  const current = state.treeSelectedPrimary;
  if (!current) return flashTreeStatus("请先在左侧选中要重命名的一级分类", true);
  const newName = prompt(`把一级分类「${current}」重命名为：`, current);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === current) return;
  if (state.categoryTree[trimmed]) return flashTreeStatus(`「${trimmed}」已存在`, true);
  flashTreeStatus("重命名 + 同步文献分类中…");
  try {
    const res = await api("/api/category-tree/rename-primary", {
      method: "POST",
      body: JSON.stringify({ old: current, new: trimmed }),
    });
    state.categoryTree = res.tree || {};
    state.treeSelectedPrimary = trimmed;
    state.categoryDraft.primaries = state.categoryDraft.primaries.map((p) => (p === current ? trimmed : p));
    renderCategoryTree();
    renderPaperPrimaryChoices();
    renderPaperSecondaryChoices();
    flashTreeStatus(`已重命名为「${trimmed}」，同步 ${res.migrated || 0} 篇文献`);
    await loadCategories();
    await loadPapers();
    if (state.selected) renderSelected();
  } catch (e) {
    flashTreeStatus(`失败：${e.message}`, true);
  }
}

async function deletePrimary() {
  const current = state.treeSelectedPrimary;
  if (!current) return flashTreeStatus("请先选中要删除的一级分类", true);
  if (!confirm(`删除一级分类「${current}」？\n\n已分到此分类的文献不会自动改分类（仅清理体系树）。`)) return;
  delete state.categoryTree[current];
  state.treeSelectedPrimary = primaryNames()[0] || "";
  state.categoryDraft.primaries = state.categoryDraft.primaries.filter((p) => p !== current);
  // 把那个一级下的二级 / 三级也清掉(已经没父级了)
  const dropSecs = new Set();
  const dropTerts = new Set();
  // 注：此时 categoryTree 里 current 已删除，所以从 res tree 之前的快照里拿不到了
  // 简化处理：保留其它二级/三级，由用户在 UI 上看到再决定。
  renderPaperPrimaryChoices();
  renderPaperSecondaryChoices();
  renderCategoryTree();
  flashTreeStatus("保存中…");
  try {
    await saveCategoryTree(true);
    flashTreeStatus(`已删除「${current}」`);
  } catch (e) {
    flashTreeStatus(`保存失败：${e.message}`, true);
  }
}

// --- 二级 ---

async function addSecondaryToTree() {
  const primary = state.treeSelectedPrimary;
  const value = ($("newSecondaryInput")?.value || "").trim();
  if (!primary) return flashTreeStatus("请先选中一个一级分类", true);
  if (!value) return;
  const node = state.categoryTree[primary];
  if (!node || Array.isArray(node)) {
    // 兼容老格式
    const old = Array.isArray(node) ? node : [];
    state.categoryTree[primary] = Object.fromEntries(old.map((s) => [s, []]));
  }
  if (state.categoryTree[primary][value] !== undefined) {
    return flashTreeStatus(`「${value}」已在「${primary}」中`, true);
  }
  state.categoryTree[primary][value] = [];
  state.treeSelectedSecondary = value;
  $("newSecondaryInput").value = "";
  renderCategoryTree();
  flashTreeStatus("保存中…");
  try {
    await saveCategoryTree(true);
    flashTreeStatus(`已添加二级分类「${value}」`);
  } catch (e) {
    flashTreeStatus(`保存失败：${e.message}`, true);
  }
}

async function renameSecondary() {
  const primary = state.treeSelectedPrimary;
  const current = state.treeSelectedSecondary;
  if (!primary || !current) return flashTreeStatus("请先在左侧选中二级分类", true);
  const newName = prompt(`把二级分类「${current}」重命名为：`, current);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === current) return;
  if (secondaryNames(primary).includes(trimmed)) {
    return flashTreeStatus(`「${trimmed}」已存在`, true);
  }
  flashTreeStatus("重命名 + 同步文献分类中…");
  try {
    const res = await api("/api/category-tree/rename-secondary", {
      method: "POST",
      body: JSON.stringify({ primary, old: current, new: trimmed }),
    });
    state.categoryTree = res.tree || {};
    state.treeSelectedSecondary = trimmed;
    state.categoryDraft.secondaries = state.categoryDraft.secondaries.map((s) => (s === current ? trimmed : s));
    renderCategoryTree();
    renderPaperSecondaryChoices();
    flashTreeStatus(`已重命名为「${trimmed}」，同步 ${res.migrated || 0} 篇文献`);
    await loadCategories();
    await loadPapers();
    if (state.selected) renderSelected();
  } catch (e) {
    flashTreeStatus(`失败：${e.message}`, true);
  }
}

async function deleteSecondary() {
  const primary = state.treeSelectedPrimary;
  const current = state.treeSelectedSecondary;
  if (!primary || !current) return flashTreeStatus("请先选中二级分类", true);
  if (!confirm(`删除二级分类「${current}」（连带其下的所有三级）？\n\n已分到此分类的文献不会自动改分类。`)) return;
  if (state.categoryTree[primary] && !Array.isArray(state.categoryTree[primary])) {
    delete state.categoryTree[primary][current];
  }
  state.treeSelectedSecondary = "";
  state.categoryDraft.secondaries = state.categoryDraft.secondaries.filter((s) => s !== current);
  renderCategoryTree();
  flashTreeStatus("保存中…");
  try {
    await saveCategoryTree(true);
    flashTreeStatus(`已删除「${current}」`);
  } catch (e) {
    flashTreeStatus(`保存失败：${e.message}`, true);
  }
}

// --- 三级 ---

async function addTertiary() {
  const primary = state.treeSelectedPrimary;
  const secondary = state.treeSelectedSecondary;
  const value = ($("newTertiaryInput")?.value || "").trim();
  if (!primary || !secondary) return flashTreeStatus("请先选中一个二级分类", true);
  if (!value) return;
  const node = state.categoryTree[primary];
  if (!node || Array.isArray(node) || !node[secondary]) {
    return flashTreeStatus("二级分类不存在", true);
  }
  if (node[secondary].includes(value)) return flashTreeStatus(`「${value}」已存在`, true);
  node[secondary].push(value);
  $("newTertiaryInput").value = "";
  renderCategoryTree();
  flashTreeStatus("保存中…");
  try {
    await saveCategoryTree(true);
    flashTreeStatus(`已添加三级分类「${value}」`);
  } catch (e) {
    flashTreeStatus(`保存失败：${e.message}`, true);
  }
}

async function renameTertiary() {
  const primary = state.treeSelectedPrimary;
  const secondary = state.treeSelectedSecondary;
  const current = getSelectedTertiary();
  if (!primary || !secondary) return flashTreeStatus("请先选中一个二级分类", true);
  if (!current) return flashTreeStatus("请先点选要重命名的三级分类项", true);
  const newName = prompt(`把三级分类「${current}」重命名为：`, current);
  if (newName === null) return;
  const trimmed = newName.trim();
  if (!trimmed || trimmed === current) return;
  if (tertiaryNames(primary, secondary).includes(trimmed)) {
    return flashTreeStatus(`「${trimmed}」已存在`, true);
  }
  flashTreeStatus("重命名 + 同步文献分类中…");
  try {
    const res = await api("/api/category-tree/rename-tertiary", {
      method: "POST",
      body: JSON.stringify({ primary, secondary, old: current, new: trimmed }),
    });
    state.categoryTree = res.tree || {};
    state.categoryDraft.tertiaries = state.categoryDraft.tertiaries.map((t) => (t === current ? trimmed : t));
    renderCategoryTree();
    renderPaperTertiaryChoices();
    flashTreeStatus(`已重命名为「${trimmed}」，同步 ${res.migrated || 0} 篇文献`);
    await loadCategories();
    await loadPapers();
    if (state.selected) renderSelected();
  } catch (e) {
    flashTreeStatus(`失败：${e.message}`, true);
  }
}

async function deleteTertiary() {
  const primary = state.treeSelectedPrimary;
  const secondary = state.treeSelectedSecondary;
  const current = getSelectedTertiary();
  if (!primary || !secondary || !current) return flashTreeStatus("请先点选三级分类项", true);
  if (!confirm(`删除三级分类「${current}」？\n\n已分到此分类的文献不会自动改分类。`)) return;
  const node = state.categoryTree[primary];
  if (node && !Array.isArray(node) && Array.isArray(node[secondary])) {
    node[secondary] = node[secondary].filter((t) => t !== current);
  }
  state.categoryDraft.tertiaries = state.categoryDraft.tertiaries.filter((t) => t !== current);
  renderCategoryTree();
  flashTreeStatus("保存中…");
  try {
    await saveCategoryTree(true);
    flashTreeStatus(`已删除「${current}」`);
  } catch (e) {
    flashTreeStatus(`保存失败：${e.message}`, true);
  }
}

async function addPaperSecondary() {
  // 新二级挂到「第一个所选的一级」下；用户可以在体系管理器里再移动
  const primary = state.categoryDraft.primaries[0];
  const value = $("newPaperSecondary").value.trim();
  if (!primary) return alert("请先勾选一个一级分类");
  if (!value) return;
  const node = state.categoryTree[primary];
  if (!node || Array.isArray(node)) {
    state.categoryTree[primary] = Array.isArray(node)
      ? Object.fromEntries(node.map((s) => [s, []]))
      : {};
  }
  if (state.categoryTree[primary][value] === undefined) {
    state.categoryTree[primary][value] = [];
  }
  state.categoryDraft.secondaries = splitValues(joinUnique([...state.categoryDraft.secondaries, value]));
  $("newPaperSecondary").value = "";
  renderPaperSecondaryChoices();
  renderCategoryTree();
  await saveCategoryTree(true);
}

async function savePaperCategory() {
  if (!state.selected) return;
  const primaries = state.categoryDraft.primaries || [];
  const secondaries = state.categoryDraft.secondaries || [];
  const tertiaries = state.categoryDraft.tertiaries || [];
  $("categorySaveStatus").textContent = "同步中";
  const data = await api("/api/paper", {
    method: "POST",
    body: JSON.stringify({
      paper_id: state.selected.paper_id,
      fields: {
        一级分类: joinUnique(primaries),
        二级分类: joinUnique(secondaries),
        三级分类: joinUnique(tertiaries),
        最终分类: finalCategory(primaries, secondaries, tertiaries),
      },
    }),
  });
  state.selected = data.paper;
  $("categorySaveStatus").textContent = "已同步到总表";
  renderClassificationBox(state.selected);
  await loadCategories();
  await loadPapers();
}

async function askAi() {
  if (!state.selected) return;
  const question = $("questionInput").value.trim();
  if (!question) return;
  const useHistoryEl = $("chatUseHistory");
  const useHistory = useHistoryEl ? useHistoryEl.checked : true;
  $("askBtn").disabled = true;
  $("aiStatus").textContent = "AI 正在阅读当前文献";
  $("aiAnswer").classList.add("hidden");
  try {
    const data = await api("/api/ask", {
      method: "POST",
      body: JSON.stringify({
        paper_id: state.selected.paper_id,
        question,
        append: false,
        use_images: $("imageAskToggle").checked,
        page_spec: $("imagePageInput").value.trim(),
        use_history: useHistory,
        work_context: state.workContext || "",
      }),
    });
    state.chatHistory = data.history || state.chatHistory;
    renderChatHistory();
    $("questionInput").value = "";
    $("aiAnswer").textContent = data.answer;
    $("aiAnswer").classList.remove("hidden");
    $("appendContent").value = data.answer;
    const usage = data.usage || {};
    $("aiStatus").textContent = usage.total_tokens
      ? `已完成 · ${usage.total_tokens} tokens`
      : usage.provider
        ? `已完成 · ${usage.provider}`
        : "已完成";
  } catch (error) {
    $("aiStatus").textContent = error.message;
  } finally {
    $("askBtn").disabled = false;
  }
}

function renderChatHistory() {
  const host = $("chatHistory");
  if (!host) return;
  const history = state.chatHistory || [];
  host.innerHTML = "";
  for (const msg of history) {
    const wrap = document.createElement("div");
    wrap.className = `chat-msg chat-msg-${msg.role === "assistant" ? "assistant" : "user"}`;
    const meta = document.createElement("div");
    meta.className = "chat-msg-meta";
    const role = document.createElement("span");
    role.className = "chat-role";
    role.textContent = msg.role === "assistant" ? "AI" : "我";
    meta.appendChild(role);
    if (msg.ts) {
      const ts = document.createElement("span");
      ts.textContent = msg.ts.replace("T", " ").replace("Z", "");
      meta.appendChild(ts);
    }
    if (msg.role === "assistant" && msg.model) {
      const model = document.createElement("span");
      model.textContent = msg.model;
      meta.appendChild(model);
    }
    wrap.appendChild(meta);
    const body = document.createElement("div");
    // MUST carry `bubble-body` — the design CSS that makes the answer text
    // selectable (user-select:text) targets `.bubble-body`. A bare <div>
    // (the old code) got none of it, so answers couldn't be selected.
    body.className = "bubble-body";
    body.textContent = String(msg.content || "");
    wrap.appendChild(body);
    // Assistant bubbles get a copy button. The phase2 document-level handler
    // copies straight from the bubble's DOM text, so this works regardless of
    // which renderer (app.js here, or phase2's rerenderChat) drew the bubble.
    if (msg.role === "assistant") {
      const actions = document.createElement("div");
      actions.className = "bubble-actions";
      actions.innerHTML = `<button data-act="copy" type="button">复制</button>`;
      wrap.appendChild(actions);
    }
    host.appendChild(wrap);
  }
  host.scrollTop = host.scrollHeight;
  const userTurns = history.filter((m) => m.role === "user").length;
  const aiTurns = history.filter((m) => m.role === "assistant").length;
  const status = $("chatHistoryStatus");
  if (status) {
    status.textContent = userTurns ? `共 ${userTurns} 轮提问 · ${aiTurns} 条 AI 回复` : "尚无对话";
  }
  const clearBtn = $("clearChatBtn");
  if (clearBtn) clearBtn.disabled = !history.length;
}

async function loadChatHistoryFor(paperId) {
  if (!paperId) {
    state.chatHistory = [];
    renderChatHistory();
    return;
  }
  try {
    const data = await api(`/api/chat-history?paper_id=${encodeURIComponent(paperId)}`);
    state.chatHistory = data.history || [];
  } catch {
    state.chatHistory = [];
  }
  renderChatHistory();
}

async function clearChatHistory() {
  if (!state.selected) return;
  if (!confirm("清空本篇文献的全部对话记录？此操作不可撤销。")) return;
  try {
    await api("/api/chat-history/clear", {
      method: "POST",
      body: JSON.stringify({ paper_id: state.selected.paper_id }),
    });
    state.chatHistory = [];
    renderChatHistory();
    $("aiAnswer").classList.add("hidden");
    $("aiStatus").textContent = "已清空";
  } catch (e) {
    alert("清空失败：" + e.message);
  }
}

function updateImageAskSummary() {
  const enabled = $("imageAskToggle").checked;
  const pages = $("imagePageInput").value.trim();
  $("imageAskSummary").textContent = enabled ? `已启用${pages ? ` · 页码 ${pages}` : " · 未填页码"}` : "未启用";
  $("imageAskOpenBtn").classList.toggle("active", enabled);
}

function openImageAskModal() {
  if (!state.selected) return;
  $("imageAskModal").classList.remove("hidden");
}

function closeImageAskModal() {
  $("imageAskModal").classList.add("hidden");
  updateImageAskSummary();
}

async function appendToNote() {
  if (!state.selected) return;
  const content = $("appendContent").value.trim();
  if (!content) return;
  $("appendNoteBtn").disabled = true;
  try {
    const data = await api("/api/note/append", {
      method: "POST",
      body: JSON.stringify({
        paper_id: state.selected.paper_id,
        title: $("appendTitle").value,
        content,
      }),
    });
    state.note = data.note;
    $("noteEditor").value = state.note;
    $("notePreview").innerHTML = `<p>${markdownLite(state.note)}</p>`;
    $("aiStatus").textContent = "已追加到笔记";
  } catch (error) {
    $("aiStatus").textContent = error.message;
  } finally {
    $("appendNoteBtn").disabled = false;
  }
}

async function extractEnglishExcerpts() {
  if (!state.selected) return;
  const btn = $("excerptBtn");
  const status = $("excerptStatus");
  const result = $("excerptResult");
  btn.disabled = true;
  status.textContent = "AI 正在摘录英文好句…";
  result.classList.add("hidden");
  result.textContent = "";
  try {
    const data = await api("/api/excerpt", {
      method: "POST",
      body: JSON.stringify({
        paper_id: state.selected.paper_id,
        append_note: false,
      }),
    });
    result.textContent = data.answer;
    result.classList.remove("hidden");
    const usage = data.usage || {};
    status.textContent = usage.total_tokens
      ? `已追加到全部好句库 · ${usage.total_tokens} tokens`
      : "已追加到全部好句库";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    btn.disabled = false;
  }
}

async function deleteSelectedPaper() {
  if (!state.selected) return;
  const title = getEnglishTitle(state.selected);
  const ok = confirm(
    `确认删除这篇文献吗？\n\n${title}\n\n将删除库内 PDF、Markdown 笔记、文本缓存、AI 缓存，并从总表和分类索引移除。`
  );
  if (!ok) return;
  $("deletePaperBtn").disabled = true;
  try {
    await api("/api/paper/delete", {
      method: "POST",
      body: JSON.stringify({ paper_id: state.selected.paper_id }),
    });
    clearSelectedView();
    await loadConfig();
    await loadCategories();
    await loadPapers();
  } catch (error) {
    alert(error.message);
    $("deletePaperBtn").disabled = false;
  }
}

async function helpReadCurrentPaper() {
  if (!state.selected) return;
  const btn = $("helpReadBtn");
  const paperId = state.selected.paper_id;
  if (!confirm(
    `让 AI 重新阅读这篇文献？\n\n会刷新：标题 / 中英文标题 / 作者 / 年份 / 期刊 / DOI / 一句话总结 / 关键词 / 研究方法 / 与论文关系 / 笔记正文。\n\n不会动：你的分类、AI 分类建议、重要性、阅读状态、备注、人工笔记区。`
  )) {
    return;
  }
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "AI 阅读中…";
  try {
    await api("/api/paper/help-read", {
      method: "POST",
      body: JSON.stringify({ paper_id: paperId }),
    });
    const paperData = await api(`/api/paper?paper_id=${encodeURIComponent(paperId)}`);
    state.selected = paperData.paper;
    const noteData = await api(`/api/note?paper_id=${encodeURIComponent(paperId)}`);
    state.note = noteData.content;
    await loadPapers();
    renderSelected();
    btn.textContent = "已刷新 ✓";
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
  } catch (error) {
    // The hr-overlay (app-design-helpread.js) already shows the error persistently
    // via fetch hook. Only fall back to alert if the overlay didn't load.
    if (!window.hrOverlay) {
      alert("帮我阅读失败：" + error.message);
    } else {
      console.warn("[help-read] error (shown in overlay):", error);
    }
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function loadCitationList() {
  try {
    const data = await api("/api/citations");
    state.citations = data.citations || [];
    const select = $("helpCiteSelect");
    if (select) {
      const previousValue = select.value;
      select.innerHTML = state.citations.length
        ? state.citations
            .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.display_name || c.name)} (${c.entry_count})</option>`)
            .join("")
        : '<option value="">尚未创建任何 citation</option>';
      if (previousValue && state.citations.some((c) => c.name === previousValue)) {
        select.value = previousValue;
      }
      const hasCitations = state.citations.length > 0;
      select.disabled = !hasCitations;
      $("helpCiteBtn").disabled = !hasCitations || !state.selected;
    }
    // sync the AI work-context dropdown
    const workSelect = $("aiWorkContext");
    if (workSelect) {
      const saved = state.workContext || (typeof localStorage !== "undefined" ? localStorage.getItem("aiWorkContext") : "") || "";
      const previousValue = workSelect.value || saved;
      workSelect.innerHTML = '<option value="">无 — 只基于这篇文献</option>'
        + state.citations
            .map((c) => `<option value="${escapeHtml(c.name)}">${escapeHtml(c.display_name || c.name)}</option>`)
            .join("");
      if (previousValue && state.citations.some((c) => c.name === previousValue)) {
        workSelect.value = previousValue;
        state.workContext = previousValue;
      } else {
        workSelect.value = "";
        state.workContext = "";
      }
    }
  } catch (e) {
    console.error("loadCitationList failed", e);
  }
}

async function helpCiteCurrentPaper() {
  if (!state.selected) return;
  const btn = $("helpCiteBtn");
  const citationName = $("helpCiteSelect").value;
  if (!citationName) {
    alert("请先在右侧下拉里选一个 citation 文件");
    return;
  }
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "AI 生成中…";
  try {
    const data = await api("/api/citation/help-cite", {
      method: "POST",
      body: JSON.stringify({
        paper_id: state.selected.paper_id,
        citation: citationName,
      }),
    });
    btn.textContent = "已追加 ✓";
    await loadCitationList();
    // Show a preview of the AI-generated entry
    const previewMsg = `已追加到 ${citationName}.md：\n\n${(data.entry || "").slice(0, 600)}\n\n（完整记录已写入文件，可在设置→引用文件管理中查看）`;
    setTimeout(() => alert(previewMsg), 100);
    setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1500);
  } catch (error) {
    alert("帮我引用失败：" + error.message);
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function organizeInbox() {
  $("organizeBtn").disabled = true;
  $("organizeBtn").textContent = "整理中";
  try {
    const data = await api("/api/organize", { method: "POST", body: "{}" });
    state.organizeJobId = data.job_id;
    showOrganizeProgress(data.job || {});
    pollOrganizeProgress(data.job_id);
  } catch (error) {
    alert(error.message);
    $("organizeBtn").disabled = false;
    $("organizeBtn").textContent = "整理新文献";
  }
}

function showOrganizeProgress(job = {}) {
  const current = Number(job.current || 0);
  const total = Number(job.total || 0);
  const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 8;
  const statusText = job.status === "done" ? "整理完成" : job.status === "error" ? "整理失败" : "正在整理";
  $("organizeProgress").classList.remove("hidden");
  $("organizeProgressTitle").textContent = statusText;
  $("organizeProgressMeta").textContent = `${total ? `${current}/${total}` : "准备中"} · 模型：${job.model || "读取中"}`;
  $("organizeProgressMessage").textContent = job.message || "";
  $("organizeProgressBarFill").style.width = `${percent}%`;
  $("organizeProgress").classList.toggle("error", job.status === "error");
}

function pollOrganizeProgress(jobId) {
  if (state.organizePollTimer) clearInterval(state.organizePollTimer);
  state.organizePollTimer = setInterval(async () => {
    try {
      const data = await api(`/api/organize/status?job_id=${encodeURIComponent(jobId)}`);
      const job = data.job || {};
      showOrganizeProgress(job);
      if (job.status === "done" || job.status === "error") {
        clearInterval(state.organizePollTimer);
        state.organizePollTimer = null;
        $("organizeBtn").disabled = false;
        $("organizeBtn").textContent = "整理新文献";
        if (job.status === "done") {
          await loadConfig();
          await loadCategoryTree();
          await loadCategories();
          await loadPapers();
          setTimeout(() => $("organizeProgress").classList.add("hidden"), 5000);
        }
      }
    } catch (error) {
      clearInterval(state.organizePollTimer);
      state.organizePollTimer = null;
      $("organizeProgressMessage").textContent = error.message;
      $("organizeProgress").classList.add("error");
      $("organizeBtn").disabled = false;
      $("organizeBtn").textContent = "整理新文献";
    }
  }, 1000);
}

async function refreshScanStatus() {
  $("scanRefreshBtn").disabled = true;
  $("scanRefreshBtn").textContent = "标记中";
  try {
    const data = await api("/api/scan-status/refresh", { method: "POST", body: "{}" });
    $("modelLabel").textContent = `扫描件 ${data.scanned} · 疑似 ${data.suspected} · 共 ${data.count} 篇`;
    await loadCategories();
    await loadPapers();
  } catch (error) {
    alert(error.message);
  } finally {
    $("scanRefreshBtn").disabled = false;
    $("scanRefreshBtn").textContent = "刷新扫描标记";
  }
}

function bindEvents() {
  $("searchInput").addEventListener("input", debounce(loadPapers));
  $("categorySelect").addEventListener("change", loadPapers);
  $("readStatusFilter").addEventListener("change", loadPapers);
  $("importanceFilter").addEventListener("change", loadPapers);
  $("sortSelect")?.addEventListener("change", loadPapers);
  // 便签面板
  $("stickyNewInput")?.addEventListener("input", () => {
    $("stickyAddBtn").disabled = !$("stickyNewInput").value.trim();
  });
  $("stickyAddBtn")?.addEventListener("click", () => addSticky().catch((e) => {
    $("stickyStatus").textContent = e.message;
  }));
  $("saveNoteBtn").addEventListener("click", () => saveNote(false));
  $("noteEditor").addEventListener("input", autosaveNote);
  $("saveMetaBtn").addEventListener("click", () => saveMeta(false));
  for (const id of [
    "titleEn",
    "titleZh",
    "venue",
    "journalQuartile",
    "journalRankManual",
    "importance",
    "readStatus",
    "myRemark",
    "flagSSCI",
    "flagSCI",
    "flagUTD",
    "flagFT50",
    "flagABS",
  ]) {
    $(id).addEventListener("input", autosaveMeta);
    $(id).addEventListener("change", autosaveMeta);
  }
  $("classificationBox").addEventListener("click", openCategoryModal);
  $("closeCategoryBtn").addEventListener("click", () => $("categoryModal").classList.add("hidden"));
  $("openTreeManagerBtn")?.addEventListener("click", () => {
    renderCategoryTree();
    $("treeManagerModal").classList.remove("hidden");
  });
  $("closeTreeManagerBtn")?.addEventListener("click", () => {
    $("treeManagerModal").classList.add("hidden");
  });
  // 一级分类的事件已经在 renderPaperPrimaryChoices() 内绑定到每个 chip
  $("addPaperSecondaryBtn").addEventListener("click", () => {
    addPaperSecondary().catch((error) => {
      $("categorySaveStatus").textContent = error.message;
    });
  });
  $("savePaperCategoryBtn").addEventListener("click", () => {
    savePaperCategory().catch((error) => {
      $("categorySaveStatus").textContent = error.message;
    });
  });
  $("addPrimaryBtn").addEventListener("click", addPrimary);
  $("renamePrimaryBtn").addEventListener("click", renamePrimary);
  $("deletePrimaryBtn").addEventListener("click", deletePrimary);
  $("addSecondaryBtn").addEventListener("click", addSecondaryToTree);
  $("renameSecondaryBtn")?.addEventListener("click", renameSecondary);
  $("deleteSecondaryBtn")?.addEventListener("click", deleteSecondary);
  $("addTertiaryBtn")?.addEventListener("click", addTertiary);
  $("renameTertiaryBtn")?.addEventListener("click", renameTertiary);
  $("deleteTertiaryBtn")?.addEventListener("click", deleteTertiary);
  $("newPrimaryInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addPrimary(); }
  });
  $("newSecondaryInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addSecondaryToTree(); }
  });
  $("newTertiaryInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addTertiary(); }
  });
  $("askBtn").addEventListener("click", askAi);
  const clearChatBtn = $("clearChatBtn");
  if (clearChatBtn) clearChatBtn.addEventListener("click", clearChatHistory);
  const workSelect = $("aiWorkContext");
  if (workSelect) {
    workSelect.addEventListener("change", (e) => {
      state.workContext = e.target.value || "";
      if (typeof localStorage !== "undefined") {
        try { localStorage.setItem("aiWorkContext", state.workContext); } catch {}
      }
    });
  }
  const saveUiBtn = $("saveUiBtn");
  if (saveUiBtn) saveUiBtn.addEventListener("click", saveUiSettings);
  $("appendNoteBtn").addEventListener("click", appendToNote);
  $("excerptBtn").addEventListener("click", extractEnglishExcerpts);
  $("imageAskOpenBtn").addEventListener("click", openImageAskModal);
  $("closeImageAskBtn").addEventListener("click", closeImageAskModal);
  $("saveImageAskBtn").addEventListener("click", closeImageAskModal);
  $("imageAskToggle").addEventListener("change", updateImageAskSummary);
  $("imagePageInput").addEventListener("input", updateImageAskSummary);
  $("deletePaperBtn").addEventListener("click", deleteSelectedPaper);
  $("translateClipboardBtn")?.addEventListener("click", () => {
    translateClipboard().catch((e) => {
      $("translateStatus").textContent = e.message;
    });
  });
  $("closeTranslateBtn").addEventListener("click", () => $("translatePopup").classList.add("hidden"));
  const sidebarToggle = $("sidebarToggle");
  if (sidebarToggle) {
    sidebarToggle.addEventListener("click", () => setSidebarCollapsed(!state.sidebarCollapsed));
  }
  $("organizeBtn").addEventListener("click", organizeInbox);
  $("helpReadBtn").addEventListener("click", helpReadCurrentPaper);
  $("refreshRankBtn")?.addEventListener("click", refreshRankCurrentPaper);
  $("refreshRankAllBtn")?.addEventListener("click", refreshRankAll);
  $("exportCategoryBtn")?.addEventListener("click", openExportCategoryModal);
  $("closeExportCategoryBtn")?.addEventListener("click", () => $("exportCategoryModal").classList.add("hidden"));
  $("runExportCategoryBtn")?.addEventListener("click", () => runExportCategory().catch((e) => {
    $("exportCategoryStatus").textContent = e.message;
  }));
  $("helpCiteBtn").addEventListener("click", helpCiteCurrentPaper);
  $("scanRefreshBtn").addEventListener("click", refreshScanStatus);
  $("settingsBtn").addEventListener("click", async () => {
    await loadSettings();
    await loadTranslationSettings();
    await loadPrompts();
    await loadTrackingJournals();
    $("settingsModal").classList.remove("hidden");
  });
  $("closeSettingsBtn").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("saveTranslationBtn").addEventListener("click", saveTranslationSettings);
  $("saveEasyscholarBtn")?.addEventListener("click", saveEasyscholarSettings);
  $("saveOcrBtn")?.addEventListener("click", saveOcrSettings);
  $("saveVisionBtn")?.addEventListener("click", saveVisionSettings);
  document.querySelectorAll("#visionProviderTabs button").forEach((btn) => {
    btn.addEventListener("click", () => showVisionPanel(btn.dataset.visionPanel));
  });
  $("visionProvider")?.addEventListener("change", (e) => {
    showVisionPanel(e.target.value);
    // also update the "当前激活" hint
    const hint = $("visionActiveHint");
    if (hint) hint.textContent = `已切换到 ${e.target.value}，记得点「保存视觉设置」生效`;
  });
  document.querySelectorAll("#translationProviderTabs button").forEach((btn) => {
    btn.addEventListener("click", () => showTranslationProviderPanel(btn.dataset.transProvider));
  });
  $("createCitationBtn").addEventListener("click", createCitation);
  $("saveCitationBtn").addEventListener("click", saveCurrentCitation);
  $("deleteCitationBtn").addEventListener("click", deleteCurrentCitation);
  $("savePromptsBtn").addEventListener("click", savePrompts);
  $("addJournalBtn").addEventListener("click", addTrackingJournal);
  $("saveJournalsBtn").addEventListener("click", saveTrackingJournals);
  document.querySelectorAll("#settingsTabs button").forEach((button) => {
    button.addEventListener("click", () => showSettingsTab(button.dataset.settingsTab));
  });
  document.querySelectorAll("#providerTabs button").forEach((button) => {
    button.addEventListener("click", () => showProviderPanel(button.dataset.provider));
  });
  $("previewBtn").addEventListener("click", () => {
    state.preview = !state.preview;
    $("notePreview").classList.toggle("hidden", !state.preview);
    $("noteEditor").classList.toggle("hidden", state.preview);
    $("previewBtn").textContent = state.preview ? "编辑" : "预览";
  });
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      $(`${tab.dataset.tab}Panel`).classList.add("active");
    });
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => {
    button.addEventListener("click", () => {
      $("questionInput").value = button.dataset.prompt;
    });
  });
}

function initViewer() {
  const container = $("pdfViewer");
  state.viewer = new PDFViewer(container);
  state.viewer.on("onError", (err) => console.error("pdf viewer error", err));
  // Expose for debugging
  window._lwState = state;
}

// 心跳：每 15s ping 一次后端，让后台 watcher 知道浏览器还在；浏览器关掉
// 后约 60s 工作台进程会自动退出（在 server.py 里实现）。
function startHeartbeat() {
  // Track the last rebuild_error ts we showed so a still-stuck Excel doesn't
  // re-toast every 15s, but a new error after recovery does.
  let lastRebuildErrTs = null;
  const beat = async () => {
    try {
      const resp = await fetch("/api/heartbeat");
      const data = await resp.json().catch(() => null);
      if (data && data.rebuild_error && data.rebuild_error.ts && data.rebuild_error.ts !== lastRebuildErrTs) {
        lastRebuildErrTs = data.rebuild_error.ts;
        notify.errorPersist(data.rebuild_error.message);
      }
      if (data && !data.rebuild_error) lastRebuildErrTs = null;
    } catch {
      // Heartbeat failure is intentionally silent — server might be restarting.
    }
  };
  beat();
  setInterval(beat, 15000);
  // 切回前台时立刻补一次心跳，避免休眠/隐藏后被误判离线
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") beat();
  });
}

// When the phase5 classification modal saves, it dispatches this event so
// app.js can (a) sync state.selected to the freshly-saved paper — otherwise
// a later meta-panel save re-sends a stale row and wipes categories; and
// (b) refresh the sidebar category counts + paper list.
document.addEventListener("dc-paper-categorized", async (e) => {
  const detail = (e && e.detail) || {};
  const paper = detail.paper;
  if (paper && state.selected && state.selected.paper_id === detail.paperId) {
    state.selected = paper;
    renderClassificationBox(state.selected);
  }
  try { await loadCategories(); } catch (err) { console.error("loadCategories after categorize failed", err); }
  try { await loadPapers(); } catch (err) { console.error("loadPapers after categorize failed", err); }
});

async function init() {
  initViewer();
  bindEvents();
  await loadConfig();
  await loadUiSettings();
  await loadCategoryTree();
  await loadCategories();
  await loadCitationList();
  await loadPapers();
  startHeartbeat();
}

init().catch((error) => {
  document.body.innerHTML = `<pre>${escapeHtml(error.stack || error.message)}</pre>`;
});
