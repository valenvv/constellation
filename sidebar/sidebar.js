// ResearchMap — sidebar.js
// Renders the D3 force graph and manages all sidebar UI interactions.

// ── State ─────────────────────────────────────────────────────────────────

let graph = { nodes: [], edges: [] };
let simulation = null;
let selectedNode = null;
let currentFilter = "all";
let researchTopic = null;

// Chat state
let chatHistory = [];

// Graph filters
let graphFilterType = "all";
let graphFilterSource = "all";

// ── Init ──────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  loadGraph();
  loadTopic();
  setupTabs();
  setupNoteBar();
  setupSettings();
  setupExport();
  setupClear();
  setupListFilters();
  setupDetailPanel();
  setupChat();
  setupTopicGate();
  setupGraphFabs();
  setupGraphFilters();

  // Re-render on resize so the simulation re-centres if the side panel changes size
  window.addEventListener("resize", () => {
    if (graph.nodes.length > 0) renderGraph();
  });

  // Listen for graph updates from background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "GRAPH_UPDATED") {
      graph = msg.graph;
      renderGraph();
      renderList();
    }
  });

  // Load saved API key hint
  chrome.storage.local.get(["geminiKey"], (data) => {
    if (data.geminiKey) {
      document.getElementById("input-apikey").value = "••••••••••••";
      document.getElementById("key-status").textContent = "✓ Clave guardada";
    }
  });
});

function loadGraph() {
  chrome.runtime.sendMessage({ type: "GET_GRAPH" }, (res) => {
    if (res?.graph) {
      graph = res.graph;
      renderGraph();
      renderList();
    }
  });
}

function loadTopic() {
  chrome.runtime.sendMessage({ type: "GET_TOPIC" }, (res) => {
    researchTopic = res?.topic || null;
    updateTopicUI();
  });
}

// ── D3 Force Graph ────────────────────────────────────────────────────────

function renderGraph() {
  // Defer one frame so the side-panel layout is settled and the SVG has real dimensions.
  // Without this, on first open the container width/height is 0 and the simulation centres at (0,0).
  requestAnimationFrame(() => doRenderGraph());
}

