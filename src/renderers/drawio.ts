function countDiagramPages(xml: string): number {
  const matches = xml.match(/<diagram[\s>]/g)
  return matches ? matches.length : 1
}

export function renderDrawioBody(content: string): string {
  const escapedXml = JSON.stringify(content)

  return `<main class="drawio-container">
      <div id="drawio-viewer" class="mxgraph"></div>
    </main>
    <script src="https://viewer.diagrams.net/js/viewer-static.min.js"></script>
    <script>
      const xml = ${escapedXml};
      const container = document.getElementById("drawio-viewer");
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      const config = {
        highlight: isDark ? "#818cf8" : "#4f46e5",
        nav: true,
        resize: true,
        toolbar: "pages zoom layers tags",
        border: 20,
        page: 0,
        lightbox: false,
        "toolbar-nohide": true,
        xml,
      };
      container.setAttribute("data-mxgraph", JSON.stringify(config));
      if (typeof GraphViewer !== "undefined" && GraphViewer.processElements) {
        GraphViewer.processElements();
      }
    </script>`
}

export { countDiagramPages }
