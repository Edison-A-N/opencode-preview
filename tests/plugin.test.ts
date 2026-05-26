import { describe, expect, test } from "bun:test"

import {
  addPreviewSystemPrompt,
  applyPreviewToolDefinition,
  buildPreviewUrl,
  PREVIEW_TOOL_DESCRIPTION,
  resolvePreviewInputPath,
  toProjectRelativePath,
} from "../src/index"

describe("preview plugin guidance", () => {
  test("adds a system prompt that requires using the preview tool", () => {
    const output = { system: ["existing instructions"] }

    addPreviewSystemPrompt(output)

    const prompt = output.system.at(-1)
    expect(prompt).toContain("MUST call the preview tool")
    expect(prompt).toContain("Markdown (.md)")
    expect(prompt).toContain("DrawIO (.drawio)")
    expect(prompt).toContain("PNG")
    expect(prompt).toContain("Do not manually construct preview URLs")
    expect(prompt).toContain("exact Preview URL")
  })

  test("keeps the enhanced preview tool description for LLM tool definitions", () => {
    const output = { description: "Preview a file" }

    applyPreviewToolDefinition({ toolID: "preview" }, output)

    expect(output.description).toBe(PREVIEW_TOOL_DESCRIPTION)
    expect(output.description).toContain("copy the returned Preview URL exactly")
  })

  test("does not change unrelated tool definitions", () => {
    const output = { description: "Write a file" }

    applyPreviewToolDefinition({ toolID: "write" }, output)

    expect(output.description).toBe("Write a file")
  })

  test("builds encoded preview URLs", () => {
    const url = buildPreviewUrl("http://localhost:17890", "project id", "docs/test file.md")

    expect(url).toBe("http://localhost:17890/preview?project=project%20id&file=docs%2Ftest%20file.md")
  })

  test("includes worktree when provided", () => {
    const url = buildPreviewUrl("http://localhost:17890", "project", "diagram.drawio", "feature/link-preview")

    expect(url).toBe(
      "http://localhost:17890/preview?project=project&file=diagram.drawio&worktree=feature%2Flink-preview",
    )
  })

  test("preserves explicit worktree preview paths as provided", () => {
    const url = buildPreviewUrl("http://localhost:17890", "project", "docs/readme.md", "feature/link-preview")

    expect(url).toContain("file=docs%2Freadme.md")
    expect(url).toContain("worktree=feature%2Flink-preview")
  })

  test("resolves preview input relative to tool context directory", () => {
    expect(resolvePreviewInputPath("docs/readme.md", "/workspace/project")).toBe("/workspace/project/docs/readme.md")
    expect(resolvePreviewInputPath("/tmp/outside.md", "/workspace/project")).toBe("/tmp/outside.md")
  })

  test("converts files inside the worktree to stable project-relative paths", () => {
    expect(toProjectRelativePath("/workspace/project/docs/readme.md", "/workspace/project")).toBe("docs/readme.md")
  })

  test("returns null for files outside the worktree", () => {
    expect(toProjectRelativePath("/tmp/outside.md", "/workspace/project")).toBeNull()
  })
})
