import type { ContextMessage } from '../context/truncation.ts'

export type ProviderName = 'openai' | 'anthropic' | 'zhipu-coding'

export type ProviderStreamInput = {
  model: string
  messages: ContextMessage[]
  summary?: string | null
  systemPrompt?: string | null
  maxTokens?: number
  signal?: AbortSignal
}

export type ProviderStreamEvent =
  | { type: 'token'; text: string }
  | { type: 'done' }

export type ProviderClient = {
  name: ProviderName
  defaultModel: string
  stream(input: ProviderStreamInput): AsyncGenerator<ProviderStreamEvent>
}
