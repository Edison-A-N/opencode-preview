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

function parseCSV(raw: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let i = 0

  while (i < raw.length) {
    const ch = raw[i]

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < raw.length && raw[i + 1] === '"') {
          field += '"'
          i += 2
        } else {
          inQuotes = false
          i++
        }
      } else {
        field += ch
        i++
      }
    } else {
      if (ch === '"') {
        inQuotes = true
        i++
      } else if (ch === ",") {
        row.push(field)
        field = ""
        i++
      } else if (ch === "\r") {
        row.push(field)
        field = ""
        rows.push(row)
        row = []
        i++
        if (i < raw.length && raw[i] === "\n") i++
      } else if (ch === "\n") {
        row.push(field)
        field = ""
        rows.push(row)
        row = []
        i++
      } else {
        field += ch
        i++
      }
    }
  }

  if (field || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

const RAINBOW_CLASSES = [
  "csv-rainbow-0",
  "csv-rainbow-1",
  "csv-rainbow-2",
  "csv-rainbow-3",
  "csv-rainbow-4",
  "csv-rainbow-5",
  "csv-rainbow-6",
  "csv-rainbow-7",
]

export function renderCsvBody(content: string): string {
  const rows = parseCSV(content)
  if (rows.length === 0) {
    return `<main class="csv-body"><p class="csv-empty">Empty CSV file</p></main>`
  }

  const totalCols = Math.max(...rows.map((r) => r.length))

  const [header, ...dataRows] = rows
  const totalRows = dataRows.length

  let thead = "<thead><tr>"
  for (let c = 0; c < totalCols; c++) {
    thead += `<th>${escapeHtml(header[c] ?? "")}</th>`
  }
  thead += "</tr></thead>"

  let tbody = "<tbody>"
  for (let r = 0; r < dataRows.length; r++) {
    const row = dataRows[r]
    const cls = RAINBOW_CLASSES[r % RAINBOW_CLASSES.length]
    tbody += `<tr class="${cls}">`
    for (let c = 0; c < totalCols; c++) {
      tbody += `<td>${escapeHtml(row[c] ?? "")}</td>`
    }
    tbody += "</tr>"
  }
  tbody += "</tbody>"

  return `<main class="csv-body">
  <div class="csv-meta">
    <span class="csv-badge">CSV</span>
    <span class="csv-stats">${totalRows} rows &middot; ${totalCols} columns</span>
  </div>
  <div class="csv-table-wrap">
    <table class="csv-table">${thead}${tbody}</table>
  </div>
</main>`
}
