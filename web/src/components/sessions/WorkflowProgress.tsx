/**
 * WorkflowProgress — live panel for a session's dynamic-workflow / background tasks.
 *
 * Driven by the `session:background-tasks` stream (see useBackgroundTasks). A dynamic
 * workflow fans out many subagents that outlive the agent's text turn. This panel
 * mirrors Claude Code's own `/workflows` view: it shows WHAT workflow was created
 * (name + generated script), the phases, and every subagent grouped by phase — each
 * row clickable to reveal its prompt + result. Rendered inside SessionChatHistory so
 * BOTH the /sessions page and the home slide-out get it for free.
 *
 * Two render modes:
 *   - Workflow mode (agents.length > 0): rich phase/agent breakdown.
 *   - Legacy mode (no agents): flat background-task list (plain background tasks).
 *
 * The counts here are DISPLAY-ONLY — completion is driven by the backend's
 * session_state_changed{idle} signal, never by this panel.
 */

import { memo, useState } from 'react';
import { useBackgroundTasks, type BackgroundTask, type WorkflowAgent } from '@/hooks/useBackgroundTasks';
import { WorkflowTranscriptModal, type TranscriptTarget } from './WorkflowTranscriptModal';
import { useFullscreen } from '@/hooks/useFullscreen';
import { ICON_EXPAND, ICON_COLLAPSE } from '../common/Icons';

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'killed']);

function StatusDot({ status }: { status: string }) {
  if (status === 'running') return <span className="wf-task-dot wf-task-dot-running" title="Running">{'●'}</span>;
  if (status === 'completed') return <span className="wf-task-dot wf-task-dot-done" title="Completed">{'✓'}</span>;
  if (status === 'failed') return <span className="wf-task-dot wf-task-dot-error" title="Failed">{'✗'}</span>;
  if (status === 'stopped' || status === 'killed') return <span className="wf-task-dot wf-task-dot-stopped" title="Stopped">{'■'}</span>;
  if (status === 'paused') return <span className="wf-task-dot wf-task-dot-paused" title="Paused">{'⏸'}</span>;
  return <span className="wf-task-dot wf-task-dot-pending" title="Pending">{'⏳'}</span>;
}

