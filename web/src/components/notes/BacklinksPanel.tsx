import { useState } from 'react';
import { useBacklinks } from '@/hooks/useBacklinks';

interface BacklinksPanelProps {
  notePath: string;
  onNavigate: (path: string) => void;
}

export function BacklinksPanel({ notePath, onNavigate }: BacklinksPanelProps) {
  const { backlinks, loading } = useBacklinks(notePath);
  const [expanded, setExpanded] = useState(false);

  if (loading || backlinks.length === 0) return null;

  return (
    <div className="notes-backlinks-panel">
      <button
        className="notes-backlinks-toggle"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={`notes-backlinks-arrow ${expanded ? 'expanded' : ''}`}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="notes-backlinks-count">{backlinks.length} backlink{backlinks.length !== 1 ? 's' : ''}</span>
      </button>
      {expanded && (
        <div className="notes-backlinks-list">
          {backlinks.map(bl => (
            <div
              key={bl.path}
              className="notes-backlink-item"
              onClick={() => onNavigate(bl.path)}
            >
              <span className="notes-backlink-name">{bl.name}</span>
              <span className="notes-backlink-snippet">{bl.snippet}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
