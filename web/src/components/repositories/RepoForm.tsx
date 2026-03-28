import { useState, useEffect, useCallback } from 'react';
import { fetchRepository } from '@/api/repositories';

interface RepoFormProps {
  editSlug: string | null;
  onSave: (slug: string, content: string) => Promise<void>;
  onCancel: () => void;
}

const TEMPLATE = `name:
description:
tech_stack: []
hosts:
  local:
    path:
architecture_notes: |

common_commands: |

`;

export function RepoForm({ editSlug, onSave, onCancel }: RepoFormProps) {
  const [slug, setSlug] = useState(editSlug || '');
  const [content, setContent] = useState(TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!editSlug);

  useEffect(() => {
    if (!editSlug) return;
    let cancelled = false;
    fetchRepository(editSlug).then((detail) => {
      if (!cancelled) {
        setContent(detail.content);
        setSlug(editSlug);
        setLoading(false);
      }
    }).catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [editSlug]);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedSlug = slug.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmedSlug) {
      setError('Repository slug is required');
      return;
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(trimmedSlug)) {
      setError('Slug must start with alphanumeric and contain only lowercase letters, numbers, hyphens, dots, or underscores.');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      await onSave(trimmedSlug, content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [slug, content, onSave]);

  if (loading) return <p className="text-muted">Loading...</p>;

  return (
    <form className="repo-form" onSubmit={handleSubmit}>
      <div className="repo-form-header">
        <h2>{editSlug ? 'Edit Repository' : 'Add Repository'}</h2>
      </div>

      {error && <div className="repo-form-error">{error}</div>}

      <div className="repo-form-field">
        <label htmlFor="repo-slug">Slug (filename)</label>
        <input
          id="repo-slug"
          type="text"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          placeholder="my-project"
          disabled={!!editSlug}
          className="repo-form-input"
        />
        <span className="repo-form-hint">Lowercase, hyphenated. This becomes the filename: {slug || 'name'}.yaml</span>
      </div>

      <div className="repo-form-field">
        <label htmlFor="repo-content">YAML Content</label>
        <textarea
          id="repo-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="repo-form-textarea"
          rows={20}
          spellCheck={false}
        />
      </div>

      <div className="repo-form-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving...' : (editSlug ? 'Update' : 'Create')}
        </button>
      </div>
    </form>
  );
}
