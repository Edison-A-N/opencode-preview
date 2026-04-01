import { describe, expect, test } from "bun:test"
import { ensureInsideRoot, isPreviewable, getCodeLanguage } from "../src/server"
import { renderMarkdownBody } from "../src/renderers/markdown"
import { renderCodeBody } from "../src/renderers/code"

describe("isPreviewable", () => {
  test("accepts markdown files", () => {
    expect(isPreviewable("README.md")).toBe(true)
    expect(isPreviewable("docs/guide.md")).toBe(true)
  })

  test("accepts drawio files", () => {
    expect(isPreviewable("diagram.drawio")).toBe(true)
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
