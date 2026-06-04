import { getProviderSettings, type AppSettings } from '../config/settings.ts'
import { createAnthropicClient } from './anthropic.ts'
import { createOpenAIClient } from './openai.ts'
import { createZhipuCodingClient } from './zhipu-coding.ts'
import type { ProviderClient, ProviderName } from './types.ts'

export function createProviderClient(provider: ProviderName, settings?: AppSettings): ProviderClient {
  const providerSettings = settings ? getProviderSettings(settings, provider) : null
  if (provider === 'anthropic') {
    return createAnthropicClient(
      providerSettings
        ? {
            apiKey: providerSettings.apiKey,
            baseUrl: providerSettings.baseUrl,
            defaultModel: providerSettings.defaultModel,
          }
        : {},
    )
  }
  if (provider === 'zhipu-coding') {
    return createZhipuCodingClient(
      providerSettings
        ? {
            apiKey: providerSettings.apiKey,
            baseUrl: providerSettings.baseUrl,
            defaultModel: providerSettings.defaultModel,
          }
        : {},
    )
  }
  return createOpenAIClient(
    providerSettings
      ? {
          apiKey: providerSettings.apiKey,
          baseUrl: providerSettings.baseUrl,
          defaultModel: providerSettings.defaultModel,
        }
      : {},
  )
}

export function parseProviderName(value: unknown, fallback: ProviderName = 'openai'): ProviderName {
  if (value === 'openai' || value === 'anthropic' || value === 'zhipu-coding') {
    return value
  }
  return fallback
}

export function assertProviderConfigured(provider: ProviderName, settings?: AppSettings): void {
  if (settings) {
    const providerSettings = getProviderSettings(settings, provider)
    if (!providerSettings.apiKey) {
      throw new Error(`Missing ${providerSettings.apiKeyEnv}`)
    }
    return
  }

  const envName =
    provider === 'anthropic'
      ? 'ANTHROPIC_API_KEY'
      : provider === 'zhipu-coding'
        ? 'ZHIPU_CODING_API_KEY'
        : 'OPENAI_API_KEY'
  if (!process.env[envName]) {
    throw new Error(`Missing ${envName}`)
  }
}
