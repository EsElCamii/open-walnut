import { apiGet } from './client';

export interface PhaseHookInfo {
  id: string
  name: string
  description: string
  triggerPhase: string
  fromPhases?: string[]
  actionType: string
  actionDetail: string
  conditions: string[]
  priority: number
}

export async function fetchPhaseHooks(): Promise<PhaseHookInfo[]> {
  return apiGet<PhaseHookInfo[]>('/api/task-phase-hooks')
}
