<p align="center">
  <h1 align="center">opencode-preview</h1>
  <p align="center">
    Instant file preview for <a href="https://github.com/opencode-ai/opencode">OpenCode</a> — Markdown, DrawIO, HTML, CSV, and 40+ code languages.<br>
    Zero config. Live reload. Dark mode. Just works.
  </p>
</p>

<p align="center">
  <a href="https://github.com/Edison-A-N/opencode-preview/releases"><img src="https://img.shields.io/github/v/release/Edison-A-N/opencode-preview?style=flat-square&color=blue" alt="Release"></a>
  <a href="https://github.com/Edison-A-N/opencode-preview/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Edison-A-N/opencode-preview?style=flat-square" alt="License"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?style=flat-square&logo=bun" alt="Bun"></a>
</p>

<!-- TODO: Add a screenshot or GIF demo here for maximum impact
<p align="center">
  <img src="docs/demo.gif" alt="opencode-preview demo" width="720">
</p>
-->

---

## Why?

Terminal AI editors are great for coding, but previewing files means switching to another app. **opencode-preview** brings the preview right to your browser — auto-started, auto-refreshed, zero config.

**One line to install:**

```json
{ "plugin": ["Edison-A-N/opencode-preview"] }
```

That's it. Open OpenCode, and preview is ready.

## Features

| Feature | Description |
|---|---|
| **Markdown** | GFM support, syntax-highlighted code blocks, clean typography |
| **DrawIO** | Embedded draw.io viewer for `.drawio` diagrams |
| **HTML** | Sandboxed iframe preview for `.html` / `.htm` files |
| **CSV** | Tabular rendering with rainbow-striped rows |
| **Code** | Syntax highlighting for 40+ languages (TypeScript, Python, Rust, Go…) |
| **File Browser** | Tree view + collapsible sidebar for quick navigation |
| **Live Reload** | WebSocket-based auto-refresh on file save |
| **Dark Mode** | Follows your system preference |
| **Multi-Project** | Single server, multiple projects via URL prefix isolation |
| **TUI Integration** | Sidebar widget + command palette in OpenCode terminal UI |
| **Path Security** | Only serves files within the project directory |

## Quick Start

### As OpenCode Plugin (Recommended)

Add to your `opencode.json`:

```json
{
  "plugin": ["Edison-A-N/opencode-preview"]
}
```

Or pin a specific version:

```json
{
  "plugin": ["Edison-A-N/opencode-preview@v0.4.2"]
}
```

The preview server starts automatically when OpenCode launches. A `preview` tool becomes available for the AI to open files in your browser.

### As Local Plugin

```bash
git clone https://github.com/Edison-A-N/opencode-preview.git
ln -s $(pwd)/opencode-preview .opencode/plugins/opencode-preview
```

### Standalone Server

Run the preview server directly without OpenCode:

```bash
cd opencode-preview
bun run dev                             # Preview current directory
bun run src/server.ts /path/to/project  # Preview specific directory
```

Then open `http://localhost:17890` in your browser.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PREVIEW_PORT` | `17890` | Server port |

## Architecture

```
src/
├── index.ts           # OpenCode plugin entry (server plugin)
├── tui.tsx            # OpenCode TUI plugin (sidebar widget + commands)
├── server.ts          # Bun.serve() HTTP server + WebSocket
├── renderers/
│   ├── code.ts        # Syntax-highlighted code preview
│   ├── csv.ts         # CSV table renderer with rainbow rows
│   ├── drawio.ts      # CDN draw.io viewer
│   ├── html.ts        # Sandboxed iframe HTML preview
│   └── markdown.ts    # marked + CDN highlight.js
└── templates/
    ├── browser.html   # File browser page
    └── styles.css     # Shared styles (light/dark)
```

## API Routes

Each registered project gets a URL prefix derived from its directory name (e.g., `my-project`).

| Route | Description |
|---|---|
| `GET /` | 302 redirect to default project |
| `GET /:prefix/` | File browser UI for the project |
| `GET /:prefix/preview?file=<path>` | Render a file (Markdown, DrawIO, HTML, CSV, or code) |
| `GET /:prefix/api/files` | JSON list of previewable files |
| `GET /:prefix/api/file?path=<path>` | Raw file content |
| `GET /:prefix/styles.css` | Stylesheet |
| `WS /:prefix/ws` | Live reload notifications |

All routes support an optional `?worktree=<name>` parameter to preview files from a git worktree.

## Requirements

- [Bun](https://bun.sh) v1.0+
- OpenCode v1.3+ (for plugin usage)

> **Note**: This package exports `.ts`/`.tsx` entry points directly and requires Bun as the runtime. It is not compatible with plain Node.js.

## Contributing

Issues and PRs welcome! This project uses Bun for development:

```bash
git clone https://github.com/Edison-A-N/opencode-preview.git
cd opencode-preview
bun install
bun run dev
```

## License

[MIT](LICENSE)
