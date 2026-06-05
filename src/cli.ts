#!/usr/bin/env bun
import { isAbsolute, join } from 'node:path'
import { runAgentTurn } from './agent/agent-loop.ts'
import { loadSettings } from './config/settings.ts'
import { createCliConfirmationHandler } from './cli/confirm.ts'
import { createMarkdownOutput } from './cli/markdown.ts'
import { runChatCommand } from './cli/chat.ts'
import {
  inferDefaultCommand,
  printHelp,
  runContextCommand,
  runDemoContextCommand,
  runInitCommand,
  runNewCommand,
  runSetupCommand,
  runSwitchCommand,
  type FlagMap,
} from './cli/commands.ts'
import { parseProviderName } from './providers/index.ts'
import { SqliteSessionStore } from './storage/sqlite-session-store.ts'

const rawCommand = process.argv[2]
const command = rawCommand && !rawCommand.startsWith('--') ? rawCommand : inferDefaultCommand()
const flags = parseFlags(process.argv.slice(command === rawCommand ? 3 : 2))
const settingsPath = typeof flags.settings === 'string' ? flags.settings : join(process.cwd(), 'settings.json')
const envPath = typeof flags.env === 'string' ? flags.env : join(process.cwd(), '.env')

if (command === 'help') {
  printHelp()
  process.exit(0)
}

const settings = loadSettings({
  settingsPath,
  envPath,
})

if (command === 'setup') {
  await runSetupCommand(flags, settingsPath, envPath)
  process.exit(0)
}

const dbPath =
  typeof flags.db === 'string'
    ? flags.db
    : resolveFromCwd(settings.databasePath)

if (command === 'init') {
  runInitCommand(dbPath)
  process.exit(0)
}

if (command === 'new') {
  runNewCommand(flags, settings, dbPath)
  process.exit(0)
}

if (command === 'chat') {
  await runChatCommand({
    flags,
    settings,
    dbPath,
  })
  process.exit(0)
}

if (command === 'demo-context') {
  runDemoContextCommand(flags, settings)
  process.exit(0)
}

if (command === 'context') {
  runContextCommand(flags, settings, dbPath)
  process.exit(0)
}

if (command === 'switch') {
  runSwitchCommand(flags, settings, dbPath)
  process.exit(0)
}

if (command === 'send') {
  const sessionId = Number(flags.session)
  if (!Number.isFinite(sessionId)) {
    throw new Error('Missing --session <id>')
  }
  if (typeof flags.prompt !== 'string' || flags.prompt.length === 0) {
    throw new Error('Missing --prompt <text>')
  }

  const store = new SqliteSessionStore(dbPath)
  try {
    await runAgentTurn({
      store,
      settings,
      sessionId,
      prompt: flags.prompt,
      provider: typeof flags.provider === 'string' ? parseProviderName(flags.provider) : undefined,
      model: typeof flags.model === 'string' ? flags.model : undefined,
      limit: Number(flags.limit ?? 10),
      maxTokens: Number(flags.maxTokens ?? 1024),
      toolExecutionContext: {
        confirm: createCliConfirmationHandler(),
      },
      output:
        flags.raw === true || flags.markdown === 'false'
          ? process.stdout
          : createMarkdownOutput(process.stdout, { colors: process.stdout.isTTY }),
    })
  } finally {
    store.close()
  }

  process.exit(0)
}

printHelp()

function parseFlags(args: string[]): FlagMap {
  const result: FlagMap = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg?.startsWith('--')) {
      continue
    }
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next && !next.startsWith('--')) {
      result[key] = next
      i += 1
    } else {
      result[key] = true
    }
  }
  return result
}

function resolveFromCwd(path: string): string {
  return isAbsolute(path) ? path : join(process.cwd(), path)
}
