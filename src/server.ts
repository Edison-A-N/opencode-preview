import { spawn } from "node:child_process"
import { type FSWatcher, watch } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocket, WebSocketServer } from "ws"

import { getFileIconSvg } from "./file-icons"
import { renderCodeBody } from "./renderers/code"
import { renderCsvBody } from "./renderers/csv"
import { renderCommitDiff, renderDiffBody } from "./renderers/diff"
import { countDiagramPages } from "./renderers/drawio"
import { renderHtmlBody } from "./renderers/html"
import { renderMarkdownBody } from "./renderers/markdown"

const moduleMeta = import.meta as ImportMeta & { dir?: string }
const __dirname = moduleMeta.dir ?? path.dirname(fileURLToPath(import.meta.url))
const TEMPLATES_DIR = path.join(__dirname, "templates")

let _stylesCss: string | undefined

async function getStylesCss(): Promise<string> {
  if (_stylesCss === undefined) {
    _stylesCss = await readFile(path.join(TEMPLATES_DIR, "styles.css"), "utf-8")
  }
  return _stylesCss
}

// --- Singleton server state (shared across module instances) ---
const SINGLETON_KEY = Symbol.for("opencode-preview-server-state")

interface ServerState {
  server: import("node:http").Server | null
  wss: WebSocketServer | null
  activePort: number
  startPromise: Promise<number> | null
  opencodeServerUrl: string | null
  stop: (() => void) | null
}

function getServerState(): ServerState {
  const g = globalThis as Record<symbol, ServerState | undefined>
  let state = g[SINGLETON_KEY]
  if (!state) {
    state = {
      server: null,
      wss: null,
      activePort: 17890,
      startPromise: null,
      opencodeServerUrl: null,
      stop: null,
    }
    g[SINGLETON_KEY] = state
  }
  return state
}

function resetServerState(state: ServerState): void {
  const websocketServer = state.wss
  const httpServer = state.server
  state.wss = null
  state.server = null
  state.activePort = 0
  state.opencodeServerUrl = null
  state.stop = null
  websocketServer?.close()
  if (httpServer?.listening) {
    httpServer.close()
  }
}

// --- Project resolution via opencode API ---

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
  const user = process.env.OPENCODE_SERVER_USERNAME || "opencode"
  return { Authorization: `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}` }
}

async function fetchProjects(): Promise<ProjectInfo[]> {
  const serverUrl = getServerState().opencodeServerUrl
  if (!serverUrl) return []
  try {
    const resp = await fetch(`${serverUrl}/project`, { headers: getAuthHeaders() })
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
  ".lock": "plaintext",
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
  "bun.lockb": "plaintext",
}

export function isPreviewable(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === ".md" || ext === ".drawio" || ext === ".html" || ext === ".htm" || ext === ".csv" || ext === ".png") return true
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

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".next", "__pycache__", ".venv", "venv"])

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

async function collectEmptyDirectories(directory: string, base = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const childDirectories = entries.filter((entry) => entry.isDirectory() && !IGNORED_DIRS.has(entry.name))
  const nested = await Promise.all(
    childDirectories.map(async (entry) => {
      const absolutePath = path.join(directory, entry.name)
      const childEntries = await readdir(absolutePath, { withFileTypes: true })
      const childResults = await collectEmptyDirectories(absolutePath, base)
      if (childEntries.length === 0) {
        return [path.relative(base, absolutePath).split(path.sep).join("/"), ...childResults]
      }
      return childResults
    }),
  )
  return nested.flat().sort((a, b) => a.localeCompare(b))
}

function isIgnoredTreePath(filePath: string): boolean {
  return filePath.split("/").some((part) => IGNORED_DIRS.has(part))
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
  return new Promise((resolve) => {
    const proc = spawn("git", ["-C", rootDir, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    proc.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    proc.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message })
    })
    proc.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      })
    })
  })
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


async function isGitWorkTree(rootDir: string): Promise<boolean> {
  const result = await runGit(rootDir, ["rev-parse", "--is-inside-work-tree"])
  return result.code === 0 && result.stdout.trim() === "true"
}

