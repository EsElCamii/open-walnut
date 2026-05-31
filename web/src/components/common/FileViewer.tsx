/**
 * FileViewer — full-screen overlay for viewing file content.
 *
 * Opens via portal, delegates content fetch + rendering to FileContentView,
 * adds overlay chrome (header, copy-path, close, footer).
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FileContentView } from './FileContentView';

interface FileViewerProps {
  path: string;
  line?: number;
  host?: string;
  onClose: () => void;
}

export function FileViewer({ path: filePath, line, host, onClose }: FileViewerProps) {
  const [copied, setCopied] = useState(false);

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

  const overlay = (
    <div className="file-viewer-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="file-viewer-panel">
        <div className="file-viewer-header">
          <div className="file-viewer-title">
            <span className="file-viewer-icon">&#x1F4C4;</span>
            <span className="file-viewer-path" title={filePath}>{filename}</span>
            {line && <span className="file-viewer-line">:{line}</span>}
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
        <div className="file-viewer-body">
          <FileContentView path={filePath} line={line} host={host} />
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
