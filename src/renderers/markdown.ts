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

function stripFrontMatter(raw: string): { body: string; meta: Record<string, string> } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return { body: raw, meta: {} }
  const meta: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":")
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const val = line.slice(idx + 1).trim()
      if (key && val) meta[key] = val
    }
  }
  return { body: match[2], meta }
}

export async function renderMarkdownBody(content: string): Promise<string> {
  const { body, meta } = stripFrontMatter(content)
  const html = await marked.parse(body)
  const words = countWords(body)
  const lines = body.split("\n").length
  const title = meta.title
    ? `<h1 class="frontmatter-title">${meta.title}</h1>`
    : ""

  return `<main class="markdown-body">
  <div class="markdown-meta">
    <span class="markdown-badge">Markdown</span>
    <span>${words} words &middot; ${lines} lines &middot; ${readingTime(words)}</span>
  </div>
  ${title}
  ${html}
</main>`
}
