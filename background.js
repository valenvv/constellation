// ResearchMap — background.js
// 3-layer architecture: full text (local) → dense summaries (LLM) → deep analysis (on-demand)

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = "gemini-2.5-flash";

// ── Fetch with retry for 429 rate limits ────────────────────────────────────

async function fetchRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, options);
      if (res.status === 429 && i < retries) {
        const wait = Math.min(2000 * (i + 1), 8000);
        console.warn(`[RM] 429 rate limited — retry ${i + 1}/${retries} in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (e) {
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
}

// ── State ────────────────────────────────────────────────────────────────────

let graph = { nodes: [], edges: [] };
let apiKey = null;
let researchTopic = null;

const stateReady = new Promise((resolve) => {
  chrome.storage.local.get(["graph", "geminiKey", "researchTopic"], (data) => {
    if (data.graph) graph = data.graph;
    if (data.geminiKey) apiKey = data.geminiKey;
    if (data.researchTopic) researchTopic = data.researchTopic;
    console.log("[RM] state loaded", {
      hasKey: Boolean(apiKey),
      nodes: graph.nodes?.length || 0,
      hasTopic: Boolean(researchTopic),
    });
    resolve();
  });
});

// ── Open sidebar when toolbar icon is clicked ────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Message router ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  stateReady.then(() => {
    switch (msg.type) {

      case "SET_API_KEY":
        apiKey = msg.apiKey;
        chrome.storage.local.set({ geminiKey: apiKey });
        console.log("[RM] API key saved", { hasKey: Boolean(apiKey) });
        sendResponse({ ok: true });
        break;

      case "GET_GRAPH":
        sendResponse({ graph });
        break;

      case "GET_TOPIC":
        sendResponse({ topic: researchTopic });
        break;

      case "SET_TOPIC":
        handleSetTopic(msg.title, msg.description).then((res) => sendResponse(res));
        break;

      case "CLEAR_GRAPH":
        clearGraph().then(() => sendResponse({ ok: true }));
        break;

      case "ADD_PAGE": {
        const windowId = sender?.tab?.windowId || null;
        handleAddNode({
          type: "page",
          title: msg.title,
          url: msg.url,
          source: safeHostname(msg.url),
          contentSnippet: msg.contentSnippet,
          fullText: msg.fullText || null,
          windowId,
        }).then((res) => sendResponse(res));
        break;
      }

      case "ADD_AI_OUTPUT":
        handleAddNode({
          type: "ai_output",
          title: msg.title,
          url: msg.url,
          source: msg.source,
          contentSnippet: msg.contentSnippet,
          fullText: msg.contentSnippet || null,
        }).then((res) => sendResponse(res));
        break;

      case "ADD_NOTE":
        handleAddNode({
          type: "note",
          title: msg.text.slice(0, 60) + (msg.text.length > 60 ? "…" : ""),
          url: null,
          source: "nota",
          contentSnippet: msg.text,
          fullText: msg.text,
        }).then((res) => sendResponse(res));
        break;

      case "DELETE_NODE":
        deleteNode(msg.nodeId);
        sendResponse({ ok: true });
        break;

      case "ANALYZE_GAPS":
        analyzeResearchGaps().then((res) => sendResponse(res));
        break;

      case "SUGGEST_SOURCES":
        suggestSources().then((res) => sendResponse(res));
        break;

      case "ASK_RESEARCH":
        askResearch(msg.question).then((res) => sendResponse(res));
        break;

      case "REANALYZE_ALL":
        reanalyzeWeakNodes().then((res) => sendResponse(res));
        break;

      default:
        sendResponse({ ok: false, error: "unknown_message_type" });
        break;
    }
  });
  return true;
});

// ── Full text storage (Layer 1) ─────────────────────────────────────────────

function storeFullText(nodeId, text) {
  if (!text) return;
  chrome.storage.local.set({ [`ft_${nodeId}`]: text });
}

function getFullText(nodeId) {
  return new Promise((resolve) => {
    chrome.storage.local.get(`ft_${nodeId}`, (data) => {
      resolve(data[`ft_${nodeId}`] || null);
    });
  });
}

function getFullTexts(nodeIds) {
  const keys = nodeIds.map((id) => `ft_${id}`);
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (data) => {
      const result = {};
      nodeIds.forEach((id) => {
        result[id] = data[`ft_${id}`] || null;
      });
      resolve(result);
    });
  });
}

function deleteFullText(nodeId) {
  chrome.storage.local.remove(`ft_${nodeId}`);
}

// ── Core logic ───────────────────────────────────────────────────────────────

async function handleAddNode(nodeData) {
  console.log("[RM] ── ADD ──", nodeData.type, `"${nodeData.title?.slice(0, 50)}"`, { url: nodeData.url?.slice(0, 60), hasKey: Boolean(apiKey) });

  if (nodeData.url && graph.nodes.find((n) => n.url === nodeData.url)) {
    console.log("[RM]   skip: duplicate URL");
    return { ok: false, error: "duplicate" };
  }

  const node = {
    id: crypto.randomUUID(),
    type: nodeData.type,
    title: nodeData.title,
    url: nodeData.url,
    source: nodeData.source,
    contentSnippet: nodeData.contentSnippet,
    windowId: nodeData.windowId || null,
    summary: null,
    concepts: [],
    embedding: null,
    timestamp: Date.now(),
  };

  // Layer 1: store full text locally (free)
  if (nodeData.fullText) {
    storeFullText(node.id, nodeData.fullText);
    console.log("[RM]   full text stored:", (nodeData.fullText.length / 1024).toFixed(1), "KB");
  }

  graph.nodes.push(node);
  persistGraph();
  broadcastGraph();
  console.log("[RM]   node added — total:", graph.nodes.length);

  // Layer 2: generate dense summary async (non-blocking)
  if (apiKey) {
    setTimeout(() => generateDenseSummary(node.id), 500);
  } else {
    node.concepts = fallbackConcepts(node.title, node.contentSnippet);
    rebuildEdges();
    persistGraph();
    broadcastGraph();
  }

  return { ok: true };
}

async function generateDenseSummary(nodeId) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || !apiKey) return;

  console.log("[RM]   [summary] generating for:", node.title?.slice(0, 40));

  // Use full text if available, otherwise snippet
  let content = await getFullText(nodeId);
  if (!content) content = node.contentSnippet || node.title;

  const topicCtx = researchTopic
    ? `\nCONTEXTO DE INVESTIGACION: "${researchTopic.title}" — ${researchTopic.description}`
    : "";

  const prompt = `Summarize this web page for a research knowledge graph.${topicCtx}

PAGE TITLE: ${node.title}
SOURCE: ${node.source}
CONTENT:
${content.slice(0, 8000)}

Write a DENSE, information-rich paragraph (150-250 words, in Spanish) that captures:
- The main argument, finding, or purpose
- Key evidence, data, or methodology
- Important claims, conclusions, or implications
- Specific names, terms, or concepts

Do NOT write a generic overview. Pack specific, factual information — every sentence should add new information.

Also extract 8-12 key concepts as lowercase strings (1-3 words each). Include BOTH English AND Spanish versions of each concept.

Return JSON (no markdown):
{"summary": "dense paragraph here", "concepts": ["concept_en", "concepto_es", ...]}`;

  const result = await callGeminiJSON(prompt, 2048);

  if (result && typeof result === "object" && !Array.isArray(result)) {
    if (typeof result.summary === "string" && result.summary.length > 30) {
      node.summary = result.summary;
    }
    if (Array.isArray(result.concepts) && result.concepts.length > 0) {
      node.concepts = result.concepts.filter((c) => typeof c === "string").slice(0, 16);
    }
    console.log("[RM]   [summary] ok:", node.concepts.length, "concepts,", (node.summary || "").length, "chars");
  } else {
    console.log("[RM]   [summary] LLM failed, using fallback");
    node.concepts = fallbackConcepts(node.title, node.contentSnippet);
  }

  rebuildEdges();
  persistGraph();
  broadcastGraph();

  // Get embedding after summary (staggered to avoid rate limits)
  setTimeout(() => generateEmbedding(nodeId), 2000);
}

async function generateEmbedding(nodeId) {
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node || !apiKey) return;

  const text = `${node.title} ${node.summary || node.contentSnippet || ""}`.slice(0, 2000);
  const emb = await getEmbedding(text);
  if (emb) {
    node.embedding = emb;
    rebuildEdges();
    persistGraph();
    broadcastGraph();
    console.log("[RM]   [embedding] ok for:", node.title?.slice(0, 30));
  }
}

function deleteNode(nodeId) {
  deleteFullText(nodeId);
  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
  rebuildEdges();
  persistGraph();
  broadcastGraph();
}

async function clearGraph() {
  // Clean up full text storage for all nodes
  const keys = graph.nodes.map((n) => `ft_${n.id}`);
  if (keys.length > 0) {
    await new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  }
  graph = { nodes: [], edges: [] };
  persistGraph();
  broadcastGraph();
}

// ── Edge building ────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the","a","an","and","or","of","in","on","at","to","for","by","with","from","as","is","are",
  "was","were","be","been","being","that","this","these","those","it","its","his","her","their",
  "our","your","my","i","we","you","he","she","they","them","us","not","but","if","then","so",
  "el","la","los","las","un","una","unos","unas","de","del","y","o","u","en","con","por","para",
  "que","es","son","fue","ser","esto","este","esa","ese","sus","al","si","no","como","mas",
  "about","more","also","can","will","has","have","had","do","does","did","just","when","how",
  "all","each","than","only","get","new","use","used","using","entre","sobre","puede","tiene",
  "esta","donde","cuando","todo","cada","otro","otra","muy","bien","hay","hacer",
]);

function rebuildEdges() {
  const nodes = graph.nodes;
  if (nodes.length < 2) { graph.edges = []; return; }

  const prevReasons = {};
  graph.edges.forEach((e) => {
    if (e._enriched && e.reason) prevReasons[e.id] = e.reason;
  });

  // Expand concepts per node
  nodes.forEach((n) => {
    const expanded = new Set();
    (n.concepts || []).forEach((c) => {
      const norm = normalizeText(c);
      if (!norm) return;
      expanded.add(norm);
      if (norm.includes(" ")) {
        norm.split(" ").forEach((tok) => {
          if (tok.length > 3 && !STOPWORDS.has(tok)) expanded.add(tok);
        });
      }
    });
    n._exp = Array.from(expanded);
  });

  // Document frequency for TF-IDF
  const docFreq = {};
  nodes.forEach((n) => {
    new Set(n._exp || []).forEach((c) => { docFreq[c] = (docFreq[c] || 0) + 1; });
  });
  const N = nodes.length;

  const edges = [];
  for (let i = 0; i < nodes.length; i++) {
    const setA = new Set(nodes[i]._exp || []);
    for (let j = i + 1; j < nodes.length; j++) {
      const setB = new Set(nodes[j]._exp || []);

      const maxRatio = N <= 6 ? 0.95 : N <= 15 ? 0.8 : 0.6;
      const shared = [...setA].filter((c) => setB.has(c) && (docFreq[c] || 0) / N <= maxRatio);

      const embSim = (nodes[i].embedding && nodes[j].embedding)
        ? cosineSimilarity(nodes[i].embedding, nodes[j].embedding) : 0;

      if (shared.length < 2 && embSim < 0.55) continue;

      const tfidf = shared.reduce((sum, c) => sum + Math.log(N / (docFreq[c] || 1)), 0);
      const weight = Math.round((tfidf + (embSim > 0.5 ? embSim * 3 : 0)) * 10) / 10;

      let reason;
      if (shared.length === 0) {
        reason = `Conexion semantica (${Math.round(embSim * 100)}% similitud)`;
      } else {
        const phrases = shared.filter((c) => c.includes(" ")).slice(0, 3);
        const tokens = shared.filter((c) => !c.includes(" ")).slice(0, 3 - phrases.length);
        const terms = [...phrases, ...tokens];
        const extra = shared.length > terms.length ? ` (+${shared.length - terms.length})` : "";
        reason = `Temas en comun: ${terms.join(", ")}${extra}`;
      }

      const edgeId = `${nodes[i].id}__${nodes[j].id}`;
      edges.push({
        id: edgeId,
        source: nodes[i].id,
        target: nodes[j].id,
        sharedConcepts: shared,
        weight,
        reason: prevReasons[edgeId] || reason,
        _enriched: Boolean(prevReasons[edgeId]),
      });
    }
  }

  nodes.forEach((n) => delete n._exp);
  graph.edges = edges;
  console.log("[RM] edges:", edges.length);
}

// ── Deep analysis — Layer 3 (uses full text on-demand) ──────────────────────

async function askResearch(question) {
  if (graph.nodes.length < 2) return { ok: false, error: "too_few_nodes", minNodes: 2 };
  if (!apiKey) return { ok: false, error: "no_api_key" };

  // Get full text for all nodes (deep context)
  const allIds = graph.nodes.map((n) => n.id);
  const fullTexts = await getFullTexts(allIds);

  const sourcesCtx = graph.nodes.map((n, i) => {
    const ft = fullTexts[n.id];
    const content = ft ? ft.slice(0, 3000) : (n.summary || n.contentSnippet || "").slice(0, 500);
    return `[${i + 1}] "${n.title}" (${n.source}):\n${content}`;
  }).join("\n\n");

  const topicCtx = researchTopic
    ? `TEMA DE INVESTIGACION: ${researchTopic.title} — ${researchTopic.description}\n\n`
    : "";

  const prompt = `Sos un asistente de investigacion. Responde esta pregunta basandote SOLO en las fuentes proporcionadas. Cita fuentes por numero [1], [2], etc. Si las fuentes no tienen suficiente informacion, decilo y sugeri que buscar.

${topicCtx}FUENTES:
${sourcesCtx}

PREGUNTA: ${question}

Responde en español, 2-4 parrafos. Se especifico, analitico, y cita fuentes.`;

  const answer = await callGeminiRaw(prompt, 1500);
  if (!answer) return { ok: false, error: "ask_failed" };

  const citedIndices = [...answer.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1]) - 1);
  const sources = [...new Set(citedIndices)]
    .filter((i) => i >= 0 && i < graph.nodes.length)
    .map((i) => ({ title: graph.nodes[i].title, url: graph.nodes[i].url }));

  return { ok: true, answer, sources };
}

async function analyzeResearchGaps() {
  if (!researchTopic) return { ok: false, error: "no_topic" };
  if (graph.nodes.length < 5) return { ok: false, error: "too_few_nodes", minNodes: 5 };
  if (!apiKey) return { ok: false, error: "no_api_key" };

  // Use summaries for gap analysis
  const nodesSummary = graph.nodes.map((n) =>
    `- "${n.title}": ${n.summary || n.contentSnippet || "(sin resumen)"}`
  ).slice(0, 20).join("\n");

  const concepts = [...new Set(graph.nodes.flatMap((n) => n.concepts || []))].slice(0, 30).join(", ");

  const prompt = `Sos un asesor de investigacion. Analiza esta investigacion e identifica 3-5 vacios importantes, perspectivas faltantes o subtemas poco explorados.

Tema: ${researchTopic.title} — ${researchTopic.description}
Fuentes:
${nodesSummary}
Conceptos: ${concepts}

Devuelve SOLO un JSON array de objetos con:
- "gap": titulo corto del vacio (max 10 palabras)
- "why": por que importa (1-2 oraciones)
- "searchQuery": query de Google Scholar para llenar este vacio

Sin markdown, sin explicacion fuera del JSON.`;

  const result = await callGeminiJSON(prompt, 2048);
  if (!Array.isArray(result)) return { ok: false, error: "analysis_failed" };

  const conceptFreq = {};
  graph.nodes.forEach((n) => (n.concepts || []).forEach((c) => {
    const norm = normalizeText(c);
    if (norm) conceptFreq[norm] = (conceptFreq[norm] || 0) + 1;
  }));

  return {
    ok: true,
    gaps: result.slice(0, 5),
    stats: {
      totalNodes: graph.nodes.length,
      totalConcepts: Object.keys(conceptFreq).length,
      wellCovered: Object.values(conceptFreq).filter((f) => f >= 3).length,
      barelyCovered: Object.values(conceptFreq).filter((f) => f === 1).length,
    },
  };
}

async function suggestSources() {
  if (!researchTopic) return { ok: false, error: "no_topic" };
  if (graph.nodes.length < 3) return { ok: false, error: "too_few_nodes", minNodes: 3 };
  if (!apiKey) return { ok: false, error: "no_api_key" };

  const nodesSummary = graph.nodes.slice(0, 15).map((n) => `${n.title} (${n.type})`).join("; ");
  const concepts = [...new Set(graph.nodes.flatMap((n) => n.concepts || []))].slice(0, 20).join(", ");

  const prompt = `Sos un asesor de investigacion. Sugeri 3-5 nuevas direcciones, papers o temas para explorar que complementen esta investigacion.

Tema: ${researchTopic.title} — ${researchTopic.description}
Fuentes actuales: ${nodesSummary}
Conceptos clave: ${concepts}

Devuelve SOLO un JSON array de objetos con:
- "title": nombre del tema sugerido (max 12 palabras)
- "why": por que seria valioso (1-2 oraciones)
- "searchQuery": query de Google Scholar

Sin markdown.`;

  const result = await callGeminiJSON(prompt, 2048);
  if (!Array.isArray(result)) return { ok: false, error: "suggestion_failed" };
  return { ok: true, suggestions: result.slice(0, 5) };
}

// ── Re-analyze weak nodes ───────────────────────────────────────────────────

async function reanalyzeWeakNodes() {
  if (!apiKey) return { ok: false, error: "no_api_key" };

  const weakNodes = graph.nodes.filter((n) => {
    if (!n.summary || n.summary.length < 50) return true;
    if (!n.concepts || n.concepts.length < 4) return true;
    return false;
  });

  if (weakNodes.length === 0) return { ok: true, reanalyzed: 0 };

  console.log("[RM] reanalyzing", weakNodes.length, "weak nodes");
  let count = 0;

  for (const node of weakNodes) {
    await generateDenseSummary(node.id);
    if (node.summary && node.summary.length > 50) count++;
    await new Promise((r) => setTimeout(r, 1500));
  }

  return { ok: true, reanalyzed: count };
}

// ── Topic management ────────────────────────────────────────────────────────

async function handleSetTopic(title, description) {
  const cleanTitle = (title || "").trim();
  const cleanDesc = (description || "").trim();
  if (!cleanTitle || !cleanDesc) return { ok: false, error: "invalid_topic" };

  researchTopic = {
    title: cleanTitle,
    description: cleanDesc,
    timestamp: Date.now(),
  };
  chrome.storage.local.set({ researchTopic });
  console.log("[RM] topic set:", cleanTitle);

  // Re-summarize existing nodes with topic context (background, non-blocking)
  if (apiKey && graph.nodes.length > 0) {
    setTimeout(() => {
      console.log("[RM] re-summarizing nodes with topic context");
      reanalyzeWeakNodes();
    }, 1000);
  }

  return { ok: true, topic: researchTopic };
}

// ── Gemini API callers ──────────────────────────────────────────────────────

async function callGeminiRaw(message, maxTokens = 4096) {
  if (!apiKey) return null;
  try {
    const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent`;
    const headers = { "Content-Type": "application/json" };
    if (/^AIza[0-9A-Za-z_\-]{20,}$/.test(apiKey)) headers["x-goog-api-key"] = apiKey;
    else headers["Authorization"] = `Bearer ${apiKey}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const res = await fetchRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[RM] Gemini HTTP ${res.status}:`, errText.slice(0, 200));
      return null;
    }

    const data = await res.json();
    const finish = data?.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") console.warn("[RM] Gemini finishReason:", finish);
    const text = (data?.candidates?.[0]?.content?.parts
      ?.filter((p) => !p.thought)
      ?.map((p) => p.text)
      .filter(Boolean)
      .join("") || "").trim();
    return text || null;
  } catch (e) {
    console.warn("[RM] Gemini error:", e.message);
    return null;
  }
}