async function getFileCommitInfos(rootDir: string, files: string[]): Promise<Map<string, string>> {
  const commitMap = new Map<string, string>()
  if (files.length === 0 || !(await isGitWorkTree(rootDir))) {
    return commitMap
  }

  const batchSize = 50
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize)
    const batchSet = new Set(batch)
    const result = await runGit(rootDir, ["-c", "core.quotePath=false", "log", "--name-only", "--format=%x1e%h - %s", "--", ...batch])
    if (result.code !== 0) {
      continue
    }

    const records = result.stdout.split("\x1e").filter((record) => record.trim())
    for (const record of records) {
      const [commitInfo, ...changedFiles] = record.trim().split(/\r?\n/).filter(Boolean)
      if (!commitInfo) continue
      for (const changedFile of changedFiles) {
        const normalizedPath = normalizeGitPath(changedFile)
        if (batchSet.has(normalizedPath) && !commitMap.has(normalizedPath)) {
          commitMap.set(normalizedPath, commitInfo)
        }
      }
    }
  }
  return commitMap
}

async function gitStatus(rootDir: string, options: { includeIgnored?: boolean } = {}): Promise<GitFileStatus[]> {
  const args = ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-uall"]
  if (options.includeIgnored) args.push("--ignored")
  const result = await runGit(rootDir, args)
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

  const statusResult = await runGit(rootDir, ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-uall", "--", filePath])
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
const WATCHER_START_WARN_MS = 1000
const runtimeGlobals = globalThis as typeof globalThis & { Bun?: unknown }

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

function hasLiveClientForDir(dir: string): boolean {
  for (const client of wsClients) {
    const metadata = wsClientMeta.get(client)
    if (metadata?.rootDir === dir && client.readyState === WebSocket.OPEN) return true
  }
  return false
}

function watchPreviewDirectory(dir: string, directory: string, recursive: boolean): FSWatcher | null {
  try {
    const watcher = watch(directory, { recursive }, (_, filename) => {
      if (!filename || !isPreviewable(filename)) return
      broadcastChange(dir)
    })
    watcher.on("error", (error) => {
      console.warn(`[opencode-preview] File watcher disabled for ${directory}:`, error.message)
      watcher.close()
    })
    return watcher
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[opencode-preview] Failed to watch ${directory}:`, message)
    return null
  }
}

function shouldUseRecursiveWatcher(): boolean {
  return runtimeGlobals.Bun === undefined && process.platform !== "linux"
}

async function ensureWatchers(dir: string): Promise<void> {
  const existing = dirWatchers.get(dir)
  if (existing) {
    existing.refCount++
    return
  }

  const entry = { watchers: [] as FSWatcher[], refCount: 1 }
  dirWatchers.set(dir, entry)
  const startedAt = Date.now()

  const recursiveWatcher = shouldUseRecursiveWatcher() ? watchPreviewDirectory(dir, dir, true) : null
  if (recursiveWatcher) {
    entry.watchers.push(recursiveWatcher)
  } else {
    const directories = await listDirectories(dir)
    if (dirWatchers.get(dir) !== entry) return
    for (const d of directories) {
      const watcher = watchPreviewDirectory(dir, d, false)
      if (watcher) entry.watchers.push(watcher)
    }
  }

  const elapsed = Date.now() - startedAt
  if (elapsed > WATCHER_START_WARN_MS) {
    console.warn(`[opencode-preview] File watcher initialization for ${dir} took ${elapsed}ms (${entry.watchers.length} directories)`)
  }
}

function startWatchers(rootDir: string): void {
  setImmediate(() => {
    if (!hasLiveClientForDir(rootDir)) return
    void ensureWatchers(rootDir).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[opencode-preview] File watcher initialization failed for ${rootDir}:`, message)
      const entry = dirWatchers.get(rootDir)
      if (entry?.watchers.length === 0) {
        dirWatchers.delete(rootDir)
      }
    })
  })
}

// --- HTML helpers ---

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
    return map[ch]
  })
}

function safeProjectIconColor(color: string | undefined): string {
  if (!color) return "var(--primary)"
  return /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?$/.test(color) ? color : "var(--primary)"
}

// --- Server-side sidebar rendering ---

function fileIconSvg(filePath: string): string {
  return getFileIconSvg(filePath)
}

interface FileTreeNode { [key: string]: string | FileTreeNode | null }

function compareFileTreeEntries(
  [nameA, valueA]: [string, string | FileTreeNode | null],
  [nameB, valueB]: [string, string | FileTreeNode | null],
): number {
  const aIsFolder = typeof valueA !== "string"
  const bIsFolder = typeof valueB !== "string"

  if (aIsFolder !== bIsFolder) {
    return aIsFolder ? -1 : 1
  }

  return nameA.localeCompare(nameB)
}

