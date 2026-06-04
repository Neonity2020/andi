import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SqliteSessionStore } from '../src/storage/sqlite-session-store.ts'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('sqlite session store', () => {
  test('persists sessions, messages, and summaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-store-'))
    tempDirs.push(dir)
    const dbPath = join(dir, 'agent.sqlite')
    const store = new SqliteSessionStore(dbPath)

    const session = store.createSession({
      title: 'test session',
      activeProvider: 'openai',
      modelHint: 'gpt-4.1',
    })

    store.appendMessage(session.id, {
      role: 'user',
      provider: 'local',
      model: 'none',
      content: 'hello world',
    })

    store.appendMessage(session.id, {
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-4.1',
      content: 'response',
    })

    store.setSummary(session.id, 'summary text', 2)
    store.recordRoutingEvent({
      sessionId: session.id,
      fromProvider: 'openai',
      toProvider: 'anthropic',
      reason: 'manual switch',
    })

    const bundle = store.getSessionBundle(session.id, 10)
    const sessions = store.listSessions()
    const messages = store.listRecentMessages(session.id, 10)

    expect(sessions).toHaveLength(1)
    expect(bundle.session?.title).toBe('test session')
    expect(bundle.summary?.summary_text).toBe('summary text')
    expect(messages).toHaveLength(2)
    expect(bundle.messages[1]?.content).toBe('response')

    const switched = store.updateSessionProvider(session.id, 'anthropic')
    expect(switched?.active_provider).toBe('anthropic')

    store.close()
  })
})
