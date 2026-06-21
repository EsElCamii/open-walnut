/**
 * Context Inspector route — exposes the full agent context for debugging.
 * GET /api/context returns every section the agent sees each turn.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { validateAgentId, validateConversationId } from '../../constants.js'
import { getConfig } from '../../core/config-manager.js'
import { DEFAULT_MODEL } from '../../agent/model.js'
import { DEFAULT_MAX_TOKENS } from '../../agent/providers/defaults.js'
import { buildRoleSection, buildSystemPrompt, buildTaskCategoriesSection, getNotesContext } from '../../agent/context.js'
import { buildSkillsPrompt } from '../../core/skill-loader.js'
import { getCompactionSummary, getModelContext } from '../../core/chat-history.js'
import { getMemoryFile } from '../../core/memory-file.js'
import { getAllProjectSummaries } from '../../core/project-memory.js'
import { getDailyLogsWithinBudget, estimateTokens, estimateMessagesTokens, estimateFullPayload } from '../../core/daily-log.js'
import { getToolSchemas } from '../../agent/tools.js'

export const contextInspectorRouter = Router()

const DAILY_LOG_HALF_BUDGET = 5000

// GET /api/context?agentId=general
contextInspectorRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawAgentId = (req.query.agentId as string) || undefined
    const agentId = rawAgentId ? validateAgentId(rawAgentId) : undefined
    const rawConvId = (req.query.conversationId as string) || undefined
    // Resolve the conversation at the boundary: an explicit id wins, otherwise
    // fall back to the agent's ACTIVE conversation. The inspector always reflects
    // a real conversation's context — never the deprecated legacy ghost file.
    let conversationId = rawConvId ? validateConversationId(rawConvId) : undefined
    if (!conversationId) {
      const { getActiveConversationId } = await import('../../core/conversations.js')
      conversationId = await getActiveConversationId(agentId ?? 'general')
    }
    const config = await getConfig()

    // Non-General console agent — simplified context view
    if (agentId && agentId !== 'general') {
      const { getConsoleAgent } = await import('../../core/agent-registry.js')
      const { buildSubagentToolSet } = await import('../../agent/subagent-context.js')
      const { loadContextSources } = await import('../../agent/context-sources.js')
      const agentDef = await getConsoleAgent(agentId)
      if (!agentDef) {
        res.status(404).json({ error: `Console agent '${agentId}' not found` })
        return
      }

      const systemPrompt = agentDef.system_prompt ?? `You are ${agentDef.name}.`
      const contextXml = await loadContextSources(agentDef, {})
      const fullSystem = contextXml ? systemPrompt + '\n\n' + contextXml : systemPrompt
      const agentTools = await buildSubagentToolSet(agentDef)
      const apiMessages = await getModelContext(agentId, conversationId)
      const compactionContent = await getCompactionSummary(agentId, conversationId).catch(() => null) ?? ''
      // Separate memory/daily for agent vs main, shown as distinct sections
      const ownMemory = getMemoryFile(agentId)?.content ?? ''
      const mainMemory = getMemoryFile(undefined)?.content ?? ''
      const ownDaily = getDailyLogsWithinBudget(DAILY_LOG_HALF_BUDGET, agentId)
      const mainDaily = getDailyLogsWithinBudget(DAILY_LOG_HALF_BUDGET, undefined)

      const systemTokens = estimateTokens(fullSystem)
      const toolsTokens = estimateTokens(JSON.stringify(agentTools))
      const messagesTokens = estimateMessagesTokens(apiMessages)
      const compactionTokens = estimateTokens(compactionContent)
      const ownMemoryTokens = estimateTokens(ownMemory)
      const mainMemoryTokens = estimateTokens(mainMemory)
      const ownDailyTokens = estimateTokens(ownDaily)
      const mainDailyTokens = estimateTokens(mainDaily)
      const totalTokens = systemTokens + toolsTokens + messagesTokens

      res.json({
        sections: {
          modelConfig: {
            content: { model: config.agent?.main_model ?? DEFAULT_MODEL, agent: agentDef.name },
            tokens: 0,
          },
          roleAndRules: {
            content: fullSystem,
            tokens: systemTokens,
          },
          skills: { content: '', tokens: 0 },
          compactionSummary: { content: compactionContent, tokens: compactionTokens },
          taskCategories: { content: '', tokens: 0 },
          agentMemory: { content: ownMemory || '(no agent memory yet)', tokens: ownMemoryTokens },
          mainAgentMemory: { content: mainMemory || '(no main memory)', tokens: mainMemoryTokens },
          agentDailyLogs: { content: ownDaily || '(no agent daily logs)', tokens: ownDailyTokens },
          mainAgentDailyLogs: { content: mainDaily || '(no main daily logs)', tokens: mainDailyTokens },
          globalMemory: { content: '', tokens: 0 },
          projectSummaries: { content: '', tokens: 0, count: 0 },
          notesContext: { content: '', tokens: 0 },
          dailyLogs: { content: '', tokens: 0 },
          tools: { content: agentTools, tokens: toolsTokens, count: agentTools.length },
          apiMessages: { content: apiMessages, tokens: messagesTokens, count: apiMessages.length },
        },
        totalTokens,
      })
      return
    }

    // General agent — full context view
    const name = config.user.name ?? 'the user'

    // Gather each section independently
    const roleContent = buildRoleSection(name)
    const skillsContent = await buildSkillsPrompt() ?? ''
    const compactionContent = await getCompactionSummary(undefined, conversationId).catch(() => null) ?? ''
    const globalMemory = getMemoryFile()?.content ?? ''
    const projectSummaries = getAllProjectSummaries()
    const dailyLogs = getDailyLogsWithinBudget(Math.floor(20000 / 2))
    const toolSchemas = getToolSchemas()
    const apiMessages = await getModelContext(undefined, conversationId)

    // Task categories & projects overview
    const taskCategoriesText = await buildTaskCategoriesSection()

    // Format project summaries as text (same as buildMemoryContext)
    const projectSummariesText = projectSummaries.length > 0
      ? projectSummaries.map((s) => `- **${s.name}** (${s.path}): ${s.description}`).join('\n')
      : '(No projects yet.)'

    // Token estimates per section
    const roleTokens = estimateTokens(roleContent)
    const skillsTokens = estimateTokens(skillsContent)
    const compactionTokens = estimateTokens(compactionContent)
    const taskCategoriesTokens = estimateTokens(taskCategoriesText)
    const globalMemoryTokens = estimateTokens(globalMemory)
    const projectSummariesTokens = estimateTokens(projectSummariesText)
    const dailyLogsTokens = estimateTokens(dailyLogs)
    const toolsText = JSON.stringify(toolSchemas)
    const toolsTokens = estimateTokens(toolsText)

    // Use robust estimation for messages to handle images correctly
    // (by pixel dimensions, not base64 size which can inflate by 500x)
    const messagesTokens = estimateMessagesTokens(apiMessages)

    // Model config — mirror what the agent loop actually uses (loop.ts lines 146-150)
    const modelConfig = {
      model: config.agent?.main_model ?? config.agent?.model ?? DEFAULT_MODEL,
      max_tokens: config.agent?.maxTokens ?? DEFAULT_MAX_TOKENS,
      region: config.agent?.region ?? config.provider?.bedrock_region ?? 'us-west-2',
    }
    const modelConfigText = JSON.stringify(modelConfig)
    const modelConfigTokens = estimateTokens(modelConfigText)

    // Use the actual buildSystemPrompt() for the total, consistent with
    // needsCompaction() and /api/chat/stats. The per-section breakdowns above
    // are informational for the UI; the total must match the real payload.
    const actualSystemPrompt = await buildSystemPrompt(undefined, conversationId)
    const payloadEstimate = estimateFullPayload({ system: actualSystemPrompt, tools: toolSchemas, messages: apiMessages })

    // totalTokens uses the payload estimate for consistency, plus model config overhead
    const totalTokens = payloadEstimate.total + modelConfigTokens

    res.json({
      sections: {
        modelConfig: {
          content: modelConfig,
          tokens: modelConfigTokens,
        },
        roleAndRules: {
          content: roleContent,
          tokens: roleTokens,
        },
        skills: {
          content: skillsContent,
          tokens: skillsTokens,
        },
        compactionSummary: {
          content: compactionContent,
          tokens: compactionTokens,
        },
        taskCategories: {
          content: taskCategoriesText,
          tokens: taskCategoriesTokens,
        },
        globalMemory: {
          content: globalMemory,
          tokens: globalMemoryTokens,
        },
        projectSummaries: {
          content: projectSummariesText,
          tokens: projectSummariesTokens,
          count: projectSummaries.length,
        },
        notesContext: {
          content: getNotesContext(),
          tokens: estimateTokens(getNotesContext()),
        },
        dailyLogs: {
          content: dailyLogs,
          tokens: dailyLogsTokens,
        },
        tools: {
          content: toolSchemas,
          tokens: toolsTokens,
          count: toolSchemas.length,
        },
        apiMessages: {
          content: apiMessages,
          tokens: messagesTokens,
          count: apiMessages.length,
        },
      },
      totalTokens,
    })
  } catch (err) {
    next(err)
  }
})