function doRenderGraph() {
  const svg = d3.select("#graph-svg");
  svg.selectAll("*").remove();

  const empty = document.getElementById("graph-empty");
  if (graph.nodes.length === 0) {
    empty.style.display = "flex";
    return;
  }
  empty.style.display = "none";
  updateSourceFilter();

  const container = document.getElementById("graph-container");
  // Fallbacks in case the container hasn't been laid out yet
  const W = container.clientWidth || container.getBoundingClientRect().width || 320;
  const H = container.clientHeight || container.getBoundingClientRect().height || 400;

  svg.attr("viewBox", `0 0 ${W} ${H}`).attr("preserveAspectRatio", "xMidYMid meet");

  const g = svg.append("g");

  // Zoom + pan
  svg.call(
    d3.zoom()
      .scaleExtent([0.3, 3])
      .on("zoom", (event) => g.attr("transform", event.transform))
  );

  // Apply filters
  const filteredNodes = graph.nodes.filter((n) => {
    if (graphFilterType !== "all" && n.type !== graphFilterType) return false;
    if (graphFilterSource !== "all" && n.source !== graphFilterSource) return false;
    return true;
  });
  const filteredIds = new Set(filteredNodes.map((n) => n.id));

  const nodes = filteredNodes.map((n) => ({ ...n }));
  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

  // Compute degree (number of connections) per node for sizing
  const degree = {};
  graph.edges.forEach((e) => {
    degree[e.source] = (degree[e.source] || 0) + 1;
    degree[e.target] = (degree[e.target] || 0) + 1;
  });
  nodes.forEach((n) => { n._degree = degree[n.id] || 0; });

  const links = graph.edges
    .filter((e) => filteredIds.has(e.source) && filteredIds.has(e.target))
    .map((e) => ({
      ...e,
      source: nodeById[e.source],
      target: nodeById[e.target],
    }))
    .filter((e) => e.source && e.target);

  // Cluster hulls — will be updated on tick
  const CLUSTER_COLORS = [
    { fill: "rgba(83,74,183,0.08)", stroke: "rgba(83,74,183,0.25)" },
    { fill: "rgba(29,158,117,0.08)", stroke: "rgba(29,158,117,0.25)" },
    { fill: "rgba(186,117,23,0.08)", stroke: "rgba(186,117,23,0.25)" },
    { fill: "rgba(153,60,29,0.08)", stroke: "rgba(153,60,29,0.25)" },
    { fill: "rgba(66,133,244,0.08)", stroke: "rgba(66,133,244,0.25)" },
    { fill: "rgba(234,67,53,0.08)", stroke: "rgba(234,67,53,0.25)" },
  ];

  const clusterIds = [...new Set(nodes.map((n) => n.cluster ?? 0))];
  const hullGroup = g.append("g").attr("class", "cluster-hulls");
  const hullPaths = {};

  if (clusterIds.length > 1) {
    clusterIds.forEach((cid) => {
      const color = CLUSTER_COLORS[cid % CLUSTER_COLORS.length];
      hullPaths[cid] = hullGroup.append("path")
        .attr("class", "cluster-hull")
        .attr("fill", color.fill)
        .attr("stroke", color.stroke);
    });
  }

  function updateHulls() {
    if (clusterIds.length <= 1) return;
    clusterIds.forEach((cid) => {
      const pts = nodes.filter((n) => (n.cluster ?? 0) === cid).map((n) => [n.x, n.y]);
      if (pts.length < 3) {
        if (hullPaths[cid]) hullPaths[cid].attr("d", "");
        return;
      }
      const hull = d3.polygonHull(pts);
      if (hull && hullPaths[cid]) {
        const pad = 22;
        const cx = d3.mean(hull, (p) => p[0]);
        const cy = d3.mean(hull, (p) => p[1]);
        const expanded = hull.map((p) => {
          const dx = p[0] - cx, dy = p[1] - cy;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          return [p[0] + (dx / len) * pad, p[1] + (dy / len) * pad];
        });
        hullPaths[cid].attr("d", "M" + expanded.join("L") + "Z");
      }
    });
  }

  // Compute weight percentile to hide weak edges when graph is large
  const weights = links.map((l) => l.weight || 0).sort((a, b) => a - b);
  const medianWeight = weights.length > 0 ? weights[Math.floor(weights.length / 2)] : 0;
  const maxWeight = weights.length > 0 ? weights[weights.length - 1] : 1;

  // Force simulation — strong edges pull closer, weak push farther
  simulation = d3
    .forceSimulation(nodes)
    .force("link", d3.forceLink(links).id((d) => d.id)
      .distance((d) => maxWeight > 0 ? 140 - 60 * ((d.weight || 0) / maxWeight) : 80)
    )
    .force("charge", d3.forceManyBody().strength(-250))
    .force("center", d3.forceCenter(W / 2, H / 2))
    .force("collision", d3.forceCollide(32));

  // Draw edges — opacity proportional to weight
  const linkGroup = g.append("g");

  // Invisible wider hit area so edges are easy to hover/click
  const linkHit = linkGroup
    .selectAll("line.graph-link-hit")
    .data(links)
    .join("line")
    .attr("class", "graph-link-hit")
    .attr("stroke", "transparent")
    .attr("stroke-width", 14);

  // Visible edge lines
  const link = linkGroup
    .selectAll("line.graph-link")
    .data(links)
    .join("line")
    .attr("class", "graph-link")
    .attr("stroke-width", (d) => maxWeight > 0 ? 1 + 2.5 * ((d.weight || 0) / maxWeight) : 1.5)
    .attr("stroke-opacity", (d) => {
      if (links.length <= 10) return 0.55;
      return maxWeight > 0 ? 0.2 + 0.55 * ((d.weight || 0) / maxWeight) : 0.4;
    });

  const edgeTooltip = getEdgeTooltip();
  const edgeEvents = (sel) => sel
    .on("mousemove", (event, d) => {
      showEdgeTooltip(edgeTooltip, formatEdgeReason(d), event);
    })
    .on("mouseout", () => hideEdgeTooltip(edgeTooltip))
    .on("click", (event, d) => {
      event.stopPropagation();
      showEdgeTooltip(edgeTooltip, formatEdgeReason(d), event);
    });
  edgeEvents(link);
  edgeEvents(linkHit);

  // Draw nodes
  const node = g
    .append("g")
    .selectAll("g")
    .data(nodes)
    .join("g")
    .attr("class", (d) => `graph-node node-${d.type}`)
    .call(drag(simulation))
    .on("click", (event, d) => {
      event.stopPropagation();
      showDetail(d);
    });

  node.append("circle").attr("r", (d) => nodeRadius(d));

  node
    .append("text")
    .attr("dy", (d) => nodeRadius(d) + 11)
    .text((d) => truncate(d.title, 18));

  // Dismiss detail when clicking canvas (only if the click is on the svg background, not bubbled from a node)
  svg.on("click", (event) => {
    if (event.target === svg.node()) hideDetail();
  });

  // Tick
  simulation.on("tick", () => {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    linkHit
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    updateHulls();
  });
}

