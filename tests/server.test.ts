import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { renderCodeBody } from "../src/renderers/code"
import { renderHtmlBody } from "../src/renderers/html"
import { renderMarkdownBody } from "../src/renderers/markdown"
import {
  ensureInsideRoot,
  getCodeLanguage,
  getCurrentBranch,
  isPreviewable,
  renderCopyPathHtmlForTest,
} from "../src/server"

describe("isPreviewable", () => {
  test("accepts markdown files", () => {
    expect(isPreviewable("README.md")).toBe(true)
    expect(isPreviewable("docs/guide.md")).toBe(true)
  })

  test("accepts drawio files", () => {
    expect(isPreviewable("diagram.drawio")).toBe(true)
  })

  test("accepts html files", () => {
    expect(isPreviewable("page.html")).toBe(true)
    expect(isPreviewable("index.htm")).toBe(true)
  })

  test("accepts code files", () => {
    expect(isPreviewable("index.ts")).toBe(true)
    expect(isPreviewable("main.py")).toBe(true)
    expect(isPreviewable("app.go")).toBe(true)
    expect(isPreviewable("style.css")).toBe(true)
    expect(isPreviewable("config.json")).toBe(true)
  })

  test("accepts special filenames", () => {
    expect(isPreviewable("Dockerfile")).toBe(true)
    expect(isPreviewable("Makefile")).toBe(true)
  })

  test("rejects non-previewable files", () => {
    expect(isPreviewable("image.png")).toBe(false)
    expect(isPreviewable("archive.zip")).toBe(false)
    expect(isPreviewable("binary.exe")).toBe(false)
  })
})

describe("getCodeLanguage", () => {
  test("returns correct language for extensions", () => {
    expect(getCodeLanguage("file.ts")).toBe("typescript")
    expect(getCodeLanguage("file.py")).toBe("python")
    expect(getCodeLanguage("file.rs")).toBe("rust")
    expect(getCodeLanguage("file.go")).toBe("go")
  })

  test("returns correct language for special filenames", () => {
    expect(getCodeLanguage("Dockerfile")).toBe("dockerfile")
    expect(getCodeLanguage("Makefile")).toBe("makefile")
  })

  test("returns null for non-code files", () => {
    expect(getCodeLanguage("file.md")).toBeNull()
    expect(getCodeLanguage("file.png")).toBeNull()
    expect(getCodeLanguage("file.html")).toBeNull()
    expect(getCodeLanguage("file.htm")).toBeNull()
  })
})

describe("ensureInsideRoot", () => {
  test("allows paths inside root", () => {
    const result = ensureInsideRoot("/project", "src/index.ts")
    expect(result).toBe("/project/src/index.ts")
  })

  test("allows root itself", () => {
    const result = ensureInsideRoot("/project", ".")
    expect(result).toBe("/project")
  })

  test("rejects path traversal", () => {
    expect(() => ensureInsideRoot("/project", "../etc/passwd")).toThrow("Path is outside of preview root")
  })

  test("rejects absolute paths outside root", () => {
    expect(() => ensureInsideRoot("/project", "/etc/passwd")).toThrow("Path is outside of preview root")
  })
})

describe("getCurrentBranch", () => {
  test("reads branch from a normal git directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-branch-"))
    await mkdir(path.join(dir, ".git"))
    await writeFile(path.join(dir, ".git", "HEAD"), "ref: refs/heads/feature/workspace\n")

    expect(await getCurrentBranch(dir)).toBe("feature/workspace")
  })

  test("reads branch from a linked worktree gitdir", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "preview-worktree-"))
    const gitDir = await mkdtemp(path.join(tmpdir(), "preview-gitdir-"))
    await writeFile(path.join(dir, ".git"), `gitdir: ${gitDir}\n`)
    await writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/actual-branch\n")

    expect(await getCurrentBranch(dir)).toBe("actual-branch")
  })
})

describe("renderMarkdownBody", () => {
  test("renders markdown to HTML", async () => {
    const result = await renderMarkdownBody("# Hello\n\nWorld")
    expect(result).toContain("<h1>")
    expect(result).toContain("Hello")
    expect(result).toContain("World")
    expect(result).toContain('class="markdown-body"')
  })

  test("handles empty content", async () => {
    const result = await renderMarkdownBody("")
    expect(result).toContain('class="markdown-body"')
  })
})

describe("renderCodeBody", () => {
  test("renders code with language tag", () => {
    const result = renderCodeBody("const x = 1", "typescript")
    expect(result).toContain('class="language-typescript"')
    expect(result).toContain("const x = 1")
  })

  test("escapes HTML in code", () => {
    const result = renderCodeBody("<script>alert('xss')</script>", "html")
    expect(result).toContain("&lt;script&gt;")
    expect(result).not.toContain("<script>alert")
  })

  test("shows line count", () => {
    const result = renderCodeBody("line1\nline2\nline3", "text")
    expect(result).toContain("3 lines")
  })
})

describe("renderHtmlBody", () => {
  test("renders iframe with correct src", () => {
    const result = renderHtmlBody("my-project-id", "pages/index.html", "")
    expect(result).toContain('class="html-preview-body"')
    expect(result).toContain("<iframe")
    expect(result).toContain("/api/file?project=my-project-id&path=pages%2Findex.html")
    expect(result).toContain("sandbox=")
  })

  test("includes worktree params in iframe src", () => {
    const result = renderHtmlBody("proj-id", "page.html", "worktree=feature-branch")
    expect(result).toContain("/api/file?project=proj-id&path=page.html&worktree=feature-branch")
  })

  test("includes open in new tab link", () => {
    const result = renderHtmlBody("proj-id", "page.html", "")
    expect(result).toContain("Open in new tab")
    expect(result).toContain("target=\"_blank\"")
  })

  test("shows HTML Preview badge", () => {
    const result = renderHtmlBody("proj-id", "page.html", "")
    expect(result).toContain("HTML Preview")
    expect(result).toContain('class="html-badge"')
  })
})


describe("renderCopyPathHtml", () => {
  test("shows project name when browsing a linked worktree", () => {
    const result = renderCopyPathHtmlForTest("/tmp/2026-05-17-sandbox-runtime", "proj-id", [
      { id: "proj-id", name: "eager-cactus", worktree: "/home/user/eager-cactus" },
    ])

    expect(result).toContain('<span class="copy-path-name">eager-cactus</span>')
    expect(result).toContain('title="/tmp/2026-05-17-sandbox-runtime"')
  })
})
