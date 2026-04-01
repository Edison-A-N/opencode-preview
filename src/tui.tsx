import type { TuiPlugin, TuiPluginModule, TuiSlotPlugin } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"
import { isPreviewable as serverIsPreviewable } from "./server"

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

function previewUrl(baseUrl: string, file: string): string {
  return `${baseUrl}/preview?file=${encodeURIComponent(file)}`
}

export const tui: TuiPlugin = async (api) => {
  const baseUrl = `http://localhost:${DEFAULT_PORT}`

  api.command.register(() => {
    const route = api.route.current
    if (route.name !== "session") return [openBrowserCommand(baseUrl, api)]

    const files = api.state.session.diff(route.params.sessionID)
    const previewable = files.filter((f) => isPreviewable(f.file))

    return [
      openBrowserCommand(baseUrl, api),
      ...previewable.map((f) => ({
        title: `Preview: ${f.file}`,
        value: `preview:file:${f.file}`,
        description: `Open ${f.file} in browser preview`,
        category: "Preview",
        onSelect() {
          const url = previewUrl(baseUrl, f.file)
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

        if (previewable.length === 0) return null

        return (
          <box flexDirection="column" paddingTop={1}>
            <text bold dimColor>
              Preview
            </text>
            {previewable.map((f) => {
              const icon = f.file.endsWith(".drawio") ? "📊" : "📄"
              const url = previewUrl(baseUrl, f.file)
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
  api: Parameters<TuiPlugin>[0],
) {
  return {
    title: "Open Preview",
    value: "preview:open",
    description: "Open the preview file browser in your default browser",
    category: "Preview",
    onSelect() {
      openUrl(baseUrl)
      api.ui.toast({ variant: "info", message: `Opened ${baseUrl}`, duration: 3000 })
    },
  }
}

export default { id: "opencode-preview", tui } satisfies TuiPluginModule
