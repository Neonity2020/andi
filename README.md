# andi

`andi` is a lightweight coding-agent control plane built with Bun and TypeScript.

## What it does

- Persistent sessions backed by SQLite
- Provider switching across OpenAI, Anthropic, and Zhipu Coding Plan
- Interactive chat with automatic session restore
- Terminal Markdown rendering for assistant responses
- Basic tool-use loop for coding tasks
- Shell execution tool for tests, builds, search, and inspection
- Interactive confirmation before dangerous shell operations
- Context compaction to avoid injecting large generated code verbatim
- Settings-driven provider, base URL, API key, and model management

## Quick Start

```bash
bun install
bun run src/cli.ts
```

The default command opens interactive chat and restores the most recent session when available.

## Commands

- `bun run src/cli.ts` - interactive chat
- `bun run src/cli.ts setup` - generate `settings.json` and `.env`
- `bun run src/cli.ts new` - create a session
- `bun run src/cli.ts send` - send a single prompt to a session
- `bun run src/cli.ts context` - inspect the active request bundle

Assistant responses are rendered as terminal-friendly Markdown by default. Use `--raw` for unrendered model output.

## Configuration

- `settings.example.json` shows the provider and model layout
- `.env.example` shows required API key variables
- Real `settings.json` and `.env` stay local and are ignored by git

## Roadmap

### Now

- Continuous interactive chat with automatic session restore
- Provider switching across OpenAI, Anthropic, and Zhipu Coding Plan
- Basic tool-use loop with file listing, reading, and writing
- Workspace-scoped shell execution with timeout and output truncation
- Confirmation gate for dangerous shell commands
- SQLite-backed session persistence and rolling context compaction

### Next

- `/sessions` command for browsing and resuming recent sessions
- Better session banner with richer recent-message summaries
- Richer coding tools and safer edit workflows

### Later

- Optional provider routing rules
- Smarter summary refresh strategy
- Editor and desktop surfaces on top of the same agent core
