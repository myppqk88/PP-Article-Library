/* ============================================================
 * 文献工作台 — Phase 2: AI multi-conversation + editable append + page citations.
 *
 * Strategy: keep all conversations in localStorage (key `chat-convs:{paper_id}`).
 * On first switch to a paper, migrate the legacy server-side history into a
 * "默认会话" conversation. After that the server's chat-history file is
 * never written again — all chat lives in localStorage.
 *
 * Multi-turn context: prior messages are stitched into the next prompt as
 * a 【先前对话】 prefix, and `/api/ask` is called with `use_history=false`.
 *
 * NO backend changes required.
 * ============================================================ */

(function () {
  "use strict";

  const TURNS = 6;                    // max prior turns to include in prompt
  const STORAGE_PREFIX = "chat-convs:";
  let currentPaperId = null;
  let convs = { conversations: [], active_id: null };
  let isRenderingByMe = false;       // kept for backward compat (unused now)
  let chatObserver = null;           // the #chatHistory MutationObserver

  const origFetch = window.fetch.bind(window);

  // ============================================================
  // Storage
  // ============================================================
  function loadConvs(paperId) {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + paperId);
      if (!raw) return { conversations: [], active_id: null };
      const obj = JSON.parse(raw);
      return obj && obj.conversations ? obj : { conversations: [], active_id: null };
    } catch (_) {
      return { conversations: [], active_id: null };
    }
  }
  function saveConvs(paperId, data) {
    try {
      localStorage.setItem(STORAGE_PREFIX + paperId, JSON.stringify(data));
    } catch (e) {
      console.warn("[phase2] save convs failed:", e);
    }
  }
  function genId() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }
  function activeConv() {
    return convs.conversations.find((c) => c.id === convs.active_id);
  }

  // ============================================================
  // Paper-change detection: intercept fetch to learn current paper_id
  // ============================================================
  window.fetch = function (...args) {
    const url = args[0];
    if (typeof url === "string") {
      const m = url.match(/\/api\/paper\?paper_id=([^&]+)/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (id !== currentPaperId) {
          onPaperChanged(id);
        }
      }
    }
    return origFetch(...args);
  };

  async function onPaperChanged(paperId) {
    currentPaperId = paperId;
    convs = loadConvs(paperId);
    if (!convs.conversations.length) {
      // Migrate from legacy server-side history
      let legacy = [];
      try {
        const resp = await origFetch(
          `/api/chat-history?paper_id=${encodeURIComponent(paperId)}`
        );
        if (resp.ok) {
          const data = await resp.json();
          legacy = data.history || [];
        }
      } catch (_) {}
      const conv = {
        id: genId(),
        name: legacy.length ? "默认会话（迁移自旧版）" : "默认会话",
        created_at: new Date().toISOString(),
        messages: legacy,
      };
      convs = { conversations: [conv], active_id: conv.id };
      saveConvs(paperId, convs);
    }
    renderConvStrip();
    rerenderChat();
  }

  // ============================================================
  // Conversation strip
  // ============================================================
  function ensureConvStrip() {
    let strip = document.getElementById("aiConvStrip");
    if (strip) return strip;
    const aiPanel = document.getElementById("aiPanel");
    if (!aiPanel) return null;
    strip = document.createElement("div");
    strip.id = "aiConvStrip";
    strip.className = "ai-conv-strip";
    // Insert as the very FIRST child of aiPanel, above the work-context row.
    aiPanel.insertBefore(strip, aiPanel.firstChild);
    return strip;
  }

  function renderConvStrip() {
    const strip = ensureConvStrip();
    if (!strip) return;
    strip.innerHTML = "";

    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "conv-new";
    newBtn.title = "新建对话";
    newBtn.innerHTML =
      '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 2v8M2 6h8"/></svg> 新建';
    newBtn.addEventListener("click", createConv);
    strip.appendChild(newBtn);

    for (const c of convs.conversations) {
      const chip = document.createElement("span");
      chip.className = "conv-chip" + (c.id === convs.active_id ? " active" : "");
      chip.title = c.name;
      const turns = c.messages.filter((m) => m.role === "user").length;
      chip.innerHTML = `
        <span class="conv-name"></span>
        <span class="conv-count">${turns}</span>
        <button class="conv-menu" type="button" title="重命名 / 删除">⋮</button>
      `;
      chip.querySelector(".conv-name").textContent = c.name;
      chip.addEventListener("click", (e) => {
        if (e.target.closest(".conv-menu")) return;
        activateConv(c.id);
      });
      chip.querySelector(".conv-menu").addEventListener("click", (e) => {
        e.stopPropagation();
        openConvMenu(c.id);
      });
      strip.appendChild(chip);
    }
  }

  function createConv() {
    if (!currentPaperId) return;
    const name = prompt(
      "新对话名称：",
      `对话 ${convs.conversations.length + 1}`
    );
    if (!name || !name.trim()) return;
    const conv = {
      id: genId(),
      name: name.trim(),
      created_at: new Date().toISOString(),
      messages: [],
    };
    convs.conversations.push(conv);
    convs.active_id = conv.id;
    saveConvs(currentPaperId, convs);
    renderConvStrip();
    rerenderChat();
  }

  function activateConv(id) {
    if (convs.active_id === id) return;
    convs.active_id = id;
    saveConvs(currentPaperId, convs);
    renderConvStrip();
    rerenderChat();
  }

  function openConvMenu(id) {
    const c = convs.conversations.find((x) => x.id === id);
    if (!c) return;
    const choice = prompt(
      `「${c.name}」\n\n输入操作：\n1 = 重命名\n2 = 删除\n3 = 复制\n\n（取消则关闭）`,
      "1"
    );
    if (choice === "1") {
      const newName = prompt("新名称：", c.name);
      if (newName && newName.trim()) {
        c.name = newName.trim();
        saveConvs(currentPaperId, convs);
        renderConvStrip();
      }
    } else if (choice === "2") {
      if (convs.conversations.length <= 1) {
        alert("至少要保留一个对话。");
        return;
      }
      if (!confirm(`确认删除「${c.name}」？此操作不可撤销。`)) return;
      convs.conversations = convs.conversations.filter((x) => x.id !== id);
      if (convs.active_id === id) convs.active_id = convs.conversations[0].id;
      saveConvs(currentPaperId, convs);
      renderConvStrip();
      rerenderChat();
    } else if (choice === "3") {
      const copy = {
        id: genId(),
        name: c.name + " 副本",
        created_at: new Date().toISOString(),
        messages: JSON.parse(JSON.stringify(c.messages)),
      };
      convs.conversations.push(copy);
      convs.active_id = copy.id;
      saveConvs(currentPaperId, convs);
      renderConvStrip();
      rerenderChat();
    }
  }

  // ============================================================
  // Chat rendering (replaces app.js's renderChatHistory)
  // ============================================================
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c])
    );
  }

  function renderMessageContent(text) {
    let html = escapeHtml(text);
    // Page citations: [p.7], (p.7), p.7, p.12-15, pp.12-15
    const re = /(\[|\()?\bp+p?\.?\s*(\d+)(?:\s*[-–]\s*(\d+))?(\]|\))?/gi;
    html = html.replace(re, (m, open, p1, p2, close) => {
      const pages = p2 ? `${p1}-${p2}` : p1;
      return `<a class="page-ref" data-page="${p1}" title="跳到 PDF 第 ${pages} 页">[p.${pages}]</a>`;
    });
    // Light markdown: **bold** *italic* `code`
    html = html
      .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`\n]+?)`/g, "<code>$1</code>")
      .replace(/(?:^|\s)\*([^*\n]+?)\*(?:\s|$)/g, " <em>$1</em> ");
    return html;
  }

  function formatTs(ts) {
    if (!ts) return "";
    return String(ts).replace("T", " ").replace("Z", "").slice(0, 16);
  }

  function rerenderChat() {
    const host = document.getElementById("chatHistory");
    if (!host) return;
    // Disconnect our observer for the whole render so our own DOM writes
    // don't re-trigger it (which used to cause an endless re-render loop).
    if (chatObserver) chatObserver.disconnect();
    isRenderingByMe = true;
    host.innerHTML = "";
    const conv = activeConv();
    if (!conv) {
      isRenderingByMe = false;
      if (chatObserver) chatObserver.observe(host, { childList: true });
      return;
    }
    for (let idx = 0; idx < conv.messages.length; idx++) {
      const msg = conv.messages[idx];
      const wrap = document.createElement("div");
      wrap.className = `chat-msg chat-msg-${msg.role === "assistant" ? "assistant" : "user"}`;
      wrap.dataset.idx = String(idx);

      const meta = document.createElement("div");
      meta.className = "chat-msg-meta";
      const role = document.createElement("span");
      role.className = "chat-role";
      role.textContent = msg.role === "assistant" ? "AI" : "我";
      meta.appendChild(role);
      if (msg.ts) {
        const ts = document.createElement("span");
        ts.className = "chat-time";
        ts.textContent = formatTs(msg.ts);
        meta.appendChild(ts);
      }
      if (msg.role === "assistant" && msg.model) {
        const model = document.createElement("span");
        model.textContent = msg.model;
        meta.appendChild(model);
      }
      wrap.appendChild(meta);

      const body = document.createElement("div");
      body.className = "bubble-body";
      body.innerHTML = renderMessageContent(String(msg.content || ""));
      wrap.appendChild(body);

      if (msg.role === "assistant") {
        const actions = document.createElement("div");
        actions.className = "bubble-actions";
        actions.innerHTML = `
          <button data-act="copy" type="button">复制</button>
          <button data-act="append" type="button">追加到笔记…</button>
          <button data-act="append-citation" type="button">+ 追加到 citation</button>
          <button data-act="regenerate" type="button">重生成</button>
        `;
        wrap.appendChild(actions);
      }
      host.appendChild(wrap);
    }
    host.scrollTop = host.scrollHeight;
    updateChatStatus();
    isRenderingByMe = false;
    // Reconnect AFTER this synchronous render finishes so the just-made
    // mutations are not queued for the observer.
    if (chatObserver) chatObserver.observe(host, { childList: true });
  }

  function updateChatStatus() {
    const conv = activeConv();
    const status = document.getElementById("chatHistoryStatus");
    if (!status) return;
    if (!conv) {
      status.textContent = "尚无对话";
      return;
    }
    const userTurns = conv.messages.filter((m) => m.role === "user").length;
    status.textContent = userTurns
      ? `${conv.name} · ${userTurns} 轮提问`
      : `${conv.name} · 尚无对话`;
    const clearBtn = document.getElementById("clearChatBtn");
    if (clearBtn) clearBtn.disabled = !userTurns;
  }

  // Reset rendered chat whenever app.js touches #chatHistory.
  // The observer is DISCONNECTED for the duration of our own rerenderChat and
  // reconnected after — the old `isRenderingByMe` boolean did not work because
  // the observer callback is async (a microtask): by the time it ran,
  // rerenderChat had already set the flag back to false, so phase2's own
  // renders re-triggered the observer → a continuous re-render loop that
  // rebuilt the bubbles constantly and collapsed any text selection.
  function installChatHistoryObserver() {
    const chatHistory = document.getElementById("chatHistory");
    if (!chatHistory) return;
    chatObserver = new MutationObserver(() => {
      setTimeout(rerenderChat, 0);
    });
    chatObserver.observe(chatHistory, { childList: true });
  }

  // ============================================================
  // Page-ref click → PDF iframe #page=N
  // ============================================================
  document.addEventListener("click", (e) => {
    const ref = e.target.closest(".page-ref");
    if (!ref) return;
    e.preventDefault();
    const page = ref.dataset.page;
    if (!page) return;
    const iframe = document.querySelector(".pdfv-iframe, #pdfViewer iframe");
    if (!iframe) return;
    try {
      const url = new URL(iframe.src, location.href);
      url.hash = `page=${page}`;
      iframe.src = url.toString();
    } catch (err) {
      console.warn("[phase2] jump-to-page failed:", err);
    }
  });

  // ============================================================
  // Bubble actions: copy / append / regenerate
  // ============================================================
  // Robust copy: clipboard API, with an execCommand fallback for insecure
  // contexts (e.g. opened via a LAN IP rather than 127.0.0.1) and a visible
  // success/fail state.
  async function copyTextRobust(text, btn) {
    if (!text) return;
    const orig = btn.dataset.origLabel || btn.textContent;
    btn.dataset.origLabel = orig;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (_) { ok = false; }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;left:-9999px;top:0;";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch (_) { ok = false; }
    }
    btn.textContent = ok ? "已复制 ✓" : "复制失败";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  }

  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#chatHistory .bubble-actions button");
    if (!btn) return;
    const act = btn.dataset.act;
    const bubble = btn.closest(".chat-msg");
    if (!bubble) return;

    // COPY reads text straight from the bubble DOM — works no matter which
    // renderer built the bubble (phase2 vs app.js) and even if data-idx is
    // missing/NaN. The old code looked up conv.messages[idx] and silently
    // returned when idx was NaN, so the button did nothing.
    if (act === "copy") {
      const body = bubble.querySelector(".bubble-body") || bubble;
      const text = (body.innerText || body.textContent || "").trim();
      copyTextRobust(text, btn);
      return;
    }

    const idx = parseInt(bubble.dataset.idx, 10);
    const conv = activeConv();
    if (!conv) return;
    const msg = conv.messages[idx];
    if (!msg) return;
    if (act === "append") {
      openAppendEditor(idx, bubble);
    } else if (act === "append-citation") {
      appendToCitation(idx, btn);
    } else if (act === "regenerate") {
      regenerateFrom(idx);
    }
  });

  async function appendToCitation(idx, btn) {
    const conv = activeConv();
    if (!conv) return;
    const msg = conv.messages[idx];
    if (!msg || !currentPaperId) return;
    // Use the citation currently selected in the AI 工作语境 dropdown
    const sel = document.getElementById("aiWorkContext");
    const citation = sel?.value || "";
    if (!citation) {
      window.toast?.("请先在顶部「语境」chip 里选一个 citation 文件，再追加。", "error");
      return;
    }
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      // Append as a simple markdown block; the citation file is plain MD
      const entry = `\n\n### ${currentPaperId} · AI 整理 · ${new Date().toISOString().slice(0, 10)}\n\n${msg.content.trim()}\n`;
      // Fetch current file → append → save
      const cur = await (await origFetch(`/api/citation?name=${encodeURIComponent(citation)}`)).json();
      const newRaw = (cur.citation?.raw || "") + entry;
      const r = await origFetch("/api/citation/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: citation, raw: newRaw }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "保存失败");
      btn.textContent = "✓ 已追加";
      window.toast?.(`已追加到 ${citation}.md`, "success");
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
    } catch (e) {
      window.toast?.("追加失败：" + e.message, "error");
      btn.textContent = orig;
      btn.disabled = false;
    }
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function openAppendEditor(idx, bubble) {
    bubble.querySelectorAll(".ai-append-editor").forEach((el) => el.remove());
    const conv = activeConv();
    if (!conv) return;
    const msg = conv.messages[idx];

    const editor = document.createElement("div");
    editor.className = "ai-append-editor";
    editor.innerHTML = `
      <div class="ae-head">
        <span class="ae-label">追加到</span>
        <div class="ae-target-seg">
          <button type="button" class="active" data-target="note">本文笔记</button>
          <button type="button" data-target="sticky">便签</button>
        </div>
        <span class="ae-target" id="aeTarget">notes/${currentPaperId || ""}.md</span>
      </div>
      <div class="ae-field">
        <label>标题（插入为二级标题）</label>
        <input type="text" />
      </div>
      <div class="ae-field">
        <label>内容（可编辑 AI 原文）</label>
        <textarea></textarea>
      </div>
      <div class="ae-foot">
        <button type="button" class="ae-cancel">取消</button>
        <button type="button" class="ae-confirm">追加</button>
      </div>
    `;
    editor.querySelector("input").value = `AI · 可引用点 · ${todayStr()}`;
    editor.querySelector("textarea").value = msg.content;
    bubble.appendChild(editor);
    editor.querySelector("textarea").focus();

    function updateTargetLabel() {
      const target = editor.querySelector(".ae-target-seg button.active").dataset.target;
      const lab = editor.querySelector("#aeTarget");
      if (target === "note") lab.textContent = `notes/${currentPaperId || ""}.md`;
      else lab.textContent = `library/stickies/${currentPaperId || ""}.json`;
    }

    editor.querySelectorAll(".ae-target-seg button").forEach((b) => {
      b.addEventListener("click", () => {
        editor
          .querySelectorAll(".ae-target-seg button")
          .forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        updateTargetLabel();
      });
    });

    editor.querySelector(".ae-cancel").addEventListener("click", () => editor.remove());

    editor.querySelector(".ae-confirm").addEventListener("click", async () => {
      const target = editor.querySelector(".ae-target-seg button.active").dataset.target;
      const title = editor.querySelector("input").value.trim();
      const content = editor.querySelector("textarea").value.trim();
      if (!content || !currentPaperId) return;
      const confirmBtn = editor.querySelector(".ae-confirm");
      confirmBtn.disabled = true;
      confirmBtn.textContent = "追加中…";
      try {
        if (target === "note") {
          await origFetch("/api/note/append", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paper_id: currentPaperId,
              title,
              content,
            }),
          });
          // Refresh visible note
          const resp = await origFetch(
            `/api/note?paper_id=${encodeURIComponent(currentPaperId)}`
          );
          if (resp.ok) {
            const data = await resp.json();
            const noteEditor = document.getElementById("noteEditor");
            const notePreview = document.getElementById("notePreview");
            if (noteEditor) noteEditor.value = data.content || "";
            if (notePreview) notePreview.innerHTML = simpleMarkdown(data.content || "");
          }
        } else if (target === "sticky") {
          await origFetch("/api/sticky/add", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paper_id: currentPaperId,
              content: title ? `**${title}**\n\n${content}` : content,
              color: "clay",
            }),
          });
        }
        const aiStatus = document.getElementById("aiStatus");
        if (aiStatus) aiStatus.textContent = target === "note" ? "已追加到笔记" : "已追加到便签";
        editor.remove();
      } catch (err) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = "追加";
        alert("追加失败：" + err.message);
      }
    });
  }

  function regenerateFrom(assistantIdx) {
    const conv = activeConv();
    if (!conv) return;
    let userIdx = assistantIdx - 1;
    while (userIdx >= 0 && conv.messages[userIdx].role !== "user") userIdx--;
    if (userIdx < 0) return;
    const userMsg = conv.messages[userIdx];
    conv.messages = conv.messages.slice(0, userIdx);
    saveConvs(currentPaperId, convs);
    rerenderChat();
    sendQuestion(userMsg.content);
  }

  // ============================================================
  // Send: replaces askAi via capture-phase intercept on #askBtn
  // ============================================================
  function installSendIntercept() {
    const askBtn = document.getElementById("askBtn");
    if (!askBtn) return;
    askBtn.addEventListener(
      "click",
      (e) => {
        e.stopImmediatePropagation();
        const qEl = document.getElementById("questionInput");
        const q = qEl ? qEl.value.trim() : "";
        if (!q) return;
        sendQuestion(q);
      },
      { capture: true }
    );
  }

  async function sendQuestion(question) {
    if (!currentPaperId) return;
    const conv = activeConv();
    if (!conv) return;
    const askBtn = document.getElementById("askBtn");
    const status = document.getElementById("aiStatus");
    if (askBtn) askBtn.disabled = true;
    if (status) status.textContent = "AI 正在阅读当前文献…";
    const qEl = document.getElementById("questionInput");
    if (qEl) qEl.value = "";

    // Append user message
    conv.messages.push({
      role: "user",
      content: question,
      ts: new Date().toISOString(),
    });
    saveConvs(currentPaperId, convs);
    rerenderChat();

    // Build prompt with prior context (if multi-turn on)
    const useHistory =
      document.getElementById("chatUseHistory")?.checked ?? true;
    const useImages =
      document.getElementById("imageAskToggle")?.checked ?? false;
    const pageSpec =
      document.getElementById("imagePageInput")?.value.trim() || "";
    const workContext = document.getElementById("aiWorkContext")?.value || "";

    let promptQuestion = question;
    if (useHistory && conv.messages.length > 1) {
      const trail = conv.messages.slice(-TURNS - 1, -1);
      if (trail.length) {
        const prefix = trail
          .map((m) => `${m.role === "user" ? "用户" : "助手"}: ${m.content}`)
          .join("\n\n");
        promptQuestion = `【先前对话】\n${prefix}\n\n【本轮问题】\n${question}`;
      }
    }

    try {
      const resp = await origFetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paper_id: currentPaperId,
          question: promptQuestion,
          append: false,
          use_images: useImages,
          page_spec: pageSpec,
          use_history: false,
          work_context: workContext,
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text}`);
      }
      const data = await resp.json();
      const usage = data.usage || {};
      conv.messages.push({
        role: "assistant",
        content: data.answer || "",
        ts: new Date().toISOString(),
        model: usage.model || "",
        usage,
      });
      saveConvs(currentPaperId, convs);
      rerenderChat();

      // Backward-compat side effects (kept for app.js's internal state, but
      // hidden so the panel doesn't duplicate the bubble content)
      const aiAnswer = document.getElementById("aiAnswer");
      if (aiAnswer) {
        aiAnswer.textContent = data.answer || "";
        // keep hidden — see init()
      }
      const appendContent = document.getElementById("appendContent");
      if (appendContent) appendContent.value = data.answer || "";
      if (status) {
        status.textContent = usage.total_tokens
          ? `已完成 · ${usage.total_tokens} tokens`
          : usage.provider
            ? `已完成 · ${usage.provider}`
            : "已完成";
      }
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      if (askBtn) askBtn.disabled = false;
    }
  }

  // ============================================================
  // Clear chat: replaces app.js's handler
  // ============================================================
  function installClearIntercept() {
    const clearBtn = document.getElementById("clearChatBtn");
    if (!clearBtn) return;
    clearBtn.addEventListener(
      "click",
      (e) => {
        e.stopImmediatePropagation();
        if (!currentPaperId) return;
        const conv = activeConv();
        if (!conv) return;
        if (!confirm(`清空对话「${conv.name}」的全部记录？此操作不可撤销。`)) return;
        conv.messages = [];
        saveConvs(currentPaperId, convs);
        rerenderChat();
      },
      { capture: true }
    );
  }

  // ============================================================
  // Light markdown renderer (used when refreshing note preview)
  // ============================================================
  function simpleMarkdown(text) {
    const safe = escapeHtml(text);
    return safe
      .replace(/^### (.+)$/gm, "<h3>$1</h3>")
      .replace(/^## (.+)$/gm, "<h2>$1</h2>")
      .replace(/^# (.+)$/gm, "<h1>$1</h1>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/\n\n/g, "</p><p>")
      .replace(/^/, "<p>")
      .replace(/$/, "</p>");
  }

  // ============================================================
  // Init
  // ============================================================
  function init() {
    installChatHistoryObserver();
    installSendIntercept();
    installClearIntercept();
    renderConvStrip();
    // The pre-P2 #aiAnswer block and <details class="append-to-note">
    // are now redundant — every bubble has its own actions + inline editor.
    // Hide them so the AI panel isn't cluttered.
    const aiAnswer = document.getElementById("aiAnswer");
    if (aiAnswer) aiAnswer.style.display = "none";
    document.querySelectorAll("#aiPanel .append-to-note").forEach((d) => {
      d.style.display = "none";
    });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
