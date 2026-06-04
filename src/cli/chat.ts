import { createInterface } from 'node:readline/promises'
import { getDefaultModel, getProviderSettings, type AppSettings } from '../config/settings.ts'
import { runAgentTurn } from '../agent/agent-loop.ts'
import { SqliteSessionStore } from '../storage/sqlite-session-store.ts'
import { parseProviderName } from '../providers/index.ts'
import type { ProviderName } from '../providers/types.ts'
import type { FlagMap } from './commands.ts'

export type ChatRunInput = {
  flags: FlagMap
  settings: AppSettings
  dbPath: string
  readLine?: (prompt: string) => Promise<string | null>
  output?: Pick<NodeJS.WriteStream, 'write'>
  turnRunner?: typeof runAgentTurn
}

export type ChatRunResult = {
  sessionId: number
  provider: ProviderName
  model: string
}

export async function runChatCommand({
  flags,
  settings,
  dbPath,
  readLine,
  output = process.stdout,
  turnRunner = runAgentTurn,
}: ChatRunInput): Promise<ChatRunResult> {
  if (!readLine && !process.stdin.isTTY) {
    throw new Error('Interactive chat requires a TTY')
  }

  const store = new SqliteSessionStore(dbPath)
  const rl = readLine ? null : createInterface({ input: process.stdin, output: process.stdout })
  const ask = readLine ?? (async (prompt: string) => rl?.question(prompt) ?? null)

  try {
    const initialProvider = parseProviderName(flags.provider, settings.defaultProvider)
    const initialModel =
      typeof flags.model === 'string'
        ? flags.model
        : getDefaultModel(getProviderSettings(settings, initialProvider))
    const { session, status } = resolveInitialSession(store, flags, initialProvider, initialModel)

    let sessionId = session.id
    let activeProvider = parseProviderName(session.active_provider, initialProvider)
    let activeModel = session.model_hint ?? initialModel

    const startupOverride = applyStartupOverrides({
      store,
      sessionId,
      settings,
      flags,
      activeProvider,
      activeModel,
    })
    sessionId = startupOverride.sessionId
    activeProvider = startupOverride.activeProvider
    activeModel = startupOverride.activeModel
    const banner = buildChatBanner({
      status,
      sessionId,
      session: store.getSession(sessionId),
      activeProvider,
      activeModel,
      recentMessages: store.getSessionBundle(sessionId, Number(flags.limit ?? 10)).messages,
    })
    output.write(`${banner.join('\n')}\n`)

    while (true) {
      const line = await ask('> ')
      if (line == null) {
        break
      }

      const input = line.trim()
      if (!input) {
        continue
      }

      if (isExitCommand(input)) {
        break
      }

      if (input.startsWith('/help')) {
        output.write(
          `Commands: /provider <name> [model], /model <name>, /new [title], /session, /exit\n`,
        )
        continue
      }

      if (input.startsWith('/session')) {
        output.write(`${JSON.stringify({ session: store.getSession(sessionId) }, null, 2)}\n`)
        continue
      }

      if (input.startsWith('/provider ')) {
        const next = input.slice('/provider '.length).trim()
        const [providerName, ...modelParts] = next.split(/\s+/)
        const nextProvider = parseProviderName(providerName, activeProvider)
        const providerSettings = getProviderSettings(settings, nextProvider)
        const nextModel =
          modelParts.length > 0 ? modelParts.join(' ') : getDefaultModel(providerSettings)
        const updated = store.updateSession(sessionId, {
          activeProvider: nextProvider,
          modelHint: nextModel,
        })
        if (!updated) {
          throw new Error(`Session ${sessionId} was not found`)
        }
        if (nextProvider !== activeProvider) {
          store.recordRoutingEvent({
            sessionId,
            fromProvider: activeProvider,
            toProvider: nextProvider,
            reason: 'interactive switch',
          })
        }
        activeProvider = nextProvider
        activeModel = nextModel
        output.write(`Switched to ${activeProvider} / ${activeModel}\n`)
        continue
      }

      if (input.startsWith('/model ')) {
        const nextModel = input.slice('/model '.length).trim()
        if (!nextModel) {
          throw new Error('Missing model name')
        }
        const updated = store.updateSession(sessionId, { modelHint: nextModel })
        if (!updated) {
          throw new Error(`Session ${sessionId} was not found`)
        }
        activeModel = nextModel
        output.write(`Model hint set to ${activeModel}\n`)
        continue
      }

      if (input.startsWith('/new')) {
        const title = input.slice('/new'.length).trim() || 'Interactive session'
        const newSession = store.createSession({
          title,
          activeProvider,
          modelHint: activeModel,
        })
        sessionId = newSession.id
        output.write(`Created session #${sessionId}: ${title}\n`)
        continue
      }

      const result = await turnRunner({
        store,
        settings,
        sessionId,
        prompt: input,
        output,
        limit: Number(flags.limit ?? 10),
        maxTokens: Number(flags.maxTokens ?? 1024),
      })

      activeProvider = result.provider
      activeModel = result.model
    }

    const current = store.getSession(sessionId)
    if (!current) {
      throw new Error(`Session ${sessionId} was not found`)
    }

    return {
      sessionId: current.id,
      provider: parseProviderName(current.active_provider, activeProvider),
      model: current.model_hint ?? activeModel,
    }
  } finally {
    rl?.close()
    store.close()
  }
}

