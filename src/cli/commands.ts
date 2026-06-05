import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import {
  getOnboardingProviderChoices,
  renderEnvFile,
  renderSettingsJson,
  type OnboardingSelection,
} from '../config/onboarding.ts'
import { getDefaultModel, getProviderSettings, type AppSettings } from '../config/settings.ts'
import { buildProviderRequest } from '../context/request-bundler.ts'
import { SqliteSessionStore } from '../storage/sqlite-session-store.ts'
import { parseProviderName } from '../providers/index.ts'
import type { ProviderName } from '../providers/types.ts'

export type FlagMap = Record<string, string | boolean>

export function inferDefaultCommand(): string {
  if (!existsSync(join(process.cwd(), 'settings.json'))) {
    return 'setup'
  }
  return 'chat'
}

export async function runSetupCommand(
  flags: FlagMap,
  settingsPath: string,
  envPath: string,
): Promise<void> {
  const force = flags.force === true
  if (!force) {
    assertCanCreateFile(settingsPath, '--settings')
    assertCanCreateFile(envPath, '--env')
  }

  const selection = await resolveOnboardingSelection(flags)
  writeConfigFile(settingsPath, renderSettingsJson(selection))
  writeConfigFile(envPath, renderEnvFile(selection))

  console.log(`Created ${settingsPath}`)
  console.log(`Created ${envPath}`)
  console.log(`Default provider: ${selection.provider}`)
  console.log(`Default model: ${selection.model}`)
  console.log(`API key env: ${selection.apiKeyEnv}`)
}

export function runInitCommand(dbPath: string): void {
  const store = new SqliteSessionStore(dbPath)
  console.log(JSON.stringify({ ok: true, dbPath }, null, 2))
  store.close()
}

export function runNewCommand(
  flags: FlagMap,
  settings: AppSettings,
  dbPath: string,
): void {
  const provider = parseProviderName(flags.provider, settings.defaultProvider)
  const providerSettings = getProviderSettings(settings, provider)
  const store = new SqliteSessionStore(dbPath)
  const session = store.createSession({
    title: typeof flags.title === 'string' ? flags.title : 'Untitled session',
    activeProvider: provider,
    modelHint: typeof flags.model === 'string' ? flags.model : getDefaultModel(providerSettings),
  })
  console.log(JSON.stringify({ session }, null, 2))
  store.close()
}

export function runContextCommand(
  flags: FlagMap,
  settings: AppSettings,
  dbPath: string,
): void {
  const sessionId = Number(flags.session)
  if (!Number.isFinite(sessionId)) {
    throw new Error('Missing --session <id>')
  }

  const store = new SqliteSessionStore(dbPath)
  const bundle = store.getSessionBundle(sessionId, Number(flags.limit ?? 10))
  const provider = parseProviderName(flags.provider, settings.defaultProvider)
  const { request } = buildProviderRequest({
    provider,
    model:
      typeof flags.model === 'string'
        ? flags.model
        : bundle.session?.model_hint ?? getDefaultModel(getProviderSettings(settings, provider)),
    messages: bundle.messages,
    summary: bundle.summary?.summary_text ?? null,
  })

  console.log(JSON.stringify({ bundle, request }, null, 2))
  store.close()
}

export function runSwitchCommand(
  flags: FlagMap,
  settings: AppSettings,
  dbPath: string,
): void {
  const sessionId = Number(flags.session)
  if (!Number.isFinite(sessionId)) {
    throw new Error('Missing --session <id>')
  }
  const toProvider = parseProviderName(flags.provider, settings.defaultProvider)
  const store = new SqliteSessionStore(dbPath)
  const session = store.getSession(sessionId)
  if (!session) {
    store.close()
    throw new Error(`Session ${sessionId} was not found`)
  }
  const providerSettings = getProviderSettings(settings, toProvider)
  store.updateSession(sessionId, {
    activeProvider: toProvider,
    modelHint: typeof flags.model === 'string' ? flags.model : getDefaultModel(providerSettings),
  })
  store.recordRoutingEvent({
    sessionId,
    fromProvider: session.active_provider,
    toProvider,
    reason: typeof flags.reason === 'string' ? flags.reason : 'manual switch',
  })
  console.log(JSON.stringify({ session: store.getSession(sessionId) }, null, 2))
  store.close()
}

