/* ============================================================================
 * 帮我阅读 progress overlay + persistent error display.
 *
 * Why: previously the flow was "button → confirm() → silently disabled → alert()".
 * For Chinese-language PDFs that errored late (CLI not logged in, empty AI
 * response, etc.) the user saw nothing until an alert that auto-closed too
 * fast to read. 整理新文献 has its own overlay; 帮我阅读 had none.
 *
 * Strategy:
 *   • Patch window.fetch. When the call is POST /api/paper/help-read, show a
 *     fixed-position progress card. Move through stages on a soft timeline
 *     (AI calls take 30-120s; we can't truly poll a one-shot endpoint).
 *   • On 2xx: success state + auto-hide after 2.4s.
 *   • On any failure (HTTP non-2xx OR JSON has ok:false OR network error):
 *     keep the card visible with the full error text + 关闭 button.
 *   • Zero coupling to app.js's module-scoped state. We don't touch the
 *     button or the existing flow — app.js still refreshes the paper view.
 *
 * Loaded after app.js + app-design-*.js. Self-contained module.
 * ========================================================================== */

(() => {
  const log = (...args) => console.log("[helpread-overlay]", ...args);
  const HELP_READ_PATH = "/api/paper/help-read";

  // --------------------------------------------------------- Inject CSS
  const css = `
    .hr-overlay {
      position: fixed; bottom: 18px; left: 18px;
      width: 420px; max-width: calc(100vw - 36px);
      background: var(--dc-bg-panel, #fff);
      border: 1px solid var(--dc-border, #d9d6cf);
      border-radius: 12px;
      box-shadow: 0 10px 30px -10px rgba(20, 14, 8, 0.25), 0 4px 12px -4px rgba(20, 14, 8, 0.15);
      padding: 14px 16px;
      z-index: 200;
      display: flex; flex-direction: column; gap: 8px;
      font-size: 13px;
      color: var(--dc-text, #2b2620);
      font-family: var(--dc-font, inherit);
    }
    .hr-overlay.hidden { display: none; }
    .hr-overlay-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
    }
    .hr-overlay-title {
      font-weight: 600; font-size: 13px;
      display: flex; align-items: center; gap: 8px;
    }
    .hr-overlay-spinner {
      width: 12px; height: 12px;
      border: 2px solid var(--dc-border, #d9d6cf);
      border-top-color: var(--dc-accent, #c8553d);
      border-radius: 50%;
      animation: hr-spin 0.8s linear infinite;
    }
    .hr-overlay.is-error .hr-overlay-spinner { display: none; }
    .hr-overlay.is-success .hr-overlay-spinner {
      border: 2px solid #2e8b57;
      animation: none; position: relative;
    }
    .hr-overlay.is-success .hr-overlay-spinner::after {
      content: ""; position: absolute;
      left: 2px; top: 0px;
      width: 4px; height: 8px;
      border-right: 2px solid #2e8b57;
      border-bottom: 2px solid #2e8b57;
      transform: rotate(45deg);
    }
    @keyframes hr-spin { to { transform: rotate(360deg); } }
    .hr-overlay-close {
      background: transparent; border: none; cursor: pointer;
      font-size: 16px; line-height: 1; padding: 2px 6px;
      color: var(--dc-text-soft, #6b6660);
      border-radius: 4px;
    }
    .hr-overlay-close:hover { background: var(--dc-bg-soft, #f5f1e8); }
    .hr-overlay-meta {
      font-size: 11.5px; color: var(--dc-text-soft, #6b6660);
      word-break: break-all;
    }
    .hr-overlay-stage {
      display: flex; align-items: center; gap: 6px;
      font-size: 11.5px;
      flex-wrap: wrap;
    }
    .hr-overlay-stage-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--dc-border, #d9d6cf);
      transition: background 0.2s;
      display: inline-block;
    }
    .hr-overlay-stage-dot.active { background: var(--dc-accent, #c8553d); }
    .hr-overlay-stage-dot.done { background: #2e8b57; }
    .hr-overlay-track {
      height: 6px;
      background: var(--dc-bg-soft, #f5f1e8);
      border-radius: 999px; overflow: hidden;
    }
    .hr-overlay-fill {
      height: 100%; width: 0%;
      background: var(--dc-accent, #c8553d);
      transition: width 0.4s ease;
    }
    .hr-overlay.is-error .hr-overlay-fill { background: #c0392b; width: 100% !important; }
    .hr-overlay.is-success .hr-overlay-fill { background: #2e8b57; width: 100% !important; }
    .hr-overlay-msg {
      font-size: 12px;
      line-height: 1.55;
      max-height: 260px;
      overflow-y: auto;
      padding: 6px 8px;
      background: var(--dc-bg-soft, #f5f1e8);
      border-radius: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: ui-monospace, "SF Mono", Consolas, monospace;
    }
    .hr-overlay.is-error .hr-overlay-msg {
      background: #fcebe8;
      color: #8b2f24;
      border: 1px solid #e8c5be;
    }
    .hr-overlay-elapsed {
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      color: var(--dc-text-soft, #6b6660);
    }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "hr-overlay-css";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // --------------------------------------------------------- Build DOM
  // We don't advance past "AI 阅读中" on a timer — AI calls can take
  // anywhere from 20s (deepseek-chat) to 400s+ (deepseek-v4-pro reasoning,
  // long PDFs). The save/reload stages get marked done AFTER the fetch
  // resolves, in setStageOnResolve().
  const STAGES = [
    { key: "prep",   label: "准备",       pct: 8,   delayBefore: 0 },
    { key: "ai",     label: "AI 阅读中",   pct: 70,  delayBefore: 1200 },
    { key: "save",   label: "写入索引",    pct: 92,  delayBefore: null },  // event-driven
    { key: "reload", label: "刷新视图",    pct: 98,  delayBefore: null },  // event-driven
  ];

  function buildOverlay() {
    const wrap = document.createElement("div");
    wrap.className = "hr-overlay hidden";
    wrap.id = "hrOverlay";
    const stageHTML = STAGES.map((s, i) => {
      const sep = i < STAGES.length - 1 ? "<span style='opacity:.4;margin:0 2px'>›</span>" : "";
      return `<span class="hr-overlay-stage-dot" data-stage="${s.key}"></span><span data-stage-label="${s.key}" style="color:var(--dc-text-soft,#6b6660)">${s.label}</span>${sep}`;
    }).join("");
    wrap.innerHTML = `
      <div class="hr-overlay-head">
        <div class="hr-overlay-title">
          <div class="hr-overlay-spinner"></div>
          <span id="hrOverlayTitle">帮我阅读</span>
        </div>
        <button class="hr-overlay-close" id="hrOverlayClose" type="button" title="关闭">×</button>
      </div>
      <div class="hr-overlay-meta" id="hrOverlayMeta"></div>
      <div class="hr-overlay-stage">${stageHTML}<span class="hr-overlay-elapsed" id="hrOverlayElapsed" style="margin-left:auto"></span></div>
      <div class="hr-overlay-track"><div class="hr-overlay-fill" id="hrOverlayFill"></div></div>
      <div class="hr-overlay-msg" id="hrOverlayMsg" style="display:none"></div>
    `;
    document.body.appendChild(wrap);
    wrap.querySelector("#hrOverlayClose").addEventListener("click", () => hide());
    return wrap;
  }

  let overlay = null;
  function getOverlay() {
    if (!overlay) overlay = buildOverlay();
    return overlay;
  }

  let stageTimers = [];
  let elapsedTimer = null;
  let startedAt = 0;

  function clearTimers() {
    stageTimers.forEach((t) => clearTimeout(t));
    stageTimers = [];
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  function setStage(key) {
    const ov = getOverlay();
    const idx = STAGES.findIndex((s) => s.key === key);
    if (idx < 0) return;
    const dots = ov.querySelectorAll(".hr-overlay-stage-dot");
    dots.forEach((dot, i) => {
      dot.classList.toggle("done", i < idx);
      dot.classList.toggle("active", i === idx);
    });
    ov.querySelector("#hrOverlayFill").style.width = STAGES[idx].pct + "%";
  }

  function startStaging() {
    clearTimers();
    setStage("prep");
    STAGES.forEach((s) => {
      if (s.key === "prep") return;
      if (s.delayBefore == null) return;  // event-driven stage, skip timer
      stageTimers.push(setTimeout(() => setStage(s.key), s.delayBefore));
    });
  }

  function startElapsed() {
    startedAt = performance.now();
    const el = getOverlay().querySelector("#hrOverlayElapsed");
    const tick = () => {
      const s = ((performance.now() - startedAt) / 1000).toFixed(1);
      el.textContent = s + "s";
    };
    tick();
    elapsedTimer = setInterval(tick, 200);
  }

  function show(titleHint) {
    const ov = getOverlay();
    ov.classList.remove("hidden", "is-error", "is-success");
    ov.querySelector("#hrOverlayTitle").textContent = "帮我阅读 · AI 正在工作";
    ov.querySelector("#hrOverlayMeta").textContent = titleHint || "正在重新阅读这篇文献，刷新元数据 / 笔记…";
    ov.querySelector("#hrOverlayMsg").style.display = "none";
    ov.querySelector("#hrOverlayFill").style.width = "0%";
    ov.querySelectorAll(".hr-overlay-stage-dot").forEach((d) => {
      d.classList.remove("done", "active");
    });
    startElapsed();
    startStaging();
  }

  function hide() {
    clearTimers();
    getOverlay().classList.add("hidden");
  }

  function showError(message) {
    clearTimers();
    const ov = getOverlay();
    ov.classList.remove("is-success");
    ov.classList.add("is-error");
    ov.querySelector("#hrOverlayTitle").textContent = "帮我阅读失败 — 查看下方错误";
    ov.querySelector("#hrOverlayMeta").textContent = "点 × 关闭。错误信息保持显示，方便复制排查。";
    const msgEl = ov.querySelector("#hrOverlayMsg");
    msgEl.textContent = message || "(无具体错误信息)";
    msgEl.style.display = "block";
  }

  function showSuccess() {
    clearTimers();
    const ov = getOverlay();
    ov.classList.remove("is-error");
    ov.classList.add("is-success");
    ov.querySelector("#hrOverlayTitle").textContent = "帮我阅读完成 ✓";
    ov.querySelectorAll(".hr-overlay-stage-dot").forEach((d) => {
      d.classList.remove("active"); d.classList.add("done");
    });
    const elapsedNow = ((performance.now() - startedAt) / 1000).toFixed(1);
    ov.querySelector("#hrOverlayMeta").textContent = `耗时 ${elapsedNow}s · 已刷新索引和笔记`;
    setTimeout(() => {
      if (ov.classList.contains("is-success")) hide();
    }, 2400);
  }

  // expose for debugging / other patches
  window.hrOverlay = { show, hide, showError, showSuccess, setStage };

  // --------------------------------------------------------- Fetch hook
  const originalFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const method = (init && init.method) || (input && input.method) || "GET";
    const isHelpRead = method.toUpperCase() === "POST" && url.indexOf(HELP_READ_PATH) !== -1;
    if (!isHelpRead) return originalFetch(input, init);
    // During a batch read (app-phase3.js runBulkRead), the bulk progress modal
    // already shows per-paper progress — don't also flash this single-paper
    // overlay for every iteration.
    if (window.__bulkReadRunning) return originalFetch(input, init);

    // Try to read paper title from the request body for the meta line
    let titleHint = "";
    try {
      if (init && typeof init.body === "string") {
        const parsed = JSON.parse(init.body);
        if (parsed && parsed.paper_id) {
          titleHint = "paper_id: " + String(parsed.paper_id);
        }
      }
    } catch {}
    show(titleHint);

    try {
      const resp = await originalFetch(input, init);
      // Clone so app.js's caller can still read the body
      const cloned = resp.clone();
      let data = null;
      try { data = await cloned.json(); } catch {}
      if (!resp.ok || (data && data.ok === false)) {
        const errMsg = (data && data.error)
          ? data.error
          : `HTTP ${resp.status}${resp.statusText ? " " + resp.statusText : ""}`;
        showError(errMsg);
      } else {
        // The AI call returned successfully — advance through the event-driven
        // tail stages (save → reload) quickly. app.js's caller will then make
        // two more fetches (/api/paper, /api/note) and refresh the UI.
        setStage("save");
        setTimeout(() => setStage("reload"), 250);
        setTimeout(() => showSuccess(), 700);
      }
      return resp;
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      // Surface timeout errors in a friendlier way (the underlying message
      // comes from Python's requests lib via the server, e.g. "Read timed
      // out. (read timeout=120)"). The actual hint is at the server.
      showError(msg + "\n\n（网络或 fetch 抛出异常，请检查后端是否在运行。）");
      throw err;
    }
  };

  log("ready — fetch hook installed for " + HELP_READ_PATH);
})();
