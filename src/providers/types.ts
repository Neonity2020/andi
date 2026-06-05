import type { ContextMessage } from '../context/truncation.ts'

export type ProviderName = 'openai' | 'anthropic' | 'zhipu-coding'

export type ProviderStreamInput = {
  model: string
  messages: ContextMessage[]
  summary?: string | null
  systemPrompt?: string | null
  tools?: ProviderTool[]
  maxTokens?: number
  signal?: AbortSignal
}

export type ProviderTool = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: unknown
  }
}

export type ProviderToolCall = {
  id: string
  name: string
  input: unknown
}

export type ProviderStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; toolCall: ProviderToolCall }
  | { type: 'done' }

export type ProviderClient = {
  name: ProviderName
  defaultModel: string
  stream(input: ProviderStreamInput): AsyncGenerator<ProviderStreamEvent>
}
