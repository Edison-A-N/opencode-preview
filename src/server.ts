import { watch, type FSWatcher } from "fs"
import { readdir, readFile, stat } from "fs/promises"
import path from "path"

import { renderCodeBody } from "./renderers/code"
import { renderDrawioBody } from "./renderers/drawio"
import { renderMarkdownBody } from "./renderers/markdown"

let server: Bun.Server | null = null
let defaultRootDirectory = ""
let activePort = 17890
const dirWatchers = new Map<string, { watchers: FSWatcher[]; refCount: number }>()
const wsClients = new Set<Bun.ServerWebSocket<{ dir: string }>>()

const CODE_EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".kt": "kotlin",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".sql": "sql",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".dockerfile": "dockerfile",
  ".lua": "lua",
  ".r": "r",
  ".scala": "scala",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".vue": "xml",
  ".svelte": "xml",
  ".tf": "hcl",
  ".ini": "ini",
  ".conf": "ini",
  ".env": "bash",
  ".gitignore": "plaintext",
  ".editorconfig": "ini",
}

const SPECIAL_FILENAMES: Record<string, string> = {
  Dockerfile: "dockerfile",
  Makefile: "makefile",
  Jenkinsfile: "groovy",
  Vagrantfile: "ruby",
  Gemfile: "ruby",
  Rakefile: "ruby",
  Justfile: "makefile",
}

export function isPreviewable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".md" || ext === ".drawio") return true
  if (ext in CODE_EXTENSIONS) return true
  const basename = path.basename(filePath)
  return basename in SPECIAL_FILENAMES
}

export function getCodeLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext in CODE_EXTENSIONS) return CODE_EXTENSIONS[ext]
  const basename = path.basename(filePath)
  if (basename in SPECIAL_FILENAMES) return SPECIAL_FILENAMES[basename]
  return null
}

export function ensureInsideRoot(rootDir: string, relativeFilePath: string): string {
  const resolvedPath = path.resolve(rootDir, relativeFilePath)
  if (resolvedPath !== rootDir && !resolvedPath.startsWith(`${rootDir}${path.sep}`)) {
    throw new Error("Path is outside of preview root")
  }
  return resolvedPath
}

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".venv", "venv", ".opencode"])

async function collectPreviewFiles(directory: string, base = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          return []
        }
        return collectPreviewFiles(absolutePath, base)
      }
      if (!entry.isFile() || !isPreviewable(entry.name)) {
        return []
      }
      return [path.relative(base, absolutePath).split(path.sep).join("/")]
    }),
  )
  return files.flat().sort((a, b) => a.localeCompare(b))
}

async function resolveWorktreePath(baseDir: string, worktreeName: string): Promise<string> {
  // .git can be a directory (normal repo) or a file pointing to the real gitdir (worktree checkout)
  const gitPath = path.join(baseDir, ".git")
  let gitDir: string

  try {
    const gitStat = await stat(gitPath)
    if (gitStat.isDirectory()) {
      gitDir = gitPath
    } else {
      // .git is a file (worktree checkout) — follow the pointer to the real gitdir
      const content = await readFile(gitPath, "utf-8")
      const match = content.trim().match(/^gitdir:\s*(.+)$/)
      if (!match) throw new Error("Invalid .git file format")
      const linkedGitDir = path.resolve(baseDir, match[1])
      gitDir = path.resolve(linkedGitDir, "..", "..")
    }
  } catch {
    throw new Error(`Cannot find .git in ${baseDir}`)
  }

  const worktreeGitDir = path.join(gitDir, "worktrees", worktreeName, "gitdir")
  try {
    const gitdirContent = await readFile(worktreeGitDir, "utf-8")
    // gitdir contains path like "/home/user/.../worktree-name/.git" — parent is the checkout dir
    const worktreeDotGit = gitdirContent.trim()
    const worktreeDir = path.dirname(worktreeDotGit)

    const dirStat = await stat(worktreeDir)
    if (!dirStat.isDirectory()) {
      throw new Error(`Worktree directory does not exist: ${worktreeDir}`)
    }
    return worktreeDir
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Worktree directory")) {
      throw error
    }
    throw new Error(`Worktree "${worktreeName}" not found in ${gitDir}/worktrees/`)
  }
}

