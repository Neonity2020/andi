import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderName } from '../providers/types.ts'

export type ModelConfig = {
  id: string
  label?: string
  maxTokens?: number
  contextWindow?: number
}

export type ProviderSettings = {
  id: ProviderName
  enabled: boolean
  baseUrl: string
  apiKeyEnv: string
  apiKey?: string
  defaultModel: string
  models: ModelConfig[]
}

export type AppSettings = {
  defaultProvider: ProviderName
  databasePath: string
  providers: Record<ProviderName, ProviderSettings>
}

export type LoadSettingsOptions = {
  cwd?: string
  settingsPath?: string
  envPath?: string
  env?: Record<string, string | undefined>
}

type RawSettings = {
  defaultProvider?: ProviderName
  databasePath?: string
  providers?: Partial<Record<ProviderName, Partial<ProviderSettings> & { apiKeyRef?: string }>>
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultProvider: 'openai',
  databasePath: 'data/agent.sqlite',
  providers: {
    openai: {
      id: 'openai',
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'OPENAI_API_KEY',
      defaultModel: 'gpt-4.1',
      models: [{ id: 'gpt-4.1' }, { id: 'gpt-4.1-mini' }],
    },
    anthropic: {
      id: 'anthropic',
      enabled: true,
      baseUrl: 'https://api.anthropic.com/v1',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      defaultModel: 'claude-sonnet-4-5',
      models: [{ id: 'claude-sonnet-4-5' }],
    },
    'zhipu-coding': {
      id: 'zhipu-coding',
      enabled: true,
      baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apiKeyEnv: 'ZHIPU_CODING_API_KEY',
      defaultModel: 'glm-4.7',
      models: [
        { id: 'glm-4.7' },
        { id: 'glm-5.1' },
        { id: 'glm-5-turbo' },
        { id: 'glm-4.5-air' },
      ],
    },
  },
}

export function loadSettings(options: LoadSettingsOptions = {}): AppSettings {
  const cwd = options.cwd ?? process.cwd()
  const env = {
    ...process.env,
    ...readEnvFile(options.envPath ?? join(cwd, '.env')),
    ...options.env,
  }
  const raw = readSettingsFile(options.settingsPath ?? join(cwd, 'settings.json'))
  const merged = mergeSettings(raw)

  return {
    ...merged,
    providers: {
      openai: resolveProviderSecrets(merged.providers.openai, env),
      anthropic: resolveProviderSecrets(merged.providers.anthropic, env),
      'zhipu-coding': resolveProviderSecrets(merged.providers['zhipu-coding'], env),
    },
  }
}

export function getProviderSettings(settings: AppSettings, provider: ProviderName): ProviderSettings {
  const providerSettings = settings.providers[provider]
  if (!providerSettings.enabled) {
    throw new Error(`Provider ${provider} is disabled in settings.json`)
  }
  return providerSettings
}

export function getDefaultModel(providerSettings: ProviderSettings): string {
  return providerSettings.defaultModel || providerSettings.models[0]?.id || ''
}

function mergeSettings(raw: RawSettings | null): AppSettings {
  const providers = {
    openai: mergeProviderSettings(DEFAULT_SETTINGS.providers.openai, raw?.providers?.openai),
    anthropic: mergeProviderSettings(DEFAULT_SETTINGS.providers.anthropic, raw?.providers?.anthropic),
    'zhipu-coding': mergeProviderSettings(
      DEFAULT_SETTINGS.providers['zhipu-coding'],
      raw?.providers?.['zhipu-coding'],
    ),
  }
  return {
    defaultProvider: raw?.defaultProvider ?? DEFAULT_SETTINGS.defaultProvider,
    databasePath: raw?.databasePath ?? DEFAULT_SETTINGS.databasePath,
    providers,
  }
}

function mergeProviderSettings(
  defaults: ProviderSettings,
  raw?: Partial<ProviderSettings> & { apiKeyRef?: string },
): ProviderSettings {
  const apiKeyEnv = raw?.apiKeyEnv ?? parseApiKeyRef(raw?.apiKeyRef) ?? defaults.apiKeyEnv
  return {
    ...defaults,
    ...raw,
    id: defaults.id,
    enabled: raw?.enabled ?? defaults.enabled,
    baseUrl: raw?.baseUrl ?? defaults.baseUrl,
    apiKeyEnv,
    defaultModel: raw?.defaultModel ?? defaults.defaultModel,
    models: raw?.models ?? defaults.models,
  }
}

function resolveProviderSecrets(
  provider: ProviderSettings,
  env: Record<string, string | undefined>,
): ProviderSettings {
  return {
    ...provider,
    apiKey: provider.apiKey ?? env[provider.apiKeyEnv],
  }
}

function readSettingsFile(path: string): RawSettings | null {
  if (!existsSync(path)) {
    return null
  }
  const content = readFileSync(path, 'utf8')
  return JSON.parse(content) as RawSettings
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {}
  }

  const entries: Record<string, string> = {}
  const content = readFileSync(path, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const index = line.indexOf('=')
    if (index === -1) {
      continue
    }
    const key = line.slice(0, index).trim()
    const value = unquoteEnvValue(line.slice(index + 1).trim())
    entries[key] = value
  }
  return entries
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1)
  }
  return value
}

function parseApiKeyRef(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const match = value.match(/^\$\{([A-Z0-9_]+)\}$/)
  return match?.[1] ?? value
}
