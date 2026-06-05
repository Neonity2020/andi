import { getDefaultModel, getProviderSettings, type AppSettings } from '../config/settings.ts'
import { CODING_AGENT_SYSTEM_PROMPT, buildSystemPrompt } from './system-prompt.ts'
import {
  assertProviderConfigured,
  createProviderClient,
  parseProviderName,
} from '../providers/index.ts'
import type { ProviderClient, ProviderName, ProviderToolCall } from '../providers/types.ts'
import type { SqliteSessionStore } from '../storage/sqlite-session-store.ts'
import { createDefaultToolRegistry, providerToolsFromRegistry } from '../tools/registry.ts'
import type { ToolCall, ToolExecutionContext, ToolRegistry, ToolResult } from '../tools/types.ts'

export type AgentTurnOutput = {
  write(text: string): void
  flush?(): void
}

export type AgentTurnInput = {
  store: SqliteSessionStore
  settings: AppSettings
  sessionId: number
  prompt: string
  provider?: ProviderName
  model?: string
  limit?: number
  maxTokens?: number
  output?: AgentTurnOutput
  createClient?: (provider: ProviderName, settings: AppSettings) => ProviderClient
  toolRegistry?: ToolRegistry
  toolExecutionContext?: ToolExecutionContext
  systemPrompt?: string
  maxToolIterations?: number
}

export type AgentTurnResult = {
  provider: ProviderName
  model: string
  assistantContent: string
  toolResults: ToolResult[]
}

export async function runAgentTurn({
  store,
  settings,
  sessionId,
  prompt,
  provider: requestedProvider,
  model: requestedModel,
  limit = 10,
  maxTokens = 1024,
  output,
  createClient = createProviderClient,
  toolRegistry = createDefaultToolRegistry(),
  toolExecutionContext,
  systemPrompt,
  maxToolIterations = 4,
}: AgentTurnInput): Promise<AgentTurnResult> {
  const session = store.getSession(sessionId)
  if (!session) {
    throw new Error(`Session ${sessionId} was not found`)
  }

  const provider = requestedProvider ?? parseProviderName(session.active_provider)
  const providerSettings = getProviderSettings(settings, provider)
  const model =
    requestedModel ??
    (provider === session.active_provider
      ? session.model_hint ?? getDefaultModel(providerSettings)
      : getDefaultModel(providerSettings))

  assertProviderConfigured(provider, settings)
  const client = createClient(provider, settings)

  // Build system prompt with actual provider and model
  const effectiveSystemPrompt = buildSystemPrompt(provider, model)

  if (provider !== session.active_provider) {
    store.updateSessionProvider(sessionId, provider)
    store.recordRoutingEvent({
      sessionId,
      fromProvider: session.active_provider,
      toProvider: provider,
      reason: 'send override',
    })
  }

  store.appendMessage(sessionId, {
    role: 'user',
    provider: 'local',
    model: 'none',
    content: prompt,
  })

  let assistantContent = ''
  const allToolResults: ToolResult[] = []

  for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
    const bundle = store.getSessionBundle(sessionId, limit)
    const turn = await runProviderTurn({
      client,
      model,
      messages: bundle.messages,
      summary: bundle.summary?.summary_text ?? null,
      maxTokens,
      output,
      systemPrompt: effectiveSystemPrompt,
      toolRegistry,
    })
    assistantContent += turn.assistantContent

    if (turn.toolCalls.length === 0) {
      if (turn.assistantContent && !turn.assistantContent.endsWith('\n')) {
        output?.write('\n')
      }
      output?.flush?.()
      store.appendMessage(sessionId, {
        role: 'assistant',
        provider,
        model,
        content: turn.assistantContent,
      })
      break
    }

    store.appendMessage(sessionId, {
      role: 'assistant',
      provider,
      model,
      content: turn.assistantContent,
      metadata: {
        toolCalls: turn.toolCalls.map(toStoredToolCall),
      },
    })

    const toolResults = await executeToolCalls(turn.toolCalls, toolRegistry, toolExecutionContext)
    allToolResults.push(...toolResults)
    for (const result of toolResults) {
      store.appendMessage(sessionId, {
        role: 'tool',
        provider: 'local',
        model: result.toolName,
        content: result.content,
        metadata: {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          isError: result.isError ?? false,
        },
      })
    }

    if (iteration === maxToolIterations) {
      const warning = `Stopped after ${maxToolIterations} tool iterations.`
      assistantContent += warning
      output?.write(`${warning}\n`)
      output?.flush?.()
      store.appendMessage(sessionId, {
        role: 'assistant',
        provider,
        model,
        content: warning,
      })
    }
  }

  return {
    provider,
    model,
    assistantContent,
    toolResults: allToolResults,
  }
}

async function runProviderTurn({
  client,
  model,
  messages,
  summary,
  maxTokens,
  output,
  systemPrompt,
  toolRegistry,
}: {
  client: ProviderClient
  model: string
  messages: Array<{ role?: string; content?: string; [key: string]: unknown }>
  summary: string | null
  maxTokens: number
  output?: AgentTurnOutput
  systemPrompt: string
  toolRegistry: ToolRegistry
}): Promise<{ assistantContent: string; toolCalls: ProviderToolCall[] }> {
  let assistantContent = ''
  const toolCalls: ProviderToolCall[] = []

  for await (const event of client.stream({
    model,
    messages,
    summary,
    systemPrompt,
    tools: providerToolsFromRegistry(toolRegistry),
    maxTokens,
  })) {
    if (event.type === 'token') {
      assistantContent += event.text
      output?.write(event.text)
    }
    if (event.type === 'tool_call') {
      toolCalls.push(event.toolCall)
    }
  }

  return { assistantContent, toolCalls }
}

async function executeToolCalls(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
  context?: ToolExecutionContext,
): Promise<ToolResult[]> {
  const results: ToolResult[] = []
  for (const toolCall of toolCalls) {
    const tool = registry.get(toolCall.name)
    if (!tool) {
      results.push({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: `Tool not found: ${toolCall.name}`,
        isError: true,
      })
      continue
    }

    try {
      results.push({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: await tool.execute(toolCall.input, context),
      })
    } catch (error) {
      results.push({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      })
    }
  }
  return results
}

function toStoredToolCall(toolCall: ProviderToolCall) {
  return {
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    arguments: JSON.stringify(toolCall.input ?? {}),
  }
}
