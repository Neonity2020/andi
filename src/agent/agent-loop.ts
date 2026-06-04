import { getDefaultModel, getProviderSettings, type AppSettings } from '../config/settings.ts'
import {
  assertProviderConfigured,
  createProviderClient,
  parseProviderName,
} from '../providers/index.ts'
import type { ProviderClient, ProviderName } from '../providers/types.ts'
import type { SqliteSessionStore } from '../storage/sqlite-session-store.ts'

export type AgentTurnOutput = {
  write(text: string): void
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
}

export type AgentTurnResult = {
  provider: ProviderName
  model: string
  assistantContent: string
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

  const bundle = store.getSessionBundle(sessionId, limit)
  let assistantContent = ''

  for await (const event of client.stream({
    model,
    messages: bundle.messages,
    summary: bundle.summary?.summary_text ?? null,
    maxTokens,
  })) {
    if (event.type === 'token') {
      assistantContent += event.text
      output?.write(event.text)
    }
  }

  if (assistantContent && !assistantContent.endsWith('\n')) {
    output?.write('\n')
  }

  store.appendMessage(sessionId, {
    role: 'assistant',
    provider,
    model,
    content: assistantContent,
  })

  return {
    provider,
    model,
    assistantContent,
  }
}
