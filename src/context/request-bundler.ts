import {
  compactConversationForContext,
  type ContextMessage,
  type ContextLimitOverrides,
} from './truncation.ts'
import { buildOpenAIRequest } from '../providers/openai.ts'
import { buildAnthropicRequest } from '../providers/anthropic.ts'

export type ProviderName = 'openai' | 'anthropic' | 'zhipu-coding'

export type BuildProviderRequestInput = {
  provider: ProviderName
  model: string
  messages: ContextMessage[]
  summary: string | null
  systemPrompt?: string | null
  limits?: ContextLimitOverrides
  maxTokens?: number
}

export function buildProviderRequest({
  provider,
  model,
  messages,
  summary,
  systemPrompt = null,
  limits = {},
  maxTokens = 1024,
}: BuildProviderRequestInput) {
  const compacted = compactConversationForContext(messages, limits)
  const contextMessages: ContextMessage[] = []

  if (summary) {
    contextMessages.push({
      role: 'system',
      content: summary,
    })
  }

  if (systemPrompt) {
    contextMessages.push({
      role: 'system',
      content: systemPrompt,
    })
  }

  contextMessages.push(...compacted.messages)

  if (provider === 'anthropic') {
    return {
      bundle: compacted,
      request: buildAnthropicRequest({
        model,
        messages: contextMessages,
        maxTokens,
      }),
    }
  }

  return {
    bundle: compacted,
    request: buildOpenAIRequest({
      model,
      messages: contextMessages,
      maxTokens,
    }),
  }
}
