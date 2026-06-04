import { describe, expect, test } from 'bun:test'
import {
  createOnboardingSettings,
  getOnboardingProviderChoices,
  renderEnvFile,
  renderSettingsJson,
} from '../src/config/onboarding.ts'

describe('onboarding config generation', () => {
  test('lists all supported providers for first-run setup', () => {
    const providers = getOnboardingProviderChoices().map(choice => choice.id)

    expect(providers).toEqual(['openai', 'anthropic', 'zhipu-coding'])
  })

  test('creates settings for selected provider and model', () => {
    const settings = createOnboardingSettings({
      provider: 'zhipu-coding',
      model: 'glm-5.1',
    })

    expect(settings.defaultProvider).toBe('zhipu-coding')
    expect(settings.providers['zhipu-coding'].defaultModel).toBe('glm-5.1')
    expect(settings.providers['zhipu-coding'].apiKeyEnv).toBe('ZHIPU_CODING_API_KEY')
  })

  test('renders settings.json and .env content', () => {
    const settingsJson = renderSettingsJson({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKeyEnv: 'CUSTOM_ANTHROPIC_KEY',
    })
    const envFile = renderEnvFile({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      apiKeyEnv: 'CUSTOM_ANTHROPIC_KEY',
      apiKey: 'secret',
    })

    expect(settingsJson).toContain('"defaultProvider": "anthropic"')
    expect(settingsJson).toContain('"apiKeyRef": "${CUSTOM_ANTHROPIC_KEY}"')
    expect(envFile).toContain('CUSTOM_ANTHROPIC_KEY=secret')
    expect(envFile).toContain('ZHIPU_CODING_API_KEY=')
  })
})
