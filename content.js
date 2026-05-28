// ResearchMap — content.js
// Runs on regular web pages. Extracts full visible text and sends to background.

(function () {
  if (window.self !== window.top) return;

  const url = location.href;
  if (!url.startsWith("http")) return;
  if (isBlockedUrl(url)) return;

  setTimeout(captureCurrentPage, 2500);

  function captureCurrentPage() {
    const title = document.title || url;
    const metaDesc = document.querySelector('meta[name="description"]')?.content || "";

    // Extract all meaningful visible text from the page
    const fullText = extractPageText();
    if (!fullText || fullText.replace(/\s+/g, "").length < 80) return;

    // Snippet for quick display in sidebar, full text for deep storage
    const contentSnippet = (title + " " + metaDesc + " " + fullText).replace(/\s+/g, " ").trim().slice(0, 800);

    chrome.runtime.sendMessage({
      type: "ADD_PAGE",
      title,
      url,
      contentSnippet,
      fullText: fullText.slice(0, 50000),
    });
  }

  function extractPageText() {
    // Try structured content containers first
    const candidates = Array.from(
      document.querySelectorAll("article, main, [role=main], section")
    ).filter(Boolean);

    let best = "";
    for (const c of candidates) {
      const t = visibleTextOf(c);
      if (t.length > best.length) best = t;
    }

    // If structured containers gave little, try large divs
    if (best.length < 500) {
      const divs = Array.from(document.querySelectorAll("div, p")).filter(Boolean);
      for (const d of divs) {
        const t = visibleTextOf(d);
        if (t.length > best.length) best = t;
      }
    }

    // Fallback to body text
    if (best.length < 200) {
      const bodyText = document.body ? (document.body.innerText || document.body.textContent || "") : "";
      if (bodyText.length > best.length) best = bodyText;
    }

    return best.replace(/\s+/g, " ").trim();
  }

  function visibleTextOf(el) {
    if (el.closest("nav, footer, aside, header")) return "";
    const clone = el.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, iframe, svg, [aria-hidden='true']").forEach((n) => n.remove());
    const links = clone.querySelectorAll("a");
    const textLen = Math.max(1, (clone.textContent || "").length);
    if (links.length / textLen > 0.05) return "";
    return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function isBlockedUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return true; }

    const host = parsed.hostname.replace("www.", "");

    // Apps, tools, social, email — never research content
    const blocked = [
      "facebook.com", "instagram.com", "tiktok.com",
      "reddit.com", "threads.net", "pinterest.com",
      "meet.google.com", "mail.google.com", "calendar.google.com",
      "drive.google.com", "docs.google.com", "sheets.google.com",
      "slides.google.com", "chat.google.com", "contacts.google.com",
      "accounts.google.com", "myaccount.google.com", "pay.google.com",
      "photos.google.com", "keep.google.com", "maps.google.com",
      "translate.google.com", "play.google.com",
      "youtube.com", "music.youtube.com",
      "outlook.live.com", "outlook.office.com", "outlook.office365.com",
      "teams.microsoft.com", "login.microsoftonline.com",
      "zoom.us", "discord.com", "slack.com", "web.whatsapp.com",
      "web.telegram.org", "netflix.com", "spotify.com", "twitch.tv",
      "ebay.com", "mercadolibre.com",
      "github.com", "gitlab.com", "bitbucket.org",
      "localhost",
      // Search engines — never capture results pages
      "scholar.google.com", "scholar.google.com.ar",
      "bing.com", "duckduckgo.com", "search.yahoo.com",
      "yandex.com", "baidu.com", "ecosia.org", "brave.com",
    ];
    if (blocked.some((h) => host === h || host.endsWith("." + h))) return true;

    // Google search (any google domain with search paths)
    const path = parsed.pathname || "";
    const query = parsed.search || "";
    const isGoogle = host === "google.com" || host.endsWith(".google.com");
    if (isGoogle && (path.startsWith("/search") || path.startsWith("/url") || path.startsWith("/imgres") || path.startsWith("/scholar"))) return true;
    if (isGoogle && path === "/" && /[?&]q=/.test(query)) return true;

    // Chrome internal
    if (rawUrl.startsWith("chrome://") || rawUrl.startsWith("chrome-extension://") || rawUrl.startsWith("about:")) return true;

    return false;
  }
})();
