import { describe, expect, test } from 'bun:test'
import { CODING_AGENT_SYSTEM_PROMPT } from '../src/agent/system-prompt.ts'
import { createDefaultToolRegistry } from '../src/tools/registry.ts'

describe('coding agent system prompt', () => {
  test('guides one-off real-time queries through shell scripts', () => {
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('real-time external queries')
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('weather')
    expect(CODING_AGENT_SYSTEM_PROMPT).toContain('Beijing')
  })

  test('describes run_shell as useful for external data query scripts', () => {
    const runShell = createDefaultToolRegistry().get('run_shell')

    expect(runShell?.description).toContain('one-off scripts')
    expect(runShell?.description).toContain('external data queries')
  })
})
