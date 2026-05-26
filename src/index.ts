import { stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { type Plugin, type PluginModule, tool } from "@opencode-ai/plugin"

import { buildExternalPreviewUrl, isPreviewable, registerExternalPreviewFile, startServer } from "./server"

const DEFAULT_PORT = Number(process.env.PREVIEW_PORT ?? "17890")
const DEFAULT_HOST = process.env.PREVIEW_HOST ?? "localhost"

export const PREVIEW_TOOL_DESCRIPTION =
  "Open a browser preview and return a Preview URL for previewable files such as Markdown, DrawIO, HTML, PNG, SVG, and code files. Use this after creating or editing previewable files, and copy the returned Preview URL exactly into the final response."

export const PREVIEW_SYSTEM_PROMPT = `When you create or modify previewable files such as Markdown (.md), DrawIO (.drawio), HTML, PNG, SVG, or source code files, you MUST call the preview tool for each relevant file before your final response.

Do not manually construct preview URLs. Use only the exact Preview URL returned by the preview tool, and include that exact URL in your final response.`

function resolveBaseUrl(host: string, port: number): string {
  return host.includes(":") ? `http://${host}` : `http://${host}:${port}`
}

export function buildPreviewUrl(baseUrl: string, projectId: string, file: string, worktree?: string): string {
  let url = `${baseUrl}/preview?project=${encodeURIComponent(projectId)}&file=${encodeURIComponent(file)}`
  if (worktree) url += `&worktree=${encodeURIComponent(worktree)}`
  return url
}

function expandHomePath(filePath: string): string {
  if (filePath === "~") return homedir()
  if (filePath.startsWith(`~${path.sep}`)) return path.join(homedir(), filePath.slice(2))
  return filePath
}

export function resolvePreviewInputPath(input: string, directory: string): string {
  const expanded = expandHomePath(input)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(directory, expanded))
}

export function toProjectRelativePath(absolutePath: string, worktree: string): string | null {
  const resolvedWorktree = path.resolve(worktree)
  const relative = path.relative(resolvedWorktree, absolutePath)
  if (relative === "") return "."
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null
  return relative.split(path.sep).join("/")
}

export function addPreviewSystemPrompt(output: { system: string[] }): void {
  output.system.push(PREVIEW_SYSTEM_PROMPT)
}

export function applyPreviewToolDefinition(input: { toolID: string }, output: { description: string }): void {
  if (input.toolID === "preview") {
    output.description = PREVIEW_TOOL_DESCRIPTION
  }
}

async function openInBrowser($: PluginContext["$"] | undefined, url: string): Promise<void> {
  if (!$) {
    return
  }

  const platform = process.platform
  try {
    if (platform === "darwin") {
      await $`open ${url}`.quiet()
      return
    }
    if (platform === "win32") {
      await $`cmd /c start ${url}`.quiet()
      return
    }
    await $`xdg-open ${url}`.quiet()
  } catch (error) {
    console.debug(`[opencode-preview] Failed to open browser: ${error}`)
  }
}

type PluginContext = Parameters<Plugin>[0]

export const server: Plugin = async ({ project, client, $, serverUrl }) => {
  const projectId = project.id

  // Defer server startup to background so plugin init returns immediately
  // and does not block opencode startup. The ready promise is awaited lazily
  // when the preview tool is first invoked.
  const ready = (async () => {
    const port = await startServer(DEFAULT_PORT, serverUrl.toString().replace(/\/$/, ""))
    const baseUrl = resolveBaseUrl(DEFAULT_HOST, port)

    client.app.log({
      body: {
        service: "opencode-preview",
        level: "info",
        message: `Preview server started at ${baseUrl}/browse?project=${projectId}`,
        extra: { projectId, port },
      },
    })

    return { port, baseUrl }
  })()

  return {
    tool: {
      preview: tool({
        description: PREVIEW_TOOL_DESCRIPTION,
        args: {
          file: tool.schema.string().describe("Path to a previewable file (.md, .drawio, .png, code files); relative, absolute, and ~ paths are supported"),
          worktree: tool.schema.string().optional().describe("Git worktree name to preview from (resolves via .git/worktrees/)"),
        },
        async execute(args, context) {
          const { baseUrl } = await ready
          const file = args.file.trim()
          if (args.worktree) {
            const url = buildPreviewUrl(baseUrl, projectId, file, args.worktree)
            await openInBrowser($, url)
            return `Preview URL: ${url}`
          }

          const absolutePath = resolvePreviewInputPath(file, context.directory)
          const projectRelativePath = toProjectRelativePath(absolutePath, context.worktree)
          let url: string

          if (projectRelativePath) {
            url = buildPreviewUrl(baseUrl, projectId, projectRelativePath, args.worktree)
          } else {
            const fileStat = await stat(absolutePath)
            if (!fileStat.isFile() || !isPreviewable(absolutePath)) {
              throw new Error("File is not previewable")
            }

            await context.ask({
              permission: "opencode-preview.external",
              patterns: [absolutePath],
              always: [path.dirname(absolutePath)],
              metadata: {
                title: `Preview external file ${absolutePath}`,
                file: absolutePath,
              },
            })

            const token = registerExternalPreviewFile(absolutePath, absolutePath)
            url = buildExternalPreviewUrl(baseUrl, token)
          }
          await openInBrowser($, url)
          return `Preview URL: ${url}`
        },
      }),
    },
    "experimental.chat.system.transform": async (_input, output) => {
      addPreviewSystemPrompt(output)
    },
    "tool.definition": async (input, output) => {
      applyPreviewToolDefinition(input, output)
    },
    event: async ({ event }) => {
      if (event.type !== "file.edited") {
        return
      }

      const filePath = String(event.properties?.file ?? "")
      if (!filePath || !isPreviewable(filePath)) {
        return
      }

      await client.app.log({
        body: {
          service: "opencode-preview",
          level: "debug",
          message: `Edited previewable file: ${filePath}`,
        },
      })
    },
  }
}

/** @deprecated Use `server` instead */
export const PreviewPlugin = server

export default { id: "opencode-preview", server } satisfies PluginModule
