/* ============================================================
 * 文献工作台 — Phase 5: 3-col category modal + excerpt cards + settings polish.
 *
 * — Category modal: intercept the classification-box click and open
 *   #categoryModalV2 with a 3-column linked picker; saves via existing
 *   /api/paper endpoint.
 * — Excerpt: parse the /api/excerpt plain-text response into structured
 *   cards (quote + usage note) with per-card "复制 / 入便签 / 删除" actions.
 *   Excerpt deletion is local-only (modifies the rendered list) — the
 *   .md file on disk is the source of truth; clean it manually if needed.
 * — Settings: insert a connection-status card at the top of the model
 *   settings section so you can see provider health at a glance.
 *
 * NO backend changes required.
 * ============================================================ */

(function () {
  "use strict";

  const origFetch = window.fetch.bind(window);

  // ============================================================
  // 1. Category modal v2: 3-column linked picker
  // ============================================================
  let categoryTree = {}; // { primary: { secondary: [tertiary, ...] } }
  let categoryCounts = {}; // name -> count
  let draft = { primaries: new Set(), secondaries: new Set(), tertiaries: new Set() };
  let focused = { primary: null, secondary: null };
  let aiSuggestions = { primary: null, secondaries: [], tertiaries: [] };
  let currentPaper = null;

  function splitList(value) {
    // 只按 `；` `;` 切分；逗号是分类名里的合法字符（比如
    // "Mapping ... A Structural, Temporal, and Spatial Analysis"），
    // 按逗号切会把单个长分类名切成 3 段，导致弹窗无法勾选回来。
    return String(value || "")
      .split(/[;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async function loadTreeAndCounts() {
    try {
      const [treeResp, countsResp] = await Promise.all([
        origFetch("/api/category-tree"),
        origFetch("/api/categories"),
      ]);
      if (treeResp.ok) {
        const data = await treeResp.json();
        categoryTree = data.tree || {};
      }
      if (countsResp.ok) {
        const data = await countsResp.json();
        categoryCounts = {};
        (data.categories || []).forEach((c) => {
          categoryCounts[c.name] = c.count;
        });
      }
    } catch (_) {}
  }

  async function loadCurrentPaper(paperId) {
    if (!paperId) return null;
    try {
      const resp = await origFetch(
        `/api/paper?paper_id=${encodeURIComponent(paperId)}`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return data.paper;
    } catch (_) {
      return null;
    }
  }

  function getActivePaperId() {
    // Heuristic: find the active sidebar item and reverse-lookup, or
    // pull from delete button data, or rely on a global cache.
    // Cleanest: ask /api/papers and find by title — but that's slow.
    // Instead: use a fetch-interceptor cache (mirrored from phase2).
    return window.__litHubCurrentPaperId || null;
  }

  // Mirror phase2's fetch interceptor for paper id tracking
  window.fetch = function (...args) {
    const url = args[0];
    if (typeof url === "string") {
      const m = url.match(/\/api\/paper\?paper_id=([^&]+)/);
      if (m) window.__litHubCurrentPaperId = decodeURIComponent(m[1]);
    }
    return origFetch(...args);
  };

  async function openCategoryModalV2() {
    const paperId = getActivePaperId();
    if (!paperId) {
      alert("请先选中一篇文献。");
      return;
    }
    await loadTreeAndCounts();
    currentPaper = await loadCurrentPaper(paperId);
    if (!currentPaper) {
      alert("加载文献信息失败。");
      return;
    }
    // Hydrate draft from paper
    draft = {
      primaries: new Set(splitList(currentPaper["一级分类"])),
      secondaries: new Set(splitList(currentPaper["二级分类"])),
      tertiaries: new Set(splitList(currentPaper["三级分类"])),
    };
    aiSuggestions = {
      primary: currentPaper["AI建议一级"] || currentPaper["AI建议分类_一级"] || "",
      secondaries: splitList(
        currentPaper["AI建议二级"] || currentPaper["AI建议分类_二级"] || ""
      ),
      tertiaries: splitList(
        currentPaper["AI建议三级"] || currentPaper["AI建议分类_三级"] || ""
      ),
    };
    // Set focus to first selected (or AI-suggested, or first) primary
    const primaryNames = Object.keys(categoryTree);
    focused.primary =
      Array.from(draft.primaries)[0] ||
      (aiSuggestions.primary && primaryNames.includes(aiSuggestions.primary)
        ? aiSuggestions.primary
        : primaryNames[0]) ||
      null;
    focused.secondary =
      Array.from(draft.secondaries)[0] || aiSuggestions.secondaries[0] || null;

    // Set subtitle
    const sub = document.getElementById("categoryV2Subtitle");
    if (sub) {
      const title =
        currentPaper["英文标题"] ||
        currentPaper.title_en ||
        currentPaper["中文标题"] ||
        paperId;
      sub.textContent = title.length > 60 ? title.slice(0, 60) + "…" : title;
    }

    document.getElementById("categoryModalV2")?.classList.remove("hidden");
    renderAll();
  }

  function renderAll() {
    renderPathRow();
    renderPrimaryCol();
    renderSecondaryCol();
    renderTertiaryCol();
  }

  function renderPathRow() {
    const row = document.getElementById("catPathRow");
    const chips = document.getElementById("catPathChips");
    if (!row || !chips) return;
    chips.innerHTML = "";
    const primaries = Array.from(draft.primaries);
    const secondaries = Array.from(draft.secondaries);
    const tertiaries = Array.from(draft.tertiaries);
    const empty =
      !primaries.length && !secondaries.length && !tertiaries.length;
    row.classList.toggle("empty", empty);
    if (empty) {
      const span = document.createElement("span");
      span.style.color = "var(--muted-soft)";
      span.style.fontSize = "12px";
      span.textContent = "尚未选择任何分类";
      chips.appendChild(span);
      return;
    }
    // Render each primary as a separate row
    primaries.forEach((prim) => {
      const path = [];
      path.push({ label: prim, color: "primary" });
      // include matched secondaries
      const subs = (categoryTree[prim] || {});
      const matched2 = secondaries.filter((s) => subs[s] !== undefined);
      matched2.forEach((sec) => {
        path.push({ label: sec, color: "secondary" });
        // matched tertiaries
        const ters = (subs[sec] || []).filter((t) => tertiaries.includes(t));
        ters.forEach((ter) => path.push({ label: ter, color: "tertiary" }));
      });
      path.forEach((node, i) => {
        if (i > 0) {
          const sep = document.createElement("span");
          sep.className = "path-sep";
          sep.textContent = "›";
          chips.appendChild(sep);
        }
        const chip = document.createElement("span");
        chip.className = "path-chip";
        chip.textContent = node.label;
        chips.appendChild(chip);
      });
      const br = document.createElement("span");
      br.style.flexBasis = "100%";
      chips.appendChild(br);
    });
  }

  function renderPrimaryCol() {
    const list = document.getElementById("catPrimaryList");
    const tag = document.getElementById("catPrimaryTag");
    if (!list) return;
    list.innerHTML = "";
    const names = Object.keys(categoryTree);
    if (tag) tag.textContent = `${names.length} 项 · 多选`;
    names.forEach((name) => {
      const row = mkCatRow({
        text: name,
        count: categoryCounts[name],
        selected: draft.primaries.has(name),
        focused: focused.primary === name,
        ai: aiSuggestions.primary === name,
        onClick: (e) => {
          // ALWAYS move focus to this primary so the 二级 column refreshes
          // immediately — clicking the checkbox used to only toggle selection,
          // forcing a second click on the text to navigate.
          focused.primary = name;
          if (e.target.closest(".checkbox")) {
            toggleSet(draft.primaries, name);
          }
          renderAll();
        },
        onRename: () => renamePrimary(name),
        onDelete: () => deletePrimary(name),
      });
      list.appendChild(row);
    });
  }

  function renderSecondaryCol() {
    const list = document.getElementById("catSecondaryList");
    const head = document.getElementById("catSecondaryHead");
    const tag = document.getElementById("catSecondaryTag");
    if (!list) return;
    list.innerHTML = "";
    if (!focused.primary || !categoryTree[focused.primary]) {
      if (head) head.textContent = "二级";
      if (tag) tag.textContent = "";
      return;
    }
    if (head) head.textContent = `二级 · ${focused.primary}`;
    const subs = categoryTree[focused.primary] || {};
    const names = Object.keys(subs);
    if (tag) tag.textContent = `${names.length} 项`;
    names.forEach((name) => {
      const row = mkCatRow({
        text: name,
        count: categoryCounts[name],
        selected: draft.secondaries.has(name),
        focused: focused.secondary === name,
        ai: aiSuggestions.secondaries.includes(name),
        onClick: (e) => {
          // ALWAYS move focus so the 三级 column refreshes on a single click
          focused.secondary = name;
          if (e.target.closest(".checkbox")) {
            const wasOn = draft.secondaries.has(name);
            toggleSet(draft.secondaries, name);
            // Cascade up: selecting a 二级 auto-selects its parent 一级 —
            // a paper can't be in a sub-category without its parent.
            if (!wasOn && draft.secondaries.has(name) && focused.primary) {
              draft.primaries.add(focused.primary);
            }
          }
          renderAll();
        },
        onRename: () => renameSecondary(name),
        onDelete: () => deleteSecondary(name),
      });
      list.appendChild(row);
    });
  }

  function renderTertiaryCol() {
    const list = document.getElementById("catTertiaryList");
    const head = document.getElementById("catTertiaryHead");
    const tag = document.getElementById("catTertiaryTag");
    if (!list) return;
    list.innerHTML = "";
    if (!focused.secondary) {
      if (head) head.textContent = "三级";
      if (tag) tag.textContent = "";
      return;
    }
    if (head) head.textContent = `三级 · ${focused.secondary}`;
    const ters = ((categoryTree[focused.primary] || {})[focused.secondary]) || [];
    if (tag) tag.textContent = `${ters.length} 项`;
    ters.forEach((name) => {
      const row = mkCatRow({
        text: name,
        count: categoryCounts[name],
        selected: draft.tertiaries.has(name),
        focused: false,
        ai: aiSuggestions.tertiaries.includes(name),
        onClick: () => {
          const wasOn = draft.tertiaries.has(name);
          toggleSet(draft.tertiaries, name);
          // Cascade up: selecting a 三级 auto-selects its parent 二级 AND
          // grandparent 一级.
          if (!wasOn && draft.tertiaries.has(name)) {
            if (focused.secondary) draft.secondaries.add(focused.secondary);
            if (focused.primary) draft.primaries.add(focused.primary);
          }
          renderAll();
        },
        onRename: () => renameTertiary(name),
        onDelete: () => deleteTertiary(name),
      });
      list.appendChild(row);
    });
  }

  function mkCatRow({ text, count, selected, focused, ai, onClick, onRename, onDelete }) {
    const row = document.createElement("div");
    row.className = "cat-row";
    if (selected) row.classList.add("selected");
    if (focused) row.classList.add("focused");
    if (ai && !selected) row.classList.add("ai-suggest");
    row.innerHTML = `
      <span class="checkbox"></span>
      <span class="row-text"></span>
      ${count != null ? `<span class="row-count">${count}</span>` : ""}
      <span class="row-actions">
        <button type="button" data-act="rename" title="重命名">✎</button>
        <button type="button" data-act="delete" class="danger" title="删除">×</button>
      </span>
    `;
    row.querySelector(".row-text").textContent = text;
    row.addEventListener("click", (e) => {
      if (e.target.closest('button[data-act="rename"]')) {
        e.stopPropagation();
        onRename?.();
        return;
      }
      if (e.target.closest('button[data-act="delete"]')) {
        e.stopPropagation();
        onDelete?.();
        return;
      }
      onClick?.(e);
    });
    return row;
  }

  function toggleSet(s, name) {
    if (s.has(name)) s.delete(name);
    else s.add(name);
  }

  // ---------- inline-add ----------
  function bindAddRow(inputId, btnId, handler) {
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if (!input || !btn) return;
    btn.addEventListener("click", () => {
      const v = input.value.trim();
      if (!v) return;
      handler(v);
      input.value = "";
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        btn.click();
      }
    });
  }

  function addPrimary(name) {
    if (!categoryTree[name]) categoryTree[name] = {};
    draft.primaries.add(name);
    focused.primary = name;
    saveCategoryTree().then(renderAll);
  }
  function addSecondary(name) {
    if (!focused.primary) return alert("请先在左列选一个一级分类。");
    const subs = categoryTree[focused.primary] || (categoryTree[focused.primary] = {});
    if (!subs[name]) subs[name] = [];
    draft.secondaries.add(name);
    focused.secondary = name;
    saveCategoryTree().then(renderAll);
  }
  function addTertiary(name) {
    if (!focused.primary || !focused.secondary)
      return alert("请先在中间列选一个二级分类。");
    const ters = categoryTree[focused.primary][focused.secondary] || [];
    if (!ters.includes(name)) ters.push(name);
    categoryTree[focused.primary][focused.secondary] = ters;
    draft.tertiaries.add(name);
    saveCategoryTree().then(renderAll);
  }

  // 重命名一个分类。关键：必须走专门的 rename 接口 —— 它会同时
  //   (1) 改 settings.yaml 里的分类树；
  //   (2) migrate_rows_for_rename 把所有文献分类字段里的旧名换成新名。
  // 之前这里只 POST /api/category-tree（只存树、不迁移文献），导致树里
  // 是新名、文献里还是旧名 —— 外面的分类徽章一直不变。
  async function renameCategoryViaApi(endpoint, payload, label) {
    let data;
    try {
      const resp = await origFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) {
        alert("重命名失败：" + (data.error || `HTTP ${resp.status}`));
        return null;
      }
    } catch (err) {
      alert("重命名失败：" + err.message);
      return null;
    }
    // 旧名计数清零、新名接管 —— 刷新弹窗里的计数
    try {
      const r = await origFetch("/api/categories");
      if (r.ok) {
        const d = await r.json();
        categoryCounts = {};
        (d.categories || []).forEach((c) => (categoryCounts[c.name] = c.count));
      }
    } catch (err) {
      console.warn("[phase5] refresh counts after rename failed:", err);
    }
    // 通知 app.js：重载分类树 / 计数 / 文献列表 / 当前文献元信息
    document.dispatchEvent(new CustomEvent("dc-categories-renamed"));
    const status = document.getElementById("catSaveStatus");
    if (status) {
      status.textContent = `已重命名${label || ""}，同步 ${data.migrated || 0} 篇文献`;
      setTimeout(() => { if (status) status.textContent = ""; }, 4000);
    }
    return data;
  }

  async function renamePrimary(name) {
    const newName = prompt(`把一级分类「${name}」改名为：`, name);
    if (!newName || newName.trim() === "" || newName === name) return;
    const trimmed = newName.trim();
    if (categoryTree[trimmed]) return alert("已存在同名一级分类。");
    const res = await renameCategoryViaApi(
      "/api/category-tree/rename-primary", { old: name, new: trimmed }, "一级分类"
    );
    if (!res) return;
    categoryTree[trimmed] = categoryTree[name];
    delete categoryTree[name];
    if (draft.primaries.has(name)) {
      draft.primaries.delete(name);
      draft.primaries.add(trimmed);
    }
    if (focused.primary === name) focused.primary = trimmed;
    renderAll();
  }
  async function deletePrimary(name) {
    if (!confirm(`删除一级分类「${name}」？\n所有挂在它下面的二级、三级一并删除。`)) return;
    delete categoryTree[name];
    draft.primaries.delete(name);
    if (focused.primary === name) focused.primary = Object.keys(categoryTree)[0] || null;
    await saveCategoryTree();
    renderAll();
  }
  async function renameSecondary(name) {
    if (!focused.primary) return;
    const newName = prompt(`把二级分类「${name}」改名为：`, name);
    if (!newName || newName.trim() === "" || newName === name) return;
    const trimmed = newName.trim();
    const subs = categoryTree[focused.primary] || {};
    if (subs[trimmed]) return alert("已存在同名二级分类。");
    const res = await renameCategoryViaApi(
      "/api/category-tree/rename-secondary",
      { primary: focused.primary, old: name, new: trimmed }, "二级分类"
    );
    if (!res) return;
    subs[trimmed] = subs[name];
    delete subs[name];
    if (draft.secondaries.has(name)) {
      draft.secondaries.delete(name);
      draft.secondaries.add(trimmed);
    }
    if (focused.secondary === name) focused.secondary = trimmed;
    renderAll();
  }
  async function deleteSecondary(name) {
    if (!focused.primary) return;
    if (!confirm(`删除二级分类「${name}」？\n挂在它下面的三级一并删除。`)) return;
    const subs = categoryTree[focused.primary] || {};
    delete subs[name];
    draft.secondaries.delete(name);
    if (focused.secondary === name) focused.secondary = Object.keys(subs)[0] || null;
    await saveCategoryTree();
    renderAll();
  }
  async function renameTertiary(name) {
    if (!focused.primary || !focused.secondary) return;
    const newName = prompt(`把三级分类「${name}」改名为：`, name);
    if (!newName || newName.trim() === "" || newName === name) return;
    const trimmed = newName.trim();
    let arr = (categoryTree[focused.primary][focused.secondary] || []);
    if (arr.includes(trimmed)) return alert("已存在同名三级分类。");
    const res = await renameCategoryViaApi(
      "/api/category-tree/rename-tertiary",
      { primary: focused.primary, secondary: focused.secondary, old: name, new: trimmed },
      "三级分类"
    );
    if (!res) return;
    arr = arr.map((x) => (x === name ? trimmed : x));
    categoryTree[focused.primary][focused.secondary] = arr;
    if (draft.tertiaries.has(name)) {
      draft.tertiaries.delete(name);
      draft.tertiaries.add(trimmed);
    }
    renderAll();
  }
  async function deleteTertiary(name) {
    if (!focused.primary || !focused.secondary) return;
    if (!confirm(`删除三级分类「${name}」？`)) return;
    let arr = (categoryTree[focused.primary][focused.secondary] || []).filter((x) => x !== name);
    categoryTree[focused.primary][focused.secondary] = arr;
    draft.tertiaries.delete(name);
    await saveCategoryTree();
    renderAll();
  }

  async function saveCategoryTree() {
    try {
      await origFetch("/api/category-tree", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tree: categoryTree }),
      });
      const resp = await origFetch("/api/categories");
      if (resp.ok) {
        const data = await resp.json();
        categoryCounts = {};
        (data.categories || []).forEach((c) => (categoryCounts[c.name] = c.count));
      }
    } catch (err) {
      console.warn("[phase5] save tree failed:", err);
    }
  }

  async function applyCategoryToPaper() {
    const paperId = getActivePaperId();
    if (!paperId) return;
    const status = document.getElementById("catSaveStatus");
    if (status) status.textContent = "保存中…";
    const primaries = Array.from(draft.primaries);
    const secondaries = Array.from(draft.secondaries);
    const tertiaries = Array.from(draft.tertiaries);
    // CRITICAL: join with `；` (NOT `,`). Category names legitimately contain
    // commas; splitList()/categories_from_rows() only split on `；;`. Joining
    // multi-select with `,` produced one phantom token "CatA,CatB" that matched
    // no tree node -> on re-open every checkbox rendered blank (bug #2).
    const SEP = "；";
    const final =
      (tertiaries.length ? tertiaries.join(SEP) : "") ||
      (secondaries.length ? secondaries.join(SEP) : "") ||
      (primaries.length ? primaries.join(SEP) : "") ||
      "未分类";
    try {
      const resp = await origFetch("/api/paper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paper_id: paperId,
          fields: {
            一级分类: primaries.join(SEP),
            二级分类: secondaries.join(SEP),
            三级分类: tertiaries.join(SEP),
            最终分类: final,
          },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${resp.status}`);
      }
      if (status) status.textContent = "已保存";
      // Notify app.js so it can: (a) sync state.selected to the freshly-saved
      // paper — otherwise a later meta-panel save re-sends the STALE
      // pre-classification row and wipes the categories (bug #3); and
      // (b) re-fetch /api/categories so the sidebar counts update (bug #1).
      document.dispatchEvent(new CustomEvent("dc-paper-categorized", {
        detail: { paperId, paper: data.paper || null },
      }));
      // Update the visible classification summary
      const summary = document.getElementById("classificationSummary");
      if (summary) summary.textContent = final || "未设置";
      const box = document.getElementById("classificationBox");
      if (box) box.classList.toggle("empty", final === "未分类" || !final);
      setTimeout(() => {
        document.getElementById("categoryModalV2")?.classList.add("hidden");
        if (status) status.textContent = "";
      }, 500);
    } catch (err) {
      if (status) status.textContent = "保存失败：" + err.message;
    }
  }

  function clearDraft() {
    draft.primaries.clear();
    draft.secondaries.clear();
    draft.tertiaries.clear();
    renderAll();
  }

  // ---------- Wire up category modal v2 ----------
  function installCategoryModalV2() {
    // Replace classificationBox click to open v2 modal
    const box = document.getElementById("classificationBox");
    if (box) {
      box.addEventListener(
        "click",
        (e) => {
          e.stopImmediatePropagation();
          openCategoryModalV2();
        },
        { capture: true }
      );
    }
    document.getElementById("closeCategoryV2Btn")?.addEventListener("click", () => {
      document.getElementById("categoryModalV2")?.classList.add("hidden");
    });
    document.getElementById("catCancelBtn")?.addEventListener("click", () => {
      document.getElementById("categoryModalV2")?.classList.add("hidden");
    });
    document.getElementById("catApplyBtn")?.addEventListener("click", applyCategoryToPaper);
    document.getElementById("catClearLink")?.addEventListener("click", clearDraft);
    bindAddRow("catPrimaryNew", "catPrimaryAdd", addPrimary);
    bindAddRow("catSecondaryNew", "catSecondaryAdd", addSecondary);
    bindAddRow("catTertiaryNew", "catTertiaryAdd", addTertiary);
  }

  // ============================================================
  // 2. Excerpt structured cards — parse /api/excerpt response into cards
  // ============================================================

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])
    );
  }

  function parseExcerpts(text) {
    // Expected pattern from prompts/note_prompt — flexible:
    //   1. "english quote ..."
    //      用法/中文：how to use it
    //   2. ...
    const cards = [];
    const blocks = String(text)
      .split(/\n\s*\d+\s*[\.、]\s*/)
      .map((b) => b.trim())
      .filter(Boolean);
    for (const block of blocks) {
      // first line(s) up to a "用法" / "中文" / "解读" line → quote; rest → note
      const lines = block.split("\n").map((l) => l.trim());
      let quote = lines[0] || "";
      let note = "";
      for (let i = 1; i < lines.length; i++) {
        const l = lines[i];
        const m = l.match(/^(?:用法|中文|解读|含义|说明)\s*[：:]\s*(.*)$/);
        if (m) {
          note = m[1] + (i + 1 < lines.length ? " " + lines.slice(i + 1).join(" ") : "");
          break;
        } else if (!note && i === 1 && l && !/[".“]/.test(l[0])) {
          // continuation of quote? heuristic: if no label found and line lacks quote marks, treat as quote continuation
          quote += " " + l;
        } else {
          quote += " " + l;
        }
      }
      // strip surrounding quotes
      quote = quote.replace(/^["“”]+|["“”]+$/g, "").trim();
      if (quote) cards.push({ quote, note });
    }
    return cards;
  }

  function renderExcerptCards(text) {
    const host = document.getElementById("excerptResult");
    if (!host) return;
    const cards = parseExcerpts(text);
    if (!cards.length) {
      // Fall back to raw text
      host.textContent = text;
      host.classList.remove("hidden");
      return;
    }
    host.classList.remove("hidden");
    host.classList.remove("ai-answer"); // remove plain-text styling
    host.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "excerpt-pane";

    // Hero
    const hero = document.createElement("div");
    hero.className = "excerpt-hero";
    hero.innerHTML = `
      <div class="stat-row">
        <div><span class="big">${cards.length}</span> 本文献</div>
        <span class="sep">·</span>
        <div style="color:var(--muted-soft);font-size:11px">已追加到 <code style="font-family:var(--font-mono);background:rgba(255,255,255,0.5);padding:1px 4px;border-radius:3px">english_excerpts.md</code></div>
      </div>
      <div class="hero-actions">
        <a class="btn-ghost-x" href="/file?path=library/index/english_excerpts.md" target="_blank" rel="noreferrer">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 3h4v4"/><path d="M13 3l-6 6"/><path d="M3 5v8h8v-3"/></svg>
          .md 全库
        </a>
      </div>
    `;
    wrap.appendChild(hero);

    // List
    const list = document.createElement("div");
    list.className = "excerpt-list";
    cards.forEach((c, i) => {
      const card = document.createElement("div");
      card.className = "excerpt-card";
      if (i === 0) card.classList.add("fresh");
      card.innerHTML = `
        <div class="quote"></div>
        <div class="note">
          <span class="note-label">用法</span>
          <span class="note-text"></span>
        </div>
        <div class="ex-foot">
          <span class="ex-source">本文献 #${i + 1}</span>
          <span class="spacer"></span>
          <div class="ex-actions">
            <button data-act="copy" type="button">复制</button>
            <button data-act="sticky" type="button">入便签</button>
            <button data-act="remove" class="danger" type="button" title="从此次显示中移除（不会改 .md）">×</button>
          </div>
        </div>
      `;
      card.querySelector(".quote").textContent = c.quote;
      card.querySelector(".note-text").textContent = c.note || "（AI 未给出用法说明）";
      card.querySelector('[data-act="copy"]').addEventListener("click", () => {
        navigator.clipboard.writeText(c.quote).catch(() => {});
        card.querySelector('[data-act="copy"]').textContent = "✓ 已复制";
        setTimeout(() => {
          const b = card.querySelector('[data-act="copy"]');
          if (b) b.textContent = "复制";
        }, 1500);
      });
      card.querySelector('[data-act="sticky"]').addEventListener("click", async () => {
        const paperId = getActivePaperId();
        if (!paperId) return;
        await origFetch("/api/sticky/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paper_id: paperId,
            content: `> ${c.quote}\n\n用法：${c.note}`,
            color: "yellow",
          }),
        });
        const b = card.querySelector('[data-act="sticky"]');
        if (b) {
          b.textContent = "✓ 已加便签";
          setTimeout(() => (b.textContent = "入便签"), 1500);
        }
      });
      card.querySelector('[data-act="remove"]').addEventListener("click", () => {
        card.remove();
      });
      list.appendChild(card);
    });
    wrap.appendChild(list);
    host.appendChild(wrap);
  }

  // Intercept /api/excerpt response and render cards instead of raw text
  function installExcerptInterceptor() {
    const realFetch = window.fetch.bind(window);
    window.fetch = function (...args) {
      const url = args[0];
      const isExcerpt =
        typeof url === "string" && url.includes("/api/excerpt");
      if (!isExcerpt) return realFetch(...args);
      return realFetch(...args).then(async (resp) => {
        if (!resp.ok) return resp;
        const clone = resp.clone();
        try {
          const data = await clone.json();
          if (data && typeof data.answer === "string") {
            // Render after the existing app.js runs
            setTimeout(() => renderExcerptCards(data.answer), 60);
          }
        } catch (_) {}
        return resp;
      });
    };
  }

  // ============================================================
  // 3. Connection-status card at top of model settings
  // ============================================================

  function injectConnectionCard() {
    const section = document.getElementById("modelSettingsSection");
    if (!section) return;
    if (document.getElementById("connCard")) return;
    const card = document.createElement("div");
    card.id = "connCard";
    card.className = "conn-card";
    card.innerHTML = `
      <span class="conn-pulse">
        <svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 8a5 5 0 0110 0"/><circle cx="8" cy="8" r="1.5" fill="currentColor" stroke="none"/></svg>
      </span>
      <div class="conn-info">
        <span class="conn-status unknown"><span class="ds"></span> 待测试</span>
        <span class="conn-title" id="connTitle">主模型</span>
        <span class="conn-meta" id="connMeta">点右侧「重新测试」探活</span>
      </div>
      <button id="connTestBtn" class="conn-test" type="button">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M2 8a6 6 0 1110 4"/><path d="M12 9.5V13h-3.5"/></svg>
        测试连接
      </button>
    `;
    section.insertBefore(card, section.firstChild);

    // Populate title from #modelLabel
    function updateTitleFromLabel() {
      const ml = document.getElementById("modelLabel");
      const title = document.getElementById("connTitle");
      if (ml && title) title.textContent = ml.textContent || "主模型";
    }
    updateTitleFromLabel();
    const ml = document.getElementById("modelLabel");
    if (ml) {
      new MutationObserver(updateTitleFromLabel).observe(ml, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    document.getElementById("connTestBtn")?.addEventListener("click", testConnection);
  }

  async function testConnection() {
    const status = document.querySelector("#connCard .conn-status");
    const meta = document.getElementById("connMeta");
    const btn = document.getElementById("connTestBtn");
    if (status) {
      status.className = "conn-status unknown";
      status.innerHTML = '<span class="ds"></span> 测试中…';
    }
    if (btn) btn.disabled = true;
    try {
      // Use the existing /api/config endpoint as a cheap reachability check
      const t0 = Date.now();
      const resp = await origFetch("/api/config");
      const ms = Date.now() - t0;
      if (resp.ok) {
        if (status) {
          status.className = "conn-status";
          status.innerHTML = '<span class="ds"></span> 后端可达';
        }
        if (meta) meta.textContent = `延迟 ${ms} ms · 后端响应正常`;
      } else {
        if (status) {
          status.className = "conn-status error";
          status.innerHTML = `<span class="ds"></span> HTTP ${resp.status}`;
        }
        if (meta) meta.textContent = `后端返回错误码 ${resp.status}`;
      }
    } catch (err) {
      if (status) {
        status.className = "conn-status error";
        status.innerHTML = '<span class="ds"></span> 连接失败';
      }
      if (meta) meta.textContent = String(err.message || err);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    installCategoryModalV2();
    installExcerptInterceptor();
    injectConnectionCard();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
