import {
  buildOpenAICompatibleRequest,
  createOpenAICompatibleClient,
  parseOpenAICompatibleStreamToken,
} from './openai-compatible.ts'
import type { ProviderClient } from './types.ts'

export const buildOpenAIRequest = buildOpenAICompatibleRequest
export const parseOpenAIStreamToken = parseOpenAICompatibleStreamToken

export type OpenAIClientOptions = {
  apiKey?: string
  baseUrl?: string
  defaultModel?: string
  fetchImpl?: typeof fetch
}

export function createOpenAIClient(options: OpenAIClientOptions = {}): ProviderClient {
  return createOpenAICompatibleClient({
    name: 'openai',
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseUrl: options.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    defaultModel: options.defaultModel ?? 'gpt-4.1',
    missingKeyName: 'OPENAI_API_KEY',
    fetchImpl: options.fetchImpl,
  })
}
