import { type FSWatcher, watch } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { WebSocket, WebSocketServer } from "ws"

import { renderCodeBody } from "./renderers/code"
import { renderCsvBody } from "./renderers/csv"
import { renderDrawioBody } from "./renderers/drawio"
import { renderHtmlBody } from "./renderers/html"
import { renderMarkdownBody } from "./renderers/markdown"

// Eagerly resolve template paths at module load time (import.meta.dir is
// correct when the module is first evaluated, but may become stale inside
// async request handlers in certain plugin host environments such as OpenCode).
const TEMPLATES_DIR = path.join(import.meta.dir, "templates")

// Lazy-loaded templates — read from disk on first HTTP request instead of at
// module load time so that importing this module never blocks plugin startup.
let _browserHtml: string | undefined
let _stylesCss: string | undefined

async function getBrowserHtml(): Promise<string> {
  if (_browserHtml === undefined) {
    _browserHtml = await readFile(path.join(TEMPLATES_DIR, "browser.html"), "utf-8")
  }
  return _browserHtml
}

async function getStylesCss(): Promise<string> {
  if (_stylesCss === undefined) {
    _stylesCss = await readFile(path.join(TEMPLATES_DIR, "styles.css"), "utf-8")
  }
  return _stylesCss
}

let server: import("node:http").Server | null = null
let wss: WebSocketServer | null = null
let activePort = 17890

// --- Project resolution via opencode API ---

let opencodeServerUrl: string | null = null

interface ProjectInfo {
  id: string
  worktree: string
  name?: string
  icon?: { color?: string }
}

const projectCache = new Map<string, { dir: string; time: number }>()
const PROJECT_CACHE_TTL = 60_000

async function fetchProjects(): Promise<ProjectInfo[]> {
  if (!opencodeServerUrl) return []
  try {
    const resp = await fetch(`${opencodeServerUrl}/project`)
    if (!resp.ok) return []
    return (await resp.json()) as ProjectInfo[]
  } catch {
    return []
  }
}

async function resolveProjectDir(projectId: string): Promise<string> {
  // Check cache first
  const cached = projectCache.get(projectId)
  if (cached && Date.now() - cached.time < PROJECT_CACHE_TTL) {
    return cached.dir
  }

  const projects = await fetchProjects()
  // Update cache for all projects
  for (const p of projects) {
    projectCache.set(p.id, { dir: p.worktree, time: Date.now() })
  }

  const project = projects.find((p) => p.id === projectId)
  if (!project) {
    throw new Error(`Project not found: ${projectId}`)
  }
  return project.worktree
}

// --- File type detection ---

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

// --- File system helpers ---

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

interface WorktreeInfo {
  name: string
  branch: string
}

async function getWorktreeBranch(gitDir: string, worktreeName: string): Promise<string> {
  try {
    const headPath = path.join(gitDir, "worktrees", worktreeName, "HEAD")
    const headContent = (await readFile(headPath, "utf-8")).trim()
    const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/)
    if (refMatch) return refMatch[1]
    // Detached HEAD — show short hash
    return headContent.slice(0, 8)
  } catch {
    return "unknown"
  }
}

async function listWorktrees(baseDir: string): Promise<WorktreeInfo[]> {
  try {
    const gitDir = await findGitDir(baseDir)
    const worktreesDir = path.join(gitDir, "worktrees")
    const entries = await readdir(worktreesDir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))
    return Promise.all(
      dirs.map(async (e) => ({
        name: e.name,
        branch: await getWorktreeBranch(gitDir, e.name),
      })),
    )
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

// --- File watcher & WebSocket ---

const dirWatchers = new Map<string, { watchers: FSWatcher[]; refCount: number }>()
const wsClients = new Set<WebSocket>()
const wsClientMeta = new WeakMap<WebSocket, { rootDir: string }>()

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
    const metadata = wsClientMeta.get(client)
    if (metadata?.rootDir === changedDir && client.readyState === WebSocket.OPEN) {
      client.send(message)
    }
  }
}

async function ensureWatchers(dir: string): Promise<void> {
  const existing = dirWatchers.get(dir)
  if (existing) {
    existing.refCount++
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

// --- HTML helpers ---

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
    return map[ch]
  })
}