function buildFileTree(files: string[], emptyDirectories: string[]): FileTreeNode {
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
  for (const directory of emptyDirectories) {
    const parts = directory.split("/")
    let cursor = root
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (i === parts.length - 1) {
        if (!cursor[part]) cursor[part] = null
      } else {
        if (!cursor[part] || typeof cursor[part] === "string") cursor[part] = {}
        cursor = cursor[part] as FileTreeNode
      }
    }
  }
  return root
}

function isUntrackedTreeNode(node: string | FileTreeNode | null, gitFilesMap: Map<string, GitFileStatus>, folderPath = ""): boolean {
  if (node === null) {
    return true
  }
  if (typeof node === "string") {
    const status = gitFilesMap.get(node)?.status
    return status === "?" || status === "!"
  }
  const folderStatus = folderPath ? gitFilesMap.get(folderPath)?.status : undefined
  if (folderStatus === "?" || folderStatus === "!") {
    return true
  }
  const children = Object.entries(node)
  return children.length > 0 && children.every(([name, child]) => {
    const childPath = folderPath ? `${folderPath}/${name}` : name
    return isUntrackedTreeNode(child, gitFilesMap, childPath)
  })
}

function renderFileTreeHtml(
  node: FileTreeNode,
  projectId: string,
  worktreeParams: string,
  currentFile: string,
  gitFilesMap: Map<string, GitFileStatus>,
  commitMap: Map<string, string>,
  parentPath = "",
): string {
  const entries = Object.entries(node).sort(compareFileTreeEntries)
  const items = entries.map(([name, value]) => {
    if (value === null) {
      const folderPath = parentPath ? `${parentPath}/${name}` : name
      return `<li class="folder-item folder-item-untracked folder-item-empty"><details data-folder-path="${escapeHtml(folderPath)}"><summary><span class="folder-name">${escapeHtml(name)}</span></summary></details></li>`
    }
    if (typeof value === "string") {
      let href = `/preview?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(value)}`
      if (worktreeParams) href += `&${worktreeParams}`
      const active = value === currentFile ? " active" : ""

      const gitStatus = gitFilesMap.get(value)
      const isUntracked = gitStatus?.status === "?" || gitStatus?.status === "!"
      const itemClass = isUntracked ? " file-item-untracked" : ""
      const commitInfo = commitMap.get(value)
      const commitMetaHtml = commitInfo ? `<span class="file-commit-info" title="${escapeHtml(commitInfo)}">${escapeHtml(commitInfo)}</span>` : ""
      const tooltip = escapeHtml(value) + (commitInfo ? ` &#10;${escapeHtml(commitInfo)}` : "")

      return `<li class="file-item${itemClass}"><a href="${href}" class="file-link${active}" data-file-path="${escapeHtml(value)}" data-tooltip="${tooltip}"><span class="file-icon">${fileIconSvg(value)}</span><span class="file-path">${escapeHtml(name)}</span>${commitMetaHtml}</a></li>`
    }
    const folderPath = parentPath ? `${parentPath}/${name}` : name
    const hasActive = currentFile && JSON.stringify(value).includes(JSON.stringify(currentFile).slice(1, -1))
    const open = hasActive ? " open" : ""
    const isUntrackedFolder = isUntrackedTreeNode(value, gitFilesMap, folderPath)
    const itemClass = isUntrackedFolder ? " folder-item-untracked" : ""
    const inner = renderFileTreeHtml(value, projectId, worktreeParams, currentFile, gitFilesMap, commitMap, folderPath)
    return `<li class="folder-item${itemClass}"><details data-folder-path="${escapeHtml(folderPath)}"${open}><summary><span class="folder-name">${escapeHtml(name)}</span></summary>${inner}</details></li>`
  })
  return `<ul class="file-tree">${items.join("")}</ul>`
}

