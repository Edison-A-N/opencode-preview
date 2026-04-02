import { describe, expect, test } from "bun:test"
import { ensureInsideRoot, isPreviewable, getCodeLanguage } from "../src/server"
import { renderMarkdownBody } from "../src/renderers/markdown"
import { renderCodeBody } from "../src/renderers/code"
import { renderHtmlBody } from "../src/renderers/html"

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
    const result = renderHtmlBody("my-project", "pages/index.html", "")
    expect(result).toContain('class="html-preview-body"')
    expect(result).toContain("<iframe")
    expect(result).toContain("/my-project/api/file?path=pages%2Findex.html")
    expect(result).toContain("sandbox=")
  })

  test("includes worktree params in iframe src", () => {
    const result = renderHtmlBody("proj", "page.html", "worktree=feature-branch")
    expect(result).toContain("/proj/api/file?path=page.html&worktree=feature-branch")
  })

  test("includes open in new tab link", () => {
    const result = renderHtmlBody("proj", "page.html", "")
    expect(result).toContain("Open in new tab")
    expect(result).toContain("target=\"_blank\"")
  })

  test("shows HTML Preview badge", () => {
    const result = renderHtmlBody("proj", "page.html", "")
    expect(result).toContain("HTML Preview")
    expect(result).toContain('class="html-badge"')
  })
})
