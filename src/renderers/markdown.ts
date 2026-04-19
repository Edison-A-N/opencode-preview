import { marked } from "marked"

marked.setOptions({
  gfm: true,
  breaks: false,
})

function countWords(text: string): number {
  const stripped = text.replace(/[#*_`~[\]()>|-]/g, " ")
  const words = stripped.split(/\s+/).filter((w) => w.length > 0)
  return words.length
}

function readingTime(words: number): string {
  const minutes = Math.max(1, Math.round(words / 200))
  return `${minutes} min read`
}

type FrontMatter = Record<string, string | string[]>

function stripFrontMatter(raw: string): { body: string; meta: FrontMatter } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { body: raw, meta: {} }
  const meta: FrontMatter = {}
  let currentKey = ""
  let currentVal = ""
  const lines = match[1].split("\n")

  for (const line of lines) {
    if (/^\s+-\s+/.test(line)) {
      const item = line.replace(/^\s+-\s+/, "").trim()
      if (currentKey) {
        const prev = meta[currentKey]
        meta[currentKey] = Array.isArray(prev) ? [...prev, item] : prev ? [prev, item] : [item]
      }
      continue
    }
    if (/^\s+/.test(line) && currentKey) {
      const trimmed = line.trim()
      if (trimmed) {
        const prev = meta[currentKey]
        meta[currentKey] = typeof prev === "string" && prev
          ? `${prev} ${trimmed}`
          : trimmed
      }
      continue
    }
    const idx = line.indexOf(":")
    if (idx > 0) {
      currentKey = line.slice(0, idx).trim()
      currentVal = line.slice(idx + 1).trim()
      if (currentVal && currentVal !== ">-" && currentVal !== "|") {
        meta[currentKey] = currentVal
      }
    }
  }
  return { body: match[2], meta }
}

function renderFrontMatterCard(meta: FrontMatter): string {
  const entries = Object.entries(meta).filter(([k]) => k !== "title")
  if (entries.length === 0) return ""

  const rows = entries.map(([key, val]) => {
    const rendered = Array.isArray(val)
      ? val.map((v) => `<span class="fm-tag">${v}</span>`).join(" ")
      : val
    return `<div class="fm-row"><span class="fm-key">${key}</span><span class="fm-val">${rendered}</span></div>`
  }).join("\n")

  return `<div class="fm-card">${rows}</div>`
}

export async function renderMarkdownBody(content: string): Promise<string> {
  const { body, meta } = stripFrontMatter(content)
  const html = await marked.parse(body)
  const words = countWords(body)
  const lines = body.split("\n").length
  const title = meta.title
    ? `<h1 class="frontmatter-title">${meta.title}</h1>`
    : ""
  const card = renderFrontMatterCard(meta)

  return `<main class="markdown-body">
  <div class="markdown-meta">
    <span class="markdown-badge">Markdown</span>
    <span>${words} words &middot; ${lines} lines &middot; ${readingTime(words)}</span>
  </div>
  ${title}
  ${card}
  ${html}
</main>`
}