const BRANCH_SVG = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M5 6.5v3M11 6.5C11 8 9.5 9.5 5 9.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="5" cy="5" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="11" r="1.5" stroke="currentColor" stroke-width="1.3"/><circle cx="11" cy="5" r="1.5" stroke="currentColor" stroke-width="1.3"/></svg>'
const CHEVRON_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CHECK_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 7L6 9.5L10.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const COPY_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 3A1.5 1.5 0 0 1 6 1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 11V3z" stroke="currentColor" stroke-width="1.3"/><path d="M3 4.5h-.5A1.5 1.5 0 0 0 1 6v7.5A1.5 1.5 0 0 0 2.5 15H10a1.5 1.5 0 0 0 1.5-1.5V13" stroke="currentColor" stroke-width="1.3"/></svg>'
const FOLDER_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 3.5A1.5 1.5 0 0 1 3 2h3.38a1 1 0 0 1 .72.3L8.42 3.7a1 1 0 0 0 .72.3H13a1.5 1.5 0 0 1 1.5 1.5v7a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12.5v-9z" stroke="currentColor" stroke-width="1.2"/></svg>'
const HOME_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M8 2.5L1.5 8M8 2.5l6.5 5.5M3.5 6.5v7h3v-4h3v4h3v-7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'

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
  const activeProject = projects.find((p) => p.id === projectId)
  const projectName = activeProject?.name ?? (activeProject ? path.basename(activeProject.worktree) : path.basename(rootDir))

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

  const homeBtn = `<a class="sidebar-home-btn" href="/" title="Projects Home" aria-label="Projects Home">${HOME_SVG}</a>`
  return `<div class="copy-path-row">${homeBtn}${switcher}<button class="copy-path-btn" id="copy-path-btn" type="button" title="${escapeHtml(rootDir)}">${COPY_SVG}<span>Copy Path</span></button><button id="sidebar-collapse-btn" class="sidebar-collapse-btn" type="button" title="Collapse Sidebar"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2 3.75C2 2.784 2.784 2 3.75 2h8.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-8.5ZM5.5 4v8h-1.5a.25.25 0 0 1-.25-.25v-8.5c0-.138.112-.25.25-.25H5.5Z"></path></svg></button></div>`
}

export function renderCopyPathHtmlForTest(rootDir: string, projectId: string, projects: ProjectInfo[]): string {
  return renderCopyPathHtml(rootDir, projectId, projects)
}

export function renderFileTreeHtmlForTest(files: string[], emptyDirectories: string[] = []): string {
  return renderFileTreeHtml(buildFileTree(files, emptyDirectories), "proj-id", "", "", new Map(), new Map())
}

