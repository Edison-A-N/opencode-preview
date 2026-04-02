export function renderHtmlBody(prefix: string, relativePath: string, worktreeParams: string): string {
  const apiPath = `/${prefix}/api/file?path=${encodeURIComponent(relativePath)}`
  const iframeSrc = worktreeParams ? `${apiPath}&${worktreeParams}` : apiPath

  return `<main class="html-preview-body">
  <div class="html-meta">
    <span class="html-badge">HTML Preview</span>
    <a href="${iframeSrc}" target="_blank" class="html-open-link">Open in new tab</a>
  </div>
  <iframe
    class="html-preview-frame"
    src="${iframeSrc}"
    sandbox="allow-scripts"
    loading="lazy"
  ></iframe>
</main>`
}
