/**
 * FileViewer — full-screen overlay for viewing file content.
 *
 * Opens via portal, fetches file content from /api/file-content,
 * renders with line numbers, optional line highlight + scroll-to.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { fetchFileContent, type FileContentResponse } from '@/api/files';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { formatSize } from '@/utils/format';

interface FileViewerProps {
  path: string;
  line?: number;
  host?: string;
  onClose: () => void;
}

/** Map file extensions to markdown code fence language hints */
function extToLang(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    sh: 'bash', zsh: 'bash', bash: 'bash',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    md: 'markdown', css: 'css', scss: 'scss', html: 'html',
    sql: 'sql', graphql: 'graphql', xml: 'xml', swift: 'swift',
    kt: 'kotlin', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  };
  return map[ext] || '';
}

export function FileViewer({ path: filePath, line, host, onClose }: FileViewerProps) {
  const [data, setData] = useState<FileContentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Fetch file content
  useEffect(() => {
    setLoading(true);
    setData(null);
    fetchFileContent(filePath, host)
      .then(setData)
      .catch((err) => {
        setData({
          content: null, size: 0, truncated: false, binary: false,
          error: err instanceof Error ? err.message : String(err),
          extension: '',
        });
      })
      .finally(() => setLoading(false));
  }, [filePath, host]);

  // Scroll to highlighted line after content renders
  useEffect(() => {
    if (!line || !contentRef.current) return;
    const el = contentRef.current.querySelector(`[data-line="${line}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [line, data]);

  // Escape key closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopyPath = useCallback(() => {
    navigator.clipboard.writeText(filePath).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [filePath]);

  const filename = filePath.split('/').pop() ?? filePath;

  // Render file content as highlighted code via markdown
  const contentHtml = useMemo(() => {
    if (!data?.content) return '';
    const lang = extToLang(data.extension);
    // Wrap in code fence for syntax highlighting
    const fenced = `\`\`\`${lang}\n${data.content}\n\`\`\``;
    return renderMarkdownWithRefs(fenced);
  }, [data]);

  // Build line-numbered view
  const lineNumberedHtml = useMemo(() => {
    if (!data?.content) return '';
    const lines = data.content.split('\n');
    // Build simple line-numbered HTML
    const rows = lines.map((lineText, i) => {
      const lineNum = i + 1;
      const isHighlighted = lineNum === line;
      const escaped = lineText
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<div class="fv-line${isHighlighted ? ' fv-line-highlight' : ''}" data-line="${lineNum}"><span class="fv-line-num">${lineNum}</span><span class="fv-line-text">${escaped}</span></div>`;
    });
    return rows.join('');
  }, [data, line]);

  const overlay = (
    <div className="file-viewer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="file-viewer-panel">
        <div className="file-viewer-header">
          <div className="file-viewer-title">
            <span className="file-viewer-icon">&#x1F4C4;</span>
            <span className="file-viewer-path" title={filePath}>{filename}</span>
            {line && <span className="file-viewer-line">:{line}</span>}
            {data && !data.error && (
              <span className="file-viewer-size">{formatSize(data.size)}</span>
            )}
            {data?.truncated && (
              <span className="file-viewer-truncated">
                Showing first {formatSize(512 * 1024)} of {formatSize(data.size)}
              </span>
            )}
          </div>
          <div className="file-viewer-actions">
            <button
              className="file-viewer-btn"
              onClick={handleCopyPath}
              title="Copy file path"
            >
              {copied ? 'Copied!' : 'Copy Path'}
            </button>
            <button className="file-viewer-close" onClick={onClose} title="Close (Esc)">
              &#x2715;
            </button>
          </div>
        </div>
        <div className="file-viewer-body" ref={contentRef}>
          {loading && (
            <div className="file-viewer-loading">Loading file...</div>
          )}
          {!loading && data?.error && (
            <div className="file-viewer-error">{data.error}</div>
          )}
          {!loading && data?.binary && (
            <div className="file-viewer-error">
              Binary file ({formatSize(data.size)}) — cannot display
            </div>
          )}
          {!loading && data?.content && (
            <pre className="file-viewer-code" dangerouslySetInnerHTML={{ __html: lineNumberedHtml }} />
          )}
        </div>
        <div className="file-viewer-footer">
          <span className="file-viewer-full-path" title={filePath}>{filePath}</span>
          {host && <span className="file-viewer-host">SSH: {host}</span>}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
