import type { AppSettings, ProviderSettings } from './settings.ts'
import { DEFAULT_SETTINGS } from './settings.ts'
import type { ProviderName } from '../providers/types.ts'

export type OnboardingSelection = {
  provider: ProviderName
  model: string
  apiKeyEnv?: string
  apiKey?: string
  databasePath?: string
}

export type OnboardingProviderChoice = {
  id: ProviderName
  label: string
  settings: ProviderSettings
}

export const PROVIDER_LABELS: Record<ProviderName, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic Claude',
  'zhipu-coding': '智谱 GLM Coding Plan',
}

export function getOnboardingProviderChoices(
  settings: AppSettings = DEFAULT_SETTINGS,
): OnboardingProviderChoice[] {
  return Object.values(settings.providers).map(provider => ({
    id: provider.id,
    label: PROVIDER_LABELS[provider.id],
    settings: provider,
  }))
}

export function createOnboardingSettings(selection: OnboardingSelection): AppSettings {
  const settings = structuredClone(DEFAULT_SETTINGS) as AppSettings
  const provider = settings.providers[selection.provider]
  provider.defaultModel = selection.model
  if (selection.apiKeyEnv) {
    provider.apiKeyEnv = selection.apiKeyEnv
  }

  return {
    ...settings,
    defaultProvider: selection.provider,
    databasePath: selection.databasePath ?? DEFAULT_SETTINGS.databasePath,
  }
}

export function renderSettingsJson(selection: OnboardingSelection): string {
  const settings = createOnboardingSettings(selection)
  return `${JSON.stringify(toSettingsFileShape(settings), null, 2)}\n`
}

export function renderEnvFile(selection: OnboardingSelection): string {
  const settings = createOnboardingSettings(selection)
  return `${Object.values(settings.providers)
    .map(provider => `${provider.apiKeyEnv}=${provider.id === selection.provider ? selection.apiKey ?? '' : ''}`)
    .join('\n')}\n`
}

function toSettingsFileShape(settings: AppSettings) {
  return {
    defaultProvider: settings.defaultProvider,
    databasePath: settings.databasePath,
    providers: Object.fromEntries(
      Object.entries(settings.providers).map(([id, provider]) => [
        id,
        {
          enabled: provider.enabled,
          baseUrl: provider.baseUrl,
          apiKeyRef: `\${${provider.apiKeyEnv}}`,
          defaultModel: provider.defaultModel,
          models: provider.models,
        },
      ]),
    ),
  }
}
