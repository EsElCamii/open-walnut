/**
 * Task Phase Hook Registry — single array of all phase-triggered hooks.
 *
 * To add a new hook: append an object to TASK_PHASE_HOOKS.
 */

import type { PhaseHookAction, TaskPhaseHookDef, TaskPhaseHookInfo } from './types.js'

export const TASK_PHASE_HOOKS: TaskPhaseHookDef[] = [
  {
    id: 'human-verified-auto-push',
    name: 'Auto-push session on verify',
    description: 'When a task is marked HUMAN_VERIFIED, sends a message to the active session instructing it to run code review and commit.',
    triggerPhase: 'HUMAN_VERIFIED',
    action: {
      type: 'send_message',
      message: 'User has verified this work and approved it. Please proceed:\n1. Run /code-review to review all changes\n2. After review, run /close-session-with-commit to commit and close',
    },
    condition: {
      requiresSession: true,
    },
    priority: 100,
  },
]

/** Get hooks that trigger on a specific phase. */
export function getHooksForPhase(triggerPhase: string): TaskPhaseHookDef[] {
  return TASK_PHASE_HOOKS
    .filter(h => h.triggerPhase === triggerPhase)
    .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100))
}

/** Build a human-readable action detail string (truncated to 120 chars for API summary; HooksPage shows full details separately). */
function describeAction(action: PhaseHookAction): string {
  switch (action.type) {
    case 'send_message':
      return `Send message: "${action.message.slice(0, 120)}${action.message.length > 120 ? '…' : ''}"`
    case 'invoke_agent':
      return `Invoke agent: ${action.agentId}`
    case 'schedule_check':
      return `Schedule check every ${action.intervalMinutes}min (${action.checkType})`
  }
}

/** Build a human-readable conditions list. */
function describeConditions(hook: TaskPhaseHookDef): string[] {
  const out: string[] = []
  if (hook.condition?.requiresSession) out.push('Requires active session')
  if (hook.condition?.predicate) out.push('Custom condition')
  if (hook.fromPhases?.length) out.push(`Only from: ${hook.fromPhases.join(', ')}`)
  return out
}

/** Serializable hook info for the REST API (strips predicate functions). */
export function getHookInfoList(): TaskPhaseHookInfo[] {
  return TASK_PHASE_HOOKS.map(h => ({
    id: h.id,
    name: h.name,
    description: h.description,
    triggerPhase: h.triggerPhase,
    fromPhases: h.fromPhases,
    actionType: h.action.type,
    actionDetail: describeAction(h.action),
    conditions: describeConditions(h),
    priority: h.priority ?? 100,
  }))
}
