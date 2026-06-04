import {
  createOpenAICompatibleClient,
  type OpenAICompatibleClientOptions,
} from './openai-compatible.ts'
import type { ProviderClient } from './types.ts'

export type ZhipuCodingClientOptions = Partial<
  Pick<OpenAICompatibleClientOptions, 'apiKey' | 'baseUrl' | 'defaultModel' | 'fetchImpl'>
>

export function createZhipuCodingClient(options: ZhipuCodingClientOptions = {}): ProviderClient {
  return createOpenAICompatibleClient({
    name: 'zhipu-coding',
    apiKey: options.apiKey ?? process.env.ZHIPU_CODING_API_KEY,
    baseUrl: options.baseUrl ?? 'https://open.bigmodel.cn/api/coding/paas/v4',
    defaultModel: options.defaultModel ?? 'glm-4.7',
    missingKeyName: 'ZHIPU_CODING_API_KEY',
    fetchImpl: options.fetchImpl,
  })
}
