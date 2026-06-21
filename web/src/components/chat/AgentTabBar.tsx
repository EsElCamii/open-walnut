/**
 * AgentTabBar — horizontal tab strip that replaces the old AgentDropdown.
 *
 * Layout:  [● Walnut ▾] | conv 1 | conv 2 | … | +
 *
 *   - The "Walnut" tab shows the active agent; clicking it opens a small dropdown
 *     to switch agents / create a new one (agents only — conversations live in the
 *     tabs now).
 *   - Each conversation is a tab: click to switch, double-click to rename inline,
 *     hover to reveal × (the Main conversation can't be deleted).
 *   - Trailing "+" creates a new conversation. The conversation strip scrolls
 *     horizontally when it overflows; the Walnut tab and + stay pinned.
 *
 * The agent dropdown reuses the inline-style popover from the former AgentDropdown;
 * the tab chrome itself is CSS-classed (see globals.css ".agent-tab-*").
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentDefinition } from '@/api/agents';
import type { ConversationMeta } from '@/api/conversations';

interface AgentTabBarProps {
  agents: AgentDefinition[];
  activeAgentId: string;
  onSwitchAgent: (agentId: string) => void;
  conversations: ConversationMeta[];
  activeConversationId: string | null;
  onSwitchConversation: (conversationId: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onCreateAgent: (name: string, description: string, systemPrompt?: string) => void;
  onCreateAgentByChat: () => void;
  onToggleAgentVisibility: (agentId: string, visible: boolean) => void;
}

/** Slugify a name into a stable agent id (lowercase, dashes, alnum only). */
export function slugifyAgentId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'agent';
}

