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

export async function renderMarkdownBody(content: string): Promise<string> {
  const html = await marked.parse(content)
  const words = countWords(content)
  const lines = content.split("\n").length

  return `<main class="markdown-body">
  <div class="markdown-meta">
    <span class="markdown-badge">Markdown</span>
    <span>${words} words &middot; ${lines} lines &middot; ${readingTime(words)}</span>
  </div>
  ${html}
</main>`
}
