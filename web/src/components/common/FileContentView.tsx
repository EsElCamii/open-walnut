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

export function FileContentView({ path: filePath, line, host }: FileContentViewProps) {
  const [data, setData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setData(null);
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

  const lineNumberedHtml = useMemo(() => {
    if (!data?.content) return '';
    return buildLineNumberedHtml(data.content, line);
  }, [data, line]);

  return (
    <div className="file-content-view" ref={contentRef}>
      {loading && <div className="file-viewer-loading">Loading file...</div>}
      {!loading && data?.error && <div className="file-viewer-error">{data.error}</div>}
      {!loading && data?.binary && (
        <div className="file-viewer-error">
          Binary file ({formatSize(data.size)}) — cannot display
        </div>
      )}
      {!loading && data?.content != null && data.content !== '' && (
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