async function resolveRootDir(url: URL): Promise<string> {
  const worktreeName = url.searchParams.get("worktree")
  const dirParam = url.searchParams.get("dir")

  if (worktreeName) {
    const baseDir = dirParam ? path.resolve(dirParam) : defaultRootDirectory
    return resolveWorktreePath(baseDir, worktreeName)
  }

  if (dirParam) {
    const resolved = path.resolve(dirParam)
    if (!resolved.startsWith(`${defaultRootDirectory}${path.sep}`) && resolved !== defaultRootDirectory) {
      throw new Error(`Directory is outside of default root: ${resolved}`)
    }
    const dirStat = await stat(resolved)
    if (!dirStat.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`)
    }
    return resolved
  }

  return defaultRootDirectory
}

function dirQueryString(url: URL): string {
  const parts: string[] = []
  const dir = url.searchParams.get("dir")
  const worktree = url.searchParams.get("worktree")
  if (dir) parts.push(`dir=${encodeURIComponent(dir)}`)
  if (worktree) parts.push(`worktree=${encodeURIComponent(worktree)}`)
  return parts.length > 0 ? parts.join("&") : ""
}

function createLiveReloadScript(dirParams: string): string {
  const wsParams = dirParams ? `?${dirParams}` : ""
  return `<script>
(() => {
  let socket;
  let timer;
  const connect = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(protocol + "://" + window.location.host + "/ws${wsParams}");
    socket.onmessage = () => window.location.reload();
    socket.onclose = () => {
      clearTimeout(timer);
      timer = setTimeout(connect, 1000);
    };
  };
  connect();
})();
</script>`
}

function createSidebarScript(currentFile: string, dirParams: string): string {
  const escaped = JSON.stringify(currentFile)
  const escapedDirParams = JSON.stringify(dirParams)
  return `<script>
(() => {
  const currentFile = ${escaped};
  const dirParams = ${escapedDirParams};
  const sidebar = document.getElementById("preview-sidebar");

  const escapeHtml = (v) => v
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("\\"", "&quot;");

  const iconFor = (f) => {
    if (f.endsWith(".drawio")) return "📊";
    if (f.endsWith(".md")) return "📄";
    return "💻";
  };

  function buildHref(file) {
    let href = "/preview?file=" + encodeURIComponent(file);
    if (dirParams) href += "&" + dirParams;
    return href;
  }

  function buildTree(files) {
    const root = {};
    for (const file of files) {
      const parts = file.split("/");
      let cursor = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (i === parts.length - 1) { cursor[part] = file; }
        else { cursor[part] = cursor[part] || {}; cursor = cursor[part]; }
      }
    }
    return root;
  }

  function renderTree(node) {
    const entries = Object.entries(node).sort(([a],[b]) => a.localeCompare(b));
    return '<ul class="file-tree">' + entries.map(([name, value]) => {
      if (typeof value === "string") {
        const href = buildHref(value);
        const active = value === currentFile ? " active" : "";
        return '<li class="file-item"><a href="' + href + '" class="' + active + '"><span class="file-icon">' + iconFor(value) + '</span><span class="file-path">' + escapeHtml(name) + '</span></a></li>';
      }
      const hasActive = JSON.stringify(value).includes(JSON.stringify(currentFile).slice(1,-1));
      const open = hasActive ? " open" : "";
      return '<li class="folder-item"><details' + open + '><summary>📁 ' + escapeHtml(name) + '</summary>' + renderTree(value) + '</details></li>';
    }).join("") + '</ul>';
  }

  async function loadSidebar() {
    sidebar.innerHTML = '<div class="sidebar-loading">Loading...</div>';
    try {
      let apiUrl = "/api/files";
      if (dirParams) apiUrl += "?" + dirParams;
      const resp = await fetch(apiUrl);
      const data = await resp.json();
      const files = Array.isArray(data.files) ? data.files : [];
      if (files.length === 0) {
        sidebar.innerHTML = '<div class="sidebar-loading">No files found.</div>';
        return;
      }
      sidebar.innerHTML = '<div class="sidebar-header"><h2>Files</h2></div>' + renderTree(buildTree(files));
      const active = sidebar.querySelector("a.active");
      if (active) active.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {
      sidebar.innerHTML = '<div class="sidebar-loading">Failed to load.</div>';
    }
  }

  loadSidebar();
})();
</script>`
}

function wrapWithSidebar(title: string, innerBody: string, currentFile: string, dirParams: string, rootDir: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="/styles.css" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" media="(prefers-color-scheme: light)" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" media="(prefers-color-scheme: dark)" />
  </head>
  <body>
    <div class="preview-layout">
      <nav id="preview-sidebar" class="preview-sidebar"></nav>
      <div class="preview-content">
        <div class="dir-indicator"><code>${rootDir}</code></div>
        ${innerBody}
      </div>
    </div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
    <script>document.querySelectorAll("pre code").forEach(b => window.hljs?.highlightElement(b));</script>
    ${createSidebarScript(currentFile, dirParams)}
    ${createLiveReloadScript(dirParams)}
  </body>
</html>`
}

function contentTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".md") {
    return "text/markdown; charset=utf-8"
  }
  if (ext === ".drawio") {
    return "application/xml; charset=utf-8"
  }
  return "text/plain; charset=utf-8"
}

