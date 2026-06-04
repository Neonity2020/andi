# Endless-Stream Coding Agent Design

Version: `v0.1`
Status: Draft
Date: `2026-06-04`

## 1. Goal

Build a lightweight coding-agent control plane that lets a developer switch between multiple LLM providers without losing conversational context or workflow momentum.

The first product wedge is not "another agent". It is:

- Unified provider routing
- Persistent conversation memory
- Mid-conversation handoff between providers
- Minimal configuration overhead

The MVP should let a user start a conversation with OpenAI, switch to Anthropic mid-stream, and continue with the last relevant context preserved.

## 2. Product Principles

1. Keep the first release narrow.
2. Optimize for "do not interrupt the flow".
3. Prefer local-first persistence unless a cloud feature is clearly needed.
4. Preserve user control over routing decisions.
5. Make every subsystem independently replaceable.

## 3. MVP Scope

### In scope

- OpenAI and Anthropic providers
- A single routing layer
- SQLite-backed session persistence
- Rolling message window
- Lightweight rolling summary
- Manual provider switching
- Basic retry and provider error surfacing

### Out of scope for MVP

- Team collaboration
- Multi-tenant workspace auth
- Plugin marketplace
- Postgres / distributed infra
- Autonomous model routing based on complex heuristics
- Browser automation
- Tool ecosystem beyond the minimum agent loop

## 4. System Shape

The product should be implemented as a small control plane with three layers:

1. `Client`
   - CLI or desktop shell for issuing prompts and switching providers
2. `Agent Core`
   - Owns sessions, memory, summaries, and provider selection
3. `Provider Adapters`
   - Normalize OpenAI / Anthropic request and response formats

The first version should avoid unnecessary service boundaries. A single Node process is enough.

## 5. Main Data Flow

1. User sends a prompt into an active session.
2. The core loads:
   - recent messages
   - rolling summary
   - active provider configuration
3. The core builds a provider-specific request payload.
4. The provider streams tokens back to the core.
5. The core forwards tokens to the client immediately.
6. The core persists:
   - the raw user message
   - assistant response
   - updated summary if needed
   - provider metadata
7. If the user switches provider mid-conversation, the next request reuses the same session memory.

## 6. Core Modules

### 6.1 Session Manager

Responsibilities:

- Create and load sessions
- Track session state
- Store provider choice per turn
- Maintain message history window

### 6.2 Memory Manager

Responsibilities:

- Keep the last `N` messages
- Maintain a rolling summary of older context
- Produce a compact prompt context for the next provider call

Recommended strategy:

- Store all messages in SQLite
- Feed only the last `10` turns plus summary into the next request
- Refresh the summary when the history grows beyond the window

### 6.3 Router

Responsibilities:

- Select provider
- Validate provider availability
- Apply optional routing rules
- Surface fallback decisions explicitly to the user

Initial routing policy:

- Default to explicit user choice
- Allow a simple rule engine later
- Fail closed when a provider is unavailable unless the user asks for fallback

### 6.4 Provider Adapter Interface

Each adapter should normalize three things:

- message input format
- streaming output format
- error shape

Required adapter methods:

- `sendMessage(sessionContext, prompt, options)`
- `streamMessage(...)`
- `healthCheck()`
- `estimateCost(...)` or placeholder equivalent

### 6.5 Persistence Layer

Use SQLite for MVP because it is simple, local, durable, and sufficient for a single-user control plane.

Minimum tables:

- `sessions`
- `messages`
- `summaries`
- `provider_configs`
- `routing_events`

## 7. SQLite Schema Sketch

### `sessions`

- `id`
- `title`
- `created_at`
- `updated_at`
- `active_provider`
- `model_hint`

### `messages`

- `id`
- `session_id`
- `role`
- `provider`
- `model`
- `content`
- `created_at`
- `token_count`
- `parent_message_id`

### `summaries`

- `id`
- `session_id`
- `summary_text`
- `summary_version`
- `updated_at`

### `provider_configs`

- `id`
- `provider`
- `name`
- `base_url`
- `api_key_ref`
- `enabled`

### `routing_events`

- `id`
- `session_id`
- `from_provider`
- `to_provider`
- `reason`
- `created_at`

## 8. Context Continuity Strategy

The main engineering problem is not raw chat forwarding. It is continuity across model switches.

Recommended approach:

1. Always store the full conversation.
2. Build each provider request from:
   - the rolling summary
   - the latest `N` messages
   - the current user message
3. If the user switches provider, preserve the same session and regenerate the request bundle for the new provider.

This avoids fragile model-specific state transfer.

## 8.1 Context Injection Guardrails

The prompt builder must not blindly inject large LLM-generated code blocks into the next turn.

Rules:

- Preserve the raw transcript in storage.
- Truncate assistant- and tool-generated code aggressively before prompt injection.
- Prefer line-oriented head/tail preservation over semantic rewriting in the hot path.
- Keep truncation explicit with a marker so the model knows the omitted material exists.
- Never spend the active context window on full generated code unless the user explicitly needs it.

This is the same overall direction used by Claude Code's compaction and session-memory paths: store everything, inject only the bounded slice that matters.

## 9. Provider Switching Behavior

Switching providers should be a session-level decision, not a conversation reset.

When a switch occurs:

- keep the same session id
- keep the same memory store
- record a routing event
- regenerate the provider-specific payload
- continue streaming from the new provider

This ensures the user experiences a seamless handoff instead of a new chat.

## 10. Failure Modes

We should handle failures explicitly and visibly:

- Provider timeout
- Provider auth failure
- Rate limit / quota exhaustion
- Context window overflow
- Streaming interruption

Default behavior:

- preserve the partial transcript
- store the failure event
- show a recoverable retry path

Important: failures must not corrupt the session state.

## 11. Non-Goals for the First Cut

Do not introduce these too early:

- multi-agent planning
- autonomous tool execution
- plugin SDK
- distributed locking
- cloud sync
- collaborative editing

Those may become part of the long-term platform, but they are not needed to validate the wedge.

## 12. Implementation Plan

### Phase 1: Working Skeleton

- Create repo structure
- Add provider adapter interfaces
- Add SQLite persistence
- Add a minimal session command surface

### Phase 2: Continuous Context

- Persist messages
- Generate rolling summaries
- Rehydrate context on each turn
- Keep the last 10 messages in the active prompt bundle

### Phase 3: Provider Handoff

- Add explicit provider switching
- Verify mid-conversation continuity
- Measure whether user-reported context loss is near zero for normal usage

### Phase 4: Productizing the Control Plane

- Add config UX
- Add routing rules
- Add observability
- Add a distribution surface such as CLI, desktop app, or editor integration

## 13. Engineering Quality Bar

We should treat the first implementation as infrastructure, not a demo.

Quality requirements:

- Clear module boundaries
- Testable adapter contracts
- Deterministic persistence
- No hidden state in the client
- Observability for routing and provider failures
- Straightforward migration path if we later split services

## 14. What We Need to Decide Next

To move from design into execution, we should align on these in order:

1. Primary surface: CLI first, desktop app first, or editor plugin first
2. Repo structure: single package or small monorepo
3. Session identity: local-only or cloud-synced
4. Summary strategy: rule-based summary refresh or LLM-generated summary
5. Routing policy: manual only for v0, or manual plus a tiny rules engine

## 15. Current Recommendation

For the first implementation, I recommend:

- `CLI first`
- `single Node app`
- `local SQLite`
- `manual provider switching`
- `simple rolling summary`

That combination is the fastest path to validating the core promise: continuous context across provider changes.
