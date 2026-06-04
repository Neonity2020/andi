export type ContextRole = 'system' | 'user' | 'assistant' | 'tool'

export type ContextMessage = {
  role?: ContextRole | string
  content?: string
  contextTruncated?: boolean
  [key: string]: unknown
}

export type ContextLimitOverrides = Partial<{
  maxMessages: number
  maxCharsPerMessage: number
  maxLinesPerMessage: number
  maxCharsPerAssistantMessage: number
  maxCharsPerUserMessage: number
  maxAssistantChars: number
  maxUserChars: number
  maxCodeFenceLines: number
  codeFenceHeadLines: number
  codeFenceTailLines: number
  plainHeadLines: number
  plainTailLines: number
}>

export type ContextBundle = {
  messages: ContextMessage[]
  droppedMessages: number
}

type ContextLimitConfig = {
  maxMessages: number
  maxCharsPerMessage: number
  maxLinesPerMessage: number
  maxCharsPerAssistantMessage: number
  maxCharsPerUserMessage: number
  maxCodeFenceLines: number
  codeFenceHeadLines: number
  codeFenceTailLines: number
  plainHeadLines: number
  plainTailLines: number
}

type Segment = {
  type: 'text' | 'code'
  lines: string[]
}

const DEFAULT_CONTEXT_LIMITS: ContextLimitConfig = {
  maxMessages: 10,
  maxCharsPerMessage: 12_000,
  maxLinesPerMessage: 220,
  maxCharsPerAssistantMessage: 9_000,
  maxCharsPerUserMessage: 16_000,
  maxCodeFenceLines: 80,
  codeFenceHeadLines: 12,
  codeFenceTailLines: 12,
  plainHeadLines: 80,
  plainTailLines: 24,
}

export function compactConversationForContext(
  messages: ContextMessage[],
  limits: ContextLimitOverrides = {},
): ContextBundle {
  const config = mergeLimitConfig(limits)
  const windowed = messages.slice(-config.maxMessages)
  const compacted = windowed.map(message => compactMessageForContext(message, config))

  return {
    messages: compacted,
    droppedMessages: Math.max(0, messages.length - windowed.length),
  }
}

export function compactMessageForContext(
  message: ContextMessage,
  limits: ContextLimitOverrides = DEFAULT_CONTEXT_LIMITS,
): ContextMessage {
  if (!message || typeof message !== 'object') {
    return message
  }

  if (typeof message.content !== 'string') {
    return message
  }

  const role = message.role ?? 'assistant'
  const content = message.content
  const charLimit =
    role === 'assistant' || role === 'tool'
      ? pickFirstDefined(
          limits.maxCharsPerAssistantMessage,
          limits.maxAssistantChars,
          DEFAULT_CONTEXT_LIMITS.maxCharsPerAssistantMessage,
        )
      : pickFirstDefined(
          limits.maxCharsPerUserMessage,
          limits.maxUserChars,
          DEFAULT_CONTEXT_LIMITS.maxCharsPerUserMessage,
        )

  const compacted = compactTextForContext(content, {
    charLimit,
    lineLimit: limits.maxLinesPerMessage,
    maxCodeFenceLines: limits.maxCodeFenceLines,
    codeFenceHeadLines: limits.codeFenceHeadLines,
    codeFenceTailLines: limits.codeFenceTailLines,
    plainHeadLines: limits.plainHeadLines,
    plainTailLines: limits.plainTailLines,
  })

  if (compacted === content) {
    return message
  }

  return {
    ...message,
    content: compacted,
    contextTruncated: true,
  }
}

export function compactTextForContext(
  text: string,
  options: Partial<{
    charLimit: number
    lineLimit: number
    maxCodeFenceLines: number
    codeFenceHeadLines: number
    codeFenceTailLines: number
    plainHeadLines: number
    plainTailLines: number
  }> = {},
): string {
  const config = {
    charLimit: 12_000,
    lineLimit: 220,
    maxCodeFenceLines: 80,
    codeFenceHeadLines: 12,
    codeFenceTailLines: 12,
    plainHeadLines: 80,
    plainTailLines: 24,
  }
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      config[key as keyof typeof config] = value as never
    }
  }

  const lines = text.split('\n')
  const segments = splitIntoSegments(lines)
  const hasCodeFence = segments.some(segment => segment.type === 'code')
  if (!hasCodeFence && text.length <= config.charLimit && lines.length <= config.lineLimit) {
    return text
  }

  let changed = false
  const rebuilt: string[] = []

  for (const segment of segments) {
    if (segment.type === 'code') {
      const compacted = compactCodeFenceSegment(segment, config)
      if (compacted !== segment.lines.join('\n')) {
        changed = true
      }
      rebuilt.push(compacted)
      continue
    }

    const compacted = compactPlainSegment(segment, config)
    if (compacted !== segment.lines.join('\n')) {
      changed = true
    }
    rebuilt.push(compacted)
  }

  if (!changed && text.length > config.charLimit) {
    return truncateLines(lines, config.plainHeadLines, config.plainTailLines, markerLine(text.length)).join('\n')
  }

  return rebuilt.join('\n')
}

