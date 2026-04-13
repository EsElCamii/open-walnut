import { useState, useMemo, useCallback } from 'react';
import { useRepositories } from '@/hooks/useRepositories';
import { RepoCard } from '@/components/repositories/RepoCard';
import { RepoForm } from '@/components/repositories/RepoForm';
import { RepoDetail } from '@/components/repositories/RepoDetail';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { RepoSummary } from '@/api/repositories';

export function ReposSection() {
  const { repos, loading, error, save, remove, refresh } = useRepositories();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<RepoSummary | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return repos;
    const q = search.toLowerCase();
    return repos.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.slug.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.tech_stack.toLowerCase().includes(q),
    );
  }, [repos, search]);

  const handleCreate = useCallback(() => {
    setSelected(null);
    setEditingSlug(null);
    setShowForm(true);
  }, []);

  const handleEdit = useCallback((slug: string) => {
    setEditingSlug(slug);
    setShowForm(true);
  }, []);

  const handleSave = useCallback(async (slug: string, content: string) => {
    await save(slug, content);
    setShowForm(false);
    setEditingSlug(null);
  }, [save]);

  const handleDelete = useCallback(async (slug: string) => {
    if (!confirm(`Delete repository "${slug}"?`)) return;
    try {
      await remove(slug);
      if (selected?.slug === slug) setSelected(null);
    } catch {
      // useRepositories.refresh() handles re-fetching; error is transient
    }
  }, [remove, selected]);

  const handleSelect = useCallback((repo: RepoSummary) => {
    setSelected(repo);
    setShowForm(false);
  }, []);

  const handleBack = useCallback(() => {
    setShowForm(false);
    setEditingSlug(null);
    setSelected(null);
  }, []);

  if (loading) return <div id="repositories" className="card settings-section settings-section-wide"><LoadingSpinner /></div>;
  if (error) return <div id="repositories" className="card settings-section settings-section-wide"><div className="empty-state"><p>Error: {error}</p></div></div>;

  if (showForm) {
    return (
      <div id="repositories" className="card settings-section settings-section-wide">
        <RepoForm
          editSlug={editingSlug}
          onSave={handleSave}
          onCancel={handleBack}
        />
      </div>
    );
  }

  if (selected) {
    return (
      <div id="repositories" className="card settings-section settings-section-wide">
        <RepoDetail
          repo={selected}
          onBack={handleBack}
          onEdit={() => handleEdit(selected.slug)}
          onDelete={() => handleDelete(selected.slug)}
        />
      </div>
    );
  }

  return (
    <div id="repositories" className="card settings-section settings-section-wide">
      <div className="repos-header">
        <h3 className="settings-section-title">Repositories</h3>
        <button className="btn btn-primary" onClick={handleCreate}>
          + Add Repository
        </button>
      </div>

      <div className="repos-search-row">
        <input
          className="repos-search-input"
          type="text"
          placeholder="Search repositories..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="repos-count">{filtered.length} {filtered.length === 1 ? 'repo' : 'repos'}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <p>{repos.length === 0
            ? 'No repositories registered yet. Click "+ Add Repository" to get started.'
            : 'No repositories match your search.'
          }</p>
        </div>
      ) : (
        <div className="repos-grid">
          {filtered.map((repo) => (
            <RepoCard
              key={repo.slug}
              repo={repo}
              onClick={() => handleSelect(repo)}
              onEdit={() => handleEdit(repo.slug)}
              onDelete={() => handleDelete(repo.slug)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
