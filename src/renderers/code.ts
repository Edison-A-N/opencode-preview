const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPE_MAP[ch])
}

export function renderCodeBody(content: string, language: string): string {
  const escaped = escapeHtml(content)
  const lines = content.split("\n").length

  return `<main class="code-body">
  <div class="code-meta">
    <span class="code-lang">${escapeHtml(language)}</span>
    <span class="code-lines">${lines} lines</span>
  </div>
  <pre><code class="language-${escapeHtml(language)}">${escaped}</code></pre>
</main>`
}
