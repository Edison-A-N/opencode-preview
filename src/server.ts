import { watch, type FSWatcher } from "fs"
import { readdir, readFile, stat } from "fs/promises"
import path from "path"

import { renderCodeBody } from "./renderers/code"
import { renderCsvBody } from "./renderers/csv"
import { renderDrawioBody } from "./renderers/drawio"
import { renderHtmlBody } from "./renderers/html"
import { renderMarkdownBody } from "./renderers/markdown"

let server: Bun.Server<{ rootDir: string }> | null = null
let activePort = 17890
let defaultPrefix = ""

// prefix → rootDir mapping
const registeredProjects = new Map<string, string>()

const dirWatchers = new Map<string, { watchers: FSWatcher[]; refCount: number }>()
const wsClients = new Set<Bun.ServerWebSocket<{ rootDir: string }>>()

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
  if (ext === ".md" || ext === ".drawio" || ext === ".html" || ext === ".htm" || ext === ".csv") return true
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
        if (IGNORED_DIRS.has(entry.name)) {
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

async function findGitDir(baseDir: string): Promise<string> {
  const gitPath = path.join(baseDir, ".git")
  const gitStat = await stat(gitPath)
  if (gitStat.isDirectory()) {
    return gitPath
  }
  const content = await readFile(gitPath, "utf-8")
  const match = content.trim().match(/^gitdir:\s*(.+)$/)
  if (!match) throw new Error("Invalid .git file format")
  const linkedGitDir = path.resolve(baseDir, match[1])
  return path.resolve(linkedGitDir, "..", "..")
}

async function listWorktrees(baseDir: string): Promise<string[]> {
  try {
    const gitDir = await findGitDir(baseDir)
    const worktreesDir = path.join(gitDir, "worktrees")
    const entries = await readdir(worktreesDir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  } catch {
    return []
  }
}

async function resolveWorktreePath(baseDir: string, worktreeName: string): Promise<string> {
  let gitDir: string
  try {
    gitDir = await findGitDir(baseDir)
  } catch {
    throw new Error(`Cannot find .git in ${baseDir}`)
  }

  const worktreeGitDir = path.join(gitDir, "worktrees", worktreeName, "gitdir")
  try {
    const gitdirContent = await readFile(worktreeGitDir, "utf-8")
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

async function resolveRootDir(projectRootDir: string, url: URL): Promise<string> {
  const worktreeName = url.searchParams.get("worktree")
  if (worktreeName) {
    return resolveWorktreePath(projectRootDir, worktreeName)
  }
  return projectRootDir
}

function worktreeQueryString(url: URL): string {
  const worktree = url.searchParams.get("worktree")
  return worktree ? `worktree=${encodeURIComponent(worktree)}` : ""
}

function createLiveReloadScript(prefix: string, worktreeParams: string): string {
  const wsPath = `/${prefix}/ws`
  const wsParams = worktreeParams ? `?${worktreeParams}` : ""
  return `<script>
(() => {
  let socket;
  let timer;
  const connect = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(protocol + "://" + window.location.host + "${wsPath}${wsParams}");
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

function createSidebarScript(prefix: string, currentFile: string, worktreeParams: string): string {
  const escaped = JSON.stringify(currentFile)
  const escapedPrefix = JSON.stringify(prefix)
  const escapedWorktreeParams = JSON.stringify(worktreeParams)
  return `<script>
(() => {
  const currentFile = ${escaped};
  const prefix = ${escapedPrefix};
  const worktreeParams = ${escapedWorktreeParams};
  const sidebar = document.getElementById("preview-sidebar");

  const escapeHtml = (v) => v
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll("\\"", "&quot;");

  const iconFor = (file) => {
    let color = "#519aba";
    let text = "";
    const f = file.toLowerCase();
    if (f.endsWith(".ts")) { color = "#3178c6"; text = "TS"; }
    else if (f.endsWith(".tsx")) { color = "#3178c6"; text = "TX"; }
    else if (f.endsWith(".js") || f.endsWith(".cjs") || f.endsWith(".mjs")) { color = "#f1e05a"; text = "JS"; }
    else if (f.endsWith(".jsx")) { color = "#f1e05a"; text = "JX"; }
    else if (f.endsWith(".html") || f.endsWith(".htm")) { color = "#e34f26"; text = "<>"; }
    else if (f.endsWith(".css")) { color = "#1572b6"; text = "#"; }
    else if (f.endsWith(".json")) { color = "#cbcb41"; text = "{}"; }
    else if (f.endsWith(".md")) { color = "#42a5f5"; text = "M↓"; }
    else if (f.endsWith(".py")) { color = "#3572A5"; text = "PY"; }
    else if (f.endsWith(".go")) { color = "#00ADD8"; text = "GO"; }
    else if (f.endsWith(".rs")) { color = "#dea584"; text = "RS"; }
    else if (f.endsWith(".drawio")) { color = "#f08705"; text = "D"; }
    else if (f.endsWith(".csv")) { color = "#217346"; text = "CSV"; }
    else { text = f.split('.').pop().substring(0, 2).toUpperCase() || "F"; }

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="' + color + '" d="M13.85 4.44l-3.28-3.3c-.19-.18-.43-.28-.71-.28H3.5c-.55 0-1 .45-1 1v12.28c0 .55.45 1 1 1h9c.55 0 1-.45 1-1V5.14c0-.26-.1-.51-.28-.7zM9.5 2.56L12.06 5H9.5V2.56zM12.5 14h-9V2.5h5V5.5h3.5v8.5z"/><text x="8" y="11" font-size="5" font-family="sans-serif" font-weight="bold" fill="' + color + '" text-anchor="middle">' + text + '</text></svg>';
  };

  function buildHref(file) {
    let href = "/" + prefix + "/preview?file=" + encodeURIComponent(file);
    if (worktreeParams) href += "&" + worktreeParams;
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
      return '<li class="folder-item"><details' + open + '><summary>' + escapeHtml(name) + '</summary>' + renderTree(value) + '</details></li>';
    }).join("") + '</ul>';
  }

  async function loadSidebar() {
    sidebar.innerHTML = '<div class="sidebar-loading">Loading...</div>';
    try {
      let apiUrl = "/" + prefix + "/api/files";
      if (worktreeParams) apiUrl += "?" + worktreeParams;
      const resp = await fetch(apiUrl);
      const data = await resp.json();
      const files = Array.isArray(data.files) ? data.files : [];

      let worktreeHtml = "";
      try {
        const wtResp = await fetch("/" + prefix + "/api/worktrees");
        const wtData = await wtResp.json();
        const worktrees = Array.isArray(wtData.worktrees) ? wtData.worktrees : [];
        if (worktrees.length > 0) {
          const params = new URLSearchParams(worktreeParams);
          const activeWt = params.get("worktree") || "";
          worktreeHtml = '<div class="sidebar-worktree-section"><div class="sidebar-header"><h2>Worktree</h2></div><div class="worktree-options">';
          worktreeHtml += '<label class="worktree-radio"><input type="radio" name="sidebar-worktree" value=""' + (activeWt === "" ? " checked" : "") + '><span class="worktree-label">Main repo</span></label>';
          for (const wt of worktrees) {
            const checked = activeWt === wt ? " checked" : "";
            worktreeHtml += '<label class="worktree-radio"><input type="radio" name="sidebar-worktree" value="' + escapeHtml(wt) + '"' + checked + '><span class="worktree-label">' + escapeHtml(wt) + '</span></label>';
          }
          worktreeHtml += '</div></div>';
        }
      } catch {}

      if (files.length === 0) {
        sidebar.innerHTML = worktreeHtml + '<div class="sidebar-loading">No files found.</div>';
        attachWorktreeHandler();
        return;
      }
      sidebar.innerHTML = worktreeHtml + '<div class="sidebar-header"><h2>Files</h2></div>' + renderTree(buildTree(files));
      attachWorktreeHandler();
      const active = sidebar.querySelector("a.active");
      if (active) active.scrollIntoView({ block: "center", behavior: "instant" });
    } catch {
      sidebar.innerHTML = '<div class="sidebar-loading">Failed to load.</div>';
    }
  }

  function attachWorktreeHandler() {
    const radios = sidebar.querySelectorAll('input[name="sidebar-worktree"]');
    for (const r of radios) {
      r.addEventListener("change", (e) => {
        const url = new URL(window.location);
        if (e.target.value) {
          url.searchParams.set("worktree", e.target.value);
        } else {
          url.searchParams.delete("worktree");
        }
        window.location.href = url.toString();
      });
    }
  }

  loadSidebar();
})();
</script>`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
    return map[ch]
  })
}

function wrapWithSidebar(prefix: string, title: string, innerBody: string, currentFile: string, worktreeParams: string, rootDir: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/${prefix}/styles.css" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" media="(prefers-color-scheme: light)" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" media="(prefers-color-scheme: dark)" />
  </head>
  <body>
    <div class="preview-layout">
      <nav id="preview-sidebar" class="preview-sidebar"></nav>
      <div class="preview-content">
        <div class="dir-indicator"><code>${escapeHtml(rootDir)}</code></div>
        ${innerBody}
      </div>
    </div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
    <script>document.querySelectorAll("pre code").forEach(b => window.hljs?.highlightElement(b));</script>
    ${createSidebarScript(prefix, currentFile, worktreeParams)}
    ${createLiveReloadScript(prefix, worktreeParams)}
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
  if (ext === ".csv") {
    return "text/csv; charset=utf-8"
  }
  if (ext === ".html" || ext === ".htm") {
    return "text/html; charset=utf-8"
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
    if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) {
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
    if (client.data.rootDir === changedDir) {
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

async function renderBrowserPage(prefix: string, rootDir: string, worktreeParams: string): Promise<string> {
  const templatePath = path.join(import.meta.dir, "templates", "browser.html")
  const template = await Bun.file(templatePath).text()
  return template
    .replaceAll("{{PROJECT_DIRECTORY}}", rootDir)
    .replaceAll("{{PREFIX}}", prefix)
    .replaceAll("{{WORKTREE_PARAMS}}", worktreeParams)
    .replace("</body>", `${createLiveReloadScript(prefix, worktreeParams)}</body>`)
}

/** Parse the URL prefix from pathname. Returns { prefix, rest } or null if no valid prefix. */
function parsePrefix(pathname: string): { prefix: string; rest: string } | null {
  const slashIdx = pathname.indexOf("/", 1)
  const prefix = slashIdx === -1 ? pathname.slice(1) : pathname.slice(1, slashIdx)
  if (!prefix || !registeredProjects.has(prefix)) return null
  const rest = slashIdx === -1 ? "/" : pathname.slice(slashIdx)
  return { prefix, rest }
}

/** Generate a unique prefix from a directory basename. Appends -2, -3, etc. on conflict. */
function generatePrefix(rootDir: string): string {
  const base = path.basename(rootDir) || "project"
  if (!registeredProjects.has(base)) return base
  let counter = 2
  while (registeredProjects.has(`${base}-${counter}`)) {
    counter++
  }
  return `${base}-${counter}`
}

/**
 * Register a project directory for serving under a URL prefix.
 * Returns the assigned prefix. If the directory is already registered, returns its existing prefix.
 * Server must be started first via `startServer`.
 */
export async function registerProject(rootDir: string): Promise<string> {
  const resolved = path.resolve(rootDir)

  // Check if already registered
  for (const [prefix, dir] of registeredProjects) {
    if (dir === resolved) return prefix
  }

  const prefix = generatePrefix(resolved)
  registeredProjects.set(prefix, resolved)
  await ensureWatchers(resolved)

  // Set default prefix to the first registered project
  if (!defaultPrefix) {
    defaultPrefix = prefix
  }

  return prefix
}

/**
 * Start the preview server. Does not register any project — call `registerProject` separately.
 * Returns the port the server is listening on.
 */
export async function startServer(port = Number(process.env.PREVIEW_PORT ?? "17890")): Promise<number> {
  if (server) {
    return activePort
  }

  activePort = Number.isNaN(port) ? 17890 : port

  server = Bun.serve<{ rootDir: string }>({
    hostname: "0.0.0.0",
    port: activePort,
    fetch: async (request, serverInstance) => {
      const url = new URL(request.url)

      // Root path → redirect to default project
      if (url.pathname === "/") {
        if (!defaultPrefix) {
          return new Response("No projects registered", { status: 404 })
        }
        return Response.redirect(`/${defaultPrefix}/`, 302)
      }

      // Parse prefix from URL
      const parsed = parsePrefix(url.pathname)
      if (!parsed) {
        return new Response("Not Found", { status: 404 })
      }

      const { prefix, rest } = parsed
      const projectRootDir = registeredProjects.get(prefix)!
      const wtParams = worktreeQueryString(url)

      // WebSocket upgrade: /:prefix/ws
      if (rest === "/ws") {
        let rootDir: string
        try {
          rootDir = await resolveRootDir(projectRootDir, url)
        } catch {
          rootDir = projectRootDir
        }
        await ensureWatchers(rootDir)
        const upgraded = serverInstance.upgrade(request, { data: { rootDir } })
        if (upgraded) {
          return undefined
        }
        return new Response("WebSocket upgrade failed", { status: 400 })
      }

      // Static: /:prefix/styles.css
      if (rest === "/styles.css") {
        const cssPath = path.join(import.meta.dir, "templates", "styles.css")
        const css = await Bun.file(cssPath).text()
        return new Response(css, { headers: { "content-type": "text/css; charset=utf-8" } })
      }

      let rootDir: string
      try {
        rootDir = await resolveRootDir(projectRootDir, url)
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid directory"
        return new Response(message, { status: 400 })
      }

      // Browser page: /:prefix/
      if (rest === "/") {
        return new Response(await renderBrowserPage(prefix, rootDir, wtParams), {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }

      // API: file listing: /:prefix/api/files
      if (rest === "/api/files") {
        const files = await collectPreviewFiles(rootDir)
        return Response.json({ files, directory: rootDir })
      }

      // API: worktree listing: /:prefix/api/worktrees
      if (rest === "/api/worktrees") {
        const worktrees = await listWorktrees(projectRootDir)
        return Response.json({ worktrees })
      }

      // API: raw file content: /:prefix/api/file
      if (rest === "/api/file") {
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

      // Preview page: /:prefix/preview
      if (rest === "/preview") {
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
            return new Response(wrapWithSidebar(prefix, relativePath, body, relativePath, wtParams, rootDir), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }

          if (extension === ".drawio") {
            const body = renderDrawioBody(content)
            return new Response(wrapWithSidebar(prefix, relativePath, body, relativePath, wtParams, rootDir), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }

          if (extension === ".html" || extension === ".htm") {
            const body = renderHtmlBody(prefix, relativePath, wtParams)
            return new Response(wrapWithSidebar(prefix, relativePath, body, relativePath, wtParams, rootDir), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }

          if (extension === ".csv") {
            const body = renderCsvBody(content)
            return new Response(wrapWithSidebar(prefix, relativePath, body, relativePath, wtParams, rootDir), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          }

          const lang = getCodeLanguage(absolutePath)
          if (lang) {
            const body = renderCodeBody(content, lang)
            return new Response(wrapWithSidebar(prefix, relativePath, body, relativePath, wtParams, rootDir), {
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
      message() {},
      close(ws) {
        wsClients.delete(ws)
        const dir = ws.data.rootDir
        const entry = dirWatchers.get(dir)
        // Only decrement refCount for non-primary project dirs (worktree dirs)
        const isPrimaryDir = [...registeredProjects.values()].includes(dir)
        if (entry && !isPrimaryDir) {
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
  registeredProjects.clear()
  defaultPrefix = ""
  activePort = 0
  server.stop(true)
  server = null
}

if (import.meta.main) {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
  const port = Number(process.env.PREVIEW_PORT ?? "17890")
  const startedPort = await startServer(port)
  const prefix = await registerProject(directory)
  console.log(`Preview server running at http://127.0.0.1:${startedPort}`)
  console.log(`  Project: ${path.resolve(directory)}`)
  console.log(`  Browse:  http://127.0.0.1:${startedPort}/${prefix}/`)
  console.log(`  Use ?worktree=name to preview a git worktree`)
}
