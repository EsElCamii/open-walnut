/**
 * AgentDropdown — trigger button + popover that replaces the old AgentSwitcher.
 *
 * Two sections:
 *   1. Agents — switch active agent, toggle console visibility (eye), create new.
 *   2. Conversations (for the active agent) — switch, rename, delete, create new.
 *
 * Always reachable (even with a single agent) so the conversation list + "New
 * Conversation" are always available. Inline styles + CSS vars, mirroring
 * AgentSwitcher.tsx and the ChatHeaderRow close-on-outside-click pattern.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import type { AgentDefinition } from '@/api/agents';
import type { ConversationMeta } from '@/api/conversations';
import { timeAgo } from '@/utils/time';

interface AgentDropdownProps {
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

export function AgentDropdown(props: AgentDropdownProps) {
  const {
    agents, activeAgentId, onSwitchAgent,
    conversations, activeConversationId, onSwitchConversation,
    onNewConversation, onDeleteConversation, onRenameConversation,
    onCreateAgent, onCreateAgentByChat, onToggleAgentVisibility,
  } = props;

  const [open, setOpen] = useState(false);
  const [showNewAgent, setShowNewAgent] = useState(false);
  const [newAgentName, setNewAgentName] = useState('');
  const [newAgentDesc, setNewAgentDesc] = useState('');
  const [newAgentPrompt, setNewAgentPrompt] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);

  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const activeAgentName = activeAgent?.name ?? activeAgentId;

  // Close popover on outside click (mirror ChatHeaderRow menu pattern).
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Reset transient sub-forms whenever the popover closes.
  useEffect(() => {
    if (!open) {
      setShowNewAgent(false);
      setNewAgentName('');
      setNewAgentDesc('');
      setNewAgentPrompt('');
      setRenamingId(null);
      setRenameValue('');
    }
  }, [open]);

  const submitNewAgent = useCallback(() => {
    const name = newAgentName.trim();
    if (!name) return;
    onCreateAgent(name, newAgentDesc.trim(), newAgentPrompt.trim() || undefined);
    setShowNewAgent(false);
    setNewAgentName('');
    setNewAgentDesc('');
    setNewAgentPrompt('');
    setOpen(false);
  }, [newAgentName, newAgentDesc, newAgentPrompt, onCreateAgent]);

  const commitRename = useCallback((cid: string) => {
    const title = renameValue.trim();
    if (title) onRenameConversation(cid, title);
    setRenamingId(null);
    setRenameValue('');
  }, [renameValue, onRenameConversation]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={triggerStyle}
        title="Agents & conversations"
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
        <span style={{ fontWeight: 600 }}>{activeAgentName}</span>
        <span style={{ fontSize: 9, opacity: 0.6 }}>{'▾'}{/* ▾ */}</span>
      </button>

      {open && (
        <div style={popoverStyle}>
          {/* ── Agents ── */}
          <div style={sectionLabelStyle}>Agents</div>
          {agents.map((agent) => {
            const isActive = agent.id === activeAgentId;
            const visible = agent.console !== false;
            const isGeneral = agent.id === 'general';
            return (
              <div key={agent.id} style={rowStyle(isActive)} className="agent-dd-row">
                <button
                  onClick={() => { onSwitchAgent(agent.id); setOpen(false); }}
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
                onClick={() => { onCreateAgentByChat(); setOpen(false); }}
                style={{ ...addRowStyle, width: 'auto', flexShrink: 0, paddingLeft: 8 }}
                title="Design & create an agent by chatting with Walnut"
              >
                Create by chat
              </button>
            </div>
          )}

          <div style={dividerStyle} />

          {/* ── Conversations (active agent) ── */}
          <div style={sectionLabelStyle}>Conversations</div>
          {conversations.length === 0 && (
            <div style={{ padding: '4px 12px', fontSize: 12, color: 'var(--fg-muted)' }}>No conversations yet</div>
          )}
          {conversations.map((conv) => {
            const isActive = conv.id === activeConversationId;
            const isRenaming = renamingId === conv.id;
            return (
              <div key={conv.id} style={rowStyle(isActive)} className="agent-dd-row">
                {isRenaming ? (
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(conv.id);
                      if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); }
                    }}
                    onBlur={() => commitRename(conv.id)}
                    style={{ ...inputStyle, margin: '0 4px' }}
                  />
                ) : (
                  <>
                    <button
                      onClick={() => { onSwitchConversation(conv.id); setOpen(false); }}
                      style={rowMainBtnStyle(isActive)}
                      title={conv.title}
                    >
                      {conv.isMain && (
                        <span
                          style={mainBadgeStyle}
                          title="Receives notifications & cron. Can't be deleted."
                        >
                          Main
                        </span>
                      )}
                      {conv.pinned && <span style={{ flexShrink: 0 }} title="Pinned">{'\u{1F4CC}'}{/* 📌 */}</span>}
                      <span style={{ ...ellipsisStyle, fontWeight: isActive ? 600 : 400 }}>{conv.title}</span>
                      <span style={{ fontSize: 10, color: 'var(--fg-muted)', flexShrink: 0, marginLeft: 4 }}>
                        {timeAgo(conv.lastMessageAt)}
                      </span>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setRenamingId(conv.id); setRenameValue(conv.title); }}
                      style={iconBtnStyle}
                      title="Rename"
                      aria-label="Rename conversation"
                      className="agent-dd-hover-btn"
                    >
                      {'✎'}{/* ✎ */}
                    </button>
                    {/* Main conversation can't be deleted (it owns notifications & cron) — omit ×, keep rename. */}
                    {!conv.isMain && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onDeleteConversation(conv.id); }}
                        style={iconBtnStyle}
                        title="Delete"
                        aria-label="Delete conversation"
                        className="agent-dd-hover-btn"
                      >
                        {'×'}{/* × */}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })}
          <button
            onClick={() => { onNewConversation(); setOpen(false); }}
            style={addRowStyle}
          >
            + New Conversation
          </button>
        </div>
      )}
    </div>
  );
}

// ── Inline styles (CSS vars, mirroring AgentSwitcher) ──

const triggerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '2px 10px',
  borderRadius: 12,
  border: '1px solid var(--border)',
  background: 'var(--bg-secondary)',
  color: 'var(--fg)',
  fontSize: 12,
  cursor: 'pointer',
  maxWidth: 220,
};

const popoverStyle: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  left: 0,
  minWidth: 260,
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

const dividerStyle: React.CSSProperties = {
  height: 1,
  background: 'var(--border)',
  margin: '6px 0',
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

const mainBadgeStyle: React.CSSProperties = {
  flexShrink: 0,
  padding: '0 5px',
  borderRadius: 4,
  fontSize: 9,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 0.3,
  background: 'var(--accent-subtle, rgba(0,122,255,0.12))',
  color: 'var(--accent)',
  lineHeight: '15px',
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