function nodeRadius(d) {
  const base = { page: 14, ai_output: 13, note: 11 };
  const deg = Math.min(d._degree || 0, 8);
  return (base[d.type] || 12) + deg * 0.8;
}

function drag(sim) {
  return d3
    .drag()
    .on("start", (event, d) => {
      if (!event.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    });
}

// ── Node detail panel ─────────────────────────────────────────────────────

function showDetail(nodeData) {
  selectedNode = nodeData;
  const panel = document.getElementById("node-detail");

  const badge = document.getElementById("detail-source-badge");
  badge.textContent = nodeData.source || nodeData.type;
  badge.className = `source-badge badge-${nodeData.type}`;

  document.getElementById("detail-title").textContent = nodeData.title;
  document.getElementById("detail-snippet").textContent =
    nodeData.summary || nodeData.contentSnippet?.slice(0, 200) || "";

  const conceptsEl = document.getElementById("detail-concepts");
  conceptsEl.innerHTML = "";
  (nodeData.concepts || []).forEach((c) => {
    const span = document.createElement("span");
    span.className = "concept-tag";
    span.textContent = c;
    conceptsEl.appendChild(span);
  });

  const linkEl = document.getElementById("detail-link");
  if (nodeData.url) {
    linkEl.href = nodeData.url;
    linkEl.style.display = "inline";
  } else {
    linkEl.style.display = "none";
  }

  panel.style.display = "flex";
}

function hideDetail() {
  document.getElementById("node-detail").style.display = "none";
  selectedNode = null;
}

function setupDetailPanel() {
  document.getElementById("btn-close-detail").addEventListener("click", hideDetail);

  document.getElementById("btn-delete-node").addEventListener("click", () => {
    if (!selectedNode) return;
    chrome.runtime.sendMessage({ type: "DELETE_NODE", nodeId: selectedNode.id });
    hideDetail();
  });
}

// ── List tab ──────────────────────────────────────────────────────────────

function renderList() {
  const ul = document.getElementById("node-list");
  ul.innerHTML = "";

  const filtered =
    currentFilter === "all"
      ? graph.nodes
      : graph.nodes.filter((n) => n.type === currentFilter);

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.style.cssText = "padding:20px 14px; color: var(--text-faint); font-size:12px;";
    li.textContent = "Sin nodos para mostrar.";
    ul.appendChild(li);
    return;
  }

  // Sort newest first
  [...filtered]
    .sort((a, b) => b.timestamp - a.timestamp)
    .forEach((node) => {
      const li = document.createElement("li");
      li.className = "node-list-item";

      const dot = document.createElement("div");
      dot.className = `node-dot dot-${node.type}`;

      const content = document.createElement("div");
      content.className = "node-list-content";

      const titleDiv = document.createElement("div");
      titleDiv.className = "node-list-title";
      titleDiv.textContent = node.title;

      const meta = document.createElement("div");
      meta.className = "node-list-meta";
      meta.textContent = `${node.source} · ${timeAgo(node.timestamp)}`;

      content.appendChild(titleDiv);
      content.appendChild(meta);
      li.appendChild(dot);
      li.appendChild(content);

      li.addEventListener("click", () => {
        switchTab("graph");
        setTimeout(() => showDetail(node), 100);
      });
      ul.appendChild(li);
    });
}