function createLiveReloadScript(projectId: string, worktreeParams: string): string {
  const wsParams = `project=${encodeURIComponent(projectId)}${worktreeParams ? `&${worktreeParams}` : ""}`
  return `<script>
(() => {
  let socket;
  let timer;
  const connect = () => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(protocol + "://" + window.location.host + "/ws?${wsParams}");
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

function createSidebarScript(projectId: string, currentFile: string, worktreeParams: string): string {
  const escaped = JSON.stringify(currentFile)
  const escapedProjectId = JSON.stringify(projectId)
  const escapedWorktreeParams = JSON.stringify(worktreeParams)
  return `<script>
(() => {
  const currentFile = ${escaped};
  const projectId = ${escapedProjectId};
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
    let href = "/preview?project=" + encodeURIComponent(projectId) + "&file=" + encodeURIComponent(file);
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
      let apiUrl = "/api/files?project=" + encodeURIComponent(projectId);
      if (worktreeParams) apiUrl += "&" + worktreeParams;
      const resp = await fetch(apiUrl);
      const data = await resp.json();
      const files = Array.isArray(data.files) ? data.files : [];

      let worktreeHtml = "";
      try {
        const wtResp = await fetch("/api/worktrees?project=" + encodeURIComponent(projectId));
        const wtData = await wtResp.json();
        const worktrees = Array.isArray(wtData.worktrees) ? wtData.worktrees : [];
        if (worktrees.length > 0) {
          const params = new URLSearchParams(worktreeParams);
          const activeWt = params.get("worktree") || "";
          worktreeHtml = '<div class="wt-switcher" id="sidebar-wt-switcher" data-active="' + escapeHtml(activeWt) + '" data-worktrees="' + escapeHtml(JSON.stringify(worktrees)) + '"></div>';
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
    const container = document.getElementById("sidebar-wt-switcher");
    if (!container) return;
    const activeWt = container.getAttribute("data-active") || "";
    const worktrees = JSON.parse(container.getAttribute("data-worktrees") || "[]");

    const branchSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 6.5v3M11 6.5C11 8 9.5 9.5 5 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="5" cy="5" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="11" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="5" r="1.5" stroke="currentColor" stroke-width="1.3"/></svg>';
    const chevronSvg = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const checkSvg = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 7L6 9.5L10.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    const allOptions = [{ value: "", label: "main" }];
    for (const wt of worktrees) {
      const label = (typeof wt === "object" && wt.branch) ? wt.name + " (" + wt.branch + ")" : (wt.name || wt);
      allOptions.push({ value: wt.name || wt, label: label });
    }
    const current = allOptions.find(function(o) { return o.value === activeWt; }) || allOptions[0];

    const trigger = document.createElement("button");
    trigger.className = "wt-trigger";
    trigger.type = "button";
    trigger.setAttribute("aria-expanded", "false");
    trigger.innerHTML = '<span class="wt-trigger-icon">' + branchSvg + '</span><span class="wt-trigger-name">' + escapeHtml(current.label) + '</span><span class="wt-trigger-chevron">' + chevronSvg + '</span>';

    const dropdown = document.createElement("div");
    dropdown.className = "wt-dropdown";
    dropdown.setAttribute("data-open", "false");

    for (const opt of allOptions) {
      const btn = document.createElement("button");
      btn.className = "wt-option";
      btn.type = "button";
      btn.setAttribute("data-active", opt.value === activeWt ? "true" : "false");
      const badge = opt.value === "" ? '<span class="wt-option-badge">default</span>' : "";
      btn.innerHTML = '<span class="wt-option-check">' + checkSvg + '</span><span class="wt-option-label">' + escapeHtml(opt.label) + '</span>' + badge;
      btn.addEventListener("click", function() {
        const url = new URL(window.location);
        if (opt.value) { url.searchParams.set("worktree", opt.value); }
        else { url.searchParams.delete("worktree"); }
        window.location.href = url.toString();
      });
      dropdown.appendChild(btn);
    }

    trigger.addEventListener("click", function(e) {
      e.stopPropagation();
      const open = dropdown.getAttribute("data-open") === "true";
      dropdown.setAttribute("data-open", open ? "false" : "true");
      trigger.setAttribute("aria-expanded", open ? "false" : "true");
    });

    document.addEventListener("click", function() {
      dropdown.setAttribute("data-open", "false");
      trigger.setAttribute("aria-expanded", "false");
    });

    container.appendChild(trigger);
    container.appendChild(dropdown);
  }

  loadSidebar();
})();
</script>`
}

function createTocScript(): string {
  return `<script>
(() => {
  const container = document.querySelector(".preview-main") || document.querySelector(".preview-content");
  if (!container) return;
  const headings = container.querySelectorAll("h1, h2, h3");
  const tocNav = document.getElementById("toc-nav");
  if (!tocNav || !headings.length) { if (tocNav) tocNav.remove(); return; }
  const list = tocNav.querySelector("ul");
  headings.forEach((h, i) => {
    if (!h.id) h.id = "toc-id-" + i;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = h.textContent;
    a.className = "toc-" + h.tagName.toLowerCase();
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(h.id).scrollIntoView({ behavior: "smooth" });
    });
    li.appendChild(a);
    list.appendChild(li);
  });
  const links = list.querySelectorAll("a");
  const scrollParent = document.querySelector(".preview-main") || document.querySelector(".preview-content");
  let ticking = false;
  function updateActive() {
    const scrollTop = scrollParent.scrollTop;
    let current = null;
    for (const h of headings) {
      if (h.offsetTop - 80 <= scrollTop) current = h;
    }
    if (current) {
      links.forEach(l => l.classList.remove("active"));
      const active = list.querySelector('a[href="#' + current.id + '"]');
      if (active) { active.classList.add("active"); active.scrollIntoView({ block: "nearest", behavior: "instant" }); }
    }
    ticking = false;
  }
  scrollParent.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(updateActive); } });
  if (links.length) links[0].classList.add("active");
})();
</script>`
}

function wrapWithSidebar(projectId: string, title: string, innerBody: string, currentFile: string, worktreeParams: string, rootDir: string, hasToc = false): string {
  const tocHtml = hasToc
    ? `<nav id="toc-nav" class="toc-nav"><div class="toc-heading">On This Page</div><ul></ul></nav>`
    : ""
  const contentClass = hasToc ? "preview-content preview-content-with-toc" : "preview-content"
  const bodyWrapper = hasToc
    ? `<div class="preview-main">\n        <div class="dir-indicator"><code>${escapeHtml(rootDir)}</code></div>\n        ${innerBody}\n      </div>\n      ${tocHtml}`
    : `<div class="dir-indicator"><code>${escapeHtml(rootDir)}</code></div>\n        ${innerBody}`
  const tocScript = hasToc ? createTocScript() : ""
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/styles.css" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" media="(prefers-color-scheme: light)" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" media="(prefers-color-scheme: dark)" />
  </head>
  <body>
    <div class="preview-layout">
      <nav id="preview-sidebar" class="preview-sidebar"></nav>
      <div class="${contentClass}">
        ${bodyWrapper}
      </div>
    </div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
    <script>document.querySelectorAll("pre code").forEach(b => window.hljs?.highlightElement(b));</script>
    ${createSidebarScript(projectId, currentFile, worktreeParams)}
    ${tocScript}
    ${createLiveReloadScript(projectId, worktreeParams)}
  </body>
</html>`
}

function contentTypeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".md") return "text/markdown; charset=utf-8"
  if (ext === ".drawio") return "application/xml; charset=utf-8"
  if (ext === ".csv") return "text/csv; charset=utf-8"
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8"
  return "text/plain; charset=utf-8"
}

// --- HTTP helpers ---

function parseRequestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? `127.0.0.1:${activePort}`
  return new URL(req.url ?? "/", `http://${host}`)
}

function sendResponse(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, headers)
  res.end(body)
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  sendResponse(res, status, JSON.stringify(payload), { "content-type": "application/json; charset=utf-8" })
}

// --- Project list page ---

function renderProjectListPage(projects: ProjectInfo[]): string {
  const sortedProjects = projects.sort((a, b) =>
    (a.name ?? path.basename(a.worktree)).localeCompare(b.name ?? path.basename(b.worktree)),
  )

  const projectItems = sortedProjects
    .map((p) => {
      const name = escapeHtml(p.name ?? path.basename(p.worktree))
      const dir = escapeHtml(p.worktree)
      const color = p.icon?.color ?? "var(--primary)"
      return `<li class="file-item" data-name="${name.toLowerCase()}" data-dir="${dir.toLowerCase()}"><a href="/browse?project=${encodeURIComponent(p.id)}"><span class="file-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><rect x="1" y="2" width="14" height="12" rx="2" fill="${color}" opacity="0.15"/><path d="M1 4c0-1.1.9-2 2-2h3.5l1.5 2H13c1.1 0 2 .9 2 2v6c0 1.1-.9 2-2 2H3c-1.1 0-2-.9-2-2V4z" fill="none" stroke="${color}" stroke-width="1.2"/></svg></span><span class="file-path">${name}</span></a><div style="padding-left:2.4rem;font-size:0.78rem;color:var(--muted);margin-top:-2px">${dir}</div></li>`
    })
    .join("\n")

  const projectOptions = sortedProjects
    .map((p) => {
      const name = escapeHtml(p.name ?? path.basename(p.worktree))
      return `<option value="${encodeURIComponent(p.id)}">${name}</option>`
    })
    .join("\n")

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Preview — Projects</title>
    <link rel="stylesheet" href="/styles.css" />
    <style>
      .project-search-bar {
        position: relative;
        margin: 0 1.25rem 0.5rem;
      }
      .project-search-input {
        width: 100%;
        padding: 0.45rem 0.65rem 0.45rem 2rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg);
        color: var(--text);
        font-size: 0.85rem;
        outline: none;
        transition: border-color 0.15s;
      }
      .project-search-input:focus {
        border-color: var(--focus-border);
      }
      .project-search-input::placeholder {
        color: var(--muted);
        opacity: 0.7;
      }
      .project-search-icon {
        position: absolute;
        left: 0.6rem;
        top: 50%;
        transform: translateY(-50%);
        width: 14px;
        height: 14px;
        color: var(--muted);
        pointer-events: none;
        opacity: 0.6;
      }
      .project-quick-select {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin: 0 1.25rem 0.75rem;
      }
      .project-quick-select label {
        font-size: 0.78rem;
        color: var(--muted);
        white-space: nowrap;
      }
      .project-quick-select select {
        flex: 1;
        padding: 0.35rem 0.5rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--bg);
        color: var(--text);
        font-size: 0.82rem;
        outline: none;
        cursor: pointer;
      }
      .project-quick-select select:focus {
        border-color: var(--focus-border);
      }
      .file-item[data-hidden="true"] {
        display: none;
      }
      .search-no-results {
        color: var(--muted);
        padding: 0.75rem 1.25rem;
        font-size: 13px;
        display: none;
      }
    </style>
  </head>
  <body>
    <main class="browser-shell">
      <header class="browser-header">
        <h1>Preview Server</h1>
        <p class="project-path">Select a project to browse</p>
      </header>
      <div class="project-search-bar">
        <svg class="project-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04z"/></svg>
        <input type="text" class="project-search-input" id="project-search" placeholder="Search projects..." autocomplete="off" />
      </div>
      <div class="project-quick-select">
        <label for="project-jump">Jump to:</label>
        <select id="project-jump">
          <option value="">— select —</option>
          ${projectOptions}
        </select>
      </div>
      <section class="file-list-panel">
        <div class="panel-title-row">
          <h2>Projects</h2>
        </div>
        <ul id="file-list" class="file-list">
          <ul class="file-tree" style="padding:0.25rem 0.5rem" id="project-list">
            ${projectItems || '<li class="file-empty">No projects found. Is opencode running?</li>'}
          </ul>
        </ul>
        <div class="search-no-results" id="no-results">No matching projects found.</div>
      </section>
    </main>
    <script>
      (() => {
        const searchInput = document.getElementById("project-search");
        const jumpSelect = document.getElementById("project-jump");
        const items = document.querySelectorAll("#project-list > .file-item");
        const noResults = document.getElementById("no-results");

        searchInput.addEventListener("input", () => {
          const query = searchInput.value.toLowerCase().trim();
          let visible = 0;
          items.forEach(item => {
            const name = item.getAttribute("data-name") || "";
            const dir = item.getAttribute("data-dir") || "";
            const match = !query || name.includes(query) || dir.includes(query);
            item.setAttribute("data-hidden", match ? "false" : "true");
            if (match) visible++;
          });
          noResults.style.display = visible === 0 && query ? "block" : "none";
        });

        jumpSelect.addEventListener("change", () => {
          const val = jumpSelect.value;
          if (val) window.location.href = "/browse?project=" + val;
        });
      })();
    </script>
  </body>