async function renderSidebarHtml(
  projectId: string,
  worktreeParams: string,
  currentFile: string,
  currentDiff: string,
  projectRootDir: string,
  rootDir: string,
): Promise<string> {
  const [previewFiles, emptyDirectories, worktrees, gitFiles, ignoredGitFiles, projects, defaultBranch] = await Promise.all([
    collectPreviewFiles(rootDir),
    collectEmptyDirectories(rootDir),
    listWorktrees(projectRootDir),
    gitStatus(rootDir),
    gitStatus(rootDir, { includeIgnored: true }),
    fetchProjects(),
    getCurrentBranch(projectRootDir),
  ])
  const gitFilesMap = new Map(ignoredGitFiles.map((f) => [f.path, f]))
  const untrackedFiles = gitFiles
    .filter((f) => f.status === "?")
    .map((f) => f.path)
    .filter((filePath) => !isIgnoredTreePath(filePath))
  const untrackedFileSet = new Set(untrackedFiles)
  const files = [...new Set([...previewFiles, ...untrackedFiles])].sort((a, b) => a.localeCompare(b))
  const untrackedDirectories = emptyDirectories.filter((directory) => !isIgnoredTreePath(directory))
  const trackedFiles = files.filter((f) => !untrackedFileSet.has(f))
  const commitMap = await getFileCommitInfos(rootDir, trackedFiles)

  const changesSidebarHtml = renderChangesListHtml(projectId, worktreeParams, gitFiles, currentDiff)
  const changesCount = gitFiles.length

  const activeWt = new URLSearchParams(worktreeParams).get("worktree") || ""
  const wtHtml = renderWorktreeSwitcherHtml(worktrees, activeWt, projectId, defaultBranch)
  const cpHtml = renderCopyPathHtml(rootDir, projectId, projects)
  const treeHtml = files.length === 0 && untrackedDirectories.length === 0
    ? '<div class="sidebar-loading">No files found.</div>'
    : renderFileTreeHtml(buildFileTree(files, untrackedDirectories), projectId, worktreeParams, currentFile, gitFilesMap, commitMap)
  const changesHtml = changesSidebarHtml
  const defaultTab = currentDiff ? "changes" : "files"

  return `${wtHtml}${cpHtml}
  <div class="sidebar-tabs" id="sidebar-tabs">
    <button class="sidebar-tab${defaultTab === "files" ? " active" : ""}" data-tab="files" type="button">Files</button>
    <button class="sidebar-tab${defaultTab === "changes" ? " active" : ""}" data-tab="changes" type="button">Changes <span class="changes-count">${changesCount}</span></button>
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
(function(){
  var s=localStorage.getItem("preview-sidebar-width");
  if(s){var w=parseInt(s,10);if(w>=160&&w<=window.innerWidth*0.5)document.documentElement.style.setProperty("--sidebar-w",w+"px")}
})();
  </script>
</head>
<body>
  <div class="preview-layout" id="preview-layout">
    <script>
      (function(){
        if(localStorage.getItem("preview-sidebar-collapsed")==="true") {
          document.getElementById("preview-layout").classList.add("sidebar-collapsed");
        }
      })();
    </script>
    <div class="sidebar-rail" id="sidebar-rail"><button id="sidebar-expand-btn" class="sidebar-toggle-btn" type="button" title="Expand Sidebar"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M2 3.75C2 2.784 2.784 2 3.75 2h8.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 12.25 14h-8.5A1.75 1.75 0 0 1 2 12.25v-8.5Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h8.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25h-8.5ZM5.5 4v8h-1.5a.25.25 0 0 1-.25-.25v-8.5c0-.138.112-.25.25-.25H5.5Z"></path></svg></button></div>
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

  function getContentScrollElement() {
    return content.querySelector(".preview-main") || content;
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
      tabs[prev].scrollTop = getContentScrollElement().scrollTop || 0;
    }
    activeTabIndex = index;
    var tab = tabs[index];
    if (tab.cachedHtml !== undefined) {
      content.className = tab.cachedClass || "preview-content";
      content.innerHTML = tab.cachedHtml;
      getContentScrollElement().scrollTop = tab.scrollTop || 0;
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

  function loadTabContent(tab, doSwitch, options) {
    options = options || {};
    var preserveScroll = !!options.preserveScroll;
    var quiet = !!options.quiet;
    var isActiveTab = tabs[activeTabIndex] === tab;
    var scrollTop = preserveScroll ? (isActiveTab ? getContentScrollElement().scrollTop || 0 : tab.scrollTop || 0) : 0;
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
    if (doSwitch && !quiet) content.style.opacity = "0.5";
    fetch(apiUrl).then(function(resp) {
      if (!resp.ok) throw new Error(resp.status + "");
      return resp.json();
    }).then(function(data) {
      var nextClass = data.contentClass || "preview-content";
      var nextHtml = data.body;
      var contentChanged = tab.cachedClass !== nextClass || tab.cachedHtml !== nextHtml;
      tab.title = data.title || "Preview";
      tab.cachedClass = nextClass;
      tab.cachedHtml = nextHtml;
      tab.scrollTop = scrollTop;
      if (tabs[activeTabIndex] === tab && contentChanged) {
        content.className = tab.cachedClass;
        content.innerHTML = tab.cachedHtml;
        content.style.opacity = "";
        initMermaid();
        content.querySelectorAll("pre code").forEach(function(b) { if (window.hljs) window.hljs.highlightElement(b); });
        initToc();
        initDrawio();
        if (preserveScroll) {
          var scrollElement = getContentScrollElement();
          scrollElement.scrollTop = scrollTop;
          requestAnimationFrame(function() { getContentScrollElement().scrollTop = scrollTop; });
        }
        document.title = tab.title;
        updateSidebarActive(tab.file, tab.view || "file");
      } else if (tabs[activeTabIndex] === tab) {
        content.style.opacity = "";
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

  // --- sidebar toggle ---
  (function() {
    var expandBtn = document.getElementById("sidebar-expand-btn");
    var collapseBtn = document.getElementById("sidebar-collapse-btn");
    var layout = document.getElementById("preview-layout");
    var KEY = "preview-sidebar-collapsed";
    function toggleSidebar() {
      var isCollapsed = layout.classList.toggle("sidebar-collapsed");
      localStorage.setItem(KEY, isCollapsed ? "true" : "false");
    }
    if (expandBtn) expandBtn.addEventListener("click", toggleSidebar);
    if (collapseBtn) collapseBtn.addEventListener("click", toggleSidebar);
  })();

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
      // Identify matched folders
      var matchedFolders = new Set();
      allFolders.forEach(function(li) {
        var details = li.querySelector(":scope > details");
        var folderPath = details ? (details.getAttribute("data-folder-path") || "").toLowerCase() : "";
        var folderName = folderPath.split("/").pop() || "";
        if (folderPath.includes(lowerQuery) || fuzzyMatch(folderName, lowerQuery)) {
          matchedFolders.add(li);
        }
      });

      // Pass: mark matching files
      var matchedFiles = new Set();
      allItems.forEach(function(li) {
        var link = li.querySelector("a.file-link");
        var filePath = link ? (link.getAttribute("data-file-path") || "").toLowerCase() : "";
        var fileName = filePath.split("/").pop() || "";
        var matched = filePath.includes(lowerQuery) || fuzzyMatch(fileName, lowerQuery);
        if (matched) { li.classList.remove("search-hidden"); matchedFiles.add(li); }
        else { li.classList.add("search-hidden"); }
      });

      allFolders.forEach(function(li) {
        var hasVisible = matchedFiles.size > 0 && li.querySelector("li.file-item:not(.search-hidden)");
        var selfMatched = matchedFolders.has(li);
        if (hasVisible || selfMatched) { li.classList.remove("search-hidden"); } else { li.classList.add("search-hidden"); }
        var details = li.querySelector(":scope > details");
        if (details && (hasVisible || selfMatched)) details.open = true;
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
    var highlightIndex = -1;

    function updateHighlight() {
      var visibleOptions = options.filter(function(opt) { return opt.style.display !== "none"; });
      options.forEach(function(opt) { opt.removeAttribute("data-highlighted"); });
      if (visibleOptions.length > 0) {
        if (highlightIndex >= visibleOptions.length) highlightIndex = visibleOptions.length - 1;
        if (highlightIndex < 0) highlightIndex = 0;
        var active = visibleOptions[highlightIndex];
        active.setAttribute("data-highlighted", "true");
        if (active.scrollIntoView) {
          active.scrollIntoView({ block: "nearest" });
        }
      } else {
        highlightIndex = -1;
      }
    }

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
      searchInput.addEventListener("keydown", function(e) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          highlightIndex++;
          updateHighlight();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          highlightIndex--;
          updateHighlight();
        } else if (e.key === "Enter") {
          e.preventDefault();
          var visibleOptions = options.filter(function(opt) { return opt.style.display !== "none"; });
          if (highlightIndex >= 0 && highlightIndex < visibleOptions.length) {
            visibleOptions[highlightIndex].click();
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          dropdown.setAttribute("data-open", "false");
          trigger.setAttribute("aria-expanded", "false");
          trigger.focus();
        }
      });
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
        highlightIndex = 0;
        updateHighlight();
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
    var socket, timer, reloadTimer;
    function refreshOpenTabs() {
      reloadTimer = null;
      refreshChangesList(true);
      tabs.forEach(function(tab) {
        if (tab.file) {
          var isActive = tabs[activeTabIndex] === tab;
          loadTabContent(tab, isActive, { preserveScroll: true, quiet: true });
        }
      });
    }
    function connect() {
      var protocol = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(protocol + "://" + window.location.host + "/ws?" + wsParams);
      socket.onmessage = function() {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(refreshOpenTabs, 200);
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
  if (ext === ".png") return "image/png"
  if (ext === ".md") return "text/markdown; charset=utf-8"
  if (ext === ".drawio") return "application/xml; charset=utf-8"
  if (ext === ".csv") return "text/csv; charset=utf-8"
  if (ext === ".html" || ext === ".htm") return "text/html; charset=utf-8"
  return "text/plain; charset=utf-8"
}

// --- HTTP helpers ---

function parseRequestUrl(req: IncomingMessage): URL {
  const host = req.headers.host ?? `127.0.0.1:${getServerState().activePort}`
  return new URL(req.url ?? "/", `http://${host}`)
}

