/* ============================================================================
 * Author co-occurrence graph for a selected category.
 *
 * Why: when you've tagged 50 papers as "开放科学政策" you want to know who the
 * central researchers in that subfield are, who collaborates with whom, where
 * the gaps are. A coauthor graph surfaces this in 1 screen.
 *
 * Adds:
 *   • A "作者共现图" button in the categorization panel (and a fallback in
 *     the 分类弹窗's per-category section)
 *   • A modal with a force-directed SVG layout (vanilla, no D3)
 *   • Sliders for: min_papers (filter noise), edge-weight threshold (clutter)
 *   • Exports: PNG (rasterize the SVG) / CSV (edge list) / GraphML (Gephi)
 *
 * Backend: /api/coauth-graph?category=X&level=Y&min_papers=N
 * ========================================================================== */

(() => {
  const log = (...args) => console.log("[coauth]", ...args);

  // ============================================================
  // 1. Styles
  // ============================================================
  const css = `
    .dc-coauth-modal {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 1000;
      display: none;
      align-items: center; justify-content: center;
    }
    .dc-coauth-modal.visible { display: flex; }
    .dc-coauth-card {
      background: var(--dc-bg-panel, #fff);
      color: var(--dc-text, #2b2620);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 12px;
      width: min(94vw, 1100px);
      height: min(90vh, 760px);
      box-shadow: 0 20px 60px -10px rgba(0,0,0,0.4);
      display: flex; flex-direction: column;
      overflow: hidden;
    }
    .dc-coauth-head {
      padding: 14px 20px;
      border-bottom: 1px solid var(--dc-line, #d9d6cf);
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
      background: var(--dc-panel, #f8f5ee);
    }
    .dc-coauth-head h3 {
      margin: 0; font-size: 14px; font-weight: 600;
    }
    .dc-coauth-head .dc-coauth-controls {
      display: flex; gap: 10px; align-items: center;
      font-size: 12px;
    }
    .dc-coauth-head label {
      display: flex; align-items: center; gap: 4px;
      color: var(--dc-text-soft, #6b6660);
    }
    .dc-coauth-head input[type="number"] {
      width: 50px;
      padding: 2px 6px;
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 4px;
      background: var(--dc-bg-soft, #f5f1e8);
      color: var(--dc-text, #2b2620);
      font-size: 12px;
    }
    .dc-coauth-head select {
      padding: 2px 8px;
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 4px;
      background: var(--dc-bg-soft, #f5f1e8);
      color: var(--dc-text, #2b2620);
      font-size: 12px;
    }
    .dc-coauth-head button {
      padding: 4px 10px;
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 4px;
      background: var(--dc-bg-soft, #f5f1e8);
      color: var(--dc-text, #2b2620);
      cursor: pointer;
      font-size: 12px;
    }
    .dc-coauth-head button:hover { background: var(--dc-bg-strong, #ede6d6); }
    .dc-coauth-head button.primary {
      background: var(--dc-accent, #c8553d);
      color: #fff;
      border-color: var(--dc-accent, #c8553d);
    }
    .dc-coauth-body {
      flex: 1;
      display: grid;
      grid-template-columns: 1fr 240px;
      min-height: 0;
      overflow: hidden;
    }
    .dc-coauth-svg-wrap {
      position: relative;
      background: var(--dc-bg, #faf7f1);
      overflow: hidden;
    }
    .dc-coauth-svg { width: 100%; height: 100%; cursor: grab; }
    .dc-coauth-svg:active { cursor: grabbing; }
    .dc-coauth-svg .edge {
      stroke: var(--dc-muted, #6b6660);
      stroke-opacity: 0.35;
      fill: none;
    }
    .dc-coauth-svg .node circle {
      stroke: var(--dc-text-strong, #1f1a14);
      stroke-width: 1.2;
      transition: filter 0.15s;
      cursor: pointer;
    }
    .dc-coauth-svg .node:hover circle {
      filter: brightness(1.15);
      stroke-width: 2;
    }
    .dc-coauth-svg .node text {
      font-family: ui-sans-serif, -apple-system, "PingFang SC", sans-serif;
      font-size: 10px;
      fill: var(--dc-text, #2b2620);
      pointer-events: none;
      text-anchor: middle;
    }
    .dc-coauth-svg .label-bg {
      fill: var(--dc-bg-panel, #fff);
      fill-opacity: 0.85;
    }
    .dc-coauth-side {
      border-left: 1px solid var(--dc-line, #d9d6cf);
      background: var(--dc-panel, #f8f5ee);
      padding: 14px 14px 14px 16px;
      overflow-y: auto;
      font-size: 12px;
    }
    .dc-coauth-side h4 {
      margin: 0 0 8px 0;
      font-size: 12px;
      font-weight: 600;
      color: var(--dc-text-strong, #1f1a14);
    }
    .dc-coauth-side .stat-row {
      display: flex; justify-content: space-between;
      padding: 3px 0;
      color: var(--dc-text-soft, #6b6660);
    }
    .dc-coauth-side .stat-row strong {
      color: var(--dc-text-strong, #1f1a14);
      font-weight: 600;
    }
    .dc-coauth-side .top-author {
      display: flex; justify-content: space-between;
      padding: 4px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11.5px;
    }
    .dc-coauth-side .top-author:hover { background: var(--dc-bg-strong, #ede6d6); }
    .dc-coauth-side .top-author .name { font-weight: 500; }
    .dc-coauth-side .top-author .count {
      color: var(--dc-muted, #6b6660);
      font-variant-numeric: tabular-nums;
    }
    .dc-coauth-side .selected-author {
      background: var(--dc-bg-soft, #f5f1e8);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 6px;
      padding: 8px 10px;
      margin-top: 12px;
      font-size: 11.5px;
    }
    .dc-coauth-empty {
      display: flex; align-items: center; justify-content: center;
      height: 100%;
      color: var(--dc-muted, #6b6660);
      font-size: 13px;
      text-align: center;
      padding: 40px;
    }
    .dc-coauth-loading {
      display: flex; align-items: center; justify-content: center;
      height: 100%;
      color: var(--dc-muted, #6b6660);
      font-size: 13px;
    }
    .dc-coauth-loading .spinner {
      width: 16px; height: 16px;
      border: 2px solid var(--dc-line, #d9d6cf);
      border-top-color: var(--dc-accent, #c8553d);
      border-radius: 50%;
      animation: dc-spin 0.8s linear infinite;
      margin-right: 10px;
    }
    @keyframes dc-spin { to { transform: rotate(360deg); } }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "dc-coauth-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ============================================================
  // 2. State + DOM
  // ============================================================
  const state = {
    data: null,
    nodes: [],
    edges: [],
    minWeight: 1,
    minPapers: 1,
    level: "all",
    category: "",
    selectedAuthor: null,
    sim: null,
    labelMode: "important",  // important | all | none
  };
  let modal = null;

  function buildModal() {
    if (modal && modal.isConnected) return modal;
    modal = document.createElement("div");
    modal.className = "dc-coauth-modal";
    modal.innerHTML = `
      <div class="dc-coauth-card">
        <div class="dc-coauth-head">
          <h3 id="dcCoauthTitle">作者共现图</h3>
          <div class="dc-coauth-controls">
            <label>最少 <input id="dcCoauthMinPapers" type="number" min="1" max="20" value="1" /> 篇</label>
            <label>边阈值 <input id="dcCoauthMinWeight" type="number" min="1" max="10" value="1" /></label>
            <label>层级
              <select id="dcCoauthLevel">
                <option value="all">全部</option>
                <option value="primary">一级</option>
                <option value="secondary">二级</option>
                <option value="tertiary">三级</option>
              </select>
            </label>
            <label>人名
              <select id="dcCoauthLabelMode">
                <option value="important">仅重要节点</option>
                <option value="all">全部显示</option>
                <option value="none">全部隐藏</option>
              </select>
            </label>
            <button id="dcCoauthRefresh">刷新</button>
            <button id="dcCoauthExportPng">导出 PNG</button>
            <button id="dcCoauthExportCsv">导出 CSV</button>
            <button id="dcCoauthExportGraphml">导出 GraphML</button>
            <button id="dcCoauthClose" class="primary">关闭</button>
          </div>
        </div>
        <div class="dc-coauth-body">
          <div class="dc-coauth-svg-wrap">
            <svg class="dc-coauth-svg" id="dcCoauthSvg"></svg>
            <div id="dcCoauthLoading" class="dc-coauth-loading" style="position:absolute;inset:0;background:var(--dc-bg,#faf7f1);"></div>
          </div>
          <div class="dc-coauth-side" id="dcCoauthSide">
            <h4>统计</h4>
            <div id="dcCoauthStats"></div>
            <h4 style="margin-top:14px">中心度 Top 12</h4>
            <div id="dcCoauthTop"></div>
            <div id="dcCoauthSelected" style="display:none"></div>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("dcCoauthClose").addEventListener("click", hide);
    modal.addEventListener("click", (e) => { if (e.target === modal) hide(); });
    document.getElementById("dcCoauthRefresh").addEventListener("click", () => loadGraph());
    document.getElementById("dcCoauthMinPapers").addEventListener("change", (e) => {
      state.minPapers = Math.max(1, parseInt(e.target.value || "1", 10));
      loadGraph();
    });
    document.getElementById("dcCoauthMinWeight").addEventListener("change", (e) => {
      state.minWeight = Math.max(1, parseInt(e.target.value || "1", 10));
      render();
    });
    document.getElementById("dcCoauthLevel").addEventListener("change", (e) => {
      state.level = e.target.value;
      loadGraph();
    });
    document.getElementById("dcCoauthLabelMode").addEventListener("change", (e) => {
      state.labelMode = e.target.value;
      render();  // re-render only — no need to re-fetch
    });
    document.getElementById("dcCoauthExportPng").addEventListener("click", exportPng);
    document.getElementById("dcCoauthExportCsv").addEventListener("click", exportCsv);
    document.getElementById("dcCoauthExportGraphml").addEventListener("click", exportGraphml);
    return modal;
  }

  function show(category) {
    buildModal();
    state.category = category || "";
    state.selectedAuthor = null;
    document.getElementById("dcCoauthTitle").textContent =
      "作者共现图 · " + (category || "(全部文献)");
    modal.classList.add("visible");
    loadGraph();
  }

  function hide() {
    if (modal) modal.classList.remove("visible");
    if (state.sim) { state.sim.stop(); state.sim = null; }
  }

  // ============================================================
  // 3. Load + render
  // ============================================================
  async function loadGraph() {
    const loading = document.getElementById("dcCoauthLoading");
    loading.innerHTML = '<span class="spinner"></span>正在统计…';
    loading.style.display = "flex";
    try {
      const params = new URLSearchParams({
        category: state.category,
        level: state.level,
        min_papers: String(state.minPapers),
      });
      const r = await fetch(`/api/coauth-graph?${params}`);
      const data = await r.json();
      if (!r.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      state.data = data;
      state.nodes = data.nodes;
      state.edges = data.edges;
      renderStats();
      render();
    } catch (e) {
      loading.innerHTML = `<span style="color:#c0392b">加载失败：${escapeHtml(e.message)}</span>`;
      console.error("[coauth] failed", e);
      return;
    }
    loading.style.display = "none";
  }

  function renderStats() {
    const d = state.data || {};
    const s = d.stats || {};
    const el = document.getElementById("dcCoauthStats");
    el.innerHTML = `
      <div class="stat-row"><span>分类</span><strong>${escapeHtml(d.category || "")}</strong></div>
      <div class="stat-row"><span>文献数</span><strong>${d.paper_count || 0}</strong></div>
      <div class="stat-row"><span>作者数</span><strong>${s.total_authors || 0}<span style="color:var(--dc-muted)">/ ${s.total_authors_unfiltered || 0}</span></strong></div>
      <div class="stat-row"><span>合作边数</span><strong>${s.total_edges || 0}</strong></div>
      <div class="stat-row"><span>最高度数</span><strong>${s.max_degree || 0}</strong></div>
    `;
    // Top authors
    const topEl = document.getElementById("dcCoauthTop");
    const sorted = [...state.nodes].sort((a, b) => (b.degree - a.degree) || (b.paper_count - a.paper_count)).slice(0, 12);
    topEl.innerHTML = sorted.map((n) => `
      <div class="top-author" data-author="${escapeHtml(n.id)}">
        <span class="name">${escapeHtml(n.id)}</span>
        <span class="count">${n.paper_count}篇 · ${n.degree}合作</span>
      </div>
    `).join("");
    topEl.querySelectorAll(".top-author").forEach((el) => {
      el.addEventListener("click", () => selectAuthor(el.dataset.author));
    });
  }

  function selectAuthor(authorId) {
    state.selectedAuthor = authorId;
    const node = state.nodes.find((n) => n.id === authorId);
    const sel = document.getElementById("dcCoauthSelected");
    if (!node) { sel.style.display = "none"; return; }
    const collaborators = state.edges
      .filter((e) => e.source === authorId || e.target === authorId)
      .map((e) => ({ name: e.source === authorId ? e.target : e.source, w: e.weight }))
      .sort((a, b) => b.w - a.w)
      .slice(0, 10);
    sel.style.display = "block";
    sel.className = "selected-author";
    sel.innerHTML = `
      <div style="font-weight:600;color:var(--dc-text-strong);margin-bottom:4px">${escapeHtml(authorId)}</div>
      <div style="color:var(--dc-muted);font-size:11px;margin-bottom:6px">
        ${node.paper_count} 篇 · ${node.degree} 合作度
      </div>
      <div style="font-size:11px;color:var(--dc-text-soft);margin-bottom:4px">主要合作者：</div>
      ${collaborators.length ? collaborators.map((c) => `
        <div style="display:flex;justify-content:space-between;padding:2px 0;font-size:11px">
          <span>${escapeHtml(c.name)}</span>
          <span style="color:var(--dc-muted)">${c.w}</span>
        </div>
      `).join("") : `<div style="font-size:11px;color:var(--dc-muted)">无合作者</div>`}
    `;
    render();  // re-render to highlight
  }

  // ============================================================
  // 4. Force-directed SVG layout (vanilla, no d3)
  // ============================================================
  function render() {
    const svg = document.getElementById("dcCoauthSvg");
    const rect = svg.getBoundingClientRect();
    const w = rect.width || 800;
    const h = rect.height || 600;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

    // Filter by minWeight
    const edges = state.edges.filter((e) => e.weight >= state.minWeight);
    // Only keep nodes that appear in at least one kept edge OR have isolated paper_count>=2
    const connectedIds = new Set();
    edges.forEach((e) => { connectedIds.add(e.source); connectedIds.add(e.target); });
    const nodes = state.nodes
      .map((n) => ({ ...n }))
      .filter((n) => connectedIds.has(n.id) || (n.paper_count >= 2 && state.nodes.length < 50));

    // Initialize positions in a circle
    nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, nodes.length)) * 2 * Math.PI;
      const radius = Math.min(w, h) * 0.32;
      n.x = w / 2 + Math.cos(angle) * radius;
      n.y = h / 2 + Math.sin(angle) * radius;
      n.vx = 0; n.vy = 0;
    });

    // Build adjacency for force calc
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const edgePairs = edges.map((e) => ({
      a: nodeMap.get(e.source),
      b: nodeMap.get(e.target),
      w: e.weight,
    })).filter((e) => e.a && e.b);

    // Force-directed sim params
    const ITER = 240;
    const KS = 0.04;     // spring strength
    const KR = 1800;     // repulsion strength
    const DAMP = 0.85;
    const TARGET_LEN = 90;
    const CENTER_PULL = 0.005;

    function stepOnce() {
      // Repulsion (n^2 but n is small)
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = a.x - b.x, dy = a.y - b.y;
          let dist2 = dx * dx + dy * dy + 0.01;
          let dist = Math.sqrt(dist2);
          let force = KR / dist2;
          let fx = (dx / dist) * force;
          let fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
      // Spring (attraction along edges)
      edgePairs.forEach((e) => {
        let dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        let dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
        let force = (dist - TARGET_LEN) * KS * Math.log2(e.w + 1);
        let fx = (dx / dist) * force;
        let fy = (dy / dist) * force;
        e.a.vx += fx; e.a.vy += fy;
        e.b.vx -= fx; e.b.vy -= fy;
      });
      // Center pull
      nodes.forEach((n) => {
        n.vx += (w / 2 - n.x) * CENTER_PULL;
        n.vy += (h / 2 - n.y) * CENTER_PULL;
      });
      // Apply + damp
      nodes.forEach((n) => {
        n.x += n.vx; n.y += n.vy;
        n.vx *= DAMP; n.vy *= DAMP;
        // Clamp to viewport
        n.x = Math.max(40, Math.min(w - 40, n.x));
        n.y = Math.max(40, Math.min(h - 40, n.y));
      });
    }
    for (let i = 0; i < ITER; i++) stepOnce();

    // Draw
    const maxPaperCount = state.data.stats.max_paper_count || 1;
    const maxWeight = Math.max(...edgePairs.map((e) => e.w), 1);

    let html = "";
    // Edges first (under nodes)
    edgePairs.forEach((e) => {
      const opacity = 0.18 + 0.5 * (e.w / maxWeight);
      const sw = 0.7 + 1.6 * (e.w / maxWeight);
      const isSel = state.selectedAuthor && (e.a.id === state.selectedAuthor || e.b.id === state.selectedAuthor);
      const stroke = isSel ? "var(--dc-accent, #c8553d)" : "var(--dc-muted, #6b6660)";
      html += `<line class="edge" x1="${e.a.x.toFixed(1)}" y1="${e.a.y.toFixed(1)}" x2="${e.b.x.toFixed(1)}" y2="${e.b.y.toFixed(1)}" stroke="${stroke}" stroke-opacity="${opacity.toFixed(2)}" stroke-width="${sw.toFixed(1)}"/>`;
    });
    // Label threshold for "仅重要节点" mode: a node is "important" if it has
    // 2+ papers OR is in the top tier by paper count.
    const labelThreshold = Math.max(2, maxPaperCount * 0.4);

    // Nodes
    nodes.forEach((n) => {
      const r = 4 + 14 * Math.sqrt(n.paper_count / maxPaperCount);
      const isSel = state.selectedAuthor === n.id;
      const fill = isSel ? "var(--dc-accent, #c8553d)" : colorForDegree(n.degree, state.data.stats.max_degree);
      html += `<g class="node" data-author="${escapeAttr(n.id)}">`;
      // Native SVG tooltip — hover ANY node (labelled or not) to see who it is.
      html += `<title>${escapeHtml(n.id)} · ${n.paper_count} 篇 · ${n.degree} 合作度</title>`;
      html += `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${fill}"/>`;
      // Label visibility honors the 人名 dropdown:
      //   all       → every node labelled
      //   none      → no labels (except the one you clicked)
      //   important → only nodes with enough papers (default; avoids clutter
      //               when a category has 100+ authors)
      let showLabel;
      if (state.labelMode === "all") {
        showLabel = true;
      } else if (state.labelMode === "none") {
        showLabel = isSel;
      } else {
        showLabel = isSel || n.paper_count >= labelThreshold;
      }
      if (showLabel) {
        const ty = n.y + r + 11;
        // Smaller font when showing ALL labels so a dense graph stays legible
        const fs = state.labelMode === "all" ? 8.5 : 10;
        html += `<text x="${n.x.toFixed(1)}" y="${ty.toFixed(1)}" font-size="${fs}">${escapeHtml(n.id)}</text>`;
      }
      html += `</g>`;
    });

    svg.innerHTML = html;

    // Wire node clicks
    svg.querySelectorAll(".node").forEach((g) => {
      g.addEventListener("click", () => selectAuthor(g.dataset.author));
    });

    // If no nodes, show empty state
    if (nodes.length === 0) {
      svg.innerHTML = '';
      const overlay = document.createElement("div");
      overlay.className = "dc-coauth-empty";
      overlay.style.cssText = "position:absolute;inset:0";
      overlay.textContent = state.data.paper_count === 0
        ? "这个分类下没有文献。"
        : "提高「最少 N 篇」或降低「边阈值」可显示更多作者。";
      svg.parentElement.appendChild(overlay);
      setTimeout(() => overlay.remove(), 4000);
    }
  }

  function colorForDegree(d, maxD) {
    const t = maxD ? d / maxD : 0;
    // Warm orange→red gradient
    const r = Math.round(232 + (200 - 232) * (1 - t));
    const g = Math.round(165 + (60 - 165) * t);
    const b = Math.round(120 + (60 - 120) * t);
    return `rgb(${r},${g},${b})`;
  }

  // ============================================================
  // 5. Exports
  // ============================================================
  function exportPng() {
    const svg = document.getElementById("dcCoauthSvg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const W = rect.width * 2, H = rect.height * 2;
    const xml = new XMLSerializer().serializeToString(svg);
    const blob = new Blob(['<?xml version="1.0"?>' + xml], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--dc-bg") || "#faf7f1";
      ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, 0, 0, W, H);
      canvas.toBlob((b) => {
        downloadBlob(b, `coauth-${safeFilename(state.category || "all")}-${Date.now()}.png`);
        URL.revokeObjectURL(url);
      }, "image/png");
    };
    img.src = url;
  }

  function exportCsv() {
    const rows = [["source", "target", "weight"]];
    state.edges.forEach((e) => rows.push([e.source, e.target, e.weight]));
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")).join("\n");
    downloadBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }),
                 `coauth-${safeFilename(state.category || "all")}-${Date.now()}.csv`);
  }

  function exportGraphml() {
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&apos;"}[c]));
    let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<graphml xmlns="http://graphml.graphdrawing.org/xmlns">\n`;
    xml += `<key id="papers" for="node" attr.name="papers" attr.type="int"/>\n`;
    xml += `<key id="degree" for="node" attr.name="degree" attr.type="int"/>\n`;
    xml += `<key id="weight" for="edge" attr.name="weight" attr.type="int"/>\n`;
    xml += `<graph edgedefault="undirected">\n`;
    state.nodes.forEach((n) => {
      xml += `<node id="${esc(n.id)}"><data key="papers">${n.paper_count}</data><data key="degree">${n.degree}</data></node>\n`;
    });
    state.edges.forEach((e, i) => {
      xml += `<edge id="e${i}" source="${esc(e.source)}" target="${esc(e.target)}"><data key="weight">${e.weight}</data></edge>\n`;
    });
    xml += `</graph>\n</graphml>\n`;
    downloadBlob(new Blob([xml], { type: "application/xml" }),
                 `coauth-${safeFilename(state.category || "all")}-${Date.now()}.graphml`);
  }

  function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }

  function safeFilename(s) {
    return String(s).replace(/[\\/:*?"<>|]/g, "_").substring(0, 40);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));
  }
  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/["&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
  }

  // ============================================================
  // 6. Public API + entry-point button
  // ============================================================
  // Anyone can call window.dcCoauth.show("category-name") to open the modal.
  window.dcCoauth = { show, hide };

  // Auto-inject an entry-point button into the categorization panel + side
  // category picker. The button asks for category context and opens modal.
  function injectEntryButton() {
    // Add a global button in the top-right tools area
    const tools = document.querySelector(".topbar-right") ||
                  document.querySelector(".topbar") ||
                  document.querySelector("header");
    if (tools && !document.getElementById("dcCoauthBtn")) {
      const btn = document.createElement("button");
      btn.id = "dcCoauthBtn";
      btn.type = "button";
      btn.title = "为当前选中分类绘制作者共现图";
      btn.style.cssText =
        "padding:5px 10px;border-radius:6px;border:1px solid var(--dc-line,#d9d6cf);" +
        "background:var(--dc-bg-soft,#f5f1e8);color:var(--dc-text,#2b2620);" +
        "cursor:pointer;font-size:12px;margin-left:6px;";
      btn.textContent = "👥 作者图";
      btn.addEventListener("click", () => {
        // Try to grab the currently-filtered category
        const sel = document.getElementById("categorySelect");
        const cat = sel && sel.value && sel.value !== "__uncategorized" && sel.value !== "__only_ai"
          ? sel.value
          : "";
        show(cat);
      });
      tools.appendChild(btn);
    }
  }
  if (document.body) injectEntryButton();
  else document.addEventListener("DOMContentLoaded", injectEntryButton, { once: true });

  log("ready — call window.dcCoauth.show('category') or click 👥 作者图 in topbar");
})();
