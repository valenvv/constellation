// ResearchMap — content-ai.js
// Injected into ChatGPT, Claude.ai, Perplexity, Gemini.
// Shows a floating button to save the current AI conversation to the graph.

(function () {
  if (window.self !== window.top) return;

  const SOURCE_MAP = {
    "chatgpt.com": "ChatGPT",
    "chat.openai.com": "ChatGPT",
    "claude.ai": "Claude",
    "perplexity.ai": "Perplexity",
    "gemini.google.com": "Gemini",
  };

  const hostname = location.hostname.replace("www.", "");
  const sourceName = SOURCE_MAP[hostname] || hostname;

  // ── Selectors for each platform ──────────────────────────────────────────

  const SELECTORS = {
    // Selectors used to find ALL matches; the LAST one is taken as "most recent".
    // Note: `:last-of-type` was wrong here — it picks the last element of a CSS type among
    // siblings, not the last match of the selector overall. ChatGPT/Claude/etc. render
    // messages as sibling divs, so :last-of-type rarely matched what we wanted.
    response: {
      "chatgpt.com": '[data-message-author-role="assistant"] .markdown',
      "chat.openai.com": '[data-message-author-role="assistant"] .markdown',
      "claude.ai": '[data-testid="assistant-message"] .prose, [data-testid="assistant-message"]',
      "perplexity.ai": ".prose",
      "gemini.google.com": "model-response .response-content, model-response",
    },
    // User's last message (used as title)
    prompt: {
      "chatgpt.com": '[data-message-author-role="user"]',
      "chat.openai.com": '[data-message-author-role="user"]',
      "claude.ai": '[data-testid="user-message"]',
      "perplexity.ai": ".query-text",
      "gemini.google.com": "user-query .query-text, user-query",
    },
  };

  // ── Create FAB ────────────────────────────────────────────────────────────

  const fab = document.createElement("button");
  fab.id = "researchmap-fab";
  fab.innerHTML = `
    <svg class="rm-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="5" cy="5" r="2.5" stroke="white" stroke-width="1.5"/>
      <circle cx="15" cy="5" r="2.5" stroke="white" stroke-width="1.5"/>
      <circle cx="10" cy="15" r="2.5" stroke="white" stroke-width="1.5"/>
      <line x1="7.2" y1="6.2" x2="13" y2="6.2" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="6" y1="7" x2="9.2" y2="13" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
      <line x1="14" y1="7" x2="10.8" y2="13" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
    </svg>
    Guardar en grafo
  `;
  fab.title = "Guardar esta conversación en Constellation";

  const toast = document.createElement("div");
  toast.id = "researchmap-toast";

  document.body.appendChild(fab);
  document.body.appendChild(toast);

  // ── Save handler ──────────────────────────────────────────────────────────

  fab.addEventListener("click", async () => {
    fab.classList.add("rm-saving");
    fab.textContent = "Guardando…";

    const { responseText, promptText } = extractContent();

    if (!responseText) {
      showToast("Seleccioná el texto exacto que querés guardar.");
      fab.classList.remove("rm-saving");
      fab.innerHTML = getDefaultInner();
      return;
    }

    const title = promptText
      ? `${sourceName}: ${promptText.slice(0, 60)}${promptText.length > 60 ? "…" : ""}`
      : `${sourceName}: ${responseText.slice(0, 60)}${responseText.length > 60 ? "…" : ""}`;

    const contentSnippet = responseText.slice(0, 1500);

    chrome.runtime.sendMessage({
      type: "ADD_AI_OUTPUT",
      title,
      url: location.href,
      source: sourceName,
      contentSnippet,
    }, (res) => {
      if (!res?.ok) {
        const msg = res?.error === "no_topic"
          ? "Definí primero un tema de investigación en la extensión."
          : "No se pudo guardar el output seleccionado.";
        showToast(msg);
        fab.classList.remove("rm-saving");
        fab.innerHTML = getDefaultInner();
        return;
      }

      fab.classList.remove("rm-saving");
      fab.classList.add("rm-saved");
      fab.innerHTML = `✓ Guardado`;
      showToast(`"${title.slice(0, 50)}…" agregado al grafo`);

      setTimeout(() => {
        fab.classList.remove("rm-saved");
        fab.innerHTML = getDefaultInner();
      }, 2500);
    });
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function extractContent() {
    const promptSelector = SELECTORS.prompt[hostname];
    const pickLast = (sel) => {
      if (!sel) return null;
      const all = document.querySelectorAll(sel);
      return all.length ? all[all.length - 1] : null;
    };

    const selectionText = getSelectedText();
    const promptEl = pickLast(promptSelector);
    return {
      responseText: selectionText || "",
      promptText: promptEl?.innerText?.trim() || "",
    };
  }

  function getSelectedText() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return "";
    const text = selection.toString().trim();
    return text.length > 0 ? text : "";
  }

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("rm-visible");
    setTimeout(() => toast.classList.remove("rm-visible"), 3000);
  }

  function getDefaultInner() {
    return `
      <svg class="rm-icon" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="5" cy="5" r="2.5" stroke="white" stroke-width="1.5"/>
        <circle cx="15" cy="5" r="2.5" stroke="white" stroke-width="1.5"/>
        <circle cx="10" cy="15" r="2.5" stroke="white" stroke-width="1.2"/>
        <line x1="7.2" y1="6.2" x2="13" y2="6.2" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="6" y1="7" x2="9.2" y2="13" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
        <line x1="14" y1="7" x2="10.8" y2="13" stroke="white" stroke-width="1.2" stroke-linecap="round"/>
      </svg>
      Guardar en grafo
    `;
  }
})();