function setupListFilters() {
  document.querySelectorAll(".filter-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach((c) =>
        c.classList.remove("active")
      );
      chip.classList.add("active");
      currentFilter = chip.dataset.filter;
      renderList();
    });
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });
}

function switchTab(tabId) {
  document.querySelectorAll(".tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.style.display = p.id === `tab-${tabId}` ? "flex" : "none";
  });
  const noteBar = document.querySelector(".note-bar");
  if (noteBar) noteBar.style.display = (tabId === "settings" || tabId === "chat") ? "none" : "flex";
  if (tabId === "list") renderList();
  if (tabId === "graph") { updateSourceFilter(); renderGraph(); }
}

// ── Note bar ──────────────────────────────────────────────────────────────

function setupNoteBar() {
  const input = document.getElementById("note-input");
  const btn = document.getElementById("btn-add-note");

  const submit = () => {
    const text = input.value.trim();
    if (!text) return;
    chrome.runtime.sendMessage({ type: "ADD_NOTE", text });
    input.value = "";
  };

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// ── Settings ──────────────────────────────────────────────────────────────

function setupSettings() {
  document.getElementById("btn-save-key").addEventListener("click", () => {
    const keyEl = document.getElementById("input-apikey");
    const key = keyEl.value.trim();
    if (!key || key.includes("•")) return;
    chrome.runtime.sendMessage({ type: "SET_API_KEY", apiKey: key }, (res) => {
      if (res?.ok) {
        document.getElementById("key-status").textContent = "✓ Clave guardada";
        keyEl.value = "••••••••••••";
      } else {
        document.getElementById("key-status").textContent = "Error guardando clave";
      }
    });
  });

  document.getElementById("btn-reanalyze").addEventListener("click", () => {
    const btn = document.getElementById("btn-reanalyze");
    const status = document.getElementById("reanalyze-status");
    btn.disabled = true;
    status.textContent = "Re-analizando...";
    chrome.runtime.sendMessage({ type: "REANALYZE_ALL" }, (res) => {
      btn.disabled = false;
      if (res?.ok) {
        status.textContent = res.reanalyzed > 0
          ? `${res.reanalyzed} nodo(s) re-analizados.`
          : "Todos los nodos ya tienen buenos conceptos.";
      } else {
        status.textContent = res?.error === "no_api_key"
          ? "Configura una API key primero."
          : "Error al re-analizar.";
      }
    });
  });
}

// ── Topic gate ───────────────────────────────────────────────────────────

function setupTopicGate() {
  document.getElementById("btn-edit-topic").addEventListener("click", () => {
    openTopicGate();
  });

  document.getElementById("btn-save-topic").addEventListener("click", () => {
    const titleEl = document.getElementById("topic-title");
    const descEl = document.getElementById("topic-desc");
    const statusEl = document.getElementById("topic-status");
    const title = titleEl.value.trim();
    const description = descEl.value.trim();

    if (!title || !description) {
      statusEl.textContent = "Completa titulo y descripcion.";
      return;
    }

    statusEl.textContent = "Guardando...";
    chrome.runtime.sendMessage(
      { type: "SET_TOPIC", title, description },
      (res) => {
        if (!res?.ok) {
          statusEl.textContent = "No se pudo guardar el tema.";
          return;
        }
        researchTopic = res.topic;
        statusEl.textContent = "Tema guardado.";
        updateTopicUI();
        setTimeout(() => {
          closeTopicGate();
          statusEl.textContent = "";
        }, 400);
      }
    );
  });
}

function updateTopicUI() {
  const gate = document.getElementById("topic-gate");
  const summary = document.getElementById("topic-summary");
  const editBtn = document.getElementById("btn-edit-topic");
  const noteInput = document.getElementById("note-input");
  const noteBtn = document.getElementById("btn-add-note");

  if (researchTopic?.title) {
    gate.style.display = "none";
    summary.textContent = `${researchTopic.title} — ${researchTopic.description.slice(0, 90)}${researchTopic.description.length > 90 ? "…" : ""}`;
    editBtn.style.display = "inline-flex";
    noteInput.disabled = false;
    noteBtn.disabled = false;
    noteInput.placeholder = "Agregar nota rapida...";
  } else {
    summary.textContent = "No definido (opcional — las paginas se capturan igual).";
    editBtn.style.display = "inline-flex";
    noteInput.disabled = false;
    noteBtn.disabled = false;
    noteInput.placeholder = "Agregar nota rapida...";
    // Don't block the UI — topic is optional, pages capture automatically
    gate.style.display = "none";
  }
}

function openTopicGate() {
  const gate = document.getElementById("topic-gate");
  const titleEl = document.getElementById("topic-title");
  const descEl = document.getElementById("topic-desc");
  if (researchTopic) {
    titleEl.value = researchTopic.title || "";
    descEl.value = researchTopic.description || "";
  }
  gate.style.display = "flex";
}

function closeTopicGate() {
  const gate = document.getElementById("topic-gate");
  gate.style.display = "none";
}

// ── Export ────────────────────────────────────────────────────────────────

function setupExport() {
  const doExport = () => {
    const json = JSON.stringify(graph, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `researchmap-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  document.getElementById("btn-export").addEventListener("click", doExport);
  document.getElementById("btn-export-settings").addEventListener("click", doExport);
}

// ── Clear ─────────────────────────────────────────────────────────────────

function setupClear() {
  document.getElementById("btn-clear").addEventListener("click", () => {
    if (confirm("¿Borrar todo el grafo? Esta acción no se puede deshacer.")) {
      chrome.runtime.sendMessage({ type: "CLEAR_GRAPH" });
    }
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────

function truncate(str, max) {
  return str?.length > max ? str.slice(0, max) + "…" : str || "";
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
}

function formatEdgeReason(edge) {
  if (edge.reason) return edge.reason;
  const shared = Array.isArray(edge.sharedConcepts) ? edge.sharedConcepts : [];
  if (!shared.length) return "Contenido tematicamente relacionado.";
  const phrases = shared.filter((c) => c.includes(" ")).slice(0, 3);
  const singles = shared.filter((c) => !c.includes(" ")).slice(0, 3 - phrases.length);
  const shown = [...phrases, ...singles];
  const extra = shared.length > shown.length ? ` (+${shared.length - shown.length} mas)` : "";
  return `Temas en comun: ${shown.join(", ")}${extra}`;
}

function getEdgeTooltip() {
  let el = document.getElementById("edge-tooltip");
  if (el) return el;
  const container = document.getElementById("graph-container");
  el = document.createElement("div");
  el.id = "edge-tooltip";
  el.className = "edge-tooltip";
  container.appendChild(el);
  return el;
}

function showEdgeTooltip(el, text, event) {
  const container = document.getElementById("graph-container");
  const rect = container.getBoundingClientRect();
  const x = event.clientX - rect.left + 10;
  const y = event.clientY - rect.top + 10;
  el.textContent = text;
  el.style.transform = `translate(${x}px, ${y}px)`;
  el.classList.add("visible");
}

function hideEdgeTooltip(el) {
  el.classList.remove("visible");
}

// ── Chat (Ask my research) ───────────────────────────────────────────────

function setupChat() {
  const sendBtn = document.getElementById("btn-chat-send");
  const chatInput = document.getElementById("chat-input");

  sendBtn.addEventListener("click", handleChatSend);
  chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleChatSend();
  });
}

function handleChatSend() {
  const input = document.getElementById("chat-input");
  const sendBtn = document.getElementById("btn-chat-send");
  const messagesEl = document.getElementById("chat-messages");
  const question = input.value.trim();
  if (!question) return;

  // Remove welcome message
  const welcome = messagesEl.querySelector(".chat-welcome");
  if (welcome) welcome.remove();

  // Add user bubble
  appendChatBubble("user", question);
  input.value = "";
  sendBtn.disabled = true;

  // Add loading bubble
  const loadingId = "chat-loading-" + Date.now();
  const loadingEl = document.createElement("div");
  loadingEl.id = loadingId;
  loadingEl.className = "chat-bubble chat-bubble-loading";
  loadingEl.textContent = "Analizando tus fuentes...";
  messagesEl.appendChild(loadingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  chrome.runtime.sendMessage(
    { type: "CHAT_ASK", question, history: chatHistory },
    (res) => {
      sendBtn.disabled = false;
      const loading = document.getElementById(loadingId);
      if (loading) loading.remove();

      if (!res?.ok) {
        const msgs = {
          too_few_nodes: "Necesitas al menos 2 fuentes para preguntar.",
          no_api_key: "Configura una API key en la pestana Config.",
          ask_failed: "No se pudo generar la respuesta. Intenta de nuevo.",
        };
        const errEl = document.createElement("div");
        errEl.className = "chat-bubble chat-bubble-error";
        errEl.textContent = msgs[res?.error] || "Error desconocido.";
        messagesEl.appendChild(errEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return;
      }

      // Save to history
      chatHistory.push({ role: "user", content: question });
      chatHistory.push({ role: "assistant", content: res.answer });

      // Add assistant bubble with sources
      appendChatBubble("assistant", res.answer, res.sources);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  );
}

function appendChatBubble(role, text, sources) {
  const messagesEl = document.getElementById("chat-messages");
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble chat-bubble-${role}`;
  bubble.textContent = text;

  if (role === "assistant" && sources && sources.length > 0) {
    const srcDiv = document.createElement("div");
    srcDiv.className = "chat-bubble-sources";
    srcDiv.innerHTML = "<strong>Fuentes:</strong>";
    sources.forEach((s) => {
      const a = document.createElement("a");
      a.textContent = s.title;
      if (s.url) { a.href = s.url; a.target = "_blank"; a.rel = "noopener"; }
      srcDiv.appendChild(a);
    });
    bubble.appendChild(srcDiv);
  }

  messagesEl.appendChild(bubble);
}

// ── Graph floating buttons (Gaps + Suggestions) ─────────────────────────

function setupGraphFabs() {
  document.getElementById("btn-fab-gaps").addEventListener("click", () => {
    togglePopup("popup-gaps");
  });
  document.getElementById("btn-fab-suggestions").addEventListener("click", () => {
    togglePopup("popup-suggestions");
  });

  document.querySelectorAll(".popup-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      const popupId = btn.dataset.popup;
      if (popupId) document.getElementById(popupId).style.display = "none";
    });
  });

  document.getElementById("btn-popup-gaps-analyze").addEventListener("click", handlePopupGaps);
  document.getElementById("btn-popup-suggestions-suggest").addEventListener("click", handlePopupSuggestions);
}

