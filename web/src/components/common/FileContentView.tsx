/**
 * FileContentView — shared file-content renderer.
 *
 * Fetches a file from /api/file-content (local + remote via host) and renders
 * it with line numbers + optional line highlight/scroll-to. Used by both the
 * full-screen FileViewer overlay and the inline right pane of SessionFileExplorer.
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { fetchFileContent, type FileContentResponse } from '@/api/files';
import { formatSize } from '@/utils/format';
import { renderMarkdownWithRefs } from '@/utils/markdown';

interface FileContentViewProps {
  path: string;
  line?: number;
  host?: string;
}

/** Build line-numbered HTML from raw file content. */
function buildLineNumberedHtml(content: string, highlightLine?: number): string {
  const lines = content.split('\n');
  const rows = lines.map((lineText, i) => {
    const lineNum = i + 1;
    const isHighlighted = lineNum === highlightLine;
    const escaped = lineText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<div class="fv-line${isHighlighted ? ' fv-line-highlight' : ''}" data-line="${lineNum}"><span class="fv-line-num">${lineNum}</span><span class="fv-line-text">${escaped}</span></div>`;
  });
  return rows.join('');
}

/** Whether a file extension is HTML and thus previewable as rendered markup. */
function isHtmlExt(ext: string | undefined, path: string): boolean {
  const e = (ext || path.split('.').pop() || '').toLowerCase();
  return e === 'html' || e === 'htm';
}

/** Whether a file extension is Markdown and thus previewable as rendered markup. */
function isMarkdownExt(ext: string | undefined, path: string): boolean {
  const e = (ext || path.split('.').pop() || '').toLowerCase();
  return e === 'md' || e === 'markdown' || e === 'mdx';
}

export function FileContentView({ path: filePath, line, host }: FileContentViewProps) {
  const [data, setData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // For HTML/Markdown files, default to the rendered preview; toggle to source on demand.
  const [showSource, setShowSource] = useState(false);
  // Fullscreen the preview (md/html) — CSS-fixed overlay, no remount.
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
    setShowSource(false);
    setFullscreen(false);
    fetchFileContent(filePath, host)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => {
        if (cancelled) return;
        setData({
          content: null, size: 0, truncated: false, binary: false,
          error: err instanceof Error ? err.message : String(err),
          extension: '',
        });
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filePath, host]);

  // Scroll to highlighted line after content renders
  useEffect(() => {
    if (!line || !contentRef.current) return;
    const el = contentRef.current.querySelector(`[data-line="${line}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [line, data]);

  // Escape exits fullscreen (capture phase so it fires before the FileViewer's own
  // Escape-to-close handler, letting the first Escape just leave fullscreen).
  useEffect(() => {
    if (!fullscreen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setFullscreen(false); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [fullscreen]);

  const lineNumberedHtml = useMemo(() => {
    if (!data?.content) return '';
    return buildLineNumberedHtml(data.content, line);
  }, [data, line]);

  const isHtml = data?.content != null && isHtmlExt(data.extension, filePath);
  const isMarkdown = data?.content != null && isMarkdownExt(data.extension, filePath);
  const isRenderable = isHtml || isMarkdown;
  const showPreview = isRenderable && !showSource;

  const markdownHtml = useMemo(() => {
    if (!isMarkdown || !data?.content) return '';
    return renderMarkdownWithRefs(data.content);
  }, [isMarkdown, data]);

  return (
    <div className={`file-content-view${fullscreen ? ' fv-fullscreen' : ''}`} ref={contentRef}>
      {loading && <div className="file-viewer-loading">Loading file...</div>}
      {!loading && data?.error && <div className="file-viewer-error">{data.error}</div>}
      {!loading && data?.binary && (
        <div className="file-viewer-error">
          Binary file ({formatSize(data.size)}) — cannot display
        </div>
      )}
      {!loading && isRenderable && (
        <div className="fv-html-toolbar">
          <button
            className={`fv-html-tab${showPreview ? ' active' : ''}`}
            onClick={() => setShowSource(false)}
          >
            Preview
          </button>
          <button
            className={`fv-html-tab${!showPreview ? ' active' : ''}`}
            onClick={() => setShowSource(true)}
          >
            Source
          </button>
          <button
            className="fv-html-tab fv-fullscreen-btn"
            onClick={() => setFullscreen((f) => !f)}
            title={fullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}
          >
            {fullscreen ? '✕ Exit' : '⛶ Fullscreen'}
          </button>
        </div>
      )}
      {!loading && showPreview && isHtml && (
        <iframe
          className="fv-html-preview"
          sandbox=""
          srcDoc={data!.content ?? ''}
          title={filePath}
        />
      )}
      {!loading && showPreview && isMarkdown && (
        <div className="fv-md-preview markdown-body" dangerouslySetInnerHTML={{ __html: markdownHtml }} />
      )}
      {!loading && !showPreview && data?.content != null && data.content !== '' && (
        <pre className="file-viewer-code" dangerouslySetInnerHTML={{ __html: lineNumberedHtml }} />
      )}
      {!loading && data && !data.error && !data.binary && data.content === '' && (
        <div className="file-viewer-loading">Empty file</div>
      )}
      {!loading && data?.truncated && (
        <div className="file-viewer-truncated">
          Showing first {formatSize(512 * 1024)} of {formatSize(data.size)}
        </div>
      )}
    </div>
  );
}
