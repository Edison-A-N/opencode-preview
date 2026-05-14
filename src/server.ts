import { type FSWatcher, watch } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { WebSocket, WebSocketServer } from "ws"

import { renderCodeBody } from "./renderers/code"
import { renderCsvBody } from "./renderers/csv"
import { renderCommitDiff, renderDiffBody } from "./renderers/diff"
import { countDiagramPages } from "./renderers/drawio"
import { renderHtmlBody } from "./renderers/html"
import { renderMarkdownBody } from "./renderers/markdown"

const __dirname = (import.meta as any).dir ?? path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.join(__dirname, "templates")

let _stylesCss: string | undefined

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

function getAuthHeaders(): Record<string, string> {
  const pw = process.env.OPENCODE_SERVER_PASSWORD
  if (!pw) return {}
  const user = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  return { Authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}` }
}

async function fetchProjects(): Promise<ProjectInfo[]> {
  if (!opencodeServerUrl) return []
  try {
    const resp = await fetch(`${opencodeServerUrl}/project`, { headers: getAuthHeaders() })
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
    return readBranchFromHead(headPath)
  } catch {
    return "unknown"
  }
}

export async function getCurrentBranch(baseDir: string): Promise<string> {
  try {
    const gitPath = path.join(baseDir, ".git")
    const gitStat = await stat(gitPath)
    const headDir = gitStat.isDirectory()
      ? gitPath
      : path.resolve(baseDir, parseGitdirFile(await readFile(gitPath, "utf-8")))
    return readBranchFromHead(path.join(headDir, "HEAD"))
  } catch {
    return "unknown"
  }
}

function parseGitdirFile(content: string): string {
  const match = content.trim().match(/^gitdir:\s*(.+)$/)
  if (!match) throw new Error("Invalid .git file format")
  return match[1]
}

async function readBranchFromHead(headPath: string): Promise<string> {
  const headContent = (await readFile(headPath, "utf-8")).trim()
  const refMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/)
  if (refMatch) return refMatch[1]
  return headContent.slice(0, 8)
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

interface GitFileStatus {
  path: string
  status: string
  statusLabel: string
}

const GIT_STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Unmerged",
  "?": "Untracked",
  "!": "Ignored",
}

function gitStatusLabel(status: string): string {
  return GIT_STATUS_LABELS[status] ?? "Changed"
}

async function runGit(rootDir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", "-C", rootDir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

function normalizeGitPath(rawPath: string): string {
  const unquoted = rawPath.startsWith('"') && rawPath.endsWith('"') ? rawPath.slice(1, -1) : rawPath
  return unquoted.replace(/\\/g, "/")
}

function parsePorcelainLine(line: string): GitFileStatus | null {
  if (line.length < 4) return null
  const x = line[0]
  const y = line[1]
  const pathPart = line.slice(3).trim()
  if (!pathPart) return null

  let resolvedPath = pathPart
  if (pathPart.includes(" -> ")) {
    const parts = pathPart.split(" -> ")
    resolvedPath = parts[parts.length - 1]
  }

  let status = "?"
  if (x === "?" && y === "?") {
    status = "?"
  } else if (x !== " ") {
    status = x
  } else if (y !== " ") {
    status = y
  }

  return {
    path: normalizeGitPath(resolvedPath),
    status,
    statusLabel: gitStatusLabel(status),
  }
}

// --- Git log (commit history) ---

interface GitCommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
  branch: string | null
  tags: string[]
}

function parseDecorateRefs(decorate: string): { branch: string | null; tags: string[] } {
  if (!decorate) return { branch: null, tags: [] }
  const parts = decorate.split(",").map((s) => s.trim())
  let branch: string | null = null
  const tags: string[] = []
  for (const part of parts) {
    if (part.startsWith("HEAD -> ")) {
      branch = part.slice("HEAD -> ".length)
    } else if (part.startsWith("tag: ")) {
      tags.push(part.slice("tag: ".length))
    }
  }
  return { branch, tags }
}

async function gitLog(rootDir: string, count = 50): Promise<GitCommitInfo[]> {
  const SEP = "---GIT-RECORD-SEP---"
  const format = `%H%n%h%n%s%n%an%n%aI%n%D%n${SEP}`
  const result = await runGit(rootDir, ["log", `--format=${format}`, `-n`, String(count)])
  if (result.code !== 0) return []

  const commits: GitCommitInfo[] = []
  const records = result.stdout.split(SEP).filter((r) => r.trim())
  for (const record of records) {
    const lines = record.trim().split("\n")
    if (lines.length < 5) continue
    const [hash, shortHash, message, author, date, ...decorateLines] = lines
    const decorate = decorateLines.join(",").trim()
    const { branch, tags } = parseDecorateRefs(decorate)
    commits.push({ hash, shortHash, message, author, date, branch, tags })
  }
  return commits
}

interface CommitDetail {
  hash: string
  author: string
  date: string
  message: string
  diff: string
}

async function gitShow(rootDir: string, commitHash: string): Promise<CommitDetail> {
  if (!/^[0-9a-f]{4,40}$/i.test(commitHash)) {
    throw new Error("Invalid commit hash")
  }
  const BODY_SEP = "---COMMIT-BODY-END---"
  const format = `%H%n%an <%ae>%n%aI%n%B${BODY_SEP}`
  const result = await runGit(rootDir, ["show", `--format=${format}`, commitHash])
  if (result.code !== 0) {
    throw new Error(result.stderr || "Failed to get commit diff")
  }
  const raw = result.stdout
  const sepIdx = raw.indexOf(BODY_SEP)
  const metaBlock = sepIdx === -1 ? raw : raw.slice(0, sepIdx)
  const diff = sepIdx === -1 ? "" : raw.slice(sepIdx + BODY_SEP.length)
  const metaLines = metaBlock.split("\n")
  const hash = metaLines[0] || commitHash
  const author = metaLines[1] || ""
  const date = metaLines[2] || ""
  const message = metaLines.slice(3).join("\n").trim()
  return { hash, author, date, message, diff }
}

async function gitStatus(rootDir: string): Promise<GitFileStatus[]> {
  const result = await runGit(rootDir, ["status", "--porcelain=v1", "-uall"])
  if (result.code !== 0) return []

  const files: GitFileStatus[] = []
  const seen = new Set<string>()
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue
    const parsed = parsePorcelainLine(line)
    if (!parsed) continue
    if (seen.has(parsed.path)) continue
    seen.add(parsed.path)
    files.push(parsed)
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

function buildSyntheticUntrackedDiff(filePath: string, content: string): string {
  const normalized = content.replace(/\r\n/g, "\n")
  const lines = normalized.length === 0 ? [] : normalized.split("\n")
  const header = [
    `diff --git a/${filePath} b/${filePath}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${filePath}`,
  ]
  if (lines.length === 0) {
    return `${header.join("\n")}\n`
  }
  const body = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)]
  return `${[...header, ...body].join("\n")}\n`
}

async function gitDiff(rootDir: string, filePath: string): Promise<string> {
  // Validate path for ALL files (tracked and untracked) to prevent path traversal
  const absolutePath = ensureInsideRoot(rootDir, filePath)

  const statusResult = await runGit(rootDir, ["status", "--porcelain=v1", "-uall", "--", filePath])
  if (statusResult.code !== 0) {
    throw new Error(statusResult.stderr || "Failed to query git status")
  }

  const statusLine = statusResult.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
  const parsed = statusLine ? parsePorcelainLine(statusLine) : null
  if (parsed?.status === "?") {
    const content = await readFile(absolutePath, "utf-8")
    return buildSyntheticUntrackedDiff(filePath, content)
  }

  const diffResult = await runGit(rootDir, ["diff", "HEAD", "--", filePath])
  if (diffResult.code !== 0) {
    throw new Error(diffResult.stderr || "Failed to query git diff")
  }
  return diffResult.stdout
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

// --- Server-side sidebar rendering ---

const ICON_COLORS: Record<string, [string, string]> = {
  ".ts": ["#3178c6", "TS"], ".tsx": ["#3178c6", "TX"],
  ".js": ["#f1e05a", "JS"], ".cjs": ["#f1e05a", "JS"], ".mjs": ["#f1e05a", "JS"],
  ".jsx": ["#f1e05a", "JX"],
  ".html": ["#e34f26", "<>"], ".htm": ["#e34f26", "<>"],
  ".css": ["#1572b6", "#"], ".json": ["#cbcb41", "{}"],
  ".md": ["#42a5f5", "M↓"], ".py": ["#3572A5", "PY"],
  ".go": ["#00ADD8", "GO"], ".rs": ["#dea584", "RS"],
  ".drawio": ["#f08705", "D"], ".csv": ["#217346", "CSV"],
}

function fileIconSvg(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const match = ICON_COLORS[ext]
  const color = match ? match[0] : "#519aba"
  const text = match ? match[1] : ext.replace(".", "").substring(0, 2).toUpperCase() || "F"
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><path fill="${color}" d="M13.85 4.44l-3.28-3.3c-.19-.18-.43-.28-.71-.28H3.5c-.55 0-1 .45-1 1v12.28c0 .55.45 1 1 1h9c.55 0 1-.45 1-1V5.14c0-.26-.1-.51-.28-.7zM9.5 2.56L12.06 5H9.5V2.56zM12.5 14h-9V2.5h5V5.5h3.5v8.5z"/><text x="8" y="11" font-size="5" font-family="sans-serif" font-weight="bold" fill="${color}" text-anchor="middle">${text}</text></svg>`
}

