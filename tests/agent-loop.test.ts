import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgentTurn } from '../src/agent/agent-loop.ts'
import { loadSettings } from '../src/config/settings.ts'
import type { ProviderClient } from '../src/providers/types.ts'
import { SqliteSessionStore } from '../src/storage/sqlite-session-store.ts'
import { createToolRegistry } from '../src/tools/registry.ts'

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

  test('executes tool calls and feeds tool results into a follow-up provider turn', async () => {
    const { store } = createStore()
    const settings = loadSettings({ env: { OPENAI_API_KEY: 'test-openai-key' } })
    const session = store.createSession({
      title: 'tool test',
      activeProvider: 'openai',
      modelHint: 'gpt-4.1',
    })
    const seenMessageRoles: string[][] = []
    const toolRegistry = createToolRegistry([
      {
        name: 'read_file',
        description: 'read a file',
        inputSchema: { type: 'object' },
        async execute(input) {
          expect(input).toEqual({ path: 'README.md' })
          return 'README contents'
        },
      },
    ])

    const client: ProviderClient = {
      name: 'openai',
      defaultModel: 'gpt-4.1',
      async *stream(input) {
        seenMessageRoles.push(input.messages.map(message => String(message.role)))
        expect(input.systemPrompt).toContain('coding agent')
        expect(input.tools?.[0]?.function.name).toBe('read_file')

        if (seenMessageRoles.length === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'call_1',
              name: 'read_file',
              input: { path: 'README.md' },
            },
          }
          yield { type: 'done' }
          return
        }

        expect(input.messages.some(message => message.role === 'tool')).toBe(true)
        yield { type: 'token', text: 'I read it.' }
        yield { type: 'done' }
      },
    }

    const result = await runAgentTurn({
      store,
      settings,
      sessionId: session.id,
      prompt: 'read README',
      createClient: () => client,
      toolRegistry,
    })

    const messages = store.listRecentMessages(session.id, 10)
    expect(result.assistantContent).toBe('I read it.')
    expect(result.toolResults).toHaveLength(1)
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(messages[1]?.metadata).toEqual({
      toolCalls: [
        {
          id: 'call_1',
          name: 'read_file',
          input: { path: 'README.md' },
          arguments: '{"path":"README.md"}',
        },
      ],
    })
    expect(messages[2]?.metadata).toEqual({
      toolCallId: 'call_1',
      toolName: 'read_file',
      isError: false,
    })
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
