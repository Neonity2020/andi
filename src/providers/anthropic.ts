import { compactConversationForContext, type ContextMessage } from '../context/truncation.ts'
import { assertProviderResponseOk, parseSSE } from './sse.ts'
import type { ProviderClient, ProviderStreamEvent, ProviderStreamInput } from './types.ts'

export type AnthropicRequestInput = {
  model: string
  messages: ContextMessage[]
  maxTokens?: number
}

export function buildAnthropicRequest({
  model,
  messages,
  maxTokens = 1024,
}: AnthropicRequestInput) {
  const normalized = normalizeMessagesForAnthropic(messages)
  const system = normalized.systemParts.length > 0 ? normalized.systemParts.join('\n\n') : undefined

  return {
    model,
    stream: true,
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages: normalized.messages,
  }
}

export type AnthropicClientOptions = {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  fetchImpl?: typeof fetch
}

export function createAnthropicClient(options: AnthropicClientOptions = {}): ProviderClient {
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY
  const baseUrl = options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com/v1'
  const fetchImpl = options.fetchImpl ?? fetch

  return {
    name: 'anthropic',
    defaultModel: options.defaultModel ?? 'claude-sonnet-4-5',
    async *stream(input: ProviderStreamInput): AsyncGenerator<ProviderStreamEvent> {
      if (!apiKey) {
        throw new Error('Missing ANTHROPIC_API_KEY')
      }

      const request = buildAnthropicRequest({
        model: input.model,
        messages: buildContextMessages(input),
        maxTokens: input.maxTokens,
      })

      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: input.signal,
      })

      await assertProviderResponseOk(response)

      for await (const data of parseSSE(response)) {
        const token = parseAnthropicStreamToken(data)
        if (token) {
          yield { type: 'token', text: token }
        }
      }

      yield { type: 'done' }
    },
  }
}

export function parseAnthropicStreamToken(data: string): string {
  const parsed = JSON.parse(data) as {
    type?: string
    delta?: { text?: string }
  }
  if (parsed.type !== 'content_block_delta') {
    return ''
  }
  return parsed.delta?.text ?? ''
}

function buildContextMessages(input: ProviderStreamInput): ContextMessage[] {
  const compacted = compactConversationForContext(input.messages)
  const messages: ContextMessage[] = []
  if (input.summary) {
    messages.push({ role: 'system', content: input.summary })
  }
  if (input.systemPrompt) {
    messages.push({ role: 'system', content: input.systemPrompt })
  }
  messages.push(...compacted.messages)
  return messages
}

function normalizeMessagesForAnthropic(messages: ContextMessage[]) {
  const systemParts: string[] = []
  const normalizedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') {
      continue
    }

    const content = typeof message.content === 'string' ? message.content : String(message.content ?? '')
    if (!content) {
      continue
    }

    if (message.role === 'system') {
      systemParts.push(content)
      continue
    }

    normalizedMessages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
    })
  }

  return { systemParts, messages: normalizedMessages }
}
