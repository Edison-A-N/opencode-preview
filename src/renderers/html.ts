export function renderHtmlBody(projectId: string, relativePath: string, worktreeParams: string, rawFileUrl?: string): string {
  const apiPath = `/api/file?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(relativePath)}`
  const iframeSrc = rawFileUrl ?? (worktreeParams ? `${apiPath}&${worktreeParams}` : apiPath)

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