interface FileTreeNode { [key: string]: string | FileTreeNode }

function buildFileTree(files: string[]): FileTreeNode {
  const root: FileTreeNode = {}
  for (const file of files) {
    const parts = file.split("/")
    let cursor = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1) { cursor[part] = file }
      else { if (!cursor[part] || typeof cursor[part] === "string") cursor[part] = {}; cursor = cursor[part] as FileTreeNode }
    }
  }
  return root
}

function renderFileTreeHtml(node: FileTreeNode, projectId: string, worktreeParams: string, currentFile: string, parentPath = ""): string {
  const entries = Object.entries(node).sort(([a], [b]) => a.localeCompare(b))
  const items = entries.map(([name, value]) => {
    if (typeof value === "string") {
      let href = `/preview?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(value)}`
      if (worktreeParams) href += `&${worktreeParams}`
      const active = value === currentFile ? " active" : ""
      return `<li class="file-item"><a href="${href}" class="file-link${active}" data-tooltip="${escapeHtml(value)}"><span class="file-icon">${fileIconSvg(value)}</span><span class="file-path">${escapeHtml(name)}</span></a></li>`
    }
    const folderPath = parentPath ? `${parentPath}/${name}` : name
    const hasActive = currentFile && JSON.stringify(value).includes(JSON.stringify(currentFile).slice(1, -1))
    const open = hasActive ? " open" : ""
    const inner = renderFileTreeHtml(value as FileTreeNode, projectId, worktreeParams, currentFile, folderPath)
    return `<li class="folder-item"><details data-folder-path="${escapeHtml(folderPath)}"${open}><summary>${escapeHtml(name)}</summary>${inner}</details></li>`
  })
  return `<ul class="file-tree">${items.join("")}</ul>`
}

const BRANCH_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 6.5v3M11 6.5C11 8 9.5 9.5 5 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="5" cy="5" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="11" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="5" r="1.5" stroke="currentColor" stroke-width="1.3"/></svg>'
const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 7L6 9.5L10.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const COPY_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 3A1.5 1.5 0 0 1 6 1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 11V3z" stroke="currentColor" stroke-width="1.3"/><path d="M3 4.5h-.5A1.5 1.5 0 0 0 1 6v7.5A1.5 1.5 0 0 0 2.5 15H10a1.5 1.5 0 0 0 1.5-1.5V13" stroke="currentColor" stroke-width="1.3"/></svg>'
const FOLDER_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.38a1 1 0 0 1 .72.3L8.42 3.7a1 1 0 0 0 .72.3H13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12.5v-9z" stroke="currentColor" stroke-width="1.2"/></svg>'

function renderWorktreeSwitcherHtml(worktrees: WorktreeInfo[], activeWt: string, projectId: string, defaultBranch: string): string {
  if (worktrees.length === 0) return ""
  const allOptions: { value: string; label: string }[] = [{ value: "", label: defaultBranch }]
  for (const wt of worktrees) allOptions.push({ value: wt.name, label: wt.branch ? `${wt.name} (${wt.branch})` : wt.name })
  const current = allOptions.find((o) => o.value === activeWt) ?? allOptions[0]

  const optionItems = allOptions.map((opt) => {
    const isActive = opt.value === activeWt
    const badge = opt.value === "" ? '<span class="wt-option-badge">default</span>' : ""
    let href = `/browse?project=${encodeURIComponent(projectId)}`
    if (opt.value) href += `&worktree=${encodeURIComponent(opt.value)}`
    return `<button class="wt-option" type="button" data-active="${isActive}" data-href="${escapeHtml(href)}"><span class="wt-option-check">${CHECK_SVG}</span><span class="wt-option-label">${escapeHtml(opt.label)}</span>${badge}</button>`
  }).join("")

  return `<div class="wt-switcher" id="sidebar-wt-switcher"><button class="wt-trigger" type="button" aria-expanded="false"><span class="wt-trigger-icon">${BRANCH_SVG}</span><span class="wt-trigger-name">${escapeHtml(current.label)}</span><span class="wt-trigger-chevron">${CHEVRON_SVG}</span></button><div class="wt-dropdown" data-open="false">${optionItems}</div></div>`
}

function renderCopyPathHtml(rootDir: string, projectId: string, projects: ProjectInfo[]): string {
  const projectName = rootDir.split("/").filter(Boolean).pop() || rootDir

  const sorted = [...projects].sort((a, b) =>
    (a.name ?? path.basename(a.worktree)).localeCompare(b.name ?? path.basename(b.worktree)),
  )
  const optionItems = sorted.map((p) => {
    const isActive = p.id === projectId
    const label = p.name ?? path.basename(p.worktree)
    const href = `/browse?project=${encodeURIComponent(p.id)}`
    const searchText = `${label} ${p.worktree}`.toLowerCase()
    return `<button class="wt-option project-option" type="button" data-active="${isActive}" data-href="${escapeHtml(href)}" data-search="${escapeHtml(searchText)}" title="${escapeHtml(p.worktree)}"><span class="wt-option-check">${CHECK_SVG}</span><span class="wt-option-label">${escapeHtml(label)}</span></button>`
  }).join("")

  const searchHtml = `<div class="project-search"><input type="text" class="project-search-input" placeholder="Search projects..." /></div>`
  const emptyHtml = `<div class="project-search-empty" style="display: none;">No projects found</div>`

  const switcher = `<div class="project-switcher" id="sidebar-project-switcher"><button class="copy-path-project project-trigger" type="button" aria-expanded="false" title="${escapeHtml(rootDir)}">${FOLDER_SVG}<span class="copy-path-name">${escapeHtml(projectName)}</span><span class="project-trigger-chevron">${CHEVRON_SVG}</span></button><div class="wt-dropdown project-dropdown" data-open="false">${searchHtml}${optionItems}${emptyHtml}</div></div>`

  return `<div class="copy-path-row">${switcher}<button class="copy-path-btn" id="copy-path-btn" type="button" title="${escapeHtml(rootDir)}">${COPY_SVG}<span>Copy Path</span></button></div>`
}

