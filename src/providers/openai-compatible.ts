import { compactConversationForContext, type ContextMessage } from '../context/truncation.ts'
import { assertProviderResponseOk, parseSSE } from './sse.ts'
import type {
  ProviderClient,
  ProviderName,
  ProviderStreamEvent,
  ProviderStreamInput,
  ProviderToolCall,
} from './types.ts'

export type OpenAICompatibleRequestInput = {
  model: string
  messages: ContextMessage[]
  tools?: ProviderStreamInput['tools']
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
  tools = [],
  maxTokens = 1024,
}: OpenAICompatibleRequestInput) {
  return {
    model,
    stream: true,
    max_tokens: maxTokens,
    messages: normalizeMessagesForOpenAICompatible(messages),
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
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
        tools: input.tools,
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

      const toolCallAccumulator = new Map<number, { id: string; name: string; argumentsText: string }>()

      for await (const data of parseSSE(response)) {
        if (data === '[DONE]') {
          for (const toolCall of finalizeOpenAICompatibleToolCalls(toolCallAccumulator)) {
            yield { type: 'tool_call', toolCall }
          }
          yield { type: 'done' }
          return
        }

        const token = parseOpenAICompatibleStreamToken(data)
        if (token) {
          yield { type: 'token', text: token }
        }

        collectOpenAICompatibleToolCallDeltas(data, toolCallAccumulator)
      }

      for (const toolCall of finalizeOpenAICompatibleToolCalls(toolCallAccumulator)) {
        yield { type: 'tool_call', toolCall }
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
    .map(normalizeMessageForOpenAICompatible)
    .filter(Boolean)
}

function normalizeRole(role: ContextMessage['role']) {
  if (role === 'tool') {
    return 'tool'
  }
  if (role === 'assistant' || role === 'user' || role === 'system') {
    return role
  }

  return 'user'
}

function normalizeMessageForOpenAICompatible(message: ContextMessage) {
  const role = normalizeRole(message.role)
  const content = typeof message.content === 'string' ? message.content : String(message.content ?? '')
  const metadata = normalizeMetadata(message.metadata)

  if (role === 'tool') {
    return {
      role,
      tool_call_id: metadata?.toolCallId ?? metadata?.tool_call_id ?? 'unknown_tool_call',
      content,
    }
  }

  if (role === 'assistant' && Array.isArray(metadata?.toolCalls)) {
    return {
      role,
      content: content.length > 0 ? content : null,
      tool_calls: metadata.toolCalls.map((toolCall: Record<string, unknown>) => ({
        id: String(toolCall.id ?? ''),
        type: 'function',
        function: {
          name: String(toolCall.name ?? ''),
          arguments:
            typeof toolCall.arguments === 'string'
              ? toolCall.arguments
              : JSON.stringify(toolCall.input ?? {}),
        },
      })),
    }
  }

  if (content.length === 0) {
    return null
  }

  return { role, content }
}

function normalizeMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') {
    return null
  }
  return metadata as Record<string, unknown>
}

function collectOpenAICompatibleToolCallDeltas(
  data: string,
  accumulator: Map<number, { id: string; name: string; argumentsText: string }>,
): void {
  const parsed = JSON.parse(data) as {
    choices?: Array<{
      delta?: {
        tool_calls?: Array<{
          index?: number
          id?: string
          function?: { name?: string; arguments?: string }
        }>
      }
    }>
  }

  for (const choice of parsed.choices ?? []) {
    for (const delta of choice.delta?.tool_calls ?? []) {
      const index = delta.index ?? 0
      const current = accumulator.get(index) ?? { id: '', name: '', argumentsText: '' }
      accumulator.set(index, {
        id: delta.id ?? current.id,
        name: delta.function?.name ?? current.name,
        argumentsText: current.argumentsText + (delta.function?.arguments ?? ''),
      })
    }
  }
}

function finalizeOpenAICompatibleToolCalls(
  accumulator: Map<number, { id: string; name: string; argumentsText: string }>,
): ProviderToolCall[] {
  const toolCalls: ProviderToolCall[] = []
  for (const [index, call] of [...accumulator.entries()].sort(([left], [right]) => left - right)) {
    if (!call.name) {
      continue
    }
    toolCalls.push({
      id: call.id || `tool_call_${index}`,
      name: call.name,
      input: parseToolArguments(call.argumentsText),
    })
  }
  accumulator.clear()
  return toolCalls
}

function parseToolArguments(argumentsText: string): unknown {
  if (!argumentsText.trim()) {
    return {}
  }
  try {
    return JSON.parse(argumentsText)
  } catch {
    return { raw: argumentsText }
  }
}