function sendResponse(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
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
  const sortedProjects = [...projects].sort((a, b) =>
    (a.name ?? path.basename(a.worktree)).localeCompare(b.name ?? path.basename(b.worktree)),
  )

  const projectItems = sortedProjects
    .map((p) => {
      const rawName = p.name ?? path.basename(p.worktree)
      const rawDir = p.worktree
      const name = escapeHtml(rawName)
      const dir = escapeHtml(rawDir)
      const searchName = escapeHtml(rawName.toLowerCase())
      const searchDir = escapeHtml(rawDir.toLowerCase())
      const color = safeProjectIconColor(p.icon?.color)
      return `<li class="project-card" data-name="${searchName}" data-dir="${searchDir}">
  <a href="/browse?project=${encodeURIComponent(p.id)}" class="project-card-link">
    <div class="project-card-icon">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="20" height="20">
        <rect x="1" y="2" width="14" height="12" rx="2" fill="${color}" opacity="0.15"/>
        <path d="M1 4c0-1.1.9-2 2-2h3.5l1.5 2H13c1.1 0 2 .9 2 2v6c0 1.1-.9 2-2 2H3c-1.1 0-2-.9-2-2V4z" fill="none" stroke="${color}" stroke-width="1.2"/>
      </svg>
    </div>
    <div class="project-card-content">
      <div class="project-card-name">${name}</div>
      <div class="project-card-path">${dir}</div>
    </div>
  </a>
</li>`
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
      body { background: var(--card); }
      .home-container {
        max-width: 800px;
        margin: 0 auto;
        padding: 4rem 1.5rem;
      }
      .home-header {
        margin-bottom: 2rem;
        text-align: center;
      }
      .home-header h1 {
        margin: 0 0 0.5rem;
        font-size: 2rem;
        font-weight: 600;
        letter-spacing: -0.02em;
        color: var(--text);
      }
      .home-header p {
        margin: 0;
        font-size: 1rem;
        color: var(--muted);
      }
      .home-controls {
        margin-bottom: 2rem;
      }
      .project-search-bar {
        position: relative;
       }
      .project-search-input {
        width: 100%;
        padding: 0.6rem 0.8rem 0.6rem 2.2rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--bg);
        color: var(--text);
        font-size: 0.95rem;
        outline: none;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .project-search-input:focus {
        border-color: var(--focus-border);
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus-border) 20%, transparent);
      }
      .project-search-input::placeholder {
        color: var(--muted);
        opacity: 0.7;
      }
      .project-search-icon {
        position: absolute;
        left: 0.8rem;
        top: 50%;
        transform: translateY(-50%);
        width: 16px;
        height: 16px;
        color: var(--muted);
        pointer-events: none;
        opacity: 0.6;
      }
      .home-stats {
        margin-bottom: 1rem;
        font-size: 0.85rem;
        font-weight: 500;
        color: var(--text);
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--border);
      }
      .project-grid {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
      }
      .project-card {
        border-bottom: 1px solid var(--border);
      }
      .project-card:last-child {
        border-bottom: none;
      }
      .project-card-link {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 1rem 0.5rem;
        text-decoration: none;
        color: inherit;
        border-radius: 6px;
        transition: background 0.15s;
      }
      .project-card-link:hover {
        background: var(--list-hover);
      }
      .project-card[data-active="true"] .project-card-link {
        background: var(--list-active);
        box-shadow: inset 3px 0 0 var(--primary);
      }
      .project-card-icon {
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 40px;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
      }
      .project-card-content {
        flex: 1;
        min-width: 0;
      }
      .project-card-name {
        font-size: 1rem;
        font-weight: 500;
        color: var(--text);
        margin-bottom: 0.2rem;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .project-card-path {
        font-size: 0.8rem;
        color: var(--muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .project-card[data-hidden="true"] {
        display: none;
      }
      .search-no-results, .file-empty {
        text-align: center;
        padding: 3rem 1rem;
        color: var(--muted);
        font-size: 0.95rem;
        background: var(--bg);
        border: 1px dashed var(--border);
        border-radius: 8px;
        margin-top: 1rem;
      }
      .search-no-results {
        display: none;
      }
    </style>
  </head>
  <body>
    <main class="home-container">
      <header class="home-header">
        <h1>Opencode Preview</h1>
        <p>Select a project to browse and preview its files.</p>
      </header>
      
      <div class="home-controls">
        <div class="project-search-bar">
          <svg class="project-search-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.74a6 6 0 1 1 1.06-1.06l3.04 3.04a.75.75 0 1 1-1.06 1.06l-3.04-3.04z"/></svg>
          <input type="text" class="project-search-input" id="project-search" placeholder="Search projects by name or path..." autocomplete="off" />
        </div>
      </div>

      <div class="home-stats" id="project-stats">
        ${sortedProjects.length} ${sortedProjects.length === 1 ? 'Project' : 'Projects'}
      </div>

      <ul id="project-list" class="project-grid">
        ${projectItems || '<li class="file-empty">No projects found. Is opencode running?</li>'}
      </ul>
      <div class="search-no-results" id="no-results">No matching projects found.</div>
    </main>
    <script>
      (() => {
        const searchInput = document.getElementById("project-search");
        const items = document.querySelectorAll("#project-list > .project-card");
        const noResults = document.getElementById("no-results");
        const stats = document.getElementById("project-stats");
        const total = items.length;
        let activeIndex = 0;

        const visibleItems = () => Array.from(items).filter(item => item.getAttribute("data-hidden") !== "true");

        function setActive(index) {
          const visible = visibleItems();
          items.forEach(item => item.removeAttribute("data-active"));
          if (visible.length === 0) {
            activeIndex = -1;
            return;
          }
          activeIndex = Math.max(0, Math.min(index, visible.length - 1));
          const active = visible[activeIndex];
          active.setAttribute("data-active", "true");
          if (active.scrollIntoView) active.scrollIntoView({ block: "nearest" });
        }

        function openActive() {
          const visible = visibleItems();
          if (activeIndex < 0 || activeIndex >= visible.length) return;
          const link = visible[activeIndex].querySelector("a.project-card-link");
          if (link) link.click();
        }

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
          stats.textContent = query 
            ? visible + " of " + total + " Projects" 
            : total + (total === 1 ? " Project" : " Projects");
          setActive(0);
        });

        searchInput.addEventListener("keydown", (event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive(activeIndex + 1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive(activeIndex - 1);
          } else if (event.key === "Enter") {
            event.preventDefault();
            openActive();
          }
        });

        items.forEach(item => {
          item.addEventListener("mouseenter", () => {
            const index = visibleItems().indexOf(item);
            if (index >= 0) setActive(index);
          });
        });

        setActive(0);
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

  if (!isPreviewable(absolutePath)) {
    return { title: "Preview Browser", body: BROWSE_EMPTY_BODY, contentClass: "preview-content" }
  }

  const extension = path.extname(absolutePath).toLowerCase()

  if (extension === ".png") {
    const apiPath = `/api/file?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(filePath)}`
    const rawUrl = wtParams ? `${apiPath}&${wtParams}` : apiPath
    const escapedUrl = escapeHtml(rawUrl)
    const escapedName = escapeHtml(path.basename(absolutePath))
    const body = `<div class="preview-image-container">
  <img src="${escapedUrl}" class="preview-image" alt="Image preview" />
  <div class="preview-image-actions">
    <a href="${escapedUrl}" download="${escapedName}" target="_blank">Open Original</a>
  </div>
</div>`
    return {
      title: filePath,
      body,
      contentClass: "preview-content preview-content-image",
    }
  }

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

      const ext = path.extname(absolutePath).toLowerCase()
      const raw = ext === ".png"
        ? await readFile(absolutePath)
        : await readFile(absolutePath, "utf-8")
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
  const state = getServerState()

  if (state.startPromise) {
    if (serverUrl) state.opencodeServerUrl = serverUrl
    return state.startPromise
  }

  if (state.server) {
    if (serverUrl) state.opencodeServerUrl = serverUrl
    return state.activePort
  }

  const startPromise = (async () => {
    const resolvedPort = Number.isNaN(port) ? 17890 : port
    state.activePort = resolvedPort
    if (serverUrl) state.opencodeServerUrl = serverUrl

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
    state.server = httpServer

    const websocketServer = new WebSocketServer({ noServer: true })
    state.wss = websocketServer

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

        websocketServer.handleUpgrade(req, socket, head, (ws) => {
          wsClientMeta.set(ws, { rootDir })
          websocketServer.emit("connection", ws, req)
          startWatchers(rootDir)
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
      httpServer.listen(resolvedPort, "0.0.0.0")
    })

    state.stop = () => {
      closeAllWatchers()
      for (const client of wsClients) {
        client.close()
      }
      wsClients.clear()
      projectCache.clear()
      resetServerState(state)
    }

    return resolvedPort
  })()

  state.startPromise = startPromise
  try {
    const result = await startPromise
    return result
  } catch (error) {
    resetServerState(state)
    throw error
  } finally {
    state.startPromise = null
  }
}

export function stopServer(): void {
  const state = getServerState()
  state.stop?.()
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
