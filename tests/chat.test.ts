import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runChatCommand } from '../src/cli/chat.ts'
import { loadSettings } from '../src/config/settings.ts'
import { SqliteSessionStore } from '../src/storage/sqlite-session-store.ts'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('chat command', () => {
  test('keeps a continuous session across multiple prompts and provider switches', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-chat-'))
    tempDirs.push(dir)

    const settings = loadSettings({ cwd: dir, env: {} })
    const inputs = ['hello', '/provider anthropic glm-5.1', 'world', '/exit']
    const calls: Array<{ sessionId: number; prompt: string; provider: string; model: string }> = []
    let output = ''

    const result = await runChatCommand({
      flags: {},
      settings,
      dbPath: join(dir, 'agent.sqlite'),
      readLine: async () => inputs.shift() ?? null,
      output: {
        write(text: string) {
          output += text
        },
      },
      turnRunner: async ({ store, sessionId, prompt }) => {
        const session = store.getSession(sessionId)
        if (!session) {
          throw new Error(`Session ${sessionId} was not found`)
        }
        calls.push({
          sessionId,
          prompt,
          provider: session.active_provider,
          model: session.model_hint ?? '',
        })
        return {
          provider: session.active_provider as 'openai' | 'anthropic' | 'zhipu-coding',
          model: session.model_hint ?? '',
          assistantContent: 'ok',
        }
      },
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.prompt).toBe('hello')
    expect(calls[0]?.provider).toBe('openai')
    expect(calls[0]?.model).toBe('gpt-4.1')
    expect(calls[1]?.prompt).toBe('world')
    expect(calls[1]?.provider).toBe('anthropic')
    expect(calls[1]?.model).toBe('glm-5.1')
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('glm-5.1')
    expect(output).toContain('Started session #')
    expect(output).toContain('Switched to anthropic / glm-5.1')
  })

  test('restores the most recent session when no session is specified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-chat-restore-'))
    tempDirs.push(dir)

    const settings = loadSettings({ cwd: dir, env: {} })
    const store = new SqliteSessionStore(join(dir, 'agent.sqlite'))
    const first = store.createSession({
      title: 'older session',
      activeProvider: 'openai',
      modelHint: 'gpt-4.1',
    })
    const latest = store.createSession({
      title: 'latest session',
      activeProvider: 'anthropic',
      modelHint: 'glm-5.1',
    })
    store.appendMessage(latest.id, {
      role: 'user',
      provider: 'local',
      model: 'none',
      content: 'please check the last state',
    })
    store.appendMessage(latest.id, {
      role: 'assistant',
      provider: 'anthropic',
      model: 'glm-5.1',
      content: 'state looks good',
    })
    store.close()

    let output = ''
    const result = await runChatCommand({
      flags: {},
      settings,
      dbPath: join(dir, 'agent.sqlite'),
      readLine: async () => '/exit',
      output: {
        write(text: string) {
          output += text
        },
      },
    })

    expect(result.sessionId).toBe(latest.id)
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('glm-5.1')
    expect(output).toContain(`Restored session #${latest.id}`)
    expect(output).toContain('Title: latest session')
    expect(output).toContain('Updated: ')
    expect(output).toContain('Last active provider/model: anthropic / glm-5.1')
    expect(output).toContain('Recent user: please check the last state')
    expect(output).toContain('Recent assistant: state looks good')
    expect(output).toContain('Commands: /provider, /model, /new, /session, /help, /exit')
    expect(output).toContain('Type a prompt to continue.')
    expect(output).not.toContain(`Started session #${first.id}`)
  })
})
