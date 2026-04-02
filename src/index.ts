import { tool, type Plugin, type PluginModule } from "@opencode-ai/plugin"

import { isPreviewable, registerProject, startServer } from "./server"

const DEFAULT_PORT = Number(process.env.PREVIEW_PORT ?? "17890")

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

export const server: Plugin = async ({ directory, client, $, worktree }) => {
  const projectDirectory = worktree || directory
  const port = await startServer(DEFAULT_PORT)
  const prefix = await registerProject(projectDirectory)
  const baseUrl = `http://localhost:${port}`

  await client.app.log({
    body: {
      service: "opencode-preview",
      level: "info",
      message: `Preview server started at ${baseUrl}/${prefix}/`,
      extra: { directory: projectDirectory, port, prefix },
    },
  })

  return {
    tool: {
      preview: tool({
        description: "Preview a file in the browser. Supports dir/worktree params to switch project context.",
        args: {
          file: tool.schema.string().describe("Relative path to a previewable file (.md, .drawio, code files)"),
          worktree: tool.schema.string().optional().describe("Git worktree name to preview from (resolves via .git/worktrees/)"),
        },
        async execute(args) {
          const file = args.file.trim()
          const params = new URLSearchParams({ file })
          if (args.worktree) params.set("worktree", args.worktree)
          const url = `${baseUrl}/${prefix}/preview?${params.toString()}`
          await openInBrowser($, url)
          return `Preview URL: ${url}`
        },
      }),
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
