import { defineConfig } from "tsup"

export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      server: "src/server.ts",
    },
    format: ["esm"],
    dts: { tsconfig: "tsconfig.build.json" },
    splitting: true,
    clean: true,
    target: "node20",
    outDir: "dist",
    external: [
      "@opentui/core",
      "@opentui/solid",
    ],
    noExternal: ["ws", "marked", "@opencode-ai/plugin"],
    async onSuccess() {
      const { cpSync, mkdirSync } = await import("node:fs")
      mkdirSync("dist/templates", { recursive: true })
      cpSync("src/templates", "dist/templates", { recursive: true })
    },
  },
  {
    entry: { tui: "src/tui.tsx" },
    format: ["esm"],
    dts: false,
    splitting: false,
    target: "node20",
    outDir: "dist",
    external: [
      "@opentui/core",
      "@opentui/solid",
    ],
    noExternal: ["ws", "marked", "@opencode-ai/plugin"],
  },
])