function togglePopup(id) {
  const popup = document.getElementById(id);
  const other = id === "popup-gaps" ? "popup-suggestions" : "popup-gaps";
  document.getElementById(other).style.display = "none";
  popup.style.display = popup.style.display === "none" ? "flex" : "none";
}

function handlePopupGaps() {
  const btn = document.getElementById("btn-popup-gaps-analyze");
  const container = document.getElementById("popup-gaps-body");
  btn.disabled = true;
  container.innerHTML = '<p class="insights-loading">Analizando tu investigacion...</p>';

  chrome.runtime.sendMessage({ type: "ANALYZE_GAPS" }, (res) => {
    btn.disabled = false;
    if (!res?.ok) {
      const msgs = {
        no_topic: "Defini un tema de investigacion primero.",
        too_few_nodes: `Necesitas al menos ${res?.minNodes || 5} fuentes para analizar vacios.`,
        no_api_key: "Configura una API key en la pestana Config.",
        analysis_failed: "No se pudo completar el analisis. Intenta de nuevo.",
      };
      container.innerHTML = `<p class="insights-error">${msgs[res?.error] || "Error desconocido."}</p>`;
      return;
    }

    container.innerHTML = "";
    if (res.stats) {
      const statsDiv = document.createElement("div");
      statsDiv.className = "insights-stats";
      statsDiv.innerHTML = [
        `<span class="stat-chip">${res.stats.totalNodes} fuentes</span>`,
        `<span class="stat-chip">${res.stats.totalConcepts} conceptos</span>`,
        `<span class="stat-chip">${res.stats.wellCovered} bien cubiertos</span>`,
        `<span class="stat-chip">${res.stats.barelyCovered} con vacios</span>`,
      ].join("");
      container.appendChild(statsDiv);
    }
    (res.gaps || []).forEach((gap) => {
      container.appendChild(createInsightCard(gap.gap, gap.why, gap.searchQuery, "Buscar en Google Scholar →"));
    });
  });
}

