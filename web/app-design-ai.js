/* ============================================================
 * 文献工作台 — Design patch: AI panel
 *
 * Replaces the visual shell of #aiPanel to match the new design:
 *
 *   [conv-strip from phase2]                              <- kept
 *   [context-chip-row: 📄 papers chip · 📌 citation chip · ✕ ····· ≡ 多轮]
 *   [chatHistory restyled]                                <- kept
 *   [quick-prompt-row: 4 chips]
 *   [attach-row: 全文上下文 / 页面图·p.X ✕]
 *   [textarea (#questionInput)]                            <- kept
 *   [compose-bar: 加图 / 多轮 / 清空 ········ ⌘Enter / 发送]
 *
 * This patch HIDES the old controls (work-context select, image-ask-row,
 * #askBtn, #aiAnswer, append-to-note accordion, plain chat-toolbar) and
 * DELEGATES new control clicks to those hidden elements. Phase 2 still
 * owns the conversation storage + chat rendering — we only style what it
 * produces.
 *
 * Safe to remove: delete this file + the <script> tag in index.html;
 * the original UI returns.
 * ============================================================ */

(function () {
  "use strict";

  // ============================================================
  // 1. Inject scoped styles
  // ============================================================
  function injectStyles() {
    if (document.getElementById("dc-ai-style")) return;
    const s = document.createElement("style");
    s.id = "dc-ai-style";
    s.textContent = `
      /* Hide old shell elements that the patch supersedes */
      #aiPanel .ai-context-row { display: none !important; }
      #aiPanel > .chat-toolbar { display: none !important; }
      #aiPanel > .image-ask-row { display: none !important; }
      #aiPanel > #askBtn { display: none !important; }
      #aiPanel > #aiStatus { display: none !important; }
      #aiPanel > #aiAnswer { display: none !important; }
      #aiPanel > details.append-to-note { display: none !important; }

      /* Panel layout: stack with header(chips) → history → footer */
      #aiPanel {
        gap: 10px;
      }

      /* Conv strip (phase2) — restyle minimally */
      #aiPanel #aiConvStrip {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        padding-bottom: 2px;
        border-bottom: 1px solid var(--dc-line-soft);
      }

      /* ============ Context chip row ============ */
      .dc-ai-context {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 4px;
        flex-wrap: wrap;
      }
      .dc-ai-context-label {
        font-size: var(--dc-fs-xs);
        color: var(--dc-muted);
        flex-shrink: 0;
      }
      .dc-ai-context-spacer { flex: 1; }
      .dc-ai-context .dc-chip {
        cursor: pointer;
      }
      .dc-ai-context .dc-chip-paper {
        background: var(--dc-panel-soft);
        color: var(--dc-text);
        border-color: var(--dc-line);
      }
      .dc-ai-context .dc-chip-citation {
        background: var(--dc-accent-soft);
        color: var(--dc-accent-strong);
        border-color: var(--dc-accent-soft);
        font-weight: var(--dc-fw-medium);
      }
      .dc-ai-context .dc-chip-citation-empty {
        background: transparent;
        color: var(--dc-muted);
        border-style: dashed;
      }

      /* ============ Quick-prompt chip row ============ */
      .dc-ai-prompts {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        padding: 4px 0;
      }
      .dc-ai-prompts button {
        border: 1px solid var(--dc-line);
        background: var(--dc-panel-soft);
        color: var(--dc-muted);
        border-radius: var(--dc-r-pill);
        padding: 4px 12px;
        font-size: var(--dc-fs-xs);
        cursor: pointer;
        white-space: nowrap;
        transition: border-color 0.12s, color 0.12s, background 0.12s;
      }
      .dc-ai-prompts button:hover {
        border-color: var(--dc-accent);
        color: var(--dc-accent-strong);
        background: var(--dc-accent-tint);
      }
      .dc-ai-prompts .dc-ai-prompt-icon {
        margin-right: 3px;
        opacity: 0.65;
      }

      /* ============ Attach-chip row ============ */
      .dc-ai-attach {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        padding: 2px 0;
      }

      /* ============ Bottom textarea + compose bar ============ */
      .dc-ai-compose-shell {
        display: flex;
        flex-direction: column;
        gap: 6px;
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-card);
        background: var(--dc-surface);
        padding: 10px 12px;
        transition: border-color 0.12s, box-shadow 0.12s;
      }
      .dc-ai-compose-shell:focus-within {
        border-color: var(--dc-accent);
        box-shadow: 0 0 0 3px var(--dc-accent-soft);
      }
      .dc-ai-compose-shell #questionInput {
        border: none !important;
        background: transparent !important;
        padding: 0 !important;
        outline: none !important;
        font-family: var(--dc-font-sans) !important;
        font-size: var(--dc-fs-body) !important;
        line-height: 1.55;
        resize: none;
        min-height: 56px;
        box-shadow: none !important;
        color: var(--dc-text);
      }
      .dc-ai-compose-shell #questionInput::placeholder {
        color: var(--dc-muted-soft);
      }
      .dc-ai-compose-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .dc-ai-compose-bar .dc-ai-toolbtn {
        background: transparent;
        border: none;
        padding: 4px 8px;
        color: var(--dc-muted);
        font-size: var(--dc-fs-xs);
        cursor: pointer;
        border-radius: var(--dc-r-button);
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .dc-ai-compose-bar .dc-ai-toolbtn:hover {
        background: var(--dc-panel-soft);
        color: var(--dc-text);
      }
      .dc-ai-compose-bar .dc-ai-toolbtn.danger:hover {
        color: var(--dc-danger);
        background: var(--dc-danger-soft);
      }
      .dc-ai-compose-bar .dc-ai-toolbtn svg {
        width: 13px;
        height: 13px;
      }
      .dc-ai-compose-bar .dc-ai-toolspacer { flex: 1; }
      .dc-ai-compose-bar .dc-kbd-hint {
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted-soft);
        padding: 2px 6px;
        border: 1px solid var(--dc-line);
        border-radius: var(--dc-r-input);
        background: var(--dc-panel-soft);
        font-family: var(--dc-font-mono);
      }
      .dc-ai-send {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        background: var(--dc-accent);
        color: var(--dc-accent-ink);
        border: 1px solid var(--dc-accent);
        border-radius: var(--dc-r-button);
        padding: 6px 14px;
        font-size: var(--dc-fs-body);
        font-weight: var(--dc-fw-medium);
        cursor: pointer;
      }
      .dc-ai-send:hover {
        background: var(--dc-accent-strong);
        border-color: var(--dc-accent-strong);
      }
      .dc-ai-send:disabled { opacity: 0.5; cursor: not-allowed; }
      .dc-ai-send svg { width: 12px; height: 12px; }

      /* ============ Thinking bubble (while AI is responding) ============ */
      #dcAiThinking {
        display: none;
        margin: 4px 0 4px 0;
        padding: 8px 14px;
        background: var(--dc-panel-soft, #f5f1e8);
        border: 1px solid var(--dc-line, #d9d6cf);
        border-radius: 18px 18px 18px 4px;
        max-width: 70%;
        align-self: flex-start;
        font-size: var(--dc-fs-body, 13px);
        color: var(--dc-muted, #6b6660);
      }
      #dcAiThinking.is-active {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        animation: dc-thinking-fade-in 0.2s ease;
      }
      #dcAiThinking .dc-thinking-label {
        font-size: 11.5px;
        color: var(--dc-muted, #6b6660);
      }
      #dcAiThinking .dc-thinking-dots {
        display: inline-flex; gap: 4px;
      }
      #dcAiThinking .dc-thinking-dots span {
        width: 6px; height: 6px; border-radius: 50%;
        background: var(--dc-accent, #c8553d);
        opacity: 0.4;
        animation: dc-thinking-bounce 1.2s infinite ease-in-out;
      }
      #dcAiThinking .dc-thinking-dots span:nth-child(2) { animation-delay: 0.15s; }
      #dcAiThinking .dc-thinking-dots span:nth-child(3) { animation-delay: 0.3s; }
      #dcAiThinking .dc-thinking-elapsed {
        font-variant-numeric: tabular-nums;
        font-size: 11px;
        color: var(--dc-muted-soft, #a39d94);
        margin-left: 4px;
      }
      @keyframes dc-thinking-bounce {
        0%, 60%, 100% { opacity: 0.4; transform: translateY(0); }
        30% { opacity: 1; transform: translateY(-3px); }
      }
      @keyframes dc-thinking-fade-in {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      /* ============ Chat bubbles (phase2 renders, we restyle) ============ */
      #aiPanel .chat-msg-user {
        align-self: flex-end;
        background: var(--dc-accent-tint);
        border: 1px solid var(--dc-accent-soft);
        color: var(--dc-text);
        max-width: 78%;
        padding: 9px 13px;
        border-radius: 14px 14px 4px 14px;
      }
      #aiPanel .chat-msg-user .chat-msg-meta {
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted);
        margin-bottom: 3px;
        display: flex;
        gap: 6px;
        justify-content: flex-end;
      }
      #aiPanel .chat-msg-user .chat-role { color: var(--dc-accent-strong); font-weight: var(--dc-fw-medium); }

      #aiPanel .chat-msg-assistant {
        background: var(--dc-surface);
        border: 1px solid var(--dc-line);
        max-width: 100%;
        padding: 11px 14px;
        border-radius: 14px 14px 14px 4px;
        color: var(--dc-text);
      }
      #aiPanel .chat-msg-assistant .chat-msg-meta {
        display: flex;
        gap: 6px;
        font-size: var(--dc-fs-xxs);
        color: var(--dc-muted);
        margin-bottom: 6px;
        align-items: center;
      }
      #aiPanel .chat-msg-assistant .chat-role {
        background: var(--dc-text-strong);
        color: white;
        padding: 2px 7px;
        border-radius: var(--dc-r-pill);
        font-size: 9px;
        letter-spacing: 0.05em;
        font-weight: var(--dc-fw-bold);
      }
      #aiPanel .chat-msg-assistant .bubble-body {
        font-size: var(--dc-fs-body);
        line-height: 1.65;
        /* Allow drag-selecting + copying any portion of the answer. */
        -webkit-user-select: text;
        user-select: text;
        cursor: text;
      }
      #aiPanel .chat-msg .bubble-body,
      #aiPanel .chat-msg-user .bubble-body {
        -webkit-user-select: text;
        user-select: text;
      }
      #aiPanel .chat-msg-assistant .bubble-body code {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line-soft);
        padding: 1px 5px;
        border-radius: 3px;
        font-family: var(--dc-font-mono);
        font-size: 0.9em;
      }
      /* 动作按钮永久可见，hover 时高亮（之前是 opacity:0/1 hover-only，
         结果鼠标到按钮位置才看见，用户体验混乱，已改为常驻显示） */
      #aiPanel .chat-msg-assistant .bubble-actions {
        display: flex !important;
        gap: 4px;
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px dashed var(--dc-line-soft);
        opacity: 1 !important;
        flex-wrap: wrap;
      }
      #aiPanel .chat-msg-assistant .bubble-actions button {
        background: var(--dc-panel-soft);
        border: 1px solid var(--dc-line-soft);
        color: var(--dc-muted);
        font-size: var(--dc-fs-xs);
        padding: 3px 9px;
        border-radius: var(--dc-r-pill);
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      #aiPanel .chat-msg-assistant .bubble-actions button:hover {
        background: var(--dc-accent-tint);
        color: var(--dc-accent-strong);
        border-color: var(--dc-accent);
      }
      #aiPanel .chat-msg-assistant .bubble-actions button:disabled {
        opacity: 0.5;
        cursor: wait;
      }

      /* Page reference chip in AI answer */
      #aiPanel .page-ref-chip {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        margin: 0 1px;
        background: var(--dc-accent-soft);
        color: var(--dc-accent-strong);
        border-radius: 4px;
        font-size: 0.85em;
        font-weight: var(--dc-fw-medium);
        cursor: pointer;
        font-family: var(--dc-font-mono);
      }
      #aiPanel .page-ref-chip:hover {
        background: var(--dc-accent);
        color: var(--dc-accent-ink);
      }
    `;
    document.head.appendChild(s);
  }

  // ============================================================
  // 2. Mount design shell INTO #aiPanel
  // ============================================================
  function mount() {
    const panel = document.getElementById("aiPanel");
    if (!panel) return false;
    if (panel.dataset.dcMounted) return true;
    panel.dataset.dcMounted = "1";

    // ---- Context chip row ----
    const ctx = document.createElement("div");
    ctx.className = "dc-ai-context";
    ctx.id = "dcAiContext";
    ctx.innerHTML = `
      <span class="dc-ai-context-label">语境</span>
      <span class="dc-chip dc-chip-paper" id="dcAiCtxPaper" title="当前选中的文献">
        <svg class="dc-chip-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 1.5h5l2.5 2.5v6.5h-7.5z"/><path d="M7.5 1.5v2.5h2.5"/></svg>
        <span class="dc-chip-text">—</span>
      </span>
      <span class="dc-chip dc-chip-citation dc-chip-citation-empty dc-chip-removable" id="dcAiCtxCitation" title="点击切换工作语境（要写哪篇 manuscript）">
        <svg class="dc-chip-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 9h6"/><path d="M3 6h6"/><path d="M3 3l3 3l-3 3"/></svg>
        <span class="dc-chip-text">未选工作语境</span>
        <button class="dc-chip-remove" type="button" title="清除工作语境" style="display:none">×</button>
      </span>
      <span class="dc-ai-context-spacer"></span>
      <span class="dc-toggle-chip" id="dcAiMultiTurn" title="开启后每次发送会带上前面的对话">
        <svg class="dc-chip-icon" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1.5 3h9"/><path d="M1.5 6h9"/><path d="M1.5 9h9"/></svg>
        多轮
      </span>
    `;

    // Find anchor: place after #aiConvStrip if present, else as first child
    const conv = document.getElementById("aiConvStrip");
    if (conv && conv.nextSibling) panel.insertBefore(ctx, conv.nextSibling);
    else panel.insertBefore(ctx, panel.firstChild);

    // ---- Quick-prompt row + Compose shell will go AFTER chatHistory ----
    // (attach row removed per user feedback; image attach lives only via 加图 button if needed)
    const chatHistory = document.getElementById("chatHistory");
    if (!chatHistory) return false;

    const promptsRow = document.createElement("div");
    promptsRow.className = "dc-ai-prompts";
    promptsRow.id = "dcAiPrompts";
    const PROMPTS = [
      { label: "综述笔记", icon: "≡", prompt: "请基于这篇文献，补充一版更适合放入博士论文文献综述的结构化笔记。" },
      { label: "可引用点", icon: "✓", prompt: "请提取这篇文献中最适合作为论文论据的可引用观点，并说明可放入哪一章或哪一节。" },
      { label: "分类建议", icon: "▤", prompt: "请重新判断这篇文献在我的分类体系中的位置，给出一级分类、二级分类和理由。" },
      { label: "相关性",   icon: "◎", prompt: "请说明这篇文献与我的博士论文主题的关系，分为强相关、中相关、弱相关，并解释原因。" },
    ];
    promptsRow.innerHTML = PROMPTS.map(
      (p) => `<button type="button" data-prompt="${p.prompt.replace(/"/g, "&quot;")}"><span class="dc-ai-prompt-icon">${p.icon}</span>${p.label}</button>`
    ).join("");

    // Attach-row removed — 全文上下文 was confusing; 加图 not desired.
    const attachRow = null;

    // ---- Compose shell: textarea + toolbar ----
    const composeShell = document.createElement("div");
    composeShell.className = "dc-ai-compose-shell";
    composeShell.id = "dcAiComposeShell";

    // Move the existing #questionInput INTO the shell so we don't lose
    // event listeners and value.
    const questionInput = document.getElementById("questionInput");
    if (questionInput) {
      questionInput.placeholder = "问当前文献…  也可以「上面那条详细一点」追问";
      composeShell.appendChild(questionInput);
    } else {
      const fakeInput = document.createElement("textarea");
      fakeInput.id = "questionInput";
      fakeInput.placeholder = "问当前文献…";
      composeShell.appendChild(fakeInput);
    }

    const composeBar = document.createElement("div");
    composeBar.className = "dc-ai-compose-bar";
    composeBar.innerHTML = `
      <button class="dc-ai-toolbtn danger" id="dcAiClearBtn" type="button" title="清空当前会话的对话历史">
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2.5 3.5h7"/><path d="M4 3.5v-1h4v1"/><path d="M3.5 3.5l.6 7h3.8l.6-7"/></svg>
        清空
      </button>
      <span class="dc-ai-toolspacer"></span>
      <span class="dc-kbd-hint">⌘Enter</span>
      <button class="dc-ai-send" id="dcAiSendBtn" type="button">
        发送
        <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6l8-4-3 8-2-3z"/></svg>
      </button>
    `;
    composeShell.appendChild(composeBar);

    // Insert after chatHistory: prompts row + compose shell
    if (chatHistory.nextSibling) {
      panel.insertBefore(promptsRow, chatHistory.nextSibling);
      panel.insertBefore(composeShell, promptsRow.nextSibling);
    } else {
      panel.appendChild(promptsRow);
      panel.appendChild(composeShell);
    }

    wireEvents();
    wireThinkingBubble();
    return true;
  }

  // ============================================================
  // 3. Wire new controls to existing hidden controls
  // ============================================================
  function wireEvents() {
    // Quick prompts
    document.querySelectorAll("#dcAiPrompts button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const q = document.getElementById("questionInput");
        if (q) {
          q.value = btn.dataset.prompt;
          q.focus();
        }
      });
    });

    // 多轮 chip in 语境 row: toggle #chatUseHistory
    const realToggle = document.getElementById("chatUseHistory");
    function syncMultiTurn() {
      const on = realToggle ? realToggle.checked : true;
      document.getElementById("dcAiMultiTurn")?.classList.toggle("on", on);
    }
    function flipMultiTurn() {
      if (!realToggle) return;
      realToggle.checked = !realToggle.checked;
      realToggle.dispatchEvent(new Event("change", { bubbles: true }));
      syncMultiTurn();
    }
    document.getElementById("dcAiMultiTurn")?.addEventListener("click", flipMultiTurn);
    realToggle?.addEventListener("change", syncMultiTurn);
    syncMultiTurn();

    // 清空: trigger existing clear chat button
    document.getElementById("dcAiClearBtn")?.addEventListener("click", () => {
      document.getElementById("clearChatBtn")?.click();
    });

    // 发送: trigger existing #askBtn
    document.getElementById("dcAiSendBtn")?.addEventListener("click", () => {
      document.getElementById("askBtn")?.click();
    });

    // Ctrl/Cmd+Enter on textarea also sends
    const q = document.getElementById("questionInput");
    q?.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        document.getElementById("askBtn")?.click();
      }
    });

    // Citation chip → cycle through citations from #aiWorkContext <select>
    document.getElementById("dcAiCtxCitation")?.addEventListener("click", (e) => {
      // If user clicked the ✕ remove button, clear instead
      if (e.target.closest(".dc-chip-remove")) {
        const sel = document.getElementById("aiWorkContext");
        if (sel) {
          sel.value = "";
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }
        syncCtxCitation();
        return;
      }
      // Otherwise: open a quick picker via the native <select>
      const sel = document.getElementById("aiWorkContext");
      if (sel) {
        // Cycling: pick next option
        const opts = Array.from(sel.options);
        const cur = opts.findIndex((o) => o.value === sel.value);
        const next = opts[(cur + 1) % opts.length];
        sel.value = next.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        syncCtxCitation();
      }
    });

    // Sync paper chip with currently-selected paper title
    syncCtxPaper();
    syncCtxCitation();
    document.getElementById("aiWorkContext")?.addEventListener("change", syncCtxCitation);

    // Watch for paper title changes (when user selects a new paper)
    const titleEl = document.getElementById("paperTitle");
    if (titleEl) {
      const mo = new MutationObserver(syncCtxPaper);
      mo.observe(titleEl, { childList: true, characterData: true, subtree: true });
    }
  }

  // ============================================================
  // 3b. Thinking bubble — shown while #askBtn is disabled (= waiting for AI)
  //     Previously the user got zero feedback: question disappeared, status
  //     line was hidden, no progress dots. Now we show a chat bubble that
  //     animates dots + elapsed-seconds counter, and surfaces errors when the
  //     #aiStatus text changes to an error string.
  // ============================================================
  function wireThinkingBubble() {
    const host = document.getElementById("chatHistory");
    const askBtn = document.getElementById("askBtn");
    const aiStatus = document.getElementById("aiStatus");
    if (!host || !askBtn) return;

    let bubble = null;
    let elapsedTimer = null;
    let startedAt = 0;

    function ensureBubble() {
      if (bubble && bubble.isConnected) return bubble;
      bubble = document.createElement("div");
      bubble.id = "dcAiThinking";
      bubble.innerHTML = `
        <span class="dc-thinking-dots"><span></span><span></span><span></span></span>
        <span class="dc-thinking-label">AI 正在阅读这篇文献…</span>
        <span class="dc-thinking-elapsed" id="dcAiThinkingElapsed">0.0s</span>
      `;
      // CRITICAL: insert AFTER #chatHistory as a SIBLING — not inside it.
      // phase2's chat re-render does `#chatHistory.innerHTML = ""`, which would
      // instantly wipe a child bubble (that's why the dots looked frozen /
      // never appeared). As a sibling it survives every chat re-render.
      const parent = host.parentNode;
      if (parent) parent.insertBefore(bubble, host.nextSibling);
      else host.appendChild(bubble);
      return bubble;
    }

    function show() {
      const b = ensureBubble();
      b.classList.add("is-active");
      // scroll chat history to bottom so the bubble is visible
      host.scrollTop = host.scrollHeight;
      startedAt = performance.now();
      const elEl = document.getElementById("dcAiThinkingElapsed");
      const tick = () => {
        if (!elEl) return;
        elEl.textContent = ((performance.now() - startedAt) / 1000).toFixed(1) + "s";
      };
      tick();
      if (elapsedTimer) clearInterval(elapsedTimer);
      elapsedTimer = setInterval(tick, 200);
    }

    function hide() {
      if (bubble) bubble.classList.remove("is-active");
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    }

    // Watch askBtn's disabled attribute. askAi() sets disabled=true on send,
    // false in the finally block — perfect signal for "AI thinking".
    const mo = new MutationObserver((entries) => {
      for (const entry of entries) {
        if (entry.attributeName === "disabled") {
          if (askBtn.disabled) {
            show();
          } else {
            hide();
            // If aiStatus contains an error message, surface it as a temporary
            // bubble so the user sees what went wrong. Status text "已完成"
            // / "已完成 · 240 tokens" / "" → no error.
            const status = (aiStatus?.textContent || "").trim();
            if (status &&
                !status.startsWith("已完成") &&
                !status.startsWith("AI 正在") &&
                status.length > 1) {
              showErrorBubble(status);
            }
          }
        }
      }
    });
    mo.observe(askBtn, { attributes: true, attributeFilter: ["disabled"] });

    function showErrorBubble(msg) {
      const errBubble = document.createElement("div");
      errBubble.className = "chat-msg chat-msg-assistant";
      errBubble.style.cssText = "color:#8b2f24;background:#fcebe8;border:1px solid #e8c5be;border-radius:8px;padding:8px 12px;margin:6px 0;font-size:12px;white-space:pre-wrap;";
      errBubble.textContent = "AI 调用失败：" + msg;
      host.appendChild(errBubble);
      host.scrollTop = host.scrollHeight;
    }
  }

  // ============================================================
  // 4. Sync helpers
  // ============================================================
  function shortPaperLabel() {
    // Try to build "{first_author} {year}" from #paperMeta or #paperTitle.
    const meta = document.getElementById("paperMeta")?.textContent?.trim() || "";
    const title = document.getElementById("paperTitle")?.textContent?.trim() || "";
    if (title === "选择一篇文献" || !title) return "";
    // paperMeta is usually "YYYY 作者；…"
    const m = meta.match(/^(\d{4})\s+([^；,;]+)/);
    if (m) {
      const author = m[2].split(/[\s,]+/)[0].replace(/[A-Z]\./g, "").trim();
      return `${author} ${m[1]}`;
    }
    // Fallback: short title
    return title.slice(0, 28) + (title.length > 28 ? "…" : "");
  }

  function syncCtxPaper() {
    const chip = document.getElementById("dcAiCtxPaper");
    if (!chip) return;
    const text = chip.querySelector(".dc-chip-text");
    const label = shortPaperLabel();
    if (text) text.textContent = label || "未选文献";
    chip.style.opacity = label ? "1" : "0.5";
  }

  function syncCtxCitation() {
    const chip = document.getElementById("dcAiCtxCitation");
    if (!chip) return;
    const sel = document.getElementById("aiWorkContext");
    const remove = chip.querySelector(".dc-chip-remove");
    const text = chip.querySelector(".dc-chip-text");
    if (!sel || !sel.value) {
      chip.classList.add("dc-chip-citation-empty");
      if (text) text.textContent = "+ 工作语境";
      if (remove) remove.style.display = "none";
    } else {
      chip.classList.remove("dc-chip-citation-empty");
      const opt = sel.options[sel.selectedIndex];
      if (text) text.textContent = opt ? opt.text : sel.value;
      if (remove) remove.style.display = "";
    }
  }

  // image-attach 功能保留在按页读图弹窗里，但 AI 面板上不再显示该入口/状态。

  // ============================================================
  // 5. Render inline page-ref chips inside assistant messages
  // ============================================================
  function chipifyPageRefs(root) {
    if (!root) return;
    root.querySelectorAll("#aiPanel .chat-msg-assistant .bubble-body").forEach((body) => {
      if (body.dataset.dcChipified) return;
      body.dataset.dcChipified = "1";
      // Walk text nodes, replace [p.N] / p.N / §N / §N.M with chips
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
      const targets = [];
      let n;
      while ((n = walker.nextNode())) targets.push(n);
      const RE = /\[?p\.\s?(\d+(?:-\d+)?)\]?|§\s?(\d+(?:\.\d+)?)/g;
      for (const node of targets) {
        const txt = node.nodeValue;
        if (!RE.test(txt)) continue;
        RE.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let m;
        while ((m = RE.exec(txt))) {
          if (m.index > last) frag.appendChild(document.createTextNode(txt.slice(last, m.index)));
          const chip = document.createElement("span");
          chip.className = "page-ref-chip";
          chip.textContent = m[0].replace(/[\[\]]/g, "");
          if (m[1]) chip.dataset.page = m[1].split("-")[0];
          frag.appendChild(chip);
          last = m.index + m[0].length;
        }
        if (last < txt.length) frag.appendChild(document.createTextNode(txt.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
    });
  }

  // Observe chatHistory for new messages, then chipify.
  // Debounced + childList-only: the old observer fired on every characterData
  // / subtree mutation — including chipify's OWN replaceChild — so the chat
  // subtree churned continuously, collapsing any text selection the user
  // tried to make inside an answer bubble. Debouncing + ignoring our own
  // mutations lets the DOM settle so selection sticks.
  function watchChat() {
    const host = document.getElementById("chatHistory");
    if (!host) return;
    let timer = null;
    let chipifying = false;
    const mo = new MutationObserver(() => {
      if (chipifying) return;  // ignore mutations chipify itself caused
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        chipifying = true;
        try { chipifyPageRefs(host); }
        finally { chipifying = false; }
      }, 250);
    });
    mo.observe(host, { childList: true });  // childList only — no subtree/charData
    chipifyPageRefs(host);
  }

  // Click page-ref chip → jump PDF iframe to page
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".page-ref-chip");
    if (!chip || !chip.dataset.page) return;
    const iframe = document.querySelector(".pdfv-iframe, #pdfViewer iframe");
    if (!iframe) return;
    try {
      const url = new URL(iframe.src, location.href);
      url.hash = `page=${chip.dataset.page}`;
      iframe.src = url.toString();
    } catch (_) {}
  });

  // ============================================================
  // 6. Boot
  // ============================================================
  function boot() {
    injectStyles();
    if (mount()) {
      watchChat();
    } else {
      // aiPanel not in DOM yet; retry on next frame
      requestAnimationFrame(boot);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
