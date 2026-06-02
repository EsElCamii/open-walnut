import { useState, useEffect } from 'react';
import type { Config, TaskPriority } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { ListEditor } from '../inputs/ListEditor';
import { useTheme, type ThemePreference } from '@/hooks/useTheme';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useSessionPanelMode, type SessionPanelMode } from '@/hooks/useSessionPanelMode';

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const PANEL_OPTIONS: { value: SessionPanelMode; label: string }[] = [
  { value: '1', label: '1 Panel' },
  { value: '2', label: '2 Panels' },
  { value: 'auto', label: 'Auto' },
];

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function GeneralSection({ config, onSave }: Props) {
  const { theme, setTheme } = useTheme();
  const focusBar = useFocusBarContext();
  const { mode: panelMode, setMode: setPanelMode } = useSessionPanelMode();
  const [userName, setUserName] = useState(config.user?.name ?? '');
  const [defaultPriority, setDefaultPriority] = useState<TaskPriority>(config.defaults?.priority ?? 'none');
  const [defaultCategory, setDefaultCategory] = useState(config.defaults?.category ?? '');
  const [localCategories, setLocalCategories] = useState<string[]>(config.local?.categories ?? []);
  const [bumpPinnedOnChat, setBumpPinnedOnChat] = useState(config.ui?.bump_pinned_on_chat !== false);

  useEffect(() => {
    setUserName(config.user?.name ?? '');
    setDefaultPriority(config.defaults?.priority ?? 'none');
    setDefaultCategory(config.defaults?.category ?? '');
    setLocalCategories(config.local?.categories ?? []);
    setBumpPinnedOnChat(config.ui?.bump_pinned_on_chat !== false);
  }, [config]);

  const handleSave = async () => {
    await onSave({
      user: { name: userName },
      defaults: { priority: defaultPriority, category: defaultCategory },
      local: { ...config.local, categories: localCategories },
      ui: { ...config.ui, bump_pinned_on_chat: bumpPinnedOnChat },
    });
  };

  return (
    <SectionCard id="general" title="General" description="Basic preferences and defaults." onSave={handleSave}>
      <div className="form-group">
        <label>Theme</label>
        <div className="theme-picker">
          {THEME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`theme-picker-btn${theme === opt.value ? ' active' : ''}`}
              onClick={() => setTheme(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="form-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={focusBar.visible}
            onChange={(e) => focusBar.setVisible(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
          />
          Show Focus Bar
          <span className="text-sm text-muted" style={{ marginLeft: 4 }}>&mdash; pinned task dock at the bottom</span>
        </label>
      </div>

      <div className="form-group">
        <label>Tier visible limits</label>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['focus', 'next', 'satellite', 'wait'] as const).map((tier) => (
            <label key={tier} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
              <span style={{ textTransform: 'capitalize' }}>{tier}</span>
              <input
                type="number"
                min={1}
                max={50}
                value={focusBar.tierLimits[tier]}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(50, parseInt(e.target.value, 10) || 1));
                  focusBar.setTierLimits({ ...focusBar.tierLimits, [tier]: v });
                }}
                style={{ width: 52, textAlign: 'center' }}
                data-testid={`tier-limit-${tier}`}
              />
            </label>
          ))}
        </div>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          Max cards visible per tier before scrolling
        </p>
      </div>

      <div className="form-group">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={bumpPinnedOnChat}
            onChange={(e) => setBumpPinnedOnChat(e.target.checked)}
            style={{ width: 16, height: 16, accentColor: 'var(--accent)' }}
            data-testid="bump-pinned-on-chat"
          />
          Move chatted task to top of its tier
          <span className="text-sm text-muted" style={{ marginLeft: 4 }}>&mdash; chatting with a pinned task bubbles it to the front</span>
        </label>
      </div>

      <div className="form-group">
        <label>Session Panels</label>
        <div className="theme-picker">
          {PANEL_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`theme-picker-btn${panelMode === opt.value ? ' active' : ''}`}
              onClick={() => setPanelMode(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted" style={{ margin: '4px 0 0' }}>
          Auto adjusts based on screen width
        </p>
      </div>

      <div className="form-group">
        <label htmlFor="settings-name">User Name</label>
        <input
          id="settings-name"
          type="text"
          value={userName}
          onChange={(e) => setUserName(e.target.value)}
          placeholder="Your name"
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="settings-priority">Default Priority</label>
          <select
            id="settings-priority"
            value={defaultPriority}
            onChange={(e) => setDefaultPriority(e.target.value as TaskPriority)}
          >
            <option value="none">None (untriaged)</option>
            <option value="backlog">Backlog</option>
            <option value="important">Important</option>
            <option value="immediate">Immediate</option>
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="settings-category">Default Category</label>
          <input
            id="settings-category"
            type="text"
            value={defaultCategory}
            onChange={(e) => setDefaultCategory(e.target.value)}
            placeholder="e.g., Work"
          />
        </div>
      </div>

      <div className="form-group">
        <label>Local-Only Categories</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 4px' }}>
          Categories that are never synced to external services.
        </p>
        <ListEditor
          items={localCategories}
          onChange={setLocalCategories}
          placeholder="Add category..."
        />
      </div>
    </SectionCard>
  );
}