function fmtTokens(n?: number): string {
  if (!n) return '';
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function fmtDuration(ms?: number): string {
  if (!ms) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

/** Short model label that KEEPS the version (e.g. "opus-4-8"), per the user's
 *  preference to distinguish versions — not just "opus". */
function shortModel(model?: string): string {
  if (!model) return '';
  const last = model.split('.').pop() ?? model;
  return last.replace(/^claude-/, '').replace(/-v\d+.*$/, '').replace(/\[1m\]$/, ' 1M');
}

// ── Legacy flat task row (non-workflow background tasks) ──
const TaskRow = memo(function TaskRow({ task }: { task: BackgroundTask }) {
  const activity = task.summary
    || (task.lastTool ? `${task.description ?? ''} · ${task.lastTool}` : task.description)
    || '';
  return (
    <div className={`wf-task wf-task-${task.status}`}>
      <StatusDot status={task.status} />
      <span className="wf-task-name" title={task.subagentType}>
        {task.description || task.subagentType || task.taskId.slice(0, 8)}
      </span>
      {task.status === 'running' && activity && (
        <span className="wf-task-activity">{activity.slice(0, 80)}</span>
      )}
      {task.tokens ? <span className="wf-task-tokens">{fmtTokens(task.tokens)}</span> : null}
    </div>
  );
});

/** Build the "model · tokens · duration" meta line for an agent. */
function agentMeta(agent: WorkflowAgent): string {
  return [shortModel(agent.model), fmtTokens(agent.tokens) && `${fmtTokens(agent.tokens)} tok`, fmtDuration(agent.durationMs)]
    .filter(Boolean).join(' · ');
}

// ── Rich workflow subagent row (clickable → inline prompt/result preview;
//    "View full transcript" opens the large modal reader) ──
const WorkflowAgentRow = memo(function WorkflowAgentRow({
  agent, expanded, onToggle, onOpenTranscript,
}: {
  agent: WorkflowAgent; expanded: boolean;
  onToggle: () => void; onOpenTranscript: (a: WorkflowAgent) => void;
}) {
  const meta = agentMeta(agent);
  return (
    <div className={`wf-agent ${expanded ? 'wf-agent-expanded' : ''}`}>
      <button className="wf-agent-row" onClick={onToggle} title={agent.agentId}>
        <span className="wf-agent-caret">{expanded ? '▾' : '▸'}</span>
        <StatusDot status={agent.status} />
        <span className="wf-agent-name">{agent.label || agent.agentId.slice(0, 8)}</span>
        {meta && <span className="wf-agent-meta">{meta}</span>}
      </button>
      {expanded && (
        <div className="wf-agent-detail">
          {agent.promptPreview && (
            <div className="wf-agent-block">
              <div className="wf-agent-block-label">Prompt</div>
              <div className="wf-agent-prompt">{agent.promptPreview}</div>
            </div>
          )}
          <div className="wf-agent-block">
            <div className="wf-agent-block-label">Result</div>
            {agent.resultPreview ? (
              <div className="wf-agent-result">{agent.resultPreview}</div>
            ) : (
              <div className="wf-agent-result wf-agent-result-empty">
                {agent.status === 'running' ? 'Running…' : 'No result yet'}
              </div>
            )}
          </div>
          {/* Full transcript is too long for this cramped box → open the large modal reader. */}
          <button className="wf-transcript-toggle" onClick={() => onOpenTranscript(agent)}>
            View full transcript →
          </button>
        </div>
      )}
    </div>
  );
});

export const WorkflowProgress = memo(function WorkflowProgress({ sessionId }: { sessionId: string }) {
  const { workflowName, workflowDescription, scriptSource, inFlight, tasks, phases, agents } = useBackgroundTasks(sessionId);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);
  // null = follow the smart default (collapse a finished run, expand a live one);
  // true/false = the user clicked the chevron and now owns the state.
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);
  // Which subagent's full transcript is open in the big modal reader (null = none).
  const [transcriptTarget, setTranscriptTarget] = useState<TranscriptTarget | null>(null);
  // Whole-panel full screen — same CSS-promotion hook the session panel uses
  // (95vw x 95vh, Escape to exit, shared scroll lock).
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();

  const isWorkflow = agents.length > 0;

  // Nothing to show until at least one background task / agent has appeared.
  if (!isWorkflow && tasks.length === 0 && inFlight === 0) return null;

  // Counts: workflow mode derives from the agents union; legacy from the flat task list.
  const total = isWorkflow ? agents.length : tasks.length;
  const done = isWorkflow
    ? agents.filter(a => TERMINAL.has(a.status)).length
    : tasks.filter(t => t.status !== 'running' && t.status !== 'pending' && t.status !== 'paused').length;
  const running = isWorkflow ? agents.filter(a => a.status === 'running').length : inFlight;
  const totalTokens = isWorkflow
    ? agents.reduce((s, a) => s + (a.tokens ?? 0), 0)
    : tasks.reduce((s, t) => s + (t.tokens ?? 0), 0);

  // Collapse: default collapsed once the run is finished (nothing running) so the
  // panel doesn't hog vertical space; expanded while work is live. User clicks win.
  // Fullscreen forces expanded — a collapsed full-screen panel makes no sense.
  const collapsed = !isFullscreen && (collapseOverride ?? (running === 0));

  // Group agents by phase for the rich view; keep phase order by index.
  // ONE sentinel for "agent has no phaseIndex" in BOTH the group match and the orphan
  // check — otherwise an agent with undefined phaseIndex could match phase 0 AND be
  // treated as an orphan, rendering twice (duplicate React key).
  const NO_PHASE = -1;
  const phaseList = phases.length
    ? [...phases].sort((a, b) => a.index - b.index)
    : [{ index: 0, title: '' }];
  const agentsByPhase = (phaseIndex: number) =>
    agents.filter(a => (a.phaseIndex ?? NO_PHASE) === phaseIndex).sort((a, b) => a.index - b.index);
  // Catch-all for agents whose phaseIndex matches no known phase. This happens
  // naturally with partial snapshots: a workflow_agent entry can arrive carrying a
  // phaseIndex before its workflow_phase entry has been accumulated — so this is the
  // consequence of sparse/out-of-order snapshots, not dead defensive code.
  const orphanAgents = phases.length
    ? agents.filter(a => !phases.some(p => p.index === (a.phaseIndex ?? NO_PHASE)))
    : [];

  const openTranscript = (a: WorkflowAgent) =>
    setTranscriptTarget({ agentId: a.agentId, label: a.label, model: a.model, meta: agentMeta(a) });

  return (
    <>
    {FullscreenBackdrop}
    <div className={`wf-card ${collapsed ? 'wf-card-collapsed' : ''}${fullscreenClass}`}>
      <div className="wf-card-header">
        {/* The whole bar toggles collapse; the chevron just signals it's clickable.
            (Disabled while fullscreen — the panel is force-expanded then.) */}
        <button
          className="wf-card-collapse"
          onClick={() => !isFullscreen && setCollapseOverride(!collapsed)}
          aria-expanded={!collapsed}
          title={isFullscreen ? '' : collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="wf-card-caret">{collapsed ? '▸' : '▾'}</span>
          <span className="wf-card-icon">{'⚙'}</span>
          <span className="wf-card-title" title={workflowDescription}>
            {workflowName ? `Workflow: ${workflowName}` : 'Background tasks'}
          </span>
        </button>
        <span className="wf-card-count">
          {done}/{total}{isWorkflow ? ' agents' : ''}
          {running > 0 && <span className="wf-card-running"> · {running} running</span>}
        </span>
        {totalTokens > 0 && <span className="wf-card-tokens">{fmtTokens(totalTokens)} tok</span>}
        {scriptSource && (
          <button className="wf-script-toggle" onClick={() => setShowScript(s => !s)} title="View the generated workflow script">
            {showScript ? 'Hide script' : 'View script'}
          </button>
        )}
        {/* Whole-panel full screen — same affordance as the session panel. */}
        <button
          className="wf-card-fullscreen"
          onClick={isFullscreen ? exitFullscreen : enterFullscreen}
          title={isFullscreen ? 'Collapse back' : 'Expand to full screen'}
          aria-label={isFullscreen ? 'Exit full screen' : 'Expand workflow to full screen'}
        >
          {isFullscreen ? ICON_COLLAPSE : ICON_EXPAND}
        </button>
      </div>

      {!collapsed && (
        <>
          {workflowDescription && isWorkflow && (
            <div className="wf-card-desc">{workflowDescription}</div>
          )}

          {showScript && scriptSource && (
            <pre className="wf-script">{scriptSource}</pre>
          )}

          {isWorkflow ? (
            <div className="wf-card-tasks">
              {phaseList.map(phase => {
                const phaseAgents = phases.length ? agentsByPhase(phase.index) : agents;
                if (phaseAgents.length === 0) return null;
                return (
                  <div key={phase.index} className="wf-phase">
                    {phase.title && (
                      <div className="wf-phase-header">
                        <span className="wf-phase-title">{phase.title}</span>
                        <span className="wf-phase-count">{phaseAgents.filter(a => TERMINAL.has(a.status)).length}/{phaseAgents.length}</span>
                      </div>
                    )}
                    {phaseAgents.map(a => (
                      <WorkflowAgentRow
                        key={a.agentId}
                        agent={a}
                        expanded={expandedAgent === a.agentId}
                        onToggle={() => setExpandedAgent(prev => prev === a.agentId ? null : a.agentId)}
                        onOpenTranscript={openTranscript}
                      />
                    ))}
                  </div>
                );
              })}
              {orphanAgents.map(a => (
                <WorkflowAgentRow
                  key={a.agentId}
                  agent={a}
                  expanded={expandedAgent === a.agentId}
                  onToggle={() => setExpandedAgent(prev => prev === a.agentId ? null : a.agentId)}
                  onOpenTranscript={openTranscript}
                />
              ))}
            </div>
          ) : (
            <div className="wf-card-tasks">
              {tasks.map(t => <TaskRow key={t.taskId} task={t} />)}
            </div>
          )}
        </>
      )}

      {transcriptTarget && (
        <WorkflowTranscriptModal
          target={transcriptTarget}
          sessionId={sessionId}
          onClose={() => setTranscriptTarget(null)}
        />
      )}
    </div>
    </>
  );
});