function mergeLimitConfig(limits: ContextLimitOverrides): ContextLimitConfig {
  return {
    maxMessages: limits.maxMessages ?? DEFAULT_CONTEXT_LIMITS.maxMessages,
    maxCharsPerMessage: limits.maxCharsPerMessage ?? DEFAULT_CONTEXT_LIMITS.maxCharsPerMessage,
    maxLinesPerMessage: limits.maxLinesPerMessage ?? DEFAULT_CONTEXT_LIMITS.maxLinesPerMessage,
    maxCharsPerAssistantMessage:
      limits.maxCharsPerAssistantMessage ?? DEFAULT_CONTEXT_LIMITS.maxCharsPerAssistantMessage,
    maxCharsPerUserMessage:
      limits.maxCharsPerUserMessage ?? DEFAULT_CONTEXT_LIMITS.maxCharsPerUserMessage,
    maxCodeFenceLines: limits.maxCodeFenceLines ?? DEFAULT_CONTEXT_LIMITS.maxCodeFenceLines,
    codeFenceHeadLines: limits.codeFenceHeadLines ?? DEFAULT_CONTEXT_LIMITS.codeFenceHeadLines,
    codeFenceTailLines: limits.codeFenceTailLines ?? DEFAULT_CONTEXT_LIMITS.codeFenceTailLines,
    plainHeadLines: limits.plainHeadLines ?? DEFAULT_CONTEXT_LIMITS.plainHeadLines,
    plainTailLines: limits.plainTailLines ?? DEFAULT_CONTEXT_LIMITS.plainTailLines,
  }
}

function splitIntoSegments(lines: string[]): Segment[] {
  const segments: Segment[] = []
  let buffer: string[] = []
  let inFence = false
  let fenceLines: string[] = []

  for (const line of lines) {
    if (isFenceLine(line)) {
      if (!inFence) {
        if (buffer.length > 0) {
          segments.push({ type: 'text', lines: buffer })
          buffer = []
        }
        inFence = true
        fenceLines = [line]
        continue
      }

      fenceLines.push(line)
      segments.push({ type: 'code', lines: fenceLines })
      fenceLines = []
      inFence = false
      continue
    }

    if (inFence) {
      fenceLines.push(line)
    } else {
      buffer.push(line)
    }
  }

  if (inFence) {
    buffer.push(...fenceLines)
  }

  if (buffer.length > 0) {
    segments.push({ type: 'text', lines: buffer })
  }

  return segments
}

function isFenceLine(line: string): boolean {
  return /^```[\w-]*\s*$/.test(line)
}

function compactCodeFenceSegment(
  segment: Segment,
  config: {
    maxCodeFenceLines: number
    codeFenceHeadLines: number
    codeFenceTailLines: number
  },
): string {
  const lines = segment.lines
  if (lines.length <= config.maxCodeFenceLines) {
    return lines.join('\n')
  }

  const opener = lines[0] ?? '```'
  const closer = lines[lines.length - 1] ?? '```'
  const inner = lines.slice(1, -1)
  const truncated = truncateLines(
    inner,
    config.codeFenceHeadLines,
    config.codeFenceTailLines,
    `[context truncated: ${inner.length} code lines omitted]`,
  )

  return [opener, ...truncated, closer].join('\n')
}

function compactPlainSegment(
  segment: Segment,
  config: {
    lineLimit: number
    charLimit: number
    plainHeadLines: number
    plainTailLines: number
  },
): string {
  const lines = segment.lines
  if (lines.length <= config.lineLimit && lines.join('\n').length <= config.charLimit) {
    return lines.join('\n')
  }

  return truncateLines(
    lines,
    config.plainHeadLines,
    config.plainTailLines,
    markerLine(lines.join('\n').length),
  ).join('\n')
}

function truncateLines(
  lines: string[],
  headCount: number,
  tailCount: number,
  marker: string,
): string[] {
  if (lines.length <= headCount + tailCount + 1) {
    return lines
  }

  return [...lines.slice(0, headCount), marker, ...lines.slice(-tailCount)]
}

function markerLine(originalLength: number): string {
  return `[context truncated: ${originalLength} chars omitted to protect prompt budget]`
}

function pickFirstDefined<T>(...values: Array<T | undefined | null>): T | undefined {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value
    }
  }
  return undefined
}