async function renderSidebarHtml(
  projectId: string,
  worktreeParams: string,
  currentFile: string,
  currentDiff: string,
  projectRootDir: string,
  rootDir: string,
): Promise<string> {
  const [files, worktrees, changesSidebar, projects, defaultBranch] = await Promise.all([
    collectPreviewFiles(rootDir),
    listWorktrees(projectRootDir),
    renderChangesSidebarHtml(projectId, worktreeParams, rootDir, currentDiff),
    fetchProjects(),
    getCurrentBranch(projectRootDir),
  ])
  const activeWt = new URLSearchParams(worktreeParams).get("worktree") || ""
  const wtHtml = renderWorktreeSwitcherHtml(worktrees, activeWt, projectId, defaultBranch)
  const cpHtml = renderCopyPathHtml(rootDir, projectId, projects)
  const treeHtml = files.length === 0
    ? '<div class="sidebar-loading">No files found.</div>'
    : renderFileTreeHtml(buildFileTree(files), projectId, worktreeParams, currentFile)
  const changesHtml = changesSidebar.html
  const defaultTab = currentDiff ? "changes" : "files"

  return `${wtHtml}${cpHtml}
  <div class="sidebar-tabs" id="sidebar-tabs">
    <button class="sidebar-tab${defaultTab === "files" ? " active" : ""}" data-tab="files" type="button">Files</button>
    <button class="sidebar-tab${defaultTab === "changes" ? " active" : ""}" data-tab="changes" type="button">Changes <span class="changes-count">${changesSidebar.count}</span></button>
    <button class="sidebar-tab" data-tab="commits" type="button">Commits</button>
  </div>
  <div class="sidebar-panel${defaultTab === "files" ? " active" : ""}" data-panel="files"><div class="sidebar-search-bar"><svg class="sidebar-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04z"/></svg><input type="text" class="sidebar-search-input" id="sidebar-file-search" placeholder="Search files..." autocomplete="off" /><kbd class="sidebar-search-kbd" id="sidebar-search-kbd">Ctrl P</kbd></div>${treeHtml}</div>
  <div class="sidebar-panel${defaultTab === "changes" ? " active" : ""}" data-panel="changes">${changesHtml}</div>
  <div class="sidebar-panel" data-panel="commits"><div class="sidebar-loading commits-placeholder">Click to load commits</div></div>`
}

function changeStatusClass(status: string): string {
  if (status === "A") return "status-added"
  if (status === "D") return "status-deleted"
  if (status === "M") return "status-modified"
  if (status === "?") return "status-untracked"
  if (status === "R") return "status-renamed"
  return "status-changed"
}

function renderChangesListHtml(
  projectId: string,
  worktreeParams: string,
  files: GitFileStatus[],
  currentDiff: string,
): string {
  if (files.length === 0) {
    return '<div class="sidebar-loading">No changes.</div>'
  }

  const items = files.map((entry) => {
    const active = entry.path === currentDiff ? " active" : ""
    let href = `/preview?project=${encodeURIComponent(projectId)}&diff=${encodeURIComponent(entry.path)}`
    if (worktreeParams) href += `&${worktreeParams}`
    return `<li class="change-item"><a href="${href}" class="change-link${active}" data-diff-path="${escapeHtml(entry.path)}" data-status="${escapeHtml(entry.status)}" title="${escapeHtml(entry.statusLabel)}"><span class="change-status-badge ${changeStatusClass(entry.status)}">${escapeHtml(entry.status)}</span><span class="file-path">${escapeHtml(entry.path)}</span></a></li>`
  })

  return `<ul class="changes-list">${items.join("")}</ul>`
}

async function renderChangesSidebarHtml(
  projectId: string,
  worktreeParams: string,
  rootDir: string,
  currentDiff = "",
): Promise<{ html: string; count: number }> {
  const files = await gitStatus(rootDir)
  return {
    html: renderChangesListHtml(projectId, worktreeParams, files, currentDiff),
    count: files.length,
  }
}

// --- Shell page (SPA) ---