function closeWatchersForDir(dir: string): void {
  const entry = dirWatchers.get(dir)
  if (!entry) return
  for (const w of entry.watchers) {
    w.close()
  }
  dirWatchers.delete(dir)
}

function closeAllWatchers(): void {
  for (const [, entry] of dirWatchers) {
    for (const w of entry.watchers) {
      w.close()
    }
  }
  dirWatchers.clear()
}

async function listDirectories(directory: string): Promise<string[]> {
  const result = [directory]
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
      continue
    }
    const child = path.join(directory, entry.name)
    result.push(...(await listDirectories(child)))
  }
  return result
}

function broadcastChange(changedDir: string): void {
  const message = JSON.stringify({ type: "file-changed" })
  for (const client of wsClients) {
    if (client.data.dir === changedDir) {
      client.send(message)
    }
  }
}

async function ensureWatchers(dir: string): Promise<void> {
  if (dirWatchers.has(dir)) {
    dirWatchers.get(dir)!.refCount++
    return
  }

  const watcherList: FSWatcher[] = []
  try {
    const recursiveWatcher = watch(dir, { recursive: true }, (_, filename) => {
      if (!filename || !isPreviewable(filename)) return
      broadcastChange(dir)
    })
    watcherList.push(recursiveWatcher)
  } catch {
    const directories = await listDirectories(dir)
    for (const d of directories) {
      const watcher = watch(d, (_, filename) => {
        if (!filename || !isPreviewable(filename)) return
        broadcastChange(dir)
      })
      watcherList.push(watcher)
    }
  }
  dirWatchers.set(dir, { watchers: watcherList, refCount: 1 })
}

async function renderBrowserPage(rootDir: string, dirParams: string): Promise<string> {
  const templatePath = path.join(import.meta.dir, "templates", "browser.html")
  const template = await Bun.file(templatePath).text()
  return template
    .replaceAll("{{PROJECT_DIRECTORY}}", rootDir)
    .replaceAll("{{DIR_PARAMS}}", dirParams)
    .replace("</body>", `${createLiveReloadScript(dirParams)}</body>`)
}

