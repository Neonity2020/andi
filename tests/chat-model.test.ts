import { describe, expect, it } from 'bun:test'
import { runChatCommand } from '../src/cli/chat.ts'
import { SqliteSessionStore } from '../src/storage/sqlite-session-store.ts'
import { unlinkSync, existsSync } from 'node:fs'

// 测试用的 mock readLine
function createMockReadLine(inputs: string[]) {
  let index = 0
  return async (_prompt: string): Promise<string | null> => {
    if (index < inputs.length) {
      return inputs[index++]
    }
    return null
  }
}

function getTestSettings() {
  return {
    defaultProvider: 'zhipu-coding' as const,
    databasePath: '',
    providers: {
      'zhipu-coding': {
        id: 'zhipu-coding' as const,
        enabled: true,
        baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apiKeyEnv: 'ZHIPU_CODING_API_KEY',
        defaultModel: 'glm-4.7',
        models: [
          { id: 'glm-4.7', label: 'GLM-4.7', maxTokens: 32000 },
          { id: 'glm-5.1', label: 'GLM-5.1', maxTokens: 64000 },
          { id: 'glm-5-turbo', label: 'GLM-5 Turbo' },
          { id: 'glm-4.5-air', label: 'GLM-4.5 Air' },
        ],
      },
      openai: { id: 'openai' as const, enabled: true, baseUrl: '', apiKeyEnv: '', defaultModel: 'gpt-4.1', models: [] },
      anthropic: { id: 'anthropic' as const, enabled: true, baseUrl: '', apiKeyEnv: '', defaultModel: '', models: [] },
    },
  }
}

function cleanDb(path: string) {
  try {
    if (existsSync(path)) unlinkSync(path)
    const walPath = path + '-wal'
    const shmPath = path + '-shm'
    if (existsSync(walPath)) unlinkSync(walPath)
    if (existsSync(shmPath)) unlinkSync(shmPath)
  } catch {
    // ignore
  }
}

describe('/model command', () => {
  it('shows model list when /model is entered without argument', async () => {
    const dbPath = `/tmp/test-chat-${Date.now()}-1.sqlite`
    cleanDb(dbPath)

    // Create initial session
    const store = new SqliteSessionStore(dbPath)
    const session = store.createSession({
      title: 'test session',
      activeProvider: 'zhipu-coding',
      modelHint: 'glm-4.7',
    })
    store.close()

    const outputs: string[] = []
    const mockOutput = { write: (text: string) => outputs.push(text), isTTY: false }

    const mockTurnRunner = async () => ({ provider: 'zhipu-coding' as const, model: 'glm-4.7', assistantContent: '' })

    await runChatCommand({
      flags: { session: String(session.id) },
      settings: { ...getTestSettings(), databasePath: dbPath },
      dbPath,
      readLine: createMockReadLine(['/model', '/exit']),
      output: mockOutput as any,
      turnRunner: mockTurnRunner as any,
    })

    const output = outputs.join('')
    expect(output).toContain('Current: glm-4.7')
    expect(output).toContain('Available models for zhipu-coding')
    expect(output).toContain('1. GLM-4.7')
    expect(output).toContain('2. GLM-5.1')
    expect(output).toContain('→') // current model marker
    expect(output).toContain('/model glm-4.7') // example

    cleanDb(dbPath)
  })

  it('switches model by number when /model <n> is entered', async () => {
    const dbPath = `/tmp/test-chat-${Date.now()}-2.sqlite`
    cleanDb(dbPath)

    const store = new SqliteSessionStore(dbPath)
    const session = store.createSession({
      title: 'test session',
      activeProvider: 'zhipu-coding',
      modelHint: 'glm-4.7',
    })
    store.close()

    const outputs: string[] = []
    const mockOutput = { write: (text: string) => outputs.push(text), isTTY: false }
    const mockTurnRunner = async () => ({ provider: 'zhipu-coding' as const, model: 'glm-5.1', assistantContent: '' })

    await runChatCommand({
      flags: { session: String(session.id) },
      settings: { ...getTestSettings(), databasePath: dbPath },
      dbPath,
      readLine: createMockReadLine(['/model 2', '/exit']),
      output: mockOutput as any,
      turnRunner: mockTurnRunner as any,
    })

    const output = outputs.join('')
    expect(output).toContain('Switched to glm-5.1')

    // Verify session was updated
    const store2 = new SqliteSessionStore(dbPath)
    const updated = store2.getSession(session.id)
    store2.close()
    expect(updated?.model_hint).toBe('glm-5.1')

    cleanDb(dbPath)
  })

  it('switches model by name when /model <name> is entered', async () => {
    const dbPath = `/tmp/test-chat-${Date.now()}-3.sqlite`
    cleanDb(dbPath)

    const store = new SqliteSessionStore(dbPath)
    const session = store.createSession({
      title: 'test session',
      activeProvider: 'zhipu-coding',
      modelHint: 'glm-4.7',
    })
    store.close()

    const outputs: string[] = []
    const mockOutput = { write: (text: string) => outputs.push(text), isTTY: false }
    const mockTurnRunner = async () => ({ provider: 'zhipu-coding' as const, model: 'glm-5-turbo', assistantContent: '' })

    await runChatCommand({
      flags: { session: String(session.id) },
      settings: { ...getTestSettings(), databasePath: dbPath },
      dbPath,
      readLine: createMockReadLine(['/model glm-5-turbo', '/exit']),
      output: mockOutput as any,
      turnRunner: mockTurnRunner as any,
    })

    const output = outputs.join('')
    expect(output).toContain('Model hint set to glm-5-turbo')

    cleanDb(dbPath)
  })
})