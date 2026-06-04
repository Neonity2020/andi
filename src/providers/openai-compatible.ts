import { compactConversationForContext, type ContextMessage } from '../context/truncation.ts'
import { assertProviderResponseOk, parseSSE } from './sse.ts'
import type { ProviderClient, ProviderName, ProviderStreamEvent, ProviderStreamInput } from './types.ts'

export type OpenAICompatibleRequestInput = {
  model: string
  messages: ContextMessage[]
  maxTokens?: number
}

export type OpenAICompatibleClientOptions = {
  name: ProviderName
  apiKey?: string
  baseUrl: string
  defaultModel: string
  missingKeyName: string
  fetchImpl?: typeof fetch
}

export function buildOpenAICompatibleRequest({
  model,
  messages,
  maxTokens = 1024,
}: OpenAICompatibleRequestInput) {
  return {
    model,
    stream: true,
    max_tokens: maxTokens,
    messages: normalizeMessagesForOpenAICompatible(messages),
  }
}

export function createOpenAICompatibleClient({
  name,
  apiKey,
  baseUrl,
  defaultModel,
  missingKeyName,
  fetchImpl = fetch,
}: OpenAICompatibleClientOptions): ProviderClient {
  return {
    name,
    defaultModel,
    async *stream(input: ProviderStreamInput): AsyncGenerator<ProviderStreamEvent> {
      if (!apiKey) {
        throw new Error(`Missing ${missingKeyName}`)
      }

      const request = buildOpenAICompatibleRequest({
        model: input.model,
        messages: buildContextMessages(input),
        maxTokens: input.maxTokens,
      })

      const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: input.signal,
      })

      await assertProviderResponseOk(response)

      for await (const data of parseSSE(response)) {
        if (data === '[DONE]') {
          yield { type: 'done' }
          return
        }

        const token = parseOpenAICompatibleStreamToken(data)
        if (token) {
          yield { type: 'token', text: token }
        }
      }

      yield { type: 'done' }
    },
  }
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

export function parseOpenAICompatibleStreamToken(data: string): string {
  const parsed = JSON.parse(data) as {
    choices?: Array<{ delta?: { content?: string } }>
  }
  return parsed.choices?.[0]?.delta?.content ?? ''
}

function normalizeMessagesForOpenAICompatible(messages: ContextMessage[]) {
  return messages
    .filter(message => message && typeof message === 'object')
    .map(message => ({
      role: normalizeRole(message.role),
      content: typeof message.content === 'string' ? message.content : String(message.content ?? ''),
    }))
    .filter(message => message.content.length > 0)
}

function normalizeRole(role: ContextMessage['role']) {
  if (role === 'assistant' || role === 'user' || role === 'system') {
    return role
  }

  return 'user'
}