async function callGeminiJSON(message, maxTokens = 16384) {
  if (!apiKey) return null;
  try {
    const url = `${GEMINI_API_URL}/${GEMINI_MODEL}:generateContent`;
    const headers = { "Content-Type": "application/json" };
    if (/^AIza[0-9A-Za-z_\-]{20,}$/.test(apiKey)) headers["x-goog-api-key"] = apiKey;
    else headers["Authorization"] = `Bearer ${apiKey}`;

    const body = {
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.2,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    };

    const res = await fetchRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.warn(`[RM] GeminiJSON HTTP ${res.status}:`, errText.slice(0, 300));
      return null;
    }

    const data = await res.json();
    const finish = data?.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") console.warn("[RM] GeminiJSON finishReason:", finish);
    const text = (data?.candidates?.[0]?.content?.parts
      ?.filter((p) => !p.thought)
      ?.map((p) => p.text)
      .filter(Boolean)
      .join("") || "").trim();

    if (!text) {
      console.warn("[RM] GeminiJSON: empty response", JSON.stringify(data).slice(0, 300));
      return null;
    }

    try {
      return JSON.parse(text);
    } catch (parseErr) {
      console.warn("[RM] GeminiJSON parse failed:", parseErr.message, "raw:", text.slice(0, 500));
      const cleaned = text.replace(/```json|```/g, "").trim();
      try { return JSON.parse(cleaned); } catch { return null; }
    }
  } catch (e) {
    console.warn("[RM] GeminiJSON error:", e.message);
    return null;
  }
}

