# opencode-preview

OpenCode plugin that auto-starts a file preview server for Markdown and DrawIO files.

## Features

- **Multi-project support** — Single server serves multiple projects via URL prefix isolation
- **Markdown preview** — GFM support, syntax highlighting (highlight.js), clean typography
- **DrawIO preview** — Embedded draw.io viewer for `.drawio` diagrams
- **File browser** — Tree view of all `.md` / `.drawio` files in your project
- **Live reload** — WebSocket-based auto-refresh on file save
- **Dark mode** — Follows system preference
- **Path security** — Only serves files within the project directory

## Quick Start

### As OpenCode Plugin (Recommended)

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-preview"]
}
```

The preview server starts automatically when OpenCode launches. A `preview` tool becomes available for the AI to open files in your browser.

### As Local Plugin

Copy to your project's plugin directory:

```bash
# Clone into .opencode/plugins/
cp -r /path/to/opencode-preview .opencode/plugins/opencode-preview
```

Or symlink it:

```bash
ln -s ~/github/opencode-preview .opencode/plugins/opencode-preview
```

### Standalone Server

Run the preview server directly without OpenCode:

```bash
cd ~/github/opencode-preview
bun run dev                          # Preview current directory
bun run src/server.ts /path/to/project  # Preview specific directory
```

Then open `http://localhost:17890` in your browser (redirects to the project's prefixed URL).

## Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PREVIEW_PORT` | `17890` | Server port |

## Architecture

```
src/
├── index.ts           # OpenCode plugin entry
├── server.ts          # Bun.serve() HTTP server + WebSocket
├── renderers/
│   ├── code.ts        # Syntax-highlighted code preview
│   ├── markdown.ts    # marked + CDN highlight.js
│   └── drawio.ts      # CDN draw.io viewer
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
| `GET /:prefix/preview?file=<path>` | Render a file (Markdown, DrawIO, or code) |
| `GET /:prefix/api/files` | JSON list of previewable files |
| `GET /:prefix/api/file?path=<path>` | Raw file content |
| `GET /:prefix/styles.css` | Stylesheet |
| `WS /:prefix/ws` | Live reload notifications |

All routes support an optional `?worktree=<name>` parameter to preview files from a git worktree.

## Requirements

- [Bun](https://bun.sh) v1.0+
- OpenCode v1.3+ (for plugin usage)

> **Note**: This package exports `.ts`/`.tsx` entry points directly and requires Bun as the runtime. It is not compatible with plain Node.js.

## License

MIT
