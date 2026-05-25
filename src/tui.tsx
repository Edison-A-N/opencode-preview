import type { TuiPlugin, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"
import { isPreviewable as serverIsPreviewable } from "./server"

const DEFAULT_PORT = Number(process.env.PREVIEW_PORT ?? "17890")
const DEFAULT_HOST = process.env.PREVIEW_HOST ?? "localhost"

function resolveBaseUrl(host: string, port: number): string {
  return host.includes(":") ? `http://${host}` : `http://${host}:${port}`
}

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
  const path = require("node:path")
  return path.basename(worktreePath)
}

function buildUrl(baseUrl: string, projectId: string, pathname: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams()
  qs.set("project", projectId)
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v)
  }
  const query = qs.toString()
  return query ? `${baseUrl}${pathname}?${query}` : `${baseUrl}${pathname}`
}

function previewUrl(baseUrl: string, projectId: string, file: string, worktree?: string): string {
  return buildUrl(baseUrl, projectId, "/preview", { file, worktree })
}

function browserUrl(baseUrl: string, projectId: string, worktree?: string): string {
  return buildUrl(baseUrl, projectId, "/browse", { worktree })
}

export const tui: TuiPlugin = async (api) => {
  const baseUrl = resolveBaseUrl(DEFAULT_HOST, DEFAULT_PORT)
  const directory = api.state.path.directory
  const worktree = getWorktreeName(api.state.path.worktree, directory)

  const projectId = (api.state as any).project?.id ?? ""

  api.command.register(() => {
    const route = api.route.current
    if (route.name !== "session") return [openBrowserCommand(baseUrl, projectId, api, worktree)]

    const files = api.state.session.diff(route.params.sessionID)
    const previewable = files.filter((f) => isPreviewable(f.file))

    return [
      openBrowserCommand(baseUrl, projectId, api, worktree),
      ...previewable.map((f) => ({
        title: `Preview: ${f.file}`,
        value: `preview:file:${f.file}`,
        description: `Open ${f.file} in browser preview`,
        category: "Preview",
        async onSelect() {
          const url = previewUrl(baseUrl, projectId, f.file, worktree)
          openUrl(url)
          api.ui.toast({ variant: "info", message: `Preview: ${f.file}`, duration: 2000 })
        },
      })),
    ]
  })

  const slotPlugin: TuiSlotPlugin = {
    slots: {
      sidebar_content(_ctx, props) {
        const files = api.state.session.diff(props.session_id)
        const previewable = files.filter((f) => isPreviewable(f.file))

        return (
          <box flexDirection="column" paddingTop={1}>
            <text bold dimColor>
              Preview
            </text>
            <box flexDirection="row" gap={1}>
              <text dimColor>{worktree ? "🌿" : "📂"}</text>
              <a href={browserUrl(baseUrl, projectId, worktree)} color="cyan">
                {worktree ?? "Browse Files"}
              </a>
            </box>
            {previewable.map((f) => {
              const icon = f.file.endsWith(".drawio") ? "📊" : "📄"
              const url = previewUrl(baseUrl, projectId, f.file, worktree)
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
  projectId: string,
  api: Parameters<TuiPlugin>[0],
  worktree?: string,
) {
  const url = browserUrl(baseUrl, projectId, worktree)
  const label = worktree ? `Open Preview (${worktree})` : "Open Preview"
  return {
    title: label,
    value: "preview:open",
    description: "Open the preview file browser in your default browser",
    category: "Preview",
    async onSelect() {
      openUrl(url)
      api.ui.toast({ variant: "info", message: `Opened ${url}`, duration: 3000 })
    },
  }
}

export default { id: "opencode-preview", tui } satisfies TuiPluginModule
