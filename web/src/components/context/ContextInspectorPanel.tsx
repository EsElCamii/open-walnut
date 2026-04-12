import { useMemo } from 'react';
import type { ContextInspectorResponse } from '@/api/context';
import { renderMarkdownWithRefs } from '@/utils/markdown';
import { ContextSection } from './ContextSection';
import { ToolCard } from './ToolCard';
import { ApiMessageBlock } from './ApiMessageBlock';

interface ContextInspectorPanelProps {
  data: ContextInspectorResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** Memoized markdown block for context sections */
function ContextMarkdown({ content, fallback }: { content: string; fallback?: string }) {
  const text = content || fallback || '';
  const html = useMemo(() => renderMarkdownWithRefs(text), [text]);
  return (
    <div
      className="context-markdown markdown-body"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function ContextInspectorPanel({ data, loading, error, onRefresh }: ContextInspectorPanelProps) {
  if (error) {
    return (
      <div className="context-inspector">
        <div className="context-inspector-header">
          <span className="context-inspector-title">Agent Context Inspector</span>
          <button className="btn btn-sm" onClick={onRefresh}>Retry</button>
        </div>
        <div className="text-sm" style={{ color: 'var(--error)', padding: '12px 16px' }}>
          Error: {error}
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="context-inspector">
        <div className="context-inspector-header">
          <span className="context-inspector-title">Agent Context Inspector</span>
        </div>
        <div style={{ padding: '24px', textAlign: 'center' }}>
          <span className="spinner" style={{ width: 20, height: 20, borderWidth: 2, display: 'inline-block' }} />
        </div>
      </div>
    );
  }

  if (!data) return null;

  const { sections, totalTokens } = data;

  return (
    <div className="context-inspector">
      <div className="context-inspector-header">
        <span className="context-inspector-title">Agent Context Inspector</span>
        <span className="context-token-badge context-token-badge-total">
          Total: ~{totalTokens.toLocaleString()} tokens
        </span>
        <button
          className="btn btn-sm"
          onClick={onRefresh}
          disabled={loading}
          title="Refresh context"
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      <div className="context-inspector-body">
        <ContextSection title="Model Config" tokens={sections.modelConfig.tokens}>
          <pre className="context-pre">
            {`model: ${sections.modelConfig.content.model}\nmax_tokens: ${sections.modelConfig.content.max_tokens}\nregion: ${sections.modelConfig.content.region}`}
          </pre>
        </ContextSection>

        <ContextSection title="Role & Rules" tokens={sections.roleAndRules.tokens}>
          <ContextMarkdown content={sections.roleAndRules.content} />
        </ContextSection>

        <ContextSection title="Skills" tokens={sections.skills.tokens}>
          <ContextMarkdown content={sections.skills.content} fallback="(No skills loaded)" />
        </ContextSection>

        <ContextSection title="Compaction Summary" tokens={sections.compactionSummary.tokens}>
          <ContextMarkdown content={sections.compactionSummary.content} fallback="(No compaction yet)" />
        </ContextSection>

        <ContextSection title="Task Categories & Projects" tokens={sections.taskCategories.tokens}>
          <ContextMarkdown content={sections.taskCategories.content} fallback="(No active tasks)" />
        </ContextSection>

        {/* Non-General agents: show split memory sections */}
        {sections.agentMemory && (
          <ContextSection title="Agent Memory" tokens={sections.agentMemory.tokens}>
            <ContextMarkdown content={sections.agentMemory.content} fallback="(No agent memory yet)" />
          </ContextSection>
        )}
        {sections.mainAgentMemory && (
          <ContextSection title="Main Agent Memory (read-only)" tokens={sections.mainAgentMemory.tokens}>
            <ContextMarkdown content={sections.mainAgentMemory.content} fallback="(Empty)" />
          </ContextSection>
        )}
        {/* General agent: single global memory section */}
        {!sections.agentMemory && (
          <ContextSection title="Global Memory" tokens={sections.globalMemory.tokens}>
            <ContextMarkdown content={sections.globalMemory.content} fallback="(Empty)" />
          </ContextSection>
        )}

        <ContextSection
          title="Project Summaries"
          tokens={sections.projectSummaries.tokens}
          count={sections.projectSummaries.count}
        >
          <ContextMarkdown content={sections.projectSummaries.content} fallback="(No projects)" />
        </ContextSection>

        <ContextSection title="Notes Context" tokens={sections.notesContext.tokens}>
          <ContextMarkdown content={sections.notesContext.content} fallback="(No notes/AGENTS.md)" />
        </ContextSection>

        {/* Non-General agents: show split daily log sections */}
        {sections.agentDailyLogs && (
          <ContextSection title="Agent Daily Logs" tokens={sections.agentDailyLogs.tokens}>
            <ContextMarkdown content={sections.agentDailyLogs.content} fallback="(No agent activity)" />
          </ContextSection>
        )}
        {sections.mainAgentDailyLogs && (
          <ContextSection title="Main Agent Daily Logs (read-only)" tokens={sections.mainAgentDailyLogs.tokens}>
            <ContextMarkdown content={sections.mainAgentDailyLogs.content} fallback="(No recent activity)" />
          </ContextSection>
        )}
        {/* General agent: single daily logs section */}
        {!sections.agentDailyLogs && (
          <ContextSection title="Daily Logs" tokens={sections.dailyLogs.tokens}>
            <ContextMarkdown content={sections.dailyLogs.content} fallback="(No recent activity)" />
          </ContextSection>
        )}

        <ContextSection title="Tools" tokens={sections.tools.tokens} count={sections.tools.count}>
          <div className="context-tools-list">
            {sections.tools.content.map((tool) => (
              <ToolCard key={tool.name} tool={tool} />
            ))}
          </div>
        </ContextSection>

        <ContextSection
          title="API Messages"
          tokens={sections.apiMessages.tokens}
          count={sections.apiMessages.count}
        >
          <div className="context-messages-list">
            {sections.apiMessages.content.length === 0 ? (
              <div className="text-sm text-muted" style={{ padding: 8 }}>(No messages yet)</div>
            ) : (
              sections.apiMessages.content.map((msg, i) => (
                <ApiMessageBlock key={i} message={msg} index={i} />
              ))
            )}
          </div>
        </ContextSection>
      </div>
    </div>
  );
}
