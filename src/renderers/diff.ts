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

function renderDiffLine(
  cls: string,
  oldLine: number | null,
  newLine: number | null,
  marker: string,
  text: string,
): string {
  const oldNum = oldLine === null ? "" : String(oldLine)
  const newNum = newLine === null ? "" : String(newLine)
  return `<tr class="${cls}"><td class="diff-line-num">${oldNum}</td><td class="diff-line-num">${newNum}</td><td class="diff-line-code"><span class="diff-line-marker">${escapeHtml(marker)}</span>${escapeHtml(text)}</td></tr>`
}

function parseHunkStart(hunkHeader: string): { oldLine: number; newLine: number } {
  const m = hunkHeader.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/)
  if (!m) return { oldLine: 1, newLine: 1 }
  return {
    oldLine: Number.parseInt(m[1], 10),
    newLine: Number.parseInt(m[2], 10),
  }
}

/** Extract file path from a `diff --git a/... b/...` header line */
function parseFilePath(diffHeader: string): string {
  const m = diffHeader.match(/^diff --git a\/(.+?) b\/(.+)$/)
  if (!m) return "unknown"
  // For renames, show both; otherwise just the b-side path
  return m[1] === m[2] ? m[2] : `${m[1]} → ${m[2]}`
}

/** Split a multi-file diff (e.g. from `git show`) into per-file chunks */
function splitDiffByFile(diffText: string): { filePath: string; chunk: string }[] {
  const source = diffText.replace(/\r\n/g, "\n")
  const parts: { filePath: string; chunk: string }[] = []
  const segments = source.split(/^(?=diff --git )/m)

  for (const segment of segments) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    if (!trimmed.startsWith("diff --git ")) continue
    const firstNewline = trimmed.indexOf("\n")
    const headerLine = firstNewline === -1 ? trimmed : trimmed.slice(0, firstNewline)
    const filePath = parseFilePath(headerLine)
    parts.push({ filePath, chunk: trimmed })
  }

  return parts
}

/** Render a single-file diff chunk into HTML */
function renderSingleFileDiff(diffText: string, filePath: string): string {
  const source = diffText.replace(/\r\n/g, "\n")
  const lines = source.split("\n")

  let added = 0
  let deleted = 0
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let isBinary = false
  let isNewFile = false
  let isDeletedFile = false

  const rows: string[] = []

  for (const line of lines) {
    if (!line) continue

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      isBinary = true
      continue
    }

    if (line.startsWith("new file mode ")) {
      isNewFile = true
      continue
    }

    if (line.startsWith("deleted file mode ")) {
      isDeletedFile = true
      continue
    }

    if (!inHunk && line.startsWith("--- ")) {
      if (line.includes("/dev/null")) isNewFile = true
      continue
    }

    if (!inHunk && line.startsWith("+++ ")) {
      if (line.includes("/dev/null")) isDeletedFile = true
      continue
    }

    if (line.startsWith("@@ ")) {
      inHunk = true
      const start = parseHunkStart(line)
      oldLine = start.oldLine
      newLine = start.newLine
      rows.push(`<tr class="diff-hunk-header"><td class="diff-line-num"></td><td class="diff-line-num"></td><td class="diff-line-code">${escapeHtml(line)}</td></tr>`)
      continue
    }

    if (!inHunk) {
      continue
    }

    if (line.startsWith("+")) {
      added++
      rows.push(renderDiffLine("diff-line-new", null, newLine, "+", line.slice(1)))
      newLine++
      continue
    }

    if (line.startsWith("-")) {
      deleted++
      rows.push(renderDiffLine("diff-line-old", oldLine, null, "-", line.slice(1)))
      oldLine++
      continue
    }

    if (line.startsWith("\\ No newline at end of file")) {
      rows.push(renderDiffLine("diff-line-note", null, null, "", line))
      continue
    }

    const ctx = line.startsWith(" ") ? line.slice(1) : line
    rows.push(renderDiffLine("diff-line-ctx", oldLine, newLine, " ", ctx))
    oldLine++
    newLine++
  }

  const kind = isBinary ? "Binary" : isNewFile ? "New File" : isDeletedFile ? "Deleted File" : "Modified"

  const metaHtml = `<div class="diff-meta"><span class="diff-badge">${escapeHtml(kind)}</span><span class="diff-path">${escapeHtml(filePath)}</span><span class="diff-stats"><span class="diff-plus">+${added}</span> <span class="diff-minus">-${deleted}</span></span></div>`

  if (isBinary) {
    return `<section class="diff-file-section">${metaHtml}<div class="browse-empty"><p>Binary file changed — textual diff unavailable.</p></div></section>`
  }

  if (rows.length === 0) {
    return `<section class="diff-file-section">${metaHtml}<div class="browse-empty"><p>No textual changes.</p></div></section>`
  }

  return `<section class="diff-file-section">${metaHtml}<div class="diff-table-wrap"><table class="diff-table"><tbody>${rows.join("")}</tbody></table></div></section>`
}

