import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentTurn } from '../src/agent/agent-loop.ts'
import { loadSettings } from '../src/config/settings.ts'
import type { ProviderClient } from '../src/providers/types.ts'
import { SqliteSessionStore } from '../src/storage/sqlite-session-store.ts'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('agent loop', () => {
  test('streams an assistant turn and persists user and assistant messages', async () => {
    const { store } = createStore()
    const settings = loadSettings({ env: { OPENAI_API_KEY: 'test-openai-key' } })
    const session = store.createSession({
      title: 'agent test',
      activeProvider: 'openai',
      modelHint: 'gpt-4.1',
    })
    const writes: string[] = []

    const result = await runAgentTurn({
      store,
      settings,
      sessionId: session.id,
      prompt: 'hello',
      output: { write: text => writes.push(text) },
      createClient: () => createMockClient('openai', 'gpt-4.1', ['hi', ' there']),
    })

    const messages = store.listRecentMessages(session.id, 10)
    expect(result.assistantContent).toBe('hi there')
    expect(writes.join('')).toBe('hi there\n')
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant'])
    expect(messages[0]?.content).toBe('hello')
    expect(messages[1]?.content).toBe('hi there')
    store.close()
  })

  test('provider override switches the active provider before streaming', async () => {
    const { store } = createStore()
    const settings = loadSettings({
      env: {
        OPENAI_API_KEY: 'test-openai-key',
        ZHIPU_CODING_API_KEY: 'test-zhipu-key',
      },
    })
    const session = store.createSession({
      title: 'switch test',
      activeProvider: 'openai',
      modelHint: 'gpt-4.1',
    })

    const result = await runAgentTurn({
      store,
      settings,
      sessionId: session.id,
      prompt: 'switch',
      provider: 'zhipu-coding',
      createClient: provider => createMockClient(provider, 'glm-4.7', ['ok']),
    })

    expect(result.provider).toBe('zhipu-coding')
    expect(result.model).toBe('glm-4.7')
    expect(store.getSession(session.id)?.active_provider).toBe('zhipu-coding')
    store.close()
  })

  test('missing session fails before appending messages', async () => {
    const { store } = createStore()
    const settings = loadSettings({ env: { OPENAI_API_KEY: 'test-openai-key' } })

    await expect(
      runAgentTurn({
        store,
        settings,
        sessionId: 404,
        prompt: 'hello',
        createClient: () => createMockClient('openai', 'gpt-4.1', ['unused']),
      }),
    ).rejects.toThrow('Session 404 was not found')

    store.close()
  })
})

function createStore(): { store: SqliteSessionStore } {
  const dir = mkdtempSync(join(tmpdir(), 'andi-agent-loop-'))
  tempDirs.push(dir)
  return {
    store: new SqliteSessionStore(join(dir, 'agent.sqlite')),
  }
}

function createMockClient(name: ProviderClient['name'], defaultModel: string, tokens: string[]): ProviderClient {
  return {
    name,
    defaultModel,
    async *stream() {
      for (const text of tokens) {
        yield { type: 'token', text }
      }
      yield { type: 'done' }
    },
  }
}
