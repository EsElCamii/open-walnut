/**
 * Task Phase Hook — declarative automation triggered by phase transitions.
 *
 * Instead of hardcoding if-else blocks in the PATCH handler for each phase,
 * hooks are registered as data objects and executed generically.
 */

import type { Task, TaskPhase } from '../types.js'

/** Action types a hook can perform. */
export type PhaseHookActionType = 'send_message' | 'invoke_agent' | 'schedule_check'

/** send_message: push a message to the task's active session. */
export interface SendMessageAction {
  type: 'send_message'
  message: string
}

/** invoke_agent: start a subagent for the task. */
export interface InvokeAgentAction {
  type: 'invoke_agent'
  agentId: string
  prompt: string
}

/** schedule_check: register a cron-style periodic check. */
export interface ScheduleCheckAction {
  type: 'schedule_check'
  intervalMinutes: number
  checkType: string
}

export type PhaseHookAction = SendMessageAction | InvokeAgentAction | ScheduleCheckAction

export interface TaskPhaseHookDef {
  id: string
  name: string
  description: string
  triggerPhase: TaskPhase
  /** Only trigger when transitioning FROM one of these phases. */
  fromPhases?: TaskPhase[]
  action: PhaseHookAction
  condition?: {
    requiresSession?: boolean
    predicate?: (task: Task, oldPhase: TaskPhase) => boolean
  }
  /** Lower = executes first. Default 100. */
  priority?: number
}

/** Serializable subset of TaskPhaseHookDef for the REST API (no function fields). */
export interface TaskPhaseHookInfo {
  id: string
  name: string
  description: string
  triggerPhase: TaskPhase
  fromPhases?: TaskPhase[]
  actionType: PhaseHookActionType
  actionDetail: string
  conditions: string[]
  priority: number
}
