import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDefaultToolRegistry, detectDangerousShellCommand } from '../src/tools/registry.ts'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe('default tool registry', () => {
  test('includes run_shell tool and captures stdout, stderr, and exit code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-tools-'))
    tempDirs.push(dir)
    const registry = createDefaultToolRegistry(dir)
    const tool = registry.get('run_shell')

    expect(tool).not.toBeNull()
    const output = await tool!.execute({
      command: 'printf hello && printf "warn" >&2',
      timeoutMs: 5_000,
    })

    expect(output).toContain('exit_code: 0')
    expect(output).toContain('stdout:\nhello')
    expect(output).toContain('stderr:\nwarn')
  })

  test('rejects shell cwd outside workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-tools-'))
    tempDirs.push(dir)
    const registry = createDefaultToolRegistry(dir)
    const tool = registry.get('run_shell')

    await expect(
      tool!.execute({
        command: 'pwd',
        cwd: '..',
      }),
    ).rejects.toThrow('Path escapes workspace')
  })

  test('detects dangerous shell commands', () => {
    expect(detectDangerousShellCommand('rm -rf dist')).toBe('recursive or forced removal')
    expect(detectDangerousShellCommand('git reset --hard HEAD')).toBe('hard git reset')
    expect(detectDangerousShellCommand('bun install')).toBe('dependency mutation')
    expect(detectDangerousShellCommand('rg "hello" src')).toBeNull()
  })

  test('requires confirmation for dangerous shell commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-tools-'))
    tempDirs.push(dir)
    const registry = createDefaultToolRegistry(dir)
    const tool = registry.get('run_shell')
    const confirmations: string[] = []

    await expect(
      tool!.execute(
        {
          command: 'rm -rf dist',
          timeoutMs: 5_000,
        },
        {
          confirm: async request => {
            confirmations.push(request.reason)
            return false
          },
        },
      ),
    ).rejects.toThrow('Dangerous shell command denied')

    expect(confirmations).toEqual(['recursive or forced removal'])
  })

  test('runs dangerous shell command after explicit confirmation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'andi-agent-tools-'))
    tempDirs.push(dir)
    const registry = createDefaultToolRegistry(dir)
    const tool = registry.get('run_shell')

    const output = await tool!.execute(
      {
        command: 'bun install --help',
        timeoutMs: 5_000,
      },
      {
        confirm: async () => true,
      },
    )

    expect(output).toContain('exit_code: 0')
  })
})
