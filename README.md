# Constellation — Chrome Extension

Builds an automatic knowledge graph of your research sessions.

## Setup

1. Get a Claude API key from https://console.anthropic.com
1.a (Optional) To use Gemini (Flash 2.5) instead of Claude: obtain a Google Generative API token (service-account or OAuth access token) and paste it in the sidebar settings. Gemini support is experimental; the token must be usable as a Bearer token for the Generative Language API.
2. Open Chrome → `chrome://extensions` → Enable "Developer mode"
3. Click "Load unpacked" → select this folder
4. Click the Constellation icon in the toolbar to open the sidebar
5. Go to **Config** tab and enter your Claude API key

## How it works

- **Research topic**: Before starting, define a topic (title + brief description). Only related pages are added to the graph.
- **Web pages**: Automatically captured as you browse (after 2s on the page)
- **AI tools**: A floating button appears on ChatGPT, Claude.ai, Perplexity, and Gemini — select the exact output text you want and click to save
- **Quick notes**: Type in the bar at the bottom of the sidebar

Nodes are connected when they share extracted concepts. The more concepts in common, the thicker the edge.

## Icons

You need to add `icon16.png`, `icon48.png`, and `icon128.png` to the `icons/` folder.
You can generate them with ImageMagick or use any 16×16, 48×48, and 128×128 PNG files.

## Visualizador incluido

La extensión ya incluye un renderizador SVG simple en el `sidebar` que no depende de D3 ni de recursos externos, por lo que no es necesario descargar dependencias manualmente.

## Folder structure

```
constellation/
├── manifest.json
├── background.js       # Service worker — graph state + Claude API
├── content.js          # Runs on web pages
├── content-ai.js       # Runs on AI tools (floating save button)
├── content-ai.css      # Styles for the floating button
├── sidebar/
│   ├── sidebar.html
│   ├── sidebar.js      # Graph + UI logic (sin dependencias externas)
│   └── sidebar.css
└── icons/
```