export function runDemoContextCommand(flags: FlagMap, settings: AppSettings): void {
  const demoDir = mkdtempSync(join(tmpdir(), 'andi-agent-demo-'))
  const demoDb = join(demoDir, 'agent.sqlite')
  const store = new SqliteSessionStore(demoDb)

  const session = store.createSession({
    title: 'demo session',
    activeProvider: 'openai',
    modelHint: 'gpt-4.1',
  })

  store.setSummary(
    session.id,
    'Current state: user asked for a refactor; keep the overall structure but avoid injecting huge generated code verbatim into context.',
  )

  store.appendMessage(session.id, {
    role: 'user',
    provider: 'local',
    model: 'none',
    content:
      'Please generate a parser and include the full source. Also show how you would wire it into the CLI.',
  })

  store.appendMessage(session.id, {
    role: 'assistant',
    provider: 'openai',
    model: 'gpt-4.1',
    content: buildLargeCodeSample(),
  })

  const bundle = store.getSessionBundle(session.id, 10)
  const { request } = buildProviderRequest({
    provider: parseProviderName(flags.provider, settings.defaultProvider),
    model:
      typeof flags.model === 'string'
        ? flags.model
        : getDefaultModel(getProviderSettings(settings, parseProviderName(flags.provider, settings.defaultProvider))),
    messages: bundle.messages,
    summary: bundle.summary?.summary_text ?? null,
  })

  console.log(JSON.stringify({ bundle, request }, null, 2))
  store.close()
  rmSync(demoDir, { recursive: true, force: true })
}

export function printHelp(): void {
  console.log(`Usage:
  bun run src/cli.ts [--provider openai|anthropic|zhipu-coding] [--model model] [--session <id>]
  bun run src/cli.ts chat [--provider openai|anthropic|zhipu-coding] [--model model] [--session <id>]
  bun run src/cli.ts setup [--settings path] [--env path] [--provider openai|anthropic|zhipu-coding] [--model model] [--force]
  bun run src/cli.ts init [--db path] [--settings path] [--env path]
  bun run src/cli.ts new [--db path] [--title text] [--provider openai|anthropic|zhipu-coding] [--model model]
  bun run src/cli.ts context --session <id> [--db path] [--provider openai|anthropic|zhipu-coding]
  bun run src/cli.ts switch --session <id> --provider openai|anthropic|zhipu-coding [--reason text]
  bun run src/cli.ts send --session <id> --prompt text [--provider openai|anthropic|zhipu-coding] [--model model] [--raw]
  bun run src/cli.ts demo-context [--provider openai|anthropic|zhipu-coding]

No subcommand defaults to interactive chat and restores the most recent session when available.
`)
}

async function resolveOnboardingSelection(flags: FlagMap): Promise<OnboardingSelection> {
  const choices = getOnboardingProviderChoices()
  const provider =
    typeof flags.provider === 'string'
      ? parseProviderName(flags.provider)
      : await promptProvider(choices.map(choice => choice.id))
  const providerSettings = choices.find(choice => choice.id === provider)?.settings
  if (!providerSettings) {
    throw new Error(`Unsupported provider: ${provider}`)
  }

  const model =
    typeof flags.model === 'string'
      ? flags.model
      : await promptModel(provider, providerSettings.models.map(modelConfig => modelConfig.id))

  return {
    provider,
    model,
    apiKeyEnv: typeof flags.apiKeyEnv === 'string' ? flags.apiKeyEnv : providerSettings.apiKeyEnv,
    apiKey: typeof flags.apiKey === 'string' ? flags.apiKey : '',
  }
}

async function promptProvider(providers: ProviderName[]): Promise<ProviderName> {
  const answer = await askChoice(
    'Choose a default provider',
    providers.map(provider => ({ value: provider, label: provider })),
  )
  return parseProviderName(answer)
}

async function promptModel(provider: ProviderName, models: string[]): Promise<string> {
  return askChoice(
    `Choose a default model for ${provider}`,
    models.map(model => ({ value: model, label: model })),
  )
}

async function askChoice(
  question: string,
  choices: Array<{ value: string; label: string }>,
): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`Missing non-interactive value for: ${question}`)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    console.log(question)
    choices.forEach((choice, index) => {
      console.log(`  ${index + 1}. ${choice.label}`)
    })
    const answer = (await rl.question(`Select 1-${choices.length}: `)).trim()
    const index = Number(answer) - 1
    const choice = choices[index]
    if (!choice) {
      throw new Error(`Invalid selection: ${answer}`)
    }
    return choice.value
  } finally {
    rl.close()
  }
}

function assertCanCreateFile(path: string, flagName: string): void {
  if (existsSync(path)) {
    throw new Error(`${path} already exists. Re-run setup with --force or choose another ${flagName} path.`)
  }
}

function writeConfigFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, { mode: 0o600 })
}

function buildLargeCodeSample(): string {
  const lines: string[] = []
  lines.push('Here is the full implementation:')
  lines.push('```ts')
  lines.push('export function exampleParser(input: string) {')
  lines.push('  const rows = input.split("\\n")')
  lines.push('  return rows.map((row, index) => ({ index, row }))')
  lines.push('}')
  for (let i = 0; i < 180; i += 1) {
    lines.push(`// generated line ${String(i + 1).padStart(3, '0')}`)
  }
  lines.push('export const done = true')
  lines.push('```')
  lines.push('Let me know if you want the CLI wiring next.')
  return lines.join('\n')
}
