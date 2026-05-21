/* ============================================================================
 * Model picker — adds a 「检测可用模型」 button next to every model-name input
 * in settings, so users never have to remember / spell model names.
 *
 * Click the button → backend probes the provider:
 *   • Ollama            GET /api/tags        — real, lists installed models
 *   • OpenAI-compatible GET /models          — real if the API supports it;
 *                       (DeepSeek / Qwen / OpenAI / vision / OCR cloud)
 *                       falls back to a curated list on failure
 *   • Codex CLI         curated list (no list-models API)
 *   • Claude CLI        curated list
 * → a popover lists the models with availability notes; click one to fill
 *   the input. The input stays the source of truth, so the existing save
 *   logic is untouched.
 *
 * Backend: POST /api/models/detect {provider, base_url?, api_key_env?}
 * ========================================================================== */

(() => {
  const log = (...a) => console.log("[models]", ...a);

  // input id  →  how to detect it
  const MODEL_INPUTS = {
    deepseekModel:          { provider: "openai_compatible", baseUrl: "deepseekBaseUrl",        keyEnv: "deepseekKeyEnv" },
    qwenModel:              { provider: "openai_compatible", baseUrl: "qwenBaseUrl",            keyEnv: "qwenKeyEnv" },
    openaiCompatibleModel:  { provider: "openai_compatible", baseUrl: "openaiCompatibleBaseUrl", keyEnv: "openaiCompatibleKeyEnv" },
    codexModel:             { provider: "codex" },
    claudeModel:            { provider: "claude" },
    translationOllamaModel: { provider: "ollama",            baseUrl: "translationOllamaUrl" },
    translationOpenaiModel: { provider: "openai_compatible", baseUrl: "translationOpenaiUrl",   keyEnv: "translationOpenaiKeyEnv" },
    visionQwenModel:        { provider: "openai_compatible", baseUrl: "visionQwenBaseUrl",      keyEnv: "visionQwenKeyEnv" },
    visionOpenaiModel:      { provider: "openai_compatible", baseUrl: "visionOpenaiBaseUrl",    keyEnv: "visionOpenaiKeyEnv" },
    ocrCloudModel:          { provider: "openai_compatible", baseUrl: "ocrCloudBaseUrl",        keyEnv: "ocrCloudKeyEnv" },
  };

  // ---------------------------------------------------------- styles
  const css = `
    .dc-model-btn {
      margin-left: 6px;
      padding: 3px 9px;
      font-size: 11px;
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 6px;
      background: var(--dc-bg-soft, #f5f1e8);
      color: var(--dc-text, #2b2620);
      cursor: pointer;
      white-space: nowrap;
      vertical-align: middle;
    }
    .dc-model-btn:hover { border-color: var(--dc-accent, #c8553d); color: var(--dc-accent-strong, #a23b28); }
    .dc-model-btn:disabled { opacity: 0.6; cursor: progress; }
    .dc-model-pop {
      position: fixed;
      z-index: 1200;
      width: 340px;
      max-height: 360px;
      overflow-y: auto;
      background: var(--dc-bg-panel, #fff);
      color: var(--dc-text, #2b2620);
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 10px;
      box-shadow: 0 12px 36px -8px rgba(20,14,8,0.32);
      font-size: 12.5px;
      padding: 6px;
    }
    .dc-model-pop .mp-head {
      font-size: 11px;
      color: var(--dc-muted, #6b6660);
      padding: 6px 8px;
      line-height: 1.5;
      border-bottom: 1px solid var(--dc-line, #d9d6cf);
      margin-bottom: 4px;
    }
    .dc-model-pop .mp-row {
      display: flex; justify-content: space-between; align-items: baseline;
      gap: 10px;
      padding: 7px 9px;
      border-radius: 6px;
      cursor: pointer;
    }
    .dc-model-pop .mp-row:hover { background: var(--dc-bg-soft, #f5f1e8); }
    .dc-model-pop .mp-id {
      font-family: var(--dc-font-mono, ui-monospace, Consolas, monospace);
      font-weight: 600;
      word-break: break-all;
    }
    .dc-model-pop .mp-note {
      font-size: 10.5px;
      color: var(--dc-muted, #6b6660);
      white-space: nowrap;
      flex-shrink: 0;
    }
    .dc-model-pop .mp-row[data-avail="1"] .mp-id { color: var(--dc-accent-strong, #a23b28); }
    .dc-model-pop .mp-loading, .dc-model-pop .mp-empty {
      padding: 14px; text-align: center; color: var(--dc-muted, #6b6660); font-size: 12px;
    }
    .dc-model-pop .mp-manual {
      border-top: 1px solid var(--dc-line, #d9d6cf);
      margin-top: 4px;
      padding: 8px 8px 4px;
    }
    .dc-model-pop .mp-manual-label {
      font-size: 10.5px; color: var(--dc-muted, #6b6660); margin-bottom: 5px;
    }
    .dc-model-pop .mp-manual-row { display: flex; gap: 6px; }
    .dc-model-pop .mp-manual-input {
      flex: 1; min-width: 0;
      padding: 4px 7px;
      font-size: 12px;
      border: 1px solid var(--dc-line, #d9d6cf);
      border-radius: 5px;
      background: var(--dc-bg-soft, #f5f1e8);
      color: var(--dc-text, #2b2620);
      font-family: var(--dc-font-mono, ui-monospace, Consolas, monospace);
    }
    .dc-model-pop .mp-manual-btn {
      padding: 4px 11px;
      font-size: 12px;
      border: 1px solid var(--dc-accent, #c8553d);
      border-radius: 5px;
      background: var(--dc-accent, #c8553d);
      color: #fff;
      cursor: pointer;
      white-space: nowrap;
    }
  `;
  const styleEl = document.createElement("style");
  styleEl.id = "dc-models-style";
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  // ---------------------------------------------------------- popover
  let pop = null;
  function closePop() {
    if (pop) { pop.remove(); pop = null; }
    document.removeEventListener("mousedown", onDocDown, true);
  }
  function onDocDown(e) {
    if (pop && !pop.contains(e.target) && !e.target.classList.contains("dc-model-btn")) {
      closePop();
    }
  }

  function showPop(anchorBtn, targetInput) {
    closePop();
    pop = document.createElement("div");
    pop.className = "dc-model-pop";
    pop.innerHTML = `<div class="mp-loading">正在检测可用模型…</div>`;
    document.body.appendChild(pop);
    // Position under the button
    const r = anchorBtn.getBoundingClientRect();
    let left = r.left;
    let top = r.bottom + 4;
    if (left + 340 > window.innerWidth) left = window.innerWidth - 348;
    if (top + 360 > window.innerHeight) top = Math.max(8, r.top - 364);
    pop.style.left = Math.max(8, left) + "px";
    pop.style.top = top + "px";
    document.addEventListener("mousedown", onDocDown, true);
    return pop;
  }

  function renderPop(data, targetInput) {
    if (!pop) return;
    const models = data.models || [];
    let html = "";
    if (data.error) {
      html += `<div class="mp-head">${escapeHtml(data.error)}</div>`;
    } else if (data.source === "api") {
      html += `<div class="mp-head">接口实时返回 ${models.length} 个模型 — 点击填入</div>`;
    } else if (data.source === "ollama") {
      html += `<div class="mp-head">本地 Ollama 已安装 ${models.length} 个模型 — 点击填入</div>`;
    }
    if (!models.length) {
      html += `<div class="mp-empty">没有检测到模型。下面可手动输入。</div>`;
    } else {
      for (const m of models) {
        if (!m.id) continue;
        html += `
          <div class="mp-row" data-avail="${m.available ? 1 : 0}" data-id="${escapeAttr(m.id)}">
            <span class="mp-id">${escapeHtml(m.id)}</span>
            <span class="mp-note">${escapeHtml(m.note || "")}</span>
          </div>`;
      }
    }
    // Universal escape hatch: type ANY model name (newer version, a model the
    // detector can't enumerate, etc.) and fill it directly.
    const current = (targetInput.value || "").trim();
    html += `
      <div class="mp-manual">
        <div class="mp-manual-label">✏️ 手动输入模型名（检测列不全时用）</div>
        <div class="mp-manual-row">
          <input class="mp-manual-input" type="text" placeholder="例如 claude-opus-4-7"
                 value="${escapeAttr(current)}" />
          <button class="mp-manual-btn" type="button">填入</button>
        </div>
      </div>`;
    pop.innerHTML = html;
    pop.querySelectorAll(".mp-row").forEach((row) => {
      row.addEventListener("click", () => fill(row.dataset.id));
    });
    function fill(value) {
      const v = String(value || "").trim();
      if (!v) return;
      targetInput.value = v;
      targetInput.dispatchEvent(new Event("input", { bubbles: true }));
      targetInput.dispatchEvent(new Event("change", { bubbles: true }));
      closePop();
      targetInput.focus();
    }
    const manualInput = pop.querySelector(".mp-manual-input");
    const manualBtn = pop.querySelector(".mp-manual-btn");
    if (manualBtn) manualBtn.addEventListener("click", () => fill(manualInput.value));
    if (manualInput) {
      manualInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); fill(manualInput.value); }
      });
      // don't let the doc-mousedown handler treat clicks here as "outside"
      manualInput.addEventListener("mousedown", (e) => e.stopPropagation());
    }
  }

  async function detect(cfg) {
    const body = { provider: cfg.provider };
    if (cfg.baseUrl) {
      const el = document.getElementById(cfg.baseUrl);
      if (el) body.base_url = el.value.trim();
    }
    if (cfg.keyEnv) {
      const el = document.getElementById(cfg.keyEnv);
      if (el) body.api_key_env = el.value.trim();
    }
    const resp = await fetch("/api/models/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  // ---------------------------------------------------------- wire buttons
  function injectButtons() {
    for (const [inputId, cfg] of Object.entries(MODEL_INPUTS)) {
      const input = document.getElementById(inputId);
      if (!input || input.dataset.modelBtn) continue;
      input.dataset.modelBtn = "1";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dc-model-btn";
      btn.textContent = "🔍 检测模型";
      btn.title = "检测该 provider 可用的模型，点击列表填入";
      input.insertAdjacentElement("afterend", btn);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        showPop(btn, input);
        try {
          const data = await detect(cfg);
          renderPop(data, input);
        } catch (e) {
          if (pop) pop.innerHTML = `<div class="mp-empty">检测失败：${escapeHtml(e.message)}</div>`;
        } finally {
          btn.disabled = false;
        }
      });
    }
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function escapeAttr(s) {
    return String(s == null ? "" : s).replace(/["&<>]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // Settings modal exists in the DOM from page load (just hidden), so the
  // inputs are present — wire once on DOM ready. Re-run on settings open in
  // case any provider panel was lazily built.
  function boot() {
    injectButtons();
    const settingsBtn = document.getElementById("settingsBtn") || document.getElementById("openSettingsBtn");
    if (settingsBtn) settingsBtn.addEventListener("click", () => setTimeout(injectButtons, 100));
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  log("ready");
})();
