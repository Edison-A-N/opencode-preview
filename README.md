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

---

## Why?

Terminal AI editors are great for coding, but previewing files means switching to another app. **opencode-preview** brings the preview right to your browser — auto-started, auto-refreshed, zero config.

**One line to install:**

```json
{ "plugin": ["Edison-A-N/opencode-preview"] }
```

That's it. Open OpenCode, and preview is ready.

## Features

### File Rendering

| Format | Description |
|---|---|
| **Markdown** | GFM rendering via [marked](https://github.com/markedjs/marked), syntax-highlighted code blocks, word count, reading time estimate, auto-generated Table of Contents |
| **DrawIO** | Embedded [draw.io](https://www.drawio.com/) viewer with multi-page support, zoom, layers, and page navigation |
| **HTML** | Sandboxed iframe preview with "Open in new tab" link |
| **CSV** | Tabular rendering with rainbow-striped rows, row/column stats |
| **PNG** | Minimal image preview with max-dimensions, centering, and original download link |
| **Code** | Syntax highlighting for 40+ languages via [highlight.js](https://highlightjs.org/) — TypeScript, Python, Rust, Go, Java, Kotlin, C/C++, Ruby, PHP, Swift, Scala, Zig, Elixir, Erlang, Haskell, OCaml, Lua, R, SQL, GraphQL, Protobuf, HCL, Vue, Svelte, and more |

### Browser UI

| Feature | Description |
|---|---|
| **SPA Navigation** | Single-page app with client-side routing — no full reloads between files |
| **Tabbed Interface** | Open multiple files in tabs, switch between them, close individually. Tab state persists across reloads via localStorage |
| **File Tree Sidebar** | Collapsible folder tree with file-type icons, remembers open/closed folder state |
| **Resizable Sidebar** | Drag-to-resize sidebar width, persisted across sessions |
| **Markdown TOC** | Auto-generated "On This Page" table of contents with scroll-tracking active headings |
| **Worktree Switcher** | Dropdown in the sidebar to switch between git worktrees |
| **Copy Path** | One-click copy of the project root directory path |
| **Live Reload** | WebSocket-based auto-refresh on file save — all open tabs reload simultaneously |
| **Dark Mode** | Follows system `prefers-color-scheme` preference |

### Multi-Project

| Feature | Description |
|---|---|
| **Project Discovery** | Automatically discovers all projects registered in the running OpenCode instance via its API |
| **Project List** | Root page (`/`) shows all projects with search filtering and jump-to dropdown |
| **URL Isolation** | Each project is accessed via `?project=<id>` query parameter |

### OpenCode Integration

| Feature | Description |
|---|---|
| **Server Plugin** | Exposes a `preview` tool that the AI agent can call to open any previewable file in the browser |
| **TUI Plugin** | Sidebar widget showing previewable changed files + command palette entries |
| **Auto-Start** | Preview server starts in the background when OpenCode launches — non-blocking |
| **File Events** | Listens to `file.edited` events from OpenCode for logging |
| **Path Security** | Only serves files within the project directory — path traversal is blocked |

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
  "plugin": ["Edison-A-N/opencode-preview@v0.5.0"]
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
bun install
bun run dev                             # Start server
```

Set `OPENCODE_SERVER_URL` to enable project auto-discovery:

```bash
OPENCODE_SERVER_URL=http://localhost:10013 bun run dev
```

Then open `http://localhost:17890` in your browser.

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PREVIEW_PORT` | `17890` | Server port |
| `PREVIEW_MAX_TABS` | `10` | Maximum number of open tabs in the browser UI |
| `OPENCODE_SERVER_URL` | — | OpenCode server URL for project discovery (standalone mode only; auto-configured when running as plugin) |

## Architecture

```
src/
├── index.ts           # OpenCode server plugin entry — registers preview tool + file events
├── tui.tsx            # OpenCode TUI plugin — sidebar widget + command palette
├── server.ts          # HTTP server (node:http) + WebSocket (ws) + file watcher + SPA shell
├── renderers/
│   ├── code.ts        # Syntax-highlighted code preview (40+ languages)
│   ├── csv.ts         # CSV table renderer with rainbow rows
│   ├── drawio.ts      # draw.io viewer (CDN)
│   ├── html.ts        # Sandboxed iframe HTML preview
│   └── markdown.ts    # GFM rendering via marked + word count + reading time
└── templates/
    ├── browser.html   # Legacy standalone browser template
    └── styles.css     # Shared styles (light/dark themes)
```

## API Routes

All project-scoped routes require a `?project=<id>` query parameter. Worktree routes additionally accept `?worktree=<name>`.

| Route | Description |
|---|---|
| `GET /` | Project list page (search + jump-to) |
| `GET /browse` | File browser SPA shell for a project |
| `GET /preview?file=<path>` | Preview a file (Markdown, DrawIO, HTML, CSV, or code) |
| `GET /api/projects` | JSON list of all discovered projects |
| `GET /api/files` | JSON list of previewable files in a project |
| `GET /api/file?path=<path>` | Raw file content |
| `GET /api/render?file=<path>` | Rendered content fragment (JSON: `{ title, body, contentClass }`) |
| `GET /api/worktrees` | JSON list of git worktrees for a project |
| `GET /styles.css` | Stylesheet |
| `WS /ws` | Live reload notifications |

## Supported Languages

The code renderer recognizes 40+ file extensions and special filenames:

<details>
<summary>Full list</summary>

**By extension**: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.py`, `.rs`, `.go`, `.java`, `.kt`, `.c`, `.cpp`, `.h`, `.hpp`, `.cs`, `.rb`, `.php`, `.swift`, `.sh`, `.bash`, `.zsh`, `.fish`, `.sql`, `.css`, `.scss`, `.less`, `.json`, `.yaml`, `.yml`, `.toml`, `.xml`, `.graphql`, `.gql`, `.proto`, `.dockerfile`, `.lua`, `.r`, `.scala`, `.zig`, `.ex`, `.exs`, `.erl`, `.hs`, `.ml`, `.vue`, `.svelte`, `.tf`, `.ini`, `.conf`, `.env`, `.gitignore`, `.editorconfig`

**By filename**: `Dockerfile`, `Makefile`, `Jenkinsfile`, `Vagrantfile`, `Gemfile`, `Rakefile`, `Justfile`

</details>

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
bun test
bun run dev
```

## License

[MIT](LICENSE)
