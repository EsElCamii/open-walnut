import { useState } from 'react';

interface SkillFormProps {
  onSave: (input: { dirName: string; content: string; target: 'claude' | 'walnut' }) => Promise<void>;
  onCancel: () => void;
}

const SKILL_TEMPLATE = `---
name: my-skill
description: A brief description of what this skill does
---

# My Skill

Instructions for the AI agent when this skill is activated.
`;

export function SkillForm({ onSave, onCancel }: SkillFormProps) {
  const [dirName, setDirName] = useState('');
  const [content, setContent] = useState(SKILL_TEMPLATE);
  const [target, setTarget] = useState<'claude' | 'walnut'>('claude');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dirName.trim()) {
      setError('Skill name is required');
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(dirName)) {
      setError('Name must be alphanumeric, hyphens, or underscores only');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave({ dirName: dirName.trim(), content, target });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create skill');
      setSaving(false);
    }
  };

  return (
    <form className="skill-form card" onSubmit={handleSubmit}>
      <h3 className="skill-form-title">New Skill</h3>
      {error && <div className="skill-form-error">{error}</div>}
      <div className="skill-form-section">
        <label className="skill-form-label">Directory Name</label>
        <input
          type="text"
          className="skill-form-input"
          value={dirName}
          onChange={(e) => setDirName(e.target.value)}
          placeholder="my-skill-name"
          autoFocus
        />
      </div>
      <div className="skill-form-section">
        <label className="skill-form-label">Location</label>
        <select
          className="skill-form-select"
          value={target}
          onChange={(e) => setTarget(e.target.value as 'claude' | 'walnut')}
        >
          <option value="claude">~/.claude/skills/</option>
          <option value="walnut">~/.open-walnut/skills/</option>
        </select>
      </div>
      <div className="skill-form-section">
        <label className="skill-form-label">SKILL.md Content</label>
        <textarea
          className="skill-form-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={12}
          spellCheck={false}
        />
      </div>
      <div className="skill-form-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Creating...' : 'Create Skill'}
        </button>
      </div>
    </form>
  );
}
