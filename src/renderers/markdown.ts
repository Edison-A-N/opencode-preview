import { marked } from "marked"

marked.setOptions({
  gfm: true,
  breaks: false,
})

export async function renderMarkdownBody(content: string): Promise<string> {
  const html = await marked.parse(content)
  return `<main class="markdown-body">${html}</main>`
}
