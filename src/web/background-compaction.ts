/**
 * Background compaction — runs compaction outside the turn queue so the user
 * can keep chatting while the LLM summarizes old context.
 *
 * All compaction triggers (post-chat, post-cron, post-heartbeat, REST /compact)
 * share this single entry point. Callers must NOT enqueue this into the main
 * agent turn queue — it runs independently.
 */

import * as chatHistory from '../core/chat-history.js'
import { broadcastEvent } from './ws/handler.js'
import { EventNames } from '../core/event-bus.js'
import { createCompactionCallbacks, buildCompactionDivider } from './routes/chat.js'
import { log } from '../logging/index.js'

/** Per-agent compaction tracking — each agent can compact independently. */
const compactingAgents = new Set<string>()

export function isCompactionInProgress(agentId = 'general'): boolean {
  return compactingAgents.has(agentId)
}

export function triggerBackgroundCompaction(source: string, options?: { force?: boolean; agentId?: string }): void {
  const agentId = options?.agentId ?? 'general'
  if (compactingAgents.has(agentId)) return

  // Claim the slot immediately (synchronous — no yield between check and set)
  compactingAgents.add(agentId)

  void (async () => {
    try {
      if (!options?.force && !await chatHistory.needsCompaction(agentId)) return

      log.agent.info('background compaction starting', { source, agentId })
      const oldMsgCount = (await chatHistory.getModelContext(agentId)).length
      broadcastEvent(EventNames.CHAT_COMPACTING, { agentId })

      const { summarizer, memoryFlusher } = await createCompactionCallbacks({ trackUsage: true })
      const result = await chatHistory.compact(summarizer, memoryFlusher, agentId)

      if (result) {
        const divider = buildCompactionDivider(oldMsgCount, result)
        await chatHistory.addNotification({
          role: 'assistant',
          content: divider,
          source: 'compaction',
          notification: true,
          agentId,
        })
        broadcastEvent(EventNames.CHAT_COMPACTED, { divider, agentId })
        log.agent.info('background compaction complete', { source, agentId, oldMsgCount })
      } else {
        broadcastEvent(EventNames.CHAT_COMPACTED, { agentId })
        log.agent.info('background compaction skipped (no result)', { source, agentId })
      }
    } catch (err) {
      broadcastEvent(EventNames.CHAT_COMPACTED, { agentId })   // clear UI spinner on error
      log.agent.warn('background compaction failed', {
        source,
        agentId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      compactingAgents.delete(agentId)
    }
  })()
}