function handlePopupSuggestions() {
  const btn = document.getElementById("btn-popup-suggestions-suggest");
  const container = document.getElementById("popup-suggestions-body");
  btn.disabled = true;
  container.innerHTML = '<p class="insights-loading">Buscando sugerencias...</p>';

  chrome.runtime.sendMessage({ type: "SUGGEST_SOURCES" }, (res) => {
    btn.disabled = false;
    if (!res?.ok) {
      const msgs = {
        no_topic: "Defini un tema de investigacion primero.",
        too_few_nodes: `Necesitas al menos ${res?.minNodes || 3} fuentes para recibir sugerencias.`,
        no_api_key: "Configura una API key en la pestana Config.",
        suggestion_failed: "No se pudieron generar sugerencias. Intenta de nuevo.",
      };
      container.innerHTML = `<p class="insights-error">${msgs[res?.error] || "Error desconocido."}</p>`;
      return;
    }

    container.innerHTML = "";
    (res.suggestions || []).forEach((s) => {
      container.appendChild(createInsightCard(s.title, s.why, s.searchQuery, "Buscar →"));
    });
  });
}

function createInsightCard(title, body, searchQuery, actionLabel) {
  const card = document.createElement("div");
  card.className = "insight-card";

  const titleEl = document.createElement("div");
  titleEl.className = "insight-card-title";
  titleEl.textContent = title;

  const bodyEl = document.createElement("div");
  bodyEl.className = "insight-card-body";
  bodyEl.textContent = body;

  card.appendChild(titleEl);
  card.appendChild(bodyEl);

  if (searchQuery) {
    const action = document.createElement("a");
    action.className = "insight-card-action";
    action.textContent = actionLabel;
    action.href = `https://scholar.google.com/scholar?q=${encodeURIComponent(searchQuery)}`;
    action.target = "_blank";
    action.rel = "noopener";
    card.appendChild(action);
  }

  return card;
}

// ── Graph filters ────────────────────────────────────────────────────────

function setupGraphFilters() {
  document.querySelectorAll(".gf-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".gf-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      graphFilterType = chip.dataset.gfilter;
      renderGraph();
    });
  });

  document.getElementById("gf-source-select").addEventListener("change", (e) => {
    graphFilterSource = e.target.value;
    renderGraph();
  });
}

function updateSourceFilter() {
  const select = document.getElementById("gf-source-select");
  const sources = [...new Set(graph.nodes.map((n) => n.source).filter(Boolean))].sort();
  const current = select.value;
  select.innerHTML = '<option value="all">Todas las fuentes</option>';
  sources.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s;
    opt.textContent = s;
    select.appendChild(opt);
  });
  if (sources.includes(current)) select.value = current;
  else { select.value = "all"; graphFilterSource = "all"; }
}