function resolveInitialSession(
  store: SqliteSessionStore,
  flags: FlagMap,
  initialProvider: ProviderName,
  initialModel: string,
) {
  if (typeof flags.session !== 'string') {
    const latestSession = store.listSessions()[0]
    if (latestSession) {
      return {
        session: latestSession,
        status: 'restored' as const,
      }
    }

    return {
      session: store.createSession({
        title:
          typeof flags.title === 'string' && flags.title.length > 0
            ? flags.title
            : 'Interactive session',
        activeProvider: initialProvider,
        modelHint: initialModel,
      }),
      status: 'started' as const,
    }
  }

  const sessionId = Number(flags.session)
  if (!Number.isFinite(sessionId)) {
    throw new Error('Missing --session <id>')
  }

  const session = store.getSession(sessionId)
  if (!session) {
    throw new Error(`Session ${sessionId} was not found`)
  }
  return {
    session,
    status: 'opened' as const,
  }
}

function isExitCommand(input: string): boolean {
  return input === '/exit' || input === 'exit' || input === '/quit' || input === 'quit'
}

function applyStartupOverrides({
  store,
  sessionId,
  settings,
  flags,
  activeProvider,
  activeModel,
}: {
  store: SqliteSessionStore
  sessionId: number
  settings: AppSettings
  flags: FlagMap
  activeProvider: ProviderName
  activeModel: string
}): {
  sessionId: number
  activeProvider: ProviderName
  activeModel: string
} {
  const nextProvider = typeof flags.provider === 'string' ? parseProviderName(flags.provider, activeProvider) : activeProvider
  const nextModel =
    typeof flags.model === 'string'
      ? flags.model
      : activeModel

  if (nextProvider !== activeProvider || nextModel !== activeModel) {
    const providerSettings = getProviderSettings(settings, nextProvider)
    const resolvedModel = typeof flags.model === 'string' ? nextModel : getDefaultModel(providerSettings)
    const updated = store.updateSession(sessionId, {
      activeProvider: nextProvider,
      modelHint: resolvedModel,
    })
    if (!updated) {
      throw new Error(`Session ${sessionId} was not found`)
    }
    if (nextProvider !== activeProvider) {
      store.recordRoutingEvent({
        sessionId,
        fromProvider: activeProvider,
        toProvider: nextProvider,
        reason: 'startup override',
      })
    }
    return {
      sessionId,
      activeProvider: nextProvider,
      activeModel: resolvedModel,
    }
  }

  return {
    sessionId,
    activeProvider,
    activeModel,
  }
}

function buildChatBanner({
  status,
  sessionId,
  session,
  activeProvider,
  activeModel,
  recentMessages,
}: {
  status: 'restored' | 'started' | 'opened'
  sessionId: number
  session: { title: string; updated_at: string; active_provider: string; model_hint: string | null } | null
  activeProvider: ProviderName
  activeModel: string
  recentMessages: Array<{ role?: string; content?: string }>
}): string[] {
  const statusLabel = status === 'restored' ? 'Restored' : status === 'opened' ? 'Opened' : 'Started'
  const lines = [`${statusLabel} session #${sessionId} (${activeProvider} / ${activeModel})`]

  if (session) {
    lines.push(`Title: ${session.title}`)
    lines.push(`Updated: ${session.updated_at}`)
  }

  if (status === 'restored' && session) {
    lines.push(`Last active provider/model: ${session.active_provider} / ${session.model_hint ?? 'unset'}`)
  }

  const summaryLines = summarizeRecentMessages(recentMessages)
  lines.push(...summaryLines)
  lines.push('Commands: /provider, /model, /new, /session, /help, /exit')
  lines.push('Type a prompt to continue.')
  return lines
}

function summarizeRecentMessages(messages: Array<{ role?: string; content?: string }>): string[] {
  const lastUser = findLastMessage(messages, 'user')
  const lastAssistant = findLastMessage(messages, 'assistant')

  if (!lastUser && !lastAssistant) {
    return ['Recent messages: none yet.']
  }

  const lines: string[] = []
  if (lastUser) {
    lines.push(`Recent user: ${summarizeText(lastUser.content ?? '')}`)
  }
  if (lastAssistant) {
    lines.push(`Recent assistant: ${summarizeText(lastAssistant.content ?? '')}`)
  }
  return lines
}

function findLastMessage(messages: Array<{ role?: string; content?: string }>, role: string) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.role === role) {
      return message
    }
  }
  return null
}

function summarizeText(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 120) {
    return normalized || 'empty'
  }
  return `${normalized.slice(0, 117)}...`
}