export function AgentTabBar(props: AgentTabBarProps) {
  const {
    agents, activeAgentId, onSwitchAgent,
    conversations, activeConversationId, onSwitchConversation,
    onNewConversation, onDeleteConversation, onRenameConversation,
    onCreateAgent, onCreateAgentByChat, onToggleAgentVisibility,
  } = props;

  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  const [newAgentPrompt, setNewAgentPrompt] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const agentWrapRef = useRef<HTMLDivElement>(null);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeAgentName = activeAgent?.name ?? activeAgentId;

  // Close agent dropdown on outside click.
  useEffect(() => {
    if (!agentMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (agentWrapRef.current && !agentWrapRef.current.contains(e.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [agentMenuOpen]);

  // Reset the new-agent sub-form whenever the dropdown closes.
  useEffect(() => {
    if (!agentMenuOpen) {
      setShowNewAgent(false);
      setNewAgentName('');
      setNewAgentDesc('');
      setNewAgentPrompt('');
    }
  }, [agentMenuOpen]);

  const submitNewAgent = useCallback(() => {
    const name = newAgentName.trim();
    if (!name) return;
    onCreateAgent(name, newAgentDesc.trim(), newAgentPrompt.trim() || undefined);
    setShowNewAgent(false);
    setNewAgentName('');
    setNewAgentDesc('');
    setNewAgentPrompt('');
    setAgentMenuOpen(false);
  }, [newAgentName, newAgentDesc, newAgentPrompt, onCreateAgent]);

  const commitRename = useCallback((cid: string) => {
    const title = renameValue.trim();
    if (title) onRenameConversation(cid, title);
    setRenamingId(null);
    setRenameValue('');
  }, [renameValue, onRenameConversation]);

  return (
    <div className="agent-tab-bar">
      {/* ── Walnut tab — agent switcher ── */}
      <div className="agent-tab-walnut-wrap" ref={agentWrapRef}>
        <button
          className={`agent-tab agent-tab-walnut${agentMenuOpen ? ' open' : ''}`}
          onClick={() => setAgentMenuOpen((v) => !v)}
          title="Switch agent"
        >
          <span className="agent-tab-dot" />
          <span className="agent-tab-label">{activeAgentName}</span>
          <span className="agent-tab-caret">▾</span>
        </button>

        {agentMenuOpen && (
          <div style={popoverStyle}>
            <div style={sectionLabelStyle}>Agents</div>
            {agents.map((agent) => {
              const isActive = agent.id === activeAgentId;
              const visible = agent.console !== false;
              const isGeneral = agent.id === 'general';
              return (
                <div key={agent.id} style={rowStyle(isActive)} className="agent-dd-row">
                  <button
                    onClick={() => { onSwitchAgent(agent.id); setAgentMenuOpen(false); }}
                    style={rowMainBtnStyle(isActive)}
                    title={agent.description}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: isActive ? 'var(--accent)' : 'var(--fg-muted)', display: 'inline-block', flexShrink: 0 }} />
                    <span style={ellipsisStyle}>{agent.name}</span>
                  </button>
                  {/* Eye toggle — can't hide 'general' */}
                  {!isGeneral && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onToggleAgentVisibility(agent.id, !visible); }}
                      style={iconBtnStyle}
                      title={visible ? 'Hide from console' : 'Show in console'}
                      aria-label={visible ? 'Hide agent' : 'Show agent'}
                    >
                      {visible ? '\u{1F441}' : '\u{1F441}‍\u{1F5E8}'}{/* 👁 / 👁‍🗨 (struck) */}
                    </button>
                  )}
                </div>
              );
            })}

            {showNewAgent ? (
              <div style={{ padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <input
                  autoFocus
                  value={newAgentName}
                  onChange={(e) => setNewAgentName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNewAgent(); if (e.key === 'Escape') setShowNewAgent(false); }}
                  placeholder="Agent name"
                  style={inputStyle}
                />
                <input
                  value={newAgentDesc}
                  onChange={(e) => setNewAgentDesc(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitNewAgent(); if (e.key === 'Escape') setShowNewAgent(false); }}
                  placeholder="Description (optional)"
                  style={inputStyle}
                />
                {/* System prompt — Enter inserts a newline (multi-line field); submit via the button. */}
                <textarea
                  value={newAgentPrompt}
                  onChange={(e) => setNewAgentPrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Escape') setShowNewAgent(false); }}
                  placeholder="System prompt (optional — blank = auto-generate)"
                  rows={3}
                  style={textareaStyle}
                />
                <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  <button onClick={() => setShowNewAgent(false)} style={ghostBtnStyle}>Cancel</button>
                  <button onClick={submitNewAgent} style={primaryBtnStyle} disabled={!newAgentName.trim()}>Create</button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <button onClick={() => setShowNewAgent(true)} style={{ ...addRowStyle, width: 'auto', flex: 1 }}>
                  + New Agent…
                </button>
                <button
                  onClick={() => { onCreateAgentByChat(); setAgentMenuOpen(false); }}
                  style={{ ...addRowStyle, width: 'auto', flexShrink: 0, paddingLeft: 8 }}
                  title="Design & create an agent by chatting with Walnut"
                >
                  Create by chat
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <span className="agent-tab-divider" />

      {/* ── Conversation tabs (scrollable) ── */}
      <div className="agent-tab-conv-scroll">
        {conversations.map((conv) => {
          const isActive = conv.id === activeConversationId;
          const isRenaming = renamingId === conv.id;
          if (isRenaming) {
            return (
              <input
                key={conv.id}
                autoFocus
                className="agent-tab-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(conv.id);
                  if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                }}
                onBlur={() => commitRename(conv.id)}
              />
            );
          }
          return (
            <div
              key={conv.id}
              className={`agent-tab agent-tab-conv${isActive ? ' active' : ''}`}
              onClick={() => onSwitchConversation(conv.id)}
              // Main is the agent's fixed thread — its label is always "Main", not renameable.
              onDoubleClick={conv.isMain ? undefined : () => { setRenamingId(conv.id); setRenameValue(conv.title); }}
              title={conv.isMain ? 'Main — receives notifications & cron. Can\'t be renamed or deleted.' : `${conv.title} — double-click to rename`}
              role="tab"
              aria-selected={isActive}
            >
              {conv.pinned && !conv.isMain && <span title="Pinned">{'\u{1F4CC}'}{/* 📌 */}</span>}
              {/* Main shows a fixed "Main" label; other conversations show their (LLM-generated) title. */}
              <span className="agent-tab-conv-title">{conv.isMain ? 'Main' : conv.title}</span>
              {/* Main conversation can't be deleted (it owns notifications & cron). */}
              {!conv.isMain && (
                <button
                  className="agent-tab-close"
                  onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                  title="Delete conversation"
                  aria-label="Delete conversation"
                >
                  {'×'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <button
        className="agent-tab-new"
        onClick={onNewConversation}
        title="New conversation"
        aria-label="New conversation"
      >
        +
      </button>
    </div>
  );
}

// ── Inline styles for the agent dropdown popover (CSS vars, mirroring the former AgentDropdown) ──

const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  minWidth: 240,
  maxWidth: 320,
  maxHeight: 420,
  overflowY: 'auto',
  background: 'var(--bg-elevated, var(--bg))',
  border: '1px solid var(--border)',
  borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
  zIndex: 1000,
  padding: '6px 0',
};

const sectionLabelStyle: React.CSSProperties = {
  padding: '4px 12px',
  fontSize: 10,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
};

function rowStyle(isActive: boolean): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 2,
    padding: '0 6px 0 12px',
    background: isActive ? 'var(--accent-subtle)' : 'transparent',
  };
}

function rowMainBtnStyle(isActive: boolean): React.CSSProperties {
  return {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 2px',
    border: 'none',
    background: 'transparent',
    color: isActive ? 'var(--fg)' : 'var(--fg-secondary)',
    fontSize: 13,
    cursor: 'pointer',
    textAlign: 'left',
  };
}

const ellipsisStyle: React.CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flex: 1,
  minWidth: 0,
};

const iconBtnStyle: React.CSSProperties = {
  border: 'none',
  background: 'transparent',
  color: 'var(--fg-muted)',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 5px',
  borderRadius: 4,
  flexShrink: 0,
  lineHeight: 1,
};

const addRowStyle: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '6px 12px',
  border: 'none',
  background: 'transparent',
  color: 'var(--accent)',
  fontSize: 12,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'var(--bg)',
  color: 'var(--fg)',
  fontSize: 12,
  boxSizing: 'border-box',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 44,
  fontFamily: 'inherit',
  lineHeight: 1.4,
};

const ghostBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'transparent',
  color: 'var(--fg-secondary)',
  fontSize: 12,
  cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '3px 10px',
  border: 'none',
  borderRadius: 6,
  background: 'var(--accent)',
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
};
