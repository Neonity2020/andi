import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings } from '../src/config/settings.ts'
import { assertProviderConfigured, createProviderClient } from '../src/providers/index.ts'

describe('settings loader', () => {
  test('loads provider settings from settings.json and API keys from .env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-settings-'))
    try {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'anthropic',
          databasePath: 'custom/agent.sqlite',
          providers: {
            openai: {
              baseUrl: 'https://proxy.example/v1',
              apiKeyRef: '${CUSTOM_OPENAI_KEY}',
              defaultModel: 'gpt-custom',
              models: [{ id: 'gpt-custom' }],
            },
            'zhipu-coding': {
              baseUrl: 'https://zhipu.example/v1',
              apiKeyRef: '${CUSTOM_ZHIPU_KEY}',
              defaultModel: 'glm-custom',
              models: [{ id: 'glm-custom' }],
            },
          },
        }),
      )
      writeFileSync(
        join(dir, '.env'),
        'CUSTOM_OPENAI_KEY=secret-openai\nCUSTOM_ZHIPU_KEY=secret-zhipu\n',
      )

      const settings = loadSettings({ cwd: dir, env: {} })

      expect(settings.defaultProvider).toBe('anthropic')
      expect(settings.databasePath).toBe('custom/agent.sqlite')
      expect(settings.providers.openai.baseUrl).toBe('https://proxy.example/v1')
      expect(settings.providers.openai.apiKeyEnv).toBe('CUSTOM_OPENAI_KEY')
      expect(settings.providers.openai.apiKey).toBe('secret-openai')
      expect(settings.providers.openai.defaultModel).toBe('gpt-custom')
      expect(settings.providers['zhipu-coding'].baseUrl).toBe('https://zhipu.example/v1')
      expect(settings.providers['zhipu-coding'].apiKeyEnv).toBe('CUSTOM_ZHIPU_KEY')
      expect(settings.providers['zhipu-coding'].apiKey).toBe('secret-zhipu')
      expect(settings.providers['zhipu-coding'].defaultModel).toBe('glm-custom')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('includes zhipu coding defaults', () => {
    const settings = loadSettings({
      env: { ZHIPU_CODING_API_KEY: 'test-zhipu-key' },
    })

    expect(settings.providers['zhipu-coding'].baseUrl).toBe(
      'https://open.bigmodel.cn/api/coding/paas/v4',
    )
    expect(settings.providers['zhipu-coding'].apiKeyEnv).toBe('ZHIPU_CODING_API_KEY')
    expect(settings.providers['zhipu-coding'].apiKey).toBe('test-zhipu-key')
    expect(settings.providers['zhipu-coding'].defaultModel).toBe('glm-4.7')
    expect(settings.providers['zhipu-coding'].models.map(model => model.id)).toEqual([
      'glm-4.7',
      'glm-5.1',
      'glm-5-turbo',
      'glm-4.5-air',
    ])
  })

  test('uses resolved settings when constructing provider clients', () => {
    const settings = loadSettings({
      env: { OPENAI_API_KEY: 'test-key' },
    })

    const client = createProviderClient('openai', settings)

    expect(client.defaultModel).toBe('gpt-4.1')
    expect(() => assertProviderConfigured('openai', settings)).not.toThrow()
  })

  test('reports missing key using the configured env name', () => {
    const settings = loadSettings({
      env: {
        OPENAI_API_KEY: undefined,
      },
    })

    expect(() => assertProviderConfigured('openai', settings)).toThrow('Missing OPENAI_API_KEY')
  })

  test('reports missing zhipu coding key using the configured env name', () => {
    const settings = loadSettings({
      env: {
        ZHIPU_CODING_API_KEY: undefined,
      },
    })

    expect(() => assertProviderConfigured('zhipu-coding', settings)).toThrow(
      'Missing ZHIPU_CODING_API_KEY',
    )
  })
})