async function renderShellPage(projectId: string, worktreeParams: string, rootDir: string, sidebarHtml: string, initialContent?: RenderResult): Promise<string> {
  const contentClass = initialContent ? initialContent.contentClass : "preview-content"
  const contentBody = initialContent ? initialContent.body : ""
  const title = initialContent?.title || "Preview"
  const css = await getStylesCss()
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>${css}</style>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" media="(prefers-color-scheme: light)" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github-dark.min.css" media="(prefers-color-scheme: dark)" />
  <script>
(function(){var s=localStorage.getItem("preview-sidebar-width");if(s){var w=parseInt(s,10);if(w>=160&&w<=window.innerWidth*0.5)document.documentElement.style.setProperty("--sidebar-w",w+"px")}})();
  </script>
</head>
<body>
  <div class="preview-layout">
    <nav id="preview-sidebar" class="preview-sidebar">${sidebarHtml}</nav>
    <div class="sidebar-resize-handle" id="sidebar-resize-handle"></div>
    <div class="preview-main-area">
      <div id="tab-bar" class="tab-bar"></div>
      <div id="preview-content" class="${contentClass}">${contentBody}</div>
    </div>
  </div>
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
  <script>
${shellScript(projectId, worktreeParams, rootDir)}
  </script>
</body>
</html>`
}

const MAX_TABS = Math.max(Number(process.env.PREVIEW_MAX_TABS ?? "10"), 1)

function shellScript(projectId: string, worktreeParams: string, rootDir: string): string {
  return `(function(){
  var projectId = ${JSON.stringify(projectId)};
  var worktreeParams = ${JSON.stringify(worktreeParams)};
  var rootDir = ${JSON.stringify(rootDir)};
  var MAX_TABS = ${MAX_TABS};
  var content = document.getElementById("preview-content");
  var sidebar = document.getElementById("preview-sidebar");
  var tabBar = document.getElementById("tab-bar");

  var tabs = [];
  var activeTabIndex = -1;
  var tabIdSeed = 0;
  var TAB_STORE_KEY = "preview-tabs:" + projectId + ":" + worktreeParams;

  function baseName(file) {
    if (!file) return "Untitled";
    var parts = file.split("/");
    return parts[parts.length - 1] || file;
  }

  function saveTabState() {
    try {
      var data = { tabs: tabs.map(function(t){ return { file: t.file, title: t.title, view: t.view || "file" }; }), active: activeTabIndex };
      localStorage.setItem(TAB_STORE_KEY, JSON.stringify(data));
    } catch(e) {}
  }

  function loadTabState() {
    try {
      var raw = localStorage.getItem(TAB_STORE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch(e) { return null; }
  }

  function renderTabBar() {
    if (!tabBar) return;
    tabBar.innerHTML = "";
    tabs.forEach(function(tab, i) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab-item" + (i === activeTabIndex ? " active" : "");
      btn.setAttribute("data-tab-index", String(i));

      var name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = (tab.view === "commit" ? tab.file.slice(0, 8) : baseName(tab.file)) + (tab.view === "diff" ? " (diff)" : tab.view === "commit" ? " (commit)" : "");
      name.title = tab.file || "Untitled";

      var close = document.createElement("span");
      close.className = "tab-close";
      close.textContent = "\\u00d7";
      close.setAttribute("data-tab-close", String(i));

      btn.appendChild(name);
      btn.appendChild(close);
      tabBar.appendChild(btn);

      btn.addEventListener("click", function(e) {
        if (e.target.closest && e.target.closest(".tab-close")) return;
        switchToTab(i);
      });

      close.addEventListener("click", function(e) {
        e.stopPropagation();
        closeTab(i);
      });
    });
  }

  function switchToTab(index) {
    if (index < 0 || index >= tabs.length) return;
    var prev = activeTabIndex;
    if (prev >= 0 && prev < tabs.length && content) {
      tabs[prev].cachedHtml = content.innerHTML;
      tabs[prev].cachedClass = content.className;
      tabs[prev].scrollTop = content.scrollTop || 0;
    }
    activeTabIndex = index;
    var tab = tabs[index];
    if (tab.cachedHtml !== undefined) {
      content.className = tab.cachedClass || "preview-content";
      content.innerHTML = tab.cachedHtml;
      content.scrollTop = tab.scrollTop || 0;
      initMermaid();
      content.querySelectorAll("pre code").forEach(function(b) { if (window.hljs) window.hljs.highlightElement(b); });
      initToc();
      initDrawio();
      document.title = tab.title || "Preview";
      updateSidebarActive(tab.file, tab.view || "file");
      renderTabBar();
      syncTabUrl();
      saveTabState();
    } else if (tab.file) {
      loadTabContent(tab, true);
    }
  }

  function loadTabContent(tab, doSwitch) {
    var params = new URLSearchParams();
    params.set("project", projectId);
    if (worktreeParams) {
      var wt = new URLSearchParams(worktreeParams);
      wt.forEach(function(v, k) { params.set(k, v); });
    }
    var apiUrl;
    if (tab.view === "commit") {
      params.set("commit", tab.file);
      apiUrl = "/api/render/commit?" + params.toString();
    } else {
      params.set("file", tab.file);
      apiUrl = (tab.view === "diff" ? "/api/render/diff?" : "/api/render?") + params.toString();
    }
    if (doSwitch) content.style.opacity = "0.5";
    fetch(apiUrl).then(function(resp) {
      if (!resp.ok) throw new Error(resp.status + "");
      return resp.json();
    }).then(function(data) {
      tab.title = data.title || "Preview";
      tab.cachedClass = data.contentClass || "preview-content";
      tab.cachedHtml = data.body;
      tab.scrollTop = 0;
      if (tabs[activeTabIndex] === tab) {
        content.className = tab.cachedClass;
        content.innerHTML = tab.cachedHtml;
        content.style.opacity = "";
        initMermaid();
        content.querySelectorAll("pre code").forEach(function(b) { if (window.hljs) window.hljs.highlightElement(b); });
        initToc();
        initDrawio();
        document.title = tab.title;
        updateSidebarActive(tab.file, tab.view || "file");
      }
      renderTabBar();
      syncTabUrl();
      saveTabState();
    }).catch(function() {
      tab.cachedClass = "preview-content";
      tab.cachedHtml = '<div class="browse-empty"><p>Failed to load content.</p></div>';
      if (tabs[activeTabIndex] === tab) {
        content.className = "preview-content";
        content.innerHTML = tab.cachedHtml;
        content.style.opacity = "";
      }
    });
  }

  function openTab(file) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].file === file && (tabs[i].view || "file") === "file") {
        switchToTab(i);
        return;
      }
    }
    if (tabs.length >= MAX_TABS) {
      alert("Already " + MAX_TABS + " tabs open. Close one first.");
      return;
    }
    var tab = { id: ++tabIdSeed, file: file, view: "file", title: file || "Preview", cachedHtml: undefined, cachedClass: undefined, scrollTop: 0 };
    tabs.push(tab);
    activeTabIndex = tabs.length - 1;
    renderTabBar();
    loadTabContent(tab, true);
  }

  function openDiffTab(file) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].file === file && (tabs[i].view || "file") === "diff") {
        switchToTab(i);
        return;
      }
    }
    if (tabs.length >= MAX_TABS) {
      alert("Already " + MAX_TABS + " tabs open. Close one first.");
      return;
    }
    var tab = { id: ++tabIdSeed, file: file, view: "diff", title: file + " (diff)", cachedHtml: undefined, cachedClass: undefined, scrollTop: 0 };
    tabs.push(tab);
    activeTabIndex = tabs.length - 1;
    renderTabBar();
    loadTabContent(tab, true);
  }

  function openCommitTab(hash) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].file === hash && (tabs[i].view || "file") === "commit") {
        switchToTab(i);
        return;
      }
    }
    if (tabs.length >= MAX_TABS) {
      alert("Already " + MAX_TABS + " tabs open. Close one first.");
      return;
    }
    var tab = { id: ++tabIdSeed, file: hash, view: "commit", title: hash.slice(0, 8) + " (commit)", cachedHtml: undefined, cachedClass: undefined, scrollTop: 0 };
    tabs.push(tab);
    activeTabIndex = tabs.length - 1;
    renderTabBar();
    loadTabContent(tab, true);
  }

  function closeTab(index) {
    if (index < 0 || index >= tabs.length) return;
    tabs.splice(index, 1);
    if (tabs.length === 0) {
      activeTabIndex = -1;
      content.className = "preview-content";
      content.innerHTML = '<div class="browse-empty"><p>Select a file from the sidebar to preview</p></div>';
      document.title = "Preview";
      updateSidebarActive("", "file");
      renderTabBar();
      syncTabUrl();
      saveTabState();
      return;
    }
    if (activeTabIndex >= tabs.length) activeTabIndex = tabs.length - 1;
    else if (activeTabIndex > index) activeTabIndex--;
    switchToTab(activeTabIndex);
  }

  function syncTabUrl() {
    var tab = tabs[activeTabIndex];
    var params = new URLSearchParams(window.location.search);
    params.set("project", projectId);
    if (tab && tab.file) {
      var view = tab.view || "file";
      params.delete("file");
      params.delete("diff");
      params.delete("commit");
      if (view === "diff") {
        params.set("diff", tab.file);
      } else if (view === "commit") {
        params.set("commit", tab.file);
      } else {
        params.set("file", tab.file);
      }
      history.replaceState(null, "", "/preview?" + params.toString());
    } else {
      params.delete("file");
      params.delete("diff");
      params.delete("commit");
      history.replaceState(null, "", "/browse?" + params.toString());
    }
  }

  // --- sidebar resize ---
  (function() {
    var handle = document.getElementById("sidebar-resize-handle");
    if (!sidebar || !handle) return;
    var KEY = "preview-sidebar-width";
    var dragging = false, startX = 0, startW = 0;
    handle.addEventListener("mousedown", function(e) {
      e.preventDefault(); dragging = true; startX = e.clientX; startW = sidebar.getBoundingClientRect().width;
      handle.classList.add("dragging"); document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    });
    document.addEventListener("mousemove", function(e) {
      if (!dragging) return;
      sidebar.style.width = Math.min(Math.max(startW + e.clientX - startX, 160), window.innerWidth * 0.5) + "px";
    });
    document.addEventListener("mouseup", function() {
      if (!dragging) return; dragging = false; handle.classList.remove("dragging");
      document.body.style.cursor = ""; document.body.style.userSelect = "";
      var finalW = Math.round(sidebar.getBoundingClientRect().width);
      localStorage.setItem(KEY, String(finalW));
      document.documentElement.style.setProperty("--sidebar-w", finalW + "px");
    });
  })();

  // --- sidebar folder state ---
  var FOLDER_KEY = "sidebar-folder-state:" + projectId + ":" + worktreeParams;
  function saveFolderState() {
    var open = [];
    sidebar.querySelectorAll("details[data-folder-path]").forEach(function(d) { if (d.open) open.push(d.getAttribute("data-folder-path")); });
    try { localStorage.setItem(FOLDER_KEY, JSON.stringify(open)); } catch(e) {}
  }
  function restoreFolderState() {
    var raw; try { raw = localStorage.getItem(FOLDER_KEY); } catch(e) { return; }
    if (!raw) return;
    var openSet = {}; var saved = JSON.parse(raw);
    for (var i = 0; i < saved.length; i++) openSet[saved[i]] = true;
    sidebar.querySelectorAll("details[data-folder-path]").forEach(function(d) { d.open = !!openSet[d.getAttribute("data-folder-path")]; });
    var activeLink = sidebar.querySelector("a.file-link.active");
    if (activeLink) { var el = activeLink.closest("details"); while (el) { el.open = true; el = el.parentElement ? el.parentElement.closest("details") : null; } }
  }
  restoreFolderState();
  var _isSearching = false;
  sidebar.addEventListener("toggle", function(e) { if (!_isSearching && e.target && e.target.tagName === "DETAILS") saveFolderState(); }, true);

  // --- file search / filter ---
  (function() {
    var searchInput = document.getElementById("sidebar-file-search");
    var kbdHint = document.getElementById("sidebar-search-kbd");
    if (!searchInput) return;
    var filesPanel = sidebar.querySelector('.sidebar-panel[data-panel="files"]');
    if (!filesPanel) return;

    // Update kbd hint for macOS
    if (kbdHint && /Mac|iPhone|iPad/.test(navigator.platform || "")) {
      kbdHint.textContent = "⌘ P";
    }

    var _priorFolderState = null;

    function filterFileTree(query) {
      _isSearching = true;
      var allItems = filesPanel.querySelectorAll("li.file-item");
      var allFolders = filesPanel.querySelectorAll("li.folder-item");
      if (!query) {
        allItems.forEach(function(li) { li.classList.remove("search-hidden"); });
        allFolders.forEach(function(li) { li.classList.remove("search-hidden"); });
        if (_priorFolderState) {
          filesPanel.querySelectorAll("details[data-folder-path]").forEach(function(d) {
            d.open = !!_priorFolderState[d.getAttribute("data-folder-path")];
          });
          _priorFolderState = null;
        }
        _isSearching = false;
        saveFolderState();
        return;
      }
      if (!_priorFolderState) {
        _priorFolderState = {};
        filesPanel.querySelectorAll("details[data-folder-path]").forEach(function(d) {
          _priorFolderState[d.getAttribute("data-folder-path")] = d.open;
        });
      }
      var lowerQuery = query.toLowerCase();
      // Fuzzy: check if all chars appear in order
      function fuzzyMatch(text, q) {
        var ti = 0;
        for (var qi = 0; qi < q.length; qi++) {
          var idx = text.indexOf(q[qi], ti);
          if (idx === -1) return false;
          ti = idx + 1;
        }
        return true;
      }
      // First pass: mark matching files
      var matchedFiles = new Set();
      allItems.forEach(function(li) {
        var link = li.querySelector("a.file-link");
        var filePath = link ? (link.getAttribute("data-tooltip") || "").toLowerCase() : "";
        var fileName = filePath.split("/").pop() || "";
        var matched = filePath.includes(lowerQuery) || fuzzyMatch(fileName, lowerQuery);
        if (matched) { li.classList.remove("search-hidden"); matchedFiles.add(li); }
        else { li.classList.add("search-hidden"); }
      });
      allFolders.forEach(function(li) {
        var hasVisible = matchedFiles.size > 0 && li.querySelector("li.file-item:not(.search-hidden)");
        if (hasVisible) { li.classList.remove("search-hidden"); } else { li.classList.add("search-hidden"); }
        var details = li.querySelector(":scope > details");
        if (details && hasVisible) details.open = true;
      });
    }

    var _searchTimer = null;
    searchInput.addEventListener("input", function() {
      var val = searchInput.value.trim();
      if (_searchTimer) clearTimeout(_searchTimer);
      _searchTimer = setTimeout(function() { filterFileTree(val); }, 80);
    });

    searchInput.addEventListener("keydown", function(e) {
      if (e.key === "Escape") {
        searchInput.value = "";
        filterFileTree("");
        searchInput.blur();
      }
    });

    // Ctrl+P / Cmd+P shortcut
    document.addEventListener("keydown", function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "p") {
        e.preventDefault();
        // Switch to files tab if not active
        if (sidebar.__setSidebarTab) sidebar.__setSidebarTab("files");
        searchInput.focus();
        searchInput.select();
      }
    });

    // Hide kbd hint when input is focused
    searchInput.addEventListener("focus", function() {
      if (kbdHint) kbdHint.style.display = "none";
    });
    searchInput.addEventListener("blur", function() {
      if (kbdHint && !searchInput.value) kbdHint.style.display = "";
    });
  })();

  // --- sidebar files/changes tabs ---
  (function() {
    var tabButtons = sidebar.querySelectorAll(".sidebar-tab[data-tab]");
    if (!tabButtons.length) return;
    function setSidebarTab(name) {
      tabButtons.forEach(function(btn) {
        var active = btn.getAttribute("data-tab") === name;
        btn.classList.toggle("active", active);
      });
      sidebar.querySelectorAll(".sidebar-panel[data-panel]").forEach(function(panel) {
        var active = panel.getAttribute("data-panel") === name;
        panel.classList.toggle("active", active);
      });
    }
    tabButtons.forEach(function(btn) {
      btn.addEventListener("click", function() {
        var name = btn.getAttribute("data-tab") || "files";
        setSidebarTab(name);
        if (name === "commits") loadCommitsList();
      });
    });
    sidebar.__setSidebarTab = setSidebarTab;
  })();

  var _commitsLoaded = false;
  function loadCommitsList() {
    if (_commitsLoaded) return;
    _commitsLoaded = true;
    var panel = sidebar.querySelector('.sidebar-panel[data-panel="commits"]');
    if (!panel) return;
    panel.innerHTML = '<div class="sidebar-loading">Loading commits...</div>';
    var params = new URLSearchParams();
    params.set("project", projectId);
    if (worktreeParams) {
      var wt = new URLSearchParams(worktreeParams);
      wt.forEach(function(v, k) { params.set(k, v); });
    }
    fetch("/api/git/log?" + params.toString()).then(function(resp) {
      if (!resp.ok) throw new Error(resp.status + "");
      return resp.json();
    }).then(function(data) {
      renderCommitsList(panel, data.commits || []);
    }).catch(function() {
      panel.innerHTML = '<div class="sidebar-loading">Failed to load commits.</div>';
      _commitsLoaded = false;
    });
  }

  function formatCommitDate(isoStr) {
    try {
      var d = new Date(isoStr);
      var now = new Date();
      var diffMs = now - d;
      var diffMin = Math.floor(diffMs / 60000);
      if (diffMin < 1) return "just now";
      if (diffMin < 60) return diffMin + "m ago";
      var diffHr = Math.floor(diffMin / 60);
      if (diffHr < 24) return diffHr + "h ago";
      var diffDay = Math.floor(diffHr / 24);
      if (diffDay < 30) return diffDay + "d ago";
      return d.toLocaleDateString();
    } catch(e) { return isoStr; }
  }

  function renderCommitsList(panel, commits) {
    if (!commits.length) {
      panel.innerHTML = '<div class="sidebar-loading">No commits found.</div>';
      return;
    }
    var list = document.createElement("ul");
    list.className = "commits-list";
    commits.forEach(function(c) {
      var li = document.createElement("li");
      li.className = "commit-item";

      var a = document.createElement("a");
      a.className = "commit-link";
      a.href = "#";
      a.setAttribute("data-commit-hash", c.hash);

      var topRow = document.createElement("div");
      topRow.className = "commit-top-row";

      var hashBadge = document.createElement("span");
      hashBadge.className = "commit-hash-badge";
      hashBadge.textContent = c.shortHash;
      topRow.appendChild(hashBadge);

      if (c.branch) {
        var branchBadge = document.createElement("span");
        branchBadge.className = "commit-branch-badge";
        branchBadge.textContent = c.branch;
        topRow.appendChild(branchBadge);
      }
      if (c.tags && c.tags.length) {
        c.tags.forEach(function(tag) {
          var tagBadge = document.createElement("span");
          tagBadge.className = "commit-tag-badge";
          tagBadge.textContent = tag;
          topRow.appendChild(tagBadge);
        });
      }

      var msg = document.createElement("div");
      msg.className = "commit-message";
      msg.textContent = c.message;

      var meta = document.createElement("div");
      meta.className = "commit-meta";
      meta.textContent = c.author + " \u00b7 " + formatCommitDate(c.date);

      a.appendChild(topRow);
      a.appendChild(msg);
      a.appendChild(meta);
      li.appendChild(a);
      list.appendChild(li);
    });
    panel.innerHTML = "";
    panel.appendChild(list);
  }

  sidebar.addEventListener("click", function(e) {
    var link = e.target.closest ? e.target.closest("a[data-commit-hash]") : null;
    if (!link) return;
    e.preventDefault();
    var hash = link.getAttribute("data-commit-hash");
    if (hash) openCommitTab(hash);
  });

  // --- worktree dropdown ---
  (function() {
    var container = document.getElementById("sidebar-wt-switcher");
    if (!container) return;
    var trigger = container.querySelector(".wt-trigger");
    var dropdown = container.querySelector(".wt-dropdown");
    if (!trigger || !dropdown) return;
    trigger.addEventListener("click", function(e) {
      e.stopPropagation();
      var open = dropdown.getAttribute("data-open") === "true";
      dropdown.setAttribute("data-open", open ? "false" : "true");
      trigger.setAttribute("aria-expanded", open ? "false" : "true");
    });
    document.addEventListener("click", function() { dropdown.setAttribute("data-open", "false"); trigger.setAttribute("aria-expanded", "false"); });
    dropdown.querySelectorAll(".wt-option").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var href = btn.getAttribute("data-href");
        if (href) window.location.href = href;
      });
    });
  })();

  // --- project switcher dropdown ---
  (function() {
    var container = document.getElementById("sidebar-project-switcher");
    if (!container) return;
    var trigger = container.querySelector(".project-trigger");
    var dropdown = container.querySelector(".project-dropdown");
    if (!trigger || !dropdown) return;
    var searchInput = container.querySelector(".project-search-input");
    var options = Array.from(dropdown.querySelectorAll(".project-option"));
    var emptyState = dropdown.querySelector(".project-search-empty");

    trigger.addEventListener("click", function(e) {
      e.stopPropagation();
      var open = dropdown.getAttribute("data-open") === "true";
      dropdown.setAttribute("data-open", open ? "false" : "true");
      trigger.setAttribute("aria-expanded", open ? "false" : "true");
      if (!open && searchInput) {
        searchInput.value = "";
        searchInput.dispatchEvent(new Event("input"));
        setTimeout(function() { searchInput.focus(); }, 50);
      }
    });

    if (searchInput) {
      searchInput.addEventListener("click", function(e) { e.stopPropagation(); });
      searchInput.addEventListener("input", function(e) {
        var val = (e.target.value || "").toLowerCase();
        var visibleCount = 0;
        options.forEach(function(opt) {
          var text = opt.getAttribute("data-search") || "";
          if (!val || text.indexOf(val) !== -1) {
            opt.style.display = "";
            visibleCount++;
          } else {
            opt.style.display = "none";
          }
        });
        if (emptyState) emptyState.style.display = visibleCount === 0 ? "block" : "none";
      });
    }

    dropdown.addEventListener("click", function(e) { e.stopPropagation(); });
    document.addEventListener("click", function() { dropdown.setAttribute("data-open", "false"); trigger.setAttribute("aria-expanded", "false"); });

    options.forEach(function(btn) {
      btn.addEventListener("click", function() {
        var href = btn.getAttribute("data-href");
        if (href) window.location.href = href;
      });
    });
  })();

  // --- copy path ---
  (function() {
    var btn = document.getElementById("copy-path-btn");
    if (!btn) return;
    btn.addEventListener("click", function() {
      var p = navigator.clipboard ? navigator.clipboard.writeText(rootDir) : Promise.resolve();
      p.then(function() {
        var label = btn.querySelector("span:last-child");
        if (!label) return;
        var prev = label.textContent; label.textContent = "Copied!"; btn.classList.add("copied");
        setTimeout(function() { label.textContent = prev; btn.classList.remove("copied"); }, 1500);
      });
    });
  })();

  // --- SPA router ---
  function updateSidebarActive(file, view) {
    sidebar.querySelectorAll("a.file-link.active").forEach(function(a) { a.classList.remove("active"); });
    sidebar.querySelectorAll("a.change-link.active").forEach(function(a) { a.classList.remove("active"); });
    if (!file) return;
    if (view === "diff") {
      if (sidebar.__setSidebarTab) sidebar.__setSidebarTab("changes");
      sidebar.querySelectorAll("a.change-link").forEach(function(a) {
        var diffPath = a.getAttribute("data-diff-path");
        if (diffPath === file) {
          a.classList.add("active");
          a.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
      });
      return;
    }
    if (view === "commit") {
      if (sidebar.__setSidebarTab) sidebar.__setSidebarTab("commits");
      loadCommitsList();
      sidebar.querySelectorAll("a.commit-link").forEach(function(a) {
        a.classList.remove("active");
        if (a.getAttribute("data-commit-hash") === file) {
          a.classList.add("active");
          a.scrollIntoView({ block: "nearest", behavior: "instant" });
        }
      });
      return;
    }
    if (sidebar.__setSidebarTab) sidebar.__setSidebarTab("files");
    sidebar.querySelectorAll("a.file-link").forEach(function(a) {
      var tooltip = a.getAttribute("data-tooltip");
      if (tooltip === file) {
        a.classList.add("active");
        var el = a.closest("details");
        while (el) { el.open = true; el = el.parentElement ? el.parentElement.closest("details") : null; }
        a.scrollIntoView({ block: "nearest", behavior: "instant" });
      }
    });
  }

  function updateChangesSidebar(files) {
    var panel = sidebar.querySelector('.sidebar-panel[data-panel="changes"]');
    if (!panel) return;
    var count = sidebar.querySelector(".changes-count");
    if (count) count.textContent = String(files.length);
    if (!files.length) {
      panel.innerHTML = '<div class="sidebar-loading">No changes.</div>';
      return;
    }
    var list = document.createElement("ul");
    list.className = "changes-list";
    function statusClass(status) {
      if (status === "A") return "status-added";
      if (status === "D") return "status-deleted";
      if (status === "M") return "status-modified";
      if (status === "?") return "status-untracked";
      if (status === "R") return "status-renamed";
      return "status-changed";
    }
    files.forEach(function(entry) {
      var li = document.createElement("li");
      li.className = "change-item";

      var a = document.createElement("a");
      a.className = "change-link";
      a.setAttribute("href", "/preview?project=" + encodeURIComponent(projectId) + "&diff=" + encodeURIComponent(entry.path) + (worktreeParams ? "&" + worktreeParams : ""));
      a.setAttribute("data-diff-path", entry.path);
      a.setAttribute("data-status", entry.status);
      a.title = entry.statusLabel || "Changed";

      var badge = document.createElement("span");
      badge.className = "change-status-badge " + statusClass(entry.status);
      badge.textContent = entry.status;

      var pathSpan = document.createElement("span");
      pathSpan.className = "file-path";
      pathSpan.textContent = entry.path;

      a.appendChild(badge);
      a.appendChild(pathSpan);
      li.appendChild(a);
      list.appendChild(li);
    });
    panel.innerHTML = "";
    panel.appendChild(list);

    var active = tabs[activeTabIndex];
    if (active && active.file && (active.view || "file") === "diff") {
      updateSidebarActive(active.file, "diff");
    }
  }

  var _refreshTimer = null;
  function _doRefreshChanges() {
    var params = new URLSearchParams();
    params.set("project", projectId);
    if (worktreeParams) {
      var wt = new URLSearchParams(worktreeParams);
      wt.forEach(function(v, k) { params.set(k, v); });
    }
    fetch("/api/git/status?" + params.toString()).then(function(resp) {
      if (!resp.ok) throw new Error(resp.status + "");
      return resp.json();
    }).then(function(data) {
      updateChangesSidebar(data.files || []);
    }).catch(function() {});
  }
  function refreshChangesList(immediate) {
    if (immediate) { _doRefreshChanges(); return; }
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function() {
      _refreshTimer = null;
      _doRefreshChanges();
    }, 300);
  }

  // intercept all sidebar and content link clicks
  document.addEventListener("click", function(e) {
    var a = e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href");
    if (!href || href.startsWith("http") || href.startsWith("#") || a.target === "_blank") return;
    if (href.startsWith("/preview?") || href.startsWith("/browse?")) {
      e.preventDefault();
      var u = new URL(href, window.location.origin);
      var file = u.searchParams.get("file") || "";
      var diff = u.searchParams.get("diff") || "";
      var commitParam = u.searchParams.get("commit") || "";
      if (commitParam) {
        openCommitTab(commitParam);
        return;
      }
      if (diff) {
        openDiffTab(diff);
        return;
      }
      if (file) {
        openTab(file);
      }
    }
  });

  window.addEventListener("popstate", function() {
    var params = new URLSearchParams(window.location.search);
    var file = params.get("file") || "";
    var diff = params.get("diff") || "";
    var commitParam = params.get("commit") || "";
    if (commitParam) {
      openCommitTab(commitParam);
      return;
    }
    if (diff) {
      openDiffTab(diff);
      return;
    }
    if (file) openTab(file);
  });

  // --- live reload WebSocket ---
  (function() {
    var wsParams = "project=" + encodeURIComponent(projectId) + (worktreeParams ? "&" + worktreeParams : "");
    var socket, timer;
    function connect() {
      var protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(protocol + "://" + window.location.host + "/ws?" + wsParams);
      socket.onmessage = function() {
    refreshChangesList(true);
        tabs.forEach(function(tab) {
          if (tab.file) {
            var isActive = tabs[activeTabIndex] === tab;
            loadTabContent(tab, isActive);
          }
        });
      };
      socket.onclose = function() { clearTimeout(timer); timer = setTimeout(connect, 1000); };
    }
    connect();
  })();

  // --- TOC init (called after content load) ---
  function initToc() {
    var tocNav = content.querySelector("#toc-nav");
    if (!tocNav) return;
    var scrollParent = content.querySelector(".preview-main") || content;
    var headings = (content.querySelector(".preview-main") || content).querySelectorAll("h1, h2, h3");
    if (!headings.length) { tocNav.remove(); return; }
    var list = tocNav.querySelector("ul");
    list.innerHTML = "";
    headings.forEach(function(h, i) {
      if (!h.id) h.id = "toc-id-" + i;
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + h.id; a.textContent = h.textContent; a.className = "toc-" + h.tagName.toLowerCase();
      a.addEventListener("click", function(e) { e.preventDefault(); document.getElementById(h.id).scrollIntoView({ behavior: "smooth" }); });
      li.appendChild(a); list.appendChild(li);
    });
    var links = list.querySelectorAll("a");
    var ticking = false;
    function updateActive() {
      var scrollTop = scrollParent.scrollTop; var cur = null;
      for (var j = 0; j < headings.length; j++) { if (headings[j].offsetTop - 80 <= scrollTop) cur = headings[j]; }
      if (cur) { links.forEach(function(l) { l.classList.remove("active"); }); var ac = list.querySelector('a[href="#' + cur.id + '"]'); if (ac) { ac.classList.add("active"); ac.scrollIntoView({ block: "nearest", behavior: "instant" }); } }
      ticking = false;
    }
    scrollParent.addEventListener("scroll", function() { if (!ticking) { ticking = true; requestAnimationFrame(updateActive); } });
    if (links.length) links[0].classList.add("active");
  }

  // --- drawio init (called after content load) ---
  var _drawioCleanups = [];

  function initDrawio() {
    // Always clean up previous instance first (even for non-drawio content)
    _drawioCleanups.forEach(function(fn) { fn(); });
    _drawioCleanups = [];

    var el = content.querySelector("#drawio-viewer");
    if (!el) return;
    var config = el.getAttribute("data-mxgraph");
    if (!config) return;

    // Extract raw XML from the config
    var parsedCfg = JSON.parse(config);
    var xml = parsedCfg.xml || '';
    if (!xml) return;

    // Base64-encode the XML to avoid HTML/JS escaping issues in Blob HTML
    var xmlB64 = btoa(unescape(encodeURIComponent(xml)));
    var isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

    // Strategy: Use viewer-static.min.js's showLocalLightbox() to get a fully
    // interactive EditorUi-based viewer (pan, zoom, pinch, pages, layers).
    // The inline GraphViewer deliberately disables all interaction (setPanning(false),
    // setEnabled(false)), but showLocalLightbox() creates a real EditorUi instance
    // that has native support for drag-pan, wheel-zoom, and pinch-zoom.
    var html = '<!DOCTYPE html><html><head>'
      + '<meta charset="utf-8">'
      + '<meta name="color-scheme" content="light dark">'
      + '<style>'
      + 'html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;'
      + 'background:' + (isDark ? '#1e1e1e' : '#fff') + '}'
      + '#mount{position:fixed;inset:0}'
      // Lightbox fills the iframe; hide any close/overlay chrome
      + '.geViewer{position:fixed!important;inset:0!important;margin:0!important;padding:0!important}'
      + (isDark
        ? '.geDiagramContainer svg{filter:invert(1) hue-rotate(180deg)}'
        : '')
      + '</style>'
      + '<script>'
      // Set asset paths so viewer-static resolves resources correctly in Blob iframe
      + 'window.DRAWIO_BASE_URL="https://viewer.diagrams.net";'
      + 'window.PROXY_URL=window.DRAWIO_BASE_URL+"/proxy";'
      + 'window.STYLE_PATH=window.DRAWIO_BASE_URL+"/styles";'
      + 'window.SHAPES_PATH=window.DRAWIO_BASE_URL+"/shapes";'
      + 'window.STENCIL_PATH=window.DRAWIO_BASE_URL+"/stencils";'
      + 'window.DRAW_MATH_URL=window.DRAWIO_BASE_URL+"/math4/es5";'
      + 'window.GRAPH_IMAGE_PATH=window.DRAWIO_BASE_URL+"/img";'
      + 'window.mxImageBasePath=window.DRAWIO_BASE_URL+"/mxgraph/images";'
      + 'window.mxBasePath=window.DRAWIO_BASE_URL+"/mxgraph";'
      + 'window.mxLoadStylesheets=false;'
      + '<\\/script>'
      + '</head><body>'
      + '<div id="mount"></div>'
      + '<script>'
      + 'function _init(){'
      + '  if(typeof GraphViewer==="undefined"||typeof mxUtils==="undefined")return;'
      + '  var xml=decodeURIComponent(escape(atob("' + xmlB64 + '")));'
      + '  var xmlDoc=mxUtils.parseXml(xml);'
      + '  var mount=document.getElementById("mount");'
      // Disable lightbox chrome (close button, overlay) so it fills the iframe
      + '  GraphViewer.prototype.lightboxChrome=false;'
      + '  var viewer=new GraphViewer(mount,xmlDoc.documentElement,{'
      + '    highlight:"' + (isDark ? '#818cf8' : '#4f46e5') + '",'
      + '    nav:true,resize:true,'
      + '    toolbar:"pages zoom layers",'
      + '    border:20,page:0,'
      + '    lightbox:false,'
      + '    "toolbar-nohide":true,'
      + '    "allow-zoom-in":true,'
      + '    "allow-zoom-out":true'
      + '  });'
      // showLocalLightbox() opens the interactive EditorUi viewer
      + '  viewer.showLocalLightbox();'
      // Hide the inert inline viewer underneath
      + '  mount.style.display="none";'
      + '}'
      + '<\\/script>'
      + '<script src="https://viewer.diagrams.net/js/viewer-static.min.js" onload="_init()"><\\/script>'
      + '</body></html>';

    var blob = new Blob([html], { type: 'text/html' });
    var blobUrl = URL.createObjectURL(blob);

    var iframe = document.createElement('iframe');
    iframe.style.cssText = 'width:100%;height:100%;border:none;display:block;border-radius:12px;';
    iframe.src = blobUrl;

    el.parentNode.replaceChild(iframe, el);

    _drawioCleanups.push(function() {
      URL.revokeObjectURL(blobUrl);
    });
  }

  var _mermaidId = 0;
  function initMermaid() {
    if (!window.mermaid) return;
    var nodes = content.querySelectorAll("pre code.language-mermaid, pre code.mermaid");
    if (!nodes.length) return;
    var divsToRender = [];
    nodes.forEach(function(codeEl) {
      var pre = codeEl.parentElement;
      var div = document.createElement("div");
      div.className = "mermaid";
      div.id = "mermaid-" + (++_mermaidId);
      div.textContent = codeEl.textContent;
      pre.parentElement.replaceChild(div, pre);
      divsToRender.push(div);
    });
    window.mermaid.initialize({ startOnLoad: false, theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "default" });
    window.mermaid.run({ nodes: divsToRender });
  }

  // --- initial content: hydrate tabs ---
  (function() {
    var params = new URLSearchParams(window.location.search);
    var initialFile = params.get("file") || "";
    var initialDiff = params.get("diff") || "";
    var initialCommit = params.get("commit") || "";
    var saved = loadTabState();

    if (initialFile || initialDiff || initialCommit) {
      var initialView = initialCommit ? "commit" : initialDiff ? "diff" : "file";
      var initialPath = initialCommit || initialDiff || initialFile;
      var tab = { id: ++tabIdSeed, file: initialPath, view: initialView, title: initialPath, cachedHtml: content.innerHTML.trim() ? content.innerHTML : undefined, cachedClass: content.innerHTML.trim() ? content.className : undefined, scrollTop: 0 };
      if (saved && saved.tabs && saved.tabs.length > 0) {
        tabs = saved.tabs.map(function(t) { return { id: ++tabIdSeed, file: t.file, view: t.view || "file", title: t.title || t.file, cachedHtml: undefined, cachedClass: undefined, scrollTop: 0 }; });
        var found = -1;
        for (var i = 0; i < tabs.length; i++) { if (tabs[i].file === initialPath && (tabs[i].view || "file") === initialView) { found = i; break; } }
        if (found >= 0) {
          tabs[found].cachedHtml = tab.cachedHtml;
          tabs[found].cachedClass = tab.cachedClass;
          activeTabIndex = found;
        } else {
          tabs.push(tab);
          activeTabIndex = tabs.length - 1;
        }
      } else {
        tabs = [tab];
        activeTabIndex = 0;
      }
      if (tab.cachedHtml) {
        initMermaid();
        content.querySelectorAll("pre code").forEach(function(b) { if (window.hljs) window.hljs.highlightElement(b); });
        initToc();
        initDrawio();
      }
      renderTabBar();
      updateSidebarActive(initialPath, initialView);
      saveTabState();
    } else if (saved && saved.tabs && saved.tabs.length > 0) {
      tabs = saved.tabs.map(function(t) { return { id: ++tabIdSeed, file: t.file, view: t.view || "file", title: t.title || t.file, cachedHtml: undefined, cachedClass: undefined, scrollTop: 0 }; });
      activeTabIndex = Math.min(Math.max(saved.active || 0, 0), tabs.length - 1);
      renderTabBar();
      if (tabs[activeTabIndex] && tabs[activeTabIndex].file) {
        loadTabContent(tabs[activeTabIndex], true);
      }
    } else {
      renderTabBar();
    }
    refreshChangesList();
  })();
})();`
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

const BROWSE_EMPTY_BODY = `<div class="browse-empty">
  <div class="browse-empty-icon">
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="6" y="10" width="36" height="28" rx="4" stroke="currentColor" stroke-width="2" opacity="0.25"/>
      <path d="M6 16h36" stroke="currentColor" stroke-width="2" opacity="0.15"/>
      <path d="M20 28l4-4 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" opacity="0.35"/>
      <path d="M24 24v10" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.35"/>
    </svg>
  </div>
  <p>Select a file from the sidebar to preview</p>