</html>`
}

// --- Browser page ---

async function renderBrowserPage(projectId: string, rootDir: string, worktreeParams: string): Promise<string> {
  return (await getBrowserHtml())
    .replaceAll("{{PROJECT_DIRECTORY}}", rootDir)
    .replaceAll("{{PROJECT_ID}}", projectId)
    .replaceAll("{{WORKTREE_PARAMS}}", worktreeParams)
    .replace("</body>", `${createLiveReloadScript(projectId, worktreeParams)}</body>`)
}

// --- WebSocket close handler ---

function handleWebSocketClose(ws: WebSocket): void {
  wsClients.delete(ws)
  const dir = wsClientMeta.get(ws)?.rootDir
  if (!dir) return
  const entry = dirWatchers.get(dir)
  if (entry) {
    entry.refCount--
    if (entry.refCount <= 0) {
      closeWatchersForDir(dir)
    }
  }
}

// --- Main HTTP handler ---

async function handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseRequestUrl(req)
  const pathname = url.pathname

  // Static assets — no project needed
  if (pathname === "/styles.css") {
    sendResponse(res, 200, await getStylesCss(), { "content-type": "text/css; charset=utf-8" })
    return
  }

  // Project list page
  if (pathname === "/") {
    const projects = await fetchProjects()
    sendResponse(res, 200, renderProjectListPage(projects), { "content-type": "text/html; charset=utf-8" })
    return
  }

  // Projects API
  if (pathname === "/api/projects") {
    const projects = await fetchProjects()
    sendJson(res, projects)
    return
  }

  // --- All routes below require ?project= ---
  const projectId = url.searchParams.get("project")
  if (!projectId) {
    // Redirect to homepage instead of error
    res.writeHead(302, { Location: "/" })
    res.end()
    return
  }

  let projectRootDir: string
  try {
    projectRootDir = await resolveProjectDir(projectId)
  } catch {
    // Project not found — redirect to homepage
    res.writeHead(302, { Location: "/" })
    res.end()
    return
  }

  const wtParams = worktreeQueryString(url)

  let rootDir: string
  try {
    rootDir = await resolveRootDir(projectRootDir, url)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid directory"
    sendResponse(res, 400, message)
    return
  }

  // File browser
  if (pathname === "/browse") {
    sendResponse(res, 200, await renderBrowserPage(projectId, rootDir, wtParams), {
      "content-type": "text/html; charset=utf-8",
    })
    return
  }

  // File list API
  if (pathname === "/api/files") {
    const files = await collectPreviewFiles(rootDir)
    sendJson(res, { files, directory: rootDir })
    return
  }

  // Worktrees API
  if (pathname === "/api/worktrees") {
    const worktrees = await listWorktrees(projectRootDir)
    sendJson(res, { worktrees })
    return
  }

  // Raw file API
  if (pathname === "/api/file") {
    const relativePath = url.searchParams.get("path")
    if (!relativePath) {
      sendResponse(res, 400, "Missing path query parameter")
      return
    }

    try {
      const absolutePath = ensureInsideRoot(rootDir, relativePath)
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile() || !isPreviewable(absolutePath)) {
        sendResponse(res, 400, "File is not previewable")
        return
      }

      const raw = await readFile(absolutePath, "utf-8")
      sendResponse(res, 200, raw, { "content-type": contentTypeFromPath(absolutePath) })
      return
    } catch {
      sendResponse(res, 400, "Invalid file path")
      return
    }
  }

  // Preview
  if (pathname === "/preview") {
    const relativePath = url.searchParams.get("file")
    if (!relativePath) {
      res.writeHead(302, { Location: "/" })
      res.end()
      return
    }

    try {
      const absolutePath = ensureInsideRoot(rootDir, relativePath)
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile()) {
        res.writeHead(302, { Location: "/" })
        res.end()
        return
      }

      const extension = path.extname(absolutePath).toLowerCase()
      const content = await readFile(absolutePath, "utf-8")

      if (extension === ".md") {
        const body = await renderMarkdownBody(content)
        sendResponse(res, 200, wrapWithSidebar(projectId, relativePath, body, relativePath, wtParams, rootDir, true), {
          "content-type": "text/html; charset=utf-8",
        })
        return
      }

      if (extension === ".drawio") {
        const body = renderDrawioBody(content)
        sendResponse(res, 200, wrapWithSidebar(projectId, relativePath, body, relativePath, wtParams, rootDir), {
          "content-type": "text/html; charset=utf-8",
        })
        return
      }

      if (extension === ".html" || extension === ".htm") {
        const body = renderHtmlBody(projectId, relativePath, wtParams)
        sendResponse(res, 200, wrapWithSidebar(projectId, relativePath, body, relativePath, wtParams, rootDir), {
          "content-type": "text/html; charset=utf-8",
        })
        return
      }

      if (extension === ".csv") {
        const body = renderCsvBody(content)
        sendResponse(res, 200, wrapWithSidebar(projectId, relativePath, body, relativePath, wtParams, rootDir), {
          "content-type": "text/html; charset=utf-8",
        })
        return
      }

      const lang = getCodeLanguage(absolutePath)
      if (lang) {
        const body = renderCodeBody(content, lang)
        sendResponse(res, 200, wrapWithSidebar(projectId, relativePath, body, relativePath, wtParams, rootDir), {
          "content-type": "text/html; charset=utf-8",
        })
        return
      }

      sendResponse(res, 400, "Unsupported file type")
      return
    } catch {
      res.writeHead(302, { Location: "/" })
      res.end()
      return
    }
  }

  // WebSocket upgrade is handled separately
  if (pathname === "/ws") {
    sendResponse(res, 400, "WebSocket upgrade failed")
    return
  }

  sendResponse(res, 404, "Not Found")
}

// --- Server lifecycle ---

/**
 * Start the preview server.
 * @param port - Port to listen on (default: PREVIEW_PORT env or 17890)
 * @param serverUrl - OpenCode serve URL for project discovery (e.g. "http://localhost:10013")
 */
export async function startServer(port = Number(process.env.PREVIEW_PORT ?? "17890"), serverUrl?: string): Promise<number> {
  if (server) {
    // Server already running — just update the opencode URL if provided
    if (serverUrl) opencodeServerUrl = serverUrl
    return activePort
  }

  activePort = Number.isNaN(port) ? 17890 : port
  if (serverUrl) opencodeServerUrl = serverUrl

  const httpServer = createServer((req, res) => {
    void handleHttpRequest(req, res).catch((error) => {
      console.error("Request handling failed:", error)
      if (!res.headersSent) {
        sendResponse(res, 500, "Internal Server Error")
      } else {
        res.end()
      }
    })
  })
  server = httpServer

  const websocketServer = new WebSocketServer({ noServer: true })
  wss = websocketServer

  websocketServer.on("connection", (ws) => {
    wsClients.add(ws)
    ws.on("message", () => {})
    ws.on("close", () => {
      handleWebSocketClose(ws)
    })
  })

  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const url = parseRequestUrl(req)
      if (url.pathname !== "/ws") {
        socket.destroy()
        return
      }

      const projectId = url.searchParams.get("project")
      if (!projectId) {
        socket.destroy()
        return
      }

      let projectRootDir: string
      try {
        projectRootDir = await resolveProjectDir(projectId)
      } catch {
        socket.destroy()
        return
      }

      let rootDir: string
      try {
        rootDir = await resolveRootDir(projectRootDir, url)
      } catch {
        rootDir = projectRootDir
      }

      await ensureWatchers(rootDir)
      websocketServer.handleUpgrade(req, socket, head, (ws) => {
        wsClientMeta.set(ws, { rootDir })
        websocketServer.emit("connection", ws, req)
      })
    })().catch(() => {
      socket.destroy()
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      httpServer.off("listening", onListening)
      reject(error)
    }
    const onListening = () => {
      httpServer.off("error", onError)
      resolve()
    }
    httpServer.once("error", onError)
    httpServer.once("listening", onListening)
    httpServer.listen(activePort, "0.0.0.0")
  })

  return activePort
}

export function stopServer(): void {
  if (!server) return
  closeAllWatchers()
  for (const client of wsClients) {
    client.close()
  }
  wsClients.clear()
  projectCache.clear()
  opencodeServerUrl = null
  activePort = 0
  wss?.close()
  wss = null
  server.close()
  server = null
}

if (import.meta.main) {
  const directory = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
  const port = Number(process.env.PREVIEW_PORT ?? "17890")
  const ocUrl = process.env.OPENCODE_SERVER_URL
  const startedPort = await startServer(port, ocUrl)
  console.log(`Preview server running at http://127.0.0.1:${startedPort}`)
  if (ocUrl) {
    console.log(`  OpenCode API: ${ocUrl}`)
    console.log(`  Browse projects: http://127.0.0.1:${startedPort}/`)
  } else {
    console.log(`  Project: ${directory}`)
    console.log(`  Note: Set OPENCODE_SERVER_URL for auto-discovery`)
  }
}
