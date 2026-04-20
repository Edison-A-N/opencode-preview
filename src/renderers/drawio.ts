function countDiagramPages(xml: string): number {
  const matches = xml.match(/<diagram[\s>]/g)
  return matches ? matches.length : 1
}

export function renderDrawioBody(content: string): string {
  const isDark =
    typeof globalThis !== "undefined" &&
    globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches
  const config = {
    highlight: isDark ? "#818cf8" : "#4f46e5",
    nav: true,
    resize: true,
    toolbar: "pages zoom layers tags",
    border: 20,
    page: 0,
    lightbox: false,
    "toolbar-nohide": true,
    "allow-zoom-in": true,
    "allow-zoom-out": true,
    xml: content,
  }

  return `<main class="drawio-container">
      <div id="drawio-viewer" class="mxgraph" data-mxgraph='${JSON.stringify(config).replace(/'/g, "&#39;")}'></div>
    </main>`
}

export { countDiagramPages }