</div>`

interface RenderResult {
  title: string
  body: string
  contentClass: string
}

async function renderContent(projectId: string, rootDir: string, wtParams: string, filePath: string | null): Promise<RenderResult> {
  if (!filePath) {
    return { title: "Preview Browser", body: BROWSE_EMPTY_BODY, contentClass: "preview-content" }
  }

  const absolutePath = ensureInsideRoot(rootDir, filePath)
  const fileStat = await stat(absolutePath)
  if (!fileStat.isFile()) {
    return { title: "Preview Browser", body: BROWSE_EMPTY_BODY, contentClass: "preview-content" }
  }

  const extension = path.extname(absolutePath).toLowerCase()
  const fileContent = await readFile(absolutePath, "utf-8")

  if (extension === ".md") {
    const body = await renderMarkdownBody(fileContent)
    const tocHtml = '<nav id="toc-nav" class="toc-nav"><div class="toc-heading">On This Page</div><ul></ul></nav>'
    return {
      title: filePath,
      body: `<div class="preview-main">${body}</div>${tocHtml}`,
      contentClass: "preview-content preview-content-with-toc",
    }
  }

  if (extension === ".drawio") {
    const pages = countDiagramPages(fileContent)
    const pageLabel = pages === 1 ? "1 page" : `${pages} pages`
    const metaHtml = `<div class="drawio-meta"><span class="drawio-badge">DrawIO</span><span>${pageLabel}</span></div>`
    const body = `${metaHtml}<main class="drawio-container"><div id="drawio-viewer" class="mxgraph" data-mxgraph='${escapeHtml(JSON.stringify({
      highlight: "#4f46e5", nav: true, resize: true, toolbar: "pages zoom layers tags", border: 20, page: 0, lightbox: false, "toolbar-nohide": true, xml: fileContent,
    }))}'></div></main>`
    return { title: filePath, body, contentClass: "preview-content" }
  }

  if (extension === ".html" || extension === ".htm") {
    const body = renderHtmlBody(projectId, filePath, wtParams)
    return { title: filePath, body, contentClass: "preview-content" }
  }

  if (extension === ".csv") {
    const body = renderCsvBody(fileContent)
    return { title: filePath, body, contentClass: "preview-content" }
  }

  const lang = getCodeLanguage(absolutePath)
  if (lang) {
    const body = renderCodeBody(fileContent, lang)
    return { title: filePath, body, contentClass: "preview-content" }
  }

  return { title: "Preview Browser", body: BROWSE_EMPTY_BODY, contentClass: "preview-content" }
}