// ── Embeddings (Gemini text-embedding-004) ──────────────────────────────────

async function getEmbedding(text) {
  if (!apiKey) return null;
  try {
    const url = `${GEMINI_API_URL}/text-embedding-004:embedContent`;
    const headers = { "Content-Type": "application/json" };
    if (/^AIza[0-9A-Za-z_\-]{20,}$/.test(apiKey)) headers["x-goog-api-key"] = apiKey;
    else headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetchRetry(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: { parts: [{ text: text.slice(0, 2000) }] } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.embedding?.values || null;
  } catch { return null; }
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Fallback concepts (no API key) ──────────────────────────────────────────

function fallbackConcepts(title, content) {
  const full = normalizeText(`${title || ""} ${(content || "").slice(0, 1000)}`);
  const words = full.split(" ").filter((w) => w.length > 3 && !STOPWORDS.has(w));
  const concepts = new Set();

  // Bigrams from title
  const titleWords = normalizeText(title || "").split(" ").filter((w) => w.length > 3 && !STOPWORDS.has(w));
  for (let i = 0; i < titleWords.length - 1; i++) {
    concepts.add(`${titleWords[i]} ${titleWords[i + 1]}`);
  }

  // Top words by frequency
  const freq = {};
  words.forEach((w) => { freq[w] = (freq[w] || 0) + 1; });
  Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([w]) => concepts.add(w));

  return [...concepts].slice(0, 10);
}

// ── Text utilities ──────────────────────────────────────────────────────────

function normalizeText(s) {
  if (!s) return "";
  return s.toString().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/["'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function safeHostname(url) {
  try { return new URL(url).hostname.replace("www.", ""); }
  catch { return "web"; }
}

// ── Persistence ─────────────────────────────────────────────────────────────

function persistGraph() {
  chrome.storage.local.set({ graph });
}

function broadcastGraph() {
  chrome.runtime.sendMessage({ type: "GRAPH_UPDATED", graph }).catch(() => {});
}