export async function startServer(directory: string, port = Number(process.env.PREVIEW_PORT ?? "17890")): Promise<number> {
  if (server) {
    return activePort
  }

  defaultRootDirectory = path.resolve(directory)
  activePort = Number.isNaN(port) ? 17890 : port

  await ensureWatchers(defaultRootDirectory)

  server = Bun.serve<{ dir: string }>({
    hostname: "127.0.0.1",
    port: activePort,
    fetch: async (request, serverInstance) => {
      const url = new URL(request.url)
      const dqStr = dirQueryString(url)

      if (url.pathname === "/ws") {
        let rootDir: string
        try {
          rootDir = await resolveRootDir(url)
        } catch {
          rootDir = defaultRootDirectory
        }
        await ensureWatchers(rootDir)
        const upgraded = serverInstance.upgrade(request, { data: { dir: rootDir } })
        if (upgraded) {
          return undefined
        }
        return new Response("WebSocket upgrade failed", { status: 400 })
      }

      if (url.pathname === "/styles.css") {
        const cssPath = path.join(import.meta.dir, "templates", "styles.css")
        const css = await Bun.file(cssPath).text()
        return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } })
      }

      let rootDir: string
      try {
        rootDir = await resolveRootDir(url)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid directory"
        return new Response(message, { status: 400 })
      }

      if (url.pathname === "/") {
        return new Response(await renderBrowserPage(rootDir, dqStr), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }

      if (url.pathname === "/api/files") {
        const files = await collectPreviewFiles(rootDir)
        return Response.json({ files, directory: rootDir })
      }

      if (url.pathname === "/api/file") {
        const relativePath = url.searchParams.get("path")
        if (!relativePath) {
          return new Response("Missing path query parameter", { status: 400 })
        }

        try {
          const absolutePath = ensureInsideRoot(rootDir, relativePath)
          const fileStat = await stat(absolutePath)
          if (!fileStat.isFile() || !isPreviewable(absolutePath)) {
            return new Response("File is not previewable", { status: 400 })
          }

          const raw = await readFile(absolutePath, "utf-8")
          return new Response(raw, {
            headers: { "content-type": contentTypeFromPath(absolutePath) },
          })
        } catch {
          return new Response("Invalid file path", { status: 400 })
        }
      }

      if (url.pathname === "/preview") {
        const relativePath = url.searchParams.get("file")
        if (!relativePath) {
          return new Response("Missing file query parameter", { status: 400 })
        }

        try {
          const absolutePath = ensureInsideRoot(rootDir, relativePath)
          const fileStat = await stat(absolutePath)
          if (!fileStat.isFile()) {
            return new Response("File not found", { status: 404 })
          }

          const extension = path.extname(absolutePath).toLowerCase()
          const content = await readFile(absolutePath, "utf-8")

          if (extension === ".md") {
            const body = await renderMarkdownBody(content)
            return new Response(wrapWithSidebar(relativePath, body, relativePath, dqStr, rootDir), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }

          if (extension === ".drawio") {
            const body = renderDrawioBody(content)
            return new Response(wrapWithSidebar(relativePath, body, relativePath, dqStr, rootDir), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }

          const lang = getCodeLanguage(absolutePath)
          if (lang) {
            const body = renderCodeBody(content, lang)
            return new Response(wrapWithSidebar(relativePath, body, relativePath, dqStr, rootDir), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }

          return new Response("Unsupported file type", { status: 400 })
        } catch {
          return new Response("Invalid file path", { status: 400 })
        }
      }

      return new Response("Not Found", { status: 404 })
    },
    websocket: {
      open(ws) {
        wsClients.add(ws)
      },
      close(ws) {
        wsClients.delete(ws)
        const dir = ws.data.dir
        const entry = dirWatchers.get(dir)
        if (entry && dir !== defaultRootDirectory) {
          entry.refCount--
          if (entry.refCount <= 0) {
            closeWatchersForDir(dir)
          }
        }
      },
    },
  })

  return activePort
}

export function stopServer(): void {
  if (!server) {
    return
  }
  closeAllWatchers()
  for (const client of wsClients) {
    client.close()
  }
  wsClients.clear()
  server.stop(true)
  server = null
}

if (import.meta.main) {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
  const port = Number(process.env.PREVIEW_PORT ?? "17890")
  const startedPort = await startServer(directory, port)
  console.log(`Preview server running at http://127.0.0.1:${startedPort}`)
  console.log(`  Default directory: ${path.resolve(directory)}`)
  console.log(`  Use ?dir=<subdirectory> to preview a subdirectory`)
  console.log(`  Use ?worktree=name to preview a git worktree`)
}
