import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import type { ProviderTool } from '../providers/types.ts'
import type { ToolDefinition, ToolExecutionContext, ToolRegistry } from './types.ts'

export function createDefaultToolRegistry(cwd = process.cwd()): ToolRegistry {
  return createToolRegistry([
    createListFilesTool(cwd),
    createReadFileTool(cwd),
    createWriteFileTool(cwd),
    createRunShellTool(cwd),
  ])
}

export function createToolRegistry(tools: ToolDefinition[]): ToolRegistry {
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  return {
    list: () => [...byName.values()],
    get: name => byName.get(name) ?? null,
  }
}

export function providerToolsFromRegistry(registry: ToolRegistry): ProviderTool[] {
  return registry.list().map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }))
}

function createListFilesTool(cwd: string): ToolDefinition {
  return {
    name: 'list_files',
    description: 'List files under a workspace-relative directory.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory path.' },
        maxEntries: { type: 'number', description: 'Maximum entries to return.' },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = objectInput(input)
      const root = resolveWorkspacePath(cwd, stringArg(args.path, '.'))
      const maxEntries = numberArg(args.maxEntries, 80)
      const entries: string[] = []
      walk(root, cwd, entries, maxEntries)
      return entries.length > 0 ? entries.join('\n') : '(empty)'
    },
  }
}

function createReadFileTool(cwd: string): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        startLine: { type: 'number', description: 'Optional 1-based first line.' },
        endLine: { type: 'number', description: 'Optional 1-based last line.' },
        maxChars: { type: 'number', description: 'Maximum characters to return.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(input) {
      const args = objectInput(input)
      const path = resolveWorkspacePath(cwd, requiredStringArg(args.path, 'path'))
      if (!existsSync(path) || statSync(path).isDirectory()) {
        throw new Error(`File not found: ${relative(cwd, path)}`)
      }
      const lines = readFileSync(path, 'utf8').split(/\r?\n/)
      const start = Math.max(1, numberArg(args.startLine, 1))
      const end = Math.min(lines.length, numberArg(args.endLine, lines.length))
      const content = lines.slice(start - 1, end).join('\n')
      return truncate(content, numberArg(args.maxChars, 20_000))
    },
  }
}

function createWriteFileTool(cwd: string): ToolDefinition {
  return {
    name: 'write_file',
    description: 'Create or replace a UTF-8 text file inside the workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative file path.' },
        content: { type: 'string', description: 'Complete file contents.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async execute(input) {
      const args = objectInput(input)
      const path = resolveWorkspacePath(cwd, requiredStringArg(args.path, 'path'))
      const content = requiredStringArg(args.content, 'content')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
      return `Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${relative(cwd, path)}`
    },
  }
}

function createRunShellTool(cwd: string): ToolDefinition {
  return {
    name: 'run_shell',
    description:
      'Run a shell command in the workspace. Use for build, test, search, git status, inspection, and one-off scripts for external data queries.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute.' },
        cwd: { type: 'string', description: 'Optional workspace-relative working directory.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 30000.' },
        maxChars: { type: 'number', description: 'Maximum output characters to return. Defaults to 20000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = objectInput(input)
      const command = requiredStringArg(args.command, 'command')
      const workingDirectory = resolveWorkspacePath(cwd, stringArg(args.cwd, '.'))
      if (!existsSync(workingDirectory) || !statSync(workingDirectory).isDirectory()) {
        throw new Error(`Working directory not found: ${relative(cwd, workingDirectory)}`)
      }
      await confirmDangerousShellCommand(command, relative(cwd, workingDirectory) || '.', context)
      const timeoutMs = Math.max(1_000, numberArg(args.timeoutMs, 30_000))
      const maxChars = Math.max(1_000, numberArg(args.maxChars, 20_000))
      return runShellCommand(command, workingDirectory, timeoutMs, maxChars)
    },
  }
}

async function confirmDangerousShellCommand(
  command: string,
  cwd: string,
  context?: ToolExecutionContext,
): Promise<void> {
  const reason = detectDangerousShellCommand(command)
  if (!reason) {
    return
  }

  const confirmed = await context?.confirm?.({
    toolName: 'run_shell',
    command,
    cwd,
    reason,
  })

  if (!confirmed) {
    throw new Error(`Dangerous shell command denied: ${reason}`)
  }
}

export function detectDangerousShellCommand(command: string): string | null {
  const normalized = command.toLowerCase()
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+.*(-r|-f|--recursive|--force)/, 'recursive or forced removal'],
    [/\bgit\s+reset\s+--hard\b/, 'hard git reset'],
    [/\bgit\s+clean\s+.*(-f|-d)/, 'forced git clean'],
    [/\bgit\s+push\b.*(--force|-f)\b/, 'forced git push'],
    [/\bsudo\b/, 'sudo command'],
    [/\bchmod\s+.*\b(777|a\+w)\b/, 'broad permission change'],
    [/\bchown\b/, 'ownership change'],
    [/\bmv\s+.*\s+\/(usr|bin|etc|var|lib|system|private)\b/, 'move into system path'],
    [/\b(curl|wget)\b.*\|\s*(sh|bash)\b/, 'remote script execution'],
    [/\b(npm|pnpm|yarn|bun)\s+(install|add|remove)\b/, 'dependency mutation'],
    [/\bbrew\s+(install|uninstall|remove|upgrade)\b/, 'system package mutation'],
  ]

  for (const [pattern, reason] of checks) {
    if (pattern.test(normalized)) {
      return reason
    }
  }
  return null
}

async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxChars: number,
): Promise<string> {
  const proc = Bun.spawn(['/bin/sh', '-lc', command], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const timeout = setTimeout(() => {
    proc.kill()
  }, timeoutMs)

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output = [
      `exit_code: ${exitCode}`,
      stdout ? `stdout:\n${stdout.trimEnd()}` : '',
      stderr ? `stderr:\n${stderr.trimEnd()}` : '',
    ]
      .filter(Boolean)
      .join('\n')
    return truncate(output || `exit_code: ${exitCode}`, maxChars)
  } finally {
    clearTimeout(timeout)
  }
}

function walk(root: string, cwd: string, entries: string[], maxEntries: number): void {
  if (entries.length >= maxEntries || !existsSync(root)) {
    return
  }

  const stat = statSync(root)
  if (!stat.isDirectory()) {
    entries.push(relative(cwd, root))
    return
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entries.length >= maxEntries || entry.name === '.git' || entry.name === 'node_modules') {
      continue
    }
    const path = resolve(root, entry.name)
    entries.push(`${relative(cwd, path)}${entry.isDirectory() ? '/' : ''}`)
    if (entry.isDirectory()) {
      walk(path, cwd, entries, maxEntries)
    }
  }
}

function resolveWorkspacePath(cwd: string, path: string): string {
  const resolved = resolve(cwd, path)
  const relativePath = relative(cwd, resolved)
  if (relativePath.startsWith('..')) {
    throw new Error(`Path escapes workspace: ${path}`)
  }
  return resolved
}

function objectInput(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }
  return input as Record<string, unknown>
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function requiredStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing ${name}`)
  }
  return value
}

function numberArg(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function truncate(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content
  }
  return `${content.slice(0, maxChars)}\n[truncated ${content.length - maxChars} chars]`
}