async function renderDiffContent(rootDir: string, filePath: string | null): Promise<RenderResult> {
  if (!filePath) {
    return { title: "Preview Browser", body: BROWSE_EMPTY_BODY, contentClass: "preview-content" }
  }

  const diff = await gitDiff(rootDir, filePath)
  const body = renderDiffBody(diff, filePath)
  return { title: `${filePath} (diff)`, body, contentClass: "preview-content" }
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

  // File browser (SPA shell)
  if (pathname === "/browse") {
    const sidebarHtml = await renderSidebarHtml(projectId, wtParams, "", "", projectRootDir, rootDir)
    const initialContent = await renderContent(projectId, rootDir, wtParams, null)
    sendResponse(res, 200, await renderShellPage(projectId, wtParams, rootDir, sidebarHtml, initialContent), {
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
    const [worktrees, defaultBranch] = await Promise.all([
      listWorktrees(projectRootDir),
      getCurrentBranch(projectRootDir),
    ])
    sendJson(res, { worktrees, defaultBranch })
    return
  }

  if (pathname === "/api/git/status") {
    const files = await gitStatus(rootDir)
    sendJson(res, { files })
    return
  }

  if (pathname === "/api/git/diff") {
    const filePath = url.searchParams.get("file") || ""
    if (!filePath) {
      sendResponse(res, 400, "Missing file query parameter")
      return
    }
    try {
      const diff = await gitDiff(rootDir, filePath)
      sendJson(res, { diff, file: filePath })
    } catch {
      sendJson(res, { diff: "", file: filePath }, 500)
    }
    return
  }

  if (pathname === "/api/git/log") {
    const count = Math.min(Math.max(Number(url.searchParams.get("count") ?? "50"), 1), 200)
    const commits = await gitLog(rootDir, count)
    sendJson(res, { commits })
    return
  }

  if (pathname === "/api/git/show") {
    const commit = url.searchParams.get("commit") || ""
    if (!commit) {
      sendResponse(res, 400, "Missing commit query parameter")
      return
    }
    try {
      const detail = await gitShow(rootDir, commit)
      sendJson(res, { diff: detail.diff, commit, hash: detail.hash, author: detail.author, date: detail.date, message: detail.message })
    } catch {
      sendJson(res, { diff: "", commit }, 500)
    }
    return
  }

  if (pathname === "/api/render/commit") {
    const commit = url.searchParams.get("commit") || ""
    if (!commit) {
      sendJson(res, { title: "Error", body: '<div class="browse-empty"><p>Missing commit parameter.</p></div>', contentClass: "preview-content" }, 400)
      return
    }
    try {
      const detail = await gitShow(rootDir, commit)
      const body = renderCommitDiff(detail.diff, { hash: detail.hash, author: detail.author, date: detail.date, message: detail.message })
      sendJson(res, { title: `${commit.slice(0, 8)} (commit)`, body, contentClass: "preview-content" })
    } catch {
      sendJson(res, { title: "Error", body: '<div class="browse-empty"><p>Failed to load commit.</p></div>', contentClass: "preview-content" }, 500)
    }
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

  // Preview (SPA shell — content loaded client-side via /api/render)
  if (pathname === "/preview") {
    const relativePath = url.searchParams.get("file") || ""
    const diffPath = url.searchParams.get("diff") || ""
    const commitHash = url.searchParams.get("commit") || ""
    const sidebarHtml = await renderSidebarHtml(projectId, wtParams, relativePath, diffPath, projectRootDir, rootDir)
    let initialContent: RenderResult
    if (commitHash) {
      try {
        const detail = await gitShow(rootDir, commitHash)
        const body = renderCommitDiff(detail.diff, { hash: detail.hash, author: detail.author, date: detail.date, message: detail.message })
        initialContent = { title: `${commitHash.slice(0, 8)} (commit)`, body, contentClass: "preview-content" }
      } catch {
        initialContent = { title: "Error", body: '<div class="browse-empty"><p>Failed to load commit.</p></div>', contentClass: "preview-content" }
      }
    } else if (diffPath) {
      initialContent = await renderDiffContent(rootDir, diffPath)
    } else {
      initialContent = await renderContent(projectId, rootDir, wtParams, relativePath || null)
    }
    sendResponse(res, 200, await renderShellPage(projectId, wtParams, rootDir, sidebarHtml, initialContent), {
      "content-type": "text/html; charset=utf-8",
    })
    return
  }

  // API: render content fragment (JSON)
  if (pathname === "/api/render") {
    const filePath = url.searchParams.get("file") || null
    try {
      const result = await renderContent(projectId, rootDir, wtParams, filePath)
      sendJson(res, result)
    } catch {
      sendJson(res, { title: "Error", body: '<div class="browse-empty"><p>Failed to render file.</p></div>', contentClass: "preview-content" }, 500)
    }
    return
  }

  if (pathname === "/api/render/diff") {
    const filePath = url.searchParams.get("file") || null
    try {
      const result = await renderDiffContent(rootDir, filePath)
      sendJson(res, result)
    } catch {
      sendJson(res, { title: "Error", body: '<div class="browse-empty"><p>Failed to render diff.</p></div>', contentClass: "preview-content" }, 500)
    }
    return
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
