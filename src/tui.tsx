import type { TuiPlugin, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"
import path from "node:path"
import { isPreviewable as serverIsPreviewable, registerProject } from "./server"

const DEFAULT_PORT = Number(process.env.PREVIEW_PORT ?? "17890")

function openUrl(url: string) {
  const platform = process.platform
  if (platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref()
  } else if (platform === "win32") {
    spawn("cmd", ["/c", "start", url], { stdio: "ignore", detached: true }).unref()
  } else {
    spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref()
  }
}

function isPreviewable(file: string): boolean {
  return serverIsPreviewable(file)
}

function getWorktreeName(worktreePath: string, directory: string): string | undefined {
  if (!worktreePath || worktreePath === directory) return undefined
  return path.basename(worktreePath)
}

function buildUrl(baseUrl: string, prefix: string, pathname: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v)
  }
  const query = qs.toString()
  const prefixedPath = `/${prefix}${pathname}`
  return query ? `${baseUrl}${prefixedPath}?${query}` : `${baseUrl}${prefixedPath}`
}

function previewUrl(baseUrl: string, prefix: string, file: string, worktree?: string): string {
  return buildUrl(baseUrl, prefix, "/preview", { file, worktree })
}

function browserUrl(baseUrl: string, prefix: string, worktree?: string): string {
  return buildUrl(baseUrl, prefix, "/", { worktree })
}

export const tui: TuiPlugin = async (api) => {
  const baseUrl = `http://localhost:${DEFAULT_PORT}`
  const directory = api.state.path.directory
  const prefixPromise = registerProject(directory)
  const worktree = getWorktreeName(api.state.path.worktree, directory)

  let resolvedPrefix: string | undefined

  async function getPrefix(): Promise<string> {
    if (resolvedPrefix === undefined) {
      resolvedPrefix = await prefixPromise
    }
    return resolvedPrefix
  }

  api.command.register(() => {
    const prefix = resolvedPrefix ?? directory.split("/").pop() ?? "project"
    const route = api.route.current
    if (route.name !== "session") return [openBrowserCommand(baseUrl, prefix, api, worktree, getPrefix)]

    const files = api.state.session.diff(route.params.sessionID)
    const previewable = files.filter((f) => isPreviewable(f.file))

    return [
      openBrowserCommand(baseUrl, prefix, api, worktree, getPrefix),
      ...previewable.map((f) => ({
        title: `Preview: ${f.file}`,
        value: `preview:file:${f.file}`,
        description: `Open ${f.file} in browser preview`,
        category: "Preview",
        async onSelect() {
          const p = await getPrefix()
          const url = previewUrl(baseUrl, p, f.file, worktree)
          openUrl(url)
          api.ui.toast({ variant: "info", message: `Preview: ${f.file}`, duration: 2000 })
        },
      })),
    ]
  })

  const slotPlugin: TuiSlotPlugin = {
    slots: {
      sidebar_content(_ctx, props) {
        const prefix = resolvedPrefix ?? directory.split("/").pop() ?? "project"
        const files = api.state.session.diff(props.session_id)
        const previewable = files.filter((f) => isPreviewable(f.file))

        return (
          <box flexDirection="column" paddingTop={1}>
            <text bold dimColor>
              Preview
            </text>
            <box flexDirection="row" gap={1}>
              <text dimColor>{worktree ? "🌿" : "📂"}</text>
              <a href={browserUrl(baseUrl, prefix, worktree)} color="cyan">
                {worktree ?? "Browse Files"}
              </a>
            </box>
            {previewable.map((f) => {
              const icon = f.file.endsWith(".drawio") ? "📊" : "📄"
              const url = previewUrl(baseUrl, prefix, f.file, worktree)
              return (
                <box flexDirection="row" gap={1}>
                  <text dimColor>{icon}</text>
                  <a href={url} color="cyan">
                    {f.file}
                  </a>
                </box>
              )
            })}
          </box>
        )
      },
    },
  }

  api.slots.register(slotPlugin)
}

function openBrowserCommand(
  baseUrl: string,
  prefix: string,
  api: Parameters<TuiPlugin>[0],
  worktree?: string,
  getPrefix?: () => Promise<string>,
) {
  const url = browserUrl(baseUrl, prefix, worktree)
  const label = worktree ? `Open Preview (${worktree})` : "Open Preview"
  return {
    title: label,
    value: "preview:open",
    description: "Open the preview file browser in your default browser",
    category: "Preview",
    async onSelect() {
      const p = getPrefix ? await getPrefix() : prefix
      const resolvedUrl = browserUrl(baseUrl, p, worktree)
      openUrl(resolvedUrl)
      api.ui.toast({ variant: "info", message: `Opened ${resolvedUrl}`, duration: 3000 })
    },
  }
}

export default { id: "opencode-preview", tui } satisfies TuiPluginModule