/** Render a single-file diff (used for working-tree diff view) */
export function renderDiffBody(diffText: string, filePath: string): string {
  const source = diffText.replace(/\r\n/g, "\n")
  const lines = source.split("\n")

  let added = 0
  let deleted = 0
  let oldLine = 0
  let newLine = 0
  let inHunk = false
  let isBinary = false
  let isNewFile = false
  let isDeletedFile = false

  const rows: string[] = []

  for (const line of lines) {
    if (!line) continue

    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      isBinary = true
      continue
    }

    if (line.startsWith("new file mode ")) {
      isNewFile = true
      continue
    }

    if (line.startsWith("deleted file mode ")) {
      isDeletedFile = true
      continue
    }

    if (!inHunk && line.startsWith("--- ")) {
      if (line.includes("/dev/null")) isNewFile = true
      continue
    }

    if (!inHunk && line.startsWith("+++ ")) {
      if (line.includes("/dev/null")) isDeletedFile = true
      continue
    }

    if (line.startsWith("@@ ")) {
      inHunk = true
      const start = parseHunkStart(line)
      oldLine = start.oldLine
      newLine = start.newLine
      rows.push(`<tr class="diff-hunk-header"><td class="diff-line-num"></td><td class="diff-line-num"></td><td class="diff-line-code">${escapeHtml(line)}</td></tr>`)
      continue
    }

    if (!inHunk) {
      continue
    }

    if (line.startsWith("+")) {
      added++
      rows.push(renderDiffLine("diff-line-new", null, newLine, "+", line.slice(1)))
      newLine++
      continue
    }

    if (line.startsWith("-")) {
      deleted++
      rows.push(renderDiffLine("diff-line-old", oldLine, null, "-", line.slice(1)))
      oldLine++
      continue
    }

    if (line.startsWith("\\ No newline at end of file")) {
      rows.push(renderDiffLine("diff-line-note", null, null, "", line))
      continue
    }

    const ctx = line.startsWith(" ") ? line.slice(1) : line
    rows.push(renderDiffLine("diff-line-ctx", oldLine, newLine, " ", ctx))
    oldLine++
    newLine++
  }

  const kind = isBinary ? "Binary" : isNewFile ? "New File" : isDeletedFile ? "Deleted File" : "Modified"
  const stats = `+${added} / -${deleted}`

  if (isBinary) {
    return `<main class="diff-body"><div class="diff-meta"><span class="diff-badge">DIFF</span><span class="diff-path">${escapeHtml(filePath)}</span><span class="diff-kind">${escapeHtml(kind)}</span><span class="diff-stats"><span class="diff-plus">+${added}</span> <span class="diff-minus">-${deleted}</span></span></div><div class="browse-empty"><p>Binary file changed — textual diff unavailable.</p></div></main>`
  }

  if (rows.length === 0) {
    return `<main class="diff-body"><div class="diff-meta"><span class="diff-badge">DIFF</span><span class="diff-path">${escapeHtml(filePath)}</span><span class="diff-kind">${escapeHtml(kind)}</span><span class="diff-stats"><span class="diff-plus">+${added}</span> <span class="diff-minus">-${deleted}</span></span></div><div class="browse-empty"><p>No changes in working tree.</p></div></main>`
  }

  return `<main class="diff-body"><div class="diff-meta"><span class="diff-badge">DIFF</span><span class="diff-path">${escapeHtml(filePath)}</span><span class="diff-kind">${escapeHtml(kind)}</span><span class="diff-stats"><span class="diff-plus">+${added}</span> <span class="diff-minus">-${deleted}</span></span><span class="diff-count">${escapeHtml(stats)}</span></div><div class="diff-table-wrap"><table class="diff-table"><tbody>${rows.join("")}</tbody></table></div></main>`
}

export interface CommitMeta {
  hash: string
  author: string
  date: string
  message: string
}

export function renderCommitDiff(diffText: string, meta: CommitMeta): string {
  const files = splitDiffByFile(diffText)
  const summary = files.length === 0 ? "No file changes" : `${files.length} file${files.length > 1 ? "s" : ""} changed`

  const messageHtml = meta.message ? `<pre class="diff-commit-message">${escapeHtml(meta.message)}</pre>` : ""
  const headerHtml = `<div class="diff-commit-header"><span class="diff-badge">COMMIT</span><span class="diff-path">${escapeHtml(meta.hash.slice(0, 10))}</span><span class="diff-file-count">${escapeHtml(summary)}</span></div><div class="diff-commit-meta-row"><span class="diff-commit-author">${escapeHtml(meta.author)}</span><time class="diff-commit-date">${escapeHtml(meta.date)}</time></div>${messageHtml}`

  if (files.length === 0) {
    return `<main class="diff-body">${headerHtml}<div class="browse-empty"><p>No file changes in this commit.</p></div></main>`
  }

  const fileSections = files.map((f) => renderSingleFileDiff(f.chunk, f.filePath)).join("")
  return `<main class="diff-body">${headerHtml}${fileSections}</main>`
}
